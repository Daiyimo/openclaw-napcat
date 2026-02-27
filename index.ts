import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { napcatChannel } from "./src/channel.js";
import { setNapcatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "NapCat (OneBot)",
  description: "NapCat channel plugin via OneBot v11",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNapcatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatChannel });
  },
};

export default plugin;
