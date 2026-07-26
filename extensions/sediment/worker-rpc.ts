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
import {
  countPublicationOutboxFailed as countPublicationOutboxFailedProduction,
  hasPublicationOutboxPending,
  type PublicationOutboxDrainResult,
} from "./publication-outbox";
import { runWithWorkerBudget } from "../_shared/worker-budget-context";

export const SEDIMENT_WORKER_MODE_ENV = "PI_ASTACK_SEDIMENT_WORKER_MODE" as const;
export const SEDIMENT_WORKER_COPY_STORE_ROOT_ENV = "PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT" as const;
export const SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS_ENV = "PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS" as const;
export const SEDIMENT_WORKER_TASK_SCHEMA = "pi-astack/sediment-worker-task/v1" as const;
export const SEDIMENT_WORKER_RESULT_SCHEMA = "pi-astack/sediment-worker-result/v1" as const;
export const SEDIMENT_WORKER_RECEIPT_SCHEMA = "pi-astack/sediment-worker-receipt/v1" as const;
export const SEDIMENT_WORKER_PROGRESS_SCHEMA = "pi-astack/sediment-worker-progress/v1" as const;
export const SEDIMENT_WORKER_COMMAND_NAME = "sediment-worker-run" as const;
export const SEDIMENT_WORKER_RESULT_NOTIFY_PREFIX = "sediment-worker-result:" as const;
export const SEDIMENT_WORKER_PROGRESS_NOTIFY_PREFIX = "sediment-worker-progress:" as const;

/** Local publication-outbox maintenance (daemon idle owner; not formal ACK). */
export const SEDIMENT_WORKER_MAINTENANCE_SCHEMA = "pi-astack/sediment-worker-maintenance/v1" as const;
export const SEDIMENT_WORKER_MAINTENANCE_RESULT_SCHEMA = "pi-astack/sediment-worker-maintenance-result/v1" as const;
export const SEDIMENT_WORKER_MAINTENANCE_COMMAND_NAME = "sediment-worker-maintenance" as const;
export const SEDIMENT_WORKER_MAINTENANCE_RESULT_NOTIFY_PREFIX = "sediment-worker-maintenance-result:" as const;
/** Maintenance budget closed range: 60s .. 900s. */
export const SEDIMENT_WORKER_MAINTENANCE_BUDGET_MIN_MS = 60_000;
export const SEDIMENT_WORKER_MAINTENANCE_BUDGET_MAX_MS = 900_000;

/** Hard cap for source sidecar regular files (matches daemon copy-store bound). */
export const SEDIMENT_WORKER_SIDECAR_MAX_BYTES = 8 * 1024 * 1024;
/** Manifest argv / base64url decoded bound. */
export const SEDIMENT_WORKER_ARGS_MAX_BYTES = 64 * 1024;
/** In-worker more=true continuation budget (ready-pending backlog). */
export const SEDIMENT_WORKER_MORE_BUDGET = 16;
/** Default task budget when old daemons omit budget_ms (10 minutes). */
export const SEDIMENT_WORKER_DEFAULT_BUDGET_MS = 600_000;
/** Closed budget range: 60s .. 3600s. */
export const SEDIMENT_WORKER_BUDGET_MIN_MS = 60_000;
export const SEDIMENT_WORKER_BUDGET_MAX_MS = 3_600_000;
/** Reserve at end of budget for structured return (worker self-returns before daemon kill). */
export const SEDIMENT_WORKER_CLEANUP_RESERVE_MS = 5_000;
/** Soft-deadline / serial-wait fence poll slice (ms). ≤1s; tests may inject smaller. */
export const SEDIMENT_WORKER_FENCE_SLICE_MS = 1_000;

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
  "budget_ms",
]);

/**
 * Closed progress stages actually emitted by Stage0 worker paths.
 * Observational only; no identity / free text. Do not list unwired stages.
 * auto_write_* stages are emitted from tryAutoWriteLane via onProgress.
 */
export const SEDIMENT_WORKER_PROGRESS_STAGES = [
  "claim",
  "sidecar",
  "checkpoint",
  "pass",
  "search",
  "classifier",
  "detached_join",
  "receipt",
  "publication",
  "auto_write_preflight",
  "auto_write_extractor",
  "auto_write_curator",
  "auto_write_writer",
  "auto_write_embedding",
  "auto_write_publication",
] as const;
export type SedimentWorkerProgressStage = (typeof SEDIMENT_WORKER_PROGRESS_STAGES)[number];
const PROGRESS_STAGE_SET = new Set<string>(SEDIMENT_WORKER_PROGRESS_STAGES);

export const SEDIMENT_WORKER_PROGRESS_PHASES = ["start", "end", "heartbeat", "aborted"] as const;
export type SedimentWorkerProgressPhase = (typeof SEDIMENT_WORKER_PROGRESS_PHASES)[number];
const PROGRESS_PHASE_SET = new Set<string>(SEDIMENT_WORKER_PROGRESS_PHASES);

/** Closed lane labels for detached-join pending (low cardinality). */
export const SEDIMENT_WORKER_TRACKED_LANES = [
  "auto_write",
  "classifier",
  "multiview_replay",
  "embedding",
  "maintenance",
  "other",
] as const;
export type SedimentWorkerTrackedLane = (typeof SEDIMENT_WORKER_TRACKED_LANES)[number];
const TRACKED_LANE_SET = new Set<string>(SEDIMENT_WORKER_TRACKED_LANES);

/**
 * Closed deadline/cancel error codes (default retryable=true).
 * Plain settled codes (budget/stage/detached_join) do NOT default restart_child;
 * only the poison closed set forces poison + restart_child=true.
 */
export const SEDIMENT_WORKER_DEADLINE_ERROR_CODES = [
  "worker_budget_exhausted",
  "global_serial_deadline",
  "stage_deadline",
  "detached_join_deadline",
  "cancel_cleanup_unreaped",
  "pass_deadline_exceeded_unreaped",
] as const;
export type SedimentWorkerDeadlineErrorCode = (typeof SEDIMENT_WORKER_DEADLINE_ERROR_CODES)[number];
const DEADLINE_ERROR_SET = new Set<string>(SEDIMENT_WORKER_DEADLINE_ERROR_CODES);

/**
 * Closed non-retryable diagnostic: CP advanced under worker but no success receipt.
 * Fail closed — cannot auto no_progress / already_processed loop. restart_child=true.
 */
export const SEDIMENT_WORKER_CP_ADVANCED_NO_RECEIPT_CODE = "deadline_after_checkpoint_advanced" as const;
/** Process-local poison after unreaped/deadline — subsequent worker-run refuses claim/pass. */
export const SEDIMENT_WORKER_PROCESS_POISONED_CODE = "worker_process_poisoned" as const;

/**
 * Closed poison + restart_child set. All WorkerDeadlineError catches must route through
 * `poisonIfSerialOrUnreaped(code)` — plain settled worker_budget_exhausted / stage_deadline /
 * detached_join_deadline (cleanup settled, CP not advanced) must NOT poison and restart_child=false.
 */
export const SEDIMENT_WORKER_POISON_RESTART_CODES = [
  "global_serial_deadline",
  "cancel_cleanup_unreaped",
  "pass_deadline_exceeded_unreaped",
  SEDIMENT_WORKER_CP_ADVANCED_NO_RECEIPT_CODE,
  SEDIMENT_WORKER_PROCESS_POISONED_CODE,
] as const;
export type SedimentWorkerPoisonRestartCode = (typeof SEDIMENT_WORKER_POISON_RESTART_CODES)[number];
const POISON_RESTART_SET = new Set<string>(SEDIMENT_WORKER_POISON_RESTART_CODES);

export function isPoisonRestartCode(code: string | undefined): boolean {
  return typeof code === "string" && POISON_RESTART_SET.has(code);
}

/** Progress notify payload — closed keys only; no identity or free text. */
export interface SedimentWorkerProgressEvent {
  schema: typeof SEDIMENT_WORKER_PROGRESS_SCHEMA;
  stage: SedimentWorkerProgressStage;
  phase: SedimentWorkerProgressPhase;
  /** Optional low-cardinality elapsed bucket (seconds power-ish). */
  elapsed_bucket?: number;
  /** Optional low-cardinality pending work count bucket. */
  pending_bucket?: number;
  /** Optional closed lane set currently pending (sorted unique). */
  lanes?: readonly SedimentWorkerTrackedLane[];
}

const PROGRESS_KEYS = new Set([
  "schema",
  "stage",
  "phase",
  "elapsed_bucket",
  "pending_bucket",
  "lanes",
]);

/** Low-cardinality elapsed seconds buckets (closed set). */
const ELAPSED_BUCKETS_S = [0, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200, 3600] as const;
const ELAPSED_BUCKET_SET = new Set<number>(ELAPSED_BUCKETS_S);
/** Low-cardinality pending count buckets (closed set). */
const PENDING_BUCKETS = [0, 1, 2, 3, 4, 5, 8, 13, 21] as const;
const PENDING_BUCKET_SET = new Set<number>(PENDING_BUCKETS);
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
  /**
   * Task wall budget in ms (closed range 60_000..3_600_000).
   * Optional for old daemons: absent → SEDIMENT_WORKER_DEFAULT_BUDGET_MS.
   * Worker self-returns within budget (5s return reserve); does not rely on daemon kill.
   */
  budget_ms: number;
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
  /**
   * When true, Pi child may be unreaped after deadline/cancel cleanup — caller
   * must rebuild the Pi child. Backward-compatible optional field (old daemons ignore).
   */
  restart_child?: boolean;
  /**
   * Settled success left durable knowledge publication outbox pending.
   * Worker task does NOT drain publication in-task; independent maintenance owns it.
   */
  publication_pending?: boolean;
}

/** Worker-only runtime opts injected into runSedimentAgentEndPass. */
export interface SedimentWorkerPassRuntimeOpts {
  signal?: AbortSignal;
  /** Abort the worker AbortController that owns `signal` (detached-join abort-first). */
  requestAbort?: () => void;
  /** Absolute wall-clock soft deadline (budget minus cleanup reserve). */
  deadlineMs?: number;
  onProgress?: (event: SedimentWorkerProgressEvent) => void;
  now?: () => number;
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

/** Closed deterministic no-progress codes (not auto-retryable; no success receipt). */
export const SEDIMENT_WORKER_DETERMINISTIC_NO_PROGRESS_CODES = [
  "project_not_bound",
  "settings_disabled",
  "empty_window",
  "ephemeral_session",
] as const;
export type SedimentWorkerDeterministicNoProgressCode =
  (typeof SEDIMENT_WORKER_DETERMINISTIC_NO_PROGRESS_CODES)[number];
const DETERMINISTIC_NO_PROGRESS_SET = new Set<string>(SEDIMENT_WORKER_DETERMINISTIC_NO_PROGRESS_CODES);

export function isDeterministicNoProgressCode(code: string | undefined): boolean {
  return typeof code === "string" && DETERMINISTIC_NO_PROGRESS_SET.has(code);
}

/** Pass outcome: void / more / explicit no-progress classification. */
export type SedimentWorkerPassOutcome =
  | void
  | { more: true }
  | {
      no_progress: true;
      code: SedimentWorkerDeterministicNoProgressCode | "no_progress";
      /** Default: deterministic codes → false; plain no_progress → true. */
      retryable?: boolean;
    };

export type SedimentWorkerPassRunner = (
  snapshot: SedimentWorkerPassSnapshot,
  opts?: {
    intakeWindowId?: string;
    fromRecovery?: boolean;
  } & SedimentWorkerPassRuntimeOpts,
) => Promise<SedimentWorkerPassOutcome>;

export interface SedimentWorkerCommandDeps {
  runAgentEndPass: SedimentWorkerPassRunner;
  resolveAbrainHome: () => string;
  /** Must be "daemon" for worker to execute; otherwise execution_owner_not_daemon. */
  resolveExecutionOwner: () => "foreground" | "daemon";
  /**
   * @deprecated Worker tasks no longer drain publication in-task (durable outbox
   * + independent maintenance only). Kept optional for call-site compatibility;
   * ignored by the handler after success receipt. Maintenance command uses its own deps.
   */
  drainKnowledgePublicationOutbox?: (abrainHome: string) => Promise<void> | void;
  /**
   * Read-only pending publication-outbox metadata count (no item-body reads).
   * Settled task results stamp publication_pending from this; read failure fail-closes to true.
   */
  countPublicationOutboxPending?: (abrainHome: string) => Promise<number>;
  /** Production existence-only probe; preferred for task result booleans. */
  hasPublicationOutboxPending?: (abrainHome: string) => Promise<boolean>;
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
  /**
   * Optional progress notify sink (tests / command handler).
   * Failures must never fail the task.
   */
  onProgress?: (event: SedimentWorkerProgressEvent) => void;
  /** Optional monotonic/wall clock for budget tests (defaults Date.now). */
  clock?: () => number;
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

export class WorkerDeadlineError extends Error {
  readonly code: SedimentWorkerDeadlineErrorCode;
  readonly restart_child: boolean;
  constructor(code: SedimentWorkerDeadlineErrorCode, message?: string, opts?: { restart_child?: boolean }) {
    super(message ?? code);
    this.name = "WorkerDeadlineError";
    this.code = code;
    // Only poison-class codes default restart_child=true.
    this.restart_child = opts?.restart_child ?? isPoisonRestartCode(code);
  }
}

export function isWorkerDeadlineErrorCode(code: string | undefined): code is SedimentWorkerDeadlineErrorCode {
  return typeof code === "string" && DEADLINE_ERROR_SET.has(code);
}

export function bucketElapsedSeconds(elapsedMs: number): number {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  let chosen: number = ELAPSED_BUCKETS_S[0];
  for (const b of ELAPSED_BUCKETS_S) {
    if (s >= b) chosen = b;
    else break;
  }
  return chosen;
}

export function bucketPendingCount(n: number): number {
  const c = Math.max(0, Math.floor(n));
  let chosen: number = PENDING_BUCKETS[0];
  for (const b of PENDING_BUCKETS) {
    if (c >= b) chosen = b;
    else break;
  }
  return chosen;
}

/** Parse optional budget_ms; absent → default. Closed range 60s..3600s. */
export function parseWorkerBudgetMs(raw: unknown): number {
  if (raw === undefined || raw === null) return SEDIMENT_WORKER_DEFAULT_BUDGET_MS;
  const n = parseSafeIntegerField(raw, "budget_ms");
  if (n < SEDIMENT_WORKER_BUDGET_MIN_MS || n > SEDIMENT_WORKER_BUDGET_MAX_MS) {
    throw new WorkerValidationError(
      "budget_ms_out_of_range",
      `budget_ms must be in [${SEDIMENT_WORKER_BUDGET_MIN_MS}..${SEDIMENT_WORKER_BUDGET_MAX_MS}]`,
    );
  }
  return n;
}

/** Soft work deadline = absolute start + budget − cleanup reserve (≥1ms). */
export function computeWorkerSoftDeadlineMs(args: {
  startedAtMs: number;
  budgetMs: number;
  cleanupReserveMs?: number;
}): number {
  const reserve = args.cleanupReserveMs ?? SEDIMENT_WORKER_CLEANUP_RESERVE_MS;
  const softBudget = Math.max(1, args.budgetMs - reserve);
  return args.startedAtMs + softBudget;
}

export function buildWorkerProgressEvent(args: {
  stage: SedimentWorkerProgressStage;
  phase: SedimentWorkerProgressPhase;
  startedAtMs?: number;
  nowMs?: number;
  pending?: number;
  lanes?: readonly SedimentWorkerTrackedLane[];
}): SedimentWorkerProgressEvent {
  if (!PROGRESS_STAGE_SET.has(args.stage)) {
    throw new WorkerValidationError("progress_stage_invalid", "invalid progress stage");
  }
  if (!PROGRESS_PHASE_SET.has(args.phase)) {
    throw new WorkerValidationError("progress_phase_invalid", "invalid progress phase");
  }
  const event: SedimentWorkerProgressEvent = {
    schema: SEDIMENT_WORKER_PROGRESS_SCHEMA,
    stage: args.stage,
    phase: args.phase,
  };
  if (args.startedAtMs !== undefined && args.nowMs !== undefined) {
    event.elapsed_bucket = bucketElapsedSeconds(args.nowMs - args.startedAtMs);
  }
  if (args.pending !== undefined) {
    event.pending_bucket = bucketPendingCount(args.pending);
  }
  if (args.lanes && args.lanes.length > 0) {
    const uniq = [...new Set(args.lanes.filter((l) => TRACKED_LANE_SET.has(l)))].sort();
    if (uniq.length > 0) event.lanes = uniq as SedimentWorkerTrackedLane[];
  }
  return event;
}

/** Whitelist-sanitize a progress event (drop unknown keys / identity). */
export function sanitizeWorkerProgressEvent(raw: unknown): SedimentWorkerProgressEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!PROGRESS_KEYS.has(key)) return null;
  }
  if (o.schema !== SEDIMENT_WORKER_PROGRESS_SCHEMA) return null;
  if (typeof o.stage !== "string" || !PROGRESS_STAGE_SET.has(o.stage)) return null;
  if (typeof o.phase !== "string" || !PROGRESS_PHASE_SET.has(o.phase)) return null;
  const event: SedimentWorkerProgressEvent = {
    schema: SEDIMENT_WORKER_PROGRESS_SCHEMA,
    stage: o.stage as SedimentWorkerProgressStage,
    phase: o.phase as SedimentWorkerProgressPhase,
  };
  if (o.elapsed_bucket !== undefined) {
    if (typeof o.elapsed_bucket !== "number" || !Number.isSafeInteger(o.elapsed_bucket) || !ELAPSED_BUCKET_SET.has(o.elapsed_bucket)) {
      return null;
    }
    event.elapsed_bucket = o.elapsed_bucket;
  }
  if (o.pending_bucket !== undefined) {
    if (typeof o.pending_bucket !== "number" || !Number.isSafeInteger(o.pending_bucket) || !PENDING_BUCKET_SET.has(o.pending_bucket)) {
      return null;
    }
    event.pending_bucket = o.pending_bucket;
  }
  if (o.lanes !== undefined) {
    if (!Array.isArray(o.lanes)) return null;
    const lanes: SedimentWorkerTrackedLane[] = [];
    for (const item of o.lanes) {
      if (typeof item !== "string" || !TRACKED_LANE_SET.has(item)) return null;
      lanes.push(item as SedimentWorkerTrackedLane);
    }
    if (lanes.length > 0) event.lanes = [...new Set(lanes)].sort() as SedimentWorkerTrackedLane[];
  }
  return event;
}

export function formatWorkerProgressNotify(event: SedimentWorkerProgressEvent): string {
  const clean = sanitizeWorkerProgressEvent(event);
  if (!clean) throw new WorkerValidationError("progress_invalid", "progress event failed whitelist");
  return `${SEDIMENT_WORKER_PROGRESS_NOTIFY_PREFIX}${JSON.stringify(clean)}`;
}

export function tryParseWorkerProgressNotify(message: string): SedimentWorkerProgressEvent | null {
  if (!message.startsWith(SEDIMENT_WORKER_PROGRESS_NOTIFY_PREFIX)) return null;
  try {
    return sanitizeWorkerProgressEvent(JSON.parse(message.slice(SEDIMENT_WORKER_PROGRESS_NOTIFY_PREFIX.length)));
  } catch {
    return null;
  }
}

/** Sensitive-content scan for progress notify payloads (must be empty of identity). */
export function progressNotifyHasSensitiveContent(message: string): boolean {
  // No paths, session ids, digests, content, or free-text fields allowed.
  if (!message.startsWith(SEDIMENT_WORKER_PROGRESS_NOTIFY_PREFIX)) return true;
  const body = message.slice(SEDIMENT_WORKER_PROGRESS_NOTIFY_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  // Whitelist parse first — schema may contain '/' (pi-astack/.../v1), which is not a path.
  // Stage names like "sidecar" are closed vocabulary, not identity fields.
  if (sanitizeWorkerProgressEvent(parsed) === null) return true;
  // Only flag identity *keys* (JSON key form "key":), not stage values.
  if (/"(session_id|request_id|terminal_record_id|owner_project_root|owner_key|sidecar_path|content_id|path|message|error|text)"\s*:/.test(body)) {
    return true;
  }
  // Absolute/relative filesystem path markers outside the schema string.
  if (/(?:^|[^a-zA-Z0-9_-])(?:\/home\/|\/tmp\/|\/var\/|\/Users\/|[A-Za-z]:\\)/.test(body)) {
    return true;
  }
  // 64-hex digests look like identity
  if (/[0-9a-f]{64}/i.test(body)) return true;
  return false;
}

export function emitWorkerProgress(
  onProgress: ((event: SedimentWorkerProgressEvent) => void) | undefined,
  event: SedimentWorkerProgressEvent,
): void {
  if (!onProgress) return;
  try {
    const clean = sanitizeWorkerProgressEvent(event);
    if (!clean) return;
    onProgress(clean);
  } catch {
    /* progress never fails the task */
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

  const budget_ms = parseWorkerBudgetMs(m.budget_ms);

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
    budget_ms,
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
  // verifyCreated=true: fail closed on create/read-back mismatch (no silent corrupt receipt).
  const status = await durableAtomicCreateFile(file, body, { mode: 0o600, verifyCreated: true });
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

/**
 * Read-only publication-outbox pending probe for settled task results.
 * Fail closed to true on read error (never fake empty). Closed audit only — no free text.
 */
export async function resolvePublicationPendingFlag(
  abrainHome: string,
  countFn?: (abrainHome: string) => Promise<number>,
  hasPendingFn?: (abrainHome: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    if (hasPendingFn) return (await hasPendingFn(abrainHome)) === true;
    if (!countFn) return await hasPublicationOutboxPending(abrainHome);
    const n = await countFn(abrainHome);
    if (!Number.isFinite(n) || n < 0) return true;
    return Math.floor(n) > 0;
  } catch {
    // Fail closed: cannot claim publication empty when outbox is unreadable.
    return true;
  }
}

async function withPublicationPendingFlag(
  result: SedimentWorkerResult,
  abrainHome: string,
  countFn?: (abrainHome: string) => Promise<number>,
  hasPendingFn?: (abrainHome: string) => Promise<boolean>,
): Promise<SedimentWorkerResult> {
  if (result.status !== "processed" && result.status !== "already_processed") {
    return result;
  }
  const publication_pending = await resolvePublicationPendingFlag(abrainHome, countFn, hasPendingFn);
  return { ...result, publication_pending };
}

function failResult(
  ids: { request_id: string; terminal_record_id: string },
  code: string,
  opts?: {
    status?: SedimentWorkerTaskStatus;
    retryable?: boolean;
    pass_iterations?: number;
    restart_child?: boolean;
  },
): SedimentWorkerResult {
  const status = opts?.status ?? "failed";
  const settled = status === "processed" || status === "already_processed";
  const deadline = isWorkerDeadlineErrorCode(code);
  // Explicit opts win. Poison closed set → true; plain deadline → false; else omit.
  const restartChild = opts?.restart_child
    ?? (isPoisonRestartCode(code) ? true : deadline ? false : undefined);
  return {
    schema: SEDIMENT_WORKER_RESULT_SCHEMA,
    request_id: ids.request_id,
    terminal_record_id: ids.terminal_record_id,
    status,
    settled,
    retryable: opts?.retryable ?? (deadline ? true : !settled),
    memory_decisions: 0,
    memory_writes: 0,
    error_code: code,
    ...(opts?.pass_iterations !== undefined ? { pass_iterations: opts.pass_iterations } : {}),
    ...(restartChild !== undefined ? { restart_child: restartChild } : {}),
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

/**
 * Process-local poison after unreaped/deadline. Subsequent worker-run returns
 * `worker_process_poisoned` immediately (no claim / no pass). Daemon must
 * kill-and-wait this Pi child before ledger retry/redrive — do NOT healthy-reuse.
 * Hung serial gates are NOT actively released (no detach of bad pass).
 * OFD claim is always released on RPC return; poison is the in-process depth
 * defense that refuses same-process work after claim release.
 */
let workerProcessPoisoned = false;
let workerProcessPoisonReason: string | undefined;

/** In-flight cancelable soft-deadline fences (must return to 0 after each task). */
let activeDeadlineFenceCount = 0;

/** Sentinel: fence stopped cleanly after work settled (not a business error). */
const FENCE_STOPPED = Symbol("sediment-worker-deadline-fence-stopped");

/** Test-only: reset global serial chain (does not abort in-flight work). */
export function _resetGlobalPassSerialForTests(): void {
  globalPassTail = Promise.resolve();
}

/** Test-only: clear process poison (production never clears). */
export function _resetWorkerProcessPoisonForTests(): void {
  workerProcessPoisoned = false;
  workerProcessPoisonReason = undefined;
}

export function isWorkerProcessPoisoned(): boolean {
  return workerProcessPoisoned;
}

export function workerProcessPoisonReasonForTests(): string | undefined {
  return workerProcessPoisonReason;
}

/** Test-only: outstanding cancelable deadline fences (must be 0 after task return). */
export function activeDeadlineFenceCountForTests(): number {
  return activeDeadlineFenceCount;
}

function markWorkerProcessPoisoned(reason: string): void {
  // L5: first poison reason is sticky — subsequent refuse paths must not
  // overwrite root cause (e.g. worker_process_poisoned on each reject).
  if (workerProcessPoisoned) return;
  workerProcessPoisoned = true;
  workerProcessPoisonReason = reason;
}

/**
 * Unique poison entry for all WorkerDeadlineError / deadline-code paths.
 * Only the poison closed set marks process poison; plain settled budget/stage/
 * detached_join codes are no-ops here.
 */
function poisonIfSerialOrUnreaped(code: string | undefined): void {
  if (isPoisonRestartCode(code)) {
    markWorkerProcessPoisoned(code!);
  }
}

/** Fail a deadline/poison code via the unique poison closed set + restart defaults. */
function failDeadline(
  ids: { request_id: string; terminal_record_id: string },
  code: string,
  opts?: { pass_iterations?: number; retryable?: boolean },
): SedimentWorkerResult {
  poisonIfSerialOrUnreaped(code);
  return failResult(ids, code, {
    restart_child: isPoisonRestartCode(code),
    ...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}),
    ...(opts?.pass_iterations !== undefined ? { pass_iterations: opts.pass_iterations } : {}),
  });
}

/** Test-injectable fence slice (ms); production default SEDIMENT_WORKER_FENCE_SLICE_MS. */
let fenceSliceMsOverride: number | undefined;

export function _setWorkerFenceSliceMsForTests(ms: number | undefined): void {
  fenceSliceMsOverride = ms;
}

function currentFenceSliceMs(): number {
  const raw = fenceSliceMsOverride ?? SEDIMENT_WORKER_FENCE_SLICE_MS;
  return Math.max(1, Math.min(SEDIMENT_WORKER_FENCE_SLICE_MS, raw));
}

function throwIfWorkerDeadline(opts?: {
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
  code?: SedimentWorkerDeadlineErrorCode;
}): void {
  if (opts?.signal?.aborted) {
    throw new WorkerDeadlineError(opts.code ?? "worker_budget_exhausted", "aborted");
  }
  if (opts?.deadlineMs !== undefined) {
    const now = opts.now ?? Date.now;
    if (now() >= opts.deadlineMs) {
      throw new WorkerDeadlineError(opts.code ?? "worker_budget_exhausted", "deadline exceeded");
    }
  }
}

/**
 * Wait for previous serial gate.
 * - No deadline + no signal: plain await.
 * - Signal-only: event-driven (prev settle OR abort) — **no poll timer**.
 * - Deadline present: single timer/race fence (slice ≤1s, test-injectable);
 *   does not append per-slice `.then` handlers on `prev` (one safePrev attach).
 */
async function waitPrevWithDeadline(
  prev: Promise<unknown>,
  opts?: { signal?: AbortSignal; deadlineMs?: number; now?: () => number },
): Promise<void> {
  const safePrev = prev.then(() => undefined, () => undefined);
  if (opts?.deadlineMs === undefined && !opts?.signal) {
    await safePrev;
    return;
  }

  // Signal-only: no infinite poll timer — wait for prev or abort event.
  if (opts?.deadlineMs === undefined && opts?.signal) {
    if (opts.signal.aborted) {
      throw new WorkerDeadlineError(
        "global_serial_deadline",
        "aborted while waiting for global serial",
      );
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        opts.signal!.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        opts.signal!.removeEventListener("abort", onAbort);
        reject(new WorkerDeadlineError(
          "global_serial_deadline",
          "aborted while waiting for global serial",
        ));
      };
      void safePrev.then(finishOk, finishOk);
      opts.signal!.addEventListener("abort", onAbort, { once: true });
    });
    return;
  }

  const now = opts!.now ?? Date.now;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    const finishOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      finishErr(new WorkerDeadlineError(
        "global_serial_deadline",
        "aborted while waiting for global serial",
      ));
    };

    const schedule = () => {
      if (settled) return;
      if (opts?.signal?.aborted) {
        onAbort();
        return;
      }
      if (opts?.deadlineMs !== undefined && now() >= opts.deadlineMs) {
        finishErr(new WorkerDeadlineError(
          "global_serial_deadline",
          "deadline while waiting for global serial",
        ));
        return;
      }
      const slice = currentFenceSliceMs();
      const rem = opts?.deadlineMs !== undefined
        ? Math.max(1, Math.min(slice, opts.deadlineMs - now()))
        : slice;
      timer = setTimeout(schedule, rem);
    };

    // Single attach — never re-append handlers each slice.
    void safePrev.then(finishOk, finishOk);

    if (opts?.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Immediate deadline check + first fence slice (handles already-resolved prev via microtask).
    if (opts?.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      finishErr(new WorkerDeadlineError(
        "global_serial_deadline",
        "deadline while waiting for global serial",
      ));
      return;
    }
    schedule();
  });
}

/**
 * Process-wide pass serial. Prior task rejection never poisons the tail chain.
 * When deadline/signal fires while waiting for the previous task, this waiter
 * releases *its own* gate without running `fn` and throws `global_serial_deadline`.
 * It does NOT release a hung previous pass (single-inflight fence).
 * `global_serial_deadline` is treated as process poison under single-worker contract.
 */
export async function withGlobalPassSerial<T>(
  fn: () => Promise<T>,
  opts?: { signal?: AbortSignal; deadlineMs?: number; now?: () => number },
): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = globalPassTail;
  // Always chain through both fulfill + reject so a rejected prev cannot poison tail.
  globalPassTail = prev.then(() => gate, () => gate);
  try {
    await waitPrevWithDeadline(prev, opts);
    throwIfWorkerDeadline({ ...opts, code: "global_serial_deadline" });
    return await fn();
  } finally {
    release();
  }
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function checkpointAdvanced(
  before: { lastProcessedEntryId?: string },
  after: { lastProcessedEntryId?: string },
): boolean {
  const b = before.lastProcessedEntryId ?? "";
  const a = after.lastProcessedEntryId ?? "";
  return a !== "" && a !== b;
}

/** True when durable CP lastProcessedEntryId equals the synthetic sidecar tip. */
function checkpointCoversBranchTip(
  cp: { lastProcessedEntryId?: string },
  branchEntries: readonly unknown[],
): boolean {
  const tip = branchEntries.length > 0 ? branchEntries[branchEntries.length - 1] : undefined;
  const tipId = tip && typeof tip === "object" && tip !== null && typeof (tip as { id?: unknown }).id === "string"
    ? (tip as { id: string }).id
    : undefined;
  if (!tipId || !cp.lastProcessedEntryId) return false;
  return cp.lastProcessedEntryId === tipId;
}

function failCpAdvancedNoReceipt(
  ids: { request_id: string; terminal_record_id: string },
  opts?: { pass_iterations?: number },
): SedimentWorkerResult {
  // Fail closed: not auto-retryable; poison + daemon kill-and-wait for diagnosis.
  return failDeadline(ids, SEDIMENT_WORKER_CP_ADVANCED_NO_RECEIPT_CODE, {
    retryable: false,
    ...(opts?.pass_iterations !== undefined ? { pass_iterations: opts.pass_iterations } : {}),
  });
}

function failProcessPoisoned(
  ids: { request_id: string; terminal_record_id: string },
): SedimentWorkerResult {
  return failDeadline(ids, SEDIMENT_WORKER_PROCESS_POISONED_CODE, {
    retryable: true,
  });
}

/**
 * Full worker task handler. Crash-safe: no durable success receipt until
 * real checkpoint advanced AND backlog exhausted (more=false). Busy claim is
 * OFD-backed and released on process death / RPC return (finally). Transient
 * failures leave no receipt. Unreaped/deadline poisons the process — daemon
 * must kill/reap before redrive; do not healthy-reuse.
 */
export async function runSedimentWorkerTask(
  argsRaw: string,
  deps: SedimentWorkerCommandDeps,
): Promise<SedimentWorkerResult> {
  // Budget clock starts at handler entry (covers validate / receipt / claim).
  const clock = deps.clock ?? Date.now;
  const startedAtMs = clock();
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

  // Process poison: refuse immediately — no claim, no pass, no serial wait.
  if (workerProcessPoisoned) {
    return failProcessPoisoned(ids);
  }

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
    const budgetMs = manifest.budget_ms;
    const absoluteDeadlineMs = startedAtMs + budgetMs;
    const softDeadlineMs = computeWorkerSoftDeadlineMs({ startedAtMs, budgetMs });
    const ac = new AbortController();
    const onProgress = deps.onProgress;
    const progress = (stage: SedimentWorkerProgressStage, phase: SedimentWorkerProgressPhase, extra?: {
      pending?: number;
      lanes?: readonly SedimentWorkerTrackedLane[];
    }) => {
      emitWorkerProgress(onProgress, buildWorkerProgressEvent({
        stage,
        phase,
        startedAtMs,
        nowMs: clock(),
        pending: extra?.pending,
        lanes: extra?.lanes,
      }));
    };

    if (softDeadlineMs - clock() <= 0) {
      try { ac.abort(); } catch { /* ignore */ }
    }

    // Receipt pre-check (fail closed on corrupt). Only success receipt ⇒ already_processed.
    try {
      throwIfWorkerDeadline({ signal: ac.signal, deadlineMs: softDeadlineMs, now: clock });
      const existing = await readProcessedReceipt(abrainHome, manifest.terminal_record_id);
      if (existing) {
        return await withPublicationPendingFlag(
          resultFromProcessedReceipt(existing, manifest.request_id),
          abrainHome,
          deps.countPublicationOutboxPending,
          deps.hasPublicationOutboxPending,
        );
      }
    } catch (err) {
      if (err instanceof WorkerDeadlineError) {
        // Plain budget before claim: settled immediately, CP not advanced → no poison.
        return failDeadline(ids, err.code);
      }
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

    // OFD claim is released in finally on every RPC return path (including unreaped).
    // After release, daemon seeing restart_child=true must kill-and-wait the Pi child
    // before ledger retry/redrive. Process poison is in-process depth defense that
    // refuses same-process tasks even after OFD is free.
    try {
      try {
        // Re-check under claim.
        progress("claim", "start");
        try {
          throwIfWorkerDeadline({ signal: ac.signal, deadlineMs: softDeadlineMs, now: clock });
          const again = await readProcessedReceipt(abrainHome, manifest.terminal_record_id);
          if (again) {
            progress("claim", "end");
            return await withPublicationPendingFlag(
              resultFromProcessedReceipt(again, manifest.request_id),
              abrainHome,
              deps.countPublicationOutboxPending,
              deps.hasPublicationOutboxPending,
            );
          }
        } catch (err) {
          if (err instanceof WorkerDeadlineError) {
            progress("claim", "aborted");
            return failDeadline(ids, err.code);
          }
          const code = err instanceof WorkerValidationError ? err.code : "receipt_corrupt_or_collision";
          return failResult(ids, code, { retryable: false });
        }
        progress("claim", "end");

        progress("sidecar", "start");
        let verified: VerifiedSidecarMessages;
        try {
          throwIfWorkerDeadline({ signal: ac.signal, deadlineMs: softDeadlineMs, now: clock });
          verified = await readAndVerifyWorkerSidecar({
            sidecarPath: manifest.sidecar_path,
            sessionId: manifest.session_id,
            contentId: manifest.content_id,
          });
        } catch (err) {
          if (err instanceof WorkerDeadlineError) {
            progress("sidecar", "aborted");
            return failDeadline(ids, err.code);
          }
          const code = err instanceof WorkerValidationError ? err.code : "sidecar_failed";
          // Validation / sidecar failures: settled=false, no durable failed receipt.
          return failResult(ids, code, { retryable: false });
        }
        progress("sidecar", "end");

        const snapshot = buildWorkerPassSnapshot({
          manifest,
          messages: verified.messages,
          modelRegistry: deps.modelRegistry,
        });
        const cpSessionId = snapshot.checkpointSessionId;
        const projectRoot = snapshot.cwd;

        // Baseline CP before this attempt (deadline capture + prior-no-receipt check).
        let beforePassCp: { lastProcessedEntryId?: string } = {};
        try {
          beforePassCp = await deps.loadSessionCheckpoint(projectRoot, cpSessionId);
          // Prior attempt advanced CP over this sidecar tip but never wrote a
          // success receipt → fail closed; do not guess already_processed.
          if (checkpointCoversBranchTip(beforePassCp, snapshot.branchEntries)) {
            return failCpAdvancedNoReceipt(ids);
          }
        } catch {
          return failResult(ids, "checkpoint_load_failed", { retryable: true });
        }

        // Pass body under global serial + soft deadline. Not a bare Promise.race:
        // on abort we wait ≤ cleanup reserve for settlement; unreaped → restart_child.
        let passSettled = false;
        let lastKnownAdvanced = false;

        const runPassBody = async (): Promise<SedimentWorkerResult> => {
          return await withGlobalPassSerial(async () => {
            let iterations = 0;
            let lastMore = false;
            let anyAdvanced = false;

            while (iterations < SEDIMENT_WORKER_MORE_BUDGET) {
              throwIfWorkerDeadline({
                signal: ac.signal,
                deadlineMs: softDeadlineMs,
                now: clock,
                code: "worker_budget_exhausted",
              });
              iterations += 1;
              progress("pass", "start");

              progress("checkpoint", "start");
              let beforeCp: { lastProcessedEntryId?: string };
              try {
                beforeCp = await deps.loadSessionCheckpoint(projectRoot, cpSessionId);
              } catch {
                return failResult(ids, "checkpoint_load_failed", { retryable: true, pass_iterations: iterations });
              }
              progress("checkpoint", "end");

              let passResult: SedimentWorkerPassOutcome;
              try {
                passResult = await deps.runAgentEndPass(snapshot, {
                  fromRecovery: false,
                  signal: ac.signal,
                  requestAbort: () => { try { ac.abort(); } catch { /* ignore */ } },
                  deadlineMs: softDeadlineMs,
                  onProgress: (ev) => emitWorkerProgress(onProgress, ev),
                  now: clock,
                });
              } catch (err) {
                if (err instanceof WorkerDeadlineError) {
                  progress("pass", "aborted");
                  return failDeadline(ids, err.code, { pass_iterations: iterations });
                }
                // Pass may throw plain Error with deadline code message/property
                // (e.g. index stage precheck → stage_deadline).
                const errCode = err instanceof Error
                  ? (err as Error & { code?: unknown }).code
                  : undefined;
                const code = err instanceof Error && isWorkerDeadlineErrorCode(err.message)
                  ? err.message
                  : typeof errCode === "string" && isWorkerDeadlineErrorCode(errCode)
                    ? errCode
                    : undefined;
                if (code) {
                  progress("pass", "aborted");
                  return failDeadline(ids, code, { pass_iterations: iterations });
                }
                // Task-scoped current-candidate deferred unfinished artifact
                // (multiview pending / staging deferred / promotion-needed):
                // retryable, no CP advance / no receipt / not processed.
                if (
                  (typeof errCode === "string" && errCode === "current_candidate_deferred")
                  || (err instanceof Error && err.message === "current_candidate_deferred")
                ) {
                  return failResult(ids, "current_candidate_deferred", {
                    retryable: true,
                    pass_iterations: iterations,
                  });
                }
                return failResult(ids, "pipeline_threw", { retryable: true, pass_iterations: iterations });
              }

              progress("checkpoint", "start");
              let afterCp: { lastProcessedEntryId?: string };
              try {
                afterCp = await deps.loadSessionCheckpoint(projectRoot, cpSessionId);
              } catch {
                return failResult(ids, "checkpoint_load_failed", { retryable: true, pass_iterations: iterations });
              }
              progress("checkpoint", "end");

              const advanced = checkpointAdvanced(beforeCp, afterCp);
              if (advanced) {
                anyAdvanced = true;
                lastKnownAdvanced = true;
              }
              // Explicit pass classification (M4): deterministic vs retryable no_progress.
              // no_progress may fail-without-receipt ONLY when this task never advanced CP.
              // If anyAdvanced (e.g. advance then empty_window), write processed receipt.
              const classifiedNoProgress = !!(passResult
                && typeof passResult === "object"
                && (passResult as { no_progress?: unknown }).no_progress === true);
              if (classifiedNoProgress && !anyAdvanced) {
                const classified = passResult as {
                  no_progress: true;
                  code: string;
                  retryable?: boolean;
                };
                const code = typeof classified.code === "string" && classified.code
                  ? classified.code
                  : "no_progress";
                const retryable = classified.retryable
                  ?? (isDeterministicNoProgressCode(code) ? false : true);
                progress("pass", "end");
                return failResult(ids, code, { retryable, pass_iterations: iterations });
              }
              lastMore = !classifiedNoProgress
                && !!(passResult && typeof passResult === "object" && (passResult as { more?: unknown }).more === true);
              progress("pass", "end");

              if (lastMore) {
                // more=true without real CP advance is no-progress / livelock — fail closed.
                if (!advanced) {
                  return failResult(ids, "no_progress", { retryable: true, pass_iterations: iterations });
                }
                // more loop must re-check remaining budget; cannot open 16 full budgets.
                continue;
              }

              // more=false (or classified no_progress after prior advance) terminal.
              if (!anyAdvanced && !advanced) {
                // Void return without classification remains retryable no_progress
                // (transient / unknown soft skip). Deterministic codes must be
                // surfaced explicitly by the pass (M4).
                return failResult(ids, "no_progress", { retryable: true, pass_iterations: iterations });
              }

              // Real CP advanced and backlog exhausted → create-only success receipt.
              // Soft deadline may already be past: use reserved hard deadline (≤5s)
              // for the create-only write. Do NOT soft-fence before receipt.
              // coversTip+no-receipt entry path remains fail-closed separately.
              progress("receipt", "start");
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
                const hardRem = Math.max(0, absoluteDeadlineMs - clock());
                if (hardRem <= 0) {
                  return failResult(ids, "receipt_write_failed", { retryable: true, pass_iterations: iterations });
                }
                const writeBudgetMs = Math.min(SEDIMENT_WORKER_CLEANUP_RESERVE_MS, hardRem);
                let timedOut = false;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  writeStatus = await Promise.race([
                    writeProcessedReceipt(abrainHome, receipt),
                    new Promise<never>((_, reject) => {
                      timer = setTimeout(() => {
                        timedOut = true;
                        reject(new Error("receipt_write_timeout"));
                      }, writeBudgetMs);
                    }),
                  ]);
                } finally {
                  if (timer !== undefined) clearTimeout(timer);
                  void timedOut;
                }
              } catch {
                return failResult(ids, "receipt_write_failed", { retryable: true, pass_iterations: iterations });
              }

              if (writeStatus === "collision") {
                // Fail closed: never return processed unless re-read is valid processed.
                // Consistent code receipt_corrupt_or_collision; no force-retry path.
                try {
                  const raced = await readProcessedReceipt(abrainHome, manifest!.terminal_record_id);
                  if (raced) {
                    progress("receipt", "end");
                    return await withPublicationPendingFlag(
                      resultFromProcessedReceipt(raced, manifest!.request_id),
                      abrainHome,
                      deps.countPublicationOutboxPending,
                      deps.hasPublicationOutboxPending,
                    );
                  }
                } catch {
                  /* fall through */
                }
                return failResult(ids, "receipt_corrupt_or_collision", { retryable: false, pass_iterations: iterations });
              }
              if (writeStatus === "identical") {
                try {
                  const raced = await readProcessedReceipt(abrainHome, manifest!.terminal_record_id);
                  if (raced) {
                    progress("receipt", "end");
                    return await withPublicationPendingFlag(
                      resultFromProcessedReceipt(raced, manifest!.request_id),
                      abrainHome,
                      deps.countPublicationOutboxPending,
                      deps.hasPublicationOutboxPending,
                    );
                  }
                } catch {
                  return failResult(ids, "receipt_corrupt_or_collision", { retryable: false, pass_iterations: iterations });
                }
              }

              // Success receipt is durable. Do NOT drain publication in-task
              // (no uncancelled Promise.race). Durable outbox + independent
              // maintenance own publication; stamp actual pending bool.
              progress("receipt", "end");
              return await withPublicationPendingFlag({
                schema: SEDIMENT_WORKER_RESULT_SCHEMA,
                request_id: manifest!.request_id,
                terminal_record_id: manifest!.terminal_record_id,
                status: "processed",
                settled: true,
                retryable: false,
                memory_decisions: 0,
                memory_writes: 0,
                pass_iterations: iterations,
              }, abrainHome, deps.countPublicationOutboxPending, deps.hasPublicationOutboxPending);
            }

            // more-iteration budget exhausted with more still true: retryable non-final, no receipt.
            return failResult(ids, "more_budget_exhausted", {
              retryable: true,
              pass_iterations: iterations,
            });
          }, {
            signal: ac.signal,
            deadlineMs: softDeadlineMs,
            now: clock,
          });
        };

        const workPromise = (async (): Promise<SedimentWorkerResult> => {
          try {
            return await runPassBody();
          } finally {
            passSettled = true;
          }
        })();

        // Soft-deadline fence: cancelable via AbortSignal; normal path must settle
        // (no permanent pending async frame). Polls injected `clock` so tests can
        // jump time. Fence slice ≤1s (test-injectable). Abort + ≤5s cleanup, then unreaped.
        const fenceStop = new AbortController();
        activeDeadlineFenceCount += 1;
        const deadlineFence = (async (): Promise<never> => {
          try {
            for (;;) {
              if (fenceStop.signal.aborted) {
                throw FENCE_STOPPED;
              }
              const rem = softDeadlineMs - clock();
              if (rem <= 0 || ac.signal.aborted) {
                try { ac.abort(); } catch { /* ignore */ }
                throw new WorkerDeadlineError(
                  "worker_budget_exhausted",
                  "soft deadline elapsed",
                );
              }
              const slice = currentFenceSliceMs();
              await sleepMs(Math.min(slice, Math.max(1, rem)), fenceStop.signal);
            }
          } finally {
            activeDeadlineFenceCount = Math.max(0, activeDeadlineFenceCount - 1);
          }
        })();

        const stopDeadlineFence = async (): Promise<void> => {
          if (!fenceStop.signal.aborted) {
            try { fenceStop.abort(); } catch { /* ignore */ }
          }
          try {
            await deadlineFence;
          } catch {
            /* WorkerDeadlineError or FENCE_STOPPED — both settle the frame */
          }
        };

        // Re-read CP after abort/deadline.
        // H1: durable processed receipt always wins → settled success (never
        // deadline_after_checkpoint_advanced / pass_unreaped poison).
        // ONLY coversTip + no receipt → deadline_after_checkpoint_advanced fatal.
        // Partial before→after CP advance is safe resume: ordinary retryable
        // deadline, no poison (more-loop partial watermark).
        // Plain settled codes only poison when unreaped / poison closed set.
        const resolveDeadlineOutcome = async (
          fallbackCode: SedimentWorkerDeadlineErrorCode,
        ): Promise<SedimentWorkerResult> => {
          try {
            const existing = await readProcessedReceipt(abrainHome, ids.terminal_record_id);
            if (existing) {
              return await withPublicationPendingFlag(
                resultFromProcessedReceipt(existing, ids.request_id),
                abrainHome,
                deps.countPublicationOutboxPending,
                deps.hasPublicationOutboxPending,
              );
            }
          } catch {
            /* corrupt receipt still fail-closed below if coversTip */
          }
          // Fast path: receipt file present even if re-read races (create-only).
          if (fsSync.existsSync(sedimentWorkerReceiptPath(abrainHome, ids.terminal_record_id))) {
            try {
              const raced = await readProcessedReceipt(abrainHome, ids.terminal_record_id);
              if (raced) {
                return await withPublicationPendingFlag(
                  resultFromProcessedReceipt(raced, ids.request_id),
                  abrainHome,
                  deps.countPublicationOutboxPending,
                  deps.hasPublicationOutboxPending,
                );
              }
            } catch {
              /* fall through to coversTip diagnostic */
            }
          }
          let coversTip = false;
          try {
            const after = await deps.loadSessionCheckpoint(projectRoot, cpSessionId);
            if (checkpointCoversBranchTip(after, snapshot.branchEntries)) {
              coversTip = true;
            }
          } catch {
            /* keep coversTip=false; partial lastKnownAdvanced is non-fatal */
          }
          if (coversTip) {
            return failCpAdvancedNoReceipt(ids);
          }
          // Partial CP advance / no advance: ordinary retryable deadline, no poison.
          return failDeadline(ids, fallbackCode);
        };

        /** After fence deadline only: CP advanced + failed settle without receipt → closed diagnostic. */
        const finalizeAfterDeadlineFence = async (
          settledResult: SedimentWorkerResult,
        ): Promise<SedimentWorkerResult> => {
          poisonIfSerialOrUnreaped(settledResult.error_code);
          if (settledResult.error_code === SEDIMENT_WORKER_CP_ADVANCED_NO_RECEIPT_CODE) {
            return settledResult;
          }
          if (
            settledResult.status === "failed"
            && !settledResult.settled
            && lastKnownAdvanced
            && settledResult.error_code !== "no_progress"
            && !fsSync.existsSync(sedimentWorkerReceiptPath(abrainHome, ids.terminal_record_id))
          ) {
            return await resolveDeadlineOutcome(
              isWorkerDeadlineErrorCode(settledResult.error_code)
                ? settledResult.error_code
                : "worker_budget_exhausted",
            );
          }
          return settledResult;
        };

        let result: SedimentWorkerResult;
        try {
          try {
            result = await Promise.race([workPromise, deadlineFence]);
          } catch (err) {
            if (err === FENCE_STOPPED) {
              result = await workPromise;
            } else if (err instanceof WorkerDeadlineError) {
              progress("pass", "aborted");
              if (!ac.signal.aborted) {
                try { ac.abort(); } catch { /* ignore */ }
              }
              const cleanupMs = Math.max(0, Math.min(
                SEDIMENT_WORKER_CLEANUP_RESERVE_MS,
                absoluteDeadlineMs - clock(),
              ));
              if (!passSettled && cleanupMs > 0) {
                await Promise.race([
                  workPromise.then(() => undefined, () => undefined),
                  sleepMs(cleanupMs),
                ]);
              }
              if (!passSettled) {
                // Background pass still running — do NOT detach serial (hung gate stays).
                // H1: if create-only receipt already durable, return settled success
                // (never pass_unreaped / deadline_after_checkpoint_advanced poison).
                // Otherwise poison process; daemon must kill-and-wait before redrive.
                return await resolveDeadlineOutcome("pass_deadline_exceeded_unreaped");
              }
              // Settled during cleanup window — plain codes must not poison when CP not advanced.
              try {
                result = await workPromise;
              } catch (inner) {
                if (inner instanceof WorkerDeadlineError) {
                  if (isPoisonRestartCode(inner.code)) {
                    return failDeadline(ids, inner.code);
                  }
                  return await resolveDeadlineOutcome(inner.code);
                }
                return await resolveDeadlineOutcome(err.code);
              }
              return await finalizeAfterDeadlineFence(result);
            } else {
              throw err;
            }
          }

          // Normal settle (work won race): poison closed set only; keep non-deadline codes intact.
          poisonIfSerialOrUnreaped(result.error_code);
          return result;
        } finally {
          // Always cancel + await fence cleanup so no permanent pending async frame remains.
          await stopDeadlineFence();
        }
      } finally {
        /* pass-scoped locals only */
      }
    } finally {
      // Always release OFD on RPC return — no fd leak. Unreaped does not hold claim.
      // restart_child=true ⇒ daemon kill-and-wait before ledger retry/redrive.
      try { lock.close(); } catch { /* best-effort */ }
    }
  } catch (err) {
    if (err instanceof WorkerDeadlineError) {
      return failDeadline(ids, err.code);
    }
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
        }) => Promise<void>;
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

      const onProgress = (event: SedimentWorkerProgressEvent) => {
        try {
          notify(formatWorkerProgressNotify(event), "info");
        } catch {
          /* progress notify failure must never fail the task */
        }
      };

      let result: SedimentWorkerResult;
      try {
        result = await runSedimentWorkerTask(args, {
          ...deps,
          modelRegistry: deps.modelRegistry ?? ctx.modelRegistry,
          onProgress: deps.onProgress ?? onProgress,
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
        const code = err instanceof WorkerDeadlineError
          ? err.code
          : err instanceof WorkerValidationError
            ? err.code
            : "worker_internal_error";
        result = failResult(
          { request_id: requestId, terminal_record_id: terminalId },
          code,
          {
            retryable: true,
            ...(err instanceof WorkerDeadlineError ? { restart_child: err.restart_child } : {}),
          },
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

// ─── Publication outbox maintenance RPC ───────────────────────────────────────

const MAINTENANCE_REQUEST_KEYS = new Set(["schema", "request_id", "budget_ms", "kind"]);
const MAINTENANCE_RESULT_KEYS = new Set([
  "schema",
  "request_id",
  "status",
  "retryable",
  "restart_child",
  "pending_before_bucket",
  "pending_after_bucket",
  "failed_bucket",
  "error_code",
  "elapsed_bucket",
]);

/** Closed outbox count buckets for maintenance result (pending/failed residual; not progress pending). */
export const SEDIMENT_WORKER_OUTBOX_PENDING_BUCKETS = ["unknown", "0", "1", "2-4", "5-9", "10-49", "50+"] as const;
export type SedimentWorkerOutboxPendingBucket = (typeof SEDIMENT_WORKER_OUTBOX_PENDING_BUCKETS)[number];
/** Alias: failed residual uses the same closed bucket set as pending. */
export type SedimentWorkerOutboxFailedBucket = SedimentWorkerOutboxPendingBucket;
const OUTBOX_PENDING_BUCKET_SET = new Set<string>(SEDIMENT_WORKER_OUTBOX_PENDING_BUCKETS);

export type SedimentWorkerMaintenanceStatus = "idle" | "drained" | "pending" | "failed";
const MAINTENANCE_STATUS_SET = new Set<string>(["idle", "drained", "pending", "failed"]);

export interface SedimentWorkerMaintenanceRequest {
  schema: typeof SEDIMENT_WORKER_MAINTENANCE_SCHEMA;
  request_id: string;
  budget_ms: number;
  kind: "publication_outbox";
}

export interface SedimentWorkerMaintenanceResult {
  schema: typeof SEDIMENT_WORKER_MAINTENANCE_RESULT_SCHEMA;
  request_id: string;
  status: SedimentWorkerMaintenanceStatus;
  retryable: boolean;
  restart_child: boolean;
  pending_before_bucket: SedimentWorkerOutboxPendingBucket;
  pending_after_bucket: SedimentWorkerOutboxPendingBucket;
  /**
   * Optional forward-compatible failed residual bucket (schema v1).
   * Closed: unknown|0|1|2-4|5-9|10-49|50+. Gate/read failure → unknown (never invented 0).
   */
  failed_bucket?: SedimentWorkerOutboxFailedBucket;
  error_code?: string;
  elapsed_bucket?: number;
}

export interface SedimentWorkerMaintenanceDeps {
  resolveAbrainHome: () => string;
  /**
   * Effective owner must be daemon (configured daemon + full triple gate).
   * Incomplete gate / foreground → closed config error, no writes.
   */
  resolveEffectiveExecutionOwner: () => "foreground" | "daemon";
  /** Production direct drain; must resolve the complete structured drain result. */
  drainKnowledgePublicationOutbox: (abrainHome: string) => Promise<PublicationOutboxDrainResult>;
  /** Production metadata-only pending count; must not deserialize item bodies. */
  countPublicationOutboxPending: (abrainHome: string) => Promise<number>;
  /**
   * Production metadata-only failed residual count (filename/schema/identity validated;
   * symlink/corrupt fail closed). Historical failed is critical and never auto-drained.
   * Optional: defaults to production countPublicationOutboxFailed.
   */
  countPublicationOutboxFailed?: (abrainHome: string) => Promise<number>;
  onProgress?: (event: SedimentWorkerProgressEvent) => void;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Test-only heartbeat interval override; production is exactly 5 seconds. */
  heartbeatMs?: number;
}

export function bucketOutboxPendingCount(n: number | null | undefined): SedimentWorkerOutboxPendingBucket {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "unknown";
  const c = Math.floor(n);
  if (c <= 0) return "0";
  if (c === 1) return "1";
  if (c <= 4) return "2-4";
  if (c <= 9) return "5-9";
  if (c <= 49) return "10-49";
  return "50+";
}

export function parseWorkerMaintenanceBudgetMs(raw: unknown): number {
  const n = parseSafeIntegerField(raw, "budget_ms");
  if (n < SEDIMENT_WORKER_MAINTENANCE_BUDGET_MIN_MS || n > SEDIMENT_WORKER_MAINTENANCE_BUDGET_MAX_MS) {
    throw new WorkerValidationError(
      "budget_ms_out_of_range",
      `budget_ms must be in [${SEDIMENT_WORKER_MAINTENANCE_BUDGET_MIN_MS}..${SEDIMENT_WORKER_MAINTENANCE_BUDGET_MAX_MS}]`,
    );
  }
  return n;
}

export function validateSedimentWorkerMaintenanceRequest(raw: unknown): SedimentWorkerMaintenanceRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkerValidationError("manifest_not_object", "maintenance request must be object");
  }
  const m = raw as Record<string, unknown>;
  rejectUnknownKeys(m, MAINTENANCE_REQUEST_KEYS, "unknown_field", "maintenance");
  if (m.schema !== SEDIMENT_WORKER_MAINTENANCE_SCHEMA) {
    throw new WorkerValidationError("schema_mismatch", "unsupported maintenance schema");
  }
  if (typeof m.request_id !== "string" || !HEX64_RE.test(m.request_id)) {
    throw new WorkerValidationError("invalid_request_id", "request_id must be 64 lowercase hex");
  }
  if (m.kind !== "publication_outbox") {
    throw new WorkerValidationError("kind_rejected", "only publication_outbox maintenance is admitted");
  }
  const budget_ms = parseWorkerMaintenanceBudgetMs(m.budget_ms);
  return {
    schema: SEDIMENT_WORKER_MAINTENANCE_SCHEMA,
    request_id: m.request_id,
    budget_ms,
    kind: "publication_outbox",
  };
}

export function parseSedimentWorkerMaintenanceArgs(args: string): SedimentWorkerMaintenanceRequest {
  const trimmed = (args ?? "").trim();
  if (!trimmed) throw new WorkerValidationError("empty_args", "maintenance args required");
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new WorkerValidationError("multiline_args", "maintenance must be single-line");
  }
  if (Buffer.byteLength(trimmed, "utf8") > SEDIMENT_WORKER_ARGS_MAX_BYTES) {
    throw new WorkerValidationError("args_too_large", "maintenance args exceed 64KiB");
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
      throw new WorkerValidationError("args_not_base64url", "maintenance is not valid base64url JSON");
    }
    if (buf.byteLength === 0) throw new WorkerValidationError("args_not_base64url", "empty base64url payload");
    if (buf.byteLength > SEDIMENT_WORKER_ARGS_MAX_BYTES) {
      throw new WorkerValidationError("args_too_large", "decoded maintenance exceeds 64KiB");
    }
    text = buf.toString("utf8");
    if (!text.startsWith("{")) {
      throw new WorkerValidationError("args_not_json", "decoded maintenance is not JSON object");
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WorkerValidationError("args_not_json", "maintenance JSON parse failed");
  }
  return validateSedimentWorkerMaintenanceRequest(raw);
}

function buildMaintenanceResult(args: {
  request_id: string;
  status: SedimentWorkerMaintenanceStatus;
  retryable: boolean;
  restart_child: boolean;
  pending_before: number | null;
  pending_after: number | null;
  /** null/undefined → failed_bucket unknown (never invent 0). */
  failed?: number | null;
  error_code?: string;
  startedAtMs?: number;
  nowMs?: number;
}): SedimentWorkerMaintenanceResult {
  const result: SedimentWorkerMaintenanceResult = {
    schema: SEDIMENT_WORKER_MAINTENANCE_RESULT_SCHEMA,
    request_id: args.request_id,
    status: args.status,
    retryable: args.retryable,
    restart_child: args.restart_child,
    pending_before_bucket: bucketOutboxPendingCount(args.pending_before),
    pending_after_bucket: bucketOutboxPendingCount(args.pending_after),
    // Always surface failed residual bucket (optional field for old readers; unknown when unread).
    failed_bucket: bucketOutboxPendingCount(args.failed),
  };
  if (args.error_code) result.error_code = args.error_code;
  if (args.startedAtMs !== undefined && args.nowMs !== undefined) {
    result.elapsed_bucket = bucketElapsedSeconds(args.nowMs - args.startedAtMs);
  }
  return result;
}

/** Whitelist-sanitize maintenance result (drop unknown keys / free text). */
export function sanitizeWorkerMaintenanceResult(raw: unknown): SedimentWorkerMaintenanceResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!MAINTENANCE_RESULT_KEYS.has(key)) return null;
  }
  if (o.schema !== SEDIMENT_WORKER_MAINTENANCE_RESULT_SCHEMA) return null;
  if (typeof o.request_id !== "string" || !HEX64_RE.test(o.request_id)) return null;
  if (typeof o.status !== "string" || !MAINTENANCE_STATUS_SET.has(o.status)) return null;
  if (typeof o.retryable !== "boolean") return null;
  if (typeof o.restart_child !== "boolean") return null;
  if (typeof o.pending_before_bucket !== "string" || !OUTBOX_PENDING_BUCKET_SET.has(o.pending_before_bucket)) return null;
  if (typeof o.pending_after_bucket !== "string" || !OUTBOX_PENDING_BUCKET_SET.has(o.pending_after_bucket)) return null;
  // Optional forward-compatible failed residual bucket.
  if (o.failed_bucket !== undefined) {
    if (typeof o.failed_bucket !== "string" || !OUTBOX_PENDING_BUCKET_SET.has(o.failed_bucket)) return null;
  }
  if (o.error_code !== undefined && (typeof o.error_code !== "string" || !o.error_code || /[\s\/\\]/.test(o.error_code))) {
    return null;
  }
  if (o.elapsed_bucket !== undefined) {
    if (typeof o.elapsed_bucket !== "number" || !Number.isSafeInteger(o.elapsed_bucket) || !ELAPSED_BUCKET_SET.has(o.elapsed_bucket)) {
      return null;
    }
  }
  const result: SedimentWorkerMaintenanceResult = {
    schema: SEDIMENT_WORKER_MAINTENANCE_RESULT_SCHEMA,
    request_id: o.request_id,
    status: o.status as SedimentWorkerMaintenanceStatus,
    retryable: o.retryable,
    restart_child: o.restart_child,
    pending_before_bucket: o.pending_before_bucket as SedimentWorkerOutboxPendingBucket,
    pending_after_bucket: o.pending_after_bucket as SedimentWorkerOutboxPendingBucket,
  };
  if (typeof o.failed_bucket === "string") {
    result.failed_bucket = o.failed_bucket as SedimentWorkerOutboxFailedBucket;
  }
  if (typeof o.error_code === "string") result.error_code = o.error_code;
  if (typeof o.elapsed_bucket === "number") result.elapsed_bucket = o.elapsed_bucket;
  return result;
}

export function formatWorkerMaintenanceResultNotify(result: SedimentWorkerMaintenanceResult): string {
  const clean = sanitizeWorkerMaintenanceResult(result);
  if (!clean) throw new WorkerValidationError("maintenance_result_invalid", "maintenance result failed whitelist");
  return `${SEDIMENT_WORKER_MAINTENANCE_RESULT_NOTIFY_PREFIX}${JSON.stringify(clean)}`;
}

export function tryParseWorkerMaintenanceResultNotify(message: string): SedimentWorkerMaintenanceResult | null {
  if (!message.startsWith(SEDIMENT_WORKER_MAINTENANCE_RESULT_NOTIFY_PREFIX)) return null;
  try {
    return sanitizeWorkerMaintenanceResult(
      JSON.parse(message.slice(SEDIMENT_WORKER_MAINTENANCE_RESULT_NOTIFY_PREFIX.length)),
    );
  } catch {
    return null;
  }
}

/** Sensitive-content scan for maintenance result notify (no identity / free text). */
export function maintenanceResultNotifyHasSensitiveContent(message: string): boolean {
  if (!message.startsWith(SEDIMENT_WORKER_MAINTENANCE_RESULT_NOTIFY_PREFIX)) return true;
  const body = message.slice(SEDIMENT_WORKER_MAINTENANCE_RESULT_NOTIFY_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  if (sanitizeWorkerMaintenanceResult(parsed) === null) return true;
  if (/"(session_id|terminal_record_id|owner_project_root|owner_key|sidecar_path|content_id|path|message|error|text|item_id|url)"\s*:/.test(body)) {
    return true;
  }
  if (/(?:^|[^a-zA-Z0-9_-])(?:\/home\/|\/tmp\/|\/var\/|\/Users\/|[A-Za-z]:\\)/.test(body)) {
    return true;
  }
  // request_id is required hex64 identity-correlation for daemon; allow only that closed field.
  // Reject other 64-hex blobs outside request_id value by checking non-request_id hex.
  const withoutRequestId = body.replace(/"request_id"\s*:\s*"[0-9a-f]{64}"/g, "\"request_id\":\"\"");
  if (/[0-9a-f]{64}/i.test(withoutRequestId)) return true;
  return false;
}

async function safeCountPublicationPending(
  abrainHome: string,
  countFn: (abrainHome: string) => Promise<number>,
): Promise<{ ok: true; count: number } | { ok: false }> {
  try {
    const n = await countFn(abrainHome);
    if (!Number.isFinite(n) || n < 0) return { ok: false };
    return { ok: true, count: Math.floor(n) };
  } catch {
    return { ok: false };
  }
}

function normalizePublicationDrainResult(raw: unknown): PublicationOutboxDrainResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("publication drain returned no structured result");
  }
  const value = raw as Record<string, unknown>;
  if (value.status !== "busy" && value.status !== "completed") {
    throw new Error("publication drain returned invalid status");
  }
  const integer = (field: string, min: number): number => {
    const n = value[field];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min) {
      throw new Error(`publication drain returned invalid ${field}`);
    }
    return n;
  };
  const result: PublicationOutboxDrainResult = {
    status: value.status,
    processed: integer("processed", 0),
    drained: integer("drained", 0),
    terminalFailed: integer("terminalFailed", 0),
    pending: integer("pending", -1),
  };
  if (value.lastError !== undefined) {
    if (typeof value.lastError !== "string" || value.lastError.length === 0) {
      throw new Error("publication drain returned invalid lastError");
    }
    result.lastError = value.lastError;
  }
  return result;
}

/**
 * Local publication-outbox maintenance under daemon effective owner + worker
 * security env gates. It shares the task pass serial and calls only the direct
 * production drain; no checkpoint / receipt / ledger / source work is admitted.
 */
export async function runSedimentWorkerMaintenance(
  argsRaw: string,
  deps: SedimentWorkerMaintenanceDeps,
): Promise<SedimentWorkerMaintenanceResult> {
  const clock = deps.clock ?? Date.now;
  const startedAtMs = clock();
  let request: SedimentWorkerMaintenanceRequest;
  try {
    request = parseSedimentWorkerMaintenanceArgs(argsRaw);
  } catch (err) {
    const code = err instanceof WorkerValidationError ? err.code : "manifest_invalid";
    return buildMaintenanceResult({
      request_id: "0".repeat(64),
      status: "failed",
      retryable: false,
      restart_child: false,
      pending_before: null,
      pending_after: null,
      error_code: code,
      startedAtMs,
      nowMs: clock(),
    });
  }

  const requestId = request.request_id;
  const finish = (args: {
    status: SedimentWorkerMaintenanceStatus;
    retryable: boolean;
    restart_child: boolean;
    pending_before: number | null;
    pending_after: number | null;
    /** null/undefined → failed_bucket unknown. */
    failed?: number | null;
    error_code?: string;
  }): SedimentWorkerMaintenanceResult => buildMaintenanceResult({
    request_id: requestId,
    ...args,
    startedAtMs,
    nowMs: clock(),
  });

  if (workerProcessPoisoned) {
    return finish({
      status: "failed",
      retryable: true,
      restart_child: true,
      pending_before: null,
      pending_after: null,
      error_code: SEDIMENT_WORKER_PROCESS_POISONED_CODE,
    });
  }

  const absoluteDeadlineMs = startedAtMs + request.budget_ms;
  const softDeadlineMs = computeWorkerSoftDeadlineMs({ startedAtMs, budgetMs: request.budget_ms });
  const ac = new AbortController();
  const progress = (phase: SedimentWorkerProgressPhase) => {
    emitWorkerProgress(deps.onProgress, buildWorkerProgressEvent({
      stage: "publication",
      phase,
      startedAtMs,
      nowMs: clock(),
    }));
  };

  progress("start");
  const heartbeat = setInterval(() => progress("heartbeat"), deps.heartbeatMs ?? 5_000);
  heartbeat.unref?.();

  const runExclusive = async (): Promise<SedimentWorkerMaintenanceResult> => {
    try {
      if (deps.resolveEffectiveExecutionOwner() !== "daemon") {
        return finish({
          status: "failed",
          retryable: false,
          restart_child: false,
          pending_before: null,
          pending_after: null,
          error_code: "effective_owner_not_daemon",
        });
      }
      // Maintenance carries no record identity, but it must still pass the same
      // worker copy-store + non-empty realpath owner allowlist validation.
      resolveWorkerSecurityEnv(deps.env ?? process.env);
    } catch (err) {
      const code = err instanceof WorkerValidationError ? err.code : "worker_security_gate_failed";
      return finish({
        status: "failed",
        retryable: false,
        restart_child: false,
        pending_before: null,
        pending_after: null,
        error_code: code,
      });
    }

    let abrainHome: string;
    try {
      abrainHome = path.resolve(deps.resolveAbrainHome());
    } catch {
      return finish({
        status: "failed",
        retryable: false,
        restart_child: false,
        pending_before: null,
        pending_after: null,
        error_code: "worker_configuration_invalid",
      });
    }

    const beforePendingProbe = await safeCountPublicationPending(abrainHome, deps.countPublicationOutboxPending);
    if (!beforePendingProbe.ok) {
      return finish({
        status: "failed",
        retryable: true,
        restart_child: false,
        pending_before: null,
        pending_after: null,
        failed: null,
        error_code: "publication_outbox_count_failed",
      });
    }
    const countFailedFn = deps.countPublicationOutboxFailed ?? countPublicationOutboxFailedProduction;
    const beforeFailedProbe = await safeCountPublicationPending(abrainHome, countFailedFn);
    if (!beforeFailedProbe.ok) {
      return finish({
        status: "failed",
        retryable: true,
        restart_child: false,
        pending_before: beforePendingProbe.count,
        pending_after: null,
        failed: null,
        error_code: "publication_outbox_failed_count_failed",
      });
    }
    const pendingBefore = beforePendingProbe.count;
    const failedBefore = beforeFailedProbe.count;
    // idle only when both pending and failed residual are empty.
    if (pendingBefore === 0 && failedBefore === 0) {
      return finish({
        status: "idle",
        retryable: false,
        restart_child: false,
        pending_before: 0,
        pending_after: 0,
        failed: 0,
      });
    }
    // Historical failed residual is critical: never claim idle/drained; do not auto-requeue/delete.
    if (pendingBefore === 0 && failedBefore > 0) {
      return finish({
        status: "failed",
        retryable: false,
        restart_child: false,
        pending_before: 0,
        pending_after: 0,
        failed: failedBefore,
        error_code: "publication_terminal_failed_present",
      });
    }
    if (softDeadlineMs <= clock()) {
      if (!ac.signal.aborted) ac.abort();
      return finish({
        status: "pending",
        retryable: true,
        restart_child: false,
        pending_before: pendingBefore,
        pending_after: null,
        failed: failedBefore,
        error_code: "worker_budget_exhausted",
      });
    }

    let drainSettled = false;
    const workPromise = runWithWorkerBudget(
      { deadlineMs: softDeadlineMs, signal: ac.signal, now: clock },
      async (): Promise<PublicationOutboxDrainResult> => {
        try {
          throwIfWorkerDeadline({
            signal: ac.signal,
            deadlineMs: softDeadlineMs,
            now: clock,
            code: "worker_budget_exhausted",
          });
          return normalizePublicationDrainResult(await deps.drainKnowledgePublicationOutbox(abrainHome));
        } finally {
          drainSettled = true;
        }
      },
    );
    // Keep a rejection observer even when deadline cleanup has zero milliseconds.
    void workPromise.catch(() => undefined);

    const fenceStop = new AbortController();
    activeDeadlineFenceCount += 1;
    const deadlineFence = (async (): Promise<never> => {
      try {
        for (;;) {
          if (fenceStop.signal.aborted) throw FENCE_STOPPED;
          const remaining = softDeadlineMs - clock();
          if (remaining <= 0 || ac.signal.aborted) {
            if (!ac.signal.aborted) ac.abort();
            throw new WorkerDeadlineError("worker_budget_exhausted", "publication soft deadline elapsed");
          }
          await sleepMs(Math.min(currentFenceSliceMs(), Math.max(1, remaining)), fenceStop.signal);
        }
      } finally {
        activeDeadlineFenceCount = Math.max(0, activeDeadlineFenceCount - 1);
      }
    })();

    const stopDeadlineFence = async (): Promise<void> => {
      if (!fenceStop.signal.aborted) fenceStop.abort();
      try { await deadlineFence; } catch { /* settle fence frame */ }
    };

    const classifyDrain = async (drain: PublicationOutboxDrainResult): Promise<SedimentWorkerMaintenanceResult> => {
      const afterPendingProbe = await safeCountPublicationPending(abrainHome, deps.countPublicationOutboxPending);
      const afterFailedProbe = await safeCountPublicationPending(abrainHome, countFailedFn);
      const pendingAfter = afterPendingProbe.ok ? afterPendingProbe.count : null;
      // Prefer after failed residual; fall back to before when after unread (never invent 0).
      const failedAfter = afterFailedProbe.ok ? afterFailedProbe.count : null;
      const failedKnown = failedAfter ?? failedBefore;

      // This-round terminal move takes the specific code; residual still surfaces failed_bucket.
      if (drain.terminalFailed > 0) {
        return finish({
          status: "failed",
          retryable: false,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          failed: failedKnown,
          error_code: "publication_terminal_failed",
        });
      }
      // Durable failed residual is critical regardless of pending/busy/held remaining.
      if (failedAfter !== null && failedAfter > 0) {
        return finish({
          status: "failed",
          retryable: false,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          failed: failedAfter,
          error_code: "publication_terminal_failed_present",
        });
      }
      if (drain.status === "busy") {
        return finish({
          status: "pending",
          retryable: true,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          failed: failedKnown,
          error_code: "publication_drain_busy",
        });
      }
      if (drain.lastError === "publication_l1_pending") {
        return finish({
          status: "pending",
          retryable: true,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          failed: failedKnown,
          error_code: "publication_l1_pending",
        });
      }
      if (drain.lastError !== undefined) {
        return finish({
          status: "failed",
          retryable: true,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          failed: failedKnown,
          error_code: "publication_drain_failed",
        });
      }
      if (!afterPendingProbe.ok) {
        return finish({
          status: "failed",
          retryable: true,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: null,
          failed: failedKnown,
          error_code: "publication_outbox_count_failed",
        });
      }
      if (!afterFailedProbe.ok) {
        return finish({
          status: "failed",
          retryable: true,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          failed: null,
          error_code: "publication_outbox_failed_count_failed",
        });
      }
      if (pendingAfter! > 0) {
        return finish({
          status: "pending",
          retryable: true,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          failed: failedAfter,
          error_code: "publication_remaining",
        });
      }
      return finish({
        status: "drained",
        retryable: false,
        restart_child: false,
        pending_before: pendingBefore,
        pending_after: 0,
        failed: 0,
      });
    };

    const classifyThrow = async (): Promise<SedimentWorkerMaintenanceResult> => {
      const afterPendingProbe = await safeCountPublicationPending(abrainHome, deps.countPublicationOutboxPending);
      const afterFailedProbe = await safeCountPublicationPending(abrainHome, countFailedFn);
      const failedAfter = afterFailedProbe.ok ? afterFailedProbe.count : null;
      // Historical failed residual still critical even when drain threw.
      if (failedAfter !== null && failedAfter > 0) {
        return finish({
          status: "failed",
          retryable: false,
          restart_child: false,
          pending_before: pendingBefore,
          pending_after: afterPendingProbe.ok ? afterPendingProbe.count : null,
          failed: failedAfter,
          error_code: "publication_terminal_failed_present",
        });
      }
      return finish({
        status: "failed",
        retryable: true,
        restart_child: false,
        pending_before: pendingBefore,
        pending_after: afterPendingProbe.ok ? afterPendingProbe.count : null,
        failed: failedAfter ?? failedBefore,
        error_code: "publication_drain_failed",
      });
    };

    try {
      try {
        return await classifyDrain(await Promise.race([workPromise, deadlineFence]));
      } catch (err) {
        if (err instanceof WorkerDeadlineError) {
          if (!ac.signal.aborted) ac.abort();
          const cleanupMs = Math.max(0, Math.min(
            SEDIMENT_WORKER_CLEANUP_RESERVE_MS,
            absoluteDeadlineMs - clock(),
          ));
          if (!drainSettled && cleanupMs > 0) {
            await Promise.race([
              workPromise.then(() => undefined, () => undefined),
              sleepMs(cleanupMs),
            ]);
          }
          if (!drainSettled) {
            poisonIfSerialOrUnreaped("cancel_cleanup_unreaped");
            return finish({
              status: "failed",
              retryable: true,
              restart_child: true,
              pending_before: pendingBefore,
              pending_after: null,
              failed: failedBefore,
              error_code: "cancel_cleanup_unreaped",
            });
          }
          try {
            return await classifyDrain(await workPromise);
          } catch {
            return await classifyThrow();
          }
        }
        return await classifyThrow();
      }
    } finally {
      await stopDeadlineFence();
    }
  };

  try {
    const result = await withGlobalPassSerial(runExclusive, {
      signal: ac.signal,
      deadlineMs: softDeadlineMs,
      now: clock,
    });
    progress(result.status === "failed" ? "aborted" : "end");
    return result;
  } catch (err) {
    if (!ac.signal.aborted) ac.abort();
    const code = err instanceof WorkerDeadlineError ? err.code : "worker_internal_error";
    progress("aborted");
    if (code === "global_serial_deadline") {
      // This maintenance invocation never entered runExclusive, so it owns no
      // drain to reap and must not poison or kill the healthy serial owner.
      return finish({
        status: "pending",
        retryable: true,
        restart_child: false,
        pending_before: null,
        pending_after: null,
        error_code: "maintenance_worker_busy",
      });
    }
    return finish({
      status: "failed",
      retryable: true,
      restart_child: false,
      pending_before: null,
      pending_after: null,
      error_code: code,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export function registerSedimentWorkerMaintenanceCommand(
  pi: {
    registerCommand?: (
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: {
          ui?: { notify?(message: string, type?: string): void };
        }) => Promise<void>;
      },
    ) => void;
  },
  deps: SedimentWorkerMaintenanceDeps,
): void {
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand(SEDIMENT_WORKER_MAINTENANCE_COMMAND_NAME, {
    description:
      "Daemon Stage0 sediment worker maintenance: drain publication outbox within budget (JSON or base64url). No agent turn.",
    async handler(args, ctx) {
      const notify = ctx.ui?.notify?.bind(ctx.ui);
      if (typeof notify !== "function") {
        return;
      }

      const onProgress = (event: SedimentWorkerProgressEvent) => {
        try {
          notify(formatWorkerProgressNotify(event), "info");
        } catch {
          /* progress notify failure must never fail the task */
        }
      };

      let result: SedimentWorkerMaintenanceResult;
      try {
        result = await runSedimentWorkerMaintenance(args, {
          ...deps,
          onProgress: deps.onProgress ?? onProgress,
        });
      } catch (err) {
        let requestId = "0".repeat(64);
        try {
          requestId = parseSedimentWorkerMaintenanceArgs(args).request_id;
        } catch { /* keep zeros */ }
        const code = err instanceof WorkerDeadlineError
          ? err.code
          : err instanceof WorkerValidationError
            ? err.code
            : "worker_internal_error";
        if (isPoisonRestartCode(code)) poisonIfSerialOrUnreaped(code);
        result = buildMaintenanceResult({
          request_id: requestId,
          status: "failed",
          retryable: true,
          restart_child: isPoisonRestartCode(code),
          pending_before: null,
          pending_after: null,
          error_code: code,
        });
      }

      const clean = sanitizeWorkerMaintenanceResult(result) ?? result;
      const type = clean.status === "failed" ? "error" : clean.status === "pending" ? "warning" : "info";
      try {
        notify(formatWorkerMaintenanceResultNotify(clean), type);
      } catch {
        /* RPC notify failure after execution */
      }
    },
  });
}
