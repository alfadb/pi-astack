#!/usr/bin/env node
/**
 * Smoke: ADR 0027 A4 sub-agent boundary hardening.
 *
 * Verifies the explicit session-id channel, Proxy robustness, global
 * boundary-untrusted fail-closed flag, and source wiring for mutating
 * consumers. Does not touch ~/.abrain.
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

const piApiStub = {
  AgentSession: { prototype: { _buildRuntime: () => {}, _runAutoCompaction: () => {}, _emit: () => {} } },
  InteractiveMode: { prototype: { handleEvent: () => {} } },
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-boundary-a4-"));
const internalsPath = path.join(repoRoot, "extensions/_shared/pi-internals.ts");
const internalsCjs = transpile(internalsPath);
const internals = loadCJS(
  internalsCjs,
  path.join(tmpDir, "pi-internals.cjs"),
  new Map([["@earendil-works/pi-coding-agent", piApiStub]]),
);

const {
  markSessionAsSubAgent,
  isSubAgentSession,
  inspectSubAgentBoundarySignals,
  bindSubAgentBoundarySentinel,
  getSubAgentBoundaryStatus,
  getSubAgentBoundaryDiagnostic,
  isSubAgentBoundaryUntrusted,
  markSubAgentBoundaryUntrusted,
  _resetSubAgentMarkersForTests,
  _resetSubAgentBoundaryProbeForTests,
} = internals;

function makeMockPi() {
  const handlers = new Map();
  return {
    on: (event, handler) => handlers.set(event, handler),
    fire: (event, eventData, ctx) => handlers.get(event)?.(eventData, ctx),
  };
}

function makeSm(id) {
  return {
    getSessionId: () => id,
    getSessionFile: () => undefined,
  };
}

console.log("sub-agent boundary A4 hardening");

check("id registry is first-class and visible in boundary signals", () => {
  _resetSubAgentMarkersForTests();
  _resetSubAgentBoundaryProbeForTests();
  const sm = makeSm("subagent-a4-id");
  markSessionAsSubAgent(sm);
  const signals = inspectSubAgentBoundarySignals({ sessionManager: sm });
  if (signals.sessionId !== "subagent-a4-id") throw new Error(`unexpected session id ${signals.sessionId}`);
  if (!signals.idRegistered) throw new Error("expected idRegistered=true");
  if (!signals.weakMarked) throw new Error("expected weakMarked=true");
  if (!isSubAgentSession({ sessionManager: sm })) throw new Error("marked SM should be sub-agent");
});

check("Proxy-wrapped sessionManager still matches by stable id", () => {
  _resetSubAgentMarkersForTests();
  _resetSubAgentBoundaryProbeForTests();
  const sm = makeSm("subagent-proxy-id");
  markSessionAsSubAgent(sm);
  const proxy = new Proxy({}, {
    get(_target, prop) {
      return sm[prop];
    },
  });
  const signals = inspectSubAgentBoundarySignals({ sessionManager: proxy });
  if (!signals.idRegistered) throw new Error("proxy should hit id registry");
  if (signals.weakMarked) throw new Error("proxy should not hit WeakSet identity");
  if (!isSubAgentSession({ sessionManager: proxy })) throw new Error("proxy should still be sub-agent");
});

check("sentinel accepts Proxy-wrapped sessionManager via id channel", () => {
  _resetSubAgentMarkersForTests();
  _resetSubAgentBoundaryProbeForTests();
  const pi = makeMockPi();
  const warnings = [];
  bindSubAgentBoundarySentinel(pi, { warn: (msg) => warnings.push(msg) });
  const sm = makeSm("subagent-sentinel-proxy-id");
  markSessionAsSubAgent(sm);
  const proxy = new Proxy({}, { get: (_target, prop) => sm[prop] });
  pi.fire("session_start", {}, { sessionManager: proxy });
  if (getSubAgentBoundaryStatus() !== "ok") throw new Error(`expected ok, got ${getSubAgentBoundaryStatus()}`);
  if (warnings.length !== 0) throw new Error(`expected no warning, got ${warnings.length}`);
  if (isSubAgentBoundaryUntrusted()) throw new Error("boundary should remain trusted");
});

check("both channels missing sets boundary-untrusted and loud diagnostic", () => {
  _resetSubAgentMarkersForTests();
  _resetSubAgentBoundaryProbeForTests();
  const pi = makeMockPi();
  const warnings = [];
  bindSubAgentBoundarySentinel(pi, { warn: (msg) => warnings.push(msg) });
  const sm = makeSm("subagent-real-id");
  markSessionAsSubAgent(sm);
  pi.fire("session_start", {}, { sessionManager: makeSm("unregistered-wrapper-id") });
  if (getSubAgentBoundaryStatus() !== "broken") throw new Error(`expected broken, got ${getSubAgentBoundaryStatus()}`);
  if (!isSubAgentBoundaryUntrusted()) throw new Error("boundary-untrusted flag should be set");
  if (warnings.length !== 1 || !warnings[0].includes("CRITICAL")) throw new Error("expected one critical warning");
  const diag = getSubAgentBoundaryDiagnostic();
  if (!diag) throw new Error("expected sentinel diagnostic");
  if (diag.idRegistered !== false || diag.weakMarked !== false) {
    throw new Error(`expected both channels false, got ${JSON.stringify(diag)}`);
  }
});

check("mutating consumer fail-closed pattern stops writes under untrusted boundary", () => {
  _resetSubAgentMarkersForTests();
  _resetSubAgentBoundaryProbeForTests();
  markSubAgentBoundaryUntrusted("smoke_forced_untrusted", { smoke: true });
  let wrote = false;
  function mutatingConsumer() {
    if (isSubAgentBoundaryUntrusted()) return "blocked";
    wrote = true;
    return "wrote";
  }
  const outcome = mutatingConsumer();
  if (outcome !== "blocked") throw new Error(`expected blocked, got ${outcome}`);
  if (wrote) throw new Error("consumer wrote despite boundary-untrusted flag");
});

check("mutating extension entries are wired to boundary-untrusted guard", () => {
  const required = [
    "extensions/sediment/index.ts",
    "extensions/compaction-tuner/index.ts",
    "extensions/model-fallback/index.ts",
    "extensions/model-curator/index.ts",
    "extensions/persistent-input-history/index.ts",
  ];
  for (const rel of required) {
    const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    if (!text.includes("isSubAgentBoundaryUntrusted")) {
      throw new Error(`${rel} does not import/check isSubAgentBoundaryUntrusted`);
    }
  }
});

console.log();
if (failures.length === 0) {
  console.log("sub-agent boundary A4: all checks passed");
  process.exit(0);
}
console.error(`sub-agent boundary A4: ${failures.length} failure(s)`);
for (const { name, err } of failures) {
  console.error(`  - ${name}: ${err.stack || err.message}`);
}
process.exit(1);
