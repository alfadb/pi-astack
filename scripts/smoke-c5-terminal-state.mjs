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
 *   - buildTerminalStateFields() produces the right side-effect fields
 *     for each terminal_state
 *   - inferParallelTerminalState() aggregation rules:
 *       all ok                  → completed
 *       all cancelled           → cancelled (cancel_source preserved)
 *       partial (0<ok<N)        → degraded (what_dropped + alt_path)
 *       0 ok with any failed    → failed
 *       all failed              → failed
 *   - cancelSource override path
 *   - empty input is degenerate failed
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

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg}\n        expected ${e}\n        got      ${a}`);
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

console.log("\nSection: buildTerminalStateFields (single-task side effects)");

check("completed: only resumable:false", () => {
  const f = buildTerminalStateFields({ output: "ok" });
  assertEq(f, { terminal_state: "completed", resumable: false });
});

check("failed: rollback_done + cleanup_done + resumable", () => {
  const f = buildTerminalStateFields({ error: "x", failureType: "agent_error" });
  assertEq(f, {
    terminal_state: "failed",
    rollback_done: true,
    cleanup_done: true,
    resumable: false,
  });
});

check("cancelled (timeout failureType) → cancel_source=timeout", () => {
  const f = buildTerminalStateFields({ error: "t", failureType: "timeout" });
  assertEq(f, {
    terminal_state: "cancelled",
    cancel_source: "timeout",
    cleanup_done: true,
    resumable: false,
  });
});

check("cancelled (aborted failureType) → cancel_source=user", () => {
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

check("all 3 ok → completed", () => {
  const r = inferParallelTerminalState([
    { result: ok, label: "modelA" },
    { result: ok, label: "modelB" },
    { result: ok, label: "modelC" },
  ]);
  assertEq(r, { terminal_state: "completed", resumable: false });
});

check("2 ok / 1 failed → degraded with what_dropped + alt_path", () => {
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
    resumable: false,
  });
});

check("all 3 failed → failed", () => {
  const r = inferParallelTerminalState([
    { result: failed, label: "modelA" },
    { result: failed, label: "modelB" },
    { result: failed, label: "modelC" },
  ]);
  assertEq(r, {
    terminal_state: "failed",
    rollback_done: true,
    cleanup_done: true,
    what_dropped: ["modelA", "modelB", "modelC"],
    resumable: false,
  });
});

check("all cancelled (timeout) → cancelled, cancel_source=timeout", () => {
  const r = inferParallelTerminalState([
    { result: cancelledTimeout, label: "modelA" },
    { result: cancelledTimeout, label: "modelB" },
  ]);
  assertEq(r, {
    terminal_state: "cancelled",
    cancel_source: "timeout",
    cleanup_done: true,
    what_dropped: ["modelA", "modelB"],
    resumable: false,
  });
});

check("all cancelled (user abort) → cancelled, cancel_source=user", () => {
  const r = inferParallelTerminalState([
    { result: cancelledAbort, label: "modelA" },
    { result: cancelledAbort, label: "modelB" },
  ]);
  assertEq(r, {
    terminal_state: "cancelled",
    cancel_source: "user",
    cleanup_done: true,
    what_dropped: ["modelA", "modelB"],
    resumable: false,
  });
});

check("0 ok, 1 failed + 1 cancelled → failed (conservative)", () => {
  // Conservative aggregate: any real failure dominates a cancellation.
  // Protects against masking real failures behind a cancellation that
  // happened to coincide.
  const r = inferParallelTerminalState([
    { result: failed, label: "modelA" },
    { result: cancelledTimeout, label: "modelB" },
  ]);
  assertEq(r, {
    terminal_state: "failed",
    rollback_done: true,
    cleanup_done: true,
    what_dropped: ["modelA", "modelB"],
    resumable: false,
  });
});

check("0 tasks (degenerate) → failed", () => {
  const r = inferParallelTerminalState([]);
  assertEq(r, {
    terminal_state: "failed",
    rollback_done: true,
    cleanup_done: true,
    resumable: false,
  });
});

check("partial cancelled + ok → degraded (cancelled tasks count as dropped)", () => {
  // 1 ok, 1 cancelled (not failed) — still partial success → degraded
  const r = inferParallelTerminalState([
    { result: ok, label: "modelA" },
    { result: cancelledTimeout, label: "modelB" },
  ]);
  assertEq(r, {
    terminal_state: "degraded",
    what_dropped: ["modelB"],
    alt_path: "use 1/2 task results",
    cleanup_done: true,
    resumable: false,
  });
});

console.log("\nSection: schema invariants");

check("v1 always sets resumable:false (never undefined or true)", () => {
  // Spot-check all the variants
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

check("failed paths always carry rollback_done:true (v1 read-only dispatch)", () => {
  const failedStates = [
    buildTerminalStateFields({ error: "x", failureType: "agent_error" }),
    buildTerminalStateFields({ error: "x", failureType: "rate_limit" }),
    inferParallelTerminalState([{ result: failed, label: "x" }]),
  ];
  for (const s of failedStates) {
    if (s.terminal_state === "failed" && s.rollback_done !== true) {
      throw new Error(`failed state missing rollback_done:true: ${JSON.stringify(s)}`);
    }
  }
});

check("cancelled paths always carry cancel_source", () => {
  const cancelledStates = [
    buildTerminalStateFields({ error: "t", failureType: "timeout" }),
    buildTerminalStateFields({ error: "a", failureType: "aborted" }),
    inferParallelTerminalState([
      { result: cancelledTimeout, label: "x" },
    ]),
  ];
  for (const s of cancelledStates) {
    if (s.terminal_state !== "cancelled") continue;
    if (!s.cancel_source) {
      throw new Error(`cancelled state missing cancel_source: ${JSON.stringify(s)}`);
    }
  }
});

check("degraded paths always carry what_dropped + alt_path", () => {
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
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all ${process.stdout.columns ? "" : ""}smoke checks passed`);
