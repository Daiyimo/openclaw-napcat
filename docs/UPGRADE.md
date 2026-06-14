# 远程一键升级指南

## 适用场景

- 你的服务器上有 Docker 部署的 OpenClaw NapCat 实例
- 你想从**任意其他设备**（笔记本、手机、朋友的服务器）执行升级
- 只需一条命令，无需手动 docker exec / docker cp / 重启

---

## 一行命令升级

```bash
curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/remote-upgrade.sh | bash
```

### 国内加速（raw.githubusercontent.com 被墙时）

```bash
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/remote-upgrade.sh | bash
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CONTAINER_NAME` | 自动检测第一个含 openclaw 的容器 | 容器名 |
| `DATA_DIR` | 自动检测（docker inspect → 常见路径） | 宿主机数据卷路径 |
| `BRANCH` | `main` | 代码分支 |
| `MIRROR` | 自动尝试 6 个镜像 | 强制指定单一镜像 URL |

### 示例：自定义环境

```bash
CONTAINER_NAME=my-bot DATA_DIR=/home/user/openclaw-data bash <(curl -fsSL ...)
```

---

## 升级流程

```
 下载源码 tarball（6 镜像兜底）
       ↓
 备份当前 dist/
       ↓
 docker cp → 容器内解压
       ↓
 npm install → npm run build → npm prune
       ↓
 docker cp ← 导出编译结果
       ↓
 部署到 DATA_DIR/extensions/napcat/
       ↓
 docker restart
       ↓
 ✅ 完成 / ❌ 自动回滚
```

---

## 离线环境

如果服务器无法访问 GitHub：

1. 在有网络的机器上下载 tarball：
   ```bash
   curl -fsSL https://github.com/Daiyimo/openclaw-napcat/archive/refs/heads/main.tar.gz -o /tmp/oc.tar.gz
   ```
2. 传到目标服务器（scp / U 盘 / 任意方式）
3. 在目标服务器上执行：
   ```bash
   OPENCLAW_NAPCAT_LOCAL_TARBALL=/tmp/oc.tar.gz bash remote-upgrade.sh
   ```

---

## 首次部署 vs 升级

| 操作 | 命令 | 说明 |
|------|------|------|
| **首次部署** | `docker-install.sh` | 全量安装，写入配置 |
| **后续升级** | `remote-upgrade.sh` | 仅更新代码，保留配置 |
| **完整重装** | `docker-install.sh` | 覆盖安装 |

> **提示：** `docker-install.sh`（首次安装）也可以用于升级，但会重新写入 NapCat 配置。`remote-upgrade.sh` 更轻量，保留用户配置。
