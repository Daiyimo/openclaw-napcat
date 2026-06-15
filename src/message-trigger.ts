/**
 * 触发检测模块
 *
 * 负责所有触发条件判断：@检测、关键词触发、名字触发、
 * 指向性门控、其他 bot 名字构建。
 * 从 message-processor.ts 提取，不改变任何业务逻辑。
 */

import type { OneBotEvent } from "./types.js";
import { getBotInfo } from "./known-bots-store.js";
import { maskId } from "./utils/log-sanitize.js";
import type { Logger } from "./types/channel-types.js";

// ============ @ 检测 ============

/**
 * 检测消息是否 @ 了机器人（message 数组或 CQ string 均支持），
 * 或者是否回复了机器人发的消息。
 */
export function detectMention(
  event: OneBotEvent,
  selfId: number | string,
  text: string,
  repliedMsg?: { sender?: { user_id?: number } } | null,
  debug = false,
  log?: Logger,
): boolean {
  if (Array.isArray(event.message)) {
    for (const s of event.message) {
      if (s.type === "at") {
        if (String(s.data?.qq) === String(selfId) || s.data?.qq === "all") {
          if (debug) (log ?? console).log(`[napcat-QQ][debug-mention] MATCH at segment qq=${s.data?.qq} selfId=${selfId}`);
          return true;
        }
      }
    }
  } else if (text.includes(`[CQ:at,qq=${selfId}]`)) {
    if (debug) (log ?? console).log(`[napcat-QQ][debug-mention] MATCH text fallback selfId=${selfId}`);
    return true;
  }
  if (repliedMsg?.sender?.user_id !== undefined) {
    if (String(repliedMsg.sender.user_id) === String(selfId)) {
      if (debug) (log ?? console).log(`[napcat-QQ][debug-mention] MATCH reply sender userId=${maskId(repliedMsg.sender.user_id)} selfId=${selfId}`);
      return true;
    }
  }
  return false;
}

/**
 * 检测消息中是否 @ 了其他用户（非 bot 自身、非 @all）。
 * 用于在 @其他人 时跳过所有触发逻辑。
 *
 * NapCat 发送端可能 stripping @ 段，只保留纯文本昵称。
 * 此时通过检查消息是否以其他已知 bot 的昵称开头来补判。
 */
export function hasMentionOtherUser(
  event: OneBotEvent,
  selfId: number | string,
  otherBotNames?: string[],
): boolean {
  if (!Array.isArray(event.message)) {
    if (typeof event.message === "string") {
      const selfIdStr = String(selfId);
      const atRegex = /\[CQ:at,qq=(\d+)\]/g;
      let m;
      while ((m = atRegex.exec(event.message)) !== null) {
        if (m[1] !== "all" && m[1] !== selfIdStr) return true;
      }
    }
    return false;
  }
  for (const s of event.message) {
    if (s.type === "at") {
      const qq = s.data?.qq;
      if (qq !== "all" && String(qq) !== String(selfId)) {
        return true;
      }
    }
  }

  // NapCat stripping 补判：消息以其他 bot 昵称开头 → 视为隐式 @
  if (otherBotNames && otherBotNames.length > 0) {
    const text = typeof event.message === "string"
      ? event.message
      : event.message.filter(s => s.type === "text").map(s => s.data?.text || "").join("");
    const trimmed = text.trimStart();
    for (const name of otherBotNames) {
      if (!name || name === String(selfId)) continue;
      if (trimmed.startsWith(name)) {
        const after = trimmed.slice(name.length);
        if (after.length === 0 || /^[\s，。！？!?,."'、；;：:（(）)]/.test(after)) {
          return true;
        }
      }
    }
  }

  return false;
}

// ============ 关键词/名字触发 ============

/** 关键词正则缓存：避免每次调用重新编译 */
let keywordRegexCache: { key: string; regex: RegExp } | null = null;

function getKeywordRegex(keywords: string[]): RegExp {
  const key = JSON.stringify(keywords);
  if (keywordRegexCache?.key === key) return keywordRegexCache.regex;
  const escaped = keywords.map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(escaped.map((kw) => `(?:${kw})`).join("|"));
  keywordRegexCache = { key, regex };
  return regex;
}

/**
 * 检测文本是否包含任意触发关键词。
 */
export function detectKeywordTrigger(
  text: string,
  keywords: string[] | undefined,
): boolean {
  if (!keywords || keywords.length === 0) return false;
  // 空字符串直接跳过（避免 RegExp 匹配空串导致误判）
  if (text.length === 0) return false;
  const re = getKeywordRegex(keywords);
  return re.test(text);
}

/**
 * 检测消息中是否包含 bot 的名字（自我认知触发）。
 */
export function detectNameTrigger(
  text: string,
  botName: string | undefined,
  debug = false,
  log?: Logger,
): boolean {
  if (!botName || botName.trim().length === 0) return false;

  const cleanName = botName.trim();
  const textLower = text.toLowerCase();
  const nameLower = cleanName.toLowerCase();
  const matched = textLower.includes(nameLower);

  if (debug && matched) {
    (log ?? console).log(`[napcat-QQ][debug-name-trigger] MATCH botName="${cleanName}" in text="${text.slice(0, 50)}"`);
  }

  return matched;
}

// ============ 指向性门控 ============

/**
 * 判断消息是否指向本 bot（多 bot 路由门控）。
 *
 * 群聊/频道消息必须 @本 bot / 含本 bot 名字才放行；
 * 私聊天然通过。
 */
export function isMessageDirectedAtBot(
  event: OneBotEvent,
  selfId: number | string | undefined,
  text: string,
  selfName: string | undefined,
  otherBotNames: string[] = [],
): boolean {
  if (event.message_type !== "group" && event.message_type !== "guild") {
    return true;
  }

  const selfIdStr = selfId != null ? String(selfId) : null;

  let isMentionedSelf = false;
  let isMentionedOther = false;
  if (Array.isArray(event.message)) {
    for (const s of event.message) {
      if (s.type === "at") {
        const qq = s.data?.qq;
        if (qq === "all" || (selfIdStr != null && String(qq) === selfIdStr)) {
          isMentionedSelf = true;
        } else {
          isMentionedOther = true;
        }
      }
    }
  } else if (selfIdStr) {
    if (text.includes(`[CQ:at,qq=${selfIdStr}]`) || text.includes("[CQ:at,qq=all]")) {
      isMentionedSelf = true;
    } else if (/\[CQ:at,qq=\d+\]/.test(text)) {
      isMentionedOther = true;
    }
  }

  if (isMentionedSelf) return true;
  if (isMentionedOther) return false;

  if (selfName && detectNameTrigger(text, selfName, false)) return true;

  if (otherBotNames.length > 0) {
    for (const name of otherBotNames) {
      if (text.startsWith(name) && /[\s\p{P}]/u.test(text[name.length] ?? "")) {
        return false;
      }
    }
  }

  return true;
}

// ============ 其他 bot 名字构建 ============

/**
 * 根据配置中的 knownBotIds 构建其他 bot 的昵称列表和 ID 集合。
 */
export function buildOtherBotNames(
  accountId: string,
  knownBotIds: (number | string)[] | undefined,
  selfId: string,
): { names: string[]; idSet: Set<string> } {
  const names: string[] = [];
  const idSet = new Set<string>();
  if (knownBotIds?.length) {
    for (const botId of knownBotIds) {
      const idStr = String(botId);
      if (idStr === selfId) continue;
      idSet.add(idStr);
      const info = getBotInfo(accountId, idStr);
      const name = info?.card || info?.nickname;
      if (name) names.push(name);
    }
  }
  return { names, idSet };
}
