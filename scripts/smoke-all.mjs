#!/usr/bin/env node
/**
 * Aggregate smoke gate.
 *
 * Why this exists: pi-astack has 100+ `smoke:*` scripts but no single runner
 * and no CI. Several isolated harnesses transpile a hand-listed set of TS
 * sources and assert against the live pi-astack-settings.json. When production
 * code grows a new intra-repo import edge (e.g. ADR 0034 direction-impact,
 * causal-anchor, sync-file-lock) or a settings kill-switch flips (e.g. ADR 0036
 * stage1Skip), those harnesses silently go red with nobody re-running them.
 * This runner closes that gap: it executes the deterministic OFFLINE subset and
 * exits non-zero if ANY of them fail, so manifest/assertion drift is caught.
 *
 * Usage:
 *   node scripts/smoke-all.mjs            # offline gate (default; hard-fails on any red)
 *   node scripts/smoke-all.mjs --live     # also run network/key-dependent smokes
 *   node scripts/smoke-all.mjs --only-live # run only the live subset
 *   node scripts/smoke-all.mjs --timeout=180  # per-test seconds (offline default 120)
 *
 * Exit code: 1 if any selected OFFLINE smoke FAILs or TIMEOUTs; LIVE timeouts
 * are reported as warnings (slow upstream model / rate limit, not a code defect).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Smokes that perform real network calls (embedding HTTP / search backend) or
// depend on a live API key. They self-SKIP without a key but otherwise run live
// and can be slow (e.g. stage0-metrics: ~140s for the M3 stage2 ranker). Kept
// out of the default offline gate so the gate stays fast and deterministic.
const LIVE = new Set([
  "embedding",
  "web-search",
  "stage0-metrics",
  "stage0-freshness",
  "stage0-nonactive",
]);

const args = process.argv.slice(2);
const withLive = args.includes("--live");
const onlyLive = args.includes("--only-live");
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const offlineTimeoutSec = timeoutArg ? Number(timeoutArg.split("=")[1]) : 120;
const liveTimeoutSec = Math.max(offlineTimeoutSec, 300);

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const allSmokes = Object.keys(pkg.scripts || {})
  .filter((k) => k.startsWith("smoke:"))
  .map((k) => ({ name: k.slice("smoke:".length), cmd: pkg.scripts[k] }))
  .filter((s) => s.name !== "all"); // never recurse into this runner

// Parse `node scripts/<file>.mjs` out of the npm script body so we can spawn
// node directly (skips per-test npm overhead).
function parseNodeScript(cmd) {
  const m = cmd.match(/node\s+(scripts\/[^\s]+\.mjs)/);
  return m ? m[1] : null;
}

function classify(name) {
  return LIVE.has(name) ? "live" : "offline";
}

let selected = allSmokes;
if (onlyLive) selected = allSmokes.filter((s) => classify(s.name) === "live");
else if (!withLive) selected = allSmokes.filter((s) => classify(s.name) === "offline");

selected.sort((a, b) => a.name.localeCompare(b.name));

console.log(`smoke-all — ${selected.length} smoke(s) selected ` +
  `(${onlyLive ? "live only" : withLive ? "offline + live" : "offline only"}; ` +
  `offline timeout ${offlineTimeoutSec}s, live timeout ${liveTimeoutSec}s)\n`);

const results = [];
for (const s of selected) {
  const lane = classify(s.name);
  const file = parseNodeScript(s.cmd);
  if (!file) { results.push({ name: s.name, lane, status: "SKIP-UNPARSEABLE" }); continue; }
  const timeoutSec = lane === "live" ? liveTimeoutSec : offlineTimeoutSec;
  const started = Date.now();
  const run = spawnSync("node", [file], {
    cwd: repoRoot,
    timeout: timeoutSec * 1000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Date.now() - started;
  let status;
  if (run.error && run.error.code === "ETIMEDOUT") status = "TIMEOUT";
  else if (run.status === 0) status = "PASS";
  else status = "FAIL";
  const out = ((run.stdout || "") + (run.stderr || ""));
  const skipped = status === "PASS" && /\bSKIP:/.test(out);
  results.push({ name: s.name, lane, status: skipped ? "SKIP" : status, ms, out });
  const tag = skipped ? "SKIP" : status;
  const icon = tag === "PASS" ? "ok  " : tag === "SKIP" ? "skip" : tag === "TIMEOUT" ? "time" : "FAIL";
  console.log(`  ${icon}  [${lane}] ${s.name} (${(ms / 1000).toFixed(1)}s)`);
  if (status === "FAIL") {
    const tail = out.trim().split(/\n/).slice(-4).map((l) => "        | " + l).join("\n");
    if (tail) console.log(tail);
  }
}

// Gate policy: any OFFLINE FAIL or TIMEOUT is a hard failure. LIVE TIMEOUTs are
// warnings (slow/rate-limited upstream, not a code defect). LIVE FAILs are hard.
const offlineBad = results.filter((r) => r.lane === "offline" && (r.status === "FAIL" || r.status === "TIMEOUT"));
const liveFail = results.filter((r) => r.lane === "live" && r.status === "FAIL");
const liveTimeout = results.filter((r) => r.lane === "live" && r.status === "TIMEOUT");

const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
console.log(`\nsummary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
if (liveTimeout.length) console.log(`live timeouts (warn, not gating): ${liveTimeout.map((r) => r.name).join(", ")}`);

const hardFail = [...offlineBad, ...liveFail];
if (hardFail.length) {
  console.log(`\nGATE FAIL: ${hardFail.map((r) => `${r.name}(${r.status})`).join(", ")}`);
  process.exit(1);
}
console.log("\nGATE OK");
