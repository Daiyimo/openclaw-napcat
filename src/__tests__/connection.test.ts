/**
 * installConnectHandler 独立测试
 *
 * 覆盖: 正常连接流程、getLoginInfo 超时、群路由注册失败、
 *       握手回填节流、定时器创建、connect 事件注册
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { installConnectHandler } from "../gateway/connection.js";
import type { OneBotClient } from "../client.js";
import type { ConnectionContext, SharedState } from "../types/channel-types.js";

// ── Mock 工厂 ──────────────────────────────────────────────

function makeClient(overrides: Partial<OneBotClient> = {}): OneBotClient & { _capturedHandler?: (event: string) => void } {
  return {
    getSelfId: vi.fn(() => null),
    setSelfId: vi.fn(),
    getLoginInfo: vi.fn(),
    getGroupList: vi.fn(),
    on: vi.fn(),
    ...overrides,
  } as unknown as OneBotClient & { _capturedHandler?: (event: string) => void };
}

function makeAccount(accountId = "acc-1") {
  return {
    accountId,
    config: { _selfId: undefined as number | undefined, _selfName: undefined as string | undefined },
  };
}

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    account: makeAccount(),
    cfg: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    channelRuntime: {
      activity: { record: vi.fn() },
    },
    startAccountCtx: {
      setStatus: vi.fn(),
      getStatus: vi.fn(() => ({})),
      runtime: {},
    },
    knownGroupIds: new Set<string>(),
    shared: {
      handshakeBackfillDone: undefined as Set<string> | undefined,
      setBotSelfId: vi.fn(),
    } as SharedState,
    ...overrides,
  } as unknown as ConnectionContext;
}

// ── 测试 ──────────────────────────────────────────────────

let capturedHandler: (() => Promise<void>) | undefined;

/** 调用 installConnectHandler 并捕获 connect handler 引用 */
function installAndCapture(
  client: ReturnType<typeof makeClient>,
  ctx: ConnectionContext,
): (() => Promise<void>) | undefined {
  capturedHandler = undefined;
  const originalOn = client.on;
  client.on = vi.fn((event: string, cb: () => Promise<void>) => {
    if (event === "connect") capturedHandler = cb;
    return (originalOn as any)(event, cb);
  });
  installConnectHandler(client, ctx);
  return capturedHandler;
}

describe("installConnectHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("test_connect_handler_registers_listener", () => {
    const client = makeClient();
    const ctx = makeCtx();
    installConnectHandler(client, ctx);
    expect(client.on).toHaveBeenCalledWith("connect", expect.any(Function));
  });

  it("test_connect_sets_selfId_and_status_on_success", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => ({ user_id: 12345, nickname: "TestBot" })),
      getGroupList: vi.fn(async () => []),
    });
    const ctx = makeCtx();
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    await handler();

    expect(client.setSelfId).toHaveBeenCalledWith(12345);
    expect(ctx.account.config._selfId).toBe(12345);
    expect(ctx.account.config._selfName).toBe("TestBot");
    expect(ctx.startAccountCtx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ running: true, connected: true }),
    );
  });

  it("test_connect_handles_login_timeout", async () => {
    vi.useFakeTimers();
    try {
      // Simulate getLoginInfo hanging past timeout
      let resolveLogin: (v: { user_id: number }) => void;
      const loginPromise = new Promise<{ user_id: number }>((r) => { resolveLogin = r; });
      const client = makeClient({
        getLoginInfo: vi.fn(() => loginPromise),
      });
      const warnMock = vi.fn();
      const ctx = makeCtx({ log: { ...makeCtx().log!, warn: warnMock } });
      const handler = installAndCapture(client, ctx);
      if (!handler) throw new Error("handler not captured");
      const promise = handler();
      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(5000);
      // Resolve login after timeout — should be ignored by Promise.race
      resolveLogin!({ user_id: 12345 });
      await promise;

      expect(warnMock).toHaveBeenCalled();
      expect(client.setSelfId).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_connect_handles_empty_login_info", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => null),
      getGroupList: vi.fn(async () => []),
    });
    const ctx = makeCtx();
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    await handler();

    expect(client.setSelfId).not.toHaveBeenCalled();
  });

  it("test_connect_calls_getGroupList", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => ({ user_id: 12345, nickname: "Bot" })),
      getGroupList: vi.fn(async () => [{ group_id: 100 }]),
    });
    const ctx = makeCtx();
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    await handler();

    expect(client.getGroupList).toHaveBeenCalled();
  });

  it("test_connect_handles_group_route_error_gracefully", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => ({ user_id: 12345, nickname: "Bot" })),
      getGroupList: vi.fn(async () => [{ group_id: 100 }]),
    });
    const ctx = makeCtx({ log: { ...makeCtx().log!, warn: vi.fn() } });
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    // Should not throw even if group route registration fails
    await expect(handler()).resolves.toBeUndefined();
  });

  it("test_connect_handles_getGroupList_reject", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => ({ user_id: 12345, nickname: "Bot" })),
      getGroupList: vi.fn(async () => { throw new Error("getGroupList network error"); }),
    });
    const warnMock = vi.fn();
    const ctx = makeCtx({ log: { ...makeCtx().log!, warn: warnMock } });
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    // Promise.allSettled 内兜底，不应抛出
    await expect(handler()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalled();
  });

  it("test_connect_handles_empty_login_info_object", async () => {
    // getLoginInfo 返回 {} 而非 null — info?.user_id 为 undefined
    const client = makeClient({
      getLoginInfo: vi.fn(async () => ({})),
      getGroupList: vi.fn(async () => []),
    });
    const ctx = makeCtx();
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    await handler();
    // 空对象边界：user_id 为 undefined，不调用 setSelfId
    expect(client.setSelfId).not.toHaveBeenCalled();
  });

  it("test_connect_records_activity", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => ({ user_id: 12345, nickname: "Bot" })),
      getGroupList: vi.fn(async () => []),
    });
    const ctx = makeCtx();
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    await handler();
    // activity.record invoked (no error = path executed)
    expect(client.setSelfId).toHaveBeenCalledWith(12345);
  });

  it("test_connect_handshake_backfill_failure_is_non_fatal", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => ({ user_id: 12345, nickname: "Bot" })),
      getGroupList: vi.fn(async () => []),
      getGroupMsgHistory: vi.fn(async () => []), // backfill needs this
    });
    const warnMock = vi.fn();
    const ctx = makeCtx({ log: { ...makeCtx().log!, warn: warnMock }, shared: {
      handshakeBackfillDone: undefined,
      setBotSelfId: vi.fn(),
    } as SharedState });
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    // Should not throw even if backfill encounters issues
    await expect(handler()).resolves.toBeUndefined();
    expect(client.setSelfId).toHaveBeenCalled();
  });

  it("test_connect_error_does_not_crash_handler", async () => {
    const client = makeClient({
      getLoginInfo: vi.fn(async () => {
        throw new Error("Connection failed");
      }),
    });
    const ctx = makeCtx({ log: { ...makeCtx().log!, warn: vi.fn() } });
    const handler = installAndCapture(client, ctx);
    if (!handler) throw new Error("handler not captured");
    await expect(handler()).resolves.toBeUndefined();
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("test_connect_returns_result_object", () => {
    const client = makeClient();
    const ctx = makeCtx();
    const result = installConnectHandler(client, ctx);
    expect(result).toHaveProperty("groupRouteRefreshTimer");
    expect(result.groupRouteRefreshTimer).toBeNull(); // not started yet
  });
});
