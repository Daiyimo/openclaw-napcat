/**
 * 已知 bot 持久化存储
 *
 * 用途：跨重启/跨进程保留通过签名检测发现的 bot QQ 号，
 * 避免冷启动第一个周期内漏识别导致循环对话浪费 token。
 *
 * 文件：~/.openclaw/napcat-qq/data/known-bots-<accountId>.json
 * 格式：{ "botIds": ["12345", "67890"] }
 * 写入：5s 节流 + 原子写（沿用 known-users.ts 的写盘模式）
 * 隔离：按 accountId 隔离文件，避免多账号/多实例写竞态
 */

import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "./utils/platform.js";

const SAVE_THROTTLE_MS = 5_000;
const MAX_BOT_IDS = 5_000;

const caches = new Map<string, Set<string>>();
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

function loadCache(accountId: string): Set<string> {
  const existing = caches.get(accountId);
  if (existing) return existing;

  const cache = new Set<string>();
  try {
    const file = getStoreFile(accountId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (Array.isArray(data?.botIds)) {
        for (const id of data.botIds) {
          if (typeof id === "string" || typeof id === "number") {
            cache.add(String(id));
          }
        }
      }
      console.log(`[known-bots-store] Loaded ${cache.size} bot IDs for account ${accountId}`);
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
    const payload = { botIds: [...cache] };
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

export function recordKnownBot(accountId: string, botId: string | number): void {
  const cache = loadCache(accountId);
  const idStr = String(botId);
  if (cache.has(idStr)) return;
  if (cache.size >= MAX_BOT_IDS) {
    console.warn(`[known-bots-store] Max size ${MAX_BOT_IDS} reached, dropping ${idStr}`);
    return;
  }
  cache.add(idStr);
  scheduleSave(accountId);
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

export function _getCacheForTest(accountId: string): Set<string> | undefined {
  return caches.get(accountId);
}
