/**
 * 二次确认机制
 *
 * 用于高代价/不可逆的管理员命令（/dismiss /leave /setname /admin /unadmin 等）。
 * 同一 admin 在 TTL 窗口内发两次同样的命令才真正执行，避免误按。
 *
 * 实现：模块级 Map（per-key），TTL 默认 30s，纯函数 API。
 * 不持久化：进程重启后所有 pending 自动失效（这是想要的行为，防止悬空状态）。
 */

/** 默认二次确认窗口（ms）。30 秒足以让 admin 看到提示并复制粘贴重发。 */
export const DEFAULT_CONFIRM_TTL_MS = 30_000;

/** 内部 pending 条目：记录首次触发时间戳。 */
interface PendingEntry {
  firstAt: number;  // ms
}

/** 模块级 pending Map（不导出，仅通过纯函数访问）。 */
const pendingMap = new Map<string, PendingEntry>();

/** 构造内部 key：userId + action（含目标识别符如 `${cmd}:${groupId}`）。 */
function buildKey(userId: number, action: string): string {
  return `${userId}::${action}`;
}

/**
 * 请求二次确认。
 *
 * - 首次调用 → 写入 pending，返回 "pending"（调用方应 reply "再发一次以确认"）
 * - TTL 窗口内同 key 二次调用 → 删除 pending，返回 "confirmed"（调用方应执行真正动作）
 * - 超过 TTL 的二次调用 → 视作首次（重置 pending），返回 "pending"
 *
 * 不依赖 Date.now()/setTimeout 调度——读取时按需检查 firstAt + ttl 是否过期。
 *
 * @param userId admin QQ 号
 * @param action 动作标识，应含目标识别符（例如 `dismiss:88888`、`admin:55555:88888`）
 * @param ttlMs 二次确认窗口；默认 30s
 * @returns "pending" | "confirmed"
 */
export function requireConfirm(
  userId: number,
  action: string,
  ttlMs: number = DEFAULT_CONFIRM_TTL_MS,
): "pending" | "confirmed" {
  const key = buildKey(userId, action);
  const now = Date.now();
  const entry = pendingMap.get(key);

  if (entry && now - entry.firstAt <= ttlMs) {
    // 二次确认命中
    pendingMap.delete(key);
    return "confirmed";
  }

  // 首次或已过期（重新计时）
  pendingMap.set(key, { firstAt: now });
  return "pending";
}

/**
 * 主动清除一个 pending 条目（命令取消、显式 reset 等场景使用）。
 */
export function clearConfirm(userId: number, action: string): void {
  pendingMap.delete(buildKey(userId, action));
}

/**
 * 仅用于测试：重置全部 pending 状态。
 */
export function _testReset(): void {
  pendingMap.clear();
}

/**
 * 仅用于测试：返回 pending Map 当前条目数。
 */
export function _testSize(): number {
  return pendingMap.size;
}
