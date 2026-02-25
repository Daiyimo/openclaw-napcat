#!/bin/bash

echo "=== OpenClaw 配置更新工具 ==="

# 检查依赖
if ! command -v jq &> /dev/null; then
    echo "错误: 未找到 jq 工具，请先安装。"
    exit 1
fi

# 获取真实用户和家目录 (应对 curl | sudo bash 环境变量漂移)
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(eval echo "~$REAL_USER")

# 配置文件路径
CONFIG_FILE="$REAL_HOME/.openclaw/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "错误: 未找到 $CONFIG_FILE，请确认 openclaw 已在用户 $REAL_USER 下正确安装。"
    exit 1
fi

echo "目标配置文件: $CONFIG_FILE"

# ── 交互式配置收集 ──────────────────────────────────────────

echo ""
# 注意：这里的 < /dev/tty 是 curl | bash 模式下能正常弹窗交互的关键
read -r -p "请输入 WebSocket 地址 (留空使用默认值 ws://127.0.0.1:3001): " INPUT_WS_URL </dev/tty
WS_URL="${INPUT_WS_URL:-ws://127.0.0.1:3001}"

read -r -p "请输入 HTTP API 地址 (留空使用默认值 http://127.0.0.1:3000): " INPUT_HTTP_URL </dev/tty
HTTP_URL="${INPUT_HTTP_URL:-http://127.0.0.1:3000}"

while true; do
    read -r -p "请输入管理员 QQ 号 (必填，仅限数字): " INPUT_ADMIN </dev/tty
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
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "备份已保存至: $BACKUP_FILE"

# 执行更新
sudo -u "$REAL_USER" jq \
  --arg wsUrl "$WS_URL" \
  --arg httpUrl "$HTTP_URL" \
  --argjson adminQq "$ADMIN_QQ" \
'
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
.gateway.controlUi = {"allowInsecureAuth": true} |
.gateway.trustedProxies = ["127.0.0.1", "192.168.110.0/24"] |
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
    # 确保文件权限还是属于真实用户的，避免被 root 抢占
    chown "$REAL_USER:$REAL_USER" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "更新成功！配置已应用。"
else
    echo "更新失败，正在恢复备份..."
    mv "$BACKUP_FILE" "$CONFIG_FILE"
    rm -f "${CONFIG_FILE}.tmp"
    exit 1
fi

# 检查 QQ 插件是否已加载
echo "正在检查 QQ 插件状态..."
# 用真实用户权限执行检查，防止 root 找不到环境变量中的 openclaw 路径
PLUGIN_LIST=$(sudo -u "$REAL_USER" openclaw plugins list 2>&1)

if echo "$PLUGIN_LIST" | grep -i "qq" | grep -i "loaded" &> /dev/null; then
    echo "QQ插件配置正常。"
    echo "正在重启网关服务..."
    
    # 1. 在用户模式先执行 stop
    echo "-> 正在以普通用户 ($REAL_USER) 身份停止服务..."
    sudo -u "$REAL_USER" openclaw gateway stop
    
    # 2. 用 sudo 启动服务
    echo "-> 正在以特权模式启动服务..."
    sudo openclaw gateway
else
    echo "警告: 未检测到 QQ 插件处于 loaded 状态，请检查配置是否正确。"
    echo "插件列表输出:"
    echo "$PLUGIN_LIST"
fi
