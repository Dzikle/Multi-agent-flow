import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";

async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "ledger-validation-"));
  const artifactDir = join(root, "artifacts"); mkdirSync(artifactDir);
  const token = randomUUID();
  const app = buildApp({dbPath: join(root, "ledger.db"), artifactDir, dispatcherToken: token,
    readToken: randomUUID(), host: "127.0.0.1", port: 0, heartbeatTtlMs: 1000, maxArtifactBytes: 1048576});
  const url = await app.listen({host: "127.0.0.1", port: 0});
  t.after(async () => { await app.close(); rmSync(root, {recursive: true, force: true}); });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(url + path, {method: body === undefined ? "GET" : "POST",
      headers: {authorization: "Bearer " + token, "content-type": "application/json"},
      body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, body: await response.json() as any};
  };
  const emit = (type: string, run_id?: string, attempt_id?: string, data = {}, event_id: string = randomUUID()) =>
    request("/v1/events", {event_id, type, actor: "verification", ...(run_id ? {run_id} : {}), ...(attempt_id ? {attempt_id} : {}), data});
  return {url, token, request, emit};
}

test("malformed HTTP JSON returns a client error, not an internal failure", async t => {
  const ctx = await fixture(t);
  const response = await fetch(ctx.url + "/v1/events", {method: "POST", headers: {
    authorization: "Bearer " + ctx.token, "content-type": "application/json"}, body: "{"});
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).error.code, "BAD_REQUEST");
});

test("invalid numeric pagination is rejected deterministically", async t => {
  const ctx = await fixture(t);
  for (const path of ["/v1/runs?limit=1.5", "/v1/events?limit=nope", "/v1/events?after_seq=Infinity", "/v1/events?after_seq=-1"]) {
    const response = await ctx.request(path);
    assert.equal(response.status, 400, path);
  }
});

test("repeated query filters return validation errors rather than SQLite binding failures", async t => {
  const ctx = await fixture(t);
  for (const path of ["/v1/runs?status=running&status=completed", "/v1/events?run_id=one&run_id=two", "/v1/usage/summary?run_id=one&run_id=two"]) {
    assert.equal((await ctx.request(path)).status,400,path);
  }
});

test("invalid numeric server configuration fails before creating storage", () => {
  const env = {LEDGER_DISPATCHER_TOKEN:randomUUID(),LEDGER_READ_TOKEN:randomUUID()};
  for (const extra of [{PORT:"nope"},{PORT:"65536"},{LEDGER_HEARTBEAT_TTL_MS:"Infinity"},{LEDGER_HEARTBEAT_TTL_MS:"-1"},{LEDGER_MAX_ARTIFACT_BYTES:"0"}]) {
    assert.throws(() => loadConfig({...env,...extra}), /must be an integer/);
  }
});

test("external events cannot occupy internal artifact and usage IDs", async t => {
  const ctx = await fixture(t);
  for (const id of ["artifact:synthetic", "usage:synthetic"]) {
    const response = await ctx.emit("system.tick", undefined, undefined, {}, id);
    assert.equal(response.status, 400);
  }
  assert.equal((await ctx.request("/v1/events")).body.events.length, 0);
});

test("work item identity cannot collide when components contain separators", async t => {
  const ctx = await fixture(t);
  for (const [run, source, repository] of [["one", "a\nb", "c"], ["two", "a", "b\nc"]]) {
    assert.equal((await ctx.emit("run.created", run, undefined, {work_item: {source, repository, external_id: "x"}})).status, 201);
  }
  const one = (await ctx.request("/v1/runs/one")).body;
  const two = (await ctx.request("/v1/runs/two")).body;
  assert.notEqual(one.work_item_id, two.work_item_id);
});

test("attempt terminal events refresh run phase and expose complete attempt history", async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.emit("run.created", "one", undefined, {work_item: {source: "github", repository: "synthetic/test", external_id: "1"}})).status, 201);
  await ctx.emit("run.started", "one");
  await ctx.emit("attempt.started", "one", "dev", {role: "developer", phase: "implementation"});
  await ctx.emit("attempt.heartbeat", "one", "dev");
  await ctx.emit("attempt.succeeded", "one", "dev", {phase: "verified", exit_code: 0});
  const run = (await ctx.request("/v1/runs/one")).body;
  assert.equal(run.phase, "verified");
  assert.equal(run.updated_at, run.latest_event.recorded_at);
  const attempt = (await ctx.request("/v1/attempts/dev")).body;
  assert.equal(attempt.events.length, 3);
  assert.deepEqual(attempt.events.map((e: any) => e.event_type), ["attempt.started", "attempt.heartbeat", "attempt.succeeded"]);
});

test("Windows crash exit codes can settle failed attempts without leaving them running", async t => {
  const ctx = await fixture(t);
  await ctx.emit("run.created", "windows", undefined, {work_item:{source:"github",repository:"synthetic/test",external_id:"windows"}});
  await ctx.emit("run.started", "windows");
  for (const [attempt,exit_code] of [["signed",-1073741819],["unsigned",3221225477]] as const) {
    await ctx.emit("attempt.started", "windows", attempt, {role:"developer"});
    assert.equal((await ctx.emit("attempt.failed", "windows", attempt, {exit_code})).status,201);
    const result=(await ctx.request("/v1/attempts/"+attempt)).body;
    assert.equal(result.status,"failed");assert.equal(result.exit_code,exit_code);
  }
});
