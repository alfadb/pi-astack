#!/usr/bin/env node
/**
 * Outcome evidence index production-runtime isolation smoke.
 * Proves: child process rebuild, abrainHome singleflight merge, structured
 * error visibility, parent event-loop progress during child work, bare
 * top-level-await settle without suite keepalive, and parent process.exit
 * best-effort kill of a still-running rebuild child via the shared exit hook.
 * Existing smoke:outcome-evidence remains the semantic spine coverage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const selfPath = fileURLToPath(import.meta.url);
const PARENT_EXIT_HELPER_FLAG = "--parent-exit-helper";
const PARENT_EXIT_HELPER_SCHEMA = "outcome-evidence-index-parent-exit-helper/v1";
const BARE_TLA_HELPER_FLAG = "--bare-tla-helper";
const BARE_TLA_HELPER_SCHEMA = "outcome-evidence-index-bare-tla-helper/v1";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

// ── Nested bare top-level-await helper ──────────────────────────────────────
// No suite keepalive / extra timers. Only awaits isolated rebuild and exits 0
// when the child settles — proves referenced stdio/child handles are enough.
if (process.argv[2] === BARE_TLA_HELPER_FLAG) {
  const abrainHomeArg = process.argv[3];
  if (!abrainHomeArg || !path.isAbsolute(abrainHomeArg)) {
    fs.writeSync(2, "bare-tla-helper requires absolute abrainHome\n");
    process.exit(2);
  }
  const jitiHelper = createJiti(repoRoot, { interopDefault: true });
  const outcomeHelper = jitiHelper(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));
  outcomeHelper.__TEST_setOutcomeEvidenceIsolatedRebuildControls({});
  const rebuilt = await outcomeHelper.rebuildOutcomeEvidenceIndexIsolated(abrainHomeArg);
  fs.writeSync(1, `${JSON.stringify({
    schema_version: BARE_TLA_HELPER_SCHEMA,
    status: "await_settled",
    ok: rebuilt.ok === true,
    mode: rebuilt.mode,
    child_pid: rebuilt.child_pid ?? null,
    exit_code: rebuilt.exit_code ?? null,
    rows: rebuilt.rows ?? 0,
    error: rebuilt.error ?? null,
  })}\n`);
  process.exit(rebuilt.ok === true ? 0 : 1);
}

// ── Nested parent helper (spawned by the parent-exit lifecycle check) ───────
// Starts a long busy-work isolated rebuild child, reports its pid via one
// structured stdout JSON line, then exits normally without awaiting the child.
// Lifecycle under test: process.exit + shared exit hook must kill the worker.
if (process.argv[2] === PARENT_EXIT_HELPER_FLAG) {
  const abrainHomeArg = process.argv[3];
  const busyMs = Number(process.argv[4] || 20_000);
  if (!abrainHomeArg || !path.isAbsolute(abrainHomeArg)) {
    fs.writeSync(2, "parent-exit-helper requires absolute abrainHome\n");
    process.exit(2);
  }
  if (!Number.isSafeInteger(busyMs) || busyMs < 1_000 || busyMs > 30_000) {
    fs.writeSync(2, "parent-exit-helper busyMs out of bounds\n");
    process.exit(2);
  }
  const jitiHelper = createJiti(repoRoot, { interopDefault: true });
  const outcomeHelper = jitiHelper(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));
  outcomeHelper.__TEST_setOutcomeEvidenceIsolatedRebuildControls({ childBusyMs: busyMs });
  // Fire-and-forget: do not await. Child is intentionally still busy when we exit.
  void outcomeHelper.rebuildOutcomeEvidenceIndexIsolated(abrainHomeArg);
  const deadline = Date.now() + 5_000;
  let workerPid = 0;
  while (Date.now() < deadline) {
    const pids = outcomeHelper.__TEST_getOutcomeEvidenceIsolatedRebuildChildPids();
    if (pids.length > 0 && typeof pids[0] === "number" && pids[0] > 0) {
      workerPid = pids[0];
      break;
    }
    // Small busy wait — avoid introducing a referenced timer that could race exit.
    const spinUntil = Date.now() + 10;
    while (Date.now() < spinUntil) { /* spin */ }
  }
  if (!(workerPid > 0)) {
    fs.writeSync(2, "parent-exit-helper failed to observe worker pid\n");
    process.exit(3);
  }
  fs.writeSync(1, `${JSON.stringify({
    schema_version: PARENT_EXIT_HELPER_SCHEMA,
    status: "child_spawned_exiting",
    parent_pid: process.pid,
    worker_pid: workerPid,
    busy_ms: busyMs,
  })}\n`);
  // Normal exit path (not SIGKILL of self): must run the shared exit hook.
  process.exit(0);
}

const jiti = createJiti(repoRoot, { interopDefault: true });
const outcome = jiti(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function pidAlive(pid) {
  if (!(typeof pid === "number" && pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} not satisfied within ${timeoutMs}ms`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-outcome-index-isolation-"));
const abrainHome = path.join(root, "abrain");
const projectRoot = path.join(root, "project");
fs.mkdirSync(abrainHome, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });

const toolCall = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const assistantCalls = (calls) => ({ role: "assistant", content: calls });
const toolResult = (id, name, content, details = undefined, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content,
  ...(details ? { details } : {}),
  isError,
  timestamp: "2026-07-24T04:00:00.000Z",
});

try {
  await check("live collector awaits isolated child rebuild and index converges before return", async () => {
    const branch = [
      assistantCalls([
        toolCall("mem-1", "memory_search", { query: "iso" }),
        toolCall("test-1", "bash", { command: "npm test" }),
      ]),
      toolResult("mem-1", "memory_search", JSON.stringify({ results: [{ slug: "iso-memory" }] })),
      toolResult("test-1", "bash", "ok", { exitCode: 0 }),
      { role: "assistant", content: "```memory-footnote\nslug: iso-memory\n```" },
    ];
    const first = await outcome.collectAndAppendOutcomeEvidence({
      abrainHome,
      projectRoot,
      sessionId: "session-iso",
      turnId: "1",
      branch,
    });
    assert(first.errors.length === 0, JSON.stringify(first));
    assert(first.exposures.length === 1 && first.outcomes.length === 1 && first.rejudges.length === 1, JSON.stringify(first));
    const rows = outcome.readOutcomeEvidenceIndex(abrainHome);
    assert(rows.length === 3, `expected converged index rows=3, got ${rows.length}`);
    assert(rows.some((row) => row.event_id === first.outcomes[0]), "outcome missing from derived index after live await");
  });

  await check("isolated rebuild runs in a child process with structured result", async () => {
    outcome.__TEST_setOutcomeEvidenceIsolatedRebuildControls({});
    const rebuilt = await outcome.rebuildOutcomeEvidenceIndexIsolated(abrainHome);
    assert(rebuilt.mode === "child", JSON.stringify(rebuilt));
    assert(rebuilt.ok === true, JSON.stringify(rebuilt));
    assert(typeof rebuilt.child_pid === "number" && rebuilt.child_pid > 0, `missing child pid: ${JSON.stringify(rebuilt)}`);
    assert(rebuilt.child_pid !== process.pid, `child pid must differ from parent: ${rebuilt.child_pid}`);
    assert(typeof rebuilt.wall_time_ms === "number" && rebuilt.wall_time_ms >= 0, JSON.stringify(rebuilt));
    assert(typeof rebuilt.candidates === "number" && rebuilt.candidates >= 3, JSON.stringify(rebuilt));
    assert(rebuilt.rows >= 3, JSON.stringify(rebuilt));
    assert(typeof rebuilt.stderr === "string", "stderr field required");
    assert(rebuilt.exit_code === 0, JSON.stringify(rebuilt));
  });

  await check("same abrainHome concurrent isolated rebuilds singleflight-merge to one child", async () => {
    outcome.__TEST_setOutcomeEvidenceIsolatedRebuildControls({ childBusyMs: 400 });
    const p1 = outcome.rebuildOutcomeEvidenceIndexIsolated(abrainHome);
    const p2 = outcome.rebuildOutcomeEvidenceIndexIsolated(abrainHome);
    assert(p1 === p2, "same-home concurrent calls must share one Promise (process-global singleflight)");
    const [r1, r2] = await Promise.all([p1, p2]);
    assert(r1 === r2, "singleflight must resolve to the same result object identity for shared promise");
    assert(r1.ok && r2.ok, JSON.stringify({ r1, r2 }));
    assert(r1.child_pid === r2.child_pid && typeof r1.child_pid === "number", "shared flight must report one child pid");
    outcome.__TEST_setOutcomeEvidenceIsolatedRebuildControls({});
  });

  await check("isolated rebuild errors are structured and visible (never throw)", async () => {
    outcome.__TEST_setOutcomeEvidenceIsolatedRebuildControls({});
    // Symlink abrainHome is rejected by the hardened walk; proves child returns
    // structured ok:false rather than rejecting the parent Promise.
    const target = path.join(root, "symlink-target");
    const linkedHome = path.join(root, "symlink-abrain-home");
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, linkedHome);
    const rebuilt = await outcome.rebuildOutcomeEvidenceIndexIsolated(linkedHome);
    assert(rebuilt.mode === "child", JSON.stringify(rebuilt));
    assert(rebuilt.ok === false, `symlink home must fail closed: ${JSON.stringify(rebuilt)}`);
    assert(typeof rebuilt.error === "string" && rebuilt.error.includes("symlink_rejected"), `error not visible: ${JSON.stringify(rebuilt)}`);
    assert(rebuilt.rows === 0 && rebuilt.candidates === 0, JSON.stringify(rebuilt));
    assert(typeof rebuilt.child_pid === "number" && rebuilt.child_pid > 0, "failed child should still report pid");
    // Promise must settle as resolved (not rejected) — reaching here is the proof.
  });

  await check("parent event loop keeps ticking while isolated child rebuild runs", async () => {
    outcome.__TEST_setOutcomeEvidenceIsolatedRebuildControls({ childBusyMs: 500 });
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    // Keep the ticker itself from being the only proof: also setImmediate gate.
    let gates = 0;
    let gating = true;
    const gate = () => {
      if (!gating) return;
      gates += 1;
      setImmediate(gate);
    };
    setImmediate(gate);
    const started = Date.now();
    const rebuilt = await outcome.rebuildOutcomeEvidenceIndexIsolated(abrainHome);
    const elapsed = Date.now() - started;
    gating = false;
    clearInterval(ticker);
    outcome.__TEST_setOutcomeEvidenceIsolatedRebuildControls({});
    assert(rebuilt.ok, JSON.stringify(rebuilt));
    assert(elapsed >= 400, `child busy should dominate wall time, elapsed=${elapsed}`);
    assert(ticks >= 8, `event-loop ticker frozen during rebuild: ticks=${ticks}, elapsed=${elapsed}`);
    assert(gates >= 8, `event-loop setImmediate gate frozen during rebuild: gates=${gates}`);
    console.log(`        event-loop ticks=${ticks} gates=${gates} elapsed_ms=${elapsed} child_pid=${rebuilt.child_pid}`);
  });

  await check("sync rebuild API remains available for explicit CLI/tests", async () => {
    const sync = outcome.rebuildOutcomeEvidenceIndex(abrainHome);
    assert(sync.ok === true, JSON.stringify(sync));
    assert(typeof sync.candidates === "number", "sync result must report candidates");
    assert(sync.rows >= 3, JSON.stringify(sync));
  });

  await check("bare top-level await settles without suite keepalive and exits 0", async () => {
    // Nested process has no setInterval keepalive — only the awaited isolated rebuild.
    // Must complete and exit 0 (not Node's unsettled-TLA exit 13).
    const helperHome = path.join(root, "bare-tla-abrain");
    fs.mkdirSync(helperHome, { recursive: true });
    // Seed one legal outcome so rebuild has real work and still succeeds.
    const seed = await outcome.appendAttributedIndependentOutcomeFixture({
      abrainHome: helperHome,
      projectRoot,
      targetSlug: "bare-tla-memory",
      producerNonce: "bare-tla-seed",
    });
    assert(seed.ok && seed.eventId, `seed fixture failed: ${JSON.stringify(seed)}`);
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [selfPath, BARE_TLA_HELPER_FLAG, helperHome],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const close = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code, signal) => resolve({ code, signal, error: null }));
    });
    const elapsed = Date.now() - started;
    assert(!close.error, `bare-tla helper spawn failed: ${close.error}`);
    assert(close.code === 0, `bare-tla helper exit code=${close.code} signal=${close.signal} stderr=${stderr.slice(0, 400)} stdout=${stdout.slice(0, 400)}`);
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
    let report;
    try { report = JSON.parse(line); }
    catch {
      throw new Error(`bare-tla helper stdout not structured JSON: ${JSON.stringify({ stdout, stderr })}`);
    }
    assert(report.schema_version === BARE_TLA_HELPER_SCHEMA, JSON.stringify(report));
    assert(report.status === "await_settled", JSON.stringify(report));
    assert(report.ok === true, JSON.stringify(report));
    assert(report.mode === "child", JSON.stringify(report));
    assert(typeof report.child_pid === "number" && report.child_pid > 0, JSON.stringify(report));
    assert(report.exit_code === 0, JSON.stringify(report));
    console.log(`        bare_tla_elapsed_ms=${elapsed} child_pid=${report.child_pid} rows=${report.rows}`);
  });

  await check("parent normal exit kills still-running isolated rebuild child quickly", async () => {
    // Independent nested parent process: long child busy work, parent exits without
    // awaiting. Assert parent returns fast AND the reported worker pid is dead.
    const busyMs = 20_000;
    const helperHome = path.join(root, "parent-exit-abrain");
    fs.mkdirSync(helperHome, { recursive: true });
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [selfPath, PARENT_EXIT_HELPER_FLAG, helperHome, String(busyMs)],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const close = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code, signal) => resolve({ code, signal, error: null }));
    });
    const parentElapsed = Date.now() - started;
    assert(!close.error, `helper spawn failed: ${close.error}`);
    assert(close.code === 0, `helper exit code=${close.code} signal=${close.signal} stderr=${stderr.slice(0, 400)}`);
    // Parent must not wait for the 20s busy child (process.exit + exit hook path).
    assert(parentElapsed < 8_000, `parent did not exit quickly: elapsed_ms=${parentElapsed} busy_ms=${busyMs}`);
    assert(parentElapsed < busyMs / 2, `parent elapsed ${parentElapsed}ms not clearly below busy ${busyMs}ms`);
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
    let report;
    try { report = JSON.parse(line); }
    catch {
      throw new Error(`helper stdout not structured JSON: ${JSON.stringify({ stdout, stderr })}`);
    }
    assert(report.schema_version === PARENT_EXIT_HELPER_SCHEMA, JSON.stringify(report));
    assert(report.status === "child_spawned_exiting", JSON.stringify(report));
    assert(typeof report.worker_pid === "number" && report.worker_pid > 0, JSON.stringify(report));
    assert(report.worker_pid !== process.pid && report.worker_pid !== child.pid, JSON.stringify(report));
    // SIGKILL is async from the OS view; poll briefly, avoid fixed sleep races.
    const deadAfterMs = await waitUntil(() => !pidAlive(report.worker_pid), 2_000, `worker pid ${report.worker_pid} death`);
    assert(!pidAlive(report.worker_pid), `worker pid ${report.worker_pid} still alive after parent exit`);
    console.log(`        parent_elapsed_ms=${parentElapsed} worker_pid=${report.worker_pid} worker_dead_after_ms=${deadAfterMs}`);
  });
} finally {
  outcome.__TEST_setOutcomeEvidenceIsolatedRebuildControls({});
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nTotal: ${passed + failures.length}  Passed: ${passed}  Failed: ${failures.length}`);
if (failures.length) process.exit(1);
