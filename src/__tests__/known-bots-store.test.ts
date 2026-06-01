import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 用临时目录隔离测试
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "known-bots-store-test-"));

vi.mock("../utils/platform.js", () => ({
  getQQBotDataDir: (sub: string) => path.join(tmpDir, sub),
}));

// import 必须在 mock 之后
const {
  initKnownBotsStore,
  isKnownBot,
  recordKnownBot,
  recordBotInfo,
  getBotInfo,
  listKnownBots,
  flushKnownBotsStore,
  resetKnownBotsStore,
  _getCacheForTest,
} = await import("../known-bots-store.js");

beforeEach(() => {
  resetKnownBotsStore();
  // 清理临时文件
  if (fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
    }
  }
});

describe("known-bots-store", () => {
  it("initKnownBotsStore 创建空缓存", () => {
    initKnownBotsStore("acct1");
    expect(_getCacheForTest("acct1")?.size).toBe(0);
  });

  it("recordKnownBot 写入内存缓存", () => {
    initKnownBotsStore("acct1");
    recordKnownBot("acct1", "12345");
    expect(isKnownBot("acct1", "12345")).toBe(true);
  });

  it("isKnownBot 对未知账号返回 false", () => {
    initKnownBotsStore("acct1");
    recordKnownBot("acct1", "12345");
    expect(isKnownBot("acct2", "12345")).toBe(false);
  });

  it("按账号隔离缓存", () => {
    initKnownBotsStore("acct1");
    initKnownBotsStore("acct2");
    recordKnownBot("acct1", "111");
    recordKnownBot("acct2", "222");
    expect(isKnownBot("acct1", "111")).toBe(true);
    expect(isKnownBot("acct1", "222")).toBe(false);
    expect(isKnownBot("acct2", "222")).toBe(true);
  });

  it("重复 record 不重复 add", () => {
    initKnownBotsStore("acct1");
    recordKnownBot("acct1", "12345");
    recordKnownBot("acct1", "12345");
    expect(_getCacheForTest("acct1")?.size).toBe(1);
  });

  it("flushKnownBotsStore 写入文件（5s 节流不阻塞）", () => {
    vi.useFakeTimers();
    try {
      initKnownBotsStore("acct1");
      recordBotInfo("acct1", { selfId: "12345", nickname: "TestBot" });
      // 立即 flush（不等节流 timer）
      flushKnownBotsStore();
      const file = path.join(tmpDir, "data", "known-bots-acct1.json");
      expect(fs.existsSync(file)).toBe(true);
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      expect(data.bots).toBeInstanceOf(Array);
      expect(data.bots[0].selfId).toBe("12345");
      expect(data.bots[0].nickname).toBe("TestBot");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush 5s 后再读能恢复", () => {
    initKnownBotsStore("acct1");
    recordBotInfo("acct1", { selfId: "12345", nickname: "Bot1" });
    recordBotInfo("acct1", { selfId: "67890", nickname: "Bot2" });
    flushKnownBotsStore();

    // 模拟重启
    resetKnownBotsStore();
    initKnownBotsStore("acct1");
    expect(isKnownBot("acct1", "12345")).toBe(true);
    expect(isKnownBot("acct1", "67890")).toBe(true);
    expect(getBotInfo("acct1", "12345")?.nickname).toBe("Bot1");
  });

  it("recordBotInfo 合并 nickname/card 更新", () => {
    initKnownBotsStore("acct1");
    recordBotInfo("acct1", { selfId: "12345", nickname: "OldName" });
    recordBotInfo("acct1", { selfId: "12345", card: "NewCard" });
    const info = getBotInfo("acct1", "12345")!;
    expect(info.nickname).toBe("OldName");  // 保留
    expect(info.card).toBe("NewCard");      // 新增
  });

  it("listKnownBots 返回所有 bot", () => {
    initKnownBotsStore("acct1");
    recordBotInfo("acct1", { selfId: "1", nickname: "A" });
    recordBotInfo("acct1", { selfId: "2", nickname: "B" });
    const bots = listKnownBots("acct1");
    expect(bots.length).toBe(2);
  });

  it("兼容旧格式 { botIds: [...] }", () => {
    const dir = path.join(tmpDir, "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "known-bots-acct1.json"),
      JSON.stringify({ botIds: ["12345", "67890"] }),
    );
    initKnownBotsStore("acct1");
    expect(isKnownBot("acct1", "12345")).toBe(true);
    expect(isKnownBot("acct1", "67890")).toBe(true);
  });

  it("支持数字型 botId", () => {
    initKnownBotsStore("acct1");
    recordKnownBot("acct1", 12345);
    expect(isKnownBot("acct1", 12345)).toBe(true);
    expect(isKnownBot("acct1", "12345")).toBe(true); // string/number 互通
  });

  it("空文件不报错", () => {
    initKnownBotsStore("acct1");
    expect(_getCacheForTest("acct1")?.size).toBe(0);
  });

  it("损坏文件不报错（降级为空缓存）", () => {
    const dir = path.join(tmpDir, "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "known-bots-acct1.json"), "{not valid json");
    initKnownBotsStore("acct1");
    expect(_getCacheForTest("acct1")?.size).toBe(0);
  });
});
