#!/usr/bin/env node
/**
 * smoke-staging-ageout — Stage 4 (autonomous evolution): prompt-driven
 * AGE-OUT of aged (>30d) provisional staging hypotheses (ADR 0025 §4.1.5 /
 * §4.6.6).
 *
 * Stage 4 is REVERSIBLE soft-archive ONLY: soft_archive flips lifecycle_state
 * + sets aged_out_at; it NEVER unlinks a file (staging is git-ignored .state →
 * unlink is irreversible; the mechanical N-day hard-delete is a deferred
 * Stage 5). promote_candidate is ADVISORY only (multi-view §4.4 still gates
 * promotion). attribution_pending is left UNTOUCHED.
 *
 * Locks the deterministic logic WITHOUT a real LLM:
 *   - parseStagingAgeOutOutput: tolerant parse, unknown → keep_aging
 *     (conservative), malformed → throw (→ keep all aging)
 *   - selectAgeOutCandidates: ONLY aged-out (≥30d) pending provisional-
 *     correction; excludes fresh (<30d), non-pending, soft_archived, and
 *     recently-aged-out-reviewed
 *   - annotateAgeOut: pure transform; soft_archive sets lifecycle_state +
 *     aged_out_at; keep_aging/promote_candidate leave lifecycle active;
 *     attribution_pending UNCHANGED; file NEVER unlinked
 *   - applyAgeOutDecisions: on-disk, atomic, reversible
 *   - loader/resolver EXCLUDE soft_archived from active backlog + staleCount
 *   - runStagingAgeOutIfDue: debounce / no_candidates / model-unavailable
 *
 * Real modules via jiti; staging dir sandboxed under a tmp ABRAIN_ROOT.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`); }
}

const ageout = jiti(path.join(repoRoot, "extensions/sediment/staging-ageout.ts"));
const loader = jiti(path.join(repoRoot, "extensions/sediment/staging-loader.ts"));
const resolver = jiti(path.join(repoRoot, "extensions/sediment/staging-resolver.ts"));
const aggregator = jiti(path.join(repoRoot, "extensions/sediment/aggregator.ts"));

const DAY = 24 * 60 * 60 * 1000;

// ── [1] parseStagingAgeOutOutput ──────────────────────────────────────
console.log("\n[1] parseStagingAgeOutOutput");
{
  const r = ageout.parseStagingAgeOutOutput('{"decisions":[{"slug":"provisional-a","decision":"soft_archive","rationale":"stale"}]}');
  check("soft_archive parsed", r.decisions.length === 1 && r.decisions[0].decision === "soft_archive" && r.decisions[0].slug === "provisional-a");
}
{
  const r = ageout.parseStagingAgeOutOutput('```json\n{"decisions":[{"slug":"x","decision":"promote_candidate"}]}\n```');
  check("fenced + promote_candidate", r.decisions[0].decision === "promote_candidate");
}
{
  const r = ageout.parseStagingAgeOutOutput('{"decisions":[{"slug":"y","decision":"bogus"}]}');
  check("unknown decision → keep_aging (conservative)", r.decisions[0].decision === "keep_aging");
}
{
  const r = ageout.parseStagingAgeOutOutput('{"decisions":[{"decision":"soft_archive"}]}');
  check("missing slug → dropped", r.decisions.length === 0);
}
{
  let threw = false;
  try { ageout.parseStagingAgeOutOutput("not json at all"); } catch { threw = true; }
  check("unparseable → throws (caller keeps all aging)", threw);
}

// ── [2] annotateAgeOut pure transform (REVERSIBLE) ────────────────────
console.log("\n[2] annotateAgeOut (reversible; attribution_pending untouched)");
function makeEntry(slug, overrides = {}) {
  return {
    slug, status: "provisional", kind: "provisional-correction",
    created: new Date(Date.now() - 40 * DAY).toISOString(), attribution_pending: true,
    originating_device: "smoke", hypothesis: `hyp ${slug}`,
    source_utterance: [{ quote: `q ${slug}`, context: "", captured_at: new Date().toISOString() }],
    suggested_resolution_paths: [], _provenance_warning: "w", ...overrides,
  };
}
{
  const now = new Date();
  const sa = ageout.annotateAgeOut(makeEntry("provisional-z"), now, "soft_archive", "stale one-off");
  check("soft_archive sets lifecycle_state=soft_archived", sa.lifecycle_state === "soft_archived");
  check("soft_archive sets aged_out_at + reviewed_at + decision + rationale",
    typeof sa.aged_out_at === "string" && typeof sa.aged_out_reviewed_at === "string" && sa.aged_out_decision === "soft_archive" && sa.aged_out_rationale === "stale one-off");
  check("soft_archive does NOT touch attribution_pending (stays true)", sa.attribution_pending === true);
  check("soft_archive does NOT bump updated", sa.updated === undefined);
  check("soft_archive stamps prompt_version", sa.aged_out_prompt_version === "v1");

  const ka = ageout.annotateAgeOut(makeEntry("provisional-k"), now, "keep_aging", "still viable");
  check("keep_aging leaves lifecycle_state unset (active)", ka.lifecycle_state === undefined);
  check("keep_aging sets reviewed_at + decision (debounce), no aged_out_at", typeof ka.aged_out_reviewed_at === "string" && ka.aged_out_decision === "keep_aging" && ka.aged_out_at === undefined);

  const pc = ageout.annotateAgeOut(makeEntry("provisional-p"), now, "promote_candidate", "durable!");
  check("promote_candidate stays active (not soft-archived)", pc.lifecycle_state === undefined && pc.aged_out_decision === "promote_candidate");
  check("promote_candidate keeps attribution_pending true (multi-view path)", pc.attribution_pending === true);
}

// ── [3] selectAgeOutCandidates + on-disk apply (no LLM) ───────────────
console.log("\n[3] selectAgeOutCandidates + applyAgeOutDecisions (on-disk, reversible)");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-ageout-abrain-"));
const prevRoot = process.env.ABRAIN_ROOT;
process.env.ABRAIN_ROOT = tmpRoot;

function writeStaging(slug, { pending = true, created, kind = "provisional-correction", extra = {} } = {}) {
  const dir = loader.stagingDir();
  fs.mkdirSync(dir, { recursive: true });
  const createdIso = created ?? new Date(Date.now() - 40 * DAY).toISOString();
  const entry = {
    slug, status: "provisional", kind, created: createdIso,
    attribution_pending: pending, originating_device: "smoke",
    hypothesis: `hyp for ${slug}`, source_utterance: [{ quote: `q ${slug}`, context: "", captured_at: createdIso }],
    suggested_resolution_paths: [], _provenance_warning: "w", ...extra,
  };
  fs.writeFileSync(path.join(dir, `${createdIso.replace(/[:.]/g, "-")}-${slug}.json`), JSON.stringify({ schema_version: 1, entry }, null, 2));
}

try {
  const aged = new Date(Date.now() - 40 * DAY).toISOString();     // >30d → age-out tier
  const fresh = new Date(Date.now() - 2 * DAY).toISOString();      // <30d → resolver tier
  const recentlyAgedOut = new Date(Date.now() - 3 * DAY).toISOString(); // within 14d re-review

  writeStaging("provisional-aged1", { created: aged });
  writeStaging("provisional-aged2", { created: new Date(Date.now() - 50 * DAY).toISOString() });
  writeStaging("provisional-fresh", { created: fresh });                            // excluded: <30d
  writeStaging("provisional-nonpending", { created: aged, pending: false });        // excluded: not pending
  writeStaging("provisional-softarchived", { created: aged, extra: { lifecycle_state: "soft_archived" } }); // excluded
  writeStaging("provisional-recentlyreviewed", { created: aged, extra: { aged_out_reviewed_at: recentlyAgedOut, aged_out_decision: "keep_aging" } }); // excluded: re-review window
  writeStaging("not-correction", { created: aged, kind: "multiview-pending" });     // excluded: wrong kind

  const cands = ageout.selectAgeOutCandidates(new Date());
  const slugs = cands.map((c) => c.entry.slug).sort();
  check("selects ONLY aged-out (>30d) pending provisional-correction, excl. soft_archived + recently-reviewed",
    JSON.stringify(slugs) === JSON.stringify(["provisional-aged1", "provisional-aged2"]), JSON.stringify(slugs));
  check("oldest-first ordering (aged2 created earlier than aged1)", cands[0].entry.slug === "provisional-aged2", cands.map((c) => c.entry.slug).join(","));

  // The resolver must NOT pick up these aged-out entries (its tier is <30d).
  const resolverCands = resolver.selectStagingCandidates(new Date()).map((c) => c.entry.slug).sort();
  check("resolver tier excludes aged-out entries (only fresh)", JSON.stringify(resolverCands) === JSON.stringify(["provisional-fresh"]), JSON.stringify(resolverCands));

  // Apply: soft_archive aged1, keep_aging aged2.
  const dir = loader.stagingDir();
  const fileCountBefore = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  const output = { decisions: [
    { slug: "provisional-aged1", decision: "soft_archive", rationale: "stale" },
    { slug: "provisional-aged2", decision: "keep_aging", rationale: "still viable" },
  ] };
  const res = ageout.applyAgeOutDecisions(cands, output, new Date());
  check("apply: soft_archived slug recorded", JSON.stringify(res.softArchived) === JSON.stringify(["provisional-aged1"]), JSON.stringify(res));
  check("apply: kept_aging count = 1", res.keptAging === 1, JSON.stringify(res));

  // REVERSIBLE: no file unlinked.
  const fileCountAfter = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  check("apply NEVER unlinks a staging file (reversible)", fileCountAfter === fileCountBefore, `${fileCountBefore}→${fileCountAfter}`);

  const aged1File = fs.readdirSync(dir).find((f) => f.includes("provisional-aged1"));
  const aged1 = JSON.parse(fs.readFileSync(path.join(dir, aged1File), "utf-8")).entry;
  check("on-disk: aged1 soft_archived + aged_out_at, attribution_pending STILL true", aged1.lifecycle_state === "soft_archived" && typeof aged1.aged_out_at === "string" && aged1.attribution_pending === true);
  const aged2File = fs.readdirSync(dir).find((f) => f.includes("provisional-aged2"));
  const aged2 = JSON.parse(fs.readFileSync(path.join(dir, aged2File), "utf-8")).entry;
  check("on-disk: aged2 kept_aging stays active (no lifecycle_state)", aged2.lifecycle_state === undefined && aged2.aged_out_decision === "keep_aging");

  // EXCLUSION: soft-archived entry must drop from loader context AND staleCount.
  const ctx = loader.loadStagingContext();
  const ctxSlugs = ctx.entries.map((e) => e.slug);
  check("loader: soft_archived entry NOT in active context", !ctxSlugs.includes("provisional-aged1"));
  // Build a CONTROLLED staleness fixture to lock exclusion with a real count.
  // Wipe the dir and write exactly: 1 stale-NOT-archived + 1 stale-SOFT-archived
  // + 1 fresh-pending. staleCount must be 1 (only the non-archived stale one).
  const dirX = loader.stagingDir();
  for (const f of fs.readdirSync(dirX)) { if (f.endsWith(".json")) fs.rmSync(path.join(dirX, f)); }
  writeStaging("provisional-staleplain", { created: new Date(Date.now() - 45 * DAY).toISOString() });
  writeStaging("provisional-stalearch", { created: new Date(Date.now() - 45 * DAY).toISOString(), extra: { lifecycle_state: "soft_archived", aged_out_at: new Date().toISOString() } });
  writeStaging("provisional-freshx", { created: new Date(Date.now() - 1 * DAY).toISOString() });
  const ctx2 = loader.loadStagingContext();
  check("loader: staleCount EXCLUDES soft_archived (1 stale-plain, not 2)", ctx2.staleCount === 1, `staleCount=${ctx2.staleCount}`);
  check("loader: active context has only the fresh entry", ctx2.entries.length === 1 && ctx2.entries[0].slug === "provisional-freshx", JSON.stringify(ctx2.entries.map((e) => e.slug)));
  check("loader: stagingActiveFileCount excludes soft_archived (2 active of 3)", loader.stagingActiveFileCount() === 2, `active=${loader.stagingActiveFileCount()} total=${loader.stagingFileCount()}`);
  check("loader: stagingActionableFileCount excludes only retired/debounced entries (2 actionable)", loader.stagingActionableFileCount() === 2, `actionable=${loader.stagingActionableFileCount()}`);

  // DRAINAGE INVARIANT (the headline goal): the REAL aggregator's
  // staging_backlog advisory must NOT fire on soft_archived-only stale
  // entries. This is what summarizeStaging drives — the path the loader fix
  // alone did NOT cover (caught by 3-T0 review). With ONLY soft_archived stale
  // files present, provisional_stale must be 0 and no staging_backlog advisory.
  for (const f of fs.readdirSync(dirX)) { if (f.endsWith(".json")) fs.rmSync(path.join(dirX, f)); }
  writeStaging("provisional-retired1", { created: new Date(Date.now() - 45 * DAY).toISOString(), extra: { lifecycle_state: "soft_archived", aged_out_at: new Date().toISOString() } });
  writeStaging("provisional-retired2", { created: new Date(Date.now() - 60 * DAY).toISOString(), extra: { lifecycle_state: "soft_archived", aged_out_at: new Date().toISOString() } });
  const aggProjRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-ageout-agg-"));
  const summary = aggregator.runSedimentAggregator({ projectRoot: aggProjRoot, settings: { autoLlmWriteEnabled: true }, now: new Date() });
  check("aggregator: provisional_stale EXCLUDES soft_archived (0, not 2)", summary.staging.provisional_stale === 0, `provisional_stale=${summary.staging.provisional_stale}`);
  check("aggregator: provisional_pending EXCLUDES soft_archived (0)", summary.staging.provisional_pending === 0, `provisional_pending=${summary.staging.provisional_pending}`);
  check("aggregator: provisional_actionable EXCLUDES soft_archived (0)", summary.staging.provisional_actionable === 0, `provisional_actionable=${summary.staging.provisional_actionable}`);
  check("aggregator: soft_archived counter surfaces retired files (2)", summary.staging.soft_archived === 2, `soft_archived=${summary.staging.soft_archived}`);
  const stagingAdv = summary.advisories.filter((a) => a.kind === "staging_backlog");
  check("aggregator: staging_backlog advisory DRAINS when only soft_archived stale present", stagingAdv.length === 0, JSON.stringify(stagingAdv));

  // A kept-aging entry that was reviewed inside the age-out re-review window is
  // still active, but not an immediate stale backlog action item. It should be
  // visible as debounced audit state instead of keeping provisional_stale > 0.
  for (const f of fs.readdirSync(dirX)) { if (f.endsWith(".json")) fs.rmSync(path.join(dirX, f)); }
  writeStaging("provisional-reviewed", {
    created: new Date(Date.now() - 45 * DAY).toISOString(),
    extra: { aged_out_reviewed_at: new Date().toISOString(), aged_out_decision: "keep_aging" },
  });
  const reviewedSummary = aggregator.runSedimentAggregator({ projectRoot: aggProjRoot, settings: { autoLlmWriteEnabled: true }, now: new Date() });
  check("loader: stagingActionableFileCount excludes recently age-out-reviewed stale", loader.stagingActionableFileCount() === 0, `actionable=${loader.stagingActionableFileCount()}`);
  check("aggregator: recently age-out-reviewed stale is debounced, not actionable stale", reviewedSummary.staging.provisional_stale === 0 && reviewedSummary.staging.provisional_stale_review_debounced === 1, JSON.stringify(reviewedSummary.staging));
  check("aggregator: provisional_actionable excludes recently age-out-reviewed stale", reviewedSummary.staging.provisional_actionable === 0, JSON.stringify(reviewedSummary.staging));
  check("aggregator: reviewed-only stale does not fire staging_backlog", reviewedSummary.advisories.filter((a) => a.kind === "staging_backlog").length === 0, JSON.stringify(reviewedSummary.advisories));
  try { fs.rmSync(aggProjRoot, { recursive: true, force: true }); } catch {}

  // Restore the apply-block fixture so subsequent assertions see aged1/aged2.
  for (const f of fs.readdirSync(dirX)) { if (f.endsWith(".json")) fs.rmSync(path.join(dirX, f)); }
  writeStaging("provisional-aged1", { created: aged, extra: { lifecycle_state: "soft_archived", aged_out_at: new Date().toISOString() } });
  writeStaging("provisional-aged2", { created: new Date(Date.now() - 50 * DAY).toISOString(), extra: { aged_out_reviewed_at: new Date().toISOString(), aged_out_decision: "keep_aging" } });

  // Re-running selection after soft_archive: aged1 excluded (soft_archived),
  // aged2 excluded (just reviewed, within re-review window).
  const cands2 = ageout.selectAgeOutCandidates(new Date()).map((c) => c.entry.slug);
  check("after apply: soft_archived + just-reviewed both excluded from re-selection", !cands2.includes("provisional-aged1") && !cands2.includes("provisional-aged2"), JSON.stringify(cands2));

  // runStagingAgeOutIfDue skip paths (no LLM). Use a FRESH staging root that
  // still has an aged candidate (the tmpRoot above was just drained by apply),
  // so the model-availability checks are reached (not short-circuited by
  // no_candidates).
  const settings = { aggregatorModel: "provider-a/model-a", curatorModel: "provider-a/model-a", curatorTimeoutMs: 30000, autoLlmWriteEnabled: true };
  const skipRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-ageout-skip-"));
  process.env.ABRAIN_ROOT = skipRoot;
  writeStaging("provisional-skipcand", { created: new Date(Date.now() - 45 * DAY).toISOString() });
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-ageout-proj-"));
  const r1 = await ageout.runStagingAgeOutIfDue({ projectRoot, settings, now: new Date() });
  check("no modelRegistry → skipped=model_registry_unavailable", r1.skipped === "model_registry_unavailable", JSON.stringify(r1));
  check("model-registry-unavailable does NOT write last-run", !fs.existsSync(ageout.stagingAgeOutLastRunPath(projectRoot)));

  fs.mkdirSync(path.dirname(ageout.stagingAgeOutLastRunPath(projectRoot)), { recursive: true });
  fs.writeFileSync(ageout.stagingAgeOutLastRunPath(projectRoot), JSON.stringify({ last_run_ts: new Date().toISOString(), status: "ok" }));
  const r2 = await ageout.runStagingAgeOutIfDue({ projectRoot, settings, modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, now: new Date() });
  check("fresh last-run → skipped=debounced", r2.skipped === "debounced", JSON.stringify(r2));

  const future = new Date(Date.now() + 25 * 60 * 60 * 1000); // > 24h default
  const r3 = await ageout.runStagingAgeOutIfDue({ projectRoot, settings, modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, now: future });
  check("past debounce + unresolvable model → skipped=model_not_found (no throw)", r3.skipped === "model_not_found", JSON.stringify(r3));

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-ageout-empty-"));
  process.env.ABRAIN_ROOT = emptyRoot;
  const r4 = await ageout.runStagingAgeOutIfDue({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-ageout-proj2-")), settings, modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) }, now: new Date() });
  check("empty staging → skipped=no_candidates", r4.skipped === "no_candidates", JSON.stringify(r4));
  process.env.ABRAIN_ROOT = tmpRoot;
  try { fs.rmSync(emptyRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(skipRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
} finally {
  if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = prevRoot;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// ── [4] source-level wiring + invariant locks ─────────────────────────
console.log("\n[4] wiring + invariant locks");
{
  const idx = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
  check("index schedules runStagingAgeOutIfDue", /runStagingAgeOutIfDue\(/.test(idx));
  check("index gates age-out on autoLlmWriteEnabled !== false", /runStagingAgeOutIfDue/.test(idx) && /autoLlmWriteEnabled !== false\) scheduleAggregator/.test(idx));

  const mod = fs.readFileSync(path.join(repoRoot, "extensions/sediment/staging-ageout.ts"), "utf-8");
  // INVARIANT: never flips attribution_pending, never unlinks a staging file.
  check("age-out never flips attribution_pending (reversible)", !/attribution_pending:\s*false/.test(mod));
  // The only unlinkSync calls allowed are on the advisory LOCK path (in
  // tryAcquireLock stale-steal + releaseLock). Assert there is NO unlink of a
  // candidate / staging hypothesis file path. (The behavioral check above —
  // fileCount unchanged after apply — is the authoritative guarantee; this is
  // a defense-in-depth source lock.)
  check("age-out does NOT unlink any staging hypothesis file (Stage 5 deferred)",
    !/unlinkSync\(\s*(?:c\.file|candidate|abs|tmp)\b/.test(mod) && !/(?:c\.file|candidate)[^\n]*unlinkSync/.test(mod));
  // Every unlinkSync in the module must target the lock path helper.
  const unlinkCalls = mod.match(/unlinkSync\([^)]*\)/g) || [];
  check("age-out: all unlinkSync calls are advisory-lock release (not staging files)",
    unlinkCalls.length > 0 && unlinkCalls.every((c) => /stagingAgeOutLockPath|\bfile\b/.test(c)), JSON.stringify(unlinkCalls));
  check("age-out uses atomic tmp+rename write", /renameSync\(/.test(mod));

  const agg = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf-8");
  check("aggregator renamed structural entry → staging-hard-archive-unimplemented", /staging-hard-archive-unimplemented/.test(agg));
  check("aggregator dropped the old deletion-unimplemented id", !/id:\s*"staging-backlog-deletion-unimplemented"/.test(agg));
}

console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) { console.log("FAILURES — investigate before commit"); process.exit(1); }
process.exit(0);
