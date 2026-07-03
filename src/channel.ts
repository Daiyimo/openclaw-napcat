import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  type OpenClawConfig,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig, getQQConfigDefaults, resolvePassiveModeTemperature } from "./config.js";
import { registerClientsMap } from "./proactive.js";
import { normalizeTarget } from "./message-parser.js";
import { PassiveModeManager } from "./passive-mode.js";
import type { InboundRateLimitStore, Logger } from "./types/channel-types.js";
import { resolveOutboundSessionRoute } from "./utils/resolve-session-route.js";
import { initConfigRef } from "./config-watcher.js";
import { PROBE_DEFAULT_TIMEOUT_MS } from "./constants.js";
import { getLog } from "./admin-commands/shared.js";

// ── 子模块委托 ─────────────────────────────────────────────────────────────
import { startAccount } from "./gateway/index.js";
import { sendText } from "./outbound/send-text.js";
import { sendMedia } from "./outbound/send-media.js";
import { createMetricsCollector } from "./metrics.js";
import { AlertCooldown } from "./metrics.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
  configured: boolean;
};

// 模块级日志引用（默认 console，可由外部注入框架 logger）
let _log: Logger = console;

/** 设置模块级日志（供外部注入框架 logger） */
export function setModuleLogger(log: Logger): void {
  _log = log;
}

// ============================================================
// 共享状态（全局，跨账号共用，传递给子模块）
// ============================================================

const clients = new Map<string, OneBotClient>();
registerClientsMap(clients);

const inboundStores = new Map<string, InboundRateLimitStore>();
/** 并发启动锁（模块级共享，防止同一账号并发 startAccount 竞态） */
export const startingPromises = new Map<string, Promise<void>>();
/** 旁观模式冷却状态（模块级单例，startAccount 和 outbound.sendText 共享） */
const passiveMode = new PassiveModeManager();
/**
 * 已知群号集合（按账号隔离），在 registerGroupRoute 时填充。
 * 用于在 outbound.sendText 中将裸数字 to 自动转换为 group:xxx。
 * Map<accountId, Set<groupId>>，防止多账号间误匹配。
 */
const knownGroupIdsPerAccount = new Map<string, Set<string>>();

/** 获取指定账号的已知群号集合（自动创建） */
function getKnownGroupIds(accountId: string): Set<string> {
  let s = knownGroupIdsPerAccount.get(accountId);
  if (!s) {
    s = new Set<string>();
    knownGroupIdsPerAccount.set(accountId, s);
  }
  return s;
}

function getClientForAccount(accountId: string): OneBotClient | undefined {
  return clients.get(accountId);
}

/**
 * Bot 自身 QQ 号缓存（按账号隔离）。
 * 由 connect handler 写入，outbound.sendText 读取用于生成友军签名。
 * 避免依赖框架传入的 config 对象（可能为副本，不含运行时注入的 _selfId）。
 */
const botSelfIds = new Map<string, number>();

/** 获取指定账号的 bot QQ 号 */
function getBotSelfId(accountId: string): number | undefined {
  return botSelfIds.get(accountId);
}

/** 设置指定账号的 bot QQ 号 */
function setBotSelfId(accountId: string, selfId: number): void {
  botSelfIds.set(accountId, selfId);
}

/**
 * Bot 自身昵称缓存（按账号隔离）。
 * 由 connect handler 写入，outbound.sendText 读取用于生成友军签名。
 * 避免依赖框架传入的 config 对象（resolveAccount 会删除 _selfName 字段）。
 */
const botSelfNames = new Map<string, string>();

/** 获取指定账号的 bot 昵称 */
function getBotSelfName(accountId: string): string | undefined {
  return botSelfNames.get(accountId);
}

/** 设置指定账号的 bot 昵称 */
function setBotSelfName(accountId: string, name: string): void {
  botSelfNames.set(accountId, name);
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount, unknown, unknown> = {
  id: "napcat",
  meta: {
    id: "napcat",
    label: "NapCat (OneBot 11)",
    selectionLabel: "NapCat",
    docsPath: "extensions/napcat",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    reply: true,
    unsend: true,
    nativeCommands: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg: OpenClawConfig) => {
      const qq = cfg.channels?.napcat;
      if (!qq) return [];
      if (qq.accounts) return Object.keys(qq.accounts);
      return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      const qq = cfg.channels?.napcat;
      const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
      const cleanConfig = accountConfig ? { ...accountConfig } : {};
      delete (cleanConfig as Record<string, unknown>)._selfId;
      delete (cleanConfig as Record<string, unknown>)._selfName;
      const parsed = QQConfigSchema.safeParse(cleanConfig ?? {});
      const rawConfig = parsed.success ? parsed.data : (accountConfig || {});
      // safeParse 不填充 .default()，手动合并默认值（用户显式设置的优先）
      const config: QQConfig = { ...getQQConfigDefaults(), ...rawConfig };
      // passiveMode.temperature 优先映射到三个子参数
      const pm = config.passiveMode;
      if (pm?.temperature !== undefined && pm.temperature !== null) {
        const mapped = resolvePassiveModeTemperature(pm.temperature);
        if (mapped) {
          config.passiveMode = { ...pm, ...mapped };
        }
      }
      return {
        accountId: id,
        name: accountConfig?.name ?? "QQ Default",
        enabled: true,
        configured: Boolean(accountConfig?.wsUrl || accountConfig?.reverseWsPort),
        tokenSource: accountConfig?.accessToken ? "config" : "none",
        config,
      };
    },
    defaultAccountId: (_cfg: OpenClawConfig) => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc: ResolvedQQAccount, _cfg: OpenClawConfig) => ({
      accountId: acc.accountId,
      name: acc.name,
      enabled: acc.enabled ?? true,
      configured: acc.configured,
    }),
  },
  directory: {
    listPeers: async (params: { cfg: OpenClawConfig; accountId?: string | null; query?: string | null; limit?: number | null; runtime: any }) => {
      const client = getClientForAccount(params.accountId || DEFAULT_ACCOUNT_ID);
      if (!client) return [];
      try {
        const friends = await client.getFriendList();
        return friends.map((f) => ({
          id: String(f.user_id),
          name: f.remark || f.nickname,
          kind: "user" as const,
        }));
      } catch (err) {
        _log.warn(`[napcat-QQ] listPeers failed for ${params.accountId || DEFAULT_ACCOUNT_ID}:`, err);
        return [];
      }
    },
    listGroups: async (params: { cfg: OpenClawConfig; accountId?: string | null; query?: string | null; limit?: number | null; runtime: any }) => {
      const client = getClientForAccount(params.accountId || DEFAULT_ACCOUNT_ID);
      if (!client) return [];
      try {
        const groups = await client.getGroupList();
        return groups.map((g) => ({
          id: String(g.group_id),
          name: g.group_name,
          kind: "group" as const,
        }));
      } catch (err) {
        _log.warn(`[napcat-QQ] listGroups failed for ${params.accountId || DEFAULT_ACCOUNT_ID}:`, err);
        return [];
      }
    },
  },
  status: {
    probeAccount: async ({ account, timeoutMs, cfg: _cfg }: { account: ResolvedQQAccount; timeoutMs: number; cfg: OpenClawConfig }) => {
      if (!account.config.wsUrl && !account.config.reverseWsPort)
        return { ok: false, error: "Missing wsUrl or reverseWsPort" };

      const client = new OneBotClient({
        wsUrl: account.config.wsUrl,
        httpUrl: account.config.httpUrl,
        accessToken: account.config.accessToken,
        requireReverseWsToken: account.config.requireReverseWsToken,
      });

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          client.disconnect();
          resolve({ ok: false, error: "Connection timeout" });
        }, timeoutMs || PROBE_DEFAULT_TIMEOUT_MS);

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
          client.disconnect();
          resolve({ ok: false, error: String(err) });
        });

        client.connect();
      });
    },
    buildAccountSnapshot: ({ account, cfg: _cfg, runtime }: { account?: ResolvedQQAccount; cfg: OpenClawConfig; runtime?: any; probe?: any; audit?: any }) => {
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
    resolveAccountId: (params: { cfg: OpenClawConfig; accountId?: string; input?: any }) =>
      normalizeAccountId(params.accountId),
    applyAccountName: (params: { cfg: OpenClawConfig; accountId: string; name?: string }) =>
      applyAccountNameToChannelSection({
        cfg: params.cfg,
        channelKey: "napcat",
        accountId: params.accountId,
        name: params.name ?? "",
      }),
    validateInput: (_params: { cfg: OpenClawConfig; accountId: string; input: ChannelSetupInput }) => null,
    applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: ChannelSetupInput }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: params.cfg,
        channelKey: "napcat",
        accountId: params.accountId,
        name: params.input.name ?? "",
      });

      const next =
        params.accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "napcat" })
          : namedConfig;

      // ChannelSetupInput 不含 wsUrl/httpUrl 等 napcat 专属字段，
      // 通过 as QQConfig 窄化类型以访问这些字段
      const napcatInput = params.input as unknown as QQConfig;
      const newConfig = {
        wsUrl: napcatInput.wsUrl || undefined,
        httpUrl: napcatInput.httpUrl,
        reverseWsPort: napcatInput.reverseWsPort,
        accessToken: napcatInput.accessToken,
        enabled: true,
      };

      if (params.accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: { ...next.channels, napcat: { ...next.channels?.napcat, ...newConfig } },
        };
      }

      return {
        ...next,
        channels: {
          ...next.channels,
          napcat: {
            ...next.channels?.napcat,
            enabled: true,
            accounts: {
              ...next.channels?.napcat?.accounts,
              [params.accountId]: {
                ...(next.channels?.napcat?.accounts?.[params.accountId] || {}),
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
      accountId: string;
      abortSignal: AbortSignal;
      log?: any;
      getStatus: () => any;
      setStatus: (next: any) => void;
      channelRuntime?: import("openclaw/plugin-sdk").PluginRuntimeChannel;
      runtime: any;
    }) => {
      await startAccount(
        {
          account: ctx.account,
          cfg: ctx.cfg,
          accountId: ctx.accountId,
          abortSignal: ctx.abortSignal,
          log: getLog(ctx.log),
          getStatus: ctx.getStatus,
          setStatus: ctx.setStatus,
          channelRuntime: ctx.channelRuntime,
          runtime: ctx.runtime,
        },
        {
          clients,
          knownGroupIds: getKnownGroupIds(ctx.accountId),
          inboundStores,
          passiveMode,
          setBotSelfId,
          setBotSelfName,
          startingPromises,
          _messageHandlerCleanups: new Map<string, () => void>(),
          metrics: new Map([[ctx.accountId, createMetricsCollector()]]),
          alertCooldown: new Map([[ctx.accountId, new AlertCooldown()]]),
        },
      );
    },
    logoutAccount: async ({ accountId, cfg: _cfg }: { accountId: string; cfg: OpenClawConfig; account?: any; runtime: any; log?: any }) => {
      return { loggedOut: true, cleared: true };
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async (params: { to?: string; text: string; target?: string; channel?: string; accountId?: string | null; replyToId?: string | null; cfg?: any; log?: any }): Promise<{ channel: "napcat"; sent: boolean; messageId?: string; error?: string }> => {
      // 防御性归一化：cron agent 可能用 channel 代替 target，兼容处理
      const to = params.to ?? params.target ?? params.channel ?? "";
      const text = params.text;
      const resolvedAid = params.accountId || DEFAULT_ACCOUNT_ID;
      // 提取本 bot 的 QQ 号和昵称用于生成友军签名
      // 优先用昵称（更可读），UID 作为兜底
      const accountCfg = (resolvedAid === DEFAULT_ACCOUNT_ID ? params.cfg?.channels?.napcat : params.cfg?.channels?.napcat?.accounts?.[resolvedAid]) as QQConfig | undefined;
      const selfId = getBotSelfId(resolvedAid) ?? params.cfg?.channels?.napcat?._selfId;
      // resolveAccount 会删除 _selfName，优先从模块级缓存读取（connect handler 写入）
      const selfName = getBotSelfName(resolvedAid) ?? accountCfg?._selfName;
      return sendText(
        { to, text, accountId: params.accountId, replyToId: params.replyToId, botSelfId: selfId, botSelfName: selfName, cfg: accountCfg },
        { getClient: getClientForAccount, knownGroupIds: getKnownGroupIds(resolvedAid), passiveMode, log: params.log },
      );
    },
    sendMedia: async (params: { to?: string; text?: string; mediaUrl: string; accountId?: string | null; replyToId?: string | null; log?: any }): Promise<{ channel: "napcat"; sent: boolean; messageId?: string; error?: string }> => {
      const { to, text, mediaUrl, accountId, replyToId, log } = params;
      const resolvedTo = to ?? "";
      const resolvedAid = accountId || DEFAULT_ACCOUNT_ID;
      return sendMedia(
        { to: resolvedTo, text, mediaUrl, accountId: resolvedAid, replyToId },
        { getClient: getClientForAccount, knownGroupIds: getKnownGroupIds(resolvedAid), log },
      );
    },
  },
  messaging: {
    normalizeTarget,
    targetResolver: {
      looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^(group|guild|private):/.test(id),
      hint: "QQ号, private:QQ号, group:群号, 或 guild:频道ID:子频道ID",
      resolveTarget: async (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        input: string;
        normalized: string;
        preferredKind?: string;
      }): Promise<{ to: string; kind: "user" | "group" | "channel"; source: "normalized" | "directory" }> => {
        const to = params.normalized;
        // SDK DirectoryEntryKind: user=私聊, group=群聊, channel=频道
        // napcat 归一化输出: private: / group: / guild:
        const napcatToSdkKind: Record<string, "user" | "group" | "channel"> = {
          private: "user",
          group: "group",
          guild: "channel",
        };
        const prefix = to.split(":")[0];
        const mappedKind = napcatToSdkKind[prefix];
        // 优先使用框架提供的 preferredKind（会话类型偏好），否则从前缀推导
        const kind = params.preferredKind && napcatToSdkKind[params.preferredKind]
          ? napcatToSdkKind[params.preferredKind]
          : (mappedKind ?? "group");
        return { to, kind, source: "normalized" as const };
      },
    },
    resolveOutboundSessionRoute: (params: {
      cfg: any;
      agentId: string;
      accountId?: string | null;
      target: string;
      currentSessionKey?: string;
      resolvedTarget?: {
        to: string;
        kind: string;
        display?: string;
        source: "normalized" | "directory";
      };
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => resolveOutboundSessionRoute(params.agentId, params.target),
  },
  actions: {
    describeMessageTool(_params: {
      cfg: any;
      currentChannelId?: string | null;
      accountId?: string | null;
      sessionKey?: string | null;
      [key: string]: any;
    }) {
      return {
        actions: ["send", "reply", "react", "unsend", "read"] as const,
      };
    },
  },
  agentPrompt: {
    messageToolHints(_params: { cfg: OpenClawConfig; accountId?: string | null }) {
      return [
        "跨会话发送消息：如需将消息发往非当前会话（如指定群聊），请在消息开头使用 [TO:目标] 前缀。" +
        "目标格式：group:群号（群聊）或 private:QQ号（私聊）。示例：[TO:group:88888888]早上好！",
        "发送消息时必须使用 target 参数指定接收方（如 group:1081646667 或 private:QQ号），" +
        "不要使用 channel 参数。channel 是内部路由标识，不是发送目标。",
      ];
    },
  },
};
