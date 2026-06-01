/**
 * Bot 签名工具
 *
 * send-text.ts 和 message-sender.ts 共用的签名追加逻辑,
 * 支持 visible / zero-width / none 三种样式。
 *
 * - visible:    在文本末尾追加 [BOT:selfId],用户可见,可靠
 * - zero-width: 在文本末尾追加零宽字符签名,用户不可见,可能被平台剥
 * - none:       不追加任何文本签名(仅靠 sender.bot / knownBotIds / known-bots 缓存)
 *
 * v1.9.2 移除: 'metadata'(OneBot json 段握手),因 json 段在 QQ 客户端
 *   渲染为可见卡片消息,导致启动广播 spam。
 */

import { makeZeroWidthSignature } from "../constants.js";

export type BotSignatureStyle = "none" | "visible" | "zero-width";

/**
 * 追加 bot 签名到文本末尾。
 *
 * - text 为空时不追加
 * - botSelfId 缺失时不追加
 * - style === "none" 时返回原 text
 * - 私聊由调用方在传入前判断 isGroup(函数本身不强制)
 */
export function appendBotSignature(
  text: string,
  botSelfId: number | string | null | undefined,
  style: BotSignatureStyle,
): string {
  if (!text) return text;
  if (botSelfId === null || botSelfId === undefined) return text;
  if (style === "none") return text;
  const sig = style === "zero-width"
    ? makeZeroWidthSignature(botSelfId)
    : `[BOT:${botSelfId}]`;
  return text + sig;
}
