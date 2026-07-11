#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const helperPath = path.join(repoRoot, "extensions/_shared/rotating-jsonl.ts");
const maintenanceCli = path.join(repoRoot, "scripts/audit-log-maintenance.mjs");
const jitiPath = path.join(repoRoot, "node_modules/jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  appendRotatingJsonlLine,
  resolveJsonlRotationSettings,
  rotateJsonlGeneration,
} = await jiti.import(helperPath);
const {
  DEFAULT_LLM_AUDIT_ROTATION_SETTINGS,
  resolveLlmAuditRotationSettings,
} = await jiti.import(path.join(repoRoot, "extensions/_shared/llm-audit.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-audit-rotation-"));
process.on("exit", () => {
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

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function auditFiles(activePath) {
  const archiveDir = path.join(path.dirname(activePath), "archive");
  const archives = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(archiveDir, name))
    : [];
  return [...archives, activePath].filter((file) => fs.existsSync(file));
}

function readAllRows(activePath) {
  const rows = [];
  for (const file of auditFiles(activePath)) {
    const raw = fs.readFileSync(file, "utf8");
    assert(raw === "" || raw.endsWith("\n"), `partial trailing line in ${file}`);
    for (const line of raw.split("\n").filter(Boolean)) rows.push(JSON.parse(line));
  }
  return rows;
}

function childAppend(activePath, worker, count) {
  const code = `
    const { createJiti } = require(${JSON.stringify(jitiPath)});
    const jiti = createJiti(process.cwd() + "/", { moduleCache: false });
    (async () => {
      const { appendRotatingJsonlLine } = await jiti.import(${JSON.stringify(helperPath)});
      for (let i = 0; i < ${count}; i++) {
        const result = await appendRotatingJsonlLine(${JSON.stringify(activePath)}, JSON.stringify({ id: ${JSON.stringify(worker)} + ":" + i, worker: ${worker}, seq: i, payload: "x".repeat(48) }), {
          sink: "concurrent-smoke",
          rotation: { enabled: true, maxBytes: 700, maxAgeMs: 86400000, lockTimeoutMs: 5000 },
        });
        if (!result.appended) throw new Error(JSON.stringify(result));
        if (i % 5 === 0) await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
      }
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(`worker ${worker} exited ${status}: ${stderr}`)));
  });
}

console.log("audit log rotation smoke");

await check("rotation settings are strict finite positive integers with compatible defaults", async () => {
  assert.deepEqual(resolveLlmAuditRotationSettings({}), DEFAULT_LLM_AUDIT_ROTATION_SETTINGS);
  assert.equal(DEFAULT_LLM_AUDIT_ROTATION_SETTINGS.maxBytes, 256 * 1024 * 1024);
  assert.equal(DEFAULT_LLM_AUDIT_ROTATION_SETTINGS.maxAgeMs, 24 * 60 * 60 * 1000);
  const valid = resolveLlmAuditRotationSettings({ llmAudit: { rotation: { enabled: false, maxBytes: 9, maxAgeMs: 10, lockTimeoutMs: 11 } } });
  assert.deepEqual(valid, { enabled: false, maxBytes: 9, maxAgeMs: 10, lockTimeoutMs: 11 });
  const invalid = resolveJsonlRotationSettings(
    { enabled: "true", maxBytes: 0, maxAgeMs: NaN, lockTimeoutMs: 60001 },
    DEFAULT_LLM_AUDIT_ROTATION_SETTINGS,
  );
  assert.deepEqual(invalid, DEFAULT_LLM_AUDIT_ROTATION_SETTINGS);
});

await check("six child processes append and rotate every unique JSON row exactly once", async () => {
  const active = path.join(tmpRoot, "concurrent", "audit.jsonl");
  const workers = 6;
  const count = 36;
  await Promise.all(Array.from({ length: workers }, (_, worker) => childAppend(active, worker, count)));
  const rows = readAllRows(active);
  assert.equal(rows.length, workers * count);
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate row id found");
  for (let worker = 0; worker < workers; worker++) {
    for (let seq = 0; seq < count; seq++) assert(ids.includes(`${worker}:${seq}`), `missing ${worker}:${seq}`);
  }
  const files = auditFiles(active);
  assert(files.length > 2, "tiny threshold did not create archives");
  assert.equal(new Set(files.map((file) => path.basename(file))).size, files.length, "archive name collision");
  for (const file of files) assert.equal(mode(file), 0o600, `bad file mode: ${file}`);
  const dir = path.dirname(active);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, "archive")), 0o700);
  assert.equal(mode(path.join(dir, ".audit.jsonl.generation.json")), 0o600);
});

await check("oversize row is complete, diagnosed, and rotated before the following row", async () => {
  const active = path.join(tmpRoot, "oversize", "audit.jsonl");
  const rotation = { enabled: true, maxBytes: 80, maxAgeMs: 60_000, lockTimeoutMs: 500 };
  const large = { id: "large", payload: "q".repeat(400) };
  const first = await appendRotatingJsonlLine(active, JSON.stringify(large), { sink: "oversize", rotation });
  assert(first.appended && first.oversize);
  assert(first.diagnostics.some((item) => item.code === "oversize_line"));
  const second = await appendRotatingJsonlLine(active, JSON.stringify({ id: "after" }), { sink: "oversize", rotation });
  assert(second.appended && second.rotated);
  const rows = readAllRows(active);
  assert.deepEqual(new Set(rows.map((row) => row.id)), new Set(["large", "after"]));
  const archive = auditFiles(active).find((file) => file !== active);
  assert(archive && fs.statSync(archive).size > rotation.maxBytes, "soft max was incorrectly treated as a split/hard cap");
});

await check("generation age uses sidecar createdAt and rotates without mtime-as-creation", async () => {
  const active = path.join(tmpRoot, "age", "audit.jsonl");
  const rotation = { enabled: true, maxBytes: 10000, maxAgeMs: 500, lockTimeoutMs: 500 };
  await appendRotatingJsonlLine(active, JSON.stringify({ id: "old" }), { sink: "age", rotation, now: () => 1_700_000_000_000 });
  const second = await appendRotatingJsonlLine(active, JSON.stringify({ id: "new" }), { sink: "age", rotation, now: () => 1_700_000_001_000 });
  assert(second.rotated);
  const names = auditFiles(active).map((file) => path.basename(file));
  assert(names.some((name) => /first-.*__observed-last-pre-rotate-.*__rotated-.*__pid-.*__seq-/.test(name)));
});

await check("live lock timeout fails open to active with controlled diagnostic", async () => {
  const active = path.join(tmpRoot, "lock-timeout", "audit.jsonl");
  const rotation = { enabled: true, maxBytes: 40, maxAgeMs: 60_000, lockTimeoutMs: 25 };
  await appendRotatingJsonlLine(active, JSON.stringify({ id: "before", payload: "x".repeat(80) }), { sink: "lock-timeout", rotation });
  const lockPath = path.join(path.dirname(active), ".audit.jsonl.rotate.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "held", created_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  const result = await appendRotatingJsonlLine(active, JSON.stringify({ id: "during-lock" }), { sink: "lock-timeout", rotation });
  assert(result.appended && !result.rotated);
  assert(result.diagnostics.some((item) => item.code === "rotation_failed" && item.message.includes("timeout")));
  fs.rmSync(lockPath, { force: true });
  assert(readAllRows(active).some((row) => row.id === "during-lock"));
});

await check("archive, generation meta, and transaction symlinks fail open without touching external targets", async () => {
  const rotation = { enabled: true, maxBytes: 1, maxAgeMs: 1, lockTimeoutMs: 100 };

  const archiveActive = path.join(tmpRoot, "unsafe-archive", "audit.jsonl");
  const archiveExternal = path.join(tmpRoot, "unsafe-archive-external");
  fs.mkdirSync(path.dirname(archiveActive), { recursive: true });
  fs.mkdirSync(archiveExternal, { mode: 0o755 });
  fs.writeFileSync(archiveActive, "", { mode: 0o600 });
  fs.symlinkSync(archiveExternal, path.join(path.dirname(archiveActive), "archive"));
  const archiveResult = await appendRotatingJsonlLine(archiveActive, JSON.stringify({ id: "archive-safe-append" }), { sink: "unsafe-archive", rotation });
  assert(archiveResult.appended && !archiveResult.rotated);
  assert(archiveResult.diagnostics.some((item) => item.code === "recovery_failed"));
  assert.equal(mode(archiveExternal), 0o755);
  assert.deepEqual(fs.readdirSync(archiveExternal), []);
  assert.equal(JSON.parse(fs.readFileSync(archiveActive, "utf8")).id, "archive-safe-append");

  for (const kind of ["generation", "transaction"]) {
    const active = path.join(tmpRoot, `unsafe-${kind}`, "audit.jsonl");
    const sinkDir = path.dirname(active);
    const external = path.join(tmpRoot, `unsafe-${kind}-external.json`);
    fs.mkdirSync(path.join(sinkDir, "archive"), { recursive: true });
    fs.writeFileSync(active, "", { mode: 0o600 });
    fs.writeFileSync(external, `${kind}-external-keep\n`, { mode: 0o644 });
    const sidecar = kind === "generation"
      ? path.join(sinkDir, ".audit.jsonl.generation.json")
      : path.join(sinkDir, ".audit.jsonl.rotation-transaction.json");
    fs.symlinkSync(external, sidecar);
    const result = await appendRotatingJsonlLine(active, JSON.stringify({ id: `${kind}-safe-append` }), { sink: `unsafe-${kind}`, rotation });
    assert(result.appended && !result.rotated, kind);
    assert(result.diagnostics.some((item) => item.code === "recovery_failed"), kind);
    assert.equal(fs.readFileSync(external, "utf8"), `${kind}-external-keep\n`, kind);
    assert.equal(mode(external), 0o644, kind);
    assert.equal(fs.lstatSync(sidecar).isSymbolicLink(), true, kind);
    assert.equal(JSON.parse(fs.readFileSync(active, "utf8")).id, `${kind}-safe-append`, kind);
  }
});

await check("every durable transaction phase recovers without row loss or generation createdAt drift", async () => {
  const phases = ["prepared", "meta_archived", "active_archived", "active_created", "meta_created"];
  const baseNow = 1_700_000_000_000;
  for (const phase of phases) {
    const active = path.join(tmpRoot, `crash-${phase}`, "audit.jsonl");
    const rotation = { enabled: true, maxBytes: 10000, maxAgeMs: 60_000, lockTimeoutMs: 500 };
    await appendRotatingJsonlLine(active, JSON.stringify({ id: `before-${phase}` }), { sink: `crash-${phase}`, rotation, now: () => baseNow });
    const result = await rotateJsonlGeneration(active, {
      sink: `crash-${phase}`,
      rotation,
      now: () => baseNow + 1000,
      afterRotationPhase: (current) => {
        if (current === phase) throw new Error(`injected crash at ${phase}`);
      },
    });
    assert(!result.rotated && result.diagnostics.some((item) => item.code === "rotation_failed"), phase);
    const marker = path.join(path.dirname(active), ".audit.jsonl.rotation-transaction.json");
    assert(fs.existsSync(marker), `${phase}: marker missing`);
    assert.equal(mode(marker), 0o600, `${phase}: marker mode`);
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).phase, phase);

    const recovered = await appendRotatingJsonlLine(active, JSON.stringify({ id: `after-${phase}` }), { sink: `crash-${phase}`, rotation });
    assert(recovered.appended, phase);
    assert.deepEqual(new Set(readAllRows(active).map((row) => row.id)), new Set([`before-${phase}`, `after-${phase}`]), phase);
    assert(!fs.existsSync(marker), `${phase}: marker not cleared`);
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(active), ".audit.jsonl.generation.json"), "utf8"));
    assert.equal(meta.createdAt, new Date(baseNow + 1000).toISOString(), `${phase}: next generation createdAt drifted`);
    assert.equal(meta.boundaryPrecision, "eventually_stable_not_linearizable");
  }
});

await check("late old-fd append keeps archive hot until seal captures the final stable hash and lines", async () => {
  const active = path.join(tmpRoot, "late-old-fd", "audit.jsonl");
  const rotation = { enabled: true, maxBytes: 10000, maxAgeMs: 60_000, lockTimeoutMs: 500 };
  await appendRotatingJsonlLine(active, JSON.stringify({ id: "before" }), { sink: "late-old-fd", rotation });
  const oldFd = fs.openSync(active, "a");
  const rotated = await rotateJsonlGeneration(active, { sink: "late-old-fd", rotation });
  assert(rotated.rotated && rotated.archivePath);
  fs.writeSync(oldFd, `${JSON.stringify({ id: "late-old-fd" })}\n`);
  fs.closeSync(oldFd);

  const runSeal = (args, expectedStatus = 0) => {
    const result = spawnSync(process.execPath, [maintenanceCli, "seal", "--root", path.dirname(active), ...args], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, expectedStatus, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    return JSON.parse((result.stdout || result.stderr).trim());
  };
  const stableMs = 100;
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(rotated.archivePath, future, future);
  const hot = runSeal(["--stable-ms", String(stableMs)]);
  const hotEntry = hot.roots[0].entries.find((entry) => entry.path === rotated.archivePath);
  assert.equal(hotEntry.status, "hot");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(rotated.archivePath, old, old);
  await waitForStableWindow(rotated.archivePath, stableMs);
  const planned = runSeal(["--stable-ms", String(stableMs)]);
  const plannedEntry = planned.roots[0].entries.find((entry) => entry.path === rotated.archivePath);
  assert.equal(plannedEntry.status, "snapshot_planned");
  const sealed = runSeal(["--stable-ms", String(stableMs), "--yes"]);
  const entry = sealed.roots[0].entries.find((item) => item.path === rotated.archivePath);
  const finalBytes = fs.readFileSync(rotated.archivePath);
  assert.equal(entry.status, "snapshot_verified");
  assert.equal(entry.lines, 2);
  assert.equal(entry.sha256, createHash("sha256").update(finalBytes).digest("hex"));
  assert.equal(entry.boundary_precision, "eventually_stable_not_linearizable");
});

await check("existing active with missing meta gets a non-backfilled generation", async () => {
  const active = path.join(tmpRoot, "missing-meta", "audit.jsonl");
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, `${JSON.stringify({ id: "legacy" })}\n`, { mode: 0o600 });
  const old = new Date("2001-01-01T00:00:00.000Z");
  fs.utimesSync(active, old, old);
  const before = Date.now();
  const result = await appendRotatingJsonlLine(active, JSON.stringify({ id: "current" }), {
    sink: "missing-meta",
    rotation: { enabled: true, maxBytes: 10000, maxAgeMs: 60_000, lockTimeoutMs: 500 },
  });
  assert(result.appended);
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(active), ".audit.jsonl.generation.json"), "utf8"));
  assert(Date.parse(meta.createdAt) >= before, `createdAt was backfilled: ${meta.createdAt}`);
  assert.equal(readAllRows(active).length, 2);
});

await check("schema exposes strict llm and dispatch rotation blocks", async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
  const llm = schema.properties.llmAudit.properties.rotation;
  const dispatch = schema.properties.dispatch.properties.auditRotation;
  for (const block of [llm, dispatch]) {
    assert.equal(block.additionalProperties, false);
    assert.equal(block.properties.maxBytes.minimum, 1);
    assert.equal(block.properties.maxBytes.maximum, 1099511627776);
    assert.equal(block.properties.maxAgeMs.maximum, 31622400000);
    assert.equal(block.properties.lockTimeoutMs.maximum, 60000);
  }
});

if (failed > 0) {
  console.log(`\nFAIL - ${failed} check(s) failed; ${passed} passed.`);
  process.exit(1);
}
console.log(`\nPASS - ${passed} audit rotation check(s) passed.`);
