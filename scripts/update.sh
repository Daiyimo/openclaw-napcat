#!/bin/bash
set -e

echo "=== OpenClaw QQ 插件更新 ==="

# 1. 自动定位插件目录
EXT_DIR=$(find /usr /home /opt /var -type d -path "*/node_modules/openclaw/extensions" 2>/dev/null | head -n 1)
if [ -z "$EXT_DIR" ]; then
    if OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
        EXT_DIR="$(dirname "$(dirname "$OPENCLAW_BIN")")/lib/node_modules/openclaw/extensions"
    fi
fi

PLUGIN_DIR="$EXT_DIR/qq"

if [ ! -d "$PLUGIN_DIR" ]; then
    echo "错误: 未找到插件目录 $PLUGIN_DIR，请先运行 install.sh 安装插件"
    exit 1
fi

echo "插件目录: $PLUGIN_DIR"

# 2. 拉取最新代码
cd "$PLUGIN_DIR"

if [ ! -d ".git" ]; then
    echo "错误: 插件目录不是 git 仓库，请重新运行 install.sh"
    exit 1
fi

echo "正在拉取最新代码..."
git pull https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git main

# 3. 重新编译 TypeScript
echo "正在编译..."
npm install --registry=https://registry.npmmirror.com 2>/dev/null || npm install
npm run build
npm prune --omit=dev

echo "更新完成！"
echo ""

# 4. 重启 openclaw
echo "正在重启 OpenClaw..."
pkill -f "openclaw gateway" 2>/dev/null || true
sleep 2
echo "请手动运行: sudo openclaw gateway"
