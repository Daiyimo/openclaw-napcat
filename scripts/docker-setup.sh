#!/usr/bin/env bash
# ============================================================================
# openclaw-napcat Docker 一键部署脚本
# ============================================================================
#
# 用法：
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-setup.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-setup.sh | bash
#
# 或克隆后直接运行：
#   bash scripts/docker-setup.sh
#   bash scripts/docker-setup.sh /自定义/部署路径
#
# 脚本完成的工作：
#   1. 检查 Docker / Docker Compose / Git 依赖
#   2. 拉取（或更新）openclaw-napcat 源码
#   3. 交互式收集 NapCat 地址、管理员 QQ 等配置
#   4. 生成 .env 和 docker-compose.yml
#   5. 构建镜像并启动容器
#   6. 引导进入 openclaw gateway setup 完成频道配置
# ============================================================================

set -e

# ── 颜色 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[openclaw-napcat]${NC} $*"; }
success() { echo -e "${GREEN}[openclaw-napcat]${NC} ✓ $*"; }
warn()    { echo -e "${YELLOW}[openclaw-napcat]${NC} ! $*"; }
error()   { echo -e "${RED}[openclaw-napcat]${NC} ✗ $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }
ask()     {
    local prompt="$1" default="$2"
    if [ -n "$default" ]; then
        read -r -p "$(echo -e "  ${CYAN}${prompt}${NC} [${default}]: ")" _val
        echo "${_val:-$default}"
    else
        read -r -p "$(echo -e "  ${CYAN}${prompt}${NC}: ")" _val
        echo "$_val"
    fi
}
ask_yn() {
    local prompt="$1" default="${2:-n}"
    read -r -p "$(echo -e "  ${CYAN}${prompt}${NC} (y/N): ")" _yn
    [ "${_yn:-$default}" = "y" ] || [ "${_yn:-$default}" = "Y" ]
}

IS_INTERACTIVE=true
[ -t 0 ] || IS_INTERACTIVE=false

# ── 帮助 ─────────────────────────────────────────────────────────────────────
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    echo "openclaw-napcat Docker 一键部署脚本"
    echo ""
    echo "用法: bash docker-setup.sh [部署目录]"
    echo "  部署目录  可选，默认: ~/openclaw-napcat"
    echo ""
    echo "环境变量（非交互模式）："
    echo "  DEPLOY_DIR=/opt/qq   指定部署目录"
    echo "  QQ_HTTP_URL=...      跳过 HTTP 地址提示"
    echo "  QQ_WS_URL=...        跳过 WS 地址提示"
    echo "  QQ_ADMINS=...        跳过管理员 QQ 号提示"
    echo "  QQ_SKIP_BUILD=1      仅生成配置，不构建镜像"
    exit 0
fi

# ── 1. 前置依赖检查 ───────────────────────────────────────────────────────────
step "检查前置依赖"

check_cmd() {
    command -v "$1" >/dev/null 2>&1 || error "未找到 $1，请先安装后重试。$2"
}

check_cmd docker    "\n  安装参考: https://docs.docker.com/engine/install/"
success "Docker: $(docker --version | head -1)"

# Docker Compose：v2 作为子命令，v1 作为独立命令
if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
    success "Docker Compose v2: $(docker compose version --short 2>/dev/null || echo 'ok')"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
    warn "检测到 Docker Compose v1，建议升级到 v2"
else
    error "未找到 Docker Compose\n  安装参考: https://docs.docker.com/compose/install/"
fi

check_cmd git "\n  Ubuntu/Debian: sudo apt-get install git\n  CentOS/RHEL:   sudo yum install git"
success "Git: $(git --version | awk '{print $3}')"

# ── 2. 确定部署目录 ───────────────────────────────────────────────────────────
step "确定部署目录"

DEPLOY_DIR="${1:-${DEPLOY_DIR:-$HOME/openclaw-napcat}}"
info "部署目录: $DEPLOY_DIR"

if [ -d "$DEPLOY_DIR/.git" ]; then
    info "检测到已有仓库，执行 git pull 更新..."
    git -C "$DEPLOY_DIR" pull --ff-only 2>/dev/null && success "仓库已更新" || warn "git pull 失败，使用当前版本"
else
    mkdir -p "$DEPLOY_DIR"
    REPO_URL="https://github.com/Daiyimo/openclaw-napcat.git"
    PROXY_URL="https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git"
    info "正在克隆仓库到 $DEPLOY_DIR ..."
    if git clone --depth=1 "$REPO_URL" "$DEPLOY_DIR" 2>/dev/null; then
        success "克隆成功"
    else
        warn "直连 GitHub 失败，尝试 gh-proxy 代理..."
        git clone --depth=1 "$PROXY_URL" "$DEPLOY_DIR" \
            || error "克隆失败，请检查网络连接\n  手动: git clone $REPO_URL $DEPLOY_DIR"
        success "通过代理克隆成功"
    fi
fi

cd "$DEPLOY_DIR"

# ── 3. 收集配置 ───────────────────────────────────────────────────────────────
step "配置 NapCat 连接"

echo ""
info "请填写 NapCat 连接信息（容器部署时地址使用服务名，如 http://napcat:3000）"
echo ""

# 正向 / 反向模式选择
if [ "$IS_INTERACTIVE" = true ]; then
    echo -e "  WS 连接模式："
    echo -e "    ${CYAN}1${NC}) 正向模式（openclaw 主动连接 NapCat WS Server，推荐）"
    echo -e "    ${CYAN}2${NC}) 反向模式（NapCat 主动连接 openclaw WS Server，适合 NAT 穿透）"
    read -r -p "  请选择 [1]: " _ws_mode_choice
    _ws_mode_choice="${_ws_mode_choice:-1}"
else
    _ws_mode_choice="1"
fi

if [ "$_ws_mode_choice" = "2" ]; then
    WS_MODE="reverse"
    WS_MODE_LABEL="反向"
else
    WS_MODE="forward"
    WS_MODE_LABEL="正向"
fi
info "WS 模式: $WS_MODE_LABEL（$WS_MODE）"
echo ""

# HTTP URL
_default_http="http://napcat:3000"
QQ_HTTP_URL="${QQ_HTTP_URL:-}"
if [ -z "$QQ_HTTP_URL" ]; then
    QQ_HTTP_URL=$(ask "NapCat HTTP API 地址" "$_default_http")
fi
QQ_HTTP_URL="${QQ_HTTP_URL:-$_default_http}"
success "QQ_HTTP_URL=$QQ_HTTP_URL"

# WS URL / REVERSE_WS_PORT
QQ_WS_URL="${QQ_WS_URL:-}"
QQ_REVERSE_WS_PORT="${QQ_REVERSE_WS_PORT:-}"

if [ "$WS_MODE" = "forward" ]; then
    _default_ws="ws://napcat:3001"
    if [ -z "$QQ_WS_URL" ]; then
        QQ_WS_URL=$(ask "NapCat WebSocket Server 地址" "$_default_ws")
    fi
    QQ_WS_URL="${QQ_WS_URL:-$_default_ws}"
    success "QQ_WS_URL=$QQ_WS_URL"
else
    _default_port="3002"
    if [ -z "$QQ_REVERSE_WS_PORT" ]; then
        QQ_REVERSE_WS_PORT=$(ask "openclaw 反向 WS 监听端口" "$_default_port")
    fi
    QQ_REVERSE_WS_PORT="${QQ_REVERSE_WS_PORT:-$_default_port}"
    success "QQ_REVERSE_WS_PORT=$QQ_REVERSE_WS_PORT"
    info "NapCat websocketClients 需配置 url=ws://openclaw:$QQ_REVERSE_WS_PORT"
    QQ_WS_URL=""
fi

# Access Token
QQ_ACCESS_TOKEN="${QQ_ACCESS_TOKEN:-}"
if [ -z "$QQ_ACCESS_TOKEN" ] && [ "$IS_INTERACTIVE" = true ]; then
    _t=$(ask "NapCat 访问令牌（与 NapCat token 字段一致，无则留空）" "")
    QQ_ACCESS_TOKEN="$_t"
fi
[ -n "$QQ_ACCESS_TOKEN" ] && success "QQ_ACCESS_TOKEN=***已设置***" || info "访问令牌：未设置"

echo ""
step "配置权限与触发"
echo ""

# 管理员
QQ_ADMINS="${QQ_ADMINS:-}"
if [ -z "$QQ_ADMINS" ] && [ "$IS_INTERACTIVE" = true ]; then
    QQ_ADMINS=$(ask "管理员 QQ 号（逗号分隔，拥有 /ping /status /logs /mute /kick 权限，留空跳过）" "")
fi
[ -n "$QQ_ADMINS" ] && { QQ_ADMINS="${QQ_ADMINS// /}"; success "QQ_ADMINS=$QQ_ADMINS"; } || info "管理员：未设置"

# 群聊 @触发
QQ_REQUIRE_MENTION="${QQ_REQUIRE_MENTION:-true}"
if [ "$IS_INTERACTIVE" = true ]; then
    echo -e "  ${CYAN}群聊中是否需要 @机器人 才触发？${NC}（默认 yes）"
    read -r -p "  (Y/n): " _req
    [ "${_req:-Y}" = "n" ] || [ "${_req:-Y}" = "N" ] && QQ_REQUIRE_MENTION="false"
fi
success "QQ_REQUIRE_MENTION=$QQ_REQUIRE_MENTION"

# OpenClaw Gateway Token
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ] && [ "$IS_INTERACTIVE" = true ]; then
    _oct=$(ask "OpenClaw WebUI 访问密码（留空则无密码保护，建议设置）" "")
    OPENCLAW_GATEWAY_TOKEN="$_oct"
fi
[ -n "$OPENCLAW_GATEWAY_TOKEN" ] && success "OPENCLAW_GATEWAY_TOKEN=***已设置***" || warn "OpenClaw 未设置访问密码，请确保端口 18789 不对公网暴露"

# ── 4. 生成配置文件 ───────────────────────────────────────────────────────────
step "生成 .env 和 docker-compose.yml"

ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

# .env
cat > "$ENV_FILE" <<EOF
# openclaw-napcat Docker 部署配置
# 由 docker-setup.sh 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')

# ── NapCat 连接 ──────────────────────────────────────────────────────────────
QQ_HTTP_URL=${QQ_HTTP_URL}
EOF

if [ -n "$QQ_WS_URL" ]; then
    echo "QQ_WS_URL=${QQ_WS_URL}" >> "$ENV_FILE"
fi

if [ -n "$QQ_REVERSE_WS_PORT" ]; then
    echo "QQ_REVERSE_WS_PORT=${QQ_REVERSE_WS_PORT}" >> "$ENV_FILE"
fi

if [ -n "$QQ_ACCESS_TOKEN" ]; then
    echo "QQ_ACCESS_TOKEN=${QQ_ACCESS_TOKEN}" >> "$ENV_FILE"
else
    echo "# QQ_ACCESS_TOKEN=" >> "$ENV_FILE"
fi

cat >> "$ENV_FILE" <<EOF

# ── 权限 ─────────────────────────────────────────────────────────────────────
QQ_ADMINS=${QQ_ADMINS}
QQ_REQUIRE_MENTION=${QQ_REQUIRE_MENTION}
# QQ_ALLOWED_GROUPS=
# QQ_BLOCKED_USERS=

# ── AI 行为 ───────────────────────────────────────────────────────────────────
# QQ_SYSTEM_PROMPT=
# QQ_HISTORY_LIMIT=5
# QQ_MARKDOWN_MODE=passthrough

# ── OpenClaw ──────────────────────────────────────────────────────────────────
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
TZ=Asia/Shanghai

# 部署目录（Docker volume 挂载根目录）
OPENCLAW_CONFIG_DIR=${DEPLOY_DIR}/data
EOF

success ".env 已生成: $ENV_FILE"

# docker-compose.yml
REVERSE_WS_PORT_SECTION=""
if [ "$WS_MODE" = "reverse" ] && [ -n "$QQ_REVERSE_WS_PORT" ]; then
    REVERSE_WS_PORT_SECTION="      - \"${QQ_REVERSE_WS_PORT}:${QQ_REVERSE_WS_PORT}\"   # 反向 WS 端口"
fi

cat > "$COMPOSE_FILE" <<EOF
# openclaw-napcat Docker Compose
# 由 docker-setup.sh 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')

services:

  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    volumes:
      - ./napcat-data:/app/napcat/config
    environment:
      - NAPCAT_GID=1000
      - NAPCAT_UID=1000
    ports:
      - "6099:6099"     # WebUI 扫码登录
      - "3000:3000"     # HTTP API
    restart: unless-stopped

  openclaw:
    build:
      context: .
      dockerfile: docker/Dockerfile
    image: openclaw-qq:latest
    container_name: openclaw
    depends_on:
      - napcat
    volumes:
      - \${OPENCLAW_CONFIG_DIR:-./data}:/home/node/.openclaw
    environment:
      HOME: /home/node
      TZ: \${TZ:-Asia/Shanghai}
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN:-}
      QQ_HTTP_URL: \${QQ_HTTP_URL}
EOF

if [ -n "$QQ_WS_URL" ]; then
    echo "      QQ_WS_URL: \${QQ_WS_URL}" >> "$COMPOSE_FILE"
fi
if [ -n "$QQ_REVERSE_WS_PORT" ]; then
    echo "      QQ_REVERSE_WS_PORT: \${QQ_REVERSE_WS_PORT}" >> "$COMPOSE_FILE"
fi

cat >> "$COMPOSE_FILE" <<EOF
      QQ_ACCESS_TOKEN: \${QQ_ACCESS_TOKEN:-}
      QQ_ADMINS: \${QQ_ADMINS:-}
      QQ_REQUIRE_MENTION: \${QQ_REQUIRE_MENTION:-true}
      QQ_ALLOWED_GROUPS: \${QQ_ALLOWED_GROUPS:-}
      QQ_SYSTEM_PROMPT: \${QQ_SYSTEM_PROMPT:-}
      QQ_HISTORY_LIMIT: \${QQ_HISTORY_LIMIT:-5}
      QQ_MARKDOWN_MODE: \${QQ_MARKDOWN_MODE:-passthrough}
    ports:
      - "\${OPENCLAW_GATEWAY_PORT:-18789}:18789"
EOF

if [ -n "$REVERSE_WS_PORT_SECTION" ]; then
    echo "      $REVERSE_WS_PORT_SECTION" >> "$COMPOSE_FILE"
fi

cat >> "$COMPOSE_FILE" <<EOF
    init: true
    restart: unless-stopped
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
EOF

success "docker-compose.yml 已生成: $COMPOSE_FILE"

# ── 5. NapCat 配置提示 ────────────────────────────────────────────────────────
step "NapCat 网络配置"

mkdir -p "$DEPLOY_DIR/napcat-data"

if [ "$WS_MODE" = "forward" ]; then
    info "正向模式：NapCat 需启用 websocketServers（端口 3001）"
    info "可参考配置文件: config/napcat-forward.json.example"
    if [ -f "$DEPLOY_DIR/config/napcat-forward.json.example" ]; then
        cp "$DEPLOY_DIR/config/napcat-forward.json.example" "$DEPLOY_DIR/napcat-data/onebot11_napcat-forward.json.example"
        info "已复制参考配置到 napcat-data/ 目录"
    fi
else
    info "反向模式：NapCat 需配置 websocketClients 指向 openclaw:$QQ_REVERSE_WS_PORT"
    info "可参考配置文件: config/napcat-reverse.json.example"
    if [ -f "$DEPLOY_DIR/config/napcat-reverse.json.example" ]; then
        cp "$DEPLOY_DIR/config/napcat-reverse.json.example" "$DEPLOY_DIR/napcat-data/onebot11_napcat-reverse.json.example"
        info "已复制参考配置到 napcat-data/ 目录（修改 url 后移入 NapCat 配置目录）"
    fi
fi

# ── 6. 构建并启动 ─────────────────────────────────────────────────────────────
step "构建镜像并启动容器"

if [ "${QQ_SKIP_BUILD:-}" = "1" ]; then
    info "QQ_SKIP_BUILD=1，跳过构建和启动"
elif [ "$IS_INTERACTIVE" = true ]; then
    echo ""
    if ask_yn "现在构建镜像并启动容器？（首次构建约需 3-5 分钟）"; then
        info "开始构建镜像..."
        $COMPOSE_CMD -f "$COMPOSE_FILE" build --no-cache
        success "镜像构建完成"
        info "启动容器..."
        $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
        success "容器已启动"
    else
        info "跳过启动。稍后运行以下命令手动启动："
        echo ""
        echo "    cd $DEPLOY_DIR && docker compose up -d --build"
    fi
else
    info "非交互模式，跳过自动构建。手动启动命令："
    echo ""
    echo "    cd $DEPLOY_DIR && docker compose up -d --build"
fi

# ── 7. 完成指引 ───────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e " ${GREEN}${BOLD}部署完成！${NC}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo -e " ${BOLD}部署目录：${NC}$DEPLOY_DIR"
echo ""
echo -e " ${BOLD}启动 / 停止：${NC}"
echo "   cd $DEPLOY_DIR"
echo "   docker compose up -d --build    # 首次构建后启动"
echo "   docker compose down             # 停止"
echo "   docker compose logs -f openclaw # 查看日志"
echo ""
echo -e " ${BOLD}NapCat 扫码登录：${NC}"
echo "   http://<服务器IP>:6099"
echo ""
echo -e " ${BOLD}OpenClaw WebUI：${NC}"
echo "   http://<服务器IP>:18789"
echo ""
echo -e " ${BOLD}进入容器配置 QQ 频道（引导向导）：${NC}"
echo -e "   ${CYAN}docker exec -it openclaw openclaw gateway setup${NC}"
echo "   → 选择 QQ (OneBot) 频道"
echo "   → 按提示填写 NapCat 地址（容器间地址如 http://napcat:3000）"
echo ""
echo -e " ${BOLD}验证状态：${NC}"
echo "   docker exec openclaw openclaw --version"
echo "   docker exec openclaw openclaw status"
echo ""
echo -e " ${YELLOW}提示${NC}: 若环境变量已包含完整配置，容器启动时将自动写入"
echo "       openclaw.json，无需再运行 gateway setup。"
echo ""
