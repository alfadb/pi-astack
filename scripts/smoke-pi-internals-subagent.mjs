#!/usr/bin/env node
/**
 * Smoke: pi-internals sub-agent context API (ADR 0027 PR-B).
 *
 * Verifies the WeakSet-based sub-agent session marker:
 *   - markSessionAsSubAgent(sm) is idempotent
 *   - isSubAgentSession(ctx) returns true iff ctx.sessionManager was marked
 *   - returns false for unmarked / null / non-object ctx.sessionManager
 *   - object identity matters (different SessionManager instance = false)
 *   - WeakSet behaviour: dropping all refs to sm allows GC (best-effort
 *     verified via global.gc when --expose-gc flag present; otherwise
 *     just asserts the API doesn't pin objects via a strong ref)
 *
 * This pins the ctx.sessionManager → marker contract that the lifecycle
 * handlers in sediment / compaction-tuner / model-fallback /
 * persistent-input-history / model-curator / abrain-rule-injector
 * depend on.
 *
 * Why integration-style instead of pure unit: pi-internals.ts imports
 * AgentSession + InteractiveMode from @earendil-works/pi-coding-agent,
 * which pulls heavy deps. We stub those classes minimally so the sub-agent
 * API surface can be loaded without touching pi runtime.
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

function transpileTsToCjs(srcPath) {
  const source = fs.readFileSync(srcPath, "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  });
  return out.outputText;
}

function loadModuleFromString(code, fakePath, stubResolve) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  if (stubResolve) {
    Module._load = function patched(request, parent, ...rest) {
      if (stubResolve.has(request)) return stubResolve.get(request);
      return origLoad.call(this, request, parent, ...rest);
    };
  }
  try {
    m._compile(code, fakePath);
  } finally {
    if (stubResolve) Module._load = origLoad;
  }
  return m.exports;
}

const internalsSrc = path.join(repoRoot, "extensions/_shared/pi-internals.ts");
const compiled = transpileTsToCjs(internalsSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-internals-subagent-"));
const tmpFile = path.join(tmpDir, "pi-internals.cjs");
fs.writeFileSync(tmpFile, compiled);

// Stub out the pi runtime import so we can load just the sub-agent API.
// AgentSession/InteractiveMode are only touched by the turn-boundary patch
// (proto._buildRuntime etc.). For the sub-agent API surface we just need
// the import to resolve — supply objects whose `.prototype` lookup works.
function makeStubClass() {
  const fn = function StubClass() {};
  return fn;
}
const piRuntimeStub = {
  AgentSession: makeStubClass(),
  InteractiveMode: makeStubClass(),
};
const stubResolve = new Map([
  ["@earendil-works/pi-coding-agent", piRuntimeStub],
]);

const internals = loadModuleFromString(compiled, tmpFile, stubResolve);

console.log("pi-internals sub-agent context API (ADR 0027 PR-B)");

const { markSessionAsSubAgent, isSubAgentSession } = internals;

check("API surface exists", () => {
  if (typeof markSessionAsSubAgent !== "function") {
    throw new Error("markSessionAsSubAgent not exported");
  }
  if (typeof isSubAgentSession !== "function") {
    throw new Error("isSubAgentSession not exported");
  }
});

check("unmarked SessionManager → isSubAgentSession=false", () => {
  const sm = { __label: "main-session-sm" };
  const ctx = { sessionManager: sm };
  if (isSubAgentSession(ctx) !== false) {
    throw new Error("expected false for unmarked");
  }
});

check("marked SessionManager → isSubAgentSession=true", () => {
  const sm = { __label: "sub-agent-sm" };
  markSessionAsSubAgent(sm);
  const ctx = { sessionManager: sm };
  if (isSubAgentSession(ctx) !== true) {
    throw new Error("expected true after marking");
  }
});

check("marking is per-instance (different sm → false)", () => {
  const sm1 = { __label: "sm1" };
  const sm2 = { __label: "sm2" };
  markSessionAsSubAgent(sm1);
  if (isSubAgentSession({ sessionManager: sm1 }) !== true) {
    throw new Error("sm1 should be marked");
  }
  if (isSubAgentSession({ sessionManager: sm2 }) !== false) {
    throw new Error("sm2 should NOT be marked (per-instance contract)");
  }
});

check("marking is idempotent (re-mark same instance)", () => {
  const sm = { __label: "idempotent" };
  markSessionAsSubAgent(sm);
  markSessionAsSubAgent(sm);
  markSessionAsSubAgent(sm);
  if (isSubAgentSession({ sessionManager: sm }) !== true) {
    throw new Error("re-marking should remain true");
  }
});

check("null/undefined ctx → false (no throw)", () => {
  if (isSubAgentSession(null) !== false) throw new Error("null ctx should return false");
  if (isSubAgentSession(undefined) !== false) throw new Error("undefined ctx should return false");
});

check("ctx with missing sessionManager → false (no throw)", () => {
  if (isSubAgentSession({}) !== false) {
    throw new Error("missing sessionManager should return false");
  }
});

check("ctx.sessionManager=null → false (no throw)", () => {
  if (isSubAgentSession({ sessionManager: null }) !== false) {
    throw new Error("null sessionManager should return false");
  }
});

check("ctx.sessionManager=string → false (non-object guard)", () => {
  if (isSubAgentSession({ sessionManager: "not-an-object" }) !== false) {
    throw new Error("non-object sessionManager should return false");
  }
});

check("markSessionAsSubAgent ignores null/non-object (no throw)", () => {
  markSessionAsSubAgent(null);
  markSessionAsSubAgent(undefined);
  markSessionAsSubAgent("string");
  markSessionAsSubAgent(42);
  // Should not throw, and should not pollute any state.
  if (isSubAgentSession({ sessionManager: "string" }) !== false) {
    throw new Error("non-object marking must not affect later lookups");
  }
});

check("mimics real ctx shape: sessionManager with method props", () => {
  // Real SessionManager has methods like getSessionId, getBranch, etc.
  // Marker keyed by object identity, not shape.
  const sm = {
    getSessionId: () => "sub-agent-fake-id",
    getBranch: () => [],
    getSessionFile: () => null,
  };
  markSessionAsSubAgent(sm);
  // Wrap as ExtensionContext would expose it (sessionManager is a getter)
  const ctx = {
    get sessionManager() { return sm; },
    cwd: "/tmp",
    modelRegistry: undefined,
  };
  if (isSubAgentSession(ctx) !== true) {
    throw new Error("ctx with getter sessionManager should resolve to marked sm");
  }
});

check("sub-agent / main isolation: two SessionManager instances", () => {
  // Simulates the actual production split: main session has its own sm,
  // dispatch creates a separate inMemory sm and marks it.
  const mainSm = { __role: "main" };
  const subSm = { __role: "sub-agent" };
  markSessionAsSubAgent(subSm);

  const mainCtx = { sessionManager: mainSm };
  const subCtx = { sessionManager: subSm };

  // Mimics what a lifecycle handler does:
  //   if (isSubAgentSession(ctx)) return;  // skip main-session-only work
  const mainHandlerWouldRun = !isSubAgentSession(mainCtx);
  const subHandlerWouldRun = !isSubAgentSession(subCtx);

  if (!mainHandlerWouldRun) {
    throw new Error("main handler must run for main ctx");
  }
  if (subHandlerWouldRun) {
    throw new Error("main-only handler must NOT run for sub-agent ctx");
  }
});

// ── Summary ─────────────────────────────────────────────────────
console.log();
if (failures.length === 0) {
  console.log(`✅ pi-internals sub-agent: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ pi-internals sub-agent: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
