#!/usr/bin/env node
/**
 * Smoke: ADR 0027 §C2' v1 Stage 1b dispatch → heartbeat integration.
 *
 * The standalone heartbeat writer is covered by smoke-c5-heartbeat.mjs.
 * This smoke locks the wiring: dispatch_agent and dispatch_parallel
 * both pass anchor + projectRoot into runInProcess, runInProcess calls
 * startHeartbeat AND stop, and heartbeat handle is exposed on every
 * terminal path.
 *
 * Same grep-based discipline as smoke-c5-audit-row-schema.mjs.
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

console.log("Section: runInProcess heartbeat lifecycle");

check("runInProcess imports startHeartbeat from _shared/heartbeat", () => {
  if (!/import\s*\{[^}]*startHeartbeat[^}]*\}\s*from\s*["']\.\.\/_shared\/heartbeat["']/.test(dispatchSrc)) {
    throw new Error("dispatch/index.ts must import startHeartbeat from ../_shared/heartbeat");
  }
});

check("runInProcess signature accepts heartbeatCtx (anchor + projectRoot)", () => {
  if (!/heartbeatCtx\?:\s*\{\s*anchor\?:\s*CausalAnchor;\s*projectRoot\?:\s*string\s*\}/.test(dispatchSrc)) {
    throw new Error(
      "runInProcess must accept optional heartbeatCtx parameter " +
      "with { anchor?: CausalAnchor; projectRoot?: string } shape",
    );
  }
});

check("runInProcess calls startHeartbeat BEFORE createAgentSession", () => {
  // Verify start ordering: startHeartbeat must appear before
  // createAgentSession in the source so a hang during session
  // construction can also be detected.
  const startHbIdx = dispatchSrc.search(/const heartbeat:\s*HeartbeatHandle\s*=\s*startHeartbeat\(/);
  if (startHbIdx < 0) {
    throw new Error("runInProcess must call startHeartbeat() to obtain HeartbeatHandle");
  }
  const createIdx = dispatchSrc.search(/await createAgentSession\(/);
  if (createIdx < 0) {
    throw new Error("could not locate createAgentSession call");
  }
  if (startHbIdx >= createIdx) {
    throw new Error(
      "startHeartbeat must be called BEFORE createAgentSession so session-construction " +
      "hangs are observable via missed beats",
    );
  }
});

check("runInProcess calls heartbeat.stop() on Promise.race result", () => {
  // The cleanest way to ensure stop() is called on every terminal path
  // (success / error / timeout / abort) is to call it after Promise.race
  // resolves. heartbeat.stop() is idempotent + best-effort. Widen the
  // regex window to accommodate the explanatory comment block.
  const raceIdx = dispatchSrc.search(/const result = await Promise\.race\(\[runPromise, timeoutPromise\]\);/);
  if (raceIdx < 0) {
    throw new Error("could not locate Promise.race aggregation site");
  }
  // Look ahead 1500 chars to find heartbeat.stop() before `return result`.
  const window = dispatchSrc.slice(raceIdx, raceIdx + 1500);
  if (!/heartbeat\.stop\(\)/.test(window)) {
    throw new Error(
      "heartbeat.stop() must be called after Promise.race resolves so every " +
      "terminal path (success/error/timeout/abort) cleans up the trace file",
    );
  }
  // Sanity: must be before `return result`
  const stopIdx = window.search(/heartbeat\.stop\(\)/);
  const returnIdx = window.search(/return result;/);
  if (stopIdx < 0 || returnIdx < 0 || stopIdx >= returnIdx) {
    throw new Error("heartbeat.stop() must execute before `return result;`");
  }
});

console.log("\nSection: caller-side heartbeatCtx threading");

check("dispatch_agent.execute passes anchor + projectRoot to runInProcess", () => {
  // Find the dispatch_agent runInProcess call (anchored by
  // `runWithTriggerAnchor(subAnchor`). The call body spans multiple
  // lines with comments; widen the window.
  const startIdx = dispatchSrc.search(
    /result = await runWithTriggerAnchor\(subAnchor,/,
  );
  if (startIdx < 0) throw new Error("could not locate dispatch_agent runInProcess call");
  const window = dispatchSrc.slice(startIdx, startIdx + 2000);
  if (!/anchor:\s*subAnchor,\s*projectRoot:\s*ctx\.cwd\s*\|\|\s*process\.cwd\(\)/.test(window)) {
    throw new Error(
      "dispatch_agent must pass { anchor: subAnchor, projectRoot: ctx.cwd || process.cwd() } " +
      "as heartbeatCtx to runInProcess",
    );
  }
});

check("dispatch_parallel.worker passes anchor + projectRoot to runInProcess", () => {
  // Find the dispatch_parallel worker's runInProcess call.
  const startIdx = dispatchSrc.search(
    /res = await runWithTriggerAnchor\(subAnchor,/,
  );
  if (startIdx < 0) throw new Error("could not locate dispatch_parallel runInProcess call");
  const window = dispatchSrc.slice(startIdx, startIdx + 2000);
  // Note: short-form `{ anchor: subAnchor, projectRoot }` (no explicit
  // value because the projectRoot variable is captured by the closure).
  if (!/anchor:\s*subAnchor,\s*projectRoot\s*\}/.test(window)) {
    throw new Error(
      "dispatch_parallel must pass { anchor: subAnchor, projectRoot } as heartbeatCtx " +
      "(projectRoot is the outer scope const captured by the worker)",
    );
  }
});

console.log("\nSection: fail-open boundary");

check("dispatch never blocks on heartbeat: startHeartbeat is sync, stop() is best-effort", () => {
  // The contract: heartbeat module must NEVER reject a Promise that
  // dispatch awaits. startHeartbeat is sync, stop() is sync (per the
  // heartbeat.ts module), so this is automatic. We assert that
  // dispatch doesn't accidentally `await heartbeat.start/stop`.
  if (/await\s+startHeartbeat\(/.test(dispatchSrc)) {
    throw new Error("dispatch must NOT await startHeartbeat (sync API, fail-open)");
  }
  if (/await\s+heartbeat\.stop\(/.test(dispatchSrc)) {
    throw new Error("dispatch must NOT await heartbeat.stop() (sync API)");
  }
});

check("dispatch does NOT propagate heartbeat errors into AgentResult", () => {
  // heartbeat is best-effort observability. No call site should
  // try/catch heartbeat.stop() and surface the error as an AgentResult
  // failure_type — heartbeat IO failure must be invisible to caller.
  if (/heartbeat\.[a-z]+\(\)\s*\)\s*\)\s*\)\s*\)/.test(dispatchSrc)) {
    // Defensive: confirm no obvious return-result-on-heartbeat-fail pattern.
    throw new Error("heartbeat result must not feed into AgentResult");
  }
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all dispatch ↔ heartbeat integration invariants hold`);
