#!/bin/bash

# 获取脚本执行时的真实用户（解决 sudo 下的权限归属问题）
REAL_USER=${SUDO_USER:-$USER}

echo "=== OpenClaw 配置更新工具 ==="

# 检查依赖
if ! command -v jq &> /dev/null; then
    echo "错误: 未找到 jq 工具，请先安装。"
    exit 1
fi

# 自动查找 openclaw.json
echo "正在自动查找 openclaw.json ..."
CONFIG_FILE=$(find / -name "openclaw.json" 2>/dev/null | head -n 1)

if [ -z "$CONFIG_FILE" ]; then
    echo "错误: 未找到 openclaw.json，请确认 openclaw 已正确安装。"
    exit 1
fi

echo "找到配置文件: $CONFIG_FILE (用户: $REAL_USER)"

# ── 交互式配置收集 ──────────────────────────────────────────

# wsUrl
echo ""
read -r -p "请输入 WebSocket 地址 (留空使用默认值 ws://127.0.0.1:3001): " INPUT_WS_URL
WS_URL="${INPUT_WS_URL:-ws://127.0.0.1:3001}"

# httpUrl
read -r -p "请输入 HTTP API 地址 (留空使用默认值 http://127.0.0.1:3000): " INPUT_HTTP_URL
HTTP_URL="${INPUT_HTTP_URL:-http://127.0.0.1:3000}"

# admins（必填，循环直到输入合法 QQ 号）
while true; do
    read -r -p "请输入管理员 QQ 号 (必填，仅限数字): " INPUT_ADMIN
    if [[ "$INPUT_ADMIN" =~ ^[0-9]+$ ]]; then
        ADMIN_QQ="$INPUT_ADMIN"
        break
    else
        echo "错误: 管理员 QQ 号不能为空且只能包含数字，请重新输入。"
    fi
done

echo ""
echo "配置预览:"
echo "  wsUrl  : $WS_URL"
echo "  httpUrl: $HTTP_URL"
echo "  admins : [$ADMIN_QQ]"
echo ""

# ────────────────────────────────────────────────────────────

BACKUP_FILE="${CONFIG_FILE}.bak.$(date +%F_%H%M%S)"

# 备份
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "备份已保存至: $BACKUP_FILE"

# 执行更新
jq \
  --arg wsUrl "$WS_URL" \
  --arg httpUrl "$HTTP_URL" \
  --argjson adminQq "$ADMIN_QQ" \
'
# 1. 写入完整的 channels 配置
.channels = {
  "qq": {
    "wsUrl": $wsUrl,
    "httpUrl": $httpUrl,
    "accessToken": "123456",
    "admins": [$adminQq],
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
.gateway.trustedProxies = ["127.0.0.1", "192.168.110.0/24"] |

# 4. 写入 plugins 配置
.plugins = {
  "entries": {
    "qq": {
      "enabled": true
    }
  }
}
' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"

if [ $? -eq 0 ]; then
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    chown "${REAL_USER}:${REAL_USER}" "$CONFIG_FILE" 2>/dev/null || true
    chmod 600 "$CONFIG_FILE"
    echo "更新成功！配置已应用。"

    # 同步配置到普通用户目录，确保非 root 下 openclaw gateway 能正常读取
    USER_HOME=$(eval echo "~$REAL_USER")
    USER_CONFIG_DIR="$USER_HOME/.openclaw"
    USER_CONFIG_FILE="$USER_CONFIG_DIR/openclaw.json"

    if [ "$CONFIG_FILE" != "$USER_CONFIG_FILE" ]; then
        echo "正在同步配置到用户目录: $USER_CONFIG_FILE ..."
        mkdir -p "$USER_CONFIG_DIR"
        cp "$CONFIG_FILE" "$USER_CONFIG_FILE"
        chown -R "${REAL_USER}:${REAL_USER}" "$USER_CONFIG_DIR"
        chmod 600 "$USER_CONFIG_FILE"
        echo "同步完成，普通用户现在可直接执行 openclaw gateway。"
    fi
else
    echo "更新失败，正在恢复备份..."
    mv "$BACKUP_FILE" "$CONFIG_FILE"
    rm -f "${CONFIG_FILE}.tmp"
    exit 1
fi

# 检查 QQ 插件是否已加载
echo "正在检查 QQ 插件状态..."
PLUGIN_LIST=$(openclaw plugins list 2>&1)

if echo "$PLUGIN_LIST" | grep -i "qq" | grep -i "loaded" &> /dev/null; then
    echo "QQ插件配置正常，重启openclaw即可使用。"
else
    echo "警告: 未检测到 QQ 插件处于 loaded 状态，请检查配置是否正确。"
    echo "插件列表输出:"
    echo "$PLUGIN_LIST"
fi
