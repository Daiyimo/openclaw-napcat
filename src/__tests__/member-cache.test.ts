import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCachedMemberName,
  setCachedMemberName,
  populateGroupMemberCache,
  clearMemberCache,
} from "../member-cache.js";

function makeMockClient(memberList: any[] = []) {
  return {
    getGroupMemberList: vi.fn().mockResolvedValue(memberList),
  } as any;
}

describe("member-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearMemberCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getCachedMemberName", () => {
    it("returns null for cache miss", () => {
      expect(getCachedMemberName("group1", "user1")).toBeNull();
    });

    it("returns cached name on hit", () => {
      setCachedMemberName("group1", "user1", "Alice");
      expect(getCachedMemberName("group1", "user1")).toBe("Alice");
    });

    it("returns null for expired entry", () => {
      setCachedMemberName("group1", "user1", "Alice");
      vi.advanceTimersByTime(3_600_001); // 1 hour + 1ms
      expect(getCachedMemberName("group1", "user1")).toBeNull();
    });

    it("returns entry just before expiry", () => {
      setCachedMemberName("group1", "user1", "Alice");
      vi.advanceTimersByTime(3_599_999);
      expect(getCachedMemberName("group1", "user1")).toBe("Alice");
    });
  });

  describe("setCachedMemberName", () => {
    it("stores name", () => {
      setCachedMemberName("g1", "u1", "Bob");
      expect(getCachedMemberName("g1", "u1")).toBe("Bob");
    });

    it("overwrites existing name", () => {
      setCachedMemberName("g1", "u1", "Old");
      setCachedMemberName("g1", "u1", "New");
      expect(getCachedMemberName("g1", "u1")).toBe("New");
    });
  });

  describe("populateGroupMemberCache", () => {
    it("populates cache from API response", async () => {
      const client = makeMockClient([
        { user_id: 111, card: "Admin", nickname: "AdminNick" },
        { user_id: 222, card: "", nickname: "RegularUser" },
        { user_id: 333, nickname: "NoCard" },
      ]);
      await populateGroupMemberCache(client, 999);
      expect(getCachedMemberName("999", "111")).toBe("Admin");
      expect(getCachedMemberName("999", "222")).toBe("RegularUser");
      expect(getCachedMemberName("999", "333")).toBe("NoCard");
    });

    it("skips re-fetch within TTL", async () => {
      const client = makeMockClient([{ user_id: 1, card: "A" }]);
      await populateGroupMemberCache(client, 100);
      expect(client.getGroupMemberList).toHaveBeenCalledTimes(1);
      await populateGroupMemberCache(client, 100);
      expect(client.getGroupMemberList).toHaveBeenCalledTimes(1);
    });

    it("re-fetches after TTL expires", async () => {
      const client = makeMockClient([{ user_id: 1, card: "A" }]);
      await populateGroupMemberCache(client, 100);
      vi.advanceTimersByTime(3_600_001);
      await populateGroupMemberCache(client, 100);
      expect(client.getGroupMemberList).toHaveBeenCalledTimes(2);
    });

    it("handles API failure gracefully", async () => {
      const client = {
        getGroupMemberList: vi.fn().mockRejectedValue(new Error("API error")),
      } as any;
      await expect(populateGroupMemberCache(client, 100)).rejects.toThrow("member cache load failed");
    });

    it("deduplicates concurrent requests for same group", async () => {
      const client = makeMockClient([{ user_id: 1, card: "A" }]);
      const p1 = populateGroupMemberCache(client, 200);
      const p2 = populateGroupMemberCache(client, 200);
      await Promise.all([p1, p2]);
      expect(client.getGroupMemberList).toHaveBeenCalledTimes(1);
    });

    it("rejects all waiters on API failure", async () => {
      const client = {
        getGroupMemberList: vi.fn().mockRejectedValue(new Error("API error")),
      } as any;
      const p1 = populateGroupMemberCache(client, 200);
      const p2 = populateGroupMemberCache(client, 200); // concurrent
      await expect(Promise.all([p1, p2])).rejects.toThrow("member cache load failed");
    });
  });

  describe("clearMemberCache", () => {
    it("clears all cached data", () => {
      setCachedMemberName("g1", "u1", "Alice");
      clearMemberCache();
      expect(getCachedMemberName("g1", "u1")).toBeNull();
    });
  });
});
