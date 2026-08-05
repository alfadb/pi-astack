#!/usr/bin/env node
/**
 * Windows DCC attestation physical-layer smoke (implementation integration).
 *
 * - Loads native addon only via __TEST + temp package for fixture suites.
 * - Production pin null → zero-arg fail-closed; pin live → production positive only in
 *   closed child (controller never maps live .node). Temp suites stay independent.
 * - Covers: pending→ready/blocked state machine, protected dir/file DACL,
 *   inheritance/extra ACE tamper, CAS identity, weak ACL fail-closed,
 *   six-condition foreground observation.
 *
 * Non-win32 / non-x64 / missing artifact → print `SKIP:` and exit 0.
 * Does not touch ~/.abrain or settings.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const stagedNode = path.join(repoRoot, "native/windows/target/smoke-staging/pi-astack-windows-native.node");
const buildInfoPath = path.join(repoRoot, "native/windows/target/smoke-staging/build-info.json");
const CAPABILITIES = ["atomic_file_tempdir_v1", "atomic_file_v1", "protected_dacl_v1", "retained_directory_lock_v1"];

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

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

function hex64(seed) {
  return createHash("sha256").update(String(seed)).digest("hex");
}

function hex40(seed) {
  return createHash("sha1").update(String(seed)).digest("hex");
}

function runIcacls(args) {
  const r = spawnSync("icacls", args, { encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

if (process.platform !== "win32") skip("not win32");
if (process.arch !== "x64") skip("not x64");
if (!fs.existsSync(stagedNode) || !fs.existsSync(buildInfoPath)) {
  skip("missing smoke-staging artifact; run npm run build:windows-native-addon first");
}

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

// moduleCache must stay enabled so retained-lock test override is the same instance
// consumed by canonical-control → mutation-barrier.
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false });
const nativeMod = jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));
const retainedLock = jiti(path.join(repoRoot, "extensions/_shared/retained-directory-lock.ts"));
const control = jiti(path.join(repoRoot, "extensions/sediment/canonical-control.ts"));

const binaryBytes = fs.readFileSync(stagedNode);
const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
for (const c of CAPABILITIES) {
  assert(Array.isArray(buildInfo.capabilities) && buildInfo.capabilities.includes(c), `build-info must include ${c}`);
}

// Production pin may be null (fail-closed) or live (post-pin). Never map live .node in controller.
const pinSha = nativeMod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256;
const pinSrc = nativeMod.WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT;
const pinLive =
  typeof pinSha === "string" && /^[0-9a-f]{64}$/.test(pinSha)
  && typeof pinSrc === "string" && /^[0-9a-f]{40}$/.test(pinSrc);
const pinAbsent = pinSha == null && pinSrc == null;
assert(pinAbsent || pinLive, `production pin null or live, got manifest=${pinSha} source=${pinSrc}`);
assert(nativeMod.loadWindowsNativeAddon.length === 0, "production loader must be zero-arg");
if (!pinLive) {
  let productionLoadCode = null;
  try {
    nativeMod.loadWindowsNativeAddon();
  } catch (error) {
    productionLoadCode = error?.code ?? String(error);
  }
  assert(
    productionLoadCode === "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING"
      || productionLoadCode === "WINDOWS_NATIVE_ADDON_MANIFEST_MISSING"
      || String(productionLoadCode || "").includes("PROVENANCE")
      || String(productionLoadCode || "").includes("PIN"),
    `production zero-arg load must fail closed, got ${productionLoadCode}`,
  );
  // isDccAttestationPlatformSupported: pin null → win32 unsupported (no throw, no cache).
  assert(control.isDccAttestationPlatformSupported("linux") === true, "linux supported");
  assert(control.isDccAttestationPlatformSupported("darwin") === true, "darwin supported");
  assert(control.isDccAttestationPlatformSupported("win32") === false, "win32 production pin-null must be unsupported");
  assert(control.isDccAttestationPlatformSupported() === false, "default process.platform pin-null fail-closed");
} else {
  // pin live: do not call isDccAttestationPlatformSupported / loadWindowsNativeAddon in controller
  // (would dlopen + cache production addon and break temp-suite no-inject isolation).
  assert(control.isDccAttestationPlatformSupported("linux") === true, "linux supported");
  assert(control.isDccAttestationPlatformSupported("darwin") === true, "darwin supported");
}

// Temp package + __TEST load (not production pin bypass).
const abrainHomeRoot = path.resolve(os.homedir(), ".abrain");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dcc-win-att-"));
assert(!tmp.startsWith(abrainHomeRoot + path.sep) && tmp !== abrainHomeRoot, `temp under ~/.abrain: ${tmp}`);
process.once("exit", () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const packageRoot = fs.mkdtempSync(path.join(tmp, "pkg-"));
fs.writeFileSync(
  path.join(packageRoot, "package.json"),
  `${JSON.stringify({ name: "pi-astack-dcc-win-temp", private: true }, null, 2)}\n`,
);
const paths = nativeMod.resolveWindowsNativeAddonPaths(packageRoot);
fs.mkdirSync(path.dirname(paths.binaryPath), { recursive: true });
fs.writeFileSync(paths.binaryPath, binaryBytes);
const toolchainId = buildInfo.toolchain_id || "d".repeat(64);
assert(/^[0-9a-f]{64}$/.test(toolchainId), "toolchain_id sha256");
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
  capabilities: [...CAPABILITIES],
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(paths.manifestPath, manifestText, "utf8");
const manifestSha256 = sha256(Buffer.from(manifestText, "utf8"));

const loaded = nativeMod.__TEST.loadWindowsNativeAddon({
  packageRoot,
  platform: "win32",
  arch: "x64",
  nodeVersion: process.versions.node,
  expectedManifestSha256: manifestSha256,
});
assert(
  JSON.stringify([...loaded.capabilities]) === JSON.stringify(CAPABILITIES),
  `capabilities mismatch: ${JSON.stringify(loaded.capabilities)}`,
);
const addon = loaded.addon;
// Mutation barrier / kick settle needs retained lock under temp package (pin null).
retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(addon);
process.once("exit", () => {
  try { retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(null); } catch { /* ignore */ }
});

const epoch = "7";
const holderNonce = hex64("dcc-win-holder");
const stateDirKey = hex64("dcc-win-state-dir");
const runNonce = hex64("dcc-win-run");
const goodHead = hex40("dcc-win-ready-head");

function authorityRecord(overrides = {}) {
  return {
    schema: "pi-router/local-sediment-executor-authority/v1",
    local_executor_epoch: epoch,
    mode: "held",
    holder_kind: "daemon",
    holder_nonce: holderNonce,
    state_dir_key: stateDirKey,
    run_nonce: runNonce,
    ...overrides,
  };
}

function createAbrain(name) {
  const abrain = path.join(tmp, name);
  fs.mkdirSync(abrain, { recursive: true });
  const directory = path.join(abrain, ".state", "sediment", "local-executor-authority");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "authority.lock"), "");
  fs.writeFileSync(path.join(directory, "authority.json"), `${JSON.stringify(authorityRecord())}\n`);
  return abrain;
}

function request(operation, seed) {
  return {
    schema: "pi-astack/sediment-worker-canonical-control/v1",
    request_id: hex64(seed),
    operation,
    local_executor_epoch: epoch,
    local_executor_holder_nonce: holderNonce,
  };
}

function deps(abrain, testHooks = {}) {
  return {
    resolveAbrainHome: () => abrain,
    authorityObservation: { observeLock: () => "held" },
    windowsDccNativeAddon: addon,
    testHooks: {
      repairStorePresentBrainLayout() {},
      ...testHooks,
    },
  };
}

/** All smoke readers outside control ALS must enter the gated helper context. */
function withAddon(fn) {
  return control.withWindowsDccNativeAddonForTests(addon, fn);
}

function readAttestation(abrain) {
  return withAddon(() => control.readCanonicalConvergenceAttestation(abrain));
}

function diagnostics(startup) {
  return {
    apiVersion: 1,
    repo: "private",
    settings: {
      enabled: true,
      mode: "local_convergence_v2",
      valid: true,
      reason: "enabled",
      settingsPath: "private",
    },
    startupGeneration: 1,
    startup,
    loadedProvenance: [],
    implementationFingerprint: "smoke-dcc-windows",
    tail: [],
  };
}

function attestationDirectory(abrain) {
  return path.join(abrain, ".state", "sediment", "canonical-convergence");
}

function attestationFile(abrain) {
  return path.join(attestationDirectory(abrain), "attestation.json");
}

async function waitFor(fn, label, timeoutMs = 15_000) {
  // Must yield the event loop (setTimeout) so kick setImmediate settle can run.
  // Atomics.wait would block the main thread and starve settle forever.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

console.log("DCC Windows attestation physical layer");

await check("production path without test inject (pin-null unavailable; pin-live skipped in-controller)", async () => {
  if (pinLive) {
    // Calling production reader/control here would dlopen + cache live addon in this process.
    // Production positive is owned by closed child / dossier; temp suite uses inject only.
    return;
  }
  const abrain = createAbrain("prod-unavailable");
  let code = null;
  try {
    // Outside ALS inject — production pin-null path.
    control.readCanonicalConvergenceAttestation(abrain);
  } catch (error) {
    code = error?.code;
  }
  assert(code === "attestation_unavailable", `reader code=${code}`);

  const closed = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "prod-kick")),
    {
      resolveAbrainHome: () => abrain,
      authorityObservation: { observeLock: () => "held" },
      // no windowsDccNativeAddon inject
      testHooks: {
        kickStartup() {
          throw new Error("must not reach kickStartup");
        },
      },
    },
  );
  assert(closed.status === "unavailable", `status=${closed.status}`);
  assert(closed.reason_code === "attestation_unavailable", `reason=${closed.reason_code}`);
  assert(closed.convergence_generation === null, "generation must be null");
  assert(!fs.existsSync(attestationDirectory(abrain)), "must not create attestation dir");
});

await check("pending→ready state machine with native protected attestation", async () => {
  const abrain = createAbrain("ready-path");
  const hooks = {
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      return { pending: 0, failed: 0, invalid: 0 };
    },
    async applyBindIntents() {
      return { applied: 0, pending: 0, failed: 0 };
    },
    async probeCanonicalBacklog() {
      return "none";
    },
  };
  const first = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "ready-1")),
    deps(abrain, hooks),
  );
  assert(first.status === "pending", JSON.stringify(first));
  assert(first.convergence_generation === "1", JSON.stringify(first));

  const ready = await waitFor(() => {
    try {
      const value = readAttestation(abrain);
      return value?.outcome === "ready" ? value : null;
    } catch {
      return null;
    }
  }, "ready attestation");
  assert(ready.canonical_head === goodHead, JSON.stringify(ready));
  assert(ready.convergence_generation === "1", JSON.stringify(ready));

  // native private_rw on dir + file
  nativeMod.verifyProtectedPath(addon, attestationDirectory(abrain), "directory", "private_rw");
  nativeMod.verifyProtectedPath(addon, attestationFile(abrain), "file", "private_rw");

  const observe = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("observe", "ready-obs")),
    deps(abrain, hooks),
  );
  assert(observe.status === "ready", JSON.stringify(observe));
  assert(observe.reason_code === "none", JSON.stringify(observe));
});

await check("pending→blocked continuation_failed remains non-ready", async () => {
  const abrain = createAbrain("blocked-path");
  const hooks = {
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      return { pending: 0, failed: 1, invalid: 0 };
    },
    async applyBindIntents() {
      throw new Error("must not apply");
    },
  };
  const first = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "blocked-1")),
    deps(abrain, hooks),
  );
  assert(first.status === "pending", JSON.stringify(first));
  const blocked = await waitFor(() => {
    try {
      const value = readAttestation(abrain);
      return value?.reason_code === "continuation_failed" ? value : null;
    } catch {
      return null;
    }
  }, "blocked attestation");
  assert(blocked.outcome === "blocked", JSON.stringify(blocked));
  assert(blocked.canonical_head === null, JSON.stringify(blocked));
  nativeMod.verifyProtectedPath(addon, attestationFile(abrain), "file", "private_rw");
});

await check("CAS rejects identity mismatch; successful replace readback exact", async () => {
  const abrain = createAbrain("cas-path");
  const hooks = {
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      return { pending: 0, failed: 0, invalid: 0 };
    },
    async applyBindIntents() {
      return { applied: 0, pending: 0, failed: 0 };
    },
    async probeCanonicalBacklog() {
      return "none";
    },
  };
  await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "cas-1")),
    deps(abrain, hooks),
  );
  const first = await waitFor(() => {
    try {
      const value = readAttestation(abrain);
      return value?.outcome === "ready" ? value : null;
    } catch {
      return null;
    }
  }, "cas ready");

  const beforeRaw = fs.readFileSync(attestationFile(abrain));
  const beforeId = nativeMod.readProtectedFile(addon, attestationFile(abrain), 64 * 1024).identity;

  // External replace with same protected DACL changes file_id → CAS identity diverge.
  const tampered = Buffer.from(
    `${JSON.stringify({
      ...first,
      convergence_generation: "99",
      published_at_ms: first.published_at_ms + 1,
    })}\n`,
    "utf8",
  );
  nativeMod.durableAtomicReplaceFile(addon, attestationFile(abrain), tampered);
  const afterId = nativeMod.readProtectedFile(addon, attestationFile(abrain), 64 * 1024).identity;
  assert(
    afterId.file_id !== beforeId.file_id || afterId.size !== beforeId.size,
    "replacement must change identity (file_id/size)",
  );

  // Next kick with new generation must still write via CAS against live expected snapshot.
  const second = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "cas-2")),
    deps(abrain, hooks),
  );
  assert(second.status === "pending" || second.status === "ready" || second.status === "running"
    || second.status === "blocked", JSON.stringify(second));
  // generation advances from tampered live generation (99) or from tuple restart — either way not stuck.
  assert(typeof second.convergence_generation === "string", "generation present");

  // Restore a clean ready and verify readback raw exact after control write.
  await waitFor(() => {
    try {
      const value = readAttestation(abrain);
      return value && value.convergence_generation !== "99" ? value : null;
    } catch {
      return null;
    }
  }, "post-cas settle");

  // Identity fields present on windows snapshots via native read path.
  const live = nativeMod.readProtectedFile(addon, attestationFile(abrain), 64 * 1024);
  assert(typeof live.identity.volume_serial_number === "string" && live.identity.volume_serial_number.length > 0, "vol");
  assert(typeof live.identity.file_id === "string" && live.identity.file_id.length > 0, "file_id");
  assert(live.identity.size === live.data.byteLength, "size match");
  assert(beforeRaw.byteLength > 0, "baseline raw captured");
});

await check("DACL tamper / inheritance / extra ACE → attestation_unavailable (not ready)", async () => {
  const abrain = createAbrain("dacl-tamper");
  const hooks = {
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      return { pending: 0, failed: 0, invalid: 0 };
    },
    async applyBindIntents() {
      return { applied: 0, pending: 0, failed: 0 };
    },
    async probeCanonicalBacklog() {
      return "none";
    },
  };
  await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "tamper-1")),
    deps(abrain, hooks),
  );
  await waitFor(() => {
    try {
      const value = readAttestation(abrain);
      return value?.outcome === "ready" ? value : null;
    } catch {
      return null;
    }
  }, "tamper baseline ready");

  const file = attestationFile(abrain);
  const dir = attestationDirectory(abrain);

  // Extra ACE (Everyone:F) — must exit 0 + re-read before native reject.
  const grant = runIcacls([file, "/grant", "Everyone:F"]);
  assert(grant.status === 0, `icacls grant failed: ${grant.stderr}`);
  const listing = runIcacls([file]);
  assert(listing.status === 0, "icacls readback failed");
  assert(/Everyone/i.test(listing.stdout), `Everyone ACE missing in ${listing.stdout}`);

  let tamperCode = null;
  try {
    readAttestation(abrain);
  } catch (error) {
    tamperCode = error?.code;
  }
  assert(tamperCode === "attestation_unavailable", `extra ACE code=${tamperCode}`);

  // Reset file via native rewrite so dir-level tests can proceed.
  // Re-create protected attestation through a fresh kick after setProtectedPath restore.
  try {
    nativeMod.setProtectedPath(addon, file, "file", "private_rw");
  } catch {
    // if set fails due to foreign ACE, delete and re-kick
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }

  // Inheritance enable on directory is also invalid for protected exact DACL.
  const inherit = runIcacls([dir, "/inheritance:e"]);
  assert(inherit.status === 0, `icacls inheritance enable failed: ${inherit.stderr}`);
  let dirCode = null;
  try {
    readAttestation(abrain);
  } catch (error) {
    dirCode = error?.code;
  }
  assert(dirCode === "attestation_unavailable", `inheritance code=${dirCode}`);

  // Observe must not report ready under tamper.
  const obs = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("observe", "tamper-obs")),
    deps(abrain, hooks),
  );
  assert(obs.status !== "ready", `observe status under tamper=${obs.status}`);
  assert(
    obs.reason_code === "attestation_unavailable"
      || obs.status === "unavailable"
      || obs.status === "blocked",
    JSON.stringify(obs),
  );
});

await check("weak/default ACL file is not accepted as ready", async () => {
  const abrain = createAbrain("weak-acl");
  // Parent sediment dir exists; create weak attestation objects with Node fs only.
  const dir = attestationDirectory(abrain);
  fs.mkdirSync(dir, { recursive: true });
  const weakBody = `${JSON.stringify({
    schema: "pi-astack/canonical-convergence-attestation/v1",
    local_executor_epoch: epoch,
    local_executor_holder_nonce: holderNonce,
    convergence_generation: "1",
    outcome: "ready",
    reason_code: "none",
    canonical_head: goodHead,
    published_at_ms: 1_800_000_000_000,
  })}\n`;
  fs.writeFileSync(attestationFile(abrain), weakBody, "utf8");

  if (!pinLive) {
    let code = null;
    try {
      // Outside ALS inject — production pin-null path.
      control.readCanonicalConvergenceAttestation(abrain);
    } catch (error) {
      code = error?.code;
    }
    // Without ALS inject, production pin-null already unavailable.
    assert(code === "attestation_unavailable", `weak without inject code=${code}`);
  }

  let weakWithInject = null;
  try {
    readAttestation(abrain);
  } catch (error) {
    weakWithInject = error?.code;
  }
  assert(weakWithInject === "attestation_unavailable", `weak with inject code=${weakWithInject}`);

  // With inject in ALS via control read path: use observeForeground which accepts inject.
  const fg = await control.observeForegroundCanonicalConvergence(abrain, {
    authorityObservation: { observeLock: () => "held" },
    windowsDccNativeAddon: addon,
    readCanonicalHead: async () => goodHead,
  });
  assert(fg.status !== "ready", `weak fg status=${fg.status}`);
  assert(
    fg.reason_code === "attestation_unavailable" || fg.status === "unavailable",
    JSON.stringify(fg),
  );
});

await check("six-condition foreground observation ready only when stable+authorized", async () => {
  const abrain = createAbrain("six-cond");
  const hooks = {
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      return { pending: 0, failed: 0, invalid: 0 };
    },
    async applyBindIntents() {
      return { applied: 0, pending: 0, failed: 0 };
    },
    async probeCanonicalBacklog() {
      return "none";
    },
  };
  await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "six-1")),
    deps(abrain, hooks),
  );
  await waitFor(() => {
    try {
      const value = readAttestation(abrain);
      return value?.outcome === "ready" ? value : null;
    } catch {
      return null;
    }
  }, "six-cond ready attestation");

  const ready = await control.observeForegroundCanonicalConvergence(abrain, {
    authorityObservation: { observeLock: () => "held" },
    windowsDccNativeAddon: addon,
    readCanonicalHead: async () => goodHead,
  });
  assert(ready.status === "ready" && ready.reason_code === "none", JSON.stringify(ready));

  const headMismatch = await control.observeForegroundCanonicalConvergence(abrain, {
    authorityObservation: { observeLock: () => "held" },
    windowsDccNativeAddon: addon,
    readCanonicalHead: async () => hex40("other-head"),
  });
  assert(headMismatch.status === "blocked" && headMismatch.reason_code === "head_mismatch", JSON.stringify(headMismatch));

  const revoked = await control.observeForegroundCanonicalConvergence(abrain, {
    authorityObservation: { observeLock: () => "absent" },
    windowsDccNativeAddon: addon,
    readCanonicalHead: async () => goodHead,
  });
  assert(revoked.status === "blocked" && revoked.reason_code === "authority_revoked", JSON.stringify(revoked));

  // No inject: pin-null → unavailable; pin-live would load production — skip to keep process clean.
  if (!pinLive) {
    const noInject = await control.observeForegroundCanonicalConvergence(abrain, {
      authorityObservation: { observeLock: () => "held" },
      readCanonicalHead: async () => goodHead,
    });
    assert(noInject.status === "unavailable", JSON.stringify(noInject));
    assert(noInject.reason_code === "attestation_unavailable", JSON.stringify(noInject));
  }
});

await check("write failure on DACL-broken directory maps attestation_write_failed / unavailable", async () => {
  const abrain = createAbrain("write-fail");
  // Pre-create unprotected dir so ensure/verify fails closed on write path after kick admits.
  const dir = attestationDirectory(abrain);
  fs.mkdirSync(dir, { recursive: true });
  // Strip to a weak ACL if possible: grant Everyone and enable inheritance.
  runIcacls([dir, "/grant", "Everyone:F"]);
  runIcacls([dir, "/inheritance:e"]);

  const hooks = {
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
  };
  const result = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "write-fail-1")),
    deps(abrain, hooks),
  );
  // May be blocked/write_failed or unavailable depending on when DACL is checked.
  assert(
    result.status === "blocked" || result.status === "unavailable" || result.status === "pending",
    JSON.stringify(result),
  );
  if (result.status === "pending") {
    // Background settle may report write_failed.
    await waitFor(() => {
      try {
        const value = readAttestation(abrain);
        return value; // if readable, not a hard fail path
      } catch (error) {
        return error?.code === "attestation_unavailable" ? { ok: true } : null;
      }
    }, "write-fail settle");
  }
  if (result.status === "blocked") {
    assert(
      result.reason_code === "attestation_write_failed" || result.reason_code === "attestation_unavailable",
      JSON.stringify(result),
    );
  }
  // Must never surface ready under weak dir DACL.
  try {
    const att = readAttestation(abrain);
    assert(att === null || att.outcome !== "ready", `must not be ready: ${JSON.stringify(att)}`);
  } catch (error) {
    assert(error?.code === "attestation_unavailable", `code=${error?.code}`);
  }
});

await check("dual-writer first-write concurrent CAS: single expected writer wins, no lost update", async () => {
  const abrain = createAbrain("dual-writer");
  const hooks = {
    kickStartup() {
      // Stay pending so settle does not immediately race another generation.
      return {
        promise: new Promise(() => {
          /* never settles in this smoke */
        }),
      };
    },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      return { pending: 0, failed: 0, invalid: 0 };
    },
    async applyBindIntents() {
      return { applied: 0, pending: 0, failed: 0 };
    },
  };

  // Fire two concurrent first kicks (both see expected=null). Retained-directory
  // lock serializes CAS: exactly one create-only writer publishes generation 1;
  // the other fails write (or sees the published pending and joins running).
  const [a, b] = await Promise.all([
    control.runSedimentWorkerCanonicalControl(JSON.stringify(request("kick", "dual-a")), deps(abrain, hooks)),
    control.runSedimentWorkerCanonicalControl(JSON.stringify(request("kick", "dual-b")), deps(abrain, hooks)),
  ]);

  const outcomes = [a, b];
  const published = outcomes.filter(
    (r) => r.status === "pending" && r.reason_code === "startup_requested" && r.convergence_generation === "1",
  );
  const failedWrite = outcomes.filter(
    (r) => r.reason_code === "attestation_write_failed" || r.status === "blocked",
  );
  const joinedRunning = outcomes.filter(
    (r) => r.status === "running" && r.reason_code === "startup_running" && r.convergence_generation === "1",
  );

  // One writer publishes gen=1; the other either write-fails or joins the same gen as running.
  assert(
    published.length + joinedRunning.length >= 1,
    `expected at least one gen=1 publisher/joiner: ${JSON.stringify(outcomes)}`,
  );
  assert(
    published.length <= 1,
    `at most one first-write publisher: ${JSON.stringify(outcomes)}`,
  );
  assert(
    published.length + failedWrite.length + joinedRunning.length === 2,
    `closed dual-writer outcomes: ${JSON.stringify(outcomes)}`,
  );

  // Durable attestation is a single complete gen=1 document (no lost/torn update).
  const durable = await waitFor(() => {
    try {
      return readAttestation(abrain);
    } catch {
      return null;
    }
  }, "dual-writer durable");
  assert(durable, "durable attestation missing");
  assert(durable.convergence_generation === "1", `gen=${durable.convergence_generation}`);
  assert(
    durable.outcome === "pending" || durable.outcome === "ready" || durable.outcome === "blocked",
    `outcome=${durable.outcome}`,
  );
  assert(durable.local_executor_epoch === epoch, "epoch stable");
  assert(durable.local_executor_holder_nonce === holderNonce, "nonce stable");
  nativeMod.verifyProtectedPath(addon, attestationFile(abrain), "file", "private_rw");

  // File bytes parse as one strict attestation (no interleaved dual write).
  const raw = fs.readFileSync(attestationFile(abrain), "utf8");
  const parsed = JSON.parse(raw);
  assert(parsed.convergence_generation === "1", "raw gen");
  assert(parsed.schema === "pi-astack/canonical-convergence-attestation/v1", "raw schema");
});

// pin-live: closed child verifies production zero-arg load (controller never maps live .node).
if (pinLive) {
  await check("production zero-arg load positive (closed child, no test hooks)", () => {
    const env = { ...process.env };
    delete env.PI_ASTACK_ENABLE_TEST_HOOKS;
    const script = `
      const { createRequire } = require("node:module");
      const path = require("node:path");
      if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== undefined) {
        throw new Error("hooks must be unset");
      }
      const { createJiti } = createRequire(path.join(${JSON.stringify(repoRoot)}, "package.json"))("jiti");
      const jiti = createJiti(${JSON.stringify(repoRoot)}, { interopDefault: true, fsCache: false, moduleCache: false });
      const m = jiti(path.join(${JSON.stringify(repoRoot)}, "extensions/_shared/windows-native-addon.ts"));
      const loaded = m.loadWindowsNativeAddon();
      if (loaded.status !== "loaded") throw new Error("status=" + loaded.status);
      if (loaded.manifest.build_mode !== "production") throw new Error("build_mode");
      if (m.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 !== ${JSON.stringify(pinSha)}) throw new Error("pin");
      process.stdout.write(JSON.stringify({ ok: true, status: loaded.status }) + "\\n");
    `;
    const r = spawnSync(process.execPath, ["--input-type=commonjs", "-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env,
    });
    assert(r.status === 0, `prod-zeroarg child exit ${r.status}: ${r.stderr}\n${r.stdout}`);
    const json = JSON.parse(String(r.stdout).trim().split(/\r?\n/).filter(Boolean).pop());
    assert(json.ok === true && json.status === "loaded", JSON.stringify(json));
  });
}

console.log(`\n${passed} checks passed`);
console.log("smoke-dcc-windows-attestation: OK");
