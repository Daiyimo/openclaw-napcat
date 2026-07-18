/**
 * gateway/inbound.ts 中 session 冲突派发处理的回归测试。
 *
 * 背景：框架 initSessionState 已在内部重试 session 初始化冲突（指数退避），且冲突
 * 发生在 deliver 回调之前（pre-deliver）。因此插件不再自建重试循环，也不做降级重放
 * （原降级块因 lastDeliverPayload 恒为 undefined 属死代码，且真跑会绕过框架 session
 * 造成重复/错序回复）。当前行为（对齐 Discord 插件）：
 *  - session 冲突时不重试、不重放，直接通知用户「会话繁忙，请稍后再试」；
 *  - 释放哨兵为 markSilent（不写冷却，允许立即重试）+ 计 dispatch.failed；
 *  - 不 rethrow，因此不进入外层「Reply dispatch error」错误路径；
 *  - 非冲突错误照旧冒泡到外层 catch，走正常错误通知路径。
 *
 * 驱动方式沿用 inbound-pipeline.test.ts：EventEmitter client + installMessageHandler。
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

import { installMessageHandler } from "../gateway/inbound.js";
import { invalidateOtherBotNamesCache } from "../gateway/trigger-state.js";
import { resetDialogState } from "../dialog-state.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SELF_ID = 10000;
const USER_ID = 55555;
const GROUP_ID = 88888;
const ACCOUNT_ID = "acct1";
/** 与框架报错文案一致，命中 inbound.ts 的 /session initialization conflicted/i 检测 */
const CONFLICT_MESSAGE = "reply session initialization conflicted for agent:default:napcat:direct:55555";
/** session 冲突时发给用户的繁忙提示文案 */
const BUSY_NOTICE = "⏳ 会话繁忙，请稍后再试。";

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

describe("installMessageHandler — session conflict dispatch handling", () => {
  beforeEach(() => {
    resetDialogState();
    invalidateOtherBotNamesCache();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("test_session_conflict_notifies_user_busy_without_retry_or_error_path", async () => {
    // 框架已内部重试；插件收到冲突时不重试、不重放，直接发繁忙提示，且不冒泡到错误路径
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx({ enableErrorNotify: true });
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error(CONFLICT_MESSAGE));
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());

    // 终点：向用户发送「会话繁忙」提示
    await vi.waitFor(
      () => expect(shared.deliverMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: BUSY_NOTICE }),
      ),
      { timeout: 2000 },
    );

    // 不重试：dispatch 仅调用一次
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    // 不 rethrow：不进入外层「Reply dispatch error」错误路径
    expect(ctx.log.error).not.toHaveBeenCalledWith(expect.stringContaining("Reply dispatch error"));
  });

  it("test_session_conflict_releases_sentinel_markSilent_and_counts_failed", async () => {
    // 旁观模式 session 冲突：释放哨兵为 markSilent（不写冷却）+ 计 dispatch.failed
    const metrics = { increment: vi.fn() };
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx(
      {
        requireMention: true,
        _selfName: "爱弥斯",
        knownBotIds: [99999],
        passiveMode: { enabled: true, cooldownMs: 0, minIntervalMs: 0 },
      },
      { metrics: metrics as unknown as InboundContext["metrics"] },
    );
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
      () => expect(shared.deliverMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: BUSY_NOTICE }),
      ),
      { timeout: 2000 },
    );

    // 哨兵释放为 markSilent（旁观冷却 key），计 dispatch.failed
    expect(markSilentSpy).toHaveBeenCalledWith(`${ACCOUNT_ID}:group:${GROUP_ID}`);
    expect(metrics.increment).toHaveBeenCalledWith("dispatch", "failed");
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("test_session_conflict_busy_notice_failure_does_not_rethrow", async () => {
    // 繁忙提示自身发送失败：内部 catch 吞掉并 warn，不冒泡到外层错误路径
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx();
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error(CONFLICT_MESSAGE));
    shared.deliverMock.mockRejectedValueOnce(new Error("send failed"));
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());

    await vi.waitFor(
      () => expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("会话繁忙提示发送失败"),
        expect.anything(),
      ),
      { timeout: 2000 },
    );

    // 不 rethrow：不进入外层「Reply dispatch error」错误路径
    expect(ctx.log.error).not.toHaveBeenCalledWith(expect.stringContaining("Reply dispatch error"));
  });

  it("test_non_conflict_dispatch_error_notifies_user_via_error_path", async () => {
    // 非冲突错误照旧冒泡到外层 catch，走正常错误通知路径
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

    // 冒泡到外层：记录「Reply dispatch error」
    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("Reply dispatch error"));
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("test_dispatch_success_marks_done_and_counts_succeeded", async () => {
    // 正常路径：派发成功走成功分支
    const metrics = { increment: vi.fn() };
    const { client, ctx, dispatchReplyWithBufferedBlockDispatcher } = makeCtx(
      {},
      { metrics: metrics as unknown as InboundContext["metrics"] },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(undefined);
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());

    await vi.waitFor(
      () => expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining("dispatch succeeded")),
      { timeout: 2000 },
    );

    expect(metrics.increment).toHaveBeenCalledWith("dispatch", "succeeded");
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    // 不发繁忙提示、不进入错误路径
    expect(shared.deliverMock).not.toHaveBeenCalledWith(expect.objectContaining({ text: BUSY_NOTICE }));
    expect(ctx.log.error).not.toHaveBeenCalledWith(expect.stringContaining("Reply dispatch error"));
  });
});
