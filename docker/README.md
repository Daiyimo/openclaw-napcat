# openclaw-napcat Docker 使用指南

本目录提供 Docker 部署所需的全部文件：

| 文件 | 说明 |
|------|------|
| `Dockerfile` | 基于官方 openclaw 镜像构建，内置 QQ 插件 |
| `entrypoint.sh` | 容器启动脚本（环境变量 → 配置 + 启动 openclaw） |
| `setup-config.js` | 将 `QQ_*` 环境变量写入 openclaw 配置的 Node.js 脚本 |

## 快速开始

```bash
# 1. 复制配置文件
cp config/docker-compose.yml.example docker-compose.yml
cp config/.env.example .env

# 2. 修改 .env 填写 NapCat 地址等基本配置
#    关键项：QQ_HTTP_URL / QQ_WS_URL / QQ_ADMINS

# 3. 构建镜像 + 启动
docker compose up -d --build

# 4. 查看启动日志
docker compose logs -f openclaw
```

## 通过向导配置 QQ 频道

如果不使用环境变量，可在容器内运行 openclaw 的交互式配置向导：

```bash
docker exec -it openclaw openclaw gateway setup
```

选择 **QQ (OneBot)** 频道，按提示填写 NapCat 地址和参数即可。

## 验证插件已加载

```bash
docker exec openclaw openclaw --version
# 输出：OpenClaw x.x.x

docker exec openclaw openclaw status
# 应看到 qq 频道状态
```
