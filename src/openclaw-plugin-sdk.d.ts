// OpenClaw Plugin SDK Type Declarations
// 对齐 openclaw 2026.3.31 source
// 采用最小化声明：仅覆盖插件实际使用的接口

declare module "openclaw/plugin-sdk" {
  // ── 基础运行时 ─────────────────────────────────────────────────────────────

  /** channel 子命名空间（对应 PluginRuntimeChannel） */
  export interface PluginRuntimeChannel {
    reply: {
      createReplyDispatcherWithTyping: (params: {
        deliver: (payload: ReplyPayload) => Promise<void>;
      }) => { dispatcher: any; replyOptions: any };
      dispatchReplyFromConfig: (params: {
        ctx: any;
        cfg: any;
        dispatcher: any;
        replyOptions: any;
      }) => Promise<void>;
      finalizeInboundContext: <T extends Record<string, unknown>>(
        ctx: T,
        opts?: {
          forceBodyForAgent?: boolean;
          forceBodyForCommands?: boolean;
          forceChatType?: boolean;
          forceConversationLabel?: boolean;
        },
      ) => T & Record<string, unknown>;
      dispatchReplyWithBufferedBlockDispatcher?: (params: any) => Promise<void>;
      withReplyDispatcher?: (params: any) => Promise<void>;
      formatAgentEnvelope?: (params: any) => string;
    };
    session: {
      resolveStorePath: (store?: any, opts?: { agentId?: string }) => string;
      recordInboundSession: (params: {
        storePath: string;
        sessionKey: string;
        ctx: any;
        updateLastRoute: {
          sessionKey: string;
          channel: string;
          to: string;
          accountId: string;
        };
        onRecordError: (err: any) => void;
      }) => Promise<void>;
      recordSessionMetaFromInbound?: (params: any) => void;
      readSessionUpdatedAt?: (params: any) => number | null;
      updateLastRoute?: (params: any) => void;
    };
    activity: {
      record: (params: {
        channel: string;
        accountId: string;
        direction: "inbound" | "outbound";
      }) => void;
      get?: (params: any) => any;
    };
    text?: {
      chunkByNewline?: (text: string, limit: number) => string[];
      chunkMarkdownText?: (text: string, limit: number) => string[];
      hasControlCommand?: (text: string) => boolean;
      resolveTextChunkLimit?: (params: any) => number;
    };
    routing?: {
      buildAgentSessionKey?: (params: any) => string;
      resolveAgentRoute?: (params: any) => any;
    };
    media?: {
      fetchRemoteMedia?: (params: any) => Promise<any>;
      saveMediaBuffer?: (params: any) => Promise<string>;
    };
    mentions?: any;
    reactions?: any;
    groups?: any;
    debounce?: any;
    commands?: {
      resolveCommandAuthorizedFromAuthorizers?: (params: any) => boolean;
      isControlCommandMessage?: (text: string) => boolean;
      shouldHandleTextCommands?: (params: any) => boolean;
    };
    outbound?: any;
    threadBindings?: any;
    pairing?: any;
    discord?: any;
    slack?: any;
    matrix?: any;
    signal?: any;
    line?: any;
  }

  export interface PluginRuntime {
    version?: string;
    channel: PluginRuntimeChannel;
    subagent?: {
      run: (params: {
        sessionKey: string;
        message: string;
        provider?: string;
        model?: string;
        extraSystemPrompt?: string;
        lane?: string;
        deliver?: boolean;
        idempotencyKey?: string;
      }) => Promise<{ runId: string }>;
      waitForRun?: (params: { runId: string; timeoutMs?: number }) => Promise<any>;
      getSessionMessages?: (params: {
        sessionKey: string;
        limit?: number;
      }) => Promise<{ messages: unknown[] }>;
      deleteSession?: (params: { sessionKey: string; deleteTranscript?: boolean }) => Promise<void>;
    };
    config?: {
      loadConfig: () => any;
      writeConfigFile?: (cfg: any) => void;
    };
    agent?: any;
    system?: any;
    media?: any;
    tts?: any;
    mediaUnderstanding?: any;
    imageGeneration?: any;
    webSearch?: any;
    stt?: any;
    events?: any;
    logging?: {
      shouldLogVerbose?: () => boolean;
      getChildLogger?: (bindings?: Record<string, unknown>) => any;
    };
    state?: any;
    modelAuth?: any;
  }

  export interface OpenClawConfig {
    channels?: { [channelKey: string]: any };
    session?: { store?: any };
    [key: string]: any;
  }

  // ── Gateway 上下文 ──────────────────────────────────────────────────────────

  /** startAccount 注入的上下文（2026.3.31）。onReady/onError 已在 3.31 移除。 */
  export type ChannelGatewayContext<TAccount = unknown> = {
    cfg: OpenClawConfig;
    accountId: string;
    account: TAccount;
    runtime?: any;
    abortSignal: AbortSignal;
    log?: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    getStatus?: () => ChannelAccountSnapshot;
    /** 3.31: setStatus 接收完整 ChannelAccountSnapshot，不再是 Partial */
    setStatus?: (next: ChannelAccountSnapshot) => void;
    /**
     * Channel runtime helpers 注入到外部插件（@since 2026.2.19）
     * 替代全局 PluginRuntime 单例的首选访问方式
     */
    channelRuntime?: PluginRuntimeChannel;
  };

  export type ChannelLogoutResult = {
    cleared: boolean;
    loggedOut?: boolean;
    [key: string]: unknown;
  };

  export type ChannelLogoutContext<TAccount = unknown> = {
    cfg: OpenClawConfig;
    accountId: string;
    account: TAccount;
    runtime?: any;
    log?: any;
  };

  // ── Outbound 上下文 ─────────────────────────────────────────────────────────

  export type ChannelOutboundContext = {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    /** 替代旧版 replyTo（3.31）*/
    replyToId?: string | null;
    threadId?: string | number | null;
    accountId?: string | null;
    identity?: any;
    deps?: any;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
  };

  // ── Message Tool / Actions ─────────────────────────────────────────────────

  export type ChannelMessageActionDiscoveryContext = {
    cfg: OpenClawConfig;
    currentChannelId?: string | null;
    currentChannelProvider?: string | null;
    currentThreadTs?: string | null;
    currentMessageId?: string | number | null;
    accountId?: string | null;
    sessionKey?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    requesterSenderId?: string | null;
    [key: string]: any;
  };

  export type ChannelMessageToolDiscovery = {
    actions?: readonly string[] | null;
    capabilities?: readonly string[] | null;
    schema?: any;
  };

  export type ChannelMessageActionAdapter = {
    /** 统一 discovery 入口，返回 actions/capabilities/schema */
    describeMessageTool: (
      params: ChannelMessageActionDiscoveryContext,
    ) => ChannelMessageToolDiscovery | null | undefined;
    supportsAction?: (params: { action: string }) => boolean;
    requiresTrustedRequesterSender?: (params: { action: string; toolContext?: any }) => boolean;
    extractToolSend?: (params: {
      args: Record<string, unknown>;
    }) => { to: string; accountId?: string | null; threadId?: string | null } | null;
    handleAction?: (ctx: any) => Promise<any>;
  };

  // ── Directory ───────────────────────────────────────────────────────────────

  /** 3.31: runtime 字段已新增为必选 */
  export type ChannelDirectoryListParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    query?: string | null;
    limit?: number | null;
    runtime: any;
  };

  export type ChannelDirectoryEntry = {
    kind: "user" | "group" | "channel";
    id: string;
    name?: string;
    handle?: string;
    avatarUrl?: string;
    rank?: number;
    raw?: unknown;
    /** @deprecated prefer kind */
    type?: "user" | "group";
    metadata?: any;
  };

  // ── Account Snapshot ────────────────────────────────────────────────────────

  export interface ChannelAccountSnapshot {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    linked?: boolean;
    running?: boolean;
    connected?: boolean;
    restartPending?: boolean;
    reconnectAttempts?: number;
    lastConnectedAt?: number | null;
    lastDisconnect?: string | { at: number; status?: number; error?: string; loggedOut?: boolean } | null;
    lastMessageAt?: number | null;
    lastEventAt?: number | null;
    lastError?: string | null;
    healthState?: string;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
    busy?: boolean;
    activeRuns?: number;
    lastRunActivityAt?: number | null;
    mode?: string;
    tokenSource?: string;
    botTokenSource?: string;
    probe?: unknown;
    lastProbeAt?: number | null;
    audit?: unknown;
    [key: string]: unknown;
  }

  // ── ChannelPlugin ───────────────────────────────────────────────────────────

  export type ChannelConfigSchema = {
    schema: Record<string, unknown>;
    uiHints?: Record<string, any>;
    runtime?: any;
  };

  export interface ChannelPlugin<TAccount = any> {
    id: string;
    meta: {
      id: string;
      label: string;
      selectionLabel: string;
      docsPath: string;
      blurb: string;
      order?: number;
      aliases?: readonly string[];
      docsLabel?: string;
      markdownCapable?: boolean;
    };
    /** 静态能力声明（3.31 起 deleteMessage 已废弃，用 unsend） */
    capabilities: {
      chatTypes: string[];
      media?: boolean;
      polls?: boolean;
      reactions?: boolean;
      edit?: boolean;
      unsend?: boolean;
      reply?: boolean;
      threads?: boolean;
      nativeCommands?: boolean;
      blockStreaming?: boolean;
      /** @deprecated 使用 unsend */
      deleteMessage?: boolean;
    };
    defaults?: { queue?: { debounceMs?: number } };
    reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
    configSchema?: ChannelConfigSchema;
    config: {
      listAccountIds: (cfg: OpenClawConfig) => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
      inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
      /** 3.31 起参数为 cfg（之前为无参） */
      defaultAccountId?: (cfg: OpenClawConfig) => string;
      /** 3.31 起第二个参数增加 cfg */
      describeAccount?: (account: TAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot;
      isEnabled?: (account: TAccount, cfg: OpenClawConfig) => boolean;
      isConfigured?: (account: TAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
      setAccountEnabled?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        enabled: boolean;
      }) => OpenClawConfig;
      deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
      resolveAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => Array<string | number> | undefined;
      formatAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        allowFrom: Array<string | number>;
      }) => string[];
      resolveDefaultTo?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => string | undefined;
    };
    /** 3.31 起所有字段均可选（applyAccountConfig 除外） */
    setup?: {
      resolveAccountId?: (params: {
        cfg: OpenClawConfig;
        accountId?: string;
        input?: any;
      }) => string;
      resolveBindingAccountId?: (params: {
        cfg: OpenClawConfig;
        agentId: string;
        accountId?: string;
      }) => string | undefined;
      applyAccountName?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        name?: string;
      }) => OpenClawConfig;
      /** 3.31: cfg/accountId 均为必选 */
      validateInput?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        input: any;
      }) => string | null;
      applyAccountConfig: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        input: any;
      }) => OpenClawConfig;
      afterAccountConfigWritten?: (params: any) => Promise<void> | void;
    };
    /** 3.31 起 startAccount 不再提供 onReady/onError，使用 setStatus */
    gateway?: {
      startAccount?: (ctx: ChannelGatewayContext<TAccount>) => Promise<unknown>;
      stopAccount?: (ctx: ChannelGatewayContext<TAccount>) => Promise<void>;
      logoutAccount?: (ctx: ChannelLogoutContext<TAccount>) => Promise<ChannelLogoutResult>;
      loginWithQrStart?: (params: any) => Promise<any>;
      loginWithQrWait?: (params: any) => Promise<any>;
    };
    /** 3.31 起使用 ChannelOutboundContext（replyTo → replyToId），deliveryMode 为必选 */
    outbound?: {
      /** 3.31: 必选字段 */
      deliveryMode: "direct" | "gateway" | "hybrid";
      chunker?: ((text: string, limit: number) => string[]) | null;
      textChunkLimit?: number;
      normalizePayload?: (params: { payload: ReplyPayload }) => ReplyPayload | null;
      sendText?: (
        ctx: ChannelOutboundContext,
      ) => Promise<{ channel: string; sent: boolean; messageId?: string; error?: string }>;
      sendMedia?: (
        ctx: ChannelOutboundContext & { mediaUrl: string },
      ) => Promise<{ channel: string; sent: boolean; messageId?: string; error?: string }>;
      sendPayload?: (ctx: any) => Promise<any>;
      sendFormattedText?: (ctx: any) => Promise<any[]>;
      sendFormattedMedia?: (ctx: any) => Promise<any>;
      sendPoll?: (ctx: any) => Promise<any>;
    };
    status?: {
      defaultRuntime?: ChannelAccountSnapshot;
      buildChannelSummary?: (params: {
        account: TAccount;
        cfg: OpenClawConfig;
        defaultAccountId: string;
        snapshot: ChannelAccountSnapshot;
      }) => Record<string, unknown> | Promise<Record<string, unknown>>;
      probeAccount?: (params: {
        account: TAccount;
        timeoutMs: number;
        cfg: OpenClawConfig;
      }) => Promise<any>;
      auditAccount?: (params: any) => Promise<any>;
      buildCapabilitiesDiagnostics?: (params: any) => Promise<any>;
      /** 3.31: cfg 为必选 */
      buildAccountSnapshot?: (params: {
        account?: TAccount;
        cfg: OpenClawConfig;
        runtime?: ChannelAccountSnapshot;
        probe?: any;
        audit?: any;
      }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>;
      logSelfId?: (params: any) => void;
      resolveAccountState?: (params: any) => string;
      collectStatusIssues?: (accounts: ChannelAccountSnapshot[]) => any[];
    };
    directory?: {
      self?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry | null>;
      listPeers?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
      listPeersLive?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
      listGroups?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
      listGroupsLive?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
      listGroupMembers?: (
        params: ChannelDirectoryListParams & { groupId: string },
      ) => Promise<ChannelDirectoryEntry[]>;
    };
    messaging?: {
      normalizeTarget?: (raw: string) => string | undefined;
      targetResolver?: {
        looksLikeId?: (raw: string, normalized?: string) => boolean;
        hint?: string;
        resolveTarget?: (params: any) => Promise<any | null>;
      };
      buildCrossContextComponents?: (params: any) => any[];
      enableInteractiveReplies?: (params: any) => boolean;
      hasStructuredReplyPayload?: (params: any) => boolean;
      parseExplicitTarget?: (params: any) => any | null;
      inferTargetChatType?: (params: any) => string | undefined;
      resolveOutboundSessionRoute?: (params: any) => any;
      resolveSessionTarget?: (params: any) => string | undefined;
    };
    /** 3.31 新增：统一 message tool discovery + 动作处理（describeMessageTool 从 messaging 迁移至此） */
    actions?: ChannelMessageActionAdapter;
    agentPrompt?: {
      messageToolHints?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string[];
      messageToolCapabilities?: (params: any) => string[] | undefined;
      reactionGuidance?: (params: any) => any;
    };
    security?: {
      resolveDmPolicy?: (ctx: any) => any | null;
      collectWarnings?: (ctx: any) => Promise<string[]> | string[];
    };
    groups?: {
      resolveRequireMention?: (params: any) => boolean | undefined;
      resolveGroupIntroHint?: (params: any) => string | undefined;
      resolveToolPolicy?: (params: any) => any | undefined;
    };
    lifecycle?: {
      onAccountConfigChanged?: (params: any) => Promise<void> | void;
      onAccountRemoved?: (params: any) => Promise<void> | void;
    };
    auth?: {
      login?: (params: any) => Promise<void>;
      authorizeActorAction?: (params: any) => { authorized: boolean; reason?: string };
      getActionAvailabilityState?: (params: any) => any;
    };
    /** @deprecated 3.31 起 beforeDispatch 已从 ChannelPlugin 移除，改用 api.registerHook */
    hooks?: never;
    allowlist?: any;
    bindings?: any;
    conversationBindings?: any;
    streaming?: any;
    threading?: any;
    mentions?: any;
    resolver?: any;
    heartbeat?: any;
    pairing?: any;
    agentTools?: any;
    setupWizard?: any;
    elevated?: any;
    commands?: any;
    approvals?: any;
  }

  // ── Plugin Registration ────────────────────────────────────────────────────

  export type ReplyPayload = {
    text?: string;
    /** 多媒体 URL 列表（优先级高于 mediaUrl） */
    mediaUrls?: string[];
    /** 单媒体 URL（向后兼容，优先使用 mediaUrls） */
    mediaUrl?: string;
    replyToId?: string;
    audioAsVoice?: boolean;
    sensitiveMedia?: boolean;
    isError?: boolean;
    isReasoning?: boolean;
    isStatusNotice?: boolean;
    channelData?: Record<string, unknown>;
    /** @deprecated 历史 deliver 路径遗留，新路径请用 mediaUrls */
    files?: Array<{ url: string; name?: string }>;
  };

  export type BeforeDispatchHook = (ctx: any) => any;

  /** 3.31: registrationMode 区分完整注册 vs setup-only vs cli-metadata */
  export type PluginRegistrationMode = "full" | "setup-only" | "setup-runtime" | "cli-metadata";

  export interface OpenClawPluginApi {
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    source?: string;
    /** 3.31 新增：当前注册阶段 */
    registrationMode?: PluginRegistrationMode;
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    runtime: PluginRuntime;
    /** 3.31: logger 已为必选 */
    logger: {
      debug?: (message: string) => void;
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
    registerChannel: (
      registration: { plugin: ChannelPlugin<any> } | ChannelPlugin<any>,
    ) => void;
    /** 3.31 新增：注册内部事件钩子 */
    registerHook: (
      events: string | string[],
      handler: (event: any) => Promise<void> | void,
      opts?: any,
    ) => void;
    registerTool?: (tool: any, opts?: any) => void;
    registerHttpRoute?: (params: any) => void;
    registerGatewayMethod?: (method: string, handler: any, opts?: any) => void;
    registerCli?: (registrar: any, opts?: any) => void;
    registerService?: (service: any) => void;
  }

  // ── Helper functions / constants ───────────────────────────────────────────

  export function buildChannelConfigSchema(schema: any): ChannelConfigSchema;
  export function emptyPluginConfigSchema(): any;

  export const DEFAULT_ACCOUNT_ID: "default";
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

  // ── Onboarding ─────────────────────────────────────────────────────────────

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
}
