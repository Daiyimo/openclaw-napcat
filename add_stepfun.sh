#!/bin/bash

# 脚本用途：向 OpenClaw 配置添加 StepFun 3.5 Flash 模型并设为主模型
# 使用方式：
#   sudo -i
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/add_stepfun.sh | bash -s -- "你的APIKey"

set -e

# 配置文件路径（已内置）
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
STEPFUN_APIKEY="${1:-}"

if [ -z "$STEPFUN_APIKEY" ]; then
    echo "错误：请提供 StepFun API Key 作为参数"
    echo "用法: curl -fsSL https://... | bash -s -- \"你的APIKey\""
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "错误：配置文件不存在: $CONFIG_FILE"
    echo "请确认 OpenClaw 已正确安装"
    exit 1
fi

# 检查 jq 是否安装
if ! command -v jq &> /dev/null; then
    echo "错误：需要安装 jq"
    echo "Ubuntu/Debian: apt install jq"
    echo "macOS: brew install jq"
    exit 1
fi

echo "=========================================="
echo "  OpenClaw 配置 - 添加 StepFun 3.5 Flash"
echo "=========================================="
echo ""
echo "配置文件: $CONFIG_FILE"
echo "API Key: ${STEPFUN_APIKEY:0:10}..."
echo ""

# 备份原文件
cp "$CONFIG_FILE" "${CONFIG_FILE}.bak.$(date +%Y%m%d%H%M%S)"
echo "已备份原配置文件"

# 使用 jq 修改配置：添加 stepfun provider 并设置为主模型
jq --arg apikey "$STEPFUN_APIKEY" '
    # 1. 添加或更新 stepfun provider
    .models.providers.stepfun = {
        "baseUrl": "https://api.stepfun.com/v1",
        "apiKey": $apikey,
        "api": "openai-completions",
        "models": [
            {
                "id": "stepfun/step-3.5-flash",
                "name": "Step 3.5 Flash",
                "api": "openai-completions",
                "reasoning": false,
                "input": ["text"],
                "cost": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0
                },
                "contextWindow": 256000,
                "maxTokens": 8192
            }
        ]
    } |
    # 2. 设置默认模型为 stepfun
    .agents.defaults.model.primary = "stepfun/step-3.5-flash"
' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

echo "=========================================="
echo "  配置更新完成!"
echo "=========================================="
echo "  - 已添加 StepFun 3.5 Flash"
echo "  - 默认模型: stepfun/step-3.5-flash"
echo "  - meta 信息保持不变"
echo "  - 备份文件: ${CONFIG_FILE}.bak.*"
