#!/usr/bin/env node
/**
 * Smoke: ModelRegistry.refresh() 0.84.x ModelsRefreshResult handling.
 *
 * 0.84.1 refresh resolves { aborted: boolean; errors: ReadonlyMap<string, Error> }
 * instead of void. dispatch and model-curator must NOT silently drop aborted /
 * per-provider errors: warn clearly, then keep using the current catalog. Older
 * hosts that resolve void/undefined are treated as success (no noise).
 *
 * Covers:
 *   1) dispatch.refreshModelRegistry success result — no noise
 *   2) dispatch.refreshModelRegistry old-host void — no noise
 *   3) dispatch.refreshModelRegistry aborted — warns, still resolves
 *   4) dispatch.refreshModelRegistry provider errors — warns per provider
 *   5) dispatch.refreshModelRegistry rejection — rejects, slot cleared → retry
 *   6) dispatch singleflight settled → retry re-runs refresh
 *   7) model-curator factory: ModelsRefreshResult errors warn + catalog still used
 *   8) model-curator factory: aborted warns + catalog still used
 *   9) model-curator factory: old void emits no noise + catalog used
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

const dispatchMod = await jiti.import(
  path.join(repoRoot, "extensions/dispatch/index.ts"),
);
const { refreshModelRegistry } = dispatchMod;

let failures = 0;
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function captureWarnings() {
  const previous = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => { console.warn = previous; },
  };
}

console.log("Smoke: ModelRegistry.refresh 0.84.x ModelsRefreshResult\n");

await checkAsync("dispatch success result { aborted:false, errors:empty } → resolves, no noise", async () => {
  let calls = 0;
  const registry = {
    async refresh() {
      calls++;
      return { aborted: false, errors: new Map() };
    },
  };
  const cap = captureWarnings();
  try {
    const got = await refreshModelRegistry(registry);
    if (got !== registry) throw new Error("refreshModelRegistry must return the registry");
  } finally {
    cap.restore();
  }
  if (calls !== 1) throw new Error(`expected 1 refresh, got ${calls}`);
  if (cap.lines.length !== 0) {
    throw new Error(`success path produced noise: ${cap.lines.join(" | ")}`);
  }
});

await checkAsync("dispatch old-host void → resolves, no noise", async () => {
  let calls = 0;
  const registry = {
    async refresh() { calls++; }, // older hosts resolve undefined
  };
  const cap = captureWarnings();
  try {
    const got = await refreshModelRegistry(registry);
    if (got !== registry) throw new Error("must return the registry");
  } finally {
    cap.restore();
  }
  if (calls !== 1) throw new Error(`expected 1 refresh, got ${calls}`);
  if (cap.lines.length !== 0) throw new Error(`old void produced noise: ${cap.lines.join(" | ")}`);
});

await checkAsync("dispatch aborted result → warns aborted, still resolves", async () => {
  const registry = {
    async refresh() {
      return { aborted: true, errors: new Map() };
    },
  };
  const cap = captureWarnings();
  try {
    await refreshModelRegistry(registry);
  } finally {
    cap.restore();
  }
  if (!cap.lines.some((l) => l.includes("refresh was aborted"))) {
    throw new Error(`aborted warning missing: ${cap.lines.join(" | ")}`);
  }
  if (!cap.lines[0]?.startsWith("pi-astack/dispatch:")) {
    throw new Error(`dispatch warning must carry pi-astack/dispatch: prefix: ${cap.lines.join(" | ")}`);
  }
  if (cap.lines.length !== 1) throw new Error(`expected exactly 1 warning, got ${cap.lines.length}`);
});

await checkAsync("dispatch provider errors result → warns per provider, still resolves", async () => {
  const registry = {
    async refresh() {
      return {
        aborted: false,
        errors: new Map([
          ["anthropic", new Error("anthropic boom")],
          ["openai", new Error("openai boom")],
        ]),
      };
    },
  };
  const cap = captureWarnings();
  try {
    await refreshModelRegistry(registry);
  } finally {
    cap.restore();
  }
  if (!cap.lines.some((l) => l.includes("provider refresh failed (anthropic)") && l.includes("anthropic boom"))) {
    throw new Error(`anthropic provider warning missing: ${cap.lines.join(" | ")}`);
  }
  if (!cap.lines.some((l) => l.includes("provider refresh failed (openai)"))) {
    throw new Error(`openai provider warning missing: ${cap.lines.join(" | ")}`);
  }
  if (cap.lines.some((l) => !l.startsWith("pi-astack/dispatch:"))) {
    throw new Error(`dispatch warnings must carry pi-astack/dispatch: prefix: ${cap.lines.join(" | ")}`);
  }
  if (cap.lines.length !== 2) throw new Error(`expected exactly 2 warnings, got ${cap.lines.length}`);
});

await checkAsync("dispatch rejection → rejects; slot cleared → retry succeeds", async () => {
  let calls = 0;
  let shouldThrow = true;
  const registry = {
    async refresh() {
      calls++;
      if (shouldThrow) throw new Error("refresh-boom");
      return { aborted: false, errors: new Map() };
    },
  };
  let rejected = false;
  try {
    await refreshModelRegistry(registry);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("first refresh rejection must propagate");
  if (calls !== 1) throw new Error(`expected 1 call on failure, got ${calls}`);
  shouldThrow = false;
  const cap = captureWarnings();
  try {
    await refreshModelRegistry(registry); // settled → retry
  } finally {
    cap.restore();
  }
  if (calls !== 2) throw new Error(`expected retry after settle (calls=2), got ${calls}`);
  if (cap.lines.length !== 0) throw new Error(`retry success produced noise: ${cap.lines.join(" | ")}`);
});

await checkAsync("dispatch singleflight: concurrent aborted → 1 refresh, 1 warning, settled → retryable", async () => {
  const calls = [];
  let gate;
  const opened = new Promise((r) => { gate = r; });
  const registry = {
    async refresh() {
      calls.push("start");
      await opened;
      calls.push("end");
      return { aborted: true, errors: new Map() };
    },
  };
  const cap = captureWarnings();
  try {
    const wave = Promise.all([
      refreshModelRegistry(registry),
      refreshModelRegistry(registry),
      refreshModelRegistry(registry),
      refreshModelRegistry(registry),
    ]);
    await new Promise((r) => setImmediate(r));
    if (calls.filter((x) => x === "start").length !== 1) {
      throw new Error(`singleflight expected 1 refresh start, got ${calls.filter((x) => x === "start").length}`);
    }
    gate();
    await wave;
    if (calls.filter((x) => x === "end").length !== 1) {
      throw new Error(`singleflight expected 1 refresh completion, got ${calls.filter((x) => x === "end").length}`);
    }
    if (cap.lines.length !== 1) {
      throw new Error(`aborted singleflight should warn exactly once, got ${cap.lines.length}`);
    }
    // settled → next call re-runs refresh (not coalesced forever)
    const again = await refreshModelRegistry(registry);
    if (again !== registry) throw new Error("must return registry");
    if (calls.filter((x) => x === "start").length !== 2) {
      throw new Error(`expected retry re-run after settle, got ${calls.filter((x) => x === "start").length} starts`);
    }
  } finally {
    cap.restore();
  }
});

await checkAsync("dispatch non-object registry fallback: refresh result still reported (aborted)", async () => {
  // Non-object (primitive) registries bypass the WeakMap singleflight and await
  // refresh directly; their 0.84.x result must still flow into the report helper.
  let calls = 0;
  const previousRefresh = Number.prototype.refresh;
  Number.prototype.refresh = async function () {
    calls++;
    return { aborted: true, errors: new Map() };
  };
  const cap = captureWarnings();
  try {
    const got = await refreshModelRegistry(123);
    if (got !== 123) throw new Error("must return the primitive registry");
  } finally {
    cap.restore();
    if (previousRefresh === undefined) delete Number.prototype.refresh;
    else Number.prototype.refresh = previousRefresh;
  }
  if (calls !== 1) throw new Error(`expected 1 refresh on non-object fallback, got ${calls}`);
  if (cap.lines.length !== 1 || !cap.lines[0].includes("refresh was aborted")) {
    throw new Error(`non-object fallback result not reported: ${cap.lines.join(" | ")}`);
  }
  if (!cap.lines[0].startsWith("pi-astack/dispatch:")) {
    throw new Error(`fallback warning must carry pi-astack/dispatch: prefix: ${cap.lines.join(" | ")}`);
  }
});

await checkAsync("dispatch console.warn monkey-patched to throw → refresh still resolves, no crash", async () => {
  let calls = 0;
  const registry = {
    async refresh() {
      calls++;
      return { aborted: true, errors: new Map([["anthropic", new Error("boom")]]) };
    },
  };
  const previousWarn = console.warn;
  console.warn = () => { throw new Error("monkey-patched console.warn explodes"); };
  try {
    const got = await refreshModelRegistry(registry);
    if (got !== registry) throw new Error("must return registry");
    if (calls !== 1) throw new Error(`expected 1 refresh, got ${calls}`);
  } finally {
    console.warn = previousWarn;
  }
});

// ── model-curator factory (real extension) ─────────────────────
// The curator module reads PI_ASTACK_SETTINGS_PATH at import time, so the env
// must be set before importing (moduleCache:false keeps the fixture isolated).

const savedSettingsPath = process.env.PI_ASTACK_SETTINGS_PATH;
const fixtureSettingsPath = path.join(os.tmpdir(), `pi-curator-refresh-fixture-${Date.now()}.json`);
const DEFAULTS_OVERRIDE = {
  modelCurator: {
    providers: { alpha: ["executor"] },
    hints: { "alpha/executor": "test hint" },
    imageGen: {},
    tiers: {
      test: { label: "test", models: ["alpha/executor"] },
    },
  },
};
fs.writeFileSync(fixtureSettingsPath, JSON.stringify(DEFAULTS_OVERRIDE));
process.env.PI_ASTACK_SETTINGS_PATH = fixtureSettingsPath;

const curatorJiti = createJiti(import.meta.url, { moduleCache: false });
const curatorMod = await curatorJiti.import(
  path.join(repoRoot, "extensions/model-curator/index.ts"),
);
const activateCurator = curatorMod.default;

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

async function curatorApplyWith(refreshImpl) {
  const h = harness();
  const warnings = [];
  const previousWarn = console.warn;
  const previousError = console.error;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  console.error = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await h.handlers.get("session_start")(
      {},
      {
        modelRegistry: {
          refresh: refreshImpl,
          getAll() { return [fixtureModel()]; },
          async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
        },
        sessionManager: {},
        hasUI: false,
      },
    );
  } finally {
    console.warn = previousWarn;
    console.error = previousError;
  }
  return { h, warnings };
}

try {
  await checkAsync("curator: ModelsRefreshResult provider errors → warns + catalog still applied", async () => {
    const { h, warnings } = await curatorApplyWith(async () => ({
      aborted: false,
      errors: new Map([["openai", new Error("upstream 500")]]),
    }));
    if (!warnings.some((l) => l.includes("provider openai refresh failed") && l.includes("upstream 500"))) {
      throw new Error(`provider warning missing: ${warnings.join(" | ")}`);
    }
    if (!h.registrations.some(({ name }) => name === "alpha")) {
      throw new Error("provider error must not block whitelist application");
    }
  });

  await checkAsync("curator: aborted ModelsRefreshResult → warns + catalog still applied", async () => {
    const { h, warnings } = await curatorApplyWith(async () => ({
      aborted: true,
      errors: new Map(),
    }));
    if (!warnings.some((l) => l.includes("refresh aborted"))) {
      throw new Error(`aborted warning missing: ${warnings.join(" | ")}`);
    }
    if (!h.registrations.some(({ name }) => name === "alpha")) {
      throw new Error("aborted refresh must not block whitelist application");
    }
  });

  await checkAsync("curator: old-host void → no noise + catalog applied", async () => {
    const { h, warnings } = await curatorApplyWith(async () => {});
    if (warnings.length !== 0) {
      throw new Error(`old void produced noise: ${warnings.join(" | ")}`);
    }
    if (!h.registrations.some(({ name }) => name === "alpha")) {
      throw new Error("old void refresh must not block whitelist application");
    }
  });

  await checkAsync("curator: success result → no noise + catalog applied", async () => {
    const { h, warnings } = await curatorApplyWith(async () => ({
      aborted: false,
      errors: new Map(),
    }));
    if (warnings.length !== 0) {
      throw new Error(`success produced noise: ${warnings.join(" | ")}`);
    }
    if (!h.registrations.some(({ name }) => name === "alpha")) {
      throw new Error("success refresh must apply the whitelist");
    }
  });

  await checkAsync("curator: console.warn monkey-patched to throw → catalog still applied", async () => {
    const h = harness();
    const previousWarn = console.warn;
    console.warn = () => { throw new Error("monkey-patched console.warn explodes"); };
    try {
      await h.handlers.get("session_start")(
        {},
        {
          modelRegistry: {
            async refresh() {
              return { aborted: true, errors: new Map([["openai", new Error("upstream 500")]]) };
            },
            getAll() { return [fixtureModel()]; },
            async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
          },
          sessionManager: {},
          hasUI: false,
        },
      );
    } finally {
      console.warn = previousWarn;
    }
    if (!h.registrations.some(({ name }) => name === "alpha")) {
      throw new Error("throwing console.warn must not block whitelist application");
    }
  });
} finally {
  if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
  else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
  try { fs.rmSync(fixtureSettingsPath, { force: true }); } catch { /* best effort */ }
}

console.log(`\nfailures: ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
