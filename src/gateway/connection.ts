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
import { makeBotHandshakeMessage, shouldSendHandshake, markHandshakeSent, runHandshakeBackfill } from "../utils/bot-handshake.js";

export interface ConnectionResult {
  groupRouteRefreshTimer: ReturnType<typeof setInterval> | null;
  /** 24h 一次的握手心跳定时器(让对方后入场的 bot 也能发现本 bot) */
  handshakeHeartbeatTimer: ReturnType<typeof setInterval> | null;
}

/**
 * 安装 connect 事件处理器。
 * 返回可供 cleanup 阶段销毁的 timer 引用。
 */
export function installConnectHandler(
  client: OneBotClient,
  ctx: ConnectionContext,
): ConnectionResult {
  const result: ConnectionResult = { groupRouteRefreshTimer: null, handshakeHeartbeatTimer: null };

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
        // 存入 account config（兼容旧路径）
        ctx.account.config._selfId = info.user_id;
        // 存入模块级缓存，确保 outbound.sendText 在重连后仍能获取到 selfId
        ctx.shared.setBotSelfId(ctx.account.accountId, info.user_id);
      }
      if (info?.nickname) {
        console.log(`[napcat-QQ] Logged in as: ${info.nickname} (${info.user_id})`);
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

      // 预注册群路由的局部函数
      // 使用框架 resolveAgentRoute 生成正确的 session key 格式，
      // 避免手写格式（如 "qq:group:xxx"）与框架内部格式不匹配导致系统无法发现
      const registerGroupRoute = async (groupId: string | number) => {
        const storePath = ctx.channelRuntime.session.resolveStorePath(
          ctx.cfg.session?.store,
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
          AccountId: ctx.account.accountId,
          ChatType: "group",
          Timestamp: Date.now(),
          OriginatingChannel: "napcat",
          OriginatingTo: groupFromId,
          SenderName: "",
          SenderId: "",
          ConversationLabel: `QQ Group ${groupId}`,
        };

        // 通过框架路由解析获取正确的 session key
        let sessionKey: string | undefined;
        try {
          const route = (ctx.channelRuntime as any)?.routing?.resolveAgentRoute?.({
            cfg: ctx.cfg,
            channel: "napcat",
            accountId: ctx.account.accountId,
            peer: { kind: "group", id: String(groupId) },
          });
          sessionKey = route?.sessionKey;
        } catch {
          // resolveAgentRoute 不可用时静默降级（不影响其他群）
        }

        if (!sessionKey) {
          console.warn(`[napcat-QQ] Cannot resolve session key for group ${groupId}, skipping route registration`);
          ctx.knownGroupIds.add(String(groupId));
          return;
        }

        await ctx.channelRuntime.session.recordInboundSession({
          storePath,
          sessionKey,
          ctx: { ...routeCtx, SessionKey: sessionKey },
          updateLastRoute: { sessionKey, channel: "napcat", to: groupFromId, accountId: ctx.account.accountId },
          onRecordError: () => {},
        });
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

      // ── 协议层握手（Plan A）：对每个已加入群发一次 bot 身份声明 ──
      // 仅在 metadata 模式下发送；其他模式（visible/zero-width/none）跳过，
      // 仍依赖 in-band 签名或 sender.bot / knownBotIds。
      // 节流：每个群 24h 内不重复发送。
      if (ctx.config.botSignatureStyle === "metadata" && info?.user_id) {
        try {
          const groups = await client.getGroupList();
          let sent = 0;
          let skipped = 0;
          for (const g of groups) {
            const gid = String(g.group_id);
            if (!shouldSendHandshake(ctx.account.accountId, gid)) {
              skipped += 1;
              continue;
            }
            try {
              await client.sendGroupMsg(g.group_id, makeBotHandshakeMessage(info.user_id));
              markHandshakeSent(ctx.account.accountId, gid);
              sent += 1;
            } catch (sendErr) {
              // 单群失败不阻塞其他群
              console.warn(`[napcat-QQ] Handshake send failed for group ${gid}: ${sendErr}`);
            }
          }
          if (sent > 0) {
            console.log(`[napcat-QQ] Sent bot handshake to ${sent} groups (skipped ${skipped} by throttle)`);
          }
        } catch (hsErr) {
          console.warn(`[napcat-QQ] Handshake batch failed (non-fatal): ${hsErr}`);
        }
      }

      // ── 冷启动历史回填：拉最近 N 条群消息，扫描握手 / 文本签名 ──
      // 解决"对方 bot 之前发过握手,本 bot 启动后才入群"的不对称时序问题。
      // 节流：每账号每进程仅回填一次,避免定时器触发时的重复 IO。
      if (!ctx.shared.handshakeBackfillDone?.has(ctx.account.accountId)) {
        try {
          const discovered = await runHandshakeBackfill(client, ctx.account.accountId);
          if (discovered > 0) {
            console.log(
              `[napcat-QQ] Cold-start backfill discovered ${discovered} bot(s) from group history`,
            );
          }
          if (!ctx.shared.handshakeBackfillDone) {
            ctx.shared.handshakeBackfillDone = new Set<string>();
          }
          ctx.shared.handshakeBackfillDone.add(ctx.account.accountId);
        } catch (bfErr) {
          console.warn(`[napcat-QQ] Handshake backfill failed (non-fatal): ${bfErr}`);
        }
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

      // ── 握手心跳：每 24h 重发一次握手 ─────────────────────────
      // 解决"老握手滚出 30 条历史,对方 bot 后入群抓不到"问题。
      // 节流由 shouldSendHandshake 控制(24h 窗口),定时器只触发"重发请求"。
      if (!result.handshakeHeartbeatTimer) {
        result.handshakeHeartbeatTimer = setInterval(async () => {
          if (ctx.config.botSignatureStyle !== "metadata" || !info?.user_id) return;
          try {
            const groups = await client.getGroupList();
            let sent = 0;
            for (const g of groups) {
              const gid = String(g.group_id);
              if (!shouldSendHandshake(ctx.account.accountId, gid)) continue;
              try {
                await client.sendGroupMsg(g.group_id, makeBotHandshakeMessage(info.user_id));
                markHandshakeSent(ctx.account.accountId, gid);
                sent += 1;
              } catch {
                // 单群失败静默,定时器下次再试
              }
            }
            if (sent > 0) {
              console.log(`[napcat-QQ][handshake-heartbeat] re-sent to ${sent} groups`);
            }
          } catch (err) {
            console.warn(`[napcat-QQ][handshake-heartbeat] tick failed: ${err}`);
          }
        }, 24 * 60 * 60 * 1_000);
      }
    } catch (err) {
      console.warn(`[napcat-QQ] connect handler error (non-fatal): ${err}`);
    }
  });

  return result;
}
