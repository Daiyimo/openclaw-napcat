import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock modules ────────────────────────────────────────────────────────────

vi.mock("node:fs", () => {
  const store = new Map<string, string>();
  return {
    default: {
      existsSync: vi.fn((p: string) => store.has(p)),
      readFileSync: vi.fn((p: string) => store.get(p) || ""),
      writeFileSync: vi.fn((p: string, data: string) => { store.set(p, data); }),
      renameSync: vi.fn((old: string, nw: string) => {
        const data = store.get(old);
        if (data) { store.set(nw, data); store.delete(old); }
      }),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn((p: string) => store.has(p)),
    readFileSync: vi.fn((p: string) => store.get(p) || ""),
    writeFileSync: vi.fn((p: string, data: string) => { store.set(p, data); }),
    renameSync: vi.fn((old: string, nw: string) => {
      const data = store.get(old);
      if (data) { store.set(nw, data); store.delete(old); }
    }),
    mkdirSync: vi.fn(),
  };
});

vi.mock("../utils/platform.js", () => ({
  getQQBotDataDir: vi.fn(() => "/mock/data"),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  recordKnownUser,
  getKnownUser,
  listKnownUsers,
  getKnownUsersStats,
  flushKnownUsers,
} from "../known-users.js";

describe("known-users", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("recordKnownUser", () => {
    it("records a new private user", () => {
      recordKnownUser({
        openid: "ku-10001",
        type: "private",
        nickname: "Alice",
        accountId: "acct-a",
      });
      const user = getKnownUser("acct-a", "ku-10001", "private");
      expect(user).toBeDefined();
      expect(user!.openid).toBe("ku-10001");
      expect(user!.type).toBe("private");
      expect(user!.nickname).toBe("Alice");
      expect(user!.interactionCount).toBe(1);
    });

    it("records a new group user", () => {
      recordKnownUser({
        openid: "ku-10002",
        type: "group",
        nickname: "Bob",
        groupId: 11111,
        accountId: "acct-b",
      });
      const user = getKnownUser("acct-b", "ku-10002", "group", 11111);
      expect(user).toBeDefined();
      expect(user!.groupId).toBe(11111);
    });

    it("increments interaction count for existing user", () => {
      recordKnownUser({ openid: "ku-10003", type: "private", accountId: "acct-c" });
      recordKnownUser({ openid: "ku-10003", type: "private", accountId: "acct-c" });
      recordKnownUser({ openid: "ku-10003", type: "private", accountId: "acct-c" });
      const user = getKnownUser("acct-c", "ku-10003", "private");
      expect(user!.interactionCount).toBe(3);
    });

    it("updates nickname when changed", () => {
      recordKnownUser({ openid: "ku-10004", type: "private", nickname: "Old", accountId: "acct-d" });
      recordKnownUser({ openid: "ku-10004", type: "private", nickname: "New", accountId: "acct-d" });
      const user = getKnownUser("acct-d", "ku-10004", "private");
      expect(user!.nickname).toBe("New");
    });

    it("does not overwrite nickname with undefined", () => {
      recordKnownUser({ openid: "ku-10005", type: "private", nickname: "Alice", accountId: "acct-e" });
      recordKnownUser({ openid: "ku-10005", type: "private", accountId: "acct-e" });
      const user = getKnownUser("acct-e", "ku-10005", "private");
      expect(user!.nickname).toBe("Alice");
    });
  });

  describe("getKnownUser", () => {
    it("returns undefined for non-existent user", () => {
      expect(getKnownUser("acct-none", "ku-nonexistent", "private")).toBeUndefined();
    });
  });

  describe("listKnownUsers", () => {
    it("lists all users when no filter", () => {
      const before = listKnownUsers().length;
      recordKnownUser({ openid: "ku-list-1", type: "private", accountId: "acct-list" });
      recordKnownUser({ openid: "ku-list-2", type: "group", groupId: 200, accountId: "acct-list" });
      const users = listKnownUsers();
      expect(users.length).toBeGreaterThanOrEqual(before + 2);
    });

    it("filters by accountId", () => {
      recordKnownUser({ openid: "ku-filter-1", type: "private", accountId: "acct-filter" });
      const users = listKnownUsers({ accountId: "acct-filter" });
      expect(users.every(u => u.accountId === "acct-filter")).toBe(true);
    });

    it("filters by type", () => {
      const users = listKnownUsers({ type: "guild" });
      expect(users.every(u => u.type === "guild")).toBe(true);
    });

    it("applies limit", () => {
      const users = listKnownUsers({ limit: 1 });
      expect(users).toHaveLength(1);
    });

    it("sorts by lastSeenAt descending by default", () => {
      const users = listKnownUsers();
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].lastSeenAt).toBeGreaterThanOrEqual(users[i].lastSeenAt);
      }
    });

    it("supports ascending sort", () => {
      const users = listKnownUsers({ sortBy: "firstSeenAt", sortOrder: "asc", limit: 5 });
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].firstSeenAt).toBeLessThanOrEqual(users[i].firstSeenAt);
      }
    });
  });

  describe("getKnownUsersStats", () => {
    it("returns stats for a specific account", () => {
      recordKnownUser({ openid: "ku-stat-1", type: "private", accountId: "acct-stat" });
      recordKnownUser({ openid: "ku-stat-2", type: "group", groupId: 300, accountId: "acct-stat" });
      const stats = getKnownUsersStats("acct-stat");
      expect(stats.totalUsers).toBeGreaterThanOrEqual(2);
      expect(stats.privateUsers).toBeGreaterThanOrEqual(1);
      expect(stats.groupUsers).toBeGreaterThanOrEqual(1);
    });

    it("counts active users in 24h", () => {
      const stats = getKnownUsersStats("acct-stat");
      expect(stats.activeIn24h).toBeGreaterThanOrEqual(2);
    });

    it("counts active users in 7d", () => {
      const stats = getKnownUsersStats("acct-stat");
      expect(stats.activeIn7d).toBeGreaterThanOrEqual(2);
    });
  });

  describe("flushKnownUsers", () => {
    it("saves to file without throwing", () => {
      recordKnownUser({ openid: "ku-flush-1", type: "private", accountId: "acct-flush" });
      expect(() => flushKnownUsers()).not.toThrow();
    });
  });
});
