/**
 * 群号 TTL 缓存工具
 *
 * 为 knownGroupIds（纯 Set）提供时间戳追踪，确保过期群号重新经 API 确认。
 * 避免解散的群号长期留在缓存中被误匹配为群聊。
 *
 * 来源：P1 #6 — knownGroupIds 无 TTL。
 */

import { KNOWN_GROUP_TTL_MS } from "../constants.js";

// ============ 内部状态 ============

/** 群号 → 最后确认时间戳（ms） */
const _timestamps: Map<string, number> = new Map();

// ============ 公开 API ============

/**
 * 判断群号缓存是否仍有效。
 * 无时间戳的 entry 视为已过期（可能是其他模块静默写入的旧数据）。
 */
export function isGroupCacheValid(groupId: string): boolean {
  const ts = _timestamps.get(groupId);
  if (ts === undefined) return false;
  return Date.now() - ts < KNOWN_GROUP_TTL_MS;
}

/**
 * 刷新群号时间戳，并惰性清理已过期条目。
 */
export function refreshGroupCache(groupId: string): void {
  _timestamps.set(groupId, Date.now());
  const now = Date.now();
  for (const [id, ts] of _timestamps) {
    if (now - ts >= KNOWN_GROUP_TTL_MS) {
      _timestamps.delete(id);
    }
  }
}

/**
 * 从时间戳追踪中移除群号。
 */
export function evictGroupTimestamp(groupId: string): void {
  _timestamps.delete(groupId);
}
