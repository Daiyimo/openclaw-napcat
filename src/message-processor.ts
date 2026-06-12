/**
 * 消息处理器
 *
 * 提供文本提取、触发检测和上下文构建的纯函数/近纯函数。
 * 从 channel.ts startAccount 的 message handler 中提取，不改变任何业务逻辑。
 */

import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OneBotEvent } from "./types.js";
import type { OneBotClient } from "./client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QQConfig } from "./config.js";
import { getCachedMemberName } from "./member-cache.js";
import { getBotInfo } from "./known-bots-store.js";
import { cleanCQCodes } from "./message-parser.js";
import { convertSilkToWav } from "./utils/audio-convert.js";
import { transcribeAudioForNapcat } from "./message-parser.js";
import type { Logger } from "./types/channel-types.js";
import { maskId } from "./utils/log-sanitize.js";
import { DEFAULT_RESPONSE_GUIDELINES } from "./constants.js";

// ============ 文本提取 ============

/**
 * 将 OneBot 消息段数组解析为可读文本字符串。
 * 异步：处理语音 STT 和转发消息需调用 client API。
 *
 * @param event       OneBot 事件
 * @param client      OneBotClient 实例（用于获取转发消息、文件 URL）
 * @param config      QQ 配置子集（enableSTT、aiVoiceId）
 * @param openClawCfg 完整 OpenClaw 配置（供 STT 转写使用），可选
 */
export async function resolveMessageText(
  event: OneBotEvent,
  client: OneBotClient,
  config: Pick<QQConfig, "enableSTT" | "aiVoiceId">,
  openClawCfg?: OpenClawConfig,
  log?: Logger,
): Promise<string> {
  let text = event.raw_message || "";

  if (!Array.isArray(event.message)) {
    return text;
  }

  const isGroup = event.message_type === "group";
  const groupId = event.group_id;

  let resolvedText = "";
  for (const seg of event.message) {
    if (seg.type === "text") {
      resolvedText += seg.data?.text || "";
    } else if (seg.type === "at") {
      let name = seg.data?.qq;
      if (name !== "all" && isGroup && groupId) {
        const cached = getCachedMemberName(String(groupId), String(name));
        if (cached) name = cached;
      }
      resolvedText += ` @${name} `;
    } else if (seg.type === "record") {
      if (config.enableSTT && seg.data?.url) {
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `voice-${Date.now()}.amr`);
        let wavPath: string | null = null;
        try {
          const voiceUrl = seg.data.url;
          const voiceResp = await fetch(voiceUrl, { signal: AbortSignal.timeout(30_000) });
          if (voiceResp.ok) {
            const buf = await voiceResp.arrayBuffer();
            await fsSync.promises.writeFile(tmpFile, Buffer.from(buf));
            const wavResult = await convertSilkToWav(tmpFile, tmpDir);
            if (wavResult?.wavPath) {
              wavPath = wavResult.wavPath;
              const transcript = await transcribeAudioForNapcat(
                wavPath,
                openClawCfg ?? ({} as OpenClawConfig),
              );
              resolvedText += transcript
                ? ` [语音转文字: ${transcript}]`
                : ` [语音消息: 转写为空]`;
            } else {
              resolvedText += ` [语音消息: 格式不支持]`;
            }
          } else {
            resolvedText += ` [语音消息: 下载失败]`;
          }
        } catch (sttErr) {
          const errMsg = sttErr instanceof Error ? sttErr.message : String(sttErr);
          (log ?? console).warn(`[message-processor] STT failed: ${errMsg}`, sttErr instanceof Error ? sttErr.cause : undefined);
          resolvedText += ` [语音消息: 转写失败]`;
        } finally {
          try { fsSync.unlinkSync(tmpFile); } catch (e) { (log ?? console).debug(`[message-processor] cleanup tmpFile failed: ${e}`); }
          if (wavPath) { try { fsSync.unlinkSync(wavPath); } catch (e) { (log ?? console).debug(`[message-processor] cleanup wav failed: ${e}`); } }
        }
      } else {
        const textData = seg.data?.text;
        resolvedText += ` [语音消息]${textData ? `(${textData})` : ""}`;
      }
    } else if (seg.type === "image") {
      resolvedText += " [图片]";
    } else if (seg.type === "video") {
      resolvedText += " [视频消息]";
    } else if (seg.type === "json") {
      resolvedText += " [卡片消息]";
    } else if (seg.type === "forward" && seg.data?.id) {
      try {
        const forwardData = await client.getForwardMsg(seg.data.id);
        if (forwardData?.messages && Array.isArray(forwardData.messages)) {
          resolvedText += "\n[转发聊天记录]:";
          for (const m of forwardData.messages.slice(0, 10)) {
            const raw = m.content || m.raw_message || "";
            if (typeof raw === "string" && raw.includes("[CQ:forward")) continue;
            const preview = cleanCQCodes(raw).slice(0, 200);
            resolvedText += `\n${m.sender?.nickname || m.user_id}: ${preview}`;
          }
        }
      } catch (e) {
        (log ?? console).debug(`[message-processor] forward msg fetch failed: ${e}`);
      }
    } else if (seg.type === "file") {
      let fileSeg = seg;
      if (!fileSeg.data?.url && isGroup && groupId) {
        try {
          const info = await client.sendWithResponse("get_group_file_url", {
            group_id: groupId,
            file_id: fileSeg.data?.file_id,
            busid: fileSeg.data?.busid,
          });
          if (info?.url) fileSeg = { ...fileSeg, data: { ...fileSeg.data, url: info.url } };
        } catch (e) {
          (log ?? console).debug(`[message-processor] file URL fetch failed: ${e}`);
        }
      }
      resolvedText += ` [文件: ${fileSeg.data?.file || "未命名"}]`;
    }
  }

  if (resolvedText) text = resolvedText;
  return text;
}

// ============ 触发检测 ============

/**
 * 检测消息是否 @ 了机器人（message 数组或 CQ string 均支持），
 * 或者是否回复了机器人发的消息。
 *
 * @param event      OneBot 事件
 * @param selfId     机器人自身 QQ 号
 * @param text       消息文本（用于 CQ string 检测）
 * @param repliedMsg 被引用的消息对象（用于 reply 触发），可选
 */
export function detectMention(
  event: OneBotEvent,
  selfId: number | string,
  text: string,
  repliedMsg?: { sender?: { user_id?: any } } | null,
  debug = false,
  log?: Logger,
): boolean {
  if (Array.isArray(event.message)) {
    for (const s of event.message) {
      if (s.type === "at") {
        if (String(s.data?.qq) === String(selfId) || s.data?.qq === "all") {
          if (debug) (log ?? console).log(`[napcat-QQ][debug-mention] MATCH at segment qq=${s.data?.qq} selfId=${selfId}`);
          return true;
        }
      }
    }
  } else if (text.includes(`[CQ:at,qq=${selfId}]`)) {
    if (debug) (log ?? console).log(`[napcat-QQ][debug-mention] MATCH text fallback selfId=${selfId}`);
    return true;
  }
  if (repliedMsg?.sender?.user_id !== undefined) {
      if (String(repliedMsg.sender.user_id) === String(selfId)) {
        if (debug) (log ?? console).log(`[napcat-QQ][debug-mention] MATCH reply sender userId=${maskId(repliedMsg.sender.user_id)} selfId=${selfId}`);
        return true;
    }
  }
  return false;
}

/**
 * 检测消息中是否 @ 了其他用户（非 bot 自身、非 @all）。
 * 用于在 @其他人 时跳过所有触发逻辑（被动模式、关键词、回复引用）。
 *
 * @param event  OneBot 事件
 * @param selfId 机器人自身 QQ 号
 */
/**
 * 检测消息中是否 @ 了其他用户（非 bot 自身、非 @all）。
 * 用于在 @其他人 时跳过所有触发逻辑（被动模式、关键词、回复引用）。
 *
 * NapCat 发送端可能 stripping @ 段，只保留纯文本昵称。
 * 此时通过检查消息是否以其他已知 bot 的昵称开头来补判。
 *
 * @param event        OneBot 事件
 * @param selfId       机器人自身 QQ 号
 * @param otherBotNames 其他已知 bot 的昵称列表（用于 NapCat stripping 后的补判）
 */
export function hasMentionOtherUser(
  event: OneBotEvent,
  selfId: number | string,
  otherBotNames?: string[],
): boolean {
  if (!Array.isArray(event.message)) {
    if (typeof event.message === "string") {
      const selfIdStr = String(selfId);
      const atRegex = /\[CQ:at,qq=(\d+)\]/g;
      let m;
      while ((m = atRegex.exec(event.message)) !== null) {
        if (m[1] !== "all" && m[1] !== selfIdStr) return true;
      }
    }
    return false;
  }
  for (const s of event.message) {
    if (s.type === "at") {
      const qq = s.data?.qq;
      if (qq !== "all" && String(qq) !== String(selfId)) {
        return true;
      }
    }
  }

  // NapCat stripping 补判：消息以其他 bot 昵称开头 → 视为隐式 @
  if (otherBotNames && otherBotNames.length > 0) {
    const text = typeof event.message === "string"
      ? event.message
      : event.message.filter(s => s.type === "text").map(s => s.data?.text || "").join("");
    const trimmed = text.trimStart();
    for (const name of otherBotNames) {
      if (!name || name === String(selfId)) continue;
      if (trimmed.startsWith(name)) {
        // 名字后必须紧跟空白或句末标点，避免 "我爱你小爱" 误命中
        const after = trimmed.slice(name.length);
        if (after.length === 0 || /^[\s，。！？!?,."'、；;：:（(）)]/.test(after)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * 检测文本是否包含任意触发关键词。
 */
export function detectKeywordTrigger(
  text: string,
  keywords: string[] | undefined,
): boolean {
  if (!keywords || keywords.length === 0) return false;
  for (const kw of keywords) {
    if (text.includes(kw)) return true;
  }
  return false;
}

/**
 * 检测消息中是否包含 bot 的名字（自我认知触发）。
 * 用于在群聊中区分不同的 bot，只有被叫到名字的 bot 才响应。
 *
 * @param text     消息文本
 * @param botName  bot 的名字（来自 QQ 昵称或群名片）
 * @param debug    是否输出调试日志
 */
export function detectNameTrigger(
  text: string,
  botName: string | undefined,
  debug = false,
  log?: Logger,
): boolean {
  if (!botName || botName.trim().length === 0) return false;

  // 清理 botName：去除前后空格，转为小写进行匹配
  const cleanName = botName.trim();
  const textLower = text.toLowerCase();
  const nameLower = cleanName.toLowerCase();

  // 检测消息中是否包含 bot 名字
  const matched = textLower.includes(nameLower);

    if (debug && matched) {
      (log ?? console).log(`[napcat-QQ][debug-name-trigger] MATCH botName="${cleanName}" in text="${text.slice(0, 50)}"`);
    }

  return matched;
}

/**
 * 判断消息是否指向本 bot（v1.11+ 多 bot 路由门控）。
 *
 * 群聊/频道消息必须 @本 bot / 含本 bot 名字才放行；
 * 文本以其他已知 bot 名字开头（NapCat stripping 补判）则视为指向其他 bot。
 * 私聊天然通过。
 *
 * 设计：单一纯函数，供 inbound pipeline 顶层门控 + 守卫内 defense-in-depth 共用。
 *
 * @param event          OneBot 事件
 * @param selfId         本 bot QQ 号（必传，但允许 undefined 兜底放行）
 * @param text           消息文本
 * @param selfName       本 bot 昵称（来自 QQ 昵称或群名片）
 * @param otherBotNames  其他已知 bot 的昵称列表（用于 NapCat stripping 补判）
 */
export function isMessageDirectedAtBot(
  event: OneBotEvent,
  selfId: number | string | undefined,
  text: string,
  selfName: string | undefined,
  otherBotNames?: string[],
): boolean {
  // 私聊/非群聊场景：天然指向
  if (event.message_type !== "group" && event.message_type !== "guild") {
    return true;
  }

  const selfIdStr = selfId != null ? String(selfId) : null;

  // 扫描 at 段，区分"@本 bot（含 @all）"和"@其他"
  let isMentionedSelf = false;
  let isMentionedOther = false;
  if (Array.isArray(event.message)) {
    for (const s of event.message) {
      if (s.type === "at") {
        const qq = s.data?.qq;
        if (qq === "all" || (selfIdStr != null && String(qq) === selfIdStr)) {
          isMentionedSelf = true;
        } else {
          isMentionedOther = true;
        }
      }
    }
  } else if (selfIdStr) {
    // CQ 字符串格式：扫描 [CQ:at,qq=...]（与 detectMention 行为一致）
    if (text.includes(`[CQ:at,qq=${selfIdStr}]`) || text.includes("[CQ:at,qq=all]")) {
      isMentionedSelf = true;
    } else if (/\[CQ:at,qq=\d+\]/.test(text)) {
      isMentionedOther = true;
    }
  }

  // @本 bot → 放行（@self 优先于 @other）
  if (isMentionedSelf) return true;

  // @其他（已知/未知用户或其他 bot）→ 不放行
  if (isMentionedOther) return false;

  // 名字命中（含 substring 匹配）→ 放行
  if (selfName && detectNameTrigger(text, selfName, false)) return true;

  // NapCat stripping 补判：文本以其他 bot 昵称开头 → 视为指向其他 bot
  if (otherBotNames && otherBotNames.length > 0) {
    const trimmed = text.trimStart();
    for (const name of otherBotNames) {
      if (!name || (selfIdStr != null && name === selfIdStr)) continue;
      if (trimmed.startsWith(name)) {
        // 名字后必须紧跟空白/标点/句末，避免子串误命中（如"小爱"在"我爱你小爱"中）
        const after = trimmed.slice(name.length);
        if (after.length === 0 || /^[\s，。！？!?,."'、；;：:（(）)]/.test(after)) {
          return false;
        }
      }
    }
  }

  // 未 @ 任何人 → 中性消息，放行至被动模式由冷却/间隔策略决定
  return true;
}

/**
 * 根据配置中的 knownBotIds 构建其他 bot 的昵称列表和 ID 集合。
 * 一次性返回 names（用于 isMessageDirectedAtBot / hasMentionOtherUser 的补判）
 * 和 idSet（用于 O(1) 白名单检测，替代 .some() 线性扫描）。
 */
export function buildOtherBotNames(
  accountId: string,
  knownBotIds: (number | string)[] | undefined,
  selfId: string,
): { names: string[]; idSet: Set<string> } {
  const names: string[] = [];
  const idSet = new Set<string>();
  if (knownBotIds?.length) {
    for (const botId of knownBotIds) {
      const idStr = String(botId);
      if (idStr === selfId) continue;
      idSet.add(idStr);
      const info = getBotInfo(accountId, idStr);
      const name = info?.card || info?.nickname;
      if (name) names.push(name);
    }
  }
  return { names, idSet };
}

// ============ 上下文构建 ============

/**
 * 根据消息类型构建 fromId 字符串。
 * - 私聊：userId 字符串
 * - 群聊：group:groupId
 * - 频道：guild:guildId:channelId
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

const DEFAULT_PASSIVE_PROMPT =
  "你是群里话不多但很有分量的成员，**只在被 @ 时才回复**；\n" +
  "若消息 @ 的是别的用户或 bot 而不是你,不要代替被 @ 者回应,也不要做「我是 X bot,管不了别人的 bot」式的自我意识式解释——这种回答无价值且暴露 AI 痕迹。\n" +
  "对管理类指令(修改配置/查询/调整等)必须严格判断消息是否 @ 了你本人:没 @ 你就 [SILENT]。\n" +
  "对 @ 了你认识的其他 bot 的消息(昵称会在 [系统提示] 中标出),你可以自然地加入对话,但不要每条都插——只在话题真有趣或你有不同看法时才简短开口。\n" +
  "没想说的、不该你回的,回复 [SILENT]。";

/**
 * 构建发送给 AI 的完整消息体。
 * 包含 reply 引用（如有）、systemPrompt 块、historyContext 块、旁观模式块。
 *
 * @param opts.text           消息文本（可含 CQ 码，内部会 cleanCQCodes）
 * @param opts.repliedMsg     被引用消息对象（可为 null）
 * @param opts.systemPrompt   QQ 配置的 systemPrompt
 * @param opts.historyContext 群历史消息字符串
 * @param opts.isPassiveMode  是否处于旁观模式
 * @param opts.passivePrompt  旁观模式自定义提示词（undefined 使用默认）
 */
export function buildBodyWithReply(opts: {
  text: string;
  repliedMsg: {
    raw_message?: string;
    message?: string;
    sender?: { nickname?: string; card?: string; user_id?: any };
  } | null;
  systemPrompt: string | undefined;
  historyContext: string;
  isPassiveMode: boolean;
  passivePrompt: string | undefined;
  /** 本 bot 的 QQ 号，用于剥离发送给自己的友军签名 */
  botSelfId?: string | number;
  /** 本 bot 的昵称，用于自我认知 */
  botName?: string;
  /** 消息中 @ 的已知 bot 列表（v1.8+ 被动观测插话用） */
  mentionsKnownBot?: Array<{ selfId: string; nickname?: string; card?: string }>;
  /**
   * 回复格式硬约束。undefined = 用 DEFAULT_RESPONSE_GUIDELINES;
   * 空字符串 = 完全关闭约束;非空字符串 = 替换默认。
   * v1.9.1+ 用于防止 reasoning 类模型把 CoT 混到回复里。
   */
  responseGuidelines?: string;
}): string {
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
  // 剥离友军签名 [BOT:${selfId}]，防止 AI 学到签名并复现
  const botId = opts.botSelfId;
  const strippedText = botId
    ? cleanText.replace(new RegExp(`\\[BOT:${botId}\\]`, "g"), "")
    : cleanText;
  const bodyWithReply = strippedText + replySuffix;

  let systemBlock = "";

  // ── 回复格式硬约束（v1.9.1+）────────────────────────────────
  // 默认注入 DEFAULT_RESPONSE_GUIDELINES,把约束放在 system prompt 顶部,
  // 让 LLM 在生成任何回复前先看到格式要求。
  // 关闭方式:传 responseGuidelines: ""
  // 替换方式:传 responseGuidelines: "你的自定义约束..."
  const guidelines = opts.responseGuidelines ?? DEFAULT_RESPONSE_GUIDELINES;
  if (guidelines) {
    systemBlock += `<response_guidelines>\n${guidelines}\n</response_guidelines>\n\n`;
  }

  // 注入 bot 身份信息（自我认知）——v1.9.4 提到 response_guidelines 之后,
  // 让 AI 早期就知道"我是谁"避免 @ 别人时混淆身份（之前放末尾权重不够）
  const botName = opts.botName;
  if (botId || botName) {
    let identity = "<identity>";
    if (botName) identity += `你的名字是${botName}，`;
    if (botId) identity += `你的QQ号是${botId}`;
    identity += "</identity>\n\n";
    systemBlock += identity;
  }

  if (systemPrompt) systemBlock += `<system>${systemPrompt}</system>\n\n`;
  if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
  if (isPassiveMode) {
    const prompt = passivePrompt ?? DEFAULT_PASSIVE_PROMPT;
    systemBlock += `<passive_mode>${prompt}</passive_mode>\n\n`;
    // 被动观测：消息 @ 了已知 bot 时提示 AI 可以自然加入
    if (mentionsKnownBot && mentionsKnownBot.length > 0) {
      const names = mentionsKnownBot
        .map((b) => b.card || b.nickname || b.selfId)
        .join(", ");
      systemBlock += `<system_hint>这条消息 @ 了你认识的其他 bot: ${names}。你可以自然地加入对话，但不要每条都插——只在话题真有趣或你有不同看法时才简短开口。</system_hint>\n\n`;
    }
  }

  return systemBlock + bodyWithReply;
}
