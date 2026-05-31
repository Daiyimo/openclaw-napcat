/**
 * 日志脱敏工具
 *
 * 防止在日志中输出完整的 QQ 号、路径、URL 等敏感信息。
 */

/**
 * 将 QQ 号脱敏为 123*** 格式
 * @param id QQ 号或用户 ID
 * @param visiblePrefix 保留前几位数字（默认 3 位）
 */
export function maskId(id: string | number | undefined | null, visiblePrefix = 3): string {
  if (id == null) return "null";
  const s = String(id);
  if (s.length <= visiblePrefix) return s;
  return s.slice(0, visiblePrefix) + "***";
}

/**
 * 将 URL 脱敏，隐藏查询参数和路径中的敏感部分
 */
export function maskUrl(url: string, maxPathLength = 40): string {
  try {
    const u = new URL(url);
    // 保留协议 + host，隐藏 pathname（截断）+ 全部 query
    const path = u.pathname.length > maxPathLength
      ? u.pathname.slice(0, maxPathLength) + "..."
      : u.pathname;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    // 非标准 URL，截断返回
    return url.length > maxPathLength ? url.slice(0, maxPathLength) + "..." : url;
  }
}

/**
 * 从文本中脱敏所有 QQ 号（5-12 位数字）
 */
export function maskIdsInText(text: string): string {
  return text.replace(/\b\d{5,12}\b/g, (match) => maskId(match));
}
