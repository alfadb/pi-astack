#!/usr/bin/env node
/** ADR0040 automatic stable-view recovery smoke. Every mutation stays under /tmp. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { preparePropositionPolicyStableViewFixture } from "./_proposition-policy-stable-view-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const recovery = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-recovery.ts"));
const reader = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts"));

if (process.env.PI_STABLE_RECOVERY_LOCK_CHILD === "1") {
  const lock = publisher.__TEST.acquireProductionPublicationLock(path.join(process.env.CHILD_ABRAIN_ROOT, ".state", "sediment"));
  process.stdout.write("READY\n");
  setTimeout(() => { lock.close(); process.exit(0); }, Number(process.env.CHILD_HOLD_MS || 250));
  await new Promise(() => {});
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-stable-recovery-"));
const originalEnv = { HOME: process.env.HOME, ABRAIN_ROOT: process.env.ABRAIN_ROOT };
const FIVE = ["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"];
const EVENT_IDS = [
  "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6",
  "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
  "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585",
];
let passed = 0;
const failures = [];

function assert(value, message) { if (!value) throw new Error(message || "assertion failed"); }
async function check(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL  ${name}\n        ${error?.stack || error}\n`); }
}
function configureRoot(root) {
  process.env.ABRAIN_ROOT = root;
  process.env.HOME = path.dirname(root);
}
async function fixture(label) {
  const root = path.join(tmpRoot, label);
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: root });
  return root;
}
function stableRoot(root) {
  return path.join(root, ...publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"));
}
function eventPath(home, eventId) {
  return path.join(home, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}
function strictRead(root) {
  return reader.readPropositionPolicyStableViewForRuntime({
    abrainHome: root,
    settings: { maxReadBytes: 262144 },
    sessionManager: {
      isPersisted: () => true,
      getSessionId: () => "recovery-smoke",
      getSessionFile: () => path.join(tmpRoot, "never-created.jsonl"),
    },
  });
}
async function expectCode(code, fn) {
  let caught;
  try { await fn(); } catch (error) { caught = error; }
  assert(caught?.code === code, `expected ${code}, got ${caught?.code || caught}`);
}
function spawnLockHolder(root, holdMs = 250) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: { ...process.env, PI_STABLE_RECOVERY_LOCK_CHILD: "1", CHILD_ABRAIN_ROOT: root, CHILD_HOLD_MS: String(holdMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (stdout.includes("READY\n")) return resolve();
      if (child.exitCode !== null) return reject(new Error(`lock holder exited: ${stderr}`));
      if (Date.now() >= deadline) return reject(new Error(`lock holder timeout: ${stdout} ${stderr}`));
      setTimeout(poll, 10);
    };
    poll();
  });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { ready, closed };
}

process.stdout.write("ADR0040 automatic proposition policy stable-view recovery smoke\n");
try {
  await check("missing real-shape stable root schedules without blocking and publishes exact five plus selected_valid", async () => {
    const root = await fixture("missing-root");
    configureRoot(root);
    assert(!fs.existsSync(stableRoot(root)), "fixture unexpectedly has a stable root");
    const started = performance.now();
    const completion = recovery.schedulePropositionPolicyStableViewRecovery({ abrainHome: root, repoRoot });
    const scheduleMs = performance.now() - started;
    assert(scheduleMs < 25, `detached scheduling took ${scheduleMs.toFixed(1)}ms`);
    const result = await completion;
    assert(result.status === "recovered" && result.final_read_reason === "selected_valid", `recovery=${JSON.stringify(result)}`);
    const selected = strictRead(root);
    assert(selected.ok && selected.reason === "selected_valid" && selected.bundleHash === result.bundle_hash, `strict read=${JSON.stringify(selected)}`);
    const bundle = path.join(stableRoot(root), fs.readlinkSync(path.join(stableRoot(root), "latest")));
    assert(JSON.stringify(fs.readdirSync(bundle).sort()) === JSON.stringify([...FIVE].sort()), "published set is not exact five");
    assert(result.audit === "appended", `audit=${result.audit_error || result.audit}`);
    const auditFile = path.join(root, ...recovery.PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_AUDIT_RELATIVE.split("/"));
    const auditRow = JSON.parse(fs.readFileSync(auditFile, "utf8").trim().split("\n")[0]);
    assert(auditRow.schema_version === recovery.PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_AUDIT_SCHEMA
      && auditRow.result_schema_version === result.schema_version, "recovery audit/result schemas are not independently bound");
  });

  await check("same-root recovery is process-singleflight and converges idempotently", async () => {
    const root = await fixture("singleflight");
    configureRoot(root);
    const first = recovery.recoverPropositionPolicyStableView({ abrainHome: root, repoRoot });
    const second = recovery.recoverPropositionPolicyStableView({ abrainHome: root, repoRoot });
    assert(first === second, "same-root in-flight promises differ");
    const [left, right] = await Promise.all([first, second]);
    assert(left === right && left.status === "recovered", `singleflight result=${JSON.stringify(left)}`);
    const rerun = await recovery.recoverPropositionPolicyStableView({ abrainHome: root, repoRoot });
    assert(rerun.status === "already_valid" && rerun.bundle_hash === left.bundle_hash, `rerun=${JSON.stringify(rerun)}`);
  });

  await check("SOURCE_RACE retries are bounded and scheduled failures do not poison later startups", async () => {
    const retryRoot = await fixture("source-race-retry");
    configureRoot(retryRoot);
    try {
      recovery.__TEST.setControls({ childSourceRaceUntilAttempt: 2 });
      const retried = await recovery.recoverPropositionPolicyStableView({
        abrainHome: retryRoot,
        repoRoot,
        sourceRaceMaxRetries: 3,
        sourceRaceBackoffMs: 5,
      });
      assert(retried.status === "recovered" && strictRead(retryRoot).ok, `retried=${JSON.stringify(retried)}`);
    } finally {
      recovery.__TEST.resetControls();
    }

    const scheduledRoot = await fixture("scheduled-source-race-retry");
    configureRoot(scheduledRoot);
    try {
      recovery.__TEST.setControls({ childSourceRaceUntilAttempt: 5 });
      const failed = await recovery.schedulePropositionPolicyStableViewRecovery({
        abrainHome: scheduledRoot,
        repoRoot,
        sourceRaceMaxRetries: 0,
        sourceRaceBackoffMs: 5,
      });
      assert(failed.status === "failed" && failed.error_code === "RECOVERY_SOURCE_RACE_EXHAUSTED", `failed=${JSON.stringify(failed)}`);
      assert(recovery.getPropositionPolicyStableViewRecoveryDiagnostics(scheduledRoot).scheduled === false, "failed scheduled promise remained cached");
      recovery.__TEST.resetControls();
      const repaired = await recovery.schedulePropositionPolicyStableViewRecovery({ abrainHome: scheduledRoot, repoRoot });
      assert(repaired.status === "recovered" && strictRead(scheduledRoot).ok, `repaired=${JSON.stringify(repaired)}`);
    } finally {
      recovery.__TEST.resetControls();
    }
  });

  await check("child compile/publication boundary keeps the parent heartbeat alive and enforces timeout", async () => {
    const heartbeatRoot = await fixture("child-heartbeat");
    configureRoot(heartbeatRoot);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      recovery.__TEST.setControls({ childBusyMs: 500 });
      const result = await recovery.recoverPropositionPolicyStableView({ abrainHome: heartbeatRoot, repoRoot, childTimeoutMs: 30_000 });
      assert(result.status === "recovered", `heartbeat result=${JSON.stringify(result)}`);
      assert(ticks >= 5, `parent heartbeat froze while child was busy; ticks=${ticks}`);
    } finally {
      clearInterval(timer);
      recovery.__TEST.resetControls();
    }

    const timeoutRoot = await fixture("child-timeout");
    configureRoot(timeoutRoot);
    try {
      recovery.__TEST.setControls({ childBusyMs: 2_000 });
      const timedOut = await recovery.recoverPropositionPolicyStableView({ abrainHome: timeoutRoot, repoRoot, childTimeoutMs: 1_000 });
      assert(timedOut.status === "failed" && timedOut.error_code === "RECOVERY_CHILD_TIMEOUT", `timeout=${JSON.stringify(timedOut)}`);
      assert(!strictRead(timeoutRoot).ok, "timed-out child left a selected stable view");
    } finally {
      recovery.__TEST.resetControls();
    }
  });

  await check("post-publication strict read converges when another publisher advances latest", async () => {
    const root = await fixture("post-read-advanced");
    configureRoot(root);
    try {
      recovery.__TEST.setControls({
        async afterChildPublication() {
          fs.unlinkSync(eventPath(root, EVENT_IDS[0]));
          await publisher.publishPropositionPolicyStableView({ mode: "production", sourceAbrainHome: root, repoRoot });
        },
      });
      const result = await recovery.recoverPropositionPolicyStableView({ abrainHome: root, repoRoot });
      const selected = strictRead(root);
      assert(result.status === "contended_converged" && result.reason.includes("latest advanced"), `advanced result=${JSON.stringify(result)}`);
      assert(selected.ok && selected.bundleHash === result.bundle_hash && selected.itemCount === 0, `advanced read=${JSON.stringify(selected)}`);
    } finally {
      recovery.__TEST.resetControls();
    }
  });

  await check("cross-process OFD contention retries without scanning under the held lock", async () => {
    const root = await fixture("contention");
    configureRoot(root);
    const holder = spawnLockHolder(root, 2_000);
    await holder.ready;
    const result = await recovery.recoverPropositionPolicyStableView({
      abrainHome: root,
      repoRoot,
      contentionWaitMs: 5_000,
      contentionPollMs: 20,
    });
    const ended = await holder.closed;
    assert(ended.code === 0, `holder=${JSON.stringify(ended)}`);
    assert(result.status === "recovered" && result.contention_observed === true, `contended result=${JSON.stringify(result)}`);
    assert(strictRead(root).ok, "contended recovery did not converge to strict-valid");
  });

  await check("dynamic HOME and ABRAIN_ROOT derive every production path and reject a wrong source root", async () => {
    const home = path.join(tmpRoot, "dynamic-home");
    const homeRoot = path.join(home, ".abrain");
    await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: homeRoot });
    delete process.env.ABRAIN_ROOT;
    process.env.HOME = home;
    const fromHome = await publisher.publishPropositionPolicyStableView({ mode: "production", sourceAbrainHome: homeRoot, repoRoot });
    assert(fromHome.target_root === stableRoot(homeRoot) && fromHome.latest_symlink.startsWith(homeRoot), "HOME-derived binding differs");

    const explicitRoot = await fixture("dynamic-explicit");
    configureRoot(explicitRoot);
    const explicit = await publisher.publishPropositionPolicyStableView({ mode: "production", sourceAbrainHome: explicitRoot, repoRoot });
    assert(explicit.target_root === stableRoot(explicitRoot), "ABRAIN_ROOT-derived target differs");
    await expectCode("PRODUCTION_ROOT_MISMATCH", () => publisher.publishPropositionPolicyStableView({
      mode: "production",
      sourceAbrainHome: homeRoot,
      repoRoot,
    }));
  });

  await check("symlink production root and preview-to-production alias are rejected", async () => {
    const real = await fixture("real-root");
    const link = path.join(tmpRoot, "root-link");
    fs.symlinkSync(real, link, "dir");
    configureRoot(link);
    let symlinkError;
    try { await publisher.publishPropositionPolicyStableView({ mode: "production", sourceAbrainHome: link, repoRoot }); }
    catch (error) { symlinkError = error; }
    assert(["UNSAFE_ANCESTOR", "UNSAFE_DIRECTORY"].includes(symlinkError?.code), `symlink error=${symlinkError?.code || symlinkError}`);
    configureRoot(real);
    let previewError;
    try { await publisher.publishPropositionPolicyStableView({ mode: "preview", sourceAbrainHome: real, sandboxAbrainHome: real, repoRoot }); }
    catch (error) { previewError = error; }
    assert(previewError?.code === "SANDBOX_REQUIRED", `preview alias=${previewError?.code || previewError}`);
  });

  await check("unsafe latest, root symlink, foreign entry, and content collision remain untouched", async () => {
    const invalidLatest = await fixture("invalid-latest");
    configureRoot(invalidLatest);
    fs.mkdirSync(path.join(stableRoot(invalidLatest), "bundles"), { recursive: true });
    fs.symlinkSync("../../escape", path.join(stableRoot(invalidLatest), "latest"), "dir");
    const latestResult = await recovery.recoverPropositionPolicyStableView({ abrainHome: invalidLatest, repoRoot, contentionWaitMs: 0 });
    assert(latestResult.status === "failed" && fs.readlinkSync(path.join(stableRoot(invalidLatest), "latest")) === "../../escape", "unsafe latest was removed or accepted");

    const rootLink = await fixture("stable-root-link-source");
    const foreign = path.join(tmpRoot, "stable-root-link-foreign");
    fs.mkdirSync(foreign);
    fs.mkdirSync(path.dirname(stableRoot(rootLink)), { recursive: true });
    fs.symlinkSync(foreign, stableRoot(rootLink), "dir");
    configureRoot(rootLink);
    const rootLinkResult = await recovery.recoverPropositionPolicyStableView({ abrainHome: rootLink, repoRoot, contentionWaitMs: 0 });
    assert(rootLinkResult.status === "failed" && fs.lstatSync(stableRoot(rootLink)).isSymbolicLink(), "stable root symlink was removed or accepted");

    const foreignRoot = await fixture("foreign-entry");
    configureRoot(foreignRoot);
    fs.mkdirSync(stableRoot(foreignRoot), { recursive: true });
    fs.writeFileSync(path.join(stableRoot(foreignRoot), "foreign"), "hostile\n");
    const foreignResult = await recovery.recoverPropositionPolicyStableView({ abrainHome: foreignRoot, repoRoot, contentionWaitMs: 0 });
    assert(foreignResult.status === "failed" && fs.readFileSync(path.join(stableRoot(foreignRoot), "foreign"), "utf8") === "hostile\n", "foreign root entry was removed");

    const collisionRoot = await fixture("collision");
    configureRoot(collisionRoot);
    const bundle = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: collisionRoot, repoRoot });
    const collisionDir = path.join(stableRoot(collisionRoot), "bundles", bundle.bundle_hash);
    fs.mkdirSync(collisionDir, { recursive: true });
    fs.writeFileSync(path.join(collisionDir, "manifest.json"), "foreign collision\n");
    const collision = await recovery.recoverPropositionPolicyStableView({ abrainHome: collisionRoot, repoRoot, contentionWaitMs: 0 });
    assert(collision.status === "failed" && fs.readFileSync(path.join(collisionDir, "manifest.json"), "utf8") === "foreign collision\n", "collision residue was removed");
  });

  await check("durable audit and process diagnostics remain hard bounded with already_valid dedupe", async () => {
    const root = path.join(tmpRoot, "missing-root");
    configureRoot(root);
    const auditStatuses = new Set();
    for (let index = 0; index < 70; index += 1) {
      const result = await recovery.recoverPropositionPolicyStableView({ abrainHome: root, repoRoot });
      assert(result.status === "already_valid", `bounded rerun ${index}=${result.status}`);
      auditStatuses.add(result.audit);
    }
    const diagnostics = recovery.getPropositionPolicyStableViewRecoveryDiagnostics(root);
    assert(diagnostics.tail.length === recovery.PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_PROCESS_ROWS, `tail=${diagnostics.tail.length}`);
    const audit = path.join(root, ...recovery.PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_AUDIT_RELATIVE.split("/"));
    assert(fs.statSync(audit).size <= recovery.PROPOSITION_POLICY_STABLE_VIEW_RECOVERY_MAX_AUDIT_BYTES, "audit exceeded hard cap");
    const rows = fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const alreadyValidRows = rows.filter((row) => row.status === "already_valid" && row.abrain_home === root);
    assert(auditStatuses.has("appended") && auditStatuses.has("deduplicated"), `already_valid audit statuses=${[...auditStatuses].join(",")}`);
    assert(alreadyValidRows.length === 1, `already_valid durable rows were not deduplicated: ${alreadyValidRows.length}`);
  });
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.stdout.write("\n");
if (failures.length) {
  process.stdout.write(`FAIL: ${failures.length} failure(s), ${passed} passed\n`);
  process.exit(1);
}
process.stdout.write(`PASS: ${passed} checks; detached canonical-derived recovery, dynamic roots, strict post-read, contention, hostile residue, and bounded diagnostics verified\n`);
