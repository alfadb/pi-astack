#!/usr/bin/env node
/**
 * Deterministic smoke for Windows native addon frozen ABI v1 loader/manifest/capabilities.
 *
 * Uses a temp package root + explicit __TEST seams only for fixture suites.
 * Production pin may be null (fail-closed) or live (post-pin). Live production
 * zero-arg load is verified only in a closed child so the controller never maps
 * the live package image. Temp fixture suites stay independent and are never
 * labeled production. Does not touch ~/.abrain.
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

// Closed production-zeroarg child: no test hooks, controller never maps live .node.
if (process.argv[2] === "--worker" && process.argv[3] === "prod-zeroarg") {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== undefined) {
    process.stderr.write("prod-zeroarg worker must not see PI_ASTACK_ENABLE_TEST_HOOKS\n");
    process.exit(2);
  }
  try {
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error(`prod-zeroarg requires win32-x64, got ${process.platform}/${process.arch}`);
    }
    const require = createRequire(import.meta.url);
    const { createJiti } = require("jiti");
    const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
    const m = jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));
    if (typeof m.__TEST !== "undefined" && process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== undefined) {
      throw new Error("prod-zeroarg must not enable test hooks");
    }
    const loaded = m.loadWindowsNativeAddon();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: loaded.status,
      build_mode: loaded.manifest?.build_mode,
      capabilities: [...(loaded.capabilities || [])],
      source_commit: loaded.manifest?.source_commit,
      pin: m.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256,
    })}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: err?.code || null,
      message: String(err?.message || err),
    })}\n`);
    process.exit(1);
  }
}

// Options loader + mutating __TEST helpers require test hooks.
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const mod = jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));

const {
  WINDOWS_NATIVE_ADDON_ABI,
  WINDOWS_NATIVE_ADDON_MANIFEST_SCHEMA_VERSION,
  WINDOWS_NATIVE_ADDON_MANIFEST_RELATIVE_PATH,
  WINDOWS_NATIVE_ADDON_BINARY_RELATIVE_PATH,
  WINDOWS_NATIVE_ADDON_BINARY_FILE,
  WINDOWS_NATIVE_ADDON_MINIMUM_NODE,
  WINDOWS_NATIVE_ADDON_NAPI_VERSION,
  WINDOWS_NATIVE_ADDON_TARGET,
  WINDOWS_NATIVE_ADDON_ERROR_CODES,
  WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256,
  WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT,
  WINDOWS_NATIVE_ADDON_INITIAL_CAPABILITIES,
  WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1,
  loadWindowsNativeAddon,
  validateWindowsNativeAddonManifest,
  validateWindowsNativeAddonCapabilities,
  tryAcquireRetainedDirectoryLock,
  resolveWindowsNativeAddonPaths,
  isNodeVersionAtLeast,
  __TEST,
} = mod;

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

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function expectCode(code, fn, messageIncludes) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert(caught, `expected ${code}, but operation succeeded`);
  assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  if (messageIncludes) {
    assert(String(caught.message || caught).includes(messageIncludes), `expected message to include ${messageIncludes}, got ${caught.message || caught}`);
  }
  return caught;
}

function tempPackageRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-win-native-${label}-`));
  const abrain = path.resolve(os.homedir(), ".abrain");
  assert(!root.startsWith(abrain + path.sep) && root !== abrain, `temp root must not be under ~/.abrain: ${root}`);
  return root;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function baseManifest(overrides = {}) {
  return {
    schema_version: WINDOWS_NATIVE_ADDON_MANIFEST_SCHEMA_VERSION,
    addon_abi: WINDOWS_NATIVE_ADDON_ABI,
    platform: "win32",
    arch: "x64",
    napi_version: WINDOWS_NATIVE_ADDON_NAPI_VERSION,
    minimum_node: WINDOWS_NATIVE_ADDON_MINIMUM_NODE,
    source_commit: "a".repeat(40),
    source_tree_sha256: "b".repeat(64),
    toolchain: "msvc-19.40+cargo (fixture)",
    toolchain_id: "d".repeat(64),
    target: WINDOWS_NATIVE_ADDON_TARGET,
    binary_file: WINDOWS_NATIVE_ADDON_BINARY_FILE,
    binary_bytes: 12,
    binary_sha256: "c".repeat(64),
    build_id: "fixture-build-001",
    build_mode: "development",
    reproducibility: "dual_clean_match",
    native_tests: "passed",
    clippy: "passed",
    build_config_sha256: "e".repeat(64),
    capabilities: [...WINDOWS_NATIVE_ADDON_INITIAL_CAPABILITIES],
    ...overrides,
  };
}

function writeFixturePackage(root, { binaryBytes = Buffer.from("fake-binary\n"), manifestOverrides = {} } = {}) {
  const paths = resolveWindowsNativeAddonPaths(root);
  fs.mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
  const manifest = baseManifest({
    binary_bytes: binaryBytes.byteLength,
    binary_sha256: sha256(binaryBytes),
    ...manifestOverrides,
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(paths.manifestPath, manifestText, "utf8");
  fs.writeFileSync(paths.binaryPath, binaryBytes);
  return {
    paths,
    manifest,
    binaryBytes,
    manifestBytes: Buffer.from(manifestText, "utf8"),
    manifestSha256: sha256(Buffer.from(manifestText, "utf8")),
  };
}

function toIdentity(st) {
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    isFile: () => st.isFile(),
  };
}

function realFsSeam(overrides = {}) {
  const ops = [];
  const base = {
    existsSync: (p) => {
      ops.push({ op: "existsSync", path: p });
      return fs.existsSync(p);
    },
    readFileSync: (p) => {
      ops.push({ op: "readFileSync", path: p });
      return fs.readFileSync(p);
    },
    statSync: (p) => {
      ops.push({ op: "statSync", path: p });
      return toIdentity(fs.statSync(p));
    },
    lstatSync: (p) => {
      ops.push({ op: "lstatSync", path: p });
      const st = fs.lstatSync(p);
      return {
        size: st.size,
        isSymbolicLink: () => st.isSymbolicLink(),
        isFile: () => st.isFile(),
      };
    },
    realpathSync: (p) => {
      ops.push({ op: "realpathSync", path: p });
      return fs.realpathSync(p);
    },
    openSync: (p, flags) => {
      ops.push({ op: "openSync", path: p, flags });
      return fs.openSync(p, flags);
    },
    fstatSync: (fd) => {
      ops.push({ op: "fstatSync", fd });
      return toIdentity(fs.fstatSync(fd));
    },
    readFileFdSync: (fd) => {
      ops.push({ op: "readFileFdSync", fd });
      const st = fs.fstatSync(fd);
      const buf = Buffer.allocUnsafe(st.size);
      let offset = 0;
      while (offset < st.size) {
        const n = fs.readSync(fd, buf, offset, st.size - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      return buf.subarray(0, offset);
    },
    closeSync: (fd) => {
      ops.push({ op: "closeSync", fd });
      fs.closeSync(fd);
    },
    ...overrides,
  };
  return { fs: base, ops };
}

function matchingFakeAddon(manifest, identityOverrides = {}, optionOverrides = {}) {
  const identity = {
    addon_abi: WINDOWS_NATIVE_ADDON_ABI,
    build_id: manifest.build_id,
    source_commit: manifest.source_commit,
    source_tree_sha256: manifest.source_tree_sha256,
    toolchain_id: manifest.toolchain_id,
    platform: "win32",
    arch: "x64",
    napi_version: WINDOWS_NATIVE_ADDON_NAPI_VERSION,
    target: WINDOWS_NATIVE_ADDON_TARGET,
    build_mode: manifest.build_mode,
    reproducibility: manifest.reproducibility,
    native_tests: manifest.native_tests,
    clippy: manifest.clippy,
    build_config_sha256: manifest.build_config_sha256,
    ...identityOverrides,
  };
  const capabilities = optionOverrides.capabilities ?? [...(manifest.capabilities || WINDOWS_NATIVE_ADDON_INITIAL_CAPABILITIES)];
  return {
    addon_abi: identity.addon_abi,
    getBuildIdentity() {
      return { ...identity };
    },
    getCapabilities() {
      return [...capabilities];
    },
    tryAcquireRetainedDirectoryLock() {
      if (optionOverrides.lockImpl) return optionOverrides.lockImpl();
      return null;
    },
  };
}

function loadWin(opts) {
  return __TEST.loadWindowsNativeAddon({
    platform: "win32",
    arch: "x64",
    nodeVersion: "22.19.0",
    ...opts,
  });
}

const EXPECTED_ERROR_CODES = [
  "WINDOWS_NATIVE_ADDON_UNSUPPORTED_PLATFORM",
  "WINDOWS_NATIVE_ADDON_NODE_VERSION_UNSUPPORTED",
  "WINDOWS_NATIVE_ADDON_ARCH_MISMATCH",
  "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING",
  "WINDOWS_NATIVE_ADDON_MANIFEST_MISSING",
  "WINDOWS_NATIVE_ADDON_MANIFEST_INVALID",
  "WINDOWS_NATIVE_ADDON_MANIFEST_HASH_MISMATCH",
  "WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED",
  "WINDOWS_NATIVE_ADDON_BINARY_MISSING",
  "WINDOWS_NATIVE_ADDON_BINARY_SIZE_MISMATCH",
  "WINDOWS_NATIVE_ADDON_BINARY_HASH_MISMATCH",
  "WINDOWS_NATIVE_ADDON_BINARY_MUTATED",
  "WINDOWS_NATIVE_ADDON_ABI_MISMATCH",
  "WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH",
  "WINDOWS_NATIVE_ADDON_NAPI_MISMATCH",
  "WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH",
  "WINDOWS_NATIVE_ADDON_CAPABILITY_UNADVERTISED",
  "WINDOWS_NATIVE_ADDON_LOAD_FAILED",
  "WINDOWS_NATIVE_ADDON_INVALID_PATH",
  "WINDOWS_NATIVE_ADDON_ANCESTOR_REPARSE",
  "WINDOWS_NATIVE_ADDON_REPARSE",
  "WINDOWS_NATIVE_ADDON_UNSUPPORTED_VOLUME",
  "WINDOWS_NATIVE_ADDON_NOT_DIRECTORY",
  "WINDOWS_NATIVE_ADDON_NOT_FOUND",
  "WINDOWS_NATIVE_ADDON_ACCESS_DENIED",
  "WINDOWS_NATIVE_ADDON_IDENTITY_CHANGED",
  "WINDOWS_NATIVE_ADDON_MUTEX_FAILED",
  "WINDOWS_NATIVE_ADDON_MUTEX_NAMESPACE_DENIED",
  "WINDOWS_NATIVE_ADDON_DACL_INVALID",
  "WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID",
  "WINDOWS_NATIVE_ADDON_WRONG_THREAD",
  "WINDOWS_NATIVE_ADDON_CLOSED",
  "WINDOWS_NATIVE_ADDON_NOT_FILE",
  "WINDOWS_NATIVE_ADDON_INVALID_PROFILE",
  "WINDOWS_NATIVE_ADDON_INVALID_KIND",
  "WINDOWS_NATIVE_ADDON_IO_FAILED",
  "WINDOWS_NATIVE_ADDON_TOO_LARGE",
  "WINDOWS_NATIVE_ADDON_BUSY",
  "WINDOWS_NATIVE_ADDON_FAILED",
];

console.log("Windows native addon frozen ABI v1 smoke");
assert(WINDOWS_NATIVE_ADDON_ABI === 1, "frozen ABI is 1");
assert(
  WINDOWS_NATIVE_ADDON_MANIFEST_SCHEMA_VERSION === "windows-native-addon-manifest/v1",
  "schema version v1",
);
const EXPECTED_KNOWN_CAPABILITIES = [
  "atomic_file_tempdir_v1",
  "atomic_file_v1",
  "protected_dacl_v1",
  "retained_directory_lock_v1",
];
assert(
  JSON.stringify([...WINDOWS_NATIVE_ADDON_INITIAL_CAPABILITIES]) === JSON.stringify(EXPECTED_KNOWN_CAPABILITIES),
  "known capabilities sorted set",
);
assert(WINDOWS_NATIVE_ADDON_CAPABILITY_RETAINED_DIRECTORY_LOCK_V1 === "retained_directory_lock_v1", "lock capability id");
const PIN_LIVE =
  typeof WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 === "string"
  && /^[0-9a-f]{64}$/.test(WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256)
  && typeof WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT === "string"
  && /^[0-9a-f]{40}$/.test(WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT);
const PIN_ABSENT =
  WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 === null
  && WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT === null;
assert(
  PIN_ABSENT || PIN_LIVE,
  `production pin must be both-null or live sha256+source, got manifest=${WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256} source=${WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT}`,
);
assert(loadWindowsNativeAddon.length === 0, "production loadWindowsNativeAddon arity must be 0");
assert(
  JSON.stringify([...WINDOWS_NATIVE_ADDON_ERROR_CODES]) === JSON.stringify(EXPECTED_ERROR_CODES),
  `error code closed set exact match; got ${JSON.stringify(WINDOWS_NATIVE_ADDON_ERROR_CODES)}`,
);
assert(WINDOWS_NATIVE_ADDON_MANIFEST_RELATIVE_PATH === "native/windows/win32-x64/manifest.json", "fixed manifest relative path");
assert(WINDOWS_NATIVE_ADDON_BINARY_RELATIVE_PATH === "native/windows/win32-x64/pi-astack-windows-native.node", "fixed binary relative path");
console.log("  ok    constants + exact error-code set + production arity=0 + ABI v1 capabilities");
passed += 1;

// Source hygiene: production defaults must not read env for binary/manifest paths,
// must not implement runtime download / auto-compile, and __TEST is only referenced by smoke+module.
// process.env is allowed only for the PI_ASTACK_ENABLE_TEST_HOOKS gate on __TEST helpers.
{
  const srcPath = path.join(repoRoot, "extensions/_shared/windows-native-addon.ts");
  const src = fs.readFileSync(srcPath, "utf8");
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const envMatches = codeOnly.match(/process\.env(?:\.[A-Za-z0-9_]+|\[[^\]]+\])?/g) || [];
  for (const m of envMatches) {
    assert(
      m === "process.env.PI_ASTACK_ENABLE_TEST_HOOKS",
      `loader may only read PI_ASTACK_ENABLE_TEST_HOOKS from process.env, got ${m}`,
    );
  }
  assert(!/\b(?:fetch|https?\.get|axios|got|curl|wget)\b/i.test(codeOnly), "loader must not download binaries");
  assert(!/\b(?:node-gyp|cmake-js|prebuild-install|node-pre-gyp)\b/i.test(codeOnly), "loader must not auto-compile");
  assert(/\bexport function loadWindowsNativeAddon\(\)/.test(src), "production entry is zero-parameter");
  assert(!/\bexport function loadWindowsNativeAddon\([^)]+\)/.test(src), "production entry must not accept parameters");
  assert(/windows-native-addon-pin/.test(src), "loader must import pin module");
  assert(/WINDOWS_NATIVE_ADDON_PACKAGE_ACL_INVALID/.test(src), "loader must define PACKAGE_ACL_INVALID");
  assert(/enforcePackageAcl/.test(src), "production path must support package ACL enforce flag");

  // After-load same-fd rehash must exist and order: dlopen → rehash → identity → self identity.
  assert(/function assertSameFdBinaryHash\(/.test(src), "loader must define assertSameFdBinaryHash");
  const loadCall = codeOnly.indexOf("loadNativeModule(paths.binaryPath)");
  const rehashCall = codeOnly.indexOf("assertSameFdBinaryHash(");
  const afterIdCall = codeOnly.indexOf('assertBinaryIdentityUnchanged(io, fd, paths.binaryPath, preIdentity, "after-load")');
  const selfIdCall = codeOnly.indexOf("assertIdentityMatchesManifest(");
  assert(loadCall >= 0, "load flow must call loadNativeModule(paths.binaryPath)");
  assert(rehashCall > loadCall, "same-fd rehash must run after dlopen");
  assert(afterIdCall > rehashCall, "after-load identity must run after same-fd rehash");
  assert(selfIdCall > rehashCall, "self identity must run after same-fd rehash");
  assert(selfIdCall > afterIdCall, "self identity must run after after-load identity");

  // Grep __TEST references in code outside smoke + module itself (docs may describe the seam).
  const walkCode = (dir, acc = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "target") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkCode(full, acc);
      else if (/\.(ts|js|mjs|cjs)$/.test(ent.name)) acc.push(full);
    }
    return acc;
  };
  const allowedTestLoaders = new Set([
    "extensions/_shared/windows-native-addon.ts",
    "scripts/smoke-windows-native-addon.mjs",
    "scripts/smoke-windows-native-retained-lock.mjs",
    "scripts/smoke-windows-native-durable-dacl.mjs",
    "scripts/smoke-windows-native-package.mjs",
    "scripts/package-windows-native-addon.mjs",
    "scripts/smoke-retained-directory-lock.mjs",
    "scripts/smoke-dcc-windows-attestation.mjs",
    "scripts/smoke-proposition-policy-stable-view-windows.mjs",
    "scripts/smoke-dcc-worker-control.mjs",
    "scripts/smoke-edge-protocol-shadow-windows.mjs",
    "scripts/smoke-edge-protocol-shadow.mjs",
  ]);
  const strictOffenders = [];
  for (const file of walkCode(repoRoot)) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    if (allowedTestLoaders.has(rel)) continue;
    const text = fs.readFileSync(file, "utf8");
    // Only the windows-native-addon `__TEST.loadWindowsNativeAddon` seam is confined.
    // Production adapters may import the zero-arg loader and host their own gated test APIs.
    if (/\b__TEST\s*\.\s*loadWindowsNativeAddon\b/.test(text)) {
      strictOffenders.push(rel);
    }
  }
  assert(strictOffenders.length === 0, `__TEST referenced outside smoke/module: ${strictOffenders.join(", ")}`);
  console.log("  ok    source hygiene: no path env/download/auto-compile; production arity 0; __TEST confined; same-fd rehash order");
  passed += 1;
}

await check("__TEST.loadWindowsNativeAddon requires PI_ASTACK_ENABLE_TEST_HOOKS=1", () => {
  const prev = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  try {
    expectCode("WINDOWS_NATIVE_ADDON_FAILED", () => __TEST.loadWindowsNativeAddon({
      platform: "win32",
      arch: "x64",
      nodeVersion: "22.19.0",
      expectedManifestSha256: "a".repeat(64),
      loadNativeModule() {
        throw new Error("must not load without test hooks");
      },
    }), "PI_ASTACK_ENABLE_TEST_HOOKS=1");
  } finally {
    if (prev === undefined) process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = prev;
  }
});

await check("production pin absent fails closed before trusting on-disk manifest", () => {
  const root = tempPackageRoot("pin-missing");
  try {
    const { manifestSha256 } = writeFixturePackage(root);
    void manifestSha256;
    const tracked = realFsSeam();
    // Force pin-missing via explicit null so the closed path is covered both pre-pin
    // (module pin null) and post-pin (module pin live). No fs probe either way.
    expectCode("WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: null,
      fs: tracked.fs,
      loadNativeModule() {
        throw new Error("must not load without pin");
      },
    }));
    assert(tracked.ops.length === 0, `pin missing must not probe fs, got ${JSON.stringify(tracked.ops)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("PIN source field: production path requires SOURCE_COMMIT; test options exempt", () => {
  // Source contract: loader production pin path validates PIN_SOURCE_COMMIT non-null/40hex
  // and equals manifest.source_commit; options with expectedManifestSha256 do not.
  const src = fs.readFileSync(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"), "utf8");
  assert(/isProductionPinPath/.test(src), "loader must distinguish production pin path");
  assert(/PIN_SOURCE_COMMIT/.test(src), "loader must reference PIN_SOURCE_COMMIT");
  assert(/production source commit pin is absent/.test(src), "closed error for missing source commit pin");
  assert(/production source commit pin does not match manifest\.source_commit/.test(src), "closed error for source commit mismatch");
  assert(/options\.expectedManifestSha256 === undefined/.test(src), "production path = no expectedManifestSha256 override");
  // Test options path still loads with only expectedManifestSha256 (no source commit pin).
  const root = tempPackageRoot("pin-source-exempt");
  try {
    const { manifest, manifestSha256 } = writeFixturePackage(root);
    const result = loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        return matchingFakeAddon(manifest);
      },
    });
    assert(result.status === "loaded", "test options load without PIN_SOURCE_COMMIT");
    assert(result.manifest.source_commit === manifest.source_commit, "manifest source_commit");
    // Test options path is independent of module pin (null or live).
    assert(
      WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT === null
        || /^[0-9a-f]{40}$/.test(WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT),
      "module source pin null or live sha1",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("manifest raw-bytes pin mismatch fails closed before parse trust", () => {
  const root = tempPackageRoot("pin-mismatch");
  try {
    writeFixturePackage(root);
    expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_HASH_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: "e".repeat(64),
      loadNativeModule() {
        throw new Error("must not load on pin mismatch");
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("Linux platform is unsupported and performs zero binary/manifest probe", () => {
  const root = tempPackageRoot("linux");
  try {
    writeFixturePackage(root);
    const tracked = realFsSeam();
    expectCode("WINDOWS_NATIVE_ADDON_UNSUPPORTED_PLATFORM", () => __TEST.loadWindowsNativeAddon({
      platform: "linux",
      arch: "x64",
      nodeVersion: "22.19.0",
      packageRoot: root,
      expectedManifestSha256: "f".repeat(64),
      fs: tracked.fs,
      loadNativeModule() {
        throw new Error("loadNativeModule must not be called on linux");
      },
    }), "requires win32");
    assert(tracked.ops.length === 0, `expected zero fs ops on linux, got ${JSON.stringify(tracked.ops)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("darwin platform is unsupported with zero probe", () => {
  const root = tempPackageRoot("darwin");
  try {
    const tracked = realFsSeam();
    expectCode("WINDOWS_NATIVE_ADDON_UNSUPPORTED_PLATFORM", () => __TEST.loadWindowsNativeAddon({
      platform: "darwin",
      packageRoot: root,
      expectedManifestSha256: "f".repeat(64),
      fs: tracked.fs,
    }));
    assert(tracked.ops.length === 0, "darwin must not probe fs");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("real current-platform zero-arg production entry (pin-null fail-closed / pin-live child positive)", () => {
  const prevCwd = process.cwd();
  const empty = tempPackageRoot("prod-zero-arg");
  try {
    process.chdir(empty);
    if (process.platform === "win32") {
      if (process.arch !== "x64") {
        expectCode("WINDOWS_NATIVE_ADDON_ARCH_MISMATCH", () => loadWindowsNativeAddon());
      } else if (!isNodeVersionAtLeast(process.versions.node, WINDOWS_NATIVE_ADDON_MINIMUM_NODE)) {
        expectCode("WINDOWS_NATIVE_ADDON_NODE_VERSION_UNSUPPORTED", () => loadWindowsNativeAddon());
      } else if (!PIN_LIVE) {
        // Production pin null → fail closed before trusting any on-disk artifact (no dlopen).
        expectCode("WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING", () => loadWindowsNativeAddon());
      } else {
        // Pin live: never map live package in the controller. Closed child verifies zero-arg.
        const env = { ...process.env };
        delete env.PI_ASTACK_ENABLE_TEST_HOOKS;
        const r = spawnSync(process.execPath, [__filename, "--worker", "prod-zeroarg"], {
          cwd: repoRoot,
          encoding: "utf8",
          windowsHide: true,
          env,
        });
        assert(r.status === 0, `prod-zeroarg child exit ${r.status}: ${r.stderr}\n${r.stdout}`);
        const line = String(r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
        const json = JSON.parse(line);
        assert(json.ok === true && json.status === "loaded", `prod-zeroarg json ${line}`);
        assert(json.build_mode === "production", "child build_mode production");
        assert(Array.isArray(json.capabilities) && json.capabilities.includes("retained_directory_lock_v1"), "child caps");
        assert(json.source_commit === WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT, "child source_commit pin");
        assert(json.pin === WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256, "child pin");
      }
    } else {
      expectCode("WINDOWS_NATIVE_ADDON_UNSUPPORTED_PLATFORM", () => loadWindowsNativeAddon());
    }
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

await check("missing binary fails closed after valid pinned manifest", () => {
  const root = tempPackageRoot("missing-binary");
  try {
    const { paths, manifest, manifestSha256 } = writeFixturePackage(root);
    fs.rmSync(paths.binaryPath);
    expectCode("WINDOWS_NATIVE_ADDON_BINARY_MISSING", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        throw new Error("should not load");
      },
    }));
    validateWindowsNativeAddonManifest(manifest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("foreign/extra manifest keys fail closed", () => {
  const root = tempPackageRoot("foreign-manifest");
  try {
    const { paths } = writeFixturePackage(root);
    const bad = baseManifest({ extra_field: "nope" });
    const text = `${JSON.stringify(bad)}\n`;
    fs.writeFileSync(paths.manifestPath, text, "utf8");
    expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: sha256(Buffer.from(text, "utf8")),
    }), "foreign or extra keys");
    expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => validateWindowsNativeAddonManifest(bad), "foreign or extra keys");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("capabilities: sorted unique known allowlist + must contain retained", () => {
  expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => validateWindowsNativeAddonCapabilities([]), "non-empty");
  expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => validateWindowsNativeAddonCapabilities(["zzz_v1", "aaa_v1"]), "not in the known allowlist");
  // Unknown future id not yet on allowlist.
  expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => validateWindowsNativeAddonCapabilities(["atomic_replace_v1"]), "not in the known allowlist");
  expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => validateWindowsNativeAddonCapabilities([
    "atomic_replace_v1",
    "retained_directory_lock_v1",
  ]), "not in the known allowlist");
  // retained alone is still valid (required minimum; known allowlist permits subset).
  const ok = validateWindowsNativeAddonCapabilities(["retained_directory_lock_v1"]);
  assert(JSON.stringify([...ok]) === JSON.stringify(["retained_directory_lock_v1"]), "ok retained-only subset");
  assert(ok.includes("retained_directory_lock_v1"), "must contain retained");
  const full = validateWindowsNativeAddonCapabilities(EXPECTED_KNOWN_CAPABILITIES);
  assert(JSON.stringify([...full]) === JSON.stringify(EXPECTED_KNOWN_CAPABILITIES), "ok full known set");
});

await check("minimum_node requires exact 22.19.0 (no prerelease suffix)", () => {
  expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => validateWindowsNativeAddonManifest(baseManifest({
    minimum_node: "22.19.0-rc.1",
  })), "minimum_node");
  expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => validateWindowsNativeAddonManifest(baseManifest({
    minimum_node: "22.19.1",
  })), "minimum_node");
});

await check("prerelease runtime Node below floor fails closed", () => {
  assert(isNodeVersionAtLeast("22.19.0", "22.19.0") === true, "equal release ok");
  assert(isNodeVersionAtLeast("22.19.0-rc.1", "22.19.0") === false, "prerelease below release");
  assert(isNodeVersionAtLeast("22.19.1", "22.19.0") === true, "higher patch ok");
  assert(isNodeVersionAtLeast("22.18.0", "22.19.0") === false, "lower minor rejected");
  const root = tempPackageRoot("prerelease-node");
  try {
    const { manifestSha256 } = writeFixturePackage(root);
    let loaded = false;
    expectCode("WINDOWS_NATIVE_ADDON_NODE_VERSION_UNSUPPORTED", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      nodeVersion: "22.19.0-rc.1",
      loadNativeModule() {
        loaded = true;
        return matchingFakeAddon(baseManifest());
      },
    }));
    assert(!loaded, "prerelease node must not load native module");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("wrong arch fails closed before binary load", () => {
  const root = tempPackageRoot("wrong-arch");
  try {
    const { manifestSha256 } = writeFixturePackage(root);
    let loaded = false;
    expectCode("WINDOWS_NATIVE_ADDON_ARCH_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      arch: "arm64",
      loadNativeModule() {
        loaded = true;
        return matchingFakeAddon(baseManifest());
      },
    }));
    assert(!loaded, "wrong arch must not load native module");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("wrong N-API version in manifest fails closed at validate", () => {
  const root = tempPackageRoot("wrong-napi");
  try {
    const binaryBytes = Buffer.from("fake-napi\n");
    const { paths } = writeFixturePackage(root, { binaryBytes });
    const bad = baseManifest({
      napi_version: 8,
      binary_bytes: binaryBytes.byteLength,
      binary_sha256: sha256(binaryBytes),
    });
    const text = `${JSON.stringify(bad)}\n`;
    fs.writeFileSync(paths.manifestPath, text, "utf8");
    expectCode("WINDOWS_NATIVE_ADDON_MANIFEST_INVALID", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: sha256(Buffer.from(text, "utf8")),
    }), "napi_version");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("identity napi_version mismatch is reachable via NAPI_MISMATCH", () => {
  const root = tempPackageRoot("identity-napi");
  try {
    const { manifest, manifestSha256 } = writeFixturePackage(root);
    expectCode("WINDOWS_NATIVE_ADDON_NAPI_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        return matchingFakeAddon(manifest, { napi_version: 8 });
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("capability self-report mismatch fails closed", () => {
  const root = tempPackageRoot("cap-mismatch");
  try {
    const { manifest, manifestSha256 } = writeFixturePackage(root);
    expectCode("WINDOWS_NATIVE_ADDON_CAPABILITY_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        return matchingFakeAddon(manifest, {}, { capabilities: ["atomic_replace_v1"] });
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("unadvertised capability call fails closed", () => {
  const fake = {
    addon_abi: 1,
    getBuildIdentity() {
      return {};
    },
    getCapabilities() {
      return [];
    },
    tryAcquireRetainedDirectoryLock() {
      throw new Error("must not be reached");
    },
  };
  expectCode("WINDOWS_NATIVE_ADDON_CAPABILITY_UNADVERTISED", () => tryAcquireRetainedDirectoryLock(fake, "C:\\tmp"), "not advertised");
});

await check("binary hash mismatch fails closed", () => {
  const root = tempPackageRoot("hash-mismatch");
  try {
    const binaryBytes = Buffer.from("hash-me\n");
    const { manifestSha256 } = writeFixturePackage(root, {
      binaryBytes,
      manifestOverrides: {
        binary_bytes: binaryBytes.byteLength,
        binary_sha256: "d".repeat(64),
      },
    });
    expectCode("WINDOWS_NATIVE_ADDON_BINARY_HASH_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        throw new Error("must not load on hash mismatch");
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("binary size mismatch fails closed", () => {
  const root = tempPackageRoot("size-mismatch");
  try {
    const binaryBytes = Buffer.from("size-me!!\n");
    const { manifestSha256 } = writeFixturePackage(root, {
      binaryBytes,
      manifestOverrides: {
        binary_bytes: binaryBytes.byteLength + 7,
        binary_sha256: sha256(binaryBytes),
      },
    });
    expectCode("WINDOWS_NATIVE_ADDON_BINARY_SIZE_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        throw new Error("must not load on size mismatch");
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("addon self-reported ABI mismatch fails closed", () => {
  const root = tempPackageRoot("abi-mismatch");
  try {
    const { manifest, manifestSha256 } = writeFixturePackage(root);
    expectCode("WINDOWS_NATIVE_ADDON_ABI_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        return {
          addon_abi: 99,
          getBuildIdentity() {
            return matchingFakeAddon(manifest).getBuildIdentity();
          },
          getCapabilities() {
            return [...WINDOWS_NATIVE_ADDON_INITIAL_CAPABILITIES];
          },
          tryAcquireRetainedDirectoryLock() {
            return null;
          },
        };
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("addon self-reported build identity mismatch fails closed", () => {
  const root = tempPackageRoot("identity-mismatch");
  try {
    const { manifest, manifestSha256 } = writeFixturePackage(root);
    expectCode("WINDOWS_NATIVE_ADDON_BUILD_IDENTITY_MISMATCH", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule() {
        return matchingFakeAddon(manifest, { build_id: "other-build" });
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("Node below 22.19 fails closed without loading", () => {
  const root = tempPackageRoot("old-node");
  try {
    const { manifestSha256 } = writeFixturePackage(root);
    let loaded = false;
    expectCode("WINDOWS_NATIVE_ADDON_NODE_VERSION_UNSUPPORTED", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      nodeVersion: "22.18.0",
      loadNativeModule() {
        loaded = true;
        return matchingFakeAddon(baseManifest());
      },
    }));
    assert(!loaded, "old node must not load native module");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("symlink leaf is rejected as PATH_UNTRUSTED", () => {
  const root = tempPackageRoot("symlink-leaf");
  try {
    const { paths, manifestSha256, binaryBytes } = writeFixturePackage(root);
    // Inject lstat that marks the binary leaf as a symlink.
    const seam = realFsSeam({
      lstatSync: (p) => {
        if (path.resolve(p) === path.resolve(paths.binaryPath)) {
          return {
            size: binaryBytes.byteLength,
            isSymbolicLink: () => true,
            isFile: () => false,
          };
        }
        const st = fs.lstatSync(p);
        return {
          size: st.size,
          isSymbolicLink: () => st.isSymbolicLink(),
          isFile: () => st.isFile(),
        };
      },
    });
    expectCode("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      fs: seam.fs,
      loadNativeModule() {
        throw new Error("must not load symlink leaf");
      },
    }), "symlink");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("realpath escaping package root is PATH_UNTRUSTED", () => {
  const root = tempPackageRoot("realpath-escape");
  try {
    const { paths, manifestSha256 } = writeFixturePackage(root);
    const outside = path.join(os.tmpdir(), `pi-astack-win-native-outside-${Date.now()}`);
    fs.writeFileSync(outside, "escape\n");
    try {
      const seam = realFsSeam({
        realpathSync: (p) => {
          if (path.resolve(p) === path.resolve(paths.manifestPath)) return outside;
          return fs.realpathSync(p);
        },
      });
      expectCode("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", () => loadWin({
        packageRoot: root,
        expectedManifestSha256: manifestSha256,
        fs: seam.fs,
        loadNativeModule() {
          throw new Error("must not load escaped realpath");
        },
      }), "realpath");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("binary replaced during load is rejected by post-identity check", () => {
  const root = tempPackageRoot("toctou-replace");
  try {
    const binaryBytes = Buffer.from("toctou-original-bytes\n");
    const { paths, manifest, manifestSha256 } = writeFixturePackage(root, { binaryBytes });
    // Replace race: same-fd rehash runs before identity and may catch size/hash first;
    // either detector must still fail closed with BINARY_MUTATED.
    const caught = expectCode("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule(absoluteBinaryPath) {
        // Replace bytes + bump mtime so path/fd identity diverges after hash.
        fs.writeFileSync(absoluteBinaryPath, Buffer.from("toctou-replaced-bytes-XXXX\n"));
        const now = new Date(Date.now() + 5000);
        fs.utimesSync(absoluteBinaryPath, now, now);
        return matchingFakeAddon(manifest);
      },
    }));
    const msg = String(caught.message || "");
    assert(
      msg.includes("same-fd rehash") || msg.includes("identity changed"),
      `replace race must be caught by rehash or identity, got ${msg}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("injected lstat non-ENOENT is PATH_UNTRUSTED (no fail-open)", () => {
  const root = tempPackageRoot("lstat-eacces");
  try {
    const { paths, manifestSha256 } = writeFixturePackage(root);
    const seam = realFsSeam({
      lstatSync: (p) => {
        if (path.resolve(p) === path.resolve(paths.binaryPath)) {
          const err = new Error("EACCES: permission denied (injected)");
          err.code = "EACCES";
          throw err;
        }
        const st = fs.lstatSync(p);
        return {
          size: st.size,
          isSymbolicLink: () => st.isSymbolicLink(),
          isFile: () => st.isFile(),
        };
      },
    });
    const caught = expectCode("WINDOWS_NATIVE_ADDON_PATH_UNTRUSTED", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      fs: seam.fs,
      loadNativeModule() {
        throw new Error("must not load when lstat non-ENOENT");
      },
    }), "unreadable");
    assert(caught.detail?.check === "lstat", `detail.check=lstat, got ${caught.detail?.check}`);
    assert(caught.detail?.code === "EACCES", `detail.code=EACCES, got ${caught.detail?.code}`);
    const detailText = JSON.stringify(caught.detail || {});
    assert(!detailText.includes(paths.binaryPath), "PATH_UNTRUSTED detail must not leak path");
    assert(!detailText.includes(root), "PATH_UNTRUSTED detail must not leak package root");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("injected lstat ENOENT still maps to BINARY_MISSING", () => {
  const root = tempPackageRoot("lstat-enoent");
  try {
    const { paths, manifestSha256 } = writeFixturePackage(root);
    // Remove binary so absence is real; inject lstat ENOENT as the observable surface.
    fs.rmSync(paths.binaryPath, { force: true });
    const seam = realFsSeam({
      lstatSync: (p) => {
        if (path.resolve(p) === path.resolve(paths.binaryPath)) {
          const err = new Error("ENOENT: no such file (injected)");
          err.code = "ENOENT";
          throw err;
        }
        const st = fs.lstatSync(p);
        return {
          size: st.size,
          isSymbolicLink: () => st.isSymbolicLink(),
          isFile: () => st.isFile(),
        };
      },
    });
    expectCode("WINDOWS_NATIVE_ADDON_BINARY_MISSING", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      fs: seam.fs,
      loadNativeModule() {
        throw new Error("must not load missing binary");
      },
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("in-place binary mutation after open is rejected by same-fd rehash", () => {
  const root = tempPackageRoot("toctou-inplace");
  try {
    const original = Buffer.from("toctou-inplace-AAAA\n");
    const mutated = Buffer.from("toctou-inplace-BBBB\n");
    assert(original.byteLength === mutated.byteLength, "in-place mutation must preserve size");
    const { paths, manifest, manifestSha256 } = writeFixturePackage(root, { binaryBytes: original });
    const caught = expectCode("WINDOWS_NATIVE_ADDON_BINARY_MUTATED", () => loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      loadNativeModule(absoluteBinaryPath) {
        // Overwrite through a second handle while loader holds the original fd open.
        // Preserve size + restore mtime so identity best-effort alone would not catch content flip.
        const before = fs.statSync(absoluteBinaryPath);
        const fdw = fs.openSync(absoluteBinaryPath, "r+");
        try {
          fs.writeSync(fdw, mutated, 0, mutated.byteLength, 0);
          fs.fsyncSync(fdw);
        } finally {
          fs.closeSync(fdw);
        }
        fs.utimesSync(absoluteBinaryPath, before.atime, before.mtime);
        return matchingFakeAddon(manifest);
      },
    }), "same-fd rehash");
    assert(caught.detail?.check === "sha256", `detail.check=sha256, got ${caught.detail?.check}`);
    assert(caught.detail?.phase === "after-load", `detail.phase=after-load, got ${caught.detail?.phase}`);
    // Ensure we did not fall back to path identity as the only detector for this case.
    assert(!String(caught.message || "").includes("identity changed"), "must fail via same-fd rehash, not identity");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("strict-valid fake addon loads successfully via __TEST seams + pin", () => {
  const root = tempPackageRoot("strict-valid");
  try {
    const binaryBytes = Buffer.from("strict-valid-fake-addon\n");
    const { paths, manifest, manifestSha256 } = writeFixturePackage(root, { binaryBytes });
    let loadedPath = null;
    const result = loadWin({
      packageRoot: root,
      expectedManifestSha256: manifestSha256,
      nodeVersion: "24.18.1",
      loadNativeModule(absoluteBinaryPath) {
        loadedPath = absoluteBinaryPath;
        return matchingFakeAddon(manifest);
      },
    });
    assert(result.status === "loaded", "status loaded");
    assert(result.manifestPath === paths.manifestPath, "manifest path");
    assert(result.binaryPath === paths.binaryPath, "binary path");
    assert(loadedPath === paths.binaryPath, "loader received fixed package-relative binary path");
    assert(result.manifest.build_id === manifest.build_id, "manifest build_id");
    assert(result.identity.build_id === manifest.build_id, "identity build_id");
    assert(result.identity.addon_abi === 1, "identity frozen abi 1");
    assert(result.addon.addon_abi === 1, "addon frozen abi 1");
    assert(
      JSON.stringify([...result.capabilities]) === JSON.stringify(EXPECTED_KNOWN_CAPABILITIES),
      "capabilities exact",
    );
    assert(
      JSON.stringify([...result.manifest.capabilities]) === JSON.stringify(EXPECTED_KNOWN_CAPABILITIES),
      "manifest capabilities exact",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("schema file freezes ABI v1 exact key set and additionalProperties false", () => {
  const schemaPath = path.join(repoRoot, "schemas/windows-native-addon-manifest-v1.json");
  assert(fs.existsSync(schemaPath), "v1 schema file exists");
  assert(
    !fs.existsSync(path.join(repoRoot, "schemas/windows-native-addon-manifest-v0-provisional.json")),
    "v0 provisional schema file must be deleted",
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert(schema.additionalProperties === false, "additionalProperties false");
  const required = schema.required;
  const props = Object.keys(schema.properties).sort();
  const expected = [
    "addon_abi",
    "arch",
    "binary_bytes",
    "binary_file",
    "binary_sha256",
    "build_config_sha256",
    "build_id",
    "build_mode",
    "capabilities",
    "clippy",
    "minimum_node",
    "napi_version",
    "native_tests",
    "platform",
    "reproducibility",
    "schema_version",
    "source_commit",
    "source_tree_sha256",
    "target",
    "toolchain",
    "toolchain_id",
  ];
  assert(JSON.stringify([...required].sort()) === JSON.stringify(expected), "required exact keys");
  assert(JSON.stringify(props) === JSON.stringify(expected), "properties exact keys");
  assert(schema.properties.schema_version.const === "windows-native-addon-manifest/v1", "schema_version const");
  assert(schema.properties.addon_abi.const === 1, "addon_abi const 1");
  assert(schema.properties.platform.const === "win32", "platform const");
  assert(schema.properties.arch.const === "x64", "arch const");
  assert(schema.properties.napi_version.const === 9, "napi const");
  assert(schema.properties.minimum_node.const === "22.19.0", "minimum_node exact const");
  assert(schema.properties.binary_file.const === "pi-astack-windows-native.node", "binary_file const");
  // Capabilities are extensible (array + contains retained), not a frozen exact const.
  assert(schema.properties.capabilities.type === "array", "capabilities type array");
  assert(schema.properties.capabilities.minItems === 1, "capabilities minItems");
  assert(schema.properties.capabilities.uniqueItems === true, "capabilities uniqueItems");
  assert(schema.properties.capabilities.items?.pattern === "^[a-z][a-z0-9_]*_v[0-9]+$", "capabilities items pattern");
  assert(
    schema.properties.capabilities.contains?.const === "retained_directory_lock_v1",
    "capabilities contains retained",
  );
  assert(schema.properties.capabilities.const === undefined, "capabilities must not be exact const");
  assert(schema.properties.toolchain_id.pattern === "^[0-9a-f]{64}$", "toolchain_id pattern");
  assert(JSON.stringify(schema.properties.build_mode.enum) === JSON.stringify(["development", "production"]), "build_mode enum");
  assert(JSON.stringify(schema.properties.reproducibility.enum) === JSON.stringify(["skipped", "dual_clean_match"]), "reproducibility enum");
  assert(schema.properties.native_tests.const === "passed", "native_tests const passed");
  assert(schema.properties.clippy.const === "passed", "clippy const passed");
  assert(schema.properties.build_config_sha256.pattern === "^[0-9a-f]{64}$", "build_config_sha256 pattern");
});

// Final guard: this smoke never created ~/.abrain side effects.
assert(!process.cwd().includes(`${path.sep}.abrain`), "cwd must not be under .abrain");

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} case(s); ${passed} passed`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} checks`);
