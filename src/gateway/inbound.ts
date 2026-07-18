/**
 * Gateway 入站消息处理器
 *
 * 处理 OneBotClient 的 "message" 事件：消息解析、触发检测、
 * 频控过滤、AI 派发、回复投递。
 * 采用两阶段管道：filter → trigger，dispatch 保持 inline
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
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
import { MessageSender } from "../message-sender.js";
import { filterStage, type FilterResult } from "./filter.js";
import { triggerStage } from "./trigger.js";
import {
  ERROR_NOTIFY_SLEEP_MS,
  GROUP_HISTORY_CACHE_TTL_MS,
  SESSION_CONFLICT_PATTERN,
  SESSION_CONFLICT_RETRIES,
  SESSION_CONFLICT_BASE_DELAY_MS,
  SESSION_CONFLICT_JITTER_MIN_RATIO,
} from "../constants.js";
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

// ============ session 冲突检测 ============

/**
 * 判断错误是否为框架 session 初始化冲突。
 *
 * 用于统一识别 openclaw 框架并发 session 初始化时抛出的特定错误，
 * 触发重试 / 降级 / 噪音抑制路径。集中在此消除多处手抄正则。
 *
 * @param err  捕获到的未知错误对象。
 * @returns    是 Error 且 message 命中冲突特征时返回 true，否则 false。
 */
export function isSessionConflictError(err: unknown): boolean {
  return err instanceof Error && SESSION_CONFLICT_PATTERN.test(err.message);
}

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

  const messageHandler = async (event: OneBotEvent) => {
    const filterResult = filterStage(event, client, ctx);
    if (!filterResult) return;

    const { userId, groupId, guildId, channelId, isGroup, isGuild, selfId } = filterResult;
    // filterStage 已在入口对 inbound.total 计数，此处无需重复

    // 每条消息创建独立的 MessageSender，携带正确的发送上下文
    // 修复：之前全局复用的 MessageSender isGroup 永远为 false，导致群消息走私聊 API
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
      log,
      metrics: ctx.metrics,
    });

    // typing 声明在函数作用域，确保外层 catch 也能 stop
    let typing: TypingKeepAlive | undefined;

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
        } catch (err) {
          log.warn(`[napcat-QQ] resolveAgentRoute failed for group ${groupId}, using fallback session key:`, err);
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
        ...(event.message_id ? { MessageSid: String(event.message_id) } : {}),
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

      // session 记录（SDK 可选能力，不存在时静默跳过）
      if (channelRuntime.session?.recordInboundSession && channelRuntime.session?.resolveStorePath) {
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
      }

      // ── Typing 状态 ───────────────────────────────────
      typing = new TypingKeepAlive(client, isGroup || isGuild, groupId, userId, log);
      typing.start();

      // 旁观模式冷却 key
      const passiveCooldownKey = isPassiveModeFlag ? `${account.accountId}:${fromId}` : null;

      // ── 停止意图决策 ─────────────────────────────────
      try {
        if (isUserStopIntent && config.botStopReplyEnabled !== false) {
          const selfIdStr = String(client.getSelfId() ?? "");
          const ratio = config.botStopReplyRatio ?? 0.66;
          if (!shouldBotReplyToStop(selfIdStr, ratio)) {
            typing?.stop();
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
        const dispatch = channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher;
        if (!dispatch) {
          throw new Error("[napcat-QQ] dispatchReplyWithBufferedBlockDispatcher not available");
        }
        const sessionKey = ctxPayload.SessionKey as string | undefined;
        const chatId = ctxPayload.To ?? ctxPayload.From;
        log.info(`[napcat-QQ][dispatch-debug] about to dispatch sessionKey=${sessionKey ?? "(none)"} chatId=${chatId}`);

        // 框架 session 初始化冲突重试（最多 3 次，指数退避 2000/4000/8000ms + 抖动）
        // 冲突持续时降级为直接发送，避免用户收不到回复
        let dispatchError: unknown;
        let lastDeliverPayload: { text?: string; mediaUrls?: string[]; mediaUrl?: string } | undefined;
        for (let attempt = 0; attempt <= SESSION_CONFLICT_RETRIES; attempt++) {
          try {
            await dispatch({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                deliver: async (payload: unknown) => {
                  const dp = payload as Record<string, unknown>;
                  const deliverText = String(dp.Body ?? dp.text ?? "");
                  const mediaUrls = dp.MediaUrls ?? dp.mediaUrls;
                  const hasMedia = Boolean(Array.isArray(mediaUrls) && mediaUrls.length > 0) || Boolean(dp.MediaUrl);
                  lastDeliverPayload = {
                    text: deliverText || undefined,
                    mediaUrls: mediaUrls as string[] | undefined,
                    mediaUrl: (dp.MediaUrl ?? dp.mediaUrl) as string | undefined,
                  };
                  log.info(`[napcat-QQ][deliver-debug] deliver called, text.length=${deliverText.length}, hasMedia=${hasMedia}`);
                  try {
                    await deliver({
                      text: deliverText,
                      mediaUrls: mediaUrls as string[] | undefined,
                      mediaUrl: (dp.MediaUrl ?? dp.mediaUrl) as string | undefined,
                      replyToId: (dp.ReplyToId ?? dp.replyToId) as string | undefined,
                      replyMsgId,
                      historyContext,
                      isPassiveMode: isPassiveModeFlag,
                      isBot,
                      isUserStopIntent,
                      event,
                    } as any);
                    log.info(`[napcat-QQ][deliver-debug] deliver completed`);
                  } catch (deliverErr) {
                    log.error(`[napcat-QQ][deliver-debug] deliver FAILED:`, deliverErr);
                    throw deliverErr;
                  }
                },
                onError: (err: unknown) => log.error("[napcat-QQ] dispatch error:", err),
              },
              replyOptions: {
                onReplyStart: undefined,
              },
            });
            dispatchError = null;
            break; // 成功，跳出重试循环
          } catch (err) {
            dispatchError = err;
            if (isSessionConflictError(err) && attempt < SESSION_CONFLICT_RETRIES) {
              // 指数退避 baseDelay = BASE * 2**attempt（2000/4000/8000），叠加抖动避免惊群
              const baseDelay = SESSION_CONFLICT_BASE_DELAY_MS * 2 ** attempt;
              const retryDelay = Math.floor(
                baseDelay * (SESSION_CONFLICT_JITTER_MIN_RATIO + Math.random() * (1 - SESSION_CONFLICT_JITTER_MIN_RATIO)),
              );
              log.warn(`[napcat-QQ][dispatch-debug] session conflict, retry ${attempt + 1}/${SESSION_CONFLICT_RETRIES} in ${retryDelay}ms: ${(err as Error).message}`);
              await sleep(retryDelay);
              continue;
            }
            break; // 非冲突错误或重试耗尽，跳出循环
          }
        }

        if (dispatchError) {
          const isSessionConflict = isSessionConflictError(dispatchError);
          if (isSessionConflict && lastDeliverPayload) {
            log.warn(`[napcat-QQ][dispatch-debug] session conflict after ${SESSION_CONFLICT_RETRIES} retries, falling back to direct send`);
            try {
              // 降级重放：复用 actualDeliver（绕过 debouncer，降级应立即发送）重放最后一次 deliver。
              // sender 已持有正确的 isGroup/groupId/userId 上下文，天然发到正确目标，
              // 并走完整 MessageSender 管线（markdown 格式化 / 分片 / 上传缓存 / 去重）。
              await actualDeliver(lastDeliverPayload);
              log.info(`[napcat-QQ][dispatch-debug] fallback direct send succeeded`);
              // 降级送达也算成功：释放哨兵为 markDone，并计 dispatch.succeeded
              if (passiveCooldownKey) passiveMode.markDone(passiveCooldownKey);
              ctx.metrics?.increment("dispatch", "succeeded");
            } catch (fallbackErr) {
              log.error(`[napcat-QQ][dispatch-debug] fallback direct send failed:`, fallbackErr);
              // 降级发送失败：释放哨兵为 markSilent（不写冷却，允许用户立即重试），并计 dispatch.failed
              if (passiveCooldownKey) passiveMode.markSilent(passiveCooldownKey);
              ctx.metrics?.increment("dispatch", "failed");
            }
          } else {
            throw dispatchError;
          }
        } else {
          // 派发成功：释放哨兵并写入冷却时间戳
          if (passiveCooldownKey) passiveMode.markDone(passiveCooldownKey);
          ctx.metrics?.increment("dispatch", "succeeded");

          log.info(`[napcat-QQ][dispatch-debug] dispatch succeeded sessionKey=${sessionKey ?? "(none)"}`);
          }

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
          // session 冲突是框架内部 bug，用户无法干预，不发送噪音通知
          const isFrameworkSessionConflict = isSessionConflictError(error);
          if (!isFrameworkSessionConflict && ctx.alertCooldown?.shouldFire(alertKey)) {
            ctx.alertCooldown.record(alertKey, "dispatch error notified");
            await deliver({ text: "⚠️ 服务调用失败，请稍后重试。" });
          }
        }
        const errorDetails = error instanceof Error
          ? `${error.name}: ${error.message} | stack: ${error.stack?.split('\n').slice(0, 3).join(' | ')}`
          : String(error ?? "(empty/null error)");
        log.error(`[napcat-QQ] Reply dispatch error: ${errorDetails}`);
      } finally {
        if (debouncer) {
          try {
            await debouncer.dispose();
          } catch (disposeErr) {
            log.warn("[napcat-QQ] debouncer dispose failed:", disposeErr);
          }
        }
        typing?.stop();
      }
    } catch (err) {
      // 确保 typing 状态释放（recordInboundSession/downloadImages 等前置步骤异常时）
      typing?.stop();
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
