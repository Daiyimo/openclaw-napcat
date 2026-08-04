import { describe, it, expect } from "vitest";
import {
  maskId,
  maskUrl,
  maskIdsInText,
  maskBearerToken,
  maskSecretsInText,
} from "../utils/log-sanitize.js";

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

// maskSecretsInText 保护 /logs：日志缓冲区含 openclaw 内核与其他插件的输出，
// 仅脱敏 QQ 号不足以阻止 API key 被发进 QQ 会话。
describe("maskSecretsInText", () => {
  it("redacts Bearer tokens", () => {
    const out = maskSecretsInText("Authorization: Bearer abc123DEF456ghi");
    expect(out).not.toContain("abc123DEF456ghi");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts Authorization header inside JSON", () => {
    const out = maskSecretsInText('{"Authorization": "Bearer sometokenvalue123"}');
    expect(out).not.toContain("sometokenvalue123");
  });

  it("redacts OpenAI/Anthropic style sk- keys", () => {
    const out = maskSecretsInText("key=sk-ant-api03-AbCdEfGhIjKlMnOp");
    expect(out).not.toContain("AbCdEfGhIjKlMnOp");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub personal access tokens", () => {
    const out = maskSecretsInText("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
  });

  it("redacts github_pat_ tokens", () => {
    const out = maskSecretsInText("github_pat_11ABCDEFG0123456789_abcdefg");
    expect(out).not.toContain("11ABCDEFG0123456789_abcdefg");
  });

  it("redacts access_token=value form", () => {
    const out = maskSecretsInText("access_token=s3cr3tvalue123");
    expect(out).not.toContain("s3cr3tvalue123");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts api_key and password fields case-insensitively", () => {
    const out = maskSecretsInText('API_KEY: "MySecretKey123" password=Hunter2xyz');
    expect(out).not.toContain("MySecretKey123");
    expect(out).not.toContain("Hunter2xyz");
  });

  it("leaves ordinary log lines untouched", () => {
    const line = "[napcat-QQ] connected to gateway, 3 groups registered";
    expect(maskSecretsInText(line)).toBe(line);
  });

  it("does not redact short non-secret values", () => {
    // 6 字符下限：避免把 "token=on" 这类开关值也吞掉
    expect(maskSecretsInText("token=on")).toBe("token=on");
  });

  it("composes with maskIdsInText without leaking either", () => {
    const out = maskSecretsInText(maskIdsInText("user 123456789 key=sk-abcdefghijklmn"));
    expect(out).not.toContain("123456789");
    expect(out).not.toContain("abcdefghijklmn");
  });
});

describe("maskBearerToken (existing behavior)", () => {
  it("keeps the Bearer prefix while redacting the value", () => {
    expect(maskBearerToken("Bearer abcdef123456")).toBe("Bearer [REDACTED]");
  });

  it("returns text unchanged when no bearer token present", () => {
    expect(maskBearerToken("no credentials here")).toBe("no credentials here");
  });
});
