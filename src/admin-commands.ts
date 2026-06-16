/**
 * 管理命令处理器集合
 *
 * 每个命令是独立函数，接收 AdminCmdContext 和 parts，
 * 返回回复字符串或 null（未处理）。
 * 由 admin-registry.ts 的 CommandRegistry 统一管理。
 */

import type { AdminCmdContext } from "./admin-registry.js";
import { getUpdateInfo } from "./update-checker.js";
import { getRecentLogs, formatLogEntry } from "./log-buffer.js";
import { maskIdsInText } from "./utils/log-sanitize.js";
import { getPackageVersion } from "./utils/pkg-version.js";
import { updateConfigRef, getConfigRef, initConfigRef } from "./config-watcher.js";
import { resolvePassiveModeTemperature } from "./config.js";
import { invalidateOtherBotNamesCache } from "./gateway/trigger-state.js";
import { NapcatApiError } from "./errors/napcat-error.js";
import { requireConfirm } from "./utils/confirm-pending.js";
import {
  getCwd,
  pushCwd,
  popCwd,
  resetCwd,
  formatCwdPath,
  currentFolderId,
  type FolderStackEntry,
} from "./utils/group-file-cwd.js";
import type { ActiveRateLimit } from "./rate-limiter.js";
import { sendProactive } from "./proactive.js";

// ============ 常量 ============

/** /mute 默认禁言时长（分钟） */
const MUTE_DEFAULT_MINUTES = 30;
/** /mute 最大禁言时长（分钟）= 30 天 */
const MUTE_MAX_MINUTES = 43200;
/** /files 默认列文件数量 */
const FILES_DEFAULT_COUNT = 20;
/** /files 最大列文件数量 */
const FILES_MAX_COUNT = 50;
/** /ban 默认禁言时长（秒）= 30 分钟 */
const BAN_DEFAULT_DURATION = 1800;
/** /shutlist 最大显示禁言用户数 */
const MAX_SHUT_LIST_DISPLAY = 30;

/** /logs 默认日志条数 */
const LOGS_DEFAULT_COUNT = 20;
/** /logs 最大日志条数 */
const LOGS_MAX_COUNT = 100;
/** /essence 最大显示精华消息条数 */
const ESSENCE_MAX_DISPLAY = 10;
/** 高代价操作确认窗口（秒） */
const CONFIRM_TIMEOUT_SECONDS = 30;

// ============ 共享辅助函数 ============

/** 从消息段数组（或 CQ 码字符串回退）中提取第一个被 @ 的 QQ 号 */
export function extractAtTarget(message: AdminCmdContext["message"], text: string): number | null {
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
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
  }
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = parseInt(m[1], 10);
    if (!seen.has(id)) { seen.add(id); out.push(id); }
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

/** 发送回复（群发群消息，私聊发私聊） */
export async function reply(ctx: AdminCmdContext, msg: string): Promise<void> {
  if (ctx.isGroup && ctx.groupId) {
    await ctx.client.sendGroupMsg(ctx.groupId, msg);
  } else if (ctx.userId) {
    await ctx.client.sendPrivateMsg(ctx.userId, msg);
  }
}

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

/** 把 OneBot 抛出的 Error 包成统一文案 */
export function fmtError(err: unknown): string {
  if (err instanceof NapcatApiError) {
    // 按错误码提供差异化提示，帮助用户快速定位问题
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

/** 必须在群里执行的命令的统一提示 */
export async function requireGroup(ctx: AdminCmdContext): Promise<boolean> {
  if (!ctx.isGroup || !ctx.groupId) {
    await reply(ctx, "该命令仅限群聊使用。");
    return false;
  }
  return true;
}

/** 解析 message_id（优先 reply 段，回退 parts 第 n 项） */
export function resolveMsgId(ctx: AdminCmdContext, parts: string[], idx = 0): string | null {
  const fromReply = extractReplyMsgId(ctx.message);
  if (fromReply) return fromReply;
  const raw = parts[idx];
  if (raw && /^-?\d+$/.test(raw)) return raw;
  return null;
}

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

// ============ 命令处理器 ============

export async function handlePing(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  const now = Date.now();
  const latency = ctx.eventTime ? now - ctx.eventTime : -1;
  const latencyStr = latency >= 0 ? `${latency}ms` : "未知";
  return `🏓 Pong! 延迟: ${latencyStr}`;
}

export async function handleVersion(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
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
  } catch (err) {
    (ctx.log ?? console).warn("[napcat-QQ] Version check failed:", err);
    msg += `\n更新状态: 检查失败`;
  }

  return msg;
}

export async function handleLogs(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  const n = parts[0] ? parseInt(parts[0], 10) : LOGS_DEFAULT_COUNT;
  const count = isNaN(n) || n <= 0 ? LOGS_DEFAULT_COUNT : Math.min(n, LOGS_MAX_COUNT);
  const logs = getRecentLogs(count);
  if (logs.length === 0) return "[logs] 暂无日志";
  const raw = logs.map(formatLogEntry).join("\n");
  return `[最近 ${logs.length} 条日志]\n${maskIdsInText(raw)}`;
}

export async function handleStatus(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  const version = getPackageVersion(import.meta.url);
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  const uptime = formatUptime(process.uptime());

  if (ctx.metrics) {
    return ctx.metrics.formatReport(
      ctx.client.getSelfId()?.toString() ?? "unknown",
      version,
    );
  }

  return (
    `[OpenClaw QQ] v${version}\n` +
    `状态: 已连接\n` +
    `Self ID: ${ctx.client.getSelfId()}\n` +
    `内存: ${mem} MB\n` +
    `运行时间: ${uptime}`
  );
}

export async function handleHelp(_ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  return HELP_TEXT;
}

export async function handleMute(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (targetId && targetId > 0) {
    const rawMin = parts[1] ? parseInt(parts[1], 10) : MUTE_DEFAULT_MINUTES;
    const minutes = isNaN(rawMin) ? MUTE_DEFAULT_MINUTES : Math.max(1, Math.min(rawMin, MUTE_MAX_MINUTES));
    try {
      ctx.client.setGroupBan(ctx.groupId!, targetId, minutes * 60);
      return `已禁言 ${targetId} ${minutes} 分钟。`;
    } catch (err) {
      return `❌ 禁言失败：${fmtError(err)}`;
    }
  }
  return "用法：/mute @用户 [分钟数]";
}

export async function handleUnmute(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (targetId && targetId > 0) {
    try {
      ctx.client.setGroupBan(ctx.groupId!, targetId, 0);
      return `已解除禁言 ${targetId}。`;
    } catch (err) {
      return `❌ 解除禁言失败：${fmtError(err)}`;
    }
  }
  return "用法：/unmute @用户";
}

export async function handleBan(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (targetId && targetId > 0) {
    const rawMin = parts[1] ? parseInt(parts[1], 10) : MUTE_DEFAULT_MINUTES;
    const minutes = isNaN(rawMin) ? MUTE_DEFAULT_MINUTES : Math.max(1, Math.min(rawMin, MUTE_MAX_MINUTES));
    try {
      ctx.client.setGroupBan(ctx.groupId!, targetId, minutes * 60);
      return `已禁言 ${targetId} ${minutes} 分钟。`;
    } catch (err) {
      return `❌ 禁言失败：${fmtError(err)}`;
    }
  }
  return "用法：/ban @用户 [分钟数]";
}

export async function handleKick(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (targetId && targetId > 0) {
    try {
      ctx.client.setGroupKick(ctx.groupId!, targetId);
      return `已踢出 ${targetId}。`;
    } catch (err) {
      return `❌ 踢人失败：${fmtError(err)}`;
    }
  }
  return "用法：/kick @用户";
}

export async function handleKickBatch(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targets = extractAtTargets(ctx.message, ctx.text);
  if (targets.length === 0) return "用法：/kickbatch @a @b @c（至少一个 @ 目标）";
  if (await needConfirm(ctx, "kickbatch", `${ctx.groupId}:${targets.join(",")}`, `批量踢出 ${targets.length} 人`))
    return null;
  try {
    ctx.client.setGroupKickMembers(ctx.groupId!, targets);
    return `✅ 已批量踢出 ${targets.length} 人：${targets.join(", ")}`;
  } catch (err) {
    return `❌ 批量踢人失败：${fmtError(err)}`;
  }
}

export async function handleAdmin(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const enable = true;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parseInt(_parts[0], 10) || null);
  if (!targetId || targetId <= 0) return "用法：/admin @用户";
  if (await needConfirm(ctx, "admin", `${ctx.groupId}:${targetId}`, `任命管理员 ${targetId}`)) return null;
  try {
    ctx.client.setGroupAdmin(ctx.groupId!, targetId, enable);
    return `✅ 已任命 ${targetId} 为群管理员。`;
  } catch (err) {
    return `❌ 任命管理员失败：${fmtError(err)}（需 bot 为群主）`;
  }
}

export async function handleUnadmin(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const enable = false;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parseInt(_parts[0], 10) || null);
  if (!targetId || targetId <= 0) return "用法：/unadmin @用户";
  if (await needConfirm(ctx, "unadmin", `${ctx.groupId}:${targetId}`, `撤销管理员 ${targetId}`)) return null;
  try {
    ctx.client.setGroupAdmin(ctx.groupId!, targetId, enable);
    return `✅ 已撤销 ${targetId} 的群管理员。`;
  } catch (err) {
    return `❌ 撤销管理员失败：${fmtError(err)}（需 bot 为群主）`;
  }
}

export async function handleCard(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text);
  if (!targetId) return "用法：/card @用户 [新名片]（空 = 清除）";
  const newCard = parts.join(" ").replace(/\[CQ:at,qq=\d+\]\s*/g, "").trim();
  try {
    ctx.client.setGroupCard(ctx.groupId!, targetId, newCard);
    return newCard ? `✅ 已将 ${targetId} 的名片改为「${newCard}」` : `✅ 已清除 ${targetId} 的名片`;
  } catch (err) {
    return `❌ 修改名片失败：${fmtError(err)}`;
  }
}

export async function handleTitle(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text);
  if (!targetId) return "用法：/title @用户 <头衔>（需 bot 为群主）";
  const title = parts.join(" ").replace(/\[CQ:at,qq=\d+\]\s*/g, "").trim();
  if (!title) return "用法：/title @用户 <头衔>";
  try {
    ctx.client.setGroupSpecialTitle(ctx.groupId!, targetId, title);
    return `✅ 已为 ${targetId} 设置头衔「${title}」`;
  } catch (err) {
    return `❌ 设置头衔失败：${fmtError(err)}（需 bot 为群主）`;
  }
}

export async function handleShutList(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const list = await ctx.client.getGroupShutList(ctx.groupId!);
  if (!list || list.length === 0) return "当前无人被禁言。";
  const lines = list.slice(0, MAX_SHUT_LIST_DISPLAY).map((m: Record<string, unknown>) => {
    const id = m.user_id ?? m.uid ?? "?";
    const nick = m.nickname ?? m.card ?? "";
    const until = Number(m.shut_up_timestamp ?? m.shutuptime ?? 0);
    const remain = Math.max(0, until * 1000 - Date.now());
    const min = Math.ceil(remain / 60000);
    return `  ${id}${nick ? `（${nick}）` : ""}：剩余 ${min} 分钟`;
  });
  const more = list.length > MAX_SHUT_LIST_DISPLAY ? `\n（共 ${list.length} 人，仅显示前 ${MAX_SHUT_LIST_DISPLAY}）` : "";
  return `当前禁言名单：\n${lines.join("\n")}${more}`;
}

export async function handleBanAll(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  try {
    ctx.client.setGroupWholeBan(ctx.groupId!, true);
    return "✅ 已开启全员禁言。";
  } catch (err) {
    return `❌ 设置全员禁言失败：${fmtError(err)}`;
  }
}

export async function handleUnbanAll(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  try {
    ctx.client.setGroupWholeBan(ctx.groupId!, false);
    return "✅ 已关闭全员禁言。";
  } catch (err) {
    return `❌ 设置全员禁言失败：${fmtError(err)}`;
  }
}

export async function handleSetName(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const newName = parts.join(" ").trim();
  if (!newName) return "用法：/setname <新群名>";
  if (await needConfirm(ctx, "setname", `${ctx.groupId}:${newName}`, `修改群名为「${newName}」`)) return null;
  try {
    ctx.client.setGroupName(ctx.groupId!, newName);
    return `✅ 已修改群名为「${newName}」`;
  } catch (err) {
    return `❌ 修改群名失败：${fmtError(err)}`;
  }
}

export async function handleSetRemark(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const remark = parts.join(" ").trim();
  if (!remark) return "用法：/setremark <备注>（备注仅 bot 自己可见）";
  if (await needConfirm(ctx, "setremark", `${ctx.groupId}`, `设置群备注为「${remark}」`)) return null;
  try {
    await ctx.client.setGroupRemark(ctx.groupId!, remark);
    return `✅ 已设置群备注为「${remark}」`;
  } catch (err) {
    return `❌ 设置群备注失败：${fmtError(err)}`;
  }
}

export async function handleSetPortrait(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const file = extractImageFile(ctx.message);
  if (!file) return "用法：回复一张图片，并发送 /setportrait";
  if (await needConfirm(ctx, "setportrait", `${ctx.groupId}`, "修改群头像")) return null;
  try {
    await ctx.client.setGroupPortrait(ctx.groupId!, file);
    return "✅ 已修改群头像。";
  } catch (err) {
    return `❌ 修改群头像失败：${fmtError(err)}`;
  }
}

export async function handleLeave(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  if (await needConfirm(ctx, "leave", `${ctx.groupId}`, "bot 退出本群")) return null;
  try {
    ctx.client.setGroupLeave(ctx.groupId!, false);
    return "👋 bot 已退出本群。";
  } catch (err) {
    return `❌ 退群失败：${fmtError(err)}`;
  }
}

export async function handleDismiss(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  if (await needConfirm(ctx, "dismiss", `${ctx.groupId}`, "解散本群（不可逆）")) return null;
  try {
    ctx.client.setGroupLeave(ctx.groupId!, true);
    return "💥 群已解散。";
  } catch (err) {
    return `❌ 解散群失败：${fmtError(err)}（需 bot 为群主）`;
  }
}

export async function handleEssence(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /essence，或 /essence <message_id>`;
  try {
    await ctx.client.setEssenceMsg(msgId);
    return "✅ 已设为精华消息。";
  } catch (err) {
    return `❌ 操作精华消息失败：${fmtError(err)}`;
  }
}

export async function handleDeEssence(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /deessence，或 /deessence <message_id>`;
  try {
    await ctx.client.deleteEssenceMsg(msgId);
    return "✅ 已移出精华消息。";
  } catch (err) {
    return `❌ 操作精华消息失败：${fmtError(err)}`;
  }
}

export async function handleEssenceList(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const list = await ctx.client.getEssenceMsgList(ctx.groupId!);
  if (!list || list.length === 0) return "当前群无精华消息。";
  const lines = list.slice(0, ESSENCE_MAX_DISPLAY).map((m: Record<string, unknown>, i: number) => {
    const sender = m.sender_nick ?? m.sender_id ?? "?";
    const content = (m.content ?? "").toString().slice(0, 60).replace(/\n/g, " ");
    return `  ${i + 1}. ${sender}: ${content}`;
  });
  const more = list.length > ESSENCE_MAX_DISPLAY ? `\n（共 ${list.length} 条精华，仅显示前 ${ESSENCE_MAX_DISPLAY}）` : "";
  return `群精华消息：\n${lines.join("\n")}${more}`;
}

export async function handleHonor(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const type = parts[0] || "all";
  const info = await ctx.client.getGroupHonorInfo(ctx.groupId!, type);
  if (!info) return "❌ 获取群荣誉失败。";
  const fmtTop = (entry: Record<string, unknown>) => {
    const nick = entry?.nickname ?? entry?.uin ?? "?";
    const days = entry?.day_count ?? "";
    return days ? `${nick}（${days} 天）` : String(nick);
  };
  const sections: string[] = [];
  if (info.current_talkative) sections.push(`👑 龙王：${fmtTop(info.current_talkative)}`);
  if (info.talkative_list?.length) sections.push(`🗣 群聊之火：${info.talkative_list.slice(0, 3).map(fmtTop).join(", ")}`);
  if (info.performer_list?.length) sections.push(`🔥 群聊炽焰：${info.performer_list.slice(0, 3).map(fmtTop).join(", ")}`);
  if (info.legend_list?.length) sections.push(`🏆 群聊传说：${info.legend_list.slice(0, 3).map(fmtTop).join(", ")}`);
  if (info.strong_newbie_list?.length) sections.push(`🌱 冒尖小春笋：${info.strong_newbie_list.slice(0, 3).map(fmtTop).join(", ")}`);
  if (info.emotion_list?.length) sections.push(`💖 快乐源泉：${info.emotion_list.slice(0, 3).map(fmtTop).join(", ")}`);
  return sections.length ? `群荣誉（${type}）：\n${sections.join("\n")}` : "该类别暂无数据。";
}

export async function handleAtAllRemain(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const info = await ctx.client.getGroupAtAllRemain(ctx.groupId!);
  if (!info) return "❌ 查询失败。";
  const can = info.can_at_all ?? false;
  const groupRemain = info.remain_at_all_count_for_group ?? info.group_remain_at_all_count ?? "?";
  const meRemain = info.remain_at_all_count_for_uin ?? info.uin_remain_at_all_count ?? "?";
  return (
    `@全体 剩余：\n` +
    `  本群总计：${groupRemain}\n` +
    `  你（${ctx.userId}）：${meRemain}\n` +
    `  当前${can ? "可" : "不可"}@全体。`
  );
}

export async function handleGroupInfo(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  try {
    const info = await ctx.client.getGroupInfo(ctx.groupId!);
    if (!info) return "❌ 获取群信息失败。";
    const memberCount = (info as any).member_count ?? "?";
    const maxMember = (info as any).max_member_count ?? "?";
    const atAll = await ctx.client.getGroupAtAllRemain(ctx.groupId!).catch((err) => {
      console.warn(`[napcat-QQ] getGroupAtAllRemain failed (group ${ctx.groupId}): ${err instanceof Error ? err.message : err}`);
      return null;
    });
    const atAllRemain = atAll ? `${atAll.remain_at_all_count_for_group ?? atAll.group_remain_at_all_count ?? "?"}` : "?";
    return [
      `📋 群 ${ctx.groupId} 详情：`,
      `  群名：${info.group_name ?? "?"}`,
      `  成员：${memberCount}/${maxMember}`,
      `  @全体 剩余：${atAllRemain}`,
    ].join("\n");
  } catch (err) {
    return `❌ 获取群信息失败：${fmtError(err)}`;
  }
}

// ── 群文件命令 ──────────────────────────────────────────────────────

export async function handleFiles(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const stack = getCwd(ctx.userId!, ctx.groupId!);
  const folderId = currentFolderId(stack);
  const rawCount = parts[0] ? parseInt(parts[0], 10) : FILES_DEFAULT_COUNT;
  const count = isNaN(rawCount) ? FILES_DEFAULT_COUNT : Math.max(1, Math.min(rawCount, FILES_MAX_COUNT));
  const data = folderId === "/"
    ? await ctx.client.getGroupRootFiles(ctx.groupId!, count)
    : await ctx.client.getGroupFilesByFolder(ctx.groupId!, folderId, count);
  if (!data) return "❌ 列文件失败。";
  const folders: Record<string, unknown>[] = data.folders ?? [];
  const files: Record<string, unknown>[] = data.files ?? [];
  const pwd = formatCwdPath(stack);
  const fLines = folders.slice(0, count).map((f: Record<string, unknown>) => `  📁 ${f.folder_name ?? f.name ?? "?"}    [${f.folder_id ?? f.id ?? "?"}]`);
  const lLines = files.slice(0, count).map((f: Record<string, unknown>) => {
    const fileSize = f.file_size as number | undefined;
    const size = fileSize ? `${(fileSize / 1024).toFixed(1)} KB` : "";
    return `  📄 ${f.file_name ?? f.name ?? "?"}  ${size}  [${f.file_id ?? f.id ?? "?"}]`;
  });
  const body = [...fLines, ...lLines].join("\n") || "  （空目录）";
  return `📂 当前目录：${pwd}\n${body}\n\n用 /cd <文件夹名> 进入；/cdup 上层；/cd / 回根`;
}

export async function handleCd(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const target = parts.join(" ").trim();
  if (!target) return "用法：/cd <文件夹名> | /cd /（回根）";
  if (target === "/") {
    resetCwd(ctx.userId!, ctx.groupId!);
    return "📂 已回到根目录。";
  }
  const stack = getCwd(ctx.userId!, ctx.groupId!);
  const folderId = currentFolderId(stack);
  const data = folderId === "/"
    ? await ctx.client.getGroupRootFiles(ctx.groupId!)
    : await ctx.client.getGroupFilesByFolder(ctx.groupId!, folderId);
  const folders: Record<string, unknown>[] = data?.folders ?? [];
  const match = folders.find((f: Record<string, unknown>) => (f.folder_name ?? f.name) === target);
  if (!match) return `❌ 当前目录下未找到子文件夹「${target}」（用 /files 查看可用列表）`;
  const entry: FolderStackEntry = { id: String(match.folder_id ?? match.id), name: String(match.folder_name ?? match.name) };
  pushCwd(ctx.userId!, ctx.groupId!, entry);
  return `📂 已进入 ${formatCwdPath(getCwd(ctx.userId!, ctx.groupId!))}`;
}

export async function handleCdup(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const popped = popCwd(ctx.userId!, ctx.groupId!);
  const pwd = formatCwdPath(getCwd(ctx.userId!, ctx.groupId!));
  return popped ? `📂 已离开 ${popped.name}，当前 ${pwd}` : "📂 已在根目录。";
}

export async function handlePwd(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  return `📂 ${formatCwdPath(getCwd(ctx.userId!, ctx.groupId!))}`;
}

export async function handleDl(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const fileId = parts[0];
  if (!fileId) return "用法：/dl <file_id>（file_id 从 /files 获取）";
  const data = await ctx.client.getGroupFileUrl(ctx.groupId!, fileId);
  if (!data || !data.url) return "❌ 获取下载链接失败。";
  return `🔗 下载链接：\n${data.url}`;
}

export async function handleDelFile(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const fileId = parts[0];
  if (!fileId) return "用法：/delfile <file_id>";
  try {
    await ctx.client.deleteGroupFile(ctx.groupId!, fileId);
    return `✅ 已删除文件 ${fileId}`;
  } catch (err) {
    return `❌ 删除文件失败：${fmtError(err)}`;
  }
}

export async function handleMkdir(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const name = parts.join(" ").trim();
  if (!name) return "用法：/mkdir <文件夹名>";
  try {
    await ctx.client.createGroupFileFolder(ctx.groupId!, name);
    return `✅ 已创建文件夹「${name}」`;
  } catch (err) {
    return `❌ 创建文件夹失败：${fmtError(err)}`;
  }
}

export async function handleRmdir(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const folderId = parts[0];
  if (!folderId) return "用法：/rmdir <folder_id>（从 /files 获取）";
  try {
    await ctx.client.deleteGroupFolder(ctx.groupId!, folderId);
    return `✅ 已删除文件夹 ${folderId}`;
  } catch (err) {
    return `❌ 删除文件夹失败：${fmtError(err)}`;
  }
}

export async function handleMvFile(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const fileId = parts[0];
  const targetDir = parts[1];
  if (!fileId || !targetDir) return "用法：/mvfile <file_id> <target_folder_id>（target 用 / 表示根目录）";
  const curDir = currentFolderId(getCwd(ctx.userId!, ctx.groupId!));
  try {
    await ctx.client.moveGroupFile(ctx.groupId!, fileId, curDir, targetDir);
    return `✅ 已移动文件 ${fileId} → ${targetDir}`;
  } catch (err) {
    return `❌ 移动文件失败：${fmtError(err)}`;
  }
}

export async function handleRenameFile(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const fileId = parts[0];
  const newName = parts.slice(1).join(" ").trim();
  if (!fileId || !newName) return "用法：/renamefile <file_id> <新名>";
  const curDir = currentFolderId(getCwd(ctx.userId!, ctx.groupId!));
  try {
    await ctx.client.renameGroupFile(ctx.groupId!, fileId, curDir, newName);
    return `✅ 已重命名为「${newName}」`;
  } catch (err) {
    return `❌ 重命名失败：${fmtError(err)}`;
  }
}

export async function handleUpload(_ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  return (
    "ℹ️ 上传群文件请直接拖拽到群里（NapCat 自动同步到群文件）。\n" +
    "如需通过 API 上传，调用 client.uploadGroupFile(groupId, file, name)。"
  );
}

// ── NapCat 扩展命令 ─────────────────────────────────────────────────

export async function handlePoke(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (!targetId) return "用法：/poke @用户";
  try {
    ctx.client.sendGroupPoke(ctx.groupId!, targetId);
    return `👉 已戳一戳 ${targetId}`;
  } catch (err) {
    return `❌ 戳一戳失败：${fmtError(err)}`;
  }
}

export async function handleSign(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  try {
    await ctx.client.setGroupSign(ctx.groupId!);
    return "✅ 已群签到。";
  } catch (err) {
    return `❌ 签到失败：${fmtError(err)}`;
  }
}

export async function handleTodo(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /todo，或 /todo <message_id>`;
  try {
    await ctx.client.setGroupTodo(ctx.groupId!, msgId);
    return `✅ 已标记消息 ${msgId} 为待办`;
  } catch (err) {
    return `❌ 待办操作失败：${fmtError(err)}`;
  }
}

export async function handleDoneTodo(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /donetodo，或 /donetodo <message_id>`;
  try {
    await ctx.client.completeGroupTodo(ctx.groupId!, msgId);
    return `✅ 已完成消息 ${msgId}`;
  } catch (err) {
    return `❌ 待办操作失败：${fmtError(err)}`;
  }
}

export async function handleCancelTodo(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /canceltodo，或 /canceltodo <message_id>`;
  try {
    await ctx.client.cancelGroupTodo(ctx.groupId!, msgId);
    return `✅ 已取消消息 ${msgId} 的待办`;
  } catch (err) {
    return `❌ 待办操作失败：${fmtError(err)}`;
  }
}

export async function handleSendTo(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  const target = parts[0];
  const msgText = parts.slice(1).join(" ");
  if (!target || !msgText) {
    return (
      `用法：/sendto <目标> <消息内容>\n示例：\n` +
      `  /sendto group:88888888 早上好\n` +
      `  /sendto 12345678 你好`
    );
  }
  try {
    const result = await sendProactive({ to: target, text: msgText });
    if (result.success) return `✅ 已发送到 ${target}`;
    return `❌ 发送失败：${result.error}`;
  } catch (err) {
    return `❌ 发送失败：${fmtError(err)}`;
  }
}

export async function handleReload(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!ctx.configRef || !ctx.fullCfg) return "❌ 热更新未启用";
  const napcat = ctx.fullCfg.channels?.napcat;
  const result = updateConfigRef(ctx.configRef, napcat);
  if (result.success) {
    invalidateOtherBotNamesCache();
    let msg = "✅ 配置已重载";
    if (result.connectionChanged) {
      msg += "\n⚠️ 连接参数有变更，需重启容器才能生效";
    }
    if (ctx.rateLimiter && napcat?.inboundRateLimitMs !== undefined) {
      ctx.rateLimiter.updateWindowMs(napcat.inboundRateLimitMs);
      ctx.rateLimiter.updateAdmins([...(napcat.admins ?? []), ...(napcat.sharedAdmins ?? [])]);
    }
    return msg;
  }
  return `❌ 配置验证失败，保留旧配置\n${result.error}`;
}

export async function handleGroups(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!ctx.refreshGroupRoutes) return "❌ 群路由刷新未启用";
  try {
    const count = await ctx.refreshGroupRoutes();
    return `✅ 已刷新 ${count} 个群路由，cron 投递现在可用`;
  } catch (err) {
    return `❌ 刷新失败：${fmtError(err)}`;
  }
}

export async function handleRateLimit(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!ctx.rateLimiter) return "❌ 限流器未初始化";
  const { windowMs, maxMessages } = ctx.rateLimiter.getConfig();
  const configLine =
    windowMs <= 0
      ? "当前状态: 禁用 (windowMs=0)"
      : `当前阈值: ${maxMessages} 条 / ${windowMs / 1000}s`;
  const limits = ctx.rateLimiter.getActiveLimits();
  if (limits.length === 0) return `✅ 当前无活跃限流\n${configLine}`;
  const lines = limits.map((l: ActiveRateLimit) => {
    const remaining = (l.retryAfterMs / 1000).toFixed(1);
    const display = l.target.startsWith("user:") ? `用户 ${l.target.slice(5)}` : `群 ${l.target.slice(6)}`;
    return `  ${display}: 冷却 ${remaining}s (窗口内 ${l.count} 条, 累计阻断 ${l.blockedTotal} 次)`;
  });
  return `${configLine}\n⚠️ 活跃限流 (${limits.length}):\n${lines.join("\n")}`;
}

export async function handleUnrateLimit(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!ctx.rateLimiter) return "❌ 限流器未初始化";
  const target = parts[0];
  if (!target) return "用法: /unratelimit <用户QQ号或群号>\n例: /unratelimit 123456789";
  const cleared = ctx.rateLimiter.clear(target);
  if (cleared) return `✅ 已解除 ${target} 的限流`;
  return `ℹ️ ${target} 当前未被限流`;
}

export async function handleTemperature(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  const configRef = getConfigRef();
  if (!configRef) return "❌ 配置引用未初始化（需要重启后生效）";
  const raw = ctx.text.trim();
  const match = raw.match(/温度\s*[=:：]\s*(\d+)/i) ?? raw.match(/(\d+)\s*[=:：]\s*温度/i);
  if (!match) {
    const pm = configRef.current.passiveMode;
    const t = pm?.temperature;
    const sub = [
      pm?.cooldownMs != null ? `冷却 ${pm.cooldownMs / 1000}s` : null,
      pm?.minIntervalMs != null ? `最小间隔 ${pm.minIntervalMs / 1000}s` : null,
      pm?.botSuppressionMs != null ? `Bot压制 ${pm.botSuppressionMs / 1000}s` : null,
    ].filter(Boolean).join(" / ");
    const header = t != null ? `🌡️ 当前温度: ${t}` : "🌡️ 当前配置:";
    return `${header}\n${sub || "使用默认值（温度=50 对应冷却10s/间隔30s/压制120s）"}`;
  }
  const t = Number(match[1]);
  if (!Number.isInteger(t) || t < 0 || t > 100) return "❌ 温度需为 0-100 的整数";
  const current = configRef.current;
  const pm = current.passiveMode ?? {};
  const updated = { ...current, passiveMode: { ...pm, temperature: t } };
  const result = updateConfigRef(configRef, updated);
  if (!result.success) return `❌ 设置失败: ${result.error}`;
  const mapped = resolvePassiveModeTemperature(t) ?? {};
  return `✅ 温度设为 ${t}\n冷却 ${(mapped.cooldownMs ?? 0) / 1000}s / 最小间隔 ${(mapped.minIntervalMs ?? 0) / 1000}s / Bot压制 ${(mapped.botSuppressionMs ?? 0) / 1000}s`;
}

// ============ /help 文本 ============

const HELP_TEXT =
  `[OpenClaw QQ] 管理命令（带 * 为二次确认，30s 内再发一次确认）\n` +
  `\n` +
  `📊 基础\n` +
  `  /status              查看状态\n` +
  `  /ping                测量延迟\n` +
  `  /version             查看版本和更新\n` +
  `  /logs [N]            最近 N 条日志（默认 20）\n` +
  `  /reload              热重载配置\n` +
  `  /groups              刷新群路由（解决 cron 投递问题）\n` +
  `  /ratelimit           查看当前活跃限流列表\n` +
  `  /unratelimit <目标>   解除指定用户/群的限流\n` +
  `  /sendto <目标> <内容>  跨会话发送\n` +
  `\n` +
  `👥 群成员\n` +
  `  /mute @用户 [分]     禁言（默认 30 分钟）\n` +
  `  /unmute @用户        解除禁言\n` +
  `  /ban @用户 [分]      同 /mute\n` +
  `  /kick @用户          踢人\n` +
  `  /kickbatch @a @b *   批量踢人\n` +
  `  /admin @用户 *       任命管理员（需 bot 为群主）\n` +
  `  /unadmin @用户 *     撤销管理员\n` +
  `  /card @用户 [名片]    改群名片（空 = 清除）\n` +
  `  /title @用户 <头衔>   设置专属头衔（需群主）\n` +
  `  /shutlist            查看禁言名单\n` +
  `\n` +
  `🔇 全员\n` +
  `  /banall              开启全员禁言\n` +
  `  /unbanall            关闭全员禁言\n` +
  `\n` +
  `🏷️ 群资料\n` +
  `  /setname <新群名> *   改群名（需群主）\n` +
  `  /setremark <备注> *   改群备注（仅自己看到）\n` +
  `  /setportrait *       改群头像（回复一张图片）\n` +
  `  /leave *             bot 退出本群\n` +
  `  /dismiss *           解散本群（需群主，不可逆）\n` +
  `\n` +
  `⭐ 精华消息\n` +
  `  /essence [msgid]     设为精华（回复消息或带 msgid）\n` +
  `  /deessence [msgid]   取消精华\n` +
  `  /essencelist         列精华消息\n` +
  `\n` +
  `📈 查询\n` +
  `  /honor [type]        群荣誉（type: all/talkative/performer/legend/strong_newbie/emotion）\n` +
  `  /atallremain         @全体 剩余次数\n` +
  `  /groupinfo           群详情\n` +
  `\n` +
  `📁 群文件\n` +
  `  /files [count]       列当前目录（默认 20）\n` +
  `  /cd <文件夹名>       进入子目录；/cd / 回根\n` +
  `  /cdup                上级目录\n` +
  `  /pwd                 当前路径\n` +
  `  /dl <file_id>        获取下载链接\n` +
  `  /delfile <file_id>   删文件\n` +
  `  /mkdir <name>        新建子文件夹\n` +
  `  /rmdir <folder_id>   删子文件夹\n` +
  `  /mvfile <fid> <tgt>  移动文件（tgt 用 / 表示根目录）\n` +
  `  /renamefile <fid> <新名>  重命名\n` +
  `  /upload              上传方式说明\n` +
  `\n` +
  `🎭 NapCat 扩展\n` +
  `  /poke @用户          戳一戳\n` +
  `  /sign                群签到\n` +
  `  /todo [msgid]        标记待办\n` +
  `  /donetodo [msgid]    完成待办\n` +
  `  /canceltodo [msgid]  取消待办\n` +
  `\n` +
  `/help                显示本帮助`;

// ============ 注册表 ============

import { CommandRegistry } from "./admin-registry.js";

/** 全局管理命令注册表 */
export const adminCommandRegistry = new CommandRegistry();

adminCommandRegistry.register("ping", "测量延迟", handlePing);
adminCommandRegistry.register("version", "查看版本", handleVersion);
adminCommandRegistry.register("logs", "最近日志", handleLogs);
adminCommandRegistry.register("status", "查看状态", handleStatus);
adminCommandRegistry.register("help", "帮助", handleHelp);

adminCommandRegistry.register("mute", "禁言", handleMute);
adminCommandRegistry.register("unmute", "解除禁言", handleUnmute);
adminCommandRegistry.register("ban", "禁言", handleBan);
adminCommandRegistry.register("kick", "踢人", handleKick);
adminCommandRegistry.register("kickbatch", "批量踢人", handleKickBatch);
adminCommandRegistry.register("admin", "任命管理员", handleAdmin);
adminCommandRegistry.register("unadmin", "撤销管理员", handleUnadmin);
adminCommandRegistry.register("card", "改名片", handleCard);
adminCommandRegistry.register("title", "设头衔", handleTitle);
adminCommandRegistry.register("shutlist", "禁言名单", handleShutList);
adminCommandRegistry.register("banall", "全员禁言", handleBanAll);
adminCommandRegistry.register("unbanall", "解除全员禁言", handleUnbanAll);
adminCommandRegistry.register("setname", "改群名", handleSetName);
adminCommandRegistry.register("setremark", "改群备注", handleSetRemark);
adminCommandRegistry.register("setportrait", "改群头像", handleSetPortrait);
adminCommandRegistry.register("leave", "bot 退群", handleLeave);
adminCommandRegistry.register("dismiss", "解散群", handleDismiss);
adminCommandRegistry.register("essence", "设精华", handleEssence);
adminCommandRegistry.register("deessence", "取消精华", handleDeEssence);
adminCommandRegistry.register("essencelist", "精华列表", handleEssenceList);
adminCommandRegistry.register("honor", "群荣誉", handleHonor);
adminCommandRegistry.register("atallremain", "@全体 剩余", handleAtAllRemain);
adminCommandRegistry.register("groupinfo", "群详情", handleGroupInfo);

adminCommandRegistry.register("files", "列群文件", handleFiles);
adminCommandRegistry.register("cd", "进入子目录", handleCd);
adminCommandRegistry.register("cdup", "上级目录", handleCdup);
adminCommandRegistry.register("pwd", "当前路径", handlePwd);
adminCommandRegistry.register("dl", "下载链接", handleDl);
adminCommandRegistry.register("delfile", "删文件", handleDelFile);
adminCommandRegistry.register("mkdir", "建文件夹", handleMkdir);
adminCommandRegistry.register("rmdir", "删文件夹", handleRmdir);
adminCommandRegistry.register("mvfile", "移动文件", handleMvFile);
adminCommandRegistry.register("renamefile", "重命名文件", handleRenameFile);
adminCommandRegistry.register("upload", "上传说明", handleUpload);

adminCommandRegistry.register("poke", "戳一戳", handlePoke);
adminCommandRegistry.register("sign", "群签到", handleSign);
adminCommandRegistry.register("todo", "待办", handleTodo);
adminCommandRegistry.register("donetodo", "完成待办", handleDoneTodo);
adminCommandRegistry.register("canceltodo", "取消待办", handleCancelTodo);

adminCommandRegistry.register("sendto", "跨会话发送", handleSendTo);
adminCommandRegistry.register("reload", "热重载配置", handleReload);
adminCommandRegistry.register("groups", "刷新群路由", handleGroups);
adminCommandRegistry.register("ratelimit", "查看限流", handleRateLimit);
adminCommandRegistry.register("unratelimit", "解除限流", handleUnrateLimit);
adminCommandRegistry.register("temperature", "调整被动模式温度", handleTemperature);

/**
 * 管理命令统一入口。
 *
 * 支持两种调用方式（向后兼容）：
 * - 旧签名：handleAdminCommand(cmd: string, args: string[], ctx: Partial<AdminCmdContext>)
 * - 新签名：handleAdminCommand(ctx: AdminCmdContext)
 *
 * 返回 boolean（true = 命中并处理，false = 未命中）。
 */
export async function handleAdminCommand(
  cmdOrCtx: string | AdminCmdContext,
  args?: string[],
  ctx?: Partial<AdminCmdContext>,
): Promise<boolean> {
  let context: AdminCmdContext;
  let trailingArgs: string[];
  let matchedCmd: string | null = null;

  if (typeof cmdOrCtx === "string" && args && ctx) {
    // ── 旧签名：handleAdminCommand(cmd, args, ctx) ──
    const text = ctx.text ?? cmdOrCtx;
    const trimmed = text.startsWith("/") ? text.slice(1) : text;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    trailingArgs = parts.slice(1);

    // 管理员授权检查（防御性：即使调用方未检查也在此拦截）
    if (ctx.isAdmin === false) {
      return false;
    }

    matchedCmd = findCommand(cmd);
    if (!matchedCmd) return false;

    context = {
      client: ctx.client!,
      isGroup: ctx.isGroup ?? false,
      groupId: ctx.groupId,
      userId: ctx.userId,
      text: trimmed,
      message: ctx.message,
      eventTime: ctx.eventTime,
      configRef: ctx.configRef,
      fullCfg: ctx.fullCfg,
      refreshGroupRoutes: ctx.refreshGroupRoutes,
      rateLimiter: ctx.rateLimiter,
      metrics: ctx.metrics,
      alertCooldown: ctx.alertCooldown,
      log: ctx.log,
      isAdmin: ctx.isAdmin,
    };
  } else {
    // ── 新签名：handleAdminCommand(ctx) ──
    const fullCtx = cmdOrCtx as AdminCmdContext;
    const text = fullCtx.text.trim();
    if (text.length === 0) return false;

    // 管理员授权检查（防御性：即使调用方未检查也在此拦截）
    if (fullCtx.isAdmin === false) {
      return false;
    }

    const trimmed = text.startsWith("/") ? text.slice(1) : text;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    trailingArgs = parts.slice(1);

    matchedCmd = findCommand(cmd);
    if (!matchedCmd) return false;

    context = fullCtx;
  }

  return adminCommandRegistry.execute(matchedCmd!, context, trailingArgs);
}

/** 在已注册命令中查找最长前缀匹配 */
function findCommand(input: string): string | null {
  const names = adminCommandRegistry.getCommandNames();
  // 先找完全匹配
  if (names.includes(input)) return input;
  // 再找前缀匹配（最长的）
  let best: string | null = null;
  for (const name of names) {
    if (name.startsWith(input) && input.length >= 3 && (!best || name.length > best.length)) {
      best = name;
    }
  }
  return best;
}

// 重新导出类型，保持向后兼容
export type { AdminCmdContext } from "./admin-registry.js";
