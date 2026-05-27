/**
 * 配置热更新支持
 *
 * 提供 ConfigRef 引用对象，运行时通过 /reload 命令触发配置重新加载。
 * 使用 Zod schema 验证新配置，验证失败则保留旧值。
 */

import { QQConfigSchema, type QQConfig } from "./config.js";

export interface ConfigRef {
  /** 当前生效的配置 */
  current: QQConfig;
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
 * 创建一个持有当前配置的引用对象。
 * @param initial 初始配置，必须已通过 Zod 验证
 */
export function createConfigRef(initial: QQConfig): ConfigRef {
  return { current: initial };
}

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

  if (!parsed.success) {
    const errMsg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    console.warn(`[config-watcher] Validation failed, keeping old config: ${errMsg}`);
    return { success: false, connectionChanged: false, error: errMsg };
  }

  const newConfig = parsed.data;
  const oldConfig = ref.current;

  const connectionChanged = CONNECTION_FIELDS.some(
    (field) => String(newConfig[field] ?? "") !== String(oldConfig[field] ?? ""),
  );

  if (connectionChanged) {
    console.warn(
      "[config-watcher] Connection parameters changed (wsUrl/httpUrl/reverseWsPort/accessToken). " +
        "These require a restart to take effect.",
    );
  }

  ref.current = newConfig;
  return { success: true, connectionChanged };
}
