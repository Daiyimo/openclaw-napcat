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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
   */
  private async sendText(text: string): Promise<void> {
    const { client, config, isGroup, isGuild, groupId, userId, guildId, channelId } = this.ctx;

    let processed = text;
    const effectiveMarkdownMode =
      config.markdownMode ?? (config.formatMarkdown ? "strip" : "passthrough");
    if (effectiveMarkdownMode === "strip") processed = stripMarkdown(processed);
    if (config.antiRiskMode) processed = processAntiRisk(processed);

    const chunks = splitMessage(processed, config.maxMessageLength || 4000);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      if (effectiveMarkdownMode === "native") {
        const mdSegments: OneBotMessage = [];
        if (isGroup && i === 0)
          mdSegments.push({ type: "at", data: { qq: String(userId) } });
        mdSegments.push({ type: "markdown", data: { content: chunk } });
        if (isGroup) await client.sendGroupMsg(groupId!, mdSegments);
        else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, mdSegments);
        else await client.sendPrivateMsg(userId!, mdSegments);
      } else {
        if (isGroup) {
          const segments: OneBotMessage = [];
          if (i === 0) {
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

      // TTS（第一个分片且文字足够短）
      if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
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

      // 从文本中提取媒体 URL 并以原生格式发送
      const extractedMedia = extractMediaUrlsFromText(chunk);
      for (const media of extractedMedia) {
        try {
          const resolvedUrl = await resolveMediaUrl(media.url);
          if (media.type === "image") {
            const imgSeg: OneBotMessage = [{ type: "image", data: { file: resolvedUrl } }];
            if (isGroup) await client.sendGroupMsg(groupId!, imgSeg);
            else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, imgSeg);
            else await client.sendPrivateMsg(userId!, imgSeg);
          } else if (media.type === "video") {
            const vidSeg: OneBotMessage = [{ type: "video", data: { file: resolvedUrl } }];
            if (isGroup) await client.sendGroupMsg(groupId!, vidSeg);
            else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, vidSeg);
            else await client.sendPrivateMsg(userId!, vidSeg);
          } else {
            const fileName = media.name || "file";
            try {
              if (isGroup) await client.uploadGroupFile(groupId!, resolvedUrl, fileName);
              else if (!isGuild) await client.uploadPrivateFile(userId!, resolvedUrl, fileName);
              else await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${resolvedUrl}`);
            } catch {
              const fileSeg: OneBotMessage = [{ type: "file", data: { file: resolvedUrl, name: fileName } }];
              if (isGroup) await client.sendGroupMsg(groupId!, fileSeg);
              else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${resolvedUrl}`);
              else await client.sendPrivateMsg(userId!, fileSeg);
            }
          }
          if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
        } catch (mediaErr) {
          console.warn(`[message-sender] Failed to send extracted media ${media.url}:`, mediaErr);
        }
      }

      if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
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
      if (isGroup) await client.sendGroupMsg(groupId!, imgSeg);
      else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, imgSeg);
      else await client.sendPrivateMsg(userId!, imgSeg);
    } else if (isVideoFile(rawUrl) || isVideoFile(url)) {
      const vidSeg: OneBotMessage = [{ type: "video", data: { file: url } }];
      if (isGroup) await client.sendGroupMsg(groupId!, vidSeg);
      else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, vidSeg);
      else await client.sendPrivateMsg(userId!, vidSeg);
    } else {
      try {
        if (isGroup) await client.uploadGroupFile(groupId!, url, name);
        else if (!isGuild) await client.uploadPrivateFile(userId!, url, name);
        else await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
      } catch {
        const fileSeg: OneBotMessage = [{ type: "file", data: { file: url, name } }];
        if (isGroup) await client.sendGroupMsg(groupId!, fileSeg);
        else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
        else await client.sendPrivateMsg(userId!, fileSeg);
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
      if (isGroup) await client.sendGroupMsg(groupId!, fileSegment);
      else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${rawUrl}`);
      else await client.sendPrivateMsg(userId!, fileSegment);
    } else {
      const url = await resolveMediaUrl(rawUrl);
      if (isImageFile(url) || isImageFile(rawUrl)) {
        const imgSegment: OneBotMessage = [{ type: "image", data: { file: url } }];
        if (isGroup) await client.sendGroupMsg(groupId!, imgSegment);
        else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, imgSegment);
        else await client.sendPrivateMsg(userId!, imgSegment);
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
          if (isGroup) await client.sendGroupMsg(groupId!, fileSegment);
          else if (isGuild) await client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
          else await client.sendPrivateMsg(userId!, fileSegment);
        }
      }
    }
    if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
  }
}
