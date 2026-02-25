#!/bin/bash

echo "=== OpenClaw 配置更新工具 ==="

# 获取最初发起 sudo 的普通用户名 (例如你的 ugnas)
REAL_USER="${SUDO_USER:-$USER}"

# ────────────────────────────────────────────────────────────
# 第一步：以普通用户模式，最先停止服务
# ────────────────────────────────────────────────────────────
echo "[1/3] 正在以用户 ($REAL_USER) 身份停止网关服务..."

openclaw gateway stop

# 稍微等待 2 秒，确保旧进程完全退出，端口彻底释放
sleep 2 

# ────────────────────────────────────────────────────────────
# 第二步：在特权模式下，修改 Root 配置文件
# ────────────────────────────────────────────────────────────
echo "[2/3] 正在进入特权模式检查并修改配置..."

if ! command -v jq &> /dev/null; then
    echo "错误: 未找到 jq 工具，请先安装。"
    exit 1
fi

CONFIG_FILE="/root/.openclaw/openclaw.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "错误: 未找到配置文件 $CONFIG_FILE"
    exit 1
fi

# 交互获取配置
read -r -p "请输入 WebSocket 地址 (默认 ws://127.0.0.1:3001): " INPUT_WS_URL </dev/tty
WS_URL="${INPUT_WS_URL:-ws://127.0.0.1:3001}"

read -r -p "请输入 HTTP API 地址 (默认 http://127.0.0.1:3000): " INPUT_HTTP_URL </dev/tty
HTTP_URL="${INPUT_HTTP_URL:-http://127.0.0.1:3000}"

while true; do
    read -r -p "请输入管理员 QQ 号 (必填，仅限数字): " INPUT_ADMIN </dev/tty
    if [[ "$INPUT_ADMIN" =~ ^[0-9]+$ ]]; then
        ADMIN_QQ="$INPUT_ADMIN"
        break
    else
        echo "错误: QQ 号只能包含数字，请重新输入。"
    fi
done

# 备份并修改 JSON
BACKUP_FILE="${CONFIG_FILE}.bak.$(date +%F_%H%M%S)"
cp "$CONFIG_FILE" "$BACKUP_FILE"

jq --arg ws "$WS_URL" --arg http "$HTTP_URL" --argjson admin "$ADMIN_QQ" \
'.channels.qq.wsUrl = $ws | 
 .channels.qq.httpUrl = $http | 
 .channels.qq.admins = [$admin] | 
 .plugins.entries.qq.enabled = true |
 .gateway.controlUi = {"allowInsecureAuth": true}' \
"$CONFIG_FILE" > "${CONFIG_FILE}.tmp"

if [ $? -eq 0 ]; then
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "配置修改完成 (Root 权限)。"
else
    mv "$BACKUP_FILE" "$CONFIG_FILE"
    echo "更新失败，已回滚配置。"
    exit 1
fi

# ────────────────────────────────────────────────────────────
# 第三步：退出特权操作，以普通用户模式重新启动服务
# ────────────────────────────────────────────────────────────
echo "[3/3] 正在切回用户 ($REAL_USER) 模式启动网关..."

sudo openclaw gateway
