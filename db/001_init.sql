-- LEL v1, SQLite 3.40+; run under PRAGMA foreign_keys=ON.
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(length(source)>0),
  repository TEXT NOT NULL CHECK(length(repository)>0),
  external_id TEXT NOT NULL CHECK(length(external_id)>0),
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source,repository,external_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('created','running','waiting','blocked','completed','failed','cancelled')),
  phase TEXT,
  result TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_work_item_created ON runs(work_item_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status,updated_at DESC);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  parent_attempt_id TEXT REFERENCES attempts(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  host TEXT,
  phase TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted','timed_out','cancelled')),
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_heartbeat_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(parent_attempt_id IS NULL OR parent_attempt_id<>id)
);
CREATE INDEX IF NOT EXISTS idx_attempts_run_start ON attempts(run_id,started_at);
CREATE INDEX IF NOT EXISTS idx_attempts_status_heartbeat ON attempts(status,last_heartbeat_at);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_hash TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES attempts(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  phase TEXT,
  message TEXT,
  occurred_at TEXT,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id,seq);
CREATE INDEX IF NOT EXISTS idx_events_attempt_seq ON events(attempt_id,seq);
CREATE INDEX IF NOT EXISTS idx_events_type_seq ON events(event_type,seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES attempts(id) ON DELETE RESTRICT,
  artifact_type TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  content_type TEXT NOT NULL,
  encoding TEXT,
  sanitized INTEGER NOT NULL CHECK(sanitized IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON artifacts(attempt_id,created_at);

CREATE TABLE IF NOT EXISTS usage_samples (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens>=0),
  cost_usd_micros INTEGER CHECK(cost_usd_micros IS NULL OR cost_usd_micros>=0),
  source TEXT NOT NULL CHECK(source IN ('provider_reported','estimated','manual')),
  recorded_at TEXT NOT NULL,
  metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json))
);
CREATE INDEX IF NOT EXISTS idx_usage_attempt ON usage_samples(attempt_id);

-- Events form an immutable audit record. Lifecycle projections (runs/attempts)
-- are mutable only through the deterministic service write transaction.
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT,'events are immutable'); END;

INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
