# Implementation Plan: Inbound Rate Limiting

**Branch**: `feature/inbound-rate-limiting` | **Date**: 2026-06-06 | **Spec**: [spec.md](../001-inbound-rate-limiting/spec.md)

## Summary

基于已有的 `inboundRateLimitMs` 配置字段，将当前简单的 last-timestamp cooldown 升级为滑动窗口算法，新增 per-group 粒度、管理员豁免、以及 `/ratelimit` 和 `/unratelimit` 管理命令。

## Technical Context

**Language/Version**: TypeScript (Node.js, ESM)
**Primary Dependencies**: 标准库 + 项目已有 Zod (config 验证) + vitest (测试)
**Storage**: 内存 Map (inboundStore.lastTrigger)，不持久化
**Testing**: vitest (项目已有，`src/__tests__/`)
**Target Platform**: Node.js 20+ (Docker 容器内)
**Project Type**: OpenClaw 插件 (channel adapter)
**Performance Goals**: 限流检查 <1ms per message (热路径)
**Constraints**: 不引入新依赖；滑动窗口精度 ms 级；最大 5000 活跃 key
**Scale/Scope**: 单进程内多账号场景；每个账号独立限流状态

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Plugin Isolation | PASS | 新模块独立于 OneBot/AI 依赖，纯函数 |
| II. Reliability First | PASS | 滑动窗口保证精确限流，无 burst bypass |
| III. Safety Guards | PASS | 管理员豁免，安全门控不受影响 |
| IV. Zero External Deps | PASS | 纯内存实现，无新依赖 |
| V. Simplicity & Type Safety | PASS | 单一职责模块，完整类型注解 |

## Project Structure

### Documentation (this feature)

```text
specs/001-inbound-rate-limiting/
├── spec.md              # 功能规格（已完成）
├── plan.md              # 本文件
├── research.md          # 现有实现分析（本文件合并）
├── data-model.md        # 限流数据结构
└── tasks.md             # 待 /speckit.tasks 生成
```

### Source Code (repository root)

```text
src/
├── rate-limiter.ts              # [NEW] 核心限流模块（滑动窗口）
├── gateway/inbound.ts           # [MODIFY] 接入限流器 + 管理员豁免
├── admin-commands.ts            # [MODIFY] 新增 /ratelimit /unratelimit
├── config.ts                    # [NO CHANGE] inboundRateLimitMs 已存在
├── constants.ts                 # [NO CHANGE]
└── __tests__/
    └── rate-limiter.test.ts     # [NEW] 限流器单元测试
```

**Structure Decision**: 单一文件 `rate-limiter.ts`，与 `deliver-debounce.ts` 同级，保持 inbound pipeline 的插件化风格。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 滑动窗口 vs 简单 cooldown | 简单 cooldown 在窗口边界处允许 burst（如 1000ms 窗口下，用户可在 1001ms 瞬间发 2 条），滑动窗口精确防止 | 简单 cooldown 无法防御 burst attack |
| 独立模块 vs inline | 现有 inline 实现无法测试，且 per-user + per-group 双粒度需要共享逻辑 | 内联代码无法复用，测试覆盖率 < 30% |
