#!/usr/bin/env node
/**
 * ADR 0039 P2 PR4 manual/replay dossier — Constraint Evidence Event append.
 *
 * User-initiated only. This script does not register runtime hooks, does not
 * trigger agent_end, and does not write canonical memory. It writes L1 events
 * only under a temporary abrain home unless --abrain points at a temp directory.
 *
 * Usage:
 *   node scripts/dossier-constraint-evidence-event.mjs [--quote text]
 *     [--replay-json file] [--type signal|correction|rejection|forget|retract|not-memory|unclassified]
 *     [--scope project|global|unknown] [--project pi-global]
 *     [--not-memory settings|tool_contract|provider_budget_flag|unknown]
 *     [--abrain /tmp/constraint-evidence-abrain] [--keep]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

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

function diagnosticsSummary(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics ?? []) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => `${code}:${count}`).join(", ") || "none";
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
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

function safeAbrainHome(value) {
  if (!value) return fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-dossier-"));
  const resolved = path.resolve(value);
  const tempRoot = path.resolve(os.tmpdir());
  const rel = path.relative(tempRoot, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
  throw new Error(`--abrain must point inside ${tempRoot}; refusing non-temporary abrain path ${resolved}`);
}

function eventTypeFromArg(value) {
  switch (value) {
    case "signal": return "constraint_signal_observed";
    case "correction": return "constraint_correction_observed";
    case "rejection": return "constraint_rejection_observed";
    case "forget": return "constraint_forget_observed";
    case "retract": return "constraint_retract_observed";
    case "not-memory": return "constraint_not_memory_observed";
    case "unclassified": return "constraint_unclassified_observed";
    default: throw new Error(`unsupported --type ${value}`);
  }
}

function operationHintFromType(eventType) {
  switch (eventType) {
    case "constraint_correction_observed": return "correction";
    case "constraint_rejection_observed": return "rejection";
    case "constraint_forget_observed": return "forget";
    case "constraint_retract_observed": return "retract";
    case "constraint_not_memory_observed": return "not_memory";
    case "constraint_unclassified_observed": return "unclassified";
    default: return "create";
  }
}

function scopeContext(scopeArg, projectId, sha256Hex) {
  if (scopeArg === "global") {
    return {
      active_project_binding: { project_id: projectId, binding_reason: "manual dossier argument" },
      scope_hint: { kind: "global", evidence: "manual dossier argument" },
      scope_confidence: 0.8,
    };
  }
  if (scopeArg === "unknown") {
    return {
      active_project_binding: { project_id: projectId, binding_reason: "manual dossier argument" },
      scope_hint: { kind: "unknown", reason: "manual dossier left scope unknown" },
      scope_confidence: 0.2,
    };
  }
  return {
    active_project_binding: {
      project_id: projectId,
      binding_reason: "manual dossier argument",
      cwd_hash: sha256Hex(process.cwd()),
    },
    scope_hint: { kind: "project", project_id: projectId, evidence: "manual dossier argument" },
    scope_confidence: 0.8,
  };
}

function bodyFromReplay(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function bodyFromArgs(input) {
  const quote = input.quote;
  const eventType = eventTypeFromArg(input.type);
  const operationHint = operationHintFromType(eventType);
  const notMemoryHint = input.notMemory;
  const payload = {
    sanitized_quote: quote,
    ...(eventType === "constraint_not_memory_observed"
      ? { not_memory_hint: notMemoryHint }
      : {
        candidate_constraint_text: quote,
        candidate_title: input.title,
        candidate_trigger_phrases: input.trigger ? [input.trigger] : [],
        candidate_applies_when: input.appliesWhen,
        candidate_priority_hint: "unknown",
      }),
    ...(eventType === "constraint_unclassified_observed" ? { unclassified_reason: "manual replay requested unclassified event" } : {}),
  };
  return {
    event_schema_version: input.eventSchemaVersion,
    event_type: eventType,
    created_at_utc: input.now,
    device_id: input.deviceId,
    producer_nonce: input.producerNonce,
    actor: { role: "user", id: "manual-dossier" },
    causal_parents: input.parent ? [input.parent] : [],
    session_id: input.sessionId,
    turn_id: input.turnId,
    source: {
      channel: "manual",
      source_role: "user",
      source_ref: `manual:${input.sessionId}/${input.turnId}`,
      quote_hash: input.sha256Hex(quote),
    },
    intent: { domain_hint: "constraint", operation_hint: operationHint, confidence: 0.75 },
    payload,
    scope: scopeContext(input.scope, input.projectId, input.sha256Hex),
    sanitizer: {
      sanitizer_name: "manual-dossier-sanitizer",
      sanitizer_version: "v1",
      status: input.blocked ? "blocked" : "passed",
      replacements_count: 0,
      ...(input.blocked ? { blocked_reason: "manual dossier --blocked" } : {}),
    },
    neighbor_summary: {
      retrieval_mode: "readonly",
      input_hash: input.sha256Hex("manual-dossier-neighbors"),
      neighbor_refs: [],
      summary: "manual dossier did not query live memory neighbors",
    },
    producer: {
      name: "sediment.constraint-event-writer",
      version: "dossier-pr4",
      code_version: "manual-replay",
    },
    privacy: { contains_user_quote: true, redaction_level: "none" },
  };
}

const KEEP = hasFlag("keep");
const replayJson = arg("replay-json", "");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-dossier-stage-"));
for (const file of [
  "extensions/_shared/durable-write.ts",
  "extensions/_shared/jcs.ts",
  "extensions/_shared/l1-schema-registry.ts",
  "extensions/sediment/constraint-evidence/types.ts",
  "extensions/sediment/constraint-evidence/canonical-json.ts",
  "extensions/sediment/constraint-evidence/diagnostics.ts",
  "extensions/sediment/constraint-evidence/hash-envelope.ts",
  "extensions/sediment/constraint-evidence/read.ts",
  "extensions/sediment/constraint-evidence/append.ts",
  "extensions/sediment/constraint-evidence/status.ts",
]) {
  stageTs(tmp, file);
}
fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(tmp, "schemas", "l1-schema-role-registry.json"));

const {
  appendConstraintEvidenceEvent,
} = require(path.join(tmp, "sediment", "constraint-evidence", "append.js"));
const {
  sha256Hex,
} = require(path.join(tmp, "sediment", "constraint-evidence", "hash-envelope.js"));
const {
  summarizeConstraintEventProjectionStatus,
} = require(path.join(tmp, "sediment", "constraint-evidence", "status.js"));

const abrainHome = safeAbrainHome(arg("abrain", ""));
const projectId = arg("project", "pi-global");
const now = arg("now", new Date().toISOString());
const sessionId = arg("session", "manual-session");
const turnId = arg("turn", "manual-turn");
const quote = arg("quote", "Use Evidence Event append for new durable constraint signals.");
const body = replayJson
  ? bodyFromReplay(replayJson)
  : bodyFromArgs({
    quote,
    type: arg("type", "signal"),
    title: arg("title", "Manual constraint evidence event"),
    trigger: arg("trigger", "Evidence Event"),
    appliesWhen: arg("applies-when", "new durable constraint signals"),
    scope: arg("scope", "project"),
    projectId,
    notMemory: arg("not-memory", "settings"),
    blocked: hasFlag("blocked"),
    parent: arg("parent", ""),
    now,
    sessionId,
    turnId,
    deviceId: arg("device", "manual-dossier-device"),
    producerNonce: arg("nonce", `${sessionId}:${turnId}:${now}`),
    eventSchemaVersion: "constraint-evidence-event/v1",
    sha256Hex,
  });

console.log("constraint evidence event dossier — ADR 0039 P2 PR4");
console.log(`mode: ${replayJson ? "replay-json" : "manual-fixture"}`);
console.log(`abrainHome: ${abrainHome}`);
console.log(`keepTemp: ${KEEP}`);
console.log(`eventType: ${body.event_type}`);
console.log(`sourceChannel: ${body.source?.channel ?? "unknown"}`);
console.log(`scopeHint: ${body.scope?.scope_hint?.kind ?? "unknown"}`);

const beforeRules = fs.existsSync(path.join(abrainHome, "rules"))
  ? JSON.stringify(listFiles(path.join(abrainHome, "rules")))
  : "[]";
const result = await appendConstraintEvidenceEvent({ abrainHome, body });
const afterRules = fs.existsSync(path.join(abrainHome, "rules"))
  ? JSON.stringify(listFiles(path.join(abrainHome, "rules")))
  : "[]";
const projection = summarizeConstraintEventProjectionStatus(result.ok
  ? [{ eventId: result.eventId, status: "queued", observedAtUtc: now }]
  : [{ eventId: result.eventId ?? "append-failed", status: "append_failed", observedAtUtc: now }], { nowMs: Date.parse(now) || Date.now() });
const eventFiles = listFiles(path.join(abrainHome, "l1", "events"));
const rulesFileListChanged = beforeRules !== afterRules;
const reportDir = path.join(abrainHome, ".state", "sediment", "constraint-events", "manual-dossier");
const reportPath = path.join(reportDir, "report.json");
const auditPath = path.join(reportDir, "append-audit.jsonl");
const report = {
  schemaVersion: "constraint-evidence-dossier-report/v1",
  mode: replayJson ? "replay-json" : "manual-fixture",
  abrainHome,
  keepTemp: KEEP,
  eventType: body.event_type,
  sourceChannel: body.source?.channel ?? "unknown",
  scopeHint: body.scope?.scope_hint?.kind ?? "unknown",
  ok: result.ok,
  status: result.status,
  eventId: result.eventId ?? null,
  filePath: result.filePath ?? null,
  diagnostics: result.diagnostics,
  rulesFileListChanged,
  projection,
  eventFiles,
};
writeJson(reportPath, report);
appendJsonLine(auditPath, report);

console.log("\n-- append result --");
console.log(`ok=${result.ok}`);
console.log(`status=${result.status}`);
console.log(`eventId=${result.eventId ?? "<none>"}`);
console.log(`filePath=${result.filePath ?? "<none>"}`);
console.log(`diagnostics=${diagnosticsSummary(result.diagnostics)}`);
console.log(`rulesFileListChanged=${rulesFileListChanged}`);
console.log(`projection=${JSON.stringify(projection)}`);
console.log(`eventFiles=${eventFiles.join(",") || "none"}`);
console.log(`reportPath=${reportPath}`);
console.log(`auditPath=${auditPath}`);

if (!KEEP) {
  fs.rmSync(abrainHome, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("tempCleaned=true");
} else {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("tempCleaned=false");
}

process.exit(result.ok ? 0 : 1);
