#!/usr/bin/env node
/**
 * Production acceptance for ADR 0044 Stage A0 frozen-contract read-only adapter.
 *
 * Single formal validation path (pi-router is the consuming authority):
 * 1) Verify frozen contract identity (pi-router e26f669 + memory.fds sha256)
 * 2) Build real production edge-protocol-shadow corpus from real Pi session JSONL
 * 3) Local FDS-driven read-only projection aggregate (counts only)
 * 4) Formal gate: cargo test -p pi_memory_proto --test edge_shadow_adapter_conformance
 *    with external adapter CLI (argv --pi-router-root; manifest.json + records.ndjson)
 * 5) Sidecar: e26f669 edge_shadow_corpus exact RawValue digest cross-check
 * 6) Zero mutation of source journal/sidecars (before/after formal gate)
 *
 * Accepted stdout ONLY:
 *   { contract_commit, fds_sha256, records, zero_mutation }
 * Failures never leak body/path. Exit 0 only when formal gate + sidecar pass.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  collectMainChainFromSession,
  isTerminalAssistantMessage,
} from "./edge-protocol-shadow-chain.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const adapterCli = path.join(root, "scripts/edge-shadow-adapter-conformance-cli.mjs");

const MIN_TURNS = Math.max(1, Number(process.env.EDGE_FROZEN_MIN_TURNS || 10));
const TARGET_SESSIONS = Math.max(1, Number(process.env.EDGE_FROZEN_TARGET_SESSIONS || 10));
const sessionsRoot = process.env.PI_SESSIONS_DIR
  ? path.resolve(process.env.PI_SESSIONS_DIR)
  : path.join(os.homedir(), ".pi", "agent", "sessions");
const piRouterRoot = process.env.PI_ROUTER_ROOT
  ? path.resolve(process.env.PI_ROUTER_ROOT)
  : "/home/worker/work/components/pi-router";

function listSessionFiles(dir, acc = [], depth = 0) {
  if (depth > 4 || acc.length > 800) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listSessionFiles(full, acc, depth + 1);
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      try {
        const st = fs.statSync(full);
        if (st.size >= 2_000 && st.size <= 8_000_000) {
          acc.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch { /* skip */ }
    }
    if (acc.length > 800) break;
  }
  return acc;
}

let workRoot = null;

function fail(code) {
  // Failure surface: fixed 4 top-level keys only — no body/path/content.
  console.log(JSON.stringify({
    contract_commit: "e26f669e51966efb05a0a23894356e262b897ed6",
    fds_sha256: "0076de46d54705f509082963d91068e9b99cc5740473c5c7ab772fb9fddb1f66",
    records: { accepted: 0, rejected: 1, error_code: code },
    zero_mutation: { ok: false },
  }));
  if (workRoot) {
    try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(2);
}

/** Formal argv: node + cli + --pi-router-root (no PI_ROUTER_ROOT env dependency). */
function adapterCommandJson() {
  return JSON.stringify([process.execPath, adapterCli, "--pi-router-root", piRouterRoot]);
}

/**
 * M5: only parse records=N / source_snapshot_unchanged from the formal
 * run_utc= aggregate line; result=ok from a separate formal result line +
 * cargo exit 0. Never fall back to arbitrary "records=" in failure logs.
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
  return {
    status,
    ok: status === 0 && resultOk,
    formal_conformance_records: formalRecords,
    source_snapshot_unchanged: sourceUnchanged,
  };
}

/** Formal pi-router consumer-authority gate (external adapter CLI). */
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
        // No PI_ROUTER_ROOT — conformance main path is argv --pi-router-root.
      },
      encoding: "utf8",
      timeout: 600_000,
    },
  );
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  return parseFormalConformanceOutput(result.status, combined);
}

/** Sidecar exact RawValue digest cross-check (not a substitute for formal gate). */
function runFlatCorpusCrossCheck(edgeRoot) {
  const cargo = spawnSync(
    "cargo",
    [
      "test",
      "-p",
      "pi_memory_domain",
      "--test",
      "edge_shadow_corpus",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      cwd: piRouterRoot,
      env: {
        ...process.env,
        PI_MEMORY_EDGE_SHADOW_CORPUS: "1",
        PI_MEMORY_EDGE_SHADOW_ROOT: edgeRoot,
      },
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  const out = `${cargo.stdout || ""}\n${cargo.stderr || ""}`;
  const okLine = /edge_shadow_corpus result=ok aggregate_records=(\d+)/.exec(out);
  return {
    status: cargo.status,
    aggregate_records: okLine ? Number(okLine[1]) : 0,
    ok: cargo.status === 0 && okLine !== null,
  };
}

try {
  const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
  const adapter = await jiti.import(
    path.join(root, "extensions/sediment/edge-shadow-frozen-contract-adapter.ts"),
  );
  const edge = await jiti.import(
    path.join(root, "extensions/sediment/edge-protocol-shadow.ts"),
  );

  // ── 1) Contract identity (fail-closed) ─────────────────────────────
  try {
    const identity = adapter.verifyFrozenContractIdentity({
      piRouterRoot,
      require: true,
      checkGitHead: true,
    });
    if (identity.fds_status !== "verified" || identity.pi_router_head_matches_contract !== true) {
      fail("contract_identity_failed");
    }
    adapter.loadFrozenEdgeShadowContract({ piRouterRoot });
  } catch {
    fail("contract_identity_failed");
  }

  // ── 2) Real production session corpus → edge shadow ────────────────
  const files = listSessionFiles(sessionsRoot).sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected = [];
  let turnsCollected = 0;
  for (const f of files) {
    if (selected.length >= TARGET_SESSIONS && turnsCollected >= MIN_TURNS) break;
    const chain = collectMainChainFromSession(f.path);
    if (!chain || chain.terminal_assistant_turns < 1) continue;
    const maxPerSession = Math.max(1, Math.ceil(MIN_TURNS / TARGET_SESSIONS) + 2);
    selected.push({
      source_tag: chain.source_tag,
      chainNodes: chain.chainNodes,
      terminalTurnIndices: chain.terminalTurnIndices.slice(0, maxPerSession),
    });
    turnsCollected += Math.min(chain.terminal_assistant_turns, maxPerSession);
    if (turnsCollected >= MIN_TURNS && selected.length >= Math.min(3, TARGET_SESSIONS)) {
      if (turnsCollected >= MIN_TURNS) break;
    }
  }

  if (turnsCollected < 1 || selected.length < 1) {
    fail("no_production_sessions");
  }

  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-frozen-prod-"));
  const abrainHome = path.join(workRoot, "abrain");
  const ownerRoot = path.join(workRoot, "owner-project");
  fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(ownerRoot, { recursive: true });

  let turnsCaptured = 0;
  let candidates = 0;
  let witnesses = 0;

  for (let si = 0; si < selected.length; si += 1) {
    const sel = selected[si];
    const sessionId = `frozen-prod-${sel.source_tag}-${si}`;
    await edge.initializeEdgeProtocolShadowSession({
      abrainHome,
      ownerProjectRoot: ownerRoot,
      sessionId,
    });

    const messagesSoFar = [];
    let turnIdx = 0;
    for (let ni = 0; ni < sel.chainNodes.length; ni += 1) {
      const node = sel.chainNodes[ni];
      messagesSoFar.push(node.message);
      if (!isTerminalAssistantMessage(node.message)) continue;
      if (!sel.terminalTurnIndices.includes(ni)) continue;

      const c6 = { session_id: sessionId, turn_id: turnIdx };
      const leafTip = {
        id: node.id,
        parentId: node.parentId,
        type: "message",
        timestampUtc: node.timestamp,
      };
      const cap = await edge.captureEdgeProtocolCandidate({
        abrainHome,
        ownerProjectRoot: ownerRoot,
        sessionId,
        messages: messagesSoFar.slice(),
        c6,
        leafTip,
      });
      if (cap.status !== "captured") continue;
      candidates += 1;
      const wit = await edge.writeEdgeTerminalWitness({
        abrainHome,
        ownerProjectRoot: ownerRoot,
        sessionId,
        c6,
        leafTip,
      });
      if (wit.status === "written") witnesses += 1;
      turnsCaptured += 1;
      turnIdx += 1;
      if (turnsCaptured >= MIN_TURNS) break;
    }
    if (turnsCaptured >= MIN_TURNS) break;
  }

  if (candidates < 1 || witnesses < 1 || turnsCaptured < MIN_TURNS) {
    fail("production_capture_insufficient");
  }

  const edgeRoot = edge.edgeProtocolShadowRoot(abrainHome);

  // ── 3) Snapshot before formal gate ─────────────────────────────────
  const snapBefore = adapter.snapshotEdgeRootContentDigest(edgeRoot);

  // ── 4) Local FDS projection aggregate (read-only counts) ───────────
  process.env.PI_ASTACK_EDGE_SHADOW_FROZEN_CONTRACT_ADAPTER = "1";
  if (!adapter.isFrozenContractAdapterEnabled()) {
    fail("adapter_default_off_not_lifted");
  }

  const { aggregate: adapterAgg, projections } = adapter.scanEdgeShadowRootReadOnly(edgeRoot, {
    piRouterRoot,
  });
  const snapAfterLocal = adapter.snapshotEdgeRootContentDigest(edgeRoot);

  const adapterOk =
    adapterAgg.records_projected_ok > 0 &&
    adapterAgg.records_projection_failed === 0 &&
    adapterAgg.filename_seq_mismatch === 0 &&
    adapterAgg.filename_record_id_mismatch === 0 &&
    adapterAgg.identity_shadow_only === adapterAgg.records_projected_ok &&
    adapterAgg.retention_ineligible === adapterAgg.records_projected_ok &&
    adapterAgg.worker_ineligible === adapterAgg.records_projected_ok &&
    adapterAgg.raw_sidecar_present === adapterAgg.records_projected_ok &&
    adapterAgg.raw_sidecar_missing_file === 0 &&
    adapterAgg.raw_sidecar_content_id_mismatch === 0 &&
    adapterAgg.raw_sidecar_byte_length_mismatch === 0 &&
    adapterAgg.raw_sidecar_messages_digest_mismatch === 0 &&
    adapterAgg.raw_sidecar_schema_mismatch === 0 &&
    adapterAgg.rejected_unexpected_record === 0 &&
    adapterAgg.scan_errors === 0 &&
    projections.length === adapterAgg.records_projected_ok &&
    projections.every(
      (p) =>
        p.wire.byteLength > 0 &&
        typeof p.identity.producer_process_identity === "string" &&
        p.identity.producer_process_identity.length > 0 &&
        (p.identity.body === "candidate_capture" || p.identity.body === "terminal_witness"),
    );

  if (!adapterOk) {
    fail("adapter_projection_failed");
  }

  // ── 5) Formal pi-router conformance gate (authoritative) ───────────
  const formal = runFormalAdapterConformance(edgeRoot);
  if (
    !formal.ok ||
    formal.formal_conformance_records !== adapterAgg.records_projected_ok ||
    !formal.source_snapshot_unchanged
  ) {
    fail("formal_adapter_conformance_failed");
  }

  // ── 6) Sidecar flat-root cross-check (not a substitute) ────────────
  const cross = runFlatCorpusCrossCheck(edgeRoot);
  if (!cross.ok || cross.aggregate_records !== adapterAgg.records_projected_ok) {
    fail("flat_corpus_crosscheck_failed");
  }

  // ── 7) Zero mutation proof ─────────────────────────────────────────
  const snapAfterFormal = adapter.snapshotEdgeRootContentDigest(edgeRoot);
  const zeroMutation =
    snapBefore.aggregate_sha256 === snapAfterLocal.aggregate_sha256 &&
    snapAfterLocal.aggregate_sha256 === snapAfterFormal.aggregate_sha256 &&
    snapBefore.file_count === snapAfterFormal.file_count;

  if (!zeroMutation) {
    fail("mutation_detected");
  }

  // Strict accepted surface only.
  const acceptance = {
    contract_commit: adapter.FROZEN_MEMORY_CONTRACT_COMMIT,
    fds_sha256: adapter.FROZEN_MEMORY_FDS_SHA256,
    records: {
      seen: adapterAgg.records_seen,
      projected_ok: adapterAgg.records_projected_ok,
      candidate_capture: adapterAgg.candidate_capture,
      terminal_witness: adapterAgg.terminal_witness,
      identity_shadow_only: adapterAgg.identity_shadow_only,
      retention_ineligible: adapterAgg.retention_ineligible,
      worker_ineligible: adapterAgg.worker_ineligible,
      formal_conformance_records: formal.formal_conformance_records,
      sidecar_crosscheck_records: cross.aggregate_records,
      turns_captured: turnsCaptured,
    },
    zero_mutation: {
      ok: true,
      file_count: snapBefore.file_count,
      proof_digest: snapBefore.aggregate_sha256,
    },
  };
  console.log(JSON.stringify(acceptance, null, 2));
} catch {
  fail("unexpected_error");
} finally {
  if (workRoot) {
    try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

process.exit(0);
