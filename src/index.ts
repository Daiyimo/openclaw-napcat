/**
 * QQ (NapCat) channel plugin for OpenClaw.
 *
 * Uses OneBot v11 protocol to connect to QQ via NapCat or similar implementations.
 */
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { qqChannel } from "./channel.js";

export default defineChannelPluginEntry({
  id: "qq",
  name: "QQ (NapCat)",
  description: "QQ channel plugin via OneBot v11 (NapCat, LLOneBot, etc.)",
  plugin: qqChannel,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program
          .command("qq")
          .description("QQ channel management");
      },
      {
        descriptors: [
          {
            name: "qq",
            description: "QQ channel management",
            hasSubcommands: false,
          },
        ],
      },
    );
  },
});

// Re-export public APIs
export { sendProactive, sendBulkProactive, broadcastToKnownUsers } from "./proactive.js";
export { listKnownUsers, getKnownUsersStats, recordKnownUser, flushKnownUsers } from "./known-users.js";
export type { KnownUser } from "./known-users.js";
