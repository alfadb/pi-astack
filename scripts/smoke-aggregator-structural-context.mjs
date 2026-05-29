#!/usr/bin/env node
/**
 * Smoke: aggregator STRUCTURAL_CONTEXT staleness lint
 * (ADR 0025 §4.3 Phase C.1.a + round-2 review DeepSeek P1-3 follow-up).
 *
 * STRUCTURAL_CONTEXT in extensions/sediment/aggregator.ts is a hardcoded
 * list of known-unimplemented capabilities. The v1 prompt reads it as
 * input feed 4 so the LLM can demote recurring noise from
 * known-unimplemented features instead of re-discovering them as new
 * findings every run.
 *
 * Maintenance hazard: when one of these capabilities ships, a
 * developer must remove the corresponding STRUCTURAL_CONTEXT entry
 * in the same commit. If forgotten, the v1 LLM permanently treats a
 * now-fixed capability as unimplemented noise — not catastrophic
 * (the LLM sees actual data) but semantically wrong.
 *
 * This smoke pairs each STRUCTURAL_CONTEXT entry with a "still
 * unimplemented" signature (a code/file pattern that should remain
 * absent until the capability ships). If a signature becomes present,
 * the smoke fails and tells the developer to delete the corresponding
 * STRUCTURAL_CONTEXT entry.
 *
 * Why this is acceptable (vs the ADR 0024 §3 "no mechanical
 * threshold" stance): this is a LINT on DEVELOPER WORKFLOW (file
 * presence in source tree), NOT a gate on LLM behavior. It enforces
 * the maintenance contract documented in aggregator.ts STRUCTURAL_CONTEXT
 * header comment.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const failures = [];
let totalChecks = 0;
function check(name, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log("Smoke: aggregator STRUCTURAL_CONTEXT staleness lint\n");

// ──────────────────────────────────────────────────────────────────
// Step 1: parse STRUCTURAL_CONTEXT entries from aggregator.ts source
// ──────────────────────────────────────────────────────────────────

const aggSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/sediment/aggregator.ts"),
  "utf8",
);

// Find each `id: "..."` inside the STRUCTURAL_CONTEXT array. We grab
// the whole declaration block via balanced-bracket heuristic.
const declMatch = /export const STRUCTURAL_CONTEXT:\s*[^=]*=\s*\[([\s\S]*?)\];/m.exec(aggSrc);
if (!declMatch) {
  console.error("STRUCTURAL_CONTEXT declaration not found in aggregator.ts");
  process.exit(1);
}
const declBody = declMatch[1];
const idMatches = [...declBody.matchAll(/id:\s*"([^"]+)"/g)];
const idsInSource = idMatches.map((m) => m[1]);

console.log(`Found ${idsInSource.length} STRUCTURAL_CONTEXT entries: ${idsInSource.join(", ")}\n`);

// ──────────────────────────────────────────────────────────────────
// Step 2: pair each id with an "unimplemented" signature
// ──────────────────────────────────────────────────────────────────

/**
 * Each entry: { id, description (what should NOT exist), shouldBeAbsent }
 * shouldBeAbsent runs returning either true (still unimplemented, ok) or
 * a string describing what was found (capability shipped, fail).
 */
const KNOWN_ENTRIES = {
  // 2026-05-29 Stage 3: the staging-RESOLVER shipped (non-destructive triage),
  // but it does NOT delete provisional staging files — so the structural entry
  // was RENAMED to "staging-backlog-deletion-unimplemented" (the remaining gap
  // is the age-out DELETION sweep, not resolution). Its staleness signature
  // therefore checks for a DELETER, not for the resolver module.
  "staging-backlog-deletion-unimplemented": {
    description: "ADR 0025 §4.1.5 mechanical age-out deletion sweep for provisional staging",
    /** Returns true while no age-out sweep deletes provisional staging files.
     *  Ships when staging-resolver.ts unlinks stale provisional-correction
     *  entries (e.g. a sweepStaleStagingEntries / ageOut function). */
    shouldBeAbsent: () => {
      const resolverSrc = fs.readFileSync(
        path.join(repoRoot, "extensions/sediment/staging-resolver.ts"),
        "utf8",
      );
      // Match only a dedicated age-out/sweep function name — NOT the advisory
      // lock's unlinkSync (releaseLock), which is unrelated to staging files.
      const shipped = /\b(?:sweepStaleStagingEntries|ageOutStaging|deleteStaleStaging)\s*\(/.test(resolverSrc);
      if (shipped) {
        return "staging-resolver.ts appears to delete provisional staging files — age-out sweep may have shipped; remove this STRUCTURAL_CONTEXT entry.";
      }
      return true;
    },
  },
  // 2026-05-28 Stage 2 cleanup: "archive-reactivation-reviewer-unimplemented"
  // removed from KNOWN_ENTRIES in the same commit that removed it from
  // STRUCTURAL_CONTEXT. The reviewer shipped: prompt at
  // extensions/sediment/prompts/archive-reactivation-reviewer-v1.md,
  // module at extensions/sediment/archive-reactivation.ts,
  // sediment/index.ts integrates it via scheduleAggregator, and
  // promptVersion.archiveReactivationReviewer is bumped to "v1".
  // 2026-05-28 cleanup: "p15-writer-dispatch-stub" removed from
  // STRUCTURAL_CONTEXT in the same commit — writer dispatch was shipped
  // earlier than the ADR text reflected, so the entry was always stale.
  // The remaining P1.5 limitation (Pass 1 schema rich-payload synthesis)
  // is tracked structurally in P15WatchdogSignals, not here.
};

// ──────────────────────────────────────────────────────────────────
// Step 3: verify every source entry has a known signature + check it
// ──────────────────────────────────────────────────────────────────

check("every STRUCTURAL_CONTEXT id has a known unimplemented-signature", () => {
  const unknownIds = idsInSource.filter((id) => !KNOWN_ENTRIES[id]);
  if (unknownIds.length > 0) {
    throw new Error(
      `STRUCTURAL_CONTEXT contains unknown ids without a staleness check: ${unknownIds.join(", ")}. ` +
      `If you added a new structural-context entry, add a corresponding KNOWN_ENTRIES check to this smoke. ` +
      `Otherwise this smoke can't detect when the capability ships.`,
    );
  }
});

check("every KNOWN_ENTRIES signature is present in source (no orphan)", () => {
  const knownIds = Object.keys(KNOWN_ENTRIES);
  const orphanIds = knownIds.filter((id) => !idsInSource.includes(id));
  if (orphanIds.length > 0) {
    throw new Error(
      `KNOWN_ENTRIES has signatures for ids not in STRUCTURAL_CONTEXT: ${orphanIds.join(", ")}. ` +
      `Either re-add the source entry or delete the KNOWN_ENTRIES check.`,
    );
  }
});

// Per-id staleness check.
for (const id of idsInSource) {
  const entry = KNOWN_ENTRIES[id];
  if (!entry) continue; // already failed above
  check(`STRUCTURAL_CONTEXT[${id}] capability is still unimplemented`, () => {
    const result = entry.shouldBeAbsent();
    if (result !== true) {
      throw new Error(
        `${result}\n` +
        `        STALENESS: please remove STRUCTURAL_CONTEXT[${id}] from aggregator.ts ` +
        `in the same commit that ships ${entry.description}, ` +
        `and update the aggregator v1 prompt's structural_context handling if needed.`,
      );
    }
  });
}

// ──────────────────────────────────────────────────────────────────
// Wrap-up
// ──────────────────────────────────────────────────────────────────

console.log(`\nTotal: ${totalChecks}  Passed: ${totalChecks - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — STRUCTURAL_CONTEXT staleness lint detected drift.");
  console.log("Either ship the capability and delete the entry, or update this smoke if the signature changed.");
  process.exit(1);
}
