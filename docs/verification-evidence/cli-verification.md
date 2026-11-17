# Standalone CLI verification — 2026-11-17

Scope: `client/agent-ledger.mjs`, exercised as a separate Node process over real loopback HTTP against isolated temporary SQLite databases and spools. No dispatcher integration or external services are used. Credentials are random per test process and are never written to evidence.

Runtime: Node.js v22.23.5, Windows PowerShell. Repository: `C:\Dev\Personal\Multi-agent-flow`, branch `feat/execution-ledger-v1`.

## Commands and exit codes

```powershell
$env:PATH='C:\Users\Stojancho\AppData\Local\npm-cache\_npx\52027bd8fc0022aa\node_modules\node\bin;'+$env:PATH
node --version
node --import tsx --test tests/cli.test.ts
```

`node --version`: exit 0, `v22.23.5`.

CLI regression command before fixes: exit 1, 2 passed / 3 failed. Failures reproduced:

- After a service stop/restart, emitting `run.started` returned HTTP 404 while its earlier `run.created` remained queued.
- A newer event sorted before an existing event when the producer clock moved backwards.
- A service accepting HTTP without responding kept the CLI blocked until the test's 6-second process watchdog terminated it.

CLI regression command after fixes: exit 0, 7 passed / 0 failed. Raw final output is in `cli-tests.txt`.

## Verified behavior

1. Service is started, stopped, and restarted on the same TCP port and SQLite database. An offline event remains byte-equivalent as JSON with its original `event_id`. A subsequent emit drains the earlier event first; server event history is in the expected order, the spool empties, and state survives another service restart.
2. Spool prefixes increase beyond the highest retained position, including when the clock moves backwards. Event files are flushed before their atomic publication. A UUID suffix prevents pathname reuse while another consumer still holds an older ACK. Concurrent producers atomically publish distinct entries; their relative ordering is defined by the sorted queue keys.
3. `LEDGER_HTTP_TIMEOUT_MS=100` bounds an unresponsive HTTP request. The CLI returns nonzero in under 3 seconds and retains the unchanged event. The production default is 5000 ms; accepted bounds are 1–60000 ms.
4. An HTTP proxy forwards an event to the real service and deliberately withholds the committed ACK. While the CLI submission is still pending, the real service is stopped and the CLI child is killed. The event remains in the durable spool. Restarting the same service/database and replaying removes the spool file and leaves exactly one stored event with the original ID.
5. CLI `runs`, `runs created`, `run ID`, `active`, `events ID`, and `issue REPO NUMBER` JSON equal their direct HTTP responses. Invalid read credentials return nonzero/HTTP 401 without exposing the credential. A read credential used for emit returns HTTP 403 and retains the event; replay with the dispatcher credential succeeds.
6. Invalid JSON, null input, and invalid IDs fail without adding spool entries. A malformed retained spool file stops replay before later entries; the CLI reports the remaining count and does not reorder or silently discard entries.
7. A deterministic overlapping-replay regression runs four CLI child processes against real HTTP, freezes the producer clock, and pauses an emitter immediately after atomic file publication. Before the fix, an old ACK deleted the newer queued event: the emitter returned exit 0 with `undefined` output, an empty spool, and no HTTP delivery of the newer event. After the fix, the new unique pathname survives the old ACK; a concurrent consumer can deliver it, and its emitter obtains the original server ACK by replaying the identical full payload. This additional regression was observed failing before the fix and passing afterward.

Nonzero tracking failures are intentional diagnostics. The calling agent wrapper must continue its own work and replay retained events when service/credentials are repaired. A schema-invalid but syntactically valid producer event can still remain at the head of the queue; review the reported file rather than silently skipping or mutating its ID.

The service lifecycle in these automated CLI tests uses real Fastify TCP listeners in the test process. Independent external runtime process verification is recorded separately by the main verification harness.
