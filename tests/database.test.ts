import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

test("append-only history rejects SQLite replacement through either unique key", () => {
  const db = new Database(":memory:");
  try {
    db.exec(readFileSync("db/001_init.sql","utf8"));
    const insert = "INSERT INTO events(seq,event_id,event_hash,actor,event_type,recorded_at,payload_json) VALUES (1,'original','hash','synthetic','system.tick','2026-11-17T00:00:00.000Z','{}')";
    db.exec(insert);
    const original = db.prepare("SELECT * FROM events").get();
    for (const replacement of [
      "INSERT OR REPLACE INTO events(event_id,event_hash,actor,event_type,recorded_at,payload_json) VALUES ('original','changed','synthetic','system.error','later','{}')",
      "INSERT OR REPLACE INTO events(seq,event_id,event_hash,actor,event_type,recorded_at,payload_json) VALUES (1,'different','changed','synthetic','system.error','later','{}')"
    ]) {
      assert.throws(() => db.exec(replacement), /immutable/);
      assert.deepEqual(db.prepare("SELECT * FROM events").get(), original);
    }
  } finally {db.close();}
});
