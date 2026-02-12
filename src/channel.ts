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
            const path = fileURLToPath(url);
            const data = await fs.readFile(path);
            const base64 = data.toString("base64");
            return `base64://${base64}`;
        } catch (e) {
            console.warn(`[QQ] Failed to convert local file to base64: ${e}`);
            return url; // Fallback to original
        }
    }
    return url;
}

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
    listAccountIds: (cfg) => {
        // @ts-ignore
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        // @ts-ignore
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
    describeAccount: (acc) => ({
        accountId: acc.accountId,
        configured: acc.configured,
    }),
  },
  directory: {
      listPeers: async ({ accountId }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
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
      listGroups: async ({ accountId, cfg }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          const list: any[] = [];
          
          try {
              const groups = await client.getGroupList();
              list.push(...groups.map(g => ({
                  id: String(g.group_id),
                  name: g.group_name,
                  type: "group" as const,
                  metadata: { ...g }
              })));
          } catch (e) {}

          // @ts-ignore
          const enableGuilds = cfg?.channels?.qq?.enableGuilds ?? true;
          if (enableGuilds) {
              try {
                  const guilds = await client.getGuildList();
                  list.push(...guilds.map(g => ({
                      id: `guild:${g.guild_id}`,
                      name: `[频道] ${g.guild_name}`,
                      type: "group" as const,
                      metadata: { ...g }
                  })));
              } catch (e) {}
          }
          return list;
      }
  },
  status: {
      probeAccount: async ({ account, timeoutMs }) => {
          if (!account.config.wsUrl) return { ok: false, error: "Missing wsUrl" };
          
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
      buildAccountSnapshot: ({ account, runtime, probe }) => {
          return {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured: account.configured,
              running: runtime?.running ?? false,
              lastStartAt: runtime?.lastStartAt ?? null,
              lastError: runtime?.lastError ?? null,
              probe,
          };
      }
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => 
        applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name }),
    validateInput: ({ input }) => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
        const namedConfig = applyAccountNameToChannelSection({
            cfg,
            channelKey: "qq",
            accountId,
            name: input.name,
        });
        
        const next = accountId !== DEFAULT_ACCOUNT_ID 
            ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" }) 
            : namedConfig;

        const newConfig = {
            wsUrl: input.wsUrl || "ws://localhost:3001",
            httpUrl: input.httpUrl,
            reverseWsPort: input.reverseWsPort,
            accessToken: input.accessToken,
            enabled: true,
        };

        if (accountId === DEFAULT_ACCOUNT_ID) {
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
                        [accountId]: {
                            ...next.channels?.qq?.accounts?.[accountId],
                            ...newConfig
                        }
                    }
                }
            }
        };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;

        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

        // 1. Prevent multiple clients for the same account
        const existingClient = clients.get(account.accountId);
        if (existingClient) {
            console.log(`[QQ] Stopping existing client for account ${account.accountId} before restart`);
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

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info && info.user_id) client.setSelfId(info.user_id);
                if (info && info.nickname) console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                getQQRuntime().channel.activity.record({
                    channel: "qq", accountId: account.accountId, direction: "inbound", 
                 });
             } catch (err) { }
        });

        client.on("message", async (event) => {
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

            const isGroup = event.message_type === "group";
            const isGuild = event.message_type === "guild";
            
            if (isGuild && !config.enableGuilds) return;

            const userId = event.user_id;
            const groupId = event.group_id;
            const guildId = event.guild_id;
            const channelId = event.channel_id;

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
                    } else if (seg.type === "record") resolvedText += ` [语音消息]${seg.data?.text ? `(${seg.data.text})` : ""}`;
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
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]\n/status - 状态\n/mute @用户 [分] - 禁言\n/kick @用户 - 踢出\n/help - 帮助`;
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
            if (!isTriggered && config.keywordTriggers) {
                for (const kw of config.keywordTriggers) { if (text.includes(kw)) { isTriggered = true; break; } }
            }
            
            const checkMention = isGroup || isGuild;
            if (checkMention && config.requireMention && !isTriggered) {
                const selfId = client.getSelfId();
                const effectiveSelfId = selfId ?? event.self_id;
                if (!effectiveSelfId) return;
                let mentioned = false;
                if (Array.isArray(event.message)) {
                    for (const s of event.message) { if (s.type === "at" && (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")) { mentioned = true; break; } }
                } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) mentioned = true;
                if (!mentioned && repliedMsg?.sender?.user_id === effectiveSelfId) mentioned = true;
                if (!mentioned) return;
            }

            // React with emoji if configured (static mode, not "auto")
            if (config.reactionEmoji && config.reactionEmoji !== "auto" && event.message_id) {
                try { client.setMsgEmojiLike(event.message_id, config.reactionEmoji); } catch (e) {}
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

            const deliver = async (payload: ReplyPayload) => {
                 const send = async (msg: string) => {
                     let processed = msg;

                     // Extract AI-chosen reaction from reply text
                     if (config.reactionEmoji === "auto" && event.message_id) {
                         const reactionMatch = processed.match(/^\[reaction:(\d+)\]\s*/);
                         if (reactionMatch) {
                             try { client.setMsgEmojiLike(event.message_id, reactionMatch[1]); } catch (e) {}
                             processed = processed.slice(reactionMatch[0].length);
                         }
                     }

                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         
                         if (isGroup) client.sendGroupMsg(groupId, chunk);
                         else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, chunk);
                         else client.sendPrivateMsg(userId, chunk);
                         
                         if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
                             const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                             if (tts) {
                                 if (isGroup && config.aiVoiceId) {
                                     try { await client.sendGroupAiRecord(groupId, tts, config.aiVoiceId); } catch (e) {
                                         // Fallback to CQ:tts
                                         client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`);
                                     }
                                 } else if (isGroup) {
                                     client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`);
                                 } else {
                                     client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`);
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
                                 if (isGroup) client.sendGroupMsg(groupId, imgMsg);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, imgMsg);
                                 else client.sendPrivateMsg(userId, imgMsg);
                             } else {
                                 // Try upload API first for non-image files, fall back to CQ code
                                 const fileName = f.name || 'file';
                                 try {
                                     if (isGroup) {
                                         await client.uploadGroupFile(groupId, url, fileName);
                                     } else if (!isGuild) {
                                         await client.uploadPrivateFile(userId, url, fileName);
                                     } else {
                                         client.sendGuildChannelMsg(guildId, channelId, `[文件] ${url}`);
                                     }
                                 } catch (e) {
                                     // Fallback to CQ code
                                     const txtMsg = `[CQ:file,file=${url},name=${fileName}]`;
                                     if (isGroup) client.sendGroupMsg(groupId, txtMsg);
                                     else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, `[文件] ${url}`);
                                     else client.sendPrivateMsg(userId, txtMsg);
                                 }
                             }
                             if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                         }
                     }
                 }
            };

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
            if (config.reactionEmoji === "auto") {
                systemBlock += `<reaction-instruction>根据用户消息的语气和内容，在回复的最开头添加一个表情回应标记，格式为 [reaction:表情ID]。表情ID从以下列表中选择最合适的一个：
128077(👍厉害) 128079(👏鼓掌) 128293(🔥火) 128516(😄高兴) 128514(😂激动) 128522(😊嘿嘿) 128536(😘飞吻) 128170(💪加油) 128147(💓爱心) 10024(✨闪光) 127881(🎉庆祝) 128557(😭大哭) 128076(👌OK)
示例：用户说"谢谢"→回复"[reaction:128147]不客气！"，用户说"太厉害了"→回复"[reaction:128293]嘿嘿~"
只输出一个[reaction:ID]标记，放在回复最前面，后面紧跟正文。</reaction-instruction>\n\n`;
            }
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

            try { await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
            } catch (error) { if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); }
          } catch (err) {
            console.error("[QQ] Critical error in message handler:", err);
          }
        });

        client.connect();
        client.startReverseWs();
        return () => {
            clearInterval(cleanupInterval);
            client.disconnect();
            clients.delete(account.accountId);
        };
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
        console.log(`[QQ][outbound.sendText] called: to=${to}, accountId=${accountId}, text=${text?.slice(0, 100)}`);
        const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
        const client = getClientForAccount(resolvedAccountId);
        console.log(`[QQ][outbound.sendText] client lookup: accountId=${resolvedAccountId}, found=${!!client}, clients keys=[${[...clients.keys()].join(",")}]`);
        if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
        try {
            const target = parseTarget(to);
            console.log(`[QQ][outbound.sendText] parsed target: type=${target.type}, to=${to}`);
            const chunks = splitMessage(text, 4000);
            for (let i = 0; i < chunks.length; i++) {
                let message: OneBotMessage | string = chunks[i];
                if (replyTo && i === 0) message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];

                console.log(`[QQ][outbound.sendText] sending chunk ${i + 1}/${chunks.length} to ${to} (${target.type})`);
                await dispatchMessage(client, target, message);

                if (chunks.length > 1) await sleep(1000);
            }
            console.log(`[QQ][outbound.sendText] success: to=${to}`);
            return { channel: "qq", sent: true };
        } catch (err) {
            console.error("[QQ][outbound.sendText] FAILED:", err);
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
             if (isImageFile(mediaUrl)) message.push({ type: "image", data: { file: finalUrl } });
             else message.push({ type: "text", data: { text: `[CQ:file,file=${finalUrl},url=${finalUrl}]` } });

             await dispatchMessage(client, target, message);
             return { channel: "qq", sent: true };
         } catch (err) {
             console.error("[QQ] outbound.sendMedia failed:", err);
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
  },
  setup: { resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) }
};
