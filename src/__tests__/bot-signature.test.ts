import { describe, it, expect } from "vitest";
import { appendBotSignature } from "../utils/bot-signature.js";

describe("appendBotSignature (v1.9.4 优先用 botName)", () => {
  it("visible 模式追加 [BOT:<name>]", () => {
    expect(appendBotSignature("hello", "云崽", 123, "visible")).toBe("hello[BOT:云崽]");
  });

  it("zero-width 模式追加零宽字符签名", () => {
    const result = appendBotSignature("hello", "123", "123", "zero-width");
    // 零宽字符签名格式：U+200B + "123" + U+200C
    expect(result).toBe("hello​123‌");
  });

  it("text 为空时不追加", () => {
    expect(appendBotSignature("", "云崽", 123, "visible")).toBe("");
    expect(appendBotSignature("", "云崽", 123, "zero-width")).toBe("");
  });

  it("botName 和 botSelfId 都缺失时不追加", () => {
    expect(appendBotSignature("hello", null, null, "visible")).toBe("hello");
    expect(appendBotSignature("hello", undefined, undefined, "visible")).toBe("hello");
  });

  it("botName 缺失时回退到 UID 兜底", () => {
    expect(appendBotSignature("hi", null, 99999, "visible")).toBe("hi[BOT:99999]");
    expect(appendBotSignature("hi", undefined, 99999, "visible")).toBe("hi[BOT:99999]");
  });

  it("支持字符串型 selfId", () => {
    expect(appendBotSignature("hi", null, "99999", "visible")).toBe("hi[BOT:99999]");
  });

  it("visible 与 zero-width 模式输出不同", () => {
    const visible = appendBotSignature("x", "云崽", 1, "visible");
    const zero = appendBotSignature("x", "云崽", 1, "zero-width");
    expect(visible).not.toBe(zero);
  });

  it("none 模式永不追加", () => {
    expect(appendBotSignature("hello", "云崽", 123, "none")).toBe("hello");
    expect(appendBotSignature("hello", null, 123, "none")).toBe("hello");
  });
});
