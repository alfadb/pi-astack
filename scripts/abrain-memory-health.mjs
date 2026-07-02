#!/usr/bin/env node
/**
 * Read-only health report for the current second-brain memory topology.
 *
 * It complements, but does not replace, smoke-adr0039-reconcile.mjs:
 * - reconcile verifies strict L1/L2/L3 rebuild invariants and may refresh L3;
 * - this script only reads the live abrain tree and memory search metrics.
 *
 * Usage:
 *   node scripts/abrain-memory-health.mjs [--abrain ~/.abrain] [--project-root ~/.pi]
 *   node scripts/abrain-memory-health.mjs --strict
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultProjectRoot = path.resolve(repoRoot, "..", "..", "..");
const settingsPath = path.resolve(repoRoot, "..", "..", "pi-astack-settings.json");
const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listFiles(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function relativeUnix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

function expectedEventRelativePath(eventId) {
  return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function average(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function fmtNumber(value, digits = 2) {
  return value === null || value === undefined || Number.isNaN(value) ? "n/a" : Number(value).toFixed(digits);
}

function parseTs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
const projectRoot = path.resolve(expandHome(arg("project-root", defaultProjectRoot)));
const metricsWindow = toInt(arg("metrics-window", "200"), 200);
const strict = flag("strict");
const thresholds = {
  maxStage0FallbackRate: toFloat(arg("max-stage0-fallback-rate", "0.05"), 0.05),
  maxVerdictNoneRate: toFloat(arg("max-verdict-none-rate", "0.50"), 0.50),
  maxStage2P95Ms: toFloat(arg("max-stage2-p95-ms", "60000"), 60000),
  minAveragePoolHit: toFloat(arg("min-average-pool-hit", "0.50"), 0.50),
  maxLatestMetricsAgeHours: toFloat(arg("max-latest-metrics-age-hours", "24"), 24),
};

const settings = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
const findings = [];
function finding(level, code, message) {
  findings.push({ level, code, message });
}

function validateL1() {
  const files = listFiles(path.join(abrainHome, "l1", "events"), (file) => file.endsWith(".json"));
  const byDomain = new Map();
  const bySchema = new Map();
  const failures = [];
  for (const file of files) {
    const rel = relativeUnix(abrainHome, file);
    let envelope;
    try {
      envelope = readJson(file);
    } catch (err) {
      failures.push(`${rel}: invalid_json:${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const body = envelope.body ?? null;
    const eventId = typeof envelope.event_id === "string" ? envelope.event_id : "";
    const bodyHash = sha256Hex(canonicalJson(body));
    const schema = typeof body?.event_schema_version === "string" ? body.event_schema_version : String(envelope.schema || "unknown");
    const domain = body?.intent && typeof body.intent === "object" ? String(body.intent.domain_hint || "unknown") : "unknown";
    bySchema.set(schema, (bySchema.get(schema) || 0) + 1);
    byDomain.set(domain, (byDomain.get(domain) || 0) + 1);
    if (envelope.hash_alg !== "sha256") failures.push(`${rel}: hash_alg_not_sha256`);
    if (eventId !== bodyHash || envelope.body_hash !== bodyHash) failures.push(`${rel}: body_hash_mismatch`);
    if (/^[0-9a-f]{64}$/.test(eventId) && rel !== expectedEventRelativePath(eventId)) failures.push(`${rel}: content_address_path_mismatch`);
  }
  for (const failure of failures.slice(0, 10)) finding("ERROR", "l1_event_invalid", failure);
  if (failures.length > 10) finding("ERROR", "l1_event_invalid_more", `${failures.length - 10} additional L1 validation failures omitted`);
  return {
    files: files.length,
    failures: failures.length,
    byDomain: Object.fromEntries([...byDomain].sort()),
    bySchema: Object.fromEntries([...bySchema].sort()),
  };
}

function resolveKnowledgeLatestDir() {
  const outputRoot = settings?.sediment?.knowledgeProjector?.l2OutputRoot;
  const root = outputRoot === "repo"
    ? path.join(abrainHome, "l2", "views", "knowledge")
    : path.join(abrainHome, ".state", "sediment", "knowledge-projection");
  return path.join(root, "latest");
}

function summarizeL2Knowledge() {
  const latestDir = resolveKnowledgeLatestDir();
  const files = listFiles(latestDir, (file) => file.endsWith(".md"));
  let world = 0;
  let project = 0;
  let other = 0;
  const projectIds = new Set();
  for (const file of files) {
    const rel = relativeUnix(latestDir, file);
    if (rel.startsWith("world/")) world += 1;
    else if (rel.startsWith("projects/")) {
      project += 1;
      const projectId = rel.split("/")[1];
      if (projectId) projectIds.add(projectId);
    } else {
      other += 1;
    }
  }
  const manifestPath = path.join(latestDir, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  return { latestDir, files: files.length, world, project, other, projects: projectIds.size, manifest };
}

function countLegacySurfaces() {
  return {
    knowledgeMarkdown: listFiles(path.join(abrainHome, "knowledge"), (file) => file.endsWith(".md")).length,
    rulesMarkdown: listFiles(path.join(abrainHome, "rules"), (file) => file.endsWith(".md")).length,
    projectMarkdown: listFiles(path.join(abrainHome, "projects"), (file) => file.endsWith(".md")).length,
  };
}

function sqliteSummary() {
  const dbPath = path.join(abrainHome, ".state", "sediment", "adr0039-l3", "adr0039.sqlite");
  if (!fs.existsSync(dbPath)) {
    finding("WARN", "l3_sqlite_missing", `ADR0039 L3 SQLite not found: ${dbPath}`);
    return { dbPath, exists: false };
  }
  let sqliteModule;
  try {
    sqliteModule = require("node:sqlite");
  } catch (err) {
    finding("WARN", "node_sqlite_unavailable", `Cannot open L3 SQLite with node:sqlite: ${err instanceof Error ? err.message : String(err)}`);
    return { dbPath, exists: true, unavailable: true };
  }
  const db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get()?.cnt ?? 0);
    const counts = {
      l1Events: count("l1_events"),
      l2Views: count("l2_views"),
      searchCorpus: count("search_corpus"),
      projectorState: count("projector_state"),
      diagnostics: count("diagnostics"),
      jobs: count("jobs"),
    };
    const metaRows = db.prepare("SELECT key, value FROM meta ORDER BY key").all?.() ?? [];
    const meta = Object.fromEntries(metaRows.map((row) => [String(row.key), String(row.value)]));
    const latestJob = db.prepare("SELECT status, created_at_utc, updated_at_utc, detail_json FROM jobs WHERE kind='adr0039-l3-sync' ORDER BY updated_at_utc DESC LIMIT 1").get() ?? null;
    return { dbPath, exists: true, counts, meta, latestJob };
  } finally {
    db.close();
  }
}

function indexSummary() {
  const indexMetaPath = path.join(abrainHome, ".state", "memory", "index-meta.json");
  const embeddingsPath = path.join(abrainHome, ".state", "memory", "embeddings.json");
  const indexMeta = fs.existsSync(indexMetaPath) ? readJson(indexMetaPath) : null;
  let embeddings = null;
  if (fs.existsSync(embeddingsPath)) {
    const raw = readJson(embeddingsPath);
    embeddings = {
      path: embeddingsPath,
      model: raw.model,
      dim: raw.dim,
      entries: raw.entries && typeof raw.entries === "object" ? Object.keys(raw.entries).length : 0,
      version: raw.version,
    };
  }
  if (!indexMeta) finding("WARN", "index_meta_missing", `memory index meta not found: ${indexMetaPath}`);
  if (!embeddings) finding("WARN", "embedding_cache_missing", `embedding cache not found: ${embeddingsPath}`);
  return { indexMetaPath, embeddingsPath, indexMeta, embeddings };
}

function readMetrics() {
  const metricsPath = path.join(projectRoot, ".pi-astack", "memory", "search-metrics.jsonl");
  if (!fs.existsSync(metricsPath)) {
    finding("WARN", "search_metrics_missing", `search metrics not found: ${metricsPath}`);
    return { metricsPath, rows: [], invalidRows: 0 };
  }
  const lines = fs.readFileSync(metricsPath, "utf8").split("\n").filter((line) => line.trim());
  const rows = [];
  let invalidRows = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") rows.push(parsed);
    } catch {
      invalidRows += 1;
    }
  }
  if (invalidRows) finding("WARN", "search_metrics_invalid_rows", `${invalidRows} invalid JSONL rows in ${metricsPath}`);
  return { metricsPath, rows: rows.slice(-metricsWindow), totalRows: rows.length, invalidRows };
}

function summarizeMetrics(metrics) {
  const rows = metrics.rows;
  if (!rows.length) return { rows: 0 };
  const boolRate = (key) => rows.filter((row) => row[key] === true).length / rows.length;
  const verdictCounts = rows.reduce((acc, row) => {
    const key = String(row.verdict || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const nums = (key) => rows.map((row) => Number(row[key])).filter(Number.isFinite);
  const stage2 = nums("stage2_ms");
  const embed = nums("stage0_embed_ms");
  const poolHit = nums("stage0_pool_hit");
  const stale = nums("stage0_stale");
  const latestTs = rows.map((row) => parseTs(row.ts)).filter((v) => v !== null).sort((a, b) => b - a)[0] ?? null;
  const latestAgeHours = latestTs === null ? null : (Date.now() - latestTs) / 3600000;
  const stage0Modes = [...new Set(rows.map((row) => String(row.stage0_mode || "unknown")))].sort();
  const stage1Surfaces = [...new Set(rows.map((row) => String(row.stage1_surface || "unknown")))].sort();
  const llmErrorRows = rows.filter((row) => row.s1?.err || row.s2?.err).length;
  const summary = {
    rows: rows.length,
    totalRows: metrics.totalRows,
    verdictCounts,
    noneRate: (verdictCounts.none || 0) / rows.length,
    stage0FallbackRate: boolRate("stage0_fallback"),
    stage0ExpandedRate: boolRate("stage0_expanded"),
    stage0Modes,
    stage1Surfaces,
    llmErrorRows,
    stage2Ms: { p50: percentile(stage2, 0.5), p95: percentile(stage2, 0.95), max: percentile(stage2, 1) },
    stage0EmbedMs: { p50: percentile(embed, 0.5), p95: percentile(embed, 0.95), max: percentile(embed, 1) },
    stage0PoolHit: { avg: average(poolHit), min: percentile(poolHit, 0), p50: percentile(poolHit, 0.5) },
    stage0Stale: { max: percentile(stale, 1) },
    latestAgeHours,
  };
  if (summary.stage0FallbackRate > thresholds.maxStage0FallbackRate) {
    finding("WARN", "stage0_fallback_rate_high", `stage0 fallback rate ${fmtNumber(summary.stage0FallbackRate)} > ${fmtNumber(thresholds.maxStage0FallbackRate)}`);
  }
  if (summary.noneRate > thresholds.maxVerdictNoneRate) {
    finding("WARN", "verdict_none_rate_high", `verdict=none rate ${fmtNumber(summary.noneRate)} > ${fmtNumber(thresholds.maxVerdictNoneRate)}`);
  }
  if (summary.stage2Ms.p95 !== null && summary.stage2Ms.p95 > thresholds.maxStage2P95Ms) {
    finding("WARN", "stage2_p95_slow", `stage2 p95 ${summary.stage2Ms.p95}ms > ${thresholds.maxStage2P95Ms}ms`);
  }
  if (summary.stage0PoolHit.avg !== null && summary.stage0PoolHit.avg < thresholds.minAveragePoolHit) {
    finding("WARN", "stage0_pool_hit_low", `stage0_pool_hit avg ${fmtNumber(summary.stage0PoolHit.avg)} < ${fmtNumber(thresholds.minAveragePoolHit)}`);
  }
  if (summary.latestAgeHours !== null && summary.latestAgeHours > thresholds.maxLatestMetricsAgeHours) {
    finding("WARN", "search_metrics_stale", `latest search metrics row is ${fmtNumber(summary.latestAgeHours)}h old`);
  }
  if (llmErrorRows > 0) finding("WARN", "search_llm_error_rows", `${llmErrorRows} rows contain s1/s2 errors in the sampled window`);
  return summary;
}

function compareDerived(l1, l2, l3, index) {
  if (l3.exists && l3.counts) {
    if (l3.counts.l1Events !== l1.files) finding("WARN", "l3_l1_count_drift", `L3 l1_events=${l3.counts.l1Events}, L1 event files=${l1.files}`);
    if (l3.counts.searchCorpus !== l2.files) finding("WARN", "l3_search_corpus_drift", `L3 search_corpus=${l3.counts.searchCorpus}, L2 knowledge md=${l2.files}`);
    if (!l3.meta?.schema_deferred) finding("WARN", "l3_deferred_marker_missing", "L3 meta.schema_deferred missing; vector/graph boundary may be ambiguous");
  }
  if (index.indexMeta?.coverageRatio !== undefined && Number(index.indexMeta.coverageRatio) < 1) {
    finding("WARN", "embedding_coverage_below_one", `index-meta coverageRatio=${index.indexMeta.coverageRatio}`);
  }
  if (index.indexMeta && index.embeddings && Number(index.indexMeta.indexedEntries) !== index.embeddings.entries) {
    finding("WARN", "embedding_index_count_drift", `index-meta indexedEntries=${index.indexMeta.indexedEntries}, embeddings entries=${index.embeddings.entries}`);
  }
}

function printJsonBlock(label, value) {
  console.log(`${label}: ${JSON.stringify(value)}`);
}

if (!fs.existsSync(abrainHome)) finding("ERROR", "abrain_missing", `abrain home not found: ${abrainHome}`);

const l1 = fs.existsSync(abrainHome) ? validateL1() : { files: 0, failures: 0, byDomain: {}, bySchema: {} };
const l2 = fs.existsSync(abrainHome) ? summarizeL2Knowledge() : { latestDir: "", files: 0, world: 0, project: 0, other: 0, projects: 0, manifest: null };
const legacy = fs.existsSync(abrainHome) ? countLegacySurfaces() : { knowledgeMarkdown: 0, rulesMarkdown: 0, projectMarkdown: 0 };
const l3 = fs.existsSync(abrainHome) ? sqliteSummary() : { exists: false };
const index = fs.existsSync(abrainHome) ? indexSummary() : { indexMeta: null, embeddings: null };
const metrics = readMetrics();
const metricsSummary = summarizeMetrics(metrics);
compareDerived(l1, l2, l3, index);

console.log("Second-brain memory health (read-only)");
console.log(`abrainHome: ${abrainHome}`);
console.log(`projectRoot: ${projectRoot}`);
console.log(`strict: ${strict ? "yes" : "no"}`);
console.log("");
printJsonBlock("runtime_config", {
  knowledgeEvidenceMode: settings?.sediment?.knowledgeEvidenceEventWriter?.mode,
  legacyMarkdownWriteOnSuccessfulEvent: settings?.sediment?.knowledgeEvidenceEventWriter?.legacyMarkdownWriteOnSuccessfulEvent,
  constraintEvidenceMode: settings?.sediment?.constraintEvidenceEventWriter?.mode,
  canonicalReadMode: settings?.sediment?.knowledgeProjector?.canonicalReadMode,
  l2OutputRoot: settings?.sediment?.knowledgeProjector?.l2OutputRoot,
  stage1Skip: settings?.memory?.search?.stage1Skip,
  sparseBM25: settings?.memory?.search?.sparseBM25,
  stage2Model: settings?.memory?.search?.stage2Model,
});
printJsonBlock("l1_events", l1);
printJsonBlock("l2_knowledge", { latestDir: l2.latestDir, files: l2.files, world: l2.world, project: l2.project, projects: l2.projects, other: l2.other, manifestLatestEventId: l2.manifest?.latestEventId });
printJsonBlock("legacy_surfaces", legacy);
printJsonBlock("l3_sqlite", l3.exists ? { dbPath: l3.dbPath, counts: l3.counts, meta: l3.meta, latestJob: l3.latestJob } : l3);
printJsonBlock("embedding_index", { indexMeta: index.indexMeta, embeddings: index.embeddings });
printJsonBlock("search_metrics", { metricsPath: metrics.metricsPath, window: metricsWindow, summary: metricsSummary, thresholds });
console.log("");
if (!findings.length) {
  console.log("PASS: no health findings in this window.");
  process.exit(0);
}
for (const item of findings) console.log(`${item.level}: ${item.code}: ${item.message}`);
const errors = findings.filter((item) => item.level === "ERROR").length;
const warnings = findings.filter((item) => item.level === "WARN").length;
if (errors || (strict && warnings)) {
  console.log(`FAIL: ${errors} error(s), ${warnings} warning(s)${strict ? " (strict)" : ""}.`);
  process.exit(1);
}
console.log(`PASS_WITH_WARNINGS: ${warnings} warning(s); rerun with --strict to gate on warnings.`);
process.exit(0);
