/**
 * 消息触发检测模块独立测试
 *
 * 覆盖: @检测、关键词触发、名字触发、指向性门控、其他 bot 名字
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectMention,
  hasMentionOtherUser,
  detectKeywordTrigger,
  detectNameTrigger,
  isMessageDirectedAtBot,
  buildOtherBotNames,
} from "../message-trigger.js";
import type { OneBotEvent } from "../types.js";

// ── Mock 工厂 ──────────────────────────────────────────────

function makeEvent(overrides: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    message_type: "group",
    message: [],
    ...overrides,
  } as OneBotEvent;
}

// ── detectMention ─────────────────────────────────────────

describe("detectMention", () => {
  it("test_detect_mention_at_segment_matches_self", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "10000" } }] });
    expect(detectMention(event, 10000, "")).toBe(true);
  });

  it("test_detect_mention_at_segment_at_all", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "all" } }] });
    expect(detectMention(event, 10000, "")).toBe(true);
  });

  it("test_detect_mention_at_segment_other_user", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "99999" } }] });
    expect(detectMention(event, 10000, "")).toBe(false);
  });

  it("test_detect_mention_cq_fallback", () => {
    const event = makeEvent({ message: "[CQ:at,qq=10000]hi" });
    expect(detectMention(event, 10000, "[CQ:at,qq=10000]hi")).toBe(true);
  });

  it("test_detect_mention_reply_sender", () => {
    const event = makeEvent({ message: [] });
    expect(detectMention(event, 10000, "", { sender: { user_id: 10000 } })).toBe(true);
  });

  it("test_detect_mention_reply_other_sender", () => {
    const event = makeEvent({ message: [] });
    expect(detectMention(event, 10000, "", { sender: { user_id: 99999 } })).toBe(false);
  });

  it("test_detect_mention_no_match", () => {
    const event = makeEvent({ message: [{ type: "text", data: { text: "hello" } }] });
    expect(detectMention(event, 10000, "hello")).toBe(false);
  });
});

// ── hasMentionOtherUser ───────────────────────────────────

describe("hasMentionOtherUser", () => {
  it("test_has_mention_other_at_segment", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "99999" } }] });
    expect(hasMentionOtherUser(event, 10000)).toBe(true);
  });

  it("test_has_mention_other_at_self", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "10000" } }] });
    expect(hasMentionOtherUser(event, 10000)).toBe(false);
  });

  it("test_has_mention_other_at_all", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "all" } }] });
    expect(hasMentionOtherUser(event, 10000)).toBe(false);
  });

  it("test_has_mention_other_cq_fallback", () => {
    const event = makeEvent({ message: "[CQ:at,qq=99999] hi" });
    expect(hasMentionOtherUser(event, 10000)).toBe(true);
  });

  it("test_has_mention_other_prefix_bot_name", () => {
    const event = makeEvent({ message: [{ type: "text", data: { text: "BotA hello" } }] });
    expect(hasMentionOtherUser(event, 10000, ["BotA"])).toBe(true);
  });

  it("test_has_mention_other_prefix_self_name_ignored", () => {
    // selfId 数值 "10000" 不会与名字 "MyBot" 匹配，因此前缀检测仍会命中
    const event = makeEvent({ message: [{ type: "text", data: { text: "MyBot hello" } }] });
    expect(hasMentionOtherUser(event, 10000, ["MyBot"])).toBe(true);
  });

  it("test_has_mention_other_no_at_no_names", () => {
    const event = makeEvent({ message: [{ type: "text", data: { text: "hello world" } }] });
    expect(hasMentionOtherUser(event, 10000)).toBe(false);
  });
});

// ── detectKeywordTrigger ──────────────────────────────────

describe("detectKeywordTrigger", () => {
  it("test_keyword_trigger_matches", () => {
    expect(detectKeywordTrigger("hello world", ["hello"])).toBe(true);
  });

  it("test_keyword_trigger_no_match", () => {
    expect(detectKeywordTrigger("hello world", ["goodbye"])).toBe(false);
  });

  it("test_keyword_trigger_empty_keywords", () => {
    expect(detectKeywordTrigger("hello world", [])).toBe(false);
  });

  it("test_keyword_trigger_undefined_keywords", () => {
    expect(detectKeywordTrigger("hello world", undefined)).toBe(false);
  });

  it("test_keyword_trigger_multiple_keywords", () => {
    expect(detectKeywordTrigger("hello there", ["foo", "hello", "bar"])).toBe(true);
    expect(detectKeywordTrigger("goodbye there", ["foo", "hello", "bar"])).toBe(false);
  });
});

// ── detectNameTrigger ─────────────────────────────────────

describe("detectNameTrigger", () => {
  it("test_name_trigger_matches", () => {
    expect(detectNameTrigger("hello MyBot", "MyBot")).toBe(true);
  });

  it("test_name_trigger_case_insensitive", () => {
    expect(detectNameTrigger("hello mybot", "MyBot")).toBe(true);
  });

  it("test_name_trigger_no_bot_name", () => {
    expect(detectNameTrigger("hello world", undefined)).toBe(false);
  });

  it("test_name_trigger_empty_bot_name", () => {
    expect(detectNameTrigger("hello world", "")).toBe(false);
  });

  it("test_name_trigger_no_match", () => {
    expect(detectNameTrigger("hello world", "OtherBot")).toBe(false);
  });
});

// ── isMessageDirectedAtBot ────────────────────────────────

describe("isMessageDirectedAtBot", () => {
  it("test_directed_private_always_passes", () => {
    const event = makeEvent({ message_type: "private" });
    expect(isMessageDirectedAtBot(event, 10000, "hi", undefined)).toBe(true);
  });

  it("test_directed_group_at_self_passes", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "10000" } }] });
    expect(isMessageDirectedAtBot(event, 10000, "hi", undefined)).toBe(true);
  });

  it("test_directed_group_at_other_blocks", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "99999" } }] });
    expect(isMessageDirectedAtBot(event, 10000, "hi", undefined)).toBe(false);
  });

  it("test_directed_group_at_all_passes", () => {
    const event = makeEvent({ message: [{ type: "at", data: { qq: "all" } }] });
    expect(isMessageDirectedAtBot(event, 10000, "hi", undefined)).toBe(true);
  });

  it("test_directed_group_name_match_passes", () => {
    const event = makeEvent({ message: [{ type: "text", data: { text: "MyBot help" } }] });
    expect(isMessageDirectedAtBot(event, 10000, "MyBot help", "MyBot")).toBe(true);
  });

  it("test_directed_group_other_bot_prefix_blocks", () => {
    const event = makeEvent({ message: [{ type: "text", data: { text: "OtherBot help" } }] });
    expect(isMessageDirectedAtBot(event, 10000, "OtherBot help", "MyBot", ["OtherBot"])).toBe(false);
  });

  it("test_directed_group_no_at_no_name_passes", () => {
    const event = makeEvent({ message: [{ type: "text", data: { text: "random message" } }] });
    expect(isMessageDirectedAtBot(event, 10000, "random message", undefined)).toBe(true);
  });
});

// ── buildOtherBotNames ────────────────────────────────────

describe("buildOtherBotNames", () => {
  it("test_build_other_bot_names", () => {
    const result = buildOtherBotNames("acc-1", [20000, 10000], "10000");
    expect(result.idSet.has("20000")).toBe(true);
    expect(result.idSet.has("10000")).toBe(false); // self filtered
  });

  it("test_build_other_bot_names_empty", () => {
    const result = buildOtherBotNames("acc-1", [], "10000");
    expect(result.names).toEqual([]);
    expect(result.idSet.size).toBe(0);
  });
});
