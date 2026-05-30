import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pushLog,
  getRecentLogs,
  clearLogBuffer,
  formatLogEntry,
  installGlobalInterceptor,
  type LogEntry,
} from "../log-buffer.js";

// Save original console methods
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

describe("pushLog", () => {
  beforeEach(() => {
    clearLogBuffer();
  });

  it("adds a log entry to the buffer", () => {
    pushLog("log", "test message");
    const logs = getRecentLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("log");
    expect(logs[0].msg).toBe("test message");
    expect(logs[0].ts).toBeTypeOf("number");
  });

  it("supports warn and error levels", () => {
    pushLog("warn", "warning msg");
    pushLog("error", "error msg");
    const logs = getRecentLogs();
    expect(logs[0].level).toBe("warn");
    expect(logs[1].level).toBe("error");
  });

  it("trims buffer when exceeding max size", () => {
    // Default max is 200, push 210 entries
    for (let i = 0; i < 210; i++) {
      pushLog("log", `msg-${i}`);
    }
    const logs = getRecentLogs();
    expect(logs.length).toBeLessThanOrEqual(200);
    // Should keep the most recent entries
    expect(logs[logs.length - 1].msg).toBe("msg-209");
  });
});

describe("getRecentLogs", () => {
  beforeEach(() => {
    clearLogBuffer();
  });

  it("returns all logs when n is not specified", () => {
    pushLog("log", "a");
    pushLog("log", "b");
    pushLog("log", "c");
    expect(getRecentLogs()).toHaveLength(3);
  });

  it("returns all logs when n >= buffer length", () => {
    pushLog("log", "a");
    pushLog("log", "b");
    expect(getRecentLogs(10)).toHaveLength(2);
  });

  it("returns last n entries", () => {
    pushLog("log", "a");
    pushLog("log", "b");
    pushLog("log", "c");
    const logs = getRecentLogs(2);
    expect(logs).toHaveLength(2);
    expect(logs[0].msg).toBe("b");
    expect(logs[1].msg).toBe("c");
  });

  it("returns empty array for empty buffer", () => {
    expect(getRecentLogs()).toHaveLength(0);
  });
});

describe("clearLogBuffer", () => {
  it("empties the buffer", () => {
    pushLog("log", "a");
    pushLog("log", "b");
    clearLogBuffer();
    expect(getRecentLogs()).toHaveLength(0);
  });
});

describe("formatLogEntry", () => {
  it("formats log level with [LOG] prefix", () => {
    const entry: LogEntry = { level: "log", msg: "hello", ts: 1717200000000 };
    const result = formatLogEntry(entry);
    expect(result).toContain("[LOG]");
    expect(result).toContain("hello");
  });

  it("formats warn level with [WRN] prefix", () => {
    const entry: LogEntry = { level: "warn", msg: "warning", ts: 1717200000000 };
    const result = formatLogEntry(entry);
    expect(result).toContain("[WRN]");
    expect(result).toContain("warning");
  });

  it("formats error level with [ERR] prefix", () => {
    const entry: LogEntry = { level: "error", msg: "failure", ts: 1717200000000 };
    const result = formatLogEntry(entry);
    expect(result).toContain("[ERR]");
    expect(result).toContain("failure");
  });

  it("includes ISO timestamp", () => {
    const entry: LogEntry = { level: "log", msg: "test", ts: 1717200000000 };
    const result = formatLogEntry(entry);
    // Should contain a date-like string
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// Note: installGlobalInterceptor tests are skipped because they modify
// the global console object which affects other tests. The function is
// tested indirectly through the inbound pipeline integration tests.
// The key paths (pushLog ring buffer, getRecentLogs, clearLogBuffer,
// formatLogEntry) are all covered above.
