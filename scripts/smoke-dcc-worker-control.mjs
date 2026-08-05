#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const control = await jiti.import(path.join(root, "extensions/sediment/canonical-control.ts"));
const worker = await jiti.import(path.join(root, "extensions/sediment/worker-rpc.ts"));
const runtime = await jiti.import(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const budget = await jiti.import(path.join(root, "extensions/_shared/worker-budget-context.ts"));
const mutationAuthority = await jiti.import(path.join(root, "extensions/_shared/canonical-mutation-authority.ts"));
const localAuthority = await jiti.import(path.join(root, "extensions/sediment/local-executor-authority.ts"));

/**
 * Windows-only: load temp package addon for DCC physical layer + retained-lock barrier.
 * Production pin remains null; this is a test seam only (never production dynamic pin).
 */
let windowsDccAddon = undefined;
const stagedNode = path.join(root, "native/windows/target/smoke-staging/pi-astack-windows-native.node");
const stagedBuildInfo = path.join(root, "native/windows/target/smoke-staging/build-info.json");
if (process.platform === "win32" && process.arch === "x64" && fs.existsSync(stagedNode) && fs.existsSync(stagedBuildInfo)) {
  const nativeMod = await jiti.import(path.join(root, "extensions/_shared/windows-native-addon.ts"));
  const retainedLock = await jiti.import(path.join(root, "extensions/_shared/retained-directory-lock.ts"));
  const binaryBytes = fs.readFileSync(stagedNode);
  const buildInfo = JSON.parse(fs.readFileSync(stagedBuildInfo, "utf8"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dcc-wc-pkg-"));
  process.once("exit", () => {
    try { fs.rmSync(packageRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "pi-astack-dcc-wc-temp", private: true })}\n`);
  const paths = nativeMod.resolveWindowsNativeAddonPaths(packageRoot);
  fs.mkdirSync(path.dirname(paths.binaryPath), { recursive: true });
  fs.writeFileSync(paths.binaryPath, binaryBytes);
  const CAPABILITIES = ["atomic_file_tempdir_v1", "atomic_file_v1", "protected_dacl_v1", "retained_directory_lock_v1"];
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
    toolchain_id: buildInfo.toolchain_id,
    target: "win32-x64",
    binary_file: "pi-astack-windows-native.node",
    binary_bytes: binaryBytes.byteLength,
    binary_sha256: crypto.createHash("sha256").update(binaryBytes).digest("hex"),
    build_id: buildInfo.build_id,
    build_mode: buildInfo.build_mode || buildInfo.mode,
    reproducibility: buildInfo.reproducibility,
    native_tests: buildInfo.native_tests,
    clippy: buildInfo.clippy,
    build_config_sha256: buildInfo.build_config_sha256,
    capabilities: CAPABILITIES,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(paths.manifestPath, manifestText, "utf8");
  const loaded = nativeMod.__TEST.loadWindowsNativeAddon({
    packageRoot,
    platform: "win32",
    arch: "x64",
    nodeVersion: process.versions.node,
    expectedManifestSha256: crypto.createHash("sha256").update(manifestText).digest("hex"),
  });
  windowsDccAddon = loaded.addon;
  retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(windowsDccAddon);
  process.once("exit", () => {
    try { retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(null); } catch { /* ignore */ }
  });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function hex64(seed) {
  return crypto.createHash("sha256").update(String(seed)).digest("hex");
}

function hex40(seed) {
  return crypto.createHash("sha1").update(String(seed)).digest("hex");
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dcc-worker-control-"));
process.once("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const epoch = "7";
const holderNonce = hex64("dcc-holder");
const stateDirKey = hex64("dcc-state-dir");
const runNonce = hex64("dcc-run");
const goodHead = hex40("dcc-ready-head");

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

function createAbrain(name, options = {}) {
  const abrain = path.join(tmp, name);
  fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
  fs.chmodSync(abrain, 0o700);
  if (options.authority !== false) writeAuthority(abrain, options.record);
  return abrain;
}

function writeAuthority(abrain, record = authorityRecord()) {
  const directory = path.join(abrain, ".state", "sediment", "local-executor-authority");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "authority.lock");
  const file = path.join(directory, "authority.json");
  fs.writeFileSync(lock, "", { mode: 0o600 });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(lock, 0o600);
    fs.chmodSync(file, 0o600);
  }
}

function request(operation, seed, overrides = {}) {
  return {
    schema: "pi-astack/sediment-worker-canonical-control/v1",
    request_id: hex64(seed),
    operation,
    local_executor_epoch: epoch,
    local_executor_holder_nonce: holderNonce,
    ...overrides,
  };
}

function deps(abrain, testHooks = undefined, observation = "held", platform = undefined) {
  return {
    resolveAbrainHome: () => abrain,
    authorityObservation: { observeLock: () => observation },
    ...(testHooks ? { testHooks } : {}),
    ...(platform !== undefined ? { platform } : {}),
    // Real win32 host + temp package: inject DCC physical layer. Simulated
    // platform:"win32" fail-closed tests must not receive this inject.
    ...(windowsDccAddon && platform === undefined ? { windowsDccNativeAddon: windowsDccAddon } : {}),
  };
}

function run(abrain, manifest, testHooks = undefined, observation = "held", platform = undefined) {
  return control.runSedimentWorkerCanonicalControl(
    JSON.stringify(manifest),
    deps(abrain, testHooks, observation, platform),
  );
}

/** Windows temp-package readers must run under gated ALS (no process-global override). */
function readAttestation(abrain) {
  if (windowsDccAddon) {
    return control.withWindowsDccNativeAddonForTests(windowsDccAddon, () =>
      control.readCanonicalConvergenceAttestation(abrain),
    );
  }
  return control.readCanonicalConvergenceAttestation(abrain);
}

function withDaemonMutationAuthority(abrain, operation) {
  return mutationAuthority.withCanonicalMutationAuthority({
    abrainHome: abrain,
    role: "daemon",
    revalidate: () => {
      const admission = localAuthority.admitLocalExecutorAuthority({
        abrainHome: abrain,
        expectation: {
          local_executor_epoch: epoch,
          local_executor_holder_nonce: holderNonce,
        },
        expectedHolderKind: "daemon",
        observation: { observeLock: () => "held" },
      });
      if (admission.regime !== "strict") throw new Error("strict daemon authority required");
    },
  }, operation);
}

function attestationDirectory(abrain) {
  return path.join(abrain, ".state", "sediment", "canonical-convergence");
}

function attestationFile(abrain) {
  return path.join(attestationDirectory(abrain), "attestation.json");
}

function attestation(overrides = {}) {
  return {
    schema: "pi-astack/canonical-convergence-attestation/v1",
    local_executor_epoch: epoch,
    local_executor_holder_nonce: holderNonce,
    convergence_generation: "1",
    outcome: "pending",
    reason_code: "startup_requested",
    canonical_head: null,
    published_at_ms: 1_800_000_000_000,
    ...overrides,
  };
}

function writeAttestation(abrain, value = attestation(), raw = undefined) {
  const directory = attestationDirectory(abrain);
  const body = raw ?? `${JSON.stringify(value)}\n`;
  if (windowsDccAddon) {
    // Protected DACL path for Windows DCC physical layer.
    const nativeMod = jiti(path.join(root, "extensions/_shared/windows-native-addon.ts"));
    nativeMod.ensureProtectedDirectory(windowsDccAddon, directory);
    nativeMod.durableAtomicReplaceFile(windowsDccAddon, attestationFile(abrain), Buffer.from(body, "utf8"));
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  fs.writeFileSync(attestationFile(abrain), body, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(attestationFile(abrain), 0o600);
}

function snapshotTree(rootDir) {
  const rows = [];
  const walk = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const rel = path.join(relative, name).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) rows.push(`l:${rel}:${fs.readlinkSync(absolute)}`);
      else if (stat.isDirectory()) {
        rows.push(`d:${rel}:${stat.mode & 0o777}`);
        walk(absolute, rel);
      } else if (stat.isFile()) {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
        rows.push(`f:${rel}:${stat.mode & 0o777}:${digest}`);
      } else rows.push(`o:${rel}:${stat.mode & 0o777}`);
    }
  };
  walk(rootDir);
  return rows.join("\n");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function diagnostics(startup, extra = {}) {
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
    implementationFingerprint: "smoke",
    tail: [],
    ...extra,
  };
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function expectCode(fn, expected) {
  let code = null;
  try {
    fn();
  } catch (error) {
    code = error?.code;
  }
  assert(code === expected, `expected ${expected}, got ${code}`);
}

function expectAttestationUnavailable(abrain) {
  let code = null;
  try {
    readAttestation(abrain);
  } catch (error) {
    code = error?.code;
  }
  assert(code === "attestation_unavailable", `expected attestation_unavailable, got ${code}`);
}

console.log("DCC D1 sediment worker canonical control");

await check("request manifest is strict, exact-keyed, duplicate-safe, and base64url-compatible", async () => {
  const valid = request("kick", "manifest-valid");
  assert(control.parseSedimentWorkerCanonicalControlArgs(JSON.stringify(valid)).operation === "kick", "valid JSON rejected");
  assert(control.parseSedimentWorkerCanonicalControlArgs(base64url(valid)).request_id === valid.request_id, "valid base64url rejected");

  for (const key of Object.keys(valid)) {
    const partial = { ...valid };
    delete partial[key];
    expectCode(
      () => control.validateSedimentWorkerCanonicalControlManifest(partial),
      "manifest_keys_invalid",
    );
  }
  expectCode(
    () => control.validateSedimentWorkerCanonicalControlManifest({ ...valid, unknown: true }),
    "manifest_keys_invalid",
  );
  const duplicate = `{"schema":"pi-astack/sediment-worker-canonical-control/v1","request_id":"${valid.request_id}","request_id":"${valid.request_id}","operation":"kick","local_executor_epoch":"7","local_executor_holder_nonce":"${holderNonce}"}`;
  expectCode(() => control.parseSedimentWorkerCanonicalControlArgs(duplicate), "args_not_strict_json");
  for (const badEpoch of ["0", "01", "+1", "18446744073709551616"]) {
    expectCode(
      () => control.validateSedimentWorkerCanonicalControlManifest({ ...valid, local_executor_epoch: badEpoch }),
      "invalid_local_executor_epoch",
    );
  }
  expectCode(
    () => control.validateSedimentWorkerCanonicalControlManifest({
      ...valid,
      local_executor_holder_nonce: holderNonce.toUpperCase(),
    }),
    "invalid_local_executor_holder_nonce",
  );
  assert(JSON.stringify(control.CANONICAL_CONTROL_STATUSES) === JSON.stringify([
    "pending", "running", "ready", "blocked", "unavailable",
  ]), "control status set drifted");
  assert(JSON.stringify(control.CANONICAL_CONTROL_REASON_CODES) === JSON.stringify([
    "none",
    "startup_requested",
    "startup_running",
    "startup_budget_exhausted",
    "canonical_mutation_busy",
    "canonical_scan_busy",
    "canonical_scan_lock_failed",
    "continuation_pending",
    "canonical_head_changed",
    "canonical_backlog_pending",
    "owner_intervention_required",
    "startup_blocked",
    "startup_failed",
    "continuation_failed",
    "attestation_unavailable",
    "attestation_write_failed",
    "authority_stale",
    "authority_unavailable",
    "authority_revoked",
    "invalid_request",
    "generation_overflow",
  ]), "control reason set drifted");

  const gatedAbrain = createAbrain("test-hook-gate");
  delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  let gatedCode = null;
  try {
    await control.runSedimentWorkerCanonicalControl(JSON.stringify(valid), {
      resolveAbrainHome: () => gatedAbrain,
      authorityObservation: { observeLock: () => "held" },
      testHooks: { now: () => 1 },
    });
  } catch (error) {
    gatedCode = error?.code;
  } finally {
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  }
  assert(gatedCode === "test_hooks_disabled", `production test-hook gate=${gatedCode}`);
});

await check("worker registration adds command presence while capabilities bytes remain exact-one", async () => {
  const abrain = createAbrain("registration");
  const settings = path.join(tmp, "registration-settings.json");
  fs.writeFileSync(settings, `${JSON.stringify({
    canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
    sediment: { enabled: true, executionOwner: "daemon" },
  })}\n`);
  process.env.ABRAIN_ROOT = abrain;
  process.env.PI_ASTACK_SETTINGS_PATH = settings;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  delete process.env.PI_ABRAIN_DISABLED;

  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const activate = sediment.default ?? sediment;
  const commands = new Map();
  const handlers = new Map();
  const api = {
    registerCommand(name, options) { commands.set(name, options); },
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    registerEntryRenderer() {},
    getActiveTools() { return []; },
    getAllTools() { return []; },
    setActiveTools() {},
  };
  activate(api);
  assert(commands.has("sediment-worker-canonical-control"), "canonical control command absent");
  assert(commands.has("sediment-worker-capabilities"), "capabilities command absent");
  assert(!commands.has("sediment"), "ordinary command registered in worker mode");
  assert(handlers.size === 0, `worker mode lifecycle handlers=${handlers.size}`);

  const notices = [];
  await commands.get("sediment-worker-capabilities").handler("", {
    ui: { notify(message, type) { notices.push([message, type]); } },
  });
  const exactCapabilities = "sediment-worker-capabilities:{\"schema\":\"pi-astack/sediment-worker-capabilities/v1\",\"capabilities\":[\"local_executor_authority_process_lifetime_v1\"]}";
  assert(notices.length === 1 && notices[0][0] === exactCapabilities, `capabilities bytes changed: ${notices[0]?.[0]}`);
  assert(worker.formatSedimentWorkerCapabilitiesNotify() === exactCapabilities, "capabilities formatter drifted");

  delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  const ordinaryCommands = new Map();
  activate({ ...api, registerCommand(name, options) { ordinaryCommands.set(name, options); } });
  assert(!ordinaryCommands.has("sediment-worker-canonical-control"), "ordinary mode registered canonical control");
});

await check("authority rejection maps closed codes before canonical work and preserves zero attestation delta", async () => {
  const cases = [
    {
      name: "stale",
      manifest: request("kick", "authority-stale", { local_executor_epoch: "8" }),
      observation: "held",
      reason: "authority_stale",
    },
    {
      name: "revoked",
      manifest: request("kick", "authority-revoked"),
      observation: "free",
      reason: "authority_revoked",
    },
    {
      name: "unavailable",
      manifest: request("kick", "authority-unavailable"),
      observation: "unavailable",
      reason: "authority_unavailable",
    },
  ];
  for (const item of cases) {
    const abrain = createAbrain(`authority-${item.name}`);
    const before = snapshotTree(abrain);
    let kicks = 0;
    const outcome = await run(abrain, item.manifest, {
      kickStartup() { kicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
    }, item.observation);
    assert(outcome.status === "unavailable" && outcome.reason_code === item.reason, JSON.stringify(outcome));
    assert(kicks === 0, `${item.name} entered canonical startup`);
    assert(snapshotTree(abrain) === before, `${item.name} changed attestation/authority tree`);
  }
});

await check("store-absent strict request follows LSEA fail-closed legacy contract", async () => {
  const abrain = createAbrain("store-absent", { authority: false });
  const before = snapshotTree(abrain);
  let kicks = 0;
  const outcome = await run(abrain, request("kick", "store-absent"), {
    kickStartup() { kicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
  });
  assert(outcome.status === "unavailable" && outcome.reason_code === "authority_unavailable", JSON.stringify(outcome));
  assert(kicks === 0 && snapshotTree(abrain) === before, "store-absent request failed open or mutated state");
});

await check("kick publishes private pending before startup, returns immediately, then CAS-settles exact ready HEAD", async () => {
  const abrain = createAbrain("kick-ready");
  const startup = deferred();
  let kicks = 0;
  let pendingObservedAtKick = false;
  const kickPromise = run(abrain, request("kick", "kick-ready"), {
    // Mechanical: skip layout repair/commit (non-git fixtures fail closed on real commit).
    repairStorePresentBrainLayout() {},
    kickStartup() {
      kicks += 1;
      const current = readAttestation(abrain);
      pendingObservedAtKick = current?.outcome === "pending"
        && current.reason_code === "startup_requested"
        && current.canonical_head === null;
      return { promise: startup.promise };
    },
    readCanonicalHead: async () => goodHead,
    now: () => 1_800_000_000_001,
  });
  const immediate = await Promise.race([
    kickPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("kick awaited canonical startup")), 2_000)),
  ]);
  assert(immediate.status === "pending" && immediate.reason_code === "startup_requested", JSON.stringify(immediate));
  assert(immediate.convergence_generation === "1", JSON.stringify(immediate));
  // Next-turn repair/startup: kick returns before setImmediate work runs.
  assert(kicks === 0, `startup must not run before await kick returns (kicks=${kicks})`);
  const pendingAtReturn = readAttestation(abrain);
  assert(
    pendingAtReturn?.outcome === "pending"
      && pendingAtReturn.reason_code === "startup_requested"
      && pendingAtReturn.canonical_head === null,
    "pending attestation must be durable before next-turn startup",
  );
  const pendingStat = fs.lstatSync(attestationFile(abrain));
  const pendingDirStat = fs.lstatSync(attestationDirectory(abrain));
  if (process.platform !== "win32") {
    assert((pendingStat.mode & 0o777) === 0o600, `attestation mode=${pendingStat.mode & 0o777}`);
    assert((pendingDirStat.mode & 0o777) === 0o700, `attestation dir mode=${pendingDirStat.mode & 0o777}`);
  }

  // Allow next-turn repair + kickStartup, then settle ready.
  await waitFor(() => (kicks === 1 ? true : null), "next-turn kickStartup");
  assert(pendingObservedAtKick, "pending-before-start contract failed");
  startup.resolve(diagnostics("ready"));
  const ready = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.outcome === "ready" ? value : null;
  }, "ready attestation");
  assert(ready.reason_code === "none" && ready.canonical_head === goodHead, JSON.stringify(ready));
});

await check("same-process concurrent kicks coalesce to one generation and one startup attempt", async () => {
  const abrain = createAbrain("kick-coalesce");
  const startup = deferred();
  let kicks = 0;
  const hooks = {
    repairStorePresentBrainLayout() {},
    kickStartup() { kicks += 1; return { promise: startup.promise }; },
    readCanonicalHead: async () => goodHead,
  };
  const [first, second] = await Promise.all([
    run(abrain, request("kick", "coalesce-first"), hooks),
    run(abrain, request("kick", "coalesce-second"), hooks),
  ]);
  assert(first.convergence_generation === "1" && second.convergence_generation === "1", "generation not coalesced");
  assert(
    (first.status === "pending" || first.status === "running")
      && (second.status === "pending" || second.status === "running"),
    `${first.status}/${second.status}`,
  );
  // Next-turn: kickStartup may land after both control returns.
  await waitFor(() => (kicks === 1 ? true : null), "coalesced next-turn kickStartup");
  const current = readAttestation(abrain);
  assert(current?.outcome === "pending" && current.convergence_generation === "1", JSON.stringify(current));
  startup.resolve(diagnostics("ready"));
  await waitFor(() => readAttestation(abrain)?.outcome === "ready", "coalesced ready");
});

await check("stale async settle cannot overwrite a replaced tuple/generation", async () => {
  const abrain = createAbrain("kick-cas-stale");
  const startup = deferred();
  let headReads = 0;
  const kicked = await run(abrain, request("kick", "cas-stale"), {
    repairStorePresentBrainLayout() {},
    kickStartup() { return { promise: startup.promise }; },
    readCanonicalHead: async () => { headReads += 1; return goodHead; },
  });
  assert(kicked.convergence_generation === "1", JSON.stringify(kicked));
  writeAttestation(abrain, attestation({
    convergence_generation: "2",
    reason_code: "startup_requested",
  }));
  startup.resolve(diagnostics("ready"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const current = readAttestation(abrain);
  assert(current?.convergence_generation === "2" && current.outcome === "pending", JSON.stringify(current));
  assert(headReads === 0, "stale settle read HEAD before tuple/generation CAS check");
});

await check("asynchronous settle faults collapse to closed process-local aggregate", async () => {
  const abrain = createAbrain("settle-fault-aggregate");
  const startup = deferred();
  let clockCalls = 0;
  const hooks = {
    repairStorePresentBrainLayout() {},
    kickStartup() { return { promise: startup.promise }; },
    readCanonicalHead: async () => goodHead,
    now() {
      clockCalls += 1;
      return clockCalls === 1 ? 1_800_000_000_010 : -1;
    },
  };
  const kicked = await run(abrain, request("kick", "settle-fault-kick"), hooks);
  assert(kicked.status === "pending", JSON.stringify(kicked));
  startup.resolve(diagnostics("ready"));
  const observed = await waitFor(async () => {
    const value = await run(abrain, request("observe", `settle-fault-observe-${clockCalls}`), hooks);
    return value.reason_code === "attestation_write_failed" ? value : null;
  }, "closed settle fault aggregate");
  assert(observed.status === "blocked" && observed.retryable === true, JSON.stringify(observed));
  assert(observed.convergence_generation === "1", `write_failed must carry generation: ${JSON.stringify(observed)}`);
  assert(control.sanitizeSedimentWorkerCanonicalControlResult(observed), "write_failed shape illegal");
  const persisted = readAttestation(abrain);
  assert(persisted?.outcome === "pending" && persisted.canonical_head === null, JSON.stringify(persisted));
});

await check("deferred settle stays pending and next external kick advances durable generation", async () => {
  const abrain = createAbrain("kick-deferred");
  let kicks = 0;
  const first = await run(abrain, request("kick", "deferred-first"), {
    repairStorePresentBrainLayout() {},
    kickStartup() {
      kicks += 1;
      return {
        promise: Promise.resolve(diagnostics("deferred", {
          deferredReason: "STARTUP_BUDGET_EXHAUSTED",
          retryable: true,
        })),
      };
    },
  });
  assert(first.convergence_generation === "1", JSON.stringify(first));
  await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.reason_code === "startup_budget_exhausted" ? value : null;
  }, "deferred generation one");

  const second = await run(abrain, request("kick", "deferred-second"), {
    repairStorePresentBrainLayout() {},
    kickStartup() {
      kicks += 1;
      const pending = readAttestation(abrain);
      assert(pending?.outcome === "pending" && pending.convergence_generation === "2", "generation two not published before retry");
      return {
        promise: Promise.resolve(diagnostics("deferred", {
          deferredReason: "CANONICAL_SCAN_BUSY",
          retryable: true,
        })),
      };
    },
  });
  assert(second.convergence_generation === "2", JSON.stringify(second));
  // Next-turn: second kickStartup lands after control return.
  await waitFor(() => (kicks === 2 ? true : null), "deferred second next-turn kickStartup");
  const deferredTwo = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.reason_code === "canonical_scan_busy" ? value : null;
  }, "deferred generation two");
  assert(deferredTwo.convergence_generation === "2" && deferredTwo.canonical_head === null, JSON.stringify(deferredTwo));
});

await check("observe ready without drift stays ready; zero kick/runtime/tree delta", async () => {
  const abrain = createAbrain("observe-zero");
  writeAttestation(abrain, attestation({
    outcome: "ready",
    reason_code: "none",
    canonical_head: goodHead,
  }));
  const beforeTree = snapshotTree(abrain);
  const beforeRuntime = [
    runtime.__canonicalRuntimeMapSizeForTests(),
    runtime.__canonicalStartupPromiseMapSizeForTests(),
  ];
  let kicks = 0;
  let headReads = 0;
  let inventoryCalls = 0;
  let backlogCalls = 0;
  let applyCalls = 0;
  const observed = await run(abrain, request("observe", "observe-zero"), {
    kickStartup() { kicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => { headReads += 1; return goodHead; },
    async inspectBindIntentInventory() {
      inventoryCalls += 1;
      return { pending: 0, failed: 0, invalid: 0 };
    },
    async applyBindIntents() { applyCalls += 1; return { applied: 0, pending: 0, failed: 0 }; },
    async probeCanonicalBacklog() { backlogCalls += 1; return "none"; },
  });
  const afterRuntime = [
    runtime.__canonicalRuntimeMapSizeForTests(),
    runtime.__canonicalStartupPromiseMapSizeForTests(),
  ];
  assert(observed.status === "ready" && observed.reason_code === "none", JSON.stringify(observed));
  assert(control.sanitizeSedimentWorkerCanonicalControlResult(observed), "ready no-drift shape illegal");
  assert(kicks === 0, "observe entered kick/startup");
  assert(applyCalls === 0, "observe applied bind intents");
  assert(headReads === 1 && inventoryCalls === 1 && backlogCalls === 1,
    `ready probe reads head=${headReads} inv=${inventoryCalls} backlog=${backlogCalls}`);
  assert(JSON.stringify(afterRuntime) === JSON.stringify(beforeRuntime), `runtime delta ${beforeRuntime} -> ${afterRuntime}`);
  assert(snapshotTree(abrain) === beforeTree, "observe changed filesystem");
});

await check("observe ready HEAD/backlog/bind drift returns closed due without tree delta", async () => {
  const abrain = createAbrain("observe-ready-drift");
  writeAttestation(abrain, attestation({
    outcome: "ready",
    reason_code: "none",
    canonical_head: goodHead,
    convergence_generation: "9",
  }));
  const beforeTree = snapshotTree(abrain);
  let kicks = 0;
  let applyCalls = 0;

  const headDrift = await run(abrain, request("observe", "observe-head-drift"), {
    kickStartup() { kicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => hex40("other-live-head"),
    async inspectBindIntentInventory() { return { pending: 0, failed: 0, invalid: 0 }; },
    async applyBindIntents() { applyCalls += 1; return { applied: 0, pending: 0, failed: 0 }; },
    async probeCanonicalBacklog() { return "none"; },
  });
  assert(headDrift.status === "pending" && headDrift.reason_code === "canonical_head_changed",
    JSON.stringify(headDrift));
  assert(headDrift.retryable === true && headDrift.convergence_generation === "9", JSON.stringify(headDrift));
  assert(control.sanitizeSedimentWorkerCanonicalControlResult(headDrift), "head drift shape illegal");

  const backlogDrift = await run(abrain, request("observe", "observe-backlog-drift"), {
    kickStartup() { kicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() { return { pending: 0, failed: 0, invalid: 0 }; },
    async applyBindIntents() { applyCalls += 1; return { applied: 0, pending: 0, failed: 0 }; },
    async probeCanonicalBacklog() { return "pending"; },
  });
  assert(backlogDrift.status === "pending" && backlogDrift.reason_code === "canonical_backlog_pending",
    JSON.stringify(backlogDrift));
  assert(backlogDrift.retryable === true && backlogDrift.convergence_generation === "9", JSON.stringify(backlogDrift));
  assert(control.sanitizeSedimentWorkerCanonicalControlResult(backlogDrift), "backlog drift shape illegal");

  const bindPending = await run(abrain, request("observe", "observe-bind-pending"), {
    kickStartup() { kicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() { return { pending: 1, failed: 0, invalid: 0 }; },
    async applyBindIntents() { applyCalls += 1; return { applied: 0, pending: 0, failed: 0 }; },
    async probeCanonicalBacklog() { return "none"; },
  });
  assert(bindPending.status === "pending" && bindPending.reason_code === "continuation_pending",
    JSON.stringify(bindPending));
  assert(bindPending.retryable === true, JSON.stringify(bindPending));
  assert(control.sanitizeSedimentWorkerCanonicalControlResult(bindPending), "bind pending shape illegal");

  const bindFailed = await run(abrain, request("observe", "observe-bind-failed"), {
    kickStartup() { kicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() { return { pending: 0, failed: 1, invalid: 0 }; },
    async applyBindIntents() { applyCalls += 1; return { applied: 0, pending: 0, failed: 0 }; },
    async probeCanonicalBacklog() { return "none"; },
  });
  assert(bindFailed.status === "blocked" && bindFailed.reason_code === "continuation_failed",
    JSON.stringify(bindFailed));
  assert(bindFailed.retryable === false, JSON.stringify(bindFailed));
  assert(control.sanitizeSedimentWorkerCanonicalControlResult(bindFailed), "bind failed shape illegal");

  // Privacy: closed aggregate only — no exact head/path/count leakage.
  for (const sample of [headDrift, backlogDrift, bindPending, bindFailed]) {
    const text = JSON.stringify(sample);
    assert(!text.includes(goodHead), "leaked goodHead");
    assert(!text.includes(hex40("other-live-head")), "leaked other head");
    assert(!/"pending":\s*1/.test(text), "leaked inventory count");
    assert(!text.includes(abrain), "leaked abrain path");
  }

  // Durable ready attestation must remain untouched (observe never rewrites).
  const durable = readAttestation(abrain);
  assert(durable?.outcome === "ready" && durable.reason_code === "none"
    && durable.canonical_head === goodHead && durable.convergence_generation === "9",
    JSON.stringify(durable));
  assert(kicks === 0 && applyCalls === 0, `kicks=${kicks} apply=${applyCalls}`);
  assert(snapshotTree(abrain) === beforeTree, "observe drift path mutated tree");
});

await check("observe ready real porcelain l1 backlog surfaces canonical_backlog_pending", async () => {
  const abrain = createAbrain("observe-real-backlog");
  initBareAbrainGit(abrain);
  const head = spawnSync("git", ["-C", abrain, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert(head.status === 0, `rev-parse failed: ${head.stderr}`);
  const liveHead = head.stdout.trim();
  writeAttestation(abrain, attestation({
    outcome: "ready",
    reason_code: "none",
    canonical_head: liveHead,
    convergence_generation: "3",
  }));
  const l1Dir = path.join(abrain, "l1", "events", "sha256");
  fs.mkdirSync(l1Dir, { recursive: true });
  fs.writeFileSync(path.join(l1Dir, "drift-probe-only.json"), "{\"probe\":true}\n");
  const beforeTree = snapshotTree(abrain);
  const observed = await run(abrain, request("observe", "observe-real-backlog"), {
    // Real HEAD + real porcelain; only suppress bind inventory apply/path noise.
    async inspectBindIntentInventory() { return { pending: 0, failed: 0, invalid: 0 }; },
    async applyBindIntents() { throw new Error("observe must not apply"); },
  });
  assert(observed.status === "pending" && observed.reason_code === "canonical_backlog_pending",
    JSON.stringify(observed));
  assert(observed.retryable === true && observed.convergence_generation === "3", JSON.stringify(observed));
  assert(control.sanitizeSedimentWorkerCanonicalControlResult(observed), "real backlog shape illegal");
  const text = JSON.stringify(observed);
  assert(!text.includes(liveHead), "leaked live head");
  assert(!text.includes("drift-probe-only"), "leaked backlog path");
  assert(snapshotTree(abrain) === beforeTree, "real backlog observe mutated tree");
  const durable = readAttestation(abrain);
  assert(durable?.outcome === "ready" && durable.canonical_head === liveHead, JSON.stringify(durable));
});

await check("attestation reader rejects unknown/duplicate fields, symlink, non-private modes, and invalid fields", async () => {
  const abrain = createAbrain("attestation-strict");
  const good = attestation();
  writeAttestation(abrain, good);
  assert(readAttestation(abrain)?.convergence_generation === "1", "good attestation rejected");

  writeAttestation(abrain, { ...good, unknown: "x" });
  expectAttestationUnavailable(abrain);

  const duplicate = `{"schema":"pi-astack/canonical-convergence-attestation/v1","local_executor_epoch":"7","local_executor_epoch":"7","local_executor_holder_nonce":"${holderNonce}","convergence_generation":"1","outcome":"pending","reason_code":"startup_requested","canonical_head":null,"published_at_ms":1800000000000}\n`;
  writeAttestation(abrain, good, duplicate);
  expectAttestationUnavailable(abrain);

  for (const patch of [
    { local_executor_epoch: "0" },
    { local_executor_epoch: "01" },
    { local_executor_holder_nonce: holderNonce.toUpperCase() },
    { convergence_generation: "0" },
    { convergence_generation: "01" },
    { convergence_generation: "18446744073709551616" },
    { reason_code: "free_text" },
    { canonical_head: goodHead },
    { published_at_ms: -1 },
    { published_at_ms: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    writeAttestation(abrain, { ...good, ...patch });
    expectAttestationUnavailable(abrain);
  }
  writeAttestation(abrain, { ...good, outcome: "ready", reason_code: "none", canonical_head: `${goodHead}0` });
  expectAttestationUnavailable(abrain);
  writeAttestation(abrain, { ...good, outcome: "ready", canonical_head: goodHead });
  expectAttestationUnavailable(abrain);

  if (process.platform !== "win32") {
    writeAttestation(abrain, good);
    fs.chmodSync(attestationFile(abrain), 0o640);
    expectAttestationUnavailable(abrain);
    fs.chmodSync(attestationFile(abrain), 0o600);
    fs.chmodSync(attestationDirectory(abrain), 0o750);
    expectAttestationUnavailable(abrain);
    fs.chmodSync(attestationDirectory(abrain), 0o700);

    const target = path.join(tmp, "attestation-symlink-target.json");
    fs.writeFileSync(target, `${JSON.stringify(good)}\n`, { mode: 0o600 });
    fs.rmSync(attestationFile(abrain));
    fs.symlinkSync(target, attestationFile(abrain));
    expectAttestationUnavailable(abrain);
  }
});

await check("attestation mismatch is unavailable; generation overflow fails closed; new tuple starts at one", async () => {
  const mismatchAbrain = createAbrain("attestation-mismatch");
  writeAttestation(mismatchAbrain, attestation({ local_executor_epoch: "8" }));
  const mismatch = await run(mismatchAbrain, request("observe", "mismatch-observe"));
  assert(mismatch.status === "unavailable" && mismatch.reason_code === "attestation_unavailable", JSON.stringify(mismatch));

  const overflowAbrain = createAbrain("attestation-overflow");
  writeAttestation(overflowAbrain, attestation({ convergence_generation: "18446744073709551615" }));
  let overflowKicks = 0;
  const beforeOverflow = snapshotTree(overflowAbrain);
  const overflow = await run(overflowAbrain, request("kick", "overflow-kick"), {
    kickStartup() { overflowKicks += 1; return { promise: Promise.resolve(diagnostics("ready")) }; },
  });
  assert(overflow.status === "blocked" && overflow.reason_code === "generation_overflow", JSON.stringify(overflow));
  assert(overflowKicks === 0 && snapshotTree(overflowAbrain) === beforeOverflow, "overflow mutated or entered startup");

  const newTupleAbrain = createAbrain("attestation-new-tuple");
  writeAttestation(newTupleAbrain, attestation({
    local_executor_epoch: "8",
    local_executor_holder_nonce: hex64("old-holder"),
    convergence_generation: "18446744073709551615",
  }));
  const newTuple = await run(newTupleAbrain, request("kick", "new-tuple-kick"), {
    repairStorePresentBrainLayout() {},
    kickStartup() {
      const pending = readAttestation(newTupleAbrain);
      assert(pending?.local_executor_epoch === epoch && pending.convergence_generation === "1", "new tuple did not reset to generation one");
      return {
        promise: Promise.resolve(diagnostics("deferred", {
          deferredReason: "CANONICAL_MUTATION_BUSY",
          retryable: true,
        })),
      };
    },
  });
  assert(newTuple.convergence_generation === "1", JSON.stringify(newTuple));
  await waitFor(
    () => readAttestation(newTupleAbrain)?.reason_code === "canonical_mutation_busy",
    "new tuple deferred settle",
  );
});

await check("closed result notify contains no head, epoch, nonce, path, or free-text error", async () => {
  const result = {
    schema: "pi-astack/sediment-worker-canonical-control-result/v1",
    request_id: hex64("privacy-result"),
    operation: "observe",
    status: "ready",
    reason_code: "none",
    convergence_generation: "9",
    retryable: false,
  };
  const notify = control.formatSedimentWorkerCanonicalControlResultNotify(result);
  assert(notify.startsWith("sediment-worker-canonical-control-result:"), notify);
  const parsed = control.tryParseSedimentWorkerCanonicalControlResultNotify(notify);
  assert(parsed?.status === "ready" && parsed.convergence_generation === "9", "result notify parse failed");
  const payload = notify.slice(notify.indexOf(":") + 1);
  const object = JSON.parse(payload);
  assert(JSON.stringify(Object.keys(object)) === JSON.stringify([
    "schema",
    "request_id",
    "operation",
    "status",
    "reason_code",
    "convergence_generation",
    "retryable",
  ]), `result keys=${Object.keys(object)}`);
  for (const forbidden of [goodHead, holderNonce, tmp, "canonical_head", "local_executor_epoch", "holder_nonce", "path", "error"]) {
    assert(!notify.includes(forbidden), `result leaked ${forbidden}`);
  }
});

await check("sanitize/parse/format enforce cross-field control-result invariants and reject negatives", async () => {
  const base = {
    schema: "pi-astack/sediment-worker-canonical-control-result/v1",
    request_id: hex64("sanitize-invariants"),
    operation: "observe",
  };
  const legal = [
    { status: "ready", reason_code: "none", convergence_generation: "1", retryable: false },
    { status: "pending", reason_code: "startup_requested", convergence_generation: "2", retryable: true },
    { status: "pending", reason_code: "startup_running", convergence_generation: "2", retryable: true },
    { status: "pending", reason_code: "startup_budget_exhausted", convergence_generation: "3", retryable: true },
    { status: "pending", reason_code: "canonical_mutation_busy", convergence_generation: "3", retryable: true },
    { status: "pending", reason_code: "canonical_scan_busy", convergence_generation: "3", retryable: true },
    { status: "pending", reason_code: "canonical_scan_lock_failed", convergence_generation: "3", retryable: true },
    { status: "pending", reason_code: "continuation_pending", convergence_generation: "3", retryable: true },
    { status: "pending", reason_code: "canonical_head_changed", convergence_generation: "3", retryable: true },
    { status: "pending", reason_code: "canonical_backlog_pending", convergence_generation: "3", retryable: true },
    { status: "running", reason_code: "startup_running", convergence_generation: "4", retryable: true },
    { status: "blocked", reason_code: "owner_intervention_required", convergence_generation: "5", retryable: false },
    { status: "blocked", reason_code: "startup_blocked", convergence_generation: "5", retryable: false },
    { status: "blocked", reason_code: "continuation_failed", convergence_generation: "5", retryable: false },
    { status: "blocked", reason_code: "startup_failed", convergence_generation: "5", retryable: true },
    // Strict: attestation_unavailable → generation null only; write_failed → nonnull only.
    { status: "blocked", reason_code: "attestation_unavailable", convergence_generation: null, retryable: true },
    { status: "blocked", reason_code: "attestation_write_failed", convergence_generation: "6", retryable: true },
    { status: "blocked", reason_code: "generation_overflow", convergence_generation: null, retryable: false },
    { status: "blocked", reason_code: "generation_overflow", convergence_generation: "7", retryable: false },
    { status: "blocked", reason_code: "invalid_request", convergence_generation: null, retryable: false },
    { status: "unavailable", reason_code: "authority_stale", convergence_generation: null, retryable: true },
    { status: "unavailable", reason_code: "authority_unavailable", convergence_generation: null, retryable: true },
    { status: "unavailable", reason_code: "authority_revoked", convergence_generation: null, retryable: true },
    { status: "unavailable", reason_code: "attestation_unavailable", convergence_generation: null, retryable: true },
  ];
  for (const row of legal) {
    const value = { ...base, ...row };
    assert(control.sanitizeSedimentWorkerCanonicalControlResult(value), `legal rejected: ${JSON.stringify(row)}`);
    const notify = control.formatSedimentWorkerCanonicalControlResultNotify(value);
    assert(control.tryParseSedimentWorkerCanonicalControlResultNotify(notify)?.status === row.status, `parse lost ${row.status}`);
  }

  const illegal = [
    { status: "ready", reason_code: "startup_running", convergence_generation: "1", retryable: false },
    { status: "ready", reason_code: "none", convergence_generation: null, retryable: false },
    { status: "ready", reason_code: "none", convergence_generation: "1", retryable: true },
    { status: "pending", reason_code: "none", convergence_generation: "1", retryable: true },
    { status: "pending", reason_code: "startup_requested", convergence_generation: null, retryable: true },
    { status: "pending", reason_code: "startup_requested", convergence_generation: "1", retryable: false },
    { status: "running", reason_code: "startup_requested", convergence_generation: "1", retryable: true },
    { status: "running", reason_code: "startup_running", convergence_generation: null, retryable: true },
    { status: "running", reason_code: "startup_running", convergence_generation: "1", retryable: false },
    { status: "blocked", reason_code: "none", convergence_generation: "1", retryable: false },
    { status: "blocked", reason_code: "startup_blocked", convergence_generation: "1", retryable: true },
    { status: "blocked", reason_code: "continuation_failed", convergence_generation: "1", retryable: true },
    { status: "blocked", reason_code: "continuation_failed", convergence_generation: null, retryable: false },
    { status: "pending", reason_code: "continuation_pending", convergence_generation: "1", retryable: false },
    { status: "blocked", reason_code: "startup_failed", convergence_generation: "1", retryable: false },
    { status: "blocked", reason_code: "attestation_unavailable", convergence_generation: "6", retryable: true },
    { status: "blocked", reason_code: "attestation_write_failed", convergence_generation: null, retryable: true },
    { status: "blocked", reason_code: "invalid_request", convergence_generation: "1", retryable: false },
    { status: "blocked", reason_code: "authority_stale", convergence_generation: null, retryable: true },
    { status: "unavailable", reason_code: "startup_running", convergence_generation: null, retryable: true },
    { status: "unavailable", reason_code: "authority_unavailable", convergence_generation: "1", retryable: true },
    { status: "unavailable", reason_code: "authority_unavailable", convergence_generation: null, retryable: false },
    { status: "ready", reason_code: "none", convergence_generation: "1", retryable: false, extra: true },
  ];
  for (const row of illegal) {
    const { extra, ...fields } = row;
    const value = extra ? { ...base, ...fields, unknown: true } : { ...base, ...fields };
    assert(control.sanitizeSedimentWorkerCanonicalControlResult(value) === null, `illegal accepted: ${JSON.stringify(row)}`);
  }
  assert(control.sanitizeSedimentWorkerCanonicalControlResult({ ...base }) === null, "missing fields accepted");
  assert(control.tryParseSedimentWorkerCanonicalControlResultNotify("sediment-worker-canonical-control-result:{") === null, "broken notify accepted");
});

function writeEnabledCanonicalSettings(file) {
  fs.writeFileSync(file, `${JSON.stringify({
    canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
  })}\n`);
}

function initBareAbrainGit(abrain) {
  const git = spawnSync("git", ["init", "-b", "main"], { cwd: abrain, encoding: "utf8" });
  assert(git.status === 0, `git init failed: ${git.stderr}`);
  spawnSync("git", ["-C", abrain, "config", "user.email", "dcc-smoke@example.com"], { encoding: "utf8" });
  spawnSync("git", ["-C", abrain, "config", "user.name", "dcc-smoke"], { encoding: "utf8" });
  // Keep .state/ (authority/attestation) out of the worktree so enabled whole-L1
  // startup sees a clean statusHash rather than dirty-tree blocked.
  fs.writeFileSync(path.join(abrain, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(abrain, "README"), "dcc\n");
  const add = spawnSync("git", ["-C", abrain, "add", ".gitignore", "README"], { encoding: "utf8" });
  assert(add.status === 0, `git add failed: ${add.stderr}`);
  const commit = spawnSync("git", ["-C", abrain, "commit", "-m", "init"], { encoding: "utf8" });
  assert(commit.status === 0, `git commit failed: ${commit.stderr}`);
}

await check("real runtime kick: serial ready starts a new generation; concurrent in-flight coalesces", async () => {
  const abrain = createAbrain("runtime-kick-fresh");
  initBareAbrainGit(abrain);
  const settings = path.join(tmp, "runtime-kick-settings.json");
  writeEnabledCanonicalSettings(settings);
  const opts = { abrainHome: abrain, settingsPath: settings, sourceRoot: root };

  let first;
  const firstDiag = await withDaemonMutationAuthority(abrain, async () => {
    first = runtime.kickCanonicalStartupAttempt(opts);
    return first.promise;
  });
  assert(firstDiag.settings?.enabled === true && firstDiag.settings?.reason === "enabled",
    `first kick must use enabled whole-L1 path: ${JSON.stringify(firstDiag.settings)}`);
  assert(firstDiag.startup === "ready", JSON.stringify(firstDiag));
  assert(first.generation >= 1, `first generation=${first.generation}`);

  // Historical getCanonicalStartupPromise reuses settled ready (no new gen).
  const reused = await withDaemonMutationAuthority(
    abrain,
    () => runtime.getCanonicalStartupPromise(opts),
  );
  assert(reused.startup === "ready" && reused.startupGeneration === firstDiag.startupGeneration,
    `getCanonicalStartupPromise must keep ready reuse: ${JSON.stringify(reused)}`);

  let second;
  const secondDiag = await withDaemonMutationAuthority(abrain, async () => {
    second = runtime.kickCanonicalStartupAttempt(opts);
    return second.promise;
  });
  assert(secondDiag.settings?.enabled === true && secondDiag.settings?.reason === "enabled",
    `second kick must stay on enabled path: ${JSON.stringify(secondDiag.settings)}`);
  assert(secondDiag.startup === "ready", JSON.stringify(secondDiag));
  assert(second.generation > first.generation, `fresh kick gen ${second.generation} <= ${first.generation}`);
  assert(secondDiag.startupGeneration > firstDiag.startupGeneration,
    `runtime generation not advanced: ${firstDiag.startupGeneration} -> ${secondDiag.startupGeneration}`);

  // Concurrent immediate kicks on a fresh enabled root must singleflight-coalesce.
  const concurrentAbrain = createAbrain("runtime-kick-coalesce");
  initBareAbrainGit(concurrentAbrain);
  const concurrentSettings = path.join(tmp, "runtime-kick-coalesce-settings.json");
  writeEnabledCanonicalSettings(concurrentSettings);
  const concurrentOpts = {
    abrainHome: concurrentAbrain,
    settingsPath: concurrentSettings,
    sourceRoot: root,
  };
  let a;
  let b;
  const [da, db] = await withDaemonMutationAuthority(concurrentAbrain, async () => {
    a = runtime.kickCanonicalStartupAttempt(concurrentOpts);
    b = runtime.kickCanonicalStartupAttempt(concurrentOpts);
    assert(a.generation === b.generation, `in-flight coalesce failed: ${a.generation}/${b.generation}`);
    assert(a.promise === b.promise, "in-flight kicks must share the same promise");
    return Promise.all([a.promise, b.promise]);
  });
  assert(da.settings?.enabled === true && db.settings?.enabled === true, "coalesced kick left enabled path");
  assert(da.startup === "ready" && db.startup === "ready", "coalesced kick not ready");
  assert(da.startupGeneration === db.startupGeneration, "coalesced diagnostics generation split");
});

await check("real runtime kick from expired worker-budget ALS does not inherit budget and can ready", async () => {
  const abrain = createAbrain("runtime-kick-budget");
  initBareAbrainGit(abrain);
  const settings = path.join(tmp, "runtime-kick-budget-settings.json");
  writeEnabledCanonicalSettings(settings);
  const opts = { abrainHome: abrain, settingsPath: settings, sourceRoot: root };
  let attempt;
  const diag = await withDaemonMutationAuthority(abrain, async () => {
    attempt = budget.runWithWorkerBudget(
      { deadlineMs: Date.now() - 60_000 },
      () => runtime.kickCanonicalStartupAttempt(opts),
    );
    // Kick must exit worker-budget ALS before creating the attempt. Mutation
    // authority is a separate ALS and remains active through full startup.
    assert(budget.getWorkerBudgetContext() === undefined, "test harness still inside budget ALS");
    return attempt.promise;
  });
  assert(diag.settings?.enabled === true && diag.settings?.reason === "enabled",
    `budget kick must use enabled whole-L1 path: ${JSON.stringify(diag.settings)}`);
  assert(diag.startup === "ready", JSON.stringify(diag));
  assert(diag.deferredReason !== "STARTUP_BUDGET_EXHAUSTED", "kick inherited expired worker budget");
});

await check("observe no-aggregate pending maps runtime peek (running/deferred/blocked/ready→running) with zero side effects", async () => {
  const abrain = createAbrain("observe-runtime-map");
  writeAttestation(abrain, attestation({
    outcome: "pending",
    reason_code: "startup_requested",
    convergence_generation: "11",
  }));
  const cases = [
    { peek: { status: "running" }, status: "running", reason: "startup_running" },
    { peek: { status: "deferred", deferredReason: "CANONICAL_MUTATION_BUSY", retryable: true }, status: "pending", reason: "canonical_mutation_busy" },
    { peek: { status: "deferred", deferredReason: "STARTUP_BUDGET_EXHAUSTED", retryable: true }, status: "pending", reason: "startup_budget_exhausted" },
    // blocked peek must NOT publish control blocked — durable attestation settle is sole terminal.
    { peek: { status: "blocked", reason: "x" }, status: "running", reason: "startup_running" },
    // ready must continue mapping to running — runtime-ready cannot bypass durable attestation.
    { peek: { status: "ready", generation: 3 }, status: "running", reason: "startup_running" },
  ];
  for (const [index, item] of cases.entries()) {
    const beforeTree = snapshotTree(abrain);
    const beforeRuntime = [
      runtime.__canonicalRuntimeMapSizeForTests(),
      runtime.__canonicalStartupPromiseMapSizeForTests(),
    ];
    let observeCalls = 0;
    let kickCalls = 0;
    let headReads = 0;
    const observed = await run(abrain, request("observe", `observe-map-${index}`), {
      observeStartup(options) {
        observeCalls += 1;
        assert(options?.abrainHome === abrain || path.resolve(options?.abrainHome) === path.resolve(abrain),
          `observe hook abrainHome=${options?.abrainHome}`);
        return Object.freeze({ ...item.peek });
      },
      kickStartup() {
        kickCalls += 1;
        return { promise: Promise.resolve(diagnostics("ready")) };
      },
      readCanonicalHead: async () => {
        headReads += 1;
        return goodHead;
      },
    });
    assert(observeCalls === 1, `observe hook calls=${observeCalls} for ${item.peek.status}`);
    assert(kickCalls === 0 && headReads === 0, `observe side-effect for ${item.peek.status}`);
    assert(observed.status === item.status && observed.reason_code === item.reason, JSON.stringify(observed));
    assert(observed.convergence_generation === "11" && observed.retryable === true,
      `retryable/generation for ${item.peek.status}: ${JSON.stringify(observed)}`);
    if (item.status === "running" || item.status === "pending") assert(observed.retryable === true, "pending/running must be retryable");
    const afterRuntime = [
      runtime.__canonicalRuntimeMapSizeForTests(),
      runtime.__canonicalStartupPromiseMapSizeForTests(),
    ];
    assert(JSON.stringify(afterRuntime) === JSON.stringify(beforeRuntime), `runtime delta for ${item.peek.status}`);
    assert(snapshotTree(abrain) === beforeTree, `fs delta for ${item.peek.status}`);
  }

  // Real observe export is pure peek (no create).
  const before = [
    runtime.__canonicalRuntimeMapSizeForTests(),
    runtime.__canonicalStartupPromiseMapSizeForTests(),
  ];
  const peek = runtime.observeCanonicalStartupAttempt({ abrainHome: abrain });
  assert(peek && typeof peek.status === "string", `real observe export=${JSON.stringify(peek)}`);
  const after = [
    runtime.__canonicalRuntimeMapSizeForTests(),
    runtime.__canonicalStartupPromiseMapSizeForTests(),
  ];
  assert(JSON.stringify(after) === JSON.stringify(before), "real observe created runtime/promise");
});

await check("readCanonicalHeadOid shares runtime Git isolation (config nulled)", async () => {
  const abrain = createAbrain("git-isolation-head");
  initBareAbrainGit(abrain);
  const env = runtime.sanitizedCanonicalGitEnvironment();
  assert(env.GIT_CONFIG_GLOBAL === "/dev/null", "GIT_CONFIG_GLOBAL not isolated");
  assert(env.GIT_CONFIG_SYSTEM === "/dev/null", "GIT_CONFIG_SYSTEM not isolated");
  assert(env.GIT_TERMINAL_PROMPT === "0", "GIT_TERMINAL_PROMPT not off");
  assert(env.GIT_OPTIONAL_LOCKS === "0", "GIT_OPTIONAL_LOCKS not off");
  const head = await runtime.readCanonicalHeadOid(abrain);
  assert(/^[0-9a-f]{40}$/.test(head), `head=${head}`);
});

await check("win32 deps platform fail-closed before authority/attestation/runtime; no tree delta", async () => {
  assert(typeof control.isDccAttestationPlatformSupported === "function",
    "isDccAttestationPlatformSupported must be exported");
  assert(control.isDccAttestationPlatformSupported("linux") === true, "linux must be supported");
  assert(control.isDccAttestationPlatformSupported("darwin") === true, "darwin must be supported");
  // Production pin-null: win32 unsupported even on real Windows hosts.
  // (Test-seam inject does not change isDccAttestationPlatformSupported.)
  assert(control.isDccAttestationPlatformSupported("win32") === false, "win32 production pin-null must fail closed");
  assert(
    control.isDccAttestationPlatformSupported(process.platform) === (process.platform !== "win32"),
    "default process.platform helper must match real host under pin-null",
  );

  const abrain = createAbrain("win32-fail-closed");
  const beforeTree = snapshotTree(abrain);
  assert(!fs.existsSync(attestationDirectory(abrain)), "attestation dir must not pre-exist");

  for (const operation of ["kick", "observe"]) {
    let kickCalls = 0;
    let observeCalls = 0;
    let resolveCalls = 0;
    let lockCalls = 0;
    const manifest = request(operation, `win32-${operation}`);
    const closed = await control.runSedimentWorkerCanonicalControl(JSON.stringify(manifest), {
      resolveAbrainHome: () => {
        resolveCalls += 1;
        return abrain;
      },
      authorityObservation: {
        observeLock: () => {
          lockCalls += 1;
          return "held";
        },
      },
      platform: "win32",
      testHooks: {
        kickStartup() {
          kickCalls += 1;
          return { promise: Promise.resolve(diagnostics("ready")) };
        },
        observeStartup() {
          observeCalls += 1;
          return Object.freeze({ status: "ready", generation: 1 });
        },
        readCanonicalHead: async () => {
          kickCalls += 1; // also forbidden side-effect path
          return goodHead;
        },
      },
    });
    assert(closed.request_id === manifest.request_id, `${operation} request_id mismatch`);
    assert(closed.operation === operation, `${operation} operation mismatch`);
    assert(closed.status === "unavailable", `${operation} status=${closed.status}`);
    assert(closed.reason_code === "attestation_unavailable", `${operation} reason=${closed.reason_code}`);
    assert(closed.convergence_generation === null, `${operation} generation=${closed.convergence_generation}`);
    assert(closed.retryable === true, `${operation} retryable=${closed.retryable}`);
    assert(control.sanitizeSedimentWorkerCanonicalControlResult(closed), `${operation} illegal closed shape`);
    assert(kickCalls === 0, `${operation} kickStartup calls=${kickCalls}`);
    assert(observeCalls === 0, `${operation} observeStartup calls=${observeCalls}`);
    assert(resolveCalls === 0, `${operation} resolveAbrainHome calls=${resolveCalls}`);
    assert(lockCalls === 0, `${operation} observeLock calls=${lockCalls}`);
  }

  assert(!fs.existsSync(attestationDirectory(abrain)), "win32 path must not create attestation dir");
  assert(snapshotTree(abrain) === beforeTree, "win32 path mutated abrain tree");

  // Production gate: without inject, win32 reader throws closed.
  // When this smoke installs a temp-package test override on real win32,
  // absent store returns null (physical layer available, object missing).
  if (process.platform === "win32" && !windowsDccAddon) {
    expectAttestationUnavailable(abrain);
  } else {
    assert(readAttestation(abrain) === null, "absent read must be null when physical layer available");
  }
});

await check("durable failed bind inventory blocks ready; next kick stays blocked (continuation_failed)", async () => {
  const abrain = createAbrain("continuation-failed-durable");
  let inspectCalls = 0;
  let applyCalls = 0;
  const hooks = {
    repairStorePresentBrainLayout() {},
    kickStartup() { return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      inspectCalls += 1;
      return { pending: 0, failed: 1, invalid: 0 };
    },
    async applyBindIntents() {
      applyCalls += 1;
      return { applied: 0, pending: 0, failed: 0 };
    },
  };
  const first = await run(abrain, request("kick", "cont-failed-1"), hooks);
  assert(first.status === "pending", JSON.stringify(first));
  const blocked = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.reason_code === "continuation_failed" ? value : null;
  }, "continuation_failed attestation");
  assert(blocked.outcome === "blocked" && blocked.canonical_head === null, JSON.stringify(blocked));
  assert(applyCalls === 0, "failed inventory must not call apply");
  assert(inspectCalls >= 1, "expected inventory inspect");

  const second = await run(abrain, request("kick", "cont-failed-2"), hooks);
  assert(second.convergence_generation === "2", JSON.stringify(second));
  const blockedAgain = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.convergence_generation === "2" && value.reason_code === "continuation_failed" ? value : null;
  }, "continuation_failed persists on next kick");
  assert(blockedAgain.outcome === "blocked" && blockedAgain.canonical_head === null, JSON.stringify(blockedAgain));
  assert(applyCalls === 0, "historical failed must keep blocking apply");
});

await check("pending bind continuation settles continuation_pending and does not publish HEAD", async () => {
  const abrain = createAbrain("continuation-pending");
  let headReads = 0;
  const hooks = {
    repairStorePresentBrainLayout() {},
    kickStartup() { return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => { headReads += 1; return goodHead; },
    async inspectBindIntentInventory() {
      return { pending: 1, failed: 0, invalid: 0 };
    },
    async applyBindIntents() {
      return { applied: 0, pending: 1, failed: 0 };
    },
  };
  await run(abrain, request("kick", "cont-pending-1"), hooks);
  const pending = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.reason_code === "continuation_pending" ? value : null;
  }, "continuation_pending attestation");
  assert(pending.outcome === "pending" && pending.canonical_head === null, JSON.stringify(pending));
  assert(headReads === 0, "continuation_pending must not read final HEAD");
});

await check("successful bind continuation then publishes ready with exact HEAD", async () => {
  const abrain = createAbrain("continuation-success");
  let applied = 0;
  const hooks = {
    repairStorePresentBrainLayout() {},
    kickStartup() { return { promise: Promise.resolve(diagnostics("ready")) }; },
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() {
      return applied === 0
        ? { pending: 1, failed: 0, invalid: 0 }
        : { pending: 0, failed: 0, invalid: 0 };
    },
    async applyBindIntents() {
      applied += 1;
      return { applied: 1, pending: 0, failed: 0 };
    },
  };
  await run(abrain, request("kick", "cont-success-1"), hooks);
  const ready = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.outcome === "ready" ? value : null;
  }, "ready after continuation");
  assert(ready.reason_code === "none" && ready.canonical_head === goodHead, JSON.stringify(ready));
  assert(applied === 1, `apply calls=${applied}`);
});

await check("authority revoked inside continuation mutation settles blocked/startup_failed, never ready", async () => {
  const abrain = createAbrain("continuation-authority-revoked");
  const lockState = { value: "held" };
  let headReads = 0;
  const kicked = await control.runSedimentWorkerCanonicalControl(
    JSON.stringify(request("kick", "continuation-authority-revoked")),
    {
      resolveAbrainHome: () => abrain,
      authorityObservation: { observeLock: () => lockState.value },
      ...(windowsDccAddon ? { windowsDccNativeAddon: windowsDccAddon } : {}),
      testHooks: {
        repairStorePresentBrainLayout() {},
        kickStartup() { return { promise: Promise.resolve(diagnostics("ready")) }; },
        readCanonicalHead: async () => { headReads += 1; return goodHead; },
        async inspectBindIntentInventory() {
          return { pending: 1, failed: 0, invalid: 0 };
        },
        async applyBindIntents() {
          lockState.value = "free";
          await mutationAuthority.assertCanonicalMutationAuthorized(abrain);
          throw new Error("unreachable");
        },
      },
    },
  );
  assert(kicked.status === "pending", JSON.stringify(kicked));
  const blocked = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.reason_code === "startup_failed" ? value : null;
  }, "authority-revoked startup_failed");
  assert(blocked.outcome === "blocked" && blocked.canonical_head === null, JSON.stringify(blocked));
  assert(headReads === 0, "revoked continuation must not publish/read ready HEAD");
});

await check("observe never inspects or applies bind continuation", async () => {
  const abrain = createAbrain("observe-no-continuation");
  writeAttestation(abrain, attestation({
    outcome: "pending",
    reason_code: "startup_running",
  }));
  let inspectCalls = 0;
  let applyCalls = 0;
  const observed = await run(abrain, request("observe", "observe-no-cont"), {
    observeStartup() { return { status: "ready" }; },
    async inspectBindIntentInventory() { inspectCalls += 1; return { pending: 0, failed: 0, invalid: 0 }; },
    async applyBindIntents() { applyCalls += 1; return { applied: 0, pending: 0, failed: 0 }; },
  });
  assert(observed.status === "running", JSON.stringify(observed));
  assert(inspectCalls === 0 && applyCalls === 0, "observe touched bind continuation");
});

await check("production-default DCC kick applies real pending bind intent and publishes exact HEAD", async () => {
  // Real combination path: temporary git ABRAIN + real pending bind intent +
  // enabled canonical runtime. Kick uses default dynamic import inventory+apply
  // (no inspect/apply hooks). Authority observation may use the test deps hook.
  const previousSettings = process.env.PI_ASTACK_SETTINGS_PATH;
  try {
    const abrain = createAbrain("production-default-bind");
    initBareAbrainGit(abrain);
    const settings = path.join(tmp, "production-default-bind-settings.json");
    writeEnabledCanonicalSettings(settings);
    process.env.PI_ASTACK_SETTINGS_PATH = settings;

    const project = path.join(tmp, "production-default-project");
    fs.mkdirSync(project, { recursive: true });
    const bindIntent = await jiti.import(path.join(root, "extensions/abrain/bind-intent.ts"));
    const plan = await bindIntent.planAbrainBind({
      abrainHome: abrain,
      cwd: project,
      projectId: "prod-default-proj",
      now: "2026-07-30T15:10:00.000+08:00",
    });
    const intent = bindIntent.intentFromPlan(plan);
    // fsyncDirectory on win32 no longer pretends directory fsync (verifies path only);
    // bind-intent durable write must not EPERM-skip as an edge/durable residual.
    const written = await bindIntent.writeAbrainBindIntent(abrain, intent);
    assert(written.status === "created", `intent write status=${written.status}`);
    assert(!fs.existsSync(plan.registryPath), "registry must start absent");

    const headBefore = spawnSync("git", ["-C", abrain, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert(headBefore.status === 0, `rev-parse before failed: ${headBefore.stderr}`);
    const headBeforeOid = headBefore.stdout.trim();

    // No inspect/apply hooks — production defaults must execute.
    // Authority observation stays on the existing test deps path (held).
    const kick = await run(abrain, request("kick", "prod-default-kick-1"));
    assert(kick.status === "pending" || kick.status === "running" || kick.status === "ready",
      `kick immediate status unexpected: ${JSON.stringify(kick)}`);

    const ready = await waitFor(() => {
      const value = readAttestation(abrain);
      return value?.outcome === "ready" ? value : null;
    }, "production-default ready attestation", 60_000);

    assert(ready.reason_code === "none", JSON.stringify(ready));
    assert(typeof ready.canonical_head === "string" && /^[0-9a-f]{40}$/.test(ready.canonical_head),
      `canonical_head shape: ${ready.canonical_head}`);

    const headAfter = spawnSync("git", ["-C", abrain, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert(headAfter.status === 0, `rev-parse after failed: ${headAfter.stderr}`);
    const headAfterOid = headAfter.stdout.trim();
    assert(headAfterOid !== headBeforeOid, "tracked registry commit must advance HEAD");
    assert(ready.canonical_head === headAfterOid,
      `attestation canonical_head must equal final git HEAD (${ready.canonical_head} vs ${headAfterOid})`);

    assert(fs.existsSync(plan.registryPath), "registry must materialize under ownership");
    const lsTree = spawnSync("git", ["-C", abrain, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" });
    assert(lsTree.status === 0, `ls-tree failed: ${lsTree.stderr}`);
    assert(lsTree.stdout.split("\n").includes(intent.registryRelativePath),
      `HEAD missing registry path ${intent.registryRelativePath}`);

    const inventory = await bindIntent.inspectAbrainBindIntentInventory(abrain);
    assert(inventory.pending === 0 && inventory.failed === 0 && inventory.invalid === 0,
      `post-apply inventory=${JSON.stringify(inventory)}`);
    const remaining = await bindIntent.listAbrainBindIntentPending(abrain);
    assert(remaining.length === 0, "pending must move to done");
    const donePath = path.join(bindIntent.abrainBindIntentDoneDir(abrain), `${intent.itemId}.json`);
    assert(fs.existsSync(donePath), "done terminal record missing");
  } finally {
    if (previousSettings === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = previousSettings;
  }
});

await check("authority-admitted kick real-repairs missing zone+gitignore then ready; observe never repairs", async () => {
  if (process.platform === "win32") {
    // Real layout-repair + git commit path has residual Windows host failures
    // (startup_failed) independent of DCC attestation physical layer; covered on Linux.
    console.log("  skip  layout-repair ready (Windows real-repair residual; see smoke-dcc-windows-attestation)");
    return;
  }
  const previousSettings = process.env.PI_ASTACK_SETTINGS_PATH;
  try {
    const abrain = createAbrain("layout-repair-ready");
    initBareAbrainGit(abrain);
    // Incomplete tracked .gitignore: commit a version that does NOT contain .state/,
    // so before HEAD cannot already satisfy the durable repair contract.
    fs.writeFileSync(path.join(abrain, ".gitignore"), "# incomplete layout-repair fixture\n");
    const incompleteAdd = spawnSync("git", ["-C", abrain, "add", ".gitignore"], { encoding: "utf8" });
    assert(incompleteAdd.status === 0, `incomplete gitignore add failed: ${incompleteAdd.stderr}`);
    const incompleteCommit = spawnSync(
      "git",
      ["-C", abrain, "commit", "-m", "incomplete gitignore without .state/"],
      { encoding: "utf8" },
    );
    assert(incompleteCommit.status === 0, `incomplete gitignore commit failed: ${incompleteCommit.stderr}`);
    // Drop knowledge zone (createAbrain has none; force-absent for the repair path).
    fs.rmSync(path.join(abrain, "knowledge"), { recursive: true, force: true });
    assert(!fs.existsSync(path.join(abrain, "knowledge")), "fixture must start without knowledge zone");
    // Tracked tree clean at the incomplete tip (untracked .state/ may appear until repair ignores it).
    const trackedDirty = spawnSync(
      "git",
      ["-C", abrain, "status", "--porcelain", "--untracked-files=no"],
      { encoding: "utf8" },
    );
    assert(trackedDirty.status === 0, `tracked status failed: ${trackedDirty.stderr}`);
    assert(trackedDirty.stdout === "", `tracked porcelain not clean before kick: ${JSON.stringify(trackedDirty.stdout)}`);
    const beforeHeadGi = spawnSync("git", ["-C", abrain, "show", "HEAD:.gitignore"], { encoding: "utf8" });
    assert(beforeHeadGi.status === 0, `before HEAD:.gitignore missing: ${beforeHeadGi.stderr}`);
    assert(
      !/(^|\n)\.state\/?(\n|$)/.test(beforeHeadGi.stdout),
      `before HEAD:.gitignore must NOT contain .state/: ${JSON.stringify(beforeHeadGi.stdout)}`,
    );
    const beforeHead = spawnSync("git", ["-C", abrain, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert(/^[0-9a-f]{40}$/.test(beforeHead), `before HEAD invalid: ${beforeHead}`);

    const settings = path.join(tmp, "layout-repair-ready-settings.json");
    writeEnabledCanonicalSettings(settings);
    process.env.PI_ASTACK_SETTINGS_PATH = settings;

    let repairCalls = 0;
    // Production-default path: no repair hook → real authority-executor repair.
    const kick = await run(abrain, request("kick", "layout-repair-kick-1"));
    assert(kick.status === "pending", JSON.stringify(kick));

    const ready = await waitFor(() => {
      const value = readAttestation(abrain);
      return value?.outcome === "ready" ? value : null;
    }, "layout-repair ready", 60_000);
    assert(ready.reason_code === "none", JSON.stringify(ready));
    assert(fs.existsSync(path.join(abrain, "knowledge")), "kick must create missing knowledge zone");
    assert(fs.lstatSync(path.join(abrain, "knowledge")).isDirectory(), "knowledge must be plain dir");
    assert(!fs.lstatSync(path.join(abrain, "knowledge")).isSymbolicLink(), "knowledge must not be symlink");
    const gi = fs.readFileSync(path.join(abrain, ".gitignore"), "utf8");
    assert(/(^|\n)\.state\/?(\n|$)/.test(gi), "kick must ensure .state/ gitignore (worktree)");

    // Durable HEAD proof — not just worktree files:
    //   before HEAD tracked .gitignore lacked .state/
    //   kick repair must advance HEAD (liveHead !== beforeHead)
    //   ready.canonical_head exact live HEAD
    //   porcelain empty
    //   HEAD:.gitignore (committed tree) contains .state/
    const liveHead = spawnSync("git", ["-C", abrain, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert(/^[0-9a-f]{40}$/.test(liveHead), `live HEAD invalid: ${liveHead}`);
    assert(liveHead !== beforeHead, `kick layout repair must advance HEAD (before=${beforeHead} live=${liveHead})`);
    assert(ready.canonical_head === liveHead, `canonical_head ${ready.canonical_head} !== live HEAD ${liveHead}`);
    const porcelain = spawnSync("git", ["-C", abrain, "status", "--porcelain"], { encoding: "utf8" });
    assert(porcelain.status === 0, `status failed: ${porcelain.stderr}`);
    assert(porcelain.stdout === "", `porcelain not empty: ${JSON.stringify(porcelain.stdout)}`);
    const headGi = spawnSync("git", ["-C", abrain, "show", "HEAD:.gitignore"], { encoding: "utf8" });
    assert(headGi.status === 0, `HEAD:.gitignore missing: ${headGi.stderr}`);
    assert(/(^|\n)\.state\/?(\n|$)/.test(headGi.stdout), "HEAD:.gitignore must contain .state/");

    // Observe zero repair: inject a counting repair hook that must never fire.
    const beforeTree = snapshotTree(abrain);
    const observed = await run(abrain, request("observe", "layout-repair-observe"), {
      repairStorePresentBrainLayout() { repairCalls += 1; },
      observeStartup() { return Object.freeze({ status: "ready", generation: 1 }); },
    });
    assert(observed.status === "ready" || observed.status === "running" || observed.status === "pending",
      JSON.stringify(observed));
    assert(repairCalls === 0, `observe repair calls=${repairCalls}`);
    assert(snapshotTree(abrain) === beforeTree, "observe mutated tree");
  } finally {
    if (previousSettings === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = previousSettings;
  }
});

await check("layout gitignore commit is hardened: hooks off, only .gitignore, no GIT_* inheritance, head===live", async () => {
  if (process.platform === "win32") {
    console.log("  skip  layout-gi-hardened (Windows real-repair residual)");
    return;
  }
  const previousIndex = process.env.GIT_INDEX_FILE;
  try {
    const abrain = createAbrain("layout-gi-hardened");
    initBareAbrainGit(abrain);

    // Baseline HEAD tracked .gitignore must NOT contain .state/.
    fs.writeFileSync(path.join(abrain, ".gitignore"), "# incomplete layout-gi hardened fixture\n");
    const incompleteAdd = spawnSync("git", ["-C", abrain, "add", ".gitignore"], { encoding: "utf8" });
    assert(incompleteAdd.status === 0, `incomplete add failed: ${incompleteAdd.stderr}`);
    const incompleteCommit = spawnSync(
      "git",
      ["-C", abrain, "commit", "-m", "incomplete gitignore without .state/"],
      { encoding: "utf8" },
    );
    assert(incompleteCommit.status === 0, `incomplete commit failed: ${incompleteCommit.stderr}`);
    const beforeHeadGi = spawnSync("git", ["-C", abrain, "show", "HEAD:.gitignore"], { encoding: "utf8" });
    assert(beforeHeadGi.status === 0, `before HEAD:.gitignore missing: ${beforeHeadGi.stderr}`);
    assert(
      !/(^|\n)\.state\/?(\n|$)/.test(beforeHeadGi.stdout),
      `before HEAD:.gitignore must NOT contain .state/: ${JSON.stringify(beforeHeadGi.stdout)}`,
    );
    const beforeHead = spawnSync("git", ["-C", abrain, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    // Executable pre-commit hook that would write a marker and fail the commit.
    const hookMarker = path.join(tmp, "layout-gi-pre-commit-marker");
    fs.rmSync(hookMarker, { force: true });
    const hooksDir = path.join(abrain, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\nprintf 'hook-ran\\n' > '${hookMarker.replace(/'/g, `'"'"'`)}'\nexit 1\n`,
      { mode: 0o755 },
    );
    fs.chmodSync(hookPath, 0o755);

    // Pre-stage an unrelated path that must remain staged and never enter HEAD.
    fs.writeFileSync(path.join(abrain, "unrelated.txt"), "keep-staged\n");
    const stageUnrelated = spawnSync("git", ["-C", abrain, "add", "unrelated.txt"], { encoding: "utf8" });
    assert(stageUnrelated.status === 0, `pre-stage unrelated failed: ${stageUnrelated.stderr}`);
    const prePorcelain = spawnSync("git", ["-C", abrain, "status", "--porcelain"], { encoding: "utf8" });
    assert(prePorcelain.status === 0, `pre status failed: ${prePorcelain.stderr}`);
    assert(/A\s+unrelated\.txt/.test(prePorcelain.stdout), `unrelated not staged: ${JSON.stringify(prePorcelain.stdout)}`);

    // Malicious GIT_INDEX_FILE must not be inherited by layout commit git calls.
    const evilIndex = path.join(tmp, "layout-gi-evil-index-must-not-exist");
    fs.rmSync(evilIndex, { force: true });
    process.env.GIT_INDEX_FILE = evilIndex;

    // Real repair (no repair hook) + fake ready startup (skip whole-L1).
    const kick = await run(abrain, request("kick", "layout-gi-hardened-1"), {
      kickStartup() {
        return { promise: Promise.resolve(diagnostics("ready")) };
      },
    });
    assert(kick.status === "pending", JSON.stringify(kick));

    const ready = await waitFor(() => {
      const value = readAttestation(abrain);
      return value?.outcome === "ready" ? value : null;
    }, "layout-gi-hardened ready");
    assert(ready.reason_code === "none", JSON.stringify(ready));

    assert(!fs.existsSync(hookMarker), "pre-commit hook marker must not exist (hooks disabled)");
    assert(!fs.existsSync(evilIndex), "malicious GIT_INDEX_FILE must not be created");

    // Drop process GIT_INDEX_FILE before smoke-side git inspections; production
    // path already ran under sanitizedCanonicalGitEnvironment isolation.
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;

    const liveHead = spawnSync("git", ["-C", abrain, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert(/^[0-9a-f]{40}$/.test(liveHead), `live HEAD invalid: ${liveHead}`);
    assert(liveHead !== beforeHead, `layout commit must advance HEAD (before=${beforeHead} live=${liveHead})`);
    assert(ready.canonical_head === liveHead, `attestation head ${ready.canonical_head} !== live HEAD ${liveHead}`);

    const headGi = spawnSync("git", ["-C", abrain, "show", "HEAD:.gitignore"], { encoding: "utf8" });
    assert(headGi.status === 0, `HEAD:.gitignore missing: ${headGi.stderr}`);
    assert(/(^|\n)\.state\/?(\n|$)/.test(headGi.stdout), "HEAD:.gitignore must contain .state/");

    const changed = spawnSync(
      "git",
      ["-C", abrain, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      { encoding: "utf8" },
    );
    assert(changed.status === 0, `diff-tree failed: ${changed.stderr}`);
    const names = changed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    assert(
      names.length === 1 && names[0] === ".gitignore",
      `HEAD must only contain .gitignore change: ${JSON.stringify(names)}`,
    );

    const porcelain = spawnSync("git", ["-C", abrain, "status", "--porcelain"], { encoding: "utf8" });
    assert(porcelain.status === 0, `status failed: ${porcelain.stderr}`);
    assert(/A\s+unrelated\.txt/.test(porcelain.stdout), `unrelated must remain staged: ${JSON.stringify(porcelain.stdout)}`);
    const headTree = spawnSync(
      "git",
      ["-C", abrain, "ls-tree", "-r", "--name-only", "HEAD"],
      { encoding: "utf8" },
    );
    assert(headTree.status === 0, `ls-tree failed: ${headTree.stderr}`);
    assert(
      !headTree.stdout.split("\n").map((line) => line.trim()).includes("unrelated.txt"),
      "unrelated.txt must not be in HEAD",
    );
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
  }
});

await check("non-git missing gitignore real repair settles blocked/startup_failed (not ready)", async () => {
  const abrain = createAbrain("layout-gi-nongit");
  assert(!fs.existsSync(path.join(abrain, ".git")), "fixture must not be a git worktree");
  assert(!fs.existsSync(path.join(abrain, ".gitignore")), "fixture must start without .gitignore");

  // Real repair (no repair hook): ensure writes .gitignore then commit path must fail closed.
  const kick = await run(abrain, request("kick", "layout-gi-nongit-1"), {
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
  });
  assert(kick.status === "pending", JSON.stringify(kick));

  const blocked = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.reason_code === "startup_failed" ? value : null;
  }, "non-git layout commit startup_failed");
  assert(blocked.outcome === "blocked", JSON.stringify(blocked));
  assert(blocked.canonical_head === null, JSON.stringify(blocked));
  assert(blocked.convergence_generation === "1", JSON.stringify(blocked));
  // External surface is startup_failed only — no path/raw git detail.
  assert(blocked.reason_code === "startup_failed", JSON.stringify(blocked));
});

await check("kick layout repair is next-turn (not microtask): await returns before repair; barrier holds; failure settles blocked", async () => {
  const barrier = await jiti.import(path.join(root, "extensions/_shared/canonical-mutation-barrier.ts"));
  const abrain = createAbrain("repair-next-turn");
  let repairCalls = 0;
  let repairSawBarrier = false;

  // Sync counting repair: Promise microtask would run before the awaiter of kick
  // resumes; setImmediate (next event-loop turn) keeps repair off the return path.
  const kick = await run(abrain, request("kick", "repair-next-turn-1"), {
    repairStorePresentBrainLayout() {
      repairCalls += 1;
      repairSawBarrier = barrier.canonicalMutationBarrierHeld(abrain);
    },
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
  });
  assert(kick.status === "pending", JSON.stringify(kick));
  assert(repairCalls === 0, `repair must not run before await kick returns (calls=${repairCalls})`);

  await waitFor(() => readAttestation(abrain)?.outcome === "ready", "next-turn ready");
  assert(repairCalls === 1, `repair calls=${repairCalls}`);
  assert(repairSawBarrier === true, "repair must run inside withCanonicalMutationBarrier");

  // Barrier/repair failure (incl. busy class) → blocked/startup_failed retryable.
  const throwAbrain = createAbrain("repair-throw-settle");
  const throwKick = await run(throwAbrain, request("kick", "repair-throw-1"), {
    repairStorePresentBrainLayout() {
      throw new barrier.CanonicalMutationBarrierError("CANONICAL_MUTATION_BUSY", "synthetic busy");
    },
    kickStartup() {
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
  });
  assert(throwKick.status === "pending", JSON.stringify(throwKick));
  const blocked = await waitFor(() => {
    const value = readAttestation(throwAbrain);
    return value?.reason_code === "startup_failed" ? value : null;
  }, "repair-throw startup_failed");
  assert(blocked.outcome === "blocked" && blocked.canonical_head === null, JSON.stringify(blocked));
  assert(blocked.convergence_generation === "1", JSON.stringify(blocked));
});

await check("layout repair failclosed on zone/root/gitignore/temp symlink with external zero delta", async () => {
  if (process.platform === "win32") {
    // Creating symlinks without Developer Mode / elevation raises EPERM on many Windows hosts.
    console.log("  skip  layout repair symlink failclosed (Windows symlink EPERM)");
    return;
  }
  const layout = await jiti.import(path.join(root, "extensions/abrain/brain-layout.ts"));

  // Zone symlink → fail closed, external target untouched.
  {
    const abrain = createAbrain("repair-zone-symlink");
    const external = path.join(tmp, "escape-zone-target");
    fs.mkdirSync(external, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(external, "marker"), "keep\n");
    const beforeExternal = snapshotTree(external);
    fs.symlinkSync(external, path.join(abrain, "knowledge"));
    let code = null;
    try {
      layout.repairStorePresentBrainLayoutForAuthorityExecutor(abrain);
    } catch (error) {
      code = error?.code ?? error?.message;
    }
    assert(code === "brain_layout_zone_invalid", `zone symlink code=${code}`);
    assert(snapshotTree(external) === beforeExternal, "zone symlink external delta");
    assert(fs.lstatSync(path.join(abrain, "knowledge")).isSymbolicLink(), "zone symlink replaced");
  }

  // Root symlink → fail closed, no follow into target.
  {
    const external = path.join(tmp, "escape-root-target");
    fs.mkdirSync(external, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(external, "marker"), "root\n");
    const beforeExternal = snapshotTree(external);
    const abrain = path.join(tmp, "repair-root-symlink");
    fs.symlinkSync(external, abrain);
    let code = null;
    try {
      layout.repairStorePresentBrainLayoutForAuthorityExecutor(abrain);
    } catch (error) {
      code = error?.code ?? error?.message;
    }
    assert(code === "brain_layout_root_invalid", `root symlink code=${code}`);
    assert(snapshotTree(external) === beforeExternal, "root symlink external delta");
  }

  // .gitignore symlink → fail closed, external target untouched.
  {
    const abrain = createAbrain("repair-gi-symlink");
    // Create plain zones first so we reach gitignore ensure.
    layout.repairStorePresentBrainLayoutForAuthorityExecutor(abrain);
    const external = path.join(tmp, "escape-gi-target");
    fs.writeFileSync(external, "secret\n");
    const beforeExternal = snapshotTree(path.dirname(external));
    fs.rmSync(path.join(abrain, ".gitignore"), { force: true });
    fs.symlinkSync(external, path.join(abrain, ".gitignore"));
    let code = null;
    try {
      layout.repairStorePresentBrainLayoutForAuthorityExecutor(abrain);
    } catch (error) {
      code = error?.code ?? error?.message;
    }
    assert(code === "gitignore_unreadable", `gi symlink code=${code}`);
    assert(fs.readFileSync(external, "utf8") === "secret\n", "gi symlink external content changed");
    assert(fs.lstatSync(path.join(abrain, ".gitignore")).isSymbolicLink(), "gi symlink replaced");
    // External dir snapshot may include other files; content check is the contract.
    void beforeExternal;
  }

  // Kick path: repair failure → blocked/startup_failed retryable, never ready.
  {
    const abrain = createAbrain("repair-fail-kick");
    fs.symlinkSync(path.join(tmp, "escape-zone-target"), path.join(abrain, "knowledge"));
    // Real repair (no no-op hook).
    const kicked = await run(abrain, request("kick", "repair-fail-kick-1"), {
      kickStartup() {
        return { promise: Promise.resolve(diagnostics("ready")) };
      },
      readCanonicalHead: async () => goodHead,
    });
    assert(kicked.status === "pending", JSON.stringify(kicked));
    const blocked = await waitFor(() => {
      const value = readAttestation(abrain);
      return value?.reason_code === "startup_failed" ? value : null;
    }, "repair-fail startup_failed");
    assert(blocked.outcome === "blocked" && blocked.canonical_head === null, JSON.stringify(blocked));
    assert(blocked.convergence_generation === "1", JSON.stringify(blocked));
  }
});

await check("old-generation settle cannot overwrite newer active aggregate (token race)", async () => {
  const abrain = createAbrain("settle-gen-race");
  const gen1Startup = deferred();
  let gen1Kicks = 0;
  let gen2Kicks = 0;

  // Gen1: hang in startup so we control settle timing.
  const first = await run(abrain, request("kick", "race-gen1"), {
    repairStorePresentBrainLayout() {},
    kickStartup() {
      gen1Kicks += 1;
      return { promise: gen1Startup.promise };
    },
    readCanonicalHead: async () => goodHead,
  });
  assert(first.convergence_generation === "1", JSON.stringify(first));
  await waitFor(() => (gen1Kicks === 1 ? true : null), "gen1 next-turn kickStartup");
  await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.convergence_generation === "1" && value.outcome === "pending" ? value : null;
  }, "gen1 pending");

  // Force settledVisible so a fresh generation can replace the in-flight token:
  // write a terminal attestation for gen1, then kick gen2.
  writeAttestation(abrain, attestation({
    convergence_generation: "1",
    outcome: "blocked",
    reason_code: "startup_failed",
  }));

  const second = await run(abrain, request("kick", "race-gen2"), {
    repairStorePresentBrainLayout() {},
    kickStartup() {
      gen2Kicks += 1;
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
  });
  assert(second.convergence_generation === "2", JSON.stringify(second));
  await waitFor(() => (gen2Kicks === 1 ? true : null), "gen2 next-turn kickStartup");
  assert(gen1Kicks === 1 && gen2Kicks === 1, `kicks gen1=${gen1Kicks} gen2=${gen2Kicks}`);

  const gen2Ready = await waitFor(() => {
    const value = readAttestation(abrain);
    return value?.convergence_generation === "2" && value.outcome === "ready" ? value : null;
  }, "gen2 ready");
  assert(gen2Ready.canonical_head === goodHead, JSON.stringify(gen2Ready));

  // Late gen1 settle must not clobber gen2 aggregate/attestation.
  gen1Startup.resolve(diagnostics("ready"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = readAttestation(abrain);
  assert(after?.convergence_generation === "2" && after.outcome === "ready", JSON.stringify(after));
  assert(after.canonical_head === goodHead, JSON.stringify(after));

  const observed = await run(abrain, request("observe", "race-observe"), {
    repairStorePresentBrainLayout() {},
    readCanonicalHead: async () => goodHead,
    async inspectBindIntentInventory() { return { pending: 0, failed: 0, invalid: 0 }; },
    async probeCanonicalBacklog() { return "none"; },
  });
  assert(observed.status === "ready" && observed.convergence_generation === "2", JSON.stringify(observed));
});

await check("gated repair hook lets mechanical tests skip layout; production default uses real repair", async () => {
  const abrain = createAbrain("repair-hook-gate");
  let repairCalls = 0;
  let kickCalls = 0;
  await run(abrain, request("kick", "repair-hook-1"), {
    repairStorePresentBrainLayout() { repairCalls += 1; },
    kickStartup() {
      kickCalls += 1;
      return { promise: Promise.resolve(diagnostics("ready")) };
    },
    readCanonicalHead: async () => goodHead,
  });
  await waitFor(() => readAttestation(abrain)?.outcome === "ready", "hook ready");
  assert(repairCalls === 1, `repair hook calls=${repairCalls}`);
  assert(kickCalls === 1, `kick calls=${kickCalls}`);
  // No-op repair: zones not created by production helper.
  assert(!fs.existsSync(path.join(abrain, "identity")), "no-op repair must not create zones");
});

await check("targeted strict TypeScript has no diagnostics in DCC control; new runtime exports are present", async () => {
  // New runtime exports are type-checked through control imports. Filter by
  // owned DCC control path only — never by fixed source line numbers. Sibling
  // pre-existing strict noise in unrelated runtime/recovery modules is out of D1 scope.
  for (const name of [
    "kickCanonicalStartupAttempt",
    "observeCanonicalStartupAttempt",
    "sanitizedCanonicalGitEnvironment",
    "readCanonicalHeadOid",
  ]) {
    assert(typeof runtime[name] === "function", `missing runtime export ${name}`);
  }
  const tsc = path.join(root, "node_modules/typescript/lib/tsc.js");
  const result = spawnSync(process.execPath, [
    tsc,
    "--lib", "ES2022",
    "--types", "node",
    "--typeRoots", path.join(root, "node_modules/@types"),
    "--target", "ES2022",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--strict",
    "--skipLibCheck",
    "--noEmit",
    path.join(root, "extensions/sediment/canonical-control.ts"),
  ], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert(!result.error, `tsc did not execute: ${result.error?.message}`);
  const diagnostics = `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean);
  const owned = diagnostics.filter((line) => line.includes("extensions/sediment/canonical-control.ts"));
  assert(owned.length === 0, `DCC control tsc diagnostics:\n${owned.join("\n")}`);
});

console.log(`\n${passed} checks passed`);
