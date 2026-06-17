/**
 * Bot 协议层识别（仅保留读侧）
 *
 * 发送侧握手在 v1.9.2 移除（OneBot json 段在 QQ 客户端渲染为可见卡片 spam）。
 * 现仅保留:
 *   - parseBotHandshake: 解析入站消息中的握手 json 段（防御性识别）
 *   - runHandshakeBackfill: 冷启动拉群历史扫描签名入 cache（只读不发）
 *
 * 友军识别依赖: sender.bot / knownBotIds / 持久化 known-bots cache / 文本签名。
 */

import type { OneBotMessage } from "../types.js";
import { BOT_SIGNATURE_PATTERN, BOT_SIGNATURE_ZW_PATTERN } from "../constants.js";
import { recordKnownBot, isKnownBot } from "../known-bots-store.js";
import { maskId } from "./log-sanitize.js";
import type { Logger } from "../types/channel-types.js";
import { getLog } from "../admin-commands/shared.js";

/** 握手元数据中 app 字段的固定值,用于跨实现识别 */
const HANDSHAKE_APP = "openclaw-napcat";
/** 握手元数据中 kind 字段的固定值 */
const HANDSHAKE_KIND = "bot";

/** 握手消息的 payload 形态(用于 parse 端) */
export interface BotHandshakePayload {
  app: string;
  kind: string;
  selfId: string;
  v: number;
  version: string;
  signedAt: number;
}

/**
 * 解析一段消息,提取握手元数据(若存在)。
 * 返回 null 表示不是握手消息。
 *
 * 兼容发送端/接收端两种 data.data 形态:字符串(JSON 序列化)或对象(已解析)。
 */
export function parseBotHandshake(message: OneBotMessage | undefined): BotHandshakePayload | null {
  if (!Array.isArray(message)) return null;
  for (const seg of message) {
    if (seg?.type !== "json") continue;
    const segData = seg.data as { data?: unknown };
    let inner: unknown = segData?.data;
    if (typeof inner === "string") {
      try { inner = JSON.parse(inner); } catch { continue; }
    }
    if (!inner || typeof inner !== "object") continue;
    const obj = inner as Record<string, unknown>;
    if (obj.app === HANDSHAKE_APP && obj.kind === HANDSHAKE_KIND) {
      const selfId = obj.selfId;
      if (typeof selfId === "string" || typeof selfId === "number") {
        return {
          app: HANDSHAKE_APP,
          kind: HANDSHAKE_KIND,
          selfId: String(selfId),
          v: typeof obj.v === "number" ? obj.v : 1,
          version: typeof obj.version === "string" ? obj.version : "unknown",
          signedAt: typeof obj.signedAt === "number" ? obj.signedAt : 0,
        };
      }
    }
  }
  return null;
}

// ============ 冷启动历史回填 ============

/** 回填时拉取的每群历史消息条数 */
const BACKFILL_HISTORY_COUNT = 30;

/**
 * 一次扫描一段历史消息,从中提取可能的 bot 标识。
 * 同时支持协议层握手(json 段)和文本签名([BOT:xxx] / 零宽)。
 */
function extractBotIdsFromHistoryMessage(
  rawMessage: string | undefined,
  message: OneBotMessage | undefined,
): string[] {
  const ids: string[] = [];
  if (Array.isArray(message)) {
    const hs = parseBotHandshake(message);
    if (hs) ids.push(hs.selfId);
  }
  if (rawMessage) {
    const m = BOT_SIGNATURE_PATTERN.exec(rawMessage);
    if (m?.[1]) ids.push(m[1]);
    const zm = BOT_SIGNATURE_ZW_PATTERN.exec(rawMessage);
    if (zm?.[1] && !ids.includes(zm[1])) ids.push(zm[1]);
  }
  return ids;
}

interface BackfillClient {
  getGroupList(): Promise<Array<{ group_id: number }>>;
  getGroupMsgHistory(
    groupId: number,
    count?: number,
  ): Promise<{
    messages?: Array<{
      raw_message?: string;
      message?: OneBotMessage;
      sender?: { user_id?: number | string };
    }>;
  }>;
}

/**
 * 冷启动握手回填(只读):对每个已加入群拉取最近 BACKFILL_HISTORY_COUNT 条消息,
 * 扫描并记录其中出现的所有 bot 标识(握手 + 文本签名)。
 *
 * @returns 新发现的 bot 数量
 */
export async function runHandshakeBackfill(
  client: BackfillClient,
  accountId: string,
  log?: Logger,
): Promise<number> {
  const groups = await client.getGroupList();
  // 并发拉取所有群历史（Promise.allSettled 避免单群失败影响其余）
  const results = await Promise.allSettled(
    groups.map((g) =>
      client.getGroupMsgHistory(g.group_id, BACKFILL_HISTORY_COUNT).then((history) => ({ group: g, history })),
    ),
  );
  let discovered = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { group, history } = result.value;
    const messages = history?.messages ?? [];
    for (const m of messages) {
      const ids = extractBotIdsFromHistoryMessage(m.raw_message, m.message);
      for (const id of ids) {
        if (!isKnownBot(accountId, id)) {
          recordKnownBot(accountId, id);
          discovered += 1;
          getLog(log).log(
            `[napcat-QQ][backfill] discovered bot ${maskId(id)} in group ${group.group_id} (msg from user ${m.sender?.user_id})`,
          );
        }
      }
    }
  }
  return discovered;
}
