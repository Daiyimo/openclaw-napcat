/**
 * Gateway 入站消息处理器
 *
 * 处理 OneBotClient 的 "message" 事件：消息解析、触发检测、
 * 频控过滤、AI 派发、回复投递。
 * 从 channel.ts startAccount 中提取，行为不变。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";
import type { InboundContext } from "../types/channel-types.js";
import { recordKnownUser } from "../known-users.js";
import { populateGroupMemberCache } from "../member-cache.js";
import { isKnownBot, recordKnownBot, recordBotInfo, getBotInfo } from "../known-bots-store.js";
import { getDialogState, recordBotTurn, markStopped, recordUserMessage } from "../dialog-state.js";
import { shouldBotReplyToStop, getBotStopDelay, detectStopIntent } from "../utils/bot-decision.js";
import {
  detectSensitiveFileRequest,
  DEFAULT_REJECTION_MESSAGE,
} from "../utils/sensitive-guard.js";
import {
  extractImageUrls,
  downloadImages,
  cleanCQCodes,
  getReplyMessageId,
} from "../message-parser.js";
import { createDeliverDebouncer, type DeliverPayload, type DeliverInfo } from "../deliver-debounce.js";
import { TypingKeepAlive } from "../typing-keepalive.js";
import { recordRef, lookupRef } from "../ref-index-store.js";
import { handleAdminCommand } from "../admin-commands.js";
import { maskId } from "../utils/log-sanitize.js";
import {
  resolveMessageText,
  detectMention,
  detectKeywordTrigger,
  detectNameTrigger,
  hasMentionOtherUser,
  isMessageDirectedAtBot,
  buildFromId,
  buildBodyWithReply,
} from "../message-processor.js";
import { MessageSender } from "../message-sender.js";
import { parseBotHandshake } from "../utils/bot-handshake.js";
import { BOT_SIGNATURE_PATTERN, BOT_SIGNATURE_ZW_PATTERN, ERROR_NOTIFY_SLEEP_MS, BOT_STOPPED_SUPPRESS_MS, DEFAULT_STOP_KEYWORDS } from "../constants.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 友军抑制随机延迟上限（ms），提取为常量便于测试控制 */
const BOT_SUPPRESSION_JITTER_MS = 2000;

// ── 友军识别：bot ID 持久化缓存 ──────────────────────────────
// 通过签名检测自动发现 bot，缓存到磁盘（按账号隔离）。
// 跨重启/跨进程保留，避免冷启动第一个周期漏识别导致的循环对话。

/**
 * 安装 message 事件处理器。
 */
export function installMessageHandler(
  client: OneBotClient,
  ctx: InboundContext,
): void {
  const {
    account,
    config,
    cfg,
    channelRuntime,
    uploadCache,
    inboundStore,
    processedMsgIds,
    knownGroupIds,
    passiveMode,
    log,
  } = ctx;

  client.on("message", async (event) => {
    const userId = event.user_id;
    const groupId = event.group_id;
    const guildId = event.guild_id;
    const channelId = event.channel_id;
    // 收到群消息时顺手更新已知群号集合
    if (groupId) knownGroupIds.add(String(groupId));

    try {
      if (event.post_type === "meta_event") {
        if (
          event.meta_event_type === "lifecycle" &&
          event.sub_type === "connect" &&
          event.self_id
        )
          client.setSelfId(event.self_id);
        return;
      }

      // 好友/入群请求自动处理
      if (event.post_type === "request" && config.autoApproveRequests) {
        if (event.request_type === "friend" && event.flag)
          client.setFriendAddRequest(event.flag, true);
        else if (event.request_type === "group" && event.flag && event.sub_type)
          client.setGroupAddRequest(event.flag, event.sub_type, true);
        return;
      }

      // 戳一戳转换为消息事件
      if (
        event.post_type === "notice" &&
        event.notice_type === "notify" &&
        event.sub_type === "poke"
      ) {
        if (String(event.target_id) === String(client.getSelfId())) {
          const isGroupPoke = !!event.group_id;
          event.post_type = "message";
          event.message_type = isGroupPoke ? "group" : "private";
          event.raw_message = `[动作] 用户戳了你一下`;
          event.message = [{ type: "text", data: { text: event.raw_message } }];
          if (isGroupPoke) {
            client.sendGroupPoke(event.group_id!, event.user_id!);
          } else if (event.user_id) {
            client.sendFriendPoke(event.user_id);
          }
        } else return;
      }

      // v1.9.2 移除 group_increase 触发握手节流清除(metadata 模式已删)

      if (event.post_type !== "message") return;

      const isGroup = event.message_type === "group";
      const isGuild = event.message_type === "guild";

      // 过滤自身消息
      const selfId = client.getSelfId() || event.self_id;
      if (!selfId) {
        console.warn(
          `[napcat-QQ] selfId not available yet, dropping message from user ${event.user_id}`,
        );
        return;
      }
      if (String(event.user_id) === String(selfId)) {
        if (config.debug) console.log(`[napcat-QQ][debug-self-filter] dropping self message event.user_id=${maskId(event.user_id)} selfId=${selfId}`);
        return;
      }

      // 消息去重
      if (config.enableDeduplication !== false && event.message_id) {
        const msgIdKey = String(event.message_id);
        if (processedMsgIds.has(msgIdKey)) return;
        processedMsgIds.add(msgIdKey);
      }

      // 自动已读（fire-and-forget，捕获 rejected promise 避免 unhandledRejection）
      if (config.autoMarkRead) {
        if (isGroup && groupId) {
          client.markGroupMsgAsRead(groupId).catch(() => {});
        } else if (!isGroup && !isGuild && userId) {
          client.markPrivateMsgAsRead(userId).catch(() => {});
        }
      }

      // 批量预热群成员缓存
      if (isGroup && groupId) {
        await populateGroupMemberCache(client, groupId);
      }

      // ── 消息文本提取 ────────────────────────────────
      const text = await resolveMessageText(event, client, config, cfg as Record<string, unknown>);

      // ── 过滤规则 ─────────────────────────────────────
      if (config.blockedUsers?.includes(userId!)) return;
      if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId!))
        return;

      // 友军识别：bot 消息记录活跃时间后跳过
      // 五层检测：白名单 → sender.bot 字段 → 自维护 bot ID 缓存 → 签名（可见/零宽）→ 协议层握手
      let isBot = false;
      if (isGroup) {
        const userIdStr = userId != null ? String(userId) : null;
        // Layer 0: 手动白名单（最高优先级）
        const whitelistMatch = config.knownBotIds?.some(id => String(id) === userIdStr) ?? false;
        // Layer 1: sender.bot 字段
        const senderBot = event.sender?.bot === true;
        // Layer 2: 自维护缓存（持久化到磁盘，按账号隔离）
        const cachedBotMatch = userIdStr !== null && isKnownBot(account.accountId, userIdStr);
        // Layer 3: 签名检测（可见 [BOT:ID] + 零宽字符）
        const sigMatch = BOT_SIGNATURE_PATTERN.exec(text);
        const zwSigMatch = BOT_SIGNATURE_ZW_PATTERN.exec(text);
        const matchedBotId = sigMatch?.[1] ?? zwSigMatch?.[1] ?? null;
        // Layer 4: 协议层握手（v1.9 引入,v1.9.2 发送侧已删除,接收侧保留作防御性检测）
        // 如果对方 bot 仍发送 json 段握手,本 bot 仍能识别;否则此层不命中。
        let handshakeMatch: string | null = null;
        if (Array.isArray(event.message)) {
          const hs = parseBotHandshake(event.message);
          if (hs) handshakeMatch = hs.selfId;
        }
        isBot = whitelistMatch || senderBot || cachedBotMatch || matchedBotId !== null || handshakeMatch !== null;
        if (config.debug) {
          console.log(
            `[napcat-QQ][debug-bot-filter] userId=${maskId(userId)} whitelist=${whitelistMatch} ` +
              `sender.bot=${senderBot} cachedBot=${cachedBotMatch} sigMatch=${matchedBotId} ` +
              `handshake=${handshakeMatch} isBot=${isBot} text="${text.slice(0, 80)}"`,
          );
        }
        if (isBot) {
          // 通过签名检测到的 bot 自动加入持久化缓存，后续无需签名也能识别
          if (matchedBotId !== null) {
            recordKnownBot(account.accountId, matchedBotId);
            // 异步拉取 bot 详细信息（昵称/群名片），不阻塞主流程
            fetchBotInfoAsync(client, account.accountId, matchedBotId, isGroup ? groupId : undefined, log).catch((err) => {
              log.warn?.(`[napcat-QQ] Failed to fetch bot info for ${matchedBotId}: ${err.message}`);
            });
          }
          // 通过握手消息（Plan A）发现 bot：记录元数据并异步拉昵称
          if (handshakeMatch !== null) {
            recordKnownBot(account.accountId, handshakeMatch);
            fetchBotInfoAsync(client, account.accountId, handshakeMatch, isGroup ? groupId : undefined, log).catch((err) => {
              log.warn?.(`[napcat-QQ] Failed to fetch bot info for ${handshakeMatch}: ${err.message}`);
            });
            // 握手消息本身不携带用户内容，直接 return 不进入 AI 派发
            if (config.debug) {
              console.log(`[napcat-QQ][debug-handshake] recorded bot ${handshakeMatch} from handshake, skipping AI dispatch`);
            }
            return;
          }
          if (config.ignoreSenderBot !== false) passiveMode.markBotActive(`group:${groupId}`);

          // ── 多 bot 对话控制（v1.8+）──────────────────
          // 友军识别后不再 100% 静默；改为受轮数上限 + 停止状态约束
          if (config.ignoreSenderBot !== false) {
            const dialogKey = `group:${groupId}`;
            const dialog = getDialogState(account.accountId, dialogKey);
            const maxRounds = config.botDialogMaxRounds ?? 5;

            // 已被用户停止 → 静默
            if (dialog.stoppedAt !== null && Date.now() - dialog.stoppedAt < BOT_STOPPED_SUPPRESS_MS) {
              if (config.debug) {
                console.log(`[napcat-QQ][debug-dialog] bot msg dropped: dialog stopped at ${dialog.stoppedAt}`);
              }
              return;
            }

            // 达到轮数上限 → 静默
            if (dialog.rounds >= maxRounds) {
              if (config.debug) {
                console.log(`[napcat-QQ][debug-dialog] bot msg dropped: rounds=${dialog.rounds} >= ${maxRounds}`);
              }
              return;
            }

            // 通过对话控制：记录本轮，AI 派发继续
            recordBotTurn(account.accountId, dialogKey, String(userId));
            if (config.debug) {
              console.log(`[napcat-QQ][debug-dialog] bot msg allowed: rounds=${dialog.rounds + 1}/${maxRounds}`);
            }
          }
          // 不 return，继续走 AI 派发（让 bot 之间能对话聊天，受轮数限制）
        }
      }

      // ── 指向性门控（v1.11+）───────────────────────────────
      // 群/频道人类消息必须指向本 bot 才继续。bot 互发旁路（受 dialog state 控制），
      // 私聊天然通过。修复：sharedAdmins 后两 bot 都视为 admin，旧守卫内
      // isDirectedAtMe 被 bypass 导致未被点名的 bot 越权响应。
      if (!isBot) {
        const otherBotNames: string[] = [];
        if (config.knownBotIds?.length) {
          for (const botId of config.knownBotIds) {
            if (String(botId) === String(selfId)) continue;
            const info = getBotInfo(account.accountId, String(botId));
            const name = info?.card || info?.nickname;
            if (name) otherBotNames.push(name);
          }
        }
        if (!isMessageDirectedAtBot(event, selfId, text, config._selfName, otherBotNames)) {
          if (config.debug) {
            console.log(
              `[napcat-QQ][debug-directed] silent drop: msg not directed at this bot, user=${maskId(userId)}`,
            );
          }
          return;
        }
      }

      const isAdmin =
        (config.admins?.includes(userId!) ?? false) ||
        (config.sharedAdmins?.includes(userId!) ?? false);
      const effectiveSelfId = client.getSelfId() ?? event.self_id;

      // ── 级联阻断：守卫拒绝消息（含 [SYS:GUARD] 标记）直接丢弃 ──────
      // 防止 bot 间收到守卫拒绝后再次触发守卫，形成 ping-pong 死循环。
      if (text.includes("[SYS:GUARD]")) {
        if (config.debug) {
          console.log(`[napcat-QQ][debug-sensitive-guard] cascade blocked: msg contains [SYS:GUARD]`);
        }
        return;
      }

      // ── 系统文件预拦截（v1.10+）──────────────────────────────
      // 非 admin 用户试图诱导 bot 修改 SOUL/AGENTS/IDENTITY/USER/MEMORY 等
      // 系统文件时直接拒绝。治标方案：OpenClaw 主项目 LLM tool dispatch 层
      // 不消费 CommandAuthorized，在网关侧把消息挡在 OpenClaw 调用之前。
      // 详见 src/utils/sensitive-guard.ts。
      //
      // 注意：来自其他 bot 的消息跳过守卫（bot 间的正常对话不应被敏感守卫拦截）。
      // 检测五层：白名单 → sender.bot → 持久化缓存 → 签名 → 握手。
      // 仅群聊场景需要判断（私聊不存在 bot 间消息）。
      const isKnownBotSender =
        isGroup &&
        ((config.knownBotIds?.some(id => String(id) === String(userId)) ?? false) ||
          event.sender?.bot === true ||
          (userId != null && isKnownBot(account.accountId, String(userId))) ||
          (BOT_SIGNATURE_PATTERN.test(text) || BOT_SIGNATURE_ZW_PATTERN.test(text)));
      if (!isAdmin && !isKnownBotSender && config.sensitiveFileGuard?.enabled !== false) {
        const guardOpts = {
          ...(config.sensitiveFileGuard?.files ? { files: config.sensitiveFileGuard.files } : {}),
          ...(config.sensitiveFileGuard?.verbs ? { verbs: config.sensitiveFileGuard.verbs } : {}),
          ...(config.sensitiveFileGuard?.nouns ? { nouns: config.sensitiveFileGuard.nouns } : {}),
        };
        const check = detectSensitiveFileRequest(text, guardOpts);
        if (check.matched) {
          // 指向性判断：消息必须指向本 bot 才发拒绝。
          // 顶层门控（v1.11+）已对人类消息做了 early return，此处保留 isDirectedAtMe
          // 作为 defense-in-depth，防止有人从其他代码路径直接走到守卫。
          // 私聊天然通过；bot 消息已在守卫入口（isKnownBotSender）跳过。
          const isDirectedAtMe = isMessageDirectedAtBot(
            event, effectiveSelfId, text, config._selfName,
          );

          if (!isDirectedAtMe) {
            if (config.debug) {
              console.log(
                `[napcat-QQ][debug-sensitive-guard] silent drop: matched but not directed at bot, user=${maskId(userId)}`,
              );
            }
            return;
          }

          const rejectMsg = (config.sensitiveFileGuard?.rejectMessage ?? DEFAULT_REJECTION_MESSAGE) + "[SYS:GUARD]";
          if (isGroup && groupId) {
            await client.sendGroupMsg(groupId, rejectMsg);
          } else if (userId) {
            await client.sendPrivateMsg(userId, rejectMsg);
          }
          if (config.debug) {
            console.log(
              `[napcat-QQ][debug-sensitive-guard] blocked user=${maskId(userId)} reason=${check.reason} hit=${check.hit} directed=${isDirectedAtMe}`,
            );
          }
          return;
        }
      }

      // ── 管理员命令 ────────────────────────────────────
      if (!isGuild && isAdmin && text.trim().startsWith("/")) {
        const isCmdMentioned =
          !isGroup ||
          (() => {
            const sid = client.getSelfId() ?? event.self_id;
            if (!sid) return false;
            if (Array.isArray(event.message)) {
              for (const s of event.message) {
                if (
                  s.type === "at" &&
                  (String(s.data?.qq) === String(sid) || s.data?.qq === "all")
                )
                  return true;
              }
            }
            return text.includes(`[CQ:at,qq=${sid}]`);
          })();

        if (isCmdMentioned) {
          const parts = text.trim().split(/\s+/);
          const cmd = parts[0];
          const handled = await handleAdminCommand(cmd, parts, {
            client,
            isGroup,
            groupId,
            userId,
            text,
            message: event.message,
            eventTime: event.time ? event.time * 1000 : undefined,
            refreshGroupRoutes: async () => {
              const groups = await client.getGroupList();
              const storePath = channelRuntime.session.resolveStorePath(
                (cfg as OpenClawConfig).session?.store,
                { agentId: "default" },
              );
              await Promise.allSettled(groups.map(async (g) => {
                const gid = String(g.group_id);
                const groupFromId = `group:${gid}`;
                const routeCtx = {
                  Provider: "napcat",
                  Channel: "napcat",
                  From: groupFromId,
                  To: "napcat:bot",
                  Body: "",
                  RawBody: "",
                  AccountId: account.accountId,
                  ChatType: "group",
                  Timestamp: Date.now(),
                  OriginatingChannel: "napcat",
                  OriginatingTo: groupFromId,
                  SenderName: "",
                  SenderId: "",
                  ConversationLabel: `QQ Group ${gid}`,
                };

                let sessionKey: string | undefined;
                try {
                  const route = (channelRuntime as any)?.routing?.resolveAgentRoute?.({
                    cfg: cfg as OpenClawConfig,
                    channel: "napcat",
                    accountId: account.accountId,
                    peer: { kind: "group", id: gid },
                  });
                  sessionKey = route?.sessionKey;
                } catch {
                  // routing unavailable, skip this group
                }

                if (!sessionKey) {
                  console.warn(`[napcat-QQ] Cannot resolve session key for group ${gid}, skipping`);
                  knownGroupIds.add(gid);
                  return;
                }

                await channelRuntime.session.recordInboundSession({
                  storePath,
                  sessionKey,
                  ctx: { ...routeCtx, SessionKey: sessionKey },
                  updateLastRoute: { sessionKey, channel: "napcat", to: groupFromId, accountId: account.accountId },
                  onRecordError: () => {},
                });
                knownGroupIds.add(gid);
              }));
              log.info(`[napcat-QQ] /groups: refreshed ${groups.length} group routes`);
              return groups.length;
            },
          });
          if (handled) return;
        }
      }

      // ── 获取被引用消息 ────────────────────────────────
      let repliedMsg: any = null;
      const replyMsgId = getReplyMessageId(event.message, text);
      if (replyMsgId) {
        const refEntry = lookupRef(replyMsgId, account.accountId);
        if (refEntry) {
          repliedMsg = {
            sender: { nickname: refEntry.sender, user_id: refEntry.senderId },
            raw_message: refEntry.text,
            message: refEntry.text,
          };
        } else {
          try {
            repliedMsg = await client.getMsg(replyMsgId);
          } catch (e) {
            console.debug(`[napcat-QQ] Failed to fetch replied message ${replyMsgId}:`, e);
          }
        }
      }

      // ── 历史上下文 ────────────────────────────────────
      let historyContext = "";
      if (isGroup && config.historyLimit !== 0) {
        try {
          const limit = config.historyLimit || 5;
          const history = await client.getGroupMsgHistory(groupId!, limit + 1);
          if (history?.messages) {
            historyContext = history.messages
              .slice(-(limit + 1), -1)
              .map(
                (m: any) =>
                  `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`,
              )
              .join("\n");
          }
        } catch (e) {
          console.debug(`[napcat-QQ] Failed to fetch group history for ${groupId}:`, e);
        }
      }

      // ── @其他人检测：仅在 bot 自身未被 @/回复 时跳过 ──────────────────
      // 如果消息 @了其他用户但 bot 也被 @，bot 仍应响应
      // NapCat 可能 stripping @ 段，只保留纯文本昵称，需要 nickname 补判
      const otherBotNames: string[] = [];
      if (config.knownBotIds?.length) {
        for (const botId of config.knownBotIds) {
          if (String(botId) === String(effectiveSelfId)) continue;
          const info = getBotInfo(account.accountId, String(botId));
          const name = info?.card || info?.nickname;
          if (name) otherBotNames.push(name);
        }
      }
      if (isGroup || isGuild) {
        if (effectiveSelfId && !detectMention(event, effectiveSelfId, text, null, config.debug)) {
          if (hasMentionOtherUser(event, effectiveSelfId, otherBotNames)) {
            if (config.debug) {
              console.log(`[napcat-QQ][debug-mention-other] skipping message that @mentions other user, not bot`);
            }
            return;
          }
        }
      }

      // ── 触发检测 ──────────────────────────────────────
      let isTriggered = (!isGroup && !isGuild) || text.includes("[动作] 用户戳了你一下");

      const checkMention = isGroup || isGuild;
      let isMentioned = false;
      if (checkMention) {
        if (!effectiveSelfId) return;
        isMentioned = detectMention(event, effectiveSelfId, text, repliedMsg, config.debug);
      }

      // 名字触发检测（自我认知）：消息中包含 bot 名字时触发
      // 优先级：@提及 > 名字触发 > 关键词触发
      if (!isTriggered && !isMentioned && checkMention) {
        const botName = config._selfName;
        if (botName && detectNameTrigger(text, botName, config.debug)) {
          isTriggered = true;
          if (config.debug) {
            console.log(`[napcat-QQ][debug-trigger] name trigger activated: botName="${botName}"`);
          }
        }
      }

      if (!isTriggered) {
        isTriggered = detectKeywordTrigger(text, config.keywordTriggers);
      }

      // ── 旁观模式标记 ──────────────────────────────────
      const fromId = buildFromId(isGroup, isGuild, userId, groupId, guildId, channelId);
      const conversationLabel = isGroup
        ? `QQ Group ${groupId}`
        : isGuild
          ? `QQ Guild ${guildId} Channel ${channelId}`
          : `QQ User ${userId}`;
      let isPassiveMode = false;

      if (checkMention && config.requireMention && !isTriggered && !isMentioned) {
        if (config.passiveMode?.enabled && isGroup) {
          // 旁观模式：消息 @ 了其他用户时也不进入（避免 "你是叫我吗" 误回复）
          const passiveSelfId = client.getSelfId() ?? event.self_id;
          if (passiveSelfId && hasMentionOtherUser(event, passiveSelfId, otherBotNames)) {
            if (config.debug) {
              console.log(`[napcat-QQ][debug-mention-other] passive mode skipped: msg @ other user, not bot`);
            }
            return;
          }
          const cooldownKey = `${account.accountId}:${fromId}`;
          const cooldownMs = config.passiveMode.cooldownMs ?? 10_000;
          const minIntervalMs = config.passiveMode.minIntervalMs ?? 30_000;
          const botSuppressionMs = config.passiveMode.botSuppressionMs ?? 120_000;
          // 友军抑制：其他 bot 近期活跃则跳过（含预占消息）
          if (botSuppressionMs > 0 && passiveMode.isBotSuppressed(`group:${groupId}`, botSuppressionMs)) {
            // 检测到友军活跃，随机延迟错开处理时机，减少竞态
            await sleep(Math.random() * BOT_SUPPRESSION_JITTER_MS);
            return;
          }
          // 最小间隔（含 [SILENT] 响应）→ 冷却（仅实质回复）
          if (!passiveMode.isIntervalAllowed(cooldownKey, minIntervalMs)) return;
          if (!passiveMode.isAllowed(cooldownKey, cooldownMs)) return;
          isPassiveMode = true;
          passiveMode.markActive(cooldownKey);
          passiveMode.markCheck(cooldownKey);
        } else {
          return;
        }
      }

      // ── 多 bot 对话：用户消息重置 + 停止意图检测（v1.8+）─────
      let isUserStopIntent = false;
      if (isGroup && groupId && !isBot) {
        // 任何用户消息都重置对话轮数（仅当消息会走 AI 派发）
        if (isTriggered || isMentioned || isPassiveMode || !config.requireMention) {
          recordUserMessage(account.accountId, `group:${groupId}`);
        }
        // 检测用户停止对话意图
        if (config.botStopReplyEnabled !== false) {
          const stopKeywords = (config.botStopKeywords && config.botStopKeywords.length > 0)
            ? config.botStopKeywords
            : DEFAULT_STOP_KEYWORDS;
          if (detectStopIntent(text, stopKeywords)) {
            isUserStopIntent = true;
            markStopped(account.accountId, `group:${groupId}`);
            if (config.debug) {
              console.log(`[napcat-QQ][debug-dialog] user stop intent detected`);
            }
          }
        }
      }

      // ── 记录入站消息到引用索引 ────────────────────────
      if (event.message_id) {
        recordRef({
          msgId: String(event.message_id),
          text: cleanCQCodes(text),
          sender: event.sender?.card || event.sender?.nickname || String(userId),
          senderId: String(userId),
          timestamp: (event.time ?? Date.now() / 1000) * 1000,
          accountId: account.accountId,
        });
      }

      // ── 消息发送器 ────────────────────────────────────
      const sender = new MessageSender({
        client,
        config,
        uploadCache,
        accountId: account.accountId,
        isGroup,
        isGuild,
        groupId,
        userId,
        guildId,
        channelId,
      });
      const actualDeliver = (payload: DeliverPayload) => sender.deliver(payload);

      // ── Deliver Debouncer 包装 ─────────────────────────
      const debouncer = createDeliverDebouncer(
        config.deliverDebounce,
        (p, _info: DeliverInfo) => actualDeliver(p),
        log,
        `[napcat-QQ][debounce]`,
      );

      const deliver = async (payload: unknown) => {
        const dp = payload as DeliverPayload;
        if (debouncer) {
          await debouncer.deliver(dp, { kind: "reply" });
        } else {
          await actualDeliver(dp);
        }
      };

      // ── 智能表情回应 ──────────────────────────────────
      // 仅对来自其他用户的消息贴表情，不对自己的消息或 bot 消息贴表情
      if (
        !isPassiveMode &&
        (config.enableReactions || config.reactionEmoji) &&
        event.message_id &&
        String(event.user_id) !== String(selfId) &&
        !event.sender?.bot
      ) {
        try {
          let emojiId: string;
          if (config.reactionEmoji) {
            emojiId = config.reactionEmoji;
          } else {
            const t = text;
            emojiId = "307"; // 喵喵（默认）

            if (/查找|查询|搜索|检查|检测|查看|打开|获取|看看|找|搜/.test(t)) emojiId = "124";
            else if (/好的|收到|确认|明白|了解|知道了|好|没问题|OK|ok/.test(t)) emojiId = "76";
            else if (/谢谢|感谢|谢了|多谢|感激/.test(t)) emojiId = "297";
            else if (/加油|继续|努力|坚持|棒|厉害|牛|强/.test(t)) emojiId = "315";
            else if (/哈哈|开心|高兴|快乐|好玩|有趣|笑|嘻嘻/.test(t)) emojiId = "99";
            else if (/难过|悲伤|伤心|哭|呜|唉|可怜|失落/.test(t)) emojiId = "5";
            else if (/生气|愤怒|气死|烦|滚|讨厌|恼火/.test(t)) emojiId = "326";
            else if (/[?？]|为什么|怎么|啥|什么|不懂|不明白|疑问/.test(t)) emojiId = "32";
            else if (/哇|惊|震惊|不会吧|真的吗|卧槽|天啊|没想到/.test(t)) emojiId = "180";
            else if (/喜欢|爱|爱你|心动|可爱|萌/.test(t)) emojiId = "66";
            else if (/你好|早|晚安|嗨|hi|hello|Hey|hey/.test(t)) emojiId = "14";
            else if (/帮|请|麻烦|劳烦|能不能|可以吗|求/.test(t)) emojiId = "118";
            else if (/吃|饿|饭|食|喝|美食/.test(t)) emojiId = "53";
            else if (/睡|困|累|休息|晚安|倦/.test(t)) emojiId = "8";
          }

          if (config.debug) {
            console.log(
              `[napcat-QQ][debug-reaction] msgId=${event.message_id} emojiId=${emojiId} ` +
                `userId=${maskId(event.user_id)} selfId=${selfId} isBot=${event.sender?.bot} text="${text.slice(0, 50)}"`,
            );
          }
          await client.setMsgEmojiLike(event.message_id, emojiId);
          if (config.debug) console.log(`[napcat-QQ][debug-reaction] success msgId=${event.message_id}`);
        } catch (err) {
          console.error(`[napcat-QQ][debug-reaction] FAILED msgId=${event.message_id} err=`, err);
        }
      } else if (
        !isPassiveMode &&
        (config.enableReactions || config.reactionEmoji) &&
        event.message_id &&
        (String(event.user_id) === String(selfId) || event.sender?.bot)
      ) {
        if (config.debug) {
          console.log(
            `[napcat-QQ][debug-reaction] SKIP self/bot msgId=${event.message_id} userId=${maskId(event.user_id)} selfId=${selfId} isBot=${event.sender?.bot}`,
          );
        }
      }

      // ── 入站频控 & 静默关键词过滤 ────────────────────
      {
        const store = inboundStore;
        const { config: storeConfig } = store;

        if (storeConfig.inboundRateLimitMs > 0 && fromId) {
          const key = `${account.accountId}:${fromId}`;
          const now = Date.now();
          const last = store.lastTrigger.get(key) ?? 0;
          if (now - last < storeConfig.inboundRateLimitMs) {
            console.log(
              `[napcat-QQ][rate_limit] rate limited: ${key} (${now - last}ms < ${storeConfig.inboundRateLimitMs}ms)`,
            );
            return;
          }
          // 按时间戳排序清理最不活跃的条目（非 FIFO），防止高频用户被误淘汰
          if (store.lastTrigger.size > 5000) {
            const entries = [...store.lastTrigger.entries()];
            entries.sort((a, b) => a[1] - b[1]);
            for (let i = 0; i < 1000 && i < entries.length; i++) {
              store.lastTrigger.delete(entries[i][0]);
            }
          }
          store.lastTrigger.set(key, now);
        }

        if (storeConfig.silentKeywords?.length) {
          const body = cleanCQCodes(text);
          for (const kw of storeConfig.silentKeywords) {
            // 词边界匹配：ww 匹配 "ww签到" 但不匹配 "www"
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (new RegExp(`\\b${escaped}\\b`).test(body)) {
              console.log(
                `[napcat-QQ][silent_keyword] matched "${kw}", dropping message from ${fromId}`,
              );
              return;
            }
          }
        }
      }

      const { dispatcher, replyOptions } =
        channelRuntime.reply.createReplyDispatcherWithTyping({ deliver });

      let replyToBody = "";
      let replyToSender = "";
      if (replyMsgId && repliedMsg) {
        replyToBody = cleanCQCodes(
          typeof repliedMsg.message === "string"
            ? repliedMsg.message
            : repliedMsg.raw_message || "",
        );
        replyToSender =
          repliedMsg.sender?.nickname ||
          repliedMsg.sender?.card ||
          String(repliedMsg.sender?.user_id || "");
      }

      // ── 收集消息中 @ 的已知 bot（被动观测插话用）────
      const mentionsKnownBot: Array<{ selfId: string; nickname?: string; card?: string }> = [];
      if (Array.isArray(event.message)) {
        for (const seg of event.message) {
          if (seg.type === "at" && seg.data?.qq) {
            const atUserId = String(seg.data.qq);
            if (atUserId !== "all" && isKnownBot(account.accountId, atUserId)) {
              const info = getBotInfo(account.accountId, atUserId);
              mentionsKnownBot.push({
                selfId: atUserId,
                nickname: info?.nickname,
                card: info?.card,
              });
            }
          }
        }
      }

      const bodyWithReply = buildBodyWithReply({
        text,
        repliedMsg,
        systemPrompt: config.systemPrompt,
        historyContext,
        isPassiveMode,
        passivePrompt: config.passiveMode?.systemPrompt,
        botSelfId: client.getSelfId() ?? event.self_id,
        botName: config._selfName,
        mentionsKnownBot: mentionsKnownBot.length > 0 ? mentionsKnownBot : undefined,
        responseGuidelines: config.responseGuidelines,
      });

      // ── 解析正确的 session key（框架格式）────────────────────
      // 使用框架 resolveAgentRoute 生成标准格式 key，
      // 避免手写 "qq:group:xxx" 与框架内部格式不匹配
      //
      // ⚠️ P0：降级格式必须与 resolveOutboundSessionRoute 一致
      // 否则 cron 投递和 sessions_send 将找不到群会话
      let resolvedSessionKey: string | undefined;
      if (isGroup && groupId) {
        try {
          const route = (channelRuntime as any)?.routing?.resolveAgentRoute?.({
            cfg: cfg as OpenClawConfig,
            channel: "napcat",
            accountId: account.accountId,
            peer: { kind: "group", id: String(groupId) },
          });
          resolvedSessionKey = route?.sessionKey;
        } catch {
          // ⚠️ P0：格式必须为 agent:default:napcat:group:{groupId}
          // 旧格式 "qq:{fromId}" 会导致出站路由找不到会话
          resolvedSessionKey = `agent:default:napcat:group:${groupId}`;
        }
      } else if (isGuild && guildId && channelId) {
        resolvedSessionKey = `agent:default:napcat:channel:${guildId}:${channelId}`;
      } else {
        // 私聊
        resolvedSessionKey = `agent:default:napcat:direct:${fromId}`;
      }

      // ── 下载入站图片到本地 ──
      // 框架要求 MediaUrls 和 MediaPaths 长度一致，同时传两个字段
      const imageUrls = extractImageUrls(event.message);
      let downloaded: { path: string; type: string }[] = [];
      if (imageUrls.length > 0) {
        downloaded = await downloadImages(imageUrls);
      }

      const ctxPayload = channelRuntime.reply.finalizeInboundContext({
        Provider: "napcat",
        Channel: "napcat",
        From: fromId,
        To: "napcat:bot",
        Body: bodyWithReply,
        RawBody: text,
        SenderId: String(userId),
        SenderName: event.sender?.nickname || "Unknown",
        ConversationLabel: conversationLabel,
        SessionKey: resolvedSessionKey || `qq:${fromId}`,
        AccountId: account.accountId,
        ChatType: isGroup ? "group" : isGuild ? "channel" : "direct",
        Timestamp: (event.time ?? Math.floor(Date.now() / 1000)) * 1000,
        OriginatingChannel: "napcat",
        OriginatingTo: fromId,
        CommandAuthorized: isAdmin || (!isGroup && !isGuild),
        ...(downloaded.length > 0 ? {
          MediaPaths: downloaded.map(d => d.path),
          MediaPath: downloaded[0].path,
          MediaTypes: downloaded.map(d => d.type),
          MediaType: downloaded[0].type,
          MediaUrls: imageUrls,
          MediaUrl: imageUrls[0],
        } : {}),
        ...(replyMsgId && {
          ReplyToId: replyMsgId,
          ReplyToBody: replyToBody,
          ReplyToSender: replyToSender,
        }),
      });

      await channelRuntime.session.recordInboundSession({
        storePath: channelRuntime.session.resolveStorePath(
          (cfg as OpenClawConfig).session?.store,
          { agentId: "default" },
        ),
        sessionKey: ctxPayload.SessionKey as string,
        ctx: ctxPayload,
        updateLastRoute: {
          sessionKey: ctxPayload.SessionKey as string,
          channel: "napcat",
          to: fromId,
          accountId: account.accountId,
        },
        onRecordError: (err) => console.error("QQ Session Error:", err),
      });

      // ── Typing 状态 ───────────────────────────────────
      const typing = new TypingKeepAlive(client, isGroup || isGuild, groupId, userId);
      typing.start();

      // 旁观模式冷却 key（在 finally 中释放哨兵）
      const passiveCooldownKey = isPassiveMode ? `${account.accountId}:${fromId}` : null;

      // ── 多 bot 对话：用户停止指令时按 selfId hash 决策响应（v1.8+）──────
      if (isUserStopIntent && config.botStopReplyEnabled !== false) {
        const selfId = String(client.getSelfId() ?? "");
        const ratio = config.botStopReplyRatio ?? 0.66;
        if (!shouldBotReplyToStop(selfId, ratio)) {
          if (config.debug) {
            console.log(`[napcat-QQ][debug-dialog] stop reply declined by hash: selfId=${maskId(selfId)} ratio=${ratio}`);
          }
          typing.stop();
          return;
        }
        const delay = getBotStopDelay(selfId, config.botStopReplyDelayMaxMs ?? 300);
        if (delay > 0) {
          if (config.debug) {
            console.log(`[napcat-QQ][debug-dialog] stop reply delay: ${delay}ms`);
          }
          await sleep(delay);
        }
      }

      try {
        await channelRuntime.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });

        // 派发成功：释放哨兵并写入冷却时间戳
        if (passiveCooldownKey) passiveMode.markDone(passiveCooldownKey);

        recordKnownUser({
          openid: String(userId),
          type: isGroup ? "group" : isGuild ? "guild" : "private",
          nickname: event.sender?.card || event.sender?.nickname,
          groupId: isGroup ? groupId : undefined,
          accountId: account.accountId,
        });
      } catch (error) {
        // 派发失败：释放哨兵（不写冷却，允许用户立即重试）
        if (passiveCooldownKey) passiveMode.markSilent(passiveCooldownKey);

        if (config.enableErrorNotify) {
          await deliver({ text: "⚠️ 服务调用失败，请稍后重试。" });
        }
        console.error("[napcat-QQ] Reply dispatch error:", error);
      } finally {
        if (debouncer) await debouncer.dispose();
        typing.stop();
      }
    } catch (err) {
      console.error("[napcat-QQ] Critical error in message handler:", err);
      if (config.enableErrorNotify && config.admins?.length) {
        try {
          const errorMsg =
            `⚠️ 消息处理异常\n用户: ${maskId(userId)}\n群组: ${groupId ? maskId(groupId) : "私聊"}\n` +
            `错误: ${err instanceof Error ? err.message : String(err)}`;
          for (const adminId of config.admins) {
            await client.sendPrivateMsg(adminId, errorMsg);
            await sleep(ERROR_NOTIFY_SLEEP_MS);
          }
        } catch (notifyErr) {
          console.warn("[napcat-QQ] Failed to send error notification:", notifyErr);
        }
      }
    }
  });
}

// ============ 辅助函数：异步拉取 bot 详细信息 ============

const BOT_INFO_FETCH_TIMEOUT_MS = 5_000;

/**
 * 异步拉取 bot 昵称/群名片并持久化。
 * 不阻塞主流程；失败仅 warn 不影响消息处理。
 */
async function fetchBotInfoAsync(
  client: OneBotClient,
  accountId: string,
  botId: string,
  groupId: number | undefined,
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void; error?: (msg: string) => void },
): Promise<void> {
  try {
    let info: any = null;
    if (groupId !== undefined) {
      // 优先拉群成员信息（含群名片 card，比陌生人信息更丰富）
      try {
        info = await Promise.race([
          client.getGroupMemberInfo(groupId, botId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), BOT_INFO_FETCH_TIMEOUT_MS),
          ),
        ]);
      } catch {
        // 群内查不到（非本群成员）回退到陌生人信息
        info = await Promise.race([
          client.getStrangerInfo(botId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), BOT_INFO_FETCH_TIMEOUT_MS),
          ),
        ]);
      }
    } else {
      info = await Promise.race([
        client.getStrangerInfo(botId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), BOT_INFO_FETCH_TIMEOUT_MS),
        ),
      ]);
    }
    if (info && (info.nickname || info.card)) {
      recordBotInfo(accountId, {
        selfId: botId,
        nickname: info.nickname,
        card: info.card,
      });
      log?.info?.(`[napcat-QQ] Updated bot info: ${botId} → ${info.card || info.nickname}`);
    }
  } catch (err: any) {
    log?.warn?.(`[napcat-QQ] fetchBotInfoAsync failed for ${botId}: ${err.message}`);
  }
}
