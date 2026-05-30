[**中文**](README.md)

# 更新日志

### [Unreleased]

#### 新增

- **友军识别（Bot-to-Bot Recognition）**：检测 `sender.bot=true` 和不可见零宽字符签名，防止多 bot 在同一群产生循环对话；`ignoreSenderBot` 默认 true，`botSuppressionMs` 默认 120 秒
- **旁观模式频率控制**：新增 `minIntervalMs`（最小触发间隔，含 [SILENT] 响应），防止 AI 被频繁调用；`botSuppressionMs` 控制友军识别抑制时长
- **智能延迟**：仅当检测到其他 bot 近期活跃时才随机延迟 0~2 秒错开处理，不拖慢正常响应
- **零宽字符签名仅群追加**：bot 签名仅在群消息中追加，私聊不追加，避免冗余

---

### v1.7.0 - 架构重构 + 旁观模式 + 跨会话投递 + Docker 部署 (2026-05-27)

本版本为架构级重构，将单文件 900 行 channel.ts 拆分为模块化架构，新增旁观模式、跨会话投递、配置热重载等特性，并引入完整测试覆盖。

#### 新增

- **旁观模式（Passive Mode）**：AI 监听群聊全部消息，自主判断是否发言，支持冷却时间和自定义 system prompt
- **跨会话投递**：AI 回复中使用 `[TO:group:群号]` 或 `[TO:private:QQ号]` 前缀将消息发送到非当前会话
- **`/sendto` 管理命令**：管理员直接向指定目标发送消息（`/sendto group:88888888 内容`）
- **`/reload` 管理命令**：运行时热重载配置，无需重启容器
- **HTTP 指数退避重试**：OneBot HTTP API 调用失败时自动重试（5xx/网络错误），延迟 200→400→800ms
- **群路由自动刷新**：每 6 小时同步群组列表，确保新群的 cron 投递和跨会话发送正常工作
- **裸数字群号自动识别**：outbound 发送时裸数字 `to` 自动匹配已知群号，彻底修复 cron 群投递问题
- **Docker 一键部署**：支持 `curl | bash` 安装，适配 NAS Docker UI 场景
- **Vitest 测试框架**：引入完整测试基础设施

#### 重构

- **模块化架构拆分（P0/P1/P2）**：
  - 提取 `gateway/`（connection + inbound + lifecycle）和 `outbound/`（send-text + send-media）子模块
  - 提取 `PassiveModeManager` 类，状态机管理旁观模式冷却
  - 提取 `MessageSender` 类，统一回复投递逻辑（分片/TTS/Markdown）
  - 提取 `MessageProcessor` 纯函数（文本解析/触发检测/上下文构建）
  - 提取 `ConfigRef` 热更新支持（config-watcher.ts）
  - `channel.ts` 瘦身为纯组装层（从 ~900 行降至 ~330 行）
- **常量治理**：所有魔法数字提取到 `constants.ts`，带来源注释
- **渠道 ID 重命名**：从 `"qq"` 改为 `"napcat"`，避免与官方 QQ Bot 插件冲突
- **类型严格化**：新增 `types/channel-types.ts`，为 gateway/outbound 定义严格接口

#### 性能

- **ref-index-store 异步批量写**：`appendFileSync` 改为写队列 + 异步批量 flush，`compactFile` 后台化执行

#### 修复

- 修复旁观模式孤儿哨兵抖动 bug，`isAllowed` 懒释放时正确删除条目
- 修复裸数字群号 API 探测兜底逻辑，消息接收时顺手缓存已知群号
- 修复 `registerGroupRoute` 作用域编译错误
- 修复群路由注册未同时覆盖裸数字和带前缀两种 key 的问题
- 修复 `normalizeTarget` 未剥离 `napcat:` 前缀的问题
- 修复容器内 TypeScript 编译缺失（@types/ws 移入 dependencies）
- 修复 `listAccountIds` / `resolveAccount` 错误读取 `channels.qq` 而非 `channels.napcat`
- 修复 `resolveAccount` 未通过 Zod 解析导致默认值缺失
- 修复所有 NapCat API 数字 ID 未统一转 string 的兼容性问题
- 修复 14+ 处深度审查发现的 bug（详见 commit 81018ec, 54be11e, b40080d）

#### 测试

- 新增 `message-parser` 全纯函数单元测试
- 新增 `config` Zod Schema 验证测试
- 新增 `deliver-debounce` 防抖合并逻辑测试（fake timers）
- 新增 `admin-commands` 管理命令处理测试
- 新增 `passive-mode` 状态机 14 条单元测试
- 新增 `message-sender` 投递逻辑 15 条单元测试
- 新增 `message-processor` 文本/触发/上下文 25 条单元测试
- 新增 `ref-index-store` 异步写测试
- 新增 `retry` 指数退避重试测试
- 新增 `config-watcher` 热更新测试
- 新增 `inbound-pipeline` 集成测试（12 个场景端到端覆盖）

#### 适配

- 适配 OpenClaw 3.31 插件 SDK（`defineChannelPluginEntry` 注册模式）
- 支持 `registrationMode` 区分 setup-only / cli-metadata / full 模式

---

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
