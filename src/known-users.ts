/**
 * 已知用户存储
 * 记录与机器人交互过的所有用户
 * 支持主动消息和批量通知功能
 */

import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "./utils/platform.js";

// 存储文件路径（延迟初始化，避免模块加载时立即创建目录）
let _KNOWN_USERS_DIR: string | null = null;
let _KNOWN_USERS_FILE: string | null = null;

function getKnownUsersFile(): string {
  if (!_KNOWN_USERS_FILE) {
    _KNOWN_USERS_DIR = getQQBotDataDir("data");
    _KNOWN_USERS_FILE = path.join(_KNOWN_USERS_DIR, "known-users.json");
  }
  return _KNOWN_USERS_FILE;
}

function getKnownUsersDir(): string {
  getKnownUsersFile(); // 确保初始化
  return _KNOWN_USERS_DIR!;
}

// 已知用户信息接口（适配 OneBot/NapCat：使用 QQ 数字号码）
export interface KnownUser {
  /** 用户 QQ 号（字符串形式）或群号 */
  openid: string;
  /** 消息类型 */
  type: "private" | "group" | "guild";
  /** 用户昵称（如有） */
  nickname?: string;
  /** 群号（如果是群消息） */
  groupId?: number;
  /** 关联的机器人账户 ID */
  accountId: string;
  /** 首次交互时间戳 */
  firstSeenAt: number;
  /** 最后交互时间戳 */
  lastSeenAt: number;
  /** 交互次数 */
  interactionCount: number;
}

// 内存缓存
let usersCache: Map<string, KnownUser> | null = null;

// 写入节流配置
const SAVE_THROTTLE_MS = 5000; // 5秒写入一次
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

/**
 * 确保目录存在
 */
function ensureDir(): void {
  const dir = getKnownUsersDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 从文件加载用户数据到缓存
 */
function loadUsersFromFile(): Map<string, KnownUser> {
  if (usersCache !== null) {
    return usersCache;
  }

  usersCache = new Map();

  try {
    const file = getKnownUsersFile();
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, "utf-8");
      const users = JSON.parse(data) as KnownUser[];

      for (const user of users) {
        const key = makeUserKey(user);
        usersCache.set(key, user);
      }

      console.log(`[known-users] Loaded ${usersCache.size} users`);
    }
  } catch (err) {
    console.error(`[known-users] Failed to load users: ${err}`);
    usersCache = new Map();
  }

  return usersCache;
}

/**
 * 保存用户数据到文件（节流版本）
 */
function saveUsersToFile(): void {
  if (!isDirty) return;

  if (saveTimer) {
    return; // 已有定时器在等待
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSaveUsersToFile();
  }, SAVE_THROTTLE_MS);
}

/**
 * 实际执行保存
 */
function doSaveUsersToFile(): void {
  if (!usersCache || !isDirty) return;

  try {
    ensureDir();
    const users = Array.from(usersCache.values());
    fs.writeFileSync(getKnownUsersFile(), JSON.stringify(users, null, 2), "utf-8");
    isDirty = false;
  } catch (err) {
    console.error(`[known-users] Failed to save users: ${err}`);
  }
}

/**
 * 强制立即保存（用于进程退出前）
 */
export function flushKnownUsers(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  doSaveUsersToFile();
}

/**
 * 生成用户唯一键
 */
function makeUserKey(user: Partial<KnownUser>): string {
  const base = `${user.accountId}:${user.type}:${user.openid}`;
  if (user.type === "group" && user.groupId) {
    return `${base}:${user.groupId}`;
  }
  return base;
}

/**
 * 记录已知用户（收到消息时调用）
 */
export function recordKnownUser(user: {
  openid: string;
  type: "private" | "group" | "guild";
  nickname?: string;
  groupId?: number;
  accountId: string;
}): void {
  const cache = loadUsersFromFile();
  const key = makeUserKey(user);
  const now = Date.now();

  const existing = cache.get(key);

  if (existing) {
    existing.lastSeenAt = now;
    existing.interactionCount++;
    if (user.nickname && user.nickname !== existing.nickname) {
      existing.nickname = user.nickname;
    }
  } else {
    const newUser: KnownUser = {
      openid: user.openid,
      type: user.type,
      nickname: user.nickname,
      groupId: user.groupId,
      accountId: user.accountId,
      firstSeenAt: now,
      lastSeenAt: now,
      interactionCount: 1,
    };
    cache.set(key, newUser);
    console.log(`[known-users] New user: ${user.openid} (${user.type})`);
  }

  isDirty = true;
  saveUsersToFile();
}

/**
 * 获取单个用户信息
 */
export function getKnownUser(
  accountId: string,
  openid: string,
  type: "private" | "group" | "guild" = "private",
  groupId?: number
): KnownUser | undefined {
  const cache = loadUsersFromFile();
  const key = makeUserKey({ accountId, openid, type, groupId });
  return cache.get(key);
}

/**
 * 列出所有已知用户
 */
export function listKnownUsers(options?: {
  accountId?: string;
  type?: "private" | "group" | "guild";
  activeWithin?: number;
  limit?: number;
  sortBy?: "lastSeenAt" | "firstSeenAt" | "interactionCount";
  sortOrder?: "asc" | "desc";
}): KnownUser[] {
  const cache = loadUsersFromFile();
  let users = Array.from(cache.values());

  if (options?.accountId) {
    users = users.filter(u => u.accountId === options.accountId);
  }
  if (options?.type) {
    users = users.filter(u => u.type === options.type);
  }
  if (options?.activeWithin) {
    const cutoff = Date.now() - options.activeWithin;
    users = users.filter(u => u.lastSeenAt >= cutoff);
  }

  const sortBy = options?.sortBy ?? "lastSeenAt";
  const sortOrder = options?.sortOrder ?? "desc";
  users.sort((a, b) => {
    const aVal = a[sortBy] ?? 0;
    const bVal = b[sortBy] ?? 0;
    return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
  });

  if (options?.limit && options.limit > 0) {
    users = users.slice(0, options.limit);
  }

  return users;
}

/**
 * 获取用户统计信息
 */
export function getKnownUsersStats(accountId?: string): {
  totalUsers: number;
  privateUsers: number;
  groupUsers: number;
  guildUsers: number;
  activeIn24h: number;
  activeIn7d: number;
} {
  const users = listKnownUsers({ accountId });

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  return {
    totalUsers: users.length,
    privateUsers: users.filter(u => u.type === "private").length,
    groupUsers: users.filter(u => u.type === "group").length,
    guildUsers: users.filter(u => u.type === "guild").length,
    activeIn24h: users.filter(u => now - u.lastSeenAt < day).length,
    activeIn7d: users.filter(u => now - u.lastSeenAt < 7 * day).length,
  };
}

/**
 * 删除用户记录
 */
export function removeKnownUser(
  accountId: string,
  openid: string,
  type: "private" | "group" | "guild" = "private",
  groupId?: number
): boolean {
  const cache = loadUsersFromFile();
  const key = makeUserKey({ accountId, openid, type, groupId });

  if (cache.has(key)) {
    cache.delete(key);
    isDirty = true;
    saveUsersToFile();
    console.log(`[known-users] Removed user ${openid}`);
    return true;
  }

  return false;
}

/**
 * 清除所有用户记录
 */
export function clearKnownUsers(accountId?: string): number {
  const cache = loadUsersFromFile();
  let count = 0;

  if (accountId) {
    for (const [key, user] of cache.entries()) {
      if (user.accountId === accountId) {
        cache.delete(key);
        count++;
      }
    }
  } else {
    count = cache.size;
    cache.clear();
  }

  if (count > 0) {
    isDirty = true;
    doSaveUsersToFile();
    console.log(`[known-users] Cleared ${count} users`);
  }

  return count;
}

/**
 * 获取群组的所有已知成员
 */
export function getGroupMembers(accountId: string, groupId: number): KnownUser[] {
  return listKnownUsers({ accountId, type: "group" })
    .filter(u => u.groupId === groupId);
}
