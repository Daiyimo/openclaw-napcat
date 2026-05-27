/**
 * 旁观模式冷却状态管理
 *
 * 状态机：
 *   未记录 → markActive() → 哨兵（派发进行中，记录创建时间）
 *                        → markDone()   → cooldown timestamp（真实冷却时间）
 *                        → markSilent() → 未记录（AI 选择静默）
 *
 * 哨兵释放策略（懒释放）：
 *   不使用 setTimeout，避免与 vi.useFakeTimers() 产生交互。
 *   isAllowed() 中检查哨兵年龄；超过 PASSIVE_SENTINEL_TIMEOUT_MS 则视为自动释放。
 *   cleanup() 调用时刷新哨兵时间戳，保证 cleanup 结束后哨兵继续有效（重置懒超时窗口）。
 */

import { PASSIVE_SENTINEL_TIMEOUT_MS } from "./constants.js";

export class PassiveModeManager {
  /** 活跃哨兵：key → 哨兵写入的 Date.now() */
  private readonly sentinels = new Map<string, number>();
  /** 已完成派发的冷却时间戳：key → 最近一次 markDone 的 Date.now() */
  private readonly cooldowns = new Map<string, number>();

  /**
   * 检查是否允许触发旁观。
   * 返回 false 的情况：
   *   - 哨兵存在且未超时（派发进行中，拒绝并发）
   *   - 上次回复时间距今 < cooldownMs
   */
  isAllowed(key: string, cooldownMs: number): boolean {
    const sentinelAt = this.sentinels.get(key);
    if (sentinelAt !== undefined) {
      // 懒释放：哨兵年龄超过兜底超时则视为自动释放，放行
      if (Date.now() - sentinelAt >= PASSIVE_SENTINEL_TIMEOUT_MS) {
        this.sentinels.delete(key);
        return true;
      }
      return false;
    }
    const ts = this.cooldowns.get(key);
    if (ts === undefined) return true;
    return Date.now() - ts >= cooldownMs;
  }

  /**
   * 标记派发开始：写入哨兵，记录创建时间。
   * 不注册 setTimeout；释放逻辑由 isAllowed() 懒判定负责。
   */
  markActive(key: string): void {
    this.sentinels.set(key, Date.now());
  }

  /**
   * 派发成功：仅当哨兵仍存在时将其移入 cooldowns，写入真实时间戳。
   * 若哨兵不存在（重复调用时），跳过，已有冷却时间戳不受影响。
   */
  markDone(key: string): void {
    if (this.sentinels.has(key)) {
      this.sentinels.delete(key);
      this.cooldowns.set(key, Date.now());
    }
  }

  /**
   * AI 选择 [SILENT]：仅清除哨兵，不清除已有冷却时间戳。
   */
  markSilent(key: string): void {
    if (this.sentinels.has(key)) {
      this.sentinels.delete(key);
    }
  }

  /**
   * 清理超过 maxAgeMs 的过期冷却条目。
   * 不再刷新哨兵时间戳 — 哨兵生命期仅由 markActive 时写入的时间戳和
   * PASSIVE_SENTINEL_TIMEOUT_MS 兜底超时决定，cleanup 不应干扰。
   */
  cleanup(maxAgeMs: number): void {
    const now = Date.now();
    // 清理已超时的哨兵（兜底释放，正常路径由 markDone/markSilent 处理）
    for (const [key, sentinelAt] of this.sentinels.entries()) {
      if (now - sentinelAt >= PASSIVE_SENTINEL_TIMEOUT_MS) {
        this.sentinels.delete(key);
      }
    }
    // 清理超龄冷却条目
    for (const [key, value] of this.cooldowns.entries()) {
      if (now - value > maxAgeMs) {
        this.cooldowns.delete(key);
      }
    }
  }
}
