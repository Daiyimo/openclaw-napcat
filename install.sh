#!/bin/bash
set -e

echo "=== OpenClaw QQ 插件一键安装 ==="

# 获取当前用户
USER_NAME="$(whoami)"
echo "当前用户: $USER_NAME"

# 1. 自动搜索 openclaw 扩展目录
echo "正在搜索 openclaw 扩展目录..."

# 搜索包含 /node_modules/openclaw/extensions 的目录
EXT_DIR=$(find /usr /home /opt /var -type d -path "*/node_modules/openclaw/extensions" 2>/dev/null | head -n 1)

# 如果没找到，尝试用 which 定位
if [ -z "$EXT_DIR" ]; then
    if OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
        OPENCLAW_DIR=$(dirname "$(dirname "$OPENCLAW_BIN")")/lib/node_modules/openclaw
        EXT_DIR="$OPENCLAW_DIR/extensions"
    fi
fi

# 检查扩展目录是否存在
if [ -z "$EXT_DIR" ] || [ ! -d "$EXT_DIR" ]; then
    echo "错误: 未找到 openclaw 扩展目录，请确保已正确安装 openclaw"
    exit 1
fi

echo "找到扩展目录: $EXT_DIR"

# 检查写权限
if [ ! -w "$EXT_DIR" ]; then
    echo "警告: 当前用户对 $EXT_DIR 没有写权限"
    echo "请使用 sudo 运行此脚本，或联系管理员添加写权限"
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
# Force HTTPS for all git operations to avoid SSH key requirement
git config --global url."https://".insteadOf ssh://
git config --global url."https://github.com/".insteadOf git@github.com:
npm install ws zod --no-package-lock --omit=dev --no-audit --prefer-online --registry=https://registry.npmmirror.com

echo ""
echo "=== 安装完成 ==="
echo "插件路径: $EXT_DIR/qq"
echo "请重启 openclaw 使插件生效"
