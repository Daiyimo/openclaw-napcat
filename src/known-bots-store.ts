/**
 * 已知 bot 持久化存储
 *
 * 用途：跨重启/跨进程保留通过签名检测发现的 bot QQ 号 + 昵称，
 * 避免冷启动第一个周期内漏识别导致循环对话浪费 token。
 *
 * 文件：~/.openclaw/napcat-qq/data/known-bots-<accountId>.json
 * 格式：{ "bots": [{ selfId, nickname?, card?, firstSeenAt, lastSeenAt }] }
 * 写入：5s 节流 + 原子写（沿用 known-users.ts 的写盘模式）
 * 隔离：按 accountId 隔离文件，避免多账号/多实例写竞态
 */

import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "./utils/platform.js";
import type { OneBotClient } from "./client.js";

const SAVE_THROTTLE_MS = 5_000;
const MAX_BOT_IDS = 5_000;

export interface BotInfo {
  selfId: string;
  nickname?: string;
  card?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

const caches = new Map<string, Map<string, BotInfo>>();
const dirty = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

function getStoreFile(accountId: string): string {
  const dir = getQQBotDataDir("data");
  return path.join(dir, `known-bots-${accountId}.json`);
}

function ensureDir(): void {
  const dir = getQQBotDataDir("data");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadCache(accountId: string): Map<string, BotInfo> {
  const existing = caches.get(accountId);
  if (existing) return existing;

  const cache = new Map<string, BotInfo>();
  try {
    const file = getStoreFile(accountId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      // 兼容旧格式 { botIds: ["12345"] } 和新格式 { bots: [{ selfId, ... }] }
      if (Array.isArray(data?.bots)) {
        const now = Date.now();
        for (const item of data.bots) {
          if (item && (typeof item.selfId === "string" || typeof item.selfId === "number")) {
            cache.set(String(item.selfId), {
              selfId: String(item.selfId),
              nickname: typeof item.nickname === "string" ? item.nickname : undefined,
              card: typeof item.card === "string" ? item.card : undefined,
              firstSeenAt: typeof item.firstSeenAt === "number" ? item.firstSeenAt : now,
              lastSeenAt: typeof item.lastSeenAt === "number" ? item.lastSeenAt : now,
            });
          }
        }
      } else if (Array.isArray(data?.botIds)) {
        // 旧格式升级
        const now = Date.now();
        for (const id of data.botIds) {
          if (typeof id === "string" || typeof id === "number") {
            cache.set(String(id), {
              selfId: String(id),
              firstSeenAt: now,
              lastSeenAt: now,
            });
          }
        }
      }
      console.log(`[known-bots-store] Loaded ${cache.size} bot info entries for account ${accountId}`);
    }
  } catch (err) {
    console.error(`[known-bots-store] Failed to load for ${accountId}: ${err}`);
  }
  caches.set(accountId, cache);
  return cache;
}

function scheduleSave(accountId: string): void {
  dirty.add(accountId);
  if (timers.has(accountId)) return;
  const timer = setTimeout(() => {
    timers.delete(accountId);
    doSave(accountId);
  }, SAVE_THROTTLE_MS);
  timers.set(accountId, timer);
}

function doSave(accountId: string): void {
  const cache = caches.get(accountId);
  if (!cache || !dirty.has(accountId)) return;
  try {
    ensureDir();
    const filePath = getStoreFile(accountId);
    const tmpPath = filePath + ".tmp";
    const payload = { bots: [...cache.values()] };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
    dirty.delete(accountId);
  } catch (err) {
    console.error(`[known-bots-store] Failed to save for ${accountId}: ${err}`);
  }
}

export function initKnownBotsStore(accountId: string): void {
  loadCache(accountId);
}

export function isKnownBot(accountId: string, userId: string | number): boolean {
  return loadCache(accountId).has(String(userId));
}

export function getBotInfo(accountId: string, botId: string | number): BotInfo | undefined {
  return loadCache(accountId).get(String(botId));
}

/**
 * 添加/更新 bot 信息。
 * - 已存在：更新 lastSeenAt + nickname/card（如果提供）
 * - 不存在：新建
 */
export function recordBotInfo(accountId: string, info: Partial<Omit<BotInfo, "selfId">> & { selfId: string | number }): BotInfo {
  const cache = loadCache(accountId);
  const idStr = String(info.selfId);
  const now = Date.now();
  const existing = cache.get(idStr);
  if (existing) {
    if (info.nickname !== undefined) existing.nickname = info.nickname;
    if (info.card !== undefined) existing.card = info.card;
    existing.lastSeenAt = now;
    scheduleSave(accountId);
    return existing;
  }
  if (cache.size >= MAX_BOT_IDS) {
    console.warn(`[known-bots-store] Max size ${MAX_BOT_IDS} reached, dropping ${idStr}`);
    // 返回一个不存于 cache 的临时对象（不持久化）
    const { selfId: _drop, ...rest } = info;
    return { selfId: idStr, firstSeenAt: now, lastSeenAt: now, ...rest };
  }
  const bot: BotInfo = {
    selfId: idStr,
    nickname: info.nickname,
    card: info.card,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  cache.set(idStr, bot);
  scheduleSave(accountId);
  return bot;
}

/**
 * 兼容旧 API：只记录 selfId（不附带昵称）。
 */
export function recordKnownBot(accountId: string, botId: string | number): void {
  recordBotInfo(accountId, { selfId: botId });
}

export function listKnownBots(accountId: string): BotInfo[] {
  return [...loadCache(accountId).values()];
}

export function flushKnownBotsStore(): void {
  for (const accountId of caches.keys()) {
    const timer = timers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(accountId);
    }
    doSave(accountId);
  }
}

export function resetKnownBotsStore(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  caches.clear();
  dirty.clear();
}

export function _getCacheForTest(accountId: string): Map<string, BotInfo> | undefined {
  return caches.get(accountId);
}

const BOT_INFO_FETCH_TIMEOUT_MS = 5_000;

export async function fetchBotInfoAsync(
  client: OneBotClient,
  accountId: string,
  botId: string,
  groupId: number | undefined,
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void; error?: (msg: string) => void },
): Promise<void> {
  try {
    let info: any = null;
    if (groupId !== undefined) {
      try {
        info = await Promise.race([
          client.getGroupMemberInfo(groupId, botId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), BOT_INFO_FETCH_TIMEOUT_MS),
          ),
        ]);
      } catch {
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
