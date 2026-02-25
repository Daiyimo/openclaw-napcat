#!/bin/bash
set -e

echo "=== OpenClaw QQ 插件一键安装 ==="

# 获取当前用户和家目录
USER_HOME="$HOME"
USER_NAME="$(whoami)"

echo "当前用户: $USER_NAME"
echo "用户目录: $USER_HOME"

# 1. 查找用户目录下的 npm 全局模块路径
# 优先查找 .npm-global/lib/node_modules/openclaw
# 如果不存在则查找 npm prefix -g 显示的路径

# 方法1: 检查用户自定义的 npm 全局目录
if [ -d "$USER_HOME/.npm-global/lib/node_modules/openclaw" ]; then
    OPENCLAW_DIR="$USER_HOME/.npm-global/lib/node_modules/openclaw"
# 方法2: 使用 npm prefix -g 获取全局路径
elif OPENCLAW_PREFIX=$(npm prefix -g 2>/dev/null); then
    OPENCLAW_DIR="$OPENCLAW_PREFIX/lib/node_modules/openclaw"
# 方法3: 查找系统中已安装的 openclaw
elif OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
    OPENCLAW_DIR=$(dirname "$(dirname "$OPENCLAW_BIN")")/lib/node_modules/openclaw
else
    echo "错误: 未找到 openclaw 安装路径，请先安装 openclaw 或配置 npm 全局目录"
    exit 1
fi

EXT_DIR="$OPENCLAW_DIR/extensions"

# 检查扩展目录是否存在
if [ ! -d "$EXT_DIR" ]; then
    echo "错误: 扩展目录不存在: $EXT_DIR"
    exit 1
fi

echo "扩展目录: $EXT_DIR"

# 2. 进入扩展目录，清理旧版本并克隆
cd "$EXT_DIR"
if [ -d "qq" ]; then
    echo "检测到旧版本，正在删除..."
    rm -rf qq
fi

echo "正在克隆插件..."
git clone --branch v4.17.25 https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq

cd qq

# 3. 安装依赖
echo "安装依赖..."
npm install ws zod --no-package-lock --omit=dev --no-audit --registry=https://registry.npmmirror.com

echo ""
echo "=== 安装完成 ==="
echo "插件路径: $EXT_DIR/qq"
echo "请重启 openclaw 使插件生效"
