# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`@openclaw/qq`（版本 1.7.0）是一个 **OpenClaw 频道插件**，通过 OneBot v11 协议（WebSocket + HTTP）将 QQ（NapCat）接入 OpenClaw AI 框架。TypeScript 编写，编译为 ESM。

## 常用命令

```bash
# 构建
pnpm build          # tsc --project tsconfig.json，产物输出到 dist/

# 测试
pnpm test           # vitest run（单次，--passWithNoTests）
pnpm run test:watch # vitest watch 模式
pnpm run test:coverage  # 覆盖率报告

# 运行单个测试文件
pnpm vitest run src/__tests__/config.test.ts
```

> 包管理器使用 `pnpm`（项目 FAQ 和安装脚本均基于 pnpm）。

## 架构

### 双层分工

| 层 | 文件 | 职责 |
|---|---|---|
| 通信协议层 | `src/client.ts` | `OneBotClient`：封装正向 WS / 反向 WS Server / HTTP API，心跳检测，request-response 绑定 |
| 核心业务层 | `src/channel.ts` | `qqChannel`：消息处理完整流水线、AI 调度、多媒体、群管、频控 |
| 插件入口 | `src/index.ts` | 向 OpenClaw 注册 `qqChannel`，导出 `proactive` / `known-users` 公共 API |

### 通信优先级

发送消息时：优先 HTTP API → 失败回退 WebSocket（正向/反向均可）。接收消息只走 WebSocket 事件。

### 消息处理流水线（`channel.ts startAccount`）

```
NapCat 事件
  1. 元事件 / 好友入群请求自动审批
  2. 戳一戳 → 合成文本消息事件
  3. 自身消息过滤 + 消息去重（Set，上限 2000）
  4. 消息段解析（text/at/record(STT)/image/video/json/forward/file）
  5. 黑名单 / 群组白名单检查
  6. 管理员命令处理（/ping /version /logs /status /help /mute /kick）
  7. 历史上下文拉取（get_group_msg_history）
  8. 触发检测（@提及 / 关键词 / 回复机器人）
  9. 记录消息到引用索引（ref-index-store）
  10. 入站频控 + 静默关键词过滤（inboundRateLimitMs / silentKeywords）
  11. 智能表情回应（setMsgEmojiLike，关键词匹配）
  12. 构建 ctxPayload → recordInboundSession
  13. 启动 TypingKeepAlive
  14. dispatchReplyFromConfig（OpenClaw AI 推理）
  15. deliver（含 DeliverDebouncer 合并防抖）
```

### OpenClaw SDK 类型声明

`src/openclaw-plugin-sdk.d.ts` 是**手动维护**的 `openclaw/plugin-sdk` 类型存根（peer dependency 无源码）。每次对齐新版 OpenClaw 时需同步更新，当前对齐版本 **2026.3.31**。注意文件顶部的版本注释。

### 关键设计约束

- `deliveryMode: "direct"` — 插件绕过 OpenClaw 发送队列直接发消息。
- `registrationMode` 检查（`index.ts`）— `setup-only` / `cli-metadata` 模式下不初始化 runtime 单例，避免副作用。
- `hooks.beforeDispatch` 已在 3.31 移除 — 频控和静默关键词过滤内联在 `startAccount` 中，不在 `ChannelPlugin.hooks` 里。

### 数据持久化

| 数据 | 路径 | 格式 |
|---|---|---|
| 引用消息索引 | `~/.openclaw/napcat-qq/data/ref-index.jsonl` | JSONL，TTL 7 天，超 2× 活跃条数自动 compact |
| 已知用户 | `~/.openclaw/napcat-qq/known-users.json` | JSON，节流写入 |

## 辅助模块速查

| 模块 | 职责要点 |
|---|---|
| `config.ts` | Zod Schema，35+ 配置项，含范围约束（参见 `QQConfigSchema`） |
| `message-parser.ts` | 纯函数集：CQ码清理、图片提取、目标解析、Markdown 处理、反风控 |
| `deliver-debounce.ts` | `DeliverDebouncer`：滑动窗口（windowMs）+ 强制刷新（maxWaitMs）合并碎片消息 |
| `log-buffer.ts` | 拦截 `console.*` 输出到环形缓冲区，支持 `/logs` 命令导出 |
| `ref-index-store.ts` | 引用消息本地 JSONL 索引，`lookupRef` 先查本地再调 `getMsg` API |
| `upload-cache.ts` | 文件上传去重缓存（30 分钟 TTL），同 URL 避免重复上传 |
| `proactive.ts` | 主动消息：单发、批量发、广播已知用户 |
| `admin-commands.ts` | `/ping /version /logs /status /help /mute /kick` 处理逻辑 |
| `typing-keepalive.ts` | AI 处理期间周期性发 typing 状态，`stop()` 必须在 finally 中调用 |

## 测试规范

测试位于 `src/__tests__/`，均为纯单元测试（无网络/IO）。覆盖：`config`、`deliver-debounce`、`admin-commands`、`message-parser`。

`deliver-debounce.test.ts` 使用 `vi.useFakeTimers()`；测试前 `beforeEach` 启用假时钟，`afterEach` 恢复。新增定时器相关测试必须遵循此模式。

## 配置字段默认值（重要）

以下字段有非空默认值，修改 Schema 时注意：

| 字段 | 默认值 |
|---|---|
| `requireMention` | `true` |
| `enableDeduplication` | `true` |
| `maxMessageLength` | `4000` |
| `historyLimit` | `5` |
| `rateLimitMs` | `1000` |
| `markdownMode` | `"passthrough"` |
| `logBufferSize` | `200` |
| `inboundRateLimitMs` | `0`（禁用） |
| `enableReactions` | `true` |
| `deliverDebounce.windowMs` | `1500` |
| `deliverDebounce.maxWaitMs` | `8000` |
