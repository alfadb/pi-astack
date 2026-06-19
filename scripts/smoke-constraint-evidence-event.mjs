#!/usr/bin/env node
/**
 * Smoke test: ADR 0039 P2 Constraint Evidence Event PR2.
 *
 * Offline only: pure functions + fixture events. No runtime hook, no append writer,
 * no real abrain writes, and no canonical memory mutation.
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

const failures = [];
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    fn();
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

const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-constraint-evidence-"));
for (const file of [
  "extensions/sediment/constraint-evidence/types.ts",
  "extensions/sediment/constraint-evidence/canonical-json.ts",
  "extensions/sediment/constraint-evidence/diagnostics.ts",
  "extensions/sediment/constraint-evidence/hash-envelope.ts",
  "extensions/sediment/constraint-evidence/read.ts",
  "extensions/sediment/constraint-evidence/status.ts",
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
  markStaleQueuedConstraintEvents,
  summarizeConstraintEventProjectionStatus,
} = require(path.join(outRoot, "sediment", "constraint-evidence", "status.js"));

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

check("PR2 module does not import mutation symbols or runtime hooks", () => {
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

fs.rmSync(outRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\nFAIL — ${failures.length}/${total} check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${total} constraint evidence event check(s) passed.`);
