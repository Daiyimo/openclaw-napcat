/**
 * 旁观模式下友军身份误判修复测试
 *
 * 场景：用户 @ 另一个用户/bot（不是自己），旁观模式 bot 不应误判为"叫我吗"。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import EventEmitter from "events";
import type { OneBotClient } from "../client.js";
import type { OneBotEvent } from "../types.js";
import type { InboundContext, PluginRuntimeChannel } from "../types/channel-types.js";
import type { QQConfig } from "../config.js";
import { UploadCache } from "../upload-cache.js";
import { PassiveModeManager } from "../passive-mode.js";

vi.mock("../member-cache.js", () => ({
  populateGroupMemberCache: vi.fn().mockResolvedValue(undefined),
  getCachedMemberName: vi.fn().mockReturnValue(null),
}));

vi.mock("../known-users.js", () => ({ recordKnownUser: vi.fn() }));
vi.mock("../ref-index-store.js", () => ({
  recordRef: vi.fn(),
  lookupRef: vi.fn().mockReturnValue(null),
}));
vi.mock("../message-sender.js", () => ({
  MessageSender: vi.fn().mockImplementation(() => ({ deliver: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock("../typing-keepalive.js", () => ({
  TypingKeepAlive: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));
vi.mock("../deliver-debounce.js", () => ({
  createDeliverDebouncer: vi.fn().mockReturnValue(null),
}));
vi.mock("../utils/pkg-version.js", () => ({ getPackageVersion: vi.fn().mockReturnValue("1.0.0") }));
vi.mock("../update-checker.js", () => ({
  getUpdateInfo: vi.fn().mockResolvedValue({ hasUpdate: false, latest: "1.0.0", error: null }),
}));
vi.mock("../log-buffer.js", () => ({
  getRecentLogs: vi.fn().mockReturnValue([]),
  formatLogEntry: vi.fn().mockImplementation((e: unknown) => String(e)),
}));

import { installMessageHandler } from "../gateway/inbound.js";
import { resetDialogState } from "../dialog-state.js";
import { resetKnownBotsStore } from "../known-bots-store.js";

const SELF_ID = 10000;
const OTHER_USER_ID = 99999;

function makeClient(selfId = SELF_ID): OneBotClient {
  const ee = new EventEmitter() as any;
  ee.getSelfId = vi.fn().mockReturnValue(selfId);
  ee.getStrangerInfo = vi.fn().mockResolvedValue({ user_id: String(OTHER_USER_ID), nickname: "Other" });
  ee.getGroupMemberInfo = vi.fn().mockResolvedValue({ user_id: String(OTHER_USER_ID), nickname: "Other" });
  return ee as OneBotClient;
}

function makeCtx(configOverrides: Partial<QQConfig> = {}): {
  client: OneBotClient;
  ctx: InboundContext;
  dispatchReplyFromConfig: any;
} {
  const passiveMode = new PassiveModeManager();
  const uploadCache = new UploadCache();

  const dispatchReplyFromConfig = vi.fn().mockResolvedValue(undefined);
  const channelRuntime: PluginRuntimeChannel = {
    activity: { record: vi.fn() },
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/store"),
      recordInboundSession: vi.fn().mockResolvedValue(undefined),
    },
    reply: {
      createReplyDispatcherWithTyping: vi.fn().mockReturnValue({
        dispatcher: {},
        replyOptions: {},
      }),
      finalizeInboundContext: vi.fn().mockImplementation((ctx: any) => ctx),
      dispatchReplyFromConfig,
    },
  };

  const config: QQConfig = {
    requireMention: true,
    passiveMode: { enabled: true, cooldownMs: 10_000, minIntervalMs: 30_000, botSuppressionMs: 0 },
    ignoreSenderBot: true,
    enableDeduplication: true,
    maxMessageLength: 4000,
    rateLimitMs: 0,
    markdownMode: "passthrough",
    logBufferSize: 200,
    inboundRateLimitMs: 0,
    enableReactions: true,
    deliverDebounce: { enabled: false, windowMs: 1500, maxWaitMs: 8000 },
    enableUpdateCheck: false,
    botDialogMaxRounds: 5,
    botStopReplyEnabled: true,
    botStopReplyRatio: 0.66,
    botStopReplyDelayMaxMs: 300,
    ...configOverrides,
  } as QQConfig;

  const ctx: InboundContext = {
    client: makeClient(),
    account: { accountId: "acct1", name: "test", enabled: true, configured: true, config },
    config,
    cfg: { channels: { napcat: {} }, session: {} } as any,
    channelRuntime,
    uploadCache,
    inboundStore: { lastTrigger: new Map(), config, processedMsgIds: new Set<string>() },
    processedMsgIds: new Set(),
    knownGroupIds: new Set(),
    passiveMode,
    log: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };

  return { client: ctx.client, ctx, dispatchReplyFromConfig };
}

function makeGroupEventAtOther(): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 88888,
    user_id: 55555,
    self_id: SELF_ID,
    sender: { user_id: 55555, nickname: "User" },
    message_id: 100,
    message: [{ type: "at", data: { qq: String(OTHER_USER_ID) } }, { type: "text", data: { text: " 你好" } }],
    raw_message: `[CQ:at,qq=${OTHER_USER_ID}] 你好`,
    time: Math.floor(Date.now() / 1000),
  } as OneBotEvent;
}

describe("A 修复：旁观模式 @其他用户 不应误派发", () => {
  beforeEach(() => {
    resetDialogState();
    resetKnownBotsStore();
  });

  it("旁观模式下 @其他用户 不进入 AI 派发", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx();
    installMessageHandler(client, ctx);

    client.emit("message", makeGroupEventAtOther());

    // 等待事件循环
    await new Promise((r) => setTimeout(r, 50));

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("旁观模式下 @自己 正常派发", async () => {
    const { client, ctx, dispatchReplyFromConfig } = makeCtx();
    installMessageHandler(client, ctx);

    client.emit("message", {
      post_type: "message",
      message_type: "group",
      group_id: 88888,
      user_id: 55555,
      self_id: SELF_ID,
      sender: { user_id: 55555, nickname: "User" },
      message_id: 100,
      message: [{ type: "at", data: { qq: String(SELF_ID) } }, { type: "text", data: { text: " 你好" } }],
      raw_message: `[CQ:at,qq=${SELF_ID}] 你好`,
      time: Math.floor(Date.now() / 1000),
    } as OneBotEvent);

    await vi.waitFor(() => expect(dispatchReplyFromConfig).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
  });
});
