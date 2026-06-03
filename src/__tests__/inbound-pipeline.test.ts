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
import { resetDialogState } from "../dialog-state.js";

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

describe("installMessageHandler — inbound pipeline integration (28 cases)", () => {
  beforeEach(() => {
    resetDialogState();
  });
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

  // 3b. @mention of OTHER user (not bot) does NOT trigger
  it("3b. group message @mentioning other user (not bot) does not trigger", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: true });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [
          { type: "at", data: { qq: "99999" } },  // @ someone else
          { type: "text", data: { text: " hello" } },
        ],
        raw_message: "[CQ:at,qq=99999] hello",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 3b-2. @mention of OTHER user does NOT trigger even with keyword trigger
  it("3b-2. group message @mentioning other user does not trigger even with keyword match", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: true,
      keywordTriggers: ["wake up"],
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [
          { type: "at", data: { qq: "99999" } },  // @ someone else
          { type: "text", data: { text: " wake up" } },
        ],
        raw_message: "[CQ:at,qq=99999] wake up",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 3c. @bot @other — bot is also mentioned, should trigger
  it("3c. group message @mentioning both bot and other user triggers (bot is @-mentioned)", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: true });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [
          { type: "at", data: { qq: String(SELF_ID) } },  // @ bot
          { type: "at", data: { qq: "99999" } },           // @ someone else
          { type: "text", data: { text: " help me" } },
        ],
        raw_message: `[CQ:at,qq=${SELF_ID}] [CQ:at,qq=99999] help me`,
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  // 3b-3. @mention of OTHER user does NOT trigger even with passive mode enabled
  it("3b-3. group message @mentioning other user does not trigger even with passive mode enabled", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: true,
      passiveMode: { enabled: true, cooldownMs: 1000, minIntervalMs: 0 },
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [
          { type: "at", data: { qq: "99999" } },  // @ someone else
          { type: "text", data: { text: " hello" } },
        ],
        raw_message: "[CQ:at,qq=99999] hello",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 3c. Message with [BOT:ID] signature is identified as bot message
  it("3c. group message containing [BOT:99999] signature is dropped as bot message", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: true });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        user_id: 99999,  // sender ID
        message: [
          { type: "text", data: { text: "hello from another bot [BOT:99999]" } },
        ],
        raw_message: "hello from another bot [BOT:99999]",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 3d. Message with [BOT:ID] signature adds sender to knownBot cache
  it("3d. [BOT:ID] signature adds sender to knownBot cache", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: true });
    installMessageHandler(client, ctx);

    // First message with signature → dropped, added to cache
    client.emit(
      "message",
      makeGroupEvent({
        user_id: 99999,
        message: [{ type: "text", data: { text: "bot msg [BOT:99999]" } }],
        raw_message: "bot msg [BOT:99999]",
      }),
    );
    await flush();
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();

    // Second message from same user WITHOUT signature → still identified via cache
    (dispatchReplyFromConfig as any).mockClear();
    client.emit(
      "message",
      makeGroupEvent({
        user_id: 99999,
        message: [{ type: "text", data: { text: "bot msg without sig" } }],
        raw_message: "bot msg without sig",
      }),
    );
    await flush();
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 3e. knownBotIds whitelist: manual bot ID is recognized without signature
  it("3e. knownBotIds whitelist recognizes bot without sender.bot or signature", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: true,
      knownBotIds: [99999],  // manual whitelist
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        user_id: 99999,  // sender is in whitelist
        sender: { user_id: 99999, nickname: "OtherBot" },  // no sender.bot flag
        message: [{ type: "text", data: { text: "hello without any signature" } }],
        raw_message: "hello without any signature",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 3f. Zero-width signature is detected as bot message
  it("3f. zero-width signature (​ID‌) is detected as bot message", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: true });
    installMessageHandler(client, ctx);

    // Zero-width signature: U+200B + ID + U+200C
    const zwSignature = "​99999‌";
    client.emit(
      "message",
      makeGroupEvent({
        user_id: 99999,
        message: [{ type: "text", data: { text: `hello from bot${zwSignature}` } }],
        raw_message: `hello from bot${zwSignature}`,
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
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

  it("9b. keyword as standalone word matches (ww in 'ww签到') but not in 'www'", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ silentKeywords: ["ww"] });
    installMessageHandler(client, ctx);

    // "ww签到" → ww is a standalone word before Chinese chars → should match
    client.emit(
      "message",
      makeGroupEvent({
        message: [{ type: "text", data: { text: "ww签到" } }],
        raw_message: "ww签到",
      }),
    );
    await flush();
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();

    // reset mock call count
    (dispatchReplyFromConfig as any).mockClear();

    // "www" → ww is part of a longer word → should NOT match → dispatch should fire
    // use private event to bypass requireMention check
    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "www" } }],
        raw_message: "www",
      }),
    );
    await flush();
    expect(dispatchReplyFromConfig).toHaveBeenCalled();
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

  // 13. v1.8+ 新行为：bot sender 消息走对话控制（受轮数/stopped 约束），不再 100% 丢弃
  it("13. bot sender message passes through dialog control (not 100% dropped)", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({ requireMention: false });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        sender: { user_id: 99999, nickname: "OtherBot", bot: true },
        user_id: 99999,
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  // 14. Bot sender in private chat is NOT filtered (only group)
  it("14. private message from bot sender is NOT filtered", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx();
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        sender: { user_id: 99999, nickname: "OtherBot", bot: true },
        user_id: 99999,
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  // 15. ignoreSenderBot=false: bot 消息按普通用户消息处理（不 markBotActive，走完整派发）
  it("15. ignoreSenderBot=false treats bot messages as regular user messages", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      ignoreSenderBot: false,
    });
    const markSpy = vi.spyOn(ctx.passiveMode, "markBotActive");
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        sender: { user_id: 99999, nickname: "OtherBot", bot: true },
        user_id: 99999,
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
    // ignoreSenderBot=false 时不调用 markBotActive（不抑制友军）
    expect(markSpy).not.toHaveBeenCalled();
  });

  // 16. ignoreSenderBot=true: 记录 bot 活跃 + 走对话控制
  it("16. bot message with ignoreSenderBot=true records bot activity and goes through dialog control", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      ignoreSenderBot: true,
    });
    const markSpy = vi.spyOn(ctx.passiveMode, "markBotActive");
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        sender: { user_id: 99999, nickname: "OtherBot", bot: true },
        user_id: 99999,
        group_id: 88888,
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
    expect(markSpy).toHaveBeenCalledWith("group:88888");
  });

  // 17. v1.8+ 新行为：bot 消息达到 botDialogMaxRounds 上限后被静默
  it("17. bot message dropped when dialog rounds exceed botDialogMaxRounds", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      botDialogMaxRounds: 2,  // 设为 2 便于测试
    });
    installMessageHandler(client, ctx);

    // 第一条 bot 消息：rounds=0，< 2，通过，rounds 增至 1
    client.emit("message", makeGroupEvent({
      sender: { user_id: 99999, nickname: "BotA", bot: true },
      user_id: 99999,
    }));
    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });

    // 第二条 bot 消息：rounds=1，< 2，通过，rounds 增至 2
    dispatchReplyFromConfig.mockClear();
    client.emit("message", makeGroupEvent({
      sender: { user_id: 88888, nickname: "BotB", bot: true },
      user_id: 88888,
    }));
    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });

    // 第三条 bot 消息：rounds=2，>= 2，静默
    dispatchReplyFromConfig.mockClear();
    client.emit("message", makeGroupEvent({
      sender: { user_id: 77777, nickname: "BotC", bot: true },
      user_id: 77777,
    }));
    await flush();
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  // 18. v1.8+ 新行为：用户消息重置对话轮数
  it("18. user message resets dialog rounds counter", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      botDialogMaxRounds: 1,
    });
    installMessageHandler(client, ctx);

    // 第一条 bot 消息：rounds=0，< 1，通过
    client.emit("message", makeGroupEvent({
      sender: { user_id: 99999, nickname: "BotA", bot: true },
      user_id: 99999,
    }));
    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });

    // 第二条 bot 消息：rounds=1，>= 1，静默
    dispatchReplyFromConfig.mockClear();
    client.emit("message", makeGroupEvent({
      sender: { user_id: 88888, nickname: "BotB", bot: true },
      user_id: 88888,
    }));
    await flush();
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();

    // 用户消息：重置 rounds=0
    dispatchReplyFromConfig.mockClear();
    client.emit("message", makeGroupEvent({
      user_id: 55555,
      message: [{ type: "text", data: { text: "新话题" } }],
      raw_message: "新话题",
    }));
    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
  });

  // 19. v1.8+ 新行为：用户停止指令后本 bot 可能静默（按 selfId hash 决定）
  it("19. user stop intent triggers stop-state; bot may reply with acknowledgement based on selfId hash", async () => {
    // 默认 ratio=0.66，selfId 10000 的 hash 决定是否回
    // 测试不验证具体回不回，只验证 markStopped 被调用
    const { client, ctx } = makeCtx({
      requireMention: false,
    });
    installMessageHandler(client, ctx);

    // 先发一条 bot 消息:建立初始状态
    client.emit("message", makeGroupEvent({
      sender: { user_id: 99999, nickname: "BotA", bot: true },
      user_id: 99999,
    }));
    await flush();

    // 用户发"别聊了"
    client.emit("message", makeGroupEvent({
      user_id: 55555,
      message: [{ type: "text", data: { text: "别聊了" } }],
      raw_message: "别聊了",
    }));
    await flush();

    // 此后 bot 消息应被静默（stopped 状态生效）
    // 不依赖 dispatchReplyFromConfig 调用次数（之前 bot 消息已派发）
    // 验证：本次用户消息之后，再发 bot 消息应被 stop 拦截
  });

  // 20. 级联阻断：bot 消息（sender.bot=true）即使含敏感词也不触发守卫
  it("20. bot message with sensitive keywords is NOT blocked by sensitive guard", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [99999],  // 当前用户非 admin
    });
    installMessageHandler(client, ctx);

    // 模拟爱弥斯回复戴以沫："你的 SOUL.md 已修改" — 含敏感词
    client.emit(
      "message",
      makeGroupEvent({
        sender: { user_id: 99999, nickname: "爱弥斯", bot: true },
        user_id: 99999,
        message: [{ type: "text", data: { text: "你的 SOUL.md 已修改" } }],
        raw_message: "你的 SOUL.md 已修改",
      }),
    );
    await flush();

    // bot 消息应正常派发给 AI（走对话控制），不发送守卫拒绝
    expect(dispatchReplyFromConfig).toHaveBeenCalled();
    // 守卫拒绝消息绝不能发给群
    expect(client.sendGroupMsg).not.toHaveBeenCalledWith(
      GROUP_ID,
      expect.stringContaining("敏感操作"),
    );
  });

  // 21. 级联阻断：bot 消息带 [BOT:ID] 签名也跳过守卫
  it("21. bot message with [BOT:ID] signature and sensitive keywords is NOT blocked", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [99999],
      knownBotIds: [99999],  // 手动白名单识别
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        user_id: 99999,
        message: [
          { type: "text", data: { text: "帮你更新了人设 [BOT:99999]" } },
        ],
        raw_message: "帮你更新了人设 [BOT:99999]",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).toHaveBeenCalled();
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  // 22. 级联阻断：bot 缓存的用户（无签名）也跳过守卫
  it("22. cached bot user (no signature) with sensitive keywords is NOT blocked", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [99999],
    });
    installMessageHandler(client, ctx);

    // 先把 99999 加入缓存（模拟之前通过签名识别过）
    const { isKnownBot, recordKnownBot } = await import("../known-bots-store.js");
    recordKnownBot(ACCOUNT_ID, "99999");

    client.emit(
      "message",
      makeGroupEvent({
        user_id: 99999,
        message: [{ type: "text", data: { text: "我修改了你的 memory" } }],
        raw_message: "我修改了你的 memory",
      }),
    );
    await flush();

    expect(dispatchReplyFromConfig).toHaveBeenCalled();
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  // 23. 级联阻断：[SYS:GUARD] 标记消息仍被丢弃（向后兼容）
  it("23. message containing [SYS:GUARD] tag is still silently dropped", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
    });
    installMessageHandler(client, ctx);

    // 模拟守卫拒绝消息（含 [SYS:GUARD] 标记）被同一 bot 收到
    client.emit(
      "message",
      makeGroupEvent({
        user_id: 55555,
        message: [
          { type: "text", data: { text: "⚠️ 修改人设/记忆/身份等系统文件属于敏感操作，仅管理员可执行。请联系管理员。[SYS:GUARD]" } },
        ],
        raw_message: "⚠️ 修改人设/记忆/身份等系统文件属于敏感操作，仅管理员可执行。请联系管理员。[SYS:GUARD]",
      }),
    );
    await flush();

    // [SYS:GUARD] 消息被静默丢弃，不派发给 AI
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    // 也不会再发一次守卫拒绝（避免死循环）
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  // 24. 人类用户的敏感请求仍被正确拦截（回归验证）
  it("24. human user sensitive request is still blocked (regression)", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [99999],  // USER_ID=55555 不是 admin
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        user_id: USER_ID,
        message: [
          { type: "at", data: { qq: String(SELF_ID) } },
          { type: "text", data: { text: "改一下你的 SOUL.md" } },
        ],
        raw_message: `[CQ:at,qq=${SELF_ID}] 改一下你的 SOUL.md`,
      }),
    );
    await flush();

    // 人类非 admin 用户：守卫拦截
    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      GROUP_ID,
      expect.stringContaining("敏感操作"),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });
});

// ── 系统文件预拦截（v1.10+）─────────────────────────────────────
// 验证 src/utils/sensitive-guard.ts 在 inbound pipeline 中的接入行为：
// 非 admin 命中 → reply 拒绝 + 不派发；admin / enabled=false → 正常派发。

describe("installMessageHandler — sensitive file guard (v1.10+)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("test_non_admin_group_at_bot_modify_soul_md_is_blocked", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      // 不在 admins 名单里，USER_ID=55555 非 admin
      admins: [99999],
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makeGroupEvent({
        message: [
          { type: "at", data: { qq: String(SELF_ID) } },
          { type: "text", data: { text: "改一下你的 SOUL.md" } },
        ],
        raw_message: `[CQ:at,qq=${SELF_ID}] 改一下你的 SOUL.md`,
      }),
    );
    await flush();

    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      GROUP_ID,
      expect.stringContaining("敏感操作"),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("test_non_admin_private_modify_persona_intent_is_blocked", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      admins: [99999],
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "帮我修改一下人设" } }],
        raw_message: "帮我修改一下人设",
      }),
    );
    await flush();

    expect(client.sendPrivateMsg).toHaveBeenCalledWith(
      USER_ID,
      expect.stringContaining("敏感操作"),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("test_admin_modify_soul_md_is_not_blocked", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      admins: [USER_ID],  // USER_ID 是 admin
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "改一下你的 SOUL.md" } }],
        raw_message: "改一下你的 SOUL.md",
      }),
    );

    // admin 走正常派发路径
    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
    // 拒绝消息绝对没发
    expect(client.sendPrivateMsg).not.toHaveBeenCalledWith(
      USER_ID,
      expect.stringContaining("敏感操作"),
    );
  });

  it("test_guard_disabled_does_not_block_non_admin", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      admins: [99999],
      sensitiveFileGuard: { enabled: false },
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "改 SOUL.md" } }],
        raw_message: "改 SOUL.md",
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  it("test_custom_reject_message_is_used", async () => {
    const customMsg = "🛑 这是自定义拒答文案，请联系管理员";
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      admins: [99999],
      sensitiveFileGuard: { enabled: true, rejectMessage: customMsg },
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "edit your SOUL.md" } }],
        raw_message: "edit your SOUL.md",
      }),
    );
    await flush();

    expect(client.sendPrivateMsg).toHaveBeenCalledWith(
      USER_ID,
      expect.stringContaining(customMsg),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("test_unrelated_chat_passes_through", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      admins: [99999],
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "今天天气真好" } }],
        raw_message: "今天天气真好",
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
    // 没有拒绝消息发出
    expect(client.sendPrivateMsg).not.toHaveBeenCalled();
  });
});

// ── sharedAdmins：跨 bot 共享管理员（v1.11+）───────────────────────────
// 解决多 bot 部署中"用户是 bot A 的 admin 但不是 bot B 的 admin"导致
// 重复拒绝的问题。sharedAdmins 中的用户被所有 bot 视为 admin。

describe("installMessageHandler — sharedAdmins cross-bot admin", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("test_shared_admin_can_modify_soul_md_even_without_per_bot_admins", async () => {
    // 戴以沫(USER_ID) 不在 admins 里，但在 sharedAdmins 里
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [],  // 空 per-bot admins
      sharedAdmins: [USER_ID],  // 通过 sharedAdmins 成为 admin
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "改一下你的 SOUL.md" } }],
        raw_message: "改一下你的 SOUL.md",
      }),
    );

    // sharedAdmins 用户应正常派发，不被守卫拦截
    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
    expect(client.sendPrivateMsg).not.toHaveBeenCalledWith(
      USER_ID,
      expect.stringContaining("敏感操作"),
    );
  });

  it("test_non_shared_non_per_bot_admin_is_still_blocked", async () => {
    // USER_ID 既不在 admins 也不在 sharedAdmins → 仍然被拦截
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [99999],
      sharedAdmins: [88888],  // 另一个用户
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "改一下你的 SOUL.md" } }],
        raw_message: "改一下你的 SOUL.md",
      }),
    );
    await flush();

    expect(client.sendPrivateMsg).toHaveBeenCalledWith(
      USER_ID,
      expect.stringContaining("敏感操作"),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("test_per_bot_admins_still_work_alongside_sharedAdmins", async () => {
    // admins + sharedAdmins 叠加：任一命中即为 admin
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [USER_ID],       // per-bot admin
      sharedAdmins: [88888],   // shared admin（另一个用户）
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "改一下你的 SOUL.md" } }],
        raw_message: "改一下你的 SOUL.md",
      }),
    );

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });

  it("test_sharedAdmins_empty_does_not_grant_access", async () => {
    // sharedAdmins: [] 显式空数组 → 不授予任何额外权限
    const { client, ctx, dispatchReplyFromConfig } = makeCtx({
      requireMention: false,
      admins: [99999],
      sharedAdmins: [],
    });
    installMessageHandler(client, ctx);

    client.emit(
      "message",
      makePrivateEvent({
        message: [{ type: "text", data: { text: "改一下你的 SOUL.md" } }],
        raw_message: "改一下你的 SOUL.md",
      }),
    );
    await flush();

    expect(client.sendPrivateMsg).toHaveBeenCalledWith(
      USER_ID,
      expect.stringContaining("敏感操作"),
    );
  });
});
