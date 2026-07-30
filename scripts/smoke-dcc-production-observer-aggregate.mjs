#!/usr/bin/env node
/**
 * Fixture-only smoke for scripts/dcc-production-observer-aggregate.mjs.
 * Temporary ABRAIN trees only — never touches real ~/.abrain or production state.
 * Validates ready/pending/failed/corrupt/observer-fail, strict no-secret output,
 * and zero ABRAIN tree delta around the CLI invocation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "scripts/dcc-production-observer-aggregate.mjs");
const SCHEMA = "pi-astack/dcc-production-observer-aggregate/v1";

const EPOCH = "3";
const HOLDER = crypto.createHash("sha256").update("dcc-prod-obs-holder").digest("hex");
const STATE_DIR_KEY = crypto.createHash("sha256").update("dcc-prod-obs-state").digest("hex");
const RUN_NONCE = crypto.createHash("sha256").update("dcc-prod-obs-run").digest("hex");

const SECRET_NEEDLES = [
  HOLDER,
  STATE_DIR_KEY,
  RUN_NONCE,
  "local_executor_epoch",
  "local_executor_holder_nonce",
  "canonical_head",
  "convergence_generation",
  "canonical-convergence",
  "authority.json",
  "attestation.json",
  "bind-intent",
  "itemId",
  "/home/",
  "pending=",
  "failed=",
  "invalid=",
  "ENOENT",
  "EACCES",
];

let failures = 0;

function assert(value, message) {
  if (!value) {
    failures += 1;
    console.error(`FAIL ${message}`);
    throw new Error(message);
  }
}

function hex40(seed) {
  return crypto.createHash("sha1").update(String(seed)).digest("hex");
}

function snapshotTree(dir) {
  const rows = [];
  function walk(current, rel = "") {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const next = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) rows.push(`l:${next}->${fs.readlinkSync(full)}`);
      else if (st.isDirectory()) {
        rows.push(`d:${next}`);
        walk(full, next);
      } else if (st.isFile()) {
        const body = fs.readFileSync(full);
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        rows.push(`f:${next}:${st.mode & 0o777}:${body.length}:${hash}`);
      } else {
        rows.push(`o:${next}`);
      }
    }
  }
  walk(dir);
  return rows.join("\n");
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function initGitAbrain(base, name) {
  const abrain = path.join(base, name);
  fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
  fs.chmodSync(abrain, 0o700);
  git(abrain, "init");
  git(abrain, "config", "user.email", "dcc-prod-obs@example.invalid");
  git(abrain, "config", "user.name", "dcc-prod-obs");
  fs.writeFileSync(path.join(abrain, ".gitignore"), ".state/\n", { mode: 0o600 });
  fs.writeFileSync(path.join(abrain, "README.md"), "fixture\n", { mode: 0o600 });
  git(abrain, "add", ".gitignore", "README.md");
  git(abrain, "commit", "-m", "fixture");
  return abrain;
}

function writeAuthority(abrain, overrides = {}) {
  const directory = path.join(abrain, ".state", "sediment", "local-executor-authority");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const lock = path.join(directory, "authority.lock");
  const file = path.join(directory, "authority.json");
  fs.writeFileSync(lock, "", { mode: 0o600 });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      schema: "pi-router/local-sediment-executor-authority/v1",
      local_executor_epoch: EPOCH,
      mode: "held",
      holder_kind: "daemon",
      holder_nonce: HOLDER,
      state_dir_key: STATE_DIR_KEY,
      run_nonce: RUN_NONCE,
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(lock, 0o600);
  fs.chmodSync(file, 0o600);
  return lock;
}

function writeAttestation(abrain, head, overrides = {}) {
  const directory = path.join(abrain, ".state", "sediment", "canonical-convergence");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "attestation.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      schema: "pi-astack/canonical-convergence-attestation/v1",
      local_executor_epoch: EPOCH,
      local_executor_holder_nonce: HOLDER,
      convergence_generation: "1",
      outcome: "ready",
      reason_code: "none",
      canonical_head: head,
      published_at_ms: 1_800_000_000_000,
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(file, 0o600);
}

async function buildValidIntent(_abrain) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const bindIntent = await jiti.import(path.join(root, "extensions/abrain/bind-intent.ts"));
  const intent = bindIntent.buildAbrainBindIntent({
    projectId: "fixture-project",
    projectRoot: "/tmp/dcc-prod-obs-fixture-project",
    normalizedPath: "/tmp/dcc-prod-obs-fixture-project",
    registryRelativePath: "projects/fixture-project/_project.json",
    registryBytes: `${JSON.stringify({
      schema_version: 1,
      project_id: "fixture-project",
      created_at: "2026-07-30T00:00:00.000+08:00",
      updated_at: "2026-07-30T00:00:00.000+08:00",
    }, null, 2)}\n`,
    registryCreated: true,
    gitignoreRelativePath: ".gitignore",
    gitignoreBytes: ".state/\n",
    gitignoreUpdated: false,
    message: "project: add fixture-project",
  });
  return { bindIntent, intent };
}

function runCli(abrainRoot, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Production CLI must not see test hooks.
  delete env.PI_ASTACK_ENABLE_TEST_HOOKS;
  if (abrainRoot === null) {
    delete env.DCC_ABRAIN_ROOT;
  } else {
    env.DCC_ABRAIN_ROOT = abrainRoot;
  }
  const result = spawnSync(process.execPath, [CLI], {
    encoding: "utf8",
    env,
    cwd: root,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function assertNoSecrets(text, label) {
  for (const needle of SECRET_NEEDLES) {
    if (text.includes(needle)) {
      assert(false, `${label}: leaked ${needle}`);
    }
  }
  // Never print exact path fragments of the fixture tree.
  if (/\/tmp\/[A-Za-z0-9._-]*dcc-prod-obs/.test(text)) {
    assert(false, `${label}: leaked fixture path`);
  }
  // No count-like inventory fields.
  if (/"pending"\s*:/.test(text) || /"failed"\s*:/.test(text) || /"invalid"\s*:/.test(text)) {
    assert(false, `${label}: leaked inventory counts`);
  }
}

function parseStrictAggregate(stdout, label) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  assert(lines.length === 1, `${label}: expected exactly one stdout line, got ${lines.length}`);
  let obj;
  try {
    obj = JSON.parse(lines[0]);
  } catch {
    assert(false, `${label}: stdout not JSON`);
  }
  assert(obj && typeof obj === "object" && !Array.isArray(obj), `${label}: not object`);
  const keys = Object.keys(obj).sort();
  assert(
    keys.join(",") === "reason_code,schema,status",
    `${label}: unexpected keys ${keys.join(",")}`,
  );
  assert(obj.schema === SCHEMA, `${label}: schema`);
  assert(typeof obj.status === "string", `${label}: status type`);
  assert(typeof obj.reason_code === "string", `${label}: reason type`);
  return obj;
}

async function withFlock(lockPath, fn) {
  if (process.platform !== "linux" || !fs.existsSync("/usr/bin/flock")) {
    throw new Error("linux_flock_required");
  }
  const holder = spawn("/usr/bin/flock", ["-F", "-x", lockPath, "/bin/sleep", "30"], {
    stdio: "ignore",
  });
  try {
    // Wait until lock is actually held by probing with non-blocking flock.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const probe = spawnSync("/usr/bin/flock", ["-F", "-n", lockPath, "-c", "true"], {
        encoding: "utf8",
      });
      if (probe.status !== 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return await fn();
  } finally {
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("close", resolve));
  }
}

async function caseReady(base) {
  const abrain = initGitAbrain(base, "ready");
  const head = git(abrain, "rev-parse", "HEAD");
  const lockPath = writeAuthority(abrain);
  writeAttestation(abrain, head);
  const before = snapshotTree(abrain);
  await withFlock(lockPath, async () => {
    // Retry briefly for flock visibility.
    let last = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      last = runCli(abrain);
      const obj = parseStrictAggregate(last.stdout, "ready");
      assertNoSecrets(`${last.stdout}\n${last.stderr}`, "ready");
      if (obj.status === "ready" && obj.reason_code === "none" && last.status === 0) {
        assert(snapshotTree(abrain) === before, "ready: tree delta");
        console.log("  ok    ready");
        return;
      }
      if (obj.status === "blocked" && obj.reason_code === "authority_revoked") {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      assert(
        false,
        `ready: unexpected ${JSON.stringify(obj)} exit=${last.status} stderr=${last.stderr}`,
      );
    }
    assert(false, `ready: timed out last=${JSON.stringify(last)}`);
  });
}

async function casePending(base) {
  const abrain = initGitAbrain(base, "pending");
  const head = git(abrain, "rev-parse", "HEAD");
  const lockPath = writeAuthority(abrain);
  writeAttestation(abrain, head);
  const { intent } = await buildValidIntent(abrain);
  const pendingDir = path.join(abrain, ".state", "abrain", "bind-intent", "pending");
  fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(pendingDir, `${intent.itemId}.json`),
    `${JSON.stringify(intent)}\n`,
    { mode: 0o600 },
  );
  const before = snapshotTree(abrain);
  await withFlock(lockPath, async () => {
    const last = runCli(abrain);
    const obj = parseStrictAggregate(last.stdout, "pending");
    assertNoSecrets(`${last.stdout}\n${last.stderr}`, "pending");
    assert(last.status === 1, "pending: exit");
    assert(obj.status === "blocked", `pending: status=${obj.status}`);
    assert(obj.reason_code === "continuation_pending", `pending: reason=${obj.reason_code}`);
    assert(snapshotTree(abrain) === before, "pending: tree delta");
    console.log("  ok    pending");
  });
}

async function caseFailed(base) {
  const abrain = initGitAbrain(base, "failed");
  const head = git(abrain, "rev-parse", "HEAD");
  const lockPath = writeAuthority(abrain);
  writeAttestation(abrain, head);
  const { intent } = await buildValidIntent(abrain);
  const failedDir = path.join(abrain, ".state", "abrain", "bind-intent", "failed");
  fs.mkdirSync(failedDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(failedDir, `${intent.itemId}.json`),
    `${JSON.stringify({ ...intent, note: "historical" })}\n`,
    { mode: 0o600 },
  );
  const before = snapshotTree(abrain);
  await withFlock(lockPath, async () => {
    const last = runCli(abrain);
    const obj = parseStrictAggregate(last.stdout, "failed");
    assertNoSecrets(`${last.stdout}\n${last.stderr}`, "failed");
    assert(last.status === 1, "failed: exit");
    assert(obj.status === "blocked", `failed: status=${obj.status}`);
    assert(obj.reason_code === "continuation_failed", `failed: reason=${obj.reason_code}`);
    assert(snapshotTree(abrain) === before, "failed: tree delta");
    console.log("  ok    failed");
  });
}

async function caseCorrupt(base) {
  const abrain = initGitAbrain(base, "corrupt");
  const head = git(abrain, "rev-parse", "HEAD");
  const lockPath = writeAuthority(abrain);
  writeAttestation(abrain, head);
  const pendingDir = path.join(abrain, ".state", "abrain", "bind-intent", "pending");
  fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pendingDir, "not-a-digest.json"), "{\"bad\":true}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(pendingDir, `${"b".repeat(64)}.json`), "{not-json\n", { mode: 0o600 });
  const before = snapshotTree(abrain);
  await withFlock(lockPath, async () => {
    const last = runCli(abrain);
    const obj = parseStrictAggregate(last.stdout, "corrupt");
    assertNoSecrets(`${last.stdout}\n${last.stderr}`, "corrupt");
    assert(last.status === 1, "corrupt: exit");
    assert(obj.status === "blocked", `corrupt: status=${obj.status}`);
    assert(obj.reason_code === "continuation_failed", `corrupt: reason=${obj.reason_code}`);
    assert(snapshotTree(abrain) === before, "corrupt: tree delta");
    console.log("  ok    corrupt");
  });
}

async function caseObserverFail(base) {
  const abrain = initGitAbrain(base, "observer-fail");
  // No authority store → observer closed fail; inventory clean.
  const before = snapshotTree(abrain);
  const last = runCli(abrain);
  const obj = parseStrictAggregate(last.stdout, "observer-fail");
  assertNoSecrets(`${last.stdout}\n${last.stderr}`, "observer-fail");
  assert(last.status === 1, "observer-fail: exit");
  assert(obj.status !== "ready", "observer-fail: must not be ready");
  assert(
    obj.status === "legacy" || obj.status === "unavailable" || obj.status === "blocked",
    `observer-fail: status=${obj.status}`,
  );
  assert(obj.reason_code !== "none", "observer-fail: reason");
  assert(snapshotTree(abrain) === before, "observer-fail: tree delta");
  console.log("  ok    observer-fail");
}

function caseEnvMissing() {
  const last = runCli(null);
  const obj = parseStrictAggregate(last.stdout, "env-missing");
  assertNoSecrets(`${last.stdout}\n${last.stderr}`, "env-missing");
  assert(last.status === 1, "env-missing: exit");
  assert(obj.status === "unavailable", "env-missing: status");
  assert(obj.reason_code === "env_missing", "env-missing: reason");
  console.log("  ok    env-missing");
}

function caseAbsoluteInvalid() {
  // Relative path must fail closed as absolute_invalid (never resolves relative cwd).
  const last = runCli("relative/not/absolute");
  const obj = parseStrictAggregate(last.stdout, "absolute-invalid");
  assertNoSecrets(`${last.stdout}\n${last.stderr}`, "absolute-invalid");
  assert(last.status === 1, "absolute-invalid: exit");
  assert(obj.status === "unavailable", "absolute-invalid: status");
  assert(obj.reason_code === "absolute_invalid", "absolute-invalid: reason");
  console.log("  ok    absolute-invalid");
}

async function caseAbrainLeafSymlink(base) {
  // Leaf symlink ABRAIN root: helpers reject plain-root requirement; closed fail, zero delta.
  const real = initGitAbrain(base, "leaf-symlink-real");
  const head = git(real, "rev-parse", "HEAD");
  const lockPath = writeAuthority(real);
  writeAttestation(real, head);
  const linkPath = path.join(base, "leaf-symlink-abrain");
  fs.symlinkSync(real, linkPath);
  const beforeReal = snapshotTree(real);
  await withFlock(lockPath, async () => {
    const last = runCli(linkPath);
    const obj = parseStrictAggregate(last.stdout, "abrain-leaf-symlink");
    assertNoSecrets(`${last.stdout}\n${last.stderr}`, "abrain-leaf-symlink");
    assert(last.status === 1, "abrain-leaf-symlink: exit");
    assert(obj.status !== "ready", "abrain-leaf-symlink: must not be ready");
    assert(obj.reason_code !== "none", "abrain-leaf-symlink: reason");
    assert(snapshotTree(real) === beforeReal, "abrain-leaf-symlink: tree delta");
    console.log("  ok    abrain-leaf-symlink");
  });
}

async function caseBindIntentIntermediateSymlink(base) {
  // Intermediate symlink under bind-intent chain: inventory fail-closed, zero tree delta.
  const abrain = initGitAbrain(base, "bind-int-symlink");
  const head = git(abrain, "rev-parse", "HEAD");
  const lockPath = writeAuthority(abrain);
  writeAttestation(abrain, head);
  const stateAbrain = path.join(abrain, ".state", "abrain");
  fs.mkdirSync(stateAbrain, { recursive: true, mode: 0o700 });
  const escapeTarget = path.join(base, "bind-int-escape");
  fs.mkdirSync(escapeTarget, { recursive: true, mode: 0o700 });
  fs.symlinkSync(escapeTarget, path.join(stateAbrain, "bind-intent"));
  const before = snapshotTree(abrain);
  await withFlock(lockPath, async () => {
    const last = runCli(abrain);
    const obj = parseStrictAggregate(last.stdout, "bind-intent-intermediate-symlink");
    assertNoSecrets(`${last.stdout}\n${last.stderr}`, "bind-intent-intermediate-symlink");
    assert(last.status === 1, "bind-intent-intermediate-symlink: exit");
    assert(obj.status !== "ready", "bind-intent-intermediate-symlink: must not be ready");
    assert(
      obj.reason_code === "inventory_unavailable" || obj.reason_code === "continuation_failed",
      `bind-intent-intermediate-symlink: reason=${obj.reason_code}`,
    );
    assert(snapshotTree(abrain) === before, "bind-intent-intermediate-symlink: tree delta");
    console.log("  ok    bind-intent-intermediate-symlink");
  });
}

async function main() {
  if (process.platform !== "linux") {
    console.error("smoke-dcc-production-observer-aggregate: linux_required");
    process.exit(1);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dcc-prod-obs-smoke-"));
  try {
    caseEnvMissing();
    caseAbsoluteInvalid();
    await caseObserverFail(base);
    await caseReady(base);
    await casePending(base);
    await caseFailed(base);
    await caseCorrupt(base);
    await caseAbrainLeafSymlink(base);
    await caseBindIntentIntermediateSymlink(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  if (failures !== 0) {
    console.error("smoke-dcc-production-observer-aggregate result=fail");
    process.exit(1);
  }
  console.log("smoke-dcc-production-observer-aggregate result=ok");
}

main().catch((error) => {
  // Never print fixture paths from error objects.
  console.error("smoke-dcc-production-observer-aggregate result=fail");
  console.error(String(error && error.message ? error.message : "error").slice(0, 200));
  process.exit(1);
});
