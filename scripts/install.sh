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

# 2. 进入扩展目录，清理旧版本并下载源码（tarball 模式）
cd "$EXT_DIR"
if [ -d "napcat" ]; then
    echo "检测到旧版本，正在删除..."
    rm -rf napcat
fi

echo "正在下载插件源码（tarball 模式，无需 git）..."

ARCHIVE="/tmp/openclaw-napcat-main.tar.gz"
EXTRACT_DIR="/tmp/openclaw-napcat-extract-$$"
rm -rf "$EXTRACT_DIR" "$ARCHIVE"
mkdir -p "$EXTRACT_DIR"

# 镜像列表：按优先级尝试
MIRRORS=(
  "https://ghfast.top/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://github.com/Daiyimo/openclaw-napcat/archive"
)

DOWNLOAD_OK=0
for mirror in "${MIRRORS[@]}"; do
    url="${mirror}/refs/heads/main.tar.gz"
    echo "  尝试: $url"
    if curl -fL --connect-timeout 5 --max-time 120 -# -o "$ARCHIVE" "$url"; then
        if tar -tzf "$ARCHIVE" &>/dev/null; then
            size=$(du -h "$ARCHIVE" | cut -f1)
            echo "  ✓ 下载成功 (${size})"
            DOWNLOAD_OK=1
            break
        else
            echo "  ✗ tarball 损坏，重试下一个镜像"
            rm -f "$ARCHIVE"
        fi
    else
        echo "  ✗ 下载失败 (curl exit=$?)"
    fi
done

if [ "$DOWNLOAD_OK" -ne 1 ]; then
    echo "✗ 所有镜像均失败，请检查网络连接"
    exit 1
fi

if ! tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"; then
    echo "✗ 解压失败"
    exit 1
fi
rm -f "$ARCHIVE"

SRC_DIR=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -name "openclaw-napcat-*" | head -1)
if [ -z "$SRC_DIR" ]; then
    echo "✗ 解压后未找到源码目录"
    exit 1
fi
# 回归保护：find 自匹配 bug 不应再出现
if [ "$SRC_DIR" = "$EXTRACT_DIR" ]; then
    echo "✗ 内部错误：find 返回了 EXTRACT_DIR 自身，请报告此 bug"
    exit 1
fi

mv "$SRC_DIR" napcat
rm -rf "$EXTRACT_DIR"

cd napcat

# 3. 安装依赖（含 devDependencies 以支持编译）
echo "安装依赖..."
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
