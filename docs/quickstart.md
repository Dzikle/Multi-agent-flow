# Local build and manual API verification

Use branch feat/execution-ledger-v1 until the PR is reviewed/merged. No existing Licitacija.mk dispatcher integration is required.

## Requirements

Use Node.js 22 LTS (see `.nvmrc`), npm, a local shell, and permission to write a SQLite DB file. Verified on Windows with Node 22.23.5 and npm 11.19.0. The pinned better-sqlite3 11.x dependency has no matching Node 24 Windows prebuild in this environment; Node 24 installation attempted a native build and failed without Python/build tools. No Docker or external database is required. Run commands from the repository root: runtime reads db/001_init.sql and web/index.html relative to the current working directory. `npm ci` performs a reproducible clean installation from the committed lockfile.

## Linux / macOS

~~~bash
git clone https://github.com/Dzikle/Multi-agent-flow.git
cd Multi-agent-flow
git switch feat/execution-ledger-v1
npm install
npm run build
npm test

export LEDGER_DISPATCHER_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
export LEDGER_READ_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
npm run dev
~~~

In a second terminal, export the SAME token values (not newly generated tokens):

~~~bash
export LEDGER_URL=http://127.0.0.1:4177
export LEDGER_TOKEN='<same dispatcher token>'
npm run smoke
node client/agent-ledger.mjs runs
node client/agent-ledger.mjs active
~~~

## Windows PowerShell

~~~powershell
git clone https://github.com/Dzikle/Multi-agent-flow.git
cd Multi-agent-flow
git switch feat/execution-ledger-v1
npm install
npm run build
npm test

$env:LEDGER_DISPATCHER_TOKEN = [guid]::NewGuid().ToString("N")
$env:LEDGER_READ_TOKEN = [guid]::NewGuid().ToString("N")
npm run dev
~~~

In a second PowerShell terminal, set LEDGER_TOKEN to the *same dispatcher secret* from the first terminal:

~~~powershell
$env:LEDGER_URL = "http://127.0.0.1:4177"
$env:LEDGER_TOKEN = "<paste original dispatcher token>"
npm run smoke
node client/agent-ledger.mjs runs
node client/agent-ledger.mjs active
~~~

Do not commit, paste into chat, or embed real secrets in test scripts.

## Minimal manual HTTP flow (portable Node)

After startup, the following PowerShell snippets use Invoke-RestMethod and leave the development ledger in a completed state.

~~~powershell
$h = @{ Authorization = "Bearer $env:LEDGER_TOKEN" }
$run = "manual-$([guid]::NewGuid().ToString('N'))"
$attempt = "attempt-$([guid]::NewGuid().ToString('N'))"
function Emit($type, $attemptId, $data) {
  $body = @{ event_id=[guid]::NewGuid().ToString("N"); type=$type; run_id=$run; actor="manual-test"; data=$data }
  if ($attemptId) { $body.attempt_id=$attemptId }
  Invoke-RestMethod -Uri "$env:LEDGER_URL/v1/events" -Method Post -Headers $h -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 6)
}
Emit "run.created" $null @{work_item=@{source="manual";repository="test/local";external_id=$run}}
Emit "run.started" $null @{}
Emit "attempt.started" $attempt @{role="developer";provider="manual";phase="implementation"}
Emit "attempt.succeeded" $attempt @{exit_code=0}
Emit "run.completed" $null @{result="verified"}
Invoke-RestMethod -Uri "$env:LEDGER_URL/v1/runs/$run" -Headers $h | ConvertTo-Json -Depth 6
~~~

## Browser status page

Open http://127.0.0.1:4177/ and enter the LEDGER_READ_TOKEN. The page keeps the token only in memory and queries the read API every 8 seconds. Select a run to inspect attempts and artifact metadata. There are no task control buttons.

## SQLite sanity check

~~~bash
sqlite3 ./data/ledger.db "PRAGMA integrity_check; SELECT COUNT(*) FROM runs; SELECT COUNT(*) FROM events;"
~~~

If sqlite3 CLI is not installed, use any SQLite client. Rows remain after server restart. Do not open the file for writing from other processes.

## Upload policy

Artifact uploads are DISABLED until LEDGER_ALLOW_ARTIFACT_UPLOAD=true is explicitly set. Current v1 requires the producer to assert x-sanitized: true, but **does not perform comprehensive secret redaction**. Test with synthetic redacted text only. Use per-chunk files under 10 MiB. Do not upload real agent session exports yet.

## Operational cautions

- Default binding is 127.0.0.1:4177. For remote Tailscale access, bind to the private Tailscale address and add network access restrictions.
- Keep LEDGER_DB_PATH, LEDGER_ARTIFACT_DIR and LEDGER_SPOOL_DIR in persistent, backed-up locations, outside Git.
- If the server is offline, CLI emit saves events to a local spool. Run node client/agent-ledger.mjs replay after connectivity returns.
- CLI requests time out after 5000 ms. `LEDGER_HTTP_TIMEOUT_MS` accepts 1–60000 ms. Failed emits/replays return exit code 1 while preserving events; a future agent wrapper must catch that result and continue agent work. Queue schema errors stop replay for operator review. Use a separate persistent local spool directory per ordered producer; independent producers do not have a shared causal order.
- Stop the runtime with Ctrl+C; signal handling closes HTTP and SQLite. On Windows the npm/PowerShell wrapper may report exit 1 for the keyboard interrupt even when the application logs `Execution Ledger stopped`.
- No agent spawning, GitHub issue mutations or Trello sync occurs in this service.

## Repeat the standalone acceptance gate

Use Node 22 and an installed Chromium/Playwright outside the application. Set `PLAYWRIGHT_MODULE` if Playwright is not available as a local module (see [browser evidence](verification-evidence/browser/README.md)). In PowerShell run `./scripts/verify-local.ps1`. It performs clean install, build, all tests, audit, the built-server real HTTP/CLI/SQLite/restart probe, and the actual desktop/mobile browser probe, saving commands and exit codes under `docs/verification-evidence/final/`. Neither probe calls GitHub or another application. It uses synthetic temporary storage and separate generated credentials. See [verification report](verification-report.md) and [integration readiness](integration-readiness.md) before any pilot.
