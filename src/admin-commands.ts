/**
 * 管理命令处理模块
 *
 * 入口：handleAdminCommand(cmd, parts, ctx)
 * 已在 gateway/inbound.ts 的 admin gate 之后调用，所有命令默认 admin 权限。
 *
 * 命令分组：
 *   - 基础：/ping /version /logs /status /help /sendto /reload /groups
 *   - 群成员管理：/mute /unmute /ban /kick /kickbatch* /admin* /unadmin* /card /title /shutlist
 *   - 群禁言/全员：/banall /unbanall
 *   - 群资料：/setname* /setremark* /setportrait* /leave* /dismiss*
 *   - 精华消息：/essence /deessence /essencelist
 *   - 查询：/honor /atallremain /groupinfo
 *   - 群文件：/files /cd /cdup /pwd /dl /delfile /mkdir /rmdir /mvfile /renamefile /upload
 *   - NapCat 扩展：/poke /sign /todo /donetodo /canceltodo
 *
 * 带 * 的命令为"高代价/不可逆"，走二次确认（utils/confirm-pending）。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OneBotClient } from "./client.js";
import type { OneBotMessage } from "./types.js";
import { getUpdateInfo } from "./update-checker.js";
import { getRecentLogs, formatLogEntry } from "./log-buffer.js";
import { getPackageVersion } from "./utils/pkg-version.js";
import { updateConfigRef, type ConfigRef } from "./config-watcher.js";
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

import type { InboundRateLimiter } from "./rate-limiter.js";

// ============ 上下文类型 ============

export interface AdminCmdContext {
  client: OneBotClient;
  isGroup: boolean;
  groupId?: number;
  userId?: number;
  text: string;
  /** 原始消息段数组，用于解析 @目标 / 回复消息 */
  message?: OneBotMessage | string;
  /** 发送时间戳（ms），用于 /ping 延迟计算 */
  eventTime?: number;
  /** 配置引用，供 /reload 命令使用 */
  configRef?: ConfigRef;
  /** 完整 OpenClaw 配置，供 /reload 读取最新值 */
  fullCfg?: OpenClawConfig;
  /** 群路由刷新回调，供 /groups 命令使用。返回注册的群数量 */
  refreshGroupRoutes?: () => Promise<number>;
  /** 入站限流器，供 /ratelimit /unratelimit 命令使用 */
  rateLimiter?: InboundRateLimiter;
}

// ============ 辅助函数 ============

/** 从消息段数组（或 CQ 码字符串回退）中提取第一个被 @ 的 QQ 号 */
function extractAtTarget(message: OneBotMessage | string | undefined, text: string): number | null {
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "at" && seg.data?.qq && /^\d+$/.test(String(seg.data.qq))) {
        return parseInt(seg.data.qq, 10);
      }
    }
  }
  // 回退：从纯文本中匹配（兼容字符串格式消息）
  const m = text.match(/\[CQ:at,qq=(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 从消息段数组中提取所有被 @ 的 QQ 号（按出现顺序去重）。
 * 用于 /kickbatch 等多目标命令。CQ 码回退也支持多 @。
 */
function extractAtTargets(message: OneBotMessage | string | undefined, text: string): number[] {
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
  // CQ 码全局匹配兜底
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = parseInt(m[1], 10);
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/**
 * 从消息段数组中提取回复目标消息 ID。OneBot reply 段格式：
 * { type: "reply", data: { id: "<msg_id>" } }
 */
function extractReplyMsgId(message: OneBotMessage | string | undefined): string | null {
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "reply" && seg.data?.id) return String(seg.data.id);
    }
  }
  return null;
}

/**
 * 从消息段提取第一个 image 段的 file（用于 /setportrait）。
 */
function extractImageFile(message: OneBotMessage | string | undefined): string | null {
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "image" && (seg.data?.file || seg.data?.url)) {
        return String(seg.data.file ?? seg.data.url);
      }
    }
  }
  return null;
}

async function reply(ctx: AdminCmdContext, msg: string): Promise<void> {
  const { client, isGroup, groupId, userId } = ctx;
  if (isGroup && groupId) {
    await client.sendGroupMsg(groupId, msg);
  } else if (userId) {
    await client.sendPrivateMsg(userId, msg);
  }
}

/**
 * 二次确认壳。pending 时 reply 提示后返回 true（已处理）；confirmed 时返回 false（调用方继续真正执行）。
 *
 * 调用样板：
 *   if (await needConfirm(ctx, "dismiss", String(groupId), "解散本群")) return true;
 *   // 执行真正的 dismiss 动作
 */
async function needConfirm(
  ctx: AdminCmdContext,
  cmd: string,
  scope: string,
  description: string,
): Promise<boolean> {
  if (!ctx.userId) return false;
  const action = `${cmd}:${scope}`;
  const state = requireConfirm(ctx.userId, action);
  if (state === "pending") {
    await reply(
      ctx,
      `⚠️ 高代价操作：${description}\n请在 30 秒内再发一次同样的命令以确认。`,
    );
    return true;
  }
  return false;
}

/** 把 OneBot 抛出的 Error 包成统一文案 */
function fmtError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 必须在群里执行的命令的统一提示 */
async function requireGroup(ctx: AdminCmdContext): Promise<boolean> {
  if (!ctx.isGroup || !ctx.groupId) {
    await reply(ctx, "该命令仅限群聊使用。");
    return false;
  }
  return true;
}

/** 解析 message_id（优先 reply 段，回退 parts 第 n 项） */
function resolveMsgId(ctx: AdminCmdContext, parts: string[], idx: number = 1): string | null {
  const fromReply = extractReplyMsgId(ctx.message);
  if (fromReply) return fromReply;
  const raw = parts[idx];
  if (raw && /^-?\d+$/.test(raw)) return raw;
  return null;
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
    } catch (e) {
      console.debug(`[napcat-QQ] Update check failed in /status:`, e);
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
    await reply(ctx, HELP_TEXT);
    return true;
  }

  // ── /mute /ban /unmute /kick ─────────────────────────────
  if (isGroup && groupId && (cmd === "/mute" || cmd === "/ban")) {
    const targetId = extractAtTarget(ctx.message, text) ?? (parts[1] ? parseInt(parts[1], 10) : null);
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

  if (isGroup && groupId && cmd === "/unmute") {
    const targetId = extractAtTarget(ctx.message, text) ?? (parts[1] ? parseInt(parts[1], 10) : null);
    if (targetId && targetId > 0) {
      client.setGroupBan(groupId, targetId, 0);
      await reply(ctx, `已解除禁言 ${targetId}。`);
    } else {
      await reply(ctx, `用法：/unmute @用户`);
    }
    return true;
  }

  if (isGroup && groupId && cmd === "/kick") {
    const targetId = extractAtTarget(ctx.message, text) ?? (parts[1] ? parseInt(parts[1], 10) : null);
    if (targetId && targetId > 0) {
      client.setGroupKick(groupId, targetId);
      await reply(ctx, `已踢出 ${targetId}。`);
    } else {
      await reply(ctx, `用法：/kick @用户`);
    }
    return true;
  }

  // ── /kickbatch（二次确认）─────────────────────────────────
  if (cmd === "/kickbatch") {
    if (!(await requireGroup(ctx))) return true;
    const targets = extractAtTargets(ctx.message, text);
    if (targets.length === 0) {
      await reply(ctx, "用法：/kickbatch @a @b @c（至少一个 @ 目标）");
      return true;
    }
    if (await needConfirm(ctx, "kickbatch", `${groupId}:${targets.join(",")}`, `批量踢出 ${targets.length} 人`)) return true;
    try {
      client.setGroupKickMembers(groupId!, targets);
      await reply(ctx, `✅ 已批量踢出 ${targets.length} 人：${targets.join(", ")}`);
    } catch (err) {
      await reply(ctx, `❌ 批量踢人失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /admin /unadmin（二次确认）────────────────────────────
  if (cmd === "/admin" || cmd === "/unadmin") {
    if (!(await requireGroup(ctx))) return true;
    const enable = cmd === "/admin";
    const targetId = extractAtTarget(ctx.message, text) ?? (parts[1] ? parseInt(parts[1], 10) : null);
    if (!targetId || targetId <= 0) {
      await reply(ctx, `用法：${cmd} @用户`);
      return true;
    }
    if (await needConfirm(ctx, cmd, `${groupId}:${targetId}`, `${enable ? "任命" : "撤销"}管理员 ${targetId}`)) return true;
    try {
      client.setGroupAdmin(groupId!, targetId, enable);
      await reply(ctx, `✅ 已${enable ? "任命" : "撤销"} ${targetId} 为群管理员。`);
    } catch (err) {
      await reply(ctx, `❌ ${enable ? "任命" : "撤销"}管理员失败：${fmtError(err)}（需 bot 为群主）`);
    }
    return true;
  }

  // ── /card ─────────────────────────────────────────────────
  if (cmd === "/card") {
    if (!(await requireGroup(ctx))) return true;
    const targetId = extractAtTarget(ctx.message, text);
    if (!targetId) {
      await reply(ctx, "用法：/card @用户 [新名片]（空 = 清除）");
      return true;
    }
    // 找到 @ 之后的剩余文本作为新 card；parts[0]=/card，@ 段不在 parts 里，取 parts[1+] 拼回
    const newCard = parts.slice(1).join(" ").replace(/\[CQ:at,qq=\d+\]\s*/g, "").trim();
    try {
      client.setGroupCard(groupId!, targetId, newCard);
      await reply(ctx, newCard ? `✅ 已将 ${targetId} 的名片改为「${newCard}」` : `✅ 已清除 ${targetId} 的名片`);
    } catch (err) {
      await reply(ctx, `❌ 修改名片失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /title ────────────────────────────────────────────────
  if (cmd === "/title") {
    if (!(await requireGroup(ctx))) return true;
    const targetId = extractAtTarget(ctx.message, text);
    if (!targetId) {
      await reply(ctx, "用法：/title @用户 <头衔>（需 bot 为群主）");
      return true;
    }
    const title = parts.slice(1).join(" ").replace(/\[CQ:at,qq=\d+\]\s*/g, "").trim();
    if (!title) {
      await reply(ctx, "用法：/title @用户 <头衔>");
      return true;
    }
    try {
      client.setGroupSpecialTitle(groupId!, targetId, title);
      await reply(ctx, `✅ 已为 ${targetId} 设置头衔「${title}」`);
    } catch (err) {
      await reply(ctx, `❌ 设置头衔失败：${fmtError(err)}（需 bot 为群主）`);
    }
    return true;
  }

  // ── /shutlist ─────────────────────────────────────────────
  if (cmd === "/shutlist") {
    if (!(await requireGroup(ctx))) return true;
    const list = await client.getGroupShutList(groupId!);
    if (!list || list.length === 0) {
      await reply(ctx, "当前无人被禁言。");
    } else {
      const lines = list.slice(0, 30).map((m: any) => {
        const id = m.user_id ?? m.uid ?? "?";
        const nick = m.nickname ?? m.card ?? "";
        const until = m.shut_up_timestamp ?? m.shutuptime ?? 0;
        const remain = Math.max(0, until * 1000 - Date.now());
        const min = Math.ceil(remain / 60000);
        return `  ${id}${nick ? `（${nick}）` : ""}：剩余 ${min} 分钟`;
      });
      const more = list.length > 30 ? `\n（共 ${list.length} 人，仅显示前 30）` : "";
      await reply(ctx, `当前禁言名单：\n${lines.join("\n")}${more}`);
    }
    return true;
  }

  // ── /banall /unbanall ─────────────────────────────────────
  if (cmd === "/banall" || cmd === "/unbanall") {
    if (!(await requireGroup(ctx))) return true;
    const enable = cmd === "/banall";
    try {
      client.setGroupWholeBan(groupId!, enable);
      await reply(ctx, enable ? "✅ 已开启全员禁言。" : "✅ 已关闭全员禁言。");
    } catch (err) {
      await reply(ctx, `❌ 设置全员禁言失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /setname（二次确认）──────────────────────────────────
  if (cmd === "/setname") {
    if (!(await requireGroup(ctx))) return true;
    const newName = parts.slice(1).join(" ").trim();
    if (!newName) {
      await reply(ctx, "用法：/setname <新群名>");
      return true;
    }
    if (await needConfirm(ctx, "setname", `${groupId}:${newName}`, `修改群名为「${newName}」`)) return true;
    try {
      client.setGroupName(groupId!, newName);
      await reply(ctx, `✅ 已修改群名为「${newName}」`);
    } catch (err) {
      await reply(ctx, `❌ 修改群名失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /setremark（二次确认）─────────────────────────────────
  if (cmd === "/setremark") {
    if (!(await requireGroup(ctx))) return true;
    const remark = parts.slice(1).join(" ").trim();
    if (!remark) {
      await reply(ctx, "用法：/setremark <备注>（备注仅 bot 自己可见）");
      return true;
    }
    if (await needConfirm(ctx, "setremark", `${groupId}`, `设置群备注为「${remark}」`)) return true;
    try {
      await client.setGroupRemark(groupId!, remark);
      await reply(ctx, `✅ 已设置群备注为「${remark}」`);
    } catch (err) {
      await reply(ctx, `❌ 设置群备注失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /setportrait（二次确认 + 必须回复图片）───────────────
  if (cmd === "/setportrait") {
    if (!(await requireGroup(ctx))) return true;
    const file = extractImageFile(ctx.message);
    if (!file) {
      await reply(ctx, "用法：回复一张图片，并发送 /setportrait");
      return true;
    }
    if (await needConfirm(ctx, "setportrait", `${groupId}`, "修改群头像")) return true;
    try {
      await client.setGroupPortrait(groupId!, file);
      await reply(ctx, "✅ 已修改群头像。");
    } catch (err) {
      await reply(ctx, `❌ 修改群头像失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /leave（二次确认，退群）─────────────────────────────
  if (cmd === "/leave") {
    if (!(await requireGroup(ctx))) return true;
    if (await needConfirm(ctx, "leave", `${groupId}`, "bot 退出本群")) return true;
    try {
      client.setGroupLeave(groupId!, false);
      await reply(ctx, "👋 bot 已退出本群。");
    } catch (err) {
      await reply(ctx, `❌ 退群失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /dismiss（二次确认，解散群，群主限定）────────────────
  if (cmd === "/dismiss") {
    if (!(await requireGroup(ctx))) return true;
    if (await needConfirm(ctx, "dismiss", `${groupId}`, "解散本群（不可逆）")) return true;
    try {
      client.setGroupLeave(groupId!, true);
      await reply(ctx, "💥 群已解散。");
    } catch (err) {
      await reply(ctx, `❌ 解散群失败：${fmtError(err)}（需 bot 为群主）`);
    }
    return true;
  }

  // ── /essence /deessence /essencelist ─────────────────────
  if (cmd === "/essence" || cmd === "/deessence") {
    if (!(await requireGroup(ctx))) return true;
    const msgId = resolveMsgId(ctx, parts);
    if (!msgId) {
      await reply(ctx, `用法：回复目标消息并发送 ${cmd}，或 ${cmd} <message_id>`);
      return true;
    }
    try {
      if (cmd === "/essence") await client.setEssenceMsg(msgId);
      else await client.deleteEssenceMsg(msgId);
      await reply(ctx, cmd === "/essence" ? "✅ 已设为精华消息。" : "✅ 已移出精华消息。");
    } catch (err) {
      await reply(ctx, `❌ 操作精华消息失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/essencelist") {
    if (!(await requireGroup(ctx))) return true;
    const list = await client.getEssenceMsgList(groupId!);
    if (!list || list.length === 0) {
      await reply(ctx, "当前群无精华消息。");
    } else {
      const lines = list.slice(0, 10).map((m: any, i: number) => {
        const sender = m.sender_nick ?? m.sender_id ?? "?";
        const content = (m.content ?? "")
          .toString()
          .slice(0, 60)
          .replace(/\n/g, " ");
        return `  ${i + 1}. ${sender}: ${content}`;
      });
      const more = list.length > 10 ? `\n（共 ${list.length} 条精华，仅显示前 10）` : "";
      await reply(ctx, `群精华消息：\n${lines.join("\n")}${more}`);
    }
    return true;
  }

  // ── /honor /atallremain /groupinfo ───────────────────────
  if (cmd === "/honor") {
    if (!(await requireGroup(ctx))) return true;
    const type = parts[1] || "all";
    const info = await client.getGroupHonorInfo(groupId!, type);
    if (!info) { await reply(ctx, "❌ 获取群荣誉失败。"); return true; }
    const fmtTop = (entry: any) => {
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
    await reply(ctx, sections.length ? `群荣誉（${type}）：\n${sections.join("\n")}` : "该类别暂无数据。");
    return true;
  }

  if (cmd === "/atallremain") {
    if (!(await requireGroup(ctx))) return true;
    const info = await client.getGroupAtAllRemain(groupId!);
    if (!info) { await reply(ctx, "❌ 查询失败。"); return true; }
    const can = info.can_at_all ?? false;
    const groupRemain = info.remain_at_all_count_for_group ?? info.group_remain_at_all_count ?? "?";
    const meRemain = info.remain_at_all_count_for_uin ?? info.uin_remain_at_all_count ?? "?";
    await reply(
      ctx,
      `@全体 剩余：\n  本群总计：${groupRemain}\n  你（${userId}）：${meRemain}\n  当前${can ? "可" : "不可"}@全体。`,
    );
    return true;
  }

  if (cmd === "/groupinfo") {
    if (!(await requireGroup(ctx))) return true;
    try {
      const info = await client.getGroupInfo(groupId!);
      if (!info) { await reply(ctx, "❌ 获取群信息失败。"); return true; }
      const memberCount = (info as any).member_count ?? "?";
      const maxMember = (info as any).max_member_count ?? "?";
      const remarkAll: any = await client.getGroupAtAllRemain(groupId!).catch(() => null);
      const atAllRemain = remarkAll ? `${remarkAll.remain_at_all_count_for_group ?? remarkAll.group_remain_at_all_count ?? "?"}` : "?";
      const lines = [
        `📋 群 ${groupId} 详情：`,
        `  群名：${info.group_name ?? "?"}`,
        `  成员：${memberCount}/${maxMember}`,
        `  @全体 剩余：${atAllRemain}`,
      ];
      await reply(ctx, lines.join("\n"));
    } catch (err) {
      await reply(ctx, `❌ 获取群信息失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── 群文件全套 ───────────────────────────────────────────
  if (cmd === "/files") {
    if (!(await requireGroup(ctx))) return true;
    const stack = getCwd(userId!, groupId!);
    const folderId = currentFolderId(stack);
    const rawCount = parts[1] ? parseInt(parts[1], 10) : 20;
    const count = isNaN(rawCount) ? 20 : Math.max(1, Math.min(rawCount, 50));
    const data = folderId === "/"
      ? await client.getGroupRootFiles(groupId!, count)
      : await client.getGroupFilesByFolder(groupId!, folderId, count);
    if (!data) { await reply(ctx, "❌ 列文件失败。"); return true; }
    const folders: any[] = data.folders ?? [];
    const files: any[] = data.files ?? [];
    const pwd = formatCwdPath(stack);
    const fLines = folders.slice(0, count).map((f: any) => `  📁 ${f.folder_name ?? f.name ?? "?"}    [${f.folder_id ?? f.id ?? "?"}]`);
    const lLines = files.slice(0, count).map((f: any) => {
      const size = f.file_size ? `${(f.file_size / 1024).toFixed(1)} KB` : "";
      return `  📄 ${f.file_name ?? f.name ?? "?"}  ${size}  [${f.file_id ?? f.id ?? "?"}]`;
    });
    const body = [...fLines, ...lLines].join("\n") || "  （空目录）";
    await reply(ctx, `📂 当前目录：${pwd}\n${body}\n\n用 /cd <文件夹名> 进入；/cdup 上层；/cd / 回根`);
    return true;
  }

  if (cmd === "/cd") {
    if (!(await requireGroup(ctx))) return true;
    const target = parts.slice(1).join(" ").trim();
    if (!target) {
      await reply(ctx, "用法：/cd <文件夹名> | /cd /（回根）");
      return true;
    }
    if (target === "/") {
      resetCwd(userId!, groupId!);
      await reply(ctx, "📂 已回到根目录。");
      return true;
    }
    // 查当前层所有子目录，按名匹配
    const stack = getCwd(userId!, groupId!);
    const folderId = currentFolderId(stack);
    const data = folderId === "/"
      ? await client.getGroupRootFiles(groupId!)
      : await client.getGroupFilesByFolder(groupId!, folderId);
    const folders: any[] = data?.folders ?? [];
    const match = folders.find((f: any) => (f.folder_name ?? f.name) === target);
    if (!match) {
      await reply(ctx, `❌ 当前目录下未找到子文件夹「${target}」（用 /files 查看可用列表）`);
      return true;
    }
    const entry: FolderStackEntry = { id: String(match.folder_id ?? match.id), name: String(match.folder_name ?? match.name) };
    pushCwd(userId!, groupId!, entry);
    await reply(ctx, `📂 已进入 ${formatCwdPath(getCwd(userId!, groupId!))}`);
    return true;
  }

  if (cmd === "/cdup") {
    if (!(await requireGroup(ctx))) return true;
    const popped = popCwd(userId!, groupId!);
    const pwd = formatCwdPath(getCwd(userId!, groupId!));
    await reply(ctx, popped ? `📂 已离开 ${popped.name}，当前 ${pwd}` : "📂 已在根目录。");
    return true;
  }

  if (cmd === "/pwd") {
    if (!(await requireGroup(ctx))) return true;
    await reply(ctx, `📂 ${formatCwdPath(getCwd(userId!, groupId!))}`);
    return true;
  }

  if (cmd === "/dl") {
    if (!(await requireGroup(ctx))) return true;
    const fileId = parts[1];
    if (!fileId) {
      await reply(ctx, "用法：/dl <file_id>（file_id 从 /files 获取）");
      return true;
    }
    const data = await client.getGroupFileUrl(groupId!, fileId);
    if (!data || !data.url) {
      await reply(ctx, "❌ 获取下载链接失败。");
      return true;
    }
    await reply(ctx, `🔗 下载链接：\n${data.url}`);
    return true;
  }

  if (cmd === "/delfile") {
    if (!(await requireGroup(ctx))) return true;
    const fileId = parts[1];
    if (!fileId) {
      await reply(ctx, "用法：/delfile <file_id>");
      return true;
    }
    try {
      await client.deleteGroupFile(groupId!, fileId);
      await reply(ctx, `✅ 已删除文件 ${fileId}`);
    } catch (err) {
      await reply(ctx, `❌ 删除文件失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/mkdir") {
    if (!(await requireGroup(ctx))) return true;
    const name = parts.slice(1).join(" ").trim();
    if (!name) {
      await reply(ctx, "用法：/mkdir <文件夹名>");
      return true;
    }
    try {
      await client.createGroupFileFolder(groupId!, name);
      await reply(ctx, `✅ 已创建文件夹「${name}」`);
    } catch (err) {
      await reply(ctx, `❌ 创建文件夹失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/rmdir") {
    if (!(await requireGroup(ctx))) return true;
    const folderId = parts[1];
    if (!folderId) {
      await reply(ctx, "用法：/rmdir <folder_id>（从 /files 获取）");
      return true;
    }
    try {
      await client.deleteGroupFolder(groupId!, folderId);
      await reply(ctx, `✅ 已删除文件夹 ${folderId}`);
    } catch (err) {
      await reply(ctx, `❌ 删除文件夹失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/mvfile") {
    if (!(await requireGroup(ctx))) return true;
    const fileId = parts[1];
    const targetDir = parts[2];
    if (!fileId || !targetDir) {
      await reply(ctx, "用法：/mvfile <file_id> <target_folder_id>（target 用 / 表示根目录）");
      return true;
    }
    const curDir = currentFolderId(getCwd(userId!, groupId!));
    try {
      await client.moveGroupFile(groupId!, fileId, curDir, targetDir);
      await reply(ctx, `✅ 已移动文件 ${fileId} → ${targetDir}`);
    } catch (err) {
      await reply(ctx, `❌ 移动文件失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/renamefile") {
    if (!(await requireGroup(ctx))) return true;
    const fileId = parts[1];
    const newName = parts.slice(2).join(" ").trim();
    if (!fileId || !newName) {
      await reply(ctx, "用法：/renamefile <file_id> <新名>");
      return true;
    }
    const curDir = currentFolderId(getCwd(userId!, groupId!));
    try {
      await client.renameGroupFile(groupId!, fileId, curDir, newName);
      await reply(ctx, `✅ 已重命名为「${newName}」`);
    } catch (err) {
      await reply(ctx, `❌ 重命名失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/upload") {
    await reply(
      ctx,
      "ℹ️ 上传群文件请直接拖拽到群里（NapCat 自动同步到群文件）。\n" +
      "如需通过 API 上传，调用 client.uploadGroupFile(groupId, file, name)。",
    );
    return true;
  }

  // ── NapCat 扩展：/poke /sign /todo /donetodo /canceltodo ──
  if (cmd === "/poke") {
    if (!(await requireGroup(ctx))) return true;
    const targetId = extractAtTarget(ctx.message, text) ?? (parts[1] ? parseInt(parts[1], 10) : null);
    if (!targetId) {
      await reply(ctx, "用法：/poke @用户");
      return true;
    }
    try {
      client.sendGroupPoke(groupId!, targetId);
      await reply(ctx, `👉 已戳一戳 ${targetId}`);
    } catch (err) {
      await reply(ctx, `❌ 戳一戳失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/sign") {
    if (!(await requireGroup(ctx))) return true;
    try {
      await client.setGroupSign(groupId!);
      await reply(ctx, "✅ 已群签到。");
    } catch (err) {
      await reply(ctx, `❌ 签到失败：${fmtError(err)}`);
    }
    return true;
  }

  if (cmd === "/todo" || cmd === "/donetodo" || cmd === "/canceltodo") {
    if (!(await requireGroup(ctx))) return true;
    const msgId = resolveMsgId(ctx, parts);
    if (!msgId) {
      await reply(ctx, `用法：回复目标消息并发送 ${cmd}，或 ${cmd} <message_id>`);
      return true;
    }
    try {
      if (cmd === "/todo") await client.setGroupTodo(groupId!, msgId);
      else if (cmd === "/donetodo") await client.completeGroupTodo(groupId!, msgId);
      else await client.cancelGroupTodo(groupId!, msgId);
      const verb = cmd === "/todo" ? "标记为待办" : cmd === "/donetodo" ? "完成" : "取消";
      await reply(ctx, `✅ 已${verb}消息 ${msgId}`);
    } catch (err) {
      await reply(ctx, `❌ 待办操作失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /sendto ──────────────────────────────────────────────
  // 跨会话发送，绕过 OpenClaw 会话树限制
  if (cmd === "/sendto") {
    const target = parts[1];
    const msgText = parts.slice(2).join(" ");
    if (!target || !msgText) {
      await reply(ctx, `用法：/sendto <目标> <消息内容>\n示例：\n  /sendto group:88888888 早上好\n  /sendto 12345678 你好`);
      return true;
    }
    try {
      const { sendProactive } = await import("./proactive.js");
      const result = await sendProactive({ to: target, text: msgText });
      if (result.success) {
        await reply(ctx, `✅ 已发送到 ${target}`);
      } else {
        await reply(ctx, `❌ 发送失败：${result.error}`);
      }
    } catch (err) {
      await reply(ctx, `❌ 发送失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /reload ─────────────────────────────────────────────
  if (cmd === "/reload") {
    if (!ctx.configRef || !ctx.fullCfg) {
      await reply(ctx, "❌ 热更新未启用");
      return true;
    }
    const napcat = ctx.fullCfg.channels?.napcat;
    const result = updateConfigRef(ctx.configRef, napcat);
    if (result.success) {
      let msg = "✅ 配置已重载";
      if (result.connectionChanged) {
        msg += "\n⚠️ 连接参数有变更，需重启容器才能生效";
      }
      await reply(ctx, msg);
    } else {
      await reply(ctx, `❌ 配置验证失败，保留旧配置\n${result.error}`);
    }
    return true;
  }

  // ── /groups ─────────────────────────────────────────────
  if (cmd === "/groups") {
    if (!ctx.refreshGroupRoutes) {
      await reply(ctx, "❌ 群路由刷新未启用");
      return true;
    }
    try {
      const count = await ctx.refreshGroupRoutes();
      await reply(ctx, `✅ 已刷新 ${count} 个群路由，cron 投递现在可用`);
    } catch (err) {
      await reply(ctx, `❌ 刷新失败：${fmtError(err)}`);
    }
    return true;
  }

  // ── /ratelimit ──────────────────────────────────────────
  if (cmd === "/ratelimit") {
    if (!ctx.rateLimiter) {
      await reply(ctx, "❌ 限流器未初始化");
      return true;
    }
    const limits = ctx.rateLimiter.getActiveLimits();
    if (limits.length === 0) {
      await reply(ctx, "✅ 当前无活跃限流");
      return true;
    }
    const lines = limits.map((l) => {
      const remaining = (l.retryAfterMs / 1000).toFixed(1);
      const display = l.target.startsWith("user:") ? `用户 ${l.target.slice(5)}` : `群 ${l.target.slice(6)}`;
      return `  ${display}: 冷却 ${remaining}s (窗口内 ${l.count} 条, 累计阻断 ${l.blockedTotal} 次)`;
    });
    await reply(ctx, `⚠️ 活跃限流 (${limits.length}):\n${lines.join("\n")}`);
    return true;
  }

  // ── /unratelimit ────────────────────────────────────────
  if (cmd === "/unratelimit") {
    if (!ctx.rateLimiter) {
      await reply(ctx, "❌ 限流器未初始化");
      return true;
    }
    const target = parts[1];
    if (!target) {
      await reply(ctx, "用法: /unratelimit <用户QQ号或群号>\n例: /unratelimit 123456789");
      return true;
    }
    const cleared = ctx.rateLimiter.clear(target);
    if (cleared) {
      await reply(ctx, `✅ 已解除 ${target} 的限流`);
    } else {
      await reply(ctx, `ℹ️ ${target} 当前未被限流`);
    }
    return true;
  }

  return false;
}

// ============ /help 文本（按分组）============

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
