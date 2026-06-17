/**
 * Gateway 生命周期管理
 *
 * startAccount 的顶层编排：初始化资源、安装 connect/message handler、
 * 等待 abort 信号、清理。
 * 从 channel.ts startAccount 中提取，行为不变。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { OneBotClient } from "../client.js";
import type { QQConfig } from "../config.js";
import type { MetricsCollector, AlertCooldown } from "../metrics.js";
import type {
  InboundRateLimitStore,
  PluginRuntimeChannel,
  SharedState,
  StartAccountContext,
} from "../types/channel-types.js";
import { getQQRuntime } from "../runtime.js";
import { installGlobalInterceptor } from "../log-buffer.js";
import { triggerUpdateCheck } from "../update-checker.js";
import { initRefIndexStore, flushRefIndex } from "../ref-index-store.js";
import { flushKnownUsers } from "../known-users.js";
import { UploadCache } from "../upload-cache.js";
import { MessageSender } from "../message-sender.js";
import {
  CLEANUP_INTERVAL_MS,
  PASSIVE_COOLDOWN_MAX_AGE_MS,
  INBOUND_RATE_LIMIT_DEFAULT_MAX,
  DIALOG_STATE_CLEANUP_MS,
} from "../constants.js";
import { installConnectHandler } from "./connection.js";
import { installMessageHandler } from "./inbound.js";
import { initKnownBotsStore, flushKnownBotsStore } from "../known-bots-store.js";
import { cleanupDialogState } from "../dialog-state.js";
import { InboundRateLimiter } from "../rate-limiter.js";
import { trimSet, trimDedupSet } from "../utils/cache-evict.js";
import { startTtlSweep, stopTtlSweep } from "../member-cache.js";
import { getLog } from "../admin-commands/shared.js";

/**
 * 启动单个 QQ 账号的完整生命周期。
 * 外部（channel.ts）传入共享状态引用，本函数负责资源创建和清理。
 */
export async function startAccount(
  ctx: StartAccountContext,
  shared: SharedState,
): Promise<void> {
  const { account, cfg } = ctx;
  const config = account.config;
  const log = getLog(ctx.log);

  // 优先使用 ctx.channelRuntime（3.31+ 注入方式），回退到全局单例
  const channelRuntime: PluginRuntimeChannel =
    ctx.channelRuntime ?? getQQRuntime().channel;

  // ── 并发控制：防止同一账号并发 startAccount 导致竞态（P1 #7） ──
  // 同一账号并发调用时，第二个调用 await 第一个的 Promise 并直接返回，
  // 避免两个调用同时读到旧 client、同时 disconnect、同时创建新 client 导致双倍 disconnect。
  // ⚠️ P0 修复：set 必须在 IIFE 创建之前（同步阶段），否则两个并发调用可在 IIFE yield 前都通过检查。
  const existingPromise = shared.startingPromises.get(account.accountId);
  if (existingPromise) {
    log.log(
      `[napcat-QQ] startAccount already in progress for ${account.accountId}, awaiting existing startup...`,
    );
    await existingPromise;
    return;
  }

  const thisStartPromise = (async () => {
    try {
      if (!config.wsUrl && !config.reverseWsPort)
        throw new Error("QQ: either wsUrl or reverseWsPort is required");

      // ── 初始化日志缓冲区 ────────────────────────────────
      installGlobalInterceptor(config.logBufferSize ?? 200);

      // ── 显式启动群成员缓存 TTL 扫描（替代模块级自动启动） ──
      startTtlSweep();

      // ── 注册入站频控状态 ────────────────────────────────
      const lastTrigger = new Map<string, number>();
      const rateLimiter = new InboundRateLimiter(
        { windowMs: config.inboundRateLimitMs ?? 0, maxMessages: INBOUND_RATE_LIMIT_DEFAULT_MAX },
        [...(config.admins ?? []), ...(config.sharedAdmins ?? [])],
      );
      const inboundStore: InboundRateLimitStore = {
        lastTrigger,
        rateLimiter,
        config,
        processedMsgIds: new Set<string>(),
      };
      shared.inboundStores.set(account.accountId, inboundStore);

    // ── 版本检查 ────────────────────────────────────────
    if (config.enableUpdateCheck !== false) {
      triggerUpdateCheck(log);
    }

    // ── 初始化引用索引 ──────────────────────────────────
    initRefIndexStore();

    // ── 初始化已知 bot 持久化缓存（避免冷启动漏识别） ──
    initKnownBotsStore(account.accountId);

    // ── 上传缓存 ────────────────────────────────────────
    const uploadCache = new UploadCache();

    // ── 防止同账号重复启动 ──────────────────────────────
    const existingClient = shared.clients.get(account.accountId);
    if (existingClient) {
      log.log(
        `[napcat-QQ] Stopping existing client for account ${account.accountId} before restart`,
      );
      await existingClient.disconnect();
    }

    const client = new OneBotClient({
      wsUrl: config.wsUrl,
      httpUrl: config.httpUrl,
      reverseWsPort: config.reverseWsPort,
      accessToken: config.accessToken,
      requireReverseWsToken: config.requireReverseWsToken,
    });

    // 安全警告：accessToken 已配置但 requireReverseWsToken 未启用时，
    // 反向 WS 接受未认证连接，存在未授权 API 调用风险
    if (config.accessToken && !config.requireReverseWsToken) {
      log.warn("[napcat-QQ] Security: accessToken is configured but requireReverseWsToken is false. Reverse WS accepts unauthenticated connections. Set requireReverseWsToken=true for full security.");
    }

    shared.clients.set(account.accountId, client);

    let groupRouteRefreshTimer: ReturnType<typeof setInterval> | null = null;
    const cleanupInterval = setInterval(() => {
      // inboundStore.processedMsgIds 是 filter.ts 实际使用的去重集合，定期修剪
      if (inboundStore && trimDedupSet(inboundStore.processedMsgIds)) {
        log.log(`[napcat-QQ] Inbound dedup set trimmed: kept ${inboundStore.processedMsgIds.size} recent IDs`);
      }
      shared.passiveMode.cleanup(PASSIVE_COOLDOWN_MAX_AGE_MS);
      cleanupDialogState(DIALOG_STATE_CLEANUP_MS);
    }, CLEANUP_INTERVAL_MS);

    // ── 安装 connect handler ────────────────────────────
    const connResult = installConnectHandler(client, {
      client,
      account,
      config,
      cfg,
      channelRuntime,
      knownGroupIds: shared.knownGroupIds,
      log,
      startAccountCtx: {
        getStatus: ctx.getStatus,
        setStatus: ctx.setStatus,
      },
      shared,
    });

    // ── 安装 message handler ────────────────────────────
    const accountMetrics = shared.metrics?.get(account.accountId);
    const accountAlertCooldown = shared.alertCooldown?.get(account.accountId);

    // 闭包捕获本次实例的卸载函数，防止竞态：旧实例 cleanup 期间新实例可能已覆盖 Map
    let myUninstall: (() => void) | undefined;

    // 防止重连时 message handler listener 累积：先卸载旧的
    const oldUninstall = shared._messageHandlerCleanups?.get(account.accountId);
    if (oldUninstall) {
      oldUninstall();
      shared._messageHandlerCleanups?.delete(account.accountId);
    }

    // 创建 MessageSender 实例并注入（DI），便于测试时替换 mock
    const messageSender = new MessageSender({
      client,
      config,
      uploadCache,
      accountId: account.accountId,
      isGroup: false, // 运行时由 sendFile/sendByTarget 根据实际目标判断
      isGuild: false,
      groupId: undefined,
      userId: undefined,
      guildId: undefined,
      channelId: undefined,
      log,
      metrics: accountMetrics,
    });

    myUninstall = installMessageHandler(client, {
      client,
      account,
      config,
      cfg,
      channelRuntime,
      uploadCache,
      inboundStore,
      knownGroupIds: shared.knownGroupIds,
      passiveMode: shared.passiveMode,
      log,
      metrics: accountMetrics,
      alertCooldown: accountAlertCooldown,
    });

    // 保存卸载函数
    if (shared._messageHandlerCleanups) {
      shared._messageHandlerCleanups.set(account.accountId, myUninstall);
    }

    // 注册 gauge 实时查询（提供最新值）
    if (accountMetrics) {
      accountMetrics.registerGauge("knownGroups", () => shared.knownGroupIds.size);
      accountMetrics.registerGauge("uploadCacheSize", () => uploadCache.size);
    }

    try {
      client.connect();
      client.startReverseWs();

      // 等待 abort 信号（兜底：无 abortSignal 时直接返回避免永久挂起）
      if (ctx.abortSignal) {
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal!.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
        });
      } else {
        log.warn("[napcat-QQ] No abortSignal provided, startAccount will not block");
      }
    } finally {
      clearInterval(cleanupInterval);
      if (connResult.groupRouteRefreshTimer) clearInterval(connResult.groupRouteRefreshTimer);
    }

    // ── Cleanup ─────────────────────────────────────────
    // 卸载 message handler listener，防止重连时累积
    // 用闭包变量 myUninstall（本次实例），避免竞态读到新实例的函数
    if (myUninstall) {
      myUninstall();
      shared._messageHandlerCleanups?.delete(account.accountId);
    }

    flushKnownBotsStore();
    flushKnownUsers();
    await flushRefIndex();
    uploadCache.dispose();
    try {
      await client.disconnect();
    } catch (disconnectErr) {
      log.warn(`[napcat-QQ] Client disconnect for ${account.accountId} encountered an error:`, disconnectErr);
    }
    shared.clients.delete(account.accountId);
    shared.inboundStores.delete(account.accountId);
    // 注意：不调用 stopTtlSweep() — TTL 扫描是全局资源，其他在线账号依赖它清理 member cache
    } catch (err) {
      // setup 失败时清理 shared maps，防止脏数据残留导致后续 restart 行为异常
      shared.clients.delete(account.accountId);
      shared.inboundStores.delete(account.accountId);
      throw err;
    }
  })();

  // set 在 IIFE 创建后立即执行（仍在同步阶段），确保 get/set 之间无 yield 点
  shared.startingPromises.set(account.accountId, thisStartPromise);

  try {
    await thisStartPromise;
  } finally {
    // 只清理仍然是最新 Promise 的条目（避免清理后续重启的 Promise）
    const current = shared.startingPromises.get(account.accountId);
    if (current === thisStartPromise) {
      shared.startingPromises.delete(account.accountId);
    }
  }
}

// ============ 辅助函数（导出供测试）============
