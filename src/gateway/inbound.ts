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
import type { InboundContext, Logger, NapcatInboundContext } from "../types/channel-types.js";
import { recordKnownUser } from "../known-users.js";
import { isKnownBot, getBotInfo } from "../known-bots-store.js";
import { shouldBotReplyToStop, getBotStopDelay } from "../utils/bot-decision.js";
import { matchEmojiId } from "../utils/emoji-rules.js";
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
  buildFromId,
  buildBodyWithReply,
} from "../message-processor.js";
import { MessageSender, type MessageSenderContext } from "../message-sender.js";
import { filterStage, type FilterResult } from "./filter.js";
import { triggerStage } from "./trigger.js";
import { ERROR_NOTIFY_SLEEP_MS, GROUP_HISTORY_CACHE_TTL_MS } from "../constants.js";
import { sleep } from "../utils/sleep.js";
import { evictOldest } from "../utils/cache-evict.js";

// ============ 群消息历史缓存 ============

/** 群消息历史缓存上限（条目数），超过后淘汰最旧的条目防止内存泄漏 */
const GROUP_HISTORY_CACHE_MAX = 200;

/** 群消息历史缓存：key = groupId:limit，value = { messages, timestamp } */
const _groupHistoryCache = new Map<string, { messages: Record<string, unknown>[]; timestamp: number }>();

/**
 * 获取带 TTL 缓存的群消息历史，避免每条消息都触发网络 I/O。
 * @param client    OneBotClient 实例
 * @param groupId   群号
 * @param limit     条数限制
 * @param log       日志实例
 * @returns         群消息历史数组，失败返回 null
 */
async function getCachedGroupHistory(
  client: OneBotClient,
  groupId: number | string,
  limit: number,
  log: Logger,
): Promise<any[] | null> {
  const cacheKey = `${groupId}:${limit}`;
  const now = Date.now();
  const cached = _groupHistoryCache.get(cacheKey);
  if (cached && now - cached.timestamp < GROUP_HISTORY_CACHE_TTL_MS) {
    return cached.messages;
  }
  try {
    const history = await client.getGroupMsgHistory(Number(groupId), limit);
    const messages = (history as { messages?: unknown[] } | null)?.messages;
    if (messages && Array.isArray(messages)) {
      _groupHistoryCache.set(cacheKey, { messages: messages as Record<string, unknown>[], timestamp: now });
      evictOldest(_groupHistoryCache, GROUP_HISTORY_CACHE_MAX);
    }
    return (messages as Record<string, unknown>[] | null) ?? null;
  } catch (e) {
    log.warn(`[napcat-QQ] Failed to fetch group history for ${groupId}:`, e);
    return null;
  }
}

export function installMessageHandler(
  client: OneBotClient,
  ctx: InboundContext,
  messageSender?: MessageSender,
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

  const messageHandler = async (event: OneBotEvent) => {
    const filterResult = filterStage(event, client, ctx);
    if (!filterResult) return;

    const { userId, groupId, guildId, channelId, isGroup, isGuild, selfId } = filterResult;
    // 入站计数（filter 已放行）
    ctx.metrics?.increment("inbound", "total");

    try {
      const triggerResult = await triggerStage(
        { event, userId, groupId, guildId, channelId, isGroup, isGuild, selfId, metrics: ctx.metrics },
        client,
        ctx,
      );
      if (!triggerResult) return;

      // 使用 trigger 结果直接获取触发状态（triggerStage 已计算，避免重复执行检测逻辑）
      const { text, isTriggered, isMentioned, isPassiveMode: isPassiveModeFlag } = triggerResult;
      const isBot = triggerResult.isBot;
      const isAdmin = triggerResult.isAdmin;
      const effectiveSelfId = triggerResult.effectiveSelfId;
      const knownBotIdSet = triggerResult.knownBotIdSet;
      const otherBotNames = triggerResult.otherBotNames;
      const isUserStopIntent = triggerResult.isUserStopIntent;

      // ── 消息文本提取（trigger 已解析，此处直接用）──────────────────
      // text 已在 triggerStage 中解析完成

      // ── 获取被引用消息 ────────────────────────────────
      let repliedMsg: Record<string, unknown> | null = null;
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
            log.warn(`[napcat-QQ] Failed to fetch replied message ${replyMsgId}:`, e);
          }
        }
      }

      // ── 历史上下文 ────────────────────────────────────
      let historyContext = "";
      if (isGroup && config.historyLimit !== 0) {
        const limit = config.historyLimit || 5;
        const history = await getCachedGroupHistory(client, groupId!, limit + 1, log);
        if (history) {
          historyContext = history
            .slice(-(limit + 1), -1)
            .map(
              (m: Record<string, unknown>) =>
                `${(m.sender as { nickname?: string; user_id?: unknown } | undefined)?.nickname ?? m.user_id}: ${cleanCQCodes((m.raw_message as string | undefined) ?? "")}`,
            )
            .join("\n");
        }
      }

      // ── 构建 fromId 和会话标签 ──────────────────────
      const fromId = buildFromId(isGroup, isGuild, userId, groupId, guildId, channelId);
      const conversationLabel = isGroup
        ? `QQ Group ${groupId}`
        : isGuild
          ? `QQ Guild ${guildId} Channel ${channelId}`
          : `QQ User ${userId}`;

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
      const sender = messageSender ?? new MessageSender({
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
        !isPassiveModeFlag &&
        (config.enableReactions || config.reactionEmoji) &&
        event.message_id &&
        String(event.user_id) !== String(selfId) &&
        !event.sender?.bot
      ) {
        try {
          const emojiId = config.reactionEmoji ?? matchEmojiId(text);
          await client.setMsgEmojiLike(event.message_id, emojiId);
        } catch (err) {
          log.error(`[napcat-QQ][debug-reaction] FAILED msgId=${event.message_id} err=`, err);
        }
      }

      // ── 被引用消息信息 ──────────────────────────────
      let replyToBody = "";
      let replyToSender = "";
      if (replyMsgId && repliedMsg) {
        const msg = repliedMsg as {
          message?: unknown;
          raw_message?: unknown;
          sender?: { nickname?: unknown; card?: unknown; user_id?: unknown };
        };
        replyToBody = cleanCQCodes(
          typeof msg.message === "string"
            ? msg.message
            : typeof msg.raw_message === "string"
              ? msg.raw_message
              : "",
        );
        replyToSender =
          typeof msg.sender?.nickname === "string"
            ? msg.sender.nickname
            : typeof msg.sender?.card === "string"
              ? msg.sender.card
              : msg.sender?.user_id !== undefined
                ? String(msg.sender.user_id)
                : "";
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

      // ── 派发回复（3.31: dispatchReplyWithBufferedBlockDispatcher）────────────────
      // 旧: createReplyDispatcherWithTyping + dispatchReplyFromConfig + finalizeInboundContext
      // 新: 直接构造 ctx 对象，一步完成派发
      const ctxPayload: NapcatInboundContext = {
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
      };

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
        onRecordError: (err) => log.error("QQ Session Error:", err),
      });

      // ── Typing 状态 ───────────────────────────────────
      const typing = new TypingKeepAlive(client, isGroup || isGuild, groupId, userId, log);
      typing.start();

      // 旁观模式冷却 key
      const passiveCooldownKey = isPassiveModeFlag ? `${account.accountId}:${fromId}` : null;

      // ── 停止意图决策 ─────────────────────────────────
      try {
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
      } catch (err) {
        log.warn("[napcat-QQ] stop-intent decision failed:", err);
        // 降级：不拦截消息，继续正常派发（dispatch 的 finally 会停止 typing）
      }

      try {
        ctx.metrics?.increment("dispatch", "attempts");
        await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: async (payload: unknown) => {
              const dp = payload as Record<string, unknown>;
              await deliver({
                text: (dp.Body ?? dp.text ?? "") as string,
                mediaUrls: (dp.MediaUrls ?? dp.mediaUrls) as string[] | undefined,
                mediaUrl: (dp.MediaUrl ?? dp.mediaUrl) as string | undefined,
                replyToId: (dp.ReplyToId ?? dp.replyToId) as string | undefined,
                replyMsgId,
                historyContext,
                isPassiveMode: isPassiveModeFlag,
                isBot,
                isUserStopIntent,
                event,
              } as any);
            },
            onError: (err: unknown) => log.error("[napcat-QQ] dispatch error:", err),
          },
          replyOptions: {
            onReplyStart: undefined,
          },
        });

        // 派发成功：释放哨兵并写入冷却时间戳
        if (passiveCooldownKey) passiveMode.markDone(passiveCooldownKey);
        ctx.metrics?.increment("dispatch", "succeeded");

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
        ctx.metrics?.increment("dispatch", "failed");

        if (config.enableErrorNotify) {
          // 告警冷却：同一错误模板在冷却窗口内不重复通知
          const alertKey = `dispatch_error:${account.accountId}`;
          if (ctx.alertCooldown?.shouldFire(alertKey)) {
            ctx.alertCooldown.record(alertKey, "dispatch error notified");
            await deliver({ text: "⚠️ 服务调用失败，请稍后重试。" });
          }
        }
        log.error("[napcat-QQ] Reply dispatch error:", error);
      } finally {
        if (debouncer) await debouncer.dispose();
        typing.stop();
      }
    } catch (err) {
      log.error("[napcat-QQ] Critical error in message handler:", err);
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
          log.warn("[napcat-QQ] Failed to send error notification:", notifyErr);
        }
      }
    }
  };

  client.on("message", messageHandler);

  return () => {
    client.removeListener("message", messageHandler);
  };
}
