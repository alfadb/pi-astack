#!/usr/bin/env node
/**
 * ADR0039 manual local integrity checker.
 *
 * Standalone CLI wrapper around extensions/abrain/reconcile-gate.ts for an
 * operator-requested local check. It is not installed as a hook and is not a
 * live runtime or device git-sync gate.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { checkAdr0039ReconcileGate } = await jiti.import(path.join(repoRoot, "extensions", "abrain", "reconcile-gate.ts"));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function expandHome(input) {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
const gate = await checkAdr0039ReconcileGate({ abrainHome, repoRoot, env: process.env });
const details = gate.details;

process.stdout.write(details.stdout || "");
process.stderr.write(details.stderr || "");

if (gate.ok && gate.reason === "passed") {
  console.log("PASS — ADR0039 local integrity check passed.");
  process.exit(0);
}

if (gate.ok && gate.reason === "overridden") {
  console.error("WARN — ADR0039 local integrity finding(s) OVERRIDDEN by explicit env flag(s).");
  if (details.l1Violations.length > 0 && details.l1Override) {
    console.error("       PI_SKIP_L1_APPEND_ONLY=1 bypassed an L1 append-only violation — L1 immutability was broken; reproject as a NEW appended event ASAP.");
  }
  if (details.otherBlockers.length > 0 && details.l2Override) {
    console.error("       PI_SKIP_L2_CHECK=1 overrode a dirty derived view / local-content finding; reproject + commit l1/ + l2/ ASAP.");
  }
  console.error(`       Override recorded: ${details.overrideLogPath || "(could not write override log)"}`);
  process.exit(0);
}

if (gate.reason === "runner_error") {
  console.error(`FAIL — ADR0039 local integrity checker could not run reconcile: ${details.stderr || "unknown runner error"}`);
  process.exit(1);
}

console.error("FAIL — ADR0039 local integrity check found blocking inconsistencies.");
if (details.l1Violations.length > 0 && !details.l1Override) {
  console.error("  L1 APPEND-ONLY VIOLATED — the local comparison range modifies/deletes an immutable L1 event:");
  for (const line of details.l1Violations) console.error(`    ${line.trim()}`);
  console.error("  L1 is content-addressed + immutable (ADR0039 §4.2). NEVER edit/delete/rename in place.");
  console.error("  Fix: restore the original l1 file; record any correction as a NEW appended event.");
  console.error("  Manual-check override (audited, SEPARATE from L2): PI_SKIP_L1_APPEND_ONLY=1 npm run check:adr0039-integrity");
}
if (details.otherBlockers.length > 0 && !details.l2Override) {
  console.error("  LOCAL-INTEGRITY finding(s) (dirty derived view / L1 hash / L2 byte-mismatch / L3 mirror):");
  for (const line of details.otherBlockers) console.error(`    ${line.trim()}`);
  console.error("  Fix: reproject + commit l1/ + l2/, e.g.");
  console.error("       node scripts/backfill-legacy-knowledge.mjs --abrain ~/.abrain --reproject");
  console.error("       git -C ~/.abrain add l1 l2 && git -C ~/.abrain commit -m 'reproject L2'");
  console.error("  Manual-check override (audited): PI_SKIP_L2_CHECK=1 npm run check:adr0039-integrity");
}
process.exit(details.status || 1);
