#!/bin/bash
set -e

# ============================================================
#  OpenClaw QQ 插件一键安装 + 配置 + 启动
#  用法: curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/scripts/setup.sh | sudo bash
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================================"
echo "  OpenClaw QQ 插件 一键安装 + 配置 + 启动"
echo "================================================"
echo ""

# ── 步骤 1: 安装插件 ────────────────────────────────────────
echo ">>> [1/2] 安装插件..."
echo ""
bash "$SCRIPT_DIR/install.sh"

echo ""
echo ">>> [2/2] 配置插件并启动服务..."
echo ""

# ── 步骤 2: 配置 + 启动 ─────────────────────────────────────
bash "$SCRIPT_DIR/update_json.sh"
