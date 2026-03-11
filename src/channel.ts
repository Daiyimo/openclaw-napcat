import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  type OpenClawConfig,
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
import type { OneBotMessage } from "./types.js";
import { convertSilkToWav } from "./utils/audio-convert.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { registerClientsMap } from "./proactive.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
  configured: boolean;
};

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过 1 小时无法被动回复（需改为主动消息）
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/**
 * 清理过期记录（定期调用以避免内存泄漏）
 */
function cleanupMessageTrackers() {
  const now = Date.now();
  for (const [id, rec] of messageReplyTracker) {
    if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.delete(id);
    }
  }
}

/**
 * 检查是否可以回复该消息（限流检查）
 */
function checkMessageReplyLimit(messageId: string): {
  allowed: boolean;
  remaining: number;
  shouldFallbackToProactive: boolean;
  fallbackReason?: "expired" | "limit_exceeded";
  message?: string;
} {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  // 新消息，首次回复
  if (!record) {
    return {
      allowed: true,
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }

  // 检查是否超过1小时（message_id 过期）
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: `消息已超过 1 小时有效期，无法被动回复`,
    };
  }

  // 检查是否超过回复次数限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "limit_exceeded",
      message: `该消息已达到 1 小时内最大回复次数(${MESSAGE_REPLY_LIMIT}次)`,
    };
  }

  return {
    allowed: true,
    remaining,
    shouldFallbackToProactive: false,
  };
}

/**
 * 记录一次消息回复
 */
function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
  console.log(`[napcat-QQ] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`);
}

// ========================================

const memberCache = new Map<string, { name: string, time: number }>();
const bulkCachedGroups = new Set<string>();

function getCachedMemberName(groupId: string, userId: string): string | null {
    const key = `${groupId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) { // 1 hour cache
        return cached.name;
    }
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
    } catch (e) {
        // Fallback: individual queries will still work
    }
}

function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  const urls: string[] = [];
  
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment.type === "image") {
        const url = segment.data?.url || (typeof segment.data?.file === 'string' && (segment.data.file.startsWith('http') || segment.data.file.startsWith('base64://')) ? segment.data.file : undefined);
        if (url) {
          urls.push(url);
          if (urls.length >= maxImages) break;
        }
      }
    }
  } else if (typeof message === "string") {
    const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
    let match;
    while ((match = imageRegex.exec(message)) !== null) {
      const val = match[1].replace(/&amp;/g, "&");
      if (val.startsWith("http") || val.startsWith("base64://")) {
        urls.push(val);
        if (urls.length >= maxImages) break;
      }
    }
  }
  
  return urls;
}

function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  
  let result = text;
  const imageUrls: string[] = [];
  
  // Match both url= and file= if they look like URLs
  const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const val = match[1].replace(/&amp;/g, "&");
    if (val.startsWith("http")) {
      imageUrls.push(val);
    }
  }

  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => {
    if (match.startsWith("[CQ:image")) {
      return "[图片]";
    }
    return "";
  });
  
  result = result.replace(/\s+/g, " ").trim();
  
  if (imageUrls.length > 0) {
    result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
  }
  
  return result;
}

function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) {
          return id;
        }
      }
    }
  }
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

type TargetType = "private" | "group" | "guild";
interface ParsedTarget {
  type: TargetType;
  /** For private: user_id (number); for group: group_id (number); for guild: { guildId, channelId } */
  userId?: number;
  groupId?: number;
  guildId?: string;
  channelId?: string;
}

/**
 * Parse the `to` field from outbound calls into a structured target.
 *
 * Supported formats:
 *   - Private:  "12345678"  or  "private:12345678"
 *   - Group:    "group:88888888"
 *   - Guild:    "guild:GUILD_ID:CHANNEL_ID"
 */
function parseTarget(to: string): ParsedTarget {
  if (to.startsWith("group:")) {
    const id = parseInt(to.slice(6), 10);
    if (isNaN(id)) throw new Error(`Invalid group target: "${to}" — expected "group:<number>"`);
    return { type: "group", groupId: id };
  }
  if (to.startsWith("guild:")) {
    const parts = to.split(":");
    if (parts.length < 3 || !parts[1] || !parts[2]) {
      throw new Error(`Invalid guild target: "${to}" — expected "guild:<guildId>:<channelId>"`);
    }
    return { type: "guild", guildId: parts[1], channelId: parts[2] };
  }
  if (to.startsWith("private:")) {
    const id = parseInt(to.slice(8), 10);
    if (isNaN(id)) throw new Error(`Invalid private target: "${to}" — expected "private:<number>"`);
    return { type: "private", userId: id };
  }
  // Default: treat as private user id
  const id = parseInt(to, 10);
  if (isNaN(id)) {
    throw new Error(
      `Cannot determine target type from "${to}". Use "private:<QQ号>", "group:<群号>", or "guild:<频道ID>:<子频道ID>".`
    );
  }
  return { type: "private", userId: id };
}

/** Dispatch a message to the correct API based on the parsed target. */
async function dispatchMessage(client: OneBotClient, target: ParsedTarget, message: OneBotMessage | string) {
  switch (target.type) {
    case "group":
      await client.sendGroupMsg(target.groupId!, message);
      break;
    case "guild":
      client.sendGuildChannelMsg(target.guildId!, target.channelId!, message);
      break;
    case "private":
      await client.sendPrivateMsg(target.userId!, message);
      break;
  }
}

const clients = new Map<string, OneBotClient>();

// Register with proactive module so it can use clients for outbound sends
registerClientsMap(clients);

function getClientForAccount(accountId: string) {
    return clients.get(accountId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isImageFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
}

function splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks = [];
    let current = text;
    while (current.length > 0) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
    }
    return chunks;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1") // Bold
        .replace(/\*(.*?)\*/g, "$1")     // Italic
        .replace(/`(.*?)`/g, "$1")       // Inline code
        .replace(/#+\s+(.*)/g, "$1")     // Headers
        .replace(/\[(.*?)\]\(.*?\)/g, "$1") // Links
        .replace(/^\s*>\s+(.*)/gm, "▎$1") // Blockquotes
        .replace(/```[\s\S]*?```/g, "[代码块]") // Code blocks
        .replace(/^\|.*\|$/gm, (match) => { // Simple table row approximation
             return match.replace(/\|/g, " ").trim();
        })
        .replace(/^[\-\*]\s+/gm, "• "); // Lists
}

function processAntiRisk(text: string): string {
    return text.replace(/(https?:\/\/)/gi, "$1 ");
}

async function resolveMediaUrl(url: string): Promise<string> {
    if (url.startsWith("file:")) {
        try {
            const filePath = fileURLToPath(url);
            const data = await fs.readFile(filePath);
            const base64 = data.toString("base64");
            return `base64://${base64}`;
        } catch (e) {
            console.warn(`[napcat-QQ] Failed to convert local file to base64: ${e}`);
            return url;
        }
    }
    // 裸本地路径（如 /tmp/xxx.jpg 或 C:\xxx.jpg），NapCat 运行在远端时无法访问，转为 base64
    if (url.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(url)) {
        try {
            const data = await fs.readFile(url);
            const base64 = data.toString("base64");
            return `base64://${base64}`;
        } catch (e) {
            console.warn(`[napcat-QQ] Failed to read local file, passing as-is: ${e}`);
            return url;
        }
    }
    return url;
}

// ============ STT 辅助函数 ============

interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const c = cfg as any;

  // 优先 channels.qq.stt（插件专属配置）
  const channelStt = c?.channels?.qq?.stt;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = channelStt?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = channelStt?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = channelStt?.apiKey || providerCfg?.apiKey;
    const model: string = channelStt?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // 回退 tools.media.audio.models[0]（框架级配置）
  const audioModelEntry = c?.tools?.media?.audio?.models?.[0];
  if (audioModelEntry) {
    const providerId: string = audioModelEntry?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = audioModelEntry?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = audioModelEntry?.apiKey || providerCfg?.apiKey;
    const model: string = audioModelEntry?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

async function transcribeAudioForNapcat(audioPath: string, cfg: Record<string, unknown>): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) return null;

  const fileBuffer = fsSync.readFileSync(audioPath);
  const fileName = path.basename(audioPath);
  const mime = fileName.endsWith(".wav") ? "audio/wav"
    : fileName.endsWith(".mp3") ? "audio/mpeg"
    : fileName.endsWith(".ogg") ? "audio/ogg"
    : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = await resp.json() as { text?: string };
  return result.text?.trim() || null;
}

// ========================================

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
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg: OpenClawConfig) => {
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl || accountConfig?.reverseWsPort),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc: ChannelAccountSnapshot) => ({
        accountId: acc.accountId,
        configured: acc.enabled,
    }),
  },
  directory: {
      listPeers: async (params: { accountId?: string }) => {
          const client = getClientForAccount(params.accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          try {
              const friends = await client.getFriendList();
              return friends.map(f => ({
                  id: String(f.user_id),
                  name: f.remark || f.nickname,
                  type: "user" as const,
                  metadata: { ...f }
              }));
          } catch (e) {
              return [];
          }
      },
      listGroups: async (params: { accountId?: string; cfg?: any }) => {
          const client = getClientForAccount(params.accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          try {
              const groups = await client.getGroupList();
              return groups.map(g => ({
                  id: String(g.group_id),
                  name: g.group_name,
                  type: "group" as const,
                  metadata: { ...g }
              }));
          } catch (e) {
              return [];
          }
      },
  },
  status: {
      probeAccount: async ({ account, timeoutMs }) => {
          if (!account.config.wsUrl && !account.config.reverseWsPort) return { ok: false, error: "Missing wsUrl or reverseWsPort" };
          
          const client = new OneBotClient({
              wsUrl: account.config.wsUrl,
              httpUrl: account.config.httpUrl,
              accessToken: account.config.accessToken,
          });
          
          return new Promise((resolve) => {
              const timer = setTimeout(() => {
                  client.disconnect();
                  resolve({ ok: false, error: "Connection timeout" });
              }, timeoutMs || 5000);

              client.on("connect", async () => {
                  try {
                      const info = await client.getLoginInfo();
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ 
                          ok: true, 
                          bot: { id: String(info.user_id), username: info.nickname } 
                      });
                  } catch (e) {
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ ok: false, error: String(e) });
                  }
              });
              
              client.on("error", (err) => {
                  clearTimeout(timer);
                  resolve({ ok: false, error: String(err) });
              });

              client.connect();
          });
      },
      buildAccountSnapshot: ({ account, runtime }) => {
          return {
              accountId: account?.accountId ?? "unknown",
              name: account?.name ?? "Unknown",
              enabled: account?.enabled ?? false,
              configured: account?.configured ?? false,
              running: runtime?.running ?? false,
              lastStartAt: runtime?.lastStartAt ?? null,
              lastError: runtime?.lastError ?? null,
          };
      }
  },
  setup: {
    resolveAccountId: (params: { accountId?: string | null }) => normalizeAccountId(params.accountId),
    applyAccountName: (params: { cfg: OpenClawConfig; accountId: string; name: string }) =>
        applyAccountNameToChannelSection({ cfg: params.cfg, channelKey: "qq", accountId: params.accountId, name: params.name }),
    validateInput: (params: { input: any }) => null,
    applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: any }) => {
        const namedConfig = applyAccountNameToChannelSection({
            cfg: params.cfg,
            channelKey: "qq",
            accountId: params.accountId,
            name: params.input.name,
        });

        const next = params.accountId !== DEFAULT_ACCOUNT_ID
            ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" })
            : namedConfig;

        const newConfig = {
            wsUrl: params.input.wsUrl || undefined,
            httpUrl: params.input.httpUrl,
            reverseWsPort: params.input.reverseWsPort,
            accessToken: params.input.accessToken,
            enabled: true,
        };

        if (params.accountId === DEFAULT_ACCOUNT_ID) {
            return {
                ...next,
                channels: {
                    ...next.channels,
                    qq: { ...next.channels?.qq, ...newConfig }
                }
            };
        }

        return {
            ...next,
            channels: {
                ...next.channels,
                qq: {
                    ...next.channels?.qq,
                    enabled: true,
                    accounts: {
                        ...next.channels?.qq?.accounts,
                        [params.accountId]: {
                            ...(next.channels?.qq?.accounts?.[params.accountId] || {}),
                            ...newConfig
                        }
                    }
                }
            }
        };
    },
  },
  gateway: {
    startAccount: async (ctx: { account: ResolvedQQAccount; cfg: OpenClawConfig; abortSignal: AbortSignal; log?: any; onReady: () => void; onError: (error: Error) => void }) => {
        const { account, cfg } = ctx;
        const config = account.config;

        if (!config.wsUrl && !config.reverseWsPort) throw new Error("QQ: either wsUrl or reverseWsPort is required");

        // 1. Prevent multiple clients for the same account
        const existingClient = clients.get(account.accountId);
        if (existingClient) {
            console.log(`[napcat-QQ] Stopping existing client for account ${account.accountId} before restart`);
            existingClient.disconnect();
        }

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            httpUrl: config.httpUrl,
            reverseWsPort: config.reverseWsPort,
            accessToken: config.accessToken,
        });
        
        clients.set(account.accountId, client);

        const processedMsgIds = new Set<string>();
        const cleanupInterval = setInterval(() => {
            if (processedMsgIds.size > 1000) processedMsgIds.clear();
        }, 3600000);

        // Periodic cleanup of expired message reply trackers
        const trackerCleanupInterval = setInterval(() => {
            cleanupMessageTrackers();
        }, 60 * 60 * 1000);

        client.on("connect", async () => {
             console.log(`[napcat-QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info && info.user_id) client.setSelfId(info.user_id);
                if (info && info.nickname) console.log(`[napcat-QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                getQQRuntime().channel.activity.record({
                    channel: "qq", accountId: account.accountId, direction: "inbound",
                 });
             } catch (err) { }
        });

        client.on("message", async (event) => {
          // Extract common fields for error reporting (must be outside try to be visible in catch)
          const isGroup = event.message_type === "group";
          const isGuild = event.message_type === "guild";
          const userId = event.user_id;
          const groupId = event.group_id;
          const guildId = event.guild_id;
          const channelId = event.channel_id;

          try {
            if (event.post_type === "meta_event") {
                 if (event.meta_event_type === "lifecycle" && event.sub_type === "connect" && event.self_id) client.setSelfId(event.self_id);
                 return;
            }

            // Handle friend/group add requests
            if (event.post_type === "request" && config.autoApproveRequests) {
                if (event.request_type === "friend" && event.flag) client.setFriendAddRequest(event.flag, true);
                else if (event.request_type === "group" && event.flag && event.sub_type) client.setGroupAddRequest(event.flag, event.sub_type, true);
                return;
            }

            if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke") {
                if (String(event.target_id) === String(client.getSelfId())) {
                    const isGroupPoke = !!event.group_id;
                    event.post_type = "message";
                    event.message_type = isGroupPoke ? "group" : "private";
                    event.raw_message = `[动作] 用户戳了你一下`;
                    event.message = [{ type: "text", data: { text: event.raw_message } }];
                    // Poke back
                    if (isGroupPoke) {
                        client.sendGroupPoke(event.group_id!, event.user_id!);
                    } else if (event.user_id) {
                        client.sendFriendPoke(event.user_id);
                    }
                } else return;
            }

            if (event.post_type !== "message") return;

            // 2. Dynamic self-message filtering
            const selfId = client.getSelfId() || event.self_id;
            if (selfId && String(event.user_id) === String(selfId)) return;

            if (config.enableDeduplication !== false && event.message_id) {
                const msgIdKey = String(event.message_id);
                if (processedMsgIds.has(msgIdKey)) return;
                processedMsgIds.add(msgIdKey);
            }

            // Auto mark messages as read
            if (config.autoMarkRead) {
                try {
                    if (isGroup && groupId) client.markGroupMsgAsRead(groupId);
                    else if (!isGroup && !isGuild && userId) client.markPrivateMsgAsRead(userId);
                } catch (e) {}
            }

            // Bulk populate member cache on first group message
            if (isGroup && groupId) {
                await populateGroupMemberCache(client, groupId);
            }
            
            let text = event.raw_message || "";
            
            if (Array.isArray(event.message)) {
                let resolvedText = "";
                for (const seg of event.message) {
                    if (seg.type === "text") resolvedText += seg.data?.text || "";
                    else if (seg.type === "at") {
                        let name = seg.data?.qq;
                        if (name !== "all" && isGroup) {
                            const cached = getCachedMemberName(String(groupId), String(name));
                            if (cached) name = cached;
                        }
                        resolvedText += ` @${name} `;
                    } else if (seg.type === "record") {
                        if (config.enableSTT && seg.data?.url) {
                            try {
                                const voiceUrl = seg.data.url;
                                const tmpDir = os.tmpdir();
                                const tmpFile = path.join(tmpDir, `voice-${Date.now()}.amr`);
                                const voiceResp = await fetch(voiceUrl);
                                if (voiceResp.ok) {
                                    const buf = await voiceResp.arrayBuffer();
                                    fsSync.writeFileSync(tmpFile, Buffer.from(buf));
                                    const wavResult = await convertSilkToWav(tmpFile, tmpDir);
                                    if (wavResult) {
                                        const transcript = await transcribeAudioForNapcat(wavResult.wavPath, cfg as Record<string, unknown>);
                                        try { fsSync.unlinkSync(tmpFile); } catch {}
                                        try { fsSync.unlinkSync(wavResult.wavPath); } catch {}
                                        if (transcript) {
                                            resolvedText += ` [语音转文字: ${transcript}]`;
                                        } else {
                                            resolvedText += ` [语音消息: 转写为空]`;
                                        }
                                    } else {
                                        try { fsSync.unlinkSync(tmpFile); } catch {}
                                        resolvedText += ` [语音消息: 格式不支持]`;
                                    }
                                } else {
                                    resolvedText += ` [语音消息: 下载失败]`;
                                }
                            } catch (sttErr) {
                                console.warn(`[napcat-QQ] STT failed: ${sttErr}`);
                                resolvedText += ` [语音消息: 转写失败]`;
                            }
                        } else {
                            resolvedText += ` [语音消息]${seg.data?.text ? `(${seg.data.text})` : ""}`;
                        }
                    }
                    else if (seg.type === "image") resolvedText += " [图片]";
                    else if (seg.type === "video") resolvedText += " [视频消息]";
                    else if (seg.type === "json") resolvedText += " [卡片消息]";
                    else if (seg.type === "forward" && seg.data?.id) {
                        try {
                            const forwardData = await client.getForwardMsg(seg.data.id);
                            if (forwardData?.messages) {
                                resolvedText += "\n[转发聊天记录]:";
                                for (const m of forwardData.messages.slice(0, 10)) {
                                    resolvedText += `\n${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.content || m.raw_message)}`;
                                }
                            }
                        } catch (e) {}
                    } else if (seg.type === "file") {
                         if (!seg.data?.url && isGroup) {
                             try {
                                 const info = await (client as any).sendWithResponse("get_group_file_url", { group_id: groupId, file_id: seg.data?.file_id, busid: seg.data?.busid });
                                 if (info?.url) seg.data.url = info.url;
                             } catch(e) {}
                         }
                         resolvedText += ` [文件: ${seg.data?.file || "未命名"}]`;
                    }
                }
                if (resolvedText) text = resolvedText;
            }
            
            if (config.blockedUsers?.includes(userId)) return;
            if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId)) return;

            const isAdmin = config.admins?.includes(userId) ?? false;
            if (config.admins?.length && !isAdmin) return;

            if (!isGuild && isAdmin && text.trim().startsWith('/')) {
                const isCmdMentioned = !isGroup || (() => {
                    const sid = client.getSelfId() ?? event.self_id;
                    if (!sid) return false;
                    if (Array.isArray(event.message)) {
                        for (const s of event.message) { if (s.type === "at" && (String(s.data?.qq) === String(sid) || s.data?.qq === "all")) return true; }
                    }
                    return text.includes(`[CQ:at,qq=${sid}]`);
                })();
                if (isCmdMentioned) {
                    const parts = text.trim().split(/\s+/);
                    const cmd = parts[0];
                    if (cmd === '/status') {
                        const statusMsg = `[OpenClaw QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                        if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                        return;
                    }
                    if (cmd === '/help') {
                        const helpMsg = `[OpenClaw QQ]\n/status - 状态\n/mute @用户 [分] - 禁言\n/kick @用户 - 踢出\n/help - 帮助`;
                        if (isGroup) client.sendGroupMsg(groupId, helpMsg); else client.sendPrivateMsg(userId, helpMsg);
                        return;
                    }
                    if (isGroup && (cmd === '/mute' || cmd === '/ban')) {
                        const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                        const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                        if (targetId) {
                            client.setGroupBan(groupId, targetId, parts[2] ? parseInt(parts[2]) * 60 : 1800);
                            client.sendGroupMsg(groupId, `已禁言。`);
                        }
                        return;
                    }
                    if (isGroup && cmd === '/kick') {
                        const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                        const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                        if (targetId) {
                            client.setGroupKick(groupId, targetId);
                            client.sendGroupMsg(groupId, `已踢出。`);
                        }
                        return;
                    }
                }
            }
            
            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            if (replyMsgId) {
                try { repliedMsg = await client.getMsg(replyMsgId); } catch (err) {}
            }
            
            let historyContext = "";
            if (isGroup && config.historyLimit !== 0) {
                 try {
                     const limit = config.historyLimit || 5;
                     const history = await client.getGroupMsgHistory(groupId, limit + 1);
                     if (history?.messages) {
                         historyContext = history.messages.slice(-(limit + 1), -1).map((m: any) => `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`).join("\n");
                     }
                 } catch (e) {}
            }

            let isTriggered = !isGroup || text.includes("[动作] 用户戳了你一下");

            const checkMention = isGroup || isGuild;
            let isMentioned = false;
            if (checkMention) {
                const selfId = client.getSelfId();
                const effectiveSelfId = selfId ?? event.self_id;
            if (!effectiveSelfId) return;
                if (Array.isArray(event.message)) {
                    for (const s of event.message) { if (s.type === "at" && (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")) { isMentioned = true; break; } }
                } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) isMentioned = true;
                if (!isMentioned && repliedMsg?.sender?.user_id === effectiveSelfId) isMentioned = true;
            }

            if (!isTriggered && config.keywordTriggers) {
                for (const kw of config.keywordTriggers) {
                    if (text.includes(kw)) { isTriggered = true; break; }
                }
            }

            if (checkMention && config.requireMention && !isTriggered && !isMentioned) return;

            // 准备 deliver 函数（用于发送回复和错误通知）
            const deliver = async (payload: ReplyPayload) => {
              const send = async (msg: string) => {
                let processed = msg;

                // markdownMode 优先于旧的 formatMarkdown 标志
                const effectiveMarkdownMode = config.markdownMode ?? (config.formatMarkdown ? "strip" : "passthrough");
                if (effectiveMarkdownMode === "strip") processed = stripMarkdown(processed);
                if (config.antiRiskMode) processed = processAntiRisk(processed);
                const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                for (let i = 0; i < chunks.length; i++) {
                  let chunk = chunks[i];

                  if (effectiveMarkdownMode === "native") {
                    // native 模式：包装为 markdown 消息段（NapCat 支持）
                    const mdSegments: OneBotMessage = [];
                    if (isGroup && i === 0) mdSegments.push({ type: "at", data: { qq: String(userId) } });
                    mdSegments.push({ type: "markdown", data: { content: chunk } });
                    if (isGroup) await client.sendGroupMsg(groupId, mdSegments);
                    else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, mdSegments);
                    else await client.sendPrivateMsg(userId, mdSegments);
                  } else {
                    if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;

                    if (isGroup) await client.sendGroupMsg(groupId, chunk);
                    else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, chunk);
                    else await client.sendPrivateMsg(userId, chunk);
                  }

                  if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
                    const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                    if (tts) {
                      try {
                        if (isGroup && config.aiVoiceId) {
                          await client.sendGroupAiRecord(groupId, tts, config.aiVoiceId);
                        } else if (isGroup) {
                          client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`);
                        } else {
                          client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`);
                        }
                      } catch (e) {
                        // TTS 失败静默忽略
                      }
                    }
                  }

                  if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                }
              };

              if (payload.text) await send(payload.text);
              if (payload.files) {
                for (const f of payload.files) {
                  if (f.url) {
                    const url = await resolveMediaUrl(f.url);
                    if (isImageFile(url)) {
                      const imgMsg = `[CQ:image,file=${url}]`;
                      if (isGroup) await client.sendGroupMsg(groupId, imgMsg);
                      else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, imgMsg);
                      else await client.sendPrivateMsg(userId, imgMsg);
                    } else {
                      const fileName = f.name || 'file';
                      try {
                        if (isGroup) await client.uploadGroupFile(groupId, url, fileName);
                        else if (!isGuild) await client.uploadPrivateFile(userId, url, fileName);
                        else await client.sendGuildChannelMsg(guildId, channelId, `[文件] ${url}`);
                      } catch (e) {
                        const txtMsg = `[CQ:file,file=${url},name=${fileName}]`;
                        if (isGroup) await client.sendGroupMsg(groupId, txtMsg);
                        else if (isGuild) await client.sendGuildChannelMsg(guildId, channelId, `[文件] ${url}`);
                        else await client.sendPrivateMsg(userId, txtMsg);
                      }
                    }
                    if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                  }
                }
              }
            };

            // 消息回复限流检查（仅在 enableReplyLimit: true 时生效，默认关闭）
            if (replyMsgId && config.enableDeduplication !== false && config.enableReplyLimit === true) {
              const limitResult = checkMessageReplyLimit(replyMsgId);
              if (!limitResult.allowed) {
                if (config.enableErrorNotify) {
                  await deliver({ text: `⚠️ ${limitResult.message}` });
                }
                console.log(`[napcat-QQ] Reply limit exceeded: messageId=${replyMsgId}, reason=${limitResult.fallbackReason}`);
                return;
              }
            }

            // Smart emoji reaction based on message content
            if (config.enableReactions && event.message_id) {
                try {
                    const t = text;
                    let emojiId = "307"; // default: 喵喵

                    // 查找/检查/打开类 → OK (124)
                    if (/查找|查询|搜索|检查|检测|查看|打开|获取|看看|找|搜/.test(t)) emojiId = "124";
                    // 确认/好的/收到 → 好的 (124) already covered, 赞 (76)
                    else if (/好的|收到|确认|明白|了解|知道了|好|没问题|OK|ok/.test(t)) emojiId = "76";
                    // 感谢/谢谢 → 拜谢 (297)
                    else if (/谢谢|感谢|谢了|多谢|感激/.test(t)) emojiId = "297";
                    // 加油/鼓励 → 加油 (315)
                    else if (/加油|继续|努力|坚持|棒|厉害|牛|赞/.test(t)) emojiId = "315";
                    // 开心/高兴/哈哈 → 鼓掌 (99)
                    else if (/哈哈|开心|高兴|快乐|好玩|有趣|笑|嘻嘻/.test(t)) emojiId = "99";
                    // 悲伤/难过/哭 → 流泪 (5)
                    else if (/难过|悲伤|伤心|哭|呜|唉|可怜|失落/.test(t)) emojiId = "5";
                    // 生气/愤怒 → 生气 (326)
                    else if (/生气|愤怒|气死|烦|滚|讨厌|恼火/.test(t)) emojiId = "326";
                    // 疑问/不懂/为什么 → 疑问 (32)
                    else if (/[?？]|为什么|怎么|啥|什么|不懂|不明白|疑问/.test(t)) emojiId = "32";
                    // 惊讶/震惊/哇 → 惊喜 (180)
                    else if (/哇|惊|震惊|不会吧|真的吗|卧槽|天啊|没想到/.test(t)) emojiId = "180";
                    // 喜欢/爱 → 爱心 (66)
                    else if (/喜欢|爱|爱你|心动|可爱|萌/.test(t)) emojiId = "66";
                    // 打招呼/问好 → 微笑 (14)
                    else if (/你好|早|晚安|嗨|hi|hello|Hey|hey/.test(t)) emojiId = "14";
                    // 帮助/请求 → 拱手 (118)
                    else if (/帮|请|麻烦|劳烦|能不能|可以吗|求/.test(t)) emojiId = "118";
                    // 吃/食物 → 蛋糕 (53)
                    else if (/吃|饿|饭|食|喝|美食/.test(t)) emojiId = "53";
                    // 睡觉/累 → 睡 (8)
                    else if (/睡|困|累|休息|晚安|乏/.test(t)) emojiId = "8";

                    await client.setMsgEmojiLike(event.message_id, emojiId);
                } catch (e) {}
            }

            let fromId = String(userId);
            let conversationLabel = `QQ User ${userId}`;
            if (isGroup) {
                fromId = `group:${groupId}`;
                conversationLabel = `QQ Group ${groupId}`;
            } else if (isGuild) {
                fromId = `guild:${guildId}:${channelId}`;
                conversationLabel = `QQ Guild ${guildId} Channel ${channelId}`;
            }

            const runtime = getQQRuntime();

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

            let replyToBody = "";
            let replyToSender = "";
            if (replyMsgId && repliedMsg) {
                replyToBody = cleanCQCodes(typeof repliedMsg.message === 'string' ? repliedMsg.message : repliedMsg.raw_message || '');
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
            }

            const replySuffix = replyToBody ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]` : "";
            let bodyWithReply = cleanCQCodes(text) + replySuffix;
            let systemBlock = "";
            if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
            if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
            bodyWithReply = systemBlock + bodyWithReply;

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: conversationLabel,
                SessionKey: `qq:${fromId}`, AccountId: account.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                ...(extractImageUrls(event.message).length > 0 && { MediaUrls: extractImageUrls(event.message) }),
                ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
            });
            
            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
                sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                updateLastRoute: { sessionKey: ctxPayload.SessionKey!, channel: "qq", to: fromId, accountId: account.accountId },
                onRecordError: (err) => console.error("QQ Session Error:", err)
            });

            try {
              await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
              // 发送成功后记录回复次数（用于限流）
              if (replyMsgId) {
                recordMessageReply(replyMsgId);
              }
              // 记录已知用户（用于主动消息）
              recordKnownUser({
                openid: String(userId),
                type: isGroup ? "group" : isGuild ? "guild" : "private",
                nickname: event.sender?.card || event.sender?.nickname,
                groupId: isGroup ? groupId : undefined,
                accountId: account.accountId,
              });
            } catch (error) {
              if (config.enableErrorNotify) {
                await deliver({ text: "⚠️ 服务调用失败，请稍后重试。" });
              }
              console.error("[napcat-QQ] Reply dispatch error:", error);
            }
          } catch (err) {
            console.error("[napcat-QQ] Critical error in message handler:", err);
            // 发送错误通知给管理员（如果启用）
            if (config.enableErrorNotify && config.admins?.length) {
              try {
                const errorMsg = `⚠️ 消息处理异常\n用户: ${userId}\n群组: ${isGroup ? groupId : '私聊'}\n错误: ${err instanceof Error ? err.message : String(err)}`;
                for (const adminId of config.admins) {
                  await client.sendPrivateMsg(adminId, errorMsg);
                  await sleep(500);
                }
              } catch (notifyErr) {
                console.warn("[napcat-QQ] Failed to send error notification:", notifyErr);
              }
            }
          }
        });

        client.connect();
        client.startReverseWs();

        // Keep startAccount pending until OpenClaw signals shutdown via abortSignal.
        // Without this, startAccount returns immediately while the WebSocket is still
        // connecting, causing health-monitor to see running:true connected:false and
        // trigger a spurious auto-restart loop (same fix applied in v2026.2.26 to
        // Google Chat, Nextcloud Talk, LINE, and Telegram channels).
        await new Promise<void>((resolve) => {
            if (ctx.abortSignal?.aborted) { resolve(); return; }
            ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });

        clearInterval(cleanupInterval);
        clearInterval(trackerCleanupInterval);
        flushKnownUsers();
        client.disconnect();
        clients.delete(account.accountId);
    },
    logoutAccount: async ({ accountId, cfg }) => {
        return { loggedOut: true, cleared: true };
    }
  },
  outbound: {
    sendText: async ({ to, text, accountId, replyTo }) => {
        // Ignore non-routable targets (e.g. framework heartbeat probes)
        if (!to || to === "heartbeat") {
            return { channel: "qq", sent: true };
        }
        console.log(`[napcat-QQ][outbound.sendText] called: to=${to}, accountId=${accountId}, text=${text?.slice(0, 100)}`);
        const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
        const client = getClientForAccount(resolvedAccountId);
        console.log(`[napcat-QQ][outbound.sendText] client lookup: accountId=${resolvedAccountId}, found=${!!client}, clients keys=[${[...clients.keys()].join(",")}]`);
        if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
        try {
            const target = parseTarget(to);
            console.log(`[napcat-QQ][outbound.sendText] parsed target: type=${target.type}, to=${to}`);
            const chunks = splitMessage(text, 4000);
            for (let i = 0; i < chunks.length; i++) {
                let message: OneBotMessage | string = chunks[i];
                if (replyTo && i === 0) message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];

                console.log(`[napcat-QQ][outbound.sendText] sending chunk ${i + 1}/${chunks.length} to ${to} (${target.type})`);
                await dispatchMessage(client, target, message);

                if (chunks.length > 1) await sleep(1000);
            }
            console.log(`[napcat-QQ][outbound.sendText] success: to=${to}`);
            return { channel: "qq", sent: true };
        } catch (err) {
            console.error("[napcat-QQ][outbound.sendText] FAILED:", err);
            return { channel: "qq", sent: false, error: String(err) };
        }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         // Ignore non-routable targets (e.g. framework heartbeat probes)
         if (!to || to === "heartbeat") {
             return { channel: "qq", sent: true };
         }
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
         try {
             const target = parseTarget(to);
             const finalUrl = await resolveMediaUrl(mediaUrl);

             const message: OneBotMessage = [];
             if (replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
             if (text) message.push({ type: "text", data: { text } });
             if (isImageFile(mediaUrl) || isImageFile(finalUrl)) message.push({ type: "image", data: { file: finalUrl } });
             else message.push({ type: "text", data: { text: `[CQ:file,file=${finalUrl},url=${finalUrl}]` } });

             await dispatchMessage(client, target, message);
             return { channel: "qq", sent: true };
         } catch (err) {
             console.error("[napcat-QQ] outbound.sendMedia failed:", err);
             return { channel: "qq", sent: false, error: String(err) };
         }
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", success: false, error: "Client not connected" };
        try { client.deleteMsg(messageId); return { channel: "qq", success: true }; }
        catch (err) { return { channel: "qq", success: false, error: String(err) }; }
    }
  },
  messaging: {
      normalizeTarget,
      targetResolver: {
          looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^(group|guild|private):/.test(id),
          hint: "QQ号, private:QQ号, group:群号, 或 guild:频道ID:子频道ID",
      }
  }
};
