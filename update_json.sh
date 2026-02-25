#!/bin/bash

echo "=== OpenClaw 配置更新工具 (自动切回用户模式) ==="

# 1. 初始环境检查
if ! command -v jq &> /dev/null; then
    echo "错误: 未找到 jq 工具。"
    exit 1
fi

# 获取最初发起 sudo 的普通用户名 (如 ugnas)
REAL_USER="${SUDO_USER:-$USER}"

# 2. 修改配置 (必须用 root 权限做的事)
CONFIG_FILE="/root/.openclaw/openclaw.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "错误: 未找到 $CONFIG_FILE"
    exit 1
fi

# 备份
cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"

# 交互获取输入 (使用 /dev/tty 确保 curl | bash 模式下正常工作)
read -r -p "请输入 WebSocket 地址 (默认 ws://127.0.0.1:3001): " INPUT_WS_URL </dev/tty
WS_URL="${INPUT_WS_URL:-ws://127.0.0.1:3001}"

read -r -p "请输入管理员 QQ 号: " INPUT_ADMIN </dev/tty

# 执行修改
jq --arg ws "$WS_URL" --argjson admin "$INPUT_ADMIN" \
'.channels.qq.wsUrl = $ws | .channels.qq.admins = [$admin] | .plugins.entries.qq.enabled = true' \
"$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

echo "配置修改完成。"

# 3. 退出 Root 逻辑：以普通用户身份接管后续操作
# 我们使用 sudo -u 执行一个复合命令，这模拟了“退出 root 回到用户模式”的行为
echo "正在切换回用户 $REAL_USER 执行服务重启..."

sudo -u "$REAL_USER" bash << EOF
    echo "--- 当前用户: \$(whoami) ---"
    
    echo "1. 正在停止服务..."
    openclaw gateway stop
    
    sleep 2
    
    echo "2. 正在启动服务 (后台运行)..."
    # 使用 nohup 确保脚本退出后，程序依然运行
    nohup openclaw gateway > /tmp/openclaw_service.log 2>&1 &
    
    echo "3. 检查进程..."
    sleep 1
    pgrep -fl openclaw
    echo "服务已在后台启动。日志位于 /tmp/openclaw_service.log"
EOF

echo "=== 脚本执行完毕，Root 进程已退出 ==="
