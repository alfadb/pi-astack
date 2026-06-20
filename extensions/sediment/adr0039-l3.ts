import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const sqliteModule = require("node:sqlite") as { DatabaseSync: new (filename: string) => DatabaseSyncLike };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

interface StatementSyncLike {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): Record<string, unknown> | undefined;
}

export interface Adr0039L3SyncResult {
  ok: boolean;
  dbPath: string;
  counts: {
    l1Events: number;
    l2Views: number;
    projectorState: number;
    jobs: number;
    diagnostics: number;
  };
  failures: string[];
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function toJsonValue(value: unknown, at = "root"): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => toJsonValue(item, `${at}[${index}]`));
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = toJsonValue(child, `${at}.${key}`);
    }
    return out;
  }
  throw new Error(`unsupported JSON value at ${at}: ${typeof value}`);
}

function listFiles(root: string, predicate = (_file: string) => true): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile() && predicate(full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function relativeUnix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function expectedEventRelativePath(eventId: string): string {
  return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

function openDatabase(dbPath: string): DatabaseSyncLike {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l1_events (
  event_id TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at_utc TEXT,
  source_domain TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projector_state (
  projector TEXT PRIMARY KEY,
  watermark_event_id TEXT,
  updated_at_utc TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l2_views (
  view_id TEXT PRIMARY KEY,
  view_kind TEXT NOT NULL,
  source_event_id TEXT,
  input_event_set_hash TEXT,
  output_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
`);
  return db;
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mirrorL1Events(abrainHome: string, db: DatabaseSyncLike, failures: string[]): number {
  const files = listFiles(path.join(abrainHome, "l1", "events"), (file) => file.endsWith(".json"));
  const insert = db.prepare("INSERT INTO l1_events(event_id, body_hash, schema_name, event_type, created_at_utc, source_domain, file_path, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const file of files) {
    const rel = relativeUnix(abrainHome, file);
    const raw = fs.readFileSync(file, "utf-8");
    try {
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      const body = envelope.body as Record<string, unknown> | undefined;
      const eventId = scalarString(envelope.event_id) || "";
      const bodyHash = sha256Hex(canonicalJson(toJsonValue(body ?? null)));
      const expectedRel = /^[0-9a-f]{64}$/.test(eventId) ? expectedEventRelativePath(eventId) : "";
      if (eventId !== bodyHash || envelope.body_hash !== bodyHash) failures.push(`${rel}: l3_body_hash_mismatch`);
      if (expectedRel && rel !== expectedRel) failures.push(`${rel}: l3_content_address_path_mismatch`);
      insert.run(
        eventId || sha256Hex(raw),
        String(envelope.body_hash || bodyHash),
        String(envelope.schema || "unknown"),
        String(body?.event_type || "unknown"),
        scalarString(body?.created_at_utc),
        String(body?.intent && typeof body.intent === "object" && (body.intent as Record<string, unknown>).domain_hint || "unknown"),
        rel,
        sha256Hex(raw),
      );
    } catch (err) {
      failures.push(`${rel}: l3_invalid_event_json:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return files.length;
}

function readFrontmatterScalar(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1]!.trim().replace(/^"(.*)"$/, "$1") : null;
}

function mirrorL2Views(abrainHome: string, db: DatabaseSyncLike, failures: string[]): number {
  let count = 0;
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO l2_views(view_id, view_kind, source_event_id, input_event_set_hash, output_hash, file_path, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const knowledgeRoot = path.join(abrainHome, ".state", "sediment", "knowledge-projection", "latest");
  for (const file of listFiles(knowledgeRoot, (candidate) => candidate.endsWith(".md"))) {
    const raw = fs.readFileSync(file, "utf-8");
    const rel = relativeUnix(abrainHome, file);
    const sourceEventId = readFrontmatterScalar(raw, "sediment_event_id");
    const inputEventSetHash = readFrontmatterScalar(raw, "sediment_input_event_set_hash") || sourceEventId;
    if (sourceEventId && !/^[0-9a-f]{64}$/.test(sourceEventId)) failures.push(`${rel}: l3_invalid_source_event_id`);
    insert.run(`knowledge:${rel}`, "knowledge-projection", sourceEventId, inputEventSetHash, sha256Hex(raw), rel, now);
    count += 1;
  }

  const shadowRoot = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  for (const name of ["decision.json", "compiled-view.md", "event-coverage.json"]) {
    const file = path.join(shadowRoot, name);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf-8");
    const rel = relativeUnix(abrainHome, file);
    insert.run(`constraint-shadow:${name}`, "constraint-shadow", null, null, sha256Hex(raw), rel, now);
    count += 1;
  }
  return count;
}

function mirrorProjectorState(abrainHome: string, db: DatabaseSyncLike): number {
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO projector_state(projector, watermark_event_id, updated_at_utc, detail_json) VALUES (?, ?, ?, ?)");
  let count = 0;
  const knowledgeManifest = path.join(abrainHome, ".state", "sediment", "knowledge-projection", "latest", "manifest.json");
  if (fs.existsSync(knowledgeManifest)) {
    const manifest = JSON.parse(fs.readFileSync(knowledgeManifest, "utf-8")) as Record<string, unknown>;
    insert.run("knowledge-projector", scalarString(manifest.latestEventId), now, JSON.stringify(manifest));
    count += 1;
  }
  const constraintDecision = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "decision.json");
  if (fs.existsSync(constraintDecision)) {
    const decision = JSON.parse(fs.readFileSync(constraintDecision, "utf-8")) as Record<string, unknown>;
    insert.run("constraint-shadow", scalarString(decision.inputRootHash), now, JSON.stringify(decision));
    count += 1;
  }
  return count;
}

export function syncAdr0039L3Store(args: { abrainHome: string; dbPath?: string }): Adr0039L3SyncResult {
  const abrainHome = path.resolve(args.abrainHome);
  const dbPath = path.resolve(args.dbPath || path.join(abrainHome, ".state", "sediment", "adr0039-l3", "adr0039.sqlite"));
  const failures: string[] = [];
  const db = openDatabase(dbPath);
  const startedAt = new Date().toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const table of ["meta", "l1_events", "projector_state", "l2_views", "jobs", "diagnostics"]) db.exec(`DELETE FROM ${table}`);
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("schema_version", "adr0039-l3/v1");
    const l1Events = mirrorL1Events(abrainHome, db, failures);
    const l2Views = mirrorL2Views(abrainHome, db, failures);
    const projectorState = mirrorProjectorState(abrainHome, db);
    const finishedAt = new Date().toISOString();
    db.prepare("INSERT INTO jobs(job_id, kind, status, created_at_utc, updated_at_utc, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`adr0039-l3-sync:${finishedAt}`, "adr0039-l3-sync", failures.length ? "failed" : "completed", startedAt, finishedAt, JSON.stringify({ l1Events, l2Views, projectorState }));
    const diagnosticInsert = db.prepare("INSERT INTO diagnostics(diagnostic_id, severity, code, message, created_at_utc) VALUES (?, ?, ?, ?, ?)");
    for (const failure of failures) diagnosticInsert.run(sha256Hex(failure), "error", failure.split(":")[1]?.trim() || "adr0039_l3_failure", failure, finishedAt);
    db.exec("COMMIT");
    return { ok: failures.length === 0, dbPath, counts: { l1Events, l2Views, projectorState, jobs: 1, diagnostics: failures.length }, failures };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, dbPath, counts: { l1Events: 0, l2Views: 0, projectorState: 0, jobs: 0, diagnostics: 1 }, failures: [`l3_sync_failed:${message}`] };
  } finally {
    db.close();
  }
}
