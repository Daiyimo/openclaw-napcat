// OpenClaw Plugin SDK Type Declarations
// 对齐 openclaw 2026.6.11 source
// 采用最小化声明：仅覆盖插件实际使用的接口

declare module "openclaw/plugin-sdk" {
  // ── 基础类型 ─────────────────────────────────────────────────────────────

  /** 聊天类型：direct（私聊）/ group（群）/ channel（频道） */
  export type ChatType = "direct" | "group" | "channel";

  // ── 基础运行时 ─────────────────────────────────────────────────────────────

  export interface PluginRuntimeChannel {
    reply: {
      dispatchReplyWithBufferedBlockDispatcher?: (params: {
        ctx: any;
        cfg: any;
        dispatcherOptions: { deliver: (payload: any) => Promise<void>; onError?: (err: unknown, info: any) => void };
        replyOptions?: { onReplyStart?: () => Promise<void> | void };
      }) => Promise<void>;
    };
    session: {
      resolveStorePath?: (store?: any, opts?: { agentId?: string }) => string;
      recordInboundSession?: (params: {
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
    };
    activity: {
      record: (params: {
        channel: string;
        accountId: string;
        direction: "inbound" | "outbound";
      }) => void;
    };
    text?: any;
    routing?: any;
    media?: any;
    mentions?: any;
    reactions?: any;
    groups?: any;
    debounce?: any;
    commands?: any;
    outbound?: any;
    inbound?: any;
  }

  export interface PluginRuntime {
    version?: string;
    channel: PluginRuntimeChannel;
    subagent?: any;
    config?: any;
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

  export type ChannelGatewayContext<TAccount = unknown> = {
    cfg: OpenClawConfig;
    accountId: string;
    account: TAccount;
    runtime: any;
    abortSignal: AbortSignal;
    log?: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (next: ChannelAccountSnapshot) => void;
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
    runtime: any;
    log?: any;
  };

  // ── Outbound 上下文 ─────────────────────────────────────────────────────────

  export type ChannelOutboundContext = {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    audioAsVoice?: boolean;
    mediaAccess?: any;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    gifPlayback?: boolean;
    forceDocument?: boolean;
    replyToId?: string | null;
    replyToIdSource?: "explicit" | "implicit";
    replyToMode?: any;
    formatting?: any;
    threadId?: string | number | null;
    accountId?: string | null;
    identity?: any;
    deps?: any;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
  };

  export type ChannelOutboundSessionRoute = {
    sessionKey: string;
    baseSessionKey: string;
    peer: { kind: ChatType; id: string };
    chatType: "direct" | "group" | "channel";
    from: string;
    to: string;
    threadId?: string | number;
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
    senderIsOwner?: boolean;
    [key: string]: any;
  };

  export type ChannelMessageToolDiscovery = {
    actions?: readonly string[] | null;
    capabilities?: readonly string[] | null;
    schema?: any;
  };

  export type ChannelMessageActionAdapter = {
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

  export type ChannelDirectoryListParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    query?: string | null;
    limit?: number | null;
    runtime: any;
  };

  export type ChannelDirectoryEntryKind = "user" | "group" | "channel";

  export type ChannelDirectoryEntry = {
    kind: "user" | "group" | "channel";
    id: string;
    name?: string;
    handle?: string;
    avatarUrl?: string;
    rank?: number;
    raw?: unknown;
    type?: "user" | "group";
    metadata?: any;
  };

  // ── Account Snapshot ────────────────────────────────────────────────────────

  export interface ChannelAccountSnapshot {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    statusState?: string;
    linked?: boolean;
    running?: boolean;
    connected?: boolean;
    restartPending?: boolean;
    reconnectAttempts?: number;
    lastConnectedAt?: number | null;
    lastDisconnect?: string | {
      at: number;
      status?: number;
      error?: string;
      loggedOut?: boolean;
    } | null;
    lastMessageAt?: number | null;
    lastEventAt?: number | null;
    lastTransportActivityAt?: number | null;
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
    dmPolicy?: string;
    allowFrom?: string[];
    tokenSource?: string;
    botTokenSource?: string;
    appTokenSource?: string;
    signingSecretSource?: string;
    tokenStatus?: string;
    botTokenStatus?: string;
    appTokenStatus?: string;
    signingSecretStatus?: string;
    userTokenStatus?: string;
    credentialSource?: string;
    secretSource?: string;
    audienceType?: string;
    audience?: string;
    webhookPath?: string;
    webhookUrl?: string;
    baseUrl?: string;
    allowUnmentionedGroups?: boolean;
    cliPath?: string | null;
    dbPath?: string | null;
    port?: number | null;
    probe?: unknown;
    lastProbeAt?: number | null;
    audit?: unknown;
    application?: unknown;
    bot?: unknown;
    publicKey?: string | null;
    profile?: unknown;
    channelAccessToken?: string;
    channelSecret?: string;
  }

  // ── ChannelPlugin ───────────────────────────────────────────────────────────

  export type ChannelConfigSchema = {
    schema: Record<string, unknown>;
    uiHints?: Record<string, any>;
    runtime?: any;
  };

  export interface ChannelPlugin<
    ResolvedAccount = any,
    Probe = unknown,
    Audit = unknown,
  > {
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
      selectionDocsPrefix?: string;
      selectionDocsOmitLabel?: boolean;
      selectionExtras?: readonly string[];
      detailLabel?: string;
      systemImage?: string;
      exposure?: any;
      showConfigured?: boolean;
      showInSetup?: boolean;
      quickstartAllowFrom?: boolean;
      forceAccountBinding?: boolean;
      preferSessionLookupForAnnounceTarget?: boolean;
      preferOver?: readonly string[];
    };
    capabilities: {
      chatTypes: Array<ChatType | "thread">;
      polls?: boolean;
      reactions?: boolean;
      edit?: boolean;
      unsend?: boolean;
      reply?: boolean;
      effects?: boolean;
      groupManagement?: boolean;
      threads?: boolean;
      media?: boolean;
      nativeCommands?: boolean;
      blockStreaming?: boolean;
    };
    setupWizard?: any;
    defaults?: { queue?: { debounceMs?: number } };
    reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
    configSchema?: ChannelConfigSchema;
    config: {
      listAccountIds: (cfg: OpenClawConfig) => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
      inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
      defaultAccountId?: (cfg: OpenClawConfig) => string;
      describeAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot;
      isEnabled?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean;
      isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
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
      afterAccountConfigWritten?: (params: {
        previousCfg: OpenClawConfig;
        cfg: OpenClawConfig;
        accountId: string;
        input: any;
        runtime: any;
      }) => Promise<void> | void;
    };
    gatewayMethods?: string[];
    gatewayMethodDescriptors?: { name: string; scope?: string; description?: string }[];
    gateway?: {
      startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
      stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
      logoutAccount?: (ctx: ChannelLogoutContext<ResolvedAccount>) => Promise<ChannelLogoutResult>;
      loginWithQrStart?: (params: any) => Promise<any>;
      loginWithQrWait?: (params: any) => Promise<any>;
    };
    outbound?: {
      deliveryMode: "direct" | "gateway" | "hybrid";
      chunker?: ((text: string, limit: number, ctx?: any) => string[]) | null;
      textChunkLimit?: number;
      normalizePayload?: (params: { payload: any }) => any | null;
      sendText?: (ctx: ChannelOutboundContext) => Promise<{ channel: string; sent: boolean; messageId?: string; error?: string }>;
      sendMedia?: (ctx: ChannelOutboundContext & { mediaUrl: string }) => Promise<{ channel: string; sent: boolean; messageId?: string; error?: string }>;
      sendPayload?: (ctx: any) => Promise<any>;
      sendFormattedText?: (ctx: any) => Promise<any[]>;
      sendFormattedMedia?: (ctx: any) => Promise<any>;
      sendPoll?: (ctx: any) => Promise<any>;
    };
    status?: {
      defaultRuntime?: ChannelAccountSnapshot;
      buildChannelSummary?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        defaultAccountId: string;
        snapshot: ChannelAccountSnapshot;
      }) => Record<string, unknown> | Promise<Record<string, unknown>>;
      probeAccount?: (params: {
        account: ResolvedAccount;
        timeoutMs: number;
        cfg: OpenClawConfig;
      }) => Promise<Probe>;
      auditAccount?: (params: any) => Promise<any>;
      buildCapabilitiesDiagnostics?: (params: any) => Promise<any>;
      buildAccountSnapshot?: (params: {
        account?: ResolvedAccount;
        cfg: OpenClawConfig;
        runtime?: ChannelAccountSnapshot;
        probe?: Probe;
        audit?: Audit;
      }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>;
      logSelfId?: (params: any) => void;
      resolveAccountState?: (params: any) => string;
      collectStatusIssues?: (accounts: ChannelAccountSnapshot[]) => any[];
    };
    directory?: {
      self?: (params: { cfg: OpenClawConfig; accountId?: string | null; runtime: any }) => Promise<ChannelDirectoryEntry | null>;
      listPeers?: (params: { cfg: OpenClawConfig; accountId?: string | null; query?: string | null; limit?: number | null; runtime: any }) => Promise<ChannelDirectoryEntry[]>;
      listPeersLive?: (params: { cfg: OpenClawConfig; accountId?: string | null; query?: string | null; limit?: number | null; runtime: any }) => Promise<ChannelDirectoryEntry[]>;
      listGroups?: (params: { cfg: OpenClawConfig; accountId?: string | null; query?: string | null; limit?: number | null; runtime: any }) => Promise<ChannelDirectoryEntry[]>;
      listGroupsLive?: (params: { cfg: OpenClawConfig; accountId?: string | null; query?: string | null; limit?: number | null; runtime: any }) => Promise<ChannelDirectoryEntry[]>;
      listGroupMembers?: (
        params: { cfg: OpenClawConfig; accountId?: string | null; groupId: string; limit?: number | null; runtime: any },
      ) => Promise<ChannelDirectoryEntry[]>;
    };
    messaging?: {
      normalizeTarget?: (raw: string) => string | undefined;
      targetResolver?: {
        looksLikeId?: (raw: string, normalized?: string) => boolean;
        hint?: string;
        reservedLiterals?: readonly string[];
        resolveTarget?: (params: {
          cfg: OpenClawConfig;
          accountId?: string | null;
          input: string;
          normalized: string;
          preferredKind?: ChannelDirectoryEntryKind | "channel";
        }) => Promise<{
          to: string;
          kind: ChannelDirectoryEntryKind | "channel";
          display?: string;
          source?: "normalized" | "directory";
        } | null>;
      };
      buildCrossContextComponents?: (params: any) => any[];
      enableInteractiveReplies?: (params: any) => boolean;
      hasStructuredReplyPayload?: (params: any) => boolean;
      parseExplicitTarget?: (params: any) => any | null;
      inferTargetChatType?: (params: { to: string }) => ChatType | undefined;
      resolveOutboundSessionRoute?: (params: {
        cfg: OpenClawConfig;
        agentId: string;
        accountId?: string | null;
        target: string;
        currentSessionKey?: string;
        resolvedTarget?: {
          to: string;
          kind: ChannelDirectoryEntryKind | "channel";
          display?: string;
          source: "normalized" | "directory";
        };
        replyToId?: string | null;
        threadId?: string | number | null;
      }) => ChannelOutboundSessionRoute | Promise<ChannelOutboundSessionRoute | null> | null;
      resolveSessionTarget?: (params: any) => string | undefined;
    };
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
    groups?: any;
    lifecycle?: {
      onAccountConfigChanged?: (params: any) => Promise<void> | void;
      onAccountRemoved?: (params: any) => Promise<void> | void;
    };
    auth?: any;
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
    elevated?: any;
    commands?: any;
    approvals?: any;
  }

  // ── Plugin Registration ────────────────────────────────────────────────────

  export type ReplyPayload = {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
    audioAsVoice?: boolean;
    sensitiveMedia?: boolean;
    isError?: boolean;
    isReasoning?: boolean;
    isStatusNotice?: boolean;
    channelData?: Record<string, unknown>;
    files?: Array<{ url: string; name?: string }>;
  };

  export type PluginRegistrationMode = "full" | "setup-only" | "setup-runtime" | "cli-metadata" | "discovery" | "tool-discovery";

  export interface OpenClawPluginApi {
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    source?: string;
    registrationMode?: PluginRegistrationMode;
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    runtime: PluginRuntime;
    logger: {
      debug?: (message: string) => void;
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
    registerChannel: (
      registration: { plugin: ChannelPlugin<any> } | ChannelPlugin<any>,
    ) => void;
    registerHook?: (
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

  /** Shared setup input bag used by CLI, onboarding, and setup adapters. */
  export type ChannelSetupInput = {
    name?: string;
    token?: string;
    privateKey?: string;
    tokenFile?: string;
    secret?: string;
    secretFile?: string;
    botToken?: string;
    appToken?: string;
    signalNumber?: string;
    cliPath?: string;
    dbPath?: string;
    service?: "imessage" | "sms" | "auto";
    region?: string;
    authDir?: string;
    httpUrl?: string;
    httpHost?: string;
    httpPort?: string;
    webhookPath?: string;
    webhookUrl?: string;
    audienceType?: string;
    audience?: string;
    useEnv?: boolean;
    homeserver?: string;
    dangerouslyAllowPrivateNetwork?: boolean;
    allowPrivateNetwork?: boolean;
    proxy?: string;
    userId?: string;
    accessToken?: string;
    password?: string;
    deviceName?: string;
    wsUrl?: string;
    reverseWsPort?: number | string;
    avatarUrl?: string;
    initialSyncLimit?: number;
    profile?: string;
    ship?: string;
    url?: string;
    baseUrl?: string;
    relayUrls?: string;
    code?: string;
    groupChannels?: string[];
    dmAllowlist?: string[];
    autoDiscoverChannels?: boolean;
  };

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
}
