#!/bin/bash
set -e

# 获取脚本执行时的真实用户（解决 sudo 下的权限归属问题）
REAL_USER=${SUDO_USER:-$USER}
USER_HOME=$(eval echo "~$REAL_USER")

echo "=== OpenClaw QQ 插件一键安装 (增强版) ==="

# 1. 查找 openclaw 路径 (尝试多个常用位置)
OPENCLAW_BIN=$(which openclaw 2>/dev/null || find /usr/local/bin /usr/bin -name "openclaw" 2>/dev/null | head -n 1)

if [ -z "$OPENCLAW_BIN" ]; then
    echo "错误: 未找到 openclaw。请确保已全局安装 openclaw (npm install -g openclaw)"
    exit 1
fi

# 获取 node_modules 所在的实际路径
# 通常全局安装在 /usr/local/lib/node_modules 或 /usr/lib/node_modules
OPENCLAW_DIR=$(dirname "$(dirname "$(readlink -f "$OPENCLAW_BIN")")")/lib/node_modules/openclaw
EXT_DIR="$OPENCLAW_DIR/extensions"

echo "目标扩展目录: $EXT_DIR"

# 2. 确保目录存在并处理权限
if [ ! -d "$EXT_DIR" ]; then
    echo "正在创建扩展目录..."
    sudo mkdir -p "$EXT_DIR"
fi
# 将目录所有权暂时给当前执行用户，方便后续 git/npm 操作
sudo chown -R "$REAL_USER" "$OPENCLAW_DIR"

# 3. 切换到目标目录并拉取代码
cd "$EXT_DIR"
if [ -d "qq" ]; then
    echo "检测到旧版本，正在清理..."
    rm -rf qq
fi

echo "正在克隆插件 (用户: $REAL_USER)..."
sudo -u "$REAL_USER" git clone --branch v4.17.25 https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq

cd qq

# 4. 配置 Git 和修复 NPM 权限
echo "优化环境配置..."
sudo -u "$REAL_USER" git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
sudo -u "$REAL_USER" git config --global url."https://github.com/".insteadOf "git@github.com:"

# 修复家目录下的 npm 缓存权限（关键！）
sudo chown -R "$REAL_USER" "$USER_HOME/.npm" 2>/dev/null || true

# 5. 安装依赖
echo "正在安装依赖 (使用镜像源)..."
# 使用 sudo -u 确保以普通用户身份运行 npm，避免 post-install 脚本报错
sudo -u "$REAL_USER" npm install ws zod --no-package-lock --omit=dev --no-audit --registry=https://registry.npmmirror.com

echo ""
echo "=== 安装完成 ==="
echo "插件已就绪: $EXT_DIR/qq"
echo "提示: 请执行 'openclaw restart' 或手动重启以生效。"
