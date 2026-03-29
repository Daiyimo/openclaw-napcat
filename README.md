
OpenClaw 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
# OpenClaw QQ 插件 (OneBot v11)

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加全功能的 QQ 频道支持。它不仅支持基础聊天，还集成了群管、频道、多模态交互和生产级风控能力。

## 🏗️ 架构概览

```
┌──────────────────────────────────────────────────────┐
│                    OpenClaw 主框架                     │
│  (提供 Plugin SDK、Runtime、Session、Reply 调度等)       │
└────────────┬─────────────────────────────────────────┘
             │ register channel plugin
             ▼
┌──────────────────────────────────────────────────────┐
│               index.ts (插件入口)                      │
│  - 注册 qqChannel 到 OpenClaw                          │
│  - 导出 proactive / known-users API                   │
└────────────┬─────────────────────────────────────────┘
             │
     ┌───────┴──────────────────────────┐
     ▼                                  ▼
┌─────────────┐              ┌──────────────────┐
│  channel.ts │              │    client.ts     │
│ (核心业务层)  │─────调用──────▶│ (通信协议层)       │
│             │              │ OneBotClient     │
└──────┬──────┘              └────────┬─────────┘
       │                             │
       │                     ┌───────┴──────────┐
       │                     │                  │
       │              正向WebSocket         反向WebSocket
       │              + HTTP API           Server
       │                     │                  │
       │                     └────────┬─────────┘
       │                              ▼
       │                     ┌────────────────┐
       │                     │  NapCat / QQ   │
       │                     │ (OneBot v11)   │
       │                     └────────────────┘
       │
  ┌────┴────────────────────────────────────────┐
  │          辅助模块                              │
  ├─ config.ts          配置 Schema (Zod)        │
  ├─ types.ts           OneBot 类型定义            │
  ├─ runtime.ts         运行时引用管理              │
  ├─ proactive.ts       主动消息发送               │
  ├─ known-users.ts     已知用户存储               │
  ├─ member-cache.ts    群成员名称缓存              │
  ├─ message-parser.ts  消息解析纯函数集合           │
  ├─ admin-commands.ts  管理员命令处理              │
  ├─ log-buffer.ts      环形日志缓冲区              │
  ├─ deliver-debounce.ts 出站消息合并防抖            │
  ├─ update-checker.ts  npm 版本检查               │
  ├─ typing-keepalive.ts Typing 状态维持           │
  ├─ upload-cache.ts    文件上传去重缓存             │
  ├─ ref-index-store.ts 引用消息持久索引(JSONL)      │
  └─ utils/                                     │
     ├─ audio-convert.ts  Silk→WAV 转换           │
     ├─ pkg-version.ts    读取插件版本号             │
     └─ platform.ts       平台路径工具              │
  └─────────────────────────────────────────────┘
```

### 核心模块职责

| 文件 | 职责 | 关键功能 |
|------|------|---------|
| `index.ts` | 插件入口 | 向 OpenClaw 注册插件 & 频道，导出公共 API |
| `channel.ts` | 核心业务层（~900行） | 消息收发、管理命令、表情回应、历史上下文、STT、多媒体处理、Markdown 处理等 |
| `client.ts` | 通信协议层 | 封装 OneBot v11 的 WebSocket（正向+反向）和 HTTP API，心跳检测，消息路由 |
| `config.ts` | 配置定义 | 用 Zod 定义 35+ 配置项的 Schema 和类型，含范围校验 |
| `types.ts` | 类型定义 | OneBot 消息段（24种类型）和事件类型 |
| `runtime.ts` | 运行时桥接 | 在插件和 OpenClaw Runtime 之间传递引用 |
| `proactive.ts` | 主动消息模块 | 支持单发、批量发送、广播已知用户 |
| `known-users.ts` | 用户管理 | 记录交互用户、JSON 持久化、节流写入、查询统计 |
| `member-cache.ts` | 群成员缓存 | 群昵称懒加载缓存，防止并发重复拉取 |
| `message-parser.ts` | 消息解析 | CQ码清理、图片提取、目标解析、Markdown 处理等纯函数 |
| `admin-commands.ts` | 管理命令 | `/ping` `/version` `/logs` `/status` `/help` `/mute` `/kick` |
| `log-buffer.ts` | 日志缓冲 | 环形缓冲区拦截 console 输出，支持 `/logs` 命令导出 |
| `deliver-debounce.ts` | 消息防抖 | 将 AI 连续输出合并为一条消息发送 |
| `update-checker.ts` | 版本检查 | 启动时查询 npm 最新版本，支持 `/version` 展示 |
| `typing-keepalive.ts` | Typing 状态 | 私聊 AI 处理期间维持输入中状态 |
| `upload-cache.ts` | 上传缓存 | 相同文件 30 分钟内跳过重复上传 |
| `ref-index-store.ts` | 引用索引 | JSONL 持久化引用消息索引，TTL 7 天自动清理 |

### 通信架构（双通道冗余）

`OneBotClient` 支持 **三种通信方式并行**：

1. **正向 WebSocket**（`wsUrl`）：插件主动连接 NapCat
2. **反向 WebSocket**（`reverseWsPort`）：插件监听端口，NapCat 主动连接
3. **HTTP API**（`httpUrl`）：用于发送消息的 HTTP 接口

发送消息时优先使用 HTTP API，失败则回退到 WebSocket；接收消息通过 WebSocket 事件驱动。

### 消息处理流程

```
NapCat 事件 → OneBotClient.emit("message")
  → channel.ts message handler
    → 1. 元事件/请求事件 处理（加好友、进群自动审批）
    → 2. 戳一戳(poke) 处理 → 转化为文本消息
    → 3. 自身消息过滤 + 去重
    → 4. 消息段解析（文本/AT/@/图片/语音/视频/文件/转发）
    → 5. 黑白名单检查
    → 6. 管理员命令处理（/ping, /version, /logs, /status, /help, /mute, /kick）
    → 7. 触发条件检查（@提及/关键词/回复）
    → 8. 表情回应 (智能匹配 emoji)
    → 9. 构建上下文（历史消息 + system prompt + 回复引用）
    → 10. 启动 Typing 状态维持
    → 11. 分发给 OpenClaw Runtime 进行 AI 推理（消息防抖合并）
    → 12. 通过 deliver 函数回复（支持分片、TTS、文件、Markdown 模式）
```

---

## ✨ 核心特性

### 🧠 深度智能与上下文
*   **历史回溯 (Context)**：在群聊中自动获取最近 N 条历史消息（默认 5 条），让 AI 能理解对话前文，不再“健忘”。
*   **系统提示词 (System Prompt)**：支持注入自定义提示词，让 Bot 扮演特定角色（如“猫娘”、“严厉的管理员”）。
*   **转发消息理解**：AI 能够解析并读取用户发送的合并转发聊天记录，处理复杂信息。
*   **关键词唤醒**：除了 @机器人，支持配置特定的关键词（如”小助手”）来触发对话，无需同时 @机器人。

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

**推荐：安装 + 配置 + 启动一步完成**

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/setup.sh | sudo bash
```

或分步执行：

```bash
# 步骤 1：安装插件（克隆 + 编译）
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/install.sh | sudo bash

# 步骤 2：配置并启动
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/update_json.sh | sudo bash

# 一行命令添加 StepFun 模型并设为主模型 (Linux/macOS)
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/add_stepfun.sh | sudo bash

# Windows 用户请使用 PowerShell 脚本（自动请求管理员权限）
irm "https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/install_stepfun.ps1" -UseBasicParsing | iex
```

### 方法 : 使用 OpenClaw CLI (推荐)
如果你的 OpenClaw 版本支持插件市场或 CLI 安装：
```bash
# 进入插件目录
cd /usr/lib/node_modules/openclaw/dist/extensions
# 克隆仓库
git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq
# 进入qq插件目录
cd qq
npm install -g pnpm
# 安装依赖
pnpm install
```

---

## ⚙️ 配置说明

### 1. 快速配置 (update_json.sh)
插件内置了交互式配置脚本，在插件目录下运行：

```bash
bash scripts/update_json.sh
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
| `systemPrompt` | string | - | **人设设定**。注入到 AI 上下文的系统提示词。 |
| `enableDeduplication` | boolean | `true` | 消息去重，防止同一条消息被处理两次。 |
| `enableErrorNotify` | boolean | `true` | 出错时通知管理员或当前用户。 |
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友申请和群邀请。 |
| `maxMessageLength` | number | `4000` | 单条消息最大长度（100–10000），超过将自动分片发送。 |
| `formatMarkdown` | boolean | `false` | 是否将 Markdown 表格/列表转换为易读的纯文本排版。 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如给 URL 加空格）。 |
| `allowedGroups` | number[] | `[]` | **群组白名单**。若设置，Bot 仅在这些群组响应；若为空，则响应所有群组。 |
| `blockedUsers` | number[] | `[]` | **用户黑名单**。Bot 将忽略这些用户的消息。 |
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
    *   发送包含配置**关键词**（如”小助手”）的消息。
    *   **戳一戳**机器人头像。

### 👮‍♂️ 管理员指令
仅配置在 `admins` 列表中的用户可用。**群聊中需 @机器人**才能触发，私聊中直接发送即可：

*   `/status`
    *   查看机器人运行状态（版本、内存占用、运行时长、Self ID）。
*   `/ping`
    *   测量从发送到机器人收到消息的延迟。
*   `/version`
    *   显示插件版本、Node.js 版本及是否有 npm 更新。
*   `/logs [N]`
    *   导出最近 N 条日志（默认 20，最多 100）。
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

完整更新日志见 [CHANGELOG.md](CHANGELOG.md)。

---

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Daiyimo/openclaw-napcat&type=Date)](https://star-history.com/#Daiyimo/openclaw-napcat&Date)

---

## 📄 许可证

[MIT](LICENSE) © Daiyimo
