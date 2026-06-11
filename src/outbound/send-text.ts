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
import {
  parseTarget,
  splitMessage,
  dispatchMessage,
} from "../message-parser.js";
import { OUTBOUND_MULTI_CHUNK_SLEEP_MS, DEFAULT_BOT_SIGNATURE_STYLE } from "../constants.js";
import { maskIdsInText } from "../utils/log-sanitize.js";
import { appendBotSignature } from "../utils/bot-signature.js";

import { sleep } from "../utils/sleep.js";

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
}

export interface SendTextDeps {
  getClient: (accountId: string) => OneBotClient | undefined;
  knownGroupIds: Set<string>;
  passiveMode: PassiveModeManager;
}

/**
 * 发送纯文本消息到指定目标。
 * 处理旁观模式 [SILENT]、跨会话 [TO:] 前缀、裸数字群号探测。
 */
export async function sendText(
  params: SendTextParams,
  deps: SendTextDeps,
): Promise<{ channel: "napcat"; sent: boolean; error?: string }> {
  const { to, text, replyToId } = params;
  const { getClient, knownGroupIds, passiveMode } = deps;

  if (!to || to === "heartbeat") return { channel: "napcat", sent: true };

  // ── 旁观模式 [SILENT] / NO_REPLY 拦截 ──────────────────────
  const resolvedAccountId = params.accountId || DEFAULT_ACCOUNT_ID;
  const cooldownKey = `${resolvedAccountId}:${to}`;
  const trimmed = text?.trim() ?? "";
  // 支持多种静默标记格式：[SILENT]、NO_REPLY、no reply、No Reply 等
  // 允许前后有标点（英文 + 中文）: "NO_REPLY.", "NO_REPLY!", "NO_REPLY。", "NO_REPLY，", "NO_REPLY；"
  if (/^\[SILENT\]$/i.test(trimmed) || /^NO[_\s]?REPLY[.!?。!！,，;；…]*$/i.test(trimmed)) {
    console.log(`[napcat-QQ][passive] AI 选择静默 (to=${to})`);
    passiveMode.markSilent(cooldownKey);
    return { channel: "napcat", sent: true };
  }
  // 旁观路径有实质回复：更新冷却时间戳
  passiveMode.markDone(cooldownKey);

  // ── 跨会话投递：[TO:目标] 前缀 ──────────────────────────
  const crossMatch = /^\[TO:([^\]]+)\]([\s\S]*)$/is.exec(text?.trim() ?? "");
  if (crossMatch) {
    const crossTarget = crossMatch[1].trim();
    const crossMsg = crossMatch[2].trim();
    if (crossMsg) {
      const { sendProactive } = await import("../proactive.js");
      const result = await sendProactive({ to: crossTarget, text: crossMsg, accountId: resolvedAccountId });
      console.log(`[napcat-QQ][cross-session] ${result.success ? "✅" : "❌"} to=${crossTarget}`);
      return { channel: "napcat", sent: result.success, error: result.error };
    }
  }

  console.log(
    `[napcat-QQ][outbound.sendText] called: to=${to}, accountId=${params.accountId}, text=${maskIdsInText(text?.slice(0, 100) || "")}`,
  );

  // ── 追加友军签名（仅群消息） ─────────────────────────────────
  // 根据配置选择签名格式：
  // - visible:   [BOT:selfId] 格式，可靠但用户可见
  // - zero-width:零宽字符格式，用户不可见，但可能被平台剥离
  // - none:      不追加（仅靠 sender.bot / knownBotIds / 持久化 cache）
  // v1.9.4: 签名优先用 bot 昵称(更可读),UID 兜底
  const isGroup = /^\d+$/.test(to) || to.startsWith("group:");
  const style = params.cfg?.botSignatureStyle ?? DEFAULT_BOT_SIGNATURE_STYLE;
  const finalText = isGroup && (params.botSelfId || params.botSelfName)
    ? appendBotSignature(text, params.botSelfName ?? null, params.botSelfId, style)
    : text;
  const client = getClient(resolvedAccountId);
  if (!client) return { channel: "napcat", sent: false, error: "Client not connected" };

  // v1.9.2 移除 metadata 模式:发文本前补握手 json 段会变成可见卡片消息 = spam

  try {
    // 裸数字 to 处理
    let effectiveTo = to;
    if (/^\d+$/.test(to)) {
      if (knownGroupIds.has(to)) {
        effectiveTo = `group:${to}`;
        console.log(
          `[napcat-QQ][outbound.sendText] 裸数字 ${to} 识别为群聊（已知列表） → ${effectiveTo}`,
        );
      } else {
        const groupInfo = await client.getGroupInfo(to);
        if (groupInfo?.group_id) {
          knownGroupIds.add(to);
          effectiveTo = `group:${to}`;
          console.log(
            `[napcat-QQ][outbound.sendText] 裸数字 ${to} 经 API 确认为群聊 → ${effectiveTo}`,
          );
        } else {
          console.warn(
            `[napcat-QQ][outbound.sendText] 裸数字 "${to}" 无法确认为群，将作私聊处理。` +
              `如需指定群请使用 "group:${to}" 格式。`,
          );
        }
      }
    }

    const target = parseTarget(effectiveTo);
    const chunks = splitMessage(finalText, 4000);
    for (let i = 0; i < chunks.length; i++) {
      let message: OneBotMessage | string = chunks[i];
      if (replyToId && i === 0)
        message = [
          { type: "reply", data: { id: String(replyToId) } },
          { type: "text", data: { text: chunks[i] } },
        ];
      await dispatchMessage(client, target, message);
      // 仅在非最后一个 chunk 时 sleep，避免末尾无意义等待
      if (chunks.length > 1 && i < chunks.length - 1) await sleep(OUTBOUND_MULTI_CHUNK_SLEEP_MS);
    }
    return { channel: "napcat", sent: true };
  } catch (err) {
    console.error("[napcat-QQ][outbound.sendText] FAILED:", err);
    return { channel: "napcat", sent: false, error: String(err) };
  }
}
