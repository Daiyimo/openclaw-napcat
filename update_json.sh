#!/bin/bash

echo "=== OpenClaw 配置更新工具 (混合权限模式) ==="

# 1. 检查依赖
if ! command -v jq &> /dev/null; then
    echo "错误: 未找到 jq 工具，请先安装。"
    exit 1
fi

# 获取执行 sudo 的原始用户 (例如 ugnas)
# 如果直接是 root 登录，则 REAL_USER 还是 root
REAL_USER="${SUDO_USER:-$USER}"

# 2. 配置文件路径 (依然修改 root 下的配置)
CONFIG_FILE="/root/.openclaw/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "错误: 未找到 $CONFIG_FILE"
    exit 1
fi

echo "正在处理 root 配置文件: $CONFIG_FILE"
echo "原始执行用户: $REAL_USER"

# ── 交互式配置收集 ──────────────────────────────────────────

echo ""
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

# ────────────────────────────────────────────────────────────

# 3. 备份并更新 JSON (以 root 权限执行)
BACKUP_FILE="${CONFIG_FILE}.bak.$(date +%F_%H%M%S)"
cp "$CONFIG_FILE" "$BACKUP_FILE"

jq \
  --arg wsUrl "$WS_URL" \
  --arg httpUrl "$HTTP_URL" \
  --argjson adminQq "$ADMIN_QQ" \
'
.channels.qq = ( .channels.qq + {
    "wsUrl": $wsUrl,
    "httpUrl": $httpUrl,
    "admins": [$adminQq],
    "enabled": true
}) |
.gateway.controlUi = {"allowInsecureAuth": true} |
.plugins.entries.qq.enabled = true
' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"

if [ $? -eq 0 ]; then
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "更新成功！"
else
    mv "$BACKUP_FILE" "$CONFIG_FILE"
    echo "更新失败，已回滚。"
    exit 1
fi

# 4. 检查与重启
echo "正在检查 QQ 插件状态..."
# 这里建议也用 root 权限检查，如果 root 查不到，脚本会报错
PLUGIN_LIST=$(openclaw plugins list 2>&1)

if echo "$PLUGIN_LIST" | grep -i "qq" | grep -i "loaded" &> /dev/null; then
    echo "QQ 插件配置正常。"
    
    # 【关键修改】以原始用户身份执行 stop
    echo "-> 正在切换至用户 $REAL_USER 停止服务..."
    if [ "$REAL_USER" == "root" ]; then
        # 如果原本就是 root 登录的，没法降权，只能尝试直接跑
        openclaw gateway stop
    else
        # 核心逻辑：以普通用户身份执行
        sudo -u "$REAL_USER" openclaw gateway stop
    fi
    
    # 延时 2 秒确保端口释放
    sleep 2
    
    # 启动服务 (依然用 root 启动)
    echo "-> 正在以 root 身份启动服务..."
    # 加上 & 符号让它在后台运行，否则脚本会卡死在这里
    nohup openclaw gateway > /tmp/openclaw.log 2>&1 &
    
    echo "服务已在后台启动。你可以查看日志: tail -f /tmp/openclaw.log"
else
    echo "警告: QQ 插件未加载，跳过重启。"
fi
