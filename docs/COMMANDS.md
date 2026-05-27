# 管理员指令

> 仅 `admins` 列表中的用户可用。群聊中需 @机器人，私聊中直接发送即可。

## 指令一览

| 指令 | 适用范围 | 说明 |
| :--- | :--- | :--- |
| `/ping` | 私聊/群聊 | 测量从发送到机器人收到消息的延迟 |
| `/status` | 私聊/群聊 | 查看机器人运行状态（版本、内存占用、运行时长、Self ID） |
| `/version` | 私聊/群聊 | 显示插件版本、Node.js 版本及是否有 npm 更新 |
| `/logs [N]` | 私聊/群聊 | 导出最近 N 条日志（默认 20，最多 100） |
| `/reload` | 私聊/群聊 | 热重载运行时配置。连接参数变更会提示需重启 |
| `/sendto <目标> <内容>` | 私聊/群聊 | 跨会话发送消息。目标格式：`group:群号`、`private:QQ号`、或裸 QQ 号 |
| `/help` | 私聊/群聊 | 显示帮助菜单 |
| `/mute @用户 [分钟]` | 仅群聊 | 禁言指定用户（默认 30 分钟）。示例：`/mute @张三 10` |
| `/kick @用户` | 仅群聊 | 将指定用户移出群聊 |

## 详细说明

### /reload

热重载当前 `openclaw.json` 中 `channels.napcat` 段的配置值。以下参数可即时生效：

- 触发规则（`requireMention`、`keywordTriggers`）
- 频控参数（`rateLimitMs`、`inboundRateLimitMs`）
- 静默关键词（`silentKeywords`）
- 旁观模式（`passiveMode`）
- 所有行为类开关

连接参数（`wsUrl`、`httpUrl`、`reverseWsPort`、`accessToken`）变更后会提示"需重启容器才能生效"。

### /sendto

跨会话发送消息，绕过 OpenClaw 会话树限制。

```
/sendto group:88888888 早上好
/sendto private:12345678 你好
/sendto 12345678 直接发送（自动识别为私聊）
```

### /logs

```
/logs        # 默认最近 20 条
/logs 50     # 最近 50 条
/logs 100    # 最多 100 条
```

日志来源为环形缓冲区拦截的 console 输出，缓冲大小由 `logBufferSize` 配置控制（默认 200 行）。
