#!/usr/bin/env node
/**
 * ADR0039 Constraint L2 repo-mode flip POST-RESTART verify (4×T0 v3 consensus).
 * Run ONCE after flipping constraintShadowCompiler.l2OutputRoot → "repo",
 * restarting pi, and letting one compile run. Replaces the runbook's
 * eyeball-the-git-status step with a single deterministic exit code, so
 * "verification 别自己说了算" holds for the user too.
 *
 * Checks (all disk-observable, non-mutating):
 *  1. constraint L2 view present (the flip actually produced l2/views/constraint).
 *  2. full ~/.abrain reconcile green (delegates to smoke-adr0039-reconcile, which
 *     now includes the bundle-a stale-L2 scan — catches a swallowed l2_write_failed
 *     leaving L2 stale behind a newer 固化 event).
 *  3. git attribution: every dirty path is sediment-managed (l1/ or l2/); any
 *     dirty path outside → FAIL (a hand-edit / wrong-tree mutation slipped in).
 *
 * Usage: node scripts/verify-constraint-l2-flip.mjs [--abrain ~/.abrain]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) { const i = process.argv.indexOf(name); return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; }
function expandHome(p) { return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p; }
const ABRAIN = path.resolve(expandHome(arg("--abrain", path.join(os.homedir(), ".abrain"))));

const failures = [];
function fail(msg) { failures.push(msg); console.log(`  FAIL  ${msg}`); }
function ok(msg) { console.log(`  ok    ${msg}`); }

console.log(`ADR0039 Constraint L2 repo-mode flip verify — ${ABRAIN}`);

// 1. constraint L2 view present
const l2Path = path.join(ABRAIN, "l2", "views", "constraint", "latest", "compiled-view.md");
if (!fs.existsSync(l2Path)) {
  fail("constraint L2 view absent (l2/views/constraint/latest/compiled-view.md) — flip did not take effect, or 固化/L2 write failed (check for SC_L2_WRITE_FAILED in the auto-refresh log)");
} else {
  const raw = fs.readFileSync(l2Path, "utf8");
  const m = raw.match(/^sediment_projection_event_id:\s*(.+)$/m);
  ok(`constraint L2 present (projection_event_id ${m ? m[1].trim().slice(0, 16) : "?"}…)`);
}

// 2. full reconcile (includes the bundle-a constraint stale-L2 scan)
try {
  execFileSync("node", [path.join(__dirname, "smoke-adr0039-reconcile.mjs"), "--abrain", ABRAIN], { stdio: ["ignore", "ignore", "pipe"] });
  ok("reconcile green (L1/L2 byte-faithful incl constraint stale-L2 scan)");
} catch (err) {
  const out = (err && err.stderr ? err.stderr.toString() : "") || (err && err.stdout ? err.stdout.toString() : "");
  fail(`reconcile failed:\n${out.split("\n").filter((l) => /fail|stale|mismatch|FAIL/i.test(l)).slice(0, 8).join("\n") || out.slice(-400)}`);
}

// 3. git attribution: only sediment-managed l1/ or l2/ may be dirty
try {
  const porcelain = execFileSync("git", ["-C", ABRAIN, "status", "--porcelain", "-uall"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const offenders = porcelain.filter((line) => !/^..\s+(l1\/|l2\/)/.test(line));
  if (offenders.length) fail(`git attribution: ${offenders.length} dirty path(s) outside sediment l1//l2/ (commit/inspect before enabling):\n        ${offenders.slice(0, 8).join("\n        ")}`);
  else ok(`git attribution clean (${porcelain.length} dirty path(s), all under l1//l2/)`);
} catch (err) {
  fail(`git status failed (is ${ABRAIN} a git repo?): ${err && err.message ? err.message : err}`);
}

if (failures.length) { console.log(`\nverify FAILED — ${failures.length} check(s) failed. Do NOT consider the flip confirmed.`); process.exit(1); }
console.log("\nverify PASS — Constraint L2 repo-mode flip is clean + attributable. Safe to commit ~/.abrain.");
