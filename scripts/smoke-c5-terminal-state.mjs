#!/usr/bin/env node
/**
 * Smoke: ADR 0027 §C5 v1 terminal_state schema
 * (`extensions/dispatch/terminal-state.ts`).
 *
 * Validates the deterministic terminal_state mapping that the dispatch
 * audit writer relies on. This is the infra-layer prerequisite for any
 * future PR that opens L2 mutating production paths.
 *
 * Coverage:
 *   - inferTerminalState() correctly maps every FailureType to one of
 *     completed / failed / cancelled (never degraded for single task)
 *   - buildTerminalStateFields() produces ADR §C5 strict-scope fields:
 *       completed → terminal_state + resumable only
 *       failed    → terminal_state + reason + rollback_done + resumable
 *       cancelled → terminal_state + cancel_source + cleanup_done + resumable
 *       (degraded never produced single-task)
 *   - inferParallelTerminalState() aggregation rules:
 *       all ok                  → completed
 *       all cancelled           → cancelled (cancel_source resolved)
 *       partial (0<ok<N)        → degraded (what_dropped + alt_path + tasks_not_completed)
 *       0 ok with any failed    → failed (reason + tasks_not_completed)
 *       all failed              → failed (reason + tasks_not_completed)
 *   - cancelSource override path (ctx.cancelSource dominates heuristic)
 *   - empty input is degenerate failed
 *   - parent-abort override: ctx.cancelSource="user" propagates to aggregate
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

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

/** Structural deep-equality — order-independent for plain objects/arrays.
 *  Arrays are compared element-wise IN ORDER (intentional: tasks_not_completed
 *  and what_dropped have task ordering semantics). Objects are compared as
 *  unordered key sets. Primitives use === . */
function structEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!structEq(a[i], b[i])) return false;
    return true;
  }
  if (typeof a !== "object") return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
  for (const k of ak) if (!structEq(a[k], b[k])) return false;
  return true;
}

function assertEq(actual, expected, msg) {
  if (!structEq(actual, expected)) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    throw new Error(`${msg ?? "structural inequality"}\n        expected ${e}\n        got      ${a}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  }).outputText;
}

function loadCJS(code, fakePath) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  m._compile(code, fakePath);
  return m.exports;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c5-terminal-state-smoke-"));

const srcPath = path.join(repoRoot, "extensions/dispatch/terminal-state.ts");
const cjs = transpile(srcPath);
const cjsPath = path.join(tmpDir, "terminal-state.cjs");
fs.writeFileSync(cjsPath, cjs);
const mod = loadCJS(cjs, cjsPath);

const {
  inferTerminalState,
  buildTerminalStateFields,
  inferParallelTerminalState,
} = mod;

console.log("Section: inferTerminalState (single-task mapping)");

check("success result → completed", () => {
  assertEq(inferTerminalState({ output: "hello" }), "completed");
});

check("aborted → cancelled", () => {
  assertEq(
    inferTerminalState({ error: "aborted", failureType: "aborted" }),
    "cancelled",
  );
});

check("timeout → cancelled (timeout is external boundary)", () => {
  assertEq(
    inferTerminalState({ error: "timeout after 30000ms", failureType: "timeout" }),
    "cancelled",
  );
});

check("timeout_partial → cancelled (v1: no per-task SLA policy)", () => {
  assertEq(
    inferTerminalState({ error: "timeout (partial)", failureType: "timeout_partial", output: "some text" }),
    "cancelled",
  );
});

check("rate_limit → failed", () => {
  assertEq(
    inferTerminalState({ error: "rate limit", failureType: "rate_limit" }),
    "failed",
  );
});

check("network → failed", () => {
  assertEq(
    inferTerminalState({ error: "ECONNRESET", failureType: "network" }),
    "failed",
  );
});

check("server_error → failed", () => {
  assertEq(
    inferTerminalState({ error: "500 server error", failureType: "server_error" }),
    "failed",
  );
});

check("auth → failed", () => {
  assertEq(
    inferTerminalState({ error: "401 unauthorized", failureType: "auth" }),
    "failed",
  );
});

check("model_not_found → failed", () => {
  assertEq(
    inferTerminalState({ error: "not found", failureType: "model_not_found" }),
    "failed",
  );
});

check("tool_rejected → failed", () => {
  assertEq(
    inferTerminalState({ error: "rejected", failureType: "tool_rejected" }),
    "failed",
  );
});

check("agent_error → failed", () => {
  assertEq(
    inferTerminalState({ error: "agent error", failureType: "agent_error" }),
    "failed",
  );
});

check("retry_exhausted → failed", () => {
  assertEq(
    inferTerminalState({ error: "retries exhausted", failureType: "retry_exhausted" }),
    "failed",
  );
});

check("truncated → failed", () => {
  assertEq(
    inferTerminalState({ error: "truncated", failureType: "truncated" }),
    "failed",
  );
});

check("context_overflow → failed", () => {
  assertEq(
    inferTerminalState({ error: "context too long", failureType: "context_overflow" }),
    "failed",
  );
});

check("crash → failed", () => {
  assertEq(
    inferTerminalState({ error: "crash", failureType: "crash" }),
    "failed",
  );
});

check("error without failureType → failed (default branch)", () => {
  assertEq(
    inferTerminalState({ error: "unknown" }),
    "failed",
  );
});

console.log("\nSection: buildTerminalStateFields (ADR §C5 strict scope)");

check("completed: only terminal_state + resumable:false", () => {
  const f = buildTerminalStateFields({ output: "ok" });
  assertEq(f, { terminal_state: "completed", resumable: false });
});

check("failed: terminal_state + reason + rollback_done + resumable (no cleanup_done)", () => {
  const f = buildTerminalStateFields({ error: "boom", failureType: "agent_error" });
  assertEq(f, {
    terminal_state: "failed",
    reason: "boom",
    rollback_done: true,
    resumable: false,
  });
  // Verify cleanup_done is NOT present on failed (ADR strict scope)
  if ("cleanup_done" in f) {
    throw new Error(`failed must not carry cleanup_done (ADR §C5 strict scope); got ${JSON.stringify(f)}`);
  }
});

check("failed: reason is clipped at 500 chars", () => {
  const long = "x".repeat(600);
  const f = buildTerminalStateFields({ error: long, failureType: "agent_error" });
  if (typeof f.reason !== "string" || f.reason.length > 503) {
    throw new Error(`reason should be clipped; got length ${f.reason?.length}`);
  }
  if (!f.reason.endsWith("...")) {
    throw new Error(`clipped reason should end with '...'; got ${f.reason.slice(-10)}`);
  }
});

check("cancelled (timeout failureType) → cancel_source=timeout + cleanup_done", () => {
  const f = buildTerminalStateFields({ error: "t", failureType: "timeout" });
  assertEq(f, {
    terminal_state: "cancelled",
    cancel_source: "timeout",
    cleanup_done: true,
    resumable: false,
  });
});

check("cancelled (aborted failureType) → cancel_source=user + cleanup_done", () => {
  const f = buildTerminalStateFields({ error: "a", failureType: "aborted" });
  assertEq(f, {
    terminal_state: "cancelled",
    cancel_source: "user",
    cleanup_done: true,
    resumable: false,
  });
});

check("cancelled with explicit cancelSource=user override (parent signal)", () => {
  // dispatch sets this when ctx.signal.aborted fired but failureType is
  // timeout — the parent abort caused the timeout to win the race.
  const f = buildTerminalStateFields(
    { error: "t", failureType: "timeout" },
    { cancelSource: "user" },
  );
  assertEq(f, {
    terminal_state: "cancelled",
    cancel_source: "user",
    cleanup_done: true,
    resumable: false,
  });
});

console.log("\nSection: inferParallelTerminalState (aggregate)");

const ok = { output: "yes" };
const failed = { error: "boom", failureType: "agent_error" };
const cancelledTimeout = { error: "t", failureType: "timeout" };
const cancelledAbort = { error: "a", failureType: "aborted" };

check("all 3 ok → completed (no tasks_not_completed)", () => {
  const r = inferParallelTerminalState([
    { result: ok, label: "modelA" },
    { result: ok, label: "modelB" },
    { result: ok, label: "modelC" },
  ]);
  assertEq(r, { terminal_state: "completed", resumable: false });
});

check("2 ok / 1 failed → degraded with what_dropped + alt_path + tasks_not_completed", () => {
  const r = inferParallelTerminalState([
    { result: ok, label: "modelA" },
    { result: failed, label: "modelB" },
    { result: ok, label: "modelC" },
  ]);
  assertEq(r, {
    terminal_state: "degraded",
    what_dropped: ["modelB"],
    alt_path: "use 2/3 task results",
    cleanup_done: true,
    tasks_not_completed: ["modelB"],
    resumable: false,
  });
});

check("1 ok / 2 failed → degraded (1/3 is still some success)", () => {
  const r = inferParallelTerminalState([
    { result: failed, label: "modelA" },
    { result: ok, label: "modelB" },
    { result: failed, label: "modelC" },
  ]);
  assertEq(r, {
    terminal_state: "degraded",
    what_dropped: ["modelA", "modelC"],
    alt_path: "use 1/3 task results",
    cleanup_done: true,
    tasks_not_completed: ["modelA", "modelC"],
    resumable: false,
  });
});

check("all 3 failed → failed with reason + tasks_not_completed (no what_dropped, no cleanup_done)", () => {
  const r = inferParallelTerminalState([
    { result: failed, label: "modelA" },
    { result: failed, label: "modelB" },
    { result: failed, label: "modelC" },
  ]);
  // Schema: failed must have terminal_state + reason + rollback_done +
  // tasks_not_completed (aggregate ext) + resumable. NOT what_dropped
  // (that's degraded-only per ADR strict scope). NOT cleanup_done.
  if (r.terminal_state !== "failed") {
    throw new Error(`expected failed, got ${r.terminal_state}`);
  }
  if (r.rollback_done !== true) {
    throw new Error(`failed must have rollback_done:true`);
  }
  if (typeof r.reason !== "string" || !r.reason.includes("aggregate failed")) {
    throw new Error(`failed must have aggregate reason; got ${r.reason}`);
  }
  if ("what_dropped" in r) {
    throw new Error(`failed aggregate must NOT carry what_dropped (degraded-only per ADR)`);
  }
  if ("cleanup_done" in r) {
    throw new Error(`failed aggregate must NOT carry cleanup_done (ADR strict scope)`);
  }
  assertEq(r.tasks_not_completed, ["modelA", "modelB", "modelC"]);
});

check("all cancelled (timeout) → cancelled + cancel_source=timeout + tasks_not_completed", () => {
  const r = inferParallelTerminalState([
    { result: cancelledTimeout, label: "modelA" },
    { result: cancelledTimeout, label: "modelB" },
  ]);
  assertEq(r, {
    terminal_state: "cancelled",
    cancel_source: "timeout",
    cleanup_done: true,
    tasks_not_completed: ["modelA", "modelB"],
    resumable: false,
  });
});

check("all cancelled (user abort) → cancelled + cancel_source=user", () => {
  const r = inferParallelTerminalState([
    { result: cancelledAbort, label: "modelA" },
    { result: cancelledAbort, label: "modelB" },
  ]);
  assertEq(r, {
    terminal_state: "cancelled",
    cancel_source: "user",
    cleanup_done: true,
    tasks_not_completed: ["modelA", "modelB"],
    resumable: false,
  });
});

check("0 ok, 1 failed + 1 cancelled → failed (conservative)", () => {
  // Conservative aggregate: any real failure dominates a cancellation.
  const r = inferParallelTerminalState([
    { result: failed, label: "modelA" },
    { result: cancelledTimeout, label: "modelB" },
  ]);
  if (r.terminal_state !== "failed") {
    throw new Error(`expected failed (conservative), got ${r.terminal_state}`);
  }
  assertEq(r.tasks_not_completed, ["modelA", "modelB"]);
  if (typeof r.reason !== "string") {
    throw new Error(`expected failed aggregate to carry reason`);
  }
});

check("0 tasks (degenerate) → failed with reason", () => {
  const r = inferParallelTerminalState([]);
  if (r.terminal_state !== "failed") {
    throw new Error(`expected failed for empty input`);
  }
  if (typeof r.reason !== "string" || !r.reason.includes("degenerate")) {
    throw new Error(`expected degenerate reason; got ${r.reason}`);
  }
  if (r.rollback_done !== true) {
    throw new Error(`expected rollback_done:true on degenerate failed`);
  }
});

check("partial cancelled + ok → degraded (cancelled tasks count as dropped)", () => {
  const r = inferParallelTerminalState([
    { result: ok, label: "modelA" },
    { result: cancelledTimeout, label: "modelB" },
  ]);
  assertEq(r, {
    terminal_state: "degraded",
    what_dropped: ["modelB"],
    alt_path: "use 1/2 task results",
    cleanup_done: true,
    tasks_not_completed: ["modelB"],
    resumable: false,
  });
});

console.log("\nSection: aggregate cancelSource override (R6 P1-2 fix)");

check("aggregate ctx.cancelSource=user overrides per-task heuristic", () => {
  // Parent abort fires; per-task happens to all be timeout. Without
  // override, aggregate would say cancel_source=timeout (heuristic).
  // With override, cancel_source=user wins (parent-signal dominates).
  const r = inferParallelTerminalState(
    [
      { result: cancelledTimeout, label: "modelA" },
      { result: cancelledTimeout, label: "modelB" },
    ],
    { cancelSource: "user" },
  );
  assertEq(r.cancel_source, "user");
});

check("aggregate cancel_source=user when ANY task carries aborted (mixed)", () => {
  // Mixed: one timeout, one user abort. No ctx override. Aggregate
  // should prefer "user" because the user signal is the dominant cause.
  const r = inferParallelTerminalState([
    { result: cancelledTimeout, label: "modelA" },
    { result: cancelledAbort, label: "modelB" },
  ]);
  assertEq(r.cancel_source, "user");
});

console.log("\nSection: schema invariants");

check("v1 always sets resumable:false (never undefined or true)", () => {
  const states = [
    buildTerminalStateFields({ output: "ok" }),
    buildTerminalStateFields({ error: "x", failureType: "agent_error" }),
    buildTerminalStateFields({ error: "t", failureType: "timeout" }),
    inferParallelTerminalState([{ result: ok, label: "x" }]),
    inferParallelTerminalState([{ result: failed, label: "x" }]),
    inferParallelTerminalState([{ result: ok, label: "a" }, { result: failed, label: "b" }]),
  ];
  for (const s of states) {
    if (s.resumable !== false) {
      throw new Error(`expected resumable:false everywhere in v1, got ${JSON.stringify(s)}`);
    }
  }
});

check("ADR strict scope: failed never has cleanup_done or what_dropped", () => {
  const failedStates = [
    buildTerminalStateFields({ error: "x", failureType: "agent_error" }),
    buildTerminalStateFields({ error: "x", failureType: "rate_limit" }),
    inferParallelTerminalState([{ result: failed, label: "x" }]),
    inferParallelTerminalState([]),
  ];
  for (const s of failedStates) {
    if (s.terminal_state !== "failed") continue;
    if ("cleanup_done" in s) {
      throw new Error(`failed must not carry cleanup_done: ${JSON.stringify(s)}`);
    }
    if ("what_dropped" in s) {
      throw new Error(`failed must not carry what_dropped (degraded-only): ${JSON.stringify(s)}`);
    }
  }
});

check("ADR strict scope: cancelled never has reason or what_dropped or rollback_done", () => {
  const cancelledStates = [
    buildTerminalStateFields({ error: "t", failureType: "timeout" }),
    buildTerminalStateFields({ error: "a", failureType: "aborted" }),
    inferParallelTerminalState([{ result: cancelledTimeout, label: "x" }]),
  ];
  for (const s of cancelledStates) {
    if (s.terminal_state !== "cancelled") continue;
    if ("reason" in s) {
      throw new Error(`cancelled must not carry reason (ADR scope: failed-only): ${JSON.stringify(s)}`);
    }
    if ("what_dropped" in s) {
      throw new Error(`cancelled must not carry what_dropped (degraded-only): ${JSON.stringify(s)}`);
    }
    if ("rollback_done" in s) {
      throw new Error(`cancelled must not carry rollback_done (failed-only): ${JSON.stringify(s)}`);
    }
    if (!s.cancel_source) {
      throw new Error(`cancelled missing cancel_source: ${JSON.stringify(s)}`);
    }
  }
});

check("ADR strict scope: degraded has what_dropped + alt_path; never has reason or rollback_done", () => {
  const r = inferParallelTerminalState([
    { result: ok, label: "a" },
    { result: failed, label: "b" },
  ]);
  if (r.terminal_state !== "degraded") {
    throw new Error(`expected degraded, got ${r.terminal_state}`);
  }
  if (!Array.isArray(r.what_dropped) || r.what_dropped.length === 0) {
    throw new Error(`degraded missing what_dropped: ${JSON.stringify(r)}`);
  }
  if (typeof r.alt_path !== "string" || r.alt_path.length === 0) {
    throw new Error(`degraded missing alt_path: ${JSON.stringify(r)}`);
  }
  if ("reason" in r) {
    throw new Error(`degraded must not carry reason (failed-only)`);
  }
  if ("rollback_done" in r) {
    throw new Error(`degraded must not carry rollback_done (failed-only)`);
  }
});

check("ADR aggregate ext: cancelled/failed/degraded all carry tasks_not_completed", () => {
  const cases = [
    inferParallelTerminalState([{ result: failed, label: "x" }, { result: failed, label: "y" }]),
    inferParallelTerminalState([{ result: cancelledTimeout, label: "x" }]),
    inferParallelTerminalState([{ result: ok, label: "a" }, { result: failed, label: "b" }]),
  ];
  for (const s of cases) {
    if (!Array.isArray(s.tasks_not_completed)) {
      throw new Error(`expected tasks_not_completed array; got ${JSON.stringify(s)}`);
    }
  }
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all smoke checks passed`);
