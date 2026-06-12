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
import { handleAdminCommand } from "../admin-commands.js";
import { registerGroupRoute } from "./group-route-registry.js";
import { maskId } from "../utils/log-sanitize.js";
import {
  BOT_SIGNATURE_PATTERN,
  BOT_SIGNATURE_ZW_PATTERN,
  BOT_STOPPED_SUPPRESS_MS,
  DEFAULT_STOP_KEYWORDS,
} from "../constants.js";

export interface TriggerInput {
  event: OneBotEvent;
  userId: number | undefined;
  groupId: number | undefined;
  guildId: string | undefined;
  channelId: string | undefined;
  isGroup: boolean;
  isGuild: boolean;
  selfId: string;
}

export interface TriggerResult extends TriggerInput {
  text: string;
  isBot: boolean;
  otherBotNames: string[];
  knownBotIdSet: Set<string>;
  isAdmin: boolean;
  effectiveSelfId: string;
  isKnownBotSender: boolean;
  isUserStopIntent: boolean;
  isPassiveMode: boolean;
}

const otherBotNamesResult = new Map<string, { names: string[]; idSet: Set<string> }>();

// ── silentKeywords 正则缓存 ────────────────────────────────────────────
// 每消息 new RegExp() 有 GC 开销，按关键词数组内容签名缓存，配置变更时自动重建
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

export function invalidateOtherBotNamesCache(): void {
  otherBotNamesResult.clear();
}

export async function triggerStage(
  input: TriggerInput,
  client: OneBotClient,
  ctx: InboundContext,
): Promise<TriggerResult | null> {
  const { event, isGroup, isGuild, selfId } = input;
  const { account, config, cfg, channelRuntime, knownGroupIds, passiveMode, log } = ctx;
  let isAdmin =
    (config.admins?.includes(input.userId!) ?? false) ||
    (config.sharedAdmins?.includes(input.userId!) ?? false);

  const text = await resolveMessageText(event, client, config, cfg as Record<string, unknown>, log);

  // 入站频控（滑动窗口）& 静默关键词过滤
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
        return null;
      }
      if (!isAdmin) {
        rateLimiter.record(input.userId, isGroup ? input.groupId : undefined);
      }
    }

    if (config.silentKeywords?.length) {
      const regexes = getSilentKeywordRegexes(config.silentKeywords);
      for (const re of regexes) {
        if (re.test(text)) {
          if (config.debug) {
            log.log(`[napcat-QQ][silent_keyword] matched, dropping message`);
          }
          return null;
        }
      }
    }
  }

  // 高并发热路径：buildOtherBotNames 结果在运行期不变，按 (accountId, knownBotIds) 缓存一次
  const cacheKey = `${account.accountId}:${[...(config.knownBotIds ?? [])].sort().join(",")}`;
  let otherBotNames: string[];
  let knownBotIdSet: Set<string>;
  const cached = otherBotNamesResult.get(cacheKey);
  if (cached) {
    ({ names: otherBotNames, idSet: knownBotIdSet } = cached);
  } else {
    ({ names: otherBotNames, idSet: knownBotIdSet } = buildOtherBotNames(
      account.accountId,
      config.knownBotIds,
      selfId,
    ));
    otherBotNamesResult.set(cacheKey, { names: otherBotNames, idSet: knownBotIdSet });
  }

  let isBot = false;
  if (isGroup) {
    const userIdStr = input.userId != null ? String(input.userId) : null;
    const whitelistMatch = config.knownBotIds?.some(id => String(id) === userIdStr) ?? false;
    const senderBot = event.sender?.bot === true;
    const cachedBotMatch = userIdStr !== null && isKnownBot(account.accountId, userIdStr);
    const sigMatch = BOT_SIGNATURE_PATTERN.exec(text);
    const zwSigMatch = BOT_SIGNATURE_ZW_PATTERN.exec(text);
    const matchedBotId = sigMatch?.[1] ?? zwSigMatch?.[1] ?? null;
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

  if (text.includes("[SYS:GUARD]")) {
    if (config.debug) {
      log.log(`[napcat-QQ][debug-sensitive-guard] cascade blocked: msg contains [SYS:GUARD]`);
    }
    return null;
  }
  const effectiveSelfId = selfId;

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

    if (isCmdMentioned) {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0];
      const handled = await handleAdminCommand(cmd, parts, {
        client,
        isGroup,
        groupId: input.groupId,
        userId: input.userId,
        text,
        message: event.message,
        eventTime: event.time ? event.time * 1000 : undefined,
        rateLimiter: ctx.inboundStore.rateLimiter,
        refreshGroupRoutes: async () => {
          const groups = await client.getGroupList();
          await Promise.allSettled(
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
          log.info(`[napcat-QQ] /groups: refreshed ${groups.length} group routes`);
          return groups.length;
        },
      });
      if (handled) return null;
    }
  }

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

  let isPassiveMode = false;

  if (checkMention && config.requireMention && !isTriggered && !isMentioned) {
    if (config.passiveMode?.enabled && isGroup) {
      if (hasMentionOtherUser(event, selfId, otherBotNames)) {
        if (config.debug) {
          log.log(`[napcat-QQ][debug-mention-other] passive mode skipped: msg @ other user, not bot`);
        }
        return null;
      }
      const cooldownKey = `${account.accountId}:${input.groupId}`;
      const cooldownMs = config.passiveMode.cooldownMs ?? 10_000;
      const minIntervalMs = config.passiveMode.minIntervalMs ?? 30_000;
      const botSuppressionMs = config.passiveMode.botSuppressionMs ?? 120_000;
      if (botSuppressionMs > 0 && passiveMode.isBotSuppressed(`group:${input.groupId}`, botSuppressionMs)) {
        if (config.debug) {
          log.log(`[napcat-QQ][debug-passive] bot suppression active, skipping`);
        }
        return null;
      }
      if (!passiveMode.isIntervalAllowed(cooldownKey, minIntervalMs)) return null;
      if (!passiveMode.isAllowed(cooldownKey, cooldownMs)) return null;
      isPassiveMode = true;
      passiveMode.markActive(cooldownKey);
      passiveMode.markCheck(cooldownKey);
    } else {
      return null;
    }
  }

  let isUserStopIntent = false;
  if (isGroup && input.groupId && !isBot) {
    if (isTriggered || isMentioned || isPassiveMode || !config.requireMention) {
      recordUserMessage(account.accountId, `group:${input.groupId}`);
    }
    if (config.botStopReplyEnabled !== false) {
      const stopKeywords = (config.botStopKeywords && config.botStopKeywords.length > 0)
        ? config.botStopKeywords
        : DEFAULT_STOP_KEYWORDS;
      if (detectStopIntent(text, stopKeywords)) {
        isUserStopIntent = true;
        markStopped(account.accountId, `group:${input.groupId}`);
        if (config.debug) {
          log.log(`[napcat-QQ][debug-dialog] user stop intent detected`);
        }
      }
    }
  }

  return {
    ...input,
    text,
    isBot,
    otherBotNames,
    knownBotIdSet,
    isAdmin,
    effectiveSelfId,
    isKnownBotSender,
    isUserStopIntent,
    isPassiveMode,
  };
}
