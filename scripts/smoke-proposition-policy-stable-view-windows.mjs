#!/usr/bin/env node
/**
 * Windows Policy stable-view durable pointer / read / injection smoke.
 *
 * Loads native addon only via __TEST + temp package (never production pin bypass).
 * Production zero-arg loader remains fail-closed when pin is null.
 *
 * Covers:
 * - publish → read → injection compose
 * - missing latest loud zero
 * - malformed pointer
 * - latest DACL tamper
 * - bundle file DACL tamper
 * - missing bundle / missing artifact file
 * - two publishers contention / same-hash idempotence
 * - publisher crash before latest leaves old view intact
 * - latest switch: only complete old/new views
 * - fsyncDirectory does not throw EPERM on Windows
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
import { preparePropositionPolicyStableViewFixture } from "./_proposition-policy-stable-view-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const stagedNode = path.join(repoRoot, "native/windows/target/smoke-staging/pi-astack-windows-native.node");
const buildInfoPath = path.join(repoRoot, "native/windows/target/smoke-staging/build-info.json");
const CAPABILITIES = ["atomic_file_tempdir_v1", "atomic_file_v1", "protected_dacl_v1", "retained_directory_lock_v1"];
const FIVE = ["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"];
const EVENT_IDS = [
  "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6",
  "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
  "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585",
];

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

const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false });
const nativeMod = jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));
const retainedLock = jiti(path.join(repoRoot, "extensions/_shared/retained-directory-lock.ts"));
const stableWin = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-windows-native.ts"));
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const reader = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts"));
const injector = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/index.ts"));
const durableWrite = jiti(path.join(repoRoot, "extensions/_shared/durable-write.ts"));

const binaryBytes = fs.readFileSync(stagedNode);
const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
for (const c of CAPABILITIES) {
  assert(Array.isArray(buildInfo.capabilities) && buildInfo.capabilities.includes(c), `build-info must include ${c}`);
}

// Production pin must remain null / zero-arg loader fail-closed.
assert(nativeMod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 == null, "production pin must remain null");
assert(nativeMod.loadWindowsNativeAddon.length === 0, "production loader must be zero-arg");
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

const abrainHomeRoot = path.resolve(os.homedir(), ".abrain");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-stable-view-win-"));
assert(!tmp.startsWith(abrainHomeRoot + path.sep) && tmp !== abrainHomeRoot, `temp under ~/.abrain: ${tmp}`);
process.once("exit", () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const packageRoot = fs.mkdtempSync(path.join(tmp, "pkg-"));
fs.writeFileSync(
  path.join(packageRoot, "package.json"),
  `${JSON.stringify({ name: "pi-astack-stable-view-win-temp", private: true }, null, 2)}\n`,
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

// Production retained lock + stable-view ALS/override use the same temp addon.
retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(addon);
stableWin.stableViewWindowsNativeTestApi.installAddonOverride(addon);
process.once("exit", () => {
  try { retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(null); } catch { /* ignore */ }
  try { stableWin.stableViewWindowsNativeTestApi.installAddonOverride(null); } catch { /* ignore */ }
});

const fullSource = path.join(tmp, "source-full");
const emptySource = path.join(tmp, "source-empty");
await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: fullSource });
fs.cpSync(fullSource, emptySource, { recursive: true });
fs.unlinkSync(path.join(
  emptySource,
  "l1",
  "events",
  "sha256",
  EVENT_IDS[0].slice(0, 2),
  EVENT_IDS[0].slice(2, 4),
  `${EVENT_IDS[0]}.json`,
));

function makeSandbox(label) {
  const home = path.join(tmp, label);
  fs.mkdirSync(path.join(home, ".state", "sediment"), { recursive: true });
  return home;
}

function stableRoot(home) {
  return path.join(home, ...publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"));
}

function latestPath(home) {
  return path.join(stableRoot(home), "latest");
}

function readLatestValue(home) {
  const data = stableWin.readStableViewProtectedFile(addon, latestPath(home), 80);
  return stableWin.parseStableViewLatestPointerBytes(data).latestValue;
}

function manager(sessionId = "win-stable-view-session") {
  return {
    isPersisted: () => true,
    getSessionId: () => sessionId,
    getSessionFile: () => path.join(tmp, "sessions", `${sessionId}.jsonl`),
  };
}

function settings() {
  return reader.resolvePropositionPolicyStableViewInjectionSettings({});
}

function readRuntime(home) {
  return reader.readPropositionPolicyStableViewForRuntime({
    abrainHome: home,
    settings: settings(),
    sessionManager: manager(),
    windowsNativeAddon: addon,
  });
}

async function publish(source, target, hooks) {
  return publisher.__TEST.publishSandboxProductionForTests({
    sourceAbrainHome: source,
    targetAbrainHome: target,
    repoRoot,
    windowsNativeAddon: addon,
    ...(hooks ? { hooks } : {}),
  });
}

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}

console.log("ADR0040 Windows Policy stable-view durable smoke");

await check("fsyncDirectory no longer throws EPERM on Windows directories", async () => {
  const dir = path.join(tmp, "fsync-dir");
  fs.mkdirSync(dir, { recursive: true });
  await durableWrite.fsyncDirectory(dir);
});

let fullPub;
let emptyPub;
await check("publish full + empty: regular pointer + selected_valid + injection", async () => {
  const target = makeSandbox("pub-full");
  fullPub = await publish(fullSource, target);
  assert(fullPub.status === "created", `expected created, got ${fullPub.status}`);
  assert(/^bundles\/[0-9a-f]{64}$/.test(fullPub.latest_value), "latest_value shape");
  const st = fs.lstatSync(latestPath(target));
  assert(st.isFile() && !st.isSymbolicLink(), "latest must be regular file");
  const pointerRaw = fs.readFileSync(latestPath(target));
  assert(pointerRaw.equals(Buffer.from(`${fullPub.latest_value}\n`, "utf8")), "pointer exact encoding");
  assert(readLatestValue(target) === fullPub.latest_value, "protected read latest");

  const read = readRuntime(target);
  assert(read.ok === true && read.reason === "selected_valid", `read failed: ${read.reason} ${read.error || ""}`);
  assert(read.bundleHash === fullPub.bundle_hash, "bundle hash mismatch");
  assert(read.itemCount === 1, "expected one item");
  const injection = injector.composePropositionPolicyStableViewInjection("nonce-win", read);
  assert(injection.includes("source=proposition-policy-stable-view"), "injection fence missing");
  assert(injection.includes(read.viewMd), "injection payload missing");
  assert(!injection.includes("source=constraint-shadow-compiled-view"), "compiled fallback leaked");
  assert(!injection.includes("D3"), "D3 fallback leaked");

  const emptyTarget = makeSandbox("pub-empty");
  emptyPub = await publish(emptySource, emptyTarget);
  const emptyRead = readRuntime(emptyTarget);
  assert(emptyRead.ok && emptyRead.itemCount === 0, "empty source must still inject ready_empty");
});

await check("same-hash idempotence returns identical without corrupting view", async () => {
  const target = makeSandbox("idem");
  const first = await publish(fullSource, target);
  const second = await publish(fullSource, target);
  assert(first.bundle_hash === second.bundle_hash, "hash drifted");
  assert(second.status === "identical", `expected identical, got ${second.status}`);
  const read = readRuntime(target);
  assert(read.ok && read.bundleHash === first.bundle_hash, "idempotent read failed");
});

await check("missing latest → loud zero (latest_missing)", async () => {
  const target = makeSandbox("missing-latest");
  await publish(fullSource, target);
  fs.unlinkSync(latestPath(target));
  const read = readRuntime(target);
  assert(read.ok === false && read.reason === "latest_missing", `got ${read.reason}`);
});

await check("malformed pointer → latest_invalid", async () => {
  const target = makeSandbox("malformed");
  await publish(fullSource, target);
  // Tamper via native replace with invalid encoding (still private_rw).
  nativeMod.durableAtomicReplaceFile(addon, latestPath(target), Buffer.from("bundles/../escape\n", "utf8"));
  const read = readRuntime(target);
  assert(read.ok === false && read.reason === "latest_invalid", `got ${read.reason}`);
});

await check("extra bytes / absolute / multiline / backslash pointers reject", async () => {
  const target = makeSandbox("pointer-shapes");
  await publish(fullSource, target);
  const cases = [
    Buffer.from("bundles/" + "a".repeat(64) + "\nEXTRA", "utf8"),
    Buffer.from("C:\\\\bundles\\\\" + "a".repeat(64) + "\n", "utf8"),
    Buffer.from("bundles/" + "a".repeat(64) + "\r\n", "utf8"),
    Buffer.from("bundles/" + "a".repeat(64) + "\n\n", "utf8"),
    Buffer.from("bundles\\" + "a".repeat(64) + "\n", "utf8"),
    Buffer.from("bundles/" + "A".repeat(64) + "\n", "utf8"),
  ];
  for (const payload of cases) {
    nativeMod.durableAtomicReplaceFile(addon, latestPath(target), payload);
    const read = readRuntime(target);
    assert(read.ok === false && (read.reason === "latest_invalid" || read.reason === "latest_tampered"),
      `payload ${payload.toString("utf8").replace(/\n/g, "\\n")} → ${read.reason}`);
  }
});

await check("latest DACL tamper → latest_tampered / loud zero", async () => {
  const target = makeSandbox("latest-dacl");
  await publish(fullSource, target);
  const lp = latestPath(target);
  const ic = runIcacls([lp, "/grant", "Everyone:(F)"]);
  assert(ic.status === 0, `icacls grant failed: ${ic.stderr}`);
  const read = readRuntime(target);
  assert(read.ok === false, "tampered latest must not inject");
  assert(
    read.reason === "latest_tampered" || read.reason === "read_failed",
    `unexpected reason ${read.reason}`,
  );
  assert(!String(read.error || "").includes("win32="), "must not leak native win32 codes");
});

await check("bundle file DACL tamper → loud zero", async () => {
  const target = makeSandbox("bundle-dacl");
  const pub = await publish(fullSource, target);
  const viewMd = path.join(stableRoot(target), pub.latest_value, "view.md");
  const ic = runIcacls([viewMd, "/grant", "Everyone:(F)"]);
  assert(ic.status === 0, `icacls grant failed: ${ic.stderr}`);
  const read = readRuntime(target);
  assert(read.ok === false, "tampered artifact must not inject");
  assert(
    ["latest_tampered", "partial_or_foreign", "read_failed", "unsafe_path"].includes(read.reason),
    `unexpected reason ${read.reason}`,
  );
});

await check("missing bundle dir / missing artifact → loud zero", async () => {
  const target = makeSandbox("missing-bundle");
  const pub = await publish(fullSource, target);
  const bundleDir = path.join(stableRoot(target), pub.latest_value);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  const missingBundle = readRuntime(target);
  assert(missingBundle.ok === false, "missing bundle must reject");

  const target2 = makeSandbox("missing-file");
  const pub2 = await publish(fullSource, target2);
  const artifact = path.join(stableRoot(target2), pub2.latest_value, "view.md");
  fs.unlinkSync(artifact);
  const missingFile = readRuntime(target2);
  assert(missingFile.ok === false, "missing artifact must reject");
});

await check("crash before latest leaves prior complete view", async () => {
  const target = makeSandbox("crash-before-latest");
  const first = await publish(fullSource, target);
  const firstHash = first.bundle_hash;
  let crashed = false;
  try {
    await publish(emptySource, target, {
      atCrashPoint(point) {
        if (point === "before_latest_rename") {
          crashed = true;
          throw new Error("TEST_CRASH_BEFORE_LATEST");
        }
      },
    });
  } catch (error) {
    assert(String(error.message || error).includes("TEST_CRASH_BEFORE_LATEST"), `unexpected ${error}`);
  }
  assert(crashed, "crash hook did not fire");
  // Prior latest must still be the full bundle.
  assert(readLatestValue(target) === `bundles/${firstHash}`, "latest advanced despite crash");
  const read = readRuntime(target);
  assert(read.ok && read.bundleHash === firstHash, "prior view must remain injectable");
});

await check("latest switch exposes only complete old then complete new", async () => {
  const target = makeSandbox("switch");
  const oldPub = await publish(fullSource, target);
  const oldRead = readRuntime(target);
  assert(oldRead.ok && oldRead.bundleHash === oldPub.bundle_hash, "old view invalid");
  const newPub = await publish(emptySource, target);
  assert(newPub.bundle_hash !== oldPub.bundle_hash, "expected different hashes");
  const newRead = readRuntime(target);
  assert(newRead.ok && newRead.bundleHash === newPub.bundle_hash, "new view invalid");
  // Old bundle dir remains content-addressed and complete.
  const oldDir = path.join(stableRoot(target), "bundles", oldPub.bundle_hash);
  assert(JSON.stringify(fs.readdirSync(oldDir).sort()) === JSON.stringify([...FIVE].sort()), "old all-five");
});

await check("two publishers: lock contention then idempotent convergence", async () => {
  const target = makeSandbox("contend");
  const lockRoot = path.join(target, ".state", "sediment");
  const held = retainedLock.acquireRetainedDirectoryLock(lockRoot);
  assert(held.status === "ACQUIRED", "could not hold lock");
  let busyCode = null;
  try {
    await publish(fullSource, target);
  } catch (error) {
    busyCode = error?.code ?? String(error);
  } finally {
    held.close();
  }
  assert(busyCode === "LOCK_BUSY", `expected LOCK_BUSY, got ${busyCode}`);
  // After release, publish succeeds and second is identical.
  const first = await publish(fullSource, target);
  const second = await publish(fullSource, target);
  assert(first.status === "created" || first.status === "identical", "first publish status");
  assert(second.status === "identical", "second should be identical");
  assert(readRuntime(target).ok === true, "final read must succeed");
});

await check("tampered stable root / bundles DACL: publisher does not auto-repair", async () => {
  const target = makeSandbox("tamper-root-dacl");
  await publish(fullSource, target);
  const root = stableRoot(target);
  const bundles = path.join(root, "bundles");
  for (const p of [root, bundles]) {
    const ic = runIcacls([p, "/grant", "Everyone:(F)"]);
    assert(ic.status === 0, `icacls grant failed for ${p}: ${ic.stderr}`);
  }
  let code = null;
  try {
    await publish(emptySource, target);
  } catch (error) {
    code = error?.code ?? String(error);
  }
  assert(
    code === "PUBLICATION_WINDOWS_PROTECTED_IO" || code === "PUBLICATION_WINDOWS_FAILED",
    `tampered DACL must fail-closed without auto-repair, got ${code}`,
  );
  // Still weak after failed publish — no silent setProtectedPath repair.
  const verifyRoot = (() => {
    try {
      nativeMod.verifyProtectedPath(addon, root, "directory", "private_rw");
      return "ok";
    } catch {
      return "invalid";
    }
  })();
  assert(verifyRoot === "invalid", "publisher must not auto-repair tampered root DACL");
});

await check("live latest bundle missing file / collision: fail-closed without delete/whitewash", async () => {
  const target = makeSandbox("live-partial");
  const pub = await publish(fullSource, target);
  const bundleDir = path.join(stableRoot(target), "bundles", pub.bundle_hash);
  const beforeNames = fs.readdirSync(bundleDir).sort();
  const viewMd = path.join(bundleDir, "view.md");
  const original = fs.readFileSync(viewMd);
  fs.unlinkSync(viewMd);
  let missingCode = null;
  try {
    await publish(fullSource, target);
  } catch (error) {
    missingCode = error?.code ?? String(error);
  }
  assert(
    missingCode === "PUBLICATION_PARTIAL_OR_FOREIGN" || missingCode === "PUBLICATION_WINDOWS_PROTECTED_IO",
    `live partial must fail, got ${missingCode}`,
  );
  assert(fs.existsSync(bundleDir), "must not delete live CA bundle dir");
  assert(!fs.existsSync(viewMd), "must not whitewash missing artifact");
  assert(
    JSON.stringify(fs.readdirSync(bundleDir).sort()) === JSON.stringify(beforeNames.filter((n) => n !== "view.md")),
    "live partial residue must remain untouched",
  );

  // Restore for collision path: rewrite one artifact to different bytes while latest still points here.
  const target2 = makeSandbox("live-collision");
  const pub2 = await publish(fullSource, target2);
  const bundleDir2 = path.join(stableRoot(target2), "bundles", pub2.bundle_hash);
  const collisionFile = path.join(bundleDir2, "view.md");
  nativeMod.durableAtomicReplaceFile(addon, collisionFile, Buffer.from("not-the-expected-view-md\n", "utf8"));
  let collisionCode = null;
  try {
    await publish(fullSource, target2);
  } catch (error) {
    collisionCode = error?.code ?? String(error);
  }
  assert(collisionCode === "PUBLICATION_COLLISION", `live collision must fail, got ${collisionCode}`);
  assert(fs.existsSync(bundleDir2), "must not delete collided live CA dir");
  assert(fs.readFileSync(collisionFile, "utf8") === "not-the-expected-view-md\n", "must not replace collided artifact");
  void original;
});

await check("non-live partial residual: safe create-only completion", async () => {
  const target = makeSandbox("nonlive-residual");
  const full = await publish(fullSource, target);
  // Publish empty so latest points elsewhere; leave a partial residual of the full hash.
  const empty = await publish(emptySource, target);
  assert(empty.bundle_hash !== full.bundle_hash, "need distinct hashes");
  const residualDir = path.join(stableRoot(target), "bundles", full.bundle_hash);
  assert(fs.existsSync(residualDir), "full bundle dir should remain content-addressed");
  // Simulate crash residual: drop two artifacts from the non-live full bundle.
  fs.unlinkSync(path.join(residualDir, "view.md"));
  fs.unlinkSync(path.join(residualDir, "parity.json"));
  const rebuilt = await publish(fullSource, target);
  assert(rebuilt.bundle_hash === full.bundle_hash, "should republish full hash");
  assert(
    JSON.stringify(fs.readdirSync(residualDir).sort()) === JSON.stringify([...FIVE].sort()),
    "residual must complete to all-five",
  );
  const read = readRuntime(target);
  assert(read.ok && read.bundleHash === full.bundle_hash, "completed residual must be injectable");
});

await check("native latest temp: cleanup under lock + reader ignore; foreign approx rejected", async () => {
  const target = makeSandbox("latest-temp");
  const pub = await publish(fullSource, target);
  const root = stableRoot(target);
  const exactTemp = path.join(root, `.latest.pi-astack-tmp.${process.pid}-123456789.tmp`);
  // Create exact protected private_rw temp residue.
  assert(nativeMod.durableAtomicCreateFile(addon, exactTemp, Buffer.from("temp-residue\n", "utf8")) === true, "create exact temp");
  // Reader must ignore exact protected temp during publish window (not foreign_root).
  const readWithTemp = readRuntime(target);
  assert(readWithTemp.ok && readWithTemp.bundleHash === pub.bundle_hash, `reader must ignore exact latest temp: ${readWithTemp.reason}`);

  // Publisher under lock must clean exact protected temp.
  await publish(fullSource, target);
  assert(!fs.existsSync(exactTemp), "publisher must clean exact latest native temp");

  // Approximate foreign name must fail closed (not cleaned as managed temp).
  const approx = path.join(root, `.latest-pi-astack-tmp.${process.pid}-1.tmp`);
  fs.writeFileSync(approx, "foreign\n");
  let approxCode = null;
  try {
    await publish(emptySource, target);
  } catch (error) {
    approxCode = error?.code ?? String(error);
  }
  assert(approxCode === "PUBLICATION_FOREIGN_STATE", `approx foreign must reject, got ${approxCode}`);
  assert(fs.existsSync(approx), "foreign approx must not be deleted as managed temp");

  // Reader also rejects approximate foreign name.
  const readApprox = readRuntime(target);
  assert(readApprox.ok === false && readApprox.reason === "foreign_root", `reader approx got ${readApprox.reason}`);
});

await check("exact grammar weak DACL latest temp → loud zero; protected exact may ignore", async () => {
  const target = makeSandbox("latest-temp-weak-dacl");
  const pub = await publish(fullSource, target);
  const root = stableRoot(target);

  // Same exact grammar as native latest temp, but ordinary Node create → weak DACL.
  // Reader must NOT ignore on lstat-regular alone; loud zero required.
  const weakTemp = path.join(root, `.latest.pi-astack-tmp.${process.pid}-987654321.tmp`);
  fs.writeFileSync(weakTemp, "weak-dacl-temp\n");
  const readWeak = readRuntime(target);
  assert(readWeak.ok === false, "weak DACL exact temp must loud-zero");
  assert(
    readWeak.reason === "latest_tampered" || readWeak.reason === "foreign_root" || readWeak.reason === "read_failed",
    `weak DACL temp unexpected reason ${readWeak.reason}`,
  );
  assert(!String(readWeak.error || "").includes("win32="), "must not leak native win32 codes");
  assert(fs.existsSync(weakTemp), "reader must not delete weak temp residue");
  fs.unlinkSync(weakTemp);

  // Control: protected exact private_rw temp is still ignorable after root verify + native file verify.
  const protectedTemp = path.join(root, `.latest.pi-astack-tmp.${process.pid}-112233445.tmp`);
  assert(
    nativeMod.durableAtomicCreateFile(addon, protectedTemp, Buffer.from("protected-temp\n", "utf8")) === true,
    "create protected exact temp",
  );
  const readProtected = readRuntime(target);
  assert(
    readProtected.ok && readProtected.bundleHash === pub.bundle_hash,
    `protected exact temp must remain ignorable: ${readProtected.reason}`,
  );
});

await check("runtime maxReadBytes oversize reason", async () => {
  const target = makeSandbox("oversize");
  await publish(fullSource, target);
  const tight = reader.readPropositionPolicyStableViewForRuntime({
    abrainHome: target,
    settings: { maxReadBytes: 1024 },
    sessionManager: manager(),
    windowsNativeAddon: addon,
  });
  assert(tight.ok === false && tight.reason === "oversize", `expected oversize, got ${tight.reason}`);
});

await check("pointer larger than max → latest_invalid (not latest_tampered)", async () => {
  const target = makeSandbox("pointer-oversize");
  await publish(fullSource, target);
  const huge = Buffer.from(`bundles/${"a".repeat(64)}\n` + "X".repeat(200), "utf8");
  nativeMod.durableAtomicReplaceFile(addon, latestPath(target), huge);
  const read = readRuntime(target);
  assert(read.ok === false && read.reason === "latest_invalid", `expected latest_invalid, got ${read.reason}`);
});

await check("runtime unset test hooks: override becomes unusable", async () => {
  const previous = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  stableWin.stableViewWindowsNativeTestApi.installAddonOverride(addon);
  assert(stableWin.stableViewWindowsNativeTestApi.hasProductionSingleton() === false
    || typeof stableWin.stableViewWindowsNativeTestApi.hasProductionSingleton() === "boolean",
  "hasProductionSingleton gated call works with hooks");
  // Unset hooks: resolve must not use override; reset/has must gate.
  delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  let resolveCode = null;
  try {
    stableWin.resolveStableViewWindowsNativeAddon();
  } catch (error) {
    resolveCode = error?.code ?? String(error);
  }
  assert(
    resolveCode === "WINDOWS_STABLE_VIEW_TEST_HOOKS_DISABLED"
      || resolveCode === "WINDOWS_STABLE_VIEW_NATIVE_UNAVAILABLE",
    `unset hooks must disable override resolve, got ${resolveCode}`,
  );
  let resetCode = null;
  try {
    stableWin.stableViewWindowsNativeTestApi.resetProductionSingleton();
  } catch (error) {
    resetCode = error?.code ?? String(error);
  }
  assert(resetCode === "WINDOWS_STABLE_VIEW_TEST_HOOKS_DISABLED", `reset must gate, got ${resetCode}`);
  let hasCode = null;
  try {
    stableWin.stableViewWindowsNativeTestApi.hasProductionSingleton();
  } catch (error) {
    hasCode = error?.code ?? String(error);
  }
  assert(hasCode === "WINDOWS_STABLE_VIEW_TEST_HOOKS_DISABLED", `has must gate, got ${hasCode}`);
  // Restore hooks + override for trailing checks.
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = previous || "1";
  stableWin.stableViewWindowsNativeTestApi.installAddonOverride(addon);
  retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(addon);
});

await check("production zero-arg path without test override remains fail-closed", async () => {
  stableWin.stableViewWindowsNativeTestApi.installAddonOverride(null);
  stableWin.stableViewWindowsNativeTestApi.resetProductionSingleton();
  retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(null);
  retainedLock.retainedDirectoryLockTestApi.resetWindowsAddonSingleton();
  const target = makeSandbox("prod-fail-closed");
  let code = null;
  try {
    await publisher.__TEST.publishSandboxProductionForTests({
      sourceAbrainHome: fullSource,
      targetAbrainHome: target,
      repoRoot,
      // no windowsNativeAddon — production loader only
    });
  } catch (error) {
    code = error?.code ?? String(error);
  }
  assert(
    code === "WINDOWS_NATIVE_UNAVAILABLE"
      || code === "LOCK_BUSY"
      || code === "RETAINED_DIRECTORY_LOCK_UNSUPPORTED"
      || String(code || "").includes("WINDOWS_NATIVE")
      || String(code || "").includes("PROVENANCE"),
    `expected production fail-closed, got ${code}`,
  );
  // Restore overrides for any trailing checks.
  retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(addon);
  stableWin.stableViewWindowsNativeTestApi.installAddonOverride(addon);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.name}: ${f.error?.message || f.error}`);
  process.exit(1);
}
console.log("OK windows stable-view durable smoke");
