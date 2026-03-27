/**
 * 主动消息发送模块
 * 通过 OneBotClient 向 QQ 用户/群组/频道发送主动消息
 */

import { OneBotClient } from "./client.js";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { listKnownUsers, getKnownUsersStats } from "./known-users.js";
import type { KnownUser } from "./known-users.js";
import { parseTarget } from "./message-parser.js";

// Re-export for convenience
export { listKnownUsers, getKnownUsersStats };

// clients Map 由 channel.ts 填充，通过 getter 访问
let _clients: Map<string, OneBotClient> | null = null;

/**
 * 注册 clients Map（由 channel.ts 在模块加载时调用）
 */
export function registerClientsMap(clients: Map<string, OneBotClient>): void {
  _clients = clients;
}

export interface ProactiveSendOptions {
  /** 目标：QQ号（私聊），"group:群号"（群聊），"guild:频道ID:子频道ID"（频道） */
  to: string;
  /** 发送的文本内容 */
  text: string;
  /** 可选媒体 URL（图片等） */
  mediaUrl?: string;
  /** 指定使用哪个账户 ID（不指定则使用默认账户） */
  accountId?: string;
}

export interface ProactiveSendResult {
  success: boolean;
  error?: string;
}

/**
 * 发送主动消息
 */
export async function sendProactive(options: ProactiveSendOptions): Promise<ProactiveSendResult> {
  if (!_clients) {
    return { success: false, error: "Clients map not initialized. Channel plugin may not be running." };
  }

  const resolvedAccountId = options.accountId || DEFAULT_ACCOUNT_ID;
  const client = _clients.get(resolvedAccountId);
  if (!client) {
    return {
      success: false,
      error: `No connected client for account "${resolvedAccountId}". Available: [${[..._clients.keys()].join(", ")}]`,
    };
  }

  try {
    const target = parseTarget(options.to);

    if (options.mediaUrl) {
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(options.mediaUrl);
      if (isImage) {
        const segments: any[] = [];
        if (options.text) segments.push({ type: "text", data: { text: options.text } });
        segments.push({ type: "image", data: { file: options.mediaUrl } });
        if (target.type === "group") await client.sendGroupMsg(target.groupId!, segments);
        else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, segments);
        else await client.sendPrivateMsg(target.userId!, segments);
      } else {
        // 非图片：先发文本再发文件链接
        if (options.text) {
          if (target.type === "group") await client.sendGroupMsg(target.groupId!, options.text);
          else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, options.text);
          else await client.sendPrivateMsg(target.userId!, options.text);
        }
        const fileMsg: any[] = [{ type: "file", data: { file: options.mediaUrl } }];
        if (target.type === "group") await client.sendGroupMsg(target.groupId!, fileMsg);
        else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, fileMsg);
        else await client.sendPrivateMsg(target.userId!, fileMsg);
      }
    } else {
      if (target.type === "group") await client.sendGroupMsg(target.groupId!, options.text);
      else if (target.type === "guild") await client.sendGuildChannelMsg(target.guildId!, target.channelId!, options.text);
      else await client.sendPrivateMsg(target.userId!, options.text);
    }

    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[proactive] sendProactive failed: to=${options.to}, error=${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * 批量发送主动消息，带 500ms 间隔以避免触发风控
 */
export async function sendBulkProactive(
  recipients: string[],
  text: string,
  accountId?: string,
): Promise<Array<{ to: string; result: ProactiveSendResult }>> {
  const results: Array<{ to: string; result: ProactiveSendResult }> = [];

  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    const result = await sendProactive({ to, text, accountId });
    results.push({ to, result });

    if (i < recipients.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

/**
 * 向所有已知用户（私聊）批量发送通知
 */
export async function broadcastToKnownUsers(
  text: string,
  options?: {
    accountId?: string;
    type?: "private" | "group" | "guild";
    activeWithin?: number;
  }
): Promise<{ sent: number; failed: number; results: Array<{ to: string; result: ProactiveSendResult }> }> {
  const users = listKnownUsers({
    accountId: options?.accountId,
    type: options?.type,
    activeWithin: options?.activeWithin,
  });

  const recipients: string[] = users.map((u: KnownUser) => {
    if (u.type === "group" && u.groupId) return `group:${u.groupId}`;
    return String(u.openid);
  });

  const results = await sendBulkProactive(recipients, text, options?.accountId);

  const sent = results.filter(r => r.result.success).length;
  const failed = results.filter(r => !r.result.success).length;

  return { sent, failed, results };
}
