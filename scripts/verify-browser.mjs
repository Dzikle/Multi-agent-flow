// Run with: node --import tsx scripts/verify-browser.mjs
// Install Playwright outside the application or set PLAYWRIGHT_MODULE to its index.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../src/server.ts';

const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import('playwright');
const evidence = resolve(process.env.LEDGER_BROWSER_EVIDENCE_DIR || 'docs/verification-evidence/browser');
mkdirSync(evidence, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'ledger-browser-'));
const artifactDir = join(temp, 'artifacts');
mkdirSync(artifactDir);
const dispatcherToken = randomUUID() + randomUUID(), readToken = randomUUID() + randomUUID();
const port = Number(process.env.LEDGER_BROWSER_PORT || 4197);
const app = buildApp({
  dbPath: join(temp, 'ledger.db'), artifactDir, dispatcherToken, readToken,
  host: '127.0.0.1', port, heartbeatTtlMs: 120000, maxArtifactBytes: 1048576
});
const results = [], requests = [], pageErrors = [];
let browser;
const base = `http://127.0.0.1:${port}`;
const activeRun = 'browser-active-run', completedRun = 'browser-completed-run';
async function emit(type, run_id, attempt_id, data = {}) {
  const response = await fetch(base + '/v1/events', {
    method: 'POST', headers: { authorization: `Bearer ${dispatcherToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: randomUUID(), type, run_id, attempt_id, actor: 'browser-verification', data })
  });
  assert.equal(response.status, 201, `Synthetic ${type} fixture must be accepted`);
}
async function createRun(run, issue) {
  await emit('run.created', run, undefined, { work_item: {
    source: 'manual', repository: 'synthetic/browser', external_id: issue, title: 'Synthetic browser verification'
  }, phase: 'planning' });
  await emit('run.started', run, undefined, { phase: 'implementation' });
}
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error.message) }); }
}
async function connect(page) {
  await page.locator('#token').fill(readToken);
  await page.locator('#connect').click();
  await page.locator('#rows tr').first().waitFor();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('last refreshed'));
}
async function select(page, run) {
  await page.locator('#rows tr').filter({ hasText: run }).click();
  await page.waitForFunction(run => document.getElementById('detail').textContent.includes(run), run);
}

try {
  await app.listen({ host: '127.0.0.1', port });
  await createRun(completedRun, 'completed');
  await emit('attempt.started', completedRun, 'browser-qa-failed', { role: 'qa', provider: 'synthetic', model: 'browser-model', phase: 'verification' });
  await emit('attempt.failed', completedRun, 'browser-qa-failed', { exit_code: 2, error_class: 'qa-harness', message: 'Synthetic harness failure' });
  await emit('attempt.started', completedRun, 'browser-qa-retry', { role: 'qa', provider: 'synthetic', model: 'browser-model', phase: 'verification' });
  await emit('attempt.succeeded', completedRun, 'browser-qa-retry', { exit_code: 0 });
  await emit('run.completed', completedRun, undefined, { result: 'Synthetic evidence verified' });
  await createRun(activeRun, 'active');
  await emit('attempt.started', activeRun, 'browser-developer', { role: 'developer', provider: 'synthetic', model: 'browser-model', phase: 'implementation' });

  browser = await playwright.chromium.launch({ channel: process.env.LEDGER_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(String(error.message)));
  page.on('request', request => {
    if (request.url().includes('/v1/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  await page.goto(base);
  await check('desktop rejects invalid authentication', async () => {
    assert.equal(await page.locator('#rows tr').count(), 0);
    await page.locator('#token').fill('invalid-synthetic-credential');
    await page.locator('#connect').click();
    await page.waitForFunction(() => /invalid.*token/i.test(document.getElementById('notice').textContent));
    assert.equal(await page.locator('#rows tr').count(), 0);
  });
  await connect(page);
  await check('desktop active and completed run status, phase and specialist', async () => {
    const active = page.locator('#rows tr').filter({ hasText: activeRun });
    const completed = page.locator('#rows tr').filter({ hasText: completedRun });
    assert.match(await active.innerText(), /running/);
    assert.match(await active.innerText(), /implementation/);
    assert.match(await active.innerText(), /developer.*browser-model/);
    assert.match(await completed.innerText(), /completed/);
  });
  await select(page, completedRun);
  await check('completed run exposes failed attempt and successful retry', async () => {
    const detail = await page.locator('#detail').innerText();
    assert.match(detail, /browser-qa-failed/); assert.match(detail, /failed/);
    assert.match(detail, /browser-qa-retry/); assert.match(detail, /succeeded/);
    assert.match(detail, /verification/);
  });
  await check('selected run shows ordered failed QA and retry events', async () => {
    const detail = JSON.parse(await page.locator('#detail').innerText());
    assert.ok(Array.isArray(detail.events), 'Selected run must include an events array');
    assert.deepEqual(detail.events.map(event => event.event_type), [
      'run.created', 'run.started', 'attempt.started', 'attempt.failed',
      'attempt.started', 'attempt.succeeded', 'run.completed'
    ]);
    assert.equal(detail.events[3].attempt_id, 'browser-qa-failed');
    assert.equal(detail.events[4].attempt_id, 'browser-qa-retry');
    assert.ok(detail.events.every((event, index) => !index || event.seq > detail.events[index - 1].seq));
    assert.equal(detail.event_history.truncated, false);
  });
  await page.screenshot({ path: join(evidence, 'desktop-completed.png'), fullPage: true, maskColor: '#22292d', mask: [page.locator('#token')] });
  await select(page, activeRun);
  await check('manual refresh updates selected run detail', async () => {
    await emit('attempt.progress', activeRun, 'browser-developer', { phase: 'verification', message: 'Synthetic refresh checkpoint' });
    await page.locator('#refresh').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#rows tr')].some(row => row.textContent.includes('browser-active-run') && row.textContent.includes('verification')));
    await page.waitForFunction(() => document.getElementById('detail').textContent.includes('"phase": "verification"'), null, { timeout: 1500 });
  });
  await check('manual refresh updates selected event history', async () => {
    const detail = JSON.parse(await page.locator('#detail').innerText());
    assert.ok(Array.isArray(detail.events), 'Refreshed run must include events');
    assert.equal(detail.events.at(-1).event_type, 'attempt.progress');
    assert.equal(detail.events.at(-1).message, 'Synthetic refresh checkpoint');
  });
  await check('automatic polling updates selected run phase', async () => {
    await emit('attempt.progress', activeRun, 'browser-developer', { phase: 'automatic-verification', message: 'Synthetic polling checkpoint' });
    await page.waitForFunction(() => document.getElementById('detail').textContent.includes('"phase": "automatic-verification"'), null, { timeout: 10000 });
    const detail = JSON.parse(await page.locator('#detail').innerText());
    assert.equal(detail.events?.at(-1).message, 'Synthetic polling checkpoint');
  });
  await page.screenshot({ path: join(evidence, 'desktop-active.png'), fullPage: true, maskColor: '#22292d', mask: [page.locator('#token')] });
  await check('API failure reports unavailable and successful refresh recovers', async () => {
    await page.route('**/v1/**', route => route.abort('connectionrefused'));
    await page.locator('#refresh').click();
    await page.waitForFunction(() => /failed to fetch|unavailable|network|fetch.*error/i.test(document.getElementById('notice').textContent));
    await page.screenshot({ path: join(evidence, 'api-unavailable.png'), fullPage: true, maskColor: '#22292d', mask: [page.locator('#token')] });
    await page.unroute('**/v1/**');
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('last refreshed'));
  });
  await check('switching to invalid token clears authenticated data', async () => {
    let releaseRequest, requestHeld;
    const held = new Promise(resolveHeld => { requestHeld = resolveHeld; });
    const released = new Promise(resolveReleased => { releaseRequest = resolveReleased; });
    const hold = async route => { requestHeld(); await released; await route.continue(); };
    await page.route(/\/v1\/runs\?limit=100$/, hold, { times: 1 });
    await page.locator('#refresh').click();
    await held;
    await page.locator('#token').fill('invalid-synthetic-credential');
    await page.locator('#connect').click();
    assert.equal(await page.locator('#rows tr').count(), 0, 'Credential changes clear rows before any pending response');
    releaseRequest();
    await page.waitForFunction(() => /invalid.*token/i.test(document.getElementById('notice').textContent));
    assert.equal(await page.locator('#rows tr').count(), 0, 'Previous authenticated rows must be cleared');
    assert.doesNotMatch(await page.locator('#detail').innerText(), /browser-active-run/);
  });
  await connect(page);
  await check('read token remains only in page memory', async () => {
    assert.equal(await page.locator('#token').inputValue(), '');
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
    assert.equal(storage.includes(readToken), false);
    await page.reload();
    assert.equal(await page.locator('#rows tr').count(), 0);
  });

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const mobilePage = await mobile.newPage();
  mobilePage.on('pageerror', error => pageErrors.push(String(error.message)));
  mobilePage.on('request', request => {
    if (request.url().includes('/v1/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  await mobilePage.goto(base);
  await check('mobile rejects invalid authentication', async () => {
    await mobilePage.locator('#token').fill('invalid-synthetic-credential');
    await mobilePage.locator('#connect').click();
    await mobilePage.waitForFunction(() => /invalid.*token/i.test(document.getElementById('notice').textContent));
    assert.equal(await mobilePage.locator('#rows tr').count(), 0);
  });
  await connect(mobilePage);
  await select(mobilePage, completedRun);
  await check('mobile shows completed attempt history and active run', async () => {
    assert.match(await mobilePage.locator('#detail').innerText(), /browser-qa-failed/);
    assert.match(await mobilePage.locator('#detail').innerText(), /failed/);
    assert.match(await mobilePage.locator('#rows').innerText(), /running/);
  });
  await check('mobile page fits viewport without document overflow', async () => {
    const size = await mobilePage.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    assert.ok(size.document <= size.viewport, `Document width ${size.document} exceeds viewport ${size.viewport}`);
  });
  await mobilePage.screenshot({ path: join(evidence, 'mobile-completed.png'), fullPage: true, maskColor: '#22292d', mask: [mobilePage.locator('#token')] });
  await check('mobile table can scroll to specialist and update columns', async () => {
    const scroll = await mobilePage.locator('.table-scroll').evaluate(element => {
      element.scrollLeft = element.scrollWidth;
      return { position: element.scrollLeft, overflow: element.scrollWidth > element.clientWidth };
    });
    assert.equal(scroll.overflow, true); assert.ok(scroll.position > 0);
  });
  await select(mobilePage, activeRun);
  await check('mobile manual refresh updates selected run phase', async () => {
    await emit('attempt.progress', activeRun, 'browser-developer', { phase: 'mobile-verification', message: 'Synthetic mobile checkpoint' });
    await mobilePage.locator('#refresh').click();
    await mobilePage.waitForFunction(() => document.getElementById('detail').textContent.includes('"phase": "mobile-verification"'));
    const detail = JSON.parse(await mobilePage.locator('#detail').innerText());
    assert.equal(detail.events?.at(-1).message, 'Synthetic mobile checkpoint');
    await mobilePage.screenshot({ path: join(evidence, 'mobile-active.png'), fullPage: true, maskColor: '#22292d', mask: [mobilePage.locator('#token')] });
  });
  await check('mobile API outage displays feedback and refresh recovers', async () => {
    await mobilePage.route('**/v1/**', route => route.abort('connectionrefused'));
    await mobilePage.locator('#refresh').click();
    await mobilePage.waitForFunction(() => /unavailable/i.test(document.getElementById('notice').textContent));
    assert.match(await mobilePage.locator('#detail').innerText(), /mobile-verification/);
    await mobilePage.screenshot({ path: join(evidence, 'mobile-unavailable.png'), fullPage: true, maskColor: '#22292d', mask: [mobilePage.locator('#token')] });
    await mobilePage.unroute('**/v1/**');
    await mobilePage.locator('#refresh').click();
    await mobilePage.waitForFunction(() => document.getElementById('notice').textContent.includes('last refreshed'));
  });
  await check('exactly 500 events does not falsely report truncation', async () => {
    const existing = await fetch(base + `/v1/events?run_id=${activeRun}&limit=500`, { headers: { authorization: `Bearer ${readToken}` } });
    const count = (await existing.json()).events.length;
    for (let index = count; index < 500; index++) {
      await emit('attempt.progress', activeRun, 'browser-developer', { phase: 'mobile-verification', message: `Synthetic pagination checkpoint ${index}` });
    }
    await mobilePage.locator('#refresh').click();
    await mobilePage.waitForFunction(() => {
      const detail = JSON.parse(document.getElementById('detail').textContent);
      return detail.events?.length === 500 && detail.event_history?.truncated === false;
    }, null, { timeout: 10000 });
    const detail = JSON.parse(await mobilePage.locator('#detail').innerText());
    assert.equal(detail.event_history.next_after_seq, null);
    assert.equal(detail.event_history.continuation_url, null);
  });
  await check('event history is bounded with an explicit continuation cursor', async () => {
    await emit('attempt.progress', activeRun, 'browser-developer', { phase: 'mobile-verification', message: 'Synthetic event beyond first page' });
    await mobilePage.locator('#refresh').click();
    await mobilePage.waitForFunction(() => {
      const detail = JSON.parse(document.getElementById('detail').textContent);
      return detail.events?.length === 500 && detail.event_history?.truncated === true;
    }, null, { timeout: 10000 });
    const detail = JSON.parse(await mobilePage.locator('#detail').innerText());
    assert.equal(detail.event_history.limit, 500);
    assert.equal(detail.event_history.next_after_seq, detail.events.at(-1).seq);
    assert.match(detail.event_history.notice, /500.*more|500.*continu/i);
    const continuation = await fetch(base + detail.event_history.continuation_url, { headers: { authorization: `Bearer ${readToken}` } });
    assert.equal(continuation.status, 200);
    const next = await continuation.json();
    assert.ok(next.events.length > 0 && next.events.length <= 500);
    assert.ok(next.events[0].seq > detail.event_history.next_after_seq);
    await mobilePage.locator('#detail').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await mobilePage.screenshot({ path: join(evidence, 'mobile-history-pagination.png'), fullPage: true, maskColor: '#22292d', mask: [mobilePage.locator('#token')] });
  });
  await check('dashboard exposes only read controls and uses only read API requests', async () => {
    for (const current of [page, mobilePage]) {
      const controls = await current.getByRole('button').allTextContents();
      assert.ok(controls.every(text => /^(Connect|Refresh)$/.test(text.trim())), `Unexpected controls: ${controls.join(', ')}`);
    }
    assert.ok(requests.length > 0); assert.ok(requests.every(request => request.method === 'GET'));
  });
  await check('no unhandled browser JavaScript errors', async () => assert.deepEqual(pageErrors, []));
  const report = { verified_at: new Date().toISOString(), browser: browser.version(), node: process.version,
    viewport: { desktop: '1440x1000', mobile: '390x844' }, synthetic_data_only: true, results, requests };
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ browser: report.browser, checks: results, failed: results.filter(result => !result.passed).length }, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('ledger-browser-')) {
    throw new Error('Refusing to remove an unexpected browser fixture path');
  }
  rmSync(temp, { recursive: true, force: true });
}
