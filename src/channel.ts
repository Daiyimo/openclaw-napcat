import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { registerClientsMap } from "./proactive.js";

// ── 新增模块 ────────────────────────────────────────────────────────────────
import { installGlobalInterceptor } from "./log-buffer.js";
import { populateGroupMemberCache, getCachedMemberName } from "./member-cache.js";
import {
  extractImageUrls,
  cleanCQCodes,
  getReplyMessageId,
  normalizeTarget,
  parseTarget,
  dispatchMessage,
  splitMessage,
  stripMarkdown,
  processAntiRisk,
  resolveMediaUrl,
  isImageFile,
  transcribeAudioForNapcat,
} from "./message-parser.js";
import { createDeliverDebouncer, type DeliverPayload } from "./deliver-debounce.js";
import { triggerUpdateCheck } from "./update-checker.js";
import { TypingKeepAlive } from "./typing-keepalive.js";
import { UploadCache } from "./upload-cache.js";
import { initRefIndexStore, recordRef, lookupRef, flushRefIndex } from "./ref-index-store.js";
import { handleAdminCommand } from "./admin-commands.js";
import { convertSilkToWav } from "./utils/audio-convert.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
  configured: boolean;
};

// ============================================================
// 客户端注册表（全局，跨账号共用）
// ============================================================

const clients = new Map<string, OneBotClient>();
registerClientsMap(clients);

// ── 入站频控状态（per-account, key = accountId） ─────────────────────────────
interface InboundRateLimitStore {
  lastTrigger: Map<string, number>;
  config: import("./config.js").QQConfig;
}
const inboundStores = new Map<string, InboundRateLimitStore>();

function getClientForAccount(accountId: string) {
  return clients.get(accountId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// 插件定义
// ============================================================

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
        return friends.map((f) => ({
          id: String(f.user_id),
          name: f.remark || f.nickname,
          type: "user" as const,
          metadata: { ...f },
        }));
      } catch {
        return [];
      }
    },
    listGroups: async (params: { accountId?: string; cfg?: any }) => {
      const client = getClientForAccount(params.accountId || DEFAULT_ACCOUNT_ID);
      if (!client) return [];
      try {
        const groups = await client.getGroupList();
        return groups.map((g) => ({
          id: String(g.group_id),
          name: g.group_name,
          type: "group" as const,
          metadata: { ...g },
        }));
      } catch {
        return [];
      }
    },
  },
  status: {
    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.config.wsUrl && !account.config.reverseWsPort)
        return { ok: false, error: "Missing wsUrl or reverseWsPort" };

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
            resolve({ ok: true, bot: { id: String(info.user_id), username: info.nickname } });
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
    },
  },
  setup: {
    resolveAccountId: (params: { accountId?: string | null }) =>
      normalizeAccountId(params.accountId),
    applyAccountName: (params: { cfg: OpenClawConfig; accountId: string; name: string }) =>
      applyAccountNameToChannelSection({
        cfg: params.cfg,
        channelKey: "qq",
        accountId: params.accountId,
        name: params.name,
      }),
    validateInput: (params: { input: any }) => null,
    applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: any }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: params.cfg,
        channelKey: "qq",
        accountId: params.accountId,
        name: params.input.name,
      });

      const next =
        params.accountId !== DEFAULT_ACCOUNT_ID
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
          channels: { ...next.channels, qq: { ...next.channels?.qq, ...newConfig } },
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
                ...newConfig,
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx: {
      account: ResolvedQQAccount;
      cfg: OpenClawConfig;
      abortSignal: AbortSignal;
      log?: any;
      onReady: () => void;
      onError: (error: Error) => void;
    }) => {
      const { account, cfg } = ctx;
      const config = account.config;
      const log = ctx.log ?? console;

      if (!config.wsUrl && !config.reverseWsPort)
        throw new Error("QQ: either wsUrl or reverseWsPort is required");

      // ── 初始化日志缓冲区 ────────────────────────────────
      installGlobalInterceptor(config.logBufferSize ?? 200);

      // ── 注册入站频控状态 ────────────────────────────────
      const lastTrigger = new Map<string, number>();
      inboundStores.set(account.accountId, {
        lastTrigger,
        config,
      });

      // ── 版本检查 ────────────────────────────────────────
      if (config.enableUpdateCheck !== false) {
        triggerUpdateCheck(log);
      }

      // ── 初始化引用索引 ──────────────────────────────────
      initRefIndexStore();

      // ── 上传缓存 ────────────────────────────────────────
      const uploadCache = new UploadCache();

      // ── 防止同账号重复启动 ──────────────────────────────
      const existingClient = clients.get(account.accountId);
      if (existingClient) {
        console.log(
          `[napcat-QQ] Stopping existing client for account ${account.accountId} before restart`,
        );
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
      }, 3_600_000);

      client.on("connect", async () => {
        console.log(`[napcat-QQ] Connected account ${account.accountId}`);
        try {
          const info = await client.getLoginInfo();
          if (info?.user_id) client.setSelfId(info.user_id);
          if (info?.nickname)
            console.log(`[napcat-QQ] Logged in as: ${info.nickname} (${info.user_id})`);
          getQQRuntime().channel.activity.record({
            channel: "qq",
            accountId: account.accountId,
            direction: "inbound",
          });
          ctx.onReady();
        } catch {}
      });

      client.on("message", async (event) => {
        // Extract common fields early for error reporting
        const userId = event.user_id;
        const groupId = event.group_id;
        const guildId = event.guild_id;
        const channelId = event.channel_id;

        try {
          if (event.post_type === "meta_event") {
            if (
              event.meta_event_type === "lifecycle" &&
              event.sub_type === "connect" &&
              event.self_id
            )
              client.setSelfId(event.self_id);
            return;
          }

          // 好友/入群请求自动处理
          if (event.post_type === "request" && config.autoApproveRequests) {
            if (event.request_type === "friend" && event.flag)
              client.setFriendAddRequest(event.flag, true);
            else if (event.request_type === "group" && event.flag && event.sub_type)
              client.setGroupAddRequest(event.flag, event.sub_type, true);
            return;
          }

          // 戳一戳转换为消息事件
          if (
            event.post_type === "notice" &&
            event.notice_type === "notify" &&
            event.sub_type === "poke"
          ) {
            if (String(event.target_id) === String(client.getSelfId())) {
              const isGroupPoke = !!event.group_id;
              event.post_type = "message";
              event.message_type = isGroupPoke ? "group" : "private";
              event.raw_message = `[动作] 用户戳了你一下`;
              event.message = [{ type: "text", data: { text: event.raw_message } }];
              if (isGroupPoke) {
                client.sendGroupPoke(event.group_id!, event.user_id!);
              } else if (event.user_id) {
                client.sendFriendPoke(event.user_id);
              }
            } else return;
          }

          if (event.post_type !== "message") return;

          // 在戳一戳 mutation 之后重新计算，确保 isGroup/isGuild 反映真实消息类型
          const isGroup = event.message_type === "group";
          const isGuild = event.message_type === "guild";

          // 过滤自身消息
          const selfId = client.getSelfId() || event.self_id;
          if (!selfId) {
            // selfId 尚未就绪，丢弃本条消息以防自回环
            console.warn(`[napcat-QQ] selfId not available yet, dropping message from user ${event.user_id}`);
            return;
          }
          if (String(event.user_id) === String(selfId)) return;

          // 消息去重
          if (config.enableDeduplication !== false && event.message_id) {
            const msgIdKey = String(event.message_id);
            if (processedMsgIds.has(msgIdKey)) return;
            processedMsgIds.add(msgIdKey);
          }

          // 自动已读
          if (config.autoMarkRead) {
            try {
              if (isGroup && groupId) client.markGroupMsgAsRead(groupId);
              else if (!isGroup && !isGuild && userId) client.markPrivateMsgAsRead(userId);
            } catch {}
          }

          // 批量预热群成员缓存
          if (isGroup && groupId) {
            await populateGroupMemberCache(client, groupId);
          }

          // ── 消息文本提取 ────────────────────────────────
          let text = event.raw_message || "";

          if (Array.isArray(event.message)) {
            let resolvedText = "";
            for (const seg of event.message) {
              if (seg.type === "text") {
                resolvedText += seg.data?.text || "";
              } else if (seg.type === "at") {
                let name = seg.data?.qq;
                if (name !== "all" && isGroup) {
                  const cached = getCachedMemberName(String(groupId), String(name));
                  if (cached) name = cached;
                }
                resolvedText += ` @${name} `;
              } else if (seg.type === "record") {
                if (config.enableSTT && seg.data?.url) {
                  const tmpDir = os.tmpdir();
                  const tmpFile = path.join(tmpDir, `voice-${Date.now()}.amr`);
                  let wavPath: string | null = null;
                  try {
                    const voiceUrl = seg.data.url;
                    const voiceResp = await fetch(voiceUrl);
                    if (voiceResp.ok) {
                      const buf = await voiceResp.arrayBuffer();
                      fsSync.writeFileSync(tmpFile, Buffer.from(buf));
                      const wavResult = await convertSilkToWav(tmpFile, tmpDir);
                      if (wavResult?.wavPath) {
                        wavPath = wavResult.wavPath;
                        const transcript = await transcribeAudioForNapcat(
                          wavPath,
                          cfg as Record<string, unknown>,
                        );
                        resolvedText += transcript
                          ? ` [语音转文字: ${transcript}]`
                          : ` [语音消息: 转写为空]`;
                      } else {
                        resolvedText += ` [语音消息: 格式不支持]`;
                      }
                    } else {
                      resolvedText += ` [语音消息: 下载失败]`;
                    }
                  } catch (sttErr) {
                    console.warn(`[napcat-QQ] STT failed: ${sttErr}`);
                    resolvedText += ` [语音消息: 转写失败]`;
                  } finally {
                    // 确保临时文件始终被清理
                    try { fsSync.unlinkSync(tmpFile); } catch {}
                    if (wavPath) { try { fsSync.unlinkSync(wavPath); } catch {} }
                  }
                } else {
                  resolvedText += ` [语音消息]${seg.data?.text ? `(${seg.data.text})` : ""}`;
                }
              } else if (seg.type === "image") {
                resolvedText += " [图片]";
              } else if (seg.type === "video") {
                resolvedText += " [视频消息]";
              } else if (seg.type === "json") {
                resolvedText += " [卡片消息]";
              } else if (seg.type === "forward" && seg.data?.id) {
                try {
                  const forwardData = await client.getForwardMsg(seg.data.id);
                  if (forwardData?.messages && Array.isArray(forwardData.messages)) {
                    resolvedText += "\n[转发聊天记录]:";
                    // 最多取前 10 条，跳过内嵌转发（防止递归展开），每条内容最长 200 字符
                    for (const m of forwardData.messages.slice(0, 10)) {
                      const raw = m.content || m.raw_message || "";
                      if (typeof raw === "string" && raw.includes("[CQ:forward")) continue;
                      const preview = cleanCQCodes(raw).slice(0, 200);
                      resolvedText += `\n${m.sender?.nickname || m.user_id}: ${preview}`;
                    }
                  }
                } catch {}
              } else if (seg.type === "file") {
                if (!seg.data?.url && isGroup) {
                  try {
                    const info = await (client as any).sendWithResponse("get_group_file_url", {
                      group_id: groupId,
                      file_id: seg.data?.file_id,
                      busid: seg.data?.busid,
                    });
                    if (info?.url) (seg.data as any).url = info.url;
                  } catch {}
                }
                resolvedText += ` [文件: ${seg.data?.file || "未命名"}]`;
              }
            }
            if (resolvedText) text = resolvedText;
          }

          // ── 过滤规则 ─────────────────────────────────────
          if (config.blockedUsers?.includes(userId!)) return;
          if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId!))
            return;

          const isAdmin = config.admins?.includes(userId!) ?? false;
          if (config.admins?.length && !isAdmin) return;

          // ── 管理员命令 ────────────────────────────────────
          if (!isGuild && isAdmin && text.trim().startsWith("/")) {
            const isCmdMentioned =
              !isGroup ||
              (() => {
                const sid = client.getSelfId() ?? event.self_id;
                if (!sid) return false;
                if (Array.isArray(event.message)) {
                  for (const s of event.message) {
                    if (
                      s.type === "at" &&
                      (String(s.data?.qq) === String(sid) || s.data?.qq === "all")
                    )
                      return true;
                  }
                }
                return text.includes(`[CQ:at,qq=${sid}]`);
              })();

            if (isCmdMentioned) {
              const parts = text.trim().split(/\s+/);
              const cmd = parts[0];
              const handled = await handleAdminCommand(cmd, parts, {
                client,
                isGroup,
                groupId,
                userId,
                text,
                eventTime: event.time ? event.time * 1000 : undefined,
              });
              if (handled) return;
            }
          }

          // ── 获取被引用消息 ────────────────────────────────
          let repliedMsg: any = null;
          const replyMsgId = getReplyMessageId(event.message, text);
          if (replyMsgId) {
            // 先查引用索引
            const refEntry = lookupRef(replyMsgId);
            if (refEntry) {
              repliedMsg = {
                sender: { nickname: refEntry.sender, user_id: refEntry.senderId },
                raw_message: refEntry.text,
                message: refEntry.text,
              };
            } else {
              try {
                repliedMsg = await client.getMsg(replyMsgId);
              } catch {}
            }
          }

          // ── 历史上下文 ────────────────────────────────────
          let historyContext = "";
          if (isGroup && config.historyLimit !== 0) {
            try {
              const limit = config.historyLimit || 5;
              const history = await client.getGroupMsgHistory(groupId!, limit + 1);
              if (history?.messages) {
                historyContext = history.messages
                  .slice(-(limit + 1), -1)
                  .map(
                    (m: any) =>
                      `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`,
                  )
                  .join("\n");
              }
            } catch {}
          }

          // ── 触发检测 ──────────────────────────────────────
          let isTriggered = !isGroup || text.includes("[动作] 用户戳了你一下");

          const checkMention = isGroup || isGuild;
          let isMentioned = false;
          if (checkMention) {
            const effectiveSelfId = client.getSelfId() ?? event.self_id;
            if (!effectiveSelfId) return;
            if (Array.isArray(event.message)) {
              for (const s of event.message) {
                if (
                  s.type === "at" &&
                  (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")
                ) {
                  isMentioned = true;
                  break;
                }
              }
            } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) {
              isMentioned = true;
            }
            if (!isMentioned && repliedMsg?.sender?.user_id === effectiveSelfId) isMentioned = true;
          }

          if (!isTriggered && config.keywordTriggers) {
            for (const kw of config.keywordTriggers) {
              if (text.includes(kw)) { isTriggered = true; break; }
            }
          }

          if (checkMention && config.requireMention && !isTriggered && !isMentioned) return;

          // ── 记录入站消息到引用索引 ────────────────────────
          if (event.message_id) {
            recordRef({
              msgId: String(event.message_id),
              text: cleanCQCodes(text),
              sender: event.sender?.card || event.sender?.nickname || String(userId),
              senderId: String(userId),
              timestamp: (event.time ?? Date.now() / 1000) * 1000,
              accountId: account.accountId,
            });
          }

          // ── 实际发送函数 ──────────────────────────────────
          const actualDeliver = async (payload: ReplyPayload) => {
            const send = async (msg: string) => {
              let processed = msg;
              const effectiveMarkdownMode =
                config.markdownMode ?? (config.formatMarkdown ? "strip" : "passthrough");
              if (effectiveMarkdownMode === "strip") processed = stripMarkdown(processed);
              if (config.antiRiskMode) processed = processAntiRisk(processed);
              const chunks = splitMessage(processed, config.maxMessageLength || 4000);
              for (let i = 0; i < chunks.length; i++) {
                let chunk = chunks[i];

                if (effectiveMarkdownMode === "native") {
                  const mdSegments: OneBotMessage = [];
                  if (isGroup && i === 0)
                    mdSegments.push({ type: "at", data: { qq: String(userId) } });
                  mdSegments.push({ type: "markdown", data: { content: chunk } });
                  if (isGroup) await client.sendGroupMsg(groupId!, mdSegments);
                  else if (isGuild) client.sendGuildChannelMsg(guildId!, channelId!, mdSegments);
                  else await client.sendPrivateMsg(userId!, mdSegments);
                } else {
                  if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                  if (isGroup) await client.sendGroupMsg(groupId!, chunk);
                  else if (isGuild) client.sendGuildChannelMsg(guildId!, channelId!, chunk);
                  else await client.sendPrivateMsg(userId!, chunk);
                }

                if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
                  const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                  if (tts) {
                    try {
                      if (isGroup && config.aiVoiceId) {
                        await client.sendGroupAiRecord(groupId!, tts, config.aiVoiceId);
                      } else if (isGroup) {
                        client.sendGroupMsg(groupId!, `[CQ:tts,text=${tts}]`);
                      } else {
                        client.sendPrivateMsg(userId!, `[CQ:tts,text=${tts}]`);
                      }
                    } catch {}
                  }
                }

                if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
              }
            };

            if (payload.text) await send(payload.text);

            if (payload.files) {
              for (const f of payload.files) {
                if (f.url) {
                  // 检查上传缓存
                  const cacheKey = uploadCache.buildKey(account.accountId, f.url);
                  const cachedFileId = uploadCache.get(cacheKey);

                  if (cachedFileId) {
                    // 命中缓存，直接使用 file_id
                    console.log(`[napcat-QQ] Upload cache hit for ${f.url}`);
                    const txtMsg = `[CQ:file,file=${cachedFileId},name=${f.name || "file"}]`;
                    if (isGroup) await client.sendGroupMsg(groupId!, txtMsg);
                    else if (isGuild)
                      client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${f.url}`);
                    else await client.sendPrivateMsg(userId!, txtMsg);
                  } else {
                    const url = await resolveMediaUrl(f.url);
                    if (isImageFile(url) || isImageFile(f.url)) {
                      const imgMsg = `[CQ:image,file=${url}]`;
                      if (isGroup) await client.sendGroupMsg(groupId!, imgMsg);
                      else if (isGuild)
                        client.sendGuildChannelMsg(guildId!, channelId!, imgMsg);
                      else await client.sendPrivateMsg(userId!, imgMsg);
                    } else {
                      const fileName = f.name || "file";
                      try {
                        if (isGroup) {
                          await client.uploadGroupFile(groupId!, url, fileName);
                          uploadCache.set(cacheKey, url);
                        } else if (!isGuild) {
                          await client.uploadPrivateFile(userId!, url, fileName);
                          uploadCache.set(cacheKey, url);
                        } else {
                          client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
                        }
                      } catch {
                        const txtMsg = `[CQ:file,file=${url},name=${fileName}]`;
                        if (isGroup) await client.sendGroupMsg(groupId!, txtMsg);
                        else if (isGuild)
                          client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
                        else await client.sendPrivateMsg(userId!, txtMsg);
                      }
                    }
                  }

                  if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                }
              }
            }
          };

          // ── Deliver Debouncer 包装 ─────────────────────────
          const debouncer = createDeliverDebouncer(
            config.deliverDebounce,
            (p, _info) => actualDeliver(p as ReplyPayload),
            log,
            `[napcat-QQ][debounce]`,
          );

          const deliver = async (payload: ReplyPayload) => {
            if (debouncer) {
              await debouncer.deliver(payload as DeliverPayload, { kind: "reply" });
            } else {
              await actualDeliver(payload);
            }
          };

          // ── 智能表情回应 ──────────────────────────────────
          if (config.enableReactions && event.message_id) {
            try {
              const t = text;
              let emojiId = "307"; // 喵喵

              if (/查找|查询|搜索|检查|检测|查看|打开|获取|看看|找|搜/.test(t)) emojiId = "124";
              else if (/好的|收到|确认|明白|了解|知道了|好|没问题|OK|ok/.test(t)) emojiId = "76";
              else if (/谢谢|感谢|谢了|多谢|感激/.test(t)) emojiId = "297";
              else if (/加油|继续|努力|坚持|棒|厉害|牛|强/.test(t)) emojiId = "315";
              else if (/哈哈|开心|高兴|快乐|好玩|有趣|笑|嘻嘻/.test(t)) emojiId = "99";
              else if (/难过|悲伤|伤心|哭|呜|唉|可怜|失落/.test(t)) emojiId = "5";
              else if (/生气|愤怒|气死|烦|滚|讨厌|恼火/.test(t)) emojiId = "326";
              else if (/[?？]|为什么|怎么|啥|什么|不懂|不明白|疑问/.test(t)) emojiId = "32";
              else if (/哇|惊|震惊|不会吧|真的吗|卧槽|天啊|没想到/.test(t)) emojiId = "180";
              else if (/喜欢|爱|爱你|心动|可爱|萌/.test(t)) emojiId = "66";
              else if (/你好|早|晚安|嗨|hi|hello|Hey|hey/.test(t)) emojiId = "14";
              else if (/帮|请|麻烦|劳烦|能不能|可以吗|求/.test(t)) emojiId = "118";
              else if (/吃|饿|饭|食|喝|美食/.test(t)) emojiId = "53";
              else if (/睡|困|累|休息|晚安|倦/.test(t)) emojiId = "8";

              await client.setMsgEmojiLike(event.message_id, emojiId);
            } catch {}
          }

          // ── 会话上下文构建 ────────────────────────────────
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
          const { dispatcher, replyOptions } =
            runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

          let replyToBody = "";
          let replyToSender = "";
          if (replyMsgId && repliedMsg) {
            replyToBody = cleanCQCodes(
              typeof repliedMsg.message === "string"
                ? repliedMsg.message
                : repliedMsg.raw_message || "",
            );
            replyToSender =
              repliedMsg.sender?.nickname ||
              repliedMsg.sender?.card ||
              String(repliedMsg.sender?.user_id || "");
          }

          const replySuffix = replyToBody
            ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]`
            : "";
          let bodyWithReply = cleanCQCodes(text) + replySuffix;
          let systemBlock = "";
          if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
          if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
          bodyWithReply = systemBlock + bodyWithReply;

          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Provider: "qq",
            Channel: "qq",
            From: fromId,
            To: "qq:bot",
            Body: bodyWithReply,
            RawBody: text,
            SenderId: String(userId),
            SenderName: event.sender?.nickname || "Unknown",
            ConversationLabel: conversationLabel,
            SessionKey: `qq:${fromId}`,
            AccountId: account.accountId,
            ChatType: isGroup ? "group" : isGuild ? "channel" : "direct",
            Timestamp: (event.time ?? Math.floor(Date.now() / 1000)) * 1000,
            OriginatingChannel: "qq",
            OriginatingTo: fromId,
            CommandAuthorized: true,
            ...(extractImageUrls(event.message).length > 0 && {
              MediaUrls: extractImageUrls(event.message),
            }),
            ...(replyMsgId && {
              ReplyToId: replyMsgId,
              ReplyToBody: replyToBody,
              ReplyToSender: replyToSender,
            }),
          });

          await runtime.channel.session.recordInboundSession({
            storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, {
              agentId: "default",
            }),
            sessionKey: ctxPayload.SessionKey!,
            ctx: ctxPayload,
            updateLastRoute: {
              sessionKey: ctxPayload.SessionKey!,
              channel: "qq",
              to: fromId,
              accountId: account.accountId,
            },
            onRecordError: (err) => console.error("QQ Session Error:", err),
          });

          // ── Typing 状态 ───────────────────────────────────
          const typing = new TypingKeepAlive(client, isGroup, groupId, userId);
          typing.start();

          try {
            await runtime.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions,
            });

            // 记录已知用户
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
          } finally {
            // 确保 debouncer 和 typing 在所有情况下都被清理
            if (debouncer) await debouncer.dispose();
            typing.stop();
          }
        } catch (err) {
          console.error("[napcat-QQ] Critical error in message handler:", err);
          if (config.enableErrorNotify && config.admins?.length) {
            try {
              const errorMsg =
                `⚠️ 消息处理异常\n用户: ${userId}\n群组: ${groupId ?? "私聊"}\n` +
                `错误: ${err instanceof Error ? err.message : String(err)}`;
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

      // 等待 abort 信号，保持 startAccount 挂起直到 OpenClaw 发出关闭信号
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) { resolve(); return; }
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      clearInterval(cleanupInterval);
      flushKnownUsers();
      flushRefIndex();
      uploadCache.dispose();
      client.disconnect();
      clients.delete(account.accountId);
      // 只删除本次启动注册的 store，避免覆盖新账号的 store
      const currentStore = inboundStores.get(account.accountId);
      if (currentStore?.lastTrigger === lastTrigger) {
        inboundStores.delete(account.accountId);
      }
    },
    logoutAccount: async ({ accountId, cfg }) => {
      return { loggedOut: true, cleared: true };
    },
  },
  outbound: {
    sendText: async ({ to, text, accountId, replyTo }) => {
      if (!to || to === "heartbeat") return { channel: "qq", sent: true };
      console.log(
        `[napcat-QQ][outbound.sendText] called: to=${to}, accountId=${accountId}, text=${text?.slice(0, 100)}`,
      );
      const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
      const client = getClientForAccount(resolvedAccountId);
      if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
      try {
        const target = parseTarget(to);
        const chunks = splitMessage(text, 4000);
        for (let i = 0; i < chunks.length; i++) {
          let message: OneBotMessage | string = chunks[i];
          if (replyTo && i === 0)
            message = [
              { type: "reply", data: { id: String(replyTo) } },
              { type: "text", data: { text: chunks[i] } },
            ];
          await dispatchMessage(client, target, message);
          if (chunks.length > 1) await sleep(1000);
        }
        return { channel: "qq", sent: true };
      } catch (err) {
        console.error("[napcat-QQ][outbound.sendText] FAILED:", err);
        return { channel: "qq", sent: false, error: String(err) };
      }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
      if (!to || to === "heartbeat") return { channel: "qq", sent: true };
      const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
      if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
      try {
        const target = parseTarget(to);
        const finalUrl = await resolveMediaUrl(mediaUrl);
        const message: OneBotMessage = [];
        if (replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
        if (text) message.push({ type: "text", data: { text } });
        if (isImageFile(mediaUrl) || isImageFile(finalUrl))
          message.push({ type: "image", data: { file: finalUrl } });
        else
          message.push({
            type: "text",
            data: { text: `[CQ:file,file=${finalUrl},url=${finalUrl}]` },
          });
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
      try {
        client.deleteMsg(messageId);
        return { channel: "qq", success: true };
      } catch (err) {
        return { channel: "qq", success: false, error: String(err) };
      }
    },
  },
  messaging: {
    normalizeTarget,
    targetResolver: {
      looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^(group|guild|private):/.test(id),
      hint: "QQ号, private:QQ号, group:群号, 或 guild:频道ID:子频道ID",
    },
    describeMessageTool(_params: {
      cfg: any;
      currentChannelId?: string | null;
      accountId?: string | null;
      sessionKey?: string | null;
      [key: string]: any;
    }) {
      // QQ (NapCat) channel supports these message actions via OneBot v11
      return {
        actions: ["send", "reply", "react", "unsend", "read"] as const,
      };
    },
  },
  hooks: {
    beforeDispatch(ctx: any) {
      const accountId: string = ctx.AccountId ?? ctx.accountId ?? "";
      const store = inboundStores.get(accountId);
      if (!store) return ctx; // account not started yet, pass through

      const config = store.config;

      // 1. 入站频控（仅在 From 存在时才做频控）
      if (config.inboundRateLimitMs > 0 && ctx.From) {
        const key = `${accountId}:${ctx.From}`;
        const now = Date.now();
        const last = store.lastTrigger.get(key) ?? 0;
        if (now - last < config.inboundRateLimitMs) {
          console.log(
            `[napcat-QQ][before_dispatch] rate limited: ${key} (${now - last}ms < ${config.inboundRateLimitMs}ms)`,
          );
          return null; // 拦截，不分发
        }
        // 防止 lastTrigger Map 无限增长（简单全清策略：超过 5000 条时清空所有记录，
        // 下一条消息将重新计时。这会导致一次短暂的频控豁免，属于已知权衡。）
        if (store.lastTrigger.size > 5000) {
          store.lastTrigger.clear();
        }
        store.lastTrigger.set(key, now);
      }

      // 2. 静默关键词过滤
      if (config.silentKeywords && config.silentKeywords.length > 0) {
        const body: string = ctx.Body ?? ctx.RawBody ?? "";
        for (const kw of config.silentKeywords) {
          if (body.includes(kw)) {
            console.log(
              `[napcat-QQ][before_dispatch] silent keyword matched: "${kw}", dropping message from ${ctx.From ?? "unknown"}`,
            );
            return null; // 拦截，不分发
          }
        }
      }

      return ctx; // 继续分发
    },
  },
};
