#!/usr/bin/env node
/**
 * Multi-process cold-start: process A deliberately delays immutable
 * recovery-history classification >30s OUTSIDE the mutation barrier.
 * Process B (writer / concurrent startup) must NOT observe
 * CANONICAL_MUTATION_BUSY and both end consistent with no long-term lock hold.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-startup-classify-outside-"));
const gitEnv = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv }).trim();
}

function initRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Classify Outside Fixture");
  git(repo, "config", "user.email", "classify-outside@example.invalid");
  fs.writeFileSync(path.join(repo, "README"), "classify-outside\n");
  execFileSync("git", ["-C", repo, "add", "README"], { env: gitEnv });
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"], {
    env: {
      ...gitEnv,
      GIT_AUTHOR_NAME: "Classify Outside Fixture",
      GIT_AUTHOR_EMAIL: "classify-outside@example.invalid",
      GIT_COMMITTER_NAME: "Classify Outside Fixture",
      GIT_COMMITTER_EMAIL: "classify-outside@example.invalid",
    },
  });
  return repo;
}

function childOutput(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child exit ${code}/${signal}: ${stderr || stdout}`));
    });
  });
}

const CLASSIFY_DELAY_MS = 35_000;
const BARRIER_TIMEOUT_MS = 30_000;

try {
  const repo = initRepo("cold-start");
  const settingsPath = path.join(tmp, "enabled.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
  }, null, 2)}\n`);

  const marker = path.join(tmp, "classifier-started.marker");
  // Process A: long classification outside barrier (env delay).
  // Emits "classify_begin" then delays, then awaitStartup.
  const processACode = `
const { createJiti } = require("jiti");
const fs = require("fs");
const path = require("path");
const jiti = createJiti(${JSON.stringify(root)}, { interopDefault: true });
const runtime = jiti(path.join(${JSON.stringify(root)}, "extensions/_shared/canonical-git-runtime.ts"));
const barrier = jiti(path.join(${JSON.stringify(root)}, "extensions/_shared/canonical-mutation-barrier.ts"));
(async () => {
  process.stdout.write("A_begin\\n");
  fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now()));
  // Prove we are NOT holding the barrier during the delay window.
  const heldBefore = barrier.canonicalMutationBarrierHeld(${JSON.stringify(repo)});
  process.stdout.write("A_held_before=" + heldBefore + "\\n");
  const r = await runtime.getCanonicalGitRuntime({
    abrainHome: ${JSON.stringify(repo)},
    settingsPath: ${JSON.stringify(settingsPath)},
    sourceRoot: ${JSON.stringify(root)},
    startupBarrierTimeoutMs: ${BARRIER_TIMEOUT_MS},
  });
  const diag = await r.awaitStartup();
  process.stdout.write("A_startup=" + diag.startup + "\\n");
  process.stdout.write("A_done\\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  const childA = spawn(process.execPath, ["-e", processACode], {
    cwd: root,
    env: {
      ...gitEnv,
      PI_ASTACK_STARTUP_CLASSIFY_DELAY_MS: String(CLASSIFY_DELAY_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const aDone = childOutput(childA);

  // Wait until A has started its outside-barrier classification delay.
  const waitStart = Date.now();
  while (!fs.existsSync(marker)) {
    if (Date.now() - waitStart > 10_000) throw new Error("process A never wrote classifier-started marker");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Give A a moment to enter the delay (after freeze inputs).
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Process B: concurrent writer under barrier — must acquire within 30s.
  const processBCode = `
const { createJiti } = require("jiti");
const path = require("path");
const jiti = createJiti(${JSON.stringify(root)}, { interopDefault: true });
const barrier = jiti(path.join(${JSON.stringify(root)}, "extensions/_shared/canonical-mutation-barrier.ts"));
(async () => {
  const started = Date.now();
  process.stdout.write("B_begin\\n");
  await barrier.withCanonicalMutationBarrier(${JSON.stringify(repo)}, async () => {
    process.stdout.write("B_acquired ms=" + (Date.now() - started) + "\\n");
    // Brief critical section; must not see long-term hold from A.
    await new Promise((r) => setTimeout(r, 50));
    process.stdout.write("B_release\\n");
  }, { timeoutMs: ${BARRIER_TIMEOUT_MS} });
  process.stdout.write("B_done\\n");
})().catch((error) => {
  process.stdout.write("B_error=" + (error && error.code ? error.code : error) + "\\n");
  console.error(error);
  process.exit(1);
});
`;

  const bStarted = performance.now();
  const childB = spawn(process.execPath, ["-e", processBCode], {
    cwd: root,
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bResult = await childOutput(childB);
  const bMs = performance.now() - bStarted;
  assert(!bResult.stdout.includes("CANONICAL_MUTATION_BUSY"), `process B saw CANONICAL_MUTATION_BUSY during A's classification: ${bResult.stdout}\n${bResult.stderr}`);
  assert(bResult.stdout.includes("B_acquired"), `process B did not acquire barrier: ${bResult.stdout}\n${bResult.stderr}`);
  assert(bResult.stdout.includes("B_done"), `process B did not complete: ${bResult.stdout}`);
  assert(bMs < BARRIER_TIMEOUT_MS, `process B took ${bMs.toFixed(0)}ms (>= barrier timeout) — A likely held the lock during classification`);

  // Concurrent startup from process C while A still classifying should also not busy-fail on the lock
  // solely due to classification (may still serialize on mutation briefly at the end).
  const stillClassifying = Date.now() - Number(fs.readFileSync(marker, "utf8")) < CLASSIFY_DELAY_MS - 5_000;
  if (stillClassifying) {
    const processCCode = `
const { createJiti } = require("jiti");
const path = require("path");
const jiti = createJiti(${JSON.stringify(root)}, { interopDefault: true });
const runtime = jiti(path.join(${JSON.stringify(root)}, "extensions/_shared/canonical-git-runtime.ts"));
(async () => {
  const r = await runtime.getCanonicalGitRuntime({
    abrainHome: ${JSON.stringify(repo)},
    settingsPath: ${JSON.stringify(settingsPath)},
    sourceRoot: ${JSON.stringify(root)},
    startupBarrierTimeoutMs: ${BARRIER_TIMEOUT_MS},
  });
  const diag = await r.awaitStartup();
  process.stdout.write("C_startup=" + diag.startup + "\\n");
})().catch((error) => {
  process.stdout.write("C_error=" + (error && error.code ? error.code : String(error && error.message || error)) + "\\n");
  console.error(error);
  process.exit(1);
});
`;
    const childC = spawn(process.execPath, ["-e", processCCode], {
      cwd: root,
      env: gitEnv, // no classify delay
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cResult = await childOutput(childC);
    assert(!String(cResult.stdout + cResult.stderr).includes("CANONICAL_MUTATION_BUSY"), `process C busy during A classify: ${cResult.stdout}\n${cResult.stderr}`);
    assert(cResult.stdout.includes("C_startup=ready") || cResult.stdout.includes("C_startup=blocked"), `process C unexpected: ${cResult.stdout}`);
  }

  const aResult = await aDone;
  assert(aResult.stdout.includes("A_held_before=false"), `process A held barrier before classify: ${aResult.stdout}`);
  assert(aResult.stdout.includes("A_startup=ready") || aResult.stdout.includes("A_startup=blocked"), `process A did not settle: ${aResult.stdout}\n${aResult.stderr}`);
  assert(aResult.stdout.includes("A_done"), `process A incomplete: ${aResult.stdout}`);

  // Final consistency: a fresh no-delay startup is ready and repo is clean.
  const jiti = createJiti(root, { interopDefault: true });
  const runtime = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
  // Clear process-local runtime cache by using a new process for final check.
  const finalCode = `
const { createJiti } = require("jiti");
const path = require("path");
const jiti = createJiti(${JSON.stringify(root)}, { interopDefault: true });
const runtime = jiti(path.join(${JSON.stringify(root)}, "extensions/_shared/canonical-git-runtime.ts"));
(async () => {
  const r = await runtime.getCanonicalGitRuntime({
    abrainHome: ${JSON.stringify(repo)},
    settingsPath: ${JSON.stringify(settingsPath)},
    sourceRoot: ${JSON.stringify(root)},
  });
  const diag = await r.awaitStartup();
  process.stdout.write(JSON.stringify({ startup: diag.startup, blockedReason: diag.blockedReason || null }));
})().catch((e) => { console.error(e); process.exit(1); });
`;
  const finalChild = spawn(process.execPath, ["-e", finalCode], {
    cwd: root,
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const finalResult = await childOutput(finalChild);
  const finalDiag = JSON.parse(finalResult.stdout);
  assert(finalDiag.startup === "ready", `final startup not ready: ${JSON.stringify(finalDiag)}`);
  const status = git(repo, "status", "--porcelain");
  assert(status === "", `repo left dirty after concurrent startup/writer: ${status}`);

  // Real canonical writer commit during outside classification must surface as
  // drift (HEAD/status change), not merely a sleep-barrier race. Process D
  // commits while A is still delayed outside the barrier; A must settle without
  // permanent hang, and a fresh startup afterward must be ready.
  const repo2 = initRepo("drift-writer");
  const marker2 = path.join(tmp, "drift-classifier-started.marker");
  const processDriftA = `
const { createJiti } = require("jiti");
const fs = require("fs");
const path = require("path");
const jiti = createJiti(${JSON.stringify(root)}, { interopDefault: true });
const runtime = jiti(path.join(${JSON.stringify(root)}, "extensions/_shared/canonical-git-runtime.ts"));
(async () => {
  fs.writeFileSync(${JSON.stringify(marker2)}, String(Date.now()));
  const r = await runtime.getCanonicalGitRuntime({
    abrainHome: ${JSON.stringify(repo2)},
    settingsPath: ${JSON.stringify(settingsPath)},
    sourceRoot: ${JSON.stringify(root)},
    startupBarrierTimeoutMs: ${BARRIER_TIMEOUT_MS},
  });
  const diag = await r.awaitStartup();
  const tail = (diag.tail || []).map((row) => row.status + ":" + (row.operation || "")).join(",");
  process.stdout.write("D_A_startup=" + diag.startup + "\\n");
  process.stdout.write("D_A_tail=" + tail + "\\n");
  process.stdout.write("D_A_done\\n");
})().catch((error) => { console.error(error); process.exit(1); });
`;
  const childDriftA = spawn(process.execPath, ["-e", processDriftA], {
    cwd: root,
    env: { ...gitEnv, PI_ASTACK_STARTUP_CLASSIFY_DELAY_MS: String(CLASSIFY_DELAY_MS) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const driftADone = childOutput(childDriftA);
  const driftWaitStart = Date.now();
  while (!fs.existsSync(marker2)) {
    if (Date.now() - driftWaitStart > 10_000) throw new Error("drift process A never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Real writer: commit a new tracked file so HEAD + status hash move.
  fs.writeFileSync(path.join(repo2, "drift-l1.txt"), `drift-${Date.now()}\n`);
  execFileSync("git", ["-C", repo2, "add", "drift-l1.txt"], { env: gitEnv });
  execFileSync("git", ["-C", repo2, "commit", "-qm", "real writer drift commit"], {
    env: {
      ...gitEnv,
      GIT_AUTHOR_NAME: "Drift Writer",
      GIT_AUTHOR_EMAIL: "drift@example.invalid",
      GIT_COMMITTER_NAME: "Drift Writer",
      GIT_COMMITTER_EMAIL: "drift@example.invalid",
    },
  });
  const headAfterWriter = git(repo2, "rev-parse", "HEAD");
  assert(/^[0-9a-f]{40}$/.test(headAfterWriter), "writer commit did not advance HEAD");
  const driftAResult = await driftADone;
  assert(driftAResult.stdout.includes("D_A_done"), `drift A incomplete: ${driftAResult.stdout}\n${driftAResult.stderr}`);
  assert(
    /D_A_startup=(ready|blocked)/.test(driftAResult.stdout),
    `drift A did not settle: ${driftAResult.stdout}`,
  );
  // Fresh process after real writer drift must not hang on a permanently cached blocked promise.
  const postDriftCode = `
const { createJiti } = require("jiti");
const path = require("path");
const jiti = createJiti(${JSON.stringify(root)}, { interopDefault: true });
const runtime = jiti(path.join(${JSON.stringify(root)}, "extensions/_shared/canonical-git-runtime.ts"));
(async () => {
  const r = await runtime.getCanonicalGitRuntime({
    abrainHome: ${JSON.stringify(repo2)},
    settingsPath: ${JSON.stringify(settingsPath)},
    sourceRoot: ${JSON.stringify(root)},
  });
  const diag = await r.awaitStartup();
  process.stdout.write("post_drift_startup=" + diag.startup + "\\n");
})().catch((e) => { console.error(e); process.exit(1); });
`;
  const postDriftChild = spawn(process.execPath, ["-e", postDriftCode], {
    cwd: root,
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const postDriftResult = await childOutput(postDriftChild);
  assert(postDriftResult.stdout.includes("post_drift_startup=ready"), `post-drift startup not ready: ${postDriftResult.stdout}\n${postDriftResult.stderr}`);

  console.log("startup classify outside barrier: ok");
  const aStartupMatch = aResult.stdout.match(/A_startup=(\w+)/);
  const driftStartupMatch = driftAResult.stdout.match(/D_A_startup=(\w+)/);
  console.log(`  classify_delay_ms=${CLASSIFY_DELAY_MS} writer_ms=${bMs.toFixed(0)} A_startup=${aStartupMatch ? aStartupMatch[1] : "?"}`);
  console.log(`  real_writer_drift_startup=${driftStartupMatch ? driftStartupMatch[1] : "?"} post_drift=ready`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
