/**
 * Gateway 入站消息处理器
 *
 * 处理 OneBotClient 的 "message" 事件：消息解析、触发检测、
 * 频控过滤、AI 派发、回复投递。
 * 从 channel.ts startAccount 中提取，行为不变。
 */

import type { ReplyPayload } from "openclaw/plugin-sdk";
import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";
import type { InboundContext } from "../types/channel-types.js";
import { recordKnownUser } from "../known-users.js";
import { populateGroupMemberCache } from "../member-cache.js";
import {
  extractImageUrls,
  cleanCQCodes,
  getReplyMessageId,
} from "../message-parser.js";
import { createDeliverDebouncer, type DeliverPayload } from "../deliver-debounce.js";
import { TypingKeepAlive } from "../typing-keepalive.js";
import { recordRef, lookupRef } from "../ref-index-store.js";
import { handleAdminCommand } from "../admin-commands.js";
import {
  resolveMessageText,
  detectMention,
  detectKeywordTrigger,
  buildFromId,
  buildBodyWithReply,
} from "../message-processor.js";
import { MessageSender } from "../message-sender.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
      if (String(event.user_id) === String(selfId)) return;

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
      // 检测 sender.bot 字段 + 不可见签名（零宽字符）
      if (isGroup) {
        const sigMatch = config.botSignature && text.includes(config.botSignature);
        const isBot = event.sender?.bot || sigMatch;
        if (isBot) {
          console.log(
            `[napcat-QQ][debug-bot-filter] userId=${userId} sender.bot=${event.sender?.bot} sigMatch=${sigMatch} → dropping`,
          );
          if (config.ignoreSenderBot !== false) passiveMode.markBotActive(`group:${groupId}`);
          return;
        }
      }

      const isAdmin = config.admins?.includes(userId!) ?? false;

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
                (cfg as any).session?.store,
                { agentId: "default" },
              );
              await Promise.allSettled(groups.map(async (g) => {
                const gid = String(g.group_id);
                const groupFromId = `group:${gid}`;
                const routeCtx = {
                  Provider: "qq",
                  Channel: "qq",
                  From: groupFromId,
                  To: "qq:bot",
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
                const lastRoute = { channel: "napcat", to: groupFromId, accountId: account.accountId };
                for (const sessionKey of [`qq:${groupFromId}`, `qq:${gid}`]) {
                  await channelRuntime.session.recordInboundSession({
                    storePath,
                    sessionKey,
                    ctx: { ...routeCtx, SessionKey: sessionKey },
                    updateLastRoute: { sessionKey, ...lastRoute },
                    onRecordError: () => {},
                  });
                }
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
          } catch {}
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
        } catch {}
      }

      // ── 触发检测 ──────────────────────────────────────
      let isTriggered = (!isGroup && !isGuild) || text.includes("[动作] 用户戳了你一下");

      const checkMention = isGroup || isGuild;
      let isMentioned = false;
      if (checkMention) {
        const effectiveSelfId = client.getSelfId() ?? event.self_id;
        if (!effectiveSelfId) return;
        isMentioned = detectMention(event, effectiveSelfId, text, repliedMsg);
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
          const cooldownKey = `${account.accountId}:${fromId}`;
          const cooldownMs = config.passiveMode.cooldownMs ?? 10_000;
          const minIntervalMs = config.passiveMode.minIntervalMs ?? 30_000;
          const botSuppressionMs = config.passiveMode.botSuppressionMs ?? 120_000;
          // 友军抑制：其他 bot 近期活跃则跳过（含预占消息）
          if (botSuppressionMs > 0 && passiveMode.isBotSuppressed(`group:${groupId}`, botSuppressionMs)) {
            // 检测到友军活跃，随机延迟错开处理时机，减少竞态
            await sleep(Math.random() * 2000);
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
      const actualDeliver = (payload: ReplyPayload) => sender.deliver(payload as any);

      // ── Deliver Debouncer 包装 ─────────────────────────
      const debouncer = createDeliverDebouncer(
        config.deliverDebounce,
        (p, _info) => actualDeliver(p as ReplyPayload),
        log,
        `[napcat-QQ][debounce]`,
      );

      const deliver = async (payload: unknown) => {
        if (debouncer) {
          await debouncer.deliver(payload as DeliverPayload, { kind: "reply" });
        } else {
          await actualDeliver(payload as ReplyPayload);
        }
      };

      // ── 智能表情回应 ──────────────────────────────────
      if (!isPassiveMode && (config.enableReactions || config.reactionEmoji) && event.message_id) {
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

          console.log(`[napcat-QQ][debug-reaction] msgId=${event.message_id} emojiId=${emojiId}`);
          await client.setMsgEmojiLike(event.message_id, emojiId);
          console.log(`[napcat-QQ][debug-reaction] success msgId=${event.message_id}`);
        } catch (err) {
          console.error(`[napcat-QQ][debug-reaction] FAILED msgId=${event.message_id} err=`, err);
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
            if (body.includes(kw)) {
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

      const bodyWithReply = buildBodyWithReply({
        text,
        repliedMsg,
        systemPrompt: config.systemPrompt,
        historyContext,
        isPassiveMode,
        passivePrompt: config.passiveMode?.systemPrompt,
        botSignature: config.botSignature,
      });

      const ctxPayload = channelRuntime.reply.finalizeInboundContext({
        Provider: "qq",
        Channel: "qq",
        From: fromId,
        To: "qq:bot",
        Body: bodyWithReply,
        RawBody: text,
        SenderId: String(userId),
        SenderName: event.sender?.nickname || "Unknown",
        ConversationLabel: conversationLabel,
        SessionKey: `qq:${fromId}`,
        AccountId: account.accountId,
        ChatType: isGroup ? "group" : isGuild ? "channel" : "direct",
        Timestamp: (event.time ?? Math.floor(Date.now() / 1000)) * 1000,
        OriginatingChannel: "qq",
        OriginatingTo: fromId,
        CommandAuthorized: isAdmin || (!isGroup && !isGuild),
        ...(extractImageUrls(event.message).length > 0 && {
          MediaUrls: extractImageUrls(event.message),
        }),
        ...(replyMsgId && {
          ReplyToId: replyMsgId,
          ReplyToBody: replyToBody,
          ReplyToSender: replyToSender,
        }),
      });

      await channelRuntime.session.recordInboundSession({
        storePath: channelRuntime.session.resolveStorePath(
          (cfg as any).session?.store,
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
            `⚠️ 消息处理异常\n用户: ${userId}\n群组: ${groupId ?? "私聊"}\n` +
            `错误: ${err instanceof Error ? err.message : String(err)}`;
          for (const adminId of config.admins) {
            await client.sendPrivateMsg(adminId, errorMsg);
            await sleep(500);
          }
        } catch (notifyErr) {
          console.warn("[napcat-QQ] Failed to send error notification:", notifyErr);
        }
      }
    }
  });
}
