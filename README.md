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

### 友军识别（Bot-to-Bot Recognition，v1.9+ 协议层握手）

多个 bot 在同一群会产生循环对话？开启 `ignoreSenderBot`（默认 true），bot 消息会被自动过滤：

**五层检测机制（v1.9+ 新增 Layer 4 协议层握手）：**

1. **手动白名单**（`knownBotIds`）：最高优先级，适用于不支持签名的 bot
2. **sender.bot 字段**：OneBot v11 标准字段，部分 bot 框架会设置
3. **自维护缓存**：通过签名 / 握手自动发现并缓存（持久化到 `~/.openclaw/napcat-qq/data/known-bots-<accountId>.json`），后续无需任何标记也能识别
4. **签名检测**（in-band，仅 visible / zero-width 模式启用）：见下表
5. **协议层握手**（Plan A，v1.9+ 默认）：bot 启动时向每个群发一条 `{app:"openclaw-napcat", kind:"bot", selfId, ...}` 的 OneBot `json` 段；接收方解析后入 cache，**用户文本 100% 干净**

**冷启动历史回填**：bot 启动时拉取每个群最近 30 条历史,扫描握手 / 文本签名,自动回填 `known-bots-store`。解决"对方 bot 之前发过握手,本 bot 启动后才入群"的不对称时序问题。

**友军抑制**：检测到其他 bot 活跃后，本 bot 会静默 `botSuppressionMs` 毫秒（默认 120 秒）

```json
{
  "ignoreSenderBot": true,
  "botSuppressionMs": 120000,
  "knownBotIds": [123456789, 987654321],
  "botSignatureStyle": "metadata"
}
```

```yaml
# Docker 环境变量
QQ_IGNORE_SENDER_BOT: "true"
QQ_BOT_SUPPRESSION_MS: "120000"
QQ_KNOWN_BOT_IDS: "123456789,987654321"  # 手动 bot 白名单
QQ_BOT_SIGNATURE_STYLE: metadata          # 默认：协议层握手，用户文本干净
```

**签名样式对比（v1.9+）：**

| 样式 | 格式 | 用户文本 | 适用场景 |
|------|------|----------|----------|
| `metadata`（默认） | OneBot `json` 段握手 | ✅ 100% 干净 | v1.9+ openclaw-napcat 之间首选 |
| `visible` | `[BOT:12345678]` 拼到消息末尾 | ❌ 用户可见 | 兼容老 bot / 跨框架 bot |
| `zero-width` | 零宽字符 U+200B/U+200C | ✅ 用户不可见 | 长期运行后可能失效 |
| `none` | 无任何文本标记 | ✅ 干净 | 仅靠 sender.bot / knownBotIds / cache |

私聊不追加签名也不发握手。账号断开重连时握手节流 24h 内不重发(避免重启风暴);持久化 cache 跨重启保留。

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

### 群组白名单

Bot 只在指定群聊中响应，其他群自动忽略：

```yaml
QQ_ALLOWED_GROUPS: "123456789,987654321"   # 逗号分隔的群号，留空=所有群
```

```json
{ "allowedGroups": [123456789, 987654321] }
```

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
      QQ_ACCESS_TOKEN: <你的napcat-token>
      # ── 权限 ────────────────────────────────────────────
      QQ_ADMINS: "123456789"           # 管理员 QQ 号，多个用逗号分隔
      QQ_REQUIRE_MENTION: "true"       # 群聊是否需要 @ 触发
      QQ_ALLOWED_GROUPS: ""            # 群组白名单，逗号分隔，留空=所有群
      QQ_BLOCKED_USERS: ""             # 用户黑名单，逗号分隔
      # ── 友军识别 ─────────────────────────────────────────
      QQ_IGNORE_SENDER_BOT: "true"     # 过滤 sender.bot=true 的消息
      QQ_BOT_SUPPRESSION_MS: "120000"  # 友军抑制时长（ms），0=禁用
      QQ_KNOWN_BOT_IDS: ""             # 手动 bot 白名单，逗号分隔的 QQ 号
      QQ_BOT_SIGNATURE_STYLE: visible  # 签名样式：visible | zero-width
      # ── 行为 ────────────────────────────────────────────
      QQ_SYSTEM_PROMPT: ""             # 自定义系统提示词
      QQ_HISTORY_LIMIT: "5"            # 携带历史消息条数
      QQ_MARKDOWN_MODE: passthrough    # Markdown 处理：passthrough | strip | native
      QQ_RATE_LIMIT_MS: "1000"         # 发送限速（ms）
      QQ_INBOUND_RATE_LIMIT_MS: "0"   # 入站频控（ms），0=禁用
      QQ_KEYWORD_TRIGGERS: ""          # 无需 @ 的触发关键词，逗号分隔
      QQ_SILENT_KEYWORDS: ""           # 静默关键词，命中即丢弃
      # ── 旁观模式 ─────────────────────────────────────────
      QQ_PASSIVE_MODE_ENABLED: "false" # 是否启用旁观模式
      QQ_PASSIVE_MODE_COOLDOWN_MS: "10000"      # 实质回复冷却（ms）
      QQ_PASSIVE_MODE_MIN_INTERVAL_MS: "30000"  # 最小触发间隔（ms）
    restart: unless-stopped
```

</details>

**配置说明：**

| 环境变量 | 必填 | 说明 |
|----------|------|------|
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | OpenClaw 网关 Token，用于 WebUI 鉴权 |
| `QQ_HTTP_URL` | ✅ | NapCat HTTP API 地址 |
| `QQ_REVERSE_WS_PORT` | ✅ | 反向 WS 监听端口 |
| `QQ_ACCESS_TOKEN` | ✅ | NapCat 鉴权 Token（需与 NapCat 侧一致） |
| `QQ_ADMINS` | ✅ | 管理员 QQ 号 |
| `QQ_ALLOWED_GROUPS` | ❌ | 群组白名单，留空=所有群 |
| `QQ_IGNORE_SENDER_BOT` | ❌ | 过滤其他 bot 消息，默认 `true` |
| `QQ_KNOWN_BOT_IDS` | ❌ | 手动 bot 白名单（QQ 号），适用于不支持签名的 bot |
| `QQ_BOT_SIGNATURE_STYLE` | ❌ | 签名样式：`visible`（默认）或 `zero-width` |
| `QQ_PASSIVE_MODE_ENABLED` | ❌ | 旁观模式，默认 `false` |

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
| `knownBotIds` | number[] | `[]` | 手动 bot 白名单，适用于不支持签名的 bot |
| `botSignatureStyle` | string | `"metadata"` | 签名样式：`metadata`(默认,协议层握手) / `visible` / `zero-width` / `none` |
| `debug` | boolean | `false` | 开启消息处理流水线的详细诊断日志（@mention / bot 过滤 / 表情），排查问题时临时开启 |
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

- [BUILD.md](docs/BUILD.md) — 本地构建与开发指南
- [CONFIG.md](docs/CONFIG.md) — 完整配置项
- [COMMANDS.md](docs/COMMANDS.md) — 管理员指令
- [DOCKER.md](docs/DOCKER.md) — Docker 部署指南
- [MODULES.md](docs/MODULES.md) — 模块职责
- [CHANGELOG.md](docs/CHANGELOG.md) — 更新日志

---

## License

[MIT](docs/LICENSE)
