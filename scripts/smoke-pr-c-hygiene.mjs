#!/usr/bin/env node
/**
 * Smoke: PR-C hygiene fixes for ADR 0024-0028 audit plan (F10-F15).
 *
 * Source-level smoke by design: these fixes are persistence/audit wiring
 * invariants where static code shape catches the regression cheaply without
 * spinning up pi runtime, real LLM dispatch, or abrain side effects.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

function src(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf-8");
}

const memoryTypes = src("extensions/memory/types.ts");
const memoryParser = src("extensions/memory/parser.ts");
const memoryIndex = src("extensions/memory/index.ts");
const memoryDecide = src("extensions/memory/decide.ts");
const writer = src("extensions/sediment/writer.ts");
const correctionPipeline = src("extensions/sediment/correction-pipeline.ts");
const stagingLoader = src("extensions/sediment/staging-loader.ts");
const sedimentIndex = src("extensions/sediment/index.ts");
const multiviewTypes = src("extensions/sediment/multiview-staging-types.ts");
const multiviewIo = src("extensions/sediment/multiview-staging-io.ts");
const multiviewReplay = src("extensions/sediment/multiview-staging-replay.ts");
const outcomeCollector = src("extensions/sediment/outcome-collector.ts");
const dispatch = src("extensions/dispatch/index.ts");

console.log("Section: F10 provenance round-trip");

check("MemoryEntry includes provenance axis", () => {
  if (!/provenance:\s*string;/.test(memoryTypes)) throw new Error("MemoryEntry.provenance missing");
});

check("parser reads canonical provenance and defaults legacy entries", () => {
  for (const re of [
    /const CANONICAL_PROVENANCE = new Set\(/,
    /scalarString\(frontmatter\.provenance\)/,
    /CANONICAL_PROVENANCE\.has\(provenanceRaw\)/,
    /:\s*"assistant-observed"/,
    /provenance,\n\s*title,/,
  ]) {
    if (!re.test(memoryParser)) throw new Error(`parser provenance invariant missing: ${re}`);
  }
});

check("writer serializes provenance frontmatter with default", () => {
  for (const re of [
    /const provenance = draft\.provenance \?\? "assistant-observed"/,
    /`provenance: \$\{yamlString\(provenance\)\}`/,
    /"confidence", "provenance", "schema_version"/,
  ]) {
    if (!re.test(writer)) throw new Error(`writer provenance invariant missing: ${re}`);
  }
});

console.log("\nSection: F11 staging twin cleanup");

check("staging slug builder is shared between stage and cleanup", () => {
  if (!/export function buildProvisionalStagingSlug/.test(correctionPipeline)) throw new Error("buildProvisionalStagingSlug not exported");
  if (!/slug:\s*buildProvisionalStagingSlug\(signal, seedText\)/.test(correctionPipeline)) throw new Error("buildProvisionalStagingEntry must use shared slug builder");
  if (!/import \{ buildProvisionalStagingEntry, buildProvisionalStagingSlug/.test(sedimentIndex)) throw new Error("sediment index must import shared slug builder");
});

check("tier1_direct successful write removes matching staging entries", () => {
  if (!/export function removeStagingEntriesBySlug/.test(stagingLoader)) throw new Error("removeStagingEntriesBySlug not exported");
  if (!/result\.status === "created" \|\| result\.status === "updated"/.test(sedimentIndex)) throw new Error("tier1 cleanup must be gated on successful write statuses");
  if (!/removeStagingEntriesBySlug\(buildProvisionalStagingSlug\(tier1Signal, window\.text\)\)/.test(sedimentIndex)) throw new Error("tier1 path does not remove matching staging slug");
  if (!/tier1_staging_cleanup/.test(sedimentIndex)) throw new Error("tier1 cleanup audit field missing");
});

console.log("\nSection: F12 replay intent marker");

check("multiview pending entry stores brain_write_intent_at_iso", () => {
  if (!/brain_write_intent_at_iso\?:\s*string/.test(multiviewTypes)) throw new Error("brain_write_intent_at_iso type missing");
});

check("replay persists intent before writer call", () => {
  if (!/export function markMultiviewPendingBrainWriteIntent/.test(multiviewIo)) throw new Error("intent marker IO function missing");
  if (!/markMultiviewPendingBrainWriteIntent\(entry\.slug, intentAtIso, finalDecision\)/.test(multiviewReplay)) throw new Error("replay must persist intent before writeApprovedToBrain");
  const intentIdx = multiviewReplay.indexOf("markMultiviewPendingBrainWriteIntent(entry.slug, intentAtIso, finalDecision)");
  const writeIdx = multiviewReplay.indexOf("await deps.writeApprovedToBrain(finalDecision, draft");
  if (intentIdx < 0 || writeIdx < 0 || intentIdx > writeIdx) throw new Error("intent marker must precede brain write");
});

check("known writer failures clear intent so approved non-create ops can retry", () => {
  if (!/delete loaded\.parsed\.entry\.brain_write_intent_at_iso/.test(multiviewIo)) throw new Error("writer failure updater must clear stale intent marker");
  if (!/updateMultiviewPendingWriterFailure\([\s\S]{0,500}?finalDecision,/.test(multiviewReplay)) throw new Error("writer catch path must persist retry metadata via updateMultiviewPendingWriterFailure");
});

check("ambiguous crash intent suppresses fresh non-idempotent replay and stale-archives later", () => {
  if (!/entry\.brain_write_intent_at_iso && entry\.approved_decision && entry\.approved_decision\.op !== "create"/.test(multiviewReplay)) throw new Error("non-idempotent intent guard missing");
  if (!/writer replay suppressed, manual inspection required/.test(multiviewReplay)) throw new Error("fresh suppressed replay audit detail missing");
  if (!/ageDays >= STALE_DAYS_MULTIVIEW_PENDING/.test(multiviewReplay)) throw new Error("ambiguous intent guard must eventually release replay budget through stale archive");
  if (!/entry soft-archived to abandoned\/ for manual inspection/.test(multiviewReplay)) throw new Error("ambiguous stale intent archive detail missing");
});

console.log("\nSection: F13 dispatch audit singleFlight");

check("dispatch audit uses per-file singleFlight chain", () => {
  for (const re of [
    /Symbol\.for\("pi-astack\/dispatch\/audit-singleflight\/v1"\)/,
    /const prior = chains\.get\(auditPath\) \?\? Promise\.resolve\(\)/,
    /const next = prior\.catch\(\(\) => \{\}\)\.then\(async \(\) => \{/,
    /if \(chains\.get\(auditPath\) === next\) chains\.delete\(auditPath\)/,
  ]) {
    if (!re.test(dispatch)) throw new Error(`dispatch singleFlight invariant missing: ${re}`);
  }
});

console.log("\nSection: F14 outcome ledger audit and counter cleanup");

check("outcome ledger write failure emits audit row", () => {
  if (!/function appendOutcomeLedgerFailureAudit/.test(outcomeCollector)) throw new Error("failure audit helper missing");
  if (!/operation:\s*"outcome_ledger_write_failed"/.test(outcomeCollector)) throw new Error("failure audit operation missing");
  if (!/catch \(err\) \{\n\s*appendOutcomeLedgerFailureAudit\(projectRoot, rows, err\)/.test(outcomeCollector)) throw new Error("writeOutcomeLedger catch must audit failure");
});

check("decision brief seq counters prune on session_start", () => {
  if (!/export function pruneDecisionBriefSeqCountersForSession/.test(memoryDecide)) throw new Error("counter prune export missing");
  if (!/if \(!key\.startsWith\(prefix\)\) _briefSeqCounters\.delete\(key\)/.test(memoryDecide)) throw new Error("counter prune must remove non-current session keys");
  if (!/pruneDecisionBriefSeqCountersForSession\(sessionId\)/.test(memoryIndex)) throw new Error("memory session_start must call counter prune");
});

console.log("\nSection: F15 heartbeat consumer wiring");

check("dispatch enriches audit fields from heartbeat consumer without changing settled result", () => {
  for (const re of [
    /const DISPATCH_AUDIT_VERSION = 3;/,
    /import \{ assessLivenessForAnchor \} from "\.\/heartbeat-consumer"/,
    /const heartbeat_liveness = assessLivenessForAnchor\(heartbeatProjectRoot, heartbeatAnchor\)/,
    /return enrichHeartbeat\(result\)/,
    /heartbeat_trace_path/,
    /heartbeat_liveness/,
  ]) {
    if (!re.test(dispatch)) throw new Error(`heartbeat wiring invariant missing: ${re}`);
  }
  if (/terminalStateFromLiveness\(heartbeat_liveness\)/.test(dispatch)) {
    throw new Error("post-settlement heartbeat enrichment must be audit-only and must not mutate terminal_state/failureType");
  }
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\n✅ PR-C hygiene invariants hold");
