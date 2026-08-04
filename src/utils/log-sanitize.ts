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

/**
 * 脱敏 Bearer Token。
 * 将 "Bearer <token>" 替换为 "Bearer [REDACTED]"。
 * 同时处理 JSON 中的 "Authorization": "Bearer <token>" 格式。
 */
export function maskBearerToken(text: string): string {
  return text
    .replace(/"Authorization"\s*:\s*"Bearer\s+[^"]*"/gi, '"Authorization": "Bearer [REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
}

/**
 * 脱敏文本中的常见凭据。
 *
 * 存在的原因：`/logs` 命令会把进程日志发到 QQ 会话，而日志缓冲区里混有
 * openclaw 内核与其他插件的输出，仅脱敏 QQ 号（maskIdsInText）不足以
 * 阻止 API key 外泄。这里覆盖 Bearer、常见密钥前缀，以及 key=value 形式。
 *
 * 宁可多掩盖一些排查信息，也不能把凭据发进群。
 *
 * @param text 待脱敏的文本。
 * @returns 凭据被替换为 [REDACTED] 的文本。
 */
export function maskSecretsInText(text: string): string {
  return (
    maskBearerToken(text)
      // OpenAI / Anthropic 风格密钥：sk-、sk-ant-
      .replace(/\bsk-[A-Za-z0-9\-_]{8,}/g, "sk-[REDACTED]")
      // GitHub token：ghp_ / gho_ / ghu_ / ghs_ / ghr_
      .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, "gh_[REDACTED]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "github_pat_[REDACTED]")
      // key=value / "key": "value" 形式的凭据字段
      .replace(
        /\b(access[_-]?token|api[_-]?key|apikey|secret|password|passwd|token)(\s*[=:]\s*"?)([^"\s,&}]{6,})("?)/gi,
        (_match, key: string, sep: string, _value: string, tail: string) =>
          `${key}${sep}[REDACTED]${tail}`,
      )
  );
}
