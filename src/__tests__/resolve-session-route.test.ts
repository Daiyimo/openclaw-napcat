import { describe, it, expect } from "vitest";
import { resolveOutboundSessionRoute } from "../utils/resolve-session-route.js";

// ============ resolveOutboundSessionRoute ============

describe("resolveOutboundSessionRoute", () => {
  const AGENT_ID = "default";

  // ── group 目标 ──

  it("group:群号 生成正确的 session key", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "group:88888");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:group:88888");
    expect(result!.baseSessionKey).toBe("agent:default:napcat:group:88888");
    expect(result!.peer).toEqual({ kind: "group", id: "88888" });
    expect(result!.chatType).toBe("group");
    expect(result!.from).toBe("napcat:group:88888");
    expect(result!.to).toBe("group:88888");
  });

  it("group 目标的 peerId 转小写", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "group:ABC123");
    expect(result!.sessionKey).toBe("agent:default:napcat:group:abc123");
    expect(result!.peer.id).toBe("abc123");
  });

  // ── 裸数字 ──
  // QQ 场景下裸数字默认识别为群聊（cron 投递等主要用例）
  // 如需发私聊，请使用 private:QQ号 格式

  it("裸数字群号默认识别为 group", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "815833475");
    expect(result).not.toBeNull();
    expect(result!.peer.kind).toBe("group");
    expect(result!.peer.id).toBe("815833475");
    expect(result!.sessionKey).toBe("agent:default:napcat:group:815833475");
    expect(result!.from).toBe("napcat:group:815833475");
    expect(result!.to).toBe("group:815833475");
  });

  it("裸数字群号 1081646667 正确识别为 group", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "1081646667");
    expect(result).not.toBeNull();
    expect(result!.peer.kind).toBe("group");
    expect(result!.sessionKey).toBe("agent:default:napcat:group:1081646667");
  });

  // ── private 目标 ──

  it("private:QQ号 生成 direct 类型 session key", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "private:12345");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:direct:12345");
    expect(result!.peer).toEqual({ kind: "direct", id: "12345" });
    expect(result!.chatType).toBe("direct");
    expect(result!.from).toBe("napcat:12345");
    expect(result!.to).toBe("user:12345");
  });

  it("裸数字默认识别为 group", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "12345");
    expect(result).not.toBeNull();
    expect(result!.peer.kind).toBe("group");
    expect(result!.sessionKey).toBe("agent:default:napcat:group:12345");
    expect(result!.to).toBe("group:12345");
  });

  // ── guild 目标 ──

  it("guild:频道ID:子频道ID 生成 channel 类型 session key", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "guild:gid1:ch1");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:channel:gid1:ch1");
    expect(result!.peer).toEqual({ kind: "channel", id: "gid1:ch1" });
    expect(result!.chatType).toBe("channel");
    expect(result!.from).toBe("napcat:channel:gid1:ch1");
    expect(result!.to).toBe("channel:gid1:ch1");
  });

  // ── channel 目标 ──

  it("channel:ID 生成 channel 类型 session key", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "channel:ch1");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:channel:ch1");
    expect(result!.peer).toEqual({ kind: "channel", id: "ch1" });
  });

  // ── napcat 前缀 stripping ──

  it("napcat:group:群号 正确剥离前缀", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "napcat:group:88888");
    expect(result!.sessionKey).toBe("agent:default:napcat:group:88888");
  });

  // ── peerId trim 回归测试 ──

  it("group: 88888 带空格的群号应 trim 后解析", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "group: 88888");
    expect(result).not.toBeNull();
    expect(result!.peer.id).toBe("88888");
    expect(result!.peer.kind).toBe("group");
  });

  it("private: 12345 带空格的私聊号应 trim 后解析", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "private: 12345 ");
    expect(result).not.toBeNull();
    expect(result!.peer.id).toBe("12345");
    expect(result!.peer.kind).toBe("direct");
  });

  it("napcat:group: 88888 双层前缀应 trim 后解析", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "napcat:group: 88888");
    expect(result).not.toBeNull();
    expect(result!.peer.id).toBe("88888");
    expect(result!.peer.kind).toBe("group");
  });

  // ── agentId 冒号校验 ──

  it("agentId 含冒号返回 null", () => {
    expect(resolveOutboundSessionRoute("agent:evil", "group:88888")).toBeNull();
  });

  // ── 边界条件 ──

  it("空字符串返回 null", () => {
    expect(resolveOutboundSessionRoute(AGENT_ID, "")).toBeNull();
  });

  it("纯空白字符串返回 null", () => {
    expect(resolveOutboundSessionRoute(AGENT_ID, "   ")).toBeNull();
  });

  it("自定义 agentId 正确嵌入 session key", () => {
    const result = resolveOutboundSessionRoute("my-agent", "group:12345");
    expect(result!.sessionKey).toBe("agent:my-agent:napcat:group:12345");
  });
});
