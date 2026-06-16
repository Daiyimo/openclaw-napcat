import type { PluginRuntime } from "openclaw/plugin-sdk";

/**
 * 类型守卫：验证值是否符合 PluginRuntime 结构。
 * 最小检查：对象非空且拥有 channel 属性。
 */
function isPluginRuntime(value: unknown): value is PluginRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "channel" in value &&
    typeof (value as Record<string, unknown>).channel === "object" &&
    (value as Record<string, unknown>).channel !== null
  );
}

let runtime: PluginRuntime | null = null;

export function setQQRuntime(next: unknown): void {
  if (!isPluginRuntime(next)) {
    throw new Error("Invalid PluginRuntime: expected object with channel property");
  }
  runtime = next;
}

export function getQQRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQ runtime not initialized");
  }
  return runtime;
}
