#!/usr/bin/env node
/**
 * Smoke: ADR 0027 §C2' v1 Stage 1b heartbeat writer
 *
 * Locks the heartbeat writer invariants on the standalone module so
 * regressions surface independent of the dispatch integration smoke
 * (which is grep-based and structural). This smoke runs the actual
 * writer code in-process — no LLM, no dispatch, just file IO.
 *
 * Coverage:
 *   - heartbeatTracePath constructs deterministic per-anchor path
 *   - subturn defaults to 0 when absent (main-session dispatches)
 *   - startHeartbeat with undefined anchor returns NO_OP (fail-open)
 *   - startHeartbeat writes initial "started" beat immediately
 *   - periodic timer writes "alive" beats at interval
 *   - beat() injects out-of-band phase transitions
 *   - stop() writes final "stopping" beat then unlinks file
 *   - stop() is idempotent (no double-stopping beat)
 *   - readHeartbeatTrace parses + tolerates partial lines
 *   - duplicate start for same anchor returns existing handle (no
 *     double-writer race)
 *   - cross-jiti singleton (handle registry on globalThis)
 *   - tracePath property exposes resolved path for diagnostics
 *   - C6 anchor fields are carried in every beat
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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
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

function loadCJS(code, fakePath, stubMap) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  const origLoad = Module._load;
  if (stubMap) {
    Module._load = function patched(request, parent, ...rest) {
      if (stubMap.has(request)) return stubMap.get(request);
      return origLoad.call(this, request, parent, ...rest);
    };
  }
  try {
    m._compile(code, fakePath);
  } finally {
    if (stubMap) Module._load = origLoad;
  }
  return m.exports;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c5-heartbeat-smoke-"));

// Stub `./causal-anchor` — heartbeat imports spreadAnchor + CausalAnchor.
// We hand-craft a minimal spreadAnchor that mirrors the real one.
const causalAnchorStub = {
  spreadAnchor: (a) => {
    if (!a) return {};
    const out = { session_id: a.session_id, turn_id: a.turn_id };
    if (a.subturn !== undefined) out.subturn = a.subturn;
    if (a.sub_agent_label) out.sub_agent_label = a.sub_agent_label;
    if (a.device_id) out.device_id = a.device_id;
    return out;
  },
};

const heartbeatSrc = path.join(repoRoot, "extensions/_shared/heartbeat.ts");
const heartbeatCjs = transpile(heartbeatSrc);
const heartbeatPath = path.join(tmpDir, "heartbeat.cjs");
fs.writeFileSync(heartbeatPath, heartbeatCjs);
const mod = loadCJS(
  heartbeatCjs,
  heartbeatPath,
  new Map([["./causal-anchor", causalAnchorStub]]),
);

const {
  startHeartbeat,
  heartbeatTracePath,
  heartbeatTracePathsForAnchor,
  readHeartbeatTrace,
  _resetHeartbeatRegistryForTests,
} = mod;

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c5-heartbeat-root-"));

console.log("Section: heartbeatTracePath");

check("path follows ${session_id}_${turn_id}_${subturn}_${pid}.jsonl pattern", () => {
  const p = heartbeatTracePath(testRoot, {
    session_id: "sess-abc",
    turn_id: 5,
    subturn: 2,
  });
  if (!p.endsWith(path.join(".pi-astack", "dispatch", "heartbeat", `sess-abc_5_2_${process.pid}.jsonl`))) {
    throw new Error(`unexpected path: ${p}`);
  }
});

check("path defaults subturn to 0 when absent", () => {
  const p = heartbeatTracePath(testRoot, {
    session_id: "sess-abc",
    turn_id: 5,
  });
  if (!p.endsWith(`sess-abc_5_0_${process.pid}.jsonl`)) {
    throw new Error(`expected subturn=0 + pid suffix; got ${p}`);
  }
});

check("candidate paths include pid-suffixed path plus legacy fallback", () => {
  const anchor = { session_id: "sess-candidates", turn_id: 8 };
  const paths = heartbeatTracePathsForAnchor(testRoot, anchor);
  const current = heartbeatTracePath(testRoot, anchor);
  const legacy = path.join(testRoot, ".pi-astack", "dispatch", "heartbeat", "sess-candidates_8_0.jsonl");
  if (paths[0] !== current) throw new Error(`current pid path should be first: ${JSON.stringify(paths)}`);
  if (!paths.includes(legacy)) throw new Error(`legacy fallback missing: ${JSON.stringify(paths)}`);
});

console.log("\nSection: startHeartbeat fail-open paths");

check("undefined anchor → no-op handle (no IO)", () => {
  _resetHeartbeatRegistryForTests();
  const h = startHeartbeat({ anchor: undefined, projectRoot: testRoot });
  if (h.active !== false) throw new Error("expected active:false on no-op handle");
  if (h.tracePath !== undefined) throw new Error("expected undefined tracePath on no-op");
  // stop should not throw
  h.stop();
  h.beat("alive");
});

check("anchor missing session_id → no-op handle", () => {
  _resetHeartbeatRegistryForTests();
  const h = startHeartbeat({
    anchor: { session_id: "", turn_id: 0 },
    projectRoot: testRoot,
  });
  if (h.active !== false) throw new Error("expected no-op when session_id is empty");
});

console.log("\nSection: startHeartbeat happy path");

check("initial 'started' beat written synchronously", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-1", turn_id: 1 };
  const h = startHeartbeat({
    anchor,
    projectRoot: testRoot,
    startedNote: "hello-test",
    intervalMs: 60_000, // long enough that no timer fires during this check
  });
  if (!h.active) throw new Error("expected active:true after start");
  if (typeof h.tracePath !== "string") throw new Error("expected tracePath string");
  const beats = readHeartbeatTrace(h.tracePath);
  if (beats.length !== 1) throw new Error(`expected 1 beat, got ${beats.length}`);
  if (beats[0].phase !== "started") throw new Error(`expected started phase; got ${beats[0].phase}`);
  if (beats[0].note !== "hello-test") throw new Error(`expected note=hello-test; got ${beats[0].note}`);
  if (beats[0].session_id !== "sess-1") throw new Error("missing session_id in beat");
  if (beats[0].turn_id !== 1) throw new Error("missing turn_id in beat");
  if (typeof beats[0].pid !== "number") throw new Error("pid not numeric");
  // R8 schema additions (GPT-5.5 + DeepSeek P2-1):
  if (beats[0].schema_version !== 1) throw new Error("missing schema_version=1");
  if (beats[0].seq !== 1) throw new Error(`expected seq=1 on first beat; got ${beats[0].seq}`);
  if (beats[0].interval_ms !== 60_000) {
    throw new Error(`started beat must carry interval_ms (got ${beats[0].interval_ms})`);
  }
  h.stop();
});

check("alive/stopping beats do NOT carry interval_ms (started-only)", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-1b", turn_id: 1 };
  const h = startHeartbeat({
    anchor,
    projectRoot: testRoot,
    intervalMs: 60_000,
  });
  h.beat("alive");
  // Stop writes the final 'stopping' beat then unlinks; capture beats before stop
  // by reading via separate handle to a copy of the file.
  // Easier: capture by reading first, then stop.
  const before = readHeartbeatTrace(h.tracePath);
  if (before.length !== 2) throw new Error(`expected 2 beats before stop; got ${before.length}`);
  if ("interval_ms" in before[1]) {
    throw new Error("alive beat must NOT carry interval_ms (started-only contract)");
  }
  if (before[1].seq !== 2) throw new Error(`alive beat seq must be 2; got ${before[1].seq}`);
  h.stop();
});

check("beat() writes out-of-band phase transition", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-2", turn_id: 2, subturn: 1 };
  const h = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  h.beat("alive", "prompt-phase");
  const beats = readHeartbeatTrace(h.tracePath);
  if (beats.length !== 2) throw new Error(`expected 2 beats (started + alive); got ${beats.length}`);
  if (beats[1].phase !== "alive") throw new Error("second beat must be alive");
  if (beats[1].note !== "prompt-phase") throw new Error("note not propagated");
  if (beats[1].subturn !== 1) throw new Error("subturn not propagated");
  h.stop();
});

await checkAsync("periodic timer writes 'alive' beats at interval", async () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-3", turn_id: 3 };
  const h = startHeartbeat({
    anchor,
    projectRoot: testRoot,
    // Interval is clamped to min 1000ms by the writer; pick exactly 1000
    // so the smoke runs fast.
    intervalMs: 1_000,
  });
  // Wait 2.5 intervals — should produce 2 'alive' beats.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const beats = readHeartbeatTrace(h.tracePath);
  // 1 'started' + at least 2 'alive'
  const aliveCount = beats.filter((b) => b.phase === "alive").length;
  if (aliveCount < 2) {
    throw new Error(`expected ≥2 alive beats after 2.5s; got ${aliveCount} (total beats: ${beats.length})`);
  }
  h.stop();
});

console.log("\nSection: stop() lifecycle");

check("stop() writes final 'stopping' beat AND unlinks trace file", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-4", turn_id: 4 };
  const h = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  const tracePath = h.tracePath;
  // File must exist while active.
  if (!fs.existsSync(tracePath)) throw new Error("trace file should exist before stop");
  h.stop();
  // File must be cleaned up best-effort.
  if (fs.existsSync(tracePath)) {
    throw new Error("trace file should be unlinked after stop (cleanup)");
  }
  if (h.active) throw new Error("active should be false after stop");
});

check("R8 unanimous P1 fix: stop() actually writes 'stopping' beat to disk", () => {
  // Pre-R8 bug (unanimous Opus P1-B + GPT-5.5 P1-2): stop() set
  // stopped=true BEFORE calling writeOne(\"stopping\"), and writeOne's
  // first line is `if (stopped) return`. So the stopping beat was
  // silently dropped — the post-stop unlink hid the bug.
  //
  // R8 fix: stop() writes the terminal beat with force:true BEFORE
  // flipping stopped. The beat MUST be visible in a snapshot of the
  // file taken between the writeOne call and the unlinkSync — we
  // simulate that by monkey-patching fs.unlinkSync to do nothing,
  // running stop(), then reading the file.
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-stopping-test", turn_id: 99 };
  const h = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  const tracePath = h.tracePath;
  const realUnlink = fs.unlinkSync;
  let unlinkAttempts = 0;
  fs.unlinkSync = function intercept() { unlinkAttempts++; };
  try {
    h.stop();
  } finally {
    fs.unlinkSync = realUnlink;
  }
  if (unlinkAttempts !== 1) throw new Error(`expected exactly 1 unlink attempt; got ${unlinkAttempts}`);
  const beats = readHeartbeatTrace(tracePath);
  const stopping = beats.filter((b) => b.phase === "stopping");
  if (stopping.length !== 1) {
    throw new Error(`expected exactly 1 'stopping' beat in trace; got ${stopping.length}. Pre-R8 bug.`);
  }
  // Cleanup the residue file manually.
  try { realUnlink(tracePath); } catch {}
});

check("stop() is idempotent (no double-stopping beat, no exception)", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-5", turn_id: 5 };
  const h = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  h.stop();
  h.stop();
  h.stop();
  if (h.active) throw new Error("should remain inactive after multiple stops");
});

check("beat() after stop() is silently dropped", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-6", turn_id: 6 };
  const h = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  // Capture file content before stop.
  const tracePath = h.tracePath;
  h.stop();
  // Trace file is now gone. beat() after stop should not recreate it.
  h.beat("alive", "ghost");
  if (fs.existsSync(tracePath)) {
    throw new Error("beat after stop must not recreate trace file");
  }
});

console.log("\nSection: duplicate start protection");

check("duplicate start with same anchor returns the same handle", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-7", turn_id: 7 };
  const h1 = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  const h2 = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  if (h1 !== h2) {
    throw new Error("duplicate start must return identical handle (no double writer)");
  }
  // Only 1 'started' beat should exist (the second start was a no-op).
  const beats = readHeartbeatTrace(h1.tracePath);
  const startedCount = beats.filter((b) => b.phase === "started").length;
  if (startedCount !== 1) {
    throw new Error(`expected 1 started beat; got ${startedCount}`);
  }
  h1.stop();
});

console.log("\nSection: readHeartbeatTrace");

check("missing file returns []", () => {
  const beats = readHeartbeatTrace(path.join(testRoot, "no-such-file.jsonl"));
  if (!Array.isArray(beats) || beats.length !== 0) {
    throw new Error("expected [] for missing file");
  }
});

check("readHeartbeatTrace tolerates corrupt lines", () => {
  const corruptFile = path.join(tmpDir, "corrupt.jsonl");
  fs.writeFileSync(
    corruptFile,
    [
      JSON.stringify({ ts: "2026-05-28T00:00:00Z", phase: "started", pid: 1 }),
      "not json",
      JSON.stringify({ ts: "2026-05-28T00:00:01Z", phase: "alive", pid: 1 }),
      "", // empty line
    ].join("\n") + "\n",
  );
  const beats = readHeartbeatTrace(corruptFile);
  if (beats.length !== 2) throw new Error(`expected 2 valid beats; got ${beats.length}`);
});

console.log("\nSection: anchor fields carried through");

check("subturn, sub_agent_label, device_id all propagate when present", () => {
  _resetHeartbeatRegistryForTests();
  const anchor = {
    session_id: "sess-9",
    turn_id: 9,
    subturn: 3,
    sub_agent_label: "review-opus",
    device_id: "dev-abc",
  };
  const h = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  const beats = readHeartbeatTrace(h.tracePath);
  const b = beats[0];
  if (b.subturn !== 3) throw new Error("subturn missing");
  if (b.sub_agent_label !== "review-opus") throw new Error("sub_agent_label missing");
  if (b.device_id !== "dev-abc") throw new Error("device_id missing");
  h.stop();
});

console.log("\nSection: globalThis singleton (R4 jiti lesson)");

check("active registry survives module re-import", () => {
  // Simulate jiti loading the module a second time by re-running loadCJS.
  // The globalThis Symbol.for key should ensure both module instances
  // share the same state Map.
  _resetHeartbeatRegistryForTests();
  const anchor = { session_id: "sess-10", turn_id: 10 };
  const h1 = startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });

  // Reload the module — fresh CJS instance.
  const mod2 = loadCJS(
    heartbeatCjs,
    path.join(tmpDir, "heartbeat-2.cjs"),
    new Map([["./causal-anchor", causalAnchorStub]]),
  );

  // Second instance's startHeartbeat with the SAME anchor should
  // recognize the existing handle via globalThis registry.
  const h2 = mod2.startHeartbeat({ anchor, projectRoot: testRoot, intervalMs: 60_000 });
  if (h1 !== h2) {
    throw new Error(
      "cross-module-instance: same anchor should return same handle via globalThis registry " +
      "(R4 NEW-P0 lesson). Otherwise dispatch and another extension would silently fight " +
      "over the same heartbeat file.",
    );
  }
  h1.stop();
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all heartbeat writer invariants hold`);
