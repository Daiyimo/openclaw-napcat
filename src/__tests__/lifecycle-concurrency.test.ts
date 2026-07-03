/**
 * startAccount 并发锁专项测试
 *
 * 验证 P1 #7 修复：同一账号并发 startAccount 不会导致竞态。
 * 使用 vi.doMock + 动态 import 确保 mock 在模块加载前生效。
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import type { SharedState, StartAccountContext } from "../types/channel-types.js";

// ── 不在顶层 import startAccount（等 beforeEach 中 doMock 后再动态导入）─
let startAccount: (ctx: StartAccountContext, shared: SharedState) => Promise<void>;

// ── 测试工具函数 ───────────────────────────────────────────────

function makeShared(): SharedState {
  return {
    clients: new Map(),
    knownGroupIds: new Set(),
    inboundStores: new Map(),
    passiveMode: { cleanup: vi.fn() } as unknown as SharedState["passiveMode"],
    setBotSelfId: vi.fn(),
    startingPromises: new Map(),
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
    // 提供 channelRuntime 绕过 getQQRuntime() 调用
    channelRuntime: {
      activity: { record: vi.fn() },
      session: { resolveStorePath: vi.fn(), recordInboundSession: vi.fn() },
      reply: {
        createReplyDispatcherWithTyping: vi.fn().mockReturnValue({ dispatcher: {}, replyOptions: {} }),
        finalizeInboundContext: vi.fn().mockReturnValue({}),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
    } as any,
    runtime: {},
    ...overrides,
  };
}

// ── 正式测试 ───────────────────────────────────────────────────

describe("startAccount 并发锁 (Promise lock)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // 使用 vi.doMock 显式注册 mock（在 import lifecycle 之前）
    vi.doMock("ws", () => {
      const createMockWs = () => ({
        readyState: 3, // CLOSED — 防止 terminate 触发连接错误
        CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
        send: vi.fn(), close: vi.fn(), terminate: vi.fn(),
        ping: vi.fn(), pong: vi.fn(), addEventListener: vi.fn(),
        on: vi.fn(), once: vi.fn(), off: vi.fn(),
        removeListener: vi.fn(), removeAllListeners: vi.fn(),
        setMaxListeners: vi.fn(), getMaxListeners: vi.fn().mockReturnValue(10),
        listeners: vi.fn().mockReturnValue([]), eventNames: vi.fn().mockReturnValue([]),
        prependListener: vi.fn(), prependOnceListener: vi.fn(),
        url: "", protocol: "", extensions: "", bufferedAmount: 0,
        binaryType: "nodebuffer", setTimeout: vi.fn(),
        setInterval: vi.fn(), clearInterval: vi.fn(), clearTimeout: vi.fn(),
        ref: vi.fn(), unref: vi.fn(),
      });
      return {
        default: createMockWs,
        WebSocket: createMockWs,
        WebSocketServer: vi.fn().mockImplementation(() => ({
          close: vi.fn(() => Promise.resolve()), handle: vi.fn(),
          removeAllListeners: vi.fn(), addresses: vi.fn().mockReturnValue([]),
        })),
      };
    });

    vi.doMock("../client.js", () => {
      const instance = {
        connect: vi.fn(),
        startReverseWs: vi.fn(),
        disconnect: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        off: vi.fn(),
      };
      // 每次调用返回新实例
      const ctor = vi.fn(() => ({ ...instance, on: vi.fn(), off: vi.fn() }));
      return { OneBotClient: ctor };
    });

    vi.doMock("../log-buffer.js", () => ({ installGlobalInterceptor: vi.fn() }));
    vi.doMock("../update-checker.js", () => ({ triggerUpdateCheck: vi.fn() }));
    vi.doMock("../ref-index-store.js", () => ({
      initRefIndexStore: vi.fn(),
      flushRefIndex: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("../known-bots-store.js", () => ({
      initKnownBotsStore: vi.fn(),
      flushKnownBotsStore: vi.fn(),
    }));
    vi.doMock("../known-users.js", () => ({ flushKnownUsers: vi.fn() }));
    vi.doMock("../upload-cache.js", () => ({
      UploadCache: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
    }));
    vi.doMock("../rate-limiter.js", () => ({
      InboundRateLimiter: vi.fn().mockImplementation(() => ({
        check: vi.fn(() => false), reset: vi.fn(),
      })),
    }));
    vi.doMock("../gateway/connection.js", () => ({
      installConnectHandler: vi.fn().mockReturnValue({ groupRouteRefreshTimer: null }),
    }));
    vi.doMock("../gateway/inbound.js", () => ({
      installMessageHandler: vi.fn(),
    }));

    // 所有 mock 注册后，动态导入（获取带 mock 的模块）
    vi.resetModules();
    const mod = await import("../gateway/lifecycle.js");
    startAccount = mod.startAccount;
  });

  afterEach(async () => {
    vi.unmock("ws");
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
    startAccount = undefined as unknown as typeof startAccount;
  });

  it("同一账号并发调用：第二个调用 await 第一个完成后直接返回", async () => {
    const shared = makeShared();
    const ctrl = new AbortController();
    const ctx = makeCtx({ abortSignal: ctrl.signal });

    const p1 = startAccount(ctx, shared);
    await new Promise((r) => setTimeout(r, 20));

    expect(shared.startingPromises.size).toBe(1);
    expect(shared.clients.size).toBe(1);

    const p2 = startAccount(ctx, shared);
    expect(shared.startingPromises.size).toBe(1);
    expect(shared.clients.size).toBe(1);

    ctrl.abort();
    await Promise.all([p1, p2]);

    expect(shared.startingPromises.size).toBe(0);
    expect(shared.clients.size).toBe(0);
  });

  it("不同账号可以并发启动，互不阻塞", async () => {
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

    expect(shared.startingPromises.size).toBe(2);
    expect(shared.startingPromises.has("acc-a")).toBe(true);
    expect(shared.startingPromises.has("acc-b")).toBe(true);

    ctrlA.abort();
    ctrlB.abort();
    await Promise.all([pA, pB]);

    expect(shared.startingPromises.size).toBe(0);
  });

  afterAll(() => {
    vi.unmock("ws");
    vi.unmock("../client.js");
    vi.unmock("../gateway/connection.js");
    vi.unmock("../gateway/inbound.js");
    vi.unmock("../log-buffer.js");
    vi.unmock("../update-checker.js");
    vi.unmock("../ref-index-store.js");
    vi.unmock("../known-bots-store.js");
    vi.unmock("../known-users.js");
    vi.unmock("../upload-cache.js");
    vi.unmock("../rate-limiter.js");
    vi.resetModules();
  });
});
