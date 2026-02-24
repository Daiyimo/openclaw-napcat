#!/bin/bash
set -e

# 获取脚本执行时的真实用户
REAL_USER=${SUDO_USER:-$USER}
USER_HOME=$(eval echo "~$REAL_USER")

echo "=== OpenClaw QQ 插件一键安装 (终极修复版) ==="

# 1. 定位 OpenClaw 根目录：直接从 openclaw 命令推导
if ! OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
    echo "错误: 未找到 openclaw 二进制文件。请确保已全局安装。"
    exit 1
fi

REAL_BIN_PATH=$(readlink -f "$OPENCLAW_BIN")
OPENCLAW_DIR=$(dirname "$REAL_BIN_PATH")

# 安全检查：必须是目录
if [ ! -d "$OPENCLAW_DIR" ]; then
    echo "错误: 推导出的 OpenClaw 路径不是一个目录: $OPENCLAW_DIR"
    echo "请确认 openclaw 已正确安装。当前指向: $REAL_BIN_PATH"
    exit 1
fi

EXT_DIR="$OPENCLAW_DIR/extensions"

# 清理历史错误路径（可选）
if [ -d "/usr/lib/node_modules/lib" ]; then
    echo "发现残留错误路径，正在清理..."
    sudo rm -rf "/usr/lib/node_modules/lib"
fi

echo "目标扩展目录: $EXT_DIR"

# 2. 创建扩展目录并修复权限
if [ ! -d "$EXT_DIR" ]; then
    echo "正在创建扩展目录..."
    sudo mkdir -p "$EXT_DIR"
fi
sudo chown -R "$REAL_USER" "$OPENCLAW_DIR"

# 3. 克隆插件
cd "$EXT_DIR"
[ -d "qq" ] && { echo "检测到旧版本，正在清理..."; rm -rf qq; }

echo "正在克隆插件 (用户: $REAL_USER)..."
sudo -u "$REAL_USER" git clone --branch v4.17.25 https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq

cd qq

# 4. 修复环境
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
