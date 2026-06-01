import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectMention,
  detectKeywordTrigger,
  buildFromId,
  buildBodyWithReply,
} from "../message-processor.js";
import type { OneBotEvent } from "../types.js";

// resolveMessageText 是 async + 有外部依赖，单独测试关键分支
import { resolveMessageText } from "../message-processor.js";

// ============ detectMention ============

describe("detectMention", () => {
  const selfId = 12345;

  function makeEvent(overrides: Partial<OneBotEvent> = {}): OneBotEvent {
    return {
      time: 0, self_id: selfId, post_type: "message",
      message_type: "group", group_id: 99, user_id: 1001,
      raw_message: "", message: [],
      ...overrides,
    } as OneBotEvent;
  }

  it("at 段命中 selfId 返回 true", () => {
    const event = makeEvent({
      message: [{ type: "at", data: { qq: String(selfId) } }],
    });
    expect(detectMention(event, selfId, "")).toBe(true);
  });

  it("at 段为 all 返回 true", () => {
    const event = makeEvent({
      message: [{ type: "at", data: { qq: "all" } }],
    });
    expect(detectMention(event, selfId, "")).toBe(true);
  });

  it("CQ string 中包含 selfId 返回 true", () => {
    const event = makeEvent({ message: undefined });
    expect(detectMention(event, selfId, `[CQ:at,qq=${selfId}]`)).toBe(true);
  });

  it("回复了机器人消息返回 true", () => {
    const event = makeEvent({ message: [] });
    const repliedMsg = { sender: { user_id: selfId } };
    expect(detectMention(event, selfId, "", repliedMsg)).toBe(true);
  });

  it("没有 mention 返回 false", () => {
    const event = makeEvent({
      message: [{ type: "at", data: { qq: "9999" } }],
    });
    expect(detectMention(event, selfId, "")).toBe(false);
  });
});

// ============ detectKeywordTrigger ============

describe("detectKeywordTrigger", () => {
  it("包含关键词返回 true", () => {
    expect(detectKeywordTrigger("你好机器人", ["机器人"])).toBe(true);
  });

  it("不包含关键词返回 false", () => {
    expect(detectKeywordTrigger("普通消息", ["机器人"])).toBe(false);
  });

  it("keywords 为 undefined 返回 false", () => {
    expect(detectKeywordTrigger("任意消息", undefined)).toBe(false);
  });

  it("keywords 为空数组返回 false", () => {
    expect(detectKeywordTrigger("任意消息", [])).toBe(false);
  });
});

// ============ buildFromId ============

describe("buildFromId", () => {
  it("私聊返回 userId 字符串", () => {
    expect(buildFromId(false, false, 1001, undefined, undefined, undefined))
      .toBe("1001");
  });

  it("群聊返回 group:groupId", () => {
    expect(buildFromId(true, false, 1001, 88888, undefined, undefined))
      .toBe("group:88888");
  });

  it("频道返回 guild:guildId:channelId", () => {
    expect(buildFromId(false, true, 1001, undefined, "gid1", "ch1"))
      .toBe("guild:gid1:ch1");
  });
});

// ============ buildBodyWithReply ============

describe("buildBodyWithReply", () => {
  it("无 reply、无 systemPrompt、无 history、关闭 guidelines，返回纯文本", () => {
    const result = buildBodyWithReply({
      text: "hello [CQ:at,qq=123]",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: false,
      passivePrompt: undefined,
      responseGuidelines: "",  // 关闭默认约束
    });
    // cleanCQCodes 应去掉 CQ 码并 trim
    expect(result).toBe("hello");
    expect(result).not.toContain("[Replying");
    expect(result).not.toContain("<system>");
  });

  it("默认注入 <response_guidelines> 块(v1.9.1+ 防 CoT 泄漏)", () => {
    const result = buildBodyWithReply({
      text: "hi",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: false,
      passivePrompt: undefined,
      // 不传 responseGuidelines → 应使用默认
    });
    expect(result).toContain("<response_guidelines>");
    expect(result).toContain("回复格式硬性约束");
    // 约束在 body 之前(顶部优先级)
    const idx = result.indexOf("<response_guidelines>");
    const bodyIdx = result.indexOf("hi");
    expect(idx).toBeLessThan(bodyIdx);
  });

  it("传 responseGuidelines 时用自定义内容替换默认", () => {
    const result = buildBodyWithReply({
      text: "x",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: false,
      passivePrompt: undefined,
      responseGuidelines: "我自己的约束",
    });
    expect(result).toContain("我自己的约束");
    expect(result).not.toContain("回复格式硬性约束");
  });

  it("传空字符串可关闭 guidelines 注入", () => {
    const result = buildBodyWithReply({
      text: "x",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: false,
      passivePrompt: undefined,
      responseGuidelines: "",
    });
    expect(result).not.toContain("<response_guidelines>");
  });

  it("有 reply 消息追加 [Replying to] 块", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: {
        raw_message: "原始消息",
        sender: { nickname: "发件人" },
      },
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: false,
      passivePrompt: undefined,
    });
    expect(result).toContain("[Replying to 发件人]");
    expect(result).toContain("原始消息");
    expect(result).toContain("[/Replying]");
  });

  it("有 systemPrompt 时追加 <system> 块（在正文之前）", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: null,
      systemPrompt: "你是助手",
      historyContext: "",
      isPassiveMode: false,
      passivePrompt: undefined,
    });
    expect(result).toContain("<system>你是助手</system>");
    expect(result.indexOf("<system>")).toBeLessThan(result.indexOf("test"));
  });

  it("有 historyContext 时追加 <history> 块", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "Alice: 你好\nBob: 嗨",
      isPassiveMode: false,
      passivePrompt: undefined,
    });
    expect(result).toContain("<history>");
    expect(result).toContain("Alice: 你好");
  });

  it("旁观模式追加 <passive_mode> 块", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: true,
      passivePrompt: "自定义旁观提示",
    });
    expect(result).toContain("<passive_mode>自定义旁观提示</passive_mode>");
  });

  it("旁观模式 passivePrompt 为 undefined 使用默认提示", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: true,
      passivePrompt: undefined,
    });
    expect(result).toContain("<passive_mode>");
    expect(result).toContain("[SILENT]");
  });

  it("旁观模式 mentionsKnownBot 触发 system_hint 提示", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: true,
      passivePrompt: undefined,
      mentionsKnownBot: [
        { selfId: "12345", nickname: "云崽" },
        { selfId: "67890", card: "爱弥斯" },
      ],
    });
    expect(result).toContain("<system_hint>");
    expect(result).toContain("云崽");
    expect(result).toContain("爱弥斯");
  });

  it("非旁观模式忽略 mentionsKnownBot", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: false,
      passivePrompt: undefined,
      mentionsKnownBot: [{ selfId: "12345", nickname: "云崽" }],
    });
    expect(result).not.toContain("<system_hint>");
  });

  it("默认提示包含'加入对话'指引", () => {
    const result = buildBodyWithReply({
      text: "test",
      repliedMsg: null,
      systemPrompt: undefined,
      historyContext: "",
      isPassiveMode: true,
      passivePrompt: undefined,
    });
    // 默认提示中应有关于加入对话的说明
    expect(result).toMatch(/加入对话|插话|加入/);
  });
});

// ============ resolveMessageText ============

describe("resolveMessageText", () => {
  function makeClient() {
    return {
      getForwardMsg: vi.fn(),
      sendWithResponse: vi.fn(),
    } as any;
  }

  function makeConfig(overrides = {}) {
    return { enableSTT: false, ...overrides } as any;
  }

  it("text 段直接拼接", async () => {
    const event = {
      raw_message: "fallback",
      message: [
        { type: "text", data: { text: "hello" } },
        { type: "text", data: { text: " world" } },
      ],
    } as any;
    const result = await resolveMessageText(event, makeClient(), makeConfig());
    expect(result).toBe("hello world");
  });

  it("image 段输出 [图片]", async () => {
    const event = {
      raw_message: "",
      message: [{ type: "image", data: { file: "x.jpg" } }],
    } as any;
    const result = await resolveMessageText(event, makeClient(), makeConfig());
    expect(result).toBe(" [图片]");
  });

  it("video 段输出 [视频消息]", async () => {
    const event = {
      raw_message: "",
      message: [{ type: "video", data: { file: "x.mp4" } }],
    } as any;
    const result = await resolveMessageText(event, makeClient(), makeConfig());
    expect(result).toBe(" [视频消息]");
  });

  it("record 段（STT 关闭）输出 [语音消息]", async () => {
    const event = {
      raw_message: "",
      message: [{ type: "record", data: { url: "http://voice.url" } }],
    } as any;
    const result = await resolveMessageText(event, makeClient(), makeConfig());
    expect(result).toContain("[语音消息]");
  });

  it("forward 段展开最多 10 条，跳过内嵌 forward", async () => {
    const client = makeClient();
    client.getForwardMsg.mockResolvedValue({
      messages: Array.from({ length: 12 }, (_, i) => ({
        sender: { nickname: `User${i}` },
        raw_message: `msg${i}`,
        content: `msg${i}`,
      })),
    });
    const event = {
      raw_message: "",
      message: [{ type: "forward", data: { id: "fwd1" } }],
    } as any;
    const result = await resolveMessageText(event, client, makeConfig());
    expect(result).toContain("[转发聊天记录]:");
    // 最多 10 条
    expect((result.match(/User\d+/g) || []).length).toBeLessThanOrEqual(10);
  });

  it("message 为 undefined 时回退 raw_message", async () => {
    const event = { raw_message: "raw text", message: undefined } as any;
    const result = await resolveMessageText(event, makeClient(), makeConfig());
    expect(result).toBe("raw text");
  });

  it("混合段按顺序拼接", async () => {
    const event = {
      raw_message: "",
      message: [
        { type: "text", data: { text: "看这个" } },
        { type: "image", data: { file: "x.jpg" } },
        { type: "text", data: { text: "怎么样" } },
      ],
    } as any;
    const result = await resolveMessageText(event, makeClient(), makeConfig());
    expect(result).toBe("看这个 [图片]怎么样");
  });

  it("file 段解析不修改原始 event.message 入参", async () => {
    const fileSeg = { type: "file", data: { file_id: "f1", busid: 123 } };
    const event = {
      raw_message: "",
      message: [fileSeg],
    } as any;
    const client = makeClient();
    // sendWithResponse 返回 URL，触发 file 段的 URL 填充逻辑
    client.sendWithResponse.mockResolvedValue({ url: "http://example.com/file.pdf" });

    await resolveMessageText(event, client, makeConfig());

    // 原始 event.message 中的 seg 不应被修改
    expect(event.message[0]).toBe(fileSeg);
    expect(event.message[0].data).toBe(fileSeg.data);
    expect(event.message[0].data.url).toBeUndefined();
  });
});
