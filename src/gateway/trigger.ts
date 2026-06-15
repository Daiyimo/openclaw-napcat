/**
 * 入站消息触发检测阶段。
 *
 * 负责友军识别、指向性门控、敏感守卫、管理员命令、@其他人检测、
 * 触发检测（mention/name/keyword）、旁观模式、停止意图。
 */

import type { OneBotClient } from "../client.js";
import type { OneBotEvent } from "../types.js";
import type { InboundContext } from "../types/channel-types.js";
import { isKnownBot, recordKnownBot, fetchBotInfoAsync } from "../known-bots-store.js";
import { getDialogState, markStopped, recordUserMessage, recordBotTurn } from "../dialog-state.js";
import { detectStopIntent } from "../utils/bot-decision.js";
import {
  detectSensitiveFileRequest,
  DEFAULT_REJECTION_MESSAGE,
} from "../utils/sensitive-guard.js";
import {
  detectMention,
  detectKeywordTrigger,
  detectNameTrigger,
  hasMentionOtherUser,
  isMessageDirectedAtBot,
  buildOtherBotNames,
  resolveMessageText,
} from "../message-processor.js";
import { parseBotHandshake } from "../utils/bot-handshake.js";
import { evictLru } from "../utils/cache-evict.js";
import { handleAdminCommand } from "../admin-commands.js";
import { getConfigRef, updateConfigRef } from "../config-watcher.js";
import { resolvePassiveModeTemperature } from "../config.js";
import { registerGroupRoute } from "./group-route-registry.js";
import { maskId } from "../utils/log-sanitize.js";
import {
  BOT_SIGNATURE_PATTERN,
  BOT_SIGNATURE_ZW_PATTERN,
  BOT_STOPPED_SUPPRESS_MS,
  DEFAULT_STOP_KEYWORDS,
} from "../constants.js";

import type { MetricsCollector } from "../metrics.js";

export interface TriggerInput {
  event: OneBotEvent;
  userId: number | undefined;
  groupId: number | undefined;
  guildId: string | undefined;
  channelId: string | undefined;
  isGroup: boolean;
  isGuild: boolean;
  selfId: string;
  /** 指标收集器（可选） */
  metrics?: MetricsCollector;
}

export interface TriggerResult extends TriggerInput {
  text: string;
  isTriggered: boolean;
  isMentioned: boolean;
  isBot: boolean;
  otherBotNames: string[];
  knownBotIdSet: Set<string>;
  isAdmin: boolean;
  effectiveSelfId: string;
  isKnownBotSender: boolean;
  isUserStopIntent: boolean;
  isPassiveMode: boolean;
}

// ── otherBotNames 缓存 ────────────────────────────────────────────────────

/** 缓存条目：{ names, idSet, lastAccess } */
interface CacheEntry {
  names: string[];
  idSet: Set<string>;
  lastAccess: number;
}

/** 缓存最大条目数，超过时淘汰最久未使用的条目（LRU） */
const OTHER_BOT_NAMES_CACHE_MAX = 500;

/** 缓存 key → 条目 */
const otherBotNamesCache = new Map<string, CacheEntry>();

/**
 * 获取缓存的 otherBotNames 结果，key 变更时自动重建。
 * 使用 lastAccess 时间戳实现 LRU 淘汰。
 */
function getCachedOtherBotNames(cacheKey: string): { names: string[]; idSet: Set<string> } | null {
  const entry = otherBotNamesCache.get(cacheKey);
  if (!entry) return null;
  entry.lastAccess = Date.now();
  return { names: entry.names, idSet: entry.idSet };
}

function setCachedOtherBotNames(cacheKey: string, names: string[], idSet: Set<string>): void {
  otherBotNamesCache.set(cacheKey, { names, idSet, lastAccess: Date.now() });
  if (otherBotNamesCache.size > OTHER_BOT_NAMES_CACHE_MAX) {
    evictLru(otherBotNamesCache, Math.floor(OTHER_BOT_NAMES_CACHE_MAX / 2));
  }
}

export function invalidateOtherBotNamesCache(): void {
  otherBotNamesCache.clear();
}

// ── silentKeywords 正则缓存 ────────────────────────────────────────────

let silentKeywordsCache: { key: string; regexes: RegExp[] } | null = null;

function getSilentKeywordRegexes(keywords: string[]): RegExp[] {
  const key = JSON.stringify(keywords);
  if (silentKeywordsCache?.key === key) return silentKeywordsCache.regexes;
  const regexes = keywords.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`);
  });
  silentKeywordsCache = { key, regexes };
  return regexes;
}

// ── 子函数：管理员命令处理 ──────────────────────────────────────────────

interface HandleAdminResult {
  handled: boolean;
}

async function handleAdminCommandStage(
  input: TriggerInput,
  client: OneBotClient,
  ctx: InboundContext,
  text: string,
  isCmdMentioned: boolean,
): Promise<HandleAdminResult> {
  const { account, config, cfg, channelRuntime, knownGroupIds, log } = ctx;

  if (!isCmdMentioned) {
    // 自然语言温度调整（admin 专属）
    const tempMatch = text.match(/(?:温度|活跃度|回复频率)\s*[=:：]?\s*(\d+)/i);
    if (tempMatch && !input.isGuild) {
      const t = Number(tempMatch[1]);
      if (Number.isInteger(t) && t >= 0 && t <= 100) {
        const configRef = getConfigRef();
        if (configRef) {
          const pm = configRef.current.passiveMode ?? {};
          const updated = { ...configRef.current, passiveMode: { ...pm, temperature: t } };
          const result = updateConfigRef(configRef, updated);
          const mapped = resolvePassiveModeTemperature(t) ?? {};
          const reply = result.success
            ? `✅ 温度设为 ${t}\n冷却 ${(mapped.cooldownMs ?? 0) / 1000}s / 最小间隔 ${(mapped.minIntervalMs ?? 0) / 1000}s / Bot压制 ${(mapped.botSuppressionMs ?? 0) / 1000}s`
            : `❌ 设置失败: ${result.error}`;
          if (input.isGroup && input.groupId) {
            await client.sendGroupMsg(input.groupId, reply);
          } else if (input.userId) {
            await client.sendPrivateMsg(input.userId, reply);
          }
          return { handled: true };
        }
      }
    }
    return { handled: false };
  }

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];
  const handled = await handleAdminCommand(cmd, parts, {
    client,
    isGroup: input.isGroup,
    groupId: input.groupId,
    userId: input.userId,
    text,
    message: input.event.message,
    eventTime: input.event.time ? input.event.time * 1000 : undefined,
    rateLimiter: ctx.inboundStore.rateLimiter,
    metrics: input.metrics,
    alertCooldown: ctx.alertCooldown,
    refreshGroupRoutes: async () => {
      const groups = await client.getGroupList();
      const results = await Promise.allSettled(
        groups.map((g) =>
          registerGroupRoute({
            client,
            cfg: cfg as Record<string, unknown>,
            accountId: account.accountId,
            groupId: g.group_id,
            channelRuntime,
            knownGroupIds,
            log,
          }),
        ),
      );
      const successCount = results.filter((r) => r.status === "fulfilled" && r.value).length;
      log.info(`[napcat-QQ] /groups: refreshed ${successCount}/${groups.length} group routes`);
      return successCount;
    },
  });
  return { handled };
}

// ── 子函数：被动模式检查 ─────────────────────────────────────────────────

interface PassiveModeResult {
  isPassiveMode: boolean;
}

function checkPassiveMode(
  input: TriggerInput,
  ctx: InboundContext,
  isTriggered: boolean,
  isMentioned: boolean,
  requireMention: boolean,
): PassiveModeResult {
  const { config, passiveMode } = ctx;
  const isGroup = input.isGroup;

  if (!isGroup || !requireMention || isTriggered || isMentioned) {
    return { isPassiveMode: false };
  }

  if (!config.passiveMode?.enabled) {
    return { isPassiveMode: false };
  }

  const cooldownKey = `${ctx.account.accountId}:${input.groupId}`;
  const cooldownMs = config.passiveMode.cooldownMs ?? 10_000;
  const minIntervalMs = config.passiveMode.minIntervalMs ?? 30_000;
  const botSuppressionMs = config.passiveMode.botSuppressionMs ?? 120_000;

  if (botSuppressionMs > 0 && passiveMode.isBotSuppressed(`group:${input.groupId}`, botSuppressionMs)) {
    if (config.debug) {
      ctx.log.log(`[napcat-QQ][debug-passive] bot suppression active, skipping`);
    }
    return { isPassiveMode: false };
  }
  // ⚠️ P0 修复：markCheck 必须在 isIntervalAllowed 之前调用，记录本次旁观检查时间戳
  passiveMode.markCheck(cooldownKey);
  if (!passiveMode.isIntervalAllowed(cooldownKey, minIntervalMs)) return { isPassiveMode: false };
  if (!passiveMode.isAllowed(cooldownKey, cooldownMs)) return { isPassiveMode: false };

  // ⚠️ P0 修复：isAllowed 通过后必须设置哨兵，防止并发消息同时派发到 AI
  passiveMode.markActive(cooldownKey);

  return { isPassiveMode: true };
}

// ── 子函数：停止意图检测 ─────────────────────────────────────────────────

interface StopIntentResult {
  isUserStopIntent: boolean;
}

function detectUserStopIntent(
  input: TriggerInput,
  ctx: InboundContext,
  text: string,
  isBot: boolean,
): StopIntentResult {
  const { config } = ctx;
  const isGroup = input.isGroup;

  if (!isGroup || !input.groupId || isBot) {
    return { isUserStopIntent: false };
  }

  if (config.botStopReplyEnabled !== false) {
    const stopKeywords = (config.botStopKeywords && config.botStopKeywords.length > 0)
      ? config.botStopKeywords
      : DEFAULT_STOP_KEYWORDS;
    if (detectStopIntent(text, stopKeywords)) {
      return { isUserStopIntent: true };
    }
  }

  return { isUserStopIntent: false };
}

// ── 主函数 ──────────────────────────────────────────────────────────────

export async function triggerStage(
  input: TriggerInput,
  client: OneBotClient,
  ctx: InboundContext,
): Promise<TriggerResult | null> {
  const { event, isGroup, isGuild, selfId, metrics } = input;
  const { account, config, cfg, channelRuntime, knownGroupIds, passiveMode, log } = ctx;
  let isAdmin =
    (config.admins?.includes(input.userId!) ?? false) ||
    (config.sharedAdmins?.includes(input.userId!) ?? false);

  // ── 入站频控（滑动窗口）— 在 resolveMessageText 之前检查，避免浪费 STT I/O ──
  {
    const rateLimiter = ctx.inboundStore.rateLimiter;
    if (rateLimiter && config.inboundRateLimitMs > 0) {
      const result = rateLimiter.check(input.userId, isGroup ? input.groupId : undefined, isAdmin);
      if (!result.allowed) {
        if (config.debug) {
          log.log(
            `[napcat-QQ][rate_limit] rate limited: user=${maskId(input.userId)} group=${input.groupId} ` +
              `retryAfter=${result.retryAfterMs}ms count=${result.currentCount}`,
          );
        }
        metrics?.increment("inbound", "rateLimited");
        return null;
      }
      if (!isAdmin) {
        rateLimiter.record(input.userId, isGroup ? input.groupId : undefined);
      }
    }
  }

  const text = await resolveMessageText(event, client, config, cfg as Record<string, unknown>, log);

  // ── 静默关键词过滤 ─────────────────────────────────────
  if (config.silentKeywords?.length) {
    const regexes = getSilentKeywordRegexes(config.silentKeywords);
    for (const re of regexes) {
      if (re.test(text)) {
        if (config.debug) {
          log.log(`[napcat-QQ][silent_keyword] matched, dropping message`);
        }
        metrics?.increment("inbound", "silentDropped");
        return null;
      }
    }
  }

  // ── otherBotNames 缓存（key 预计算）────────────────────────────────
  // knownBotIds 在运行期不变，配置变更时 invalidateOtherBotNamesCache() 清理
  // 因此只需在首次和 key 变更时计算
  const knownBotIdsSorted = config.knownBotIds
    ? [...config.knownBotIds].sort().join(",")
    : "";
  const cacheKey = `${account.accountId}:${selfId}:${knownBotIdsSorted}`;
  let otherBotNames: string[];
  let knownBotIdSet: Set<string>;
  const cached = getCachedOtherBotNames(cacheKey);
  if (cached) {
    ({ names: otherBotNames, idSet: knownBotIdSet } = cached);
  } else {
    ({ names: otherBotNames, idSet: knownBotIdSet } = buildOtherBotNames(
      account.accountId,
      config.knownBotIds,
      selfId,
    ));
    setCachedOtherBotNames(cacheKey, otherBotNames, knownBotIdSet);
  }

  // ── 友军识别 ────────────────────────────────────────────────────────
  let isBot = false;
  if (isGroup) {
    const userIdStr = input.userId != null ? String(input.userId) : null;
    const whitelistMatch = config.knownBotIds?.some(id => String(id) === userIdStr) ?? false;
    const senderBot = event.sender?.bot === true;
    const cachedBotMatch = userIdStr !== null && isKnownBot(account.accountId, userIdStr);
    const sigMatch = BOT_SIGNATURE_PATTERN.exec(text);
    const zwSigMatch = BOT_SIGNATURE_ZW_PATTERN.exec(text);
    const matchedBotId = sigMatch?.[1] ?? zwSigMatch?.[1] ?? null;
    if (matchedBotId) {
      metrics?.increment("cache", "botSigHits");
    }
    let handshakeMatch: string | null = null;
    if (Array.isArray(event.message)) {
      const hs = parseBotHandshake(event.message);
      if (hs) handshakeMatch = hs.selfId;
    }
    isBot = whitelistMatch || senderBot || cachedBotMatch || matchedBotId !== null || handshakeMatch !== null;
    if (config.debug) {
      log.log(
        `[napcat-QQ][debug-bot-filter] userId=${maskId(input.userId)} whitelist=${whitelistMatch} ` +
          `sender.bot=${senderBot} cachedBot=${cachedBotMatch} sigMatch=${matchedBotId} ` +
          `handshake=${handshakeMatch} isBot=${isBot} text="${text.slice(0, 80)}"`,
      );
    }
    if (isBot) {
      if (matchedBotId !== null) {
        recordKnownBot(account.accountId, matchedBotId);
        void fetchBotInfoAsync(client, account.accountId, matchedBotId, isGroup ? input.groupId : undefined, log).catch(
          (err: unknown) => {
             log.warn(`[napcat-QQ] Failed to fetch bot info for ${matchedBotId}: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
      }
      if (handshakeMatch !== null) {
        recordKnownBot(account.accountId, handshakeMatch);
        void fetchBotInfoAsync(client, account.accountId, handshakeMatch, isGroup ? input.groupId : undefined, log).catch(
          (err: unknown) => {
            log.warn?.(`[napcat-QQ] Failed to fetch bot info for ${handshakeMatch}: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
        if (config.debug) {
          log.log(`[napcat-QQ][debug-handshake] recorded bot ${handshakeMatch} from handshake, skipping AI dispatch`);
        }
        return null;
      }
      if (config.ignoreSenderBot !== false) {
        passiveMode.markBotActive(`group:${input.groupId}`);
        const dialogKey = `group:${input.groupId}`;
        const dialog = getDialogState(account.accountId, dialogKey);
        const maxRounds = config.botDialogMaxRounds ?? 5;

        if (dialog.stoppedAt !== null && Date.now() - dialog.stoppedAt < BOT_STOPPED_SUPPRESS_MS) {
          if (config.debug) {
            log.log(`[napcat-QQ][debug-dialog] bot msg dropped: dialog stopped at ${dialog.stoppedAt}`);
          }
          return null;
        }

        if (dialog.rounds >= maxRounds) {
          if (config.debug) {
            log.log(`[napcat-QQ][debug-dialog] bot msg dropped: rounds=${dialog.rounds} >= ${maxRounds}`);
          }
          return null;
        }

        recordBotTurn(account.accountId, dialogKey, String(input.userId));
        if (config.debug) {
          log.log(`[napcat-QQ][debug-dialog] bot msg allowed: rounds=${dialog.rounds + 1}/${maxRounds}`);
        }
      }
    }
  }

  // ── 指向性门控 ──────────────────────────────────────────────────────
  if (!isBot) {
    if (!isMessageDirectedAtBot(event, selfId, text, config._selfName, otherBotNames)) {
      if (config.debug) {
        log.log(
          `[napcat-QQ][debug-directed] silent drop: msg not directed at this bot, user=${maskId(input.userId)}`,
        );
      }
      return null;
    }
  }

  // ── 级联阻断标记 ────────────────────────────────────────────────────
  if (text.includes("[SYS:GUARD]")) {
    if (config.debug) {
      log.log(`[napcat-QQ][debug-sensitive-guard] cascade blocked: msg contains [SYS:GUARD]`);
    }
    return null;
  }
  const effectiveSelfId = selfId;

  // ── 敏感守卫 ────────────────────────────────────────────────────────
  const isKnownBotSender =
    isGroup &&
    (knownBotIdSet.has(String(input.userId)) ||
      event.sender?.bot === true ||
      (input.userId != null && isKnownBot(account.accountId, String(input.userId))) ||
      (BOT_SIGNATURE_PATTERN.test(text) || BOT_SIGNATURE_ZW_PATTERN.test(text)));
  if (!isAdmin && !isKnownBotSender && config.sensitiveFileGuard?.enabled !== false) {
    const guardOpts = {
      ...(config.sensitiveFileGuard?.files ? { files: config.sensitiveFileGuard.files } : {}),
      ...(config.sensitiveFileGuard?.verbs ? { verbs: config.sensitiveFileGuard.verbs } : {}),
      ...(config.sensitiveFileGuard?.nouns ? { nouns: config.sensitiveFileGuard.nouns } : {}),
    };
    const check = detectSensitiveFileRequest(text, guardOpts);
    if (check.matched) {
      const isDirectedAtMe = isMessageDirectedAtBot(event, effectiveSelfId, text, config._selfName);

      if (!isDirectedAtMe) {
        if (config.debug) {
          log.log(
            `[napcat-QQ][debug-sensitive-guard] silent drop: matched but not directed at bot, user=${maskId(input.userId)}`,
          );
        }
        return null;
      }

      const rejectMsg = (config.sensitiveFileGuard?.rejectMessage ?? DEFAULT_REJECTION_MESSAGE) + "[SYS:GUARD]";
      if (isGroup && input.groupId) {
        await client.sendGroupMsg(input.groupId, rejectMsg);
      } else if (input.userId) {
        await client.sendPrivateMsg(input.userId, rejectMsg);
      }
      if (config.debug) {
        log.log(
          `[napcat-QQ][debug-sensitive-guard] blocked user=${maskId(input.userId)} reason=${check.reason} hit=${check.hit} directed=${isDirectedAtMe}`,
        );
      }
      return null;
    }
  }

  // ── 管理员命令 ──────────────────────────────────────────────────────
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
            ) {
              return true;
            }
          }
        }
        return text.includes(`[CQ:at,qq=${sid}]`);
      })();

    const adminResult = await handleAdminCommandStage(input, client, ctx, text, isCmdMentioned);
    if (adminResult.handled) return null;
  }

  // ── 触发检测 ────────────────────────────────────────────────────────
  if (isGroup || isGuild) {
    if (selfId && !detectMention(event, selfId, text, null, config.debug, log)) {
      if (hasMentionOtherUser(event, selfId, otherBotNames)) {
        if (config.debug) {
          log.log(`[napcat-QQ][debug-mention-other] skipping message that @mentions other user, not bot`);
        }
        return null;
      }
    }
  }

  let isTriggered = (!isGroup && !isGuild) || text.includes("[动作] 用户戳了你一下");

  const checkMention = isGroup || isGuild;
  let isMentioned = false;
  if (checkMention) {
    if (!selfId) return null;
    isMentioned = detectMention(event, selfId, text, null, config.debug, log);
  }

  if (!isTriggered && !isMentioned && checkMention) {
    const botName = config._selfName;
    if (botName && detectNameTrigger(text, botName, config.debug, log)) {
      isTriggered = true;
      if (config.debug) {
        log.log(`[napcat-QQ][debug-trigger] name trigger activated: botName="${botName}"`);
      }
    }
  }

  if (!isTriggered) {
    isTriggered = detectKeywordTrigger(text, config.keywordTriggers);
  }

  // ── 被动模式 ────────────────────────────────────────────────────────
  const requireMention = config.requireMention ?? true;
  const passiveResult = checkPassiveMode(input, ctx, isTriggered, isMentioned, requireMention);

  if (checkMention && requireMention && !isTriggered && !isMentioned) {
    if (hasMentionOtherUser(event, selfId, otherBotNames)) {
      if (config.debug) {
        log.log(`[napcat-QQ][debug-mention-other] passive mode skipped: msg @ other user, not bot`);
      }
      return null;
    }
    if (!passiveResult.isPassiveMode) return null;
  }

  // ── 停止意图 ────────────────────────────────────────────────────────
  const stopResult = detectUserStopIntent(input, ctx, text, isBot);
  if (stopResult.isUserStopIntent) {
    markStopped(account.accountId, `group:${input.groupId}`);
    if (config.debug) {
      log.log(`[napcat-QQ][debug-dialog] user stop intent detected`);
    }
  }

  // ── 对话状态记录 ────────────────────────────────────────────────────
  if (isGroup && input.groupId && !isBot) {
    if (isTriggered || isMentioned || passiveResult.isPassiveMode || !requireMention) {
      recordUserMessage(account.accountId, `group:${input.groupId}`);
    }
  }

  metrics?.increment("inbound", "triggered");

  return {
    ...input,
    text,
    isTriggered,
    isMentioned,
    isBot,
    otherBotNames,
    knownBotIdSet,
    isAdmin,
    effectiveSelfId,
    isKnownBotSender,
    isUserStopIntent: stopResult.isUserStopIntent,
    isPassiveMode: passiveResult.isPassiveMode,
  };
}
