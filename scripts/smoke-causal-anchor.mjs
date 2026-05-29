#!/usr/bin/env node
/**
 * Smoke: ADR 0027 C6a causal-anchor (`extensions/_shared/causal-anchor.ts`).
 *
 * Validates the cross-layer (session_id, turn_id) trace anchor:
 *   - lifecycle binding (session_start / before_agent_start) updates state
 *   - getCurrentAnchor() returns undefined before any session, defined after
 *   - sub-agent session_start does NOT overwrite main anchor (PR-B guard)
 *   - sub-agent before_agent_start does NOT bump main turn_id (PR-B guard)
 *   - deriveSubAgentAnchor monotonic per-parent, restarts per new parent
 *   - formatAnchorPromptBlock XML-attr safety (quote escape)
 *   - spreadAnchor handles undefined gracefully
 *
 * Pattern: transpile causal-anchor.ts + pi-internals.ts (the WeakSet
 * marker dependency), stub @earendil-works/pi-coding-agent at module
 * load time, drive the lifecycle by directly invoking the registered
 * handlers via a captured FakePi.
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

// ── Stage: compile causal-anchor.ts and pi-internals.ts to CJS ──────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "causal-anchor-smoke-"));

// Stub pi runtime (causal-anchor + pi-internals both import from it).
function makeStubClass() { return function StubClass() {}; }
const piRuntimeStub = {
  AgentSession: makeStubClass(),
  InteractiveMode: makeStubClass(),
};

// First load pi-internals.ts (causal-anchor depends on it).
const piInternalsSrc = path.join(repoRoot, "extensions/_shared/pi-internals.ts");
const piInternalsCjs = transpile(piInternalsSrc);
const piInternalsPath = path.join(tmpDir, "pi-internals.cjs");
fs.writeFileSync(piInternalsPath, piInternalsCjs);
const piInternalsModule = loadCJS(
  piInternalsCjs,
  piInternalsPath,
  new Map([["@earendil-works/pi-coding-agent", piRuntimeStub]]),
);

// Then load causal-anchor.ts — it imports `./pi-internals`, which we
// stub by pointing the loader at the already-loaded module exports.
const causalAnchorSrc = path.join(repoRoot, "extensions/_shared/causal-anchor.ts");
const causalAnchorCjs = transpile(causalAnchorSrc);
const causalAnchorPath = path.join(tmpDir, "causal-anchor.cjs");
fs.writeFileSync(causalAnchorPath, causalAnchorCjs);
const causalAnchor = loadCJS(
  causalAnchorCjs,
  causalAnchorPath,
  new Map([
    ["@earendil-works/pi-coding-agent", piRuntimeStub],
    ["./pi-internals", piInternalsModule],
  ]),
);

const {
  bindLifecycle,
  getCurrentAnchor,
  deriveSubAgentAnchor,
  formatAnchorPromptBlock,
  spreadAnchor,
  _resetCausalAnchorForTests,
  _setCurrentAnchorForTests,
} = causalAnchor;
const { markSessionAsSubAgent } = piInternalsModule;

// ── FakePi: captures handlers and replays them on demand ────────────────

function makeFakePi() {
  const handlers = new Map(); // event_type → handler[]
  return {
    on(eventType, handler) {
      if (!handlers.has(eventType)) handlers.set(eventType, []);
      handlers.get(eventType).push(handler);
    },
    /** Test helper: fire all handlers for a given event. */
    _fire(eventType, event, ctx) {
      const hs = handlers.get(eventType) ?? [];
      for (const h of hs) h(event, ctx);
    },
    _handlerCount(eventType) {
      return (handlers.get(eventType) ?? []).length;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

console.log("causal-anchor (ADR 0027 C6a)");

check("API surface complete", () => {
  for (const name of [
    "bindLifecycle",
    "getCurrentAnchor",
    "deriveSubAgentAnchor",
    "formatAnchorPromptBlock",
    "spreadAnchor",
  ]) {
    if (typeof causalAnchor[name] !== "function") {
      throw new Error(`missing export: ${name}`);
    }
  }
});

check("initial getCurrentAnchor() returns undefined", () => {
  _resetCausalAnchorForTests();
  if (getCurrentAnchor() !== undefined) {
    throw new Error("expected undefined before any lifecycle event");
  }
});

check("bindLifecycle registers session_start + before_agent_start + agent_end", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  if (pi._handlerCount("session_start") !== 1) {
    throw new Error("session_start handler not registered");
  }
  if (pi._handlerCount("before_agent_start") !== 1) {
    throw new Error("before_agent_start handler not registered");
  }
  // 2026-05-29: bindLifecycle now also registers an agent_end handler that
  // resets the per-turn bump flag (replaces the old registration guard).
  if (pi._handlerCount("agent_end") !== 1) {
    throw new Error("agent_end (per-turn bump reset) handler not registered");
  }
});

check("bindLifecycle is multi-binder safe: 2 calls register 2 bump handlers but per-turn bump is idempotent", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  bindLifecycle(pi); // a second extension binding (e.g. dispatch + memory)
  if (pi._handlerCount("before_agent_start") !== 2) {
    throw new Error(`expected 2 bump handlers after 2 binds, got ${pi._handlerCount("before_agent_start")}`);
  }
  const sm = { getSessionId: () => "session-A" };
  pi._fire("session_start", { type: "session_start" }, { sessionManager: sm });
  // One turn fires BOTH bump handlers; per-turn flag → only the first counts.
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "t0" }, { sessionManager: sm });
  if (getCurrentAnchor()?.turn_id !== 0) {
    throw new Error(`two bump handlers double-incremented: turn_id=${getCurrentAnchor()?.turn_id}, want 0`);
  }
  // Next turn after agent_end reset → exactly +1 (not +2).
  pi._fire("agent_end", { type: "agent_end" }, { sessionManager: sm });
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "t1" }, { sessionManager: sm });
  if (getCurrentAnchor()?.turn_id !== 1) {
    throw new Error(`turn_id=${getCurrentAnchor()?.turn_id}, want 1 (single bump per turn)`);
  }
});

check("session_start sets session_id but NOT turn_id (still undefined)", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  const sm = { getSessionId: () => "session-A" };
  pi._fire("session_start", { type: "session_start", reason: "startup" }, { sessionManager: sm });
  // Anchor is still undefined because turn_id is -1 (no before_agent_start yet)
  if (getCurrentAnchor() !== undefined) {
    throw new Error("anchor must be undefined until before_agent_start fires");
  }
});

check("before_agent_start bumps turn_id to 0 after session_start", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  const sm = { getSessionId: () => "session-A" };
  pi._fire("session_start", { type: "session_start", reason: "startup" }, { sessionManager: sm });
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "hi" }, { sessionManager: sm });
  const anchor = getCurrentAnchor();
  if (!anchor) throw new Error("anchor should be defined now");
  if (anchor.session_id !== "session-A") throw new Error(`session_id=${anchor.session_id}`);
  if (anchor.turn_id !== 0) throw new Error(`turn_id=${anchor.turn_id}, want 0`);
});

check("subsequent turns monotonic-increment turn_id (agent_end resets the per-turn bump flag)", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  const sm = { getSessionId: () => "session-A" };
  pi._fire("session_start", { type: "session_start", reason: "startup" }, { sessionManager: sm });
  for (let want = 0; want <= 4; want++) {
    // A turn = before_agent_start (bump) ... agent_end (reset). Per-turn
    // idempotency means re-firing before_agent_start WITHOUT an agent_end in
    // between is intentionally a no-op (same turn).
    pi._fire("before_agent_start", { type: "before_agent_start", prompt: `t${want}` }, { sessionManager: sm });
    const a = getCurrentAnchor();
    if (a?.turn_id !== want) throw new Error(`turn_id=${a?.turn_id}, want ${want}`);
    // Re-firing before_agent_start in the SAME turn must NOT bump.
    pi._fire("before_agent_start", { type: "before_agent_start", prompt: `t${want}-dup` }, { sessionManager: sm });
    if (getCurrentAnchor()?.turn_id !== want) throw new Error(`same-turn re-fire bumped: ${getCurrentAnchor()?.turn_id}`);
    pi._fire("agent_end", { type: "agent_end" }, { sessionManager: sm });
  }
});

check("new session_start resets turn_id (different session)", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  const smA = { getSessionId: () => "session-A" };
  const smB = { getSessionId: () => "session-B" };
  pi._fire("session_start", { type: "session_start", reason: "startup" }, { sessionManager: smA });
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "1" }, { sessionManager: smA });
  pi._fire("agent_end", { type: "agent_end" }, { sessionManager: smA });
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "2" }, { sessionManager: smA });
  // Now turn_id=1
  pi._fire("session_start", { type: "session_start", reason: "new" }, { sessionManager: smB });
  if (getCurrentAnchor() !== undefined) {
    throw new Error("anchor should reset to undefined after session_start");
  }
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "new" }, { sessionManager: smB });
  const a = getCurrentAnchor();
  if (a?.session_id !== "session-B") throw new Error(`session_id=${a?.session_id}`);
  if (a?.turn_id !== 0) throw new Error(`turn_id=${a?.turn_id}, want 0 (reset)`);
});

// ── Sub-agent guard (PR-B integration) ─────────────────────────────────

check("sub-agent session_start does NOT overwrite main anchor", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  const mainSm = { getSessionId: () => "main-session" };
  pi._fire("session_start", { type: "session_start", reason: "startup" }, { sessionManager: mainSm });
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "user" }, { sessionManager: mainSm });
  // Main anchor is now (main-session, 0).
  const before = getCurrentAnchor();
  if (before?.session_id !== "main-session" || before?.turn_id !== 0) {
    throw new Error("setup failed");
  }
  // Now simulate sub-agent session_start firing with a MARKED SessionManager.
  const subSm = { getSessionId: () => "sub-inmemory" };
  markSessionAsSubAgent(subSm);
  pi._fire("session_start", { type: "session_start", reason: "startup" }, { sessionManager: subSm });
  const after = getCurrentAnchor();
  if (after?.session_id !== "main-session") {
    throw new Error(`sub-agent clobbered main session_id: got ${after?.session_id}`);
  }
  if (after?.turn_id !== 0) {
    throw new Error(`sub-agent clobbered main turn_id: got ${after?.turn_id}`);
  }
});

check("sub-agent before_agent_start does NOT bump main turn_id", () => {
  _resetCausalAnchorForTests();
  const pi = makeFakePi();
  bindLifecycle(pi);
  const mainSm = { getSessionId: () => "main-session" };
  pi._fire("session_start", { type: "session_start", reason: "startup" }, { sessionManager: mainSm });
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "user1" }, { sessionManager: mainSm });
  const before = getCurrentAnchor();
  if (before?.turn_id !== 0) throw new Error("setup failed");

  // Sub-agent fires before_agent_start
  const subSm = { getSessionId: () => "sub-inmemory" };
  markSessionAsSubAgent(subSm);
  pi._fire("before_agent_start", { type: "before_agent_start", prompt: "sub" }, { sessionManager: subSm });
  const after = getCurrentAnchor();
  if (after?.turn_id !== 0) {
    throw new Error(`sub-agent bumped main turn_id: ${after?.turn_id}`);
  }
});

// ── deriveSubAgentAnchor ───────────────────────────────────────────────

check("deriveSubAgentAnchor monotonic 1..N for same parent", () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("S", 3);
  const parent = getCurrentAnchor();
  if (!parent) throw new Error("parent setup failed");

  const a1 = deriveSubAgentAnchor(parent, "tag");
  const a2 = deriveSubAgentAnchor(parent, "tag");
  const a3 = deriveSubAgentAnchor(parent, "tag");
  if (a1?.subturn !== 1) throw new Error(`a1.subturn=${a1?.subturn}`);
  if (a2?.subturn !== 2) throw new Error(`a2.subturn=${a2?.subturn}`);
  if (a3?.subturn !== 3) throw new Error(`a3.subturn=${a3?.subturn}`);
  // session_id + turn_id stable
  for (const a of [a1, a2, a3]) {
    if (a?.session_id !== "S" || a?.turn_id !== 3) throw new Error("anchor diverged");
    if (a?.sub_agent_label !== "tag") throw new Error(`label=${a?.sub_agent_label}`);
  }
});

check("deriveSubAgentAnchor restarts at 1 for different (session, turn)", () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("S", 3);
  const p1 = getCurrentAnchor();
  deriveSubAgentAnchor(p1);
  deriveSubAgentAnchor(p1);
  // Move to new turn — same session, different turn_id
  _setCurrentAnchorForTests("S", 4);
  const p2 = getCurrentAnchor();
  const first = deriveSubAgentAnchor(p2);
  if (first?.subturn !== 1) {
    throw new Error(`subturn after turn bump should restart at 1, got ${first?.subturn}`);
  }
});

check("deriveSubAgentAnchor(undefined) returns undefined", () => {
  _resetCausalAnchorForTests();
  if (deriveSubAgentAnchor(undefined) !== undefined) {
    throw new Error("expected undefined parent → undefined result");
  }
});

// ── formatting ─────────────────────────────────────────────────────────

check("formatAnchorPromptBlock minimal anchor", () => {
  const block = formatAnchorPromptBlock({ session_id: "abc", turn_id: 2 });
  if (!block.includes('session_id="abc"')) throw new Error(`missing session_id: ${block}`);
  if (!block.includes('turn_id="2"')) throw new Error(`missing turn_id: ${block}`);
  if (block.includes("subturn=")) throw new Error("subturn should be absent");
  if (!block.includes("ADR 0027 C6")) throw new Error("missing marker comment");
});

check("formatAnchorPromptBlock with subturn + label", () => {
  const block = formatAnchorPromptBlock({
    session_id: "S",
    turn_id: 1,
    subturn: 3,
    sub_agent_label: "review-opus",
  });
  if (!block.includes('subturn="3"')) throw new Error(`missing subturn: ${block}`);
  if (!block.includes('sub_agent_label="review-opus"')) {
    throw new Error(`missing label: ${block}`);
  }
});

check("formatAnchorPromptBlock escapes quote in label", () => {
  const block = formatAnchorPromptBlock({
    session_id: "S",
    turn_id: 1,
    sub_agent_label: 'bad"name',
  });
  if (block.includes('bad"name"')) throw new Error("unescaped quote broke XML");
  if (!block.includes("bad&quot;name")) throw new Error(`expected escape, got: ${block}`);
});

// ── spreadAnchor ───────────────────────────────────────────────────────

check("spreadAnchor(undefined) returns {}", () => {
  const r = spreadAnchor(undefined);
  if (typeof r !== "object" || Object.keys(r).length !== 0) {
    throw new Error(`expected {}, got ${JSON.stringify(r)}`);
  }
});

check("spreadAnchor minimal includes session_id + turn_id", () => {
  const r = spreadAnchor({ session_id: "S", turn_id: 5 });
  if (r.session_id !== "S" || r.turn_id !== 5) {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
  if ("subturn" in r) throw new Error("subturn should not be present");
});

check("spreadAnchor with subturn + label includes all", () => {
  const r = spreadAnchor({ session_id: "S", turn_id: 5, subturn: 2, sub_agent_label: "tag" });
  if (r.subturn !== 2 || r.sub_agent_label !== "tag") {
    throw new Error(`got ${JSON.stringify(r)}`);
  }
});

// ── Audit-row schema integration sanity ────────────────────────────────

check("spread + extra fields → flat audit row (real usage shape)", () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("session-X", 7);
  const parent = getCurrentAnchor();
  const sub = deriveSubAgentAnchor(parent, "dispatch_agent");
  const row = {
    timestamp: "2026-05-27T16:00:00Z",
    audit_version: 1,
    pid: 12345,
    ...spreadAnchor(sub),
    operation: "dispatch_agent",
    model: "anthropic/claude-opus-4-7",
    duration_ms: 1234,
    result: "ok",
  };
  // Cross-layer join contract — must be reconstructable by jq:
  //   jq 'select(.session_id == "session-X" and .turn_id == 7 and .subturn == 1)'
  if (row.session_id !== "session-X" || row.turn_id !== 7 || row.subturn !== 1) {
    throw new Error(`audit row anchor wrong: ${JSON.stringify(row)}`);
  }
  if (row.sub_agent_label !== "dispatch_agent") {
    throw new Error("label missing in audit row");
  }
});

// ── Summary ────────────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`✅ causal-anchor: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ causal-anchor: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
