import { z } from "zod";

export const QQConfigSchema = z.object({
  /** @internal 运行时注入：机器人自身 QQ 号，不持久化到配置 */
  _selfId: z.number().int().optional(),
  /** @internal 运行时注入：机器人昵称（来自QQ昵称或群名片），不持久化到配置 */
  _selfName: z.string().optional(),
  wsUrl: z.string().url().optional().describe("The WebSocket URL of the OneBot v11 server (e.g. ws://localhost:3001). Optional if reverseWsPort is set"),
  httpUrl: z.string().url().optional().describe("The HTTP API URL of the OneBot v11 server (e.g. http://localhost:3000) for outbound message sending"),
  reverseWsPort: z.number().int().min(1).max(65535).optional().describe("Port to start a reverse WebSocket server on, for NapCat to connect to (e.g. 3002)"),
  accessToken: z.string().optional().describe("The access token for the OneBot server"),
  requireReverseWsToken: z.boolean().optional().default(false).describe("Require accessToken for reverse WebSocket connections. Default false for backward compatibility. Set to true to reject reverse WS connections when no accessToken is configured (more secure)"),
  admins: z.array(z.number().int().positive()).optional().describe("List of admin QQ numbers for this specific bot account. Combined with sharedAdmins for the effective admin check."),
  /** @deprecated Use sharedAdmins instead — this field is per-account; sharedAdmins applies to all accounts */
  sharedAdmins: z.array(z.number().int().positive()).optional().describe("Admin QQ numbers shared across ALL bot accounts in this deployment. Users in this list are treated as admins by every bot, regardless of which account's admins list they appear in. Use this when multiple bots share a common admin group (e.g. 戴以沫 managing both 爱弥斯 and 云崽)."),
  requireMention: z.boolean().optional().default(true).describe("Require @mention or reply to bot in group chats"),
  systemPrompt: z.string().optional().describe("Custom system prompt to inject into the context"),
  /**
   * 回复格式硬约束:硬性规定 LLM 不要输出 CoT / meta 注释 / 英文内部推理。
   * 默认 = DEFAULT_RESPONSE_GUIDELINES(注入在 system prompt 顶部)。
   * 传空字符串 "" 关闭约束(完全信任 LLM 自身的输出格式)。
   * 传自定义字符串:替换默认。
   */
  responseGuidelines: z.string().optional().describe("Response format constraints injected at the top of system prompt. Default = DEFAULT_RESPONSE_GUIDELINES. Empty string disables."),
  enableDeduplication: z.boolean().optional().default(true).describe("Enable message deduplication to prevent double replies"),
  enableErrorNotify: z.boolean().optional().default(true).describe("Notify admins or users when errors occur"),
  autoApproveRequests: z.boolean().optional().default(false).describe("Automatically approve friend/group add requests"),
  maxMessageLength: z.number().int().min(100).max(10000).optional().default(4000).describe("Maximum length of a single message before splitting"),
  formatMarkdown: z.boolean().optional().default(false).describe("Format markdown to plain text for better readability"),
  antiRiskMode: z.boolean().optional().default(false).describe("Enable anti-risk processing (e.g. modify URLs)"),
  allowedGroups: z.array(z.number().int().positive()).optional().describe("Whitelist of group IDs allowed to interact with"),
  blockedUsers: z.array(z.number().int().positive()).optional().describe("Blacklist of user IDs to ignore"),
  ignoreSenderBot: z.boolean().optional().default(true).describe("Ignore messages from other bot accounts (sender.bot=true) to prevent bot-to-bot loops. When true, bot messages are dropped and passiveMode.botSuppressionMs takes effect; when false, bot messages pass through and botSuppressionMs has no effect"),
  knownBotIds: z.array(z.number().int().positive()).optional().describe("Manual whitelist of known bot QQ numbers. These IDs are always recognized as bots even without sender.bot flag or [BOT:] signature. Useful for bots that don't support auto-discovery."),
  botSignatureStyle: z.enum(["none", "visible", "zero-width"]).optional().default("visible").describe("Bot identification strategy: 'visible' (default) appends [BOT:selfId] to message text — reliable, no startup spam. 'zero-width' uses invisible Unicode characters (clean UX, may be stripped by some platforms). 'none' disables text signatures entirely (relies solely on sender.bot, knownBotIds whitelist, and persistent known-bots cache). Note: an earlier 'metadata' option (OneBot json-segment handshake) was removed in v1.9.2 because json segments render as visible card messages in QQ, causing startup broadcast spam."),
  debug: z.boolean().optional().default(false).describe("Enable verbose debug logging for message processing pipeline (self-filter, bot-filter, mention, reaction). Recommended only for troubleshooting"),
  historyLimit: z.number().int().min(0).max(100).optional().default(5).describe("Number of history messages to include in context"),
  keywordTriggers: z.array(z.string()).optional().describe("List of keywords that trigger the bot (without @)"),
  enableTTS: z.boolean().optional().default(false).describe("Experimental: Convert AI text replies to voice (TTS)"),
  rateLimitMs: z.number().int().min(0).max(60000).optional().default(1000).describe("Delay in ms between sent messages to avoid risk"),
  reactionEmoji: z.string().optional().describe("Emoji ID to react on incoming trigger messages (e.g. '128077' for thumbs up). Empty = disabled"),
  enableReactions: z.boolean().optional().default(true).describe("Enable smart emoji reactions based on message content. Uses keyword matching to pick the most fitting emoji. Set to false to disable."),
  autoMarkRead: z.boolean().optional().default(false).describe("Automatically mark messages as read to prevent unread pile-up"),
  aiVoiceId: z.string().optional().describe("NapCat AI voice character ID for send_group_ai_record. Used when enableTTS is true"),
  enableSTT: z.boolean().optional().default(false).describe("Enable speech-to-text transcription for voice messages (requires STT provider configured)"),
  markdownMode: z.enum(["strip", "native", "passthrough"]).optional().default("passthrough").describe("How to handle markdown in replies: 'passthrough' sends raw markdown text, 'strip' removes markdown formatting, 'native' wraps in NapCat markdown message segment"),
  deliverDebounce: z.object({
    enabled: z.boolean().optional(),
    windowMs: z.number().int().min(100).max(30000).optional(),
    maxWaitMs: z.number().int().min(1000).max(120000).optional(),
    separator: z.string().optional(),
  }).optional().refine(
    (d) => !d || !d.windowMs || !d.maxWaitMs || d.maxWaitMs >= d.windowMs,
    { message: "deliverDebounce.maxWaitMs must be >= windowMs" },
  ).describe("Debounce consecutive text replies into one message (windowMs default 1500, maxWaitMs default 8000)"),
  enableUpdateCheck: z.boolean().optional().default(true).describe("Check npm registry for plugin updates on startup"),
  logBufferSize: z.number().int().min(10).max(10000).optional().default(200).describe("Number of log lines to retain for /logs command"),
  inboundRateLimitMs: z.number().int().min(0).max(60000).optional().default(0).describe("Per-user/group inbound rate limit in ms. 0 = disabled. E.g. 3000 means the same source can only trigger AI once every 3 seconds"),
  silentKeywords: z.array(z.string().min(1)).optional().describe("Silent keyword list. If the message body contains any of these, the message is silently dropped without triggering AI or sending any reply"),
  passiveMode: z.object({
    enabled: z.boolean().optional().default(false),
    cooldownMs: z.number().int().min(0).max(3600000).optional().default(10000),
    /** 两次旁观 AI 调用之间的最小间隔（含 [SILENT] 响应），ms */
    minIntervalMs: z.number().int().min(0).max(3600000).optional().default(30000),
    /** 友军识别：检测到其他 bot 回复后静默的时长（ms），0 = 禁用 */
    botSuppressionMs: z.number().int().min(0).max(3600000).optional().default(120000),
    systemPrompt: z.string().optional(),
    /**
     * 主动回复"温度"（0–100）。单一数值控制 passive mode 的三个频率参数：
     * cooldownMs / minIntervalMs / botSuppressionMs。
     * 设置后覆盖同级的三个子参数（但 systemPrompt 不受影响）。
     *
     * 关键帧映射：
     *   0   → cooldown=60s  minInterval=120s  botSuppression=300s  (几乎不插话)
     *   50  → cooldown=10s  minInterval=30s   botSuppression=120s  (当前默认)
     *   100 → cooldown=2s   minInterval=5s    botSuppression=30s   (很活跃)
     *
     * 与子参数共存时 temperature 优先。未设置时各子参数独立生效。
     */
    temperature: z.number().int().min(0).max(100).optional(),
  }).optional().describe("Passive observation mode: AI watches all group messages and decides whether to chime in. AI replies [SILENT] to stay quiet."),
  // ── 多 bot 对话控制（v1.8+） ─────────────────────────────────────
  /** 多 bot 对话轮数硬上限（含本 bot 自身回复）。超过后本 bot 不再响应其他 bot 消息，直到用户发新消息重置。默认 5 */
  botDialogMaxRounds: z.number().int().min(1).max(50).optional().default(5).describe("Hard cap on consecutive bot-to-bot exchanges before self-quiet (resets on user message). Default 5."),
  /** 对话空闲超时（ms）：群内无新消息超过此值后，对话状态重置。默认 60s */
  dialogTimeoutMs: z.number().int().min(1000).max(3600000).optional().default(60000).describe("Dialog state reset after this many ms of no new messages. Default 60s."),
  /** 用户停止意图关键词：消息含任一关键词时，bot 进入"停止对话"状态 */
  botStopKeywords: z.array(z.string().min(1)).optional().describe("User stop-intent keywords. When any keyword is in the user message, bots enter 'dialog stopped' state and may reply with a brief acknowledgement."),
  /** 用户停止指令时，本 bot 是否响应结束语（默认 true）。禁用后所有 bot 收到停止指令直接静默 */
  botStopReplyEnabled: z.boolean().optional().default(true).describe("When user sends a stop-intent message, whether THIS bot may reply with a brief acknowledgement (decided by selfId hash for distribution). Default true."),
  /** 用户停止指令时，回结束语的 bot 比例（0-1）。默认 0.66（2/3 的 bot 会响应） */
  botStopReplyRatio: z.number().min(0).max(1).optional().default(0.66).describe("Fraction of bots that reply with a stop-acknowledgement. Default 0.66 (≈2/3)."),
  /** 用户停止指令时，回结束语的 bot 错开延迟上限（ms）。延迟 = hash(selfId) % maxMs */
  botStopReplyDelayMaxMs: z.number().int().min(0).max(5000).optional().default(300).describe("Max stagger delay (ms) for stop-acknowledgement replies. Default 300ms."),
  // ── 系统文件预拦截（v1.10+） ─────────────────────────────────────
  /**
   * 非管理员系统文件保护：检测非 admin 用户是否在请求修改人设/记忆/身份等
   * 系统文件，命中时直接 reply 一句拒绝消息并 return，不调用 OpenClaw。
   *
   * 治标原因：OpenClaw 主项目 LLM tool dispatch 层不消费 CommandAuthorized，
   * 在 napcat 网关侧把消息挡在 OpenClaw 调用之前是用户可控的最快防线。
   * 默认开启（fail-secure）。Admin 完全不受影响。
   */
  sensitiveFileGuard: z.object({
    enabled: z.boolean().optional().default(true).describe("Block non-admin users from instructing the agent to modify persona/memory files. Default true."),
    files: z.array(z.string().min(1)).optional().describe("Protected file basenames (case-insensitive). Default: SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md."),
    verbs: z.array(z.string().min(1)).optional().describe("Intent verbs that, combined with a noun, trigger the guard. Default contains 中文 改/修改/更新/重写/设置/覆盖/写入/替换 and 英文 edit/modify/update/rewrite/set/overwrite/write/replace."),
    nouns: z.array(z.string().min(1)).optional().describe("Intent nouns paired with verbs. Default contains 中文 人设/灵魂/记忆/身份/人格/性格 and 英文 soul/agents/memory/identity/persona."),
    rejectMessage: z.string().optional().describe("Custom rejection text sent to non-admin sender. Default contains a generic admin-only notice."),
  }).optional().describe("Pre-dispatch guard against non-admin persona/memory file modification."),
  // ── 休眠模式 ─────────────────────────────────────────────────
  /**
   * 休眠模式：在指定时段内，bot 仅响应 @mention 和关键词触发，
   * 被动模式/旁观模式/名字触发全部静默。使用服务器本地时间。
   *
   * 跨午夜区间（如 23→7）：hour >= startHour || hour < endHour
   * 普通区间（如 2→6）：   hour >= startHour && hour < endHour
   */
  sleepMode: z.object({
    enabled: z.boolean().optional().default(false).describe("Enable sleep mode. Default false."),
    startHour: z.number().int().min(0).max(23).optional().default(23).describe("Sleep start hour (0-23). Default 23 (11 PM)."),
    endHour: z.number().int().min(0).max(23).optional().default(7).describe("Sleep end hour (0-23). Default 7 (7 AM)."),
  }).optional().describe("Sleep mode: during [startHour, endHour), only @mention and keyword triggers work. Passive mode and name triggers are suppressed. Uses server local time."),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;

/** 从 schema 提取所有默认值。注意：safeParse 不填充 .default()，需手动合并。 */
export function getQQConfigDefaults(): QQConfig {
  return QQConfigSchema.parse({});
}

// ── passiveMode temperature 映射 ───────────────────────────────────────────

/**
 * 将 temperature（0–100）映射到被动模式的三个频率参数。
 *
 * 三关键帧分段线性插值：
 *
 *   cooldownMs:       t=0 → 60_000   t=50 → 10_000   t=100 → 2_000
 *   minIntervalMs:    t=0 → 120_000  t=50 → 30_000   t=100 → 5_000
 *   botSuppressionMs: t=0 → 300_000  t=50 → 120_000  t=100 → 30_000
 *
 * 中间值在同段内线性插值；50 恰好命中默认值。
 *
 * @param temperature 0–100，undefined 或 null 则返回 null（调用方保留原有值）
 */
export function resolvePassiveModeTemperature(
  temperature: number | undefined | null,
): Partial<{
  cooldownMs: number;
  minIntervalMs: number;
  botSuppressionMs: number;
}> | null {
  if (temperature == null) return null;
  const clamped = Math.max(0, Math.min(100, temperature));

  const lerp = (t: number, tStart: number, tEnd: number, vStart: number, vEnd: number) =>
    Math.round(vStart + (vEnd - vStart) * (t - tStart) / (tEnd - tStart));

  return {
    cooldownMs: clamped <= 50
      ? lerp(clamped, 0, 50, 60_000, 10_000)
      : lerp(clamped, 50, 100, 10_000, 2_000),
    minIntervalMs: clamped <= 50
      ? lerp(clamped, 0, 50, 120_000, 30_000)
      : lerp(clamped, 50, 100, 30_000, 5_000),
    botSuppressionMs: clamped <= 50
      ? lerp(clamped, 0, 50, 300_000, 120_000)
      : lerp(clamped, 50, 100, 120_000, 30_000),
  };
}
