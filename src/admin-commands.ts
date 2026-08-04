/**
 * 管理命令主模块
 *
 * Handler 实现保留在本文件内（与注册表紧密耦合）。
 * 共享工具已提取到 admin-commands/shared.ts，
 * 常量提取到 admin-commands/constants.ts。
 * 通过 admin-commands/index.ts barrel 导出。
 */

import type { AdminCmdContext } from "./admin-registry.js";
import { getUpdateInfo } from "./update-checker.js";
import { getRecentLogs, formatLogEntry } from "./log-buffer.js";
import { maskIdsInText, maskSecretsInText } from "./utils/log-sanitize.js";
import { getPackageVersion } from "./utils/pkg-version.js";
import { updateConfigRef, getConfigRef } from "./config-watcher.js";
import { resolvePassiveModeTemperature } from "./config.js";
import { invalidateOtherBotNamesCache } from "./gateway/trigger-state.js";
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
import { CommandRegistry } from "./admin-registry.js";
import { sendProactive } from "./proactive.js";

// ── 提取的共享模块 ────────────────────────────────────────

import {
  extractAtTarget,
  extractAtTargets,
  extractReplyMsgId,
  extractImageFile,
  reply,
  needConfirm,
  fmtError,
  requireGroup,
  resolveMsgId,
  formatUptime,
  getLog,
  withAdminCatch,
} from "./admin-commands/shared.js";

import { CQ_AT_PATTERN } from "./constants.js";

import {
  BAN_DEFAULT_MINUTES,
  MUTE_DEFAULT_MINUTES,
  MUTE_MAX_MINUTES,
  FILES_DEFAULT_COUNT,
  FILES_MAX_COUNT,
  MAX_SHUT_LIST_DISPLAY,
  LOGS_DEFAULT_COUNT,
  LOGS_MAX_COUNT,
  ESSENCE_MAX_DISPLAY,
  CONFIRM_TIMEOUT_SECONDS,
} from "./admin-commands/constants.js";

import { DEFAULT_SLEEP_START_HOUR, DEFAULT_SLEEP_END_HOUR } from "./constants.js";

// 常量 re-export（供 client.ts 等外部模块引用）
export { BAN_DEFAULT_MINUTES, MUTE_DEFAULT_MINUTES };

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
    getLog(ctx.log).warn("[napcat-QQ] Version check failed:", err);
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
  // 日志缓冲区里混有 openclaw 内核与其他插件的输出，除 QQ 号外还必须脱敏凭据，
  // 否则 API key 会被直接发进 QQ 会话。
  return `[最近 ${logs.length} 条日志]\n${maskSecretsInText(maskIdsInText(raw))}`;
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
  return handleMuteBan("用法：/mute @用户 [分钟数]", ctx, parts);
}

export async function handleUnmute(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (targetId && targetId > 0) {
    return withAdminCatch(ctx, async () => {
      ctx.client.setGroupBan(ctx.groupId!, targetId, 0);
    }, `已解除禁言 ${targetId}。`);
  }
  return "用法：/unmute @用户";
}

/**
 * 共享 mute/ban 逻辑（/mute 和 /ban 均指向此函数）。
 * @param usage - 用法提示
 */
export async function handleMuteBan(
  usage: string,
  ctx: AdminCmdContext,
  parts: string[],
): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (targetId && targetId > 0) {
    const rawMin = parts[1] ? parseInt(parts[1], 10) : MUTE_DEFAULT_MINUTES;
    const minutes = isNaN(rawMin) ? MUTE_DEFAULT_MINUTES : Math.max(1, Math.min(rawMin, MUTE_MAX_MINUTES));
    return withAdminCatch(ctx, async () => {
      ctx.client.setGroupBan(ctx.groupId!, targetId, minutes * 60);
    }, `已禁言 ${targetId} ${minutes} 分钟。`);
  }
  return usage;
}

export async function handleKick(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parts[0] ? parseInt(parts[0], 10) : null);
  if (targetId && targetId > 0) {
    return withAdminCatch(ctx, async () => {
      ctx.client.setGroupKick(ctx.groupId!, targetId);
    }, `已踢出 ${targetId}。`);
  }
  return "用法：/kick @用户";
}

export async function handleKickBatch(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targets = extractAtTargets(ctx.message, ctx.text);
  if (targets.length === 0) return "用法：/kickbatch @a @b @c（至少一个 @ 目标）";
  if (await needConfirm(ctx, "kickbatch", `${ctx.groupId}:${targets.join(",")}`, `批量踢出 ${targets.length} 人`))
    return null;
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupKickMembers(ctx.groupId!, targets);
  }, `✅ 已批量踢出 ${targets.length} 人：${targets.join(", ")}`);
}

export async function handleAdmin(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const enable = true;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parseInt(_parts[0], 10) || null);
  if (!targetId || targetId <= 0) return "用法：/admin @用户";
  if (await needConfirm(ctx, "admin", `${ctx.groupId}:${targetId}`, `任命管理员 ${targetId}`)) return null;
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupAdmin(ctx.groupId!, targetId, enable);
  }, `✅ 已任命 ${targetId} 为群管理员。`);
}

export async function handleUnadmin(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const enable = false;
  const targetId = extractAtTarget(ctx.message, ctx.text) ?? (parseInt(_parts[0], 10) || null);
  if (!targetId || targetId <= 0) return "用法：/unadmin @用户";
  if (await needConfirm(ctx, "unadmin", `${ctx.groupId}:${targetId}`, `撤销管理员 ${targetId}`)) return null;
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupAdmin(ctx.groupId!, targetId, enable);
  }, `✅ 已撤销 ${targetId} 的群管理员。`);
}

export async function handleCard(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text);
  if (!targetId) return "用法：/card @用户 [新名片]（空 = 清除）";
  const newCard = parts.join(" ").replace(new RegExp(`${CQ_AT_PATTERN.source}\\s*`, "g"), "").trim();
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupCard(ctx.groupId!, targetId, newCard);
  }, newCard ? `✅ 已将 ${targetId} 的名片改为「${newCard}」` : `✅ 已清除 ${targetId} 的名片`);
}

export async function handleTitle(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const targetId = extractAtTarget(ctx.message, ctx.text);
  if (!targetId) return "用法：/title @用户 <头衔>（需 bot 为群主）";
  const title = parts.join(" ").replace(new RegExp(`${CQ_AT_PATTERN.source}\\s*`, "g"), "").trim();
  if (!title) return "用法：/title @用户 <头衔>";
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupSpecialTitle(ctx.groupId!, targetId, title);
  }, `✅ 已为 ${targetId} 设置头衔「${title}」`);
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
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupWholeBan(ctx.groupId!, true);
  }, "✅ 已开启全员禁言。");
}

export async function handleUnbanAll(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupWholeBan(ctx.groupId!, false);
  }, "✅ 已关闭全员禁言。");
}

export async function handleSetName(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const newName = parts.join(" ").trim();
  if (!newName) return "用法：/setname <新群名>";
  if (await needConfirm(ctx, "setname", `${ctx.groupId}:${newName}`, `修改群名为「${newName}」`)) return null;
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupName(ctx.groupId!, newName);
  }, `✅ 已修改群名为「${newName}」`);
}

export async function handleSetRemark(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const remark = parts.join(" ").trim();
  if (!remark) return "用法：/setremark <备注>（备注仅 bot 自己可见）";
  if (await needConfirm(ctx, "setremark", `${ctx.groupId}`, `设置群备注为「${remark}」`)) return null;
  return withAdminCatch(ctx, async () => {
    await ctx.client.setGroupRemark(ctx.groupId!, remark);
  }, `✅ 已设置群备注为「${remark}」`);
}

export async function handleSetPortrait(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const file = extractImageFile(ctx.message);
  if (!file) return "用法：回复一张图片，并发送 /setportrait";
  if (await needConfirm(ctx, "setportrait", `${ctx.groupId}`, "修改群头像")) return null;
  return withAdminCatch(ctx, async () => {
    await ctx.client.setGroupPortrait(ctx.groupId!, file);
  }, "✅ 已修改群头像。");
}

export async function handleLeave(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  if (await needConfirm(ctx, "leave", `${ctx.groupId}`, "bot 退出本群")) return null;
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupLeave(ctx.groupId!, false);
  }, "👋 bot 已退出本群。");
}

export async function handleDismiss(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  if (await needConfirm(ctx, "dismiss", `${ctx.groupId}`, "解散本群（不可逆）")) return null;
  return withAdminCatch(ctx, async () => {
    ctx.client.setGroupLeave(ctx.groupId!, true);
  }, "💥 群已解散。");
}

export async function handleEssence(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /essence，或 /essence <message_id>`;
  return withAdminCatch(ctx, async () => {
    await ctx.client.setEssenceMsg(msgId);
  }, "✅ 已设为精华消息。");
}

export async function handleDeEssence(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /deessence，或 /deessence <message_id>`;
  return withAdminCatch(ctx, async () => {
    await ctx.client.deleteEssenceMsg(msgId);
  }, "✅ 已移出精华消息。");
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
    const memberCount = (info as Record<string, unknown>).member_count ?? "?";
    const maxMember = (info as Record<string, unknown>).max_member_count ?? "?";
    const atAll = await ctx.client.getGroupAtAllRemain(ctx.groupId!).catch((err) => {
      getLog(ctx.log).warn(`[napcat-QQ] getGroupAtAllRemain failed (group ${ctx.groupId}): ${err instanceof Error ? err.message : err}`);
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
      ctx.log?.warn?.("[admin-command]", err);
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
  return withAdminCatch(ctx, async () => {
    await ctx.client.deleteGroupFile(ctx.groupId!, fileId);
  }, `✅ 已删除文件 ${fileId}`);
}

export async function handleMkdir(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const name = parts.join(" ").trim();
  if (!name) return "用法：/mkdir <文件夹名>";
  return withAdminCatch(ctx, async () => {
    await ctx.client.createGroupFileFolder(ctx.groupId!, name);
  }, `✅ 已创建文件夹「${name}」`);
}

export async function handleRmdir(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const folderId = parts[0];
  if (!folderId) return "用法：/rmdir <folder_id>（从 /files 获取）";
  return withAdminCatch(ctx, async () => {
    await ctx.client.deleteGroupFolder(ctx.groupId!, folderId);
  }, `✅ 已删除文件夹 ${folderId}`);
}

export async function handleMvFile(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const fileId = parts[0];
  const targetDir = parts[1];
  if (!fileId || !targetDir) return "用法：/mvfile <file_id> <target_folder_id>（target 用 / 表示根目录）";
  const curDir = currentFolderId(getCwd(ctx.userId!, ctx.groupId!));
  return withAdminCatch(ctx, async () => {
    await ctx.client.moveGroupFile(ctx.groupId!, fileId, curDir, targetDir);
  }, `✅ 已移动文件 ${fileId} → ${targetDir}`);
}

export async function handleRenameFile(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const fileId = parts[0];
  const newName = parts.slice(1).join(" ").trim();
  if (!fileId || !newName) return "用法：/renamefile <file_id> <新名>";
  const curDir = currentFolderId(getCwd(ctx.userId!, ctx.groupId!));
  return withAdminCatch(ctx, async () => {
    await ctx.client.renameGroupFile(ctx.groupId!, fileId, curDir, newName);
  }, `✅ 已重命名为「${newName}」`);
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
  return withAdminCatch(ctx, async () => {
    ctx.client.sendGroupPoke(ctx.groupId!, targetId);
  }, `👉 已戳一戳 ${targetId}`);
}

export async function handleSign(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  return withAdminCatch(ctx, async () => {
    await ctx.client.setGroupSign(ctx.groupId!);
  }, "✅ 已群签到。");
}

export async function handleTodo(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /todo，或 /todo <message_id>`;
  return withAdminCatch(ctx, async () => {
    await ctx.client.setGroupTodo(ctx.groupId!, msgId);
  }, `✅ 已标记消息 ${msgId} 为待办`);
}

export async function handleDoneTodo(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /donetodo，或 /donetodo <message_id>`;
  return withAdminCatch(ctx, async () => {
    await ctx.client.completeGroupTodo(ctx.groupId!, msgId);
  }, `✅ 已完成消息 ${msgId}`);
}

export async function handleCancelTodo(ctx: AdminCmdContext, parts: string[]): Promise<string | null> {
  if (!(await requireGroup(ctx))) return null;
  const msgId = resolveMsgId(ctx, parts);
  if (!msgId) return `用法：回复目标消息并发送 /canceltodo，或 /canceltodo <message_id>`;
  return withAdminCatch(ctx, async () => {
    await ctx.client.cancelGroupTodo(ctx.groupId!, msgId);
  }, `✅ 已取消消息 ${msgId} 的待办`);
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
  return withAdminCatch(ctx, async () => {
    const result = await sendProactive({ to: target, text: msgText });
    if (!result.success) throw new Error(result.error);
  }, `✅ 已发送到 ${target}`);
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
    getLog(ctx.log).warn?.("[admin-command]", err);
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

export async function handleSleep(ctx: AdminCmdContext, _parts: string[]): Promise<string | null> {
  const configRef = getConfigRef();
  if (!configRef) return "❌ 配置引用未初始化（需要重启后生效）";
  const raw = ctx.text.trim();
  const cmd = raw.startsWith("sleep ") ? raw.slice(6).trim() : raw === "sleep" ? "" : raw;

  // 无参数 → 显示当前状态
  if (!cmd) {
    const sm = configRef.current.sleepMode;
    if (sm?.enabled) {
      const s = sm.startHour ?? DEFAULT_SLEEP_START_HOUR;
      const e = sm.endHour ?? DEFAULT_SLEEP_END_HOUR;
      return `🌙 休眠模式: 开启\n时段: ${s}:00 - ${e}:00\n用法: /sleep off | /sleep on | /sleep <时段描述>`;
    }
    return `🌙 休眠模式: 关闭\n用法: /sleep on | /sleep off | /sleep <时段描述>`;
  }

  // 显式开关
  if (cmd === "on" || cmd === "off") {
    const current = configRef.current;
    const sm = current.sleepMode ?? {};
    const updated = { ...current, sleepMode: { ...sm, enabled: cmd === "on" } };
    const result = updateConfigRef(configRef, updated);
    if (!result.success) return `❌ 设置失败: ${result.error}`;
    if (cmd === "on") {
      const s = sm.startHour ?? DEFAULT_SLEEP_START_HOUR;
      const e = sm.endHour ?? DEFAULT_SLEEP_END_HOUR;
      return `✅ 休眠模式已开启\n时段: ${s}:00 - ${e}:00\n（仅 @mention 和关键词触发有效，其他全部静默）`;
    }
    return "✅ 休眠模式已关闭";
  }

  // 自然语言解析时段
  const parsed = parseSleepTime(cmd);
  if (!parsed) {
    return `❌ 无法识别时段描述\n支持格式：\n  /sleep on|off\n  /sleep 23 7\n  /sleep 晚上11点到早上7点\n  /sleep 每晚十一点到早上七点\n  /sleep 23:00-07:00`;
  }

  const { start, end, display } = parsed;
  if (start === end) {
    return `❌ 时段无效：开始和结束小时相同（${start}:00），休眠窗口为 0 长度。请设置不同的起止时间。`;
  }
  const current = configRef.current;
  const sm = current.sleepMode ?? {};
  const updated = { ...current, sleepMode: { ...sm, enabled: true, startHour: start, endHour: end } };
  const result = updateConfigRef(configRef, updated);
  if (!result.success) return `❌ 设置失败: ${result.error}`;
  const isCrossMidnight = start > end;
  return `✅ 休眠模式已开启\n时段: ${display}${isCrossMidnight ? "（跨午夜）" : ""}\n（仅 @mention 和关键词触发有效）`;
}

// ── 自然语言时间解析 ────────────────────────────────────────────────────────

/** 时间词 → 12h 基数。PM 词返回 12（需加偏移），AM 词返回 0 */
const TIME_WORD_BASE: Record<string, number> = {
  "凌晨": 0, "早上": 0, "上午": 0,
  "中午": 12, "下午": 12, "晚上": 12, "晚": 12,
};

/**
 * 根据时间词将 12h 制小时转为 24h 制。
 * 中文约定：12点（无论 AM/PM）= 0:00（午夜），其余 AM 直接使用，PM 加 12。
 */
function resolveHourByTimeWord(hour: number, timeWord: string): number {
  const base = TIME_WORD_BASE[timeWord];
  if (base === undefined) return hour; // 无时间词，保持原值
  // 12 点无论 AM/PM 都是午夜 0:00
  if (hour === 12) return 0;
  // AM：直接使用；PM：加 12
  return base === 0 ? hour : hour + 12;
}

/** 从文本中提取单个小时数，支持中文数字和阿拉伯数字 */
function extractHour(text: string): number | null {
  // 先尝试中文数字（长词优先，避免 "十" 先于 "十一" 匹配）
  const cnMap: Record<string, number> = {
    "十一": 11, "十二": 12, "十": 10, "九": 9, "八": 8, "七": 7,
    "六": 6, "五": 5, "四": 4, "三": 3, "二": 2, "两": 2, "一": 1, "零": 0,
  };
  for (const [cn, val] of Object.entries(cnMap)) {
    if (text.includes(cn)) return val;
  }
  // 再尝试阿拉伯数字
  const numMatch = text.match(/\b(\d{1,2})\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 0 && n <= 23) return n;
  }
  return null;
}

/**
 * 解析休眠时段描述。
 * 返回 { start, end, display } 或 null。
 *
 * 支持的格式：
 *   - "23:00-07:00" / "23:00到07:00"
 *   - "23 7" / "23到7" / "23-7"
 *   - "晚上11点到早上7点" / "每晚十一点到早上七点"
 */
function parseSleepTime(cmd: string): { start: number; end: number; display: string } | null {
  const text = cmd.trim();

  // 格式1: 23:00-07:00 或 23:00到07:00
  const directMatch = text.match(/(\d{1,2}):(\d{2})\s*[到\-—~至]\s*(\d{1,2}):(\d{2})/);
  if (directMatch) {
    const s = parseInt(directMatch[1], 10);
    const e = parseInt(directMatch[3], 10);
    if (s >= 0 && s <= 23 && e >= 0 && e <= 23) {
      // ⚠️ 分钟字段当前 schema 不支持，静默丢弃并提示用户
      const minS = directMatch[2];
      const minE = directMatch[4];
      if (minS !== "00" || minE !== "00") {
        return { start: s, end: e, display: `${s}:00 - ${e}:00 (注: 分钟暂不支持，已取整到整点)` };
      }
      return { start: s, end: e, display: `${s}:00 - ${e}:00` };
    }
  }

  // 格式2: 23 7（空格分隔）或 23到7 或 23-7
  const spaceMatch = text.match(/^(\d{1,2})\s+(\d{1,2})$/);
  if (spaceMatch && !text.match(/[点时分]/)) {
    const s = parseInt(spaceMatch[1], 10);
    const e = parseInt(spaceMatch[2], 10);
    if (s >= 0 && s <= 23 && e >= 0 && e <= 23) {
      return { start: s, end: e, display: `${s}:00 - ${e}:00` };
    }
  }
  const simpleMatch = text.match(/(\d{1,2})\s*[到\-—~至]\s*(\d{1,2})/);
  if (simpleMatch && !text.match(/[点时分]/)) {
    const s = parseInt(simpleMatch[1], 10);
    const e = parseInt(simpleMatch[2], 10);
    if (s >= 0 && s <= 23 && e >= 0 && e <= 23) {
      return { start: s, end: e, display: `${s}:00 - ${e}:00` };
    }
  }

  // 格式3: 带时间词的描述，如"晚上11点到早上7点"
  // 拆分为左右两半
  const separatorMatch = text.match(/(.+?)[到\-—~至](.+)/);
  if (separatorMatch) {
    const left = separatorMatch[1];
    const right = separatorMatch[2];

    // 解析左侧（开始时间）
    const leftHour = extractHour(left);
    // 解析右侧（结束时间）
    const rightHour = extractHour(right);

    if (leftHour !== null && rightHour !== null) {
      let start = leftHour;
      let end = rightHour;

      // 左侧时间词调整
      const leftWord = Object.keys(TIME_WORD_BASE).find(w => left.includes(w));
      if (leftWord) {
        start = resolveHourByTimeWord(leftHour, leftWord);
      }

      // 右侧时间词调整
      const rightWord = Object.keys(TIME_WORD_BASE).find(w => right.includes(w));
      if (rightWord) {
        end = resolveHourByTimeWord(rightHour, rightWord);
      }

      // 边界检查
      if (start >= 0 && start <= 23 && end >= 0 && end <= 23) {
        const display = `${start}:00 - ${end}:00`;
        return { start, end, display };
      }
    }
  }

  return null;
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
  `  /temperature [N]     调整被动模式温度（0-100，无参查看当前值）\n` +
  `  /sleep [on|off|描述]  休眠模式（on/off 切换，或自然语言设时段）\n` +
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

/** 全局管理命令注册表 */
export const adminCommandRegistry = new CommandRegistry();

adminCommandRegistry.register("ping", "测量延迟", handlePing);
adminCommandRegistry.register("version", "查看版本", handleVersion);
adminCommandRegistry.register("logs", "最近日志", handleLogs);
adminCommandRegistry.register("status", "查看状态", handleStatus);
adminCommandRegistry.register("help", "帮助", handleHelp);

adminCommandRegistry.register("mute", "禁言", handleMute);
adminCommandRegistry.register("ban", "禁言", handleMute); // ban 是 mute 的别名
adminCommandRegistry.register("unmute", "解除禁言", handleUnmute);
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
adminCommandRegistry.register("sleep", "休眠模式", handleSleep);

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

/** 在已注册命令中查找唯一前缀匹配；候选不唯一时返回 null 避免歧义 */
function findCommand(input: string): string | null {
  const names = adminCommandRegistry.getCommandNames();
  if (names.includes(input)) return input;
  const candidates = names.filter(n => n.startsWith(input) && input.length >= 3);
  return candidates.length === 1 ? candidates[0] : null;
}

// 重新导出类型，保持向后兼容
export type { AdminCmdContext } from "./admin-registry.js";
