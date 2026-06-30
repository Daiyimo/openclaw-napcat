import { describe, it, expect, vi } from "vitest";
import type { OneBotClient } from "../client.js";
import { sendMergedForward } from "../outbound/send-merged-forward.js";

function makeMockClient(sendGroupForwardMsgImpl: (...args: any[]) => Promise<unknown>): OneBotClient {
  return {
    sendGroupForwardMsg: vi.fn(sendGroupForwardMsgImpl),
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as OneBotClient;
}

describe("sendMergedForward", () => {
  const baseNodeName = "OpenClaw";
  const baseNodeUin = "12345";

  it("returns false for empty texts after trimming", async () => {
    const client = makeMockClient(vi.fn().mockResolvedValue({}));
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["", "  ", ""],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(false);
  });

  it("builds single node when nodeCharLimit=0", async () => {
    const spy = vi.fn().mockResolvedValue({ message_id: 1 });
    const client = makeMockClient(spy);
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["hello world"],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith(67890, [{ name: baseNodeName, uin: baseNodeUin, content: "hello world" }]);
  });

  it("builds multiple nodes when nodeCharLimit > 0 and text exceeds limit", async () => {
    const spy = vi.fn().mockResolvedValue({ message_id: 1 });
    const client = makeMockClient(spy);
    const longText = "a".repeat(3000);
    const result = await sendMergedForward({
      client, groupId: 67890, texts: [longText],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 1000,
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0][1] as Array<{ content: string }>;
    expect(callArgs.length).toBeGreaterThan(1);
  });

  it("returns false when sendGroupForwardMsg throws", async () => {
    const client = makeMockClient(vi.fn().mockRejectedValue(new Error("API error")));
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["hello"],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(false);
  });

  it("merges multiple texts into one node when nodeCharLimit=0", async () => {
    const spy = vi.fn().mockResolvedValue({ message_id: 1 });
    const client = makeMockClient(spy);
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["part1", "part2", "part3"],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith(67890, [{ name: baseNodeName, uin: baseNodeUin, content: "part1part2part3" }]);
  });
});
