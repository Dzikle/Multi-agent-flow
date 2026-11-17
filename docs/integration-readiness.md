# Execution Ledger V1 integration readiness

Verdict: **PASS WITH LIMITATIONS** for the standalone service. Its core metadata lifecycle is ready for a separate, controlled integration pilot after the wrapper requirements below are implemented and tested. Real session-log uploads remain disabled. This task made no changes to the dispatcher, specialist wrappers, Licitacija.mk, GitHub Projects or Trello.

Evidence: [verification report](verification-report.md), [final commands and exit codes](verification-evidence/final/commands.json), [real HTTP responses](verification-evidence/final/standalone/http.json), and [actual browser verification](verification-evidence/browser/README.md). Verification used Node 22.23.5 on Windows and a single loopback server; it does not establish production throughput or multi-host failover.

## Authority and ownership

GitHub remains authoritative for task state. The existing dispatcher alone owns claims, leases, execution control, routing, retries, resuming agents and completion decisions. SQLite stores ledger metadata and projections. Events are immutable; raw artifact bytes live outside SQLite. CLI and dashboard query the same HTTP API. Ledger availability must never become a prerequisite for doing agent work.

The service has no start/stop/claim/resume-agent endpoint or dashboard control. A `run.resumed` event records an external decision; it never resumes a process. A stale heartbeat only reports uncertainty. A failed QA attempt never automatically fails the run.

## Verified endpoint surface

| Endpoint | Verified behavior |
| --- | --- |
| `GET /health` | Unauthenticated minimal health, actual SQLite access, clean initialization and restart |
| `POST /v1/events` | Full coordinator/developer/reviewer/QA/correction lifecycle; unique IDs; ordered commits; rollback on invalid transitions/references; identical retry ACK; changed same-ID 409; concurrent retries |
| `GET /v1/runs`, `GET /v1/runs/:id` | Active/completed runs, distinct phase/status, all attempts including failure, latest event and artifact metadata |
| `GET /v1/attempts/:id` | Current state plus bounded ordered history; signed/unsigned Windows process crash codes retained |
| `GET /v1/events` | Global/run/attempt ordering and cursor continuation; dashboard exact-500 and 501-event boundaries |
| `GET /v1/agents/active` | Independent concurrent specialists, heartbeat ages and suspected stale without stored status mutation |
| `GET /v1/issues` | Multiple execution records mapped to a synthetic GitHub issue, same data as CLI |
| `POST /v1/usage`, `GET /v1/usage/summary` | Multiple providers/specialists, token/cache measurements, explicit estimates vs provider charges, NULL unknowns, coverage, duplicate and conflict behavior |
| `POST /v1/artifacts`, `GET /v1/artifacts/:id` | Opt-in only; synthetic bytes, SHA-256, gzip transport, bounds, ownership/access, metadata immutability, interrupted upload and recoverable file/metadata crash boundary |
| `GET /` | Actual Chrome desktop/mobile auth, read-only data, attempts/events, refresh/polling, API outage feedback and recovery |

These checks verify the exercised scenarios, not every possible state combination or production failure mode. See [API contract](api.md) for limits and cursor handling. Run/issue details and active-attempt lists are not yet paginated; the current dashboard lists up to 100 runs and shows up to 500 selected-run events with an explicit continuation cursor.

## Dispatcher emission contract for the next phase

1. Emit `system.tick` for a scheduler observation; `system.idle` when no task is selected, or `system.error` with a sanitized diagnostic. These have no run/attempt ID.
2. After its existing authoritative issue claim succeeds, allocate a new opaque run ID and emit `run.created` with `{source:"github", repository, external_id}`; then `run.started`. A rerun of the same issue uses a new run ID.
3. Allocate a distinct attempt ID for every invocation, including correction/reviewer/QA retries. Supply the ID and run context to the trusted wrapper; agree on exactly one producer for each lifecycle event.
4. Emit `run.waiting`, `run.blocked`, `run.resumed`, or the final `run.completed`/`run.failed`/`run.cancelled` only to record decisions the dispatcher already made. Settle running attempts before terminal run events. Finalization with active attempts is rejected.

Never acquire locks, update project status, launch a specialist, or conclude QA succeeded from ledger state alone. Use producer clocks only as optional `occurred_at`; `seq` is server commit order and `recorded_at` is the server UTC timestamp. Do not use reserved `usage:`/`artifact:` prefixes for external event IDs.

## Specialist wrapper emission contract for the next phase

The trusted wrapper should emit `attempt.started` at launch, periodic `attempt.heartbeat` independently of the model, optional sanitized `attempt.progress`, and one terminal event based on the actual process outcome: `attempt.succeeded`, `attempt.failed`, `attempt.interrupted`, `attempt.timed_out`, or `attempt.cancelled`. Do not depend on a model's final tool call. Capture signed or unsigned Windows exit codes without truncation. Only the dispatcher decides whether a specialist outcome completes the overall run.

Persist an event before transmission, keep the full payload and original ID through retries, and preserve causal order within each producer. A lost ACK must replay exactly the original event. CLI `emit` and `replay` now retain failed events, drain older observed entries first, use bounded HTTP timeouts and tolerate overlapping replay without deleting a newer entry. Prefer one persistent local spool per ordered producer. Independent producers have no shared causal order; the ledger provides global commit order.

**Fail-open work is mandatory:** the CLI intentionally returns nonzero on tracking failure. Wrappers must catch it, continue running the agent, and arrange later replay. Do not put an unchecked tracking command in a shell's fail-fast launch path. Schema errors/409 conflicts stop queue replay for operator review; never discard or regenerate IDs to hide them. Provider usage submission is not currently spooled by the CLI `usage` command; future wrappers need an explicit durable retry policy for measurements. There is no artifact uploader/retry CLI yet.

## Environment

| Variable | Purpose/default |
| --- | --- |
| `LEDGER_DISPATCHER_TOKEN` | Server write and artifact-download credential, at least 16 characters |
| `LEDGER_READ_TOKEN` | Separate server metadata-only read credential, at least 16 characters; must differ from dispatcher token |
| `LEDGER_DB_PATH` | Server SQLite file; default `./data/ledger.db`; use persistent local disk outside Git for a pilot |
| `LEDGER_ARTIFACT_DIR` | Separate file storage; default `./data/artifacts`; keep coordinated backups with DB |
| `HOST`, `PORT` | Bind address/port; defaults `127.0.0.1`, `4177`; keep private, never public HTTP |
| `LEDGER_HEARTBEAT_TTL_MS` | Diagnostic stale threshold, default `120000`; positive integer |
| `LEDGER_MAX_ARTIFACT_BYTES` | Per-transfer chunk limit, default `10485760`; positive integer |
| `LEDGER_ALLOW_ARTIFACT_UPLOAD` | Uploads enabled only for exact value `true`; leave unset for initial integration |
| `LEDGER_URL` | Client internal API URL, default `http://127.0.0.1:4177` |
| `LEDGER_TOKEN` | Client bearer credential; read token for status, dispatcher token only in trusted producers |
| `LEDGER_SPOOL_DIR` | Client durable event directory, default `./spool`; use local filesystem supporting hard links, tested on NTFS |
| `LEDGER_HTTP_TIMEOUT_MS` | Client request timeout, default `5000`, integer range 1–60000 |
| `LEDGER_RUN_ID`, `LEDGER_ATTEMPT_ID`, `LEDGER_WORK_ITEM` | Future wrapper correlation context; not automatically consumed by the current CLI/server |

Configuration is read from process environment; an `.env` file is not loaded automatically. Use Node 22 LTS and the lockfile (`npm ci`). Repository-relative schema/UI paths require starting from the repository root. Use private-network access controls and TLS before remote transport. V1 has static credentials; attempt-scoped specialist credentials are not implemented, so do not expose the dispatcher token to model prompts or untrusted specialist code.

## Heartbeats and logs

For the default 120-second stale threshold, a wrapper heartbeat about every 30 seconds gives room for transient failures. This is a recommendation for the future wrapper, not an implemented scheduler. Use the same attempt ID throughout one invocation; create a fresh ID for a retry. Display stale as "potentially stale", never silently convert stored running status to failure or take execution ownership. Backlogs can have old producer timestamps but fresh receipt times; interpret both.

Only synthetic logs were uploaded here. `x-sanitized:true` is an assertion by the producer, not server redaction. Hashes verify transferred bytes, not whether content is safe. Chunk uploads are buffered up to the configured limit; gzip is not decompressed or validated as structured session data. There is no raw-session capture/redaction pipeline, retention job, upload concurrency quota, or durable artifact retry utility in V1. Abrupt termination during a temporary write can leave an unacknowledged `.upload-*` file; matched post-rename orphan files recover on identical retry. Filesystem and SQLite commits are not one atomic transaction. Power-loss durability and full backup/restore/retention drills remain unverified.

Before real-agent integration: implement/test fail-open wrappers, durable usage retry, persistent spool replay ownership, credential isolation and pilot storage/backup operations. Keep logs off until redaction, retention, access controls and artifact recovery policies have been exercised with approved content. Large-history pagination and load testing should precede broad rollout. No critical defect remains in the verified standalone metadata path; these limits prevent treating the result as unrestricted production readiness.
