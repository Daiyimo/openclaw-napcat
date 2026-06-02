/**
 * 二次确认机制单元测试
 *
 * 零 mock 纯函数测试。覆盖：
 *   - 首次返回 pending
 *   - TTL 内二次确认 → confirmed
 *   - 超 TTL → 重置为 pending
 *   - 不同 user / 不同 action 独立
 *   - clearConfirm 主动清除
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  requireConfirm,
  clearConfirm,
  DEFAULT_CONFIRM_TTL_MS,
  _testReset,
  _testSize,
} from "../utils/confirm-pending.js";

describe("requireConfirm — 基本流程", () => {
  beforeEach(() => {
    _testReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test_first_call_returns_pending", () => {
    expect(requireConfirm(123, "dismiss:88888")).toBe("pending");
    expect(_testSize()).toBe(1);
  });

  it("test_second_call_within_ttl_returns_confirmed_and_clears", () => {
    requireConfirm(123, "dismiss:88888");
    vi.advanceTimersByTime(10_000);  // 10s 内
    expect(requireConfirm(123, "dismiss:88888")).toBe("confirmed");
    expect(_testSize()).toBe(0);  // 确认后自动清除
  });

  it("test_second_call_at_ttl_boundary_returns_confirmed", () => {
    requireConfirm(123, "dismiss:88888");
    vi.advanceTimersByTime(DEFAULT_CONFIRM_TTL_MS);  // 恰好 TTL 边界
    expect(requireConfirm(123, "dismiss:88888")).toBe("confirmed");
  });

  it("test_second_call_after_ttl_resets_to_pending", () => {
    requireConfirm(123, "dismiss:88888");
    vi.advanceTimersByTime(DEFAULT_CONFIRM_TTL_MS + 1);  // 超 1ms
    expect(requireConfirm(123, "dismiss:88888")).toBe("pending");
    // 应重置为新的 pending（仍有 1 个条目）
    expect(_testSize()).toBe(1);
  });

  it("test_third_call_within_new_ttl_after_reset_returns_confirmed", () => {
    requireConfirm(123, "dismiss:88888");
    vi.advanceTimersByTime(DEFAULT_CONFIRM_TTL_MS + 1);
    requireConfirm(123, "dismiss:88888");  // 视作首次
    vi.advanceTimersByTime(5_000);
    expect(requireConfirm(123, "dismiss:88888")).toBe("confirmed");
  });
});

describe("requireConfirm — 隔离性", () => {
  beforeEach(() => {
    _testReset();
  });

  it("test_different_users_have_independent_pending", () => {
    requireConfirm(111, "admin:55555");
    requireConfirm(222, "admin:55555");
    expect(_testSize()).toBe(2);
    // 用户 111 确认不影响 222
    expect(requireConfirm(111, "admin:55555")).toBe("confirmed");
    expect(_testSize()).toBe(1);
    expect(requireConfirm(222, "admin:55555")).toBe("confirmed");
  });

  it("test_different_actions_have_independent_pending", () => {
    requireConfirm(111, "admin:55555:88888");
    requireConfirm(111, "dismiss:88888");
    expect(_testSize()).toBe(2);
    expect(requireConfirm(111, "admin:55555:88888")).toBe("confirmed");
    expect(_testSize()).toBe(1);
  });
});

describe("requireConfirm — 自定义 TTL", () => {
  beforeEach(() => {
    _testReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test_custom_ttl_overrides_default", () => {
    requireConfirm(123, "test", 5000);
    vi.advanceTimersByTime(4999);
    expect(requireConfirm(123, "test", 5000)).toBe("confirmed");
  });

  it("test_custom_ttl_expires_correctly", () => {
    requireConfirm(123, "test", 5000);
    vi.advanceTimersByTime(5001);
    expect(requireConfirm(123, "test", 5000)).toBe("pending");
  });
});

describe("clearConfirm", () => {
  beforeEach(() => {
    _testReset();
  });

  it("test_clear_removes_pending", () => {
    requireConfirm(123, "test");
    expect(_testSize()).toBe(1);
    clearConfirm(123, "test");
    expect(_testSize()).toBe(0);
    // 清除后再次调用视为首次
    expect(requireConfirm(123, "test")).toBe("pending");
  });

  it("test_clear_nonexistent_is_noop", () => {
    expect(() => clearConfirm(999, "never-set")).not.toThrow();
    expect(_testSize()).toBe(0);
  });
});
