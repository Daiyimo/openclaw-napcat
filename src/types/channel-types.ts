/**
 * Shared type definitions for gateway and outbound modules.
 * Replaces inline `any` types with precise interfaces.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OneBotClient } from "../client.js";
import type { QQConfig } from "../config.js";
import type { PassiveModeManager } from "../passive-mode.js";
import type { UploadCache } from "../upload-cache.js";
import type { MetricsCollector, AlertCooldown } from "../metrics.js";

export interface Logger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface AccountStatus {
  accountId: string;
  running: boolean;
  connected: boolean;
  lastStartAt?: number | null;
  lastError?: string | null;
}

export interface SendResult {
  channel: "napcat";
  sent: boolean;
  error?: string;
}

import type { InboundRateLimiter } from "../rate-limiter.js";

export interface InboundRateLimitStore {
  /** @deprecated Replaced by rateLimiter for sliding window support */
  lastTrigger: Map<string, number>;
  /** 消息去重集合 */
  processedMsgIds: Set<string>;
  /** 滑动窗口限流器 */
  rateLimiter?: InboundRateLimiter;
  config: QQConfig;
}

export interface SharedState {
  clients: Map<string, OneBotClient>;
  knownGroupIds: Set<string>;
  inboundStores: Map<string, InboundRateLimitStore>;
  passiveMode: PassiveModeManager;
  setBotSelfId: (accountId: string, selfId: number) => void;
  /** 每账号冷启动握手回填是否已执行（避免定时器重复触发） */
  handshakeBackfillDone?: Set<string>;
  /**
   * 并发锁：防止同一账号并发 startAccount 导致竞态
   * @see P1 #7
   */
  startingPromises: Map<string, Promise<void>>;
  /** 指标收集器（按账号隔离，可选） */
  metrics?: Map<string, MetricsCollector>;
  /** 告警冷却管理器（按账号隔离，可选） */
  alertCooldown?: Map<string, AlertCooldown>;
  /** message handler 卸载函数（防止重连时 listener 累积） */
  _messageHandlerCleanups: Map<string, () => void>;
}

/**
 * 本地 channel runtime 类型（与 openclaw SDK PluginRuntimeChannel 对齐）。
 * 只声明 napcat 实际使用的方法，避免直接依赖 SDK 内部类型。
 */
export interface PluginRuntimeChannel {
  activity: {
    record: (params: { channel: string; accountId: string; direction: "inbound" | "outbound" }) => void;
  };
  session: {
    resolveStorePath: (store: unknown, opts: { agentId: string }) => string;
    recordInboundSession: (params: {
      storePath: string;
      sessionKey: string;
      ctx: Record<string, unknown>;
      updateLastRoute: { sessionKey: string; channel: string; to: string; accountId: string };
      onRecordError: (err: unknown) => void;
    }) => Promise<void>;
  };
  reply: {
    finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
    dispatchReplyWithBufferedBlockDispatcher: (params: {
      ctx: Record<string, unknown>;
      cfg: OpenClawConfig;
      dispatcherOptions: {
        deliver: (payload: unknown) => Promise<void>;
        onError?: (err: unknown) => void;
      };
      replyOptions?: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

export interface InboundContext {
  client: OneBotClient;
  account: { accountId: string; config: QQConfig; name?: string; enabled?: boolean; configured?: boolean };
  config: QQConfig;
  cfg: OpenClawConfig;
  channelRuntime: PluginRuntimeChannel;
  uploadCache: UploadCache;
  inboundStore: InboundRateLimitStore;
  processedMsgIds: Set<string>;
  knownGroupIds: Set<string>;
  passiveMode: PassiveModeManager;
  log: Logger;
  metrics?: MetricsCollector;
  alertCooldown?: AlertCooldown;
}

export interface ConnectionContext {
  client: OneBotClient;
  account: { accountId: string; config: QQConfig; name?: string; enabled?: boolean; configured?: boolean };
  config: QQConfig;
  cfg: OpenClawConfig;
  channelRuntime: PluginRuntimeChannel;
  knownGroupIds: Set<string>;
  log: Logger;
  startAccountCtx: {
    getStatus: () => AccountStatus;
    setStatus: (next: AccountStatus) => void;
  };
  shared: SharedState;
}

export interface StartAccountContext {
  account: { accountId: string; config: QQConfig; name?: string; enabled?: boolean; configured?: boolean };
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log: Logger;
  getStatus: () => AccountStatus;
  setStatus: (next: AccountStatus) => void;
  channelRuntime?: PluginRuntimeChannel;
  runtime?: unknown;
}
