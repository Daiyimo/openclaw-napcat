/**
 * 入站消息过滤阶段独立测试
 *
 * 覆盖: 正常路径、边界条件、错误路径、状态机转换
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { filterStage } from "../gateway/filter.js";
import type { OneBotClient } from "../client.js";
import type { OneBotEvent, InboundContext } from "../types/channel-types.js";

// ── Mock 工厂 ──────────────────────────────────────────────

function makeEvent(overrides: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    user_id: 12345,
    group_id: 88888,
    message: [{ type: "text", data: { text: "hello" } }],
    self_id: 10000,
    ...overrides,
  };
}

function makeClient(overrides: Partial<OneBotClient> = {}): OneBotClient {
  return {
    getSelfId: vi.fn(() => 10000),
    setSelfId: vi.fn(),
    sendGroupPoke: vi.fn(),
    sendFriendPoke: vi.fn(),
    markGroupMsgAsRead: vi.fn(),
    markPrivateMsgAsRead: vi.fn(),
    setFriendAddRequest: vi.fn(),
    setGroupAddRequest: vi.fn(),
    ...overrides,
  } as unknown as OneBotClient;
}

function makeCtx(overrides: Partial<InboundContext> = {}): InboundContext {
  return {
    config: {
      debug: false,
      autoApproveRequests: false,
      blockedUsers: undefined,
      allowedGroups: undefined,
      enableDeduplication: true,
      autoMarkRead: false,
    },
    knownGroupIds: new Set<string>(),
    inboundStore: { processedMsgIds: new Set<string>() },
    log: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    metrics: { increment: vi.fn() },
    ...overrides,
  } as unknown as InboundContext;
}

// ── 测试 ──────────────────────────────────────────────────

describe("filterStage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 正常路径 ──

  it("test_filter_passes_normal_group_message", () => {
    const event = makeEvent();
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(12345);
    expect(result!.groupId).toBe(88888);
    expect(result!.isGroup).toBe(true);
    expect(result!.selfId).toBe("10000");
  });

  it("test_filter_passes_private_message", () => {
    const event = makeEvent({ message_type: "private", group_id: undefined });
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).not.toBeNull();
    expect(result!.isGroup).toBe(false);
    expect(result!.groupId).toBeUndefined();
  });

  // ── 边界条件 ──

  it("test_filter_drops_meta_event_lifecycle", () => {
    const event = makeEvent({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect" });
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
    expect(client.setSelfId).toHaveBeenCalledWith(event.self_id);
  });

  it("test_filter_drops_non_message_post_type", () => {
    const event = makeEvent({ post_type: "notice" });
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
  });

  it("test_filter_drops_self_message", () => {
    const event = makeEvent({ user_id: 10000 }); // same as selfId
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
  });

  it("test_filter_drops_blocked_user", () => {
    const event = makeEvent();
    const client = makeClient();
    const ctx = makeCtx({ config: { ...makeCtx().config!, blockedUsers: [12345] } });
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
  });

  it("test_filter_drops_disallowed_group", () => {
    const event = makeEvent();
    const client = makeClient();
    const ctx = makeCtx({ config: { ...makeCtx().config!, allowedGroups: [99999] } });
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
  });

  it("test_filter_drops_duplicate_message", () => {
    const event = makeEvent({ message_id: "msg-1" });
    const client = makeClient();
    const store = { processedMsgIds: new Set(["msg-1"]) };
    const ctx = makeCtx({ inboundStore: store as any });
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
  });

  it("test_filter_passes_new_message_id", () => {
    const event = makeEvent({ message_id: "msg-new" });
    const client = makeClient();
    const store = { processedMsgIds: new Set<string>() };
    const ctx = makeCtx({ inboundStore: store as any });
    const result = filterStage(event, client, ctx);
    expect(result).not.toBeNull();
    expect(store.processedMsgIds.has("msg-new")).toBe(true);
  });

  it("test_filter_records_known_group", () => {
    const event = makeEvent();
    const client = makeClient();
    const knownGroupIds = new Set<string>();
    const ctx = makeCtx({ knownGroupIds });
    filterStage(event, client, ctx);
    expect(knownGroupIds.has("88888")).toBe(true);
  });

  it("test_filter_drops_poke_to_other_user", () => {
    const event = makeEvent({
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      target_id: 99999, // not self
    });
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
  });

  // ── 错误路径 ──

  it("test_filter_warns_when_selfId_missing", () => {
    const client = makeClient({ getSelfId: vi.fn(() => null) });
    const ctx = makeCtx();
    const event = makeEvent({ self_id: undefined });
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("test_filter_approves_friend_request_when_configured", () => {
    const event = makeEvent({
      post_type: "request",
      request_type: "friend",
      flag: "req-flag",
    });
    const client = makeClient();
    const ctx = makeCtx({ config: { ...makeCtx().config!, autoApproveRequests: true } });
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
    expect(client.setFriendAddRequest).toHaveBeenCalledWith("req-flag", true);
  });

  it("test_filter_approves_group_request_when_configured", () => {
    const event = makeEvent({
      post_type: "request",
      request_type: "group",
      flag: "req-flag",
      sub_type: "add",
    });
    const client = makeClient();
    const ctx = makeCtx({ config: { ...makeCtx().config!, autoApproveRequests: true } });
    const result = filterStage(event, client, ctx);
    expect(result).toBeNull();
    expect(client.setGroupAddRequest).toHaveBeenCalledWith("req-flag", "add", true);
  });

  // ── 状态机转换 ──

  it("test_filter_converts_poke_to_message", () => {
    const event = makeEvent({
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      target_id: 10000, // self
      group_id: 88888,
    });
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).not.toBeNull();
    expect(result!.event.post_type).toBe("message");
    expect(result!.event.message_type).toBe("group");
    expect(result!.event.raw_message).toBe("[动作] 用户戳了你一下");
    expect(client.sendGroupPoke).toHaveBeenCalled();
  });

  it("test_filter_converts_private_poke_to_message", () => {
    const event = makeEvent({
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      target_id: 10000,
      user_id: 12345,
      group_id: undefined,
    });
    const client = makeClient();
    const ctx = makeCtx();
    const result = filterStage(event, client, ctx);
    expect(result).not.toBeNull();
    expect(result!.event.post_type).toBe("message");
    expect(result!.event.message_type).toBe("private");
    expect(client.sendFriendPoke).toHaveBeenCalledWith(12345);
  });
});
