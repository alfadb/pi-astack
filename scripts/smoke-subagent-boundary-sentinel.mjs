#!/usr/bin/env node
/**
 * Smoke: ADR 0027 PR-B+ R1 P1-1 — sub-agent SessionManager boundary sentinel.
 *
 * Pins the contract:
 *   - `bindSubAgentBoundarySentinel(pi)` registers a session_start listener
 *   - Listener with marked SM in ctx → status="ok", no warn
 *   - Listener with unmarked SM in ctx → status="broken", loud warn emitted
 *   - Listener with marked-then-wrapped SM (the actual pi-upgrade failure
 *     scenario) → status="broken"
 *   - Listener is idempotent after first OK or broken (no repeated warns)
 *   - `PI_ASTACK_SUPPRESS_BOUNDARY_SENTINEL=1` env var disables the bind
 *
 * Why this smoke matters: this is the structural alarm for the WeakSet
 * boundary failure mode (Opus's "most hidden time bomb"). If pi upgrades
 * and wraps SessionManager at the ExtensionContext boundary, sub-agents
 * silently look like main sessions → sediment learns their reasoning.
 * The sentinel must fire LOUD on the first sub-agent spawn so the
 * operator catches it instead of debugging brain pollution months later.
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

// ── Stage pi-internals.ts ──────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-boundary-sentinel-"));

const piApiStub = {
  // bindSubAgentBoundarySentinel needs ExtensionAPI type — used as type only.
  // For runtime, we provide pi.on() as the only callable.
  AgentSession: {
    prototype: {
      _buildRuntime: () => {},
      _runAutoCompaction: () => {},
      _emit: () => {},
    },
  },
  InteractiveMode: {
    prototype: {
      handleEvent: () => {},
    },
  },
};

const piInternalsSrc = path.join(repoRoot, "extensions/_shared/pi-internals.ts");
const piInternalsCjs = transpile(piInternalsSrc);
const piInternalsPath = path.join(tmpDir, "pi-internals.cjs");
fs.writeFileSync(piInternalsPath, piInternalsCjs);
const piInternals = loadCJS(
  piInternalsCjs,
  piInternalsPath,
  new Map([["@earendil-works/pi-coding-agent", piApiStub]]),
);

const {
  markSessionAsSubAgent,
  isSubAgentSession,
  bindSubAgentBoundarySentinel,
  getSubAgentBoundaryStatus,
  getSubAgentBoundaryDiagnostic,
  _resetSubAgentMarkersForTests,
  _resetSubAgentBoundaryProbeForTests,
} = piInternals;

// ── Mock pi.on() that captures handler ─────────────────────────

function makeMockPi() {
  const handlers = new Map(); // event → handler
  return {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    fire: (event, eventData, ctx) => {
      const h = handlers.get(event);
      if (h) h(eventData, ctx);
    },
    handlers,
  };
}

// ── Tests ──────────────────────────────────────────────────────

console.log("sub-agent SessionManager boundary sentinel (ADR 0027 PR-B+ R1 P1-1)");

check("status starts as 'untested'", () => {
  _resetSubAgentBoundaryProbeForTests();
  if (getSubAgentBoundaryStatus() !== "untested") {
    throw new Error(`expected 'untested', got '${getSubAgentBoundaryStatus()}'`);
  }
  if (getSubAgentBoundaryDiagnostic() !== null) {
    throw new Error("expected null diagnostic initially");
  }
});

check("bindSubAgentBoundarySentinel registers session_start listener", () => {
  _resetSubAgentBoundaryProbeForTests();
  const pi = makeMockPi();
  bindSubAgentBoundarySentinel(pi);
  if (!pi.handlers.has("session_start")) {
    throw new Error("expected session_start listener registered");
  }
});

check("OK case: marked SM in ctx → status='ok', no warn", () => {
  _resetSubAgentBoundaryProbeForTests();
  const pi = makeMockPi();
  let warned = false;
  bindSubAgentBoundarySentinel(pi, { warn: () => (warned = true) });

  const sm = { kind: "fake-sm" };
  markSessionAsSubAgent(sm);

  // Simulate sub-agent session_start where ctx.sessionManager === sm
  pi.fire("session_start", {}, { sessionManager: sm });

  if (getSubAgentBoundaryStatus() !== "ok") {
    throw new Error(`expected 'ok', got '${getSubAgentBoundaryStatus()}'`);
  }
  if (warned) throw new Error("warn was emitted on OK case");
  if (getSubAgentBoundaryDiagnostic() !== null) {
    throw new Error("diagnostic should be null on OK case");
  }
});

check("BROKEN case: unmarked SM in ctx → status='broken', loud warn emitted", () => {
  _resetSubAgentBoundaryProbeForTests();
  _resetSubAgentMarkersForTests();
  const pi = makeMockPi();
  const warnMessages = [];
  bindSubAgentBoundarySentinel(pi, { warn: (m) => warnMessages.push(m) });

  const sm = { kind: "fake-sm" };
  markSessionAsSubAgent(sm);

  // Simulate the actual failure: pi wraps SM, ctx receives a DIFFERENT object
  const wrappedSm = { kind: "wrapper", original: sm }; // identity ≠ sm
  pi.fire("session_start", {}, { sessionManager: wrappedSm });

  if (getSubAgentBoundaryStatus() !== "broken") {
    throw new Error(`expected 'broken', got '${getSubAgentBoundaryStatus()}'`);
  }
  if (warnMessages.length !== 1) {
    throw new Error(`expected 1 warn message, got ${warnMessages.length}`);
  }
  const msg = warnMessages[0];
  if (!msg.includes("CRITICAL") || !msg.includes("boundary invariant VIOLATED")) {
    throw new Error(`warn message missing expected CRITICAL/VIOLATED text:\n${msg}`);
  }
  if (!msg.includes("ADR 0027 PR-B")) {
    throw new Error("warn message missing ADR citation");
  }
  // Diagnostic populated
  const diag = getSubAgentBoundaryDiagnostic();
  if (!diag) throw new Error("diagnostic should be set on broken case");
  if (!diag.observedSmType) throw new Error("diag missing observedSmType");
  if (!Array.isArray(diag.observedSmKeys)) throw new Error("diag missing observedSmKeys");
  if (!diag.timestamp) throw new Error("diag missing timestamp");
});

check("idempotent: second session_start does NOT re-fire warn after broken", () => {
  _resetSubAgentBoundaryProbeForTests();
  _resetSubAgentMarkersForTests();
  const pi = makeMockPi();
  const warnMessages = [];
  bindSubAgentBoundarySentinel(pi, { warn: (m) => warnMessages.push(m) });

  const sm = { kind: "sm1" };
  markSessionAsSubAgent(sm);
  pi.fire("session_start", {}, { sessionManager: { other: 1 } }); // broken
  if (warnMessages.length !== 1) throw new Error("expected first warn");

  pi.fire("session_start", {}, { sessionManager: { other: 2 } }); // 2nd unmarked
  if (warnMessages.length !== 1) {
    throw new Error(`expected 1 total warn (sticky after broken), got ${warnMessages.length}`);
  }
});

check("idempotent: subsequent session_start no-op after ok", () => {
  _resetSubAgentBoundaryProbeForTests();
  const pi = makeMockPi();
  let warnCount = 0;
  bindSubAgentBoundarySentinel(pi, { warn: () => warnCount++ });

  const sm1 = { kind: "first" };
  markSessionAsSubAgent(sm1);
  pi.fire("session_start", {}, { sessionManager: sm1 }); // OK
  if (getSubAgentBoundaryStatus() !== "ok") throw new Error("first probe should be ok");

  // Now simulate a SECOND sub-agent spawn with broken wrapping —
  // sentinel should NOT re-probe (already verified). status stays ok.
  const sm2 = { kind: "second" };
  markSessionAsSubAgent(sm2);
  pi.fire("session_start", {}, { sessionManager: { wrapper: sm2 } }); // wrapped
  if (getSubAgentBoundaryStatus() !== "ok") {
    throw new Error(`second fire should be no-op (status stays ok), got '${getSubAgentBoundaryStatus()}'`);
  }
  if (warnCount !== 0) throw new Error("no warn should fire after ok");
});

check("no SM in ctx → defer (does not flip status)", () => {
  _resetSubAgentBoundaryProbeForTests();
  const pi = makeMockPi();
  let warnCount = 0;
  bindSubAgentBoundarySentinel(pi, { warn: () => warnCount++ });

  pi.fire("session_start", {}, {});
  pi.fire("session_start", {}, { sessionManager: null });
  pi.fire("session_start", {}, { sessionManager: "not-an-object" });
  if (getSubAgentBoundaryStatus() !== "untested") {
    throw new Error(`expected 'untested' (defer), got '${getSubAgentBoundaryStatus()}'`);
  }
  if (warnCount !== 0) throw new Error("no warn on bad SM");
});

check("PI_ASTACK_SUPPRESS_BOUNDARY_SENTINEL=1 disables bind", () => {
  _resetSubAgentBoundaryProbeForTests();
  process.env.PI_ASTACK_SUPPRESS_BOUNDARY_SENTINEL = "1";
  try {
    const pi = makeMockPi();
    bindSubAgentBoundarySentinel(pi);
    if (pi.handlers.has("session_start")) {
      throw new Error("listener should NOT be registered when suppressed");
    }
  } finally {
    delete process.env.PI_ASTACK_SUPPRESS_BOUNDARY_SENTINEL;
  }
});

check("integration: marker WeakSet still functional in this Node runtime", () => {
  // Sanity baseline: if Node's WeakSet API itself is broken, the sentinel
  // would be wasted effort. This is the safety floor.
  _resetSubAgentMarkersForTests();
  const sm = { brand: "weakset-test" };
  if (isSubAgentSession({ sessionManager: sm })) {
    throw new Error("unmarked SM should be false");
  }
  markSessionAsSubAgent(sm);
  if (!isSubAgentSession({ sessionManager: sm })) {
    throw new Error("marked SM should be true — WeakSet broken at runtime level");
  }
  // Different identity, even if "looks similar"
  const lookalike = { brand: "weakset-test" };
  if (isSubAgentSession({ sessionManager: lookalike })) {
    throw new Error("WeakSet should be identity-based, not structural");
  }
});

// ── Summary ────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`✅ sub-agent boundary sentinel: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ sub-agent boundary sentinel: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
