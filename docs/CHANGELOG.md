[**中文**](README.md)

# 更新日志

### v1.6.1 - 基于 OpenClaw 2026.3.24 (2026-03-27)

#### 修复
- 修复 `CommandAuthorized` 权限逻辑：群聊普通用户不再被标记为已授权，仅管理员和私聊用户可使用框架级指令（`/model`、`/think` 等）

---

### v1.6.0 - 适配 OpenClaw 2026.3.24 (2026-03-26)

适配 OpenClaw 2026.3.22+ 插件架构新特性，全部改动向后兼容。

#### 新增
- 实现 `describeMessageTool()` 接口，Control UI 可正确显示 QQ 频道可用工具
- 新增 `hooks.beforeDispatch`（`before_dispatch` Hook），支持入站频控（`inboundRateLimitMs`）和静默关键词（`silentKeywords`）

---

### v1.5.1 - 智能表情回应 + 触发逻辑修复 (2026-03-03)

#### 修复
- 修复群聊 `keywordTriggers` 必须同时 @ 才能触发的问题，现可独立触发
- 修复 `set_msg_emoji_like` 缺少 `set: true` 参数，NapCat 4.17.25 下请求被忽略的问题
- `setMsgEmojiLike` 改走 HTTP API，提升可靠性

#### 新增
- 新增 `enableReactions` 配置，开启后根据消息内容关键词智能匹配表情回应（15 种场景映射）

---

### v1.3.2 - 适配 OpenClaw 2026.2.25/2026.2.26 安全配置 (2026-02-27)

#### 修复
- 适配 OpenClaw 2026.2.26 Host 头来源校验，新增 `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback` 配置，修复绑定 `0.0.0.0` 时 WebSocket 连接报 4008 错误

---

### v1.3.1 - 误触发修复 (2026-02-27)

#### 修复
- 还原关键词触发在群聊中可独立触发（无需同时 @机器人）
- 群聊管理员指令（`/status`、`/help`、`/mute`、`/kick`）现需同时 @机器人才执行，避免误触发

---

### v1.3.0 - NapCat API 深度集成 (2026-02-12)

#### 新增
- 表情回应：收到触发消息时自动添加表情（`enableReactions`）
- 已读标记：自动标记群聊/私聊消息为已读（`autoMarkRead`）
- AI 语音：使用 NapCat 原生 `send_group_ai_record` API 发送 AI 语音（`aiVoiceId`）
- 私聊戳一戳：`friend_poke` 事件支持
- 批量成员缓存：使用 `get_group_member_list` 替代逐个查询
- 文件上传：非图片文件优先使用 `upload_group_file` / `upload_private_file`

---

### v1.2.0 - Outbound 目标解析优化

#### 修复
- 修复定时任务发送群聊消息时因目标类型解析错误调用 `sendPrivateMsg` 报错的问题
- 新增 `parseTarget()` 统一解析 `to` 字段，支持 `private:id`、`group:id`、`guild:G:C` 格式

---

### v1.1.1 - Outbound 调试日志

#### 新增
- 在 outbound 全链路（`outbound.sendText`、`sendAction`）增加详细调试日志，便于排查定时任务消息发送问题

---

### v1.1.0 - HTTP API + 反向 WebSocket + Outbound 修复

#### 新增
- 新增 HTTP API 发送支持（`httpUrl` 配置）
- 新增反向 WebSocket Server（`reverseWsPort` 配置），NapCat 可主动连接
- 修复 OpenClaw 定时任务/主动推送消息无法送达的问题

---
