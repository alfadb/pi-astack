#!/usr/bin/env node
/**
 * Platform-neutral retained-directory-lock adapter smoke.
 *
 * Always:
 * - static assert Linux OFD key source unchanged (still hard-requires linux + flock)
 * - static assert fd-dependent production consumers still import OFD directly
 * - static assert non-fd production consumers import the adapter
 * - production path: zero-arg load / pin-null fail-closed on win32; unsupported on other non-linux
 *
 * Windows (with smoke-staging binary):
 * - temp package + dynamic pin via windows-native-addon `__TEST` only
 * - adapter seam `retainedDirectoryLockTestApi.acquireWithWindowsAddon` (no env override)
 * - BUSY contention, crash release, stable RetainedDirectoryLockError mapping
 * - production acquireRetainedDirectoryLock fails closed while pin is null
 *
 * Does not touch ~/.abrain or settings. Does not write production pin.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
// windows-native-addon __TEST.loadWindowsNativeAddon requires test hooks.
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const stagedNode = path.join(repoRoot, "native/windows/target/smoke-staging/pi-astack-windows-native.node");
const buildInfoPath = path.join(repoRoot, "native/windows/target/smoke-staging/build-info.json");

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

let passed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`);
  }
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

function waitExit(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("child wait timeout"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function loadJitiModule(rel) {
  const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
  return jiti(path.join(repoRoot, rel));
}

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

// ── Static wiring assertions (all platforms) ───────────────────────────────

check("Linux OFD key contract source unchanged", () => {
  const src = read("extensions/_shared/retained-directory-ofd-lock.ts");
  assert(/export function acquireRetainedDirectoryOfdLock\(/.test(src), "OFD acquire export present");
  assert(/process\.platform !== "linux"/.test(src), "OFD still hard-requires linux");
  assert(/OFD_LOCK_UNSUPPORTED/.test(src), "OFD_LOCK_UNSUPPORTED retained");
  assert(/\/usr\/bin\/flock/.test(src), "pinned flock path retained");
  assert(/procfd_path: `\/proc\/self\/fd\/\$\{fd\}`/.test(src) || /procfd_path:\s*`\/proc\/self\/fd\/\$\{fd\}`/.test(src), "procfd_path retained");
  assert(!/loadWindowsNativeAddon|tryAcquireRetainedDirectoryLock|windows-native-addon/.test(src), "OFD must not import windows native");
  assert(!/lockfile|sync-file-lock|fs\.writeFileSync\([^)]*lock/i.test(src), "OFD must not fallback to TS lockfile");
});

check("fd-dependent consumers still import OFD directly", () => {
  const fdConsumers = [
    "extensions/_shared/proposition-lifecycle-freshness-production-core.ts",
    "extensions/_shared/proposition-real-policy-append-production-execute.ts",
  ];
  for (const rel of fdConsumers) {
    const src = read(rel);
    // real-policy uses its own evidence OFD helper, not the shared OFD export name necessarily.
    if (rel.includes("lifecycle-freshness")) {
      assert(/from ["']\.\/retained-directory-ofd-lock["']/.test(src), `${rel} must import OFD module`);
      assert(/acquireRetainedDirectoryOfdLock/.test(src), `${rel} must call OFD acquire`);
      assert(!/from ["']\.\/retained-directory-lock["']/.test(src), `${rel} must not use adapter`);
    } else {
      // real-policy: own OFD / procfd path — must not use adapter, must keep fd/procfd.
      assert(/procfdDirectory|acquireEvidenceDirectoryLock|\/proc\/self\/fd/.test(src), `${rel} keeps procfd/OFD path`);
      assert(!/from ["']\.\/retained-directory-lock["']/.test(src), `${rel} must not use adapter`);
      assert(!/from ["']\.\/retained-directory-ofd-lock["']/.test(src), `${rel} keeps its own OFD helper (not shared adapter)`);
    }
  }
});

check("non-fd production consumers use adapter", () => {
  const adapterConsumers = [
    "extensions/_shared/canonical-mutation-barrier.ts",
    "extensions/_shared/l1-validated-scan-cache.ts",
    "extensions/sediment/edge-protocol-shadow.ts",
    "extensions/sediment/intake.ts",
    "extensions/sediment/worker-rpc.ts",
    "extensions/_shared/proposition-policy-stable-view-recovery.ts",
    "extensions/_shared/proposition-policy-stable-view-publisher.ts",
  ];
  for (const rel of adapterConsumers) {
    const src = read(rel);
    assert(/from ["'][^"']*retained-directory-lock["']/.test(src), `${rel} must import adapter`);
    assert(!/from ["'][^"']*retained-directory-ofd-lock["']/.test(src), `${rel} must not import OFD directly`);
  }
});

check("adapter surface + Windows production pin fail-closed path + gated test override only", () => {
  const src = read("extensions/_shared/retained-directory-lock.ts");
  assert(/export function acquireRetainedDirectoryLock\(/.test(src), "acquire export");
  assert(/export async function withRetainedDirectoryLock/.test(src), "with export");
  assert(/export class RetainedDirectoryLockError/.test(src), "error class");
  assert(/assertIdentity\(\)/.test(src), "assertIdentity on lease");
  assert(/loadWindowsNativeAddon/.test(src), "uses production windows loader");
  assert(/tryAcquireRetainedDirectoryLock/.test(src), "uses tryAcquire wrapper");
  assert(/retainedDirectoryLockTestApi/.test(src), "explicit test seam");
  assert(/acquired_after_abandon/.test(src), "acquired_after_abandon passthrough");
  assert(/RETAINED_DIRECTORY_LOCK_CLOSED/.test(src), "closed code");
  assert(/PI_ASTACK_ENABLE_TEST_HOOKS/.test(src), "test hooks gate for override");
  // process.env is allowed only for the explicit test-hooks gate on installWindowsAddonOverride.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const envHits = [...codeOnly.matchAll(/process\.env/g)];
  assert(envHits.length === 1, `process.env only for test-hooks gate, got ${envHits.length}`);
  assert(/installWindowsAddonOverride[\s\S]{0,400}PI_ASTACK_ENABLE_TEST_HOOKS/.test(src),
    "installWindowsAddonOverride must gate on PI_ASTACK_ENABLE_TEST_HOOKS");
  assert(/acquireWithWindowsAddon[\s\S]{0,200}assertRetainedLockTestHooks|acquireWithWindowsAddon[\s\S]{0,300}PI_ASTACK_ENABLE_TEST_HOOKS|assertRetainedLockTestHooks\("acquireWithWindowsAddon"\)/.test(src),
    "acquireWithWindowsAddon must gate on test hooks");
  assert(/assertRetainedLockTestHooks\("resetWindowsAddonSingleton"\)|resetWindowsAddonSingleton[\s\S]{0,200}PI_ASTACK_ENABLE_TEST_HOOKS/.test(src),
    "resetWindowsAddonSingleton must gate on test hooks");
  assert(/assertRetainedLockTestHooks\("hasWindowsAddonSingleton"\)|hasWindowsAddonSingleton[\s\S]{0,200}PI_ASTACK_ENABLE_TEST_HOOKS/.test(src),
    "hasWindowsAddonSingleton must gate on test hooks");
  assert(!/\bsync-file-lock\b/.test(codeOnly), "no TS lockfile fallback import");
  assert(!/from\s+["'][^"']*lockfile[^"']*["']/.test(codeOnly), "no lockfile module import");
  assert(!/expectedManifestSha256|packageRoot/.test(codeOnly.match(/retainedDirectoryLockTestApi[\s\S]*$/)?.[0] || ""),
    "test api must not expose pin/package paths");
  assert(/WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING|mapWindowsToRetainedError|loadWindowsNativeAddon\(\)/.test(src)
    || /loadWindowsNativeAddon/.test(src), "production load path present");
  // Failures must not be cached on the production singleton.
  assert(/Do not cache failures|windowsAddonSingleton = loaded/.test(src), "success-only singleton cache");
});

check("publisher identity check is platform-split (linux fstat / windows assertIdentity)", () => {
  const src = read("extensions/_shared/proposition-policy-stable-view-publisher.ts");
  assert(/process\.platform === "linux"/.test(src), "linux branch");
  assert(/fs\.fstatSync\(lock\.fd\)/.test(src), "linux fstat(fd)");
  assert(/lock\.assertIdentity\(\)/.test(src), "windows assertIdentity");
});

// ── Module load + production fail-closed ───────────────────────────────────

const adapter = loadJitiModule("extensions/_shared/retained-directory-lock.ts");
const winMod = loadJitiModule("extensions/_shared/windows-native-addon.ts");

check("production acquire fails closed on non-linux without successful native load", () => {
  if (process.platform === "linux") {
    // On Linux production path is OFD; skip fail-closed pin check here.
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rdl-prod-"));
  try {
    let err = null;
    try {
      adapter.acquireRetainedDirectoryLock(dir);
    } catch (e) {
      err = e;
    }
    assert(err, "expected fail-closed error");
    assert(err.name === "RetainedDirectoryLockError" || err.name === "WindowsNativeAddonError"
      || /RetainedDirectoryLockError|WindowsNativeAddonError/.test(err.name), `error class: ${err.name}`);
    if (process.platform === "win32") {
      assert(
        err.code === "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING"
          || /PROVENANCE_PIN_MISSING/.test(String(err.message))
          || /PROVENANCE_PIN_MISSING/.test(String(err.code)),
        `win32 production must fail on missing pin, got ${err.code}: ${err.message}`,
      );
    } else {
      assert(
        err.code === "RETAINED_DIRECTORY_LOCK_UNSUPPORTED"
          || /UNSUPPORTED/.test(String(err.code)),
        `non-win non-linux unsupported, got ${err.code}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("test seam does not expose production-mutable pin path; override requires test hooks", () => {
  const api = adapter.retainedDirectoryLockTestApi;
  assert(api && typeof api.acquireWithWindowsAddon === "function", "acquireWithWindowsAddon");
  assert(typeof api.resetWindowsAddonSingleton === "function", "resetWindowsAddonSingleton");
  assert(typeof api.hasWindowsAddonSingleton === "function", "hasWindowsAddonSingleton");
  assert(typeof api.installWindowsAddonOverride === "function", "installWindowsAddonOverride");
  assert(!("expectedManifestSha256" in api), "must not expose pin field on seam");
  assert(!("packageRoot" in api), "must not expose packageRoot mutator on seam");
  const prev = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  try {
    delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    for (const [label, fn] of [
      ["installWindowsAddonOverride", () => api.installWindowsAddonOverride(null)],
      ["resetWindowsAddonSingleton", () => api.resetWindowsAddonSingleton()],
      ["hasWindowsAddonSingleton", () => api.hasWindowsAddonSingleton()],
      ["acquireWithWindowsAddon", () => api.acquireWithWindowsAddon(process.cwd(), {})],
    ]) {
      let err = null;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      assert(err, `${label} without test hooks must throw`);
      assert(
        err.code === "RETAINED_DIRECTORY_LOCK_TEST_HOOKS_DISABLED"
          || /TEST_HOOKS_DISABLED/.test(String(err.code)),
        `${label} code=${err.code}`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = prev;
  }
});

// ── Windows dynamic-pin multi-process ──────────────────────────────────────

function prepareTempPackage(mod, buildInfo, binaryBytes) {
  const abrain = path.resolve(os.homedir(), ".abrain");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rdl-pkg-"));
  assert(!root.startsWith(abrain + path.sep) && root !== abrain, `temp must not be under ~/.abrain: ${root}`);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "pi-astack-rdl-temp", private: true }, null, 2)}\n`);
  const paths = mod.resolveWindowsNativeAddonPaths(root);
  fs.mkdirSync(path.dirname(paths.binaryPath), { recursive: true });
  fs.writeFileSync(paths.binaryPath, binaryBytes);
  const toolchainId = buildInfo.toolchain_id || "d".repeat(64);
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
  return { root, paths, manifestSha256: sha256(Buffer.from(manifestText, "utf8")) };
}

function writeReadyAtomic(readyFile, payload) {
  const dir = path.dirname(readyFile);
  const tmp = path.join(dir, `.${path.basename(readyFile)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(tmp, readyFile);
}

// Child mode: load temp package via windows __TEST, then adapter test seam.
// Must not fall through into the controller suite.
if (process.argv[2] === "--child") {
  const mode = process.argv[3];
  const payload = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  const { packageRoot, manifestSha256, lockDir, readyFile, releaseFile } = payload;
  try {
    const win = loadJitiModule("extensions/_shared/windows-native-addon.ts");
    const ad = loadJitiModule("extensions/_shared/retained-directory-lock.ts");
    const loaded = win.__TEST.loadWindowsNativeAddon({
      packageRoot,
      platform: "win32",
      arch: "x64",
      nodeVersion: process.versions.node,
      expectedManifestSha256: manifestSha256,
    });
    if (mode === "inproc-suite") {
      // Controller never loads .node — all same-process native checks run here.
      const results = [];
      const case_ = (name, fn) => {
        try {
          fn();
          results.push({ name, ok: true });
        } catch (e) {
          results.push({ name, ok: false, error: String(e?.stack || e) });
        }
      };
      case_("acquire/assert/fd-null/close", () => {
        const a = ad.retainedDirectoryLockTestApi.acquireWithWindowsAddon(lockDir, loaded.addon);
        if (a.status !== "ACQUIRED") throw new Error(`status=${a.status}`);
        if (a.fd !== null) throw new Error("fd must be null");
        if (a.procfd_path !== null) throw new Error("procfd_path must be null");
        if (typeof a.acquired_after_abandon !== "boolean") throw new Error("acquired_after_abandon missing");
        if (typeof a.identity.path !== "string" || !a.identity.path) throw new Error("identity.path");
        if (typeof a.identity.file_id !== "string") throw new Error("identity.file_id");
        a.assertIdentity();
        a.close();
        let closedErr = null;
        try { a.assertIdentity(); } catch (e) { closedErr = e; }
        if (!closedErr || closedErr.code !== "RETAINED_DIRECTORY_LOCK_CLOSED") {
          throw new Error(`closed assert: ${closedErr?.code}`);
        }
      });
      case_("second acquire BUSY", () => {
        const a = ad.retainedDirectoryLockTestApi.acquireWithWindowsAddon(lockDir, loaded.addon);
        if (a.status !== "ACQUIRED") throw new Error("first");
        const b = ad.retainedDirectoryLockTestApi.acquireWithWindowsAddon(lockDir, loaded.addon);
        if (b.status !== "BUSY") throw new Error(`second=${b.status}`);
        a.close();
        const c = ad.retainedDirectoryLockTestApi.acquireWithWindowsAddon(lockDir, loaded.addon);
        if (c.status !== "ACQUIRED") throw new Error("reacquire");
        c.close();
      });
      case_("error maps to RetainedDirectoryLockError", () => {
        const missing = path.join(lockDir, "no-such-nested-dir-xyz");
        let err = null;
        try {
          ad.retainedDirectoryLockTestApi.acquireWithWindowsAddon(missing, loaded.addon);
        } catch (e) { err = e; }
        if (!err) throw new Error("expected error");
        if (err.name !== "RetainedDirectoryLockError") throw new Error(`name=${err.name}`);
        if (typeof err.code !== "string" || !err.code.startsWith("WINDOWS_NATIVE_ADDON_")) {
          throw new Error(`code=${err.code}`);
        }
      });
      writeReadyAtomic(readyFile, { status: "OK", results });
      process.exit(results.every((r) => r.ok) ? 0 : 1);
    }

    const lease = ad.retainedDirectoryLockTestApi.acquireWithWindowsAddon(lockDir, loaded.addon);
    if (mode === "try-once") {
      writeReadyAtomic(readyFile, {
        status: lease.status,
        fd: lease.fd,
        procfd_path: lease.procfd_path,
        hasAssert: typeof lease.assertIdentity === "function",
        identityPath: lease.identity?.path,
      });
      if (lease.status === "ACQUIRED") {
        lease.assertIdentity();
        lease.close();
      }
      process.exit(0);
    }
    if (mode === "hold-until-release") {
      if (lease.status !== "ACQUIRED") {
        writeReadyAtomic(readyFile, { status: lease.status });
        process.exit(1);
      }
      lease.assertIdentity();
      // Pin across sync wait so FR cannot drop the mutex.
      globalThis.__PI_ASTACK_RDL_HOLD_LEASE = lease;
      writeReadyAtomic(readyFile, { status: "ACQUIRED", fd: lease.fd });
      waitForFile(releaseFile, 60000);
      lease.close();
      process.exit(0);
    }
    if (mode === "hold-forever") {
      if (lease.status !== "ACQUIRED") {
        writeReadyAtomic(readyFile, { status: lease.status });
        process.exit(1);
      }
      globalThis.__PI_ASTACK_RDL_HOLD_LEASE = lease;
      writeReadyAtomic(readyFile, { status: "ACQUIRED" });
      setInterval(() => {
        try { globalThis.__PI_ASTACK_RDL_HOLD_LEASE.assertIdentity(); } catch { /* keep alive */ }
      }, 1000);
    } else {
      throw new Error(`unknown child mode ${mode}`);
    }
  } catch (error) {
    try {
      writeReadyAtomic(readyFile, {
        status: "ERROR",
        name: error?.name,
        code: error?.code,
        message: String(error?.message || error),
      });
    } catch { /* ignore */ }
    process.exit(1);
  }
} else {
  await runController();
}

async function runController() {

async function runWindowsDynamicPinSuite() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    console.log("  skip  windows dynamic-pin suite (not win32-x64)");
    return;
  }
  if (!fs.existsSync(stagedNode) || !fs.existsSync(buildInfoPath)) {
    console.log("  skip  windows dynamic-pin suite (missing smoke-staging artifact; run build:windows-native-addon)");
    return;
  }

  const binaryBytes = fs.readFileSync(stagedNode);
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  const { root: packageRoot, manifestSha256 } = prepareTempPackage(winMod, buildInfo, binaryBytes);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rdl-work-"));
  const abrain = path.resolve(os.homedir(), ".abrain");
  assert(!workRoot.startsWith(abrain + path.sep), "work root must not be under ~/.abrain");

  function spawnChild(mode, lockDir, readyFile, releaseFile) {
    const payloadPath = path.join(workRoot, `payload-${mode}-${randomBytes(4).toString("hex")}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify({
      packageRoot,
      manifestSha256,
      lockDir,
      readyFile,
      releaseFile: releaseFile || null,
    }));
    return spawn(process.execPath, [__filename, "--child", mode, payloadPath], {
      cwd: repoRoot,
      env: { ...process.env, PI_ASTACK_ENABLE_TEST_HOOKS: "1" },
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    });
  }

  try {
    // Controller never loads the .node binary (so temp package cleanup can delete it).
    await checkAsync("adapter+temp pin: in-process suite via child (acquire/BUSY/error map)", async () => {
      const lockDir = path.join(workRoot, "inproc-lock");
      fs.mkdirSync(lockDir, { recursive: true });
      const ready = path.join(workRoot, "inproc-ready.json");
      const child = spawnChild("inproc-suite", lockDir, ready);
      waitForFile(ready, 30000);
      const report = JSON.parse(fs.readFileSync(ready, "utf8"));
      await waitExit(child, 30000);
      assert(report.status === "OK", `inproc suite: ${JSON.stringify(report)}`);
      for (const r of report.results || []) {
        assert(r.ok, `inproc ${r.name}: ${r.error}`);
      }
      assert((report.results || []).length >= 3, "expected inproc cases");
    });

    await checkAsync("adapter+temp pin: multi-process holder → contender BUSY → release ACQUIRED", async () => {
      const lockDir = path.join(workRoot, "mp-lock");
      fs.mkdirSync(lockDir, { recursive: true });
      const holdReady = path.join(workRoot, "hold-ready.json");
      const releaseFile = path.join(workRoot, "hold-release");
      const holder = spawnChild("hold-until-release", lockDir, holdReady, releaseFile);
      waitForFile(holdReady);
      const held = JSON.parse(fs.readFileSync(holdReady, "utf8"));
      assert(held.status === "ACQUIRED", `holder: ${JSON.stringify(held)}`);
      assert(held.fd === null, "holder fd null");

      const tryReady = path.join(workRoot, "try-busy.json");
      const contender = spawnChild("try-once", lockDir, tryReady);
      waitForFile(tryReady);
      const busy = JSON.parse(fs.readFileSync(tryReady, "utf8"));
      assert(busy.status === "BUSY", `expected BUSY, got ${JSON.stringify(busy)}`);
      await waitExit(contender, 15000);

      fs.writeFileSync(releaseFile, "go\n");
      await waitExit(holder, 20000);

      const try2 = path.join(workRoot, "try-free.json");
      const c2 = spawnChild("try-once", lockDir, try2);
      waitForFile(try2);
      const free = JSON.parse(fs.readFileSync(try2, "utf8"));
      assert(free.status === "ACQUIRED", `expected ACQUIRED after release, got ${JSON.stringify(free)}`);
      await waitExit(c2, 15000);
    });

    await checkAsync("adapter+temp pin: kill holder → reacquire (crash release)", async () => {
      const lockDir = path.join(workRoot, "kill-lock");
      fs.mkdirSync(lockDir, { recursive: true });
      const ready = path.join(workRoot, "kill-hold-ready.json");
      const child = spawnChild("hold-forever", lockDir, ready);
      try {
        waitForFile(ready);
        const held = JSON.parse(fs.readFileSync(ready, "utf8"));
        assert(held.status === "ACQUIRED", `child hold: ${JSON.stringify(held)}`);

        const busyReady = path.join(workRoot, "kill-busy.json");
        const busyChild = spawnChild("try-once", lockDir, busyReady);
        waitForFile(busyReady);
        const busy = JSON.parse(fs.readFileSync(busyReady, "utf8"));
        assert(busy.status === "BUSY", `BUSY while holder alive, got ${JSON.stringify(busy)}`);
        await waitExit(busyChild, 15000);

        assert(child.kill() !== false, "kill holder");
        await waitExit(child, 15000);

        let after = null;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const rfile = path.join(workRoot, `reacq-${Date.now()}.json`);
          const c = spawnChild("try-once", lockDir, rfile);
          waitForFile(rfile, 15000);
          after = JSON.parse(fs.readFileSync(rfile, "utf8"));
          await waitExit(c, 15000);
          if (after.status === "ACQUIRED") break;
          sleep(100);
        }
        assert(after && after.status === "ACQUIRED", `reacquire after crash: ${JSON.stringify(after)}`);
      } finally {
        try { child.kill(); } catch { /* ignore */ }
        try { await waitExit(child, 5000); } catch { /* ignore */ }
      }
    });

    await checkAsync("production acquire still pin-null fail-closed after temp-pin tests", () => {
      // Production path never used the temp package; pin remains null.
      process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
      adapter.retainedDirectoryLockTestApi.resetWindowsAddonSingleton();
      const lockDir = path.join(workRoot, "prod-still-closed");
      fs.mkdirSync(lockDir, { recursive: true });
      let err = null;
      try {
        adapter.acquireRetainedDirectoryLock(lockDir);
      } catch (e) {
        err = e;
      }
      assert(err, "production must fail-closed");
      assert(
        err.code === "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING"
          || /PROVENANCE_PIN_MISSING/.test(String(err.code))
          || /PROVENANCE_PIN_MISSING/.test(String(err.message)),
        `expected pin missing, got ${err.code}: ${err.message}`,
      );
    });
  } finally {
    // Controller never loads .node — children must be gone before package delete.
    // Retry briefly for Windows file locks after child exits.
    const rmRetry = (target, label) => {
      let last = null;
      for (let i = 0; i < 20; i += 1) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
          return;
        } catch (e) {
          last = e;
          sleep(100);
        }
      }
      throw new Error(`${label} cleanup failed: ${last}`);
    };
    rmRetry(packageRoot, "temp package");
    rmRetry(workRoot, "work root");
  }
}

await runWindowsDynamicPinSuite();

// Linux OFD path smoke when available
if (process.platform === "linux") {
  check("linux adapter delegates to OFD (acquire/busy/assert/close/closed-assert)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rdl-linux-"));
    try {
      // OFD requires realpath-canonical directory with no symlink ancestors.
      const real = fs.realpathSync(dir);
      const a = adapter.acquireRetainedDirectoryLock(real);
      assert(a.status === "ACQUIRED", "acquired");
      assert(typeof a.fd === "number", "linux fd number");
      assert(typeof a.procfd_path === "string" && a.procfd_path.startsWith("/proc/self/fd/"), "procfd");
      assert(a.acquired_after_abandon === false, "linux acquired_after_abandon false");
      a.assertIdentity();
      const b = adapter.acquireRetainedDirectoryLock(real);
      assert(b.status === "BUSY", "second BUSY");
      assert(b.acquired_after_abandon === undefined, "BUSY omits acquired_after_abandon");
      a.close();
      let closedErr = null;
      try { a.assertIdentity(); } catch (e) { closedErr = e; }
      assert(closedErr && closedErr.code === "RETAINED_DIRECTORY_LOCK_CLOSED",
        `closed assertIdentity must throw CLOSED, got ${closedErr?.code}`);
      const c = adapter.acquireRetainedDirectoryLock(real);
      assert(c.status === "ACQUIRED", "reacquire");
      c.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log("");
if (failures.length) {
  console.error(`smoke-retained-directory-lock: ${failures.length} failure(s), ${passed} passed`);
  for (const f of failures) console.error(` - ${f.name}: ${f.error?.message || f.error}`);
  process.exit(1);
}
console.log(`smoke-retained-directory-lock: ${passed} passed`);
process.exit(0);
} // end runController
