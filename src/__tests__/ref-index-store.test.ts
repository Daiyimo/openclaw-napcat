import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 在每个测试前重置模块状态，避免缓存污染
let tmpDir: string;
let store: typeof import("../ref-index-store.js");

// 通过环境变量注入临时目录（mock platform.ts）
vi.mock("../utils/platform.js", () => ({
  getQQBotDataDir: vi.fn(() => tmpDir),
}));

beforeEach(async () => {
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ref-index-test-"));
  // 重新加载模块以重置所有模块级变量
  vi.resetModules();
  store = await import("../ref-index-store.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordRef + lookupRef", () => {
  it("recordRef 后内存中立即可查（不等待 flush）", () => {
    store.recordRef({
      msgId: "msg1",
      text: "hello",
      sender: "Alice",
      timestamp: Date.now(),
    });
    const result = store.lookupRef("msg1");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("hello");
  });

  it("lookupRef 命中返回正确 RefEntry", () => {
    const now = Date.now();
    store.recordRef({ msgId: "msg2", text: "world", sender: "Bob", timestamp: now });
    const result = store.lookupRef("msg2");
    expect(result).toMatchObject({ msgId: "msg2", text: "world", sender: "Bob" });
  });

  it("lookupRef 未找到返回 null", () => {
    expect(store.lookupRef("nonexistent")).toBeNull();
  });

  it("lookupRef TTL 过期返回 null 并从缓存删除", () => {
    const TTL_MS = 7 * 24 * 60 * 60 * 1000;
    store.recordRef({ msgId: "msg3", text: "old", sender: "C", timestamp: 0 });
    vi.advanceTimersByTime(TTL_MS + 1_000);
    expect(store.lookupRef("msg3")).toBeNull();
    // 再次查询仍为 null（不是重新加载）
    expect(store.lookupRef("msg3")).toBeNull();
  });
});

describe("写队列（queueLine / flushWriteQueue）", () => {
  it("recordRef 不同步写文件（调用后文件尚未出现）", () => {
    store.recordRef({ msgId: "m1", text: "t", sender: "s", timestamp: Date.now() });
    // 异步写队列：调用 recordRef 后文件不应立即存在
    const filePath = path.join(tmpDir, "ref-index.jsonl");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("100ms 后批量写入文件", async () => {
    store.recordRef({ msgId: "m1", text: "a", sender: "s", timestamp: Date.now() });
    store.recordRef({ msgId: "m2", text: "b", sender: "s", timestamp: Date.now() });
    // 触发 100ms 定时器（flushWriteQueue 被调度）
    await vi.advanceTimersByTimeAsync(150);
    // setTimeout 的回调是 fire-and-forget，内部 async I/O 需要真实事件循环完成
    vi.useRealTimers();
    await new Promise(resolve => setTimeout(resolve, 50));
    vi.useFakeTimers();
    // Check the file was written
    const filePath = path.join(tmpDir, "ref-index.jsonl");
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    expect(content).toContain("m1");
    expect(content).toContain("m2");
  });

  it("空队列不写文件", async () => {
    await vi.advanceTimersByTimeAsync(200);
    const filePath = path.join(tmpDir, "ref-index.jsonl");
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("flushRefIndex", () => {
  it("flushRefIndex 调用后队列被清空（文件内容存在）", async () => {
    store.recordRef({ msgId: "mx", text: "flush", sender: "s", timestamp: Date.now() });
    await store.flushRefIndex();
    const filePath = path.join(tmpDir, "ref-index.jsonl");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("mx");
  });
});

describe("getRefIndexStats", () => {
  it("返回正确的 size 和 filePath", () => {
    store.recordRef({ msgId: "s1", text: "x", sender: "s", timestamp: Date.now() });
    const stats = store.getRefIndexStats();
    expect(stats.size).toBe(1);
    expect(stats.filePath).toContain("ref-index.jsonl");
  });
});

describe("损坏的 JSONL 行", () => {
  it("跳过损坏行，正常加载其余条目", () => {
    const filePath = path.join(tmpDir, "ref-index.jsonl");
    const validLine = JSON.stringify({ k: "good", v: { msgId: "good", text: "ok", sender: "s", timestamp: Date.now() }, t: Date.now() });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(filePath, `not-valid-json\n${validLine}\n`);
    store.initRefIndexStore();
    const stats = store.getRefIndexStats();
    expect(stats.size).toBe(1);
  });
});
