#!/usr/bin/env node
/** Reviewed ADR0040 P2a.2 installer helper. Only the hardcoded target is writable. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TARGET = "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1";
const MANIFEST = "/run/pi-astack/installer-manifest.json";
const BUNDLE_SOURCE = "/run/pi-astack/bundle";
const SCHEMA = "proposition-policy-push-installer-manifest/v1";
const HASH_SCOPE = "sha256 over canonical sorted-key JSON UTF-8 bytes of this manifest with manifest_hash omitted";
const ARTIFACTS = ["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"];
const SHA256 = /^[0-9a-f]{64}$/;
let staleReadyRechecks = 0;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fail(code, message, detail = undefined) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.detail = detail;
  throw error;
}

function exactKeys(value, expected, at) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INSTALLER_MANIFEST_INVALID", `${at} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("INSTALLER_MANIFEST_INVALID", `${at} keys differ`, { actual, wanted });
}

function validateManifest(value) {
  exactKeys(value, ["schema_version", "hash_algorithm", "manifest_hash_scope", "mode", "plan_hash", "plan_raw_sha256", "installer_source_sha256", "bundle_hash", "artifact_rows", "target_identity", "transaction_id", "test_crash_at", "test_pause_after_stale_ready_ms", "manifest_hash"], "manifest");
  if (value.schema_version !== SCHEMA || value.hash_algorithm !== "sha256" || value.manifest_hash_scope !== HASH_SCOPE) fail("INSTALLER_MANIFEST_INVALID", "manifest identity differs");
  if (!['production', 'sandbox_test'].includes(value.mode)) fail("INSTALLER_MANIFEST_INVALID", "mode differs");
  for (const key of ["plan_hash", "plan_raw_sha256", "installer_source_sha256", "bundle_hash", "transaction_id", "manifest_hash"]) if (!SHA256.test(value[key])) fail("INSTALLER_MANIFEST_INVALID", `${key} is not SHA-256`);
  exactKeys(value.target_identity, ["dev", "ino"], "manifest.target_identity");
  if (![value.target_identity.dev, value.target_identity.ino].every((item) => Number.isSafeInteger(item) && item > 0)) fail("INSTALLER_MANIFEST_INVALID", "target identity is invalid");
  if (!Array.isArray(value.artifact_rows) || value.artifact_rows.length !== ARTIFACTS.length) fail("INSTALLER_MANIFEST_INVALID", "artifact cardinality differs");
  for (const [index, row] of value.artifact_rows.entries()) {
    exactKeys(row, ["name", "bytes", "sha256"], `manifest.artifact_rows[${index}]`);
    if (row.name !== ARTIFACTS[index] || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !SHA256.test(row.sha256)) fail("INSTALLER_MANIFEST_INVALID", "artifact row differs", { index });
  }
  const transitions = [null, "staging_partial", "bundle_ready", "complete_latest"];
  if (!transitions.includes(value.test_crash_at)) fail("INSTALLER_MANIFEST_INVALID", "unknown crash transition");
  if (!Number.isSafeInteger(value.test_pause_after_stale_ready_ms) || value.test_pause_after_stale_ready_ms < 0 || value.test_pause_after_stale_ready_ms > 5000) fail("INSTALLER_MANIFEST_INVALID", "stale-ready pause is invalid");
  if (value.mode === "production" && (value.test_crash_at !== null || value.test_pause_after_stale_ready_ms !== 0)) fail("INSTALLER_MANIFEST_INVALID", "production manifest exposes a test hook");
  const base = { ...value };
  delete base.manifest_hash;
  if (sha256(stable(base)) !== value.manifest_hash) fail("INSTALLER_MANIFEST_INVALID", "manifest self-hash differs");
}

function lstatMaybe(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function verifyDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) fail("INSTALLER_PATH_UNSAFE", `${label} is not an exact non-symlink directory`, { directory });
  return stat;
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDirectory(directory, parent) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = verifyDirectory(directory, path.basename(directory));
  if ((stat.mode & 0o7777) !== 0o700) fs.chmodSync(directory, 0o700);
}

function verifyRegularExact(file, expected, allowPrefix = false, missingOk = false) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== file) fail("INSTALLER_ARTIFACT_UNSAFE", "artifact is not an exact regular file", { file });
    const actual = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || fs.realpathSync(file) !== file) fail("INSTALLER_ARTIFACT_RACE", "artifact identity changed while read", { file });
    const valid = allowPrefix ? actual.length <= expected.length && actual.equals(expected.subarray(0, actual.length)) : actual.equals(expected);
    if (!valid) fail("INSTALLER_ARTIFACT_COLLISION", "artifact bytes differ", { file });
    return actual;
  } catch (error) {
    if (missingOk && error?.code === "ENOENT") return null;
    throw error;
  }
}

function readBundle(manifest) {
  verifyDirectory(BUNDLE_SOURCE, "bundle source");
  const names = fs.readdirSync(BUNDLE_SOURCE).sort();
  if (stable(names) !== stable(ARTIFACTS)) fail("INSTALLER_BUNDLE_SOURCE", "bundle source inventory differs", { names });
  const output = new Map();
  for (const row of manifest.artifact_rows) {
    const file = path.join(BUNDLE_SOURCE, row.name);
    const bytes = verifyRegularExact(file, fs.readFileSync(file));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) fail("INSTALLER_BUNDLE_SOURCE", "bundle source hash differs", { name: row.name });
    output.set(row.name, bytes);
  }
  const semantic = JSON.parse(output.get("manifest.json").toString("utf8"));
  if (semantic.bundle_hash !== manifest.bundle_hash) fail("INSTALLER_BUNDLE_SOURCE", "semantic manifest bundle hash differs");
  return output;
}

function readdirMaybe(directory) {
  try { return fs.readdirSync(directory).sort(); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function assertAllowedPartial(directory, bundle, allowPrefix) {
  const stat = lstatMaybe(directory);
  if (!stat) return [];
  try { verifyDirectory(directory, "partial bundle"); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const names = readdirMaybe(directory);
  if (!names) return [];
  const present = [];
  for (const name of names) {
    if (!ARTIFACTS.includes(name)) fail("INSTALLER_FOREIGN_STATE", "partial directory contains a foreign name", { directory, name });
    if (verifyRegularExact(path.join(directory, name), bundle.get(name), allowPrefix, true)) present.push(name);
  }
  return present;
}

function inspectState(manifest, bundle) {
  verifyDirectory(TARGET, "target");
  const allowed = new Set(["bundles", "latest", "staging"]);
  const rootNames = readdirMaybe(TARGET);
  if (!rootNames) throw Object.assign(new Error("target disappeared during inspection"), { code: "ENOENT" });
  for (const name of rootNames) if (!allowed.has(name)) fail("INSTALLER_FOREIGN_STATE", "target contains a foreign name", { name });
  const bundleRoot = path.join(TARGET, "bundles");
  const bundleDir = path.join(bundleRoot, manifest.bundle_hash);
  const stagingRoot = path.join(TARGET, "staging");
  const stageDir = path.join(stagingRoot, manifest.transaction_id);
  let ready = false;
  if (lstatMaybe(bundleRoot)) {
    verifyDirectory(bundleRoot, "bundles");
    const children = readdirMaybe(bundleRoot);
    if (!children) throw Object.assign(new Error("bundles disappeared during inspection"), { code: "ENOENT" });
    if (children.some((name) => name !== manifest.bundle_hash)) fail("INSTALLER_FOREIGN_STATE", "bundles contains a foreign bundle", { children });
    if (children.includes(manifest.bundle_hash)) {
      const names = assertAllowedPartial(bundleDir, bundle, false);
      ready = names.length === ARTIFACTS.length;
    }
  }
  let staged = false;
  if (lstatMaybe(stagingRoot)) {
    verifyDirectory(stagingRoot, "staging");
    const children = readdirMaybe(stagingRoot) ?? [];
    if (children.some((name) => name !== manifest.transaction_id)) fail("INSTALLER_FOREIGN_STATE", "staging contains a foreign transaction", { children });
    if (children.includes(manifest.transaction_id)) {
      assertAllowedPartial(stageDir, bundle, true);
      staged = true;
    }
  }
  const latest = path.join(TARGET, "latest");
  if (!ready && manifest.mode === "sandbox_test" && manifest.test_pause_after_stale_ready_ms > 0) sleep(manifest.test_pause_after_stale_ready_ms);
  const latestStat = lstatMaybe(latest);
  if (latestStat) {
    if (!latestStat.isSymbolicLink() || fs.readlinkSync(latest) !== `bundles/${manifest.bundle_hash}`) fail("INSTALLER_LATEST_UNSAFE", "latest is foreign");
    if (!ready) {
      const freshNames = assertAllowedPartial(bundleDir, bundle, false);
      if (freshNames.length !== ARTIFACTS.length) throw Object.assign(new Error("latest appeared before a fresh exact bundle observation"), { code: "INSTALLER_CONCURRENT_RETRY" });
      staleReadyRechecks += 1;
    }
    return "complete";
  }
  if (ready && !staged) return "bundle_ready";
  return staged || rootNames.length ? "staging_partial" : "empty";
}

function writeConvergent(file, expected) {
  let fd;
  try {
    try { fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      verifyRegularExact(file, expected, true);
      const actual = fs.readFileSync(file);
      if (actual.equals(expected)) return;
      fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    }
    let offset = fs.fstatSync(fd).size;
    while (offset < expected.length) offset += fs.writeSync(fd, expected, offset, expected.length - offset, offset);
    fs.ftruncateSync(fd, expected.length);
    fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  verifyRegularExact(file, expected, false);
}

function linkNoReplace(source, target, expected) {
  try {
    fs.linkSync(source, target);
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if (error?.code === "ENOENT" && lstatMaybe(target)) {
      verifyRegularExact(target, expected, false);
      return;
    }
    if (error?.code !== "EEXIST") throw error;
  }
  verifyRegularExact(target, expected, false);
  fs.chmodSync(target, 0o600);
}

function cleanupStage(stageDir, stagingRoot, bundle) {
  const names = readdirMaybe(stageDir) ?? [];
  for (const name of names) if (!ARTIFACTS.includes(name)) fail("INSTALLER_FOREIGN_STATE", "stage cleanup found a foreign name", { name });
  for (const name of ARTIFACTS) {
    const file = path.join(stageDir, name);
    if (!verifyRegularExact(file, bundle.get(name), false, true)) continue;
    try { fs.unlinkSync(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  try { fs.rmdirSync(stageDir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
  try { fs.rmdirSync(stagingRoot); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(sleepCell, 0, 0, ms); }

function settleStage(stageDir, stagingRoot, bundle) {
  let stableAbsent = 0;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try { cleanupStage(stageDir, stagingRoot, bundle); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!lstatMaybe(stageDir) && !lstatMaybe(stagingRoot)) {
      stableAbsent += 1;
      if (stableAbsent >= 4) return;
    } else stableAbsent = 0;
    sleep(1);
  }
  fail("INSTALLER_CONCURRENT_TIMEOUT", "staging did not converge after bounded retries");
}

function inspectConvergent(manifest, bundle) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try { return inspectState(manifest, bundle); }
    catch (error) { if (!["ENOENT", "INSTALLER_CONCURRENT_RETRY"].includes(error?.code)) throw error; }
    sleep(1);
  }
  fail("INSTALLER_CONCURRENT_TIMEOUT", "state inspection did not converge after bounded retries");
}

function crash(manifest, transition) {
  if (manifest.mode === "sandbox_test" && manifest.test_crash_at === transition) process.kill(process.pid, "SIGKILL");
}

try {
  const raw = fs.readFileSync(MANIFEST, "utf8");
  const manifest = JSON.parse(raw);
  if (raw !== `${stable(manifest)}\n`) fail("INSTALLER_MANIFEST_INVALID", "manifest bytes are not canonical plus one newline");
  validateManifest(manifest);
  const targetStat = verifyDirectory(TARGET, "target");
  if (targetStat.dev !== manifest.target_identity.dev || targetStat.ino !== manifest.target_identity.ino) fail("INSTALLER_TARGET_REPLACED", "target identity differs from the FD-verified handoff");
  const bundle = readBundle(manifest);
  const initialState = inspectConvergent(manifest, bundle);
  const bundlesRoot = path.join(TARGET, "bundles");
  const bundleDir = path.join(bundlesRoot, manifest.bundle_hash);
  const stagingRoot = path.join(TARGET, "staging");
  const stageDir = path.join(stagingRoot, manifest.transaction_id);
  const latest = path.join(TARGET, "latest");
  let finalState = initialState;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      const observed = inspectState(manifest, bundle);
      if (observed !== "complete") {
        ensureDirectory(stagingRoot, TARGET);
        ensureDirectory(stageDir, stagingRoot);
        for (const [index, name] of ARTIFACTS.entries()) {
          writeConvergent(path.join(stageDir, name), bundle.get(name));
          if (index === 0) crash(manifest, "staging_partial");
        }
        fsyncDirectory(stageDir);
        ensureDirectory(bundlesRoot, TARGET);
        ensureDirectory(bundleDir, bundlesRoot);
        for (const name of ARTIFACTS) linkNoReplace(path.join(stageDir, name), path.join(bundleDir, name), bundle.get(name));
        fsyncDirectory(bundleDir);
        fsyncDirectory(bundlesRoot);
        if (assertAllowedPartial(bundleDir, bundle, false).length !== ARTIFACTS.length) throw Object.assign(new Error("bundle observation raced"), { code: "ENOENT" });
        crash(manifest, "bundle_ready");
        try {
          fs.symlinkSync(`bundles/${manifest.bundle_hash}`, latest, "dir");
          fsyncDirectory(TARGET);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const stat = fs.lstatSync(latest);
          if (!stat.isSymbolicLink() || fs.readlinkSync(latest) !== `bundles/${manifest.bundle_hash}`) fail("INSTALLER_LATEST_UNSAFE", "latest collision differs");
        }
        crash(manifest, "complete_latest");
      }
      settleStage(stageDir, stagingRoot, bundle);
      finalState = inspectState(manifest, bundle);
      if (finalState === "complete") break;
    } catch (error) {
      if (!["ENOENT", "INSTALLER_CONCURRENT_RETRY"].includes(error?.code)) throw error;
    }
    sleep(1);
  }
  if (finalState !== "complete") fail("INSTALLER_CONCURRENT_TIMEOUT", "transaction did not converge after bounded retries", { finalState });
  process.stdout.write(`${JSON.stringify({
    schema_version: "proposition-policy-push-installer-result/v1",
    status: initialState === "complete" ? "identical" : initialState === "empty" ? "created" : "recovered",
    initial_state: initialState,
    final_state: finalState,
    bundle_hash: manifest.bundle_hash,
    transaction_id: manifest.transaction_id,
    stale_ready_rechecks: staleReadyRechecks,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error?.code || "INSTALLER_FAILED"}: ${error?.message || String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
}
