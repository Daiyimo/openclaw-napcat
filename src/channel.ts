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

/** Local detection: pick an emoji based on message content.
 *  Returns emoji ID string, or null if no emoji (pure greetings/thanks).
 *  Emoji IDs reference: https://bot.q.qq.com/wiki/develop/api-v2/openapi/emoji/model.html
 *  Type 1 (QQ system, short ID): 76=赞, 124=OK, 99=鼓掌, 66=爱心, etc.
 *  Type 2 (Unicode, long ID): 128077=👍, 128076=👌, 128514=😂, etc. */
function pickLocalEmoji(text: string): string | null {
    const trimmed = text.replace(/@\S+\s*/g, "").trim();
    if (!trimmed) return null;
    // Pure greetings — no emoji
    if (/^(你好|hello|hi|hey|在吗|在不在|早上好|晚上好|早安|晚安|嗨|哈喽|下午好|中午好)[\s!！。.~～]*$/i.test(trimmed)) return null;
    // Pure thanks — no emoji
    if (/^(谢谢|感谢|多谢|thanks|thank you|thx|蟹蟹|3q)[\s!！。.~～]*$/i.test(trimmed)) return null;

    // --- Emotion / sentiment matching (most specific first) ---

    // Asking about bot / model / identity → QQ系统:喵喵(307)
    if (/(什么模型|哪家模型|哪个模型|用的什么|用的啥|什么大模型|哪个大模型|什么ai|哪家ai|什么llm|你是谁|你是什么|你叫什么|你是哪个|你是啥|是gpt|是claude|是gemini|是通义|是文心|是豆包|是minimax|是kimi|谁开发的|谁做的|谁训练的|什么版本)/.test(trimmed)) return "307";
    // Sad / crying → 😭 大哭 (128557)
    if (/(难过|伤心|哭了|呜呜|555|崩溃|心疼|痛苦|好惨|可怜|委屈|哭死|泪目|emo|破防)/.test(trimmed)) return "128557";
    // Laughing / funny → 😂 激动 (128514)
    if (/(哈哈|笑死|搞笑|太逗|乐了|笑喷|好好笑|lol|hahaha|233|xswl|笑不活)/.test(trimmed)) return "128514";
    // Praise / admiration → 👍 厉害 (128077)
    if (/(厉害|牛[逼比啊]?|强|棒|优秀|大佬|膜拜|佩服|666|nb|nice|amazing|awesome|绝绝子|yyds)/.test(trimmed)) return "128077";
    // Shock / disbelief → 🔥 火 (128293)
    if (/(卧槽|天哪|我去|绝了|离谱|无语|震惊|不敢信|what|omg|wow|我靠|真的假的|服了|裂开)/.test(trimmed)) return "128293";
    // Encouragement / fighting → 💪 肌肉 (128170)
    if (/(加油|冲[!！鸭呀]?|奋斗|努力|坚持|fighting|go|干巴爹|拼了|冲冲冲)/.test(trimmed)) return "128170";
    // Love / affection → 💓 爱心 (128147)
    if (/(喜欢|爱你|爱了|么么|mua|比心|❤|💕|亲亲|宝贝|老婆|老公|心动|恋爱)/.test(trimmed)) return "128147";
    // Celebration / congrats → 🎉 庆祝 (127881)
    if (/(恭喜|祝贺|太好了|成功|过了|上岸|录取|中了|赢了|发财|好运|撒花|万岁)/.test(trimmed)) return "127881";
    // Cute / shy → 😊 嘿嘿 (128522)
    if (/(嘿嘿|害羞|脸红|可爱|萌|卖萌|略略|嘻嘻|hiahia|撒娇)/.test(trimmed)) return "128522";
    // Angry / annoyed → 🔥 火 (128293)
    if (/(生气|气死|烦死|讨厌|滚|怒|垃圾|狗屎|fuck|shit|mmp)/.test(trimmed)) return "128293";
    // Sleepy / tired → 💤 睡觉 (128164)
    if (/(困了|好累|累死|好困|打哈欠|要睡了|晚安|摸鱼|划水|摆烂|躺平)/.test(trimmed)) return "128164";
    // Doge / meme → 👍 厉害 (128077)
    if (/(doge|狗头|滑稽|手动狗头)/.test(trimmed)) return "128077";
    // Eating / food → 🍻 干杯 (127867)
    if (/(吃[了饭]|好饿|饿了|干饭|美食|好吃|真香|馋)/.test(trimmed)) return "127867";
    // Sparkle / pretty → ✨ 闪光 (10024)
    if (/(闪闪|好看|漂亮|美丽|好美|颜值|仙女|帅|炫|华丽)/.test(trimmed)) return "10024";
    // Curious / chatty / playful → QQ系统:喵喵(307)
    if (/(为什么|怎么回事|怎么了|咋了|啥意思|什么意思|说说|聊聊|讲讲|想知道|好奇|有趣|好玩|无聊|随便|陪我|逗我)/.test(trimmed)) return "307";

    // --- Task / question patterns → 👌 好的 (128076) ---
    if (/[?？吗呢吧么]$/.test(trimmed)) return "128076";
    if (trimmed.startsWith('/')) return "128076";
    if (/https?:\/\//.test(trimmed)) return "128076";
    if (/^(帮我|请帮|能不能|可以帮|麻烦|请问|查|翻译|设置|打开|关闭|发送|提醒|计算|搜索|下载|上传|生成|创建|删除|修改|更新|运行|执行|分析|总结|整理|推荐|对比|比较|转发|获取)/.test(trimmed)) return "128076";

    // --- Default fallback → QQ系统:喵喵(307) ---
    return "307";
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

            // --- 群精华消息通知 ---
            if (event.post_type === "notice" && event.notice_type === "essence" && event.group_id) {
                const gid = event.group_id;
                const subType = event.sub_type; // 'add' | 'delete'
                const senderId = event.sender_id || event.user_id;
                const operatorId = event.operator_id;
                const msgId = event.message_id;

                if (config.enableEssenceMsg) {
                    let senderName = senderId ? getCachedMemberName(String(gid), String(senderId)) || String(senderId) : "未知";
                    let operatorName = operatorId ? getCachedMemberName(String(gid), String(operatorId)) || String(operatorId) : "未知";

                    if (subType === "add") {
                        client.sendGroupMsg(gid, `[精华消息] ${operatorName} 设置了 ${senderName} 的消息为精华消息 (ID: ${msgId})`);
                    } else if (subType === "delete") {
                        client.sendGroupMsg(gid, `[精华消息] ${operatorName} 移出了 ${senderName} 的精华消息 (ID: ${msgId})`);
                    }
                }
                console.log(`[QQ] Essence ${subType}: group=${gid}, sender=${senderId}, operator=${operatorId}, msgId=${msgId}`);
                return;
            }

            // --- 群管理员变动通知 ---
            if (event.post_type === "notice" && event.notice_type === "group_admin" && event.group_id) {
                const gid = event.group_id;
                const uid = event.user_id;
                const subType = event.sub_type; // 'set' | 'unset'
                const name = uid ? getCachedMemberName(String(gid), String(uid)) || String(uid) : "未知";
                if (subType === "set") {
                    console.log(`[QQ] Group admin set: group=${gid}, user=${uid}`);
                } else {
                    console.log(`[QQ] Group admin unset: group=${gid}, user=${uid}`);
                }
                return;
            }

            // --- 群成员增减通知 ---
            if (event.post_type === "notice" && (event.notice_type === "group_increase" || event.notice_type === "group_decrease") && event.group_id) {
                const gid = event.group_id;
                const uid = event.user_id;
                const operatorId = event.operator_id;
                if (event.notice_type === "group_increase") {
                    console.log(`[QQ] Group member joined: group=${gid}, user=${uid}, operator=${operatorId}`);
                    // Refresh member cache
                    bulkCachedGroups.delete(String(gid));
                } else {
                    console.log(`[QQ] Group member left: group=${gid}, user=${uid}, sub_type=${event.sub_type}, operator=${operatorId}`);
                    memberCache.delete(`${gid}:${uid}`);
                    bulkCachedGroups.delete(String(gid));
                }
                return;
            }

            // --- 群禁言通知 ---
            if (event.post_type === "notice" && event.notice_type === "group_ban" && event.group_id) {
                const gid = event.group_id;
                const uid = event.user_id;
                const operatorId = event.operator_id;
                const duration = event.duration || 0;
                const subType = event.sub_type; // 'ban' | 'lift_ban'
                console.log(`[QQ] Group ban ${subType}: group=${gid}, user=${uid}, operator=${operatorId}, duration=${duration}`);
                return;
            }

            // --- 群文件上传通知 ---
            if (event.post_type === "notice" && event.notice_type === "group_upload" && event.group_id) {
                console.log(`[QQ] Group file upload: group=${event.group_id}, user=${event.user_id}`);
                return;
            }

            // --- 群名片变更通知 ---
            if (event.post_type === "notice" && event.notice_type === "group_card" && event.group_id) {
                const uid = event.user_id;
                const gid = event.group_id;
                if (uid && event.card_new) {
                    setCachedMemberName(String(gid), String(uid), event.card_new);
                }
                console.log(`[QQ] Group card changed: group=${gid}, user=${uid}, old=${event.card_old}, new=${event.card_new}`);
                return;
            }

            // --- 好友添加通知 ---
            if (event.post_type === "notice" && event.notice_type === "friend_add") {
                console.log(`[QQ] Friend added: user=${event.user_id}`);
                return;
            }

            // --- 群荣誉变更/红包运气王/头衔变更通知 ---
            if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type !== "poke") {
                if (event.sub_type === "honor") {
                    console.log(`[QQ] Group honor: group=${event.group_id}, user=${event.user_id}, honor_type=${event.honor_type}`);
                } else if (event.sub_type === "lucky_king") {
                    console.log(`[QQ] Lucky king: group=${event.group_id}, user=${event.user_id}, target=${event.target_id}`);
                } else if (event.sub_type === "title") {
                    console.log(`[QQ] Title change: group=${event.group_id}, user=${event.user_id}, title=${event.title}`);
                }
                return;
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

            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            if (replyMsgId) {
                try { repliedMsg = await client.getMsg(replyMsgId); } catch (err) {}
            }

            // Extract first at-target from message segments or raw_message for command use
            function getCommandAtTarget(): number | null {
                // First try message segments (most reliable)
                if (Array.isArray(event.message)) {
                    for (const seg of event.message as OneBotMessageSegment[]) {
                        if (seg.type === "at" && seg.data?.qq && seg.data.qq !== "all") {
                            // Skip at-mentions targeting the bot itself
                            const selfId = client.getSelfId();
                            if (selfId && String(seg.data.qq) === String(selfId)) continue;
                            const id = parseInt(String(seg.data.qq), 10);
                            if (!isNaN(id)) return id;
                        }
                    }
                }
                // Fallback to CQ code in raw_message
                const rawMatch = event.raw_message?.match(/\[CQ:at,qq=(\d+)\]/);
                if (rawMatch) {
                    const id = parseInt(rawMatch[1], 10);
                    const selfId = client.getSelfId();
                    if (selfId && id === selfId) return null;
                    return id;
                }
                return null;
            }

            // Strip @mentions and leading whitespace to extract the command
            const cmdText = text.replace(/@\S+\s*/g, "").trim();

            // 中文关键词 → 斜杠命令映射
            const cmdAliasMap: Record<string, string> = {
                "群打卡": "/signin", "打卡": "/signin", "签到": "/signin",
                "戳一戳": "/poke", "戳他": "/poke", "戳她": "/poke",
                "点赞": "/like", "赞他": "/like", "赞她": "/like",
                "禁言": "/mute", "解除禁言": "/unmute", "解禁": "/unmute",
                "全员禁言": "/muteall", "解除全员禁言": "/unmuteall",
                "踢人": "/kick", "踢出": "/kick",
                "设管理": "/admin", "取消管理": "/unadmin",
                "设头衔": "/title", "设置头衔": "/title",
                "设名片": "/card", "设置名片": "/card", "改名片": "/card",
                "改群名": "/groupname", "修改群名": "/groupname",
                "发公告": "/notice", "群公告": "/notice",
                "群荣誉": "/honor", "荣誉": "/honor",
                "精华消息": "/essence", "精华列表": "/essence",
                "设精华": "/setessence", "设为精华": "/setessence",
                "取消精华": "/delessence", "移出精华": "/delessence",
                "禁言列表": "/banlist", "查禁言": "/banlist",
                "全体剩余": "/atall",
                "清缓存": "/cache", "清理缓存": "/cache",
                "状态": "/status", "帮助": "/help", "命令": "/help",
            };

            // Try to resolve Chinese alias: match the longest prefix
            let resolvedCmdText = cmdText;
            if (!cmdText.startsWith('/')) {
                for (const [alias, slashCmd] of Object.entries(cmdAliasMap)) {
                    if (cmdText === alias || cmdText.startsWith(alias + " ") || cmdText.startsWith(alias + "\n")) {
                        resolvedCmdText = slashCmd + cmdText.slice(alias.length);
                        break;
                    }
                }
            }

            if (!isGuild && isAdmin && resolvedCmdText.startsWith('/')) {
                const parts = resolvedCmdText.split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]\n` +
                        `--- 基础命令 ---\n` +
                        `/status (状态) - 机器人状态\n` +
                        `/help (帮助) - 显示帮助\n` +
                        `/cache (清缓存) - 清理缓存\n` +
                        `--- 群管理 ---\n` +
                        `/mute (禁言) @用户 [分钟]\n` +
                        `/unmute (解禁) @用户\n` +
                        `/muteall (全员禁言)\n` +
                        `/unmuteall (解除全员禁言)\n` +
                        `/kick (踢人) @用户\n` +
                        `/admin (设管理) @用户\n` +
                        `/unadmin (取消管理) @用户\n` +
                        `/title (设头衔) @用户 头衔\n` +
                        `/card (设名片) @用户 名片\n` +
                        `/groupname (改群名) 名称\n` +
                        `/notice (发公告) 公告内容\n` +
                        `--- 互动功能 ---\n` +
                        `/poke (戳一戳) @用户\n` +
                        `/like (点赞) @用户 [次数]\n` +
                        `/signin (打卡/签到)\n` +
                        `--- 信息查询 ---\n` +
                        `/honor (群荣誉)\n` +
                        `/banlist (禁言列表)\n` +
                        `/atall (全体剩余)\n` +
                        `--- 精华消息 ---\n` +
                        `/essence (精华列表)\n` +
                        `/setessence (设精华) - 回复消息使用\n` +
                        `/delessence (取消精华) - 回复消息使用\n` +
                        `\n支持斜杠命令和中文关键词两种触发方式`;
                    if (isGroup) client.sendGroupMsg(groupId, helpMsg); else client.sendPrivateMsg(userId, helpMsg);
                    return;
                }
                if (isGroup && (cmd === '/mute' || cmd === '/ban')) {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        const duration = parts[parts.length - 1] ? parseInt(parts[parts.length - 1]) : NaN;
                        client.setGroupBan(groupId, targetId, !isNaN(duration) && duration > 0 ? duration * 60 : 1800);
                        client.sendGroupMsg(groupId, `已禁言。`);
                    }
                    return;
                }
                if (isGroup && cmd === '/kick') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupKick(groupId, targetId);
                        client.sendGroupMsg(groupId, `已踢出。`);
                    }
                    return;
                }
                // /unmute @用户 - 解除禁言
                if (isGroup && cmd === '/unmute') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupBan(groupId, targetId, 0);
                        client.sendGroupMsg(groupId, `已解除禁言。`);
                    }
                    return;
                }
                // /muteall - 全员禁言
                if (isGroup && cmd === '/muteall') {
                    try {
                        await client.setGroupWholeBan(groupId, true);
                        client.sendGroupMsg(groupId, `已开启全员禁言。`);
                    } catch (e) {
                        client.sendGroupMsg(groupId, `全员禁言失败: ${e}`);
                    }
                    return;
                }
                // /unmuteall - 解除全员禁言
                if (isGroup && cmd === '/unmuteall') {
                    try {
                        await client.setGroupWholeBan(groupId, false);
                        client.sendGroupMsg(groupId, `已解除全员禁言。`);
                    } catch (e) {
                        client.sendGroupMsg(groupId, `解除全员禁言失败: ${e}`);
                    }
                    return;
                }
                // /poke @用户 - 戳一戳
                if (isGroup && cmd === '/poke') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        try {
                            await client.sendPoke(targetId, groupId);
                            client.sendGroupMsg(groupId, `已戳 ${targetId}。`);
                        } catch (e) {
                            // Fallback to group_poke
                            client.sendGroupPoke(groupId, targetId);
                        }
                    }
                    return;
                }
                // /like @用户 [次数] - 点赞
                if (cmd === '/like') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        // Last numeric part is the times count
                        const lastPart = parts[parts.length - 1];
                        const timesNum = lastPart ? parseInt(lastPart) : NaN;
                        const times = !isNaN(timesNum) && timesNum > 0 ? Math.min(timesNum, 20) : 10;
                        try {
                            await client.sendLike(targetId, times);
                            const reply = `已给 ${targetId} 点赞 ${times} 次。`;
                            if (isGroup) client.sendGroupMsg(groupId, reply); else client.sendPrivateMsg(userId, reply);
                        } catch (e) {
                            const reply = `点赞失败: ${e}`;
                            if (isGroup) client.sendGroupMsg(groupId, reply); else client.sendPrivateMsg(userId, reply);
                        }
                    }
                    return;
                }
                // /admin @用户 - 设置管理员
                if (isGroup && cmd === '/admin') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        try {
                            await client.setGroupAdmin(groupId, targetId, true);
                            client.sendGroupMsg(groupId, `已设置 ${targetId} 为管理员。`);
                        } catch (e) {
                            client.sendGroupMsg(groupId, `设置管理员失败: ${e}`);
                        }
                    }
                    return;
                }
                // /unadmin @用户 - 取消管理员
                if (isGroup && cmd === '/unadmin') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        try {
                            await client.setGroupAdmin(groupId, targetId, false);
                            client.sendGroupMsg(groupId, `已取消 ${targetId} 的管理员。`);
                        } catch (e) {
                            client.sendGroupMsg(groupId, `取消管理员失败: ${e}`);
                        }
                    }
                    return;
                }
                // /title @用户 头衔 - 设置专属头衔
                if (isGroup && cmd === '/title') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    // parts: ["/title", "QQ号或@名", "头衔..."] — 取第2个之后的部分作为头衔
                    const titleText = parts.slice(2).join(" ") || (parts[1] && isNaN(parseInt(parts[1])) ? "" : "");
                    if (targetId) {
                        try {
                            await client.setGroupSpecialTitle(groupId, targetId, titleText);
                            client.sendGroupMsg(groupId, titleText ? `已设置 ${targetId} 的头衔为: ${titleText}` : `已清除 ${targetId} 的头衔。`);
                        } catch (e) {
                            client.sendGroupMsg(groupId, `设置头衔失败: ${e}`);
                        }
                    }
                    return;
                }
                // /card @用户 名片 - 设置群名片
                if (isGroup && cmd === '/card') {
                    const targetId = getCommandAtTarget() || (parts[1] ? parseInt(parts[1]) : null);
                    const cardText = parts.slice(2).join(" ") || "";
                    if (targetId) {
                        try {
                            await client.setGroupCard(groupId, targetId, cardText);
                            client.sendGroupMsg(groupId, cardText ? `已设置 ${targetId} 的群名片为: ${cardText}` : `已清除 ${targetId} 的群名片。`);
                        } catch (e) {
                            client.sendGroupMsg(groupId, `设置群名片失败: ${e}`);
                        }
                    }
                    return;
                }
                // /groupname 名称 - 修改群名
                if (isGroup && cmd === '/groupname') {
                    const newName = resolvedCmdText.slice(cmd.length).trim();
                    if (newName) {
                        try {
                            await client.setGroupName(groupId, newName);
                            client.sendGroupMsg(groupId, `群名已修改为: ${newName}`);
                        } catch (e) {
                            client.sendGroupMsg(groupId, `修改群名失败: ${e}`);
                        }
                    }
                    return;
                }
                // /banlist - 查看禁言列表
                if (isGroup && cmd === '/banlist') {
                    try {
                        const banList = await client.getGroupBanList(groupId);
                        if (banList && banList.length > 0) {
                            let msg = `[禁言列表] 共${banList.length}人\n`;
                            for (const b of banList.slice(0, 20)) {
                                const name = getCachedMemberName(String(groupId), String(b.user_id)) || String(b.user_id);
                                msg += `${name} (${b.user_id})`;
                                if (b.ban_time) msg += ` - 剩余${Math.ceil(b.ban_time / 60)}分钟`;
                                msg += "\n";
                            }
                            client.sendGroupMsg(groupId, msg.trim());
                        } else {
                            client.sendGroupMsg(groupId, `当前无禁言成员。`);
                        }
                    } catch (e) {
                        client.sendGroupMsg(groupId, `获取禁言列表失败: ${e}`);
                    }
                    return;
                }
                // /atall - 查看@全体剩余次数
                if (isGroup && cmd === '/atall') {
                    try {
                        const remain = await client.getGroupAtAllRemain(groupId);
                        if (remain) {
                            client.sendGroupMsg(groupId, `[@ 全体成员] 今日剩余: 群内 ${remain.can_at_all ? '可用' : '不可用'}，剩余 ${remain.remain_at_all_count_for_group ?? '未知'} 次 (管理员剩余 ${remain.remain_at_all_count_for_uin ?? '未知'} 次)`);
                        }
                    } catch (e) {
                        client.sendGroupMsg(groupId, `获取@全体剩余次数失败: ${e}`);
                    }
                    return;
                }
                // NapCat 4.17.25 新命令
                if (isGroup && cmd === '/notice') {
                    const noticeText = resolvedCmdText.slice(cmd.length).trim();
                    if (noticeText) {
                        try {
                            await client.sendGroupNotice(groupId, noticeText);
                            client.sendGroupMsg(groupId, `公告已发送。`);
                        } catch (e) {
                            client.sendGroupMsg(groupId, `公告发送失败: ${e}`);
                        }
                    }
                    return;
                }
                if (isGroup && cmd === '/signin') {
                    try {
                        // 尝试 set_group_sign (NapCat推荐) 和 send_group_sign_in 两种API
                        try {
                            await client.setGroupSign(groupId);
                        } catch {
                            await client.sendGroupSignIn(groupId);
                        }
                        client.sendGroupMsg(groupId, `打卡成功！`);
                    } catch (e) {
                        client.sendGroupMsg(groupId, `打卡失败: ${e}`);
                    }
                    return;
                }
                if (isGroup && cmd === '/honor') {
                    try {
                        const honor = await client.getGroupHonorInfo(groupId, "all");
                        if (honor) {
                            let msg = `[群荣誉信息]\n`;
                            if (honor.current_nickname) msg += `群昵称: ${honor.current_nickname}\n`;
                            if (honor.day_count !== undefined) msg += `群聊等级: ${honor.day_count}\n`;
                            client.sendGroupMsg(groupId, msg);
                        }
                    } catch (e) {
                        client.sendGroupMsg(groupId, `获取荣誉失败: ${e}`);
                    }
                    return;
                }
                if (isGroup && cmd === '/essence') {
                    try {
                        const essence = await client.getGroupEssenceMsgList(groupId);
                        if (essence && essence.length > 0) {
                            const msg = `[精华消息] 共${essence.length}条`;
                            client.sendGroupMsg(groupId, msg);
                        } else {
                            client.sendGroupMsg(groupId, `暂无精华消息。回复某条消息并输入"/setessence"设为精华`);
                        }
                    } catch (e) {
                        client.sendGroupMsg(groupId, `获取精华消息失败: ${e}`);
                    }
                    return;
                }
                if (isGroup && cmd === '/setessence' && replyMsgId) {
                    try {
                        await client.setEssenceMsg(replyMsgId);
                        client.sendGroupMsg(groupId, `已设为精华消息。`);
                    } catch (e) {
                        client.sendGroupMsg(groupId, `设置精华失败: ${e}`);
                    }
                    return;
                }
                if (isGroup && cmd === '/delessence' && replyMsgId) {
                    try {
                        await client.deleteEssenceMsg(replyMsgId);
                        client.sendGroupMsg(groupId, `已移出精华消息。`);
                    } catch (e) {
                        client.sendGroupMsg(groupId, `移出精华失败: ${e}`);
                    }
                    return;
                }
                if (cmd === '/cache') {
                    if (isAdmin) {
                        try {
                            await client.cleanCache();
                            const cacheMsg = `缓存已清理。`;
                            if (isGroup) client.sendGroupMsg(groupId, cacheMsg); else client.sendPrivateMsg(userId, cacheMsg);
                        } catch (e) {
                            const errMsg = `清理缓存失败: ${e}`;
                            if (isGroup) client.sendGroupMsg(groupId, errMsg); else client.sendPrivateMsg(userId, errMsg);
                        }
                    }
                    return;
                }
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
                try { await client.setMsgEmojiLike(event.message_id, config.reactionEmoji); } catch (e) {}
            }

            // Auto reaction mode: local OK emoji for non-greeting messages + AI [reaction:ID] for emotion
            const isAutoReaction = config.reactionEmoji === "auto";

            // Local detection: immediately send context-aware emoji for non-greeting/thanks messages
            let localEmojiSent: string | null = null;
            if (isAutoReaction && event.message_id) {
                const cleanText = cleanCQCodes(text).trim();
                const emojiId = pickLocalEmoji(cleanText);
                if (emojiId) {
                    try {
                        await client.setMsgEmojiLike(event.message_id, emojiId);
                        localEmojiSent = emojiId;
                    } catch (e) {}
                }
            }

            // NapCat 4.17.25: URL safety check
            if (config.enableUrlCheck && Array.isArray(event.message)) {
                for (const seg of event.message) {
                    if (seg.type === "text") {
                        const urlRegex = /https?:\/\/[^\s]+/g;
                        const urls = seg.data?.text?.match(urlRegex);
                        if (urls) {
                            for (const url of urls) {
                                try {
                                    const safe = await client.checkUrlSafely(url);
                                    if (safe?.level && safe.level > 1) {
                                        console.log(`[QQ] URL unsafe: ${url}, level: ${safe.level}`);
                                        text = text.replace(url, "[链接已拦截]");
                                    }
                                } catch (e) {}
                            }
                        }
                    }
                }
            }

            // NapCat 4.17.25: Image OCR
            let ocrText = "";
            if (config.enableOcr && Array.isArray(event.message)) {
                for (const seg of event.message) {
                    if (seg.type === "image") {
                        const imgUrl = seg.data?.url || seg.data?.file;
                        if (imgUrl) {
                            try {
                                const ocr = await client.ocrImage(imgUrl);
                                if (ocr?.texts) {
                                    ocrText = ocr.texts.map((t: any) => t.text).join(" ");
                                    console.log(`[QQ] OCR result: ${ocrText.slice(0, 100)}...`);
                                }
                            } catch (e) {}
                        }
                    }
                }
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

                     // Extract reaction/task marker from AI reply (supplements local detection)
                     if (isAutoReaction && event.message_id) {
                         const taskEmojiOnlyMatch = processed.match(/^\[task:emoji_only\]\s*/);
                         if (taskEmojiOnlyMatch) {
                             if (!localEmojiSent) {
                                 try { await client.setMsgEmojiLike(event.message_id, "128076"); } catch (e) {}
                             }
                             processed = processed.slice(taskEmojiOnlyMatch[0].length);
                         } else {
                             const taskMatch = processed.match(/^\[task:ok\]\s*/);
                             if (taskMatch) {
                                 if (!localEmojiSent) {
                                     try { await client.setMsgEmojiLike(event.message_id, "128076"); } catch (e) {}
                                 }
                                 processed = processed.slice(taskMatch[0].length);
                             } else {
                                 // AI-chosen emotion emoji — send if different from local emoji
                                 const reactionMatch = processed.match(/^\[reaction:(\d+)\]\s*/);
                                 if (reactionMatch) {
                                     if (reactionMatch[1] !== localEmojiSent) {
                                         try { await client.setMsgEmojiLike(event.message_id, reactionMatch[1]); } catch (e) {}
                                     }
                                     processed = processed.slice(reactionMatch[0].length);
                                 }
                             }
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
                systemBlock += `<reaction-instruction>
【规则】如果用户消息是闲聊、情感表达、夸奖、吐槽、搞笑等非任务类内容，你必须在回复最开头加上一个表情标记 [reaction:表情ID]。
任务类请求和普通问候/感谢不需要加标记，正常回复即可。

可用表情ID：128077(👍) 128079(👏) 128293(🔥) 128516(😄) 128514(😂) 128522(😊) 128536(😘) 128170(💪) 128147(❤) 10024(✨) 127881(🎉) 128557(😭)

示例（严格按此格式）：
用户：哈哈太搞笑了 → [reaction:128514]确实太好笑了！
用户：你真厉害 → [reaction:128077]嘿嘿谢谢~
用户：好难过 → [reaction:128557]怎么啦？跟我说说
用户：太棒了 → [reaction:128293]对吧！
用户：不客气 → [reaction:128522]有需要随时叫我～
用户：666 → [reaction:128293]嘿嘿~
用户：帮我查天气 → 好的，我帮你查一下（无标记）
用户：你好 → 你好呀！（无标记）
</reaction-instruction>\n\n`;
            }
            if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
            if (ocrText) systemBlock += `<ocr-text>\n${ocrText}\n</ocr-text>\n\n`;
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
