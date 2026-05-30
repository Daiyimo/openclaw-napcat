import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  type OpenClawConfig,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { registerClientsMap } from "./proactive.js";
import { normalizeTarget } from "./message-parser.js";
import { PassiveModeManager } from "./passive-mode.js";
import type { InboundRateLimitStore } from "./types/channel-types.js";

// ── 子模块委托 ─────────────────────────────────────────────────────────────
import { startAccount } from "./gateway/index.js";
import { sendText } from "./outbound/send-text.js";
import { sendMedia, deleteMessage } from "./outbound/send-media.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
  configured: boolean;
};

// ============================================================
// 共享状态（全局，跨账号共用，传递给子模块）
// ============================================================

const clients = new Map<string, OneBotClient>();
registerClientsMap(clients);

const inboundStores = new Map<string, InboundRateLimitStore>();
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

// ============================================================
// 插件定义
// ============================================================

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
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
    unsend: true,
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
      const parsed = QQConfigSchema.safeParse(accountConfig ?? {});
      const config = parsed.success ? parsed.data : (accountConfig || {});
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
      } catch {
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
      } catch {
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
    validateInput: (_params: { cfg: OpenClawConfig; accountId: string; input: any }) => null,
    applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: any }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: params.cfg,
        channelKey: "napcat",
        accountId: params.accountId,
        name: params.input.name,
      });

      const next =
        params.accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "napcat" })
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
      getStatus?: () => any;
      setStatus?: (next: any) => void;
      channelRuntime?: import("openclaw/plugin-sdk").PluginRuntimeChannel;
      runtime?: any;
    }) => {
      await startAccount(
        {
          account: ctx.account,
          cfg: ctx.cfg,
          accountId: ctx.accountId,
          abortSignal: ctx.abortSignal,
          log: ctx.log ?? console,
          getStatus: ctx.getStatus,
          setStatus: ctx.setStatus,
          channelRuntime: ctx.channelRuntime as any,
          runtime: ctx.runtime,
        },
        { clients, knownGroupIds: getKnownGroupIds(ctx.accountId), inboundStores, passiveMode },
      );
    },
    logoutAccount: async ({ accountId, cfg: _cfg }: { accountId: string; cfg: OpenClawConfig; account?: any; runtime?: any; log?: any }) => {
      return { loggedOut: true, cleared: true };
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async ({ to, text, accountId, replyToId, cfg }: { to: string; text: string; accountId?: string | null; replyToId?: string | null; cfg?: any }) => {
      const resolvedAid = accountId || DEFAULT_ACCOUNT_ID;
      // 从 QQ 配置中提取 botSignature
      const qq = cfg?.channels?.napcat;
      const accountCfg = resolvedAid === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[resolvedAid];
      const botSignature = accountCfg?.botSignature;
      return sendText(
        { to, text, accountId, replyToId, botSignature },
        { getClient: getClientForAccount, knownGroupIds: getKnownGroupIds(resolvedAid), passiveMode },
      );
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const resolvedAid = accountId || DEFAULT_ACCOUNT_ID;
      return sendMedia(
        { to, text, mediaUrl, accountId, replyToId },
        { getClient: getClientForAccount, knownGroupIds: getKnownGroupIds(resolvedAid) },
      );
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
      return deleteMessage(
        { messageId, accountId },
        { getClient: getClientForAccount },
      );
    },
  },
  messaging: {
    normalizeTarget,
    targetResolver: {
      looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^(group|guild|private):/.test(id),
      hint: "QQ号, private:QQ号, group:群号, 或 guild:频道ID:子频道ID",
    },
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
      ];
    },
  },
};
