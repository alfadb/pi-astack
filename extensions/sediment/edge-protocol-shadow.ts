/**
 * ADR 0044 Pi-side capture-only protocol shadow.
 *
 * Durable raw sidecar + per-session append-only edge journal.
 * Default-off. Never becomes memory authority. Never seals / never opens links.
 * Existing local sediment intake/queue remains the only local_primary authority.
 *
 * Missing Pi core capabilities (SessionManager transaction, launch broker)
 * are recorded explicitly; link/seal remain deferred.
 *
 * producer_seq truth = journal record filenames under OFD lock (no writer-state).
 * run_generation (protocol-shadow temporary) = candidate producer_seq; not a core fence.
 */

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, fsyncDirectory } from "../_shared/durable-write";
import { canonicalizeJcs, normalizeJcsValueOmittingUndefined, sha256Hex } from "../_shared/jcs";
import { withRetainedDirectoryOfdLock } from "../_shared/retained-directory-ofd-lock";

export const EDGE_PROTOCOL_SHADOW_ROOT_NAME = "edge-protocol-shadow" as const;
export const EDGE_JOURNAL_SCHEMA = "pi-astack/edge-journal/v1" as const;
export const EDGE_SOURCE_SCHEMA = "pi-astack/edge-source/v1" as const;
export const EDGE_JOURNAL_SCHEMA_VERSION = 1 as const;

/**
 * Hard size contract shared with pi-router daemon scanner / copy-store.
 * `pi_router_daemon::memory_shadow_copy::MAX_READ_BYTES` and
 * `MemoryCopyStore` default max file bytes are both 8 MiB. Producer must not
 * write any source sidecar or journal record larger than this bound.
 */
export const EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES = 8 * 1024 * 1024;

export type EdgeJournalRecordType = "candidate_capture" | "terminal_witness";

export interface EdgeC6Identity {
  session_id: string;
  turn_id: number | string;
  subturn?: number | string;
  sub_agent_label?: string;
  parent?: Readonly<Record<string, unknown>>;
}

export interface EdgeCapabilities {
  authority: "protocol_shadow";
  local_primary_authority: "existing_sediment_intake";
  session_transaction: false;
  launch_broker: false;
  terminal_seal: false;
  link_open_close: false;
  stage_a_complete: false;
}

export const EDGE_PROTOCOL_SHADOW_CAPABILITIES: EdgeCapabilities = Object.freeze({
  authority: "protocol_shadow",
  local_primary_authority: "existing_sediment_intake",
  session_transaction: false,
  launch_broker: false,
  terminal_seal: false,
  link_open_close: false,
  stage_a_complete: false,
});

export interface EdgeSourceRef {
  kind: "raw_sidecar";
  content_id: string;
  /** Relative to the session root (no absolute / owner path leakage in journal). */
  relative_path: string;
  byte_length: number;
}

export interface EdgeCandidateRef {
  record_id: string;
  producer_seq: number;
  payload_digest: string;
  run_generation: number;
}

export interface EdgeLeafTip {
  id: string;
  parentId: string | null;
  type: string;
  timestampUtc?: string;
}

export interface EdgeJournalRecord {
  schema: typeof EDGE_JOURNAL_SCHEMA;
  schema_version: typeof EDGE_JOURNAL_SCHEMA_VERSION;
  record_id: string;
  session_id: string;
  producer_seq: number;
  /**
   * Per Node process journal writer identity (stable for the process lifetime).
   * Not SessionManager epoch and not a launch fence — only identifies which
   * process produced this journal record. Cross-process seq linearization is
   * provided by the OFD lock, not by this field.
   */
  session_writer_epoch: string;
  record_type: EdgeJournalRecordType;
  created_at: string;
  payload_digest: string;
  c6: EdgeC6Identity;
  /**
   * Protocol-shadow temporary execution generation for the same C6.
   * For candidate_capture: equals this record's producer_seq (session-monotonic),
   * so same-C6 subsequent captures strictly increase without rewriting C6.
   * For terminal_witness: copies the referenced candidate's run_generation.
   * Not a Pi core fence; future core broker may provide a formal generation.
   */
  run_generation: number;
  source_ref?: EdgeSourceRef;
  candidate_ref?: EdgeCandidateRef;
  capabilities: EdgeCapabilities;
  /** TerminalWitness-only disposition. Never a TurnSettled / terminal_seal. */
  settlement_status?: "unsupported_core_capability" | "capture_only";
  leaf_tip?: EdgeLeafTip;
  deferred_by_missing_core?: ReadonlyArray<"session_transaction" | "launch_broker" | "terminal_seal" | "link_open_close">;
}

export interface EdgeSourceEnvelope {
  schema: typeof EDGE_SOURCE_SCHEMA;
  schema_version: 1;
  /** sha256 of exact serialized messages JSON bytes (not whole-envelope digest). */
  content_id: string;
  session_id: string;
  /** Full JSON-safe snapshot of agent_end event.messages (Pi JSONL-equivalent sensitivity). */
  messages: unknown;
  message_count: number;
}

export type EdgeWriteStatus = "created" | "identical" | "collision";

export interface EdgeCandidateCaptureResult {
  status: "captured" | "source_failed" | "journal_failed" | "disabled";
  duration_ms: number;
  source?: { content_id: string; path: string; status: EdgeWriteStatus; byte_length: number };
  record?: EdgeJournalRecord;
  record_path?: string;
  error_code?: string;
  error_detail?: string;
}

export interface EdgeTerminalWitnessResult {
  status: "written" | "no_candidate" | "journal_failed" | "disabled";
  duration_ms: number;
  record?: EdgeJournalRecord;
  record_path?: string;
  error_code?: string;
  error_detail?: string;
}

export interface EdgeCaptureArgs {
  abrainHome: string;
  ownerProjectRoot: string;
  sessionId: string;
  messages: unknown;
  c6: EdgeC6Identity;
  /** Capture-time SessionManager leaf tip (not settled tip). */
  leafTip?: EdgeLeafTip;
  createdAt?: string;
}

export interface EdgeWitnessArgs {
  abrainHome: string;
  ownerProjectRoot: string;
  sessionId: string;
  c6: EdgeC6Identity;
  leafTip?: EdgeLeafTip;
  createdAt?: string;
  /**
   * Explicit pin: witness this candidate_capture record_id (must match C6).
   * Without this, latest candidate for C6 is used (agent_settled path).
   * Opt-in only — does not change default latest-C6 behavior when omitted.
   */
  candidateRecordId?: string;
  /**
   * Explicit opt-in for pair/recovery: if a terminal_witness already references
   * the chosen candidate, return it without appending. Default false preserves
   * historical writeEdgeTerminalWitness multi-call append semantics.
   */
  idempotentReuse?: boolean;
}

export type EdgeTerminalPairStatus =
  | "complete"
  | "candidate_only"
  | "source_failed"
  | "journal_failed"
  | "conflict"
  | "disabled";

/** Idempotent healthy-terminal candidate+witness pair result (daemon continuous producer). */
export interface EdgeTerminalPairCaptureResult {
  status: EdgeTerminalPairStatus;
  duration_ms: number;
  candidate?: EdgeCandidateCaptureResult;
  witness?: EdgeTerminalWitnessResult;
  /** Durable pair admission key: (session_id, terminal_leaf_id). */
  terminal_leaf_id?: string;
  /** True when an existing candidate for (session,terminal_leaf,content) was reused. */
  candidate_reused?: boolean;
  /** True when an existing terminal_witness for that candidate was reused. */
  witness_reused?: boolean;
  /**
   * Attribution diagnostic only: another candidate in this session already carries
   * the same C6 with a different terminal leaf. Never blocks admission.
   */
  c6_collision?: boolean;
  error_code?: string;
  error_detail?: string;
}

export type EdgeUnreferencedSourceItemResult =
  | "would_recover"
  | "recovered"
  | "reused"
  | "already_referenced"
  | "skipped"
  | "failed";

export interface EdgeUnreferencedSourceRecoveryItem {
  session_id: string;
  content_id_prefix: string;
  result: EdgeUnreferencedSourceItemResult;
  terminal_leaf_id?: string;
  c6_collision?: boolean;
  error_code?: string;
  error_detail?: string;
}

/** Operator recovery for journal-unreferenced source sidecars (default dry-run). */
export interface EdgeUnreferencedSourceRecoveryResult {
  status: "ready" | "failed";
  mode: "dry_run" | "execute";
  duration_ms: number;
  scanned: number;
  eligible: number;
  recovered: number;
  reused: number;
  failed: number;
  skipped: number;
  already_referenced: number;
  sessions_scanned: number;
  items: EdgeUnreferencedSourceRecoveryItem[];
  error_code?: string;
  error_detail?: string;
}

export interface EdgeMissingWitnessRecoveryResult {
  status: "ready" | "failed";
  duration_ms: number;
  /** Candidate_capture records considered across scanned sessions. */
  scanned: number;
  recovered: number;
  failed: number;
  already_complete: number;
  /** Bounded owner-wide walk: number of session dirs visited. */
  sessions_scanned?: number;
  /** Sessions skipped due to caps / fail-closed layout. */
  sessions_skipped?: number;
  error_code?: string;
  error_detail?: string;
}

export interface EdgeSessionInitArgs {
  abrainHome: string;
  ownerProjectRoot: string;
  sessionId: string;
}

/** Low-cardinality layout init result. Never includes absolute paths or raw body. */
export interface EdgeSessionInitResult {
  status: "ready" | "failed";
  duration_ms: number;
  error_code?: string;
  error_detail?: string;
}

const SOURCE_MODE = 0o600;
const DIR_MODE = 0o700;
// Durable fsync under multi-process contention can exceed a few hundred ms;
// keep retries short per attempt but allow ~2s total before fail-closed.
const LOCK_BUSY_RETRIES = 200;
const LOCK_BUSY_SLEEP_MS = 10;
const RECORD_FILENAME_RE = /^(\d{20})__([0-9a-f]{64})\.json$/;
/** Owner-wide recovery bounds (cost-controlled on session_start). */
const RECOVERY_MAX_SESSIONS = 64;
const RECOVERY_MAX_CANDIDATES_PER_SESSION = 256;

/** Unique + stable for this Node process lifetime. Journal writer identity only. */
const PROCESS_JOURNAL_WRITER_EPOCH: string = `${Date.now().toString(36)}-pid${process.pid}-${crypto.randomUUID()}`;

let edgeDiagOnceKeys = new Set<string>();
/** One-shot test fault: throw before source durable create. Gated by PI_ASTACK_ENABLE_TEST_HOOKS. */
let sourceCreateFaultArmed = false;

export function getProcessJournalWriterEpoch(): string {
  return PROCESS_JOURNAL_WRITER_EPOCH;
}

export function edgeProtocolShadowRoot(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", EDGE_PROTOCOL_SHADOW_ROOT_NAME);
}

export function edgeOwnerKey(ownerProjectRoot: string): string {
  return sha256Hex(path.resolve(ownerProjectRoot));
}

export function edgeSessionRoot(abrainHome: string, ownerProjectRoot: string, sessionId: string): string {
  const safeSession = sanitizeSessionId(sessionId);
  return path.join(
    edgeProtocolShadowRoot(abrainHome),
    "by-owner",
    edgeOwnerKey(ownerProjectRoot),
    "sessions",
    safeSession,
  );
}

export function edgeSourcesDir(sessionRoot: string): string {
  return path.join(sessionRoot, "sources");
}

export function edgeJournalDir(sessionRoot: string): string {
  return path.join(sessionRoot, "journal");
}

export function edgeJournalRecordsDir(sessionRoot: string): string {
  return path.join(edgeJournalDir(sessionRoot), "records");
}

export function edgeJournalLockDir(sessionRoot: string): string {
  return path.join(edgeJournalDir(sessionRoot), "lock");
}

/**
 * Per-session private staging for atomic publish temps.
 * Same filesystem as records/sources (link(2) requires it) but NOT under
 * `journal/records/` — daemon scanner treats any unexpected name there as
 * whole-round fail (`source_unexpected_entry`). Crash residue here is ignored.
 */
export function edgeStagingDir(sessionRoot: string): string {
  return path.join(sessionRoot, "staging");
}

export function edgeSourcePath(sessionRoot: string, contentId: string): string {
  assertContentId(contentId);
  return path.join(edgeSourcesDir(sessionRoot), `${contentId}.json`);
}

export function edgeRecordPath(sessionRoot: string, producerSeq: number, recordId: string): string {
  assertContentId(recordId);
  if (!Number.isInteger(producerSeq) || producerSeq < 1) throw new Error(`invalid producer_seq: ${producerSeq}`);
  return path.join(edgeJournalRecordsDir(sessionRoot), `${String(producerSeq).padStart(20, "0")}__${recordId}.json`);
}

function edgeStagingTmpPath(sessionRoot: string, kind: "source" | "record"): string {
  return path.join(
    edgeStagingDir(sessionRoot),
    `.${kind}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
}

/** JSON-safe deep clone. Single walk. Strips functions/symbols; BigInt → string; Error → {name,message}.
 *  Ancestor/path stack (not a permanent seen set): only true cycles become `{circular:true}`;
 *  non-cyclic shared objects are fully serialized at every reference site. */
export function toJsonSafe(value: unknown): unknown {
  const ancestors: object[] = [];
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v === undefined ? null : null;
    const t = typeof v;
    if (t === "string" || t === "boolean") return v;
    if (t === "number") return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null;
    if (t === "bigint") return String(v);
    if (t === "function" || t === "symbol") return null;
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (v instanceof Date) return v.toISOString();
    if (ArrayBuffer.isView(v)) {
      const view = v as ArrayBufferView;
      // Safe copy: Buffer.from(ArrayBufferView) is not accepted under strict @types/node.
      const copy = new Uint8Array(view.byteLength);
      copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      return {
        type: "binary",
        byte_length: view.byteLength,
        sha256: crypto.createHash("sha256").update(copy).digest("hex"),
      };
    }
    if (typeof v === "object") {
      const obj = v as object;
      if (ancestors.includes(obj)) return { circular: true };
      ancestors.push(obj);
      try {
        if (Array.isArray(v)) return v.map(walk);
        const out: Record<string, unknown> = {};
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
          if (child === undefined) continue;
          out[k] = walk(child);
        }
        return out;
      } finally {
        ancestors.pop();
      }
    }
    return null;
  };
  return walk(value);
}

/**
 * content_id / payload_digest = sha256 of exact serialized messages JSON bytes.
 * Callers must pass the same string later embedded as the source envelope `messages` value.
 */
export function computePayloadDigest(messagesJson: string): string {
  return sha256Hex(messagesJson);
}

/**
 * Stable record_id for an edge journal record body.
 * JCS(normalize({ ...partialWithoutSeqAndId, producer_seq_placeholder: null })) then sha256.
 * Callers must pass the same partial shape used at write time (no record_id, no producer_seq).
 */
export function computeEdgeJournalRecordId(
  partialWithoutSeqAndId: Readonly<Record<string, unknown>>,
): string {
  return sha256Hex(canonicalizeJcs(normalizeJcsValueOmittingUndefined({
    ...partialWithoutSeqAndId,
    producer_seq_placeholder: null,
  })));
}

/**
 * Recompute record_id from a durable journal record (strips record_id + producer_seq).
 * Used by acceptance/integrity paths so tests do not re-copy JCS rules.
 */
export function recomputeEdgeJournalRecordId(record: EdgeJournalRecord): string {
  const { record_id: _recordId, producer_seq: _producerSeq, ...rest } = record;
  return computeEdgeJournalRecordId(rest as Readonly<Record<string, unknown>>);
}

/** Parse `000...N__<64hex>.json` record filenames. Returns null when the name is not a record. */
export function parseEdgeRecordFilename(name: string): { producerSeq: number; recordId: string } | null {
  const m = RECORD_FILENAME_RE.exec(name);
  if (!m) return null;
  const producerSeq = Number(m[1]);
  if (!Number.isInteger(producerSeq) || producerSeq < 1) return null;
  return { producerSeq, recordId: m[2] };
}

/**
 * Resolve source_ref.relative_path under sessionRoot.
 * Rejects path escape (absolute, `..`, outside session root). Does not read file contents.
 */
export function resolveEdgeSourcePathWithinSession(
  sessionRoot: string,
  relativePath: string,
): { ok: true; absolutePath: string } | { ok: false; error_code: string } {
  if (typeof relativePath !== "string" || !relativePath) {
    return { ok: false, error_code: "source_relative_path_missing" };
  }
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    return { ok: false, error_code: "source_path_escape" };
  }
  const rootResolved = path.resolve(sessionRoot);
  // Force posix-style relative components through path.resolve under root.
  const candidate = path.resolve(rootResolved, relativePath);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
    return { ok: false, error_code: "source_path_escape" };
  }
  return { ok: true, absolutePath: candidate };
}

export function c6Key(c6: EdgeC6Identity): string {
  return canonicalizeJcs(normalizeJcsValueOmittingUndefined({
    session_id: c6.session_id,
    turn_id: c6.turn_id,
    ...(c6.subturn !== undefined ? { subturn: c6.subturn } : {}),
    ...(c6.sub_agent_label ? { sub_agent_label: c6.sub_agent_label } : {}),
    ...(c6.parent ? { parent: c6.parent } : {}),
  }));
}

/**
 * Durable pair admission leaf identity for a session.
 * Prefer real terminal descriptor `leaf_tip.id`; legacy journal rows without
 * leaf_tip derive a stable id from candidate/source content digest so old
 * records still dedupe without rewrite.
 */
export function resolveTerminalLeafId(args: {
  leafTip?: EdgeLeafTip | null;
  payloadDigest?: string | null;
  sourceContentId?: string | null;
}): string | null {
  const tipId = args.leafTip?.id;
  if (typeof tipId === "string") {
    const trimmed = tipId.trim();
    if (trimmed) return trimmed;
  }
  const digest =
    (typeof args.payloadDigest === "string" && args.payloadDigest)
    || (typeof args.sourceContentId === "string" && args.sourceContentId)
    || "";
  if (/^[0-9a-f]{64}$/.test(digest)) return `legacy_content:${digest}`;
  return null;
}

/** Synthetic leaf tip used only by unreferenced-source operator recovery. */
export function legacySourceRecoveryLeafTip(contentId: string, timestampUtc?: string): EdgeLeafTip {
  assertContentId(contentId);
  return {
    id: contentId,
    parentId: null,
    type: "legacy_source_recovery",
    ...(timestampUtc ? { timestampUtc } : {}),
  };
}

export function emitEdgeProtocolShadowDiagnosticOnce(code: string, _detail?: string): void {
  // Low-cardinality only: code/status. Never log absolute paths or raw body.
  if (edgeDiagOnceKeys.has(code)) return;
  edgeDiagOnceKeys.add(code);
  console.error(`[sediment/edge-protocol-shadow] ${code}`);
}

export function _resetEdgeProtocolShadowDiagnosticsForTests(): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error("_resetEdgeProtocolShadowDiagnosticsForTests requires PI_ASTACK_ENABLE_TEST_HOOKS=1");
  }
  edgeDiagOnceKeys = new Set();
  sourceCreateFaultArmed = false;
}

/** Test-only: arm a one-shot fault before source durable create. */
export function _armSourceCreateFaultForTests(): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error("_armSourceCreateFaultForTests requires PI_ASTACK_ENABLE_TEST_HOOKS=1");
  }
  sourceCreateFaultArmed = true;
}

export function _disarmSourceCreateFaultForTests(): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error("_disarmSourceCreateFaultForTests requires PI_ASTACK_ENABLE_TEST_HOOKS=1");
  }
  sourceCreateFaultArmed = false;
}

function maybeThrowSourceCreateFaultForTests(): void {
  // Production never sets PI_ASTACK_ENABLE_TEST_HOOKS; both gates required.
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1" || !sourceCreateFaultArmed) return;
  sourceCreateFaultArmed = false;
  throw new Error("test_hook_source_create_fault");
}

/**
 * Build durable source envelope bytes without re-serializing the large messages payload.
 * `messagesJson` is already JSON.stringify'd once; content_id digests those exact bytes.
 */
export function buildEdgeSourceEnvelopeBody(args: {
  contentId: string;
  sessionId: string;
  messageCount: number;
  messagesJson: string;
}): string {
  return (
    `{"schema":${JSON.stringify(EDGE_SOURCE_SCHEMA)}` +
    `,"schema_version":1` +
    `,"content_id":${JSON.stringify(args.contentId)}` +
    `,"session_id":${JSON.stringify(args.sessionId)}` +
    `,"message_count":${args.messageCount}` +
    `,"messages":${args.messagesJson}}\n`
  );
}

/**
 * Extract the exact raw JSON bytes of a top-level object field (serde_json RawValue
 * equivalent). Rejects nested-only matches; does not re-serialize.
 */
export function extractTopLevelJsonFieldRaw(
  text: string,
  fieldName: string,
): string | null {
  const src = text.trim();
  if (!src.startsWith("{")) return null;
  let i = 1;
  const n = src.length;
  const skipWs = () => {
    while (i < n && (src[i] === " " || src[i] === "\n" || src[i] === "\r" || src[i] === "\t")) i += 1;
  };
  const parseString = (): string | null => {
    if (src[i] !== "\"") return null;
    i += 1;
    let out = "";
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") {
        if (i + 1 >= n) return null;
        out += ch + src[i + 1];
        i += 2;
        continue;
      }
      if (ch === "\"") {
        i += 1;
        return out;
      }
      out += ch;
      i += 1;
    }
    return null;
  };
  const skipValue = (): { start: number; end: number } | null => {
    skipWs();
    if (i >= n) return null;
    const start = i;
    const ch = src[i];
    if (ch === "\"") {
      if (parseString() === null) return null;
      return { start, end: i };
    }
    if (ch === "{" || ch === "[") {
      const open = ch;
      const close = ch === "{" ? "}" : "]";
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (; i < n; i += 1) {
        const c = src[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === "\"") inStr = false;
          continue;
        }
        if (c === "\"") {
          inStr = true;
          continue;
        }
        if (c === open) depth += 1;
        else if (c === close) {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            return { start, end: i };
          }
        }
      }
      return null;
    }
    // primitive: true/false/null/number
    while (i < n && !/^[\s,\]}]$/.test(src[i]!)) i += 1;
    if (i === start) return null;
    return { start, end: i };
  };
  while (i < n) {
    skipWs();
    if (src[i] === "}") return null;
    const key = parseString();
    if (key === null) return null;
    skipWs();
    if (src[i] !== ":") return null;
    i += 1;
    const val = skipValue();
    if (!val) return null;
    if (key === fieldName) return src.slice(val.start, val.end);
    skipWs();
    if (src[i] === ",") {
      i += 1;
      continue;
    }
    if (src[i] === "}") return null;
    return null;
  }
  return null;
}

export type EdgeSourceEnvelopeVerifyResult =
  | { ok: true; messages_raw: string; message_count: number }
  | {
      ok: false;
      code:
        | "byte_length_mismatch"
        | "schema_mismatch"
        | "content_id_mismatch"
        | "messages_digest_mismatch"
        | "envelope_inconsistent"
        | "not_utf8";
    };

/**
 * Canonical source envelope integrity check used by frozen-contract adapter.
 * content_id must equal sha256 of exact messages RawValue bytes (not re-serialized).
 */
export function verifyEdgeSourceEnvelopeBytes(
  bytes: Buffer | Uint8Array,
  expected: { sessionId: string; contentId: string; byteLength: number },
): EdgeSourceEnvelopeVerifyResult {
  if (bytes.byteLength !== expected.byteLength) {
    return { ok: false, code: "byte_length_mismatch" };
  }
  let text: string;
  try {
    text = Buffer.from(bytes).toString("utf8");
  } catch {
    return { ok: false, code: "not_utf8" };
  }
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(text.trim()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "envelope_inconsistent" };
  }
  if (env.schema !== EDGE_SOURCE_SCHEMA || env.schema_version !== 1) {
    return { ok: false, code: "schema_mismatch" };
  }
  if (typeof env.content_id !== "string" || env.content_id !== expected.contentId) {
    return { ok: false, code: "content_id_mismatch" };
  }
  if (env.session_id !== expected.sessionId) {
    return { ok: false, code: "envelope_inconsistent" };
  }
  const messagesRaw = extractTopLevelJsonFieldRaw(text, "messages");
  if (messagesRaw === null) return { ok: false, code: "envelope_inconsistent" };
  let parsedMessages: unknown;
  try {
    parsedMessages = JSON.parse(messagesRaw);
  } catch {
    return { ok: false, code: "envelope_inconsistent" };
  }
  const digest = computePayloadDigest(messagesRaw);
  if (digest !== expected.contentId || digest !== env.content_id) {
    return { ok: false, code: "messages_digest_mismatch" };
  }
  const messageCount = typeof env.message_count === "number" ? env.message_count : -1;
  if (!Number.isInteger(messageCount) || messageCount < 0) {
    return { ok: false, code: "envelope_inconsistent" };
  }
  if (Array.isArray(parsedMessages)) {
    if (parsedMessages.length !== messageCount) {
      return { ok: false, code: "envelope_inconsistent" };
    }
  } else if (messageCount !== 0) {
    return { ok: false, code: "envelope_inconsistent" };
  }
  return { ok: true, messages_raw: messagesRaw, message_count: messageCount };
}

/**
 * Default-off protocol shadow startup durable session layout.
 * Idempotent: same layout as capture (session/sources/journal/records/lock).
 * Does NOT write source or candidate. Does NOT relax symlink/mode/fsync safety.
 * Caller gates enabled=true; this function itself is not a settings reader.
 */
export async function initializeEdgeProtocolShadowSession(
  args: EdgeSessionInitArgs,
): Promise<EdgeSessionInitResult> {
  const started = performance.now();
  if (!args.sessionId) {
    return {
      status: "failed",
      duration_ms: performance.now() - started,
      error_code: "missing_session_id",
      error_detail: sanitizeDiagnostic("sessionId required"),
    };
  }
  try {
    const sessionRoot = edgeSessionRoot(args.abrainHome, args.ownerProjectRoot, args.sessionId);
    await ensureSessionLayout(sessionRoot, args.abrainHome);
    return { status: "ready", duration_ms: performance.now() - started };
  } catch (err) {
    return {
      status: "failed",
      duration_ms: performance.now() - started,
      error_code: "layout_init_failed",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
}

/**
 * agent_end capture: durable source first, then candidate journal record.
 * Never pin-only. Does not wait on LLM/Git/network/recovery/drain.
 */
export async function captureEdgeProtocolCandidate(args: EdgeCaptureArgs): Promise<EdgeCandidateCaptureResult> {
  const started = performance.now();
  const sessionId = args.sessionId;
  if (!sessionId) {
    return failCandidate(started, "missing_session_id", "sessionId required");
  }
  // Fail closed BEFORE any source IO: live session must match C6 identity session.
  let c6: EdgeC6Identity;
  try {
    c6 = normalizeC6(args.c6);
  } catch (err) {
    return failCandidate(started, "invalid_c6", errMessage(err));
  }
  if (sessionId !== c6.session_id) {
    return failCandidate(started, "session_c6_mismatch", "sessionId does not match c6.session_id");
  }
  const sessionRoot = edgeSessionRoot(args.abrainHome, args.ownerProjectRoot, sessionId);
  try {
    await ensureSessionLayout(sessionRoot, args.abrainHome);
    // Single walk + single messages stringify; digest exact messages JSON bytes.
    const messagesSafe = toJsonSafe(args.messages);
    const messagesJson = JSON.stringify(messagesSafe);
    const payloadDigest = computePayloadDigest(messagesJson);
    const messageCount = Array.isArray(messagesSafe) ? messagesSafe.length : 0;
    const sourceBody = buildEdgeSourceEnvelopeBody({
      contentId: payloadDigest,
      sessionId,
      messageCount,
      messagesJson,
    });
    const sourceByteLength = Buffer.byteLength(sourceBody, "utf-8");
    // Hard size contract BEFORE any candidate/journal write — no partial product.
    if (sourceByteLength > EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES) {
      return failCandidate(started, "source_too_large", `source exceeds ${EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES} bytes`);
    }
    const sourcePath = edgeSourcePath(sessionRoot, payloadDigest);
    let sourceStatus: EdgeWriteStatus;
    try {
      sourceStatus = await createOrVerifyEdgeSidecar(sessionRoot, sourcePath, sourceBody);
    } catch (err) {
      const code = errMessage(err) === "source_collision" ? "source_collision" : "source_write_failed";
      return failCandidate(started, code, errMessage(err));
    }

    const sourceRef: EdgeSourceRef = {
      kind: "raw_sidecar",
      content_id: payloadDigest,
      relative_path: path.posix.join("sources", `${payloadDigest}.json`),
      byte_length: sourceByteLength,
    };

    try {
      const written = await withJournalWriter(sessionRoot, args.abrainHome, async (writer) => {
        const producerSeq = writer.allocateSeq();
        // Protocol-shadow temporary execution generation (= session producer_seq).
        // Same-C6 subsequent captures strictly increase; C6 fields are never rewritten.
        // Not a core fence — future broker may supply a formal generation.
        const runGeneration = producerSeq;
        const createdAtRecord = args.createdAt ?? new Date().toISOString();
        const partial = {
          schema: EDGE_JOURNAL_SCHEMA,
          schema_version: EDGE_JOURNAL_SCHEMA_VERSION,
          session_id: sessionId,
          session_writer_epoch: writer.session_writer_epoch,
          record_type: "candidate_capture" as const,
          created_at: createdAtRecord,
          payload_digest: payloadDigest,
          c6,
          run_generation: runGeneration,
          source_ref: sourceRef,
          capabilities: EDGE_PROTOCOL_SHADOW_CAPABILITIES,
          ...(args.leafTip ? { leaf_tip: args.leafTip } : {}),
          deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"] as const,
        };
        // Small journal object: JCS for stable record_id (excludes producer_seq).
        const recordId = computeEdgeJournalRecordId(partial as Readonly<Record<string, unknown>>);
        const record: EdgeJournalRecord = {
          ...partial,
          record_id: recordId,
          producer_seq: producerSeq,
          deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"],
        };
        const recordPath = edgeRecordPath(sessionRoot, producerSeq, recordId);
        const body = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(body, "utf-8") > EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES) {
          throw new Error("record_too_large");
        }
        const status = await durableAtomicCreateFile(recordPath, body, {
          mode: SOURCE_MODE,
          verifyCreated: false,
          tmpPath: edgeStagingTmpPath(sessionRoot, "record"),
        });
        if (status === "collision") throw new Error("journal record collision");
        await assertMode(recordPath, SOURCE_MODE);
        return { record, recordPath, status };
      });
      return {
        status: "captured",
        duration_ms: performance.now() - started,
        source: {
          content_id: payloadDigest,
          path: sourcePath,
          status: sourceStatus,
          byte_length: sourceRef.byte_length,
        },
        record: written.record,
        record_path: written.recordPath,
      };
    } catch (err) {
      const detail = errMessage(err);
      return failCandidate(
        started,
        detail === "record_too_large" ? "record_too_large" : "journal_write_failed",
        detail,
        {
          content_id: payloadDigest,
          path: sourcePath,
          status: sourceStatus,
          byte_length: sourceRef.byte_length,
        },
      );
    }
  } catch (err) {
    return failCandidate(started, "capture_failed", errMessage(err));
  }
}

/**
 * agent_settled: local durable TerminalWitness only.
 * References latest candidate for this session/C6. Never terminal_seal / TurnSettled.
 *
 * Default semantics are unchanged from pre-continuous-producer: each call may
 * append a new witness for the latest/pinned candidate. Idempotent reuse and
 * pair capture live in `captureEdgeProtocolTerminalPair` or require explicit
 * `idempotentReuse: true` / `candidateRecordId` opts.
 */
export async function writeEdgeTerminalWitness(args: EdgeWitnessArgs): Promise<EdgeTerminalWitnessResult> {
  const started = performance.now();
  const sessionId = args.sessionId;
  if (!sessionId) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "missing_session_id",
      error_detail: sanitizeDiagnostic("sessionId required"),
    };
  }
  // Fail closed BEFORE any source/journal IO: live session must match C6 identity session.
  let c6: EdgeC6Identity;
  try {
    c6 = normalizeC6(args.c6);
  } catch (err) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "invalid_c6",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
  if (sessionId !== c6.session_id) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "session_c6_mismatch",
      error_detail: sanitizeDiagnostic("sessionId does not match c6.session_id"),
    };
  }
  const sessionRoot = edgeSessionRoot(args.abrainHome, args.ownerProjectRoot, sessionId);
  try {
    await ensureSessionLayout(sessionRoot, args.abrainHome);
    // findLatest/pin + allocateSeq + durable witness create must share one OFD lock
    // critical section so concurrent candidate writers cannot race the ref.
    const written = await withJournalWriter(sessionRoot, args.abrainHome, async (writer) => {
      const index = await loadJournalIndex(sessionRoot);
      writer.seedSeq(index.maxSeq + 1);
      let latest: { record: EdgeJournalRecord; path: string } | null = null;
      if (args.candidateRecordId) {
        const hit = index.byRecordId.get(args.candidateRecordId);
        if (hit && hit.record.record_type === "candidate_capture") {
          latest = { record: hit.record, path: hit.path };
        }
        if (!latest) return { kind: "no_candidate" as const };
        if (c6Key(latest.record.c6) !== c6Key(c6)) {
          throw new Error("candidate c6 mismatch for pinned candidateRecordId");
        }
      } else {
        latest = indexFindLatestCandidateForC6(index, c6);
        if (!latest) return { kind: "no_candidate" as const };
      }
      // Opt-in only: default public API may still append multiple witnesses.
      if (args.idempotentReuse === true) {
        const existingWit = index.witnessByCandidateId.get(latest.record.record_id);
        if (existingWit) {
          return { kind: "reused" as const, record: existingWit.record, recordPath: existingWit.path };
        }
      }
      // Never point a witness at a missing sidecar.
      if (latest.record.source_ref?.content_id) {
        const sidePath = edgeSourcePath(sessionRoot, latest.record.source_ref.content_id);
        try {
          await fs.stat(sidePath);
        } catch {
          throw new Error("witness_source_missing");
        }
      }
      return writeWitnessRecordUnderLock({
        writer,
        sessionRoot,
        sessionId,
        c6,
        candidate: latest.record,
        leafTip: args.leafTip,
        createdAt: args.createdAt,
      });
    });
    if (written.kind === "no_candidate") {
      return { status: "no_candidate", duration_ms: performance.now() - started };
    }
    return {
      status: "written",
      duration_ms: performance.now() - started,
      record: written.record,
      record_path: written.recordPath,
    };
  } catch (err) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "witness_write_failed",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
}

/**
 * Production producer naming alias for writeEdgeTerminalWitness.
 * Same durable TerminalWitness semantics; never terminal_seal / ConsumerAck.
 */
export async function captureEdgeProtocolTerminalWitness(
  args: EdgeWitnessArgs,
): Promise<EdgeTerminalWitnessResult> {
  return writeEdgeTerminalWitness(args);
}

/**
 * Idempotent healthy-terminal pair: durable source + candidate, then TerminalWitness.
 *
 * Critical section under the journal OFD lock:
 *  - one journal index load (candidate/witness lookup + seq)
 *  - durable admission key = (session_id, terminal leaf message id)
 *  - same (session,leaf,content) reuses candidate
 *  - same leaf different content → fail closed `terminal_identity_content_conflict`
 *  - different leaf even with same C6 → independent pair; `c6_collision` diagnostic only
 *  - C6 is retained for attribution, not unique admission
 *  - witness dedupe under the same lock
 *
 * Sidecar is always create/verify content-addressed before any witness is written.
 * Partial witness failure leaves the candidate for recovery.
 */
export async function captureEdgeProtocolTerminalPair(
  args: EdgeCaptureArgs,
): Promise<EdgeTerminalPairCaptureResult> {
  const sessionId = args.sessionId;
  if (!sessionId) {
    return {
      status: "journal_failed",
      duration_ms: 0,
      error_code: "missing_session_id",
      error_detail: sanitizeDiagnostic("sessionId required"),
    };
  }
  return captureEdgeProtocolTerminalPairAtSessionRoot({
    abrainHome: args.abrainHome,
    sessionRoot: edgeSessionRoot(args.abrainHome, args.ownerProjectRoot, sessionId),
    sessionId,
    messages: args.messages,
    c6: args.c6,
    leafTip: args.leafTip,
    createdAt: args.createdAt,
  });
}

/**
 * Pair capture against an already-resolved session root (operator recovery).
 * Same admission semantics as {@link captureEdgeProtocolTerminalPair}.
 */
export async function captureEdgeProtocolTerminalPairAtSessionRoot(args: {
  abrainHome: string;
  sessionRoot: string;
  sessionId: string;
  messages: unknown;
  c6: EdgeC6Identity;
  leafTip?: EdgeLeafTip;
  createdAt?: string;
}): Promise<EdgeTerminalPairCaptureResult> {
  const started = performance.now();
  const sessionId = args.sessionId;
  if (!sessionId) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "missing_session_id",
      error_detail: sanitizeDiagnostic("sessionId required"),
    };
  }
  let c6: EdgeC6Identity;
  try {
    c6 = normalizeC6(args.c6);
  } catch (err) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "invalid_c6",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
  if (sessionId !== c6.session_id) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "session_c6_mismatch",
      error_detail: sanitizeDiagnostic("sessionId does not match c6.session_id"),
    };
  }
  const terminalLeafId = resolveTerminalLeafId({ leafTip: args.leafTip ?? null });
  if (!terminalLeafId) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "missing_terminal_leaf",
      error_detail: sanitizeDiagnostic("terminal leaf id required for pair admission"),
    };
  }
  // Normalize leaf tip so durable records always carry the admission identity.
  const leafTip: EdgeLeafTip = {
    id: terminalLeafId,
    parentId: args.leafTip?.parentId ?? null,
    type: args.leafTip?.type ?? "message",
    ...(args.leafTip?.timestampUtc ? { timestampUtc: args.leafTip.timestampUtc } : {}),
  };

  const sessionRoot = path.resolve(args.sessionRoot);
  try {
    await ensureSessionLayout(sessionRoot, args.abrainHome);
    const messagesSafe = toJsonSafe(args.messages);
    const messagesJson = JSON.stringify(messagesSafe);
    const payloadDigest = computePayloadDigest(messagesJson);
    const messageCount = Array.isArray(messagesSafe) ? messagesSafe.length : 0;
    const sourceBody = buildEdgeSourceEnvelopeBody({
      contentId: payloadDigest,
      sessionId,
      messageCount,
      messagesJson,
    });
    const sourceByteLength = Buffer.byteLength(sourceBody, "utf-8");
    if (sourceByteLength > EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES) {
      return {
        status: "source_failed",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        error_code: "source_too_large",
        error_detail: sanitizeDiagnostic(`source exceeds ${EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES} bytes`),
      };
    }
    const sourcePath = edgeSourcePath(sessionRoot, payloadDigest);
    let sourceStatus: EdgeWriteStatus;
    try {
      // Always create/verify exact content-addressed sidecar (missing → restore;
      // corrupt/collision → fail closed). Never write witness for missing source.
      sourceStatus = await createOrVerifyEdgeSidecar(sessionRoot, sourcePath, sourceBody);
    } catch (err) {
      const detail = errMessage(err);
      return {
        status: "source_failed",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        error_code: detail === "source_collision" ? "source_collision" : "source_write_failed",
        error_detail: sanitizeDiagnostic(detail),
      };
    }

    const sourceRef: EdgeSourceRef = {
      kind: "raw_sidecar",
      content_id: payloadDigest,
      relative_path: path.posix.join("sources", `${payloadDigest}.json`),
      byte_length: sourceByteLength,
    };

    type PairLockResult =
      | {
          kind: "complete";
          candidate: EdgeJournalRecord;
          candidatePath: string;
          candidateReused: boolean;
          witness: EdgeJournalRecord;
          witnessPath: string;
          witnessReused: boolean;
          c6Collision: boolean;
        }
      | {
          kind: "candidate_only";
          candidate: EdgeJournalRecord;
          candidatePath: string;
          candidateReused: boolean;
          c6Collision: boolean;
          error_code: string;
          error_detail?: string;
        }
      | { kind: "conflict"; error_code: string; error_detail: string }
      | { kind: "failed"; error_code: string; error_detail: string };

    const locked = await withJournalWriter(sessionRoot, args.abrainHome, async (writer): Promise<PairLockResult> => {
      // One index load under the OFD lock: candidate/witness lookup + seq.
      const index = await loadJournalIndex(sessionRoot);
      writer.seedSeq(index.maxSeq + 1);
      const wantC6 = c6Key(c6);

      // Admission key = terminal leaf (not C6). Same leaf different content fail closed.
      const sameLeaf = index.candidatesByLeaf.get(terminalLeafId) ?? [];
      const matching = sameLeaf.find((c) => c.record.payload_digest === payloadDigest) ?? null;
      if (!matching && sameLeaf.length > 0) {
        const otherDigest = sameLeaf[sameLeaf.length - 1]?.record.payload_digest;
        if (otherDigest && otherDigest !== payloadDigest) {
          return {
            kind: "conflict",
            error_code: "terminal_identity_content_conflict",
            error_detail: sanitizeDiagnostic("same terminal leaf already has a different content digest"),
          };
        }
      }

      // C6 collision is attribution diagnostic only — never unique admission.
      const sameC6 = index.candidatesByC6.get(wantC6) ?? [];
      const c6Collision = sameC6.some((c) => {
        const otherLeaf = resolveTerminalLeafId({
          leafTip: c.record.leaf_tip,
          payloadDigest: c.record.payload_digest,
          sourceContentId: c.record.source_ref?.content_id,
        });
        return otherLeaf !== null && otherLeaf !== terminalLeafId;
      });

      let candidateReused = false;
      let candidateRecord: EdgeJournalRecord;
      let candidatePath: string;

      if (matching) {
        candidateReused = true;
        candidateRecord = matching.record;
        candidatePath = matching.path;
      } else {
        const producerSeq = writer.allocateSeq();
        const runGeneration = producerSeq;
        const createdAtRecord = args.createdAt ?? new Date().toISOString();
        const partial = {
          schema: EDGE_JOURNAL_SCHEMA,
          schema_version: EDGE_JOURNAL_SCHEMA_VERSION,
          session_id: sessionId,
          session_writer_epoch: writer.session_writer_epoch,
          record_type: "candidate_capture" as const,
          created_at: createdAtRecord,
          payload_digest: payloadDigest,
          c6,
          run_generation: runGeneration,
          source_ref: sourceRef,
          capabilities: EDGE_PROTOCOL_SHADOW_CAPABILITIES,
          leaf_tip: leafTip,
          deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"] as const,
        };
        const recordId = computeEdgeJournalRecordId(partial as Readonly<Record<string, unknown>>);
        candidateRecord = {
          ...partial,
          record_id: recordId,
          producer_seq: producerSeq,
          deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"],
        };
        candidatePath = edgeRecordPath(sessionRoot, producerSeq, recordId);
        const body = `${JSON.stringify(candidateRecord)}\n`;
        if (Buffer.byteLength(body, "utf-8") > EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES) {
          return {
            kind: "failed",
            error_code: "record_too_large",
            error_detail: sanitizeDiagnostic(`record exceeds ${EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES} bytes`),
          };
        }
        const status = await durableAtomicCreateFile(candidatePath, body, {
          mode: SOURCE_MODE,
          verifyCreated: false,
          tmpPath: edgeStagingTmpPath(sessionRoot, "record"),
        });
        if (status === "collision") {
          return {
            kind: "failed",
            error_code: "journal_record_collision",
            error_detail: sanitizeDiagnostic("journal record collision"),
          };
        }
        await assertMode(candidatePath, SOURCE_MODE);
        if (c6Collision) {
          emitEdgeProtocolShadowDiagnosticOnce("c6_collision");
        }
      }

      const existingWit = index.witnessByCandidateId.get(candidateRecord.record_id);
      if (existingWit) {
        return {
          kind: "complete",
          candidate: candidateRecord,
          candidatePath,
          candidateReused,
          witness: existingWit.record,
          witnessPath: existingWit.path,
          witnessReused: true,
          c6Collision,
        };
      }

      try {
        const wit = await writeWitnessRecordUnderLock({
          writer,
          sessionRoot,
          sessionId,
          c6,
          candidate: candidateRecord,
          leafTip: leafTip ?? candidateRecord.leaf_tip,
          createdAt: args.createdAt,
        });
        return {
          kind: "complete",
          candidate: candidateRecord,
          candidatePath,
          candidateReused,
          witness: wit.record,
          witnessPath: wit.recordPath,
          witnessReused: false,
          c6Collision,
        };
      } catch (err) {
        return {
          kind: "candidate_only",
          candidate: candidateRecord,
          candidatePath,
          candidateReused,
          c6Collision,
          error_code: "witness_write_failed",
          error_detail: sanitizeDiagnostic(errMessage(err)),
        };
      }
    });

    if (locked.kind === "conflict") {
      emitEdgeProtocolShadowDiagnosticOnce(locked.error_code);
      return {
        status: "conflict",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        error_code: locked.error_code,
        error_detail: locked.error_detail,
      };
    }
    if (locked.kind === "failed") {
      return {
        status: "journal_failed",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        error_code: locked.error_code,
        error_detail: locked.error_detail,
      };
    }

    const candidateResult: EdgeCandidateCaptureResult = {
      status: "captured",
      duration_ms: 0,
      source: {
        content_id: payloadDigest,
        path: sourcePath,
        status: sourceStatus,
        byte_length: sourceByteLength,
      },
      record: locked.candidate,
      record_path: locked.candidatePath,
    };

    if (locked.kind === "candidate_only") {
      return {
        status: "candidate_only",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        candidate: candidateResult,
        candidate_reused: locked.candidateReused,
        c6_collision: locked.c6Collision || undefined,
        error_code: locked.error_code,
        error_detail: locked.error_detail,
      };
    }

    return {
      status: "complete",
      duration_ms: performance.now() - started,
      terminal_leaf_id: terminalLeafId,
      candidate: candidateResult,
      witness: {
        status: "written",
        duration_ms: 0,
        record: locked.witness,
        record_path: locked.witnessPath,
      },
      candidate_reused: locked.candidateReused,
      witness_reused: locked.witnessReused,
      c6_collision: locked.c6Collision || undefined,
    };
  } catch (err) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      terminal_leaf_id: terminalLeafId,
      error_code: "pair_capture_failed",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
}

/**
 * Operator-only: admit an already-durable content-addressed source as a
 * candidate+witness pair without re-serializing messages or rewriting source bytes.
 * Same leaf admission / c6_collision / producer_seq rules as live pair capture.
 */
export async function admitExistingSourceAsTerminalPair(args: {
  abrainHome: string;
  sessionRoot: string;
  sessionId: string;
  contentId: string;
  sourceByteLength: number;
  c6: EdgeC6Identity;
  leafTip: EdgeLeafTip;
  createdAt?: string;
}): Promise<EdgeTerminalPairCaptureResult> {
  const started = performance.now();
  const sessionId = args.sessionId;
  if (!sessionId) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "missing_session_id",
      error_detail: sanitizeDiagnostic("sessionId required"),
    };
  }
  let c6: EdgeC6Identity;
  try {
    c6 = normalizeC6(args.c6);
  } catch (err) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "invalid_c6",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
  if (sessionId !== c6.session_id) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "session_c6_mismatch",
      error_detail: sanitizeDiagnostic("sessionId does not match c6.session_id"),
    };
  }
  const terminalLeafId = resolveTerminalLeafId({ leafTip: args.leafTip });
  if (!terminalLeafId) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      error_code: "missing_terminal_leaf",
      error_detail: sanitizeDiagnostic("terminal leaf id required for pair admission"),
    };
  }
  if (!/^[0-9a-f]{64}$/.test(args.contentId)) {
    return {
      status: "source_failed",
      duration_ms: performance.now() - started,
      terminal_leaf_id: terminalLeafId,
      error_code: "invalid_content_id",
      error_detail: sanitizeDiagnostic("contentId must be 64 hex"),
    };
  }
  const leafTip: EdgeLeafTip = {
    id: terminalLeafId,
    parentId: args.leafTip.parentId ?? null,
    type: args.leafTip.type || "message",
    ...(args.leafTip.timestampUtc ? { timestampUtc: args.leafTip.timestampUtc } : {}),
  };
  const sessionRoot = path.resolve(args.sessionRoot);
  const payloadDigest = args.contentId;
  const sourcePath = edgeSourcePath(sessionRoot, payloadDigest);
  try {
    await fs.stat(sourcePath);
  } catch {
    return {
      status: "source_failed",
      duration_ms: performance.now() - started,
      terminal_leaf_id: terminalLeafId,
      error_code: "source_missing",
      error_detail: sanitizeDiagnostic("existing source missing"),
    };
  }
  const sourceRef: EdgeSourceRef = {
    kind: "raw_sidecar",
    content_id: payloadDigest,
    relative_path: path.posix.join("sources", `${payloadDigest}.json`),
    byte_length: args.sourceByteLength,
  };

  try {
    await ensureSessionLayout(sessionRoot, args.abrainHome);
    type PairLockResult =
      | {
          kind: "complete";
          candidate: EdgeJournalRecord;
          candidatePath: string;
          candidateReused: boolean;
          witness: EdgeJournalRecord;
          witnessPath: string;
          witnessReused: boolean;
          c6Collision: boolean;
        }
      | {
          kind: "candidate_only";
          candidate: EdgeJournalRecord;
          candidatePath: string;
          candidateReused: boolean;
          c6Collision: boolean;
          error_code: string;
          error_detail?: string;
        }
      | { kind: "conflict"; error_code: string; error_detail: string }
      | { kind: "failed"; error_code: string; error_detail: string };

    const locked = await withJournalWriter(sessionRoot, args.abrainHome, async (writer): Promise<PairLockResult> => {
      const index = await loadJournalIndex(sessionRoot);
      writer.seedSeq(index.maxSeq + 1);
      const wantC6 = c6Key(c6);
      const sameLeaf = index.candidatesByLeaf.get(terminalLeafId) ?? [];
      const matching = sameLeaf.find((c) => c.record.payload_digest === payloadDigest) ?? null;
      if (!matching && sameLeaf.length > 0) {
        const otherDigest = sameLeaf[sameLeaf.length - 1]?.record.payload_digest;
        if (otherDigest && otherDigest !== payloadDigest) {
          return {
            kind: "conflict",
            error_code: "terminal_identity_content_conflict",
            error_detail: sanitizeDiagnostic("same terminal leaf already has a different content digest"),
          };
        }
      }
      const sameC6 = index.candidatesByC6.get(wantC6) ?? [];
      const c6Collision = sameC6.some((c) => {
        const otherLeaf = resolveTerminalLeafId({
          leafTip: c.record.leaf_tip,
          payloadDigest: c.record.payload_digest,
          sourceContentId: c.record.source_ref?.content_id,
        });
        return otherLeaf !== null && otherLeaf !== terminalLeafId;
      });

      let candidateReused = false;
      let candidateRecord: EdgeJournalRecord;
      let candidatePath: string;
      if (matching) {
        candidateReused = true;
        candidateRecord = matching.record;
        candidatePath = matching.path;
      } else {
        const producerSeq = writer.allocateSeq();
        const runGeneration = producerSeq;
        const createdAtRecord = args.createdAt ?? new Date().toISOString();
        const partial = {
          schema: EDGE_JOURNAL_SCHEMA,
          schema_version: EDGE_JOURNAL_SCHEMA_VERSION,
          session_id: sessionId,
          session_writer_epoch: writer.session_writer_epoch,
          record_type: "candidate_capture" as const,
          created_at: createdAtRecord,
          payload_digest: payloadDigest,
          c6,
          run_generation: runGeneration,
          source_ref: sourceRef,
          capabilities: EDGE_PROTOCOL_SHADOW_CAPABILITIES,
          leaf_tip: leafTip,
          deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"] as const,
        };
        const recordId = computeEdgeJournalRecordId(partial as Readonly<Record<string, unknown>>);
        candidateRecord = {
          ...partial,
          record_id: recordId,
          producer_seq: producerSeq,
          deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"],
        };
        candidatePath = edgeRecordPath(sessionRoot, producerSeq, recordId);
        const body = `${JSON.stringify(candidateRecord)}\n`;
        if (Buffer.byteLength(body, "utf-8") > EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES) {
          return {
            kind: "failed",
            error_code: "record_too_large",
            error_detail: sanitizeDiagnostic(`record exceeds ${EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES} bytes`),
          };
        }
        const status = await durableAtomicCreateFile(candidatePath, body, {
          mode: SOURCE_MODE,
          verifyCreated: false,
          tmpPath: edgeStagingTmpPath(sessionRoot, "record"),
        });
        if (status === "collision") {
          return {
            kind: "failed",
            error_code: "journal_record_collision",
            error_detail: sanitizeDiagnostic("journal record collision"),
          };
        }
        await assertMode(candidatePath, SOURCE_MODE);
        if (c6Collision) emitEdgeProtocolShadowDiagnosticOnce("c6_collision");
      }

      const existingWit = index.witnessByCandidateId.get(candidateRecord.record_id);
      if (existingWit) {
        return {
          kind: "complete",
          candidate: candidateRecord,
          candidatePath,
          candidateReused,
          witness: existingWit.record,
          witnessPath: existingWit.path,
          witnessReused: true,
          c6Collision,
        };
      }
      try {
        const wit = await writeWitnessRecordUnderLock({
          writer,
          sessionRoot,
          sessionId,
          c6,
          candidate: candidateRecord,
          leafTip,
          createdAt: args.createdAt,
        });
        return {
          kind: "complete",
          candidate: candidateRecord,
          candidatePath,
          candidateReused,
          witness: wit.record,
          witnessPath: wit.recordPath,
          witnessReused: false,
          c6Collision,
        };
      } catch (err) {
        return {
          kind: "candidate_only",
          candidate: candidateRecord,
          candidatePath,
          candidateReused,
          c6Collision,
          error_code: "witness_write_failed",
          error_detail: sanitizeDiagnostic(errMessage(err)),
        };
      }
    });

    if (locked.kind === "conflict") {
      emitEdgeProtocolShadowDiagnosticOnce(locked.error_code);
      return {
        status: "conflict",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        error_code: locked.error_code,
        error_detail: locked.error_detail,
      };
    }
    if (locked.kind === "failed") {
      return {
        status: "journal_failed",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        error_code: locked.error_code,
        error_detail: locked.error_detail,
      };
    }
    const candidateResult: EdgeCandidateCaptureResult = {
      status: "captured",
      duration_ms: 0,
      source: {
        content_id: payloadDigest,
        path: sourcePath,
        status: "identical",
        byte_length: args.sourceByteLength,
      },
      record: locked.candidate,
      record_path: locked.candidatePath,
    };
    if (locked.kind === "candidate_only") {
      return {
        status: "candidate_only",
        duration_ms: performance.now() - started,
        terminal_leaf_id: terminalLeafId,
        candidate: candidateResult,
        candidate_reused: locked.candidateReused,
        c6_collision: locked.c6Collision || undefined,
        error_code: locked.error_code,
        error_detail: locked.error_detail,
      };
    }
    return {
      status: "complete",
      duration_ms: performance.now() - started,
      terminal_leaf_id: terminalLeafId,
      candidate: candidateResult,
      witness: {
        status: "written",
        duration_ms: 0,
        record: locked.witness,
        record_path: locked.witnessPath,
      },
      candidate_reused: locked.candidateReused,
      witness_reused: locked.witnessReused,
      c6_collision: locked.c6Collision || undefined,
    };
  } catch (err) {
    return {
      status: "journal_failed",
      duration_ms: performance.now() - started,
      terminal_leaf_id: terminalLeafId,
      error_code: "pair_capture_failed",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
}

/**
 * Complete candidate-only pairs for ONE session (bounded).
 * Prefer {@link recoverEdgeProtocolMissingWitnessesForOwner} on session_start.
 */
export async function recoverEdgeProtocolMissingWitnesses(
  args: EdgeSessionInitArgs,
): Promise<EdgeMissingWitnessRecoveryResult> {
  const started = performance.now();
  if (!args.sessionId) {
    return {
      status: "failed",
      duration_ms: performance.now() - started,
      scanned: 0,
      recovered: 0,
      failed: 0,
      already_complete: 0,
      sessions_scanned: 0,
      error_code: "missing_session_id",
      error_detail: sanitizeDiagnostic("sessionId required"),
    };
  }
  try {
    const one = await recoverMissingWitnessesForSession({
      abrainHome: args.abrainHome,
      ownerProjectRoot: args.ownerProjectRoot,
      sessionId: args.sessionId,
    });
    return {
      status: "ready",
      duration_ms: performance.now() - started,
      scanned: one.scanned,
      recovered: one.recovered,
      failed: one.failed,
      already_complete: one.already_complete,
      sessions_scanned: 1,
      sessions_skipped: 0,
    };
  } catch (err) {
    return {
      status: "failed",
      duration_ms: performance.now() - started,
      scanned: 0,
      recovered: 0,
      failed: 0,
      already_complete: 0,
      sessions_scanned: 0,
      error_code: "witness_recovery_failed",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
}

/**
 * Owner-wide candidate-only recovery: walk all bounded sessions under the
 * owner key. Safe lstat walk + caps; symlink / unexpected entry fail closed
 * for that session (counted, not guessed). Same-C6 conflict does not invent.
 */
export async function recoverEdgeProtocolMissingWitnessesForOwner(args: {
  abrainHome: string;
  ownerProjectRoot: string;
  maxSessions?: number;
}): Promise<EdgeMissingWitnessRecoveryResult> {
  const started = performance.now();
  const maxSessions = args.maxSessions ?? RECOVERY_MAX_SESSIONS;
  let scanned = 0;
  let recovered = 0;
  let failed = 0;
  let already = 0;
  let sessionsScanned = 0;
  let sessionsSkipped = 0;
  try {
    const ownerKey = edgeOwnerKey(args.ownerProjectRoot);
    const sessionsDir = path.join(
      edgeProtocolShadowRoot(args.abrainHome),
      "by-owner",
      ownerKey,
      "sessions",
    );
    let names: string[];
    try {
      const st = await fs.lstat(sessionsDir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return {
          status: "failed",
          duration_ms: performance.now() - started,
          scanned: 0,
          recovered: 0,
          failed: 0,
          already_complete: 0,
          sessions_scanned: 0,
          sessions_skipped: 0,
          error_code: "sessions_dir_invalid",
          error_detail: sanitizeDiagnostic("sessions dir symlink or not directory"),
        };
      }
      names = await fs.readdir(sessionsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          status: "ready",
          duration_ms: performance.now() - started,
          scanned: 0,
          recovered: 0,
          failed: 0,
          already_complete: 0,
          sessions_scanned: 0,
          sessions_skipped: 0,
        };
      }
      throw err;
    }
    names.sort();
    for (const name of names) {
      if (sessionsScanned >= maxSessions) {
        sessionsSkipped += 1;
        continue;
      }
      const sessionPath = path.join(sessionsDir, name);
      try {
        const st = await fs.lstat(sessionPath);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          sessionsSkipped += 1;
          continue;
        }
      } catch {
        sessionsSkipped += 1;
        continue;
      }
      sessionsScanned += 1;
      try {
        const one = await recoverMissingWitnessesForSession({
          abrainHome: args.abrainHome,
          ownerProjectRoot: args.ownerProjectRoot,
          sessionId: name,
        });
        scanned += one.scanned;
        recovered += one.recovered;
        failed += one.failed;
        already += one.already_complete;
      } catch {
        sessionsSkipped += 1;
      }
    }
    return {
      status: "ready",
      duration_ms: performance.now() - started,
      scanned,
      recovered,
      failed,
      already_complete: already,
      sessions_scanned: sessionsScanned,
      sessions_skipped: sessionsSkipped,
    };
  } catch (err) {
    return {
      status: "failed",
      duration_ms: performance.now() - started,
      scanned,
      recovered,
      failed,
      already_complete: already,
      sessions_scanned: sessionsScanned,
      sessions_skipped: sessionsSkipped,
      error_code: "owner_witness_recovery_failed",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
}

const UNREF_SOURCE_RECOVERY_ACCEPTED_STOP = new Set(["stop", "length"]);

/**
 * Operator recovery for journal-unreferenced source sidecars.
 *
 * Default dry-run (no writes). `--execute` / `execute:true` writes candidate+witness
 * under the same session journal OFD lock + monotonic producer_seq. Never creates
 * semantic jobs / ACK / mutates source bytes. Never auto-invoked on session_start.
 *
 * Eligible sources: valid envelope, healthy terminal assistant, not already
 * referenced by a candidate. Terminal leaf identity for recovery uses the
 * content_id as a stable synthetic leaf (legacy_source_recovery) so redrive is
 * idempotent without inventing SessionManager tips.
 */
export async function recoverEdgeProtocolUnreferencedSources(args: {
  abrainHome: string;
  ownerProjectRoot?: string;
  sessionId?: string;
  limit?: number;
  execute?: boolean;
}): Promise<EdgeUnreferencedSourceRecoveryResult> {
  const started = performance.now();
  const mode: "dry_run" | "execute" = args.execute === true ? "execute" : "dry_run";
  const limit = args.limit !== undefined && Number.isInteger(args.limit) && args.limit > 0
    ? args.limit
    : Number.POSITIVE_INFINITY;
  const items: EdgeUnreferencedSourceRecoveryItem[] = [];
  let scanned = 0;
  let eligible = 0;
  let recovered = 0;
  let reused = 0;
  let failed = 0;
  let skipped = 0;
  let alreadyReferenced = 0;
  let sessionsScanned = 0;

  try {
    const abrainHome = path.resolve(args.abrainHome);
    const root = edgeProtocolShadowRoot(abrainHome);
    const byOwnerDir = path.join(root, "by-owner");
    let ownerKeys: string[];
    try {
      const st = await fs.lstat(byOwnerDir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return {
          status: "failed",
          mode,
          duration_ms: performance.now() - started,
          scanned: 0,
          eligible: 0,
          recovered: 0,
          reused: 0,
          failed: 0,
          skipped: 0,
          already_referenced: 0,
          sessions_scanned: 0,
          items: [],
          error_code: "edge_root_invalid",
          error_detail: sanitizeDiagnostic("by-owner is not a directory"),
        };
      }
      ownerKeys = await fs.readdir(byOwnerDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          status: "ready",
          mode,
          duration_ms: performance.now() - started,
          scanned: 0,
          eligible: 0,
          recovered: 0,
          reused: 0,
          failed: 0,
          skipped: 0,
          already_referenced: 0,
          sessions_scanned: 0,
          items: [],
        };
      }
      throw err;
    }

    const wantOwnerKey = args.ownerProjectRoot
      ? edgeOwnerKey(args.ownerProjectRoot)
      : null;
    ownerKeys.sort();
    for (const ownerKey of ownerKeys) {
      if (wantOwnerKey && ownerKey !== wantOwnerKey) continue;
      if (!/^[0-9a-f]{64}$/.test(ownerKey)) {
        skipped += 1;
        continue;
      }
      const sessionsDir = path.join(byOwnerDir, ownerKey, "sessions");
      let sessionNames: string[];
      try {
        const st = await fs.lstat(sessionsDir);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          skipped += 1;
          continue;
        }
        sessionNames = await fs.readdir(sessionsDir);
      } catch {
        continue;
      }
      sessionNames.sort();
      for (const sessionName of sessionNames) {
        if (args.sessionId && sessionName !== args.sessionId) continue;
        const sessionPath = path.join(sessionsDir, sessionName);
        try {
          const st = await fs.lstat(sessionPath);
          if (st.isSymbolicLink() || !st.isDirectory()) {
            skipped += 1;
            continue;
          }
        } catch {
          skipped += 1;
          continue;
        }
        sessionsScanned += 1;
        const sourcesDir = edgeSourcesDir(sessionPath);
        let sourceNames: string[];
        try {
          sourceNames = await fs.readdir(sourcesDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        const index = await loadJournalIndex(sessionPath);
        sourceNames.sort();
        for (const sourceName of sourceNames) {
          if (!/^[0-9a-f]{64}\.json$/.test(sourceName)) continue;
          if (scanned >= limit) break;
          scanned += 1;
          const contentId = sourceName.slice(0, 64);
          const contentPrefix = contentId.slice(0, 12);
          if (index.candidatesByContentId.has(contentId)) {
            alreadyReferenced += 1;
            items.push({
              session_id: sessionName,
              content_id_prefix: contentPrefix,
              result: "already_referenced",
            });
            continue;
          }

          const sourcePath = path.join(sourcesDir, sourceName);
          let raw: Buffer;
          try {
            raw = await fs.readFile(sourcePath);
          } catch (err) {
            failed += 1;
            items.push({
              session_id: sessionName,
              content_id_prefix: contentPrefix,
              result: "failed",
              error_code: "source_read_failed",
              error_detail: sanitizeDiagnostic(errMessage(err)),
            });
            continue;
          }
          const verified = verifyEdgeSourceEnvelopeBytes(raw, {
            sessionId: sessionName,
            contentId,
            byteLength: raw.byteLength,
          });
          if (!verified.ok) {
            skipped += 1;
            items.push({
              session_id: sessionName,
              content_id_prefix: contentPrefix,
              result: "skipped",
              error_code: verified.code,
            });
            continue;
          }
          let messages: unknown;
          try {
            messages = JSON.parse(verified.messages_raw);
          } catch {
            skipped += 1;
            items.push({
              session_id: sessionName,
              content_id_prefix: contentPrefix,
              result: "skipped",
              error_code: "messages_parse_failed",
            });
            continue;
          }
          if (!Array.isArray(messages) || !sourceHasHealthyTerminalAssistant(messages)) {
            skipped += 1;
            items.push({
              session_id: sessionName,
              content_id_prefix: contentPrefix,
              result: "skipped",
              error_code: "not_healthy_terminal",
            });
            continue;
          }

          eligible += 1;
          const leafTip = legacySourceRecoveryLeafTip(contentId);
          const terminalLeafId = leafTip.id;
          const c6: EdgeC6Identity = {
            session_id: sessionName,
            turn_id: "source_recovery",
            sub_agent_label: "unreferenced_source_recovery",
          };

          if (mode === "dry_run") {
            items.push({
              session_id: sessionName,
              content_id_prefix: contentPrefix,
              result: "would_recover",
              terminal_leaf_id: terminalLeafId,
            });
            continue;
          }

          try {
            // Admit the existing content-addressed source without re-serializing
            // messages (re-stringify would drift payload_digest and leave orphans).
            const pair = await admitExistingSourceAsTerminalPair({
              abrainHome,
              sessionRoot: sessionPath,
              sessionId: sessionName,
              contentId,
              sourceByteLength: raw.byteLength,
              c6,
              leafTip,
            });
            if (pair.status === "complete") {
              if (pair.candidate_reused && pair.witness_reused) {
                reused += 1;
                items.push({
                  session_id: sessionName,
                  content_id_prefix: contentPrefix,
                  result: "reused",
                  terminal_leaf_id: terminalLeafId,
                  c6_collision: pair.c6_collision,
                });
              } else {
                recovered += 1;
                items.push({
                  session_id: sessionName,
                  content_id_prefix: contentPrefix,
                  result: "recovered",
                  terminal_leaf_id: terminalLeafId,
                  c6_collision: pair.c6_collision,
                });
              }
              // Refresh content index for subsequent items in same session.
              if (pair.candidate?.record) {
                index.candidatesByContentId.set(contentId, {
                  record: pair.candidate.record,
                  path: pair.candidate.record_path ?? "",
                });
              }
            } else if (pair.status === "conflict") {
              failed += 1;
              items.push({
                session_id: sessionName,
                content_id_prefix: contentPrefix,
                result: "failed",
                terminal_leaf_id: terminalLeafId,
                error_code: pair.error_code ?? "conflict",
                error_detail: pair.error_detail,
              });
            } else {
              failed += 1;
              items.push({
                session_id: sessionName,
                content_id_prefix: contentPrefix,
                result: "failed",
                terminal_leaf_id: terminalLeafId,
                error_code: pair.error_code ?? pair.status,
                error_detail: pair.error_detail,
              });
            }
          } catch (err) {
            failed += 1;
            items.push({
              session_id: sessionName,
              content_id_prefix: contentPrefix,
              result: "failed",
              terminal_leaf_id: terminalLeafId,
              error_code: "pair_capture_threw",
              error_detail: sanitizeDiagnostic(errMessage(err)),
            });
          }
        }
        if (scanned >= limit) break;
      }
      if (scanned >= limit) break;
    }

    return {
      status: "ready",
      mode,
      duration_ms: performance.now() - started,
      scanned,
      eligible,
      recovered,
      reused,
      failed,
      skipped,
      already_referenced: alreadyReferenced,
      sessions_scanned: sessionsScanned,
      items,
    };
  } catch (err) {
    return {
      status: "failed",
      mode,
      duration_ms: performance.now() - started,
      scanned,
      eligible,
      recovered,
      reused,
      failed,
      skipped,
      already_referenced: alreadyReferenced,
      sessions_scanned: sessionsScanned,
      items,
      error_code: "unreferenced_source_recovery_failed",
      error_detail: sanitizeDiagnostic(errMessage(err)),
    };
  }
}

function sourceHasHealthyTerminalAssistant(messages: ReadonlyArray<unknown>): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const role = (m as Record<string, unknown>).role;
    if (role !== "assistant") continue;
    const stop = (m as Record<string, unknown>).stopReason;
    return typeof stop === "string" && UNREF_SOURCE_RECOVERY_ACCEPTED_STOP.has(stop);
  }
  return false;
}

export async function listEdgeJournalRecords(sessionRoot: string): Promise<EdgeJournalRecord[]> {
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: EdgeJournalRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const raw = await fs.readFile(path.join(dir, name), "utf-8");
    const parsed = JSON.parse(raw) as EdgeJournalRecord;
    if (parsed?.schema !== EDGE_JOURNAL_SCHEMA) continue;
    records.push(parsed);
  }
  records.sort((a, b) => a.producer_seq - b.producer_seq);
  return records;
}

/**
 * Latest candidate for C6: scan record filenames by producer_seq descending;
 * return on first matching candidate. Normal agent_settled hits near the newest
 * record — does not full-parse the journal.
 */
export async function findLatestCandidateForC6(
  sessionRoot: string,
  c6: EdgeC6Identity,
): Promise<{ record: EdgeJournalRecord; path: string } | null> {
  const want = c6Key(c6);
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // 20-digit zero-padded producer_seq prefix → lexicographic order == seq order.
  const newestFirst = names
    .filter((name) => RECORD_FILENAME_RE.test(name))
    .sort()
    .reverse();
  for (const name of newestFirst) {
    const full = path.join(dir, name);
    let parsed: EdgeJournalRecord;
    try {
      parsed = JSON.parse(await fs.readFile(full, "utf-8")) as EdgeJournalRecord;
    } catch {
      continue;
    }
    if (parsed.schema !== EDGE_JOURNAL_SCHEMA || parsed.record_type !== "candidate_capture") continue;
    if (c6Key(parsed.c6) !== want) continue;
    return { record: parsed, path: full };
  }
  return null;
}

/** Candidate by exact record_id (for pinned witness recovery). */
export async function findCandidateByRecordId(
  sessionRoot: string,
  recordId: string,
): Promise<{ record: EdgeJournalRecord; path: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(recordId)) return null;
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const name of names) {
    const parsedName = parseEdgeRecordFilename(name);
    if (!parsedName || parsedName.recordId !== recordId) continue;
    const full = path.join(dir, name);
    let parsed: EdgeJournalRecord;
    try {
      parsed = JSON.parse(await fs.readFile(full, "utf-8")) as EdgeJournalRecord;
    } catch {
      continue;
    }
    if (parsed.schema !== EDGE_JOURNAL_SCHEMA || parsed.record_type !== "candidate_capture") continue;
    if (parsed.record_id !== recordId) continue;
    return { record: parsed, path: full };
  }
  return null;
}

/**
 * Legacy helper: existing candidate for same C6 + payload_digest.
 * Pair admission no longer keys on C6; prefer {@link findCandidateForLeafAndDigest}.
 * Newest-first so concurrent retries latch onto the durable head for that content.
 */
export async function findCandidateForC6AndDigest(
  sessionRoot: string,
  c6: EdgeC6Identity,
  payloadDigest: string,
): Promise<{ record: EdgeJournalRecord; path: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(payloadDigest)) return null;
  const want = c6Key(c6);
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const newestFirst = names
    .filter((name) => RECORD_FILENAME_RE.test(name))
    .sort()
    .reverse();
  for (const name of newestFirst) {
    const full = path.join(dir, name);
    let parsed: EdgeJournalRecord;
    try {
      parsed = JSON.parse(await fs.readFile(full, "utf-8")) as EdgeJournalRecord;
    } catch {
      continue;
    }
    if (parsed.schema !== EDGE_JOURNAL_SCHEMA || parsed.record_type !== "candidate_capture") continue;
    if (parsed.payload_digest !== payloadDigest) continue;
    if (c6Key(parsed.c6) !== want) continue;
    return { record: parsed, path: full };
  }
  return null;
}

/**
 * Idempotent pair key: existing candidate for same terminal leaf + payload_digest.
 * Legacy rows without leaf_tip derive leaf id from content digest.
 */
export async function findCandidateForLeafAndDigest(
  sessionRoot: string,
  terminalLeafId: string,
  payloadDigest: string,
): Promise<{ record: EdgeJournalRecord; path: string } | null> {
  if (!terminalLeafId || !/^[0-9a-f]{64}$/.test(payloadDigest)) return null;
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const newestFirst = names
    .filter((name) => RECORD_FILENAME_RE.test(name))
    .sort()
    .reverse();
  for (const name of newestFirst) {
    const full = path.join(dir, name);
    let parsed: EdgeJournalRecord;
    try {
      parsed = JSON.parse(await fs.readFile(full, "utf-8")) as EdgeJournalRecord;
    } catch {
      continue;
    }
    if (parsed.schema !== EDGE_JOURNAL_SCHEMA || parsed.record_type !== "candidate_capture") continue;
    if (parsed.payload_digest !== payloadDigest) continue;
    const leafId = resolveTerminalLeafId({
      leafTip: parsed.leaf_tip,
      payloadDigest: parsed.payload_digest,
      sourceContentId: parsed.source_ref?.content_id,
    });
    if (leafId !== terminalLeafId) continue;
    return { record: parsed, path: full };
  }
  return null;
}

/** Existing terminal_witness for a candidate record_id (idempotent witness gate). */
export async function findTerminalWitnessForCandidate(
  sessionRoot: string,
  candidateRecordId: string,
): Promise<{ record: EdgeJournalRecord; path: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(candidateRecordId)) return null;
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // Newest-first: a late duplicate would still be found; callers treat any hit as complete.
  const newestFirst = names
    .filter((name) => RECORD_FILENAME_RE.test(name))
    .sort()
    .reverse();
  for (const name of newestFirst) {
    const full = path.join(dir, name);
    let parsed: EdgeJournalRecord;
    try {
      parsed = JSON.parse(await fs.readFile(full, "utf-8")) as EdgeJournalRecord;
    } catch {
      continue;
    }
    if (parsed.schema !== EDGE_JOURNAL_SCHEMA || parsed.record_type !== "terminal_witness") continue;
    if (parsed.candidate_ref?.record_id !== candidateRecordId) continue;
    return { record: parsed, path: full };
  }
  return null;
}

// ── internals ──────────────────────────────────────────────────────────

interface JournalWriter {
  /** This process's journal writer identity (not SessionManager / launch fence). */
  session_writer_epoch: string;
  allocateSeq(): number;
  /** When caller already loaded a journal index under the lock, seed next seq. */
  seedSeq(next: number): void;
}

interface JournalIndexEntry {
  record: EdgeJournalRecord;
  path: string;
  name: string;
}

interface JournalIndex {
  maxSeq: number;
  byRecordId: Map<string, JournalIndexEntry>;
  /** Attribution index only — not pair admission. */
  candidatesByC6: Map<string, Array<{ record: EdgeJournalRecord; path: string }>>;
  /** Durable pair admission index: terminal leaf id → candidates (legacy-derived when needed). */
  candidatesByLeaf: Map<string, Array<{ record: EdgeJournalRecord; path: string }>>;
  /** content_id → candidate (for unreferenced-source scans). */
  candidatesByContentId: Map<string, { record: EdgeJournalRecord; path: string }>;
  witnessByCandidateId: Map<string, { record: EdgeJournalRecord; path: string }>;
}

/**
 * OFD lock + allocate next producer_seq from record filenames only.
 * No secondary writer-state head: crash recovery re-scans filenames under the lock.
 * Callers that load a full journal index under the lock should `seedSeq` from that
 * index so seq allocation does not re-scan filenames a second time.
 */
async function withJournalWriter<T>(
  sessionRoot: string,
  abrainHome: string,
  fn: (writer: JournalWriter) => Promise<T>,
): Promise<T> {
  // Lock dir is part of session layout (already durable-ensured by caller).
  await ensureDirOwned(edgeJournalLockDir(sessionRoot), abrainHome);
  // Ensure exact realpath (no symlinks) for OFD lock protocol.
  const realLock = await fs.realpath(edgeJournalLockDir(sessionRoot));

  let lastBusy = false;
  for (let attempt = 0; attempt < LOCK_BUSY_RETRIES; attempt += 1) {
    const locked = await withRetainedDirectoryOfdLock(realLock, async () => {
      // Default: max(record filename seq)+1 under OFD lock. Pair path seeds from index.
      let nextSeq = (await scanMaxProducerSeq(sessionRoot)) + 1;
      const writer: JournalWriter = {
        session_writer_epoch: PROCESS_JOURNAL_WRITER_EPOCH,
        allocateSeq() {
          const seq = nextSeq;
          nextSeq += 1;
          return seq;
        },
        seedSeq(next: number) {
          if (Number.isInteger(next) && next >= 1) nextSeq = next;
        },
      };
      return fn(writer);
    });
    if (locked.status === "ACQUIRED") return locked.value;
    lastBusy = true;
    await sleep(LOCK_BUSY_SLEEP_MS);
  }
  throw new Error(lastBusy ? "journal writer lock busy" : "journal writer lock failed");
}

async function scanMaxProducerSeq(sessionRoot: string): Promise<number> {
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let max = 0;
  for (const name of names) {
    const m = RECORD_FILENAME_RE.exec(name);
    if (!m) continue;
    const seq = Number(m[1]);
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max;
}

/** One full parse of journal/records under the caller's OFD lock. */
async function loadJournalIndex(sessionRoot: string): Promise<JournalIndex> {
  const dir = edgeJournalRecordsDir(sessionRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        maxSeq: 0,
        byRecordId: new Map(),
        candidatesByC6: new Map(),
        candidatesByLeaf: new Map(),
        candidatesByContentId: new Map(),
        witnessByCandidateId: new Map(),
      };
    }
    throw err;
  }
  const byRecordId = new Map<string, JournalIndexEntry>();
  const candidatesByC6 = new Map<string, Array<{ record: EdgeJournalRecord; path: string }>>();
  const candidatesByLeaf = new Map<string, Array<{ record: EdgeJournalRecord; path: string }>>();
  const candidatesByContentId = new Map<string, { record: EdgeJournalRecord; path: string }>();
  const witnessByCandidateId = new Map<string, { record: EdgeJournalRecord; path: string }>();
  let maxSeq = 0;
  const sorted = names.filter((n) => RECORD_FILENAME_RE.test(n)).sort();
  for (const name of sorted) {
    const parsedName = parseEdgeRecordFilename(name);
    if (!parsedName) continue;
    if (parsedName.producerSeq > maxSeq) maxSeq = parsedName.producerSeq;
    const full = path.join(dir, name);
    let record: EdgeJournalRecord;
    try {
      record = JSON.parse(await fs.readFile(full, "utf-8")) as EdgeJournalRecord;
    } catch {
      continue;
    }
    if (record.schema !== EDGE_JOURNAL_SCHEMA) continue;
    const entry: JournalIndexEntry = { record, path: full, name };
    byRecordId.set(record.record_id, entry);
    if (record.record_type === "candidate_capture") {
      const key = c6Key(record.c6);
      const list = candidatesByC6.get(key) ?? [];
      list.push({ record, path: full });
      candidatesByC6.set(key, list);
      const leafId = resolveTerminalLeafId({
        leafTip: record.leaf_tip,
        payloadDigest: record.payload_digest,
        sourceContentId: record.source_ref?.content_id,
      });
      if (leafId) {
        const leafList = candidatesByLeaf.get(leafId) ?? [];
        leafList.push({ record, path: full });
        candidatesByLeaf.set(leafId, leafList);
      }
      const contentId = record.source_ref?.content_id ?? record.payload_digest;
      if (typeof contentId === "string" && /^[0-9a-f]{64}$/.test(contentId)) {
        // Newest wins (sorted ascending).
        candidatesByContentId.set(contentId, { record, path: full });
      }
    } else if (record.record_type === "terminal_witness" && record.candidate_ref?.record_id) {
      // Keep newest for the candidate (sorted ascending → last wins).
      witnessByCandidateId.set(record.candidate_ref.record_id, { record, path: full });
    }
  }
  return {
    maxSeq,
    byRecordId,
    candidatesByC6,
    candidatesByLeaf,
    candidatesByContentId,
    witnessByCandidateId,
  };
}

function indexFindLatestCandidateForC6(
  index: JournalIndex,
  c6: EdgeC6Identity,
): { record: EdgeJournalRecord; path: string } | null {
  const list = index.candidatesByC6.get(c6Key(c6));
  if (!list || list.length === 0) return null;
  return list[list.length - 1] ?? null;
}

/**
 * Content-addressed sidecar create/verify. Always attempts durable create;
 * identical = reuse; collision = fail closed. Test fault gated.
 */
async function createOrVerifyEdgeSidecar(
  sessionRoot: string,
  sourcePath: string,
  sourceBody: string,
): Promise<EdgeWriteStatus> {
  maybeThrowSourceCreateFaultForTests();
  const status = await durableAtomicCreateFile(sourcePath, sourceBody, {
    mode: SOURCE_MODE,
    verifyCreated: false,
    tmpPath: edgeStagingTmpPath(sessionRoot, "source"),
  });
  if (status === "collision") {
    throw new Error("source_collision");
  }
  await assertMode(sourcePath, SOURCE_MODE);
  return status;
}

async function writeWitnessRecordUnderLock(args: {
  writer: JournalWriter;
  sessionRoot: string;
  sessionId: string;
  c6: EdgeC6Identity;
  candidate: EdgeJournalRecord;
  leafTip?: EdgeLeafTip;
  createdAt?: string;
}): Promise<{ kind: "written"; record: EdgeJournalRecord; recordPath: string }> {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const candidateRef: EdgeCandidateRef = {
    record_id: args.candidate.record_id,
    producer_seq: args.candidate.producer_seq,
    payload_digest: args.candidate.payload_digest,
    run_generation: args.candidate.run_generation,
  };
  const producerSeq = args.writer.allocateSeq();
  const partial = {
    schema: EDGE_JOURNAL_SCHEMA,
    schema_version: EDGE_JOURNAL_SCHEMA_VERSION,
    session_id: args.sessionId,
    session_writer_epoch: args.writer.session_writer_epoch,
    record_type: "terminal_witness" as const,
    created_at: createdAt,
    payload_digest: args.candidate.payload_digest,
    c6: args.c6,
    run_generation: args.candidate.run_generation,
    candidate_ref: candidateRef,
    source_ref: args.candidate.source_ref,
    capabilities: EDGE_PROTOCOL_SHADOW_CAPABILITIES,
    settlement_status: "unsupported_core_capability" as const,
    ...(args.leafTip ? { leaf_tip: args.leafTip } : {}),
    deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"] as const,
  };
  const recordId = computeEdgeJournalRecordId(partial as Readonly<Record<string, unknown>>);
  const record: EdgeJournalRecord = {
    ...partial,
    record_id: recordId,
    producer_seq: producerSeq,
    deferred_by_missing_core: ["session_transaction", "launch_broker", "terminal_seal", "link_open_close"],
  };
  const recordPath = edgeRecordPath(args.sessionRoot, producerSeq, recordId);
  const body = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(body, "utf-8") > EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES) {
    throw new Error("record_too_large");
  }
  const status = await durableAtomicCreateFile(recordPath, body, {
    mode: SOURCE_MODE,
    verifyCreated: false,
    tmpPath: edgeStagingTmpPath(args.sessionRoot, "record"),
  });
  if (status === "collision") throw new Error("journal witness collision");
  await assertMode(recordPath, SOURCE_MODE);
  return { kind: "written" as const, record, recordPath };
}

async function recoverMissingWitnessesForSession(args: {
  abrainHome: string;
  ownerProjectRoot: string;
  sessionId: string;
}): Promise<{ scanned: number; recovered: number; failed: number; already_complete: number }> {
  const sessionRoot = edgeSessionRoot(args.abrainHome, args.ownerProjectRoot, args.sessionId);
  // Do not create layout for sessions that never had producer product.
  try {
    await fs.lstat(edgeJournalRecordsDir(sessionRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, recovered: 0, failed: 0, already_complete: 0 };
    }
    throw err;
  }
  await ensureSessionLayout(sessionRoot, args.abrainHome);
  const index = await loadJournalIndex(sessionRoot);
  const candidates: Array<{ record: EdgeJournalRecord; path: string }> = [];
  for (const list of index.candidatesByC6.values()) {
    for (const c of list) candidates.push(c);
  }
  candidates.sort((a, b) => a.record.producer_seq - b.record.producer_seq);
  const bounded = candidates.slice(0, RECOVERY_MAX_CANDIDATES_PER_SESSION);
  let recovered = 0;
  let failed = 0;
  let already = 0;
  for (const cand of bounded) {
    if (index.witnessByCandidateId.has(cand.record.record_id)) {
      already += 1;
      continue;
    }
    // Sidecar must exist; never invent witness for missing source.
    if (cand.record.source_ref?.content_id) {
      try {
        await fs.stat(edgeSourcePath(sessionRoot, cand.record.source_ref.content_id));
      } catch {
        failed += 1;
        continue;
      }
    }
    const wit = await writeEdgeTerminalWitness({
      abrainHome: args.abrainHome,
      ownerProjectRoot: args.ownerProjectRoot,
      sessionId: args.sessionId,
      c6: cand.record.c6,
      leafTip: cand.record.leaf_tip,
      candidateRecordId: cand.record.record_id,
      idempotentReuse: true,
    });
    if (wit.status === "written") {
      recovered += 1;
      if (wit.record) {
        index.witnessByCandidateId.set(cand.record.record_id, {
          record: wit.record,
          path: wit.record_path ?? "",
        });
      }
    } else {
      failed += 1;
    }
  }
  return {
    scanned: bounded.length,
    recovered,
    failed,
    already_complete: already,
  };
}

/**
 * Durable layered mkdir under abrainHome ownership root.
 * Walks ownershipRoot → target component-by-component with lstat (no intermediate
 * symlink follow / path escape). ownershipRoot itself must be a non-symlink dir.
 * Only newly created directories: mode 0700, fsync(parent), fsync(self).
 * Existing directories: reject symlink/non-directory; tighten target mode if needed; no fsync.
 * Never chmod ancestors above abrainHome. First full-path create remains crash-durable.
 */
async function ensureSessionLayout(sessionRoot: string, abrainHome: string): Promise<void> {
  await ensureDirOwned(sessionRoot, abrainHome);
  await ensureDirOwned(edgeSourcesDir(sessionRoot), abrainHome);
  await ensureDirOwned(edgeStagingDir(sessionRoot), abrainHome);
  await ensureDirOwned(edgeJournalDir(sessionRoot), abrainHome);
  await ensureDirOwned(edgeJournalRecordsDir(sessionRoot), abrainHome);
  await ensureDirOwned(edgeJournalLockDir(sessionRoot), abrainHome);
}

function isUnderOrEqual(target: string, root: string): boolean {
  const t = path.resolve(target);
  const r = path.resolve(root);
  return t === r || t.startsWith(r + path.sep);
}

async function ensureDirOwned(target: string, abrainHome: string): Promise<void> {
  const resolvedTarget = path.resolve(target);
  const ownershipRoot = path.resolve(abrainHome);
  if (!isUnderOrEqual(resolvedTarget, ownershipRoot)) {
    throw new Error("edge layout target outside abrainHome ownership root");
  }

  // ownershipRoot is the trusted start: must itself be a real (non-symlink) directory.
  // Never lstat(target) first — that would follow intermediate symlinks and escape root.
  const rootSt = await fs.lstat(ownershipRoot);
  if (rootSt.isSymbolicLink()) throw new Error("symlink in edge layout path");
  if (!rootSt.isDirectory()) throw new Error("edge layout path is not a directory");

  if (resolvedTarget === ownershipRoot) {
    if ((rootSt.mode & 0o777) !== DIR_MODE) {
      await fs.chmod(resolvedTarget, DIR_MODE);
    }
    return;
  }

  const rel = path.relative(ownershipRoot, resolvedTarget);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("edge layout target outside abrainHome ownership root");
  }

  const parts = rel.split(path.sep).filter((p) => p && p !== ".");
  let cursor = ownershipRoot;
  let firstMissing = -1;

  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]!);
    try {
      const st = await fs.lstat(cursor);
      if (st.isSymbolicLink()) throw new Error("symlink in edge layout path");
      if (!st.isDirectory()) throw new Error("edge layout path is not a directory");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      firstMissing = i;
      break;
    }
  }

  if (firstMissing === -1) {
    // Entire path exists and every component was lstat'd as a real directory.
    // Tighten target mode only — no fsync every call.
    const st = await fs.lstat(resolvedTarget);
    if (st.isSymbolicLink()) throw new Error("symlink in edge layout path");
    if (!st.isDirectory()) throw new Error("edge layout path is not a directory");
    if ((st.mode & 0o777) !== DIR_MODE) {
      await fs.chmod(resolvedTarget, DIR_MODE);
    }
    return;
  }

  // Create missing components from first ENOENT through target (parent already verified real dir).
  cursor = ownershipRoot;
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]!);
    if (i < firstMissing) continue;
    try {
      await fs.mkdir(cursor, { mode: DIR_MODE });
    } catch (err) {
      // Concurrent creators may race the same edge path; EEXIST is fine if still a real dir.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = await fs.lstat(cursor);
      if (st.isSymbolicLink()) throw new Error("symlink in edge layout path");
      if (!st.isDirectory()) throw new Error("edge layout path is not a directory");
    }
    // Only this create path is crash-durable: force 0700 + fsync parent/self.
    await fs.chmod(cursor, DIR_MODE);
    await fsyncDirectory(path.dirname(cursor));
    await fsyncDirectory(cursor);
  }
}

async function assertMode(filePath: string, mode: number): Promise<void> {
  const st = await fs.stat(filePath);
  if ((st.mode & 0o777) !== mode) {
    // Attempt repair once (umask may have stripped bits on some FS).
    await fs.chmod(filePath, mode);
  }
}

function normalizeC6(c6: EdgeC6Identity): EdgeC6Identity {
  if (!c6.session_id) throw new Error("c6.session_id required");
  if (c6.turn_id === undefined || c6.turn_id === null || c6.turn_id === "") throw new Error("c6.turn_id required");
  return {
    session_id: String(c6.session_id),
    turn_id: c6.turn_id,
    ...(c6.subturn !== undefined ? { subturn: c6.subturn } : {}),
    ...(c6.sub_agent_label ? { sub_agent_label: c6.sub_agent_label } : {}),
    ...(c6.parent ? { parent: c6.parent } : {}),
  };
}

function sanitizeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) throw new Error("empty sessionId");
  // Reject `.` / `..` / pure-dot strings (path traversal / ambiguous components).
  if (/^\.+$/.test(trimmed)) throw new Error("invalid sessionId: pure-dot");
  if (/^[A-Za-z0-9._-]+$/.test(trimmed) && trimmed.length <= 200) return trimmed;
  return `h_${sha256Hex(trimmed)}`;
}

function assertContentId(id: string): void {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`invalid content/record id: ${id}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sanitizeDiagnostic(detail: string): string {
  // Never retain absolute filesystem paths in returned error_detail.
  // Match common absolute path prefixes only (low false-positive risk).
  return detail
    .replace(/(?:[A-Za-z]:)?(?:\/|\\)(?:home|Users|tmp|var|private|root|opt|usr|mnt|data)(?:\/|\\)[\w.\/\\-]+/g, "<path>")
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 200);
}

function failCandidate(
  started: number,
  code: string,
  detail: string,
  source?: EdgeCandidateCaptureResult["source"],
): EdgeCandidateCaptureResult {
  const journalish =
    code === "journal_write_failed"
    || code === "record_too_large"
    || code === "capture_failed"
    || code === "missing_session_id"
    || code === "invalid_c6"
    || code === "session_c6_mismatch";
  return {
    status: journalish ? "journal_failed" : "source_failed",
    duration_ms: performance.now() - started,
    source,
    error_code: code,
    error_detail: sanitizeDiagnostic(detail),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Synchronous existence probe used by disabled-path zero-product checks. */
export function edgeProtocolShadowExistsSync(abrainHome: string): boolean {
  try {
    return fsSync.existsSync(edgeProtocolShadowRoot(abrainHome));
  } catch {
    return false;
  }
}

/** Test-only: expose sanitizeSessionId failure modes for pure-dot rejection. */
export function _sanitizeSessionIdForTests(sessionId: string): string {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error("_sanitizeSessionIdForTests requires PI_ASTACK_ENABLE_TEST_HOOKS=1");
  }
  return sanitizeSessionId(sessionId);
}
