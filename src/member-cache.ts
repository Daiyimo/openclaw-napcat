/**
 * 群成员名称缓存
 *
 * 缓存群成员昵称/名片，避免频繁查询 API。
 * 支持按群批量填充和单条查询。
 */

import type { OneBotClient } from "./client.js";
import type { Logger } from "./types/channel-types.js";

// ============ 状态 ============

/** 单条缓存 TTL（1 小时） */
const MEMBER_CACHE_TTL_MS = 3_600_000;
/** 缓存最大条目数（防止 OOM） */
const MAX_CACHE_SIZE = 100_000;
/** 摊销淘汰：每插入 N 条才触发一次清理 */
const EVICTION_INTERVAL = 500;
/** 每次淘汰删除的比例 */
const EVICTION_FRACTION = 0.2;

let evictionCounter = 0;

let _log: Logger = console;

const memberCache = new Map<string, { name: string; time: number }>();
// 记录每个群的批量拉取时间，TTL 与单条缓存一致（1 小时）
const bulkCachedGroups = new Map<string, number>(); // groupId → 拉取时间戳
/** 正在加载中的群 ID → 等待者 Promise resolve/reject 函数列表 */
type Waiter = { resolve: () => void; reject: (err: Error) => void };
const loadingGroups = new Map<string, Waiter[]>();
/** 失败重试时间戳（groupKey → 最早可重试的毫秒时间戳） */
const failedUntil = new Map<string, number>();
/** 每个群的重试次数（用于指数退避） */
const failCount = new Map<string, number>();
/** 重试退避基数（ms），每次失败翻倍，上限 5 分钟 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 300_000;

// 定期 TTL 兜底扫描（每 15 分钟），清理过期条目防止长期累积
const TTL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
let ttlSweepTimer: ReturnType<typeof setInterval> | null = null;

// 模块加载时自动启动 TTL 扫描（不影响进程退出）
let ttlSweepStarted = false;

function ensureTtlSweep(): void {
  if (ttlSweepStarted) return;
  ttlSweepStarted = true;
  ttlSweepTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of memberCache) {
      if (now - entry.time > MEMBER_CACHE_TTL_MS) {
        memberCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) (_log ?? console).log(`[member-cache] TTL sweep: removed ${cleaned} expired entries`);
  }, TTL_SWEEP_INTERVAL_MS);
  ttlSweepTimer.unref();
}

/** 启动 TTL 兜底扫描定时器（不影响进程退出） */
export function startTtlSweep(): void {
  ensureTtlSweep();
}

/** 停止 TTL 兜底扫描 */
export function stopTtlSweep(): void {
  if (ttlSweepTimer) {
    clearInterval(ttlSweepTimer);
    ttlSweepTimer = null;
    ttlSweepStarted = false;
  }
}

// ============ 公共 API ============

/**
 * 从缓存中获取群成员名称（1 小时内有效）
 */
export function getCachedMemberName(groupId: string, userId: string): string | null {
  const key = `${groupId}:${userId}`;
  const cached = memberCache.get(key);
  if (cached && Date.now() - cached.time < MEMBER_CACHE_TTL_MS) {
    return cached.name;
  }
  if (cached) memberCache.delete(key); // 懒清理过期条目
  return null;
}

/**
 * 写入群成员名称缓存
 */
export function setCachedMemberName(groupId: string, userId: string, name: string): void {
  // 摊销淘汰：每 EVICTION_INTERVAL 次插入才排序清理一次
  // 避免每次 @mention 都触发 O(n log n)
  evictionCounter++;
  if (memberCache.size >= MAX_CACHE_SIZE && evictionCounter >= EVICTION_INTERVAL) {
    evictionCounter = 0;
    const entries = [...memberCache.entries()];
    entries.sort((a, b) => a[1].time - b[1].time);
    const toRemove = Math.floor(MAX_CACHE_SIZE * EVICTION_FRACTION);
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      memberCache.delete(entries[i][0]);
    }
  }
  memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

/**
 * 批量填充指定群的成员缓存（每群只填充一次）
 * 使用 Promise 通知模式替代 spin-wait，减少 CPU 浪费。
 */
export async function populateGroupMemberCache(client: OneBotClient, groupId: number, log?: Logger): Promise<void> {
  const key = String(groupId);
  const cachedAt = bulkCachedGroups.get(key);
  if (cachedAt !== undefined && cachedAt >= 0 && Date.now() - cachedAt < MEMBER_CACHE_TTL_MS) return;

  // 失败退避期：不发起请求，等待者延迟 resolve
  const retryAfter = failedUntil.get(key);
  if (retryAfter && Date.now() < retryAfter) {
    // 在退避期内：等待（调用方可通过 Promise.race 自行超时）
    await new Promise((resolve) => setTimeout(resolve, retryAfter - Date.now()));
    return;
  }
  // 退避期已过：清除标记，允许重试
  if (retryAfter) failedUntil.delete(key);

  // 已在加载中：用 Promise 等待完成通知，避免重复拉取
  if (loadingGroups.has(key)) {
    await new Promise<void>((resolve, reject) => {
      const waiters = loadingGroups.get(key);
      if (waiters) {
        waiters.push({ resolve, reject });
      } else {
        resolve(); // 加载已结束
      }
    });
    return;
  }

  loadingGroups.set(key, []);
  let hadError = false;
  try {
    const members = await client.getGroupMemberList(groupId);
    if (Array.isArray(members)) {
      for (const m of members) {
        const name = m.card || m.nickname || String(m.user_id);
        setCachedMemberName(key, String(m.user_id), name);
      }
      bulkCachedGroups.set(key, Date.now());
      failCount.delete(key); // 成功则重置重试计数
      failedUntil.delete(key);
    }
  } catch (err) {
    hadError = true;
    (log ?? _log ?? console).error(`[member-cache] 批量拉取群 ${groupId} 成员失败，降级为按需查询: ${err instanceof Error ? err.message : String(err)}`);
    // 指数退避：防止并发请求在失败后同时重试（惊群防护）
    const count = (failCount.get(key) ?? 0) + 1;
    failCount.set(key, count);
    const retryMs = Math.min(RETRY_BASE_MS * Math.pow(2, count - 1), RETRY_MAX_MS);
    failedUntil.set(key, Date.now() + retryMs);
    bulkCachedGroups.delete(key);
  } finally {
    // 通知所有等待者：成功 resolve，失败 reject，避免惊群
    const waiters = loadingGroups.get(key);
    loadingGroups.delete(key);
    if (waiters && waiters.length > 0) {
      const success = bulkCachedGroups.has(key);
      for (const waiter of waiters) {
        if (success) {
          waiter.resolve();
        } else {
          waiter.reject(new Error(`member cache load failed for group ${key}`));
        }
      }
    }
  }
  if (hadError) throw new Error(`member cache load failed for group ${key}`);
}

/**
 * 清除成员缓存（用于测试或手动刷新）
 */
export function clearMemberCache(): void {
  memberCache.clear();
  bulkCachedGroups.clear();
  failedUntil.clear();
  failCount.clear();
}
