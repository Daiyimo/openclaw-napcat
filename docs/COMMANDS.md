# 管理员指令

> 仅 `admins` 列表中的用户可用。群聊中需 @机器人，私聊中直接发送即可。
> 带 ⚠️ 的命令为"高代价/不可逆"，需在 **30 秒内** 再发一次同样的命令以确认。

## 📊 基础

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/ping` | 私/群 | 测量延迟 |
| `/status` | 私/群 | 运行状态（版本、内存、Self ID、运行时长） |
| `/version` | 私/群 | 插件版本、Node.js 版本、npm 更新检查 |
| `/logs [N]` | 私/群 | 最近 N 条日志（默认 20,最多 100） |
| `/reload` | 私/群 | 热重载运行时配置 |
| `/ratelimit` | 私/群 | 查看当前入站频控状态（活跃限流条目、剩余冷却、触发计数） |
| `/unratelimit <目标>` | 私/群 | 手动解除指定用户的入站频控（支持用户 ID 或昵称） |
| `/groups` | 私/群 | 手动刷新群路由（解决 cron 投递找不到群） |
| `/sendto <目标> <内容>` | 私/群 | 跨会话发送（目标格式：`group:群号` / `private:QQ号` / 裸 QQ 号） |
| `/help` | 私/群 | 显示帮助 |

## 👥 群成员管理

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/mute @用户 [分钟]` | 仅群 | 禁言（默认 30 分） |
| `/unmute @用户` | 仅群 | 解除禁言 |
| `/ban @用户 [分钟]` | 仅群 | `/mute` 别名 |
| `/kick @用户` | 仅群 | 踢出指定用户 |
| `/kickbatch @a @b @c` ⚠️ | 仅群 | 批量踢人 |
| `/admin @用户` ⚠️ | 仅群 | 任命管理员（需 bot 为群主） |
| `/unadmin @用户` ⚠️ | 仅群 | 撤销管理员（需 bot 为群主） |
| `/card @用户 [名片]` | 仅群 | 改群名片（空 = 清除） |
| `/title @用户 <头衔>` | 仅群 | 设置专属头衔（需 bot 为群主） |
| `/shutlist` | 仅群 | 查看当前禁言名单（按剩余时间） |

## 🔇 全员禁言

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/banall` | 仅群 | 开启全员禁言 |
| `/unbanall` | 仅群 | 关闭全员禁言 |

## 🏷️ 群资料

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/setname <新群名>` ⚠️ | 仅群 | 修改群名称（需群主） |
| `/setremark <备注>` ⚠️ | 仅群 | 设置群备注（仅 bot 自己可见） |
| `/setportrait` ⚠️ | 仅群 | 修改群头像（**回复一张图片**再发） |
| `/leave` ⚠️ | 仅群 | bot 退出本群 |
| `/dismiss` ⚠️ | 仅群 | 解散本群（需群主，**不可逆**） |

## ⭐ 精华消息

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/essence [msgid]` | 仅群 | 设为精华（回复目标消息发送 = 自动取 msgid） |
| `/deessence [msgid]` | 仅群 | 移出精华 |
| `/essencelist` | 仅群 | 列群精华（前 10 条） |

## 📈 查询

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/honor [type]` | 仅群 | 群荣誉。type ∈ `all` / `talkative` / `performer` / `legend` / `strong_newbie` / `emotion` |
| `/atallremain` | 仅群 | @全体 剩余次数（本群 / 你） |
| `/groupinfo` | 仅群 | 群详情（成员数 / 最大数 / @全体剩余 / 群名） |
| `/temperature [温度=N]` | 群/私 | 查看或调整被动模式温度。无参数显示当前子参数配置；`温度=50` 设置（0=几乎不插话，100=很活跃） |

## 📁 群文件

> 每个 admin 在每个群里独立维护"当前目录"，行为类似 shell：

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/files [count]` | 仅群 | 列当前目录下文件 + 子文件夹（默认 20,最多 50） |
| `/cd <文件夹名>` | 仅群 | 进入指定子目录；`/cd /` 回根 |
| `/cdup` | 仅群 | 上级目录 |
| `/pwd` | 仅群 | 显示当前路径 |
| `/dl <file_id>` | 仅群 | 获取文件下载链接 |
| `/delfile <file_id>` | 仅群 | 删除文件 |
| `/mkdir <name>` | 仅群 | 新建子文件夹 |
| `/rmdir <folder_id>` | 仅群 | 删除子文件夹 |
| `/mvfile <file_id> <target_folder_id>` | 仅群 | 移动文件（target 用 `/` 表示根目录） |
| `/renamefile <file_id> <新名>` | 仅群 | 重命名文件 |
| `/upload` | 仅群 | 上传方式说明 |

**典型使用流程**：

```
/files            # 列根目录,记下感兴趣的 folder_id / file_id
/cd 文档          # 按名进入子目录
/pwd              # 看当前在哪
/files            # 列当前目录
/dl abc123        # 取文件 abc123 的下载链接
/cdup             # 回上级
/mkdir 新文件夹    # 在当前目录建子文件夹
```

## 🎭 NapCat 扩展

| 指令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/poke @用户` | 仅群 | 戳一戳 |
| `/sign` | 仅群 | 群签到 |
| `/todo [msgid]` | 仅群 | 标记消息为待办（回复目标消息发送 = 自动取 msgid） |
| `/donetodo [msgid]` | 仅群 | 完成待办 |
| `/canceltodo [msgid]` | 仅群 | 取消待办 |

---

## 详细说明

### ⚠️ 二次确认机制

`/admin /unadmin /kickbatch /setname /setremark /setportrait /leave /dismiss` 这些高代价命令需要在 30 秒内 **再发一次同样的命令** 才会真正执行。首次发送只返回 "再发一次以确认" 的提示。

设计目的：防止管理员手滑误操作。30 秒过后状态重置，需要重新走一次"首次 → 确认"流程。

实现：`src/utils/confirm-pending.ts`，per-admin per-action 隔离，进程重启所有 pending 自动失效。

### /reload

热重载当前 `openclaw.json` 中 `channels.napcat` 段的配置值。以下参数可即时生效：

- 触发规则（`requireMention`、`keywordTriggers`）
- 频控参数（`rateLimitMs`、`inboundRateLimitMs`）
- 静默关键词（`silentKeywords`）
- 旁观模式（`passiveMode`）
- 系统文件预拦截（`sensitiveFileGuard`，v1.10+）
- 所有行为类开关

连接参数（`wsUrl`、`httpUrl`、`reverseWsPort`、`accessToken`）变更后会提示"需重启容器才能生效"。

### /sendto

跨会话发送消息,绕过 OpenClaw 会话树限制。

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

### 群文件 cwd 状态

群文件 cwd（当前工作目录）维护在 **进程内存**，per-admin per-group 隔离：

- 不同 admin 在同一群里 cwd 互不影响
- 同一 admin 在不同群里 cwd 互不影响
- 进程重启 → 所有 cwd 回到根目录（设计如此，避免悬空状态）

如果 `/cd 文件夹名` 找不到对应子目录，会列出当前目录的可用文件夹列表供参考。

实现：`src/utils/group-file-cwd.ts`。

### 命令权限范围

所有命令都受 admin gate 保护（见 `src/gateway/inbound.ts` 的 `isAdmin` 检查）。
非 admin 用户即使发送任何 `/xxx` 命令也不会进入命令处理流程。
