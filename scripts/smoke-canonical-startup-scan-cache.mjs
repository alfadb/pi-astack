#!/usr/bin/env node
/**
 * Smoke: non-authoritative L1 validated-scan cache, scan mutex BUSY→deferred,
 * last-known-ready fail-closed gate, and progressive resume after budget defer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const runtimeModule = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const barrier = jiti(path.join(root, "extensions/_shared/canonical-mutation-barrier.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const cache = jiti(path.join(root, "extensions/_shared/l1-validated-scan-cache.ts"));
const lockModule = jiti(path.join(root, "extensions/_shared/retained-directory-ofd-lock.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-startup-scan-cache-"));
const settingsPath = path.join(tmp, "enabled.json");
const gitEnv = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  PI_ASTACK_ENABLE_TEST_HOOKS: "1",
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
  git(repo, "config", "user.name", "Scan Cache Fixture");
  git(repo, "config", "user.email", "scan-cache@example.invalid");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(repo, "README"), "startup scan cache\n");
  git(repo, "add", ".gitignore", "README");
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"], {
    env: {
      ...gitEnv,
      GIT_AUTHOR_NAME: "Scan Cache Fixture",
      GIT_AUTHOR_EMAIL: "scan-cache@example.invalid",
      GIT_COMMITTER_NAME: "Scan Cache Fixture",
      GIT_COMMITTER_EMAIL: "scan-cache@example.invalid",
    },
  });
  return repo;
}

function writeKnowledge(repo, seq) {
  const body = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: `2026-07-24T00:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: "scan-cache-fixture",
    device_event_seq: seq,
    producer_nonce: `scan-cache-${seq}`,
    causal_parents: [],
    session_id: "scan-cache-session",
    turn_id: `turn-${seq}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: `sediment:auto_write:created:scan-cache-${seq}` },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug: `scan-cache-${seq}`,
      title: `Scan Cache ${seq}`,
      kind: "knowledge",
      status: "active",
      provenance: "synthetic-smoke",
      confidence: 9,
      compiled_truth: `# Scan Cache ${seq}\n\nSynthetic cache fixture.`,
      trigger_phrases: ["scan cache"],
      derives_from: [],
    },
    sanitizer: { sanitizer_name: "fixture", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "skipped", reason: "fixture" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
  const eventId = l1.canonicalL1BodyHash(body);
  const relative = l1.expectedL1EventRelativePath(eventId);
  const file = path.join(repo, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: eventId,
    body_hash: eventId,
    body,
  })}\n`);
  return { eventId, relative, file };
}

function childResult(child) {
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

function runtimeOptions(repo, extra = {}) {
  return {
    abrainHome: repo,
    settingsPath,
    sourceRoot: root,
    startupBusyBudgetMs: extra.startupBusyBudgetMs ?? 30_000,
    startupBarrierTimeoutMs: extra.startupBarrierTimeoutMs ?? 5_000,
    ...extra,
  };
}

/** Explicit opt-in — production default is cache off. */
function scanCached(repo, extra = {}) {
  return l1.scanWholeL1Validated({ abrainHome: repo, useValidatedCache: true, ...extra });
}

function cacheRoot(repo) {
  return path.join(cache.resolveAbrainHomeRealpath(repo), ".state", "canonical", "l1-validated-scan-cache");
}

fs.writeFileSync(settingsPath, `${JSON.stringify({
  canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
}, null, 2)}\n`);

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("default / useValidatedCache:false never creates .state cache", async () => {
  const repo = initRepo("default-no-cache");
  writeKnowledge(repo, 1);
  const defaultScan = await l1.scanWholeL1Validated({ abrainHome: repo });
  assert(defaultScan.all.length === 1, "default scan failed");
  assert(defaultScan.cacheHits === 0 && defaultScan.cacheMisses === 1, `unexpected default counters: hits=${defaultScan.cacheHits} misses=${defaultScan.cacheMisses}`);
  assert(!fs.existsSync(cacheRoot(repo)), `default scan created cache root: ${cacheRoot(repo)}`);
  assert(!fs.existsSync(path.join(repo, ".state", "canonical", "l1-validated-scan-cache")), "default scan created relative cache root");

  const explicitOff = await l1.scanWholeL1Validated({ abrainHome: repo, useValidatedCache: false });
  assert(explicitOff.all.length === 1, "explicit-off scan failed");
  assert(!fs.existsSync(cacheRoot(repo)), "useValidatedCache:false created cache root");

  // Inventory fingerprint probe must also stay read-only re: cache state.
  await l1.computeL1InventoryFingerprint({ abrainHome: repo });
  assert(!fs.existsSync(cacheRoot(repo)), "computeL1InventoryFingerprint wrote cache state");
});

await check("cold scan populates progressive validated cache under .state", async () => {
  const repo = initRepo("cold-cache");
  // Sub-batch fixture: must be < put batch so close()/flush is required for durability.
  const coldCount = 4;
  assert(
    coldCount < cache.L1_VALIDATED_SCAN_CACHE_PUT_BATCH,
    `cold fixture (${coldCount}) must be smaller than put batch (${cache.L1_VALIDATED_SCAN_CACHE_PUT_BATCH})`,
  );
  for (let i = 1; i <= coldCount; i += 1) writeKnowledge(repo, i);
  const beforeStatus = git(repo, "status", "--porcelain=v1", "-z", "-uall");
  const scan1 = await scanCached(repo);
  assert(scan1.all.length === coldCount, `expected ${coldCount} records, got ${scan1.all.length}`);
  assert(scan1.cacheMisses === coldCount && scan1.cacheHits === 0, `cold counters wrong: ${JSON.stringify({ hits: scan1.cacheHits, misses: scan1.cacheMisses, reval: scan1.cacheRevalidated })}`);
  assert(typeof scan1.inventoryFingerprint === "string" && /^[0-9a-f]{64}$/.test(scan1.inventoryFingerprint), "inventory fingerprint missing");
  const dbPath = cache.l1ValidatedScanCacheDbPath(cache.resolveAbrainHomeRealpath(repo));
  assert(fs.existsSync(dbPath), `cache db missing: ${dbPath}`);
  assert(dbPath.includes(`${path.sep}v2${path.sep}`), `cache path not v2: ${dbPath}`);
  // close() must flush partial put batch so sub-batch cold scans leave complete durable rows.
  const { DatabaseSync } = require("node:sqlite");
  const coldDb = new DatabaseSync(dbPath, { readOnly: true });
  const coldRows = Number(coldDb.prepare("SELECT COUNT(*) AS n FROM validated_files").get().n);
  coldDb.close();
  assert(coldRows === coldCount, `sub-batch cold close left incomplete cache rows: ${coldRows} !== ${coldCount}`);
  assert(git(repo, "status", "--porcelain=v1", "-z", "-uall") === beforeStatus, "cache write polluted statusHash/L1");
  assert(!git(repo, "status", "--porcelain=v1", "--", ".state").trim(), ".state leaked into git status");

  const scan2 = await scanCached(repo);
  assert(scan2.all.length === coldCount, "warm cache lost records");
  assert(scan2.cacheHits === coldCount, `warm expected ${coldCount} hits, got hits=${scan2.cacheHits} misses=${scan2.cacheMisses} reval=${scan2.cacheRevalidated}`);
  assert(scan2.cacheMisses === 0 && scan2.cacheRevalidated === 0, "warm should not miss/revalidate");
  assert(scan2.inventoryFingerprint === scan1.inventoryFingerprint, "warm inventory fingerprint drifted");
  assert(JSON.stringify(scan2.all.map((r) => r.eventId)) === JSON.stringify(scan1.all.map((r) => r.eventId)), "warm event set differs");
});

await check("cache corruption / registry invalidation falls back to revalidation and rebuilds rows", async () => {
  const repo = initRepo("cache-corrupt");
  writeKnowledge(repo, 1);
  writeKnowledge(repo, 2);
  const good = await scanCached(repo);
  assert(good.all.length === 2, "seed scan failed");
  const dbPath = cache.l1ValidatedScanCacheDbPath(cache.resolveAbrainHomeRealpath(repo));
  // Corrupt every envelope payload while keeping rows present.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE validated_files SET envelope_json = ?").run("{\"not\":\"valid-envelope\"}\n");
  // Integrity will also fail after envelope_json change — either path must revalidate.
  db.close();
  const recovered = await scanCached(repo);
  assert(recovered.all.length === 2, `corrupt cache did not revalidate: ${recovered.all.length}`);
  assert(
    recovered.cacheRevalidated + recovered.cacheMisses === 2,
    `corrupt rows not revalidated: hits=${recovered.cacheHits} misses=${recovered.cacheMisses} reval=${recovered.cacheRevalidated}`,
  );
  assert(recovered.inventoryFingerprint === good.inventoryFingerprint, "revalidated inventory fingerprint drifted");

  // Rebuilt rows must be usable on the next warm pass.
  const warmAfterRebuild = await scanCached(repo);
  assert(warmAfterRebuild.all.length === 2, "post-rebuild warm lost rows");
  assert(warmAfterRebuild.cacheHits === 2, `post-rebuild warm expected 2 hits, got ${warmAfterRebuild.cacheHits}`);

  // Validator fingerprint mismatch clears cache header path.
  const db2 = new DatabaseSync(dbPath);
  db2.prepare("UPDATE meta SET value = ? WHERE key = ?").run("stale-validator", "validatorFingerprint");
  // Also force epoch mismatch so old rows cannot satisfy the new header.
  db2.prepare("UPDATE meta SET value = ? WHERE key = ?").run("stale-epoch", "epochHash");
  db2.close();
  const afterValidator = await scanCached(repo);
  assert(afterValidator.all.length === 2, "validator invalidation broke scan");
  assert(afterValidator.cacheMisses === 2, `validator epoch reset should miss: ${afterValidator.cacheMisses}`);
});

await check("file identity drift misses cache and revalidates", async () => {
  const repo = initRepo("identity-drift");
  const written = writeKnowledge(repo, 1);
  const first = await scanCached(repo);
  assert(first.all.length === 1, "seed failed");
  // Same path, same content-addressed name, but rewrite bytes with identical
  // logical envelope after a touch that changes mtime/ctime identity.
  const raw = fs.readFileSync(written.file, "utf8");
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(written.file, raw);
  const second = await scanCached(repo);
  assert(second.all.length === 1 && second.all[0].eventId === first.all[0].eventId, "identity drift revalidation failed");
  assert(second.cacheMisses === 1 || second.cacheRevalidated === 1, `identity drift should miss: hits=${second.cacheHits} misses=${second.cacheMisses}`);
  // Inventory fingerprint must change when mtime/ctime identity changes.
  assert(second.inventoryFingerprint !== first.inventoryFingerprint, "identity drift did not change inventory fingerprint");
});

await check("malformed L1 still fail-closed with cache present", async () => {
  const repo = initRepo("malformed");
  writeKnowledge(repo, 1);
  await scanCached(repo);
  const badRel = l1.expectedL1EventRelativePath("a".repeat(64));
  const badFile = path.join(repo, ...badRel.split("/"));
  fs.mkdirSync(path.dirname(badFile), { recursive: true });
  fs.writeFileSync(badFile, "{not-json\n");
  let code = null;
  try {
    await scanCached(repo);
  } catch (error) {
    code = error.code ?? error.message;
  }
  assert(typeof code === "string" && /L1_/.test(String(code)), `malformed did not fail-closed: ${code}`);
});

await check("budget deferred mid-scan leaves progressive cache; next attempt resumes with cacheHits", async () => {
  const repo = initRepo("budget-resume");
  for (let i = 1; i <= 8; i += 1) writeKnowledge(repo, i);
  // Wall-clock cooperative units: half delay at before_file + half at after_file.
  // Budget must absorb freeze/list overhead + at least one full record write, yet
  // stay below 8 * recordDelayMs so the inventory cannot finish before defer.
  // (60/90 was flaky: freeze variance could exhaust budget at first before_file → 0 rows.)
  const recordDelayMs = 200;
  const budgetMs = 700;
  const code = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
const cache=j(path.join(${JSON.stringify(root)},"extensions/_shared/l1-validated-scan-cache.ts"));
const fs=require("fs");
(async()=>{
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS="1";
  process.env.PI_ASTACK_L1_SCAN_RECORD_DELAY_MS=${JSON.stringify(String(recordDelayMs))};
  const instance=await runtime.getCanonicalGitRuntime({
    abrainHome:${JSON.stringify(repo)},
    settingsPath:${JSON.stringify(settingsPath)},
    sourceRoot:${JSON.stringify(root)},
    startupBusyBudgetMs:${budgetMs},
    startupBarrierTimeoutMs:1000,
  });
  const deferred=await instance.awaitStartup();
  const dbPath=cache.l1ValidatedScanCacheDbPath(cache.resolveAbrainHomeRealpath(${JSON.stringify(repo)}));
  let cachedRows=0;
  if(fs.existsSync(dbPath)){
    const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync(dbPath,{readOnly:true});
    cachedRows=db.prepare("SELECT COUNT(*) AS n FROM validated_files").get().n;
    db.close();
  }
  process.stdout.write(JSON.stringify({deferred, cachedRows}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const child = spawn(process.execPath, ["-e", code], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const payload = JSON.parse((await childResult(child)).stdout);
  assert(
    payload.deferred.startup === "deferred" && payload.deferred.deferredReason === "STARTUP_BUDGET_EXHAUSTED",
    `expected budget deferred: ${JSON.stringify(payload.deferred)}`,
  );
  assert(payload.cachedRows > 0, `expected progressive cache rows after budget defer, got ${payload.cachedRows}`);
  assert(payload.cachedRows < 8, `budget defer cached entire inventory (${payload.cachedRows}); delay/budget too loose`);

  // Fresh process, normal budget, no per-record delay: should complete using cache.
  // Then an explicit warm scan proves cacheHits>0 and complete rows.
  const recoverCode = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
const l1=j(path.join(${JSON.stringify(root)},"extensions/_shared/l1-schema-registry.ts"));
(async()=>{
  delete process.env.PI_ASTACK_L1_SCAN_RECORD_DELAY_MS;
  const instance=await runtime.getCanonicalGitRuntime({
    abrainHome:${JSON.stringify(repo)},
    settingsPath:${JSON.stringify(settingsPath)},
    sourceRoot:${JSON.stringify(root)},
    startupBusyBudgetMs:30_000,
    startupBarrierTimeoutMs:5_000,
  });
  const ready=await instance.awaitStartup();
  const warm=await l1.scanWholeL1Validated({ abrainHome:${JSON.stringify(repo)}, useValidatedCache:true });
  process.stdout.write(JSON.stringify({
    ready,
    warm: {
      rows: warm.all.length,
      cacheHits: warm.cacheHits,
      cacheMisses: warm.cacheMisses,
      cacheRevalidated: warm.cacheRevalidated,
    },
  }));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const recoverChild = spawn(process.execPath, ["-e", recoverCode], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const recovered = JSON.parse((await childResult(recoverChild)).stdout);
  assert(recovered.ready.startup === "ready", `resume after budget not ready: ${recovered.ready.blockedReason}`);
  assert(
    recovered.ready.tail.some((row) => row.status === "last_known_ready_written" || row.phase === "publish_ready"),
    `ready missing publish diagnostics: ${JSON.stringify(recovered.ready.tail.slice(-8))}`,
  );
  // Startup may append recovery/meta L1 rows on top of the 8 knowledge fixtures.
  // Prove progressive cache reuse: hits > 0, misses < total, counters cover every row,
  // and the original knowledge inventory is still fully present.
  assert(recovered.warm.rows >= 8, `resume warm incomplete rows: ${recovered.warm.rows}`);
  assert(recovered.warm.cacheHits > 0, `resume warm expected cacheHits>0: ${JSON.stringify(recovered.warm)}`);
  assert(
    recovered.warm.cacheMisses < recovered.warm.rows,
    `resume warm cacheMisses not < total: ${JSON.stringify(recovered.warm)}`,
  );
  assert(
    recovered.warm.cacheHits + recovered.warm.cacheMisses + recovered.warm.cacheRevalidated === recovered.warm.rows,
    `resume warm counters not exhaustive: ${JSON.stringify(recovered.warm)}`,
  );
});

await check("last-known-ready gate skips cold when fingerprints match; drifts reopen cold", async () => {
  const repo = initRepo("last-known-ready");
  // Commit L1 so startup is a clean idle worktree (the production multi-pi case).
  // Untracked content/metadata tails intentionally force cold and are covered elsewhere.
  for (let i = 1; i <= 3; i += 1) writeKnowledge(repo, i);
  git(repo, "add", "l1");
  execFileSync("git", ["-C", repo, "commit", "-qm", "seed clean l1"], {
    env: {
      ...gitEnv,
      GIT_AUTHOR_NAME: "Scan Cache Fixture",
      GIT_AUTHOR_EMAIL: "scan-cache@example.invalid",
      GIT_COMMITTER_NAME: "Scan Cache Fixture",
      GIT_COMMITTER_EMAIL: "scan-cache@example.invalid",
    },
  });
  assert(git(repo, "status", "--porcelain=v1", "-uall") === "", "fixture worktree not clean before ready gate");
  const first = await runtimeModule.getCanonicalGitRuntime(runtimeOptions(repo));
  const ready1 = await first.awaitStartup();
  assert(ready1.startup === "ready", `initial ready failed: ${ready1.blockedReason}`);
  assert(
    ready1.tail.some((row) => row.status === "last_known_ready_written"),
    `last-known-ready not written: ${JSON.stringify(ready1.tail.filter((r) => String(r.phase || "").includes("publish") || String(r.status || "").includes("ready")))}`,
  );
  const readyPath = cache.lastKnownReadyPath(cache.resolveAbrainHomeRealpath(repo));
  assert(fs.existsSync(readyPath), "ready fingerprint file missing");
  assert(readyPath.includes(`${path.sep}v2${path.sep}`), `ready path not v2: ${readyPath}`);
  const readyRaw = JSON.parse(fs.readFileSync(readyPath, "utf8"));
  assert(readyRaw.schema === "canonical-last-known-ready/v2", `ready schema not v2: ${readyRaw.schema}`);
  assert(typeof readyRaw.implementationFingerprint === "string" && /^[0-9a-f]{64}$/.test(readyRaw.implementationFingerprint), "implementationFingerprint missing");
  assert(typeof readyRaw.validatorFingerprint === "string" && readyRaw.validatorFingerprint.length > 0, "validatorFingerprint missing");
  assert(typeof readyRaw.registryHash === "string" && /^[0-9a-f]{64}$/.test(readyRaw.registryHash), "registryHash missing");

  // New process-global runtime key via fresh child: should skip cold.
  const warmCode = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
(async()=>{
  const instance=await runtime.getCanonicalGitRuntime({
    abrainHome:${JSON.stringify(repo)},
    settingsPath:${JSON.stringify(settingsPath)},
    sourceRoot:${JSON.stringify(root)},
  });
  const diag=await instance.awaitStartup();
  process.stdout.write(JSON.stringify({diag}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const warmChild = spawn(process.execPath, ["-e", warmCode], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const warm = JSON.parse((await childResult(warmChild)).stdout).diag;
  assert(warm.startup === "ready", `warm gate not ready: ${warm.blockedReason}`);
  assert(
    warm.tail.some((row) => row.phase === "last_known_ready_gate" && row.status === "skip_cold"),
    `warm gate did not skip cold: ${JSON.stringify(warm.tail)}`,
  );
  assert(
    !warm.tail.some((row) => row.phase === "freeze_initial"),
    `warm gate still entered freeze_initial: ${JSON.stringify(warm.tail)}`,
  );

  // Drift L1 inventory → must cold start again.
  writeKnowledge(repo, 99);
  const driftCode = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
(async()=>{
  const instance=await runtime.getCanonicalGitRuntime({
    abrainHome:${JSON.stringify(repo)},
    settingsPath:${JSON.stringify(settingsPath)},
    sourceRoot:${JSON.stringify(root)},
  });
  const diag=await instance.awaitStartup();
  process.stdout.write(JSON.stringify({diag}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const driftChild = spawn(process.execPath, ["-e", driftCode], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const drifted = JSON.parse((await childResult(driftChild)).stdout).diag;
  assert(drifted.startup === "ready", `drift cold not ready: ${drifted.blockedReason}`);
  assert(
    drifted.tail.some((row) => row.phase === "last_known_ready_gate" && row.status === "cold_required"),
    `drift did not force cold: ${JSON.stringify(drifted.tail.filter((r) => r.phase === "last_known_ready_gate"))}`,
  );
  assert(
    drifted.tail.some((row) => row.phase === "freeze_initial"),
    `drift cold missing freeze_initial: ${JSON.stringify(drifted.tail)}`,
  );
});

await check("corrupt last-known-ready never fail-opens", async () => {
  const repo = initRepo("ready-corrupt-gate");
  writeKnowledge(repo, 1);
  git(repo, "add", "l1");
  execFileSync("git", ["-C", repo, "commit", "-qm", "seed clean l1"], {
    env: {
      ...gitEnv,
      GIT_AUTHOR_NAME: "Scan Cache Fixture",
      GIT_AUTHOR_EMAIL: "scan-cache@example.invalid",
      GIT_COMMITTER_NAME: "Scan Cache Fixture",
      GIT_COMMITTER_EMAIL: "scan-cache@example.invalid",
    },
  });
  const rt = await runtimeModule.getCanonicalGitRuntime(runtimeOptions(repo));
  assert((await rt.awaitStartup()).startup === "ready", "seed ready failed");
  const readyPath = cache.lastKnownReadyPath(cache.resolveAbrainHomeRealpath(repo));
  assert(fs.existsSync(readyPath), "ready fingerprint missing before corruption");
  fs.writeFileSync(readyPath, "not-json");
  const code = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
(async()=>{
  const instance=await runtime.getCanonicalGitRuntime({
    abrainHome:${JSON.stringify(repo)},
    settingsPath:${JSON.stringify(settingsPath)},
    sourceRoot:${JSON.stringify(root)},
  });
  const diag=await instance.awaitStartup();
  process.stdout.write(JSON.stringify({diag}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const child = spawn(process.execPath, ["-e", code], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const diag = JSON.parse((await childResult(child)).stdout).diag;
  assert(diag.startup === "ready", `corrupt ready gate blocked: ${diag.blockedReason}`);
  assert(
    diag.tail.some((row) => row.phase === "last_known_ready_gate" && row.status === "cold_required" && row.reason === "missing"),
    `corrupt ready fail-opened skip: ${JSON.stringify(diag.tail.filter((r) => r.phase === "last_known_ready_gate"))}`,
  );
});

await check("scan mutex BUSY → deferred; release then external retry ready", async () => {
  const repo = initRepo("scan-mutex");
  writeKnowledge(repo, 1);
  const mutexDir = cache.ensureL1ScanMutexDirectory(repo);
  const held = lockModule.acquireRetainedDirectoryOfdLock(mutexDir);
  assert(held.status === "ACQUIRED", "could not hold scan mutex");
  try {
    const code = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
(async()=>{
  const instance=await runtime.getCanonicalGitRuntime({
    abrainHome:${JSON.stringify(repo)},
    settingsPath:${JSON.stringify(settingsPath)},
    sourceRoot:${JSON.stringify(root)},
  });
  const deferred=await instance.awaitStartup();
  process.stdout.write(JSON.stringify({deferred, promiseMap: runtime.__canonicalStartupPromiseMapSizeForTests()}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
    const child = spawn(process.execPath, ["-e", code], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
    const payload = JSON.parse((await childResult(child)).stdout);
    assert(
      payload.deferred.startup === "deferred" && payload.deferred.deferredReason === "CANONICAL_SCAN_BUSY" && payload.deferred.retryable === true,
      `scan busy not deferred: ${JSON.stringify(payload.deferred)}`,
    );
    assert(payload.promiseMap === 0, `deferred promise was not evicted: ${payload.promiseMap}`);
  } finally {
    held.close();
  }

  const retryCode = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
(async()=>{
  const instance=await runtime.getCanonicalGitRuntime({
    abrainHome:${JSON.stringify(repo)},
    settingsPath:${JSON.stringify(settingsPath)},
    sourceRoot:${JSON.stringify(root)},
  });
  const ready=await instance.awaitStartup();
  process.stdout.write(JSON.stringify({ready}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const retryChild = spawn(process.execPath, ["-e", retryCode], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  const ready = JSON.parse((await childResult(retryChild)).stdout).ready;
  assert(ready.startup === "ready", `post-scan-mutex retry not ready: ${ready.blockedReason}`);
});

await check("scan mutex and mutation barrier do not deadlock (barrier never waits on scan lock)", async () => {
  const repo = initRepo("lock-order");
  writeKnowledge(repo, 1);
  const mutexDir = cache.ensureL1ScanMutexDirectory(repo);
  const scanHeld = lockModule.acquireRetainedDirectoryOfdLock(mutexDir);
  assert(scanHeld.status === "ACQUIRED", "scan mutex hold failed");
  try {
    // Holding scan mutex must not prevent acquiring mutation barrier.
    const result = await barrier.tryWithCanonicalMutationBarrier(repo, async () => {
      // Inside barrier, whole-L1 scan must proceed without waiting for scan mutex.
      // Default cache off; lock-order only.
      const scan = await l1.scanWholeL1Validated({ abrainHome: repo });
      return scan.all.length;
    });
    assert(result.status === "acquired" && result.value === 1, `barrier+scan under foreign scan lock failed: ${JSON.stringify(result)}`);
  } finally {
    scanHeld.close();
  }

  // Holding mutation barrier must not require scan mutex for freeze-style scans
  // (startup barrier freezes set requireScanMutex=false / underBarrier path).
  await barrier.withCanonicalMutationBarrier(repo, async () => {
    const scan = await l1.scanWholeL1Validated({ abrainHome: repo });
    assert(scan.all.length === 1, "barrier-held scan failed");
  });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  for (const row of failures) console.error(`- ${row.name}: ${row.error instanceof Error ? row.error.stack : row.error}`);
  process.exitCode = 1;
}
