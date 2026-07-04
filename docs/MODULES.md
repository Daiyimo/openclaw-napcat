# 核心模块职责

> 完整源码结构请参考 [ARCHITECTURE_VISUAL.md](./ARCHITECTURE_VISUAL.md)

## 模块一览

| 文件 | 职责 | 关键功能 |
|------|------|---------|
| `src/index.ts` | 插件入口 | 向 OpenClaw 注册插件 & 频道，导出公共 API |
| `src/channel.ts` | 核心组装层 | 定义 ChannelPlugin 接口实现，连接 gateway/outbound 子模块，管理共享状态 |
| `src/client.ts` | 通信协议层 | 封装 OneBot v11 的 WebSocket（正向+反向）和 HTTP API，心跳检测，请求-响应关联 |
| `src/config.ts` | 配置定义 | Zod Schema 定义 35+ 配置项，含范围校验和默认值 |
| `src/config-watcher.ts` | 配置热更新 | ConfigRef 引用对象 + Zod 验证 + 连接参数变更检测 |
| `src/constants.ts` | 全局常量 | 所有跨文件的魔法数字集中管理，带来源注释 |
| `src/types.ts` | 类型定义 | OneBot 消息段（24 种类型）和事件类型 |
| `src/types/channel-types.ts` | 模块接口 | gateway/outbound 子模块的严格 TypeScript 接口定义 |
| `src/runtime.ts` | 运行时桥接 | 在插件和 OpenClaw Runtime 之间传递引用 |

## gateway/ — 入站消息处理

| 文件 | 职责 | 关键功能 |
|------|------|---------|
| `src/gateway/lifecycle.ts` | 生命周期编排 | startAccount 顶层流程：资源初始化 → handler 安装 → abort 等待 → 清理 |
| `src/gateway/connection.ts` | 连接管理 | WebSocket 连接建立、群路由注册（裸数字 + 带前缀）、定时刷新 |
| `src/gateway/inbound.ts` | 消息流水线 | 消息解析 → 去重 → 过滤 → 触发检测 → 旁观判定 → AI 派发 → 回复投递 |

## outbound/ — 出站消息投递

| 文件 | 职责 | 关键功能 |
|------|------|---------|
| `src/outbound/send-text.ts` | 文本发送 | 目标解析（裸数字/group:/private:）、跨会话 [TO:] 拦截、分片、风控限速 |
| `src/outbound/send-media.ts` | 媒体发送 | 图片/文件/语音投递、消息撤回 |

## 业务模块

| 文件 | 职责 | 关键功能 |
|------|------|---------|
| `src/passive-mode.ts` | 旁观模式 | 状态机（哨兵→冷却→释放），懒释放策略，防止并发派发 |
| `src/message-processor.ts` | 消息处理纯函数 | 文本提取（含转发/引用解析）、@检测、关键词触发、上下文构建 |
| `src/message-sender.ts` | 回复投递 | 分片发送、TTS/AI Voice、Markdown 模式处理、表情回应 |
| `src/message-parser.ts` | 消息解析 | CQ 码清理、图片 URL 提取、目标格式解析、normalizeTarget |
| `src/deliver-debounce.ts` | 消息防抖 | 窗口合并连续文本输出、最大等待强制 flush、失败重试 |
| `src/admin-commands.ts` | 管理命令 | `/ping` `/version` `/logs` `/status` `/help` `/mute` `/kick` `/sendto` `/reload` |
| `src/proactive.ts` | 主动消息 | 单发、批量发送（带间隔）、广播已知用户 |
| `src/known-users.ts` | 用户管理 | 记录交互用户、JSON 持久化、节流写入、查询过滤 |
| `src/member-cache.ts` | 群成员缓存 | 群昵称懒加载缓存，防止并发重复拉取 |
| `src/ref-index-store.ts` | 引用索引 | JSONL 持久化、异步批量写、TTL 7 天、自动 compact |
| `src/log-buffer.ts` | 日志缓冲 | 环形缓冲区拦截 console 输出，支持 `/logs` 导出 |
| `src/update-checker.ts` | 版本检查 | 启动时查询 npm 最新版本，缓存结果 |
| `src/typing-keepalive.ts` | Typing 状态 | AI 处理期间维持"对方正在输入..."指示 |
| `src/upload-cache.ts` | 上传缓存 | 相同文件 30 分钟内跳过重复上传 |

## utils/ 子目录

| 文件 | 职责 |
|------|------|
| `src/utils/retry.ts` | HTTP 指数退避重试（withRetry + HttpApiError + isRetryableError） |
| `src/utils/audio-convert.ts` | Silk → WAV 音频转换 |
| `src/utils/pkg-version.ts` | 读取 package.json 版本号 |
| `src/utils/platform.ts` | 平台相关路径工具（数据目录定位） |

## 测试

| 文件 | 覆盖范围 |
|------|---------|
| `src/__tests__/message-parser.test.ts` | 消息解析纯函数 |
| `src/__tests__/config.test.ts` | Zod Schema 验证 |
| `src/__tests__/deliver-debounce.test.ts` | 防抖合并逻辑（fake timers） |
| `src/__tests__/admin-commands.test.ts` | 管理命令处理（vi.mock） |
| `src/__tests__/passive-mode.test.ts` | 旁观模式状态机 |
| `src/__tests__/message-sender.test.ts` | 投递逻辑 |
| `src/__tests__/message-processor.test.ts` | 文本/触发/上下文 |
| `src/__tests__/ref-index-store.test.ts` | 异步写 + compact |
| `src/__tests__/retry.test.ts` | 指数退避重试 |
| `src/__tests__/config-watcher.test.ts` | 热更新逻辑 |
| `src/__tests__/inbound-pipeline.test.ts` | 入站流水线集成测试（12 场景） |

## 铁律：投递层防御性类型转换

> **来源**：2026-07-04 线上 bug 修复。cron agent / AI 上游将数字类型（如 `207.44`）作为 `text` 字段传递，导致 `TypeError: text?.trim is not a function`，消息发送崩溃。

### 约定

**所有出站入口的 `text` / `payload.text` 必须第一时间归一化为字符串，后续代码不再做类型假设。**

### 固定模式

```typescript
// ❌ 禁止：直接调用 .trim()，假设 text 一定是字符串
const trimmed = text?.trim() ?? "";

// ✅ 正确：先归一化，再 trim
const normalizedText = typeof text === "string" ? text : String(text ?? "");
const trimmed = normalizedText.trim();
```

### 适用位置（三处入口，均已修复）

| 文件 | 入口函数 | 状态 |
|------|---------|------|
| `src/outbound/send-text.ts` | `sendText(params, deps)` — `params.text` | ✅ 已修复 |
| `src/message-sender.ts` | `MessageSender.deliver(payload)` — `payload.text` | ✅ 已修复 |
| `src/deliver-debounce.ts` | `DeliverDebouncer.deliver(payload, info)` — `payload.text` | ✅ 已修复 |

### 新代码检查清单

- [ ] 新增出站入口时，第一行必须做 `typeof text === "string" ? text : String(text ?? "")` 归一化
- [ ] 不得在入口之后任何位置直接调用 `text?.trim()` 或 `text.replace()` 等字符串方法（已归一化的 `normalizedText` 可安全调用）
- [ ] 回归测试需覆盖数字类型 `text`（如 `207.44`）不崩溃的场景
