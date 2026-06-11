/**
 * 群路由注册共享逻辑。
 *
 * 消除 gateway/connection.ts（连接时注册）和 gateway/inbound.ts（/groups 刷新）
 * 之间的重复代码。
 */

import type { OneBotClient } from "../client.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

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

  const storePath = channelRuntime.session.resolveStorePath(
    cfg.session?.store,
    { agentId: "default" },
  );
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
  try {
    const route = channelRuntime.routing?.resolveAgentRoute?.({
      cfg,
      channel: "napcat",
      accountId,
      peer: { kind: "group", id: String(groupId) },
    });
    sessionKey = route?.sessionKey;
  } catch {
    // routing unavailable, skip this group
  }

  if (!sessionKey) {
    log?.warn?.(`[napcat-QQ] Cannot resolve session key for group ${groupId}, skipping route registration`);
    knownGroupIds.add(String(groupId));
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
