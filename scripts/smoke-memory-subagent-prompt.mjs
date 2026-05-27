#!/usr/bin/env node
/**
 * Smoke: ADR 0027 PR-B+ R1 P1-2 — memory ext sub-agent prompt variant.
 *
 * Pins Route A' (T0 vote synthesis) contract:
 *
 *   - main session before_agent_start receives FULL memory protocol prompt:
 *       * memory-footnote attribution block (used: decisive/confirmatory/...)
 *       * memory_decide Path B guidance
 *
 *   - sub-agent session before_agent_start receives the SUB-AGENT VARIANT:
 *       * memory_decide / memory_search usage guidance (consumption side)
 *       * NO footnote attribution block (P0-α closes the sink for sub-agents
 *         — asking them to write footnotes is asking them to spend tokens
 *         on signal that nothing consumes)
 *
 *   - dispatch default tool allowlist includes memory_search, memory_get,
 *     memory_neighbors, memory_decide (NOT memory_list — broad-inventory
 *     tool, not needed for L2 workers)
 *
 * Why this smoke matters: this is the structural pin for the T0 3-way
 * vote synthesis (Opus B / GPT-5.5 C / DeepSeek A → Route A'). If a
 * future commit reverts to pure A (footnote block in sub-agent context)
 * or pure B (no memory prompt at all in sub-agent), this smoke catches
 * the regression and forces a fresh T0 vote.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function bad(msg) { fail++; console.log(`  ✗ ${msg}`); }

console.log("memory ext sub-agent prompt variant (ADR 0027 PR-B+ R1 P1-2 Route A')");

// ── memory/index.ts: dual-branch before_agent_start ────────────

console.log("\n  memory/index.ts before_agent_start:");
const memSrc = readFileSync(resolve(repoRoot, "extensions/memory/index.ts"), "utf8");

if (/import\s*\{[^}]*\bisSubAgentSession\b[^}]*\}\s*from\s*["'][^"']*pi-internals/.test(memSrc)) {
  ok("imports isSubAgentSession from pi-internals");
} else {
  bad("MISSING import of isSubAgentSession");
}

if (/const\s+MEMORY_INJECT_MARKER\s*=\s*["'][^"']*memory-footnote protocol/.test(memSrc)) {
  ok("MEMORY_INJECT_MARKER (main variant marker) defined");
} else {
  bad("MEMORY_INJECT_MARKER (main variant) missing");
}

if (/const\s+MEMORY_INJECT_MARKER_SUBAGENT\s*=\s*["'][^"']*sub-agent/.test(memSrc)) {
  ok("MEMORY_INJECT_MARKER_SUBAGENT (sub-agent variant marker) defined");
} else {
  bad("MEMORY_INJECT_MARKER_SUBAGENT (sub-agent variant) missing");
}

if (/const\s+isSubAgent\s*=\s*isSubAgentSession\(/.test(memSrc)) {
  ok("before_agent_start branches on isSubAgentSession(ctx)");
} else {
  bad("before_agent_start does NOT branch on isSubAgentSession");
}

// Sub-agent variant content checks
const subBlockMatch = memSrc.match(
  /if\s*\(isSubAgent\)\s*\{[\s\S]*?subBlock\s*=\s*`([\s\S]*?)`;[\s\S]*?return\s*\{[\s\S]*?subBlock/,
);
if (subBlockMatch) {
  const subBlock = subBlockMatch[1];

  // Sub-agent prompt: must MENTION memory_decide / memory_search guidance
  if (/memory_decide/.test(subBlock)) {
    ok("sub-agent variant mentions memory_decide (Path B guidance preserved)");
  } else {
    bad("sub-agent variant LOST memory_decide guidance — DeepSeek vote A concern");
  }
  if (/memory_search/.test(subBlock)) {
    ok("sub-agent variant mentions memory_search");
  } else {
    bad("sub-agent variant LOST memory_search guidance");
  }

  // Sub-agent prompt: must NOT instruct the LLM to write memory-footnote blocks
  // (P0-α closes the sediment sink for sub-agent footnotes).
  // The variant DOES mention "memory-footnote" once in a NEGATIVE clause
  // ("不需要在回复末尾写 memory-footnote block") — that's expected
  // anti-instruction. What we forbid is the POSITIVE attribution protocol.
  if (/used:\s*decisive\s*\|\s*confirmatory\s*\|\s*retrieved-unused/.test(subBlock)) {
    bad("sub-agent variant STILL contains footnote attribution protocol — Opus vote B concern (sink closed by P0-α)");
  } else {
    ok("sub-agent variant correctly OMITS footnote attribution protocol (Opus B concern addressed)");
  }

  // Must mention P0-α explicitly so future readers know WHY
  if (/P0-\u03b1|sediment\s*mask/.test(subBlock)) {
    ok("sub-agent variant explains P0-α sink closure rationale to the LLM");
  } else {
    bad("sub-agent variant does not explain WHY footnote is omitted");
  }
} else {
  bad("could not parse sub-agent variant subBlock");
}

// Main variant content checks
const mainBlockMatch = memSrc.match(
  /\}\s*\n\s*\/\/\s*Main session[\s\S]*?const\s+block\s*=\s*`([\s\S]*?)`;\s*\n\s*return\s*\{[\s\S]*?systemPrompt:[\s\S]*?block/,
);
if (mainBlockMatch) {
  const mainBlock = mainBlockMatch[1];
  if (/used:\s*decisive\s*\|\s*confirmatory\s*\|\s*retrieved-unused/.test(mainBlock)) {
    ok("main session variant retains full footnote attribution protocol");
  } else {
    bad("main session variant LOST footnote attribution protocol — regression!");
  }
  if (/memory_decide/.test(mainBlock)) {
    ok("main session variant retains memory_decide guidance");
  } else {
    bad("main session variant LOST memory_decide guidance");
  }
} else {
  bad("could not parse main session variant block");
}

// Idempotency: handler must check BOTH markers, not just one
if (/current\.includes\(MEMORY_INJECT_MARKER\).*\|\|.*current\.includes\(MEMORY_INJECT_MARKER_SUBAGENT\)|current\.includes\(MEMORY_INJECT_MARKER_SUBAGENT\).*\|\|.*current\.includes\(MEMORY_INJECT_MARKER\)/.test(memSrc)) {
  ok("idempotency: handler skips if EITHER marker present (no double-inject)");
} else {
  bad("idempotency: marker check does not include both variants");
}

// ── dispatch/index.ts: default tool allowlist ──────────────────

console.log("\n  dispatch/index.ts default tool allowlist:");
const disSrc = readFileSync(resolve(repoRoot, "extensions/dispatch/index.ts"), "utf8");

// All 4 default allowlist sites should include memory_search/get/neighbors/decide
const defaultPattern = /read,grep,find,ls,web_search,web_fetch,memory_search,memory_get,memory_neighbors,memory_decide/;
const matches = disSrc.match(new RegExp(defaultPattern.source, "g"));
if (matches && matches.length >= 4) {
  ok(`default allowlist contains memory_search/get/neighbors/decide in all ${matches.length} sites`);
} else {
  bad(`expected ≥4 default allowlist sites; found ${matches ? matches.length : 0}`);
}

// memory_list explicitly NOT in default (T0 consensus: too broad)
const memListMatch = disSrc.match(/"read,grep,find,ls,web_search,web_fetch,memory_search[^"]*?memory_list[^"]*"/);
if (memListMatch) {
  bad(`memory_list incorrectly added to default allowlist: ${memListMatch[0]}`);
} else {
  ok("memory_list correctly EXCLUDED from default allowlist (DeepSeek + GPT-5.5 vote)");
}

// KNOWN_TOOLS should still include memory_list (callers can opt in explicitly)
if (/KNOWN_TOOLS[\s\S]{0,500}memory_list/.test(disSrc)) {
  ok("memory_list remains in KNOWN_TOOLS for explicit opt-in");
} else {
  bad("memory_list missing from KNOWN_TOOLS — caller can no longer pass it");
}

// ── Summary ────────────────────────────────────────────────────

console.log();
if (fail === 0) {
  console.log(`✅ memory sub-agent prompt variant: all ${pass} checks passed`);
  process.exit(0);
} else {
  console.error(`❌ memory sub-agent prompt variant: ${fail} failure(s) out of ${pass + fail}`);
  process.exit(1);
}
