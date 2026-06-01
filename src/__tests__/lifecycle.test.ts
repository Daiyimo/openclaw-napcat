/**
 * lifecycle.ts 辅助函数单元测试
 *
 * 注：lifecycle.ts 整体依赖 OpenClaw 框架和 AbortSignal，启动逻辑难以单测。
 * 这里只对内部辅助函数做单测。
 */
import { describe, it, expect } from "vitest";
import { trimDedupSet } from "../gateway/lifecycle.js";

describe("trimDedupSet", () => {
  it("集合未超 maxSize 时不修剪", () => {
    const set = new Set(["1", "2", "3"]);
    expect(trimDedupSet(set, 10, 5)).toBe(false);
    expect(set.size).toBe(3);
  });

  it("集合刚好等于 maxSize 时不修剪", () => {
    const set = new Set(["1", "2", "3", "4", "5"]);
    expect(trimDedupSet(set, 5, 3)).toBe(false);
    expect(set.size).toBe(5);
  });

  it("集合超过 maxSize 时修剪到 keepSize，保留最新 N 条", () => {
    const set = new Set(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(trimDedupSet(set, 5, 3)).toBe(true);
    expect(set.size).toBe(3);
    // 保留最新 3 条（6, 7, 8）
    expect([...set]).toEqual(["6", "7", "8"]);
  });

  it("使用默认参数（maxSize=2000, keepSize=1000）", () => {
    const set = new Set<string>();
    for (let i = 0; i < 2500; i++) set.add(String(i));
    expect(trimDedupSet(set)).toBe(true);
    expect(set.size).toBe(1000);
    // 保留最新 1000 条
    const entries = [...set];
    expect(entries[0]).toBe("1500");
    expect(entries[999]).toBe("2499");
  });

  it("修剪后集合可继续添加新元素", () => {
    const set = new Set(["1", "2", "3", "4", "5", "6"]);
    trimDedupSet(set, 3, 2);
    expect(set.size).toBe(2);
    set.add("new1");
    set.add("new2");
    expect(set.size).toBe(4);
  });
});
