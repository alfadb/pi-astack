#!/usr/bin/env node
/**
 * Smoke: dispatch.maxProviderConcurrency settings contract.
 *
 * Verifies three things:
 *   1. The default resolver value is 4.
 *   2. A valid config override is honored.
 *   3. Invalid values and malformed/missing files fall back to 4.
 *
 * The helper is intentionally hot-read on every call so dispatch_parallel can
 * observe settings changes without restarting pi.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const requireFromHere = createRequire(import.meta.url);
const ts = requireFromHere("typescript");

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

function transpileTsToCjs(srcPath) {
  const source = fs.readFileSync(srcPath, "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: srcPath,
  });
  return out.outputText;
}

function loadModuleFromString(code, fakePath) {
  const Module = requireFromHere("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  const baseRequire = m.require.bind(m);
  m.require = (id) => id === "../_shared/rotating-jsonl"
    ? {
        resolveJsonlRotationSettings(raw, defaults) {
          const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
          const bounded = (value, fallback, max) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
          return {
            enabled: typeof rec.enabled === "boolean" ? rec.enabled : defaults.enabled,
            maxBytes: bounded(rec.maxBytes, defaults.maxBytes, 1099511627776),
            maxAgeMs: bounded(rec.maxAgeMs, defaults.maxAgeMs, 31622400000),
            lockTimeoutMs: bounded(rec.lockTimeoutMs, defaults.lockTimeoutMs, 60000),
          };
        },
      }
    : baseRequire(id);
  m._compile(code, fakePath);
  return m.exports;
}

const settingsSrcPath = path.join(repoRoot, "extensions/dispatch/settings.ts");
const governorSrcPath = path.join(repoRoot, "extensions/dispatch/worker-run-governor.ts");
const schemaPath = path.join(repoRoot, "pi-astack-settings.schema.json");
const schemaText = fs.readFileSync(schemaPath, "utf8");
const compiled = transpileTsToCjs(settingsSrcPath);
const compiledGovernor = transpileTsToCjs(governorSrcPath);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dispatch-settings-"));
const tmpFile = path.join(tmpDir, "settings.cjs");
fs.writeFileSync(tmpFile, compiled);
fs.writeFileSync(path.join(tmpDir, "worker-run-governor.js"), compiledGovernor);
const { DEFAULT_DISPATCH_SETTINGS, resolveDispatchSettings, readDispatchSettings } = loadModuleFromString(compiled, tmpFile);

console.log("dispatch settings smoke\n");

check("schema defines exactly one top-level dispatch key", () => {
  const matches = schemaText.match(/^\s*"dispatch":\s*\{$/gm) ?? [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one top-level dispatch key, found ${matches.length}`);
  }

  const schema = JSON.parse(schemaText);
  const dispatchProps = schema?.properties?.dispatch?.properties;
  if (!dispatchProps) throw new Error("dispatch.properties missing from parsed schema");
  for (const key of ["auditRotation", "maxProviderConcurrency", "taskGovernor", "workerRunGovernor", "hub"]) {
    if (!(key in dispatchProps)) {
      throw new Error(`dispatch.properties missing ${key}`);
    }
  }
});

check("default resolver value is 4 with 64 MiB / 7d audit rotation", () => {
  if (DEFAULT_DISPATCH_SETTINGS.maxProviderConcurrency !== 4) {
    throw new Error(`default constant mismatch: ${DEFAULT_DISPATCH_SETTINGS.maxProviderConcurrency}`);
  }
  const resolved = resolveDispatchSettings({});
  if (resolved.maxProviderConcurrency !== 4) {
    throw new Error(`empty settings resolved to ${resolved.maxProviderConcurrency}`);
  }
  const rotation = resolved.auditRotation;
  if (!rotation.enabled || rotation.maxBytes !== 64 * 1024 * 1024 || rotation.maxAgeMs !== 7 * 24 * 60 * 60 * 1000 || rotation.lockTimeoutMs !== 1000) {
    throw new Error(`audit rotation defaults drifted: ${JSON.stringify(rotation)}`);
  }
});

check("valid override is honored", () => {
  const resolved = resolveDispatchSettings({ dispatch: {
    maxProviderConcurrency: 7,
    auditRotation: { enabled: false, maxBytes: 1234, maxAgeMs: 5678, lockTimeoutMs: 99 },
    workerRunGovernor: {
      providerBudgets: {
        providerRetryLimit: 9,
        providerRetryWindowSize: 20,
        providerRetryWindowLimit: 12,
        fullOutputUsageRatio: 0.99,
      },
      visibleText: { abortOnRepeat: false },
    },
  } });
  if (resolved.maxProviderConcurrency !== 7) {
    throw new Error(`expected 7, got ${resolved.maxProviderConcurrency}`);
  }
  if (JSON.stringify(resolved.auditRotation) !== JSON.stringify({ enabled: false, maxBytes: 1234, maxAgeMs: 5678, lockTimeoutMs: 99 })) {
    throw new Error(`audit rotation override not honored: ${JSON.stringify(resolved.auditRotation)}`);
  }
  if (
    resolved.workerRunGovernor.providerBudgets.providerRetryLimit !== 9 ||
    resolved.workerRunGovernor.providerBudgets.providerRetryWindowSize !== 20 ||
    resolved.workerRunGovernor.providerBudgets.providerRetryWindowLimit !== 12 ||
    resolved.workerRunGovernor.providerBudgets.fullOutputUsageRatio !== 0.99
  ) {
    throw new Error(`workerRunGovernor provider override not honored: ${JSON.stringify(resolved.workerRunGovernor)}`);
  }
  if (resolved.workerRunGovernor.visibleText.abortOnRepeat !== false) {
    throw new Error("workerRunGovernor visibleText override not honored");
  }
});

check("taskGovernor exposes only three non-terminal thresholds and ignores legacy hard input", () => {
  const schema = JSON.parse(schemaText);
  const taskGovernorSchema = schema.properties.dispatch.properties.taskGovernor;
  const limitsSchema = schema.definitions.dispatchTaskGovernorLimits;
  if ("hard" in limitsSchema.properties) throw new Error("active task-governor schema still exposes hard");
  if (JSON.stringify(Object.keys(limitsSchema.properties).sort()) !== JSON.stringify(["auditPause", "checkpoint", "freshAuth"])) {
    throw new Error(`unexpected task-governor thresholds: ${JSON.stringify(limitsSchema.properties)}`);
  }
  for (const [profile, limits] of Object.entries(taskGovernorSchema.properties.profiles.default)) {
    if ("hard" in limits || typeof limits.freshAuth !== "number") {
      throw new Error(`profile ${profile} does not use the three-stage audit contract: ${JSON.stringify(limits)}`);
    }
  }
  const resolved = resolveDispatchSettings({ dispatch: { taskGovernor: { profiles: {
    read_only: { checkpoint: 11, auditPause: 22, freshAuth: 33, hard: 1 },
  } } } });
  if (JSON.stringify(resolved.taskGovernor.profiles.read_only) !== JSON.stringify({ checkpoint: 11, auditPause: 22, freshAuth: 33 })) {
    throw new Error(`legacy hard affected runtime resolution: ${JSON.stringify(resolved.taskGovernor.profiles.read_only)}`);
  }
});

check("workerRunGovernor defaults are enabled and bounded", () => {
  const cfg = resolveDispatchSettings({}).workerRunGovernor;
  if (!cfg.enabled || !cfg.visibleText.enabled || !cfg.visibleText.abortOnRepeat || !cfg.providerBudgets.enabled || !cfg.toolObservers.enabled) {
    throw new Error(`expected enabled defaults: ${JSON.stringify(cfg)}`);
  }
  if (
    cfg.providerBudgets.providerRetryLimit !== 7 ||
    cfg.providerBudgets.providerRetryWindowSize !== 14 ||
    cfg.providerBudgets.providerRetryWindowLimit !== 10 ||
    cfg.providerBudgets.emptyVisibleRetryLimit !== 2 ||
    cfg.providerBudgets.fullOutputCapLimit !== 2
  ) {
    throw new Error(`narrow budget defaults drifted: ${JSON.stringify(cfg.providerBudgets)}`);
  }
});

check("invalid retry-window values and combinations fall back without affecting other valid settings", () => {
  const invalidSize = resolveDispatchSettings({ dispatch: { workerRunGovernor: { providerBudgets: {
    providerRetryLimit: 9, providerRetryWindowSize: 0, providerRetryWindowLimit: 8, fullOutputUsageRatio: 0.99,
  } } } }).workerRunGovernor.providerBudgets;
  if (invalidSize.providerRetryWindowSize !== 14 || invalidSize.providerRetryWindowLimit !== 8 || invalidSize.providerRetryLimit !== 9 || invalidSize.fullOutputUsageRatio !== 0.99) {
    throw new Error(`invalid size fallback polluted valid settings: ${JSON.stringify(invalidSize)}`);
  }

  const invalidLimit = resolveDispatchSettings({ dispatch: { workerRunGovernor: { providerBudgets: {
    providerRetryLimit: 9, providerRetryWindowSize: 5, providerRetryWindowLimit: 0, fullOutputUsageRatio: 0.99,
  } } } }).workerRunGovernor.providerBudgets;
  if (invalidLimit.providerRetryWindowSize !== 5 || invalidLimit.providerRetryWindowLimit !== 4 || invalidLimit.providerRetryLimit !== 9 || invalidLimit.fullOutputUsageRatio !== 0.99) {
    throw new Error(`invalid limit fallback did not preserve valid size and unrelated settings: ${JSON.stringify(invalidLimit)}`);
  }

  const invalidCombination = resolveDispatchSettings({ dispatch: { workerRunGovernor: { providerBudgets: {
    providerRetryLimit: 9, providerRetryWindowSize: 8, providerRetryWindowLimit: 8, fullOutputUsageRatio: 0.99,
  } } } }).workerRunGovernor.providerBudgets;
  if (invalidCombination.providerRetryWindowSize !== 14 || invalidCombination.providerRetryWindowLimit !== 10 || invalidCombination.providerRetryLimit !== 9 || invalidCombination.fullOutputUsageRatio !== 0.99) {
    throw new Error(`invalid combination fallback polluted valid settings: ${JSON.stringify(invalidCombination)}`);
  }
});

check("retry-window runtime bounds match schema bounds and always preserve limit < size", () => {
  const schemaProvider = JSON.parse(schemaText).properties.dispatch.properties.workerRunGovernor.properties.providerBudgets.properties;
  const sizeSchema = schemaProvider.providerRetryWindowSize;
  const limitSchema = schemaProvider.providerRetryWindowLimit;
  if (sizeSchema.minimum !== 2 || sizeSchema.maximum !== 10000 || limitSchema.minimum !== 1 || limitSchema.maximum !== 9999) {
    throw new Error(`unexpected schema bounds: ${JSON.stringify({ sizeSchema, limitSchema })}`);
  }

  const resolveWindow = (providerBudgets) => resolveDispatchSettings({
    dispatch: { workerRunGovernor: { providerBudgets } },
  }).workerRunGovernor.providerBudgets;
  for (const [size, limit] of [[2, 1], [10000, 9999]]) {
    const resolved = resolveWindow({ providerRetryWindowSize: size, providerRetryWindowLimit: limit });
    if (resolved.providerRetryWindowSize !== size || resolved.providerRetryWindowLimit !== limit) {
      throw new Error(`valid boundary pair was not preserved: ${JSON.stringify({ size, limit, resolved })}`);
    }
  }

  const boundaryCases = [
    { providerRetryWindowSize: 1, providerRetryWindowLimit: 1 },
    { providerRetryWindowSize: 10001, providerRetryWindowLimit: 1 },
    { providerRetryWindowSize: 2, providerRetryWindowLimit: 0 },
    { providerRetryWindowSize: 10000, providerRetryWindowLimit: 10000 },
    { providerRetryWindowSize: 0, providerRetryWindowLimit: 14 },
  ];
  for (const input of boundaryCases) {
    const resolved = resolveWindow(input);
    const { providerRetryWindowSize: size, providerRetryWindowLimit: limit } = resolved;
    if (!(Number.isInteger(size) && Number.isInteger(limit) && size >= 2 && size <= 10000 && limit >= 1 && limit <= 9999 && limit < size)) {
      throw new Error(`runtime emitted an invalid retry window: ${JSON.stringify({ input, resolved })}`);
    }
  }
});

check("nested invalid workerRunGovernor values fall back independently", () => {
  const cfg = resolveDispatchSettings({ dispatch: { workerRunGovernor: {
    enabled: "yes",
    visibleText: { enabled: 1, abortOnRepeat: null },
    providerBudgets: {
      enabled: [], providerRetryLimit: 0, providerRetryWindowSize: 0,
      providerRetryWindowLimit: 10001, emptyVisibleRetryLimit: 2.5,
      fullOutputCapLimit: 10001, fullOutputUsageRatio: 0.49,
    },
    toolObservers: {
      enabled: "true",
      sameFileSmallReadChurn: {
        enabled: {}, observeAfter: -1, maxWindowLines: 0,
        overlapRatio: 1.01, maxTrackedPaths: 10001,
      },
      schemaErrorStorm: { enabled: "false", observeAfter: NaN, maxTrackedShapes: 0 },
    },
  } } }).workerRunGovernor;
  if (JSON.stringify(cfg) !== JSON.stringify(DEFAULT_DISPATCH_SETTINGS.workerRunGovernor)) {
    throw new Error(`nested invalid values did not fall back: ${JSON.stringify(cfg)}`);
  }
});

check("auditRotation and workerRunGovernor schema validate nested bounds and reject unknown fields", () => {
  const dispatchSchema = JSON.parse(schemaText).properties.dispatch.properties;
  const rotation = dispatchSchema.auditRotation;
  if (rotation.type !== "object" || rotation.additionalProperties !== false) throw new Error("auditRotation schema must be strict");
  if (rotation.properties.maxBytes.minimum !== 1 || rotation.properties.maxBytes.maximum !== 1099511627776) throw new Error("auditRotation maxBytes bounds drifted");
  if (rotation.properties.maxAgeMs.minimum !== 1 || rotation.properties.maxAgeMs.maximum !== 31622400000) throw new Error("auditRotation maxAgeMs bounds drifted");
  if (rotation.properties.lockTimeoutMs.minimum !== 1 || rotation.properties.lockTimeoutMs.maximum !== 60000) throw new Error("auditRotation lockTimeoutMs bounds drifted");
  const schema = dispatchSchema.workerRunGovernor;
  const provider = schema.properties.providerBudgets;
  const readChurn = schema.properties.toolObservers.properties.sameFileSmallReadChurn;
  const schemaStorm = schema.properties.toolObservers.properties.schemaErrorStorm;
  for (const node of [schema, schema.properties.visibleText, provider, schema.properties.toolObservers, readChurn, schemaStorm]) {
    if (node.type !== "object" || node.additionalProperties !== false) throw new Error(`nested object is not strict: ${JSON.stringify(node)}`);
  }
  if (provider.properties.fullOutputUsageRatio.minimum !== 0.5 || provider.properties.fullOutputUsageRatio.maximum !== 1) throw new Error("usage ratio schema bounds drifted");
  if (provider.properties.providerRetryLimit.default !== 7) throw new Error("provider retry limit schema default drifted");
  for (const key of ["providerRetryLimit", "emptyVisibleRetryLimit", "fullOutputCapLimit"]) {
    const node = provider.properties[key];
    if (node.type !== "integer" || node.minimum !== 1 || node.maximum !== 10000) throw new Error(`invalid provider budget schema: ${key}`);
  }
  if (provider.properties.providerRetryWindowSize.minimum !== 2 || provider.properties.providerRetryWindowSize.maximum !== 10000 || provider.properties.providerRetryWindowSize.default !== 14) throw new Error("retry window size schema bounds drifted");
  if (provider.properties.providerRetryWindowLimit.minimum !== 1 || provider.properties.providerRetryWindowLimit.maximum !== 9999 || provider.properties.providerRetryWindowLimit.default !== 10) throw new Error("retry window limit schema bounds drifted");
  if (!provider.description.includes("1 <= limit < providerRetryWindowSize")) throw new Error("retry window relational constraint missing from schema description");
  if (readChurn.properties.overlapRatio.minimum !== 0.5 || readChurn.properties.overlapRatio.maximum !== 1) throw new Error("overlap ratio schema bounds drifted");
});

check("invalid values fall back to default", () => {
  for (const value of [0, -1, 2.5, 17, "8", null, undefined, {}, []]) {
    const resolved = resolveDispatchSettings({ dispatch: { maxProviderConcurrency: value } });
    if (resolved.maxProviderConcurrency !== 4) {
      throw new Error(`value ${JSON.stringify(value)} resolved to ${resolved.maxProviderConcurrency}, expected 4`);
    }
  }
  const invalidRotation = resolveDispatchSettings({ dispatch: { auditRotation: {
    enabled: "true", maxBytes: 0, maxAgeMs: Infinity, lockTimeoutMs: 60001,
  } } }).auditRotation;
  if (JSON.stringify(invalidRotation) !== JSON.stringify(DEFAULT_DISPATCH_SETTINGS.auditRotation)) {
    throw new Error(`invalid audit rotation did not strictly fall back: ${JSON.stringify(invalidRotation)}`);
  }
});

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dispatch-home-"));
const tempAgentDir = path.join(tempHome, ".pi", "agent");
fs.mkdirSync(tempAgentDir, { recursive: true });
const settingsPath = path.join(tempAgentDir, "pi-astack-settings.json");
const prevHome = process.env.HOME;
const prevUserprofile = process.env.USERPROFILE;

try {
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  check("readDispatchSettings defaults when file is missing", () => {
    fs.rmSync(settingsPath, { force: true });
    const resolved = readDispatchSettings();
    if (resolved.maxProviderConcurrency !== 4) {
      throw new Error(`missing file resolved to ${resolved.maxProviderConcurrency}`);
    }
  });

  check("readDispatchSettings hot-reads file changes", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ dispatch: { maxProviderConcurrency: 2 } }));
    let resolved = readDispatchSettings();
    if (resolved.maxProviderConcurrency !== 2) {
      throw new Error(`first read resolved to ${resolved.maxProviderConcurrency}`);
    }

    fs.writeFileSync(settingsPath, JSON.stringify({ dispatch: { maxProviderConcurrency: 6 } }));
    resolved = readDispatchSettings();
    if (resolved.maxProviderConcurrency !== 6) {
      throw new Error(`second read resolved to ${resolved.maxProviderConcurrency}`);
    }
  });

  check("readDispatchSettings falls back on malformed JSON", () => {
    fs.writeFileSync(settingsPath, "{");
    const resolved = readDispatchSettings();
    if (resolved.maxProviderConcurrency !== 4) {
      throw new Error(`malformed JSON resolved to ${resolved.maxProviderConcurrency}`);
    }
  });
} finally {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserprofile;
}

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
