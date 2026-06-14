import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InboundRateLimiter, type RateLimitConfig } from "../rate-limiter.js";

describe("InboundRateLimiter", () => {
  let limiter: InboundRateLimiter;
  const defaultConfig: RateLimitConfig = { windowMs: 1000, maxMessages: 3 };

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new InboundRateLimiter(defaultConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 禁用模式 ──────────────────────────────────────────────

  describe("disabled mode", () => {
    it("allows all messages when windowMs is 0", () => {
      const noop = new InboundRateLimiter({ windowMs: 0, maxMessages: 1 });
      for (let i = 0; i < 100; i++) {
        const result = noop.check(1001, undefined);
        expect(result.allowed).toBe(true);
      }
    });

    it("record is no-op when disabled", () => {
      const noop = new InboundRateLimiter({ windowMs: 0, maxMessages: 1 });
      noop.record(1001, undefined);
      const result = noop.check(1001, undefined);
      expect(result.currentCount).toBe(0);
    });
  });

  // ── 基本限流 ──────────────────────────────────────────────

  describe("basic rate limiting", () => {
    it("allows messages under the limit", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      expect(limiter.check(1001, undefined).allowed).toBe(true);
      vi.advanceTimersByTime(100);
      expect(limiter.check(1001, undefined).allowed).toBe(true);
      vi.advanceTimersByTime(100);
      expect(limiter.check(1001, undefined).allowed).toBe(true);
    });

    it("blocks the 4th message when maxMessages=3", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // 3 messages allowed
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        expect(r.allowed).toBe(true);
        if (r.allowed) limiter.record(1001, undefined);
        vi.advanceTimersByTime(100);
      }
      // 4th message blocked
      const blocked = limiter.check(1001, undefined);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("retryAfterMs decreases over time", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // Fill the window
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
        vi.advanceTimersByTime(100);
      }
      const blocked1 = limiter.check(1001, undefined);
      expect(blocked1.retryAfterMs).toBeGreaterThan(0);

      // Advance 500ms
      vi.advanceTimersByTime(500);
      const blocked2 = limiter.check(1001, undefined);
      expect(blocked2.retryAfterMs).toBeLessThan(blocked1.retryAfterMs);
    });

    it("allows again after window expires", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
        vi.advanceTimersByTime(100);
      }
      expect(limiter.check(1001, undefined).allowed).toBe(false);

      // Advance past window
      vi.advanceTimersByTime(1100);
      expect(limiter.check(1001, undefined).allowed).toBe(true);
    });
  });

  // ── 滑动窗口防 burst ──────────────────────────────────────

  describe("sliding window prevents burst", () => {
    it("prevents burst at window boundary", () => {
      // Send 3 messages at t=0, then wait almost the full window
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }

      // Wait 999ms (just 1ms before window expires)
      vi.advanceTimersByTime(999);
      // Should still be blocked — earliest entry hasn't expired yet
      expect(limiter.check(1001, undefined).allowed).toBe(false);

      // Wait 2ms more (window fully expired)
      vi.advanceTimersByTime(2);
      expect(limiter.check(1001, undefined).allowed).toBe(true);
    });

    it("uses sliding window not fixed window", () => {
      // Send 3 at t=0, 3 more at t=600ms
      // With sliding window of 1000ms: at t=600, the first 3 are still in window
      // So the 4th at t=600 should be blocked
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }

      vi.advanceTimersByTime(600);
      // Sliding window: t=0 entries still in [t-1000, t] = [-1000, 600]
      const r = limiter.check(1001, undefined);
      expect(r.allowed).toBe(false); // 3 entries still in window
    });
  });

  // ── 用户/群隔离 ──────────────────────────────────────────

  describe("user/group isolation", () => {
    it("isolates rate limits between different users", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }
      // User 1001 is rate limited
      expect(limiter.check(1001, undefined).allowed).toBe(false);
      // User 1002 is NOT rate limited
      expect(limiter.check(1002, undefined).allowed).toBe(true);
    });

    it("isolates rate limits between different groups", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(undefined, 2001);
        if (r.allowed) limiter.record(undefined, 2001);
      }
      // Group 2001 is rate limited
      expect(limiter.check(undefined, 2001).allowed).toBe(false);
      // Group 2002 is NOT rate limited
      expect(limiter.check(undefined, 2002).allowed).toBe(true);
    });

    it("user and group limits are independent", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // Record 3 messages from user 1001 (in any group context)
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, 2001);
        if (r.allowed) limiter.record(1001, 2001);
      }
      // user:1001 is rate limited (3 entries recorded under user:1001)
      expect(limiter.check(1001, undefined).allowed).toBe(false);
      // group:2001 is NOT rate limited (record() only tracks user key when userId is provided)
      expect(limiter.check(undefined, 2001).allowed).toBe(true);
      // Different user and group is allowed
      expect(limiter.check(1002, 2002).allowed).toBe(true);
    });
  });

  // ── 管理员豁免 ────────────────────────────────────────────

  describe("admin exemption", () => {
    it("allows admin even when rate limited", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }
      // Regular user blocked
      expect(limiter.check(1001, undefined).allowed).toBe(false);
      // Admin allowed
      expect(limiter.check(1001, undefined, true).allowed).toBe(true);
    });

    it("does not record admin messages", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      limiter.check(1001, undefined, true); // admin, allowed
      limiter.check(1001, undefined, true); // still admin
      // Non-admin should still be allowed (admin messages didn't consume quota)
      expect(limiter.check(1001, undefined).allowed).toBe(true);
    });
  });

  // ── clear 方法 ────────────────────────────────────────────

  describe("clear()", () => {
    it("clears a user's rate limit", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }
      expect(limiter.check(1001, undefined).allowed).toBe(false);

      expect(limiter.clear("user:1001")).toBe(true);
      expect(limiter.check(1001, undefined).allowed).toBe(true);
    });

    it("clears a group's rate limit", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(undefined, 2001);
        if (r.allowed) limiter.record(undefined, 2001);
      }
      expect(limiter.check(undefined, 2001).allowed).toBe(false);

      expect(limiter.clear("group:2001")).toBe(true);
      expect(limiter.check(undefined, 2001).allowed).toBe(true);
    });

    it("returns false for non-existent target", () => {
      expect(limiter.clear("user:99999")).toBe(false);
    });

    it("accepts plain numeric target as user", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }
      expect(limiter.clear("1001")).toBe(true);
      expect(limiter.check(1001, undefined).allowed).toBe(true);
    });
  });

  // ── getActiveLimits ───────────────────────────────────────

  describe("getActiveLimits()", () => {
    it("returns empty when no limits active", () => {
      expect(limiter.getActiveLimits()).toHaveLength(0);
    });

    it("returns active rate limited targets", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // Rate limit user 1001
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }
      // Not rate limit user 1002 (only 2 messages)
      for (let i = 0; i < 2; i++) {
        const r = limiter.check(1002, undefined);
        if (r.allowed) limiter.record(1002, undefined);
      }

      const active = limiter.getActiveLimits();
      expect(active).toHaveLength(1);
      expect(active[0]!.target).toBe("user:1001");
      expect(active[0]!.count).toBe(3);
      expect(active[0]!.retryAfterMs).toBeGreaterThan(0);
    });

    it("sorts by remaining cooldown", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // Rate limit user 1001 early
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        if (r.allowed) limiter.record(1001, undefined);
      }

      // Wait 500ms, then rate limit user 1002
      vi.advanceTimersByTime(500);
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1002, undefined);
        if (r.allowed) limiter.record(1002, undefined);
      }

      const active = limiter.getActiveLimits();
      expect(active).toHaveLength(2);
      // user:1001 rate limited at t=0 → oldest t=0 → remaining = 1000 - 500 = 500ms
      // user:1002 rate limited at t=500 → oldest t=500 → remaining = 1000 - 0 = 1000ms
      // Ascending sort: shorter remaining first
      expect(active[0]!.target).toBe("user:1001"); // 500ms remaining
      expect(active[1]!.target).toBe("user:1002"); // 1000ms remaining
    });
  });

  // ── _enforceKeyLimit 边界条件 ──────────────────────────────

  describe("_enforceKeyLimit eviction (P1 回归)", () => {
    it("超出上限 1 个时仅删除 1 个，保留恰好 MAX_ACTIVE_KEYS 个", () => {
      // 使用私有方法访问（通过 record 触发）
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // 填充 5000 个 key（MAX_ACTIVE_KEYS = 5000）
      for (let i = 0; i < 5000; i++) {
        limiter.record(i, undefined);
      }
      expect(limiter.getStats().activeKeys).toBe(5000);

      // 再添加 1 个，触发淘汰
      limiter.record(5000, undefined);

      // 应该恰好保留 5000 个（MAX_ACTIVE_KEYS），不是 4000
      const stats = limiter.getStats();
      expect(stats.activeKeys).toBe(5000);
    });

    it("超出上限 1200 个时删除 1000 个（不超过 CLEANUP_BATCH）", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // 填充 5000 个 key
      for (let i = 0; i < 5000; i++) {
        limiter.record(i, undefined);
      }
      // 再添加 1200 个，超出上限 1200
      for (let i = 5000; i < 6200; i++) {
        limiter.record(i, undefined);
      }

      // 应该保留 5000 个（删除 1200 个中的前 1000 个）
      expect(limiter.getStats().activeKeys).toBe(5000);
    });
  });

  // ── getStats ──────────────────────────────────────────────

  describe("getStats()", () => {
    it("returns correct stats", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      // Fill window: 3 messages at t=0
      for (let i = 0; i < 3; i++) {
        const r = limiter.check(1001, undefined);
        expect(r.allowed).toBe(true);
        limiter.record(1001, undefined);
      }
      // 4th and beyond are blocked
      for (let i = 0; i < 4; i++) {
        limiter.check(1001, undefined); // blocked
        vi.advanceTimersByTime(100);
      }

      const stats = limiter.getStats();
      expect(stats.activeKeys).toBe(1);
      expect(stats.totalBlocked).toBe(4);
    });
  });

  // ── 更新管理员 ────────────────────────────────────────────

  describe("updateAdmins()", () => {
    it("updates admin list for hot-reload", () => {
      const limiter2 = new InboundRateLimiter(defaultConfig, [999]);
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      for (let i = 0; i < 3; i++) {
        const r = limiter2.check(1001, undefined);
        if (r.allowed) limiter2.record(1001, undefined);
      }
      // 999 is admin, should pass
      expect(limiter2.check(999, undefined).allowed).toBe(true);

      // Remove 999 from admins
      limiter2.updateAdmins([]);
      // Now 999 should be rate limited too (since 1001's entries count for same key? No, different user)
      // Actually 999 has no entries, so it should still be allowed...
      // Let's test that 999 gets blocked after its own entries
      for (let i = 0; i < 3; i++) {
        const r = limiter2.check(999, undefined);
        if (r.allowed) limiter2.record(999, undefined);
      }
      expect(limiter2.check(999, undefined).allowed).toBe(false);
    });
  });

  // ── 更新窗口大小 ────────────────────────────────────────────

  describe("updateWindowMs()", () => {
    it("updates window size for hot-reload", () => {
      const limiter3 = new InboundRateLimiter(
        { windowMs: 5000, maxMessages: 2 },
        [],
      );
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      limiter3.record(1001, undefined);
      limiter3.record(1001, undefined);
      expect(limiter3.check(1001, undefined).allowed).toBe(false);

      // Fast-forward past original window (5s)
      vi.setSystemTime(new Date("2024-01-01T00:00:05.001Z"));
      expect(limiter3.check(1001, undefined).allowed).toBe(true); // old entries expired

      // Shrink window to 1000ms - records from t=0 are now outside the new window
      limiter3.updateWindowMs(1000);
      limiter3.record(1001, undefined);
      // The old entries at t=0 are now outside 1s window from current time (5s ago)
      // so user should be allowed (only 1 entry in new window)
      const result = limiter3.check(1001, undefined);
      expect(result.allowed).toBe(true);
    });
  });
});
