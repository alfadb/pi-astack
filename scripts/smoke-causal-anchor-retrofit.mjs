#!/usr/bin/env node
/**
 * Smoke: ADR 0027 C6b audit-writer retrofit invariants.
 *
 * Each pi-astack JSON audit/ledger/metric writer MUST attach the
 * cross-layer causal anchor (session_id, turn_id, optional subturn)
 * so a `tail audit.jsonl | jq 'select(.session_id == X and .turn_id == Y)'`
 * query can reconstruct one user turn across L1 (sediment / abrain /
 * compaction-tuner) and L2 (dispatch already covered by C6a) loops.
 *
 * Structural verification: for each writer file, assert:
 *   (i)  imports getCurrentAnchor + spreadAnchor from ../_shared/causal-anchor
 *   (ii) calls spreadAnchor(getCurrentAnchor()) inside the writer body
 *
 * # Why structural (not behavioural)
 *
 * The behavioural contract (anchor really appears in jsonl rows) is
 * exercised end-to-end in real dispatch / sediment runs and verified
 * by post-restart inspection of audit.jsonl. Structural assertions here
 * catch the regression where someone adds a NEW writer or refactors an
 * existing one and forgets to attach the anchor — at which point the C6
 * "every row has anchor" invariant silently breaks.
 *
 * # Out of scope
 *
 * - model-fallback canary.log: plain text by design (grep-friendly diagnostic
 *   stream), not JSON. C6 anchor injection would corrupt format. If
 *   cross-layer join is ever needed for fallback events, add a separate
 *   model-fallback-events.jsonl writer; this smoke would then cover it.
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

// ── Writers covered by C6b ──────────────────────────────────────
// Each entry: { file, label, writerSearchPattern (regex on file text) }
//
// writerSearchPattern matches the LINES where the writer constructs its
// enriched object — we then verify spreadAnchor(getCurrentAnchor()) appears
// within ~10 lines of that match.

const writers = [
  {
    file: "extensions/sediment/writer.ts",
    label: "sediment audit.jsonl (appendAudit)",
    auditFile: ".pi-astack/sediment/audit.jsonl",
    // Match the enriched-object construction inside appendAudit
    anchorWindow: /const enriched = \{[\s\S]{0,500}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,500}\.\.\.event,\s*\};/,
  },
  {
    file: "extensions/sediment/llm-extractor.ts",
    label: "sediment extractor-metrics.jsonl",
    auditFile: "~/.abrain/.state/sediment/extractor-metrics.jsonl",
    anchorWindow: /const enriched = \{[\s\S]{0,300}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,300}\.\.\.entry,\s*\};/,
  },
  {
    file: "extensions/sediment/curator.ts",
    label: "sediment curator-metrics.jsonl",
    auditFile: "~/.abrain/.state/sediment/curator-metrics.jsonl",
    anchorWindow: /const enriched = \{[\s\S]{0,300}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,300}\.\.\.entry,\s*\};/,
  },
  {
    file: "extensions/compaction-tuner/index.ts",
    label: "compaction-tuner audit.jsonl (local appendAudit)",
    auditFile: ".pi-astack/compaction-tuner/audit.jsonl",
    anchorWindow: /const enriched = \{[\s\S]{0,400}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,400}\.\.\.row,\s*\};/,
  },
  {
    file: "extensions/abrain/git-sync.ts",
    label: "abrain git-sync.jsonl (local audit)",
    auditFile: "~/.abrain/.state/git-sync.jsonl",
    anchorWindow: /JSON\.stringify\(\{\s*\.\.\.spreadAnchor\(getCurrentAnchor\(\)\),\s*\.\.\.event\s*\}\)/,
  },
  {
    file: "extensions/abrain/vault-writer.ts",
    label: "abrain vault-events.jsonl (appendVaultEvent)",
    auditFile: "~/.abrain/.state/vault-events.jsonl",
    anchorWindow: /const enriched = \{[\s\S]{0,400}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,400}\.\.\.ev,\s*\};/,
  },
  // ── R1 P1-3 additions: previously-missing JSONL writers ──
  {
    file: "extensions/sediment/outcome-collector.ts",
    label: "sediment outcome-ledger.jsonl (writeOutcomeLedger)",
    auditFile: "~/.abrain/.state/sediment/outcome-ledger.jsonl",
    // outcome-collector pushes into a `lines` array, not an `enriched` const.
    // Match the inline JSON.stringify spread shape directly.
    anchorWindow: /JSON\.stringify\(\{\s*\.\.\.spreadAnchor\(getCurrentAnchor\(\)\),\s*\.\.\.row,/,
  },
  {
    file: "extensions/sediment/aggregator.ts",
    label: "sediment aggregator-ledger.jsonl (writeAggregatorLedger)",
    auditFile: "~/.abrain/.state/sediment/aggregator-ledger.jsonl",
    // P1-3 added writer: anchor first, then ...summary. Trailing comma
    // optional per formatter style.
    anchorWindow: /const enrichedSummary = \{[\s\S]{0,300}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,300}\.\.\.summary,?\s*\};/,
  },
  {
    file: "extensions/memory/llm-search.ts",
    label: "memory search-metrics.jsonl (logSearchMetrics)",
    auditFile: ".pi-astack/memory/search-metrics.jsonl",
    anchorWindow: /const enriched = \{[\s\S]{0,300}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,300}\.\.\.entry,?\s*\};/,
  },
  {
    file: "extensions/sediment/multi-view.ts",
    label: "sediment multi-view-metrics.jsonl (logReviewerMetrics)",
    auditFile: "~/.abrain/.state/sediment/multi-view-metrics.jsonl",
    anchorWindow: /const enriched = \{[\s\S]{0,300}spreadAnchor\(getCurrentAnchor\(\)\)[\s\S]{0,300}\.\.\.entry,?\s*\};/,
  },
];

// dispatch is C6a, but verify for completeness — same invariant
const c6aWriters = [
  {
    file: "extensions/dispatch/index.ts",
    label: "dispatch audit.jsonl (C6a appendDispatchAudit)",
    auditFile: ".pi-astack/dispatch/audit.jsonl",
    anchorWindow: /const row = \{[\s\S]{0,400}spreadAnchor\(anchor\)[\s\S]{0,400}\.\.\.event,\s*\};/,
  },
];

console.log("ADR 0027 C6b audit-writer retrofit (anchor injection)");

function checkWriter({ file, label, anchorWindow }) {
  const src = readFileSync(resolve(repoRoot, file), "utf8");
  // (i) imports
  const importPresent = /import\s*\{[^}]*\bgetCurrentAnchor\b[^}]*\bspreadAnchor\b[^}]*\}\s*from\s*["'][^"']*causal-anchor/.test(src)
    || /import\s*\{[^}]*\bspreadAnchor\b[^}]*\bgetCurrentAnchor\b[^}]*\}\s*from\s*["'][^"']*causal-anchor/.test(src);
  if (importPresent) {
    ok(`${label}: imports getCurrentAnchor + spreadAnchor from causal-anchor`);
  } else {
    bad(`${label}: MISSING import of getCurrentAnchor / spreadAnchor`);
  }
  // (ii) enriched object construction includes spreadAnchor call
  if (anchorWindow.test(src)) {
    ok(`${label}: writer body calls spreadAnchor(getCurrentAnchor()) inside enriched construction`);
  } else {
    bad(`${label}: enriched object does NOT include spreadAnchor(getCurrentAnchor()) in expected window`);
  }
}

// ── C6b retrofits (this PR) ─────────────────────────────────────

console.log("\n  C6b retrofits:");
for (const w of writers) checkWriter(w);

// ── C6a baseline (sanity — pinned by previous PR) ──────────────

console.log("\n  C6a baseline (regression sanity):");
for (const w of c6aWriters) checkWriter(w);

// ── Exclusion documented ───────────────────────────────────────

console.log("\n  documented exclusions:");
const mfSrc = readFileSync(resolve(repoRoot, "extensions/model-fallback/index.ts"), "utf8");
const hasSpreadAnchor = /spreadAnchor\(getCurrentAnchor\(\)\)/.test(mfSrc);
if (!hasSpreadAnchor) {
  ok("model-fallback/index.ts: NOT retrofitted (canary.log is plain text by design — documented in C6b commit)");
} else {
  bad("model-fallback/index.ts: anchor injection unexpectedly added — canary.log is plain text, not JSON");
}

// ── Causal-anchor source itself: helpers stay pure ─────────────

console.log("\n  causal-anchor invariants:");
const caSrc = readFileSync(resolve(repoRoot, "extensions/_shared/causal-anchor.ts"), "utf8");
if (/export function spreadAnchor/.test(caSrc) && /Returns the partial object/.test(caSrc)) {
  ok("spreadAnchor is a pure function (returns plain object, no side effects)");
} else {
  bad("spreadAnchor docstring or signature unexpected");
}
if (/export function getCurrentAnchor.*\)\s*:\s*CausalAnchor \| undefined/.test(caSrc)) {
  ok("getCurrentAnchor returns CausalAnchor | undefined (no throw)");
} else {
  bad("getCurrentAnchor signature regressed");
}

// ── Summary ────────────────────────────────────────────────────

console.log();
if (fail === 0) {
  console.log(`✅ C6b retrofit: all ${pass} checks passed`);
  process.exit(0);
} else {
  console.error(`❌ C6b retrofit: ${fail} failure(s) out of ${pass + fail}`);
  process.exit(1);
}
