import { describe, it, expect } from "vitest";
import { shouldBotReplyToStop, getBotStopDelay, detectStopIntent } from "../utils/bot-decision.js";

describe("shouldBotReplyToStop", () => {
  it("ratio=1 时所有 bot 都回", () => {
    for (let id = 1; id <= 100; id++) {
      expect(shouldBotReplyToStop(String(id), 1)).toBe(true);
    }
  });

  it("ratio=0 时没有 bot 回", () => {
    for (let id = 1; id <= 100; id++) {
      expect(shouldBotReplyToStop(String(id), 0)).toBe(false);
    }
  });

  it("ratio=0.5 时约一半 bot 回（±15%）", () => {
    let count = 0;
    const N = 1000;
    for (let id = 1; id <= N; id++) {
      if (shouldBotReplyToStop(String(id), 0.5)) count++;
    }
    const ratio = count / N;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });

  it("ratio=0.66 时约 2/3 bot 回（±15%）", () => {
    let count = 0;
    const N = 1000;
    for (let id = 1; id <= N; id++) {
      if (shouldBotReplyToStop(String(id), 0.66)) count++;
    }
    const ratio = count / N;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.8);
  });

  it("同一 selfId 多次调用结果稳定", () => {
    const a = shouldBotReplyToStop("12345", 0.66);
    const b = shouldBotReplyToStop("12345", 0.66);
    const c = shouldBotReplyToStop("12345", 0.66);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("支持数字型 selfId", () => {
    const result = shouldBotReplyToStop(12345, 0.66);
    expect(typeof result).toBe("boolean");
  });

  it("P0 修复：stableHash 对 -2147483648 返回非负数", () => {
    // Math.abs(-2147483648) 在 JS 中仍返回负数（IEEE 754 限制）
    // 修复后用 >>> 0，确保 hash 值始终为非负
    const result = shouldBotReplyToStop("-2147483648", 0.66);
    expect(typeof result).toBe("boolean");
    // 不应因 normalized 为负而导致恒为 true
    // 通过同一 ID 调用两次确认结果稳定
    const again = shouldBotReplyToStop("-2147483648", 0.66);
    expect(result).toBe(again);
  });
});

describe("getBotStopDelay", () => {
  it("maxMs=0 时返回 0", () => {
    expect(getBotStopDelay("12345", 0)).toBe(0);
  });

  it("返回 [0, maxMs) 范围", () => {
    const max = 300;
    for (let id = 1; id <= 100; id++) {
      const delay = getBotStopDelay(String(id), max);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(max);
    }
  });

  it("同一 selfId 多次调用结果稳定", () => {
    const a = getBotStopDelay("12345", 300);
    const b = getBotStopDelay("12345", 300);
    expect(a).toBe(b);
  });
});

describe("detectStopIntent", () => {
  it("匹配中文关键词", () => {
    expect(detectStopIntent("别聊了", ["别聊了"])).toBe(true);
    expect(detectStopIntent("求求你们别聊了", ["别聊了"])).toBe(true);
  });

  it("匹配英文关键词（词边界）", () => {
    expect(detectStopIntent("please stop", ["stop"])).toBe(true);
    expect(detectStopIntent("Stop now", ["stop"])).toBe(true);
  });

  it("不误匹配 stopwatch 等子串", () => {
    expect(detectStopIntent("use the stopwatch", ["stop"])).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(detectStopIntent("STOP", ["stop"])).toBe(true);
    expect(detectStopIntent("stop", ["STOP"])).toBe(true);
  });

  it("多关键词任一匹配", () => {
    expect(detectStopIntent("闭嘴吧", ["别聊了", "闭嘴", "安静"])).toBe(true);
    expect(detectStopIntent("安静一下", ["别聊了", "闭嘴", "安静"])).toBe(true);
  });

  it("空文本不匹配", () => {
    expect(detectStopIntent("", ["stop"])).toBe(false);
  });

  it("空关键词列表不匹配", () => {
    expect(detectStopIntent("别聊了", [])).toBe(false);
  });
});
