import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: any, cb: Function) => {
    // Simulate ffmpeg found
    if (cmd.includes("ffmpeg")) {
      cb(null, "ffmpeg version 6.0", "");
    } else {
      cb(new Error("not found"), "", "");
    }
  }),
}));

import { isWindows, getHomeDir, getQQBotDataDir, detectFfmpeg } from "../utils/platform.js";

describe("platform", () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform });
  });

  describe("isWindows", () => {
    it("returns true on win32 platform", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(isWindows()).toBe(true);
    });

    it("returns false on linux platform", () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(isWindows()).toBe(false);
    });

    it("returns false on darwin platform", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      expect(isWindows()).toBe(false);
    });
  });

  describe("getHomeDir", () => {
    it("returns a non-empty string", () => {
      const home = getHomeDir();
      expect(home).toBeTruthy();
      expect(typeof home).toBe("string");
    });
  });

  describe("getQQBotDataDir", () => {
    it("returns a path containing .openclaw and napcat-qq", () => {
      const dir = getQQBotDataDir("data");
      expect(dir).toContain(".openclaw");
      expect(dir).toContain("napcat-qq");
      expect(dir).toContain("data");
    });

    it("supports nested sub-paths", () => {
      const dir = getQQBotDataDir("data", "subdir", "nested");
      expect(dir).toContain("subdir");
      expect(dir).toContain("nested");
    });

    it("creates directory if it does not exist", () => {
      // This test verifies the function doesn't throw when creating dirs
      expect(() => getQQBotDataDir("test-dir")).not.toThrow();
    });
  });

  describe("detectFfmpeg", () => {
    it("returns a string or null", async () => {
      const result = await detectFfmpeg();
      expect(result === null || typeof result === "string").toBe(true);
    });
  });
});
