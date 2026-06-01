#!/bin/bash
# openclaw-napcat QQ 插件安装脚本
#
# 在 openclaw 容器终端内执行：
#   # 国内推荐:走 gh-proxy.com 拉脚本本身(避免 raw.githubusercontent.com 超时)
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
#
#   # 如果上面也不稳定,可指定单一镜像(跳过列表):
#   export OPENCLAW_NAPCAT_MIRROR=https://kkgithub.com/Daiyimo/openclaw-napcat/archive
#   curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
#
# 特性：
#   - 插件安装到持久化数据卷 ~/.openclaw/extensions/napcat/，容器镜像更新后不丢失
#   - 自动编译 TypeScript，无需宿主机任何工具链
#   - 读取容器内 QQ_* 环境变量写入 openclaw.json
#   - 多镜像加速下载（5 个镜像按稳定性优先级,单镜像 30s 超时）
#   - 自动静默重启容器
#   - 自动刷新群路由（重启后 connect handler 自动注册）

set -e

BRANCH="${OPENCLAW_NAPCAT_BRANCH:-main}"
EXT_DIR="${HOME:-/home/node}/.openclaw/extensions/napcat"
TEMP_DIR="/tmp/openclaw-napcat-install-$$"
# 检测运行方式：docker-compose 还是 docker run
COMPOSE_FILE=""
if [ -f "docker-compose.yml" ] || [ -f "compose.yml" ]; then
  COMPOSE_CMD="docker compose"
elif [ -n "$(docker ps --filter "name=openclaw" --format "{{.Names}}" 2>/dev/null)" ]; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD=""
fi

echo "=== OpenClaw NapCat 插件安装 ==="
echo "分支: $BRANCH"
echo "安装目录: $EXT_DIR"
echo ""

# ── 1. 下载源码（多镜像 tarball，不依赖 git）────────────────────────────────────
# 改用 tarball 下载的原因：
#  1. openclaw 容器基础镜像（node:alpine/slim）通常没装 git，`git clone` 静默失败
#  2. tarball 只含源码（~1-2 MB），比 `git clone --depth 1`（拉 git objects）快 5-10x
#  3. curl 显示 HTTP 状态码，失败时用户能立即看到原因
#  4. 任何 Linux 基础镜像都自带 tar + curl
echo "[1/4] 正在下载源码（tarball 模式，无需 git）..."

ARCHIVE="/tmp/openclaw-napcat-${BRANCH}.tar.gz"
EXTRACT_DIR="/tmp/openclaw-napcat-extract-$$"
rm -rf "$TEMP_DIR" "$EXTRACT_DIR" "$ARCHIVE"
mkdir -p "$EXTRACT_DIR"

# 镜像列表：按优先级尝试（GitHub archive 直链）
# 顺序按"国内可用度 + 稳定性"排。ghfast/gh-proxy 经常挂,加 kkgithub 等兜底。
# 用户可通过 OPENCLAW_NAPCAT_MIRROR 环境变量强制指定单个镜像（跳过列表）。
MIRRORS=(
  "https://kkgithub.com/Daiyimo/openclaw-napcat/archive"
  "https://ghfast.top/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://mirror.ghproxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://github.com/Daiyimo/openclaw-napcat/archive"
)

DOWNLOAD_OK=0
# 如果用户指定了单一镜像,优先用它
if [ -n "$OPENCLAW_NAPCAT_MIRROR" ]; then
  MIRRORS=("$OPENCLAW_NAPCAT_MIRROR")
fi
for mirror in "${MIRRORS[@]}"; do
  url="${mirror}/refs/heads/${BRANCH}.tar.gz"
  echo "  尝试: $url"
  # -f 失败时返回非零；-L 跟随重定向；--connect-timeout 3 快速放弃坏代理；
  # --max-time 30 单镜像 30s 兜底(避免一个挂掉拖 2 分钟);-# 显示进度条
  if curl -fL --connect-timeout 3 --max-time 30 -# -o "$ARCHIVE" "$url"; then
    # 验证 tarball 完整（避免下载到 HTML 错误页）
    if tar -tzf "$ARCHIVE" &>/dev/null; then
      size=$(du -h "$ARCHIVE" | cut -f1)
      echo "  ✓ 下载成功 (${size})"
      DOWNLOAD_OK=1
      break
    else
      echo "  ✗ tarball 损坏（可能是 HTML 错误页），重试下一个镜像"
      rm -f "$ARCHIVE"
    fi
  else
    echo "  ✗ 下载失败 (curl exit=$?)"
  fi
done

if [ "$DOWNLOAD_OK" -ne 1 ]; then
  echo "✗ 所有镜像均失败，请检查网络连接"
  echo "  提示:可设置 OPENCLAW_NAPCAT_MIRROR 指定单一镜像，例如:"
  echo "    export OPENCLAW_NAPCAT_MIRROR=https://kkgithub.com/Daiyimo/openclaw-napcat/archive"
  exit 1
fi

# 解压到临时目录（GitHub archive 根目录是 openclaw-napcat-<branch>/）
if ! tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"; then
  echo "✗ 解压失败"
  exit 1
fi
rm -f "$ARCHIVE"
# -mindepth 1 跳过搜索根自身：EXTRACT_DIR 名为 openclaw-napcat-extract-<pid>，
# 模式 openclaw-napcat-* 会把它本身当匹配项，导致 head -1 拿到父目录而非子目录
TEMP_DIR=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -name "openclaw-napcat-*" | head -1)
if [ -z "$TEMP_DIR" ]; then
  echo "✗ 解压后未找到源码目录"
  exit 1
fi
# 回归保护：find 自匹配 bug 不应再出现
if [ "$TEMP_DIR" = "$EXTRACT_DIR" ]; then
  echo "✗ 内部错误：find 返回了 EXTRACT_DIR 自身，请报告此 bug"
  exit 1
fi

cd "$TEMP_DIR"

# ── 2. 安装依赖并编译 TypeScript ──────────────────────────────────────────────
echo ""
echo "[2/4] 安装依赖并编译（约 60 秒）..."

npm install --registry=https://registry.npmmirror.com 2>/dev/null || npm install
npm run build
npm prune --omit=dev

echo "✓ 编译完成"

# ── 3. 安装到持久化扩展目录 ───────────────────────────────────────────────────
echo ""
echo "[3/4] 安装到 $EXT_DIR ..."

rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR/docker"

cp -r dist node_modules package.json openclaw.plugin.json "$EXT_DIR/"
cp docker/setup-config.cjs "$EXT_DIR/docker/"

# 验证核心文件
if [ ! -f "$EXT_DIR/dist/src/index.js" ]; then
  echo "✗ 安装失败：dist/src/index.js 不存在"
  exit 1
fi
if [ ! -d "$EXT_DIR/node_modules" ]; then
  echo "✗ 安装失败：node_modules 不存在，npm install 可能未完成"
  exit 1
fi
if [ ! -f "$EXT_DIR/docker/setup-config.cjs" ]; then
  echo "✗ 安装失败：docker/setup-config.cjs 不存在"
  exit 1
fi

echo "✓ 插件文件已复制"

# ── 4. 写入 NapCat 渠道配置 ────────────────────────────────────────────────────
echo ""
echo "[4/4] 写入 NapCat 渠道配置..."

QQ_FORCE_RECONFIGURE=true node "$EXT_DIR/docker/setup-config.cjs"

echo "✓ 配置写入完成"

# ── 5. 静默重启容器并刷新群路由 ───────────────────────────────────────────────
echo ""
echo "[5/5] 重启 OpenClaw 容器..."

# 查找容器名称
CONTAINER_NAME=$(docker ps --filter "name=openclaw" --format "{{.Names}}" 2>/dev/null | head -n 1)

if [ -n "$CONTAINER_NAME" ] && [ -n "$COMPOSE_CMD" ]; then
  # docker-compose 方式：静默重启
  $COMPOSE_CMD restart openclaw 2>/dev/null || true
  echo "✓ 容器已重启，群路由将在 connect handler 中自动注册"
elif [ -n "$CONTAINER_NAME" ]; then
  # docker run 方式：直接 restart
  docker restart "$CONTAINER_NAME" 2>/dev/null || true
  echo "✓ 容器已重启，群路由将在 connect handler 中自动注册"
else
  echo "⚠ 未检测到运行中的 openclaw 容器，请手动启动："
  echo "   docker compose up -d"
fi

# ── 清理 ─────────────────────────────────────────────────────────────────────
rm -rf "$TEMP_DIR"

echo ""
echo "=== 安装完成 ==="
echo "✓ 插件路径: $EXT_DIR"
echo ""
echo "→ 下一步："
echo "   1. 执行 openclaw onboard 进行初始化配置（AI 模型、账号等）"
echo "   2. 配置完成后执行 openclaw gateway 拉起服务"
echo "      观察日志中是否出现以下内容："
echo "        [napcat-QQ] Reverse WebSocket server listening on port 3002"
echo "        [napcat-QQ] Reverse WS: NapCat connected"
echo "      若 NapCat 尚未启动，请先启动 NapCat，等待约 1 分钟自动连上"
echo ""
echo "提示：如需更新插件，重新运行此脚本即可。"
