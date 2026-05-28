#!/usr/bin/env node
/**
 * Smoke: ADR 0027 §C2' Stage 1b R8 P1 fix — heartbeat lifecycle
 * structural invariant.
 *
 * Stage 1b R8 unanimous P1 finding (Opus P0-A + GPT-5.5 P1-1 + DeepSeek
 * P1-2): runInProcess had three early-return paths BEFORE Promise.race
 * that skipped heartbeat.stop(), causing setInterval + on-disk trace +
 * globalThis registry to leak indefinitely.
 *
 * R8 fix: wrap runInProcess body in try/finally so heartbeat.stop()
 * fires on every terminal path.
 *
 * This smoke locks the STRUCTURAL invariant via source grep — there
 * must be no `return` between `startHeartbeat(...)` and the `try {`
 * that opens the lifecycle scope. New early-return paths added in
 * future without wrapping in try/finally will fail this smoke.
 *
 * Why not runtime: actually executing runInProcess requires real pi
 * runtime + LLM + model resolution. Mocking is heavy and fragile.
 * The structural invariant is small (no `return` outside try) and
 * catches the regression class definitively.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const dispatchSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/dispatch/index.ts"),
  "utf-8",
);
const heartbeatSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/_shared/heartbeat.ts"),
  "utf-8",
);

console.log("Section: heartbeat.ts internal R8 fixes");

check("stop() writes 'stopping' BEFORE setting stopped=true", () => {
  // The pre-R8 bug was that stop() set stopped=true then called
  // writeOne("stopping"), but writeOne's first line is
  // `if (stopped) return`, so the terminal beat was silently dropped.
  // R8 fix: writeOne("stopping", { force: true }) is called BEFORE
  // stopped=true, with force=true as belt-and-suspenders.
  const stopBody = heartbeatSrc.match(
    /stop\(\)\s*\{[\s\S]{0,1000}?\}\s*,\s*\n\s*tracePath/,
  );
  if (!stopBody) throw new Error("could not locate stop() method body");
  // The writeOne(\"stopping\"...) call must appear BEFORE the stopped=true assignment.
  const writeIdx = stopBody[0].search(/writeOne\("stopping"/);
  const stoppedIdx = stopBody[0].search(/stopped\s*=\s*true/);
  if (writeIdx < 0) throw new Error("stop() must call writeOne(\"stopping\")");
  if (stoppedIdx < 0) throw new Error("stop() must set stopped=true");
  if (writeIdx >= stoppedIdx) {
    throw new Error(
      "stop() must call writeOne(\"stopping\") BEFORE setting stopped=true. " +
      "Pre-R8 ordering caused the terminal beat to be silently dropped " +
      "(unanimous Opus P1-B + GPT-5.5 P1-2 finding).",
    );
  }
});

check("writeOne accepts { force: true } to bypass stopped guard", () => {
  // The force flag is needed so the terminal "stopping" beat lands even
  // if a caller already set stopped (defense in depth alongside the
  // ordering fix above).
  if (!/writeOne\(phase: HeartbeatPhase,\s*opts:\s*\{[^}]*force\?:\s*boolean[^}]*\}/.test(heartbeatSrc)) {
    throw new Error(
      "writeOne must accept opts with force?: boolean (R8 belt-and-suspenders)",
    );
  }
  if (!/if \(stopped && !opts\.force\) return/.test(heartbeatSrc)) {
    throw new Error(
      "writeOne guard must read `if (stopped && !opts.force) return` so " +
      "force=true bypasses it",
    );
  }
});

check("HeartbeatBeat schema carries schema_version + seq + interval_ms", () => {
  // R8 GPT-5.5 + DeepSeek unanimous P2-1: consumer needs to know the
  // schema and interval to make staleness math reliable.
  if (!/schema_version:\s*number/.test(heartbeatSrc)) {
    throw new Error("HeartbeatBeat.schema_version must be declared");
  }
  if (!/seq:\s*number/.test(heartbeatSrc)) {
    throw new Error("HeartbeatBeat.seq must be declared");
  }
  if (!/interval_ms\?:\s*number/.test(heartbeatSrc)) {
    throw new Error("HeartbeatBeat.interval_ms? must be declared");
  }
  if (!/HEARTBEAT_SCHEMA_VERSION = 1/.test(heartbeatSrc)) {
    throw new Error("HEARTBEAT_SCHEMA_VERSION constant must be declared (= 1 in v1)");
  }
});

console.log("\nSection: dispatch/index.ts runInProcess lifecycle (R8 P1 fix)");

check("runInProcess wraps body in try/finally around heartbeat lifecycle", () => {
  // R8 unanimous P1 fix: try/finally is the only way to guarantee
  // stop() fires on every path (early return, throw, normal completion).
  //
  // Look for the pattern:
  //   const heartbeat: HeartbeatHandle = startHeartbeat(...)
  //   ...
  //   try {
  //     ... body ...
  //   } finally {
  //     heartbeat.stop();
  //   }
  const startIdx = dispatchSrc.search(/const heartbeat:\s*HeartbeatHandle\s*=\s*startHeartbeat\(/);
  if (startIdx < 0) throw new Error("could not locate startHeartbeat call");
  // The next non-trivial token after startHeartbeat closing must be
  // `try {` (with comments/blank lines allowed in between).
  const window = dispatchSrc.slice(startIdx, startIdx + 2000);
  if (!/try\s*\{/.test(window)) {
    throw new Error(
      "no try block found after startHeartbeat. R8 P1 unanimous fix " +
      "requires try/finally wrapping the runInProcess body so " +
      "heartbeat.stop() fires on every terminal path",
    );
  }
  // The finally must call heartbeat.stop()
  const finallyMatch = dispatchSrc.match(/\}\s*finally\s*\{[\s\S]{0,500}?heartbeat\.stop\(\)/);
  if (!finallyMatch) {
    throw new Error(
      "no `} finally { heartbeat.stop() }` found. R8 P1 fix requires " +
      "heartbeat.stop() in finally block to guarantee idempotent cleanup " +
      "on early returns, throws, and normal completion",
    );
  }
});

check("no early `return` between startHeartbeat and try {", () => {
  // Sanity: any return between startHeartbeat and the try block bypasses
  // the lifecycle scope. There SHOULD be none in R8.
  const startIdx = dispatchSrc.search(/const heartbeat:\s*HeartbeatHandle\s*=\s*startHeartbeat\(/);
  if (startIdx < 0) throw new Error("could not locate startHeartbeat call");
  const tryIdx = dispatchSrc.slice(startIdx).search(/\n\s*try\s*\{/);
  if (tryIdx < 0) throw new Error("no try { found after startHeartbeat");
  const between = dispatchSrc.slice(startIdx, startIdx + tryIdx);
  // Any `return ` keyword in this gap is suspect.
  if (/\breturn\s+[^;]/.test(between)) {
    throw new Error(
      "FOUND a `return` statement between startHeartbeat and try { — this " +
      "regression would leak heartbeat. All early returns MUST be inside " +
      "the try block.",
    );
  }
});

check("heartbeat.stop() is the ONLY exit-cleanup call (no manual stop scattered)", () => {
  // Multiple manual heartbeat.stop() calls scattered through the function
  // body would be a code smell suggesting the try/finally invariant
  // isn't fully trusted. In R8 there should be exactly ONE
  // ACTUAL heartbeat.stop() invocation (the one in finally). Comments
  // that mention `heartbeat.stop()` for documentation don't count.
  // Count only lines where heartbeat.stop() is not preceded by `//` on
  // the same line.
  let stopCalls = 0;
  for (const line of dispatchSrc.split("\n")) {
    const idx = line.indexOf("heartbeat.stop()");
    if (idx < 0) continue;
    // Find the first `//` on this line, if any.
    const commentIdx = line.indexOf("//");
    if (commentIdx >= 0 && commentIdx < idx) continue; // inside a comment
    stopCalls++;
  }
  if (stopCalls !== 1) {
    throw new Error(
      `expected exactly 1 heartbeat.stop() executable call (in finally); got ${stopCalls}. ` +
      `Multiple stop() calls suggest the try/finally invariant is being ` +
      `worked around rather than trusted.`,
    );
  }
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all C5 heartbeat lifecycle invariants hold`);
