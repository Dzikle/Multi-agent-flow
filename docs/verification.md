# Standalone verification plan

## Required automated cases

1. Run created / started / specialist started / succeeded / run completed; SQL projections match GET results.
2. Same event replay: exactly one persisted event, stable original sequence and timestamp.
3. Same event_id with different JSON: 409 and no projection change.
4. Unknown parent ID, parent attempt on different run, bad state transition: reject and roll back.
5. Concurrent specialist attempts in same run remain independent.
6. QA attempt failure is not run failure; a fix attempt may start afterward.
7. Terminal run/attempt cannot be reopened or heartbeated.
8. Scheduler event with no run persists.
9. Heartbeat TTL shows suspected_stale but never changes persisted status.
10. Server restarts preserve events, attempts and current state.
11. Artifact upload verifies hash, enforces size, refuses changed-content replay and path traversal.
12. Unauthorized writer/reader rejected and tokens not present in logs.
13. Usage samples preserve unknown values, separate estimated vs billed, never double-count duplicates.
14. Wrapper killed mid-run: last log chunk and retry spool survive.
15. Health endpoint, UI and CLI produce equivalent run status.

## Manual smoke

- Start using temporary SQLite database and artifact directory.
- Send POST run.created, run.started, attempt.started, attempt.progress, attempt.succeeded, run.completed.
- GET /v1/runs, GET /v1/runs/:id, GET /v1/events and verify order.
- Restart server; query again and inspect SQL row counts / PRAGMA integrity_check.
- Open root status page; inspect current phase and last event.
- Simulate network failure and verify caller retains queued events for replay.

## Rollout gates

Independent build and manual API tests first. Then integrate wrappers with the real dispatcher in a dedicated pilot issue. Never use ledger status to acquire task locks, change project board states, or falsely infer model/QA success. Keep artifact collection opt-in until redaction and private access are verified.
