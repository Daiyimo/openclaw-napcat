/**
 * 消息处理器 — Barrel 入口
 *
 * 职责分层：
 *   - 纯触发检测 → message-trigger.ts
 *   - 消息体构建  → message-body-builder.ts
 *   - 异步文本提取（含 STT、转发消息、文件 URL 拉取）→ 本文件（依赖 Node.js fs/os/path）
 *
 * 所有导出均从下方子模块 re-export，调用方无需修改 import 路径。
 */

// ── 子模块 re-export ─────────────────────────────────────

export {
  detectMention,
  hasMentionOtherUser,
  detectKeywordTrigger,
  detectNameTrigger,
  isMessageDirectedAtBot,
  buildOtherBotNames,
} from "./message-trigger.js";

export {
  buildFromId,
  buildBodyWithReply,
} from "./message-body-builder.js";
export type { BuildBodyOpts } from "./message-body-builder.js";

// ── 异步文本提取（保留在本文件，依赖 Node.js fs/os/path）────

import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OneBotEvent } from "./types.js";
import type { OneBotClient } from "./client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QQConfig } from "./config.js";
import { getCachedMemberName } from "./member-cache.js";
import { cleanCQCodes } from "./message-parser.js";
import { convertSilkToWav } from "./utils/audio-convert.js";
import { transcribeAudioForNapcat } from "./message-parser.js";
import type { Logger } from "./types/channel-types.js";

/** 允许的 URL scheme：仅 http/https，防止 SSRF */
const ALLOWED_URL_SCHEMES = ["http:", "https:"];

/**
 * 校验 URL 是否在允许的 scheme 白名单内，防止 SSRF 攻击。
 */
function validateFetchUrl(url: string, log?: Logger): boolean {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
      (log ?? console).warn(`[message-processor] SSRF blocked: disallowed scheme "${parsed.protocol}" in URL: ${url.slice(0, 100)}`);
      return false;
    }
    return true;
  } catch {
    (log ?? console).warn(`[message-processor] SSRF blocked: invalid URL: ${url.slice(0, 100)}`);
    return false;
  }
}

/**
 * 将 OneBot 消息段数组解析为可读文本字符串。
 * 异步：处理语音 STT 和转发消息需调用 client API。
 *
 * @param event       OneBot 事件
 * @param client      OneBotClient 实例（用于获取转发消息、文件 URL）
 * @param config      QQ 配置子集（enableSTT、aiVoiceId）
 * @param openClawCfg 完整 OpenClaw 配置（供 STT 转写使用），可选
 * @param log         可选日志器
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
          if (!validateFetchUrl(voiceUrl, log)) {
            resolvedText += ` [语音消息: URL 不允许]`;
            continue;
          }
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
