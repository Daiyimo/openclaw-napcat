# syntax=docker/dockerfile:1.7
# ============================================================================
# openclaw-napcat Docker 镜像
#
# 构建一个内置 QQ (OneBot v11) 插件的 OpenClaw 镜像。
#
# 用法：
#   docker build -t openclaw-qq .
#   docker build --build-arg OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:3.31 -t openclaw-qq .
#
# 多平台构建：
#   docker buildx build --platform linux/amd64,linux/arm64 -t openclaw-qq .
# ============================================================================

# ── Stage 1: 编译插件 ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS plugin-builder

WORKDIR /build

# 先复制 package.json，利用 Docker 层缓存
COPY package.json package-lock.json* ./

# 安装全部依赖（含 devDependencies，TypeScript 编译需要）
RUN npm ci --ignore-scripts \
    --registry=https://registry.npmmirror.com 2>/dev/null \
    || npm ci --ignore-scripts

# 复制源码并编译
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# 安装纯生产依赖（供运行时使用）
RUN npm ci --omit=dev --ignore-scripts \
    --registry=https://registry.npmmirror.com 2>/dev/null \
    || npm ci --omit=dev --ignore-scripts

# ── Stage 2: 集成到 OpenClaw 镜像 ─────────────────────────────────────────────
# 默认使用官方 openclaw 镜像；可通过 --build-arg 覆盖
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest

FROM ${OPENCLAW_IMAGE}

LABEL org.opencontainers.image.title="OpenClaw + QQ (openclaw-napcat)" \
      org.opencontainers.image.description="OpenClaw gateway with built-in QQ channel plugin via NapCat/OneBot v11" \
      org.opencontainers.image.source="https://github.com/Daiyimo/openclaw-napcat" \
      org.opencontainers.image.licenses="MIT"

# ── 以 root 安装插件 ──────────────────────────────────────────────────────────
USER root

# 将编译产物复制到 openclaw 扩展目录
ENV QQ_PLUGIN_DIR=/app/extensions/napcat
RUN mkdir -p ${QQ_PLUGIN_DIR}

COPY --from=plugin-builder --chown=node:node /build/dist            ${QQ_PLUGIN_DIR}/dist/
COPY --from=plugin-builder --chown=node:node /build/node_modules    ${QQ_PLUGIN_DIR}/node_modules/
COPY --chown=node:node package.json openclaw.plugin.json            ${QQ_PLUGIN_DIR}/

# 复制 Docker 辅助脚本
COPY --chown=node:node docker/setup-config.cjs  ${QQ_PLUGIN_DIR}/docker/setup-config.cjs
COPY docker/entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# ── 切回非 root 用户 ──────────────────────────────────────────────────────────
USER node

# 插件路径注入（告知 openclaw 扫描自定义扩展目录）
ENV OPENCLAW_EXTRA_EXTENSIONS_DIR=/app/extensions

# OpenClaw 网关默认端口
EXPOSE 18789

# 反向 WS 模式监听端口（仅在 QQ_REVERSE_WS_PORT 配置时使用）
EXPOSE 3002

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "openclaw.mjs", "gateway", "--bind", "lan"]
