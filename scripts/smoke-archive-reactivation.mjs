#!/usr/bin/env node
/**
 * Smoke: ADR 0025 §4.6 archive-reactivation-reviewer v1 (Stage 2)
 *
 * Locks the pure / unit-level invariants of
 * extensions/sediment/archive-reactivation.ts:
 *
 *   - parseArchiveReactivationOutput tolerates missing/extra fields
 *   - parseArchiveReactivationOutput defaults unknown decisions to
 *     keep_archived (default-conservative)
 *   - debounce: second call within minIntervalMs returns skipped:debounced
 *   - empty archived set → skipped:no_candidates (no LLM call)
 *   - missing modelRegistry → skipped:model_registry_unavailable
 *   - missing decisions in LLM output are defaulted to keep_archived
 *     per-slug (reviewed_count == decisions.length invariant)
 *
 * Plus source-level invariants for sediment integration + aggregator
 * STRUCTURAL_CONTEXT cleanup + promptVersion bump.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  }).outputText;
}

function loadCJS(code, fakePath, stubMap) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  const origLoad = Module._load;
  if (stubMap) {
    Module._load = function patched(request, parent, ...rest) {
      if (stubMap.has(request)) return stubMap.get(request);
      return origLoad.call(this, request, parent, ...rest);
    };
  }
  try {
    m._compile(code, fakePath);
  } finally {
    if (stubMap) Module._load = origLoad;
  }
  return m.exports;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-reactivation-smoke-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archive-reactivation-proj-"));

// Stubs for runtime imports.
const runtimeStub = {
  ensureUserGlobalSidecarMigrated: () => {},
  formatLocalIsoTimestamp: (d) => (d ?? new Date()).toISOString(),
  userGlobalSedimentDir: () => path.join(tmpDir, "user-global-sediment"),
};
const causalAnchorStub = {
  getCurrentAnchor: () => undefined,
  spreadAnchor: () => ({}),
};
const sanitizerStub = {
  sanitizeForMemory: (text) => ({ ok: true, text, replacements: [] }),
};

// Build a chained Module._load stub map.
const stubMap = new Map([
  ["../_shared/runtime", runtimeStub],
  ["../_shared/causal-anchor", causalAnchorStub],
  ["./sanitizer", sanitizerStub],
]);

const arPath = path.join(repoRoot, "extensions/sediment/archive-reactivation.ts");
const arCjs = transpile(arPath);
const arOutPath = path.join(tmpDir, "archive-reactivation.cjs");
fs.writeFileSync(arOutPath, arCjs);
const arMod = loadCJS(arCjs, arOutPath, stubMap);

const {
  parseArchiveReactivationOutput,
  runArchiveReactivationIfDue,
  archiveReactivationLastRunPath,
  archiveReactivationLedgerPath,
} = arMod;

console.log("Section: parseArchiveReactivationOutput");

check("strict JSON with 3 valid decisions parses cleanly", () => {
  const raw = JSON.stringify({
    decisions: [
      { slug: "prefer-pnpm", decision: "reactivate", rationale: "live use", archived_quote: "use pnpm", user_quote: "pnpm install", age_days_approx: 5 },
      { slug: "old-pattern", decision: "keep_archived", rationale: "no bridge", archived_quote: "", user_quote: "", age_days_approx: 12 },
      { slug: "ancient-prefer", decision: "hard_archive_recommended", rationale: "stale", archived_quote: "", user_quote: "", age_days_approx: 90 },
    ],
  });
  const out = parseArchiveReactivationOutput(raw);
  if (out.decisions.length !== 3) throw new Error(`expected 3 decisions; got ${out.decisions.length}`);
  if (out.decisions[0].decision !== "reactivate") throw new Error("first decision must be reactivate");
  if (out.decisions[2].decision !== "hard_archive_recommended") throw new Error("third decision must be hard_archive_recommended");
});

check("fenced JSON (```json ... ```) parses", () => {
  const raw = "Some preamble.\n```json\n" + JSON.stringify({ decisions: [{ slug: "a", decision: "keep_archived" }] }) + "\n```\n";
  const out = parseArchiveReactivationOutput(raw);
  if (out.decisions.length !== 1 || out.decisions[0].slug !== "a") {
    throw new Error("fenced JSON not parsed correctly");
  }
});

check("unknown decision defaults to keep_archived (conservative)", () => {
  const raw = JSON.stringify({
    decisions: [{ slug: "x", decision: "delete_aggressively", rationale: "made up" }],
  });
  const out = parseArchiveReactivationOutput(raw);
  if (out.decisions[0].decision !== "keep_archived") {
    throw new Error("unknown decision must default to keep_archived");
  }
});

check("missing optional fields default to safe values", () => {
  const raw = JSON.stringify({
    decisions: [{ slug: "x", decision: "reactivate" }],
  });
  const out = parseArchiveReactivationOutput(raw);
  if (out.decisions[0].rationale !== "") throw new Error("rationale default '' missing");
  if (out.decisions[0].archived_quote !== "") throw new Error("archived_quote default '' missing");
  if (out.decisions[0].age_days_approx !== 0) throw new Error("age_days_approx default 0 missing");
});

check("malformed JSON throws (caller catches as degraded)", () => {
  let threw = false;
  try {
    parseArchiveReactivationOutput("not json {{}");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("malformed JSON must throw");
});

check("entry without slug is silently dropped (not crashed)", () => {
  const raw = JSON.stringify({
    decisions: [
      { decision: "reactivate" }, // missing slug
      { slug: "good", decision: "keep_archived" },
    ],
  });
  const out = parseArchiveReactivationOutput(raw);
  if (out.decisions.length !== 1 || out.decisions[0].slug !== "good") {
    throw new Error("entry without slug must be dropped");
  }
});

check("rationale > 500 chars is clipped", () => {
  const long = "y".repeat(800);
  const raw = JSON.stringify({
    decisions: [{ slug: "x", decision: "reactivate", rationale: long }],
  });
  const out = parseArchiveReactivationOutput(raw);
  if (out.decisions[0].rationale.length > 500) {
    throw new Error("rationale must be clipped at 500 chars");
  }
});

console.log("\nSection: runArchiveReactivationIfDue skipped paths");

await checkAsync("empty archived set → skipped:no_candidates (no LLM call)", async () => {
  const fakeRegistry = { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) };
  const r = await runArchiveReactivationIfDue({
    projectRoot,
    archivedEntries: [],
    windowText: "user: hello",
    settings: { aggregatorModel: "test/test", aggregatorTimeoutMs: 10_000, aggregatorMaxRetries: 0, autoLlmWriteEnabled: true },
    modelRegistry: fakeRegistry,
    sessionId: "test-sess",
  });
  if (r.skipped !== "no_candidates") throw new Error(`expected skipped:no_candidates; got ${r.skipped}`);
  if (r.reviewed_count !== 0) throw new Error("reviewed_count should be 0 when no candidates");
});

await checkAsync("missing modelRegistry → skipped:model_registry_unavailable", async () => {
  // Use a fresh project root so prior last_run doesn't trigger debounce.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-noreg-"));
  const r = await runArchiveReactivationIfDue({
    projectRoot: proj,
    archivedEntries: [
      {
        slug: "x",
        kind: "preference",
        status: "archived",
        confidence: 8,
        scope: "project",
        compiledTruth: "use foo",
        frontmatter: { archive_at: new Date().toISOString() },
      },
    ],
    windowText: "user: hi",
    settings: { aggregatorModel: "test/test", aggregatorTimeoutMs: 10_000, aggregatorMaxRetries: 0, autoLlmWriteEnabled: true },
    modelRegistry: undefined,
    sessionId: "test-sess",
  });
  if (r.skipped !== "model_registry_unavailable") {
    throw new Error(`expected skipped:model_registry_unavailable; got ${r.skipped}`);
  }
});

await checkAsync("debounce: second call within minIntervalMs returns skipped:debounced", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-debounce-"));
  // Write a last_run timestamp NOW so the next call is within the
  // debounce window (default 24h).
  const lastRunFile = archiveReactivationLastRunPath(proj);
  fs.mkdirSync(path.dirname(lastRunFile), { recursive: true });
  fs.writeFileSync(
    lastRunFile,
    JSON.stringify({ last_run_ts: new Date().toISOString(), status: "ok" }),
  );
  const fakeRegistry = { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) };
  const r = await runArchiveReactivationIfDue({
    projectRoot: proj,
    archivedEntries: [
      {
        slug: "x",
        kind: "preference",
        status: "archived",
        confidence: 8,
        scope: "project",
        compiledTruth: "use foo",
        frontmatter: { archive_at: new Date().toISOString() },
      },
    ],
    windowText: "user: hi",
    settings: { aggregatorModel: "test/test", aggregatorTimeoutMs: 10_000, aggregatorMaxRetries: 0, autoLlmWriteEnabled: true },
    modelRegistry: fakeRegistry,
    sessionId: "test-sess",
  });
  if (r.skipped !== "debounced") throw new Error(`expected skipped:debounced; got ${r.skipped}`);
});

await checkAsync("minIntervalMs=0 bypasses debounce", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-no-debounce-"));
  const lastRunFile = archiveReactivationLastRunPath(proj);
  fs.mkdirSync(path.dirname(lastRunFile), { recursive: true });
  fs.writeFileSync(
    lastRunFile,
    JSON.stringify({ last_run_ts: new Date().toISOString(), status: "ok" }),
  );
  // No registry → still skipped, but with model_registry_unavailable
  // not debounced (proves debounce was bypassed).
  const r = await runArchiveReactivationIfDue({
    projectRoot: proj,
    archivedEntries: [],
    windowText: "x",
    settings: { aggregatorModel: "test/test", aggregatorTimeoutMs: 10_000, aggregatorMaxRetries: 0, autoLlmWriteEnabled: true },
    modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) },
    sessionId: "test-sess",
    minIntervalMs: 0,
  });
  if (r.skipped === "debounced") throw new Error("minIntervalMs=0 must NOT debounce");
});

console.log("\nSection: source-level integration invariants");

const sedimentSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
const aggregatorSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf-8");
const settingsSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/settings.ts"), "utf-8");

check("sediment/index.ts imports runArchiveReactivationIfDue", () => {
  if (!/import\s*\{\s*runArchiveReactivationIfDue\s*\}\s*from\s*"\.\/archive-reactivation"/.test(sedimentSrc)) {
    throw new Error("missing import { runArchiveReactivationIfDue } from \"./archive-reactivation\"");
  }
});

check("sediment/index.ts schedules archive-reactivation via scheduleAggregator", () => {
  // Look for the call site of runArchiveReactivationIfDue and ensure
  // it's inside a scheduleAggregator(() => { ... }) block. Walk
  // backwards from the call to confirm scheduleAggregator wraps it.
  const callIdx = sedimentSrc.search(/runArchiveReactivationIfDue\(/);
  if (callIdx < 0) throw new Error("could not locate runArchiveReactivationIfDue() call");
  // Look for scheduleAggregator within ~2000 chars before the call.
  const before = sedimentSrc.slice(Math.max(0, callIdx - 2000), callIdx);
  if (!/scheduleAggregator\(/.test(before)) {
    throw new Error(
      "archive-reactivation must be scheduled via the same scheduleAggregator helper used by aggregator (Stage 2 wiring)",
    );
  }
});

check("sediment/index.ts reactivateEntry closure only fires when canMutate=true", () => {
  // The closure should be conditional on settings.autoLlmWriteEnabled === true.
  if (!/canMutate\s*=\s*settings\.autoLlmWriteEnabled\s*===\s*true/.test(sedimentSrc)) {
    throw new Error(
      "reactivate closure must be gated by canMutate = (settings.autoLlmWriteEnabled === true) so staging-only mode doesn't mutate",
    );
  }
});

check("sediment/index.ts uses entryToText for window text (L2 mask preserved)", () => {
  // The archive-reactivation block must use entryToText for window
  // construction so sub-agent toolResult content is withheld (same
  // P0-α discipline as the classifier). Find the runArchiveReactivationIfDue
  // call site and look for entryToText within the surrounding ~1500 chars.
  const callIdx = sedimentSrc.search(/runArchiveReactivationIfDue\(/);
  if (callIdx < 0) throw new Error("could not locate runArchiveReactivationIfDue() call");
  const surrounding = sedimentSrc.slice(
    Math.max(0, callIdx - 1500),
    callIdx + 500,
  );
  if (!/entryToText\(/.test(surrounding)) {
    throw new Error("window text construction near runArchiveReactivationIfDue must use entryToText (L2 mask preserved)");
  }
});

check("aggregator.ts STRUCTURAL_CONTEXT removed archive-reactivation entry", () => {
  if (/id:\s*"archive-reactivation-reviewer-unimplemented"/.test(aggregatorSrc)) {
    throw new Error(
      "STRUCTURAL_CONTEXT must NOT contain archive-reactivation-reviewer-unimplemented anymore (Stage 2 shipped)",
    );
  }
  // staging-resolver should still be there (still unimplemented).
  if (!/id:\s*"staging-resolver-unimplemented"/.test(aggregatorSrc)) {
    throw new Error("staging-resolver-unimplemented MUST still be present (Stage 3 candidate)");
  }
});

check("settings.ts promptVersion.archiveReactivationReviewer bumped to v1", () => {
  if (!/archiveReactivationReviewer:\s*"v1"/.test(settingsSrc)) {
    throw new Error("promptVersion.archiveReactivationReviewer must be \"v1\"");
  }
  // The PROMPT_VERSION_NOTES entry must also be updated.
  if (!/archiveReactivationReviewer:[\s\S]{0,500}?ADR 0025 \u00a74\.6, Stage 2/.test(settingsSrc)) {
    throw new Error("PROMPT_VERSION_NOTES archiveReactivationReviewer must describe v1 (Stage 2)");
  }
});

check("prompt file exists", () => {
  const promptPath = path.join(repoRoot, "extensions/sediment/prompts/archive-reactivation-reviewer-v1.md");
  if (!fs.existsSync(promptPath)) {
    throw new Error("prompts/archive-reactivation-reviewer-v1.md missing");
  }
  const src = fs.readFileSync(promptPath, "utf-8");
  // Quick checks: must mention all 3 decisions, must instruct strict JSON.
  for (const decision of ["keep_archived", "reactivate", "hard_archive_recommended"]) {
    if (!new RegExp(`\\b${decision}\\b`).test(src)) {
      throw new Error(`prompt must mention decision: ${decision}`);
    }
  }
  if (!/STRICT JSON/i.test(src)) throw new Error("prompt must instruct STRICT JSON output");
  if (!/INV-INVISIBILITY/i.test(src)) throw new Error("prompt must reference INV-INVISIBILITY (ADR 0024 §2)");
});

console.log("\nSection: R1 P1 fix regression");

check("P1-A: round-robin reviewedAtPath sidecar function exists", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/function reviewedAtPath\(/.test(src)) {
    throw new Error("reviewedAtPath sidecar helper must exist (round-robin needs per-slug last_reviewed_at)");
  }
  if (!/archive-reactivation-reviewed-at\.json/.test(src)) {
    throw new Error("sidecar filename `archive-reactivation-reviewed-at.json` must be present in source");
  }
});

check("P1-A: selectReviewCandidates uses round-robin priority (not pure DESC slice)", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/function selectReviewCandidates\(/.test(src)) {
    throw new Error("selectReviewCandidates() must exist (round-robin starvation fix)");
  }
  // The old plain DESC slice in buildReviewerPrompt must be gone:
  // buildReviewerPrompt should receive a pre-selected reviewed list.
  const buildFnIdx = src.search(/function buildReviewerPrompt\(/);
  if (buildFnIdx < 0) throw new Error("buildReviewerPrompt missing");
  const buildBody = src.slice(buildFnIdx, buildFnIdx + 1200);
  if (/sorted\.slice\(0,\s*MAX_ENTRIES_PER_RUN\)/.test(buildBody)) {
    throw new Error(
      "buildReviewerPrompt still contains `sorted.slice(0, MAX_ENTRIES_PER_RUN)` — round-robin fix not applied",
    );
  }
  // Priority must factor in `reviewedAt` (not just archive age).
  const selFnIdx = src.search(/function selectReviewCandidates\(/);
  const selBody = src.slice(selFnIdx, selFnIdx + 2000);
  if (!/reviewedAt|lastReviewedMs|sinceReview/.test(selBody)) {
    throw new Error("selectReviewCandidates must factor in last-reviewed-at to avoid tail starvation");
  }
});

check("P1-A: reviewedAt sidecar gets written after a successful run", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/writeReviewedAtMap\(options\.projectRoot,\s*reviewedAtMap\)/.test(src)) {
    throw new Error("reviewedAtMap must be written back at end of successful run (round-robin progression)");
  }
});

check("P1-B: reactivateEntry signature carries scope parameter", () => {
  const arSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  // Interface signature must include (slug, scope, rationale).
  if (!/reactivateEntry\?:\s*\(slug:\s*string,\s*scope:\s*"project"\s*\|\s*"world",\s*rationale:\s*string\)/.test(arSrc)) {
    throw new Error("reactivateEntry signature must be (slug, scope, rationale) — world-scope routing fix");
  }
  // Caller must pass scope at the call site.
  if (!/options\.reactivateEntry\(d\.slug,\s*scope,\s*d\.rationale\)/.test(arSrc)) {
    throw new Error("call to reactivateEntry must pass scope=entry.scope");
  }
});

check("P1-B: sediment/index.ts reactivateEntry closure forwards scope to updateProjectEntry", () => {
  const idxSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
  // Look for the new closure signature.
  if (!/async\s*\(slug:\s*string,\s*scope:\s*"project"\s*\|\s*"world",\s*rationale:\s*string\)/.test(idxSrc)) {
    throw new Error("sediment/index.ts reactivateEntry closure must accept (slug, scope, rationale)");
  }
  // updateProjectEntry options must include scope. We scan a wider
  // window now since R2 added more options entries (auditOperation
  // moved here from the patch).
  const closureIdx = idxSrc.search(/reactivateEntry:\s*canMutate/);
  if (closureIdx < 0) throw new Error("could not locate reactivateEntry closure in sediment/index.ts");
  const closureBody = idxSrc.slice(closureIdx, closureIdx + 2500);
  if (!/^\s*scope,\s*$/m.test(closureBody)) {
    throw new Error("updateProjectEntry options must include `scope,` so world entries route correctly");
  }
});

check("P1-C: reactivate quote substring guard exists", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/reactivate_guard_failed/.test(src)) {
    throw new Error("reactivate_guard_failed downgrade marker must be present (quote substring guard)");
  }
  if (!/truth\.includes\(aq\)/.test(src)) {
    throw new Error("guard must verify archived_quote is substring of compiledTruth");
  }
  if (!/windowText\.includes\(uq\)/.test(src)) {
    throw new Error("guard must verify user_quote is substring of windowText");
  }
});

check("P1-C: guard downgrades to keep_archived (default-conservative) on failure", () => {
  // Source-level check: the guard branch must assign decision=keep_archived,
  // never silently accept reactivate without quotes.
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  const guardBlockIdx = src.search(/reviewedByslug\s*=\s*new Map\(reviewed\.map/);
  if (guardBlockIdx < 0) throw new Error("could not locate guard block");
  const guardBody = src.slice(guardBlockIdx, guardBlockIdx + 1500);
  if (!/decision:\s*"keep_archived"/.test(guardBody)) {
    throw new Error("guard failure path must downgrade to decision=keep_archived");
  }
});

check("P1-D: effectiveArchiveAt fallback to frontmatter.updated/created exists", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/function effectiveArchiveAt\(/.test(src)) {
    throw new Error("effectiveArchiveAt() fallback helper must exist (legacy archive_at backfill)");
  }
  const fnIdx = src.search(/function effectiveArchiveAt\(/);
  const fnBody = src.slice(fnIdx, fnIdx + 1200);
  if (!/fm\.updated|frontmatter\.updated|"updated"/.test(fnBody)) {
    throw new Error("effectiveArchiveAt must fall back to frontmatter.updated");
  }
  if (!/fm\.created|frontmatter\.created|"created"/.test(fnBody)) {
    throw new Error("effectiveArchiveAt must also fall back to frontmatter.created");
  }
});

check("P1-D: prompt input block surfaces fallback source when archive_at missing", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/fallback to frontmatter\./.test(src)) {
    throw new Error("buildReviewerPrompt must surface the fallback source so the LLM knows the age is approximate");
  }
});

// ── Functional behavioral test for round-robin and guard ──────────
// We invoke the pure helpers directly through the loaded module to
// prove behavior, not just structure.
console.log("\nSection: R2 behavioral tests — selectReviewCandidates math (replaces R1 degenerate stubs)");

// Helper: build N synthetic archived MemoryEntry stubs.
function mkEntries(n, prefix = "e", archiveAtFn = (i) => new Date(2026, 0, 1, 0, 0, i).toISOString(), scope = "project") {
  return Array.from({ length: n }, (_, i) => ({
    slug: `${prefix}-${String(i).padStart(3, "0")}`,
    kind: "preference",
    status: "archived",
    confidence: 8,
    scope,
    compiledTruth: `truth-${i}`,
    frontmatter: { archive_at: archiveAtFn(i) },
  }));
}

check("P1-A behavior R2: with 0 reviewed history, all 30 entries get +Inf wait → top 20 chosen deterministically", () => {
  const entries = mkEntries(30);
  const now = new Date("2026-06-01T00:00:00Z");
  const reviewedAt = new Map();
  const picked = arMod.selectReviewCandidates(entries, reviewedAt, now, 20);
  if (picked.length !== 20) throw new Error(`expected 20 picked; got ${picked.length}`);
  // All have lastReviewed=0 → sinceReview=nowMs (tied) → tiebreak
  // archive_at DESC then slug ASC. mkEntries archives at
  // 2026-01-01 + i seconds, so DESC means slug 029 first, 028 second...
  // top 20 = slugs 010..029.
  const pickedSlugs = picked.map(e => e.slug).sort();
  const expected = Array.from({ length: 20 }, (_, k) => `e-${String(k + 10).padStart(3, "0")}`).sort();
  if (JSON.stringify(pickedSlugs) !== JSON.stringify(expected)) {
    throw new Error(`expected slugs [e-010..e-029], got [${pickedSlugs.slice(0, 5).join(",")}...]`);
  }
});

check("P1-A behavior R2 (THE BIG ONE): N=40, two consecutive batches together cover ALL 40 entries (no starvation)", () => {
  const entries = mkEntries(40);
  const now1 = new Date("2026-06-01T00:00:00Z");
  const reviewedAt = new Map();
  // Batch 1: all unreviewed → top 20 by archive_at DESC, slug ASC.
  const batch1 = arMod.selectReviewCandidates(entries, reviewedAt, now1, 20);
  for (const e of batch1) reviewedAt.set(e.slug, now1.toISOString());
  // 24h later, batch 2.
  const now2 = new Date("2026-06-02T00:00:00Z");
  const batch2 = arMod.selectReviewCandidates(entries, reviewedAt, now2, 20);
  const union = new Set([...batch1.map(e => e.slug), ...batch2.map(e => e.slug)]);
  if (union.size !== 40) {
    const batch1Slugs = batch1.map(e => e.slug).sort();
    const batch2Slugs = batch2.map(e => e.slug).sort();
    throw new Error(
      `R1 starvation regression: 2 batches must cover all 40 entries; got union=${union.size}.\n` +
      `  batch1[0..3]=${batch1Slugs.slice(0, 3).join(",")} batch2[0..3]=${batch2Slugs.slice(0, 3).join(",")}`,
    );
  }
});

check("P1-A behavior R2: N=60, 3 consecutive batches together cover ALL 60 entries", () => {
  const entries = mkEntries(60);
  const reviewedAt = new Map();
  const dates = [
    new Date("2026-06-01T00:00:00Z"),
    new Date("2026-06-02T00:00:00Z"),
    new Date("2026-06-03T00:00:00Z"),
  ];
  const union = new Set();
  for (const d of dates) {
    const batch = arMod.selectReviewCandidates(entries, reviewedAt, d, 20);
    if (batch.length !== 20) throw new Error(`expected 20 per batch, got ${batch.length}`);
    for (const e of batch) {
      union.add(e.slug);
      reviewedAt.set(e.slug, d.toISOString());
    }
  }
  if (union.size !== 60) {
    throw new Error(`3 batches must cover all 60 entries; got ${union.size}`);
  }
});

check("P1-A behavior R2: steady state — most-stale (longest sinceReview) wins, regardless of archive_at", () => {
  // Construct a scenario where R1’s formula would fail but R2’s works.
  // 5 entries archived 1000 days ago, reviewed yesterday.
  // 5 entries archived 1 day ago, never reviewed.
  // With MAX=5, the never-reviewed (1-day-old) entries MUST win because
  // they have larger sinceReview (= nowMs, since lastReviewed=0).
  // R1’s formula `max(sinceArchive, sinceReview)` would pick the 1000-day-old
  // entries (sinceArchive dominates).
  const now = new Date("2026-06-01T00:00:00Z");
  const yesterday = new Date("2026-05-31T00:00:00Z").toISOString();
  const oldArchived = mkEntries(5, "old", () => "2023-09-08T00:00:00Z");
  const newArchived = mkEntries(5, "new", () => "2026-05-31T00:00:00Z");
  const reviewedAt = new Map();
  for (const e of oldArchived) reviewedAt.set(e.slug, yesterday);
  // Never-reviewed entries should win.
  const picked = arMod.selectReviewCandidates([...oldArchived, ...newArchived], reviewedAt, now, 5);
  const allNew = picked.every(e => e.slug.startsWith("new-"));
  if (!allNew) {
    throw new Error(
      `R2 LRU semantics violated: with 5 freshly-reviewed old archives + 5 never-reviewed new archives, ` +
      `MAX=5 must pick the never-reviewed ones. Got [${picked.map(e => e.slug).join(",")}]`,
    );
  }
});

check("P1-A behavior R2: future-dated archive_at (corruption) clamps to 0, doesn't yield negative sinceReview", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const future = "2099-01-01T00:00:00Z";
  // Mix one corrupted-future entry with one normal old never-reviewed entry.
  const entries = [
    { slug: "future", kind: "preference", status: "archived", confidence: 8, scope: "project", compiledTruth: "t1", frontmatter: { archive_at: future } },
    { slug: "old", kind: "preference", status: "archived", confidence: 8, scope: "project", compiledTruth: "t2", frontmatter: { archive_at: "2025-01-01T00:00:00Z" } },
  ];
  // Both never-reviewed, so both get sinceReview=nowMs. tiebreak archive_at DESC.
  // BUT future's archive_at is clamped to 0 (treated as legacy), so it loses
  // the tiebreak.
  const picked = arMod.selectReviewCandidates(entries, new Map(), now, 1);
  if (picked[0]?.slug !== "old") {
    throw new Error(`future-dated archive_at must be clamped (not allowed to win tiebreak); got first=${picked[0]?.slug}`);
  }
});

check("P1-A behavior R2: writeReviewedAtMap keeps the NEWEST when over cap (Opus P2-1 fix)", () => {
  // Simulate the cap by directly calling writeReviewedAtMap. We can’t
  // import it (it’s file-private), so verify via a runArchiveReactivationIfDue
  // pre-populate. But the simpler test: ensure the source-level cap +
  // sort-DESC pattern is correct.
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/REVIEWED_AT_MAX_ENTRIES\s*=\s*5000/.test(src)) {
    throw new Error("REVIEWED_AT_MAX_ENTRIES constant must remain 5000");
  }
  // The writeReviewedAtMap function should sort DESC by timestamp
  // before slicing.
  const fnIdx = src.search(/function writeReviewedAtMap\(/);
  if (fnIdx < 0) throw new Error("writeReviewedAtMap missing");
  const fnBody = src.slice(fnIdx, fnIdx + 1500);
  if (!/\.sort\(/.test(fnBody) || !/Date\.parse\(b\[1\]\)/.test(fnBody)) {
    throw new Error("writeReviewedAtMap must sort timestamps DESC before truncating (otherwise keeps oldest)");
  }
  if (!/slice\(0,\s*REVIEWED_AT_MAX_ENTRIES\)/.test(fnBody)) {
    throw new Error("writeReviewedAtMap must slice(0, CAP) after DESC sort");
  }
});

console.log("\nSection: R2 behavioral tests — effectiveArchiveAt fallback");

check("P1-D behavior R2: archive_at present → source=archive_at", () => {
  const eff = arMod.effectiveArchiveAt({
    slug: "x", kind: "preference", status: "archived", confidence: 8, scope: "project",
    compiledTruth: "",
    frontmatter: { archive_at: "2026-01-01T00:00:00Z", updated: "2026-03-01T00:00:00Z", created: "2025-01-01T00:00:00Z" },
  });
  if (eff.source !== "archive_at") throw new Error(`expected source=archive_at; got ${eff.source}`);
  if (eff.value !== "2026-01-01T00:00:00Z") throw new Error(`expected the archive_at value; got ${eff.value}`);
});

check("P1-D behavior R2: archive_at missing, updated present → source=updated", () => {
  const eff = arMod.effectiveArchiveAt({
    slug: "x", kind: "preference", status: "archived", confidence: 8, scope: "project",
    compiledTruth: "",
    frontmatter: { updated: "2026-03-01T00:00:00Z", created: "2025-01-01T00:00:00Z" },
  });
  if (eff.source !== "updated") throw new Error(`expected source=updated; got ${eff.source}`);
  if (eff.value !== "2026-03-01T00:00:00Z") throw new Error(`expected updated value; got ${eff.value}`);
});

check("P1-D behavior R2: archive_at missing, updated missing, created present → source=created", () => {
  const eff = arMod.effectiveArchiveAt({
    slug: "x", kind: "preference", status: "archived", confidence: 8, scope: "project",
    compiledTruth: "",
    frontmatter: { created: "2025-01-01T00:00:00Z" },
  });
  if (eff.source !== "created") throw new Error(`expected source=created; got ${eff.source}`);
});

check("P1-D behavior R2: all missing → source=unknown, value=undefined", () => {
  const eff = arMod.effectiveArchiveAt({
    slug: "x", kind: "preference", status: "archived", confidence: 8, scope: "project",
    compiledTruth: "",
    frontmatter: {},
  });
  if (eff.source !== "unknown") throw new Error(`expected source=unknown; got ${eff.source}`);
  if (eff.value !== undefined) throw new Error(`expected value=undefined; got ${eff.value}`);
});

check("P1-D behavior R2: malformed archive_at (truthy but unparseable) falls through to updated", () => {
  const eff = arMod.effectiveArchiveAt({
    slug: "x", kind: "preference", status: "archived", confidence: 8, scope: "project",
    compiledTruth: "",
    frontmatter: { archive_at: "not-a-date", updated: "2026-03-01T00:00:00Z" },
  });
  if (eff.source !== "updated") throw new Error(`malformed archive_at must fall through; got source=${eff.source}`);
});

console.log("\nSection: R3 hardening — quote min-length guard (Opus P2-R3-1, GPT R2-RESIDUAL-2)");

check("R3 P3-1 + R4 NIT: MIN_QUOTE_BYTES constant exists with value >= 8", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  // R4 NIT fix: renamed MIN_QUOTE_LEN → MIN_QUOTE_BYTES; semantic
  // now matches prompt (bytes via Buffer.byteLength), not UTF-16 .length.
  const m = /MIN_QUOTE_BYTES\s*=\s*(\d+)/.exec(src);
  if (!m) throw new Error("MIN_QUOTE_BYTES constant must be defined for quote-length floor");
  const v = Number(m[1]);
  if (!(v >= 8)) throw new Error(`MIN_QUOTE_BYTES=${v} too lax; recommend >=8 (target 12)`);
});

check("R3 P3-1 + R4 NIT: guard uses Buffer.byteLength (UTF-8 bytes), not .length (UTF-16 code units)", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  if (!/quote_too_short/.test(src)) {
    throw new Error("Source must contain 'quote_too_short' downgrade marker");
  }
  // The guard must use Buffer.byteLength, not .length — otherwise
  // CJK quotes are rejected at a 3× stricter threshold than
  // documented in the prompt.
  if (!/Buffer\.byteLength\(s,\s*"utf8"\)/.test(src)) {
    throw new Error("Guard must use Buffer.byteLength(s, 'utf8') for byte-accurate measurement");
  }
  if (!/qBytes\(aq\)\s*<\s*MIN_QUOTE_BYTES\s*\|\|\s*qBytes\(uq\)\s*<\s*MIN_QUOTE_BYTES/.test(src)) {
    throw new Error("Guard must check qBytes(aq) AND qBytes(uq) against MIN_QUOTE_BYTES");
  }
});

check("R3 P3-1: empty-truth check removed bypass (Opus NIT-1)", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  // The old check was `if (truth && !truth.includes(aq))` which let
  // empty truth bypass. Now it should be unconditional:
  // `if (!truth.includes(aq))`.
  if (/if\s*\(\s*truth\s*&&\s*!truth\.includes\(aq\)/.test(src)) {
    throw new Error("Empty-truth bypass not removed: `if (truth && !truth.includes(aq))` still present");
  }
  if (!/if\s*\(\s*!truth\.includes\(aq\)\s*\)/.test(src)) {
    throw new Error("Expected unconditional `if (!truth.includes(aq))` after Opus NIT-1 fix");
  }
});

check("R3 P3-1 + R4 NIT: prompt declares 12 UTF-8 bytes consistent with code", () => {
  const src = fs.readFileSync(
    path.join(repoRoot, "extensions/sediment/prompts/archive-reactivation-reviewer-v1.md"),
    "utf-8",
  );
  if (!/Minimum quote length/i.test(src)) {
    throw new Error("Prompt §5 must declare a minimum quote length so the LLM doesn’t emit 1-char quotes");
  }
  if (!/12 UTF-8 bytes/.test(src)) {
    throw new Error("Prompt must say 'UTF-8 bytes' (not just 'bytes') to clarify CJK semantics after R4 byte-accurate fix");
  }
  if (!/Buffer\.byteLength/.test(src)) {
    throw new Error("Prompt should reference Buffer.byteLength so reviewer knows the exact measurement");
  }
});

check("R4 P2 fix (GPT): deferred_count surfaced on degraded paths", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  // Find all degraded-path returns and ensure they include deferred_count.
  // Two return blocks marked by `degraded: true,` followed by `degraded_reason`.
  const matches = [...src.matchAll(/degraded:\s*true,\s*\n\s*degraded_reason:[\s\S]{0,600}?duration_ms:/g)];
  if (matches.length < 2) {
    throw new Error(`Expected at least 2 degraded return blocks; found ${matches.length}`);
  }
  for (const m of matches) {
    if (!/deferred_count:\s*deferredCount/.test(m[0])) {
      throw new Error(
        "Every degraded-path return must include `deferred_count: deferredCount` so audit row’s archived_total reflects true batch pressure even on failure",
      );
    }
  }
});

console.log("\nSection: R3 — deferred_count + archived_total in audit row (GPT R2-RESIDUAL-3)");

check("R3 P3-2: audit row includes deferred_count + archived_total", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
  const auditCallIdx = src.search(/operation:\s*"archive_reactivation",/);
  if (auditCallIdx < 0) throw new Error("could not locate archive_reactivation audit call");
  const body = src.slice(auditCallIdx, auditCallIdx + 1500);
  if (!/deferred_count:/.test(body)) {
    throw new Error("audit row must include deferred_count so operators can detect batch starvation pressure");
  }
  if (!/archived_total:/.test(body)) {
    throw new Error("audit row must include archived_total = reviewed_count + deferred_count");
  }
});

check("R3 P3-2: decisions_summary surfaces guard_failed flag", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
  if (!/guard_failed:\s*true/.test(src)) {
    throw new Error("decisions_summary must annotate guard_failed:true for reactivate_guard_failed downgrades");
  }
});

console.log("\nSection: R6 — concurrent-run lock (per-project advisory file lock)");

check("R6: lock helpers exported (tryAcquire + release)", () => {
  if (typeof arMod.tryAcquireArchiveReactivationLock !== "function") {
    throw new Error("tryAcquireArchiveReactivationLock must be exported");
  }
  if (typeof arMod.releaseArchiveReactivationLock !== "function") {
    throw new Error("releaseArchiveReactivationLock must be exported");
  }
  if (typeof arMod.archiveReactivationLockPath !== "function") {
    throw new Error("archiveReactivationLockPath must be exported");
  }
});

check("R6: lock file path is per-project + under .pi-astack/sediment/", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-path-"));
  const p = arMod.archiveReactivationLockPath(proj);
  if (!p.includes(proj)) throw new Error("lock path must be rooted in projectRoot");
  if (!p.endsWith(".pi-astack/sediment/archive-reactivation.lock")) {
    throw new Error(`unexpected lock path tail: ${p}`);
  }
});

check("R6: first acquire succeeds; second acquire (same instant) FAILS", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-contend-"));
  const now = new Date();
  const r1 = arMod.tryAcquireArchiveReactivationLock(proj, now);
  if (!r1.acquired) throw new Error("first acquire must succeed on a fresh project");
  const r2 = arMod.tryAcquireArchiveReactivationLock(proj, now);
  if (r2.acquired) throw new Error("second acquire must FAIL while lock is held (no concurrent run)");
  if (!r2.existingClaim) throw new Error("failed acquire should expose existingClaim for debugging");
  if (r2.existingClaim.pid !== process.pid) throw new Error("existingClaim.pid should be the holder");
  arMod.releaseArchiveReactivationLock(proj);
});

check("R6: after release, next acquire succeeds", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-release-"));
  const now = new Date();
  if (!arMod.tryAcquireArchiveReactivationLock(proj, now).acquired) throw new Error("first acquire failed");
  arMod.releaseArchiveReactivationLock(proj);
  if (!arMod.tryAcquireArchiveReactivationLock(proj, now).acquired) {
    throw new Error("acquire after release must succeed");
  }
  arMod.releaseArchiveReactivationLock(proj);
});

check("R6: stale lock (older than 30 min) is stolen on next acquire", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-stale-"));
  const oldTime = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  // Manually write a stale lock with a fake pid (1 is init, always exists,
  // but on different host so PID check skipped).
  const lockFile = arMod.archiveReactivationLockPath(proj);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 999999,
    host: "some-other-host-that-isnt-us",
    started_at: oldTime.toISOString(),
  }));
  const r = arMod.tryAcquireArchiveReactivationLock(proj, new Date());
  if (!r.acquired) throw new Error("stale lock (>30 min old) must be stealable");
  if (!r.stoleFrom) throw new Error("steal must report stoleFrom for diagnostics");
  if (r.stoleFrom.pid !== 999999) throw new Error("stoleFrom should show the original PID");
  arMod.releaseArchiveReactivationLock(proj);
});

check("R6: same-host dead PID lock is stolen even if timestamp is fresh", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-deadpid-"));
  // Use a PID that almost certainly doesn't exist (max+1) but say it's
  // on OUR host. With timestamp now, only the dead-PID detection can
  // mark it stale.
  const lockFile = arMod.archiveReactivationLockPath(proj);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 2147483646, // near INT_MAX, won't exist
    host: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  const r = arMod.tryAcquireArchiveReactivationLock(proj, new Date());
  if (!r.acquired) {
    throw new Error("same-host dead PID lock must be stealable even with fresh timestamp");
  }
  arMod.releaseArchiveReactivationLock(proj);
});

check("R6: malformed lock file is NOT blindly stolen (fail-closed)", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-malformed-"));
  const lockFile = arMod.archiveReactivationLockPath(proj);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, "this is not json");
  const r = arMod.tryAcquireArchiveReactivationLock(proj, new Date());
  if (r.acquired) {
    throw new Error("malformed lock file must NOT be stealable (we can't prove it's stale)");
  }
});

await checkAsync("R6: runArchiveReactivationIfDue returns skipped:concurrent_run when lock held", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-run-"));
  // Pre-hold the lock with our process pid.
  const now = new Date();
  if (!arMod.tryAcquireArchiveReactivationLock(proj, now).acquired) throw new Error("pre-hold failed");
  try {
    const r = await arMod.runArchiveReactivationIfDue({
      projectRoot: proj,
      archivedEntries: [{
        slug: "x",
        kind: "preference",
        status: "archived",
        confidence: 8,
        scope: "project",
        compiledTruth: "truth",
        frontmatter: { archive_at: new Date().toISOString() },
      }],
      windowText: "user: hi",
      settings: { aggregatorModel: "test/test", aggregatorTimeoutMs: 10_000, aggregatorMaxRetries: 0, autoLlmWriteEnabled: true },
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
      sessionId: "test",
      minIntervalMs: 0,
    });
    if (r.skipped !== "concurrent_run") {
      throw new Error(`expected skipped:concurrent_run; got skipped=${r.skipped} ok=${r.ok}`);
    }
  } finally {
    arMod.releaseArchiveReactivationLock(proj);
  }
});

await checkAsync("R6: concurrent_run skip does NOT advance last_run (debounce unaffected)", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lock-debounce-"));
  if (!arMod.tryAcquireArchiveReactivationLock(proj, new Date()).acquired) throw new Error("pre-hold failed");
  try {
    const lastRunFile = arMod.archiveReactivationLastRunPath(proj);
    // Should not exist before.
    if (fs.existsSync(lastRunFile)) throw new Error("last_run shouldn’t exist before run");
    await arMod.runArchiveReactivationIfDue({
      projectRoot: proj,
      archivedEntries: [{
        slug: "x", kind: "preference", status: "archived", confidence: 8, scope: "project",
        compiledTruth: "truth", frontmatter: { archive_at: new Date().toISOString() },
      }],
      windowText: "x",
      settings: { aggregatorModel: "test/test", aggregatorTimeoutMs: 10_000, aggregatorMaxRetries: 0, autoLlmWriteEnabled: true },
      modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
      sessionId: "test",
      minIntervalMs: 0,
    });
    if (fs.existsSync(lastRunFile)) {
      throw new Error("concurrent_run MUST NOT write last_run (otherwise loser’s debounce window gets consumed)");
    }
  } finally {
    arMod.releaseArchiveReactivationLock(proj);
  }
});

check("R6: source-level — lock acquired AFTER skip-checks (no waste contention)", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  // Lock acquire must come AFTER the model_registry_unavailable check
  // — otherwise we'd hold a lock for runs that immediately bail.
  const acquireIdx = src.search(/tryAcquireArchiveReactivationLock\(options\.projectRoot/);
  const modelCheckIdx = src.search(/skipped:\s*"model_registry_unavailable"/);
  const debouncedCheckIdx = src.search(/skipped:\s*"debounced"/);
  if (acquireIdx < 0) throw new Error("acquire call missing in source");
  if (modelCheckIdx < 0 || debouncedCheckIdx < 0) throw new Error("skip check markers missing");
  if (acquireIdx < modelCheckIdx || acquireIdx < debouncedCheckIdx) {
    throw new Error(
      "acquire must come AFTER debounce and model_registry skip-checks (waste-contention guard)",
    );
  }
});

check("R6: source-level — release is in a finally block (every exit path)", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"), "utf-8");
  // The finally block must mention releaseArchiveReactivationLock.
  if (!/}\s*finally\s*\{[^}]*releaseArchiveReactivationLock\(options\.projectRoot\)/s.test(src)) {
    throw new Error(
      "release call must be in a finally block so every degraded/success/exception path releases the lock",
    );
  }
});

console.log("\nSection: R2 — auditOperation in correct slot (GPT P1, DeepSeek NIT-1)");

check("R2 CRIT-2: auditOperation is in updateProjectEntry OPTIONS, not the patch", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
  const closureIdx = src.search(/reactivateEntry:\s*canMutate/);
  if (closureIdx < 0) throw new Error("could not locate reactivateEntry closure");
  const closureBody = src.slice(closureIdx, closureIdx + 2500);
  // Heuristic: find the updateProjectEntry call, split into draft + opts
  // by counting braces. Simpler: ensure `auditOperation: "archive_reactivation_apply"`
  // appears AFTER `scope,` (which we know is in the opts block).
  const auditIdx = closureBody.search(/auditOperation:\s*"archive_reactivation_apply"/);
  const scopeIdx = closureBody.search(/scope,\s*$/m);
  if (auditIdx < 0) throw new Error("auditOperation = archive_reactivation_apply must be in the source");
  if (scopeIdx < 0) throw new Error("scope, must be in the source (in opts)");
  if (auditIdx < scopeIdx) {
    throw new Error(
      "auditOperation appears BEFORE `scope,` — still in the patch draft. R2 CRIT-2 fix not applied.\n" +
      `auditOperation@${auditIdx} < scope@${scopeIdx}`,
    );
  }
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all archive-reactivation invariants hold`);
