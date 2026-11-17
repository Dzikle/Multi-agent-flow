# Future integration with existing multi-agent dispatcher

Do not integrate until the standalone ledger builds and all smoke tests pass.

## Producer boundaries

1. Scheduler triggers: emit system.tick even if no task selected; system.idle if nothing to claim.
2. Dispatcher claims issue: generate immutable run ID and issue reference; emit run.created then run.started.
3. Before every specialist launch: generate attempt ID and emit attempt.started from deterministic wrapper.
4. While child runs: wrapper emits attempt.heartbeat and captures streamed stdout/stderr or structured provider JSONL. Agent may optionally emit attempt.progress checkpoints.
5. On process exit: wrapper emits terminal attempt status independent of agent self-report, and uploads sanitized compressed log chunks with hashes and retry queue.
6. Reviewer/QA/fix runs create new attempts even for the same role. Independent verification evidence should be an artifact.
7. Dispatcher marks run.completed / blocked / failed only based on its existing authoritative workflow rules. Ledger never decides completion.

## Environment contract

- LEDGER_URL: internal base URL
- LEDGER_TOKEN: scoped credential
- LEDGER_RUN_ID: stable execution ID
- LEDGER_ATTEMPT_ID: stable invocation ID
- LEDGER_WORK_ITEM: textual reference for diagnostics, not authority

Wrap existing provider commands; avoid adding per-model "remember to send tracking" instructions as the only instrumentation. The wrapper must not block work on HTTP failure; persist JSON events in an append-only local spool and replay with original event_id. Do not write raw prompts/secrets to the ledger. Do not change existing GitHub/Trello sync.

## Example verification journey

For one isolated GitHub issue: run.created → run.started → developer attempt.started → heartbeat → attempt.succeeded → review attempt.started → attempt.succeeded → QA attempt.started → attempt.failed (qa-harness) → new developer attempt.started → attempt.succeeded → QA retry → run.completed. Assert ordered events, correct projections, independent attempt histories, log hashes, and CLI/UI status after server restart.

## Ownership rule

GitHub: desired work state. Dispatcher: live locks and execution authority. Ledger: observed execution and evidence. If they disagree, **do not auto-correct GitHub or spawn a process**; diagnose the discrepancy explicitly.
