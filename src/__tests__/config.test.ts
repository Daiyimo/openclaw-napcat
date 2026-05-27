import { describe, it, expect } from "vitest";
import { QQConfigSchema } from "../config.js";

describe("QQConfigSchema", () => {
  // ── 有效配置 ────────────────────────────────────────────────────────────

  describe("valid configs", () => {
    it("accepts empty config and applies all defaults", () => {
      const result = QQConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.requireMention).toBe(true);
      expect(result.data.enableDeduplication).toBe(true);
      expect(result.data.maxMessageLength).toBe(4000);
      expect(result.data.historyLimit).toBe(5);
      expect(result.data.rateLimitMs).toBe(1000);
      expect(result.data.markdownMode).toBe("passthrough");
      expect(result.data.logBufferSize).toBe(200);
      expect(result.data.inboundRateLimitMs).toBe(0);
      expect(result.data.formatMarkdown).toBe(false);
      expect(result.data.antiRiskMode).toBe(false);
      expect(result.data.enableTTS).toBe(false);
      expect(result.data.enableSTT).toBe(false);
      expect(result.data.enableReactions).toBe(true);
      expect(result.data.autoMarkRead).toBe(false);
      expect(result.data.autoApproveRequests).toBe(false);
      expect(result.data.enableErrorNotify).toBe(true);
      expect(result.data.enableUpdateCheck).toBe(true);
      expect(result.data.enableGuilds).toBe(true);
    });

    it("accepts complete valid config", () => {
      const result = QQConfigSchema.safeParse({
        wsUrl: "ws://localhost:3001",
        httpUrl: "http://localhost:3000",
        reverseWsPort: 3002,
        accessToken: "secret",
        admins: [12345678],
        requireMention: false,
        maxMessageLength: 500,
        historyLimit: 10,
        markdownMode: "strip",
        rateLimitMs: 2000,
        allowedGroups: [111111, 222222],
        blockedUsers: [999999],
        deliverDebounce: { enabled: true, windowMs: 2000, maxWaitMs: 10000 },
      });
      expect(result.success).toBe(true);
    });

    it("accepts markdownMode: native", () => {
      expect(QQConfigSchema.safeParse({ markdownMode: "native" }).success).toBe(true);
    });

    it("accepts markdownMode: strip", () => {
      expect(QQConfigSchema.safeParse({ markdownMode: "strip" }).success).toBe(true);
    });

    it("accepts markdownMode: passthrough", () => {
      expect(QQConfigSchema.safeParse({ markdownMode: "passthrough" }).success).toBe(true);
    });
  });

  // ── 无效配置 ────────────────────────────────────────────────────────────

  describe("invalid configs", () => {
    it("rejects non-URL wsUrl", () => {
      expect(QQConfigSchema.safeParse({ wsUrl: "not-a-url" }).success).toBe(false);
    });

    it("rejects non-URL httpUrl", () => {
      // "localhost:3000" is accepted by WHATWG URL (scheme=localhost, path=3000)
      // use a genuinely invalid value: no host after ://
      expect(QQConfigSchema.safeParse({ httpUrl: "http://" }).success).toBe(false);
    });

    it("rejects reverseWsPort below 1", () => {
      expect(QQConfigSchema.safeParse({ reverseWsPort: 0 }).success).toBe(false);
    });

    it("rejects reverseWsPort above 65535", () => {
      expect(QQConfigSchema.safeParse({ reverseWsPort: 65536 }).success).toBe(false);
    });

    it("rejects maxMessageLength below 100", () => {
      expect(QQConfigSchema.safeParse({ maxMessageLength: 50 }).success).toBe(false);
    });

    it("rejects maxMessageLength above 10000", () => {
      expect(QQConfigSchema.safeParse({ maxMessageLength: 10001 }).success).toBe(false);
    });

    it("rejects invalid markdownMode value", () => {
      expect(QQConfigSchema.safeParse({ markdownMode: "invalid" }).success).toBe(false);
    });

    it("rejects historyLimit above 100", () => {
      expect(QQConfigSchema.safeParse({ historyLimit: 101 }).success).toBe(false);
    });

    it("rejects historyLimit below 0", () => {
      expect(QQConfigSchema.safeParse({ historyLimit: -1 }).success).toBe(false);
    });

    it("rejects rateLimitMs above 60000", () => {
      expect(QQConfigSchema.safeParse({ rateLimitMs: 60001 }).success).toBe(false);
    });

    it("rejects inboundRateLimitMs below 0", () => {
      expect(QQConfigSchema.safeParse({ inboundRateLimitMs: -1 }).success).toBe(false);
    });

    it("rejects logBufferSize below 10", () => {
      expect(QQConfigSchema.safeParse({ logBufferSize: 9 }).success).toBe(false);
    });

    it("rejects logBufferSize above 10000", () => {
      expect(QQConfigSchema.safeParse({ logBufferSize: 10001 }).success).toBe(false);
    });

    it("rejects deliverDebounce.windowMs below 100", () => {
      expect(
        QQConfigSchema.safeParse({ deliverDebounce: { windowMs: 50 } }).success,
      ).toBe(false);
    });

    it("rejects deliverDebounce.windowMs above 30000", () => {
      expect(
        QQConfigSchema.safeParse({ deliverDebounce: { windowMs: 30001 } }).success,
      ).toBe(false);
    });

    it("rejects deliverDebounce.maxWaitMs below 1000", () => {
      expect(
        QQConfigSchema.safeParse({ deliverDebounce: { maxWaitMs: 999 } }).success,
      ).toBe(false);
    });

    it("rejects admins containing 0", () => {
      expect(QQConfigSchema.safeParse({ admins: [0] }).success).toBe(false);
    });

    it("rejects admins containing negative number", () => {
      expect(QQConfigSchema.safeParse({ admins: [-1] }).success).toBe(false);
    });

    it("rejects allowedGroups containing non-positive integer", () => {
      expect(QQConfigSchema.safeParse({ allowedGroups: [0] }).success).toBe(false);
    });

    it("rejects silentKeywords containing empty string", () => {
      expect(QQConfigSchema.safeParse({ silentKeywords: [""] }).success).toBe(false);
    });
  });
});
