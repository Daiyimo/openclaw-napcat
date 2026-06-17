/**
 * 配置热更新支持
 *
 * 提供 ConfigRef 引用对象，运行时通过 /reload 命令触发配置重新加载。
 * 使用 Zod schema 验证新配置，验证失败则保留旧值。
 */

import { QQConfigSchema, type QQConfig, resolvePassiveModeTemperature, getQQConfigDefaults } from "./config.js";
import type { Logger } from "./types/channel-types.js";
import { getLog } from "./admin-commands/shared.js";

/** 运行时通过命令修改的字段：配置文件缺失时不应覆盖运行时值 */
const RUNTIME_MUTABLE_FIELDS: (keyof QQConfig)[] = ["sleepMode", "passiveMode"];

export interface ConfigRef {
  /** 当前生效的配置 */
  current: QQConfig;
  /** 可选的 logger 实例 */
  log?: Logger;
}

export function createConfigRef(initial: QQConfig, log?: Logger): ConfigRef {
  return { current: initial, log };
}

let _configRef: ConfigRef | null = null;

export function initConfigRef(initial: QQConfig, log?: Logger): void {
  _configRef = createConfigRef(initial, log);
}

export function getConfigRef(): ConfigRef {
  if (!_configRef) {
    const msg = "[config-watcher] getConfigRef called before initConfigRef, returning defaults";
    // 此时无 logger 可用，使用 console 作为最终回退
    console.warn(msg);
    _configRef = createConfigRef(getQQConfigDefaults());
  }
  return _configRef;
}

export interface UpdateResult {
  success: boolean;
  connectionChanged: boolean;
  error?: string;
}

/** 这些字段变更需要重启连接 */
const CONNECTION_FIELDS: (keyof QQConfig)[] = [
  "wsUrl",
  "httpUrl",
  "reverseWsPort",
  "accessToken",
];

/**
 * 用新的原始配置更新 ConfigRef。
 *
 * 若 Zod 验证失败，保留旧配置并返回 success=false。
 * 若连接参数（wsUrl/httpUrl/reverseWsPort/accessToken）有变更，
 * 返回 connectionChanged=true 以提示调用方。
 *
 * @param ref  由 createConfigRef 创建的引用
 * @param raw  待验证的原始配置对象
 */
export function updateConfigRef(ref: ConfigRef, raw: unknown): UpdateResult {
  const parsed = QQConfigSchema.safeParse(raw ?? {});
  const log = getLog(ref.log);

  if (!parsed.success) {
    const errMsg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    log.warn(`[config-watcher] Validation failed, keeping old config: ${errMsg}`);
    return { success: false, connectionChanged: false, error: errMsg };
  }

  const newConfig = parsed.data;

  // 热更新时也要映射 temperature → 三个子参数（与 resolveAccount 逻辑一致）
  const pm = newConfig.passiveMode;
  if (pm?.temperature !== undefined && pm.temperature !== null) {
    const mapped = resolvePassiveModeTemperature(pm.temperature);
    if (mapped) {
      newConfig.passiveMode = { ...pm, ...mapped };
    }
  }

  const oldConfig = ref.current;

  const connectionChanged = CONNECTION_FIELDS.some(
    (field) => String(newConfig[field] ?? "") !== String(oldConfig[field] ?? ""),
  );

  if (connectionChanged) {
    log.warn(
      "[config-watcher] Connection parameters changed (wsUrl/httpUrl/reverseWsPort/accessToken). " +
        "These require a restart to take effect.",
    );
  }

  // 原地赋值（而非替换引用），使所有已捕获 config 引用的闭包自动生效
  // （trigger.ts/inbound.ts 的 ctx.config 引用的是 ref.current 的同一对象）

  // 运行时可变字段（sleepMode / passiveMode）仅在配置文件中显式存在时才更新；
  // 缺失时保留 ref.current 中的运行时值（防止 /reload 重置 /sleep 命令的修改）
  const rawKeys = new Set(Object.keys(raw as Record<string, unknown>));
  for (const field of RUNTIME_MUTABLE_FIELDS) {
    if (!rawKeys.has(field)) {
      delete (newConfig as Record<string, unknown>)[field];
    }
  }

  Object.assign(ref.current, newConfig);
  return { success: true, connectionChanged };
}
