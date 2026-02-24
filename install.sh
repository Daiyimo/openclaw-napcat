#!/bin/bash
set -e

# 获取脚本执行时的真实用户（解决 sudo 下的权限归属问题）
REAL_USER=${SUDO_USER:-$USER}
USER_HOME=$(eval echo "~$REAL_USER")

echo "=== OpenClaw QQ 插件一键安装 (路径修复增强版) ==="

# 1. 自动定位 OpenClaw 根目录
if ! OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
    echo "错误: 未找到 openclaw 二进制文件。请确保已全局安装。"
    exit 1
fi

# 获取真实物理路径（处理软连接）
REAL_BIN_PATH=$(readlink -f "$OPENCLAW_BIN")

# 判断是否为标准 npm 全局安装结构
if [[ "$REAL_BIN_PATH" == *"/node_modules/openclaw/"* ]]; then
    # 情况1: 路径包含 /node_modules/openclaw/，则取其父目录作为根
    # 例如: /usr/lib/node_modules/openclaw/openclaw.mjs → /usr/lib/node_modules/openclaw
    OPENCLAW_DIR=$(dirname "$REAL_BIN_PATH")
    # 安全检查：确保它是个目录
    if [ ! -d "$OPENCLAW_DIR" ]; then
        echo "错误: 推导出的 OpenClaw 目录不是一个有效目录: $OPENCLAW_DIR"
        exit 1
    fi
else
    # 备选方案：通过 npm prefix 推导
    NODE_PREFIX=$(npm config get prefix)
    OPENCLAW_DIR="$NODE_PREFIX/lib/node_modules/openclaw"
    if [ ! -d "$OPENCLAW_DIR" ]; then
        echo "错误: 无法通过 npm prefix 定位 OpenClaw 目录: $OPENCLAW_DIR"
        exit 1
    fi
fi

EXT_DIR="$OPENCLAW_DIR/extensions"

# 清理上次错误安装产生的冗余目录 (可选)
if [ -d "/usr/lib/node_modules/lib" ]; then
    echo "发现上次安装的错误路径，正在清理..."
    sudo rm -rf "/usr/lib/node_modules/lib"
fi

echo "目标扩展目录: $EXT_DIR"

# 2. 权限预热：确保目录存在且当前用户有权操作
if [ ! -d "$EXT_DIR" ]; then
    echo "正在创建扩展目录..."
    sudo mkdir -p "$EXT_DIR"
fi
sudo chown -R "$REAL_USER" "$OPENCLAW_DIR"

# 3. 进入目录并克隆
cd "$EXT_DIR"
if [ -d "qq" ]; then
    echo "检测到旧版本，正在清理..."
    rm -rf qq
fi

echo "正在克隆插件 (用户: $REAL_USER)..."
sudo -u "$REAL_USER" git clone --branch v4.17.25 https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq

cd qq

# 4. 环境优化与权限修复
echo "优化 NPM 与 Git 环境..."
sudo chown -R "$REAL_USER" "$USER_HOME/.npm" 2>/dev/null || true

sudo -u "$REAL_USER" git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
sudo -u "$REAL_USER" git config --global url."https://github.com/".insteadOf "git@github.com:"

# 5. 安装依赖
echo "正在安装依赖..."
sudo -u "$REAL_USER" npm install ws zod --no-package-lock --omit=dev --no-audit --registry=https://registry.npmmirror.com

echo ""
echo "-------------------------------------------"
echo "安装成功！"
echo "插件路径: $EXT_DIR/qq"
echo "执行 'openclaw restart' 或手动重启服务即可生效。"
echo "-------------------------------------------"
