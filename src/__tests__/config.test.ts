import { describe, it, expect } from "vitest";
import { QQConfigSchema, resolvePassiveModeTemperature } from "../config.js";

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

    it("rejects temperature above 100", () => {
      expect(
        QQConfigSchema.safeParse({ passiveMode: { temperature: 101 } }).success,
      ).toBe(false);
    });

    it("rejects temperature below 0", () => {
      expect(
        QQConfigSchema.safeParse({ passiveMode: { temperature: -1 } }).success,
      ).toBe(false);
    });

    it("rejects non-integer temperature (0.5)", () => {
      expect(
        QQConfigSchema.safeParse({ passiveMode: { temperature: 0.5 } }).success,
      ).toBe(false);
    });

    it("accepts temperature=0", () => {
      expect(
        QQConfigSchema.safeParse({ passiveMode: { temperature: 0 } }).success,
      ).toBe(true);
    });

    it("accepts temperature=100", () => {
      expect(
        QQConfigSchema.safeParse({ passiveMode: { temperature: 100 } }).success,
      ).toBe(true);
    });
  });
});

// ── resolvePassiveModeTemperature ───────────────────────────────────────────

describe("resolvePassiveModeTemperature", () => {
  it("returns null for undefined", () => {
    expect(resolvePassiveModeTemperature(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(resolvePassiveModeTemperature(null)).toBeNull();
  });

  describe("boundary values", () => {
    it("temperature=0 → quietest (cooldown=60s, minInterval=120s, botSuppression=300s)", () => {
      const result = resolvePassiveModeTemperature(0);
      expect(result).toEqual({
        cooldownMs: 60_000,
        minIntervalMs: 120_000,
        botSuppressionMs: 300_000,
      });
    });

    it("temperature=100 → most active (cooldown=2s, minInterval=5s, botSuppression=30s)", () => {
      const result = resolvePassiveModeTemperature(100);
      expect(result).toEqual({
        cooldownMs: 2_000,
        minIntervalMs: 5_000,
        botSuppressionMs: 30_000,
      });
    });
  });

  describe("midpoint", () => {
    it("temperature=50 matches defaults (cooldown=10s, minInterval=30s, botSuppression=120s)", () => {
      const result = resolvePassiveModeTemperature(50);
      expect(result).toEqual({
        cooldownMs: 10_000,
        minIntervalMs: 30_000,
        botSuppressionMs: 120_000,
      });
    });
  });

  describe("clamping", () => {
    it("clamps value above 100 to 100", () => {
      const result = resolvePassiveModeTemperature(150);
      expect(result).toEqual({
        cooldownMs: 2_000,
        minIntervalMs: 5_000,
        botSuppressionMs: 30_000,
      });
    });

    it("clamps value below 0 to 0", () => {
      const result = resolvePassiveModeTemperature(-50);
      expect(result).toEqual({
        cooldownMs: 60_000,
        minIntervalMs: 120_000,
        botSuppressionMs: 300_000,
      });
    });
  });

  describe("linear interpolation", () => {
    it("temperature=25 interpolates correctly (0–50 segment)", () => {
      // cooldown: 60000 + (10000 - 60000) * 0.5 = 60000 - 25000 = 35000
      // minInterval: 120000 + (30000 - 120000) * 0.5 = 120000 - 45000 = 75000
      // botSuppression: 300000 + (120000 - 300000) * 0.5 = 300000 - 90000 = 210000
      const result = resolvePassiveModeTemperature(25);
      expect(result).toEqual({
        cooldownMs: 35_000,
        minIntervalMs: 75_000,
        botSuppressionMs: 210_000,
      });
    });

    it("temperature=75 interpolates correctly (50–100 segment)", () => {
      // cooldown: 10000 + (2000 - 10000) * 0.5 = 10000 - 4000 = 6000
      // minInterval: 30000 + (5000 - 30000) * 0.5 = 30000 - 12500 = 17500
      // botSuppression: 120000 + (30000 - 120000) * 0.5 = 120000 - 45000 = 75000
      const result = resolvePassiveModeTemperature(75);
      expect(result).toEqual({
        cooldownMs: 6_000,
        minIntervalMs: 17_500,
        botSuppressionMs: 75_000,
      });
    });
  });
});
