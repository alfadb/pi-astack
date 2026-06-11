#!/usr/bin/env node
/**
 * smoke-staging-resolver — Stage 3 (autonomous evolution): active batch
 * TRIAGE of provisional staging hypotheses (ADR 0025 §4.1.5.1).
 *
 * The resolver is NON-DESTRUCTIVE (R1 opus P1): it never removes a hypothesis
 * from the loop (attribution_pending untouched); it only annotates a triage
 * disposition (likely_noise / plausible / promote_candidate) + reviewed-at,
 * and selection deprioritizes recently-reviewed entries. Retirement stays the
 * job of the time-bounded age-out.
 *
 * Locks the deterministic logic WITHOUT a real LLM:
 *   - parseStagingResolverOutput: tolerant parse, unknown decision →
 *     plausible (conservative), promote flag, malformed → throw (→ keep all)
 *   - selectStagingCandidates: only pending provisional-correction, oldest
 *     first, skips stale (>30d) + non-pending + recently-resolver-reviewed
 *   - annotateEntry: pure transform, attribution_pending UNCHANGED
 *   - applyResolverDecisions: on-disk annotate, non-destructive
 *   - runStagingResolverIfDue: debounce / no_candidates / model-unavailable
 *
 * Real module via jiti; staging dir sandboxed under a tmp ABRAIN_ROOT.
 */

import { strict as assert } from "node:assert";
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

const resolver = jiti(path.join(repoRoot, "extensions/sediment/staging-resolver.ts"));
const loader = jiti(path.join(repoRoot, "extensions/sediment/staging-loader.ts"));

// ── [1] parseStagingResolverOutput ────────────────────────────────────
console.log("\n[1] parseStagingResolverOutput");
{
  const r = resolver.parseStagingResolverOutput('{"decisions":[{"slug":"provisional-a","decision":"likely_noise","rationale":"one-off"}]}');
  check("likely_noise parsed", r.decisions.length === 1 && r.decisions[0].decision === "likely_noise" && r.decisions[0].slug === "provisional-a");
}
{
  const r = resolver.parseStagingResolverOutput('```json\n{"decisions":[{"slug":"x","decision":"plausible","promote_candidate":true}]}\n```');
  check("fenced + promote_candidate", r.decisions[0].decision === "plausible" && r.decisions[0].promote_candidate === true);
}
{
  const r = resolver.parseStagingResolverOutput('{"decisions":[{"slug":"y","decision":"bogus"}]}');
  check("unknown decision → plausible (conservative)", r.decisions[0].decision === "plausible");
}
{
  const r = resolver.parseStagingResolverOutput('{"decisions":[{"decision":"likely_noise"}]}');
  check("missing slug → dropped", r.decisions.length === 0);
}
{
  let threw = false;
  try { resolver.parseStagingResolverOutput("not json at all"); } catch { threw = true; }
  check("unparseable → throws (caller keeps all)", threw);
}

// ── [2] annotateEntry pure transform (NON-DESTRUCTIVE) ────────────────
console.log("\n[2] annotateEntry (non-destructive)");
{
  const e = { slug: "provisional-z", status: "provisional", kind: "provisional-correction", created: "2026-05-01T00:00:00.000+08:00", attribution_pending: true, originating_device: "d", hypothesis: "h", source_utterance: [], suggested_resolution_paths: [], _provenance_warning: "w" };
  const out = resolver.annotateEntry(e, new Date(), "likely_noise", "looks like a one-off");
  check("annotate does NOT touch attribution_pending (stays true)", out.attribution_pending === true);
  check("annotate sets resolver_disposition", out.resolver_disposition === "likely_noise");
  check("annotate sets resolver_reviewed_at + rationale", typeof out.resolver_reviewed_at === "string" && out.resolver_rationale === "looks like a one-off");
  check("annotate preserves slug/kind", out.slug === "provisional-z" && out.kind === "provisional-correction");
}

// ── [3] selectStagingCandidates + runStagingResolverIfDue (no LLM) ────
console.log("\n[3] selectStagingCandidates + runStagingResolverIfDue (no LLM)");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-stgres-abrain-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-stgres-proj-"));
const prevRoot = process.env.ABRAIN_ROOT;
process.env.ABRAIN_ROOT = tmpRoot;

function writeStaging(slug, { pending = true, created, kind = "provisional-correction", reviewedAt } = {}) {
  const dir = loader.stagingDir();
  fs.mkdirSync(dir, { recursive: true });
  const createdIso = created ?? new Date().toISOString();
  const entry = {
    slug, status: "provisional", kind, created: createdIso,
    attribution_pending: pending, originating_device: "smoke",
    hypothesis: `hyp for ${slug}`, source_utterance: [{ quote: `q ${slug}`, context: "", captured_at: createdIso }],
    suggested_resolution_paths: [], _provenance_warning: "w",
    ...(reviewedAt ? { resolver_reviewed_at: reviewedAt, resolver_disposition: "likely_noise" } : {}),
  };
  fs.writeFileSync(path.join(dir, `${createdIso.replace(/[:.]/g, "-")}-${slug}.json`), JSON.stringify({ schema_version: 1, entry }, null, 2));
}

try {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();  // stale (>30d)
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  const recentlyReviewed = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2d ago (< 7d window)
  writeStaging("provisional-pending1", { pending: true, created: recent });
  writeStaging("provisional-pending2", { pending: true, created: new Date(Date.now() - 120 * 1000).toISOString() });
  writeStaging("provisional-nonpending", { pending: false, created: recent });
  writeStaging("provisional-stale", { pending: true, created: old });
  writeStaging("provisional-recentlyreviewed", { pending: true, created: recent, reviewedAt: recentlyReviewed });
  writeStaging("not-correction", { pending: true, created: recent, kind: "multiview-pending" });

  const cands = resolver.selectStagingCandidates(new Date());
  const slugs = cands.map((c) => c.entry.slug).sort();
  check("selects only pending provisional-correction, non-stale, not-recently-reviewed",
    JSON.stringify(slugs) === JSON.stringify(["provisional-pending1", "provisional-pending2"]), JSON.stringify(slugs));
  check("candidates carry file path", cands.every((c) => typeof c.file === "string" && c.file.endsWith(".json")));

  const settings = { aggregatorModel: "provider-a/model-a", curatorModel: "provider-a/model-a", curatorTimeoutMs: 30000, autoLlmWriteEnabled: true };

  const r1 = await resolver.runStagingResolverIfDue({ projectRoot, settings, now: new Date() });
  check("no modelRegistry → skipped=model_registry_unavailable", r1.skipped === "model_registry_unavailable", JSON.stringify(r1));
  check("model-registry-unavailable does NOT write last-run (retries next turn)", !fs.existsSync(resolver.stagingResolverLastRunPath(projectRoot)));

  fs.mkdirSync(path.dirname(resolver.stagingResolverLastRunPath(projectRoot)), { recursive: true });
  fs.writeFileSync(resolver.stagingResolverLastRunPath(projectRoot), JSON.stringify({ last_run_ts: new Date().toISOString(), status: "ok" }));
  const r2 = await resolver.runStagingResolverIfDue({ projectRoot, settings, modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, now: new Date() });
  check("fresh last-run → skipped=debounced", r2.skipped === "debounced", JSON.stringify(r2));

  const past = new Date(Date.now() + 7 * 60 * 60 * 1000); // > 6h default
  const r3 = await resolver.runStagingResolverIfDue({ projectRoot, settings, modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, now: past });
  check("past debounce + unresolvable model → skipped=model_not_found (no throw)", r3.skipped === "model_not_found", JSON.stringify(r3));
  check("model_not_found writes last-run (debounced breadcrumb, not per-turn)", fs.existsSync(resolver.stagingResolverLastRunPath(projectRoot)));

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-stgres-empty-"));
  process.env.ABRAIN_ROOT = emptyRoot;
  const r4 = await resolver.runStagingResolverIfDue({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-stgres-proj2-")), settings, modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) }, now: new Date() });
  check("empty staging → skipped=no_candidates", r4.skipped === "no_candidates", JSON.stringify(r4));
  process.env.ABRAIN_ROOT = tmpRoot;
  try { fs.rmSync(emptyRoot, { recursive: true, force: true }); } catch {}
} finally {
  if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = prevRoot;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
}

// ── [3b] applyResolverDecisions: real on-disk triage (non-destructive) ─
console.log("\n[3b] applyResolverDecisions (on-disk, non-destructive)");
{
  const applyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-stgres-apply-"));
  const prev = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = applyRoot;
  try {
    writeStaging("provisional-noise", { pending: true, created: new Date(Date.now() - 60 * 1000).toISOString() });
    writeStaging("provisional-plaus", { pending: true, created: new Date(Date.now() - 120 * 1000).toISOString() });
    writeStaging("provisional-promo", { pending: true, created: new Date(Date.now() - 180 * 1000).toISOString() });
    const cands = resolver.selectStagingCandidates(new Date());
    const output = { decisions: [
      { slug: "provisional-noise", decision: "likely_noise", promote_candidate: false, rationale: "one-off" },
      { slug: "provisional-plaus", decision: "plausible", promote_candidate: false, rationale: "" },
      { slug: "provisional-promo", decision: "likely_noise", promote_candidate: true, rationale: "durable!" },
    ] };
    const res = resolver.applyResolverDecisions(cands, output, new Date());
    check("apply: likely_noise slug recorded", JSON.stringify(res.likelyNoise) === JSON.stringify(["provisional-noise"]), JSON.stringify(res));
    check("apply: promote_candidate wins over likely_noise", res.promoteCandidates.includes("provisional-promo") && !res.likelyNoise.includes("provisional-promo"));
    check("apply: plausible count = 1", res.plausible === 1, JSON.stringify(res));

    // NON-DESTRUCTIVE: ALL three still pending after triage (nothing removed)
    const after = resolver.selectStagingCandidates(new Date()).map((c) => c.entry.slug).sort();
    // (they were just reviewed → now within re-review window → deprioritized)
    check("after triage: all entries deprioritized from re-selection (reviewed)", after.length === 0, JSON.stringify(after));

    const dir = loader.stagingDir();
    const noiseFile = fs.readdirSync(dir).find((f) => f.includes("provisional-noise"));
    const noiseEntry = JSON.parse(fs.readFileSync(path.join(dir, noiseFile), "utf-8")).entry;
    check("on-disk: likely_noise entry attribution_pending STILL true (non-destructive)", noiseEntry.attribution_pending === true);
    check("on-disk: likely_noise entry annotated disposition + reviewed_at", noiseEntry.resolver_disposition === "likely_noise" && typeof noiseEntry.resolver_reviewed_at === "string");
    const promoFile = fs.readdirSync(dir).find((f) => f.includes("provisional-promo"));
    const promoEntry = JSON.parse(fs.readFileSync(path.join(dir, promoFile), "utf-8")).entry;
    check("on-disk: promote_candidate disposition recorded + still pending", promoEntry.resolver_disposition === "promote_candidate" && promoEntry.attribution_pending === true);
  } finally {
    if (prev === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prev;
    try { fs.rmSync(applyRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [4] source-level wiring locks ─────────────────────────────────────
console.log("\n[4] wiring locks");
{
  const idx = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
  check("index schedules runStagingResolverIfDue", /runStagingResolverIfDue\(/.test(idx));
  check("index gates resolver on autoLlmWriteEnabled !== false", /autoLlmWriteEnabled !== false\) scheduleAggregator/.test(idx));
  const agg = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf-8");
  // Resolver shipped as non-destructive triage, so the OLD
  // "staging-resolver-unimplemented" claim must be gone…
  check("aggregator no longer claims the RESOLVER is unimplemented", !/id:\s*"staging-resolver-unimplemented"/.test(agg));
  // …and after Stage 4 the age-out REVIEWER shipped too, so the structural
  // entry was renamed again to the remaining gap: the mechanical hard-delete
  // (unlink) of soft-archived files (Stage 5).
  check("aggregator tracks the staging hard-archive (unlink) gap", /staging-hard-archive-unimplemented/.test(agg));
  check("aggregator no longer claims age-out DELETION generally unimplemented", !/id:\s*"staging-backlog-deletion-unimplemented"/.test(agg));
  const mod = fs.readFileSync(path.join(repoRoot, "extensions/sediment/staging-resolver.ts"), "utf-8");
  check("resolver never flips attribution_pending (non-destructive)", !/attribution_pending:\s*false/.test(mod));
}

console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) { console.log("FAILURES — investigate before commit"); process.exit(1); }
process.exit(0);
