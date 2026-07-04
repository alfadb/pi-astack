#!/usr/bin/env node
/**
 * smoke-outcome-classifier-enrich — ADR 0025 §4.2.5 P2.A
 * (docs/notes/outcome-to-classifier-feedback-design.md).
 *
 * Verifies the outcome→classifier enrichment building blocks + the
 * 3-T0 Round-1 must-nail-down constraints:
 *   [1] sanitizeSlug strips scope prefixes → bare (opus: same-namespace match).
 *   [2] normalizeProjectRoot resolves abs / "" for empty.
 *   [3] readProjectOutcomeRows is PROJECT-SCOPED: project A read never
 *       includes project B rows for a same-named slug (gpt+deepseek BLOCKING).
 *   [4] readProjectOutcomeRows("") → [] (unscoped guard; gpt constraint).
 *   [5] summarizeEntryActivity over project-A rows: counts + echo-chamber
 *       (including source=path-a-implicit as retrieved-unused baseline);
 *       ABSENT slug → zeroed record (deepseek: proves
 *       the caller's last_seen/count>0 hasData guard is required).
 *   [6] Isolation end-to-end: summarize(readProjectOutcomeRows(A),["shared"])
 *       sees ONLY A's count, not A+B.
 *   [7] buildClassifierPrompt renders the track-record line (incl ⚠️ +
 *       last_seen) for a card WITH outcome_activity, and "(none recorded)"
 *       for a card WITHOUT.
 *   [8] Prompt carries the DISCOUNT guidance (direction-correct, not
 *       "echo-chamber → correction more credible").
 *   [9] scoped related slug (project:pi:shared) sanitizes to the bare
 *       ledger slug → would match (opus hardening).
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");

// Sandbox the user-global ledger into a tmp ABRAIN_ROOT BEFORE loading code.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "p2a-enrich-"));
process.env.ABRAIN_ROOT = tmpHome;
const ledgerDir = path.join(tmpHome, ".state", "sediment");
fs.mkdirSync(ledgerDir, { recursive: true });

const PROJ_A = path.resolve("/tmp/p2a-projA");
const PROJ_B = path.resolve("/tmp/p2a-projB");
const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
const row = (o) => JSON.stringify(o);

// Project A: shared-slug = 2 explicit retrieved-unused (OLDER), then 5 decisive,
//            plus 1 implicit Path A unused baseline (NEWEST, non-footnote).
//            clean-slug = 3 decisive (well-grounded, no echo). decisive_streak
//            counts consecutive decisive FOOTNOTES at the tail, so the implicit
//            baseline must not break the streak.
// Project B: shared-slug = 1 decisive  (must NOT leak into project A read).
const lines = [];
lines.push(row({ ts: iso(11), session_id: "sA", entry_slug: "shared-slug", used: "retrieved-unused", source: "memory-footnote", counterfactual: "x", project_root: PROJ_A }));
lines.push(row({ ts: iso(10), session_id: "sA", entry_slug: "shared-slug", used: "retrieved-unused", source: "memory-footnote", counterfactual: "x", project_root: PROJ_A }));
for (let i = 5; i >= 1; i--) lines.push(row({ ts: iso(i), session_id: "sA", entry_slug: "shared-slug", used: "decisive", source: "memory-footnote", counterfactual: "x", project_root: PROJ_A }));
lines.push(row({ ts: iso(0), session_id: "sA", entry_slug: "shared-slug", used: "retrieved-unused", source: "path-a-implicit", counterfactual: "implicit baseline", project_root: PROJ_A, path_a_inject_id: "path-a-smoke" }));
for (let i = 3; i >= 1; i--) lines.push(row({ ts: iso(i), session_id: "sA", entry_slug: "clean-slug", used: "decisive", source: "memory-footnote", counterfactual: "x", project_root: PROJ_A }));
lines.push(row({ ts: iso(1), session_id: "sB", entry_slug: "shared-slug", used: "decisive", source: "memory-footnote", counterfactual: "x", project_root: PROJ_B }));
fs.writeFileSync(path.join(ledgerDir, "outcome-ledger.jsonl"), lines.join("\n") + "\n");

const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

const oc = jiti(path.join(repoRoot, "extensions/sediment/outcome-collector.ts"));
const cp = jiti(path.join(repoRoot, "extensions/sediment/correction-pipeline.ts"));
const { sanitizeSlug, normalizeProjectRoot, readProjectOutcomeRows, summarizeEntryActivity } = oc;
const buildPrompt = cp._buildClassifierPromptForTests;

let pass = 0, fail = 0;
const check = (n, ok, why = "") => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${why ? `  ← ${why}` : ""}`); }
};

console.log("\n[1] sanitizeSlug strips scope prefixes → bare");
check("project:pi:foo → foo", sanitizeSlug("project:pi:foo") === "foo");
check("world:bar → bar", sanitizeSlug("world:bar") === "bar");
check("workflow:x → x", sanitizeSlug("workflow:x") === "x");
check("plain → plain", sanitizeSlug("plain") === "plain");

console.log("\n[2] normalizeProjectRoot");
check("resolves abs", normalizeProjectRoot("/tmp/p2a-projA") === PROJ_A);
check("'' for empty", normalizeProjectRoot("") === "" && normalizeProjectRoot(undefined) === "");

console.log("\n[3] readProjectOutcomeRows is PROJECT-SCOPED (no cross-project leak)");
const aRows = readProjectOutcomeRows(PROJ_A, 5000);
check("all A rows resolve to PROJ_A", aRows.length > 0 && aRows.every((r) => normalizeProjectRoot(r.project_root) === PROJ_A));
check("no PROJ_B row present", !aRows.some((r) => normalizeProjectRoot(r.project_root) === PROJ_B));

console.log("\n[4] readProjectOutcomeRows('') → [] (unscoped guard)");
check("empty projectRoot → []", readProjectOutcomeRows("", 5000).length === 0);

console.log("\n[5] summarizeEntryActivity counts + echo-chamber + absent=zeroed");
const statsA = summarizeEntryActivity(aRows, ["shared-slug", "clean-slug", "absent-slug"], 30);
const byA = Object.fromEntries(statsA.map((s) => [s.slug, s]));
check("shared decisive=5", byA["shared-slug"].decisive_count === 5, JSON.stringify(byA["shared-slug"]));
check("shared retrieved-unused=3 (2 footnote + 1 path-a-implicit)", byA["shared-slug"].retrieved_unused_count === 3, JSON.stringify(byA["shared-slug"]));
check("shared echo-chamber=true (path-a-implicit does not break footnote streak)", byA["shared-slug"].possible_echo_chamber === true);
check("clean decisive=3, echo=false", byA["clean-slug"].decisive_count === 3 && byA["clean-slug"].possible_echo_chamber === false);
const absent = byA["absent-slug"];
const absentHasData = !!absent.last_seen || absent.decisive_count > 0 || absent.confirmatory_count > 0 || absent.retrieved_unused_count > 0 || absent.total_retrievals > 0;
check("absent slug → zeroed record (hasData guard required)", absent.decisive_count === 0 && !absent.last_seen && absentHasData === false);

console.log("\n[6] isolation end-to-end: A-read sees only A's count (5, not 6)");
check("shared-slug decisive=5 from A-only", byA["shared-slug"].decisive_count === 5);

console.log("\n[7] collectOutcomes supplements Path A injected slugs as implicit baseline");
{
  const ca = jiti(path.join(repoRoot, "extensions/_shared/causal-anchor.ts"));
  ca._setCurrentAnchorForTests("sPath", 7);
  const pathALedgerDir = path.join(tmpHome, ".state", "memory");
  fs.mkdirSync(pathALedgerDir, { recursive: true });
  fs.writeFileSync(path.join(pathALedgerDir, "path-a-ledger.jsonl"), row({
    ts: iso(0), session_id: "sPath", turn_id: 7, inject_id: "path-a-implicit-smoke",
    outcome: "injected", injected_slugs: ["implicit-slug", "explicit-slug"],
  }) + "\n");

  const implicitOnly = oc.collectOutcomes([
    { type: "message", message: { role: "user", content: "use memory" } },
    { type: "message", message: { role: "assistant", content: "no explicit footnote" } },
  ], "sPath");
  const implicitRow = implicitOnly.rows.find((r) => r.source === "path-a-implicit" && r.entry_slug === "implicit-slug");
  check("collector emits source=path-a-implicit", !!implicitRow && implicitRow.used === "retrieved-unused" && implicitRow.path_a_inject_id === "path-a-implicit-smoke", JSON.stringify(implicitOnly.rows));

  const withFootnote = oc.collectOutcomes([
    { type: "message", message: { role: "user", content: "use memory" } },
    { type: "message", message: { role: "assistant", content: "```memory-footnote\nentry: explicit-slug\nused: confirmatory\ncounterfactual: used it\n```" } },
  ], "sPath");
  check("explicit current-turn footnote is not double-counted as implicit",
    withFootnote.rows.some((r) => r.source === "memory-footnote" && r.entry_slug === "explicit-slug") &&
    !withFootnote.rows.some((r) => r.source === "path-a-implicit" && r.entry_slug === "explicit-slug"),
    JSON.stringify(withFootnote.rows));
}

console.log("\n[8] buildClassifierPrompt renders track-record");
const cardWith = { slug: "shared-slug", title: "T", outcome_activity: { decisive: 5, confirmatory: 0, retrieved_unused: 2, possible_echo_chamber: true, last_seen: iso(1) } };
const cardWithout = { slug: "clean-slug", title: "C" };
const prompt = buildPrompt({ windowText: "user said use X", stagingContext: [], relatedEntries: [cardWith, cardWithout] });
check("renders decisive×5 line", /track-record: decisive×5 confirmatory×0 retrieved-unused×2/.test(prompt), "missing counts line");
check("renders ⚠️possible-echo-chamber", /⚠️possible-echo-chamber/.test(prompt));
check("renders last_seen=YYYY-MM-DD", /last_seen=\d{4}-\d{2}-\d{2}/.test(prompt));
check("renders (none recorded) for card without", /track-record: \(none recorded\)/.test(prompt));

console.log("\n[9] prompt carries DISCOUNT guidance (direction-correct)");
check("has 'DISCOUNT an entry's apparent authority'", /DISCOUNT an entry's apparent authority/.test(prompt));
check("has 'NOT to inflate correction'", /NOT to inflate correction/.test(prompt));
check("still requires content match", /STILL need the user's current/.test(prompt));

console.log("\n[10] scoped related slug sanitizes to bare ledger slug (opus hardening)");
check("project:pi:shared-slug → shared-slug", sanitizeSlug("project:pi:shared-slug") === "shared-slug");

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
fs.rmSync(PROJ_A, { recursive: true, force: true });
fs.rmSync(PROJ_B, { recursive: true, force: true });

console.log(`\n──── PASS ${pass} / ${pass + fail} ────`);
process.exit(fail === 0 ? 0 : 1);
