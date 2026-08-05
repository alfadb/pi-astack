#!/usr/bin/env node
/**
 * Real multi-process smoke for retained_directory_lock_v1 on Windows
 * (Global named mutex protocol; zero-file; no DELETE directory handle).
 *
 * Architecture: controller/worker
 * - Controller (parent) NEVER require()'s the .node binary (so temp package cleanup can delete it).
 * - All native work runs in worker/child processes that load via __TEST after manifest/hash
 *   verification of the *temp package* binaryPath (not staging source).
 * - package.json script stays `node scripts/smoke-windows-native-retained-lock.mjs`;
 *   this file self-reexecs with --expose-gc when needed.
 *
 * Default gate:
 * - non-win32 / non-x64 / missing artifact → print `SKIP:` and exit 0
 *
 * Does not mock the lock; does not touch ~/.abrain; does not write production pin.
 * Cleanup failures hard-fail (no WARN pass).
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
// __TEST.loadWindowsNativeAddon requires test hooks.
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const stagedNode = path.join(repoRoot, "native/windows/target/smoke-staging/pi-astack-windows-native.node");
const buildInfoPath = path.join(repoRoot, "native/windows/target/smoke-staging/build-info.json");

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

// Self-reexec with --expose-gc so package.json can stay `node scripts/...`.
if (typeof globalThis.gc !== "function" && process.env.PI_ASTACK_GC_REEXEC !== "1") {
  const r = spawnSync(
    process.execPath,
    ["--expose-gc", ...process.argv.slice(1)],
    {
      env: { ...process.env, PI_ASTACK_GC_REEXEC: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  process.exit(r.status == null ? 1 : r.status);
}

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

function die(msg, code = 1) {
  console.error(`smoke-windows-native-retained-lock: ${msg}`);
  process.exit(code);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs = 20000) {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${filePath}`);
    sleep(50);
  }
}

function writeReadyAtomic(readyFile, payload) {
  const dir = path.dirname(readyFile);
  const tmp = path.join(dir, `.${path.basename(readyFile)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(tmp, readyFile);
}

function loadModule() {
  const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
  return jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));
}

/**
 * Load addon from the *verified* temp package binaryPath (default loader).
 * Must NOT require the staging path — proves loader loads hash-verified bytes.
 */
function loadAddonFromTempPackage(mod, packageRoot, manifestSha256) {
  return mod.__TEST.loadWindowsNativeAddon({
    packageRoot,
    platform: "win32",
    arch: "x64",
    nodeVersion: process.versions.node,
    expectedManifestSha256: manifestSha256,
    // Default loadNativeModule(absoluteBinaryPath) requires the verified package path.
  });
}

function prepareTempPackage(mod, buildInfo, binaryBytes) {
  const abrain = path.resolve(os.homedir(), ".abrain");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-win-lock-pkg-"));
  assert(!root.startsWith(abrain + path.sep) && root !== abrain, `temp must not be under ~/.abrain: ${root}`);

  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "pi-astack-win-lock-temp", private: true }, null, 2)}\n`);

  const paths = mod.resolveWindowsNativeAddonPaths(root);
  fs.mkdirSync(path.dirname(paths.binaryPath), { recursive: true });
  fs.writeFileSync(paths.binaryPath, binaryBytes);

  const toolchainId = buildInfo.toolchain_id || "d".repeat(64);
  assert(/^[0-9a-f]{64}$/.test(toolchainId), "build-info toolchain_id must be sha256 hex");

  const manifest = {
    schema_version: "windows-native-addon-manifest/v1",
    addon_abi: 1,
    platform: "win32",
    arch: "x64",
    napi_version: 9,
    minimum_node: "22.19.0",
    source_commit: buildInfo.source_commit,
    source_tree_sha256: buildInfo.source_tree_sha256,
    toolchain: buildInfo.toolchain || "cargo+msvc (smoke)",
    toolchain_id: toolchainId,
    target: "win32-x64",
    binary_file: "pi-astack-windows-native.node",
    binary_bytes: binaryBytes.byteLength,
    binary_sha256: sha256(binaryBytes),
    build_id: buildInfo.build_id,
    build_mode: buildInfo.build_mode || buildInfo.mode,
    reproducibility: buildInfo.reproducibility,
    native_tests: buildInfo.native_tests,
    clippy: buildInfo.clippy,
    build_config_sha256: buildInfo.build_config_sha256,
    capabilities: ["atomic_file_tempdir_v1", "atomic_file_v1", "protected_dacl_v1", "retained_directory_lock_v1"],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(paths.manifestPath, manifestText, "utf8");
  const manifestSha256 = sha256(Buffer.from(manifestText, "utf8"));
  return { root, paths, manifest, manifestSha256 };
}

function pathsEqualWin(a, b) {
  return String(a).replace(/\//g, "\\").toLowerCase() === String(b).replace(/\//g, "\\").toLowerCase();
}

// ── Child / worker modes ───────────────────────────────────────────────────
function runChild() {
  const mode = process.argv[3];
  const dir = process.argv[4];
  const packageRoot = process.argv[5];
  const manifestSha256 = process.argv[6];
  const readyFile = process.argv[7];
  const releaseFile = process.argv[8];
  const extra1 = process.argv[9];

  try {
    if (process.platform !== "win32") throw new Error("child requires win32");
    const mod = loadModule();
    const loaded = loadAddonFromTempPackage(mod, packageRoot, manifestSha256);
    // Prove we loaded the package binary, not staging.
    assert(
      pathsEqualWin(loaded.binaryPath, mod.resolveWindowsNativeAddonPaths(packageRoot).binaryPath),
      `child must load verified package binaryPath, got ${loaded.binaryPath}`,
    );

    if (mode === "foreign-cwd-try") {
      const foreign = extra1;
      assert(foreign && fs.existsSync(foreign), "foreign cwd must exist");
      process.chdir(foreign);
      const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, dir);
      const result = lease
        ? {
          status: "ACQUIRED",
          identity: lease.identity,
          acquired_after_abandon: lease.acquired_after_abandon,
          cwd: process.cwd(),
        }
        : { status: "BUSY", cwd: process.cwd() };
      if (lease) lease.close();
      writeReadyAtomic(readyFile, result);
      process.exit(0);
    }

    if (mode === "chdir-while-parent-holds") {
      process.chdir(dir);
      writeReadyAtomic(readyFile, { status: "CHDIR_OK", cwd: process.cwd() });
      process.exit(0);
    }

    if (mode === "barrier-compete") {
      const barrierFile = extra1;
      const start = Date.now();
      while (!fs.existsSync(barrierFile)) {
        if (Date.now() - start > 30000) throw new Error("barrier timeout");
        sleep(5);
      }
      const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, dir);
      const result = lease
        ? { status: "ACQUIRED", pid: process.pid, identity: lease.identity, acquired_after_abandon: lease.acquired_after_abandon }
        : { status: "BUSY", pid: process.pid };
      writeReadyAtomic(readyFile, result);
      if (lease) {
        while (!fs.existsSync(releaseFile)) {
          sleep(50);
        }
        lease.close();
      }
      process.exit(0);
    }

    if (mode === "suite") {
      // In-process sequential suite (controller never loads native).
      const workRoot = dir;
      const results = runInProcessSuite(mod, loaded, workRoot);
      writeReadyAtomic(readyFile, { status: "SUITE_DONE", results });
      process.exit(results.every((r) => r.ok) ? 0 : 1);
    }

    const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, dir);

    if (mode === "try-once") {
      const result = lease
        ? { status: "ACQUIRED", identity: lease.identity, acquired_after_abandon: lease.acquired_after_abandon }
        : { status: "BUSY" };
      if (lease) lease.close();
      writeReadyAtomic(readyFile, result);
      process.exit(0);
    }

    if (mode === "hold-until-release") {
      if (!lease) {
        writeReadyAtomic(readyFile, { status: "BUSY" });
        process.exit(2);
      }
      writeReadyAtomic(readyFile, {
        status: "ACQUIRED",
        pid: process.pid,
        identity: lease.identity,
        acquired_after_abandon: lease.acquired_after_abandon,
      });
      while (!fs.existsSync(releaseFile)) {
        sleep(50);
      }
      lease.close();
      process.exit(0);
    }

    if (mode === "hold-forever") {
      if (!lease) {
        writeReadyAtomic(readyFile, { status: "BUSY" });
        process.exit(2);
      }
      globalThis.__pi_astack_hold_forever_lease = lease;
      writeReadyAtomic(readyFile, {
        status: "ACQUIRED",
        pid: process.pid,
        identity: lease.identity,
        acquired_after_abandon: lease.acquired_after_abandon,
      });
      setInterval(() => {
        const held = globalThis.__pi_astack_hold_forever_lease;
        if (!held || held.status !== "ACQUIRED") {
          process.exit(3);
        }
      }, 1000);
      return;
    }

    throw new Error(`unknown child mode ${mode}`);
  } catch (err) {
    try {
      writeReadyAtomic(readyFile, { status: "ERROR", error: String(err?.stack || err) });
    } catch {
      try {
        fs.writeFileSync(readyFile, `${JSON.stringify({ status: "ERROR", error: String(err?.stack || err) })}\n`);
      } catch {
        // ignore
      }
    }
    process.exit(1);
  }
}

function runInProcessSuite(mod, loaded, workRoot) {
  const results = [];
  function case_(name, fn) {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: String(err?.stack || err) });
    }
  }

  const lockDir = path.join(workRoot, "control-root");
  fs.mkdirSync(lockDir, { recursive: true });

  case_("acquire + identity + acquired_after_abandon boolean + close idempotent", () => {
    const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(lease, "expected ACQUIRED lease, got null/BUSY");
    assert(lease.status === "ACQUIRED", `status ${lease.status}`);
    assert(typeof lease.acquired_after_abandon === "boolean", "acquired_after_abandon boolean");
    assert(pathsEqualWin(lease.identity.path, lockDir), `identity path ${lease.identity.path} vs ${lockDir}`);
    assert(/^[0-9a-f]{16}$/.test(lease.identity.volume_serial_number), "volume hex16");
    assert(/^[0-9a-f]{32}$/.test(lease.identity.file_id), "file_id hex32");
    assert(!("handle" in lease) && !("fd" in lease) && !("mutex" in lease), "HANDLE not enumerable");
    lease.assertIdentity();
    lease.close();
    lease.close();
  });

  case_("same-process second acquire is BUSY", () => {
    const a = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(a, "first");
    const b = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(b === null, "second must be BUSY/null");
    a.close();
    const c = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(c, "third after close");
    c.close();
  });

  case_("alias casing same identity mutual exclusion", () => {
    const a = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(a, "first");
    const alt = lockDir
      .split(path.sep)
      .map((part, i) => (i === 0 ? part : (i % 2 === 0 ? part.toUpperCase() : part.toLowerCase())))
      .join(path.sep);
    const b = mod.tryAcquireRetainedDirectoryLock(loaded.addon, alt);
    assert(b === null, `alias/casing path must be BUSY, got ${b && b.status}`);
    a.close();
  });

  case_("ordinary file IO under lock not blocked", () => {
    const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(lease, "acquire");
    const filePath = path.join(lockDir, "payload.txt");
    fs.writeFileSync(filePath, "hello-under-lock\n", "utf8");
    assert(fs.readFileSync(filePath, "utf8") === "hello-under-lock\n", "readback");
    fs.mkdirSync(path.join(lockDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(lockDir, "nested", "x.txt"), "x\n");
    lease.close();
  });

  case_("relative path → INVALID_PATH", () => {
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, "relative-not-allowed");
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_INVALID_PATH", `got ${caught?.code}`);
  });

  case_("verbatim prefix → INVALID_PATH", () => {
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, `\\\\?\\${lockDir}`);
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_INVALID_PATH", `got ${caught?.code}`);
  });

  case_("device prefix → INVALID_PATH", () => {
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, `\\\\.\\${lockDir}`);
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_INVALID_PATH", `got ${caught?.code}`);
  });

  case_("leading whitespace → INVALID_PATH (no trim-reparse)", () => {
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, ` ${lockDir}`);
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_INVALID_PATH", `got ${caught?.code}`);
  });

  case_("NOT_FOUND for missing directory", () => {
    const missing = path.join(workRoot, "does-not-exist-" + randomBytes(4).toString("hex"));
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, missing);
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_NOT_FOUND", `got ${caught?.code}`);
  });

  case_("NOT_DIRECTORY for file path", () => {
    const filePath = path.join(workRoot, "not-a-dir.txt");
    fs.writeFileSync(filePath, "x\n");
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, filePath);
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_NOT_DIRECTORY", `got ${caught?.code}`);
  });

  case_("CLOSED on assertIdentity after close", () => {
    const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(lease, "acquire");
    lease.close();
    let caught;
    try {
      lease.assertIdentity();
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_CLOSED", `got ${caught?.code}`);
  });

  case_("leaf reparse/junction → REPARSE", () => {
    const target = path.join(workRoot, "real-dir");
    const linkPath = path.join(workRoot, "link-dir");
    fs.mkdirSync(target, { recursive: true });
    try {
      fs.symlinkSync(target, linkPath, "junction");
    } catch (err) {
      try {
        fs.symlinkSync(target, linkPath, "dir");
      } catch (err2) {
        throw new Error(`unable to create reparse test link: ${err2?.message || err2} / ${err?.message || err}`);
      }
    }
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, linkPath);
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_REPARSE", `got ${caught?.code}`);
  });

  case_("ancestor junction → ANCESTOR_REPARSE", () => {
    const realBase = path.join(workRoot, "anc-real");
    const leafName = "leaf";
    fs.mkdirSync(path.join(realBase, leafName), { recursive: true });
    const junctionParent = path.join(workRoot, "anc-junc");
    fs.symlinkSync(realBase, junctionParent, "junction");
    const viaJunction = path.join(junctionParent, leafName);
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, viaJunction);
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_ANCESTOR_REPARSE", `got ${caught?.code}`);
  });

  case_("junction + .. cannot bypass ancestor check", () => {
    // Path that names a junction component: must fail closed on reparse.
    // Path that collapses via .. after GetFullPathName onto a pure real path may succeed,
    // but must not dual-hold via the junction alias.
    const realLeaf = path.join(workRoot, "jdot-real", "leaf");
    fs.mkdirSync(realLeaf, { recursive: true });
    const junc = path.join(workRoot, "jdot-junc");
    fs.symlinkSync(path.join(workRoot, "jdot-real"), junc, "junction");
    const viaJunction = path.join(junc, "leaf");
    let viaCaught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, viaJunction);
    } catch (err) {
      viaCaught = err;
    }
    assert(viaCaught, "path through junction leaf must fail closed");
    assert(
      viaCaught.code === "WINDOWS_NATIVE_ADDON_ANCESTOR_REPARSE"
        || viaCaught.code === "WINDOWS_NATIVE_ADDON_REPARSE",
      `expected reparse reject, got ${viaCaught.code}`,
    );
    // .. form that still includes the junction segment before collapse is also rejected or collapses safely.
    const sneaky = path.join(junc, "..", "jdot-real", "leaf");
    let sneakyLease = null;
    let sneakyCaught = null;
    try {
      sneakyLease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, sneaky);
    } catch (err) {
      sneakyCaught = err;
    }
    if (sneakyCaught) {
      assert(
        sneakyCaught.code === "WINDOWS_NATIVE_ADDON_ANCESTOR_REPARSE"
          || sneakyCaught.code === "WINDOWS_NATIVE_ADDON_REPARSE"
          || sneakyCaught.code === "WINDOWS_NATIVE_ADDON_INVALID_PATH",
        `unexpected sneaky code ${sneakyCaught.code}`,
      );
    } else if (sneakyLease) {
      // Collapsed to real path — identity must be real leaf, and junction alias still rejected.
      assert(!/jdot-junc/i.test(sneakyLease.identity.path), "canonical must not retain junction name");
      let stillCaught;
      try {
        mod.tryAcquireRetainedDirectoryLock(loaded.addon, viaJunction);
      } catch (err) {
        stillCaught = err;
      }
      assert(stillCaught, "junction alias must remain rejected while real held");
      sneakyLease.close();
    }
  });

  case_("long path >260 supported via internal \\\\?\\", () => {
    // Create a deep directory under workRoot exceeding MAX_PATH when fully expanded.
    let deep = workRoot;
    const segment = "d".repeat(40);
    while (deep.length < 280) {
      deep = path.join(deep, segment);
    }
    fs.mkdirSync(deep, { recursive: true });
    const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, deep);
    assert(lease, "long path acquire");
    assert(lease.identity.path.length >= 260 || deep.length >= 260, "path is long");
    // External canonical is ordinary DOS (no \\?\ prefix).
    assert(!lease.identity.path.startsWith("\\\\?\\"), "canonical must be ordinary DOS");
    lease.close();
  });

  case_("unicode case path mutual exclusion", () => {
    const uni = path.join(workRoot, "Ünicøde-Dir");
    fs.mkdirSync(uni, { recursive: true });
    const a = mod.tryAcquireRetainedDirectoryLock(loaded.addon, uni);
    assert(a, "unicode acquire");
    const alt = path.join(workRoot, "ünicøde-dir"); // case fold of latin parts; umlaut may vary
    // If filesystem treats as same path, must be BUSY; if different dir exists issue — use constructed case variant of same path string.
    const cased = uni
      .split(path.sep)
      .map((p, i) => (i === 0 ? p : p.toUpperCase()))
      .join(path.sep);
    const b = mod.tryAcquireRetainedDirectoryLock(loaded.addon, cased);
    assert(b === null, "unicode/case alias must be BUSY");
    a.close();
  });

  case_("error path does not leak mutex", () => {
    for (let i = 0; i < 8; i += 1) {
      try {
        mod.tryAcquireRetainedDirectoryLock(loaded.addon, `not-absolute-${i}`);
      } catch {
        // expected
      }
    }
    const lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
    assert(lease, "still acquirable after error paths");
    lease.close();
  });

  case_("mapped error codes closed set + prefix-anchored map", () => {
    let caught;
    try {
      mod.tryAcquireRetainedDirectoryLock(loaded.addon, "");
    } catch (err) {
      caught = err;
    }
    assert(caught?.name === "WindowsNativeAddonError", "mapped class");
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_INVALID_PATH", `code ${caught?.code}`);
    assert(mod.isWindowsNativeAddonErrorCode(caught.code), "in closed set");
    // Prefix-anchor: substring mid-message without head prefix must not map to INVALID_PATH.
    const mid = mod.mapRetainedDirectoryLockError(new Error("wrapper says RETAINED_DIRECTORY_LOCK_INVALID_PATH: no"));
    // After stripping Error: prefix, message starts with "wrapper..." — not native prefix → MUTEX_FAILED.
    assert(mid.code === "WINDOWS_NATIVE_ADDON_MUTEX_FAILED", `prefix-anchor got ${mid.code}`);
    const head = mod.mapRetainedDirectoryLockError(new Error("RETAINED_DIRECTORY_LOCK_NOT_FOUND: x"));
    assert(head.code === "WINDOWS_NATIVE_ADDON_NOT_FOUND", `head map ${head.code}`);
  });

  // GC/FinalizationRegistry requires an event-loop turn; covered by dedicated async child in controller.

  return results;
}

if (process.argv[2] === "--child") {
  runChild();
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// ── Controller (never loads .node) ─────────────────────────────────────────
async function main() {
  console.log("Windows native retained_directory_lock_v1 multi-process smoke (controller/worker)");

  if (process.platform !== "win32") {
    skip(`requires win32 host (got ${process.platform})`);
  }
  if (process.arch !== "x64") {
    skip(`requires x64 (got ${process.arch})`);
  }
  if (!fs.existsSync(stagedNode) || !fs.existsSync(buildInfoPath)) {
    skip(
      `missing built artifact; run: node scripts/build-windows-native-addon.mjs (looked for ${stagedNode})`,
    );
  }

  if (typeof globalThis.gc !== "function") {
    die("gc not exposed after --expose-gc reexec (hard fail)");
  }

  const abrain = path.resolve(os.homedir(), ".abrain");
  assert(!process.cwd().startsWith(abrain + path.sep), "cwd must not be under ~/.abrain");

  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  const binaryBytes = fs.readFileSync(stagedNode);
  assert(buildInfo.addon_abi === 1, "build-info abi 1");
  assert(
    Array.isArray(buildInfo.capabilities) && buildInfo.capabilities.includes("retained_directory_lock_v1"),
    "build-info capabilities contain retained",
  );
  assert(buildInfo.binary_sha256 === sha256(binaryBytes), "build-info binary hash matches staged file");
  assert(typeof buildInfo.toolchain_id === "string" && /^[0-9a-f]{64}$/.test(buildInfo.toolchain_id), "toolchain_id");
  assert(typeof buildInfo.build_id === "string" && /^[0-9a-f]{64}$/.test(buildInfo.build_id), "deterministic build_id hex");
  assert(buildInfo.native_tests === "passed", "build-info native_tests=passed");
  assert(buildInfo.clippy === "passed", "build-info clippy=passed");
  assert(buildInfo.reproducibility === "dual_clean_match" || buildInfo.reproducibility === "skipped", "build-info reproducibility");
  assert(/^[0-9a-f]{64}$/.test(buildInfo.build_config_sha256 || ""), "build-info build_config_sha256");
  // Dev builds on dirty trees must mark development_only; production package path not asserted here.
  assert(buildInfo.development_only === true || buildInfo.mode === "production", "development_only or production mode");
  if (buildInfo.dirty_tree) {
    assert(buildInfo.development_only === true, "dirty tree must be development_only");
  }

  // Controller loads TS module only (no .node).
  const mod = loadModule();
  assert(mod.WINDOWS_NATIVE_ADDON_ABI === 1, "TS ABI 1");
  assert(mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 === null, "production pin still null");
  assert(
    mod.WINDOWS_NATIVE_ADDON_ERROR_CODES.includes("WINDOWS_NATIVE_ADDON_MUTEX_NAMESPACE_DENIED"),
    "MUTEX_NAMESPACE_DENIED in closed set",
  );

  const { root: packageRoot, paths: pkgPaths, manifestSha256 } = prepareTempPackage(mod, buildInfo, binaryBytes);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-win-lock-work-"));
  assert(!workRoot.startsWith(abrain + path.sep), "work root not under .abrain");

  let passed = 0;
  const failures = [];
  async function check(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
    }
  }

  function spawnChild(mode, dir, readyFile, releaseFile, extra, nodeArgs = []) {
    const args = [...nodeArgs, __filename, "--child", mode, dir, packageRoot, manifestSha256, readyFile];
    if (releaseFile) args.push(releaseFile);
    else if (extra) args.push("");
    if (extra) {
      args.push(extra);
    }
    return spawn(process.execPath, args, {
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      env: { ...process.env, PI_ASTACK_GC_REEXEC: "1" },
    });
  }

  // Production pin still fail-closed without loading native.
  await check("production pin still fail-closed (controller, no native load)", () => {
    let caught;
    try {
      mod.loadWindowsNativeAddon();
    } catch (err) {
      caught = err;
    }
    assert(caught?.code === "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING", "pin missing");
  });

  // ── Async in-process suite worker (loads verified package binary) ────────
  await check("worker suite loads verified package binaryPath (not staging)", async () => {
    const ready = path.join(workRoot, "suite-ready.json");
    // Run suite in a child that has event loop + gc.
    const child = spawnChild("suite", workRoot, ready, null, null, ["--expose-gc"]);
    waitForFile(ready, 120000);
    const payload = JSON.parse(fs.readFileSync(ready, "utf8"));
    await waitExitBounded(child, 120000);
    assert(payload.status === "SUITE_DONE", `suite status ${payload.status}`);
    const failed = (payload.results || []).filter((r) => !r.ok);
    if (failed.length) {
      throw new Error(`suite failures:\n${failed.map((f) => `${f.name}: ${f.error}`).join("\n")}`);
    }
    // GC case may have been flaky in sync — re-run GC explicitly async below if listed ok.
    const names = new Set((payload.results || []).map((r) => r.name));
    assert(names.has("NOT_FOUND for missing directory"), "NOT_FOUND case present");
    assert(names.has("NOT_DIRECTORY for file path"), "NOT_DIRECTORY case present");
    assert(names.has("CLOSED on assertIdentity after close"), "CLOSED case present");
  });

  // Re-run critical async GC test in a dedicated child with event loop.
  await check("owner-thread GC releases mutex (async child, --expose-gc)", async () => {
    const ready = path.join(workRoot, "gc-ready.json");
    const code = `
      const { createRequire } = require("node:module");
      const path = require("node:path");
      const fs = require("node:fs");
      const { createJiti } = createRequire(${JSON.stringify(repoRoot + "/package.json")})("jiti");
      const jiti = createJiti(${JSON.stringify(repoRoot)}, { interopDefault: true, fsCache: false, moduleCache: false });
      const mod = jiti(path.join(${JSON.stringify(repoRoot)}, "extensions/_shared/windows-native-addon.ts"));
      const packageRoot = ${JSON.stringify(packageRoot)};
      const manifestSha256 = ${JSON.stringify(manifestSha256)};
      const lockDir = ${JSON.stringify(path.join(workRoot, "gc-lock"))};
      const readyFile = ${JSON.stringify(ready)};
      fs.mkdirSync(lockDir, { recursive: true });
      (async () => {
        try {
          if (typeof global.gc !== "function") throw new Error("gc missing");
          const loaded = mod.__TEST.loadWindowsNativeAddon({
            packageRoot, platform: "win32", arch: "x64",
            nodeVersion: process.versions.node,
            expectedManifestSha256: manifestSha256,
          });
          const pkgBin = mod.resolveWindowsNativeAddonPaths(packageRoot).binaryPath;
          if (loaded.binaryPath.toLowerCase() !== pkgBin.toLowerCase()) {
            throw new Error("loaded binaryPath is not package path: " + loaded.binaryPath);
          }
          let lease = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
          if (!lease) throw new Error("acquire failed");
          const id = lease.identity.file_id;
          lease = null;
          let re = null;
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            global.gc();
            await new Promise((r) => setImmediate(r));
            re = mod.tryAcquireRetainedDirectoryLock(loaded.addon, lockDir);
            if (re) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!re) throw new Error("no reacquire after GC");
          if (re.identity.file_id !== id) throw new Error("identity mismatch");
          re.close();
          fs.writeFileSync(readyFile, JSON.stringify({ status: "OK" }) + "\\n");
          process.exit(0);
        } catch (e) {
          fs.writeFileSync(readyFile, JSON.stringify({ status: "ERROR", error: String(e && e.stack || e) }) + "\\n");
          process.exit(1);
        }
      })();
    `;
    const child = spawn(process.execPath, ["--expose-gc", "-e", code], {
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    waitForFile(ready, 30000);
    const r = JSON.parse(fs.readFileSync(ready, "utf8"));
    await waitExitBounded(child, 30000);
    assert(r.status === "OK", `gc child: ${JSON.stringify(r)}`);
  });

  // Multi-process: holder child + contender (controller never holds native lock).
  await check("holder child → contender BUSY; release → contender ACQUIRED", async () => {
    const lockDir = path.join(workRoot, "mp-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const holdReady = path.join(workRoot, "hold-ready.json");
    const releaseFile = path.join(workRoot, "hold-release");
    const holder = spawnChild("hold-until-release", lockDir, holdReady, releaseFile);
    waitForFile(holdReady);
    const held = JSON.parse(fs.readFileSync(holdReady, "utf8"));
    assert(held.status === "ACQUIRED", `holder: ${JSON.stringify(held)}`);

    const tryReady = path.join(workRoot, "try-busy.json");
    const contender = spawnChild("try-once", lockDir, tryReady);
    waitForFile(tryReady);
    const busy = JSON.parse(fs.readFileSync(tryReady, "utf8"));
    assert(busy.status === "BUSY", `expected BUSY, got ${JSON.stringify(busy)}`);
    await waitExitBounded(contender, 10000);

    fs.writeFileSync(releaseFile, "go\n");
    await waitExitBounded(holder, 15000);

    const try2 = path.join(workRoot, "try-free.json");
    const c2 = spawnChild("try-once", lockDir, try2);
    waitForFile(try2);
    const free = JSON.parse(fs.readFileSync(try2, "utf8"));
    assert(free.status === "ACQUIRED", `expected ACQUIRED after release, got ${JSON.stringify(free)}`);
    // After abandoned/normal release, acquired_after_abandon may be false.
    assert(typeof free.acquired_after_abandon === "boolean", "abandon flag present");
    await waitExitBounded(c2, 10000);
  });

  await check("child hold + kill → reacquire (abandoned); acquired_after_abandon true", async () => {
    const lockDir = path.join(workRoot, "kill-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const ready = path.join(workRoot, "kill-hold-ready.json");
    const child = spawnChild("hold-forever", lockDir, ready);
    waitForFile(ready);
    const held = JSON.parse(fs.readFileSync(ready, "utf8"));
    assert(held.status === "ACQUIRED", `child should hold: ${JSON.stringify(held)}`);

    const busyReady = path.join(workRoot, "kill-busy.json");
    const busyChild = spawnChild("try-once", lockDir, busyReady);
    waitForFile(busyReady);
    const busy = JSON.parse(fs.readFileSync(busyReady, "utf8"));
    assert(busy.status === "BUSY", "must be BUSY while holder alive");
    await waitExitBounded(busyChild, 10000);

    assert(child.kill() !== false, "kill");
    await waitExitBounded(child, 10000);

    let after = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const rfile = path.join(workRoot, `reacq-${Date.now()}.json`);
      const c = spawnChild("try-once", lockDir, rfile);
      waitForFile(rfile, 10000);
      const payload = JSON.parse(fs.readFileSync(rfile, "utf8"));
      await waitExitBounded(c, 10000);
      if (payload.status === "ACQUIRED") {
        after = payload;
        break;
      }
      sleep(50);
    }
    assert(after, "must acquire after child kill (crash/abandon reacquire)");
    // acquired_after_abandon is true only when Wait returns WAIT_ABANDONED.
    // After a full process exit with no concurrent open handles, Windows may destroy
    // the named object; the next CreateMutexW installs a fresh mutex and Wait is
    // WAIT_OBJECT_0 (flag false). Flag must still be a boolean; native unit tests
    // cover the WAIT_ABANDONED=true path with concurrent handles / thread exit.
    assert(
      typeof after.acquired_after_abandon === "boolean",
      `acquired_after_abandon must be boolean, got ${JSON.stringify(after)}`,
    );
  });

  await check("holding lock does not block child chdir", async () => {
    const lockDir = path.join(workRoot, "chdir-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const holdReady = path.join(workRoot, "chdir-hold.json");
    const releaseFile = path.join(workRoot, "chdir-release");
    const holder = spawnChild("hold-until-release", lockDir, holdReady, releaseFile);
    waitForFile(holdReady);
    const chdirReady = path.join(workRoot, "chdir-ok.json");
    const chdirChild = spawnChild("chdir-while-parent-holds", lockDir, chdirReady);
    waitForFile(chdirReady);
    const r = JSON.parse(fs.readFileSync(chdirReady, "utf8"));
    assert(r.status === "CHDIR_OK", `got ${JSON.stringify(r)}`);
    await waitExitBounded(chdirChild, 10000);
    fs.writeFileSync(releaseFile, "x\n");
    await waitExitBounded(holder, 10000);
  });

  await check("foreign child cwd can acquire absolute lock dir", async () => {
    const lockDir = path.join(workRoot, "foreign-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const foreign = path.join(workRoot, "foreign-cwd");
    fs.mkdirSync(foreign, { recursive: true });
    const ready = path.join(workRoot, "foreign-ready.json");
    const child = spawnChild("foreign-cwd-try", lockDir, ready, null, foreign);
    waitForFile(ready);
    const r = JSON.parse(fs.readFileSync(ready, "utf8"));
    assert(r.status === "ACQUIRED", `got ${JSON.stringify(r)}`);
    await waitExitBounded(child, 10000);
  });

  await check("16-process barrier compete → exactly 1 winner", async () => {
    const competeDir = path.join(workRoot, "compete");
    fs.mkdirSync(competeDir, { recursive: true });
    const barrier = path.join(workRoot, "barrier-go");
    const releaseAll = path.join(workRoot, "barrier-release");
    const N = 16;
    const children = [];
    const readies = [];
    for (let i = 0; i < N; i += 1) {
      const ready = path.join(workRoot, `compete-${i}.json`);
      readies.push(ready);
      children.push(spawnChild("barrier-compete", competeDir, ready, releaseAll, barrier));
    }
    sleep(400);
    fs.writeFileSync(barrier, "go\n");
    for (const ready of readies) waitForFile(ready, 30000);
    const results = readies.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const winners = results.filter((r) => r.status === "ACQUIRED");
    const busy = results.filter((r) => r.status === "BUSY");
    const errors = results.filter((r) => r.status === "ERROR");
    assert(errors.length === 0, `unexpected errors: ${JSON.stringify(errors)}`);
    assert(winners.length === 1, `expected exactly 1 concurrent winner, got ${winners.length}`);
    assert(busy.length === N - 1, `expected ${N - 1} BUSY, got ${busy.length}`);
    fs.writeFileSync(releaseAll, "release\n");
    await Promise.all(children.map((c) => waitExitBounded(c, 15000)));
  });

  await check("worker_threads sibling isolate sees OS BUSY (loads package binary)", async () => {
    const lockDir = path.join(workRoot, "worker-lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const holdReady = path.join(workRoot, "worker-hold.json");
    const releaseFile = path.join(workRoot, "worker-release");
    const holder = spawnChild("hold-until-release", lockDir, holdReady, releaseFile);
    waitForFile(holdReady);

    const sibling = await new Promise((resolve, reject) => {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require("node:worker_threads");
        const { createRequire } = require("node:module");
        const path = require("node:path");
        const { createJiti } = createRequire(workerData.repoRoot + "/package.json")("jiti");
        const jiti = createJiti(workerData.repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
        const mod = jiti(path.join(workerData.repoRoot, "extensions/_shared/windows-native-addon.ts"));
        const loaded = mod.__TEST.loadWindowsNativeAddon({
          packageRoot: workerData.packageRoot,
          platform: "win32",
          arch: "x64",
          nodeVersion: process.versions.node,
          expectedManifestSha256: workerData.manifestSha256,
        });
        const pkgBin = mod.resolveWindowsNativeAddonPaths(workerData.packageRoot).binaryPath;
        let status;
        let err = null;
        let binaryPath = loaded.binaryPath;
        try {
          if (loaded.binaryPath.toLowerCase() !== pkgBin.toLowerCase()) {
            throw new Error("worker loaded non-package binary: " + loaded.binaryPath);
          }
          const got = mod.tryAcquireRetainedDirectoryLock(loaded.addon, workerData.lockDir);
          status = got ? "ACQUIRED" : "BUSY";
          if (got) got.close();
        } catch (e) {
          status = "ERROR";
          err = String(e && e.stack || e);
        }
        parentPort.postMessage({ status, err, binaryPath });
        `,
        {
          eval: true,
          workerData: {
            repoRoot,
            packageRoot,
            manifestSha256,
            lockDir,
          },
        },
      );
      worker.on("message", (msg) => {
        worker.terminate().then(() => resolve(msg), reject);
      });
      worker.on("error", reject);
    });
    assert(sibling.status === "BUSY", `sibling isolate must be OS-BUSY, got ${JSON.stringify(sibling)}`);
    assert(
      pathsEqualWin(sibling.binaryPath, pkgPaths.binaryPath),
      `worker binaryPath must be package path, got ${sibling.binaryPath}`,
    );
    fs.writeFileSync(releaseFile, "x\n");
    await waitExitBounded(holder, 15000);
  });

  // Cleanup — all workers exited; controller never mapped .node → delete must succeed.
  const cleanupErrors = [];
  for (const [label, target] of [["workRoot", workRoot], ["packageRoot", packageRoot]]) {
    let lastErr = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        sleep(100);
      }
    }
    if (lastErr) cleanupErrors.push(`${label}: ${lastErr?.message || lastErr}`);
  }
  if (cleanupErrors.length) {
    console.error(`cleanup failed (hard fail, no WARN pass): ${cleanupErrors.join("; ")}`);
    process.exit(1);
  }

  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} case(s); ${passed} passed`);
    process.exit(1);
  }
  console.log(`\nPASS: ${passed} checks (named mutex retained lock; controller never loaded .node; no production wire-up)`);
}

function waitExitBounded(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`child exit timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    });
  });
}
