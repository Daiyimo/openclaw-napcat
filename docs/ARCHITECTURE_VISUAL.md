# napcat-qq 插件 - 系统架构图 (GitHub 兼容版)

## 1. 整体架构图

```mermaid
graph TB
    subgraph "QQ 用户层"
        USER[QQ 用户]
        GROUP[QQ 群组]
        GUILD[QQ 频道]
    end

    subgraph "OneBot 协议层"
        NAPCAT[NapCat Server]
        NAPCAT_API[HTTP API]
        NAPCAT_WS[WebSocket]
        NAPCAT_RWS[反向 WS]
    end

    subgraph "OpenClaw 框架层"
        GATEWAY[OpenClaw Gateway]
        ROUTER[路由管理器]
        AI_SVC[AI 模型服务]
        REPLY_DISP[回复分发器]
    end

    subgraph "napcat-qq 插件层"
        CHANNEL[ChannelPlugin]

        subgraph "gateway"
            START_ACC[startAccount]
            CONN_MGR[连接管理器]
            EVENT_HANDLER[事件处理器]
        end

        subgraph "outbound"
            SEND_TEXT[sendText]
            SEND_MEDIA[sendMedia]
            DISPATCH[dispatchMessage]
        end

        subgraph "config"
            CONFIG_SCHEMA[QQConfigSchema]
            ACCOUNT_RESOLVE[resolveAccount]
        end

        subgraph "status"
            PROBE[probeAccount]
            SNAPSHOT[buildAccountSnapshot]
        end

        subgraph "核心功能"
            RATE_LIMIT[消息限流器<br/>4次/小时]
            ERROR_NOTIFY[错误通知]
            SMART_REACT[智能交互]
        end
    end

    subgraph "OneBot 客户端层"
        CLIENT[OneBotClient]
        WS_CONN[WebSocket 连接]
        HTTP_CLI[HTTP 客户端]
        REV_WS_SVR[反向 WS 服务器]
        HEARTBEAT[心跳检测]
    end

    subgraph "配置文件"
        OPENCLAW_JSON[openclaw.json]
        PLUGIN_JSON[openclaw.plugin.json]
    end

    USER -->|发送消息| NAPCAT_WS
    GROUP -->|发送消息| NAPCAT_WS
    GUILD -->|发送消息| NAPCAT_WS

    NAPCAT_RWS -->|连接| REV_WS_SVR
    REV_WS_SVR -->|emit| EVENT_HANDLER

    NAPCAT_API -->|HTTP| HTTP_CLI
    HTTP_CLI -->|send_private_msg| USER
    HTTP_CLI -->|send_group_msg| GROUP

    GATEWAY -->|registerChannel| CHANNEL
    ROUTER -->|create session| REPLY_DISP

    START_ACC -->|new| CONN_MGR
    CONN_MGR -->|new| CLIENT
    CLIENT -->|on| EVENT_HANDLER

    EVENT_HANDLER -->|检查| RATE_LIMIT
    EVENT_HANDLER -->|智能交互| SMART_REACT
    EVENT_HANDLER -->|调用| AI_SVC
    AI_SVC -->|生成| REPLY_DISP
    REPLY_DISP -->|调用| SEND_TEXT
    SEND_TEXT -->|使用| DISPATCH
    DISPATCH -->|选择| HTTP_CLI

    EVENT_HANDLER -->|异常| ERROR_NOTIFY
    ERROR_NOTIFY -->|sendPrivateMsg| NAPCAT_API

    PROBE -->|connect| CLIENT

    PLUGIN_JSON -->|configSchema| CONFIG_SCHEMA
    CONFIG_SCHEMA -->|验证| OPENCLAW_JSON
    OPENCLAW_JSON -->|读取| ACCOUNT_RESOLVE

    CLIENT -.->|uses| WS_CONN
    CLIENT -.->|uses| HTTP_CLI
    CLIENT -.->|uses| REV_WS_SVR
    CLIENT -.->|uses| HEARTBEAT

    CHANNEL -.->|imports| CLIENT
    CHANNEL -.->|imports| CONFIG_SCHEMA
    CHANNEL -.->|uses| RATE_LIMIT
```

## 2. 消息处理详细时序图

```mermaid
sequenceDiagram
    actor 用户 as 用户 (QQ)
    participant NapCat as NapCat Server
    participant RWS as 反向 WS 服务器
    participant Client as OneBotClient
    participant Handler as 事件处理器
    participant RateLimiter as 限流器
    participant AI as AI 服务
    participant Outbound as outbound
    participant HTTP as HTTP API

    Note over 用户,NapCat: 1. 用户发送消息
    用户->>NapCat: 发送群聊消息 @机器人

    Note over NapCat,RWS: 2. NapCat 推送事件
    NapCat->>RWS: WebSocket 推送
    RWS->>Client: ws.on("message")
    Client->>Handler: emit("message", event)

    Note over Handler,RateLimiter: 3. 消息预处理
    Handler->>Handler: 过滤自消息、去重
    Handler->>Handler: 提取 userId, groupId

    alt autoMarkRead = true
        Handler->>NapCat: markGroupMsgAsRead
    end

    alt enableReactions = true
        Handler->>NapCat: set_msg_emoji_like
    end

    Note over Handler,RateLimiter: 4. 限流检查
    Handler->>RateLimiter: checkMessageReplyLimit
    RateLimiter-->>Handler: { allowed, remaining }

    alt 限流通过
        Note over Handler,AI: 5. AI 生成回复
        Handler->>AI: 调用 LLM
        AI-->>Handler: 回复文本

        Note over Handler,Outbound: 6. 发送回复
        Handler->>Outbound: deliver({ text })
        Outbound->>Outbound: parseTarget, splitMessage
        Outbound->>HTTP: send_group_msg

        HTTP->>NapCat: POST /send_group_msg
        NapCat-->>HTTP: { status: "ok" }
        HTTP-->>Outbound: 成功

        Outbound->>RateLimiter: recordMessageReply
        RateLimiter->>RateLimiter: count++
    else 限流超限
        Handler->>Handler: 发送限流提示
    end

    Note over NapCat,用户: 7. 用户收到回复
    NapCat->>用户: 显示消息

    alt 发生异常
        rect rgb(255, 200, 200)
            Note over Handler: 异常捕获
            Handler->>Handler: catch(err)
            Handler->>Handler: 检查配置
            Handler->>NapCat: sendPrivateMsg(adminId, 错误通知)
        end
    end
```

## 3. 消息限流机制

```mermaid
graph LR
    A[收到消息<br/>message_id] --> B{有记录?}
    B -->|否| C[创建记录<br/>count=1]
    B -->|是| D{超过1小时?}
    D -->|是| C
    D -->|否| E{count < 4?}
    E -->|是| F[允许<br/>count++]
    E -->|否| G[拒绝<br/>limit exceeded]

    C --> F
    F --> H[记录成功]
    G --> I[提示限流]

    subgraph "定期清理"
        CLEAN[cleanup<br/>每小时] -->|删除| EXPIRED[过期记录]
    end
```

## 4. 错误通知流程

```mermaid
graph TD
    START[异常] --> CATCH
    CATCH --> LOG[记录日志]
    LOG --> CHECK1{enableErrorNotify}
    CHECK1 -->|否| END1[忽略]
    CHECK1 -->|是| CHECK2{admins列表}
    CHECK2 -->|空| END1
    CHECK2 -->|有| FORMAT[格式化错误信息]
    FORMAT --> MSG[准备通知消息]
    MSG --> LOOP[遍历每个admin]
    LOOP --> SEND[发送私聊]
    SEND --> WAIT[等待500ms]
    WAIT --> NEXT{还有下一个}
    NEXT -->|是| LOOP
    NEXT -->|否| END2[完成]
```

## 5. 智能交互逻辑

```mermaid
graph TD
    RECEIVE[收到消息] --> DECIDE{触发类型}

    DECIDE -->|群聊| CHECK{"@机器人"}
    CHECK -->|是| PROCESS
    CHECK -->|否| KEY{关键词}
    KEY -->|是| PROCESS
    KEY -->|否| IGNORE

    DECIDE -->|私聊| PROCESS

    PROCESS --> AUTO{autoMarkRead}
    AUTO -->|是| MARK
    AUTO -->|否| REACT{enableReactions}

    REACT -->|是| ANALYZE
    REACT -->|否| AI_CALL

    ANALYZE --> MATCH{关键词匹配}
    MATCH -->|查找| EMOJI1[👌]
    MATCH -->|感谢| EMOJI2[🙏]
    MATCH -->|悲伤| EMOJI3[😢]
    MATCH -->|开心| EMOJI4[😊]
    MATCH -->|默认| EMOJI5[🐱]

    EMOJI1 --> REACT_ACTION
    EMOJI2 --> REACT_ACTION
    EMOJI3 --> REACT_ACTION
    EMOJI4 --> REACT_ACTION
    EMOJI5 --> REACT_ACTION

    AI_CALL --> RESPONSE
    RESPONSE --> SEND
```

## 6. 配置项全景图

```mermaid
graph TD
    CONFIG[openclaw.json] --> CATEGORY1[核心配置]
    CONFIG --> CATEGORY2[功能开关]
    CONFIG --> CATEGORY3[风控优化]
    CONFIG --> CATEGORY4[管理限制]
    CONFIG --> CATEGORY5[AI配置]

    CATEGORY1 --> WS[wsUrl]
    CATEGORY1 --> HTTP[httpUrl]
    CATEGORY1 --> PORT[reverseWsPort]
    CATEGORY1 --> TOKEN[accessToken]

    CATEGORY2 --> MENTION[requireMention]
    CATEGORY2 --> DEDUP[enableDeduplication]
    CATEGORY2 --> ERROR[enableErrorNotify]
    CATEGORY2 --> REACT[enableReactions]
    CATEGORY2 --> READ[autoMarkRead]
    CATEGORY2 --> TTS[enableTTS]
    CATEGORY2 --> GUILD[enableGuilds]

    CATEGORY3 --> RATE[rateLimitMs]
    CATEGORY3 --> LEN[maxMessageLength]
    CATEGORY3 --> MD[formatMarkdown]
    CATEGORY3 --> RISK_MODE[antiRiskMode]

    CATEGORY4 --> ADMIN_LIST[admins数组]
    CATEGORY4 --> GROUPS[allowedGroups]
    CATEGORY4 --> BLOCK[blockedUsers]
    CATEGORY4 --> HISTORY[historyLimit]
    CATEGORY4 --> KEYWORDS[keywordTriggers]

    CATEGORY5 --> PROMPT[systemPrompt]
    CATEGORY5 --> VOICE[aiVoiceId]
```

---

## 使用说明

以上图表使用 **Mermaid** 语法，GitHub 会自动渲染。如果某个图表无法显示，可能是：

1. **语法过于复杂** - 已简化处理
2. **emoji 符号** - 部分图表保留了简单表情，应该兼容
3. **HTML 标签** - 已全部替换为 `\n`

如果仍有问题，可以访问 [Mermaid Live Editor](https://mermaid.live) 粘贴代码查看完整渲染效果。

## 关键文件

| 文件 | 说明 | 行数 |
|------|------|------|
| src/channel.ts | 主插件实现 | ~1000 |
| src/client.ts | OneBot 客户端 | ~400 |
| src/config.ts | Zod Schema | ~30 |
| openclaw.plugin.json | 插件元数据 | ~140 |

---

**基于 `napcat-qq` 分支当前代码**

