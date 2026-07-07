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
const schemaPath = path.join(repoRoot, "pi-astack-settings.schema.json");
const compiled = transpileTsToCjs(settingsSrcPath);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dispatch-settings-"));
const tmpFile = path.join(tmpDir, "settings.cjs");
fs.writeFileSync(tmpFile, compiled);
const { DEFAULT_DISPATCH_SETTINGS, resolveDispatchSettings, readDispatchSettings } = loadModuleFromString(compiled, tmpFile);

console.log("dispatch settings smoke\n");

check("schema defines exactly one top-level dispatch key", () => {
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const matches = schemaText.match(/^\s*"dispatch":\s*\{$/gm) ?? [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one top-level dispatch key, found ${matches.length}`);
  }

  const schema = JSON.parse(schemaText);
  const dispatchProps = schema?.properties?.dispatch?.properties;
  if (!dispatchProps) throw new Error("dispatch.properties missing from parsed schema");
  for (const key of ["maxProviderConcurrency", "taskGovernor", "hub", "idleLoopGuard"]) {
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
  const resolved = resolveDispatchSettings({ dispatch: { maxProviderConcurrency: 7 } });
  if (resolved.maxProviderConcurrency !== 7) {
    throw new Error(`expected 7, got ${resolved.maxProviderConcurrency}`);
  }
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
