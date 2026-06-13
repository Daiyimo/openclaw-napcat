/**
 * channel.ts 并发启动锁回归测试（P1）
 *
 * 验证 startingPromises 是模块级共享 Map，
 * 同一账号并发调用 gateway.startAccount 时第二个调用会 await 第一个。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SharedState, StartAccountContext } from "../types/channel-types.js";

// ── Mocks ──────────────────────────────────────────────────────

function setupMocks() {
  vi.doMock("ws", () => {
    const createMockWs = () => ({
      readyState: 3, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
      send: vi.fn(), close: vi.fn(), terminate: vi.fn(),
      ping: vi.fn(), pong: vi.fn(),
      on: vi.fn(), once: vi.fn(), off: vi.fn(), removeAllListeners: vi.fn(),
    });
    return {
      default: createMockWs, WebSocket: createMockWs,
      WebSocketServer: vi.fn().mockImplementation(() => ({
        close: vi.fn(() => Promise.resolve()), on: vi.fn(),
      })),
    };
  });

  vi.doMock("openclaw/plugin-sdk", () => ({
    buildChannelConfigSchema: vi.fn(() => ({})),
    DEFAULT_ACCOUNT_ID: "default",
    normalizeAccountId: (id: string) => id,
    applyAccountNameToChannelSection: vi.fn(),
    migrateBaseNameToDefaultAccount: vi.fn(),
  }));

  vi.doMock("../client.js", () => {
    const instance = {
      connect: vi.fn(), startReverseWs: vi.fn(),
      disconnect: vi.fn(() => Promise.resolve()),
      on: vi.fn(), off: vi.fn(), getSelfId: vi.fn().mockReturnValue(12345),
    };
    return { OneBotClient: vi.fn(() => ({ ...instance })) };
  });

  vi.doMock("../log-buffer.js", () => ({ installGlobalInterceptor: vi.fn() }));
  vi.doMock("../update-checker.js", () => ({ triggerUpdateCheck: vi.fn() }));
  vi.doMock("../ref-index-store.js", () => ({
    initRefIndexStore: vi.fn(), flushRefIndex: vi.fn(() => Promise.resolve()),
  }));
  vi.doMock("../known-bots-store.js", () => ({
    initKnownBotsStore: vi.fn(), flushKnownBotsStore: vi.fn(),
  }));
  vi.doMock("../known-users.js", () => ({ flushKnownUsers: vi.fn() }));
  vi.doMock("../upload-cache.js", () => ({
    UploadCache: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
  }));
  vi.doMock("../rate-limiter.js", () => ({
    InboundRateLimiter: vi.fn().mockImplementation(() => ({
      check: vi.fn(() => ({ allowed: true })),
    })),
  }));
  vi.doMock("../gateway/connection.js", () => ({
    installConnectHandler: vi.fn().mockReturnValue({ groupRouteRefreshTimer: null }),
  }));
  vi.doMock("../gateway/inbound.js", () => ({ installMessageHandler: vi.fn() }));
}

// ── Tests ──────────────────────────────────────────────────────

describe("channel.ts — startingPromises 并发锁回归 (P1)", () => {
  let startAccount: (ctx: StartAccountContext, shared: SharedState) => Promise<void>;
  let sharedPromises: Map<string, Promise<void>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupMocks();
    vi.resetModules();
    const channelMod = await import("../channel.js");
    const lifecycleMod = await import("../gateway/lifecycle.js");
    startAccount = lifecycleMod.startAccount;
    sharedPromises = channelMod.startingPromises;
  });

  afterEach(async () => {
    vi.unmock("ws");
    vi.unmock("openclaw/plugin-sdk");
    vi.unmock("../client.js");
    vi.unmock("../log-buffer.js");
    vi.unmock("../update-checker.js");
    vi.unmock("../ref-index-store.js");
    vi.unmock("../known-bots-store.js");
    vi.unmock("../known-users.js");
    vi.unmock("../upload-cache.js");
    vi.unmock("../rate-limiter.js");
    vi.unmock("../gateway/connection.js");
    vi.unmock("../gateway/inbound.js");
    vi.resetModules();
  });

  function makeShared(): SharedState {
    return {
      clients: new Map(),
      knownGroupIds: new Set(),
      inboundStores: new Map(),
      passiveMode: { cleanup: vi.fn() } as unknown as SharedState["passiveMode"],
      setBotSelfId: vi.fn(),
      startingPromises: sharedPromises,
    };
  }

  function makeCtx(overrides: Partial<StartAccountContext> = {}): StartAccountContext {
    return {
      account: {
        accountId: "acc-1",
        config: { wsUrl: "ws://localhost:3001", enableUpdateCheck: false, logBufferSize: 200 },
      },
      cfg: {} as any,
      accountId: "acc-1",
      abortSignal: new AbortController().signal,
      log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelRuntime: {
        activity: { record: vi.fn() },
        session: { resolveStorePath: vi.fn(), recordInboundSession: vi.fn() },
        reply: {
          createReplyDispatcherWithTyping: vi.fn().mockReturnValue({ dispatcher: {}, replyOptions: {} }),
          finalizeInboundContext: vi.fn().mockReturnValue({}),
          dispatchReplyFromConfig: vi.fn(),
        },
      } as any,
      ...overrides,
    };
  }

  it("startingPromises 是模块级共享 Map，初始为空", async () => {
    expect(sharedPromises).toBeDefined();
    expect(sharedPromises.size).toBe(0);
  });

  it("同一账号并发调用：第二个调用 await 第一个（通过共享 Map 实现）", async () => {
    const shared = makeShared();
    const ctrl = new AbortController();
    const ctx = makeCtx({ abortSignal: ctrl.signal });

    const p1 = startAccount(ctx, shared);
    await new Promise((r) => setTimeout(r, 20));

    expect(sharedPromises.size).toBe(1);
    expect(shared.clients.size).toBe(1);

    const p2 = startAccount(ctx, shared);
    expect(sharedPromises.size).toBe(1);
    expect(shared.clients.size).toBe(1);

    ctrl.abort();
    await Promise.all([p1, p2]);

    expect(sharedPromises.size).toBe(0);
    expect(shared.clients.size).toBe(0);
  });

  it("不同账号并发启动互不阻塞", async () => {
    const shared = makeShared();
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();

    const ctxA = makeCtx({
      accountId: "acc-a",
      abortSignal: ctrlA.signal,
      account: { accountId: "acc-a", config: { wsUrl: "ws://a:3001", enableUpdateCheck: false, logBufferSize: 200 } },
    });
    const ctxB = makeCtx({
      accountId: "acc-b",
      abortSignal: ctrlB.signal,
      account: { accountId: "acc-b", config: { wsUrl: "ws://b:3001", enableUpdateCheck: false, logBufferSize: 200 } },
    });

    const pA = startAccount(ctxA, shared);
    await new Promise((r) => setTimeout(r, 20));
    const pB = startAccount(ctxB, shared);

    expect(sharedPromises.size).toBe(2);
    expect(sharedPromises.has("acc-a")).toBe(true);
    expect(sharedPromises.has("acc-b")).toBe(true);

    ctrlA.abort();
    ctrlB.abort();
    await Promise.all([pA, pB]);

    expect(sharedPromises.size).toBe(0);
  });
});
