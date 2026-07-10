#!/usr/bin/env node
/**
 * ADR0039 Constraint L2 repo-mode enable PREFLIGHT (4×T0 v3 consensus,
 * 2026-06-20). The repo-mode flip is user-gated (settings read at boot → needs
 * pi restart), so the main session can never execute+verify it directly. This
 * preflight proves the whole repo-mode pipeline GREEN against a SNAPSHOT of the
 * user's REAL ~/.abrain cached decision, with NO LLM call, BEFORE the user flips.
 *
 * Implementation note (within v3 intent): instead of replaying the cached
 * decision through the full runner as a compilerInvoker (which would re-scan
 * rules + re-normalize + re-validate, fragile against a minimal snapshot), we
 * DIRECTLY fixate the real validated decision.json — the verbatim production
 * artifact the runner itself passes to fixateConstraintDecisionAndRenderL2. Same
 * goal (real-data, no-LLM, prove 固化→render→reconcile→idempotent→inert), more
 * robust. If no real ~/.abrain decision exists, the preflight SKIPS (exit 0).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(() => console.log(`  ok    ${name}`), (err) => { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`); }));
      return;
    }
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message || "assertion failed"); }
function writeFile(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, "utf8"); }
function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.NodeJs, esModuleInterop: true, skipLibCheck: true },
  }).outputText;
}
function stageTs(outRoot, src, dst = src.replace(/^extensions\//, "").replace(/\.ts$/, ".js")) {
  writeFile(path.join(outRoot, dst), transpile(path.join(repoRoot, src)));
}

const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-l2-preflight-"));
for (const file of [
  "extensions/_shared/runtime.ts", "extensions/_shared/durable-write.ts", "extensions/_shared/jcs.ts", "extensions/_shared/l1-schema-registry.ts",
  "extensions/memory/settings.ts", "extensions/memory/utils.ts", "extensions/memory/direction-impact.ts", "extensions/memory/parser.ts",
  "extensions/sediment/settings.ts", "extensions/sediment/knowledge-evidence.ts", "extensions/sediment/sanitizer.ts",
  "extensions/sediment/constraint-compiler/types.ts",
  "extensions/sediment/constraint-evidence/types.ts", "extensions/sediment/constraint-evidence/canonical-json.ts",
  "extensions/sediment/constraint-evidence/hash-envelope.ts", "extensions/sediment/constraint-evidence/diagnostics.ts",
  "extensions/sediment/constraint-evidence/read.ts", "extensions/sediment/constraint-evidence/status.ts",
  "extensions/sediment/constraint-compiler/diagnostics.ts", "extensions/sediment/constraint-compiler/normalize.ts",
  "extensions/sediment/constraint-compiler/legacy-scan.ts", "extensions/sediment/constraint-compiler/event-scan.ts",
  "extensions/sediment/constraint-compiler/validate-decision.ts", "extensions/sediment/constraint-compiler/render.ts",
  "extensions/sediment/constraint-evidence/append.ts", "extensions/sediment/constraint-compiler/projection.ts",
]) {
  stageTs(outRoot, file);
}
fs.mkdirSync(path.join(outRoot, "schemas"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(outRoot, "schemas", "l1-schema-role-registry.json"));
const R = (m, f) => require(path.join(outRoot, "sediment", m, `${f}.js`));
const { fixateConstraintDecisionAndRenderL2, selectLatestConstraintProjectionEventId, CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION } = R("constraint-compiler", "projection");
const { renderConstraintL2View } = R("constraint-compiler", "render");
const { scanConstraintEvidenceEvents } = R("constraint-compiler", "event-scan");
const { validateConstraintCompilerDecision } = R("constraint-compiler", "validate-decision");
const { constraintEvidenceEventPath, sha256Hex } = R("constraint-evidence", "hash-envelope");

console.log("ADR0039 Constraint L2 repo-mode PREFLIGHT (v3 — snapshot/replay, no LLM)");

const ABRAIN = path.join(os.homedir(), ".abrain");
const LATEST = path.join(ABRAIN, ".state", "sediment", "constraint-shadow", "latest");
const decisionPath = path.join(LATEST, "decision.json");
const normPath = path.join(LATEST, "input.normalized.json");
const STALE_AFTER_MS = 86400000;

if (!fs.existsSync(decisionPath) || !fs.existsSync(normPath)) {
  console.log("  skip  no real ~/.abrain cached decision present (constraint-shadow/latest absent)");
  console.log("\npreflight SKIPPED (no real data).");
  process.exit(0);
}

const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
const norm = JSON.parse(fs.readFileSync(normPath, "utf8"));
const knownProjectIds = fs.existsSync(path.join(ABRAIN, "projects"))
  ? fs.readdirSync(path.join(ABRAIN, "projects")).filter((p) => { try { return fs.statSync(path.join(ABRAIN, "projects", p)).isDirectory(); } catch { return false; } })
  : [];

// Walk a temp home's l1/events for constraint-projection events → {eventId, createdAtUtc}.
function scanProjectionEvents(home) {
  const out = [];
  const root = path.join(home, "l1", "events", "sha256");
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".json")) {
        try { const env = JSON.parse(fs.readFileSync(full, "utf8")); if (env.schema === CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION && env.event_id) { const decision = env.body && env.body.validated_decision; out.push({ eventId: env.event_id, createdAtUtc: (env.body && env.body.created_at_utc) || "", decision, decisionHash: decision ? renderConstraintL2View(decision, env.event_id).decisionHash : null }); } } catch { /* skip */ }
      }
    }
  };
  walk(root);
  return out;
}
// Self-contained reconcile mirroring validateConstraintL2, using the EXPORTED
// stale-L2 comparator (single source of truth).
function reconcile(home) {
  const l2Path = path.join(home, "l2", "views", "constraint", "latest", "compiled-view.md");
  if (!fs.existsSync(l2Path)) return { present: false, failures: [] };
  const raw = fs.readFileSync(l2Path, "utf8");
  const m = raw.match(/^decision_hash:\s*(.+)$/m);
  const decisionHash = m ? m[1].trim() : "";
  const failures = [];
  if (!decisionHash) return { present: true, failures: ["missing_decision_hash"] };
  const events = scanProjectionEvents(home);
  const match = events.find((e) => e.decisionHash === decisionHash);
  if (!match) return { present: true, failures: [`no_projection_event_for_decision:${decisionHash.slice(0, 16)}`] };
  if (renderConstraintL2View(match.decision, match.eventId).markdown !== raw) failures.push(`byte_mismatch:${decisionHash.slice(0, 16)}`);
  // Staleness by decision_hash: the latest projection event's decision must equal
  // the L2's. A newer event with the SAME decision (another device) is NOT stale.
  const latestId = selectLatestConstraintProjectionEventId(events);
  const latest = events.find((e) => e.eventId === latestId);
  if (latest && latest.decisionHash !== decisionHash) failures.push(`stale_l2_newer_projection_exists:${decisionHash.slice(0, 16)}:${(latest.decisionHash || "?").slice(0, 16)}`);
  return { present: true, failures };
}
function git(home, args) { execFileSync("git", ["-C", home, ...args], { stdio: ["ignore", "pipe", "pipe"] }); }
function snapshot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-snap-"));
  const gi = path.join(ABRAIN, ".gitignore");
  if (fs.existsSync(gi)) fs.copyFileSync(gi, path.join(home, ".gitignore"));
  fs.mkdirSync(path.join(home, "l1", "events", "sha256"), { recursive: true });
  fs.mkdirSync(path.join(home, "l2", "views", "constraint"), { recursive: true });
  // NS-2 realism: seed sibling VALID registered foreign envelopes. Canonical
  // path R3.4.2 P1-S3: unknown or hash-mismatched events now fail the central
  // registry scan closed (covered by smoke:canonical-path-foundation and
  // smoke:constraint-shadow-compiler), so the shared-store realism fixture
  // must itself be envelope/hash/producer valid.
  const { canonicalJson: seedCanonicalJson, canonicalJsonValue: seedCanonicalJsonValue } = R("constraint-evidence", "canonical-json");
  const seed = (schema, body) => {
    const hex = sha256Hex(seedCanonicalJson(seedCanonicalJsonValue(body)));
    writeFile(path.join(home, "l1", "events", "sha256", hex.slice(0, 2), hex.slice(2, 4), `${hex}.json`), `${JSON.stringify({ schema, canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: hex, body_hash: hex, body }, null, 2)}\n`);
  };
  const seedKnowledgeBody = (marker) => ({
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-06-19T00:00:00.000Z",
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    producer: { name: "sediment.knowledge-event-writer", version: "preflight" },
    scope: { kind: "world" },
    payload: { slug: `preflight-seed-${marker}` },
  });
  seed("knowledge-evidence-envelope/v1", seedKnowledgeBody("one"));
  seed("knowledge-evidence-envelope/v1", seedKnowledgeBody("two"));
  git(home, ["init", "-q"]);
  git(home, ["config", "user.email", "preflight@local"]);
  git(home, ["config", "user.name", "preflight"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "baseline"]);
  return home;
}
const provenance = { model: "preflight", prompt_hash: "", input_hash: decision.inputRootHash, raw_output_hash: "", acceptance: "accepted_for_event_append" };
const fixateOpts = (home, createdAtUtc) => ({ abrainHome: home, decision, provenance, inputEventIds: [], createdAtUtc, deviceId: "preflight-device", producerVersion: "preflight" });

check("hard-fail gate: cached decision matches input + validates (deriveConstraintIds:false); stale → warn", () => {
  assert(decision.inputRootHash === norm.inputRootHash, `decision.inputRootHash != normalized inputRootHash (${decision.inputRootHash} vs ${norm.inputRootHash})`);
  // Idempotent re-validation of the already-validated cached decision.
  validateConstraintCompilerDecision(norm.records, decision, { knownProjectIds, expectedInputRootHash: norm.inputRootHash, deriveConstraintIds: false });
  const ageMs = Date.now() - fs.statSync(decisionPath).mtimeMs;
  if (ageMs > STALE_AFTER_MS) console.log(`        WARN: cached decision is ${(ageMs / 3600000).toFixed(1)}h old (> ${(STALE_AFTER_MS / 3600000)}h); re-run the shadow compiler before production enablement.`);
});

check("repo-mode pipeline GREEN on real decision: RUN-A written + ROUND-TRIP + RUN-B idempotent + RUN-C reconcile + RUN-D inert + NS-2 + git-delta bounded", async () => {
  const home = snapshot();
  try {
    // RUN-A: 固化 + render
    const a = await fixateConstraintDecisionAndRenderL2(fixateOpts(home, "2026-06-19T00:00:00.000Z"));
    assert(a.ok && a.status === "written", `RUN-A expected written, got ${a.status}`);
    const eventId = a.eventId;
    assert(scanProjectionEvents(home).length === 1, "RUN-A: expected exactly 1 projection event (L1 count +1)");
    const l1Path = constraintEvidenceEventPath(home, eventId);
    assert(fs.existsSync(l1Path), "RUN-A: 固化 L1 projection event missing");
    const env = JSON.parse(fs.readFileSync(l1Path, "utf8"));
    assert(env.schema === CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION, "RUN-A: wrong envelope schema");
    const l2Path = path.join(home, "l2", "views", "constraint", "latest", "compiled-view.md");
    assert(fs.existsSync(l2Path), "RUN-A: L2 compiled-view.md missing");
    const l2 = fs.readFileSync(l2Path, "utf8");
    // ROUND-TRIP
    assert(renderConstraintL2View(env.body.validated_decision, eventId).markdown === l2, "ROUND-TRIP: re-render != committed L2 bytes");
    // RUN-B: idempotent (later timestamp, same decision)
    const l2Mtime = fs.statSync(l2Path).mtimeMs;
    const b = await fixateConstraintDecisionAndRenderL2(fixateOpts(home, "2026-06-20T00:00:00.000Z"));
    assert(b.ok && b.status === "unchanged", `RUN-B expected unchanged, got ${b.status}`);
    assert(fs.readFileSync(l2Path, "utf8") === l2, "RUN-B: L2 changed on idempotent re-run");
    assert(scanProjectionEvents(home).length === 1, "RUN-B: new L1 projection event appended on idempotent re-run (L1 count != +0)");
    // RUN-C: reconcile clean (byte-compare + stale scan)
    const rec = reconcile(home);
    assert(rec.present && rec.failures.length === 0, `RUN-C reconcile failed: ${rec.failures.join("; ")}`);
    // RUN-D: rollback-inert (state-mode = no fixate) → L2 mtime + count stable
    assert(fs.statSync(l2Path).mtimeMs === l2Mtime, "RUN-D: L2 mtime changed without a fixate (not inert)");
    assert(scanProjectionEvents(home).length === 1, "RUN-D: projection event count drifted while inert");
    // NS-2: the 固化 projection event must NOT be admitted as constraint input, nor marked invalid
    const scan = await scanConstraintEvidenceEvents({ abrainHome: home });
    assert(!scan.events.some((e) => e.eventId === eventId), "NS-2: 固化 projection event wrongly admitted as constraint input (feedback loop)");
    assert(!scan.invalidEventIds.includes(eventId), "NS-2: 固化 projection event wrongly marked invalid");
    // git-delta: only l1/events/sha256/ + l2/views/constraint/ may be dirty.
    // -uall expands untracked dirs to individual files (git otherwise collapses a
    // wholly-untracked l2/ to '?? l2/', defeating the path allowlist).
    const porcelain = execFileSync("git", ["-C", home, "status", "--porcelain", "-uall"], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const line of porcelain) {
      const ok = /^(\?\?| M| A| D|A |M )\s+(l2\/views\/constraint\/|l1\/events\/sha256\/)/.test(line);
      assert(ok, `git-delta: unexpected dirty path outside allowlist: ${line}`);
    }
    assert(porcelain.length > 0, "git-delta: expected the fixate to dirty l1/l2 (nothing changed?)");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

check("stale-L2 detection: a newer 固化 event without an L2 rewrite is flagged (bundle-a)", async () => {
  const home = snapshot();
  try {
    const a = await fixateConstraintDecisionAndRenderL2(fixateOpts(home, "2026-06-19T00:00:00.000Z"));
    assert(a.ok && a.status === "written", "setup fixate failed");
    assert(reconcile(home).failures.length === 0, "baseline reconcile should be clean");
    // Part B device-independence: a NEWER event with the SAME decision (another
    // device's compile of the same inputs) must NOT flag stale — the L2 still
    // shows the correct decision. This is exactly the case the OLD event_id-based
    // staleness falsely flagged (the device_id-divergence bug).
    const sameDecId = sha256Hex(`same-${a.eventId}`);
    const sameDec = { schema: CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION, event_id: sameDecId, body_hash: sameDecId, body: { event_schema_version: "constraint-projection-event/v1", event_type: "constraint_compiled_view_produced", created_at_utc: "2026-12-30T00:00:00.000Z", validated_decision: decision } };
    writeFile(constraintEvidenceEventPath(home, sameDecId), `${JSON.stringify(sameDec, null, 2)}\n`);
    assert(reconcile(home).failures.length === 0, "same-decision newer event must NOT flag stale (device-independent)");
    // A swallowed l2_write_failed: a NEWER event with a DIFFERENT decision and no
    // L2 rewrite IS genuinely stale (the latest compile changed the decision).
    const newerId = sha256Hex(`newer-${a.eventId}`);
    const newerDecision = { ...decision, inputRootHash: `${decision.inputRootHash}-newer` };
    const newer = { schema: CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION, event_id: newerId, body_hash: newerId, body: { event_schema_version: "constraint-projection-event/v1", event_type: "constraint_compiled_view_produced", created_at_utc: "2026-12-31T23:59:59.000Z", validated_decision: newerDecision } };
    writeFile(constraintEvidenceEventPath(home, newerId), `${JSON.stringify(newer, null, 2)}\n`);
    const rec = reconcile(home);
    assert(rec.failures.some((f) => f.startsWith("stale_l2_newer_projection_exists")), `expected stale_l2 flag, got: ${rec.failures.join("; ") || "(none)"}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

check("ADR0039 Part B: L2 render is DEVICE-INDEPENDENT (same decision, different event_ids → byte-identical, no event_id in bytes)", () => {
  const x = renderConstraintL2View(decision, "x".repeat(64)).markdown;
  const y = renderConstraintL2View(decision, "y".repeat(64)).markdown;
  assert(x === y, "L2 bytes differ across event_ids — not device-independent");
  assert(!x.includes("x".repeat(64)) && !x.includes("y".repeat(64)) && !x.includes("sediment_projection_event_id"), "event_id leaked into L2 rendered bytes");
  assert(x.includes(`decision_hash: ${renderConstraintL2View(decision, "z".repeat(64)).decisionHash}\n`), "L2 missing device-independent decision_hash key");
});

await Promise.all(pending);
if (failures.length) { console.log(`\npreflight FAILED — ${failures.length}/${total} check(s) failed.`); process.exit(1); }
console.log(`\npreflight PASS — Constraint L2 repo-mode pipeline green on real ~/.abrain decision (${total} checks). Safe to flip per runbook.`);
