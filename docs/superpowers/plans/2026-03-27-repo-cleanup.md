# Repo Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 整理脚本目录结构、将 README 统一为中文版、精简 CHANGELOG 并追加 v1.6.1 条目。

**Architecture:** 三个独立任务顺序执行：(1) 移动脚本到 scripts/；(2) 用中文 README 替换英文版并更新路径引用；(3) 精简 CHANGELOG 并追加新版本条目。每个任务单独 commit。

**Tech Stack:** Git, Bash (脚本移动), Markdown 编辑

---

## 文件变更清单

| 操作 | 文件 |
|------|------|
| 新建目录 | `scripts/` |
| 移动 | `install.sh` → `scripts/install.sh` |
| 移动 | `update.sh` → `scripts/update.sh` |
| 移动 | `update_json.sh` → `scripts/update_json.sh` |
| 移动 | `add_stepfun.sh` → `scripts/add_stepfun.sh` |
| 移动 | `uninstall.sh` → `scripts/uninstall.sh` |
| 移动 | `uninstall.bat` → `scripts/uninstall.bat` |
| 移动 | `uninstall.ps1` → `scripts/uninstall.ps1` |
| 移动 | `install_stepfun.ps1` → `scripts/install_stepfun.ps1` |
| 删除 | `README.md`（英文版） |
| 重命名 | `README_CN.md` → `README.md` |
| 修改 | `README.md`（新）：更新脚本路径引用 + 去掉语言切换头 |
| 修改 | `CHANGELOG.md`：精简历史条目 + 追加 v1.6.1 |

---

### Task 1: 移动脚本到 scripts/ 目录

**Files:**
- 新建: `scripts/`（目录）
- 移动: 根目录下 8 个脚本文件

- [ ] **Step 1: 创建 scripts/ 目录并移动所有脚本**

```bash
cd "E:/project/openclaw-napcat"
mkdir scripts
git mv install.sh scripts/install.sh
git mv update.sh scripts/update.sh
git mv update_json.sh scripts/update_json.sh
git mv add_stepfun.sh scripts/add_stepfun.sh
git mv uninstall.sh scripts/uninstall.sh
git mv uninstall.bat scripts/uninstall.bat
git mv uninstall.ps1 scripts/uninstall.ps1
git mv install_stepfun.ps1 scripts/install_stepfun.ps1
```

- [ ] **Step 2: 确认移动结果**

```bash
cd "E:/project/openclaw-napcat"
ls scripts/
git status
```

期望输出：`scripts/` 下有 8 个文件，git status 显示 8 个 renamed。

- [ ] **Step 3: Commit**

```bash
cd "E:/project/openclaw-napcat"
git commit -m "chore: move all scripts into scripts/ directory"
```

---

### Task 2: README 替换为中文版并更新路径

**Files:**
- 删除: `README.md`（英文版）
- 修改/重命名: `README_CN.md` → `README.md`

- [ ] **Step 1: 删除英文 README，重命名中文版**

```bash
cd "E:/project/openclaw-napcat"
git rm README.md
git mv README_CN.md README.md
```

- [ ] **Step 2: 编辑新 README.md — 去掉顶部语言切换链接**

找到文件第 1-2 行：
```markdown
[**English**](README.md) | 中文

```
替换为（直接删除这两行，保留后续内容）：
```markdown
```

即删除 `[**English**](README.md) | 中文` 这一行及其后的空行。

- [ ] **Step 3: 更新快速部署命令中的脚本路径（第 182-191 行附近）**

找到：
```markdown
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/install.sh | sudo bash

# 一行命令修改 JSON 文件
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/update_json.sh | sudo bash

# 一行命令添加 StepFun 模型并设为主模型 (Linux/macOS)
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/add_stepfun.sh | sudo bash

# Windows 用户请使用 PowerShell 脚本（自动请求管理员权限）
irm "https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/install_stepfun.ps1" -UseBasicParsing | iex
```

替换为：
```markdown
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/scripts/install.sh | sudo bash

# 一行命令修改 JSON 文件
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/scripts/update_json.sh | sudo bash

# 一行命令添加 StepFun 模型并设为主模型 (Linux/macOS)
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/scripts/add_stepfun.sh | sudo bash

# Windows 用户请使用 PowerShell 脚本（自动请求管理员权限）
irm "https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/2026.3.24/scripts/install_stepfun.ps1" -UseBasicParsing | iex
```

- [ ] **Step 4: 更新配置说明中的 update_json.sh 本地调用路径（第 212-216 行附近）**

找到：
```markdown
### 1. 快速配置 (update_json.sh)
插件内置了交互式配置脚本，在插件目录下运行：

```bash
bash update_json.sh
```
```

替换为：
```markdown
### 1. 快速配置 (update_json.sh)
插件内置了交互式配置脚本，在插件目录下运行：

```bash
bash scripts/update_json.sh
```
```

- [ ] **Step 5: 检查 README.md 中是否还有其他裸脚本名引用**

```bash
cd "E:/project/openclaw-napcat"
grep -n "install\.sh\|update\.sh\|update_json\.sh\|add_stepfun\.sh\|uninstall\.sh\|uninstall\.bat\|uninstall\.ps1\|install_stepfun\.ps1" README.md
```

逐行确认是否都已更新为 `scripts/` 前缀，或是正文描述性提及（不需要改路径）。

- [ ] **Step 6: Commit**

```bash
cd "E:/project/openclaw-napcat"
git add README.md
git commit -m "docs: replace README with Chinese version, update script paths to scripts/"
```

---

### Task 3: 精简 CHANGELOG 并追加 v1.6.1

**Files:**
- 修改: `CHANGELOG.md`

精简原则：保留版本标题、一句话摘要、主要功能点列表；去掉"涉及文件"表格、详细实现说明、配置项详细表格。

- [ ] **Step 1: 用精简后的内容完整替换 CHANGELOG.md**

将 `CHANGELOG.md` 全文替换为以下内容：

```markdown
[**English**](README.md) | [**中文**](README_CN.md)

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

### v1.3.2 - 适配 OpenClaw 2026.2.25+ 安全配置 (2026-02-27)

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
```

- [ ] **Step 2: 确认文件内容正确**

```bash
cd "E:/project/openclaw-napcat"
cat CHANGELOG.md | head -20
```

期望看到 v1.6.1 条目在顶部。

- [ ] **Step 3: Commit**

```bash
cd "E:/project/openclaw-napcat"
git add CHANGELOG.md
git commit -m "docs: simplify CHANGELOG and add v1.6.1 entry"
```
