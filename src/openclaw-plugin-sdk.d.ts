// OpenClaw Plugin SDK Type Declarations
// 这些类型应该由 openclaw 包提供，这里提供最小化的声明以允许编译

declare module "openclaw/plugin-sdk" {
export interface PluginRuntime {
  log?: {
    info: (msg: string, meta?: any) => void;
    warn: (msg: string, meta?: any) => void;
    error: (msg: string, meta?: any) => void;
    debug: (msg: string, meta?: any) => void;
  };
  channel: {
    activity: {
      record: (params: { channel: string; accountId: string; direction: "inbound" | "outbound" }) => void;
    };
    session: {
      resolveStorePath: (store?: any, opts?: { agentId: string }) => string;
      recordInboundSession: (params: {
        storePath: string;
        sessionKey: string;
        ctx: any;
        updateLastRoute: { sessionKey: string; channel: string; to: string; accountId: string };
        onRecordError: (err: any) => void;
      }) => Promise<void>;
    };
    reply: {
      createReplyDispatcherWithTyping: (params: { deliver: (payload: ReplyPayload) => Promise<void> }) => {
        dispatcher: any;
        replyOptions: any;
      };
      dispatchReplyFromConfig: (params: {
        ctx: any;
        cfg: any;
        dispatcher: any;
        replyOptions: any;
      }) => Promise<void>;
      finalizeInboundContext: (ctx: any) => any;
    };
  };
}

export interface OpenClawConfig {
  channels?: {
    [channelKey: string]: any;
  };
  session?: {
    store?: any;
  };
}

export interface ChannelPlugin<TAccount> {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    blurb: string;
    order?: number;
  };
  capabilities: {
    chatTypes: string[];
    media: boolean;
    reactions?: boolean;
    threads?: boolean;
    deleteMessage?: boolean;
    blockStreaming?: boolean;
  };
  configSchema?: any;
  config: {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
    defaultAccountId: (cfg: OpenClawConfig) => string;
    describeAccount: (account: TAccount) => any;
    isConfigured?: (account: TAccount) => boolean;
    setAccountEnabled?: (params: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) => OpenClawConfig;
    deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
    resolveAllowFrom?: (params: { cfg: OpenClawConfig; accountId?: string }) => string[];
    formatAllowFrom?: (params: { allowFrom: Array<string | number> }) => string[];
  };
  setup: {
    resolveAccountId: (params: { accountId?: string }) => string;
    applyAccountName: (params: { cfg: OpenClawConfig; accountId: string; name: string }) => OpenClawConfig;
    validateInput: (params: { input: any }) => string | null;
    applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: any }) => OpenClawConfig;
  };
  gateway: {
    startAccount: (ctx: {
      account: TAccount;
      cfg: any;
      abortSignal: AbortSignal;
      log?: PluginRuntime["log"];
      onReady: () => void;
      onError: (error: Error) => void;
    }) => Promise<void> | void;
    logoutAccount?: (params: { accountId: string; cfg: OpenClawConfig }) => Promise<any>;
  };
  outbound: {
    sendText: (params: {
      to: string;
      text: string;
      accountId?: string | null;
      replyTo?: string | null;
      cfg: any;
    }) => Promise<{ channel: string; sent: boolean; messageId?: string; error?: string }>;
    sendMedia: (params: {
      to: string;
      text?: string;
      mediaUrl: string;
      accountId?: string | null;
      replyTo?: string | null;
      cfg: any;
    }) => Promise<{ channel: string; sent: boolean; messageId?: string; error?: string }>;
    deleteMessage?: (params: { messageId: string; accountId?: string }) => Promise<{ channel: string; success: boolean; error?: string }>;
  };
  status?: {
    defaultRuntime?: any;
    buildChannelSummary?: (params: { snapshot: Record<string, unknown> }) => any;
    buildAccountSnapshot: (params: { account?: TAccount; runtime?: Record<string, unknown> }) => any;
    probeAccount?: (params: { account: TAccount; timeoutMs?: number }) => Promise<{ ok: boolean; error?: string; bot?: { id: string; username: string } }>;
  };
  directory?: {
    listPeers?: (params: { accountId?: string }) => Promise<Array<{ id: string; name: string; type: "user" | "group"; metadata: any }>>;
    listGroups?: (params: { accountId?: string; cfg?: any }) => Promise<Array<{ id: string; name: string; type: "group"; metadata: any }>>;
  };
  messaging?: {
    normalizeTarget: (target: string) => string | undefined;
    targetResolver: {
      looksLikeId: (id: string) => boolean;
      hint: string;
    };
  };
  reload?: {
    configPrefixes: string[];
  };
  onboarding?: any;
}

export interface ChannelOnboardingAdapter {
  channel: string;
  getStatus: (ctx: { cfg: OpenClawConfig }) => Promise<{
    channel: string;
    configured: boolean;
    statusLines: string[];
    selectionHint?: string;
    quickstartScore: number;
  }>;
  configure: (ctx: {
    cfg: OpenClawConfig;
    prompter: any;
    accountOverrides?: Record<string, string>;
    shouldPromptAccountIds: boolean;
  }) => Promise<{ success: boolean; cfg: OpenClawConfig; accountId: string }>;
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
}

export interface ChannelAccountSnapshot {
  accountId: string;
  name?: string;
  enabled: boolean;
}

export type ReplyPayload = {
  text?: string;
  files?: Array<{ url: string; name?: string }>;
};

export function buildChannelConfigSchema(schema: any): any {
  return { schema };
}

export function emptyPluginConfigSchema(): any {
  return { schema: {} };
}

export const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(accountId?: string | null): string {
  return (accountId || "").trim().toLowerCase() || DEFAULT_ACCOUNT_ID;
}

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name: string;
}): OpenClawConfig {
  const { cfg, channelKey, accountId, name } = params;
  const channel = (cfg.channels?.[channelKey] as Record<string, any>) || {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [channelKey]: { ...channel, name },
      },
    };
  }

  const accounts = (channel.accounts as Record<string, any>) || {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channelKey]: {
        ...channel,
        accounts: {
          ...accounts,
          [accountId]: { ...(accounts[accountId] || {}), name },
        },
      },
    },
  };
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
}): OpenClawConfig {
  const { cfg, channelKey } = params;
  const channel = (cfg.channels?.[channelKey] as Record<string, any>) || {};
  const { name, ...rest } = channel;
  const accounts = (channel.accounts as Record<string, any>) || {};

  if (Object.keys(accounts).length > 0 && name) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [channelKey]: {
          ...rest,
          accounts: {
            ...accounts,
            [DEFAULT_ACCOUNT_ID]: { ...(accounts[DEFAULT_ACCOUNT_ID] || {}), name },
          },
        },
      },
    };
  }

  return cfg;
}

export function deleteAccountFromConfigSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): OpenClawConfig {
  const { cfg, channelKey, accountId, clearBaseFields = [] } = params;
  const channel = (cfg.channels?.[channelKey] as Record<string, any>) || {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextChannel = { ...channel };
    for (const field of clearBaseFields) {
      delete nextChannel[field];
    }
    return {
      ...cfg,
      channels: { ...cfg.channels, [channelKey]: nextChannel },
    };
  }

  const accounts = (channel.accounts as Record<string, any>) || {};
  if (!(accountId in accounts)) return cfg;

  const nextAccounts = { ...accounts };
  delete nextAccounts[accountId];
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channelKey]: { ...channel, accounts: nextAccounts },
    },
  };
}

export function setAccountEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): OpenClawConfig {
  const { cfg, channelKey, accountId, enabled, allowTopLevel = false } = params;
  const channel = (cfg.channels?.[channelKey] as Record<string, any>) || {};

  if (accountId === DEFAULT_ACCOUNT_ID || allowTopLevel) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [channelKey]: { ...channel, enabled },
      },
    };
  }

  const accounts = (channel.accounts as Record<string, any>) || {};
  if (!(accountId in accounts)) return cfg;

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channelKey]: {
        ...channel,
        accounts: {
          ...accounts,
          [accountId]: { ...accounts[accountId], enabled },
        },
      },
    },
  };
}

export interface OpenClawPluginApi {
  runtime: any;
  registerChannel: (params: { plugin: ChannelPlugin<any> }) => void;
}

}
