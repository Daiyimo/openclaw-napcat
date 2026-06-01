/**
 * bot-handshake.ts 单元测试
 *
 * 覆盖:
 *  - makeBotHandshakeMessage: 构造合法 json 段载荷
 *  - parseBotHandshake: 解析字符串 / 对象两种 data.data 形态
 *  - 节流: shouldSendHandshake / markHandshakeSent
 *  - runHandshakeBackfill: 从历史中提取握手 + 文本签名
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-handshake-test-"));

vi.mock("../utils/platform.js", () => ({
  getQQBotDataDir: (sub: string) => path.join(tmpDir, sub),
}));

const {
  makeBotHandshakeMessage,
  parseBotHandshake,
  shouldSendHandshake,
  markHandshakeSent,
  clearHandshakeThrottle,
  runHandshakeBackfill,
  _resetHandshakeThrottle,
} = await import("../utils/bot-handshake.js");
const { resetKnownBotsStore, isKnownBot, _getCacheForTest } = await import(
  "../known-bots-store.js"
);

beforeEach(() => {
  _resetHandshakeThrottle();
  resetKnownBotsStore();
  if (fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
    }
  }
});

describe("makeBotHandshakeMessage", () => {
  it("返回仅一个 json 段", () => {
    const segs = makeBotHandshakeMessage("12345");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("json");
  });

  it("data.data 是合法 JSON 字符串", () => {
    const segs = makeBotHandshakeMessage("12345");
    const seg = segs[0] as { type: "json"; data: { data: string } };
    expect(typeof seg.data.data).toBe("string");
    const parsed = JSON.parse(seg.data.data);
    expect(parsed.app).toBe("openclaw-napcat");
    expect(parsed.kind).toBe("bot");
    expect(parsed.selfId).toBe("12345");
    expect(parsed.v).toBe(1);
    expect(typeof parsed.signedAt).toBe("number");
  });

  it("数字型 selfId 序列化为字符串", () => {
    const segs = makeBotHandshakeMessage(99999);
    const seg = segs[0] as { type: "json"; data: { data: string } };
    const parsed = JSON.parse(seg.data.data);
    expect(parsed.selfId).toBe("99999");
  });
});

describe("parseBotHandshake", () => {
  it("从字符串 data.data 解析出握手", () => {
    const payload = {
      app: "openclaw-napcat",
      kind: "bot",
      selfId: "111",
      v: 1,
      version: "1.7.0",
      signedAt: 123456,
    };
    const message = [{ type: "json", data: { data: JSON.stringify(payload) } }] as any;
    const result = parseBotHandshake(message);
    expect(result?.selfId).toBe("111");
    expect(result?.app).toBe("openclaw-napcat");
  });

  it("从对象 data.data 解析出握手(已 parse 的情形)", () => {
    const payload = {
      app: "openclaw-napcat",
      kind: "bot",
      selfId: "222",
      v: 1,
      version: "1.7.0",
      signedAt: 123,
    };
    const message = [{ type: "json", data: { data: payload } }] as any;
    const result = parseBotHandshake(message);
    expect(result?.selfId).toBe("222");
  });

  it("非握手 json 段返回 null", () => {
    const message = [{ type: "json", data: { data: JSON.stringify({ foo: "bar" }) } }] as any;
    expect(parseBotHandshake(message)).toBeNull();
  });

  it("缺 app/kind 字段返回 null", () => {
    const message = [
      { type: "json", data: { data: JSON.stringify({ selfId: "x" }) } },
    ] as any;
    expect(parseBotHandshake(message)).toBeNull();
  });

  it("undefined message 返回 null", () => {
    expect(parseBotHandshake(undefined)).toBeNull();
  });

  it("空段数组返回 null", () => {
    expect(parseBotHandshake([])).toBeNull();
  });

  it("包含多个段时正确识别握手段", () => {
    const payload = { app: "openclaw-napcat", kind: "bot", selfId: "333", v: 1, version: "x", signedAt: 0 };
    const message = [
      { type: "text", data: { text: "hello" } },
      { type: "json", data: { data: JSON.stringify(payload) } },
      { type: "text", data: { text: "world" } },
    ] as any;
    expect(parseBotHandshake(message)?.selfId).toBe("333");
  });
});

describe("握手节流", () => {
  it("首次返回 true,标记后立即返回 false", () => {
    expect(shouldSendHandshake("acct1", "111")).toBe(true);
    markHandshakeSent("acct1", "111");
    expect(shouldSendHandshake("acct1", "111")).toBe(false);
  });

  it("按 accountId 隔离", () => {
    markHandshakeSent("acct1", "111");
    expect(shouldSendHandshake("acct2", "111")).toBe(true);
  });

  it("按 groupId 隔离", () => {
    markHandshakeSent("acct1", "111");
    expect(shouldSendHandshake("acct1", "222")).toBe(true);
  });

  it("clearHandshakeThrottle 后立即放行", () => {
    markHandshakeSent("acct1", "111");
    expect(shouldSendHandshake("acct1", "111")).toBe(false);
    clearHandshakeThrottle("acct1", "111");
    expect(shouldSendHandshake("acct1", "111")).toBe(true);
  });

  it("clearHandshakeThrottle 不影响其他群", () => {
    markHandshakeSent("acct1", "111");
    markHandshakeSent("acct1", "222");
    clearHandshakeThrottle("acct1", "111");
    expect(shouldSendHandshake("acct1", "111")).toBe(true);
    expect(shouldSendHandshake("acct1", "222")).toBe(false);
  });
});

describe("runHandshakeBackfill", () => {
  it("从历史 json 段握手中发现 bot", async () => {
    const payload = { app: "openclaw-napcat", kind: "bot", selfId: "99999", v: 1, version: "1.7", signedAt: 0 };
    const fakeClient = {
      getGroupList: vi.fn().mockResolvedValue([{ group_id: 88888 }]),
      getGroupMsgHistory: vi.fn().mockResolvedValue({
        messages: [
          {
            raw_message: JSON.stringify(payload),
            message: [{ type: "json", data: { data: JSON.stringify(payload) } }],
            sender: { user_id: 99999 },
          },
        ],
      }),
    };
    const discovered = await runHandshakeBackfill(fakeClient as any, "acct1");
    expect(discovered).toBe(1);
    expect(isKnownBot("acct1", "99999")).toBe(true);
  });

  it("从历史 [BOT:xxx] 文本签名发现 bot", async () => {
    const fakeClient = {
      getGroupList: vi.fn().mockResolvedValue([{ group_id: 88888 }]),
      getGroupMsgHistory: vi.fn().mockResolvedValue({
        messages: [
          {
            raw_message: "hi there [BOT:12345]",
            message: [{ type: "text", data: { text: "hi there [BOT:12345]" } }],
            sender: { user_id: 12345 },
          },
        ],
      }),
    };
    const discovered = await runHandshakeBackfill(fakeClient as any, "acct1");
    expect(discovered).toBe(1);
    expect(isKnownBot("acct1", "12345")).toBe(true);
  });

  it("已知 bot 不重复计数", async () => {
    // 先手动记录
    const { recordKnownBot } = await import("../known-bots-store.js");
    recordKnownBot("acct1", "77777");
    const fakeClient = {
      getGroupList: vi.fn().mockResolvedValue([{ group_id: 88888 }]),
      getGroupMsgHistory: vi.fn().mockResolvedValue({
        messages: [
          {
            raw_message: "[BOT:77777]",
            message: [{ type: "text", data: { text: "[BOT:77777]" } }],
            sender: { user_id: 77777 },
          },
        ],
      }),
    };
    const discovered = await runHandshakeBackfill(fakeClient as any, "acct1");
    expect(discovered).toBe(0);
  });

  it("单群失败不阻塞其他群", async () => {
    const fakeClient = {
      getGroupList: vi.fn().mockResolvedValue([{ group_id: 1 }, { group_id: 2 }]),
      getGroupMsgHistory: vi
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({
          messages: [
            {
              raw_message: "[BOT:12345]",
              message: [{ type: "text", data: { text: "[BOT:12345]" } }],
              sender: { user_id: 12345 },
            },
          ],
        }),
    };
    const discovered = await runHandshakeBackfill(fakeClient as any, "acct1");
    expect(discovered).toBe(1);
  });
});
