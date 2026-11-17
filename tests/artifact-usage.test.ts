import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { buildApp } from "../src/server.js";
import type { LedgerConfig } from "../src/config.js";

const dispatcher = "synthetic-dispatcher-credential";
const reader = "synthetic-reader-credential";
const base = "http://127.0.0.1:4188";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function configFixture() {
  const root = mkdtempSync(join(tmpdir(), "ledger-artifact-usage-"));
  const artifactDir = join(root, "artifacts");
  mkdirSync(artifactDir);
  const config: LedgerConfig = { dbPath: join(root, "ledger.db"), artifactDir, dispatcherToken: dispatcher, readToken: reader, port: 4188, host: "127.0.0.1", heartbeatTtlMs: 120000, maxArtifactBytes: 1024 };
  return { root, config };
}

async function request(path: string, body?: unknown, token = dispatcher) {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, connection: "close", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function createAttempt(run = "run-synthetic", attempt = "attempt-synthetic") {
  for (const [type, data, attemptId] of [
    ["run.created", { work_item: { source: "synthetic", repository: "local/verification", external_id: run } }, undefined],
    ["run.started", {}, undefined],
    ["attempt.started", { role: "qa", provider: "synthetic" }, attempt]
  ] as const) {
    const response = await request("/v1/events", { event_id: randomUUID(), type, run_id: run, ...(attemptId ? { attempt_id: attemptId } : {}), actor: "synthetic-wrapper", data });
    assert.equal(response.status, 201, await response.text());
  }
}

async function fixture() {
  const { root, config } = configFixture();
  let app = buildApp(config);
  const previous = process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD;
  process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD = "true";
  await app.listen({ host: config.host, port: config.port });
  return {
    root, config,
    get app() { return app; },
    restart: async () => { await app.close(); app = buildApp(config); await app.listen({ host: config.host, port: config.port }); },
    close: async () => {
      await app.close();
      if (previous === undefined) delete process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD; else process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const bytes = Buffer.from("synthetic sanitized log\n");
function upload(id: string, payload: Buffer = bytes, extra: Record<string, string> = {}) {
  return fetch(base + "/v1/artifacts", {
    method: "POST",
    headers: { authorization: "Bearer " + dispatcher, connection: "close", "content-type": "application/octet-stream", "x-artifact-id": id, "x-run-id": "run-synthetic", "x-attempt-id": "attempt-synthetic", "x-artifact-type": "session-log", "x-sha256": sha256(payload), "x-sanitized": "true", ...extra },
    body: payload
  });
}

test("artifact replay repairs lost bytes after restart without duplicating metadata or events", async () => {
  const ctx = await fixture();
  try {
    await createAttempt();
    assert.equal((await upload("repair-log")).status, 201);
    unlinkSync(join(ctx.config.artifactDir, sha256("repair-log") + ".bin"));
    await ctx.restart();
    assert.equal((await request("/v1/artifacts/repair-log")).status, 404);
    const replay = await upload("repair-log");
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal(((await replay.json()) as { duplicate: boolean }).duplicate, true);
    const download = await request("/v1/artifacts/repair-log");
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const run = await (await request("/v1/runs/run-synthetic")).json() as any;
    assert.equal(run.artifacts.length, 1);
    const events = await (await request("/v1/events?run_id=run-synthetic")).json() as any;
    assert.equal(events.events.filter((e: any) => e.event_type === "artifact.attached").length, 1);
  } finally { await ctx.close(); }
});

test("artifact ID replay rejects changed metadata even when bytes match", async () => {
  const ctx = await fixture();
  try {
    await createAttempt();
    assert.equal((await upload("immutable-log")).status, 201);
    const changes: Record<string, string>[] = [{ "x-artifact-type": "other-type" }, { "content-type": "application/gzip" }, { "content-encoding": "gzip" }];
    for (const headers of changes) {
      assert.equal((await upload("immutable-log", bytes, headers)).status, 409);
    }
    assert.deepEqual(Buffer.from(await (await request("/v1/artifacts/immutable-log")).arrayBuffer()), bytes);
  } finally { await ctx.close(); }
});

test("corrupt artifact bytes fail retrieval and identical replay restores integrity", async () => {
  const ctx = await fixture();
  try {
    await createAttempt();
    assert.equal((await upload("corrupted-log")).status, 201);
    writeFileSync(join(ctx.config.artifactDir, sha256("corrupted-log") + ".bin"), "damaged synthetic bytes");
    assert.equal((await request("/v1/artifacts/corrupted-log")).status, 500);
    assert.equal((await upload("corrupted-log")).status, 200);
    assert.deepEqual(Buffer.from(await (await request("/v1/artifacts/corrupted-log")).arrayBuffer()), bytes);
  } finally { await ctx.close(); }
});

test("artifact validation failures leave no bytes or metadata and gzip downloads retain their encoding", async () => {
  const ctx = await fixture();
  try {
    await createAttempt();
    const cases: [string, Buffer, Record<string, string>, number][] = [
      ["wrong-digest", bytes, { "x-sha256": "0".repeat(64) }, 400],
      ["oversized", Buffer.alloc(ctx.config.maxArtifactBytes + 1), {}, 413],
      ["../path-traversal", bytes, {}, 400],
      ["missing-run", bytes, { "x-run-id": "missing" }, 404],
      ["missing-attempt", bytes, { "x-attempt-id": "missing" }, 404],
      ["unsanitized", bytes, { "x-sanitized": "false" }, 400]
    ];
    for (const [id, payload, extra, expected] of cases) {
      const response = await upload(id, payload, extra);
      assert.equal(response.status, expected, await response.text());
      assert.deepEqual(readdirSync(ctx.config.artifactDir), []);
    }
    assert.equal(((await (await request("/v1/runs/run-synthetic")).json()) as any).artifacts.length, 0);
    const compressed = gzipSync(bytes);
    assert.equal((await upload("gzip-log", compressed, { "content-type": "application/gzip", "content-encoding": "gzip" })).status, 201);
    const downloaded = await new Promise<{ bytes: Buffer; encoding: string | string[] | undefined }>((resolve, reject) => {
      const req = httpRequest(base + "/v1/artifacts/gzip-log", { headers: { authorization: "Bearer " + dispatcher, connection: "close" } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.once("end", () => resolve({ bytes: Buffer.concat(chunks), encoding: response.headers["content-encoding"] }));
        response.once("error", reject);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(downloaded.encoding, "gzip");
    assert.deepEqual(downloaded.bytes, compressed);
    assert.equal((await request("/v1/artifacts/gzip-log", undefined, reader)).status, 403);
  } finally { await ctx.close(); }
});

test("an interrupted HTTP upload stores no partial artifact or attachment event", async () => {
  const ctx = await fixture();
  try {
    await createAttempt();
    const partialReceived = new Promise<void>(resolve => {
      ctx.app.server.once("request", raw => { raw.once("data", () => resolve()); });
    });
    const req = httpRequest(base + "/v1/artifacts", {
      method: "POST", headers: { authorization: "Bearer " + dispatcher, "content-type": "application/octet-stream", "content-length": "1000", "x-artifact-id": "aborted-log", "x-run-id": "run-synthetic", "x-artifact-type": "session-log", "x-sha256": sha256(bytes), "x-sanitized": "true" }
    });
    req.on("error", () => {});
    req.write(bytes);
    await partialReceived;
    const closed = new Promise<void>(resolve => req.once("close", resolve));
    req.destroy();
    await closed;
    assert.equal((await request("/health")).status, 200);
    assert.deepEqual(readdirSync(ctx.config.artifactDir), []);
    assert.equal(((await (await request("/v1/runs/run-synthetic")).json()) as any).artifacts.length, 0);
    const history = await (await request("/v1/events?run_id=run-synthetic")).json() as any;
    assert.equal(history.events.filter((event: any) => event.event_type === "artifact.attached").length, 0);
  } finally { await ctx.close(); }
});

test("artifact retry recovers after process exit between file rename and metadata commit", async () => {
  const { root, config } = configFixture();
  const code = `import { buildApp } from './src/server.ts'; import { LedgerStore } from './src/store.ts'; LedgerStore.prototype.registerArtifact = function () { process.exit(73); }; const app=buildApp(JSON.parse(process.env.LEDGER_TEST_CONFIG)); await app.listen({host:'127.0.0.1',port:4188}); process.stdout.write('ready\\n');`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, LEDGER_TEST_CONFIG: JSON.stringify(config), LEDGER_ALLOW_ARTIFACT_UPLOAD: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  let app: ReturnType<typeof buildApp> | undefined;
  const old = process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD;
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("ready\n")) resolve(); });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", code => reject(new Error("Child exited before ready: " + code + " " + stderr)));
    });
    await createAttempt();
    const exited = once(child, "exit");
    await assert.rejects(upload("crash-log"));
    assert.equal((await exited)[0], 73);
    assert.deepEqual(readFileSync(join(config.artifactDir, sha256("crash-log") + ".bin")), bytes);
    const db = new Database(config.dbPath);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM artifacts").get() as any).count, 0);
    db.close();
    process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD = "true";
    app = buildApp(config);
    await app.listen({ host: config.host, port: config.port });
    const replay = await upload("crash-log");
    assert.equal(replay.status, 201, await replay.text());
    assert.deepEqual(Buffer.from(await (await request("/v1/artifacts/crash-log")).arrayBuffer()), bytes);
    assert.equal(readdirSync(config.artifactDir).filter(name => name.startsWith(".upload-")).length, 0);
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    if (app) await app.close();
    if (old === undefined) delete process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD; else process.env.LEDGER_ALLOW_ARTIFACT_UPLOAD = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage separates provider estimates and manual totals and reports missing coverage", async () => {
  const ctx = await fixture();
  try {
    await createAttempt();
    await createAttempt("run-empty", "attempt-empty");
    const samples = [
      { sample_id: "provider-sample", attempt_id: "attempt-synthetic", provider: "synthetic", source: "provider_reported", input_tokens: 100, output_tokens: null, cost_usd_micros: 40 },
      { sample_id: "estimated-sample", attempt_id: "attempt-synthetic", provider: "synthetic", source: "estimated", input_tokens: 10, output_tokens: 8, cost_usd_micros: 900 },
      { sample_id: "manual-sample", attempt_id: "attempt-synthetic", provider: "synthetic", source: "manual", input_tokens: null, output_tokens: 2, cost_usd_micros: null }
    ];
    for (const sample of samples) assert.equal((await request("/v1/usage", sample)).status, 201);
    assert.equal((await request("/v1/usage", samples[0])).status, 200);
    assert.equal((await request("/v1/usage", { ...samples[0], cost_usd_micros: 41 })).status, 409);
    const summary = await (await request("/v1/usage/summary")).json() as any;
    assert.equal(summary.samples, 3);
    assert.equal(summary.cost_usd_micros, 940); // Legacy field is all-source; billing must use by_source.
    assert.equal(summary.unknown_cost_samples, 1);
    assert.equal(summary.unknown_input_token_samples, 1);
    assert.equal(summary.unknown_output_token_samples, 1);
    assert.equal(summary.unknown_cached_input_token_samples, 3);
    assert.equal(summary.attempts, 2);
    assert.equal(summary.attempts_with_samples, 1);
    assert.equal(summary.attempts_without_samples, 1);
    assert.equal(summary.by_source.provider_reported.cost_usd_micros, 40);
    assert.equal(summary.by_source.provider_reported.output_tokens, null);
    assert.equal(summary.by_source.estimated.cost_usd_micros, 900);
    assert.equal(summary.by_source.manual.cost_usd_micros, null);
    await ctx.restart();
    assert.equal((await request("/v1/usage", samples[0])).status, 200);
    const filtered = await (await request("/v1/usage/summary?run_id=run-empty")).json() as any;
    assert.equal(filtered.samples, 0);
    assert.equal(filtered.cost_usd_micros, null);
    assert.equal(filtered.unknown_cost_samples, 0);
    assert.equal(filtered.attempts_without_samples, 1);
    assert.equal(filtered.by_source.provider_reported.samples, 0);
  } finally { await ctx.close(); }
});
