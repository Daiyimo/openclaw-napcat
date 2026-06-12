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

let _log: Logger = console;

const memberCache = new Map<string, { name: string; time: number }>();
// 记录每个群的批量拉取时间，TTL 与单条缓存一致（1 小时）
const bulkCachedGroups = new Map<string, number>(); // groupId → 拉取时间戳
/** 正在加载中的群 ID → 等待者 Promise resolve 函数列表 */
const loadingGroups = new Map<string, Array<() => void>>();

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
  // 超出最大容量时清理最旧的 20% 条目
  if (memberCache.size >= MAX_CACHE_SIZE) {
    const entries = [...memberCache.entries()];
    entries.sort((a, b) => a[1].time - b[1].time);
    const toRemove = Math.floor(MAX_CACHE_SIZE * 0.2);
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
  if (cachedAt && Date.now() - cachedAt < MEMBER_CACHE_TTL_MS) return;

  // 已在加载中：用 Promise 等待完成通知，避免重复拉取
  if (loadingGroups.has(key)) {
    await new Promise<void>((resolve) => {
      const waiters = loadingGroups.get(key);
      if (waiters) {
        waiters.push(resolve);
      } else {
        resolve(); // 加载已结束
      }
    });
    return;
  }

  loadingGroups.set(key, []);
  try {
    const members = await client.getGroupMemberList(groupId);
    if (Array.isArray(members)) {
      for (const m of members) {
        const name = m.card || m.nickname || String(m.user_id);
        setCachedMemberName(key, String(m.user_id), name);
      }
      bulkCachedGroups.set(key, Date.now());
    }
  } catch (err) {
    (log ?? _log ?? console).error(`[member-cache] 批量拉取群 ${groupId} 成员失败，降级为按需查询: ${err}`);
  } finally {
    // 通知所有等待者
    const waiters = loadingGroups.get(key);
    loadingGroups.delete(key);
    if (waiters) {
      for (const resolve of waiters) resolve();
    }
  }
}

/**
 * 清除成员缓存（用于测试或手动刷新）
 */
export function clearMemberCache(): void {
  memberCache.clear();
  bulkCachedGroups.clear();
}
