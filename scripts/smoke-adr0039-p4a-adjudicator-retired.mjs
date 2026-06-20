#!/usr/bin/env node
/**
 * smoke-adr0039-p4a-adjudicator-retired — ADR0039 Constraint P4-a gate.
 *
 * 4×T0 unanimous (2026-06-20). Proves the Tier-1 write-time ruleset/Jaccard
 * adjudicator is RETIRED and the constraint-evidence-append failure handling
 * is correct, on two axes:
 *
 *  (A) CODE SHAPE — the adjudicator imports/calls are gone, the rollback write
 *      is a deterministic storage-only writeAbrainRule, and isTerminalTier1Reject
 *      is "default-terminal except :write_failed" for constraint append faults.
 *  (B) DEPLOYED CONFIG — the live agent config routes constraints through
 *      event_first with both legacy bypass flags false, which (given the code
 *      shape) makes the storage-only rollback create path UNREACHABLE in prod.
 *
 * Together (A)+(B) are the objective proof opus required as the P4-a SIGN gate:
 * production is not silently routed through the new storage-only path.
 *
 * Pure source-string + JSON assertions; no TS loader needed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const failures = [];
let total = 0;
function check(name, ok, detail = "") {
  total += 1;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const indexSrc = fs.readFileSync(path.join(repoRoot, "extensions", "sediment", "index.ts"), "utf8");
const settingsSrc = fs.readFileSync(path.join(repoRoot, "extensions", "sediment", "settings.ts"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));

console.log("ADR0039 P4-a adjudicator retirement");

// --- (A) code shape -------------------------------------------------------

check(
  "index.ts no longer imports the retired adjudicators",
  !indexSrc.includes('from "./tier1-ruleset-adjudicator"') && !indexSrc.includes('from "./tier1-adjudicator"'),
  "an import from a deleted adjudicator module is still present",
);

check(
  "index.ts no longer calls resolveRuleWrite / resolveTier1JaccardHit / runTier1JaccardAdjudication",
  !indexSrc.includes("resolveRuleWrite(")
    && !indexSrc.includes("resolveTier1JaccardHit(")
    && !indexSrc.includes("runTier1JaccardAdjudication("),
  "a retired adjudicator call site is still present in index.ts",
);

check(
  "retired flags removed from index.ts logic (tier1RuleSetAdjudication / tier1JaccardShadowAudit)",
  !indexSrc.includes("tier1RuleSetAdjudication") && !indexSrc.includes("tier1JaccardShadowAudit"),
  "a retired flag is still read in index.ts",
);

check(
  "rollback write is the deterministic storage-only create (p4a marker present)",
  indexSrc.includes("p4a_rollback_storage_only"),
  "storage-only rollback marker missing — adjudicator block may not have been replaced",
);

check(
  "isTerminalTier1Reject: constraint append faults are default-terminal except :write_failed",
  indexSrc.includes('result.reason.startsWith("constraint_evidence_append_failed:")')
    && indexSrc.includes('result.reason !== "constraint_evidence_append_failed:write_failed"'),
  "the default-terminal-except-write_failed inversion is missing (GAP-1 infinite-HOLD fix)",
);

check(
  "adjudicator source files are deleted from disk",
  !fs.existsSync(path.join(repoRoot, "extensions", "sediment", "tier1-ruleset-adjudicator.ts"))
    && !fs.existsSync(path.join(repoRoot, "extensions", "sediment", "tier1-adjudicator.ts")),
  "a retired adjudicator .ts still exists",
);

// --- (A') settings + schema: retired flags gone, live flag kept ----------

// Match declarations/defaults/parser usage, NOT explanatory comment mentions:
// the doc comment above tier1JaccardCuratorLane intentionally names the retired
// flags to record what P4-a removed.
const retiredDeclOrUse = (src) =>
  /tier1RuleSetAdjudication\s*:/.test(src)
  || /tier1JaccardShadowAudit\s*:/.test(src)
  || /cfg\.tier1RuleSetAdjudication/.test(src)
  || /cfg\.tier1JaccardShadowAudit/.test(src)
  || /settings\.tier1RuleSetAdjudication/.test(src)
  || /settings\.tier1JaccardShadowAudit/.test(src)
  || /DEFAULT_SEDIMENT_SETTINGS\.tier1RuleSetAdjudication/.test(src)
  || /DEFAULT_SEDIMENT_SETTINGS\.tier1JaccardShadowAudit/.test(src);
check(
  "settings.ts dropped the retired flag type/default/parser",
  !retiredDeclOrUse(settingsSrc),
  "a retired flag is still declared/defaulted/parsed in settings.ts",
);

check(
  "settings.ts keeps the live Tier-2 flag tier1JaccardCuratorLane",
  settingsSrc.includes("tier1JaccardCuratorLane"),
  "tier1JaccardCuratorLane must remain (live in curator-decision-writer.ts Tier-2 path)",
);

const sedimentSchemaProps = schema.properties?.sediment?.properties ?? {};
check(
  "schema dropped the retired flags",
  !Object.hasOwn(sedimentSchemaProps, "tier1RuleSetAdjudication")
    && !Object.hasOwn(sedimentSchemaProps, "tier1JaccardShadowAudit"),
  "a retired flag is still declared in pi-astack-settings.schema.json",
);

check(
  "schema keeps tier1JaccardCuratorLane",
  Object.hasOwn(sedimentSchemaProps, "tier1JaccardCuratorLane"),
  "tier1JaccardCuratorLane missing from schema",
);

// --- (B) deployed config makes the rollback path unreachable in prod ------

const deployedPath = path.resolve(repoRoot, "..", "..", "pi-astack-settings.json");
if (fs.existsSync(deployedPath)) {
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const w = deployed?.sediment?.constraintEvidenceEventWriter ?? {};
  check(
    "deployed config routes constraints through event_first (rollback create unreachable)",
    w.enabled === true
      && w.mode === "event_first"
      && w.legacyFallbackOnEventFailure === false
      && w.legacyRuleWriteOnSuccessfulEvent === false,
    `constraintEvidenceEventWriter=${JSON.stringify(w)} — must be {enabled:true,mode:"event_first",legacyFallbackOnEventFailure:false,legacyRuleWriteOnSuccessfulEvent:false}`,
  );
} else {
  check("deployed config present at ../../pi-astack-settings.json", false, `not found: ${deployedPath}`);
}

console.log(`\nsummary: ${total - failures.length}/${total} check(s) passed.`);
if (failures.length) {
  console.log(`FAIL — ${failures.length}/${total} P4-a retirement check(s) failed.`);
  process.exit(1);
}
console.log("PASS — ADR0039 P4-a adjudicator retirement verified.");
process.exit(0);
