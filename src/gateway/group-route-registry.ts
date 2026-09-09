/**
 * 群路由注册共享逻辑。
 *
 * 消除 gateway/connection.ts（连接时注册）和 gateway/inbound.ts（/groups 刷新）
 * 之间的重复代码。
 */

import type { OneBotClient } from "../client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export interface RegisterGroupRouteParams {
  client: OneBotClient;
  cfg: OpenClawConfig;
  accountId: string;
  groupId: string | number;
  channelRuntime: any; // PluginRuntimeChannel — 避免与上游 SDK 类型强耦合
  knownGroupIds: Set<string>;
  log?: {
    warn?: (msg: string) => void;
    info?: (msg: string) => void;
  };
}

/**
 * 为单个群注册入站会话路由。
 * 返回 true = 注册成功，false = 跳过（无法解析 sessionKey）。
 */
export async function registerGroupRoute(params: RegisterGroupRouteParams): Promise<boolean> {
  const {
    client,
    cfg,
    accountId,
    groupId,
    channelRuntime,
    knownGroupIds,
    log,
  } = params;

  // channelRuntime.session 是 SDK 可选能力；成员缺失时按函数契约 return false
  // （守卫写法对齐 inbound.ts 的可选链模式）
  if (!channelRuntime?.session?.resolveStorePath || !channelRuntime?.session?.recordInboundSession) {
    log?.warn?.(`[napcat-QQ] channelRuntime.session unavailable, skip route registration for group ${groupId}`);
    return false;
  }

  const groupFromId = `group:${groupId}`;
  const routeCtx = {
    Provider: "napcat",
    Channel: "napcat",
    From: groupFromId,
    To: "napcat:bot",
    Body: "",
    RawBody: "",
    AccountId: accountId,
    ChatType: "group",
    Timestamp: Date.now(),
    OriginatingChannel: "napcat",
    OriginatingTo: groupFromId,
    SenderName: "",
    SenderId: "",
    ConversationLabel: `QQ Group ${groupId}`,
  };

  let sessionKey: string | undefined;
  let agentId: string | undefined;
  try {
    const route = channelRuntime.routing?.resolveAgentRoute?.({
      cfg,
      channel: "napcat",
      accountId,
      peer: { kind: "group", id: String(groupId) },
    });
    sessionKey = route?.sessionKey;
    agentId = route?.agentId;
  } catch {
    // routing unavailable, fall through to legacy key
  }

  if (!sessionKey) {
    // resolveAgentRoute 失败时（框架路由未激活、无 session 记录），
    // 使用无 agent 前缀的 legacy key，由框架落到默认 agent（与 inbound.ts 一致）。
    sessionKey = `napcat:group:${groupId}`;
  }

  // openclaw ≥2026.8 的 resolveStorePath 在无 agentId 时会抛错；抛错则跳过注册
  let storePath: string;
  try {
    storePath = channelRuntime.session.resolveStorePath(
      cfg.session?.store,
      agentId ? { agentId } : undefined,
    );
  } catch (err) {
    log?.warn?.(`[napcat-QQ] resolveStorePath failed for group ${groupId}, skip route registration: ${String(err)}`);
    return false;
  }

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey,
    ctx: { ...routeCtx, SessionKey: sessionKey },
    updateLastRoute: { sessionKey, channel: "napcat", to: groupFromId, accountId },
    onRecordError: () => {},
  });
  knownGroupIds.add(String(groupId));
  return true;
}
