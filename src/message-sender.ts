/**
 * 消息发送器
 *
 * 封装 channel.ts 的 actualDeliver 逻辑。
 * 每条入站消息创建一个实例（per-message context 在构造时固定）。
 */

import type { OneBotClient } from "./client.js";
import type { QQConfig } from "./config.js";
import type { OneBotMessage } from "./types.js";
import type { UploadCache } from "./upload-cache.js";
import {
  splitMessage,
  stripMarkdown,
  processAntiRisk,
  isImageFile,
  isVideoFile,
  extractMediaUrlsFromText,
  resolveMediaUrl,
} from "./message-parser.js";
import { parseMediaTagsToSendQueue } from "./media-send.js";
import { appendBotSignature } from "./utils/bot-signature.js";
import { markStopped } from "./dialog-state.js";
import { DEFAULT_BOT_SIGNATURE_STYLE } from "./constants.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 按 isGroup/isGuild 分发消息段到正确的 OneBot API。
 * 消除 message-sender.ts 中 6+ 处重复的 if/else 分支。
 */
async function sendByTarget(
  client: OneBotClient,
  segments: OneBotMessage | string,
  ctx: MessageSenderContext,
): Promise<void> {
  if (ctx.isGroup) {
    await client.sendGroupMsg(ctx.groupId!, segments);
  } else if (ctx.isGuild) {
    await client.sendGuildChannelMsg(ctx.guildId!, ctx.channelId!, segments);
  } else {
    await client.sendPrivateMsg(ctx.userId!, segments);
  }
}

export interface MessageSenderContext {
  client: OneBotClient;
  config: QQConfig;
  uploadCache: UploadCache;
  /** 当前账号 ID，用于 uploadCache key 构建 */
  accountId: string;
  isGroup: boolean;
  isGuild: boolean;
  groupId: number | undefined;
  userId: number | undefined;
  guildId: string | undefined;
  channelId: string | undefined;
}

export class MessageSender {
  constructor(private readonly ctx: MessageSenderContext) {}

  /**
   * 完整投递一个 ReplyPayload（text + mediaUrls / mediaUrl + files）。
   */
  async deliver(payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    files?: Array<{ url?: string; name?: string }>;
    [key: string]: unknown;
  }): Promise<void> {
    // 拦截 [END_DIALOG] token：AI 在多 bot 对话中觉得话题聊不下去时返回此 token
    // 行为：不实际发送，标记该群对话已结束（其他 bot 静默 60s）
    if (payload.text?.trim() === "[END_DIALOG]") {
      if (this.ctx.isGroup && this.ctx.groupId !== undefined) {
        markStopped(this.ctx.accountId, `group:${this.ctx.groupId}`);
      }
      return;
    }
    if (payload.text) await this.sendText(payload.text);

    const urls: string[] = [];
    if (payload.mediaUrls?.length) urls.push(...payload.mediaUrls);
    else if (payload.mediaUrl) urls.push(payload.mediaUrl);
    for (const url of urls) {
      await this.sendMediaUrl(url);
    }

    if (payload.files) {
      for (const f of payload.files) {
        if (f.url) await this.sendFile(f.url, f.name);
      }
    }
  }

  /**
   * 发送纯文本。处理 markdown 模式、anti-risk、分片、TTS 和从文本中提取的媒体。
   *
   * 优先使用媒体标签系统（<qqimg>path</qqimg>），回退到 URL 正则提取。
   */
  private async sendText(text: string): Promise<void> {
    const { client, config, isGroup, isGuild, groupId, userId, guildId, channelId } = this.ctx;

    let processed = text;
    const effectiveMarkdownMode =
      config.markdownMode ?? (config.formatMarkdown ? "strip" : "passthrough");
    if (effectiveMarkdownMode === "strip") processed = stripMarkdown(processed);
    if (config.antiRiskMode) processed = processAntiRisk(processed);

    // 群消息所需参数：签名追加到最后一个 chunk（避免被 splitMessage 切开）
    const botSelfId = isGroup ? client.getSelfId() : null;
    const style = config.botSignatureStyle ?? DEFAULT_BOT_SIGNATURE_STYLE;

    // ── 媒体标签优先路径 ──
    const { hasMediaTags, sendQueue } = parseMediaTagsToSendQueue(processed);
    if (hasMediaTags) {
      // 找最后一个 text 项，签名追加到那里
      let lastTextIdx = -1;
      for (let i = sendQueue.length - 1; i >= 0; i--) {
        if (sendQueue[i].type === "text") { lastTextIdx = i; break; }
      }
      let isFirstChunk = true;
      for (let idx = 0; idx < sendQueue.length; idx++) {
        const item = sendQueue[idx];
        if (item.type === "text") {
          let content = item.content;
          if (botSelfId && idx === lastTextIdx) {
            content = appendBotSignature(content, botSelfId, style);
          }
          const chunks = splitMessage(content, config.maxMessageLength || 4000);
          for (const chunk of chunks) {
            await this.sendTextChunk(chunk, effectiveMarkdownMode, isFirstChunk);
            isFirstChunk = false;
            if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
          }
        } else if (item.type === "image") {
          try {
            const resolvedUrl = await resolveMediaUrl(item.content);
            const imgSeg: OneBotMessage = [{ type: "image", data: { file: resolvedUrl } }];
            await sendByTarget(client, imgSeg, this.ctx);
          } catch (err) {
            console.warn(`[message-sender] Failed to send media tag image ${item.content}:`, err);
          }
          if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
        }
      }
      return;
    }

    // ── 回退路径 ──
    // 签名追加到最后一个 chunk（避免被 splitMessage 切开）
    const chunks = [...splitMessage(processed, config.maxMessageLength || 4000)];
    if (botSelfId && chunks.length > 0) {
      chunks[chunks.length - 1] = appendBotSignature(chunks[chunks.length - 1], botSelfId, style);
    }
    for (let i = 0; i < chunks.length; i++) {
      await this.sendTextChunk(chunks[i], effectiveMarkdownMode, i === 0);
      if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
    }
  }

  /**
   * 发送单个文本分片。处理 markdown 模式、@提及、TTS 和从文本中提取的媒体。
   */
  private async sendTextChunk(
    chunk: string,
    markdownMode: string,
    isFirst: boolean,
  ): Promise<void> {
    const { client, config, isGroup, isGuild, groupId, userId, guildId, channelId } = this.ctx;

    // ── 发送文本 ──
    if (markdownMode === "native") {
      const mdSegments: OneBotMessage = [];
      if (isGroup && isFirst)
        mdSegments.push({ type: "at", data: { qq: String(userId) } });
      mdSegments.push({ type: "markdown", data: { content: chunk } });
      await sendByTarget(client, mdSegments, this.ctx);
    } else {
      if (isGroup) {
        const segments: OneBotMessage = [];
        if (isFirst) {
          segments.push({ type: "at", data: { qq: String(userId) } });
          segments.push({ type: "text", data: { text: " " + chunk } });
        } else {
          segments.push({ type: "text", data: { text: chunk } });
        }
        await client.sendGroupMsg(groupId!, segments);
      } else if (isGuild) {
        await client.sendGuildChannelMsg(guildId!, channelId!, chunk);
      } else {
        await client.sendPrivateMsg(userId!, chunk);
      }
    }

    // ── TTS（第一个分片且文字足够短）──
    if (!isGuild && config.enableTTS && isFirst && chunk.length < 100) {
      const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
      if (tts) {
        try {
          if (isGroup && config.aiVoiceId) {
            await client.sendGroupAiRecord(groupId!, tts, config.aiVoiceId);
          } else if (isGroup) {
            await client.sendGroupMsg(groupId!, [{ type: "tts", data: { text: tts } }]);
          } else {
            await client.sendPrivateMsg(userId!, [{ type: "tts", data: { text: tts } }]);
          }
        } catch {
          // TTS 失败不影响消息投递
        }
      }
    }

    // ── 从文本中提取媒体 URL 并以原生格式发送 ──
    const extractedMedia = extractMediaUrlsFromText(chunk);
    for (const media of extractedMedia) {
      try {
        const resolvedUrl = await resolveMediaUrl(media.url);
        if (media.type === "image") {
          const imgSeg: OneBotMessage = [{ type: "image", data: { file: resolvedUrl } }];
          await sendByTarget(client, imgSeg, this.ctx);
        } else if (media.type === "video") {
          const vidSeg: OneBotMessage = [{ type: "video", data: { file: resolvedUrl } }];
          await sendByTarget(client, vidSeg, this.ctx);
        } else {
          const fileName = media.name || "file";
          try {
            if (isGroup) await client.uploadGroupFile(groupId!, resolvedUrl, fileName);
            else if (!isGuild) await client.uploadPrivateFile(userId!, resolvedUrl, fileName);
            else await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${resolvedUrl}`);
          } catch {
            const fileSeg: OneBotMessage = [{ type: "file", data: { file: resolvedUrl, name: fileName } }];
            if (isGuild) {
              await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${resolvedUrl}`);
            } else {
              await sendByTarget(client, fileSeg, this.ctx);
            }
          }
        }
        if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
      } catch (mediaErr) {
        console.warn(`[message-sender] Failed to send extracted media ${media.url}:`, mediaErr);
      }
    }
  }

  /**
   * 发送单个媒体 URL。
   * 根据文件扩展名自动选择 image / video / file 段类型。
   * file 类型先尝试 uploadGroupFile/uploadPrivateFile，失败后 fallback 到 file 段。
   *
   * @public 供 deliver 和 channel.ts outbound.sendMedia 调用
   */
  async sendMediaUrl(rawUrl: string, fileName?: string): Promise<void> {
    const { client, config, isGroup, isGuild, groupId, userId, guildId, channelId } = this.ctx;
    const url = await resolveMediaUrl(rawUrl);
    const name = fileName || decodeURIComponent(url.split("?")[0].split("/").pop() || "file");

    if (isImageFile(rawUrl) || isImageFile(url)) {
      const imgSeg: OneBotMessage = [{ type: "image", data: { file: url } }];
      await sendByTarget(client, imgSeg, this.ctx);
    } else if (isVideoFile(rawUrl) || isVideoFile(url)) {
      const vidSeg: OneBotMessage = [{ type: "video", data: { file: url } }];
      await sendByTarget(client, vidSeg, this.ctx);
    } else {
      try {
        if (isGroup) await client.uploadGroupFile(groupId!, url, name);
        else if (!isGuild) await client.uploadPrivateFile(userId!, url, name);
        else await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
      } catch {
        const fileSeg: OneBotMessage = [{ type: "file", data: { file: url, name } }];
        if (isGuild) {
          await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
        } else {
          await sendByTarget(client, fileSeg, this.ctx);
        }
      }
    }
    if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
  }

  /**
   * 发送文件（带上传缓存）。图片走 image 段；其他走 upload，命中缓存则复用 file_id。
   */
  private async sendFile(rawUrl: string, name: string | undefined): Promise<void> {
    const { client, config, isGroup, isGuild, groupId, userId, guildId, channelId, uploadCache, accountId } = this.ctx;

    const cacheKey = uploadCache.buildKey(accountId, rawUrl);
    const cachedFileId = uploadCache.get(cacheKey);

    if (cachedFileId) {
      console.log(`[message-sender] Upload cache hit for ${rawUrl}`);
      const fileSegment: OneBotMessage = [{ type: "file", data: { file: cachedFileId, name: name || "file" } }];
      if (isGuild) {
        await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${rawUrl}`);
      } else {
        await sendByTarget(client, fileSegment, this.ctx);
      }
    } else {
      const url = await resolveMediaUrl(rawUrl);
      if (isImageFile(url) || isImageFile(rawUrl)) {
        const imgSegment: OneBotMessage = [{ type: "image", data: { file: url } }];
        await sendByTarget(client, imgSegment, this.ctx);
      } else {
        const fileName = name || "file";
        try {
          if (isGroup) {
            await client.uploadGroupFile(groupId!, url, fileName);
            uploadCache.set(cacheKey, url);
          } else if (!isGuild) {
            await client.uploadPrivateFile(userId!, url, fileName);
            uploadCache.set(cacheKey, url);
          } else {
            await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
          }
        } catch {
          const fileSegment: OneBotMessage = [{ type: "file", data: { file: url, name: fileName } }];
          if (isGuild) {
            await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
          } else {
            await sendByTarget(client, fileSegment, this.ctx);
          }
        }
      }
    }
    if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
  }
}
