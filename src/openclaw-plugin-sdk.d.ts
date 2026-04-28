// OpenClaw Plugin SDK Type Declarations
// 这些类型应该由 openclaw 包提供，这里提供最小化的声明以允许编译
// 适配 OpenClaw 2026.4.26+ 版本

declare module "openclaw/plugin-sdk" {

// ── Runtime 类型 ──────────────────────────────────────────────────────────────

export interface RuntimeLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export type PluginLogger = RuntimeLogger;

export interface PluginRuntime {
  channel: {
    activity: {
      record: (params: {
        channel: string;
        accountId?: string | null;
        direction: "inbound" | "outbound";
        at?: number;
      }) => void;
    };
    session: {
      resolveStorePath: (store?: any, opts?: { agentId?: string }) => string;
      recordInboundSession: (params: {
        storePath: string;
        sessionKey: string;
        ctx: any;
        groupResolution?: any;
        createIfMissing?: boolean;
        updateLastRoute?: {
          sessionKey: string;
          channel: string;
          to: string;
          accountId?: string;
          threadId?: string | number;
        };
        onRecordError: (err: unknown) => void;
      }) => Promise<void>;
    };
    reply: {
      createReplyDispatcherWithTyping: (params: {
        deliver: (payload: ReplyPayload) => Promise<void>;
        typingCallbacks?: any;
        onReplyStart?: () => Promise<void> | void;
        onIdle?: () => void;
        onCleanup?: () => void;
      }) => {
        dispatcher: any;
        replyOptions: any;
        markDispatchIdle: () => void;
        markRunComplete: () => void;
      };
      dispatchReplyFromConfig: (params: {
        ctx: any;
        cfg: any;
        dispatcher: any;
        replyOptions?: any;
        configOverride?: any;
      }) => Promise<{ queuedFinal: boolean; counts: Record<string, number> }>;
      finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T, opts?: any) => T & Record<string, unknown>;
    };
  };
}

// ── 配置类型 ──────────────────────────────────────────────────────────────────

export interface OpenClawConfig {
  channels?: {
    [channelKey: string]: any;
  };
  session?: {
    store?: any;
  };
}

// ── 消息 Payload ──────────────────────────────────────────────────────────────

export type ReplyPayload = {
  text?: string;
  files?: Array<{ url: string; name?: string }>;
};

// ── 插件钩子类型 ──────────────────────────────────────────────────────────────

export type PluginHookBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  isGroup?: boolean;
  timestamp?: number;
};

export type PluginHookBeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
};

export type PluginHookBeforeDispatchResult = {
  handled: boolean;
  text?: string;
};

// ── Channel Plugin 类型 ──────────────────────────────────────────────────────

export interface ChannelAccountSnapshot {
  accountId: string;
  name?: string;
  enabled: boolean;
}

export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
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
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    defaultAccountId: (cfg: OpenClawConfig) => string;
    describeAccount: (account: ResolvedAccount) => any;
    isConfigured?: (account: ResolvedAccount) => boolean;
    setAccountEnabled?: (params: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) => OpenClawConfig;
    deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
    resolveAllowFrom?: (params: { cfg: OpenClawConfig; accountId?: string }) => string[];
    formatAllowFrom?: (params: { allowFrom: Array<string | number> }) => string[];
  };
  defaults?: {
    queue?: { debounceMs?: number };
  };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  setupWizard?: any;
  setup?: {
    resolveAccountId: (params: { accountId?: string | null }) => string;
    applyAccountName: (params: { cfg: OpenClawConfig; accountId: string; name: string }) => OpenClawConfig;
    validateInput: (params: { input: any }) => string | null;
    applyAccountConfig: (params: { cfg: OpenClawConfig; accountId: string; input: any }) => OpenClawConfig;
  };
  pairing?: any;
  security?: any;
  groups?: any;
  mentions?: any;
  outbound?: {
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
    buildAccountSnapshot: (params: { account?: ResolvedAccount; runtime?: Record<string, unknown> }) => any;
    probeAccount?: (params: { account: ResolvedAccount; timeoutMs?: number }) => Promise<{ ok: boolean; error?: string; bot?: { id: string; username: string } }>;
  };
  gatewayMethods?: string[];
  gateway?: {
    startAccount: (ctx: {
      account: ResolvedAccount;
      cfg: any;
      abortSignal: AbortSignal;
      log?: any;
      onReady: () => void;
      onError: (error: Error) => void;
    }) => Promise<void> | void;
    logoutAccount?: (params: { accountId: string; cfg: OpenClawConfig }) => Promise<any>;
  };
  auth?: any;
  approvalCapability?: any;
  elevated?: any;
  commands?: any;
  lifecycle?: any;
  secrets?: any;
  allowlist?: any;
  doctor?: any;
  bindings?: any;
  conversationBindings?: any;
  streaming?: any;
  threading?: any;
  messaging?: {
    normalizeTarget: (target: string) => string | undefined;
    targetResolver: {
      looksLikeId: (id: string) => boolean;
      hint: string;
    };
    describeMessageTool?: (params: {
      cfg: any;
      currentChannelId?: string | null;
      accountId?: string | null;
      sessionKey?: string | null;
      [key: string]: any;
    }) => {
      actions?: readonly string[] | null;
      capabilities?: readonly string[] | null;
      schema?: any;
    } | null | undefined;
  };
  agentPrompt?: any;
  directory?: {
    listPeers?: (params: { accountId?: string }) => Promise<Array<{ id: string; name: string; type: "user" | "group"; metadata: any }>>;
    listGroups?: (params: { accountId?: string; cfg?: any }) => Promise<Array<{ id: string; name: string; type: "group"; metadata: any }>>;
  };
  resolver?: any;
  actions?: any;
  heartbeat?: any;
  agentTools?: any;
};

// ── Plugin API 类型 ──────────────────────────────────────────────────────────

export type PluginHookName =
  | "before_dispatch"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_agent_start"
  | "before_agent_reply"
  | "agent_end"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop"
  | "before_install"
  | string;

export type PluginHookHandlerMap = {
  before_dispatch: (
    event: PluginHookBeforeDispatchEvent,
    ctx: PluginHookBeforeDispatchContext,
  ) => Promise<PluginHookBeforeDispatchResult | void> | PluginHookBeforeDispatchResult | void;
  [key: string]: (...args: any[]) => any;
};

export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  rootDir?: string;
  runtime: PluginRuntime;
  logger: PluginLogger;
  config?: any;
  pluginConfig?: any;
  registerChannel: (params: { plugin: ChannelPlugin<any> } | ChannelPlugin<any>) => void;
  registerHook: (
    events: string | string[],
    handler: (...args: any[]) => any,
    opts?: { priority?: number },
  ) => void;
  on: <K extends PluginHookName>(
    hookName: K,
    handler: K extends keyof PluginHookHandlerMap ? PluginHookHandlerMap[K] : (...args: any[]) => any,
    opts?: { priority?: number },
  ) => void;
  registerTool?: (...args: any[]) => void;
  registerHttpRoute?: (...args: any[]) => void;
  registerGatewayMethod?: (...args: any[]) => void;
  registerCli?: (...args: any[]) => void;
  registerReload?: (...args: any[]) => void;
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

export function buildChannelConfigSchema(schema: any): any;
export function emptyPluginConfigSchema(): any;

export const DEFAULT_ACCOUNT_ID: string;
export function normalizeAccountId(accountId?: string | null): string;

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name: string;
}): OpenClawConfig;

export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
}): OpenClawConfig;

export function deleteAccountFromConfigSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): OpenClawConfig;

export function setAccountEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): OpenClawConfig;

}
