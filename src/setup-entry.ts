/**
 * Setup-only 入口（package.json openclaw.setupEntry 指向本文件的编译产物）。
 *
 * OpenClaw 在 onboarding / 渠道配置 / 只读状态与 SecretRef 扫描时加载本文件，
 * 避免拉起完整入口的重依赖。约束（对齐上游 docs/plugins/sdk-setup.md）：
 *   - 只注册 channel plugin 对象，不起 client / listener / 后台服务
 *   - 模块图仅含 config.ts（纯 zod）与 config-adapter.ts（纯函数 + SDK helper）
 *
 * 完整运行时入口见 index.ts。
 */

import {
  type ChannelPlugin,
  buildChannelConfigSchema,
  defineSetupPluginEntry,
} from "openclaw/plugin-sdk/core";
import { QQConfigSchema } from "./config.js";
import { createQQConfigAdapter } from "./config-adapter.js";
import type { ResolvedQQAccount } from "./types/channel-types.js";

const napcatSetupPlugin: ChannelPlugin<ResolvedQQAccount, unknown, unknown> = {
  id: "napcat",
  meta: {
    id: "napcat",
    label: "NapCat (OneBot 11)",
    selectionLabel: "NapCat",
    docsPath: "extensions/napcat",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    reply: true,
    unsend: true,
    nativeCommands: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: createQQConfigAdapter(),
};

export default defineSetupPluginEntry(napcatSetupPlugin);
