/**
 * Gateway 连接处理器
 *
 * 处理 OneBotClient 的 "connect" 事件：获取登录信息、
 * 预注册群路由、设置定时刷新。
 * 从 channel.ts startAccount 中提取，行为不变。
 */

import type { OneBotClient } from "../client.js";
import type { ConnectionContext } from "../types/channel-types.js";
import {
  LOGIN_INFO_TIMEOUT_MS,
  GROUP_ROUTE_REFRESH_INTERVAL_MS,
} from "../constants.js";

export interface ConnectionResult {
  groupRouteRefreshTimer: ReturnType<typeof setInterval> | null;
}

/**
 * 安装 connect 事件处理器。
 * 返回可供 cleanup 阶段销毁的 timer 引用。
 */
export function installConnectHandler(
  client: OneBotClient,
  ctx: ConnectionContext,
): ConnectionResult {
  const result: ConnectionResult = { groupRouteRefreshTimer: null };

  client.on("connect", async () => {
    console.log(`[napcat-QQ] Connected account ${ctx.account.accountId}`);
    try {
      const info = await Promise.race([
        client.getLoginInfo(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("getLoginInfo timeout")), LOGIN_INFO_TIMEOUT_MS),
        ),
      ]);
      if (info?.user_id) {
        client.setSelfId(info.user_id);
        // 存入 account config，供 outbound.sendText 生成友军签名使用
        ctx.account.config._selfId = info.user_id;
      }
      if (info?.nickname)
        console.log(`[napcat-QQ] Logged in as: ${info.nickname} (${info.user_id})`);
      ctx.channelRuntime.activity.record({
        channel: "napcat",
        accountId: ctx.account.accountId,
        direction: "inbound",
      });
      ctx.startAccountCtx.setStatus?.({
        ...ctx.startAccountCtx.getStatus?.()!,
        accountId: ctx.account.accountId,
        running: true,
        connected: true,
      });

      // 预注册群路由的局部函数
      const registerGroupRoute = async (groupId: string | number) => {
        const storePath = ctx.channelRuntime.session.resolveStorePath(
          ctx.cfg.session?.store,
          { agentId: "default" },
        );
        const groupFromId = `group:${groupId}`;
        const routeCtx = {
          Provider: "qq",
          Channel: "qq",
          From: groupFromId,
          To: "qq:bot",
          Body: "",
          RawBody: "",
          AccountId: ctx.account.accountId,
          ChatType: "group",
          Timestamp: Date.now(),
          OriginatingChannel: "napcat",
          OriginatingTo: groupFromId,
          SenderName: "",
          SenderId: "",
          ConversationLabel: `QQ Group ${groupId}`,
        };
        const lastRoute = { channel: "napcat", to: groupFromId, accountId: ctx.account.accountId };
        for (const sessionKey of [`qq:${groupFromId}`, `qq:${groupId}`]) {
          await ctx.channelRuntime.session.recordInboundSession({
            storePath,
            sessionKey,
            ctx: { ...routeCtx, SessionKey: sessionKey },
            updateLastRoute: { sessionKey, ...lastRoute },
            onRecordError: () => {},
          });
        }
        ctx.knownGroupIds.add(String(groupId));
      };

      try {
        const groups = await client.getGroupList();
        // 并行注册群路由，用 allSettled 避免单个失败阻塞全部
        await Promise.allSettled(groups.map((g) => registerGroupRoute(g.group_id)));
        console.log(
          `[napcat-QQ] Pre-registered ${groups.length} group session routes for cron delivery`,
        );
      } catch (err) {
        console.warn(`[napcat-QQ] Group route pre-registration failed (non-fatal): ${err}`);
      }

      // 每 6 小时刷新群路由
      if (!result.groupRouteRefreshTimer) {
        result.groupRouteRefreshTimer = setInterval(async () => {
          try {
            const groups = await client.getGroupList();
            await Promise.allSettled(groups.map((g) => registerGroupRoute(g.group_id)));
            console.log(`[napcat-QQ] Refreshed ${groups.length} group session routes`);
          } catch (err) {
            console.warn(`[napcat-QQ] Group route refresh failed: ${err}`);
          }
        }, GROUP_ROUTE_REFRESH_INTERVAL_MS);
      }
    } catch (err) {
      console.warn(`[napcat-QQ] connect handler error (non-fatal): ${err}`);
    }
  });

  return result;
}
