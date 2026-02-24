#!/bin/bash
set -e

# 获取脚本执行时的真实用户（解决 sudo 下的权限归属问题）
REAL_USER=${SUDO_USER:-$USER}
USER_HOME=$(eval echo "~$REAL_USER")

echo "=== OpenClaw QQ 插件一键安装 (路径修复版) ==="

# 1. 自动定位 OpenClaw 根目录 (智能路径识别)
if ! OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
    echo "错误: 未找到 openclaw 二进制文件。请确保已全局安装。"
    exit 1
fi

# 获取真实物理路径（处理软连接）
REAL_BIN_PATH=$(readlink -f "$OPENCLAW_BIN")

# 核心路径逻辑：从 /.../node_modules/openclaw/bin/openclaw 向上推导
# 如果路径符合标准结构，直接截取 bin 之前的部分
if [[ "$REAL_BIN_PATH" == *"/node_modules/openclaw/"* ]]; then
    OPENCLAW_DIR="${REAL_BIN_PATH%/bin/*}"
else
    # 备选方案：尝试通过 npm config 定位
    NODE_PREFIX=$(npm config get prefix)
    OPENCLAW_DIR="$NODE_PREFIX/lib/node_modules/openclaw"
fi

EXT_DIR="$OPENCLAW_DIR/extensions"

# 清理上次错误安装产生的冗余目录 (可选，防止强迫症)
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
# 将 OpenClaw 目录所有权赋予当前用户，避免 npm/git 权限报错
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
# 修复家目录 npm 缓存权限
sudo chown -R "$REAL_USER" "$USER_HOME/.npm" 2>/dev/null || true

# 强制使用 HTTPS 替代 SSH
sudo -u "$REAL_USER" git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
sudo -u "$REAL_USER" git config --global url."https://github.com/".insteadOf "git@github.com:"

# 5. 安装依赖
echo "正在安装依赖..."
# 以原用户身份运行，防止 root 产生无法删除的 lock 文件
sudo -u "$REAL_USER" npm install ws zod --no-package-lock --omit=dev --no-audit --registry=https://registry.npmmirror.com

echo ""
echo "-------------------------------------------"
echo "安装成功！"
echo "插件路径: $EXT_DIR/qq"
echo "执行 'openclaw restart' 或手动重启服务即可生效。"
echo "-------------------------------------------"
