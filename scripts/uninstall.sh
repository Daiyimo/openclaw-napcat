#!/bin/bash
# OpenClaw QQ 插件卸载脚本
# ============================================
#
# 使用方法:
#   ./uninstall.sh
#   sudo ./uninstall.sh  (需要 root 权限)
#
# 功能:
#   - 自动检测 OpenClaw 安装位置
#   - 停止网关服务
#   - 删除插件目录
#   - 清理配置文件
#   - 备份数据
#
# 系统支持: Linux, macOS
#
# ============================================

# 颜色定义（用于终端输出）
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 日志函数
log() {
    echo -e "${BLUE}[*]${NC} $1"
}

success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

error() {
    echo -e "${RED}[✗]${NC} $1"
}

# 检查 root 权限
check_root() {
    if [ "$EUID" -ne 0 ]; then
        warn "建议使用 sudo 运行以获得完整权限"
        return 1
    fi
    return 0
}

# 搜索插件目录
find_ext_dir() {
    log "正在搜索 OpenClaw 插件目录..."

    local ext_dir=""

    # 优先检查已知标准路径
    local known_paths=(
        "/usr/lib/node_modules/openclaw/dist/extensions/napcat"
        "/usr/local/lib/node_modules/openclaw/dist/extensions/napcat"
    )
    for p in "${known_paths[@]}"; do
        if [ -d "$p" ]; then
            ext_dir="$p"
        fi
    done

    # 再用 find 广搜
    if [ -z "$ext_dir" ]; then
        ext_dir=$(find /usr /home /opt /var -type d -path "*/node_modules/openclaw/dist/extensions/napcat" 2>/dev/null | head -n 1)
    fi

    # 如果没找到，尝试用 which 定位
    if [ -z "$ext_dir" ]; then
        if OPENCLAW_BIN=$(which openclaw 2>/dev/null); then
            OPENCLAW_DIR=$(dirname "$(dirname "$OPENCLAW_BIN")")/lib/node_modules/openclaw
            if [ -d "$OPENCLAW_DIR/dist/extensions/napcat" ]; then
                ext_dir="$OPENCLAW_DIR/dist/extensions/napcat"
            fi
        fi
    fi

    # 检查用户目录
    if [ -z "$ext_dir" ] && [ -d "$HOME/.openclaw/dist/extensions/napcat" ]; then
        ext_dir="$HOME/.openclaw/dist/extensions/napcat"
    fi

    echo "$ext_dir"
}

# 搜索配置文件
find_config() {
    log "正在搜索 OpenClaw 配置文件..."

    local config=""

    # 常见配置文件位置
    local config_paths=(
        "$HOME/.openclaw/openclaw.json"
        "/etc/openclaw/openclaw.json"
        "/usr/local/etc/openclaw/openclaw.json"
        "/opt/openclaw/openclaw.json"
    )

    for path in "${config_paths[@]}"; do
        if [ -f "$path" ]; then
            config="$path"
            break
        fi
    done

    echo "$config"
}

# 停止网关服务
stop_service() {
    log "正在停止 OpenClaw 网关..."

    # 尝试 systemctl
    if command -v systemctl &> /dev/null; then
        sudo systemctl stop openclaw 2>/dev/null || true
        sudo systemctl stop openclaw-gateway 2>/dev/null || true
    fi

    # 尝试 service 命令
    if command -v service &> /dev/null; then
        sudo service openclaw stop 2>/dev/null || true
    fi

    # 杀死进程
    sudo pkill -f openclaw 2>/dev/null || true
    sudo pkill -f "openclaw-gateway" 2>/dev/null || true

    # macOS specific
    if command -v launchctl &> /dev/null; then
        sudo launchctl unload /Library/LaunchDaemons/com.openclaw.plist 2>/dev/null || true
    fi

    success "网关已停止"
}

# 备份配置文件
backup_config() {
    local config="$1"
    if [ -f "$config" ]; then
        local backup="${config}.backup.$(date +%Y%m%d_%H%M%S)"
        log "备份配置文件到: $backup"
        cp "$config" "$backup"
        success "配置已备份"
    fi
}

# 清理配置文件
clean_config() {
    local config="$1"
    if [ -f "$config" ]; then
        log "清理配置文件..."

        # 使用 jq 清理 JSON（如果可用）
        if command -v jq &> /dev/null; then
            if jq 'del(.plugins.entries.napcat) | del(.channels.napcat)' "$config" > "${config}.tmp" 2>/dev/null; then
                mv "${config}.tmp" "$config"
                success "配置清理完成"
                return 0
            fi
        fi

        # 回退方案：手动清理
        warn "jq 不可用，使用文本清理..."
        backup_config "$config"

        # 简单删除 napcat 相关行（可能有残留）
        if grep -q '"napcat"' "$config" 2>/dev/null; then
            grep -v '"napcat"' "$config" > "${config}.tmp" 2>/dev/null || true
            mv "${config}.tmp" "$config" 2>/dev/null || true
            warn "配置已进行基础清理，请手动检查"
        fi
    fi
}

# 删除插件目录
remove_ext_dir() {
    local ext_dir="$1"
    if [ -d "$ext_dir" ]; then
        log "正在删除插件目录: $ext_dir"
        sudo rm -rf "$ext_dir"
        success "插件目录已删除"
    else
        warn "插件目录不存在，跳过删除"
    fi
}

# 清理数据文件
clean_data() {
    log "清理插件数据文件..."

    # 数据目录
    local data_dir="$HOME/.openclaw/data/napcat"
    if [ -d "$data_dir" ]; then
        sudo rm -rf "$data_dir"
        success "已删除数据目录"
    fi

    # 日志文件
    local log_files=$(find "$HOME/.openclaw/logs" -name "napcat-*.log" 2>/dev/null || true)
    if [ -n "$log_files" ]; then
        sudo rm -f $log_files
        success "已删除日志文件"
    fi
}

# 验证卸载
verify_uninstall() {
    local ext_dir="$1"
    local config="$2"

    log "验证卸载结果..."

    if [ -d "$ext_dir" ]; then
        error "插件目录仍然存在！"
        return 1
    else
        success "插件目录已删除"
    fi

    if [ -f "$config" ] && grep -q '"napcat"' "$config" 2>/dev/null; then
        warn "配置文件中可能仍有 napcat 相关配置，请手动检查"
    else
        success "配置文件中无 qq 引用"
    fi

    return 0
}

# 确认卸载
confirm_uninstall() {
    echo ""
    warn "即将执行以下操作："
    warn "  1. 停止 OpenClaw 网关服务（如正在运行）"
    warn "  2. 删除插件目录: $EXT_DIR"
    warn "  3. 清理配置文件: $CONFIG"
    echo ""
    read -p "确认卸载？(输入 YES 继续): " confirm
    if [ "$confirm" != "YES" ]; then
        log "已取消卸载"
        exit 0
    fi
}

# 主函数
main() {
    echo "=== OpenClaw NapCat 插件卸载工具 ==="
    echo ""

    check_root

    # 查找插件目录
    EXT_DIR=$(find_ext_dir)
    if [ -z "$EXT_DIR" ] || [ ! -d "$EXT_DIR" ]; then
        warn "未自动检测到插件目录"
        read -p "请输入插件完整路径 (直接回车取消): " EXT_DIR
        if [ -z "$EXT_DIR" ]; then
            error "未提供插件目录，退出"
            exit 1
        fi
    fi
    success "找到插件目录: $EXT_DIR"

    # 查找配置文件
    CONFIG=$(find_config)
    if [ -z "$CONFIG" ]; then
        warn "未自动检测到配置文件，将跳过配置清理"
    else
        success "找到配置文件: $CONFIG"
    fi

    # 确认卸载
    confirm_uninstall

    # 执行卸载步骤
    stop_service
    clean_config "$CONFIG"
    remove_ext_dir "$EXT_DIR"
    clean_data

    # 验证
    echo ""
    verify_uninstall "$EXT_DIR" "$CONFIG"

    # 完成
    echo ""
    success "NapCat 插件已成功卸载"
    echo ""
    echo "已执行的操作："
    echo "  1. 停止 OpenClaw 网关服务"
    echo "  2. 删除插件目录: $EXT_DIR"
    echo "  3. 清理配置文件: $CONFIG"
    echo ""
    echo "下一步："
    echo "  - 重启 OpenClaw 网关（如需）"
    echo "  - 如需重新安装，请运行 install.sh"
}

main "$@"
