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
import type { Logger } from "./types/channel-types.js";
import type { MetricsCollector } from "./metrics.js";
import {
  splitMessage,
  stripMarkdown,
  processAntiRisk,
  isImageFile,
  isVideoFile,
  extractMediaUrlsFromText,
  resolveMediaUrl,
  isUrlPrivate,
} from "./message-parser.js";
import { parseMediaTagsToSendQueue } from "./media-send.js";
import { appendBotSignature } from "./utils/bot-signature.js";
import { markStopped } from "./dialog-state.js";
import { isSilentToken, getLog } from "./admin-commands/shared.js";
import { DEFAULT_BOT_SIGNATURE_STYLE } from "./constants.js";

import { sleep } from "./utils/sleep.js";

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
  log?: Logger;
  /** 指标收集器（可选） */
  metrics?: MetricsCollector;
}

export class MessageSender {
  constructor(private readonly ctx: MessageSenderContext) {}

  /** 发送 TTS 语音消息（群聊用 AI 语音或普通 TTS，私聊用普通 TTS） */
  private async sendTts(text: string): Promise<void> {
    const { client, config, isGroup, groupId, userId } = this.ctx;
    if (isGroup && config.aiVoiceId) {
      await client.sendGroupAiRecord(groupId!, text, config.aiVoiceId);
    } else {
      await sendByTarget(client, [{ type: "tts", data: { text } }], this.ctx);
    }
  }

  /**
   * 上传文件，失败后 fallback 到 file 段发送。
   * 返回 true 表示上传成功（调用方可据此决定是否写入缓存等后续操作）。
   */
  private async uploadWithFallback(
    url: string,
    name: string,
    isGroup: boolean,
    isGuild: boolean,
    groupId: number | undefined,
    userId: number | undefined,
    guildId: string | undefined,
    channelId: string | undefined,
  ): Promise<boolean> {
    try {
      if (isGroup) await this.ctx.client.uploadGroupFile(groupId!, url, name);
      else if (!isGuild) await this.ctx.client.uploadPrivateFile(userId!, url, name);
      else await this.ctx.client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
      return true;
    } catch (uploadErr) {
      getLog(this.ctx.log).warn(
        `[message-sender] upload failed for ${url}, falling back to file segment:`,
        uploadErr instanceof Error ? uploadErr.message : uploadErr,
      );
      const fileSeg: OneBotMessage = [{ type: "file", data: { file: url, name } }];
      if (isGuild) {
        await this.ctx.client.sendGuildChannelMsg(guildId!, channelId!, `[文件] ${url}`);
      } else {
        await sendByTarget(this.ctx.client, fileSeg, this.ctx);
      }
      return false;
    }
  }

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
    // v1.9.4 拦截 silent 类 token:真 silent(完全不发送任何消息,只 log)
    // 之前只在 outbound.sendText 路径拦截,但 AI 派发走 MessageSender.deliver,
    // 漏拦截导致"[SILENT]"或"@user [SILENT]"真的发出去了。
    // [END_DIALOG] 同步标记对话停止状态，避免 stale state。
    const trimmed = payload.text?.trim() ?? "";
    if (isSilentToken(trimmed)) {
      if (trimmed === "[END_DIALOG]" && this.ctx.isGroup && this.ctx.groupId !== undefined) {
        markStopped(this.ctx.accountId, `group:${this.ctx.groupId}`);
      }
      // 真 silent:什么都不发,仅 log 留痕(便于 /logs 命令查)
      getLog(this.ctx.log).log(`[napcat-QQ][silent] dropped token "${trimmed}" (to=${this.ctx.isGroup ? `group:${this.ctx.groupId}` : `private:${this.ctx.userId}`})`);
      this.ctx.metrics?.increment("outbound", "silentDropped");
      return;
    }

    // 检测 incomplete turn 错误（模型返回空响应），替换为友好提示
    if (trimmed && /incomplete\s+turn\s+detected/i.test(trimmed)) {
      getLog(this.ctx.log).warn(
        `[napcat-QQ][incomplete-turn] detected, suppressed raw error, sending friendly message. ` +
        `provider=stepfun-plan/step-3.7-flash, payloads=0`
      );
      this.ctx.metrics?.increment("outbound", "incompleteTurn");
      // 不发送原始错误堆栈给用户，改为静默失败（框架会在 session 内记录）
      return;
    }
    try {
      if (payload.text) {
        await this.sendText(payload.text);
        this.ctx.metrics?.increment("outbound", "sent");
      }

      const urls: string[] = [];
      if (payload.mediaUrls?.length) urls.push(...payload.mediaUrls);
      else if (payload.mediaUrl) urls.push(payload.mediaUrl);
      for (const url of urls) {
        await this.sendMediaUrl(url);
        this.ctx.metrics?.increment("outbound", "mediaSent");
      }

      if (payload.files) {
        for (const f of payload.files) {
          if (f.url) await this.sendFile(f.url, f.name);
        }
      }
    } catch (err) {
      this.ctx.metrics?.increment("outbound", "failed");
      throw err;
    }
  }

  /**
   * 发送纯文本。处理 markdown 模式、anti-risk、分片、TTS 和从文本中提取的媒体。
   *
   * 优先使用媒体标签系统（<qqimg>path</qqimg>），回退到 URL 正则提取。
   */
  private async sendText(text: string): Promise<void> {
    const { client, config, log, isGroup, isGuild, groupId, userId, guildId, channelId } = this.ctx;

    let processed = text;
    const effectiveMarkdownMode =
      config.markdownMode ?? (config.formatMarkdown ? "strip" : "passthrough");
    if (effectiveMarkdownMode === "strip") processed = stripMarkdown(processed);
    if (config.antiRiskMode) processed = processAntiRisk(processed);

    // 群消息所需参数：签名追加到最后一个 chunk（避免被 splitMessage 切开）
    // 优先用昵称(由 connection.ts 启动时 getLoginInfo().nickname 注入),UID 兜底
    const botSelfId = isGroup ? client.getSelfId() : null;
    const botName = isGroup ? (config._selfName ?? null) : null;
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
            content = appendBotSignature(content, botName, botSelfId, style);
          }
          const chunks = splitMessage(content, config.maxMessageLength);
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
            getLog(this.ctx.log).warn(`[message-sender] Failed to send media tag image ${item.content}:`, err);
          }
          if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
        }
      }
      return;
    }

    // ── 回退路径 ──
    // 签名追加到最后一个 chunk（避免被 splitMessage 切开）
    const chunks = [...splitMessage(processed, config.maxMessageLength)];
    if (botSelfId && chunks.length > 0) {
      chunks[chunks.length - 1] = appendBotSignature(chunks[chunks.length - 1], botName, botSelfId, style);
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
    const { client, config, log, isGroup, isGuild, groupId, userId, guildId, channelId } = this.ctx;

    // ── 发送文本 ──
    // deliver() 已拦截纯 silent token；此处仅判断是否跳过 @ 段（避免"@user [SILENT]"泄漏）
    const trimmed = chunk.trim();
    const isSilentChunk = trimmed === "[END_DIALOG]" || trimmed === "[SILENT]";

    if (markdownMode === "native") {
      const mdSegments: OneBotMessage = [];
      if (isGroup && isFirst && !isSilentChunk && userId != null)
        mdSegments.push({ type: "at", data: { qq: String(userId) } });
      mdSegments.push({ type: "markdown", data: { content: chunk } });
      await sendByTarget(client, mdSegments, this.ctx);
    } else {
      if (isGroup) {
        const segments: OneBotMessage = [];
        if (isFirst && !isSilentChunk && userId != null) {
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
          await this.sendTts(tts);
        } catch (ttsErr) {
          getLog(this.ctx.log).debug("[message-sender] TTS failed (non-critical):", ttsErr instanceof Error ? ttsErr.message : ttsErr);
        }
      }
    }

    // ── 从文本中提取媒体 URL 并以原生格式发送 ──
    const extractedMedia = extractMediaUrlsFromText(chunk);
    for (const media of extractedMedia) {
      try {
        // SSRF 防护：先校验 URL 不指向私有网络
        if (media.url.startsWith("http:") || media.url.startsWith("https:")) {
          if (isUrlPrivate(media.url)) {
            getLog(this.ctx.log).warn(`[message-sender] SSRF blocked: private URL from text, skipping media: ${media.url.slice(0, 100)}`);
            continue;
          }
        }
        const resolvedUrl = await resolveMediaUrl(media.url);
        if (media.type === "image") {
          const imgSeg: OneBotMessage = [{ type: "image", data: { file: resolvedUrl } }];
          await sendByTarget(client, imgSeg, this.ctx);
        } else if (media.type === "video") {
          const vidSeg: OneBotMessage = [{ type: "video", data: { file: resolvedUrl } }];
          await sendByTarget(client, vidSeg, this.ctx);
        } else {
          const fileName = media.name || "file";
          await this.uploadWithFallback(resolvedUrl, fileName, isGroup, isGuild, groupId, userId, guildId, channelId);
        }
        if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
      } catch (mediaErr) {
        getLog(this.ctx.log).warn(`[message-sender] Failed to send extracted media ${media.url}:`, mediaErr);
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
    // SSRF 防护：拒绝指向私有网络的 URL
    if (rawUrl.startsWith("http:") || rawUrl.startsWith("https:")) {
      if (isUrlPrivate(rawUrl)) {
        getLog(this.ctx.log).warn(`[message-sender] SSRF blocked: private URL in sendMediaUrl, dropping: ${rawUrl.slice(0, 100)}`);
        return;
      }
    }
    const url = await resolveMediaUrl(rawUrl);
    const name = fileName || decodeURIComponent(url.split("?")[0].split("/").pop() || "file");

    if (isImageFile(rawUrl) || isImageFile(url)) {
      const imgSeg: OneBotMessage = [{ type: "image", data: { file: url } }];
      await sendByTarget(client, imgSeg, this.ctx);
    } else if (isVideoFile(rawUrl) || isVideoFile(url)) {
      const vidSeg: OneBotMessage = [{ type: "video", data: { file: url } }];
      await sendByTarget(client, vidSeg, this.ctx);
    } else {
      await this.uploadWithFallback(url, name || "file", isGroup, isGuild, groupId, userId, guildId, channelId);
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
      getLog(this.ctx.log).log(`[message-sender] Upload cache hit for ${rawUrl}`);
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
        const uploaded = await this.uploadWithFallback(url, fileName, isGroup, isGuild, groupId, userId, guildId, channelId);
        if (uploaded) {
          uploadCache.set(cacheKey, url);
        }
      }
    }
    if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
  }
}
