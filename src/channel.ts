import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

// --- 工具函数保持不变 ---
const memberCache = new Map<string, { name: string, time: number }>();
const bulkCachedGroups = new Set<string>();

function getCachedMemberName(groupId: string, userId: string): string | null {
    const key = `${groupId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) return cached.name;
    return null;
}

function setCachedMemberName(groupId: string, userId: string, name: string) {
    memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

async function populateGroupMemberCache(client: OneBotClient, groupId: number) {
    const key = String(groupId);
    if (bulkCachedGroups.has(key)) return;
    try {
        const members = await client.getGroupMemberList(groupId);
        if (Array.isArray(members)) {
            for (const m of members) {
                const name = m.card || m.nickname || String(m.user_id);
                setCachedMemberName(key, String(m.user_id), name);
            }
            bulkCachedGroups.add(key);
        }
    } catch (e) {}
}

function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  const urls: string[] = [];
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment.type === "image") {
        const url = segment.data?.url || (typeof segment.data?.file === 'string' && (segment.data.file.startsWith('http') || segment.data.file.startsWith('base64://')) ? segment.data.file : undefined);
        if (url) { urls.push(url); if (urls.length >= maxImages) break; }
      }
    }
  } else if (typeof message === "string") {
    const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
    let match;
    while ((match = imageRegex.exec(message)) !== null) {
      const val = match[1].replace(/&amp;/g, "&");
      if (val.startsWith("http") || val.startsWith("base64://")) { urls.push(val); if (urls.length >= maxImages) break; }
    }
  }
  return urls;
}

function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  let result = text;
  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => match.startsWith("[CQ:image") ? "[图片]" : "");
  return result.replace(/\s+/g, " ").trim();
}

function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) return id;
      }
    }
  }
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

function parseTarget(to: string) {
  if (to.startsWith("group:")) return { type: "group", groupId: parseInt(to.slice(6), 10) };
  if (to.startsWith("guild:")) {
    const parts = to.split(":");
    return { type: "guild", guildId: parts[1], channelId: parts[2] };
  }
  return { type: "private", userId: parseInt(to.startsWith("private:") ? to.slice(8) : to, 10) };
}

async function dispatchMessage(client: OneBotClient, target: any, message: any) {
  if (target.type === "group") await client.sendGroupMsg(target.groupId, message);
  else if (target.type === "guild") client.sendGuildChannelMsg(target.guildId, target.channelId, message);
  else await client.sendPrivateMsg(target.userId, message);
}

const clients = new Map<string, OneBotClient>();
const getClientForAccount = (id: string) => clients.get(id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isImageFile = (url: string) => /\.(jpg|jpeg|png|gif|webp)$/i.test(url);

function splitMessage(text: string, limit: number): string[] {
    const chunks = [];
    let cur = text;
    while (cur.length > 0) { chunks.push(cur.slice(0, limit)); cur = cur.slice(limit); }
    return chunks;
}

function stripMarkdown(text: string): string {
    return text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1").replace(/`(.*?)`/g, "$1")
        .replace(/#+\s+(.*)/g, "$1").replace(/\[(.*?)\]\(.*?\)/g, "$1").replace(/^\s*>\s+(.*)/gm, "▎$1");
}

async function resolveMediaUrl(url: string): Promise<string> {
    if (url.startsWith("file:")) {
        try {
            const path = fileURLToPath(url);
            const data = await fs.readFile(path);
            return `base64://${data.toString("base64")}`;
        } catch (e) { return url; }
    }
    return url;
}

// --- 插件主入口 ---
export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true, // 核心修改：显式支持 Reaction
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
        const qq = (cfg as any).channels?.qq;
        if (!qq) return [];
        return qq.accounts ? Object.keys(qq.accounts) : [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg: any, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({ accountId: acc.accountId, configured: acc.configured }),
  },
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;
        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            httpUrl: config.httpUrl,
            reverseWsPort: config.reverseWsPort,
            accessToken: config.accessToken,
        });
        clients.set(account.accountId, client);

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info?.user_id) client.setSelfId(info.user_id);
             } catch (err) {}
        });

        client.on("message", async (event) => {
          try {
            if (event.post_type === "meta_event") return;

            // 提前解析变量
            const replyMsgId = getReplyMessageId(event.message, event.raw_message);
            if (event.post_type !== "message") return;
            const selfId = client.getSelfId() || event.self_id;
            if (selfId && String(event.user_id) === String(selfId)) return;

            const isGroup = event.message_type === "group";
            const isGuild = event.message_type === "guild";
            const userId = event.user_id;
            const groupId = event.group_id;
            const guildId = event.guild_id;
            const channelId = event.channel_id;

            if (isGroup && groupId) await populateGroupMemberCache(client, groupId);
            
            let text = event.raw_message || "";
            const isAdmin = config.admins?.includes(userId) ?? false;
            
            const isAutoReaction = config.reactionEmoji === "auto";
            const runtime = getQQRuntime();

            // --- 核心优化：先执行 Reaction 再回复文字 ---
            const deliver = async (payload: ReplyPayload) => {
                 // A. 响应来自 config.json 工具链下发的 metadata.reaction
                 if (payload.metadata?.reaction && event.message_id) {
                     try { await client.setMsgEmojiLike(event.message_id, payload.metadata.reaction); } catch (e) {}
                 }

                 const send = async (msg: string) => {
                     let processed = msg;
                     // B. 插件内部 AI 标记备选逻辑
                     if (isAutoReaction && event.message_id) {
                         const taskMatch = processed.match(/^\[task:(?:emoji_only|ok)\]\s*/);
                         const reactionMatch = processed.match(/^\[reaction:(\d+)\]\s*/);

                         if (taskMatch) {
                             try { await client.setMsgEmojiLike(event.message_id, "128076"); } catch (e) {}
                             processed = processed.slice(taskMatch[0].length);
                         } else if (reactionMatch) {
                             try { await client.setMsgEmojiLike(event.message_id, reactionMatch[1]); } catch (e) {}
                             processed = processed.slice(reactionMatch[0].length);
                         }
                     }

                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     for (const chunk of chunks) {
                         const finalMsg = isGroup ? `[CQ:at,qq=${userId}] ${chunk}` : chunk;
                         if (isGroup) client.sendGroupMsg(groupId, finalMsg);
                         else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, finalMsg);
                         else client.sendPrivateMsg(userId, finalMsg);
                     }
                 };

                 if (payload.text) await send(payload.text);
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

            let systemBlock = "";
            if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
            if (isAutoReaction) {
                systemBlock += `<reaction-instruction>在回复开头添加 [reaction:表情ID] 或任务成功后添加 [task:emoji_only]。 可选ID: 128077(👍), 128514(😂), 128147(💓), 128076(👌)</reaction-instruction>\n\n`;
            }

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: isGroup ? `group:${groupId}` : String(userId),
                To: "qq:bot", Body: systemBlock + cleanCQCodes(text), SenderId: String(userId),
                AccountId: account.accountId, ChatType: isGroup ? "group" : "direct", Timestamp: event.time * 1000,
            });
            
            await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
          } catch (err) { console.error("[QQ] Critical error:", err); }
        });

        client.connect();
        return () => client.disconnect();
    },
    logoutAccount: async () => ({ loggedOut: true, cleared: true })
  },
  outbound: {
    sendText: async ({ to, text, accountId }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", sent: false };
        const target = parseTarget(to);
        await dispatchMessage(client, target, text);
        return { channel: "qq", sent: true };
    }
  },
  // Actions 系统：支持外部调用添加/删除表情回应
  actions: {
    listActions: ({ cfg, accountId }) => {
      const qqCfg = (cfg as any)?.channels?.qq;
      const accountConfig = accountId ? qqCfg?.accounts?.[accountId] : qqCfg;
      if (!accountConfig?.enableReactions) {
        return [];
      }
      return ["react"];
    },
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, params, cfg, accountId }) => {
      if (action !== "react") {
        throw new Error(`Action ${action} is not supported for QQ channel`);
      }

      const messageId = params.messageId;
      const emoji = params.emoji;
      const remove = params.remove === true || params.remove === "true";

      if (!messageId) {
        throw new Error("messageId is required for react action");
      }

      const qqCfg = (cfg as any)?.channels?.qq;
      const accountConfig = accountId ? qqCfg?.accounts?.[accountId] : qqCfg;

      if (!accountConfig?.enableReactions) {
        throw new Error("Reactions are not enabled for this account");
      }

      const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
      if (!client) {
        throw new Error("No client available for this account");
      }

      try {
        if (remove) {
          // 删除反应：在 QQ 中需要使用空表情 ID 来移除反应
          // 或者使用 set_msg_emoji_like 发送一个特殊值来取消
          // Note: OneBot v11 标准 API 不直接支持删除 reaction，这里我们尝试使用空 emoji
          console.log(`[QQ] Removing reaction for message ${messageId}`);
          // 尝试发送空表情 ID 来移除（如果支持的话）
          await client.setMsgEmojiLike(messageId, "");
        } else if (emoji) {
          // 添加反应
          console.log(`[QQ] Adding reaction ${emoji} to message ${messageId}`);
          await client.setMsgEmojiLike(messageId, emoji);
        } else {
          throw new Error("emoji is required when not removing reaction");
        }
        return { success: true, action: remove ? "removed" : "added", emoji, messageId };
      } catch (err: any) {
        console.error("[QQ] Reaction action failed:", err);
        throw new Error(`Failed to perform reaction: ${err.message}`);
      }
    },
  },
};