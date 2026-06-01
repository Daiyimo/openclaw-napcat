import { describe, it, expect } from "vitest";
import { appendBotSignature } from "../utils/bot-signature.js";

describe("appendBotSignature", () => {
  it("visible 模式追加 [BOT:123]", () => {
    expect(appendBotSignature("hello", 123, "visible")).toBe("hello[BOT:123]");
  });

  it("zero-width 模式追加零宽字符签名", () => {
    const result = appendBotSignature("hello", "123", "zero-width");
    // 零宽字符签名格式：U+200B + "123" + U+200C
    expect(result).toBe("hello​123‌");
  });

  it("text 为空时不追加", () => {
    expect(appendBotSignature("", 123, "visible")).toBe("");
    expect(appendBotSignature("", 123, "zero-width")).toBe("");
  });

  it("botSelfId 缺失时不追加", () => {
    expect(appendBotSignature("hello", null, "visible")).toBe("hello");
    expect(appendBotSignature("hello", undefined, "visible")).toBe("hello");
  });

  it("支持字符串型 selfId", () => {
    expect(appendBotSignature("hi", "99999", "visible")).toBe("hi[BOT:99999]");
  });

  it("visible 与 zero-width 模式输出不同", () => {
    const visible = appendBotSignature("x", 1, "visible");
    const zero = appendBotSignature("x", 1, "zero-width");
    expect(visible).not.toBe(zero);
  });
});
