/**
 * Gateway 入站消息处理器
 *
 * 处理 OneBotClient 的 "message" 事件：消息解析、触发检测、
 * 频控过滤、AI 派发、回复投递。
 * 采用两阶段管道：filter → trigger，dispatch 保持 inline
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OneBotClient } from "../client.js";
import type { OneBotEvent } from "../types.js";
import type { InboundContext } from "../types/channel-types.js";
import { recordKnownUser } from "../known-users.js";
import { isKnownBot, recordKnownBot, recordBotInfo, getBotInfo, fetchBotInfoAsync } from "../known-bots-store.js";
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
import { registerGroupRoute } from "./group-route-registry.js";
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
  buildOtherBotNames,
} from "../message-processor.js";
import { MessageSender } from "../message-sender.js";
import { filterStage, type FilterResult } from "./filter.js";
import { triggerStage } from "./trigger.js";
import { BOT_SIGNATURE_PATTERN, BOT_SIGNATURE_ZW_PATTERN, ERROR_NOTIFY_SLEEP_MS, BOT_STOPPED_SUPPRESS_MS, DEFAULT_STOP_KEYWORDS } from "../constants.js";
import { sleep } from "../utils/sleep.js";

const BOT_SUPPRESSION_JITTER_MS = 2000;

export function installMessageHandler(
  client: OneBotClient,
  ctx: InboundContext,
): () => void {
  const {
    account,
    config,
    cfg,
    channelRuntime,
    uploadCache,
    inboundStore,
    knownGroupIds,
    passiveMode,
    log,
  } = ctx;

  client.on("message", async (event) => {
    const filterResult = filterStage(event, client, ctx);
    if (!filterResult) return;

    const { userId, groupId, guildId, channelId, isGroup, isGuild, selfId } = filterResult;

    try {
      const triggerResult = await triggerStage(
        { event, userId, groupId, guildId, channelId, isGroup, isGuild, selfId },
        client,
        ctx,
      );
      if (!triggerResult) return;

      // 使用 trigger 结果继续 inline dispatch（保持测试兼容）
      let text = triggerResult.text;
      let isBot = triggerResult.isBot;
      let isPassiveMode = triggerResult.isPassiveMode;
      let isUserStopIntent = triggerResult.isUserStopIntent;
      const isAdmin = triggerResult.isAdmin;
      const effectiveSelfId = triggerResult.effectiveSelfId;
      const knownBotIdSet = triggerResult.knownBotIdSet;
      const otherBotNames = triggerResult.otherBotNames;

      // ── 消息文本提取（trigger 已解析，此处直接用）──────────────────
      // text 已在 triggerStage 中解析完成

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

      // ── @其他人检测 ──────────────────────────────────────────
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

      // 名字触发检测（自我认知）
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
      let isPassiveModeFlag = false;

      if (checkMention && config.requireMention && !isTriggered && !isMentioned) {
        if (config.passiveMode?.enabled && isGroup) {
          if (hasMentionOtherUser(event, effectiveSelfId, otherBotNames)) {
            if (config.debug) {
              console.log(`[napcat-QQ][debug-mention-other] passive mode skipped: msg @ other user, not bot`);
            }
            return;
          }
          const cooldownKey = `${account.accountId}:${fromId}`;
          const cooldownMs = config.passiveMode.cooldownMs ?? 10_000;
          const minIntervalMs = config.passiveMode.minIntervalMs ?? 30_000;
          const botSuppressionMs = config.passiveMode.botSuppressionMs ?? 120_000;
          if (botSuppressionMs > 0 && passiveMode.isBotSuppressed(`group:${groupId}`, botSuppressionMs)) {
            await sleep(Math.random() * BOT_SUPPRESSION_JITTER_MS);
            return;
          }
          if (!passiveMode.isIntervalAllowed(cooldownKey, minIntervalMs)) return;
          if (!passiveMode.isAllowed(cooldownKey, cooldownMs)) return;
          isPassiveModeFlag = true;
          passiveMode.markActive(cooldownKey);
          passiveMode.markCheck(cooldownKey);
        } else {
          return;
        }
      }

      // ── 多 bot 对话：用户消息重置 + 停止意图检测 ──────
      if (isGroup && groupId && !isBot) {
        if (isTriggered || isMentioned || isPassiveModeFlag || !config.requireMention) {
          recordUserMessage(account.accountId, `group:${groupId}`);
        }
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
            emojiId = "307";
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
          await client.setMsgEmojiLike(event.message_id, emojiId);
        } catch (err) {
          console.error(`[napcat-QQ][debug-reaction] FAILED msgId=${event.message_id} err=`, err);
        }
      }

      // ── 入站频控（滑动窗口）& 静默关键词过滤 ────────────
      {
        const store = inboundStore;
        const { config: storeConfig } = store;
        const rateLimiter = store.rateLimiter;

        if (rateLimiter && storeConfig.inboundRateLimitMs > 0) {
          const result = rateLimiter.check(userId, isGroup ? groupId : undefined, isAdmin);
          if (!result.allowed) {
            if (config.debug) {
              console.log(
                `[napcat-QQ][rate_limit] rate limited: user=${maskId(userId)} group=${groupId} ` +
                  `retryAfter=${result.retryAfterMs}ms count=${result.currentCount}`,
              );
            }
            return;
          }
          if (!isAdmin) {
            rateLimiter.record(userId, isGroup ? groupId : undefined);
          }
        }

        if (storeConfig.silentKeywords?.length) {
          const body = cleanCQCodes(text);
          for (const kw of storeConfig.silentKeywords) {
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

      // ── 收集消息中 @ 的已知 bot ─────────────────────
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
        isPassiveMode: isPassiveModeFlag,
        passivePrompt: config.passiveMode?.systemPrompt,
        botSelfId: client.getSelfId() ?? event.self_id,
        botName: config._selfName,
        mentionsKnownBot: mentionsKnownBot.length > 0 ? mentionsKnownBot : undefined,
        responseGuidelines: config.responseGuidelines,
      });

      // ── 解析正确的 session key ─────────────────────
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
          resolvedSessionKey = `agent:default:napcat:group:${groupId}`;
        }
      } else if (isGuild && guildId && channelId) {
        resolvedSessionKey = `agent:default:napcat:channel:${guildId}:${channelId}`;
      } else {
        resolvedSessionKey = `agent:default:napcat:direct:${fromId}`;
      }

      // ── 下载入站图片到本地 ──
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
        ...(replyMsgId ? {
          ReplyToId: replyMsgId,
          ReplyToBody: replyToBody,
          ReplyToSender: replyToSender,
        } : {}),
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

      // 旁观模式冷却 key
      const passiveCooldownKey = isPassiveModeFlag ? `${account.accountId}:${fromId}` : null;

      // ── 停止意图决策 ─────────────────────────────────
      if (isUserStopIntent && config.botStopReplyEnabled !== false) {
        const selfIdStr = String(client.getSelfId() ?? "");
        const ratio = config.botStopReplyRatio ?? 0.66;
        if (!shouldBotReplyToStop(selfIdStr, ratio)) {
          typing.stop();
          return;
        }
        const delay = getBotStopDelay(selfIdStr, config.botStopReplyDelayMaxMs ?? 300);
        if (delay > 0) {
          await sleep(delay);
        }
      }

      try {
        await channelRuntime.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher: () => deliver({
            text: bodyWithReply,
            replyMsg: repliedMsg,
            historyContext,
            isPassiveMode: isPassiveModeFlag,
            isBot,
            isUserStopIntent,
            event,
          } as any),
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

  return () => {
    client.removeAllListeners("message");
  };
}
