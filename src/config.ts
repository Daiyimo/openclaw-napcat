import { z } from "zod";

export const QQConfigSchema = z.object({
  wsUrl: z.string().url().describe("OneBot v11 正向 WebSocket 地址 (例如 ws://localhost:3001)"),
  httpUrl: z.string().url().optional().describe("OneBot v11 HTTP API 地址 (例如 http://localhost:3000)，用于发送 Emoji 反应或文件"),
  reverseWsPort: z.number().optional().describe("反向 WebSocket 监听端口，供 NapCat 主动连接 (例如 3002)"),
  accessToken: z.string().optional().describe("OneBot 服务端访问令牌 (Access Token)"),
  admins: z.array(z.number()).optional().describe("管理员 QQ 号列表"),
  requireMention: z.boolean().optional().default(true).describe("群聊中是否需要 @ 机器人或回复机器人消息才触发回复"),
  systemPrompt: z.string().optional().describe("自定义系统提示词，注入 AI 上下文"),
  enableDeduplication: z.boolean().optional().default(true).describe("启用消息去重，防止在网络波动时重复回复"),
  enableErrorNotify: z.boolean().optional().default(true).describe("服务出错时是否通知用户或管理员"),
  autoApproveRequests: z.boolean().optional().default(false).describe("是否自动通过好友申请或入群邀请"),
  maxMessageLength: z.number().optional().default(4000).describe("单条消息最大字符限制，超出后将自动分片发送"),
  formatMarkdown: z.boolean().optional().default(false).describe("是否将 Markdown 转换为纯文本，以获得更好的阅读体验"),
  antiRiskMode: z.boolean().optional().default(false).describe("开启风控对抗模式（如在 URL 后添加空格防止屏蔽）"),
  allowedGroups: z.array(z.number()).optional().describe("白名单：仅允许在这些群组内互动"),
  blockedUsers: z.array(z.number()).optional().describe("黑名单：不响应这些 QQ 号的消息"),
  historyLimit: z.number().optional().default(5).describe("上下文中包含的历史消息条数"),
  keywordTriggers: z.array(z.string()).optional().describe("关键词触发列表（无需 @ 即可触发机器人）"),
  enableTTS: z.boolean().optional().default(false).describe("实验性功能：将 AI 回复转换为语音消息发送"),
  enableGuilds: z.boolean().optional().default(true).describe("是否启用 QQ 频道（Guild）支持"),
  rateLimitMs: z.number().optional().default(1000).describe("多条消息发送时的间隔延迟（毫秒），降低封号风险"),
  
  // 核心功能配置：Emoji 反应逻辑
  reactionEmoji: z.string().optional().default("auto").describe("消息触发时的表情反应设置。'auto' 表示由 AI 自动选择（推荐）；输入数字 ID 表示固定反应；留空则禁用此功能。"),
  
  autoMarkRead: z.boolean().optional().default(false).describe("是否自动将接收的消息设为已读"),
  aiVoiceId: z.string().optional().describe("使用 NapCat AI 语音时的角色 ID（需开启 enableTTS）"),
  
  // NapCat 4.17.25+ 增强功能
  enableOcr: z.boolean().optional().default(false).describe("是否启用图片 OCR 识别，识别后的文字会进入 AI 上下文"),
  enableUrlCheck: z.boolean().optional().default(false).describe("是否启用链接安全检测（防止发送违规 URL）"),
  enableGroupHonor: z.boolean().optional().default(false).describe("是否允许通过指令获取群荣誉信息"),
  enableGroupSignIn: z.boolean().optional().default(false).describe("是否允许使用自动群打卡功能"),
  autoCleanCache: z.boolean().optional().default(false).describe("是否定期自动清理图片/语音缓存"),
  enableEssenceMsg: z.boolean().optional().default(false).describe("是否开启精华消息管理功能"),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;