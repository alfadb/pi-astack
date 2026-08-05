#!/usr/bin/env node
/**
 * Deterministic Windows native production package plumbing.
 *
 * Commands:
 *   package  — stage production .node + exact manifest LF bytes + rewrite pin.ts
 *   install  — verify pin/manifest/hash/self-identity, set package_rx, reverify
 *   unlock   — restore private_rw (prefer native; icacls.exe fallback), check writable
 *   verify   — production zero-arg load + package_rx three-point; bounded JSON evidence
 *
 * Never downloads or compiles. package only accepts clean production build-info with
 * build_mode=production, reproducibility=dual_clean_match, native_tests=passed,
 * clippy=passed, and binary self-identity exact match on those fields.
 * Pin + package artifacts are package outputs — not source-closure inputs.
 * No PowerShell hot path.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const packageDirRel = "native/windows/win32-x64";
const binaryName = "pi-astack-windows-native.node";
const packageDir = path.join(repoRoot, ...packageDirRel.split("/"));
const binaryPath = path.join(packageDir, binaryName);
const manifestPath = path.join(packageDir, "manifest.json");
const pinPath = path.join(repoRoot, "extensions", "_shared", "windows-native-addon-pin.ts");
const stagedNode = path.join(repoRoot, "native", "windows", "target", "smoke-staging", binaryName);
const buildInfoPath = path.join(repoRoot, "native", "windows", "target", "smoke-staging", "build-info.json");
const CAPABILITIES = [
  "atomic_file_tempdir_v1",
  "atomic_file_v1",
  "protected_dacl_v1",
  "retained_directory_lock_v1",
];
const MANIFEST_KEYS = [
  "schema_version",
  "addon_abi",
  "platform",
  "arch",
  "napi_version",
  "minimum_node",
  "source_commit",
  "source_tree_sha256",
  "toolchain",
  "toolchain_id",
  "target",
  "binary_file",
  "binary_bytes",
  "binary_sha256",
  "build_id",
  "build_mode",
  "reproducibility",
  "native_tests",
  "clippy",
  "build_config_sha256",
  "capabilities",
];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA1 = /^[0-9a-f]{40}$/;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

const require = createRequire(import.meta.url);

function die(msg, code = 1) {
  console.error(`package-windows-native-addon: ${msg}`);
  process.exit(code);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function usage() {
  console.log(`Usage: node scripts/package-windows-native-addon.mjs <package|install|unlock|verify>`);
  process.exit(2);
}

function loadNativeModule() {
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  const { createJiti } = require("jiti");
  const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
  return jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));
}

/** Exact manifest/v1 LF raw bytes (2-space indent, trailing newline, no CR). */
function serializeManifestV1(manifest) {
  const ordered = {};
  for (const key of MANIFEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(manifest, key)) {
      die(`manifest missing required key for serialization: ${key}`);
    }
    ordered[key] = manifest[key];
  }
  const extra = Object.keys(manifest).filter((k) => !MANIFEST_KEYS.includes(k));
  if (extra.length) die(`manifest has foreign keys: ${extra.join(",")}`);
  const text = `${JSON.stringify(ordered, null, 2)}\n`;
  if (text.includes("\r")) die("manifest serialization must be LF-only");
  return Buffer.from(text, "utf8");
}

function pinTsSource(manifestSha256, sourceCommit) {
  const pinVal =
    manifestSha256 == null ? "null" : JSON.stringify(manifestSha256);
  const commitVal =
    sourceCommit == null ? "null" : JSON.stringify(sourceCommit);
  // Strict template — package command overwrites this whole file.
  return [
    "/**",
    " * GENERATED provenance pin for the package-relative Windows native addon.",
    " *",
    " * Written only by `scripts/package-windows-native-addon.mjs` (package command).",
    " * Initial / absent values are null — production zero-arg load fails closed.",
    " *",
    " * NOT part of the native build source closure. Package artifacts (pin, manifest,",
    " * .node under native/windows/win32-x64/) are build/package outputs and must never",
    " * enter source_tree_sha256. Do not hand-edit production values; re-run package.",
    " */",
    `export const WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256: string | null = ${pinVal};`,
    `export const WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT: string | null = ${commitVal};`,
    "",
  ].join("\n");
}

function readBuildInfo() {
  if (!fs.existsSync(buildInfoPath)) {
    die(`missing build-info at ${buildInfoPath}; run build:windows-native-addon first (production mode)`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  } catch (error) {
    die(`build-info is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  return raw;
}

function assertProductionBuildInfo(info) {
  const buildMode = info.build_mode ?? info.mode;
  if (buildMode !== "production") {
    die(`package only accepts build_mode=production (got ${JSON.stringify(buildMode)})`);
  }
  if (info.development_only !== false) {
    die(`package requires development_only=false (got ${JSON.stringify(info.development_only)})`);
  }
  if (info.dirty_tree !== false) {
    die(`package requires dirty_tree=false (got ${JSON.stringify(info.dirty_tree)})`);
  }
  if (info.reproducibility !== "dual_clean_match") {
    die(`package requires reproducibility=dual_clean_match (got ${JSON.stringify(info.reproducibility)})`);
  }
  if (info.native_tests !== "passed") {
    die(`package requires native_tests=passed (got ${JSON.stringify(info.native_tests)})`);
  }
  if (info.clippy !== "passed") {
    die(`package requires clippy=passed (got ${JSON.stringify(info.clippy)})`);
  }
  if (!info.repro || info.repro.skipped === true || info.repro.matched !== true) {
    die("package requires repro passed (not skipped, matched=true)");
  }
  if (!GIT_SHA1.test(String(info.source_commit || ""))) {
    die("build-info source_commit must be 40-char lowercase git sha1");
  }
  if (!SHA256_HEX.test(String(info.source_tree_sha256 || ""))) {
    die("build-info source_tree_sha256 must be lowercase sha256 hex");
  }
  if (!SHA256_HEX.test(String(info.toolchain_id || ""))) {
    die("build-info toolchain_id must be lowercase sha256 hex");
  }
  if (!SHA256_HEX.test(String(info.build_id || ""))) {
    die("build-info build_id must be lowercase sha256 hex");
  }
  if (!SHA256_HEX.test(String(info.binary_sha256 || ""))) {
    die("build-info binary_sha256 must be lowercase sha256 hex");
  }
  if (!SHA256_HEX.test(String(info.build_config_sha256 || ""))) {
    die("build-info build_config_sha256 must be lowercase sha256 hex");
  }
  if (!SHA256_HEX.test(String(info.build_id_preimage_sha256 || ""))) {
    die("build-info build_id_preimage_sha256 must be lowercase sha256 hex");
  }
  if (info.build_id_preimage_sha256 !== info.build_id) {
    die("build-info build_id must equal build_id_preimage_sha256 (sha of preimage)");
  }
  // Optional cross-check: recompute preimage sha when fields are present.
  if (info.build_id_preimage_fields && typeof info.build_id_preimage_fields === "object") {
    const f = info.build_id_preimage_fields;
    const preimage = [
      `source_commit=${f.source_commit}`,
      `source_tree_sha256=${f.source_tree_sha256}`,
      `toolchain_id=${f.toolchain_id}`,
      `target=${f.target}`,
      `addon_abi=${f.addon_abi}`,
      `capabilities=${Array.isArray(f.capabilities) ? f.capabilities.join(",") : f.capabilities}`,
      `build_mode=${f.build_mode}`,
      `reproducibility=${f.reproducibility}`,
      `native_tests=${f.native_tests}`,
      `clippy=${f.clippy}`,
      `build_config_sha256=${f.build_config_sha256}`,
      `stripped_env_keys=${Array.isArray(f.stripped_env_keys) ? f.stripped_env_keys.join(",") : f.stripped_env_keys}`,
    ].join("\n") + "\n";
    const recomputed = sha256(Buffer.from(preimage, "utf8"));
    if (recomputed !== info.build_id_preimage_sha256) {
      die(`build-info build_id_preimage_sha256 cross-check failed: ${recomputed} != ${info.build_id_preimage_sha256}`);
    }
  }
  // Static hygiene: toolchain components must not smuggle path/locale into id inputs.
  const comps = info.toolchain_components || {};
  if (Object.prototype.hasOwnProperty.call(comps, "cargo_home")
    || Object.prototype.hasOwnProperty.call(comps, "rustup_home")
    || Object.prototype.hasOwnProperty.call(comps, "cl_banner")
    || Object.prototype.hasOwnProperty.call(comps, "link_banner")) {
    die("build-info toolchain_components must not carry cargo_home/rustup_home/cl_banner/link_banner (path/locale)");
  }
}

function closedEacces(label, error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return `${label}: path not writable (EACCES/EPERM). Run unlock first if package_rx is installed.`;
  }
  return `${label}: ${error instanceof Error ? error.message : error}`;
}

function assertWritable(filePath, label) {
  try {
    const fd = fs.openSync(filePath, "r+");
    fs.closeSync(fd);
  } catch (error) {
    // Missing is ok for package first write of some paths; caller decides.
    if (error && error.code === "ENOENT") return;
    die(closedEacces(label, error));
  }
}

/** Directory create/delete writability probe before package writes. */
function probePackageDirWritability() {
  fs.mkdirSync(packageDir, { recursive: true });
  const probe = path.join(packageDir, `.pi-astack-package-write-probe.${process.pid}`);
  try {
    fs.writeFileSync(probe, "probe\n", "utf8");
    fs.unlinkSync(probe);
  } catch (error) {
    try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch { /* ignore */ }
    die(closedEacces("package directory writability probe failed", error));
  }
}

function restorePinOrNull(previousPinSource) {
  try {
    if (previousPinSource != null) {
      fs.writeFileSync(pinPath, previousPinSource, "utf8");
    } else {
      fs.writeFileSync(pinPath, pinTsSource(null, null), "utf8");
    }
  } catch (error) {
    // Last-resort fail-closed: try null pin even if prior restore failed.
    try {
      fs.writeFileSync(pinPath, pinTsSource(null, null), "utf8");
    } catch {
      console.error(`package-windows-native-addon: CRITICAL: could not restore pin after failed package: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function cmdPackage() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    die("package requires win32-x64 host");
  }
  const info = readBuildInfo();
  assertProductionBuildInfo(info);
  if (!fs.existsSync(stagedNode)) {
    die(`missing staged binary ${stagedNode}`);
  }
  const binaryBytes = fs.readFileSync(stagedNode);
  if (binaryBytes.byteLength > MAX_BINARY_BYTES) {
    die(`package binary exceeds 64 MiB hard ceiling (${binaryBytes.byteLength} bytes)`);
  }
  if (binaryBytes.byteLength !== info.binary_bytes) {
    die(`staged binary size ${binaryBytes.byteLength} != build-info.binary_bytes ${info.binary_bytes}`);
  }
  const binaryHash = sha256(binaryBytes);
  if (binaryHash !== info.binary_sha256) {
    die(`staged binary hash ${binaryHash} != build-info.binary_sha256 ${info.binary_sha256}`);
  }

  probePackageDirWritability();
  if (fs.existsSync(binaryPath)) assertWritable(binaryPath, "package binary");
  if (fs.existsSync(manifestPath)) assertWritable(manifestPath, "package manifest");
  assertWritable(pinPath, "pin.ts");

  let previousPinSource = null;
  let previousManifest = null;
  let previousBinary = null;
  try {
    if (fs.existsSync(pinPath)) previousPinSource = fs.readFileSync(pinPath, "utf8");
    if (fs.existsSync(manifestPath)) previousManifest = fs.readFileSync(manifestPath);
    if (fs.existsSync(binaryPath)) previousBinary = fs.readFileSync(binaryPath);
  } catch (error) {
    die(closedEacces("failed to snapshot prior package artifacts", error));
  }

  const manifest = {
    schema_version: "windows-native-addon-manifest/v1",
    addon_abi: 1,
    platform: "win32",
    arch: "x64",
    napi_version: 9,
    minimum_node: "22.19.0",
    source_commit: info.source_commit,
    source_tree_sha256: info.source_tree_sha256,
    toolchain: String(info.toolchain || "cargo+msvc").slice(0, 256),
    toolchain_id: info.toolchain_id,
    target: "win32-x64",
    binary_file: binaryName,
    binary_bytes: binaryBytes.byteLength,
    binary_sha256: binaryHash,
    build_id: info.build_id,
    build_mode: "production",
    reproducibility: "dual_clean_match",
    native_tests: "passed",
    clippy: "passed",
    build_config_sha256: info.build_config_sha256,
    capabilities: [...CAPABILITIES],
  };
  const manifestBytes = serializeManifestV1(manifest);
  const manifestSha256 = sha256(manifestBytes);

  try {
    // Copy staging .node to fixed package path (no compile/download).
    fs.writeFileSync(binaryPath, binaryBytes);
    fs.writeFileSync(manifestPath, manifestBytes);

    const pinSource = pinTsSource(manifestSha256, info.source_commit);
    if (pinSource.includes("\r")) die("pin.ts template must be LF-only");
    fs.writeFileSync(pinPath, pinSource, "utf8");

    // Post-package identity via test loader (no package_rx enforce; install owns ACL).
    const mod = loadNativeModule();
    if (mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 !== manifestSha256) {
      throw new Error("pin rewrite did not surface expected manifest sha256 via loader import");
    }
    if (mod.WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT !== info.source_commit) {
      throw new Error("pin rewrite did not surface expected source commit via loader import");
    }
    const loaded = mod.__TEST.loadWindowsNativeAddon({
      packageRoot: repoRoot,
      platform: "win32",
      arch: "x64",
      nodeVersion: process.versions.node,
      expectedManifestSha256: manifestSha256,
    });
    if (loaded.manifest.binary_sha256 !== binaryHash) {
      throw new Error("post-package binary identity mismatch");
    }
    if (loaded.identity.build_id !== info.build_id
      || loaded.identity.source_commit !== info.source_commit
      || loaded.identity.toolchain_id !== info.toolchain_id
      || loaded.identity.build_mode !== "production"
      || loaded.identity.reproducibility !== "dual_clean_match"
      || loaded.identity.native_tests !== "passed"
      || loaded.identity.clippy !== "passed"
      || loaded.identity.build_config_sha256 !== info.build_config_sha256) {
      throw new Error("post-package self-identity mismatch vs build-info evidence fields");
    }
    if (loaded.manifest.build_mode !== "production"
      || loaded.manifest.reproducibility !== "dual_clean_match"
      || loaded.manifest.native_tests !== "passed"
      || loaded.manifest.clippy !== "passed"
      || loaded.manifest.build_config_sha256 !== info.build_config_sha256) {
      throw new Error("post-package manifest evidence fields mismatch");
    }
  } catch (error) {
    // Fail closed: restore prior pin/manifest/binary, or at least pin→null so new pin never points at a bad package.
    try {
      if (previousBinary != null) fs.writeFileSync(binaryPath, previousBinary);
      else if (fs.existsSync(binaryPath)) fs.unlinkSync(binaryPath);
    } catch { /* best-effort */ }
    try {
      if (previousManifest != null) fs.writeFileSync(manifestPath, previousManifest);
      else if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    } catch { /* best-effort */ }
    restorePinOrNull(previousPinSource);
    die(`post-package verification failed (restored prior pin/artifacts or pin=null): ${error instanceof Error ? error.message : error}`);
  }

  console.log(JSON.stringify({
    status: "packaged",
    manifest_sha256: manifestSha256,
    binary_sha256: binaryHash,
    binary_bytes: binaryBytes.byteLength,
    source_commit: info.source_commit,
    build_id: info.build_id,
    build_id_preimage_sha256: info.build_id_preimage_sha256,
    toolchain_id: info.toolchain_id,
    build_mode: "production",
    reproducibility: "dual_clean_match",
    native_tests: "passed",
    clippy: "passed",
    build_config_sha256: info.build_config_sha256,
    note: "ACL not applied; run install next. Production pin written (not null).",
  }, null, 2));
}

/**
 * Load installed package for ACL ops. Throws (never die/process.exit) so callers'
 * catch can fall back (unlock icacls / install fail closed).
 */
function loadInstalledForAcl() {
  const mod = loadNativeModule();
  const pin = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256;
  if (pin == null || !SHA256_HEX.test(pin)) {
    throw new Error("install/unlock requires non-null production pin (run package first)");
  }
  if (!fs.existsSync(manifestPath) || !fs.existsSync(binaryPath)) {
    throw new Error("package binary/manifest missing under native/windows/win32-x64");
  }
  const loaded = mod.__TEST.loadWindowsNativeAddon({
    packageRoot: repoRoot,
    platform: "win32",
    arch: "x64",
    nodeVersion: process.versions.node,
    expectedManifestSha256: pin,
  });
  return { mod, loaded, pin };
}

function cmdInstall() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    die("install requires win32-x64 host");
  }
  let loaded;
  try {
    ({ loaded } = loadInstalledForAcl());
  } catch (error) {
    die(`install precheck failed (not claiming installed): ${error instanceof Error ? error.message : error}`);
  }
  const addon = loaded.addon;
  const applied = [];
  try {
    // files first, then directory (exact package_rx).
    addon.setProtectedPath(manifestPath, "file", "package_rx");
    applied.push(["file", manifestPath]);
    addon.setProtectedPath(binaryPath, "file", "package_rx");
    applied.push(["file", binaryPath]);
    addon.setProtectedPath(packageDir, "directory", "package_rx");
    applied.push(["directory", packageDir]);
    addon.verifyProtectedPath(manifestPath, "file", "package_rx");
    addon.verifyProtectedPath(binaryPath, "file", "package_rx");
    addon.verifyProtectedPath(packageDir, "directory", "package_rx");
  } catch (error) {
    // Best-effort rollback toward private_rw so the tree is not left half-package_rx.
    for (const [kind, p] of [...applied].reverse()) {
      try {
        addon.setProtectedPath(p, kind, "private_rw");
      } catch {
        /* ignore */
      }
    }
    console.error("package-windows-native-addon: install ACL partial failure — best-effort private_rw unlock attempted; not claiming installed");
    die(`install ACL apply/reverify failed (not claiming installed): ${error instanceof Error ? error.message : error}`);
  }

  // Production zero-arg load must now succeed including package_rx gate.
  const mod = loadNativeModule();
  let prod;
  try {
    const prev = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    try {
      prod = mod.loadWindowsNativeAddon();
    } finally {
      if (prev !== undefined) process.env.PI_ASTACK_ENABLE_TEST_HOOKS = prev;
      else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    }
  } catch (error) {
    // Best-effort unlock so a bad ACL state is not left claimed-installed.
    try {
      addon.setProtectedPath(packageDir, "directory", "private_rw");
      addon.setProtectedPath(manifestPath, "file", "private_rw");
      addon.setProtectedPath(binaryPath, "file", "private_rw");
    } catch {
      console.error("package-windows-native-addon: install production reverify failed and private_rw unlock also failed; manual unlock may be required");
    }
    die(`install production load reverify failed (not claiming installed): ${error instanceof Error ? error.message : error}`);
  }
  console.log(JSON.stringify({
    status: "installed",
    manifest_sha256: mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256,
    binary_sha256: prod.manifest.binary_sha256,
    build_id: prod.identity.build_id,
    source_commit: prod.identity.source_commit,
    toolchain_id: prod.identity.toolchain_id,
    build_mode: prod.identity.build_mode,
    reproducibility: prod.identity.reproducibility,
    native_tests: prod.identity.native_tests,
    clippy: prod.identity.clippy,
    build_config_sha256: prod.identity.build_config_sha256,
    capabilities: [...prod.capabilities],
    package_rx: { directory: true, binary: true, manifest: true },
  }, null, 2));
}

function fixedIcaclsPath() {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.join(root, "System32", "icacls.exe");
}

function cmdUnlock() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    die("unlock requires win32-x64 host");
  }
  let usedNative = false;
  let method = "icacls_reset";
  try {
    const { loaded } = loadInstalledForAcl();
    const addon = loaded.addon;
    // dir first, then files → private_rw
    addon.setProtectedPath(packageDir, "directory", "private_rw");
    addon.setProtectedPath(manifestPath, "file", "private_rw");
    addon.setProtectedPath(binaryPath, "file", "private_rw");
    addon.verifyProtectedPath(packageDir, "directory", "private_rw");
    addon.verifyProtectedPath(manifestPath, "file", "private_rw");
    addon.verifyProtectedPath(binaryPath, "file", "private_rw");
    usedNative = true;
    method = "native_private_rw";
  } catch (error) {
    // Fallback when no pin / bad binary / missing DLL: fixed System32 icacls.exe reset.
    // Catch works because loadInstalledForAcl throws (never process.exit).
    const icacls = fixedIcaclsPath();
    if (!fs.existsSync(icacls)) {
      die(`native unlock failed and fixed icacls missing: ${icacls}; cause: ${error instanceof Error ? error.message : error}`);
    }
    if (!fs.existsSync(packageDir)) {
      die(`package directory missing: cannot unlock; cause: ${error instanceof Error ? error.message : error}`);
    }
    const r = spawnSync(icacls, [packageDir, "/reset", "/T", "/C", "/Q"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.error) die(`icacls spawn failed: ${r.error.message}`);
    if (r.status !== 0) {
      // Do not parse localized stdout/stderr — exit code only.
      die(`icacls reset failed with exit ${r.status}`);
    }
    method = "icacls_reset";
  }

  // Verify writable (no auto download/compile).
  for (const [p, label] of [
    [binaryPath, "binary"],
    [manifestPath, "manifest"],
    [pinPath, "pin.ts"],
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      const fd = fs.openSync(p, "r+");
      fs.closeSync(fd);
    } catch (error) {
      die(`unlock did not restore writability for ${label}: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(JSON.stringify({
    status: "unlocked",
    method,
    writable: true,
    used_native: usedNative,
  }, null, 2));
}

function cmdVerify() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    die("verify requires win32-x64 host");
  }
  const mod = loadNativeModule();
  const pin = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256;
  const sourcePin = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT;
  if (pin == null || !SHA256_HEX.test(pin)) {
    die("verify requires non-null production pin");
  }
  if (sourcePin == null || !GIT_SHA1.test(sourcePin)) {
    die("verify requires non-null 40-hex production source commit pin");
  }
  const prev = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  let loaded;
  try {
    loaded = mod.loadWindowsNativeAddon();
  } catch (error) {
    die(`production zero-arg load failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    if (prev !== undefined) process.env.PI_ASTACK_ENABLE_TEST_HOOKS = prev;
    else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  }

  if (loaded.identity.source_commit !== sourcePin) {
    die("verify: identity.source_commit does not match PIN_SOURCE_COMMIT");
  }

  // Native package_rx three-point (already done inside production load; re-emit profile pass only).
  try {
    loaded.addon.verifyProtectedPath(packageDir, "directory", "package_rx");
    loaded.addon.verifyProtectedPath(binaryPath, "file", "package_rx");
    loaded.addon.verifyProtectedPath(manifestPath, "file", "package_rx");
  } catch (error) {
    die(`package_rx reverify failed: ${error instanceof Error ? error.message : error}`);
  }

  // Bounded JSON evidence — no path/SID raw; profile pass only.
  console.log(JSON.stringify({
    status: "verified",
    manifest_sha256: pin,
    binary_sha256: loaded.manifest.binary_sha256,
    binary_bytes: loaded.manifest.binary_bytes,
    build_id: loaded.identity.build_id,
    source_commit: loaded.identity.source_commit,
    source_tree_sha256: loaded.identity.source_tree_sha256,
    toolchain_id: loaded.identity.toolchain_id,
    toolchain: loaded.manifest.toolchain,
    build_mode: loaded.identity.build_mode,
    reproducibility: loaded.identity.reproducibility,
    native_tests: loaded.identity.native_tests,
    clippy: loaded.identity.clippy,
    build_config_sha256: loaded.identity.build_config_sha256,
    capabilities: [...loaded.capabilities],
    package_rx: {
      directory: "pass",
      binary: "pass",
      manifest: "pass",
    },
  }, null, 2));
}

function main() {
  const cmd = process.argv[2];
  if (!cmd) usage();
  switch (cmd) {
    case "package":
      cmdPackage();
      break;
    case "install":
      cmdInstall();
      break;
    case "unlock":
      cmdUnlock();
      break;
    case "verify":
      cmdVerify();
      break;
    default:
      usage();
  }
}

main();
