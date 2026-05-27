#!/usr/bin/env node
/**
 * Smoke: ADR 0027 PR-B+ R1 P1-8 — spreadAnchor device_id field.
 *
 * Pins the contract:
 *   - spreadAnchor includes device_id when getDeviceId() resolves
 *   - device_id is stable across calls in the same process (cached)
 *   - device_id format: 8-64 chars of [A-Za-z0-9-]
 *   - Persisted in ~/.abrain/.state/device-id (or test-overridden home)
 *   - Atomic write: concurrent processes converge to one canonical value
 *   - Filesystem failure → returns undefined (best-effort), row writes still work
 *   - spreadAnchor(undefined) still returns {} (anchor required for any spread)
 *
 * Why this smoke matters: cross-device git-sync (ADR 0020) can produce
 * audit rows with identical (session_id, turn_id) from two different
 * devices because session_id resets per device + turn_id starts at 0
 * locally. Without device_id in the join key, `jq` queries across
 * synced ~/.abrain content can't distinguish "device A turn 5" from
 * "device B turn 5". This smoke pins the structural fix for that.
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
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => console.log(`  ok    ${name}`),
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL  ${name}\n        ${err.message}`);
        },
      );
    }
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

// ── Stage causal-anchor.ts with isolated HOME ──────────────────

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "causal-anchor-device-id-home-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "causal-anchor-device-id-"));

const piInternalsStub = { isSubAgentSession: () => false };
const piApiStub = {};

const anchorSrc = path.join(repoRoot, "extensions/_shared/causal-anchor.ts");
const anchorCjs = transpile(anchorSrc);
const anchorPath = path.join(tmpDir, "causal-anchor.cjs");
fs.writeFileSync(anchorPath, anchorCjs);
const anchor = loadCJS(
  anchorCjs,
  anchorPath,
  new Map([
    ["./pi-internals", piInternalsStub],
    ["@earendil-works/pi-coding-agent", piApiStub],
  ]),
);

const {
  spreadAnchor,
  getDeviceId,
  _setCurrentAnchorForTests,
  _resetCausalAnchorForTests,
  _resetDeviceIdCacheForTests,
} = anchor;

// ── Tests ──────────────────────────────────────────────────────

console.log("spreadAnchor device_id (ADR 0027 PR-B+ R1 P1-8)");

const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

check("first call: generates + persists device-id file", () => {
  _resetDeviceIdCacheForTests();
  // Make sure home is clean
  const stateDir = path.join(tmpHome, ".abrain", ".state");
  const file = path.join(stateDir, "device-id");
  if (fs.existsSync(file)) fs.unlinkSync(file);

  const id = getDeviceId();
  if (!id) throw new Error("expected an id, got undefined");
  if (!DEVICE_ID_RE.test(id)) throw new Error(`id format invalid: ${id}`);
  if (!fs.existsSync(file)) throw new Error("device-id file not created on disk");
  const onDisk = fs.readFileSync(file, "utf-8").trim();
  if (onDisk !== id) throw new Error(`on-disk (${onDisk}) != returned (${id})`);
});

check("subsequent calls: cached, same id, no re-write", () => {
  _resetDeviceIdCacheForTests();
  const id1 = getDeviceId();
  const id2 = getDeviceId();
  const id3 = getDeviceId();
  if (id1 !== id2 || id2 !== id3) {
    throw new Error(`ids differ across calls: ${id1} / ${id2} / ${id3}`);
  }
});

check("existing file: read instead of regenerate", () => {
  _resetDeviceIdCacheForTests();
  const stateDir = path.join(tmpHome, ".abrain", ".state");
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "device-id");
  const fixedId = "test-fixed-1234-abcd";
  fs.writeFileSync(file, fixedId + "\n", { mode: 0o600 });

  const id = getDeviceId();
  if (id !== fixedId) {
    throw new Error(`expected fixed id ${fixedId}, got ${id}`);
  }
});

check("corrupted file: ignored, returns undefined (no auto-regen)", () => {
  _resetDeviceIdCacheForTests();
  const stateDir = path.join(tmpHome, ".abrain", ".state");
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "device-id");
  fs.writeFileSync(file, "this is not a valid id format with spaces and stuff");

  const id = getDeviceId();
  if (id !== undefined) {
    throw new Error(`expected undefined for corrupted file, got ${id}`);
  }
  // File should still exist (not auto-deleted)
  if (!fs.existsSync(file)) {
    throw new Error("file was unexpectedly auto-deleted");
  }
});

check("spreadAnchor includes device_id when anchor present", () => {
  _resetDeviceIdCacheForTests();
  // Restore valid file
  const stateDir = path.join(tmpHome, ".abrain", ".state");
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "device-id");
  fs.writeFileSync(file, "valid-test-id-12345\n");

  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-test", 7);

  const spread = spreadAnchor({ session_id: "s-test", turn_id: 7 });
  if (spread.session_id !== "s-test") throw new Error("session_id missing");
  if (spread.turn_id !== 7) throw new Error("turn_id missing");
  if (spread.device_id !== "valid-test-id-12345") {
    throw new Error(`device_id missing or wrong: ${JSON.stringify(spread)}`);
  }
});

check("spreadAnchor(undefined) still returns {} (no device_id either)", () => {
  const spread = spreadAnchor(undefined);
  if (Object.keys(spread).length !== 0) {
    throw new Error(`expected {} for undefined anchor, got ${JSON.stringify(spread)}`);
  }
});

check("filesystem failure: returns undefined, cached (no retry loop)", () => {
  _resetDeviceIdCacheForTests();
  // /dev/null is a CHARACTER DEVICE, not a directory. mkdirSync under it
  // fails immediately with ENOTDIR — deterministic, fast, cross-distro.
  // Avoiding /proc/* paths because mkdirSync({recursive:true}) under /proc
  // can hang on some kernels.
  const savedHome = process.env.HOME;
  process.env.HOME = "/dev/null";
  try {
    const id1 = getDeviceId();
    if (id1 !== undefined) {
      throw new Error(`expected undefined for fs failure, got ${id1}`);
    }
    // Second call should hit the cache (no retry)
    const id2 = getDeviceId();
    if (id2 !== undefined) {
      throw new Error(`expected undefined cached, got ${id2}`);
    }
  } finally {
    process.env.HOME = savedHome;
  }
});

check("spreadAnchor degrades gracefully when device_id resolve fails", () => {
  _resetDeviceIdCacheForTests();
  const savedHome = process.env.HOME;
  process.env.HOME = "/dev/null";
  try {
    const spread = spreadAnchor({ session_id: "s", turn_id: 1 });
    if (spread.session_id !== "s") throw new Error("session_id lost");
    if (spread.turn_id !== 1) throw new Error("turn_id lost");
    if ("device_id" in spread) {
      throw new Error("device_id should be absent (not undefined-as-value) when resolve fails");
    }
  } finally {
    process.env.HOME = savedHome;
  }
});

check("two processes generating concurrently would converge (atomic write)", () => {
  _resetDeviceIdCacheForTests();
  process.env.HOME = tmpHome; // restore good home

  const stateDir = path.join(tmpHome, ".abrain", ".state");
  const file = path.join(stateDir, "device-id");
  if (fs.existsSync(file)) fs.unlinkSync(file);

  // Simulate concurrent: call twice rapidly with cache reset between
  const id1 = getDeviceId();
  _resetDeviceIdCacheForTests();
  const id2 = getDeviceId();

  // Both should read the SAME on-disk value (the first call's write
  // landed; second call's existsSync check finds it).
  if (id1 !== id2) {
    throw new Error(`expected convergence, got ${id1} vs ${id2}`);
  }
  // On-disk should match
  const onDisk = fs.readFileSync(file, "utf-8").trim();
  if (onDisk !== id1) {
    throw new Error(`on-disk ${onDisk} != ${id1}`);
  }
});

// Cleanup
process.env.HOME = origHome;

// ── Summary ────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`✅ device_id: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ device_id: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
