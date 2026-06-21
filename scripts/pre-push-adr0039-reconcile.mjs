#!/usr/bin/env node
/**
 * ADR0039 pre-push blocker.
 *
 * Blocks push when L1 hash/path validation, deterministic L2 projection
 * byte-compare, Constraint shadow freshness, dirty derived view, or L3 SQLite
 * mirror checks fail. After B3 the L2 view (l2/views/knowledge/) is git-tracked,
 * so an uncommitted/hand-edited L2 file is a real dirty derived view and is
 * blocked here (no longer a .state no-op).
 *
 * Escape hatch (deepseek HB3): set PI_SKIP_L2_CHECK=1 to override the block in
 * an emergency. The override is recorded as an auditable diagnostic; it does
 * not silence the check.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function recordOverride(abrainHome, detail) {
  try {
    const logPath = path.join(abrainHome, ".state", "sediment", "adr0039-l3", "prepush-overrides.jsonl");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), env: "PI_SKIP_L2_CHECK=1", ...detail })}\n`, "utf-8");
    return logPath;
  } catch {
    return null;
  }
}

const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
// Granular, independently-audited overrides (4xT0 R2): PI_SKIP_L2_CHECK must NOT
// silence an L1 append-only violation — that needs its own PI_SKIP_L1_APPEND_ONLY.
const l2Override = process.env.PI_SKIP_L2_CHECK === "1";
const l1Override = process.env.PI_SKIP_L1_APPEND_ONLY === "1";
const script = path.join(repoRoot, "scripts", "smoke-adr0039-reconcile.mjs");
// --push-gate-only: only blocker-tier (pushed-content) drives the block. Constraint
// shadow staleness (§6) and §12 dead-projector are gitignored-.state liveness signals
// printed but NOT push-blocking (they trip the STANDALONE reconcile:adr0039 used by CI).
const result = spawnSync(process.execPath, [script, "--abrain", abrainHome, "--push-gate-only"], {
  cwd: repoRoot,
  encoding: "utf-8",
});

if (result.error) {
  console.error(`FAIL — ADR0039 pre-push blocker could not run reconcile: ${result.error.message}`);
  process.exit(1);
}

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.status === 0) {
  console.log("PASS — ADR0039 pre-push blocker passed.");
  process.exit(0);
}

// Classify blocker FAIL lines so a single override can't sweep an unrelated class.
const failLines = (result.stdout || "").split("\n").filter((line) => line.includes("  FAIL  "));
const l1Violations = failLines.filter((line) => line.includes("l1_append_only_violated"));
const otherBlockers = failLines.filter((line) => !line.includes("l1_append_only_violated"));
const needL1 = l1Violations.length > 0;
const needOther = otherBlockers.length > 0;
const okL1 = !needL1 || l1Override;
const okOther = !needOther || l2Override;

if (okL1 && okOther) {
  const usedL1 = needL1 && l1Override;
  const usedL2 = needOther && l2Override;
  const logPath = recordOverride(abrainHome, {
    reconcile_exit: result.status,
    l1_append_only_override: usedL1,
    l2_check_override: usedL2,
    l1_violations: l1Violations.length,
    other_blockers: otherBlockers.length,
  });
  console.error("WARN — ADR0039 pre-push blocker(s) OVERRIDDEN by explicit env flag(s).");
  if (usedL1) console.error("       PI_SKIP_L1_APPEND_ONLY=1 bypassed an L1 append-only violation — L1 immutability was broken; reproject as a NEW appended event ASAP.");
  if (usedL2) console.error("       PI_SKIP_L2_CHECK=1 overrode a dirty derived view / pushed-content blocker; reproject + commit l1/ + l2/ ASAP.");
  console.error(`       Override recorded: ${logPath || "(could not write override log)"}`);
  process.exit(0);
}

console.error("FAIL — ADR0039 pre-push blocker rejected this push.");
if (needL1 && !l1Override) {
  console.error("  L1 APPEND-ONLY VIOLATED — the pushed range modifies/deletes an immutable L1 event:");
  for (const line of l1Violations) console.error(`    ${line.trim()}`);
  console.error("  L1 is content-addressed + immutable (ADR0039 §4.2). NEVER edit/delete/rename in place.");
  console.error("  Fix: restore the original l1 file; record any correction as a NEW appended event.");
  console.error("  Emergency override (audited, SEPARATE from L2): PI_SKIP_L1_APPEND_ONLY=1 git push");
}
if (needOther && !l2Override) {
  console.error("  PUSHED-CONTENT blocker(s) (dirty derived view / L1 hash / L2 byte-mismatch / L3 mirror):");
  for (const line of otherBlockers) console.error(`    ${line.trim()}`);
  console.error("  Fix: reproject + commit l1/ + l2/, e.g.");
  console.error("       node scripts/backfill-legacy-knowledge.mjs --abrain ~/.abrain --reproject");
  console.error("       git -C ~/.abrain add l1 l2 && git -C ~/.abrain commit -m 'reproject L2'");
  console.error("  Emergency override (audited): PI_SKIP_L2_CHECK=1 git push");
}
process.exit(result.status || 1);
