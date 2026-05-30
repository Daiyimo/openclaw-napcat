import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock https module ───────────────────────────────────────────────────────

let mockResponse: any = null;
let mockError: Error | null = null;

vi.mock("node:https", () => ({
  default: {
    get: vi.fn((_url: string, _opts: any, cb: Function) => {
      const res = {
        statusCode: mockError ? 500 : 200,
        on: vi.fn((event: string, handler: Function) => {
          if (event === "data") handler(JSON.stringify(mockResponse));
          if (event === "end") handler();
        }),
        resume: vi.fn(),
      };
      cb(res);
      return {
        on: vi.fn((event: string, handler: Function) => {
          if (event === "error" && mockError) handler(mockError);
        }),
        destroy: vi.fn(),
      };
    }),
  },
}));

vi.mock("../utils/pkg-version.js", () => ({
  getPackageVersion: vi.fn(() => "1.7.1"),
}));

import { getUpdateInfo, triggerUpdateCheck } from "../update-checker.js";

describe("update-checker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockError = null;
  });

  describe("getUpdateInfo", () => {
    it("detects available update when latest > current", async () => {
      mockResponse = { "dist-tags": { latest: "2.0.0" } };
      const info = await getUpdateInfo();
      expect(info.current).toBe("1.7.1");
      expect(info.latest).toBe("2.0.0");
      expect(info.hasUpdate).toBe(true);
    });

    it("reports no update when latest == current", async () => {
      mockResponse = { "dist-tags": { latest: "1.7.1" } };
      const info = await getUpdateInfo();
      expect(info.hasUpdate).toBe(false);
    });

    it("reports no update when latest < current", async () => {
      mockResponse = { "dist-tags": { latest: "1.0.0" } };
      const info = await getUpdateInfo();
      expect(info.hasUpdate).toBe(false);
    });

    it("includes stable and alpha dist-tags", async () => {
      mockResponse = { "dist-tags": { latest: "1.8.0", alpha: "2.0.0-alpha.1" } };
      const info = await getUpdateInfo();
      expect(info.stable).toBe("1.8.0");
      expect(info.alpha).toBe("2.0.0-alpha.1");
    });

    it("handles registry failure gracefully", async () => {
      mockError = new Error("network error");
      const info = await getUpdateInfo();
      expect(info.hasUpdate).toBe(false);
      expect(info.error).toBeDefined();
      expect(info.latest).toBeNull();
    });

    it("handles malformed response (no dist-tags)", async () => {
      mockResponse = { name: "@openclaw/qq" };
      const info = await getUpdateInfo();
      expect(info.hasUpdate).toBe(false);
    });

    it("includes checkedAt timestamp", async () => {
      mockResponse = { "dist-tags": { latest: "1.7.1" } };
      const before = Date.now();
      const info = await getUpdateInfo();
      expect(info.checkedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("triggerUpdateCheck", () => {
    it("runs without throwing", () => {
      mockResponse = { "dist-tags": { latest: "1.7.1" } };
      expect(() => triggerUpdateCheck()).not.toThrow();
    });

    it("uses provided logger", async () => {
      mockResponse = { "dist-tags": { latest: "2.0.0" } };
      const log = {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      triggerUpdateCheck(log);
      // Wait for the async operation
      await new Promise(r => setTimeout(r, 50));
      expect(log.info).toHaveBeenCalled();
    });
  });
});
