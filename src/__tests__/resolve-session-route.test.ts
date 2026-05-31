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
    expect(result!.to).toBe("channel:88888");
  });

  it("group 目标的 peerId 转小写", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "group:ABC123");
    expect(result!.sessionKey).toBe("agent:default:napcat:group:abc123");
    expect(result!.peer.id).toBe("abc123");
  });

  it("裸数字群号 fallback 为 direct（不应发生，但要有兜底）", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "88888");
    expect(result).not.toBeNull();
    expect(result!.peer.kind).toBe("direct");
    expect(result!.sessionKey).toBe("agent:default:napcat:direct:88888");
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

  it("裸 QQ 号 fallback 为 direct", () => {
    const result = resolveOutboundSessionRoute(AGENT_ID, "12345");
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:default:napcat:direct:12345");
    expect(result!.to).toBe("user:12345");
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
