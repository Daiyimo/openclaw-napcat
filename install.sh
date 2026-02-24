#!/bin/bash
set -e

echo "=== OpenClaw QQ 插件一键安装 ==="

# 1. 查找 openclaw 安装路径
OPENCLAW_BIN=$(which openclaw 2>/dev/null) || {
    echo "错误: 未找到 openclaw，请先安装 openclaw"
    exit 1
}
OPENCLAW_DIR=$(dirname "$(dirname "$OPENCLAW_BIN")")/lib/node_modules/openclaw
EXT_DIR="$OPENCLAW_DIR/extensions"

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

# 3. 修复 npm 目录权限
echo "修复 npm 目录权限..."
sudo chown -R "$(id -u):$(id -g)" ~/.npm 2>/dev/null || true
sudo chown -R "$(id -u):$(id -g)" ~/.npm-global 2>/dev/null || true

# 4. 强制 git 使用 HTTPS 替代 SSH（避免服务器无 SSH key 导致依赖安装失败）
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
git config --global url."https://github.com/".insteadOf "git@github.com:"

# 5. 安装依赖
echo "安装依赖..."
npm install ws zod --no-package-lock --omit=dev --no-audit --registry=https://registry.npmmirror.com

echo ""
echo "=== 安装完成 ==="
echo "插件路径: $EXT_DIR/qq"
echo "请重启 openclaw 使插件生效"
