/**
 * Outbound 文本发送
 *
 * 处理 outbound.sendText：旁观 [SILENT] 拦截、跨会话投递、
 * 裸数字群号探测、分片发送。
 * 从 channel.ts 中提取，行为不变。
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";
import type { PassiveModeManager } from "../passive-mode.js";
import type { QQConfig } from "../config.js";
import type { Logger } from "../types/channel-types.js";
import {
  parseTarget,
  splitMessage,
  dispatchMessage,
} from "../message-parser.js";
import { OUTBOUND_MULTI_CHUNK_SLEEP_MS, DEFAULT_BOT_SIGNATURE_STYLE } from "../constants.js";
import { maskIdsInText } from "../utils/log-sanitize.js";
import { appendBotSignature } from "../utils/bot-signature.js";
import { sleep } from "../utils/sleep.js";
import { sendProactive } from "../proactive.js";
import { sendMergedForward } from "./send-merged-forward.js";
import { markStopped } from "../dialog-state.js";
import { isSilentToken, getLog } from "../admin-commands/shared.js";

export interface SendTextParams {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  cfg?: QQConfig;
  /** 本 bot 的 QQ 号(兜底) */
  botSelfId?: number | string;
  /** 本 bot 的昵称(优先),由 connection.ts 启动时 getLoginInfo().nickname 注入 */
  botSelfName?: string;
  // TODO(3.31+): ChannelOutboundContext 新增字段（audioAsVoice, mediaAccess, mediaLocalRoots,
  // mediaReadFile, gifPlayback, forceDocument, replyToIdSource, replyToMode, formatting）。
  // 当前 napcat 未使用，后续按需接入。
}

export interface SendTextDeps {
  getClient: (accountId: string) => OneBotClient | undefined;
  knownGroupIds: Set<string>;
  passiveMode: PassiveModeManager;
  log?: Logger;
}

// ============ 共享：裸数字目标解析 ============

/**
 * 将裸数字 to 解析为带前缀的目标字符串。
 * 逻辑：已知群列表命中 → group:xxx；否则 API 确认 → group:xxx；否则保持原样（由 parseTarget 按默认路由）。
 *
 * @param to - 原始目标字符串
 * @param knownGroupIds - 已知群号集合（API 确认后会 add）
 * @param getGroupInfo - 延迟注入的群信息查询函数
 * @param log - 可选日志器
 * @returns 解析后的目标字符串
 */
export async function resolveBareGroupTarget(
  to: string,
  knownGroupIds: Set<string>,
  getGroupInfo: (id: string) => Promise<{ group_id?: number } | null>,
  log?: Logger,
): Promise<string> {
  if (!/^\d+$/.test(to)) return to;
  if (knownGroupIds.has(to)) {
    log?.log?.(`[napcat-QQ] 裸数字 ${to} 识别为群聊（已知列表） → group:${to}`);
    return `group:${to}`;
  }
  const info = await getGroupInfo(to);
  if (info?.group_id) {
    knownGroupIds.add(to);
    log?.log?.(`[napcat-QQ] 裸数字 ${to} 经 API 确认为群聊 → group:${to}`);
    return `group:${to}`;
  }
  log?.warn?.(`[napcat-QQ] 裸数字 "${to}" 无法确认为群，按默认路由到群聊。如需私聊请使用 "private:${to}" 格式。`);
  return to;
}

/**
 * 发送纯文本消息到指定目标。
 * 处理旁观模式 [SILENT]、跨会话 [TO:] 前缀、裸数字群号探测。
 */
export async function sendText(
  params: SendTextParams,
  deps: SendTextDeps,
): Promise<{ channel: "napcat"; sent: boolean; messageId?: string; error?: string }> {
  let to = params.to ?? "";
  const { text, replyToId } = params;
  const { getClient, knownGroupIds, passiveMode, log } = deps;

  if (!to || to === "heartbeat") {
    if (!to) {
      getLog(log).warn(
        `[napcat-QQ][outbound.sendText] received empty target, params keys: ${Object.keys(params).join(",")}`,
      );
    }
    return { channel: "napcat", sent: true };
  }

  // ── 防御性归一化：处理不完整的 to 值 ──────────────────────
  // cron agent 可能只传 "group" 或 "channel" 不带 ID
  if (to === "group" || to === "channel") {
    const fallbackId = [...knownGroupIds].sort((a, b) => Number(a) - Number(b))[0];
    if (fallbackId) {
      getLog(log).warn(
        `[napcat-QQ][outbound.sendText] incomplete target "${to}", ` +
        `fallback to known group ${fallbackId}`,
      );
      to = fallbackId;
    } else {
      getLog(log).error(
        `[napcat-QQ][outbound.sendText] cannot resolve incomplete target "${to}" — ` +
        `no known groups. Message dropped.`,
      );
      return { channel: "napcat", sent: false, error: `Cannot resolve "${to}": no group ID and no known groups` };
    }
  }

  // ── 旁观模式 [SILENT] / NO_REPLY / [END_DIALOG] 拦截 ─────────────────
  const resolvedAccountId = params.accountId || DEFAULT_ACCOUNT_ID;
  const cooldownKey = `${resolvedAccountId}:${to}`;
  const trimmed = text?.trim() ?? "";
  if (isSilentToken(trimmed)) {
    if (trimmed === "[END_DIALOG]" && to) {
      markStopped(resolvedAccountId, to);
    }
    getLog(log).log(`[napcat-QQ][passive] AI 选择静默 (to=${to})`);
    passiveMode.markSilent(cooldownKey);
    return { channel: "napcat", sent: true };
  }
  passiveMode.markDone(cooldownKey);

  // ── 跨会话投递：[TO:目标] 前缀 ──────────────────────────
  const crossMatch = /^\[TO:([^\]]+)\]([\s\S]*)$/is.exec(text?.trim() ?? "");
  if (crossMatch) {
    const crossTarget = crossMatch[1].trim();
    const crossMsg = crossMatch[2].trim();
    if (crossMsg) {
      const result = await sendProactive({ to: crossTarget, text: crossMsg, accountId: resolvedAccountId });
      getLog(log).log(`[napcat-QQ][cross-session] ${result.success ? "✅" : "❌"} to=${crossTarget}`);
      return { channel: "napcat", sent: result.success, error: result.error };
    }
  }

  getLog(log).log(
    `[napcat-QQ][outbound.sendText] called: to=${to}, accountId=${params.accountId ?? "default"}, text=${maskIdsInText(text?.slice(0, 100) || "")}`,
  );

  // ── 追加友军签名（仅群消息） ─────────────────────────────────
  const isGroup = /^\d+$/.test(to) || to.startsWith("group:");
  const style = params.cfg?.botSignatureStyle ?? DEFAULT_BOT_SIGNATURE_STYLE;
  const finalText = isGroup && (params.botSelfId || params.botSelfName)
    ? appendBotSignature(text, params.botSelfName ?? null, params.botSelfId, style)
    : text;
  const client = getClient(resolvedAccountId);
  if (!client) return { channel: "napcat", sent: false, error: "Client not connected" };

  try {
    // 裸数字 to 处理
    const effectiveTo = await resolveBareGroupTarget(
      to,
      knownGroupIds,
      async (id) => client.getGroupInfo(id),
      log,
    );

    const target = parseTarget(effectiveTo);

    // ── 合并转发前置检查 ─────────────────────────────────────
    // 仅群消息 + 超阈值时先尝试合并转发，失败自动降级普通分片
    const forwardThreshold = params.cfg?.forwardThreshold ?? 2000;
    if (target.type === "group" && forwardThreshold > 0 && finalText.length >= forwardThreshold) {
      getLog(log).log(
        `[napcat-QQ][merged-forward] text length ${finalText.length} >= threshold ${forwardThreshold}, attempting merged forward`,
      );
      const sent = await sendMergedForward({
        client,
        groupId: target.groupId!,
        texts: [finalText],
        nodeName: params.cfg?.forwardNodeName ?? "OpenClaw",
        nodeUin: String(client.getSelfId() ?? params.botSelfId ?? ""),
        nodeCharLimit: params.cfg?.forwardNodeCharLimit ?? 0,
      });
      if (sent) {
        getLog(log).log(`[napcat-QQ][merged-forward] delivered successfully (${finalText.length} chars)`);
        return { channel: "napcat", sent: true };
      }
      getLog(log).warn("[napcat-QQ][merged-forward] failed, falling back to plain chunks");
    }

    // ── 普通分片发送 ─────────────────────────────────────────
    const chunks = splitMessage(finalText, params.cfg?.maxMessageLength ?? 4000);
    let lastMessageId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      let message: OneBotMessage | string = chunks[i];
      if (replyToId && i === 0)
        message = [
          { type: "reply", data: { id: String(replyToId) } },
          { type: "text", data: { text: chunks[i] } },
        ];
      lastMessageId = await dispatchMessage(client, target, message);
      if (chunks.length > 1 && i < chunks.length - 1) await sleep(OUTBOUND_MULTI_CHUNK_SLEEP_MS);
    }
    return { channel: "napcat", sent: true, messageId: lastMessageId };
  } catch (err) {
    getLog(log).error("[napcat-QQ][outbound.sendText] FAILED:", err);
    return { channel: "napcat", sent: false, error: String(err) };
  }
}
