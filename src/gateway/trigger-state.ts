/**
 * 共享触发状态模块
 *
 * 存放 trigger.ts 和 admin-commands.ts 共同依赖的轻量状态，
 * 打破两者之间的循环导入。
 *
 * 目前包含：otherBotNames 缓存失效。
 */

// ── otherBotNames 缓存 ──────────────────────────────────────

/** 缓存条目 */
interface CacheEntry {
  names: string[];
  idSet: Set<string>;
  lastAccess: number;
}

/** 缓存最大条目数 */
const OTHER_BOT_NAMES_CACHE_MAX = 500;
const otherBotNamesCache = new Map<string, CacheEntry>();

/** LRU 淘汰：保留最近访问的 count 个条目 */
function evictLru(map: Map<string, CacheEntry>, count: number): void {
  if (map.size <= count) return;
  const entries = [...map.entries()];
  entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (let i = 0; i < entries.length - count; i++) {
    map.delete(entries[i][0]);
  }
}

export function getCachedOtherBotNames(cacheKey: string): { names: string[]; idSet: Set<string> } | null {
  const entry = otherBotNamesCache.get(cacheKey);
  if (!entry) return null;
  entry.lastAccess = Date.now();
  return { names: entry.names, idSet: entry.idSet };
}

export function setCachedOtherBotNames(cacheKey: string, names: string[], idSet: Set<string>): void {
  otherBotNamesCache.set(cacheKey, { names, idSet, lastAccess: Date.now() });
  if (otherBotNamesCache.size > OTHER_BOT_NAMES_CACHE_MAX) {
    evictLru(otherBotNamesCache, Math.floor(OTHER_BOT_NAMES_CACHE_MAX / 2));
  }
}

export function invalidateOtherBotNamesCache(): void {
  otherBotNamesCache.clear();
}
