#!/usr/bin/env node
/**
 * Smoke: model-curator live re-apply (3-T0 consensus 2026-06-10).
 *
 * Source and executable behavior assertions that lock the invariants from the T0 audit:
 *  1. P0 mtime lost-update: mtime snapshot is taken BEFORE resolveConfig()
 *     inside doApplyAllWhitelists, and the watermark is assigned from the
 *     snapshot (not a fresh stat).
 *  2. P0 serialization: concurrent applies coalesce on an in-flight promise.
 *  3. P1 fail-open root-cause: the first catalog snapshot awaits an optional
 *     async registry refresh, then re-applies resolve keep-lists against that
 *     cached builtinCatalog; refresh failure warns and uses the current snapshot.
 *     Active providers are NEVER unregister-then-re-registered (the only
 *     unregisterProvider call targets providers REMOVED from settings).
 *  4. Sub-agent guard on the before_agent_start re-apply path.
 *  5. /curator-reload registered with feature detection.
 *  6. Plan A intact: DEFAULTS holds no model strategy data (empty objects),
 *     and buildAvailableModelsBlock has the size===0 no-op guard.
 *  7. Responsibility permissions are entirely driven by the live curated
 *     per-model hints. Runtime selection guidance must not embed a model-
 *     specific execution exception.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(
  join(root, "extensions/model-curator/index.ts"),
  "utf8",
);
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-astack-model-curator-live-reapply-"));
const fixtureSettingsPath = join(fixtureRoot, "pi-astack-settings.json");
const fixtureSettings = {
  modelCurator: {
    providers: {
      alpha: ["executor"],
      beta: ["reviewer"],
      gamma: ["conditional-executor"],
    },
    hints: {
      "alpha/executor": "Permitted responsibilities: execution and judgment.",
      "beta/reviewer": "Permitted responsibilities: judgment only.",
      "gamma/conditional-executor": "Permitted responsibilities: execution only when isolated and rollbackable.",
    },
    tiers: {
      flagship: { label: "T0", models: ["alpha/executor", "beta/reviewer", "gamma/conditional-executor"] },
      standard: { label: "T1", models: ["alpha/executor"] },
      fast: { label: "T2", models: ["beta/reviewer"] },
    },
  },
};
writeFileSync(fixtureSettingsPath, `${JSON.stringify(fixtureSettings, null, 2)}\n`);
const settings = JSON.parse(readFileSync(fixtureSettingsPath, "utf8"));

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

// ── 3. refreshed cached catalog + no unregister-first (P1) ─────
{
  const body = src.slice(src.indexOf("async function doApplyAllWhitelists"));
  const iRefresh = body.indexOf("await reg.refresh()");
  const iSnapshot = body.indexOf("builtinCatalog = reg.getAll()");
  assert(/refresh\?\(\): Promise<void>/.test(src), "registry refresh contract is optional for older hosts");
  assert(iRefresh !== -1, "first catalog capture awaits registry refresh");
  assert(iSnapshot !== -1, "built-in catalog cached on first apply");
  assert(
    iRefresh !== -1 && iSnapshot !== -1 && iRefresh < iSnapshot,
    "registry refresh settles before the initial getAll snapshot",
  );
  assert(
    /WARN initial registry refresh failed/.test(body) &&
      /continuing with current catalog snapshot/.test(body),
    "initial refresh failure has an explicit fail-open warning",
  );
}
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

// Exercise the real extension factory and session_start handler. This avoids
// duplicating the production cache/refresh implementation in the smoke.
{
  const savedSettingsPath = process.env.PI_ASTACK_SETTINGS_PATH;
  process.env.PI_ASTACK_SETTINGS_PATH = fixtureSettingsPath;
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const curatorModule = await jiti.import(
    join(root, "extensions/model-curator/index.ts"),
  );
  const activateCurator = curatorModule.default;

  function harness() {
    const handlers = new Map();
    const registrations = [];
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      registerProvider(name, config) { registrations.push({ name, config }); },
      unregisterProvider() {},
      registerCommand() {},
    };
    activateCurator(pi);
    return { handlers, registrations };
  }

  function fixtureModel(provider = "alpha", id = "executor") {
    return {
      provider,
      id,
      name: id,
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    };
  }

  assert(typeof activateCurator === "function", "real curator extension factory loads");

  const first = harness();
  const order = [];
  let releaseRefresh;
  let catalog = [];
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const firstRegistry = {
    async refresh() {
      order.push("refresh-start");
      await refreshGate;
      catalog = [
        fixtureModel(),
        fixtureModel("beta", "reviewer"),
        fixtureModel("gamma", "conditional-executor"),
      ];
      order.push("refresh-end");
    },
    getAll() { order.push("getAll"); return catalog; },
    async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
  };
  const firstApply = first.handlers.get("session_start")(
    {},
    { modelRegistry: firstRegistry, sessionManager: {}, hasUI: false },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert(order.join(",") === "refresh-start", "first apply does not read catalog while refresh is pending");
  assert(first.registrations.length === 0, "first apply does not register from a pre-refresh snapshot");
  releaseRefresh();
  await firstApply;
  assert(
    order.join(",") === "refresh-start,refresh-end,getAll",
    "first apply reads catalog only after async refresh settles",
  );
  assert(
    first.registrations.some(({ name }) => name === "alpha"),
    "post-refresh catalog is used by the real whitelist path",
  );

  const fallback = harness();
  const warnings = [];
  let fallbackGetAllCalls = 0;
  const previousConsoleError = console.error;
  console.error = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    await fallback.handlers.get("session_start")(
      {},
      {
        modelRegistry: {
          async refresh() { throw new Error("refresh-boom"); },
          getAll() { fallbackGetAllCalls++; return [fixtureModel()]; },
          async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
        },
        sessionManager: {},
        hasUI: false,
      },
    );
  } finally {
    console.error = previousConsoleError;
    if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
  }
  assert(
    warnings.some((line) => line.includes("WARN initial registry refresh failed") && line.includes("refresh-boom")),
    "refresh rejection emits an explicit warning with the cause",
  );
  assert(fallbackGetAllCalls === 1, "refresh rejection falls back to exactly one current catalog snapshot");
  assert(
    fallback.registrations.some(({ name }) => name === "alpha"),
    "refresh rejection does not disable curator whitelist application",
  );
}

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
const responsibilityHints = Object.values(hints);
assert(
  responsibilityHints.length === 3 && responsibilityHints.every((hint) =>
    typeof hint === "string" && hint.includes("Permitted responsibilities:"),
  ),
  "temporary fixture supplies explicit responsibility permissions for every curated model",
);
assert(
  !src.includes("controlled execution exception") && !src.includes("sole execution exception"),
  "runtime source contains no model-specific execution exception",
);
const responsibilityClause = "for curated models, derive execution and judgment responsibility permissions from the live per-model hint.";
assert(
  src.includes(responsibilityClause) &&
    src.includes("only when that hint explicitly permits them and its stated conditions are met") &&
    src.includes("do not infer permission from a provider or model family"),
  "runtime selection guidance follows live hint permissions without provider/model-family inference",
);

console.log("");
rmSync(fixtureRoot, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("all assertions passed");
