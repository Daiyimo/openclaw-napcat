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
  admins: z.array(z.number().int().positive()).optional().describe("List of admin QQ numbers"),
  requireMention: z.boolean().optional().default(true).describe("Require @mention or reply to bot in group chats"),
  systemPrompt: z.string().optional().describe("Custom system prompt to inject into the context"),
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
  botSignatureStyle: z.enum(["visible", "zero-width"]).optional().default("visible").describe("Bot signature format: 'visible' uses [BOT:selfId] (reliable, user-visible), 'zero-width' uses invisible Unicode characters (clean UX, may be stripped by some platforms)"),
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
  }).optional().describe("Passive observation mode: AI watches all group messages and decides whether to chime in. AI replies [SILENT] to stay quiet."),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;

/** 从 schema 提取所有默认值。注意：safeParse 不填充 .default()，需手动合并。 */
export function getQQConfigDefaults(): QQConfig {
  return QQConfigSchema.parse({});
}
