# Data Model: Inbound Rate Limiting

## Entities

### RateLimitConfig

限流器配置，由 `QQConfig.inboundRateLimitMs` 转换而来。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `windowMs` | `number` | 滑动窗口大小（ms），`0` = 禁用 |
| `maxMessages` | `number` | 窗口内允许的最大消息数 |

### RateLimitResult

单次限流检查结果，由 `InboundRateLimiter.check()` 返回。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `allowed` | `boolean` | 是否允许通过 |
| `retryAfterMs` | `number` | 被限流时的剩余等待时间（ms），`allowed=true` 时为 `0` |
| `currentCount` | `number` | 当前窗口内已发送的消息数 |

### ActiveRateLimit

活跃限流条目，由 `getActiveLimits()` 返回，用于 `/ratelimit` 命令展示。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `target` | `string` | 限流目标标识（格式：`user:xxx` 或 `group:xxx`） |
| `retryAfterMs` | `number` | 剩余冷却时间（ms） |
| `count` | `number` | 窗口内已发送消息数 |
| `blockedTotal` | `number` | 累计被限流次数 |

### InboundRateLimitStore

入站限流存储，挂载在 `InboundContext.inboundStore` 上，与 `config-watcher` 的 `ConfigRef` 共享同一个 `config` 对象引用。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `lastTrigger` | `Map<string, number>` | 旧版触发时间戳（已弃用，保留用于向后兼容） |
| `processedMsgIds` | `Set<string>` | 消息去重集合 |
| `rateLimiter` | `InboundRateLimiter` | 滑动窗口限流器实例 |
| `config` | `QQConfig` | 当前配置对象（与 `InboundContext.config` 指向同一引用） |

## InboundRateLimiter 内部状态

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `config` | `RateLimitConfig` | 限流配置（`windowMs`、`maxMessages`） |
| `windows` | `Map<string, number[]>` | key → 窗口内时间戳数组（已过期的已清理） |
| `blockedCounts` | `Map<string, number>` | key → 累计被限流次数 |
| `admins` | `Set<string>` | 管理员 QQ 号集合（免限流） |

### Key 格式

- 用户级：`user:${userId}`（如 `user:12345`）
- 群级：`group:${groupId}`（如 `group:88888`）
- `/unratelimit` 支持纯数字输入，自动补全为 `user:${target}`

### 限流检查逻辑

1. `windowMs <= 0` → 禁用模式，直接放行
2. `isAdmin === true` → 管理员豁免，直接放行
3. 检查用户级 `user:${userId}` → 取最差结果
4. 检查群级 `group:${groupId}` → 取最差结果
5. 两者都通过 → 记录时间戳到 `windows`

### 生命周期

- **创建**：`channel.ts` 在 `startAccount` 时创建 `InboundRateLimiter` 实例，传入 `inboundRateLimitMs` 和初始 admins
- **热重载**：`handleReload` 调用 `updateWindowMs()` 和 `updateAdmins()`，不重建实例，保留活跃 cooldowns
- **清理**：`_enforceKeyLimit()` 在 `record()` 后执行，活跃 key 超过 `MAX_ACTIVE_KEYS`（5000）时清理最旧的 `CLEANUP_BATCH`（1000）个

### 与消息管道的关系

```
filter.ts    → 过滤阶段，不涉及限流
trigger.ts   → 触发检测阶段，执行 check() + record()
inbound.ts   → 消息处理主流程（已移除重复限流块）
```

限流检查与记录只在 `trigger.ts` 中执行一次，避免重复计数。
