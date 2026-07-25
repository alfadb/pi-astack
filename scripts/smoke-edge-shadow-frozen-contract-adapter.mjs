#!/usr/bin/env node
/**
 * Smoke for ADR 0044 Stage A0 frozen-contract read-only adapter.
 *
 * Covers: contract identity pin (e26f669 + FDS sha256), default-off gate,
 * FDS-driven projection (wire + proto-JSON), session_writer_epoch:string →
 * producer_process_identity only (never formal writer epoch), C6 string/integer
 * scalar variants, candidate/witness body oneof, formal pi-router adapter
 * conformance gate (external CLI bundle via argv --pi-router-root), producer
 * record_id recompute (M1), scan/snapshot symlink fail-closed (M2),
 * read-only scan + zero mutation, strict tsc.
 * Never prints raw bodies or absolute paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const adapterCli = path.join(root, "scripts/edge-shadow-adapter-conformance-cli.mjs");
const piRouterRoot = process.env.PI_ROUTER_ROOT
  ? path.resolve(process.env.PI_ROUTER_ROOT)
  : "/home/worker/work/components/pi-router";

let passed = 0;
const tmpRoots = [];

function assert(v, msg) {
  if (!v) throw new Error(msg);
}

function sha(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function loadAdapter() {
  const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
  return jiti.import(path.join(root, "extensions/sediment/edge-shadow-frozen-contract-adapter.ts"));
}

async function loadEdge() {
  const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
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

async function check(name, fn) {
  process.stdout.write(`  · ${name} ... `);
  await fn();
  passed += 1;
  process.stdout.write("ok\n");
}

function cleanup() {
  for (const t of tmpRoots) {
    try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function hex64(seed) {
  return sha(seed);
}

function baseCandidate(overrides = {}) {
  const content = hex64("content-cand-1");
  return {
    schema: "pi-astack/edge-journal/v1",
    schema_version: 1,
    record_id: hex64("rec-cand-1"),
    session_id: "sess-1",
    producer_seq: 1,
    session_writer_epoch: "k1x-pid42-uuid",
    record_type: "candidate_capture",
    created_at: "2026-07-24T16:56:25.353Z",
    payload_digest: content,
    c6: { session_id: "sess-1", turn_id: 7, subturn: 0, sub_agent_label: "dispatch_agent" },
    run_generation: 1,
    source_ref: {
      kind: "raw_sidecar",
      content_id: content,
      relative_path: `sources/${content}.json`,
      byte_length: 128,
    },
    capabilities: {
      authority: "protocol_shadow",
      local_primary_authority: "existing_sediment_intake",
      session_transaction: false,
      launch_broker: false,
      terminal_seal: false,
      link_open_close: false,
      stage_a_complete: false,
    },
    leaf_tip: { id: "tip-1", parentId: null, type: "assistant", timestampUtc: "2026-07-24T16:56:00Z" },
    deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"],
    ...overrides,
  };
}

function baseWitness(overrides = {}) {
  const content = hex64("content-wit-1");
  return {
    schema: "pi-astack/edge-journal/v1",
    schema_version: 1,
    record_id: hex64("rec-wit-1"),
    session_id: "sess-1",
    producer_seq: 2,
    session_writer_epoch: "proc-1",
    record_type: "terminal_witness",
    created_at: "2026-07-24T16:56:26Z",
    payload_digest: content,
    c6: { session_id: "sess-1", turn_id: "7" },
    run_generation: 1,
    source_ref: {
      kind: "raw_sidecar",
      content_id: content,
      relative_path: `sources/${content}.json`,
      byte_length: 64,
    },
    candidate_ref: {
      record_id: hex64("rec-cand-1"),
      producer_seq: 1,
      payload_digest: content,
      run_generation: 1,
    },
    capabilities: {
      authority: "protocol_shadow",
      local_primary_authority: "existing_sediment_intake",
      session_transaction: false,
      launch_broker: false,
      terminal_seal: false,
      link_open_close: false,
      stage_a_complete: false,
    },
    settlement_status: "unsupported_core_capability",
    ...overrides,
  };
}

/** Formal argv for harness: node + cli + --pi-router-root <abs> (no PI_ROUTER_ROOT env). */
function adapterCommandJson() {
  return JSON.stringify([process.execPath, adapterCli, "--pi-router-root", piRouterRoot]);
}

/**
 * M5: formal gate parse — records=N and source_snapshot_unchanged only from
 * the run_utc= aggregate line; result=ok only from a separate formal result line
 * plus cargo exit 0. No "any records=" fallback.
 */
function parseFormalConformanceOutput(status, combined) {
  const runLine = /edge_adapter_conformance\s+run_utc=[^\n]*/.exec(combined);
  let formalRecords = 0;
  let sourceUnchanged = false;
  if (runLine) {
    const rec = /\brecords=(\d+)/.exec(runLine[0]);
    if (rec) formalRecords = Number(rec[1]);
    sourceUnchanged = /\bsource_snapshot_unchanged=true\b/.test(runLine[0]);
  }
  const resultOk = /edge_adapter_conformance\s+result=ok\b/.test(combined);
  const ok = status === 0 && resultOk;
  return {
    status,
    ok,
    formal_conformance_records: formalRecords,
    source_snapshot_unchanged: sourceUnchanged,
  };
}

/** Formal pi-router adapter conformance gate (external CLI). */
function runFormalAdapterConformance(edgeRoot) {
  const result = spawnSync(
    "cargo",
    [
      "test",
      "-p",
      "pi_memory_proto",
      "--test",
      "edge_shadow_adapter_conformance",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      cwd: piRouterRoot,
      env: {
        ...process.env,
        PI_MEMORY_EDGE_ADAPTER_CONFORMANCE: "1",
        PI_MEMORY_EDGE_SHADOW_ROOT: edgeRoot,
        PI_MEMORY_EDGE_ADAPTER_COMMAND_JSON: adapterCommandJson(),
        // Intentionally no PI_ROUTER_ROOT — CLI must take root from argv.
      },
      encoding: "utf8",
      timeout: 600_000,
    },
  );
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  return parseFormalConformanceOutput(result.status, combined);
}

try {
  console.log("smoke:edge-shadow-frozen-contract-adapter");

  await check("default-off gate", async () => {
    const adapter = await loadAdapter();
    delete process.env.PI_ASTACK_EDGE_SHADOW_FROZEN_CONTRACT_ADAPTER;
    assert(adapter.isFrozenContractAdapterEnabled() === false, "default must be off");
    assert(adapter.isFrozenContractAdapterEnabled(false) === false, "false stays off");
    assert(adapter.isFrozenContractAdapterEnabled(true) === true, "explicit true on");
    process.env.PI_ASTACK_EDGE_SHADOW_FROZEN_CONTRACT_ADAPTER = "0";
    assert(adapter.isFrozenContractAdapterEnabled(true) === false, "env 0 overrides");
    process.env.PI_ASTACK_EDGE_SHADOW_FROZEN_CONTRACT_ADAPTER = "1";
    assert(adapter.isFrozenContractAdapterEnabled(false) === true, "env 1 overrides");
    delete process.env.PI_ASTACK_EDGE_SHADOW_FROZEN_CONTRACT_ADAPTER;
  });

  await check("frozen contract identity pin (e26f669 + FDS sha256)", async () => {
    const adapter = await loadAdapter();
    assert(
      adapter.FROZEN_MEMORY_CONTRACT_COMMIT === "e26f669e51966efb05a0a23894356e262b897ed6",
      "commit pin",
    );
    assert(
      adapter.FROZEN_MEMORY_FDS_SHA256 ===
        "0076de46d54705f509082963d91068e9b99cc5740473c5c7ab772fb9fddb1f66",
      "fds pin",
    );
    const id = adapter.verifyFrozenContractIdentity({
      piRouterRoot,
      require: true,
      checkGitHead: true,
    });
    assert(id.fds_status === "verified", `fds_status=${id.fds_status}`);
    assert(id.observed_fds_sha256 === adapter.FROZEN_MEMORY_FDS_SHA256, "observed digest");
    assert(id.contract_commit_short === "e26f669", "short commit");
    assert(id.pi_router_head_matches_contract === true, "exact freeze commit present");
    const contract = adapter.loadFrozenEdgeShadowContract({ piRouterRoot });
    assert(contract.fdsSha256 === adapter.FROZEN_MEMORY_FDS_SHA256, "loaded fds");
    assert(contract.type && contract.type.name === "EdgeShadowJournalRecord", "fds type");
  });

  await check("parsePiRouterRootArgv strict (abs only; reject unknown/missing/relative/NUL)", async () => {
    const adapter = await loadAdapter();
    const abs = piRouterRoot;
    assert(adapter.parsePiRouterRootArgv(["--pi-router-root", abs]) === abs, "abs ok");
    let threw = 0;
    for (const bad of [
      [],
      ["--pi-router-root"],
      ["--pi-router-root", "relative/path"],
      ["--pi-router-root", "./here"],
      ["--pi-router-root", abs, "--extra"],
      ["--other", abs],
      ["--pi-router-root", `abs\0bad`],
    ]) {
      try {
        adapter.parsePiRouterRootArgv(bad);
      } catch {
        threw += 1;
      }
    }
    assert(threw === 7, `expected 7 rejects got ${threw}`);
  });

  await check("project candidate: FDS wire + producer_process_identity + integer scalar", async () => {
    const adapter = await loadAdapter();
    const projected = adapter.projectEdgeShadowToFormal(baseCandidate(), { piRouterRoot });
    const formal = projected.proto_json;
    assert(formal.producer_process_identity === "k1x-pid42-uuid", "identity mapped");
    assert(formal.session_writer_epoch === undefined, "no formal epoch field on projection");
    assert(formal.candidate_capture, "candidate_capture body present");
    assert(!formal.terminal_witness, "no terminal_witness body");
    assert(projected.identity.body === "candidate_capture", "identity body");
    assert(projected.wire instanceof Uint8Array && projected.wire.byteLength > 0, "wire bytes");
    assert(formal.temporary_run_generation === 1, "temp run gen");
    assert(formal.c6.turn_id.integer_value === 7, "integer turn_id preserved");
    assert(formal.c6.subturn.integer_value === 0, "integer subturn");
    assert(formal.candidate_capture.raw_sidecar.relative_path.startsWith("sources/"), "raw sidecar");
    assert(
      formal.candidate_capture.leaf_tip.parent_id === undefined,
      "null parentId omitted",
    );
    assert(
      formal.candidate_capture.deferred_missing_core.includes(
        "EDGE_SHADOW_MISSING_CORE_CAPABILITY_SESSION_TRANSACTION",
      ),
      "deferred enum from FDS",
    );
    const cls = adapter.classifyFormalEdgeShadowCapabilities(formal.capabilities);
    assert(cls.retention_ineligible === true && cls.worker_ineligible === true, "ineligible");
    assert(cls.identity_class === "shadow_only_producer_process_identity", "shadow-only");
  });

  await check("project witness: candidate_ref + settlement enum + string scalar", async () => {
    const adapter = await loadAdapter();
    const projected = adapter.projectEdgeShadowToFormal(baseWitness(), { piRouterRoot });
    const formal = projected.proto_json;
    assert(formal.terminal_witness, "terminal_witness body");
    assert(!formal.candidate_capture, "no candidate body");
    assert(formal.c6.turn_id.string_value === "7", "string turn_id preserved");
    assert(
      formal.terminal_witness.settlement_status ===
        "EDGE_SHADOW_SETTLEMENT_STATUS_UNSUPPORTED_CORE_CAPABILITY",
      "settlement enum from FDS",
    );
    assert(formal.terminal_witness.candidate_ref.temporary_run_generation === 1, "ref run gen");
    assert(formal.temporary_run_generation === 1, "outer run gen from candidate");
    assert(projected.wire.byteLength > 0, "witness wire");
  });

  await check("reject numeric session_writer_epoch (never formal writer epoch)", async () => {
    const adapter = await loadAdapter();
    let threw = false;
    try {
      adapter.projectEdgeShadowToFormal(
        baseCandidate({ session_writer_epoch: 1784900789271 }),
        { piRouterRoot },
      );
    } catch (err) {
      threw = true;
      assert(err.code === "string_required" || /session_writer_epoch/.test(err.message), err.message);
    }
    assert(threw, "must reject numeric identity");
    let coerceThrew = false;
    try {
      adapter.refuseCoerceProducerIdentityToWriterEpoch("k1x-pid42-uuid");
    } catch {
      coerceThrew = true;
    }
    assert(coerceThrew, "refuse coerce always throws");
  });

  await check("reject float turn_id; preserve string variant", async () => {
    const adapter = await loadAdapter();
    let threw = false;
    try {
      adapter.projectEdgeShadowToFormal(
        baseCandidate({ c6: { session_id: "sess-1", turn_id: 1.5 } }),
        { piRouterRoot },
      );
    } catch {
      threw = true;
    }
    assert(threw, "float turn_id rejected");
    const formal = adapter.projectEdgeShadowToFormalProtoJson(
      baseCandidate({ c6: { session_id: "sess-1", turn_id: "7", subturn: "0" } }),
      { piRouterRoot },
    );
    assert(formal.c6.turn_id.string_value === "7", "string turn");
    assert(formal.c6.subturn.string_value === "0", "string subturn");
  });

  await check("reject witness when candidate_ref.run_generation != producer_seq", async () => {
    const adapter = await loadAdapter();
    let threw = false;
    try {
      adapter.projectEdgeShadowToFormal(
        baseWitness({
          run_generation: 9,
          candidate_ref: {
            record_id: hex64("rec-cand-1"),
            producer_seq: 1,
            payload_digest: hex64("content-wit-1"),
            run_generation: 9,
          },
        }),
        { piRouterRoot },
      );
    } catch (err) {
      threw = true;
      assert(/candidate_ref\.run_generation must equal candidate_ref\.producer_seq/.test(err.message), err.message);
    }
    assert(threw, "must reject gen!=seq");
  });

  await check("writeAdapterWireCorpus removed (no old local harness API)", async () => {
    const adapter = await loadAdapter();
    assert(typeof adapter.writeAdapterWireCorpus !== "function", "writeAdapterWireCorpus must be gone");
  });

  await check("read-only scan + formal pi-router conformance gate + zero mutation", async () => {
    const adapter = await loadAdapter();
    const edge = await loadEdge();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-frozen-"));
    tmpRoots.push(tmp);
    const abrainHome = path.join(tmp, "abrain");
    const ownerRoot = path.join(tmp, "owner");
    fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(ownerRoot, { recursive: true });
    const sessionId = "sess-frozen-smoke-001";
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello frozen" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
    ];
    const cap = await edge.captureEdgeProtocolCandidate({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
      messages,
      c6: { session_id: sessionId, turn_id: 3 },
      leafTip: { id: "leaf-a", parentId: null, type: "message" },
    });
    assert(cap.status === "captured", `capture ${cap.status} ${cap.error_code || ""}`);
    const wit = await edge.writeEdgeTerminalWitness({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
      c6: { session_id: sessionId, turn_id: 3 },
      leafTip: { id: "leaf-a", parentId: null, type: "message" },
    });
    assert(wit.status === "written", `witness ${wit.status}`);

    const edgeRoot = edge.edgeProtocolShadowRoot(abrainHome);
    const before = adapter.snapshotEdgeRootContentDigest(edgeRoot);
    const { aggregate, projections } = adapter.scanEdgeShadowRootReadOnly(edgeRoot, { piRouterRoot });
    const afterScan = adapter.snapshotEdgeRootContentDigest(edgeRoot);

    assert(aggregate.records_seen === 2, `seen=${aggregate.records_seen}`);
    assert(aggregate.records_projected_ok === 2, `ok=${aggregate.records_projected_ok}`);
    assert(aggregate.records_projection_failed === 0, "no projection failures");
    assert(aggregate.candidate_capture === 1 && aggregate.terminal_witness === 1, "body counts");
    assert(aggregate.identity_shadow_only === 2, "shadow-only");
    assert(aggregate.retention_ineligible === 2 && aggregate.worker_ineligible === 2, "ineligible");
    assert(aggregate.raw_sidecar_messages_digest_mismatch === 0, "sidecar digests");
    assert(aggregate.raw_sidecar_missing_file === 0, "sidecars present");
    assert(aggregate.scan_errors === 0, "no scan errors");
    assert(projections.length === 2, "projections");
    assert(projections.every((p) => p.wire.byteLength > 0), "all wires");
    assert(
      projections.every((p) => typeof p.identity.producer_process_identity === "string" && p.identity.producer_process_identity.length > 0),
      "all have producer_process_identity",
    );

    // Authoritative formal gate (external adapter CLI → manifest + records.ndjson).
    const formal = runFormalAdapterConformance(edgeRoot);
    assert(formal.status === 0, `formal gate exit=${formal.status}`);
    assert(formal.ok === true, "formal result=ok");
    assert(formal.formal_conformance_records === 2, `formal records=${formal.formal_conformance_records}`);
    assert(formal.source_snapshot_unchanged === true, "formal zero mutation");

    const afterFormal = adapter.snapshotEdgeRootContentDigest(edgeRoot);
    assert(before.aggregate_sha256 === afterScan.aggregate_sha256, "zero mutation after scan");
    assert(afterScan.aggregate_sha256 === afterFormal.aggregate_sha256, "zero mutation after formal");
    assert(before.file_count === afterFormal.file_count, "zero mutation file count");
  });

  await check("M1: tampered body with stale record_id → projection failed", async () => {
    const adapter = await loadAdapter();
    const edge = await loadEdge();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-m1-"));
    tmpRoots.push(tmp);
    const abrainHome = path.join(tmp, "abrain");
    const ownerRoot = path.join(tmp, "owner");
    fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(ownerRoot, { recursive: true });
    const sessionId = "sess-m1-tamper";
    const messages = [
      { role: "user", content: [{ type: "text", text: "m1" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ];
    const cap = await edge.captureEdgeProtocolCandidate({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
      messages,
      c6: { session_id: sessionId, turn_id: 1 },
      leafTip: { id: "leaf-m1", parentId: null, type: "message" },
    });
    assert(cap.status === "captured", "capture for m1");
    const edgeRoot = edge.edgeProtocolShadowRoot(abrainHome);
    // Locate the durable record file and tamper body without changing record_id / filename.
    const byOwner = path.join(edgeRoot, "by-owner");
    const owners = fs.readdirSync(byOwner);
    assert(owners.length >= 1, "owner present");
    const sessionsDir = path.join(byOwner, owners[0], "sessions", sessionId, "journal", "records");
    const names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".json"));
    assert(names.length === 1, "one record");
    const recPath = path.join(sessionsDir, names[0]);
    const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
    const originalId = rec.record_id;
    // Tamper a body field that participates in record_id JCS (created_at).
    rec.created_at = "2099-01-01T00:00:00.000Z";
    assert(rec.record_id === originalId, "id left unchanged");
    fs.writeFileSync(recPath, `${JSON.stringify(rec, null, 2)}\n`);

    const { aggregate } = adapter.scanEdgeShadowRootReadOnly(edgeRoot, { piRouterRoot });
    assert(aggregate.records_seen === 1, "seen tampered");
    assert(aggregate.records_projection_failed >= 1, "projection failed on tamper");
    assert(aggregate.records_projected_ok === 0, "no ok projections");
  });

  await check("M2: symlink/non-dir under layout fail-closed (scan + snapshot)", async () => {
    const adapter = await loadAdapter();
    const edge = await loadEdge();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-m2-"));
    tmpRoots.push(tmp);
    const abrainHome = path.join(tmp, "abrain");
    const ownerRoot = path.join(tmp, "owner");
    fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(ownerRoot, { recursive: true });
    const sessionId = "sess-m2-symlink";
    const messages = [
      { role: "user", content: [{ type: "text", text: "m2" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ];
    const cap = await edge.captureEdgeProtocolCandidate({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
      messages,
      c6: { session_id: sessionId, turn_id: 1 },
      leafTip: { id: "leaf-m2", parentId: null, type: "message" },
    });
    assert(cap.status === "captured", "capture for m2");
    const edgeRoot = edge.edgeProtocolShadowRoot(abrainHome);

    // Replace sessions dir with a symlink escaping toward tmp (OOB risk).
    const byOwner = path.join(edgeRoot, "by-owner");
    const owners = fs.readdirSync(byOwner);
    const ownerPath = path.join(byOwner, owners[0]);
    const sessionsPath = path.join(ownerPath, "sessions");
    const outside = path.join(tmp, "outside-sessions");
    fs.renameSync(sessionsPath, outside);
    fs.symlinkSync(outside, sessionsPath);

    const { aggregate } = adapter.scanEdgeShadowRootReadOnly(edgeRoot, { piRouterRoot });
    assert(aggregate.scan_errors >= 1, "scan fail-closed on sessions symlink");
    assert(aggregate.records_projected_ok === 0, "no projections via symlink");

    let snapThrew = false;
    try {
      adapter.snapshotEdgeRootContentDigest(edgeRoot);
    } catch {
      snapThrew = true;
    }
    assert(snapThrew, "snapshot fail-closed on symlink");

    // Non-directory where a directory is required (by-owner entry as file).
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-m2b-"));
    tmpRoots.push(tmp2);
    const fakeRoot = path.join(tmp2, "edge");
    fs.mkdirSync(path.join(fakeRoot, "by-owner"), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, "by-owner", "not-a-dir"), "x");
    const scan2 = adapter.scanEdgeShadowRootReadOnly(fakeRoot, { piRouterRoot });
    assert(scan2.aggregate.scan_errors >= 1, "non-dir owner fail-closed");
  });

  await check("adapter CLI fail-closed on env mismatch / missing argv (no body/path leak)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-cli-fail-"));
    tmpRoots.push(tmp);
    const outDir = path.join(tmp, "out");
    fs.mkdirSync(outDir, { recursive: true });
    // Wrong commit → must exit non-zero, silent streams. No PI_ROUTER_ROOT.
    const bad = spawnSync(process.execPath, [adapterCli, "--pi-router-root", piRouterRoot], {
      env: {
        PATH: process.env.PATH,
        PI_MEMORY_EDGE_SHADOW_ROOT: tmp,
        PI_MEMORY_EDGE_ADAPTER_OUTPUT_DIR: outDir,
        PI_MEMORY_CONTRACT_COMMIT: "0".repeat(40),
        PI_MEMORY_FDS_SHA256: "0076de46d54705f509082963d91068e9b99cc5740473c5c7ab772fb9fddb1f66",
        PI_MEMORY_PROTO_JSON_FIELD_NAMES: "preserving_proto_field_name",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert(bad.status !== 0, "wrong commit must fail");
    assert(!/(home|worker|\/tmp|sources\/|record_id)/i.test(`${bad.stdout || ""}${bad.stderr || ""}`), "no path/body leak");

    // Missing --pi-router-root argv → fail (even with correct env contract).
    const outDir2 = path.join(tmp, "out2");
    fs.mkdirSync(outDir2, { recursive: true });
    const missingArgv = spawnSync(process.execPath, [adapterCli], {
      env: {
        PATH: process.env.PATH,
        PI_MEMORY_EDGE_SHADOW_ROOT: tmp,
        PI_MEMORY_EDGE_ADAPTER_OUTPUT_DIR: outDir2,
        PI_MEMORY_CONTRACT_COMMIT: "e26f669e51966efb05a0a23894356e262b897ed6",
        PI_MEMORY_FDS_SHA256: "0076de46d54705f509082963d91068e9b99cc5740473c5c7ab772fb9fddb1f66",
        PI_MEMORY_PROTO_JSON_FIELD_NAMES: "preserving_proto_field_name",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert(missingArgv.status !== 0, "missing --pi-router-root must fail");
  });

  await check("strict tsc on adapter", async () => {
    const tscJs = path.join(root, "node_modules/typescript/lib/tsc.js");
    assert(fs.existsSync(tscJs), "repo-local typescript missing");
    const typeRoots = path.join(root, "node_modules/@types");
    const targetFile = path.join(root, "extensions/sediment/edge-shadow-frozen-contract-adapter.ts");
    const result = await spawnChild([
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
