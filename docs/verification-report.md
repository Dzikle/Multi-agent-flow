# Execution Ledger V1 independent verification

Verdict: **PASS WITH LIMITATIONS**. The standalone metadata service was built and exercised end to end on 2026-11-17. Clean installation, TypeScript build, **28/28 automated tests**, **128 actual built-server HTTP requests**, CLI queries/retry, SQLite inspection, restart recovery, synthetic artifact integrity, and **20/20 actual Chromium checks** passed. No critical defect remains in the exercised standalone path. Real-agent instrumentation and unrestricted session-log collection are not approved by this result; see [integration readiness](integration-readiness.md).

## Scope and environment

All seven requested documents/schema files were read before implementation changes. GitHub remains authoritative for tasks; the existing dispatcher remains authoritative for execution. The ledger only observes and records. This work did not modify or integrate any other application, dispatcher, GitHub Project or Trello board. No MCP, orchestrator, queue service, database server or application framework was introduced.

| Item | Observed value |
| --- | --- |
| Checkout | `C:\Dev\Personal\Multi-agent-flow` |
| Branch / initial state | `feat/execution-ledger-v1`, clean at `0e53a8312eecbe023c73088fb7317b62fb0208e9` |
| OS / architecture | Windows NT 10.0.26100, x64 |
| Shell | PowerShell 7.6.9 |
| Original runtime | Node 24.20.0, npm 11.19.0 |
| Verified runtime | Isolated Node **22.23.5**, npm **11.19.0**; no global runtime replacement |
| Libraries | TypeScript 5.9.3, Fastify 5.12.8, better-sqlite3 11.10.0, Zod 4.6.7, tsx 4.23.15 |
| SQLite | **3.49.2**, WAL, foreign keys enabled by server, busy timeout 5000 ms |
| Actual browser | Chrome **157.0.8103.79**, existing external Playwright module; desktop 1440×1000 and Chromium mobile emulation 390×844 |
| Listener/storage | Only `127.0.0.1`; temporary SQLite/artifact/spool directories outside Git; independently generated dispatcher/read credentials |

No repository lockfile existed initially. A lockfile and `.nvmrc` now make the verified Node 22 installation reproducible; the package engine floor matches the documented Node 22 requirement. Configuration comes from process environment, not an automatically loaded `.env`. Default persistent paths would be `./data/ledger.db`, `./data/artifacts`, and client `./spool`; probes override all three. [Environment](verification-evidence/final/environment.json), [dependencies](verification-evidence/final/dependencies.txt), and [schema](verification-evidence/final/standalone/schema.json) capture exact versions and paths.

PR #1 was **already merged** at `2026-11-17T20:58:29Z` before this task inspected it; it was not a draft. This task did not merge or reopen it. Follow-up verification fixes are prepared on the requested feature branch; the PR update identifies the delivered commit. Updating findings on the historical PR does not put those fixes onto `main`.

## Commands and exit codes

All commands ran in the personal checkout using PowerShell. The final gate is recorded in [commands.json](verification-evidence/final/commands.json), with complete output linked per command. It is independent of any prior CI result.

```powershell
git clone --branch feat/execution-ledger-v1 --single-branch https://github.com/Dzikle/Multi-agent-flow.git C:\Dev\Personal\Multi-agent-flow
git status --short --branch
git rev-parse HEAD
git config user.name Dzikle
git config user.email 72608012+Dzikle@users.noreply.github.com
node --version
npm --version
npm install
npm run build
npm test
npm audit --json
```

Clone/status/identity commands exited 0. The first `npm install` under Node 24 exited **1**: better-sqlite3 11.10.0 had no matching Windows prebuild, and native fallback could not find Python. The attempted build/test then exited **1** because `tsc`/`tsx` were not installed. The first audit attempt exited **1** (`ENOLOCK`); `npm install --package-lock-only --ignore-scripts` then exited **0** and allowed the advisory to be inspected. These are recorded failures, not passing checks.

```powershell
npm exec --yes --package=node@22 -- node -p process.execPath
$env:PATH = 'C:\Users\Stojancho\AppData\Local\npm-cache\_npx\52027bd8fc0022aa\node_modules\node\bin;' + $env:PATH
npm install
npm run build
npm test
npm audit --json
npm install zod@^4.6.7
```

The Node 22 bootstrap/install/build exited **0**; the original suite passed **5/5**, exit **0**. Audit exited **1**, reporting one high advisory in Zod 3.25.76. The targeted Zod install exited **0**. Its first compilation caught the changed `z.record` signature; this was corrected to `z.record(z.string(), z.unknown())` and verified by build and HTTP regressions. No forced audit fix was used. Each reproduced defect received a failing regression before correction; [CLI evidence](verification-evidence/cli-verification.md), [artifact/usage evidence](verification-evidence/artifact-usage-2026-11-17.json), and browser before/after results retain the outcomes.

Final fresh verification command:

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\Users\Stojancho\AppData\Roaming\npm\node_modules\@playwright\cli\node_modules\playwright\index.mjs'
./scripts/verify-local.ps1
```

| Actual final command | Exit | Result |
| --- | --- | --- |
| `node --version` | 0 | v22.23.5 |
| `npm.cmd --version` | 0 | 11.19.0 |
| `npm.cmd ci` | 0 | Clean install, 93 packages added / 94 audited |
| `npm.cmd run build` | 0 | TypeScript build succeeded |
| `npm.cmd test` | 0 | **28 tests passed**, no failures/skips |
| `npm.cmd audit` | 0 | **0 vulnerabilities** |
| `node scripts/verify-standalone.mjs docs/verification-evidence/final/standalone` | 0 | 19 acceptance checks, 128 HTTP requests, actual built server |
| `node --import tsx scripts/verify-browser.mjs` | 0 | **20/20** actual browser checks |
| `git diff --check` | 0 | No whitespace errors |

The standalone command was repeated after expanding the SQL audit to include every lifecycle timestamp and content hash; exit **0**, again 128 requests. This changed the verification script, not application behavior. `npm ls --depth=0` and the final `npm audit --json` also exited **0**. Individual CLI commands, arguments, stdout/stderr and exit codes are in [standalone results](verification-evidence/final/standalone/results.json): valid reads/emits/replays exit 0; offline emit, invalid credentials and malformed/missing arguments deliberately exit 1.

Install warnings remain: deprecated transitive `prebuild-install@7.1.3`, funding notices, and npm 11's notice that better-sqlite3/esbuild install scripts lack an `allowScripts` declaration. Installation and real native SQLite/esbuild use succeeded; these notices were not suppressed. Server startup stderr was empty in both automated runtime starts. No other database process was needed.

## Actual HTTP lifecycle and failure handling

[http.json](verification-evidence/final/standalone/http.json) contains actual request bodies, statuses and responses without Authorization headers. [lifecycle.json](verification-evidence/final/standalone/lifecycle.json) captures the final run and its complete ordered event history. IDs are unique synthetic UUID-based identifiers; the GitHub-shaped work item is not a real issue mutation.

The requested journey completed: run created/started; coordinator start/progress/success; developer start/three progress/two heartbeats/success; independent reviewer success; QA failure; run still running; distinct developer correction; new successful QA; explicit run completion. The completed run retains **six distinct attempts** and **22 ordered lifecycle events**. The failed QA stays visible. Two runs for the same work item demonstrate that work item, execution and invocation identities are separate.

| Probe | Observed result |
| --- | --- |
| Identical event twice | 201 then 200, original sequence/timestamp, one row and no projection mutation |
| Same ID, changed payload | 409 `EVENT_ID_CONFLICT`; all six domain tables unchanged |
| Finish twice / heartbeat after completion / restart completed run | Deterministic 409, no partial changes |
| Finalize with active attempt | 409 `ACTIVE_ATTEMPTS`, run remains active |
| Nonexistent run | 404 `RUN_NOT_FOUND`, no partial changes |
| Attempt or parent attempt from another run | 409, no partial changes |
| Three parallel specialists | Interleaved progress/heartbeat, independent running state and increasing global sequence |
| 32 simultaneous identical retries | Exactly one 201 and 31 duplicate 200 responses; same sequence, one database row |
| Heartbeat expiry | Actual elapsed 200 ms test threshold; three attempts become `suspected_stale:true`, stored status remains `running` |
| Malformed JSON, repeated/nonnumeric/fractional filters | 400 errors instead of internal 500; invalid numeric server configuration fails before storage creation |
| Windows crash exit values | Real HTTP accepts -1073741819 and 3221225477 and settles attempts as failed |

The production command `npm start` was also run in a real terminal on loopback :4195. An unfinished run/attempt was submitted by `Invoke-RestMethod`; Ctrl+C logged **`Execution Ledger stopped`**. The npm/PowerShell wrapper exited **1** for the keyboard interrupt. Restarting with the same DB returned an identical run/attempt snapshot and timestamps. Both request/check scripts exited **0**; see [normal-restart.json](verification-evidence/normal-restart.json). The automated built-process probe separately tested abrupt Windows process termination/restart, preserving all unfinished-run events and timestamps.

CLI regression tests stop the actual HTTP listener while a CLI child is awaiting a deliberately withheld post-commit ACK, kill the client, restart the same DB/port, and replay the original event exactly once. Additional tests cover service already offline, stalled HTTP timeout, clock rollback, and four-process overlapping replay. The final acceptance probe also stops the built runtime, observes failed emit exit 1 with the full event retained locally, restarts, replays once, then confirms a second replay has nothing left.

## SQLite inspection

The live database was inspected read-only. It contains **six domain tables** (`work_items`, `runs`, `attempts`, `events`, `artifacts`, `usage_samples`), plus `schema_migrations` and SQLite's sequence bookkeeping. [schema.json](verification-evidence/final/standalone/schema.json) lists actual SQL, columns/PKs, foreign keys, indexes and immutable triggers. Parent same-run ownership is additionally validated transactionally by the service; the individual SQL FKs alone do not encode that composite rule.

Final counts were **1 work item, 2 runs, 9 attempts, 53 events, 1 artifact, 3 usage samples**. Every event's stored content hash matches its immutable canonical JSON. Independently replaying the event history matches current run/attempt statuses, phases, creation/start/finish/update/heartbeat timestamps; optional producer timestamps remain distinct from server receipt times. API retries and rejected transactions did not add duplicate history or modify projections.

`PRAGMA integrity_check` returned **`ok`**; `PRAGMA foreign_key_check` returned **no rows**. The required run/attempt/event/usage/lookup indexes exist. Negative UPDATE/DELETE, invalid-FK and transaction-rollback probes ran against a supported SQLite backup, not by altering the live test ledger. A further in-memory regression exposed SQLite `INSERT OR REPLACE` bypassing DELETE triggers with recursive triggers off; an insert guard now prevents replacing either event unique key. It is installed idempotently on existing DB startup without changing the six-table architecture. No manual database edits were used to make service tests pass. [database.json](verification-evidence/final/standalone/database.json) records the evidence and retained temporary DB path.

## Artifacts, usage, CLI and UI

Artifact checks used only synthetic sanitized text and gzip bytes: uploads disabled by default; opt-in upload 201; matching replay 200; changed bytes or metadata under the same ID 409; bad SHA 400; oversize 413; missing/cross-run references 404/409; unauthorized download 401; metadata-only reader download 403; dispatcher download SHA matches original bytes. Artifact metadata and its one attachment event associate with the correct run/attempt; bytes are outside SQLite. An interrupted incoming HTTP body leaves no artifact/file/event. A child process deliberately exits **73** precisely after rename/before metadata registration: identical retry now recovers instead of permanently returning 409. Missing/corrupted files fail retrieval and identical re-upload restores bytes with one metadata/event row. This is a tested process-crash boundary, not a power-loss guarantee.

Synthetic usage spans multiple providers/specialists, models and sources: all-source input **300** and output **50** include provider-reported **100/20** plus explicitly estimated **200/30**. Cached input **10** and cost **40 micro-USD** are provider-reported; estimated cost is **900 micro-USD**. Unknown fields remain SQL/API NULL. A duplicate sample does not change totals; changed same-ID samples return 409. Source-specific totals and missing sample/measurement coverage are exposed. Legacy flat cost **940** intentionally remains an all-source subtotal for compatibility; it must not be called billed cost. [usage.json](verification-evidence/final/standalone/usage.json) records both reported/estimated and entirely missing summaries.

CLI `runs`, `run`, `active`, `events`, `issue`, `emit`, and `replay` were actually executed. Query JSON matches direct HTTP (heartbeat ages compared apart from elapsed milliseconds). Credential errors, missing arguments, malformed JSON and network failure give nonzero readable errors; generated bearer credentials do not appear in CLI output. Event spooling is durable before send, uses stable IDs, flushes bytes, and now preserves ordered observed entries and unique filenames across retries/concurrent drains. Usage submission and artifact upload do not yet have equivalent durable CLI spools.

The actual dashboard was exercised with Chrome, not inferred from HTML or CI. **20/20 checks passed**: invalid/read-only auth; active and completed runs; distinct status/phase/model; failed and retried attempts; ordered selected history; manual and 8-second automatic refresh; credential-switch race; missing connectivity/recovery; memory-only token handling; desktop/mobile layouts and horizontal table scrolling; explicit >500-event continuation. There are no execution-control buttons. Screenshots were visually inspected; see [browser report and images](verification-evidence/browser/README.md). Mobile verification is Chromium emulation, not a physical phone or Safari test.

## Corrections and security findings

| Reproduced problem | Targeted correction |
| --- | --- |
| CLI bypassed older queued events, reordered on clock rollback, or waited indefinitely | Drain old entries first, monotonic observed prefix, bounded HTTP timeout |
| Overlapping replays could delete a new entry reusing an old path | Unique per-entry path, tolerant ACK cleanup, identical-payload ACK recovery; deterministic multi-process regression |
| Artifact orphan blocked retries; replay falsely ACKed missing/corrupt bytes; metadata could change | Recover identical orphan, repair identical bytes, verify downloads, immutable ownership/type/encoding/content type, write cleanup/fsync |
| Estimated/provider charges mixed without explicit provenance or missing coverage | Add `by_source` and unknown/attempt coverage while retaining legacy fields |
| Bad JSON/query filters returned 500; numeric config could silently disable stale detection | Deterministic 400 validation and early finite integer configuration checks |
| Work item newline-separated hash components could collide; public event IDs occupied internal evidence namespace | Unambiguous tuple hashing while retaining existing work-item IDs; reserve internal prefixes |
| Terminal attempt phase/run freshness and attempt history incomplete | Refresh run projection on every attempt event; bounded attempt history/filter |
| Windows process crash codes rejected as outside signed 16-bit range | Accept safe integer exit codes without truncation |
| SQL REPLACE could overwrite audit history | Guard both event keys before insertion/replacement |
| Selected UI details stale; auth-switch leaked old view; mobile page overflowed; history absent | Refresh details/events, clear/ignore old auth results, contain table width, bounded ordered history with continuation |
| High Zod dependency advisory | Explicit patched Zod 4.6.7 update, minimal schema migration, lockfile and full verification |

The audit finding was [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), affecting Zod versions below 4.6.6. It concerns uncontrolled validation issue allocation for oversized collections. This service authenticates before invoking Zod, has bounded HTTP bodies, and does not define an unbounded array-validation schema; that reduces the specific reachable exposure, but did not justify retaining the flagged package. The advisory offered no patched 3.x version. The upgrade used the [official migration guide](https://zod.dev/v4/changelog), preserved documented payload fields/status codes, and required only the record-schema API adjustment. Final audit is clean; this is not a claim of a comprehensive security audit.

## Remaining limits and readiness

No critical standalone failure remains open in the exercised scenarios. The following are real limits, not unexecuted tests marked passed:

- Static dispatcher credentials are broad; attempt-scoped credentials, TLS/private remote access, credential rotation and deployment policy were not tested. All runtime listeners here were loopback-only.
- Producer `x-sanitized:true` is not redaction. There is no approved raw-session capture/redaction/retention pipeline. Keep real transcript uploads off.
- Artifact requests are bounded buffers, not streaming; no aggregate upload concurrency quota exists. Interrupted temp writes can leave unacknowledged `.upload-*` files. Files and SQLite are not one atomic commit; replay repairs the tested rename/metadata window. Power loss, disk-full failures and full backup/restore/retention drills remain unverified.
- CLI errors intentionally exit nonzero; the next-phase wrapper must catch them and continue agent work. Malformed/schema-invalid queue entries stop replay for operator review. Usage/artifact durable retries and wrapper crash log capture remain future work, not a verified integration.
- Some detail/history APIs are unpaginated; the dashboard and event pages have explicit bounds. High-volume/long-duration load, Linux, multiple server processes, remote filesystems and physical mobile devices were not tested.

It is reasonable to proceed to a **separate controlled metadata-only integration task**, with fail-open wrappers, persistent per-producer spools and logs disabled. This verification did not implement that phase. Broad real-agent log collection or an unrestricted production rollout needs the remaining operational/privacy work first.
