import { describe, it, expect, beforeEach } from "vitest";
import {
  getDialogState,
  recordBotTurn,
  recordUserMessage,
  markStopped,
  isStopped,
  cleanupDialogState,
  resetDialogState,
  _getRawStateForTest,
} from "../dialog-state.js";

beforeEach(() => {
  resetDialogState();
});

describe("dialog-state — 群级状态", () => {
  it("getDialogState 创建默认状态", () => {
    const s = getDialogState("acct1", "group1");
    expect(s.rounds).toBe(0);
    expect(s.stoppedAt).toBeNull();
    expect(s.lastSpeakerId).toBeNull();
  });

  it("recordBotTurn 增加轮数 + 记录 lastSpeakerId", () => {
    recordBotTurn("acct1", "group1", "botA");
    recordBotTurn("acct1", "group1", "botB");
    const s = _getRawStateForTest("acct1", "group1")!;
    expect(s.rounds).toBe(2);
    expect(s.lastSpeakerId).toBe("botB");
  });

  it("recordUserMessage 重置轮数 + 解除 stopped", () => {
    recordBotTurn("acct1", "group1", "botA");
    markStopped("acct1", "group1");
    recordUserMessage("acct1", "group1");
    const s = _getRawStateForTest("acct1", "group1")!;
    expect(s.rounds).toBe(0);
    expect(s.stoppedAt).toBeNull();
  });

  it("markStopped + isStopped", () => {
    markStopped("acct1", "group1");
    expect(isStopped("acct1", "group1", 60_000)).toBe(true);
    expect(isStopped("acct1", "group1", 0)).toBe(false);
  });

  it("isStopped 在时间窗口外返回 false", async () => {
    markStopped("acct1", "group1");
    // 不实际 sleep（避免拖慢测试），用 -1 ms 窗口模拟已过期
    expect(isStopped("acct1", "group1", -1)).toBe(false);
  });

  it("按 accountId+groupId 隔离状态", () => {
    recordBotTurn("acct1", "group1", "botA");
    recordBotTurn("acct2", "group2", "botX");
    expect(_getRawStateForTest("acct1", "group1")!.rounds).toBe(1);
    expect(_getRawStateForTest("acct2", "group2")!.rounds).toBe(1);
    expect(_getRawStateForTest("acct1", "group2")).toBeUndefined();
  });

  it("cleanupDialogState 删除过期状态", async () => {
    recordBotTurn("acct1", "group1", "botA");
    // 手动设置 lastBotMsgAt 为很久之前
    const s = _getRawStateForTest("acct1", "group1")!;
    s.lastBotMsgAt = Date.now() - 2 * 60 * 60 * 1000;  // 2 小时前
    cleanupDialogState(60 * 60 * 1000);  // 1 小时
    expect(_getRawStateForTest("acct1", "group1")).toBeUndefined();
  });

  it("cleanupDialogState 不删除活跃状态", () => {
    recordBotTurn("acct1", "group1", "botA");
    cleanupDialogState(60 * 60 * 1000);
    expect(_getRawStateForTest("acct1", "group1")).toBeDefined();
  });
});
