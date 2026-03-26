[**English**](README.md) | [**中文**](README_CN.md)

# 更新日志

### v1.6.0 - 适配 OpenClaw 2026.3.24 (2026-03-26)

适配 OpenClaw 2026.3.22+ 引入的插件架构新特性，全部改动向后兼容。

#### 新增

**1. `describeMessageTool` 接口实现**

在 `messaging` 对象上实现 `describeMessageTool()`，让 OpenClaw Control UI 的 "Available Right Now" 区域能正确显示 QQ 频道的可用工具。返回 QQ/NapCat 通过 OneBot v11 支持的操作：`send`、`reply`、`react`、`unsend`、`read`。

**2. `before_dispatch` Hook**

新增 `hooks.beforeDispatch`，在消息分发给 AI agent 之前触发，支持：

| 功能 | 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| 入站频控 | `inboundRateLimitMs` | `0` | 同一来源在指定 ms 内只触发一次 AI，0 = 不限制 |
| 静默关键词 | `silentKeywords` | 无 | 消息含关键词时静默丢弃，不触发 AI 也不回复 |

**3. 新增配置项**

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `inboundRateLimitMs` | number | `0` | 入站每用户频控间隔（ms），最大 60000 |
| `silentKeywords` | string[] | 无 | 静默关键词列表，每项至少 1 个字符 |

#### 适配说明

- 已使用 `openclaw/plugin-sdk/*` 路径，无需迁移 `extension-api`
- 未使用已废弃的 `listActions` / `getCapabilities` / `getToolSchema`，无需迁移
- 兼容 OpenClaw 2026.3.13+（新 hook 字段若旧版不认识会被忽略）

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/openclaw-plugin-sdk.d.ts` | 更新 | 新增 `describeMessageTool`、`BeforeDispatchHook`、`hooks` 类型 |
| `src/config.ts` | 新增字段 | `inboundRateLimitMs`、`silentKeywords` |
| `openclaw.plugin.json` | 新增字段 | 同步 configSchema |
| `src/channel.ts` | 新增 | `messaging.describeMessageTool`；`hooks.beforeDispatch` |
| `package.json` | 版本 | 升至 1.6.0 |

---

### v1.5.1 - 智能表情回应 + 触发逻辑修复 (2026-03-03)

#### 修复

**1. 修复群聊 keywordTriggers 无法独立触发**

关键词触发条件误加了 `(!checkMention || isMentioned)` 约束，导致群聊中关键词必须同时 @ bot 才生效。已移除该约束，关键词现在可独立触发。

**2. 修复 set_msg_emoji_like 缺少 set 参数**

NapCat 4.17.25 要求 `set_msg_emoji_like` 接口必须传 `set: true`，否则请求被忽略。

**3. 贴表情改走 HTTP API**

`setMsgEmojiLike` 从 `sendWs` 改为 `sendAction`，与消息发送保持一致，优先走 HTTP 确保可靠性。

#### 新增

**智能表情回应（`enableReactions`）**

新增 `enableReactions` 布尔配置，开启后根据消息内容关键词自动匹配最合适的表情回应：

| 消息类型 | 表情 | ID |
| :--- | :--- | :--- |
| 查找/搜索/检查/打开 | OK | 124 |
| 好的/收到/确认 | 赞 | 76 |
| 谢谢/感谢 | 拜谢 | 297 |
| 加油/厉害/棒 | 加油 | 315 |
| 哈哈/开心/笑 | 鼓掌 | 99 |
| 难过/哭/失落 | 流泪 | 5 |
| 生气/烦/讨厌 | 生气 | 326 |
| 疑问/为什么/? | 疑问 | 32 |
| 哇/惊/震惊 | 惊喜 | 180 |
| 喜欢/爱/可爱 | 爱心 | 66 |
| 你好/早/嗨 | 微笑 | 14 |
| 帮/请/麻烦 | 拱手 | 118 |
| 吃/饿/饭 | 蛋糕 | 53 |
| 睡/困/累 | 睡 | 8 |
| 其他 | 喵喵 | 307 |

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/channel.ts` | 修复+新增 | 关键词触发修复；智能表情回应逻辑 |
| `src/client.ts` | 修复 | `setMsgEmojiLike` 补充 `set: true`，改走 `sendAction` |
| `src/config.ts` | 新增字段 | 新增 `enableReactions` 配置项 |
| `update_json.sh` | 更新 | 默认配置改用 `enableReactions: true` |
| `install.sh` | 修复 | clone 分支从 `v4.17.25` 改为 `main` |
| `update.sh` | 新增 | 一键拉取最新代码脚本 |

---

### v1.3.2 - 适配 OpenClaw 2026.2.25+ 安全配置 (2026-02-27)

适配 OpenClaw 2026.2.25/2026.2.26 引入的 Gateway 安全策略，修复绑定 `0.0.0.0` 时 WebSocket 连接报 4008 错误的问题。

#### 变更详情

**1. 新增 `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`**

OpenClaw 2026.2.26 新增了 Host 头来源校验。当 gateway 绑定到 `0.0.0.0` 时，客户端通过 IP 访问会导致 Host 头不匹配被拒绝，需配置此项绕过。

**2. 关于 4008 配对问题**

OpenClaw 2026.2.25 封堵了非 Control UI 客户端的静默自动配对，首次访问 WebUI 需通过 CLI 完成设备配对：

```bash
# 查看待审批的设备请求
openclaw devices list

# 审批指定请求（requestId 从上方列表获取）
openclaw devices approve <requestId>
```

配对完成后，带 token 的 WebSocket 连接即可正常建立。`update_json.sh` 脚本启动服务后会自动打印配对操作指引。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `update_json.sh` | 新增 | 写入 `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true` |
| `README.md` | 文档 | 手动配置示例补充 `gateway` 段及注意事项 |

---

### v1.3.1 - 误触发修复 (2026-02-27)

修复群聊中管理员指令意外触发的问题，还原关键词独立触发能力。

#### 变更详情

**1. 关键词触发无需 @机器人（已还原）**

关键词触发在群聊中可独立触发，无需同时 @机器人。

**2. 管理员指令需同时 @机器人（群聊）**

此前管理员在群聊中发送以 `/` 开头的消息（如 `/help`）就会触发机器人指令，无论是不是在和机器人说话。

现在群聊中管理员指令（`/status`、`/help`、`/mute`、`/kick`）需要同时 @机器人才会执行，私聊中直接发送仍可触发。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/channel.ts` | 修复 | 关键词触发增加 mention 前置检查；管理员命令增加群聊 mention 前置检查 |
| `README.md` | 文档 | 同步说明关键词触发和管理员指令的触发条件变更 |

---

### v1.3.0 - NapCat API 深度集成 (2026-02-12)

基于 NapCat 完整 API 能力进行全面优化，新增多项交互功能并提升性能。

#### 新增功能

| 功能 | 说明 |
| :--- | :--- |
| **表情回应** | 收到触发消息时自动添加表情回应（`set_msg_emoji_like`），通过 `enableReactions` 配置开启，根据消息内容智能匹配表情 |
| **已读标记** | 自动标记群聊/私聊消息为已读（`mark_group_msg_as_read` / `mark_private_msg_as_read`），通过 `autoMarkRead` 配置 |
| **AI 语音** | 利用 NapCat 原生 `send_group_ai_record` API 发送 AI 语音，音色更丰富，通过 `aiVoiceId` 配置 |
| **私聊戳一戳** | 新增 `friend_poke` 支持，私聊中收到戳一戳也会回应 |
| **批量成员缓存** | 使用 `get_group_member_list` 一次获取全部群成员，替代逐个查询，大幅减少 API 调用 |
| **文件上传 API** | 非图片文件优先使用 `upload_group_file` / `upload_private_file` 上传，更可靠 |

#### 优化改进

- `OneBotEvent` 类型补全：新增 `guild_id`、`channel_id`、`target_id`、`notice_type`、`request_type`、`flag` 等字段
- `OneBotMessageSegment` 类型补全：新增 `record`、`video`、`json`、`forward`、`file`、`face` 等消息段
- `getGroupMsgHistory` 新增 `count` 参数，按需获取历史消息条数，减少数据传输
- 好友/入群请求处理从死代码修复为正确的事件分发

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/types.ts` | 增强 | 补全 OneBotEvent 和 OneBotMessageSegment 类型定义 |
| `src/config.ts` | 新增字段 | 新增 `enableReactions`、`autoMarkRead`、`aiVoiceId` 配置项 |
| `src/client.ts` | 新增方法 | 新增 7 个 NapCat API 方法，优化 `getGroupMsgHistory` 参数 |
| `src/channel.ts` | 集成 | 表情回应、已读标记、AI 语音、批量成员缓存、文件上传、私聊戳一戳 |
| `README.md` | 文档 | 同步文档更新 |
| `package.json` | 版本 | 更新为 1.3.0 |

#### 新增配置项

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enableReactions` | boolean | `true` | 智能表情回应，默认开启，设为 `false` 可关闭 |
| `autoMarkRead` | boolean | `false` | 自动标记消息为已读 |
| `aiVoiceId` | string | - | NapCat AI 语音角色 ID，配合 `enableTTS` 使用 |

#### 推荐环境

- NapCat 4.16.0+

---

### v1.2.0 - Outbound 目标解析优化

修复了定时任务 (cron) 发送群聊/频道消息时，因目标类型解析不正确导致调用 `sendPrivateMsg` 并报错"请指定正确的 group_id 或 user_id"的问题。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/channel.ts` | 重构 | 新增 `parseTarget()` 和 `dispatchMessage()` 函数，统一 outbound 目标解析和消息分发逻辑 |
| `README.md` | 新增章节 | 新增"定时任务 (Cron) `to` 字段格式"文档，明确各目标类型的格式要求 |

#### 变更详情

**1. 新增 `parseTarget()` 统一解析函数**

| `to` 值 | 解析结果 |
| :--- | :--- |
| `"12345678"` | 私聊，`userId = 12345678` |
| `"private:12345678"` | 私聊，`userId = 12345678` |
| `"group:88888888"` | 群聊，`groupId = 88888888` |
| `"guild:G1:C1"` | 频道，`guildId = G1, channelId = C1` |

---

### v1.1.1 - Outbound 调试日志

为排查定时任务消息发送不到的问题，在 outbound 全链路增加了详细的调试日志。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/channel.ts` | 增加日志 | `outbound.sendText` 入口处打印调用参数、client 查找结果、发送进度 |
| `src/client.ts` | 增加日志 | `sendAction` 中打印 HTTP 请求地址、WS 连接状态、成功/失败结果 |

---

### v1.1.0 - HTTP API + 反向 WebSocket + Outbound 修复

本次更新解决了 **OpenClaw 定时任务/主动推送消息无法送达** 的问题，并新增了两种通信方式。

#### 涉及文件

| 文件 | 变更类型 | 说明 |
| :--- | :--- | :--- |
| `src/config.ts` | 新增字段 | 新增 `httpUrl`、`reverseWsPort` 两个可选配置项 |
| `src/client.ts` | 重构 | 新增 HTTP API 发送、反向 WS Server、修复消息发送静默失败 |
| `src/channel.ts` | 修改 | 适配新配置项，outbound 发送改为 await 并正确返回错误 |

#### 新增配置项

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `httpUrl` | string | - | NapCat HTTP API 地址（如 `http://localhost:3000`），用于主动发送消息 |
| `reverseWsPort` | number | - | 反向 WebSocket 监听端口（如 `3002`），NapCat 主动连接到此端口 |
