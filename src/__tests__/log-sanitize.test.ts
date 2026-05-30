import { describe, it, expect } from "vitest";
import { maskId, maskUrl, maskIdsInText } from "../utils/log-sanitize.js";

describe("maskId", () => {
  it("returns 'null' for undefined", () => {
    expect(maskId(undefined)).toBe("null");
  });

  it("returns 'null' for null", () => {
    expect(maskId(null)).toBe("null");
  });

  it("returns full string when length <= visiblePrefix", () => {
    expect(maskId("123")).toBe("123");
    expect(maskId("12")).toBe("12");
    expect(maskId("1")).toBe("1");
  });

  it("masks QQ number keeping first 3 digits by default", () => {
    expect(maskId("123456789")).toBe("123***");
  });

  it("masks numeric id", () => {
    expect(maskId(123456789)).toBe("123***");
  });

  it("supports custom visiblePrefix", () => {
    expect(maskId("123456789", 5)).toBe("12345***");
    expect(maskId("123456789", 1)).toBe("1***");
  });

  it("returns full string when exactly visiblePrefix length", () => {
    expect(maskId("123", 3)).toBe("123");
  });
});

describe("maskUrl", () => {
  it("masks standard URL keeping protocol and host", () => {
    const result = maskUrl("https://example.com/api/path?token=secret");
    expect(result).toBe("https://example.com/api/path");
  });

  it("truncates long pathname", () => {
    const longPath = "/a".repeat(30);
    const result = maskUrl(`https://example.com${longPath}`);
    expect(result.length).toBeLessThanOrEqual("https://example.com".length + 43); // 40 + "..."
    expect(result).toContain("...");
  });

  it("returns truncated string for non-standard URL", () => {
    const result = maskUrl("not-a-url-at-all");
    expect(result).toBe("not-a-url-at-all");
  });

  it("truncates very long non-standard URL", () => {
    const long = "x".repeat(100);
    const result = maskUrl(long);
    expect(result).toBe("x".repeat(40) + "...");
  });

  it("strips query string and fragment", () => {
    const result = maskUrl("https://host/path?q=1#frag");
    expect(result).toBe("https://host/path");
  });
});

describe("maskIdsInText", () => {
  it("masks 5-12 digit numbers in text", () => {
    expect(maskIdsInText("user 123456789 sent message")).toBe("user 123*** sent message");
  });

  it("does not mask short numbers (< 5 digits)", () => {
    expect(maskIdsInText("code 1234")).toBe("code 1234");
  });

  it("does not mask long numbers (> 12 digits)", () => {
    expect(maskIdsInText("id 1234567890123")).toBe("id 1234567890123");
  });

  it("masks multiple IDs in text", () => {
    const result = maskIdsInText("from 111111111 to 222222222");
    expect(result).toBe("from 111*** to 222***");
  });

  it("returns text unchanged when no IDs", () => {
    expect(maskIdsInText("hello world")).toBe("hello world");
  });
});
