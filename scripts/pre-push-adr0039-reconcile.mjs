#!/usr/bin/env node
/**
 * ADR0039 pre-push blocker.
 *
 * Blocks push when L1 hash/path validation, deterministic L2 projection
 * byte-compare, Constraint shadow freshness, or L3 SQLite mirror checks fail.
 */

import { spawnSync } from "node:child_process";
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

const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
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
  console.error("FAIL — ADR0039 pre-push blocker rejected this push.");
  process.exit(result.status || 1);
}

console.log("PASS — ADR0039 pre-push blocker passed.");
process.exit(0);
