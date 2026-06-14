# Tasks: Inbound Rate Limiting

**Input**: Design documents from `/specs/001-inbound-rate-limiting/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), data-model.md

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)

## Path Conventions

- Source: `src/`
- Tests: `src/__tests__/`

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

- [X] T001 [US1] Create `src/rate-limiter.ts` with `InboundRateLimiter` class (sliding window, per-user + per-group, admin exemption, zero overhead when disabled)
- [X] T002 [P] [US1] Write unit tests for `InboundRateLimiter` in `src/__tests__/rate-limiter.test.ts` covering: sliding window accuracy, per-user/per-group isolation, admin exemption, disabled mode, edge cases (5000+ keys cleanup, burst bypass prevention)

**Checkpoint**: Rate limiter module complete and tested — all user stories can now integrate it

---

## Phase 2: User Story 1 - 群聊消息洪泛保护 (Priority: P1) 🎯 MVP

**Goal**: Replace inline rate limit logic in `inbound.ts` with the new `InboundRateLimiter` module; add admin exemption

**Independent Test**: Send 100 messages at 50ms interval to bot; verify only threshold messages are processed

### Implementation for User Story 1

- [X] T003 [US1] Refactor `src/gateway/inbound.ts`: replace inline rate limit block (lines 698-721) with `InboundRateLimiter` instance; add admin check before rate limit call
- [X] T004 [US1] Verify existing config integration: `inboundRateLimitMs` from `storeConfig` passed correctly to `InboundRateLimiter`

**Checkpoint**: User Story 1 fully functional — message flood protection with sliding window and admin exemption

---

## Phase 3: User Story 2 - 管理员实时查看限流状态 (Priority: P2)

**Goal**: Add `/ratelimit` admin command to display active rate limits

**Independent Test**: Trigger rate limit, then run `/ratelimit @bot` to see blocked user with remaining cooldown

### Implementation for User Story 2

- [X] T005 [P] [US2] Add `getRateLimitStatus()` method to `InboundRateLimiter` returning formatted status of active entries
- [X] T006 [US2] Register `/ratelimit` command in `src/admin-commands.ts` with output: active limits list, remaining cooldown, trigger counts

**Checkpoint**: User Story 2 independently functional — admins can inspect rate limit state

---

## Phase 4: User Story 3 - 管理员手动解除限流 (Priority: P2)

**Goal**: Add `/unratelimit <target>` admin command to clear a specific rate limit

**Independent Test**: Trigger rate limit, run `/unratelimit <userId>`, verify immediate unblock

### Implementation for User Story 3

- [X] T007 [P] [US3] Add `clearLimit(target: string)` method to `InboundRateLimiter`
- [X] T008 [US3] Register `/unratelimit <target>` command in `src/admin-commands.ts` with friendly error for non-existent targets

**Checkpoint**: User Story 3 independently functional — admins can manually clear rate limits

---

## Phase 5: User Story 4 - 配置热重载保留限流状态 (Priority: P3)

**Goal**: Ensure `InboundRateLimiter` state survives `/reload` without resetting active cooldowns

**Independent Test**: Trigger rate limit, reload config, verify cooldown continues

### Implementation for User Story 4

- [X] T009 [US4] Verify `InboundRateLimiter` is instantiated once and shared across config reloads (not recreated); add test for state persistence across config update

**Checkpoint**: All user stories complete and independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T010 [P] Update `src/constants.ts` if any rate-limit-related constants needed (not needed — config handles it)
- [X] T011 Run existing test suite to verify no regressions (758 tests pass)
- [X] T012 Update `docs/CONFIG.md` and `docs/COMMANDS.md` with `inboundRateLimitMs`, `silentKeywords`, `/ratelimit`, `/unratelimit` documentation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — can start immediately
- **User Stories (Phase 2+)**: All depend on Foundational phase completion
  - US1 (P1) → MVP
  - US2 (P2) → after US1
  - US3 (P2) → after US1
  - US4 (P3) → after Foundational (no dependency on US1-3)

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Core module before integration
- Story complete before moving to next priority

### Parallel Opportunities

- T001 (rate-limiter.ts) and T002 (tests) can be written in parallel after T001's API is defined
- T005 (getRateLimitStatus) and T007 (clearLimit) can run in parallel
- T006 and T008 (admin commands) can run in parallel after their respective methods exist
