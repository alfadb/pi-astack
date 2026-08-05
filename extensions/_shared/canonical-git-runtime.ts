import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  CONSTRAINT_L2_V1,
  KNOWLEDGE_L2_V1,
  canonicalKnowledgeManifestRelativePathV1,
} from "./canonical-l2-contract";
import {
  cohortPlanSemanticRoot,
  convergeExactCohortIndex,
  isAncestor,
  LOCAL_DRAIN_METADATA_CHECKPOINT_PROTOCOL_V1,
  LOCAL_DRAIN_PROTOCOL_V3,
  prepareExactCohortCommit,
  publishExactCohortCommit,
  resolveRef,
  snapshotIndexEntries,
  type CohortPlanEntry,
} from "./git-exact-cohort";
import { gitSingleFlight, gitSingleFlightWithDeadline } from "./git-singleflight";
import {
  CanonicalMutationBarrierError,
  canonicalMutationBarrierHeld,
  withCanonicalMutationBarrier,
  withCanonicalMutationBarrierInSingleFlight,
} from "./canonical-mutation-barrier";
import { parseGitStatusPorcelainV1Z, type GitPorcelainV1Record } from "./git-z-parser";
import { recoverDeviceJoinJournal } from "./device-join-coordinator";
import {
  RECOVERY_LANE_BUDGETS,
  claimNextRecoverySlotV3,
  foldRecoveryEventsV3,
  frozenIndexSnapshotRootV3,
  readRecoveryEventsV3,
  recoverDrainSlotV3,
  recoverOpenRecoveryEpisodesV3FromScan,
  recoveryEpisodeCursorV3,
  recordDrainPreparedV3,
  recoveryEpisodeIdentityV3,
  recoveryOperationV3,
} from "./convergence-recovery";
import {
  classifyRecoveryHistory,
  type CombinedRecoveryHistoryResult,
} from "./recovery-history-classifier";
import {
  decideCsjNextKick,
  readCsjJournal,
  runCsjInBarrier,
} from "./csj-prospective-merge";
import {
  buildCanonicalBlockedMemo,
  clearCanonicalBlockedMemo,
  writeCanonicalBlockedMemo,
} from "./csj-blocked-memo";
import {
  adaptCsjClosedReason,
  type CsjClosedReason,
} from "./csj-closed-reason";
import {
  computeL1InventoryFingerprint,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import {
  deviceJoinJournalPresent,
  L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT,
  readLastKnownReadyFingerprint,
  registryContentHash,
  tryAcquireL1ScanMutex,
  writeLastKnownReadyFingerprint,
} from "./l1-validated-scan-cache";
import { sha256Hex } from "./jcs";
import {
  clampStartupBudgetToWorker,
  getWorkerBudgetContext,
  runOutsideWorkerBudget,
} from "./worker-budget-context";

const execFileAsync = promisify(execFile);
const GLOBAL_KEY = Symbol.for("pi-astack/canonical-git-runtime/v1");
const API_VERSION = 1;
const SETTINGS_MODE = "local_convergence_v2" as const;
const MAX_DIAGNOSTIC_TAIL = 64;
const DEFAULT_STARTUP_BUSY_BUDGET_MS = 60 * 60_000;
const DEFAULT_STARTUP_BUSY_INITIAL_BACKOFF_MS = 250;
const DEFAULT_STARTUP_BUSY_MAX_BACKOFF_MS = 10_000;
const DEFAULT_STARTUP_BARRIER_TIMEOUT_MS = 30_000;
const RECOVERY_METADATA_ENVELOPE_SCHEMAS = new Set([
  "drain-recovery-envelope/v1",
  "local-drain-recovery-envelope/v2",
  "local-drain-recovery-envelope/v3",
]);
const STARTUP_DOMAIN_ERROR_NAMES = new Set([
  "CanonicalGitRuntimeError",
  "ConvergenceRecoveryError",
  "DeviceJoinError",
  "GitExactCohortError",
  "GitZParseError",
  "L1SchemaRegistryError",
  "RecoveryHistoryClassificationError",
]);

function isTypedStartupDomainError(error: unknown): error is Error & { code: string; detail?: Readonly<Record<string, unknown>> } {
  return error instanceof Error
    && STARTUP_DOMAIN_ERROR_NAMES.has(error.name)
    && typeof (error as { code?: unknown }).code === "string";
}

/**
 * Diagnostic reason surface: keep machine domain codes and CSJ closed codes;
 * strip path/OID-looking free text. Never invent t2_budget_exhausted from
 * unrelated owner_alert messages.
 */
function redactDiagnosticReason(reason: string, code?: string): string {
  const trimmed = reason.trim();
  if (!trimmed) return code && code.trim() ? code.trim() : "internal_error";
  const closed = adaptCsjClosedReason({ reason: trimmed, code });
  // Prefer closed-set only when the input itself was already a closed code.
  if (closed.reason_code !== "internal_error" && (trimmed === closed.reason_code || trimmed.endsWith(`: ${closed.reason_code}`))) {
    return closed.reason_code;
  }
  // Domain messages look like "CODE: detail" — keep the whole message but drop
  // absolute paths and bare git OIDs so diagnostics stay closed on ids.
  let out = trimmed
    .replace(/(?:^|[\s"'`=])(\/[A-Za-z0-9._\-\/]+)/g, " <path>")
    .replace(/\b[0-9a-f]{40}\b/gi, "<oid>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<oid>");
  if (code && !out.includes(code)) out = `${code}: ${out}`;
  return out;
}

export interface CanonicalGitRuntimeSettings {
  enabled: boolean;
  mode: typeof SETTINGS_MODE;
  valid: boolean;
  reason: "enabled" | "disabled" | "missing" | "invalid" | "unreadable";
  settingsPath: string;
}

export type ProducedArtifactOwner =
  | "knowledge_l1"
  | "constraint_l1"
  | "canonical_path_meta"
  | "knowledge_l2"
  | "constraint_l2"
  | "writer_transaction";

export interface ProducedArtifact {
  path: string;
  op: "put" | "delete";
  mode: "100644" | "100755" | null;
  bytes: number;
  bytesSha256: string | null;
  owner: ProducedArtifactOwner;
  sourceIds: readonly string[];
}

const CANONICAL_CONTENT_OWNERS = new Set<ProducedArtifactOwner>([
  "knowledge_l1",
  "knowledge_l2",
  "constraint_l1",
  "constraint_l2",
]);

function isCanonicalContentOwner(owner: ProducedArtifactOwner): boolean {
  return CANONICAL_CONTENT_OWNERS.has(owner);
}

/** Canonical backlog / drain / metadata-checkpoint ownership only covers l1/l2.
 *  Non-canonical dirty (e.g. tracked `.gitignore` ` M`, untracked writer files)
 *  stays outside the transaction: no receipt, no block, no mutation. */
function isCanonicalTreePath(rel: string): boolean {
  return rel.startsWith("l1/") || rel.startsWith("l2/");
}

function statusTouchesCanonicalTree(row: Pick<GitPorcelainV1Record, "paths">): boolean {
  return row.paths.some((item) => isCanonicalTreePath(item));
}

type DrainGenerationPolicy = "steady_writer" | "startup_content_backlog";
type ValidatedArtifact = { receipt: ProducedArtifact; content?: Buffer };
type RecoveryMetadataRecord = WholeL1ScanResult["all"][number];

interface RecoveryMetadataCheckpointBacklog {
  readonly head: string;
  readonly statusHash: string;
  readonly scan: WholeL1ScanResult;
  readonly artifacts: readonly ValidatedArtifact[];
}

/** Metadata-only means exactly a non-empty cohort of validated runtime metadata. */
function isCanonicalMetadataOnlyCohort(artifacts: readonly ValidatedArtifact[] | readonly ProducedArtifact[]): boolean {
  return artifacts.length > 0 && artifacts.every((artifact) => {
    const receipt = "receipt" in artifact ? artifact.receipt : artifact;
    return receipt.owner === "canonical_path_meta";
  });
}

function survivingValidatedArtifacts(plan: readonly CohortPlanEntry[], validated: readonly ValidatedArtifact[]): ValidatedArtifact[] {
  const byPath = new Map(validated.map((artifact) => [artifact.receipt.path, artifact]));
  return plan.map((entry) => {
    const artifact = byPath.get(entry.path);
    if (!artifact) throw new CanonicalGitRuntimeError("PLAN_OWNER_UNVALIDATED", "surviving plan entry has no validated owner", { path: entry.path });
    return artifact;
  });
}

export interface LoadedProvenanceEntry {
  label: string;
  path: string;
  bytesSha256: string;
  loadedBlobOid: string | null;
  headBlobOid: string | null;
}

export type CanonicalStartupDeferredReason =
  | "CANONICAL_MUTATION_BUSY"
  | "STARTUP_BUDGET_EXHAUSTED"
  | "CANONICAL_SCAN_BUSY"
  | "CANONICAL_SCAN_LOCK_FAILED";

export interface CanonicalRuntimeDiagnostics {
  apiVersion: number;
  repo: string;
  settings: CanonicalGitRuntimeSettings;
  startupGeneration: number;
  startup: "not_started" | "running" | "ready" | "blocked" | "deferred";
  blockedReason?: string;
  deferredReason?: CanonicalStartupDeferredReason;
  retryable?: true;
  ownerAlert?: true;
  loadedProvenance: readonly LoadedProvenanceEntry[];
  implementationFingerprint: string;
  tail: readonly Record<string, unknown>[];
}

/** Cached/process-local diagnostics only. Never starts startup, creates a runtime,
 *  installs a promise/singleflight, or acquires the mutation barrier. */
export interface CanonicalRuntimePeek {
  status: "none" | "not_started" | "running" | "ready" | "blocked" | "deferred";
  reason?: string;
  deferredReason?: CanonicalStartupDeferredReason;
  retryable?: true;
  generation?: number;
  lastPhase?: string;
  repo?: string;
  implementationFingerprint?: string;
}

export type CanonicalStartupHostMode = "tui" | "rpc" | "json" | "print";
export type CanonicalStartupNotificationType = "info" | "warning" | "error";
export type CanonicalStartupReporter = (message: string, type: CanonicalStartupNotificationType) => void;
type CanonicalStartupTaskScheduler = (task: () => void) => unknown;

interface CanonicalStartupConsumerInvocation {
  onReady: (diagnostics: CanonicalRuntimeDiagnostics) => Promise<void> | void;
  onBlocked?: (diagnostics: CanonicalRuntimeDiagnostics) => Promise<void> | void;
  blockedMessage: (diagnostics: CanonicalRuntimeDiagnostics) => string;
  errorMessage: (error: unknown) => string;
}

interface CanonicalStartupConsumerState {
  reporter?: CanonicalStartupReporter;
  latest?: CanonicalStartupConsumerInvocation;
  scheduled: boolean;
  running?: Promise<void>;
}

type CanonicalStartupPhase =
  | "freeze_initial"
  | "classify_initial"
  | "bootstrap_mutation"
  | "classify_recovery"
  | "recovery_mutation"
  | "classify_final"
  | "publish_ready";

interface FrozenStartupClassificationInputs {
  head: string;
  scan: WholeL1ScanResult;
  scanRoot: string;
  statusHash: string;
  inventoryFingerprint: string;
}

export interface BacklogPreflightResult {
  status: "ready" | "empty" | "blocked";
  statusHash: string;
  receipts: readonly ProducedArtifact[];
  ownership: Readonly<Record<string, readonly string[]>>;
  reason?: string;
}

export interface DrainResult {
  status: "disabled" | "empty" | "metadata_deferred" | "blocked" | "index_converged" | "consumed";
  commit?: string;
  candidate?: string;
  episodeId?: string;
  slot?: number;
  localCommit: "not_published" | "published" | "index_converged";
  reason?: string;
  ownerAlert?: true;
}

export interface CanonicalOwnershipInstrumentation {
  wholeL1Scans: number;
  knowledgeIdentityCount: number;
  knowledgeFoldRenders: number;
  globalManifestRenders: number;
  constraintDecisionRenders: number;
  headMembershipQueries: number;
  indexMembershipQueries: number;
  elapsedMs: number;
}

export interface CanonicalOwnershipContext {
  readonly repo: string;
  readonly scan: WholeL1ScanResult;
  readonly headPaths: ReadonlySet<string>;
  readonly indexPaths: ReadonlySet<string>;
  readonly instrumentation: CanonicalOwnershipInstrumentation;
  readonly _knowledgeByIdentity: ReadonlyMap<string, { nodes: readonly any[]; rendered: any }>;
  readonly _knowledgeManifest?: { nodes: readonly any[]; rendered: any };
  readonly _constraint?: { sourceIds: readonly string[]; markdown: string; projectionEventId: string };
}

export interface CanonicalConstraintL2ProjectionRender {
  readonly repo: string;
  readonly projectionEventId: string;
  readonly createdAtUtc: string;
  readonly sourceIds: readonly string[];
  readonly markdown: string;
  readonly bytes: number;
  readonly bytesSha256: string;
  readonly decisionHash: string;
}

export interface CanonicalGitRuntimeOptions {
  abrainHome: string;
  settingsPath?: string;
  sourceRoot?: string;
  refName?: string;
  /** Timeout for one low-level barrier acquisition; production defaults to 30s. */
  startupBarrierTimeoutMs?: number;
  /** Monotonic total deadline from startup-attempt entry through all barrier acquisitions and busy retries. */
  startupBusyBudgetMs?: number;
  startupBusyInitialBackoffMs?: number;
  startupBusyMaxBackoffMs?: number;
  /** Deterministic test hooks; production uses Math.random, setTimeout, and hrtime. */
  startupRetryRandom?: () => number;
  startupRetrySleep?: (delayMs: number) => Promise<void>;
  startupMonotonicNow?: () => number;
  /**
   * Test-only: invoked after CAS publish, before index converge. Production never
   * sets this. Also gated by PI_ASTACK_ENABLE_TEST_HOOKS=1 at the call site.
   * Used to deterministically produce blocked+localCommit==="published".
   */
  drainPostPublishTestHook?: () => void | Promise<void>;
  /**
   * Test-only: invoked after mutation preflight inside prePublishCheck, before CAS.
   * Production never sets this. Dual-gated by PI_ASTACK_ENABLE_TEST_HOOKS=1.
   * Used to leave a prepared episode without publication (not_published rollback path).
   */
  drainPrePublishTestHook?: () => void | Promise<void>;
  /**
   * Test-only: force AncOpen T2 budget exhausted on first NextKick evaluation so
   * runtime ownerAlert + startupState=blocked is exercised (not pure decideCsjNextKick).
   * Dual-gated by PI_ASTACK_ENABLE_TEST_HOOKS=1.
   */
  csjForceT2BudgetExhausted?: boolean;
}

export interface CanonicalGitRuntime {
  awaitStartup(): Promise<CanonicalRuntimeDiagnostics>;
  recoverAtStartup(): Promise<void>;
  requestDrain(receipts: readonly ProducedArtifact[], message?: string): Promise<DrainResult>;
  requestBacklogPreflight(): Promise<BacklogPreflightResult>;
  settleForDeviceJoin(): Promise<void>;
  diagnostics(): CanonicalRuntimeDiagnostics;
}

export class CanonicalGitRuntimeError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CanonicalGitRuntimeError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

interface GlobalRuntimeState {
  apiVersion: number;
  implementationFingerprint?: string;
  loadedProvenance?: readonly LoadedProvenanceEntry[];
  runtimes: Map<string, CanonicalGitRuntimeImpl>;
  startupPromises: Map<string, Promise<CanonicalRuntimeDiagnostics>>;
  startupPromiseGenerations: Map<string, number>;
  startupPromiseGenerationTokens: WeakMap<Promise<CanonicalRuntimeDiagnostics>, number>;
  /** Process-level promises that have settled ready. Kick may replace these for a
   * fresh convergence attempt; getCanonicalStartupPromise keeps reusing them. */
  startupPromiseReadySettled: WeakSet<Promise<CanonicalRuntimeDiagnostics>>;
  startupConsumers: Map<string, CanonicalStartupConsumerState>;
  startupFailureNotifications: Set<string>;
  startupFailureNotificationGenerations: Map<string, number>;
  startupWarningNotifications: Map<string, { generation: number; readyGeneration: number; signatures: Set<string> }>;
}

function globalState(): GlobalRuntimeState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[GLOBAL_KEY] as Partial<GlobalRuntimeState> | undefined;
  if (!existing) {
    const created: GlobalRuntimeState = {
      apiVersion: API_VERSION,
      runtimes: new Map(),
      startupPromises: new Map(),
      startupPromiseGenerations: new Map(),
      startupPromiseGenerationTokens: new WeakMap(),
      startupPromiseReadySettled: new WeakSet(),
      startupConsumers: new Map(),
      startupFailureNotifications: new Set(),
      startupFailureNotificationGenerations: new Map(),
      startupWarningNotifications: new Map(),
    };
    global[GLOBAL_KEY] = created;
    return created;
  }
  if (existing.apiVersion !== API_VERSION || !(existing.runtimes instanceof Map)) {
    throw new CanonicalGitRuntimeError("RUNTIME_SINGLETON_SPLIT", "incompatible process-global canonical runtime singleton");
  }
  if (!(existing.startupPromises instanceof Map)) existing.startupPromises = new Map();
  if (!(existing.startupPromiseGenerations instanceof Map)) existing.startupPromiseGenerations = new Map();
  if (!(existing.startupPromiseGenerationTokens instanceof WeakMap)) existing.startupPromiseGenerationTokens = new WeakMap();
  if (!(existing.startupPromiseReadySettled instanceof WeakSet)) existing.startupPromiseReadySettled = new WeakSet();
  if (!(existing.startupConsumers instanceof Map)) existing.startupConsumers = new Map();
  if (!(existing.startupFailureNotifications instanceof Set)) existing.startupFailureNotifications = new Set();
  if (!(existing.startupFailureNotificationGenerations instanceof Map)) existing.startupFailureNotificationGenerations = new Map();
  if (!(existing.startupWarningNotifications instanceof Map)) existing.startupWarningNotifications = new Map();
  return existing as GlobalRuntimeState;
}

/** Read-only view of the process-global runtime singleton. Never creates one. */
function peekGlobalState(): GlobalRuntimeState | null {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[GLOBAL_KEY] as Partial<GlobalRuntimeState> | undefined;
  if (!existing || existing.apiVersion !== API_VERSION || !(existing.runtimes instanceof Map)) return null;
  return existing as GlobalRuntimeState;
}

/** Align startup-key / peek / runtime map lookups when the path exists.
 * Falls back to path.resolve when realpath is unavailable (not-yet-created
 * roots). Async getCanonicalGitRuntime still uses repoRealpath; callers that
 * pass pre-realpath'ed ABRAIN roots avoid the rare resolve/realpath fork. */
function resolveCanonicalRepoKey(abrainHome: string): string {
  const resolved = path.resolve(abrainHome);
  try {
    return fsSync.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function resolvePeekRepoKey(abrainHome?: string): string | null {
  if (!abrainHome) return null;
  return resolveCanonicalRepoKey(abrainHome);
}

function lastStartupPhaseFromTail(tail: readonly Record<string, unknown>[]): string | undefined {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const row = tail[index]!;
    if (row.operation === "startup_phase" && typeof row.phase === "string") return row.phase;
    if (row.operation === "startup" && typeof row.status === "string") return `startup:${row.status}`;
  }
  return undefined;
}

function defaultSettingsPath(): string {
  return process.env.PI_ASTACK_SETTINGS_PATH
    ? path.resolve(process.env.PI_ASTACK_SETTINGS_PATH)
    : path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");
}

export function resolveCanonicalGitRuntimeSettings(settingsPath = defaultSettingsPath()): CanonicalGitRuntimeSettings {
  const resolved = path.resolve(settingsPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fsSync.readFileSync(resolved, "utf-8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return Object.freeze({
      enabled: false,
      mode: SETTINGS_MODE,
      valid: false,
      reason: code === "ENOENT" ? "missing" : code ? "unreadable" : "invalid",
      settingsPath: resolved,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Object.freeze({ enabled: false, mode: SETTINGS_MODE, valid: false, reason: "invalid", settingsPath: resolved });
  }
  const raw = (parsed as Record<string, unknown>).canonicalGitRuntime;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze({ enabled: false, mode: SETTINGS_MODE, valid: false, reason: "missing", settingsPath: resolved });
  }
  const cfg = raw as Record<string, unknown>;
  const keys = Object.keys(cfg).sort(compareAscii);
  const allowed = new Set(["_comment", "enabled", "mode"]);
  if (
    keys.some((key) => !allowed.has(key))
    || typeof cfg.enabled !== "boolean"
    || cfg.mode !== SETTINGS_MODE
    || (Object.hasOwn(cfg, "_comment") && typeof cfg._comment !== "string")
  ) {
    return Object.freeze({ enabled: false, mode: SETTINGS_MODE, valid: false, reason: "invalid", settingsPath: resolved });
  }
  return Object.freeze({ enabled: cfg.enabled, mode: SETTINGS_MODE, valid: true, reason: cfg.enabled ? "enabled" : "disabled", settingsPath: resolved });
}

export type CanonicalGitRuntimeDisposition = "enabled" | "legacy";

/** Only an explicit, schema-valid enabled=false selects the legacy boundary. */
export function canonicalGitRuntimeDisposition(settingsPath?: string): CanonicalGitRuntimeDisposition {
  const settings = resolveCanonicalGitRuntimeSettings(settingsPath);
  if (!settings.valid) {
    throw new CanonicalGitRuntimeError(
      "CANONICAL_GIT_SETTINGS_INVALID",
      `canonicalGitRuntime settings are ${settings.reason}: ${settings.settingsPath}`,
      { reason: settings.reason, settingsPath: settings.settingsPath },
    );
  }
  return settings.enabled ? "enabled" : "legacy";
}

export function canonicalGitRuntimeEnabled(settingsPath?: string): boolean {
  return canonicalGitRuntimeDisposition(settingsPath) === "enabled";
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Narrow shared Git isolation for canonical repo reads (global/system config
 * nulled, prompts off, optional locks off). Prefer this over copying env. */
export function sanitizedCanonicalGitEnvironment(): NodeJS.ProcessEnv {
  return sanitizedGitEnvironment();
}

/** Exact `HEAD^{commit}` under the same isolation as runtime git(). */
export async function readCanonicalHeadOid(
  repo: string,
  timeoutMs: number = 10_000,
): Promise<string> {
  const head = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"], timeoutMs)).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
    throw new CanonicalGitRuntimeError("CANONICAL_HEAD_INVALID", "rev-parse HEAD did not return a full Git OID", {
      repo: path.resolve(repo),
    });
  }
  return head;
}

async function git(repo: string, args: readonly string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: sanitizedGitEnvironment(),
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf-8",
  });
  return stdout;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function gitIsAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant], 10_000);
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 1) return false;
    throw error;
  }
}

function sourcePaths(sourceRoot: string, settingsPath: string): Array<[string, string]> {
  return [
    ["orchestrator", path.join(sourceRoot, "extensions/_shared/canonical-git-runtime.ts")],
    ["dossier-evidence-validator", path.join(sourceRoot, "extensions/_shared/p1a-dossier-evidence.ts")],
    ["singleflight", path.join(sourceRoot, "extensions/_shared/git-singleflight.ts")],
    ["mutation-barrier", path.join(sourceRoot, "extensions/_shared/canonical-mutation-barrier.ts")],
    ["retained-directory-lock", path.join(sourceRoot, "extensions/_shared/retained-directory-lock.ts")],
    ["retained-directory-ofd-lock", path.join(sourceRoot, "extensions/_shared/retained-directory-ofd-lock.ts")],
    ["windows-native-addon", path.join(sourceRoot, "extensions/_shared/windows-native-addon.ts")],
    ["device-join-coordinator", path.join(sourceRoot, "extensions/_shared/device-join-coordinator.ts")],
    ["git-z-parser", path.join(sourceRoot, "extensions/_shared/git-z-parser.ts")],
    ["recovery", path.join(sourceRoot, "extensions/_shared/convergence-recovery.ts")],
    ["recovery-history-classifier", path.join(sourceRoot, "extensions/_shared/recovery-history-classifier.ts")],
    ["canonical-l2-contract", path.join(sourceRoot, "extensions/_shared/canonical-l2-contract.ts")],
    ["canonical-l2-reconciler", path.join(sourceRoot, "extensions/_shared/canonical-l2-reconciler.ts")],
    ["exact", path.join(sourceRoot, "extensions/_shared/git-exact-cohort.ts")],
    ["durable-write", path.join(sourceRoot, "extensions/_shared/durable-write.ts")],
    ["jcs", path.join(sourceRoot, "extensions/_shared/jcs.ts")],
    ["l1-registry-implementation", path.join(sourceRoot, "extensions/_shared/l1-schema-registry.ts")],
    ["memory-parser", path.join(sourceRoot, "extensions/memory/parser.ts")],
    ["writer", path.join(sourceRoot, "extensions/sediment/writer.ts")],
    ["knowledge-evidence-renderer", path.join(sourceRoot, "extensions/sediment/knowledge-evidence.ts")],
    ["constraint-projector", path.join(sourceRoot, "extensions/sediment/constraint-compiler/projection.ts")],
    ["constraint-renderer", path.join(sourceRoot, "extensions/sediment/constraint-compiler/render.ts")],
    ["constraint-normalizer", path.join(sourceRoot, "extensions/sediment/constraint-compiler/normalize.ts")],
    ["constraint-auto-refresh", path.join(sourceRoot, "extensions/sediment/constraint-compiler/auto-refresh.ts")],
    ["constraint-event-integration", path.join(sourceRoot, "extensions/sediment/constraint-evidence/integration.ts")],
    ["git-sync", path.join(sourceRoot, "extensions/abrain/git-sync.ts")],
    ["abrain-index", path.join(sourceRoot, "extensions/abrain/index.ts")],
    ["sediment-index", path.join(sourceRoot, "extensions/sediment/index.ts")],
    ["rename-wiring", path.join(sourceRoot, "extensions/memory/rename-entry.ts")],
    ["reconcile", path.join(sourceRoot, "extensions/abrain/reconcile-gate.ts")],
    ["settings-schema", path.join(sourceRoot, "pi-astack-settings.schema.json")],
    ["registry", path.join(sourceRoot, "schemas/l1-schema-role-registry.json")],
    ["settings", settingsPath],
  ];
}

async function sourceGitRoot(sourceRoot: string): Promise<string | null> {
  try {
    return (await git(sourceRoot, ["rev-parse", "--show-toplevel"], 5_000)).trim();
  } catch {
    return null;
  }
}

async function captureLoadedProvenance(sourceRoot: string, settingsPath: string): Promise<readonly LoadedProvenanceEntry[]> {
  const gitRoot = await sourceGitRoot(sourceRoot);
  const entries: LoadedProvenanceEntry[] = [];
  for (const [label, file] of sourcePaths(sourceRoot, settingsPath)) {
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(file);
    } catch (error) {
      throw new CanonicalGitRuntimeError("PROVENANCE_SOURCE_UNREADABLE", `cannot read ${label} source`, { file, error: String(error) });
    }
    let headBlobOid: string | null = null;
    let loadedBlobOid: string | null = null;
    if (gitRoot) {
      const rel = path.relative(gitRoot, file).split(path.sep).join("/");
      if (rel && rel !== ".." && !rel.startsWith("../")) {
        try {
          headBlobOid = (await git(gitRoot, ["rev-parse", `HEAD:${rel}`], 5_000)).trim() || null;
        } catch {
          headBlobOid = null;
        }
        try {
          loadedBlobOid = (await git(gitRoot, ["hash-object", "--", file], 5_000)).trim() || null;
        } catch {
          loadedBlobOid = null;
        }
      }
    }
    entries.push(Object.freeze({ label, path: path.resolve(file), bytesSha256: sha256Hex(bytes), loadedBlobOid, headBlobOid }));
  }
  return Object.freeze(entries.sort((a, b) => compareAscii(a.label, b.label)));
}

function provenanceFingerprint(entries: readonly LoadedProvenanceEntry[]): string {
  // Process identity follows the bytes actually loaded, not the absolute path of
  // the source copy. Equivalent jiti/sourceRoot copies of the same bytes must
  // not split the process-level implementation fingerprint. LoadedProvenance
  // still retains path for diagnostics and freeze asserts.
  return sha256Hex(JSON.stringify(
    [...entries]
      .map((entry) => [entry.label, entry.bytesSha256] as const)
      .sort((a, b) => compareAscii(a[0], b[0])),
  ));
}

async function assertProvenanceFrozen(sourceRoot: string, settingsPath: string, frozen: readonly LoadedProvenanceEntry[]): Promise<void> {
  const current = await captureLoadedProvenance(sourceRoot, settingsPath);
  const byLabel = new Map(current.map((entry) => [entry.label, entry]));
  const drifted = frozen.filter((loaded) => {
    const now = byLabel.get(loaded.label);
    if (!now || now.path !== loaded.path || now.bytesSha256 !== loaded.bytesSha256 || now.loadedBlobOid !== loaded.loadedBlobOid) return true;
    // A final source commit may legitimately move HEAD from the pre-load blob
    // to the exact bytes already loaded. Any byte drift after load still blocks.
    return now.headBlobOid !== loaded.headBlobOid && now.headBlobOid !== loaded.loadedBlobOid;
  });
  if (drifted.length || current.length !== frozen.length) {
    throw new CanonicalGitRuntimeError("PROVENANCE_DRIFT", "loaded implementation/settings bytes changed before mutation", {
      frozen: provenanceFingerprint(frozen),
      current: provenanceFingerprint(current),
      drifted: drifted.map((entry) => entry.label),
    });
  }
}

async function repoRealpath(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const real = await fsp.realpath(resolved);
  const top = (await git(real, ["rev-parse", "--show-toplevel"], 5_000)).trim();
  const topReal = await fsp.realpath(top);
  if (topReal !== real) throw new CanonicalGitRuntimeError("REPO_ROOT_MISMATCH", "abrainHome must be the git worktree root", { real, topReal });
  return real;
}

async function indexLockPath(repo: string): Promise<string> {
  const absoluteGitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"], 5_000)).trim();
  if (!path.isAbsolute(absoluteGitDir)) throw new CanonicalGitRuntimeError("GIT_DIR_UNSAFE", "git returned a non-absolute git dir");
  return path.join(absoluteGitDir, "index.lock");
}

export async function preflightSharedIndexLock(repo: string): Promise<void> {
  const lockPath = await indexLockPath(repo);
  try {
    const stat = await fsp.lstat(lockPath);
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    const ageMs = Number.isFinite(stat.mtimeMs) ? Math.max(0, Math.floor(Date.now() - stat.mtimeMs)) : "unknown";
    const diagnostic = `kind=${kind} ageMs=${ageMs} inode=${stat.ino} size=${stat.size} dev=${stat.dev} mode=${stat.mode & 0o7777}`;
    throw new CanonicalGitRuntimeError(
      "INDEX_LOCK_PRESENT",
      `shared index lock exists; it is never removed by canonical runtime (${diagnostic})`,
      {
        lockPath,
        kind,
        ageMs,
        inode: stat.ino,
        size: stat.size,
        dev: stat.dev,
        mode: stat.mode & 0o7777,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
}

function canonicalRelative(repo: string, file: string): string {
  const rel = path.relative(repo, path.resolve(file)).split(path.sep).join("/");
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || rel.startsWith("/") || rel.includes("\0")) {
    throw new CanonicalGitRuntimeError("ARTIFACT_PATH_UNSAFE", "artifact path escapes repository", { file });
  }
  return rel;
}

function ownerForRelative(rel: string): ProducedArtifactOwner {
  if (rel.startsWith("l1/events/sha256/")) return "canonical_path_meta";
  if (rel.startsWith("l2/views/knowledge/")) return "knowledge_l2";
  if (rel === CONSTRAINT_L2_V1.canonicalPath) return "constraint_l2";
  return "writer_transaction";
}

export async function createProducedArtifactReceipt(options: {
  abrainHome: string;
  filePath: string;
  owner?: ProducedArtifactOwner;
  sourceIds?: readonly string[];
  op?: "put" | "delete";
}): Promise<ProducedArtifact> {
  const repo = path.resolve(options.abrainHome);
  const rel = canonicalRelative(repo, options.filePath);
  const op = options.op ?? (await fsp.lstat(options.filePath).then(() => "put" as const).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "delete" as const;
    throw error;
  }));
  const owner = options.owner ?? ownerForRelative(rel);
  if (op === "delete") {
    return Object.freeze({ path: rel, op, mode: null, bytes: 0, bytesSha256: null, owner, sourceIds: Object.freeze([...(options.sourceIds ?? [])].sort(compareAscii)) });
  }
  const stat = await fsp.lstat(options.filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CanonicalGitRuntimeError("ARTIFACT_NON_REGULAR", "put artifact must be a regular non-symlink file", { rel });
  const bytes = await fsp.readFile(options.filePath);
  return Object.freeze({
    path: rel,
    op,
    mode: (stat.mode & 0o111) ? "100755" : "100644",
    bytes: bytes.length,
    bytesSha256: sha256Hex(bytes),
    owner,
    sourceIds: Object.freeze([...(options.sourceIds ?? [])].sort(compareAscii)),
  });
}

async function gitBuffer(repo: string, args: readonly string[], timeout = 30_000): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: sanitizedGitEnvironment(),
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout as Buffer;
}

/** Exported for CSJ/C2 statusHash bit-exact homology (spec §4.3 / A19). */
export async function statusSnapshot(repo: string): Promise<{ raw: Buffer; hash: string; rows: GitPorcelainV1Record[] }> {
  const raw = await gitBuffer(repo, ["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"]);
  return { raw, hash: sha256Hex(raw), rows: parseGitStatusPorcelainV1Z(raw) };
}

async function assertRepoMutationPreflight(repo: string, refName: string): Promise<void> {
  const symbolic = (await git(repo, ["symbolic-ref", "-q", "HEAD"], 5_000)).trim();
  if (symbolic !== refName || !/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(symbolic) || symbolic.includes("..")) {
    throw new CanonicalGitRuntimeError("REF_UNSAFE", "HEAD is detached or does not match the configured fully-qualified branch", { symbolic, refName });
  }
  const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"], 5_000)).trim();
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "BISECT_LOG"]) {
    try {
      await fsp.lstat(path.join(gitDir, marker));
      throw new CanonicalGitRuntimeError("REPO_OPERATION_IN_PROGRESS", `unsafe repository operation marker exists: ${marker}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  if ((await git(repo, ["ls-files", "-u"], 5_000)).trim()) throw new CanonicalGitRuntimeError("UNMERGED_INDEX", "index contains unmerged entries");
}

/** CSJ eligibility E18–E23 preflight surface (same semantics as internal mutation preflight). */
export async function assertRepoMutationPreflightForCsj(repo: string, refName: string): Promise<void> {
  await assertRepoMutationPreflight(repo, refName);
}

async function readArtifactBytes(repo: string, receipt: ProducedArtifact): Promise<Buffer | undefined> {
  if (receipt.op === "delete") return undefined;
  const target = path.resolve(repo, ...receipt.path.split("/"));
  const bytes = await fsp.readFile(target);
  if (bytes.length !== receipt.bytes || sha256Hex(bytes) !== receipt.bytesSha256) {
    throw new CanonicalGitRuntimeError("ARTIFACT_RECEIPT_DRIFT", "artifact bytes no longer match receipt", { path: receipt.path });
  }
  const stat = await fsp.lstat(target);
  const mode = (stat.mode & 0o111) ? "100755" : "100644";
  if (!stat.isFile() || stat.isSymbolicLink() || mode !== receipt.mode) {
    throw new CanonicalGitRuntimeError("ARTIFACT_RECEIPT_DRIFT", "artifact mode/type no longer matches receipt", { path: receipt.path });
  }
  return bytes;
}

async function validateL1Artifact(repo: string, rel: string, bytes: Buffer): Promise<ProducedArtifactOwner> {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf-8")); } catch { throw new CanonicalGitRuntimeError("L1_INVALID", "L1 artifact is not JSON", { rel }); }
  const registry = loadL1SchemaRegistry();
  const validated = validateL1Envelope(parsed, { registry, abrainHome: repo, filePath: path.join(repo, rel), relativePath: rel });
  if (validated.registration.phase === "legacy_read_only") throw new CanonicalGitRuntimeError("LEGACY_L1_EXCLUDED", "legacy read-only L1 is excluded from active ownership", { rel });
  if (validated.registration.domain === "knowledge") return "knowledge_l1";
  if (validated.registration.domain === "constraint") return "constraint_l1";
  return "canonical_path_meta";
}

async function isLegacyReadOnlyL1(repo: string, rel: string): Promise<boolean> {
  if (!rel.startsWith("l1/events/sha256/")) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(await fsp.readFile(path.join(repo, rel), "utf-8")); }
  catch (error) { throw new CanonicalGitRuntimeError("L1_INVALID", "L1 artifact is not valid JSON", { rel, error: String(error) }); }
  const validated = validateL1Envelope(parsed, { registry: loadL1SchemaRegistry(), abrainHome: repo, filePath: path.join(repo, rel), relativePath: rel });
  return validated.registration.phase === "legacy_read_only";
}

function isRecoveryMetadataRecord(record: RecoveryMetadataRecord | undefined): record is RecoveryMetadataRecord {
  return !!record
    && record.registration.domain === "canonical_path"
    && record.registration.role === "meta"
    && (record.registration.phase === "active" || record.registration.phase === "legacy_read_only")
    && RECOVERY_METADATA_ENVELOPE_SCHEMAS.has(record.registration.envelope_schema);
}

async function validateRecoveryMetadataArtifact(repo: string, record: RecoveryMetadataRecord): Promise<ValidatedArtifact> {
  const rel = record.relativePath;
  if (!rel || !isRecoveryMetadataRecord(record)) {
    throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_OWNER_INVALID", "metadata checkpoint record has no strict recovery ownership");
  }
  const filePath = path.join(repo, ...rel.split("/"));
  const rawReceipt = await createProducedArtifactReceipt({ abrainHome: repo, filePath, owner: "canonical_path_meta", sourceIds: [record.eventId] });
  const content = await readArtifactBytes(repo, rawReceipt);
  if (!content) throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_DELETE_FORBIDDEN", "recovery metadata checkpoint is append-only", { path: rel });
  let parsed: unknown;
  try { parsed = JSON.parse(content.toString("utf-8")); }
  catch { throw new CanonicalGitRuntimeError("L1_INVALID", "recovery metadata checkpoint artifact is not JSON", { path: rel }); }
  const live = validateL1Envelope(parsed, {
    registry: loadL1SchemaRegistry(),
    abrainHome: repo,
    filePath,
    relativePath: rel,
  });
  if (!isRecoveryMetadataRecord({ ...record, registration: live.registration } as RecoveryMetadataRecord)
    || live.eventId !== record.eventId
    || live.envelopeHash !== record.envelopeHash) {
    throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_OWNERSHIP_DRIFT", "recovery metadata ownership changed after whole-L1 validation", { path: rel });
  }
  return {
    receipt: Object.freeze({ ...rawReceipt, owner: "canonical_path_meta", sourceIds: Object.freeze([record.eventId]) }),
    content,
  };
}

function knowledgeIdentityFromL2Path(rel: string): string {
  const prefix = `${KNOWLEDGE_L2_V1.canonicalRoot}/`;
  if (!rel.startsWith(prefix) || !rel.endsWith(".md")) throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_PATH", "unexpected knowledge L2 path", { rel });
  const parts = rel.slice(prefix.length, -3).split("/");
  if (parts.length === 2 && parts[0] === "world") return `world::${parts[1]}`;
  if (parts.length === 3 && parts[0] === "projects") return `project:${parts[1]}:${parts[2]}`;
  throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_PATH", "knowledge L2 path does not encode a canonical identity", { rel });
}

function nulPaths(buffer: Buffer): string[] {
  return buffer.toString("utf-8").split("\0").filter(Boolean);
}

async function renderLatestConstraintProjectionFromScan(
  repo: string,
  scan: WholeL1ScanResult,
): Promise<CanonicalConstraintL2ProjectionRender | null> {
  const projection = await import("../sediment/constraint-compiler/projection");
  const projections = scan.selected.filter((record) => (
    record.registration.domain === "constraint"
    && record.registration.role === "canonical"
    && record.registration.envelope_schema === projection.CONSTRAINT_PROJECTION_ENVELOPE_SCHEMA_VERSION
  ));
  const latestId = projection.selectLatestConstraintProjectionEventId(projections.map((record) => ({
    eventId: record.eventId,
    createdAtUtc: String(record.body.created_at_utc ?? ""),
  })));
  if (!latestId) return null;
  const matches = projections.filter((record) => record.eventId === latestId);
  if (matches.length !== 1) {
    throw new CanonicalGitRuntimeError("CONSTRAINT_L2_LATEST_AMBIGUOUS", "latest constraint projection event is not unique", {
      eventId: latestId,
      matches: matches.length,
    });
  }
  const latest = matches[0]!;
  const render = await import("../sediment/constraint-compiler/render");
  const decision = projection.normalizeDecisionForProjection(latest.body.validated_decision as never) as never;
  const rendered = render.renderConstraintL2View(decision, latest.eventId);
  const markdownBytes = Buffer.from(rendered.markdown, "utf-8");
  const sourceIds = Array.from(new Set([
    latest.eventId,
    ...(Array.isArray(latest.body.input_event_ids) ? latest.body.input_event_ids : []),
    ...(Array.isArray(latest.body.causal_parents) ? latest.body.causal_parents : []),
  ].filter((value): value is string => typeof value === "string"))).sort(compareAscii);
  return Object.freeze({
    repo,
    projectionEventId: latest.eventId,
    createdAtUtc: String(latest.body.created_at_utc ?? ""),
    sourceIds: Object.freeze(sourceIds),
    markdown: rendered.markdown,
    bytes: markdownBytes.length,
    bytesSha256: sha256Hex(markdownBytes),
    decisionHash: rendered.decisionHash,
  });
}

export async function renderLatestCanonicalConstraintL2Projection(options: {
  abrainHome: string;
}): Promise<CanonicalConstraintL2ProjectionRender> {
  const repo = await repoRealpath(options.abrainHome);
  const scan = await scanWholeL1Validated({ abrainHome: repo, domains: ["constraint"], roles: ["canonical"] });
  const rendered = await renderLatestConstraintProjectionFromScan(repo, scan);
  if (!rendered) throw new CanonicalGitRuntimeError("CONSTRAINT_L2_UNOWNED", "constraint L2 has no canonical projection event");
  return rendered;
}

export async function buildCanonicalOwnershipContext(options: {
  abrainHome: string;
  /** When provided, reuse a just-frozen whole-L1 scan (semantic-equivalent). */
  scan?: WholeL1ScanResult;
}): Promise<CanonicalOwnershipContext> {
  const started = Date.now();
  const repo = await repoRealpath(options.abrainHome);
  const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: repo });
  const knowledge = await import("../sediment/knowledge-evidence");
  const knowledgeNodes = scan.selected
    .filter((record) => record.registration.domain === "knowledge" && record.registration.role === "canonical")
    .map((record) => ({ eventId: record.eventId, body: record.body as any }));
  const grouped = new Map<string, any[]>();
  for (const node of knowledgeNodes) {
    const identity = knowledge.knowledgeIdentityKey(node.body);
    const set = grouped.get(identity) ?? [];
    set.push(node);
    grouped.set(identity, set);
  }
  const knowledgeByIdentity = new Map<string, { nodes: readonly any[]; rendered: any }>();
  for (const [identity, nodes] of [...grouped].sort(([left], [right]) => compareAscii(left, right))) {
    knowledgeByIdentity.set(identity, { nodes: Object.freeze(nodes.slice()), rendered: knowledge.renderKnowledgeProjectionFromSet(nodes) });
  }
  const knowledgeManifest = knowledgeNodes.length
    ? { nodes: Object.freeze(knowledgeNodes.slice()), rendered: knowledge.renderKnowledgeProjectionManifestFromSet(knowledgeNodes) }
    : undefined;

  const renderedConstraint = await renderLatestConstraintProjectionFromScan(repo, scan);
  const constraint: CanonicalOwnershipContext["_constraint"] = renderedConstraint
    ? {
      sourceIds: renderedConstraint.sourceIds,
      markdown: renderedConstraint.markdown,
      projectionEventId: renderedConstraint.projectionEventId,
    }
    : undefined;

  const [headRaw, indexRaw] = await Promise.all([
    gitBuffer(repo, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]),
    gitBuffer(repo, ["ls-files", "-z"]),
  ]);
  const headPaths = new Set(nulPaths(headRaw));
  const indexPaths = new Set(nulPaths(indexRaw));
  const instrumentation: CanonicalOwnershipInstrumentation = Object.freeze({
    wholeL1Scans: 1,
    knowledgeIdentityCount: grouped.size,
    knowledgeFoldRenders: grouped.size,
    globalManifestRenders: knowledgeManifest ? 1 : 0,
    constraintDecisionRenders: constraint ? 1 : 0,
    headMembershipQueries: 1,
    indexMembershipQueries: 1,
    elapsedMs: Date.now() - started,
  });
  return Object.freeze({
    repo,
    scan,
    headPaths,
    indexPaths,
    instrumentation,
    _knowledgeByIdentity: knowledgeByIdentity,
    ...(knowledgeManifest ? { _knowledgeManifest: knowledgeManifest } : {}),
    ...(constraint ? { _constraint: constraint } : {}),
  });
}

async function recomputeKnowledgeL2(repo: string, rel: string, bytes: Buffer | undefined, context?: CanonicalOwnershipContext): Promise<readonly string[]> {
  const identity = knowledgeIdentityFromL2Path(rel);
  const knowledge = await import("../sediment/knowledge-evidence");
  const cached = context?._knowledgeByIdentity.get(identity);
  const nodes = cached?.nodes ?? await knowledge.collectKnowledgeEventSet(repo, identity);
  if (nodes.length === 0) throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_UNOWNED", "knowledge L2 has no fold input", { rel });
  const rendered = cached?.rendered ?? knowledge.renderKnowledgeProjectionFromSet(nodes as any[]);
  if (!bytes) {
    if (rendered.kind !== "delete") throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_DELETE_UNPROVEN", "knowledge L2 delete is not the pure-fold tombstone result", { rel });
    let headBytes: Buffer;
    try {
      headBytes = await gitBuffer(repo, ["show", `HEAD:${rel}`], 5_000);
    } catch {
      throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_DELETE_UNTRACKED", "knowledge tombstone may delete only an owned projection present in HEAD", { rel });
    }
    const priorNodes = nodes.filter((node) => node.eventId !== rendered.winnerEventId);
    if (priorNodes.length === 0) throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_DELETE_NO_PRIOR_FOLD", "knowledge tombstone has no prior identity fold", { rel });
    const prior = knowledge.renderKnowledgeProjectionFromSet(priorNodes);
    if (prior.kind !== "entry" || !headBytes.equals(Buffer.from(prior.markdown!, "utf-8"))) {
      throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_DELETE_HEAD_MISMATCH", "HEAD path is not byte-equal to the prior owned identity fold", { rel });
    }
  } else {
    const markdown = bytes.toString("utf-8");
    const parser = await import("../memory/parser");
    const frontmatter = parser.parseFrontmatter(markdown);
    if (parser.scalarString(frontmatter.sediment_projection) !== "knowledge-evidence/v1") {
      throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_INVALID", "knowledge L2 frontmatter does not identify the pure projector", { rel });
    }
    if (rendered.kind !== "entry" || rendered.markdown !== markdown) {
      throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_MISMATCH", "knowledge L2 is not byte-equal to pure fold/renderer output", { rel });
    }
  }
  return Object.freeze(nodes.map((node) => node.eventId).sort(compareAscii));
}

async function recomputeKnowledgeManifest(repo: string, rel: string, bytes: Buffer, context?: CanonicalOwnershipContext): Promise<readonly string[]> {
  if (rel !== canonicalKnowledgeManifestRelativePathV1()) throw new CanonicalGitRuntimeError("KNOWLEDGE_MANIFEST_PATH", "unexpected knowledge manifest path", { rel });
  const knowledge = await import("../sediment/knowledge-evidence");
  const cached = context?._knowledgeManifest;
  const nodes = cached?.nodes ?? await knowledge.collectAllKnowledgeEventNodes(repo);
  if (nodes.length === 0) throw new CanonicalGitRuntimeError("KNOWLEDGE_MANIFEST_UNOWNED", "knowledge manifest has no complete identity fold input");
  const rendered = cached?.rendered ?? knowledge.renderKnowledgeProjectionManifestFromSet(nodes as any[]);
  const expected = Buffer.from(rendered.json, "utf-8");
  if (!bytes.equals(expected)) {
    throw new CanonicalGitRuntimeError("KNOWLEDGE_MANIFEST_MISMATCH", "knowledge manifest is not byte-equal to the complete deterministic identity-fold manifest", {
      expectedBytesSha256: sha256Hex(expected),
      actualBytesSha256: sha256Hex(bytes),
      expectedWinnerEventId: rendered.winnerEventId,
    });
  }
  return Object.freeze(nodes.map((node) => node.eventId).sort(compareAscii));
}

async function recomputeConstraintL2(repo: string, rel: string, bytes: Buffer, context?: CanonicalOwnershipContext): Promise<readonly string[]> {
  if (rel !== CONSTRAINT_L2_V1.canonicalPath) throw new CanonicalGitRuntimeError("CONSTRAINT_L2_PATH", "unexpected constraint L2 path", { rel });
  if (context?._constraint) {
    if (!bytes.equals(Buffer.from(context._constraint.markdown, "utf-8"))) {
      throw new CanonicalGitRuntimeError("CONSTRAINT_L2_MISMATCH", "constraint L2 is not byte-equal to latest projection decision", { rel, eventId: context._constraint.projectionEventId });
    }
    return context._constraint.sourceIds;
  }
  const scan = await scanWholeL1Validated({ abrainHome: repo, domains: ["constraint"], roles: ["canonical"] });
  const rendered = await renderLatestConstraintProjectionFromScan(repo, scan);
  if (!rendered) throw new CanonicalGitRuntimeError("CONSTRAINT_L2_UNOWNED", "constraint L2 has no committed-or-worktree projection decision");
  if (!bytes.equals(Buffer.from(rendered.markdown, "utf-8"))) {
    throw new CanonicalGitRuntimeError("CONSTRAINT_L2_MISMATCH", "constraint L2 is not byte-equal to latest projection decision", { rel, eventId: rendered.projectionEventId });
  }
  return Object.freeze([rendered.projectionEventId]);
}

async function validateReceipt(repo: string, receipt: ProducedArtifact, allowWriterTransaction: boolean, context?: CanonicalOwnershipContext): Promise<{ receipt: ProducedArtifact; content?: Buffer }> {
  if (!receipt || typeof receipt !== "object") throw new CanonicalGitRuntimeError("RECEIPT_INVALID", "artifact receipt must be an object");
  canonicalRelative(repo, path.join(repo, receipt.path));
  if (receipt.path === ".git" || receipt.path.startsWith(".git/") || receipt.path === ".state" || receipt.path.startsWith(".state/")) {
    throw new CanonicalGitRuntimeError("RECEIPT_PATH_BLOCKED", "git metadata and runtime cache are outside canonical transactions", { path: receipt.path });
  }
  const content = await readArtifactBytes(repo, receipt);
  let expectedOwner = receipt.owner;
  let sourceIds = receipt.sourceIds;
  if (receipt.path.startsWith("l1/events/sha256/")) {
    if (!content) throw new CanonicalGitRuntimeError("L1_DELETE_FORBIDDEN", "L1 is append-only", { path: receipt.path });
    expectedOwner = await validateL1Artifact(repo, receipt.path, content);
    sourceIds = Object.freeze([path.basename(receipt.path, ".json")]);
  } else if (receipt.path.startsWith("l2/views/knowledge/") && receipt.path.endsWith(".md")) {
    expectedOwner = "knowledge_l2";
    sourceIds = await recomputeKnowledgeL2(repo, receipt.path, content, context);
  } else if (receipt.path === canonicalKnowledgeManifestRelativePathV1()) {
    if (!content) throw new CanonicalGitRuntimeError("KNOWLEDGE_MANIFEST_DELETE_FORBIDDEN", "knowledge manifest deletion is not a projector transaction");
    expectedOwner = "knowledge_l2";
    sourceIds = await recomputeKnowledgeManifest(repo, receipt.path, content, context);
  } else if (receipt.path.startsWith("l2/views/constraint/")) {
    if (!content) throw new CanonicalGitRuntimeError("CONSTRAINT_L2_DELETE_FORBIDDEN", "constraint L2 delete is not a production transaction");
    expectedOwner = "constraint_l2";
    sourceIds = await recomputeConstraintL2(repo, receipt.path, content, context);
  } else if (!allowWriterTransaction || receipt.owner !== "writer_transaction" || receipt.sourceIds.length === 0) {
    throw new CanonicalGitRuntimeError("ARTIFACT_UNOWNED", "non-L1/L2 canonical path requires an explicit writer transaction receipt", { path: receipt.path });
  }
  if (receipt.owner !== expectedOwner && !(receipt.owner === "canonical_path_meta" && expectedOwner !== "writer_transaction")) {
    throw new CanonicalGitRuntimeError("RECEIPT_OWNER_MISMATCH", "receipt owner does not match validated artifact", { path: receipt.path, expectedOwner, actual: receipt.owner });
  }
  return { receipt: Object.freeze({ ...receipt, owner: expectedOwner, sourceIds: Object.freeze([...sourceIds].sort(compareAscii)) }), ...(content ? { content } : {}) };
}

export async function proveCanonicalArtifactOwnership(options: {
  abrainHome: string;
  filePath: string;
  op?: "put" | "delete";
  context?: CanonicalOwnershipContext;
}): Promise<ProducedArtifact> {
  const repo = options.context?.repo ?? await repoRealpath(options.abrainHome);
  if (path.resolve(options.abrainHome) !== repo) throw new CanonicalGitRuntimeError("OWNERSHIP_CONTEXT_REPO_MISMATCH", "ownership context belongs to a different repository");
  const receipt = await createProducedArtifactReceipt({ abrainHome: repo, filePath: options.filePath, op: options.op });
  return (await validateReceipt(repo, receipt, false, options.context)).receipt;
}

function quarantineReason(protocol: "v2" | "v3", items: readonly { episodeId: string; errorCode: string; message: string; detail?: string }[]): string {
  return items.map((item) => `${protocol}:${item.episodeId}:${item.errorCode}:${item.detail ?? "no-detail"}:${item.message}`).join(" | ");
}

async function classifyHistoricalRecovery(repo: string, scan: WholeL1ScanResult, head: string): Promise<CombinedRecoveryHistoryResult> {
  const history = await classifyRecoveryHistory({ repo, scan, head });
  if (history.status !== "accepted" || !history.v3) {
    const summary = history.quarantined.map((item) => `${item.protocol}:${item.episodeId}:${item.errorCode}:${item.detail ?? "no-detail"}:${item.message}`).join(" | ");
    throw new CanonicalGitRuntimeError("RECOVERY_QUARANTINED", `combined historical classification failed: ${summary}`, {
      quarantined: history.quarantined,
    });
  }
  return history;
}

function recoveryHistoryScanRoot(scan: WholeL1ScanResult): string {
  return sha256Hex(JSON.stringify(scan.all.map((record) => [
    record.relativePath ?? null,
    record.eventId,
    record.envelopeHash,
    record.classification,
    record.registration.envelope_schema,
  ])));
}

/** Multi-process harness delays. Outside-phase delays are cooperative budget units. */
function startupTestDelayMs(name: "PI_ASTACK_STARTUP_CLASSIFY_DELAY_MS" | "PI_ASTACK_STARTUP_FINAL_CLASSIFY_DELAY_MS" | "PI_ASTACK_STARTUP_MUTATION_HOLD_DELAY_MS" | "PI_ASTACK_STARTUP_FREEZE_DELAY_MS"): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 120_000);
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function retryDelayMs(baseMs: number, random: () => number): number {
  const sample = Math.min(1, Math.max(0, random()));
  return Math.max(1, Math.floor(baseMs * (0.5 + sample * 0.5)));
}

async function pruneNoops(repo: string, frozen: string, plan: readonly CohortPlanEntry[]): Promise<CohortPlanEntry[]> {
  const pruned: CohortPlanEntry[] = [];
  for (const entry of plan) {
    let headBytes: Buffer | undefined;
    let headMode: string | undefined;
    try {
      const tree = await git(repo, ["ls-tree", frozen, "--", entry.path], 5_000);
      headMode = tree.trim().split(/\s+/)[0] || undefined;
      const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", "show", `${frozen}:${entry.path}`], {
        env: sanitizedGitEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
        encoding: "buffer",
      });
      headBytes = stdout as Buffer;
    } catch {
      headBytes = undefined;
      headMode = undefined;
    }
    const bytesEqual = entry.op === "put" && headBytes?.equals(typeof entry.content === "string" ? Buffer.from(entry.content) : entry.content!);
    if (entry.op === "delete" ? headBytes === undefined : bytesEqual && headMode === (entry.mode ?? "100644")) continue;
    pruned.push(entry);
  }
  return pruned;
}

class CanonicalGitRuntimeImpl implements CanonicalGitRuntime {
  readonly repo: string;
  readonly options: Required<Pick<CanonicalGitRuntimeOptions, "refName">> & CanonicalGitRuntimeOptions;
  readonly settings: CanonicalGitRuntimeSettings;
  readonly sourceRoot: string;
  readonly loadedProvenance: readonly LoadedProvenanceEntry[];
  readonly implementationFingerprint: string;
  private startupState: CanonicalRuntimeDiagnostics["startup"] = "not_started";
  private startupGeneration = 0;
  private startupPromise?: Promise<CanonicalRuntimeDiagnostics>;
  private blockedReason?: string;
  private deferredReason?: CanonicalStartupDeferredReason;
  private startupRetryable = false;
  private ownerAlert = false;
  private frozenOwnershipContext?: { statusHash: string; context: CanonicalOwnershipContext };
  private recoveryHistoryCache?: { head: string; scanRoot: string; statusHash: string; result: CombinedRecoveryHistoryResult };
  private readonly tail: Record<string, unknown>[] = [];

  constructor(args: { repo: string; options: CanonicalGitRuntimeOptions; settings: CanonicalGitRuntimeSettings; sourceRoot: string; provenance: readonly LoadedProvenanceEntry[] }) {
    this.repo = args.repo;
    this.options = { ...args.options, refName: args.options.refName ?? "refs/heads/main" };
    this.settings = args.settings;
    this.sourceRoot = args.sourceRoot;
    this.loadedProvenance = args.provenance;
    this.implementationFingerprint = provenanceFingerprint(args.provenance);
  }

  private record(row: Record<string, unknown>): void {
    // Privacy: strip episodeId/OID/path/detail; keep domain codes + CSJ closed reasons (no free-form ids).
    const sanitized: Record<string, unknown> = { at: new Date().toISOString() };
    for (const [key, value] of Object.entries(row)) {
      if (key === "episodeId" || key === "path" || key === "candidate" || key === "head" || key === "oid" || key === "detail") continue;
      if (typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value) && key !== "statusHash" && key !== "reason") continue;
      if (key === "reason" && typeof value === "string") {
        sanitized.reason = redactDiagnosticReason(value, typeof row.code === "string" ? row.code : undefined);
        continue;
      }
      sanitized[key] = value;
    }
    this.tail.push(Object.freeze(sanitized));
    if (this.tail.length > MAX_DIAGNOSTIC_TAIL) this.tail.splice(0, this.tail.length - MAX_DIAGNOSTIC_TAIL);
  }

  private setBlockedClosed(reason: CsjClosedReason | string, opts?: { ownerAlert?: boolean; code?: string }): void {
    this.startupState = "blocked";
    // CSJ closed codes stay closed; domain codes (RECOVERY_V3_*, L1_*) preserve machine-readable text.
    this.blockedReason = redactDiagnosticReason(String(reason), opts?.code);
    if (opts?.ownerAlert) this.ownerAlert = true;
  }

  private async classifyHistoricalRecoveryCached(
    scan: WholeL1ScanResult,
    head: string,
    statusHash?: string,
  ): Promise<CombinedRecoveryHistoryResult> {
    const scanRoot = recoveryHistoryScanRoot(scan);
    const resolvedStatusHash = statusHash ?? (await statusSnapshot(this.repo)).hash;
    const cached = this.recoveryHistoryCache;
    if (
      cached?.head === head
      && cached.scanRoot === scanRoot
      && cached.statusHash === resolvedStatusHash
    ) {
      return cached.result;
    }
    const result = await classifyHistoricalRecovery(this.repo, scan, head);
    this.recoveryHistoryCache = { head, scanRoot, statusHash: resolvedStatusHash, result };
    return result;
  }

  diagnostics(): CanonicalRuntimeDiagnostics {
    return Object.freeze({
      apiVersion: API_VERSION,
      repo: this.repo,
      settings: this.settings,
      startupGeneration: this.startupGeneration,
      startup: this.startupState,
      ...(this.blockedReason ? { blockedReason: this.blockedReason } : {}),
      ...(this.deferredReason ? { deferredReason: this.deferredReason } : {}),
      ...(this.startupRetryable ? { retryable: true as const } : {}),
      ...(this.ownerAlert ? { ownerAlert: true as const } : {}),
      loadedProvenance: this.loadedProvenance,
      implementationFingerprint: this.implementationFingerprint,
      tail: Object.freeze(this.tail.slice()),
    });
  }

  private async mutationPreflight(): Promise<void> {
    if (!this.settings.valid || !this.settings.enabled || this.settings.mode !== SETTINGS_MODE) {
      throw new CanonicalGitRuntimeError("RUNTIME_DISABLED", `canonical runtime is fail-closed: ${this.settings.reason}`);
    }
    await assertProvenanceFrozen(this.sourceRoot, this.settings.settingsPath, this.loadedProvenance);
    await assertRepoMutationPreflight(this.repo, this.options.refName);
    await preflightSharedIndexLock(this.repo);
  }

  /**
   * Publish preflight. Production only runs mutation preflight (+ optional extra).
   * Under PI_ASTACK_ENABLE_TEST_HOOKS, optional one-shot env / options hook can
   * throw before CAS to exercise prepared-not-published / rollback paths.
   */
  private async prePublishCheckWithTestHook(extra?: () => Promise<void>): Promise<void> {
    await this.mutationPreflight();
    if (extra) await extra();
    if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") return;
    if (process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE === "1") {
      delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
      throw new CanonicalGitRuntimeError(
        "TEST_DRAIN_PRE_PUBLISH",
        "deterministic pre-publish fault for tests",
      );
    }
    if (typeof this.options.drainPrePublishTestHook === "function") {
      await this.options.drainPrePublishTestHook();
    }
  }

  /**
   * Index-converge preflight. Production only checks the shared index lock.
   * Under PI_ASTACK_ENABLE_TEST_HOOKS, optional one-shot env / options hook can
   * throw after CAS publish to exercise blocked+localCommit==="published".
   */
  private async preConvergeCheckWithTestHook(): Promise<void> {
    await preflightSharedIndexLock(this.repo);
    if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") return;
    if (process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE === "1") {
      delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
      throw new CanonicalGitRuntimeError(
        "TEST_DRAIN_POST_PUBLISH",
        "deterministic post-publish converge fault for tests",
      );
    }
    if (typeof this.options.drainPostPublishTestHook === "function") {
      await this.options.drainPostPublishTestHook();
    }
  }

  /**
   * After recoverDrainSlotV3 throws, decide whether CAS/publication already
   * crossed the irreversible boundary. Shared by loop-branch recovery of an
   * existing prepared episode and the final newly-prepared branch.
   */
  private async resolvePublishedPendingAfterRecoverFault(options: {
    error: unknown;
    episodeId: string;
    slot: number;
    preparedHint?: { candidate: string; cohortManifestRoot?: string };
  }): Promise<DrainResult | null> {
    let candidate = options.preparedHint?.candidate;
    let cohort = options.preparedHint?.cohortManifestRoot;
    let durablePublishedFact = false;
    try {
      const state = foldRecoveryEventsV3(await readRecoveryEventsV3(this.repo, options.episodeId)).get(options.slot);
      durablePublishedFact = !!state?.published && !state.aborted;
      const durableCandidate = typeof state?.published?.body?.candidate === "string"
        ? String(state.published.body.candidate)
        : typeof state?.prepared?.body?.candidate === "string"
          ? String(state.prepared.body.candidate)
          : undefined;
      if (!candidate && durableCandidate) candidate = durableCandidate;
      if (!cohort && typeof state?.prepared?.operation?.cohort_semantic_root === "string") {
        cohort = state.prepared.operation.cohort_semantic_root;
      }
    } catch {
      // Candidate ancestry remains an independent irreversible publication
      // fact even when recovery metadata itself is quarantined.
    }
    if (!candidate) return null;
    const current = await resolveRef(this.repo, this.options.refName);
    const refPublished = await gitIsAncestor(this.repo, candidate, current);
    if (!refPublished && !durablePublishedFact) return null;
    const reason = options.error instanceof Error ? options.error.message : String(options.error);
    this.record({
      operation: "drain_v3",
      episodeId: options.episodeId,
      slot: options.slot,
      action: "published_pending",
      candidate,
      ...(cohort ? { cohort } : {}),
      reason,
    });
    return {
      status: "blocked",
      commit: candidate,
      episodeId: options.episodeId,
      slot: options.slot,
      localCommit: "published",
      reason,
    };
  }

  /**
   * recoverDrainSlotV3 wrapper used by both the existing-episode loop branch
   * and the final newly-prepared branch. Post-CAS faults map to
   * blocked+localCommit==="published"; true pre-publish faults rethrow.
   */
  private async recoverDrainSlotPublicationAware(options: {
    operation: Parameters<typeof recoverDrainSlotV3>[0]["operation"];
    slot: number;
    episodeId: string;
    prePublishCheck: () => Promise<void>;
    preparedHint?: { candidate: string; cohortManifestRoot?: string };
  }): Promise<
    | { kind: "action"; action: Awaited<ReturnType<typeof recoverDrainSlotV3>> }
    | { kind: "published_pending"; result: DrainResult }
  > {
    try {
      const action = await recoverDrainSlotV3({
        abrainHome: this.repo,
        repo: this.repo,
        operation: options.operation,
        slot: options.slot,
        prePublishCheck: options.prePublishCheck,
        preConvergeCheck: () => this.preConvergeCheckWithTestHook(),
      });
      return { kind: "action", action };
    } catch (error) {
      const published = await this.resolvePublishedPendingAfterRecoverFault({
        error,
        episodeId: options.episodeId,
        slot: options.slot,
        preparedHint: options.preparedHint,
      });
      if (published) return { kind: "published_pending", result: published };
      throw error;
    }
  }

  /**
   * One startup key owns one promise and one retry timer. The phase machine is:
   * outside freeze/classify -> bootstrap mutation -> outside recovery classify
   * -> recovery/backlog mutation -> outside final classify -> stable ready publish.
   * Every barrier entry validates the exact tuple produced by the preceding
   * outside phase. Drift restarts independently from CANONICAL_MUTATION_BUSY.
   */
  awaitStartup(): Promise<CanonicalRuntimeDiagnostics> {
    if (!this.startupPromise) {
      this.startupGeneration += 1;
      const created = this.runStartupOutsideMutationBarrier();
      this.startupPromise = created;
      void created.then(
        (diag) => {
          if ((diag.startup === "blocked" || diag.startup === "deferred") && this.startupPromise === created) {
            this.startupPromise = undefined;
            if (this.startupState === diag.startup) {
              this.startupState = "not_started";
              this.blockedReason = undefined;
              this.deferredReason = undefined;
              this.startupRetryable = false;
              this.ownerAlert = false;
            }
          }
        },
        () => {
          if (this.startupPromise === created) this.startupPromise = undefined;
        },
      );
    }
    return this.startupPromise;
  }

  /**
   * Allow the next awaitStartup() to begin a new generation after a settled
   * ready (or non-running) attempt. Used by kick fresh-after-ready only.
   * No-op while startup is mid-flight so concurrent in-flight coalescing wins.
   */
  forceNextStartupAttempt(): void {
    if (this.startupState === "running") return;
    this.startupPromise = undefined;
  }

  /**
   * Whole-L1 scan with optional non-authoritative OFD scan mutex.
   * Never waits for the scan lock inside the mutation barrier (no lock-order
   * deadlock with the abrainHome mutation OFD). Outside the barrier, BUSY is a
   * typed deferred signal for startup.
   */
  private async scanWholeL1ForStartup(opts?: {
    checkpoint?: () => void | Promise<void>;
    /** When true (outside phases), nonblocking scan mutex is required. */
    requireScanMutex?: boolean;
  }): Promise<WholeL1ScanResult> {
    const underBarrier = canonicalMutationBarrierHeld(this.repo);
    // Canonical startup is the sole production opt-in for the progressive validated cache.
    const scanOptions = {
      abrainHome: this.repo,
      useValidatedCache: true as const,
      ...(opts?.checkpoint ? { checkpoint: opts.checkpoint } : {}),
    };
    if (underBarrier || !opts?.requireScanMutex) {
      // Barrier-held paths never block on the scan mutex.
      return scanWholeL1Validated(scanOptions);
    }
    let lock: ReturnType<typeof tryAcquireL1ScanMutex>;
    try {
      lock = tryAcquireL1ScanMutex(this.repo);
    } catch (error) {
      // Infrastructure failure (state path unsafe, etc.) — typed fail-closed,
      // never remapped into STARTUP_CLASSIFY_INPUT_DRIFT four-round giant scans.
      throw new CanonicalGitRuntimeError(
        "CANONICAL_SCAN_LOCK_FAILED",
        "failed to acquire the non-authoritative whole-L1 scan mutex",
        { repo: this.repo, reason: error instanceof Error ? error.message : String(error) },
      );
    }
    if (lock.status === "BUSY") {
      throw new CanonicalGitRuntimeError(
        "CANONICAL_SCAN_BUSY",
        "another process holds the non-authoritative whole-L1 scan mutex",
        { repo: this.repo },
      );
    }
    try {
      return await scanWholeL1Validated(scanOptions);
    } finally {
      lock.close();
    }
  }

  private async freezeStartupClassificationInputs(opts?: {
    /** Outside-phase only. Never pass a budget checkpoint into barrier mutations. */
    checkpoint?: () => void | Promise<void>;
    requireScanMutex?: boolean;
  }): Promise<FrozenStartupClassificationInputs> {
    const headBefore = await resolveRef(this.repo, this.options.refName);
    // Cooperative scan deadline lives at per-dir/per-file boundaries inside
    // scanWholeL1Validated. Mutation-path freezes omit checkpoint so barrier
    // work is never aborted mid-flight by STARTUP_BUDGET_EXHAUSTED.
    const scan = await this.scanWholeL1ForStartup({
      checkpoint: opts?.checkpoint,
      requireScanMutex: opts?.requireScanMutex === true,
    });
    const scanRoot = recoveryHistoryScanRoot(scan);
    const statusHash = (await statusSnapshot(this.repo)).hash;
    const headAfter = await resolveRef(this.repo, this.options.refName);
    if (headBefore !== headAfter) {
      throw new CanonicalGitRuntimeError(
        "STARTUP_CLASSIFY_INPUT_DRIFT",
        "HEAD drifted during freeze of outside immutable classification inputs",
        { headBefore, headAfter, scanRoot, statusHash },
      );
    }
    return {
      head: headAfter,
      scan,
      scanRoot,
      statusHash,
      inventoryFingerprint: scan.inventoryFingerprint,
    };
  }

  private async assertStartupClassificationInputsStable(
    frozen: Pick<FrozenStartupClassificationInputs, "head" | "statusHash" | "inventoryFingerprint">,
  ): Promise<void> {
    // Minimal stable proof: re-resolve HEAD + statusHash and re-list L1 file
    // identities. Do not blind-reuse the frozen scan object and do not perform a
    // second full materializing validation when identities still match.
    const currentHead = await resolveRef(this.repo, this.options.refName);
    const currentStatusHash = (await statusSnapshot(this.repo)).hash;
    const currentInventory = await computeL1InventoryFingerprint({ abrainHome: this.repo });
    if (
      currentHead !== frozen.head
      || currentStatusHash !== frozen.statusHash
      || currentInventory !== frozen.inventoryFingerprint
    ) {
      throw new CanonicalGitRuntimeError("STARTUP_CLASSIFY_INPUT_DRIFT", "HEAD/status/L1-inventory drifted after outside immutable classification", {
        frozenHead: frozen.head,
        currentHead,
        frozenStatusHash: frozen.statusHash,
        currentStatusHash,
        frozenInventoryFingerprint: frozen.inventoryFingerprint,
        currentInventoryFingerprint: currentInventory,
      });
    }
  }

  /**
   * Fail-closed last-known-ready gate. Only skips a cold attempt when the
   * durable fingerprint exists and HEAD + statusHash + L1 inventory +
   * implementation/validator/registry fingerprints all match, no device-join
   * journal is present, and cold-grade read-only preflight succeeds. Any
   * missing/corrupt/drift/unstable path returns false (start cold). Never
   * fail-open. Does **not** take the scan mutex (lock-order safety).
   */
  private async tryLastKnownReadyGate(): Promise<{
    matched: boolean;
    reason: string;
    head?: string;
    statusHash?: string;
    inventoryFingerprint?: string;
  }> {
    const previous = await readLastKnownReadyFingerprint(this.repo);
    if (!previous) return { matched: false, reason: "missing" };
    if (await deviceJoinJournalPresent(this.repo)) {
      return { matched: false, reason: "device_join_journal_present" };
    }

    // Same-class read-only safety as cold mutation preflight, but without taking
    // the scan mutex or mutation barrier. Detached HEAD / bisect / index.lock /
    // implementation drift must force cold, never skip.
    try {
      await assertProvenanceFrozen(this.sourceRoot, this.settings.settingsPath, this.loadedProvenance);
      await assertRepoMutationPreflight(this.repo, this.options.refName);
      await preflightSharedIndexLock(this.repo);
    } catch (error) {
      return {
        matched: false,
        reason: `preflight_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let head: string;
    let statusHash: string;
    let inventoryFingerprint: string;
    let dirtyRows: number;
    let registryHash: string;
    try {
      const headBefore = await resolveRef(this.repo, this.options.refName);
      const statusBefore = await statusSnapshot(this.repo);
      dirtyRows = statusBefore.rows.length;
      // Dirty worktree (including deferred recovery metadata tails) must still
      // enter the cold phase machine so backlog/recovery diagnostics remain
      // reachable. Last-known-ready only accelerates the clean idle case.
      if (dirtyRows > 0) {
        return {
          matched: false,
          reason: "dirty_status_requires_cold",
          head: headBefore,
          statusHash: statusBefore.hash,
        };
      }
      // Inventory is wrapped by head/status before+after snapshots. Any movement
      // during the probe is treated as unstable → cold.
      inventoryFingerprint = await computeL1InventoryFingerprint({ abrainHome: this.repo });
      const headAfter = await resolveRef(this.repo, this.options.refName);
      const statusAfter = await statusSnapshot(this.repo);
      if (headBefore !== headAfter || statusBefore.hash !== statusAfter.hash || statusAfter.rows.length > 0) {
        return {
          matched: false,
          reason: "probe_unstable",
          head: headAfter,
          statusHash: statusAfter.hash,
          inventoryFingerprint,
        };
      }
      head = headAfter;
      statusHash = statusAfter.hash;
      registryHash = registryContentHash(loadL1SchemaRegistry());
    } catch (error) {
      return {
        matched: false,
        reason: `probe_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (
      head !== previous.head
      || statusHash !== previous.statusHash
      || inventoryFingerprint !== previous.inventoryFingerprint
      || this.implementationFingerprint !== previous.implementationFingerprint
      || previous.validatorFingerprint !== L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT
      || registryHash !== previous.registryHash
    ) {
      return {
        matched: false,
        reason: "drift",
        head,
        statusHash,
        inventoryFingerprint,
      };
    }
    return {
      matched: true,
      reason: "matched",
      head,
      statusHash,
      inventoryFingerprint,
    };
  }

  private async startupTestDelay(
    phase: CanonicalStartupPhase,
    delayMs: number,
    markerEnv: string,
  ): Promise<void> {
    if (delayMs <= 0) return;
    const marker = process.env[markerEnv];
    if (marker) await fsp.writeFile(path.resolve(marker), `${phase} ${Date.now()}\n`);
    this.record({ operation: "startup_phase", phase, status: "test_delay", delayMs });
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private async classifyStartupHistoryOutsideBarrier(
    frozen: FrozenStartupClassificationInputs,
    phase: "classify_initial" | "classify_recovery" | "classify_final",
  ): Promise<CombinedRecoveryHistoryResult> {
    const delayMs = phase === "classify_initial"
      ? startupTestDelayMs("PI_ASTACK_STARTUP_CLASSIFY_DELAY_MS")
      : phase === "classify_final"
        ? startupTestDelayMs("PI_ASTACK_STARTUP_FINAL_CLASSIFY_DELAY_MS")
        : 0;
    await this.startupTestDelay(phase, delayMs, `PI_ASTACK_STARTUP_${phase === "classify_final" ? "FINAL_CLASSIFY" : "CLASSIFY"}_MARKER`);
    return this.classifyHistoricalRecoveryCached(frozen.scan, frozen.head, frozen.statusHash);
  }

  private runStartupBarrier<T>(
    busyDeadline: number,
    now: () => number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const configuredTimeout = Math.max(0, this.options.startupBarrierTimeoutMs ?? DEFAULT_STARTUP_BARRIER_TIMEOUT_MS);
    const remainingBudget = Math.max(0, busyDeadline - now());
    return gitSingleFlightWithDeadline(
      this.repo,
      () => withCanonicalMutationBarrierInSingleFlight(this.repo, operation, {
        timeoutMs: Math.min(configuredTimeout, remainingBudget),
        deadlineMs: busyDeadline,
        now,
      }),
      {
        deadlineMs: busyDeadline,
        now,
        onExpired: (detail) => new CanonicalMutationBarrierError(
          "CANONICAL_MUTATION_BUSY",
          "timed out waiting for the process-local canonical mutation turn",
          { ...detail },
        ),
      },
    );
  }

  private assertStartupBudgetAvailable(busyDeadline: number, now: () => number, phase: string): void {
    if (now() < busyDeadline) return;
    throw new CanonicalGitRuntimeError(
      "STARTUP_BUDGET_EXHAUSTED",
      "canonical startup monotonic budget exhausted at a cooperative cutpoint",
      { repo: this.repo, phase, deadlineMs: busyDeadline, nowMs: now() },
    );
  }

  private async runStartupPhases(
    driftAttempt: number,
    busyRetry: number,
    busyDeadline: number,
    now: () => number,
  ): Promise<CanonicalRuntimeDiagnostics> {
    // Cooperative cutpoint before any outside work. Pure outside-phase budget
    // exhaustion reports STARTUP_BUDGET_EXHAUSTED; if this attempt already had
    // barrier contention retries, the outer catch remaps the final cutpoint
    // exhaustion to CANONICAL_MUTATION_BUSY to keep busy root-cause semantics.
    this.assertStartupBudgetAvailable(busyDeadline, now, "startup_phase_entry");
    const outsideScanCheckpoint = () => this.assertStartupBudgetAvailable(busyDeadline, now, "scan_whole_l1");
    let initialFrozen: FrozenStartupClassificationInputs | undefined;
    let freezeError: unknown;
    this.record({ operation: "startup_phase", phase: "freeze_initial", status: "enter", driftAttempt, busyRetry });
    try {
      await this.startupTestDelay(
        "freeze_initial",
        startupTestDelayMs("PI_ASTACK_STARTUP_FREEZE_DELAY_MS"),
        "PI_ASTACK_STARTUP_FREEZE_MARKER",
      );
      // Read-only whole-L1 scan is cooperative: budget checkpoints sink into
      // per-directory / per-file boundaries so a multi-minute scan cannot
      // silently overrun startupBusyBudgetMs by a full scan unit.
      // Outside phases take the non-authoritative scan mutex; barrier freezes do not.
      initialFrozen = await this.freezeStartupClassificationInputs({
        checkpoint: outsideScanCheckpoint,
        requireScanMutex: true,
      });
    } catch (error) {
      // Budget exhaustion / scan-mutex busy during cooperative scan must surface
      // as deferred, not as a freeze failure that retries under the mutation barrier.
      if (
        error instanceof CanonicalGitRuntimeError
        && (
          error.code === "STARTUP_BUDGET_EXHAUSTED"
          || error.code === "CANONICAL_SCAN_BUSY"
          || error.code === "CANONICAL_SCAN_LOCK_FAILED"
        )
      ) throw error;
      freezeError = error;
      this.record({
        operation: "startup_phase",
        phase: "freeze_initial",
        status: "failed",
        driftAttempt,
        busyRetry,
        reason: error instanceof Error ? error.message : String(error),
        ...(error instanceof CanonicalGitRuntimeError ? { code: error.code, detail: error.detail } : {}),
      });
    }
    // Safe cutpoint after outside freeze/scan (scan itself already checkpointed).
    this.assertStartupBudgetAvailable(busyDeadline, now, "after_freeze_initial");

    let initialClassification: CombinedRecoveryHistoryResult | undefined;
    let initialClassificationError: unknown;
    if (initialFrozen) {
      try {
        this.assertStartupBudgetAvailable(busyDeadline, now, "before_classify_initial");
        initialClassification = await this.classifyStartupHistoryOutsideBarrier(initialFrozen, "classify_initial");
        this.record({ operation: "startup_phase", phase: "classify_initial", status: "outside_barrier_ok", driftAttempt, busyRetry, head: initialFrozen.head, scanRoot: initialFrozen.scanRoot, statusHash: initialFrozen.statusHash });
      } catch (error) {
        if (error instanceof CanonicalGitRuntimeError && error.code === "STARTUP_BUDGET_EXHAUSTED") throw error;
        initialClassificationError = error;
        this.record({ operation: "startup_phase", phase: "classify_initial", status: "outside_barrier_failed", driftAttempt, busyRetry, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    this.assertStartupBudgetAvailable(busyDeadline, now, "after_classify_initial");

    const recoveryFrozen = await this.runStartupBarrier(busyDeadline, now, async () => {
      this.record({ operation: "startup_phase", phase: "bootstrap_mutation", status: "barrier_acquired", driftAttempt, busyRetry });
      if (freezeError) {
        if (freezeError instanceof CanonicalGitRuntimeError && freezeError.code === "STARTUP_CLASSIFY_INPUT_DRIFT") {
          this.recoveryHistoryCache = undefined;
          throw freezeError;
        }
        let refrozen: FrozenStartupClassificationInputs;
        try {
          refrozen = await this.freezeStartupClassificationInputs();
        } catch (inner) {
          if (inner instanceof CanonicalGitRuntimeError && inner.code === "STARTUP_CLASSIFY_INPUT_DRIFT") {
            this.recoveryHistoryCache = undefined;
            throw inner;
          }
          throw freezeError;
        }
        this.recoveryHistoryCache = undefined;
        throw new CanonicalGitRuntimeError(
          "STARTUP_CLASSIFY_INPUT_DRIFT",
          "freeze/scan failed outside barrier but inputs stabilised under barrier; retrying",
          { prior: freezeError instanceof Error ? freezeError.message : String(freezeError), head: refrozen.head },
        );
      }
      await this.assertStartupClassificationInputsStable(initialFrozen!);
      if (initialClassificationError) throw initialClassificationError;
      if (!initialClassification) throw new CanonicalGitRuntimeError("STARTUP_CLASSIFICATION_MISSING", "initial startup classification produced no result");
      await recoverDeviceJoinJournal({ repo: this.repo });
      const frozen = await this.freezeStartupClassificationInputs();
      this.record({ operation: "startup_phase", phase: "bootstrap_mutation", status: "tuple_frozen", driftAttempt, busyRetry, head: frozen.head, scanRoot: frozen.scanRoot, statusHash: frozen.statusHash });
      return frozen;
    });

    // Safe cutpoint after bootstrap mutation returns; never interrupt mid-barrier.
    this.assertStartupBudgetAvailable(busyDeadline, now, "after_bootstrap_mutation");

    let recoveryClassification: CombinedRecoveryHistoryResult | undefined;
    let recoveryClassificationError: unknown;
    try {
      this.assertStartupBudgetAvailable(busyDeadline, now, "before_classify_recovery");
      recoveryClassification = await this.classifyStartupHistoryOutsideBarrier(recoveryFrozen, "classify_recovery");
      this.record({ operation: "startup_phase", phase: "classify_recovery", status: "outside_barrier_ok", driftAttempt, busyRetry, head: recoveryFrozen.head, scanRoot: recoveryFrozen.scanRoot, statusHash: recoveryFrozen.statusHash });
    } catch (error) {
      if (error instanceof CanonicalGitRuntimeError && error.code === "STARTUP_BUDGET_EXHAUSTED") throw error;
      recoveryClassificationError = error;
      this.record({ operation: "startup_phase", phase: "classify_recovery", status: "outside_barrier_failed", driftAttempt, busyRetry, reason: error instanceof Error ? error.message : String(error) });
    }
    this.assertStartupBudgetAvailable(busyDeadline, now, "after_classify_recovery");

    const finalFrozen = await this.runStartupBarrier(busyDeadline, now, async () => {
      this.record({ operation: "startup_phase", phase: "recovery_mutation", status: "barrier_acquired", driftAttempt, busyRetry });
      await this.assertStartupClassificationInputsStable(recoveryFrozen);
      if (recoveryClassificationError) throw recoveryClassificationError;
      if (!recoveryClassification) throw new CanonicalGitRuntimeError("STARTUP_CLASSIFICATION_MISSING", "recovery startup classification produced no result");

      await this.mutationPreflight();
      await this.recoverMetadataCheckpointIndexUnlocked(recoveryFrozen);
      await this.recoverStartupEpisodesUnlocked(recoveryFrozen.scan, recoveryClassification);
      const backlog = await this.requestBacklogPreflightUnlocked(recoveryFrozen);
      if (backlog.status === "ready") {
        if (isCanonicalMetadataOnlyCohort(backlog.receipts)) {
          this.record({ operation: "startup_backlog", status: "metadata_deferred", receiptCount: backlog.receipts.length });
        } else {
          if (!backlog.receipts.some((receipt) => isCanonicalContentOwner(receipt.owner))) {
            throw new CanonicalGitRuntimeError("STARTUP_CONTENT_AUTHORIZATION_REQUIRED", "startup generation requires validated Knowledge/Constraint L1/L2 content");
          }
          const drained = await this.requestDrainUnlocked(backlog.receipts, "startup-local-drain", "startup_content_backlog");
          if (!["index_converged", "empty", "metadata_deferred", "consumed"].includes(drained.status)) {
            throw new CanonicalGitRuntimeError("STARTUP_DRAIN_NOT_DURABLE", `startup local drain ended in ${drained.status}: ${drained.reason ?? "no reason"}`, { drained });
          }
        }
      } else if (backlog.status === "blocked") {
        throw new CanonicalGitRuntimeError("STARTUP_BACKLOG_BLOCKED", backlog.reason ?? "backlog preflight blocked");
      }

      if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS === "1") {
        await this.startupTestDelay(
          "recovery_mutation",
          startupTestDelayMs("PI_ASTACK_STARTUP_MUTATION_HOLD_DELAY_MS"),
          "PI_ASTACK_STARTUP_MUTATION_HOLD_MARKER",
        );
      }
      const frozen = await this.freezeStartupClassificationInputs();
      this.record({ operation: "startup_phase", phase: "recovery_mutation", status: "final_tuple_frozen", driftAttempt, busyRetry, head: frozen.head, scanRoot: frozen.scanRoot, statusHash: frozen.statusHash });
      return frozen;
    });

    // Safe cutpoint after recovery/backlog mutation returns.
    this.assertStartupBudgetAvailable(busyDeadline, now, "after_recovery_mutation");

    let finalClassificationError: unknown;
    try {
      this.assertStartupBudgetAvailable(busyDeadline, now, "before_classify_final");
      await this.classifyStartupHistoryOutsideBarrier(finalFrozen, "classify_final");
      this.record({ operation: "startup_phase", phase: "classify_final", status: "outside_barrier_ok", driftAttempt, busyRetry, head: finalFrozen.head, scanRoot: finalFrozen.scanRoot, statusHash: finalFrozen.statusHash });
    } catch (error) {
      if (error instanceof CanonicalGitRuntimeError && error.code === "STARTUP_BUDGET_EXHAUSTED") throw error;
      finalClassificationError = error;
      this.record({ operation: "startup_phase", phase: "classify_final", status: "outside_barrier_failed", driftAttempt, busyRetry, reason: error instanceof Error ? error.message : String(error) });
    }
    this.assertStartupBudgetAvailable(busyDeadline, now, "after_classify_final");

    return this.runStartupBarrier(busyDeadline, now, async () => {
      this.record({ operation: "startup_phase", phase: "publish_ready", status: "barrier_acquired", driftAttempt, busyRetry });
      await this.assertStartupClassificationInputsStable(finalFrozen);
      if (finalClassificationError) throw finalClassificationError;
      const finalRecovery = recoverOpenRecoveryEpisodesV3FromScan(finalFrozen.scan);
      if (finalRecovery.quarantined.length) {
        throw new CanonicalGitRuntimeError(
          "RECOVERY_QUARANTINED",
          `active v3 recovery classification failed: ${quarantineReason("v3", finalRecovery.quarantined)}`,
          { protocol: "v3", quarantined: finalRecovery.quarantined },
        );
      }
      if (finalRecovery.open.length) {
        throw new CanonicalGitRuntimeError(
          "STARTUP_FINAL_RECOVERY_OPEN",
          "stable final startup tuple still contains open recovery episodes",
          { episodeIds: finalRecovery.open.map((item) => item.episodeId) },
        );
      }
      this.startupState = "ready";
      // Clear blocked-memo on ready (orthogonal to ready fingerprint / attestation).
      await clearCanonicalBlockedMemo(this.repo).catch(() => undefined);
      this.record({ operation: "startup_phase", phase: "publish_ready", status: "tuple_stable", driftAttempt, busyRetry });
      this.record({ operation: "startup", status: "local_ready", attempt: driftAttempt, busyRetry });
      // Persist fail-closed last-known-ready fingerprint for future session_start
      // cold-skip. Only clean worktrees are eligible; deferred metadata tails must
      // keep entering the cold phase machine. Non-authoritative; write failures
      // are diagnostic-only.
      try {
        const publishStatus = await statusSnapshot(this.repo);
        if (publishStatus.rows.length === 0 && publishStatus.hash === finalFrozen.statusHash) {
          await writeLastKnownReadyFingerprint(this.repo, {
            head: finalFrozen.head,
            statusHash: finalFrozen.statusHash,
            inventoryFingerprint: finalFrozen.inventoryFingerprint,
            implementationFingerprint: this.implementationFingerprint,
            validatorFingerprint: L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT,
            registryHash: registryContentHash(loadL1SchemaRegistry()),
          });
          this.record({
            operation: "startup_phase",
            phase: "publish_ready",
            status: "last_known_ready_written",
            head: finalFrozen.head,
            statusHash: finalFrozen.statusHash,
            inventoryFingerprint: finalFrozen.inventoryFingerprint,
            implementationFingerprint: this.implementationFingerprint,
            validatorFingerprint: L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT,
          });
        } else {
          this.record({
            operation: "startup_phase",
            phase: "publish_ready",
            status: "last_known_ready_skipped_dirty",
            dirtyRows: publishStatus.rows.length,
            statusHash: publishStatus.hash,
            frozenStatusHash: finalFrozen.statusHash,
          });
        }
      } catch (error) {
        this.record({
          operation: "startup_phase",
          phase: "publish_ready",
          status: "last_known_ready_write_failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return this.diagnostics();
    });
  }

  private async runStartupOutsideMutationBarrier(): Promise<CanonicalRuntimeDiagnostics> {
    if (!this.settings.enabled || !this.settings.valid) {
      this.startupState = "ready";
      this.record({ operation: "startup", status: "legacy_boundary", reason: this.settings.reason });
      return this.diagnostics();
    }

    this.startupState = "running";
    this.blockedReason = undefined;
    this.deferredReason = undefined;
    this.startupRetryable = false;
    this.ownerAlert = false;

    // Fail-closed last-known-ready gate: only skip cold attempt when durable
    // fingerprint matches live HEAD + statusHash + L1 inventory and no journal.
    // Consumer continuation/reporter still run against the resulting ready diag.
    const readyGate = await this.tryLastKnownReadyGate();
    this.record({
      operation: "startup_phase",
      phase: "last_known_ready_gate",
      status: readyGate.matched ? "skip_cold" : "cold_required",
      reason: readyGate.reason,
      ...(readyGate.head ? { head: readyGate.head } : {}),
      ...(readyGate.statusHash ? { statusHash: readyGate.statusHash } : {}),
      ...(readyGate.inventoryFingerprint ? { inventoryFingerprint: readyGate.inventoryFingerprint } : {}),
    });
    if (readyGate.matched) {
      this.startupState = "ready";
      this.record({ operation: "startup", status: "local_ready", attempt: 0, busyRetry: 0, via: "last_known_ready" });
      return this.diagnostics();
    }

    const maxDriftAttempts = 4;
    const now = this.options.startupMonotonicNow ?? monotonicNowMs;
    const sleep = this.options.startupRetrySleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const random = this.options.startupRetryRandom ?? Math.random;
    // H2: under daemon worker budget ALS, clamp cold-start busy budget to the
    // remaining soft deadline (never inherit the 60m default into a short-lived
    // worker task). Outside ALS, configured/default budgets are unchanged.
    // Cooperative deferred on exhaustion — does not hard-kill in-flight mutation.
    const configuredBusyBudgetMs = Math.max(0, this.options.startupBusyBudgetMs ?? DEFAULT_STARTUP_BUSY_BUDGET_MS);
    const workerBudget = getWorkerBudgetContext();
    const clockForBudget = workerBudget?.now ?? now;
    const busyBudgetMs = clampStartupBudgetToWorker(configuredBusyBudgetMs, clockForBudget());
    const busyInitialBackoffMs = Math.max(1, this.options.startupBusyInitialBackoffMs ?? DEFAULT_STARTUP_BUSY_INITIAL_BACKOFF_MS);
    const busyMaxBackoffMs = Math.max(busyInitialBackoffMs, this.options.startupBusyMaxBackoffMs ?? DEFAULT_STARTUP_BUSY_MAX_BACKOFF_MS);
    const busyStarted = now();
    // When worker remaining is 0, deadline == started → first cutpoint defers.
    const busyDeadline = busyStarted + busyBudgetMs;
    let driftAttempt = 0;
    let busyRetry = 0;

    for (;;) {
      try {
        return await this.runStartupPhases(driftAttempt, busyRetry, busyDeadline, now);
      } catch (error) {
        if (error instanceof CanonicalGitRuntimeError && error.code === "STARTUP_BUDGET_EXHAUSTED") {
          const current = now();
          const elapsedMs = Math.max(0, current - busyStarted);
          // Root-cause stability: after barrier contention retries, the total
          // deadline can land on a later outside freeze/scan/classify cutpoint.
          // Preserve CANONICAL_MUTATION_BUSY so busy diagnostics/retry semantics
          // do not flip to STARTUP_BUDGET_EXHAUSTED at the final cutpoint.
          // Pure outside-phase exhaustion (busyRetry === 0) stays budget-exhausted.
          const deferredCode: CanonicalStartupDeferredReason = busyRetry > 0
            ? "CANONICAL_MUTATION_BUSY"
            : "STARTUP_BUDGET_EXHAUSTED";
          this.startupState = "deferred";
          this.deferredReason = deferredCode;
          this.startupRetryable = true;
          this.blockedReason = deferredCode === "CANONICAL_MUTATION_BUSY"
            ? `CANONICAL_MUTATION_BUSY: startup deferred after ${Math.floor(elapsedMs)}ms busy budget; retry requires an external lifecycle trigger`
            : `STARTUP_BUDGET_EXHAUSTED: startup deferred after ${Math.floor(elapsedMs)}ms total budget; retry requires an external lifecycle trigger`;
          this.record({
            operation: "startup",
            status: "deferred",
            code: deferredCode,
            retryable: true,
            retryTrigger: "external_lifecycle",
            busyRetry,
            elapsedMs: Math.floor(elapsedMs),
            budgetMs: busyBudgetMs,
            detail: error.detail,
          });
          return this.diagnostics();
        }

        if (error instanceof CanonicalGitRuntimeError && error.code === "CANONICAL_SCAN_BUSY") {
          // Non-authoritative scan mutex contention: typed deferred, promise is
          // evicted by the outer singleflight so an external lifecycle can retry.
          this.startupState = "deferred";
          this.deferredReason = "CANONICAL_SCAN_BUSY";
          this.startupRetryable = true;
          this.blockedReason = "CANONICAL_SCAN_BUSY: whole-L1 scan mutex held by another process; retry requires an external lifecycle trigger";
          this.record({
            operation: "startup",
            status: "deferred",
            code: "CANONICAL_SCAN_BUSY",
            retryable: true,
            retryTrigger: "external_lifecycle",
            busyRetry,
            detail: error.detail,
          });
          return this.diagnostics();
        }

        if (error instanceof CanonicalGitRuntimeError && error.code === "CANONICAL_SCAN_LOCK_FAILED") {
          // Scan-lock infrastructure failure is fail-closed and must not be
          // remapped into STARTUP_CLASSIFY_INPUT_DRIFT four-round giant scans.
          this.startupState = "deferred";
          this.deferredReason = "CANONICAL_SCAN_LOCK_FAILED";
          this.startupRetryable = true;
          this.blockedReason = "CANONICAL_SCAN_LOCK_FAILED: whole-L1 scan mutex infrastructure failed; retry requires an external lifecycle trigger";
          this.record({
            operation: "startup",
            status: "deferred",
            code: "CANONICAL_SCAN_LOCK_FAILED",
            retryable: true,
            retryTrigger: "external_lifecycle",
            busyRetry,
            detail: error.detail,
          });
          return this.diagnostics();
        }

        if (error instanceof CanonicalMutationBarrierError && error.code === "CANONICAL_MUTATION_BUSY") {
          const current = now();
          const remainingMs = Math.max(0, busyDeadline - current);
          if (remainingMs <= 0) {
            const elapsedMs = Math.max(0, current - busyStarted);
            this.startupState = "deferred";
            this.deferredReason = "CANONICAL_MUTATION_BUSY";
            this.startupRetryable = true;
            this.blockedReason = `CANONICAL_MUTATION_BUSY: startup deferred after ${Math.floor(elapsedMs)}ms busy budget; retry requires an external lifecycle trigger`;
            this.record({
              operation: "startup",
              status: "deferred",
              code: "CANONICAL_MUTATION_BUSY",
              retryable: true,
              retryTrigger: "external_lifecycle",
              busyRetry,
              elapsedMs: Math.floor(elapsedMs),
              budgetMs: busyBudgetMs,
              detail: error.detail,
            });
            return this.diagnostics();
          }
          const exponent = Math.min(30, busyRetry);
          const baseMs = Math.min(busyMaxBackoffMs, busyInitialBackoffMs * (2 ** exponent));
          const delayMs = Math.min(Math.floor(remainingMs), retryDelayMs(baseMs, random));
          this.record({ operation: "startup", status: "canonical_mutation_busy_retry", busyRetry, driftAttempt, delayMs, remainingMs: Math.floor(remainingMs), detail: error.detail });
          busyRetry += 1;
          await sleep(delayMs);
          continue;
        }

        if (error instanceof CanonicalGitRuntimeError && error.code === "STARTUP_CLASSIFY_INPUT_DRIFT") {
          this.recoveryHistoryCache = undefined;
          if (driftAttempt < maxDriftAttempts - 1) {
            this.record({ operation: "startup", status: "classify_input_drift_retry", attempt: driftAttempt, busyRetry, reason: error.message, detail: error.detail });
            driftAttempt += 1;
            continue;
          }
          this.startupState = "blocked";
          this.blockedReason = error.message;
          this.record({ operation: "startup", status: "blocked", reason: this.blockedReason, attempt: driftAttempt, busyRetry, drift_exhausted: true });
          return this.diagnostics();
        }

        if (isTypedStartupDomainError(error)) {
          // Outer catch must not clobber ownerAlert already set true (W2'/NextKick).
          // Do NOT collapse every owner_alert=true message into t2_budget_exhausted
          // (terminal content also carries owner_alert=true).
          const detailOwnerAlert = !!(error.detail && typeof error.detail === "object" && (error.detail as { owner_alert?: unknown }).owner_alert === true);
          const isT2BudgetExhausted = error.code === "RECOVERY_V3_LIVENESS"
            && (error.message === "t2_budget_exhausted" || /(?:^|:\s*)t2_budget_exhausted(?:\s|$)/.test(error.message));
          const messageOwnerAlert = error.message.includes("owner_alert=true") || isT2BudgetExhausted;
          if (this.ownerAlert || detailOwnerAlert || messageOwnerAlert) this.ownerAlert = true;
          this.startupState = "blocked";
          // Preserve domain machine codes (L1_*, RECOVERY_V3_*, STARTUP_*). Only pure
          // CSJ closed surfaces use the closed-set reason alone.
          this.blockedReason = isT2BudgetExhausted
            ? "t2_budget_exhausted"
            : redactDiagnosticReason(error.message, error.code);
          this.record({ operation: "startup", status: "blocked", code: error.code, reason: this.blockedReason, attempt: driftAttempt, busyRetry, ...(this.ownerAlert ? { ownerAlert: true } : {}) });
          return this.diagnostics();
        }

        // Preserve ownerAlert=true; never overwrite to false on fail-closed rethrow path.
        this.startupState = "blocked";
        const raw = error instanceof Error ? error.message : String(error);
        this.blockedReason = redactDiagnosticReason(raw);
        this.record({ operation: "startup", status: "rejected_fail_closed", reason: this.blockedReason, attempt: driftAttempt, busyRetry, ...(this.ownerAlert ? { ownerAlert: true } : {}) });
        throw error;
      }
    }
  }

  async recoverAtStartup(): Promise<void> {
    if (canonicalMutationBarrierHeld(this.repo)) return this.recoverAtStartupUnlocked();
    return gitSingleFlight(this.repo, () => withCanonicalMutationBarrierInSingleFlight(this.repo, () => this.recoverAtStartupUnlocked()));
  }

  private async recoverAtStartupUnlocked(): Promise<void> {
    await this.mutationPreflight();
    await this.recoverMetadataCheckpointIndexUnlocked();
    const head = await resolveRef(this.repo, this.options.refName);
    const scan = await scanWholeL1Validated({ abrainHome: this.repo });
    const combined = await this.classifyHistoricalRecoveryCached(scan, head);
    await this.recoverStartupEpisodesUnlocked(scan, combined);
  }

  private async recoverStartupEpisodesUnlocked(
    scan: WholeL1ScanResult,
    combined: CombinedRecoveryHistoryResult,
  ): Promise<void> {
    const history = combined.v2;
    const v3History = combined.v3!;
    this.record({ operation: "classify_v2_history", status: "accepted", episodes: history.episodes.length, joins: history.joins.length, consumed: history.consumedEventIds.length, writableFrontierCount: history.writableFrontierCount });
    this.record({ operation: "classify_v3_history", status: "accepted", candidates: v3History.candidates.length, joins: v3History.joins.length, open: v3History.openEpisodeIds.length, terminal: v3History.terminalEpisodeIds.length });
    const recovered = recoverOpenRecoveryEpisodesV3FromScan(scan);
    if (recovered.quarantined.length) throw new CanonicalGitRuntimeError("RECOVERY_QUARANTINED", `active v3 recovery classification failed: ${quarantineReason("v3", recovered.quarantined)}`, { protocol: "v3", quarantined: recovered.quarantined });
    for (const initial of recovered.open) {
      let settled = false;
      let postCasRecoverFailure = false;
      for (let step = 0; step < RECOVERY_LANE_BUDGETS.drain * 2 + 2; step += 1) {
        const cursor = recoveryEpisodeCursorV3(initial.episodeId, initial.operation, await readRecoveryEventsV3(this.repo, initial.episodeId));
        if (cursor.complete || cursor.terminal) { settled = true; break; }
        let slot = cursor.pendingSlot;
        if (slot === null) {
          const claim = await claimNextRecoverySlotV3({ abrainHome: this.repo, operation: cursor.operation });
          if (claim.status === "complete" || claim.status === "terminal") { settled = true; break; }
          slot = claim.slot;
        }
        if (slot === null) throw new CanonicalGitRuntimeError("RECOVERY_V3_LIVENESS", "startup recovery claim returned no executable slot");

        // W2/W2': identify prepared-candidate ancestor / open FIRST (exclude terminal/complete).
        // True deadlock = open prepared + unpublished + neither side is ancestor (siblings).
        // Fresh prepared (HEAD ancestor of candidate / HEAD==base) is NOT deadlock → existing recover.
        const folded = foldRecoveryEventsV3(await readRecoveryEventsV3(this.repo, cursor.episodeId)).get(slot);
        const candidate = typeof folded?.prepared?.body?.candidate === "string" ? String(folded.prepared.body.candidate) : "";
        const published = !!folded?.published;
        const openPrepared = !!folded?.prepared && !folded.converged && !folded.aborted && !folded.terminal;
        const headNow = await resolveRef(this.repo, this.options.refName);
        const candidateAncestor = candidate ? await isAncestor(this.repo, candidate, headNow) : false;
        const headAncestorOfCandidate = candidate ? await isAncestor(this.repo, headNow, candidate) : false;
        const t2BudgetExhausted =
          step >= RECOVERY_LANE_BUDGETS.drain * 2
          || (process.env.PI_ASTACK_ENABLE_TEST_HOOKS === "1" && this.options.csjForceT2BudgetExhausted === true);

        // Journal is diagnostic-only shortcut (non-authority).
        const journal = await readCsjJournal(this.repo).catch(() => null);
        if (journal?.phase === "failed_post_cas_recover" && candidateAncestor) {
          postCasRecoverFailure = true;
        }

        const decision = decideCsjNextKick({
          candidateIsAncestorOfHead: candidateAncestor,
          openPrepared,
          t2BudgetExhausted,
          published,
          deadlockEligible: !published && openPrepared && !candidateAncestor && !headAncestorOfCandidate,
        });

        // NextKick order: exhausted → ownerAlert BEFORE bounded T2.
        if (decision.action === "owner_alert_blocked") {
          this.ownerAlert = true;
          this.setBlockedClosed("t2_budget_exhausted", { ownerAlert: true, code: "RECOVERY_V3_LIVENESS" });
          this.record({ operation: "recover_drain_v3", slot, status: "blocked", reason: "t2_budget_exhausted", ownerAlert: true });
          throw new CanonicalGitRuntimeError("RECOVERY_V3_LIVENESS", "t2_budget_exhausted", { owner_alert: true });
        }

        let action: Awaited<ReturnType<typeof recoverDrainSlotV3>>;
        if (decision.action === "bounded_t2_recover" || (postCasRecoverFailure && candidateAncestor && !t2BudgetExhausted)) {
          // W2/W2': ancestry-open → bounded T2 only; never second CSJ CAS.
          // postCAS recover failure does NOT rethrow stale-base.
          try {
            action = await recoverDrainSlotV3({
              abrainHome: this.repo,
              repo: this.repo,
              operation: cursor.operation,
              slot,
              prePublishCheck: () => this.mutationPreflight(),
              preConvergeCheck: () => preflightSharedIndexLock(this.repo),
            });
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
            // Never rethrow RECOVERY_V3_STALE_BASE after CAS ancestry; treat as post_cas_recover_failed.
            if (code === "RECOVERY_V3_STALE_BASE" || postCasRecoverFailure) {
              this.record({ operation: "recover_drain_v3", slot, status: "failed", reason: "post_cas_recover_failed" });
              // Stay in loop for bounded retry; do not cover ownerAlert=false.
              if (this.ownerAlert) {
                this.setBlockedClosed("t2_budget_exhausted", { ownerAlert: true });
                throw new CanonicalGitRuntimeError("RECOVERY_V3_LIVENESS", "t2_budget_exhausted", { owner_alert: true });
              }
              continue;
            }
            throw error;
          }
        } else if (decision.action === "run_csj") {
          const csj = await runCsjInBarrier({
            abrainHome: this.repo,
            repo: this.repo,
            refName: this.options.refName,
            requireArtifactBinding: true,
            sourceRoot: this.sourceRoot,
            implementationFingerprint: this.implementationFingerprint,
            validatorFingerprint: L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT,
            registryHash: registryContentHash(loadL1SchemaRegistry()),
          });
          // Privacy: record only closed reason_code (no episodeId/OID/path).
          this.record({ operation: "csj_v1", slot, status: csj.status, reason: csj.closed.reason_code });
          if (csj.status === "joined" || csj.status === "recover_only") {
            await clearCanonicalBlockedMemo(this.repo).catch(() => undefined);
            action = csj.recoverAction ?? "index_converged";
            if (csj.journalPhase === "failed_post_cas_recover") {
              postCasRecoverFailure = true;
              // CAS succeeded but T2 failed — do not rethrow stale; next step is bounded T2.
              this.record({ operation: "csj_v1", slot, status: "failed", reason: "post_cas_recover_failed" });
              continue;
            }
          } else if (csj.status === "ineligible") {
            // Memo ONLY on eligibility failure (not postCAS / cert / cas_race).
            try {
              const status = await statusSnapshot(this.repo);
              const inventoryFingerprint = await computeL1InventoryFingerprint({ abrainHome: this.repo });
              await writeCanonicalBlockedMemo(this.repo, buildCanonicalBlockedMemo({
                head: headNow,
                statusHash: status.hash,
                inventoryFingerprint,
                implementationFingerprint: this.implementationFingerprint,
                validatorFingerprint: L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT,
                registryHash: registryContentHash(loadL1SchemaRegistry()),
              }, {
                reason_code: csj.closed.reason_code,
                eligibility_false: true,
              }));
            } catch {
              // memo is diagnostic only
            }
            this.setBlockedClosed(csj.closed.reason_code);
            throw new CanonicalGitRuntimeError("RECOVERY_V3_STALE_BASE", csj.closed.reason_code);
          } else {
            // cert/cas/artifact failure: zero mutation path; do NOT write prehead memo after failed CAS attempt with no move.
            // If CAS already moved (post_cas_recover_failed), do not rethrow stale.
            if (csj.closed.reason_code === "post_cas_recover_failed" || csj.journalPhase === "failed_post_cas_recover") {
              postCasRecoverFailure = true;
              this.record({ operation: "csj_v1", slot, status: "failed", reason: "post_cas_recover_failed" });
              continue;
            }
            this.setBlockedClosed(csj.closed.reason_code);
            throw new CanonicalGitRuntimeError("RECOVERY_V3_STALE_BASE", csj.closed.reason_code);
          }
        } else if (decision.action === "published_nonancestor_blocked") {
          this.setBlockedClosed("published_nonzero", { ownerAlert: true });
          throw new CanonicalGitRuntimeError("RECOVERY_PUBLISHED_REF_DIVERGED", "published_nonzero", { owner_alert: true });
        } else {
          // existing recover path (fresh-base / normal)
          action = await recoverDrainSlotV3({
            abrainHome: this.repo,
            repo: this.repo,
            operation: cursor.operation,
            slot,
            prePublishCheck: () => this.mutationPreflight(),
            preConvergeCheck: () => preflightSharedIndexLock(this.repo),
          });
        }
        this.record({ operation: "recover_drain_v3", slot, action });
      }
      const final = recoveryEpisodeCursorV3(initial.episodeId, initial.operation, await readRecoveryEventsV3(this.repo, initial.episodeId));
      if (!settled && !final.complete && !final.terminal) {
        // Prefer ownerAlert when budget exhausted with ancestry open.
        if (this.ownerAlert) {
          this.setBlockedClosed("t2_budget_exhausted", { ownerAlert: true });
        }
        throw new CanonicalGitRuntimeError("RECOVERY_V3_LIVENESS", this.ownerAlert ? "t2_budget_exhausted" : "recovery_liveness", {
          ...(this.ownerAlert ? { owner_alert: true } : {}),
        });
      }
    }
  }

  private async recoveryMetadataArtifactsForStatus(
    status: { rows: readonly GitPorcelainV1Record[] },
    scan: WholeL1ScanResult,
    head: string,
  ): Promise<ValidatedArtifact[]> {
    const records = new Map(scan.all.map((record) => [record.relativePath, record]));
    const artifacts: ValidatedArtifact[] = [];
    for (const row of status.rows) {
      // Non-canonical dirty is outside the metadata checkpoint transaction.
      if (!statusTouchesCanonicalTree(row)) continue;
      if (row.sourcePath || row.paths.length !== 1 || row.status !== "??") {
        throw new CanonicalGitRuntimeError(
          "DEVICE_JOIN_METADATA_DIRTY_UNKNOWN",
          "metadata checkpoint accepts only untracked recovery-event puts",
          { path: row.path, status: row.status, sourcePath: row.sourcePath ?? null },
        );
      }
      const record = records.get(row.path);
      if (!isRecoveryMetadataRecord(record)) {
        throw new CanonicalGitRuntimeError(
          "DEVICE_JOIN_METADATA_DIRTY_UNKNOWN",
          "dirty path is not strictly validated recovery metadata",
          { path: row.path, status: row.status },
        );
      }
      if ((await git(this.repo, ["ls-tree", head, "--", row.path], 5_000)).trim()) {
        throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_NOT_ADD_ONLY", "metadata checkpoint path already exists in HEAD", { path: row.path });
      }
      artifacts.push(await validateRecoveryMetadataArtifact(this.repo, record));
    }
    const index = await snapshotIndexEntries(this.repo, artifacts.map((artifact) => artifact.receipt.path));
    if (index.size) {
      throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_INDEX_DIRTY", "metadata checkpoint path already exists in the shared index", {
        paths: [...index.keys()].sort(compareAscii),
      });
    }
    return artifacts.sort((left, right) => compareAscii(left.receipt.path, right.receipt.path));
  }

  private async freezeRecoveryMetadataCheckpointBacklogUnlocked(): Promise<RecoveryMetadataCheckpointBacklog> {
    await this.mutationPreflight();
    const head = await resolveRef(this.repo, this.options.refName);
    const firstStatus = await statusSnapshot(this.repo);
    const firstScan = await scanWholeL1Validated({ abrainHome: this.repo });
    await this.classifyHistoricalRecoveryCached(firstScan, head);
    const firstArtifacts = await this.recoveryMetadataArtifactsForStatus(firstStatus, firstScan, head);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondStatus = await statusSnapshot(this.repo);
    if (firstStatus.hash !== secondStatus.hash) {
      throw new CanonicalGitRuntimeError("STATUS_DRIFT", "repository status changed while freezing the metadata checkpoint");
    }
    const secondHead = await resolveRef(this.repo, this.options.refName);
    if (secondHead !== head) throw new CanonicalGitRuntimeError("HEAD_DRIFT", "HEAD changed while freezing the metadata checkpoint", { frozen: head, current: secondHead });
    const secondScan = await scanWholeL1Validated({ abrainHome: this.repo });
    await this.classifyHistoricalRecoveryCached(secondScan, head);
    const artifacts = await this.recoveryMetadataArtifactsForStatus(secondStatus, secondScan, head);
    if (artifacts.length !== firstArtifacts.length) throw new CanonicalGitRuntimeError("OWNERSHIP_DRIFT", "metadata checkpoint cohort size changed during freeze");
    for (let index = 0; index < artifacts.length; index += 1) {
      const first = firstArtifacts[index]!;
      const second = artifacts[index]!;
      if (JSON.stringify(first.receipt) !== JSON.stringify(second.receipt) || !first.content?.equals(second.content!)) {
        throw new CanonicalGitRuntimeError("OWNERSHIP_DRIFT", "metadata checkpoint receipt changed during freeze", { path: second.receipt.path });
      }
    }
    return Object.freeze({ head, statusHash: secondStatus.hash, scan: secondScan, artifacts: Object.freeze(artifacts) });
  }

  /** A metadata checkpoint is self-describing in HEAD. If CAS succeeded before
   * a crash but the shared index did not converge, reconstruct the exact
   * add-only cohort from HEAD and finish only that index transition. */
  private async recoverMetadataCheckpointIndexUnlocked(
    preclassified?: FrozenStartupClassificationInputs,
  ): Promise<void> {
    const head = preclassified?.head ?? await resolveRef(this.repo, this.options.refName);
    const parentLine = (await git(this.repo, ["rev-list", "--parents", "-n", "1", head], 5_000)).trim().split(/\s+/);
    if (parentLine.length !== 2 || parentLine[0] !== head) return;
    const parent = parentLine[1]!;
    const paths = nulPaths(await gitBuffer(this.repo, ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", parent, head]));
    if (!paths.length) return;

    const scan = preclassified?.scan ?? await scanWholeL1Validated({ abrainHome: this.repo });
    const records = new Map(scan.all.map((record) => [record.relativePath, record]));
    if (paths.some((rel) => !isRecoveryMetadataRecord(records.get(rel)))) return;
    if (!preclassified) await this.classifyHistoricalRecoveryCached(scan, head);

    const artifacts: ValidatedArtifact[] = [];
    const targets = new Map<string, string>();
    for (const rel of paths.sort(compareAscii)) {
      if ((await git(this.repo, ["ls-tree", parent, "--", rel], 5_000)).trim()) return;
      const record = records.get(rel)!;
      const artifact = await validateRecoveryMetadataArtifact(this.repo, record);
      const treeLine = (await git(this.repo, ["ls-tree", head, "--", rel], 5_000)).trim();
      const tab = treeLine.indexOf("\t");
      const meta = tab < 0 ? [] : treeLine.slice(0, tab).split(/\s+/);
      if (meta.length !== 3 || meta[1] !== "blob" || meta[0] !== artifact.receipt.mode || meta[2] === undefined) return;
      const headBytes = await gitBuffer(this.repo, ["show", `${head}:${rel}`], 5_000);
      if (!artifact.content?.equals(headBytes)) {
        throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_WORKTREE_DRIFT", "checkpoint worktree bytes differ from HEAD", { path: rel });
      }
      targets.set(rel, `${meta[0]} ${meta[2]} 0`);
      artifacts.push(artifact);
    }

    const currentIndex = await snapshotIndexEntries(this.repo, paths);
    if (paths.every((rel) => currentIndex.get(rel) === targets.get(rel))) return;
    const allowed = new Set(paths);
    const status = await statusSnapshot(this.repo);
    for (const row of status.rows) {
      // Non-canonical dirty remains outside recovery; only unknown canonical dirty blocks.
      if (row.paths.some((rel) => !allowed.has(rel) && isCanonicalTreePath(rel))) {
        throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_RECOVERY_DIRTY_UNKNOWN", "unknown dirty path blocks metadata checkpoint index recovery", { path: row.path, status: row.status });
      }
    }

    const plan: CohortPlanEntry[] = artifacts.map(({ receipt, content }) => ({ path: receipt.path, op: "put", mode: receipt.mode!, content: content! }));
    const prepared = await prepareExactCohortCommit({
      repo: this.repo,
      refName: this.options.refName,
      frozenCommit: parent,
      plan,
      message: "recover metadata checkpoint index",
      protocolVersion: LOCAL_DRAIN_METADATA_CHECKPOINT_PROTOCOL_V1,
    });
    if (prepared.candidate !== head) return;
    await preflightSharedIndexLock(this.repo);
    await convergeExactCohortIndex({ repo: this.repo, refName: this.options.refName, cohortPaths: paths, frozenIndexSnapshot: new Map() });
    const after = await statusSnapshot(this.repo);
    if (after.rows.some((row) => statusTouchesCanonicalTree(row))) {
      throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_RECOVERY_INCOMPLETE", "metadata checkpoint index recovery did not clear residual canonical dirty");
    }
    this.record({ operation: "metadata_checkpoint", status: "index_recovered", commit: head, cohortSize: paths.length });
  }

  private async checkpointRecoveryMetadataForDeviceJoinUnlocked(): Promise<string | null> {
    const backlog = await this.freezeRecoveryMetadataCheckpointBacklogUnlocked();
    if (!backlog.artifacts.length) return null;
    const plan: CohortPlanEntry[] = backlog.artifacts.map(({ receipt, content }) => ({
      path: receipt.path,
      op: "put",
      mode: receipt.mode!,
      content: content!,
    }));
    const frozenIndexSnapshot = await snapshotIndexEntries(this.repo, plan.map((entry) => entry.path));
    if (frozenIndexSnapshot.size) throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_INDEX_DIRTY", "metadata checkpoint freeze found staged cohort paths");
    const prepared = await prepareExactCohortCommit({
      repo: this.repo,
      refName: this.options.refName,
      frozenCommit: backlog.head,
      plan,
      message: "device join recovery metadata checkpoint",
      protocolVersion: LOCAL_DRAIN_METADATA_CHECKPOINT_PROTOCOL_V1,
    });

    const final = await this.freezeRecoveryMetadataCheckpointBacklogUnlocked();
    if (final.head !== backlog.head || final.statusHash !== backlog.statusHash || final.artifacts.length !== backlog.artifacts.length) {
      throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_FREEZE_DRIFT", "metadata checkpoint changed before CAS");
    }
    for (let index = 0; index < final.artifacts.length; index += 1) {
      const before = backlog.artifacts[index]!;
      const after = final.artifacts[index]!;
      if (JSON.stringify(before.receipt) !== JSON.stringify(after.receipt) || !before.content?.equals(after.content!)) {
        throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_FREEZE_DRIFT", "metadata checkpoint bytes changed before CAS", { path: after.receipt.path });
      }
    }

    const published = await publishExactCohortCommit({
      repo: this.repo,
      abrainHome: this.repo,
      refName: this.options.refName,
      candidate: prepared.candidate,
      frozenCommit: prepared.frozenCommit,
      purpose: "exact_cohort_publish",
    });
    if ((published.status !== "published" && published.status !== "already_published") || published.currentRef !== prepared.candidate) {
      throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_CAS_CONFLICT", "metadata checkpoint lost its local ref CAS", { published });
    }
    await preflightSharedIndexLock(this.repo);
    await convergeExactCohortIndex({
      repo: this.repo,
      refName: this.options.refName,
      cohortPaths: prepared.entries.map((entry) => entry.path),
      frozenIndexSnapshot,
    });
    const finalHead = await resolveRef(this.repo, this.options.refName);
    const finalScan = await scanWholeL1Validated({ abrainHome: this.repo });
    await this.classifyHistoricalRecoveryCached(finalScan, finalHead);
    const beforeIds = backlog.scan.all.map((record) => record.eventId).sort(compareAscii);
    const afterIds = finalScan.all.map((record) => record.eventId).sort(compareAscii);
    if (finalHead !== prepared.candidate || JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
      throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_VERIFY_FAILED", "metadata checkpoint changed HEAD or recovery event inventory unexpectedly");
    }
    const finalStatus = await statusSnapshot(this.repo);
    if (finalStatus.rows.some((row) => statusTouchesCanonicalTree(row))) {
      throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_VERIFY_DIRTY", "metadata checkpoint left residual canonical dirty");
    }
    this.record({ operation: "metadata_checkpoint", status: "index_converged", commit: prepared.candidate, cohortSize: prepared.entries.length });
    return prepared.candidate;
  }

  requestBacklogPreflight(): Promise<BacklogPreflightResult> {
    return gitSingleFlight(this.repo, () => this.requestBacklogPreflightUnlocked());
  }

  private async requestBacklogPreflightUnlocked(preclassified?: FrozenStartupClassificationInputs): Promise<BacklogPreflightResult> {
    if (!this.settings.enabled || !this.settings.valid) return { status: "empty", statusHash: sha256Hex("disabled"), receipts: [], ownership: {} };
    await assertProvenanceFrozen(this.sourceRoot, this.settings.settingsPath, this.loadedProvenance);
    await assertRepoMutationPreflight(this.repo, this.options.refName);
    await preflightSharedIndexLock(this.repo);
    const first = await statusSnapshot(this.repo);
    // Startup recovery mutation already holds a frozen scan; reuse it so ownership
    // does not re-materialize whole-L1 under the barrier.
    const ownershipContext = await buildCanonicalOwnershipContext({
      abrainHome: this.repo,
      ...(preclassified ? { scan: preclassified.scan } : {}),
    });
    const receipts: ProducedArtifact[] = [];
    const ownership: Record<string, string[]> = { knowledge: [], constraint: [], canonical_path: [] };
    try {
      for (const row of first.rows) {
        // Only l1/l2 enter ownership inference. Staged/unstaged/untracked/deleted
        // non-canonical dirty (production: tracked `.gitignore` ` M`) stays outside
        // the transaction: no receipt, no ARTIFACT_UNOWNED block, no mutation.
        // Staged non-canonical exact-cohort preservation is unchanged.
        if (!statusTouchesCanonicalTree(row)) continue;
        if (row.x !== " " && row.x !== "?") {
          throw new CanonicalGitRuntimeError("STAGED_DIRTY_BLOCKED", "staged canonical path cannot be inferred by startup ownership", { path: row.path, status: row.status });
        }
        if (row.sourcePath) throw new CanonicalGitRuntimeError("STATUS_RENAME_COPY_BLOCKED", "startup backlog does not infer ownership across rename/copy records", { path: row.path, sourcePath: row.sourcePath });
        if (row.status !== "??" && row.status !== " M" && row.status !== " D") {
          throw new CanonicalGitRuntimeError("STATUS_UNSAFE", "startup backlog accepts only untracked puts, tracked modifications, or tracked deletes", { path: row.path, status: row.status });
        }
        if (row.status !== " D" && await isLegacyReadOnlyL1(this.repo, row.path)) continue;
        const filePath = path.join(this.repo, ...row.path.split("/"));
        let receipt = await createProducedArtifactReceipt({ abrainHome: this.repo, filePath, ...(row.status === " D" ? { op: "delete" as const } : {}) });
        const validated = await validateReceipt(this.repo, receipt, false, ownershipContext);
        receipt = validated.receipt;
        receipts.push(receipt);
        const group = receipt.owner.startsWith("knowledge") ? "knowledge" : receipt.owner.startsWith("constraint") ? "constraint" : "canonical_path";
        ownership[group]!.push(receipt.path);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const second = await statusSnapshot(this.repo);
      if (first.hash !== second.hash) return { status: "blocked", statusHash: second.hash, receipts: [], ownership: {}, reason: "STATUS_DRIFT" };
      for (const receipt of receipts) {
        const revalidated = (await validateReceipt(this.repo, receipt, false, ownershipContext)).receipt;
        if (JSON.stringify(revalidated) !== JSON.stringify(receipt)) {
          throw new CanonicalGitRuntimeError("OWNERSHIP_DRIFT", "artifact ownership proof changed inside the startup freeze", { path: receipt.path });
        }
      }
      for (const paths of Object.values(ownership)) paths.sort(compareAscii);
      this.frozenOwnershipContext = { statusHash: second.hash, context: ownershipContext };
      return {
        status: receipts.length ? "ready" : "empty",
        statusHash: second.hash,
        receipts: Object.freeze(receipts.sort((a, b) => compareAscii(a.path, b.path))),
        ownership: Object.freeze(ownership),
      };
    } catch (error) {
      return { status: "blocked", statusHash: first.hash, receipts: [], ownership: {}, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async requestDrain(receipts: readonly ProducedArtifact[], message = "abrain: canonical artifact drain"): Promise<DrainResult> {
    const startup = await this.awaitStartup();
    if (startup.startup !== "ready") return { status: "blocked", localCommit: "not_published", reason: startup.blockedReason, ...(startup.ownerAlert ? { ownerAlert: true } : {}) };
    if (canonicalMutationBarrierHeld(this.repo)) return this.requestDrainUnlocked(receipts, message, "steady_writer");
    return gitSingleFlight(this.repo, () => withCanonicalMutationBarrierInSingleFlight(this.repo, () => this.requestDrainUnlocked(receipts, message, "steady_writer")));
  }

  async settleForDeviceJoin(): Promise<void> {
    if (!this.settings.valid) {
      throw new CanonicalGitRuntimeError(
        "CANONICAL_GIT_SETTINGS_INVALID",
        `canonicalGitRuntime settings are ${this.settings.reason}: ${this.settings.settingsPath}`,
        { reason: this.settings.reason, settingsPath: this.settings.settingsPath },
      );
    }
    if (!this.settings.enabled) return;
    const settle = async () => {
      await this.recoverAtStartupUnlocked();
      const backlog = await this.requestBacklogPreflightUnlocked();
      if (backlog.status === "blocked") throw new CanonicalGitRuntimeError("DEVICE_JOIN_BACKLOG_BLOCKED", backlog.reason ?? "canonical backlog preflight blocked");
      if (backlog.status === "ready" && !isCanonicalMetadataOnlyCohort(backlog.receipts)) {
        if (!backlog.receipts.some((receipt) => isCanonicalContentOwner(receipt.owner))) {
          throw new CanonicalGitRuntimeError("DEVICE_JOIN_CONTENT_AUTHORIZATION_REQUIRED", "device join may drain only validated Knowledge/Constraint L1/L2 backlog");
        }
        const drained = await this.requestDrainUnlocked(backlog.receipts, "device-join-canonical-drain", "startup_content_backlog");
        if (!["index_converged", "empty", "metadata_deferred", "consumed"].includes(drained.status)) {
          throw new CanonicalGitRuntimeError("DEVICE_JOIN_DRAIN_NOT_DURABLE", `canonical drain ended in ${drained.status}: ${drained.reason ?? "no reason"}`);
        }
      }
      await this.checkpointRecoveryMetadataForDeviceJoinUnlocked();
    };
    if (canonicalMutationBarrierHeld(this.repo)) return settle();
    return withCanonicalMutationBarrier(this.repo, settle);
  }

  private async requestDrainUnlocked(receipts: readonly ProducedArtifact[], message: string, generationPolicy: DrainGenerationPolicy): Promise<DrainResult> {
    if (!this.settings.enabled || !this.settings.valid) return { status: "disabled", localCommit: "not_published" };
    await this.mutationPreflight();
    const seen = new Set<string>();
    const currentStatus = await statusSnapshot(this.repo);
    const frozen = this.frozenOwnershipContext;
    this.frozenOwnershipContext = undefined;
    const ownershipContext = frozen?.statusHash === currentStatus.hash
      ? frozen.context
      : await buildCanonicalOwnershipContext({ abrainHome: this.repo });
    const validated: ValidatedArtifact[] = [];
    for (const input of receipts) {
      if (seen.has(input.path)) throw new CanonicalGitRuntimeError("RECEIPT_DUPLICATE", "duplicate artifact receipt", { path: input.path });
      seen.add(input.path);
      validated.push(await validateReceipt(this.repo, input, generationPolicy === "steady_writer", ownershipContext));
    }
    for (const item of validated) {
      if (item.receipt.owner !== "constraint_l1" || !item.content) continue;
      const envelope = JSON.parse(item.content.toString("utf-8")) as Record<string, any>;
      if (envelope.schema !== "constraint-projection-envelope/v1") continue;
      const dependencies = Array.from(new Set([...(envelope.body?.causal_parents ?? []), ...(envelope.body?.input_event_ids ?? [])]));
      for (const eventId of dependencies) {
        if (typeof eventId !== "string" || !/^[0-9a-f]{64}$/.test(eventId)) throw new CanonicalGitRuntimeError("CONSTRAINT_DEPENDENCY_INVALID", "constraint projection dependency is not an event id");
        const dependencyPath = `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
        if (seen.has(dependencyPath)) continue;
        if (!ownershipContext.headPaths.has(dependencyPath)) {
          throw new CanonicalGitRuntimeError("CONSTRAINT_DEPENDENCY_NOT_DURABLE", "constraint projection dependency is neither in HEAD nor this cohort", { eventId, dependencyPath });
        }
      }
    }

    // Absorb only PREVIOUS canonical-runtime metadata tails. New writer/projector
    // artifacts still require explicit receipts above. This is status-driven for
    // conflict detection, not directory harvesting: every absorbed path is an
    // individually registry-validated canonical_path/meta L1 envelope.
    const tailFirst = await statusSnapshot(this.repo);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const tailSecond = await statusSnapshot(this.repo);
    if (tailFirst.hash !== tailSecond.hash) throw new CanonicalGitRuntimeError("STATUS_DRIFT", "live status changed while freezing metadata tail");
    for (const row of tailSecond.rows) {
      if (seen.has(row.path)) continue;
      if (row.x !== " " && row.x !== "?") {
        // Rename/copy porcelain lists destination first; judge every path so a
        // canonical source renamed/copied to a non-canonical target still blocks.
        if (statusTouchesCanonicalTree(row)) {
          throw new CanonicalGitRuntimeError("STAGED_DIRTY_BLOCKED", "staged canonical path outside the receipt cohort blocks drain", { path: row.path });
        }
        // Exact-cohort convergence preserves unrelated staged entries byte-for-
        // byte; they are intentionally outside this transaction.
        continue;
      }
      // Unstaged/untracked/deleted non-canonical dirty stays outside drain too
      // (same isolation as staged non-canonical; production `.gitignore` ` M`).
      // Rename/copy is judged by every porcelain path (source + destination).
      if (!statusTouchesCanonicalTree(row)) continue;
      if (!row.path.startsWith("l1/events/sha256/")) throw new CanonicalGitRuntimeError("ARTIFACT_UNOWNED", "dirty path outside the explicit transaction blocks canonical drain", { path: row.path });
      if (await isLegacyReadOnlyL1(this.repo, row.path)) continue;
      const tailReceipt = await createProducedArtifactReceipt({ abrainHome: this.repo, filePath: path.join(this.repo, row.path) });
      const tailValidated = await validateReceipt(this.repo, tailReceipt, false, ownershipContext);
      if (tailValidated.receipt.owner !== "canonical_path_meta") {
        throw new CanonicalGitRuntimeError("ARTIFACT_UNOWNED", "dirty non-meta L1 path requires its writer receipt", { path: row.path, owner: tailValidated.receipt.owner });
      }
      seen.add(row.path);
      validated.push(tailValidated);
    }
    if (!validated.length) return { status: "empty", localCommit: "not_published" };
    const frozenCommit = await resolveRef(this.repo, this.options.refName);
    const rawPlan: CohortPlanEntry[] = validated.map(({ receipt, content }) => receipt.op === "delete"
      ? { path: receipt.path, op: "delete" }
      : { path: receipt.path, op: "put", mode: receipt.mode!, content: content! });
    let plan = await pruneNoops(this.repo, frozenCommit, rawPlan);
    if (!plan.length) return { status: "empty", commit: frozenCommit, localCommit: "not_published" };
    let surviving = survivingValidatedArtifacts(plan, validated);
    if (isCanonicalMetadataOnlyCohort(surviving)) {
      this.record({ operation: "drain", action: "metadata_deferred", generationPolicy, cohortSize: plan.length });
      return {
        status: "metadata_deferred",
        localCommit: "not_published",
        reason: "canonical recovery metadata awaits a content cohort",
      };
    }

    // V3 genesis is authorized only against a base whose complete v2 history
    // already passes U* classification. This check occurs before claim, blob,
    // tree, or commit-object creation.
    const genesisScan = await scanWholeL1Validated({ abrainHome: this.repo });
    await this.classifyHistoricalRecoveryCached(genesisScan, frozenCommit);
    const activeV3 = recoverOpenRecoveryEpisodesV3FromScan(genesisScan);
    if (activeV3.quarantined.length) throw new CanonicalGitRuntimeError("RECOVERY_QUARANTINED", `v3 genesis rejected by malformed active history: ${quarantineReason("v3", activeV3.quarantined)}`, { protocol: "v3", quarantined: activeV3.quarantined });

    let frozenIndexSnapshot = await snapshotIndexEntries(this.repo, plan.map((entry) => entry.path));
    let operation = recoveryOperationV3({
      symbolicRef: this.options.refName,
      baseCommit: frozenCommit,
      cohortSemanticRoot: cohortPlanSemanticRoot(plan, LOCAL_DRAIN_PROTOCOL_V3),
      frozenIndexSnapshotRoot: frozenIndexSnapshotRootV3(plan, frozenIndexSnapshot),
    });
    let episodeId = recoveryEpisodeIdentityV3(operation);
    let matchedExisting = [...activeV3.open, ...activeV3.terminal].find((cursor) => cursor.episodeId === episodeId);

    // Recovery rows written after an exact operation was frozen are not part
    // of that operation's cohort. Excluding only that episode's own rows lets
    // an in-process retry reconstruct the original operation while retaining
    // predecessor metadata that was already part of the frozen cohort.
    if (!matchedExisting) {
      for (const cursor of [...activeV3.open, ...activeV3.terminal]) {
        const ownPaths = new Set(genesisScan.selected
          .filter((record) => record.registration.envelope_schema === "local-drain-recovery-envelope/v3" && record.body.episode_id === cursor.episodeId)
          .map((record) => record.relativePath));
        const candidateRawPlan = rawPlan.filter((entry) => !ownPaths.has(entry.path));
        const candidatePlan = await pruneNoops(this.repo, frozenCommit, candidateRawPlan);
        if (!candidatePlan.length) continue;
        const candidateSnapshot = await snapshotIndexEntries(this.repo, candidatePlan.map((entry) => entry.path));
        const candidateOperation = recoveryOperationV3({
          symbolicRef: this.options.refName,
          baseCommit: frozenCommit,
          cohortSemanticRoot: cohortPlanSemanticRoot(candidatePlan, LOCAL_DRAIN_PROTOCOL_V3),
          frozenIndexSnapshotRoot: frozenIndexSnapshotRootV3(candidatePlan, candidateSnapshot),
        });
        if (recoveryEpisodeIdentityV3(candidateOperation) !== cursor.episodeId) continue;
        plan = candidatePlan;
        frozenIndexSnapshot = candidateSnapshot;
        operation = candidateOperation;
        episodeId = cursor.episodeId;
        matchedExisting = cursor;
        break;
      }
    }

    surviving = survivingValidatedArtifacts(plan, validated);
    if (generationPolicy === "startup_content_backlog" && !surviving.some((artifact) => isCanonicalContentOwner(artifact.receipt.owner))) {
      throw new CanonicalGitRuntimeError("STARTUP_CONTENT_AUTHORIZATION_REQUIRED", "startup surviving plan requires validated Knowledge/Constraint L1/L2 content");
    }
    if (matchedExisting?.terminal) {
      const reason = "RECOVERY_V3_TERMINAL_CONTENT_BACKLOG: exact v3 operation is terminal; owner intervention required, owner_alert=true, content retained";
      this.record({ operation: "drain_v3", episodeId, action: "terminal_content_blocked", ownerAlert: true });
      return { status: "blocked", episodeId, localCommit: "not_published", reason, ownerAlert: true };
    }
    const competing = activeV3.open.filter((cursor) => cursor.episodeId !== episodeId);
    if (competing.length) throw new CanonicalGitRuntimeError("RECOVERY_V3_CONCURRENT_OPERATION", "another exact v3 operation has an unresolved retry frontier", { episodeId, competing: competing.map((cursor) => cursor.episodeId) });

    let claim = await claimNextRecoverySlotV3({ abrainHome: this.repo, operation });
    for (let step = 0; step < RECOVERY_LANE_BUDGETS.drain + 1 && claim.status !== "acquired"; step += 1) {
      if (claim.status === "terminal") {
        const reason = "RECOVERY_V3_TERMINAL_CONTENT_BACKLOG: exact v3 operation is terminal; owner intervention required, owner_alert=true, content retained";
        this.record({ operation: "drain_v3", episodeId, action: "terminal_content_blocked", ownerAlert: true });
        return { status: "blocked", episodeId, localCommit: "not_published", reason, ownerAlert: true };
      }
      if (claim.status === "complete") return { status: "consumed", episodeId, localCommit: "not_published", reason: claim.status };
      // Existing prepared/pending episode: recover must use the same post-CAS
      // publication-aware disposition as the final newly-prepared branch.
      const recovered = await this.recoverDrainSlotPublicationAware({
        operation,
        slot: claim.slot,
        episodeId,
        prePublishCheck: () => this.prePublishCheckWithTestHook(),
      });
      if (recovered.kind === "published_pending") return recovered.result;
      const action = recovered.action;
      this.record({ operation: "recover_drain_v3", episodeId, slot: claim.slot, action, source: "request_drain" });
      if (action === "index_converged" || action === "already_complete") {
        return { status: "index_converged", commit: await resolveRef(this.repo, this.options.refName), episodeId, slot: claim.slot, localCommit: "index_converged" };
      }
      if (action === "terminal") {
        const reason = "RECOVERY_V3_TERMINAL_CONTENT_BACKLOG: exact v3 operation exhausted its retry budget; owner intervention required, owner_alert=true, content retained";
        return { status: "blocked", episodeId, slot: claim.slot, localCommit: "not_published", reason, ownerAlert: true };
      }
      claim = await claimNextRecoverySlotV3({ abrainHome: this.repo, operation });
    }
    if (claim.status !== "acquired" || !claim.shouldExecute) throw new CanonicalGitRuntimeError("RECOVERY_V3_LIVENESS", "request drain could not acquire the next exact-operation slot");
    await preflightSharedIndexLock(this.repo);
    const prepared = await prepareExactCohortCommit({ repo: this.repo, refName: this.options.refName, frozenCommit, plan, message, protocolVersion: LOCAL_DRAIN_PROTOCOL_V3 });
    await recordDrainPreparedV3({ abrainHome: this.repo, operation, slot: claim.slot, prepared, frozenIndexSnapshot });
    const recovered = await this.recoverDrainSlotPublicationAware({
      operation,
      slot: claim.slot,
      episodeId,
      preparedHint: { candidate: prepared.candidate, cohortManifestRoot: prepared.cohortManifestRoot },
      prePublishCheck: () => this.prePublishCheckWithTestHook(async () => {
        for (const item of validated) await readArtifactBytes(this.repo, item.receipt);
      }),
    });
    if (recovered.kind === "published_pending") return recovered.result;
    const action = recovered.action;
    this.record({ operation: "drain_v3", episodeId, slot: claim.slot, action, candidate: prepared.candidate, cohort: prepared.cohortManifestRoot });
    if (action !== "index_converged" && action !== "already_complete") return { status: "blocked", episodeId, slot: claim.slot, localCommit: "not_published", reason: action };
    return { status: "index_converged", commit: await resolveRef(this.repo, this.options.refName), episodeId, slot: claim.slot, localCommit: "index_converged" };
  }

}

export async function getCanonicalGitRuntime(options: CanonicalGitRuntimeOptions): Promise<CanonicalGitRuntime> {
  const repo = await repoRealpath(options.abrainHome);
  const settings = resolveCanonicalGitRuntimeSettings(options.settingsPath);
  if (!settings.valid) {
    throw new CanonicalGitRuntimeError(
      "CANONICAL_GIT_SETTINGS_INVALID",
      `canonicalGitRuntime settings are ${settings.reason}: ${settings.settingsPath}`,
      { reason: settings.reason, settingsPath: settings.settingsPath },
    );
  }
  const sourceRoot = path.resolve(options.sourceRoot ?? path.join(__dirname, "..", ".."));
  const provenance = await captureLoadedProvenance(sourceRoot, settings.settingsPath);
  const fingerprint = provenanceFingerprint(provenance);
  const state = globalState();
  if (state.implementationFingerprint && state.implementationFingerprint !== fingerprint) {
    throw new CanonicalGitRuntimeError("RUNTIME_PROVENANCE_SPLIT", "jiti/module copies loaded different implementation provenance", {
      loaded: state.implementationFingerprint,
      current: fingerprint,
    });
  }
  state.implementationFingerprint = fingerprint;
  state.loadedProvenance = provenance;
  const existing = state.runtimes.get(repo);
  if (existing) {
    if (existing.settings.settingsPath !== settings.settingsPath || existing.implementationFingerprint !== fingerprint) {
      throw new CanonicalGitRuntimeError("RUNTIME_RECONFIGURE_BLOCKED", "canonical runtime provenance/settings are frozen for this process");
    }
    return existing;
  }
  const runtime = new CanonicalGitRuntimeImpl({ repo, options, settings, sourceRoot, provenance });
  state.runtimes.set(repo, runtime);
  return runtime;
}

/**
 * Pure synchronous peek of an already-constructed canonical runtime.
 * Must not call getCanonicalGitRuntime / getCanonicalStartupPromise / awaitStartup,
 * and must not create runtimes, promises, singleflight turns, or barriers.
 */
export function peekCanonicalRuntimeDiagnostics(options: {
  abrainHome?: string;
} = {}): CanonicalRuntimePeek {
  const state = peekGlobalState();
  if (!state) return Object.freeze({ status: "none" as const });
  const want = resolvePeekRepoKey(options.abrainHome);
  let runtime: CanonicalGitRuntimeImpl | undefined;
  if (want) {
    runtime = state.runtimes.get(want);
    if (!runtime) {
      for (const [repo, candidate] of state.runtimes) {
        if (repo === want || path.resolve(repo) === want) {
          runtime = candidate;
          break;
        }
      }
    }
  } else if (state.runtimes.size === 1) {
    runtime = state.runtimes.values().next().value;
  }
  if (!runtime) {
    return Object.freeze({
      status: "none" as const,
      ...(state.implementationFingerprint ? { implementationFingerprint: state.implementationFingerprint } : {}),
    });
  }
  const diag = runtime.diagnostics();
  const status = diag.startup === "not_started" && !state.startupPromises.size
    ? "not_started"
    : diag.startup;
  return Object.freeze({
    status,
    ...(diag.blockedReason ? { reason: diag.blockedReason } : {}),
    ...(diag.deferredReason ? { deferredReason: diag.deferredReason } : {}),
    ...(diag.retryable ? { retryable: true as const } : {}),
    generation: diag.startupGeneration,
    ...(lastStartupPhaseFromTail(diag.tail) ? { lastPhase: lastStartupPhaseFromTail(diag.tail) } : {}),
    repo: diag.repo,
    implementationFingerprint: diag.implementationFingerprint,
  });
}

/** Test-only: count process-local startup attempts currently cached. */
export function __canonicalStartupPromiseMapSizeForTests(): number {
  const state = peekGlobalState();
  return state?.startupPromises.size ?? 0;
}

/** Test-only: count process-local runtime instances. */
export function __canonicalRuntimeMapSizeForTests(): number {
  const state = peekGlobalState();
  return state?.runtimes.size ?? 0;
}

function canonicalStartupKey(options: CanonicalGitRuntimeOptions): string {
  return JSON.stringify([
    resolveCanonicalRepoKey(options.abrainHome),
    path.resolve(options.settingsPath ?? defaultSettingsPath()),
    path.resolve(options.sourceRoot ?? path.join(__dirname, "..", "..")),
    options.refName ?? "refs/heads/main",
    options.startupBarrierTimeoutMs ?? null,
    options.startupBusyBudgetMs ?? null,
    options.startupBusyInitialBackoffMs ?? null,
    options.startupBusyMaxBackoffMs ?? null,
  ]);
}

function canonicalStartupConsumerKey(options: CanonicalGitRuntimeOptions, consumerId: string): string {
  return `${canonicalStartupKey(options)}\0${consumerId}`;
}

function startupConsumerState(options: CanonicalGitRuntimeOptions, consumerId: string): CanonicalStartupConsumerState {
  const state = globalState();
  const key = canonicalStartupConsumerKey(options, consumerId);
  const existing = state.startupConsumers.get(key);
  if (existing) return existing;
  const created: CanonicalStartupConsumerState = { scheduled: false };
  state.startupConsumers.set(key, created);
  return created;
}

function reportCanonicalStartupState(
  state: CanonicalStartupConsumerState,
  message: string,
  type: CanonicalStartupNotificationType,
): void {
  if (state.reporter) {
    try {
      state.reporter(message, type);
      return;
    } catch {
      // A session replacement may invalidate the previous UI between events.
      // The next session_start replaces reporter; stderr remains reliable now.
    }
  }
  console.error(`[canonical-startup] ${message}`);
}

function resetCanonicalStartupWarnings(diagnostics: CanonicalRuntimeDiagnostics): void {
  const notifications = globalState().startupWarningNotifications;
  const existing = notifications.get(diagnostics.repo);
  if (!existing) {
    notifications.set(diagnostics.repo, {
      generation: diagnostics.startupGeneration,
      readyGeneration: diagnostics.startupGeneration,
      signatures: new Set(),
    });
    return;
  }
  existing.generation = Math.max(Number.isFinite(existing.generation) ? existing.generation : 0, diagnostics.startupGeneration);
  existing.readyGeneration = Math.max(Number.isFinite(existing.readyGeneration) ? existing.readyGeneration : 0, diagnostics.startupGeneration);
  existing.signatures.clear();
}

function reportCanonicalStartupWarningOnce(
  consumer: CanonicalStartupConsumerState,
  diagnostics: CanonicalRuntimeDiagnostics,
  message: string,
): void {
  if (diagnostics.startup !== "blocked" && diagnostics.startup !== "deferred") {
    reportCanonicalStartupState(consumer, message, "warning");
    return;
  }
  const state = globalState();
  let generation = state.startupWarningNotifications.get(diagnostics.repo);
  if (!generation) {
    generation = { generation: diagnostics.startupGeneration, readyGeneration: 0, signatures: new Set() };
    state.startupWarningNotifications.set(diagnostics.repo, generation);
  } else {
    generation.generation = Number.isFinite(generation.generation) ? generation.generation : 0;
    generation.readyGeneration = Number.isFinite(generation.readyGeneration) ? generation.readyGeneration : 0;
    if (diagnostics.startupGeneration < generation.generation) return;
    if (diagnostics.startupGeneration > generation.generation) {
      generation.generation = diagnostics.startupGeneration;
      generation.signatures.clear();
    }
  }
  if (diagnostics.startupGeneration <= generation.readyGeneration) return;
  const reason = diagnostics.deferredReason
    ? `${diagnostics.deferredReason}:${diagnostics.blockedReason ?? "unknown"}`
    : diagnostics.blockedReason ?? "unknown";
  const signature = `${diagnostics.startup}\0${reason}`;
  if (generation.signatures.has(signature)) return;
  generation.signatures.add(signature);
  reportCanonicalStartupState(consumer, message, "warning");
}

function reportCanonicalStartupFailureOnce(
  runtime: CanonicalGitRuntimeOptions,
  consumer: CanonicalStartupConsumerState,
  error: unknown,
  startupPromiseGeneration: number,
): void {
  const state = globalState();
  const key = canonicalStartupKey(runtime);
  if (state.startupFailureNotificationGenerations.get(key) !== startupPromiseGeneration) return;
  const notificationKey = `${key}\0${startupPromiseGeneration}`;
  if (state.startupFailureNotifications.has(notificationKey)) return;
  state.startupFailureNotifications.add(notificationKey);
  reportCanonicalStartupState(
    consumer,
    `canonical startup failed: ${error instanceof Error ? error.message : String(error)}`,
    "error",
  );
}

function nextCanonicalStartupPromiseGeneration(
  state: GlobalRuntimeState,
  key: string,
  promise: Promise<CanonicalRuntimeDiagnostics>,
): number {
  const previousGeneration = state.startupPromiseGenerations.get(key);
  const generation = (previousGeneration ?? 0) + 1;
  state.startupPromiseGenerations.set(key, generation);
  state.startupPromiseGenerationTokens.set(promise, generation);
  state.startupFailureNotificationGenerations.set(key, generation);
  if (previousGeneration !== undefined) state.startupFailureNotifications.delete(`${key}\0${previousGeneration}`);
  return generation;
}

function reuseCanonicalStartupAttempt(
  state: GlobalRuntimeState,
  key: string,
  existing: Promise<CanonicalRuntimeDiagnostics>,
): { promise: Promise<CanonicalRuntimeDiagnostics>; generation: number } {
  const generation = state.startupPromiseGenerationTokens.get(existing)
    ?? nextCanonicalStartupPromiseGeneration(state, key, existing);
  return { promise: existing, generation };
}

/**
 * Process-global startup singleflight.
 *
 * - Default (`forceFreshAfterReady=false`): historical getCanonicalStartupPromise
 *   semantics — reuse in-flight **or** settled-ready promise.
 * - Kick (`forceFreshAfterReady=true`): reuse only while in-flight; after a
 *   settled ready, CAS-replace the process promise and force the runtime into a
 *   new awaitStartup generation (may fast-path via live last-known-ready gate).
 * - Identity-guarded settle handlers prevent ABA: an older promise's
 *   resolve/reject never deletes a newer replacement for the same key.
 */
function getCanonicalStartupAttempt(
  options: CanonicalGitRuntimeOptions,
  opts: { forceFreshAfterReady?: boolean } = {},
): {
  promise: Promise<CanonicalRuntimeDiagnostics>;
  generation: number;
} {
  const state = globalState();
  const key = canonicalStartupKey(options);
  const existing = state.startupPromises.get(key);
  let forceRuntimeFresh = false;
  if (existing) {
    const readySettled = state.startupPromiseReadySettled.has(existing);
    if (!(opts.forceFreshAfterReady && readySettled)) {
      return reuseCanonicalStartupAttempt(state, key, existing);
    }
    // CAS-style replace of a settled-ready promise so concurrent kicks coalesce
    // on the first replacement rather than minting parallel attempts.
    if (state.startupPromises.get(key) === existing) {
      state.startupPromises.delete(key);
      forceRuntimeFresh = true;
    }
    const raced = state.startupPromises.get(key);
    if (raced) return reuseCanonicalStartupAttempt(state, key, raced);
  }

  const created = (async () => {
    const runtime = await getCanonicalGitRuntime(options);
    if (forceRuntimeFresh) {
      (runtime as CanonicalGitRuntimeImpl).forceNextStartupAttempt();
    }
    return runtime.awaitStartup();
  })();
  const generation = nextCanonicalStartupPromiseGeneration(state, key, created);
  state.startupPromises.set(key, created);
  void created.then(
    (diag) => {
      if (diag.startup === "ready") {
        // Mark ready only when this promise is still the installed attempt.
        // A replaced promise must not poison the successor's ready bit.
        if (state.startupPromises.get(key) === created) {
          state.startupPromiseReadySettled.add(created);
        }
        resetCanonicalStartupWarnings(diag);
        return;
      }
      // Blocked and deferred results wait for an external lifecycle trigger.
      // Eviction provides that trigger a fresh freeze and retry state machine.
      // Identity guard prevents an older settle from deleting a replacement
      // promise installed for the same key (the promise-cache ABA race).
      if ((diag.startup === "blocked" || diag.startup === "deferred") && state.startupPromises.get(key) === created) {
        state.startupPromises.delete(key);
      }
    },
    () => {
      // Identity guard prevents an older rejection from deleting a replacement
      // promise installed for the same key (the promise-cache ABA race).
      if (state.startupPromises.get(key) === created) state.startupPromises.delete(key);
    },
  );
  return { promise: created, generation };
}

/** Return the one process-global in-flight/successful startup promise for this
 * runtime. Rejections are evicted so a repaired repo can retry in-process.
 *
 * Canonical ownership under daemon worker tasks:
 * - Process-level startup attempt is created/retried **outside** worker-budget ALS
 *   (`runOutsideWorkerBudget`) so cold scan uses the full configured busy budget
 *   and is not bound to a short task deadline / task ALS.
 * - RPC tasks never wait 60m for startup. If process-level startup is not already
 *   ready, return cooperative deferred immediately (retryable/held, no poison).
 * - Each external task best-effort kicks the next generation; bootstrap continues
 *   for the worker process lifetime. Does not hard-kill in-flight mutation.
 * - Worker shutdown/restart drops in-memory attempt; a new process re-bootstraps.
 */
export function getCanonicalStartupPromise(options: CanonicalGitRuntimeOptions): Promise<CanonicalRuntimeDiagnostics> {
  const budget = getWorkerBudgetContext();
  if (!budget) return getCanonicalStartupAttempt(options).promise;

  // Kick / observe process-level attempt outside task ALS (full busy budget).
  const attempt = runOutsideWorkerBudget(() => getCanonicalStartupAttempt(options));

  // Non-blocking readiness: if already fulfilled as ready on the current
  // microtask queue, return it; otherwise cooperative-defer immediately so the
  // short task can held/retry without waiting for cold start.
  return new Promise<CanonicalRuntimeDiagnostics>((resolve) => {
    let settled = false;
    const finish = (diag: CanonicalRuntimeDiagnostics) => {
      if (settled) return;
      settled = true;
      resolve(diag);
    };
    void attempt.promise.then(
      (diag) => {
        if (diag.startup === "ready") finish(diag);
        else finish(workerBudgetStartupDeferredDiag(options, attempt.generation));
      },
      () => finish(workerBudgetStartupDeferredDiag(options, attempt.generation)),
    );
    // Attach after .then so an already-fulfilled ready promise wins the microtask queue.
    queueMicrotask(() => {
      finish(workerBudgetStartupDeferredDiag(options, attempt.generation));
    });
  });
}

/** Explicit daemon-worker convergence kick.
 *
 * Always runs outside worker-budget ALS so an expired task budget cannot clamp
 * cold startup. Semantics:
 * - in-flight attempt for the same root → singleflight coalesce (same generation)
 * - after settled ready → fresh process attempt + runtime generation
 *   (may still hit live last-known-ready gate for a fast ready)
 * - never merely reuses a fulfilled ready promise while callers bump attestation
 *
 * Ordinary getCanonicalStartupPromise keeps reusing settled ready.
 */
export function kickCanonicalStartupAttempt(options: CanonicalGitRuntimeOptions): {
  promise: Promise<CanonicalRuntimeDiagnostics>;
  generation: number;
} {
  return runOutsideWorkerBudget(() => getCanonicalStartupAttempt(options, { forceFreshAfterReady: true }));
}

/** Pure control-plane observation. Never creates a runtime, promise, timer, scan,
 * Git operation, or mutation barrier. */
export function observeCanonicalStartupAttempt(options: {
  abrainHome?: string;
} = {}): CanonicalRuntimePeek {
  return peekCanonicalRuntimeDiagnostics(options);
}

function workerBudgetStartupDeferredDiag(
  options: CanonicalGitRuntimeOptions,
  generation: number = 0,
): CanonicalRuntimeDiagnostics {
  const repo = path.resolve(options.abrainHome);
  const settings = resolveCanonicalGitRuntimeSettings(options.settingsPath);
  return Object.freeze({
    apiVersion: API_VERSION,
    repo,
    settings,
    startupGeneration: generation,
    startup: "deferred" as const,
    retryable: true as const,
    deferredReason: "STARTUP_BUDGET_EXHAUSTED" as const,
    blockedReason:
      "STARTUP_BUDGET_EXHAUSTED: worker task observed process-level startup not-ready; "
      + "task returns held/retryable without waiting. Process bootstrap continues outside task ALS; "
      + "next external task may observe ready generation or re-kick.",
    loadedProvenance: Object.freeze([] as CanonicalRuntimeDiagnostics["loadedProvenance"]),
    implementationFingerprint: peekGlobalState()?.implementationFingerprint ?? "worker-budget-deferred",
    tail: Object.freeze([] as CanonicalRuntimeDiagnostics["tail"]),
  });
}

/** Refresh the current session's reporter without retaining it in a pending task. */
export function setCanonicalStartupReporter(options: {
  runtime: CanonicalGitRuntimeOptions;
  consumerId: string;
  reporter?: CanonicalStartupReporter;
}): void {
  startupConsumerState(options.runtime, options.consumerId).reporter = options.reporter;
}

/** Report through the most recently registered session UI, with stderr fallback. */
export function reportCanonicalStartupConsumer(options: {
  runtime: CanonicalGitRuntimeOptions;
  consumerId: string;
  message: string;
  type: CanonicalStartupNotificationType;
  diagnostics?: CanonicalRuntimeDiagnostics;
}): void {
  const consumer = startupConsumerState(options.runtime, options.consumerId);
  if (options.type === "warning" && options.diagnostics) {
    reportCanonicalStartupWarningOnce(consumer, options.diagnostics, options.message);
    return;
  }
  reportCanonicalStartupState(consumer, options.message, options.type);
}

/** TUI and RPC are long-lived interactive hosts. Their session_start hooks
 * must expose the editor/protocol before full local recovery completes. */
export function canonicalStartupRunsInBackground(mode: CanonicalStartupHostMode | undefined): boolean {
  return mode === "tui" || mode === "rpc";
}

function launchCanonicalStartupConsumer(
  runtime: CanonicalGitRuntimeOptions,
  consumerId: string,
  state: CanonicalStartupConsumerState,
): Promise<void> {
  state.scheduled = false;
  if (state.running) return state.running;
  const running = (async () => {
    let diagnostics: CanonicalRuntimeDiagnostics;
    const startupAttempt = getCanonicalStartupAttempt(runtime);
    try {
      diagnostics = await startupAttempt.promise;
    } catch (error) {
      state.latest = undefined;
      reportCanonicalStartupFailureOnce(runtime, state, error, startupAttempt.generation);
      return;
    }

    // Repeated /new, /resume, or /reload calls replace a pending continuation.
    // If another session starts while onReady is running, execute the new latest
    // continuation next; no task ever retains a session-bound UI object.
    while (state.latest) {
      const invocation = state.latest;
      state.latest = undefined;
      try {
        if (diagnostics.startup === "ready") {
          resetCanonicalStartupWarnings(diagnostics);
          await invocation.onReady(diagnostics);
        } else {
          await invocation.onBlocked?.(diagnostics);
          reportCanonicalStartupWarningOnce(state, diagnostics, invocation.blockedMessage(diagnostics));
        }
      } catch (error) {
        reportCanonicalStartupState(state, invocation.errorMessage(error), "error");
      }
    }
  })().finally(() => {
    state.running = undefined;
    if (state.latest && !state.scheduled) {
      state.scheduled = true;
      queueMicrotask(() => { void launchCanonicalStartupConsumer(runtime, consumerId, state); });
    }
  });
  state.running = running;
  return running;
}

/** Schedule one named post-barrier consumer. Pending calls for the same
 * consumer are coalesced to the latest session continuation and reporter. */
export function scheduleCanonicalStartupConsumer(options: {
  runtime: CanonicalGitRuntimeOptions;
  consumerId: string;
  mode?: CanonicalStartupHostMode;
  reporter?: CanonicalStartupReporter;
  onReady: (diagnostics: CanonicalRuntimeDiagnostics) => Promise<void> | void;
  onBlocked?: (diagnostics: CanonicalRuntimeDiagnostics) => Promise<void> | void;
  blockedMessage?: (diagnostics: CanonicalRuntimeDiagnostics) => string;
  errorMessage?: (error: unknown) => string;
  schedule?: CanonicalStartupTaskScheduler;
}): Promise<void> {
  const state = startupConsumerState(options.runtime, options.consumerId);
  state.reporter = options.reporter;
  state.latest = {
    onReady: options.onReady,
    onBlocked: options.onBlocked,
    blockedMessage: options.blockedMessage ?? ((diagnostics) => `canonical startup blocked: ${diagnostics.blockedReason ?? "unknown"}`),
    errorMessage: options.errorMessage ?? ((error) => `canonical startup continuation threw: ${error instanceof Error ? error.message : String(error)}`),
  };

  if (!canonicalStartupRunsInBackground(options.mode)) {
    return launchCanonicalStartupConsumer(options.runtime, options.consumerId, state);
  }
  if (!state.running && !state.scheduled) {
    state.scheduled = true;
    const schedule = options.schedule ?? ((task: () => void) => setImmediate(task));
    try {
      schedule(() => { void launchCanonicalStartupConsumer(options.runtime, options.consumerId, state); });
    } catch (error) {
      reportCanonicalStartupState(state, state.latest.errorMessage(error), "error");
      queueMicrotask(() => { void launchCanonicalStartupConsumer(options.runtime, options.consumerId, state); });
    }
  }
  return Promise.resolve();
}

export async function awaitCanonicalGitStartup(options: CanonicalGitRuntimeOptions): Promise<CanonicalRuntimeDiagnostics> {
  return getCanonicalStartupPromise(options);
}

export async function requestCanonicalDrain(options: CanonicalGitRuntimeOptions & { receipts: readonly ProducedArtifact[]; message?: string }): Promise<DrainResult> {
  return (await getCanonicalGitRuntime(options)).requestDrain(options.receipts, options.message);
}
