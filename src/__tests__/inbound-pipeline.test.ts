/**
 * Integration tests for the inbound message pipeline.
 *
 * Tests cover: filter → parse → trigger → dispatch → reply
 * via installMessageHandler in gateway/inbound.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import EventEmitter from "events";
import type { OneBotClient } from "../client.js";
import type { OneBotEvent } from "../types.js";
import type { InboundContext, PluginRuntimeChannel } from "../types/channel-types.js";
import type { QQConfig } from "../config.js";
import { UploadCache } from "../upload-cache.js";
import { PassiveModeManager } from "../passive-mode.js";

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
    deliver: vi.fn().mockResolvedValue(undefined),
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

import { installMessageHandler } from "../gateway/inbound.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SELF_ID = 10000;
const USER_ID = 55555;
const GROUP_ID = 88888;
const ACCOUNT_ID = "acct1";

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
    enableGuilds: true,
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

function makeCtx(configOverrides: Partial<QQConfig> = {}): {
  client: OneBotClient;
  ctx: InboundContext;
  dispatchReplyFromConfig: ReturnType<typeof vi.fn>;
} {
  const client = makeClient();
  const dispatchReplyFromConfig = vi.fn().mockResolvedValue(undefined);

  const channelRuntime: PluginRuntimeChannel = {
    activity: { record: vi.fn() },
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store"),
      recordInboundSession: vi.fn().mockResolvedValue(undefined),
    },
    reply: {
      createReplyDispatcherWithTyping: vi.fn().mockReturnValue({
        dispatcher: {},
        replyOptions: {},
      }),
      finalizeInboundContext: vi.fn().mockImplementation((c) => c),
      dispatchReplyFromConfig,
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
    inboundStore: { lastTrigger: new Map(), config },
    processedMsgIds: new Set(),
    knownGroupIds: new Set(),
    passiveMode: new PassiveModeManager(),
    log: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  return { client, ctx, dispatchReplyFromConfig };
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

/** Drain all microtasks so async event handlers can run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("installMessageHandler — inbound pipeline integration (12 cases)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // 1. Private message triggers AI
  it("1. private message triggers dispatchReplyFromConfig", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx();
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  // 2. Group message without @mention does NOT trigger
  it("2. group message without @mention does not trigger (requireMention=true)", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: true });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [{ type: "text", data: { text: "just chatting" } }],
        raw_message: "just chatting",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 3. Group message WITH @mention triggers
  it("3. group message with @mention triggers dispatchReplyFromConfig", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: true });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [
          { type: "at", data: { qq: String(SELF_ID) } },
          { type: "text", data: { text: " hello bot" } },
        ],
        raw_message: `[CQ:at,qq=${SELF_ID}] hello bot`,
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  // 4. Self-message filtered
  it("4. message from self (userId === selfId) is filtered out", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx();
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent({ user_id: SELF_ID }));
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 5. Deduplication — same message_id processed only once
  it("5. duplicate message_id is processed only once", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ enableDeduplication: true });
    installMessageHandler(client, ctx);

    const event = makePrivateEvent({ message_id: 99901 });
    client.emit("message", event);
    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });

    client.emit("message", { ...event }); // identical message_id
    await flush();

    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  // 6. blockedUsers filter
  it("6. message from a blocked user is dropped", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ blockedUsers: [USER_ID] });
    installMessageHandler(client, ctx);

    client.emit("message", makePrivateEvent());
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 7. Admin /ping command — intercepted before AI dispatch
  it("7. admin /ping in private chat replies with Pong and does not dispatch AI", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ admins: [USER_ID] });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "/ping" } }],
        raw_message: "/ping",
      }),
    );

    await vi.waitFor(
      () =>
        expect(vi.mocked(client.sendPrivateMsg)).toHaveBeenCalledWith(
          USER_ID,
          expect.stringContaining("Pong"),
        ),
      { timeout: 2000 },
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 8. Inbound rate limiting — pre-seed lastTrigger to simulate a recent event
  it("8. message within rate-limit window is dropped", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ inboundRateLimitMs: 5000 });
    installMessageHandler(client, ctx);

    // Simulate that this user/conversation just triggered (0 ms ago)
    const fromId = String(USER_ID); // private → userId string
    ctx.inboundStore.lastTrigger.set(`${ACCOUNT_ID}:${fromId}`, Date.now());

    client.emit("message", makePrivateEvent());
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 9. Silent keyword filter
  it("9. message containing a silent keyword is silently dropped", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ silentKeywords: ["badword"] });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "this message has badword inside" } }],
        raw_message: "this message has badword inside",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 10. meta_event is ignored
  it("10. meta_event is ignored — no dispatch", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx();
    installMessageHandler(client, ctx);

    client.emit("message", {
      time: 0,
      self_id: SELF_ID,
      post_type: "meta_event",
      meta_event_type: "heartbeat",
    } as unknown as OneBotEvent);
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 11. Keyword trigger fires without @mention
  it("11. group message matching a keywordTrigger fires dispatch without @mention", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: true,
      keywordTriggers: ["help-me"],
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [{ type: "text", data: { text: "help-me please!" } }],
        raw_message: "help-me please!",
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  // 12. Group message updates knownGroupIds
  it("12. group message adds group_id to knownGroupIds", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: false });
    installMessageHandler(client, ctx);

    expect(ctx.knownGroupIds.has(String(GROUP_ID))).toBe(false);

    client.emit("message", makeGroupEvent());

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });

    expect(ctx.knownGroupIds.has(String(GROUP_ID))).toBe(true);
  });
});
