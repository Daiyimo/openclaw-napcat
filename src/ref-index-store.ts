/**
 * 引用消息持久索引
 *
 * 存储路径：~/.openclaw/napcat-qq/data/ref-index.jsonl
 * 每条记录：{ msgId, text, sender, timestamp, accountId }
 * TTL 7 天，文件 > 2x 活跃条数时触发 compact
 */

import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "./utils/platform.js";
import type { Logger } from "./types/channel-types.js";

// ============ 类型 ============

export interface RefEntry {
  /** OneBot message_id */
  msgId: string;
  /** 消息文本内容 */
  text: string;
  /** 发送者名称 */
  sender: string;
  /** 发送者 ID */
  senderId?: string;
  /** 消息时间戳 (ms) */
  timestamp: number;
  /** 账号 ID */
  accountId?: string;
}

// ============ 配置 ============

let _storageDir: string | null = null;
let _refIndexFile: string | null = null;
let _log: Logger = console;

function getStorageDir(): string {
  if (!_storageDir) _storageDir = getQQBotDataDir("data");
  return _storageDir;
}

function getRefIndexFile(): string {
  if (!_refIndexFile) _refIndexFile = path.join(getStorageDir(), "ref-index.jsonl");
  return _refIndexFile;
}
const MAX_ENTRIES = 50_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const COMPACT_THRESHOLD_RATIO = 2;

// ============ JSONL 行格式 ============

interface RefIndexLine {
  k: string;
  v: RefEntry;
  t: number;
}

// ============ 内存缓存 ============

let cache: Map<string, RefEntry & { _createdAt: number }> | null = null;
let totalLinesOnDisk = 0;
/** 防止并发加载（Node.js 单线程下主要是异步重入保护）*/
let cacheReady = false;

function loadFromFile(): Map<string, RefEntry & { _createdAt: number }> {
  // 已初始化（含加载失败后的空 Map），直接返回
  if (cacheReady && cache !== null) return cache;

  cache = new Map();
  totalLinesOnDisk = 0;

  try {
    if (!fs.existsSync(getRefIndexFile())) {
      cacheReady = true;
      return cache;
    }

    const raw = fs.readFileSync(getRefIndexFile(), "utf-8");
    const lines = raw.split("\n");
    const now = Date.now();
    let expired = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      totalLinesOnDisk++;
      try {
        const entry = JSON.parse(trimmed) as RefIndexLine;
        if (!entry.k || !entry.v || !entry.t) continue;
        if (now - entry.t > TTL_MS) { expired++; continue; }
        cache.set(entry.k, { ...entry.v, _createdAt: entry.t });
      } catch {
        // skip corrupted lines
      }
    }

    (_log ?? console).log(
      `[ref-index-store] Loaded ${cache.size} entries from ${totalLinesOnDisk} lines (${expired} expired)`,
    );

    scheduleCompactIfNeeded();
  } catch (err) {
    (_log ?? console).error(`[ref-index-store] Failed to load: ${err}`);
    cache = new Map();
  }

  cacheReady = true;
  return cache;
}

// ============ 写队列（异步批量写）============

let writeQueue: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
/** writeQueue 最大容量，超过时丢弃最旧条目防止 OOM */
const MAX_WRITE_QUEUE_SIZE = 10_000;

/**
 * 将 JSONL 行加入写队列，100ms 后批量写入文件。
 * 热路径调用：不阻塞事件循环。
 */
function queueLine(line: RefIndexLine): void {
  writeQueue.push(JSON.stringify(line));
  totalLinesOnDisk++; // 乐观更新，与实际 I/O 解耦
  // 防止磁盘故障时队列无限增长导致 OOM
  if (writeQueue.length > MAX_WRITE_QUEUE_SIZE) {
    const dropped = writeQueue.length - MAX_WRITE_QUEUE_SIZE;
    writeQueue = writeQueue.slice(dropped);
    (_log ?? console).warn(`[ref-index-store] Write queue overflow, dropped ${dropped} oldest entries`);
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flushWriteQueue, 100);
  }
}

async function flushWriteQueue(): Promise<void> {
  flushTimer = null;
  if (writeQueue.length === 0) return;
  const batch = writeQueue.splice(0);
  try {
    ensureDir();
    await fs.promises.appendFile(
      getRefIndexFile(),
      batch.join("\n") + "\n",
      "utf-8",
    );
  } catch (err) {
    (_log ?? console).error(`[ref-index-store] Failed to flush write queue: ${err}`);
    // 写入失败时放回，但受 MAX_WRITE_QUEUE_SIZE 限制不会无限增长
    writeQueue.unshift(...batch);
    if (writeQueue.length > MAX_WRITE_QUEUE_SIZE) {
      writeQueue = writeQueue.slice(writeQueue.length - MAX_WRITE_QUEUE_SIZE);
    }
  }
}

function ensureDir(): void {
  if (!fs.existsSync(getStorageDir())) {
    fs.mkdirSync(getStorageDir(), { recursive: true });
  }
}

// ============ Compact ============

function shouldCompact(): boolean {
  if (!cache) return false;
  return totalLinesOnDisk > cache.size * COMPACT_THRESHOLD_RATIO && totalLinesOnDisk > 1000;
}

let isCompacting = false;

function scheduleCompactIfNeeded(): void {
  if (!shouldCompact() || isCompacting) return;
  isCompacting = true;
  setImmediate(() => {
    compactFile().finally(() => {
      isCompacting = false;
    });
  });
}

async function compactFile(): Promise<void> {
  if (!cache) return;
  // 先 flush 写队列，避免 compact rename 覆盖刚 append 的数据
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushWriteQueue();

  const before = totalLinesOnDisk;
  try {
    ensureDir();
    const tmpPath = getRefIndexFile() + ".tmp";
    const lines: string[] = [];
    for (const [key, entry] of cache) {
      const line: RefIndexLine = {
        k: key,
        v: {
          msgId: entry.msgId,
          text: entry.text,
          sender: entry.sender,
          senderId: entry.senderId,
          timestamp: entry.timestamp,
          accountId: entry.accountId,
        },
        t: entry._createdAt,
      };
      lines.push(JSON.stringify(line));
    }
    await fs.promises.writeFile(tmpPath, lines.join("\n") + "\n", "utf-8");

    // 冻结：rename 前暂停 flush timer，防止在 rename 与 flush 之间产生竞态丢失
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    await fs.promises.rename(tmpPath, getRefIndexFile());
    totalLinesOnDisk = cache.size;
    (_log ?? console).log(`[ref-index-store] Compacted: ${before} lines → ${totalLinesOnDisk} lines`);

    // rename 后立即 flush 可能在 compact 期间积累的写队列（追加到新文件）
    if (writeQueue.length > 0) {
      await flushWriteQueue();
    }
  } catch (err) {
    (_log ?? console).error(`[ref-index-store] Compact failed: ${err}`);
  }
}

// ============ 溢出淘汰 ============

/** 上次淘汰时间，防止高频调用 */
let lastEvictTime = 0;
/** 淘汰最小间隔（ms） */
const EVICT_COOLDOWN_MS = 5_000;

function evictIfNeeded(): void {
  if (!cache || cache.size < MAX_ENTRIES) return;
  const now = Date.now();
  // 防止高频场景每条消息都触发排序
  if (now - lastEvictTime < EVICT_COOLDOWN_MS) return;
  lastEvictTime = now;

  // 先做 TTL 清理（O(n)，大多数场景足够）
  for (const [key, entry] of cache) {
    if (now - entry._createdAt > TTL_MS) cache.delete(key);
  }
  // TTL 清理后仍满：排序淘汰一批（摊薄 O(n log n) 成本）
  if (cache.size >= MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1]._createdAt - b[1]._createdAt);
    const toRemove = sorted.slice(0, Math.max(1000, cache.size - MAX_ENTRIES + 1000));
    for (const [key] of toRemove) cache.delete(key);
    (_log ?? console).log(`[ref-index-store] Evicted ${toRemove.length} oldest entries`);
  }
}

// ============ 公共 API ============

/**
 * 初始化（懒加载，首次调用时读取文件）
 */
export function initRefIndexStore(log?: Logger): void {
  if (log) _log = log;
  loadFromFile();
}

/**
 * 记录一条消息到引用索引
 */
export function recordRef(entry: RefEntry): void {
  const store = loadFromFile();
  try {
    evictIfNeeded();
  } catch (e) {
    (_log ?? console).error(`[ref-index-store] Eviction failed: ${e}`);
  }

  const now = Date.now();
  const key = entry.accountId ? `${entry.accountId}:${entry.msgId}` : entry.msgId;
  store.set(key, { ...entry, _createdAt: now });

  queueLine({ k: key, v: entry, t: now });

  scheduleCompactIfNeeded();
}

/**
 * 查找被引用消息
 * @param msgId   消息 ID
 * @param accountId 可选账号 ID — 优先精确匹配（含 accountId 的 key），回退裸 msgId（向后兼容）
 */
export function lookupRef(msgId: string, accountId?: string): RefEntry | null {
  const store = loadFromFile();
  const scopedKey = accountId ? `${accountId}:${msgId}` : null;
  const entry = (scopedKey ? store.get(scopedKey) : null) ?? store.get(msgId);
  if (!entry) return null;
  const resolvedKey = (scopedKey && store.has(scopedKey)) ? scopedKey : msgId;
  if (Date.now() - entry._createdAt > TTL_MS) {
    store.delete(resolvedKey);
    return null;
  }
  return {
    msgId: entry.msgId,
    text: entry.text,
    sender: entry.sender,
    senderId: entry.senderId,
    timestamp: entry.timestamp,
    accountId: entry.accountId,
  };
}

/**
 * 进程退出前冲刷写队列并压实
 */
export async function flushRefIndex(): Promise<void> {
  // 1. 先把写队列冲刷到文件
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushWriteQueue();

  // 2. 如需压实，同步执行（进程退出前，setImmediate 可能已来不及）
  if (cache && shouldCompact()) await compactFile();
}

/**
 * 缓存统计（调试用）
 */
export function getRefIndexStats(): {
  size: number;
  maxEntries: number;
  totalLinesOnDisk: number;
  filePath: string;
} {
  const store = loadFromFile();
  return { size: store.size, maxEntries: MAX_ENTRIES, totalLinesOnDisk, filePath: getRefIndexFile() };
}
