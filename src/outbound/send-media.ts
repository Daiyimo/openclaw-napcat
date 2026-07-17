/**
 * Outbound 媒体发送 & 消息撤回
 *
 * 处理 outbound.sendMedia 和 outbound.deleteMessage。
 * 从 channel.ts 中提取，行为不变。
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";
import {
  parseTarget,
  dispatchMessage,
  resolveMediaUrl,
  isImageFile,
} from "../message-parser.js";
import { resolveBareGroupTarget } from "./send-text.js";
import { getLog } from "../admin-commands/shared.js";

export interface SendMediaParams {
  to: string;
  text?: string;
  mediaUrl: string;
  accountId?: string | null;
  replyToId?: string | null;
  // TODO(3.31+): ChannelOutboundContext 新增字段（audioAsVoice, mediaAccess, gifPlayback,
  // forceDocument, replyToIdSource, replyToMode, formatting）。当前 napcat 未使用。
}

import type { Logger } from "../types/channel-types.js";

export interface SendMediaDeps {
  getClient: (accountId: string) => OneBotClient | undefined;
  knownGroupIds: Set<string>;
  log?: Logger;
}

/**
 * 发送媒体消息（图片/文件）到指定目标。
 * 返回 OutboundDeliveryResult 形状（messageId 必填，无平台 id 时为 ""）；失败时 throw。
 */
export async function sendMedia(
  params: SendMediaParams,
  deps: SendMediaDeps,
): Promise<{ channel: "napcat"; messageId: string; meta?: Record<string, unknown> }> {
  const { to, text, mediaUrl, accountId, replyToId } = params;
  const { getClient, knownGroupIds } = deps;

  if (!to || to === "heartbeat") return { channel: "napcat", messageId: "" };
  const client = getClient(accountId || DEFAULT_ACCOUNT_ID);
  if (!client) throw new Error("Client not connected");

  try {
    const effectiveTo = await resolveBareGroupTarget(
      to,
      knownGroupIds,
      async (id) => client.getGroupInfo(id),
      deps.log,
    );

    const target = parseTarget(effectiveTo);
    const finalUrl = await resolveMediaUrl(mediaUrl);
    const message: OneBotMessage = [];
    if (replyToId) message.push({ type: "reply", data: { id: String(replyToId) } });
    if (text) message.push({ type: "text", data: { text } });
    if (isImageFile(mediaUrl) || isImageFile(finalUrl))
      message.push({ type: "image", data: { file: finalUrl } });
    else {
      const fileName = finalUrl ? finalUrl.split("/").pop() || "file" : "file";
      message.push({
        type: "file",
        data: { file: finalUrl, name: fileName },
      });
    }
    const messageId = await dispatchMessage(client, target, message);
    return { channel: "napcat", messageId: messageId ?? "" };
  } catch (err) {
    getLog(deps.log).error("[napcat-QQ] outbound.sendMedia failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export interface DeleteMessageParams {
  messageId: string;
  accountId?: string | null;
}

export interface DeleteMessageDeps {
  getClient: (accountId: string) => OneBotClient | undefined;
}

/**
 * 撤回一条已发送的消息。
 */
export function deleteMessage(
  params: DeleteMessageParams,
  deps: DeleteMessageDeps,
): { channel: "napcat"; success: boolean; error?: string } {
  const { messageId, accountId } = params;
  const client = deps.getClient(accountId || DEFAULT_ACCOUNT_ID);
  if (!client) return { channel: "napcat", success: false, error: "Client not connected" };

  try {
    client.deleteMsg(messageId);
    return { channel: "napcat", success: true };
  } catch (err) {
    return { channel: "napcat", success: false, error: String(err) };
  }
}
