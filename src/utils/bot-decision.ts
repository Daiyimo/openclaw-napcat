/**
 * Bot 决策工具
 *
 * 在多 bot 同群场景下，用 bot 自身 ID 做"确定性分散"决策：
 * - 同一 bot 在同一场景下行为稳定（不像 random 会抖动）
 * - 不同 bot 的 selfId 分布均匀（期望上 N 个 bot 中按比例分散）
 * - 无需 API 查询、无需中心协调
 */

/**
 * 简单稳定哈希（djb2 变种）。selfId 字符串 → 0..2^32 整数。
 *
 * 为何不用 Math.random：随机导致同一 bot 行为不可预测（这次回下次不回），
 * 确定性 hash 让每个 bot 的"性格"在配置后保持稳定。
 */
function stableHash(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash |= 0; // 32-bit integer
  }
  // ⚠️ P0 修复：Math.abs 无法处理 Number.MIN_SAFE_INTEGER (-2147483648)，
  // 因为 IEEE 754 双精度无法表示该值的正数。用 >>> 0 转为无符号 32 位整数。
  return hash >>> 0;
}

/**
 * 决定本 bot 是否对用户停止指令回结束语。
 *
 * - ratio = 1 → 所有 bot 都回
 * - ratio = 0 → 没有 bot 回
 * - ratio = 0.66 → 约 2/3 的 bot 回（按 selfId hash 分布）
 *
 * 同一 selfId + ratio 的结果稳定不变（同 bot 在同群里行为一致）。
 */
export function shouldBotReplyToStop(selfId: string | number, ratio: number): boolean {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  const normalized = (stableHash(String(selfId)) % 10001) / 10000;
  return normalized < ratio;
}

/**
 * 计算本 bot 回结束语的错开延迟（ms）。
 *
 * 范围 [0, maxMs)。同一 selfId 的延迟稳定不变。
 */
export function getBotStopDelay(selfId: string | number, maxMs: number): number {
  if (maxMs <= 0) return 0;
  return stableHash(String(selfId)) % maxMs;
}

/**
 * 停止意图关键词正则缓存：keywords JSON → RegExp[]
 * 关键词列表不常变，缓存避免每条消息重新编译正则。
 */
const STOP_INTENT_REGEX_CACHE = new Map<string, RegExp[]>();

function getStopIntentRegexes(keywords: readonly string[]): RegExp[] {
  const key = JSON.stringify(keywords);
  const cached = STOP_INTENT_REGEX_CACHE.get(key);
  if (cached) return cached;
  const regexes: RegExp[] = [];
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    const escaped = lowerKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/[a-z]/i.test(lowerKw)) {
      regexes.push(new RegExp(`\\b${escaped}\\b`, "i"));
    }
    // 中文关键词用 substring 匹配，不缓存正则
  }
  STOP_INTENT_REGEX_CACHE.set(key, regexes);
  return regexes;
}

/**
 * 检测用户消息是否含"停止对话"意图关键词。
 *
 * 匹配规则：不区分大小写、词边界匹配（避免 "stopwatch" 误命中 "stop"）。
 */
export function detectStopIntent(text: string, keywords: readonly string[]): boolean {
  if (!text || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  const regexes = getStopIntentRegexes(keywords);
  for (const re of regexes) {
    if (re.test(lower)) return true;
  }
  // 中文关键词（不含拉丁字母）：直接 substring
  for (const kw of keywords) {
    if (!/[a-z]/i.test(kw)) {
      if (lower.includes(kw.toLowerCase())) return true;
    }
  }
  return false;
}
