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

  describe("isBotSuppressed", () => {
    it("无 bot 活跃记录时返回 false", () => {
      expect(manager.isBotSuppressed("group:88888", 120_000)).toBe(false);
    });

    it("markBotActive 后抑制期内返回 true", () => {
      manager.markBotActive("group:88888");
      vi.advanceTimersByTime(60_000);
      expect(manager.isBotSuppressed("group:88888", 120_000)).toBe(true);
    });

    it("markBotActive 后抑制到期返回 false", () => {
      manager.markBotActive("group:88888");
      vi.advanceTimersByTime(120_001);
      expect(manager.isBotSuppressed("group:88888", 120_000)).toBe(false);
    });

    it("botSuppressionMs=0 时始终返回 false", () => {
      manager.markBotActive("group:88888");
      expect(manager.isBotSuppressed("group:88888", 0)).toBe(false);
    });

    it("不同群 key 互不影响", () => {
      manager.markBotActive("group:11111");
      expect(manager.isBotSuppressed("group:22222", 120_000)).toBe(false);
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

  describe("isIntervalAllowed", () => {
    it("首次访问未知 key 返回 true", () => {
      expect(manager.isIntervalAllowed("key1", 30_000)).toBe(true);
    });

    it("markCheck 后间隔内返回 false", () => {
      manager.markCheck("key1");
      vi.advanceTimersByTime(10_000);
      expect(manager.isIntervalAllowed("key1", 30_000)).toBe(false);
    });

    it("markCheck 后间隔到期返回 true", () => {
      manager.markCheck("key1");
      vi.advanceTimersByTime(30_001);
      expect(manager.isIntervalAllowed("key1", 30_000)).toBe(true);
    });

    it("多次 markCheck 以最后一次为准", () => {
      manager.markCheck("key1");
      vi.advanceTimersByTime(20_000);
      manager.markCheck("key1"); // 重置计时
      vi.advanceTimersByTime(20_000); // 距上次 markCheck 20s
      expect(manager.isIntervalAllowed("key1", 30_000)).toBe(false);
      vi.advanceTimersByTime(10_001); // 距上次 markCheck 30s+
      expect(manager.isIntervalAllowed("key1", 30_000)).toBe(true);
    });

    it("cleanup 清理超龄 lastCheck 条目", () => {
      manager.markCheck("key1");
      vi.advanceTimersByTime(3_700_000); // > PASSIVE_COOLDOWN_MAX_AGE_MS
      manager.cleanup(3_600_000);
      expect(manager.isIntervalAllowed("key1", 0)).toBe(true);
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

  // P0 回归测试：markActive 必须在 isAllowed 返回 true 后立即调用
  // 否则并发消息可同时通过检查，同时派发到 AI
  it("markActive 后并发 isAllowed 被阻塞", () => {
    const key = "concurrent-test";
    expect(manager.isAllowed(key, 10_000)).toBe(true);
    // 模拟 trigger.ts 中 isAllowed 通过后设置哨兵
    manager.markActive(key);
    // 第二条消息立即检查 → 被哨兵拦截
    expect(manager.isAllowed(key, 10_000)).toBe(false);
    // 释放哨兵
    manager.markDone(key);
    expect(manager.isAllowed(key, 10_000)).toBe(false); // 冷却中
  });

  it("markCheck 记录检查时间戳，控制 minIntervalMs", () => {
    const key = "interval-test";
    expect(manager.isIntervalAllowed(key, 5_000)).toBe(true);
    manager.markCheck(key);
    expect(manager.isIntervalAllowed(key, 5_000)).toBe(false);
    vi.advanceTimersByTime(5_001);
    expect(manager.isIntervalAllowed(key, 5_000)).toBe(true);
  });
});
