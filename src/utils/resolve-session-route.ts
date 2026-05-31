/**
 * Session route 解析（供 cron 投递和测试使用）
 *
 * 复刻框架 resolveFallbackSession 逻辑，确保 session key 格式一致：
 *   agent:{agentId}:napcat:{peerKind}:{peerId}
 */

export interface ResolvedSessionRoute {
  sessionKey: string;
  baseSessionKey: string;
  peer: { kind: string; id: string };
  chatType: string;
  from: string;
  to: string;
}

/**
 * 根据目标字符串解析 session 路由信息。
 *
 * @param agentId 代理 ID（如 "default"）
 * @param target  目标字符串（如 "group:88888"、"private:12345"、"napcat:group:88888"）
 * @returns 路由信息，无法解析时返回 null
 */
export function resolveOutboundSessionRoute(
  agentId: string,
  target: string,
): ResolvedSessionRoute | null {
  const trimmed = target.replace(/^napcat:/i, "").trim();
  if (!trimmed) return null;

  let peerKind: "direct" | "group" | "channel" = "direct";
  let peerId = trimmed;

  if (trimmed.startsWith("group:")) {
    peerKind = "group";
    peerId = trimmed.slice(6);
  } else if (trimmed.startsWith("channel:")) {
    peerKind = "channel";
    peerId = trimmed.slice(8);
  } else if (trimmed.startsWith("guild:")) {
    peerKind = "channel";
    peerId = trimmed.slice(6);
  } else if (trimmed.startsWith("private:")) {
    peerKind = "direct";
    peerId = trimmed.slice(8);
  }

  if (!peerId) return null;

  const peerIdNorm = peerId.toLowerCase();
  const sessionKey = `agent:${agentId}:napcat:${peerKind}:${peerIdNorm}`;

  return {
    sessionKey,
    baseSessionKey: sessionKey,
    peer: { kind: peerKind, id: peerIdNorm },
    chatType: peerKind === "direct" ? "direct" : peerKind === "channel" ? "channel" : "group",
    from: peerKind === "direct" ? `napcat:${peerIdNorm}` : `napcat:${peerKind}:${peerIdNorm}`,
    to: peerKind === "direct" ? `user:${peerIdNorm}` : `channel:${peerIdNorm}`,
  };
}
