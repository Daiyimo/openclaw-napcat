/**
 * Session route 解析（供 cron 投递和测试使用）
 *
 * 复刻框架 resolveFallbackSession 逻辑，确保 session key 格式一致：
 *   agent:{agentId}:napcat:{peerKind}:{peerId}
 *
 * ⚠️ P0 核心功能 — 投递路由的基石，修改前必须确认：
 * 1. 入站 session 记录格式（inbound.ts 降级路径）与出站解析一致
 * 2. 裸数字默认语义与 parseTarget 一致（都为 group）
 * 3. 所有变更必须通过 npm test 全量测试
 */

export interface ResolvedSessionRoute {
  sessionKey: string;
  baseSessionKey: string;
  peer: { kind: "direct" | "group" | "channel"; id: string };
  chatType: string;
  from: string;
  to: string;
}

/**
 * 根据目标字符串解析 session 路由信息。
 *
 * @param agentId 代理 ID（如 "default"）
 * @param target  目标字符串（如 "group:88888"、"private:12345"、"napcat:group:88888"、"815833475"）
 * @returns 路由信息，无法解析时返回 null
 *
 * @remarks
 * - 带前缀的目标（group:/private:/channel:/guild:）按前缀解析
 * - 裸数字默认识别为群聊（QQ 场景下 cron 投递的主要用例）
 * - 如需发私聊，请使用 private:QQ号 格式
 */
export function resolveOutboundSessionRoute(
  agentId: string,
  target: string,
): ResolvedSessionRoute | null {
  const trimmed = target.replace(/^napcat:/i, "").trim();
  if (!trimmed) return null;
  if (agentId.includes(":")) return null;

  let peerKind: "direct" | "group" | "channel" = "direct";
  let peerId = trimmed;
  let hadPrefix = false;

  if (trimmed.startsWith("group:")) {
    hadPrefix = true;
    peerKind = "group";
    peerId = trimmed.slice(6).trim();
  } else if (trimmed.startsWith("channel:")) {
    hadPrefix = true;
    peerKind = "channel";
    peerId = trimmed.slice(8).trim();
  } else if (trimmed.startsWith("guild:")) {
    hadPrefix = true;
    peerKind = "channel";
    peerId = trimmed.slice(6).trim();
  } else if (trimmed.startsWith("private:")) {
    hadPrefix = true;
    peerKind = "direct";
    peerId = trimmed.slice(8).trim();
  }

  // 完全无前缀的裸数字：QQ 场景下默认视为群聊
  if (!hadPrefix && /^\d+$/.test(peerId)) {
    peerKind = "group";
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
