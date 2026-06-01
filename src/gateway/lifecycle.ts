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
import {
  DEDUP_MAX_SIZE,
  DEDUP_KEEP_SIZE,
  CLEANUP_INTERVAL_MS,
  PASSIVE_COOLDOWN_MAX_AGE_MS,
} from "../constants.js";
import { installConnectHandler } from "./connection.js";
import { installMessageHandler } from "./inbound.js";
import { initKnownBotsStore, flushKnownBotsStore } from "../known-bots-store.js";
import { cleanupDialogState } from "../dialog-state.js";

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
  const log = ctx.log ?? console;

  // 优先使用 ctx.channelRuntime（3.31+ 注入方式），回退到全局单例
  const channelRuntime: PluginRuntimeChannel =
    (ctx.channelRuntime as PluginRuntimeChannel) ?? getQQRuntime().channel;

  if (!config.wsUrl && !config.reverseWsPort)
    throw new Error("QQ: either wsUrl or reverseWsPort is required");

  // ── 初始化日志缓冲区 ────────────────────────────────
  installGlobalInterceptor(config.logBufferSize ?? 200);

  // ── 注册入站频控状态 ────────────────────────────────
  const lastTrigger = new Map<string, number>();
  const inboundStore: InboundRateLimitStore = { lastTrigger, config };
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
    console.log(
      `[napcat-QQ] Stopping existing client for account ${account.accountId} before restart`,
    );
    await existingClient.disconnect();
  }

  const client = new OneBotClient({
    wsUrl: config.wsUrl,
    httpUrl: config.httpUrl,
    reverseWsPort: config.reverseWsPort,
    accessToken: config.accessToken,
  });

  shared.clients.set(account.accountId, client);

  const processedMsgIds = new Set<string>();
  let groupRouteRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const cleanupInterval = setInterval(() => {
    if (trimDedupSet(processedMsgIds)) {
      console.log(`[napcat-QQ] Dedup set trimmed: kept ${processedMsgIds.size} recent IDs`);
    }
    shared.passiveMode.cleanup(PASSIVE_COOLDOWN_MAX_AGE_MS);
    cleanupDialogState(60 * 60 * 1000);  // 1 小时未活跃的群状态清理
  }, CLEANUP_INTERVAL_MS);

  // ── 安装 connect handler ────────────────────────────
  const connResult = installConnectHandler(client, {
    client,
    account,
    config,
    cfg,
    channelRuntime,
    knownGroupIds: shared.knownGroupIds,
    startAccountCtx: {
      getStatus: ctx.getStatus,
      setStatus: ctx.setStatus,
    },
    shared,
  });
  // connResult.groupRouteRefreshTimer 由 connect handler 内部设置
  // 通过闭包引用 connResult 对象，cleanup 阶段读取最新值

  // ── 安装 message handler ────────────────────────────
  installMessageHandler(client, {
    client,
    account,
    config,
    cfg,
    channelRuntime,
    uploadCache,
    inboundStore,
    processedMsgIds,
    knownGroupIds: shared.knownGroupIds,
    passiveMode: shared.passiveMode,
    log,
  });

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
    console.warn("[napcat-QQ] No abortSignal provided, startAccount will not block");
  }

  // ── Cleanup ─────────────────────────────────────────
  clearInterval(cleanupInterval);
  if (connResult.groupRouteRefreshTimer) clearInterval(connResult.groupRouteRefreshTimer);
  flushKnownBotsStore();
  flushKnownUsers();
  await flushRefIndex();
  uploadCache.dispose();
  await client.disconnect();
  shared.clients.delete(account.accountId);
  // 只删除本次启动注册的 store
  const currentStore = shared.inboundStores.get(account.accountId);
  if (currentStore?.lastTrigger === lastTrigger) {
    shared.inboundStores.delete(account.accountId);
  }
}

// ============ 辅助函数（导出供测试）============

/**
 * dedup 集合超过 DEDUP_MAX_SIZE 时修剪到 DEDUP_KEEP_SIZE，保留最新的 N 条。
 * 返回是否实际发生了修剪。
 *
 * 抽出来为顶层函数便于单元测试（interval 内部逻辑单测困难）。
 */
export function trimDedupSet(
  set: Set<string>,
  maxSize: number = DEDUP_MAX_SIZE,
  keepSize: number = DEDUP_KEEP_SIZE,
): boolean {
  if (set.size <= maxSize) return false;
  const entries = [...set];
  set.clear();
  for (const id of entries.slice(-keepSize)) set.add(id);
  return true;
}
