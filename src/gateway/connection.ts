/**
 * Gateway 连接处理器
 *
 * 处理 OneBotClient 的 "connect" 事件：获取登录信息、
 * 预注册群路由、设置定时刷新。
 * 从 channel.ts startAccount 中提取，行为不变。
 */

import type { OneBotClient } from "../client.js";
import type { ConnectionContext, SharedState } from "../types/channel-types.js";
import {
  LOGIN_INFO_TIMEOUT_MS,
  GROUP_ROUTE_REFRESH_INTERVAL_MS,
} from "../constants.js";
import { runHandshakeBackfill } from "../utils/bot-handshake.js";
import { registerGroupRoute } from "./group-route-registry.js";

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
    ctx.log.info(`[napcat-QQ] Connected account ${ctx.account.accountId}`);
    try {
      const info = await Promise.race([
        client.getLoginInfo(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("getLoginInfo timeout")), LOGIN_INFO_TIMEOUT_MS),
        ),
      ]);
      if (info?.user_id) {
        client.setSelfId(info.user_id);
        // 存入 account config（兼容旧路径）
        ctx.account.config._selfId = info.user_id;
        // 存入模块级缓存，确保 outbound.sendText 在重连后仍能获取到 selfId
        ctx.shared.setBotSelfId(ctx.account.accountId, info.user_id);
      }
      if (info?.nickname) {
        ctx.log.info(`[napcat-QQ] Logged in as: ${info.nickname} (${info.user_id})`);
        // 存入 account config，供自我认知和名字触发使用
        ctx.account.config._selfName = info.nickname;
      }
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

      try {
        const groups = await client.getGroupList();
        await Promise.allSettled(
          groups.map((g) =>
            registerGroupRoute({
              client,
              cfg: ctx.cfg,
              accountId: ctx.account.accountId,
              groupId: g.group_id,
              channelRuntime: ctx.channelRuntime,
              knownGroupIds: ctx.knownGroupIds,
            }),
          ),
        );
        ctx.log.info(
          `[napcat-QQ] Pre-registered ${groups.length} group session routes for cron delivery`,
        );
        } catch (err) {
          ctx.log.warn(`[napcat-QQ] Group route pre-registration failed (non-fatal): ${err}`);
      }

      // 冷启动 backfill：拉群历史（只读）扫描签名，补充 known-bots-cache。
      // metadata 握手在 v1.9.2 移除（json 段渲染为卡片 spam），
      // 友军识别仅依赖文本签名/sender.bot/knownBotIds/持久化缓存。

      // ── 冷启动历史回填：拉最近 N 条群消息，扫描握手 / 文本签名 ──
      // 解决"对方 bot 之前发过握手,本 bot 启动后才入群"的不对称时序问题。
      // 节流：每账号每进程仅回填一次,避免定时器触发时的重复 IO。
      if (!ctx.shared.handshakeBackfillDone?.has(ctx.account.accountId)) {
        try {
          const discovered = await runHandshakeBackfill(client, ctx.account.accountId);
          if (discovered > 0) {
            ctx.log.info(
              `[napcat-QQ] Cold-start backfill discovered ${discovered} bot(s) from group history`,
            );
          }
          if (!ctx.shared.handshakeBackfillDone) {
            ctx.shared.handshakeBackfillDone = new Set<string>();
          }
          ctx.shared.handshakeBackfillDone.add(ctx.account.accountId);
        } catch (bfErr) {
          ctx.log.warn(`[napcat-QQ] Handshake backfill failed (non-fatal): ${bfErr}`);
        }
      }

          // 每 6 小时刷新群路由
      if (!result.groupRouteRefreshTimer) {
        result.groupRouteRefreshTimer = setInterval(async () => {
          try {
            const groups = await client.getGroupList();
            await Promise.allSettled(
              groups.map((g) =>
                registerGroupRoute({
                  client,
                  cfg: ctx.cfg,
                  accountId: ctx.account.accountId,
                  groupId: g.group_id,
                  channelRuntime: ctx.channelRuntime,
                  knownGroupIds: ctx.knownGroupIds,
                }),
              ),
            );
            ctx.log.info(`[napcat-QQ] Refreshed ${groups.length} group session routes`);
          } catch (err) {
            ctx.log.warn(`[napcat-QQ] Group route refresh failed: ${err}`);
          }
        }, GROUP_ROUTE_REFRESH_INTERVAL_MS);
      }

      // 24h 握手心跳定时器在 v1.9.2 移除（会导致群广播 spam）。
      // 老握手滚出问题由冷启动 backfill + group_increase 节流清除解决。
      // 3. 对方 bot 重启时会自动从冷启动 backfill 重新发现
    } catch (err) {
      ctx.log.warn(`[napcat-QQ] connect handler error (non-fatal): ${err}`);
    }
  });

  return result;
}
