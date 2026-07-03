#!/usr/bin/env node
/**
 * smoke-staging-promotion — ADR 0025 §4.1.5 Stage 5 follow-up.
 *
 * Locks the deterministic logic WITHOUT a real LLM:
 *   - selectPromoteCandidates filters pending provisional-correction,
 *     promote_candidate flags, not soft_archived, outside debounce window
 *   - buildDraftFromStagingEntry / buildProposerDecisionFromStagingEntry
 *     reconstruct a ProjectEntryDraft + CuratorDecision
 *   - findSemanticDuplicate: exact slug + quote containment + Jaccard
 *   - applyPromotionOutcome: non-destructive (no unlink), flips
 *     attribution_pending only on promoted/duplicate
 *   - runStagingPromotionIfDue: debounce / disabled / no_candidates /
 *     model_registry_unavailable; calls runMultiView + writeApprovedToBrain
 *
 * Multi-view and the durable writer are INJECTED so this smoke never
 * calls a real LLM or real brain writer.
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

const promotion = jiti(path.join(repoRoot, "extensions/sediment/staging-promotion.ts"));
const replay = jiti(path.join(repoRoot, "extensions/sediment/multiview-staging-replay.ts"));
const pendingIo = jiti(path.join(repoRoot, "extensions/sediment/multiview-staging-io.ts"));
const loader = jiti(path.join(repoRoot, "extensions/sediment/staging-loader.ts"));
const { slugify } = jiti(path.join(repoRoot, "extensions/memory/utils.ts"));

const DAY = 24 * 60 * 60 * 1000;

function makeEntry(slug, overrides = {}) {
  const now = new Date().toISOString();
  return {
    slug,
    status: "provisional",
    kind: "provisional-correction",
    created: now,
    attribution_pending: true,
    originating_device: "smoke",
    hypothesis: `hypothesis for ${slug}`,
    source_utterance: [{ quote: `quote ${slug}`, context: "", captured_at: now }],
    suggested_resolution_paths: [],
    _provenance_warning: "w",
    ...overrides,
  };
}

function writeStaging(entry) {
  const dir = loader.stagingDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${entry.created.replace(/[:.]/g, "-")}-${entry.slug}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify({ schema_version: 1, entry }, null, 2));
  return path.join(dir, filename);
}

function createDurableEntry(abrainHome, projectId, slug, { title = slug, body = "body", quote } = {}) {
  const dir = path.join(abrainHome, "projects", projectId, "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  const compiledTruth = quote ? `${body}\n\n> ${quote}` : body;
  const markdown = `---\nslug: ${slug}\ntitle: ${title}\nkind: fact\nstatus: active\nconfidence: 8\n---\n\n${compiledTruth}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), markdown, "utf-8");
}

function readStagingEntry(slug) {
  const dir = loader.stagingDir();
  const file = fs.readdirSync(dir).find((f) => f.endsWith(`-${slug}.json`));
  if (!file) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")).entry;
}

function readStagingEntries(slug) {
  const dir = loader.stagingDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(`-${slug}.json`))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")).entry);
}

function makeSettings(overrides = {}) {
  return {
    stagingPromotionEnabled: true,
    autoLlmWriteEnabled: true,
    curatorModel: "provider-a/model-a",
    multiView: { reviewerProviders: ["provider-b/model-b"], proposerProviders: [], fallbackProviders: [] },
    ...overrides,
  };
}

// ── [1] selectPromoteCandidates filters ───────────────────────────────
console.log("\n[1] selectPromoteCandidates filters");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-sel-"));
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const recent = new Date().toISOString();
    const oldAttempt = new Date(Date.now() - 5 * DAY).toISOString(); // inside 14d debounce
    const staleAttempt = new Date(Date.now() - 20 * DAY).toISOString(); // outside

    writeStaging(makeEntry("promote-resolver", { resolver_disposition: "promote_candidate" }));
    writeStaging(makeEntry("promote-ageout", { aged_out_decision: "promote_candidate" }));
    writeStaging(makeEntry("not-pending", { attribution_pending: false, resolver_disposition: "promote_candidate" }));
    writeStaging(makeEntry("soft-archived", { resolver_disposition: "promote_candidate", lifecycle_state: "soft_archived" }));
    writeStaging(makeEntry("recently-attempted", { resolver_disposition: "promote_candidate", promotion_attempted_at: oldAttempt }));
    writeStaging(makeEntry("stale-attempt", { resolver_disposition: "promote_candidate", promotion_attempted_at: staleAttempt }));
    writeStaging(makeEntry("resolver-plausible", { resolver_disposition: "plausible" }));
    writeStaging(makeEntry("multiview-pending", { kind: "multiview-pending", resolver_disposition: "promote_candidate" }));

    const cands = (await promotion.selectPromoteCandidates(new Date())).map((c) => c.entry.slug).sort();
    check("selects promote_candidate, pending, not soft_archived, not debounced",
      JSON.stringify(cands) === JSON.stringify(["promote-ageout", "promote-resolver", "stale-attempt"]),
      JSON.stringify(cands));

    // oldest-first ordering
    const ordered = (await promotion.selectPromoteCandidates(new Date(), 2)).map((c) => c.entry.slug);
    check("oldest-first cap=2", ordered.length === 2, ordered.join(","));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [2] buildDraft + buildProposerDecision ──────────────────────────────
console.log("\n[2] draft / decision reconstruction");
{
  const entry = makeEntry("draft-test", {
    hypothesis: "Use yarn for package management",
    source_utterance: [{ quote: "always use yarn", context: "", captured_at: new Date().toISOString() }],
    correction_signal: {
      typing: "durable",
      confidence: 9,
      correction_intent: "tool preference",
      scope_description: "package manager",
      is_directive: true,
      provenance: "user-expressed",
      target_entry_slug: null,
      most_likely_error_direction: "",
    },
  });
  const draft = promotion.buildDraftFromStagingEntry(entry);
  check("draft title from hypothesis", draft.title === "Use yarn for package management");
  check("draft kind defaults to fact", draft.kind === "fact");
  check("draft compiledTruth includes quote", draft.compiledTruth.includes("always use yarn"));
  check("draft confidence from signal", draft.confidence === 9);
  check("draft provenance is assistant-observed (promotion is meta-curator, not direct user attestation)", draft.provenance === "assistant-observed");

  const decision = promotion.buildProposerDecisionFromStagingEntry(entry);
  check("directive → rules-zone create", decision.op === "create" && decision.zone === "rules");

  const entry2 = makeEntry("draft-test2", { hypothesis: "Some observation" });
  const decision2 = promotion.buildProposerDecisionFromStagingEntry(entry2);
  check("non-directive → knowledge create", decision2.op === "create" && !decision2.zone);
}

// ── [3] findSemanticDuplicate ───────────────────────────────────────────
console.log("\n[3] findSemanticDuplicate");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-dedup-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const title = "Duplicate title";
    const slug = slugify(title);
    createDurableEntry(tmpRoot, projectId, slug, { title, body: "Always use yarn for package management in this project because it is the chosen package manager." });

    const entry = makeEntry("dup-cand", { hypothesis: title, source_utterance: [{ quote: "unused", context: "", captured_at: new Date().toISOString() }] });
    const draft = promotion.buildDraftFromStagingEntry(entry);
    const dup = await promotion.findSemanticDuplicate(entry, draft, tmpRoot, projectId);
    check("exact slug duplicate detected", dup.duplicate === true && dup.reason === "exact_slug");

    const entry2 = makeEntry("dup-cand2", { hypothesis: "Different title", source_utterance: [{ quote: "Always use yarn for package management in this project because it is the chosen package manager", context: "", captured_at: new Date().toISOString() }] });
    const draft2 = promotion.buildDraftFromStagingEntry(entry2);
    const dup2 = await promotion.findSemanticDuplicate(entry2, draft2, tmpRoot, projectId);
    check("quote containment duplicate detected", dup2.duplicate === true && dup2.reason === "quote_contained");

    const entry2b = makeEntry("dup-cand2b", { hypothesis: "Different title", source_utterance: [{ quote: "The body content", context: "", captured_at: new Date().toISOString() }] });
    const draft2b = promotion.buildDraftFromStagingEntry(entry2b);
    const dup2b = await promotion.findSemanticDuplicate(entry2b, draft2b, tmpRoot, projectId);
    check("short quote containment ignored (<40 chars)", dup2b.duplicate === false);

    const entry3 = makeEntry("dup-cand3", { hypothesis: "Different title", source_utterance: [{ quote: "nothing shared", context: "", captured_at: new Date().toISOString() }] });
    const draft3 = promotion.buildDraftFromStagingEntry(entry3);
    const dup3 = await promotion.findSemanticDuplicate(entry3, draft3, tmpRoot, projectId);
    check("non-duplicate returns false", dup3.duplicate === false);
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [4] runStagingPromotionIfDue: approve → durable write + promoted mark
console.log("\n[4] multi-view approve → durable write");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-ok-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-proj-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const slug = "promote-ok";
    const file = writeStaging(makeEntry(slug, { resolver_disposition: "promote_candidate", origin_project_id: projectId, origin_project_root: projectRoot }));

    const writtenSlugs = [];
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => ({
        triggered: true,
        trigger_reason: "create_high_confidence",
        final_decision: { op: "create", rationale: "approved" },
        durationMs: 1,
      }),
      writeApprovedToBrain: async (decision, candidate) => {
        writtenSlugs.push(candidate.title);
        return slugify(candidate.title);
      },
      now: new Date(),
    });

    check("approve: result ok", result.ok === true);
    check("approve: promoted slug recorded", result.promoted_slugs.includes(slug), JSON.stringify(result.promoted_slugs));
    check("approve: writer invoked once", writtenSlugs.length === 1 && writtenSlugs[0].includes("hypothesis"));

    const entryAfter = readStagingEntry(slug);
    check("approve: attribution_pending=false", entryAfter.attribution_pending === false);
    check("approve: promoted_at set", typeof entryAfter.promoted_at === "string");
    check("approve: promoted_to_slug set", typeof entryAfter.promoted_to_slug === "string");
    check("approve: promotion_outcome=promoted", entryAfter.promotion_outcome === "promoted");
    check("approve: file NOT unlinked", fs.existsSync(file));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [5] runStagingPromotionIfDue: reject → retained + attempted_at ──────
console.log("\n[5] multi-view reject → retained");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-rej-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-proj2-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const slug = "promote-rejected";
    const file = writeStaging(makeEntry(slug, { resolver_disposition: "promote_candidate", origin_project_id: projectId, origin_project_root: projectRoot }));

    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => ({
        triggered: true,
        trigger_reason: "create_high_confidence",
        final_decision: { op: "skip", reason: "multiview_rejected", rationale: "not durable enough" },
        durationMs: 1,
      }),
      writeApprovedToBrain: async () => { throw new Error("should not be called"); },
      now: new Date(),
    });

    check("reject: rejected slug recorded", result.rejected_slugs.includes(slug), JSON.stringify(result.rejected_slugs));
    check("reject: writer NOT called", result.promoted_slugs.length === 0);

    const entryAfter = readStagingEntry(slug);
    check("reject: attribution_pending still true", entryAfter.attribution_pending === true);
    check("reject: promotion_attempted_at set", typeof entryAfter.promotion_attempted_at === "string");
    check("reject: promotion_outcome=rejected", entryAfter.promotion_outcome === "rejected");
    check("reject: file retained", fs.existsSync(file));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [6] duplicate → no write, attribution_pending=false ────────────────
console.log("\n[6] duplicate detection → no durable write");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-dup-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-proj3-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const title = "Existing signal";
    const slug = slugify(title);
    createDurableEntry(tmpRoot, projectId, slug, { title, body: "Body of existing signal" });
    const file = writeStaging(makeEntry("dup-cand", { hypothesis: title, source_utterance: [{ quote: "Body of existing signal", context: "", captured_at: new Date().toISOString() }], resolver_disposition: "promote_candidate", origin_project_id: projectId, origin_project_root: projectRoot }));

    let writerCalled = false;
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => { writerCalled = true; throw new Error("should not reach multi-view"); },
      writeApprovedToBrain: async () => { throw new Error("should not be called"); },
      now: new Date(),
    });

    check("duplicate: duplicate slug recorded", result.duplicate_slugs.includes("dup-cand"));
    check("duplicate: writer/multi-view NOT called", writerCalled === false);

    const entryAfter = readStagingEntry("dup-cand");
    check("duplicate: attribution_pending=false", entryAfter.attribution_pending === false);
    check("duplicate: promotion_outcome=duplicate", entryAfter.promotion_outcome === "duplicate");
    check("duplicate: file retained", fs.existsSync(file));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [7] idempotence: promoted entry is not re-promoted ──────────────────
console.log("\n[7] idempotence");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-idem-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-proj4-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const slug = "already-promoted";
    writeStaging(makeEntry(slug, {
      resolver_disposition: "promote_candidate",
      attribution_pending: false,
      promotion_outcome: "promoted",
      promoted_at: new Date().toISOString(),
      promoted_to_slug: slug,
    }));

    let writerCalled = false;
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => { writerCalled = true; throw new Error("should not reach multi-view"); },
      writeApprovedToBrain: async () => { writerCalled = true; return "x"; },
      now: new Date(),
    });

    check("idempotence: no candidates selected", result.skipped === "no_candidates", JSON.stringify(result));
    check("idempotence: writer/multi-view NOT called", writerCalled === false);
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [8] flag off → does not run ───────────────────────────────────────
console.log("\n[8] stagingPromotionEnabled=false → skip");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-off-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-proj5-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    writeStaging(makeEntry("off-cand", { resolver_disposition: "promote_candidate" }));

    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings({ stagingPromotionEnabled: false }),
      now: new Date(),
    });

    check("flag off → skipped=disabled", result.skipped === "disabled", JSON.stringify(result));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [9] autoLlmWriteEnabled tristate respect ──────────────────────────
console.log("\n[9] autoLlmWriteEnabled !== true → skip");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-tristate-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-proj6-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    writeStaging(makeEntry("tristate-cand", { resolver_disposition: "promote_candidate" }));

    const r1 = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings({ autoLlmWriteEnabled: false }),
      now: new Date(),
    });
    check("autoLlmWriteEnabled=false → disabled", r1.skipped === "disabled");

    const r2 = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings({ autoLlmWriteEnabled: "staging-only" }),
      now: new Date(),
    });
    check("autoLlmWriteEnabled=staging-only → disabled", r2.skipped === "disabled");
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [10] source-level wiring locks ──────────────────────────────────────
console.log("\n[10] source-level wiring");
{
  const idx = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
  check("index imports runStagingPromotionIfDue", /runStagingPromotionIfDue/.test(idx));
  check("index schedules runStagingPromotionIfDue", /runStagingPromotionIfDue\(/.test(idx));
  check("index gates promotion on stagingPromotionEnabled + autoLlmWriteEnabled", /stagingPromotionEnabled === true && settings\.autoLlmWriteEnabled === true/.test(idx));
  check("index audit row includes prompt_version", /STAGING_PROMOTION_PROMPT_VERSION/.test(idx));

  const agg = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf-8");
  check("aggregator has staging-promotion-default-off structural entry", /staging-promotion-default-off/.test(agg));

  const mod = fs.readFileSync(path.join(repoRoot, "extensions/sediment/staging-promotion.ts"), "utf-8");
  // The only unlinkSync calls allowed are advisory-lock release; no staging
  // hypothesis file is ever unlinked (non-destructive invariant).
  const unlinkCalls = mod.match(/unlinkSync\([^)]*\)/g) || [];
  const lockUnlink = unlinkCalls.every((c) => /unlinkSync\(file\)/.test(c));
  check("promotion module never unlinks a staging file", unlinkCalls.length === 0 || lockUnlink, JSON.stringify(unlinkCalls));
  check("promotion module respects autoLlmWriteEnabled tristate", /autoLlmWriteEnabled !== true/.test(mod));
}

// ── [11] FIX-1b: untriggered multi-view must not reach durable write ─────
console.log("\n[11] untriggered multi-view → error, no write");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-untrig-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projU-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const slug = "promote-untriggered";
    const file = writeStaging(makeEntry(slug, { resolver_disposition: "promote_candidate", origin_project_id: projectId, origin_project_root: projectRoot }));
    let writerCalled = false;
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => ({
        triggered: false,
        final_decision: { op: "create", rationale: "would bypass A'" },
        durationMs: 1,
      }),
      writeApprovedToBrain: async () => { writerCalled = true; throw new Error("should not be called"); },
      now: new Date(),
    });

    check("untriggered: writer NOT called", writerCalled === false);
    check("untriggered: outcome=error", result.rejected_slugs.includes(slug), JSON.stringify(result.rejected_slugs));
    const entryAfter = readStagingEntry(slug);
    check("untriggered: attribution_pending still true", entryAfter.attribution_pending === true);
    check("untriggered: promotion_outcome=error", entryAfter.promotion_outcome === "error");
    check("untriggered: file retained", fs.existsSync(file));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [12] debounce: second run does not re-process the same candidate ───
console.log("\n[12] daily debounce prevents second run");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-debounce-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projD-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    writeStaging(makeEntry("debounce-cand", {
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));
    const now = new Date();
    let writerCalls = 0;
    const run = () => promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => ({
        triggered: true,
        trigger_reason: "forced",
        final_decision: { op: "create", rationale: "approved" },
        durationMs: 1,
      }),
      writeApprovedToBrain: async () => { writerCalls++; return `slug-${writerCalls}`; },
      now,
    });

    const r1 = await run();
    check("first run: writer called once", writerCalls === 1 && r1.promoted_slugs.length === 1);
    const r2 = await run();
    check("second run: debounced", r2.skipped === "debounced", JSON.stringify(r2));
    check("second run: writer not called again", writerCalls === 1);
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [13] cap selects the oldest N entries in order ─────────────────────
console.log("\n[13] cap selects oldest N in order");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-cap-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projC-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const base = Date.now();
    for (let i = 5; i >= 1; i--) {
      const created = new Date(base - i * 60_000).toISOString();
      writeStaging(makeEntry(`cap-${i}`, {
        created,
        resolver_disposition: "promote_candidate",
        origin_project_id: projectId,
        origin_project_root: projectRoot,
      }));
    }
    const selected = (await promotion.selectPromoteCandidates(new Date(), 3, {
      projectRoot,
      projectId,
      abrainHome: tmpRoot,
    })).map((c) => c.entry.slug);
    check("cap=3 returns exactly 3", selected.length === 3, selected.join(","));
    check("cap=3 returns oldest first", JSON.stringify(selected) === JSON.stringify(["cap-5", "cap-4", "cap-3"]), JSON.stringify(selected));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [14] FIX-2: cross-project queue drains only owned entries ───────────
console.log("\n[14] cross-project attribution");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-cross-"));
  const projectRootA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projA-"));
  const projectRootB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projB-"));
  const projectIdA = "projectA";
  const projectIdB = "projectB";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    writeStaging(makeEntry("cross-a", {
      resolver_disposition: "promote_candidate",
      origin_project_id: projectIdA,
      origin_project_root: projectRootA,
    }));
    writeStaging(makeEntry("cross-b", {
      resolver_disposition: "promote_candidate",
      origin_project_id: projectIdB,
      origin_project_root: projectRootB,
    }));

    const promote = async (projectRoot, projectId) => {
      let called = false;
      const r = await promotion.runStagingPromotionIfDue({
        projectRoot,
        abrainHome: tmpRoot,
        projectId,
        settings: makeSettings(),
        minIntervalMs: 0,
        modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
        runMultiView: async () => ({
          triggered: true,
          trigger_reason: "forced",
          final_decision: { op: "create", rationale: "approved" },
          durationMs: 1,
        }),
        writeApprovedToBrain: async () => { called = true; return "written"; },
        now: new Date(),
      });
      return { called, r };
    };

    const a = await promote(projectRootA, projectIdA);
    const b = await promote(projectRootB, projectIdB);

    check("project A processed its own entry", a.called === true && a.r.promoted_slugs.includes("cross-a"));
    check("project B processed its own entry", b.called === true && b.r.promoted_slugs.includes("cross-b"));
    check("project A did not process B's entry", a.r.promoted_slugs.includes("cross-b") === false);
    check("project B did not process A's entry", b.r.promoted_slugs.includes("cross-a") === false);
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRootA, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRootB, { recursive: true, force: true }); } catch {}
  }
}

// ── [15] FIX-5 + FIX-6 outcome semantics ────────────────────────────────
console.log("\n[15] outcome semantics: staged_for_replay sibling + duplicate writer skip");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-outcome-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projO-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const replayCreated = new Date().toISOString();
    const siblingCreated = new Date(Date.now() + 1).toISOString();

    // FIX-6: staged_for_replay representative + sibling should defer sibling state.
    writeStaging(makeEntry("stage-replay", {
      created: replayCreated,
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));
    writeStaging(makeEntry("stage-replay", {
      created: siblingCreated,
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
      hypothesis: "sibling for replay deferral",
      source_utterance: [{ quote: "sibling for replay deferral", context: "", captured_at: siblingCreated }],
    }));
    const replay = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      minIntervalMs: 0,
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => ({
        triggered: true,
        trigger_reason: "forced",
        final_decision: { op: "skip", reason: "multiview_staged_for_replay", rationale: "defer" },
        staged: { slug: "multiview-pending-xyz", state: "deferred", path: "/tmp/fake" },
        durationMs: 1,
      }),
      writeApprovedToBrain: async () => { throw new Error("should not be called"); },
      now: new Date(),
    });
    const replayEntries = readStagingEntries("stage-replay");
    const replayEntry = replayEntries.find((entry) => entry.promotion_outcome === "staged_for_replay");
    const siblingEntry = replayEntries.find((entry) => entry.promotion_outcome === "sibling_deferred");
    check("staged_for_replay recorded", replay.staged_for_replay_slugs.includes("stage-replay"), JSON.stringify(replay));
    check("staged_for_replay representative preserved", replayEntry?.attribution_pending === true && replayEntry?.promotion_outcome === "staged_for_replay", JSON.stringify(replayEntries));
    check("staged_for_replay sibling deferred", siblingEntry?.promotion_outcome === "sibling_deferred" && siblingEntry?.attribution_pending === true, JSON.stringify(replayEntries));
    check("staged_for_replay sibling has no promoted_to_slug", siblingEntry?.promoted_to_slug === undefined, JSON.stringify(siblingEntry));

    // FIX-5: writer dedupe skip → outcome duplicate. We create a rule first,
    // then promote a rules-zone directive whose body is similar enough to
    // trigger the writer-side semantic dedupe, which maps to status "skipped".
    const ruleTitle = "Use yarn exclusively";
    const ruleSlug = slugify(ruleTitle);
    const ruleDir = path.join(tmpRoot, "projects", projectId, "rules", "listed");
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(
      path.join(ruleDir, `${ruleSlug}.md`),
      `---\nslug: ${ruleSlug}\ntitle: "${ruleTitle}"\nkind: instruction\nstatus: active\nconfidence: 8\n---\n\nAlways use yarn for package management in this project.\n`,
      "utf-8",
    );
    writeStaging(makeEntry("writer-dedupe", {
      hypothesis: ruleTitle,
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
      correction_signal: {
        signal_found: true,
        typing: "durable",
        confidence: 9,
        is_directive: true,
        correction_intent: "tool preference",
        scope_description: "package manager",
        target_entry_slug: null,
        most_likely_error_direction: "",
      },
    }));
    const dedupe = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      minIntervalMs: 0,
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => ({
        triggered: true,
        trigger_reason: "forced",
        final_decision: {
          op: "create",
          zone: "rules",
          injectMode: "listed",
          ruleScope: "project",
          rationale: "approved",
        },
        durationMs: 1,
      }),
      now: new Date(),
    });
    check("writer dedupe recorded as duplicate", dedupe.duplicate_slugs.includes("writer-dedupe"), JSON.stringify(dedupe));
    const dedupeEntry = readStagingEntry("writer-dedupe");
    check("writer dedupe: attribution_pending=false", dedupeEntry.attribution_pending === false);
    check("writer dedupe: promotion_outcome=duplicate", dedupeEntry.promotion_outcome === "duplicate");
    check("writer dedupe: matched slug recorded", typeof dedupeEntry.promoted_to_slug === "string" && dedupeEntry.promoted_to_slug.length > 0);
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [16] forced pending replay preserves reviewer trigger ──────────────
console.log("\n[16] forced pending replay invokes reviewer path");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-forced-replay-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projF-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const created = new Date().toISOString();
    pendingIo.writeMultiviewPending({
      slug: "multiview-pending-forced-smoke",
      status: "provisional",
      kind: "multiview-pending",
      created,
      origin_project_id: projectId,
      origin_project_root: projectRoot,
      originating_device: "smoke",
      multiview_state: "pass1_call_failed",
      proposer_decision: { op: "create", rationale: "forced promotion retry" },
      proposer_raw_text: "forced promotion retry",
      candidate_snapshot: {
        title: "Low confidence forced candidate",
        kind: "fact",
        compiledTruth: "Low confidence forced candidate should still get reviewer replay.",
        status: "active",
        confidence: 5,
      },
      correction_signal: null,
      neighbor_slugs: [],
      trigger_reason: "forced",
      retry_attempts: 0,
      last_attempt_iso: created,
    });

    let findCalls = 0;
    let authCalls = 0;
    const result = await replay.replayMultiviewPending({
      settings: makeSettings(),
      currentProjectId: projectId,
      currentProjectRoot: projectRoot,
      modelRegistry: {
        find: (provider, modelId) => {
          if (provider === "provider-b" && modelId === "model-b") {
            findCalls++;
            return { provider, modelId };
          }
          return null;
        },
        getApiKeyAndHeaders: async () => {
          authCalls++;
          return { ok: false, error: "smoke auth stop after reviewer selection" };
        },
      },
      loadNeighborsBySlug: async () => [],
      writeApprovedToBrain: async () => { throw new Error("should not write while reviewer auth fails"); },
    });

    check("forced replay: reviewer model selected", findCalls > 0, `findCalls=${findCalls}`);
    check("forced replay: reviewer auth path invoked", authCalls > 0, `authCalls=${authCalls}`);
    check("forced replay: does not archive as trigger disappeared", result.re_staged === 1 && result.succeeded === 0, JSON.stringify(result));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [17] explicit quoted slug suggestion controls writer + promoted_to_slug
console.log("\n[17] explicit quoted slug suggestion → canonical durable slug");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-slug-quote-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projSQ-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const stagingSlug = "slug-quote-cand";
    writeStaging(makeEntry(stagingSlug, {
      hypothesis: "需要一个 durable 条目，slug 可能为 'agents-md-extension-agnostic-policy'，描述: AGENTS.md must remain extension agnostic.",
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));

    let seenTitle = "";
    let multiViewCalls = 0;
    let writerCalls = 0;
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async ({ candidate }) => {
        multiViewCalls++;
        seenTitle = candidate.title;
        return {
          triggered: true,
          trigger_reason: "forced",
          final_decision: { op: "create", rationale: "approved" },
          durationMs: 1,
        };
      },
      writeApprovedToBrain: async () => {
        writerCalls++;
        return "an-entry-capturing-the-principle-that-agents-md-must-remain-extension-agnostic";
      },
      now: new Date(),
    });

    const entryAfter = readStagingEntry(stagingSlug);
    check("quoted slug: multi-view called once", multiViewCalls === 1);
    check("quoted slug: writer called once", writerCalls === 1);
    check("quoted slug: writer candidate title slugifies canonically", slugify(seenTitle) === "agents-md-extension-agnostic-policy", seenTitle);
    check("quoted slug: title is not meta request", !/需要一个|slug 可能为/.test(seenTitle), seenTitle);
    check("quoted slug: result durable slug canonical", result.promoted_to_slugs.includes("agents-md-extension-agnostic-policy"), JSON.stringify(result));
    check("quoted slug: promoted_to_slug canonical", entryAfter.promoted_to_slug === "agents-md-extension-agnostic-policy", JSON.stringify(entryAfter));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [18] explicit backtick slug suggestion controls writer + promoted_to_slug
console.log("\n[18] explicit backtick slug suggestion → canonical durable slug");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-slug-backtick-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projSB-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const stagingSlug = "slug-backtick-cand";
    writeStaging(makeEntry(stagingSlug, {
      hypothesis: "需要一个 durable 作业安全条目，slug 如 `Agents_MD_Extension_Agnostic_Policy`，描述: agents md extension agnostic policy should remain extension agnostic.",
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));

    let seenTitle = "";
    let writerCalls = 0;
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async ({ candidate }) => {
        seenTitle = candidate.title;
        return {
          triggered: true,
          trigger_reason: "forced",
          final_decision: { op: "create", rationale: "approved" },
          durationMs: 1,
        };
      },
      writeApprovedToBrain: async (decision, candidate) => {
        writerCalls++;
        return slugify(candidate.title);
      },
      now: new Date(),
    });

    const entryAfter = readStagingEntry(stagingSlug);
    check("backtick slug: writer called once", writerCalls === 1);
    check("backtick slug: mixed-case underscore slug canonicalized", slugify(seenTitle) === "agents-md-extension-agnostic-policy", seenTitle);
    check("backtick slug: title is not meta request", !/需要一个|slug 如/.test(seenTitle), seenTitle);
    check("backtick slug: result durable slug canonical", result.promoted_to_slugs.includes("agents-md-extension-agnostic-policy"), JSON.stringify(result));
    check("backtick slug: promoted_to_slug canonical", entryAfter.promoted_to_slug === "agents-md-extension-agnostic-policy", JSON.stringify(entryAfter));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [18a] explicit English slug-like suggestion controls writer + promoted_to_slug
console.log("\n[18a] explicit English slug like suggestion → canonical durable slug");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-slug-like-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projSL-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const stagingSlug = "slug-like-cand";
    writeStaging(makeEntry(stagingSlug, {
      hypothesis: "An entry with slug like 't0-three-model-cross-provider-review-methodology' describing: use three-model cross-provider review",
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));

    let seenTitle = "";
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async ({ candidate }) => {
        seenTitle = candidate.title;
        return {
          triggered: true,
          trigger_reason: "forced",
          final_decision: { op: "create", rationale: "approved" },
          durationMs: 1,
        };
      },
      writeApprovedToBrain: async (decision, candidate) => slugify(candidate.title),
      now: new Date(),
    });

    const entryAfter = readStagingEntry(stagingSlug);
    check("slug like: identity ok", result.ok === true && result.rejected_slugs.includes(stagingSlug) === false, JSON.stringify(result));
    check("slug like: extracted canonical slug", result.promoted_to_slugs.includes("t0-three-model-cross-provider-review-methodology"), JSON.stringify(result));
    check("slug like: title slugifies canonically", slugify(seenTitle) === "t0-three-model-cross-provider-review-methodology", seenTitle);
    check("slug like: promoted_to_slug canonical", entryAfter.promoted_to_slug === "t0-three-model-cross-provider-review-methodology", JSON.stringify(entryAfter));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [18b] slug cleanup removes trailing similarity crumbs
console.log("\n[18b] slug cleanup removes trailing similarity crumbs");
{
  const entry = makeEntry("slug-similar-crumb", {
    hypothesis: "slug 可能为 'foo-bar-policy' 或类似。该条目描述:XYZ",
  });
  const draft = promotion.buildDraftFromStagingEntry(entry);
  check("slug cleanup: title has no similarity crumb", !/或类似/.test(draft.title), draft.title);
  check("slug cleanup: body has no similarity crumb", !/或类似/.test(draft.compiledTruth), draft.compiledTruth);
}

// ── [19] invalid slug candidate → error before multi-view / writer
console.log("\n[19] invalid slug candidate → error, no writer");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-invalid-slug-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projIS-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const stagingSlug = "invalid-slug-cand";
    writeStaging(makeEntry(stagingSlug, {
      hypothesis: "需要一个条目，描述这个偏好",
      source_utterance: [{ quote: "这个偏好以后要记住", context: "", captured_at: new Date().toISOString() }],
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));

    let multiViewCalls = 0;
    let writerCalls = 0;
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => { multiViewCalls++; throw new Error("should not be called"); },
      writeApprovedToBrain: async () => { writerCalls++; return "should-not-write"; },
      now: new Date(),
    });

    const entryAfter = readStagingEntry(stagingSlug);
    check("invalid slug: multi-view not called", multiViewCalls === 0);
    check("invalid slug: writer not called", writerCalls === 0);
    check("invalid slug: result rejected", result.rejected_slugs.includes(stagingSlug), JSON.stringify(result));
    check("invalid slug: promotion_outcome=error", entryAfter.promotion_outcome === "error", JSON.stringify(entryAfter));
    check("invalid slug: rationale", entryAfter.promotion_rationale === "invalid_slug_candidate", JSON.stringify(entryAfter));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── [20] same provisional slug cluster processes one representative only
console.log("\n[20] same provisional slug cluster → one representative");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-cluster-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-promo-projCL-"));
  const projectId = "smokeproject";
  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpRoot;
  try {
    const sharedSlug = "provisional-2772c60f";
    const base = Date.now();
    writeStaging(makeEntry(sharedSlug, {
      created: new Date(base - 60_000).toISOString(),
      hypothesis: "Use one active work stage per item",
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));
    writeStaging(makeEntry(sharedSlug, {
      created: new Date(base).toISOString(),
      hypothesis: "Use one active work stage per item",
      resolver_disposition: "promote_candidate",
      origin_project_id: projectId,
      origin_project_root: projectRoot,
    }));

    let multiViewCalls = 0;
    let writerCalls = 0;
    const result = await promotion.runStagingPromotionIfDue({
      projectRoot,
      abrainHome: tmpRoot,
      projectId,
      settings: makeSettings(),
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) },
      runMultiView: async () => {
        multiViewCalls++;
        return {
          triggered: true,
          trigger_reason: "forced",
          final_decision: { op: "create", rationale: "approved" },
          durationMs: 1,
        };
      },
      writeApprovedToBrain: async (decision, candidate) => {
        writerCalls++;
        return slugify(candidate.title);
      },
      now: new Date(),
    });

    const entries = readStagingEntries(sharedSlug);
    const outcomes = entries.map((e) => e.promotion_outcome).sort();
    check("cluster: selected one representative", result.reviewed_count === 1, JSON.stringify(result));
    check("cluster: multi-view called once", multiViewCalls === 1);
    check("cluster: writer called once", writerCalls === 1);
    check("cluster: no second promoted staging outcome", outcomes.filter((o) => o === "promoted").length === 1, JSON.stringify(outcomes));
    check("cluster: sibling marked cluster_sibling", outcomes.includes("cluster_sibling"), JSON.stringify(outcomes));
    check("cluster: sibling points at representative target", entries.every((e) => e.promoted_to_slug === "use-one-active-work-stage-per-item"), JSON.stringify(entries));
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) { console.log("FAILURES — investigate before commit"); process.exit(1); }
process.exit(0);
