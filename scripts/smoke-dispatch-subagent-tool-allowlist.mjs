#!/usr/bin/env node
// Smoke test: verify the DISPATCH SIDE keeps main-session-only tools
// (vault_release / prompt_user) out of sub-agent reach.
//
// SCOPE / WHAT THIS PROVES (read carefully — it is narrow on purpose):
// This is a STRUCTURAL source-text check of extensions/dispatch/index.ts.
// It proves the dispatch side will not REQUEST or DEFAULT to vault_release/
// prompt_user, and that createAgentSession is actually called WITH a `tools`
// allowlist. It does NOT, by itself, prove the pi SDK enforces that allowlist
// exclusively — that property lives in the SDK (agent-session.js
// `allowedToolNames` filter, verified by 3-T0 review against pi 0.75.x:
// dist/core/agent-session.js:1802-1814) and would only regress on an SDK
// upgrade. A BEHAVIORAL test (register a fake `vault_release`, build a
// session with tools:["read"], assert getActiveToolNames() excludes it) is
// the recommended follow-up to pin the SDK half; see TODO at bottom.
//
// Therefore: green here means "dispatch will not hand vault_release to a
// sub-agent", NOT "vault is fully isolated from sub-agents". A default
// sub-agent still has `read`/`grep` and can read same-user files (incl.
// encrypted vault artifacts) by absolute path — that is ADR 0014 §invariant
// #1 layer-2 residual surface, out of scope for this smoke.
//
// Structural philosophy mirrors smoke-vault-subpi-isolation.mjs.

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

const src = readFileSync(dispatchPath, "utf8");

const FORBIDDEN = ["vault_release", "prompt_user"];
// Sanity anchors: tools that MUST stay present, so a parse miss (empty
// capture) can't make the "forbidden absent" checks vacuously pass.
const EXPECTED_PRESENT = ["read", "memory_search"];

// ── (a) KNOWN_TOOLS excludes the forbidden tools ────────────────────────
const knownMatch = src.match(/const KNOWN_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
if (!knownMatch) {
  bad("(a) could not locate KNOWN_TOOLS set literal — dispatch source shape changed");
} else {
  const body = knownMatch[1];
  for (const t of EXPECTED_PRESENT) {
    if (body.includes(`"${t}"`)) ok(`(a) KNOWN_TOOLS contains sanity anchor "${t}"`);
    else bad(`(a) KNOWN_TOOLS missing sanity anchor "${t}" — parse likely wrong, results untrustworthy`);
  }
  for (const t of FORBIDDEN) {
    if (body.includes(`"${t}"`)) bad(`(a) KNOWN_TOOLS MUST NOT contain "${t}" — callers could then request it via tools=`);
    else ok(`(a) KNOWN_TOOLS excludes "${t}" (caller cannot request it)`);
  }
}

// ── (b) shared default allowlist excludes the forbidden tools ──────────
// Current dispatch source centralizes the default allowlist in
// DEFAULT_SUBAGENT_TOOLS and reuses it from runInProcess + dispatch_parallel.
// This smoke should pin the default capability boundary, not require stale
// duplicated inline strings.
const defaultConstMatch = src.match(/const DEFAULT_SUBAGENT_TOOLS\s*=\s*"([^"]+)"/);
if (!defaultConstMatch) {
  bad("(b) could not locate DEFAULT_SUBAGENT_TOOLS constant — dispatch source shape changed");
} else {
  const list = defaultConstMatch[1].split(",").map((s) => s.trim());
  ok("(b) DEFAULT_SUBAGENT_TOOLS constant found");
  for (const t of EXPECTED_PRESENT) {
    if (list.includes(t)) ok(`(b) default allowlist contains sanity anchor "${t}"`);
    else bad(`(b) default allowlist missing sanity anchor "${t}" — parse likely wrong`);
  }
  for (const t of FORBIDDEN) {
    if (list.includes(t)) bad(`(b) default allowlist MUST NOT contain "${t}"`);
    else ok(`(b) default allowlist excludes "${t}"`);
  }
}

const defaultUses = [
  ["runInProcess", /toolAllowlist\s*\|\|\s*DEFAULT_SUBAGENT_TOOLS/],
  ["dispatch_parallel", /t\.tools\s*\|\|\s*DEFAULT_SUBAGENT_TOOLS/],
];
for (const [label, re] of defaultUses) {
  if (re.test(src)) ok(`(b) ${label} reuses DEFAULT_SUBAGENT_TOOLS`);
  else bad(`(b) ${label} does not reuse DEFAULT_SUBAGENT_TOOLS`);
}

// ── (c) validateTools rejects anything not in KNOWN_TOOLS ───────────────
if (/if\s*\(\s*!\s*KNOWN_TOOLS\.has\(\s*name\s*\)\s*\)/.test(src)) {
  ok("(c) validateTools rejects tools not in KNOWN_TOOLS (!KNOWN_TOOLS.has(name) guard present)");
} else {
  bad("(c) validateTools MISSING the !KNOWN_TOOLS.has(name) rejection guard");
}

// ── (f) nested-dispatch still rejected; (g) mutating NO LONGER gated ─────
// (2026-06-16) the dispatch swarm dropped the PI_MULTI_AGENT_ALLOW_MUTATING
// gate: workers may receive bash/edit/write via explicit tools=. The ONLY
// hard boundary left in validateTools is nested-dispatch + unknown-tool.
// (The workflow channel keeps its W9 env gate via enforceMutatingEnvGate,
//  verified separately in smoke-workflow-executor.)
const vtMatch = src.match(/export function validateTools\(toolsStr[\s\S]*?\n}/);
if (!vtMatch) {
  bad("(f/g) could not locate validateTools body — dispatch source shape changed");
} else {
  const vt = vtMatch[0];
  if (/dispatch_agent|dispatch_parallel/.test(vt) && /nested dispatch not allowed/.test(vt)) {
    ok("(f) validateTools rejects nested dispatch (recursion / runaway-fanout boundary kept)");
  } else {
    bad("(f) validateTools MISSING nested-dispatch rejection — the one boundary that must stay");
  }
  if (/PI_MULTI_AGENT_ALLOW_MUTATING/.test(vt)) {
    bad("(g) validateTools still gates mutating via PI_MULTI_AGENT_ALLOW_MUTATING — swarm edit/write must be ungated here (moved to workflow's enforceMutatingEnvGate)");
  } else {
    ok("(g) validateTools does NOT gate bash/edit/write (swarm editing allowed; env gate removed 2026-06-16)");
  }
}

// ── (d) createAgentSession is actually CALLED WITH a `tools` allowlist ───
// This is load-bearing: if `tools` is dropped from the call, the SDK falls
// back to enabling ALL extension tools (incl. abrain's vault_release) — and
// checks (a)/(b) would still pass green. So assert the wiring exists.
// (gpt-5.5 P1)
let wiredTools = false;
let idx = src.indexOf("createAgentSession({");
while (idx !== -1) {
  const blockEnd = src.indexOf("});", idx);
  const block = src.slice(idx, blockEnd === -1 ? idx + 600 : blockEnd);
  if (/(^|[\s,{])tools\s*[,:]/.test(block)) { wiredTools = true; break; }
  idx = src.indexOf("createAgentSession({", idx + 1);
}
if (wiredTools) {
  ok("(d) createAgentSession is called WITH `tools` (allowlist actually wired into the session)");
} else {
  bad("(d) createAgentSession call does NOT pass `tools` — SDK would enable ALL extension tools incl. vault_release");
}

// ── (e) the design-intent comment documents the exclusion ───────────────
if (/vault_release:\s*secret release, main-session-only/.test(src)) {
  ok('(e) "Deliberately NOT included" comment documents vault_release exclusion');
} else {
  bad('(e) missing the comment documenting vault_release/prompt_user as deliberately excluded');
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log();
if (fail === 0) {
  console.log(`✅ dispatch sub-agent tool allowlist: all ${pass} checks passed`);
  console.log("   (vault_release/prompt_user not requestable via tools= and absent from all defaults;");
  console.log("    SDK-side exclusivity of allowedToolNames is verified separately — see header TODO)");
  process.exit(0);
} else {
  console.error(`❌ dispatch sub-agent tool allowlist: ${fail} failure(s) out of ${pass + fail}`);
  process.exit(1);
}

// TODO(behavioral): add a companion smoke that registers a fake "vault_release"
// extension tool, calls createAgentSession({ tools: ["read"], resourceLoader,
// sessionManager: SessionManager.inMemory() }), and asserts
// session.getActiveToolNames() / getAllTools() exclude "vault_release". That
// pins the SDK allowedToolNames filter and would catch an SDK upgrade that
// made `tools` additive — the one regression class this structural smoke
// cannot see. (Opus + gpt-5.5 T0 recommendation, 2026-05-31.)
