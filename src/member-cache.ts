/**
 * 群成员名称缓存
 *
 * 缓存群成员昵称/名片，避免频繁查询 API。
 * 支持按群批量填充和单条查询。
 */

import type { OneBotClient } from "./client.js";

// ============ 状态 ============

const memberCache = new Map<string, { name: string; time: number }>();
const bulkCachedGroups = new Set<string>();
/** 正在加载中的群 ID，防止并发重复拉取 */
const loadingGroups = new Set<string>();

// ============ 公共 API ============

/**
 * 从缓存中获取群成员名称（1 小时内有效）
 */
export function getCachedMemberName(groupId: string, userId: string): string | null {
  const key = `${groupId}:${userId}`;
  const cached = memberCache.get(key);
  if (cached && Date.now() - cached.time < 3_600_000) {
    return cached.name;
  }
  return null;
}

/**
 * 写入群成员名称缓存
 */
export function setCachedMemberName(groupId: string, userId: string, name: string): void {
  memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

/**
 * 批量填充指定群的成员缓存（每群只填充一次）
 */
export async function populateGroupMemberCache(client: OneBotClient, groupId: number): Promise<void> {
  const key = String(groupId);
  if (bulkCachedGroups.has(key)) return;
  // 已在加载中，等待完成后直接返回，避免重复拉取
  if (loadingGroups.has(key)) {
    let waited = 0;
    while (loadingGroups.has(key) && waited < 250) {
      await new Promise((r) => setTimeout(r, 20));
      waited++;
    }
    return;
  }
  loadingGroups.add(key);
  try {
    const members = await client.getGroupMemberList(groupId);
    if (Array.isArray(members)) {
      for (const m of members) {
        const name = m.card || m.nickname || String(m.user_id);
        setCachedMemberName(key, String(m.user_id), name);
      }
      bulkCachedGroups.add(key);
    }
  } catch {
    // Fallback: individual queries will still work
  } finally {
    loadingGroups.delete(key);
  }
}

/**
 * 清除成员缓存（用于测试或手动刷新）
 */
export function clearMemberCache(): void {
  memberCache.clear();
  bulkCachedGroups.clear();
}
