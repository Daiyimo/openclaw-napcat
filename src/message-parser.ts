/**
 * 消息解析辅助函数
 *
 * 纯函数，无副作用，可在测试中独立验证。
 */

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import type { OneBotMessage } from "./types.js";
import type { OneBotClient } from "./client.js";
import type { Logger } from "./types/channel-types.js";
import { MAX_REDIRECT_COUNT, CONCURRENT_DOWNLOADS } from "./constants.js";
import { maskUrl } from "./utils/log-sanitize.js";
import { getLog } from "./admin-commands/shared.js";

// 模块级日志引用（默认 console，可由调用方通过 setModuleLogger 替换）
let _log: Logger = console;

/** 设置模块级日志（供外部注入框架 logger） */
export function setModuleLogger(log: Logger): void {
  _log = log;
}

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
const IMAGE_URL_PATTERN = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;

function getImageUrlRegex(): RegExp {
  // 每次返回新实例避免 /g lastIndex 泄漏（调用方用 while (re.exec())）
  return new RegExp(IMAGE_URL_PATTERN.source, "g");
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
        getLog(log).debug(`[napcat-QQ][extractImageUrls] segment.data=`, JSON.stringify(segment.data), `raw=`, maskUrl(raw ?? ""));
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

/** 根据解析后的目标分发消息到正确的 API，返回 message_id */
export async function dispatchMessage(
  client: OneBotClient,
  target: ParsedTarget,
  message: OneBotMessage | string,
): Promise<string | undefined> {
  let result: { message_id: string } | void;
  switch (target.type) {
    case "group":
      result = await client.sendGroupMsg(target.groupId!, message);
      break;
    case "guild":
      result = await client.sendGuildChannelMsg(target.guildId!, target.channelId!, message);
      break;
    case "private":
      result = await client.sendPrivateMsg(target.userId!, message);
      break;
  }
  return result?.message_id;
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
    _log.warn(`[message-parser] Failed to resolve homedir: ${err instanceof Error ? err.message : err}`);
  }
  // 2. 临时目录
  try {
    dirs.push(path.resolve(os.tmpdir()));
  } catch (err) {
    _log.warn(`[message-parser] Failed to resolve tmpdir: ${err instanceof Error ? err.message : err}`);
  }
  // 3. workspace 目录
  const workspace = os.homedir();
  try {
    dirs.push(path.resolve(workspace, ".openclaw", "workspace"));
  } catch (err) {
    _log.warn(`[message-parser] Failed to resolve workspace: ${err instanceof Error ? err.message : err}`);
  }
  return [...new Set(dirs.map((d) => d + path.sep))];
})();

/** 敏感目录黑名单：即使父目录在白名单内，这些子目录也不允许访问 */
const BLOCKED_SUB_PATTERNS: RegExp[] = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.env(?:[\\/]|$)/i,
  /[\\/]\.env\.[a-z]+(?:[\\/]|$)/i,
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
 * 使用 path.resolve + fs.realpath 解析后比对，防止 ../ 路径遍历和 symlink 绕过。
 */
async function isPathAllowed(filePath: string, log?: Logger): Promise<boolean> {
  // 先 path.resolve 处理 ../，再 realpath 跟进 symlink 真实路径
  let realPath: string;
  try {
    realPath = await fs.realpath(filePath);
  } catch {
    // 文件不存在或无权访问，视为不在白名单内
    return false;
  }
  const resolved = realPath + path.sep;
  // 白名单检查
  if (!ALLOWED_LOCAL_DIRS.some((dir) => resolved.startsWith(dir))) return false;
  // 敏感目录黑名单检查
  for (const pattern of BLOCKED_SUB_PATTERNS) {
    if (pattern.test(resolved)) {
      getLog(log).warn(`[napcat-QQ] Path traversal blocked (sensitive dir): ${filePath}`);
      return false;
    }
  }
  return true;
}

export async function resolveMediaUrl(
  url: string,
  log?: Logger,
  guard: MediaUrlGuardMode = DEFAULT_MEDIA_URL_GUARD,
): Promise<string> {
  // file: 协议 → 解码为本地路径
  if (url.startsWith("file:")) {
    try {
      const filePath = fileURLToPath(url);
      // 路径遍历防护：仅允许访问白名单目录
      if (!(await isPathAllowed(filePath, log))) {
        getLog(log).warn(`[napcat-QQ] Path traversal blocked: ${url} not in allowed directories`);
        return url;
      }
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_LOCAL_FILE_SIZE) {
        getLog(log).warn(`[napcat-QQ] File too large to base64 encode (${stat.size} bytes), passing as-is: ${url}`);
        return url;
      }
      const data = await fs.readFile(filePath);
      return `base64://${data.toString("base64")}`;
    } catch (e) {
      getLog(log).warn(`[napcat-QQ] Failed to convert local file to base64: ${e}`);
      return url;
    }
  }
  // 裸本地路径，NapCat 运行在远端时无法访问，转为 base64
  if (url.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(url)) {
    try {
      // 路径遍历防护
      if (!(await isPathAllowed(url, log))) {
        getLog(log).warn(`[napcat-QQ] Path traversal blocked: ${url} not in allowed directories`);
        return url;
      }
      const stat = await fs.stat(url);
      if (stat.size > MAX_LOCAL_FILE_SIZE) {
        getLog(log).warn(`[napcat-QQ] File too large to base64 encode (${stat.size} bytes), passing as-is: ${url}`);
        return url;
      }
      const data = await fs.readFile(url);
      return `base64://${data.toString("base64")}`;
    } catch (e) {
      getLog(log).warn(`[napcat-QQ] Failed to read local file, passing as-is: ${e}`);
      return url;
    }
  }
  // 出站媒体 URL 安全判定
  //
  // ⚠️ 关键语义：本函数**不 fetch** 该 URL —— 返回值会被塞进 OneBot 消息的 file
  // 字段，由 NapCat 去下载。所以 `return url` 等于放行，真阻断必须 throw。
  // 原实现三条路径全部 `return url` 却打日志说 "SSRF blocked"，属假阻断 + 谎报。
  //
  // 同理，此处**不做重定向链预检**：插件的 HEAD 探测无法约束 NapCat 是否跟随
  // 重定向，是纯开销的无效防护（原实现最坏阻塞 5 跳 × 10s = 50s 却不改变结果）。
  // 入站 downloadImages 由插件自己 fetch，那里的逐跳校验才真正生效。
  if (guard !== "off" && /^https?:\/\//i.test(url)) {
    if (isCloudMetadataUrl(url)) {
      getLog(log).error(
        `[napcat-QQ] 拒绝发送：媒体 URL 指向云元数据端点: ${url.slice(0, 100)}`,
      );
      throw new MediaUrlBlockedError(url, "云元数据端点");
    }
    if (isUrlPrivate(url)) {
      if (guard === "strict") {
        getLog(log).error(
          `[napcat-QQ] 拒绝发送：媒体 URL 指向内网地址（mediaUrlGuard=strict）: ${url.slice(0, 100)}`,
        );
        throw new MediaUrlBlockedError(url, "内网地址");
      }
      // metadata-only（默认）：内网放行。NapCat 常与媒体源同处内网，
      // 阻断会掐断正常发图；此处只告警，不谎称已拦截。
      getLog(log).warn(
        `[napcat-QQ] 媒体 URL 指向内网地址，按 mediaUrlGuard=metadata-only 放行: ${url.slice(0, 100)}`,
      );
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
function guessImageExtension(url: string, contentType: string | null, log?: Logger): string {
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
    getLog(log).warn(`[message-parser] Cannot guess extension from URL "${url.slice(0, 100)}": ${err instanceof Error ? err.message : err}`);
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

// ============ SSRF 防护 ============

/** RFC 1918 + 链路本地 + 回环 + 云元数据 + IPv6 ULA */
const BLOCKED_IP_RANGES: [number, number][] = [
  // 回环: 127.0.0.0/8
  [0x7F000000, 0x7FFFFFFF],
  // 链路本地: 169.254.0.0/16, fe80::/10
  [0xA9FE0000, 0xA9FEFFFF],
  // 私有: 10.0.0.0/8
  [0x0A000000, 0x0AFFFFFF],
  // 私有: 172.16.0.0/12
  [0xAC100000, 0xAC1FFFFF],
  // 私有: 192.168.0.0/16
  [0xC0A80000, 0xC0A8FFFF],
  // AWS 元数据: 169.254.169.254/32（显式确保阻断）
  [0xA9FEA9FE, 0xA9FEA9FE],
  // CGNAT / Carrier-Grade NAT: 100.64.0.0/10
  [0x64400000, 0x647FFFFF],
  // IETF 协议分析: 192.0.0.0/24
  [0xC0000000, 0xC00000FF],
  // 测试-net: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
  [0xC0000200, 0xC00002FF],
  [0xC6336400, 0xC63364FF],
  [0xCB007100, 0xCB0071FF],
];

/** 已知云元数据和内部服务主机名（DNS 重绑定保护） */
const BLOCKED_HOSTNAME_SUBSTRINGS: string[] = [
  "metadata.google.internal",
  "metadata.internal",
  "metadata.aliyun.com",
  "169.254.169.254",
  "100.100.100.200",
  "openstack",
];

/**
 * 云元数据端点 IP。
 *
 * 与 RFC1918 私网区别对待的原因：私网地址在本项目的典型部署下是**合法媒体源**
 * （NapCat 常与 OpenClaw 同处内网，见 docker-compose.yml 的 QQ_HTTP_URL 默认值
 * http://192.168.1.100:3000），而云元数据端点对"发一张图"这件事零合法用途，
 * 一旦被读取即等同泄露云账号 IAM 凭证。因此它在任何非 off 档位下都必须拒绝。
 */
const CLOUD_METADATA_IPS: readonly string[] = [
  "169.254.169.254", // AWS / Azure / GCP 链路本地元数据
  "100.100.100.200", // 阿里云元数据
];

/** 出站媒体 URL 的防护档位 */
export type MediaUrlGuardMode = "off" | "metadata-only" | "strict";

/** 默认档位：只强制阻断云元数据，内网放行（避免掐断内网媒体源） */
export const DEFAULT_MEDIA_URL_GUARD: MediaUrlGuardMode = "metadata-only";

/** 媒体 URL 被安全策略拒绝时抛出，调用方应放弃该媒体的发送 */
export class MediaUrlBlockedError extends Error {
  public readonly url: string;
  public readonly reason: string;

  constructor(url: string, reason: string) {
    super(`媒体 URL 被安全策略阻断（${reason}）: ${url.slice(0, 100)}`);
    this.name = "MediaUrlBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

/**
 * 判断 URL 是否指向云元数据端点。
 *
 * 只做字面量与主机名后缀比对，不做 DNS 解析（避免 DNS rebinding 把判定
 * 变成一次可被操纵的网络请求）。
 *
 * @param urlStr 待判定的 URL。
 * @returns 命中云元数据端点返回 true；URL 非法或为普通地址返回 false
 *          （非法 URL 的拦截由调用侧的 scheme 校验与 isUrlPrivate 负责）。
 */
export function isCloudMetadataUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const hostLower = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (CLOUD_METADATA_IPS.includes(hostLower)) return true;
    for (const blocked of BLOCKED_HOSTNAME_SUBSTRINGS) {
      if (hostLower === blocked || hostLower.endsWith("." + blocked)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 检查 IP 字符串是否在私有/回环/链路本地/ULA 范围内。
 * SSRF 防护：防止下载被重定向到内网或云元数据端点。
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const num = ip.split(".").reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
    for (const [lo, hi] of BLOCKED_IP_RANGES) {
      if (num >= lo && num <= hi) return true;
    }
    return false;
  }
  // IPv6 回环 ::1 和链路本地 fe80::/10
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80")) return true;
  // IPv6 回环映射 ::ffff:x.x.x.x → 递归检查映射的 IPv4
  if (ip.startsWith("::ffff:")) return isPrivateIp(ip.slice(7));
  // IPv6 全零 ::（等效于 0.0.0.0）
  if (ip === "::") return true;
  // IPv6 唯一本地地址 fc00::/7（含 fd00::/8 实际部署段）
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  // 默认保守策略：未知 IPv6 地址不阻断
  return false;
}

/** 从 URL 提取主机，返回 isPrivateIp 的结果 */
export function isUrlPrivate(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // 优先检查 host 是否直接是 IP
    if (net.isIPv4(parsed.hostname) || net.isIPv6(parsed.hostname.replace(/^\[|\]$/g, ""))) {
      return isPrivateIp(parsed.hostname.replace(/^\[|\]$/g, ""));
    }
    // 主机名：检查是否命中已知云元数据/内部服务
    const hostLower = parsed.hostname.toLowerCase();
    for (const blocked of BLOCKED_HOSTNAME_SUBSTRINGS) {
      if (hostLower === blocked || hostLower.endsWith("." + blocked)) {
        return true;
      }
    }
    // 不在此做 DNS 解析（避免 DNS rebinding），
    // 重定向后的 URL 会重新经过此检查，fetch 返回的响应 IP 由运行时控制
    // 关键：后续需配合服务器级防火墙（如 NapCat 容器网络策略）
    return false;
  } catch {
    // URL 解析失败视为潜在风险，阻断
    return true;
  }
}

/**
 * 单张图片的下载体积上限（字节）。
 *
 * 入站图片 URL 来自 QQ 消息，属未认证外部输入；原实现直接
 * `Buffer.from(await resp.arrayBuffer())` 无任何上限，一条构造的大文件
 * URL 即可把进程 OOM 打死。QQ 图片实际远小于此值，取 20MB 留足余量。
 */
const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024;

/**
 * 读取响应体，累计字节数超过 limit 时立即放弃。
 *
 * 不直接用 `resp.arrayBuffer()`：那会在能判断大小之前就把整个响应读进内存，
 * 对未认证的外部 URL 等于没有上限。此处边读边累计，超限即断流。
 *
 * @param resp  已确认 ok 的响应。
 * @param limit 允许的最大字节数。
 * @returns 完整响应体；超过 limit 时返回 null。
 */
async function readBodyWithLimit(resp: Response, limit: number): Promise<Buffer | null> {
  if (!resp.body) {
    // 少数运行时/mock 不提供 body 流，退回一次性读取后再判断
    const whole = Buffer.from(await resp.arrayBuffer());
    return whole.byteLength > limit ? null : whole;
  }
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {
        /* 流已中断，取消失败不影响主流程 */
      });
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function downloadImages(urls: string[], log?: Logger): Promise<DownloadedImage[]> {
  getLog(log ?? _log).log(`[napcat-QQ][downloadImages] downloading ${urls.length} image(s):`, urls.map(u => u.slice(0, 100)));
  // 下载到 workspace 目录（框架的 workspaceOnly 限制只能读取 workspace 下的文件）
  const homeDir = os.homedir();
  const downloadDir = path.join(homeDir, ".openclaw", "workspace");
  if (!fsSync.existsSync(downloadDir)) {
    fsSync.mkdirSync(downloadDir, { recursive: true });
  }
  const results: DownloadedImage[] = [];

  // 并发控制：最多同时下载数，避免并发过大被限流
  const downloadOne = async (rawUrl: string, idx: number): Promise<DownloadedImage> => {
    // SSRF 防护：仅允许 http/https scheme
    let url = rawUrl;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        getLog(log ?? _log).warn(`[napcat-QQ][downloadImages] blocked non-http(s) URL: ${parsed.protocol}//${parsed.host}`);
        return { path: url, type: "image/jpeg" };
      }
    } catch {
      getLog(log ?? _log).warn(`[napcat-QQ][downloadImages] blocked invalid URL: ${url.slice(0, 100)}`);
      return { path: url, type: "image/jpeg" };
    }

    // SSRF 防护：检查目标主机是否为私有/回环 IP
    if (isUrlPrivate(url)) {
      getLog(log ?? _log).warn(`[napcat-QQ][downloadImages] blocked private IP URL: ${url}`);
      return { path: url, type: "image/jpeg" };
    }

    // 最多跟随 3 次重定向（每跳都验证 scheme 和 IP）
    for (let redirectCount = 0; redirectCount < MAX_REDIRECT_COUNT; redirectCount++) {
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": "Mozilla/5.0" },
          redirect: "manual",
        });
        // 处理 3xx 重定向：验证 redirect URL 的 scheme 和 IP
        if (resp.status >= 300 && resp.status < 400) {
          const redirectUrl = resp.headers.get("location");
          if (!redirectUrl) {
            getLog(log ?? _log).warn(`[napcat-QQ][downloadImages] redirect without Location header: ${url}`);
            return { path: url, type: "image/jpeg" };
          }
          try {
            const parsedRedirect = new URL(redirectUrl, url);
            if (!["http:", "https:"].includes(parsedRedirect.protocol)) {
              getLog(log ?? _log).warn(`[napcat-QQ][downloadImages] blocked redirect to non-http(s) URL: ${parsedRedirect.protocol}//${parsedRedirect.host}`);
              return { path: url, type: "image/jpeg" };
            }
            const nextUrl = parsedRedirect.toString();
            // 每跳都检查私有 IP
            if (isUrlPrivate(nextUrl)) {
              getLog(log ?? _log).warn(`[napcat-QQ][downloadImages] blocked redirect to private IP: ${nextUrl}`);
              return { path: url, type: "image/jpeg" };
            }
            url = nextUrl;
            continue; // 用新 URL 重新下载
          } catch {
            getLog(log ?? _log).warn(`[napcat-QQ][downloadImages] blocked invalid redirect URL: ${redirectUrl.slice(0, 100)}`);
            return { path: url, type: "image/jpeg" };
          }
        }
        if (!resp.ok) {
          getLog(log ?? _log).warn(`[napcat-QQ] Image download failed (${resp.status}): ${url}`);
          return { path: url, type: "image/jpeg" };
        }
        const contentType = resp.headers.get("content-type");
        // 体积上限：先用 Content-Length 提前拒绝，省掉整次下载
        const declaredSize = Number(resp.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_SIZE) {
          getLog(log ?? _log).warn(
            `[napcat-QQ][downloadImages] 跳过超限图片（Content-Length ${declaredSize} 字节 > 上限 ${MAX_DOWNLOAD_SIZE}）: ${url.slice(0, 100)}`,
          );
          return { path: url, type: "image/jpeg" };
        }
        const ext = guessImageExtension(url, contentType, log);
        const mime = contentType?.split(";")[0].trim() || `image/${ext}`;
        // 用 idx 保证并发下载时文件名唯一（避免 Date.now() 碰撞）
        const filename = `img-${idx}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const filePath = path.join(downloadDir, filename);
        // Content-Length 可以缺失或造假，边读边累计才是真正的上限
        const buf = await readBodyWithLimit(resp, MAX_DOWNLOAD_SIZE);
        if (!buf) {
          getLog(log ?? _log).warn(
            `[napcat-QQ][downloadImages] 跳过超限图片（响应体超过上限 ${MAX_DOWNLOAD_SIZE} 字节）: ${url.slice(0, 100)}`,
          );
          return { path: url, type: "image/jpeg" };
        }
        fsSync.writeFileSync(filePath, buf);
        getLog(log ?? _log).log(`[napcat-QQ][downloadImages] saved: ${filePath} (${buf.length} bytes)`);
        return { path: filePath, type: mime };
      } catch (err) {
        getLog(log ?? _log).warn(`[napcat-QQ] Image download error: ${err instanceof Error ? err.message : String(err)}`);
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
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = (await resp.json()) as { text?: string };
  return result.text?.trim() || null;
}
