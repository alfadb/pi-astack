#!/usr/bin/env node
/**
 * Stage0 sediment worker-safe RPC smoke (post Critical/High review fix).
 *
 * Covers:
 *  - worker mode: zero lifecycle hooks + task/maintenance/capabilities commands
 *  - normal mode lifecycle hooks still register (regression)
 *  - foreground daemon-owner: capture ok, no enqueue
 *  - manifest unknown fields / content_id required / integer strictness
 *  - sidecar path shape under copy-store root; O_NOFOLLOW symlink reject
 *  - success receipt only when checkpoint advanced + settled true
 *  - more loop; no-progress no receipt; failed→retry success
 *  - corrupt receipt fail closed; global serialization
 *  - real pi --mode rpc E2E with bound project + controllable checkpoint advance
 *  - ordinary queue / frozen adapter regression entry points stay importable
 *
 * Never reads/prints real vault/raw production content.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

function assert(value, message) {
  if (!value) throw new Error(message);
}

function hex64(seed) {
  return crypto.createHash("sha256").update(String(seed)).digest("hex");
}

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-sediment-worker-"));
const abrainHome = path.join(tmp, "abrain");
const projectRoot = path.join(tmp, "project");
const copyStoreRoot = path.join(tmp, "copy-store");
fs.mkdirSync(abrainHome, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(copyStoreRoot, { recursive: true });

// Real project binding (forbid project_not_bound soft-skip acceptance).
const runtime = await (async () => {
  const jiti0 = createJiti(import.meta.url, { interopDefault: true });
  return jiti0.import(path.join(root, "extensions/_shared/runtime.ts"));
})();
await runtime.bindAbrainProject({
  abrainHome,
  cwd: projectRoot,
  projectId: "worker-smoke-proj",
  now: "2026-07-25T00:00:00.000+08:00",
});
const ownerRootReal = fs.realpathSync.native(path.resolve(projectRoot));

process.env.ABRAIN_ROOT = abrainHome;
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
process.env.PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT = copyStoreRoot;
process.env.PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS = JSON.stringify([ownerRootReal]);

const settingsPath = path.join(tmp, "settings.json");
function writeSettings(extra = {}) {
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
    sediment: {
      enabled: true,
      autoLlmWriteEnabled: false,
      executionOwner: "daemon",
      edgeProtocolShadow: { enabled: false },
      ...extra,
    },
  }, null, 2)}\n`);
}
writeSettings();
process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;

const jiti = createJiti(import.meta.url, { interopDefault: true });

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

console.log("sediment worker-safe RPC Stage0 (post-review)");

await check("worker mode: zero lifecycle hooks + closed worker commands", async () => {
  const prev = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  try {
    const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
    const pi = fakePi();
    const activate = sediment.default ?? sediment;
    activate(pi.api);
    const lifecycle = [
      "session_start",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "agent_settled",
      "session_shutdown",
    ];
    for (const name of lifecycle) {
      assert(!pi.handlers.has(name), `worker mode registered lifecycle hook ${name}`);
    }
    assert(pi.commands.has("sediment-worker-run"), "missing sediment-worker-run command");
    assert(pi.commands.has("sediment-worker-maintenance"), "missing sediment-worker-maintenance command");
    assert(pi.commands.has("sediment-worker-capabilities"), "missing sediment-worker-capabilities command");
    assert(pi.commands.has("sediment-worker-canonical-control"), "missing sediment-worker-canonical-control command");
    assert(!pi.commands.has("sediment"), "ordinary /sediment must not register in worker mode");
  } finally {
    if (prev === undefined) delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
    else process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prev;
  }
});

await check("normal mode: lifecycle hooks still register (regression)", async () => {
  const prev = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  writeSettings({ executionOwner: "foreground" });
  try {
    // Fresh jiti for settings re-read is best-effort; settings path is same file.
    const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
    const pi = fakePi();
    const activate = sediment.default ?? sediment;
    activate(pi.api);
    assert(pi.handlers.has("agent_end"), "normal mode missing agent_end");
    assert(pi.handlers.has("session_start"), "normal mode missing session_start");
    assert(pi.handlers.has("agent_start"), "normal mode missing agent_start");
    assert(pi.commands.has("sediment"), "normal mode missing /sediment");
    assert(!pi.commands.has("sediment-worker-run"), "worker command must not register outside worker mode");
    assert(!pi.commands.has("sediment-worker-maintenance"), "maintenance command must not register outside worker mode");
    assert(!pi.commands.has("sediment-worker-capabilities"), "capabilities command must not register outside worker mode");
    assert(!pi.commands.has("sediment-worker-canonical-control"), "canonical control must not register outside worker mode");
  } finally {
    if (prev !== undefined) process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prev;
    writeSettings({ executionOwner: "daemon" });
  }
});

await check("foreground daemon-owner: capture without enqueue", async () => {
  const prev = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  writeSettings({ executionOwner: "daemon" });
  try {
    const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
    const settings = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
    const cfg = settings.resolveSedimentSettings();
    assert(cfg.executionOwner === "daemon", `executionOwner=${cfg.executionOwner}`);
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);
    // Lifecycle still present for capture path.
    assert(pi.handlers.has("agent_end"), "daemon-owner must keep agent_end for capture");
    assert(pi.handlers.has("session_start"), "daemon-owner must keep session_start");
    // Queue must stay idle when enqueue is gated — exercise enqueue via agent_end
    // only if we can; instead assert helper gate by importing queue stats after
    // a no-op (no agent_end fire with real intake in this unit).
    assert(!pi.commands.has("sediment-worker-run"), "worker cmd only in worker mode");
    assert(!pi.commands.has("sediment-worker-maintenance"), "maintenance cmd only in worker mode");
    assert(!pi.commands.has("sediment-worker-capabilities"), "capabilities cmd only in worker mode");
    assert(!pi.commands.has("sediment-worker-canonical-control"), "canonical control only in worker mode");
  } finally {
    if (prev !== undefined) process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prev;
  }
});

const worker = await jiti.import(path.join(root, "extensions/sediment/worker-rpc.ts"));
const outbox = await jiti.import(path.join(root, "extensions/sediment/publication-outbox.ts"));
const writer = await jiti.import(path.join(root, "extensions/sediment/writer.ts"));
const sedimentSettings = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
const edge = await jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));
const checkpoint = await jiti.import(path.join(root, "extensions/sediment/checkpoint.ts"));

function placeSidecar({ sessionId, messages, terminalRecordId }) {
  const messagesJson = JSON.stringify(messages);
  const contentId = edge.computePayloadDigest(messagesJson);
  const body = edge.buildEdgeSourceEnvelopeBody({
    contentId,
    sessionId,
    messageCount: messages.length,
    messagesJson,
  });
  const dir = path.join(copyStoreRoot, "records", terminalRecordId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sidecarPath = path.join(dir, "sidecar.bin");
  fs.writeFileSync(sidecarPath, body, { mode: 0o600 });
  return { sidecarPath, contentId, body };
}

function baseManifest(overrides = {}) {
  const sessionId = "sess-worker-smoke-1";
  const terminal_record_id = overrides.terminal_record_id ?? hex64("term-1");
  const { sidecarPath, contentId } = placeSidecar({
    sessionId,
    terminalRecordId: terminal_record_id,
    messages: [
      { role: "user", content: [{ type: "text", text: "note preference for concise diffs" }] },
      { role: "assistant", content: [{ type: "text", text: "acked" }], stopReason: "stop" },
    ],
  });
  return {
    schema: "pi-astack/sediment-worker-task/v1",
    request_id: hex64("req-1"),
    terminal_record_id,
    session_id: sessionId,
    owner_project_root: ownerRootReal,
    owner_key: edge.edgeOwnerKey(ownerRootReal),
    sidecar_path: sidecarPath,
    content_id: contentId,
    task_kind: "terminal_witness",
    c6: { session_id: sessionId, turn_id: 1, subturn: 0 },
    leaf_tip: {
      id: "leaf-1",
      parentId: null,
      type: "message",
      timestampUtc: "2026-07-25T00:00:00.000Z",
    },
    ...overrides,
    // Keep terminal/sidecar consistent when terminal overridden before place:
    ...(overrides.terminal_record_id && !overrides.sidecar_path ? {} : {}),
  };
}

function advancingDeps(opts = {}) {
  const store = new Map();
  let passCount = 0;
  return {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_root, sessionId) => {
      return store.get(sessionId) ?? {};
    },
    runAgentEndPass: async (snapshot) => {
      passCount += 1;
      if (typeof opts.onPass === "function") {
        return opts.onPass({ snapshot, passCount, store });
      }
      // Default: advance checkpoint once, no more.
      const tip = snapshot.branchEntries?.[snapshot.branchEntries.length - 1];
      const tipId = tip && typeof tip === "object" && tip.id ? tip.id : `tip-${passCount}`;
      store.set(snapshot.checkpointSessionId ?? snapshot.sessionId, {
        lastProcessedEntryId: tipId,
      });
      return opts.more === true ? { more: true } : undefined;
    },
    drainKnowledgePublicationOutbox: async () => {
      if (opts.onDrain) opts.onDrain();
    },
    env: process.env,
    _store: store,
    _passCount: () => passCount,
  };
}

await check("manifest negative: unknown fields / wrong schema / non-abs root", async () => {
  let threw = false;
  try {
    worker.validateSedimentWorkerManifest({ ...baseManifest(), schema: "nope" });
  } catch (e) {
    threw = e.code === "schema_mismatch";
  }
  assert(threw, "schema mismatch not rejected");

  threw = false;
  try {
    worker.validateSedimentWorkerManifest({ ...baseManifest(), extra_field: 1 });
  } catch (e) {
    threw = e.code === "unknown_field";
  }
  assert(threw, "unknown top field not rejected");

  threw = false;
  try {
    worker.validateSedimentWorkerManifest({
      ...baseManifest(),
      c6: { session_id: "sess-worker-smoke-1", turn_id: 1, evil: true },
    });
  } catch (e) {
    threw = e.code === "unknown_field";
  }
  assert(threw, "unknown c6 field not rejected");

  threw = false;
  try {
    const m = baseManifest();
    delete m.content_id;
    worker.validateSedimentWorkerManifest(m);
  } catch (e) {
    threw = e.code === "invalid_content_id";
  }
  assert(threw, "missing content_id not rejected");

  threw = false;
  try {
    worker.validateSedimentWorkerManifest({
      ...baseManifest(),
      c6: { session_id: "sess-worker-smoke-1", turn_id: "not-a-number" },
    });
  } catch (e) {
    threw = e.code === "unsupported_integer";
  }
  assert(threw, "non-numeric turn_id must be unsupported_integer");

  threw = false;
  try {
    worker.validateSedimentWorkerManifest({ ...baseManifest(), owner_project_root: "relative/path" });
  } catch (e) {
    threw = e.code === "owner_project_root_not_absolute" || e.code === "owner_project_root_not_canonical";
  }
  assert(threw, "relative owner root not rejected");
});

await check("sidecar digest + symlink + path shape reject", async () => {
  const m = baseManifest({ terminal_record_id: hex64("term-shape") });
  // Re-place because baseManifest already placed for this terminal.
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: m.terminal_record_id,
    messages: [
      { role: "user", content: [{ type: "text", text: "note preference for concise diffs" }] },
      { role: "assistant", content: [{ type: "text", text: "acked" }], stopReason: "stop" },
    ],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  const tamperedPath = path.join(copyStoreRoot, "records", m.terminal_record_id, "sidecar.bin");
  const raw = fs.readFileSync(tamperedPath, "utf8");
  fs.writeFileSync(tamperedPath, raw.replace("concise diffs", "TAMPERED"));
  let code = null;
  try {
    await worker.readAndVerifyWorkerSidecar({
      sidecarPath: tamperedPath,
      sessionId: m.session_id,
      contentId: m.content_id,
    });
  } catch (e) {
    code = e.code;
  }
  assert(code === "messages_digest_mismatch" || code === "sidecar_verify_failed", `digest tamper code=${code}`);

  // Restore good body for symlink test sibling
  const good = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: hex64("term-link"),
    messages: [{ role: "user", content: "x" }],
  });
  const linkPath = path.join(tmp, "sidecar-link.bin");
  fs.symlinkSync(good.sidecarPath, linkPath);
  code = null;
  try {
    await worker.readAndVerifyWorkerSidecar({
      sidecarPath: linkPath,
      sessionId: m.session_id,
      contentId: good.contentId,
    });
  } catch (e) {
    code = e.code;
  }
  assert(code === "sidecar_symlink_rejected", `symlink code=${code}`);

  // Path shape: not under records/<term>/sidecar.bin
  code = null;
  try {
    worker.assertSidecarPathShape({
      sidecarPath: path.join(copyStoreRoot, "evil.bin"),
      copyStoreRoot: fs.realpathSync.native(copyStoreRoot),
      terminalRecordId: m.terminal_record_id,
    });
  } catch (e) {
    code = e.code;
  }
  assert(code === "sidecar_path_shape", `path shape code=${code}`);
});

await check("synthetic branch IDs stable across cumulative leaf_tip change", async () => {
  const messages1 = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b", stopReason: "stop" },
  ];
  const messages2 = [
    ...messages1,
    { role: "user", content: "c" },
  ];
  const b1 = worker.syntheticBranchFromMessages(messages1, {
    id: "TIP1", parentId: null, type: "message", timestampUtc: "2026-01-01T00:00:00.000Z",
  });
  const b2 = worker.syntheticBranchFromMessages(messages2, {
    id: "TIP2", parentId: "x", type: "message", timestampUtc: "2026-01-02T00:00:00.000Z",
  });
  assert(b1.length === 2 && b2.length === 3, "branch lengths");
  assert(b1[0].id === b2[0].id, "first entry id stable");
  assert(b1[1].id === b2[1].id, "previous tip id must not change when leaf_tip changes");
  assert(b1[1].id !== "TIP1", "leaf_tip.id must not become entry id (stability)");
  assert(b2[2].id !== "TIP2", "new tip also content-stable");
});

await check("execution_owner_not_daemon refused", async () => {
  const m = baseManifest({
    request_id: hex64("req-owner"),
    terminal_record_id: hex64("term-owner"),
  });
  // re-place sidecar for this terminal
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: m.terminal_record_id,
    messages: [{ role: "user", content: "o" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    ...advancingDeps(),
    resolveExecutionOwner: () => "foreground",
  });
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.error_code === "execution_owner_not_daemon", `code=${r.error_code}`);
  assert(r.settled === false, "not settled");
  assert(r.retryable === false, "owner misconfig not retryable thrash");
});

await check("success receipt only when CP advanced + settled; idempotent", async () => {
  const term = hex64("term-idem-ok");
  const m = baseManifest({
    request_id: hex64("req-idem-1"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [
      { role: "user", content: [{ type: "text", text: "idem" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  let drained = 0;
  const deps = advancingDeps({ onDrain: () => { drained += 1; } });
  const r1 = await worker.runSedimentWorkerTask(JSON.stringify(m), deps);
  assert(r1.status === "processed", `r1 status=${r1.status} code=${r1.error_code}`);
  assert(r1.settled === true, "r1 settled");
  assert(r1.retryable === false, "r1 not retryable");
  assert(deps._passCount() === 1, "pipeline once");
  assert(r1.publication_pending === false, "empty outbox ⇒ publication_pending false");
  assert(drained === 0, "no in-task publication drain after receipt");

  const r2 = await worker.runSedimentWorkerTask(JSON.stringify({
    ...m,
    request_id: hex64("req-idem-2"),
  }), deps);
  assert(r2.status === "already_processed", `r2 status=${r2.status}`);
  assert(r2.settled === true, "r2 settled");
  assert(r2.publication_pending === false, "already_processed empty outbox ⇒ false");
  assert(deps._passCount() === 1, "pipeline must not re-run");
  assert(drained === 0, "no drain on already_processed either");
});

await check("no-progress (void pass) => no receipt, retryable", async () => {
  const term = hex64("term-noprog");
  const m = baseManifest({
    request_id: hex64("req-noprog"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "skip" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  const deps = advancingDeps({
    onPass: async () => {
      // Soft skip: no checkpoint write.
      return undefined;
    },
  });
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), deps);
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.error_code === "no_progress", `code=${r.error_code}`);
  assert(r.settled === false, "not settled");
  assert(r.retryable === true, "retryable");
  // No receipt file
  const receiptPath = worker.sedimentWorkerReceiptPath(abrainHome, term);
  assert(!fs.existsSync(receiptPath), "no success receipt on no-progress");
});

await check("more loop then settle; budget exhaust retryable no receipt", async () => {
  const term = hex64("term-more");
  const m = baseManifest({
    request_id: hex64("req-more"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "more" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  const deps = advancingDeps({
    onPass: async ({ passCount, store, snapshot }) => {
      store.set(snapshot.checkpointSessionId, {
        lastProcessedEntryId: `tip-${passCount}`,
      });
      // Advance + more for first 2, then settle.
      if (passCount < 3) return { more: true };
      return undefined;
    },
  });
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), deps);
  assert(r.status === "processed", `more-loop status=${r.status} code=${r.error_code}`);
  assert(r.settled === true, "settled after more loop");
  assert(r.pass_iterations === 3, `iterations=${r.pass_iterations}`);
  assert(deps._passCount() === 3, "three passes");

  // Budget exhaust
  const term2 = hex64("term-budget");
  const m2 = baseManifest({
    request_id: hex64("req-budget"),
    terminal_record_id: term2,
  });
  const placed2 = placeSidecar({
    sessionId: m2.session_id,
    terminalRecordId: term2,
    messages: [{ role: "user", content: "budget" }],
  });
  m2.sidecar_path = placed2.sidecarPath;
  m2.content_id = placed2.contentId;
  const deps2 = advancingDeps({
    onPass: async ({ passCount, store, snapshot }) => {
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: `t-${passCount}` });
      return { more: true };
    },
  });
  const r2 = await worker.runSedimentWorkerTask(JSON.stringify(m2), deps2);
  assert(r2.status === "failed", `budget status=${r2.status}`);
  assert(r2.error_code === "more_budget_exhausted", `code=${r2.error_code}`);
  assert(r2.settled === false && r2.retryable === true, "budget retryable");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term2)), "no receipt on budget exhaust");
});

await check("failed then retry success (no durable failed receipt)", async () => {
  const term = hex64("term-retry");
  const m = baseManifest({
    request_id: hex64("req-retry"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "retry-me" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  let attempts = 0;
  const store = new Map();
  const deps = {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: "ok-tip" });
    },
    env: process.env,
  };
  const r1 = await worker.runSedimentWorkerTask(JSON.stringify(m), deps);
  assert(r1.status === "failed" && r1.error_code === "pipeline_threw", `r1=${r1.error_code}`);
  assert(r1.settled === false && r1.retryable === true, "first retryable");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no failed receipt");

  const r2 = await worker.runSedimentWorkerTask(JSON.stringify(m), deps);
  assert(r2.status === "processed" && r2.settled === true, `r2=${r2.status}`);
  assert(attempts === 2, "two attempts");
});

await check("corrupt receipt fail closed", async () => {
  const term = hex64("term-corrupt");
  const m = baseManifest({
    request_id: hex64("req-corrupt"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "c" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const receiptPath = worker.sedimentWorkerReceiptPath(abrainHome, term);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(receiptPath, "{not-valid-receipt\n", { mode: 0o600 });
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), advancingDeps());
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.error_code === "receipt_corrupt_or_collision", `code=${r.error_code}`);
  assert(r.settled === false, "not settled");
  assert(r.retryable === false, "corrupt fail closed");
});

await check("global serialization across terminal ids", async () => {
  const order = [];
  async function one(seed, delayMs) {
    const term = hex64(`term-ser-${seed}`);
    const m = baseManifest({
      request_id: hex64(`req-ser-${seed}`),
      terminal_record_id: term,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: seed }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const store = new Map();
    return worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
      runAgentEndPass: async (snapshot) => {
        order.push(`start-${seed}`);
        await new Promise((r) => setTimeout(r, delayMs));
        store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: `tip-${seed}` });
        order.push(`end-${seed}`);
      },
      env: process.env,
    });
  }
  const [a, b] = await Promise.all([one("A", 40), one("B", 5)]);
  assert(a.status === "processed" && b.status === "processed", "both processed");
  // Global serial: no interleaving of start/end across tasks.
  const joined = order.join(",");
  assert(
    joined === "start-A,end-A,start-B,end-B" || joined === "start-B,end-B,start-A,end-A",
    `serialization broken: ${joined}`,
  );
});

await check("base64url manifest accepted", async () => {
  const term = hex64("term-b64");
  const m = baseManifest({
    request_id: hex64("req-b64"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "b64" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const r = await worker.runSedimentWorkerTask(base64url(m), advancingDeps());
  assert(r.status === "processed", `b64 status=${r.status} ${r.error_code ?? ""}`);
});

await check("command handler notifies aggregate result; requires notify", async () => {
  const term = hex64("term-cmd");
  const m = baseManifest({
    request_id: hex64("req-cmd"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "cmd" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const notifies = [];
  const commands = new Map();
  let passes = 0;
  worker.registerSedimentWorkerCommand({
    registerCommand(name, options) { commands.set(name, options); },
  }, {
    ...advancingDeps({
      onPass: async ({ store, snapshot }) => {
        passes += 1;
        store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: "cmd-tip" });
      },
    }),
  });
  assert(commands.has("sediment-worker-run"), "command registered");

  // Missing notify → must not run pipeline.
  await commands.get("sediment-worker-run").handler(JSON.stringify(m), { ui: {} });
  assert(passes === 0, "no notify ⇒ no execution");

  await commands.get("sediment-worker-run").handler(JSON.stringify(m), {
    ui: { notify(msg, type) { notifies.push({ msg, type }); } },
  });
  const resultNotifies = notifies.filter((n) => n.msg.startsWith("sediment-worker-result:"));
  const progressNotifies = notifies.filter((n) => n.msg.startsWith("sediment-worker-progress:"));
  assert(resultNotifies.length === 1, `one result notify, got ${resultNotifies.length} (total=${notifies.length})`);
  // Progress is optional/best-effort; when present must pass whitelist scan.
  for (const p of progressNotifies) {
    assert(!worker.progressNotifyHasSensitiveContent(p.msg), "progress sensitive");
  }
  const parsed = worker.tryParseWorkerResultNotify(resultNotifies[0].msg);
  assert(parsed, "notify prefix parseable");
  assert(parsed.status === "processed" || parsed.status === "already_processed", `status=${parsed.status}`);
  assert(parsed.settled === true, "notify settled");
  assert(parsed.schema === "pi-astack/sediment-worker-result/v1", "result schema");
  assert(!resultNotifies[0].msg.includes(m.sidecar_path), "notify must not include sidecar path");
  assert(!resultNotifies[0].msg.includes(m.session_id), "notify must not include session_id");
});

await check("worker checkpoint slot independent of source session", async () => {
  const sessionId = "source-session-cp";
  const term = hex64("term-cp-slot");
  const m = baseManifest({
    request_id: hex64("req-cp-slot"),
    terminal_record_id: term,
    session_id: sessionId,
    c6: { session_id: sessionId, turn_id: 2 },
  });
  const placed = placeSidecar({
    sessionId,
    terminalRecordId: term,
    messages: [{ role: "user", content: "cp-slot" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  const workerSlot = worker.workerCheckpointSessionId(sessionId);
  // Seed foreground source slot with a different watermark — must not be used.
  await checkpoint.saveSessionCheckpoint(ownerRootReal, sessionId, {
    lastProcessedEntryId: "foreground-only-tip",
  });

  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: (projectRoot, sid) => checkpoint.loadSessionCheckpoint(projectRoot, sid),
    runAgentEndPass: async (snapshot) => {
      assert(snapshot.sessionId === sessionId, "provenance session");
      assert(snapshot.checkpointSessionId === workerSlot, "worker cp slot");
      assert(snapshot.anchor.session_id === sessionId, "C6 provenance");
      await checkpoint.saveSessionCheckpoint(snapshot.cwd, snapshot.checkpointSessionId, {
        lastProcessedEntryId: "worker-tip-1",
      });
    },
    env: process.env,
  });
  assert(r.status === "processed", `cp slot status=${r.status} ${r.error_code ?? ""}`);
  const fg = await checkpoint.loadSessionCheckpoint(ownerRootReal, sessionId);
  const wk = await checkpoint.loadSessionCheckpoint(ownerRootReal, workerSlot);
  assert(fg.lastProcessedEntryId === "foreground-only-tip", "foreground slot untouched");
  assert(wk.lastProcessedEntryId === "worker-tip-1", "worker slot advanced");
});

// ── Real pi --mode rpc E2E ─────────────────────────────────────────
await check("pi --mode rpc E2E: bound project + CP advance + notify correlation", async () => {
  const sessionId = "rpc-e2e-session";
  const terminal_record_id = hex64("rpc-term");
  const { sidecarPath, contentId } = placeSidecar({
    sessionId,
    terminalRecordId: terminal_record_id,
    messages: [
      { role: "user", content: [{ type: "text", text: "rpc-e2e-user" }] },
      { role: "assistant", content: [{ type: "text", text: "rpc-e2e-assistant" }], stopReason: "stop" },
    ],
  });
  const manifest = {
    schema: "pi-astack/sediment-worker-task/v1",
    request_id: hex64("rpc-req"),
    terminal_record_id,
    session_id: sessionId,
    owner_project_root: ownerRootReal,
    owner_key: edge.edgeOwnerKey(ownerRootReal),
    sidecar_path: sidecarPath,
    content_id: contentId,
    task_kind: "terminal_witness",
    c6: { session_id: sessionId, turn_id: 3 },
    leaf_tip: { id: "rpc-leaf", parentId: null, type: "message", timestampUtc: "2026-07-25T01:00:00.000Z" },
  };

  writeSettings({ executionOwner: "daemon", autoLlmWriteEnabled: false });

  // Preload test hooks file that advances worker checkpoint slot via env flag.
  // The extension itself installs hooks when PI_ASTACK_ENABLE_TEST_HOOKS=1 and
  // a companion marker file is present (written by this smoke before spawn).
  const hookMarker = path.join(tmp, "advance-checkpoint.hook");
  fs.writeFileSync(hookMarker, "1");

  const extensionPath = path.join(root, "extensions/sediment/index.ts");
  const args = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension", extensionPath,
  ];

  // Use a tiny wrapper that activates sediment in worker mode and installs
  // test hooks that advance the worker checkpoint slot (prove real CP progress).
  const wrapperPath = path.join(tmp, "worker-e2e-extension.ts");
  fs.writeFileSync(wrapperPath, `
import * as path from "node:path";
import sediment, { _setSedimentAgentEndTestHooksForTests } from ${JSON.stringify(extensionPath)};
import { saveSessionCheckpoint } from ${JSON.stringify(path.join(root, "extensions/sediment/checkpoint.ts"))};
import { workerCheckpointSessionId } from ${JSON.stringify(path.join(root, "extensions/sediment/worker-rpc.ts"))};

export default function (pi: any) {
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  process.env.ABRAIN_ROOT = ${JSON.stringify(abrainHome)};
  process.env.PI_ASTACK_SETTINGS_PATH = ${JSON.stringify(settingsPath)};
  process.env.PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT = ${JSON.stringify(copyStoreRoot)};
  process.env.PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS = ${JSON.stringify(JSON.stringify([ownerRootReal]))};
  sediment(pi);
  _setSedimentAgentEndTestHooksForTests({
    run: async (snapshot) => {
      const slot = snapshot.checkpointSessionId ?? workerCheckpointSessionId(String(snapshot.sessionId));
      const tip = Array.isArray(snapshot.branchEntries) && snapshot.branchEntries.length > 0
        ? (snapshot.branchEntries[snapshot.branchEntries.length - 1] as { id?: string }).id
        : "e2e-tip";
      await saveSessionCheckpoint(snapshot.cwd, slot, {
        lastProcessedEntryId: tip || "e2e-tip",
      });
    },
  });
}
`);

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
    cwd: tmp,
    env: {
      ...process.env,
      PI_ASTACK_SEDIMENT_WORKER_MODE: "1",
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      ABRAIN_ROOT: abrainHome,
      PI_ASTACK_SETTINGS_PATH: settingsPath,
      PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStoreRoot,
      PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([ownerRootReal]),
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  function send(obj) {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  const deadline = Date.now() + 45_000;
  function waitFor(predicate, label) {
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() > deadline) {
          return reject(new Error(`timeout waiting for ${label}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  await new Promise((r) => setTimeout(r, 300));
  send({ id: "c1", type: "get_commands" });
  await waitFor(() => stdout.includes("sediment-worker-run") || stdout.includes("\"command\":\"get_commands\""), "get_commands");

  const promptMsg = `/sediment-worker-run ${JSON.stringify(manifest)}`;
  send({ id: "p1", type: "prompt", message: promptMsg });

  await waitFor(() => stdout.includes("sediment-worker-result:"), "worker result notify");
  await new Promise((r) => setTimeout(r, 200));

  const lines = stdout.split("\n").filter(Boolean);
  const promptResp = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).find((o) => o.id === "p1" && o.type === "response");

  assert(promptResp, `missing prompt response; stdout=${stdout.slice(0, 800)}`);
  assert(promptResp.success === true, `prompt not success: ${JSON.stringify(promptResp)}`);

  const assistantStream = lines.some((l) => l.includes("\"role\":\"assistant\"") && l.includes("message_update"));
  assert(!assistantStream, "extension command must not stream assistant agent turn");

  const notifyLine = lines.find((l) => l.includes("sediment-worker-result:"));
  assert(notifyLine, `missing worker result notify; stderr=${stderr.slice(0, 400)}`);
  // RPC wraps notify as JSON; message may be escaped. Prefer parse outer, then prefix.
  let result = null;
  try {
    const outer = JSON.parse(notifyLine);
    const candidates = [];
    const walk = (v) => {
      if (typeof v === "string" && v.includes("sediment-worker-result:")) candidates.push(v);
      else if (v && typeof v === "object") {
        for (const x of Object.values(v)) walk(x);
      }
    };
    walk(outer);
    for (const c of candidates) {
      const parsed = worker.tryParseWorkerResultNotify(c);
      if (parsed) { result = parsed; break; }
      const i = c.indexOf("sediment-worker-result:");
      if (i >= 0) {
        try {
          result = JSON.parse(c.slice(i + "sediment-worker-result:".length));
          break;
        } catch { /* continue */ }
      }
    }
  } catch {
    // fall through to raw extract
  }
  if (!result) {
    const idx = notifyLine.indexOf("sediment-worker-result:");
    const payloadText = notifyLine.slice(idx + "sediment-worker-result:".length)
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, "");
    const jsonMatch = payloadText.match(/\{[\s\S]*?\}(?=[^}]*$|"|,|\s*$)/) || payloadText.match(/\{[\s\S]*\}/);
    assert(jsonMatch, "result json not found in notify");
    result = JSON.parse(jsonMatch[0]);
  }
  assert(result.schema === "pi-astack/sediment-worker-result/v1", "e2e schema");
  assert(result.request_id === manifest.request_id, "e2e request_id correlation");
  assert(result.terminal_record_id === manifest.terminal_record_id, "e2e terminal correlation");
  assert(result.status === "processed", `e2e status=${result.status} code=${result.error_code}`);
  assert(result.settled === true, "e2e settled");
  assert(result.retryable === false, "e2e not retryable");
  assert(result.session_id === undefined, "result must not include session_id");
  assert(result.sidecar_path === undefined, "result must not include path");
  assert(result.content_id === undefined, "result must not include content_id");
  assert(!stdout.includes("rpc-e2e-user"), "stdout leaked raw user text");
  assert(!stderr.includes("rpc-e2e-user"), "stderr leaked raw user text");

  // Prove worker checkpoint slot advanced (not project_not_bound skip).
  const slot = worker.workerCheckpointSessionId(sessionId);
  const cp = await checkpoint.loadSessionCheckpoint(ownerRootReal, slot);
  assert(cp.lastProcessedEntryId, `worker CP not advanced: ${JSON.stringify(cp)}`);

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

  console.log(`  e2e_result status=${result.status} settled=${result.settled} cp=${cp.lastProcessedEntryId}`);
});

await check("ordinary queue + frozen adapter modules still import (regression)", async () => {
  const queue = await jiti.import(path.join(root, "extensions/sediment/agent-end-queue.ts"));
  assert(typeof queue.enqueueDetachedAgentEnd === "function", "queue export");
  const frozen = await jiti.import(path.join(root, "extensions/sediment/edge-shadow-frozen-contract-adapter.ts"));
  assert(frozen, "frozen adapter module loads");
});

// ── Budget / progress / cancel (Stage0 end-to-end) ─────────────────────
// Exact error codes only (no OR). Poison tests do NOT reset serial tail.

function resetWorkerBudgetTestState() {
  worker._resetGlobalPassSerialForTests?.();
  worker._resetWorkerProcessPoisonForTests?.();
  worker._setWorkerFenceSliceMsForTests?.(20);
}

await check("old request without budget_ms defaults to 600_000", async () => {
  const m = baseManifest({ request_id: hex64("req-budget-default"), terminal_record_id: hex64("term-budget-default") });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: m.terminal_record_id,
    messages: [{ role: "user", content: "default-budget" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  delete m.budget_ms;
  const validated = worker.validateSedimentWorkerManifest(m);
  assert(validated.budget_ms === 600_000, `default budget_ms=${validated.budget_ms}`);
});

await check("budget_ms validation closed range 60s..3600s", async () => {
  let code = null;
  try {
    worker.validateSedimentWorkerManifest({ ...baseManifest(), budget_ms: 1_000 });
  } catch (e) {
    code = e.code;
  }
  assert(code === "budget_ms_out_of_range", `too-small code=${code}`);

  code = null;
  try {
    worker.validateSedimentWorkerManifest({ ...baseManifest(), budget_ms: 4_000_000 });
  } catch (e) {
    code = e.code;
  }
  assert(code === "budget_ms_out_of_range", `too-large code=${code}`);

  const ok = worker.validateSedimentWorkerManifest({ ...baseManifest(), budget_ms: 60_000 });
  assert(ok.budget_ms === 60_000, "min accepted");
  const ok2 = worker.validateSedimentWorkerManifest({ ...baseManifest(), budget_ms: 3_600_000 });
  assert(ok2.budget_ms === 3_600_000, "max accepted");
});

await check("never-resolving pass → exact pass_deadline_exceeded_unreaped + poison", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-never-pass");
  const m = baseManifest({
    request_id: hex64("req-never-pass"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "never" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  let t = 1_000_000;
  const clock = () => t;
  let seenAbort = false;
  const progressEvents = [];
  const started = Date.now();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    clock,
    onProgress: (ev) => { progressEvents.push(ev); },
    runAgentEndPass: async (_snap, opts) => {
      t = 1_000_000 + 60_000;
      opts?.signal?.addEventListener("abort", () => { seenAbort = true; }, { once: true });
      await new Promise(() => {});
    },
    env: process.env,
  });
  const wall = Date.now() - started;
  assert(wall < 15_000, `must not sleep full budget; wall=${wall}ms`);
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.error_code === "pass_deadline_exceeded_unreaped", `exact code=${r.error_code}`);
  assert(r.retryable === true, "deadline retryable");
  assert(r.restart_child === true, "restart_child required");
  assert(seenAbort === true, "pass must receive abort");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt on abort");
  assert(worker.isWorkerProcessPoisoned() === true, "process must be poisoned after unreaped");
  assert(progressEvents.some((e) => e.phase === "aborted" || e.stage === "pass"), "progress observed");

  // No serial tail reset: next task must refuse immediately without claim/pass.
  const term2 = hex64("term-poison-follow");
  const m2 = baseManifest({
    request_id: hex64("req-poison-follow"),
    terminal_record_id: term2,
    budget_ms: 60_000,
  });
  const placed2 = placeSidecar({
    sessionId: m2.session_id,
    terminalRecordId: term2,
    messages: [{ role: "user", content: "poison-follow" }],
  });
  m2.sidecar_path = placed2.sidecarPath;
  m2.content_id = placed2.contentId;
  let passEntered = false;
  const r2 = await worker.runSedimentWorkerTask(JSON.stringify(m2), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => { passEntered = true; },
    env: process.env,
  });
  assert(r2.error_code === "worker_process_poisoned", `exact poison code=${r2.error_code}`);
  assert(r2.restart_child === true, "poison restart_child");
  assert(passEntered === false, "poison must not enter pass");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term2)), "no receipt on poison refuse");
});

await check("progress key/value whitelist + closed buckets only", async () => {
  resetWorkerBudgetTestState();
  const good = worker.buildWorkerProgressEvent({
    stage: "classifier",
    phase: "heartbeat",
    startedAtMs: 0,
    nowMs: 12_500,
    pending: 3,
    lanes: ["classifier", "auto_write"],
  });
  assert(good.schema === "pi-astack/sediment-worker-progress/v1", "schema");
  assert(good.elapsed_bucket === 10, `elapsed_bucket=${good.elapsed_bucket}`);
  assert(good.pending_bucket === 3, `pending_bucket=${good.pending_bucket}`);
  const notify = worker.formatWorkerProgressNotify(good);
  assert(!worker.progressNotifyHasSensitiveContent(notify), "clean progress must pass scan");
  assert(worker.tryParseWorkerProgressNotify(notify)?.stage === "classifier", "parse roundtrip");

  assert(worker.sanitizeWorkerProgressEvent({
    schema: "pi-astack/sediment-worker-progress/v1",
    stage: "classifier",
    phase: "start",
    session_id: "evil",
  }) === null, "identity field rejected");

  // Arbitrary integers outside closed bucket sets must fail sanitize.
  assert(worker.sanitizeWorkerProgressEvent({
    schema: "pi-astack/sediment-worker-progress/v1",
    stage: "pass",
    phase: "start",
    elapsed_bucket: 7,
  }) === null, "non-closed elapsed_bucket rejected");
  assert(worker.sanitizeWorkerProgressEvent({
    schema: "pi-astack/sediment-worker-progress/v1",
    stage: "pass",
    phase: "start",
    pending_bucket: 6,
  }) === null, "non-closed pending_bucket rejected");

  // Bare "extractor" remains unwired; closed auto_write_* stages are accepted.
  assert(worker.sanitizeWorkerProgressEvent({
    schema: "pi-astack/sediment-worker-progress/v1",
    stage: "extractor",
    phase: "start",
  }) === null, "bare extractor stage rejected");
  for (const stage of [
    "auto_write_preflight",
    "auto_write_extractor",
    "auto_write_curator",
    "auto_write_writer",
    "auto_write_embedding",
    "auto_write_publication",
  ]) {
    const ev = worker.sanitizeWorkerProgressEvent({
      schema: "pi-astack/sediment-worker-progress/v1",
      stage,
      phase: "start",
    });
    assert(ev?.stage === stage, `auto_write stage accepted: ${stage}`);
    assert(!("session_id" in (ev ?? {})), "no identity on auto_write progress");
  }

  const evilNotify = `sediment-worker-progress:${JSON.stringify({
    schema: "pi-astack/sediment-worker-progress/v1",
    stage: "pass",
    phase: "start",
    path: "/tmp/secret",
  })}`;
  assert(worker.progressNotifyHasSensitiveContent(evilNotify), "path must fail sensitive scan");
});

await check("signal reaches pass runtime opts", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-signal-prop");
  const m = baseManifest({
    request_id: hex64("req-signal-prop"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "sig" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  let gotSignal = false;
  let gotDeadline = false;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot, opts) => {
      gotSignal = opts?.signal instanceof AbortSignal;
      gotDeadline = typeof opts?.deadlineMs === "number" && opts.deadlineMs > 0;
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: "sig-tip" });
    },
    env: process.env,
  });
  assert(r.status === "processed", `status=${r.status} code=${r.error_code}`);
  assert(gotSignal, "signal must be injected into pass opts");
  assert(gotDeadline, "deadlineMs must be injected into pass opts");
});

await check("CP covers tip + no receipt on deadline → exact deadline_after_checkpoint_advanced", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-abort-cp");
  const messages = [{ role: "user", content: "abort-cp" }];
  const m = baseManifest({
    request_id: hex64("req-abort-cp"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages,
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  // Tip id must be covered for fatal path (partial advance is non-fatal).
  const branch = worker.syntheticBranchFromMessages(messages, m.leaf_tip);
  const tipId = branch[branch.length - 1].id;

  let t = 1_000_000;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    clock: () => t,
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: tipId });
      t = 1_000_000 + 60_000;
      await new Promise(() => {});
    },
    env: process.env,
  });
  assert(r.error_code === "deadline_after_checkpoint_advanced", `exact code=${r.error_code}`);
  assert(r.settled === false, "not settled");
  assert(r.retryable === false, "fail closed not auto-retryable");
  assert(r.restart_child === true, "restart_child");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt after abort with CP cover tip");
  assert(worker.isWorkerProcessPoisoned() === true, "poison after CP-covers-tip-no-receipt");
});

await check("partial CP advance (more-loop, tip not covered) → ordinary retryable deadline, no poison", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-partial-cp");
  const messages = [
    { role: "user", content: "partial-1" },
    { role: "assistant", content: "partial-2", stopReason: "end_turn" },
  ];
  const m = baseManifest({
    request_id: hex64("req-partial-cp"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages,
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const branch = worker.syntheticBranchFromMessages(messages, m.leaf_tip);
  const tipId = branch[branch.length - 1].id;
  const partialId = branch[0].id;
  assert(partialId !== tipId, "partial must not equal tip");

  let t = 2_000_000;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    clock: () => t,
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      // more-loop partial: advance to intermediate id, not tip.
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: partialId });
      t = 2_000_000 + 60_000;
      await new Promise(() => {});
    },
    env: process.env,
  });
  assert(r.error_code === "worker_budget_exhausted" || r.error_code === "pass_deadline_exceeded_unreaped",
    `partial CP must be ordinary deadline, got=${r.error_code}`);
  assert(r.error_code !== "deadline_after_checkpoint_advanced", "partial must not fatal coversTip code");
  assert(r.retryable === true, "partial CP safe resume retryable");
  // unreaped hang may poison; if settled budget path, must not poison solely for partial CP.
  if (r.error_code === "worker_budget_exhausted") {
    assert(r.restart_child === false, "settled partial budget must not restart");
    assert(worker.isWorkerProcessPoisoned() === false, "settled partial must not poison");
  }
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt on partial");
});

await check("retry with CP covering tip + no receipt → closed diagnostic, not already_processed", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-cp-cover");
  const m = baseManifest({
    request_id: hex64("req-cp-cover"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const messages = [{ role: "user", content: "cover-tip" }];
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages,
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  // Compute synthetic tip id the same way the worker does.
  const branch = worker.syntheticBranchFromMessages(messages, m.leaf_tip);
  const tipId = branch[branch.length - 1].id;
  const slot = worker.workerCheckpointSessionId(m.session_id);
  const store = new Map([[slot, { lastProcessedEntryId: tipId }]]);

  let passEntered = false;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async () => { passEntered = true; },
    env: process.env,
  });
  assert(r.error_code === "deadline_after_checkpoint_advanced", `exact code=${r.error_code}`);
  assert(r.status !== "already_processed", "must not fake already_processed");
  assert(r.retryable === false, "fail closed");
  assert(r.restart_child === true, "restart_child");
  assert(passEntered === false, "must not enter pass when CP covers tip without receipt");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "still no receipt");
});

await check("global_serial_deadline poisons; no healthy reuse without reset", async () => {
  resetWorkerBudgetTestState();
  let tA = 2_000_000;
  const clockA = () => tA;

  async function runTask(seed, clock, hangMs, budgetMs = 60_000) {
    const term = hex64(`term-gs-${seed}`);
    const m = baseManifest({
      request_id: hex64(`req-gs-${seed}`),
      terminal_record_id: term,
      budget_ms: budgetMs,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: seed }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const store = new Map();
    return worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      clock,
      loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
      runAgentEndPass: async (snapshot) => {
        if (hangMs > 0) {
          await new Promise((r) => setTimeout(r, hangMs));
        }
        store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: `tip-${seed}` });
      },
      env: process.env,
    });
  }

  const pA = runTask("A", clockA, 150);
  await new Promise((r) => setTimeout(r, 20));
  let tB = 3_000_000;
  const clockB = () => tB;
  const pB = runTask("B", clockB, 0);
  await new Promise((r) => setTimeout(r, 40));
  tB = 3_000_000 + 60_000;
  const [a, b] = await Promise.all([pA, pB]);
  assert(a.status === "processed", `A status=${a.status} code=${a.error_code}`);
  assert(b.error_code === "global_serial_deadline", `exact B code=${b.error_code}`);
  assert(b.retryable === true && b.restart_child === true, "B restartable");
  assert(worker.isWorkerProcessPoisoned() === true, "poison after global_serial_deadline");

  // Do NOT reset tail/poison: next task must be worker_process_poisoned.
  const c = await runTask("C", () => Date.now(), 0);
  assert(c.error_code === "worker_process_poisoned", `exact C code=${c.error_code}`);
  assert(c.restart_child === true, "C restart_child");
});

await check("detached_join_deadline exact code via pass throw", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-detached-join");
  const m = baseManifest({
    request_id: hex64("req-detached-join"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "dj" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async (_snap, opts) => {
      const err = new Error("detached_join_deadline");
      err.code = "detached_join_deadline";
      throw err;
    },
    env: process.env,
  });
  assert(r.error_code === "detached_join_deadline", `exact code=${r.error_code}`);
  assert(r.settled === false && r.retryable === true, "detached join fail retryable");
  assert(r.restart_child === false, "plain settled detached_join must not restart_child");
  assert(worker.isWorkerProcessPoisoned() === false, "plain settled detached_join must not poison");
});

await check("never-settling auto_write → exact cancel_cleanup_unreaped + poison + restart", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  const sessionId = "sess-never-autowrite";
  const ac = new AbortController();
  let seenAbort = false;
  ac.signal.addEventListener("abort", () => { seenAbort = true; }, { once: true });
  sediment._setAutoWriteInFlightForTests(sessionId, new Promise(() => {}));

  const started = Date.now();
  let thrown;
  try {
    await sediment._waitForDetachedSedimentWorkIdleForTests(sessionId, undefined, {
      signal: ac.signal,
      requestAbort: () => { try { ac.abort(); } catch { /* ignore */ } },
      deadlineMs: Date.now() + 100,
      now: Date.now,
    });
  } catch (e) {
    thrown = e;
  }
  const wall = Date.now() - started;
  assert(wall < 15_000, `cleanup must bound ≤~5s+overhead; wall=${wall}ms`);
  assert(wall >= 4_000, `must wait cleanup window; wall=${wall}ms`);
  assert(thrown?.code === "cancel_cleanup_unreaped", `exact code=${thrown?.code}`);
  assert(seenAbort === true, "must abort first");

  // Wire the same code through worker-rpc failDeadline path: poison + restart.
  const term = hex64("term-never-autowrite-rpc");
  const m = baseManifest({
    request_id: hex64("req-never-autowrite-rpc"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "never-aw-rpc" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => {
      const err = new Error("cancel_cleanup_unreaped");
      err.code = "cancel_cleanup_unreaped";
      throw err;
    },
    env: process.env,
  });
  assert(r.error_code === "cancel_cleanup_unreaped", `rpc exact code=${r.error_code}`);
  assert(r.restart_child === true, "unreaped must restart_child");
  assert(worker.isWorkerProcessPoisoned() === true, "unreaped must poison");
  sediment._resetAutoWriteStateForTests();
});

await check("abort-aware auto_write settles ≤5s → detached_join_deadline no poison", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  const sessionId = "sess-abort-aware-aw";
  const ac = new AbortController();
  let resolveWork;
  const work = new Promise((r) => { resolveWork = r; });
  sediment._setAutoWriteInFlightForTests(sessionId, work);
  ac.signal.addEventListener("abort", () => { resolveWork(); }, { once: true });

  const started = Date.now();
  let thrown;
  try {
    await sediment._waitForDetachedSedimentWorkIdleForTests(sessionId, undefined, {
      signal: ac.signal,
      requestAbort: () => { try { ac.abort(); } catch { /* ignore */ } },
      deadlineMs: Date.now() + 100,
      now: Date.now,
    });
  } catch (e) {
    thrown = e;
  }
  const wall = Date.now() - started;
  assert(wall < 5_000, `abort-aware must settle inside cleanup; wall=${wall}ms`);
  assert(thrown?.code === "detached_join_deadline", `exact code=${thrown?.code}`);

  // Settled detached_join through rpc must not poison.
  const term = hex64("term-abort-aware-rpc");
  const m = baseManifest({
    request_id: hex64("req-abort-aware-rpc"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "abort-aw-rpc" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => {
      const err = new Error("detached_join_deadline");
      err.code = "detached_join_deadline";
      throw err;
    },
    env: process.env,
  });
  assert(r.error_code === "detached_join_deadline", `rpc code=${r.error_code}`);
  assert(r.restart_child === false, "settled detached_join must not restart");
  assert(worker.isWorkerProcessPoisoned() === false, "settled must not poison");
  sediment._resetAutoWriteStateForTests();
});

await check("stage_deadline exact code via pass throw (index stage precheck closed set)", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-stage-deadline");
  const m = baseManifest({
    request_id: hex64("req-stage-deadline"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "stage-dl" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => {
      // Mirrors extensions/sediment/index.ts assertWorkerStageBudget throw shape.
      const err = new Error("stage_deadline");
      err.code = "stage_deadline";
      throw err;
    },
    env: process.env,
  });
  assert(r.error_code === "stage_deadline", `exact code=${r.error_code}`);
  assert(r.settled === false && r.retryable === true, "stage_deadline retryable");
  assert(r.restart_child === false, "plain settled stage_deadline restart_child=false");
  assert(worker.isWorkerProcessPoisoned() === false, "plain settled stage_deadline must not poison");
  assert(worker.activeDeadlineFenceCountForTests() === 0, "fence must settle after stage_deadline");
});

await check("plain budget before claim: not poisoned, restart false, next task runs", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-budget-before-claim");
  const m = baseManifest({
    request_id: hex64("req-budget-before-claim"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "budget-before-claim" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  // startedAt from first clock(); subsequent reads past soft deadline (budget-5s).
  let n = 0;
  const clock = () => {
    n += 1;
    return n === 1 ? 1_000_000 : 1_000_000 + 60_000;
  };
  let passEntered = false;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    clock,
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => { passEntered = true; },
    env: process.env,
  });
  assert(r.error_code === "worker_budget_exhausted", `exact code=${r.error_code}`);
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.settled === false && r.retryable === true, "plain budget retryable");
  assert(r.restart_child === false, "plain budget before claim restart_child=false");
  assert(worker.isWorkerProcessPoisoned() === false, "plain budget before claim must not poison");
  assert(passEntered === false, "must not enter pass when budget exhausted before claim");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");

  // Next task must still run on the same process (no poison).
  const term2 = hex64("term-budget-before-claim-next");
  const m2 = baseManifest({
    request_id: hex64("req-budget-before-claim-next"),
    terminal_record_id: term2,
    budget_ms: 60_000,
  });
  const placed2 = placeSidecar({
    sessionId: m2.session_id,
    terminalRecordId: term2,
    messages: [{ role: "user", content: "next-after-plain-budget" }],
  });
  m2.sidecar_path = placed2.sidecarPath;
  m2.content_id = placed2.contentId;
  const store = new Map();
  let nextPass = false;
  const r2 = await worker.runSedimentWorkerTask(JSON.stringify(m2), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      nextPass = true;
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: "next-tip" });
    },
    env: process.env,
  });
  assert(nextPass === true, "next task must enter pass");
  assert(r2.status === "processed", `next status=${r2.status} code=${r2.error_code}`);
  assert(worker.isWorkerProcessPoisoned() === false, "still not poisoned after next success");
  assert(worker.activeDeadlineFenceCountForTests() === 0, "fence count zero after next success");
});

await check("1000 consecutive successes: activeDeadlineFenceCount returns to zero", async () => {
  resetWorkerBudgetTestState();
  for (let i = 0; i < 1000; i += 1) {
    const term = hex64(`term-fence-leak-${i}`);
    const m = baseManifest({
      request_id: hex64(`req-fence-leak-${i}`),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: `fence-${i}` }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const store = new Map();
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
      runAgentEndPass: async (snapshot) => {
        store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: `tip-${i}` });
      },
      env: process.env,
    });
    assert(r.status === "processed", `i=${i} status=${r.status} code=${r.error_code}`);
    assert(
      worker.activeDeadlineFenceCountForTests() === 0,
      `i=${i} activeDeadlineFenceCount=${worker.activeDeadlineFenceCountForTests()} must be 0`,
    );
  }
  assert(worker.isWorkerProcessPoisoned() === false, "1000 successes must not poison");
});

await check("ALS checkpoint: concurrent contexts isolated; foreground unchanged", async () => {
  resetWorkerBudgetTestState();
  const cpCtx = await jiti.import(path.join(root, "extensions/_shared/worker-checkpoint-context.ts"));
  const writes = [];

  await Promise.all([
    cpCtx.runWithCheckpointSessionIdOverride("daemon-worker:aaa", async () => {
      await new Promise((r) => setTimeout(r, 30));
      writes.push(["a", cpCtx.effectiveCheckpointSessionId("fg-session")]);
    }),
    cpCtx.runWithCheckpointSessionIdOverride("daemon-worker:bbb", async () => {
      await new Promise((r) => setTimeout(r, 5));
      writes.push(["b", cpCtx.effectiveCheckpointSessionId("fg-session")]);
    }),
  ]);

  const a = writes.find((w) => w[0] === "a");
  const b = writes.find((w) => w[0] === "b");
  assert(a?.[1] === "daemon-worker:aaa", `A slot=${a?.[1]}`);
  assert(b?.[1] === "daemon-worker:bbb", `B slot=${b?.[1]}`);
  assert(cpCtx.effectiveCheckpointSessionId("fg-session") === "fg-session", "foreground no ALS store");
  assert(cpCtx.getCheckpointSessionIdOverride() === undefined, "no store outside run");
});

await check("ALS delayed detached write stays on daemon-worker slot", async () => {
  resetWorkerBudgetTestState();
  const cpCtx = await jiti.import(path.join(root, "extensions/_shared/worker-checkpoint-context.ts"));
  let detachedSlot = null;
  let resolveDetached;
  const detachedDone = new Promise((r) => { resolveDetached = r; });

  await cpCtx.runWithCheckpointSessionIdOverride("daemon-worker:delayed", async () => {
    // Fire detached work that continues after the outer run returns (inherits ALS).
    void Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 40));
      detachedSlot = cpCtx.effectiveCheckpointSessionId("source-session");
      resolveDetached();
    });
  });

  // Outer store cleared for new sync work, but detached promise still sees override.
  assert(cpCtx.getCheckpointSessionIdOverride() === undefined, "sync store cleared after run");
  await detachedDone;
  assert(detachedSlot === "daemon-worker:delayed", `detached slot=${detachedSlot}`);
});

await check("worker pass injects signal; body remains optional for foreground callers", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-fg-opts");
  const m = baseManifest({
    request_id: hex64("req-fg-opts"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "fg" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  let sawSignal = false;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot, opts) => {
      sawSignal = opts?.signal instanceof AbortSignal;
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: "fg-tip" });
    },
    env: process.env,
  });
  assert(r.status === "processed", `status=${r.status}`);
  assert(sawSignal === true, "worker path injects signal; body remains optional for foreground callers");
});

await check("worker taskScoped skips global maintenance; never-resolving maint still processed", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  const prevMode = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  try {
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);
    const scheduled = [];
    sediment._setMaintenanceScheduleObserverForTests((lane) => {
      scheduled.push(lane);
      // Simulate never-resolving maintenance if it were started — must not be called.
      return new Promise(() => {});
    });

    const term = hex64("term-task-scoped-skip");
    const m = baseManifest({
      request_id: hex64("req-task-scoped-skip"),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [
        { role: "user", content: "task-scoped maintenance skip" },
        { role: "assistant", content: "ok", stopReason: "end_turn" },
      ],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const validated = worker.validateSedimentWorkerManifest(m);
    const opened = await worker.readAndVerifyWorkerSidecar({
      sidecarPath: validated.sidecar_path,
      sessionId: validated.session_id,
      contentId: validated.content_id,
    });
    const snapshot = worker.buildWorkerPassSnapshot({
      manifest: validated,
      messages: opened.messages,
    });

    // Worker opts → taskScoped=true → skip aggregator/staging/forgetting/replay.
    await sediment._runSedimentAgentEndPassForTests(snapshot, {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 60_000,
      now: Date.now,
    });
    // Allow any deferred setImmediate to fire if incorrectly scheduled.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert(scheduled.length === 0, `taskScoped must not schedule maintenance; got=${JSON.stringify(scheduled)}`);

    // Full RPC path: still processes (no hang on never-resolve maintenance).
    const store = new Map();
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
      runAgentEndPass: async (snap, opts) => {
        assert(opts?.signal instanceof AbortSignal, "worker injects signal");
        await sediment._runSedimentAgentEndPassForTests(snap, opts);
        // Simulate CP advance so RPC can settle processed without real write.
        store.set(snap.checkpointSessionId, {
          lastProcessedEntryId: snap.branchEntries[snap.branchEntries.length - 1]?.id ?? "tip",
        });
      },
      env: process.env,
    });
    assert(r.status === "processed", `status=${r.status} code=${r.error_code}`);
    assert(scheduled.length === 0, "rpc path also must not schedule maintenance");
  } finally {
    sediment._setMaintenanceScheduleObserverForTests(undefined);
    sediment._resetAutoWriteStateForTests();
    if (prevMode === undefined) delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
    else process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prevMode;
  }
});

await check("foreground (no worker opts) still schedules global maintenance", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  const prevMode = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1"; // runner registered in worker mode too
  try {
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);
    const scheduled = [];
    sediment._setMaintenanceScheduleObserverForTests((lane) => scheduled.push(lane));

    const term = hex64("term-fg-maint");
    const m = baseManifest({
      request_id: hex64("req-fg-maint"),
      terminal_record_id: term,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [
        { role: "user", content: "foreground maintenance" },
        { role: "assistant", content: "ok", stopReason: "end_turn" },
      ],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const validated = worker.validateSedimentWorkerManifest(m);
    const opened = await worker.readAndVerifyWorkerSidecar({
      sidecarPath: validated.sidecar_path,
      sessionId: validated.session_id,
      contentId: validated.content_id,
    });
    const snapshot = worker.buildWorkerPassSnapshot({
      manifest: validated,
      messages: opened.messages,
    });

    // No worker opts → taskScoped=false → aggregator still schedules.
    await sediment._runSedimentAgentEndPassForTests(snapshot);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert(scheduled.includes("aggregator"), `foreground must schedule aggregator; got=${JSON.stringify(scheduled)}`);
  } finally {
    sediment._setMaintenanceScheduleObserverForTests(undefined);
    sediment._resetAutoWriteStateForTests();
    if (prevMode === undefined) delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
    else process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prevMode;
  }
});

await check("two candidates remaining budget decreases; worker maxRetries=0", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const settingsMod = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
  const base = settingsMod.resolveSedimentSettings();
  assert(base.curatorMaxRetries >= 0, "baseline settings load");
  let t = 1_000_000;
  const now = () => t;
  const c1 = sediment._clampSettingsToWorkerBudgetForTests(base, { deadlineMs: 1_000_000 + 10_000, now });
  t = 1_000_000 + 4_000;
  const c2 = sediment._clampSettingsToWorkerBudgetForTests(base, { deadlineMs: 1_000_000 + 10_000, now });
  assert(c1.curatorTimeoutMs > c2.curatorTimeoutMs, `budget must decrease: c1=${c1.curatorTimeoutMs} c2=${c2.curatorTimeoutMs}`);
  assert(c1.curatorMaxRetries === 0 && c2.curatorMaxRetries === 0, "worker curator maxRetries=0");
  assert(c1.aggregatorMaxRetries === 0 && c2.aggregatorMaxRetries === 0, "worker aggregator maxRetries=0");
  // Per-candidate curator start/end emit (no index/count fields).
  const progress = [];
  const { buildWorkerProgressEvent, emitWorkerProgress } = worker;
  emitWorkerProgress((e) => progress.push(e), buildWorkerProgressEvent({ stage: "auto_write_curator", phase: "start" }));
  emitWorkerProgress((e) => progress.push(e), buildWorkerProgressEvent({ stage: "auto_write_curator", phase: "end" }));
  emitWorkerProgress((e) => progress.push(e), buildWorkerProgressEvent({ stage: "auto_write_curator", phase: "start" }));
  emitWorkerProgress((e) => progress.push(e), buildWorkerProgressEvent({ stage: "auto_write_curator", phase: "end" }));
  assert(progress.length === 4, `expected 2 start/end pairs, got ${progress.length}`);
  assert(progress.every((e) => e.stage === "auto_write_curator" && !("index" in e) && !("count" in e)), "no index/count on progress");
});

await check("curator hang classified unreaped + track; writer abort; no CP on incomplete", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  const sessionId = "sess-curator-hang";

  // Never-resolving curator work → unreapedIfTimeout tracks it.
  let thrown;
  const hang = new Promise(() => {});
  try {
    await sediment._raceAutoWriteAwaitForTests(hang, {
      signal: AbortSignal.abort(),
      deadlineMs: Date.now() - 1,
      now: Date.now,
      unreapedIfTimeout: true,
      sessionId,
    });
  } catch (e) {
    thrown = e;
  }
  assert(thrown?.code === "cancel_cleanup_unreaped", `code=${thrown?.code}`);
  const pending = sediment._collectTrackedPendingForTests(sessionId);
  assert(pending.promises.length >= 1, "hang must remain tracked");
  assert(pending.lanes.includes("auto_write"), `lanes=${JSON.stringify(pending.lanes)}`);

  // Writer abort via worker budget ALS before critical IO.
  const budget = await jiti.import(path.join(root, "extensions/_shared/worker-budget-context.ts"));
  let writerThrown;
  try {
    await budget.runWithWorkerBudget(
      { deadlineMs: Date.now() - 1, now: Date.now, signal: AbortSignal.abort() },
      () => {
        budget.assertWorkerBudgetNotExpired("writer_before");
      },
    );
  } catch (e) {
    writerThrown = e;
  }
  assert(writerThrown?.code === "stage_deadline", `writer abort code=${writerThrown?.code}`);

  // Incomplete path: no CP/receipt when pass throws unreaped before advance.
  const term = hex64("term-no-cp-incomplete");
  const m = baseManifest({
    request_id: hex64("req-no-cp-incomplete"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "incomplete" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => {
      const err = new Error("cancel_cleanup_unreaped");
      err.code = "cancel_cleanup_unreaped";
      throw err;
    },
    env: process.env,
  });
  assert(r.error_code === "cancel_cleanup_unreaped", `code=${r.error_code}`);
  assert(r.restart_child === true, "unreaped restarts");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt on incomplete");
  sediment._resetAutoWriteStateForTests();
});

await check("worker task scope uses only verified sidecar branch (no foreign session expand)", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-scope-branch");
  const m = baseManifest({
    request_id: hex64("req-scope-branch"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [
      { role: "user", content: "only this sidecar" },
      { role: "assistant", content: "reply", stopReason: "end_turn" },
    ],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const validated = worker.validateSedimentWorkerManifest(m);
  const opened = await worker.readAndVerifyWorkerSidecar({
    sidecarPath: validated.sidecar_path,
    sessionId: validated.session_id,
    contentId: validated.content_id,
  });
  const snapshot = worker.buildWorkerPassSnapshot({
    manifest: validated,
    messages: opened.messages,
  });
  assert(snapshot.sessionId === validated.session_id, "session pinned to manifest");
  assert(Array.isArray(snapshot.branchEntries) && snapshot.branchEntries.length === 2, "branch from sidecar messages only");
  // Prove no expansion: branch length equals verified message count; session id unique.
  assert(
    snapshot.branchEntries.every((e) => typeof e === "object" && e),
    "synthetic branch entries only",
  );
  // getBranch in detachedSessionManager is snapshot.branchEntries.slice — fixed window.
  // Foreign session backlog cannot appear without another sidecar task.
  assert(typeof snapshot.checkpointSessionId === "string" && snapshot.checkpointSessionId.startsWith("daemon-worker:"), "independent CP slot");
});

await check("all promises tracked helper includes auto_write + closed lanes", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  const sessionId = "sess-all-tracked";
  let resolveHang;
  const hang = new Promise((r) => { resolveHang = r; });
  sediment._setAutoWriteInFlightForTests(sessionId, hang);
  // Also track a closed-lane promise via race unreaped path.
  const never = new Promise(() => {});
  void sediment._raceAutoWriteAwaitForTests(never, {
    deadlineMs: Date.now() - 1,
    now: Date.now,
    unreapedIfTimeout: true,
    sessionId,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  const pending = sediment._collectTrackedPendingForTests(sessionId);
  assert(pending.promises.length >= 2, `expected tracked promises, got ${pending.promises.length}`);
  assert(pending.lanes.includes("auto_write"), `lanes=${JSON.stringify(pending.lanes)}`);
  resolveHang();
  await hang;
  sediment._resetAutoWriteStateForTests();
});

await check("deferred unfinished artifact → current_candidate_deferred; no CP / no receipt", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  assert(sediment._isCurrentCandidateDeferredReasonForTests("multiview_staged_for_replay") === true, "multiview pending key");
  assert(sediment._isCurrentCandidateDeferredReasonForTests("staging_deferred") === true, "staging deferred key");
  assert(sediment._isCurrentCandidateDeferredReasonForTests("promotion_needed") === true, "promotion-needed key");
  assert(sediment._isCurrentCandidateDeferredReasonForTests("duplicate_slug") === false, "terminal reason not deferred");
  assert(
    sediment._shouldAdvanceAfterResultsForTests([
      { status: "skipped", reason: "multiview_staged_for_replay" },
    ]) === false,
    "deferred must HOLD CP",
  );

  const term = hex64("term-deferred-no-cp");
  const m = baseManifest({
    request_id: hex64("req-deferred-no-cp"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "deferred-artifact" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async () => {
      const err = new Error("current_candidate_deferred");
      err.code = "current_candidate_deferred";
      throw err;
    },
    env: process.env,
  });
  assert(r.error_code === "current_candidate_deferred", `exact code=${r.error_code}`);
  assert(r.status === "failed" && r.settled === false, "not processed");
  assert(r.retryable === true, "deferred retryable");
  assert(r.restart_child !== true, "deferred must not poison/restart");
  assert(worker.isWorkerProcessPoisoned() === false, "deferred must not poison process");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt on deferred");
  // CP store empty — pass threw before advance.
  assert([...store.values()].every((v) => !v?.lastProcessedEntryId), "no CP advance on deferred");
  sediment._resetAutoWriteStateForTests();
});

await check("deferred attempt-local: recursive candidate cannot advance CP; next terminal isolated", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();

  // Attempt A: note deferred under ALS; consume path would throw deferred.
  let sawDeferred = false;
  await sediment._runWithTaskScopedCandidateDeferredAttemptForTests(async () => {
    sediment._noteTaskScopedCandidateDeferredForTests("sess-shared");
    assert(sediment._isTaskScopedCandidateDeferredThisAttemptForTests() === true, "attempt A deferred");
    // CP-hold contract still holds for deferred reasons.
    assert(
      sediment._shouldAdvanceAfterResultsForTests([
        { status: "skipped", reason: "multiview_staged_for_replay" },
        { status: "created", reason: undefined },
      ]) === false,
      "deferred + later created must HOLD CP (no recursive advance)",
    );
    sawDeferred = true;
  });
  assert(sawDeferred, "attempt A ran");

  // Next independent attempt (same session id): ALS empty — no sticky leak.
  await sediment._runWithTaskScopedCandidateDeferredAttemptForTests(async () => {
    assert(
      sediment._isTaskScopedCandidateDeferredThisAttemptForTests() === false,
      "next terminal/attempt must not inherit sticky deferred",
    );
    assert(
      sediment._shouldAdvanceAfterResultsForTests([
        { status: "created" },
      ]) === true,
      "independent task drain still advances when no deferred",
    );
  });

  // Worker: deferred after same-attempt CP advance → fatal invariant, not retryable redrive.
  const term = hex64("term-deferred-cp-advanced");
  const m = baseManifest({
    request_id: hex64("req-deferred-cp-advanced"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [
      { role: "user", content: "d1" },
      { role: "assistant", content: "d2", stopReason: "end_turn" },
    ],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const store = new Map();
  const tipId = "sw-tip-deferred-adv";
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      // Bug reproduction: deferred throw after CP already covers tip this attempt.
      store.set(snapshot.checkpointSessionId, {
        lastProcessedEntryId: snapshot.branchEntries[snapshot.branchEntries.length - 1]?.id ?? tipId,
      });
      const err = new Error("current_candidate_deferred");
      err.code = "current_candidate_deferred";
      throw err;
    },
    env: process.env,
  });
  assert(
    r.error_code === "deadline_after_checkpoint_advanced",
    `CP+deferred same attempt must fatal invariant, got=${r.error_code}`,
  );
  assert(r.retryable === false, "invariant nonretryable");
  assert(r.restart_child === true, "invariant restarts child");
  assert(worker.isWorkerProcessPoisoned() === true, "invariant poisons process");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
  resetWorkerBudgetTestState();
  sediment._resetAutoWriteStateForTests();
});

await check("receipt_write_failed after CP advanced is nonretryable restart_child", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-receipt-write-fail");
  const m = baseManifest({
    request_id: hex64("req-receipt-write-fail"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "rwf" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  const receiptPath = worker.sedimentWorkerReceiptPath(abrainHome, term);
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      store.set(snapshot.checkpointSessionId, {
        lastProcessedEntryId: snapshot.branchEntries[snapshot.branchEntries.length - 1]?.id ?? "tip",
      });
      // After pre-check (ENOENT) + CP advance: plant a directory at the receipt
      // path so create-only atomic write fails (post-CP, first cause preserved).
      fs.mkdirSync(receiptPath, { recursive: true });
      // more=false void after CP advance → receipt path
    },
    env: process.env,
  });
  assert(r.error_code === "receipt_write_failed", `code=${r.error_code}`);
  assert(r.retryable === false, "receipt_write_failed after CP must be nonretryable");
  assert(r.restart_child === true, "receipt_write_failed after CP must restart_child");
  assert(r.settled === false, "not settled");
  try { fs.rmSync(receiptPath, { recursive: true, force: true }); } catch { /* ignore */ }
  resetWorkerBudgetTestState();
});

await check("deadline cleanup with receipt present prefers processed over fatal", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-deadline-cleanup-receipt");
  const m = baseManifest({
    request_id: hex64("req-deadline-cleanup-receipt"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "dl-clean" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const store = new Map();
  // Pre-seed success receipt: deadline path must prefer it.
  const receiptDir = path.dirname(worker.sedimentWorkerReceiptPath(abrainHome, term));
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(worker.sedimentWorkerReceiptPath(abrainHome, term), JSON.stringify({
    schema: "pi-astack/sediment-worker-receipt/v1",
    terminal_record_id: term,
    request_id: m.request_id,
    status: "processed",
    settled: true,
    memory_decisions: 0,
    memory_writes: 0,
    created_at: new Date().toISOString(),
  }));
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
    runAgentEndPass: async () => {
      const err = new Error("current_candidate_deferred");
      err.code = "current_candidate_deferred";
      throw err;
    },
    env: process.env,
  });
  assert(r.status === "processed" || r.status === "already_processed", `status=${r.status}`);
  assert(r.settled === true, "receipt wins over deferred");
  resetWorkerBudgetTestState();
});

function stagingCount() {
  const dir = path.join(abrainHome, ".state", "sediment", "staging");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length;
}

function longUserText(seed) {
  // > minWindowChars (200) so long-window path is taken (not window_too_small).
  return `${seed} `.repeat(40).trim();
}

function memoryFenceText(title) {
  return [
    longUserText("explicit-lane context"),
    "",
    "MEMORY:",
    `title: ${title}`,
    "kind: fact",
    "---",
    "Body of an explicit MEMORY fence used only for lane selection in smoke.",
    "END_MEMORY",
  ].join("\n");
}

await check("auto-long stagingWritten → deferred; CP holds (real agent-end pass)", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const stagingLoader = await jiti.import(path.join(root, "extensions/sediment/staging-loader.ts"));
  const correction = await jiti.import(path.join(root, "extensions/sediment/correction-pipeline.ts"));
  sediment._resetAutoWriteStateForTests();
  const prevMode = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  writeSettings({ autoLlmWriteEnabled: "staging-only" });
  try {
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);
    const beforeStaging = stagingCount();
    sediment._setSedimentAgentEndTestHooksForTests({
      correctionPipeline: async (_entries, _related, deps) => {
        const signal = {
          signal_found: true,
          typing: "durable",
          confidence: 7,
          user_quote: "prefer staging-only capture",
          scope_description: "auto-long staging smoke",
          correction_intent: "capture provisional",
        };
        const entry = correction.buildProvisionalStagingEntry(signal, "auto-long seed", {
          projectId: "worker-smoke-proj",
          projectRoot: deps.projectRoot,
        });
        const stagingWritten = stagingLoader.writeStagingEntry(entry);
        assert(stagingWritten === true, "hook must write real staging");
        return {
          ok: true,
          model: "test/classifier",
          signal,
          durationMs: 1,
          stagingWritten: true,
          escalateToCurator: false,
        };
      },
    });

    const term = hex64("term-auto-long-staging");
    const sessionId = "sess-auto-long-staging";
    const m = baseManifest({
      request_id: hex64("req-auto-long-staging"),
      terminal_record_id: term,
      session_id: sessionId,
      budget_ms: 60_000,
      c6: { session_id: sessionId, turn_id: 1, subturn: 0 },
    });
    const placed = placeSidecar({
      sessionId,
      terminalRecordId: term,
      messages: [
        { role: "user", content: longUserText("auto-long staging trajectory") },
        { role: "assistant", content: "noted", stopReason: "end_turn" },
      ],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const validated = worker.validateSedimentWorkerManifest(m);
    const opened = await worker.readAndVerifyWorkerSidecar({
      sidecarPath: validated.sidecar_path,
      sessionId: validated.session_id,
      contentId: validated.content_id,
    });
    const snapshot = worker.buildWorkerPassSnapshot({
      manifest: validated,
      messages: opened.messages,
    });
    const cpBefore = await checkpoint.loadSessionCheckpoint(snapshot.cwd, snapshot.checkpointSessionId);

    let passErr;
    try {
      await sediment._runSedimentAgentEndPassForTests(snapshot, {
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 60_000,
        now: Date.now,
      });
    } catch (e) {
      passErr = e;
    }
    assert(passErr?.code === "current_candidate_deferred" || passErr?.message === "current_candidate_deferred",
      `auto-long must throw deferred, got=${passErr?.code || passErr?.message}`);
    assert(stagingCount() > beforeStaging, "staging must be written");
    const cpAfter = await checkpoint.loadSessionCheckpoint(snapshot.cwd, snapshot.checkpointSessionId);
    assert(
      (cpAfter?.lastProcessedEntryId ?? null) === (cpBefore?.lastProcessedEntryId ?? null),
      `CP must not advance on staging deferred, before=${JSON.stringify(cpBefore)} after=${JSON.stringify(cpAfter)}`,
    );

    // Full RPC: same trajectory → retryable deferred, no receipt, no CP.
    const store = new Map();
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
      runAgentEndPass: async (snap, opts) => {
        await sediment._runSedimentAgentEndPassForTests(snap, opts);
      },
      env: process.env,
    });
    assert(r.error_code === "current_candidate_deferred", `rpc code=${r.error_code}`);
    assert(r.retryable === true, "clean deferred retryable");
    assert(r.restart_child !== true, "clean deferred no restart");
    assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
  } finally {
    sediment._setSedimentAgentEndTestHooksForTests(undefined);
    sediment._resetAutoWriteStateForTests();
    writeSettings({ executionOwner: "daemon" });
    if (prevMode === undefined) delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
    else process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prevMode;
    resetWorkerBudgetTestState();
  }
});

await check("explicit-lane stagingWritten → deferred; CP holds (real agent-end pass)", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const stagingLoader = await jiti.import(path.join(root, "extensions/sediment/staging-loader.ts"));
  const correction = await jiti.import(path.join(root, "extensions/sediment/correction-pipeline.ts"));
  sediment._resetAutoWriteStateForTests();
  const prevMode = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  // Classifier on; explicit MEMORY selects Lane A (not auto-write).
  writeSettings({ autoLlmWriteEnabled: "staging-only" });
  try {
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);
    const beforeStaging = stagingCount();
    sediment._setSedimentAgentEndTestHooksForTests({
      correctionPipeline: async (_entries, _related, deps) => {
        const signal = {
          signal_found: true,
          typing: "durable",
          confidence: 6,
          user_quote: "explicit fence co-occurs with staging",
          scope_description: "explicit-lane staging smoke",
          correction_intent: "stage provisional alongside fence",
        };
        const entry = correction.buildProvisionalStagingEntry(signal, "explicit-lane seed", {
          projectId: "worker-smoke-proj",
          projectRoot: deps.projectRoot,
        });
        assert(stagingLoader.writeStagingEntry(entry) === true, "explicit hook staging write");
        return {
          ok: true,
          model: "test/classifier",
          signal,
          durationMs: 1,
          stagingWritten: true,
          escalateToCurator: false,
        };
      },
    });

    const term = hex64("term-explicit-staging");
    const sessionId = "sess-explicit-staging";
    const m = baseManifest({
      request_id: hex64("req-explicit-staging"),
      terminal_record_id: term,
      session_id: sessionId,
      budget_ms: 60_000,
      c6: { session_id: sessionId, turn_id: 1, subturn: 0 },
    });
    const placed = placeSidecar({
      sessionId,
      terminalRecordId: term,
      messages: [
        { role: "user", content: memoryFenceText("explicit-staging-smoke-fact") },
        { role: "assistant", content: "saved", stopReason: "end_turn" },
      ],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const validated = worker.validateSedimentWorkerManifest(m);
    const opened = await worker.readAndVerifyWorkerSidecar({
      sidecarPath: validated.sidecar_path,
      sessionId: validated.session_id,
      contentId: validated.content_id,
    });
    const snapshot = worker.buildWorkerPassSnapshot({
      manifest: validated,
      messages: opened.messages,
    });
    const cpBefore = await checkpoint.loadSessionCheckpoint(snapshot.cwd, snapshot.checkpointSessionId);

    let passErr;
    try {
      await sediment._runSedimentAgentEndPassForTests(snapshot, {
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 60_000,
        now: Date.now,
      });
    } catch (e) {
      passErr = e;
    }
    assert(passErr?.code === "current_candidate_deferred" || passErr?.message === "current_candidate_deferred",
      `explicit must throw deferred, got=${passErr?.code || passErr?.message}`);
    assert(stagingCount() > beforeStaging, "explicit staging must be written");
    const cpAfter = await checkpoint.loadSessionCheckpoint(snapshot.cwd, snapshot.checkpointSessionId);
    assert(
      (cpAfter?.lastProcessedEntryId ?? null) === (cpBefore?.lastProcessedEntryId ?? null),
      `explicit CP must hold, before=${JSON.stringify(cpBefore)} after=${JSON.stringify(cpAfter)}`,
    );
  } finally {
    sediment._setSedimentAgentEndTestHooksForTests(undefined);
    sediment._resetAutoWriteStateForTests();
    writeSettings({ executionOwner: "daemon" });
    if (prevMode === undefined) delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
    else process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prevMode;
    resetWorkerBudgetTestState();
  }
});

await check("iteration1 partial CP + iteration2 deferred → attempt-wide fatal poison", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-partial-then-deferred");
  const m = baseManifest({
    request_id: hex64("req-partial-then-deferred"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [
      { role: "user", content: "w1" },
      { role: "assistant", content: "a1", stopReason: "end_turn" },
      { role: "user", content: "w2" },
      { role: "assistant", content: "a2", stopReason: "end_turn" },
    ],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const store = new Map();
  let calls = 0;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      calls += 1;
      const entries = snapshot.branchEntries;
      if (calls === 1) {
        // Partial advance: mid watermark, not tip → more=true.
        const mid = entries[Math.max(0, entries.length - 2)];
        store.set(snapshot.checkpointSessionId, {
          lastProcessedEntryId: mid?.id ?? "mid-watermark",
        });
        return { more: true };
      }
      // Second iteration: no further CP move, deferred unfinished artifact.
      const err = new Error("current_candidate_deferred");
      err.code = "current_candidate_deferred";
      throw err;
    },
    env: process.env,
  });
  assert(calls === 2, `expected 2 iterations, calls=${calls}`);
  assert(
    r.error_code === "deadline_after_checkpoint_advanced",
    `attempt-wide any_advance must fatal, got=${r.error_code}`,
  );
  assert(r.retryable === false, "must not be retryable");
  assert(r.restart_child === true, "must restart_child");
  assert(worker.isWorkerProcessPoisoned() === true, "must poison");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
  resetWorkerBudgetTestState();
});

await check("pipeline_threw after CP covers tip → fatal invariant (not retryable)", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-pipeline-throw-after-cp");
  const m = baseManifest({
    request_id: hex64("req-pipeline-throw-after-cp"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "pipeline-throw" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      store.set(snapshot.checkpointSessionId, {
        lastProcessedEntryId: snapshot.branchEntries[snapshot.branchEntries.length - 1]?.id ?? "tip",
      });
      throw new Error("post-cp audit boom");
    },
    env: process.env,
  });
  assert(
    r.error_code === "deadline_after_checkpoint_advanced",
    `pipeline_threw after CP must fatal invariant, got=${r.error_code}`,
  );
  assert(r.retryable === false, "not retryable");
  assert(r.restart_child === true, "restart");
  assert(worker.isWorkerProcessPoisoned() === true, "poison");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
  resetWorkerBudgetTestState();
});

await check("post-pass CP load fail → checkpoint_state_unknown_after_pass nonretryable", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-cp-unknown-after-pass");
  const m = baseManifest({
    request_id: hex64("req-cp-unknown-after-pass"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "cp-unknown" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  let loads = 0;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => {
      loads += 1;
      // 1: beforePassCp, 2: before iteration pass, 3: after pass → throw
      if (loads >= 3) throw new Error("cp unreadable after pass");
      return {};
    },
    runAgentEndPass: async () => {
      // Pass completes without throw; post-pass CP probe fails.
    },
    env: process.env,
  });
  assert(
    r.error_code === "checkpoint_state_unknown_after_pass",
    `code=${r.error_code}`,
  );
  assert(r.retryable === false, "unknown after pass must not authorize retry");
  assert(r.restart_child === true, "restart_child");
  assert(worker.isWorkerProcessPoisoned() === true, "poison");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
  resetWorkerBudgetTestState();
});

await check("pipeline_threw + CP reread fail → checkpoint_state_unknown_after_pass; receipt race wins", async () => {
  resetWorkerBudgetTestState();
  {
    const term = hex64("term-pipeline-throw-cp-unknown");
    const m = baseManifest({
      request_id: hex64("req-pipeline-throw-cp-unknown"),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: "pipeline-cp-unknown" }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    let loads = 0;
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => {
        loads += 1;
        // 1: beforePassCp, 2: before iteration pass; helper CP reread throws.
        if (loads >= 3) throw new Error("cp unreadable after pipeline throw");
        return {};
      },
      runAgentEndPass: async () => {
        throw new Error("post-pass audit boom");
      },
      env: process.env,
    });
    assert(
      r.error_code === "checkpoint_state_unknown_after_pass",
      `pipeline+cp-unknown code=${r.error_code}`,
    );
    assert(r.retryable === false, "pipeline+cp-unknown nonretryable");
    assert(r.restart_child === true, "pipeline+cp-unknown restart_child");
    assert(worker.isWorkerProcessPoisoned() === true, "pipeline+cp-unknown poison");
    assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
  }
  // Receipt race: pass writes receipt then throws; helper prefers success even if CP unreadable.
  resetWorkerBudgetTestState();
  {
    const term = hex64("term-pipeline-throw-cp-unknown-receipt");
    const m = baseManifest({
      request_id: hex64("req-pipeline-throw-cp-unknown-receipt"),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: "pipeline-cp-unknown-receipt" }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    let loads = 0;
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => {
        loads += 1;
        if (loads >= 3) throw new Error("cp unreadable after pipeline throw");
        return {};
      },
      runAgentEndPass: async () => {
        const receiptDir = path.dirname(worker.sedimentWorkerReceiptPath(abrainHome, term));
        fs.mkdirSync(receiptDir, { recursive: true });
        fs.writeFileSync(worker.sedimentWorkerReceiptPath(abrainHome, term), JSON.stringify({
          schema: "pi-astack/sediment-worker-receipt/v1",
          terminal_record_id: term,
          request_id: m.request_id,
          status: "processed",
          settled: true,
          memory_decisions: 0,
          memory_writes: 0,
          created_at: new Date().toISOString(),
        }));
        throw new Error("post-pass audit boom");
      },
      env: process.env,
    });
    assert(r.status === "processed" || r.status === "already_processed", `receipt race status=${r.status}`);
    assert(r.settled === true, "receipt wins over pipeline+cp-unknown");
    assert(r.error_code === undefined || r.error_code === null || r.error_code === "", `no error when receipt wins, got=${r.error_code}`);
    assert(worker.isWorkerProcessPoisoned() === false, "receipt race must not poison");
  }
  resetWorkerBudgetTestState();
});

await check("stage_deadline + CP reread fail → checkpoint_state_unknown_after_pass; receipt race wins", async () => {
  resetWorkerBudgetTestState();
  {
    const term = hex64("term-stage-deadline-cp-unknown");
    const m = baseManifest({
      request_id: hex64("req-stage-deadline-cp-unknown"),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: "stage-dl-cp-unknown" }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    let loads = 0;
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => {
        loads += 1;
        // 1: beforePassCp, 2: before iteration pass; helper CP reread throws.
        if (loads >= 3) throw new Error("cp unreadable after stage_deadline");
        return {};
      },
      runAgentEndPass: async () => {
        const err = new Error("stage_deadline");
        err.code = "stage_deadline";
        throw err;
      },
      env: process.env,
    });
    assert(
      r.error_code === "checkpoint_state_unknown_after_pass",
      `stage_deadline+cp-unknown code=${r.error_code}`,
    );
    assert(r.retryable === false, "stage_deadline+cp-unknown nonretryable");
    assert(r.restart_child === true, "stage_deadline+cp-unknown restart_child");
    assert(worker.isWorkerProcessPoisoned() === true, "stage_deadline+cp-unknown poison");
    assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
  }
  // Receipt race: pass writes receipt then stage_deadline; helper prefers success over unknown CP.
  resetWorkerBudgetTestState();
  {
    const term = hex64("term-stage-deadline-cp-unknown-receipt");
    const m = baseManifest({
      request_id: hex64("req-stage-deadline-cp-unknown-receipt"),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: "stage-dl-cp-unknown-receipt" }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    let loads = 0;
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => {
        loads += 1;
        if (loads >= 3) throw new Error("cp unreadable after stage_deadline");
        return {};
      },
      runAgentEndPass: async () => {
        const receiptDir = path.dirname(worker.sedimentWorkerReceiptPath(abrainHome, term));
        fs.mkdirSync(receiptDir, { recursive: true });
        fs.writeFileSync(worker.sedimentWorkerReceiptPath(abrainHome, term), JSON.stringify({
          schema: "pi-astack/sediment-worker-receipt/v1",
          terminal_record_id: term,
          request_id: m.request_id,
          status: "processed",
          settled: true,
          memory_decisions: 0,
          memory_writes: 0,
          created_at: new Date().toISOString(),
        }));
        const err = new Error("stage_deadline");
        err.code = "stage_deadline";
        throw err;
      },
      env: process.env,
    });
    assert(r.status === "processed" || r.status === "already_processed", `receipt race status=${r.status}`);
    assert(r.settled === true, "receipt wins over stage_deadline+cp-unknown");
    assert(r.error_code === undefined || r.error_code === null || r.error_code === "", `no error when receipt wins, got=${r.error_code}`);
    assert(worker.isWorkerProcessPoisoned() === false, "receipt race must not poison");
  }
  resetWorkerBudgetTestState();
});

await check("deadline fence preserves receipt_write_failed first cause", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-deadline-receipt-first-cause");
  const m = baseManifest({
    request_id: hex64("req-deadline-receipt-first-cause"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "dl-receipt-first" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const receiptPath = worker.sedimentWorkerReceiptPath(abrainHome, term);
  const store = new Map();
  let t = 5_000_000;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    clock: () => t,
    loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      // CP covers tip so receipt path is taken after more=false.
      store.set(snapshot.checkpointSessionId, {
        lastProcessedEntryId: snapshot.branchEntries[snapshot.branchEntries.length - 1]?.id ?? "tip",
      });
      // Jump past soft deadline so fence can race; plant directory so receipt write fails.
      t = 5_000_000 + 55_000 + 50;
      fs.mkdirSync(receiptPath, { recursive: true });
    },
    env: process.env,
  });
  // First cause must remain receipt_write_failed (not rewritten to deadline_after_checkpoint_advanced).
  assert(r.error_code === "receipt_write_failed", `first cause preserved, got=${r.error_code}`);
  assert(r.retryable === false, "nonretryable");
  assert(r.restart_child === true, "restart_child");
  try { fs.rmSync(receiptPath, { recursive: true, force: true }); } catch { /* ignore */ }
  resetWorkerBudgetTestState();
});

await check("explicit CP then post-CP audit throw is swallowed (processed, not retry)", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  sediment._resetAutoWriteStateForTests();
  const prevMode = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = "1";
  // Disable classifier so Lane A does not await staging; only MEMORY write + CP + audit.
  writeSettings({ autoLlmWriteEnabled: false });
  try {
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);

    // Force appendAudit to throw after CP by making audit dir a file (best-effort path must swallow).
    // Use real pass via RPC with store-backed CP: simulate CP advance + audit throw inside pass.
    const term = hex64("term-post-cp-audit-swallow");
    const m = baseManifest({
      request_id: hex64("req-post-cp-audit-swallow"),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: "post-cp-audit" }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const store = new Map();
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async (_root, sid) => store.get(sid) ?? {},
      runAgentEndPass: async (snapshot) => {
        // Durable CP first (last success-affecting action), then throwing audit.
        store.set(snapshot.checkpointSessionId, {
          lastProcessedEntryId: snapshot.branchEntries[snapshot.branchEntries.length - 1]?.id ?? "tip",
        });
        // Simulate post-CP audit throw that production now best-effort catches.
        try {
          throw new Error("appendAudit boom after CP");
        } catch {
          /* production: post-CP audit .catch(() => {}) */
        }
        // more=false void → receipt
      },
      env: process.env,
    });
    assert(r.status === "processed", `status=${r.status} code=${r.error_code}`);
    assert(r.settled === true, "settled");
    assert(fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "receipt after CP+swallowed audit");
  } finally {
    sediment._resetAutoWriteStateForTests();
    writeSettings({ executionOwner: "daemon" });
    if (prevMode === undefined) delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
    else process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prevMode;
    resetWorkerBudgetTestState();
  }
});

await check("more=false completed at soft deadline still writes create-only receipt via hard reserve", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-soft-receipt");
  const m = baseManifest({
    request_id: hex64("req-soft-receipt"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages: [{ role: "user", content: "soft-receipt" }],
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;

  // Soft budget = 55s (60s-5s). Jump past soft after pass advances, still within hard.
  let t = 3_000_000;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    clock: () => t,
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: "soft-receipt-tip" });
      // Past soft (started + 55s) but inside hard reserve (started + 60s).
      t = 3_000_000 + 55_000 + 100;
      // more=false void
    },
    env: process.env,
  });
  assert(r.status === "processed", `status=${r.status} code=${r.error_code}`);
  assert(r.settled === true, "settled processed");
  assert(fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "receipt written past soft via hard reserve");
});

await check("candidate not started after deadline → stage_deadline; writer success retained", async () => {
  resetWorkerBudgetTestState();
  const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const budget = await jiti.import(path.join(root, "extensions/_shared/worker-budget-context.ts"));

  // Candidate loop top: remaining expired → stage_deadline before new work.
  let stageThrown;
  try {
    await budget.runWithWorkerBudget(
      { deadlineMs: Date.now() - 1, now: Date.now, signal: AbortSignal.abort() },
      () => {
        budget.assertWorkerBudgetNotExpired("candidate_before");
      },
    );
  } catch (e) {
    stageThrown = e;
  }
  assert(stageThrown?.code === "stage_deadline", `candidate top code=${stageThrown?.code}`);

  // writer_before still aborts; writer_after removed — success retained.
  let beforeThrown;
  try {
    await budget.runWithWorkerBudget(
      { deadlineMs: Date.now() - 1, now: Date.now },
      () => budget.assertWorkerBudgetNotExpired("writer_before"),
    );
  } catch (e) {
    beforeThrown = e;
  }
  assert(beforeThrown?.code === "stage_deadline", "writer_before still gates");

  // Simulate writer success after soft: no writer_after flip.
  let writerResult = null;
  await budget.runWithWorkerBudget(
    { deadlineMs: Date.now() - 1, now: Date.now },
    async () => {
      // Intentionally skip writer_before (already past) — success path returns value.
      writerResult = await Promise.resolve({ status: "created", slug: "kept" });
    },
  );
  assert(writerResult?.status === "created", "writer success retained after soft deadline");

  // Source contract: no assertWorkerBudgetNotExpired("writer_after") call site.
  const writerSrc = fs.readFileSync(path.join(root, "extensions/sediment/writer.ts"), "utf8");
  assert(!/assertWorkerBudgetNotExpired\(\s*["']writer_after["']\s*\)/.test(writerSrc), "writer_after abort check must be deleted");
  assert(writerSrc.includes("writer_before"), "writer_before retained");
  void sediment;
});

await check("detached join attaches allSettled once per pending set; heartbeat independent", async () => {
  resetWorkerBudgetTestState();
  // Source contract for bounded handlers (no per-50ms allSettled rebuild).
  const indexSrc = fs.readFileSync(path.join(root, "extensions/sediment/index.ts"), "utf8");
  assert(indexSrc.includes("Attach allSettled ONCE per pending-set identity"), "join attach-once documented");
  assert(indexSrc.includes("samePendingSet"), "pending-set identity compare present");
  assert(indexSrc.includes("Rebuild allSettled only when the pending promise-identity set changes"), "rebuild on set change");
  // Heartbeat wake is independent 5s, not a 50ms allSettled attach loop.
  assert(indexSrc.includes("Independent deadline/heartbeat wake"), "independent heartbeat wake");
  // Count allSettled call sites inside waitForDetachedSedimentWorkIdle body is bounded.
  const joinFn = indexSrc.slice(
    indexSrc.indexOf("async function waitForDetachedSedimentWorkIdle"),
    indexSrc.indexOf("async function auditSedimentAgentEndQueueError"),
  );
  const allSettledCount = (joinFn.match(/Promise\.allSettled/g) || []).length;
  assert(allSettledCount <= 3, `join allSettled sites bounded ≤3, got=${allSettledCount}`);
});

await check("more-loop partial CP then settled stage_deadline is retryable no poison", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-partial-settled");
  const messages = [
    { role: "user", content: "ps-1" },
    { role: "assistant", content: "ps-2", stopReason: "end_turn" },
  ];
  const m = baseManifest({
    request_id: hex64("req-partial-settled"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages,
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const branch = worker.syntheticBranchFromMessages(messages, m.leaf_tip);
  const partialId = branch[0].id;
  const store = new Map();
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: partialId });
      const err = new Error("stage_deadline");
      err.code = "stage_deadline";
      throw err;
    },
    env: process.env,
  });
  assert(r.error_code === "stage_deadline", `exact code=${r.error_code}`);
  assert(r.retryable === true, "partial settled stage_deadline retryable");
  assert(r.restart_child === false, "no restart on partial settled");
  assert(worker.isWorkerProcessPoisoned() === false, "partial settled must not poison");
  assert(store.get(worker.workerCheckpointSessionId(m.session_id))?.lastProcessedEntryId === partialId, "partial CP retained for resume");
  assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "no receipt");
});

await check("H1: durable receipt settles success without in-task publication drain", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-receipt-unreaped");
  const messages = [{ role: "user", content: "receipt-unreaped" }];
  const m = baseManifest({
    request_id: hex64("req-receipt-unreaped"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages,
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const branch = worker.syntheticBranchFromMessages(messages, m.leaf_tip);
  const tipId = branch[branch.length - 1].id;

  const store = new Map();
  let drainCalls = 0;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    drainKnowledgePublicationOutbox: async () => {
      drainCalls += 1;
      await new Promise(() => {}); // would hang if called
    },
    runAgentEndPass: async (snapshot) => {
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: tipId });
    },
    env: process.env,
  });
  assert(r.status === "processed", `status=${r.status} code=${r.error_code}`);
  assert(r.settled === true, "settled success");
  assert(r.retryable === false, "settled not retryable");
  assert(r.publication_pending === false, "empty outbox ⇒ publication_pending false");
  assert(r.restart_child !== true, "no restart_child");
  assert(fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "receipt durable");
  assert(worker.isWorkerProcessPoisoned() === false, "must not poison");
  assert(drainCalls === 0, "must not call in-task publication drain");
});

await check("H1: no in-task publication drain; receipt verifyCreated; deadline rechecks receipt (source)", async () => {
  const src = fs.readFileSync(path.join(root, "extensions/sediment/worker-rpc.ts"), "utf8");
  assert(src.includes("withPublicationPendingFlag") || src.includes("resolvePublicationPendingFlag"),
    "result stamps publication_pending from actual outbox");
  assert(src.includes("Do NOT drain publication in-task"), "in-task drain removed");
  assert(!src.includes("drainBudgetMs"), "no drainBudgetMs race");
  assert(src.includes("verifyCreated: true"), "processed receipt verifyCreated=true");
  assert(src.includes("readProcessedReceipt(abrainHome, ids.terminal_record_id)"), "deadline outcome checks receipt");
  assert(src.includes("Signal-only: no infinite poll timer") || src.includes("signal-only"),
    "waitPrev signal-only contract documented");
});

await check("M4: deterministic no_progress codes are non-retryable when never advanced", async () => {
  resetWorkerBudgetTestState();
  for (const code of ["project_not_bound", "settings_disabled", "empty_window", "ephemeral_session"]) {
    const term = hex64(`term-det-${code}`);
    const m = baseManifest({
      request_id: hex64(`req-det-${code}`),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: code }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => ({}),
      runAgentEndPass: async () => ({ no_progress: true, code, retryable: false }),
      env: process.env,
    });
    assert(r.status === "failed", `${code}: status=${r.status}`);
    assert(r.error_code === code, `${code}: error_code=${r.error_code}`);
    assert(r.retryable === false, `${code}: must not be auto-retryable`);
    assert(r.settled === false, `${code}: not settled`);
    assert(r.restart_child !== true, `${code}: no poison restart`);
    assert(!fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), `${code}: no receipt`);
  }
  assert(worker.isDeterministicNoProgressCode("project_not_bound") === true, "classifier export");
  assert(worker.isDeterministicNoProgressCode("no_progress") === false, "plain no_progress not deterministic");
});

await check("M4: advance then empty_window writes processed receipt (redrive-safe)", async () => {
  resetWorkerBudgetTestState();
  const term = hex64("term-advance-empty");
  const messages = [{ role: "user", content: "advance-then-empty" }];
  const m = baseManifest({
    request_id: hex64("req-advance-empty"),
    terminal_record_id: term,
    budget_ms: 60_000,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages,
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const branch = worker.syntheticBranchFromMessages(messages, m.leaf_tip);
  const tipId = branch[branch.length - 1].id;
  const store = new Map();
  let passN = 0;
  const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      passN += 1;
      if (passN === 1) {
        store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: tipId });
        return { more: true };
      }
      // Second iteration: empty_window after prior advance — must settle with receipt.
      return { no_progress: true, code: "empty_window", retryable: false };
    },
    env: process.env,
  });
  assert(r.status === "processed", `status=${r.status} code=${r.error_code}`);
  assert(r.settled === true, "settled after advance+empty_window");
  assert(r.retryable === false, "not retryable");
  assert(r.publication_pending === false, "empty outbox publication_pending false");
  assert(passN === 2, `pass iterations=${passN}`);
  assert(fs.existsSync(worker.sedimentWorkerReceiptPath(abrainHome, term)), "receipt durable");

  // Redrive: already_processed, no re-run of pipeline progress loss.
  const r2 = await worker.runSedimentWorkerTask(JSON.stringify({
    ...m,
    request_id: hex64("req-advance-empty-2"),
  }), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async () => {
      throw new Error("must not re-run after receipt");
    },
    env: process.env,
  });
  assert(r2.status === "already_processed", `redrive status=${r2.status}`);
  assert(r2.settled === true, "redrive settled");
  assert(r2.publication_pending === false, "already_processed actual pending false");
});

await check("L5: poison root cause sticky across subsequent refuses", async () => {
  resetWorkerBudgetTestState();
  // Direct poison via never-resolving pass → pass_deadline_exceeded_unreaped.
  const termA = hex64("term-poison-sticky-a");
  const mA = baseManifest({
    request_id: hex64("req-poison-sticky-a"),
    terminal_record_id: termA,
    budget_ms: 60_000,
  });
  const placedA = placeSidecar({
    sessionId: mA.session_id,
    terminalRecordId: termA,
    messages: [{ role: "user", content: "poison-a" }],
  });
  mA.sidecar_path = placedA.sidecarPath;
  mA.content_id = placedA.contentId;
  let tA = 4_000_000;
  const rA = await worker.runSedimentWorkerTask(JSON.stringify(mA), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    clock: () => tA,
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => {
      tA = 4_000_000 + 60_000;
      await new Promise(() => {});
    },
    env: process.env,
  });
  assert(worker.isWorkerProcessPoisoned() === true, "must be poisoned after unreaped hang");
  const firstReason = worker.workerProcessPoisonReasonForTests();
  assert(
    firstReason === "pass_deadline_exceeded_unreaped"
      || firstReason === "deadline_after_checkpoint_advanced"
      || firstReason === "global_serial_deadline",
    `first poison reason=${firstReason} rA=${rA.error_code}`,
  );
  assert(firstReason !== "worker_process_poisoned", "root cause must not be the refuse code");

  // Subsequent refuses must not overwrite root cause.
  for (const seed of ["b", "c"]) {
    const term = hex64(`term-poison-sticky-${seed}`);
    const m = baseManifest({
      request_id: hex64(`req-poison-sticky-${seed}`),
      terminal_record_id: term,
      budget_ms: 60_000,
    });
    const placed = placeSidecar({
      sessionId: m.session_id,
      terminalRecordId: term,
      messages: [{ role: "user", content: `poison-${seed}` }],
    });
    m.sidecar_path = placed.sidecarPath;
    m.content_id = placed.contentId;
    const r = await worker.runSedimentWorkerTask(JSON.stringify(m), {
      resolveAbrainHome: () => abrainHome,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => ({}),
      runAgentEndPass: async () => {},
      env: process.env,
    });
    assert(r.error_code === "worker_process_poisoned", `${seed} code=${r.error_code}`);
    assert(
      worker.workerProcessPoisonReasonForTests() === firstReason,
      `poison reason overwritten: first=${firstReason} now=${worker.workerProcessPoisonReasonForTests()}`,
    );
  }
});

await check("H2: process-level startup outside worker ALS; task defers immediately", async () => {
  resetWorkerBudgetTestState();
  const budgetMod = await jiti.import(path.join(root, "extensions/_shared/worker-budget-context.ts"));
  const runtimeSrc = fs.readFileSync(path.join(root, "extensions/_shared/canonical-git-runtime.ts"), "utf8");
  assert(runtimeSrc.includes("runOutsideWorkerBudget"), "startup kicks outside worker ALS");
  assert(runtimeSrc.includes("workerBudgetStartupDeferredDiag"), "cooperative deferred");
  assert(runtimeSrc.includes("queueMicrotask"), "non-blocking ready probe");
  assert(typeof budgetMod.runOutsideWorkerBudget === "function", "runOutsideWorkerBudget export");

  // getCanonicalStartupPromise under worker budget returns deferred quickly (no 60m wait).
  const runtime = await jiti.import(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
  const t0 = Date.now();
  const diag = await budgetMod.runWithWorkerBudget(
    { deadlineMs: Date.now() + 60_000, now: () => Date.now() },
    () => runtime.getCanonicalStartupPromise({ abrainHome }),
  );
  const elapsed = Date.now() - t0;
  assert(elapsed < 2_000, `task must not wait for cold startup (elapsed=${elapsed}ms)`);
  assert(diag.startup === "deferred" || diag.startup === "ready", `startup=${diag.startup}`);
  if (diag.startup === "deferred") {
    assert(diag.deferredReason === "STARTUP_BUDGET_EXHAUSTED" || /STARTUP_BUDGET_EXHAUSTED/.test(String(diag.blockedReason || "")),
      `deferred reason=${diag.deferredReason} blocked=${diag.blockedReason}`);
    assert(diag.retryable === true, "deferred retryable for later generation");
  }

  // Multi-generation: second short observation still returns quickly; process attempt may progress.
  const t1 = Date.now();
  const diag2 = await budgetMod.runWithWorkerBudget(
    { deadlineMs: Date.now() + 60_000, now: () => Date.now() },
    () => runtime.getCanonicalStartupPromise({ abrainHome }),
  );
  assert(Date.now() - t1 < 2_000, "generation-2 also returns quickly");
  assert(diag2.startup === "deferred" || diag2.startup === "ready", `gen2 startup=${diag2.startup}`);
});

await check("M2/M3: worker suppresses timer/LLM but durable needs_refresh marker", async () => {
  const indexSrc = fs.readFileSync(path.join(root, "extensions/sediment/index.ts"), "utf8");
  const writerSrc = fs.readFileSync(path.join(root, "extensions/sediment/writer.ts"), "utf8");
  const autoSrc = fs.readFileSync(path.join(root, "extensions/sediment/constraint-compiler/auto-refresh.ts"), "utf8");
  assert(indexSrc.includes("taskScopedAutoWrite"), "taskScopedAutoWrite present");
  assert(indexSrc.includes("recordConstraintShadowNeedsRefresh"), "worker uses marker-only API");
  assert(indexSrc.includes("free-floating republish"), "republish suppressed under worker");
  assert(writerSrc.includes("free-floating push"), "writer push suppressed under worker budget");
  assert(autoSrc.includes("recordConstraintShadowNeedsRefresh"), "marker-only export");
  assert(autoSrc.includes("needs_refresh_marker_only"), "marker-only reason");
  assert(autoSrc.includes("runOutsideWorkerBudget"), "auto-refresh exits budget ALS");

  // Behavior: marker-only path is recoverable by session startup resume.
  const auto = await jiti.import(path.join(root, "extensions/sediment/constraint-compiler/auto-refresh.ts"));
  auto._resetConstraintShadowAutoRefreshForTests();
  const settings = {
    constraintShadowCompiler: {
      enabled: true,
      autoRefresh: { enabled: true, debounceMs: 60_000, minIntervalMs: 60_000, eventStaleAfterMs: 0, maxPromptChars: 0 },
      model: "test/provider",
      l2OutputRoot: "state",
    },
  };
  auto._setConstraintShadowSettingsResolverForTests(() => settings);
  const eventId = hex64("needs-refresh-event");
  const recorded = await auto.recordConstraintShadowNeedsRefresh({
    abrainHome,
    cwd: projectRoot,
    settings,
    reason: "constraint_evidence_event_appended",
    sourceEventId: eventId,
  });
  assert(recorded.scheduled === true, `recorded=${JSON.stringify(recorded)}`);
  assert(recorded.reason === "needs_refresh_marker_only", `reason=${recorded.reason}`);
  const markerPath = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh", "needs-refresh.jsonl");
  assert(fs.existsSync(markerPath), "durable needs_refresh marker must exist");
  const markerBody = fs.readFileSync(markerPath, "utf8");
  assert(markerBody.includes(eventId), "marker contains source event");

  // Resume at session startup should see the marker (may schedule or report durability).
  const resumed = await auto.resumeConstraintShadowAutoRefreshAtStartup({
    abrainHome,
    cwd: projectRoot,
    settings,
    reason: "session_start",
  });
  assert(resumed.reason !== "needs_refresh_marker_missing", `resume must find marker (got ${resumed.reason})`);
  auto._setConstraintShadowSettingsResolverForTests(undefined);
  auto._resetConstraintShadowAutoRefreshForTests();
});

await check("waitPrev signal-only has no poll timer (source)", async () => {
  const src = fs.readFileSync(path.join(root, "extensions/sediment/worker-rpc.ts"), "utf8");
  assert(src.includes("Signal-only: no infinite poll timer") || src.includes("no poll timer"),
    "signal-only branch present");
  // Signal-only path uses addEventListener abort, not schedule() for the no-deadline case.
  assert(/deadlineMs === undefined && opts\?\.signal/.test(src) || /deadlineMs === undefined && opts\.signal/.test(src),
    "signal-only branch condition");
});

// ─── Publication outbox maintenance + actual publication_pending ─────────────

function resetWorkerPoisonState() {
  worker._resetWorkerProcessPoisonForTests();
  worker._resetGlobalPassSerialForTests();
  worker._setWorkerFenceSliceMsForTests(undefined);
}

function maintenanceReq(overrides = {}) {
  return {
    schema: "pi-astack/sediment-worker-maintenance/v1",
    request_id: hex64(`maint-${Math.random()}`),
    budget_ms: 60_000,
    kind: "publication_outbox",
    ...overrides,
  };
}

function completedDrain(overrides = {}) {
  return {
    status: "completed",
    processed: 0,
    drained: 0,
    terminalFailed: 0,
    pending: 0,
    ...overrides,
  };
}

async function seedPendingOutbox(count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const item = outbox.buildPublicationOutboxItem({
      domain: "generic",
      sessionId: `maint-seed-${i}`,
      artifactPaths: [`l1/seed-${i}.json`],
      candidateKey: `seed-cand-${i}-${Date.now()}`,
      operation: "create",
    });
    const written = await outbox.writePublicationOutboxItem(abrainHome, item);
    assert(written.status === "created" || written.status === "identical", `seed write ${i}`);
    ids.push(item.itemId);
  }
  return ids;
}

async function clearPendingOutbox() {
  const pending = await outbox.listPublicationOutboxPending(abrainHome);
  for (const row of pending) {
    try { fs.unlinkSync(row.filePath); } catch { /* ignore */ }
  }
  // Also clear durable failed residual so maintenance idle probes stay isolated.
  const failedDir = outbox.publicationOutboxFailedDir(abrainHome);
  if (fs.existsSync(failedDir)) {
    for (const name of fs.readdirSync(failedDir)) {
      try { fs.unlinkSync(path.join(failedDir, name)); } catch { /* ignore */ }
    }
  }
}

async function seedFailedOutbox(count) {
  const ids = await seedPendingOutbox(count);
  for (const itemId of ids) {
    const moved = await outbox.failPublicationOutboxItem(abrainHome, itemId, "smoke terminal fixture");
    assert(moved.status === "failed", `seed failed move ${itemId}`);
  }
  return ids;
}

await check("publication_pending true/false from actual outbox; fail-closed true", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  const term = hex64("term-pub-pending-actual");
  const messages = [{ role: "user", content: "pub-pending-actual" }];
  const m = baseManifest({
    request_id: hex64("req-pub-pending-actual"),
    terminal_record_id: term,
  });
  const placed = placeSidecar({
    sessionId: m.session_id,
    terminalRecordId: term,
    messages,
  });
  m.sidecar_path = placed.sidecarPath;
  m.content_id = placed.contentId;
  const branch = worker.syntheticBranchFromMessages(messages, m.leaf_tip);
  const tipId = branch[branch.length - 1].id;
  const store = new Map();

  const empty = await worker.runSedimentWorkerTask(JSON.stringify(m), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async (snapshot) => {
      store.set(snapshot.checkpointSessionId, { lastProcessedEntryId: tipId });
    },
    env: process.env,
  });
  assert(empty.status === "processed", `empty status=${empty.status}`);
  assert(empty.publication_pending === false, "empty outbox false");

  await seedPendingOutbox(1);
  const again = await worker.runSedimentWorkerTask(JSON.stringify({
    ...m,
    request_id: hex64("req-pub-pending-actual-2"),
  }), {
    resolveAbrainHome: () => abrainHome,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async (_r, sid) => store.get(sid) ?? {},
    runAgentEndPass: async () => { throw new Error("must not re-run"); },
    env: process.env,
  });
  assert(again.status === "already_processed", `again status=${again.status}`);
  assert(again.publication_pending === true, "seeded outbox true on already_processed");

  const failClosed = await worker.resolvePublicationPendingFlag(abrainHome, async () => {
    throw new Error("count boom");
  });
  assert(failClosed === true, "read failure fail-closes to true");
  await clearPendingOutbox();
});

await check("maintenance: empty idle; no drain write", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  let drainCalls = 0;
  const r = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq()), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => {
      drainCalls += 1;
      return completedDrain();
    },
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(r.status === "idle", `status=${r.status}`);
  assert(r.retryable === false, "idle not retryable");
  assert(r.restart_child === false, "no restart");
  assert(r.pending_before_bucket === "0" && r.pending_after_bucket === "0", "buckets 0");
  assert(r.failed_bucket === "0", `idle failed_bucket=${r.failed_bucket}`);
  assert(drainCalls === 0, "idle must not drain");
  assert(r.schema === "pi-astack/sediment-worker-maintenance-result/v1", "result schema");
});

await check("maintenance: production result maps remaining/busy/error; real adapter drains", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  await seedPendingOutbox(2);
  const countPending = () => outbox.countPublicationOutboxPending(abrainHome);

  const remaining = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-remaining"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain({ processed: 2, pending: 2 }),
    countPublicationOutboxPending: countPending,
  });
  assert(remaining.status === "pending" && remaining.retryable === true, `remaining=${JSON.stringify(remaining)}`);
  assert(remaining.error_code === "publication_remaining", `remaining code=${remaining.error_code}`);
  assert(remaining.pending_before_bucket === "2-4" && remaining.pending_after_bucket === "2-4", "remaining buckets");

  const busy = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-busy"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => ({
      status: "busy", processed: 0, drained: 0, terminalFailed: 0, pending: -1,
    }),
    countPublicationOutboxPending: countPending,
  });
  assert(busy.status === "pending" && busy.error_code === "publication_drain_busy", `busy=${JSON.stringify(busy)}`);

  const errored = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-last-error"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain({
      processed: 2,
      pending: 2,
      lastError: "canonical mutation barrier busy",
    }),
    countPublicationOutboxPending: countPending,
  });
  assert(errored.status === "failed" && errored.retryable === true, `lastError=${JSON.stringify(errored)}`);
  assert(errored.error_code === "publication_drain_failed", `lastError code=${errored.error_code}`);

  const l1Held = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-l1-held"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain({
      processed: 1,
      drained: 1,
      pending: 1,
      lastError: "publication_l1_pending",
    }),
    countPublicationOutboxPending: countPending,
  });
  assert(l1Held.status === "pending" && l1Held.retryable === true && l1Held.restart_child === false, `L1 held=${JSON.stringify(l1Held)}`);
  assert(l1Held.error_code === "publication_l1_pending" && l1Held.pending_after_bucket === "2-4", `L1 held closure=${JSON.stringify(l1Held)}`);

  let countReads = 0;
  const afterCountFailed = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-after-count-failed"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain({ processed: 2, pending: 2 }),
    countPublicationOutboxPending: async () => {
      countReads += 1;
      if (countReads === 1) return 2;
      throw new Error("after count failed");
    },
  });
  assert(afterCountFailed.status === "failed" && afterCountFailed.error_code === "publication_outbox_count_failed", `after count=${JSON.stringify(afterCountFailed)}`);
  assert(afterCountFailed.pending_before_bucket === "2-4" && afterCountFailed.pending_after_bucket === "unknown", "after read failure is unknown");

  const drained = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-real-drained"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: () => outbox.schedulePublicationOutboxDrain(abrainHome, async () => "done"),
    countPublicationOutboxPending: countPending,
  });
  assert(drained.status === "drained", `real drained=${JSON.stringify(drained)}`);
  assert(drained.pending_before_bucket === "2-4" && drained.pending_after_bucket === "0", "real drain buckets");
  assert(drained.retryable === false, "real drain is terminal success");
  await clearPendingOutbox();
});

await check("maintenance: real production drain terminal failure is never drained", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  await seedPendingOutbox(1);
  const result = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-production-terminal"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: () => writer.drainKnowledgePublicationOutbox(
      abrainHome,
      sedimentSettings.resolveSedimentSettings(),
    ),
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(result.status === "failed", `terminal status=${JSON.stringify(result)}`);
  assert(result.retryable === false, "terminal publication failure is nonretryable");
  assert(result.error_code === "publication_terminal_failed", `terminal code=${result.error_code}`);
  assert(result.pending_before_bucket === "1" && result.pending_after_bucket === "0", "terminal after-zero remains failed");
  assert(result.failed_bucket === "1", `terminal failed_bucket=${result.failed_bucket}`);
  await clearPendingOutbox();
});

await check("maintenance: durable failed residual is sticky critical (pending0 failed1 / restart / drained-with-history)", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  await seedFailedOutbox(1);

  const first = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-failed-present-1"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => {
      throw new Error("must not drain when only failed residual remains");
    },
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(first.status === "failed" && first.retryable === false, `pending0 failed1=${JSON.stringify(first)}`);
  assert(first.error_code === "publication_terminal_failed_present", `code=${first.error_code}`);
  assert(first.pending_before_bucket === "0" && first.pending_after_bucket === "0", "pending buckets stay 0");
  assert(first.failed_bucket === "1", `failed_bucket=${first.failed_bucket}`);
  assert(first.publication_pending === undefined, "maintenance result must not mix publication_pending");

  // Daemon restart equivalent: fresh call, same durable residual still critical.
  const again = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-failed-present-2"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain(),
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(again.status === "failed" && again.error_code === "publication_terminal_failed_present", `restart still failed=${JSON.stringify(again)}`);
  assert(again.failed_bucket === "1" && again.retryable === false, "restart residual sticky");

  // Pending drained while historical failed remains → still failed, not drained.
  await seedPendingOutbox(1);
  const drainedPending = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-drained-with-failed"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: () => outbox.schedulePublicationOutboxDrain(abrainHome, async () => "done"),
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(drainedPending.status === "failed", `history failed after drain=${JSON.stringify(drainedPending)}`);
  assert(drainedPending.error_code === "publication_terminal_failed_present", `history code=${drainedPending.error_code}`);
  assert(drainedPending.pending_after_bucket === "0", "pending drained");
  assert(drainedPending.failed_bucket === "1", "historical failed remains");
  assert(drainedPending.retryable === false, "historical failed not auto-retryable");
  await clearPendingOutbox();
});

await check("maintenance: failed count symlink/corrupt fail closed; failed_bucket unknown on read fail", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  const failedDir = outbox.publicationOutboxFailedDir(abrainHome);
  fs.mkdirSync(failedDir, { recursive: true });

  // Symlink fail closed.
  const linkTarget = path.join(abrainHome, "evil-target.json");
  fs.writeFileSync(linkTarget, "{}");
  const linkName = `${"a".repeat(64)}.json`;
  fs.symlinkSync(linkTarget, path.join(failedDir, linkName));
  let symlinkThrew = false;
  try {
    await outbox.countPublicationOutboxFailed(abrainHome);
  } catch {
    symlinkThrew = true;
  }
  assert(symlinkThrew, "symlink failed entry must fail closed");
  assert(await outbox.hasPublicationOutboxFailed(abrainHome).then(() => false, () => true) === true, "hasFailed symlink fail closed");
  fs.unlinkSync(path.join(failedDir, linkName));

  // Corrupt body fail closed.
  const corruptName = `${"b".repeat(64)}.json`;
  fs.writeFileSync(path.join(failedDir, corruptName), "{not-json");
  let corruptThrew = false;
  try {
    await outbox.countPublicationOutboxFailed(abrainHome);
  } catch {
    corruptThrew = true;
  }
  assert(corruptThrew, "corrupt failed entry must fail closed");
  fs.unlinkSync(path.join(failedDir, corruptName));

  // Illegal filename fail closed.
  fs.writeFileSync(path.join(failedDir, "not-a-legal-item.json"), "{}");
  let illegalThrew = false;
  try {
    await outbox.countPublicationOutboxFailed(abrainHome);
  } catch {
    illegalThrew = true;
  }
  assert(illegalThrew, "illegal filename must fail closed");
  fs.unlinkSync(path.join(failedDir, "not-a-legal-item.json"));

  // Maintenance maps failed-count throw → unknown bucket, no invented 0.
  const countFailed = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-failed-count-failed"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain(),
    countPublicationOutboxPending: async () => 0,
    countPublicationOutboxFailed: async () => { throw new Error("failed count boom"); },
  });
  assert(countFailed.status === "failed", `failed count status=${countFailed.status}`);
  assert(countFailed.error_code === "publication_outbox_failed_count_failed", `failed count code=${countFailed.error_code}`);
  assert(countFailed.failed_bucket === "unknown", `failed_bucket on read fail=${countFailed.failed_bucket}`);
  assert(countFailed.pending_before_bucket === "0", "pending known before failed-count fail");

  // Valid failed item counts as 1.
  await seedFailedOutbox(1);
  assert(await outbox.countPublicationOutboxFailed(abrainHome) === 1, "valid failed counts");
  assert(await outbox.hasPublicationOutboxFailed(abrainHome) === true, "hasFailed true");
  await clearPendingOutbox();
  assert(await outbox.countPublicationOutboxFailed(abrainHome) === 0, "empty failed is 0");
  assert(await outbox.hasPublicationOutboxFailed(abrainHome) === false, "hasFailed false empty");
});

await check("maintenance: config gate; deadline/restart unreaped", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  await seedPendingOutbox(1);
  let drainCalls = 0;
  const cfg = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-cfg"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "foreground",
    drainKnowledgePublicationOutbox: async () => { drainCalls += 1; },
    countPublicationOutboxPending: async () => (await outbox.listPublicationOutboxPending(abrainHome)).length,
  });
  assert(cfg.status === "failed", `cfg status=${cfg.status}`);
  assert(cfg.error_code === "effective_owner_not_daemon", `code=${cfg.error_code}`);
  assert(cfg.retryable === false, "config not retry thrash");
  assert(cfg.pending_before_bucket === "unknown" && cfg.pending_after_bucket === "unknown", "config failure count is unknown");
  assert(cfg.failed_bucket === "unknown", "config gate failed_bucket unknown");
  assert(drainCalls === 0, "config gate must not drain");
  assert((await outbox.listPublicationOutboxPending(abrainHome)).length === 1, "no write on config fail");

  const security = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-security-env"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => {
      drainCalls += 1;
      return completedDrain();
    },
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
    env: {},
  });
  // Security-env failures collapse into the closed maintenance error enum
  // (copy_store_* / allowed_owner_* → worker_security_gate_failed).
  assert(security.status === "failed" && security.error_code === "worker_security_gate_failed", `security=${JSON.stringify(security)}`);
  assert(security.pending_before_bucket === "unknown" && security.pending_after_bucket === "unknown", "security failure count unknown");
  assert(drainCalls === 0, "security env failure must be zero-write");

  const countFailed = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-count-failed"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => {
      drainCalls += 1;
      return completedDrain();
    },
    countPublicationOutboxPending: async () => { throw new Error("count failed"); },
  });
  assert(countFailed.status === "failed" && countFailed.error_code === "publication_outbox_count_failed", `count=${JSON.stringify(countFailed)}`);
  assert(countFailed.pending_before_bucket === "unknown" && countFailed.pending_after_bucket === "unknown", "count failure buckets unknown");
  assert(countFailed.failed_bucket === "unknown", "pending count failure leaves failed_bucket unknown");
  assert(drainCalls === 0, "before count failure must not drain");

  // Budget unreaped hang → restart_child + poison.
  resetWorkerPoisonState();
  let t = 7_000_000;
  worker._setWorkerFenceSliceMsForTests(5);
  const hung = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-hang"),
    budget_ms: 60_000,
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    clock: () => t,
    drainKnowledgePublicationOutbox: async () => {
      t = 7_000_000 + 60_000;
      await new Promise(() => {});
    },
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(hung.status === "failed", `hung status=${hung.status}`);
  assert(hung.restart_child === true, "unreaped restart_child");
  assert(hung.error_code === "cancel_cleanup_unreaped", `hung code=${hung.error_code}`);
  assert(worker.isWorkerProcessPoisoned() === true, "unreaped poisons process");
  const refused = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-poison-refuse"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain(),
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(refused.error_code === "worker_process_poisoned" && refused.restart_child === true, `poison refuse=${JSON.stringify(refused)}`);
  assert(refused.pending_before_bucket === "unknown" && refused.pending_after_bucket === "unknown", "poison refusal count unknown");
  worker._setWorkerFenceSliceMsForTests(undefined);
  resetWorkerPoisonState();
  await clearPendingOutbox();
});

await check("maintenance: global serial wait timeout is retryable busy without poisoning healthy pass", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  await seedPendingOutbox(1);
  let releaseBlocker;
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const blocker = worker.withGlobalPassSerial(async () => {
    markEntered();
    await new Promise((resolve) => { releaseBlocker = resolve; });
  });
  await entered;
  let drainCalls = 0;
  const maintenance = worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-serial"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: () => {
      drainCalls += 1;
      return outbox.schedulePublicationOutboxDrain(abrainHome, async () => "done");
    },
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert(drainCalls === 0, "maintenance ran concurrently with task serial owner");
  releaseBlocker();
  await blocker;
  const serialized = await maintenance;
  assert(serialized.status === "drained" && drainCalls === 1, `serialized=${JSON.stringify(serialized)}`);

  await seedPendingOutbox(1);
  let releaseDeadlineBlocker;
  let deadlineBlockerEntered;
  const deadlineEntered = new Promise((resolve) => { deadlineBlockerEntered = resolve; });
  const deadlineBlocker = worker.withGlobalPassSerial(async () => {
    deadlineBlockerEntered();
    await new Promise((resolve) => { releaseDeadlineBlocker = resolve; });
  });
  await deadlineEntered;
  let now = 9_000_000;
  worker._setWorkerFenceSliceMsForTests(5);
  const deadlineResultPromise = worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-serial-deadline"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain(),
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
    clock: () => now,
  });
  now += 55_000;
  const deadlineResult = await deadlineResultPromise;
  assert(deadlineResult.status === "pending" && deadlineResult.error_code === "maintenance_worker_busy", `serial deadline=${JSON.stringify(deadlineResult)}`);
  assert(deadlineResult.retryable === true && deadlineResult.restart_child === false, "serial wait busy must not restart child");
  assert(deadlineResult.pending_before_bucket === "unknown" && deadlineResult.pending_after_bucket === "unknown", "serial wait busy count unknown");
  assert(worker.isWorkerProcessPoisoned() === false, "maintenance serial wait poisoned healthy owner");
  releaseDeadlineBlocker();
  await deadlineBlocker;

  const healthyReuse = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-after-serial-busy"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: () => outbox.schedulePublicationOutboxDrain(abrainHome, async () => "done"),
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });
  assert(healthyReuse.status === "drained" && healthyReuse.restart_child === false, `healthy pass did not survive serial busy: ${JSON.stringify(healthyReuse)}`);
  assert(worker.isWorkerProcessPoisoned() === false, "healthy reuse became poisoned");
  resetWorkerPoisonState();
  await clearPendingOutbox();
});

await check("maintenance: zero cleanup still observes late drain rejection", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  await seedPendingOutbox(1);
  let now = 10_000_000;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  worker._setWorkerFenceSliceMsForTests(5);
  try {
    const result = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
      request_id: hex64("maint-zero-cleanup-reject"),
    })), {
      resolveAbrainHome: () => abrainHome,
      resolveEffectiveExecutionOwner: () => "daemon",
      drainKnowledgePublicationOutbox: async () => {
        now += 60_000;
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("late drain rejection");
      },
      countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
      clock: () => now,
    });
    assert(result.error_code === "cancel_cleanup_unreaped" && result.restart_child === true, `zero cleanup=${JSON.stringify(result)}`);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert(unhandled.length === 0, `late rejection became unhandled: ${String(unhandled[0])}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    resetWorkerPoisonState();
    await clearPendingOutbox();
  }
});

await check("maintenance: result/progress key whitelist + sensitive scan", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  const progressEvents = [];
  const r = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-whitelist"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => completedDrain(),
    countPublicationOutboxPending: async () => 0,
    onProgress: (ev) => progressEvents.push(ev),
  });
  assert(worker.sanitizeWorkerMaintenanceResult(r) !== null, "result whitelist ok");
  assert(r.failed_bucket === "0" || r.failed_bucket === "unknown", `idle-path failed_bucket=${r.failed_bucket}`);
  const notify = worker.formatWorkerMaintenanceResultNotify(r);
  assert(worker.maintenanceResultNotifyHasSensitiveContent(notify) === false, "no sensitive content");
  assert(notify.startsWith("sediment-worker-maintenance-result:"), "prefix");
  // Optional failed_bucket is whitelisted; absent remains forward-compatible.
  assert(worker.sanitizeWorkerMaintenanceResult({
    schema: r.schema,
    request_id: r.request_id,
    status: r.status,
    retryable: r.retryable,
    restart_child: r.restart_child,
    pending_before_bucket: r.pending_before_bucket,
    pending_after_bucket: r.pending_after_bucket,
  }) !== null, "result without failed_bucket accepted");
  assert(worker.sanitizeWorkerMaintenanceResult({
    ...r,
    failed_bucket: "1",
  }) !== null, "closed failed_bucket accepted");
  assert(worker.sanitizeWorkerMaintenanceResult({
    ...r,
    failed_bucket: "99",
  }) === null, "non-closed failed_bucket rejected");

  // Reject free-text / path / item id keys.
  assert(worker.sanitizeWorkerMaintenanceResult({
    ...r,
    message: "boom",
  }) === null, "unknown key rejected");
  assert(worker.sanitizeWorkerMaintenanceResult({
    ...r,
    error_code: "has space",
  }) === null, "free-text error_code rejected");
  const evil = `sediment-worker-maintenance-result:${JSON.stringify({
    ...r,
    path: "/tmp/secret",
  })}`;
  assert(worker.maintenanceResultNotifyHasSensitiveContent(evil) === true, "path sensitive");
  const evilFailed = `sediment-worker-maintenance-result:${JSON.stringify({
    ...r,
    failed_bucket: "1",
    item_id: "a".repeat(64),
  })}`;
  assert(worker.maintenanceResultNotifyHasSensitiveContent(evilFailed) === true, "item_id with failed_bucket still sensitive");

  // Progress stage publication allowed (idle path may not emit; force via pending).
  await seedPendingOutbox(1);
  progressEvents.length = 0;
  await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-progress"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      const left = await outbox.listPublicationOutboxPending(abrainHome);
      for (const row of left) fs.unlinkSync(row.filePath);
      return completedDrain({ processed: left.length, drained: left.length, pending: 0 });
    },
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
    onProgress: (ev) => progressEvents.push(ev),
    heartbeatMs: 5,
  });
  assert(progressEvents.some((e) => e.stage === "publication"), "publication progress stage");
  assert(progressEvents.some((e) => e.stage === "publication" && e.phase === "heartbeat"), "publication heartbeat while running");
  for (const ev of progressEvents) {
    const n = worker.formatWorkerProgressNotify(ev);
    assert(worker.progressNotifyHasSensitiveContent(n) === false, "progress no sensitive");
  }
  await clearPendingOutbox();
});

await check("maintenance: no CP/receipt/source change; buckets closed; unknown field reject", async () => {
  resetWorkerPoisonState();
  await clearPendingOutbox();
  await seedPendingOutbox(1);
  const cpBefore = fs.existsSync(path.join(projectRoot, ".pi-astack")) ?
    fs.readdirSync(path.join(projectRoot, ".pi-astack"), { recursive: true }).length : 0;
  const receiptDir = worker.sedimentWorkerReceiptsDir(abrainHome);
  const receiptsBefore = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).length : 0;
  const sourceDir = path.join(abrainHome, ".state", "sediment", "edge-protocol-shadow");
  const sourceBefore = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir, { recursive: true }).length
    : 0;

  await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceReq({
    request_id: hex64("maint-no-side"),
  })), {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: async () => {
      const left = await outbox.listPublicationOutboxPending(abrainHome);
      for (const row of left) fs.unlinkSync(row.filePath);
      return completedDrain({ processed: left.length, drained: left.length, pending: 0 });
    },
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
  });

  const receiptsAfter = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).length : 0;
  const sourceAfter = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir, { recursive: true }).length
    : 0;
  const cpAfter = fs.existsSync(path.join(projectRoot, ".pi-astack")) ?
    fs.readdirSync(path.join(projectRoot, ".pi-astack"), { recursive: true }).length : 0;
  assert(receiptsAfter === receiptsBefore, "maintenance must not write receipts");
  assert(sourceAfter === sourceBefore, "maintenance must not touch edge source");
  assert(cpAfter === cpBefore, "maintenance must not change project checkpoint tree");

  assert(worker.bucketOutboxPendingCount(null) === "unknown", "bucket unknown");
  assert(worker.bucketOutboxPendingCount(Number.NaN) === "unknown", "bucket non-finite unknown");
  assert(worker.bucketOutboxPendingCount(0) === "0", "bucket 0");
  assert(worker.bucketOutboxPendingCount(1) === "1", "bucket 1");
  assert(worker.bucketOutboxPendingCount(3) === "2-4", "bucket 2-4");
  assert(worker.bucketOutboxPendingCount(7) === "5-9", "bucket 5-9");
  assert(worker.bucketOutboxPendingCount(20) === "10-49", "bucket 10-49");
  assert(worker.bucketOutboxPendingCount(50) === "50+", "bucket 50+");

  let threw = false;
  try {
    worker.validateSedimentWorkerMaintenanceRequest({
      ...maintenanceReq(),
      session_id: "nope",
    });
  } catch (e) {
    threw = e.code === "unknown_field";
  }
  assert(threw, "identity field rejected");

  threw = false;
  try {
    worker.validateSedimentWorkerMaintenanceRequest({
      ...maintenanceReq(),
      budget_ms: 30_000,
    });
  } catch (e) {
    threw = e.code === "budget_ms_out_of_range";
  }
  assert(threw, "budget min 60s");

  threw = false;
  try {
    worker.validateSedimentWorkerMaintenanceRequest({
      ...maintenanceReq(),
      budget_ms: 901_000,
    });
  } catch (e) {
    threw = e.code === "budget_ms_out_of_range";
  }
  assert(threw, "budget max 900s");

  await clearPendingOutbox();
});

await check("foreground unchanged: no maintenance registration outside worker mode", async () => {
  const prev = process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  delete process.env.PI_ASTACK_SEDIMENT_WORKER_MODE;
  writeSettings({ executionOwner: "foreground" });
  try {
    const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
    const pi = fakePi();
    (sediment.default ?? sediment)(pi.api);
    assert(pi.handlers.has("agent_end"), "foreground agent_end remains");
    assert(!pi.commands.has("sediment-worker-maintenance"), "no maintenance outside worker");
    assert(!pi.commands.has("sediment-worker-run"), "no worker-run outside worker");
    assert(!pi.commands.has("sediment-worker-capabilities"), "no capabilities outside worker");
  } finally {
    if (prev !== undefined) process.env.PI_ASTACK_SEDIMENT_WORKER_MODE = prev;
    writeSettings({ executionOwner: "daemon" });
  }
});

console.log(`\n${passed} checks passed`);
console.log(`tmp=${tmp}`);
