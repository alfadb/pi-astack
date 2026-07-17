#!/usr/bin/env node
/** Reviewed ADR0040 P2a.2 bootstrap helper. The writable path is hardcoded. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ABRAIN = "/home/worker/.abrain";
const SEDIMENT = `${ABRAIN}/.state/sediment`;
const PARENT = `${SEDIMENT}/proposition-policy-push-shadow`;
const TARGET = `${PARENT}/v1`;
const MANIFEST = "/run/pi-astack/bootstrap-manifest.json";
const SCHEMA = "proposition-policy-push-bootstrap-manifest/v1";
const HASH_SCOPE = "sha256 over canonical sorted-key JSON UTF-8 bytes of this manifest with manifest_hash omitted";
const SHA256 = /^[0-9a-f]{64}$/;

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
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("BOOTSTRAP_MANIFEST_INVALID", `${at} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("BOOTSTRAP_MANIFEST_INVALID", `${at} keys differ`, { actual, wanted });
}

function validateManifest(value) {
  exactKeys(value, ["schema_version", "hash_algorithm", "manifest_hash_scope", "mode", "plan_hash", "plan_raw_sha256", "bootstrap_source_sha256", "test_crash_at", "manifest_hash"], "manifest");
  if (value.schema_version !== SCHEMA || value.hash_algorithm !== "sha256" || value.manifest_hash_scope !== HASH_SCOPE) fail("BOOTSTRAP_MANIFEST_INVALID", "manifest identity differs");
  if (!['production', 'sandbox_test'].includes(value.mode)) fail("BOOTSTRAP_MANIFEST_INVALID", "mode differs");
  for (const key of ["plan_hash", "plan_raw_sha256", "bootstrap_source_sha256", "manifest_hash"]) if (!SHA256.test(value[key])) fail("BOOTSTRAP_MANIFEST_INVALID", `${key} is not SHA-256`);
  if (value.mode === "production" && value.test_crash_at !== null) fail("BOOTSTRAP_MANIFEST_INVALID", "production manifest exposes a crash hook");
  if (value.test_crash_at !== null && value.test_crash_at !== "parent_ready") fail("BOOTSTRAP_MANIFEST_INVALID", "unknown crash transition");
  const base = { ...value };
  delete base.manifest_hash;
  if (sha256(stable(base)) !== value.manifest_hash) fail("BOOTSTRAP_MANIFEST_INVALID", "manifest self-hash differs");
}

function verifyDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) fail("BOOTSTRAP_PATH_UNSAFE", `${label} is not an exact non-symlink directory`, { directory });
  return stat;
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureHardcodedDirectory(directory, parent) {
  let created = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    created = true;
    fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = verifyDirectory(directory, path.basename(directory));
  if ((stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid() || stat.gid !== process.getgid()) {
    fail("BOOTSTRAP_PATH_METADATA", "hardcoded directory mode or ownership differs", { directory, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid });
  }
  return { created, stat };
}

try {
  const raw = fs.readFileSync(MANIFEST, "utf8");
  const manifest = JSON.parse(raw);
  if (raw !== `${stable(manifest)}\n`) fail("BOOTSTRAP_MANIFEST_INVALID", "manifest bytes are not canonical plus one newline");
  validateManifest(manifest);
  verifyDirectory(ABRAIN, "abrain");
  verifyDirectory(`${ABRAIN}/.state`, ".state");
  const sediment = verifyDirectory(SEDIMENT, "sediment");
  const parent = ensureHardcodedDirectory(PARENT, SEDIMENT);
  if (manifest.mode === "sandbox_test" && manifest.test_crash_at === "parent_ready") process.kill(process.pid, "SIGKILL");
  const target = ensureHardcodedDirectory(TARGET, PARENT);
  fsyncDirectory(PARENT);
  process.stdout.write(`${JSON.stringify({
    schema_version: "proposition-policy-push-bootstrap-result/v1",
    status: parent.created || target.created ? "created_or_recovered" : "identical",
    sediment_identity: { dev: sediment.dev, ino: sediment.ino },
    parent_identity: { dev: parent.stat.dev, ino: parent.stat.ino },
    target_identity: { dev: target.stat.dev, ino: target.stat.ino },
  })}\n`);
} catch (error) {
  process.stderr.write(`${error?.code || "BOOTSTRAP_FAILED"}: ${error?.message || String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
}
