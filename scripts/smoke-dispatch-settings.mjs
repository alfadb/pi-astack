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
  for (const key of ["maxProviderConcurrency", "taskGovernor", "workerRunGovernor", "hub"]) {
    if (!(key in dispatchProps)) {
      throw new Error(`dispatch.properties missing ${key}`);
    }
  }
});

check("default resolver value is 4", () => {
  if (DEFAULT_DISPATCH_SETTINGS.maxProviderConcurrency !== 4) {
    throw new Error(`default constant mismatch: ${DEFAULT_DISPATCH_SETTINGS.maxProviderConcurrency}`);
  }
  const resolved = resolveDispatchSettings({});
  if (resolved.maxProviderConcurrency !== 4) {
    throw new Error(`empty settings resolved to ${resolved.maxProviderConcurrency}`);
  }
});

check("valid override is honored", () => {
  const resolved = resolveDispatchSettings({ dispatch: {
    maxProviderConcurrency: 7,
    workerRunGovernor: {
      providerBudgets: { providerRetryLimit: 9, fullOutputUsageRatio: 0.99 },
      visibleText: { abortOnRepeat: false },
    },
  } });
  if (resolved.maxProviderConcurrency !== 7) {
    throw new Error(`expected 7, got ${resolved.maxProviderConcurrency}`);
  }
  if (resolved.workerRunGovernor.providerBudgets.providerRetryLimit !== 9 || resolved.workerRunGovernor.providerBudgets.fullOutputUsageRatio !== 0.99) {
    throw new Error(`workerRunGovernor provider override not honored: ${JSON.stringify(resolved.workerRunGovernor)}`);
  }
  if (resolved.workerRunGovernor.visibleText.abortOnRepeat !== false) {
    throw new Error("workerRunGovernor visibleText override not honored");
  }
});

check("workerRunGovernor defaults are enabled and bounded", () => {
  const cfg = resolveDispatchSettings({}).workerRunGovernor;
  if (!cfg.enabled || !cfg.visibleText.enabled || !cfg.visibleText.abortOnRepeat || !cfg.providerBudgets.enabled || !cfg.toolObservers.enabled) {
    throw new Error(`expected enabled defaults: ${JSON.stringify(cfg)}`);
  }
  if (cfg.providerBudgets.providerRetryLimit !== 4 || cfg.providerBudgets.emptyVisibleRetryLimit !== 2 || cfg.providerBudgets.fullOutputCapLimit !== 2) {
    throw new Error(`narrow budget defaults drifted: ${JSON.stringify(cfg.providerBudgets)}`);
  }
});

check("nested invalid workerRunGovernor values fall back independently", () => {
  const cfg = resolveDispatchSettings({ dispatch: { workerRunGovernor: {
    enabled: "yes",
    visibleText: { enabled: 1, abortOnRepeat: null },
    providerBudgets: {
      enabled: [], providerRetryLimit: 0, emptyVisibleRetryLimit: 2.5,
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

check("workerRunGovernor schema validates nested bounds and rejects unknown fields", () => {
  const schema = JSON.parse(schemaText).properties.dispatch.properties.workerRunGovernor;
  const provider = schema.properties.providerBudgets;
  const readChurn = schema.properties.toolObservers.properties.sameFileSmallReadChurn;
  const schemaStorm = schema.properties.toolObservers.properties.schemaErrorStorm;
  for (const node of [schema, schema.properties.visibleText, provider, schema.properties.toolObservers, readChurn, schemaStorm]) {
    if (node.type !== "object" || node.additionalProperties !== false) throw new Error(`nested object is not strict: ${JSON.stringify(node)}`);
  }
  if (provider.properties.fullOutputUsageRatio.minimum !== 0.5 || provider.properties.fullOutputUsageRatio.maximum !== 1) throw new Error("usage ratio schema bounds drifted");
  for (const key of ["providerRetryLimit", "emptyVisibleRetryLimit", "fullOutputCapLimit"]) {
    const node = provider.properties[key];
    if (node.type !== "integer" || node.minimum !== 1 || node.maximum !== 10000) throw new Error(`invalid provider budget schema: ${key}`);
  }
  if (readChurn.properties.overlapRatio.minimum !== 0.5 || readChurn.properties.overlapRatio.maximum !== 1) throw new Error("overlap ratio schema bounds drifted");
});

check("invalid values fall back to default", () => {
  for (const value of [0, -1, 2.5, 17, "8", null, undefined, {}, []]) {
    const resolved = resolveDispatchSettings({ dispatch: { maxProviderConcurrency: value } });
    if (resolved.maxProviderConcurrency !== 4) {
      throw new Error(`value ${JSON.stringify(value)} resolved to ${resolved.maxProviderConcurrency}, expected 4`);
    }
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
