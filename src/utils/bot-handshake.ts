/**
 * Bot 协议层握手（Plan A 协议扩展）
 *
 * 在 OneBot v11 上,在不污染用户文本的前提下,声明 bot 身份。
 * 发送端:构造一段以 `json` 段承载的元数据消息,内容为
 *   { app: "openclaw-napcat", kind: "bot", selfId, version, signedAt }
 * 接收端:解析这种 json 段,提取 selfId 并写入 known-bots-store。
 *
 * 优点:用户文本 100% 干净、协议层稳定、不会"被平台剥"。
 * 兜底:仍保留 [BOT:xxx] 文本签名作为旧版 bot 兼容(visible / zero-width)。
 *
 * 节流:每个群握手一次后,24h 内不重复发送(避免重启/重连风暴)。
 */

import type { OneBotMessage } from "../types.js";
import { BOT_HANDSHAKE_APP, BOT_HANDSHAKE_KIND, BOT_HANDSHAKE_MIN_LENGTH, BOT_SIGNATURE_PATTERN, BOT_SIGNATURE_ZW_PATTERN } from "../constants.js";
import { getPackageVersion } from "./pkg-version.js";
import { recordKnownBot } from "../known-bots-store.js";
import { isKnownBot } from "../known-bots-store.js";
import { maskId } from "./log-sanitize.js";

/** 握手元数据 payload 类型 */
export interface BotHandshakePayload {
  /** 固定为 "openclaw-napcat",用于跨实现识别 */
  app: typeof BOT_HANDSHAKE_APP;
  /** 固定为 "bot",用于和未来其他 kind 区分 */
  kind: typeof BOT_HANDSHAKE_KIND;
  /** bot 的 QQ 号(字符串,避免精度丢失) */
  selfId: string;
  /** 协议版本(目前固定 1) */
  v: 1;
  /** 插件版本(从 package.json 读取) */
  version: string;
  /** Unix ms 时间戳,用于节流和审计 */
  signedAt: number;
}

/**
 * 构造 bot 握手消息的 OneBot 段数组。
 * 仅包含一个 `json` 段,无任何 text 段,内容是元数据。
 * OneBot 11 规定 `json` 段的 `data.data` 必须是 JSON 字符串。
 */
export function makeBotHandshakeMessage(selfId: string | number): OneBotMessage {
  const payload: BotHandshakePayload = {
    app: BOT_HANDSHAKE_APP,
    kind: BOT_HANDSHAKE_KIND,
    selfId: String(selfId),
    v: 1,
    version: getPackageVersion(),
    signedAt: Date.now(),
  };
  return [{ type: "json", data: { data: JSON.stringify(payload) } }];
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
    // 字符串形态:JSON.parse;对象形态:直接用
    if (typeof inner === "string") {
      try { inner = JSON.parse(inner); } catch { continue; }
    }
    if (!inner || typeof inner !== "object") continue;
    const obj = inner as Record<string, unknown>;
    if (obj.app === BOT_HANDSHAKE_APP && obj.kind === BOT_HANDSHAKE_KIND) {
      const selfId = obj.selfId;
      if (typeof selfId === "string" || typeof selfId === "number") {
        return {
          app: BOT_HANDSHAKE_APP,
          kind: BOT_HANDSHAKE_KIND,
          selfId: String(selfId),
          v: 1,
          version: typeof obj.version === "string" ? obj.version : "unknown",
          signedAt: typeof obj.signedAt === "number" ? obj.signedAt : 0,
        };
      }
    }
  }
  return null;
}

/**
 * 群级握手节流状态:24h 内不重复发送。
 * 模块级 Map,按 (accountId, groupId) 隔离。
 */
const lastHandshakeAt = new Map<string, number>();
const HANDSHAKE_THROTTLE_MS = 24 * 60 * 60 * 1_000;

function makeThrottleKey(accountId: string, groupId: string | number): string {
  return `${accountId}:${groupId}`;
}

/** 判断指定群是否在节流窗口内(返回 true=需要发送) */
export function shouldSendHandshake(accountId: string, groupId: string | number): boolean {
  const key = makeThrottleKey(accountId, groupId);
  const last = lastHandshakeAt.get(key);
  if (last === undefined) return true;
  return Date.now() - last >= HANDSHAKE_THROTTLE_MS;
}

/** 记录已发送握手(用于 shouldSendHandshake 判断) */
export function markHandshakeSent(accountId: string, groupId: string | number): void {
  lastHandshakeAt.set(makeThrottleKey(accountId, groupId), Date.now());
}

/**
 * 清除指定群的握手节流(强制下一次发送时重发)。
 *
 * 使用场景:`group_increase` notice 事件 — 有新成员入群时,清掉该群节流,
 * 本 bot 下次在该群发任何消息时,会先发一次握手(向新成员自我介绍)。
 *
 * 注意:此函数不清除 known-bots-cache(那是发现表,不是节流表)。
 */
export function clearHandshakeThrottle(accountId: string, groupId: string | number): void {
  lastHandshakeAt.delete(makeThrottleKey(accountId, groupId));
}

/** 测试用:重置节流状态 */
export function _resetHandshakeThrottle(): void {
  lastHandshakeAt.clear();
}

// ============ 冷启动历史回填 ============

/** 回填时拉取的每群历史消息条数。30 条足够覆盖 24h 节流窗口内的握手 */
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
  // 协议层握手
  if (Array.isArray(message) && (rawMessage?.length ?? 0) >= BOT_HANDSHAKE_MIN_LENGTH) {
    const hs = parseBotHandshake(message);
    if (hs) ids.push(hs.selfId);
  }
  // 文本签名(visible)
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
 * 冷启动握手回填：对每个已加入群拉取最近 BACKFILL_HISTORY_COUNT 条消息,
 * 扫描并记录其中出现的所有 bot 标识(握手/签名)。
 *
 * 解决时序问题:对方 bot 在本 bot 启动前发过握手,本 bot 通过历史记录也能发现对方。
 *
 * @returns 新发现的 bot 数量
 */
export async function runHandshakeBackfill(
  client: BackfillClient,
  accountId: string,
): Promise<number> {
  const groups = await client.getGroupList();
  let discovered = 0;
  for (const g of groups) {
    try {
      const history = await client.getGroupMsgHistory(g.group_id, BACKFILL_HISTORY_COUNT);
      const messages = history?.messages ?? [];
      for (const m of messages) {
        const ids = extractBotIdsFromHistoryMessage(m.raw_message, m.message);
        for (const id of ids) {
          if (!isKnownBot(accountId, id)) {
            recordKnownBot(accountId, id);
            discovered += 1;
            console.log(
              `[napcat-QQ][backfill] discovered bot ${maskId(id)} in group ${g.group_id} (msg from user ${m.sender?.user_id})`,
            );
          }
        }
      }
    } catch (err) {
      // 单群失败不阻塞其他群
      console.warn(`[napcat-QQ][backfill] group ${g.group_id} history fetch failed: ${err}`);
    }
  }
  return discovered;
}
