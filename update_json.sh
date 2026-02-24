#!/bin/bash

# 使用说明: ./update_strict.sh <用户名> <配置文件绝对路径>
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "错误: 缺少参数"
    echo "用法: $0 <用户名> <配置文件路径>"
    exit 1
fi

TARGET_USER="$1"
CONFIG_FILE="$2"
BACKUP_FILE="${CONFIG_FILE}.bak.$(date +%F_%H%M%S)"

echo "正在处理: $CONFIG_FILE (用户: $TARGET_USER)"

# 检查依赖
if ! command -v jq &> /dev/null; then
    echo "错误: 未找到 jq 工具，请先安装。"
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "错误: 文件不存在 $CONFIG_FILE"
    exit 1
fi

# 备份
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "备份已保存至: $BACKUP_FILE"

# 执行更新
jq '
# 1. 写入完整的 channels 配置
.channels = {
  "qq": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "123456",
    "admins": [],
    "allowedGroups": [],
    "blockedUsers": [999999],
    "systemPrompt": "好好干，你不干，有的是其他AI干。",
    "historyLimit": 5,
    "keywordTriggers": ["小助手", "帮助"],
    "autoApproveRequests": true,
    "enableGuilds": true,
    "enableTTS": false,
    "rateLimitMs": 1000,
    "formatMarkdown": true,
    "antiRiskMode": false,
    "maxMessageLength": 4000,
    "requireMention": true,
    "reactionEmoji": "auto",
    "autoMarkRead": true,
    "enableReactions": true,
    "enableDeduplication": true,
    "enableErrorNotify": true,
    "enableOcr": true,
    "enableUrlCheck": true,
    "enableGroupHonor": true,
    "enableGroupSignIn": true,
    "autoCleanCache": true,
    "enableEssenceMsg": true
  }
} |

# 2. 写入 gateway.controlUi
.gateway.controlUi = {"allowInsecureAuth": true} |

# 3. 写入 gateway.trustedProxies
.gateway.trustedProxies = ["127.0.0.1", "192.168.110.0/24"]
' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"

if [ $? -eq 0 ]; then
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    chown "${TARGET_USER}:${TARGET_USER}" "$CONFIG_FILE" 2>/dev/null || true
    chmod 600 "$CONFIG_FILE"
    echo "更新成功！配置已应用。"
else
    echo "更新失败，正在恢复备份..."
    mv "$BACKUP_FILE" "$CONFIG_FILE"
    rm -f "${CONFIG_FILE}.tmp"
    exit 1
fi
