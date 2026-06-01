/**
 * Bot 签名工具
 *
 * send-text.ts 和 message-sender.ts 共用的签名追加逻辑，
 * 支持 visible / zero-width 两种样式。
 */

import { makeZeroWidthSignature } from "../constants.js";

export type BotSignatureStyle = "visible" | "zero-width";

/**
 * 追加 bot 签名到文本末尾。
 *
 * - text 为空时不追加
 * - botSelfId 缺失时不追加
 * - 私聊由调用方在传入前判断 isGroup（函数本身不强制）
 */
export function appendBotSignature(
  text: string,
  botSelfId: number | string | null | undefined,
  style: BotSignatureStyle,
): string {
  if (!text) return text;
  if (botSelfId === null || botSelfId === undefined) return text;
  const sig = style === "zero-width"
    ? makeZeroWidthSignature(botSelfId)
    : `[BOT:${botSelfId}]`;
  return text + sig;
}
