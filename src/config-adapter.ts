/**
 * QQ channel 的 config adapter。
 *
 * 从 channel.ts 抽取，供两个入口共用：
 *   - channel.ts       完整运行时插件
 *   - setup-entry.ts  轻量 setup-only 插件（onboarding / 只读状态 / SecretRef 扫描）
 *
 * 本模块只依赖 config.ts（纯 zod）与 SDK helper，不触碰 client / gateway / outbound，
 * 保证 setup-entry 的 import-safe。
 */

import { DEFAULT_ACCOUNT_ID, type ChannelPlugin, type OpenClawConfig } from "openclaw/plugin-sdk/core";
import { QQConfigSchema, type QQConfig, getQQConfigDefaults, resolvePassiveModeTemperature } from "./config.js";
import type { ResolvedQQAccount } from "./types/channel-types.js";

/** ChannelPlugin.config 的结构类型（手写 d.ts 未导出独立的 ChannelConfigAdapter） */
type QQConfigAdapter = ChannelPlugin<ResolvedQQAccount>["config"];

export function createQQConfigAdapter(): QQConfigAdapter {
  return {
    listAccountIds: (cfg: OpenClawConfig) => {
      const qq = cfg.channels?.napcat;
      if (!qq) return [];
      if (qq.accounts) return Object.keys(qq.accounts);
      return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      const qq = cfg.channels?.napcat;
      const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
      const cleanConfig = accountConfig ? { ...accountConfig } : {};
      delete (cleanConfig as Record<string, unknown>)._selfId;
      delete (cleanConfig as Record<string, unknown>)._selfName;
      const parsed = QQConfigSchema.safeParse(cleanConfig ?? {});
      const rawConfig = parsed.success ? parsed.data : (accountConfig || {});
      // safeParse 不填充 .default()，手动合并默认值（用户显式设置的优先）
      const config: QQConfig = { ...getQQConfigDefaults(), ...rawConfig };
      // passiveMode.temperature 优先映射到三个子参数
      const pm = config.passiveMode;
      if (pm?.temperature !== undefined && pm.temperature !== null) {
        const mapped = resolvePassiveModeTemperature(pm.temperature);
        if (mapped) {
          config.passiveMode = { ...pm, ...mapped };
        }
      }
      return {
        accountId: id,
        name: accountConfig?.name ?? "QQ Default",
        enabled: true,
        configured: Boolean(accountConfig?.wsUrl || accountConfig?.reverseWsPort),
        tokenSource: accountConfig?.accessToken ? "config" : "none",
        config,
      };
    },
    defaultAccountId: (_cfg: OpenClawConfig) => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc: ResolvedQQAccount, _cfg: OpenClawConfig) => ({
      accountId: acc.accountId,
      name: acc.name,
      enabled: acc.enabled ?? true,
      configured: acc.configured,
    }),
  };
}
