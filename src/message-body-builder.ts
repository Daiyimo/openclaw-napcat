/**
 * 消息体构建模块
 *
 * 负责构建发送给 AI 的完整消息体，包括 reply 引用、systemPrompt、
 * historyContext、旁观模式提示等。
 * 从 message-processor.ts 提取，不改变任何业务逻辑。
 */

import { cleanCQCodes } from "./message-parser.js";
import { DEFAULT_RESPONSE_GUIDELINES } from "./constants.js";
import type { Logger } from "./types/channel-types.js";

// ============ 常量 ==========

/** 友军签名剥离正则缓存：botId → RegExp（热路径缓存，避免重复编译） */
const BOT_SIG_STRIP_CACHE = new Map<string, RegExp>();

/** 获取或创建友军签名剥离正则（按 botId 缓存） */
function getBotSigStripRegex(botId: string | number): RegExp {
  const key = String(botId);
  const cached = BOT_SIG_STRIP_CACHE.get(key);
  if (cached) return cached;
  const escaped = String(botId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[BOT:${escaped}\\]`, "g");
  BOT_SIG_STRIP_CACHE.set(key, re);
  return re;
}

const DEFAULT_PASSIVE_PROMPT =
  "你是群里话不多但很有分量的成员，**只在被 @ 时才回复**；\n" +
  "若消息 @ 的是别的用户或 bot 而不是你,不要代替被 @ 者回应,也不要做「我是 X bot,管不了别人的 bot」式的自我意识式解释——这种回答无价值且暴露 AI 痕迹。\n" +
  "对管理类指令(修改配置/查询/调整等)必须严格判断消息是否 @ 了你本人:没 @ 你就 [SILENT]。\n" +
  "对 @ 了你认识的其他 bot 的消息(昵称会在 [系统提示] 中标出),你可以自然地加入对话,但不要每条都插——只在话题真有趣或你有不同看法时才简短开口。\n" +
  "没想说的、不该你回的,回复 [SILENT]。";

// ============ fromId 构建 ============

/**
 * 根据消息类型构建 fromId 字符串。
 */
export function buildFromId(
  isGroup: boolean,
  isGuild: boolean,
  userId: number | undefined,
  groupId: number | undefined,
  guildId: string | undefined,
  channelId: string | undefined,
): string {
  if (isGroup) return `group:${groupId}`;
  if (isGuild) return `guild:${guildId}:${channelId}`;
  return String(userId);
}

// ============ 消息体构建 ============

export interface BuildBodyOpts {
  text: string;
  repliedMsg: {
    raw_message?: string;
    message?: string;
    sender?: { nickname?: string; card?: string; user_id?: number };
  } | null;
  systemPrompt: string | undefined;
  historyContext: string;
  isPassiveMode: boolean;
  passivePrompt: string | undefined;
  botSelfId?: string | number;
  botName?: string;
  mentionsKnownBot?: Array<{ selfId: string; nickname?: string; card?: string }>;
  responseGuidelines?: string;
}

/**
 * 构建发送给 AI 的完整消息体。
 * 包含 reply 引用、systemPrompt、historyContext、旁观模式提示。
 */
export function buildBodyWithReply(opts: BuildBodyOpts): string {
  const { text, repliedMsg, systemPrompt, historyContext, isPassiveMode, passivePrompt, mentionsKnownBot } = opts;

  let replyToBody = "";
  let replyToSender = "";
  if (repliedMsg) {
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

  const cleanText = cleanCQCodes(text);
  const botId = opts.botSelfId;
  const strippedText = botId != null
    ? cleanText.replace(getBotSigStripRegex(botId), "")
    : cleanText;
  const bodyWithReply = strippedText + replySuffix;

  let systemBlock = "";

  // ── 回复格式硬约束 ─────────────────────────────────
  const guidelines = opts.responseGuidelines ?? DEFAULT_RESPONSE_GUIDELINES;
  if (guidelines) {
    systemBlock += `<response_guidelines>\n${guidelines}\n</response_guidelines>\n\n`;
  }

  // 注入 bot 身份信息（自我认知）
  if (botId || opts.botName) {
    let identity = "<identity>";
    if (opts.botName) identity += `你的名字是${opts.botName}，`;
    if (botId) identity += `你的QQ号是${botId}`;
    identity += "</identity>\n\n";
    systemBlock += identity;
  }

  if (systemPrompt) systemBlock += `<system>${systemPrompt}</system>\n\n`;
  if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
  if (isPassiveMode) {
    const prompt = passivePrompt ?? DEFAULT_PASSIVE_PROMPT;
    systemBlock += `<passive_mode>${prompt}</passive_mode>\n\n`;
    if (mentionsKnownBot && mentionsKnownBot.length > 0) {
      const names = mentionsKnownBot
        .map((b) => b.card || b.nickname || b.selfId)
        .join(", ");
      systemBlock += `<system_hint>这条消息 @ 了你认识的其他 bot: ${names}。你可以自然地加入对话，但不要每条都插——只在话题真有趣或你有不同看法时才简短开口。</system_hint>\n\n`;
    }
  }

  return systemBlock + bodyWithReply;
}
