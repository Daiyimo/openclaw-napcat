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

/**
 * 发送纯文本消息到指定目标。
 * 处理旁观模式 [SILENT]、跨会话 [TO:] 前缀、裸数字群号探测。
 */
export async function sendText(
  params: SendTextParams,
  deps: SendTextDeps,
): Promise<{ channel: "napcat"; sent: boolean; error?: string }> {
  let to = params.to ?? "";
  const { text, replyToId } = params;
  const { getClient, knownGroupIds, passiveMode, log } = deps;

  if (!to || to === "heartbeat") {
    if (!to) {
      (log ?? console).warn(
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
      (log ?? console).warn(
        `[napcat-QQ][outbound.sendText] incomplete target "${to}", ` +
        `fallback to known group ${fallbackId}`,
      );
      to = fallbackId;
    } else {
      (log ?? console).error(
        `[napcat-QQ][outbound.sendText] cannot resolve incomplete target "${to}" — ` +
        `no known groups. Message dropped.`,
      );
      return { channel: "napcat", sent: false, error: `Cannot resolve "${to}": no group ID and no known groups` };
    }
  }

  // ── 旁观模式 [SILENT] / NO_REPLY 拦截 ──────────────────────
  const resolvedAccountId = params.accountId || DEFAULT_ACCOUNT_ID;
  const cooldownKey = `${resolvedAccountId}:${to}`;
  const trimmed = text?.trim() ?? "";
  if (/^\[SILENT\]$/i.test(trimmed) || /^NO[_\s]?REPLY[.!?。！,，;；…]*$/i.test(trimmed)) {
    (log ?? console).log(`[napcat-QQ][passive] AI 选择静默 (to=${to})`);
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
      (log ?? console).log(`[napcat-QQ][cross-session] ${result.success ? "✅" : "❌"} to=${crossTarget}`);
      return { channel: "napcat", sent: result.success, error: result.error };
    }
  }

  (log ?? console).log(
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
    let effectiveTo = to;
    if (/^\d+$/.test(to)) {
      if (knownGroupIds.has(to)) {
        effectiveTo = `group:${to}`;
        (log ?? console).log(
          `[napcat-QQ][outbound.sendText] 裸数字 ${to} 识别为群聊（已知列表） → ${effectiveTo}`,
        );
      } else {
        const groupInfo = await client.getGroupInfo(to);
        if (groupInfo?.group_id) {
          knownGroupIds.add(to);
          effectiveTo = `group:${to}`;
          (log ?? console).log(
            `[napcat-QQ][outbound.sendText] 裸数字 ${to} 经 API 确认为群聊 → ${effectiveTo}`,
          );
        } else {
          (log ?? console).warn(
            `[napcat-QQ][outbound.sendText] 裸数字 "${to}" 无法确认为群，按默认路由到群聊。` +
              `如需私聊请使用 "private:${to}" 格式。`,
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
      if (chunks.length > 1 && i < chunks.length - 1) await sleep(OUTBOUND_MULTI_CHUNK_SLEEP_MS);
    }
    return { channel: "napcat", sent: true };
  } catch (err) {
    (log ?? console).error("[napcat-QQ][outbound.sendText] FAILED:", err);
    return { channel: "napcat", sent: false, error: String(err) };
  }
}
