# Multi-agent-flow — Execution Ledger

A small standalone, provider-neutral service for **observing agent executions**, collecting evidence and answering status queries. It does not schedule, claim, resume or route agents.

## Core design
- GitHub Issues remains the source of truth for tasks; the existing dispatcher owns claims/leases/decisions.
- Hierarchy: work item → run → specialist attempts → immutable events, artifacts and usage records.
- A deterministic endpoint validates events and updates SQLite atomically.
- A wrapper captures lifecycle and output automatically; optional specialist checkpoints improve detail.
- A read-only CLI/API and minimal dashboard show the current status and history.
- Ledger failure must not block agents: senders spool events with stable IDs for retry.
- No agent API can dispatch or control other agents.

## Specification
- [Architecture and lifecycle](docs/architecture.md)
- [SQL schema](db/001_init.sql)
- [HTTP API](docs/api.md)
- [Integration plan](docs/integration.md)
- [Verification plan](docs/verification.md)

## Proposed stack
TypeScript, Node.js LTS, Fastify, Zod, better-sqlite3, SQLite WAL, parameterized SQL (no ORM), gzip-compressed JSONL artifacts, a plain read-only HTML/JS status page.

## Delivery phases
1. Freeze design and testable contracts.
2. Implement standalone API, SQLite migrations, CLI, artifact capture and UI.
3. Run isolated build/API/restart/concurrency/failure tests.
4. Only then integrate into the existing multi-agent dispatcher and specialist wrappers.

**Safety:** no live secrets, prompts or raw private sessions should be uploaded until authorization, redaction, backups and retention have been tested.
