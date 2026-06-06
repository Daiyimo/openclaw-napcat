<!--
Sync Impact Report
- Version change: 0.1.0 → 1.0.0 (MAJOR: initial ratification)
- Modified principles: N/A (first version)
- Added sections: Core Principles (5), Architecture, Development Workflow, Governance
- Removed sections: N/A
- Templates requiring updates:
  ✅ .specify/templates/plan-template.md — no constitution-aligned gates yet (project-specific)
  ✅ .specify/templates/spec-template.md — no mandatory sections added
  ✅ .specify/templates/tasks-template.md — no principle-driven task types yet
  ✅ .specify/templates/commands/constitution.md — this file
- Follow-up TODOs: none
-->

# OpenClaw NapCat Constitution

## Core Principles

### I. Plugin Isolation
Every module MUST be independently testable and replaceable. The QQ plugin lives
inside the OpenClaw runtime but must not depend on OpenClaw internals beyond its
published plugin API. Shared logic (retry, rate-limit, dedup) goes into internal
utils, not into gateway/outbound/admin-commands glue code.

### II. Reliability First
All external calls (NapCat HTTP API, WebSocket) MUST have timeout + exponential
backoff retry. Circuit breaker activates after consecutive failures; half-open
probe resumes automatically. No silent message loss—every send MUST be
acknowledged or logged with full context.

### III. Safety Guards (NON-NEGOTIABLE)
Bot-to-bot loop prevention is mandatory: sender.bot detection, signature-based
recognition, and configurable suppression window MUST all be in place before any
message is dispatched to the AI. Group whitelist and user blacklist MUST be
enforced at the inbound boundary, never inside AI processing.

### IV. Zero External Dependencies for Observability
Status queries, structured logs, and in-memory metrics cover 80% of production
observability needs. Prometheus/ELK/Grafana MUST NOT be introduced unless the
deployment environment already has them or scale exceeds single-host capacity
(>100 concurrent sessions). All logs MUST mask user IDs (123***) and never
output full request bodies at INFO+ level.

### V. Simplicity and Type Safety
Prefer standard library and existing project utilities over new dependencies.
All public functions MUST have TypeScript type annotations. No `any` types in
production code paths. Configuration is validated at startup; invalid config
MUST fail fast with a clear error message, not silently degrade.

## Architecture

The project follows a layered pipeline architecture:

```
inbound → dedup → blacklist/whitelist → silent-keyword → rate-limit
  → admin-command-intercept → trigger-detection → AI dispatch
    → reply-debounce → fragment/TTS/markdown → outbound
```

Each layer MUST be independently testable. New layers MUST be added at the
boundary, not injected into existing processing logic.

## Development Workflow

- Git branch model: `feature/<short-name>` from `main`
- Commit format: Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.)
- Tests: unit tests for pure logic, integration tests for I/O boundaries
- Pre-commit: lint + type-check + unit tests MUST pass
- Docker is the canonical deployment target; local-only code MUST NOT bypass
  Docker-relevant constraints (env vars, file paths, network topology)

## Governance

This constitution supersedes ad-hoc practices. Amendments require:
1. A written rationale explaining what changes and why
2. Version bump per semantic versioning: MAJOR for principle removal/redefinition,
   MINOR for new principle, PATCH for clarifications
3. Propagation to all dependent templates (plan, spec, tasks, commands)

All PRs MUST verify constitution compliance before merge. Complexity that
violates a principle MUST be justified in the plan's Complexity Tracking table.

**Version**: 1.0.0 | **Ratified**: 2026-06-06 | **Last Amended**: 2026-06-06
