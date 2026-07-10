#!/usr/bin/env node
/**
 * ADR 0039 P3b Phase 1.5 dossier — production audit replay for Constraint Evidence Events.
 *
 * User-initiated only. By default this script writes to a temporary abrain home,
 * replays real production rules audit rows into L1 Constraint Evidence Events,
 * and records a report under .state/sediment/constraint-events/audit-replay/.
 * It does not register runtime hooks, does not change session_start injection,
 * and does not write canonical memory.
 *
 * Usage:
 *   node scripts/dossier-constraint-audit-replay.mjs [--audit ~/.abrain/.state/sediment/audit.jsonl]
 *     [--abrain /tmp/constraint-audit-replay-abrain] [--source-abrain ~/.abrain]
 *     [--limit 12] [--min-sessions 3] [--project pi-global] [--keep]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const HARNESS_VERSION = "adr0039-p3b-phase1.5-audit-replay/v1";

function arg(name, def) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function fileSha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function transpile(srcPath) {
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
  new (require("node:vm").Script)(out, { filename: srcPath });
  return out;
}

function stageTs(outRoot, src, dst = src.replace(/^extensions\//, "").replace(/\.ts$/, ".js")) {
  writeFile(path.join(outRoot, dst), transpile(path.join(repoRoot, src)));
}

function safeAbrainHome(value) {
  if (!value) return fs.mkdtempSync(path.join(os.tmpdir(), "constraint-audit-replay-"));
  const resolved = path.resolve(value);
  const tempRoot = path.resolve(os.tmpdir());
  const rel = path.relative(tempRoot, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
  throw new Error(`--abrain must point inside ${tempRoot}; refusing non-temporary abrain path ${resolved}`);
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function treeHash(root) {
  return sha256Hex(listFiles(root).map((rel) => `${rel}:${sha256Hex(fs.readFileSync(path.join(root, rel), "utf8"))}`).join("\n"));
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\n+/)
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.trim())
    .map((item) => ({ rowIndex: item.index, ...JSON.parse(item.line) }));
}

function parsePositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function sourceTextForRow(row, sourceAbrainHome) {
  const target = typeof row.target === "string" ? row.target : "";
  if (target) {
    const file = path.resolve(sourceAbrainHome, target);
    const rel = path.relative(path.resolve(sourceAbrainHome), file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8");
    }
  }
  return [
    typeof row.slug === "string" ? `slug: ${row.slug}` : "",
    typeof row.operation === "string" ? `operation: ${row.operation}` : "",
    typeof row.reason === "string" ? `reason: ${row.reason}` : "",
    typeof row.target === "string" ? `target: ${row.target}` : "",
  ].filter(Boolean).join("\n");
}

function selectRows(rows, limit, minSessions) {
  const supported = new Set(["create", "update", "merge", "archive", "reject"]);
  const candidates = rows.filter((row) => row.lane === "rules" && supported.has(row.operation));
  const selected = [];
  const used = new Set();
  const operations = ["create", "update", "merge", "archive", "reject"];
  for (const operation of operations) {
    const item = candidates.find((row) => row.operation === operation && !used.has(row.rowIndex));
    if (item) {
      selected.push(item);
      used.add(item.rowIndex);
    }
  }
  for (const item of candidates) {
    if (selected.length >= limit) break;
    if (used.has(item.rowIndex)) continue;
    selected.push(item);
    used.add(item.rowIndex);
  }
  const sessions = new Set(selected.map((row) => row.sessionId).filter(Boolean));
  if (selected.length < limit) throw new Error(`not enough replayable rules audit rows: selected=${selected.length} required=${limit}`);
  if (sessions.size < minSessions) throw new Error(`not enough sessions in selected audit rows: selected=${sessions.size} required=${minSessions}`);
  return selected;
}

function diagnosticsSummary(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics ?? []) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort());
}

const KEEP = hasFlag("keep");
const auditPath = path.resolve(arg("audit", path.join(os.homedir(), ".abrain", ".state", "sediment", "audit.jsonl")));
const sourceAbrainHome = path.resolve(arg("source-abrain", path.join(os.homedir(), ".abrain")));
const abrainHome = safeAbrainHome(arg("abrain", ""));
const limit = parsePositiveInt(arg("limit", "12"), "limit");
const minSessions = parsePositiveInt(arg("min-sessions", "3"), "min-sessions");
const activeProjectId = arg("project", "pi-global");
const replayRunId = arg("run-id", `${new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z")}-${process.pid}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-audit-replay-stage-"));
for (const file of [
  "extensions/_shared/jcs.ts",
  "extensions/_shared/l1-schema-registry.ts",
  "extensions/sediment/constraint-evidence/types.ts",
  "extensions/sediment/constraint-evidence/canonical-json.ts",
  "extensions/sediment/constraint-evidence/diagnostics.ts",
  "extensions/sediment/constraint-evidence/hash-envelope.ts",
  "extensions/sediment/constraint-evidence/read.ts",
  "extensions/sediment/constraint-evidence/append.ts",
  "extensions/sediment/constraint-evidence/audit-replay.ts",
]) {
  stageTs(tmp, file);
}
fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(tmp, "schemas", "l1-schema-role-registry.json"));

const { appendConstraintEvidenceEvent } = require(path.join(tmp, "sediment", "constraint-evidence", "append.js"));
const { parseConstraintEvidenceEnvelopeJson } = require(path.join(tmp, "sediment", "constraint-evidence", "read.js"));
const {
  buildConstraintEvidenceEventBodyFromAuditRow,
  constraintAuditReplayMappingRulesHash,
  CONSTRAINT_AUDIT_REPLAY_MAPPING_RULES,
  CONSTRAINT_AUDIT_REPLAY_MAPPING_VERSION,
} = require(path.join(tmp, "sediment", "constraint-evidence", "audit-replay.js"));

console.log("constraint audit replay dossier — ADR 0039 P3b Phase 1.5");
console.log(`auditPath: ${auditPath}`);
console.log(`sourceAbrainHome: ${sourceAbrainHome}`);
console.log(`abrainHome: ${abrainHome}`);
console.log(`limit: ${limit}`);
console.log(`minSessions: ${minSessions}`);
console.log(`keepTemp: ${KEEP}`);

if (!fs.existsSync(auditPath)) throw new Error(`audit jsonl not found: ${auditPath}`);
const auditJsonlSha256 = fileSha256(auditPath);
const rows = readJsonl(auditPath);
const selected = selectRows(rows, limit, minSessions);
const selectedOperations = Object.fromEntries([...selected.reduce((map, row) => {
  map.set(row.operation, (map.get(row.operation) ?? 0) + 1);
  return map;
}, new Map()).entries()].sort());
const selectedSessions = new Set(selected.map((row) => row.sessionId).filter(Boolean));
const rulesRoot = path.join(abrainHome, "rules");
const knowledgeRoot = path.join(abrainHome, "knowledge");
const projectsRoot = path.join(abrainHome, "projects");
const beforeCanonical = {
  rules: treeHash(rulesRoot),
  knowledge: treeHash(knowledgeRoot),
  projects: treeHash(projectsRoot),
};
const mappingTableSha256 = constraintAuditReplayMappingRulesHash();
const appendResults = [];
const mappingFailures = [];
const validationFailures = [];

for (const row of selected) {
  const mapped = buildConstraintEvidenceEventBodyFromAuditRow({
    row,
    auditJsonlPath: auditPath,
    auditJsonlSha256,
    replayRunId,
    replayHarnessVersion: HARNESS_VERSION,
    mappingTableSha256,
    activeProjectId,
    deviceId: "audit-replay-dossier-device",
    sourceText: sourceTextForRow(row, sourceAbrainHome),
  });
  if (!mapped.ok) {
    mappingFailures.push({ rowIndex: row.rowIndex, operation: row.operation, reason: mapped.reason });
    continue;
  }
  const append = await appendConstraintEvidenceEvent({ abrainHome, body: mapped.body });
  appendResults.push({ rowIndex: row.rowIndex, operation: row.operation, mappingRule: mapped.mappingRule, body: mapped.body, append });
  if (append.ok && append.filePath) {
    const parsed = parseConstraintEvidenceEnvelopeJson(fs.readFileSync(append.filePath, "utf8"), {
      abrainHome,
      filePath: append.filePath,
      relativePath: path.relative(abrainHome, append.filePath).split(path.sep).join("/"),
    });
    if (!parsed.ok) validationFailures.push({ rowIndex: row.rowIndex, eventId: append.eventId, diagnostics: parsed.diagnostics });
  }
}

const afterCanonical = {
  rules: treeHash(rulesRoot),
  knowledge: treeHash(knowledgeRoot),
  projects: treeHash(projectsRoot),
};
const eventFiles = listFiles(path.join(abrainHome, "l1", "events"));
const reportDir = path.join(abrainHome, ".state", "sediment", "constraint-events", "audit-replay");
const reportPath = path.join(reportDir, "report.json");
const auditOutputPath = path.join(reportDir, "append-audit.jsonl");
const appended = appendResults.filter((item) => item.append.ok).length;
const failed = appendResults.filter((item) => !item.append.ok).length;
const report = {
  schemaVersion: "constraint-audit-replay-dossier-report/v1",
  replayRunId,
  harnessVersion: HARNESS_VERSION,
  mappingVersion: CONSTRAINT_AUDIT_REPLAY_MAPPING_VERSION,
  mappingTableSha256,
  mappingRules: CONSTRAINT_AUDIT_REPLAY_MAPPING_RULES,
  auditPath,
  auditJsonlSha256,
  sourceAbrainHome,
  abrainHome,
  selectedRows: selected.length,
  selectedSessions: selectedSessions.size,
  selectedOperations,
  appended,
  failed,
  mappingFailures,
  validationFailures,
  eventFiles,
  canonicalChanged: beforeCanonical.rules !== afterCanonical.rules || beforeCanonical.knowledge !== afterCanonical.knowledge || beforeCanonical.projects !== afterCanonical.projects,
  beforeCanonical,
  afterCanonical,
  appendDiagnostics: diagnosticsSummary(appendResults.flatMap((item) => item.append.diagnostics)),
  events: appendResults.map((item) => ({
    rowIndex: item.rowIndex,
    operation: item.operation,
    eventId: item.append.eventId ?? null,
    status: item.append.status,
    ok: item.append.ok,
    filePath: item.append.filePath ?? null,
    sourceChannel: item.body.source.channel,
    replayProvenance: item.body.replay_provenance,
    diagnostics: item.append.diagnostics.map((diagnostic) => diagnostic.code),
  })),
};
writeJson(reportPath, report);
appendJsonLine(auditOutputPath, report);

console.log("\n-- replay result --");
console.log(`selectedRows=${selected.length}`);
console.log(`selectedSessions=${selectedSessions.size}`);
console.log(`selectedOperations=${JSON.stringify(selectedOperations)}`);
console.log(`appended=${appended}`);
console.log(`failed=${failed}`);
console.log(`mappingFailures=${mappingFailures.length}`);
console.log(`validationFailures=${validationFailures.length}`);
console.log(`eventFiles=${eventFiles.length}`);
console.log(`canonicalChanged=${report.canonicalChanged}`);
console.log(`reportPath=${reportPath}`);
console.log(`auditOutputPath=${auditOutputPath}`);

const ok = selected.length >= limit && selectedSessions.size >= minSessions && appended === selected.length && failed === 0 && mappingFailures.length === 0 && validationFailures.length === 0 && !report.canonicalChanged;
if (!KEEP) {
  fs.rmSync(abrainHome, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("tempCleaned=true");
} else {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("tempCleaned=false");
}
process.exit(ok ? 0 : 1);
