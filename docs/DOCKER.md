# Docker 部署指南

两个独立容器（NapCat + OpenClaw 官方镜像）在同一 Docker 网络内，通过服务名互访。

## 前提

- Docker + Docker Compose 已安装（NAS 内置 Docker 套件或手动安装）
- NapCat 容器已运行并配置好 HTTP API（端口 3000）和反向 WebSocket（端口 3002）
- OpenClaw 网关 Token（自行生成一个随机字符串）

## 快速开始

### 1. 配置环境变量

在 NAS Docker UI 中粘贴 `docker-compose.yml` 内容，填写以下必填项：

| 变量 | 说明 | 示例 |
|------|------|------|
| `OPENCLAW_GATEWAY_TOKEN` | 网关访问令牌（必填） | `abc123xyz` |
| `QQ_ADMINS` | 管理员 QQ 号（逗号分隔） | `12345678` |
| `QQ_ACCESS_TOKEN` | NapCat Access Token | `123456` |

### 2. 启动容器

在 NAS Docker UI 中启动，或命令行：

```bash
docker compose up -d
```

### 3. 安装 QQ 插件（首次部署）

进入 openclaw 容器终端，执行一行命令：

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
```

脚本自动完成：从 GitHub 下载源码 → 编译 TypeScript → 安装到持久化目录 → 写入 QQ 配置

### 4. 重启容器激活插件

```bash
docker restart openclaw
# 或在 NAS Docker UI 中点击重启
```

### 5. 验证

```bash
docker logs openclaw --tail 20
# 应看到 [openclaw-napcat] channels.qq 已从环境变量写入
# 以及 openclaw 正常启动日志
```

## 更新 OpenClaw

```bash
docker compose pull           # 拉取最新官方镜像
docker compose up -d          # 重启
# 插件在数据卷中，不受镜像更新影响
# QQ 渠道配置每次重启自动从 QQ_* 环境变量恢复，无需手动操作
```

## 更新 QQ 插件

在 openclaw 容器终端重新运行安装脚本：

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
docker restart openclaw
```

## 配置 AI 模型

OpenClaw 原生支持任意 OpenAI-compatible 模型（包括 StepFun）。

启动后访问 OpenClaw Web UI（`http://<NAS-IP>:18789`）→ 模型设置 → 添加 Provider。

## 环境变量参考

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENCLAW_GATEWAY_PORT` | Web UI 端口 | `18789` |
| `OPENCLAW_GATEWAY_TOKEN` | 访问令牌（必填） | — |
| `QQ_HTTP_URL` | NapCat HTTP API 地址 | `http://napcat:3000` |
| `QQ_REVERSE_WS_PORT` | 反向 WS 端口 | `3002` |
| `QQ_ACCESS_TOKEN` | OneBot 鉴权 Token | `123456` |
| `QQ_ADMINS` | 管理员 QQ 号（逗号分隔） | — |
| `QQ_REQUIRE_MENTION` | 群聊是否需要 @ 触发 | `true` |
| `QQ_HISTORY_LIMIT` | 上下文历史消息条数 | `5` |
| `QQ_MARKDOWN_MODE` | Markdown 处理模式（strip/native/passthrough） | `passthrough` |
| `QQ_RATE_LIMIT_MS` | 出站消息限速（ms） | `1000` |
| `QQ_ANTI_RISK_MODE` | URL 防风控处理 | `false` |
| `QQ_SYSTEM_PROMPT` | 自定义系统提示词 | — |
| `QQ_ALLOWED_GROUPS` | 群组白名单（逗号分隔群号） | — |
| `QQ_BLOCKED_USERS` | 用户黑名单（逗号分隔 QQ 号） | — |

## 数据目录结构

```
/volume1/docker/openclaw/          ← 持久化数据卷
├── openclaw.json                  # OpenClaw 配置（含 channels.qq）
├── extensions/
│   └── napcat/                     # NapCat 插件（curl 安装，镜像更新不丢失）
│       ├── dist/                  # 编译产物
│       ├── node_modules/          # 生产依赖
│       ├── package.json
│       ├── openclaw.plugin.json
│       └── docker/
│           └── setup-config.cjs
├── agents/                        # 会话数据
├── workspace/                     # 工作区
└── logs/                          # 日志
```

## 故障排查

```bash
# 查看日志
docker compose logs -f openclaw

# 进入容器调试
docker exec -it openclaw sh

# 检查插件是否正确安装
ls ~/.openclaw/extensions/napcat/dist/src/index.js

# 检查 NapCat 连通性（在 openclaw 容器内）
curl -s http://napcat:3000/get_login_info

# 强制重写 NapCat 配置
docker exec -it openclaw sh -c "QQ_FORCE_RECONFIGURE=true node ~/.openclaw/extensions/napcat/docker/setup-config.cjs"
docker restart openclaw
```
