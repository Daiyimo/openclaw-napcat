
OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
# OpenClaw QQ 插件 (OneBot v11)

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加全功能的 QQ 频道支持。它不仅支持基础聊天，还集成了群管、频道、多模态交互和生产级风控能力。

## ✨ 核心特性

### 🧠 深度智能与上下文
*   **历史回溯 (Context)**：在群聊中自动获取最近 N 条历史消息（默认 5 条），让 AI 能理解对话前文，不再“健忘”。
*   **系统提示词 (System Prompt)**：支持注入自定义提示词，让 Bot 扮演特定角色（如“猫娘”、“严厉的管理员”）。
*   **转发消息理解**：AI 能够解析并读取用户发送的合并转发聊天记录，处理复杂信息。
*   **关键词唤醒**：除了 @机器人，支持配置特定的关键词（如”小助手”）来触发对话。**关键词触发需同时 @机器人**，避免群聊中普通对话意外触发。

### 🛡️ 强大的管理与风控
*   **连接自愈**：内置心跳检测与重连指数退避机制，能自动识别并修复“僵尸连接”，确保 7x24 小时在线。
*   **群管指令**：管理员可直接在 QQ 中使用指令管理群成员（禁言/踢出）。
*   **黑白名单**：
    *   **群组白名单**：只在指定的群组中响应，避免被拉入广告群。
    *   **用户黑名单**：屏蔽恶意用户的骚扰。
*   **自动请求处理**：可配置自动通过好友申请和入群邀请，实现无人值守运营。
*   **生产级风控**：
    *   **默认 @ 触发**：默认开启 `requireMention`，仅在被 @ 时回复，保护 Token 并不打扰他人。
    *   **速率限制**：发送多条消息时自动插入随机延迟，防止被 QQ 风控禁言。
    *   **URL 规避**：自动对链接进行处理（如加空格），降低被系统吞消息的概率。
    *   **系统号屏蔽**：自动过滤 QQ 管家等系统账号的干扰。

### 🎭 丰富的交互体验
*   **戳一戳 (Poke)**：当用户"戳一戳"机器人时，AI 会感知到并做出有趣的回应。支持群聊和私聊双向戳一戳。
*   **表情回应 (Reaction)**：收到触发消息时，自动对消息添加表情回应（如竖起大拇指），提升交互体验。
*   **已读标记 (Mark Read)**：自动标记消息为已读，避免未读消息堆积。
*   **AI 语音 (AI Voice)**：利用 NapCat 原生 AI 语音 API，支持丰富的音色角色，比传统 TTS 更自然。
*   **拟人化回复**：
    *   **自动 @**：在群聊回复时，自动 @原发送者（仅在第一段消息），符合人类社交礼仪。
    *   **昵称解析**：将消息中的 `[CQ:at]` 代码转换为真实昵称（如 `@张三`），AI 回复更自然。
*   **多模态支持**：
    *   **图片**：支持收发图片。优化了对 `base64://` 格式的支持，即使 Bot 与 OneBot 服务端不在同一局域网也可正常交互。
    *   **语音**：接收语音消息（需服务端支持 STT）并可选开启 TTS 语音回复。
    *   **文件**：支持群文件和私聊文件的收发。
*   **QQ 频道 (Guild)**：原生支持 QQ 频道消息收发。

---

## 📋 前置条件

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

## 🚀 安装指南

### 快速部署 (一行命令)

```bash
# 一行命令安装 QQ 插件
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/v4.17.25/install.sh | sudo bash

# 一行命令修改 JSON 文件
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/v4.17.25/update_json.sh | sudo bash
```

### 方法 : 使用 OpenClaw CLI (推荐)
如果你的 OpenClaw 版本支持插件市场或 CLI 安装：
```bash
# 进入插件目录
cd openclaw/extensions
# 克隆仓库
git clone -b pre-release https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat/tree/main.git qq
# 进入qq插件目录
npm install -g pnpm
# 安装qq
pnpm install qq
```

---

## ⚙️ 配置说明

### 1. 快速配置 (update_json.sh)
插件内置了交互式配置脚本，在插件目录下运行：

```bash
bash update_json.sh
```

脚本会依次完成以下步骤：
1. 交互式收集配置（反向 WS 端口、HTTP API 地址、管理员 QQ 号）
2. 备份并更新 `~/.openclaw/openclaw.json`
3. 检测 QQ 插件状态，未检测到时询问是否启动
4. 打印设备配对引导（OpenClaw 2026.2.25+ 要求），等待用户确认
5. 执行 `sudo openclaw gateway` 启动网关（前台运行，日志直接输出）

启动网关后，按引导在另一个终端完成设备配对即可。

### 2. 标准化配置 (OpenClaw Setup)
如果已集成到 OpenClaw CLI，可运行：
```bash
openclaw setup qq
```

### 3. 手动配置详解 (`openclaw.json`)
你也可以直接编辑配置文件。以下是完整配置清单：

```json
{
  "channels": {
    "qq": {
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
    "trustedProxies": ["127.0.0.1", "192.168.110.0/24"]
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  }
}
```

> **注意（OpenClaw 2026.2.25+）**：`gateway` 段为必填项。2026.2.26 新增了 Host 头校验，绑定 `0.0.0.0` 时需配置 `dangerouslyAllowHostHeaderOriginFallback: true`。2026.2.25 封堵了静默自动配对，首次使用 WebUI 前需完成设备配对，见下方[设备配对](#设备配对-openclaw-20262025)章节。

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | - | OneBot v11 正向 WebSocket 地址。与 `reverseWsPort` 二选一，或同时配置作备用 |
| `httpUrl` | string | - | OneBot v11 HTTP API 地址（如 `http://localhost:3000`），用于主动发送消息和定时任务 |
| `reverseWsPort` | number | - | 反向 WebSocket 监听端口（如 `3002`），NapCat 主动连接到此端口接收事件 |
| `accessToken` | string | - | 连接鉴权 Token |
| `admins` | number[] | `[]` | **管理员 QQ 号列表**。拥有执行 `/status`, `/kick` 等指令的权限。 |
| `requireMention` | boolean | `true` | **是否需要 @ 触发**。设为 `true` 仅在被 @ 或回复机器人时响应。 |
| `allowedGroups` | number[] | `[]` | **群组白名单**。若设置，Bot 仅在这些群组响应；若为空，则响应所有群组。 |
| `blockedUsers` | number[] | `[]` | **用户黑名单**。Bot 将忽略这些用户的消息。 |
| `systemPrompt` | string | - | **人设设定**。注入到 AI 上下文的系统提示词。 |
| `historyLimit` | number | `5` | **历史消息条数**。群聊时携带最近 N 条消息给 AI，设为 0 关闭。 |
| `keywordTriggers` | string[] | `[]` | **关键词触发**。群聊中包含这些关键词且同时 @机器人 时触发回复（私聊无此限制）。 |
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友申请和群邀请。 |
| `enableGuilds` | boolean | `true` | 是否开启 QQ 频道 (Guild) 支持。 |
| `enableTTS` | boolean | `false` | (实验性) 是否将 AI 回复转为语音发送 (需服务端支持 TTS)。 |
| `rateLimitMs` | number | `1000` | **发送限速**。多条消息间的延迟(毫秒)，建议设为 1000 以防风控。 |
| `formatMarkdown` | boolean | `false` | 是否将 Markdown 表格/列表转换为易读的纯文本排版。 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如给 URL 加空格）。 |
| `maxMessageLength` | number | `4000` | 单条消息最大长度，超过将自动分片发送。 |
| `reactionEmoji` | string | - | 收到触发消息时自动回应的表情 ID（如 `"128077"` 为竖大拇指），留空不启用。 |
| `autoMarkRead` | boolean | `false` | 是否自动标记消息为已读，防止未读消息堆积。 |
| `aiVoiceId` | string | - | NapCat AI 语音角色 ID，当 `enableTTS` 开启时优先使用 AI 语音 API 代替 CQ:tts。 |

---

## 设备配对 (OpenClaw 2026.2.25+)

OpenClaw 2026.2.25 起，首次通过浏览器访问 WebUI 需要完成设备配对，否则 WebSocket 连接会被拒绝（错误码 4008）。

### 配对步骤

**1. 启动服务后，在浏览器中打开 WebUI**（会显示等待配对的提示）：
```
http://<服务器IP>:18789
```

**2. 新开一个终端，查看待审批的设备请求：**
```bash
sudo openclaw devices list
```
输出示例（找 `Pending` 表中的 `Request` 列拼接出的 UUID）：
```
Pending (1)
┌────────────────────────────┬────────┬─────...
│ Request                    │ Device │ ...
├────────────────────────────┼────────┼─────...
│ 755e8961-2b4d-4440-81a5-   │ ...    │ ...
│ a3691f8374ca               │        │ ...
└────────────────────────────┴────────┴─────...
```

**3. 审批该请求（Request 列跨行内容拼接为完整 UUID）：**
```bash
sudo openclaw devices approve 755e8961-2b4d-4440-81a5-a3691f8374ca
```

**4. 刷新浏览器**，即可正常访问 WebUI。

> 配对只需做一次，之后同一设备带 token 访问不再需要重复审批。

---

## 🎮 使用指南

### 🗣️ 基础聊天
*   **私聊**：直接发送消息给机器人即可。
*   **群聊**：
    *   **@机器人** + 消息。
    *   回复机器人的消息。
    *   **@机器人** + 包含**关键词**（如配置中的”小助手”）的消息。
    *   **戳一戳**机器人头像。

### 👮‍♂️ 管理员指令
仅配置在 `admins` 列表中的用户可用。**群聊中需 @机器人**才能触发，私聊中直接发送即可：

*   `/status`
    *   查看机器人运行状态（内存占用、连接状态、Self ID）。
*   `/help`
    *   显示帮助菜单。
*   `/mute @用户 [分钟]` (仅群聊)
    *   禁言指定用户。不填时间默认 30 分钟。
    *   示例：`/mute @张三 10`
*   `/kick @用户` (仅群聊)
    *   将指定用户移出群聊。

### 💻 CLI 命令行使用
如果你在服务器终端操作 OpenClaw，可以使用以下标准命令：

1.  **查看状态**
    ```bash
    openclaw status
    ```
    显示 QQ 连接状态、延迟及当前 Bot 昵称。

2.  **列出群组/频道**
    ```bash
    openclaw list-groups --channel qq
    ```
    列出所有已加入的群聊和频道 ID。

3.  **主动发送消息**
    ```bash
    # 发送私聊
    openclaw send qq 12345678 "你好，这是测试消息"
    
    # 发送群聊 (使用 group: 前缀)
    openclaw send qq group:88888888 "大家好"
    
    # 发送频道消息
    openclaw send qq guild:GUILD_ID:CHANNEL_ID "频道消息"
    ```

### 📅 定时任务 (Cron) `to` 字段格式

在 OpenClaw 的 cron 定时任务配置中，`to` 字段用于指定消息发送目标。**必须使用正确的前缀来区分目标类型**，否则会默认当作私聊发送，导致 `sendPrivateMsg` 报错"请指定正确的 group_id 或 user_id"。

| 目标类型 | `to` 字段格式 | 示例 |
| :--- | :--- | :--- |
| **私聊** | `QQ号` 或 `private:QQ号` | `"12345678"` 或 `"private:12345678"` |
| **群聊** | `group:群号` | `"group:88888888"` |
| **频道** | `guild:频道ID:子频道ID` | `"guild:123456:789012"` |

**配置示例**（`openclaw.json` 中的 cron 部分）：

```json
{
  "cron": [
    {
      "schedule": "0 9 * * *",
      "delivery": {
        "channel": "qq",
        "to": "group:88888888",
        "text": "早上好，今天也要加油哦！"
      }
    },
    {
      "schedule": "0 18 * * *",
      "delivery": {
        "channel": "qq",
        "to": "private:12345678",
        "text": "下班提醒：记得喝水~"
      }
    },
    {
      "schedule": "0 12 * * *",
      "delivery": {
        "channel": "qq",
        "to": "guild:GUILD_ID:CHANNEL_ID",
        "text": "午间播报"
      }
    }
  ]
}
```

> **注意**：`to` 字段中纯数字（如 `"12345678"`）会被视为私聊 QQ 号。如果你要发送到群聊，**必须加上 `group:` 前缀**。

---

## ❓ 常见问题 (FAQ)

**Q: 安装依赖时报错 `openclaw @workspace:*` 找不到？**
A: 这是因为主仓库的 workspace 协议导致的。我们已在最新版本中将其修复，请执行 `git pull` 后直接使用 `pnpm install` 或 `npm install` 即可，无需特殊环境。

**Q: 给机器人发图片它没反应？**
A: 
1. 确认你使用的 OneBot 实现（如 NapCat）开启了图片上报。
2. 建议在 OneBot 配置中开启“图片转 Base64”，这样即使你的 OpenClaw 在公网云服务器上，也能正常接收本地内网机器人的图片。
3. 插件现在会自动识别并提取图片，不再强制要求开启 `message_post_format: array`。

**Q: 机器人与 OneBot 不在同一个网络环境（非局域网）能用吗？**
A: **完全可以**。只要 `wsUrl` 能够通过内网穿透或公网 IP 访问到，且图片通过 Base64 传输，即可实现跨地域部署。

**Q: 为什么群聊不回话？**
A: 
1. 检查 `requireMention` 是否开启（默认开启），需要 @机器人。
2. 检查群组是否在 `allowedGroups` 白名单内（如果设置了的话）。
3. 检查 OneBot 日志，确认消息是否已上报。

**Q: 如何让 Bot 说话（TTS）？**
A: 将 `enableTTS` 设为 `true`。注意：这取决于 OneBot 服务端是否支持 TTS 转换。通常 NapCat/Lagrange 对此支持有限，可能需要额外插件。



## 更新日志

### v1.3.2 - 适配 OpenClaw 2026.2.25+ 安全配置 (2026-02-27)

适配 OpenClaw 2026.2.25/2026.2.26 引入的 Gateway 安全策略，修复绑定 `0.0.0.0` 时 WebSocket 连接报 4008 错误的问题。

#### 变更详情

**1. 新增 `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`**

OpenClaw 2026.2.26 新增了 Host 头来源校验。当 gateway 绑定到 `0.0.0.0` 时，客户端通过 IP 访问会导致 Host 头不匹配被拒绝，需配置此项绕过。

**2. 关于 4008 配对问题**

OpenClaw 2026.2.25 封堵了非 Control UI 客户端的静默自动配对，首次访问 WebUI 需通过 CLI 完成设备配对：

```bash
# 查看待审批的设备请求
openclaw devices list

# 审批指定请求（requestId 从上方列表获取）
openclaw devices approve <requestId>
```

配对完成后，带 token 的 WebSocket 连接即可正常建立。`update_json.sh` 脚本启动服务后会自动打印配对操作指引。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `update_json.sh` | 新增 | 写入 `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true` |
| `README.md` | 文档 | 手动配置示例补充 `gateway` 段及注意事项 |



### v1.3.1 - 误触发修复 (2026-02-27)

修复群聊中关键词和管理员指令意外触发的问题。

#### 变更详情

**1. 关键词触发需同时 @机器人**

此前 `keywordTriggers` 中的关键词在群聊中只要消息包含该词就会触发，导致和别人聊天中顺带提到关键词（如"签到"）时意外触发机器人。

现在群聊/频道中，关键词触发必须同时满足 @机器人（或回复机器人消息），私聊中不受影响。

**2. 管理员指令需同时 @机器人（群聊）**

此前管理员在群聊中发送以 `/` 开头的消息（如 `/help`）就会触发机器人指令，无论是不是在和机器人说话。

现在群聊中管理员指令（`/status`、`/help`、`/mute`、`/kick`）需要同时 @机器人才会执行，私聊中直接发送仍可触发。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/channel.ts` | 修复 | 关键词触发增加 mention 前置检查；管理员命令增加群聊 mention 前置检查 |
| `README.md` | 文档 | 同步说明关键词触发和管理员指令的触发条件变更 |



### v1.3.0 - NapCat API 深度集成 (2026-02-12)

基于 NapCat 完整 API 能力进行全面优化，新增多项交互功能并提升性能。

#### 新增功能

| 功能 | 说明 |
| :--- | :--- |
| **表情回应** | 收到触发消息时自动添加表情回应（`set_msg_emoji_like`），通过 `reactionEmoji` 配置 |
| **已读标记** | 自动标记群聊/私聊消息为已读（`mark_group_msg_as_read` / `mark_private_msg_as_read`），通过 `autoMarkRead` 配置 |
| **AI 语音** | 利用 NapCat 原生 `send_group_ai_record` API 发送 AI 语音，音色更丰富，通过 `aiVoiceId` 配置 |
| **私聊戳一戳** | 新增 `friend_poke` 支持，私聊中收到戳一戳也会回应 |
| **批量成员缓存** | 使用 `get_group_member_list` 一次获取全部群成员，替代逐个查询，大幅减少 API 调用 |
| **文件上传 API** | 非图片文件优先使用 `upload_group_file` / `upload_private_file` 上传，更可靠 |

#### 优化改进

- `OneBotEvent` 类型补全：新增 `guild_id`、`channel_id`、`target_id`、`notice_type`、`request_type`、`flag` 等字段
- `OneBotMessageSegment` 类型补全：新增 `record`、`video`、`json`、`forward`、`file`、`face` 等消息段
- `getGroupMsgHistory` 新增 `count` 参数，按需获取历史消息条数，减少数据传输
- 好友/入群请求处理从死代码修复为正确的事件分发

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/types.ts` | 增强 | 补全 OneBotEvent 和 OneBotMessageSegment 类型定义 |
| `src/config.ts` | 新增字段 | 新增 `reactionEmoji`、`autoMarkRead`、`aiVoiceId` 配置项 |
| `src/client.ts` | 新增方法 | 新增 7 个 NapCat API 方法，优化 `getGroupMsgHistory` 参数 |
| `src/channel.ts` | 集成 | 表情回应、已读标记、AI 语音、批量成员缓存、文件上传、私聊戳一戳 |
| `README.md` | 文档 | 同步文档更新 |
| `package.json` | 版本 | 更新为 1.3.0 |

#### 新增配置项

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `reactionEmoji` | string | - | 表情回应 ID（如 `"128077"`），留空不启用 |
| `autoMarkRead` | boolean | `false` | 自动标记消息为已读 |
| `aiVoiceId` | string | - | NapCat AI 语音角色 ID，配合 `enableTTS` 使用 |

#### 推荐环境

- NapCat 4.16.0+

### v1.2.0 - Outbound 目标解析优化

修复了定时任务 (cron) 发送群聊/频道消息时，因目标类型解析不正确导致调用 `sendPrivateMsg` 并报错"请指定正确的 group_id 或 user_id"的问题。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/channel.ts` | 重构 | 新增 `parseTarget()` 和 `dispatchMessage()` 函数，统一 outbound 目标解析和消息分发逻辑 |
| `README.md` | 新增章节 | 新增"定时任务 (Cron) `to` 字段格式"文档，明确各目标类型的格式要求 |

#### 变更详情

**1. 新增 `parseTarget()` 统一解析函数**

将分散在 `outbound.sendText` 和 `outbound.sendMedia` 中的 `to.startsWith("group:")` / `to.startsWith("guild:")` 判断逻辑提取为独立函数，支持以下格式：

| `to` 值 | 解析结果 |
| :--- | :--- |
| `"12345678"` | 私聊，`userId = 12345678` |
| `"private:12345678"` | 私聊，`userId = 12345678` |
| `"group:88888888"` | 群聊，`groupId = 88888888` |
| `"guild:G1:C1"` | 频道，`guildId = G1, channelId = C1` |

当 `to` 值无法解析时，会抛出明确的错误信息（包含格式提示），而不是静默传入 `NaN` 导致 OneBot 返回难以理解的错误。

**2. 新增 `dispatchMessage()` 统一分发函数**

根据 `parseTarget()` 的结果，调用对应的 `sendPrivateMsg` / `sendGroupMsg` / `sendGuildChannelMsg`，消除了 `sendText` 和 `sendMedia` 中的重复分发逻辑。

**3. 新增 `private:` 前缀支持**

为保持一致性，新增了 `private:QQ号` 格式的支持。纯数字仍然默认视为私聊。

### v1.1.0 - HTTP API + 反向 WebSocket + Outbound 修复

本次更新解决了 **OpenClaw 定时任务/主动推送消息无法送达** 的问题，并新增了两种通信方式。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/config.ts` | 新增字段 | 新增 `httpUrl`、`reverseWsPort` 两个可选配置项 |
| `src/client.ts` | 重构 | 新增 HTTP API 发送、反向 WS Server、修复消息发送静默失败 |
| `src/channel.ts` | 修改 | 适配新配置项，outbound 发送改为 await 并正确返回错误 |

#### 新增功能

**1. HTTP API 发送 (`httpUrl`)**

通过 NapCat 的 HTTP 接口（默认端口 3000）发送消息。定时任务等 outbound 场景不再依赖 WebSocket 连接状态。

- `src/config.ts`: 新增 `httpUrl` 字段（`z.string().url().optional()`）
- `src/client.ts`: 新增 `sendViaHttp()` 方法，通过 `fetch` POST 调用 OneBot HTTP API
- `src/client.ts`: 新增 `sendAction()` 方法，发送消息时优先走 HTTP，HTTP 失败自动降级到 WebSocket
- `src/client.ts`: `sendWithResponse()`（查询类 API 如 `get_login_info`）同样优先走 HTTP

**2. 反向 WebSocket Server (`reverseWsPort`)**

插件启动一个 WebSocket Server，由 NapCat 主动连接过来，确保事件接收更可靠。

- `src/config.ts`: 新增 `reverseWsPort` 字段（`z.number().optional()`）
- `src/client.ts`: 新增 `startReverseWs()` / `stopReverseWs()` 方法
- `src/client.ts`: 新增 `getActiveWs()` 方法，自动选择可用连接（正向 WS 优先，反向 WS 备选）
- `src/client.ts`: 反向 WS 支持 `accessToken` 鉴权
- `src/channel.ts`: `startAccount` 中调用 `client.startReverseWs()`，`disconnect` 时自动清理

#### Bug 修复

**3. 修复 outbound 消息发送静默失败**

旧代码中定时任务调用 `outbound.sendText` 发送消息时，即使实际发送失败也会返回 `{ sent: true }`，导致 OpenClaw 认为消息已送达。

根本原因：
- `sendGroupMsg` / `sendPrivateMsg` 不是 async 方法，内部用 fire-and-forget 的 `.catch()` 处理错误，调用方无法感知失败
- `outbound.sendText` 没有 `await` 发送结果，也没有 `try/catch`，始终返回 `{ sent: true }`
- WS 断开时 `send()` 只 `console.warn` 不抛错，消息静默丢失

修复内容：
- `src/client.ts`: `sendGroupMsg` / `sendPrivateMsg` 改为 `async`，内部 `await sendAction()`
- `src/client.ts`: `sendAction()` 改为 `async`，HTTP 失败后同步降级到 WS，不再用 `.catch()` 丢弃错误
- `src/client.ts`: `send()` 重命名为 `sendWs()`，WS 不可用时 `throw Error` 而非静默 warn
- `src/channel.ts`: `outbound.sendText` / `outbound.sendMedia` 增加 `try/catch`，`await` 每个发送调用，失败时返回 `{ sent: false, error: "..." }`

#### 消息发送优先级（修复后）

```
OpenClaw 定时任务 → outbound.sendText()
  → client.sendGroupMsg() [async]
    → sendAction() [async]
      → 1. 尝试 HTTP API (httpUrl, 如 http://localhost:3000)
      → 2. HTTP 失败? 降级到 WebSocket (正向WS > 反向WS)
      → 3. 全部失败? 抛出 Error → outbound 返回 { sent: false }
```

#### 新增配置项

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `httpUrl` | string | - | NapCat HTTP API 地址（如 `http://localhost:3000`），用于主动发送消息 |
| `reverseWsPort` | number | - | 反向 WebSocket 监听端口（如 `3002`），NapCat 主动连接到此端口 |

#### 配置示例

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "httpUrl": "http://127.0.0.1:3000",
      "reverseWsPort": 3002,
      "accessToken": "123456",
      "admins": [12345678]
    }
  }
}
```

#### NapCat 侧配置

1. **HTTP 服务**: 确保 NapCat 的 HTTP 服务已开启（默认端口 3000）
2. **反向 WebSocket**: 在 NapCat 网络配置中添加反向 WS 地址 `ws://你的服务器IP:3002`，类型选择"反向 WebSocket"

### v1.1.1 - Outbound 调试日志

为排查定时任务消息发送不到的问题，在 outbound 全链路增加了详细的调试日志。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/channel.ts` | 增加日志 | `outbound.sendText` 入口处打印调用参数、client 查找结果、发送进度 |
| `src/client.ts` | 增加日志 | `sendAction` 中打印 HTTP 请求地址、WS 连接状态、成功/失败结果 |

#### 新增日志标签

| 日志前缀 | 含义 |
| :--- | :--- |
| `[QQ][outbound.sendText] called` | outbound 被 openclaw 调用，打印 `to`、`accountId`、`text` 前 100 字符 |
| `[QQ][outbound.sendText] client lookup` | 打印 client 是否找到，以及 `clients` Map 中所有已注册的 accountId |
| `[QQ][outbound.sendText] sending chunk` | 每个消息分片发送前打印 |
| `[QQ][outbound.sendText] success` | 全部发送成功 |
| `[QQ][outbound.sendText] FAILED` | 发送失败，打印错误详情 |
| `[QQ][sendAction] trying HTTP` | 正在尝试 HTTP API 发送 |
| `[QQ][sendAction] HTTP success` | HTTP 发送成功 |
| `[QQ][sendAction] HTTP failed` | HTTP 失败，即将降级到 WS |
| `[QQ][sendAction] trying WS` | 打印正向/反向 WS 的 readyState 和是否有可用连接 |

#### 排查指南

定时任务触发后查看 openclaw 控制台日志：

- **完全没有 `[QQ][outbound.sendText]` 日志** → openclaw 没调用插件的 outbound，检查 cron job 的 `delivery.channel` 是否为 `"qq"`
- **日志显示 `found=false`** → client 没注册成功，检查 accountId 是否匹配
- **日志显示 `HTTP failed` + `WS active=false`** → HTTP 和 WS 都不通，检查 NapCat 是否在线、端口是否正确
