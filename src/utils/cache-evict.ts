/**
 * 共享缓存工具函数
 *
 * 提供通用的缓存淘汰（LRU）和清理逻辑，
 * 供 inbound.ts（群历史缓存）、lifecycle.ts（去重集合）等模块复用。
 */
import { DEDUP_MAX_SIZE, DEDUP_KEEP_SIZE } from "../constants.js";

/**
 * LRU 淘汰：从 Map 中移除最久未访问的条目，保留 count 个。
 * 适用于 V extends { lastAccess: number } 的条目。
 *
 * @param map   - 要淘汰的 Map
 * @param count - 保留的条目数
 */
export function evictLru<K, V extends { lastAccess: number }>(map: Map<K, V>, count: number): void {
  if (map.size <= count) return;
  const entries = [...map.entries()];
  entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (let i = 0; i < entries.length - count; i++) {
    map.delete(entries[i][0]);
  }
}

/**
 * 按时间戳淘汰：从 Map 中移除最旧的条目，保留 count 个。
 * 适用于 Map<K, { timestamp: number }>。
 *
 * @param map   - 要淘汰的 Map
 * @param count - 保留的条目数
 */
export function evictOldest<K>(map: Map<K, { timestamp: number }>, count: number): void {
  if (map.size <= count) return;
  const entries = [...map.entries()];
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  for (let i = 0; i < entries.length - count; i++) {
    map.delete(entries[i][0]);
  }
}

/**
 * 修剪 Set：超过 maxSize 时清空并保留最后 keepSize 个条目。
 * 适用于去重集合等需要保留最新条目的场景。
 *
 * @param set      - 要修剪的 Set
 * @param maxSize  - 最大容量，超过才修剪
 * @param keepSize - 修剪后保留的数量
 * @returns        是否实际发生了修剪
 */
export function trimSet<T>(set: Set<T>, maxSize: number, keepSize: number): boolean {
  if (set.size <= maxSize) return false;
  const entries = [...set];
  set.clear();
  for (const id of entries.slice(-keepSize)) set.add(id);
  return true;
}

/**
 * 修剪去重集合：超过 maxSize 时修剪到 keepSize，保留最新的 N 条。
 * 返回是否实际发生了修剪。默认使用 DEDUP 常量。
 *
 * @param set      - 要修剪的 Set
 * @param maxSize  - 最大容量，超过才修剪（默认 DEDUP_MAX_SIZE）
 * @param keepSize - 修剪后保留的数量（默认 DEDUP_KEEP_SIZE）
 * @returns        是否实际发生了修剪
 */
export function trimDedupSet(
  set: Set<string>,
  maxSize: number = DEDUP_MAX_SIZE,
  keepSize: number = DEDUP_KEEP_SIZE,
): boolean {
  return trimSet(set, maxSize, keepSize);
}
