import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageSender, type MessageSenderContext } from "../message-sender.js";

// ============ message-parser mock（避免 resolveMediaUrl 发起真实网络请求）============
vi.mock("../message-parser.js", () => ({
  splitMessage: (text: string, maxLen: number) => {
    if (!text || text.length <= maxLen) return [text || ""];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
    return chunks;
  },
  stripMarkdown: (text: string) => text.replace(/\*\*/g, "").replace(/[_`~#>[\]]/g, ""),
  processAntiRisk: (text: string) => text.replace(/\./g, "\\[dot\\]"),
  isImageFile: (url: string) => /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url),
  isVideoFile: (url: string) => /\.(mp4|avi|mov|mkv|webm)$/i.test(url),
  extractMediaUrlsFromText: () => [],
  resolveMediaUrl: async (url: string) => url,  // passthrough
}));

// ============ Mock 工厂 ============

function makeClient() {
  return {
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
    sendGuildChannelMsg: vi.fn().mockResolvedValue(undefined),
    uploadGroupFile: vi.fn().mockResolvedValue(undefined),
    uploadPrivateFile: vi.fn().mockResolvedValue(undefined),
    sendGroupAiRecord: vi.fn().mockResolvedValue(undefined),
    getSelfId: vi.fn().mockReturnValue(12345),
  } as any;
}

function makeUploadCache() {
  return {
    buildKey: vi.fn((accountId: string, url: string) => `${accountId}:${url}`),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  } as any;
}

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    markdownMode: "passthrough",
    antiRiskMode: false,
    maxMessageLength: 4000,
    rateLimitMs: 0,
    enableTTS: false,
    ...overrides,
  } as any;
}

function makeSender(overrides: Partial<MessageSenderContext> = {}) {
  return new MessageSender({
    client: makeClient(),
    config: makeConfig(),
    uploadCache: makeUploadCache(),
    accountId: "test-account",
    isGroup: true,
    isGuild: false,
    groupId: 88888,
    userId: 1001,
    guildId: undefined,
    channelId: undefined,
    ...overrides,
  });
}

// ============ deliver — 基础路径 ============

describe("MessageSender.deliver", () => {
  it("text only — 调用 sendGroupMsg（群聊）", async () => {
    const client = makeClient();
    const sender = makeSender({ client });
    await sender.deliver({ text: "hello" });
    expect(client.sendGroupMsg).toHaveBeenCalled();
  });

  it("私聊时调用 sendPrivateMsg 而非 sendGroupMsg", async () => {
    const client = makeClient();
    const sender = makeSender({ client, isGroup: false });
    await sender.deliver({ text: "hi" });
    expect(client.sendPrivateMsg).toHaveBeenCalled();
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });

  it("频道时调用 sendGuildChannelMsg", async () => {
    const client = makeClient();
    const sender = makeSender({
      client,
      isGroup: false,
      isGuild: true,
      guildId: "g1",
      channelId: "c1",
    });
    await sender.deliver({ text: "hi" });
    expect(client.sendGuildChannelMsg).toHaveBeenCalled();
  });

  it("无 text 不调用 sendGroupMsg", async () => {
    const client = makeClient();
    const sender = makeSender({ client });
    await sender.deliver({ text: "" });
    expect(client.sendGroupMsg).not.toHaveBeenCalled();
  });
});

// ============ deliver — files ============

describe("MessageSender.deliver — files", () => {
  it("uploadCache 未命中时调用 uploadGroupFile", async () => {
    const client = makeClient();
    const cache = makeUploadCache();
    cache.get.mockReturnValue(null);
    const sender = makeSender({ client, uploadCache: cache });
    await sender.deliver({ files: [{ url: "http://example.com/file.pdf", name: "doc.pdf" }] });
    expect(client.uploadGroupFile).toHaveBeenCalledWith(
      88888, expect.any(String), "doc.pdf",
    );
  });

  it("uploadCache 命中时直接发 file 段（不调 uploadGroupFile）", async () => {
    const client = makeClient();
    const cache = makeUploadCache();
    cache.get.mockReturnValue("cached-file-id");
    const sender = makeSender({ client, uploadCache: cache });
    await sender.deliver({ files: [{ url: "http://example.com/file.pdf", name: "doc.pdf" }] });
    expect(client.uploadGroupFile).not.toHaveBeenCalled();
    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      88888,
      expect.arrayContaining([
        expect.objectContaining({ type: "file" }),
      ]),
    );
  });
});

// ============ sendText — markdown 模式 ============

describe("MessageSender.sendText — markdown mode", () => {
  it("passthrough 模式原文发出（含 **）", async () => {
    const client = makeClient();
    const sender = makeSender({ client, config: makeConfig({ markdownMode: "passthrough" }) });
    await sender.deliver({ text: "**粗体**" });
    const call = client.sendGroupMsg.mock.calls[0];
    const segments: any[] = call[1];
    const textSeg = segments.find((s: any) => s.type === "text");
    expect(textSeg?.data?.text).toContain("**粗体**");
  });

  it("strip 模式去除 markdown 符号", async () => {
    const client = makeClient();
    const sender = makeSender({ client, config: makeConfig({ markdownMode: "strip" }) });
    await sender.deliver({ text: "**粗体**" });
    const call = client.sendGroupMsg.mock.calls[0];
    const segments: any[] = call[1];
    const textSeg = segments.find((s: any) => s.type === "text");
    expect(textSeg?.data?.text).not.toContain("**");
  });
});

// ============ sendText — antiRisk ============

describe("MessageSender.sendText — antiRisk", () => {
  it("antiRiskMode=true 时 URL 中 . 被替换", async () => {
    const client = makeClient();
    const sender = makeSender({ client, config: makeConfig({ antiRiskMode: true }) });
    await sender.deliver({ text: "http://example.com" });
    const call = client.sendGroupMsg.mock.calls[0];
    const segments: any[] = call[1];
    const textSeg = segments.find((s: any) => s.type === "text");
    expect(textSeg?.data?.text).not.toContain("http://example.com");
  });
});

// ============ sendText — 分片 ============

describe("MessageSender.sendText — 分片", () => {
  it("超过 maxMessageLength 时分多次发送", async () => {
    const client = makeClient();
    // 自 id 返回 null，隔离签名追加对分片测试的干扰
    client.getSelfId.mockReturnValue(null);
    const sender = makeSender({
      client,
      config: makeConfig({ maxMessageLength: 10, rateLimitMs: 0 }),
    });
    await sender.deliver({ text: "12345678901234567890" }); // 20 chars > 10
    expect(client.sendGroupMsg).toHaveBeenCalledTimes(2);
  });
});

// ============ sendText — TTS ============

describe("MessageSender.sendText — TTS", () => {
  it("enableTTS=true 且 aiVoiceId 配置时调 sendGroupAiRecord（visible 模式下带签名）", async () => {
    const client = makeClient();
    const sender = makeSender({
      client,
      config: makeConfig({ enableTTS: true, aiVoiceId: "voice1", botSignatureStyle: "visible" }),
    });
    await sender.deliver({ text: "短文本" });
    expect(client.sendGroupAiRecord).toHaveBeenCalledWith(88888, "短文本[BOT:12345]", "voice1");
  });
});

// ============ sendMediaUrl ============

describe("MessageSender.sendMediaUrl", () => {
  it("图片 URL 发送 image 段", async () => {
    const client = makeClient();
    const sender = makeSender({ client });
    await sender.sendMediaUrl("http://example.com/pic.jpg");
    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      88888,
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  });

  it("视频 URL 发送 video 段", async () => {
    const client = makeClient();
    const sender = makeSender({ client });
    await sender.sendMediaUrl("http://example.com/vid.mp4");
    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      88888,
      expect.arrayContaining([expect.objectContaining({ type: "video" })]),
    );
  });

  it("普通文件调 uploadGroupFile", async () => {
    const client = makeClient();
    const sender = makeSender({ client });
    await sender.sendMediaUrl("http://example.com/doc.pdf");
    expect(client.uploadGroupFile).toHaveBeenCalled();
  });

  it("uploadGroupFile 失败时 fallback 到 file 段", async () => {
    const client = makeClient();
    client.uploadGroupFile.mockRejectedValue(new Error("upload fail"));
    const sender = makeSender({ client });
    await sender.sendMediaUrl("http://example.com/doc.pdf");
    expect(client.sendGroupMsg).toHaveBeenCalledWith(
      88888,
      expect.arrayContaining([expect.objectContaining({ type: "file" })]),
    );
  });
});

// ============ sendText — bot 签名追加（修复多 bot 循环对话）============

describe("MessageSender.sendText — bot signature", () => {
  it("群消息默认 visible 模式追加 [BOT:12345] 文本签名（v1.9.2+ 默认行为,无启动 spam）", async () => {
    const client = makeClient();
    const sender = makeSender({ client }); // 默认 visible
    await sender.deliver({ text: "hello" });
    const call = client.sendGroupMsg.mock.calls[0];
    const segments: any[] = call[1];
    const textSeg = segments.find((s: any) => s.type === "text");
    expect(textSeg?.data?.text).toContain("[BOT:12345]");
  });

  it("默认 visible 模式不发送任何 json 段握手(无启动 spam)", async () => {
    const client = makeClient();
    const sender = makeSender({ client }); // 默认 visible
    await sender.deliver({ text: "hello" });
    const calls = client.sendGroupMsg.mock.calls;
    // 不应有 json 段(v1.9.2 删除 metadata 模式)
    const hasJson = calls.some((c: any[]) =>
      Array.isArray(c[1]) && c[1].some((s: any) => s.type === "json"),
    );
    expect(hasJson).toBe(false);
  });

  it("显式 zero-width 模式追加零宽字符签名(用户不可见)", async () => {
    const client = makeClient();
    const sender = makeSender({ client, config: makeConfig({ botSignatureStyle: "zero-width" }) });
    await sender.deliver({ text: "hello" });
    const call = client.sendGroupMsg.mock.calls[0];
    const segments: any[] = call[1];
    const textSeg = segments.find((s: any) => s.type === "text");
    expect(textSeg?.data?.text).toContain("​12345‌");
  });

  it("none 模式不追加文本签名,也无 json 段握手", async () => {
    const client = makeClient();
    const sender = makeSender({ client, config: makeConfig({ botSignatureStyle: "none" }) });
    await sender.deliver({ text: "hello" });
    const calls = client.sendGroupMsg.mock.calls;
    const hasJson = calls.some((c: any[]) =>
      Array.isArray(c[1]) && c[1].some((s: any) => s.type === "json"),
    );
    expect(hasJson).toBe(false);
    const textCall = calls.find((c: any[]) =>
      Array.isArray(c[1]) && c[1].some((s: any) => s.type === "text"),
    );
    const textSeg = textCall?.[1].find((s: any) => s.type === "text");
    expect(textSeg?.data?.text).not.toContain("[BOT:");
  });

  it("群消息 zero-width 模式追加零宽字符签名（用户不可见）", async () => {
    const client = makeClient();
    const sender = makeSender({ client, config: makeConfig({ botSignatureStyle: "zero-width" }) });
    await sender.deliver({ text: "hello" });
    const call = client.sendGroupMsg.mock.calls[0];
    const segments: any[] = call[1];
    const textSeg = segments.find((s: any) => s.type === "text");
    // 零宽字符签名：U+200B + "12345" + U+200C
    expect(textSeg?.data?.text).toContain("​12345‌");
  });

  it("私聊不追加签名", async () => {
    const client = makeClient();
    const sender = makeSender({ client, isGroup: false });
    await sender.deliver({ text: "hi" });
    const call = client.sendPrivateMsg.mock.calls[0];
    // sendPrivateMsg(userId, message) — message 在 call[1]
    expect(call[1]).toBe("hi");
    expect(call[1]).not.toContain("[BOT:");
  });

  it("selfId 未设置时不追加签名", async () => {
    const client = makeClient();
    client.getSelfId.mockReturnValue(null);
    const sender = makeSender({ client });
    await sender.deliver({ text: "hello" });
    const call = client.sendGroupMsg.mock.calls[0];
    const segments: any[] = call[1];
    const textSeg = segments.find((s: any) => s.type === "text");
    expect(textSeg?.data?.text).not.toContain("[BOT:");
  });

  it("分片时 visible 模式签名只在最后一个 chunk 追加（不重复）", async () => {
    const client = makeClient();
    // 原文 15 chars / maxMessageLength=5 → 3 chunks；签名追加到第 3 个
    const sender = makeSender({
      client,
      config: makeConfig({ maxMessageLength: 5, rateLimitMs: 0, botSignatureStyle: "visible" }),
    });
    await sender.deliver({ text: "123456789012345" });
    expect(client.sendGroupMsg).toHaveBeenCalledTimes(3);
    const calls = client.sendGroupMsg.mock.calls.map((c: any[]) => {
      const segs: any[] = c[1];
      return segs.find((s: any) => s.type === "text")?.data?.text ?? "";
    });
    expect(calls[0]).not.toContain("[BOT:");
    expect(calls[1]).not.toContain("[BOT:");
    expect(calls[2]).toContain("[BOT:12345]");
  });
});
