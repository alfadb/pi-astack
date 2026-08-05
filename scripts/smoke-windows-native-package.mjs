#!/usr/bin/env node
/**
 * Smoke for Windows native production package plumbing (pin / ACL / tamper).
 *
 * Architecture: controller/worker
 * - Controller NEVER dlopen/require()'s any .node (live or temp), so unlock/install
 *   and temp-package cleanup are not blocked by a mapped module image.
 * - Dynamic loader checks run in independent child modes; each case owns its own
 *   temp root + child process. Child returns bounded JSON on stdout + exit code.
 * - After child exits, controller cleans the temp root; cleanup failure hard-fails.
 * - Live production zero-arg / package_rx: child via package verify command
 *   (npm run verify:windows-native-addon / package-windows-native-addon.mjs verify).
 * - unlock→install roundtrip: child package commands only; final restore install
 *   always runs; cleanup errors are never swallowed.
 * - Static checks may load the TS loader module for constants only (no .node).
 *
 * Closed self-reexec / worker argv:
 * - `--worker <mode> ...` enters worker only and never re-enters the controller path.
 * - Unknown worker modes hard-fail. Workers do not re-spawn the controller suite.
 *
 * - No production pin or package artifacts → SKIP (exit 0) after static checks.
 * - Does not download/compile. Does not touch ~/.abrain. Non-win32/x64 → SKIP.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageDir = path.join(repoRoot, "native", "windows", "win32-x64");
const binaryPath = path.join(packageDir, "pi-astack-windows-native.node");
const manifestPath = path.join(packageDir, "manifest.json");
const pinPath = path.join(repoRoot, "extensions", "_shared", "windows-native-addon-pin.ts");
const packageScript = path.join(repoRoot, "scripts", "package-windows-native-addon.mjs");
const buildScript = path.join(repoRoot, "scripts", "build-windows-native-addon.mjs");
const loaderPath = path.join(repoRoot, "extensions/_shared/windows-native-addon.ts");
const schemaPath = path.join(repoRoot, "schemas/windows-native-addon-manifest-v1.json");

const WORKER_MODES = new Set(["acl-gate", "expect-fail"]);

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

let passed = 0;
const failures = [];

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function emitWorkerJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

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

/** TS loader only — must never call loadWindowsNativeAddon / __TEST loaders that dlopen .node. */
function loadMod() {
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
  return jiti(loaderPath);
}

function runPackageCmd(cmd) {
  const r = spawnSync(process.execPath, [packageScript, cmd], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PI_ASTACK_ENABLE_TEST_HOOKS: "1" },
  });
  return {
    status: r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    error: r.error,
  };
}

function hasProductionArtifacts(mod) {
  const pin = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256;
  if (pin == null || !/^[0-9a-f]{64}$/.test(pin)) return false;
  if (!fs.existsSync(binaryPath) || !fs.existsSync(manifestPath)) return false;
  return true;
}

function restoreInstalled(label) {
  // unlock + install both hard-fail; never swallow unlock failures.
  const unlock = runPackageCmd("unlock");
  if (unlock.status !== 0) {
    throw new Error(
      `${label}: restore unlock failed status=${unlock.status} stderr=${unlock.stderr} stdout=${unlock.stdout}`,
    );
  }
  const install = runPackageCmd("install");
  if (install.status !== 0) {
    throw new Error(
      `${label}: restore install failed status=${install.status} stderr=${install.stderr} stdout=${install.stdout}`,
    );
  }
}

function makeTempPackageFromLive(label) {
  assert(fs.existsSync(binaryPath) && fs.existsSync(manifestPath), "live package required for temp copy");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-pkg-smoke-${label}-`));
  const relDir = path.join(root, "native", "windows", "win32-x64");
  fs.mkdirSync(relDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: `pkg-smoke-${label}`, private: true })}\n`);
  const tmpBinary = path.join(relDir, "pi-astack-windows-native.node");
  const tmpManifest = path.join(relDir, "manifest.json");
  fs.copyFileSync(binaryPath, tmpBinary);
  fs.copyFileSync(manifestPath, tmpManifest);
  return { root, binaryPath: tmpBinary, manifestPath: tmpManifest };
}

function hardRm(root) {
  if (!root) return;
  try {
    if (fs.existsSync(root)) {
      // Best-effort ACL reset so package_rx temp trees remain deletable by owner.
      spawnSync("icacls.exe", [root, "/reset", "/T", "/C", "/Q"], {
        windowsHide: true,
        encoding: "utf8",
      });
      const user = os.userInfo().username;
      spawnSync("icacls.exe", [root, "/grant", `${user}:(OI)(CI)F`, "/T", "/C", "/Q"], {
        windowsHide: true,
        encoding: "utf8",
      });
    }
  } catch {
    // ACL reset is best-effort; rm failure below is authoritative.
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  } catch (e) {
    throw new Error(`cleanup failed for ${root}: ${e?.message || e}`);
  }
  if (fs.existsSync(root)) {
    throw new Error(`cleanup left residual path: ${root}`);
  }
}

/**
 * Spawn a closed worker mode. Worker never re-enters the controller suite.
 * Returns { status, json, stdout, stderr, error }.
 */
function runWorker(mode, args, { timeoutMs = 120_000 } = {}) {
  assert(WORKER_MODES.has(mode), `unknown worker mode: ${mode}`);
  const r = spawnSync(
    process.execPath,
    [__filename, "--worker", mode, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      env: {
        ...process.env,
        PI_ASTACK_ENABLE_TEST_HOOKS: "1",
        // Closed: workers must not reexec into controller-only reexec paths.
        PI_ASTACK_PACKAGE_SMOKE_WORKER: "1",
      },
    },
  );
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "");
  let json = null;
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (line) {
    try {
      json = JSON.parse(line);
    } catch {
      json = null;
    }
  }
  return {
    status: r.status,
    json,
    stdout,
    stderr,
    error: r.error,
    signal: r.signal,
  };
}

function parseBoundedJsonStdout(stdout, label) {
  const text = String(stdout || "").trim();
  assert(text, `${label}: missing JSON stdout`);
  // package commands emit pretty-printed multi-line JSON; parse the whole stdout.
  // If leading/trailing noise exists, take the outermost {...} span.
  let json;
  try {
    json = JSON.parse(text);
    return json;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    assert(start >= 0 && end > start, `${label}: no JSON object in stdout; raw=${text.slice(0, 200)}`);
    const slice = text.slice(start, end + 1);
    try {
      json = JSON.parse(slice);
    } catch (err) {
      throw new Error(`${label}: invalid JSON stdout: ${err?.message || err}; raw=${slice.slice(0, 200)}`);
    }
    return json;
  }
}

// ── Worker modes (subprocess; may dlopen temp/live .node) ──────────────────
function runWorkerMain() {
  const mode = process.argv[3];
  try {
    if (process.env.PI_ASTACK_PACKAGE_SMOKE_WORKER !== "1") {
      // Soft allow direct --worker for debugging, but refuse recursive suite entry.
    }
    if (!WORKER_MODES.has(mode)) {
      throw new Error(`unknown worker mode: ${mode}`);
    }
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error(`worker requires win32-x64 (got ${process.platform}/${process.arch})`);
    }

    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    const mod = loadMod();

    if (mode === "acl-gate") {
      const packageRoot = process.argv[4];
      const expectedManifestSha256 = process.argv[5];
      assert(packageRoot && fs.existsSync(packageRoot), "acl-gate packageRoot missing");
      assert(/^[0-9a-f]{64}$/.test(expectedManifestSha256 || ""), "acl-gate pin sha256");

      // Without package_rx, enforcing path must fail closed.
      let denied;
      try {
        mod.__TEST.loadWindowsNativeAddonEnforcingPackageAcl({
          packageRoot,
          platform: "win32",
          arch: "x64",
          nodeVersion: process.versions.node,
          expectedManifestSha256,
        });
      } catch (err) {
        denied = err;
      }
      assert(denied, "expected PACKAGE_ACL_INVALID without package_rx");
      const deniedMsg = String(denied?.code || denied?.message || denied);
      assert(
        deniedMsg.includes("WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID"),
        `expected PACKAGE_ACL_INVALID, got ${deniedMsg}`,
      );

      // Set package_rx via non-enforcing load, then re-enforce.
      const loaded = mod.__TEST.loadWindowsNativeAddon({
        packageRoot,
        platform: "win32",
        arch: "x64",
        nodeVersion: process.versions.node,
        expectedManifestSha256,
      });
      const paths = mod.resolveWindowsNativeAddonPaths(packageRoot);
      const pkgDir = path.dirname(paths.binaryPath);
      loaded.addon.setProtectedPath(paths.manifestPath, "file", "package_rx");
      loaded.addon.setProtectedPath(paths.binaryPath, "file", "package_rx");
      loaded.addon.setProtectedPath(pkgDir, "directory", "package_rx");
      const ok = mod.__TEST.loadWindowsNativeAddonEnforcingPackageAcl({
        packageRoot,
        platform: "win32",
        arch: "x64",
        nodeVersion: process.versions.node,
        expectedManifestSha256,
      });
      assert(ok.status === "loaded", "enforcing load after package_rx");
      emitWorkerJson({
        ok: true,
        mode,
        status: ok.status,
        denied_code: "WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID",
      });
      process.exit(0);
    }

    if (mode === "expect-fail") {
      const packageRoot = process.argv[4];
      const expectedManifestSha256 = process.argv[5];
      const expectedCode = process.argv[6];
      assert(packageRoot && fs.existsSync(packageRoot), "expect-fail packageRoot missing");
      assert(/^[0-9a-f]{64}$/.test(expectedManifestSha256 || ""), "expect-fail pin sha256");
      assert(expectedCode && expectedCode.startsWith("WINDOWS_NATIVE_ADDON_"), "expect-fail code");

      let caught;
      try {
        mod.__TEST.loadWindowsNativeAddon({
          packageRoot,
          platform: "win32",
          arch: "x64",
          nodeVersion: process.versions.node,
          expectedManifestSha256,
        });
      } catch (err) {
        caught = err;
      }
      assert(caught, `expected failure containing ${expectedCode}`);
      const msg = String(caught?.code || caught?.message || caught);
      assert(msg.includes(expectedCode), `expected ${expectedCode} in ${msg}`);
      emitWorkerJson({
        ok: true,
        mode,
        expected_code: expectedCode,
        observed: expectedCode,
      });
      process.exit(0);
    }

    throw new Error(`unhandled worker mode: ${mode}`);
  } catch (err) {
    emitWorkerJson({
      ok: false,
      mode: mode || null,
      error: err instanceof Error ? err.stack || err.message : String(err),
    });
    process.exit(1);
  }
}

// Closed worker entry — never falls through into controller.
if (process.argv[2] === "--worker") {
  runWorkerMain();
  process.exit(1);
}

// Refuse accidental reentry if a parent marked us as worker-only.
if (process.env.PI_ASTACK_PACKAGE_SMOKE_WORKER === "1") {
  console.error("smoke-windows-native-package: worker env set without --worker; refusing controller entry");
  process.exit(2);
}

// ── Static checks (always run; no artifact / no .node required) ────────────
console.log("Windows native package plumbing smoke (controller/worker)");

await check("static: pin file excluded from build source closure list", () => {
  const buildSrc = fs.readFileSync(buildScript, "utf8");
  assert(
    /FORBIDDEN_CLOSURE_PATHS/.test(buildSrc),
    "build script must hard-assert forbidden closure paths",
  );
  assert(
    /windows-native-addon-pin\.ts/.test(buildSrc),
    "build script must name pin.ts as forbidden",
  );
  assert(
    !/EXTRA_CLOSURE_FILES\s*=\s*\[[^\]]*windows-native-addon-pin\.ts/s.test(buildSrc),
    "pin.ts must not appear in EXTRA_CLOSURE_FILES",
  );
  assert(
    /package-windows-native-addon\.mjs/.test(buildSrc),
    "package script must be in build closure inputs",
  );
  assert(
    /smoke-windows-native-package\.mjs/.test(buildSrc),
    "package smoke must be in build closure inputs",
  );
  assert(
    /\.gitattributes/.test(buildSrc),
    ".gitattributes must be in build source closure",
  );
});

await check("static: toolchain_id preimage drops path/locale inputs", () => {
  const buildSrc = fs.readFileSync(buildScript, "utf8");
  assert(/assertToolchainIdPreimageClean/.test(buildSrc), "must assert clean toolchain preimage");
  assert(/extractClNumericVersion/.test(buildSrc), "must extract cl numeric version");
  assert(/extractLinkNumericVersion/.test(buildSrc), "must extract link numeric version");
  const captureFn = buildSrc.slice(buildSrc.indexOf("function captureToolchain"));
  const componentsBlock = captureFn.slice(
    captureFn.indexOf("const components = {"),
    captureFn.indexOf("};", captureFn.indexOf("const components = {")) + 2,
  );
  assert(!/cargo_home\s*:/.test(componentsBlock), "components must not include cargo_home");
  assert(!/rustup_home\s*:/.test(componentsBlock), "components must not include rustup_home");
  assert(!/cl_banner\s*:/.test(componentsBlock), "components must not include cl_banner");
  assert(!/link_banner\s*:/.test(componentsBlock), "components must not include link_banner");
  assert(/cl_version\s*:/.test(componentsBlock), "components must include cl_version");
  assert(/link_version\s*:/.test(componentsBlock), "components must include link_version");
});

await check("static: pin.ts initial values null + LF", () => {
  const text = fs.readFileSync(pinPath, "utf8");
  assert(!text.includes("\r"), "pin.ts must be LF");
  assert(
    /WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256:\s*string\s*\|\s*null\s*=\s*null/.test(text)
      || /WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256:\s*string\s*\|\s*null\s*=\s*"[0-9a-f]{64}"/.test(text),
    "pin manifest sha256 must be null or sha256 hex",
  );
  assert(
    /WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT:\s*string\s*\|\s*null\s*=\s*(null|"[0-9a-f]{40}")/.test(text),
    "pin source commit must be null or git sha1",
  );
});

await check("static: release path-trim + /Brepro preserved in CARGO_ENCODED_RUSTFLAGS", () => {
  const cargo = fs.readFileSync(path.join(repoRoot, "native/windows/Cargo.toml"), "utf8");
  const buildSrc = fs.readFileSync(buildScript, "utf8");
  const cargoConfig = fs.readFileSync(path.join(repoRoot, "native/windows/.cargo/config.toml"), "utf8");
  assert(/trim-paths/.test(cargo), "Cargo.toml must document trim-paths intent");
  assert(/applyTrimPathRemaps/.test(buildSrc), "build must apply trim-path remaps");
  assert(/--remap-path-prefix/.test(buildSrc), "build must use stable --remap-path-prefix");
  assert(/CARGO_ENCODED_RUSTFLAGS/.test(buildSrc), "remaps must go through CARGO_ENCODED_RUSTFLAGS");
  assert(/link-arg=\/Brepro/.test(buildSrc), "ENCODED_RUSTFLAGS must re-include link-arg=/Brepro");
  assert(/assertEncodedRustflags/.test(buildSrc), "must assert final encoded flags");
  assert(/link-arg=\/Brepro/.test(cargoConfig), ".cargo/config must declare /Brepro");
  assert(/assertBinaryHasNoSensitivePaths/.test(buildSrc), "must scan binary for sensitive path bytes");
});

await check("static: .gitattributes text=auto eol=lf + binary overrides + in closure", () => {
  const ga = fs.readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");
  assert(!ga.includes("\r"), ".gitattributes must be LF");
  assert(/^\*\s+text=auto\s+eol=lf\s*$/m.test(ga), "first policy must be * text=auto eol=lf");
  assert(/\.node\s+binary/.test(ga), ".node binary override");
  assert(/manifest\.json\s+-text/.test(ga), "manifest -text override");
});

await check("static: capability four-way + manifest field sync", () => {
  const expectedCaps = [
    "atomic_file_tempdir_v1",
    "atomic_file_v1",
    "protected_dacl_v1",
    "retained_directory_lock_v1",
  ];
  // TS constants only — no .node dlopen.
  const mod = loadMod();
  assert(
    JSON.stringify([...mod.WINDOWS_NATIVE_ADDON_KNOWN_CAPABILITIES]) === JSON.stringify(expectedCaps),
    "TS known capabilities",
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert(schema.properties.capabilities.contains?.const === "retained_directory_lock_v1", "schema contains retained");
  const buildSrc = fs.readFileSync(buildScript, "utf8");
  const pkgSrc = fs.readFileSync(packageScript, "utf8");
  const libSrc = fs.readFileSync(path.join(repoRoot, "native/windows/src/lib.rs"), "utf8");
  for (const cap of expectedCaps) {
    assert(buildSrc.includes(cap), `build CAPABILITIES must include ${cap}`);
    assert(pkgSrc.includes(cap), `package CAPABILITIES must include ${cap}`);
    assert(libSrc.includes(cap), `native lib must include ${cap}`);
  }
  const evidenceFields = ["build_mode", "reproducibility", "native_tests", "clippy", "build_config_sha256"];
  for (const f of evidenceFields) {
    assert(Object.prototype.hasOwnProperty.call(schema.properties, f), `schema has ${f}`);
    assert(mod.WINDOWS_NATIVE_ADDON_MANIFEST_KEYS.includes(f), `loader MANIFEST_KEYS has ${f}`);
    assert(pkgSrc.includes(`"${f}"`) || pkgSrc.includes(f), `package knows ${f}`);
    assert(libSrc.includes(f) || libSrc.includes(f.toUpperCase()) || /build_mode|reproducibility|native_tests|clippy|build_config_sha256/.test(libSrc), `native has ${f}`);
  }
  // loadInstalledForAcl must throw, not die/process.exit
  assert(/function loadInstalledForAcl/.test(pkgSrc), "loadInstalledForAcl present");
  const loadFn = pkgSrc.slice(pkgSrc.indexOf("function loadInstalledForAcl"), pkgSrc.indexOf("function cmdInstall"));
  assert(/throw new Error/.test(loadFn), "loadInstalledForAcl must throw");
  assert(!/\bdie\(/.test(loadFn), "loadInstalledForAcl must not call die");
  assert(!/process\.exit/.test(loadFn), "loadInstalledForAcl must not process.exit");
  assert(/loadWindowsNativeAddonEnforcingPackageAcl/.test(fs.readFileSync(loaderPath, "utf8")), "test-hooks ACL entry present");
});

await check("static: package accepts only production evidence fields", () => {
  const pkgSrc = fs.readFileSync(packageScript, "utf8");
  assert(/build_mode\s*!==\s*"production"|buildMode !== "production"/.test(pkgSrc), "package requires production");
  assert(/dual_clean_match/.test(pkgSrc), "package requires dual_clean_match");
  assert(/native_tests !== "passed"/.test(pkgSrc), "package requires native_tests=passed");
  assert(/clippy !== "passed"/.test(pkgSrc), "package requires clippy=passed");
  assert(/MAX_BINARY_BYTES|64 \* 1024 \* 1024/.test(pkgSrc), "package enforces 64MiB ceiling");
  assert(/restorePinOrNull|pinTsSource\(null/.test(pkgSrc), "package post-verify fail restores pin");
  assert(/probePackageDirWritability|writability probe/.test(pkgSrc), "package probes directory writability");
});

await check("static: cmdUnlock native branch no same-process r+; fallback only probes", () => {
  const pkgSrc = fs.readFileSync(packageScript, "utf8");
  const unlockStart = pkgSrc.indexOf("function cmdUnlock");
  const unlockEnd = pkgSrc.indexOf("function cmdVerify");
  assert(unlockStart > 0 && unlockEnd > unlockStart, "cmdUnlock/cmdVerify present");
  const unlockFn = pkgSrc.slice(unlockStart, unlockEnd);

  // Bounded success fields present.
  assert(/mapped_binary_release:\s*"on_process_exit"/.test(unlockFn), "native emits on_process_exit");
  assert(/mapped_binary_release:\s*"not_mapped"/.test(unlockFn), "fallback emits not_mapped");
  assert(/acl_profile:\s*"private_rw"/.test(unlockFn), "native emits acl_profile private_rw");
  assert(/method:\s*"native_private_rw"/.test(unlockFn), "native method closed");
  assert(/method:\s*"icacls_reset"/.test(unlockFn), "icacls method closed");
  assert(/used_native:\s*true/.test(unlockFn), "native used_native true");
  assert(/used_native:\s*false/.test(unlockFn), "fallback used_native false");

  // Native success path: after last verifyProtectedPath, emit + return before any openSync r+.
  const lastVerify = unlockFn.lastIndexOf("verifyProtectedPath");
  const nativeReturnMarker = unlockFn.indexOf('mapped_binary_release: "on_process_exit"');
  assert(lastVerify > 0 && nativeReturnMarker > lastVerify, "native success after verify");
  const nativeSuccessSlice = unlockFn.slice(lastVerify, nativeReturnMarker + 80);
  assert(!/openSync\s*\(/.test(nativeSuccessSlice), "native success path must not openSync");
  assert(/\breturn;/.test(unlockFn.slice(nativeReturnMarker, nativeReturnMarker + 200)), "native path returns after success emit");

  // openSync r+ only after icacls fallback (not_mapped path / after catch fallthrough).
  const openIdx = unlockFn.indexOf("openSync");
  assert(openIdx > 0, "fallback openSync probe present");
  assert(openIdx > nativeReturnMarker, "openSync only after native success emit/return");
  const icaclsIdx = unlockFn.indexOf("icacls");
  assert(icaclsIdx > 0 && openIdx > icaclsIdx, "openSync only after icacls fallback starts");

  // Smoke must not reintroduce EBUSY clean-child bypass (split names avoid self-match).
  const selfSrc = fs.readFileSync(__filename, "utf8");
  const ebusyHelper = ["runUnlock", "AllowingMappedEbusy"].join("");
  const cleanProbe = ["probeWritability", "CleanChild"].join("");
  const sameProbe = ["same_process", "_probe"].join("");
  assert(!selfSrc.includes(ebusyHelper), "smoke must not use EBUSY unlock bypass");
  assert(!selfSrc.includes(cleanProbe), "smoke must not use clean-child r+ probe helper");
  assert(!selfSrc.includes(sameProbe), "smoke must not invent " + sameProbe + " field");
  // restoreInstalled must hard-fail unlock (no swallowed catch around unlock).
  const restoreStart = selfSrc.indexOf("function restoreInstalled");
  assert(restoreStart > 0, "restoreInstalled present");
  const restoreEnd = selfSrc.indexOf("\nfunction ", restoreStart + 1);
  const restoreFn = selfSrc.slice(restoreStart, restoreEnd > 0 ? restoreEnd : undefined);
  assert(/runPackageCmd\("unlock"\)/.test(restoreFn), "restoreInstalled calls unlock");
  assert(/restore unlock failed/.test(restoreFn), "restoreInstalled hard-fails unlock");
  assert(!/void err/.test(restoreFn), "restoreInstalled must not swallow unlock errors");
});

await check("static: package smoke controller never dlopens .node (source contract)", () => {
  const selfSrc = fs.readFileSync(__filename, "utf8");
  const workerSplit = selfSrc.indexOf("function runWorkerMain");
  assert(workerSplit > 0, "runWorkerMain present");
  // Only the post-worker controller body is constrained; strip this static check itself
  // so its string literals cannot false-positive the forbidden-call scan.
  const staticMarker = "// ── Static checks";
  const dynamicMarker = "// Live fixed package:";
  const staticIdx = selfSrc.indexOf(staticMarker);
  const dynamicIdx = selfSrc.indexOf(dynamicMarker);
  assert(staticIdx > 0 && dynamicIdx > staticIdx, "controller section markers present");
  // Dynamic controller checks (live verify / temp child / unlock) — must not call loaders.
  const dynamicController = selfSrc.slice(dynamicIdx);
  const loadCall = ["loadWindowsNative", "Addon"].join("") + "(";
  const testLoad = ["__TEST.", "loadWindowsNative", "Addon"].join("");
  assert(!dynamicController.includes(loadCall), "dynamic controller must not call production loader");
  assert(!dynamicController.includes(testLoad), "dynamic controller must not call test loader");
  assert(/--worker/.test(selfSrc), "closed --worker entry present");
  assert(/WORKER_MODES/.test(selfSrc), "closed worker mode set present");
  assert(/hardRm/.test(selfSrc), "hard cleanup present");
  assert(/PI_ASTACK_PACKAGE_SMOKE_WORKER/.test(selfSrc), "worker env fence present");
});

if (process.platform !== "win32" || process.arch !== "x64") {
  if (failures.length) {
    console.error(`FAIL: ${failures.length} static checks failed before platform skip`);
    process.exit(1);
  }
  skip(`non-win32-x64 platform (${process.platform}/${process.arch}); static checks only`);
}

// TS pin/constants only — controller still does not map .node.
const mod = loadMod();
if (!hasProductionArtifacts(mod)) {
  if (failures.length) {
    console.error(`FAIL: ${failures.length} static checks failed before artifact skip`);
    process.exit(1);
  }
  skip("no production pin/artifacts; run production build + package + install first");
}

const pinSourceCommit = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT;

// Live fixed package: read-only production verify in a child process (no controller dlopen).
await check("live production zero-arg load + package_rx verify (read-only, child)", () => {
  // Prefer package verify command (same as npm run verify:windows-native-addon).
  const v = runPackageCmd("verify");
  assert(v.status === 0, `verify failed: ${v.stderr}\n${v.stdout}`);
  const evidence = parseBoundedJsonStdout(v.stdout, "live verify");
  assert(evidence.status === "verified", "verify status");
  assert(evidence.package_rx?.directory === "pass", "dir package_rx");
  assert(evidence.package_rx?.binary === "pass", "binary package_rx");
  assert(evidence.package_rx?.manifest === "pass", "manifest package_rx");
  assert(/^[0-9a-f]{64}$/.test(evidence.manifest_sha256), "manifest hash");
  assert(/^[0-9a-f]{64}$/.test(evidence.build_id), "build_id");
  assert(evidence.build_mode === "production", "build_mode production");
  assert(evidence.reproducibility === "dual_clean_match", "reproducibility dual_clean_match");
  assert(evidence.native_tests === "passed", "native_tests passed");
  assert(evidence.clippy === "passed", "clippy passed");
  assert(evidence.source_commit === pinSourceCommit, "PIN_SOURCE_COMMIT matches identity");
  assert(!/[A-Za-z]:\\/.test(v.stdout), "evidence must not contain Windows paths");
  assert(!/S-1-/.test(v.stdout), "evidence must not contain SID strings");
});

// Temp-package ACL gate (independent temp + child; controller never maps .node).
await check("temp package production ACL gate (enforcePackageAcl, child)", () => {
  const tmp = makeTempPackageFromLive("acl-gate");
  try {
    const pin = sha256(fs.readFileSync(tmp.manifestPath));
    const r = runWorker("acl-gate", [tmp.root, pin]);
    assert(r.status === 0, `acl-gate worker exit ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert(r.json?.ok === true, `acl-gate worker json not ok: ${JSON.stringify(r.json)}`);
    assert(r.json?.status === "loaded", "enforcing load after package_rx");
    assert(r.json?.denied_code === "WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID", "denied code");
  } finally {
    hardRm(tmp.root);
  }
});

await check("temp package manifest byte tamper → hash fail (child)", () => {
  const tmp = makeTempPackageFromLive("manifest-tamper");
  try {
    const original = fs.readFileSync(tmp.manifestPath);
    const pin = sha256(original);
    fs.writeFileSync(tmp.manifestPath, Buffer.concat([original, Buffer.from(" ")]));
    const r = runWorker("expect-fail", [tmp.root, pin, "WINDOWS_NATIVE_ADDON_MANIFEST_HASH_MISMATCH"]);
    assert(r.status === 0, `manifest-tamper worker exit ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert(r.json?.ok === true, `manifest-tamper worker json not ok: ${JSON.stringify(r.json)}`);
    assert(r.json?.observed === "WINDOWS_NATIVE_ADDON_MANIFEST_HASH_MISMATCH", "observed code");
  } finally {
    hardRm(tmp.root);
  }
});

await check("temp package binary byte tamper → hash fail (child)", () => {
  const tmp = makeTempPackageFromLive("binary-tamper");
  try {
    const manifestBytes = fs.readFileSync(tmp.manifestPath);
    const pin = sha256(manifestBytes);
    const original = fs.readFileSync(tmp.binaryPath);
    const dirty = Buffer.from(original);
    dirty[0] = dirty[0] ^ 0xff;
    fs.writeFileSync(tmp.binaryPath, dirty);
    const r = runWorker("expect-fail", [tmp.root, pin, "WINDOWS_NATIVE_ADDON_BINARY_HASH_MISMATCH"]);
    assert(r.status === 0, `binary-tamper worker exit ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert(r.json?.ok === true, `binary-tamper worker json not ok: ${JSON.stringify(r.json)}`);
    assert(r.json?.observed === "WINDOWS_NATIVE_ADDON_BINARY_HASH_MISMATCH", "observed code");
  } finally {
    hardRm(tmp.root);
  }
});

await check("temp package missing binary fail (child)", () => {
  const tmp = makeTempPackageFromLive("missing-binary");
  try {
    const pin = sha256(fs.readFileSync(tmp.manifestPath));
    fs.unlinkSync(tmp.binaryPath);
    const r = runWorker("expect-fail", [tmp.root, pin, "WINDOWS_NATIVE_ADDON_BINARY_MISSING"]);
    assert(r.status === 0, `missing-binary worker exit ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert(r.json?.ok === true, `missing-binary worker json not ok: ${JSON.stringify(r.json)}`);
    assert(r.json?.observed === "WINDOWS_NATIVE_ADDON_BINARY_MISSING", "observed code");
  } finally {
    hardRm(tmp.root);
  }
});

// Controller still has no mapped live binary (never dlopened). Child unlock/install only.
await check("unlock → install roundtrip (live ACL only, child cmds)", () => {
  const u = runPackageCmd("unlock");
  assert(u.status === 0, `unlock failed: ${u.stderr}\n${u.stdout}`);
  const unlockJson = parseBoundedJsonStdout(u.stdout, "unlock");
  assert(unlockJson.status === "unlocked", "unlock status");
  assert(unlockJson.method === "native_private_rw" || unlockJson.method === "icacls_reset", "unlock method closed set");
  assert(unlockJson.used_native === true || unlockJson.used_native === false, "used_native boolean");
  assert(
    unlockJson.mapped_binary_release === "on_process_exit" || unlockJson.mapped_binary_release === "not_mapped",
    "mapped_binary_release closed set",
  );
  if (unlockJson.method === "native_private_rw") {
    assert(unlockJson.used_native === true, "native method ⇒ used_native");
    assert(unlockJson.acl_profile === "private_rw", "native acl_profile");
    assert(unlockJson.mapped_binary_release === "on_process_exit", "native mapped release");
    assert(unlockJson.writable !== true, "native must not claim same-process writable");
  } else {
    assert(unlockJson.used_native === false, "icacls method ⇒ not used_native");
    assert(unlockJson.mapped_binary_release === "not_mapped", "icacls mapped release");
  }
  const i = runPackageCmd("install");
  assert(i.status === 0, `install failed: ${i.stderr}\n${i.stdout}`);
  const v = runPackageCmd("verify");
  assert(v.status === 0, `verify failed: ${v.stderr}\n${v.stdout}`);
  const evidence = parseBoundedJsonStdout(v.stdout, "roundtrip verify");
  assert(evidence.status === "verified", "verify status");
  assert(evidence.package_rx?.directory === "pass", "dir package_rx");
  assert(evidence.package_rx?.binary === "pass", "binary package_rx");
  assert(evidence.package_rx?.manifest === "pass", "manifest package_rx");
  assert(/^[0-9a-f]{64}$/.test(evidence.manifest_sha256), "manifest hash");
  assert(/^[0-9a-f]{64}$/.test(evidence.build_id), "build_id");
  assert(evidence.build_mode === "production", "evidence build_mode");
  assert(evidence.reproducibility === "dual_clean_match", "evidence reproducibility");
  assert(!/[A-Za-z]:\\/.test(v.stdout), "evidence must not contain Windows paths");
  assert(!/S-1-/.test(v.stdout), "evidence must not contain SID strings");
});

// Final restore guarantee (child commands; never swallow).
try {
  restoreInstalled("final");
} catch (err) {
  failures.push({ name: "final restore install", err });
  console.log(`  FAIL  final restore install\n        ${err?.stack || err?.message || err}`);
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} checks failed (${passed} passed)`);
  process.exit(1);
}
console.log(`\nOK: ${passed} checks passed (controller never loaded .node)`);
