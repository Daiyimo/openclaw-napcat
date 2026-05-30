import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock modules ────────────────────────────────────────────────────────────

vi.mock("../known-users.js", () => ({
  listKnownUsers: vi.fn().mockReturnValue([]),
  getKnownUsersStats: vi.fn().mockReturnValue({}),
}));

vi.mock("../message-parser.js", () => ({
  parseTarget: vi.fn((to: string) => ({ type: to.startsWith("group:") ? "group" : "private", id: to })),
  isImageFile: vi.fn((url: string) => /\.(jpg|jpeg|png|gif|webp)$/i.test(url)),
  dispatchMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
}));

import {
  sendProactive,
  sendBulkProactive,
  broadcastToKnownUsers,
  registerClientsMap,
} from "../proactive.js";
import { listKnownUsers } from "../known-users.js";
import { dispatchMessage } from "../message-parser.js";

function makeMockClient() {
  return {
    sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("proactive", () => {
  let clients: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    clients = new Map();
    registerClientsMap(clients as any);
  });

  describe("sendProactive", () => {
    it("fails when clients map not initialized", async () => {
      registerClientsMap(null as any);
      const result = await sendProactive({ to: "12345", text: "hi" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });

    it("fails when no client for account", async () => {
      clients.set("other", makeMockClient());
      const result = await sendProactive({ to: "12345", text: "hi", accountId: "missing" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No connected client");
    });

    it("sends text message successfully", async () => {
      clients.set("default", makeMockClient());
      const result = await sendProactive({ to: "12345", text: "hello" });
      expect(result.success).toBe(true);
      expect(dispatchMessage).toHaveBeenCalled();
    });

    it("fails when both text and mediaUrl are empty", async () => {
      clients.set("default", makeMockClient());
      const result = await sendProactive({ to: "12345", text: "", mediaUrl: "" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("不能同时为空");
    });

    it("sends image media with text", async () => {
      clients.set("default", makeMockClient());
      const result = await sendProactive({
        to: "12345",
        text: "check this",
        mediaUrl: "https://example.com/photo.jpg",
      });
      expect(result.success).toBe(true);
    });

    it("sends non-image file separately", async () => {
      clients.set("default", makeMockClient());
      const result = await sendProactive({
        to: "12345",
        text: "see file",
        mediaUrl: "https://example.com/doc.pdf",
      });
      expect(result.success).toBe(true);
      expect(dispatchMessage).toHaveBeenCalledTimes(2); // text + file
    });

    it("handles send error", async () => {
      const client = makeMockClient();
      clients.set("default", client);
      vi.mocked(dispatchMessage).mockRejectedValueOnce(new Error("send failed"));
      const result = await sendProactive({ to: "12345", text: "hi" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("send failed");
    });
  });

  describe("sendBulkProactive", () => {
    it("sends to all recipients with delay", async () => {
      clients.set("default", makeMockClient());
      const results = await sendBulkProactive(["111", "222", "333"], "broadcast");
      expect(results).toHaveLength(3);
      expect(results.every(r => r.result.success)).toBe(true);
    });

    it("returns results for each recipient", async () => {
      clients.set("default", makeMockClient());
      const results = await sendBulkProactive(["aaa", "bbb"], "msg");
      expect(results[0].to).toBe("aaa");
      expect(results[1].to).toBe("bbb");
    });
  });

  describe("broadcastToKnownUsers", () => {
    it("deduplicates same-group recipients", async () => {
      vi.mocked(listKnownUsers).mockReturnValue([
        { openid: "111", type: "group", groupId: 100, accountId: "default" } as any,
        { openid: "222", type: "group", groupId: 100, accountId: "default" } as any,
      ]);
      clients.set("default", makeMockClient());
      const result = await broadcastToKnownUsers("hello");
      // Should dedupe group:100 → only 1 send
      expect(result.sent).toBe(1);
    });

    it("reports sent/failed counts", async () => {
      vi.mocked(listKnownUsers).mockReturnValue([
        { openid: "111", type: "private", accountId: "default" } as any,
      ]);
      clients.set("default", makeMockClient());
      const result = await broadcastToKnownUsers("hi");
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
    });
  });
});
