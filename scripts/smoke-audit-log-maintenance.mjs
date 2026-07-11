#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cli = path.join(repoRoot, "scripts/audit-log-maintenance.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-audit-maintenance-"));
const sessionFixtureDir = path.join("/home/worker/.pi/agent/sessions", `--pi-astack-maintenance-smoke-${randomUUID()}--`);
fs.mkdirSync(sessionFixtureDir, { recursive: true, mode: 0o700 });
process.on("exit", () => {
  try { fs.rmSync(sessionFixtureDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}

function invoke(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function run(args, expectedStatus = 0, options = {}) {
  const result = invoke(args, options);
  assert.equal(result.status, expectedStatus, `status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  const text = result.stdout.trim() || result.stderr.trim();
  assert(text, "CLI returned no JSON");
  return JSON.parse(text);
}

function runAsync(args, env = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, completion, output: () => ({ stdout, stderr }) };
}

const pollBuffer = new Int32Array(new SharedArrayBuffer(4));

function pollDelaySync(ms = 5) {
  Atomics.wait(pollBuffer, 0, 0, ms);
}

function markerPath(label) {
  return path.join(tmpRoot, `ready-${label}-${randomUUID()}.json`);
}

async function waitForReadyMarker(marker, expectedPhase, running, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = "missing";
  while (Date.now() <= deadline) {
    if (fs.existsSync(marker)) {
      try {
        const ready = JSON.parse(fs.readFileSync(marker, "utf8"));
        observed = JSON.stringify(ready);
        if (ready.phase === expectedPhase) return ready;
      } catch (error) {
        observed = `unreadable: ${error.message}`;
      }
    }
    if (running.child.exitCode !== null) {
      const output = running.output();
      throw new Error(`child exited ${running.child.exitCode} before ${expectedPhase}; marker=${observed}\nstdout=${output.stdout}\nstderr=${output.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const output = running.output();
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${expectedPhase}; marker=${marker}; observed=${observed}; child_exit=${running.child.exitCode}\nstdout=${output.stdout}\nstderr=${output.stderr}`);
}

async function waitForStableWindow(file, stableMs, timeoutMs = stableMs + 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    last = fs.statSync(file);
    if (Date.now() - Math.max(last.mtimeMs, last.ctimeMs) >= stableMs) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, stableMs))));
  }
  throw new Error(`timed out waiting for stable window: path=${file} stable_ms=${stableMs} mtime_ms=${last?.mtimeMs} ctime_ms=${last?.ctimeMs}`);
}

function waitForStableWindowSync(file, stableMs, timeoutMs = stableMs + 1_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    last = fs.statSync(file);
    if (Date.now() - Math.max(last.mtimeMs, last.ctimeMs) >= stableMs) return;
    pollDelaySync();
  }
  throw new Error(`timed out waiting for stable window: path=${file} stable_ms=${stableMs} mtime_ms=${last?.mtimeMs} ctime_ms=${last?.ctimeMs}`);
}

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceFacts(file) {
  const bytes = fs.readFileSync(file);
  const newlineCount = bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    lines: newlineCount + (bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? 1 : 0),
  };
}

function treeSnapshot(root) {
  const out = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    const stat = fs.lstatSync(current);
    const rel = path.relative(root, current) || ".";
    out.push({ rel, type: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other", bytes: stat.size, hash: stat.isFile() ? hashFile(current) : null });
    if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name));
  }
  walk(root);
  return out;
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function makeLegacyRoot(label) {
  const root = path.join(tmpRoot, label);
  const active = path.join(root, ".pi-astack", "llm-audit", "audit.jsonl");
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, `${JSON.stringify({ id: label })}\n`, { mode: 0o600 });
  return { root, active, sink: path.dirname(active), archiveDir: path.join(path.dirname(active), "archive") };
}

function archiveSourcePath(label = "source") {
  return path.join(
    tmpRoot,
    "pin-project",
    ".pi-astack",
    "llm-audit",
    "archive",
    `llm-audit__first-20260711T000000000Z__observed-last-pre-rotate-20260711T000001000Z__rotated-20260711T000002000Z__pid-1__seq-${label}.jsonl`,
  );
}

function sourceRecord(kind, file, sourceId = "22222222-2222-4222-8222-222222222222") {
  return {
    source_id: sourceId,
    kind,
    path: file,
    ...sourceFacts(file),
    observed_at: "2026-07-11T00:01:00.000Z",
  };
}

function validPinRequest(overrides = {}) {
  const archive = archiveSourcePath();
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  if (!fs.existsSync(archive)) fs.writeFileSync(archive, "{\"event\":1}\n", { mode: 0o600 });
  return {
    schema_version: "incident-pin-request/v1",
    incident: {
      incident_id: "11111111-1111-4111-8111-111111111111",
      occurred_at: "2026-07-11T00:00:00.000Z",
      severity: "high",
      status: "open",
    },
    sources: [sourceRecord("llm_audit_archive", archive)],
    metrics: [{ metric: "affected_rows", value: 5, unit: "rows" }],
    ...overrides,
  };
}

function validEvidenceManifest(overrides = {}) {
  return {
    schema_version: "incident-evidence/v1",
    incident: { incident_id: "11111111-1111-4111-8111-111111111111", severity: "high", status: "open" },
    session: { session_id: "33333333-3333-7333-8333-333333333333", turn_id: 2, subturn: 6 },
    tool_call_id: "call_deepseek_01",
    model: "deepseek/deepseek-v4-pro",
    status: "succeeded",
    metrics: [
      { metric: "output_chars", value: 40, unit: "characters" },
      { metric: "max_output_tokens", value: 128000, unit: "tokens" },
      { metric: "detector_rounds", value: 2, unit: "cycles" },
      { metric: "thinking_delta_events", value: 4, unit: "events" },
      { metric: "reasoning_lines", value: 4, unit: "lines" },
    ],
    hashes: [
      { source_id: "44444444-4444-4444-8444-444444444444", kind: "reasoning_trace", sha256: "a".repeat(64), bytes: 40, lines: 4 },
      { source_id: "88888888-8888-4888-8888-888888888888", kind: "dispatch_audit", sha256: "b".repeat(64), bytes: 80, lines: 8 },
    ],
    audit_rows: [{ source_id: "88888888-8888-4888-8888-888888888888", row_index: 7, canonicalization: "rfc8785_jcs", sha256: "c".repeat(64) }],
    derived_hashes: [{ kind: "reasoning_delta_aggregate", sha256: "d".repeat(64), bytes: 20, characters: 20 }],
    evidence_level: "production_correlated",
    limitations: ["reasoning_trace_provider_supplied", "no_raw_content_copied"],
    timestamps: { occurred_at: "2026-07-11T00:00:00.000Z", observed_at: "2026-07-11T00:01:00.000Z", created_at: "2026-07-11T00:02:00.000Z" },
    ...overrides,
  };
}

function evidencePath(label = randomUUID()) {
  return path.join(tmpRoot, "evidence-project", ".pi-astack", "llm-audit", "incident-evidence", `incident-evidence-${label}.json`);
}

function writeEvidence(label, value) {
  const file = evidencePath(label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

function writePinRequest(label, value) {
  const file = path.join(tmpRoot, `${label}.json`);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function makeSealRoot(label, content = "{\"id\":1}\n{\"id\":2}\n") {
  const root = path.join(tmpRoot, label);
  const archiveDir = path.join(root, "archive");
  const archive = path.join(archiveDir, "stable.jsonl");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(archive, content, { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(archive, old, old);
  waitForStableWindowSync(archive, 1);
  return { root, archiveDir, archive };
}

console.log("audit log maintenance smoke");

await check("strict CLI rejects unknown flags, missing values, duplicates, and invalid command cardinality", async () => {
  assert.equal(run(["inventory", "--bogus"], 1).code, "CLI_ARGUMENT_INVALID");
  assert.equal(run(["inventory", "--root", "--yes"], 1).code, "CLI_ARGUMENT_INVALID");
  assert.equal(run(["seal", "--root", tmpRoot, "--stable-ms", "1", "--stable-ms", "2"], 1).code, "CLI_ARGUMENT_INVALID");
  assert.equal(run(["rotate-legacy", "--root", tmpRoot, "--root", tmpRoot, "--path", "/tmp/x"], 1).code, "CLI_ARGUMENT_INVALID");
  assert.equal(run(["pin", "--input-manifest", "/tmp/a", "--output-dir", "/tmp/b", "--yes=true"], 1).code, "CLI_ARGUMENT_INVALID");
  assert.equal(run(["seal", "--root", "relative"], 1).code, "PATH_REJECTED");
});

await check("inventory requires absolute roots, reads no content, and is byte-identical", async () => {
  assert.equal(run(["inventory"], 1).code, "EXPLICIT_ROOT_REQUIRED");
  const root = path.join(tmpRoot, "inventory");
  const audit = path.join(root, "audit.jsonl");
  fs.mkdirSync(path.join(root, "archive"), { recursive: true });
  fs.writeFileSync(audit, "prompt-body-must-not-appear\n", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "archive", "old.jsonl"), "{\"id\":0}\n");
  const before = treeSnapshot(root);
  const result = run(["inventory", "--root", root]);
  assert(result.ok && result.content_read === false && result.dry_run === true);
  assert(result.entries.some((entry) => entry.path === audit && entry.active === true));
  assert(!JSON.stringify(result).includes("prompt-body-must-not-appear"));
  assert.deepEqual(treeSnapshot(root), before);
});

await check("rotate-legacy defaults dry and strict execution preserves inode and permissions", async () => {
  const { root, active } = makeLegacyRoot("legacy-success");
  const raw = fs.readFileSync(active, "utf8");
  const beforeIdentity = fs.statSync(active);
  const before = treeSnapshot(root);
  const dry = run(["rotate-legacy", "--root", root, "--path", active]);
  assert(dry.dry_run && dry.entries[0].status === "planned");
  assert.deepEqual(treeSnapshot(root), before);
  const actual = run(["rotate-legacy", "--root", root, "--path", active, "--yes"]);
  const archive = actual.entries[0].archive_path;
  const archiveIdentity = fs.statSync(archive);
  assert.match(path.basename(archive), /observed-last-pre-rotate-/);
  assert.equal(archiveIdentity.dev, beforeIdentity.dev);
  assert.equal(archiveIdentity.ino, beforeIdentity.ino);
  assert.equal(fs.readFileSync(archive, "utf8"), raw);
  assert.equal(fs.readFileSync(active, "utf8"), "");
  assert.equal(actual.entries[0].boundary_precision, "eventually_stable_not_linearizable");
  assert.equal(mode(active), 0o600);
  assert.equal(mode(archive), 0o600);
  assert.equal(mode(path.dirname(active)), 0o700);
  assert.equal(mode(path.dirname(archive)), 0o700);
});

await check("rotate-legacy rejects symlink root, intermediate, target, archive, and nonregular target", async () => {
  const real = makeLegacyRoot("symlink-real");
  const linkedRoot = path.join(tmpRoot, "symlink-root");
  fs.symlinkSync(real.root, linkedRoot);
  assert.equal(run(["rotate-legacy", "--root", linkedRoot, "--path", path.join(linkedRoot, ".pi-astack", "llm-audit", "audit.jsonl"), "--yes"], 1).code, "LEGACY_PATH_REJECTED");

  const intermediateRoot = path.join(tmpRoot, "symlink-intermediate");
  const externalPi = path.join(tmpRoot, "external-pi");
  fs.mkdirSync(path.join(externalPi, "llm-audit"), { recursive: true });
  fs.writeFileSync(path.join(externalPi, "llm-audit", "audit.jsonl"), "keep\n");
  fs.mkdirSync(intermediateRoot);
  fs.symlinkSync(externalPi, path.join(intermediateRoot, ".pi-astack"));
  assert.equal(run(["rotate-legacy", "--root", intermediateRoot, "--path", path.join(intermediateRoot, ".pi-astack", "llm-audit", "audit.jsonl"), "--yes"], 1).code, "LEGACY_PATH_REJECTED");

  const targetFixture = makeLegacyRoot("symlink-target");
  const externalFile = path.join(tmpRoot, "external-audit.jsonl");
  fs.writeFileSync(externalFile, "external-keep\n", { mode: 0o644 });
  fs.rmSync(targetFixture.active);
  fs.symlinkSync(externalFile, targetFixture.active);
  assert.equal(run(["rotate-legacy", "--root", targetFixture.root, "--path", targetFixture.active, "--yes"], 1).code, "LEGACY_PATH_REJECTED");
  assert.equal(fs.readFileSync(externalFile, "utf8"), "external-keep\n");

  const archiveFixture = makeLegacyRoot("symlink-archive");
  const externalArchive = path.join(tmpRoot, "external-archive");
  fs.mkdirSync(externalArchive);
  fs.symlinkSync(externalArchive, archiveFixture.archiveDir);
  assert.equal(run(["rotate-legacy", "--root", archiveFixture.root, "--path", archiveFixture.active, "--yes"], 1).code, "LEGACY_PATH_REJECTED");
  assert.deepEqual(fs.readdirSync(externalArchive), []);

  const directoryFixture = makeLegacyRoot("directory-target");
  fs.rmSync(directoryFixture.active);
  fs.mkdirSync(directoryFixture.active);
  assert.equal(run(["rotate-legacy", "--root", directoryFixture.root, "--path", directoryFixture.active, "--yes"], 1).code, "LEGACY_PATH_REJECTED");
});

await check("rotate-legacy detects target identity replacement inside the rotation lock", async () => {
  const fixture = makeLegacyRoot("toctou-target");
  const original = path.join(fixture.sink, "original-moved.jsonl");
  const ready = markerPath("strict-rotate");
  const running = runAsync(
    ["rotate-legacy", "--root", fixture.root, "--path", fixture.active, "--yes"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_PAUSE_MS: "300",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: ready,
    },
  );
  await waitForReadyMarker(ready, "strict_rotate_locked", running);
  fs.renameSync(fixture.active, original);
  fs.writeFileSync(fixture.active, "replacement-must-not-rotate\n", { mode: 0o600 });
  const result = await running.completion;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  const failure = JSON.parse((result.stderr || result.stdout).trim());
  assert.equal(failure.code, "MAINTENANCE_FAILED");
  assert.equal(fs.readFileSync(fixture.active, "utf8"), "replacement-must-not-rotate\n");
  const archives = fs.existsSync(fixture.archiveDir) ? fs.readdirSync(fixture.archiveDir).filter((name) => name.endsWith(".jsonl")) : [];
  assert.deepEqual(archives, []);
});

await check("pin is dry-run by default and --yes emits only schema-validated fields at 0700/0600", async () => {
  const input = writePinRequest("pin-valid", validPinRequest());
  const outputDir = path.join(tmpRoot, "pins-valid");
  const dry = run(["pin", "--input-manifest", input, "--output-dir", outputDir]);
  assert(dry.dry_run && dry.pin_path === null);
  assert(!fs.existsSync(outputDir), "dry-run created output directory");
  const actual = run(["pin", "--input-manifest", input, "--output-dir", outputDir, "--yes"]);
  const raw = fs.readFileSync(actual.pin_path, "utf8");
  const pin = JSON.parse(raw);
  assert.equal(pin.schema_version, "incident-pin/v1");
  assert.equal(pin.incident.incident_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(pin.sources.length, 1);
  assert.equal(pin.sources[0].source_verified, true);
  assert.equal(pin.sources[0].identity.size, pin.sources[0].bytes);
  assert.equal(pin.retention.schema_version, "reasoning-retention/v1");
  assert.equal(pin.retention.automatic_gc, false);
  assert.equal(pin.raw_content_copied, false);
  assert.equal(mode(outputDir), 0o700);
  assert.equal(mode(actual.pin_path), 0o600);
});

await check("pin writes through the pinned directory fd when the output path is replaced", async () => {
  if (process.platform !== "linux") return;
  const input = writePinRequest("pin-directory-race", validPinRequest());
  const outputDir = path.join(tmpRoot, "pin-directory-race-output");
  const originalDir = path.join(tmpRoot, "pin-directory-race-original-inode");
  const externalDir = path.join(tmpRoot, "pin-directory-race-external");
  fs.mkdirSync(outputDir, { mode: 0o700 });
  fs.mkdirSync(externalDir, { mode: 0o755 });
  const ready = markerPath("pin-directory");
  const running = runAsync(
    ["pin", "--input-manifest", input, "--output-dir", outputDir, "--yes"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_DIRECTORY_PAUSE_MS: "300",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: ready,
    },
  );
  await waitForReadyMarker(ready, "directory_fd_ready", running);
  fs.renameSync(outputDir, originalDir);
  fs.symlinkSync(externalDir, outputDir);
  const result = await running.completion;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(JSON.parse((result.stderr || result.stdout).trim()).code, "IDENTITY_CHANGED");
  assert.deepEqual(fs.readdirSync(externalDir), []);
  assert(fs.readdirSync(originalDir).some((name) => name.startsWith("incident-pin-")), "pinned directory inode did not receive the output");
});

await check("pin rejects secret/body fields, arbitrary paths/timestamps, symlink input, deep and oversized manifests", async () => {
  const outputDir = path.join(tmpRoot, "pins-reject");
  const secret = validPinRequest({ secret: "pin-secret-value" });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("pin-secret", secret), "--output-dir", outputDir], 1).code, "PIN_INPUT_INVALID");

  const bodyPath = validPinRequest();
  bodyPath.sources[0].path = path.join(tmpRoot, ".pi-astack", "llm-audit", "archive", "raw-prompt-secret.jsonl");
  assert.equal(run(["pin", "--input-manifest", writePinRequest("pin-body-path", bodyPath), "--output-dir", outputDir], 1).code, "PIN_INPUT_INVALID");

  const badTime = validPinRequest();
  badTime.incident.occurred_at = "2026-07-11T00:00:00.000Z\nsecret";
  assert.equal(run(["pin", "--input-manifest", writePinRequest("pin-time", badTime), "--output-dir", outputDir], 1).code, "PIN_INPUT_INVALID");

  const deep = validPinRequest({ nested: { a: { b: { c: { body: "secret" } } } } });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("pin-deep", deep), "--output-dir", outputDir], 1).code, "PIN_INPUT_INVALID");

  const tooMany = validPinRequest();
  tooMany.sources = Array.from({ length: 129 }, (_, index) => ({ ...tooMany.sources[0], source_id: randomUUID(), path: archiveSourcePath(String(index)) }));
  assert.equal(run(["pin", "--input-manifest", writePinRequest("pin-array", tooMany), "--output-dir", outputDir], 1).code, "PIN_INPUT_INVALID");

  const oversized = path.join(tmpRoot, "pin-oversized.json");
  fs.writeFileSync(oversized, `{"body":"${"x".repeat(1024 * 1024)}"}`);
  assert.equal(run(["pin", "--input-manifest", oversized, "--output-dir", outputDir], 1).code, "SIZE_LIMIT_EXCEEDED");

  const input = writePinRequest("pin-real-input", validPinRequest());
  const link = path.join(tmpRoot, "pin-input-link.json");
  fs.symlinkSync(input, link);
  assert.equal(run(["pin", "--input-manifest", link, "--output-dir", outputDir], 1).code, "PATH_REJECTED");
  assert(!fs.existsSync(outputDir));
});

await check("pin validates canonical session paths and rejects arbitrary session locations/names", async () => {
  const session = path.join(sessionFixtureDir, "2026-07-10T03-29-50-267Z_33333333-3333-7333-8333-333333333333.jsonl");
  fs.writeFileSync(session, "{\"type\":\"message\"}\n", { mode: 0o600 });
  const request = validPinRequest({ sources: [sourceRecord("session_log", session)] });
  const dry = run(["pin", "--input-manifest", writePinRequest("pin-session", request), "--output-dir", path.join(tmpRoot, "pin-session-out")]);
  assert.equal(dry.dry_run, true);

  for (const badPath of [
    path.join(tmpRoot, "sessions", path.basename(sessionFixtureDir), path.basename(session)),
    path.join("/home/worker/.pi/agent/sessions", "project-without-markers", path.basename(session)),
    path.join(sessionFixtureDir, "arbitrary.jsonl"),
  ]) {
    const bad = validPinRequest();
    bad.sources[0] = { ...sourceRecord("session_log", session), path: badPath };
    assert.equal(run(["pin", "--input-manifest", writePinRequest(`bad-session-${randomUUID()}`, bad), "--output-dir", path.join(tmpRoot, "bad-session-out")], 1).code, "PIN_INPUT_INVALID");
  }
});

await check("pin enforces closed incident-evidence schema and rejects raw/free-text fields", async () => {
  const goodFile = writeEvidence("55555555-5555-4555-8555-555555555555", validEvidenceManifest());
  const good = validPinRequest({ sources: [sourceRecord("evidence_manifest", goodFile)] });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("evidence-good", good), "--output-dir", path.join(tmpRoot, "evidence-good-out")]).dry_run, true);

  const rawFile = writeEvidence("66666666-6666-4666-8666-666666666666", validEvidenceManifest({ raw_content: "forbidden" }));
  const rawRequest = validPinRequest({ sources: [sourceRecord("evidence_manifest", rawFile)] });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("evidence-raw", rawRequest), "--output-dir", path.join(tmpRoot, "evidence-raw-out")], 1).code, "PIN_INPUT_INVALID");

  const freeTextFile = writeEvidence("77777777-7777-4777-8777-777777777777", validEvidenceManifest({ limitations: ["operator prose is forbidden"] }));
  const freeTextRequest = validPinRequest({ sources: [sourceRecord("evidence_manifest", freeTextFile)] });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("evidence-free", freeTextRequest), "--output-dir", path.join(tmpRoot, "evidence-free-out")], 1).code, "PIN_INPUT_INVALID");

  const badReference = validEvidenceManifest();
  badReference.audit_rows[0].source_id = "44444444-4444-4444-8444-444444444444";
  const badReferenceFile = writeEvidence("99999999-9999-4999-8999-999999999999", badReference);
  const badReferenceRequest = validPinRequest({ sources: [sourceRecord("evidence_manifest", badReferenceFile)] });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("evidence-bad-reference", badReferenceRequest), "--output-dir", path.join(tmpRoot, "evidence-bad-reference-out")], 1).code, "PIN_INPUT_INVALID");

  const badUnit = validEvidenceManifest();
  badUnit.metrics[0].unit = "tokens";
  const badUnitFile = writeEvidence("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", badUnit);
  const badUnitRequest = validPinRequest({ sources: [sourceRecord("evidence_manifest", badUnitFile)] });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("evidence-bad-unit", badUnitRequest), "--output-dir", path.join(tmpRoot, "evidence-bad-unit-out")], 1).code, "PIN_INPUT_INVALID");

  const derivedRaw = validEvidenceManifest();
  derivedRaw.derived_hashes[0].raw = "forbidden";
  const derivedRawFile = writeEvidence("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", derivedRaw);
  const derivedRawRequest = validPinRequest({ sources: [sourceRecord("evidence_manifest", derivedRawFile)] });
  assert.equal(run(["pin", "--input-manifest", writePinRequest("evidence-derived-raw", derivedRawRequest), "--output-dir", path.join(tmpRoot, "evidence-derived-raw-out")], 1).code, "PIN_INPUT_INVALID");
});

await check("pin dry-run rejects hash, bytes, and lines mismatches", async () => {
  const base = validPinRequest();
  for (const field of ["sha256", "bytes", "lines"]) {
    const request = structuredClone(base);
    request.sources[0][field] = field === "sha256" ? "b".repeat(64) : request.sources[0][field] + 1;
    assert.equal(run(["pin", "--input-manifest", writePinRequest(`mismatch-${field}`, request), "--output-dir", path.join(tmpRoot, "mismatch-out")], 1).code, "PIN_SOURCE_MISMATCH");
  }
});

await check("pin rejects source symlinks, per-source over-limit claims, and mutation during hash", async () => {
  const archive = archiveSourcePath("symlink-source");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const external = path.join(tmpRoot, "pin-source-external.jsonl");
  fs.writeFileSync(external, "external\n");
  fs.symlinkSync(external, archive);
  const linked = validPinRequest();
  linked.sources = [{ source_id: randomUUID(), kind: "llm_audit_archive", path: archive, ...sourceFacts(external), observed_at: "2026-07-11T00:01:00.000Z" }];
  assert.equal(run(["pin", "--input-manifest", writePinRequest("source-link", linked), "--output-dir", path.join(tmpRoot, "source-link-out")], 1).code, "PATH_REJECTED");

  const overPath = archiveSourcePath("actual-over-limit");
  fs.writeFileSync(overPath, "x", { mode: 0o600 });
  fs.truncateSync(overPath, 64 * 1024 * 1024 + 1);
  const over = validPinRequest();
  over.sources = [{
    source_id: randomUUID(),
    kind: "llm_audit_archive",
    path: overPath,
    sha256: "a".repeat(64),
    bytes: 64 * 1024 * 1024 + 1,
    lines: 1,
    observed_at: "2026-07-11T00:01:00.000Z",
  }];
  assert.equal(run(["pin", "--input-manifest", writePinRequest("source-over", over), "--output-dir", path.join(tmpRoot, "source-over-out")], 1).code, "PIN_SOURCE_SIZE_EXCEEDED");

  const trace = path.join(tmpRoot, "mutation-project", ".pi-astack", "llm-audit", "dispatch-reasoning", `trace-1720660000000-1-${randomUUID()}.jsonl`);
  fs.mkdirSync(path.dirname(trace), { recursive: true });
  fs.writeFileSync(trace, `${"x".repeat(1024 * 1024 - 1)}\n`.repeat(8));
  const changing = validPinRequest({ sources: [sourceRecord("reasoning_trace", trace)] });
  const ready = markerPath("pin-source-hash");
  const running = runAsync(
    ["pin", "--input-manifest", writePinRequest("source-changing", changing), "--output-dir", path.join(tmpRoot, "source-changing-out")],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_PIN_CHUNK_DELAY_MS: "60",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: ready,
    },
  );
  await waitForReadyMarker(ready, "pin_source_hash_started", running);
  fs.appendFileSync(trace, "changed\n");
  const result = await running.completion;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(JSON.parse(result.stderr.trim()).code, "PIN_SOURCE_CHANGED");
});

await check("seal rejects archive symlink/nonregular and records fail-closed reasons", async () => {
  const { root, archiveDir } = makeSealRoot("seal-types");
  const external = path.join(tmpRoot, "seal-external.jsonl");
  fs.writeFileSync(external, "external\n");
  fs.symlinkSync(external, path.join(archiveDir, "linked.jsonl"));
  fs.mkdirSync(path.join(archiveDir, "directory.jsonl"));
  const result = run(["seal", "--root", root, "--stable-ms", "1", "--yes"], 1);
  const entries = result.roots[0].entries;
  assert(entries.some((entry) => entry.reason === "archive_symlink_forbidden"));
  assert(entries.some((entry) => entry.reason === "archive_not_regular"));
  assert(fs.existsSync(result.roots[0].manifest_path));
  assert.equal(fs.readFileSync(external, "utf8"), "external\n");
});

await check("seal verifies stable snapshots without changing archive bytes", async () => {
  const { root, archive } = makeSealRoot("seal-stable");
  const beforeHash = hashFile(archive);
  const dry = run(["seal", "--root", root, "--stable-ms", "1"]);
  assert.equal(dry.roots[0].entries[0].status, "snapshot_planned");
  const actual = run(["seal", "--root", root, "--stable-ms", "1", "--yes"]);
  const sealed = actual.roots[0].entries.find((entry) => entry.path === archive);
  assert.equal(sealed.status, "snapshot_verified");
  assert.equal(sealed.lines, 2);
  assert.equal(sealed.sha256, beforeHash);
  assert.equal(sealed.boundary_precision, "eventually_stable_not_linearizable");
  assert.equal(hashFile(archive), beforeHash);
  assert.equal(mode(actual.roots[0].manifest_path), 0o600);
  const manifest = JSON.parse(fs.readFileSync(actual.roots[0].manifest_path, "utf8"));
  assert.equal(manifest.schema_version, "audit-seal-manifest/v2");
  assert.equal(manifest.canonical_root, root);
  assert.equal(manifest.entries[0].identity.ino, fs.statSync(archive).ino);
});

await check("seal writes through the pinned archive fd when the archive path is replaced", async () => {
  if (process.platform !== "linux") return;
  const fixture = makeSealRoot("seal-directory-race");
  const originalArchiveDir = path.join(tmpRoot, "seal-directory-race-original-inode");
  const externalDir = path.join(tmpRoot, "seal-directory-race-external");
  fs.mkdirSync(externalDir, { mode: 0o755 });
  const ready = markerPath("seal-directory");
  const running = runAsync(
    ["seal", "--root", fixture.root, "--stable-ms", "1", "--yes"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_DIRECTORY_PAUSE_MS: "300",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: ready,
    },
  );
  await waitForReadyMarker(ready, "directory_fd_ready", running);
  fs.renameSync(fixture.archiveDir, originalArchiveDir);
  fs.symlinkSync(externalDir, fixture.archiveDir);
  const result = await running.completion;
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(JSON.parse((result.stderr || result.stdout).trim()).code, "IDENTITY_CHANGED");
  assert.deepEqual(fs.readdirSync(externalDir), []);
  assert(fs.readdirSync(originalArchiveDir).some((name) => name.startsWith("archive-seal-manifest-")), "pinned archive inode did not receive the manifest");
});

await check("seal refuses active-fd mutation during hash and succeeds after the stability window", async () => {
  const content = `${"x".repeat(1024 * 1024 - 1)}\n`.repeat(8);
  const { root, archive } = makeSealRoot("seal-active-fd", content);
  const fd = fs.openSync(archive, "a");
  const ready = markerPath("seal-hash");
  const running = runAsync(
    ["seal", "--root", root, "--stable-ms", "1", "--max-bytes", String(16 * 1024 * 1024), "--yes"],
    {
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_MAINTENANCE_TEST_CHUNK_DELAY_MS: "100",
      PI_ASTACK_MAINTENANCE_TEST_READY_MARKER: ready,
    },
  );
  await waitForReadyMarker(ready, "seal_hash_started", running);
  fs.writeSync(fd, "late-old-fd-line\n");
  fs.closeSync(fd);
  const changed = await running.completion;
  assert.equal(changed.status, 1, `stdout=${changed.stdout}\nstderr=${changed.stderr}`);
  const changedResult = JSON.parse(changed.stdout.trim());
  assert(changedResult.roots[0].entries.some((entry) => ["identity_changed_during_hash", "stability_window_changed_during_hash"].includes(entry.reason)));
  await waitForStableWindow(archive, 10);
  const stable = run(["seal", "--root", root, "--stable-ms", "10", "--max-bytes", String(16 * 1024 * 1024), "--yes"]);
  const verified = stable.roots[0].entries.find((entry) => entry.path === archive);
  assert.equal(verified.status, "snapshot_verified");
  assert.equal(verified.sha256, hashFile(archive));
  assert.equal(verified.lines, 9);
});

await check("seal enforces max-byte and time budgets without hashing unbounded files", async () => {
  const maxFixture = makeSealRoot("seal-max", "x".repeat(4096));
  const maxResult = run(["seal", "--root", maxFixture.root, "--stable-ms", "1", "--max-bytes", "32", "--yes"], 1);
  assert.equal(maxResult.roots[0].entries[0].reason, "max_bytes_exceeded");

  const timeFixture = makeSealRoot("seal-time", `${"y".repeat(1024 * 1024 - 1)}\n`.repeat(2));
  const timeResult = run(
    ["seal", "--root", timeFixture.root, "--stable-ms", "1", "--max-bytes", String(4 * 1024 * 1024), "--time-budget-ms", "1", "--yes"],
    1,
    { env: { PI_ASTACK_ENABLE_TEST_HOOKS: "1", PI_ASTACK_MAINTENANCE_TEST_CHUNK_DELAY_MS: "10" } },
  );
  assert.equal(timeResult.roots[0].entries[0].reason, "time_budget_exceeded");
  assert.equal(run(["seal", "--root", timeFixture.root, "--max-bytes", String(16 * 1024 * 1024 * 1024 + 1)], 1).code, "CLI_ARGUMENT_INVALID");
});

await check("seal readdir permission failure is fail-closed before any root manifest write", async () => {
  const first = makeSealRoot("seal-preflight-first");
  const blocked = makeSealRoot("seal-preflight-blocked");
  fs.chmodSync(blocked.archiveDir, 0o000);
  try {
    const result = run(["seal", "--root", first.root, "--root", blocked.root, "--stable-ms", "1", "--yes"], 1);
    assert.equal(result.code, "SEAL_READDIR_FAILED");
    assert(!fs.readdirSync(first.archiveDir).some((name) => name.startsWith("archive-seal-manifest-")));
  } finally {
    fs.chmodSync(blocked.archiveDir, 0o700);
  }
});

await check("seal writes one independent manifest per canonical root", async () => {
  const one = makeSealRoot("seal-multi-one");
  const two = makeSealRoot("seal-multi-two", "{\"id\":2}\n");
  const result = run(["seal", "--root", one.root, "--root", two.root, "--stable-ms", "1", "--yes"]);
  assert.equal(result.roots.length, 2);
  assert.notEqual(result.roots[0].manifest_path, result.roots[1].manifest_path);
  for (const rootResult of result.roots) {
    const manifest = JSON.parse(fs.readFileSync(rootResult.manifest_path, "utf8"));
    assert.equal(manifest.canonical_root, rootResult.root);
    assert(manifest.entries.every((entry) => entry.status === "snapshot_verified"));
  }
});

if (failed > 0) {
  console.log(`\nFAIL - ${failed} check(s) failed; ${passed} passed.`);
  process.exit(1);
}
console.log(`\nPASS - ${passed} audit maintenance check(s) passed.`);
