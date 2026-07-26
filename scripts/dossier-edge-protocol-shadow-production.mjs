#!/usr/bin/env node
/**
 * Production acceptance dossier for ADR 0044 Pi-side capture-only edge
 * protocol shadow — v3 real-session multi-turn lifecycle.
 *
 * Hard gates (any miss → not_accepted exit 2):
 * - agent_end handler total latency: each round + aggregate p99 < 100ms
 * - agent_settled witness latency: each round + aggregate p99 < 100ms
 * - per-turn precise integrity for same-session multi-turn (current C6 /
 *   current leaf / current source; witness exact refs; producer_seq mono +
 *   candidate/witness adjacent; filename/JCS/source digest/intake exact)
 *
 * Method (v3):
 * - Fresh Node process
 * - Real Pi session JSONL under ~/.pi/agent/sessions
 * - Per real session: one main chain (prefer latest *terminal* assistant
 *   leaf where stopReason !== 'toolUse'; walk id/parentId). toolUse
 *   assistants are mid-loop tool calls, not agent_end. If the active
 *   branch tip is still toolUse with no terminal leaf, skip the session
 *   (never fabricate). Never rewrite message bodies; never fixture/pad.
 * - Collect multi-session until >= MIN_BRANCHES terminal assistant turns;
 *   try >=10 distinct sessions (report actual if production data is thinner)
 * - Per round / per selected session: header-only SessionManager once,
 *   real session_start (edge layout init — not timed as end gate),
 *   appendMessage real messages in chain order; fire before_agent_start
 *   once per complete run (after first user, or before terminal if no
 *   active run); at each terminal assistant node fire timed agent_end +
 *   timed agent_settled. Never fire before/end on toolUse assistants.
 * - Precise truncation only on natural terminal-assistant turn boundaries
 * - PI_ASTACK_ENABLE_TEST_HOOKS=1 only replaces semantic runner with
 *   immediate no-op; capture/IO paths remain production
 * - Default 3 rounds; end/witness p99 < 100 hard gate unchanged
 *
 * Never prints message bodies or absolute user paths.
 * Output is a pure JSON summary (no raw/path). Evidence file is written
 * by the main session after a real run — this script does not claim archive.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  collectMainChainFromSession,
  isTerminalAssistantMessage,
} from "./edge-protocol-shadow-chain.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const DOSSIER_VERSION = "edge-protocol-shadow-production-dossier/v3";
const MIN_BRANCHES = Number(process.env.EDGE_SHADOW_MIN_CAPTURES || 100);
const ROUNDS = Math.max(1, Number(process.env.EDGE_SHADOW_ROUNDS || 3));
const P99_TARGET_MS = Number(process.env.EDGE_SHADOW_P99_TARGET_MS || 100);
const TARGET_SESSIONS = Math.max(1, Number(process.env.EDGE_SHADOW_TARGET_SESSIONS || 10));
const sessionsRoot = process.env.PI_SESSIONS_DIR
  ? path.resolve(process.env.PI_SESSIONS_DIR)
  : path.join(os.homedir(), ".pi", "agent", "sessions");
const abrainHomeProd = process.env.ABRAIN_ROOT_HOST
  ? path.resolve(process.env.ABRAIN_ROOT_HOST.replace(/^~(?=$|[/\\])/, os.homedir()))
  : path.join(os.homedir(), ".abrain");

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function redactPath(p) {
  if (!p) return "none";
  const norm = p.replace(/\\/g, "/");
  if (/(^|\/)sessions(\/|$)/.test(norm)) return "pi_session_jsonl";
  if (/(^|\/)\.abrain(\/|$)/.test(norm)) return "abrain_state";
  return "other_local";
}

function metricsOf(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Number(percentile(sorted, 50)?.toFixed(3)),
    p95: Number(percentile(sorted, 95)?.toFixed(3)),
    p99: Number(percentile(sorted, 99)?.toFixed(3)),
    max: Number(sorted[sorted.length - 1]?.toFixed(3)),
  };
}

function gitShortHash() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function gitWorktreeDirty() {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return status.length > 0;
  } catch {
    return true;
  }
}

/** Files whose on-disk bytes define this Pi-side edge-protocol-shadow slice. */
const IMPLEMENTATION_SOURCE_RELATIVE_PATHS = [
  "extensions/_shared/durable-write.ts",
  "extensions/sediment/agent-end-queue.ts",
  "extensions/sediment/edge-protocol-shadow.ts",
  "extensions/sediment/index.ts",
  "extensions/sediment/intake.ts",
  "extensions/sediment/settings.ts",
  "package.json",
  "pi-astack-settings.schema.json",
  "scripts/dossier-edge-protocol-shadow-production.mjs",
  "scripts/edge-protocol-shadow-chain.mjs",
];

/**
 * Stable sha256 over implementation sources for this slice.
 * For each relative path in sorted order: path + NUL + file bytes + NUL.
 * Includes this script's own content (self-hashing); no absolute paths/raw in report.
 */
function implementationSourceDigest() {
  const sorted = [...IMPLEMENTATION_SOURCE_RELATIVE_PATHS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const rel of sorted) {
    const bytes = fs.readFileSync(path.join(root, rel));
    h.update(rel, "utf8");
    h.update("\0");
    h.update(bytes);
    h.update("\0");
  }
  return {
    algorithm: "sha256",
    digest: h.digest("hex"),
    file_count: sorted.length,
  };
}

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

async function fire(handlers, name, event, ctx) {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

/** Header-only session file; SessionManager opens and appendMessage advances leaf. */
function writeHeaderOnlySession(sessionsDir, sessionId, cwd) {
  const file = path.join(sessionsDir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-07-24T12:00:00.000Z",
    cwd,
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
  return file;
}

function findEdgeSessionRoot(abrainHome, sessionId) {
  const byOwner = path.join(
    path.resolve(abrainHome),
    ".state",
    "sediment",
    "edge-protocol-shadow",
    "by-owner",
  );
  if (!fs.existsSync(byOwner)) return null;
  for (const ownerKey of fs.readdirSync(byOwner)) {
    const sess = path.join(byOwner, ownerKey, "sessions", sessionId);
    if (fs.existsSync(sess)) return sess;
  }
  return null;
}

function recordNameOf(record) {
  return `${String(record.producer_seq).padStart(20, "0")}__${record.record_id}.json`;
}

/**
 * Exact current-turn intake: pending or acked must match session +
 * anchor.turn_id == expectedTurnId + branchTip.id == live leaf.
 * Uses public list/read for pending; acked via public ackedDir + windowId
 * recompute. Never returns path/raw.
 */
async function hasExactCurrentIntakeWindow(intake, abrainTmp, sessionId, expectedTurnId, liveLeafId) {
  if (!sessionId || liveLeafId == null || liveLeafId === "") return false;

  const match = (rec) => {
    if (!rec || rec.sessionId !== sessionId) return false;
    if (String(rec.anchor?.turn_id) !== String(expectedTurnId)) return false;
    if (rec.branchTip?.id !== liveLeafId) return false;
    return true;
  };

  try {
    const pending = await intake.listSedimentIntakePendingForSession(abrainTmp, sessionId);
    for (const item of pending) {
      let rec = null;
      try {
        rec = await intake.readSedimentIntakeRecord(abrainTmp, item.windowId);
      } catch {
        continue;
      }
      if (match(rec)) return true;
    }
  } catch {
    // fall through to acked scan
  }

  try {
    const ackedDir = intake.sedimentIntakeAckedDir(abrainTmp);
    if (!fs.existsSync(ackedDir)) return false;
    for (const name of fs.readdirSync(ackedDir)) {
      if (!name.endsWith(".json")) continue;
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(ackedDir, name), "utf8"));
      } catch {
        continue;
      }
      if (!match(rec)) continue;
      // Validate identity via public windowId recompute (no raw/path out).
      try {
        const expectedId = intake.computeSedimentIntakeWindowId({
          sessionId: rec.sessionId,
          sessionFile: rec.sessionFile,
          cwd: rec.cwd,
          sourceProjectRoot: rec.sourceProjectRoot,
          branchTip: rec.branchTip,
          anchor: rec.anchor,
          captureBoundary: rec.captureBoundary,
        });
        if (rec.windowId === expectedId) return true;
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Precise per-turn integrity for same-session multi-turn.
 * Selects current C6 candidate (not previous-turn C6) and requires
 * witness exact refs + strict longitudinal producer_seq adjacency:
 *   first candidate seq=1; subsequent cand = previousWitnessSeq+1;
 *   current witness = cand+1. No relaxation for intervening records.
 * Returns currentWitnessSeq for the driver. Never logs path/raw.
 */
function verifyTurnIntegrity(args) {
  const {
    edge,
    intake,
    abrainTmp,
    sessionId,
    sessionRoot,
    sm,
    expectedTurnId,
    expectedMessageCount,
    previousWitnessSeq = 0,
    afterWitness = false,
  } = args;
  const codes = [];
  const checks = {
    source_path: false,
    source_envelope: false,
    source_digest: false,
    candidate_filename: false,
    candidate_record_id: false,
    candidate_leaf_tip: false,
    candidate_c6: false,
    longitudinal_seq: false,
    seq_monotonic_adjacent: !afterWitness ? null : false,
    witness_ref: !afterWitness ? null : false,
    witness_filename: !afterWitness ? null : false,
    witness_record_id: !afterWitness ? null : false,
    witness_capabilities: !afterWitness ? null : false,
    intake_window: false,
  };
  let currentWitnessSeq = null;

  return {
    codes,
    checks,
    run: async () => {
      let records = [];
      try {
        records = await edge.listEdgeJournalRecords(sessionRoot);
      } catch {
        records = [];
      }
      const cands = records.filter((r) => r.record_type === "candidate_capture");
      // Current C6 only — never pick previous turn's candidate as "latest overall".
      const candsForC6 = cands.filter((r) =>
        r.c6?.session_id === sessionId
        && String(r.c6?.turn_id) === String(expectedTurnId),
      );
      if (candsForC6.length < 1) {
        codes.push("missing_candidate_for_current_c6");
        return finalize();
      }
      // Highest producer_seq among current-C6 candidates.
      const cand = candsForC6.reduce((a, b) => (a.producer_seq > b.producer_seq ? a : b));

      // Longitudinal seq: session_start has no records; first cand must be 1;
      // later cand must be previousWitnessSeq+1. Strict — no intervening-record relaxation.
      if (typeof cand.producer_seq !== "number") {
        codes.push("producer_seq_missing");
      } else if (!previousWitnessSeq || previousWitnessSeq === 0) {
        if (cand.producer_seq !== 1) {
          codes.push("first_candidate_seq_not_1");
        } else {
          checks.longitudinal_seq = true;
        }
      } else if (cand.producer_seq !== previousWitnessSeq + 1) {
        codes.push("candidate_seq_not_previous_witness_plus_1");
      } else {
        checks.longitudinal_seq = true;
      }

      const rel = cand.source_ref?.relative_path;
      const resolved = edge.resolveEdgeSourcePathWithinSession(sessionRoot, rel ?? "");
      if (!resolved.ok) {
        codes.push(resolved.error_code || "source_path_escape");
      } else {
        try {
          if (!fs.existsSync(resolved.absolutePath) || !fs.statSync(resolved.absolutePath).isFile()) {
            codes.push("source_file_missing");
          } else {
            checks.source_path = true;
            let envelope;
            try {
              envelope = JSON.parse(fs.readFileSync(resolved.absolutePath, "utf8"));
            } catch {
              codes.push("source_envelope_unreadable");
              envelope = null;
            }
            if (envelope) {
              const schemaOk = envelope.schema === edge.EDGE_SOURCE_SCHEMA || envelope.schema === "pi-astack/edge-source/v1";
              const contentId = envelope.content_id;
              const sessionOk = envelope.session_id === sessionId;
              const msgCount = envelope.message_count;
              const messages = envelope.messages;
              const countOk = Array.isArray(messages)
                ? msgCount === messages.length
                : typeof msgCount === "number";
              const expectedCountOk = typeof expectedMessageCount === "number"
                ? msgCount === expectedMessageCount
                : true;
              if (!schemaOk) codes.push("source_schema_mismatch");
              if (!sessionOk) codes.push("source_session_mismatch");
              if (!countOk) codes.push("source_message_count_mismatch");
              if (!expectedCountOk) codes.push("source_message_count_not_current_leaf");
              if (typeof contentId !== "string" || !/^[0-9a-f]{64}$/.test(contentId)) {
                codes.push("source_content_id_invalid");
              }
              if (schemaOk && sessionOk && countOk && expectedCountOk && typeof contentId === "string") {
                checks.source_envelope = true;
                const recomputed = createHash("sha256")
                  .update(JSON.stringify(messages), "utf8")
                  .digest("hex");
                if (recomputed !== contentId) codes.push("source_content_id_digest_mismatch");
                if (recomputed !== cand.payload_digest) codes.push("source_payload_digest_mismatch");
                if (contentId !== cand.source_ref?.content_id) codes.push("source_ref_content_id_mismatch");
                if (recomputed === contentId && recomputed === cand.payload_digest) {
                  checks.source_digest = true;
                }
              }
            }
          }
        } catch {
          codes.push("source_path_stat_failed");
        }
      }

      const recordsDir = edge.edgeJournalRecordsDir(sessionRoot);
      try {
        const expectedName = recordNameOf(cand);
        if (fs.existsSync(path.join(recordsDir, expectedName))) {
          const p = edge.parseEdgeRecordFilename(expectedName);
          if (p && p.producerSeq === cand.producer_seq && p.recordId === cand.record_id) {
            checks.candidate_filename = true;
          } else {
            codes.push("candidate_filename_mismatch");
          }
        } else {
          codes.push("candidate_filename_mismatch");
        }
      } catch {
        codes.push("candidate_filename_scan_failed");
      }

      try {
        const recomputedId = edge.recomputeEdgeJournalRecordId(cand);
        if (recomputedId !== cand.record_id) codes.push("candidate_record_id_jcs_mismatch");
        else checks.candidate_record_id = true;
      } catch {
        codes.push("candidate_record_id_recompute_failed");
      }

      let liveLeafId = null;
      try {
        liveLeafId = typeof sm.getLeafId === "function" ? sm.getLeafId() : null;
      } catch {
        liveLeafId = null;
      }
      if (!cand.leaf_tip || typeof cand.leaf_tip.id !== "string") {
        codes.push("missing_capture_leaf_tip");
      } else if (!liveLeafId) {
        codes.push("live_leaf_unavailable");
      } else if (cand.leaf_tip.id !== liveLeafId) {
        codes.push("leaf_tip_mismatch");
      } else {
        checks.candidate_leaf_tip = true;
      }

      if (cand.c6?.session_id !== sessionId) codes.push("c6_session_drift");
      else if (cand.session_id !== sessionId) codes.push("record_session_drift");
      else if (String(cand.c6?.turn_id) !== String(expectedTurnId)) codes.push("c6_turn_mismatch");
      else checks.candidate_c6 = true;

      if (afterWitness) {
        const witsForC6 = records.filter((r) =>
          r.record_type === "terminal_witness"
          && r.c6?.session_id === sessionId
          && String(r.c6?.turn_id) === String(expectedTurnId),
        );
        if (witsForC6.length < 1) {
          codes.push("missing_witness_for_current_c6");
        } else {
          const wit = witsForC6.reduce((a, b) => (a.producer_seq > b.producer_seq ? a : b));
          currentWitnessSeq = typeof wit.producer_seq === "number" ? wit.producer_seq : null;
          if (wit.candidate_ref?.record_id !== cand.record_id) {
            codes.push("witness_candidate_ref_record_id_mismatch");
          }
          if (wit.candidate_ref?.producer_seq !== cand.producer_seq) {
            codes.push("witness_candidate_ref_seq_mismatch");
          }
          if (wit.candidate_ref?.payload_digest !== cand.payload_digest) {
            codes.push("witness_candidate_ref_digest_mismatch");
          }
          const wSrc = wit.source_ref;
          const cSrc = cand.source_ref;
          if (!wSrc || !cSrc
            || wSrc.content_id !== cSrc.content_id
            || wSrc.relative_path !== cSrc.relative_path
            || wSrc.byte_length !== cSrc.byte_length) {
            codes.push("witness_source_ref_mismatch");
          }
          if (wit.capabilities?.terminal_seal !== false) {
            codes.push("witness_terminal_seal_claimed");
          }
          if (wit.settlement_status !== "unsupported_core_capability"
            && wit.settlement_status !== "capture_only") {
            codes.push("witness_settlement_status_invalid");
          }
          if (wit.settlement_status === "unsupported_core_capability"
            && wit.capabilities?.terminal_seal === false
            && wit.candidate_ref?.record_id === cand.record_id
            && wit.candidate_ref?.producer_seq === cand.producer_seq
            && wSrc?.content_id === cSrc?.content_id) {
            checks.witness_ref = true;
            checks.witness_capabilities = true;
          } else {
            if (wit.capabilities?.terminal_seal === false
              && (wit.settlement_status === "unsupported_core_capability" || wit.settlement_status === "capture_only")) {
              checks.witness_capabilities = true;
            }
            if (wit.candidate_ref?.record_id === cand.record_id
              && wit.candidate_ref?.producer_seq === cand.producer_seq
              && wSrc?.content_id === cSrc?.content_id) {
              checks.witness_ref = true;
            }
          }

          // Strict adjacency: witness must be candidate+1. No relaxation.
          if (typeof cand.producer_seq === "number" && typeof wit.producer_seq === "number") {
            if (wit.producer_seq !== cand.producer_seq + 1) {
              if (wit.producer_seq <= cand.producer_seq) {
                codes.push("producer_seq_not_monotonic");
              } else {
                codes.push("candidate_witness_not_adjacent");
              }
            } else {
              checks.seq_monotonic_adjacent = true;
            }
          } else {
            codes.push("producer_seq_missing");
          }

          try {
            const expectedWitName = recordNameOf(wit);
            const witPath = path.join(recordsDir, expectedWitName);
            if (!fs.existsSync(witPath)) {
              codes.push("witness_filename_missing");
            } else {
              const p = edge.parseEdgeRecordFilename(expectedWitName);
              if (!p || p.producerSeq !== wit.producer_seq || p.recordId !== wit.record_id) {
                codes.push("witness_filename_fields_mismatch");
              } else {
                checks.witness_filename = true;
              }
            }
          } catch {
            codes.push("witness_filename_scan_failed");
          }

          try {
            const recomputedWit = edge.recomputeEdgeJournalRecordId(wit);
            if (recomputedWit !== wit.record_id) codes.push("witness_record_id_jcs_mismatch");
            else checks.witness_record_id = true;
          } catch {
            codes.push("witness_record_id_recompute_failed");
          }
        }
      }

      // Exact current-turn intake — previous-turn window must not satisfy.
      try {
        const exact = await hasExactCurrentIntakeWindow(
          intake,
          abrainTmp,
          sessionId,
          expectedTurnId,
          liveLeafId,
        );
        if (exact) checks.intake_window = true;
        else codes.push("missing_exact_current_intake_window");
      } catch {
        codes.push("intake_list_failed");
      }

      return finalize();
    },
  };

  function finalize() {
    const ok = codes.length === 0
      && checks.source_path
      && checks.source_envelope
      && checks.source_digest
      && checks.candidate_filename
      && checks.candidate_record_id
      && checks.candidate_leaf_tip
      && checks.candidate_c6
      && checks.longitudinal_seq
      && checks.intake_window
      && (!afterWitness || (
        checks.witness_ref
        && checks.witness_filename
        && checks.witness_record_id
        && checks.witness_capabilities
        && checks.seq_monotonic_adjacent
      ));
    return {
      ok,
      codes: [...new Set(codes)],
      checks,
      currentWitnessSeq,
    };
  }
}

// ── collect real multi-session main chains ────────────────────────────
const sessionFiles = listSessionFiles(sessionsRoot);
sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

const selectedSessions = [];
let totalAssistantTurns = 0;
const seenChainDigests = new Set();
for (const sf of sessionFiles) {
  // Prefer diversity: keep collecting until MIN turns AND target sessions,
  // or until turns hit 3× MIN (enough budget without over-scanning).
  if (totalAssistantTurns >= MIN_BRANCHES && selectedSessions.length >= TARGET_SESSIONS) break;
  if (totalAssistantTurns >= MIN_BRANCHES * 3) break;
  const chain = collectMainChainFromSession(sf.path);
  if (!chain) continue;
  const digest = createHash("sha256")
    .update(JSON.stringify(chain.chainNodes.map((n) => n.message)), "utf8")
    .digest("hex");
  if (seenChainDigests.has(digest)) continue;
  seenChainDigests.add(digest);
  selectedSessions.push(chain);
  totalAssistantTurns += chain.assistant_turns;
}

const shortHash = gitShortHash();
const report = {
  method: "production_edge_full_handler_real_session_multiturn_v3",
  version: DOSSIER_VERSION,
  generated_at_utc: new Date().toISOString(),
  git: {
    short_hash: shortHash || null,
    worktree_dirty: gitWorktreeDirty(),
  },
  implementation_source_digest: implementationSourceDigest(),
  protocol: "capture-only protocol shadow",
  acceptance_scope: "awaited_agent_end_and_agent_settled_handlers",
  acceptance_scope_note:
    "Measures real sediment agent_end (local intake durable write + edge source/candidate) and agent_settled witness. Both are hard p99 gates. session_start runs real edge layout init (reported separately; not a <100ms gate). Stage A still incomplete. Evidence archive is main-session responsibility.",
  stage_a_complete: false,
  chain_reconstruction: "pi_jsonl_latest_terminal_assistant_leaf_id_parentId_main_chain_multiturn",
  terminal_assistant_definition: "assistant && stopReason !== 'toolUse' (stop/length/error/aborted/missing)",
  input: {
    sessions_root_category: redactPath(sessionsRoot),
    session_files_considered: sessionFiles.length,
    distinct_sessions: selectedSessions.length,
    total_terminal_assistant_turns_collected: totalAssistantTurns,
    min_turns_required: MIN_BRANCHES,
    target_sessions: TARGET_SESSIONS,
    rounds: ROUNDS,
    p99_target_ms: P99_TARGET_MS,
    abrain_home_category: redactPath(abrainHomeProd),
  },
  result: "pending",
  component_diagnostic_note:
    "Component-only capture timings are not acceptance criteria; full handler path is.",
};

if (totalAssistantTurns < MIN_BRANCHES) {
  report.result = "not_accepted";
  report.reason = `insufficient_real_samples: collected ${totalAssistantTurns} terminal assistant turns < ${MIN_BRANCHES}`;
  report.note = "Fixture substitution and artificial window slicing are forbidden for this dossier. toolUse mid-loop assistants do not count as agent_end turns.";
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}

// Same filesystem as real ~/.abrain (not /tmp PVC).
const stateRoot = path.join(abrainHomeProd, ".state");
fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
const workRoot = fs.mkdtempSync(path.join(stateRoot, "edge-handler-dossier-"));
fs.chmodSync(workRoot, 0o700);
const abrainTmp = path.join(workRoot, "abrain");
const ownerTmp = path.join(workRoot, "owner");
const sessionsDir = path.join(workRoot, "sessions");
const settingsPath = path.join(workRoot, "settings.json");
fs.mkdirSync(abrainTmp, { recursive: true, mode: 0o700 });
fs.mkdirSync(ownerTmp, { recursive: true, mode: 0o700 });
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
// Make ownerTmp a git root so capture owner identity stays under the temp tree.
fs.mkdirSync(path.join(ownerTmp, ".git"), { recursive: true, mode: 0o700 });
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
process.env.ABRAIN_ROOT = abrainTmp;
delete process.env.PI_ASTACK_EDGE_PROTOCOL_SHADOW;

const jiti = createJiti(import.meta.url, { interopDefault: true });
const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
const edge = await jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));
const intake = await jiti.import(path.join(root, "extensions/sediment/intake.ts"));

const pi = fakePi();
const activate = sediment.default ?? sediment;
activate(pi.api);
// Replace semantic runner only; capture/IO remain production paths.
sediment._setSedimentAgentEndTestHooksForTests({ run: async () => {} });

const roundReports = [];
const allAgentEndMs = [];
const allWitnessMs = [];
const allSessionStartMs = [];
const allPayloadBytes = [];
let integrityOk = true;
const failureCodeCounts = Object.create(null);
let checksTotal = 0;
let checksFailed = 0;
let turnsChecked = 0;
let turnsFailed = 0;
let journalMaxSeq = 0;

function noteCodes(codes) {
  for (const c of codes) {
    failureCodeCounts[c] = (failureCodeCounts[c] || 0) + 1;
  }
}

function countChecks(checks) {
  let total = 0;
  let failed = 0;
  for (const v of Object.values(checks)) {
    if (v === null || v === undefined) continue;
    total += 1;
    if (v !== true) failed += 1;
  }
  return { total, failed };
}

/**
 * Drive one real session main chain multi-turn until budget exhausted or chain ends.
 * Lifecycle: before_agent_start once per complete run (after first user, or
 * before terminal when no active run). toolUse assistants are mid-loop only.
 * Truncation only at natural terminal-assistant turn boundaries.
 */
async function driveSessionMultiTurn(args) {
  const {
    chain,
    round,
    sessionOrdinal,
    turnsBudget,
    agentEndMs,
    witnessMs,
    sessionStartMs,
  } = args;
  const sessionId = `dossier-r${round}-s${sessionOrdinal}`;
  const sessionFile = writeHeaderOnlySession(sessionsDir, sessionId, ownerTmp);
  const sm = SessionManager.open(sessionFile, sessionsDir, ownerTmp);
  const ctx = {
    mode: "tui",
    cwd: ownerTmp,
    sessionManager: sm,
    modelRegistry: undefined,
    ui: { notify() {}, setStatus() {} },
  };

  // Real session_start (edge layout init). Not an end/settled hard gate.
  const ss0 = performance.now();
  await fire(pi.handlers, "session_start", { reason: "startup" }, ctx);
  const ssMs = performance.now() - ss0;
  sessionStartMs.push(ssMs);
  allSessionStartMs.push(ssMs);

  // Assert edge layout was created by real init (not script mkdir).
  const layoutRoot = findEdgeSessionRoot(abrainTmp, sessionId)
    ?? edge.edgeSessionRoot(abrainTmp, ownerTmp, sessionId);
  if (!fs.existsSync(edge.edgeJournalRecordsDir(layoutRoot))) {
    integrityOk = false;
    noteCodes(["session_start_layout_missing"]);
  }

  const messagesSoFar = [];
  let turnsDone = 0;
  let turnOk = 0;
  let turnFail = 0;
  let pinOnly = 0;
  let terminalOrdinal = 0; // matches binder C6 turn_id (0-based after before_agent_start)
  let runActive = false;
  let previousWitnessSeq = 0; // session_start has no records; first cand must be 1

  for (let i = 0; i < chain.chainNodes.length; i += 1) {
    const node = chain.chainNodes[i];
    const msg = node.message;
    const isTerminal = isTerminalAssistantMessage(msg);
    const isUser = msg?.role === "user";

    // Continuation / incomplete history: terminal arrives with no active run.
    if (isTerminal && !runActive) {
      await fire(pi.handlers, "before_agent_start", { systemPrompt: "" }, ctx);
      runActive = true;
    }

    // Preserve original message body exactly.
    sm.appendMessage(msg);
    messagesSoFar.push(msg);

    // First user of a run: fire before_agent_start once after that user.
    if (isUser && !runActive) {
      await fire(pi.handlers, "before_agent_start", { systemPrompt: "" }, ctx);
      runActive = true;
      continue;
    }

    // toolUse / toolResult / non-terminal: append only (no before/end).
    if (!isTerminal) continue;

    // Natural agent_end turn boundary = terminal assistant only.
    const payloadBytes = Buffer.byteLength(JSON.stringify(messagesSoFar), "utf8");
    allPayloadBytes.push(payloadBytes);

    const t0 = performance.now();
    await fire(pi.handlers, "agent_end", { messages: messagesSoFar.slice() }, ctx);
    const endMs = performance.now() - t0;
    agentEndMs.push(endMs);
    allAgentEndMs.push(endMs);

    const sessionRoot = findEdgeSessionRoot(abrainTmp, sessionId)
      ?? edge.edgeSessionRoot(abrainTmp, ownerTmp, sessionId);

    const expectedTurnId = terminalOrdinal;

    const tw0 = performance.now();
    await fire(pi.handlers, "agent_settled", {}, ctx);
    const settledMs = performance.now() - tw0;
    witnessMs.push(settledMs);
    allWitnessMs.push(settledMs);

    // Drain controllable queue outside acceptance timing.
    await sediment._waitForAutoWriteIdleForTests();

    const post = verifyTurnIntegrity({
      edge,
      intake,
      abrainTmp,
      sessionId,
      sessionRoot,
      sm,
      expectedTurnId,
      expectedMessageCount: messagesSoFar.length,
      previousWitnessSeq,
      afterWitness: true,
    });
    const postResult = await post.run();
    if (typeof postResult.currentWitnessSeq === "number") {
      previousWitnessSeq = postResult.currentWitnessSeq;
    }

    // Track journal max seq.
    try {
      const recs = await edge.listEdgeJournalRecords(sessionRoot);
      for (const r of recs) {
        if (typeof r.producer_seq === "number" && r.producer_seq > journalMaxSeq) {
          journalMaxSeq = r.producer_seq;
        }
      }
      const cands = recs.filter((r) => r.record_type === "candidate_capture");
      const latest = cands[cands.length - 1];
      if (latest && !latest.source_ref) pinOnly += 1;
    } catch { /* ignore */ }

    turnsChecked += 1;
    turnsDone += 1;
    terminalOrdinal += 1;
    runActive = false; // complete run settled
    const { total, failed } = countChecks(postResult.checks);
    checksTotal += total;
    checksFailed += failed;
    if (!postResult.ok) {
      turnsFailed += 1;
      turnFail += 1;
      integrityOk = false;
      noteCodes(postResult.codes);
    } else {
      turnOk += 1;
    }

    if (turnsDone >= turnsBudget) break; // natural terminal-assistant boundary stop
  }

  return { turnsDone, turnOk, turnFail, pinOnly, sessionId };
}

try {
  // Warmup: first durable layout create + JIT must not dominate p99.
  // Same terminal-assistant / once-per-run before_agent_start rules.
  {
    const warm = selectedSessions[0];
    const warmSid = "dossier-warmup";
    const warmFile = writeHeaderOnlySession(sessionsDir, warmSid, ownerTmp);
    const warmSm = SessionManager.open(warmFile, sessionsDir, ownerTmp);
    const warmCtx = {
      mode: "tui",
      cwd: ownerTmp,
      sessionManager: warmSm,
      modelRegistry: undefined,
      ui: { notify() {}, setStatus() {} },
    };
    await fire(pi.handlers, "session_start", { reason: "startup" }, warmCtx);
    const msgs = [];
    let warmActive = false;
    for (const node of warm.chainNodes) {
      const msg = node.message;
      const isTerminal = isTerminalAssistantMessage(msg);
      const isUser = msg?.role === "user";
      if (isTerminal && !warmActive) {
        await fire(pi.handlers, "before_agent_start", { systemPrompt: "" }, warmCtx);
        warmActive = true;
      }
      warmSm.appendMessage(msg);
      msgs.push(msg);
      if (isUser && !warmActive) {
        await fire(pi.handlers, "before_agent_start", { systemPrompt: "" }, warmCtx);
        warmActive = true;
        continue;
      }
      if (!isTerminal) continue;
      await fire(pi.handlers, "agent_end", { messages: msgs.slice() }, warmCtx);
      await fire(pi.handlers, "agent_settled", {}, warmCtx);
      await sediment._waitForAutoWriteIdleForTests();
      break;
    }
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    const agentEndMs = [];
    const witnessMs = [];
    const sessionStartMs = [];
    let turnOk = 0;
    let turnFail = 0;
    let pinOnly = 0;
    let turnsBudget = MIN_BRANCHES;
    let turnsThisRound = 0;
    let sessionsUsed = 0;

    for (let s = 0; s < selectedSessions.length && turnsThisRound < MIN_BRANCHES; s += 1) {
      const remaining = MIN_BRANCHES - turnsThisRound;
      const result = await driveSessionMultiTurn({
        chain: selectedSessions[s],
        round,
        sessionOrdinal: s,
        turnsBudget: remaining,
        agentEndMs,
        witnessMs,
        sessionStartMs,
      });
      turnsThisRound += result.turnsDone;
      turnOk += result.turnOk;
      turnFail += result.turnFail;
      pinOnly += result.pinOnly;
      sessionsUsed += 1;
    }

    const m = metricsOf(agentEndMs);
    const wm = metricsOf(witnessMs);
    const ssm = metricsOf(sessionStartMs);
    const agentEndP99Ok = m.p99 != null && m.p99 < P99_TARGET_MS;
    const witnessP99Ok = wm.p99 != null && wm.p99 < P99_TARGET_MS;
    const roundIntegrity = turnFail === 0 && pinOnly === 0 && turnsThisRound >= MIN_BRANCHES;
    if (!roundIntegrity) integrityOk = false;
    if (turnsThisRound < MIN_BRANCHES) {
      integrityOk = false;
      noteCodes(["insufficient_turns_in_round"]);
    }

    roundReports.push({
      round: round + 1,
      turns: turnsThisRound,
      distinct_sessions: sessionsUsed,
      agent_end_ms: m,
      witness_ms: wm,
      session_start_ms: ssm,
      turns_ok: turnOk,
      turns_failed: turnFail,
      pin_only: pinOnly,
      agent_end_p99_ok: agentEndP99Ok,
      witness_p99_ok: witnessP99Ok,
      integrity_ok: roundIntegrity,
    });
  }

  const aggregate = metricsOf(allAgentEndMs);
  const witnessAggregate = metricsOf(allWitnessMs);
  const sessionStartAggregate = metricsOf(allSessionStartMs);
  const agentEndAggregateP99Ok = aggregate.p99 != null && aggregate.p99 < P99_TARGET_MS;
  const witnessAggregateP99Ok = witnessAggregate.p99 != null && witnessAggregate.p99 < P99_TARGET_MS;
  const agentEndAllRoundsOk = roundReports.every((r) => r.agent_end_p99_ok);
  const witnessAllRoundsOk = roundReports.every((r) => r.witness_p99_ok);

  const payloadSorted = [...allPayloadBytes].sort((a, b) => a - b);
  const payloadBytes = {
    samples: payloadSorted.length,
    min: payloadSorted[0] ?? 0,
    p50: percentile(payloadSorted, 50),
    p95: percentile(payloadSorted, 95),
    p99: percentile(payloadSorted, 99),
    max: payloadSorted[payloadSorted.length - 1] ?? 0,
    total: allPayloadBytes.reduce((a, b) => a + b, 0),
  };

  report.rounds = roundReports;
  report.aggregate = {
    agent_end: {
      ...aggregate,
      p99_target_ms: P99_TARGET_MS,
      p99_meets_target: agentEndAggregateP99Ok && agentEndAllRoundsOk,
      all_rounds_ok: agentEndAllRoundsOk,
    },
    witness_settled: {
      ...witnessAggregate,
      p99_target_ms: P99_TARGET_MS,
      p99_meets_target: witnessAggregateP99Ok && witnessAllRoundsOk,
      all_rounds_ok: witnessAllRoundsOk,
    },
    session_start_layout_init: {
      ...sessionStartAggregate,
      note: "real edge layout init; reported only; not a <100ms hard gate",
    },
    total_handler_samples: allAgentEndMs.length,
    distinct_sessions: selectedSessions.length,
    turns_per_round_target: MIN_BRANCHES,
    journal_max_seq: journalMaxSeq,
  };
  report.payload_bytes = payloadBytes;
  report.integrity = {
    complete: integrityOk,
    turns_checked: turnsChecked,
    turns_failed: turnsFailed,
    checks_total: checksTotal,
    checks_failed: checksFailed,
    failure_codes: failureCodeCounts,
    no_pin_only: roundReports.every((r) => r.pin_only === 0),
  };
  report.capabilities = edge.EDGE_PROTOCOL_SHADOW_CAPABILITIES;
  report.deferred = ["session_transaction", "launch_broker", "terminal_seal", "link_open_close", "stage_a"];

  delete report.workRoot;
  delete report.abrainTmp;

  if (!integrityOk) {
    report.result = "not_accepted";
    report.reason = "integrity_failure";
  } else if (!agentEndAggregateP99Ok || !agentEndAllRoundsOk) {
    report.result = "not_accepted";
    report.reason = "agent_end_latency_target_miss";
    report.latency_note = `agent_end p99 aggregate=${aggregate.p99}ms target=${P99_TARGET_MS}ms; all_rounds_ok=${agentEndAllRoundsOk}`;
  } else if (!witnessAggregateP99Ok || !witnessAllRoundsOk) {
    report.result = "not_accepted";
    report.reason = "witness_latency_target_miss";
    report.latency_note = `witness p99 aggregate=${witnessAggregate.p99}ms target=${P99_TARGET_MS}ms; all_rounds_ok=${witnessAllRoundsOk}`;
  } else {
    report.result = "accepted";
    report.pi_side_slice_production_acceptance = "passed";
    report.accepted_at_utc = new Date().toISOString();
  }
} finally {
  try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(JSON.stringify(report, null, 2));
if (report.result !== "accepted") process.exit(2);
process.exit(0);
