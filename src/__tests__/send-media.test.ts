import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../message-parser.js", () => ({
  parseTarget: vi.fn((to: string) => {
    if (to.startsWith("group:")) return { type: "group", id: to.slice(6) };
    if (to.startsWith("guild:")) return { type: "guild", id: to };
    return { type: "private", id: to };
  }),
  dispatchMessage: vi.fn().mockResolvedValue(undefined),
  resolveMediaUrl: vi.fn((url: string) => Promise.resolve(url)),
  isImageFile: vi.fn((url: string) => /\.(jpg|jpeg|png|gif|webp)$/i.test(url)),
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
}));

import { sendMedia, deleteMessage } from "../outbound/send-media.js";
import { dispatchMessage } from "../message-parser.js";

function makeMockClient() {
  return {
    getGroupInfo: vi.fn().mockResolvedValue({ group_id: 12345, group_name: "Test" }),
    deleteMsg: vi.fn(),
  } as any;
}

describe("sendMedia", () => {
  const knownGroupIds = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    knownGroupIds.clear();
  });

  it("returns sent:true for heartbeat target", async () => {
    const result = await sendMedia(
      { to: "heartbeat", mediaUrl: "https://a.com/img.jpg" },
      { getClient: () => makeMockClient() as any, knownGroupIds },
    );
    expect(result.messageId).toBe("");
  });

  it("returns sent:true for empty to", async () => {
    const result = await sendMedia(
      { to: "", mediaUrl: "https://a.com/img.jpg" },
      { getClient: () => makeMockClient() as any, knownGroupIds },
    );
    expect(result.messageId).toBe("");
  });

  it("throws when client not found", async () => {
    await expect(
      sendMedia(
        { to: "12345", mediaUrl: "https://a.com/img.jpg" },
        { getClient: () => undefined, knownGroupIds },
      ),
    ).rejects.toThrow("not connected");
  });

  it("sends image message", async () => {
    const client = makeMockClient();
    vi.mocked(dispatchMessage).mockResolvedValueOnce("12345");
    const result = await sendMedia(
      { to: "user123", mediaUrl: "https://a.com/photo.jpg" },
      { getClient: () => client as any, knownGroupIds },
    );
    expect(result.messageId).toBe("12345");
    expect(dispatchMessage).toHaveBeenCalled();
  });

  it("sends file message for non-image URL", async () => {
    const client = makeMockClient();
    vi.mocked(dispatchMessage).mockResolvedValueOnce("67890");
    const result = await sendMedia(
      { to: "user123", mediaUrl: "https://a.com/doc.pdf" },
      { getClient: () => client as any, knownGroupIds },
    );
    expect(result.messageId).toBe("67890");
    expect(dispatchMessage).toHaveBeenCalled();
  });

  it("includes text in message when provided", async () => {
    const client = makeMockClient();
    await sendMedia(
      { to: "user123", text: "check this", mediaUrl: "https://a.com/img.png" },
      { getClient: () => client as any, knownGroupIds },
    );
    expect(dispatchMessage).toHaveBeenCalled();
    const msg = vi.mocked(dispatchMessage).mock.calls[0][2] as any[];
    expect(msg.some((s: any) => s.type === "text" && s.data.text === "check this")).toBe(true);
  });

  it("includes reply segment when replyToId provided", async () => {
    const client = makeMockClient();
    await sendMedia(
      { to: "user123", mediaUrl: "https://a.com/img.png", replyToId: "msg-123" },
      { getClient: () => client as any, knownGroupIds },
    );
    const msg = vi.mocked(dispatchMessage).mock.calls[0][2] as any[];
    expect(msg.some((s: any) => s.type === "reply" && s.data.id === "msg-123")).toBe(true);
  });

  it("detects bare number as group when in knownGroupIds", async () => {
    const client = makeMockClient();
    knownGroupIds.add("99999");
    await sendMedia(
      { to: "99999", mediaUrl: "https://a.com/img.jpg" },
      { getClient: () => client as any, knownGroupIds },
    );
    expect(client.getGroupInfo).not.toHaveBeenCalled();
    expect(dispatchMessage).toHaveBeenCalled();
  });

  it("checks group info for unknown bare number", async () => {
    const client = makeMockClient();
    await sendMedia(
      { to: "99999", mediaUrl: "https://a.com/img.jpg" },
      { getClient: () => client as any, knownGroupIds },
    );
    expect(client.getGroupInfo).toHaveBeenCalledWith("99999");
    expect(knownGroupIds.has("99999")).toBe(true);
  });

  it("rejects on send error", async () => {
    vi.mocked(dispatchMessage).mockRejectedValueOnce(new Error("send failed"));
    await expect(
      sendMedia(
        { to: "user123", mediaUrl: "https://a.com/img.jpg" },
        { getClient: () => makeMockClient() as any, knownGroupIds },
      ),
    ).rejects.toThrow("send failed");
  });
});

describe("deleteMessage", () => {
  it("returns error when client not found", () => {
    const result = deleteMessage(
      { messageId: "msg-1" },
      { getClient: () => undefined },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("deletes message successfully", () => {
    const client = makeMockClient();
    const result = deleteMessage(
      { messageId: "msg-1" },
      { getClient: () => client as any },
    );
    expect(result.success).toBe(true);
    expect(client.deleteMsg).toHaveBeenCalledWith("msg-1");
  });

  it("handles delete error", () => {
    const client = makeMockClient();
    client.deleteMsg.mockImplementation(() => { throw new Error("delete failed"); });
    const result = deleteMessage(
      { messageId: "msg-1" },
      { getClient: () => client as any },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("delete failed");
  });
});
