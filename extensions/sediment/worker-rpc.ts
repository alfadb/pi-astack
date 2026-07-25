/**
 * Stage0 daemon-hosted sediment worker-safe RPC command surface.
 *
 * Env: PI_ASTACK_SEDIMENT_WORKER_MODE=1
 * Required env (worker only):
 *   PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT  — canonical daemon copy-store root
 *   PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS — JSON array of realpath owner roots
 * Command: /sediment-worker-run <json|base64url-json>
 *
 * Not a formal ConsumerAck / authority / retention path. Daemon owns lifecycle.
 * Reuses the existing agent_end pass body (extractor/curator/writer) against
 * source-session sidecar messages + owner project root — never the worker
 * command session itself. Does not register ordinary lifecycle hooks.
 *
 * Receipts mean processed settled success only. Transient failures leave no
 * durable receipt (retryable). Linux-only OFD claim locks (Stage0). Receipts
 * and claims have no GC (known Stage0 bound).
 */

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, fsyncDirectory } from "../_shared/durable-write";
import { acquireRetainedDirectoryOfdLock } from "../_shared/retained-directory-ofd-lock";
import {
  EDGE_SOURCE_SCHEMA,
  computePayloadDigest,
  edgeOwnerKey,
  extractTopLevelJsonFieldRaw,
  verifyEdgeSourceEnvelopeBytes,
  type EdgeC6Identity,
  type EdgeLeafTip,
} from "./edge-protocol-shadow";

export const SEDIMENT_WORKER_MODE_ENV = "PI_ASTACK_SEDIMENT_WORKER_MODE" as const;
export const SEDIMENT_WORKER_COPY_STORE_ROOT_ENV = "PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT" as const;
export const SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS_ENV = "PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS" as const;
export const SEDIMENT_WORKER_TASK_SCHEMA = "pi-astack/sediment-worker-task/v1" as const;
export const SEDIMENT_WORKER_RESULT_SCHEMA = "pi-astack/sediment-worker-result/v1" as const;
export const SEDIMENT_WORKER_RECEIPT_SCHEMA = "pi-astack/sediment-worker-receipt/v1" as const;
export const SEDIMENT_WORKER_COMMAND_NAME = "sediment-worker-run" as const;
export const SEDIMENT_WORKER_RESULT_NOTIFY_PREFIX = "sediment-worker-result:" as const;

/** Hard cap for source sidecar regular files (matches daemon copy-store bound). */
export const SEDIMENT_WORKER_SIDECAR_MAX_BYTES = 8 * 1024 * 1024;
/** Manifest argv / base64url decoded bound. */
export const SEDIMENT_WORKER_ARGS_MAX_BYTES = 64 * 1024;
/** In-worker more=true continuation budget (ready-pending backlog). */
export const SEDIMENT_WORKER_MORE_BUDGET = 16;

const HEX64_RE = /^[0-9a-f]{64}$/;
const SAFE_INT_RE = /^-?(0|[1-9][0-9]*)$/;

const MANIFEST_TOP_KEYS = new Set([
  "schema",
  "request_id",
  "terminal_record_id",
  "session_id",
  "owner_project_root",
  "owner_key",
  "sidecar_path",
  "content_id",
  "task_kind",
  "c6",
  "leaf_tip",
  "candidate_ref",
]);
const C6_KEYS = new Set(["session_id", "turn_id", "subturn", "sub_agent_label", "parent"]);
const LEAF_TIP_KEYS = new Set(["id", "parentId", "type", "timestampUtc"]);
const CANDIDATE_REF_KEYS = new Set(["record_id", "producer_seq", "payload_digest", "run_generation"]);

export type SedimentWorkerTaskStatus =
  | "processed"
  | "already_processed"
  | "busy"
  | "failed";

export interface SedimentWorkerTaskManifest {
  schema: typeof SEDIMENT_WORKER_TASK_SCHEMA;
  request_id: string;
  /** Idempotency key (= terminal witness record_id). */
  terminal_record_id: string;
  session_id: string;
  /** Absolute canonical owner project root (realpath). Never guessed from worker cwd. */
  owner_project_root: string;
  /** Required; must equal sha256(abs owner_project_root). */
  owner_key: string;
  /** Absolute path to edge-source/v1 sidecar under daemon copy-store root. */
  sidecar_path: string;
  /** Required content_id; must match envelope + messages digest. */
  content_id: string;
  /** Stage0: only terminal_witness tasks are admitted. */
  task_kind: "terminal_witness";
  c6: EdgeC6Identity;
  leaf_tip?: EdgeLeafTip;
  candidate_ref?: {
    record_id: string;
    producer_seq: number;
    payload_digest: string;
    run_generation: number;
  };
}

export interface SedimentWorkerResult {
  schema: typeof SEDIMENT_WORKER_RESULT_SCHEMA;
  request_id: string;
  terminal_record_id: string;
  status: SedimentWorkerTaskStatus;
  /** True only for processed / already_processed settled success. */
  settled: boolean;
  /** True when daemon/caller may safely retry (no success receipt written). */
  retryable: boolean;
  memory_decisions: number;
  memory_writes: number;
  error_code?: string;
  /** Pass iterations executed inside this command (more-loop count). */
  pass_iterations?: number;
}

export interface SedimentWorkerPassSnapshot {
  readonly cwd: string;
  readonly sessionId?: string;
  /**
   * Independent checkpoint session slot for daemon worker evaluation.
   * Does not share the foreground source session watermark.
   * Provenance/C6 remain on sessionId + anchor.
   */
  readonly checkpointSessionId?: string;
  readonly sessionFile?: string;
  readonly branchEntries: readonly unknown[];
  readonly messages: readonly Readonly<{
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  }>[];
  readonly modelRegistry?: unknown;
  readonly anchor: {
    session_id: string;
    turn_id: number;
    subturn?: number;
    sub_agent_label?: string;
  };
  readonly boundaryUntrusted: boolean;
}

export type SedimentWorkerPassRunner = (
  snapshot: SedimentWorkerPassSnapshot,
  opts?: { intakeWindowId?: string; fromRecovery?: boolean },
) => Promise<void | { more: true }>;

export interface SedimentWorkerCommandDeps {
  runAgentEndPass: SedimentWorkerPassRunner;
  resolveAbrainHome: () => string;
  /** Must be "daemon" for worker to execute; otherwise execution_owner_not_daemon. */
  resolveExecutionOwner: () => "foreground" | "daemon";
  /**
   * After settled processed success, drain knowledge publication outbox once.
   * Worker cannot wait for foreground session_start.
   */
  drainKnowledgePublicationOutbox?: (abrainHome: string) => Promise<void> | void;
  /** Optional model registry from the worker process (usually undefined). */
  modelRegistry?: unknown;
  now?: () => Date;
  /** Optional env override for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Authoritative checkpoint probe used before/after each pass.
   * Worker treats real lastProcessedEntryId advancement as progress.
   */
  loadSessionCheckpoint: (
    projectRoot: string,
    sessionId: string | undefined,
  ) => Promise<{ lastProcessedEntryId?: string }>;
}

export function isSedimentWorkerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SEDIMENT_WORKER_MODE_ENV] === "1";
}

/** Stable independent checkpoint slot for a source session (daemon worker). */
export function workerCheckpointSessionId(sourceSessionId: string): string {
  return `daemon-worker:${sha256Hex(sourceSessionId)}`;
}

export function sedimentWorkerRoot(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "worker");
}

export function sedimentWorkerReceiptsDir(abrainHome: string): string {
  return path.join(sedimentWorkerRoot(abrainHome), "receipts");
}

export function sedimentWorkerClaimsDir(abrainHome: string): string {
  return path.join(sedimentWorkerRoot(abrainHome), "claims");
}

export function sedimentWorkerReceiptPath(abrainHome: string, terminalRecordId: string): string {
  assertHex64(terminalRecordId, "terminal_record_id");
  return path.join(sedimentWorkerReceiptsDir(abrainHome), `${terminalRecordId}.json`);
}

function assertHex64(value: string, field: string): void {
  if (!HEX64_RE.test(value)) throw new WorkerValidationError("invalid_hex64", `${field} must be 64 lowercase hex`);
}

export class WorkerValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerValidationError";
    this.code = code;
  }
}

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) && p === path.resolve(p);
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, code: string, label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new WorkerValidationError(code, `${label} unknown field: ${key}`);
    }
  }
}

/**
 * Accept only number or numeric string that convert losslessly to a safe integer.
 * Non-numeric → unsupported (never silent 0).
 */
export function parseSafeIntegerField(raw: unknown, field: string): number {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) {
      throw new WorkerValidationError("unsupported_integer", `${field} must be a safe integer`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!SAFE_INT_RE.test(t)) {
      throw new WorkerValidationError("unsupported_integer", `${field} must be a numeric integer string`);
    }
    const n = Number(t);
    if (!Number.isSafeInteger(n)) {
      throw new WorkerValidationError("unsupported_integer", `${field} must be a safe integer`);
    }
    // Lossless only: reject leading zeros ("01"), plus signs, scientific notation
    // (already blocked by SAFE_INT_RE). Allow "-0" → 0.
    if (t !== String(n) && t !== "-0") {
      throw new WorkerValidationError("unsupported_integer", `${field} numeric string is not lossless`);
    }
    return n;
  }
  throw new WorkerValidationError("unsupported_integer", `${field} must be number or numeric string`);
}

/**
 * Decode command args: single-line JSON, or base64url(JSON). Never log raw body.
 * Hard cap 64KiB on raw args and decoded bytes.
 */
export function parseSedimentWorkerManifestArgs(args: string): SedimentWorkerTaskManifest {
  const trimmed = (args ?? "").trim();
  if (!trimmed) throw new WorkerValidationError("empty_args", "manifest args required");
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new WorkerValidationError("multiline_args", "manifest must be single-line");
  }
  if (Buffer.byteLength(trimmed, "utf8") > SEDIMENT_WORKER_ARGS_MAX_BYTES) {
    throw new WorkerValidationError("args_too_large", "manifest args exceed 64KiB");
  }

  let text: string;
  if (trimmed.startsWith("{")) {
    text = trimmed;
  } else {
    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    let buf: Buffer;
    try {
      buf = Buffer.from(b64 + pad, "base64");
    } catch {
      throw new WorkerValidationError("args_not_base64url", "manifest is not valid base64url JSON");
    }
    if (buf.byteLength === 0) throw new WorkerValidationError("args_not_base64url", "empty base64url payload");
    if (buf.byteLength > SEDIMENT_WORKER_ARGS_MAX_BYTES) {
      throw new WorkerValidationError("args_too_large", "decoded manifest exceeds 64KiB");
    }
    text = buf.toString("utf8");
    if (!text.startsWith("{")) {
      throw new WorkerValidationError("args_not_json", "decoded manifest is not JSON object");
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WorkerValidationError("args_not_json", "manifest JSON parse failed");
  }
  return validateSedimentWorkerManifest(raw);
}

export function validateSedimentWorkerManifest(raw: unknown): SedimentWorkerTaskManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkerValidationError("manifest_not_object", "manifest must be object");
  }
  const m = raw as Record<string, unknown>;
  rejectUnknownKeys(m, MANIFEST_TOP_KEYS, "unknown_field", "manifest");

  if (m.schema !== SEDIMENT_WORKER_TASK_SCHEMA) {
    throw new WorkerValidationError("schema_mismatch", "unsupported task schema");
  }
  if (m.task_kind !== "terminal_witness") {
    throw new WorkerValidationError("task_kind_rejected", "only terminal_witness tasks are admitted");
  }
  if (typeof m.request_id !== "string" || !HEX64_RE.test(m.request_id)) {
    throw new WorkerValidationError("invalid_request_id", "request_id must be 64 lowercase hex");
  }
  if (typeof m.terminal_record_id !== "string" || !HEX64_RE.test(m.terminal_record_id)) {
    throw new WorkerValidationError("invalid_terminal_record_id", "terminal_record_id must be 64 lowercase hex");
  }
  if (typeof m.session_id !== "string" || !m.session_id.trim()) {
    throw new WorkerValidationError("invalid_session_id", "session_id required");
  }
  if (typeof m.owner_project_root !== "string" || !m.owner_project_root.trim()) {
    throw new WorkerValidationError("invalid_owner_project_root", "owner_project_root required");
  }
  if (!isAbsolutePath(m.owner_project_root)) {
    throw new WorkerValidationError("owner_project_root_not_absolute", "owner_project_root must be absolute canonical path");
  }
  if (typeof m.owner_key !== "string" || !HEX64_RE.test(m.owner_key)) {
    throw new WorkerValidationError("invalid_owner_key", "owner_key required (64 lowercase hex)");
  }
  if (typeof m.sidecar_path !== "string" || !m.sidecar_path.trim()) {
    throw new WorkerValidationError("invalid_sidecar_path", "sidecar_path required");
  }
  if (!isAbsolutePath(m.sidecar_path)) {
    throw new WorkerValidationError("sidecar_path_not_absolute", "sidecar_path must be absolute");
  }
  if (typeof m.content_id !== "string" || !HEX64_RE.test(m.content_id)) {
    throw new WorkerValidationError("invalid_content_id", "content_id required (64 lowercase hex)");
  }
  if (!m.c6 || typeof m.c6 !== "object" || Array.isArray(m.c6)) {
    throw new WorkerValidationError("invalid_c6", "c6 required");
  }
  const c6raw = m.c6 as Record<string, unknown>;
  rejectUnknownKeys(c6raw, C6_KEYS, "unknown_field", "c6");
  if (typeof c6raw.session_id !== "string" || !c6raw.session_id.trim()) {
    throw new WorkerValidationError("invalid_c6", "c6.session_id required");
  }
  if (c6raw.session_id !== m.session_id) {
    throw new WorkerValidationError("session_c6_mismatch", "session_id does not match c6.session_id");
  }
  const turnId = parseSafeIntegerField(c6raw.turn_id, "c6.turn_id");
  const subturn = c6raw.subturn !== undefined
    ? parseSafeIntegerField(c6raw.subturn, "c6.subturn")
    : undefined;
  if (c6raw.sub_agent_label !== undefined) {
    if (typeof c6raw.sub_agent_label !== "string" || !c6raw.sub_agent_label) {
      throw new WorkerValidationError("invalid_c6", "c6.sub_agent_label must be non-empty string when present");
    }
  }
  if (c6raw.parent !== undefined) {
    if (!c6raw.parent || typeof c6raw.parent !== "object" || Array.isArray(c6raw.parent)) {
      throw new WorkerValidationError("invalid_c6", "c6.parent must be object when present");
    }
  }

  let leafTip: EdgeLeafTip | undefined;
  if (m.leaf_tip !== undefined) {
    if (!m.leaf_tip || typeof m.leaf_tip !== "object" || Array.isArray(m.leaf_tip)) {
      throw new WorkerValidationError("invalid_leaf_tip", "leaf_tip must be object when present");
    }
    const lt = m.leaf_tip as Record<string, unknown>;
    rejectUnknownKeys(lt, LEAF_TIP_KEYS, "unknown_field", "leaf_tip");
    if (typeof lt.id !== "string" || !lt.id) {
      throw new WorkerValidationError("invalid_leaf_tip", "leaf_tip.id required");
    }
    if (lt.parentId !== null && typeof lt.parentId !== "string") {
      throw new WorkerValidationError("invalid_leaf_tip", "leaf_tip.parentId must be string|null");
    }
    if (typeof lt.type !== "string" || !lt.type) {
      throw new WorkerValidationError("invalid_leaf_tip", "leaf_tip.type required");
    }
    if (lt.timestampUtc !== undefined && typeof lt.timestampUtc !== "string") {
      throw new WorkerValidationError("invalid_leaf_tip", "leaf_tip.timestampUtc must be string when present");
    }
    leafTip = {
      id: lt.id,
      parentId: lt.parentId as string | null,
      type: lt.type,
      ...(typeof lt.timestampUtc === "string" ? { timestampUtc: lt.timestampUtc } : {}),
    };
  }

  let candidateRef: SedimentWorkerTaskManifest["candidate_ref"];
  if (m.candidate_ref !== undefined) {
    if (!m.candidate_ref || typeof m.candidate_ref !== "object" || Array.isArray(m.candidate_ref)) {
      throw new WorkerValidationError("invalid_candidate_ref", "candidate_ref must be object when present");
    }
    const cr = m.candidate_ref as Record<string, unknown>;
    rejectUnknownKeys(cr, CANDIDATE_REF_KEYS, "unknown_field", "candidate_ref");
    if (typeof cr.record_id !== "string" || !HEX64_RE.test(cr.record_id)) {
      throw new WorkerValidationError("invalid_candidate_ref", "candidate_ref.record_id must be 64 lowercase hex");
    }
    if (typeof cr.producer_seq !== "number" || !Number.isSafeInteger(cr.producer_seq) || cr.producer_seq < 0) {
      throw new WorkerValidationError("invalid_candidate_ref", "candidate_ref.producer_seq must be non-negative safe integer");
    }
    if (typeof cr.payload_digest !== "string" || !HEX64_RE.test(cr.payload_digest)) {
      throw new WorkerValidationError("invalid_candidate_ref", "candidate_ref.payload_digest must be 64 lowercase hex");
    }
    if (typeof cr.run_generation !== "number" || !Number.isSafeInteger(cr.run_generation) || cr.run_generation < 0) {
      throw new WorkerValidationError("invalid_candidate_ref", "candidate_ref.run_generation must be non-negative safe integer");
    }
    if (cr.payload_digest !== m.content_id) {
      throw new WorkerValidationError("candidate_payload_digest_mismatch", "candidate_ref.payload_digest must equal content_id");
    }
    candidateRef = {
      record_id: cr.record_id,
      producer_seq: cr.producer_seq,
      payload_digest: cr.payload_digest,
      run_generation: cr.run_generation,
    };
  }

  const c6: EdgeC6Identity = {
    session_id: c6raw.session_id,
    turn_id: turnId,
    ...(subturn !== undefined ? { subturn } : {}),
    ...(typeof c6raw.sub_agent_label === "string" && c6raw.sub_agent_label
      ? { sub_agent_label: c6raw.sub_agent_label }
      : {}),
    ...(c6raw.parent && typeof c6raw.parent === "object" && !Array.isArray(c6raw.parent)
      ? { parent: c6raw.parent as Readonly<Record<string, unknown>> }
      : {}),
  };

  return {
    schema: SEDIMENT_WORKER_TASK_SCHEMA,
    request_id: m.request_id,
    terminal_record_id: m.terminal_record_id,
    session_id: m.session_id,
    owner_project_root: path.resolve(m.owner_project_root),
    owner_key: m.owner_key,
    sidecar_path: path.resolve(m.sidecar_path),
    content_id: m.content_id,
    task_kind: "terminal_witness",
    c6,
    ...(leafTip ? { leaf_tip: leafTip } : {}),
    ...(candidateRef ? { candidate_ref: candidateRef } : {}),
  };
}

export interface VerifiedSidecarMessages {
  content_id: string;
  messages: unknown[];
  messages_raw: string;
  message_count: number;
}

function realpathExistingDir(p: string, code: string): string {
  let st: fsSync.Stats;
  try {
    st = fsSync.lstatSync(p);
  } catch {
    throw new WorkerValidationError(code, "path lstat failed");
  }
  if (st.isSymbolicLink()) {
    throw new WorkerValidationError(code, "path must not be a symlink at leaf");
  }
  if (!st.isDirectory()) {
    throw new WorkerValidationError(code, "path must be an existing directory");
  }
  try {
    return fsSync.realpathSync.native(p);
  } catch {
    throw new WorkerValidationError(code, "path realpath failed");
  }
}

/**
 * Resolve and validate worker copy-store root + allowed owner roots from env.
 * Worker-only; ordinary mode never requires these.
 */
export function resolveWorkerSecurityEnv(env: NodeJS.ProcessEnv = process.env): {
  copyStoreRoot: string;
  allowedOwnerRoots: Set<string>;
} {
  const rawRoot = env[SEDIMENT_WORKER_COPY_STORE_ROOT_ENV]?.trim();
  if (!rawRoot) {
    throw new WorkerValidationError(
      "copy_store_root_missing",
      `${SEDIMENT_WORKER_COPY_STORE_ROOT_ENV} required`,
    );
  }
  if (!isAbsolutePath(rawRoot)) {
    throw new WorkerValidationError("copy_store_root_not_absolute", "copy store root must be absolute canonical");
  }
  const copyStoreRoot = realpathExistingDir(rawRoot, "copy_store_root_invalid");
  if (copyStoreRoot !== path.resolve(rawRoot) && copyStoreRoot !== rawRoot) {
    // Accept realpath canonical form even if input had .. segments resolved differently;
    // require the resolved realpath is absolute.
    if (!path.isAbsolute(copyStoreRoot)) {
      throw new WorkerValidationError("copy_store_root_invalid", "copy store root realpath not absolute");
    }
  }

  const rawAllowed = env[SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS_ENV]?.trim();
  if (!rawAllowed) {
    throw new WorkerValidationError(
      "allowed_owner_roots_missing",
      `${SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS_ENV} required`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawAllowed);
  } catch {
    throw new WorkerValidationError("allowed_owner_roots_invalid", "allowed owner roots must be JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new WorkerValidationError("allowed_owner_roots_invalid", "allowed owner roots must be non-empty JSON array");
  }
  const allowedOwnerRoots = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string" || !item.trim()) {
      throw new WorkerValidationError("allowed_owner_roots_invalid", "allowed owner roots entries must be strings");
    }
    if (!isAbsolutePath(item)) {
      throw new WorkerValidationError("allowed_owner_roots_invalid", "allowed owner roots must be absolute");
    }
    const rp = realpathExistingDir(item, "allowed_owner_roots_invalid");
    allowedOwnerRoots.add(rp);
  }
  return { copyStoreRoot, allowedOwnerRoots };
}

/**
 * sidecar_path must be exactly:
 *   <copyStoreRoot>/records/<terminal_record_id>/sidecar.bin
 * realpath under root, regular file, no symlink leaf.
 */
export function assertSidecarPathShape(args: {
  sidecarPath: string;
  copyStoreRoot: string;
  terminalRecordId: string;
}): string {
  const expected = path.join(args.copyStoreRoot, "records", args.terminalRecordId, "sidecar.bin");
  const resolved = path.resolve(args.sidecarPath);
  if (resolved !== expected) {
    throw new WorkerValidationError(
      "sidecar_path_shape",
      "sidecar_path must be <copy_store_root>/records/<terminal_record_id>/sidecar.bin",
    );
  }
  // realpath of parent records dir + leaf must stay under root.
  let realFile: string;
  try {
    // Open-time verification happens later; here shape + realpath of existing path.
    realFile = fsSync.realpathSync.native(resolved);
  } catch {
    // File may not exist yet — still enforce lexical shape under root.
    if (!resolved.startsWith(args.copyStoreRoot + path.sep)) {
      throw new WorkerValidationError("sidecar_path_outside_root", "sidecar_path outside copy store root");
    }
    return resolved;
  }
  if (realFile !== expected && !realFile.startsWith(args.copyStoreRoot + path.sep)) {
    throw new WorkerValidationError("sidecar_path_outside_root", "sidecar realpath outside copy store root");
  }
  if (path.basename(realFile) !== "sidecar.bin") {
    throw new WorkerValidationError("sidecar_path_shape", "sidecar basename must be sidecar.bin");
  }
  return realFile;
}

export function assertOwnerRootAllowed(args: {
  ownerProjectRoot: string;
  ownerKey: string;
  allowedOwnerRoots: Set<string>;
}): string {
  const realOwner = realpathExistingDir(args.ownerProjectRoot, "owner_project_root_invalid");
  if (!args.allowedOwnerRoots.has(realOwner)) {
    throw new WorkerValidationError("owner_root_not_allowed", "owner_project_root not in allowed owner roots");
  }
  const expectedOwnerKey = edgeOwnerKey(realOwner);
  if (args.ownerKey !== expectedOwnerKey) {
    throw new WorkerValidationError("owner_key_mismatch", "owner_key does not match sha256(owner_project_root)");
  }
  return realOwner;
}

/**
 * Safe sidecar open via open handle + fstat (O_NOFOLLOW when available).
 * Reject symlink / non-regular / oversized; verify edge-source/v1 + session_id
 * + exact messages digest. Same-permission TOCTOU bound is honest.
 */
export async function readAndVerifyWorkerSidecar(args: {
  sidecarPath: string;
  sessionId: string;
  contentId: string;
  maxBytes?: number;
}): Promise<VerifiedSidecarMessages> {
  const maxBytes = args.maxBytes ?? SEDIMENT_WORKER_SIDECAR_MAX_BYTES;
  const abs = path.resolve(args.sidecarPath);
  const openFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0);

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, openFlags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") {
      throw new WorkerValidationError("sidecar_symlink_rejected", "sidecar must not be a symlink");
    }
    throw new WorkerValidationError("sidecar_unreadable", "sidecar open failed");
  }

  try {
    const st = await handle.stat();
    if (st.isSymbolicLink()) {
      throw new WorkerValidationError("sidecar_symlink_rejected", "sidecar must not be a symlink");
    }
    if (!st.isFile()) {
      throw new WorkerValidationError("sidecar_not_regular", "sidecar must be a regular file");
    }
    if (st.size > maxBytes) {
      throw new WorkerValidationError("sidecar_too_large", "sidecar exceeds 8MiB cap");
    }

    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await handle.read(bytes, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== st.size) {
      throw new WorkerValidationError("sidecar_size_race", "sidecar short read");
    }
    const st2 = await handle.stat();
    if (st2.size !== st.size) {
      throw new WorkerValidationError("sidecar_size_race", "sidecar size changed during read");
    }

    let env: Record<string, unknown>;
    try {
      env = JSON.parse(bytes.toString("utf8").trim()) as Record<string, unknown>;
    } catch {
      throw new WorkerValidationError("sidecar_not_json", "sidecar is not JSON");
    }
    if (env.schema !== EDGE_SOURCE_SCHEMA || env.schema_version !== 1) {
      throw new WorkerValidationError("sidecar_schema_mismatch", "sidecar schema must be edge-source/v1");
    }
    if (typeof env.session_id !== "string" || env.session_id !== args.sessionId) {
      throw new WorkerValidationError("sidecar_session_mismatch", "sidecar session_id mismatch");
    }
    if (typeof env.content_id !== "string" || !HEX64_RE.test(env.content_id)) {
      throw new WorkerValidationError("sidecar_content_id_invalid", "sidecar content_id invalid");
    }
    if (args.contentId !== env.content_id) {
      throw new WorkerValidationError("content_id_mismatch", "manifest content_id does not match envelope");
    }
    const contentId = args.contentId;

    const verified = verifyEdgeSourceEnvelopeBytes(bytes, {
      sessionId: args.sessionId,
      contentId,
      byteLength: bytes.byteLength,
    });
    if (!verified.ok) {
      throw new WorkerValidationError(
        verified.code === "messages_digest_mismatch" || verified.code === "content_id_mismatch"
          ? "messages_digest_mismatch"
          : "sidecar_verify_failed",
        `sidecar verify failed: ${verified.code}`,
      );
    }

    const messagesRaw = extractTopLevelJsonFieldRaw(bytes.toString("utf8"), "messages");
    if (messagesRaw === null || computePayloadDigest(messagesRaw) !== contentId) {
      throw new WorkerValidationError("messages_digest_mismatch", "messages exact digest mismatch");
    }

    let messages: unknown;
    try {
      messages = JSON.parse(verified.messages_raw);
    } catch {
      throw new WorkerValidationError("sidecar_messages_invalid", "messages JSON invalid");
    }
    if (!Array.isArray(messages)) {
      throw new WorkerValidationError("sidecar_messages_not_array", "messages must be array");
    }

    return {
      content_id: contentId,
      messages,
      messages_raw: verified.messages_raw,
      message_count: verified.message_count,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Convert agent_end-style messages into synthetic session branch entries so
 * the existing buildRunWindow/extractor/curator path can consume them.
 *
 * Entry IDs are content-stable (content hash). leaf_tip may pin last entry
 * type/timestamp only — never rewrite previous tip IDs when cumulative
 * sidecars grow (leaf_tip changes must not renumber prior entries).
 */
export function syntheticBranchFromMessages(
  messages: readonly unknown[],
  leafTip?: EdgeLeafTip,
): unknown[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    if (leafTip) {
      // Empty messages with tip pin: stable id from tip only when no content.
      return [{
        id: leafTip.id,
        parentId: leafTip.parentId,
        type: leafTip.type || "message",
        timestamp: leafTip.timestampUtc ?? "1970-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [], stopReason: "stop" },
      }];
    }
    return [];
  }

  const entries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;
    const msgObj = msg && typeof msg === "object" ? msg as Record<string, unknown> : {};
    const msgTimestamp = typeof msgObj.timestamp === "string" ? msgObj.timestamp : undefined;
    // Content-stable id for every position. leaf_tip.id is intentionally NOT
    // used as the entry id — cumulative sidecar growth would otherwise rename
    // the previous tip when a new leaf arrives.
    const id = `sw-${String(i).padStart(4, "0")}-${sha256Hex(JSON.stringify(msg)).slice(0, 24)}`;
    const parentId = i === 0 ? null : (entries[i - 1].id as string);
    const type = isLast && leafTip?.type ? leafTip.type : "message";
    const timestamp = isLast && leafTip?.timestampUtc
      ? leafTip.timestampUtc
      : (msgTimestamp ?? "1970-01-01T00:00:00.000Z");
    entries.push({
      id,
      parentId,
      type,
      timestamp,
      message: msg,
    });
  }
  return entries;
}

function anchorFromC6(c6: EdgeC6Identity): SedimentWorkerPassSnapshot["anchor"] {
  // turn/subturn already validated as safe integers at manifest parse.
  const turn = typeof c6.turn_id === "number" ? c6.turn_id : Number(c6.turn_id);
  const sub = c6.subturn === undefined
    ? undefined
    : (typeof c6.subturn === "number" ? c6.subturn : Number(c6.subturn));
  return {
    session_id: c6.session_id,
    turn_id: turn,
    ...(sub !== undefined ? { subturn: sub } : {}),
    ...(c6.sub_agent_label ? { sub_agent_label: c6.sub_agent_label } : {}),
  };
}

function messageSnapshotsForHealth(messages: readonly unknown[]): SedimentWorkerPassSnapshot["messages"] {
  return messages.map((m) => {
    if (!m || typeof m !== "object") return {};
    const o = m as Record<string, unknown>;
    return {
      ...(typeof o.role === "string" ? { role: o.role } : {}),
      ...(typeof o.stopReason === "string" ? { stopReason: o.stopReason } : {}),
      ...(typeof o.errorMessage === "string" ? { errorMessage: o.errorMessage } : {}),
    };
  });
}

export function buildWorkerPassSnapshot(args: {
  manifest: SedimentWorkerTaskManifest;
  messages: readonly unknown[];
  modelRegistry?: unknown;
}): SedimentWorkerPassSnapshot {
  return Object.freeze({
    cwd: args.manifest.owner_project_root,
    sessionId: args.manifest.session_id,
    checkpointSessionId: workerCheckpointSessionId(args.manifest.session_id),
    branchEntries: Object.freeze(syntheticBranchFromMessages(args.messages, args.manifest.leaf_tip)),
    messages: Object.freeze(messageSnapshotsForHealth(args.messages)),
    modelRegistry: args.modelRegistry,
    anchor: anchorFromC6(args.manifest.c6),
    boundaryUntrusted: false,
  });
}

interface WorkerReceipt {
  schema: typeof SEDIMENT_WORKER_RECEIPT_SCHEMA;
  terminal_record_id: string;
  request_id: string;
  /** Receipt only records processed settled success. */
  status: "processed";
  settled: true;
  memory_decisions: number;
  memory_writes: number;
  created_at: string;
}

function isValidProcessedReceipt(raw: unknown, terminalRecordId: string): raw is WorkerReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r.schema !== SEDIMENT_WORKER_RECEIPT_SCHEMA) return false;
  if (r.terminal_record_id !== terminalRecordId) return false;
  if (r.status !== "processed") return false;
  if (r.settled !== true) return false;
  if (typeof r.request_id !== "string" || !HEX64_RE.test(r.request_id)) return false;
  if (typeof r.memory_decisions !== "number" || typeof r.memory_writes !== "number") return false;
  if (typeof r.created_at !== "string") return false;
  return true;
}

/**
 * Read receipt fail-closed.
 * - missing → null
 * - present but corrupt / not processed settled → throws WorkerValidationError
 */
async function readProcessedReceipt(
  abrainHome: string,
  terminalRecordId: string,
): Promise<WorkerReceipt | null> {
  const file = sedimentWorkerReceiptPath(abrainHome, terminalRecordId);
  let rawText: string;
  try {
    rawText = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new WorkerValidationError("receipt_corrupt_or_collision", "receipt unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new WorkerValidationError("receipt_corrupt_or_collision", "receipt JSON corrupt");
  }
  if (!isValidProcessedReceipt(parsed, terminalRecordId)) {
    throw new WorkerValidationError("receipt_corrupt_or_collision", "receipt not valid processed settled");
  }
  return parsed;
}

async function writeProcessedReceipt(
  abrainHome: string,
  receipt: WorkerReceipt,
): Promise<"created" | "identical" | "collision"> {
  const dir = sedimentWorkerReceiptsDir(abrainHome);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = sedimentWorkerReceiptPath(abrainHome, receipt.terminal_record_id);
  const body = `${JSON.stringify(receipt)}\n`;
  const status = await durableAtomicCreateFile(file, body, { mode: 0o600, verifyCreated: false });
  await fsyncDirectory(dir).catch(() => undefined);
  return status;
}

function resultFromProcessedReceipt(receipt: WorkerReceipt, requestId: string): SedimentWorkerResult {
  return {
    schema: SEDIMENT_WORKER_RESULT_SCHEMA,
    request_id: requestId,
    terminal_record_id: receipt.terminal_record_id,
    status: receipt.request_id === requestId ? "processed" : "already_processed",
    settled: true,
    retryable: false,
    memory_decisions: receipt.memory_decisions,
    memory_writes: receipt.memory_writes,
  };
}

function failResult(
  ids: { request_id: string; terminal_record_id: string },
  code: string,
  opts?: { status?: SedimentWorkerTaskStatus; retryable?: boolean; pass_iterations?: number },
): SedimentWorkerResult {
  const status = opts?.status ?? "failed";
  const settled = status === "processed" || status === "already_processed";
  return {
    schema: SEDIMENT_WORKER_RESULT_SCHEMA,
    request_id: ids.request_id,
    terminal_record_id: ids.terminal_record_id,
    status,
    settled,
    retryable: opts?.retryable ?? !settled,
    memory_decisions: 0,
    memory_writes: 0,
    error_code: code,
    ...(opts?.pass_iterations !== undefined ? { pass_iterations: opts.pass_iterations } : {}),
  };
}

export function formatWorkerResultNotify(result: SedimentWorkerResult): string {
  // Aggregate-only JSON. Never include raw/path/session/content/digest.
  return `${SEDIMENT_WORKER_RESULT_NOTIFY_PREFIX}${JSON.stringify(result)}`;
}

export function tryParseWorkerResultNotify(message: string): SedimentWorkerResult | null {
  if (!message.startsWith(SEDIMENT_WORKER_RESULT_NOTIFY_PREFIX)) return null;
  try {
    const parsed = JSON.parse(message.slice(SEDIMENT_WORKER_RESULT_NOTIFY_PREFIX.length)) as SedimentWorkerResult;
    if (parsed?.schema !== SEDIMENT_WORKER_RESULT_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Process-wide pass serial gate (all terminal ids; per-id OFD still retained). */
let globalPassTail: Promise<void> = Promise.resolve();

async function withGlobalPassSerial<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = globalPassTail;
  globalPassTail = prev.then(() => gate, () => gate);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

function checkpointAdvanced(
  before: { lastProcessedEntryId?: string },
  after: { lastProcessedEntryId?: string },
): boolean {
  const b = before.lastProcessedEntryId ?? "";
  const a = after.lastProcessedEntryId ?? "";
  return a !== "" && a !== b;
}

/**
 * Full worker task handler. Crash-safe: no durable success receipt until
 * real checkpoint advanced AND backlog exhausted (more=false). Busy claim is
 * OFD-backed and released on process death. Transient failures leave no receipt.
 */
export async function runSedimentWorkerTask(
  argsRaw: string,
  deps: SedimentWorkerCommandDeps,
): Promise<SedimentWorkerResult> {
  const env = deps.env ?? process.env;
  let manifest: SedimentWorkerTaskManifest | undefined;
  try {
    manifest = parseSedimentWorkerManifestArgs(argsRaw);
  } catch (err) {
    const code = err instanceof WorkerValidationError ? err.code : "manifest_invalid";
    // Manifest failures cannot trust ids; zeros only — not business settled.
    return failResult(
      { request_id: "0".repeat(64), terminal_record_id: "0".repeat(64) },
      code,
      { retryable: false },
    );
  }

  const ids = {
    request_id: manifest.request_id,
    terminal_record_id: manifest.terminal_record_id,
  };

  try {
    if (deps.resolveExecutionOwner() !== "daemon") {
      return failResult(ids, "execution_owner_not_daemon", { retryable: false });
    }

    const security = resolveWorkerSecurityEnv(env);
    const ownerRoot = assertOwnerRootAllowed({
      ownerProjectRoot: manifest.owner_project_root,
      ownerKey: manifest.owner_key,
      allowedOwnerRoots: security.allowedOwnerRoots,
    });
    manifest = {
      ...manifest,
      owner_project_root: ownerRoot,
      sidecar_path: assertSidecarPathShape({
        sidecarPath: manifest.sidecar_path,
        copyStoreRoot: security.copyStoreRoot,
        terminalRecordId: manifest.terminal_record_id,
      }),
    };

    const abrainHome = path.resolve(deps.resolveAbrainHome());

    // Receipt pre-check (fail closed on corrupt).
    try {
      const existing = await readProcessedReceipt(abrainHome, manifest.terminal_record_id);
      if (existing) return resultFromProcessedReceipt(existing, manifest.request_id);
    } catch (err) {
      const code = err instanceof WorkerValidationError ? err.code : "receipt_corrupt_or_collision";
      return failResult(ids, code, { retryable: false });
    }

    const claimDir = path.join(sedimentWorkerClaimsDir(abrainHome), manifest.terminal_record_id);
    await fs.mkdir(sedimentWorkerClaimsDir(abrainHome), { recursive: true, mode: 0o700 });
    await fs.mkdir(claimDir, { recursive: true, mode: 0o700 });

    let lock: ReturnType<typeof acquireRetainedDirectoryOfdLock>;
    try {
      lock = acquireRetainedDirectoryOfdLock(claimDir);
    } catch {
      return failResult(ids, "claim_failed", { retryable: true });
    }
    if (lock.status === "BUSY") {
      return failResult(ids, "claim_busy", { status: "busy", retryable: true });
    }

    try {
      // Re-check under claim.
      try {
        const again = await readProcessedReceipt(abrainHome, manifest.terminal_record_id);
        if (again) return resultFromProcessedReceipt(again, manifest.request_id);
      } catch (err) {
        const code = err instanceof WorkerValidationError ? err.code : "receipt_corrupt_or_collision";
        return failResult(ids, code, { retryable: false });
      }

      let verified: VerifiedSidecarMessages;
      try {
        verified = await readAndVerifyWorkerSidecar({
          sidecarPath: manifest.sidecar_path,
          sessionId: manifest.session_id,
          contentId: manifest.content_id,
        });
      } catch (err) {
        const code = err instanceof WorkerValidationError ? err.code : "sidecar_failed";
        // Validation / sidecar failures: settled=false, no durable failed receipt.
        return failResult(ids, code, { retryable: false });
      }

      const snapshot = buildWorkerPassSnapshot({
        manifest,
        messages: verified.messages,
        modelRegistry: deps.modelRegistry,
      });
      const cpSessionId = snapshot.checkpointSessionId;
      const projectRoot = snapshot.cwd;

      // Global serial across all terminal ids in this process.
      return await withGlobalPassSerial(async () => {
        let iterations = 0;
        let lastMore = false;
        let anyAdvanced = false;

        while (iterations < SEDIMENT_WORKER_MORE_BUDGET) {
          iterations += 1;
          let beforeCp: { lastProcessedEntryId?: string };
          try {
            beforeCp = await deps.loadSessionCheckpoint(projectRoot, cpSessionId);
          } catch {
            return failResult(ids, "checkpoint_load_failed", { retryable: true, pass_iterations: iterations });
          }

          let passResult: void | { more: true };
          try {
            passResult = await deps.runAgentEndPass(snapshot, { fromRecovery: false });
          } catch {
            return failResult(ids, "pipeline_threw", { retryable: true, pass_iterations: iterations });
          }

          let afterCp: { lastProcessedEntryId?: string };
          try {
            afterCp = await deps.loadSessionCheckpoint(projectRoot, cpSessionId);
          } catch {
            return failResult(ids, "checkpoint_load_failed", { retryable: true, pass_iterations: iterations });
          }

          const advanced = checkpointAdvanced(beforeCp, afterCp);
          if (advanced) anyAdvanced = true;
          lastMore = !!(passResult && typeof passResult === "object" && passResult.more === true);

          if (lastMore) {
            // more=true without real CP advance is no-progress / livelock — fail closed.
            if (!advanced) {
              return failResult(ids, "no_progress", { retryable: true, pass_iterations: iterations });
            }
            continue;
          }

          // more=false terminal for this task attempt.
          if (!anyAdvanced && !advanced) {
            // Soft skip / project_not_bound / settings disabled / empty window:
            // void return is NOT processed. No success receipt.
            return failResult(ids, "no_progress", { retryable: true, pass_iterations: iterations });
          }

          // Real CP advanced and backlog exhausted → create-only success receipt.
          const receipt: WorkerReceipt = {
            schema: SEDIMENT_WORKER_RECEIPT_SCHEMA,
            terminal_record_id: manifest!.terminal_record_id,
            request_id: manifest!.request_id,
            status: "processed",
            settled: true,
            memory_decisions: 0,
            memory_writes: 0,
            created_at: (deps.now?.() ?? new Date()).toISOString(),
          };

          let writeStatus: "created" | "identical" | "collision";
          try {
            writeStatus = await writeProcessedReceipt(abrainHome, receipt);
          } catch {
            return failResult(ids, "receipt_write_failed", { retryable: true, pass_iterations: iterations });
          }

          if (writeStatus === "collision") {
            // Fail closed: never return processed unless re-read is valid processed.
            try {
              const raced = await readProcessedReceipt(abrainHome, manifest!.terminal_record_id);
              if (raced) return resultFromProcessedReceipt(raced, manifest!.request_id);
            } catch {
              /* fall through */
            }
            return failResult(ids, "receipt_corrupt_or_collision", { retryable: false, pass_iterations: iterations });
          }
          if (writeStatus === "identical") {
            try {
              const raced = await readProcessedReceipt(abrainHome, manifest!.terminal_record_id);
              if (raced) return resultFromProcessedReceipt(raced, manifest!.request_id);
            } catch {
              return failResult(ids, "receipt_corrupt_or_collision", { retryable: false, pass_iterations: iterations });
            }
          }

          // Success: trigger knowledge publication outbox one-shot (cannot wait session_start).
          try {
            await deps.drainKnowledgePublicationOutbox?.(abrainHome);
          } catch {
            // Publication drain is best-effort after settled success; durable
            // outbox remains for a later drain edge.
          }

          return {
            schema: SEDIMENT_WORKER_RESULT_SCHEMA,
            request_id: manifest!.request_id,
            terminal_record_id: manifest!.terminal_record_id,
            status: "processed",
            settled: true,
            retryable: false,
            memory_decisions: 0,
            memory_writes: 0,
            pass_iterations: iterations,
          };
        }

        // Budget exhausted with more still true: retryable non-final, no receipt.
        return failResult(ids, "more_budget_exhausted", {
          retryable: true,
          pass_iterations: iterations,
        });
      });
    } finally {
      try { lock.close(); } catch { /* best-effort */ }
    }
  } catch (err) {
    const code = err instanceof WorkerValidationError ? err.code : "worker_internal_error";
    return failResult(ids, code, { retryable: code !== "receipt_corrupt_or_collision" });
  }
}

export function registerSedimentWorkerCommand(
  pi: {
    registerCommand?: (
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: {
          ui?: { notify?(message: string, type?: string): void };
          modelRegistry?: unknown;
        }) => Promise<void> | void;
      },
    ) => void;
  },
  deps: SedimentWorkerCommandDeps,
): void {
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand(SEDIMENT_WORKER_COMMAND_NAME, {
    description:
      "Daemon Stage0 sediment worker: process one terminal_witness task from edge-source sidecar (JSON or base64url manifest). No agent turn.",
    async handler(args, ctx) {
      const notify = ctx.ui?.notify?.bind(ctx.ui);
      // Result notify must be confirmed available BEFORE execution.
      if (typeof notify !== "function") {
        // Cannot deliver business result; still avoid throwing — Pi command
        // response remains command-level acceptance only. No pipeline run.
        return;
      }

      let result: SedimentWorkerResult;
      try {
        result = await runSedimentWorkerTask(args, {
          ...deps,
          modelRegistry: deps.modelRegistry ?? ctx.modelRegistry,
        });
      } catch (err) {
        // Last-resort structured result; try to salvage ids from manifest.
        let requestId = "0".repeat(64);
        let terminalId = "0".repeat(64);
        try {
          const m = parseSedimentWorkerManifestArgs(args);
          requestId = m.request_id;
          terminalId = m.terminal_record_id;
        } catch { /* keep zeros */ }
        result = failResult(
          { request_id: requestId, terminal_record_id: terminalId },
          err instanceof WorkerValidationError ? err.code : "worker_internal_error",
          { retryable: true },
        );
      }

      const type = result.status === "failed"
        ? "error"
        : result.status === "busy"
          ? "warning"
          : "info";
      try {
        notify(formatWorkerResultNotify(result), type);
      } catch {
        /* RPC notify failure after execution: daemon may still see command response */
      }
    },
  });
}
