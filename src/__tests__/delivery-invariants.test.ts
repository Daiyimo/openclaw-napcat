/**
 * 投递功能不变量测试（P0）
 *
 * 这些测试保护投递功能的核心逻辑不被意外修改。
 * 任何修改 session key 格式、裸数字语义、降级路径的变更都必须通过这些测试。
 *
 * ⚠️ 修改这些测试前，请确认你理解影响范围：
 * - cron 投递到群
 * - sessions_send 跨会话发送
 * - 裸数字目标解析
 */

import { describe, it, expect } from "vitest";
import { resolveOutboundSessionRoute } from "../utils/resolve-session-route.js";
import { parseTarget } from "../message-parser.js";

const AGENT_ID = "default";

// ============ 不变量 1：session key 格式一致性 ============
// resolveOutboundSessionRoute 生成的 session key 必须与 inbound.ts 降级路径一致

describe("不变量 1：session key 格式一致性", () => {
  it("群聊 session key 格式：agent:default:napcat:group:{groupId}", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "group:1081646667");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:group:1081646667");
  });

  it("私聊 session key 格式：agent:default:napcat:direct:{userId}", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "private:12345");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:direct:12345");
  });

  it("频道 session key 格式：agent:default:napcat:channel:{guildId}:{channelId}", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "guild:gid1:ch1");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:channel:gid1:ch1");
  });
});

// ============ 不变量 2：裸数字语义一致性 ============
// parseTarget 和 resolveOutboundSessionRoute 对裸数字的默认解释必须一致

describe("不变量 2：裸数字语义一致性", () => {
  const bareNumbers = ["1081646667", "815833475", "12345", "999999999"];

  for (const num of bareNumbers) {
    it(`裸数字 ${num} 在 parseTarget 和 resolveOutboundSessionRoute 中都识别为 group`, () => {
      // parseTarget 应识别为 group
      const parsed = parseTarget(num);
      expect(parsed.type).toBe("group");
      expect(parsed.groupId).toBe(Number(num));

      // resolveOutboundSessionRoute 应识别为 group
      const route = resolveOutboundSessionRoute(AGENT_ID, num);
      expect(route).not.toBeNull();
      expect(route!.peer.kind).toBe("group");
      expect(route!.peer.id).toBe(num);
      expect(route!.sessionKey).toContain(":group:");
    });
  }
});

// ============ 不变量 3：带前缀目标的正确解析 ============

describe("不变量 3：带前缀目标的正确解析", () => {
  it("group: 前缀识别为群聊", () => {
    const route = resolveOutboundSessionRoute(AGENT_ID, "group:1081646667");
    expect(route!.peer.kind).toBe("group");
    expect(route!.sessionKey).toContain(":group:");

    const parsed = parseTarget("group:1081646667");
    expect(parsed.type).toBe("group");
  });

  it("private: 前缀识别为私聊", () => {
    const route = resolveOutboundSessionRoute(AGENT_ID, "private:12345");
    expect(route!.peer.kind).toBe("direct");
    expect(route!.sessionKey).toContain(":direct:");

    const parsed = parseTarget("private:12345");
    expect(parsed.type).toBe("private");
  });

  it("napcat: 前缀被正确剥离", () => {
    const route = resolveOutboundSessionRoute(AGENT_ID, "napcat:group:1081646667");
    expect(route!.sessionKey).toBe("agent:default:napcat:group:1081646667");
    expect(route!.peer.kind).toBe("group");
  });
});

// ============ 不变量 4：关键群号的稳定性 ============

describe("不变量 4：关键群号的稳定性", () => {
  it("群 1081646667 的 session key 固定不变", () => {
    const route = resolveOutboundSessionRoute(AGENT_ID, "group:1081646667");
    expect(route!.sessionKey).toBe("agent:default:napcat:group:1081646667");
    expect(route!.peer).toEqual({ kind: "group", id: "1081646667" });
    expect(route!.chatType).toBe("group");
    expect(route!.from).toBe("napcat:group:1081646667");
    expect(route!.to).toBe("channel:1081646667");
  });

  it("群 1081646667 的裸数字形式也正确解析", () => {
    const route = resolveOutboundSessionRoute(AGENT_ID, "1081646667");
    expect(route!.sessionKey).toBe("agent:default:napcat:group:1081646667");
    expect(route!.peer.kind).toBe("group");
  });
});

// ============ 不变量 5：边界条件 ============

describe("不变量 5：边界条件", () => {
  it("空字符串返回 null", () => {
    expect(resolveOutboundSessionRoute(AGENT_ID, "")).toBeNull();
  });

  it("纯空白字符串返回 null", () => {
    expect(resolveOutboundSessionRoute(AGENT_ID, "   ")).toBeNull();
  });

  it("未知格式抛出异常", () => {
    expect(() => parseTarget("unknown:12345")).toThrow();
  });
});
