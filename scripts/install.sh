#!/bin/bash
set -e

echo "=== OpenClaw QQ 插件一键安装 ==="

# 获取当前用户
USER_NAME="$(whoami)"
echo "当前用户: $USER_NAME"

# 1. 自动搜索 openclaw 扩展目录
echo "正在搜索 openclaw 扩展目录..."

# 常见扩展目录路径
POSSIBLE_EXT_DIRS=(
    "/usr/lib/node_modules/openclaw/dist/extensions"
    "/usr/local/lib/node_modules/openclaw/dist/extensions"
    "$HOME/.openclaw/extensions"
)

EXT_DIR=""
for dir in "${POSSIBLE_EXT_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        EXT_DIR="$dir"
        break
    fi
done

# 如果没找到，尝试用 which 定位
if [ -z "$EXT_DIR" ]; then
    if OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
        OPENCLAW_DIR=$(dirname "$(dirname "$OPENCLAW_BIN")")/lib/node_modules/openclaw/dist
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
if [ -d "napcat" ]; then
    echo "检测到旧版本，正在删除..."
    rm -rf napcat
fi

echo "正在克隆插件..."
git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git napcat \
    || git clone https://github.com/Daiyimo/openclaw-napcat.git napcat

cd napcat

# 3. 安装依赖（含 devDependencies 以支持编译）
echo "安装依赖..."
# Force HTTPS for all git operations to avoid SSH key requirement
git config --global url."https://".insteadOf ssh://
git config --global url."https://github.com/".insteadOf git@github.com:
npm install --no-package-lock --no-audit --prefer-online --registry=https://registry.npmmirror.com

# 4. 编译 TypeScript
echo "编译插件..."
npm run build

# 5. 验证编译结果
if [ ! -f "dist/src/index.js" ]; then
    echo "错误: 编译失败，dist/src/index.js 不存在"
    exit 1
fi

echo ""
echo "=== 安装完成 ==="
echo "插件路径: $EXT_DIR/napcat"
echo "dist/src/index.js: 已生成 ✓"
echo "请重启 openclaw 使插件生效"
