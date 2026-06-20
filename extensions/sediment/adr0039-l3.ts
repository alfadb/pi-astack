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
    eventEdges: number;
    l2Views: number;
    searchCorpusRows: number;
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
CREATE TABLE IF NOT EXISTS event_edges (
  parent_event_id TEXT NOT NULL,
  child_event_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  created_at_utc TEXT,
  PRIMARY KEY (parent_event_id, child_event_id, edge_type)
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
CREATE TABLE IF NOT EXISTS search_corpus (
  row_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  file_path TEXT NOT NULL,
  search_text_hash TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_corpus_fts USING fts5(
  row_id UNINDEXED,
  slug,
  title,
  body,
  file_path UNINDEXED
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
-- ADR0039 §4.5 (4×T0 unanimous DEFER, 2026-06-20): the vector
-- (chunks/embeddings) and graph (graph_nodes/graph_edges) tables from the
-- §4.5 suggested boundaries are INTENTIONALLY NOT created in v1. There is no
-- load evidence: vectors already live in ~/.abrain/.state/memory/embeddings.json
-- (rebuildable, model-stamped — ADR0035), and the graph layer has zero consumers
-- (event_edges already covers the event-level causal DAG). Per §4.5 line 95 /
-- line 217, defer until a real reproducible load (see the evidence-gate in
-- docs/notes/2026-06-20-adr0039-l3-schema-defer-consensus.md). Add the tables
-- ONLY together with their mirror logic + reconcile assertions + a rebuildability
-- proof, and remove this deferral marker.
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

function edgeTypeForOperation(operationHint: string): string {
  switch (operationHint) {
    case "update": return "correction";
    case "merge": return "merge";
    case "supersede": return "supersede";
    case "correction": return "correction";
    case "archive": return "archive";
    case "reactivate": return "reactivate";
    case "delete": return "delete";
    default: return "causal";
  }
}

function mirrorEventEdges(abrainHome: string, db: DatabaseSyncLike, failures: string[]): number {
  const knownEventIds = new Set<string>();
  for (const file of listFiles(path.join(abrainHome, "l1", "events"), (candidate) => candidate.endsWith(".json"))) {
    try {
      const envelope = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      const eventId = scalarString(envelope.event_id);
      if (eventId) knownEventIds.add(eventId);
    } catch { /* invalid event already reported by mirrorL1Events */ }
  }
  const insert = db.prepare("INSERT OR IGNORE INTO event_edges(parent_event_id, child_event_id, edge_type, ordinal, created_at_utc) VALUES (?, ?, ?, ?, ?)");
  let count = 0;
  for (const file of listFiles(path.join(abrainHome, "l1", "events"), (candidate) => candidate.endsWith(".json"))) {
    const rel = relativeUnix(abrainHome, file);
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const childId = scalarString(envelope.event_id);
    const body = envelope.body as Record<string, unknown> | undefined;
    if (!childId || !body) continue;
    const parents = Array.isArray(body.causal_parents) ? body.causal_parents : [];
    const operationHint = String(((body.intent as Record<string, unknown> | undefined)?.operation_hint) ?? "");
    const edgeType = edgeTypeForOperation(operationHint);
    const createdAt = scalarString(body.created_at_utc);
    parents.forEach((parent, ordinal) => {
      const parentId = typeof parent === "string" ? parent : "";
      if (!/^[0-9a-f]{64}$/.test(parentId)) {
        failures.push(`${rel}: l3_event_edge_invalid_parent`);
        return;
      }
      // event_edges must be rebuildable from L1 only; a dangling parent means
      // the causal graph references an event that is not present in L1.
      if (!knownEventIds.has(parentId)) failures.push(`${rel}: l3_event_edge_dangling_parent:${parentId}`);
      insert.run(parentId, childId, edgeType, ordinal, createdAt);
      count += 1;
    });
  }
  return count;
}

function readFrontmatterScalar(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1]!.trim().replace(/^"(.*)"$/, "$1") : null;
}

function splitMarkdown(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { frontmatter: match[1]!, body: match[2]!.trim() } : { frontmatter: "", body: raw.trim() };
}

function mirrorKnowledgeSearchCorpus(abrainHome: string, knowledgeRoot: string, db: DatabaseSyncLike, failures: string[]): number {
  let count = 0;
  const now = new Date().toISOString();
  const rows = db.prepare("INSERT INTO search_corpus(row_id, source_event_id, slug, scope, project_id, title, kind, status, confidence, provenance, file_path, search_text_hash, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const fts = db.prepare("INSERT INTO search_corpus_fts(row_id, slug, title, body, file_path) VALUES (?, ?, ?, ?, ?)");
  for (const file of listFiles(knowledgeRoot, (candidate) => candidate.endsWith(".md"))) {
    const raw = fs.readFileSync(file, "utf-8");
    const rel = relativeUnix(abrainHome, file);
    const parsed = splitMarkdown(raw);
    const sourceEventId = readFrontmatterScalar(parsed.frontmatter, "sediment_event_id") || "";
    const slug = path.basename(file, ".md");
    const scope = readFrontmatterScalar(parsed.frontmatter, "scope") || "unknown";
    const projectId = readFrontmatterScalar(parsed.frontmatter, "project_id");
    const title = readFrontmatterScalar(parsed.frontmatter, "title") || slug;
    const kind = readFrontmatterScalar(parsed.frontmatter, "kind") || "fact";
    const status = readFrontmatterScalar(parsed.frontmatter, "status") || "active";
    const confidence = Number(readFrontmatterScalar(parsed.frontmatter, "confidence") || 0);
    const provenance = readFrontmatterScalar(parsed.frontmatter, "provenance") || "unknown";
    if (!/^[0-9a-f]{64}$/.test(sourceEventId)) failures.push(`${rel}: l3_search_corpus_missing_event_id`);
    const rowId = `knowledge:${rel}`;
    rows.run(rowId, sourceEventId, slug, scope, projectId, title, kind, status, Number.isFinite(confidence) ? confidence : 0, provenance, rel, sha256Hex(raw.trim()), now);
    fts.run(rowId, slug, title, parsed.body, rel);
    count += 1;
  }
  return count;
}

function mirrorL2Views(abrainHome: string, knowledgeRoot: string, db: DatabaseSyncLike, failures: string[]): number {
  let count = 0;
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO l2_views(view_id, view_kind, source_event_id, input_event_set_hash, output_hash, file_path, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)");
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

function mirrorProjectorState(abrainHome: string, knowledgeRoot: string, db: DatabaseSyncLike): number {
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO projector_state(projector, watermark_event_id, updated_at_utc, detail_json) VALUES (?, ?, ?, ?)");
  let count = 0;
  const knowledgeManifest = path.join(knowledgeRoot, "manifest.json");
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

export function syncAdr0039L3Store(args: { abrainHome: string; dbPath?: string; knowledgeLatestDir?: string }): Adr0039L3SyncResult {
  const abrainHome = path.resolve(args.abrainHome);
  const dbPath = path.resolve(args.dbPath || path.join(abrainHome, ".state", "sediment", "adr0039-l3", "adr0039.sqlite"));
  // ADR 0039 B1: Knowledge L2 root is flag-resolved by the caller; default keeps
  // the legacy .state location so existing behavior is unchanged.
  const knowledgeLatestDir = path.resolve(args.knowledgeLatestDir || path.join(abrainHome, ".state", "sediment", "knowledge-projection", "latest"));
  const failures: string[] = [];
  const db = openDatabase(dbPath);
  const startedAt = new Date().toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const table of ["meta", "l1_events", "event_edges", "projector_state", "l2_views", "search_corpus", "search_corpus_fts", "jobs", "diagnostics"]) db.exec(`DELETE FROM ${table}`);
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("schema_version", "adr0039-l3/v1");
    // ADR0039 §4.5 (4×T0 unanimous DEFER): durable, queryable receipt that the
    // vector + graph tables are deliberately absent (no load evidence), not
    // forgotten. Retire this row when the evidence-gate fires and the tables land.
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("schema_deferred", "vector(chunks,embeddings)+graph(graph_nodes,graph_edges): deferred, no load evidence (ADR0039 §4.5; vectors in .state/memory/embeddings.json per ADR0035; graph zero consumers)");
    const l1Events = mirrorL1Events(abrainHome, db, failures);
    const eventEdges = mirrorEventEdges(abrainHome, db, failures);
    const l2Views = mirrorL2Views(abrainHome, knowledgeLatestDir, db, failures);
    const searchCorpusRows = mirrorKnowledgeSearchCorpus(abrainHome, knowledgeLatestDir, db, failures);
    const projectorState = mirrorProjectorState(abrainHome, knowledgeLatestDir, db);
    // ADR0039 §4.5 deferred-table tripwire (4×T0 unanimous, deepseek form): the
    // expected state is ABSENCE — this never fails on a deferred (missing) table.
    // It only fires if a future change CREATES one of the deferred tables but
    // leaves partial/stale rows (a half-done migration leaking data into a table
    // whose mirror+reconcile aren't wired yet). Activating a table = wire its
    // mirror + drop it from this list in the same change.
    for (const table of ["chunks", "embeddings", "graph_nodes", "graph_edges"]) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) continue;
      const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${table}"`).get() as { cnt?: number } | undefined;
      if (row && Number(row.cnt) > 0) failures.push(`adr0039-l3: deferred_table_has_data:${table}:${row.cnt}`);
    }
    const finishedAt = new Date().toISOString();
    db.prepare("INSERT INTO jobs(job_id, kind, status, created_at_utc, updated_at_utc, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`adr0039-l3-sync:${finishedAt}`, "adr0039-l3-sync", failures.length ? "failed" : "completed", startedAt, finishedAt, JSON.stringify({ l1Events, eventEdges, l2Views, searchCorpusRows, projectorState }));
    const diagnosticInsert = db.prepare("INSERT INTO diagnostics(diagnostic_id, severity, code, message, created_at_utc) VALUES (?, ?, ?, ?, ?)");
    for (const failure of failures) diagnosticInsert.run(sha256Hex(failure), "error", failure.split(":")[1]?.trim() || "adr0039_l3_failure", failure, finishedAt);
    db.exec("COMMIT");
    return { ok: failures.length === 0, dbPath, counts: { l1Events, eventEdges, l2Views, searchCorpusRows, projectorState, jobs: 1, diagnostics: failures.length }, failures };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, dbPath, counts: { l1Events: 0, eventEdges: 0, l2Views: 0, searchCorpusRows: 0, projectorState: 0, jobs: 0, diagnostics: 1 }, failures: [`l3_sync_failed:${message}`] };
  } finally {
    db.close();
  }
}
