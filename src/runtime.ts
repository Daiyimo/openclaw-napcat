import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setNapcatRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getNapcatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("NapCat runtime not initialized");
  }
  return runtime;
}
