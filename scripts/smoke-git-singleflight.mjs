#!/usr/bin/env node
/**
 * Smoke test: _shared/git-singleflight.ts (PR-1 / P0.6a, ADR 0027 C2').
 *
 * The module serializes git ops that share a repo's .git/index.lock across
 * EXTENSION MODULE COPIES (jiti moduleCache:false loads one copy per
 * importing extension). Checks:
 *
 *   1. same-key ops strictly serialize (op enqueued mid-flight waits)
 *   2. resolved value propagates to the caller
 *   3. a rejection propagates to ITS caller but does not poison the chain
 *   4. different keys do NOT serialize (overlap observed)
 *   5. key normalization: trailing-slash variant shares the chain
 *   6. TWO module copies (simulating jiti moduleCache:false) share ONE
 *      chain via the globalThis singleton — the core PR-1 regression test
 *   7. _gitSingleFlightStats() counts ops across copies
 *   8. git-sync.ts `_queueDepth()` reads the SAME shared state (proves the
 *      abrain ↔ sediment contract end-to-end at module level)
 *   9. deadline-aware waiter returns on budget and never runs after dequeue
 *  10. integration: two concurrent real `git commit` ops on one repo both
 *      succeed and land as two commits (serialized, no index.lock loser)
 *
 * Strategy mirrors smoke-abrain-git-sync.mjs: transpile TS → CJS into a
 * tmpdir, require with node. Offline, deterministic.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let totalChecks = 0;

async function asyncCheck(name, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Compile two independent copies (simulating jiti moduleCache:false) ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-gsf-"));
const sfSource = transpile(path.join(repoRoot, "extensions/_shared/git-singleflight.ts"));
fs.writeFileSync(path.join(tmpDir, "gsf-copy-a.cjs"), sfSource);
fs.writeFileSync(path.join(tmpDir, "gsf-copy-b.cjs"), sfSource);
const copyA = require(path.join(tmpDir, "gsf-copy-a.cjs"));
const copyB = require(path.join(tmpDir, "gsf-copy-b.cjs"));

function makeOp(events, name, ms) {
  return async () => {
    events.push(`${name}-start`);
    await sleep(ms);
    events.push(`${name}-end`);
    return name;
  };
}

console.log("smoke: _shared/git-singleflight (PR-1 / P0.6a)");

// [1] same-key strict serialization
await asyncCheck("[1] same-key ops strictly serialize", async () => {
  const events = [];
  const k = path.join(tmpDir, "repo-serial");
  const p1 = copyA.gitSingleFlight(k, makeOp(events, "a", 60));
  const p2 = copyA.gitSingleFlight(k, makeOp(events, "b", 10));
  await Promise.all([p1, p2]);
  assert(
    JSON.stringify(events) === JSON.stringify(["a-start", "a-end", "b-start", "b-end"]),
    `expected strict a→b order, got ${JSON.stringify(events)}`,
  );
});

// [2] value propagation
await asyncCheck("[2] resolved value propagates", async () => {
  const v = await copyA.gitSingleFlight(path.join(tmpDir, "repo-val"), async () => 42);
  assert(v === 42, `expected 42, got ${v}`);
});

// [3] rejection propagates to its caller but chain survives
await asyncCheck("[3] rejection does not poison the chain", async () => {
  const k = path.join(tmpDir, "repo-reject");
  let rejected = false;
  const p1 = copyA
    .gitSingleFlight(k, async () => {
      throw new Error("boom");
    })
    .catch((e) => {
      rejected = e.message === "boom";
    });
  const p2 = copyA.gitSingleFlight(k, async () => "after-boom");
  const [, v2] = await Promise.all([p1, p2]);
  assert(rejected, "first op's rejection did not propagate to its caller");
  assert(v2 === "after-boom", `second op did not run cleanly after rejection (got ${v2})`);
});

// [4] different keys run concurrently
await asyncCheck("[4] different keys do not serialize", async () => {
  const events = [];
  const p1 = copyA.gitSingleFlight(path.join(tmpDir, "repo-k1"), makeOp(events, "k1", 80));
  await sleep(5); // ensure k1 has started
  const p2 = copyA.gitSingleFlight(path.join(tmpDir, "repo-k2"), makeOp(events, "k2", 10));
  await Promise.all([p1, p2]);
  const k2End = events.indexOf("k2-end");
  const k1End = events.indexOf("k1-end");
  assert(k2End < k1End, `expected k2 to finish during k1, got ${JSON.stringify(events)}`);
});

// [5] key normalization (trailing slash)
await asyncCheck("[5] trailing-slash key variant shares the chain", async () => {
  const events = [];
  const k = path.join(tmpDir, "repo-norm");
  const p1 = copyA.gitSingleFlight(k, makeOp(events, "a", 50));
  const p2 = copyA.gitSingleFlight(k + path.sep, makeOp(events, "b", 10));
  await Promise.all([p1, p2]);
  assert(
    JSON.stringify(events) === JSON.stringify(["a-start", "a-end", "b-start", "b-end"]),
    `expected serialized order across key variants, got ${JSON.stringify(events)}`,
  );
});

// [6] two module copies share one chain (globalThis singleton)
await asyncCheck("[6] jiti-style module copies share ONE chain", async () => {
  assert(copyA !== copyB && copyA.gitSingleFlight !== copyB.gitSingleFlight,
    "test setup broken: expected two distinct module instances");
  const events = [];
  const k = path.join(tmpDir, "repo-cross-copy");
  const p1 = copyA.gitSingleFlight(k, makeOp(events, "a", 60));
  const p2 = copyB.gitSingleFlight(k, makeOp(events, "b", 10));
  await Promise.all([p1, p2]);
  assert(
    JSON.stringify(events) === JSON.stringify(["a-start", "a-end", "b-start", "b-end"]),
    `copies did NOT share the chain (lock would be ineffective across extensions): ${JSON.stringify(events)}`,
  );
});

// [7] stats introspection spans copies
await asyncCheck("[7] _gitSingleFlightStats counts ops across copies", async () => {
  const a = copyA._gitSingleFlightStats();
  const b = copyB._gitSingleFlightStats();
  assert(a.opsStarted > 0, "copyA stats empty");
  assert(a.opsStarted === b.opsStarted, `stats diverge across copies: ${a.opsStarted} vs ${b.opsStarted}`);
  assert(a.keys >= 6, `expected ≥6 distinct keys so far, got ${a.keys}`);
});

// [8] git-sync.ts _queueDepth reads the shared state
await asyncCheck("[8] git-sync._queueDepth() sees ops from other copies", async () => {
  // Bridge git-sync's imports the same way smoke-abrain-git-sync does.
  fs.writeFileSync(
    path.join(tmpDir, "redact.cjs"),
    transpile(path.join(repoRoot, "extensions/abrain/redact.ts")),
  );
  fs.writeFileSync(path.join(tmpDir, "redact.js"), `module.exports = require("./redact.cjs");\n`);
  fs.writeFileSync(
    path.join(tmpDir, "reconcile-gate.cjs"),
    transpile(path.join(repoRoot, "extensions/abrain/reconcile-gate.ts")),
  );
  fs.writeFileSync(path.join(tmpDir, "reconcile-gate.js"), `module.exports = require("./reconcile-gate.cjs");\n`);
  const sharedBridgeDir = path.join(tmpDir, "..", "_shared");
  fs.mkdirSync(sharedBridgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedBridgeDir, "causal-anchor.js"),
    `module.exports = { getCurrentAnchor: () => undefined, spreadAnchor: () => ({}) };\n`,
  );
  fs.writeFileSync(path.join(sharedBridgeDir, "git-singleflight.js"), sfSource);
  fs.writeFileSync(
    path.join(sharedBridgeDir, "device-join-coordinator.js"),
    `module.exports = { prepareDeviceJoin: async () => { throw new Error("unused fixture stub"); }, publishPreparedDeviceJoin: async () => { throw new Error("unused fixture stub"); } };\n`,
  );
  fs.writeFileSync(
    path.join(sharedBridgeDir, "canonical-git-runtime.js"),
    `module.exports = { getCanonicalGitRuntime: async () => { throw new Error("unused fixture stub"); }, resolveCanonicalGitRuntimeSettings: () => ({ enabled: false, valid: true }) };\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "git-sync.cjs"),
    transpile(path.join(repoRoot, "extensions/abrain/git-sync.ts")),
  );
  const gitSync = require(path.join(tmpDir, "git-sync.cjs"));
  // gitSync loaded its own _shared/git-singleflight copy (a THIRD instance);
  // _queueDepth must still report ops that flowed through copyA/copyB.
  const depth = gitSync._queueDepth();
  assert(depth.hasInflight === true, "_queueDepth did not see shared-chain ops from other copies");
});

// [9] a deadline covers queue wait and an expired tail node never runs
await asyncCheck("[9] 700ms holder + 600ms deadline skips expired mutation", async () => {
  const k = path.join(tmpDir, "repo-deadline");
  let holderStarted;
  const started = new Promise((resolve) => { holderStarted = resolve; });
  const holder = copyA.gitSingleFlight(k, async () => {
    holderStarted();
    await sleep(700);
  });
  await started;
  let mutations = 0;
  const deadlineStarted = Date.now();
  let deadlineError;
  try {
    await copyB.gitSingleFlightWithDeadline(k, async () => {
      mutations += 1;
    }, {
      deadlineMs: deadlineStarted + 600,
      now: Date.now,
      onExpired: (detail) => Object.assign(new Error("deadline expired"), { code: "TEST_DEADLINE", detail }),
    });
  } catch (error) {
    deadlineError = error;
  }
  const elapsedMs = Date.now() - deadlineStarted;
  assert(deadlineError?.code === "TEST_DEADLINE", `deadline did not reject with typed error: ${deadlineError}`);
  assert(elapsedMs <= 680, `600ms queue budget overran significantly: ${elapsedMs}ms`);
  await holder;
  await new Promise((resolve) => setImmediate(resolve));
  assert(mutations === 0, `expired tail node executed mutation ${mutations} time(s)`);
});

// [10] integration: concurrent real git commits, both land
await asyncCheck("[10] two concurrent locked git commits both succeed", async () => {
  const repo = path.join(tmpDir, "real-repo");
  fs.mkdirSync(repo, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Smoke", GIT_AUTHOR_EMAIL: "smoke@local",
    GIT_COMMITTER_NAME: "Smoke", GIT_COMMITTER_EMAIL: "smoke@local",
  };
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };
  git(["init", "-q"]);
  git(["commit", "-q", "--allow-empty", "-m", "root"]);
  const commitOp = (name) => async () => {
    fs.writeFileSync(path.join(repo, `${name}.txt`), name);
    await execFileAsync("git", ["-C", repo, "add", "--", `${name}.txt`], { env });
    await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", `add ${name}`], { env });
    return name;
  };
  // copyA = "abrain/git-sync side", copyB = "sediment/writer side"
  const [r1, r2] = await Promise.all([
    copyA.gitSingleFlight(repo, commitOp("from-gitsync")),
    copyB.gitSingleFlight(repo, commitOp("from-writer")),
  ]);
  assert(r1 === "from-gitsync" && r2 === "from-writer", "ops returned wrong values");
  const log = git(["log", "--oneline"]).stdout.trim().split("\n");
  assert(log.length === 3, `expected 3 commits (root + 2), got ${log.length}:\n${log.join("\n")}`);
});

// ── summary ──────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nTotal: ${totalChecks} checks, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
console.log("all ok");
