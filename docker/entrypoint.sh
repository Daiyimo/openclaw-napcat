#!/bin/sh
# openclaw-napcat Docker 入口脚本
#
# 执行顺序：
#  1. 将 QQ_* 环境变量写入 openclaw 配置（若尚未配置）
#  2. exec 替换进程为真正的 openclaw 命令
#
# 若需交互式配置向导，运行：
#   docker exec -it <容器名> node openclaw.mjs gateway setup
# 或：
#   docker exec -it <容器名> sh
#   openclaw gateway setup

set -e

# ── 1. 将环境变量写入 channels.qq 配置 ────────────────────────────────────────
if [ -f "/app/extensions/qq/docker/setup-config.js" ]; then
  node /app/extensions/qq/docker/setup-config.js
else
  echo "[openclaw-napcat] 警告：setup-config.js 未找到，跳过环境变量配置"
fi

# ── 2. 启动 openclaw ───────────────────────────────────────────────────────────
exec "$@"
