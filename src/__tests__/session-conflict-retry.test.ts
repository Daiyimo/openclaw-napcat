/**
 * Regression tests for the session-conflict dispatch retry in gateway/inbound.ts.
 *
 * Covers commits c3c3cfe / 4db34be / d06da6b:
 *  - "session initialization conflicted" is retried up to 3 times (linear backoff 2000/4000/6000ms)
 *  - persistent conflict takes the existing error path WITHOUT notifying the user
 *    (framework-internal conflict = noise, suppressed even when enableErrorNotify=true)
 *  - passive-mode sentinel is released (markSilent) when dispatch ultimately fails
 *  - non-conflict dispatch errors are NOT retried and follow the normal notify path
 *
 * Driving pattern mirrors inbound-pipeline.test.ts: EventEmitter client +
 * installMessageHandler. utils/sleep.js is mocked so the backoff is instant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import EventEmitter from "events";
import type { OneBotClient } from "../client.js";
import type { OneBotEvent } from "../types.js";
import type { InboundContext, PluginRuntimeChannel } from "../types/channel-types.js";
import type { QQConfig } from "../config.js";
import type { AlertCooldown } from "../metrics.js";
import { UploadCache } from "../upload-cache.js";
import { PassiveModeManager } from "../passive-mode.js";

// ── Hoisted shared mocks ─────────────────────────────────────────────────────

/** Shared deliver spy: every MessageSender mock instance delivers through this fn. */
const shared = vi.hoisted(() => ({
  deliverMock: vi.fn().mockResolvedValue(undefined),
}));

// ── Module mocks (must precede the module-under-test import) ────────────────

vi.mock("../member-cache.js", () => ({
  populateGroupMemberCache: vi.fn().mockResolvedValue(undefined),
  getCachedMemberName: vi.fn().mockReturnValue(null),
}));

vi.mock("../known-users.js", () => ({
  recordKnownUser: vi.fn(),
}));

vi.mock("../ref-index-store.js", () => ({
  recordRef: vi.fn(),
  lookupRef: vi.fn().mockReturnValue(null),
}));

vi.mock("../message-sender.js", () => ({
  MessageSender: vi.fn().mockImplementation(() => ({
    deliver: shared.deliverMock,
  })),
}));

vi.mock("../typing-keepalive.js", () => ({
  TypingKeepAlive: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../deliver-debounce.js", () => ({
  createDeliverDebouncer: vi.fn().mockReturnValue(null),
}));

vi.mock("../utils/pkg-version.js", () => ({
  getPackageVersion: vi.fn().mockReturnValue("1.0.0"),
}));

vi.mock("../update-checker.js", () => ({
  getUpdateInfo: vi.fn().mockResolvedValue({ hasUpdate: false, latest: "1.0.0", error: null }),
}));

vi.mock("../log-buffer.js", () => ({
  getRecentLogs: vi.fn().mockReturnValue([]),
  formatLogEntry: vi.fn().mockImplementation((e: unknown) => String(e)),
}));

vi.mock("../config-watcher.js", () => ({
  getConfigRef: vi.fn().mockReturnValue({
    current: { passiveMode: { temperature: 50 } },
    log: null,
  }),
  updateConfigRef: vi.fn().mockReturnValue({ success: true, connectionChanged: false }),
  initConfigRef: vi.fn(),
}));

// 退避等待置为瞬时：retry 循环的 2000/4000/6000ms 不做真实等待
vi.mock("../utils/sleep.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { installMessageHandler } from "../gateway/inbound.js";
import { invalidateOtherBotNamesCache } from "../gateway/trigger-state.js";
import { resetDialogState } from "../dialog-state.js";
import { sleep } from "../utils/sleep.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SELF_ID = 10000;
const USER_ID = 55555;
const GROUP_ID = 88888;
const ACCOUNT_ID = "acct1";
/** 与框架报错文案一致，命中 inbound.ts 的 /session initialization conflicted/i 检测 */
const CONFLICT_MESSAGE = "reply session initialization conflicted for agent:default:napcat:direct:55555";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(selfId = SELF_ID): OneBotClient {
  const emitter = new EventEmitter() as any;
  emitter.getSelfId = vi.fn().mockReturnValue(selfId);
  emitter.setSelfId = vi.fn();
  emitter.sendPrivateMsg = vi.fn().mockResolvedValue(undefined);
  emitter.sendGroupMsg = vi.fn().mockResolvedValue(undefined);
  emitter.getGroupMemberList = vi.fn().mockResolvedValue([]);
  emitter.getGroupMsgHistory = vi.fn().mockResolvedValue({ messages: [] });
  emitter.getMsg = vi.fn().mockResolvedValue(null);
  emitter.setMsgEmojiLike = vi.fn().mockResolvedValue(undefined);
  emitter.markGroupMsgAsRead = vi.fn();
  emitter.markPrivateMsgAsRead = vi.fn();
  return emitter as unknown as OneBotClient;
}

function makeConfig(overrides: Partial<QQConfig> = {}): QQConfig {
  return {
    requireMention: true,
    enableDeduplication: true,
    enableErrorNotify: false,
    autoApproveRequests: false,
    maxMessageLength: 4000,
    formatMarkdown: false,
    antiRiskMode: false,
    historyLimit: 0,        // skip getGroupMsgHistory calls
    enableTTS: false,
    rateLimitMs: 0,
    enableReactions: false, // skip setMsgEmojiLike calls
    autoMarkRead: false,
    enableSTT: false,
    markdownMode: "passthrough",
    enableUpdateCheck: false,
    logBufferSize: 200,
    inboundRateLimitMs: 0,
    ...overrides,
  } as unknown as QQConfig;
}

function makeCtx(
  configOverrides: Partial<QQConfig> = {},
  ctxExtras: Partial<InboundContext> = {},
): {
  client: OneBotClient;
  ctx: InboundContext;
  dispatchReplyWithBufferedBlockDispatcher: ReturnType<typeof vi.fn>;
} {
  const client = makeClient();
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);

  const channelRuntime: PluginRuntimeChannel = {
    activity: { record: vi.fn() },
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store"),
      recordInboundSession: vi.fn().mockResolvedValue(undefined),
    },
    reply: {
      finalizeInboundContext: vi.fn().mockImplementation((c) => c),
      dispatchReplyWithBufferedBlockDispatcher,
    },
  };

  const config = makeConfig(configOverrides);

  const ctx: InboundContext = {
    client,
    account: { accountId: ACCOUNT_ID, config },
    config,
    cfg: {} as any,
    channelRuntime,
    uploadCache: new UploadCache(),
    inboundStore: { config, processedMsgIds: new Set<string>() },
    knownGroupIds: new Set(),
    passiveMode: new PassiveModeManager(),
    log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...ctxExtras,
  };

  return { client, ctx, dispatchReplyWithBufferedBlockDispatcher };
}

let _msgId = 1000;

function makePrivateEvent(overrides: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: "message",
    message_type: "private",
    message_id: ++_msgId,
    user_id: USER_ID,
    raw_message: "hello",
    message: [{ type: "text", data: { text: "hello" } }],
    sender: { user_id: USER_ID, nickname: "TestUser" },
    ...overrides,
  } as OneBotEvent;
}

function makeGroupEvent(overrides: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: "message",
    message_type: "group",
    message_id: ++_msgId,
    user_id: USER_ID,
    group_id: GROUP_ID,
    raw_message: "hello group",
    message: [{ type: "text", data: { text: "hello group" } }],
    sender: { user_id: USER_ID, nickname: "TestUser" },
    ...overrides,
  } as OneBotEvent;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("installMessageHandler — session conflict dispatch retry", () => {
  beforeEach(() => {
    resetDialogState();
    invalidateOtherBotNamesCache();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("test_session_conflict_retried_3_times_then_error_path_without_user_notify", async () => {
    // enableErrorNotify=true 也不发通知：session 冲突是框架内部问题（4db34be 噪音抑制）
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx({ enableErrorNotify: true });
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error(CONFLICT_MESSAGE));
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());

    // 终点：既有错误路径（catch 内 log.error）
    await vi.waitFor(
      () => expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("Reply dispatch error")),
      { timeout: 2000 },
    );

    // 1 次原始调用 + 3 次重试
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(4);
    // 线性退避 2000/4000/6000（与 inbound.ts 实现一致）
    expect(vi.mocked(sleep).mock.calls.map((c) => c[0])).toEqual([2000, 4000, 6000]);
    // 噪音抑制：dispatch 从未调用 deliver，错误通知也不发给用户
    expect(shared.deliverMock).not.toHaveBeenCalled();
  });

  it("test_passive_sentinel_released_after_conflict_retries_exhausted", async () => {
    // 旁观模式派发失败：释放哨兵（markSilent），不写冷却，允许用户立即重试
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx({
      requireMention: true,
      _selfName: "爱弥斯",
      knownBotIds: [99999],
      passiveMode: { enabled: true, cooldownMs: 0, minIntervalMs: 0 },
      enableErrorNotify: true,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error(CONFLICT_MESSAGE));
    const markSilentSpy = vi.spyOn(ctx.passiveMode, "markSilent");
    installMessageHandler(client, ctx);

    // 中性群消息（无 @、无 bot 名）→ 顶层门控放行 → 进入旁观派发
    client.emit(
      "message",
      makeGroupEvent({
        message: [{ type: "text", data: { text: "大家好啊" } }],
        raw_message: "大家好啊",
      }),
    );

    await vi.waitFor(
      () => expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("Reply dispatch error")),
      { timeout: 2000 },
    );

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(4);
    // 哨兵释放：markSilent 以旁观冷却 key 被调用
    expect(markSilentSpy).toHaveBeenCalledWith(`${ACCOUNT_ID}:group:${GROUP_ID}`);
    expect(shared.deliverMock).not.toHaveBeenCalled();
  });

  it("test_dispatch_succeeds_on_second_attempt_after_session_conflict", async () => {
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx();
    dispatchReplyWithBufferedBlockDispatcher
      .mockRejectedValueOnce(new Error(CONFLICT_MESSAGE))
      .mockResolvedValueOnce(undefined);
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());

    await vi.waitFor(
      () => expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining("dispatch succeeded")),
      { timeout: 2000 },
    );

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    // 仅在首次失败后等待 2000ms
    expect(vi.mocked(sleep).mock.calls.map((c) => c[0])).toEqual([2000]);
    // 成功路径：不进入错误路径
    expect(ctx.log.error).not.toHaveBeenCalledWith(expect.stringContaining("Reply dispatch error"));
  });

  it("test_non_conflict_dispatch_error_not_retried_and_notifies_user", async () => {
    const alertCooldown = {
      shouldFire: vi.fn().mockReturnValue(true),
      record: vi.fn(),
    };
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx(
      { enableErrorNotify: true },
      { alertCooldown: alertCooldown as unknown as AlertCooldown },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("network down"));
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());

    // 终点：正常错误通知路径，向用户发送告警消息
    await vi.waitFor(
      () =>
        expect(shared.deliverMock).toHaveBeenCalledWith(
          expect.objectContaining({ text: "⚠️ 服务调用失败，请稍后重试。" }),
        ),
      { timeout: 2000 },
    );

    // 非冲突错误不重试：恰好 1 次调用，且无退避等待
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sleep)).not.toHaveBeenCalled();
  });
});
