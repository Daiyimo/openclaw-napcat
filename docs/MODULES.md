# 核心模块职责

> 完整源码结构请参考 [ARCHITECTURE_VISUAL.md](./ARCHITECTURE_VISUAL.md)

## 模块一览

| 文件 | 职责 | 关键功能 |
|------|------|---------|
| `src/index.ts` | 插件入口 | 向 OpenClaw 注册插件 & 频道，导出公共 API |
| `src/channel.ts` | 核心业务层（~900行） | 消息收发、管理命令、表情回应、历史上下文、STT、多媒体处理、Markdown 处理等 |
| `src/client.ts` | 通信协议层 | 封装 OneBot v11 的 WebSocket（正向+反向）和 HTTP API，心跳检测，消息路由 |
| `src/config.ts` | 配置定义 | 用 Zod 定义 35+ 配置项的 Schema 和类型，含范围校验 |
| `src/types.ts` | 类型定义 | OneBot 消息段（24种类型）和事件类型 |
| `src/runtime.ts` | 运行时桥接 | 在插件和 OpenClaw Runtime 之间传递引用 |
| `src/proactive.ts` | 主动消息模块 | 支持单发、批量发送、广播已知用户 |
| `src/known-users.ts` | 用户管理 | 记录交互用户、JSON 持久化、节流写入、查询统计 |
| `src/member-cache.ts` | 群成员缓存 | 群昵称懒加载缓存，防止并发重复拉取 |
| `src/message-parser.ts` | 消息解析 | CQ码清理、图片提取、目标解析、Markdown 处理等纯函数 |
| `src/admin-commands.ts` | 管理命令 | `/ping` `/version` `/logs` `/status` `/help` `/mute` `/kick` |
| `src/log-buffer.ts` | 日志缓冲 | 环形缓冲区拦截 console 输出，支持 `/logs` 命令导出 |
| `src/deliver-debounce.ts` | 消息防抖 | 将 AI 连续输出合并为一条消息发送 |
| `src/update-checker.ts` | 版本检查 | 启动时查询 npm 最新版本，支持 `/version` 展示 |
| `src/typing-keepalive.ts` | Typing 状态 | 私聊 AI 处理期间维持输入中状态 |
| `src/upload-cache.ts` | 上传缓存 | 相同文件 30 分钟内跳过重复上传 |
| `src/ref-index-store.ts` | 引用索引 | JSONL 持久化引用消息索引，TTL 7 天自动清理 |

## utils/ 子目录

| 文件 | 职责 |
|------|------|
| `src/utils/audio-convert.ts` | Silk→WAV 转换 |
| `src/utils/pkg-version.ts` | 读取插件版本号 |
| `src/utils/platform.ts` | 平台路径工具 |
