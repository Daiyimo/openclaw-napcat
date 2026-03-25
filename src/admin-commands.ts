/**
 * 管理命令处理模块
 *
 * 扩展原有的 /status /help /mute /kick，新增：
 *   /ping    - 测量回复延迟
 *   /version - 显示插件版本和更新状态
 *   /logs    - 导出最近 N 条日志
 */

import type { OneBotClient } from "./client.js";
import { getUpdateInfo } from "./update-checker.js";
import { getRecentLogs, formatLogEntry } from "./log-buffer.js";
import { getPackageVersion } from "./utils/pkg-version.js";

// ============ 上下文类型 ============

export interface AdminCmdContext {
  client: OneBotClient;
  isGroup: boolean;
  groupId?: number;
  userId?: number;
  text: string;
  /** 发送时间戳（ms），用于 /ping 延迟计算 */
  eventTime?: number;
}

// ============ 辅助函数 ============

async function reply(ctx: AdminCmdContext, msg: string): Promise<void> {
  const { client, isGroup, groupId, userId } = ctx;
  if (isGroup && groupId) {
    await client.sendGroupMsg(groupId, msg);
  } else if (userId) {
    await client.sendPrivateMsg(userId, msg);
  }
}

// ============ 命令处理器 ============

/**
 * 处理管理员命令。
 * @returns true 表示已处理，调用方应 return；false 表示未识别，继续正常流程。
 */
export async function handleAdminCommand(
  cmd: string,
  parts: string[],
  ctx: AdminCmdContext,
): Promise<boolean> {
  const { client, isGroup, groupId, userId, text, eventTime } = ctx;

  // ── /ping ───────────────────────────────────────────────
  if (cmd === "/ping") {
    const now = Date.now();
    const latency = eventTime ? now - eventTime : -1;
    const latencyStr = latency >= 0 ? `${latency}ms` : "未知";
    await reply(ctx, `🏓 Pong! 延迟: ${latencyStr}`);
    return true;
  }

  // ── /version ────────────────────────────────────────────
  if (cmd === "/version") {
    const version = getPackageVersion(import.meta.url);
    const nodeVer = process.version;
    let msg = `[OpenClaw QQ] v${version}\nNode.js: ${nodeVer}`;

    try {
      const info = await getUpdateInfo();
      if (info.hasUpdate) {
        msg += `\n更新状态: ✨ 有新版本 v${info.latest} 可用（npm i @openclaw/qq@latest）`;
      } else if (info.error) {
        msg += `\n更新状态: ⚠️ 检查失败（${info.error}）`;
      } else {
        msg += `\n更新状态: ✅ 已是最新版本`;
      }
    } catch {
      msg += `\n更新状态: 检查失败`;
    }

    await reply(ctx, msg);
    return true;
  }

  // ── /logs ────────────────────────────────────────────────
  if (cmd === "/logs") {
    const n = parts[1] ? parseInt(parts[1], 10) : 20;
    const count = isNaN(n) || n <= 0 ? 20 : Math.min(n, 100);
    const logs = getRecentLogs(count);
    if (logs.length === 0) {
      await reply(ctx, "[logs] 暂无日志");
    } else {
      const formatted = logs.map(formatLogEntry).join("\n");
      await reply(ctx, `[最近 ${logs.length} 条日志]\n${formatted}`);
    }
    return true;
  }

  // ── /status ──────────────────────────────────────────────
  if (cmd === "/status") {
    const version = getPackageVersion(import.meta.url);
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const uptime = formatUptime(process.uptime());
    const statusMsg =
      `[OpenClaw QQ] v${version}\n` +
      `状态: 已连接\n` +
      `Self ID: ${client.getSelfId()}\n` +
      `内存: ${mem} MB\n` +
      `运行时间: ${uptime}`;
    await reply(ctx, statusMsg);
    return true;
  }

  // ── /help ────────────────────────────────────────────────
  if (cmd === "/help") {
    const helpMsg =
      `[OpenClaw QQ] 管理命令\n` +
      `/status          - 查看状态\n` +
      `/ping            - 测量延迟\n` +
      `/version         - 查看版本和更新\n` +
      `/logs [N]        - 最近 N 条日志（默认 20）\n` +
      `/mute @用户 [分] - 禁言（默认 30 分钟）\n` +
      `/kick @用户      - 踢出群组\n` +
      `/help            - 显示本帮助`;
    await reply(ctx, helpMsg);
    return true;
  }

  // ── /mute /ban ───────────────────────────────────────────
  if (isGroup && groupId && (cmd === "/mute" || cmd === "/ban")) {
    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
    const rawId = targetMatch ? targetMatch[1] : parts[1];
    const targetId = rawId ? parseInt(rawId, 10) : null;
    if (targetId && targetId > 0) {
      const rawMin = parts[2] ? parseInt(parts[2], 10) : 30;
      const minutes = isNaN(rawMin) ? 30 : Math.max(1, Math.min(rawMin, 43200)); // 1 min ~ 30 days
      client.setGroupBan(groupId, targetId, minutes * 60);
      await reply(ctx, `已禁言 ${targetId} ${minutes} 分钟。`);
    } else {
      await reply(ctx, `用法：/mute @用户 [分钟数]`);
    }
    return true;
  }

  // ── /kick ────────────────────────────────────────────────
  if (isGroup && groupId && cmd === "/kick") {
    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
    const rawId = targetMatch ? targetMatch[1] : parts[1];
    const targetId = rawId ? parseInt(rawId, 10) : null;
    if (targetId && targetId > 0) {
      client.setGroupKick(groupId, targetId);
      await reply(ctx, `已踢出 ${targetId}。`);
    } else {
      await reply(ctx, `用法：/kick @用户`);
    }
    return true;
  }

  return false;
}

// ============ 工具函数 ============

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}天 ${h}小时 ${m}分`;
  if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}
