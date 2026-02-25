#!/bin/bash

echo "=== OpenClaw Configuration Update Tool ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Error: This script requires sudo privileges."
    echo "Usage: sudo $0"
    exit 1
fi

ORIGINAL_USER="${SUDO_USER:-$USER}"
if [ -z "$ORIGINAL_USER" ]; then
    echo "Error: Cannot determine original user."
    exit 1
fi

echo "Running as root. Will switch back to user: $ORIGINAL_USER"

# Check dependencies
if ! command -v jq &> /dev/null; then
    echo "Error: jq not found. Please install it."
    exit 1
fi

# Determine config path
USER_HOME=$(eval echo ~$ORIGINAL_USER)
CONFIG_FILE="$USER_HOME/.openclaw/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found at $CONFIG_FILE"
    exit 1
fi

echo "Config file: $CONFIG_FILE"

# Interactive Input
echo ""
read -r -p "Enter WebSocket URL (default: ws://127.0.0.1:3001): " INPUT_WS_URL </dev/tty
WS_URL="${INPUT_WS_URL:-ws://127.0.0.1:3001}"

read -r -p "Enter HTTP API URL (default: http://127.0.0.1:3000): " INPUT_HTTP_URL </dev/tty
HTTP_URL="${INPUT_HTTP_URL:-http://127.0.0.1:3000}"

while true; do
    read -r -p "Enter Admin QQ (digits only): " INPUT_ADMIN </dev/tty
    if [[ "$INPUT_ADMIN" =~ ^[0-9]+$ ]]; then
        ADMIN_QQ="$INPUT_ADMIN"
        break
    else
        echo "Error: Invalid input. Digits only."
    fi
done

echo ""
echo "Preview:"
echo "  wsUrl  : $WS_URL"
echo "  httpUrl: $HTTP_URL"
echo "  admins : [$ADMIN_QQ]"
echo ""

# Backup
BACKUP_FILE="${CONFIG_FILE}.bak.$(date +%F_%H%M%S)"
cp "$CONFIG_FILE" "$BACKUP_FILE"
chown "$ORIGINAL_USER":"$(id -gn $ORIGINAL_USER)" "$BACKUP_FILE"
echo "Backup saved to: $BACKUP_FILE"

# Update Config
jq \
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
    chown "$ORIGINAL_USER":"$(id -gn $ORIGINAL_USER)" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "Configuration updated successfully."
else
    echo "Update failed. Restoring backup..."
    mv "$BACKUP_FILE" "$CONFIG_FILE"
    chown "$ORIGINAL_USER":"$(id -gn $ORIGINAL_USER)" "$CONFIG_FILE"
    rm -f "${CONFIG_FILE}.tmp"
    exit 1
fi

# Check Plugin and Restart Service
echo ""
echo "Checking QQ plugin status..."

PLUGIN_LIST=$(su - "$ORIGINAL_USER" -c "openclaw plugins list" 2>&1)

if echo "$PLUGIN_LIST" | grep -i "qq" | grep -i "loaded" &> /dev/null; then
    echo "QQ plugin status: OK (loaded)."
    echo "Restarting gateway service..."
    
    # Stop service
    su - "$ORIGINAL_USER" -c "openclaw gateway stop"
    sleep 2
    
    # Start service
    sudo -u "$ORIGINAL_USER" openclaw gateway start
    
    if [ $? -eq 0 ]; then
        echo "Gateway restarted successfully."
    else
        echo "Warning: Gateway start command returned non-zero. Check logs."
    fi
else
    echo "Warning: QQ plugin not detected as loaded."
    echo "Plugin list output:"
    echo "$PLUGIN_LIST"
    echo "Automatic restart skipped. Please check configuration manually."
    exit 1
fi

echo "=== Done ==="
