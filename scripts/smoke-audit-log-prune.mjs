#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cli = path.join(repoRoot, "scripts", "audit-log-maintenance.mjs");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { appendRotatingJsonlLine, rotateJsonlGeneration } = await jiti.import(
  path.join(repoRoot, "extensions", "_shared", "rotating-jsonl.ts"),
);
const { signAuditMaintenanceHmacStrict } = await jiti.import(
  path.join(repoRoot, "extensions", "_shared", "audit-hmac.ts"),
);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-audit-prune-"));
process.on("exit", () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}

function invoke(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function run(args, status = 0, env = {}) {
  const result = invoke(args, env);
  assert.equal(result.status, status, `status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return JSON.parse((result.stdout || result.stderr).trim());
}

function trackedChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    output: () => ({ stdout, stderr }),
    completion: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
    }),
  };
}

function runAsync(args, env = {}) {
  return trackedChild(spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function rotationLockHolder(lockPath, marker, gate) {
  const code = `
    const fs = require("node:fs");
    const path = require("node:path");
    const lock = ${JSON.stringify(lockPath)};
    const marker = ${JSON.stringify(marker)};
    const gate = ${JSON.stringify(gate)};
    const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: "runtime-holder", created_at: new Date().toISOString() }) + "\\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.writeFileSync(marker, JSON.stringify({ phase: "runtime_rotate_locked", pid: process.pid }) + "\\n", { mode: 0o600 });
    const timer = setInterval(() => {
      if (!fs.existsSync(gate)) return;
      clearInterval(timer);
      fs.unlinkSync(lock);
      process.exit(0);
    }, 10);
    setTimeout(() => { clearInterval(timer); process.exit(2); }, 10000).unref();
  `;
  return trackedChild(spawn(process.execPath, ["-e", code], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }));
}

async function waitForMarker(marker, phase, running) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) {
      const value = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (value.phase === phase) return value;
    }
    if (running.child.exitCode !== null) {
      const output = running.output();
      throw new Error(`child exited before ${phase}: ${output.stdout}\n${output.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${phase}`);
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function immutableTreeSnapshot(root) {
  const rows = [];
  function walk(current) {
    const stat = fs.lstatSync(current);
    const relative = path.relative(root, current) || ".";
    const names = stat.isDirectory() ? fs.readdirSync(current).sort() : null;
    rows.push({
      path: relative,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mode: stat.mode & 0o777,
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      entries: names,
      sha256: stat.isFile() ? createHash("sha256").update(fs.readFileSync(current)).digest("hex") : null,
    });
    if (names) for (const name of names) walk(path.join(current, name));
  }
  walk(root);
  return rows;
}

function archiveNames(sink) {
  const archiveDir = path.join(sink, "archive");
  return fs.readdirSync(archiveDir).filter((name) => name.endsWith(".jsonl")).sort();
}

function archiveByCreatedAt(sink) {
  const archiveDir = path.join(sink, "archive");
  return archiveNames(sink).map((name) => {
    const file = path.join(archiveDir, name);
    const sidecar = JSON.parse(fs.readFileSync(`${file}.generation.json`, "utf8"));
    return { file, sidecar: `${file}.generation.json`, createdAt: sidecar.createdAt };
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function fixture(label, count, options = {}) {
  const project = path.join(tmpRoot, label);
  const sink = path.join(project, ".pi-astack", "llm-audit");
  const active = path.join(sink, "audit.jsonl");
  const ageDays = options.ageDays ?? 60;
  const payloadBytes = options.payloadBytes ?? 128;
  const base = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  const rotation = { enabled: true, maxBytes: 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1000, lockTimeoutMs: 1000 };
  for (let index = 0; index < count; index++) {
    const now = base + index * 1000;
    const append = await appendRotatingJsonlLine(active, JSON.stringify({ index, payload: "x".repeat(payloadBytes) }), {
      sink: "llm-audit",
      rotation,
      now: () => now,
    });
    assert(append.appended);
    const rotated = await rotateJsonlGeneration(active, {
      sink: "llm-audit",
      rotation,
      now: () => now + 500,
    });
    assert(rotated.rotated && rotated.archivePath);
  }
  return { project, sink, active, archiveDir: path.join(sink, "archive") };
}

async function seal(sink) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return run(["seal", "--root", sink, "--stable-ms", "1", "--yes"]);
}

function writePin(sink, archive) {
  const dir = path.join(sink, "incident-pins");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const compact = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const file = path.join(dir, `incident-pin-${compact}-${randomUUID()}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    schema_version: "incident-pin/v1",
    pinned: true,
    sources: [{ kind: "llm_audit_archive", path: archive }],
  })}\n`, { mode: 0o600 });
  return file;
}

function sourceFacts(file) {
  const bytes = fs.readFileSync(file);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    lines: bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (bytes.length > 0 && bytes.at(-1) !== 10 ? 1 : 0),
  };
}

function pinRequestForArchive(archive) {
  return {
    schema_version: "incident-pin-request/v1",
    incident: { incident_id: randomUUID(), occurred_at: new Date().toISOString(), severity: "high", status: "open" },
    sources: [{ source_id: randomUUID(), kind: "llm_audit_archive", path: archive, ...sourceFacts(archive), observed_at: new Date().toISOString() }],
    metrics: [],
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function signJournal(project, journal) {
  const { signature: _discarded, ...unsigned } = journal;
  return {
    ...unsigned,
    signature: signAuditMaintenanceHmacStrict(project, "audit-prune-journal/v1", canonicalJson(unsigned)),
  };
}

function journalNames(sink) {
  const directory = path.join(sink, "maintenance-manifests");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.startsWith("audit-prune-journal-")).sort() : [];
}

async function crashPrune(fixtureValue, phase, label = phase) {
  const marker = path.join(tmpRoot, `ready-${label}-${randomUUID()}.json`);
  const running = runAsync(
    ["prune", "--root", fixtureValue.sink, "--retention-days", "1", "--yes"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_HARD_CRASH_PHASE: phase,
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: marker,
    },
  );
  const readyPhase = ["prepared", "archive_quarantined", "pair_quarantined", "deleted"].includes(phase)
    ? `prune_journal_${phase}`
    : `prune_${phase}`;
  await waitForMarker(marker, readyPhase, running);
  const crashed = await running.completion;
  assert.equal(crashed.signal, "SIGKILL", `${phase}: ${crashed.stdout}\n${crashed.stderr}`);
  return { marker, crashed };
}

console.log("audit log prune smoke");

await check("prune requires the canonical llm-audit sink and enforces hard option ranges", async () => {
  assert.equal(run(["prune"], 1).code, "EXPLICIT_ROOT_REQUIRED");
  const arbitrary = path.join(tmpRoot, "arbitrary");
  fs.mkdirSync(path.join(arbitrary, "archive"), { recursive: true });
  fs.writeFileSync(path.join(arbitrary, "audit.jsonl"), "");
  assert.equal(run(["prune", "--root", arbitrary], 1).code, "PRUNE_ROOT_REJECTED");
  const f = await fixture("range", 2);
  assert.equal(run(["prune", "--root", f.sink, "--keep-latest-generations", "1"], 1).code, "CLI_ARGUMENT_INVALID");
  assert.equal(run(["prune", "--root", f.sink, "--retention-days", "0"], 1).code, "CLI_ARGUMENT_INVALID");
});

await check("three dry-runs are advisory, plan age-eligible archives, and leave the real tree exactly unchanged", async () => {
  const f = await fixture("dry-age", 5);
  await seal(f.sink);
  const before = immutableTreeSnapshot(f.sink);
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = run(["prune", "--root", f.sink, "--retention-days", "1"]);
    assert(result.dry_run && result.automatic_gc === false);
    assert.equal(result.consistency, "advisory_no_lock");
    assert.equal(result.plan_status, "advisory");
    assert.equal(result.advisory_snapshot.changed, false);
    assert.equal(result.advisory_snapshot.pre.digest, result.advisory_snapshot.post.digest);
    assert.deepEqual(result.advisory_snapshot.pre.controls, []);
    assert.deepEqual(result.advisory_snapshot.post.controls, []);
    assert.deepEqual(immutableTreeSnapshot(f.sink), before, `dry-run ${attempt + 1} mutated sink entries, metadata, identity, mode, or bytes`);
  }
  assert.equal(result.planned.length, 3);
  assert(result.planned.every((item) => item.status === "advisory"));
  assert.equal(result.kept.filter((item) => item.reason === "keep_latest_generation").length, 2);
  assert(result.reclaim_bytes > 0);
  assert(result.read_budget.consumed.entries > 0 && result.read_budget.consumed.bytes > 0);
  assert(!fs.existsSync(path.join(f.sink, "maintenance-manifests")));
  assert(!fs.existsSync(path.join(f.sink, ".audit-maintenance.lock")));
  assert(!fs.existsSync(path.join(f.sink, ".audit.jsonl.rotate.lock")));
});

await check("dry-run only reports valid recovery and never renames, unlinks, or rewrites journal state", async () => {
  const f = await fixture("dry-recovery", 3);
  await seal(f.sink);
  await crashPrune(f, "archive_rename_durable", "dry-recovery");
  const journalFile = path.join(f.sink, "maintenance-manifests", journalNames(f.sink)[0]);
  const beforeJournal = fs.readFileSync(journalFile);
  const beforeArchive = fs.readdirSync(f.archiveDir).sort().map((name) => [name, fs.readFileSync(path.join(f.archiveDir, name))]);
  const dry = run(["prune", "--root", f.sink, "--retention-days", "1", "--lock-timeout-ms", "5000"]);
  assert.equal(dry.recovery_required.length, 1);
  assert.equal(dry.recovery_rejected.length, 0);
  assert.deepEqual(fs.readFileSync(journalFile), beforeJournal);
  assert.deepEqual(fs.readdirSync(f.archiveDir).sort().map((name) => [name, fs.readFileSync(path.join(f.archiveDir, name))]), beforeArchive);
  const recovered = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"]);
  assert.equal(recovered.recovered.length, 1);
  assert.equal(archiveNames(f.sink).length, 2);
});

await check("recovery read-budget exhaustion propagates without rewriting journal state", async () => {
  const cases = [
    { label: "entry", expected: "PRUNE_ENTRY_LIMIT", args: ["--read-max-entries", "1"], env: {} },
    { label: "bytes", expected: "PRUNE_HASH_BUDGET_EXCEEDED", args: null, env: {} },
    {
      label: "time",
      expected: "PRUNE_HASH_TIME_BUDGET_EXCEEDED",
      args: ["--hash-time-budget-ms-total", "20"],
      env: { PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_MAINTENANCE_TEST_PRUNE_CHUNK_DELAY_MS: "60" },
    },
  ];
  for (const testCase of cases) {
    const f = await fixture(`recovery-budget-${testCase.label}`, 3);
    await seal(f.sink);
    await crashPrune(f, "prepared", `recovery-budget-${testCase.label}`);
    const journalPath = path.join(f.sink, "maintenance-manifests", journalNames(f.sink)[0]);
    const before = fs.readFileSync(journalPath);
    const args = testCase.args ?? ["--hash-max-bytes-total", String(before.length)];
    const result = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000", ...args], 1, testCase.env);
    assert.equal(result.code, testCase.expected, testCase.label);
    assert.deepEqual(fs.readFileSync(journalPath), before, testCase.label);
    assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).state, "prepared", testCase.label);
  }
});

await check("fake, tampered, and wrong-key journals are rejected in dry-run and --yes without pair mutation", async () => {
  const noKey = await fixture("fake-journal-no-key", 3);
  const noKeyDirectory = path.join(noKey.sink, "maintenance-manifests");
  fs.mkdirSync(noKeyDirectory, { mode: 0o700 });
  const noKeyId = randomUUID();
  writeJson(path.join(noKeyDirectory, `audit-prune-journal-${noKeyId}.json`), {
    schema_version: "audit-prune-deletion-journal/v1",
    journal_id: noKeyId,
    state: "prepared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    canonical_root: noKey.sink,
    archive_directory: noKey.archiveDir,
    reason: "age",
    archive: {},
    sidecar: {},
    archive_deleted: false,
    sidecar_deleted: false,
    raw_content_copied: false,
    signature: { algorithm: "hmac-sha256", key_id: "0".repeat(24), digest: "0".repeat(64) },
  });
  const noKeyDry = run(["prune", "--root", noKey.sink, "--retention-days", "1"]);
  assert.equal(noKeyDry.recovery_rejected.length, 1);
  assert(!fs.existsSync(path.join(noKey.sink, ".audit-hmac-key")), "dry-run created a key while rejecting a fake journal");
  assert.equal(archiveNames(noKey.sink).length, 3);

  const fake = await fixture("fake-journal", 3);
  await seal(fake.sink);
  const fakeDirectory = path.join(fake.sink, "maintenance-manifests");
  fs.mkdirSync(fakeDirectory, { mode: 0o700 });
  const fakeId = randomUUID();
  writeJson(path.join(fakeDirectory, `audit-prune-journal-${fakeId}.json`), { journal_id: fakeId, state: "pair_quarantined", signature: { algorithm: "hmac-sha256", key_id: "0".repeat(24), digest: "0".repeat(64) } });
  const fakeBefore = archiveByCreatedAt(fake.sink).map((item) => [item.file, fs.readFileSync(item.file), item.sidecar, fs.readFileSync(item.sidecar)]);
  const fakeDry = run(["prune", "--root", fake.sink, "--retention-days", "1"]);
  assert.equal(fakeDry.recovery_rejected.length, 1);
  assert.equal(run(["prune", "--root", fake.sink, "--retention-days", "1", "--yes"], 1).code, "PRUNE_RECOVERY_REJECTED");
  for (const [archive, archiveBytes, sidecar, sidecarBytes] of fakeBefore) {
    assert.deepEqual(fs.readFileSync(archive), archiveBytes);
    assert.deepEqual(fs.readFileSync(sidecar), sidecarBytes);
  }

  const tampered = await fixture("tampered-journal", 3);
  await seal(tampered.sink);
  await crashPrune(tampered, "prepared", "tampered-journal");
  const tamperedPath = path.join(tampered.sink, "maintenance-manifests", journalNames(tampered.sink)[0]);
  const tamperedValue = JSON.parse(fs.readFileSync(tamperedPath, "utf8"));
  tamperedValue.reason = "tampered";
  writeJson(tamperedPath, tamperedValue);
  assert.equal(run(["prune", "--root", tampered.sink, "--retention-days", "1", "--lock-timeout-ms", "5000"]).recovery_rejected.length, 1);
  assert.equal(run(["prune", "--root", tampered.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"], 1).code, "PRUNE_RECOVERY_REJECTED");
  assert.equal(archiveNames(tampered.sink).length, 3);

  const wrongKey = await fixture("wrong-key-journal", 3);
  await seal(wrongKey.sink);
  await crashPrune(wrongKey, "prepared", "wrong-key-journal");
  fs.writeFileSync(path.join(wrongKey.sink, ".audit-hmac-key"), randomBytes(32), { mode: 0o600 });
  assert.equal(run(["prune", "--root", wrongKey.sink, "--retention-days", "1", "--lock-timeout-ms", "5000"]).recovery_rejected.length, 1);
  assert.equal(run(["prune", "--root", wrongKey.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"], 1).code, "PRUNE_RECOVERY_REJECTED");
  assert.equal(archiveNames(wrongKey.sink).length, 3);
});

await check("signed filename, id, pair path, sidecar, and quarantine deviations are rejected", async () => {
  const mutations = [
    ["filename-id", (journal) => { journal.journal_id = randomUUID(); }],
    ["archive-path", (journal) => { journal.archive.logical_path = path.join(journal.canonical_root, "archive", "..", "escape.jsonl"); }],
    ["archive-basename", (journal) => { journal.archive.basename = "../escape.jsonl"; }],
    ["sidecar-pair", (journal) => { journal.sidecar.basename = `${journal.archive.basename}.other.json`; }],
    ["quarantine", (journal) => { journal.archive.quarantine_basename = `.audit-prune-quarantine-${journal.journal_id}-archive-arbitrary`; }],
  ];
  for (const [label, mutate] of mutations) {
    const f = await fixture(`journal-${label}`, 3);
    await seal(f.sink);
    await crashPrune(f, "prepared", `journal-${label}`);
    const basename = journalNames(f.sink)[0];
    const journalPath = path.join(f.sink, "maintenance-manifests", basename);
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    mutate(journal);
    writeJson(journalPath, signJournal(f.project, journal));
    const dry = run(["prune", "--root", f.sink, "--retention-days", "1", "--lock-timeout-ms", "5000"]);
    assert.equal(dry.recovery_rejected.length, 1, label);
    assert.equal(run(["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"], 1).code, "PRUNE_RECOVERY_REJECTED", label);
    assert.equal(archiveNames(f.sink).length, 3, label);
  }
});

await check("--yes deletes exact archive+sidecar pairs and writes a private deletion manifest", async () => {
  const f = await fixture("execute-age", 5);
  const evidence = path.join(f.sink, "incident-evidence", `incident-evidence-${randomUUID()}.json`);
  const reasoning = path.join(f.sink, "dispatch-reasoning", `trace-1720660000000-1-${randomUUID()}.jsonl`);
  fs.mkdirSync(path.dirname(evidence), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(reasoning), { recursive: true, mode: 0o700 });
  fs.writeFileSync(evidence, "{\"protected\":true}\n", { mode: 0o600 });
  fs.writeFileSync(reasoning, "{\"protected\":true}\n", { mode: 0o600 });
  const sealed = await seal(f.sink);
  const sealPaths = sealed.roots.map((root) => root.manifest_path);
  const result = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes"]);
  assert.equal(result.deleted_files, 3);
  assert.equal(archiveNames(f.sink).length, 2);
  assert(fs.existsSync(f.active), "active audit was deleted");
  for (const file of sealPaths) assert(fs.existsSync(file), "seal manifest was deleted");
  assert(fs.existsSync(evidence), "incident evidence was deleted");
  assert(fs.existsSync(reasoning), "reasoning trace was deleted");
  assert.equal(mode(path.dirname(result.deletion_manifest_path)), 0o700);
  assert.equal(mode(result.deletion_manifest_path), 0o600);
  const manifest = JSON.parse(fs.readFileSync(result.deletion_manifest_path, "utf8"));
  assert.equal(manifest.schema_version, "audit-prune-deletion-journal/v1");
  assert.equal(manifest.state, "deleted");
  assert(manifest.archive.sha256 && manifest.archive.identity?.ino && manifest.archive.bytes >= 0);
  assert(manifest.sidecar.sha256 && manifest.sidecar.identity?.ino && manifest.sidecar.bytes >= 0);
  assert.equal(manifest.archive_deleted, true);
  assert.equal(manifest.sidecar_deleted, true);
  assert.equal(manifest.raw_content_copied, false);
  assert.equal(manifest.signature.algorithm, "hmac-sha256");
  assert.match(manifest.signature.key_id, /^[0-9a-f]{24}$/);
  assert.match(manifest.signature.digest, /^[0-9a-f]{64}$/);
  assert.equal(result.deletion_journal_paths.length, 3);
});

await check("helper-generated legacy archives and arbitrary JSONL are excluded", async () => {
  const f = await fixture("legacy-excluded", 2);
  const rotation = { enabled: true, maxBytes: 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1000, lockTimeoutMs: 1000 };
  const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
  await appendRotatingJsonlLine(f.active, JSON.stringify({ legacy: true }), { sink: "llm-audit", rotation, now: () => old });
  const legacy = await rotateJsonlGeneration(f.active, { sink: "llm-audit", rotation, archiveTag: "legacy-pre-shape", now: () => old + 100 });
  assert(legacy.rotated && legacy.archivePath);
  const arbitrary = path.join(f.archiveDir, "operator-copy.jsonl");
  fs.writeFileSync(arbitrary, "{\"keep\":true}\n", { mode: 0o600 });
  await seal(f.sink);
  const result = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes"]);
  assert(result.rejected.some((item) => item.path === legacy.archivePath && item.reason === "legacy_archive_excluded"));
  assert(result.rejected.some((item) => item.path === arbitrary && item.reason === "not_current_helper_archive"));
  assert(fs.existsSync(legacy.archivePath));
  assert(fs.existsSync(`${legacy.archivePath}.generation.json`));
  assert(fs.existsSync(arbitrary));
});

await check("unsealed archives are rejected and no-op --yes creates no files", async () => {
  const f = await fixture("unsealed", 4);
  const result = run(["prune", "--root", f.sink, "--retention-days", "1"]);
  assert.equal(result.planned.length, 0);
  assert(result.rejected.some((item) => item.reason === "snapshot_verified_seal_required"));
  const before = fs.readdirSync(f.sink, { recursive: true }).map(String).sort();
  const executed = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes"]);
  assert.equal(executed.deleted_files, 0);
  assert.equal(executed.recovered.length, 0);
  assert.equal(archiveNames(f.sink).length, 4);
  assert.deepEqual(fs.readdirSync(f.sink, { recursive: true }).map(String).sort(), before);
  assert(!fs.existsSync(path.join(f.sink, "maintenance-manifests")));
});

await check("unsigned, tampered, and wrong-key seal manifests cannot authorize deletion", async () => {
  const unsigned = await fixture("fake-seal", 3);
  const oldestUnsigned = archiveByCreatedAt(unsigned.sink)[0];
  const fakeName = `archive-seal-manifest-${new Date().toISOString().replace(/[-:]/g, "").replace(".", "")}-${randomUUID()}.json`;
  writeJson(path.join(unsigned.archiveDir, fakeName), {
    schema_version: "audit-seal-manifest/v2",
    canonical_root: unsigned.sink,
    archive_directory: unsigned.archiveDir,
    entries: [{ path: oldestUnsigned.file, status: "snapshot_verified", sha256: createHash("sha256").update(fs.readFileSync(oldestUnsigned.file)).digest("hex") }],
  });
  const fakeResult = run(["prune", "--root", unsigned.sink, "--retention-days", "1"]);
  assert.equal(fakeResult.planned.length, 0);
  assert(fakeResult.rejected.some((item) => item.reason === "seal_manifest_rejected"));

  const tampered = await fixture("tampered-seal", 3);
  const sealed = await seal(tampered.sink);
  const sealPath = sealed.roots[0].manifest_path;
  const parsed = JSON.parse(fs.readFileSync(sealPath, "utf8"));
  parsed.entries.find((entry) => entry.status === "snapshot_verified").lines += 1;
  writeJson(sealPath, parsed);
  const tamperedResult = run(["prune", "--root", tampered.sink, "--retention-days", "1"]);
  assert.equal(tamperedResult.planned.length, 0);
  assert(tamperedResult.rejected.some((item) => item.path === sealPath && item.reason === "seal_manifest_rejected"));

  const wrongKey = await fixture("wrong-key-seal", 3);
  await seal(wrongKey.sink);
  fs.writeFileSync(path.join(wrongKey.sink, ".audit-hmac-key"), randomBytes(32), { mode: 0o600 });
  const wrongKeyResult = run(["prune", "--root", wrongKey.sink, "--retention-days", "1"]);
  assert.equal(wrongKeyResult.planned.length, 0);
  assert(wrongKeyResult.rejected.some((item) => item.reason === "seal_manifest_rejected"));
});

await check("seal timestamp mismatch is untrusted and malformed sidecars remain capacity-accounted", async () => {
  const timestamp = await fixture("timestamp-seal", 3);
  await seal(timestamp.sink);
  const oldest = archiveByCreatedAt(timestamp.sink)[0];
  const current = fs.statSync(oldest.file);
  fs.utimesSync(oldest.file, current.atime, new Date(current.mtimeMs + 1000));
  const timestampResult = run(["prune", "--root", timestamp.sink, "--retention-days", "1"]);
  assert(!timestampResult.planned.some((item) => item.path === oldest.file));
  assert(timestampResult.rejected.some((item) => item.path === oldest.file && item.reason === "snapshot_verified_seal_required"));

  const malformed = await fixture("accounted-unprunable", 3);
  await seal(malformed.sink);
  const bad = archiveByCreatedAt(malformed.sink)[0];
  fs.writeFileSync(bad.sidecar, "{bad-json\n", { mode: 0o600 });
  const expectedBytes = archiveNames(malformed.sink).reduce((sum, name) => sum + fs.lstatSync(path.join(malformed.archiveDir, name)).size, 0);
  const result = run(["prune", "--root", malformed.sink, "--retention-days", "1"]);
  assert.equal(result.archive_bytes, expectedBytes);
  assert(result.rejected.some((item) => item.path === bad.file && item.accounted_unprunable === true && item.bytes === fs.statSync(bad.file).size));
});

await check("prune hash budgets fail closed in dry-run and enforce 16 GiB hard ceilings", async () => {
  const f = await fixture("hash-budget", 3);
  await seal(f.sink);
  assert.equal(run(["prune", "--root", f.sink, "--hash-max-bytes-total", "1"], 1).code, "PRUNE_HASH_BUDGET_EXCEEDED");
  assert.equal(run(["prune", "--root", f.sink, "--hash-max-bytes-per-file", String(16 * 1024 * 1024 * 1024 + 1)], 1).code, "CLI_ARGUMENT_INVALID");
  assert.equal(run(["prune", "--root", f.sink, "--max-archive-bytes", String(16 * 1024 * 1024 * 1024 + 1)], 1).code, "CLI_ARGUMENT_INVALID");
});

await check("unified read budget stops manifest floods and reports actual bounded growth consumption", async () => {
  const flood = await fixture("manifest-flood", 3);
  await seal(flood.sink);
  for (let index = 0; index < 8; index++) writePin(flood.sink, archiveByCreatedAt(flood.sink)[0].file);
  assert.equal(run(["prune", "--root", flood.sink, "--read-max-entries", "2"], 1).code, "PRUNE_ENTRY_LIMIT");

  const growing = await fixture("growing-budget", 3, { payloadBytes: 4 * 1024 * 1024 });
  await seal(growing.sink);
  const maxExpectedRead = fs.readdirSync(growing.archiveDir).reduce((sum, name) => {
    const stat = fs.lstatSync(path.join(growing.archiveDir, name));
    return sum + (stat.isFile() ? stat.size : 0);
  }, 0);
  const marker = path.join(tmpRoot, `ready-growing-budget-${randomUUID()}.json`);
  const running = runAsync(
    ["prune", "--root", growing.sink, "--retention-days", "1", "--hash-max-bytes-total", String(64 * 1024 * 1024)],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_PRUNE_CHUNK_DELAY_MS: "60",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: marker,
    },
  );
  const ready = await waitForMarker(marker, "prune_hash_started", running);
  const initialSize = fs.statSync(ready.path).size;
  fs.appendFileSync(ready.path, Buffer.alloc(8 * 1024 * 1024, 0x78));
  const completed = await running.completion;
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  const result = JSON.parse(completed.stdout);
  assert(result.rejected.some((item) => item.path === ready.path));
  assert(result.read_budget.consumed.bytes <= maxExpectedRead, `growth exceeded initial read envelope: initial_file=${initialSize}`);
  assert(result.read_budget.consumed.bytes <= result.read_budget.limits.bytes);
});

await check("incident pin references exempt archives from age and capacity pruning", async () => {
  const f = await fixture("pinned", 4);
  await seal(f.sink);
  const oldest = archiveByCreatedAt(f.sink)[0];
  const pin = writePin(f.sink, oldest.file);
  const result = run(["prune", "--root", f.sink, "--retention-days", "1", "--max-archive-bytes", "1"]);
  assert(result.pinned.some((item) => item.path === oldest.file));
  assert(!result.planned.some((item) => item.path === oldest.file));
  assert(fs.existsSync(pin));
});

await check("archive and sidecar symlinks are rejected without touching external targets", async () => {
  for (const target of ["archive", "sidecar"]) {
    const f = await fixture(`symlink-${target}`, 3);
    await seal(f.sink);
    const oldest = archiveByCreatedAt(f.sink)[0];
    const selected = target === "archive" ? oldest.file : oldest.sidecar;
    const external = path.join(tmpRoot, `external-${target}.txt`);
    fs.writeFileSync(external, "external-keep\n", { mode: 0o644 });
    fs.rmSync(selected);
    fs.symlinkSync(external, selected);
    const result = run(["prune", "--root", f.sink, "--retention-days", "1"]);
    assert.equal(result.planned.length, 0);
    assert(result.rejected.some((item) => item.path === oldest.file));
    assert.equal(fs.readFileSync(external, "utf8"), "external-keep\n");
  }
});

await check("dry-run only detects existing maintenance/rotate/transaction controls while --yes fails closed", async () => {
  for (const marker of [".audit-maintenance.lock", ".audit.jsonl.rotation-transaction.json", ".audit.jsonl.rotate.lock"]) {
    const f = await fixture(`hot-${marker.replace(/\W/g, "-")}`, 2);
    const control = path.join(f.sink, marker);
    fs.writeFileSync(control, "{}\n", { mode: 0o600 });
    const before = immutableTreeSnapshot(f.sink);
    const dry = run(["prune", "--root", f.sink]);
    assert.equal(dry.consistency, "advisory_no_lock");
    assert.equal(dry.plan_status, "stale");
    assert(dry.advisory_snapshot.warnings.some((warning) => warning.path === control && warning.affects_plan));
    assert.deepEqual(immutableTreeSnapshot(f.sink), before);
    const expectedExecuteCode = marker === ".audit-maintenance.lock" ? "MAINTENANCE_LOCK_TIMEOUT" : "PRUNE_HOT_SINK";
    assert.equal(run(["prune", "--root", f.sink, "--yes", "--lock-timeout-ms", "1"], 1).code, expectedExecuteCode);
  }
});

await check("capacity pruning is oldest-first and obeys file and byte batch caps", async () => {
  const f = await fixture("capacity", 6, { ageDays: 1, payloadBytes: 512 });
  await seal(f.sink);
  const ordered = archiveByCreatedAt(f.sink);
  const byteBlocked = run([
    "prune", "--root", f.sink, "--retention-days", "3650", "--max-archive-bytes", "1",
    "--batch-max-bytes", "1", "--batch-max-files", "16",
  ]);
  assert.equal(byteBlocked.planned.length, 0);
  assert(byteBlocked.kept.some((item) => item.reason === "batch_limit"));
  const fileBound = run([
    "prune", "--root", f.sink, "--retention-days", "3650", "--max-archive-bytes", "1",
    "--batch-max-bytes", String(1024 * 1024), "--batch-max-files", "2",
  ]);
  assert.equal(fileBound.planned.length, 2);
  assert.deepEqual(fileBound.planned.map((item) => item.path), ordered.slice(0, 2).map((item) => item.file));
  assert(fileBound.planned.every((item) => item.reason.includes("capacity")));
  assert.equal(fileBound.kept.filter((item) => item.reason === "keep_latest_generation").length, 2);
});

await check("partial-pair source/quarantine collision blocks without deleting either object", async () => {
  const f = await fixture("partial-pair-collision", 3);
  await seal(f.sink);
  await crashPrune(f, "archive_rename_durable", "partial-pair-collision");
  const journalPath = path.join(f.sink, "maintenance-manifests", journalNames(f.sink)[0]);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  fs.writeFileSync(journal.archive.logical_path, "replacement-must-remain\n", { mode: 0o600 });
  const dry = run(["prune", "--root", f.sink, "--retention-days", "1", "--lock-timeout-ms", "5000"]);
  assert.equal(dry.recovery_required.length, 1);
  const blocked = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"], 1);
  assert.equal(blocked.code, "PRUNE_RECOVERY_BLOCKED");
  assert.equal(fs.readFileSync(journal.archive.logical_path, "utf8"), "replacement-must-remain\n");
  assert(fs.existsSync(path.join(f.archiveDir, journal.archive.quarantine_basename)));
  assert(fs.existsSync(journal.sidecar.logical_path));
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).state, "blocked");
});

await check("cross-journal pair collisions fail closed before recovery mutation", async () => {
  const f = await fixture("cross-journal-collision", 3);
  await seal(f.sink);
  await crashPrune(f, "prepared", "cross-journal-collision");
  const originalBasename = journalNames(f.sink)[0];
  const originalPath = path.join(f.sink, "maintenance-manifests", originalBasename);
  const original = JSON.parse(fs.readFileSync(originalPath, "utf8"));
  const duplicate = structuredClone(original);
  const oldId = duplicate.journal_id;
  duplicate.journal_id = randomUUID();
  duplicate.archive.quarantine_basename = duplicate.archive.quarantine_basename.replace(oldId, duplicate.journal_id);
  duplicate.sidecar.quarantine_basename = duplicate.sidecar.quarantine_basename.replace(oldId, duplicate.journal_id);
  const duplicateBasename = `audit-prune-journal-${duplicate.journal_id}.json`;
  writeJson(path.join(f.sink, "maintenance-manifests", duplicateBasename), signJournal(f.project, duplicate));
  const dry = run(["prune", "--root", f.sink, "--retention-days", "1", "--lock-timeout-ms", "5000"]);
  assert.equal(dry.recovery_rejected.filter((entry) => entry.reason === "cross_journal_pair_collision").length, 2);
  assert.equal(run(["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"], 1).code, "PRUNE_RECOVERY_REJECTED");
  assert.equal(archiveNames(f.sink).length, 3);
  assert.equal(fs.readdirSync(f.archiveDir).filter((name) => name.startsWith(".audit-prune-quarantine-")).length, 0);
});

await check("manifest creation and journal/archive mutations expose ordered fsync phases under the total test gate", async () => {
  const f = await fixture("fsync-order", 3);
  await seal(f.sink);
  const trace = path.join(tmpRoot, `fsync-trace-${randomUUID()}.jsonl`);
  run(
    ["prune", "--root", f.sink, "--retention-days", "1", "--yes"],
    0,
    { PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_MAINTENANCE_TEST_FSYNC_TRACE: trace },
  );
  const phases = fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line).phase);
  const ordered = [
    "manifest_parent_after_mkdir", "manifest_directory_after_open", "journal_file", "journal_parent",
    "archive_rename_file", "archive_rename_rename", "archive_rename_parent",
    "journal_replacement_file", "journal_replace", "archive_unlink_file", "archive_unlink_unlink", "archive_unlink_parent",
  ];
  let prior = -1;
  for (const phase of ordered) {
    const index = phases.indexOf(phase, prior + 1);
    assert(index > prior, `missing or out-of-order fsync phase ${phase}: ${phases.join(",")}`);
    prior = index;
  }
});

await check("SIGKILL at every durable prune micro/state phase recovers and repeat runs are idempotent", async () => {
  const phases = [
    "prepared", "archive_rename_durable", "archive_quarantined", "sidecar_rename_durable",
    "pair_quarantined", "archive_unlink_durable", "sidecar_unlink_durable", "deleted",
  ];
  for (const phase of phases) {
    const f = await fixture(`crash-${phase}`, 3);
    await seal(f.sink);
    await crashPrune(f, phase, `crash-${phase}`);
    const recovered = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"]);
    assert.equal(archiveNames(f.sink).length, 2, `${phase}: recovery did not finish deletion`);
    assert.equal(recovered.ok, true);
    const journals = fs.readdirSync(path.join(f.sink, "maintenance-manifests")).filter((name) => name.startsWith("audit-prune-journal-"));
    assert(journals.every((name) => JSON.parse(fs.readFileSync(path.join(f.sink, "maintenance-manifests", name), "utf8")).state === "deleted"), `${phase}: nonterminal journal remains`);
    assert.equal(fs.readdirSync(f.archiveDir).filter((name) => name.startsWith(".audit-prune-quarantine-")).length, 0, `${phase}: quarantine remains`);
    const repeated = run(["prune", "--root", f.sink, "--retention-days", "1", "--yes"]);
    assert.equal(repeated.deleted_files, 0, `${phase}: repeat run was not idempotent`);
  }
});

await check("pin blocks behind maintenance lock and cannot succeed after prune deletes its source", async () => {
  const f = await fixture("pin-race", 3);
  await seal(f.sink);
  const oldest = archiveByCreatedAt(f.sink)[0].file;
  const pruneMarker = path.join(tmpRoot, `ready-pin-race-prune-${randomUUID()}.json`);
  const pruneGate = path.join(tmpRoot, `gate-pin-race-prune-${randomUUID()}`);
  const pruning = runAsync(
    ["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: pruneMarker,
      PI_ASTACK_MAINTENANCE_TEST_GATE: pruneGate,
      PI_ASTACK_MAINTENANCE_TEST_GATE_PHASE: "prune_delete_ready",
    },
  );
  await waitForMarker(pruneMarker, "prune_delete_ready", pruning);

  const requestPath = path.join(tmpRoot, `pin-race-request-${randomUUID()}.json`);
  writeJson(requestPath, pinRequestForArchive(oldest));
  const pinMarker = path.join(tmpRoot, `ready-pin-race-pin-${randomUUID()}.json`);
  const pinning = runAsync(
    ["pin", "--input-manifest", requestPath, "--output-dir", path.join(f.sink, "incident-pins"), "--yes", "--lock-timeout-ms", "5000"],
    { PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: pinMarker },
  );
  await waitForMarker(pinMarker, "pin_maintenance_waiting", pinning);
  assert.equal(pinning.child.exitCode, null, "pin did not block behind prune maintenance lock");
  fs.writeFileSync(pruneGate, "release\n", { mode: 0o600 });
  const pruned = await pruning.completion;
  assert.equal(pruned.status, 0, `${pruned.stdout}\n${pruned.stderr}`);
  const pinned = await pinning.completion;
  assert.equal(pinned.status, 1, `${pinned.stdout}\n${pinned.stderr}`);
  assert(["PATH_REJECTED", "PIN_SOURCE_CHANGED", "PIN_SOURCE_MISMATCH"].includes(JSON.parse(pinned.stderr.trim()).code));
  const pinDir = path.join(f.sink, "incident-pins");
  assert(!fs.existsSync(pinDir) || fs.readdirSync(pinDir).length === 0, "pin succeeded after its source was pruned");
});

await check("executing prune waits for a live runtime rotate lock then proceeds under fixed lock order", async () => {
  const f = await fixture("rotate-lock-race", 3);
  await seal(f.sink);
  const holderMarker = path.join(tmpRoot, `ready-runtime-lock-${randomUUID()}.json`);
  const holderGate = path.join(tmpRoot, `gate-runtime-lock-${randomUUID()}`);
  const holder = rotationLockHolder(path.join(f.sink, ".audit.jsonl.rotate.lock"), holderMarker, holderGate);
  await waitForMarker(holderMarker, "runtime_rotate_locked", holder);
  const pruneMarker = path.join(tmpRoot, `ready-prune-lock-${randomUUID()}.json`);
  const pruning = runAsync(
    ["prune", "--root", f.sink, "--retention-days", "1", "--yes", "--lock-timeout-ms", "5000"],
    { PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: pruneMarker },
  );
  await waitForMarker(pruneMarker, "prune_maintenance_locked", pruning);
  assert.equal(pruning.child.exitCode, null, "prune did not wait for runtime rotate lock");
  fs.writeFileSync(holderGate, "release\n", { mode: 0o600 });
  const held = await holder.completion;
  assert.equal(held.status, 0, held.stderr);
  const result = await pruning.completion;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert(JSON.parse(result.stdout).deleted_files === 1);
});

await check("concurrent active append is warned but does not stale the advisory archive plan", async () => {
  const f = await fixture("advisory-active-append", 3);
  await seal(f.sink);
  const marker = path.join(tmpRoot, `ready-advisory-active-${randomUUID()}.json`);
  const gate = path.join(tmpRoot, `gate-advisory-active-${randomUUID()}`);
  const running = runAsync(
    ["prune", "--root", f.sink, "--retention-days", "1"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: marker,
      PI_ASTACK_MAINTENANCE_TEST_GATE: gate,
      PI_ASTACK_MAINTENANCE_TEST_GATE_PHASE: "prune_advisory_scanned",
    },
  );
  await waitForMarker(marker, "prune_advisory_scanned", running);
  fs.appendFileSync(f.active, "concurrent-active-append\n");
  fs.writeFileSync(gate, "release\n", { mode: 0o600 });
  const completed = await running.completion;
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.plan_status, "advisory");
  assert.equal(result.advisory_snapshot.changed, true);
  assert.equal(result.advisory_snapshot.unsafe_changed, false);
  assert(result.planned.length > 0 && result.planned.every((item) => item.status === "advisory"));
  assert(result.advisory_snapshot.warnings.some((warning) => warning.path === f.active && warning.reason === "active_append_observed" && warning.affects_plan === false));
  assert(!fs.existsSync(path.join(f.sink, ".audit-maintenance.lock")));
  assert(!fs.existsSync(path.join(f.sink, ".audit.jsonl.rotate.lock")));
});

await check("dry-run identity change during the advisory scan marks every candidate stale and rejected without retry or write", async () => {
  const f = await fixture("advisory-identity-change", 3);
  await seal(f.sink);
  const oldest = archiveByCreatedAt(f.sink)[0];
  const marker = path.join(tmpRoot, `ready-advisory-change-${randomUUID()}.json`);
  const gate = path.join(tmpRoot, `gate-advisory-change-${randomUUID()}`);
  const running = runAsync(
    ["prune", "--root", f.sink, "--retention-days", "1"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: marker,
      PI_ASTACK_MAINTENANCE_TEST_GATE: gate,
      PI_ASTACK_MAINTENANCE_TEST_GATE_PHASE: "prune_advisory_scanned",
    },
  );
  await waitForMarker(marker, "prune_advisory_scanned", running);
  fs.appendFileSync(oldest.file, "concurrent-archive-change\n");
  const changedBytes = fs.readFileSync(oldest.file);
  fs.writeFileSync(gate, "release\n", { mode: 0o600 });
  const completed = await running.completion;
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.consistency, "advisory_no_lock");
  assert.equal(result.plan_status, "stale");
  assert.equal(result.reclaim_bytes, 0);
  assert(result.planned.length > 0 && result.planned.every((item) => item.status === "stale"));
  assert(result.rejected.some((item) => item.path === oldest.file && item.reason === "advisory_snapshot_changed" && item.status === "rejected"));
  assert(result.advisory_snapshot.warnings.some((warning) => warning.path === oldest.file && warning.reason === "identity_or_entries_changed" && warning.affects_plan));
  assert.deepEqual(fs.readFileSync(oldest.file), changedBytes, "dry-run retried or rewrote the changed archive");
  assert(!fs.existsSync(path.join(f.sink, ".audit-maintenance.lock")));
  assert(!fs.existsSync(path.join(f.sink, ".audit.jsonl.rotate.lock")));
});

await check("identity/hash mutation between preflights aborts before any unlink", async () => {
  const f = await fixture("toctou-preflight", 3);
  await seal(f.sink);
  const oldest = archiveByCreatedAt(f.sink)[0];
  const marker = path.join(tmpRoot, `ready-preflight-${randomUUID()}.json`);
  const gate = path.join(tmpRoot, `gate-preflight-${randomUUID()}`);
  const running = runAsync(
    ["prune", "--root", f.sink, "--retention-days", "1", "--yes"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: marker,
      PI_ASTACK_MAINTENANCE_TEST_GATE: gate,
      PI_ASTACK_MAINTENANCE_TEST_GATE_PHASE: "prune_initial_preflight",
    },
  );
  await waitForMarker(marker, "prune_initial_preflight", running);
  fs.appendFileSync(oldest.file, "changed-between-preflights\n");
  fs.writeFileSync(gate, "release\n", { mode: 0o600 });
  const result = await running.completion;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(JSON.parse((result.stderr || result.stdout).trim()).code, "PRUNE_PREFLIGHT_CHANGED");
  assert.equal(archiveNames(f.sink).length, 3);
});

await check("replacement after delete-ready preflight is detected and replacement is not unlinked", async () => {
  const f = await fixture("toctou-delete", 3);
  await seal(f.sink);
  const oldest = archiveByCreatedAt(f.sink)[0];
  const moved = `${oldest.file}.moved`;
  const marker = path.join(tmpRoot, `ready-delete-${randomUUID()}.json`);
  const gate = path.join(tmpRoot, `gate-delete-${randomUUID()}`);
  const running = runAsync(
    ["prune", "--root", f.sink, "--retention-days", "1", "--yes"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: marker,
      PI_ASTACK_MAINTENANCE_TEST_GATE: gate,
      PI_ASTACK_MAINTENANCE_TEST_GATE_PHASE: "prune_delete_ready",
    },
  );
  await waitForMarker(marker, "prune_delete_ready", running);
  fs.renameSync(oldest.file, moved);
  fs.writeFileSync(oldest.file, "replacement-must-survive\n", { mode: 0o600 });
  fs.writeFileSync(gate, "release\n", { mode: 0o600 });
  const result = await running.completion;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(JSON.parse((result.stderr || result.stdout).trim()).code, "PRUNE_RECOVERY_BLOCKED");
  assert.equal(fs.readFileSync(oldest.file, "utf8"), "replacement-must-survive\n", "replacement was renamed or unlinked");
  const quarantines = fs.readdirSync(f.archiveDir).filter((name) => name.startsWith(".audit-prune-quarantine-"));
  assert.equal(quarantines.length, 0, "replacement was accepted into a trusted quarantine pair");
  assert(fs.existsSync(moved));
  const journals = fs.readdirSync(path.join(f.sink, "maintenance-manifests")).filter((name) => name.startsWith("audit-prune-journal-"));
  assert(journals.some((name) => JSON.parse(fs.readFileSync(path.join(f.sink, "maintenance-manifests", name), "utf8")).state === "blocked"));
});

if (failed > 0) {
  console.log(`\nFAIL - ${failed} check(s) failed; ${passed} passed.`);
  process.exit(1);
}
console.log(`\nPASS - ${passed} audit prune check(s) passed.`);
