/**
 * Shared type definitions for gateway and outbound modules.
 * Replaces inline `any` types with precise interfaces.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OneBotClient } from "../client.js";
import type { QQConfig } from "../config.js";
import type { PassiveModeManager } from "../passive-mode.js";
import type { UploadCache } from "../upload-cache.js";

export interface Logger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
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

export interface InboundRateLimitStore {
  lastTrigger: Map<string, number>;
  config: QQConfig;
}

export interface SharedState {
  clients: Map<string, OneBotClient>;
  knownGroupIds: Set<string>;
  inboundStores: Map<string, InboundRateLimitStore>;
  passiveMode: PassiveModeManager;
}

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
    createReplyDispatcherWithTyping: (params: { deliver: (payload: unknown) => Promise<void> }) => {
      dispatcher: unknown;
      replyOptions: unknown;
    };
    finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
    dispatchReplyFromConfig: (params: {
      ctx: Record<string, unknown>;
      cfg: OpenClawConfig;
      dispatcher: unknown;
      replyOptions: unknown;
    }) => Promise<void>;
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
}

export interface ConnectionContext {
  client: OneBotClient;
  account: { accountId: string; config: QQConfig; name?: string; enabled?: boolean; configured?: boolean };
  config: QQConfig;
  cfg: OpenClawConfig;
  channelRuntime: PluginRuntimeChannel;
  knownGroupIds: Set<string>;
  startAccountCtx: {
    getStatus?: () => AccountStatus | undefined;
    setStatus?: (next: AccountStatus) => void;
  };
}

export interface StartAccountContext {
  account: { accountId: string; config: QQConfig; name?: string; enabled?: boolean; configured?: boolean };
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log: Logger;
  getStatus?: () => AccountStatus | undefined;
  setStatus?: (next: AccountStatus) => void;
  channelRuntime?: PluginRuntimeChannel;
  runtime?: unknown;
}
