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

# 2. 拉取最新代码（tarball 模式，无需 git）
cd "$PLUGIN_DIR"

# 清理上次解压残留
rm -rf /tmp/openclaw-napcat-update
rm -f /tmp/openclaw-napcat-main.tar.gz

ARCHIVE="/tmp/openclaw-napcat-main.tar.gz"
EXTRACT_DIR="/tmp/openclaw-napcat-update"
mkdir -p "$EXTRACT_DIR"

# 镜像列表：按优先级尝试
MIRRORS=(
  "https://ghfast.top/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://github.com/Daiyimo/openclaw-napcat/archive"
)

echo "正在下载最新源码（tarball 模式，无需 git）..."
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

# 备份几个用户可能改过的文件
BACKUP_DIR="/tmp/openclaw-napcat-backup-$$"
mkdir -p "$BACKUP_DIR"
for f in openclaw.plugin.json docker/setup-config.cjs; do
    [ -f "$PLUGIN_DIR/$f" ] && cp "$PLUGIN_DIR/$f" "$BACKUP_DIR/"
done

# 解压覆盖
if ! tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"; then
    echo "✗ 解压失败"
    exit 1
fi
rm -f "$ARCHIVE"

SRC_DIR=$(find "$EXTRACT_DIR" -maxdepth 1 -type d -name "openclaw-napcat-*" | head -1)
if [ -z "$SRC_DIR" ]; then
    echo "✗ 解压后未找到源码目录"
    exit 1
fi

# 用新源码覆盖插件目录（dist/node_modules/package.json 等）
rm -rf "$PLUGIN_DIR/dist" "$PLUGIN_DIR/node_modules" "$PLUGIN_DIR/src" "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/tsconfig.json" "$PLUGIN_DIR/openclaw.plugin.json"
cp -r "$SRC_DIR/dist" "$SRC_DIR/src" "$SRC_DIR/node_modules" "$SRC_DIR/package.json" "$SRC_DIR/tsconfig.json" "$SRC_DIR/openclaw.plugin.json" "$PLUGIN_DIR/" 2>/dev/null || true
# 恢复用户可能改过的文件
for f in openclaw.plugin.json docker/setup-config.cjs; do
    [ -f "$BACKUP_DIR/$f" ] && cp "$BACKUP_DIR/$f" "$PLUGIN_DIR/$f"
done
rm -rf "$EXTRACT_DIR" "$BACKUP_DIR"

# 3. 重新编译 TypeScript（如果需要）
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
