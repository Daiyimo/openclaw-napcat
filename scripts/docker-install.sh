#!/bin/bash
# openclaw-napcat QQ 插件安装脚本
#
# ┌──────────────────────────────────────────────────────────────────────┐
# │ 在 openclaw 容器终端内执行（按推荐顺序）:                               │
# │                                                                      │
# │ # 1. 在线安装(最常用,网络可达时):                                     │
# │ curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
# │                                                                      │
# │ # 2. 国内/受限网络:走 gh-proxy.com 拉脚本本身(避免 raw 域名被墙):       │
# │ curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/docker-install.sh | bash
# │                                                                      │
# │ # 3. 强制指定单一镜像(已知在环境里能用的):                             │
# │ export OPENCLAW_NAPCAT_MIRROR=https://ghfast.top/https://github.com/Daiyimo/openclaw-napcat/archive
# │ curl -fsSL ... | bash                                                │
# │                                                                      │
# │ # 4. 完全离线(★ NAS/严格内网/镜像全挂时的唯一可靠方案):                │
# │ #    宿主机:                                                          │
# │ #      curl -fsSL https://github.com/Daiyimo/openclaw-napcat/archive/refs/heads/main.tar.gz -o /tmp/oc.tar.gz
# │ #      docker cp /tmp/oc.tar.gz <container>:/tmp/oc.tar.gz             │
# │ #    容器内:                                                          │
# │ #      export OPENCLAW_NAPCAT_LOCAL_TARBALL=/tmp/oc.tar.gz             │
# │ #      bash /tmp/docker-install.sh                                    │
# └──────────────────────────────────────────────────────────────────────┘
#
# 特性：
#   - 插件安装到持久化数据卷 ~/.openclaw/extensions/napcat/，容器镜像更新后不丢失
#   - 自动编译 TypeScript，无需宿主机任何工具链
#   - 读取容器内 QQ_* 环境变量写入 openclaw.json
#   - 多镜像加速下载（6 个镜像按稳定性优先级,单镜像 30s 超时）
#   - ★ 本地 tarball 离线兜底（见上方 #4，2026-06-02 强化后作为受限网络推荐方案）
#   - 自动静默重启容器
#   - 自动刷新群路由（重启后 connect handler 自动注册）

set -e

BRANCH="${OPENCLAW_NAPCAT_BRANCH:-main}"
EXT_DIR="${HOME:-/home/node}/.openclaw/extensions/napcat"
TEMP_DIR="/tmp/openclaw-napcat-install-$$"
# 检测运行方式：docker-compose 还是 docker run
COMPOSE_FILE=""
if [ -f "docker-compose.yml" ] || [ -f "compose.yml" ]; then
  COMPOSE_CMD="docker compose"
elif [ -n "$(docker ps --filter "name=openclaw" --format "{{.Names}}" 2>/dev/null)" ]; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD=""
fi

echo "=== OpenClaw NapCat 插件安装 ==="
echo "分支: $BRANCH"
echo "安装目录: $EXT_DIR"
echo ""

# ── 1. 下载源码（多镜像 tarball，不依赖 git）────────────────────────────────────
# 改用 tarball 下载的原因：
#  1. openclaw 容器基础镜像（node:alpine/slim）通常没装 git，`git clone` 静默失败
#  2. tarball 只含源码（~1-2 MB），比 `git clone --depth 1`（拉 git objects）快 5-10x
#  3. curl 显示 HTTP 状态码，失败时用户能立即看到原因
#  4. 任何 Linux 基础镜像都自带 tar + curl
echo "[1/4] 正在下载源码（tarball 模式，无需 git）..."

ARCHIVE="/tmp/openclaw-napcat-${BRANCH}.tar.gz"
EXTRACT_DIR="/tmp/openclaw-napcat-extract-$$"
rm -rf "$TEMP_DIR" "$EXTRACT_DIR" "$ARCHIVE"
mkdir -p "$EXTRACT_DIR"

# 镜像列表：按优先级尝试（GitHub archive 直链）
# 顺序按"国内可用度 + 稳定性"排。ghfast/gh-proxy 经常挂,补多镜像兜底。
# 2026-06-02:移除 kkgithub(部分容器环境不可达,排首位导致脚本卡 60s)
# 用户可通过 OPENCLAW_NAPCAT_MIRROR 环境变量强制指定单个镜像（跳过列表）。
MIRRORS=(
  "https://ghfast.top/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://mirror.ghproxy.com/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://github.com/Daiyimo/openclaw-napcat/archive"
  # 新增 2 个常见代理作为最后兜底,只走 30s 超时,挂了不影响主流程
  "https://ghproxy.cn/https://github.com/Daiyimo/openclaw-napcat/archive"
  "https://gh-proxy.net/https://github.com/Daiyimo/openclaw-napcat/archive"
)

DOWNLOAD_OK=0
# 如果用户指定了单一镜像,优先用它
if [ -n "$OPENCLAW_NAPCAT_MIRROR" ]; then
  MIRRORS=("$OPENCLAW_NAPCAT_MIRROR")
fi

# ── 兜底 1:本地 tarball(NAS/受限网络环境必备)──────────────────────────────
# 适用场景:用户从能访问 GitHub 的环境下载 tarball 后 scp 进来。
# 用法(在容器内运行前):
#   docker cp /path/to/openclaw-napcat-main.tar.gz <container>:/tmp/oc.tar.gz
#   export OPENCLAW_NAPCAT_LOCAL_TARBALL=/tmp/oc.tar.gz
#   bash scripts/docker-install.sh
# 优先级高于网络下载——检测到本地 tarball 直接走离线安装。
#
# ★★★ DO NOT REMOVE / DO NOT SIMPLIFY ★★★
# 2026-06-02 用户实测:6 个公开 GitHub 镜像在他那环境(跨区域部署容器)
# 全部不可达,只走本地 tarball 这一条路径才能完成安装。
# 关联:commit 9004030 + 1fd9a6a;若删除此段,他/类似环境的用户将
# 完全无法安装。请保留 OPENCLAW_NAPCAT_LOCAL_TARBALL 入口并在镜像
# 列表变更时同步测试 scripts/test-install-download.sh 场景 A/F。
if [ -n "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
  echo "  本地 tarball 模式: $OPENCLAW_NAPCAT_LOCAL_TARBALL"
  if [ ! -f "$OPENCLAW_NAPCAT_LOCAL_TARBALL" ]; then
    echo "  ✗ 文件不存在,降级到网络下载"
  elif ! tar -tzf "$OPENCLAW_NAPCAT_LOCAL_TARBALL" &>/dev/null; then
    echo "  ✗ 不是有效 tarball(可能下载到 HTML 错误页),降级到网络下载"
  else
    cp "$OPENCLAW_NAPCAT_LOCAL_TARBALL" "$ARCHIVE"
    size=$(du -h "$ARCHIVE" | cut -f1)
    echo "  ✓ 本地 tarball 验证通过 (${size}),跳过网络下载"
    DOWNLOAD_OK=1
  fi
fi

# ── 兜底 2:网络下载(带详细错误诊断 + 单镜像重试)─────────────────────────
# curl exit code 含义:
#   6  = 无法解析主机 (DNS 失败/被劫持)
#   7  = 无法连接 (网络封禁/防火墙拦截)
#   28 = 连接超时 (30s 无响应,镜像源可能挂了)
#   35 = TLS 握手失败 (SSL 证书问题)
#   52 = 服务器空回复
#   56 = 连接被对端重置
if [ "$DOWNLOAD_OK" -ne 1 ]; then
  for mirror in "${MIRRORS[@]}"; do
    url="${mirror}/refs/heads/${BRANCH}.tar.gz"
    echo "  尝试: $url"

    # 单镜像最多重试 2 次(第 1 次失败后等 2s 重试,应对网络抖动)
    attempt=1
    while [ $attempt -le 2 ]; do
      # 不加 -f,让 HTTP 错误也能下载到文件然后被 tar 验证捕获
      # (避免某些镜像把 404 响应降级为 200 页面导致误判)
      curl_err=$(curl -L --connect-timeout 3 --max-time 30 -# -o "$ARCHIVE" "$url" 2>&1)
      curl_exit=$?

      if [ $curl_exit -eq 0 ]; then
        if tar -tzf "$ARCHIVE" &>/dev/null; then
          size=$(du -h "$ARCHIVE" | cut -f1)
          echo "  ✓ 下载成功 (${size})"
          DOWNLOAD_OK=1
          break 2  # 跳出 for + while 双层循环
        else
          echo "  ✗ tarball 损坏（可能是 HTML 错误页），换下一个镜像"
          rm -f "$ARCHIVE"
          break  # 损坏不重试,直接换镜像(重试也没用)
        fi
      fi

      # 失败诊断:把 curl exit code 翻译成可读消息
      case $curl_exit in
        6)  reason="无法解析主机 (DNS 失败/被劫持)" ;;
        7)  reason="无法连接 (网络封禁/防火墙拦截)" ;;
        28) reason="连接超时 (30s 无响应,镜像源可能挂了)" ;;
        35) reason="TLS 握手失败 (SSL 证书问题)" ;;
        52) reason="服务器空回复" ;;
        56) reason="连接被对端重置" ;;
        *)  reason="curl 错误 (exit=$curl_exit)" ;;
      esac
      echo "  ✗ 第 ${attempt} 次: ${reason}"

      if [ $attempt -eq 1 ]; then
        echo "    等待 2s 后重试..."
        sleep 2
      fi
      attempt=$((attempt + 1))
    done
  done
fi

if [ "$DOWNLOAD_OK" -ne 1 ]; then
  echo ""
  echo "✗ 所有镜像均失败"
  echo ""
  echo "可能原因:"
  echo "  1. 网络环境完全无法访问 GitHub 镜像（NAS/公司内网常见）"
  echo "  2. DNS 被劫持或屏蔽（试试 nslookup github.com）"
  echo "  3. 防火墙拦截 outbound HTTPS（试试 curl -v https://baidu.com）"
  echo ""
  echo "解决方案（按推荐度排序）:"
  echo ""
  echo "  a) 本地 tarball 兜底（推荐,适合 NAS/受限网络）:"
  echo "     # 在能访问 GitHub 的机器上下载:"
  echo "     curl -fsSL https://github.com/Daiyimo/openclaw-napcat/archive/refs/heads/main.tar.gz -o /tmp/oc.tar.gz"
  echo "     # 复制到容器内:"
  echo "     docker cp /tmp/oc.tar.gz <container>:/tmp/oc.tar.gz"
  echo "     # 重新运行,指定本地 tarball:"
  echo "     export OPENCLAW_NAPCAT_LOCAL_TARBALL=/tmp/oc.tar.gz"
  echo "     bash scripts/docker-install.sh"
  echo ""
  echo "  b) 指定单一镜像（已知在你的环境能用的）:"
  echo "     export OPENCLAW_NAPCAT_MIRROR=https://kkgithub.com/Daiyimo/openclaw-napcat/archive"
  echo ""
  echo "  c) 在宿主机/路由器配置代理或 hosts 解析"
  exit 1
fi

# 解压到临时目录（GitHub archive 根目录是 openclaw-napcat-<branch>/）
if ! tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"; then
  echo "✗ 解压失败"
  exit 1
fi
rm -f "$ARCHIVE"
# -mindepth 1 跳过搜索根自身：EXTRACT_DIR 名为 openclaw-napcat-extract-<pid>，
# 模式 openclaw-napcat-* 会把它本身当匹配项，导致 head -1 拿到父目录而非子目录
TEMP_DIR=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -name "openclaw-napcat-*" | head -1)
if [ -z "$TEMP_DIR" ]; then
  echo "✗ 解压后未找到源码目录"
  exit 1
fi
# 回归保护：find 自匹配 bug 不应再出现
if [ "$TEMP_DIR" = "$EXTRACT_DIR" ]; then
  echo "✗ 内部错误：find 返回了 EXTRACT_DIR 自身，请报告此 bug"
  exit 1
fi

cd "$TEMP_DIR"

# ── 2. 安装依赖并编译 TypeScript ──────────────────────────────────────────────
echo ""
echo "[2/4] 安装依赖并编译（约 60 秒）..."

npm install --registry=https://registry.npmmirror.com 2>/dev/null || npm install
npm run build
npm prune --omit=dev

echo "✓ 编译完成"

# ── 3. 安装到持久化扩展目录 ───────────────────────────────────────────────────
echo ""
echo "[3/4] 安装到 $EXT_DIR ..."

rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR/docker"

cp -r dist node_modules package.json openclaw.plugin.json "$EXT_DIR/"
cp docker/setup-config.cjs "$EXT_DIR/docker/"

# 验证核心文件
if [ ! -f "$EXT_DIR/dist/src/index.js" ]; then
  echo "✗ 安装失败：dist/src/index.js 不存在"
  exit 1
fi
if [ ! -d "$EXT_DIR/node_modules" ]; then
  echo "✗ 安装失败：node_modules 不存在，npm install 可能未完成"
  exit 1
fi
if [ ! -f "$EXT_DIR/docker/setup-config.cjs" ]; then
  echo "✗ 安装失败：docker/setup-config.cjs 不存在"
  exit 1
fi

echo "✓ 插件文件已复制"

# ── 4. 写入 NapCat 渠道配置 ────────────────────────────────────────────────────
echo ""
echo "[4/4] 写入 NapCat 渠道配置..."

QQ_FORCE_RECONFIGURE=true node "$EXT_DIR/docker/setup-config.cjs"

echo "✓ 配置写入完成"

# ── 5. 静默重启容器并刷新群路由 ───────────────────────────────────────────────
echo ""
echo "[5/5] 重启 OpenClaw 容器..."

# 查找容器名称
CONTAINER_NAME=$(docker ps --filter "name=openclaw" --format "{{.Names}}" 2>/dev/null | head -n 1)

if [ -n "$CONTAINER_NAME" ] && [ -n "$COMPOSE_CMD" ]; then
  # docker-compose 方式：静默重启
  $COMPOSE_CMD restart openclaw 2>/dev/null || true
  echo "✓ 容器已重启，群路由将在 connect handler 中自动注册"
elif [ -n "$CONTAINER_NAME" ]; then
  # docker run 方式：直接 restart
  docker restart "$CONTAINER_NAME" 2>/dev/null || true
  echo "✓ 容器已重启，群路由将在 connect handler 中自动注册"
else
  echo "⚠ 未检测到运行中的 openclaw 容器，请手动启动："
  echo "   docker compose up -d"
fi

# ── 清理 ─────────────────────────────────────────────────────────────────────
rm -rf "$TEMP_DIR"

echo ""
echo "=== 安装完成 ==="
echo "✓ 插件路径: $EXT_DIR"
echo ""
echo "→ 下一步："
echo "   1. 执行 openclaw onboard 进行初始化配置（AI 模型、账号等）"
echo "   2. 配置完成后执行 openclaw gateway 拉起服务"
echo "      观察日志中是否出现以下内容："
echo "        [napcat-QQ] Reverse WebSocket server listening on port 3002"
echo "        [napcat-QQ] Reverse WS: NapCat connected"
echo "      若 NapCat 尚未启动，请先启动 NapCat，等待约 1 分钟自动连上"
echo ""
echo "提示：如需更新插件，重新运行此脚本即可。"
