/**
 * 入站限流模块 — 滑动窗口算法
 *
 * 设计决策（参见 specs/001-inbound-rate-limiting/plan.md）：
 * - 滑动窗口 vs 简单 cooldown：选滑动窗口，防止窗口边界 burst bypass
 * - 数据结构：Map<key, number[]> 存储时间戳数组，O(1) 查 + O(k) 过期清理
 * - 最大活跃 key 数 5000，超过时清理最不活跃的 1000 个
 */

/**
 * 限流配置
 */
export interface RateLimitConfig {
  /** 窗口大小（ms），0 = 禁用 */
  windowMs: number;
  /** 窗口内最大消息数 */
  maxMessages: number;
}

/**
 * 限流检查结果
 */
export interface RateLimitResult {
  /** 是否允许通过 */
  allowed: boolean;
  /** 被限流时的剩余等待时间（ms），allowed=true 时为 0 */
  retryAfterMs: number;
  /** 当前窗口内已发送的消息数 */
  currentCount: number;
}

/**
 * 活跃限流条目（用于管理命令展示）
 */
export interface ActiveRateLimit {
  /** 限流目标标识 (user:xxx 或 group:xxx) */
  target: string;
  /** 剩余冷却时间（ms） */
  retryAfterMs: number;
  /** 窗口内已发送消息数 */
  count: number;
  /** 累计被限流次数 */
  blockedTotal: number;
}

const MAX_ACTIVE_KEYS = 5000;
const CLEANUP_BATCH = 1000;
const ADMIN_EXEMPTION_KEY = "__admin_exempt__";

/**
 * 入站限流器
 *
 * 使用场景：
 *   1. 用户级别限流：check(userId, undefined, isAdmin) → 按 userId 限流
 *   2. 群级别限流：check(undefined, groupId) → 按 groupId 限流
 *   3. 管理员豁免：isAdmin=true 时直接放行
 */
export class InboundRateLimiter {
  private readonly config: RateLimitConfig;
  /** key → 窗口内时间戳数组（已过期的已清理） */
  private readonly windows: Map<string, number[]>;
  /** key → 累计被限流次数 */
  private readonly blockedCounts: Map<string, number>;
  /** 管理员集合（免限流） */
  private readonly admins: Set<string>;

  constructor(config: RateLimitConfig, initialAdmins: number[] = []) {
    this.config = config;
    this.windows = new Map();
    this.blockedCounts = new Map();
    this.admins = new Set(initialAdmins.map((id) => String(id)));
  }

  /**
   * 更新管理员列表（配置热重载时调用）
   */
  updateAdmins(adminIds: number[]): void {
    this.admins.clear();
    for (const id of adminIds) this.admins.add(String(id));
  }

  /**
   * 更新窗口大小（配置热重载时调用）
   */
  updateWindowMs(windowMs: number): void {
    this.config.windowMs = windowMs;
  }

  /**
   * 检查是否允许通过
   *
   * @param userId - 用户 QQ 号（用户级限流）
   * @param groupId - 群号（群级限流）
   * @param isAdmin - 是否管理员（免限流）
   * @returns 限流检查结果
   */
  check(userId: number | undefined, groupId: number | undefined, isAdmin = false): RateLimitResult {
    // 禁用模式：零开销返回
    if (this.config.windowMs <= 0) {
      return { allowed: true, retryAfterMs: 0, currentCount: 0 };
    }

    // 管理员豁免
    if (isAdmin) {
      return { allowed: true, retryAfterMs: 0, currentCount: 0 };
    }

    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let worstResult: RateLimitResult = { allowed: true, retryAfterMs: 0, currentCount: 0 };

    // 检查用户级限流
    if (userId != null) {
      const userResult = this._checkKey(`user:${userId}`, windowStart, now);
      if (!userResult.allowed) worstResult = userResult;
    }

    // 检查群级限流
    if (groupId != null) {
      const groupResult = this._checkKey(`group:${groupId}`, windowStart, now);
      if (!groupResult.allowed) {
        // 如果用户级已超限，取更长的等待时间
        if (!worstResult.allowed) {
          worstResult = {
            allowed: false,
            retryAfterMs: Math.max(worstResult.retryAfterMs, groupResult.retryAfterMs),
            currentCount: Math.max(worstResult.currentCount, groupResult.currentCount),
          };
        } else {
          worstResult = groupResult;
        }
      }
    }

    return worstResult;
  }

  /**
   * 记录一次通过
   * 优先记录用户级；只有纯群级（无 userId）时才记录群级
   */
  record(userId: number | undefined, groupId: number | undefined): void {
    if (this.config.windowMs <= 0) return;

    const key = userId != null
      ? `user:${userId}`
      : groupId != null
        ? `group:${groupId}`
        : null;

    if (!key) return;

    const timestamps = this.windows.get(key);
    if (timestamps) {
      timestamps.push(Date.now());
    } else {
      this.windows.set(key, [Date.now()]);
    }

    this._enforceKeyLimit();
  }

  /**
   * 清除指定目标的限流状态
   */
  clear(target: string): boolean {
    const key = target.startsWith("user:") || target.startsWith("group:")
      ? target
      : `user:${target}`; // 兼容纯数字输入

    const hadWindow = this.windows.delete(key);
    const hadBlocked = this.blockedCounts.delete(key);
    return hadWindow || hadBlocked;
  }

  /**
   * 获取活跃限流列表（用于 /ratelimit 命令）
   */
  getActiveLimits(): ActiveRateLimit[] {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const result: ActiveRateLimit[] = [];

    for (const [key, timestamps] of this.windows.entries()) {
      // 清理已过期的
      const valid = timestamps.filter((t) => t > windowStart);
      if (valid.length !== timestamps.length) {
        if (valid.length === 0) {
          this.windows.delete(key);
          continue;
        }
        this.windows.set(key, valid);
      }

      if (valid.length >= this.config.maxMessages) {
        // 该 key 已达到限流阈值
        const oldestValid = valid[0];
        const retryAfter = Math.max(0, this.config.windowMs - (now - oldestValid));
        result.push({
          target: key,
          retryAfterMs: retryAfter,
          count: valid.length,
          blockedTotal: this.blockedCounts.get(key) ?? 0,
        });
      }
    }

    // 按剩余时间排序
    result.sort((a, b) => a.retryAfterMs - b.retryAfterMs);
    return result;
  }

  /**
   * 获取统计信息
   */
  getStats(): { activeKeys: number; totalBlocked: number } {
    let totalBlocked = 0;
    for (const count of this.blockedCounts.values()) {
      totalBlocked += count;
    }
    return {
      activeKeys: this.windows.size,
      totalBlocked,
    };
  }

  // ── 私有方法 ──────────────────────────────────────────────

  private _checkKey(key: string, windowStart: number, now: number): RateLimitResult {
    const timestamps = this.windows.get(key);

    // 无历史记录：允许
    if (!timestamps || timestamps.length === 0) {
      return { allowed: true, retryAfterMs: 0, currentCount: 0 };
    }

    // 清理过期时间戳
    const valid = timestamps.filter((t) => t > windowStart);
    if (valid.length !== timestamps.length) {
      if (valid.length === 0) {
        this.windows.delete(key);
        return { allowed: true, retryAfterMs: 0, currentCount: 0 };
      }
      this.windows.set(key, valid);
    }

    const count = valid.length;

    // 未超限：允许
    if (count < this.config.maxMessages) {
      return { allowed: true, retryAfterMs: 0, currentCount: count };
    }

    // 已超限：计算剩余等待时间
    // 最早的条目过期后，该 key 即可通过
    const oldestValid = valid[0];
    const retryAfter = Math.max(0, this.config.windowMs - (now - oldestValid));

    // 记录限流次数
    this.blockedCounts.set(key, (this.blockedCounts.get(key) ?? 0) + 1);

    return { allowed: false, retryAfterMs: retryAfter, currentCount: count };
  }

  /** 确保活跃 key 数不超过上限 */
  private _enforceKeyLimit(): void {
    if (this.windows.size <= MAX_ACTIVE_KEYS) return;

    const entries = [...this.windows.entries()];
    // 按最后活跃时间排序（最旧的先清理）
    entries.sort((a, b) => {
      const aLast = a[1].length > 0 ? a[1][a[1].length - 1] : 0;
      const bLast = b[1].length > 0 ? b[1][b[1].length - 1] : 0;
      return aLast - bLast;
    });

    const toRemove = Math.min(CLEANUP_BATCH, this.windows.size - MAX_ACTIVE_KEYS + CLEANUP_BATCH);
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.windows.delete(entries[i][0]);
    }
  }
}
