import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";
import { InboundRateLimiter } from "../rate-limiter.js";

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
import { initConfigRef } from "../config-watcher.js";
import { getQQConfigDefaults } from "../config.js";

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
    // Initialize configRef with defaults for sleep/temperature commands
    initConfigRef(getQQConfigDefaults());
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

  // ── /ratelimit ────────────────────────────────────────────────────────────

  describe("/ratelimit", () => {
    it("replies error when rateLimiter is absent", async () => {
      await handleAdminCommand("/ratelimit", ["/ratelimit"], {
        client, isGroup: false, userId: 1, text: "/ratelimit",
      });
      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("限流器未初始化");
    });

    it("shows no active limits with threshold when enabled", async () => {
      const limiter = new InboundRateLimiter({ windowMs: 10000, maxMessages: 5 });
      await handleAdminCommand("/ratelimit", ["/ratelimit"], {
        client, isGroup: false, userId: 1, text: "/ratelimit",
        rateLimiter: limiter,
      });
      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("当前无活跃限流");
      expect(reply).toContain("当前阈值");
      expect(reply).toContain("10s");
    });

    it("shows disabled status when windowMs is 0", async () => {
      const limiter = new InboundRateLimiter({ windowMs: 0, maxMessages: 5 });
      await handleAdminCommand("/ratelimit", ["/ratelimit"], {
        client, isGroup: false, userId: 1, text: "/ratelimit",
        rateLimiter: limiter,
      });
      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("禁用");
    });

    it("shows active limits with remaining cooldown", async () => {
      const limiter = new InboundRateLimiter({ windowMs: 10000, maxMessages: 2 });
      limiter.record("123");
      vi.advanceTimersByTime(100);
      limiter.record("123");
      vi.advanceTimersByTime(100);
      limiter.record("123");
      await handleAdminCommand("/ratelimit", ["/ratelimit"], {
        client, isGroup: false, userId: 1, text: "/ratelimit",
        rateLimiter: limiter,
      });
      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("活跃限流");
    });
  });

  // ── /unratelimit ──────────────────────────────────────────────────────────

  describe("/unratelimit", () => {
    it("replies error when rateLimiter is absent", async () => {
      await handleAdminCommand("/unratelimit", ["/unratelimit", "123"], {
        client, isGroup: false, userId: 1, text: "/unratelimit 123",
      });
      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("限流器未初始化");
    });

    it("clears user rate limit", async () => {
      const limiter = new InboundRateLimiter({ windowMs: 10000, maxMessages: 2 });
      limiter.record("999", "888");
      await handleAdminCommand("/unratelimit", ["/unratelimit", "user:999"], {
        client, isGroup: false, userId: 1, text: "/unratelimit user:999",
        rateLimiter: limiter,
      });
      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("已解除");
      expect(limiter.getActiveLimits()).toHaveLength(0);
    });

    it("replies with usage hint when no target provided", async () => {
      const limiter = new InboundRateLimiter({ windowMs: 10000, maxMessages: 2 });
      await handleAdminCommand("/unratelimit", ["/unratelimit"], {
        client, isGroup: false, userId: 1, text: "/unratelimit",
        rateLimiter: limiter,
      });
      expect(client.sendPrivateMsg).toHaveBeenCalledWith(1, expect.stringContaining("用法"));
    });

    it("replies not rate limited when target has no entry", async () => {
      const limiter = new InboundRateLimiter({ windowMs: 10000, maxMessages: 2 });
      await handleAdminCommand("/unratelimit", ["/unratelimit", "user:888"], {
        client, isGroup: false, userId: 1, text: "/unratelimit user:888",
        rateLimiter: limiter,
      });
      const reply = vi.mocked(client.sendPrivateMsg).mock.calls[0][1] as string;
      expect(reply).toContain("未被限流");
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

// ── 群管扩展（v1.10+） ─────────────────────────────────────────────────
//
// 覆盖新增的 ~25 个命令：成员管理、群资料、精华、查询、群文件、NapCat 扩展。
// 重点验证：调用了正确的 client 方法和参数 / 二次确认 / cwd 流转 / 边界提示。

import {
  _testReset as resetConfirmPending,
} from "../utils/confirm-pending.js";
import {
  _testReset as resetGroupFileCwd,
} from "../utils/group-file-cwd.js";

function makeFullClient(): OneBotClient {
  return {
    // 基础
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
    getSelfId: vi.fn().mockReturnValue(10000),
    // 现有
    setGroupBan: vi.fn(),
    setGroupKick: vi.fn(),
    sendGroupPoke: vi.fn(),
    // A 类原生群管
    setGroupAdmin: vi.fn(),
    setGroupWholeBan: vi.fn(),
    setGroupCard: vi.fn(),
    setGroupName: vi.fn(),
    setGroupSpecialTitle: vi.fn(),
    setGroupLeave: vi.fn(),
    setGroupKickMembers: vi.fn(),
    setEssenceMsg: vi.fn().mockResolvedValue(undefined),
    deleteEssenceMsg: vi.fn().mockResolvedValue(undefined),
    getEssenceMsgList: vi.fn().mockResolvedValue([]),
    getGroupShutList: vi.fn().mockResolvedValue([]),
    getGroupAtAllRemain: vi.fn().mockResolvedValue({ can_at_all: true, remain_at_all_count_for_group: 10, remain_at_all_count_for_uin: 5 }),
    getGroupHonorInfo: vi.fn().mockResolvedValue({ current_talkative: { nickname: "Top", day_count: 3 } }),
    getGroupInfo: vi.fn().mockResolvedValue({ group_id: 88888, group_name: "测试群", member_count: 50, max_member_count: 200 }),
    // B 类群文件
    getGroupRootFiles: vi.fn().mockResolvedValue({ folders: [], files: [] }),
    getGroupFilesByFolder: vi.fn().mockResolvedValue({ folders: [], files: [] }),
    getGroupFileUrl: vi.fn().mockResolvedValue({ url: "https://example.com/file" }),
    deleteGroupFile: vi.fn().mockResolvedValue(undefined),
    createGroupFileFolder: vi.fn().mockResolvedValue(undefined),
    deleteGroupFolder: vi.fn().mockResolvedValue(undefined),
    moveGroupFile: vi.fn().mockResolvedValue(undefined),
    renameGroupFile: vi.fn().mockResolvedValue(undefined),
    // C 类 NapCat 扩展
    setGroupPortrait: vi.fn().mockResolvedValue(undefined),
    setGroupRemark: vi.fn().mockResolvedValue(undefined),
    setGroupSign: vi.fn().mockResolvedValue(undefined),
    setGroupTodo: vi.fn().mockResolvedValue(undefined),
    completeGroupTodo: vi.fn().mockResolvedValue(undefined),
    cancelGroupTodo: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneBotClient;
}

describe("handleAdminCommand — 群管扩展（v1.10+）", () => {
  let client: OneBotClient;

  beforeEach(() => {
    client = makeFullClient();
    vi.clearAllMocks();
    resetConfirmPending();
    resetGroupFileCwd();
  });

  // ── 成员管理 ─────────────────────────────────────────────

  it("test_unmute_calls_setGroupBan_with_duration_zero", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    await handleAdminCommand("/unmute", ["/unmute"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/unmute", message: at,
    });
    expect(client.setGroupBan).toHaveBeenCalledWith(88888, 55555, 0);
  });

  it("test_admin_first_call_returns_pending_does_not_invoke_client", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    await handleAdminCommand("/admin", ["/admin"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/admin", message: at,
    });
    expect(client.setGroupAdmin).not.toHaveBeenCalled();
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("再发一次"));
  });

  it("test_admin_second_call_within_ttl_invokes_setGroupAdmin", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/admin", message: at };
    await handleAdminCommand("/admin", ["/admin"], ctx);  // pending
    await handleAdminCommand("/admin", ["/admin"], ctx);  // confirmed
    expect(client.setGroupAdmin).toHaveBeenCalledWith(88888, 55555, true);
  });

  it("test_unadmin_confirmed_invokes_setGroupAdmin_with_false", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/unadmin", message: at };
    await handleAdminCommand("/unadmin", ["/unadmin"], ctx);
    await handleAdminCommand("/unadmin", ["/unadmin"], ctx);
    expect(client.setGroupAdmin).toHaveBeenCalledWith(88888, 55555, false);
  });

  it("test_kickbatch_confirmed_invokes_setGroupKickMembers_with_all_ids", async () => {
    const at: OneBotMessage = [
      { type: "at", data: { qq: "111" } },
      { type: "at", data: { qq: "222" } },
      { type: "at", data: { qq: "333" } },
    ];
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/kickbatch", message: at };
    await handleAdminCommand("/kickbatch", ["/kickbatch"], ctx);
    await handleAdminCommand("/kickbatch", ["/kickbatch"], ctx);
    expect(client.setGroupKickMembers).toHaveBeenCalledWith(88888, [111, 222, 333]);
  });

  it("test_card_with_new_card_calls_setGroupCard", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    await handleAdminCommand("/card", ["/card", "新名片"], {
      client, isGroup: true, groupId: 88888, userId: 1,
      text: "/card [CQ:at,qq=55555] 新名片", message: at,
    });
    expect(client.setGroupCard).toHaveBeenCalledWith(88888, 55555, "新名片");
  });

  it("test_card_with_empty_clears_card", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    await handleAdminCommand("/card", ["/card"], {
      client, isGroup: true, groupId: 88888, userId: 1,
      text: "/card [CQ:at,qq=55555]", message: at,
    });
    expect(client.setGroupCard).toHaveBeenCalledWith(88888, 55555, "");
  });

  it("test_title_calls_setGroupSpecialTitle", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    await handleAdminCommand("/title", ["/title", "尊贵的"], {
      client, isGroup: true, groupId: 88888, userId: 1,
      text: "/title [CQ:at,qq=55555] 尊贵的", message: at,
    });
    expect(client.setGroupSpecialTitle).toHaveBeenCalledWith(88888, 55555, "尊贵的");
  });

  it("test_shutlist_formats_active_bans", async () => {
    const future = Math.floor(Date.now() / 1000) + 600; // 10 分钟后解禁
    vi.mocked(client.getGroupShutList).mockResolvedValue([
      { user_id: 111, nickname: "甲", shut_up_timestamp: future },
    ]);
    await handleAdminCommand("/shutlist", ["/shutlist"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/shutlist",
    });
    expect(client.getGroupShutList).toHaveBeenCalledWith(88888);
    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      88888,
      expect.stringContaining("111"),
    );
  });

  // ── 全员禁言 ─────────────────────────────────────────────

  it("test_banall_calls_setGroupWholeBan_true", async () => {
    await handleAdminCommand("/banall", ["/banall"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/banall",
    });
    expect(client.setGroupWholeBan).toHaveBeenCalledWith(88888, true);
  });

  it("test_unbanall_calls_setGroupWholeBan_false", async () => {
    await handleAdminCommand("/unbanall", ["/unbanall"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/unbanall",
    });
    expect(client.setGroupWholeBan).toHaveBeenCalledWith(88888, false);
  });

  // ── 群资料 ───────────────────────────────────────────────

  it("test_setname_confirmed_calls_setGroupName", async () => {
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/setname 新名" };
    await handleAdminCommand("/setname", ["/setname", "新名"], ctx);
    await handleAdminCommand("/setname", ["/setname", "新名"], ctx);
    expect(client.setGroupName).toHaveBeenCalledWith(88888, "新名");
  });

  it("test_setremark_confirmed_calls_setGroupRemark", async () => {
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/setremark 备注" };
    await handleAdminCommand("/setremark", ["/setremark", "备注"], ctx);
    await handleAdminCommand("/setremark", ["/setremark", "备注"], ctx);
    expect(client.setGroupRemark).toHaveBeenCalledWith(88888, "备注");
  });

  it("test_setportrait_requires_reply_image", async () => {
    await handleAdminCommand("/setportrait", ["/setportrait"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/setportrait", message: [],
    });
    expect(client.setGroupPortrait).not.toHaveBeenCalled();
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("回复一张图片"));
  });

  it("test_setportrait_with_image_confirmed_calls_setGroupPortrait", async () => {
    const msg: OneBotMessage = [{ type: "image", data: { file: "/path/to/img.jpg" } }];
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/setportrait", message: msg };
    await handleAdminCommand("/setportrait", ["/setportrait"], ctx);  // pending
    await handleAdminCommand("/setportrait", ["/setportrait"], ctx);  // confirmed
    expect(client.setGroupPortrait).toHaveBeenCalledWith(88888, "/path/to/img.jpg");
  });

  it("test_leave_confirmed_calls_setGroupLeave_false", async () => {
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/leave" };
    await handleAdminCommand("/leave", ["/leave"], ctx);
    await handleAdminCommand("/leave", ["/leave"], ctx);
    expect(client.setGroupLeave).toHaveBeenCalledWith(88888, false);
  });

  it("test_dismiss_confirmed_calls_setGroupLeave_true", async () => {
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "/dismiss" };
    await handleAdminCommand("/dismiss", ["/dismiss"], ctx);
    await handleAdminCommand("/dismiss", ["/dismiss"], ctx);
    expect(client.setGroupLeave).toHaveBeenCalledWith(88888, true);
  });

  // ── 精华消息 ─────────────────────────────────────────────

  it("test_essence_from_reply_calls_setEssenceMsg", async () => {
    const msg: OneBotMessage = [{ type: "reply", data: { id: "999" } }];
    await handleAdminCommand("/essence", ["/essence"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/essence", message: msg,
    });
    expect(client.setEssenceMsg).toHaveBeenCalledWith("999");
  });

  it("test_deessence_with_explicit_msgid_calls_deleteEssenceMsg", async () => {
    await handleAdminCommand("/deessence", ["/deessence", "999"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/deessence 999",
    });
    expect(client.deleteEssenceMsg).toHaveBeenCalledWith("999");
  });

  // ── 查询 ─────────────────────────────────────────────────

  it("test_honor_default_type_calls_getGroupHonorInfo_all", async () => {
    await handleAdminCommand("/honor", ["/honor"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/honor",
    });
    expect(client.getGroupHonorInfo).toHaveBeenCalledWith(88888, "all");
  });

  it("test_atallremain_replies_with_counts", async () => {
    await handleAdminCommand("/atallremain", ["/atallremain"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/atallremain",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      88888,
      expect.stringContaining("@全体"),
    );
  });

  // ── 群文件 ───────────────────────────────────────────────

  it("test_files_at_root_calls_getGroupRootFiles", async () => {
    await handleAdminCommand("/files", ["/files"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/files",
    });
    expect(client.getGroupRootFiles).toHaveBeenCalledWith(88888, 20);
  });

  it("test_cd_into_existing_folder_pushes_cwd", async () => {
    vi.mocked(client.getGroupRootFiles).mockResolvedValue({
      folders: [{ folder_id: "f123", folder_name: "文档" }],
      files: [],
    });
    await handleAdminCommand("/cd", ["/cd", "文档"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/cd 文档",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("/文档"));
    // 后续 /files 应改用 byFolder
    await handleAdminCommand("/files", ["/files"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/files",
    });
    expect(client.getGroupFilesByFolder).toHaveBeenCalledWith(88888, "f123", 20);
  });

  it("test_cd_to_root_resets_cwd", async () => {
    vi.mocked(client.getGroupRootFiles).mockResolvedValue({
      folders: [{ folder_id: "f123", folder_name: "文档" }],
      files: [],
    });
    const ctx = { client, isGroup: true, groupId: 88888, userId: 1, text: "" };
    await handleAdminCommand("/cd", ["/cd", "文档"], { ...ctx, text: "/cd 文档" });
    await handleAdminCommand("/cd", ["/cd", "/"], { ...ctx, text: "/cd /" });
    await handleAdminCommand("/files", ["/files"], { ...ctx, text: "/files" });
    // /cd / 后 /files 应回到 root API
    expect(client.getGroupRootFiles).toHaveBeenCalledTimes(2);
  });

  it("test_pwd_shows_current_path", async () => {
    await handleAdminCommand("/pwd", ["/pwd"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/pwd",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("/"));
  });

  it("test_dl_returns_url", async () => {
    await handleAdminCommand("/dl", ["/dl", "fileXYZ"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/dl fileXYZ",
    });
    expect(client.getGroupFileUrl).toHaveBeenCalledWith(88888, "fileXYZ");
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("https://example.com/file"));
  });

  it("test_delfile_calls_deleteGroupFile", async () => {
    await handleAdminCommand("/delfile", ["/delfile", "fileXYZ"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/delfile fileXYZ",
    });
    expect(client.deleteGroupFile).toHaveBeenCalledWith(88888, "fileXYZ");
  });

  it("test_mkdir_calls_createGroupFileFolder", async () => {
    await handleAdminCommand("/mkdir", ["/mkdir", "新文件夹"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/mkdir 新文件夹",
    });
    expect(client.createGroupFileFolder).toHaveBeenCalledWith(88888, "新文件夹");
  });

  // ── NapCat 扩展 ──────────────────────────────────────────

  it("test_poke_calls_sendGroupPoke", async () => {
    const at: OneBotMessage = [{ type: "at", data: { qq: "55555" } }];
    await handleAdminCommand("/poke", ["/poke"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/poke", message: at,
    });
    expect(client.sendGroupPoke).toHaveBeenCalledWith(88888, 55555);
  });

  it("test_sign_calls_setGroupSign", async () => {
    await handleAdminCommand("/sign", ["/sign"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sign",
    });
    expect(client.setGroupSign).toHaveBeenCalledWith(88888);
  });

  it("test_todo_from_reply_calls_setGroupTodo", async () => {
    const msg: OneBotMessage = [{ type: "reply", data: { id: "888" } }];
    await handleAdminCommand("/todo", ["/todo"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/todo", message: msg,
    });
    expect(client.setGroupTodo).toHaveBeenCalledWith(88888, "888");
  });

  // ── 边界：群外执行群命令 ─────────────────────────────────

  it("test_group_only_command_rejected_in_private", async () => {
    await handleAdminCommand("/banall", ["/banall"], {
      client, isGroup: false, userId: 1, text: "/banall",
    });
    expect(client.setGroupWholeBan).not.toHaveBeenCalled();
    expect(client.sendPrivateMsg).toHaveBeenCalledWith(1, expect.stringContaining("仅限群聊"));
  });

  it("test_admin_without_target_replies_usage", async () => {
    await handleAdminCommand("/admin", ["/admin"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/admin",
    });
    expect(client.setGroupAdmin).not.toHaveBeenCalled();
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("用法"));
  });

  // ── /sleep 休眠模式 ──────────────────────────────────────

  it("test_sleep_no_args_shows_status_off", async () => {
    await handleAdminCommand("/sleep", ["/sleep"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("关闭"));
  });

  it("test_sleep_on_enables_sleep_mode", async () => {
    await handleAdminCommand("/sleep on", ["/sleep", "on"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep on",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("已开启"));
  });

  it("test_sleep_off_disables_sleep_mode", async () => {
    await handleAdminCommand("/sleep on", ["/sleep", "on"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep on",
    });
    vi.clearAllMocks();
    await handleAdminCommand("/sleep off", ["/sleep", "off"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep off",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("已关闭"));
  });

  it("test_sleep_with_hours_sets_time_window", async () => {
    await handleAdminCommand("/sleep 23 7", ["/sleep", "23", "7"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 23 7",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("23:00");
    expect(reply).toContain("7:00");
    expect(reply).toContain("已开启");
  });

  it("test_sleep_after_on_shows_status_on", async () => {
    await handleAdminCommand("/sleep on", ["/sleep", "on"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep on",
    });
    vi.clearAllMocks();
    await handleAdminCommand("/sleep", ["/sleep"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("开启"));
  });

  // ── 自然语言时段解析 ──────────────────────────────────────

  it("test_sleep_natural_language_chinese", async () => {
    await handleAdminCommand("/sleep 晚上11点到早上7点", ["/sleep", "晚上11点到早上7点"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 晚上11点到早上7点",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("23:00");
    expect(reply).toContain("7:00");
    expect(reply).toContain("已开启");
  });

  it("test_sleep_natural_language_chinese_numerals", async () => {
    await handleAdminCommand("/sleep 每晚十一点到早上七点", ["/sleep", "每晚十一点到早上七点"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 每晚十一点到早上七点",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("23:00");
    expect(reply).toContain("7:00");
    expect(reply).toContain("已开启");
  });

  it("test_sleep_natural_language_dash_format", async () => {
    await handleAdminCommand("/sleep 23:00-07:00", ["/sleep", "23:00-07:00"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 23:00-07:00",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("23:00");
    expect(reply).toContain("7:00");
    expect(reply).toContain("已开启");
  });

  it("test_sleep_unrecognized_format_returns_error", async () => {
    await handleAdminCommand("/sleep 明天开始", ["/sleep", "明天开始"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 明天开始",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("无法识别"));
  });

  // ── 边界与修复验证 ──────────────────────────────────────

  it("test_sleep_midnight_12pm_maps_to_0", async () => {
    // "晚上12点" = 午夜 0:00, 不是 12:00
    await handleAdminCommand("/sleep 晚上12点到早上7点", ["/sleep", "晚上12点到早上7点"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 晚上12点到早上7点",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("0:00");
    expect(reply).not.toContain("12:00 - 7:00");
  });

  it("test_sleep_lingye_1am_not_pm", async () => {
    // "夜里1点" = 凌晨1:00, 不是下午13:00
    await handleAdminCommand("/sleep 夜里1点到早上7点", ["/sleep", "夜里1点到早上7点"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 夜里1点到早上7点",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("1:00");
    expect(reply).not.toContain("13:00");
  });

  it("test_sleep_lingchen_12am_maps_to_0", async () => {
    // "凌晨12点" = 0:00
    await handleAdminCommand("/sleep 凌晨12点到早上7点", ["/sleep", "凌晨12点到早上7点"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 凌晨12点到早上7点",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("0:00");
  });

  it("test_sleep_zero_hour_recognized", async () => {
    // "零点" 应被识别为 0
    await handleAdminCommand("/sleep 零点到七点", ["/sleep", "零点到七点"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 零点到七点",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("0:00");
    expect(reply).toContain("7:00");
    expect(reply).toContain("已开启");
  });

  it("test_sleep_same_hour_rejected", async () => {
    // start === end 应被拒绝（0长度窗口）
    await handleAdminCommand("/sleep 7 7", ["/sleep", "7", "7"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 7 7",
    });
    expect(client.sendGroupMsg).toHaveBeenCalledWith(88888, expect.stringContaining("0 长度"));
  });

  it("test_sleep_updates_configRef_state", async () => {
    await handleAdminCommand("/sleep 23 7", ["/sleep", "23", "7"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 23 7",
    });
    const { getConfigRef } = await import("../config-watcher.js");
    const ref = getConfigRef();
    expect(ref.current.sleepMode.enabled).toBe(true);
    expect(ref.current.sleepMode.startHour).toBe(23);
    expect(ref.current.sleepMode.endHour).toBe(7);
  });

  it("test_sleep_off_sets_enabled_false", async () => {
    // First enable
    await handleAdminCommand("/sleep on", ["/sleep", "on"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep on",
    });
    vi.clearAllMocks();
    // Then disable and verify configRef
    await handleAdminCommand("/sleep off", ["/sleep", "off"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep off",
    });
    const { getConfigRef } = await import("../config-watcher.js");
    const ref = getConfigRef();
    expect(ref.current.sleepMode.enabled).toBe(false);
  });

  it("test_sleep_pure_chinese_numerals_no_time_word", async () => {
    await handleAdminCommand("/sleep 十一点到七点", ["/sleep", "十一点到七点"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 十一点到七点",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("11:00");
    expect(reply).toContain("7:00");
    expect(reply).toContain("已开启");
  });

  it("test_sleep_dash_format_simple", async () => {
    await handleAdminCommand("/sleep 23-7", ["/sleep", "23-7"], {
      client, isGroup: true, groupId: 88888, userId: 1, text: "/sleep 23-7",
    });
    const reply = vi.mocked(client.sendGroupMsg).mock.calls[0][1] as string;
    expect(reply).toContain("23:00");
    expect(reply).toContain("7:00");
    expect(reply).toContain("已开启");
  });
});

