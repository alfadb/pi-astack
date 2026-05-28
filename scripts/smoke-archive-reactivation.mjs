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

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all archive-reactivation invariants hold`);
