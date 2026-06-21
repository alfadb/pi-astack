#!/usr/bin/env node
/**
 * ADR0039 Constraint L2 shadow — one-time FIX-1 backfill (4×T0 R1-R3 consensus,
 * 2026-06-20 NS-2+FIX-1 ratified, 2026-06-21 R3 unanimous completion).
 *
 * Completes the already-4/4-signed Constraint-L2-shadow shard, which was
 * half-executed: the projection mechanism (projection.ts + render.ts +
 * event-scan NS-2 allowlist + reconcile/pre-push validateConstraintL2) all
 * shipped, but the artifact (the L1 projection event + l2/views/constraint/)
 * was never produced (the live compile only fixates after a successful LLM run;
 * the last run failed at the LLM stage so fixate was never reached).
 *
 * This 固化s the EXISTING on-disk validated decision.json (the constraint
 * compiler's 2026-06-20 LLM output) into ONE content-addressed
 * constraint-projection-envelope/v1 L1 event, then renders the deterministic
 * git-tracked L2 view. NO new LLM call, NO validate replay (FIX-1).
 *
 * Revision B (R-A, 4×T0): causal_parents / input_event_ids = the EXACT 2 events
 * the decision was generated from (event-coverage.json rows), NOT the 3 now on
 * disk. The 3rd constraint_signal_observed arrived after the 06-20 compile and
 * is unprojected; it will be a causal parent of the NEXT natural projection.
 *
 * Provenance honesty: the original 06-20 LLM-call artifacts (prompt.txt /
 * input.normalized.json) were OVERWRITTEN by a failed 06-21 partial run, so
 * model / prompt_hash / raw_output_hash are unrecoverable and recorded as ""
 * (the live fixate path already uses "" for unknown model/raw_output_hash). The
 * intrinsic, recoverable hashes — input_root_hash and validationHash — are
 * preserved. Reconcile byte-compares render(validated_decision); it does not
 * depend on these forensic provenance hashes.
 *
 * Hard boundaries (R3): NO injection read-flip (rule-injector keeps reading the
 * .state shadow bundle); fallbackToLegacyOnError stays true; constraint
 * schema/flag/soak stay separate from Knowledge. Reversible: git revert the
 * abrain commit + flip constraintShadowCompiler.l2OutputRoot back to "state";
 * the content-addressed L1 projection event is left as a harmless orphan, NEVER
 * rm'd (R-B-orphan — keeps "L1 永不反向写" strict-syntactic). Idempotent:
 * re-runs return "unchanged" once the committed L2 carries the decision_hash.
 *
 * Usage:
 *   node scripts/backfill-adr0039-constraint-l2.mjs --abrain ~/.abrain --dry-run
 *   node scripts/backfill-adr0039-constraint-l2.mjs --abrain ~/.abrain
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
}
function stageTs(outRoot, src) {
  const dst = src.replace(/^extensions\//, "").replace(/\.ts$/, ".js");
  writeFile(path.join(outRoot, dst), transpile(path.join(repoRoot, src)));
}
function loadProjectionModule() {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-constraint-projection-"));
  // Full transitive dependency tree of constraint-compiler/projection.ts.
  for (const src of [
    "extensions/sediment/sanitizer.ts",
    "extensions/sediment/constraint-evidence/types.ts",
    "extensions/sediment/constraint-evidence/canonical-json.ts",
    "extensions/sediment/constraint-evidence/diagnostics.ts",
    "extensions/sediment/constraint-evidence/hash-envelope.ts",
    "extensions/sediment/constraint-evidence/read.ts",
    "extensions/sediment/constraint-evidence/append.ts",
    "extensions/sediment/constraint-compiler/types.ts",
    "extensions/sediment/constraint-compiler/diagnostics.ts",
    "extensions/sediment/constraint-compiler/normalize.ts",
    "extensions/sediment/constraint-compiler/render.ts",
    "extensions/sediment/constraint-compiler/projection.ts",
  ]) stageTs(outRoot, src);
  return createRequire(path.join(outRoot, "runner.cjs"))("./sediment/constraint-compiler/projection.js");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
  const dryRun = hasFlag("dry-run");
  const createdAtUtc = arg("created-at", new Date().toISOString());

  const shadowDir = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  const decisionPath = path.join(shadowDir, "decision.json");
  const coveragePath = path.join(shadowDir, "event-coverage.json");
  const deviceIdPath = path.join(abrainHome, ".state", "device-id");

  for (const [label, p] of [["decision.json", decisionPath], ["event-coverage.json", coveragePath]]) {
    if (!fs.existsSync(p)) {
      console.error(`FAIL — missing ${label}: ${p}`);
      process.exit(1);
    }
  }

  const decision = readJson(decisionPath);
  const coverage = readJson(coveragePath);
  const inputEventIds = (coverage.rows ?? []).map((r) => r.eventId).filter(Boolean).slice().sort();
  const deviceId = fs.existsSync(deviceIdPath) ? fs.readFileSync(deviceIdPath, "utf8").trim() : "unknown-device";

  if (!inputEventIds.length) {
    console.error("FAIL — event-coverage.json has no rows; cannot determine input_event_ids.");
    process.exit(1);
  }
  if (decision.schemaVersion !== "constraint-shadow-decision/v1") {
    console.error(`FAIL — unexpected decision schemaVersion: ${decision.schemaVersion}`);
    process.exit(1);
  }

  const provenance = {
    model: "",
    prompt_hash: "",
    input_hash: decision.inputRootHash,
    raw_output_hash: "",
    ...(decision.validationHash ? { parsed_output_hash: decision.validationHash } : {}),
    acceptance: "accepted_for_event_append",
  };

  console.log("ADR0039 Constraint L2 backfill (FIX-1, Revision B)");
  console.log(`  abrain:           ${abrainHome}`);
  console.log(`  decision schema:  ${decision.schemaVersion}`);
  console.log(`  inputRootHash:    ${decision.inputRootHash}`);
  console.log(`  validationHash:   ${decision.validationHash ?? "(none)"}`);
  console.log(`  constraints:      ${(decision.constraints ?? []).length}`);
  console.log(`  device_id:        ${deviceId}`);
  console.log(`  created_at_utc:   ${createdAtUtc}`);
  console.log(`  input_event_ids:  [${inputEventIds.join(", ")}]  (count=${inputEventIds.length})`);
  console.log(`  provenance:       model="" prompt_hash="" raw_output_hash="" (06-20 LLM artifacts overwritten; unrecoverable)`);
  console.log(`                    input_hash=${provenance.input_hash} parsed_output_hash=${provenance.parsed_output_hash ?? "(none)"}`);

  if (inputEventIds.length !== 2) {
    console.warn(`  WARN — expected exactly 2 input events (Revision B); got ${inputEventIds.length}. Proceeding with the recorded set.`);
  }

  const projection = loadProjectionModule();

  if (dryRun) {
    console.log("\n[dry-run] would 固化 the decision into ONE constraint-projection-envelope/v1 L1 event");
    console.log(`[dry-run]   L1 path:   ${abrainHome}/l1/events/sha256/<id[0:2]>/<id[2:4]>/<id>.json`);
    console.log(`[dry-run]   L2 path:   ${abrainHome}/${projection.constraintL2RelativePath()}`);
    console.log("[dry-run]   event_id is content-addressed (computed at write time from the fields above).");
    console.log("[dry-run] no files written.");
    return;
  }

  const result = await projection.fixateConstraintDecisionAndRenderL2({
    abrainHome,
    decision,
    provenance,
    inputEventIds,
    createdAtUtc,
    deviceId,
    producerVersion: "constraint-shadow-artifact/v1",
  });

  console.log(`\nstatus:        ${result.status}`);
  console.log(`ok:            ${result.ok}`);
  console.log(`event_id:      ${result.eventId ?? "(none)"}`);
  console.log(`decision_hash: ${result.decisionHash}`);
  console.log(`l2:            ${abrainHome}/${result.l2RelativePath}`);
  if (result.append) console.log(`append:        ${result.append.status} -> ${result.append.filePath}`);
  if (!result.ok) {
    console.error("FAIL — fixate did not complete cleanly.");
    process.exit(1);
  }
  console.log("\nPASS — constraint L2 backfill complete. Next: git add l1 l2 in abrain + run reconcile/pre-push.");
}

main().catch((err) => {
  console.error(`FAIL — ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
