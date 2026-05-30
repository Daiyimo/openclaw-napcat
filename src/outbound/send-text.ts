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
import {
  parseTarget,
  splitMessage,
  dispatchMessage,
} from "../message-parser.js";
import { OUTBOUND_MULTI_CHUNK_SLEEP_MS } from "../constants.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface SendTextParams {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  cfg?: any;
  /** 本 bot 的 QQ 号，用于生成友军签名 [BOT:${selfId}] */
  botSelfId?: number | string;
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
  if (/^\[SILENT\]$/i.test(trimmed) || /^NO_REPLY$/i.test(trimmed)) {
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
    `[napcat-QQ][outbound.sendText] called: to=${to}, accountId=${params.accountId}, text=${text?.slice(0, 100)}`,
  );

  // ── 追加友军签名（仅群消息） ─────────────────────────────────
  // 签名格式 [BOT:${selfId}]，带自身 QQ 号，接收方通过正则提取 bot ID。
  // 相比零宽字符，此格式不会被传输层 stripping。
  const isGroup = /^\d+$/.test(to) || to.startsWith("group:");
  const botSig = params.botSelfId ? `[BOT:${params.botSelfId}]` : "";
  const effectiveText = botSig && isGroup ? text + botSig : text;
  const client = getClient(resolvedAccountId);
  if (!client) return { channel: "napcat", sent: false, error: "Client not connected" };

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
    const chunks = splitMessage(effectiveText, 4000);
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
