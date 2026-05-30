/**
 * 富媒体标签解析与发送队列
 *
 * 提供媒体标签（qqimg）的检测、拆分、路径编码修复，
 * 以及统一的发送队列执行器。移植自 openclaw-qqbot。
 */

import { normalizeMediaTags } from "./media-tags.js";

// ============ 类型定义 ============

/** 发送队列项 */
export interface SendQueueItem {
  type: "text" | "image";
  content: string;
}

// ============ 正则 ============

/** 标准化后的媒体标签正则 */
export const MEDIA_TAG_REGEX =
  /<qqimg>([^<>]+)<\/qqimg>/gi;

/** 创建新实例（每次调用重置 lastIndex） */
function createMediaTagRegex(): RegExp {
  return new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
}

// ============ 路径编码修复 ============

/**
 * 修复 LLM 输出路径时常见的编码问题：
 * - Markdown 转义导致双反斜杠
 * - 八进制转义序列
 * - UTF-8 双重编码（中文路径乱码）
 */
export function fixPathEncoding(mediaPath: string): string {
  // 双反斜杠 → 单反斜杠
  let result = mediaPath.replace(/\\\\/g, "\\");

  // Windows 本地路径跳过八进制解码（\1 \2 等是目录分隔符，不是转义）
  const isWinLocal = /^[a-zA-Z]:[\\/]/.test(mediaPath) || mediaPath.startsWith("\\\\");

  try {
    const hasOctal = /\\[0-7]{1,3}/.test(result);
    const hasNonASCII = /[-ÿ]/.test(result);

    if (!isWinLocal && (hasOctal || hasNonASCII)) {
      // 八进制转义 → 字节
      let decoded = result.replace(
        /\\([0-7]{1,3})/g,
        (_: string, octal: string) => String.fromCharCode(parseInt(octal, 8)),
      );

      // 提取字节
      const bytes: number[] = [];
      for (let i = 0; i < decoded.length; i++) {
        const code = decoded.charCodeAt(i);
        if (code <= 0xff) {
          bytes.push(code);
        } else {
          const charBytes = Buffer.from(decoded[i]!, "utf8");
          bytes.push(...charBytes);
        }
      }

      // UTF-8 解码
      const buffer = Buffer.from(bytes);
      const utf8Decoded = buffer.toString("utf8");

      if (!utf8Decoded.includes("�") || utf8Decoded.length < decoded.length) {
        result = utf8Decoded;
      }
    }
  } catch {
    // 解码失败保留原值
  }

  return result;
}

// ============ 代码块检测 ============

/**
 * 判断文本中给定位置是否处于围栏代码块内（``` 块）
 */
export function isInsideCodeBlock(text: string, position: number): boolean {
  const fenceRegex = /^(`{3,})[^\n]*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let openFence: { pos: number; ticks: number } | null = null;

  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const ticks = fenceMatch[1]!.length;
    if (!openFence) {
      openFence = { pos: fenceMatch.index, ticks };
    } else if (ticks >= openFence.ticks) {
      if (position >= openFence.pos && position < fenceMatch.index + fenceMatch[0].length) return true;
      openFence = null;
    }
  }
  if (openFence && position >= openFence.pos) return true;

  return false;
}

// ============ 媒体标签解析 ============

/**
 * 从文本中解析出完整的发送队列（含标签前后的纯文本）
 *
 * @returns `{ hasMediaTags, sendQueue }` — sendQueue 为空数组表示无媒体标签
 */
export function parseMediaTagsToSendQueue(
  text: string,
): { hasMediaTags: boolean; sendQueue: SendQueueItem[] } {
  const normalized = normalizeMediaTags(text);
  const regex = createMediaTagRegex();
  // 过滤代码块内的匹配
  const matches = [...normalized.matchAll(regex)].filter(m => !isInsideCodeBlock(normalized, m.index!));

  if (matches.length === 0) {
    return { hasMediaTags: false, sendQueue: [] };
  }

  const sendQueue: SendQueueItem[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    // 标签前的文本
    const textBetween = normalized.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
    if (textBetween) {
      sendQueue.push({ type: "text", content: textBetween });
    }

    // 解析标签内容
    let mediaPath = match[1]?.trim() ?? "";
    if (mediaPath.startsWith("MEDIA:")) {
      mediaPath = mediaPath.slice("MEDIA:".length);
    }
    mediaPath = fixPathEncoding(mediaPath);

    if (mediaPath) {
      sendQueue.push({ type: "image", content: mediaPath });
    }

    lastIndex = match.index! + match[0].length;
  }

  // 最后一个标签后的文本
  const tail = normalized.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
  if (tail) {
    sendQueue.push({ type: "text", content: tail });
  }

  return { hasMediaTags: true, sendQueue };
}

/**
 * 从文本中剥离所有媒体标签（用于最终显示）
 */
export function stripMediaTags(text: string): string {
  const regex = createMediaTagRegex();
  return normalizeMediaTags(text).replace(regex, "").replace(/\n{3,}/g, "\n\n").trim();
}
