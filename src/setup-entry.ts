/**
 * Setup entry point for QQ (NapCat) channel plugin.
 *
 * This is a lightweight entry that is loaded BEFORE the full runtime,
 * used for setup wizards, channel status checks, and configuration validation.
 *
 * This keeps the setup flow fast by not loading the full runtime (client, listeners, etc).
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { qqChannel } from "./channel.js";

export default defineSetupPluginEntry(qqChannel);
