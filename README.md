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
- [Local build, smoke requests and PowerShell guide](docs/quickstart.md)

## Proposed stack
TypeScript, Node.js LTS, Fastify, Zod, better-sqlite3, SQLite WAL, parameterized SQL (no ORM), gzip-compressed JSONL artifacts, a plain read-only HTML/JS status page.

## Build and run

On branch feat/execution-ledger-v1, install Node.js 22+, then run:

~~~bash
npm install
npm run build
npm test
~~~

Set unique LEDGER_DISPATCHER_TOKEN and LEDGER_READ_TOKEN environment variables (at least 16 characters, different values), then start with npm run dev. In another terminal set LEDGER_URL and LEDGER_TOKEN to your running endpoint and dispatcher token, then run npm run smoke. See docs/quickstart.md for exact Linux and PowerShell commands.

## Delivery phases
1. Freeze design and testable contracts.
2. Implement standalone API, SQLite migrations, CLI, artifact capture and UI.
3. Run isolated build/API/restart/concurrency/failure tests.
4. Only then integrate into the existing multi-agent dispatcher and specialist wrappers.

**Safety:** no live secrets, prompts or raw private sessions should be uploaded until authorization, redaction, backups and retention have been tested.
