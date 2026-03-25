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

const STORAGE_DIR = getQQBotDataDir("data");
const REF_INDEX_FILE = path.join(STORAGE_DIR, "ref-index.jsonl");
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
    if (!fs.existsSync(REF_INDEX_FILE)) {
      cacheReady = true;
      return cache;
    }

    const raw = fs.readFileSync(REF_INDEX_FILE, "utf-8");
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

    console.log(
      `[ref-index-store] Loaded ${cache.size} entries from ${totalLinesOnDisk} lines (${expired} expired)`,
    );

    if (shouldCompact()) compactFile();
  } catch (err) {
    console.error(`[ref-index-store] Failed to load: ${err}`);
    cache = new Map();
  }

  cacheReady = true;
  return cache;
}

// ============ JSONL 追加写 ============

function appendLine(line: RefIndexLine): void {
  try {
    ensureDir();
    fs.appendFileSync(REF_INDEX_FILE, JSON.stringify(line) + "\n", "utf-8");
    totalLinesOnDisk++;
  } catch (err) {
    console.error(`[ref-index-store] Failed to append: ${err}`);
  }
}

function ensureDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

// ============ Compact ============

function shouldCompact(): boolean {
  if (!cache) return false;
  return totalLinesOnDisk > cache.size * COMPACT_THRESHOLD_RATIO && totalLinesOnDisk > 1000;
}

function compactFile(): void {
  if (!cache) return;
  const before = totalLinesOnDisk;
  try {
    ensureDir();
    const tmpPath = REF_INDEX_FILE + ".tmp";
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
    fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    fs.renameSync(tmpPath, REF_INDEX_FILE);
    totalLinesOnDisk = cache.size;
    console.log(`[ref-index-store] Compacted: ${before} lines → ${totalLinesOnDisk} lines`);
  } catch (err) {
    console.error(`[ref-index-store] Compact failed: ${err}`);
  }
}

// ============ 溢出淘汰 ============

function evictIfNeeded(): void {
  if (!cache || cache.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry._createdAt > TTL_MS) cache.delete(key);
  }
  if (cache.size >= MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1]._createdAt - b[1]._createdAt);
    const toRemove = sorted.slice(0, cache.size - MAX_ENTRIES + 1000);
    for (const [key] of toRemove) cache.delete(key);
    console.log(`[ref-index-store] Evicted ${toRemove.length} oldest entries`);
  }
}

// ============ 公共 API ============

/**
 * 初始化（懒加载，首次调用时读取文件）
 */
export function initRefIndexStore(): void {
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
    console.error(`[ref-index-store] Eviction failed: ${e}`);
  }

  const now = Date.now();
  store.set(entry.msgId, { ...entry, _createdAt: now });

  appendLine({ k: entry.msgId, v: entry, t: now });

  if (shouldCompact()) compactFile();
}

/**
 * 查找被引用消息
 */
export function lookupRef(msgId: string): RefEntry | null {
  const store = loadFromFile();
  const entry = store.get(msgId);
  if (!entry) return null;
  if (Date.now() - entry._createdAt > TTL_MS) {
    store.delete(msgId);
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
 * 进程退出前强制 compact
 */
export function flushRefIndex(): void {
  if (cache && shouldCompact()) compactFile();
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
  return { size: store.size, maxEntries: MAX_ENTRIES, totalLinesOnDisk, filePath: REF_INDEX_FILE };
}
