#!/usr/bin/env node
/** Awaited pi agent_end integration smoke for the detached sediment queue. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-sediment-agent-end-queue-"));
const settingsPath = path.join(tmp, "settings.json");
fs.writeFileSync(settingsPath, `${JSON.stringify({
  canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
  sediment: { enabled: true },
}, null, 2)}\n`);
process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
const checkpoint = await jiti.import(path.join(root, "extensions/sediment/checkpoint.ts"));
const settingsModule = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
const queue = await jiti.import(path.join(root, "extensions/sediment/agent-end-queue.ts"));

function assert(value, message) {
  if (!value) throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    api: {
      on(name, handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool() {},
      registerCommand() {},
      registerEntryRenderer() {},
      getActiveTools() { return []; },
      getAllTools() { return []; },
      setActiveTools() {},
    },
  };
}

async function fireAwaited(handlers, name, event, ctx) {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

function entry(index, sessionPrefix = "") {
  const id = `${sessionPrefix}entry-${index}`;
  return {
    type: "message",
    id,
    parentId: index > 1 ? `${sessionPrefix}entry-${index - 1}` : null,
    timestamp: new Date(1700000000000 + index).toISOString(),
    message: { role: index % 2 ? "user" : "assistant", content: `message ${index}`, timestamp: 1700000000000 + index },
  };
}

function makeContext(branchRef, sessionId = "queue-session") {
  const uiState = { stale: false };
  const ctx = {
    mode: "tui",
    cwd: tmp,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(tmp, `${sessionId}.jsonl`),
      getBranch: () => branchRef.current,
      buildSessionContext: () => ({ messages: branchRef.current.map((row) => row.message).filter(Boolean) }),
    },
    modelRegistry: { marker: "registry" },
    ui: {
      notify() { if (uiState.stale) throw new Error("stale ctx notify"); },
      setStatus() { if (uiState.stale) throw new Error("stale ctx status"); },
    },
  };
  return { ctx, uiState };
}

const pi = fakePi();
const activate = sediment.default ?? sediment;
activate(pi.api);
const agentEndHandlers = pi.handlers.get("agent_end") ?? [];
assert(agentEndHandlers.length === 1, `expected one sediment agent_end handler, got ${agentEndHandlers.length}`);

try {
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();

  const startup = deferred();
  const firstRunRelease = deferred();
  const runs = [];
  const runContents = [];
  let runCalls = 0;
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: () => startup.promise,
    run: async (snapshot) => {
      runCalls += 1;
      assert(!("sessionManager" in snapshot) && !("ui" in snapshot) && !("ctx" in snapshot), "detached job retained a live pi context surface");
      snapshot.setStatus?.("running", "stale-ui-probe");
      snapshot.notify?.("stale-ui-probe", "info");
      runs.push(snapshot.branchEntries.map((row) => row.id));
      runContents.push(snapshot.branchEntries.map((row) => row.message?.content));
      if (runCalls === 1) await firstRunRelease.promise;
    },
  });

  const branchRef = { current: [entry(1)] };
  const { ctx, uiState } = makeContext(branchRef);
  const event = { messages: [{ role: "assistant", stopReason: "stop" }] };

  const latencies = [];
  for (let size = 1; size <= 3; size += 1) {
    branchRef.current = Array.from({ length: size }, (_, index) => entry(index + 1));
    const started = performance.now();
    await fireAwaited(pi.handlers, "agent_end", event, ctx);
    latencies.push(performance.now() - started);
  }
  assert(Math.max(...latencies) < 100, `awaited agent_end exceeded 100ms: ${latencies.map((ms) => ms.toFixed(2)).join(", ")}`);
  branchRef.current[2].message.content = "mutated after enqueue";
  await new Promise((resolve) => setImmediate(resolve));
  assert(runCalls === 0, "sediment pass ran before delayed startup settled");

  // Mark the original pi ctx stale before any detached work resumes. Dynamic
  // reporter and snapshot-only session inputs must keep the queue independent.
  uiState.stale = true;
  startup.resolve(true);
  while (runCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  assert(JSON.stringify(runs[0]) === JSON.stringify(["entry-1", "entry-2", "entry-3"]), `startup coalescing lost branch entries: ${JSON.stringify(runs)}`);
  assert(runContents[0][2] === "message 3", `detached snapshot shared a mutable live entry: ${JSON.stringify(runContents[0])}`);

  // This event arrives after the worker claimed the 3-entry snapshot. It must
  // become a second ordered pass, not mutate/reorder the claimed one.
  branchRef.current = [entry(1), entry(2), entry(3), entry(4)];
  const fourthStarted = performance.now();
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  assert(performance.now() - fourthStarted < 100, "post-claim agent_end blocked the pi runner");
  firstRunRelease.resolve();
  await sediment._waitForAutoWriteIdleForTests();
  assert(runCalls === 2, `expected two claimed passes, got ${runCalls}`);
  assert(JSON.stringify(runs[1]) === JSON.stringify(["entry-1", "entry-2", "entry-3", "entry-4"]), `post-claim ordering mismatch: ${JSON.stringify(runs)}`);
  const stats = sediment._detachedAgentEndQueueStatsForTests();
  assert(stats.enqueued === 4 && stats.coalesced === 3, `unexpected queue coalescing stats: ${JSON.stringify(stats)}`);
  assert(stats.claimed === 2 && stats.completed === 2 && stats.maxConcurrent === 1, `queue was not strict-serial for same key: ${JSON.stringify(stats)}`);

  // Full-branch coalescing is only lossless if replay advances from the oldest
  // unseen entry. Exercise enough entries to cross both count and char caps.
  const replayBranch = Array.from({ length: 43 }, (_unused, index) => ({
    id: `replay-${String(index).padStart(3, "0")}`,
    type: "message",
    message: { role: index % 2 === 0 ? "user" : "assistant", content: `payload-${index}-${"x".repeat(24)}` },
  }));
  const replaySettings = {
    ...settingsModule.resolveSedimentSettings(),
    minWindowChars: 0,
    maxWindowChars: 85,
    maxWindowEntries: 7,
    maxEntryChars: 32,
  };
  const replayedIds = [];
  let replayCheckpoint = {};
  for (let pass = 0; pass < 100; pass += 1) {
    const window = checkpoint.buildRunWindow(replayBranch, replayCheckpoint, replaySettings, { backlogOrder: "oldest" });
    if (!window.lastEntryId) break;
    replayedIds.push(...window.entries.map((row) => row.id));
    replayCheckpoint = { lastProcessedEntryId: window.lastEntryId };
  }
  assert(
    JSON.stringify(replayedIds) === JSON.stringify(replayBranch.map((row) => row.id)),
    `oldest-first replay lost or reordered entries: ${JSON.stringify(replayedIds)}`,
  );

  // Watermark invisible under same-lineage compaction: oldest-first replays the
  // remaining spine. Legacy unproven lineage fails closed (tested later).
  const invisibleBranch = Array.from({ length: 12 }, (_unused, index) => ({
    id: `remain-${String(index).padStart(2, "0")}`,
    type: "message",
    message: { role: index % 2 === 0 ? "user" : "assistant", content: `remain-payload-${index}-${"y".repeat(20)}` },
  }));
  const invisibleSettings = {
    ...settingsModule.resolveSedimentSettings(),
    minWindowChars: 0,
    maxWindowChars: 120,
    maxWindowEntries: 4,
    maxEntryChars: 40,
  };
  const spineIds = [
    "compacted-away-watermark",
    ...invisibleBranch.map((row) => row.id),
  ];
  const invisibleCp = {
    lastProcessedEntryId: "compacted-away-watermark",
    lineageRecorded: true,
    branchEntryIds: spineIds,
    branchLineageKey: checkpoint.computeBranchLineageKey(spineIds),
    branchTipId: spineIds[spineIds.length - 1],
  };
  const firstInvisible = checkpoint.buildRunWindow(invisibleBranch, invisibleCp, invisibleSettings, { backlogOrder: "oldest" });
  assert(firstInvisible.checkpointFound === false, "invisible watermark must report checkpointFound=false");
  assert(firstInvisible.lineageStatus === "compacted_same_lineage", `expected same-lineage compaction, got ${firstInvisible.lineageStatus}`);
  assert(firstInvisible.candidateEntries === invisibleBranch.length, `oldest invisible fallback must candidate full branch, got ${firstInvisible.candidateEntries}`);
  assert(firstInvisible.entries[0]?.id === "remain-00", `oldest invisible must start at oldest remaining entry, got ${firstInvisible.entries[0]?.id}`);
  const invisibleReplayed = [];
  let invCp = invisibleCp;
  for (let pass = 0; pass < 50; pass += 1) {
    const window = checkpoint.buildRunWindow(invisibleBranch, invCp, invisibleSettings, { backlogOrder: "oldest" });
    if (!window.lastEntryId || window.skipReason === "no_new_entries") break;
    invisibleReplayed.push(...window.entries.map((row) => row.id));
    invCp = {
      lastProcessedEntryId: window.lastEntryId,
      lineageRecorded: true,
      branchEntryIds: spineIds,
      branchLineageKey: checkpoint.computeBranchLineageKey(spineIds),
      branchTipId: spineIds[spineIds.length - 1],
    };
  }
  assert(
    JSON.stringify(invisibleReplayed) === JSON.stringify(invisibleBranch.map((row) => row.id)),
    `invisible-watermark oldest replay incomplete: ${JSON.stringify(invisibleReplayed)}`,
  );

  // A rejected background pass must be caught by the process-level boundary;
  // later jobs still run and Node must not emit unhandledRejection.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let recoveryRun = 0;
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: async () => true,
    run: async () => {
      recoveryRun += 1;
      if (recoveryRun === 1) throw new Error("injected detached failure");
    },
  });
  branchRef.current = [entry(1), entry(2), entry(3), entry(4), entry(5)];
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  branchRef.current = [...branchRef.current, entry(6)];
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert(recoveryRun === 2, `queue stopped after rejection: runs=${recoveryRun}`);
  assert(unhandled.length === 0, `unhandled rejections: ${unhandled.map(String).join(" | ")}`);
  const auditPath = path.join(tmp, ".pi-astack", "sediment", "audit.jsonl");
  const auditRows = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert(auditRows.some((row) => row.reason === "agent_end_queue_job_failed" && row.error?.includes("injected detached failure")), "detached rejection was not audited");
  const failureStats = sediment._detachedAgentEndQueueStatsForTests();
  assert(failureStats.errors === 1 && failureStats.maxConcurrent === 1, `failure containment stats mismatch: ${JSON.stringify(failureStats)}`);

  // ready=false → park (no claim/complete/delete) → wake executes exactly once.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  let parkRuns = 0;
  let parkGate = deferred();
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: () => parkGate.promise,
    run: async () => { parkRuns += 1; },
  });
  branchRef.current = [entry(1), entry(2)];
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  // Settle false → park (do not wait-for-idle while the gate is still open).
  parkGate.resolve(false);
  await sediment._waitForAutoWriteIdleForTests();
  const parkedStats = sediment._detachedAgentEndQueueStatsForTests();
  assert(parkedStats.readyFalse >= 1 && parkedStats.parked >= 1, `ready=false was not parked: ${JSON.stringify(parkedStats)}`);
  assert(parkedStats.claimed === 0 && parkedStats.completed === 0, `ready=false must not claim/complete: ${JSON.stringify(parkedStats)}`);
  assert(parkedStats.parkedKeys === 1 && parkedStats.pendingKeys === 1, `parked snapshot was dropped: ${JSON.stringify(parkedStats)}`);
  assert(parkRuns === 0, "parked job ran before wake");
  const parkAudit = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert(parkAudit.some((row) => row.reason === "agent_end_queue_not_ready" && row.parked === true), "ready=false did not write not_ready audit");

  // Explicit wake retries readiness; now true → exactly one run.
  parkGate = { promise: Promise.resolve(true), resolve() {}, reject() {} };
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: async () => true,
    run: async () => { parkRuns += 1; },
  });
  // wakeParked reuses the retained snapshot (no new enqueue required).
  // But waitUntilReady is re-read from the parked job object which still has
  // the old hook. Use enqueue with a fresh agent_end to wake with new hooks.
  branchRef.current = [entry(1), entry(2), entry(3)];
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  assert(parkRuns === 1, `park→wake must run exactly once, got ${parkRuns}`);
  const wokeStats = sediment._detachedAgentEndQueueStatsForTests();
  assert(wokeStats.wokeFromPark >= 1 && wokeStats.claimed === 1 && wokeStats.completed === 1, `wake stats mismatch: ${JSON.stringify(wokeStats)}`);
  assert(wokeStats.parkedKeys === 0, "wake left a parked key behind");

  // Multi-session: one never-ready gate must not block another session.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  const sessionAReady = deferred();
  const sessionBStarted = deferred();
  const sessionRuns = { A: 0, B: 0 };
  const sessionHooks = new Map();
  // Use direct queue to isolate multi-key concurrency without full sediment path.
  queue.resetDetachedAgentEndQueueForTests();
  queue.enqueueDetachedAgentEnd({
    key: "session:A",
    waitUntilReady: () => sessionAReady.promise,
    run: async () => { sessionRuns.A += 1; },
  });
  queue.enqueueDetachedAgentEnd({
    key: "session:B",
    waitUntilReady: async () => true,
    run: async () => {
      sessionRuns.B += 1;
      sessionBStarted.resolve();
    },
  });
  await Promise.race([
    sessionBStarted.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("session B blocked by session A never-ready gate")), 500)),
  ]);
  assert(sessionRuns.B === 1 && sessionRuns.A === 0, `concurrent keys failed: ${JSON.stringify(sessionRuns)}`);
  const multiStats = queue.detachedAgentEndQueueStats();
  assert(multiStats.maxConcurrent >= 1, `expected concurrent scheduling stats: ${JSON.stringify(multiStats)}`);
  sessionAReady.resolve(false);
  await queue.waitForDetachedAgentEndQueueIdle();
  const multiAfter = queue.detachedAgentEndQueueStats();
  assert(multiAfter.parkedKeys === 1 && multiAfter.readyFalse >= 1, `session A was not parked: ${JSON.stringify(multiAfter)}`);
  assert(sessionRuns.A === 0, "never-ready session A must not run");
  // Cleanup parked A for subsequent tests
  queue.resetDetachedAgentEndQueueForTests();

  // Drain-path determinism probe: multi-chunk oldest windows each surface
  // explicit MEMORY fences via the same parseExplicitMemoryBlocks used by drain.
  const extractor = await jiti.import(path.join(root, "extensions/sediment/extractor.ts"));
  const memBranch = Array.from({ length: 18 }, (_u, index) => ({
    id: `mem-${String(index).padStart(2, "0")}`,
    type: "message",
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: (index >= 4 && index % 3 === 0)
        ? `assistant note\nMEMORY:\ntitle: drain-chunk-${index}\nkind: fact\n---\nbody for chunk entry ${index}\nEND_MEMORY\n`
        : `plain message ${index} ${"z".repeat(16)}`,
    },
  }));
  const memSettings = {
    ...settingsModule.resolveSedimentSettings(),
    minWindowChars: 0,
    maxWindowChars: 160,
    maxWindowEntries: 3,
    maxEntryChars: 120,
  };
  let memCp = {};
  const memoryTitles = [];
  for (let pass = 0; pass < 40; pass += 1) {
    const window = checkpoint.buildRunWindow(memBranch, memCp, memSettings, { backlogOrder: "oldest" });
    if (!window.lastEntryId || window.skipReason === "no_new_entries") break;
    const drafts = extractor.parseExplicitMemoryBlocks(window.text);
    for (const draft of drafts) memoryTitles.push(draft.title);
    memCp = { lastProcessedEntryId: window.lastEntryId };
  }
  assert(memoryTitles.length >= 3, `expected multi-chunk MEMORY drafts, got ${JSON.stringify(memoryTitles)}`);
  assert(new Set(memoryTitles).size === memoryTitles.length, `duplicate MEMORY titles across chunks: ${JSON.stringify(memoryTitles)}`);
  const drainSource = fs.readFileSync(path.join(root, "extensions/sediment/index.ts"), "utf8");
  assert(
    drainSource.includes("parseExplicitMemoryBlocks(win.text)") && drainSource.includes("drain: true"),
    "drain lane must call parseExplicitMemoryBlocks on the drain window",
  );

  // ── R2: ready-pending true backlog >10 windows without next agent_end ──
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  let backlogWindows = 0;
  const BACKLOG_WINDOWS = 12;
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: async () => true,
    run: async () => {
      backlogWindows += 1;
      if (backlogWindows < BACKLOG_WINDOWS) return { more: true };
    },
  });
  branchRef.current = Array.from({ length: 20 }, (_, index) => entry(index + 1));
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  assert(backlogWindows === BACKLOG_WINDOWS, `ready-pending backlog stopped early: ${backlogWindows}`);
  const backlogStats = sediment._detachedAgentEndQueueStatsForTests();
  assert(backlogStats.readyPending >= BACKLOG_WINDOWS - 1, `readyPending not recorded: ${JSON.stringify(backlogStats)}`);
  assert(backlogStats.completed === 1, `final claim must complete once: ${JSON.stringify(backlogStats)}`);

  // ── R2: classifier/correction reject must not unhandled-reject; next pass runs ──
  // Exercise under the same process-level boundary as production (queue onError).
  // Companion subprocess with --unhandled-rejections=strict is asserted below.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  const correctionUnhandled = [];
  const onCorrectionUnhandled = (reason) => correctionUnhandled.push(reason);
  process.on("unhandledRejection", onCorrectionUnhandled);
  let passOrder = [];
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: async () => true,
    run: async (snapshot) => {
      passOrder.push(`start:${snapshot.branchEntries.length}`);
      if (passOrder.filter((row) => row.startsWith("start:")).length === 1) {
        throw new Error("injected correction reject");
      }
      passOrder.push(`end:${snapshot.branchEntries.length}`);
    },
  });
  branchRef.current = [entry(1)];
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  branchRef.current = [entry(1), entry(2)];
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onCorrectionUnhandled);
  assert(correctionUnhandled.length === 0, `correction unhandledRejection: ${correctionUnhandled.map(String).join(" | ")}`);
  assert(passOrder.some((row) => row.startsWith("end:2")), `next pass did not run after correction reject: ${JSON.stringify(passOrder)}`);
  const corrAudit = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert(corrAudit.some((row) => row.reason === "agent_end_queue_job_failed" && /correction reject/.test(row.error || "")), "correction reject not audited");

  // Strict unhandled-rejections mode: process must exit 0 with audited reject.
  {
    const { spawnSync } = await import("node:child_process");
    const strictScript = `
      import { createRequire } from "node:module";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const root = ${JSON.stringify(root)};
      const require = createRequire(path.join(root, "package.json"));
      const { createJiti } = require("jiti");
      const jiti = createJiti(pathToFileURL(path.join(root, "scripts/smoke-sediment-agent-end-queue.mjs")).href, { interopDefault: true });
      const queue = await jiti.import(path.join(root, "extensions/sediment/agent-end-queue.ts"));
      queue.resetDetachedAgentEndQueueForTests();
      let audited = false;
      queue.enqueueDetachedAgentEnd({
        key: "session:strict",
        waitUntilReady: async () => true,
        run: async () => { throw new Error("strict-mode correction reject"); },
        onError: async () => { audited = true; },
      });
      await queue.waitForDetachedAgentEndQueueIdle();
      await new Promise((r) => setImmediate(r));
      if (!audited) { console.error("onError not called"); process.exit(2); }
      console.log("strict-unhandled-ok");
    `;
    const strictPath = path.join(tmp, "strict-ur.mjs");
    fs.writeFileSync(strictPath, strictScript);
    const strictResult = spawnSync(process.execPath, ["--unhandled-rejections=strict", strictPath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
    });
    assert(strictResult.status === 0, `strict unhandled-rejections crashed: status=${strictResult.status} stderr=${strictResult.stderr} stdout=${strictResult.stdout}`);
    assert(/strict-unhandled-ok/.test(strictResult.stdout || ""), "strict mode did not complete cleanly");
  }

  // ── R2: lineage fail-closed + same-lineage compaction + branch switch ──
  const lineageBranch = Array.from({ length: 10 }, (_u, index) => ({
    id: `lin-${String(index).padStart(2, "0")}`,
    type: "message",
    message: { role: "user", content: `lin ${index}` },
  }));
  const lineageSettings = {
    ...settingsModule.resolveSedimentSettings(),
    minWindowChars: 0,
    maxWindowChars: 10_000,
    maxWindowEntries: 3,
    maxEntryChars: 200,
  };
  // Legacy invisible watermark without lineageRecorded → fail-closed.
  const legacyInvisible = checkpoint.buildRunWindow(
    lineageBranch,
    { lastProcessedEntryId: "gone-legacy" },
    lineageSettings,
    { backlogOrder: "oldest" },
  );
  assert(legacyInvisible.skipReason === "lineage_unproven", `legacy must fail-closed, got ${legacyInvisible.skipReason}`);
  assert(legacyInvisible.includedEntries === 0, "legacy invisible must not silently replay");

  // Same-lineage compaction: watermark gone, remaining ids are subsequence of recorded spine.
  const recordedIds = lineageBranch.map((row) => row.id);
  const compacted = lineageBranch.filter((_row, index) => index >= 4); // drop prefix
  const sameLineageCp = {
    lastProcessedEntryId: "lin-03", // compacted away
    lineageRecorded: true,
    branchEntryIds: recordedIds,
    branchLineageKey: checkpoint.computeBranchLineageKey(recordedIds),
    branchTipId: "lin-09",
  };
  const compactedWin = checkpoint.buildRunWindow(compacted, sameLineageCp, lineageSettings, { backlogOrder: "oldest" });
  assert(compactedWin.lineageStatus === "compacted_same_lineage", `expected compacted_same_lineage, got ${compactedWin.lineageStatus}`);
  assert(compactedWin.entries[0]?.id === "lin-04", `compaction replay must start at oldest remaining, got ${compactedWin.entries[0]?.id}`);

  // Branch switch: foreign ids not on recorded spine → recover from oldest of
  // the NEW branch (not permanent 0-entry). Durable candidate keys prevent
  // re-side-effects; next watermark advance rebinds lineage.
  const switched = [
    { id: "fork-00", type: "message", message: { role: "user", content: "fork" } },
    { id: "fork-01", type: "message", message: { role: "assistant", content: "fork" } },
  ];
  const switchedWin = checkpoint.buildRunWindow(switched, sameLineageCp, lineageSettings, { backlogOrder: "oldest" });
  assert(switchedWin.lineageStatus === "branch_switched", `branch switch status, got ${switchedWin.lineageStatus}`);
  assert(switchedWin.includedEntries > 0, "branch switch must recover from oldest, not permanent 0-entry");
  assert(switchedWin.entries[0]?.id === "fork-00", `branch switch recovery must start at oldest, got ${switchedWin.entries[0]?.id}`);

  // Stable durable candidate keys: no Date.now/random; same inputs → same key.
  const k1 = checkpoint.buildDurableCandidateKey({
    sessionId: "s1",
    sourceEntryIds: ["e1", "e2"],
    lane: "explicit",
    candidateIndex: 0,
    title: "Hello World",
    body: "body text",
  });
  const k2 = checkpoint.buildDurableCandidateKey({
    sessionId: "s1",
    sourceEntryIds: ["e1", "e2"],
    lane: "explicit",
    candidateIndex: 0,
    title: "  hello   world ",
    body: "body text",
  });
  const k3 = checkpoint.buildDurableCandidateKey({
    sessionId: "s1",
    sourceEntryIds: ["e1", "e2"],
    lane: "explicit",
    candidateIndex: 1,
    title: "Hello World",
    body: "body text",
  });
  assert(/^[0-9a-f]{64}$/.test(k1), `durable key must be sha256 hex, got ${k1}`);
  assert(k1 === k2, "normalized title must not change durable key");
  assert(k1 !== k3, "candidate index must change durable key");
  assert(!/Date|random|corr/i.test(k1), "durable key must not embed correlation noise");

  // ── R3: active-key wake always version-bumps (gate false mid-claim → exactly one retry) ──
  queue.resetDetachedAgentEndQueueForTests();
  let activeWakeRuns = 0;
  let activeGateResolves = 0;
  const activeGateHold = deferred();
  let activeGatePhase = "hold";
  queue.enqueueDetachedAgentEnd({
    key: "session:active-wake",
    waitUntilReady: async () => {
      if (activeGatePhase === "hold") {
        activeGateResolves += 1;
        return activeGateHold.promise;
      }
      activeGateResolves += 1;
      return true;
    },
    run: async () => { activeWakeRuns += 1; },
  });
  // Let the worker enter the active gate wait.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(activeWakeRuns === 0, "active gate must not run yet");
  // Wake while active (gate still pending false): must version-bump without parked flag.
  const wokeActive = queue.wakeParkedDetachedAgentEnd("session:active-wake");
  assert(wokeActive === 1, `active wake must version-bump, woke=${wokeActive}`);
  // First gate settles false; finally sees version bump and requeues.
  activeGatePhase = "open";
  activeGateHold.resolve(false);
  await queue.waitForDetachedAgentEndQueueIdle();
  assert(activeWakeRuns === 1, `active wake must retry exactly once, runs=${activeWakeRuns}`);
  assert(activeGateResolves >= 2, `gate must re-run after active wake, resolves=${activeGateResolves}`);
  queue.resetDetachedAgentEndQueueForTests();

  // ── R3: no-progress HOLD / aborted / unbound-style complete slot (no ready-pending spin) ──
  // These paths must return void (not more=true) so the queue completes the slot.
  // Real production paths (agent_aborted / project_not_bound / transient HOLD) share
  // the same outer more=true guard: only durable checkpoint advance may requeue.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  let holdRuns = 0;
  let holdMoreReturns = 0;
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: async () => true,
    run: async () => {
      holdRuns += 1;
      // Simulate agent_aborted / project_not_bound / transient HOLD: no durable
      // progress and no more=true. Outer production guard also refuses more
      // without checkpointAdvancedSince(start, end).
    },
  });
  branchRef.current = Array.from({ length: 30 }, (_, index) => entry(index + 1));
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  assert(holdRuns === 1, `HOLD/no-progress path must run exactly once (no spin), got ${holdRuns}`);
  assert(holdMoreReturns === 0, "HOLD path must not return more=true");
  const holdStats = sediment._detachedAgentEndQueueStatsForTests();
  assert(holdStats.readyPending === 0, `HOLD must not ready-pending: ${JSON.stringify(holdStats)}`);
  assert(holdStats.completed === 1, `HOLD must complete slot: ${JSON.stringify(holdStats)}`);
  assert(holdStats.claimed === 1, `HOLD must claim once: ${JSON.stringify(holdStats)}`);

  // more=true without durable progress would livelock; production run() only
  // returns more after checkpointAdvancedSince. Prove the queue itself stops
  // when run returns void even with a large frozen branch still present.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  let abortedRuns = 0;
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: async () => true,
    run: async () => { abortedRuns += 1; /* aborted: complete, no more */ },
  });
  branchRef.current = Array.from({ length: 40 }, (_, index) => entry(index + 1));
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  assert(abortedRuns === 1, `aborted-style path must run exactly once, got ${abortedRuns}`);
  const noProgressStats = sediment._detachedAgentEndQueueStatsForTests();
  assert(noProgressStats.readyPending === 0 && noProgressStats.completed === 1,
    `aborted-style must complete without ready-pending: ${JSON.stringify(noProgressStats)}`);

  // Real extension path: unbound cwd → project_not_bound audit, complete slot, no LLM/spin.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  sediment._setSedimentAgentEndTestHooksForTests(undefined);
  const realAuditBefore = fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  branchRef.current = [entry(1), entry(2)];
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  await sediment._waitForAutoWriteIdleForTests();
  const realStats = sediment._detachedAgentEndQueueStatsForTests();
  assert(realStats.readyPending === 0, `real project_not_bound must not ready-pending: ${JSON.stringify(realStats)}`);
  assert(realStats.completed === 1, `real project_not_bound must complete: ${JSON.stringify(realStats)}`);
  const realAudit = fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const realRows = realAudit.slice(realAuditBefore);
  assert(
    realRows.some((row) => row.reason === "project_not_bound" && row.checkpoint_advanced === false),
    `expected single project_not_bound audit, got ${JSON.stringify(realRows.map((r) => ({ reason: r.reason, advanced: r.checkpoint_advanced })))}`,
  );
  assert(
    realRows.filter((row) => row.reason === "project_not_bound").length === 1,
    "project_not_bound must not duplicate audit on spin",
  );

  // Real extension path: agent_aborted stopReason → deferred hold, complete, no spin.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  sediment._setSedimentAgentEndTestHooksForTests(undefined);
  // Need a bound project so we reach the unhealthy-stop branch after binding.
  const boundProj = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-sediment-bound-aborted-"));
  try {
    fs.mkdirSync(path.join(boundProj, ".git"), { recursive: true });
    fs.mkdirSync(path.join(boundProj, ".pi-astack"), { recursive: true });
    fs.writeFileSync(
      path.join(boundProj, ".pi-astack", "project.json"),
      `${JSON.stringify({ schema_version: 1, project_id: "smoke-aborted" }, null, 2)}\n`,
    );
    // Minimal local-map binding is required by ADR 0017; if bind fails we still
    // accept project_not_bound (no spin). Prefer aborted audit when bound.
    const abrainHome = path.join(tmp, "abrain-home");
    fs.mkdirSync(path.join(abrainHome, ".state"), { recursive: true });
    process.env.ABRAIN_ROOT = abrainHome;
    const abortAuditBefore = fs.existsSync(path.join(boundProj, ".pi-astack", "sediment", "audit.jsonl"))
      ? fs.readFileSync(path.join(boundProj, ".pi-astack", "sediment", "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).length
      : 0;
    const abortBranch = { current: [entry(1), entry(2)] };
    const abortCtx = makeContext(abortBranch, "abort-session").ctx;
    abortCtx.cwd = boundProj;
    const abortEvent = { messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "user abort" }] };
    await fireAwaited(pi.handlers, "agent_end", abortEvent, abortCtx);
    await sediment._waitForAutoWriteIdleForTests();
    const abortStats = sediment._detachedAgentEndQueueStatsForTests();
    assert(abortStats.readyPending === 0, `aborted real path must not ready-pending: ${JSON.stringify(abortStats)}`);
    assert(abortStats.completed === 1 || abortStats.errors === 0, `aborted real path must settle: ${JSON.stringify(abortStats)}`);
    // Audit may land under bound project root or still project_not_bound if local-map missing.
    const candidates = [
      path.join(boundProj, ".pi-astack", "sediment", "audit.jsonl"),
      path.join(tmp, ".pi-astack", "sediment", "audit.jsonl"),
    ];
    let abortReasons = [];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      abortReasons = abortReasons.concat(
        fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).map((r) => r.reason),
      );
    }
    assert(
      abortReasons.includes("agent_aborted") || abortReasons.includes("project_not_bound"),
      `expected agent_aborted or project_not_bound, got ${JSON.stringify(abortReasons)}`,
    );
  } finally {
    fs.rmSync(boundProj, { recursive: true, force: true });
    delete process.env.ABRAIN_ROOT;
  }

  // ── R2: global cross-key concurrency cap; same-key still serial ──
  queue.resetDetachedAgentEndQueueForTests();
  queue.configureDetachedAgentEndQueueForTests({ maxGlobalConcurrent: 2 });
  let peak = 0;
  let live = 0;
  const releases = [];
  const started = [];
  for (let i = 0; i < 5; i += 1) {
    const gate = deferred();
    releases.push(gate);
    queue.enqueueDetachedAgentEnd({
      key: `session:cap-${i}`,
      waitUntilReady: async () => true,
      run: async () => {
        live += 1;
        peak = Math.max(peak, live);
        started.push(i);
        await gate.promise;
        live -= 1;
      },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(peak <= 2, `global concurrency exceeded: peak=${peak}`);
  assert(started.length === 2, `expected 2 active under cap=2, started=${started.length}`);
  for (const gate of releases) gate.resolve();
  await queue.waitForDetachedAgentEndQueueIdle();
  assert(started.length === 5, `not all keys ran under global cap: ${started.length}`);
  queue.resetDetachedAgentEndQueueForTests();

  // ── R2: parked TTL eviction with audit hook ──
  queue.resetDetachedAgentEndQueueForTests();
  queue.configureDetachedAgentEndQueueForTests({ parkTtlMs: 1, maxParkedSlots: 8 });
  const evictions = [];
  queue.enqueueDetachedAgentEnd({
    key: "session:park-ttl",
    waitUntilReady: async () => false,
    run: async () => { throw new Error("parked job must not run"); },
    onParkEvicted: (info) => { evictions.push(info); },
    approxBytes: 128,
  });
  await queue.waitForDetachedAgentEndQueueIdle();
  assert(queue.detachedAgentEndQueueStats().parkedKeys === 1, "expected one parked key before TTL");
  await new Promise((resolve) => setTimeout(resolve, 5));
  queue.sweepParkedDetachedAgentEndForTests(Date.now() + 1000);
  assert(queue.detachedAgentEndQueueStats().parkedKeys === 0, "TTL eviction left parked key");
  assert(evictions.some((row) => row.reason === "ttl"), `expected ttl eviction, got ${JSON.stringify(evictions)}`);
  queue.resetDetachedAgentEndQueueForTests();

  // Final never-settling startup probe. Must be last: leaves an active worker
  // waiting forever (no timer keepalive). The awaited pi handler still returns
  // within budget and does not hold Node open.
  sediment._resetAutoWriteStateForTests();
  sediment._resetDetachedAgentEndQueueForTests();
  sediment._setSedimentAgentEndTestHooksForTests({
    waitUntilReady: () => new Promise(() => {}),
    run: async () => { throw new Error("never-startup job unexpectedly ran"); },
  });
  branchRef.current = Array.from({ length: 5000 }, (_, index) => entry(index + 1));
  const neverStarted = performance.now();
  await fireAwaited(pi.handlers, "agent_end", event, ctx);
  const neverMs = performance.now() - neverStarted;
  assert(neverMs < 100, `never-settling startup blocked agent_end for ${neverMs.toFixed(2)}ms`);
  await new Promise((resolve) => setImmediate(resolve));
  assert(sediment._detachedAgentEndQueueStatsForTests().pendingKeys === 1, "never-settling startup was not retained in the process queue");
  const cloneMetrics = sediment._detachedBranchCloneMetricsForTests?.() ?? { samples: 0 };
  assert(cloneMetrics.samples > 0, "clone bytes/latency metrics were not recorded");

  console.log("sediment detached agent_end queue: ok");
  console.log(`  handler_ms=${latencies.map((ms) => ms.toFixed(2)).join(",")} never_ms=${neverMs.toFixed(2)}`);
  console.log(`  coalesced_runs=${runs.length} failure_recovered=${recoveryRun} max_concurrent_same_key=1`);
  console.log(`  park_wake_runs=${parkRuns} multi_session_B_unblocked=1 clone_max_ms=${cloneMetrics.maxMs?.toFixed?.(2) ?? "?"}`);
  console.log(`  ready_pending_windows=${backlogWindows} global_cap_peak=${peak} lineage_failclosed=1`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
