/**
 * admin-commands 共享工具函数
 * 供所有 handler 子模块使用。
 */

import type { AdminCmdContext } from "../admin-registry.js";
import { requireConfirm } from "../utils/confirm-pending.js";
import { NapcatApiError } from "../errors/napcat-error.js";

// ============ 常量（从 constants.ts 引入） ============

import { CONFIRM_TIMEOUT_SECONDS } from "./constants.js";

// ============ 消息提取辅助 ============

/** 从消息段数组（或 CQ 码字符串回退）中提取第一个被 @ 的 QQ 号 */
export function extractAtTarget(
  message: AdminCmdContext["message"],
  text: string,
): number | null {
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "at" && seg.data?.qq && /^\d+$/.test(String(seg.data.qq))) {
        return parseInt(seg.data.qq, 10);
      }
    }
  }
  const m = text.match(/\[CQ:at,qq=(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

/** 从消息段数组中提取所有被 @ 的 QQ 号（按出现顺序去重） */
export function extractAtTargets(message: AdminCmdContext["message"], text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "at" && seg.data?.qq && /^\d+$/.test(String(seg.data.qq))) {
        const id = parseInt(seg.data.qq, 10);
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = parseInt(m[1], 10);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** 从消息段数组中提取回复目标消息 ID */
export function extractReplyMsgId(message: AdminCmdContext["message"]): string | null {
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "reply" && seg.data?.id) return String(seg.data.id);
    }
  }
  return null;
}

/** 从消息段提取第一个 image 段的 file（用于 /setportrait） */
export function extractImageFile(message: AdminCmdContext["message"]): string | null {
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "image" && (seg.data?.file || seg.data?.url)) {
        return String(seg.data.file ?? seg.data.url);
      }
    }
  }
  return null;
}

// ============ 发送辅助 ============

/** 发送回复（群发群消息，私聊发私聊） */
export async function reply(ctx: AdminCmdContext, msg: string): Promise<void> {
  if (ctx.isGroup && ctx.groupId) {
    await ctx.client.sendGroupMsg(ctx.groupId, msg);
  } else if (ctx.userId) {
    await ctx.client.sendPrivateMsg(ctx.userId, msg);
  }
}

// ============ 确认辅助 ============

/**
 * 二次确认壳。
 * pending → 发送提示后返回 true（已处理）；confirmed → 返回 false（调用方继续执行）。
 */
export async function needConfirm(
  ctx: AdminCmdContext,
  cmd: string,
  scope: string,
  description: string,
): Promise<boolean> {
  if (!ctx.userId) return false;
  const action = `${cmd}:${scope}`;
  const state = requireConfirm(ctx.userId, action);
  if (state === "pending") {
    await reply(ctx, `⚠️ 高代价操作：${description}\n请在 ${CONFIRM_TIMEOUT_SECONDS} 秒内再发一次同样的命令以确认。`);
    return true;
  }
  return false;
}

// ============ 错误格式化 ============

/** 把 OneBot 抛出的 Error 包成统一文案 */
export function fmtError(err: unknown): string {
  if (err instanceof NapcatApiError) {
    switch (err.code) {
      case "CONNECTION_CLOSED":
        return `连接断开: ${err.message}`;
      case "REQUEST_TIMEOUT":
        return `请求超时: ${err.message}`;
      case "RATE_LIMIT":
        return `速率限制: ${err.message}`;
      case "CLIENT_ERROR":
        return `请求错误 (HTTP ${err.statusCode}): ${err.message}`;
      case "SERVER_ERROR":
        return `服务端错误 (HTTP ${err.statusCode}): ${err.message}`;
      case "API_ERROR":
        return `API 错误: ${err.message}`;
      default:
        return `${err.code}: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// ============ 群聊检查 ============

/** 必须在群里执行的命令的统一提示 */
export async function requireGroup(ctx: AdminCmdContext): Promise<boolean> {
  if (!ctx.isGroup || !ctx.groupId) {
    await reply(ctx, "该命令仅限群聊使用。");
    return false;
  }
  return true;
}

// ============ 参数解析 ============

/** 解析 message_id（优先 reply 段，回退 parts 第 n 项） */
export function resolveMsgId(ctx: AdminCmdContext, parts: string[], idx = 0): string | null {
  const fromReply = extractReplyMsgId(ctx.message);
  if (fromReply) return fromReply;
  const raw = parts[idx];
  if (raw && /^-?\d+$/.test(raw)) return raw;
  return null;
}

// ============ 时间格式化 ============

/** 运行时长格式化 */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}天 ${h}小时 ${m}分`;
  if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}
