import { describe, it, expect, vi } from "vitest";
import type { OneBotClient } from "../client.js";
import type { QQConfig } from "../config.js";
import type { PassiveModeManager } from "../passive-mode.js";
import type { Logger } from "../types/channel-types.js";
import { sendText, type SendTextDeps } from "../outbound/send-text.js";

function makeDeps(overrides: Partial<SendTextDeps> = {}): SendTextDeps {
  return {
    getClient: vi.fn(),
    knownGroupIds: new Set<string>(),
    passiveMode: { markDone: vi.fn(), markSilent: vi.fn() } as unknown as PassiveModeManager,
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    ...overrides,
  };
}

function makeClient(overrides: Record<string, any> = {}): OneBotClient {
  return {
    getSelfId: () => 12345,
    getGroupInfo: vi.fn().mockResolvedValue({ group_id: 67890 }),
    sendGroupForwardMsg: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as unknown as OneBotClient;
}

describe("sendText merged-forward", () => {
  const baseConfig: QQConfig = {
    forwardThreshold: 2000,
    forwardNodeName: "OpenClaw",
    forwardNodeCharLimit: 0,
    maxMessageLength: 4000,
  } as QQConfig;

  it("triggers merged forward when text exceeds threshold in group", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const longText = "a".repeat(2001);

    const result = await sendText(
      { to: "group:67890", text: longText, cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(typeof result.messageId).toBe("string");
    expect(client.sendGroupForwardMsg).toHaveBeenCalledWith(
      67890,
      expect.arrayContaining([expect.objectContaining({ name: "OpenClaw" })]),
    );
  });

  it("does NOT trigger merged forward for private messages", async () => {
    const client = makeClient({ sendPrivateMsg: vi.fn().mockResolvedValue(undefined) });
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const longText = "a".repeat(2001);

    const result = await sendText(
      { to: "private:99999", text: longText, cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(typeof result.messageId).toBe("string");
    expect(client.sendGroupForwardMsg).not.toHaveBeenCalled();
  });

  it("does NOT trigger merged forward when threshold is 0", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const cfg = { ...baseConfig, forwardThreshold: 0 };

    const result = await sendText(
      { to: "group:67890", text: "a".repeat(3000), cfg, botSelfId: 12345 },
      deps,
    );

    expect(typeof result.messageId).toBe("string");
    expect(client.sendGroupForwardMsg).not.toHaveBeenCalled();
  });

  it("falls back to plain chunks when merged forward fails", async () => {
    const client = makeClient({
      sendGroupForwardMsg: vi.fn().mockRejectedValue(new Error("API error")),
    });
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const longText = "a".repeat(2001);

    const result = await sendText(
      { to: "group:67890", text: longText, cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(typeof result.messageId).toBe("string");
    expect(client.sendGroupForwardMsg).toHaveBeenCalled();
    // 降级到 sendGroupMsg 分片
    expect(client.sendGroupMsg).toHaveBeenCalled();
  });

  it("does NOT trigger when text is below threshold", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });

    const result = await sendText(
      { to: "group:67890", text: "short message", cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(typeof result.messageId).toBe("string");
    expect(client.sendGroupForwardMsg).not.toHaveBeenCalled();
  });
});
