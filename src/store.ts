import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { EventInput, UsageInput } from "./contracts.js";
import { LedgerError } from "./contracts.js";

type Row = Record<string, any>;
const nowUtc = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(k => JSON.stringify(k) + ":" + stable(object[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 250) {
    throw new LedgerError("VALIDATION", label + " must be a non-empty string (max 250)", 400);
  }
  return value;
}
function optionalString(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : requiredString(value, label);
}
function getRow(row: unknown, code: string): Row {
  if (!row) throw new LedgerError(code, "Referenced record was not found", 404);
  return row as Row;
}
const terminalRuns = new Set(["completed", "failed", "cancelled"]);
const terminalAttempts = new Set(["succeeded", "failed", "interrupted", "timed_out", "cancelled"]);

export class LedgerStore {
  readonly db: Database.Database;
  constructor(path: string, schemaPath = resolve(process.cwd(), "db/001_init.sql")) {
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(readFileSync(schemaPath, "utf8"));
  }
  close(): void { this.db.close(); }

  recordEvent(event: EventInput) {
    const canonical = stable(event);
    const digest = hash(canonical);
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT seq,event_hash,recorded_at FROM events WHERE event_id=?").get(event.event_id) as Row | undefined;
      if (previous) {
        if (previous.event_hash !== digest) throw new LedgerError("EVENT_ID_CONFLICT", "event_id already belongs to different data", 409);
        return { accepted: true, duplicate: true, sequence: previous.seq as number, recorded_at: previous.recorded_at as string };
      }
      const at = nowUtc();
      const d = event.data as Record<string, unknown>;
      const kind = event.type;
      const phase = optionalString(d.phase, "phase");
      const message = optionalString(d.message, "message");
      const runId = event.run_id || null;
      const attemptId = event.attempt_id || null;

      if (kind.startsWith("system.")) {
        if (runId || attemptId) throw new LedgerError("VALIDATION", "System events must not reference a run or attempt");
      } else if (kind.startsWith("run.")) {
        if (!runId || attemptId) throw new LedgerError("VALIDATION", "Run events require run_id and no attempt_id");
        if (kind === "run.created") {
          const item = d.work_item;
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new LedgerError("VALIDATION", "work_item is required");
          const w = item as Record<string, unknown>;
          const source = requiredString(w.source, "work_item.source");
          const repository = requiredString(w.repository, "work_item.repository");
          const externalId = requiredString(w.external_id, "work_item.external_id");
          const title = optionalString(w.title, "work_item.title");
          const workId = hash(source + "\n" + repository + "\n" + externalId).slice(0, 32);
          if (this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(runId)) throw new LedgerError("CONFLICT", "Run ID already exists", 409);
          this.db.prepare("INSERT INTO work_items(id,source,repository,external_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,repository,external_id) DO UPDATE SET title=COALESCE(excluded.title,work_items.title),updated_at=excluded.updated_at")
            .run(workId, source, repository, externalId, title, at, at);
          this.db.prepare("INSERT INTO runs(id,work_item_id,status,phase,created_at,updated_at) VALUES (?,?, 'created',?,?,?)")
            .run(runId, workId, phase, at, at);
        } else {
          const run = getRow(this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId), "RUN_NOT_FOUND");
          const transitions: Record<string, string[]> = {
            "run.started": ["created"], "run.waiting": ["running"], "run.blocked": ["running"],
            "run.resumed": ["waiting","blocked"], "run.completed": ["running","waiting","blocked"],
            "run.failed": ["running","waiting","blocked"], "run.cancelled": ["running","waiting","blocked","created"]
          };
          if (!transitions[kind]?.includes(run.status as string)) {
            throw new LedgerError("INVALID_TRANSITION", "Cannot apply " + kind + " to run in " + run.status, 409);
          }
          const state: Record<string, string> = {
            "run.started":"running", "run.waiting":"waiting","run.blocked":"blocked",
            "run.resumed":"running","run.completed":"completed","run.failed":"failed","run.cancelled":"cancelled"
          };
          const newStatus = state[kind];
          if (terminalRuns.has(newStatus)) {
            const active = this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run_id=? AND status='running'").get(runId) as Row;
            if (active.n > 0) throw new LedgerError("ACTIVE_ATTEMPTS", "Cannot finalize run with active attempts", 409);
          }
          this.db.prepare("UPDATE runs SET status=?,phase=COALESCE(?,phase),result=COALESCE(?,result),started_at=CASE WHEN ?='run.started' THEN ? ELSE started_at END,finished_at=?,updated_at=? WHERE id=?")
            .run(newStatus, phase, optionalString(d.result, "result"), kind, at, terminalRuns.has(newStatus) ? at : null, at, runId);
        }
      } else if (kind.startsWith("attempt.")) {
        if (!runId || !attemptId) throw new LedgerError("VALIDATION", "Attempt events require run_id and attempt_id");
        const run = getRow(this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId), "RUN_NOT_FOUND");
        if (kind === "attempt.started") {
          if (run.status !== "running") throw new LedgerError("INVALID_TRANSITION", "Run must be running before an attempt starts", 409);
          const role = requiredString(d.role, "role");
          const parentId = optionalString(d.parent_attempt_id, "parent_attempt_id");
          if (parentId) {
            const parent = getRow(this.db.prepare("SELECT run_id FROM attempts WHERE id=?").get(parentId), "PARENT_NOT_FOUND");
            if (parent.run_id !== runId) throw new LedgerError("PARENT_RUN_MISMATCH", "Parent attempt belongs to another run", 409);
          }
          if (this.db.prepare("SELECT 1 FROM attempts WHERE id=?").get(attemptId)) throw new LedgerError("CONFLICT", "Attempt ID already exists", 409);
          this.db.prepare("INSERT INTO attempts(id,run_id,parent_attempt_id,role,provider,model,host,phase,status,started_at,last_heartbeat_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'running',?,?,?)")
            .run(attemptId, runId, parentId, role, optionalString(d.provider,"provider"), optionalString(d.model,"model"), optionalString(d.host,"host"), phase, at, at, at);
          this.db.prepare("UPDATE runs SET phase=COALESCE(?,phase),updated_at=? WHERE id=?").run(phase, at, runId);
        } else {
          const attempt = getRow(this.db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId), "ATTEMPT_NOT_FOUND");
          if (attempt.run_id !== runId) throw new LedgerError("ATTEMPT_RUN_MISMATCH", "Attempt belongs to another run", 409);
          if (attempt.status !== "running") throw new LedgerError("INVALID_TRANSITION", "Attempt is already terminal", 409);
          if (kind === "attempt.heartbeat") {
            this.db.prepare("UPDATE attempts SET last_heartbeat_at=?,updated_at=? WHERE id=?").run(at, at, attemptId);
          } else if (kind === "attempt.progress") {
            this.db.prepare("UPDATE attempts SET phase=COALESCE(?,phase),updated_at=? WHERE id=?").run(phase, at, attemptId);
            this.db.prepare("UPDATE runs SET phase=COALESCE(?,phase),updated_at=? WHERE id=?").run(phase, at, runId);
          } else {
            const status = kind.split(".")[1];
            if (!terminalAttempts.has(status)) throw new LedgerError("VALIDATION", "Unknown attempt outcome");
            const exitCode = d.exit_code;
            if (exitCode !== undefined && exitCode !== null && (!Number.isInteger(exitCode) || (exitCode as number) < -32768 || (exitCode as number) > 32767)) {
              throw new LedgerError("VALIDATION", "exit_code must be an integer");
            }
            this.db.prepare("UPDATE attempts SET status=?,exit_code=?,phase=COALESCE(?,phase),finished_at=?,last_heartbeat_at=?,updated_at=? WHERE id=?")
              .run(status, exitCode ?? null, phase, at, at, at, attemptId);
          }
        }
      } else throw new LedgerError("VALIDATION", "Unsupported event type");

      const result = this.db.prepare("INSERT INTO events(event_id,event_hash,run_id,attempt_id,actor,event_type,phase,message,occurred_at,recorded_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(event.event_id, digest, runId, attemptId, event.actor, kind, phase, message, event.occurred_at || null, at, canonical);
      return { accepted: true, duplicate: false, sequence: Number(result.lastInsertRowid), recorded_at: at };
    })();
  }

  recordUsage(sample: UsageInput) {
    const canonical = stable(sample), digest = hash(canonical);
    return this.db.transaction(() => {
      const eventId = "usage:" + sample.sample_id;
      const prior = this.db.prepare("SELECT seq,event_hash FROM events WHERE event_id=?").get(eventId) as Row | undefined;
      if (prior) {
        if (prior.event_hash !== digest) throw new LedgerError("USAGE_ID_CONFLICT", "Usage ID already belongs to different data", 409);
        return { accepted: true, duplicate: true };
      }
      const attempt = getRow(this.db.prepare("SELECT run_id FROM attempts WHERE id=?").get(sample.attempt_id), "ATTEMPT_NOT_FOUND");
      const at = nowUtc();
      this.db.prepare("INSERT INTO usage_samples(id,attempt_id,provider,model,input_tokens,output_tokens,cached_input_tokens,cost_usd_micros,source,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(sample.sample_id,sample.attempt_id,sample.provider,sample.model ?? null,sample.input_tokens ?? null,sample.output_tokens ?? null,sample.cached_input_tokens ?? null,sample.cost_usd_micros ?? null,sample.source,at);
      this.db.prepare("INSERT INTO events(event_id,event_hash,run_id,attempt_id,actor,event_type,recorded_at,payload_json) VALUES (?,?,?,?,?,?,?,?)")
        .run(eventId,digest,attempt.run_id,sample.attempt_id,"usage","usage.reported",at,canonical);
      return { accepted: true, duplicate: false };
    })();
  }

  registerArtifact(input: { id:string; runId:string; attemptId:string|null; type:string; key:string; sha256:string; bytes:number; contentType:string; encoding:string|null; sanitized:boolean }) {
    const canonical = stable(input), digest = hash(canonical);
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(input.id) as Row | undefined;
      if (prior) {
        if (prior.sha256 !== input.sha256 || prior.size_bytes !== input.bytes || prior.run_id !== input.runId || prior.attempt_id !== input.attemptId) throw new LedgerError("ARTIFACT_ID_CONFLICT","Artifact ID already exists with different data",409);
        return {accepted:true,duplicate:true};
      }
      getRow(this.db.prepare("SELECT id FROM runs WHERE id=?").get(input.runId),"RUN_NOT_FOUND");
      if (input.attemptId) {
        const attempt=getRow(this.db.prepare("SELECT run_id FROM attempts WHERE id=?").get(input.attemptId),"ATTEMPT_NOT_FOUND");
        if (attempt.run_id !== input.runId) throw new LedgerError("ATTEMPT_RUN_MISMATCH","Attempt belongs to another run",409);
      }
      const at=nowUtc();
      this.db.prepare("INSERT INTO artifacts(id,run_id,attempt_id,artifact_type,storage_key,sha256,size_bytes,content_type,encoding,sanitized,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.id,input.runId,input.attemptId,input.type,input.key,input.sha256,input.bytes,input.contentType,input.encoding,input.sanitized?1:0,at);
      this.db.prepare("INSERT INTO events(event_id,event_hash,run_id,attempt_id,actor,event_type,recorded_at,payload_json) VALUES (?,?,?,?,?,?,?,?)")
        .run("artifact:"+input.id,digest,input.runId,input.attemptId,"artifact","artifact.attached",at,canonical);
      return {accepted:true,duplicate:false};
    })();
  }

  listRuns(status?: string, limit = 50) {
    const sql = "SELECT r.*,w.source,w.repository,w.external_id,w.title,(SELECT MAX(seq) FROM events e WHERE e.run_id=r.id) AS latest_seq FROM runs r JOIN work_items w ON r.work_item_id=w.id " +
      (status ? "WHERE r.status=? " : "") + "ORDER BY r.updated_at DESC,r.id DESC LIMIT ?";
    const rows = (status ? this.db.prepare(sql).all(status,limit) : this.db.prepare(sql).all(limit)) as Row[];
    return rows.map(row => ({...row, active_attempts:this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run_id=? AND status='running'").get(row.id) as Row})).map(row=>({...row, active_attempts:row.active_attempts.n}));
  }
  getRun(id: string) {
    const run = this.db.prepare("SELECT r.*,w.source,w.repository,w.external_id,w.title FROM runs r JOIN work_items w ON r.work_item_id=w.id WHERE r.id=?").get(id) as Row | undefined;
    if (!run) throw new LedgerError("RUN_NOT_FOUND","Run does not exist",404);
    const attempts = this.db.prepare("SELECT * FROM attempts WHERE run_id=? ORDER BY started_at,id").all(id) as Row[];
    const artifacts = this.db.prepare("SELECT id,attempt_id,artifact_type,sha256,size_bytes,content_type,created_at FROM artifacts WHERE run_id=? ORDER BY created_at").all(id);
    const latest_event = this.db.prepare("SELECT seq,event_type,recorded_at FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1").get(id) || null;
    return { ...run, attempts, artifacts, latest_event };
  }
  getAttempt(id: string) {
    const attempt = this.db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
    if (!attempt) throw new LedgerError("ATTEMPT_NOT_FOUND","Attempt does not exist",404);
    return attempt as Row;
  }
  getEvents(filters: {runId?:string; afterSeq?:number; limit?:number}) {
    const limit=Math.min(Math.max(filters.limit ?? 100,1),500), seq=Math.max(filters.afterSeq ?? 0,0);
    const rows=filters.runId
      ? this.db.prepare("SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?").all(filters.runId,seq,limit)
      : this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(seq,limit);
    return (rows as Row[]).map(r=>({...r,payload:JSON.parse(r.payload_json),payload_json:undefined}));
  }
  activeAttempts(ttlMs: number) {
    const rows=this.db.prepare("SELECT a.*,r.work_item_id,w.repository,w.external_id FROM attempts a JOIN runs r ON a.run_id=r.id JOIN work_items w ON r.work_item_id=w.id WHERE a.status='running' ORDER BY a.started_at DESC").all() as Row[];
    return rows.map(a=>({...a, heartbeat_age_ms:Math.max(0,Date.now()-Date.parse(a.last_heartbeat_at)), suspected_stale:Date.now()-Date.parse(a.last_heartbeat_at)>ttlMs}));
  }
  issueRuns(source: string, repository: string, externalId: string) {
    return this.db.prepare("SELECT r.* FROM runs r JOIN work_items w ON r.work_item_id=w.id WHERE w.source=? AND w.repository=? AND w.external_id=? ORDER BY r.created_at DESC").all(source,repository,externalId);
  }
  usageSummary(runId?: string) {
    const where=runId ? " WHERE a.run_id=?" : "";
    const sql="SELECT COUNT(*) AS samples, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.cached_input_tokens) AS cached_input_tokens, SUM(u.cost_usd_micros) AS cost_usd_micros, SUM(CASE WHEN u.cost_usd_micros IS NULL THEN 1 ELSE 0 END) AS unknown_cost_samples FROM usage_samples u JOIN attempts a ON u.attempt_id=a.id"+where;
    return runId ? this.db.prepare(sql).get(runId) : this.db.prepare(sql).get();
  }
  getArtifact(id:string) {
    const row=this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as Row|undefined;
    if (!row) throw new LedgerError("ARTIFACT_NOT_FOUND","Artifact does not exist",404);
    return row;
  }
}
