import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { qqChannel } from "./channel.js";
import { setQQRuntime } from "./runtime.js";

export { sendProactive, sendBulkProactive, broadcastToKnownUsers } from "./proactive.js";
export { listKnownUsers, getKnownUsersStats, recordKnownUser, flushKnownUsers } from "./known-users.js";
export type { KnownUser } from "./known-users.js";

const plugin = {
  id: "napcat",
  name: "NapCat (OneBot 11)",
  description: "QQ channel plugin via OneBot v11 (NapCat)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    if (api.registrationMode === "cli-metadata" || api.registrationMode === "tool-discovery") {
      // cli-metadata/tool-discovery 模式不注册 channel、不注入 runtime（对齐官方 defineChannelPluginEntry）
      return;
    }
    if (api.registrationMode !== "setup-only") {
      setQQRuntime(api.runtime);
    }
    api.registerChannel({ plugin: qqChannel });
  },
};

export default plugin;
