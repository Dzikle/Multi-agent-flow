# LEL v1 API contract

All JSON endpoints live under /v1. Responses carry stable IDs, UTC timestamps and explicit status. Auth: Authorization: Bearer <token>. A request body is rejected if its schema or event-specific required fields are invalid. Responses: 201 committed, 200 identical replay, 400 validation, 401 missing credential, 403 denied scope, 404 nonexistent parent, 409 conflicting event ID or transition, 413 oversize, 500 internal fault. Errors: {"error":{"code":"INVALID_TRANSITION","message":"..."}}.

## POST /v1/events

~~~json
{
  "event_id": "evt-run139-dev4-start",
  "type": "attempt.started",
  "run_id": "run-139-02",
  "attempt_id": "attempt-04",
  "actor": "dispatcher",
  "occurred_at": "2026-11-17T19:59:40Z",
  "data": {
    "role": "developer", "provider": "opencode",
    "model": "glm-flash", "host": "agent-pc",
    "phase": "implementation"
  }
}
~~~

Responses:
~~~json
{"accepted":true,"duplicate":false,"sequence":1842,"recorded_at":"2026-11-17T20:00:00.000Z"}
~~~
Duplicate returns duplicate=true with original sequence and timestamp. Conflicting same event_id returns 409, no mutation. event_id binds to complete canonical request (including metadata). Use the same request on HTTP retry.

Event types and required parameters:

| Event | IDs | Data | Allowed from |
|---|---|---|---|
| run.created | run_id | work_item:{source,repository,external_id,title?}, phase? | new |
| run.started | run_id | phase? | created |
| run.waiting, run.blocked | run_id | phase?,message? | running |
| run.resumed | run_id | phase? | waiting / blocked |
| run.completed, run.failed, run.cancelled | run_id | result?,message? | running / waiting / blocked |
| attempt.started | run_id, attempt_id | role required; parent_attempt_id?,provider?,model?,phase?,host? | running run |
| attempt.progress | run_id, attempt_id | phase?,message?,error_class? | running attempt |
| attempt.heartbeat | run_id, attempt_id | optional message | running attempt |
| attempt.succeeded, attempt.failed, attempt.interrupted, attempt.timed_out, attempt.cancelled | run_id, attempt_id | exit_code?,message?,error_class? | running attempt |
| system.tick, system.idle, system.error | neither required | message?,phase? | any |

Only dispatcher identity may create/close/resume runs or start/terminally settle attempts on behalf of a wrapper. A specialist scoped to attempt_id may submit progress and heartbeat. A system event may have no run_id and is always stored. Unknown events are rejected (not silently accepted).

## POST /v1/artifacts

Binary POST with headers X-Artifact-Id, X-Run-Id, optional X-Attempt-Id, X-Artifact-Type, X-SHA256, and Content-Type, optional Content-Encoding: gzip. Server streams to temp under its storage root, verifies digest, applies size limit (initially 10 MiB per chunk), atomically stores and records artifact in one DB transaction plus artifact.attached event. On failure remove temp; repeat ID with same SHA returns existing metadata; changed SHA returns 409. Never accept user-supplied destination filename/path. Require explicit sanitized=true assertion and server-side redaction policy.

## POST /v1/usage

~~~json
{"sample_id":"usage-04","attempt_id":"attempt-04","provider":"opencode","model":"glm-flash","input_tokens":10000,"output_tokens":2200,"cost_usd_micros":null,"source":"provider_reported"}
~~~

Tokens/cost are NULL when unavailable, not zero. Source is provider_reported, estimated or manual. Unique sample_id enforces idempotency.

## Read endpoints

- GET /health : process/database health (unauthenticated, minimal information)
- GET /v1/runs?status=running&limit=50 : newest first, includes phase, updated_at, active attempts, derived suspected_stale
- GET /v1/runs/:runId : run + attempts + latest event + artifact metadata
- GET /v1/issues/:source/:repo/:externalId/runs : work item execution history (URL-encode path components; safer query form may be added)
- GET /v1/attempts/:attemptId : status and history
- GET /v1/events?run_id=...&after_seq=0&limit=100 : ordered immutable events, cursor by seq
- GET /v1/agents/active : running attempts, heartbeat age, suspected_stale
- GET /v1/usage/summary?run_id=... : measured totals and missing coverage
- GET /v1/artifacts/:id : authorized artifact bytes download
- GET / : read-only status page

Read endpoints must use fixed prepared SQL, bounded pagination, correct access scope, and no destructive side effects.

## Security roles

- read: status metadata, no transcripts
- read-artifacts: evidence bytes
- specialist: only its own attempt's progress and heartbeat
- dispatcher: run/attempt lifecycle events
- admin: migration/retention/backup operations

Start with static token configuration via environment (never commit); move to persistent hashed credentials only if needed. Do not leak tokens or full payloads in HTTP access logs.
