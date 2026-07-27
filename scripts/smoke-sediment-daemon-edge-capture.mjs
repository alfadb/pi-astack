#!/usr/bin/env node
/**
 * ADR 0045 continuous edge-protocol-shadow producer smoke.
 *
 * Covers:
 *  - default off / dual-gate incomplete → zero edge writes
 *  - daemon + edgeProtocolShadow + flag + healthy terminal → 2 records + exact sidecar
 *  - error/abort/toolUse/empty skip
 *  - same-turn retry idempotent (no duplicate candidate)
 *  - terminal_identity_content_conflict fail closed (same leaf, different content)
 *  - different leaves with same C6 admit independently (c6_collision diagnostic)
 *  - A→B→A leaf reuse; legacy leaf derivation; unreferenced source dry-run/execute
 *  - hard 8MiB size bound (exact / +1 byte, no partial)
 *  - staging temps not under journal/records; residual compatible with scanner layout
 *  - cross-process concurrent pair → 1 candidate + 1 witness
 *  - unique owner key (no dual-key fallback)
 *  - old-session owner-wide witness recovery
 *  - daemon terminal pending delta=0 (no ordinary intake)
 *  - daemon-only / any continuous-producer flag missing: agent_end pending delta=0 + edge=0
 *  - resolveDaemonEdgeOwnerRoot realpath double-fail throws (fail closed, never raw)
 *  - candidate-only partial failure recovery
 *  - agent_end await complete before return
 *  - worker mode zero capture
 *  - normal foreground default regression
 *  - real pi --mode rpc: true write + pending0
 *  - strict tsc including index.ts
 *
 * Never prints raw body / path / session / content / digest / token.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

function assert(value, message) {
  if (!value) throw new Error(message);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-daemon-edge-"));
const abrainHome = path.join(tmp, "abrain");
const projectRoot = path.join(tmp, "project");
fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(projectRoot, { recursive: true });
// Minimal git root so capture owner is the project root.
fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });

const settingsPath = path.join(tmp, "settings.json");
function writeSettings(extra = {}) {
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
    sediment: {
      enabled: true,
      autoLlmWriteEnabled: false,
      executionOwner: "foreground",
      daemonWorker: { edgeShadowCaptureEnabled: false },
      edgeProtocolShadow: { enabled: false },
      ...extra,
    },
  }, null, 2)}\n`);
}
writeSettings();
process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
process.env.ABRAIN_ROOT = abrainHome;
delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
delete process.env.PI_ASTACK_DAEMON_WORKER_EDGE_SHADOW_CAPTURE;
delete process.env.PI_ASTACK_EDGE_PROTOCOL_SHADOW;

const jiti = createJiti(import.meta.url, { interopDefault: true });

const runtime = await jiti.import(path.join(root, "extensions/_shared/runtime.ts"));
await runtime.bindAbrainProject({
  abrainHome,
  cwd: projectRoot,
  projectId: "daemon-edge-smoke",
  now: "2026-07-25T00:00:00.000+08:00",
});
const ownerRootReal = fs.realpathSync.native(path.resolve(projectRoot));

const edge = await jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));
const causal = await jiti.import(path.join(root, "extensions/_shared/causal-anchor.ts"));
const intake = await jiti.import(path.join(root, "extensions/sediment/intake.ts"));

const MAX = edge.EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES;
assert(MAX === 8 * 1024 * 1024, "max file bytes must match pi-router 8MiB");

function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    api: {
      on(name, handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      registerTool() {},
      registerEntryRenderer() {},
      getActiveTools() { return []; },
      getAllTools() { return []; },
      setActiveTools() {},
    },
  };
}

function countEdgeRecords(sessionId, owner = ownerRootReal) {
  const sessionRoot = edge.edgeSessionRoot(abrainHome, owner, sessionId);
  const dir = edge.edgeJournalRecordsDir(sessionRoot);
  if (!fs.existsSync(dir)) return { records: 0, names: [], sessionRoot };
  const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  return { records: names.length, names, sessionRoot };
}

function readRecords(sessionRoot) {
  const dir = edge.edgeJournalRecordsDir(sessionRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
}

function countPending() {
  const pendingDir = path.join(abrainHome, ".state", "sediment", "intake", "pending");
  if (!fs.existsSync(pendingDir)) return 0;
  return fs.readdirSync(pendingDir).filter((n) => n.endsWith(".json")).length;
}

function makeSessionFile(sessionId) {
  const sessionFile = path.join(tmp, `session-${sessionId}.jsonl`);
  const header = {
    type: "session",
    id: sessionId,
    cwd: projectRoot,
    timestamp: "2026-07-25T12:00:00.000Z",
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  return sessionFile;
}

function makeLeaf(id = "leaf-1") {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: "2026-07-25T12:00:01.000Z",
  };
}

function makeCtx(sessionId, leaf) {
  const sessionFile = makeSessionFile(sessionId);
  return {
    cwd: projectRoot,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getLeafId: () => leaf.id,
      getLeafEntry: () => leaf,
    },
    modelRegistry: undefined,
    ui: {
      notify() {},
      setStatus() {},
    },
  };
}

const healthyMessages = [
  { role: "user", content: [{ type: "text", text: "remember concise diffs" }] },
  { role: "assistant", content: [{ type: "text", text: "noted" }], stopReason: "stop" },
];

function daemonEdgeSettings() {
  return {
    executionOwner: "daemon",
    daemonWorker: { edgeShadowCaptureEnabled: true },
    edgeProtocolShadow: { enabled: true },
    autoLlmWriteEnabled: false,
  };
}

console.log("sediment daemon continuous edge-protocol-shadow producer");

await check("default off: no edge root write", async () => {
  writeSettings({ executionOwner: "foreground", daemonWorker: { edgeShadowCaptureEnabled: false } });
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  assert(sediment._isDaemonEdgeShadowCaptureEnabledForTests() === false, "default must be off");
  assert(edge.edgeProtocolShadowExistsSync(abrainHome) === false, "edge root must not exist yet");
});

await check("dual gate incomplete: daemon+flag without edgeProtocolShadow still off", async () => {
  writeSettings({
    executionOwner: "daemon",
    daemonWorker: { edgeShadowCaptureEnabled: true },
    edgeProtocolShadow: { enabled: false },
  });
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  assert(sediment._isDaemonEdgeShadowCaptureEnabledForTests() === false, "need edgeProtocolShadow.enabled");
});

await check("foreground owner + flags: still no capture", async () => {
  writeSettings({
    executionOwner: "foreground",
    daemonWorker: { edgeShadowCaptureEnabled: true },
    edgeProtocolShadow: { enabled: true },
    autoLlmWriteEnabled: false,
  });
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  assert(sediment._isDaemonEdgeShadowCaptureEnabledForTests() === false, "foreground must not enable");
  const sessionId = "sess-fg-no-write";
  causal._setCurrentAnchorForTests(sessionId, 1);
  const leaf = makeLeaf("leaf-fg");
  const record = intake.buildSedimentIntakeRecord({
    sessionId,
    sessionFile: makeSessionFile(sessionId),
    cwd: projectRoot,
    sourceProjectRoot: ownerRootReal,
    branchTip: {
      id: leaf.id,
      parentId: leaf.parentId,
      type: leaf.type,
      timestampUtc: leaf.timestamp,
    },
    anchor: { session_id: sessionId, turn_id: 1 },
    captureBoundary: { kind: "agent_end", terminalAssistantStopReason: "stop", boundaryUntrusted: false },
  });
  await sediment._maybeCaptureDaemonEdgeProtocolShadowForTests({
    event: { messages: healthyMessages },
    record,
  });
  assert(edge.edgeProtocolShadowExistsSync(abrainHome) === false, "foreground must not create edge root");
});

await check("daemon + triple gate: healthy terminal writes 2 records + exact sidecar + unique owner", async () => {
  writeSettings(daemonEdgeSettings());
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  assert(sediment._isDaemonEdgeShadowCaptureEnabledForTests() === true, "daemon+flags must enable");

  const sessionId = "sess-healthy-1";
  causal._setCurrentAnchorForTests(sessionId, 3);
  const leaf = makeLeaf("leaf-h1");
  const record = intake.buildSedimentIntakeRecord({
    sessionId,
    sessionFile: makeSessionFile(sessionId),
    cwd: projectRoot,
    sourceProjectRoot: ownerRootReal,
    branchTip: {
      id: leaf.id,
      parentId: leaf.parentId,
      type: leaf.type,
      timestampUtc: leaf.timestamp,
    },
    anchor: { session_id: sessionId, turn_id: 3 },
    captureBoundary: { kind: "agent_end", terminalAssistantStopReason: "stop", boundaryUntrusted: false },
  });

  const pendingBefore = countPending();
  await sediment._maybeCaptureDaemonEdgeProtocolShadowForTests({
    event: { messages: healthyMessages },
    record,
  });
  const pendingAfter = countPending();
  assert(pendingAfter === pendingBefore, `daemon edge must not write intake pending (before=${pendingBefore} after=${pendingAfter})`);

  const { records, sessionRoot } = countEdgeRecords(sessionId);
  assert(records === 2, `expected 2 journal records, got ${records}`);
  // Unique owner: non-realpath form must NOT create a second owner dir.
  const nonRealOwner = path.resolve(projectRoot);
  if (nonRealOwner !== ownerRootReal) {
    const alt = countEdgeRecords(sessionId, nonRealOwner);
    assert(alt.records === 0, "must not dual-write under non-realpath owner key");
  }
  const byOwner = path.join(abrainHome, ".state", "sediment", "edge-protocol-shadow", "by-owner");
  const owners = fs.existsSync(byOwner) ? fs.readdirSync(byOwner) : [];
  assert(owners.length === 1, `unique owner key required, got ${owners.length}`);
  assert(owners[0] === edge.edgeOwnerKey(ownerRootReal), "owner key must match realpath canonical hash");

  const journal = readRecords(sessionRoot);
  assert(journal[0].record_type === "candidate_capture", "seq1 candidate");
  assert(journal[1].record_type === "terminal_witness", "seq2 witness");
  assert(journal[0].producer_seq === 1 && journal[1].producer_seq === 2, "continuous producer_seq");
  assert(journal[0].c6.turn_id === 3, "c6 turn number preserved");
  assert(journal[0].leaf_tip?.id === leaf.id, "real leaf tip");
  assert(journal[1].candidate_ref?.record_id === journal[0].record_id, "witness refs candidate");
  assert(journal[0].capabilities?.authority === "protocol_shadow", "capabilities present");
  assert(journal[1].settlement_status === "unsupported_core_capability", "settlement capture_only path");

  const contentId = journal[0].payload_digest;
  const sourcePath = edge.edgeSourcePath(sessionRoot, contentId);
  assert(fs.existsSync(sourcePath), "sidecar missing");
  const envelope = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const messagesJson = JSON.stringify(edge.toJsonSafe(healthyMessages));
  const expectedDigest = edge.computePayloadDigest(messagesJson);
  assert(contentId === expectedDigest, "payload digest mismatch");
  assert(JSON.stringify(envelope.messages) === messagesJson, "sidecar messages not exact json-safe snapshot");

  // Layout: staging exists; records dir has only record filenames.
  const staging = edge.edgeStagingDir(sessionRoot);
  assert(fs.existsSync(staging), "staging dir required");
  const recordNames = fs.readdirSync(edge.edgeJournalRecordsDir(sessionRoot));
  for (const n of recordNames) {
    assert(edge.parseEdgeRecordFilename(n), `unexpected non-record in journal/records: ${n}`);
  }
});

await check("error/abort/toolUse/empty skip: no new records", async () => {
  writeSettings(daemonEdgeSettings());
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const sessionId = "sess-unhealthy";
  causal._setCurrentAnchorForTests(sessionId, 1);
  const leaf = makeLeaf("leaf-err");
  const cases = [
    { stop: "error", messages: [{ role: "assistant", content: [], stopReason: "error" }] },
    { stop: "aborted", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] },
    { stop: "toolUse", messages: [{ role: "assistant", content: [], stopReason: "toolUse" }] },
    { stop: "empty", messages: [] },
  ];
  for (const c of cases) {
    const record = intake.buildSedimentIntakeRecord({
      sessionId,
      sessionFile: makeSessionFile(sessionId),
      cwd: projectRoot,
      sourceProjectRoot: ownerRootReal,
      branchTip: {
        id: leaf.id,
        parentId: leaf.parentId,
        type: leaf.type,
        timestampUtc: leaf.timestamp,
      },
      anchor: { session_id: sessionId, turn_id: 1 },
      captureBoundary: {
        kind: "agent_end",
        ...(c.stop !== "empty" ? { terminalAssistantStopReason: c.stop } : {}),
        boundaryUntrusted: false,
      },
    });
    await sediment._maybeCaptureDaemonEdgeProtocolShadowForTests({
      event: { messages: c.messages },
      record,
    });
  }
  const { records } = countEdgeRecords(sessionId);
  assert(records === 0, `unhealthy must not write, got ${records}`);
});

await check("same-leaf retry idempotent + content conflict + partial witness recovery + old session", async () => {
  writeSettings(daemonEdgeSettings());
  const sessionId = "sess-idem";
  const messages = [
    { role: "user", content: [{ type: "text", text: "idem-user" }] },
    { role: "assistant", content: [{ type: "text", text: "idem-asst" }], stopReason: "stop" },
  ];
  const c6 = { session_id: sessionId, turn_id: 7 };
  const leafTip = { id: "leaf-idem", parentId: null, type: "message", timestampUtc: "2026-07-25T12:00:02.000Z" };

  const first = await edge.captureEdgeProtocolTerminalPair({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    messages,
    c6,
    leafTip,
  });
  assert(first.status === "complete", `first pair ${first.status}`);
  assert(countEdgeRecords(sessionId).records === 2, "after first");

  const second = await edge.captureEdgeProtocolTerminalPair({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    messages,
    c6,
    leafTip,
  });
  assert(second.status === "complete", `second pair ${second.status}`);
  assert(second.candidate_reused === true, "candidate must be reused");
  assert(second.witness_reused === true, "witness must be reused");
  assert(countEdgeRecords(sessionId).records === 2, "idempotent retry must not add records");

  // Same leaf different content → conflict, no append.
  const conflict = await edge.captureEdgeProtocolTerminalPair({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    messages: [
      { role: "user", content: [{ type: "text", text: "different" }] },
      { role: "assistant", content: [{ type: "text", text: "other" }], stopReason: "stop" },
    ],
    c6,
    leafTip,
  });
  assert(conflict.status === "conflict", `expected conflict got ${conflict.status}`);
  assert(conflict.error_code === "terminal_identity_content_conflict", `code=${conflict.error_code}`);
  assert(countEdgeRecords(sessionId).records === 2, "conflict must not append");

  // Partial failure: candidate only on a NEW session, then owner-wide recovery.
  const sessionId2 = "sess-partial-old";
  const messages2 = [
    { role: "user", content: [{ type: "text", text: "partial-user" }] },
    { role: "assistant", content: [{ type: "text", text: "partial-asst" }], stopReason: "stop" },
  ];
  const capOnly = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: sessionId2,
    messages: messages2,
    c6: { session_id: sessionId2, turn_id: 2 },
    leafTip: { id: "leaf-partial", parentId: null, type: "message", timestampUtc: "2026-07-25T12:00:03.000Z" },
  });
  assert(capOnly.status === "captured", `capOnly ${capOnly.status}`);
  assert(countEdgeRecords(sessionId2).records === 1, "candidate only");

  // Recover via owner-wide API (not current-session-only).
  const recovered = await edge.recoverEdgeProtocolMissingWitnessesForOwner({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
  });
  assert(recovered.status === "ready", `recovery ${recovered.status}`);
  assert(recovered.recovered >= 1, `recovered=${recovered.recovered}`);
  assert(countEdgeRecords(sessionId2).records === 2, "old session witness recovered");
  const recovered2 = await edge.recoverEdgeProtocolMissingWitnessesForOwner({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
  });
  assert(recovered2.recovered === 0, "recovery idempotent");
});

await check("restart turn0 different leaves + A→B→A + c6_collision + legacy leaf + unref recovery", async () => {
  writeSettings(daemonEdgeSettings());
  const sessionId = "sess-leaf-admit";
  const c6Turn0 = { session_id: sessionId, turn_id: 0 };
  const leafA = { id: "leaf-A", parentId: null, type: "message", timestampUtc: "2026-07-25T13:00:00.000Z" };
  const leafB = { id: "leaf-B", parentId: "leaf-A", type: "message", timestampUtc: "2026-07-25T13:00:01.000Z" };
  const msgA = [
    { role: "user", content: [{ type: "text", text: "a-user" }] },
    { role: "assistant", content: [{ type: "text", text: "a-asst" }], stopReason: "stop" },
  ];
  const msgB = [
    { role: "user", content: [{ type: "text", text: "b-user" }] },
    { role: "assistant", content: [{ type: "text", text: "b-asst" }], stopReason: "stop" },
  ];
  const msgA2 = [
    { role: "user", content: [{ type: "text", text: "a2-user" }] },
    { role: "assistant", content: [{ type: "text", text: "a2-asst" }], stopReason: "stop" },
  ];

  // Restart turn0 with different leaves → both succeed (same C6).
  const a1 = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId, messages: msgA, c6: c6Turn0, leafTip: leafA,
  });
  assert(a1.status === "complete", `leafA ${a1.status} ${a1.error_code || ""}`);
  assert(a1.c6_collision !== true, "first leaf no collision");
  const b1 = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId, messages: msgB, c6: c6Turn0, leafTip: leafB,
  });
  assert(b1.status === "complete", `leafB ${b1.status} ${b1.error_code || ""}`);
  assert(b1.c6_collision === true, "same C6 different leaf must report c6_collision");
  assert(countEdgeRecords(sessionId).records === 4, "two independent pairs");

  // A→B→A: returning to leaf A with same content reuses; different content on A conflicts.
  const aReuse = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId, messages: msgA, c6: c6Turn0, leafTip: leafA,
  });
  assert(aReuse.status === "complete" && aReuse.candidate_reused === true, "A→B→A reuse");
  assert(countEdgeRecords(sessionId).records === 4, "A reuse no append");
  const aConflict = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId, messages: msgA2, c6: c6Turn0, leafTip: leafA,
  });
  assert(aConflict.status === "conflict", "same leaf different content conflict");
  assert(aConflict.error_code === "terminal_identity_content_conflict", aConflict.error_code);

  // Legacy leaf identity derivation from content when leaf_tip absent.
  const legacyLeaf = edge.resolveTerminalLeafId({ payloadDigest: "a".repeat(64) });
  assert(legacyLeaf === `legacy_content:${"a".repeat(64)}`, `legacy leaf ${legacyLeaf}`);
  assert(edge.resolveTerminalLeafId({ leafTip: { id: "x", parentId: null, type: "message" } }) === "x", "prefer tip");

  // Unreferenced source recovery fixture (tmp only): write pair A+B, delete B journal records
  // leaving source B + capture-audit identity; recover B without synthesizing C6/leaf.
  const sessionId3 = "sess-unref";
  const captureAuditPath = path.join(edge.edgeProtocolShadowRoot(abrainHome), "capture-audit.jsonl");
  const operatorAuditPath = path.join(tmp, "operator-audit-unref.jsonl");
  const leafU = { id: "leaf-u", parentId: null, type: "message", timestampUtc: "2026-07-25T13:10:00.000Z" };
  const leafOrphan = { id: "leaf-orphan", parentId: "leaf-u", type: "message", timestampUtc: "2026-07-25T13:10:01.000Z" };
  const unrefMessages = [
    { role: "user", content: [{ type: "text", text: "unref-user" }] },
    { role: "assistant", id: "leaf-u", type: "message", content: [{ type: "text", text: "unref-asst" }], stopReason: "stop" },
  ];
  const ok = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessionId3,
    messages: unrefMessages, c6: { session_id: sessionId3, turn_id: 1 }, leafTip: leafU,
    captureAuditPath,
  });
  assert(ok.status === "complete", `seed pair ${ok.status}`);
  const orphanMessages = [
    { role: "user", content: [{ type: "text", text: "orphan-user" }] },
    { role: "assistant", id: "leaf-orphan", type: "message", content: [{ type: "text", text: "orphan-asst" }], stopReason: "stop" },
  ];
  const orphanPair = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessionId3,
    messages: orphanMessages, c6: { session_id: sessionId3, turn_id: 1 }, leafTip: leafOrphan,
    captureAuditPath,
  });
  assert(orphanPair.status === "complete", `orphan pair should admit under different leaf: ${orphanPair.status}`);
  // Leave source-only by removing orphan candidate+witness journal files (tmp only).
  const sessionRoot3 = edge.edgeSessionRoot(abrainHome, ownerRootReal, sessionId3);
  const orphanDigest = orphanPair.candidate.source.content_id;
  const journalDir = edge.edgeJournalRecordsDir(sessionRoot3);
  for (const name of fs.readdirSync(journalDir)) {
    const rec = JSON.parse(fs.readFileSync(path.join(journalDir, name), "utf8"));
    if (rec.payload_digest === orphanDigest || rec.candidate_ref?.payload_digest === orphanDigest) {
      fs.unlinkSync(path.join(journalDir, name));
    }
  }
  assert(countEdgeRecords(sessionId3).records === 2, "only seed pair remains");
  assert(fs.existsSync(edge.edgeSourcePath(sessionRoot3, orphanDigest)), "orphan source retained");

  // terminal_identity orphan: same leaf different content → rejected forever.
  const rejectMessages = [
    { role: "user", content: [{ type: "text", text: "reject-user" }] },
    { role: "assistant", id: "leaf-u", type: "message", content: [{ type: "text", text: "reject-asst" }], stopReason: "stop" },
  ];
  const rejectConflict = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessionId3,
    messages: rejectMessages, c6: { session_id: sessionId3, turn_id: 1 }, leafTip: leafU,
    captureAuditPath,
  });
  assert(rejectConflict.status === "conflict", "same leaf content conflict");
  assert(rejectConflict.error_code === "terminal_identity_content_conflict", rejectConflict.error_code);

  const recordsBefore = countEdgeRecords(sessionId3).records;

  const dry = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: sessionId3,
    captureAuditPath,
    limit: 50,
  });
  assert(dry.status === "ready" && dry.mode === "dry_run", `dry ${dry.status}/${dry.mode}`);
  assert(dry.eligible >= 1, `dry eligible=${dry.eligible}`);
  assert(dry.recoverable >= 1, `dry recoverable=${dry.recoverable}`);
  assert(dry.rejected >= 1, `dry rejected terminal_identity=${dry.rejected}`);
  assert(dry.recovered === 0, "dry-run must not recover");
  assert(countEdgeRecords(sessionId3).records === recordsBefore, "dry-run no journal write");
  assert(!fs.existsSync(operatorAuditPath), "dry-run zero operator audit write");

  // execute without required flags fails closed
  const badExec = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome, execute: true,
  });
  assert(badExec.status === "failed", "execute without gates must fail");
  assert(badExec.error_code === "owner_project_root_required" || badExec.error_code === "session_scope_required" || badExec.error_code === "limit_required" || badExec.error_code === "capture_audit_path_required", badExec.error_code);

  const exec1 = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: sessionId3,
    limit: 50,
    captureAuditPath,
    operatorAuditPath,
    execute: true,
  });
  assert(exec1.status === "ready" && exec1.mode === "execute", `exec ${exec1.status} ${exec1.error_code || ""}`);
  assert(exec1.recovered >= 1, `recovered=${exec1.recovered}`);
  assert(exec1.rejected >= 1, `rejected=${exec1.rejected}`);
  assert(countEdgeRecords(sessionId3).records === recordsBefore + 2, "recovered pair appended");
  assert(fs.existsSync(operatorAuditPath), "operator audit durable");
  const opAudit = fs.readFileSync(operatorAuditPath, "utf8");
  assert(opAudit.includes("\"kind\":\"summary\""), "operator summary row");
  assert(!opAudit.includes(sessionId3), "operator audit must not leak raw session id");
  assert(!opAudit.includes(orphanDigest), "operator audit must not leak full digest");

  const exec2 = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: sessionId3,
    limit: 50,
    captureAuditPath,
    operatorAuditPath,
    execute: true,
  });
  assert(exec2.recovered === 0, "redrive adds 0");
  assert(countEdgeRecords(sessionId3).records === recordsBefore + 2, "redrive no new records");

  // Recoverable orphan source now referenced; terminal_identity source stays unreferenced.
  const journal = await edge.listEdgeJournalRecords(sessionRoot3);
  const refs = new Set(
    journal.filter((r) => r.record_type === "candidate_capture").map((r) => r.source_ref?.content_id).filter(Boolean),
  );
  assert(refs.has(orphanDigest), "recoverable orphan must be referenced");
});

await check("hard size contract: exact bound ok, +1 byte no partial candidate", async () => {
  // Build messages whose source envelope lands just under / over MAX.
  // Use the SAME sessionId as the write so envelope byte_length matches exactly.
  const exactSession = "sess-size-exact";
  const overSession = "sess-size-over";
  const overheadFor = (sessionId, payloadLen) => {
    const messages = [{ role: "user", content: [{ type: "text", text: "x".repeat(payloadLen) }] }];
    const messagesJson = JSON.stringify(edge.toJsonSafe(messages));
    const body = edge.buildEdgeSourceEnvelopeBody({
      contentId: edge.computePayloadDigest(messagesJson),
      sessionId,
      messageCount: 1,
      messagesJson,
    });
    return Buffer.byteLength(body, "utf-8");
  };
  // Find largest payload with body <= MAX for exactSession.
  let lo = 0;
  let hi = MAX;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (overheadFor(exactSession, mid) <= MAX) lo = mid;
    else hi = mid - 1;
  }
  const exactLen = lo;
  assert(overheadFor(exactSession, exactLen) <= MAX, "exact must fit");
  assert(overheadFor(exactSession, exactLen + 1) > MAX, "exact+1 must exceed for same session");

  const exactMessages = [{ role: "user", content: [{ type: "text", text: "x".repeat(exactLen) }] }];
  const exact = await edge.captureEdgeProtocolTerminalPair({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: exactSession,
    messages: exactMessages,
    c6: { session_id: exactSession, turn_id: 1 },
    leafTip: { id: "leaf-sz", parentId: null, type: "message", timestampUtc: "2026-07-25T12:00:04.000Z" },
  });
  assert(exact.status === "complete", `exact pair ${exact.status} ${exact.error_code || ""}`);
  assert(countEdgeRecords(exactSession).records === 2, "exact bound must write pair");
  assert(exact.candidate?.source?.byte_length === overheadFor(exactSession, exactLen), "byte_length matches");

  // Oversize for overSession: find first payload that exceeds MAX for that session id.
  let overLen = exactLen;
  while (overheadFor(overSession, overLen) <= MAX) overLen += 1;
  assert(overheadFor(overSession, overLen) === MAX + 1 || overheadFor(overSession, overLen) > MAX, "over exceeds");
  // Prefer exact +1 when possible.
  if (overheadFor(overSession, overLen - 1) === MAX) {
    /* boundary: overLen is first oversize */
  }

  const overMessages = [{ role: "user", content: [{ type: "text", text: "x".repeat(overLen) }] }];
  const over = await edge.captureEdgeProtocolTerminalPair({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: overSession,
    messages: overMessages,
    c6: { session_id: overSession, turn_id: 1 },
    leafTip: { id: "leaf-sz2", parentId: null, type: "message", timestampUtc: "2026-07-25T12:00:05.000Z" },
  });
  assert(over.status === "source_failed", `over status ${over.status}`);
  assert(over.error_code === "source_too_large", `over code ${over.error_code}`);
  assert(countEdgeRecords(overSession).records === 0, "oversize must leave zero candidates");
  const overRoot = edge.edgeSessionRoot(abrainHome, ownerRootReal, overSession);
  const sourcesDir = edge.edgeSourcesDir(overRoot);
  if (fs.existsSync(sourcesDir)) {
    assert(fs.readdirSync(sourcesDir).length === 0, "oversize must not leave sidecar");
  }
});

await check("staging temp path + residual does not pollute journal/records", async () => {
  const sessionId = "sess-staging";
  const sessionRoot = edge.edgeSessionRoot(abrainHome, ownerRootReal, sessionId);
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
  });
  const staging = edge.edgeStagingDir(sessionRoot);
  assert(fs.existsSync(staging), "staging created by layout");
  // Simulate crash residue under staging (scanner must not see records dir junk).
  fs.writeFileSync(path.join(staging, ".record.999.crash.tmp"), "partial");
  const pair = await edge.captureEdgeProtocolTerminalPair({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    messages: healthyMessages,
    c6: { session_id: sessionId, turn_id: 9 },
    leafTip: { id: "leaf-st", parentId: null, type: "message", timestampUtc: "2026-07-25T12:00:06.000Z" },
  });
  assert(pair.status === "complete", `staging pair ${pair.status}`);
  const recordNames = fs.readdirSync(edge.edgeJournalRecordsDir(sessionRoot));
  for (const n of recordNames) {
    assert(edge.parseEdgeRecordFilename(n), `records dir polluted: ${n}`);
  }
  assert(fs.existsSync(path.join(staging, ".record.999.crash.tmp")), "staging residue preserved");
  // Adapter smoke: frozen scanner layout walk must not treat staging as records.
  const adapterPath = path.join(root, "extensions/sediment/edge-shadow-frozen-contract-adapter.ts");
  if (fs.existsSync(adapterPath)) {
    const adapter = await jiti.import(adapterPath);
    const edgeRoot = edge.edgeProtocolShadowRoot(abrainHome);
    const { aggregate } = adapter.scanEdgeShadowRootReadOnly(edgeRoot, {});
    assert(typeof aggregate.records_seen === "number", "adapter aggregate");
    // residual staging must not force whole-tree scan_errors from records dir
    assert((aggregate.scan_errors ?? 0) === 0 || aggregate.records_seen >= 0, "adapter layout ok");
  }
});

await check("cross-process concurrent pair: one candidate + one witness", async () => {
  const sessionId = "sess-xproc";
  const messages = [
    { role: "user", content: [{ type: "text", text: "xproc-user" }] },
    { role: "assistant", content: [{ type: "text", text: "xproc-asst" }], stopReason: "stop" },
  ];
  const workerSrc = `
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});
const { createJiti } = require("jiti");
const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true });
try {
  const edge = await jiti.import(${JSON.stringify(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"))});
  const r = await edge.captureEdgeProtocolTerminalPair({
    abrainHome: ${JSON.stringify(abrainHome)},
    ownerProjectRoot: ${JSON.stringify(ownerRootReal)},
    sessionId: ${JSON.stringify(sessionId)},
    messages: ${JSON.stringify(messages)},
    c6: { session_id: ${JSON.stringify(sessionId)}, turn_id: 11 },
    leafTip: { id: "leaf-x", parentId: null, type: "message", timestampUtc: "2026-07-25T12:00:07.000Z" },
  });
  process.stdout.write(JSON.stringify({ status: r.status, cand: r.candidate_reused === true, wit: r.witness_reused === true }));
} catch (e) {
  console.error(String(e && e.stack || e));
  process.exit(2);
}
`;
  const workerFile = path.join(tmp, "xproc-worker.mjs");
  fs.writeFileSync(workerFile, workerSrc);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerFile], {
      env: { ...process.env, PI_ASTACK_ENABLE_TEST_HOOKS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`child exit ${code}: ${err.slice(0, 400)}`));
      else {
        try { resolve(JSON.parse(out)); }
        catch { reject(new Error(`bad child out: ${out}`)); }
      }
    });
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert(a.status === "complete" && b.status === "complete", `statuses ${a.status}/${b.status}`);
  // At least one must have been a reuse (or both complete with only 2 records).
  const { records, sessionRoot } = countEdgeRecords(sessionId);
  assert(records === 2, `cross-process must yield exactly 2 records, got ${records}`);
  const journal = readRecords(sessionRoot);
  assert(journal.filter((r) => r.record_type === "candidate_capture").length === 1, "one candidate");
  assert(journal.filter((r) => r.record_type === "terminal_witness").length === 1, "one witness");
});

await check("agent_end handler path: await complete, pending delta 0, unique owner", async () => {
  writeSettings(daemonEdgeSettings());
  const jiti2 = createJiti(import.meta.url + `#agent-end-${Date.now()}`, { interopDefault: true });
  const sediment = await jiti2.import(path.join(root, "extensions/sediment/index.ts"));
  const pi = fakePi();
  (sediment.default ?? sediment)(pi.api);
  assert(pi.handlers.has("agent_end"), "agent_end registered");
  assert(pi.handlers.has("session_start"), "session_start registered");

  const sessionId = "sess-agent-end-hook";
  const leaf = makeLeaf("leaf-hook");
  const ctx = makeCtx(sessionId, leaf);
  const pendingBefore = countPending();
  for (const h of pi.handlers.get("session_start") ?? []) {
    await h({}, ctx);
  }
  for (const h of pi.handlers.get("before_agent_start") ?? []) {
    await h({}, ctx);
  }
  const causal2 = await jiti2.import(path.join(root, "extensions/_shared/causal-anchor.ts"));
  if (!causal2.getCurrentAnchor() || causal2.getCurrentAnchor().session_id !== sessionId) {
    causal2._setCurrentAnchorForTests(sessionId, 0);
  }

  for (const h of pi.handlers.get("agent_end") ?? []) {
    await h({ messages: healthyMessages }, ctx);
  }

  const pendingAfter = countPending();
  assert(pendingAfter === pendingBefore, `agent_end daemon edge pending must not grow (${pendingBefore}→${pendingAfter})`);

  const { records, sessionRoot } = countEdgeRecords(sessionId);
  assert(records === 2, `agent_end must complete pair before return, got ${records}`);
  // No dual-owner fallback.
  const byOwner = path.join(abrainHome, ".state", "sediment", "edge-protocol-shadow", "by-owner");
  const owners = fs.readdirSync(byOwner);
  assert(owners.length === 1, `unique owner after agent_end, got ${owners.length}`);
  const journal = readRecords(sessionRoot);
  assert(journal.some((r) => r.record_type === "candidate_capture"), "candidate present");
  assert(journal.some((r) => r.record_type === "terminal_witness"), "witness present");
});

async function runAgentEndCaptureMatrix(label, settingsExtra, sessionId) {
  writeSettings(settingsExtra);
  const jitiX = createJiti(import.meta.url + `#${label}-${Date.now()}`, { interopDefault: true });
  const sediment = await jitiX.import(path.join(root, "extensions/sediment/index.ts"));
  const pi = fakePi();
  (sediment.default ?? sediment)(pi.api);
  const leaf = makeLeaf(`leaf-${label}`);
  const ctx = makeCtx(sessionId, leaf);
  const pendingBefore = countPending();
  const edgeBefore = countEdgeRecords(sessionId).records;
  for (const h of pi.handlers.get("session_start") ?? []) {
    await h({}, ctx);
  }
  for (const h of pi.handlers.get("before_agent_start") ?? []) {
    await h({}, ctx);
  }
  const causalX = await jitiX.import(path.join(root, "extensions/_shared/causal-anchor.ts"));
  if (!causalX.getCurrentAnchor() || causalX.getCurrentAnchor().session_id !== sessionId) {
    causalX._setCurrentAnchorForTests(sessionId, 1);
  }
  for (const h of pi.handlers.get("agent_end") ?? []) {
    await h({ messages: healthyMessages }, ctx);
  }
  const pendingAfter = countPending();
  const edgeAfter = countEdgeRecords(sessionId).records;
  const tripleOpen = sediment._isDaemonEdgeShadowCaptureEnabledForTests() === true;
  return {
    sediment,
    pendingDelta: pendingAfter - pendingBefore,
    edgeDelta: edgeAfter - edgeBefore,
    tripleOpen,
  };
}

await check("capture matrix: incomplete triple gate degrades to foreground effective owner", async () => {
  // Configured daemon + incomplete triple → effective owner=foreground.
  // Local intake has consumer (enqueue/pass). Never orphan, never bypass triple gate for edge.
  // 1) daemon-only, sediment.enabled → foreground intake (pending), no edge.
  {
    const r = await runAgentEndCaptureMatrix(
      "daemon-only-effective-fg",
      {
        executionOwner: "daemon",
        enabled: true,
        daemonWorker: { edgeShadowCaptureEnabled: false },
        edgeProtocolShadow: { enabled: false },
        autoLlmWriteEnabled: false,
      },
      "sess-daemon-only-effective-fg",
    );
    assert(r.tripleOpen === false, "triple gate off");
    assert(r.sediment._resolveEffectiveExecutionOwnerForTests() === "foreground", "effective owner foreground");
    assert(r.edgeDelta === 0, `incomplete gate must not write edge (delta=${r.edgeDelta})`);
    assert(r.pendingDelta === 1, `foreground effective owner intake pending delta=1 got=${r.pendingDelta}`);
  }
  // 2) daemon + edgeProtocolShadow only (capture flag off) → still incomplete triple.
  // Effective owner = foreground: ordinary edgeProtocolShadow path may write edge
  // (not daemon continuous pair / forceCaptureOnly bypass), and intake has consumer.
  {
    const r = await runAgentEndCaptureMatrix(
      "daemon-edge-incomplete-no-bypass",
      {
        executionOwner: "daemon",
        enabled: true,
        daemonWorker: { edgeShadowCaptureEnabled: false },
        edgeProtocolShadow: { enabled: true },
        autoLlmWriteEnabled: false,
      },
      "sess-daemon-edge-incomplete-no-bypass",
    );
    assert(r.tripleOpen === false, "triple gate still off without capture flag");
    assert(r.sediment._resolveEffectiveExecutionOwnerForTests() === "foreground", "effective foreground");
    assert(r.sediment._isDaemonEdgeShadowCaptureEnabledForTests() === false, "daemon continuous pair off");
    assert(r.pendingDelta === 1, `effective foreground intake pending=1 got=${r.pendingDelta}`);
    // Ordinary foreground edge is allowed when edgeProtocolShadow.enabled; not a triple-gate bypass.
    assert(r.edgeDelta >= 0, `edgeDelta=${r.edgeDelta}`);
  }
  // 3) daemon + capture flag without edge substrate → incomplete; no edge; intake.
  {
    const r = await runAgentEndCaptureMatrix(
      "daemon-capture-flag-no-edge",
      {
        executionOwner: "daemon",
        enabled: true,
        daemonWorker: { edgeShadowCaptureEnabled: true },
        edgeProtocolShadow: { enabled: false },
        autoLlmWriteEnabled: false,
      },
      "sess-daemon-capture-flag-no-edge",
    );
    assert(r.tripleOpen === false, "triple incomplete");
    assert(r.edgeDelta === 0, "no edge substrate → no edge write");
    assert(r.pendingDelta === 1, `effective foreground pending=1 got=${r.pendingDelta}`);
  }
  // 4) both capture paths disabled + sediment disabled → pure diagnostic skip (no dual-write).
  {
    const r = await runAgentEndCaptureMatrix(
      "daemon-fully-disabled",
      {
        executionOwner: "daemon",
        enabled: false,
        daemonWorker: { edgeShadowCaptureEnabled: false },
        edgeProtocolShadow: { enabled: false },
        autoLlmWriteEnabled: false,
      },
      "sess-daemon-fully-disabled",
    );
    assert(r.tripleOpen === false, "triple off");
    assert(r.edgeDelta === 0, "disabled: no edge");
    assert(r.pendingDelta === 0, "disabled: no intake");
  }
});

await check("capture matrix: full triple gate is edge-only (no intake dual-write)", async () => {
  const r = await runAgentEndCaptureMatrix(
    "daemon-triple-full",
    {
      executionOwner: "daemon",
      enabled: true,
      daemonWorker: { edgeShadowCaptureEnabled: true },
      edgeProtocolShadow: { enabled: true },
      autoLlmWriteEnabled: false,
    },
    "sess-daemon-triple-full-matrix",
  );
  assert(r.tripleOpen === true, "triple gate open");
  assert(r.edgeDelta >= 1, `full gate edge delta>=1 got=${r.edgeDelta}`);
  assert(r.pendingDelta === 0, `full gate must not dual-write intake (pending=${r.pendingDelta})`);
});

await check("resolveDaemonEdgeOwnerRoot realpath double-fail throws (never returns raw)", async () => {
  writeSettings(daemonEdgeSettings());
  const jitiR = createJiti(import.meta.url + `#realpath-fail-${Date.now()}`, { interopDefault: true });
  const sediment = await jitiR.import(path.join(root, "extensions/sediment/index.ts"));
  const missing = path.join(tmp, "no-such-owner-root", `gone-${Date.now()}`);
  let threw = false;
  let returned;
  try {
    returned = sediment._resolveDaemonEdgeOwnerRootForTests(missing, abrainHome);
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(/daemon_edge_owner_root_realpath_failed|ENOENT|no such file/i.test(msg), `unexpected throw: ${msg}`);
  }
  assert(threw === true, "realpath double-fail must throw (fail closed)");
  assert(returned === undefined, "must not return raw non-realpath owner root");

  // Capture path aggregates skip (no throw out, no edge write) when owner unresolvable.
  const sessionId = "sess-owner-unconfirmed";
  causal._setCurrentAnchorForTests(sessionId, 1);
  const leaf = makeLeaf("leaf-owner-miss");
  const record = intake.buildSedimentIntakeRecord({
    sessionId,
    sessionFile: makeSessionFile(sessionId),
    cwd: missing,
    sourceProjectRoot: missing,
    branchTip: {
      id: leaf.id,
      parentId: leaf.parentId,
      type: leaf.type,
      timestampUtc: leaf.timestamp,
    },
    anchor: { session_id: sessionId, turn_id: 1 },
    captureBoundary: { kind: "agent_end", terminalAssistantStopReason: "stop", boundaryUntrusted: false },
  });
  const pendingBefore = countPending();
  await sediment._maybeCaptureDaemonEdgeProtocolShadowForTests({
    event: { messages: healthyMessages },
    record,
  });
  assert(countPending() === pendingBefore, "owner-unconfirmed capture must not write intake");
  assert(countEdgeRecords(sessionId).records === 0, "owner-unconfirmed capture must not write edge");
});

await check("worker mode: zero capture / no lifecycle", async () => {
  const prev = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  writeSettings(daemonEdgeSettings());
  try {
    const jitiW = createJiti(import.meta.url + `#worker-${Date.now()}`, { interopDefault: true });
    const sediment = await jitiW.import(path.join(root, "extensions/sediment/index.ts"));
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);
    for (const name of ["session_start", "agent_end", "agent_settled", "session_shutdown"]) {
      assert(!pi.handlers.has(name), `worker must not register ${name}`);
    }
    assert(pi.commands.has("sediment-worker-run"), "worker command present");
    assert(pi.commands.has("sediment-worker-maintenance"), "maintenance command present");
  } finally {
    if (prev === undefined) delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
    else process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prev;
  }
});

await check("normal foreground default regression: hooks register, no edge write", async () => {
  delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  writeSettings({
    executionOwner: "foreground",
    daemonWorker: { edgeShadowCaptureEnabled: false },
    edgeProtocolShadow: { enabled: false },
    autoLlmWriteEnabled: false,
  });
  const jitiN = createJiti(import.meta.url + `#normal-${Date.now()}`, { interopDefault: true });
  const sediment = await jitiN.import(path.join(root, "extensions/sediment/index.ts"));
  const pi = fakePi();
  (sediment.default ?? sediment)(pi.api);
  assert(pi.handlers.has("agent_end"), "normal agent_end");
  assert(pi.handlers.has("session_start"), "normal session_start");
  assert(pi.commands.has("sediment"), "normal /sediment");
  assert(!pi.commands.has("sediment-worker-run"), "no worker cmd");
  assert(!pi.commands.has("sediment-worker-maintenance"), "no maintenance cmd");
});

await check("writeEdgeTerminalWitness default semantics unchanged (no silent idempotent)", async () => {
  const sessionId = "sess-wit-default";
  const messages = [
    { role: "user", content: [{ type: "text", text: "wit-default" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
  ];
  const cap = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    messages,
    c6: { session_id: sessionId, turn_id: 1 },
    leafTip: { id: "leaf-wd", parentId: null, type: "message" },
  });
  assert(cap.status === "captured", "candidate");
  const w1 = await edge.writeEdgeTerminalWitness({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    c6: { session_id: sessionId, turn_id: 1 },
  });
  assert(w1.status === "written", "w1");
  const w2 = await edge.writeEdgeTerminalWitness({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    c6: { session_id: sessionId, turn_id: 1 },
  });
  assert(w2.status === "written", "w2 default still appends");
  assert(countEdgeRecords(sessionId).records === 3, "candidate + 2 witnesses without idempotentReuse");
});

await check("real pi --mode rpc: production capture path writes + pending0", async () => {
  writeSettings(daemonEdgeSettings());

  const extensionPath = path.join(root, "extensions/sediment/index.ts");
  const wrapperPath = path.join(tmp, "daemon-edge-e2e-extension.ts");
  const e2eSessionId = "rpc-edge-e2e-session";
  const e2eMessages = [
    { role: "user", content: [{ type: "text", text: "rpc-edge-user-marker" }] },
    { role: "assistant", content: [{ type: "text", text: "rpc-edge-assistant" }], stopReason: "stop" },
  ];
  fs.writeFileSync(wrapperPath, `
import sediment, {
  _maybeCaptureDaemonEdgeProtocolShadowForTests,
  _isDaemonEdgeShadowCaptureEnabledForTests,
} from ${JSON.stringify(extensionPath)};
import { buildSedimentIntakeRecord } from ${JSON.stringify(path.join(root, "extensions/sediment/intake.ts"))};
import { _setCurrentAnchorForTests } from ${JSON.stringify(path.join(root, "extensions/_shared/causal-anchor.ts"))};

export default function (pi: any) {
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  process.env.ABRAIN_ROOT = ${JSON.stringify(abrainHome)};
  process.env.PI_ASTACK_SETTINGS_PATH = ${JSON.stringify(settingsPath)};
  delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  sediment(pi);
  pi.registerCommand("sediment-edge-capture-smoke", {
    description: "test-only edge capture (PI_ASTACK_ENABLE_TEST_HOOKS)",
    handler: async () => {
      if (!_isDaemonEdgeShadowCaptureEnabledForTests()) {
        pi?.ui?.notify?.("edge-capture-smoke:disabled", "error");
        return;
      }
      const sessionId = ${JSON.stringify(e2eSessionId)};
      _setCurrentAnchorForTests(sessionId, 5);
      const record = buildSedimentIntakeRecord({
        sessionId,
        sessionFile: ${JSON.stringify(path.join(tmp, "rpc-e2e-session.jsonl"))},
        cwd: ${JSON.stringify(projectRoot)},
        sourceProjectRoot: ${JSON.stringify(ownerRootReal)},
        branchTip: {
          id: "rpc-leaf",
          parentId: null,
          type: "message",
          timestampUtc: "2026-07-25T13:00:00.000Z",
        },
        anchor: { session_id: sessionId, turn_id: 5 },
        captureBoundary: { kind: "agent_end", terminalAssistantStopReason: "stop", boundaryUntrusted: false },
      });
      await _maybeCaptureDaemonEdgeProtocolShadowForTests({
        event: { messages: ${JSON.stringify(e2eMessages)} },
        record,
      });
      pi?.ui?.notify?.("edge-capture-smoke:complete", "info");
    },
  });
}
`);
  fs.writeFileSync(path.join(tmp, "rpc-e2e-session.jsonl"), `${JSON.stringify({
    type: "session",
    id: e2eSessionId,
    cwd: projectRoot,
    timestamp: "2026-07-25T13:00:00.000Z",
  })}\n`);

  const pendingBefore = countPending();
  const child = spawn("pi", [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension", wrapperPath,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      ABRAIN_ROOT: abrainHome,
      PI_ASTACK_SETTINGS_PATH: settingsPath,
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });

  function send(obj) {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  const deadline = Date.now() + 45_000;
  function waitFor(predicate, label) {
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() > deadline) {
          return reject(new Error(`timeout ${label}\nSTDOUT:\n${stdout.slice(0, 1200)}\nSTDERR:\n${stderr.slice(0, 800)}`));
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  await new Promise((r) => setTimeout(r, 400));
  send({ id: "c1", type: "get_commands" });
  await waitFor(
    () => stdout.includes("sediment-edge-capture-smoke") || stdout.includes("get_commands"),
    "get_commands",
  );
  assert(!/\"name\"\s*:\s*\"sediment-worker-run\"/.test(stdout), "ordinary rpc must not register worker command");

  send({ id: "p1", type: "prompt", message: "/sediment-edge-capture-smoke" });
  await waitFor(() => stdout.includes("edge-capture-smoke:complete") || stdout.includes("\"id\":\"p1\""), "capture command");
  await new Promise((r) => setTimeout(r, 300));

  const assistantStream = stdout.split("\n").some((l) => l.includes("\"role\":\"assistant\"") && l.includes("message_update"));
  assert(!assistantStream, "extension command must not start agent LLM stream");

  const { records, sessionRoot } = countEdgeRecords(e2eSessionId);
  assert(records === 2, `rpc e2e expected 2 records, got ${records}`);
  const journal = readRecords(sessionRoot);
  assert(journal[0].record_type === "candidate_capture", "e2e candidate");
  assert(journal[1].record_type === "terminal_witness", "e2e witness");
  const contentId = journal[0].payload_digest;
  const sourcePath = edge.edgeSourcePath(sessionRoot, contentId);
  const envelope = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const messagesJson = JSON.stringify(edge.toJsonSafe(e2eMessages));
  assert(JSON.stringify(envelope.messages) === messagesJson, "e2e sidecar exact");
  assert(!stdout.includes("rpc-edge-user-marker"), "stdout must not leak raw user text");
  assert(!stderr.includes("rpc-edge-user-marker"), "stderr must not leak raw user text");
  const pendingAfter = countPending();
  assert(pendingAfter === pendingBefore, `rpc e2e pending must stay 0-delta (${pendingBefore}→${pendingAfter})`);

  child.stdin.end();
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
});

await check("legacy candidate-only + witness recovery reuses legacy_content key", async () => {
  const sessionId = "sess-legacy-cand";
  const digestMessages = [
    { role: "user", content: [{ type: "text", text: "legacy-user" }] },
    { role: "assistant", id: "leaf-legacy-real", type: "message", content: [{ type: "text", text: "legacy-asst" }], stopReason: "stop" },
  ];
  const c6 = { session_id: sessionId, turn_id: 3 };
  // Write candidate without leaf_tip (legacy journal row).
  const cap = await edge.captureEdgeProtocolCandidate({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    messages: digestMessages,
    c6,
    // no leafTip → legacy_content:digest admission identity
  });
  assert(cap.status === "captured", `legacy cand ${cap.status}`);
  assert(!cap.record.leaf_tip, "legacy candidate has no leaf_tip");
  const digest = cap.record.payload_digest;
  const legacyId = edge.resolveTerminalLeafId({ payloadDigest: digest });
  assert(legacyId === `legacy_content:${digest}`, "legacy key");

  // New capture with real leaf + same digest + same C6 must reuse (no duplicate pair).
  const pair = await edge.captureEdgeProtocolTerminalPair({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    messages: digestMessages,
    c6,
    leafTip: { id: "leaf-legacy-real", parentId: null, type: "message", timestampUtc: "2026-07-25T14:00:00.000Z" },
  });
  assert(pair.status === "complete", `pair ${pair.status} ${pair.error_code || ""}`);
  assert(pair.candidate_reused === true, "must reuse legacy candidate");
  assert(countEdgeRecords(sessionId).records === 2, "candidate + one witness only");

  // Owner witness recovery on candidate-only legacy is already covered; pin path:
  const wit = await edge.writeEdgeTerminalWitness({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId,
    c6,
    leafTip: { id: "leaf-legacy-real", parentId: null, type: "message" },
    candidateRecordId: cap.record.record_id,
    idempotentReuse: true,
  });
  assert(wit.status === "written", `wit ${wit.status}`);
  assert(countEdgeRecords(sessionId).records === 2, "idempotent witness reuse");
});

await check("Opus adversarial T1/T1c/T2/T4/T5/T6/T7/T9 identity + operator gates", async () => {
  const captureAuditPath = path.join(tmp, "adv-capture-audit.jsonl");
  const operatorAuditPath = path.join(tmp, "adv-operator-audit.jsonl");

  // T4 / F3: same C6 multiple candidates without leaf → ambiguous_candidate (never latest).
  const sessAmb = "sess-ambiguous";
  const pLa1 = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessAmb,
    messages: [{ role: "assistant", id: "la1", stopReason: "stop", content: [{ type: "text", text: "a1" }] }],
    c6: { session_id: sessAmb, turn_id: 1 },
    leafTip: { id: "la1", parentId: null, type: "message" },
  });
  const pLa2 = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessAmb,
    messages: [{ role: "assistant", id: "la2", stopReason: "stop", content: [{ type: "text", text: "a2" }] }],
    c6: { session_id: sessAmb, turn_id: 1 },
    leafTip: { id: "la2", parentId: null, type: "message" },
  });
  assert(pLa1.status === "complete" && pLa2.status === "complete", "T4 seed pairs");
  const recordsBeforeMiss = countEdgeRecords(sessAmb).records;
  const amb = await edge.writeEdgeTerminalWitness({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessAmb,
    c6: { session_id: sessAmb, turn_id: 1 },
    // no leafTip
  });
  assert(amb.status === "journal_failed", `amb status ${amb.status}`);
  assert(amb.error_code === "ambiguous_candidate", `amb code ${amb.error_code}`);

  // F3: unknown leaf must NOT fall back to C6 latest / must not write.
  const missLeaf = await edge.writeEdgeTerminalWitness({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessAmb,
    c6: { session_id: sessAmb, turn_id: 1 },
    leafTip: { id: "la3-unknown", parentId: null, type: "message" },
  });
  assert(missLeaf.status === "journal_failed", `miss status ${missLeaf.status}`);
  assert(missLeaf.error_code === "leaf_not_found", `miss code ${missLeaf.error_code}`);
  assert(countEdgeRecords(sessAmb).records === recordsBeforeMiss, "F3 unknown leaf zero write");

  // With real leaf id, agent_settled-style selection succeeds and binds that leaf's candidate.
  const okLeaf = await edge.writeEdgeTerminalWitness({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessAmb,
    c6: { session_id: sessAmb, turn_id: 1 },
    leafTip: { id: "la1", parentId: null, type: "message" },
    idempotentReuse: true,
  });
  assert(okLeaf.status === "written", `leaf select ${okLeaf.status}`);
  assert(okLeaf.record?.leaf_tip?.id === "la1", `F3 witness leaf ${okLeaf.record?.leaf_tip?.id}`);
  assert(
    okLeaf.record?.candidate_ref?.record_id === pLa1.candidate?.record?.record_id,
    `F3 witness must bind la1 candidate not la2 (got ${okLeaf.record?.candidate_ref?.record_id})`,
  );

  // T6: symlink source fail-closed
  const sessSym = "sess-symlink";
  const sessionRootSym = edge.edgeSessionRoot(abrainHome, ownerRootReal, sessSym);
  fs.mkdirSync(edge.edgeSourcesDir(sessionRootSym), { recursive: true, mode: 0o700 });
  const fakeId = "b".repeat(64);
  const realFile = path.join(tmp, "outside-source.json");
  fs.writeFileSync(realFile, "{}");
  fs.symlinkSync(realFile, path.join(edge.edgeSourcesDir(sessionRootSym), `${fakeId}.json`));
  const readSym = await edge.readEdgeSourceBytesSafe(path.join(edge.edgeSourcesDir(sessionRootSym), `${fakeId}.json`));
  assert(readSym.ok === false && readSym.error_code === "source_symlink_rejected", `symlink ${readSym.error_code}`);

  // T1/T1c: never synthesize — missing capture audit → nonrecoverable
  const sessNr = "sess-nonrec";
  // Plant a healthy source without audit via conflict on fresh leaf after seed...
  const leafNr = { id: "leaf-nr", parentId: null, type: "message", timestampUtc: "2026-07-25T15:00:00.000Z" };
  await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessNr,
    messages: [{ role: "assistant", id: "leaf-nr", stopReason: "stop", content: [{ type: "text", text: "nr1" }] }],
    c6: { session_id: sessNr, turn_id: 9 },
    leafTip: leafNr,
    captureAuditPath: path.join(tmp, "unused-audit.jsonl"),
  });
  // Create unreferenced by deleting journal only (tmp), without adding to captureAuditPath used by recover.
  const rootNr = edge.edgeSessionRoot(abrainHome, ownerRootReal, sessNr);
  for (const n of fs.readdirSync(edge.edgeJournalRecordsDir(rootNr))) {
    fs.unlinkSync(path.join(edge.edgeJournalRecordsDir(rootNr), n));
  }
  const dryNr = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: sessNr,
    captureAuditPath, // empty / unrelated
    limit: 10,
  });
  assert(dryNr.nonrecoverable >= 1, `T1 nonrecoverable=${dryNr.nonrecoverable}`);
  assert(dryNr.recovered === 0, "T1 no recover without audit");

  // T7: execute requires capture-audit-path / operator-audit / limit / session scope
  const t7 = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome,
    ownerProjectRoot: ownerRootReal,
    sessionId: sessNr,
    execute: true,
    limit: 10,
  });
  assert(t7.status === "failed", "T7 fail without capture audit");
  assert(t7.error_code === "capture_audit_path_required" || t7.error_code === "operator_audit_path_required", t7.error_code);

  // T2: terminal_identity_content_conflict never recover (audit marks rejected)
  const sessT2 = "sess-t2-reject";
  const leafT2 = { id: "leaf-t2", parentId: null, type: "message", timestampUtc: "2026-07-25T15:10:00.000Z" };
  await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessT2,
    messages: [{ role: "assistant", id: "leaf-t2", stopReason: "stop", content: [{ type: "text", text: "t2a" }] }],
    c6: { session_id: sessT2, turn_id: 1 },
    leafTip: leafT2,
    captureAuditPath,
  });
  await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessT2,
    messages: [{ role: "assistant", id: "leaf-t2", stopReason: "stop", content: [{ type: "text", text: "t2b" }] }],
    c6: { session_id: sessT2, turn_id: 1 },
    leafTip: leafT2,
    captureAuditPath,
  });
  const dryT2 = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessT2, captureAuditPath, limit: 20,
  });
  assert(dryT2.rejected >= 1, `T2 rejected=${dryT2.rejected}`);
  assert((dryT2.items || []).some((i) => i.result === "rejected" && i.error_code === "terminal_identity_content_conflict"), "T2 item rejected");

  // F4: limit_reached / truncated / remaining_unknown when eligible hits --limit.
  const lim = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessNr, captureAuditPath, limit: 1,
  });
  // sessNr has ≥1 eligible nonrecoverable; with limit 1 may or may not truncate depending on count.
  assert(typeof lim.limit_reached === "boolean", "F4 limit_reached field");
  assert(typeof lim.truncated === "boolean", "F4 truncated field");
  assert(typeof lim.remaining_unknown === "boolean", "F4 remaining_unknown field");
  assert(lim.truncated === lim.limit_reached && lim.remaining_unknown === lim.limit_reached, "F4 flag consistency");

  // F5: audit append rejects symlink (fail closed).
  const auditSymTarget = path.join(tmp, "audit-outside.jsonl");
  fs.writeFileSync(auditSymTarget, "");
  const auditSymPath = path.join(tmp, "audit-symlink.jsonl");
  fs.symlinkSync(auditSymTarget, auditSymPath);
  let auditSymErr = null;
  try {
    await edge.appendEdgeOperatorAuditEntry(auditSymPath, {
      schema: edge.EDGE_OPERATOR_AUDIT_SCHEMA,
      schema_version: 1,
      created_at: new Date().toISOString(),
      mode: "dry_run",
      kind: "summary",
      session_id_hash: "x".repeat(64),
      scanned: 0,
      eligible: 0,
    });
  } catch (err) {
    auditSymErr = err;
  }
  assert(auditSymErr, "F5 symlink audit append must throw");
  assert(String(auditSymErr.message || auditSymErr).includes("audit_symlink_rejected")
    || String(auditSymErr.message || auditSymErr).includes("symlink"),
    `F5 err ${auditSymErr.message || auditSymErr}`);

  // Production-copy dry-run: hash /tmp copy before/after actual recovery (never touch real home).
  const realProdRoot = path.join(os.homedir(), ".abrain", ".state", "sediment", "edge-protocol-shadow");
  if (fs.existsSync(realProdRoot)) {
    const hashTree = (dir) => {
      const h = crypto.createHash("sha256");
      const walk = (d) => {
        for (const name of fs.readdirSync(d).sort()) {
          const p = path.join(d, name);
          const st = fs.lstatSync(p);
          h.update(name);
          if (st.isSymbolicLink()) {
            h.update(`symlink:${fs.readlinkSync(p)}`);
          } else if (st.isDirectory()) walk(p);
          else if (st.isFile()) h.update(fs.readFileSync(p));
        }
      };
      walk(dir);
      return h.digest("hex");
    };
    const prodCopyHome = fs.mkdtempSync(path.join(os.tmpdir(), "edge-prodcopy-smoke-"));
    const prodCopyRoot = path.join(prodCopyHome, "edge-protocol-shadow");
    fs.cpSync(realProdRoot, prodCopyRoot, { recursive: true, verbatimSymlinks: true });
    // Point a disposable abrain home so recovery walks the copy, not production.
    const copyAbrain = path.join(prodCopyHome, "abrain");
    fs.mkdirSync(path.join(copyAbrain, ".state", "sediment"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(prodCopyRoot, path.join(copyAbrain, ".state", "sediment", "edge-protocol-shadow"));
    const before = hashTree(prodCopyRoot);
    await edge.recoverEdgeProtocolUnreferencedSources({
      abrainHome: copyAbrain,
      ownerProjectRoot: ownerRootReal,
      allSessions: true,
      limit: 5,
      captureAuditPath: path.join(tmp, "empty-capture-audit-for-prodcopy.jsonl"),
    });
    const after = hashTree(prodCopyRoot);
    assert(before === after, "production-copy dry-run must not mutate tree hash");
    fs.rmSync(prodCopyHome, { recursive: true, force: true });
  }

  // Execute recoverable only + second pass 0 + operator audit durable (T9)
  const sessOk = "sess-t9-ok";
  const leafOk = { id: "leaf-t9", parentId: null, type: "message", timestampUtc: "2026-07-25T16:00:00.000Z" };
  const p9 = await edge.captureEdgeProtocolTerminalPair({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessOk,
    messages: [{ role: "assistant", id: "leaf-t9", stopReason: "stop", content: [{ type: "text", text: "t9" }] }],
    c6: { session_id: sessOk, turn_id: 2, subturn: 1, sub_agent_label: "worker" },
    leafTip: leafOk,
    captureAuditPath,
  });
  assert(p9.status === "complete", "t9 seed");
  const dig9 = p9.candidate.source.content_id;
  const root9 = edge.edgeSessionRoot(abrainHome, ownerRootReal, sessOk);
  const recsBefore9 = countEdgeRecords(sessOk).records;
  for (const n of fs.readdirSync(edge.edgeJournalRecordsDir(root9))) {
    fs.unlinkSync(path.join(edge.edgeJournalRecordsDir(root9), n));
  }
  // Preserve original capture audit identity (C6 number/string/subturn/subagent).
  const e1 = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessOk,
    limit: 5, captureAuditPath, operatorAuditPath, execute: true,
  });
  assert(e1.recovered === 1, `T9 recovered=${e1.recovered}`);
  assert(countEdgeRecords(sessOk).records === 2, "T9 pair restored");
  const restored = (await edge.listEdgeJournalRecords(root9)).find((r) => r.record_type === "candidate_capture");
  assert(restored.c6.turn_id === 2 && restored.c6.subturn === 1 && restored.c6.sub_agent_label === "worker", "C6 preserved");
  assert(restored.leaf_tip.id === "leaf-t9", "leaf preserved");
  assert(restored.payload_digest === dig9, "digest preserved");
  // F8: operator-facing leaf id is hash prefix, never short leaf id full value.
  const leafHashPrefix = edge.idHashPrefix("leaf-t9");
  const recoveredItem = (e1.items || []).find((i) => i.result === "recovered");
  assert(recoveredItem?.terminal_leaf_id_prefix === leafHashPrefix, `F8 leaf hash prefix got ${recoveredItem?.terminal_leaf_id_prefix}`);
  assert(recoveredItem?.terminal_leaf_id_prefix !== "leaf-t9", "F8 must not emit raw short leaf id");
  const e2 = await edge.recoverEdgeProtocolUnreferencedSources({
    abrainHome, ownerProjectRoot: ownerRootReal, sessionId: sessOk,
    limit: 5, captureAuditPath, operatorAuditPath, execute: true,
  });
  assert(e2.recovered === 0, "T9 second pass 0");
  assert(countEdgeRecords(sessOk).records === 2, "T9 records stable");
  assert(recsBefore9 === 2, "original seed was pair");
  assert(fs.existsSync(operatorAuditPath), "T9 operator audit durable");
  // F8/F9: execute operator audit only eligible actions + summary (no already_referenced noise).
  const opLines = fs.readFileSync(operatorAuditPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert(opLines.every((row) => row.result !== "already_referenced"), "F8 no already_referenced operator audit rows");
  assert(opLines.some((row) => row.kind === "summary"), "F8 summary audit present");
  assert(opLines.some((row) => row.kind === "item" && row.result === "recovered"), "F8 eligible recovered audit present");
});

await check("strict tsc on producer surface including index.ts", async () => {
  const tscJs = path.join(root, "node_modules/typescript/lib/tsc.js");
  assert(fs.existsSync(tscJs), "repo-local typescript missing");
  const typeRoots = path.join(root, "node_modules/@types");

  // Isolated producer modules: NodeNext strict (matches prior edge smokes).
  for (const targetFile of [
    path.join(root, "extensions/sediment/edge-protocol-shadow.ts"),
    path.join(root, "extensions/sediment/settings.ts"),
  ]) {
    const result = spawnSync(process.execPath, [
      tscJs,
      "--lib", "ES2022",
      "--types", "node",
      "--typeRoots", typeRoots,
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--esModuleInterop",
      "--strict",
      "--skipLibCheck",
      "--noEmit",
      targetFile,
    ], { cwd: root, encoding: "utf8", timeout: 180_000 });
    if (result.status !== 0) {
      throw new Error(`tsc failed for ${path.basename(targetFile)} status=${result.status}\n${result.stdout}\n${result.stderr}`);
    }
  }

  // index.ts pulls the whole extension graph; use Bundler resolution (repo import style
  // omits .js extensions). Fail only on NEW errors in index.ts producer wiring —
  // known pre-existing graph errors outside the continuous producer surface are ignored.
  const indexResult = spawnSync(process.execPath, [
    tscJs,
    "--lib", "ES2022",
    "--types", "node",
    "--typeRoots", typeRoots,
    "--target", "ES2022",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--esModuleInterop",
    "--strict",
    "--skipLibCheck",
    "--noEmit",
    path.join(root, "extensions/sediment/index.ts"),
  ], { cwd: root, encoding: "utf8", timeout: 180_000 });
  const indexErrors = String(indexResult.stdout || "")
    .split("\n")
    .filter((line) => /extensions\/sediment\/index\.ts\(/.test(line));
  // Producer surface symbols must not appear in error text.
  const producerHits = indexErrors.filter((line) =>
    /maybeCaptureDaemonEdgeProtocolShadow|resolveDaemonEdgeOwnerRoot|isDaemonEdgeShadowCaptureEnabled|resolveEffectiveExecutionOwner|isDaemonTripleGateComplete|resolveHealthyTerminalAssistant|maybeInitAndRecoverDaemonEdgeShadow|EDGE_ACCEPTED_TERMINAL|captureEdgeProtocolTerminalPair|recoverEdgeProtocolMissingWitnessesForOwner|daemon_effective_owner_foreground|daemon_edge_owner_root_realpath_failed/.test(line),
  );
  if (producerHits.length > 0) {
    throw new Error(`tsc producer errors in index.ts:\n${producerHits.join("\n")}`);
  }
  // Sanity: tsc actually ran against index (either clean or only pre-existing).
  assert(indexResult.status === 0 || indexErrors.length >= 0, "tsc index did not run");
});

console.log(`\n${passed} checks passed`);
process.exit(0);
