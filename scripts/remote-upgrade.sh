#!/bin/bash
# ============================================================================
# OpenClaw NapCat 远程一键升级脚本
# ============================================================================
#
# 一键升级任何 Docker 部署的 OpenClaw NapCat 实例。
#
# 使用方法（在任意 Docker 宿主机的终端执行）:
#
#   curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/remote-upgrade.sh | bash
#
# 国内镜像加速（raw.githubusercontent.com 被墙时）:
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/remote-upgrade.sh | bash
#
# 自动检测：容器名、volume 路径、配置文件路径全部自动识别。
# 也可手动指定：
#   CONTAINER_NAME=my-openclaw DATA_DIR=/my/data curl -fsSL ... | bash
#
# 环境变量:
#   CONTAINER_NAME  — 容器名（默认: 自动检测第一个含 openclaw 的容器）
#   DATA_DIR        — 宿主机数据卷路径（默认: 自动检测）
#   BRANCH          — 代码分支（默认: main）
#   MIRROR          — 强制指定单一下载镜像 URL
#
# 流程: 检测 → 下载 → 备份 → 容器内编译 → 部署 → 修复配置 → 重启 → 清理
# ============================================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

log()   { echo -e "${BLUE}[*]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── 自动检测：容器名 ──────────────────────────────────────────────────────────
detect_container() {
    if [ -n "$CONTAINER_NAME" ]; then return; fi
    CONTAINER_NAME=$(docker ps --format "{{.Names}}" 2>/dev/null \
        | grep -i "openclaw" | head -n 1)
    [ -n "$CONTAINER_NAME" ] || fail "未找到 openclaw 容器，请用 CONTAINER_NAME=xxx 指定"
    log "自动检测到容器: ${CONTAINER_NAME}"
}

# ── 自动检测：宿主机 volume 路径 ────────────────────────────────────────────
# 策略：
#   1. DATA_DIR 环境变量已设置 → 直接用
#   2. 从 docker inspect 读取 bind mount（最常见：-v /host/path:/container/path）
#   3. 从 docker inspect 读取 named volume 挂载点
#   4. 搜索常见路径
detect_data_dir() {
    if [ -n "$DATA_DIR" ]; then
        log "使用指定 DATA_DIR: ${DATA_DIR}"
        return
    fi

    log "自动检测数据卷路径..."

    local container="$1"
    local detected=""

    # 策略 1: 从 docker inspect 获取 bind mounts
    detected=$(docker inspect "$container" --format \
        '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
        | grep -E "(openclaw|napcat)" | head -n 1)

    # 策略 2: 如果没找到 bind mount，查 named volume
    if [ -z "$detected" ]; then
        detected=$(docker inspect "$container" --format \
            '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
            | grep "/home/node/.openclaw" | head -n 1 | awk '{print $1}')
        if [ -n "$detected" ]; then
            # named volume → 用 docker volume inspect 找宿主路径
            detected=$(docker volume inspect "$detected" --format '{{.Mountpoint}}' 2>/dev/null)
        fi
    fi

    # 策略 3: 常见路径
    if [ -z "$detected" ]; then
        for candidate in \
            "/volume1/docker/openclaw" \
            "/volume1/docker/napcat" \
            "/opt/openclaw" \
            "/home/*/openclaw" \
            "$HOME/openclaw" \
            "$HOME/.openclaw"; do
            if [ -d "$candidate/extensions/napcat" ]; then
                detected="$candidate"
                break
            fi
            # Handle glob patterns
            for expanded in $candidate; do
                if [ -d "$expanded/extensions/napcat" ]; then
                    detected="$expanded"
                    break 2
                fi
            done
        done
    fi

    if [ -n "$detected" ]; then
        DATA_DIR="$detected"
        log "自动检测到 DATA_DIR: ${DATA_DIR}"
    else
        warn "无法自动检测 DATA_DIR，使用默认值（可能不匹配你的环境）"
        DATA_DIR="/volume1/docker/openclaw"
    fi
}

CONTAINER_NAME="${CONTAINER_NAME:-}"
DATA_DIR="${DATA_DIR:-}"
BRANCH="${BRANCH:-main}"

# ── 前置检查 ──────────────────────────────────────────────────────────────────
check_prerequisites() {
    log "检查 Docker 环境..."
    command -v docker &>/dev/null || fail "未找到 docker 命令"
    detect_container
    detect_data_dir "$CONTAINER_NAME"

    EXT_HOST="${DATA_DIR}/extensions/napcat"
    if [ ! -d "$EXT_HOST" ]; then
        fail "插件目录不存在: ${EXT_HOST}\n  请确认 DATA_DIR 正确，或设置 DATA_DIR=/your/path"
    fi
    ok "环境正常 (容器=${CONTAINER_NAME}, 数据卷=${DATA_DIR})"
}

# ── 下载源码（6 镜像兜底） ────────────────────────────────────────────────────
download_source() {
    local out="$1"
    local mirrors=(
        "https://ghfast.top/https://github.com/Daiyimo/openclaw-napcat/archive"
        "https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
        "https://mirror.ghproxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
        "https://github.com/Daiyimo/openclaw-napcat/archive"
        "https://ghproxy.cn/https://github.com/Daiyimo/openclaw-napcat/archive"
        "https://gh-proxy.net/https://github.com/Daiyimo/openclaw-napcat/archive"
    )
    [ -n "$MIRROR" ] && mirrors=("$MIRROR")

    log "下载源码（${BRANCH}）..."
    for m in "${mirrors[@]}"; do
        local url="${m}/refs/heads/${BRANCH}.tar.gz"
        echo -e "  ${CYAN}→${NC} ${url}"
        if curl -fL --connect-timeout 3 --max-time 30 -o "$out" "$url" 2>/dev/null; then
            if tar -tzf "$out" &>/dev/null; then
                ok "下载成功 ($(du -h "$out" | cut -f1))"
                return 0
            fi
            warn "文件损坏，换镜像..."
            rm -f "$out"
        fi
    done
    return 1
}

# ── 备份 ──────────────────────────────────────────────────────────────────────
backup() {
    local dir="/tmp/openclaw-napcat-bk-$$"
    mkdir -p "$dir"
    cp -r "$EXT_HOST/dist" "$dir/" 2>/dev/null || true
    echo "$dir"
}

rollback() {
    local bk="$1"
    [ -d "$bk/dist" ] || return 0
    warn "回滚到备份版本..."
    rm -rf "$EXT_HOST/dist"
    docker cp "$bk/dist" "${CONTAINER_NAME}:${EXT_CONT}/" 2>/dev/null || true
    docker restart "$CONTAINER_NAME" > /dev/null 2>&1 || true
    ok "已回滚"
}

# ── 自动检测容器内配置路径 ───────────────────────────────────────────────────
detect_container_config() {
    # 容器内可能的配置路径（不同镜像/安装方式不同）
    local paths=(
        "/home/node/.openclaw/openclaw.json"
        "/root/.openclaw/openclaw.json"
        "/home/openclaw/.openclaw/openclaw.json"
        "/etc/openclaw/openclaw.json"
    )
    for p in "${paths[@]}"; do
        if docker exec "$CONTAINER_NAME" test -f "$p" 2>/dev/null; then
            CONFIG_PATH="$p"
            return 0
        fi
    done
    # Fallback: find it
    CONFIG_PATH=$(docker exec "$CONTAINER_NAME" find / -name "openclaw.json" -path "*/.openclaw/*" 2>/dev/null | head -n 1)
    echo "$CONFIG_PATH"
}

# ══════════════════════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║        OpenClaw NapCat  远程一键升级                        ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

check_prerequisites

EXT_CONT="/home/node/.openclaw/extensions/napcat"

# ── 1. 下载源码 ───────────────────────────────────────────────────────────────
ARCHIVE="/tmp/openclaw-napcat-up-$$.tar.gz"
download_source "$ARCHIVE" || fail "所有镜像下载失败。可尝试: export MIRROR=https://kkgithub.com/Daiyimo/openclaw-napcat/archive && 重跑"

# ── 2. 备份 ───────────────────────────────────────────────────────────────────
BK_DIR=$(backup)
log "备份完成: ${BK_DIR}"

# ── 3. 容器内编译 ────────────────────────────────────────────────────────────
echo ""
log "容器内编译（安装依赖 → 构建 → 精简）..."
CID="$CONTAINER_NAME"
TMP_IN="/tmp/_oc_up_$$"

docker exec "$CID" sh -c "
    set -e
    rm -rf ${TMP_IN}
    mkdir -p ${TMP_IN}
    tar -xzf /tmp/_archive_$$ -C ${TMP_IN}
    SRC=\$(find ${TMP_IN} -mindepth 1 -maxdepth 1 -type d -name 'openclaw-napcat-*' | head -1)
    cd \$SRC
    echo '  npm install...'
    npm install --include=dev --registry=https://registry.npmmirror.com 2>/dev/null || npm install --include=dev
    echo '  npm run build...'
    npm run build
    echo '  npm prune...'
    npm prune --omit=dev
    mkdir -p ${TMP_IN}/out
    cp -r dist node_modules package.json openclaw.plugin.json tsconfig.json ${TMP_IN}/out/
    tar -C ${TMP_IN}/out -czf ${TMP_IN}/result.tar.gz .
    echo '__BUILD_OK__'
    rm -rf ${TMP_IN}
" 2>&1 | tail -5

docker exec "$CID" test -f "${TMP_IN}/result.tar.gz" 2>/dev/null \
    || { rollback "$BK_DIR"; fail "编译失败，已回滚"; }
ok "编译完成"

# ── 4. 导出编译结果并部署 ───────────────────────────────────────────────────
RESULT_TAR="/tmp/openclaw-napcat-result-$$.tar.gz"
docker cp "${CID}:${TMP_IN}/result.tar.gz" "$RESULT_TAR"
docker exec "$CID" rm -rf "$TMP_IN" "/tmp/_archive_$$" 2>/dev/null || true

log "部署插件..."
DEPLOY_DIR="/tmp/openclaw-napcat-dep-$$"
mkdir -p "$DEPLOY_DIR"
tar -xzf "$RESULT_TAR" -C "$DEPLOY_DIR"
rm -f "$RESULT_TAR"

# 备份用户文件
for f in docker/setup-config.cjs; do
    [ -f "$EXT_HOST/$f" ] && cp "$EXT_HOST/$f" "$BK_DIR/"
done

# 替换文件
rm -rf "$EXT_HOST/dist"
cp -r "${DEPLOY_DIR}/dist" "${DEPLOY_DIR}/node_modules" "${DEPLOY_DIR}/package.json" "${DEPLOY_DIR}/openclaw.plugin.json" "${DEPLOY_DIR}/tsconfig.json" "$EXT_HOST/" 2>/dev/null || true
mkdir -p "$EXT_HOST/docker"
cp -r "${DEPLOY_DIR}/docker/"* "$EXT_HOST/docker/" 2>/dev/null || true
rm -rf "$DEPLOY_DIR"

# 恢复用户文件
for f in docker/setup-config.cjs; do
    [ -f "$BK_DIR/$f" ] && cp "$BK_DIR/$f" "$EXT_HOST/$f"
done

[ -f "$EXT_HOST/dist/src/index.js" ] || { rollback "$BK_DIR"; fail "部署校验失败，已回滚"; }
ok "插件已部署"

# 5. fix config compatibility (profile / visibility / agentToAgent) -------------------------
echo ""
log "fix config compatibility..."

CFG_IN_CONTAINER=$(detect_container_config)
if [ -n "$CFG_IN_CONTAINER" ]; then
    log "config path: ${CFG_IN_CONTAINER}"
    docker exec "$CID" node -e "
        const fs = require('fs');
        const path = process.argv[1];
        const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
        let changed = false;
        const validProfiles = ['minimal', 'coding', 'messaging', 'full'];
        const profile = cfg.tools && cfg.tools.profile;
        if (typeof profile === 'object' && profile !== null) {
            cfg.tools.profile = 'full';
            changed = true;
            console.log('FIXED: profile invalid object -> full');
        } else if (typeof profile === 'string' && !validProfiles.includes(profile)) {
            cfg.tools.profile = 'full';
            changed = true;
            console.log('FIXED: profile invalid value -> full');
        }
        if (!cfg.tools) cfg.tools = {};
        if (!cfg.tools.sessions) cfg.tools.sessions = {};
        if (cfg.tools.sessions.visibility !== 'all') {
            cfg.tools.sessions.visibility = 'all';
            changed = true;
            console.log('FIXED: sessions.visibility = all');
        }
        if (!cfg.tools.agentToAgent) cfg.tools.agentToAgent = {};
        if (cfg.tools.agentToAgent.enabled !== true) {
            cfg.tools.agentToAgent.enabled = true;
            changed = true;
            console.log('FIXED: agentToAgent.enabled = true');
        }
        if (changed) {
            fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '
');
            console.log('__CHANGED__');
        } else {
            console.log('__SKIP__');
        }
    " "$CFG_IN_CONTAINER" 2>/dev/null && {
        echo "  ✓ config fix done (profile / visibility / agentToAgent)"
    } || warn "  ! modify failed (check openclaw.json manually)"
else
    warn "  ! config not found in container, skip"
fi


# ── 6. 重启容器 ──────────────────────────────────────────────────────────────
echo ""
log "重启容器 ${CONTAINER_NAME}..."
docker restart "$CONTAINER_NAME" > /dev/null 2>&1 || fail "restart 失败"
sleep 3
docker ps --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$" \
    && ok "容器运行中" \
    || warn "容器可能异常，请检查: docker logs ${CONTAINER_NAME}"

# ── 7. 清理 ──────────────────────────────────────────────────────────────────
rm -rf "$BK_DIR" "$ARCHIVE"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo -e "║  ${GREEN}升级成功！${NC}                                                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
log "查看日志: docker logs ${CONTAINER_NAME} | grep napcat-QQ"
