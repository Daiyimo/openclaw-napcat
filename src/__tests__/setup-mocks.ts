/**
 * 共享 Mock 工厂
 *
 * 集中管理测试中常用的 mock 对象，避免每个测试文件各自定义重复的 mock 结构。
 * 所有 mock 函数默认返回 mockResolvedValue(undefined)，可通过参数覆盖。
 */

import { vi } from "vitest";
import type { Logger } from "./types/channel-types.js";

// ============ Mock Client ============

export interface MockClientOptions {
  getGroupMemberList?: ReturnType<typeof vi.fn>;
  getGroupList?: ReturnType<typeof vi.fn>;
  getGroupInfo?: ReturnType<typeof vi.fn>;
  getFriendList?: ReturnType<typeof vi.fn>;
  sendGroupMsg?: ReturnType<typeof vi.fn>;
  sendPrivateMsg?: ReturnType<typeof vi.fn>;
  sendGuildChannelMsg?: ReturnType<typeof vi.fn>;
  uploadGroupFile?: ReturnType<typeof vi.fn>;
  uploadPrivateFile?: ReturnType<typeof vi.fn>;
  sendGroupAiRecord?: ReturnType<typeof vi.fn>;
  getGroupMsgHistory?: ReturnType<typeof vi.fn>;
  getForwardMsg?: ReturnType<typeof vi.fn>;
  getGroupHonorInfo?: ReturnType<typeof vi.fn>;
  getGroupRootFiles?: ReturnType<typeof vi.fn>;
  getGroupFilesByFolder?: ReturnType<typeof vi.fn>;
  getGroupFileUrl?: ReturnType<typeof vi.fn>;
  deleteGroupFile?: ReturnType<typeof vi.fn>;
  setGroupBan?: ReturnType<typeof vi.fn>;
  setEssenceMsg?: ReturnType<typeof vi.fn>;
  getEssenceMsgList?: ReturnType<typeof vi.fn>;
  getGroupShutList?: ReturnType<typeof vi.fn>;
  getGroupAtAllRemain?: ReturnType<typeof vi.fn>;
  setGroupPortrait?: ReturnType<typeof vi.fn>;
  setGroupRemark?: ReturnType<typeof vi.fn>;
  setGroupSign?: ReturnType<typeof vi.fn>;
  setGroupTodo?: ReturnType<typeof vi.fn>;
  sendAction?: ReturnType<typeof vi.fn>;
  sendWithResponse?: ReturnType<typeof vi.fn>;
  sendViaHttp?: ReturnType<typeof vi.fn>;
  markGroupMsgAsRead?: ReturnType<typeof vi.fn>;
  markPrivateMsgAsRead?: ReturnType<typeof vi.fn>;
  getStrangerInfo?: ReturnType<typeof vi.fn>;
  getGroupMemberInfo?: ReturnType<typeof vi.fn>;
  setMsgEmojiLike?: ReturnType<typeof vi.fn>;
}

/** 创建 mock OneBotClient，所有方法默认 mockResolvedValue(undefined) */
export function makeMockClient(overrides: MockClientOptions = {}): Record<string, unknown> {
  const defaults: Record<string, ReturnType<typeof vi.fn>> = {
    getGroupMemberList: vi.fn().mockResolvedValue([]),
    getGroupList: vi.fn().mockResolvedValue([]),
    getGroupInfo: vi.fn().mockResolvedValue({ group_id: 88888, group_name: "测试群", member_count: 10 }),
    getFriendList: vi.fn().mockResolvedValue([]),
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
    sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
    sendGuildChannelMsg: vi.fn().mockResolvedValue(undefined),
    uploadGroupFile: vi.fn().mockResolvedValue(undefined),
    uploadPrivateFile: vi.fn().mockResolvedValue(undefined),
    sendGroupAiRecord: vi.fn().mockResolvedValue(undefined),
    getGroupMsgHistory: vi.fn().mockResolvedValue({ messages: [] }),
    getForwardMsg: vi.fn().mockResolvedValue([]),
    getGroupHonorInfo: vi.fn().mockResolvedValue({ current_talkative: { nickname: "Top", day_count: 3 } }),
    getGroupRootFiles: vi.fn().mockResolvedValue({ folders: [], files: [] }),
    getGroupFilesByFolder: vi.fn().mockResolvedValue({ folders: [], files: [] }),
    getGroupFileUrl: vi.fn().mockResolvedValue({ url: "https://example.com/file" }),
    deleteGroupFile: vi.fn().mockResolvedValue(undefined),
    setGroupBan: vi.fn().mockResolvedValue(undefined),
    setEssenceMsg: vi.fn().mockResolvedValue(undefined),
    getEssenceMsgList: vi.fn().mockResolvedValue([]),
    getGroupShutList: vi.fn().mockResolvedValue([]),
    getGroupAtAllRemain: vi.fn().mockResolvedValue({ can_at_all: true, remain_at_all_count_for_group: 10 }),
    setGroupPortrait: vi.fn().mockResolvedValue(undefined),
    setGroupRemark: vi.fn().mockResolvedValue(undefined),
    setGroupSign: vi.fn().mockResolvedValue(undefined),
    setGroupTodo: vi.fn().mockResolvedValue(undefined),
    sendAction: vi.fn().mockResolvedValue(undefined),
    sendWithResponse: vi.fn().mockResolvedValue(undefined),
    sendViaHttp: vi.fn().mockResolvedValue({ data: "ok", retcode: 0 }),
    markGroupMsgAsRead: vi.fn().mockResolvedValue(undefined),
    markPrivateMsgAsRead: vi.fn().mockResolvedValue(undefined),
    getStrangerInfo: vi.fn().mockResolvedValue({ user_id: 123, nickname: "TestUser" }),
    getGroupMemberInfo: vi.fn().mockResolvedValue({ user_id: 123, nickname: "TestUser", role: "member" }),
    setMsgEmojiLike: vi.fn().mockResolvedValue(undefined),
  };
  return { ...defaults, ...overrides };
}

// ============ Mock Logger ============

export function makeMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  } as unknown as Logger;
}

// ============ Mock Config ============

export function makeMockConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wsUrl: "ws://localhost:3001",
    httpUrl: "http://localhost:3000",
    reverseWsPort: 3002,
    accessToken: undefined,
    requireReverseWsToken: false,
    admins: [123456],
    sharedAdmins: [],
    requireMention: true,
    keywordTriggers: [],
    enableDeduplication: true,
    enableErrorNotify: true,
    autoApproveRequests: false,
    maxMessageLength: 4000,
    formatMarkdown: false,
    antiRiskMode: false,
    passiveMode: { temperature: 50 },
    botDialogMaxRounds: 5,
    botStopKeywords: ["别聊了", "stop"],
    botStopReply: true,
    ...overrides,
  };
}
