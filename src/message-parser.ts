/**
 * 消息解析辅助函数
 *
 * 纯函数，无副作用，可在测试中独立验证。
 */

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import type { OneBotMessage } from "./types.js";
import type { OneBotClient } from "./client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { Logger } from "./types/channel-types.js";

// ============ CQ 码参数转义 ============

/** 转义 CQ 码参数值中的特殊字符，防止注入 */
export function escapeCQParam(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

// ============ 预编译正则（避免每次调用重复编译） ============

const CQ_FACE_REGEX = /\[CQ:face,id=(\d+)\]/g;
const CQ_ANY_REGEX = /\[CQ:[^\]]+\]/g;
const CQ_REPLY_REGEX = /\[CQ:reply,id=(\d+)\]/;
// 注：带 /g 标志的正则有 lastIndex 状态，每次调用须用 new RegExp 复制一份
const IMAGE_URL_PATTERN = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
/** 预编译的 image URL regex 实例缓存（避免每次调用 new RegExp） */
let cachedImageUrlRegex: RegExp | null = null;

function getImageUrlRegex(): RegExp {
  if (!cachedImageUrlRegex) {
    cachedImageUrlRegex = new RegExp(IMAGE_URL_PATTERN.source, "g");
  }
  return cachedImageUrlRegex;
}

// 文件 base64 转换的最大允许大小（10 MB），防止大文件撑爆内存
const MAX_LOCAL_FILE_SIZE = 10 * 1024 * 1024;

// ============ 图片 URL 提取 ============

export function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3, log?: Logger): string[] {
  const urls: string[] = [];

  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment.type === "image") {
        // 优先取 url 字段；为空时回退到 file 字段（NapCat 常把本地路径放 file 里）
        const raw =
          segment.data?.url ||
          (typeof segment.data?.file === "string" ? segment.data.file : undefined);
        (log ?? console).log(`[napcat-QQ][extractImageUrls] segment.data=`, JSON.stringify(segment.data), `raw=`, raw);
        if (!raw) continue;
        // 接受 http(s)、base64、file: 协议，以及裸路径（由下游 resolveMediaUrl 处理）
        const url =
          raw.startsWith("http") ||
          raw.startsWith("base64://") ||
          raw.startsWith("file:") ||
          raw.startsWith("/") ||
          /^[a-zA-Z]:[/\\]/.test(raw)
            ? raw
            : undefined;
        if (url) {
          urls.push(url);
          if (urls.length >= maxImages) break;
        }
      }
    }
  } else if (typeof message === "string") {
    const re = getImageUrlRegex();
    let match;
    while ((match = re.exec(message)) !== null) {
      const val = match[1].replace(/&amp;/g, "&");
      if (
        val.startsWith("http") ||
        val.startsWith("base64://") ||
        val.startsWith("file:") ||
        val.startsWith("/") ||
        /^[a-zA-Z]:[/\\]/.test(val)
      ) {
        urls.push(val);
        if (urls.length >= maxImages) break;
      }
    }
  }

  return urls;
}

// ============ CQ 码清理 ============

export function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";

  let result = text;
  const imageUrls: string[] = [];

  const re = getImageUrlRegex();
  let match;
  while ((match = re.exec(text)) !== null) {
    const val = match[1].replace(/&amp;/g, "&");
    if (val.startsWith("http")) imageUrls.push(val);
  }

  result = result.replace(CQ_FACE_REGEX, "[表情]");
  // 每次调用须重置 lastIndex
  CQ_ANY_REGEX.lastIndex = 0;
  result = result.replace(CQ_ANY_REGEX, (m) => {
    if (m.startsWith("[CQ:image")) return "[图片]";
    return "";
  });
  result = result.replace(/\s+/g, " ").trim();

  if (imageUrls.length > 0) {
    result = result
      ? `${result} [图片: ${imageUrls.join(", ")}]`
      : `[图片: ${imageUrls.join(", ")}]`;
  }

  return result;
}

// ============ 回复消息 ID 提取 ============

export function getReplyMessageId(
  message: OneBotMessage | string | undefined,
  rawMessage?: string,
): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) return id;
      }
    }
  }
  if (rawMessage) {
    const m = rawMessage.match(CQ_REPLY_REGEX);
    if (m) return m[1];
  }
  return null;
}

// ============ 目标解析 ============

export function normalizeTarget(raw: string): string {
  // 去掉 OpenClaw 可能附加的前缀（插件历史上曾叫 qq，现叫 napcat）
  let result = raw.replace(/^(qq:|napcat:)/i, "");
  // 框架内部用 user:/channel: 表示私聊/群聊，转换为 napcat 接受的 private:/group:
  if (/^user:/i.test(result)) result = "private:" + result.slice(5);
  else if (/^channel:/i.test(result)) result = "group:" + result.slice(8);
  return result;
}

export type TargetType = "private" | "group" | "guild";

export interface ParsedTarget {
  type: TargetType;
  userId?: number;
  groupId?: number;
  guildId?: string;
  channelId?: string;
}

/**
 * 将 `to` 字段解析为结构化目标。
 *
 * 支持格式：
 *   - Private:  "12345678"  or  "private:12345678"
 *   - Group:    "group:88888888"
 *   - Guild:    "guild:GUILD_ID:CHANNEL_ID"
 */
export function parseTarget(to: string): ParsedTarget {
  // 兼容框架返回的 napcat:group: / napcat:private: 格式，统一剥离前缀
  if (to.startsWith("napcat:")) {
    to = to.slice(7);
  }
  if (to.startsWith("group:")) {
    const id = parseInt(to.slice(6), 10);
    if (isNaN(id)) throw new Error(`Invalid group target: "${to}" — expected "group:<number>"`);
    return { type: "group", groupId: id };
  }
  // ⚠️ P0：channel: 前缀在 cron 投递场景中等同于 group
  // 框架 resolveOutboundSessionRoute 返回 to="channel:{peerId}" 用于群聊
  if (to.startsWith("channel:")) {
    const id = parseInt(to.slice(8), 10);
    if (isNaN(id)) throw new Error(`Invalid channel target: "${to}" — expected "channel:<number>"`);
    return { type: "group", groupId: id };
  }
  if (to.startsWith("guild:")) {
    const parts = to.split(":");
    if (parts.length < 3 || !parts[1] || !parts[2]) {
      throw new Error(
        `Invalid guild target: "${to}" — expected "guild:<guildId>:<channelId>"`,
      );
    }
    return { type: "guild", guildId: parts[1], channelId: parts[2] };
  }
  if (to.startsWith("private:")) {
    const id = parseInt(to.slice(8), 10);
    if (isNaN(id)) throw new Error(`Invalid private target: "${to}" — expected "private:<number>"`);
    return { type: "private", userId: id };
  }
  const id = parseInt(to, 10);
  if (isNaN(id)) {
    throw new Error(
      `Cannot determine target type from "${to}". Use "private:<QQ号>", "group:<群号>", or "guild:<频道ID>:<子频道ID>".`,
    );
  }
  // ⚠️ P0：裸数字默认为群聊，与 resolveOutboundSessionRoute 语义一致
  // 如需发私聊，请使用 private: 前缀
  // 修改此处会导致 cron 投递和 sessions_send 的裸数字目标解析错误
  return { type: "group", groupId: id };
}

/** 根据解析后的目标分发消息到正确的 API */
export async function dispatchMessage(
  client: OneBotClient,
  target: ParsedTarget,
  message: OneBotMessage | string,
): Promise<void> {
  switch (target.type) {
    case "group":
      await client.sendGroupMsg(target.groupId!, message);
      break;
    case "guild":
      await client.sendGuildChannelMsg(target.guildId!, target.channelId!, message);
      break;
    case "private":
      await client.sendPrivateMsg(target.userId!, message);
      break;
  }
}

// ============ 消息分割 ============

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // 在 limit 范围内找最后一个空白/换行作为分割点，避免切断 token / URL / JWT
    let splitAt = remaining.lastIndexOf(" ", limit);
    const splitAtNl = remaining.lastIndexOf("\n", limit);
    let splitIsNewline = false;
    if (splitAtNl > splitAt) {
      splitAt = splitAtNl;
      splitIsNewline = true;
    }
    // 没找到空白/换行位，硬切
    if (splitAt === -1) splitAt = limit;
    // 空格分割点太靠前（< limit/2）时硬切；换行总是有效分割点
    if (!splitIsNewline && splitAt <= limit / 2) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ============ Markdown 处理 ============

export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/`(.*?)`/g, "$1")
    .replace(/#+\s+(.*)/g, "$1")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/^\s*>\s+(.*)/gm, "▎$1")
    .replace(/^\|.*\|$/gm, (m) => m.replace(/\|/g, " ").trim())
    .replace(/^[\-\*]\s+/gm, "• ");
}

// ============ 防风险处理 ============

export function processAntiRisk(text: string): string {
  return text.replace(/(https?:\/\/)/gi, "$1 ");
}

// ============ 媒体 URL 解析 ============

/** 允许访问的本地文件目录白名单（防止路径遍历） */
const ALLOWED_LOCAL_DIRS: string[] = (() => {
  const dirs: string[] = [];
  // 1. 项目数据目录
  try {
    const dataDir = path.resolve(os.homedir(), ".openclaw", "napcat-qq");
    dirs.push(dataDir);
  } catch (err) {
    console.warn(`[message-parser] Failed to resolve homedir: ${err instanceof Error ? err.message : err}`);
  }
  // 2. 临时目录
  try {
    dirs.push(path.resolve(os.tmpdir()));
  } catch (err) {
    console.warn(`[message-parser] Failed to resolve tmpdir: ${err instanceof Error ? err.message : err}`);
  }
  // 3. workspace 目录
  const workspace = process.env.HOME || "/home/node";
  try {
    dirs.push(path.resolve(workspace, ".openclaw", "workspace"));
  } catch (err) {
    console.warn(`[message-parser] Failed to resolve workspace: ${err instanceof Error ? err.message : err}`);
  }
  return [...new Set(dirs.map((d) => d + path.sep))];
})();

/** 敏感目录黑名单：即使父目录在白名单内，这些子目录也不允许访问 */
const BLOCKED_SUB_PATTERNS: RegExp[] = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.env[\\/]/i,
  /[\\/]\.env\.[a-z]+[\\/]/i,
  /[\\/]\.config[\\/]/i,
  /[\\/]\.gnupg[\\/]/i,
  /[\\/]\.docker[\\/]/i,
  /[\\/]\.kube[\\/]/i,
  /[\\/]\.aws[\\/]/i,
  /[\\/]\.npmrc$/i,
  /[\\/]\.gitconfig$/i,
  /[\\/]\.netrc$/i,
];

/**
 * 检查路径是否在允许的目录白名单内，且不命中敏感子目录黑名单。
 * 使用 path.resolve 解析后比对，防止 ../ 路径遍历。
 */
function isPathAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath) + path.sep;
  // 白名单检查
  if (!ALLOWED_LOCAL_DIRS.some((dir) => resolved.startsWith(dir))) return false;
  // 敏感目录黑名单检查
  for (const pattern of BLOCKED_SUB_PATTERNS) {
    if (pattern.test(resolved)) {
      console.warn(`[napcat-QQ] Path traversal blocked (sensitive dir): ${filePath}`);
      return false;
    }
  }
  return true;
}

export async function resolveMediaUrl(url: string, log?: Logger): Promise<string> {
  // file: 协议 → 解码为本地路径
  if (url.startsWith("file:")) {
    try {
      const filePath = fileURLToPath(url);
      // 路径遍历防护：仅允许访问白名单目录
      if (!isPathAllowed(filePath)) {
        (log ?? console).warn(`[napcat-QQ] Path traversal blocked: ${url} not in allowed directories`);
        return url;
      }
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_LOCAL_FILE_SIZE) {
        (log ?? console).warn(`[napcat-QQ] File too large to base64 encode (${stat.size} bytes), passing as-is: ${url}`);
        return url;
      }
      const data = await fs.readFile(filePath);
      return `base64://${data.toString("base64")}`;
    } catch (e) {
      (log ?? console).warn(`[napcat-QQ] Failed to convert local file to base64: ${e}`);
      return url;
    }
  }
  // 裸本地路径，NapCat 运行在远端时无法访问，转为 base64
  if (url.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(url)) {
    try {
      // 路径遍历防护
      if (!isPathAllowed(url)) {
        (log ?? console).warn(`[napcat-QQ] Path traversal blocked: ${url} not in allowed directories`);
        return url;
      }
      const stat = await fs.stat(url);
      if (stat.size > MAX_LOCAL_FILE_SIZE) {
        (log ?? console).warn(`[napcat-QQ] File too large to base64 encode (${stat.size} bytes), passing as-is: ${url}`);
        return url;
      }
      const data = await fs.readFile(url);
      return `base64://${data.toString("base64")}`;
    } catch (e) {
      (log ?? console).warn(`[napcat-QQ] Failed to read local file, passing as-is: ${e}`);
      return url;
    }
  }
  return url;
}

// ============ 入站图片下载 ============

/** 常见图片扩展名映射 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** 从 URL 或 Content-Type 猜测图片扩展名 */
function guessImageExtension(url: string, contentType: string | null): string {
  if (contentType) {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  }
  // 从 URL pathname 猜
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase();
    if (ext && ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch (err) {
    console.warn(`[message-parser] Cannot guess extension from URL "${url.slice(0, 100)}": ${err instanceof Error ? err.message : err}`);
  }
  return "jpg"; // 默认
}

/**
 * 下载图片到本地目录，按原始顺序返回结果。
 *
 * 每个条目：成功 = { path: 本地路径, type: MIME 类型 }，失败 = { path: 原始 URL, type: "image/jpeg" }。
 * 返回数组长度与输入 urls 一致，保持顺序，便于直接作为 MediaPaths 使用。
 */
export interface DownloadedImage {
  path: string;
  type: string;
}

export async function downloadImages(urls: string[], log?: Logger): Promise<DownloadedImage[]> {
  (log ?? console).log(`[napcat-QQ][downloadImages] downloading ${urls.length} image(s):`, urls.map(u => u.slice(0, 100)));
  // 下载到 workspace 目录（框架的 workspaceOnly 限制只能读取 workspace 下的文件）
  const homeDir = process.env.HOME || "/home/node";
  const downloadDir = path.join(homeDir, ".openclaw", "workspace");
  if (!fsSync.existsSync(downloadDir)) {
    fsSync.mkdirSync(downloadDir, { recursive: true });
  }
  const results: DownloadedImage[] = [];

  // 并发控制：最多 3 张同时下载，避免并发过大被限流
  const CONCURRENT_DOWNLOADS = 3;
  const downloadOne = async (rawUrl: string, idx: number): Promise<DownloadedImage> => {
    // SSRF 防护：仅允许 http/https scheme，防止 file:///gopher:// 等内网扫描
    let url = rawUrl;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        (log ?? console).warn(`[napcat-QQ][downloadImages] blocked non-http(s) URL: ${parsed.protocol}//${parsed.host}`);
        return { path: url, type: "image/jpeg" };
      }
    } catch {
      (log ?? console).warn(`[napcat-QQ][downloadImages] blocked invalid URL: ${url.slice(0, 100)}`);
      return { path: url, type: "image/jpeg" };
    }

    // 最多跟随 3 次重定向（每跳都验证 scheme，防止 SSRF 绕过）
    for (let redirectCount = 0; redirectCount < 3; redirectCount++) {
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": "Mozilla/5.0" },
          redirect: "manual",
        });
        // 处理 3xx 重定向：验证 redirect URL 的 scheme
        if (resp.status >= 300 && resp.status < 400) {
          const redirectUrl = resp.headers.get("location");
          if (!redirectUrl) {
            (log ?? console).warn(`[napcat-QQ][downloadImages] redirect without Location header: ${url}`);
            return { path: url, type: "image/jpeg" };
          }
          try {
            const parsedRedirect = new URL(redirectUrl, url);
            if (!["http:", "https:"].includes(parsedRedirect.protocol)) {
              (log ?? console).warn(`[napcat-QQ][downloadImages] blocked redirect to non-http(s) URL: ${parsedRedirect.protocol}//${parsedRedirect.host}`);
              return { path: url, type: "image/jpeg" };
            }
            url = parsedRedirect.toString();
            continue; // 用新 URL 重新下载
          } catch {
            (log ?? console).warn(`[napcat-QQ][downloadImages] blocked invalid redirect URL: ${redirectUrl.slice(0, 100)}`);
            return { path: url, type: "image/jpeg" };
          }
        }
        if (!resp.ok) {
          (log ?? console).warn(`[napcat-QQ] Image download failed (${resp.status}): ${url}`);
          return { path: url, type: "image/jpeg" };
        }
        const contentType = resp.headers.get("content-type");
        const ext = guessImageExtension(url, contentType);
        const mime = contentType?.split(";")[0].trim() || `image/${ext}`;
        // 用 idx 保证并发下载时文件名唯一（避免 Date.now() 碰撞）
        const filename = `img-${idx}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const filePath = path.join(downloadDir, filename);
        const buf = Buffer.from(await resp.arrayBuffer());
        fsSync.writeFileSync(filePath, buf);
        (log ?? console).log(`[napcat-QQ][downloadImages] saved: ${filePath} (${buf.length} bytes)`);
        return { path: filePath, type: mime };
      } catch (err) {
        (log ?? console).warn(`[napcat-QQ] Image download error: ${err instanceof Error ? err.message : String(err)}`);
        return { path: url, type: "image/jpeg" };
      }
    }
    return { path: url, type: "image/jpeg" };
  };

  // 分批并发下载（每批 CONCURRENT_DOWNLOADS 张）
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += CONCURRENT_DOWNLOADS) {
    chunks.push(urls.slice(i, i + CONCURRENT_DOWNLOADS));
  }
  for (const chunk of chunks) {
    const chunkResults = await Promise.all(chunk.map((u, i) => downloadOne(u, i)));
    results.push(...chunkResults);
  }

  return results;
}

// ============ 文件类型检测 ============

/** 提取 URL 的路径部分（去除 query string / fragment），用于扩展名判断 */
function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0].split("#")[0];
  }
}

export function isImageFile(url: string): boolean {
  const lower = urlPathname(url).toLowerCase();
  return (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".bmp") ||
    lower.endsWith(".svg")
  );
}

export function isVideoFile(url: string): boolean {
  const lower = urlPathname(url).toLowerCase();
  return (
    lower.endsWith(".mp4") ||
    lower.endsWith(".avi") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".mkv") ||
    lower.endsWith(".webm")
  );
}

// ============ 从纯文本中提取媒体 URL ============

const TEXT_URL_REGEX = /https?:\/\/[^\s\])<>"]+/gi;
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?[^\s]*)?$/i;
const VIDEO_EXTENSIONS = /\.(mp4|avi|mov|mkv|webm)(\?[^\s]*)?$/i;
const FILE_EXTENSIONS = /\.([a-zA-Z0-9]{1,10})(\?[^\s]*)?$/i;

export interface ExtractedMedia {
  url: string;
  type: "image" | "video" | "file";
  name: string;
}

/**
 * 从纯文本中提取媒体 URL，按扩展名分类为 image / video / file。
 *
 * 支持两种格式：
 * 1. Markdown 图片语法：`![alt](url)` — 无条件识别为 image
 * 2. 裸 URL 带文件扩展名：普通网页链接不会被提取
 */
export function extractMediaUrlsFromText(text: string): ExtractedMedia[] {
  const results: ExtractedMedia[] = [];
  const seen = new Set<string>();

  // ── 1. Markdown 图片语法 ──
  const mdImageRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdImageRe.exec(text)) !== null) {
    let url = mdMatch[2].trim();
    url = url.replace(/[.,;!?:)\]}>]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    let pathname: string;
    try { pathname = new URL(url).pathname; } catch { pathname = url.split("?")[0]; }
    const name = decodeURIComponent(pathname.split("/").pop() || "image");
    results.push({ url, type: "image", name });
  }

  // ── 2. 裸 URL（带媒体扩展名） ──
  let match: RegExpExecArray | null;
  const re = new RegExp(TEXT_URL_REGEX.source, "gi");
  while ((match = re.exec(text)) !== null) {
    let url = match[0];
    url = url.replace(/[.,;!?:)\]}>]+$/, "");
    if (seen.has(url)) continue;

    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url.split("?")[0];
    }

    let type: "image" | "video" | "file" | null = null;
    if (IMAGE_EXTENSIONS.test(pathname)) {
      type = "image";
    } else if (VIDEO_EXTENSIONS.test(pathname)) {
      type = "video";
    } else if (FILE_EXTENSIONS.test(pathname) && !/\.(html?|php|asp|aspx|jsp)$/i.test(pathname)) {
      type = "file";
    }

    if (type) {
      seen.add(url);
      const name = decodeURIComponent(pathname.split("/").pop() || "file");
      results.push({ url, type, name });
    }
  }
  return results;
}

// ============ STT 辅助函数 ============

interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function resolveSTTConfig(cfg: Record<string, unknown> | undefined): STTConfig | null {
  const c: Record<string, unknown> = cfg ?? {};
  const channels = c?.channels as Record<string, unknown> | undefined;
  const models = c?.models as Record<string, unknown> | undefined;

  // 优先 channels.napcat.stt（插件专属配置）
  const napcatCh = channels?.napcat as Record<string, unknown> | undefined;
  const channelStt = napcatCh?.stt as Record<string, unknown> | undefined;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = (channelStt?.provider as string | undefined) || "openai";
    const providers = models?.providers as Record<string, unknown> | undefined;
    const providerCfg = providers?.[providerId] as Record<string, unknown> | undefined;
    const baseUrl: string | undefined = (channelStt?.baseUrl as string | undefined) || (providerCfg?.baseUrl as string | undefined);
    const apiKey: string | undefined = (channelStt?.apiKey as string | undefined) || (providerCfg?.apiKey as string | undefined);
    const model: string = (channelStt?.model as string | undefined) || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // 回退 tools.media.audio.models[0]（框架级配置）
  const tools = c?.tools as Record<string, unknown> | undefined;
  const media = tools?.media as Record<string, unknown> | undefined;
  const audioModels = (media?.audio as { models?: unknown[] } | undefined)?.models;
  const audioModelEntry = audioModels?.[0] as Record<string, unknown> | undefined;
  if (audioModelEntry) {
    const providerId: string = (audioModelEntry?.provider as string | undefined) || "openai";
    const providers = models?.providers as Record<string, unknown> | undefined;
    const providerCfg = providers?.[providerId] as Record<string, unknown> | undefined;
    const baseUrl: string | undefined = (audioModelEntry?.baseUrl as string | undefined) || (providerCfg?.baseUrl as string | undefined);
    const apiKey: string | undefined = (audioModelEntry?.apiKey as string | undefined) || (providerCfg?.apiKey as string | undefined);
    const model: string = (audioModelEntry?.model as string | undefined) || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

export async function transcribeAudioForNapcat(
  audioPath: string,
  cfg: Record<string, unknown> | undefined,
): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) return null;

  const fileBuffer = fsSync.readFileSync(audioPath);
  const fileName = path.basename(audioPath);
  const mime = fileName.endsWith(".wav")
    ? "audio/wav"
    : fileName.endsWith(".mp3")
      ? "audio/mpeg"
      : fileName.endsWith(".ogg")
        ? "audio/ogg"
        : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = (await resp.json()) as { text?: string };
  return result.text?.trim() || null;
}
