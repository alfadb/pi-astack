#!/usr/bin/env node
/**
 * Smoke: model-curator live re-apply (3-T0 consensus 2026-06-10).
 *
 * Source-level assertions that lock the invariants from the T0 audit:
 *  1. P0 mtime lost-update: mtime snapshot is taken BEFORE resolveConfig()
 *     inside doApplyAllWhitelists, and the watermark is assigned from the
 *     snapshot (not a fresh stat).
 *  2. P0 serialization: concurrent applies coalesce on an in-flight promise.
 *  3. P1 fail-open root-cause: re-applies resolve keep-lists against a cached
 *     builtinCatalog; active providers are NEVER unregister-then-re-registered
 *     (the only unregisterProvider call targets providers REMOVED from settings).
 *  4. Sub-agent guard on the before_agent_start re-apply path.
 *  5. /curator-reload registered with feature detection.
 *  6. Plan A intact: DEFAULTS holds no model strategy data (empty objects),
 *     and buildAvailableModelsBlock has the size===0 no-op guard.
 *  7. Responsibility boundaries stay split: non-GPT hints are judgment-oriented,
 *     GPT hints are execution-oriented but may also be used for judgment-oriented tasks,
 *     including research, discussion, classification, synthesis, decision-making, solution evaluation,
 *     architecture critique, and independent review of completed task results or final diffs;
 *     runtime selection guidance mirrors both phrases without blurring coding, log review, or concrete implementation.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(
  join(root, "extensions/model-curator/index.ts"),
  "utf8",
);
const settings = JSON.parse(readFileSync(
  join(root, "..", "..", "pi-astack-settings.json"),
  "utf8",
));

let failures = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { failures++; console.error(`  ✗ ${msg}`); }
function assert(cond, msg) { (cond ? ok : fail)(msg); }

console.log("model-curator live re-apply smoke:");

// ── 1. mtime snapshot ordering (P0) ─────────────────────────────
{
  const body = src.slice(src.indexOf("async function doApplyAllWhitelists"));
  const iSnap = body.indexOf("const mtimeSnapshot = settingsMtimeMs()");
  const iCfg = body.indexOf("const cfg = resolveConfig()");
  assert(iSnap !== -1, "doApplyAllWhitelists snapshots mtime");
  assert(iCfg !== -1, "doApplyAllWhitelists reads config");
  assert(
    iSnap !== -1 && iCfg !== -1 && iSnap < iCfg,
    "mtime snapshot taken BEFORE resolveConfig (no lost-update)",
  );
  assert(
    /lastAppliedMtimeMs = mtimeSnapshot/.test(body),
    "watermark assigned from pre-apply snapshot, not fresh stat",
  );
}

// ── 2. serialization (P0) ───────────────────────────────────────
assert(
  /let applyInFlight: Promise<void> \| null = null/.test(src),
  "in-flight promise state declared",
);
assert(
  /if \(applyInFlight\) return applyInFlight/.test(src),
  "concurrent applies coalesce on in-flight promise",
);

// ── 3. cached catalog + no unregister-first (P1 root-cause) ─────
assert(
  /builtinCatalog \?\?= reg\.getAll\(\)/.test(src),
  "built-in catalog cached on first apply",
);
{
  // Every unregisterProvider call site must live inside the removed-from-
  // settings branch; there must be no unconditional unregister of active
  // providers before re-applying.
  const calls = [...src.matchAll(/pi\.unregisterProvider\(/g)];
  assert(calls.length === 1, "exactly one unregisterProvider call site");
  const i = src.indexOf("pi.unregisterProvider(");
  const windowBefore = src.slice(Math.max(0, i - 300), i);
  assert(
    /!cfgProviderNames\.has\(name\)/.test(windowBefore),
    "unregister only targets providers removed from settings",
  );
}
assert(
  /previouslyApplied/.test(src) &&
    /appliedProviderNames = \[\.\.\.registered, \.\.\.previouslyApplied\]/.test(src),
  "tracking preserves last-good registrations on kept=0 (auth fail)",
);

// ── 4. sub-agent guard on re-apply path ─────────────────────────
{
  const beforeAgent = src.slice(src.indexOf('pi.on("before_agent_start"'));
  const iGuard = beforeAgent.indexOf("!isSubAgentSession(ctx)");
  const iReapply = beforeAgent.indexOf("applyAllWhitelists");
  assert(iGuard !== -1, "before_agent_start checks isSubAgentSession");
  assert(
    iGuard !== -1 && iReapply !== -1 && iGuard < iReapply,
    "re-apply gated behind sub-agent guard",
  );
  assert(
    /m !== null && m !== lastAppliedMtimeMs/.test(beforeAgent),
    "mtime gate: null-safe inequality check",
  );
}

// ── 5. /curator-reload command ──────────────────────────────────
assert(
  /typeof maybeRegisterCommand === "function"/.test(src),
  "registerCommand feature-detected for older pi",
);
assert(
  /"curator-reload"/.test(src),
  "/curator-reload command registered",
);
assert(
  /ui\?\.notify\?\./.test(src),
  "command handler uses optional chaining for headless ctx",
);

// ── 6. Plan A invariants still hold ─────────────────────────────
{
  const defaults = src.slice(
    src.indexOf("const DEFAULTS: CuratorDefaults"),
    src.indexOf("};", src.indexOf("const DEFAULTS: CuratorDefaults")),
  );
  assert(
    /providers: \{\}/.test(defaults) &&
      /hints: \{\}/.test(defaults) &&
      /imageGen: \{\}/.test(defaults),
    "DEFAULTS holds no model strategy data (single-source in settings.json)",
  );
  assert(
    !/claude-|gpt-|deepseek-|MiniMax|kimi/.test(defaults),
    "no model IDs hardcoded in DEFAULTS",
  );
}
assert(
  /if \(curatedProviders\.size === 0\) return null/.test(src),
  "unconfigured guard: no registry dump into system prompt",
);

const hints = settings.modelCurator?.hints ?? {};
const providers = settings.modelCurator?.providers ?? {};
const expectedHintKeys = new Set(
  Object.entries(providers).flatMap(([provider, models]) =>
    Array.isArray(models) ? models.map((model) => `${provider}/${model}`) : [],
  ),
);
const actualHintKeys = new Set(Object.keys(hints));
assert(
  expectedHintKeys.size > 0 && expectedHintKeys.size === actualHintKeys.size &&
    [...expectedHintKeys].every((key) => actualHintKeys.has(key)) &&
    [...actualHintKeys].every((key) => expectedHintKeys.has(key)),
  "provider/model entries and hint keys stay in exact one-to-one sync",
);
const nonGptHints = Object.entries(hints)
  .filter(([model]) => !model.startsWith("openai/"))
  .map(([, hint]) => hint);
const gptHints = Object.entries(hints)
  .filter(([model]) => model.startsWith("openai/"))
  .map(([, hint]) => hint);
assert(
  nonGptHints.length > 0 && nonGptHints.every((hint) =>
    hint.includes("Use only for judgment-oriented tasks") &&
    hint.includes("do not use for coding, log review, or concrete implementation."),
  ),
  "all non-GPT curated hints limit work to judgment-oriented tasks",
);
const gptJudgmentClause = "GPT models may also be used for judgment-oriented tasks, including research, discussion, classification, synthesis, decision-making, solution evaluation, architecture critique, and independent review of completed task results or final diffs.";
assert(
  gptHints.length > 0 && gptHints.every((hint) =>
    hint.includes("Assign execution-oriented tasks, including coding, log review, and concrete implementation, exclusively to GPT models.") &&
    hint.includes(gptJudgmentClause) &&
    !hint.includes("Use only for"),
  ),
  "all GPT curated hints reserve execution work to GPT without restricting GPT to it",
);
assert(
  src.toLowerCase().includes("assign execution-oriented tasks, including coding, log review, and concrete implementation, exclusively to gpt models") &&
    src.includes(gptJudgmentClause) &&
    src.includes("Use non-GPT curated models only for judgment-oriented tasks, including research, discussion, classification, synthesis, decision-making, solution evaluation, architecture critique, and independent review of completed task results or final diffs; see each model's hint for permitted examples and boundaries;"),
  "runtime selection guidance preserves the execution and judgment boundary",
);

console.log("");
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("all assertions passed");
