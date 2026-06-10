#!/usr/bin/env node
/**
 * Smoke: Tier-1 directive defer-resolution gate (multi-view.ts `case "defer"`).
 *
 * Live bug (2026-06-08): a user-expressed durable CREATE directive ("所有 GitHub
 * 仓库必须使用 gh") was routed through multi-view; Pass 1 said scope=project,
 * curator said global, Pass 2 DEFERRED on the split -> stageAndSkipDecision
 * -> replay loop -> terminal_max_retries -> abandoned/ = silent functional loss.
 *
 * Fix (3×T0 unanimous): in the defer arm, if shouldEscalateToCurator(signal) the
 * candidate commits the proposer decision (deterministic Tier-1, identical to the
 * confirm_proposer path) instead of staging. The guard reuses the SAME structural
 * gate that admitted the candidate to multi-view, so it cannot widen the set and
 * keeps the A'-layer closed for probabilistic (assistant-observed) candidates.
 *
 * This asserts the GATE (which signals trigger deterministic commit vs stay on the
 * probabilistic replay path). The defer->commit branch itself is byte-identical to
 * confirm_proposer and is validated end-to-end by the live gh-rule replay.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const cp = await jiti.import(`${repoRoot}/extensions/sediment/correction-pipeline.ts`);
const { shouldEscalateToCurator } = cp;

const failures = [];
let total = 0;
function assert(cond, msg) { total++; if (!cond) { failures.push(msg); console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`); }

// The exact shape of the live staged gh directive's correction_signal.
const ghDirective = {
  signal_found: true,
  typing: "durable",
  target_entry_slug: null,
  confidence: 8,
  provenance: "user-expressed",
  quote_source: "user_message",
};

// 1. The live directive class commits deterministically (defer arm fires).
assert(shouldEscalateToCurator(ghDirective) === true, "user-expressed durable create directive -> deterministic commit");

// 2. A'-layer: assistant-observed stays on the probabilistic replay path.
assert(shouldEscalateToCurator({ ...ghDirective, provenance: "assistant-observed" }) === false, "assistant-observed -> still staged (A'-layer closed)");

// 3. content-in-transcript ('always use Yarn' README trap) stays staged.
assert(shouldEscalateToCurator({ ...ghDirective, provenance: "content-in-transcript", quote_source: "transcript_content" }) === false, "content-in-transcript -> still staged");

// 4. Below the Tier-1 confidence floor stays staged — for NON-directive
//    signals (the conf≥8 fallback path; PR-2 O5 convergence).
assert(shouldEscalateToCurator({ ...ghDirective, confidence: 7 }) === false, "confidence 7 non-directive -> still staged");

// 4b. PR-2 (ADR 0028 R2' recall bias): is_directive=true EXEMPTS the
//     confidence gate — the same signal at conf 7 commits when the
//     classifier marked it an imperative directive.
assert(shouldEscalateToCurator({ ...ghDirective, confidence: 7, is_directive: true }) === true, "confidence 7 directive -> Tier-1 (conf gate exempted)");

// 5. Non-durable (task-local) stays staged.
assert(shouldEscalateToCurator({ ...ghDirective, typing: "task-local" }) === false, "task-local -> still staged");

// 6. A targeted UPDATE (has target_entry_slug) is not a CREATE directive.
assert(shouldEscalateToCurator({ ...ghDirective, target_entry_slug: "some-entry" }) === false, "has target_entry_slug -> not a tier-1 create directive");

// 7. No signal / null tolerated.
assert(shouldEscalateToCurator({ ...ghDirective, signal_found: false }) === false, "signal_found=false -> false");
assert(shouldEscalateToCurator(null) === false, "null signal -> false (no throw)");

if (failures.length) { console.log(`\nFAIL — ${failures.length} of ${total} failed.`); process.exit(1); }
console.log(`\nPASS — ${total} assertions (tier-1 directive defer-resolution gate).`);
