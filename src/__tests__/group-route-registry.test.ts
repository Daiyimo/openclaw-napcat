import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerGroupRoute } from "../gateway/group-route-registry.js";

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeChannelRuntime(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/session-store"),
      recordInboundSession: vi.fn().mockResolvedValue(undefined),
    },
    routing: {
      resolveAgentRoute: vi.fn(),
    },
    ...overrides,
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as any,
    cfg: { session: { store: "sqlite" } } as any,
    accountId: "acct1",
    groupId: 123456,
    channelRuntime: makeChannelRuntime(),
    knownGroupIds: new Set<string>(),
    log: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerGroupRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when resolveAgentRoute succeeds", async () => {
    const rt = makeChannelRuntime({
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({ sessionKey: "agent:main:napcat:group:123456", agentId: "main" }),
      },
    });
    const params = makeParams({ channelRuntime: rt });
    const result = await registerGroupRoute(params);
    expect(result).toBe(true);
    expect(rt.session.recordInboundSession).toHaveBeenCalled();
    expect(rt.session.resolveStorePath).toHaveBeenCalledWith("sqlite", { agentId: "main" });
  });

  it("falls back to legacy sessionKey when resolveAgentRoute returns undefined", async () => {
    const rt = makeChannelRuntime({
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue(undefined),
      },
    });
    const params = makeParams({ channelRuntime: rt });
    const result = await registerGroupRoute(params);
    expect(result).toBe(true);
    // Should have recorded session with the fallback key
    expect(rt.session.recordInboundSession).toHaveBeenCalled();
    const call = rt.session.recordInboundSession.mock.calls[0];
    expect(call[0].sessionKey).toBe("napcat:group:123456");
  });

  it("falls back when resolveAgentRoute throws", async () => {
    const rt = makeChannelRuntime({
      routing: {
        resolveAgentRoute: vi.fn().mockImplementation(() => {
          throw new Error("routing unavailable");
        }),
      },
    });
    const params = makeParams({ channelRuntime: rt });
    const result = await registerGroupRoute(params);
    expect(result).toBe(true);
    expect(rt.session.recordInboundSession).toHaveBeenCalled();
    const call = rt.session.recordInboundSession.mock.calls[0];
    expect(call[0].sessionKey).toBe("napcat:group:123456");
  });

  it("returns false when resolveStorePath throws without agentId", async () => {
    const rt = makeChannelRuntime({
      routing: { resolveAgentRoute: vi.fn().mockReturnValue(undefined) },
      session: {
        resolveStorePath: vi.fn().mockImplementation(() => {
          throw new Error("Session storage path requires an explicit agent id.");
        }),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
    });
    const params = makeParams({ channelRuntime: rt });
    const result = await registerGroupRoute(params);
    expect(result).toBe(false);
    expect(rt.session.recordInboundSession).not.toHaveBeenCalled();
  });

  it("adds groupId to knownGroupIds on success", async () => {
    const known = new Set<string>();
    const rt = makeChannelRuntime({
      routing: { resolveAgentRoute: vi.fn().mockReturnValue(undefined) },
    });
    const params = makeParams({ channelRuntime: rt, knownGroupIds: known });
    await registerGroupRoute(params);
    expect(known.has("123456")).toBe(true);
  });

  it("uses string groupId in fallback key", async () => {
    const rt = makeChannelRuntime({
      routing: { resolveAgentRoute: vi.fn().mockReturnValue(undefined) },
    });
    const params = makeParams({ channelRuntime: rt, groupId: "88888888" });
    const result = await registerGroupRoute(params);
    expect(result).toBe(true);
    const call = rt.session.recordInboundSession.mock.calls[0];
    expect(call[0].sessionKey).toBe("napcat:group:88888888");
  });
});
