# OpenClaw QQ 插件（适配 openclaw-docker）

通过 OneBot v11 协议（NapCat）将 QQ 接入 [OpenClaw](https://github.com/openclaw/openclaw) AI 框架。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenClaw 容器/进程                         │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  @openclaw/qq 插件                                         │  │
│  │                                                           │  │
│  │  gateway/            outbound/          admin-commands     │  │
│  │  ┌────────────┐     ┌─────────────┐    ┌─────────────┐   │  │
│  │  │ connection │     │  send-text   │    │ /ping /logs │   │  │
│  │  │ inbound    │     │  send-media  │    │ /groups ... │   │  │
│  │  │ lifecycle  │     └─────────────┘    └─────────────┘   │  │
│  │  └────────────┘                                           │  │
│  │       ↑ 消息事件          ↓ 发送指令                        │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │         OneBotClient (client.ts)                     │  │  │
│  │  │   正向WS ←→ 反向WS Server ←→ HTTP API (带重试)       │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          ↕                                       │
└──────────────────────────┼──────────────────────────────────────┘
                           │ OneBot v11 协议
┌──────────────────────────┼──────────────────────────────────────┐
│  NapCat 容器/进程         │                                      │
│  HTTP :3000  ←───────────┘ (发送消息)                            │
│  WS Client   ────────────→ :3002 (反向WS，接收事件)              │
└─────────────────────────────────────────────────────────────────┘
```

**消息处理流水线：**

```
入站消息 → 去重 → 黑白名单 → 静默关键词 → 频控
  → 管理命令拦截 → 触发检测(@/关键词/旁观) → AI 派发
    → 回复防抖合并 → 分片/TTS/Markdown → 发送
```

---

## 功能

- **多通道连接**：正向 WebSocket / 反向 WebSocket / HTTP API 三通道互备
- **灵活触发**：@机器人、关键词、戳一戳、旁观模式（AI 自主决定是否发言）
- **消息防抖**：AI 连续输出自动合并为一条消息，避免轰炸
- **跨会话投递**：`[TO:group:群号]` 前缀或 `/sendto` 命令发送到任意目标
- **配置热重载**：`/reload` 即时生效，无需重启
- **群路由按需刷新**：`/groups` 命令手动注册群路由，解决 cron 投递问题
- **HTTP 重试**：指数退避自动重试，5xx/网络错误不丢消息
- **智能表情**：15 种关键词场景自动贴表情
- **管理命令**：`/ping` `/status` `/version` `/logs` `/reload` `/groups` `/sendto` `/mute` `/kick`
- **安全管控**：Token 鉴权、群组白名单、用户黑名单、入站频控、静默关键词
- **Docker 部署**：`curl | bash` 一键安装

---

## 特色功能

### `/groups` — 群路由按需刷新

机器人加入了新群但 cron 投递报错"找不到会话"？发 `/groups` 即可：

```
/groups
→ ✅ 已刷新 5 个群路由，cron 投递现在可用
```

原理：调用 `getGroupList()` 拉取所有已加入群，为每个群注册 session 路由。无需重启容器。

### 友军识别（Bot-to-Bot Recognition）

多个 bot 在同一群会产生循环对话？开启 `ignoreSenderBot`（默认 true），bot 消息会被自动过滤：

- 检测 `sender.bot=true`（OneBot v11 标准字段）
- 检测发出的消息末尾的不可见零宽字符签名
- 检测到其他 bot 活跃后，本 bot 会静默 `botSuppressionMs` 毫秒（默认 120 秒）

```json
{ "ignoreSenderBot": true, "botSuppressionMs": 120000 }
```

签名使用零宽字符（`​‌‍`），用户不可见，仅在群消息中追加（私聊不追加，避免冗余）。

### 旁观模式（Passive Mode）

AI 监听群聊所有消息，自主判断是否参与对话，无需 @：

```json
{
  "passiveMode": {
    "enabled": true,
    "cooldownMs": 10000,
    "minIntervalMs": 30000,
    "botSuppressionMs": 120000
  }
}
```

- `cooldownMs`：实质回复后的冷却时间（默认 10 秒）
- `minIntervalMs`：最小触发间隔，含 [SILENT] 响应（默认 30 秒），防止 AI 被频繁调用
- `botSuppressionMs`：友军识别抑制时长（默认 120 秒），检测到其他 bot 回复后静默

### 静默关键词过滤

群里有其他 bot 指令（如 `ww签到`）会误触发？配置 `silentKeywords` 直接屏蔽：

```yaml
QQ_SILENT_KEYWORDS: "ww,签到,打卡"   # 包含任一关键词的消息直接丢弃
```

### 消息防抖合并

AI 连续输出多条碎片消息时，自动等待并合并为一条发送：

```json
{ "deliverDebounce": { "enabled": true, "windowMs": 1500, "maxWaitMs": 8000 } }
```

### 跨会话投递

AI 回复中使用 `[TO:group:群号]内容` 可发送到任意群/用户，绕过 session 限制。管理员也可用 `/sendto group:群号 内容` 手动发送。

---

## Docker 部署

<details>
<summary><b>docker-compose.yml 完整示例（点击展开）</b></summary>

```yaml
services:
  # ── NapCat：QQ 协议端 ──────────────────────────────────────
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    volumes:
      - ./napcat-data:/app/napcat/config
    ports:
      - "6099:6099"       # WebUI（首次扫码登录）
      - "3000:3000"       # HTTP API
    restart: unless-stopped

  # ── OpenClaw + QQ 插件 ─────────────────────────────────────
  openclaw:
    image: ghcr.io/openclaw/openclaw:latest
    container_name: openclaw
    user: "0:0"
    depends_on:
      - napcat
    ports:
      - "18789:18789"     # OpenClaw WebUI
      - "3002:3002"       # 反向 WS（NapCat 连入）
    volumes:
      - ./openclaw-data:/home/node/.openclaw
    environment:
      HOME: /home/node
      TZ: Asia/Shanghai
      OPENCLAW_GATEWAY_BIND: lan
      OPENCLAW_GATEWAY_TOKEN: <你的gateway-token>
      OPENCLAW_EXTRA_EXTENSIONS_DIR: /home/node/.openclaw/extensions
      # ── NapCat 连接 ─────────────────────────────────────
      QQ_HTTP_URL: http://napcat:3000
      QQ_REVERSE_WS_PORT: "3002"
      QQ_ACCESS_TOKEN: <你的token>
      # ── 权限 ────────────────────────────────────────────
      QQ_ADMINS: "123456789"
      QQ_REQUIRE_MENTION: "true"
      QQ_ALLOWED_GROUPS: ""           # 留空=所有群
      QQ_BLOCKED_USERS: ""
      # ── 行为 ────────────────────────────────────────────
      QQ_SYSTEM_PROMPT: ""
      QQ_HISTORY_LIMIT: "5"
      QQ_MARKDOWN_MODE: passthrough
      QQ_RATE_LIMIT_MS: "1000"
      QQ_KEYWORD_TRIGGERS: ""
      QQ_SILENT_KEYWORDS: ""          # 静默关键词，逗号分隔
      QQ_IGNORE_SENDER_BOT: "true"    # 过滤其他 bot 消息
      QQ_BOT_SUPPRESSION_MS: "120000" # 友军抑制时长（ms），0=禁用
      QQ_INBOUND_RATE_LIMIT_MS: "0"
    restart: unless-stopped
```

</details>

**NapCat 侧配置**（`onebot11_<QQ号>.json`）：

```json
{
  "network": {
    "httpServers": [{
      "enable": true, "port": 3000, "host": "0.0.0.0",
      "messagePostFormat": "array", "token": "<同 QQ_ACCESS_TOKEN>"
    }],
    "websocketClients": [{
      "enable": true, "url": "ws://openclaw:3002",
      "messagePostFormat": "array", "token": "<同 QQ_ACCESS_TOKEN>",
      "reconnectInterval": 5000
    }]
  }
}
```

**首次部署：**

```bash
docker compose up -d
docker exec -it openclaw sh -c \
  "curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash"
docker compose restart openclaw
docker exec -it openclaw openclaw onboard   # 配置 AI 模型
docker compose restart openclaw
```

详细部署指南见 [docs/DOCKER.md](docs/DOCKER.md)。

---

## 快速配置（非 Docker）

`~/.openclaw/openclaw.json` 中添加：

```json
{
  "channels": {
    "napcat": {
      "reverseWsPort": 3002,
      "httpUrl": "http://<NapCat地址>:3000",
      "accessToken": "你的Token",
      "admins": [你的QQ号]
    }
  }
}
```

---

## 常用配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `reverseWsPort` | number | - | 反向 WS 监听端口 |
| `httpUrl` | string | - | NapCat HTTP API 地址 |
| `accessToken` | string | - | 鉴权 Token |
| `admins` | number[] | `[]` | 管理员 QQ 号 |
| `requireMention` | boolean | `true` | 群聊是否需要 @ 触发 |
| `allowedGroups` | number[] | `[]` | 群组白名单（空=全部） |
| `blockedUsers` | number[] | `[]` | 用户黑名单 |
| `ignoreSenderBot` | boolean | `true` | 过滤其他 bot 消息，防止循环对话 |
| `botSuppressionMs` | number | `120000` | 友军抑制时长（ms），0=禁用 |
| `keywordTriggers` | string[] | `[]` | 无需 @ 的触发关键词 |
| `silentKeywords` | string[] | `[]` | 静默关键词（命中即丢弃） |
| `historyLimit` | number | `5` | 携带历史消息条数 |
| `rateLimitMs` | number | `1000` | 发送限速（ms） |
| `passiveMode` | object | - | 旁观模式配置 |
| `deliverDebounce` | object | - | 消息防抖配置 |

完整配置见 [docs/CONFIG.md](docs/CONFIG.md)。

---

## 文档

- [CONFIG.md](docs/CONFIG.md) — 完整配置项
- [COMMANDS.md](docs/COMMANDS.md) — 管理员指令
- [DOCKER.md](docs/DOCKER.md) — Docker 部署指南
- [MODULES.md](docs/MODULES.md) — 模块职责
- [CHANGELOG.md](docs/CHANGELOG.md) — 更新日志

---

## License

[MIT](docs/LICENSE)
