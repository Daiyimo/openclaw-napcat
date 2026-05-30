import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UploadCache } from "../upload-cache.js";

describe("UploadCache", () => {
  let cache: UploadCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new UploadCache();
  });

  afterEach(() => {
    cache.dispose();
    vi.useRealTimers();
  });

  describe("buildKey", () => {
    it("combines accountId and filePath", () => {
      expect(cache.buildKey("acct1", "/path/to/file")).toBe("acct1:/path/to/file");
    });
  });

  describe("get/set", () => {
    it("returns null for missing key", () => {
      expect(cache.get("nonexistent")).toBeNull();
    });

    it("returns stored fileId", () => {
      cache.set("key1", "file-id-123");
      expect(cache.get("key1")).toBe("file-id-123");
    });

    it("returns null for expired entry", () => {
      cache.set("key1", "file-id", 1000);
      vi.advanceTimersByTime(1001);
      expect(cache.get("key1")).toBeNull();
    });

    it("returns entry just before expiry", () => {
      cache.set("key1", "file-id", 1000);
      vi.advanceTimersByTime(999);
      expect(cache.get("key1")).toBe("file-id");
    });

    it("supports custom TTL", () => {
      cache.set("key1", "id1", 5000);
      vi.advanceTimersByTime(4999);
      expect(cache.get("key1")).toBe("id1");
      vi.advanceTimersByTime(2);
      expect(cache.get("key1")).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("removes expired entries", () => {
      cache.set("expired", "id1", 1000);
      cache.set("alive", "id2", 5000);
      vi.advanceTimersByTime(1001);
      cache.cleanup();
      expect(cache.get("expired")).toBeNull();
      expect(cache.get("alive")).toBe("id2");
    });

    it("handles empty cache", () => {
      expect(() => cache.cleanup()).not.toThrow();
    });
  });

  describe("dispose", () => {
    it("clears all entries and stops timer", () => {
      cache.set("key1", "id1");
      cache.set("key2", "id2");
      expect(cache.size).toBe(2);
      cache.dispose();
      expect(cache.size).toBe(0);
    });
  });

  describe("size", () => {
    it("returns number of entries", () => {
      expect(cache.size).toBe(0);
      cache.set("a", "1");
      expect(cache.size).toBe(1);
      cache.set("b", "2");
      expect(cache.size).toBe(2);
    });
  });

  describe("default TTL", () => {
    it("uses 30-minute default TTL", () => {
      cache.set("key", "id");
      vi.advanceTimersByTime(30 * 60 * 1000 - 1);
      expect(cache.get("key")).toBe("id");
      vi.advanceTimersByTime(2);
      expect(cache.get("key")).toBeNull();
    });
  });
});
