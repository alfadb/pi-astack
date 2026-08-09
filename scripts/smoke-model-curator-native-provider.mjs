#!/usr/bin/env node
/**
 * Smoke: model-curator whitelist via NATIVE provider wrapper.
 *
 * Independent review found applyWhitelist cast nullable auth.headers (0.84.x
 * ProviderHeaders with null delete markers) into config-form ProviderConfigInput
 * and fed it to pi.registerProvider(name, config) — the 0.84.x composer cannot
 * consume null (auth resolution crashes). This smoke locks the replacement:
 *
 *   Part A (facade harness over the real extension factory):
 *   1. native provider path (reg.getProvider present) → pi.registerProvider is
 *      called with the OBJECT overload; only the whitelist models remain; the
 *      original provider headers' null marker is preserved; methods are bound to
 *      the original provider; the config composer is never fed.
 *   2. old facade WITHOUT getProvider + no null markers → legacy config-form
 *      fallback still registers.
 *   3. old facade WITHOUT getProvider + null markers → FAIL CLOSED (no
 *      registration) with a clear missing reason — never silently filters markers.
 *
 *   Part B (real external 0.84.1 host):
 *   4. composer 反例: config-form registerProvider with a null header marker
 *      crashes auth resolution — proving null must not enter the config composer.
 *   5. wrapper 正例: registerNativeProvider(object overload) keeps the null
 *      marker on the provider, keeps getModels to the whitelist, and auth still
 *      resolves — proving the native wrapper path avoids the composer entirely.
 *   6. real host loadExtensions over all 25 extension index.ts → 0 errors.
 */

import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveExternalHostCodingAgent,
} from "./_resolve-host-pi.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

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

// ── fixture settings ──────────────────────────────────────────────
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-native-"));
const fixtureSettingsPath = path.join(fixtureRoot, "pi-astack-settings.json");
const fixtureSettings = {
  modelCurator: {
    providers: { alpha: ["executor"] },
    hints: { "alpha/executor": "Permitted responsibilities: execution and judgment." },
    imageGen: {},
    tiers: { flagship: { label: "T0", models: ["alpha/executor"] } },
  },
};
fs.writeFileSync(fixtureSettingsPath, JSON.stringify(fixtureSettings));
const savedSettingsPath = process.env.PI_ASTACK_SETTINGS_PATH;
process.env.PI_ASTACK_SETTINGS_PATH = fixtureSettingsPath;

const curatorModule = await jiti.import(
  path.join(repoRoot, "extensions/model-curator/index.ts"),
);
const activateCurator = curatorModule.default;

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

// pi stub that records whether registerProvider was called with the string
// (config form → feeds the composer) or object (native provider) overload.
function harness() {
  const handlers = new Map();
  const registrations = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerProvider(a, b) {
      registrations.push(
        typeof a === "string"
          ? { kind: "config", name: a, config: b }
          : { kind: "object", provider: a },
      );
    },
    unregisterProvider() {},
    registerCommand() {},
  };
  activateCurator(pi);
  return { handlers, registrations };
}

// A native Provider-like object whose methods close over `this` so we can
// assert the wrapper binds them to the original provider.
function nativeProvider(provider = "alpha", modelIds = ["executor", "reviewer"], opts = {}) {
  const models = modelIds.map((id) => fixtureModel(provider, id));
  return {
    id: provider,
    name: opts.name ?? provider,
    baseUrl: opts.baseUrl ?? "https://example.invalid/v1",
    headers: opts.headers,
    auth: opts.auth ?? {
      apiKey: {
        name: "API key",
        resolve: async () => ({ auth: { apiKey: "native-key" }, source: "test" }),
      },
    },
    getModels: () => models,
    stream: function () { return { boundTo: this?.id ?? "unbound" }; },
    streamSimple: function () { return { boundTo: this?.id ?? "unbound" }; },
    refreshModels: async function () { return { boundTo: this?.id ?? "unbound" }; },
    filterModels: function (ms) { return ms; },
    fetchDeferred: function () { return { boundTo: this?.id ?? "unbound" }; },
    cancelDeferred: async function () {},
  };
}

async function runSessionStart(h, modelRegistry) {
  await h.handlers.get("session_start")(
    {},
    { modelRegistry, sessionManager: {}, hasUI: false },
  );
}

console.log("Smoke: model-curator native provider wrapper path\n");

// ── Part A.1: native path ─────────────────────────────────────────
await checkAsync("native path: object overload used, whitelist only, null marker preserved, composer never fed", async () => {
  const h = harness();
  const native = nativeProvider("alpha", ["executor", "reviewer"], {
    headers: { "X-Delete": null, "X-Keep": "keep-value" },
  });
  await runSessionStart(h, {
    getAll() { return [fixtureModel("alpha", "executor"), fixtureModel("alpha", "reviewer")]; },
    getProvider(name) {
      if (name !== "alpha") return undefined;
      return native;
    },
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "fixture-key", headers: { "X-Origin": "orig" } };
    },
  });

  const objects = h.registrations.filter((r) => r.kind === "object");
  const configs = h.registrations.filter((r) => r.kind === "config");
  if (objects.length !== 1) {
    throw new Error(`expected exactly 1 object overload registration, got ${h.registrations.length}: ${JSON.stringify(h.registrations.map((r) => r.kind))}`);
  }
  if (configs.length !== 0) {
    throw new Error("config composer must NOT be fed on the native path");
  }
  const wrapper = objects[0].provider;
  const ids = wrapper.getModels().map((m) => m.id);
  if (ids.length !== 1 || ids[0] !== "executor") {
    throw new Error(`whitelist not retained: getModels()=${JSON.stringify(ids)}`);
  }
  if (wrapper.headers?.["X-Delete"] !== null) {
    throw new Error(`null delete marker lost: ${JSON.stringify(wrapper.headers)}`);
  }
  if (wrapper.headers?.["X-Keep"] !== "keep-value") {
    throw new Error(`string header dropped: ${JSON.stringify(wrapper.headers)}`);
  }
  if (wrapper.id !== "alpha" || wrapper.baseUrl !== "https://example.invalid/v1") {
    throw new Error(`provider identity lost: ${JSON.stringify({ id: wrapper.id, baseUrl: wrapper.baseUrl })}`);
  }
  if (wrapper.auth !== native.auth) {
    throw new Error("native auth must be preserved by reference");
  }
  // Methods that may depend on `this` must be bound to the original provider.
  if (wrapper.stream().boundTo !== "alpha") {
    throw new Error(`stream not bound to original provider: ${JSON.stringify(wrapper.stream())}`);
  }
  if (wrapper.streamSimple().boundTo !== "alpha") {
    throw new Error(`streamSimple not bound to original provider`);
  }
  if (typeof wrapper.refreshModels !== "function") {
    throw new Error("refreshModels capability must be preserved on the wrapper");
  }
  if (typeof wrapper.filterModels !== "function") {
    throw new Error("filterModels capability must be preserved on the wrapper");
  }
  if (typeof wrapper.fetchDeferred !== "function" || typeof wrapper.cancelDeferred !== "function") {
    throw new Error("deferred capabilities must be preserved on the wrapper");
  }
});

// ── Part A.1b: absent optional capabilities are NOT advertised ─────
await checkAsync("native path: absent optional methods are not present as explicit-undefined keys", async () => {
  const h = harness();
  const bare = nativeProvider("alpha", ["executor"], { headers: { "X-Keep": "keep-value" } });
  // Strip the optional capabilities to simulate a minimal provider.
  delete bare.refreshModels;
  delete bare.filterModels;
  delete bare.fetchDeferred;
  delete bare.cancelDeferred;
  await runSessionStart(h, {
    getAll() { return [fixtureModel("alpha", "executor")]; },
    getProvider(name) { return name === "alpha" ? bare : undefined; },
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "fixture-key" };
    },
  });
  const objects = h.registrations.filter((r) => r.kind === "object");
  if (objects.length !== 1) {
    throw new Error(`expected 1 object overload registration, got ${objects.length}`);
  }
  const wrapper = objects[0].provider;
  for (const method of ["refreshModels", "filterModels", "fetchDeferred", "cancelDeferred"]) {
    if (method in wrapper) {
      throw new Error(`absent optional capability advertised as present key: ${method}`);
    }
  }
  if (typeof wrapper.stream !== "function" || typeof wrapper.streamSimple !== "function") {
    throw new Error("required stream/streamSimple must stay on the wrapper");
  }
  if (wrapper.headers?.["X-Keep"] !== "keep-value") {
    throw new Error(`headers lost: ${JSON.stringify(wrapper.headers)}`);
  }
});

// ── Part A.2: old facade, no null → config-form fallback ──────────
await checkAsync("old facade (no getProvider) + no null headers → config-form fallback registers", async () => {
  const h = harness();
  await runSessionStart(h, {
    getAll() { return [fixtureModel("alpha", "executor"), fixtureModel("alpha", "reviewer")]; },
    async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
  });
  const configs = h.registrations.filter((r) => r.kind === "config");
  if (configs.length !== 1 || configs[0].name !== "alpha") {
    throw new Error(`config-form fallback not used: ${JSON.stringify(h.registrations.map((r) => r.kind))}`);
  }
  if (!Array.isArray(configs[0].config?.models) || configs[0].config.models.length !== 1) {
    throw new Error(`fallback config models wrong: ${JSON.stringify(configs[0].config?.models)}`);
  }
  if (h.registrations.some((r) => r.kind === "object")) {
    throw new Error("object overload must not be used on a facade without getProvider");
  }
});

// ── Part A.3: old facade, null marker → fail closed ───────────────
await checkAsync("old facade (no getProvider) + null markers → FAIL CLOSED, never silently filtered", async () => {
  const h = harness();
  const stderr = [];
  const previousError = console.error;
  console.error = (...args) => stderr.push(args.map(String).join(" "));
  try {
    await runSessionStart(h, {
      getAll() { return [fixtureModel("alpha", "executor")]; },
      async getApiKeyAndHeaders() {
        // apiKey present → auth readiness passes, but the null marker cannot be
        // represented by the legacy config-form composer → must fail closed.
        return { ok: true, apiKey: "fixture-key", headers: { "X-Delete": null } };
      },
    });
  } finally {
    console.error = previousError;
  }
  if (h.registrations.length !== 0) {
    throw new Error(`must NOT register on null-marker facade: ${JSON.stringify(h.registrations.map((r) => r.kind))}`);
  }
  if (!stderr.some((l) => l.includes("null delete markers"))) {
    throw new Error(`clear missing reason missing: ${stderr.join(" | ")}`);
  }
});

// ── Part B: real external 0.84.1 host ─────────────────────────────
const externalHost = resolveExternalHostCodingAgent(repoRoot);
const hostRoot = externalHost.external && externalHost.root ? externalHost.root : null;
if (!hostRoot) {
  console.log("  note  TEST-ONLY skip of real-host composer checks (no external 0.84.1 host resolved)");
} else {
  console.log(`  note  real host via ${externalHost.source}: ${hostRoot}`);
  await checkAsync("composer 反例: config-form null header marker breaks auth resolution", async () => {
    const Pi = await import(pathToFileURL(path.join(hostRoot, "dist/index.js")).href);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-host-"));
    let runtime;
    try {
      runtime = await Pi.ModelRuntime.create({
        modelsPath: null,
        allowModelNetwork: false,
        authPath: path.join(agentDir, "auth.json"),
      });
      runtime.registerProvider("alpha", {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        apiKey: "k",
        headers: { "X-Delete": null },
        models: [{
          id: "executor", name: "executor", api: "openai-completions",
          baseUrl: "https://example.invalid/v1", reasoning: false,
          input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000, maxTokens: 100,
        }],
      });
      let threw = false;
      try {
        await runtime.getAuth("alpha");
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error("config-form with a null header marker must crash auth resolution on 0.84.1");
      }
    } finally {
      try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  await checkAsync("wrapper 正例: native provider object keeps null marker + whitelist + working auth", async () => {
    const Pi = await import(pathToFileURL(path.join(hostRoot, "dist/index.js")).href);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-curator-host-"));
    let runtime;
    try {
      runtime = await Pi.ModelRuntime.create({
        modelsPath: null,
        allowModelNetwork: false,
        authPath: path.join(agentDir, "auth.json"),
      });
      const modelDef = {
        id: "executor", name: "executor", api: "openai-completions",
        baseUrl: "https://example.invalid/v1", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000, maxTokens: 100,
      };
      const wrapper = {
        id: "beta", name: "beta", baseUrl: "https://example.invalid/v1",
        headers: { "X-Delete": null, "X-Keep": "keep-value" },
        auth: {
          apiKey: {
            name: "API key",
            resolve: async () => ({ auth: { apiKey: "wrapped-key" }, source: "test" }),
          },
        },
        getModels: () => [{ ...modelDef, provider: "beta" }],
        stream() { throw new Error("not used"); },
        streamSimple() { throw new Error("not used"); },
      };
      runtime.registerNativeProvider(wrapper);
      const p = runtime.getProvider("beta");
      if (!p) throw new Error("native provider not registered");
      if (p.headers?.["X-Delete"] !== null || p.headers?.["X-Keep"] !== "keep-value") {
        throw new Error(`null marker lost through native registration: ${JSON.stringify(p.headers)}`);
      }
      const ids = p.getModels().map((m) => m.id);
      if (ids.length !== 1 || ids[0] !== "executor") {
        throw new Error(`whitelist not retained on real host: ${JSON.stringify(ids)}`);
      }
      const auth = await runtime.getAuth("beta");
      const key = auth?.auth?.apiKey ?? auth?.apiKey;
      if (key !== "wrapped-key") {
        throw new Error(`native wrapper auth broken: ${JSON.stringify(key)}`);
      }
    } finally {
      try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  await checkAsync("real 0.84.1 loader: 25 extensions, 0 errors", async () => {
    const hostLoaderEntry = path.join(hostRoot, "dist", "core", "extensions", "loader.js");
    if (!fs.existsSync(hostLoaderEntry)) {
      throw new Error(`host extension loader missing: ${hostLoaderEntry}`);
    }
    const hostMod = await import(pathToFileURL(hostLoaderEntry).href);
    if (typeof hostMod.loadExtensions !== "function") {
      throw new Error("host loader does not export loadExtensions");
    }
    // The loader must see the REAL pi-astack-settings.json (extensions like
    // abrain fail closed on missing canonicalGitRuntime) — restore the original
    // settings path for this check.
    if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
    try {
      const dirs = fs.readdirSync(path.join(repoRoot, "extensions"))
        .filter((d) => d !== "_shared" && fs.existsSync(path.join(repoRoot, "extensions", d, "index.ts")));
      const extPaths = dirs.map((d) => path.join(repoRoot, "extensions", d, "index.ts"));
      if (extPaths.length !== 25) {
        throw new Error(`expected 25 extension index.ts, found ${extPaths.length}`);
      }
      const result = await hostMod.loadExtensions(extPaths, repoRoot);
      const errors = result?.errors ?? [];
      if (errors.length !== 0) {
        throw new Error(`host loadExtensions returned ${errors.length} error(s): ` +
          errors.map((e) => `${e.path}: ${e.error}`).join(" | "));
      }
      if (!Array.isArray(result?.extensions) || result.extensions.length !== 25) {
        throw new Error(`expected 25 extensions loaded, got ${JSON.stringify(result?.extensions?.length)}`);
      }
      console.log(`  note  host loadExtensions: ${result.extensions.length} extensions, 0 errors`);
    } finally {
      process.env.PI_ASTACK_SETTINGS_PATH = fixtureSettingsPath;
    }
  });
}

if (savedSettingsPath === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
else process.env.PI_ASTACK_SETTINGS_PATH = savedSettingsPath;
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(`\nfailures: ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
