#!/bin/bash
# OpenClaw QQ 插件卸载脚本 - 快速参考
# ============================================
#
# 使用方法:
#   ./uninstall.sh
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

# 主函数
main() {
    echo "=== OpenClaw QQ 插件卸载工具 ==="
    echo ""

    # 调用核心卸载逻辑
    # （实际脚本包含完整的实现）
}

main "$@"
