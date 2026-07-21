#!/usr/bin/env node
/** ADR0040 production stable-view publisher smoke. All writes stay under /tmp. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { preparePropositionPolicyStableViewFixture } from "./_proposition-policy-stable-view-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const contract = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-contract.ts"));

if (process.env.PI_STABLE_PUBLISHER_CHILD) {
  await runChild();
  process.exit(0);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-production-publisher-"));
const fullSource = path.join(tmpRoot, "source-full");
const emptySource = path.join(tmpRoot, "source-empty");
const FIVE = ["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"];
const EVENT_IDS = [
  "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6",
  "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
  "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585",
];
let passed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

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

function eventPath(home, eventId) {
  return path.join(home, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}

async function copySources() {
  await preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: fullSource });
  fs.cpSync(fullSource, emptySource, { recursive: true });
  fs.unlinkSync(eventPath(emptySource, EVENT_IDS[0]));
}

function makeProductionSandbox(label) {
  const home = path.join(tmpRoot, label);
  fs.mkdirSync(path.join(home, ".state", "sediment"), { recursive: true, mode: 0o700 });
  return home;
}

function stableRoot(home) {
  return path.join(home, ...publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"));
}

function latestValue(home) {
  return fs.readlinkSync(path.join(stableRoot(home), "latest"));
}

function bundleDir(home, value = latestValue(home)) {
  return path.join(stableRoot(home), value);
}

function assertCompleteBundle(directory) {
  assert(fs.lstatSync(directory).isDirectory(), "bundle is not a directory");
  assert(JSON.stringify(fs.readdirSync(directory).sort()) === JSON.stringify([...FIVE].sort()), "bundle is not exact all-five");
}

function noTemps(home) {
  const root = stableRoot(home);
  if (!fs.existsSync(root)) return true;
  return fs.readdirSync(root).every((name) => !name.startsWith(".staging-") && !name.startsWith(".latest-"));
}

function child(env, waitForReady = false) {
  const proc = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: { ...process.env, PI_STABLE_PUBLISHER_CHILD: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => proc.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  const ready = waitForReady
    ? new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`child READY timeout: ${stdout} ${stderr}`)), 10_000);
      const poll = () => {
        if (stdout.includes("READY\n")) { clearTimeout(timeout); resolve(); }
        else if (proc.exitCode !== null) { clearTimeout(timeout); reject(new Error(`child exited before READY: ${stdout} ${stderr}`)); }
        else setTimeout(poll, 10);
      };
      poll();
    })
    : Promise.resolve();
  return { proc, closed, ready };
}

async function sandboxPublish(sourceAbrainHome, targetAbrainHome, hooks) {
  return publisher.__TEST.publishSandboxProductionForTests({ sourceAbrainHome, targetAbrainHome, repoRoot, ...(hooks ? { hooks } : {}) });
}

console.log("ADR0040 production full-flip publisher smoke");
await copySources();

try {
  let fullBundle;
  await check("deterministic production bundle has honest sole-source authority and exact five artifacts", async () => {
    const first = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: fullSource, repoRoot });
    const second = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: fullSource, repoRoot });
    fullBundle = first;
    assert(first.bundle_hash === second.bundle_hash, "bundle identity is nondeterministic");
    assert(FIVE.every((name) => first.artifacts[name] === second.artifacts[name]), "bundle bytes are nondeterministic");
    assert(first.manifest.authority === publisher.PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORITY, "publication authority is not production sole-source");
    const inner = JSON.parse(first.artifacts["manifest.json"]);
    assert(inner.authority === publisher.PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORITY, "outer manifest authority drifted");
    assert(contract.PROPOSITION_POLICY_STABLE_VIEW_COMPILER_MANIFEST_AUTHORITY.includes("sole_persisted_main_session"), "compiler authority remains sandbox-only");
    assert(JSON.parse(first.artifacts["view.json"]).items.length === 1, "full source is not one item");
    publisher.validatePropositionPolicyStableViewBundle(first);
  });

  await check("preview remains sandbox-only and production materialization has no bypass", async () => {
    const target = makeProductionSandbox("preview");
    const preview = await publisher.publishPropositionPolicyStableView({ mode: "preview", sourceAbrainHome: fullSource, repoRoot, sandboxAbrainHome: target });
    assert(preview.mode === "preview", "preview mode drifted");
    assertCompleteBundle(preview.bundle_directory);
    let error;
    try { publisher.__TEST.materializeBundle({ mode: "production", targetAbrainHome: target, bundle: fullBundle }); } catch (caught) { error = caught; }
    assert(error?.code === "PRODUCTION_LOCK_REQUIRED", `production bypass failed as ${error?.code || error}`);
  });

  await check("LOCK_BUSY aborts before every whole-L1 scan", async () => {
    const target = makeProductionSandbox("busy-before-scan");
    const lockRoot = path.join(target, ".state", "sediment");
    const held = publisher.__TEST.acquireProductionPublicationLock(lockRoot);
    let scanned = false;
    let error;
    try {
      await sandboxPublish(fullSource, target, { afterFirstSourceScan() { scanned = true; } });
    } catch (caught) { error = caught; }
    held.close();
    assert(error?.code === "LOCK_BUSY", `contender failed as ${error?.code || error}`);
    assert(scanned === false, "contender scanned L1 before acquiring the lock");
    assert(!fs.existsSync(stableRoot(target)), "busy contender mutated publication root");
  });

  await check("two production publisher processes have one winner and a clean rerun", async () => {
    const target = makeProductionSandbox("two-process");
    const env = { CHILD_ACTION: "publish", CHILD_SOURCE: fullSource, CHILD_TARGET: target, CHILD_REPO: repoRoot };
    const left = child(env);
    const right = child(env);
    const results = await Promise.all([left.closed, right.closed]);
    const successes = results.filter((row) => row.code === 0 && row.stdout.includes("PUBLISHED"));
    const busy = results.filter((row) => row.code === 73 && row.stderr.includes("LOCK_BUSY"));
    assert(successes.length === 1 && busy.length === 1, `unexpected contender results: ${JSON.stringify(results)}`);
    assertCompleteBundle(bundleDir(target));
    const rerun = await sandboxPublish(fullSource, target);
    assert(rerun.status === "identical" && noTemps(target), "post-contention rerun did not converge cleanly");
  });

  await check("SIGKILL releases the retained OFD lock", async () => {
    const target = makeProductionSandbox("sigkill-lock");
    const lockRoot = path.join(target, ".state", "sediment");
    const holder = child({ CHILD_ACTION: "hold", CHILD_LOCK_ROOT: lockRoot }, true);
    await holder.ready;
    let busy;
    try { publisher.__TEST.acquireProductionPublicationLock(lockRoot); } catch (error) { busy = error; }
    assert(busy?.code === "LOCK_BUSY", "holder did not retain the lock");
    holder.proc.kill("SIGKILL");
    const ended = await holder.closed;
    assert(ended.signal === "SIGKILL", `holder ended by ${ended.signal || ended.code}`);
    const acquired = publisher.__TEST.acquireProductionPublicationLock(lockRoot);
    acquired.close();
  });

  await check("A/B source mismatch aborts before latest mutation", async () => {
    const target = makeProductionSandbox("source-race");
    const removed = eventPath(fullSource, EVENT_IDS[0]);
    const raw = fs.readFileSync(removed);
    let error;
    try {
      await sandboxPublish(fullSource, target, { afterFirstSourceScan() { fs.unlinkSync(removed); } });
    } catch (caught) { error = caught; } finally {
      fs.mkdirSync(path.dirname(removed), { recursive: true });
      fs.writeFileSync(removed, raw);
    }
    assert(error?.code === "SOURCE_RACE", `source race failed as ${error?.code || error}`);
    assert(!fs.existsSync(path.join(stableRoot(target), "latest")), "SOURCE_RACE mutated latest");
  });

  await check("whole-L1 A/B detects an unrelated post-projection inventory addition", async () => {
    const target = makeProductionSandbox("whole-l1-race");
    const unrelatedId = "f".repeat(64);
    const unrelated = eventPath(fullSource, unrelatedId);
    let error;
    try {
      await sandboxPublish(fullSource, target, {
        afterProjectionBeforeSecondSourceScan() {
          fs.mkdirSync(path.dirname(unrelated), { recursive: true });
          fs.writeFileSync(unrelated, "unrelated raw bytes\n");
        },
      });
    } catch (caught) { error = caught; } finally {
      fs.rmSync(unrelated, { force: true });
    }
    assert(error?.code === "SOURCE_RACE", `unrelated whole-L1 race failed as ${error?.code || error}`);
    assert(!fs.existsSync(path.join(stableRoot(target), "latest")), "whole-L1 SOURCE_RACE mutated latest");
  });

  await check("SIGKILL after 0..4 artifact writes leaves partial official staging that every rerun removes and rebuilds", async () => {
    for (let count = 0; count < FIVE.length; count += 1) {
      const target = makeProductionSandbox(`crash-artifact-${count}`);
      const crashed = child({
        CHILD_ACTION: "publish",
        CHILD_SOURCE: fullSource,
        CHILD_TARGET: target,
        CHILD_REPO: repoRoot,
        CHILD_CRASH_ARTIFACT_COUNT: String(count),
      });
      const ended = await crashed.closed;
      assert(ended.signal === "SIGKILL", `artifact ${count} crash signal=${ended.signal || ended.code}`);
      assert(!fs.existsSync(path.join(stableRoot(target), "latest")), `artifact ${count} crash created authority`);
      const stagingNames = fs.readdirSync(stableRoot(target)).filter((name) => name.startsWith(".staging-"));
      assert(stagingNames.length === 1, `artifact ${count} crash staging count=${stagingNames.length}`);
      assert(fs.readdirSync(path.join(stableRoot(target), stagingNames[0])).length === count,
        `artifact ${count} crash left the wrong prefix`);
      const rerun = await sandboxPublish(fullSource, target);
      assert(rerun.status === "created" && noTemps(target), `artifact ${count} rerun did not converge`);
      assertCompleteBundle(rerun.bundle_directory);
      const repeated = await sandboxPublish(fullSource, target);
      assert(repeated.status === "identical" && noTemps(target), `artifact ${count} repeated rerun drifted`);
    }
  });

  await check("old bundle-hash staging and latest residue are owned by the locked namespace and converge after new L1", async () => {
    const stagingTarget = makeProductionSandbox("old-hash-staging");
    const stagingCrash = child({
      CHILD_ACTION: "publish",
      CHILD_SOURCE: emptySource,
      CHILD_TARGET: stagingTarget,
      CHILD_REPO: repoRoot,
      CHILD_CRASH_ARTIFACT_COUNT: "3",
    });
    assert((await stagingCrash.closed).signal === "SIGKILL", "old-hash staging child did not crash");
    const oldStaging = fs.readdirSync(stableRoot(stagingTarget)).find((name) => name.startsWith(".staging-"));
    assert(oldStaging && !oldStaging.includes(fullBundle.bundle_hash), "old-hash staging residue was not distinct from new L1");
    const rebuiltStaging = await sandboxPublish(fullSource, stagingTarget);
    assert(rebuiltStaging.bundle_hash === fullBundle.bundle_hash && noTemps(stagingTarget), "new L1 did not clean old-hash staging");

    const latestTarget = makeProductionSandbox("old-hash-latest");
    const latestCrash = child({
      CHILD_ACTION: "publish",
      CHILD_SOURCE: emptySource,
      CHILD_TARGET: latestTarget,
      CHILD_REPO: repoRoot,
      CHILD_CRASH_POINT: "before_latest_rename",
    });
    assert((await latestCrash.closed).signal === "SIGKILL", "old-hash latest child did not crash");
    const oldLatest = fs.readdirSync(stableRoot(latestTarget)).find((name) => name.startsWith(".latest-"));
    assert(oldLatest, "old-hash latest residue is missing");
    assert(!fs.readlinkSync(path.join(stableRoot(latestTarget), oldLatest)).includes(fullBundle.bundle_hash),
      "old-hash latest residue unexpectedly targets new L1");
    const rebuiltLatest = await sandboxPublish(fullSource, latestTarget);
    assert(rebuiltLatest.bundle_hash === fullBundle.bundle_hash && noTemps(latestTarget), "new L1 did not clean old-hash latest");
    const repeated = await sandboxPublish(fullSource, latestTarget);
    assert(repeated.status === "identical" && noTemps(latestTarget), "post-old-hash rerun did not remain converged");
  });

  await check("official temp names with unsafe types and ordinary foreign entries fail closed", async () => {
    const stagingTarget = makeProductionSandbox("unsafe-staging-type");
    fs.mkdirSync(stableRoot(stagingTarget), { recursive: true });
    const stagingName = `.staging-${"a".repeat(64)}-1-${"b".repeat(16)}`;
    fs.symlinkSync(".", path.join(stableRoot(stagingTarget), stagingName), "dir");
    let stagingError;
    try { await sandboxPublish(fullSource, stagingTarget); } catch (error) { stagingError = error; }
    assert(stagingError?.code === "PUBLICATION_FOREIGN_STATE" && fs.lstatSync(path.join(stableRoot(stagingTarget), stagingName)).isSymbolicLink(),
      "unsafe staging type was removed or accepted");

    const latestTarget = makeProductionSandbox("unsafe-latest-type");
    fs.mkdirSync(stableRoot(latestTarget), { recursive: true });
    const latestName = `.latest-1-${"c".repeat(16)}`;
    fs.writeFileSync(path.join(stableRoot(latestTarget), latestName), "foreign\n");
    let latestError;
    try { await sandboxPublish(fullSource, latestTarget); } catch (error) { latestError = error; }
    assert(latestError?.code === "PUBLICATION_FOREIGN_STATE" && fs.readFileSync(path.join(stableRoot(latestTarget), latestName), "utf8") === "foreign\n",
      "unsafe latest type was removed or accepted");
  });

  await check("crash before latest rename leaves a complete orphan and preserves prior authority", async () => {
    const target = makeProductionSandbox("crash-before-latest");
    const baseline = await sandboxPublish(emptySource, target);
    const baselineLatest = baseline.latest_value;
    const crashed = child({ CHILD_ACTION: "publish", CHILD_SOURCE: fullSource, CHILD_TARGET: target, CHILD_REPO: repoRoot, CHILD_CRASH_POINT: "before_latest_rename" });
    const ended = await crashed.closed;
    assert(ended.signal === "SIGKILL", `crash signal=${ended.signal || ended.code}`);
    assert(latestValue(target) === baselineLatest, "pre-latest crash changed authority");
    const hashes = fs.readdirSync(path.join(stableRoot(target), "bundles"));
    assert(hashes.length === 2, `expected baseline plus orphan, got ${hashes.length}`);
    hashes.forEach((hash) => assertCompleteBundle(path.join(stableRoot(target), "bundles", hash)));
    const rerun = await sandboxPublish(fullSource, target);
    assert(rerun.status === "identical" && rerun.latest_value !== baselineLatest && noTemps(target), "orphan promotion rerun did not converge");
  });

  await check("crash after latest rename can expose only a complete content-addressed authority", async () => {
    const target = makeProductionSandbox("crash-after-latest");
    await sandboxPublish(emptySource, target);
    const crashed = child({ CHILD_ACTION: "publish", CHILD_SOURCE: fullSource, CHILD_TARGET: target, CHILD_REPO: repoRoot, CHILD_CRASH_POINT: "after_latest_rename" });
    const ended = await crashed.closed;
    assert(ended.signal === "SIGKILL", `crash signal=${ended.signal || ended.code}`);
    assertCompleteBundle(bundleDir(target));
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir(target), "manifest.json"), "utf8"));
    assert(latestValue(target) === `bundles/${manifest.bundle_hash}`, "post-rename latest is not content-addressed");
    const rerun = await sandboxPublish(fullSource, target);
    assert(rerun.status === "identical" && noTemps(target), "post-rename recovery did not converge");
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; exclusive lock, double scan, fresh staging, atomic bundle/latest, crash recovery, and sole-source authority verified`);

async function runChild() {
  const action = process.env.CHILD_ACTION;
  if (action === "hold") {
    const lock = publisher.__TEST.acquireProductionPublicationLock(process.env.CHILD_LOCK_ROOT);
    process.stdout.write("READY\n");
    process.on("SIGTERM", () => { lock.close(); process.exit(0); });
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
    return;
  }
  if (action === "publish") {
    try {
      const crashPoint = process.env.CHILD_CRASH_POINT;
      const crashArtifactCount = process.env.CHILD_CRASH_ARTIFACT_COUNT === undefined
        ? undefined
        : Number(process.env.CHILD_CRASH_ARTIFACT_COUNT);
      const hooks = crashPoint || crashArtifactCount !== undefined
        ? {
            atCrashPoint(point) { if (point === crashPoint) process.kill(process.pid, "SIGKILL"); },
            atStagingArtifactCount(count) { if (count === crashArtifactCount) process.kill(process.pid, "SIGKILL"); },
          }
        : undefined;
      const result = await publisher.__TEST.publishSandboxProductionForTests({
        sourceAbrainHome: process.env.CHILD_SOURCE,
        targetAbrainHome: process.env.CHILD_TARGET,
        repoRoot: process.env.CHILD_REPO,
        ...(hooks ? { hooks } : {}),
      });
      process.stdout.write(`PUBLISHED ${result.status} ${result.bundle_hash}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error?.code || "ERROR"}: ${error?.message || error}\n`);
      process.exit(error?.code === "LOCK_BUSY" ? 73 : 74);
    }
  }
  throw new Error(`unknown child action: ${action}`);
}
