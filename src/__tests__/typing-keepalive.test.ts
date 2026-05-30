import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypingKeepAlive } from "../typing-keepalive.js";

function makeMockClient() {
  return {
    sendAction: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("TypingKeepAlive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing for group chat", () => {
    const client = makeMockClient();
    const typing = new TypingKeepAlive(client, true, 12345, 67890);
    typing.start();
    expect(client.sendAction).not.toHaveBeenCalled();
  });

  it("sends typing status immediately for private chat", () => {
    const client = makeMockClient();
    const typing = new TypingKeepAlive(client, false, undefined, 67890);
    typing.start();
    expect(client.sendAction).toHaveBeenCalledWith("set_input_status", {
      user_id: "67890",
      event_type: 1,
    });
  });

  it("sends periodic typing updates every 50 seconds", () => {
    const client = makeMockClient();
    const typing = new TypingKeepAlive(client, false, undefined, 67890);
    typing.start();
    expect(client.sendAction).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50_000);
    expect(client.sendAction).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(50_000);
    expect(client.sendAction).toHaveBeenCalledTimes(3);
  });

  it("stops sending after stop()", () => {
    const client = makeMockClient();
    const typing = new TypingKeepAlive(client, false, undefined, 67890);
    typing.start();
    expect(client.sendAction).toHaveBeenCalledTimes(1);

    typing.stop();
    vi.advanceTimersByTime(100_000);
    expect(client.sendAction).toHaveBeenCalledTimes(1);
  });

  it("start is idempotent after stop", () => {
    const client = makeMockClient();
    const typing = new TypingKeepAlive(client, false, undefined, 67890);
    typing.start();
    typing.stop();
    typing.start(); // should not restart
    expect(client.sendAction).toHaveBeenCalledTimes(1);
  });

  it("does not send when userId is undefined", () => {
    const client = makeMockClient();
    const typing = new TypingKeepAlive(client, false, undefined, undefined);
    typing.start();
    expect(client.sendAction).not.toHaveBeenCalled();
  });

  it("ignores sendAction errors silently", () => {
    const client = makeMockClient();
    client.sendAction.mockRejectedValue(new Error("network error"));
    const typing = new TypingKeepAlive(client, false, undefined, 67890);
    expect(() => typing.start()).not.toThrow();
  });
});
