/**
 * 主动消息发送模块
 * 通过 OneBotClient 向 QQ 用户/群组/频道发送主动消息
 */

import { OneBotClient } from "./client.js";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { listKnownUsers, getKnownUsersStats } from "./known-users.js";
import type { KnownUser } from "./known-users.js";
import { parseTarget, isImageFile, dispatchMessage } from "./message-parser.js";
import type { OneBotMessage } from "./types.js";

import type { Logger } from "./types/channel-types.js";

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
  log?: Logger;
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

    // 入参守卫
    if (!options.text && !options.mediaUrl) {
      return { success: false, error: "text 和 mediaUrl 不能同时为空" };
    }

    if (options.mediaUrl) {
      // 去除 query string / fragment 后再判断扩展名，避免 CDN 签名 URL 误判
      const urlPath = options.mediaUrl.split("?")[0].split("#")[0];
      if (isImageFile(urlPath)) {
        const segments: OneBotMessage = [];
        if (options.text) segments.push({ type: "text", data: { text: options.text } });
        segments.push({ type: "image", data: { file: options.mediaUrl } });
        await dispatchMessage(client, target, segments);
      } else {
        // 非图片：先发文本再发文件
        if (options.text) await dispatchMessage(client, target, options.text);
        const fileMsg: OneBotMessage = [{ type: "file", data: { file: options.mediaUrl } }];
        await dispatchMessage(client, target, fileMsg);
      }
    } else {
      await dispatchMessage(client, target, options.text!);
    }

    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    (options.log ?? console).error(`[proactive] sendProactive failed: to=${options.to}, error=${errorMsg}`);
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

  // 同一个群可能存在多条已知用户记录，需去重，否则群会收到重复消息
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const u of users) {
    const target = (u.type === "group" && u.groupId) ? `group:${u.groupId}` : String(u.openid);
    if (!seen.has(target)) {
      seen.add(target);
      recipients.push(target);
    }
  }

  const results = await sendBulkProactive(recipients, text, options?.accountId);

  const sent = results.filter(r => r.result.success).length;
  const failed = results.filter(r => !r.result.success).length;

  return { sent, failed, results };
}
