import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";

// vi.mock 必须在 import 之前（vitest 会将其提升到顶部）
vi.mock("../utils/pkg-version.js", () => ({
  getPackageVersion: vi.fn().mockReturnValue("1.7.0"),
}));

vi.mock("../update-checker.js", () => ({
  getUpdateInfo: vi.fn().mockResolvedValue({ hasUpdate: false, latest: "1.7.0", error: null }),
}));

vi.mock("../log-buffer.js", () => ({
  getRecentLogs: vi.fn().mockReturnValue([]),
  formatLogEntry: vi.fn().mockImplementation((e: unknown) => `entry:${String(e)}`),
}));

import { handleAdminCommand } from "../admin-commands.js";
import { getRecentLogs } from "../log-buffer.js";

// ── Mock client factory ───────────────────────────────────────────────────

function makeMockClient(): OneBotClient {
  return {
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
    setGroupBan: vi.fn(),
    setGroupKick: vi.fn(),
    getSelfId: vi.fn().mockReturnValue(10000),
  } as unknown as OneBotClient;
}

describe("handleAdminCommand", () => {
  let client: OneBotClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeMockClient();
    vi.clearAllMocks();
    // Re-apply mock return values after clearAllMocks
    vi.mocked(getRecentLogs).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── /ping ───────────────────────────────────────────────────────────────

  describe("/ping", () => {
    it("reports exact latency in ms when eventTime is provided", async () => {
      vi.setSystemTime(1_000_100);

      const result = await handleAdminCommand("/ping", ["/ping"], {
        client,
        isGroup: false,
        userId: 123456,
        text: "/ping",
        eventTime: 1_000_000,
      });

      expect(result).toBe(true);
      expect(client.sendPrivateMsg).toHaveBeenCalledWith(123456, "🏓 Pong! 延迟: 100ms");
    });

    it("reports 未知 when eventTime is absent", async () => {
      const result = await handleAdminCommand("/ping", ["/ping"], {
        client,
        isGroup: false,
        userId: 123456,
        text: "/ping",
      });

      expect(result).toBe(true);
      expect(client.sendPrivateMsg).toHaveBeenCalledWith(123456, "🏓 Pong! 延迟: 未知");
    });

    it("replies to group channel when isGroup is true", async () => {
      await handleAdminCommand("/ping", ["/ping"], {
        client,
        isGroup: true,
        groupId: 88888888,
        text: "/ping",
      });

      expect(client.sendGroupMsg).toHaveBeenCalledWith(
        88888888,
        expect.stringContaining("Pong"),
      );
      expect(client.sendPrivateMsg).not.toHaveBeenCalled();
    });
  });

  // ── /logs ───────────────────────────────────────────────────────────────

  describe("/logs", () => {
    it("returns 暂无日志 when log buffer is empty", async () => {
      vi.mocked(getRecentLogs).mockReturnValue([]);

      await handleAdminCommand("/logs", ["/logs"], {
        client,
        isGroup: false,
        userId: 1,
        text: "/logs",
      });

      expect(client.sendPrivateMsg).toHaveBeenCalledWith(1, "[logs] 暂无日志");
    });

    it("requests default 20 logs when no count provided", async () => {
      await handleAdminCommand("/logs", ["/logs"], {
        client, isGroup: false, userId: 1, text: "/logs",
      });
      expect(getRecentLogs).toHaveBeenCalledWith(20);
    });

    it("requests specified number of logs", async () => {
      await handleAdminCommand("/logs", ["/logs", "50"], {
        client, isGroup: false, userId: 1, text: "/logs 50",
      });
      expect(getRecentLogs).toHaveBeenCalledWith(50);
    });

    it("caps log count at 100 for large numbers", async () => {
      await handleAdminCommand("/logs", ["/logs", "200"], {
        client, isGroup: false, userId: 1, text: "/logs 200",
      });
      expect(getRecentLogs).toHaveBeenCalledWith(100);
    });

    it("falls back to 20 for non-numeric count", async () => {
      await handleAdminCommand("/logs", ["/logs", "abc"], {
        client, isGroup: false, userId: 1, text: "/logs abc",
      });
      expect(getRecentLogs).toHaveBeenCalledWith(20);
    });

    it("formats and sends log entries", async () => {
      vi.mocked(getRecentLogs).mockReturnValue(["entry1", "entry2"] as any);

      await handleAdminCommand("/logs", ["/logs"], {
        client, isGroup: false, userId: 1, text: "/logs",
      });

      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("最近 2 条日志");
    });
  });

  // ── /help ───────────────────────────────────────────────────────────────

  describe("/help", () => {
    it("returns help text containing all commands", async () => {
      await handleAdminCommand("/help", ["/help"], {
        client, isGroup: false, userId: 1, text: "/help",
      });

      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("/status");
      expect(reply).toContain("/ping");
      expect(reply).toContain("/version");
      expect(reply).toContain("/logs");
      expect(reply).toContain("/mute");
      expect(reply).toContain("/kick");
      expect(reply).toContain("/help");
    });

    it("returns true", async () => {
      const result = await handleAdminCommand("/help", ["/help"], {
        client, isGroup: false, userId: 1, text: "/help",
      });
      expect(result).toBe(true);
    });
  });

  // ── /mute ───────────────────────────────────────────────────────────────

  describe("/mute", () => {
    it("bans @mentioned user in group for default 30 minutes", async () => {
      const message: OneBotMessage = [
        { type: "at", data: { qq: "987654" } } as any,
      ];

      await handleAdminCommand("/mute", ["/mute"], {
        client, isGroup: true, groupId: 100001, userId: 1,
        text: "/mute", message,
      });

      expect(client.setGroupBan).toHaveBeenCalledWith(100001, 987654, 30 * 60);
      expect(client.sendGroupMsg).toHaveBeenCalledWith(
        100001, expect.stringContaining("987654"),
      );
    });

    it("bans for specified minutes", async () => {
      const message: OneBotMessage = [
        { type: "at", data: { qq: "111" } } as any,
      ];

      // parts[2] 是时长；parts[1] 是文本中的 @目标占位（AT 段另行解析）
      await handleAdminCommand("/mute", ["/mute", "@111", "60"], {
        client, isGroup: true, groupId: 100001, userId: 1,
        text: "/mute @111 60", message,
      });

      expect(client.setGroupBan).toHaveBeenCalledWith(100001, 111, 60 * 60);
    });

    it("falls back to CQ code @target parsing from text", async () => {
      await handleAdminCommand("/mute", ["/mute"], {
        client, isGroup: true, groupId: 100001, userId: 1,
        text: "/mute [CQ:at,qq=55555]",
        message: "/mute [CQ:at,qq=55555]",
      });

      expect(client.setGroupBan).toHaveBeenCalledWith(100001, 55555, 30 * 60);
    });

    it("replies with usage hint when no target provided", async () => {
      await handleAdminCommand("/mute", ["/mute"], {
        client, isGroup: true, groupId: 100001, userId: 1, text: "/mute",
      });

      expect(client.setGroupBan).not.toHaveBeenCalled();
      expect(client.sendGroupMsg).toHaveBeenCalledWith(
        100001, expect.stringContaining("用法"),
      );
    });

    it("does nothing outside group chat", async () => {
      await handleAdminCommand("/mute", ["/mute"], {
        client, isGroup: false, userId: 1, text: "/mute",
      });

      expect(client.setGroupBan).not.toHaveBeenCalled();
    });

    it("handles /ban alias identically to /mute", async () => {
      const message: OneBotMessage = [
        { type: "at", data: { qq: "222" } } as any,
      ];

      await handleAdminCommand("/ban", ["/ban"], {
        client, isGroup: true, groupId: 100001, userId: 1,
        text: "/ban", message,
      });

      expect(client.setGroupBan).toHaveBeenCalledWith(100001, 222, 30 * 60);
    });
  });

  // ── /kick ───────────────────────────────────────────────────────────────

  describe("/kick", () => {
    it("kicks @mentioned user in group", async () => {
      const message: OneBotMessage = [
        { type: "at", data: { qq: "777777" } } as any,
      ];

      await handleAdminCommand("/kick", ["/kick"], {
        client, isGroup: true, groupId: 100001, userId: 1,
        text: "/kick", message,
      });

      expect(client.setGroupKick).toHaveBeenCalledWith(100001, 777777);
      expect(client.sendGroupMsg).toHaveBeenCalledWith(
        100001, expect.stringContaining("777777"),
      );
    });

    it("replies with usage hint when no target", async () => {
      await handleAdminCommand("/kick", ["/kick"], {
        client, isGroup: true, groupId: 100001, userId: 1, text: "/kick",
      });

      expect(client.setGroupKick).not.toHaveBeenCalled();
      expect(client.sendGroupMsg).toHaveBeenCalledWith(
        100001, expect.stringContaining("用法"),
      );
    });

    it("does nothing outside group chat", async () => {
      await handleAdminCommand("/kick", ["/kick"], {
        client, isGroup: false, userId: 1, text: "/kick",
      });

      expect(client.setGroupKick).not.toHaveBeenCalled();
    });
  });

  // ── 未知命令 ────────────────────────────────────────────────────────────

  it("returns false for unknown command and does not reply", async () => {
    const result = await handleAdminCommand("/unknown", ["/unknown"], {
      client, isGroup: false, userId: 1, text: "/unknown",
    });

    expect(result).toBe(false);
    expect(client.sendPrivateMsg).not.toHaveBeenCalled();
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });
});
