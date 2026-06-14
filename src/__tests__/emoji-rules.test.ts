import { describe, it, expect } from "vitest";
import { matchEmojiId, EMOJI_RULES, DEFAULT_EMOJI_ID } from "../utils/emoji-rules.js";

describe("matchEmojiId", () => {
  it("正常路径 — 匹配到对应规则返回正确 emojiId", () => {
    expect(matchEmojiId("查找文件")).toBe("124");
    expect(matchEmojiId("查询订单状态")).toBe("124");
    expect(matchEmojiId("好的收到")).toBe("76");
    expect(matchEmojiId("谢谢帮忙")).toBe("297");
    expect(matchEmojiId("你好呀")).toBe("76"); // "好" 匹配规则 1 (好|没问题)
    expect(matchEmojiId("嗨")).toBe("14");      // "嗨" 匹配规则 10 (早|晚安|嗨)
  });

  it("边界条件 — 空字符串返回默认 emoji", () => {
    expect(matchEmojiId("")).toBe(DEFAULT_EMOJI_ID);
    expect(matchEmojiId("   ")).toBe(DEFAULT_EMOJI_ID);
  });

  it("边界条件 — 无匹配返回默认 emoji", () => {
    expect(matchEmojiId("xyz 完全无关的内容")).toBe(DEFAULT_EMOJI_ID);
    expect(matchEmojiId("123456")).toBe(DEFAULT_EMOJI_ID);
  });

  it("边界条件 — 特殊字符和混合内容", () => {
    // "?" 应匹配规则 32
    expect(matchEmojiId("这是什么？")).toBe("32");
    // "哈哈" 应匹配规则 99
    expect(matchEmojiId("哈哈笑死我了")).toBe("99");
  });

  it("错误路径 — 正则不应抛异常", () => {
    // 匹配时正则不应因特殊字符崩溃
    expect(() => matchEmojiId("(?!)")).not.toThrow();
    expect(() => matchEmojiId("[$&+]")).not.toThrow();
  });

  it("规则表结构完整性", () => {
    // 每条规则都有 re 和 emojiId
    for (const rule of EMOJI_RULES) {
      expect(rule.re).toBeInstanceOf(RegExp);
      expect(typeof rule.emojiId).toBe("string");
      expect(rule.emojiId.length).toBeGreaterThan(0);
    }
  });

  it("优先级 — 先匹配的规则优先", () => {
    // "好的" 匹配规则 76（index 1），而非规则 118（index 6）
    expect(matchEmojiId("好的")).toBe("76");
  });
});
