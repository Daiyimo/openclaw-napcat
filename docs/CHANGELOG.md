[**中文**](README.md)

# 更新日志

### [Unreleased] - 投递层防御性类型转换

#### Fixed

- **`TypeError: text?.trim is not a function` 导致投递失败**：cron agent / AI 上游将数字类型（如 `207.44`）作为 `text` 字段传递，Napcat 投递层三处 `.trim()` 调用均未做类型防御，导致消息发送崩溃、`delivered: false`。
  - 修复：在 `send-text.ts`、`message-sender.ts`、`deliver-debounce.ts` 三个入口统一加 `typeof text === "string" ? text : String(text ?? "")` 防御性归一化。
  - 新增回归测试覆盖两条发送路径（send-text / message-sender），数字类型 `text` 不再崩溃。
  - 约定：**所有出站入口的 `text` / `payload.text` 必须第一时间归一化为字符串，后续代码不再做类型假设**。

### [Unreleased] - 远程一键升级

#### Added

- **`scripts/remote-upgrade.sh`**：一行 curl 命令跨服务器升级 Docker 部署的 OpenClaw NapCat。
  - 适用场景：你在任意设备（笔记本、朋友的服务器）上执行升级，无需手动 docker exec。
  - 用法：`curl -fsSL https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/main/scripts/remote-upgrade.sh | bash`
  - 特性：多镜像兜底下载、容器内编译、自动备份/回滚、支持自定义 CONTAINER_NAME / DATA_DIR / BRANCH。
  - 国内加速：`curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/... | bash`

### [Unreleased] - /temperature 显示优化

#### Fixed

- **`/temperature` 无参数时显示"未设 temperature，使用子参数模式"**：即使用户通过 `cooldownMs` / `minIntervalMs` / `botSuppressionMs` 子参数配置了被动模式，也会显示此提示，令人困惑。
  - 修复：无参数时始终显示当前生效的子参数值，header 区分"显式设了 temperature"和"使用子参数"两种模式。

### [Unreleased] - docker-install.sh set -e 陷阱修复

#### Fixed

- **`scripts/docker-install.sh` 第一个镜像失败时 silent 退出**：用户在容器里跑 `curl -fsSL .../docker-install.sh | bash`，输出 "尝试: https://ghfast.top/..." 后脚本直接退回 shell prompt，没有任何错误诊断。
  - 根因：line 134 用 `curl_err=$(curl ... 2>&1)` 形式。按 bash 规范，命令替换内命令的非零退出不应触发 set -e；**但 bash 4.4 之前的版本（以及部分容器 minimal shell）行为不一致**，会因 inner curl 失败立刻退出，跳过下面的 case 诊断和 fallback 镜像循环。
  - 修复：改用 `set +e` / `set -e` 显式包裹 curl 调用，并加 `< /dev/null` 显式关闭 stdin 防 `curl | bash` 模式下子 curl 偷读外层 pipe 字节。
  - 影响范围：所有用 docker-install.sh 一键安装的用户，特别是 ghfast.top 在当前网络环境不可达时。`install.sh` / `update.sh` 已经用 `if curl ...; then` 模式，无此问题。

### [Unreleased] - 群管理全套补齐

#### Added — 群管命令从 3 个扩展到 30+

参考 NapCat 4.18.1 OpenAPI 补齐群管命令，按分组展示。详见 [`docs/COMMANDS.md`](COMMANDS.md)。

**A. OneBot v11 原生群管**：
- `/unmute` 解除禁言、`/kickbatch` 批量踢人（⚠️ 二次确认）
- `/admin /unadmin` 任命/撤销管理员（⚠️ 二次确认）
- `/card` 改群名片、`/title` 专属头衔
- `/banall /unbanall` 全员禁言开关
- `/shutlist` 查看禁言名单

**B. 群资料**：
- `/setname` 改群名（⚠️ 二次确认）
- `/setremark` 改群备注（⚠️ 二次确认）
- `/setportrait` 改群头像（⚠️ 二次确认，需回复一张图片）
- `/leave` bot 退群（⚠️ 二次确认）
- `/dismiss` 解散本群（⚠️ 二次确认，不可逆）

**C. 精华消息**：`/essence /deessence /essencelist`

**D. 查询**：`/honor`（群荣誉）、`/atallremain`（@全体剩余）、`/groupinfo`

**E. 群文件全套**（per-admin per-group cwd 状态，类 shell 体验）：
- `/files /cd /cdup /pwd` 浏览
- `/dl /delfile /mkdir /rmdir /mvfile /renamefile` 增删改查
- `/upload` 上传方式说明

**F. NapCat 扩展**：
- `/poke` 戳一戳、`/sign` 群签到
- `/todo /donetodo /canceltodo` 群待办三件套

**底层 `src/client.ts` 同步补齐 27 个 OneBot/NapCat API**（`setGroupAdmin / setGroupCard / setEssenceMsg / getGroupRootFiles / setGroupPortrait` 等）。

#### Added — 二次确认机制

新增 `src/utils/confirm-pending.ts`（纯函数 + 模块 Map，30s TTL）。高代价命令（带 ⚠️）首次触发返回 "pending" 提示，30 秒内同 admin 同 action 再发一次才真正执行。防止手滑误操作。

#### Added — 群文件 cwd 状态

新增 `src/utils/group-file-cwd.ts`（纯函数 + 模块 Map）。每个 admin 在每个群里独立维护当前目录栈，`/cd /cdup /files` 等命令像 shell 一样工作。

#### Added — 测试 +54

- `confirm-pending.test.ts` 11 it（纯函数零 mock）
- `group-file-cwd.test.ts` 10 it（纯函数零 mock）
- `admin-commands.test.ts` +33 it：覆盖新命令 happy path + 二次确认 + cwd 流转 + 边界

#### Why

- 现状：napcat 群管命令只有 3 个（`/mute /ban /kick`），75% 群管 API 在 client.ts 也空白
- 痛点：群主每次想做群管要切 NapCat WebUI 手动点
- 决策：参考 NapCat 4.18.1 OpenAPI 全套补齐；高代价操作走二次确认防误按；全部仅 admin 与现有 gate 一致

### [Unreleased] - 系统文件预拦截

#### Added

- **`sensitiveFileGuard` 配置项**（默认启用）：在 inbound pipeline 中拦截非 admin 用户对系统文件（SOUL/AGENTS/IDENTITY/USER/MEMORY.md）的修改请求。命中时直接 reply 一句拒绝消息并 return，不调用 OpenClaw。Admin 完全不受影响。
  - 两路匹配：文件名直命（如 "改一下你的 SOUL.md"）或动词+名词意图组合（如 "帮我修改一下人设"）
  - 默认词表：中英共 5 个文件名 + 16 个动词 + 11 个名词
  - 英文按 `\b` 词边界匹配避免误伤；中文按 substring 匹配；不区分大小写；按词长降序优先
  - 全场景生效（群聊 / 频道 / 私聊）
  - 完整配置示例与字段说明见 [`docs/CONFIG.md`](CONFIG.md#sensitivefileguard-详细说明)
- 新增纯函数模块 `src/utils/sensitive-guard.ts` + 21 个单元测试 + 6 个集成测试

#### Why

- **问题**：非管理员在 QQ 群 @bot 后能让 bot 修改 SOUL.md（人设文件）
- **根因**（已在主项目 openclaw 验证）：napcat 网关已正确传 `CommandAuthorized: isAdmin` 给 OpenClaw，但 OpenClaw 主项目的 `src/agents/` 树整体不读这个字段，LLM tool dispatch 层（write/edit/apply_patch 工具）缺权限闸门
- **决策**：上游 `openclaw/CLAUDE.md` 明确要求 security 改动必须 owner ask/review，不能直接动主项目。在 napcat 网关侧加预拦截是用户可控的最快防线
- **后续**：本字段是治标方案。根治需要 OpenClaw 主项目在 `src/agents/agent-tools.before-tool-call.ts` 加 bootstrap 文件 denylist

### v1.9.3 - docker-install 网络修复 + 本地 tarball 强化 (2026-06-02)

#### Fixed

- **移除 kkgithub 镜像**：v1.9.2 把它放到镜像列表首位作为国内加速源,但实测在跨区域部署的容器里完全不可达(非慢,是挂死)。30s 超时 × 2 次重试 = 用户必须等 60s 才能 fallback,体感是脚本"卡住",普遍被迫 Ctrl+C 中断。回退到 0a5d676 的 3 镜像顺序 + 后续新增的 2 个代理,共 6 个镜像。
- **强化 `OPENCLAW_NAPCAT_LOCAL_TARBALL` 离线兜底**:v1.9.2 已经支持该环境变量,但只在脚本里以普通兜底段出现。本版:
  - 脚本头部注释把"本地 tarball 离线安装"提到 4 种安装方式里的 #4(完全离线场景,作为受限于网络时的推荐方案)
  - 在兜底段加 ★ DO NOT REMOVE 标记,关联 commit 9004030 / 1fd9a6a,提示未来维护者这是受限网络用户的唯一安装通道
  - 新增测试场景 F 锁住"本地 tarball 优先级 > 网络下载"的行为,防止未来重构误删

#### Why

- 5 个公开 GitHub 镜像在某用户环境(跨区域容器部署)里**全部不可达**——这不是个别镜像临时挂掉,而是该环境的整体网络隔离。此时本地 tarball 离线安装是**唯一**可工作的路径,不能降级为"可选"。
- 测试 7/7 通过:`bash scripts/test-install-download.sh`

### v1.9.2 - 撤销 metadata 协议层握手 (2026-06-01)

#### Removed

- **完全删除 `botSignatureStyle: "metadata"` 模式**:v1.9.0/1.9.1 试过的"协议层握手"是错的——OneBot `json` 段在 QQ 客户端**会渲染成可见的卡片消息**,导致启动时向所有群广播 spam 卡片(用户报告的真实问题)。移除范围:
  - `metadata` 枚举值从 `botSignatureStyle` 删除
  - 启动握手(connection.ts onConnect 块)
  - 24h 心跳定时器
  - 出站握手补发(message-sender.ts / send-text.ts)
  - `group_increase` 触发握手节流清除
  - `makeBotHandshakeMessage` / `shouldSendHandshake` / `markHandshakeSent` / `clearHandshakeThrottle` 函数
  - `BOT_HANDSHAKE_APP` / `BOT_HANDSHAKE_KIND` / `BOT_HANDSHAKE_MIN_LENGTH` 常量
- 默认 `DEFAULT_BOT_SIGNATURE_STYLE` 改为 `"visible"`(v1.8 行为)

#### Kept (读侧,无 spam 风险)

- `parseBotHandshake()`:入站消息中如含 json 段握手(对方 bot 仍可能发),仍能识别
- `runHandshakeBackfill()`:冷启动时拉最近 30 条群历史,扫描握手 + 文本签名入 cache(只读不发)
- Layer 4 协议层握手检测(inbound.ts 5 层检测的一部分,作防御性兜底)

#### Why

| 模式 | 用户文本 | 启动行为 | 适用 |
|---|---|---|---|
| `visible`(默认) | `... [BOT:xxx]` 可见 | 不发消息 | 跨框架 bot 兼容,可靠 |
| `zero-width` | 不可见 | 不发消息 | 美观优先,99% 场景有效 |
| `none` | 无签名 | 不发消息 | 仅靠 sender.bot / knownBotIds / cache |
| ~~`metadata`~~ | 无签名 | **向所有群发卡片 spam** | ❌ 已删除 |

### v1.9.1 - 默认回复格式硬约束 (2026-06-01)

#### Added

- **responseGuidelines 配置项**:在 system prompt 顶部默认注入 `DEFAULT_RESPONSE_GUIDELINES` 硬约束,防止 reasoning 类模型(Claude with extended thinking / o1 / o3 等)把 CoT 混到回复里。
  - 默认约束包括:不输出内部推理 / 用户行为分析 / 英文 meta 注释;群聊 50 字以内;不"八股"结构;语言跟用户;多 bot 不复述;旁听没想说的回复 [SILENT]。
  - **关闭方式**:`responseGuidelines: ""` 或 `QQ_RESPONSE_GUIDELINES: ""`。
  - **自定义方式**:传非空字符串,完全替换默认内容。
- **docker-compose 环境变量**:`QQ_RESPONSE_GUIDELINES` 透传到 `channels.napcat.responseGuidelines`。

### v1.9.0 - Plan A 协议层握手 + 用户文本 100% 干净 (2026-06-01)

#### Changed

- **友军识别默认策略从 `visible` 改为 `metadata`**：用 OneBot `json` 段在协议层声明 bot 身份，**用户消息文本 100% 干净**,不再出现 `[BOT:xxx]` 后缀。
  - 旧默认值 `visible` 仍可用(回退兼容),显式设置 `botSignatureStyle: "visible"` 即可。
  - 新增 `none` 选项:完全禁用文本签名,仅靠 `sender.bot` / `knownBotIds` / 持久化 cache 兜底。
- **五层检测机制**：在原四层(白名单 / sender.bot / 持久化 cache / 文本签名)之上新增 **Layer 4 协议层握手**。
- **冷启动历史回填**：bot 启动时拉取每个群最近 30 条历史,扫描握手 / 文本签名,自动回填 `known-bots-store`,解决"对方 bot 后上线"的不对称时序问题。

#### Added

- `src/utils/bot-handshake.ts`：握手消息的构造 / 解析 / 节流 / 冷启动回填逻辑。
- `botSignatureStyle` 新增 `metadata` / `none` 两个枚举值。
- `BOT_HANDSHAKE_APP` / `BOT_HANDSHAKE_KIND` / `BOT_HANDSHAKE_MIN_LENGTH` 常量。

#### Compatibility

- 旧 bot(非 v1.9+)继续按 in-band 签名 / `sender.bot` / `knownBotIds` 工作,无 breaking change。
- 协议层握手只在 openclaw-napcat v1.9+ 之间生效;新默认值 `metadata` 对老 bot 兼容(对方仍能通过持久化 cache 识别本 bot,因为握手会被老 bot 忽略但不影响)。

### v1.8.1 - 安装脚本 find 自匹配 bug (2026-06-01)

#### Fixed

- **`docker-install.sh` / `install.sh` / `update.sh` 编译/安装失败**：v1.8.0 引入的 `find ... -maxdepth 1 -type d -name "openclaw-napcat-*"` 模式会匹配 `EXTRACT_DIR` 自身（`openclaw-napcat-extract-<pid>` 也以 `openclaw-napcat-` 开头），`head -1` 取到父目录而非 `openclaw-napcat-<branch>/` 子目录，导致后续 `cd` / `mv` / `cp -r` / `npm install` 找不到源码。

  修复：find 加 `-mindepth 1` 跳过搜索根；3 个脚本都加 `SRC_DIR != EXTRACT_DIR` 断言作为回归保护。

  触发场景：所有通过 v1.8.0 脚本安装/更新的用户必现（症状为 `npm error code ENOENT ... package.json`）。

### v1.8.0 - 多 bot 协同 + 安装脚本改造 (2026-06-01)

#### 安装脚本改造（scripts/）

**改 `git clone` 为 tarball 下载**，解决以下问题：
- openclaw 容器基础镜像（node:alpine/slim）通常**没装 git**，导致 `git clone` 静默失败
- tarball 只含源码（~1-2 MB），比 `git clone --depth 1`（拉 git objects）**快 5-10 倍**
- curl 显示 HTTP 状态码和进度条，失败时用户能立即看到原因
- `tar + curl` 是所有 Linux 基础镜像的标配

改造范围：
- `scripts/docker-install.sh`：容器内热安装
- `scripts/install.sh`：宿主机安装
- `scripts/update.sh`：插件更新

新下载特性：
- 3 镜像回退（ghfast.top → gh-proxy.com → github.com）
- 每个镜像显示 HTTP 状态码和文件大小
- 验证 tarball 完整性（避免下载到 HTML 错误页）
- `-fL --connect-timeout 5 --max-time 120 -#` curl 参数组合
- 进度条 `-#` 让用户知道下载中

### v1.7.2 - 友军识别增强 + NO_REPLY 修复 (2026-05-31)

#### 新增

- **手动 bot 白名单（`knownBotIds`）**：支持手动指定已知 bot 的 QQ 号，适用于不支持签名的 bot 框架，最高优先级识别
- **签名样式配置（`botSignatureStyle`）**：可选 `visible`（默认，`[BOT:selfId]`）或 `zero-width`（零宽字符，用户不可见）
- **零宽字符签名检测**：同时支持可见 `[BOT:ID]` 和零宽字符 `​ID‌` 两种签名格式的检测
- **@其他人跳过所有触发**：当消息中 @了其他用户（非 bot）时，跳过被动模式、关键词触发、回复引用，避免误触发
- **NO_REPLY 变体支持**：支持 `NO_REPLY`、`NO_REPLY.`、`NO_REPLY!`、`NO REPLY`、`NO_REPLY` 等格式（不区分大小写）

#### 修复

- **NO_REPLY 检测增强**：修复 AI 返回带标点或空格的 NO_REPLY 变体时仍会发送消息的问题
- **@其他人误触发**：修复 @其他用户时 bot 仍会通过被动模式或关键词触发回复的问题

#### 配置项

```json
{
  "knownBotIds": [123456789, 987654321],
  "botSignatureStyle": "visible"
}
```

```yaml
QQ_KNOWN_BOT_IDS: "123456789,987654321"
QQ_BOT_SIGNATURE_STYLE: visible
```

---

### v1.7.1 - 友军识别 + 旁观模式频率控制 (2026-05-30)

#### 新增

- **友军识别（Bot-to-Bot Recognition）**：检测 `sender.bot=true` 和不可见零宽字符签名，防止多 bot 在同一群产生循环对话；`ignoreSenderBot` 默认 true，`botSuppressionMs` 默认 120 秒
- **自维护 bot ID 缓存**：不再需要手动配置 `knownBotIds`，插件通过签名检测自动发现并缓存 bot 用户 ID，跨服务器部署也能正确识别友军
- **旁观模式频率控制**：新增 `minIntervalMs`（最小触发间隔，含 [SILENT] 响应），防止 AI 被频繁调用；`botSuppressionMs` 控制友军识别抑制时长
- **智能延迟**：仅当检测到其他 bot 近期活跃时才随机延迟 0~2 秒错开处理，不拖慢正常响应
- **零宽字符签名仅群追加**：bot 签名仅在群消息中追加，私聊不追加，避免冗余
- **调试日志门控**：新增 `debug` 配置项（默认 false），开启后输出消息处理流水线的详细诊断日志，便于排查 @mention / bot 过滤 / 表情回应等问题

#### 修复

- **Docker 安装脚本支持 `QQ_ALLOWED_GROUPS` 环境变量**：`docker-setup.sh` 和 `update_json.sh` 现在可以交互式设置群组白名单

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
