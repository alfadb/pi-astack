#!/usr/bin/env node
/**
 * Smoke for Windows native production package plumbing (pin / ACL / tamper).
 *
 * - No production pin or package artifacts → SKIP (exit 0) after static checks.
 * - Live fixed package: read-only production zero-arg verify only (no destructive
 *   writes to already-dlopen-able live .node).
 * - Hash / missing / ACL tamper: independent temp package + subprocess; timeout/kill
 *   cannot pollute live package.
 * - Production ACL gate: temp package + __TEST.loadWindowsNativeAddonEnforcingPackageAcl
 *   (test-hooks gated); never rewrites live binary bytes.
 * - unlock→install roundtrip still exercises live ACL plumbing and always restores.
 *
 * Does not download/compile. Does not touch ~/.abrain. Non-win32/x64 → SKIP.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const packageDir = path.join(repoRoot, "native", "windows", "win32-x64");
const binaryPath = path.join(packageDir, "pi-astack-windows-native.node");
const manifestPath = path.join(packageDir, "manifest.json");
const pinPath = path.join(repoRoot, "extensions", "_shared", "windows-native-addon-pin.ts");
const packageScript = path.join(repoRoot, "scripts", "package-windows-native-addon.mjs");
const buildScript = path.join(repoRoot, "scripts", "build-windows-native-addon.mjs");
const loaderPath = path.join(repoRoot, "extensions/_shared/windows-native-addon.ts");
const schemaPath = path.join(repoRoot, "schemas/windows-native-addon-manifest-v1.json");

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

function expectFail(fn, codeIncludes) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert(caught, "expected failure");
  const msg = String(caught?.code || caught?.message || caught);
  if (codeIncludes) {
    assert(msg.includes(codeIncludes), `expected ${codeIncludes} in ${msg}`);
  }
  return caught;
}

function hasProductionArtifacts(mod) {
  const pin = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256;
  if (pin == null || !/^[0-9a-f]{64}$/.test(pin)) return false;
  if (!fs.existsSync(binaryPath) || !fs.existsSync(manifestPath)) return false;
  return true;
}

function restoreInstalled(label) {
  const unlock = runPackageCmd("unlock");
  const install = runPackageCmd("install");
  if (install.status !== 0) {
    throw new Error(
      `${label}: restore install failed status=${install.status} stderr=${install.stderr} stdout=${install.stdout}`,
    );
  }
  void unlock;
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

// ── Static checks (always run; no artifact required) ───────────────────────
console.log("Windows native package plumbing smoke");

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

if (process.platform !== "win32" || process.arch !== "x64") {
  if (failures.length) {
    console.error(`FAIL: ${failures.length} static checks failed before platform skip`);
    process.exit(1);
  }
  skip(`non-win32-x64 platform (${process.platform}/${process.arch}); static checks only`);
}

const mod = loadMod();
if (!hasProductionArtifacts(mod)) {
  if (failures.length) {
    console.error(`FAIL: ${failures.length} static checks failed before artifact skip`);
    process.exit(1);
  }
  skip("no production pin/artifacts; run production build + package + install first");
}

// Live fixed package: read-only production verify (no destructive .node writes).
await check("live production zero-arg load + package_rx verify (read-only)", () => {
  const prev = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  try {
    const fresh = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
    const m = fresh(loaderPath);
    const loaded = m.loadWindowsNativeAddon();
    assert(loaded.status === "loaded", "status loaded");
    assert(loaded.manifest.binary_sha256 && loaded.identity.build_id, "identity present");
    assert(m.WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT === loaded.identity.source_commit, "PIN_SOURCE_COMMIT matches identity");
    assert(loaded.identity.build_mode === "production", "build_mode production");
    assert(loaded.identity.reproducibility === "dual_clean_match", "reproducibility dual_clean_match");
    assert(loaded.identity.native_tests === "passed", "native_tests passed");
    assert(loaded.identity.clippy === "passed", "clippy passed");
    loaded.addon.verifyProtectedPath(packageDir, "directory", "package_rx");
    loaded.addon.verifyProtectedPath(binaryPath, "file", "package_rx");
    loaded.addon.verifyProtectedPath(manifestPath, "file", "package_rx");
  } finally {
    if (prev !== undefined) process.env.PI_ASTACK_ENABLE_TEST_HOOKS = prev;
    else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  }
});

// Temp-package ACL gate (does not touch live .node bytes).
await check("temp package production ACL gate (enforcePackageAcl)", () => {
  const tmp = makeTempPackageFromLive("acl-gate");
  try {
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    const fresh = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
    const m = fresh(loaderPath);
    const pin = sha256(fs.readFileSync(tmp.manifestPath));
    // Without package_rx, enforcing path must fail closed.
    expectFail(
      () => m.__TEST.loadWindowsNativeAddonEnforcingPackageAcl({
        packageRoot: tmp.root,
        platform: "win32",
        arch: "x64",
        nodeVersion: process.versions.node,
        expectedManifestSha256: pin,
      }),
      "WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID",
    );
    // Set package_rx on temp copy via native from a non-enforcing load, then re-enforce.
    const loaded = m.__TEST.loadWindowsNativeAddon({
      packageRoot: tmp.root,
      platform: "win32",
      arch: "x64",
      nodeVersion: process.versions.node,
      expectedManifestSha256: pin,
    });
    const pkgDir = path.dirname(tmp.binaryPath);
    loaded.addon.setProtectedPath(tmp.manifestPath, "file", "package_rx");
    loaded.addon.setProtectedPath(tmp.binaryPath, "file", "package_rx");
    loaded.addon.setProtectedPath(pkgDir, "directory", "package_rx");
    const ok = m.__TEST.loadWindowsNativeAddonEnforcingPackageAcl({
      packageRoot: tmp.root,
      platform: "win32",
      arch: "x64",
      nodeVersion: process.versions.node,
      expectedManifestSha256: pin,
    });
    assert(ok.status === "loaded", "enforcing load after package_rx");
  } finally {
    try { fs.rmSync(tmp.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

await check("temp package manifest byte tamper → hash fail", () => {
  const tmp = makeTempPackageFromLive("manifest-tamper");
  try {
    const original = fs.readFileSync(tmp.manifestPath);
    const pin = sha256(original);
    fs.writeFileSync(tmp.manifestPath, Buffer.concat([original, Buffer.from(" ")]));
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    const fresh = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
    const m = fresh(loaderPath);
    expectFail(
      () => m.__TEST.loadWindowsNativeAddon({
        packageRoot: tmp.root,
        platform: "win32",
        arch: "x64",
        nodeVersion: process.versions.node,
        expectedManifestSha256: pin,
      }),
      "WINDOWS_NATIVE_ADDON_MANIFEST_HASH_MISMATCH",
    );
  } finally {
    try { fs.rmSync(tmp.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

await check("temp package binary byte tamper → hash fail", () => {
  const tmp = makeTempPackageFromLive("binary-tamper");
  try {
    const manifestBytes = fs.readFileSync(tmp.manifestPath);
    const pin = sha256(manifestBytes);
    const original = fs.readFileSync(tmp.binaryPath);
    const dirty = Buffer.from(original);
    dirty[0] = dirty[0] ^ 0xff;
    fs.writeFileSync(tmp.binaryPath, dirty);
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    const fresh = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
    const m = fresh(loaderPath);
    expectFail(
      () => m.__TEST.loadWindowsNativeAddon({
        packageRoot: tmp.root,
        platform: "win32",
        arch: "x64",
        nodeVersion: process.versions.node,
        expectedManifestSha256: pin,
      }),
      "WINDOWS_NATIVE_ADDON_BINARY_HASH_MISMATCH",
    );
  } finally {
    try { fs.rmSync(tmp.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

await check("temp package missing binary fail", () => {
  const tmp = makeTempPackageFromLive("missing-binary");
  try {
    const pin = sha256(fs.readFileSync(tmp.manifestPath));
    fs.unlinkSync(tmp.binaryPath);
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    const fresh = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
    const m = fresh(loaderPath);
    expectFail(
      () => m.__TEST.loadWindowsNativeAddon({
        packageRoot: tmp.root,
        platform: "win32",
        arch: "x64",
        nodeVersion: process.versions.node,
        expectedManifestSha256: pin,
      }),
      "WINDOWS_NATIVE_ADDON_BINARY_MISSING",
    );
  } finally {
    try { fs.rmSync(tmp.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

await check("unlock → install roundtrip (live ACL only)", () => {
  const u = runPackageCmd("unlock");
  assert(u.status === 0, `unlock failed: ${u.stderr}\n${u.stdout}`);
  const unlockJson = JSON.parse(u.stdout);
  assert(unlockJson.status === "unlocked", "unlock status");
  assert(unlockJson.method === "native_private_rw" || unlockJson.method === "icacls_reset", "unlock method closed set");
  const i = runPackageCmd("install");
  assert(i.status === 0, `install failed: ${i.stderr}\n${i.stdout}`);
  const v = runPackageCmd("verify");
  assert(v.status === 0, `verify failed: ${v.stderr}\n${v.stdout}`);
  const evidence = JSON.parse(v.stdout);
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

// Final restore guarantee.
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
console.log(`\nOK: ${passed} checks passed`);
void sha256;
