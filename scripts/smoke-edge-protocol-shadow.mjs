#!/usr/bin/env node
/**
 * Focused smoke for ADR 0044 Pi-side capture-only protocol shadow.
 *
 * Covers: source-before-candidate, modes 0600/0700, content id/idempotency,
 * concurrent cross-process producer_seq + distinct process writer epochs,
 * same-C6 run_generation (=producer_seq) increment, C6 stability, agent_settled
 * witness without seal, disabled zero products, strict source-failure fault
 * injection, cross-process restart seq continuity from record filenames only
 * (no writer-state), journal body no raw leak, strict tsc.
 *
 * Never prints raw message bodies or sensitive absolute paths.
 * Always deletes the temp root on exit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const childMode = process.argv.find((a) => a.startsWith("--child="))?.slice("--child=".length);
const tmp = process.env.SMOKE_EDGE_TMP || fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-shadow-"));
const abrainHome = process.env.SMOKE_EDGE_ABRAIN || path.join(tmp, "abrain");
const ownerRoot = process.env.SMOKE_EDGE_OWNER || path.join(tmp, "owner-project");
const sessionId = process.env.SMOKE_EDGE_SESSION || "sess-edge-smoke-001";

// Parent owns lifecycle of temp root created here.
const ownsTmp = !process.env.SMOKE_EDGE_TMP;

function assert(v, msg) {
  if (!v) throw new Error(msg);
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

function sha(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function loadMod() {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  return jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));
}

function spawnChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// ── child: concurrent producer_seq race ──────────────────────────────
if (childMode === "producer") {
  const edge = await loadMod();
  const c6 = {
    session_id: sessionId,
    turn_id: Number(process.env.SMOKE_EDGE_TURN || 7),
  };
  const n = Number(process.env.SMOKE_EDGE_N || 8);
  const childId = process.env.SMOKE_EDGE_CHILD || String(process.pid);
  const processEpoch = edge.getProcessJournalWriterEpoch();
  for (let i = 0; i < n; i += 1) {
    const messages = [
      { role: "user", content: [{ type: "text", text: `child-${childId}-msg-${i}` }] },
      { role: "assistant", content: [{ type: "text", text: `reply-${childId}-${i}` }], stopReason: "stop" },
    ];
    const r = await edge.captureEdgeProtocolCandidate({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
      messages,
      c6: { ...c6, turn_id: c6.turn_id },
    });
    if (r.status !== "captured") {
      process.stderr.write(`CHILD_FAIL ${r.error_code || r.status}\n`);
      process.exit(2);
    }
    // seq\tepoch per line — parent validates uniqueness + multi-epoch.
    process.stdout.write(`${r.record.producer_seq}\t${r.record.session_writer_epoch}\t${processEpoch}\n`);
  }
  process.exit(0);
}

// ── child: race candidates while peer writes witnesses ───────────────
if (childMode === "race-cand") {
  const edge = await loadMod();
  const n = Number(process.env.SMOKE_EDGE_N || 12);
  const c6 = { session_id: sessionId, turn_id: Number(process.env.SMOKE_EDGE_TURN || 55) };
  for (let i = 0; i < n; i += 1) {
    const r = await edge.captureEdgeProtocolCandidate({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
      messages: [{ role: "user", content: `race-cand-${process.pid}-${i}` }],
      c6,
    });
    if (r.status !== "captured") {
      process.stderr.write(`RACE_CAND_FAIL ${r.error_code || r.status}\n`);
      process.exit(2);
    }
    process.stdout.write(`cand\t${r.record.producer_seq}\t${r.record.record_id}\n`);
  }
  process.exit(0);
}

if (childMode === "race-wit") {
  const edge = await loadMod();
  const n = Number(process.env.SMOKE_EDGE_N || 12);
  const c6 = { session_id: sessionId, turn_id: Number(process.env.SMOKE_EDGE_TURN || 55) };
  // Brief yield so peer cand cold-start can land; parent also seeds one candidate.
  await new Promise((r) => setTimeout(r, 20));
  let written = 0;
  for (let i = 0; i < n; i += 1) {
    const w = await edge.writeEdgeTerminalWitness({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
      c6,
      leafTip: { id: `wit-leaf-${i}`, parentId: null, type: "message" },
    });
    if (w.status === "written") {
      written += 1;
      process.stdout.write(
        `wit\t${w.record.producer_seq}\t${w.record.candidate_ref.producer_seq}\t${w.record.candidate_ref.record_id}\n`,
      );
    } else if (w.status === "no_candidate") {
      process.stdout.write(`wit\tnone\n`);
    } else {
      process.stderr.write(`RACE_WIT_FAIL ${w.error_code || w.status}\n`);
      process.exit(2);
    }
  }
  if (written === 0) {
    process.stderr.write("RACE_WIT_FAIL zero_written\n");
    process.exit(2);
  }
  process.exit(0);
}

// ── child: real extension wiring (isolated process; no global C6/settings pollution)
if (childMode === "ext-wiring") {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const mode = process.env.SMOKE_EDGE_WIRING_MODE || "edge-only";
  const work = process.env.SMOKE_EDGE_WIRING_TMP;
  if (!work) {
    process.stderr.write("missing SMOKE_EDGE_WIRING_TMP\n");
    process.exit(2);
  }
  const abrain = path.join(work, "abrain");
  const owner = path.join(work, "owner");
  const sessionsDir = path.join(work, "sessions");
  const settingsPath = path.join(work, "settings.json");
  fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
  fs.mkdirSync(owner, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

  const edgeEnabled = mode !== "edge-off";
  const sedimentEnabled = mode === "both";
  fs.writeFileSync(settingsPath, JSON.stringify({
    canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
    sediment: {
      enabled: sedimentEnabled,
      edgeProtocolShadow: { enabled: edgeEnabled },
      autoLlmWriteEnabled: false,
    },
  }));
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  process.env.ABRAIN_ROOT = abrain;
  delete process.env.PI_ASTACK_EDGE_PROTOCOL_SHADOW;

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const edge = await jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));
  const intake = await jiti.import(path.join(root, "extensions/sediment/intake.ts"));

  const handlers = new Map();
  const pi = {
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
  };
  const activate = sediment.default ?? sediment;
  activate(pi);

  // Semantic worker no-op (must not replace capture/IO).
  if (typeof sediment._setSedimentAgentEndTestHooksForTests === "function") {
    sediment._setSedimentAgentEndTestHooksForTests({ run: async () => {} });
  }

  const sessionId = "wiring-sess-001";
  const userId = "u0000001";
  const tipId = "a0000002";
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-07-24T10:00:00.000Z",
    cwd: owner,
  };
  const userEntry = {
    type: "message",
    id: userId,
    parentId: null,
    timestamp: "2026-07-24T10:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "wiring user" }],
      timestamp: Date.parse("2026-07-24T10:00:01.000Z"),
    },
  };
  const tipEntry = {
    type: "message",
    id: tipId,
    parentId: userId,
    timestamp: "2026-07-24T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "wiring assistant" }],
      timestamp: Date.parse("2026-07-24T10:00:02.000Z"),
      stopReason: "stop",
    },
  };
  fs.writeFileSync(sessionFile, [header, userEntry, tipEntry].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const sm = SessionManager.open(sessionFile);
  const ctx = {
    mode: "tui",
    cwd: owner,
    sessionManager: sm,
    modelRegistry: undefined,
    ui: { notify() {}, setStatus() {} },
  };
  async function fire(name, event) {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  }

  // session_start must create edge layout when enabled (no private mkdir).
  const sessionRootBefore = edge.edgeSessionRoot(abrain, owner, sessionId);
  const layoutBeforeStart = fs.existsSync(edge.edgeJournalRecordsDir(sessionRootBefore));
  await fire("session_start", { reason: "startup" });
  const layoutAfterStart = fs.existsSync(edge.edgeJournalRecordsDir(sessionRootBefore));
  // Multi-turn same session: two assistant turns with progressive messages.
  const user2Id = "u0000003";
  const tip2Id = "a0000004";
  const user2 = {
    role: "user",
    content: [{ type: "text", text: "wiring user turn2" }],
    timestamp: Date.parse("2026-07-24T10:00:03.000Z"),
  };
  const tip2 = {
    role: "assistant",
    content: [{ type: "text", text: "wiring assistant turn2" }],
    timestamp: Date.parse("2026-07-24T10:00:04.000Z"),
    stopReason: "stop",
  };

  await fire("before_agent_start", { systemPrompt: "" });
  const messages1 = [userEntry.message, tipEntry.message];
  await fire("agent_end", { messages: messages1 });
  await fire("agent_settled", {});

  // Append second turn into the same SessionManager leaf chain.
  // (open already has tip; append via new entries would need file rewrite —
  // for wiring we re-open with both turns written.)
  const user2Entry = {
    type: "message",
    id: user2Id,
    parentId: tipId,
    timestamp: "2026-07-24T10:00:03.000Z",
    message: user2,
  };
  const tip2Entry = {
    type: "message",
    id: tip2Id,
    parentId: user2Id,
    timestamp: "2026-07-24T10:00:04.000Z",
    message: tip2,
  };
  fs.writeFileSync(
    sessionFile,
    [header, userEntry, tipEntry, user2Entry, tip2Entry].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  // Re-open so leaf advances to tip2.
  const sm2 = SessionManager.open(sessionFile);
  ctx.sessionManager = sm2;
  await fire("before_agent_start", { systemPrompt: "" });
  const messages2 = [userEntry.message, tipEntry.message, user2, tip2];
  await fire("agent_end", { messages: messages2 });
  await fire("agent_settled", {});

  // Drain controllable queue work (timing not measured here).
  if (typeof sediment._waitForAutoWriteIdleForTests === "function") {
    await sediment._waitForAutoWriteIdleForTests();
  }

  const pending = await intake.listSedimentIntakePendingForSession(abrain, sessionId);
  const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
  const records = await edge.listEdgeJournalRecords(sessionRoot);
  const cands = records.filter((r) => r.record_type === "candidate_capture");
  const wits = records.filter((r) => r.record_type === "terminal_witness");
  const edgeRootExists = edge.edgeProtocolShadowExistsSync(abrain);
  const seqs = records.map((r) => r.producer_seq).sort((a, b) => a - b);
  const turnIds = cands.map((c) => c.c6?.turn_id);
  const lastCand = cands[cands.length - 1];
  const lastWit = wits[wits.length - 1];

  const ownerResolveCount = typeof sediment._captureOwnerResolveCountForTests === "function"
    ? sediment._captureOwnerResolveCountForTests()
    : null;

  const out = {
    mode,
    pending_count: pending.length,
    candidate_count: cands.length,
    witness_count: wits.length,
    edge_root_exists: edgeRootExists,
    layout_before_session_start: layoutBeforeStart,
    layout_after_session_start: layoutAfterStart,
    c6_session: cands[0]?.c6?.session_id ?? null,
    cand_leaf: lastCand?.leaf_tip?.id ?? null,
    wit_leaf: lastWit?.leaf_tip?.id ?? null,
    terminal_seal: lastCand?.capabilities?.terminal_seal ?? null,
    settlement: lastWit?.settlement_status ?? null,
    live_tip: tip2Id,
    producer_seqs: seqs,
    candidate_turn_ids: turnIds,
    last_wit_ref_seq: lastWit?.candidate_ref?.producer_seq ?? null,
    last_cand_seq: lastCand?.producer_seq ?? null,
    owner_resolve_count: ownerResolveCount,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

// ── child: toolUse mid-loop must not create extra edge turn ───────────
if (childMode === "ext-tooluse") {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const work = process.env.SMOKE_EDGE_WIRING_TMP;
  if (!work) {
    process.stderr.write("missing SMOKE_EDGE_WIRING_TMP\n");
    process.exit(2);
  }
  const abrain = path.join(work, "abrain");
  const owner = path.join(work, "owner");
  const sessionsDir = path.join(work, "sessions");
  const settingsPath = path.join(work, "settings.json");
  fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
  fs.mkdirSync(owner, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify({
    canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
    sediment: {
      enabled: true,
      edgeProtocolShadow: { enabled: true },
      autoLlmWriteEnabled: false,
    },
  }));
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  process.env.ABRAIN_ROOT = abrain;
  delete process.env.PI_ASTACK_EDGE_PROTOCOL_SHADOW;

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const edge = await jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));

  const handlers = new Map();
  const pi = {
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
  };
  (sediment.default ?? sediment)(pi);
  if (typeof sediment._setSedimentAgentEndTestHooksForTests === "function") {
    sediment._setSedimentAgentEndTestHooksForTests({ run: async () => {} });
  }

  const sessionId = "wiring-tooluse-001";
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-07-24T10:00:00.000Z",
    cwd: owner,
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  const sm = SessionManager.open(sessionFile, sessionsDir, owner);
  const ctx = {
    mode: "tui",
    cwd: owner,
    sessionManager: sm,
    modelRegistry: undefined,
    ui: { notify() {}, setStatus() {} },
  };
  async function fire(name, event) {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  }

  await fire("session_start", { reason: "startup" });

  // One complete run: user → toolUse assistant → toolResult → terminal assistant.
  // Only ONE before_agent_start + ONE agent_end/settled at the terminal.
  const user = {
    role: "user",
    content: [{ type: "text", text: "please use a tool" }],
    timestamp: Date.parse("2026-07-24T10:00:01.000Z"),
  };
  const toolCall = {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "true" } }],
    timestamp: Date.parse("2026-07-24T10:00:02.000Z"),
    stopReason: "toolUse",
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: Date.parse("2026-07-24T10:00:03.000Z"),
  };
  const terminal = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: Date.parse("2026-07-24T10:00:04.000Z"),
    stopReason: "stop",
  };

  await fire("before_agent_start", { systemPrompt: "" });
  sm.appendMessage(user);
  sm.appendMessage(toolCall);
  sm.appendMessage(toolResult);
  sm.appendMessage(terminal);
  const messages = [user, toolCall, toolResult, terminal];
  await fire("agent_end", { messages });
  await fire("agent_settled", {});
  if (typeof sediment._waitForAutoWriteIdleForTests === "function") {
    await sediment._waitForAutoWriteIdleForTests();
  }

  const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
  const records = await edge.listEdgeJournalRecords(sessionRoot);
  const cands = records.filter((r) => r.record_type === "candidate_capture");
  const wits = records.filter((r) => r.record_type === "terminal_witness");
  process.stdout.write(JSON.stringify({
    candidate_count: cands.length,
    witness_count: wits.length,
    candidate_turn_ids: cands.map((c) => c.c6?.turn_id),
    producer_seqs: records.map((r) => r.producer_seq).sort((a, b) => a - b),
  }) + "\n");
  process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(ownerRoot, { recursive: true, mode: 0o700 });

const edge = await loadMod();
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

function cleanup() {
  if (!ownsTmp) return;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

console.log("edge-protocol-shadow capture-only");

const c6 = { session_id: sessionId, turn_id: 3, subturn: undefined };
const secretMarker = `SECRET_BODY_${sha("marker").slice(0, 12)}`;
const messages1 = [
  { role: "user", content: [{ type: "text", text: `hello ${secretMarker}` }] },
  { role: "assistant", content: [{ type: "text", text: "world" }], stopReason: "stop" },
];

try {
await check("source-before-candidate + modes + content id", async () => {
  const r = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId,
    messages: messages1,
    c6,
  });
  assert(r.status === "captured", `capture failed: ${r.error_code} ${r.error_detail}`);
  assert(r.source?.content_id, "missing content_id");
  assert(fs.existsSync(r.source.path), "source missing");
  assert(fs.existsSync(r.record_path), "candidate missing");
  assert(modeOf(r.source.path) === 0o600, `source mode ${modeOf(r.source.path).toString(8)}`);
  assert(modeOf(r.record_path) === 0o600, `record mode ${modeOf(r.record_path).toString(8)}`);

  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRoot, sessionId);
  const edgeRoot = edge.edgeProtocolShadowRoot(abrainHome);
  const ownerKey = edge.edgeOwnerKey(ownerRoot);
  // Edge-owned layout dirs created this round: edge root / owner / sessions / session / sources / journal / records / lock
  const dirs0700 = [
    edgeRoot,
    path.join(edgeRoot, "by-owner"),
    path.join(edgeRoot, "by-owner", ownerKey),
    path.join(edgeRoot, "by-owner", ownerKey, "sessions"),
    sessionRoot,
    edge.edgeSourcesDir(sessionRoot),
    edge.edgeJournalDir(sessionRoot),
    edge.edgeJournalRecordsDir(sessionRoot),
    edge.edgeJournalLockDir(sessionRoot),
  ];
  for (const d of dirs0700) {
    assert(fs.existsSync(d), `missing edge dir`);
    assert(modeOf(d) === 0o700, `dir mode not 0700: got ${modeOf(d).toString(8)}`);
  }
  // No secondary writer-state head — producer_seq truth is record filenames only.
  const writerState = path.join(edge.edgeJournalDir(sessionRoot), "writer-state.json");
  assert(!fs.existsSync(writerState), "writer-state.json must not exist");

  // content-addressed: re-capture identical messages → identical source create
  const r2 = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId,
    messages: messages1,
    c6,
  });
  assert(r2.status === "captured", "second capture failed");
  assert(r2.source.content_id === r.source.content_id, "content id drifted");
  assert(r2.source.status === "identical" || r2.source.status === "created", `unexpected source status ${r2.source.status}`);
  assert(r2.record.producer_seq === r.record.producer_seq + 1, "producer_seq not monotonic");
  assert(r2.record.run_generation === r2.record.producer_seq, "candidate run_generation must equal producer_seq");
  assert(r2.record.run_generation === r.record.run_generation + 1, "run_generation not incremented for same C6");
  assert(r2.record.c6.turn_id === c6.turn_id, "C6 turn_id drifted");
  assert(r2.record.c6.session_id === c6.session_id, "C6 session_id drifted");
  assert(typeof r2.record.session_writer_epoch === "string" && r2.record.session_writer_epoch.length > 0, "epoch must be non-empty string");
  assert(r2.record.session_writer_epoch === edge.getProcessJournalWriterEpoch(), "in-process epoch must be stable");
  // journal must not embed raw body
  const recRaw = fs.readFileSync(r.record_path, "utf8");
  assert(!recRaw.includes(secretMarker), "journal leaked raw body marker");
  assert(!recRaw.includes("\"messages\""), "journal contains messages field");
  assert(r.record.capabilities.terminal_seal === false, "must not claim terminal_seal");
  assert(r.record.capabilities.launch_broker === false, "must not claim launch_broker");
  assert(r.record.capabilities.session_transaction === false, "must not claim session_transaction");
});

await check("agent_settled witness refs latest candidate and does not seal", async () => {
  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRoot, sessionId);
  const before = await edge.listEdgeJournalRecords(sessionRoot);
  const latestCand = [...before].reverse().find((x) => x.record_type === "candidate_capture");
  assert(latestCand, "need a candidate first");
  const w = await edge.writeEdgeTerminalWitness({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId,
    c6,
    leafTip: { id: "leaf-1", parentId: null, type: "message", timestampUtc: "2026-07-24T00:00:00.000Z" },
  });
  assert(w.status === "written", `witness failed: ${w.error_code} ${w.error_detail}`);
  assert(w.record.record_type === "terminal_witness", "wrong type");
  assert(w.record.settlement_status === "unsupported_core_capability", "wrong settlement_status");
  assert(w.record.candidate_ref?.record_id === latestCand.record_id, "witness not pointing at latest candidate");
  assert(w.record.candidate_ref?.producer_seq === latestCand.producer_seq, "witness producer_seq mismatch");
  assert(w.record.capabilities.terminal_seal === false, "witness must not seal");
  assert(Array.isArray(w.record.deferred_by_missing_core), "missing deferred_by_missing_core");
  assert(w.record.deferred_by_missing_core.includes("terminal_seal"), "must defer terminal_seal");
  assert(w.record.deferred_by_missing_core.includes("launch_broker"), "must defer launch_broker");
  const recRaw = fs.readFileSync(w.record_path, "utf8");
  assert(!recRaw.includes(secretMarker), "witness journal leaked raw");
});

await check("disabled path zero products (fresh abrain)", async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-disabled-"));
  try {
    const abrain2 = path.join(tmp2, "abrain");
    fs.mkdirSync(abrain2, { recursive: true });
    assert(edge.edgeProtocolShadowExistsSync(abrain2) === false, "disabled must not create root");
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const settingsPath = path.join(tmp2, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ sediment: { enabled: true, edgeProtocolShadow: { enabled: false } } }));
    process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
    delete process.env.PI_ASTACK_EDGE_PROTOCOL_SHADOW;
    const settings = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
    const resolved = settings.resolveSedimentSettings();
    assert(resolved.edgeProtocolShadow.enabled === false, "default/settings disabled");
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

await check("source failure via test fault: status=source_failed, no candidate, record count unchanged", async () => {
  const sid = "sess-source-fail";
  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRoot, sid);
  const warm = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
    messages: [{ role: "user", content: "warmup" }],
    c6: { session_id: sid, turn_id: 1 },
  });
  assert(warm.status === "captured", `warmup failed: ${warm.error_code}`);
  const beforeRecs = await edge.listEdgeJournalRecords(sessionRoot);
  const beforeCount = beforeRecs.length;
  const beforeTurn2 = beforeRecs.filter((x) => x.record_type === "candidate_capture" && x.c6.turn_id === 2).length;
  assert(beforeTurn2 === 0, "precondition: no turn 2 candidate");

  edge._armSourceCreateFaultForTests();
  try {
    const r = await edge.captureEdgeProtocolCandidate({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId: sid,
      messages: [{ role: "user", content: `fail-${Date.now()}` }],
      c6: { session_id: sid, turn_id: 2 },
    });
    assert(r.status === "source_failed", `expected source_failed, got ${r.status} ${r.error_code}`);
    assert(!r.record, "must not write candidate when source fails");
    assert(!r.record_path, "must not have record_path on source_failed");
    const afterRecs = await edge.listEdgeJournalRecords(sessionRoot);
    assert(afterRecs.length === beforeCount, `record count increased after source fail: ${beforeCount} -> ${afterRecs.length}`);
    assert(!afterRecs.some((x) => x.record_type === "candidate_capture" && x.c6.turn_id === 2), "candidate written after source fail");
  } finally {
    edge._disarmSourceCreateFaultForTests();
  }

  // Production gate: without test hooks env, arming must throw and must not arm.
  const saved = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  try {
    delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    let threw = false;
    try {
      edge._armSourceCreateFaultForTests();
    } catch {
      threw = true;
    }
    assert(threw, "arm without PI_ASTACK_ENABLE_TEST_HOOKS must throw");
  } finally {
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = saved;
  }
});

await check("cross-process concurrent producer_seq uniqueness + multi process epochs", async () => {
  const raceSession = "sess-race-001";
  const envBase = {
    ...process.env,
    SMOKE_EDGE_TMP: tmp,
    SMOKE_EDGE_ABRAIN: abrainHome,
    SMOKE_EDGE_OWNER: ownerRoot,
    SMOKE_EDGE_SESSION: raceSession,
    SMOKE_EDGE_TURN: "99",
    SMOKE_EDGE_N: "8",
    PI_ASTACK_ENABLE_TEST_HOOKS: "1",
  };
  // True concurrent: spawn all three children then await together.
  const kids = await Promise.all([
    spawnChild([fileURLToPath(import.meta.url), "--child=producer"], { ...envBase, SMOKE_EDGE_CHILD: "0" }),
    spawnChild([fileURLToPath(import.meta.url), "--child=producer"], { ...envBase, SMOKE_EDGE_CHILD: "1" }),
    spawnChild([fileURLToPath(import.meta.url), "--child=producer"], { ...envBase, SMOKE_EDGE_CHILD: "2" }),
  ]);
  const seqs = [];
  const epochs = new Set();
  for (const kid of kids) {
    assert(kid.status === 0, `child failed status=${kid.status} stderr=${(kid.stderr || "").slice(0, 300)}`);
    for (const line of kid.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      const [seqStr, recEpoch, processEpoch] = line.split("\t");
      const seq = Number(seqStr);
      assert(Number.isInteger(seq) && seq >= 1, `bad seq ${seqStr}`);
      assert(recEpoch && processEpoch && recEpoch === processEpoch, "record epoch must equal process epoch");
      seqs.push(seq);
      epochs.add(recEpoch);
    }
  }
  assert(seqs.length === 24, `expected 24 seqs, got ${seqs.length}`);
  const set = new Set(seqs);
  assert(set.size === seqs.length, `duplicate producer_seq across processes`);
  const sorted = [...seqs].sort((a, b) => a - b);
  assert(sorted[0] === 1, `seq should start at 1, got ${sorted[0]}`);
  assert(sorted[sorted.length - 1] === 24, `max seq ${sorted[sorted.length - 1]}`);
  for (let i = 0; i < 24; i += 1) {
    assert(sorted[i] === i + 1, `seq not continuous at ${i}: ${sorted[i]}`);
  }
  assert(epochs.size >= 2, `expected multiple distinct session_writer_epoch, got ${epochs.size}`);
});

await check("cross-process restart continues producer_seq from record filenames only (no writer-state)", async () => {
  const sid = "sess-restart-seq";
  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRoot, sid);
  const a = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
    messages: [{ role: "user", content: "restart-a" }],
    c6: { session_id: sid, turn_id: 1 },
  });
  assert(a.status === "captured", a.error_detail);
  const b = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
    messages: [{ role: "user", content: "restart-b" }],
    c6: { session_id: sid, turn_id: 2 },
  });
  assert(b.status === "captured", b.error_detail);
  assert(b.record.producer_seq === a.record.producer_seq + 1, "precondition seq");
  const statePath = path.join(edge.edgeJournalDir(sessionRoot), "writer-state.json");
  assert(!fs.existsSync(statePath), "writer-state must not exist after captures");

  // Fresh process: continues solely from max record filename seq.
  const kid = await spawnChild(
    [fileURLToPath(import.meta.url), "--child=producer"],
    {
      ...process.env,
      SMOKE_EDGE_TMP: tmp,
      SMOKE_EDGE_ABRAIN: abrainHome,
      SMOKE_EDGE_OWNER: ownerRoot,
      SMOKE_EDGE_SESSION: sid,
      SMOKE_EDGE_TURN: "3",
      SMOKE_EDGE_N: "3",
      SMOKE_EDGE_CHILD: "restart",
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
    },
  );
  assert(kid.status === 0, `restart child failed status=${kid.status} ${kid.stderr}`);
  const childSeqs = kid.stdout.split("\n").map((s) => s.trim()).filter(Boolean).map((line) => Number(line.split("\t")[0]));
  assert(childSeqs.length === 3, `expected 3 child seqs, got ${childSeqs.length}`);
  assert(childSeqs[0] === b.record.producer_seq + 1, `restart first seq ${childSeqs[0]} expected ${b.record.producer_seq + 1}`);
  assert(childSeqs[1] === b.record.producer_seq + 2, "restart seq not continuous");
  assert(childSeqs[2] === b.record.producer_seq + 3, "restart seq not continuous");
  assert(!fs.existsSync(statePath), "writer-state must not appear after cross-process restart");

  // Parent process also continues from filenames after child writes.
  const c = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
    messages: [{ role: "user", content: "restart-c" }],
    c6: { session_id: sid, turn_id: 4 },
  });
  assert(c.status === "captured", c.error_detail);
  assert(c.record.producer_seq === b.record.producer_seq + 4, `parent after restart expected ${b.record.producer_seq + 4}, got ${c.record.producer_seq}`);
  assert(c.record.run_generation === c.record.producer_seq, "run_generation must equal producer_seq");
  assert(!fs.existsSync(statePath), "writer-state must remain absent");
});

await check("C6 fields never rewritten by run_generation", async () => {
  const sid = "sess-c6-stable";
  const base = { session_id: sid, turn_id: 42, sub_agent_label: "smoke" };
  const gens = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await edge.captureEdgeProtocolCandidate({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId: sid,
      messages: [{ role: "user", content: `c6-${i}` }],
      c6: base,
    });
    assert(r.status === "captured", r.error_detail);
    assert(r.record.c6.turn_id === 42, "turn_id mutated");
    assert(r.record.c6.sub_agent_label === "smoke", "sub_agent_label mutated");
    gens.push(r.record.run_generation);
  }
  assert(JSON.stringify(gens) === JSON.stringify([1, 2, 3]), `run_generation sequence ${JSON.stringify(gens)}`);
  // protocol-shadow: run_generation === producer_seq (session-monotonic)
  assert(gens.every((g, i) => g === i + 1), "run_generation must track producer_seq on fresh session");
  const statePath = path.join(edge.edgeJournalDir(edge.edgeSessionRoot(abrainHome, ownerRoot, sid)), "writer-state.json");
  assert(!fs.existsSync(statePath), "writer-state must not exist");
});

await check("toJsonSafe: shared objects full; true cycle only circular", async () => {
  const shared = { v: 1 };
  const root = { a: shared, b: shared };
  const safe = edge.toJsonSafe(root);
  assert(safe.a && safe.b, "shared missing");
  assert(safe.a.v === 1 && safe.b.v === 1, "shared not fully serialized at both sites");
  assert(!safe.a.circular && !safe.b.circular, "false circular on shared non-cycle");

  const cyc = { name: "self" };
  cyc.self = cyc;
  const csafe = edge.toJsonSafe(cyc);
  assert(csafe.self && csafe.self.circular === true, "true cycle must mark circular");
  assert(csafe.name === "self", "cycle root fields retained");
});

await check("sanitizeSessionId rejects pure-dot strings", async () => {
  for (const bad of [".", "..", "...", "...."]) {
    let threw = false;
    try {
      edge._sanitizeSessionIdForTests(bad);
    } catch (err) {
      threw = /pure-dot|invalid sessionId/.test(String(err?.message || err));
    }
    assert(threw, `expected pure-dot reject for ${JSON.stringify(bad)}`);
  }
  assert(edge._sanitizeSessionIdForTests("sess.ok-1") === "sess.ok-1", "normal id must pass");
  // edgeSessionRoot must throw for pure-dot rather than create path component
  let rootThrew = false;
  try {
    edge.edgeSessionRoot(abrainHome, ownerRoot, "..");
  } catch {
    rootThrew = true;
  }
  assert(rootThrew, "edgeSessionRoot must reject pure-dot sessionId");
});

await check("sessionId/c6.session_id mismatch fails closed before source IO", async () => {
  const sid = "sess-c6-match";
  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRoot, sid);
  const before = fs.existsSync(edge.edgeSourcesDir(sessionRoot))
    ? fs.readdirSync(edge.edgeSourcesDir(sessionRoot)).length
    : 0;
  const r = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
    messages: [{ role: "user", content: "mismatch" }],
    c6: { session_id: "other-session", turn_id: 1 },
  });
  assert(r.status === "source_failed" || r.status === "journal_failed", `unexpected status ${r.status}`);
  assert(r.error_code === "session_c6_mismatch", `code ${r.error_code}`);
  const after = fs.existsSync(edge.edgeSourcesDir(sessionRoot))
    ? fs.readdirSync(edge.edgeSourcesDir(sessionRoot)).length
    : 0;
  assert(after === before, "source written despite session/c6 mismatch");
  const w = await edge.writeEdgeTerminalWitness({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
    c6: { session_id: "other-session", turn_id: 1 },
  });
  assert(w.status === "journal_failed", `witness status ${w.status}`);
  assert(w.error_code === "session_c6_mismatch", `witness code ${w.error_code}`);
});

await check("cross-process candidate-vs-witness race refs lock-critical latest", async () => {
  const raceSession = "sess-wit-race";
  // Seed one candidate so witness path is not starved when cand process cold-starts.
  // Concurrent cand/wit still races lock-critical latest after this seed.
  const seed = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: raceSession,
    messages: [{ role: "user", content: "race-seed" }],
    c6: { session_id: raceSession, turn_id: 55 },
  });
  assert(seed.status === "captured", `race seed failed: ${seed.error_code}`);
  const envBase = {
    ...process.env,
    SMOKE_EDGE_TMP: tmp,
    SMOKE_EDGE_ABRAIN: abrainHome,
    SMOKE_EDGE_OWNER: ownerRoot,
    SMOKE_EDGE_SESSION: raceSession,
    SMOKE_EDGE_TURN: "55",
    SMOKE_EDGE_N: "16",
    PI_ASTACK_ENABLE_TEST_HOOKS: "1",
  };
  const [candKid, witKid] = await Promise.all([
    spawnChild([fileURLToPath(import.meta.url), "--child=race-cand"], envBase),
    spawnChild([fileURLToPath(import.meta.url), "--child=race-wit"], envBase),
  ]);
  assert(candKid.status === 0, `race-cand failed status=${candKid.status}`);
  assert(witKid.status === 0, `race-wit failed status=${witKid.status} ${witKid.stderr}`);
  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRoot, raceSession);
  const records = await edge.listEdgeJournalRecords(sessionRoot);
  const cands = records.filter((r) => r.record_type === "candidate_capture");
  const wits = records.filter((r) => r.record_type === "terminal_witness");
  assert(cands.length >= 1, "need candidates");
  assert(wits.length >= 1, "need witnesses");
  for (const w of wits) {
    assert(w.candidate_ref?.record_id, "witness missing candidate_ref");
    // Critical-section latest: among candidates with seq < witness.seq, max must equal ref.
    const prior = cands.filter((c) => c.producer_seq < w.producer_seq);
    assert(prior.length >= 1, `witness seq=${w.producer_seq} has no prior candidate`);
    const maxPrior = prior.reduce((a, b) => (a.producer_seq > b.producer_seq ? a : b));
    assert(
      w.candidate_ref.producer_seq === maxPrior.producer_seq,
      `witness did not ref lock-critical latest: ref=${w.candidate_ref.producer_seq} maxPrior=${maxPrior.producer_seq}`,
    );
    assert(w.candidate_ref.record_id === maxPrior.record_id, "witness record_id not lock-critical latest");
    assert(w.capabilities.terminal_seal === false, "witness must not seal");
  }
});

await check("durableAtomicCreateFile verifyCreated default + false + identical/collision", async () => {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const durable = await jiti.import(path.join(root, "extensions/_shared/durable-write.ts"));
  const ddir = path.join(tmp, "durable-verify");
  fs.mkdirSync(ddir, { recursive: true, mode: 0o700 });
  const p1 = path.join(ddir, "a.json");
  const body = '{"ok":true}\n';
  const created = await durable.durableAtomicCreateFile(p1, body, { mode: 0o600 });
  assert(created === "created", `default create got ${created}`);
  const identical = await durable.durableAtomicCreateFile(p1, body, { mode: 0o600, verifyCreated: false });
  assert(identical === "identical", `identical got ${identical}`);
  const collision = await durable.durableAtomicCreateFile(p1, '{"ok":false}\n', { mode: 0o600, verifyCreated: false });
  assert(collision === "collision", `collision got ${collision}`);
  const p2 = path.join(ddir, "b.json");
  const createdNoVerify = await durable.durableAtomicCreateFile(p2, body, { mode: 0o600, verifyCreated: false });
  assert(createdNoVerify === "created", `verifyCreated=false create got ${createdNoVerify}`);
  assert(fs.readFileSync(p2, "utf8") === body, "verifyCreated=false must still persist bytes");
});

await check("initializeEdgeProtocolShadowSession idempotent layout, no source/candidate", async () => {
  const sid = "sess-init-layout";
  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRoot, sid);
  assert(!fs.existsSync(sessionRoot), "precondition: no session root");
  const r1 = await edge.initializeEdgeProtocolShadowSession({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
  });
  assert(r1.status === "ready", `init status ${r1.status} ${r1.error_code}`);
  assert(typeof r1.duration_ms === "number", "duration_ms required");
  assert(fs.existsSync(edge.edgeSourcesDir(sessionRoot)), "sources dir");
  assert(fs.existsSync(edge.edgeJournalRecordsDir(sessionRoot)), "records dir");
  assert(fs.existsSync(edge.edgeJournalLockDir(sessionRoot)), "lock dir");
  assert(modeOf(sessionRoot) === 0o700, "session root mode");
  assert(fs.readdirSync(edge.edgeSourcesDir(sessionRoot)).length === 0, "init must not write source");
  assert(fs.readdirSync(edge.edgeJournalRecordsDir(sessionRoot)).length === 0, "init must not write candidate");
  const r2 = await edge.initializeEdgeProtocolShadowSession({
    abrainHome,
    ownerProjectRoot: ownerRoot,
    sessionId: sid,
  });
  assert(r2.status === "ready", `idempotent init ${r2.status}`);
  assert(fs.readdirSync(edge.edgeJournalRecordsDir(sessionRoot)).length === 0, "idempotent init still no records");
});

await check("intermediate ancestor symlink fails closed; no escape write outside abrainHome", async () => {
  // Real intermediate-layer symlink under abrainHome (.state is real; sediment → outside).
  // ensureDirOwned must walk ownershipRoot→target component-wise and fail on the symlink,
  // never follow it via lstat(full target) and create source/candidate outside the root.
  const base = fs.mkdtempSync(path.join(tmp, "edge-symlink-escape-"));
  const abrain = path.join(base, "abrain");
  const outside = path.join(base, "outside-escape");
  const owner = path.join(base, "owner");
  fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
  fs.mkdirSync(owner, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(abrain, ".state"), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, path.join(abrain, ".state", "sediment"), "dir");

  function listFilesRecursive(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const st = fs.lstatSync(full);
        if (st.isDirectory() && !st.isSymbolicLink()) walk(full);
        else out.push(path.relative(dir, full));
      }
    };
    walk(dir);
    return out;
  }

  const sid = "sess-symlink-escape";
  const beforeOutside = listFilesRecursive(outside);
  assert(beforeOutside.length === 0, "precondition: outside empty");

  const init = await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId: sid,
  });
  assert(init.status === "failed", `init must fail closed, got ${init.status}`);
  assert(init.error_code === "layout_init_failed", `init code ${init.error_code}`);
  // sanitizeDiagnostic must not leak absolute outside/abrain paths
  assert(!String(init.error_detail || "").includes(outside), "init error_detail leaked outside path");
  assert(!String(init.error_detail || "").includes(abrain), "init error_detail leaked abrain path");

  const cap = await edge.captureEdgeProtocolCandidate({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId: sid,
    messages: [{ role: "user", content: "escape-probe-must-not-persist" }],
    c6: { session_id: sid, turn_id: 1 },
  });
  assert(cap.status !== "captured", `capture must fail closed, got ${cap.status}`);
  assert(cap.error_code, "capture must surface error_code");

  const afterOutside = listFilesRecursive(outside);
  assert(
    afterOutside.length === 0,
    `outside must remain free of source/candidate after symlink escape attempt: ${JSON.stringify(afterOutside)}`,
  );
  // No edge root materialization under the escaped target either.
  assert(
    !fs.existsSync(path.join(outside, edge.EDGE_PROTOCOL_SHADOW_ROOT_NAME)),
    "edge root must not appear under symlink target",
  );
  assert(
    !fs.existsSync(path.join(outside, "edge-protocol-shadow")),
    "edge-protocol-shadow must not appear under symlink target",
  );
});

await check("intake writeSedimentIntakeRecord verifyCreated=false identical + collision", async () => {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const intake = await jiti.import(path.join(root, "extensions/sediment/intake.ts"));
  const abrainI = path.join(tmp, "intake-verify-abrain");
  fs.mkdirSync(abrainI, { recursive: true, mode: 0o700 });
  const base = {
    sessionId: "intake-coll-sess",
    sessionFile: path.join(tmp, "intake-coll-sess.jsonl"),
    cwd: ownerRoot,
    sourceProjectRoot: ownerRoot,
    branchTip: {
      id: "tip-intake-1",
      parentId: null,
      type: "message",
      timestampUtc: "2026-07-24T00:00:00.000Z",
    },
    captureBoundary: {
      kind: "agent_end",
      boundaryUntrusted: false,
      terminalAssistantStopReason: "stop",
    },
  };
  const rec = intake.buildSedimentIntakeRecord(base);
  const w1 = await intake.writeSedimentIntakeRecord(abrainI, rec);
  assert(w1.status === "created", `first intake write ${w1.status}`);
  const w2 = await intake.writeSedimentIntakeRecord(abrainI, rec);
  assert(w2.status === "identical", `identical re-write ${w2.status}`);
  // Same windowId path with different body → collision (hash-path identity).
  const collided = {
    ...rec,
    // Force different canonical body while keeping windowId (file path).
    captureBoundary: {
      ...rec.captureBoundary,
      terminalAssistantStopReason: "length",
    },
  };
  // windowId is content-addressed from coordinates; changing captureBoundary
  // may change windowId. Build a raw write against the same path via helper
  // collision path: re-create with same windowId by writing different bytes
  // through durableAtomicCreateFile is already covered; exercise intake's
  // collision branch by planting different JSON at the pending path.
  const pendingPath = intake.sedimentIntakePendingPath(abrainI, rec.windowId);
  const different = `${JSON.stringify({ ...rec, sourceDigest: "0".repeat(64) })}\n`;
  // Overwrite is forbidden by durable create; simulate pre-existing different bytes.
  fs.writeFileSync(pendingPath, different, { mode: 0o600 });
  const w3 = await intake.writeSedimentIntakeRecord(abrainI, rec);
  assert(w3.status === "collision", `collision status ${w3.status}`);
});

await check("real extension wiring: edge-only / edge-off / both via isolated process", async () => {
  async function runWiring(mode) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-edge-wiring-${mode}-`));
    try {
      const kid = await spawnChild(
        [fileURLToPath(import.meta.url), "--child=ext-wiring"],
        {
          ...process.env,
          SMOKE_EDGE_WIRING_TMP: work,
          SMOKE_EDGE_WIRING_MODE: mode,
          PI_ASTACK_ENABLE_TEST_HOOKS: "1",
        },
      );
      if (kid.status !== 0) {
        throw new Error(`wiring mode=${mode} status=${kid.status}\n${kid.stderr}\n${kid.stdout}`);
      }
      const line = kid.stdout.trim().split("\n").filter(Boolean).at(-1);
      return JSON.parse(line);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const edgeOnly = await runWiring("edge-only");
  assert(edgeOnly.pending_count === 0, `edge-only must not create intake pending: ${edgeOnly.pending_count}`);
  assert(edgeOnly.candidate_count === 2, `edge-only multi-turn candidates ${edgeOnly.candidate_count}`);
  assert(edgeOnly.witness_count === 2, `edge-only multi-turn witnesses ${edgeOnly.witness_count}`);
  assert(edgeOnly.layout_before_session_start === false, "layout must not exist before session_start");
  assert(edgeOnly.layout_after_session_start === true, "session_start must durable-init edge layout");
  assert(edgeOnly.c6_session === "wiring-sess-001", `c6 session ${edgeOnly.c6_session}`);
  assert(edgeOnly.cand_leaf === edgeOnly.live_tip, `capture leaf_tip ${edgeOnly.cand_leaf}`);
  assert(edgeOnly.wit_leaf === edgeOnly.live_tip, `settled leaf_tip ${edgeOnly.wit_leaf}`);
  assert(edgeOnly.terminal_seal === false, "must not seal");
  assert(edgeOnly.settlement === "unsupported_core_capability", `settlement ${edgeOnly.settlement}`);
  assert(Array.isArray(edgeOnly.producer_seqs) && edgeOnly.producer_seqs.length === 4, `seqs ${JSON.stringify(edgeOnly.producer_seqs)}`);
  assert(JSON.stringify(edgeOnly.producer_seqs) === JSON.stringify([1, 2, 3, 4]), `mono seqs ${JSON.stringify(edgeOnly.producer_seqs)}`);
  assert(edgeOnly.last_wit_ref_seq === edgeOnly.last_cand_seq, "witness must ref current candidate seq");
  assert(JSON.stringify(edgeOnly.candidate_turn_ids) === JSON.stringify([0, 1]), `turn ids ${JSON.stringify(edgeOnly.candidate_turn_ids)}`);

  // edge-off = default-both-off (sediment + edge disabled).
  const edgeOff = await runWiring("edge-off");
  assert(edgeOff.pending_count === 0, "edge-off must not create intake (sediment disabled)");
  assert(edgeOff.candidate_count === 0, "edge-off zero candidates");
  assert(edgeOff.witness_count === 0, "edge-off zero witnesses");
  assert(edgeOff.edge_root_exists === false, "edge-off must not create edge root");
  assert(edgeOff.layout_after_session_start === false, "edge-off session_start zero layout product");
  assert(edgeOff.owner_resolve_count === 0, `default-both-off must not resolve owner/git: ${edgeOff.owner_resolve_count}`);

  const both = await runWiring("both");
  // Multi-turn: 2 intake windows (one per assistant tip) or coalesced — at least 1.
  assert(both.pending_count >= 1, `both must create intake pending: ${both.pending_count}`);
  assert(both.candidate_count === 2, `both multi-turn candidates ${both.candidate_count}`);
  assert(both.witness_count === 2, `both multi-turn witnesses ${both.witness_count}`);
  assert(both.layout_after_session_start === true, "both session_start must init layout");
  assert(both.c6_session === "wiring-sess-001", "both c6 session mismatch");
  assert(both.terminal_seal === false, "both must not seal");
  assert(both.last_wit_ref_seq === both.last_cand_seq, "both witness must ref current cand");
  assert(both.owner_resolve_count > 0, "enabled path must resolve owner");
});

await check("terminal assistant boundary helper: toolUse is not agent_end turn", async () => {
  const { isTerminalAssistantMessage, collectMainChainFromSession } = await import(
    path.join(root, "scripts/edge-protocol-shadow-chain.mjs"),
  );
  assert(isTerminalAssistantMessage({ role: "assistant", stopReason: "stop" }) === true, "stop");
  assert(isTerminalAssistantMessage({ role: "assistant", stopReason: "length" }) === true, "length");
  assert(isTerminalAssistantMessage({ role: "assistant", stopReason: "error" }) === true, "error");
  assert(isTerminalAssistantMessage({ role: "assistant", stopReason: "aborted" }) === true, "aborted");
  assert(isTerminalAssistantMessage({ role: "assistant" }) === true, "missing stopReason is terminal");
  assert(isTerminalAssistantMessage({ role: "assistant", stopReason: "toolUse" }) === false, "toolUse mid-loop");
  assert(isTerminalAssistantMessage({ role: "user" }) === false, "user not terminal");

  // Synthetic chain: toolUse leaf alone must not produce a main chain.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-chain-"));
  try {
    const onlyToolUse = path.join(tmpDir, "tooluse-only.jsonl");
    const rows = [
      { type: "session", version: 3, id: "s1", timestamp: "2026-07-24T00:00:00.000Z", cwd: tmpDir },
      {
        type: "message", id: "u1", parentId: null, timestamp: "2026-07-24T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-24T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }], stopReason: "toolUse" },
      },
    ];
    fs.writeFileSync(onlyToolUse, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert(collectMainChainFromSession(onlyToolUse) === null, "toolUse-only leaf must skip (no fabricate)");

    // toolUse mid-chain + terminal leaf → one terminal turn only.
    const withTerminal = path.join(tmpDir, "tooluse-then-stop.jsonl");
    const rows2 = [
      ...rows,
      {
        type: "message", id: "tr1", parentId: "a1", timestamp: "2026-07-24T00:00:03.000Z",
        message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
      },
      {
        type: "message", id: "a2", parentId: "tr1", timestamp: "2026-07-24T00:00:04.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      },
    ];
    fs.writeFileSync(withTerminal, rows2.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const chain = collectMainChainFromSession(withTerminal);
    assert(chain, "terminal leaf chain required");
    assert(chain.terminal_assistant_turns === 1, `expected 1 terminal turn got ${chain.terminal_assistant_turns}`);
    assert(chain.assistant_turns === 1, "assistant_turns alias must match terminal count");
    // Mid-loop toolUse node is on the chain but is not a terminal turn index.
    const roles = chain.chainNodes.map((n) => n.message?.role);
    assert(roles.includes("assistant"), "chain includes assistants");
    const terminalCount = chain.chainNodes.filter((n) => isTerminalAssistantMessage(n.message)).length;
    assert(terminalCount === 1, `chain terminal count ${terminalCount}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

await check("real extension: toolUse mid-loop produces single turn (not extra agent_end)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-tooluse-"));
  try {
    const kid = await spawnChild(
      [fileURLToPath(import.meta.url), "--child=ext-tooluse"],
      {
        ...process.env,
        SMOKE_EDGE_WIRING_TMP: work,
        PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      },
    );
    if (kid.status !== 0) {
      throw new Error(`tooluse wiring status=${kid.status}\n${kid.stderr}\n${kid.stdout}`);
    }
    const line = kid.stdout.trim().split("\n").filter(Boolean).at(-1);
    const out = JSON.parse(line);
    assert(out.candidate_count === 1, `toolUse run must produce 1 candidate, got ${out.candidate_count}`);
    assert(out.witness_count === 1, `toolUse run must produce 1 witness, got ${out.witness_count}`);
    assert(JSON.stringify(out.candidate_turn_ids) === JSON.stringify([0]), `turn ids ${JSON.stringify(out.candidate_turn_ids)}`);
    assert(JSON.stringify(out.producer_seqs) === JSON.stringify([1, 2]), `seqs ${JSON.stringify(out.producer_seqs)}`);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Strict tsc: local typescript + absolute typeRoots + absolute files; non-zero fails hard.
await check("strict tsc on edge-protocol-shadow", async () => {
  const tscJs = path.join(root, "node_modules/typescript/lib/tsc.js");
  assert(fs.existsSync(tscJs), "repo-local typescript missing");
  const typeRoots = path.join(root, "node_modules/@types");
  assert(fs.existsSync(typeRoots), "repo-local @types missing");
  const targetFile = path.join(root, "extensions/sediment/edge-protocol-shadow.ts");
  const result = await spawnChild([
    tscJs,
    "--lib", "ES2022",
    "--types", "node",
    "--typeRoots", typeRoots,
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--strict",
    "--skipLibCheck",
    "--noEmit",
    targetFile,
  ], { ...process.env });
  if (result.status !== 0) {
    throw new Error(`tsc failed status=${result.status}\n${result.stdout}\n${result.stderr}`);
  }
});

console.log(`\n${passed} checks passed`);
cleanup();
process.exit(0);
} catch (err) {
  console.error(`\nSMOKE FAILED after ${passed} passed: ${err instanceof Error ? err.message : String(err)}`);
  cleanup();
  process.exit(1);
}
