# 配置详解

> 快速配置请使用 `bash scripts/update_json.sh`，详见 [README](../README.md) 安装指南。

## 完整配置清单

编辑 `~/.openclaw/openclaw.json`，在 `channels.napcat` 下添加以下配置：

```json
{
  "channels": {
    "napcat": {
      "reverseWsPort": 3002,
      "httpUrl": "http://127.0.0.1:3000",
      "accessToken": "123456",
      "admins": [12345678],
      "allowedGroups": [10001, 10002],
      "blockedUsers": [999999],
      "systemPrompt": "好好干，你不干，有的是其他AI干。",
      "historyLimit": 5,
      "keywordTriggers": ["小助手", "帮助"],
      "autoApproveRequests": true,
      "enableGuilds": true,
      "enableTTS": false,
      "enableSTT": false,
      "rateLimitMs": 1000,
      "formatMarkdown": false,
      "markdownMode": "passthrough",
      "antiRiskMode": false,
      "maxMessageLength": 4000,
      "enableReactions": true,
      "autoMarkRead": false,
      "aiVoiceId": "",
      "deliverDebounce": { "enabled": true, "windowMs": 1500, "maxWaitMs": 8000 },
      "enableUpdateCheck": true,
      "logBufferSize": 200
    }
  },
  "gateway": {
    "controlUi": {
      "allowInsecureAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true
    },
    "trustedProxies": ["127.0.0.1", "192.168.110.0/24"]
  },
  "plugins": {
    "entries": {
      "napcat": { "enabled": true }
    }
  }
}
```

## 配置项参考

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | - | OneBot v11 正向 WebSocket 地址。与 `reverseWsPort` 二选一，或同时配置作备用 |
| `httpUrl` | string | - | OneBot v11 HTTP API 地址（如 `http://localhost:3000`），用于主动发送消息和定时任务 |
| `reverseWsPort` | number | - | 反向 WebSocket 监听端口（如 `3002`），NapCat 主动连接到此端口接收事件 |
| `accessToken` | string | - | 连接鉴权 Token |
| `admins` | number[] | `[]` | **管理员 QQ 号列表**。拥有执行 `/status`, `/kick` 等指令的权限。 |
| `requireMention` | boolean | `true` | **是否需要 @ 触发**。设为 `true` 仅在被 @ 或回复机器人时响应。 |
| `systemPrompt` | string | - | **人设设定**。注入到 AI 上下文的系统提示词。 |
| `enableDeduplication` | boolean | `true` | 消息去重，防止同一条消息被处理两次。 |
| `enableErrorNotify` | boolean | `true` | 出错时通知管理员或当前用户。 |
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友申请和群邀请。 |
| `maxMessageLength` | number | `4000` | 单条消息最大长度（100–10000），超过将自动分片发送。 |
| `formatMarkdown` | boolean | `false` | 是否将 Markdown 表格/列表转换为易读的纯文本排版。 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如给 URL 加空格）。 |
| `allowedGroups` | number[] | `[]` | **群组白名单**。若设置，Bot 仅在这些群组响应；若为空，则响应所有群组。 |
| `blockedUsers` | number[] | `[]` | **用户黑名单**。Bot 将忽略这些用户的消息。 |
| `ignoreSenderBot` | boolean | `true` | **过滤其他 bot 消息**。收到 `sender.bot=true` 的消息时直接跳过，防止 bot 间循环对话。设为 `false` 时放行 bot 消息，`botSuppressionMs` 不生效。 |
| `historyLimit` | number | `5` | **历史消息条数**。群聊时携带最近 N 条消息给 AI（0-100），设为 0 关闭。 |
| `keywordTriggers` | string[] | `[]` | **关键词触发**。群聊中消息包含这些关键词时直接触发回复，无需同时 @机器人（私聊同样有效）。 |
| `enableTTS` | boolean | `false` | (实验性) 是否将 AI 回复转为语音发送 (需服务端支持 TTS)。 |
| `enableGuilds` | boolean | `true` | 是否开启 QQ 频道 (Guild) 支持。 |
| `rateLimitMs` | number | `1000` | **发送限速**。多条消息间的延迟(毫秒，0–60000)，建议设为 1000 以防风控。 |
| `reactionEmoji` | string | - | 保留字段，`enableReactions` 开启时不使用。 |
| `enableReactions` | boolean | `true` | **智能表情回应**。默认开启，根据消息内容自动贴对应表情（如查找类→OK，悲伤类→流泪），默认表情为喵喵（307）。设为 `false` 可关闭。 |
| `autoMarkRead` | boolean | `false` | 是否自动标记消息为已读，防止未读消息堆积。 |
| `aiVoiceId` | string | - | NapCat AI 语音角色 ID，当 `enableTTS` 开启时优先使用 AI 语音 API 代替 CQ:tts。 |
| `enableSTT` | boolean | `false` | 是否开启语音消息转文字（需配置 STT 提供商）。 |
| `markdownMode` | string | `"passthrough"` | Markdown 处理模式：`passthrough` 原样发送、`strip` 剥除格式、`native` 使用 NapCat 原生 Markdown 段。 |
| `deliverDebounce` | object | - | 出站消息防抖配置。`enabled` 开关，`windowMs`（默认1500，100–30000）静默窗口，`maxWaitMs`（默认8000，1000–120000）最长等待，`separator` 合并分隔符。 |
| `enableUpdateCheck` | boolean | `true` | 启动时检查 npm 是否有新版本。 |
| `logBufferSize` | number | `200` | `/logs` 命令保留的日志行数（10–10000）。 |
| `inboundRateLimitMs` | number | `0` | 入站频控（ms），同一来源两次触发的最小间隔。`0` = 禁用。 |
| `silentKeywords` | string[] | `[]` | **静默关键词**。消息包含任一关键词时直接丢弃，不触发 AI、不回复（适合过滤其他 bot 指令）。 |
| `passiveMode` | object | - | **旁观模式**配置，见下方详细说明。 |

## gateway 必填说明

> **注意（OpenClaw 2026.2.25+）**：`gateway` 段为必填项。2026.2.26 新增了 Host 头校验，绑定 `0.0.0.0` 时需配置 `dangerouslyAllowHostHeaderOriginFallback: true`。2026.2.25 封堵了静默自动配对，首次使用 WebUI 前需完成设备配对，见 [README](../README.md) 设备配对章节。

## passiveMode 详细说明

```json
{
  "passiveMode": {
    "enabled": true,
    "cooldownMs": 10000,
    "minIntervalMs": 30000,
    "botSuppressionMs": 120000,
    "systemPrompt": "你是一个观察者，仅在值得发言时回复，否则输出 [SILENT]"
  }
}
```

| 子字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `false` | 是否开启旁观模式。开启后 AI 监听所有群消息，自主判断是否发言。 |
| `cooldownMs` | number | `10000` | **实质回复冷却**。AI 真实回复后，该会话 `cooldownMs` 毫秒内不再触发（0–3600000）。 |
| `minIntervalMs` | number | `30000` | **最小触发间隔**。含 [SILENT] 响应在内的所有检查的最小间隔，防止 AI 被频繁调用（0–3600000）。 |
| `botSuppressionMs` | number | `120000` | **友军抑制时长**。检测到其他 bot 在该群回复后，本 bot 静音该时长（ms）。`0` = 禁用。依赖 `ignoreSenderBot=true`。 |
| `systemPrompt` | string | - | **旁观人设**。仅在旁观模式下注入的额外系统提示词，指导 AI 何时发言、何时 [SILENT]。 |

**工作流程：** 群消息到达 → 检测触发（@/关键词）→ 通过 `minIntervalMs` 限流 → 通过 `botSuppressionMs` 友军抑制 → 通过 `cooldownMs` 冷却 → AI 判断 → 输出回复 或 `[SILENT]`。
