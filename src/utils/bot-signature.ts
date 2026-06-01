/**
 * Bot 签名工具
 *
 * send-text.ts 和 message-sender.ts 共用的签名追加逻辑,
 * 支持 visible / zero-width / none / metadata 四种样式。
 *
 * - visible:    在文本末尾追加 [BOT:selfId],用户可见,可靠
 * - zero-width: 在文本末尾追加零宽字符签名,用户不可见,可能被平台剥
 * - none:       不追加任何文本签名(仅靠 sender.bot / knownBotIds / known-bots 缓存)
 * - metadata:   不追加文本签名(同 none),但调用方需另行发送握手段(plan A)
 */

import { makeZeroWidthSignature } from "../constants.js";

export type BotSignatureStyle = "none" | "visible" | "zero-width" | "metadata";

/**
 * 追加 bot 签名到文本末尾。
 *
 * - text 为空时不追加
 * - botSelfId 缺失时不追加
 * - style === "none" 或 "metadata" 时返回原 text(由调用方负责发送握手)
 * - 私聊由调用方在传入前判断 isGroup(函数本身不强制)
 */
export function appendBotSignature(
  text: string,
  botSelfId: number | string | null | undefined,
  style: BotSignatureStyle,
): string {
  if (!text) return text;
  if (botSelfId === null || botSelfId === undefined) return text;
  if (style === "none" || style === "metadata") return text;
  const sig = style === "zero-width"
    ? makeZeroWidthSignature(botSelfId)
    : `[BOT:${botSelfId}]`;
  return text + sig;
}

/**
 * 判断给定 style 是否需要在发送文本前/后发握手消息(Plan A)。
 */
export function requiresHandshake(style: BotSignatureStyle): boolean {
  return style === "metadata";
}
