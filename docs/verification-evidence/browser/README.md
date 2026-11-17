# Actual browser verification

The repeatable browser script starts its own HTTP server on `127.0.0.1:4197`, creates a temporary SQLite database and artifact directory, and seeds synthetic runs through authenticated HTTP. Credentials are generated in memory for each execution. It drives an actual installed Chrome browser through Playwright, then closes the browser/server and removes its temporary data. The application receives no browser dependencies.

Verified on 2026-11-17 using Node **22.23.5**, Playwright CLI **0.1.24** (its existing Playwright **1.66.0-alpha-1794252756000** module), and actual Chrome **157.0.8103.79**. Desktop viewport: **1440×1000**. Mobile Chromium viewport: **390×844**, mobile/touch emulation. Screenshots were opened and visually inspected. This is Chromium mobile emulation, not a physical-device test.

Command used from the repository root in PowerShell:

```powershell
$env:PATH = 'C:\Users\Stojancho\AppData\Local\npm-cache\_npx\52027bd8fc0022aa\node_modules\node\bin;' + $env:PATH
$env:PLAYWRIGHT_MODULE = 'C:\Users\Stojancho\AppData\Roaming\npm\node_modules\@playwright\cli\node_modules\playwright\index.mjs'
node --import tsx scripts/verify-browser.mjs
```

`PLAYWRIGHT_MODULE` can point to any separately installed Playwright `index.mjs`. Without it, the script imports an available `playwright` package. Set `LEDGER_BROWSER_CHANNEL` to another installed Chromium channel if needed, `LEDGER_BROWSER_PORT` to a free browser-safe loopback port, or `LEDGER_BROWSER_EVIDENCE_DIR` to another output directory. No application framework or package dependency was added.

The final run exited **0**, with **20/20 checks passing**; see [results.json](results.json). The script asserts desktop/mobile authentication, active/completed runs, failed and retried attempts, phase/status/model, manual refresh, automatic eight-second polling, memory-only token handling, API network failure and recovery, mobile document width and horizontal table scrolling, read-only controls/API calls, and no unhandled JavaScript errors. Authentication switching is also tested with an older authenticated request held in flight.

Selected details retain the run fields and include an ordered `events` array from `/v1/events?run_id=...&limit=500`. A one-event look-ahead query distinguishes exactly 500 events from a truncated history. `event_history` states the limit, truncation notice, `next_after_seq` cursor, and a read-only continuation URL when more events exist. Browser checks verify failed QA and the later retry in server commit order, refreshed event history on desktop/mobile and automatic polling, exactly 500 events without false truncation, and 501 events with a working continuation cursor.

The initial regression run exited **1** with three failures, recorded in [../browser-before/results.json](../browser-before/results.json):

- Selected details retained the old phase after Refresh updated the table.
- Switching to an invalid token retained previously authenticated rows and details.
- The mobile document grew to 543px at a 390px viewport.

The fixes reload selected details on every refresh, clear data when credentials change and ignore older responses, and contain table overflow inside a horizontal scrolling region. API outage feedback explicitly identifies the displayed data as last confirmed.

The missing ordered-history behavior was separately reproduced before the history fix: [../browser-history-before/results.json](../browser-history-before/results.json) records five failed history assertions and exit **1**.

Screenshots contain synthetic data only, and token fields are masked:

- [Desktop completed run and failed attempt](desktop-completed.png)
- [Desktop active run](desktop-active.png)
- [Desktop API unavailable](api-unavailable.png)
- [Mobile completed run](mobile-completed.png)
- [Mobile active run, scrolled table](mobile-active.png)
- [Mobile API unavailable](mobile-unavailable.png)
- [Mobile bounded history and continuation cursor](mobile-history-pagination.png)

The first attempted port, `4190`, failed before browser navigation because fetch rejects that restricted port. The verifier defaults to `4197`.
