#!/usr/bin/env node
/**
 * Smoke test: ADR 0039 P2/P3b Constraint Evidence Event PR2/PR3/PR4/Phase 1.5.
 *
 * Offline only: pure functions + fixture events. No runtime hook, no real abrain
 * writes, and no canonical memory mutation. PR3/PR4 checks use temporary trees.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
const pending = [];
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(result.then(
        () => console.log(`  ok    ${name}`),
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
        },
      ));
      return;
    }
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
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

const integrationSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/constraint-evidence/integration.ts"), "utf8");
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-constraint-evidence-"));
for (const file of [
  "extensions/sediment/constraint-evidence/types.ts",
  "extensions/sediment/constraint-evidence/canonical-json.ts",
  "extensions/sediment/constraint-evidence/diagnostics.ts",
  "extensions/sediment/constraint-evidence/hash-envelope.ts",
  "extensions/sediment/constraint-evidence/read.ts",
  "extensions/sediment/constraint-evidence/append.ts",
  "extensions/sediment/constraint-evidence/status.ts",
  "extensions/sediment/sanitizer.ts",
  "extensions/sediment/constraint-evidence/integration.ts",
  "extensions/sediment/constraint-evidence/audit-replay.ts",
]) {
  stageTs(outRoot, file);
}

const { canonicalJson, canonicalJsonValue } = require(path.join(outRoot, "sediment", "constraint-evidence", "canonical-json.js"));
const {
  CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "types.js"));
const {
  constraintEvidenceBodyHash,
  createConstraintEvidenceEnvelope,
  constraintEvidenceEnvelopeJson,
  constraintEvidenceEventPath,
  constraintEvidenceEventRelativePath,
  isSha256Hex,
  sha256Hex,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "hash-envelope.js"));
const {
  assertConstraintEvidenceDiagnosticConsumers,
  makeConstraintEvidenceDiagnostic,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "diagnostics.js"));
const {
  parseConstraintEvidenceEnvelopeJson,
  validateConstraintEvidenceEnvelope,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "read.js"));
const {
  appendConstraintEvidenceEvent,
  guardConstraintEvidencePath,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "append.js"));
const {
  markStaleQueuedConstraintEvents,
  summarizeConstraintEventProjectionStatus,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "status.js"));
const {
  appendTier1ConstraintEvidenceEvent,
  buildTier1ConstraintEvidenceEventBody,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "integration.js"));
const {
  buildConstraintEvidenceEventBodyFromAuditRow,
  constraintAuditReplayMappingRulesHash,
  CONSTRAINT_AUDIT_REPLAY_MAPPING_VERSION,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "audit-replay.js"));

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

function fixtureBody(overrides = {}) {
  return {
    event_schema_version: CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION,
    event_type: "constraint_signal_observed",
    created_at_utc: "2026-06-19T12:00:00.000Z",
    device_id: "device-test",
    device_event_seq: 1,
    actor: { role: "user", id: "user-test" },
    causal_parents: [],
    session_id: "session-test",
    turn_id: "turn-test",
    source: {
      channel: "manual",
      source_role: "user",
      source_ref: "turn:session-test/turn-test#user-1",
      quote_hash: sha256Hex("Use edit/write for file changes."),
    },
    intent: { domain_hint: "constraint", operation_hint: "create", confidence: 0.9 },
    payload: {
      sanitized_quote: "Use edit/write for file changes.",
      candidate_constraint_text: "Use edit/write for file changes.",
      candidate_title: "Use edit/write",
      candidate_trigger_phrases: ["edit/write"],
      candidate_applies_when: "file modification tasks",
      candidate_priority_hint: "always",
    },
    scope: {
      active_project_binding: { project_id: "pi-astack", binding_reason: "cwd" },
      scope_hint: { kind: "project", project_id: "pi-astack", evidence: "current project" },
      scope_confidence: 0.8,
    },
    sanitizer: {
      sanitizer_name: "fixture-sanitizer",
      sanitizer_version: "v1",
      status: "passed",
      replacements_count: 0,
    },
    neighbor_summary: {
      retrieval_mode: "readonly",
      input_hash: sha256Hex("neighbors"),
      neighbor_refs: [{ ref: "rule:global:always:edit-write", scope: "global", title: "edit/write" }],
      summary: "related edit/write rule",
    },
    producer: {
      name: "sediment.constraint-event-writer",
      version: "pr2-fixture",
      code_version: "test",
    },
    privacy: { contains_user_quote: true, redaction_level: "none" },
    ...overrides,
  };
}

console.log("constraint evidence event smoke");

check("canonical JSON sorts object keys recursively", () => {
  const left = canonicalJson(canonicalJsonValue({ b: 2, a: { d: true, c: [3, 2, 1] } }));
  const right = canonicalJson(canonicalJsonValue({ a: { c: [3, 2, 1], d: true }, b: 2 }));
  assert(left === right, `${left} !== ${right}`);
  assert(left === '{"a":{"c":[3,2,1],"d":true},"b":2}', left);
});

check("canonical JSON rejects unsupported values", () => {
  let caught = null;
  try {
    canonicalJsonValue({ bad: undefined });
  } catch (err) {
    caught = err;
  }
  assert(caught, "expected undefined rejection");
});

check("body hash is stable across key order", () => {
  const body = fixtureBody();
  const shuffled = { ...body, producer: { version: "pr2-fixture", name: "sediment.constraint-event-writer", code_version: "test" } };
  assert(constraintEvidenceBodyHash(body) === constraintEvidenceBodyHash(shuffled), "hash changed with key order");
});

check("body field change changes event id", () => {
  const first = createConstraintEvidenceEnvelope(fixtureBody());
  const second = createConstraintEvidenceEnvelope(fixtureBody({ device_event_seq: 2 }));
  assert(first.event_id !== second.event_id, "event id did not change");
});

check("envelope uses body hash as event id", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  assert(isSha256Hex(envelope.event_id), "event id is not sha256 hex");
  assert(envelope.event_id === envelope.body_hash, "event_id/body_hash mismatch");
  assert(envelope.body_hash === constraintEvidenceBodyHash(envelope.body), "body hash mismatch");
});

check("relative and absolute event paths derive from event id", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  const rel = constraintEvidenceEventRelativePath(envelope.event_id);
  assert(rel === `l1/events/sha256/${envelope.event_id.slice(0, 2)}/${envelope.event_id.slice(2, 4)}/${envelope.event_id}.json`, rel);
  assert(constraintEvidenceEventPath("/tmp/abrain", envelope.event_id).endsWith(rel), "absolute path does not end with relative path");
});

check("absolute path normalizes Windows backslashes to forward slashes", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  const rel = constraintEvidenceEventRelativePath(envelope.event_id);
  const result = constraintEvidenceEventPath("C:\\Users\\alfadb\\.abrain", envelope.event_id);
  assert(!result.includes("\\"), `path contains backslash: ${result}`);
  assert(result === `C:/Users/alfadb/.abrain/${rel}`, `unexpected path: ${result}`);
});

check("parse with Windows abrainHome and filePath does not false-positive CE_HASH_PATH_MISMATCH", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  const rel = constraintEvidenceEventRelativePath(envelope.event_id);
  const abrainHome = "C:\\Users\\alfadb\\.abrain";
  const filePath = "C:\\Users\\alfadb\\.abrain\\" + rel.replace(/\//g, "\\");
  const result = parseConstraintEvidenceEnvelopeJson(constraintEvidenceEnvelopeJson(envelope), {
    abrainHome,
    filePath,
    relativePath: rel,
  });
  assert(result.ok, result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  assert(!result.diagnostics.some((diagnostic) => diagnostic.code === "CE_HASH_PATH_MISMATCH"), "false-positive CE_HASH_PATH_MISMATCH on Windows path");
});

check("valid envelope parses with expected path", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  const result = parseConstraintEvidenceEnvelopeJson(constraintEvidenceEnvelopeJson(envelope), {
    relativePath: constraintEvidenceEventRelativePath(envelope.event_id),
  });
  assert(result.ok, result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  assert(result.value.event_id === envelope.event_id, "event id changed");
});

check("envelope metadata changes do not change body hash but reader detects mismatch", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  const changed = { ...envelope, canonicalization: "other" };
  assert(changed.body_hash === envelope.body_hash, "body hash should be unchanged");
  const result = validateConstraintEvidenceEnvelope(changed);
  assert(!result.ok, "expected validation failure");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_HASH_ENVELOPE_MISMATCH"), "missing envelope mismatch diagnostic");
});

check("body hash mismatch is rejected", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  const result = validateConstraintEvidenceEnvelope({ ...envelope, body_hash: sha256Hex("wrong") });
  assert(!result.ok, "expected mismatch rejection");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_HASH_ENVELOPE_MISMATCH"), "missing hash diagnostic");
});

check("path hash mismatch is rejected", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody());
  const result = validateConstraintEvidenceEnvelope(envelope, { relativePath: "l1/events/sha256/00/00/00.json" });
  assert(!result.ok, "expected path mismatch rejection");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_HASH_PATH_MISMATCH"), "missing path diagnostic");
});

check("unsupported event schema is rejected", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody({ event_schema_version: "constraint-evidence-event/v0" }));
  const result = validateConstraintEvidenceEnvelope(envelope);
  assert(!result.ok, "expected schema rejection");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_SCHEMA_UNSUPPORTED"), "missing schema diagnostic");
});

check("sanitizer blocked is diagnostic-only for PR2 reader", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody({
    sanitizer: {
      sanitizer_name: "fixture-sanitizer",
      sanitizer_version: "v1",
      status: "blocked",
      replacements_count: 0,
      blocked_reason: "secret-like payload",
    },
  }));
  const result = validateConstraintEvidenceEnvelope(envelope);
  assert(result.ok, "blocked reader result should remain structurally valid");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_SANITIZER_BLOCKED"), "missing sanitizer diagnostic");
});

check("not-memory settings event emits not-memory diagnostic", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody({
    event_type: "constraint_not_memory_observed",
    intent: { domain_hint: "constraint", operation_hint: "not_memory", confidence: 0.95 },
    payload: {
      sanitized_quote: "Set provider budget flag in settings.",
      not_memory_hint: "settings",
    },
  }));
  const result = validateConstraintEvidenceEnvelope(envelope);
  assert(result.ok, "settings not-memory should be structurally valid");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_NOT_MEMORY_SETTINGS"), "missing settings diagnostic");
});

check("not-memory tool contract event emits tool diagnostic", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody({
    event_type: "constraint_not_memory_observed",
    intent: { domain_hint: "constraint", operation_hint: "not_memory" },
    payload: {
      sanitized_quote: "dispatch_parallel worker limit is part of tool contract.",
      not_memory_hint: "tool_contract",
    },
  }));
  const result = validateConstraintEvidenceEnvelope(envelope);
  assert(result.ok, "tool not-memory should be structurally valid");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_NOT_MEMORY_TOOL_CONTRACT"), "missing tool diagnostic");
});

check("unknown scope emits scope diagnostic without global promotion", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody({
    scope: {
      active_project_binding: { binding_reason: "no active project" },
      scope_hint: { kind: "unknown", reason: "no explicit scope evidence" },
    },
  }));
  const result = validateConstraintEvidenceEnvelope(envelope);
  assert(result.ok, "unknown scope should be structurally valid");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_SCOPE_AMBIGUOUS"), "missing scope diagnostic");
});

check("unclassified event emits diagnostic", () => {
  const envelope = createConstraintEvidenceEnvelope(fixtureBody({
    event_type: "constraint_unclassified_observed",
    intent: { domain_hint: "constraint", operation_hint: "unclassified" },
    payload: {
      sanitized_quote: "unclear signal",
      unclassified_reason: "ambiguous wording",
    },
  }));
  const result = validateConstraintEvidenceEnvelope(envelope);
  assert(result.ok, "unclassified should be structurally valid");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_UNCLASSIFIED"), "missing unclassified diagnostic");
});

check("all diagnostics have consumers", () => {
  const diagnostics = [
    makeConstraintEvidenceDiagnostic({ code: "CE_APPEND_OK", message: "append ok" }),
    makeConstraintEvidenceDiagnostic({ code: "CE_EVENT_NOT_MEMORY_LEAK", message: "not-memory leak", eventIds: [sha256Hex("event")] }),
    makeConstraintEvidenceDiagnostic({ code: "CE_EVENT_SCOPE_CONSERVATISM_BREACH", message: "scope breach" }),
  ];
  assertConstraintEvidenceDiagnosticConsumers(diagnostics);
});

check("projection status summary counts queued and stale records", () => {
  const nowMs = Date.parse("2026-06-19T12:10:00.000Z");
  const records = [
    { eventId: "a", status: "queued", observedAtUtc: "2026-06-19T12:00:00.000Z" },
    { eventId: "b", status: "projected", observedAtUtc: "2026-06-19T12:00:00.000Z", projectedAtUtc: "2026-06-19T12:01:00.000Z" },
    { eventId: "c", status: "invalid" },
    { eventId: "d", status: "append_failed" },
  ];
  const summary = summarizeConstraintEventProjectionStatus(records, { nowMs });
  assert(summary.total === 4, "bad total");
  assert(summary.queued === 1 && summary.projected === 1 && summary.invalid === 1 && summary.appendFailed === 1, "bad counts");
  assert(summary.oldestQueuedAgeMs === 600000, `bad age ${summary.oldestQueuedAgeMs}`);
  const marked = markStaleQueuedConstraintEvents(records, { nowMs, staleAfterMs: 300000 });
  assert(marked[0].status === "stale", "queued event not marked stale");
});

check("append writer writes event under content-addressed L1 path", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-abrain-"));
  const body = fixtureBody({ device_event_seq: 101 });
  const result = await appendConstraintEvidenceEvent({ abrainHome, body });
  assert(result.ok && result.status === "appended", `append failed: ${result.diagnostics.map((diagnostic) => diagnostic.code).join(",")}`);
  assert(fs.existsSync(result.filePath), "event file missing");
  assert(result.filePath.endsWith(constraintEvidenceEventRelativePath(result.eventId)), "wrong event path");
  const text = fs.readFileSync(result.filePath, "utf8");
  assert(text.endsWith("\n"), "event file lacks final newline");
  const parsed = parseConstraintEvidenceEnvelopeJson(text, {
    abrainHome,
    filePath: result.filePath,
    relativePath: constraintEvidenceEventRelativePath(result.eventId),
  });
  assert(parsed.ok, parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  const temps = listFiles(abrainHome).filter((file) => file.endsWith(".tmp"));
  assert(temps.length === 0, `temp files left behind: ${temps.join(",")}`);
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("append writer returns idempotent duplicate for identical event", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-abrain-"));
  const body = fixtureBody({ device_event_seq: 102 });
  const first = await appendConstraintEvidenceEvent({ abrainHome, body });
  const second = await appendConstraintEvidenceEvent({ abrainHome, body });
  assert(first.ok && first.status === "appended", "first append did not write");
  assert(second.ok && second.status === "idempotent_duplicate", "second append was not idempotent");
  assert(second.diagnostics.some((diagnostic) => diagnostic.code === "CE_APPEND_IDEMPOTENT_DUPLICATE"), "missing duplicate diagnostic");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("append writer rejects existing path with different content", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-abrain-"));
  const body = fixtureBody({ device_event_seq: 103 });
  const first = await appendConstraintEvidenceEvent({ abrainHome, body });
  assert(first.ok, "first append failed");
  fs.writeFileSync(first.filePath, `${JSON.stringify({ collision: true })}\n`, "utf8");
  const second = await appendConstraintEvidenceEvent({ abrainHome, body });
  assert(!second.ok && second.status === "collision", "collision was not rejected");
  assert(second.diagnostics.some((diagnostic) => diagnostic.code === "CE_HASH_PATH_COLLISION"), "missing collision diagnostic");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("append writer blocks sanitizer-blocked event before writing L1", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-abrain-"));
  const body = fixtureBody({
    device_event_seq: 104,
    sanitizer: {
      sanitizer_name: "fixture-sanitizer",
      sanitizer_version: "v1",
      status: "blocked",
      replacements_count: 0,
      blocked_reason: "secret-like payload",
    },
  });
  const result = await appendConstraintEvidenceEvent({ abrainHome, body });
  assert(!result.ok && result.status === "blocked", "blocked event was written");
  assert(result.filePath && !fs.existsSync(result.filePath), "blocked event file exists");
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "CE_SANITIZER_BLOCKED"), "missing blocked diagnostic");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("path guard rejects canonical memory targets", () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-abrain-"));
  const rejected = guardConstraintEvidencePath({
    abrainHome,
    targetPath: path.join(abrainHome, "rules", "always", "bad.md"),
  });
  assert(!rejected.ok, "canonical rules target was allowed");
  const allowed = guardConstraintEvidencePath({
    abrainHome,
    targetPath: path.join(abrainHome, "l1", "events", "aa", "bb", "event.json"),
  });
  assert(allowed.ok, "event target was rejected");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("append writer leaves canonical rules tree unchanged", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-abrain-"));
  const rulesDir = path.join(abrainHome, "rules");
  writeFile(path.join(rulesDir, "always", "existing.md"), "---\nstatus: active\n---\n\n# Existing\n");
  const before = treeHash(rulesDir);
  const result = await appendConstraintEvidenceEvent({ abrainHome, body: fixtureBody({ device_event_seq: 105 }) });
  assert(result.ok, "append failed");
  const after = treeHash(rulesDir);
  assert(before === after, "canonical rules tree changed");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("runtime integration body is deterministic for repeated agent_end signal", () => {
  const base = {
    signal: {
      user_quote: "本项目内，Constraint Evidence Event writer 必须默认关闭。",
      correction_intent: "new preference",
      scope_description: "current project only",
      confidence: 9,
      provenance: "user-expressed",
    },
    draft: {
      title: "Constraint Evidence default off",
      body: "本项目内，Constraint Evidence Event writer 必须默认关闭。",
      entryConfidence: 9,
    },
    sessionId: "runtime-session",
    turnId: "runtime-turn",
    projectId: "pi-global",
    cwd: repoRoot,
    createdAtUtc: "2026-06-19T12:00:00.000Z",
    correlationId: "runtime-session:auto-first",
    candidateId: "tier1-direct:c0",
    deviceId: "runtime-device",
  };
  const first = buildTier1ConstraintEvidenceEventBody(base);
  const second = buildTier1ConstraintEvidenceEventBody({ ...base, correlationId: "runtime-session:auto-second" });
  assert(constraintEvidenceBodyHash(first) === constraintEvidenceBodyHash(second), "correlation id changed event identity");
  assert(first.source.channel === "agent_end", "runtime event channel mismatch");
  assert(first.scope.scope_hint.kind === "project", "project signal must remain project-scoped at append time");
  assert(first.legacy_parallel_write.legacy_path_kind === "tier1_ruleset_adjudicator", "legacy path hint missing");
});

check("runtime integration propagates sanitizer blocked status", () => {
  assert(integrationSrc.includes("result.ok === false"), "integration must inspect sanitizer ok:false");
  assert(integrationSrc.includes('status: blocked ? "blocked"'), "integration must emit blocked sanitizer status");
  assert(integrationSrc.includes("blocked_reason"), "integration must emit blocked_reason");
});

check("runtime integration records sanitizer redaction metadata", () => {
  const rawToken = "sk-" + "A".repeat(32);
  const rawAws = "AKIA" + "IOSFODNN7EXAMPLE";
  const body = buildTier1ConstraintEvidenceEventBody({
    signal: {
      user_quote: `所有项目中，禁止记录 ${rawToken}`,
      correction_intent: "new preference",
      scope_description: `all projects for owner@example.com via ${rawAws}`,
      confidence: 9,
      provenance: "user-expressed",
    },
    draft: {
      title: `Do not persist ${rawToken}`,
      body: `Do not persist ${rawToken} or ${rawAws}`,
      entryConfidence: 9,
      triggerPhrases: [`token ${rawToken}`],
    },
    sessionId: "runtime-session",
    turnId: "runtime-turn",
    projectId: "pi-global",
    cwd: repoRoot,
    createdAtUtc: "2026-06-19T12:00:00.000Z",
    correlationId: "runtime-session:auto-sanitize",
    candidateId: "tier1-direct:sanitize",
    deviceId: "runtime-device",
  });
  const persisted = JSON.stringify(body.payload);
  assert(!persisted.includes(rawToken), "payload leaked raw API token");
  assert(!persisted.includes(rawAws), "payload leaked raw AWS key");
  assert(!persisted.includes("owner@example.com"), "payload leaked raw email");
  assert(body.payload.sanitized_quote.includes("[SECRET:openai_api_key]"), "quote did not keep typed token placeholder");
  assert(body.payload.candidate_constraint_text.includes("[SECRET:aws_access_key]"), "body did not keep typed AWS placeholder");
  assert(body.sanitizer.status === "redacted", "sanitizer status must reflect redaction");
  assert(body.sanitizer.replacements_count === 7, `unexpected replacement count: ${body.sanitizer.replacements_count}`);
  assert(body.privacy.redaction_level === "partial", "privacy redaction level must reflect sanitizer metadata");
});

check("runtime integration scope: project wording beats incidental global-config mention", () => {
  const body = buildTier1ConstraintEvidenceEventBody({
    signal: {
      user_quote: "pi-astack直接推main，不要开PR，它是我的自有仓库，pi-astack是属于我个人的~/.pi全局配置的pi-global仓库的子模块，推送pi-astack后要把pi-global的子模块指针一起提交推送",
      correction_intent: "new preference",
      scope_description: "项目级规则，适用于 pi-astack（作为 pi-global 子模块）",
      confidence: 9,
      provenance: "user-expressed",
    },
    draft: {
      title: "项目级规则，适用于 pi-astack：直接推 main，不创建 PR",
      body: "pi-astack直接推main，不要开PR，它是我的自有仓库，pi-astack是属于我个人的~/.pi全局配置的pi-global仓库的子模块，推送pi-astack后要把pi-global的子模块指针一起提交推送",
      entryConfidence: 9,
    },
    sessionId: "runtime-session",
    turnId: "runtime-turn",
    projectId: "pi-global",
    cwd: repoRoot,
    createdAtUtc: "2026-06-24T12:39:20.511Z",
    correlationId: "runtime-session:auto-scope",
    candidateId: "tier1-direct:scope",
    deviceId: "runtime-device",
  });
  assert(body.scope.scope_hint.kind === "project", "incidental 全局配置 mention must not force global scope");
  assert(body.scope.scope_hint.project_id === "pi-global", "project scope must preserve active binding");
});

check("runtime integration scope: explicit all-project wording stays global", () => {
  const body = buildTier1ConstraintEvidenceEventBody({
    signal: {
      user_quote: "所有项目中，显式 runtime 开关必须保留在 JSON 配置里。",
      correction_intent: "new preference",
      scope_description: "all projects",
      confidence: 9,
      provenance: "user-expressed",
    },
    draft: {
      title: "Runtime switch explicit JSON",
      body: "所有项目中，显式 runtime 开关必须保留在 JSON 配置里。",
      entryConfidence: 9,
    },
    sessionId: "runtime-session",
    turnId: "runtime-turn",
    projectId: "pi-global",
    cwd: repoRoot,
    createdAtUtc: "2026-06-19T12:00:00.000Z",
    correlationId: "runtime-session:auto-global-scope",
    candidateId: "tier1-direct:global-scope",
    deviceId: "runtime-device",
  });
  assert(body.scope.scope_hint.kind === "global", "explicit all-project wording must remain global-scoped");
});

check("runtime integration appends L1 event and state audit idempotently", async () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-runtime-"));
  const options = {
    abrainHome,
    signal: {
      user_quote: "所有项目中，显式 runtime 开关必须保留在 JSON 配置里。",
      correction_intent: "new preference",
      scope_description: "all projects",
      confidence: 9,
      provenance: "user-expressed",
    },
    draft: {
      title: "Runtime switch explicit JSON",
      body: "所有项目中，显式 runtime 开关必须保留在 JSON 配置里。",
      entryConfidence: 9,
    },
    sessionId: "runtime-session",
    turnId: "runtime-turn",
    projectId: "pi-global",
    cwd: repoRoot,
    createdAtUtc: "2026-06-19T12:00:00.000Z",
    correlationId: "runtime-session:auto-random-a",
    candidateId: "tier1-direct:c0",
    deviceId: "runtime-device",
  };
  const first = await appendTier1ConstraintEvidenceEvent(options);
  const second = await appendTier1ConstraintEvidenceEvent({ ...options, correlationId: "runtime-session:auto-random-b" });
  assert(first.append.ok && first.append.status === "appended", `first append failed: ${JSON.stringify(first.append.diagnostics)}`);
  assert(second.append.ok && second.append.status === "idempotent_duplicate", `second append not idempotent: ${JSON.stringify(second.append)}`);
  assert(first.append.eventId === second.append.eventId, "event id changed across repeated signal");
  assert(listFiles(path.join(abrainHome, "l1", "events")).length === 1, "runtime append wrote duplicate L1 files");
  assert(fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-events", "runtime", "append-audit.jsonl")), "runtime audit missing");
  assert(fs.existsSync(path.join(abrainHome, ".state", "sediment", "constraint-events", "runtime", "projection-status.jsonl")), "runtime status missing");
  assert(!fs.existsSync(path.join(abrainHome, "rules")), "runtime append created canonical rules tree");
  const statusLines = fs.readFileSync(path.join(abrainHome, ".state", "sediment", "constraint-events", "runtime", "projection-status.jsonl"), "utf8").trim().split("\n");
  assert(statusLines.length === 2, "runtime status should record both attempts");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("manual dossier is registered as dossier script, not smoke", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert(pkg.scripts["dossier:constraint-evidence-event"] === "node scripts/dossier-constraint-evidence-event.mjs", "missing dossier registration");
  assert(pkg.scripts["dossier:constraint-audit-replay"] === "node scripts/dossier-constraint-audit-replay.mjs", "missing audit replay dossier registration");
  assert(!Object.entries(pkg.scripts).some(([name, command]) => name.startsWith("smoke:") && String(command).includes("dossier-constraint-evidence-event")), "dossier registered under smoke");
  assert(!Object.entries(pkg.scripts).some(([name, command]) => name.startsWith("smoke:") && String(command).includes("dossier-constraint-audit-replay")), "audit replay dossier registered under smoke");
});

check("audit replay mapper emits explicit historical provenance", () => {
  const auditJsonlSha256 = sha256Hex("fixture audit jsonl");
  const mappingTableSha256 = constraintAuditReplayMappingRulesHash();
  const mapped = buildConstraintEvidenceEventBodyFromAuditRow({
    row: {
      rowIndex: 7,
      timestamp: "2026-06-19T12:00:00.000Z",
      lane: "rules",
      operation: "create",
      scope: "global",
      inject_mode: "always",
      slug: "use-edit-write",
      sessionId: "session-a",
      turnId: "turn-a",
      correlationId: "correlation-a",
    },
    auditJsonlPath: "/tmp/audit.jsonl",
    auditJsonlSha256,
    replayRunId: "replay-smoke",
    replayHarnessVersion: "smoke-harness/v1",
    mappingTableSha256,
    activeProjectId: "pi-global",
    deviceId: "smoke-device",
    sourceText: "Use edit/write for file changes.",
  });
  assert(mapped.ok, "replay mapper rejected supported row");
  assert(mapped.body.source.channel === "replay", "replay source channel missing");
  assert(mapped.body.replay_provenance.source === "historical_audit_backfill", "historical provenance missing");
  assert(mapped.body.replay_provenance.mapping_table_version === CONSTRAINT_AUDIT_REPLAY_MAPPING_VERSION, "mapping version missing");
  assert(mapped.body.replay_provenance.mapping_table_sha256 === mappingTableSha256, "mapping hash missing");
  assert(mapped.body.replay_provenance.audit_row_index === 7, "audit row index missing");
  assert(mapped.body.legacy_parallel_write.attempted === true, "legacy create marker missing");
  const envelope = createConstraintEvidenceEnvelope(mapped.body);
  const parsed = validateConstraintEvidenceEnvelope(envelope);
  assert(parsed.ok, parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
});

check("manual dossier default uses temporary abrain and cleans it", () => {
  const output = execFileSync("node", ["scripts/dossier-constraint-evidence-event.mjs", "--now", "2026-06-19T12:00:00.000Z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert(output.includes("mode: manual-fixture"), "missing manual mode output");
  assert(output.includes("ok=true"), "dossier did not append event");
  assert(output.includes("rulesFileListChanged=false"), "rules changed");
  assert(output.includes("reportPath=/tmp/constraint-evidence-dossier-"), "report path is not temporary");
  assert(output.includes("tempCleaned=true"), "temporary abrain was not cleaned");
});

check("manual dossier --keep writes report and audit under temporary state", () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-dossier-smoke-"));
  const output = execFileSync("node", [
    "scripts/dossier-constraint-evidence-event.mjs",
    "--abrain", abrainHome,
    "--keep",
    "--now", "2026-06-19T12:00:00.000Z",
    "--session", "smoke-session",
    "--turn", "smoke-turn",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert(output.includes("tempCleaned=false"), "kept temp tree was cleaned");
  const reportPath = path.join(abrainHome, ".state", "sediment", "constraint-events", "manual-dossier", "report.json");
  const auditPath = path.join(abrainHome, ".state", "sediment", "constraint-events", "manual-dossier", "append-audit.jsonl");
  assert(fs.existsSync(reportPath), "report missing");
  assert(fs.existsSync(auditPath), "audit missing");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert(report.schemaVersion === "constraint-evidence-dossier-report/v1", "bad report schema");
  assert(report.ok === true && report.status === "appended", "bad report result");
  assert(report.rulesFileListChanged === false, "rules changed");
  assert(report.projection.queued === 1, "queued projection missing");
  assert(report.eventFiles.length === 1, "event file list missing");
  assert(fs.readFileSync(auditPath, "utf8").trim().split("\n").length === 1, "audit line count mismatch");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("manual dossier replay-json appends replayed event body", () => {
  const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-evidence-dossier-smoke-"));
  const replayFile = path.join(abrainHome, "replay-body.json");
  writeFile(replayFile, `${JSON.stringify(fixtureBody({ device_event_seq: 501, event_type: "constraint_not_memory_observed", intent: { domain_hint: "constraint", operation_hint: "not_memory" }, payload: { sanitized_quote: "settings signal", not_memory_hint: "settings" } }), null, 2)}\n`);
  const output = execFileSync("node", [
    "scripts/dossier-constraint-evidence-event.mjs",
    "--abrain", abrainHome,
    "--keep",
    "--replay-json", replayFile,
    "--now", "2026-06-19T12:00:00.000Z",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert(output.includes("mode: replay-json"), "missing replay mode output");
  assert(output.includes("eventType: constraint_not_memory_observed"), "wrong event type output");
  assert(output.includes("diagnostics=CE_NOT_MEMORY_SETTINGS:1, CE_APPEND_OK:1") || output.includes("diagnostics=CE_APPEND_OK:1"), "unexpected diagnostics output");
  const report = JSON.parse(fs.readFileSync(path.join(abrainHome, ".state", "sediment", "constraint-events", "manual-dossier", "report.json"), "utf8"));
  assert(report.mode === "replay-json", "report mode mismatch");
  assert(report.eventType === "constraint_not_memory_observed", "report event type mismatch");
  fs.rmSync(abrainHome, { recursive: true, force: true });
});

check("manual dossier rejects non-temporary abrain paths", () => {
  const result = spawnSync("node", ["scripts/dossier-constraint-evidence-event.mjs", "--abrain", repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert(result.status !== 0, "non-temporary abrain path was accepted");
  assert(`${result.stderr}${result.stdout}`.includes("must point inside"), "missing refusal reason");
});

check("runtime evidence writer setting is default-off in schema and explicit config", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
  const schemaFlag = schema.properties.sediment.properties.constraintEvidenceEventWriter.properties.enabled;
  assert(schemaFlag.default === false, "schema default must be false");
  const settingsPath = path.resolve(repoRoot, "..", "..", "pi-astack-settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert(Object.hasOwn(settings.sediment.constraintEvidenceEventWriter, "enabled"), "runtime config must keep explicit rollback switch");
  assert(typeof settings.sediment.constraintEvidenceEventWriter.enabled === "boolean", "runtime config switch must be boolean");
});

check("PR2/PR3/PR4/PR5 module does not import mutation symbols or runtime hooks", () => {
  const dir = path.join(repoRoot, "extensions", "sediment", "constraint-evidence");
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".ts"));
  const combined = files.map((file) => fs.readFileSync(path.join(dir, file), "utf8")).join("\n");
  for (const forbidden of [
    "writeAbrainRule",
    "applyTier1RuleAdjudication",
    "archiveAbrainRule",
    "deleteAbrainRule",
    "mutateRuleStatusContested",
    "resolveRuleWrite",
    "runTier1JaccardAdjudication",
    "curateProjectDraft",
    "executeCuratorDecisionToBrain",
    "writeProjectEntry",
    "updateProjectEntry",
    "pi.on(\"agent_end\")",
    "pi.on(\"session_start\")",
    "pi.on(\"before_agent_start\")",
  ]) {
    assert(!combined.includes(forbidden), `forbidden symbol present: ${forbidden}`);
  }
});

await Promise.all(pending);
fs.rmSync(outRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\nFAIL — ${failures.length}/${total} check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${total} constraint evidence event check(s) passed.`);
