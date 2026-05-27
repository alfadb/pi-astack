#!/usr/bin/env node
// Smoke test: verify dispatch sub-agents are isolated from main-session-only
// extensions (sediment, compaction-tuner, model-fallback, model-curator,
// persistent-input-history, abrain rule-injector) via the v3 in-process
// mechanism — pi-internals.ts WeakSet marker + handler-level
// `isSubAgentSession(ctx)` guards.
//
// This replaces the v2 (subprocess) check that verified spawn("pi", ...,
// { env: { PI_ABRAIN_DISABLED: "1" } }). v3 dispatch runs sub-agents
// in-process (ADR 0009), so env-var passthrough is no longer the mechanism.
// The new contract per ADR 0027 PR-B:
//
//   (i)   dispatch/index.ts imports markSessionAsSubAgent from pi-internals
//   (ii)  dispatch calls markSessionAsSubAgent(sm) on the SessionManager
//         BEFORE passing it to createAgentSession({sessionManager: sm})
//   (iii) the same SessionManager instance is what reaches createAgentSession
//         (so ctx.sessionManager === marked sm in every lifecycle handler)
//   (iv)  every main-session-only lifecycle handler has the
//         `isSubAgentSession(ctx)` early-return guard
//
// This is structural verification — sufficient to catch a future regression
// where someone reintroduces SessionManager.inMemory() inline without the
// marker, or adds a new main-session lifecycle handler without the guard.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const dispatchPath = resolve(repoRoot, "extensions/dispatch/index.ts");

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function bad(msg) { fail++; console.log(`  ✗ ${msg}`); }

const dispatchSrc = readFileSync(dispatchPath, "utf8");

// ── (i) dispatch imports markSessionAsSubAgent ──────────────────────────
if (/import\s*\{[^}]*\bmarkSessionAsSubAgent\b[^}]*\}\s*from\s*["'][^"']*pi-internals/.test(dispatchSrc)) {
  ok("(i) dispatch imports markSessionAsSubAgent from pi-internals");
} else {
  bad("(i) dispatch does not import markSessionAsSubAgent — sub-agent isolation broken");
}

// ── (ii) markSessionAsSubAgent is called before createAgentSession ──────
// Find the createAgentSession call and the preceding markSessionAsSubAgent.
const createCallIdx = dispatchSrc.indexOf("createAgentSession({");
if (createCallIdx === -1) {
  bad("(ii) could not locate createAgentSession({...}) call in dispatch");
} else {
  // Search backwards from the call for markSessionAsSubAgent within ~30 lines.
  const before = dispatchSrc.slice(Math.max(0, createCallIdx - 2000), createCallIdx);
  if (/markSessionAsSubAgent\s*\(/.test(before)) {
    ok("(ii) markSessionAsSubAgent called before createAgentSession");
  } else {
    bad("(ii) markSessionAsSubAgent NOT called before createAgentSession — marker missing");
  }
}

// ── (iii) the marked SessionManager is the one passed to createAgentSession ──
// Match a binding like `const X = SessionManager.inMemory(...)` followed by
// `markSessionAsSubAgent(X)` and then `sessionManager: X` inside createAgentSession.
// Note: SessionManager.inMemory(...) often has nested parens (e.g.
// process.cwd()), so accept any content via [\s\S]*? rather than [^)]*.
const subAgentBindMatch = dispatchSrc.match(
  /const\s+(\w+)\s*=\s*SessionManager\.inMemory\([\s\S]*?\);?\s*markSessionAsSubAgent\(\1\);[\s\S]{0,2000}sessionManager:\s*\1\b/,
);
if (subAgentBindMatch) {
  ok(`(iii) marked SessionManager binding "${subAgentBindMatch[1]}" flows into createAgentSession`);
} else {
  bad("(iii) sub-agent SessionManager binding does not flow through marker → createAgentSession unbroken");
}

// ── (iv) every main-session-only lifecycle handler has the isSubAgentSession guard ──
//
// List of (extension file, expected pi.on event, why it must be guarded).
const guarded = [
  ["extensions/sediment/index.ts", "agent_end",
   "sediment must not extract user-implicit-truth signal from sub-agent output"],
  ["extensions/sediment/index.ts", "session_start",
   "sediment session footer/checkpoint is main-session-only"],
  ["extensions/sediment/index.ts", "agent_start",
   "sediment agent cycle tracking is main-session-only"],
  ["extensions/sediment/index.ts", "before_agent_start",
   "sediment sticky-rule surveillance reads user system prompt — N/A for sub-agent"],
  ["extensions/compaction-tuner/index.ts", "agent_end",
   "compaction state is per-session, sub-agent has its own budget"],
  ["extensions/model-fallback/index.ts", "agent_end",
   "fallback state-machine must not switch sub-agent's dispatched model"],
  ["extensions/model-fallback/index.ts", "session_start",
   "fallback pre-flight is main-session-only"],
  ["extensions/persistent-input-history/index.ts", "session_start",
   "no editor in sub-agent; would also pollute main's history file"],
  ["extensions/persistent-input-history/index.ts", "input",
   "sub-agent prompts are dispatch-generated, not user typing"],
  ["extensions/model-curator/index.ts", "session_start",
   "must NOT prune the sub-agent's model registry (dispatch chose the model)"],
  ["extensions/abrain/rule-injector/index.ts", "session_start",
   "no rule footer/notify in sub-agent UI"],
  ["extensions/abrain/rule-injector/index.ts", "before_agent_start",
   "must NOT inject project rules into sub-agent's dispatch-crafted system prompt"],
];

for (const [relPath, event, why] of guarded) {
  const src = readFileSync(resolve(repoRoot, relPath), "utf8");
  // Find the pi.on("event", ...) handler block and check that within the
  // first ~50 lines after the handler arrow, an isSubAgentSession(ctx) early
  // return appears.
  //
  // Regex notes:
  //   - Case-insensitive (`i` flag) so we match both `pi.on(` and
  //     `maybePi.on(` (rule-injector dynamically type-checks via maybePi).
  //   - `{0,1500}` window covers sediment's huge multi-line ctx type
  //     declarations (event + ctx with nested method signatures often
  //     exceeds 700 chars between `pi.on(` and `) => {`).
  const handlerRe = new RegExp(
    `pi\\.on\\s*\\(\\s*["']${event}["'][\\s\\S]{0,1500}?\\)\\s*=>\\s*\\{`,
    "gi",
  );
  let m;
  let found = false;
  while ((m = handlerRe.exec(src)) !== null) {
    // Look in the ~50 lines following the arrow `{` for the guard.
    const body = src.slice(m.index + m[0].length, m.index + m[0].length + 2500);
    if (/if\s*\(\s*isSubAgentSession\s*\([^)]*\)\s*\)\s*return/.test(body)) {
      found = true;
      break;
    }
  }
  if (found) {
    ok(`(iv) ${relPath}: pi.on("${event}") has isSubAgentSession guard`);
  } else {
    bad(`(iv) ${relPath}: pi.on("${event}") MISSING isSubAgentSession guard — ${why}`);
  }
}

// ── Summary ─────────────────────────────────────────────────────
console.log();
if (fail === 0) {
  console.log(`✅ sub-agent isolation (v3 in-process): all ${pass} checks passed`);
  process.exit(0);
} else {
  console.error(`❌ sub-agent isolation: ${fail} failure(s) out of ${pass + fail}`);
  process.exit(1);
}
