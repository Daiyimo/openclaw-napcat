import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { qqChannel } from "./channel.js";
import { setQQRuntime } from "./runtime.js";

export { sendProactive, sendBulkProactive, broadcastToKnownUsers } from "./proactive.js";
export { listKnownUsers, getKnownUsersStats, recordKnownUser, flushKnownUsers } from "./known-users.js";
export type { KnownUser } from "./known-users.js";

// 3.31: 使用 defineChannelPluginEntry 注册模式
// 注意：3.31 的 register 会收到 api.registrationMode，
// setup-only / cli-metadata 模式下不需要初始化 runtime。
const plugin = {
  id: "napcat",
  name: "NapCat (OneBot 11)",
  description: "QQ channel plugin via OneBot v11 (NapCat)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 仅在完整注册模式下初始化 runtime 单例
    if (api.registrationMode !== "setup-only" && api.registrationMode !== "cli-metadata") {
      setQQRuntime(api.runtime);
    }
    api.registerChannel({ plugin: qqChannel });
  },
};

export default plugin;
