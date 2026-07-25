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

export function edgeSourcePath(sessionRoot: string, contentId: string): string {
  assertContentId(contentId);
  return path.join(edgeSourcesDir(sessionRoot), `${contentId}.json`);
}

export function edgeRecordPath(sessionRoot: string, producerSeq: number, recordId: string): string {
  assertContentId(recordId);
  if (!Number.isInteger(producerSeq) || producerSeq < 1) throw new Error(`invalid producer_seq: ${producerSeq}`);
  return path.join(edgeJournalRecordsDir(sessionRoot), `${String(producerSeq).padStart(20, "0")}__${recordId}.json`);
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
    const sourcePath = edgeSourcePath(sessionRoot, payloadDigest);
    let sourceStatus: EdgeWriteStatus;
    try {
      // Fail closed BEFORE durable source create — never write candidate without source.
      maybeThrowSourceCreateFaultForTests();
      // verifyCreated=false: link(temp,target) shares already-fsynced temp inode.
      sourceStatus = await durableAtomicCreateFile(sourcePath, sourceBody, {
        mode: SOURCE_MODE,
        verifyCreated: false,
      });
      if (sourceStatus === "collision") {
        // Same content_id with different bytes is a hard integrity failure.
        return failCandidate(started, "source_collision", "content-addressed source collision");
      }
      await assertMode(sourcePath, SOURCE_MODE);
    } catch (err) {
      return failCandidate(started, "source_write_failed", errMessage(err));
    }

    const sourceRef: EdgeSourceRef = {
      kind: "raw_sidecar",
      content_id: payloadDigest,
      relative_path: path.posix.join("sources", `${payloadDigest}.json`),
      byte_length: Buffer.byteLength(sourceBody, "utf-8"),
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
        const status = await durableAtomicCreateFile(recordPath, body, {
          mode: SOURCE_MODE,
          verifyCreated: false,
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
      return failCandidate(started, "journal_write_failed", errMessage(err), {
        content_id: payloadDigest,
        path: sourcePath,
        status: sourceStatus,
        byte_length: sourceRef.byte_length,
      });
    }
  } catch (err) {
    return failCandidate(started, "capture_failed", errMessage(err));
  }
}

/**
 * agent_settled: local durable TerminalWitness only.
 * References latest candidate for this session/C6. Never terminal_seal / TurnSettled.
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
    // findLatest + allocateSeq + durable witness create must share one OFD lock
    // critical section so concurrent candidate writers cannot race the ref.
    const written = await withJournalWriter(sessionRoot, args.abrainHome, async (writer) => {
      const latest = await findLatestCandidateForC6(sessionRoot, c6);
      if (!latest) return null;
      const createdAt = args.createdAt ?? new Date().toISOString();
      const candidateRef: EdgeCandidateRef = {
        record_id: latest.record.record_id,
        producer_seq: latest.record.producer_seq,
        payload_digest: latest.record.payload_digest,
        run_generation: latest.record.run_generation,
      };
      const producerSeq = writer.allocateSeq();
      const partial = {
        schema: EDGE_JOURNAL_SCHEMA,
        schema_version: EDGE_JOURNAL_SCHEMA_VERSION,
        session_id: sessionId,
        session_writer_epoch: writer.session_writer_epoch,
        record_type: "terminal_witness" as const,
        created_at: createdAt,
        payload_digest: latest.record.payload_digest,
        c6,
        // Witness does not invent a new execution generation; it seals nothing.
        run_generation: latest.record.run_generation,
        candidate_ref: candidateRef,
        source_ref: latest.record.source_ref,
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
      const recordPath = edgeRecordPath(sessionRoot, producerSeq, recordId);
      const status = await durableAtomicCreateFile(recordPath, `${JSON.stringify(record)}\n`, {
        mode: SOURCE_MODE,
        verifyCreated: false,
      });
      if (status === "collision") throw new Error("journal witness collision");
      await assertMode(recordPath, SOURCE_MODE);
      return { record, recordPath };
    });
    if (!written) {
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

// ── internals ──────────────────────────────────────────────────────────

interface JournalWriter {
  /** This process's journal writer identity (not SessionManager / launch fence). */
  session_writer_epoch: string;
  allocateSeq(): number;
}

/**
 * OFD lock + allocate next producer_seq from record filenames only.
 * No secondary writer-state head: crash recovery re-scans filenames under the lock.
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
      // producer_seq unique truth: max(record filename seq)+1 under OFD lock, then durable create.
      let nextSeq = (await scanMaxProducerSeq(sessionRoot)) + 1;
      const writer: JournalWriter = {
        session_writer_epoch: PROCESS_JOURNAL_WRITER_EPOCH,
        allocateSeq() {
          const seq = nextSeq;
          nextSeq += 1;
          return seq;
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
  return {
    status: code.startsWith("source_") ? "source_failed" : code === "journal_write_failed" ? "journal_failed" : "source_failed",
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
