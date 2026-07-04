import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendText } from "../outbound/send-text.js";
import type { PassiveModeManager } from "../passive-mode.js";

// ============ Mocks ============

function makePassiveMode() {
  return {
    markSilent: vi.fn(),
    markDone: vi.fn(),
    isBotSuppressed: vi.fn().mockReturnValue(false),
    isAllowed: vi.fn().mockReturnValue(true),
    isIntervalAllowed: vi.fn().mockReturnValue(true),
  } as unknown as PassiveModeManager;
}

function makeClient() {
  return {
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
    sendGuildChannelMsg: vi.fn().mockResolvedValue(undefined),
    dispatchMessage: vi.fn().mockResolvedValue(undefined),
    getGroupInfo: vi.fn().mockResolvedValue({ group_id: "88888" }),
  } as any;
}

const knownGroupIds = new Set<string>();

function makeDeps(overrides: { getClient?: any; knownGroupIds?: Set<string>; passiveMode?: PassiveModeManager } = {}) {
  return {
    getClient: overrides.getClient || (() => makeClient()),
    knownGroupIds: overrides.knownGroupIds || knownGroupIds,
    passiveMode: overrides.passiveMode || makePassiveMode(),
  };
}

// ============ Tests ============

describe("sendText — passive mode silent interception", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    knownGroupIds.clear();
  });

  it("intercepts [SILENT] and returns sent:true without calling client", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "[SILENT]" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).toHaveBeenCalled();
  });

  it("intercepts NO_REPLY (case-insensitive) and returns sent:true without calling client", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "NO_REPLY" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).toHaveBeenCalled();
  });

  it("intercepts no_reply (lowercase)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "no_reply" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  it("does NOT intercept text containing silent as substring", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "please stay silent" },
      deps,
    );
    expect(result.sent).toBe(true);
    expect(client.sendGroupMsg).toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).not.toHaveBeenCalled();
  });

  it("marks passiveMode.markDone for normal replies", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    await sendText(
      { to: "group:88888", text: "hello there" },
      deps,
    );
    expect(deps.passiveMode.markDone).toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).not.toHaveBeenCalled();
  });

  it("intercepts NO_REPLY with trailing punctuation (NO_REPLY.)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "NO_REPLY." },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).toHaveBeenCalled();
  });

  it("intercepts NO_REPLY with exclamation mark (NO_REPLY!)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "NO_REPLY!" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  it("intercepts NO_REPLY with space separator (NO REPLY)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "NO REPLY" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  it("intercepts NO_REPLY with underscore (NO_REPLY)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "NO_REPLY" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  it("does NOT intercept NO_REPLY as substring (say NO_REPLY please)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "say NO_REPLY please" },
      deps,
    );
    expect(result.sent).toBe(true);
    expect(client.sendGroupMsg).toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).not.toHaveBeenCalled();
  });

  it("intercepts NO_REPLY with Chinese period (NO_REPLY。)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "NO_REPLY。" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).toHaveBeenCalled();
  });

  it("intercepts NO_REPLY with Chinese comma (NO_REPLY，)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "NO_REPLY，" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).toHaveBeenCalled();
  });

  it("intercepts no_reply with Chinese exclamation (no_reply！)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: "no_reply！" },
      deps,
    );
    expect(result).toEqual({ channel: "napcat", sent: true });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
    expect(deps.passiveMode.markSilent).toHaveBeenCalled();
  });
});

describe("sendText — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    knownGroupIds.clear();
  });

  it("returns sent:true for empty to", async () => {
    const result = await sendText({ to: "", text: "hello" }, makeDeps());
    expect(result).toEqual({ channel: "napcat", sent: true });
  });

  it("returns sent:true for heartbeat target", async () => {
    const result = await sendText({ to: "heartbeat", text: "hello" }, makeDeps());
    expect(result).toEqual({ channel: "napcat", sent: true });
  });

  it("returns error when client not found", async () => {
    const deps = makeDeps({ getClient: () => undefined });
    const result = await sendText({ to: "group:88888", text: "hello" }, deps);
    expect(result.sent).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("handles numeric text without crashing (regression for TypeError on .trim)", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: () => client });
    const result = await sendText(
      { to: "group:88888", text: 207.44 as any },
      deps,
    );
    expect(result.sent).toBe(true);
    expect(client.sendGroupMsg).toHaveBeenCalled();
  });
});
