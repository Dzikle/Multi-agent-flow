# Execution Ledger v1 architecture

## Authority boundary

**GitHub** owns tasks and project status. **Existing dispatcher** owns locks, claims, routing, retries, resume and completion decisions. **Ledger** only observes and stores evidence. Ledger downtime must not block execution.

Single always-on Node server, SQLite database on local disk (WAL, foreign keys, busy timeout), authenticated private HTTP, and separate compressed artifact directory. Agent wrappers and CLI use HTTP; only server process opens SQLite. No queue, ORM, OpenSearch, Redis, Paperclip or Langfuse required.

## Six domain tables

- work_items: external reference, unique source/repository/external_id; title only cached.
- runs: a **single execution** for a work item. Rerun means new run ID, even on same issue.
- attempts: one specific specialist **process invocation**. Retries always create new attempt IDs. Optional parent_attempt_id describes nested specialist work.
- events: append-only, unique event_id with content hash; server-assigned seq and recorded_at; references run and/or attempt, or neither for scheduler tick.
- artifacts: metadata + SHA-256 for stored logs or evidence; raw bytes live outside SQLite.
- usage_samples: provider-sourced tokens and micro-USD charges; NULL = unknown, not 0.

Run_id, attempt_id and event_id are opaque IDs assigned by the dispatcher/wrapper. Never infer them from issue numbers or timestamps. A run may contain concurrent attempts. Event sequence reflects **server commit order**, while occurred_at is the optional producer clock value.

## Lifecycle and transitions

Run statuses: created -> running; running -> waiting | blocked | completed | failed | cancelled; waiting/blocked -> running; completed/failed/cancelled terminal. A run's latest phase is separate from its status.

Attempt statuses: running -> succeeded | failed | interrupted | timed_out | cancelled. All terminal statuses immutable. Failure of QA attempt does **not** fail a run; dispatcher may retry using a new developer attempt. Only dispatcher token closes or blocks/resumes runs.

A heartbeat updates last_heartbeat_at, never status. Read APIs may derive suspected_stale if age exceeds configured threshold. This is **diagnostic**, not automatic failure nor permission to take ownership.

## Deterministic ingestion

1. Authenticate and validate payload against exact event type schema.
2. Canonicalize/hash incoming event to distinguish same-ID replay from conflict.
3. In SQLite transaction: check existing event_id; if identical return original seq; if different reject 409.
4. Validate parent references, same-run relationships, phase/state transition and role permissions.
5. Apply projection to work_items/runs/attempts, append immutable event, commit.
6. ACK only after commit. Duplicate reply is 200; new commit 201.

No arbitrary SQL, dynamic table name or caller-controlled updates. All SQL parameterized, all state transitions centrally tested. Errors and authentication failures must never be persisted as successful lifecycle events.

## Collection and failure handling

Dispatcher wrapper automatically emits attempt.started before launch and attempt terminal outcome after process exit; periodic heartbeat comes from wrapper, not model. Optional agent checkpoints can add attempt.progress. Capture stdout/stderr and supported structured JSONL locally as chunks, redact secrets, compress and upload with stable artifact IDs. Never rely on a final agent tool call: crashes/quotas may prevent it.

If the network fails, write events into a local durable spool; retry with unchanged event IDs in original order. Artifacts similarly retry; send checksums and accept duplicate IDs only for identical content. A crash leaves local log chunks/spool for recovery. Status endpoints show last confirmed event and heartbeat freshness separately.

## Security, privacy and operations

- Private Tailscale-first deployment, TLS for external exposure.
- v1 uses separate read and dispatcher credentials (dispatcher also downloads artifacts). Per-attempt specialist credentials are a future enhancement. Bearer tokens supplied through environment/secrets; never put credentials into prompts, logs, query params or repo.
- Redact sensitive content before transfer; v1 trusts an explicit sanitized declaration but does not yet independently redact the artifact. Avoid hidden reasoning, raw secrets, personal data. Limit event size, artifact size and upload concurrency. Use server-chosen artifact paths.
- WAL backup via supported SQLite backup API or VACUUM INTO; back up artifact files alongside DB; configurable retention and health checks.
- Correlate errors using sanitized type codes; distinguish qa-harness from code, infra, quota and model errors.
- Event history append-only; projections can be audited and rebuilt from events in a future maintenance tool.

## UI

Initial read-only table: issue, run ID, status, latest phase, active specialist, model, last event time, heartbeat freshness, outcome. Clicking a run shows attempts and ordered events. Poll every 5-10 seconds; do not make UI the authority for state or build a new Kanban.

## Out of scope

No control plane, task queue, agent scheduling, marketplace adapters, GitHub project synchronization, log-based automatic code evaluation or multi-tenant billing.
