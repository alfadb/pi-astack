#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  "smoke-constraint-runtime-gate.mjs",
  "smoke-constraint-legacy-retirement.mjs",
  "smoke-constraint-semantic-review-pack.mjs",
  "smoke-constraint-text-delta-dispositions-writer.mjs",
  "smoke-constraint-compiled-only-dispositions-writer.mjs",
  "smoke-constraint-shadow-compiler.mjs",
  "smoke-constraint-shadow-liveness-recovery.mjs",
  "smoke-constraint-l2-repo-preflight.mjs",
  "smoke-constraint-evidence-event.mjs",
];

for (const suite of suites) {
  process.stdout.write(`\n[constraint-full] ${suite}\n`);
  const result = spawnSync(process.execPath, [path.join(scriptsDir, suite)], {
    cwd: path.resolve(scriptsDir, ".."),
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`[constraint-full] FAIL ${suite} (exit ${result.status ?? "signal"})\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(`\nsmoke-constraint-compiler-full: PASS (${suites.length}/${suites.length} suites)\n`);
