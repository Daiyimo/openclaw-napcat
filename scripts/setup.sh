#!/bin/bash
set -e

# ============================================================
#  OpenClaw QQ 插件一键安装 + 配置 + 启动
#  用法: curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/scripts/setup.sh | sudo bash
# ============================================================

# BASH_SOURCE 在通过管道输入时为空，因此使用固定的远程 raw URL
RAW_BASE="https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/scripts"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "================================================"
echo "  OpenClaw QQ 插件 一键安装 + 配置 + 启动"
echo "================================================"
echo ""

# ── 步骤 1: 安装插件 ────────────────────────────────────────
echo ">>> [1/2] 安装插件..."
echo ""
curl -fsSL "$RAW_BASE/install.sh" -o "$TMP_DIR/install.sh"
chmod +x "$TMP_DIR/install.sh"
bash "$TMP_DIR/install.sh"

echo ""
echo ">>> [2/2] 配置插件并启动服务..."
echo ""

# ── 步骤 2: 配置 + 启动 ─────────────────────────────────────
curl -fsSL "$RAW_BASE/update_json.sh" -o "$TMP_DIR/update_json.sh"
chmod +x "$TMP_DIR/update_json.sh"
bash "$TMP_DIR/update_json.sh"
