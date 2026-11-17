import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LedgerConfig {
  dbPath: string;
  artifactDir: string;
  dispatcherToken: string;
  readToken: string;
  port: number;
  host: string;
  heartbeatTtlMs: number;
  maxArtifactBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LedgerConfig {
  const dispatcherToken = env.LEDGER_DISPATCHER_TOKEN || "";
  const readToken = env.LEDGER_READ_TOKEN || "";
  if (dispatcherToken.length < 16 || readToken.length < 16) {
    throw new Error("LEDGER_DISPATCHER_TOKEN and LEDGER_READ_TOKEN must each be at least 16 characters");
  }
  if (dispatcherToken === readToken) throw new Error("Use separate dispatcher and read tokens");
  const integer = (name: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER - 1024) => {
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(name + " must be an integer between " + minimum + " and " + maximum);
    return value;
  };
  const port = integer("PORT", 4177, 0, 65535);
  const heartbeatTtlMs = integer("LEDGER_HEARTBEAT_TTL_MS", 120000, 1);
  const maxArtifactBytes = integer("LEDGER_MAX_ARTIFACT_BYTES", 10485760, 1);
  const dbPath = resolve(env.LEDGER_DB_PATH || "./data/ledger.db");
  const artifactDir = resolve(env.LEDGER_ARTIFACT_DIR || "./data/artifacts");
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  return {
    dbPath, artifactDir, dispatcherToken, readToken,
    port,
    host: env.HOST || "127.0.0.1",
    heartbeatTtlMs,
    maxArtifactBytes
  };
}
