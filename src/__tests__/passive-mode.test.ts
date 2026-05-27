import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassiveModeManager } from "../passive-mode.js";
import { PASSIVE_SENTINEL_TIMEOUT_MS } from "../constants.js";

describe("PassiveModeManager", () => {
  let manager: PassiveModeManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PassiveModeManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isAllowed", () => {
    it("首次访问未知 key 返回 true", () => {
      expect(manager.isAllowed("key1", 10_000)).toBe(true);
    });

    it("哨兵存在时返回 false（拒绝并发派发）", () => {
      manager.markActive("key1");
      expect(manager.isAllowed("key1", 10_000)).toBe(false);
    });

    it("markDone 后冷却期内返回 false", () => {
      manager.markActive("key1");
      manager.markDone("key1");
      vi.advanceTimersByTime(5_000);
      expect(manager.isAllowed("key1", 10_000)).toBe(false);
    });

    it("markDone 后冷却到期返回 true", () => {
      manager.markActive("key1");
      manager.markDone("key1");
      vi.advanceTimersByTime(10_001);
      expect(manager.isAllowed("key1", 10_000)).toBe(true);
    });
  });

  describe("markActive", () => {
    it("调用后 isAllowed 返回 false", () => {
      manager.markActive("key1");
      expect(manager.isAllowed("key1", 0)).toBe(false);
    });

    it("超过 PASSIVE_SENTINEL_TIMEOUT_MS 后哨兵自动释放", () => {
      manager.markActive("key1");
      vi.advanceTimersByTime(PASSIVE_SENTINEL_TIMEOUT_MS + 1);
      expect(manager.isAllowed("key1", 10_000)).toBe(true);
    });
  });

  describe("markDone", () => {
    it("将哨兵替换为真实时间戳（isAllowed 在 cooldown 内返回 false）", () => {
      manager.markActive("key1");
      manager.markDone("key1");
      expect(manager.isAllowed("key1", 10_000)).toBe(false);
    });

    it("如果没有哨兵（已有时间戳）不会覆盖已有时间戳", () => {
      manager.markActive("key1");
      manager.markDone("key1");
      vi.advanceTimersByTime(8_000);
      // 再调一次 markDone 不应重置计时
      manager.markDone("key1");
      vi.advanceTimersByTime(4_000); // 总共 12s，如果没被重置应该已到期
      expect(manager.isAllowed("key1", 10_000)).toBe(true);
    });
  });

  describe("markSilent", () => {
    it("清除哨兵，之后 isAllowed 返回 true", () => {
      manager.markActive("key1");
      manager.markSilent("key1");
      expect(manager.isAllowed("key1", 10_000)).toBe(true);
    });

    it("对非哨兵（已有时间戳）调用不删除时间戳", () => {
      manager.markActive("key1");
      manager.markDone("key1");
      manager.markSilent("key1"); // 不应清除时间戳
      expect(manager.isAllowed("key1", 10_000)).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("删除超龄条目（非哨兵）", () => {
      manager.markActive("key1");
      manager.markDone("key1");
      vi.advanceTimersByTime(3_700_000); // > PASSIVE_COOLDOWN_MAX_AGE_MS
      manager.cleanup(3_600_000);
      expect(manager.isAllowed("key1", 0)).toBe(true);
    });

    it("保留未超龄的条目", () => {
      manager.markActive("key1");
      manager.markDone("key1");
      vi.advanceTimersByTime(1_000);
      manager.cleanup(3_600_000);
      expect(manager.isAllowed("key1", 10_000)).toBe(false);
    });

    it("超龄哨兵在 isAllowed 中被懒释放，cleanup 之后 isAllowed 返回 true", () => {
      manager.markActive("key1");
      vi.advanceTimersByTime(3_700_000); // > PASSIVE_SENTINEL_TIMEOUT_MS
      manager.cleanup(3_600_000);
      expect(manager.isAllowed("key1", 0)).toBe(true);
    });
  });

  it("完整状态机流转：markActive → markDone → 冷却期内 isAllowed=false", () => {
    expect(manager.isAllowed("k", 5_000)).toBe(true);
    manager.markActive("k");
    expect(manager.isAllowed("k", 5_000)).toBe(false);
    manager.markDone("k");
    expect(manager.isAllowed("k", 5_000)).toBe(false);
    vi.advanceTimersByTime(5_001);
    expect(manager.isAllowed("k", 5_000)).toBe(true);
  });
});
