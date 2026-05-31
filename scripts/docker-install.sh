#!/bin/bash
# openclaw-napcat QQ 插件安装脚本
#
# 在宿主机执行：
#   curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
#
# 特性：
#   - 插件安装到持久化数据卷 ~/.openclaw/extensions/napcat/，容器镜像更新后不丢失
#   - 自动编译 TypeScript，无需宿主机任何工具链
#   - 多镜像加速下载，自动静默重启容器
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

# ── 1. 下载源码（多镜像加速）─────────────────────────────────────────────
echo "[1/4] 正在下载源码..."
rm -rf "$TEMP_DIR"

# 镜像列表：按优先级尝试
MIRRORS=(
  "https://ghfast.top/https://github.com"
  "https://gh-proxy.com/https://github.com"
  "https://github.com"
)

REPO="Daiyimo/openclaw-napcat"
CLONE_URL=""

for mirror in "${MIRRORS[@]}"; do
  echo "  尝试镜像: $mirror"
  if git clone --branch "$BRANCH" --depth 1 "$mirror/$REPO.git" "$TEMP_DIR" 2>/dev/null; then
    CLONE_URL="$mirror/$REPO.git"
    echo "  ✓ 下载成功"
    break
  fi
  rm -rf "$TEMP_DIR"
done

if [ -z "$CLONE_URL" ]; then
  echo "✗ 所有镜像均失败，请检查网络连接"
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
echo "[4/5] 写入 NapCat 渠道配置..."

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
echo "   等待约 10 秒让容器启动完成，群路由会自动注册（无需手动 /groups）"
echo "   观察日志确认连接成功："
echo "     docker logs -f $CONTAINER_NAME 2>/dev/null | grep 'napcat-QQ'"
