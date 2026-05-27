#!/bin/bash
# openclaw-napcat QQ 插件安装脚本
#
# 在 openclaw 容器终端内执行：
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
#
# 特性：
#   - 插件安装到持久化数据卷 ~/.openclaw/extensions/napcat/，容器镜像更新后不丢失
#   - 自动编译 TypeScript，无需宿主机任何工具链
#   - 读取容器内 QQ_* 环境变量写入 openclaw.json

set -e

BRANCH="${OPENCLAW_NAPCAT_BRANCH:-main}"
EXT_DIR="${HOME:-/home/node}/.openclaw/extensions/napcat"
TEMP_DIR="/tmp/openclaw-napcat-install-$$"

echo "=== OpenClaw NapCat 插件安装 ==="
echo "分支: $BRANCH"
echo "安装目录: $EXT_DIR"
echo ""

# ── 1. 下载源码 ──────────────────────────────────────────────────────────────
echo "[1/4] 正在下载源码..."
rm -rf "$TEMP_DIR"

git clone --branch "$BRANCH" --depth 1 \
  "https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git" "$TEMP_DIR" 2>/dev/null \
  || git clone --branch "$BRANCH" --depth 1 \
  "https://github.com/Daiyimo/openclaw-napcat.git" "$TEMP_DIR"

cd "$TEMP_DIR"
echo "✓ 源码下载完成"

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

# ── 清理临时文件 ─────────────────────────────────────────────────────────────
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
