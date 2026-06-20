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
const override = process.env.PI_SKIP_L2_CHECK === "1";
const script = path.join(repoRoot, "scripts", "smoke-adr0039-reconcile.mjs");
const result = spawnSync(process.execPath, [script, "--abrain", abrainHome], {
  cwd: repoRoot,
  encoding: "utf-8",
  stdio: "inherit",
});

if (result.error) {
  console.error(`FAIL — ADR0039 pre-push blocker could not run reconcile: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  if (override) {
    const logPath = recordOverride(abrainHome, { reconcile_exit: result.status });
    console.error("WARN — ADR0039 pre-push reconcile FAILED but PI_SKIP_L2_CHECK=1 overrode the block.");
    console.error(`       Override recorded: ${logPath || "(could not write override log)"}`);
    console.error("       The dirty derived view is NOT fixed; reproject + commit l1/ + l2/ as soon as possible.");
    process.exit(0);
  }
  console.error("FAIL — ADR0039 pre-push blocker rejected this push (dirty derived view or reconcile failure).");
  console.error("Runbook:");
  console.error("  1. Inspect the FAIL lines above (e.g. dirty_derived_view:?? l2/views/knowledge/...).");
  console.error("  2. If L2 drifted from L1: reproject + commit, e.g.");
  console.error("       node scripts/backfill-legacy-knowledge.mjs --abrain ~/.abrain --reproject");
  console.error("       git -C ~/.abrain add l1 l2 && git -C ~/.abrain commit -m 'reproject L2'");
  console.error("  3. If you must push anyway (emergency only): PI_SKIP_L2_CHECK=1 git push  (override is audited).");
  process.exit(result.status || 1);
}

console.log("PASS — ADR0039 pre-push blocker passed.");
process.exit(0);
