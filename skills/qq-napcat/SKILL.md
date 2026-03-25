# QQ NapCat 插件技能指南

## 概述

OpenClaw QQ NapCat 插件通过 OneBot v11 协议接入 QQ，支持私聊、群聊和频道消息。

---

## 媒体发送

### 图片

在 AI 回复中嵌入图片 URL，插件会自动识别并以图片消息形式发送：

```
# 图片 URL（http/https）
https://example.com/image.png

# 本地文件路径（会自动转为 base64）
file:///tmp/image.jpg
```

支持格式：`.jpg`、`.jpeg`、`.png`、`.gif`、`.webp`

### 文件

非图片媒体文件会通过 OneBot 文件上传 API 发送：

- 群聊：使用 `upload_group_file`
- 私聊：使用 `upload_private_file`
- 频道：发送文件链接文本

> 💡 **上传缓存**：同一账号、同一文件在 30 分钟内只上传一次，再次发送自动复用缓存。

### 语音（TTS）

开启 `enableTTS: true` 后，AI 回复的前 100 字会同时发送为语音消息：

- 群聊（配置了 `aiVoiceId`）：使用 NapCat AI 变声
- 群聊（未配置 aiVoiceId）：使用 QQ CQ 码 TTS
- 私聊：使用 QQ CQ 码 TTS

---

## 管理命令

管理员命令需满足以下条件才能触发：
1. 发送者 QQ 号在 `admins` 列表中
2. 群聊中需要 @机器人

### 命令列表

| 命令 | 说明 | 示例 |
|------|------|------|
| `/ping` | 测量消息到收到回复的延迟 | `/ping` |
| `/version` | 显示插件版本、Node.js 版本及更新状态 | `/version` |
| `/logs [N]` | 导出最近 N 条系统日志（默认 20，最多 100） | `/logs 50` |
| `/status` | 显示机器人状态（连接、内存、运行时间） | `/status` |
| `/help` | 显示所有可用命令 | `/help` |
| `/mute @用户 [分钟]` | 禁言群成员（默认 30 分钟） | `/mute @张三 10` |
| `/kick @用户` | 将群成员踢出群组 | `/kick @张三` |

### 命令示例输出

**`/ping`**
```
🏓 Pong! 延迟: 42ms
```

**`/version`**
```
[OpenClaw QQ] v1.5.1
Node.js: v20.11.0
更新状态: ✨ 有新版本 v1.6.0 可用（npm i @openclaw/qq@latest）
```

**`/status`**
```
[OpenClaw QQ] v1.5.1
状态: 已连接
Self ID: 123456789
内存: 45.23 MB
运行时间: 2天 3小时 15分
```

**`/logs 5`**
```
[最近 5 条日志]
2026-03-25 10:01:23 [LOG] [napcat-QQ] Connected account default
2026-03-25 10:01:24 [LOG] [napcat-QQ] Logged in as: MyBot (123456789)
2026-03-25 10:05:11 [LOG] [napcat-QQ] recordMessageReply: 12345, count=1
2026-03-25 10:08:33 [WRN] [napcat-QQ] STT failed: connection timeout
2026-03-25 10:12:44 [LOG] [ref-index-store] Loaded 128 entries from 200 lines
```

---

## 配置说明

### 消息防抖（deliverDebounce）

当 AI 快速产生多条消息时，自动合并为一条发送，避免消息轰炸：

```json
{
  "channels": {
    "qq": {
      "deliverDebounce": {
        "enabled": true,
        "windowMs": 1500,
        "maxWaitMs": 8000,
        "separator": "\n\n---\n\n"
      }
    }
  }
}
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否开启防抖 |
| `windowMs` | `1500` | 防抖窗口（毫秒），窗口内无新消息则发送 |
| `maxWaitMs` | `8000` | 最大等待时间（毫秒），超时强制发送 |
| `separator` | `\n\n---\n\n` | 合并多条消息时的分隔符 |

### 版本更新检查（enableUpdateCheck）

```json
{
  "channels": {
    "qq": {
      "enableUpdateCheck": true
    }
  }
}
```

启动时自动检查 npm registry 是否有新版本，有更新时在日志中提示。
使用 `/version` 命令可随时查看当前更新状态。

### 日志缓冲区（logBufferSize）

```json
{
  "channels": {
    "qq": {
      "logBufferSize": 200
    }
  }
}
```

控制 `/logs` 命令可查看的最大日志条数，默认 200 条。

### 其他常用配置

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://localhost:3001",
      "admins": [123456789],
      "requireMention": true,
      "enableReactions": true,
      "markdownMode": "passthrough",
      "historyLimit": 5,
      "rateLimitMs": 1000,
      "enableSTT": false,
      "enableTTS": false
    }
  }
}
```

---

## 引用消息支持

插件会自动记录所有入站消息到本地引用索引（`~/.openclaw/napcat-qq/data/ref-index.jsonl`）。
当用户引用一条历史消息时，AI 上下文会包含被引用消息的内容，即使 OneBot API 无法查到该消息。

- TTL：7 天
- 最大缓存：50,000 条
- 超出时自动淘汰最旧记录
