# OpenClaw NapCat Plugin (OneBot v11)

This plugin connects [OpenClaw](https://github.com/openclaw/openclaw) to [NapCat](https://napneko.github.io) via the OneBot v11 protocol, enabling full-featured group chat, direct message, and guild (channel) support. It goes beyond basic messaging with production-grade reliability features, rich interaction modes, and deep NapCat API integration.

## Why NapCat?

[NapCat](https://napneko.github.io) is the leading open-source OneBot v11 implementation in China, built on top of the modern NTQQ client. It runs on Windows, Linux, and macOS (x64), with memory usage as low as 50–100 MB. NapCat uses a Core/Adapter architecture that allows seamless migration between bot protocols. Its active QQ and Telegram communities, rapid release cadence (4.16.0+ recommended), and rich extended API surface (AI voice, emoji reactions, read receipts, file upload) make it the most capable and widely-deployed OneBot backend available today.

This plugin targets OpenClaw `2026.2.26` and uses the same `abortSignal`-based gateway lifecycle pattern introduced for the Google Chat, Telegram, and LINE channels in that release.

## Features

### Intelligence & Context
- **History recall**: Automatically fetches the last N group messages (default 5) so the AI understands conversation context.
- **System prompt injection**: Define a custom persona or instruction set.
- **Forwarded message parsing**: Reads merged forward chat logs and passes their content to the AI.
- **Keyword triggers**: Trigger the bot by keyword in addition to @mention (group/guild: @mention is still required to prevent accidental triggers).

### Reliability & Safety
- **Connection self-healing**: WebSocket ping-based heartbeat with forced reconnect on timeout (90 s dead-connection detection).
- **Rate limiting**: Configurable delay between outbound messages to avoid platform throttling.
- **Message deduplication**: Prevents duplicate replies when the same event is delivered more than once.
- **Group allowlist / user blocklist**: Restrict the bot to specific groups; ignore specific users.
- **Anti-risk URL mode**: Inserts whitespace into URLs to reduce the chance of messages being silently dropped.
- **System account filtering**: Ignores messages from automated system bots.
- **Auto-approve requests**: Optionally approve friend/group-join requests without manual intervention.

### Rich Interactions
- **Poke (nudge)**: Detects incoming pokes in both group and direct chats; pokes back and generates a contextual AI reply.
- **Emoji reactions**: Reacts to trigger messages with a configured emoji ID, or lets the AI choose dynamically (`reactionEmoji: "auto"`).
- **Auto mark-as-read**: Keeps the unread counter clear.
- **AI voice (NapCat)**: Uses NapCat's native `send_group_ai_record` API for high-quality AI-generated voice replies.
- **Auto @mention in groups**: Automatically @mentions the original sender on the first reply segment.
- **Nickname resolution**: Converts `[CQ:at]` codes to real display names before passing to the AI.

### Multimedia
- **Images**: Send and receive images. Supports `base64://` encoding for cross-network deployments where the bot and NapCat are on different networks.
- **Voice**: Receive voice messages (requires STT on the server side) and optionally reply with TTS voice.
- **Files**: Upload and receive group/private files using NapCat's upload APIs with CQ code fallback.
- **Guilds**: Native send/receive for guild (channel) messages.

---

## 前置条件

1.  **OpenClaw**：已安装并运行 OpenClaw 主程序。
2.  **OneBot v11 服务端**：你需要一个运行中的 OneBot v11 实现。
    *   推荐：**[NapCat (Docker)](https://github.com/NapCatQQ/NapCat-Docker)** (4.16.0+) 或 **Lagrange**。
    *   **重要配置**：请务必在 OneBot 配置中将 `message_post_format` 设置为 `array`（数组格式），否则无法解析多媒体消息。

### NapCat 配置参考图

#### 1. HTTP 配置
![HTTP配置图](docs/images/http配置图.jpg)

#### 2. WebSocket 反向配置
![WS反向配置图](docs/images/ws反向配置图.jpg)

> **注意**：在 WS 反向配置中，URL 地址需要填 **OpenClaw 所在服务器的 IP**（如 `ws://192.168.110.2:3002`），而不是 `127.0.0.1`。

---

## 安装指南

### 快速部署 (一行命令)

```bash
# 一行命令安装 QQ 插件
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/v4.17.25/install.sh | sudo bash

# 一行命令修改 JSON 文件
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/v4.17.25/update_json.sh | sudo bash
```

### 方法 : 使用 OpenClaw CLI (推荐)
```bash
# From your OpenClaw extensions directory
git clone https://github.com/Daiyimo/openclaw-napcat napcat
cd napcat
npm install
```

---

## Configuration

### openclaw.json

```json
{
  "channels": {
    "napcat": {
      "reverseWsPort": 3002,
      "httpUrl": "http://127.0.0.1:3000",
      "accessToken": "your-token",
      "admins": [12345678],
      "allowedGroups": [10001, 10002],
      "blockedUsers": [999999],
      "systemPrompt": "You are a helpful assistant.",
      "historyLimit": 5,
      "keywordTriggers": ["assistant", "help"],
      "autoApproveRequests": false,
      "enableGuilds": true,
      "enableTTS": false,
      "rateLimitMs": 1000,
      "formatMarkdown": true,
      "antiRiskMode": false,
      "maxMessageLength": 4000,
      "reactionEmoji": "",
      "autoMarkRead": false,
      "aiVoiceId": ""
    }
  },
  "gateway": {
    "controlUi": {
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true
    },
    "trustedProxies": ["127.0.0.1"]
  },
  "plugins": {
    "entries": {
      "napcat": { "enabled": true }
    }
  }
}
```

> **Note (OpenClaw 2026.2.25+)**: The `gateway` section is required. `dangerouslyAllowHostHeaderOriginFallback: true` is needed when the gateway is bound to `0.0.0.0` and accessed by IP address. Device pairing must be completed on first use — see [Device Pairing](#device-pairing-openclaw-20262025) below.

### Configuration Reference

| Key | Type | Default | Description |
|---|---|---|---|
| `wsUrl` | string | — | Forward WebSocket URL (e.g. `ws://localhost:3001`). Use this or `reverseWsPort` or both. |
| `httpUrl` | string | — | HTTP API URL (e.g. `http://localhost:3000`). Used for outbound sends; falls back to WS. |
| `reverseWsPort` | number | — | Port for a reverse WebSocket server. NapCat connects here to push events. |
| `accessToken` | string | — | Authentication token shared with NapCat. |
| `admins` | number[] | `[]` | User IDs with access to admin commands (`/status`, `/kick`, etc.). |
| `requireMention` | boolean | `true` | Only respond when @mentioned or replied-to in group/guild chats. |
| `allowedGroups` | number[] | `[]` | Group allowlist. Empty = respond in all groups. |
| `blockedUsers` | number[] | `[]` | User blocklist. Messages from these users are ignored. |
| `systemPrompt` | string | — | Injected into the AI context as a system instruction. |
| `historyLimit` | number | `5` | Number of preceding group messages to include as context. Set to `0` to disable. |
| `keywordTriggers` | string[] | `[]` | Keywords that trigger a reply (group/guild: also requires @mention). |
| `autoApproveRequests` | boolean | `false` | Auto-approve friend and group-join requests. |
| `enableGuilds` | boolean | `true` | Enable guild (channel) message support. |
| `enableTTS` | boolean | `false` | Send AI replies as voice messages. |
| `rateLimitMs` | number | `1000` | Milliseconds between consecutive outbound messages. |
| `formatMarkdown` | boolean | `false` | Strip markdown formatting for plain-text readability. |
| `antiRiskMode` | boolean | `false` | Add whitespace to URLs to reduce silent message drops. |
| `maxMessageLength` | number | `4000` | Split messages longer than this into chunks. |
| `reactionEmoji` | string | — | Emoji ID to react with on trigger (e.g. `"128077"` = 👍). Set to `"auto"` for AI-selected reactions. |
| `autoMarkRead` | boolean | `false` | Mark messages as read automatically. |
| `aiVoiceId` | string | — | NapCat AI voice character ID. Takes priority over `CQ:tts` when `enableTTS` is on. |

---

## Device Pairing (OpenClaw 2026.2.25+)

OpenClaw 2026.2.25 requires browser clients to complete a one-time device pairing before WebSocket connections are accepted (error code 4008 otherwise).

**1. Start OpenClaw and open the WebUI in your browser:**
```
http://<server-ip>:18789
```

**2. List pending pairing requests:**
```bash
sudo openclaw devices list
```

**3. Approve the request (join the UUID across line breaks):**
```bash
sudo openclaw devices approve 755e8961-2b4d-4440-81a5-a3691f8374ca
```

**4. Refresh the browser.** The pairing is persistent — the same device does not need re-approval on subsequent connections.

---

## Usage

### Chat Triggers

- **Direct message**: Send any message directly to the bot.
- **Group**: @mention the bot, reply to a bot message, or use a configured keyword while @mentioning.
- **Poke (nudge)**: Poke the bot in a group or DM.

### Admin Commands

Available to users listed in `admins`. In groups, the bot must be @mentioned.

| Command | Description |
|---|---|
| `/status` | Show connection state, self ID, and memory usage. |
| `/help` | List available commands. |
| `/mute @user [minutes]` | Mute a user. Default: 30 minutes. (Group only) |
| `/kick @user` | Remove a user from the group. (Group only) |

### 📅 定时任务 (Cron) `to` 字段格式

在 OpenClaw 的 cron 定时任务配置中，`to` 字段用于指定消息发送目标。**必须使用正确的前缀来区分目标类型**，否则会默认当作私聊发送，导致 `sendPrivateMsg` 报错"请指定正确的 group_id 或 user_id"。

| 目标类型 | `to` 字段格式 | 示例 |
| :--- | :--- | :--- |
| **私聊** | `QQ号` 或 `private:QQ号` | `"12345678"` 或 `"private:12345678"` |
| **群聊** | `group:群号` | `"group:88888888"` |
| **频道** | `guild:频道ID:子频道ID` | `"guild:123456:789012"` |

**配置示例**（`openclaw.json` 中的 cron 部分）：

**Example cron configuration:**
```json
{
  "cron": [
    {
      "schedule": "0 9 * * *",
      "delivery": {
        "channel": "napcat",
        "to": "group:88888888",
        "text": "Good morning!"
      }
    }
  ]
}
```

---

## Changelog

### v1.5.0 — Rename to NapCat (2026-02-27)

Renamed all public-facing identifiers from `qq` to `napcat` to reflect the actual underlying runtime. Internal protocol identifiers (OneBot CQ codes) are unchanged.

### v1.3.2 — OpenClaw 2026.2.25+ gateway compatibility (2026-02-27)

Added `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback` to fix WebSocket error 4008 when the gateway is bound to `0.0.0.0`. Updated `update_json.sh` to write this config automatically and print device-pairing instructions on startup.

### v1.3.1 — Trigger fix (2026-02-27)

- Keyword triggers in group/guild chats now require @mention to prevent accidental activation.
- Admin commands in groups now require @mention.

### v1.3.0 — Deep NapCat API integration (2026-02-12)

Added emoji reactions (`set_msg_emoji_like`), read receipts (`mark_group/private_msg_as_read`), AI voice (`send_group_ai_record`), private poke (`friend_poke`), bulk member cache (`get_group_member_list`), and file upload APIs.

### v1.2.0 — Outbound target parsing (prior)

Introduced `parseTarget()` and `dispatchMessage()` for unified outbound routing. Added `private:` prefix support. Fixed silent `NaN` errors on malformed targets.

### v1.1.0 — HTTP API + reverse WebSocket (prior)

Added HTTP API send path with WS fallback. Added reverse WebSocket server mode. Fixed silent outbound failures — `outbound.sendText` now surfaces real errors.

### v1.0.0 — Initial release (prior)

Basic OneBot v11 forward WebSocket support with group/private/guild messaging, @mention trigger, history context, and admin commands.
