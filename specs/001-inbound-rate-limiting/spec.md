# Feature Specification: Inbound Rate Limiting

**Feature Branch**: `feature/inbound-rate-limiting`

**Created**: 2026-06-06

**Status**: Draft

**Input**: User description: "Add inbound rate limiting to protect the bot from message floods and abusive users. Currently QQ_INBOUND_RATE_LIMIT_MS exists in config but is not implemented."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 群聊消息洪泛保护 (Priority: P1)

当某个用户或群在短时间内发送大量消息时，系统自动限流，超出部分被静默丢弃，不会影响 AI 处理队列或触发不必要的气泡回复。

**Why this priority**: 消息洪泛是最常见的滥用场景，不处理会导致 bot 响应变慢、API 配额耗尽、甚至被 QQ 限流封号。这是安全基线。

**Independent Test**: 用测试脚本向 bot 发送 100 条消息（间隔 50ms），验证 bot 只处理了阈值内的消息，后续被静默丢弃。

**Acceptance Scenarios**:

1. **Given** bot 处于正常运行状态，入站限流窗口为 1000ms 且最大 5 条，**When** 同一用户在 1 秒内发送 10 条消息，**Then** 只处理前 5 条，其余静默丢弃，不产生 AI 调用。
2. **Given** 用户 A 触发限流，**When** 用户 B 发送消息，**Then** 用户 B 的消息正常处理，不受影响。

---

### User Story 2 - 管理员实时查看限流状态 (Priority: P2)

管理员可以通过 `/ratelimit` 命令查看当前所有被限流的用户/群列表、剩余冷却时间、以及累计触发次数。

**Why this priority**: 管理员需要可见性来判断是否有人在恶意攻击，以及限流参数是否需要调整。

**Independent Test**: 触发限流后执行 `/ratelimit` 命令，输出包含被限流 ID、触发时间、剩余冷却时间。

**Acceptance Scenarios**:

1. **Given** 用户 123 已被限流，**When** 管理员发送 `/ratelimit`，**Then** 输出 `123: 冷却中 (剩余 3.2s, 已触发 2 次)`。
2. **Given** 无活跃限流，**When** 管理员发送 `/ratelimit`，**Then** 输出 `当前无活跃限流`。

---

### User Story 3 - 管理员手动解除限流 (Priority: P2)

管理员可以通过 `/unratelimit <user/group>` 命令手动解除某个用户或群的限流状态，无需等待冷却窗口自然结束。

**Why this priority**: 误判场景需要快速恢复，避免正常用户被误伤后长时间无法交互。

**Independent Test**: 触发限流后执行 `/unratelimit 123`，用户 123 立即恢复消息处理。

**Acceptance Scenarios**:

1. **Given** 用户 123 正在限流冷却中，**When** 管理员发送 `/unratelimit 123`，**Then** 用户 123 的下一条消息被正常处理。
2. **Given** 用户 123 未被限流，**When** 管理员发送 `/unratelimit 123`，**Then** 输出 `用户 123 当前未被限流`（友好的空操作）。

---

### User Story 4 - 配置热重载保留限流状态 (Priority: P3)

修改 `QQ_INBOUND_RATE_LIMIT_MS` 配置后执行 `/reload`，新参数立即生效，但已有的限流状态（正在冷却的用户）不丢失。

**Why this priority**: 配置热重载是现有功能，限流状态不应成为它的例外。

**Independent Test**: 触发限流后修改配置并执行 `/reload`，验证冷却倒计时继续而不重置。

**Acceptance Scenarios**:

1. **Given** 用户 123 处于限流冷却剩余 5s，**When** 管理员修改配置并执行 `/reload`，**Then** 冷却继续倒计时，最终正常解除。
2. **Given** 用户 123 处于限流冷却剩余 5s，**When** 管理员将窗口从 1000ms 改为 500ms 并执行 `/reload`，**Then** 新窗口对后续消息生效，当前冷却不受影响。

---

### Edge Cases

- 当 `QQ_INBOUND_RATE_LIMIT_MS` 为 0 或未配置时，限流完全禁用，所有消息正常通过。
- 限流作用于 inbound 流水线的哪个阶段？应在黑白名单检查之后、触发检测之前，确保安全管控不受限流影响。
- 管理员消息是否豁免限流？是——admins 列表中的 QQ 号不参与限流计数。
- 群限流 vs 用户限流：同时支持两种粒度。群限流针对该群内所有非管理员用户的总消息数。
- 重启后限流状态是否需要持久化？否——cold start 时无活跃限流是合理行为。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support per-user inbound rate limiting with configurable message count and time window.
- **FR-002**: System MUST support per-group inbound rate limiting with the same configurable parameters.
- **FR-003**: Administrators (as defined by `QQ_ADMINS`) MUST be exempt from rate limiting.
- **FR-004**: Rate-limited messages MUST be silently dropped—no error reply, no AI dispatch, no log spam at INFO level.
- **FR-005**: System MUST provide `/ratelimit` admin command to list active rate limits with remaining cooldown.
- **FR-006**: System MUST provide `/unratelimit <target>` admin command to manually clear a rate limit.
- **FR-007**: Rate limit state MUST survive config hot-reload (`/reload`) without resetting active cooldowns.
- **FR-008**: When `QQ_INBOUND_RATE_LIMIT_MS` is 0 or absent, rate limiting MUST be completely disabled (zero overhead).
- **FR-009**: Rate limit counters MUST use sliding window algorithm, not fixed window, to prevent burst bypass.
- **FR-010**: Rate limit logic MUST be implemented as a standalone module in the inbound pipeline, testable without OneBot or AI dependencies.

### Key Entities

- **RateLimitConfig**: `{ windowMs: number, maxMessages: number }` — configuration for a single rate limit scope
- **RateLimitEntry**: `{ count: number, windowStart: number, blockedCount: number }` — runtime state for one tracked entity
- **RateLimitScope**: `"user"` | `"group"` — whether the limit applies per-user or per-group
- **InboundRateLimiter**: Core module managing all rate limit state, providing `check(userId, groupId): { allowed: boolean, retryAfterMs?: number }`

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Bot 处理入站消息的吞吐量在限流激活时保持稳定，不会因限流逻辑本身引入 >5ms 的延迟增量。
- **SC-002**: 在 100 条/秒的消息洪泛测试中，bot 仅处理配置允许的消息数，其余被静默丢弃，无异常抛出。
- **SC-003**: 管理员可通过 `/ratelimit` 在 1 秒内获取完整限流状态。
- **SC-004**: 限流模块的单元测试覆盖率达到 90% 以上（不含 I/O 适配层）。
- **SC-005**: 配置 `QQ_INBOUND_RATE_LIMIT_MS=0` 时，限流模块对吞吐量的影响 <1ms per message（零路径）。

## Assumptions

- 入站频控的粒度以用户 QQ 号（userId）和群号（groupId）为单位，不以 IP 或其他标识符。
- 限流作用于 message 事件层面，不作用于其他事件类型（notice, request）。
- 群限流统计该群内所有非管理员用户的消息总和，管理员消息不计入。
- 滑动窗口的精度以毫秒为单位，不需要亚毫秒精度。
- 限流状态不持久化到磁盘——冷启动后无活跃限流是可接受行为。
- `QQ_INBOUND_RATE_LIMIT_MS` 作为总开关：值为 0 = 禁用；非 0 = 同时启用用户限流和群限流（两者参数相同，从同一配置派生）。
