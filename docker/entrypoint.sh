#!/bin/sh
# openclaw-napcat Docker 入口脚本（Dockerfile 构建路线）
#
# 执行顺序：
#  1. 将 QQ_* 环境变量写入 openclaw 配置（若尚未配置）
#  2. exec 替换进程为真正的 openclaw 命令

set -e

# ── 1. 将环境变量写入 channels.qq 配置 ────────────────────────────────────────
if [ -f "/app/extensions/napcat/docker/setup-config.cjs" ]; then
  node /app/extensions/napcat/docker/setup-config.cjs
else
  echo "[openclaw-napcat] 警告：setup-config.cjs 未找到，跳过环境变量配置"
fi

# ── 2. 启动 openclaw ───────────────────────────────────────────────────────────
exec "$@"
