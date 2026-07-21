#!/usr/bin/env node
/** Multi-process startup busy retry, outside-final-classification, and barrier backoff gate. */
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
const recovery = jiti(path.join(root, "extensions/_shared/convergence-recovery.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-startup-busy-retry-"));
const settingsPath = path.join(tmp, "enabled.json");
const pendingChildren = new Set();
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
  git(repo, "config", "user.name", "Startup Busy Fixture");
  git(repo, "config", "user.email", "startup-busy@example.invalid");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(repo, "README"), "startup busy retry\n");
  git(repo, "add", ".gitignore", "README");
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"], {
    env: {
      ...gitEnv,
      GIT_AUTHOR_NAME: "Startup Busy Fixture",
      GIT_AUTHOR_EMAIL: "startup-busy@example.invalid",
      GIT_COMMITTER_NAME: "Startup Busy Fixture",
      GIT_COMMITTER_EMAIL: "startup-busy@example.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  });
  return repo;
}

function writeKnowledge(repo, seq) {
  const body = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: `2026-07-21T00:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: "startup-busy-fixture",
    device_event_seq: seq,
    producer_nonce: `startup-busy-${seq}`,
    causal_parents: [],
    session_id: "startup-busy-session",
    turn_id: `turn-${seq}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "agent_end", source_ref: `sediment:auto_write:created:startup-busy-${seq}` },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug: `startup-busy-${seq}`,
      title: `Startup Busy ${seq}`,
      kind: "knowledge",
      status: "active",
      provenance: "synthetic-smoke",
      confidence: 9,
      compiled_truth: `# Startup Busy ${seq}\n\nSynthetic startup retry fixture.`,
      trigger_phrases: ["startup busy retry"],
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
  return { eventId, relative };
}

function childResult(child) {
  const promise = new Promise((resolve, reject) => {
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
  pendingChildren.add(promise);
  void promise.finally(() => pendingChildren.delete(promise)).catch(() => {});
  return promise;
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function barrierHolder(repo, holdMs, marker) {
  const code = `
const {createJiti}=require("jiti");
const fs=require("fs"),path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const barrier=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-mutation-barrier.ts"));
(async()=>barrier.withCanonicalMutationBarrier(${JSON.stringify(repo)},async()=>{
  fs.writeFileSync(${JSON.stringify(marker)},"held\\n");
  await new Promise(resolve=>setTimeout(resolve,${holdMs}));
}))().catch(error=>{console.error(error);process.exit(1)});
`;
  return spawn(process.execPath, ["-e", code], { cwd: root, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
}

try {
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
  }, null, 2)}\n`);

  // A performs a real startup drain and advances HEAD. B times out on A's
  // mutation barrier, retries inside one shared promise from a new freeze, and
  // reaches ready while A's long final classification is outside the barrier.
  const repo = initRepo("two-startups");
  const knowledge = writeKnowledge(repo, 1);
  const headBefore = git(repo, "rev-parse", "HEAD");
  const mutationMarker = path.join(tmp, "a-mutation-held.marker");
  const finalMarker = path.join(tmp, "a-final-classify.marker");
  const barrierTimeoutMs = 100;
  const mutationHoldMs = 1_500;
  const finalClassifyDelayMs = 3_000;
  const optionsLiteral = JSON.stringify({
    abrainHome: repo,
    settingsPath,
    sourceRoot: root,
    startupBarrierTimeoutMs: barrierTimeoutMs,
    startupBusyBudgetMs: 3_000,
    startupBusyInitialBackoffMs: 20,
    startupBusyMaxBackoffMs: 80,
  });

  const processACode = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
(async()=>{
  const options=${optionsLiteral};
  const instance=await runtime.getCanonicalGitRuntime(options);
  const diagnostics=await instance.awaitStartup();
  if(diagnostics.startup!=="ready")throw new Error(diagnostics.blockedReason||diagnostics.startup);
  await instance.settleForDeviceJoin();
  process.stdout.write(JSON.stringify({startup:diagnostics.startup,tail:diagnostics.tail}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const childA = spawn(process.execPath, ["-e", processACode], {
    cwd: root,
    env: {
      ...gitEnv,
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      PI_ASTACK_STARTUP_MUTATION_HOLD_DELAY_MS: String(mutationHoldMs),
      PI_ASTACK_STARTUP_MUTATION_HOLD_MARKER: mutationMarker,
      PI_ASTACK_STARTUP_FINAL_CLASSIFY_DELAY_MS: String(finalClassifyDelayMs),
      PI_ASTACK_STARTUP_FINAL_CLASSIFY_MARKER: finalMarker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const aDone = childResult(childA);
  await waitFor("A real mutation hold", () => fs.existsSync(mutationMarker));
  const mutationHead = git(repo, "rev-parse", "HEAD");
  assert(mutationHead !== headBefore, "A did not advance HEAD before holding the mutation barrier");

  const processBCode = `
const {createJiti}=require("jiti");
const path=require("path");
const j=createJiti(${JSON.stringify(root)},{interopDefault:true});
const runtime=j(path.join(${JSON.stringify(root)},"extensions/_shared/canonical-git-runtime.ts"));
(async()=>{
  const options=${optionsLiteral};
  options.startupRetryRandom=()=>0;
  const first=runtime.getCanonicalStartupPromise(options);
  const second=runtime.getCanonicalStartupPromise(options);
  if(first!==second)throw new Error("startup promise was not shared");
  const diagnostics=await first;
  process.stdout.write(JSON.stringify({shared:true,startup:diagnostics.startup,blockedReason:diagnostics.blockedReason||null,tail:diagnostics.tail}));
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const childB = spawn(process.execPath, ["-e", processBCode], {
    cwd: root,
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bDone = childResult(childB);

  await waitFor("A outside final classification", () => fs.existsSync(finalMarker));
  // B may still own its own short recovery phase. Wait for it so the probe
  // isolates A's final-classification lock scope instead of measuring B.
  const bResult = await bDone;
  const probeStarted = Date.now();
  await barrier.withCanonicalMutationBarrier(repo, async () => {
    fs.writeFileSync(path.join(repo, "final-drift.txt"), "real writer during outside final classification\n");
    git(repo, "add", "final-drift.txt");
    git(repo, "commit", "-qm", "real final tuple drift", "--", "final-drift.txt");
  }, {
    timeoutMs: 500,
    retryMs: 10,
    maxRetryMs: 50,
  });
  const finalOutsideProbeMs = Date.now() - probeStarted;
  assert(finalOutsideProbeMs < 500, `final classification still held the barrier for ${finalOutsideProbeMs}ms`);

  const aResult = await aDone;
  const a = JSON.parse(aResult.stdout);
  const b = JSON.parse(bResult.stdout);
  assert(a.startup === "ready", `A did not become ready: ${aResult.stdout}\n${aResult.stderr}`);
  assert(b.shared && b.startup === "ready", `B shared startup did not become ready: ${bResult.stdout}\n${bResult.stderr}`);
  assert(b.tail.some((row) => row.status === "canonical_mutation_busy_retry"), "B never exercised runtime-level CANONICAL_MUTATION_BUSY retry");
  assert(b.tail.filter((row) => row.phase === "freeze_initial" && row.status === "enter").length >= 2, "B reused its old frozen tuple after busy");
  assert(a.tail.some((row) => row.phase === "classify_final" && row.status === "test_delay"), "A did not exercise delayed final classification");
  assert(a.tail.some((row) => row.status === "classify_input_drift_retry"), "A published ready without recomputing the drifted final tuple");
  const mutationCohort = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", mutationHead).split("\n").filter(Boolean).sort();
  assert(JSON.stringify(mutationCohort) === JSON.stringify([knowledge.relative]), `A startup mutation cohort drifted: ${JSON.stringify(mutationCohort)}`);
  assert(git(repo, "status", "--porcelain=v1", "-uall") === "", "concurrent startups did not leave a clean repository after settlement");
  const finalScan = await l1.scanWholeL1Validated({ abrainHome: repo });
  const finalRecovery = recovery.recoverOpenRecoveryEpisodesV3FromScan(finalScan);
  assert(finalRecovery.open.length === 0 && finalRecovery.quarantined.length === 0, "final recovery cohort is open or quarantined");

  // Low-level timeout remains authoritative. Normal multi-waiter callers share
  // one process-local poller; captured sleeps prove capped exponential backoff.
  const barrierRepo = initRepo("barrier-backoff");
  const barrierMarker = path.join(tmp, "barrier-backoff-holder.marker");
  const holder = barrierHolder(barrierRepo, 350, barrierMarker);
  const holderDone = childResult(holder);
  await waitFor("barrier backoff holder", () => fs.existsSync(barrierMarker));
  let lowLevelError;
  try {
    await barrier.withCanonicalMutationBarrierInSingleFlight(barrierRepo, async () => {}, {
      timeoutMs: 35,
      retryMs: 10,
      maxRetryMs: 40,
      random: () => 1,
    });
  } catch (error) {
    lowLevelError = error;
  }
  assert(lowLevelError?.code === "CANONICAL_MUTATION_BUSY", `low-level timeout semantics changed: ${lowLevelError}`);

  const delays = [];
  let probes = 0;
  const waiterOptions = {
    timeoutMs: 1_000,
    retryMs: 10,
    maxRetryMs: 40,
    random: () => 1,
    onProbe: () => { probes += 1; },
    sleep: async (delayMs) => {
      delays.push(delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
  };
  const waiterOrder = [];
  await Promise.all([0, 1, 2].map((id) => barrier.withCanonicalMutationBarrier(barrierRepo, async () => {
    waiterOrder.push(id);
  }, waiterOptions)));
  await holderDone;
  assert(JSON.stringify(waiterOrder) === JSON.stringify([0, 1, 2]), `multi-waiter single-flight order drifted: ${waiterOrder}`);
  assert(delays.length >= 3 && delays[0] === 10 && delays[1] === 20 && delays[2] === 40, `barrier backoff is not exponential/capped: ${delays}`);
  assert(delays.every((delay) => delay <= 40), `barrier backoff exceeded cap: ${delays}`);
  assert(probes === delays.length + 3, `multi-waiter polling multiplied unexpectedly: probes=${probes} delays=${delays.length}`);

  // A permanent holder exhausts a short monotonic total budget into typed
  // deferred diagnostics. No retry timer remains; holder release plus a later
  // lifecycle consumer invocation starts a new freeze and reaches ready.
  const deferredRepo = initRepo("deferred-retry");
  const deferredMarker = path.join(tmp, "deferred-holder.marker");
  const deferredHolder = barrierHolder(deferredRepo, 650, deferredMarker);
  const deferredHolderDone = childResult(deferredHolder);
  await waitFor("deferred holder", () => fs.existsSync(deferredMarker));
  let activeSleeps = 0;
  let maxActiveSleeps = 0;
  const activeTimeoutsBefore = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const deferredOptions = {
    abrainHome: deferredRepo,
    settingsPath,
    sourceRoot: root,
    startupBarrierTimeoutMs: 30,
    startupBusyBudgetMs: 140,
    startupBusyInitialBackoffMs: 10,
    startupBusyMaxBackoffMs: 20,
    startupRetryRandom: () => 0,
    startupRetrySleep: (delayMs) => new Promise((resolve) => {
      activeSleeps += 1;
      maxActiveSleeps = Math.max(maxActiveSleeps, activeSleeps);
      setTimeout(() => { activeSleeps -= 1; resolve(); }, delayMs);
    }),
  };
  const staleReports = [];
  const currentReports = [];
  const blockedDiagnostics = [];
  let abrainReady = 0;
  let sedimentReady = 0;
  const sharedDeferred = runtimeModule.getCanonicalStartupPromise(deferredOptions);
  assert(sharedDeferred === runtimeModule.getCanonicalStartupPromise(deferredOptions), "deferred startup did not share one promise");
  const abrainFirst = runtimeModule.scheduleCanonicalStartupConsumer({
    runtime: deferredOptions,
    consumerId: "abrain-runtime",
    mode: "json",
    reporter: (message, type) => staleReports.push({ consumer: "abrain", message, type }),
    onReady: () => { abrainReady += 1; },
    onBlocked: (diagnostics) => { blockedDiagnostics.push(diagnostics); },
  });
  const sedimentFirst = runtimeModule.scheduleCanonicalStartupConsumer({
    runtime: deferredOptions,
    consumerId: "sediment-runtime",
    mode: "json",
    reporter: (message, type) => staleReports.push({ consumer: "sediment", message, type }),
    onReady: () => { sedimentReady += 1; },
    onBlocked: (diagnostics) => { blockedDiagnostics.push(diagnostics); },
  });
  runtimeModule.setCanonicalStartupReporter({ runtime: deferredOptions, consumerId: "abrain-runtime", reporter: (message, type) => currentReports.push({ consumer: "abrain", message, type }) });
  runtimeModule.setCanonicalStartupReporter({ runtime: deferredOptions, consumerId: "sediment-runtime", reporter: (message, type) => currentReports.push({ consumer: "sediment", message, type }) });
  const deferred = await sharedDeferred;
  await Promise.all([abrainFirst, sedimentFirst]);
  assert(deferred.startup === "deferred" && deferred.deferredReason === "CANONICAL_MUTATION_BUSY" && deferred.retryable === true, `busy budget did not return typed deferred diagnostics: ${JSON.stringify(deferred)}`);
  assert(blockedDiagnostics.length === 2 && blockedDiagnostics.every((item) => item.startup === "deferred"), "both consumers did not observe the shared deferred result");
  assert(staleReports.length === 0, "deferred delivery retained stale reporters");
  assert(currentReports.every((row) => row.type !== "error"), `transient busy emitted a red error: ${JSON.stringify(currentReports)}`);
  assert(maxActiveSleeps === 1 && activeSleeps === 0, `startup retry timers leaked or multiplied: active=${activeSleeps} max=${maxActiveSleeps}`);
  await new Promise((resolve) => setImmediate(resolve));
  const activeTimeoutsAfter = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  assert(activeTimeoutsAfter <= activeTimeoutsBefore, `deferred startup leaked Timeout resources: before=${activeTimeoutsBefore} after=${activeTimeoutsAfter}`);
  assert(abrainReady === 0 && sedimentReady === 0, "deferred startup ran an onReady continuation");

  await deferredHolderDone;
  await Promise.all([
    runtimeModule.scheduleCanonicalStartupConsumer({
      runtime: deferredOptions,
      consumerId: "abrain-runtime",
      mode: "json",
      reporter: (message, type) => currentReports.push({ consumer: "abrain", message, type }),
      onReady: () => { abrainReady += 1; },
    }),
    runtimeModule.scheduleCanonicalStartupConsumer({
      runtime: deferredOptions,
      consumerId: "sediment-runtime",
      mode: "json",
      reporter: (message, type) => currentReports.push({ consumer: "sediment", message, type }),
      onReady: () => { sedimentReady += 1; },
    }),
  ]);
  assert(abrainReady === 1 && sedimentReady === 1, `external lifecycle retry did not run each onReady once: ${abrainReady}/${sedimentReady}`);
  assert(git(deferredRepo, "status", "--porcelain=v1", "-uall") === "", "deferred retry left repository dirty");

  // Terminal notifications are scoped to one startup-promise generation. Two
  // consumers share attempt 1 and emit one error. After an in-process repair
  // reaches ready, attempt 2 gets one new error and never calls stale reporters.
  const missingRepo = path.join(tmp, "missing-terminal-repo");
  const terminalOptions = { abrainHome: missingRepo, settingsPath, sourceRoot: root };
  const attempt1Reports = [];
  const attempt2Reports = [];
  let terminalReady = 0;
  const scheduleTerminalConsumers = (reports) => Promise.all([
    runtimeModule.scheduleCanonicalStartupConsumer({
      runtime: terminalOptions,
      consumerId: "terminal-abrain",
      mode: "json",
      reporter: (message, type) => reports.push({ consumer: "abrain", message, type }),
      onReady: () => { terminalReady += 1; },
      errorMessage: () => "consumer-specific-error-must-not-leak",
    }),
    runtimeModule.scheduleCanonicalStartupConsumer({
      runtime: terminalOptions,
      consumerId: "terminal-sediment",
      mode: "json",
      reporter: (message, type) => reports.push({ consumer: "sediment", message, type }),
      onReady: () => { terminalReady += 1; },
      errorMessage: () => "consumer-specific-error-must-not-leak",
    }),
  ]);

  await scheduleTerminalConsumers(attempt1Reports);
  const attempt1Errors = attempt1Reports.filter((row) => row.type === "error");
  assert(attempt1Errors.length === 1, `attempt 1 terminal notification was not deduplicated: ${JSON.stringify(attempt1Reports)}`);

  initRepo("missing-terminal-repo");
  const repairedRuntime = await runtimeModule.getCanonicalGitRuntime(terminalOptions);
  const repaired = await repairedRuntime.awaitStartup();
  assert(repaired.startup === "ready", `terminal fixture did not recover in process: ${JSON.stringify(repaired)}`);

  fs.writeFileSync(settingsPath, '{"canonicalGitRuntime":{"enabled":true,"mode":"invalid-after-ready"}}\n');
  await scheduleTerminalConsumers(attempt2Reports);
  const attempt2Errors = attempt2Reports.filter((row) => row.type === "error");
  const terminalErrors = [...attempt1Errors, ...attempt2Errors];
  assert(terminalReady === 0, "terminal failure consumer unexpectedly ran onReady");
  assert(attempt1Reports.length === 1, `attempt 2 reached a stale reporter: ${JSON.stringify(attempt1Reports)}`);
  assert(attempt2Errors.length === 1, `attempt 2 terminal notification was not deduplicated: ${JSON.stringify(attempt2Reports)}`);
  assert(terminalErrors.length === 2, `fresh startup attempts did not emit exactly two total errors: ${JSON.stringify(terminalErrors)}`);
  assert(terminalErrors.every((row) => row.message.startsWith("canonical startup failed:") && !row.message.includes("consumer-specific")), "terminal notification was not generic");

  console.log("startup busy retry and outside final classification: ok");
  console.log(`  A_head_advanced=${mutationHead !== headBefore} B_busy_retries=${b.tail.filter((row) => row.status === "canonical_mutation_busy_retry").length} final_probe_ms=${finalOutsideProbeMs}`);
  console.log(`  barrier_probes=${probes} delays=${delays.join(",")} deferred_retries=${deferred.tail.filter((row) => row.status === "canonical_mutation_busy_retry").length}`);
  console.log(`  onReady=abrain:${abrainReady},sediment:${sedimentReady} terminal_attempt_errors=${attempt1Errors.length}+${attempt2Errors.length}`);
} finally {
  await Promise.allSettled([...pendingChildren]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
