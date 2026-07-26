#!/usr/bin/env node
/**
 * Smoke: bounded tool-run snapshot + terminal attribution helpers.
 *
 * Covers:
 *   - concurrent tools (ending A does not erase still-running B)
 *   - start / update / end lifecycle
 *   - bounded map (MAX_TRACKED_TOOL_RUNS)
 *   - audit projection has only safe keys (no args/output/prompt)
 *   - heartbeat is not a tool (tracker only accepts tool_execution_*)
 *   - enrichResultAttribution evidence-first mapping
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-run-snapshot-smoke-"));

const snapPath = path.join(repoRoot, "extensions/dispatch/tool-run-snapshot.ts");
const snapCjs = transpile(snapPath);
const snapMod = loadCJS(snapCjs, path.join(tmpDir, "tool-run-snapshot.cjs"));
const {
  ToolRunTracker,
  toolSnapshotAuditFields,
  toolSnapshotDetailsFields,
  MAX_TRACKED_TOOL_RUNS,
} = snapMod;

const tsPath = path.join(repoRoot, "extensions/dispatch/terminal-state.ts");
const tsMod = loadCJS(transpile(tsPath), path.join(tmpDir, "terminal-state.cjs"));
const { buildTerminalStateFields, resolveTerminationSource } = tsMod;

console.log("Section: concurrent tool snapshot");

check("start two tools → active_count=2; end one → active_count=1; other remains", () => {
  const t = new ToolRunTracker();
  const t0 = 1_000_000;
  t.onStart("bash", "call-a", t0);
  t.onStart("read", "call-b", t0 + 10);
  let snap = t.snapshot(t0 + 20);
  assert(snap.active_count === 2, `expected 2 active, got ${snap.active_count}`);
  assert(snap.active.some((x) => x.tool_call_id === "call-a"), "missing call-a");
  assert(snap.active.some((x) => x.tool_call_id === "call-b"), "missing call-b");
  t.onEnd("bash", "call-a", false, t0 + 30);
  snap = t.snapshot(t0 + 40);
  assert(snap.active_count === 1, `expected 1 active after end A, got ${snap.active_count}`);
  assert(snap.active[0].tool_call_id === "call-b", "still-running B must remain");
  assert(snap.last.tool_call_id === "call-a", "last should be most recently touched (A end)");
  assert(snap.last.status === "completed", `last status completed, got ${snap.last.status}`);
});

check("update touches last_update_at without storing payload", () => {
  const t = new ToolRunTracker();
  const t0 = 2_000_000;
  t.onStart("bash", "c1", t0);
  t.onUpdate("bash", "c1", t0 + 500);
  // Pass attacker-controlled junk as toolName only affects name if unknown.
  t.onUpdate({ evil: true }, "c1", t0 + 800);
  const snap = t.snapshot(t0 + 900);
  assert(snap.last.last_update_at, "last_update_at required after update");
  const raw = JSON.stringify(snap);
  assert(!raw.includes("evil"), "must not store attacker-controlled fields");
  assert(!raw.includes("partialResult"), "must not store partialResult");
  assert(!raw.includes("args"), "must not store args key");
});

check("age_ms is progress age (now - last_update), not total runtime", () => {
  // Non-coincidental timestamps: start/update/end/now all distinct so
  // started→now, started→end, and now→last_update cannot collapse.
  const t = new ToolRunTracker();
  const t0 = 5_000_000;

  // Running, no update yet: age ≈ idle since start.
  t.onStart("bash", "prog-a", t0);
  let snap = t.snapshot(t0 + 700);
  assert(snap.last.status === "running", "running before update");
  assert(snap.last.age_ms === 700, `running no-update age=700, got ${snap.last.age_ms}`);
  assert(snap.last.started_at, "started_at kept");
  assert(snap.last.last_update_at, "last_update_at present while running");
  // Must NOT be total runtime-only coincidence with a different definition.
  assert(snap.last.age_ms !== 0, "idle running age must not be zero");

  // Just after update: progress age ≈ 0 relative to snapshot close to update.
  t.onUpdate("bash", "prog-a", t0 + 1_200);
  snap = t.snapshot(t0 + 1_205);
  assert(snap.last.age_ms === 5, `post-update age=5, got ${snap.last.age_ms}`);
  // If age were total runtime (now-start) it would be 1205 — reject that.
  assert(snap.last.age_ms !== 1_205, "age_ms must not be total runtime after update");
  assert(snap.last.age_ms !== 1_200, "age_ms must not be update-start delta");

  // Later snapshot without further update: age grows from last_update only.
  snap = t.snapshot(t0 + 1_500);
  assert(snap.last.age_ms === 300, `stale-running age=300, got ${snap.last.age_ms}`);

  // Completed: last_update advances to end; age is now-end, not end-start.
  t.onEnd("bash", "prog-a", false, t0 + 2_000);
  snap = t.snapshot(t0 + 2_450);
  assert(snap.last.status === "completed", `completed, got ${snap.last.status}`);
  assert(snap.last.completed_at, "completed_at set on end");
  assert(snap.last.age_ms === 450, `completed progress age=450, got ${snap.last.age_ms}`);
  // Total runtime would be 2450 (now-start) or 2000 (end-start) — both wrong.
  assert(snap.last.age_ms !== 2_450, "completed age_ms must not be now-start");
  assert(snap.last.age_ms !== 2_000, "completed age_ms must not be end-start total runtime");
});

check("end with isError → status=error; age_ms from last_update (end)", () => {
  const t = new ToolRunTracker();
  // start=10, end=20, snapshot=55 → progress age=35 (not total runtime 10 or 45).
  t.onStart("edit", "e1", 10);
  t.onEnd("edit", "e1", true, 20);
  const snap = t.snapshot(55);
  assert(snap.last.status === "error", `expected error, got ${snap.last.status}`);
  assert(snap.last.completed_at, "completed_at set on end");
  assert(snap.last.age_ms === 35, `age_ms=35 (55-20), got ${snap.last.age_ms}`);
  assert(snap.last.age_ms !== 10, "must not use completed-start total runtime");
  assert(snap.last.age_ms !== 45, "must not use now-start total runtime");
});

check("map is bounded at MAX_TRACKED_TOOL_RUNS; constructor force-caps to 32", () => {
  const t = new ToolRunTracker(4);
  for (let i = 0; i < 12; i++) {
    t.onStart(`tool${i}`, `id-${i}`, i * 10);
    if (i % 2 === 0) t.onEnd(`tool${i}`, `id-${i}`, false, i * 10 + 5);
  }
  const snap = t.snapshot(10_000);
  // Active running entries alone cannot exceed max; total tracked is internal.
  assert(snap.active_count <= 4, `active_count ${snap.active_count} exceeds cap`);
  assert(MAX_TRACKED_TOOL_RUNS === 32, `default cap is 32, got ${MAX_TRACKED_TOOL_RUNS}`);

  // Constructor argument above hard cap is force-capped to 32.
  const oversized = new ToolRunTracker(999);
  for (let i = 0; i < 40; i++) oversized.onStart(`t${i}`, `cap-${i}`, i);
  const full = oversized.snapshot(1000);
  assert(full.active_count <= 32, `force-cap active_count ${full.active_count}`);
});

check("missing toolCallId / orphan update+end are ignored; running never evicted", () => {
  const t = new ToolRunTracker(2);
  t.onStart("bash", "keep-a", 1);
  t.onStart("read", "keep-b", 2);
  // Missing / empty ids ignored
  t.onStart("evil", "", 3);
  t.onStart("evil", null, 4);
  t.onUpdate("evil", undefined, 5);
  t.onEnd("evil", "", false, 6);
  // Orphan update/end without start ignored
  t.onUpdate("orphan", "no-start", 7);
  t.onEnd("orphan", "no-start", false, 8);
  let snap = t.snapshot(10);
  assert(snap.active_count === 2, `expected 2 running, got ${snap.active_count}`);
  assert(snap.active.every((x) => x.tool_call_id === "keep-a" || x.tool_call_id === "keep-b"), "running set corrupted");

  // Capacity full of running: new start dropped, not evicting keep-a/keep-b
  t.onStart("dropme", "keep-c", 11);
  snap = t.snapshot(12);
  assert(snap.active_count === 2, `must not grow past cap by evicting running: ${snap.active_count}`);
  assert(!snap.active.some((x) => x.tool_call_id === "keep-c"), "new start must be dropped when full of running");
  assert(snap.active.some((x) => x.tool_call_id === "keep-a"), "keep-a must remain");
  assert(snap.active.some((x) => x.tool_call_id === "keep-b"), "keep-b must remain");

  // After one finishes, a new start may reclaim the finished slot
  t.onEnd("bash", "keep-a", false, 13);
  t.onStart("new", "keep-c", 14);
  snap = t.snapshot(15);
  assert(snap.active.some((x) => x.tool_call_id === "keep-c"), "new start after free slot");
  assert(snap.active.some((x) => x.tool_call_id === "keep-b"), "keep-b still running");
  assert(snap.active_count === 2, `active after reclaim: ${snap.active_count}`);
});

check("duplicate toolCallId start replaces in place", () => {
  const t = new ToolRunTracker();
  t.onStart("bash", "dup", 1);
  t.onStart("read", "dup", 5);
  const snap = t.snapshot(10);
  assert(snap.active_count === 1, "one slot for duplicate id");
  assert(snap.last.tool_name === "read", `replaced name, got ${snap.last.tool_name}`);
  assert(snap.last.tool_call_id === "dup", "same id");
});

check("audit fields only allowlisted keys", () => {
  const t = new ToolRunTracker();
  t.onStart("bash", "x", 1);
  t.onUpdate("bash", "x", 2);
  const fields = toolSnapshotAuditFields(t.snapshot(3));
  assert(typeof fields.active_tool_count === "number", "active_tool_count");
  assert(fields.last_tool, "last_tool");
  const keys = Object.keys(fields.last_tool).sort();
  for (const k of keys) {
    assert(
      ["tool_name", "tool_call_id", "status", "started_at", "last_update_at", "completed_at", "age_ms"].includes(k),
      `unexpected last_tool key: ${k}`,
    );
  }
  const details = toolSnapshotDetailsFields(t.snapshot(3));
  assert(details.lastTool.toolName === "bash", "details camelCase toolName");
  assert(!JSON.stringify(details).includes("command"), "no command field");
});

check("heartbeat is not a tool — empty tracker until tool_execution_*", () => {
  const t = new ToolRunTracker();
  // Simulate only heartbeat/progress: no onStart calls.
  const snap = t.snapshot();
  assert(snap.active_count === 0, "no active tools");
  assert(snap.last === undefined, "no last tool without tool events");
});

console.log("\nSection: timeout terminal fields include last_tool safe metadata");

check("timeout terminal build carries termination_source=timeout", () => {
  const f = buildTerminalStateFields({
    error: "idle timeout",
    failureType: "timeout",
    timeoutKind: "idle",
    lastProgressReason: "event:tool_execution_start",
  });
  assert(f.terminal_state === "cancelled", f.terminal_state);
  assert(f.cancel_source === "timeout", f.cancel_source);
  assert(f.termination_source === "timeout", f.termination_source);
});

check("provider/stream/guardrail/unknown classification matrix", () => {
  assert(resolveTerminationSource({ error: "e", failureType: "auth" }) === "provider");
  // stopReason alone never proves stream (SDK has "aborted", not "abort").
  assert(resolveTerminationSource({ error: "e", failureType: "truncated", stopReason: "abort" }) === "provider");
  assert(resolveTerminationSource({ error: "e", failureType: "truncated", stopReason: "aborted" }) === "provider");
  assert(
    resolveTerminationSource(
      { error: "e", failureType: "truncated", stopReason: "aborted" },
      { abortEvidence: "stream" },
    ) === "stream",
  );
  assert(resolveTerminationSource({ error: "e", failureType: "guardrail_stop" }) === "guardrail");
  assert(resolveTerminationSource({ error: "Request aborted", failureType: "crash" }) === "unknown");
  assert(resolveTerminationSource({ error: "e", failureType: "repetitive_output" }) === "worker_run_governor");
  assert(resolveTerminationSource({ error: "e", failureType: "model_not_found" }) === "unknown");
});

// Source-level: index.ts must not pass event.args into ToolRunTracker.
const indexSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf8");
check("toolTracker never receives event.args or partialResult", () => {
  const start = indexSrc.match(/toolTracker\.onStart\([^)]+\)/)?.[0] ?? "";
  const update = indexSrc.match(/toolTracker\.onUpdate\([^)]+\)/)?.[0] ?? "";
  const end = indexSrc.match(/toolTracker\.onEnd\([^)]+\)/)?.[0] ?? "";
  assert(start.includes("toolName") && start.includes("toolCallId"), `onStart shape: ${start}`);
  assert(!start.includes("args"), "onStart must not pass args");
  assert(!update.includes("partialResult") && !update.includes("args"), "onUpdate must not pass payload");
  assert(end.includes("isError"), `onEnd shape: ${end}`);
});

check("runInProcess classifies resolved stopReason=aborted via pure helpers (not stream)", () => {
  assert(/isResolvedAbortStopReason\(stopReason\)/.test(indexSrc), "must call isResolvedAbortStopReason");
  assert(/agentResultFromResolvedAbort\(/.test(indexSrc), "must call agentResultFromResolvedAbort");
  // Ordering: aborted judgment must precede agentReportedError so errorMessage
  // cannot reclassify lifecycle abort as agent_error/stream.
  const abortIdx = indexSrc.indexOf("isResolvedAbortStopReason(stopReason)");
  const agentErrIdx = indexSrc.indexOf("const agentReportedError");
  assert(abortIdx > 0 && agentErrIdx > abortIdx, "aborted check must precede agentReportedError");
  // Must not map stopReason aborted to truncated/stream in the resolve path.
  const resolveWindow = indexSrc.slice(
    indexSrc.indexOf("// Truncation: max-tokens"),
    indexSrc.indexOf("return {\n        output: finalOutput || \"(no output)\""),
  );
  assert(!/failureType:\s*\"truncated\"[\s\S]{0,80}aborted/.test(resolveWindow)
    || /must NOT be auto-classified as stream\/truncated/.test(resolveWindow),
    "resolved aborted must not be truncated/stream");
});

// Executable pure-path: resolved abort result → settlement attribution.
// Prefer jiti import of pure helpers over regex-only self-proof.
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const dispatch = await jiti.import(path.join(repoRoot, "extensions/dispatch/index.ts"));
const {
  agentResultFromResolvedAbort,
  isResolvedAbortStopReason,
  enrichResultAttribution,
} = dispatch;
const { abortEvidenceFromSignal: abortFromSignal } = tsMod;

console.log("\nSection: resolved stopReason=aborted pure settlement path");

check("isResolvedAbortStopReason only accepts SDK aborted token", () => {
  assert(isResolvedAbortStopReason("aborted") === true, "aborted");
  assert(isResolvedAbortStopReason("abort") === false, "abort is not SDK token");
  assert(isResolvedAbortStopReason("stop") === false, "stop");
  assert(isResolvedAbortStopReason(undefined) === false, "undefined");
});

check("agentResultFromResolvedAbort keeps partial + error + failureType aborted + stopReason", () => {
  const r = agentResultFromResolvedAbort({
    output: "partial text",
    errorMessage: "",
    durationMs: 42,
    toolCallCount: 2,
  });
  assert(r.output === "partial text", r.output);
  assert(r.error === "aborted", r.error);
  assert(r.failureType === "aborted", r.failureType);
  assert(r.stopReason === "aborted", r.stopReason);
  assert(r.durationMs === 42 && r.toolCallCount === 2, JSON.stringify(r));
  // Never stream/truncated from this pure path.
  assert(r.failureType !== "truncated", "must not be truncated");
});

check("settlement: parent AbortSignal no reason → cancelled/parent", () => {
  const bare = agentResultFromResolvedAbort({ output: "x", durationMs: 1 });
  const ctl = new AbortController();
  ctl.abort(); // no reason
  const evidence = abortFromSignal(ctl.signal);
  assert(evidence === "parent", `evidence=${evidence}`);
  const settled = enrichResultAttribution(bare, { abortEvidence: evidence });
  const fields = buildTerminalStateFields(settled, { abortEvidence: evidence });
  assert(fields.terminal_state === "cancelled", fields.terminal_state);
  assert(fields.cancel_source === "parent", fields.cancel_source);
  assert(fields.termination_source === "parent", fields.termination_source);
  assert(settled.failureType === "aborted" && settled.stopReason === "aborted", JSON.stringify(settled));
});

check("settlement: no lifecycle owner → cancelled/unknown", () => {
  const bare = agentResultFromResolvedAbort({
    output: "partial",
    errorMessage: "session aborted",
    durationMs: 3,
  });
  const settled = enrichResultAttribution(bare, {} /* no abortEvidence */);
  const fields = buildTerminalStateFields(settled);
  assert(fields.terminal_state === "cancelled", fields.terminal_state);
  assert(fields.cancel_source === "unknown", fields.cancel_source);
  assert(fields.termination_source === "unknown", fields.termination_source);
  assert(settled.error === "session aborted", settled.error);
  // stopReason alone never invents stream.
  assert(settled.terminationSource !== "stream", settled.terminationSource);
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all smoke checks passed`);
