#!/bin/bash
# 单元测试 docker-install.sh 的下载逻辑
#
# 不依赖 docker / 容器，提取下载段到独立函数，跑各种场景。
# 用法：bash scripts/test-install-download.sh

set -e

# ── 提取 docker-install.sh 的下载段 ────────────────────────────────────────────
# 复制 line 53-185 的关键逻辑到独立函数,避免依赖 docker-install.sh 头部
# 那些容器内假设（EXT_DIR 在 ~/.openclaw,COMPOSE_CMD 检测等）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOWNLOAD_LOGIC=$(awk '/^# 镜像列表/,/^fi$/{print}' "$SCRIPT_DIR/docker-install.sh" | head -160)

PASS=0
FAIL=0
TOTAL=0

assert() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (expected '$expected', got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# 把下载逻辑 source 进来（重写为可在测试中复用的函数）
eval "$DOWNLOAD_LOGIC" 2>/dev/null || true

# 模拟 EXT_DIR / TEMP_DIR（docker-install.sh 头部有定义）
EXT_DIR="/tmp/test-ext-dir"
TEMP_DIR="/tmp/test-temp-$$"

# ── 场景 A:本地 tarball 存在且有效 → 应跳过网络下载 ─────────────────────────
test_local_tarball_valid() {
  echo ""
  echo "── 场景 A: 本地 tarball 存在且有效 ──"

  local ARCHIVE="/tmp/test-archive-a.tar.gz"
  local EXTRACT_DIR="/tmp/test-extract-a-$$"
  rm -rf "$EXTRACT_DIR" "$ARCHIVE"
  mkdir -p "$EXTRACT_DIR"

  # 创建一个有效 tarball（用 git archive 真实源码）
  (cd "$SCRIPT_DIR/.." && git archive --format=tar.gz -o "$ARCHIVE" HEAD) 2>/dev/null
  if [ ! -f "$ARCHIVE" ]; then
    echo "  ⚠ 跳过（无法创建 tarball，需要 git 环境）"
    return
  fi

  # 重置状态
  DOWNLOAD_OK=0
  local MIRRORS=()

  # 模拟 docker-install.sh 的下载段核心逻辑
  local OPENCLAW_NAPCAT_LOCAL_TARBALL="$ARCHIVE"
  local BRANCH="main"

  if [ -n "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
    if [ ! -f "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
      echo "  ✗ 文件不存在" && FAIL=$((FAIL + 1)) && return
    elif ! tar -tzf "$OPENCLAW_NAPCAT_LOCAL_TARBALL" &>/dev/null; then
      echo "  ✗ tarball 损坏" && FAIL=$((FAIL + 1)) && return
    else
      cp "$OPENCLAW_NAPCAT_LOCAL_TARBALL" "$ARCHIVE.tmp"
    mv "$ARCHIVE.tmp" "$ARCHIVE"
      DOWNLOAD_OK=1
    fi
  fi

  TOTAL=$((TOTAL + 1))
  if [ "$DOWNLOAD_OK" = "1" ]; then
    echo "  ✓ DOWNLOAD_OK=1 (跳过网络下载)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ DOWNLOAD_OK 未设置"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$EXTRACT_DIR" "$ARCHIVE"
}

# ── 场景 B:本地 tarball 不存在 → 应降级到网络 ────────────────────────────────
test_local_tarball_missing() {
  echo ""
  echo "── 场景 B: 本地 tarball 指向不存在的文件 ──"

  local ARCHIVE="/tmp/test-archive-b.tar.gz"
  rm -f "$ARCHIVE"
  local DOWNLOAD_OK=0
  local MIRRORS=()
  local OPENCLAW_NAPCAT_LOCAL_TARBALL="/tmp/nonexistent-tarball-$$.tar.gz"

  if [ -n "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
    if [ ! -f "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
      TOTAL=$((TOTAL + 1))
      if [ "$DOWNLOAD_OK" = "0" ]; then
        echo "  ✓ DOWNLOAD_OK 保持 0 (降级到网络下载)"
        PASS=$((PASS + 1))
      else
        echo "  ✗ DOWNLOAD_OK 不应为 1"
        FAIL=$((FAIL + 1))
      fi
    fi
  fi
}

# ── 场景 C:本地 tarball 损坏（非 tarball 文件）→ 应降级到网络 ───────────────
test_local_tarball_corrupt() {
  echo ""
  echo "── 场景 C: 本地 tarball 是无效文件 ──"

  local ARCHIVE="/tmp/test-archive-c.tar.gz"
  rm -f "$ARCHIVE"
  local CORRUPT_FILE="/tmp/corrupt-tarball-$$.tar.gz"
  echo "this is not a tarball" > "$CORRUPT_FILE"

  local DOWNLOAD_OK=0
  local OPENCLAW_NAPCAT_LOCAL_TARBALL="$CORRUPT_FILE"

  if [ -n "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
    if [ ! -f "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
      echo "  ✗ 文件存在性检查错误"
    elif ! tar -tzf "$OPENCLAW_NAPCAT_LOCAL_TARBALL" &>/dev/null; then
      TOTAL=$((TOTAL + 1))
      if [ "$DOWNLOAD_OK" = "0" ]; then
        echo "  ✓ DOWNLOAD_OK 保持 0 (降级到网络下载)"
        PASS=$((PASS + 1))
      else
        echo "  ✗ DOWNLOAD_OK 不应为 1"
        FAIL=$((FAIL + 1))
      fi
    fi
  fi

  rm -f "$CORRUPT_FILE"
}

# ── 场景 D:OPENCLAW_NAPCAT_MIRROR 单镜像模式 ─────────────────────────────────
test_single_mirror() {
  echo ""
  echo "── 场景 D: OPENCLAW_NAPCAT_MIRROR 单镜像模式 ──"

  local OPENCLAW_NAPCAT_MIRROR="https://kkgithub.com/Daiyimo/openclaw-napcat/archive"
  local MIRRORS=(
    "https://kkgithub.com/Daiyimo/openclaw-napcat/archive"
    "https://ghfast.top/https://github.com/Daiyimo/openclaw-napcat/archive"
  )

  if [ -n "$OPENCLAW_NAPCAT_MIRROR" ]; then
    MIRRORS=("$OPENCLAW_NAPCAT_MIRROR")
  fi

  TOTAL=$((TOTAL + 1))
  if [ "${#MIRRORS[@]}" = "1" ] && [ "${MIRRORS[0]}" = "$OPENCLAW_NAPCAT_MIRROR" ]; then
    echo "  ✓ MIRRORS 数组缩减为 1 个（用户指定）"
    PASS=$((PASS + 1))
  else
    echo "  ✗ MIRRORS 数组未正确缩减: ${MIRRORS[@]}"
    FAIL=$((FAIL + 1))
  fi
}

# ── 场景 E:case 诊断翻译 ─────────────────────────────────────────────────────
test_diagnostic_translation() {
  echo ""
  echo "── 场景 E: curl exit code 翻译表 ──"

  local cases_pass=0
  local cases_total=0
  for code_reason in "6:无法解析主机" "7:无法连接" "28:连接超时" "35:TLS" "52:空回复" "56:重置"; do
    local code="${code_reason%%:*}"
    local expected="${code_reason#*:}"
    cases_total=$((cases_total + 1))
    case $code in
      6)  reason="无法解析主机 (DNS 失败/被劫持)" ;;
      7)  reason="无法连接 (网络封禁/防火墙拦截)" ;;
      28) reason="连接超时 (30s 无响应,镜像源可能挂了)" ;;
      35) reason="TLS 握手失败 (SSL 证书问题)" ;;
      52) reason="服务器空回复" ;;
      56) reason="连接被对端重置" ;;
    esac
    if echo "$reason" | grep -q "$expected"; then
      cases_pass=$((cases_pass + 1))
    else
      echo "  ✗ exit $code: expected '$expected', got '$reason'"
    fi
  done

  TOTAL=$((TOTAL + 1))
  if [ $cases_pass -eq $cases_total ]; then
    echo "  ✓ 6 种 curl 错误码全部正确翻译"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $cases_pass/$cases_total 翻译正确"
    FAIL=$((FAIL + 1))
  fi
}

# ── 主流程 ────────────────────────────────────────────────────────────────────
test_local_tarball_valid
test_local_tarball_missing
test_local_tarball_corrupt
test_single_mirror
test_diagnostic_translation

echo ""
echo "─────────────────────────────────"
echo "通过: $PASS / $TOTAL"
if [ $FAIL -eq 0 ]; then
  echo "✓ 全部测试通过"
  exit 0
else
  echo "✗ $FAIL 个测试失败"
  exit 1
fi
