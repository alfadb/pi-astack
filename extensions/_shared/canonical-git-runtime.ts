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
  LOCAL_DRAIN_METADATA_CHECKPOINT_PROTOCOL_V1,
  LOCAL_DRAIN_PROTOCOL_V3,
  prepareExactCohortCommit,
  publishExactCohortCommit,
  resolveRef,
  snapshotIndexEntries,
  type CohortPlanEntry,
} from "./git-exact-cohort";
import { gitSingleFlight } from "./git-singleflight";
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
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import { sha256Hex } from "./jcs";

const execFileAsync = promisify(execFile);
const GLOBAL_KEY = Symbol.for("pi-astack/canonical-git-runtime/v1");
const API_VERSION = 1;
const SETTINGS_MODE = "local_convergence_v2" as const;
const MAX_DIAGNOSTIC_TAIL = 64;
const RECOVERY_METADATA_ENVELOPE_SCHEMAS = new Set([
  "drain-recovery-envelope/v1",
  "local-drain-recovery-envelope/v2",
  "local-drain-recovery-envelope/v3",
]);

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

export interface CanonicalRuntimeDiagnostics {
  apiVersion: number;
  repo: string;
  settings: CanonicalGitRuntimeSettings;
  startup: "not_started" | "running" | "ready" | "blocked";
  blockedReason?: string;
  ownerAlert?: true;
  loadedProvenance: readonly LoadedProvenanceEntry[];
  implementationFingerprint: string;
  tail: readonly Record<string, unknown>[];
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
  /** Primarily for bounded hosts/tests; production defaults to the barrier's 30s timeout. */
  startupBarrierTimeoutMs?: number;
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
  startupConsumers: Map<string, CanonicalStartupConsumerState>;
}

function globalState(): GlobalRuntimeState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[GLOBAL_KEY] as Partial<GlobalRuntimeState> | undefined;
  if (!existing) {
    const created: GlobalRuntimeState = {
      apiVersion: API_VERSION,
      runtimes: new Map(),
      startupPromises: new Map(),
      startupConsumers: new Map(),
    };
    global[GLOBAL_KEY] = created;
    return created;
  }
  if (existing.apiVersion !== API_VERSION || !(existing.runtimes instanceof Map)) {
    throw new CanonicalGitRuntimeError("RUNTIME_SINGLETON_SPLIT", "incompatible process-global canonical runtime singleton");
  }
  if (!(existing.startupPromises instanceof Map)) existing.startupPromises = new Map();
  if (!(existing.startupConsumers instanceof Map)) existing.startupConsumers = new Map();
  return existing as GlobalRuntimeState;
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
    GIT_TERMINAL_PROMPT: "0",
  };
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
    ["retained-directory-ofd-lock", path.join(sourceRoot, "extensions/_shared/retained-directory-ofd-lock.ts")],
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
  // Process identity follows the bytes actually loaded. A later source commit
  // may move HEAD to those same bytes without changing the running program.
  return sha256Hex(JSON.stringify(entries.map((entry) => [entry.label, entry.path, entry.bytesSha256])));
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
    throw new CanonicalGitRuntimeError("INDEX_LOCK_PRESENT", "shared index lock exists; it is never removed by canonical runtime", {
      lockPath,
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    });
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

async function statusSnapshot(repo: string): Promise<{ raw: Buffer; hash: string; rows: GitPorcelainV1Record[] }> {
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

export async function buildCanonicalOwnershipContext(options: { abrainHome: string }): Promise<CanonicalOwnershipContext> {
  const started = Date.now();
  const repo = await repoRealpath(options.abrainHome);
  const scan = await scanWholeL1Validated({ abrainHome: repo });
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

/**
 * Test/multi-process harness only. When set, cold-start classification sleeps
 * this many ms OUTSIDE the mutation barrier so a concurrent writer can prove
 * it is not CANONICAL_MUTATION_BUSY during long classification.
 * Production never sets PI_ASTACK_STARTUP_CLASSIFY_DELAY_MS.
 */
function startupClassificationDelayMs(): number {
  const raw = process.env.PI_ASTACK_STARTUP_CLASSIFY_DELAY_MS;
  if (raw === undefined || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 120_000);
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
  private startupPromise?: Promise<CanonicalRuntimeDiagnostics>;
  private blockedReason?: string;
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
    this.tail.push(Object.freeze({ at: new Date().toISOString(), ...row }));
    if (this.tail.length > MAX_DIAGNOSTIC_TAIL) this.tail.splice(0, this.tail.length - MAX_DIAGNOSTIC_TAIL);
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
      startup: this.startupState,
      ...(this.blockedReason ? { blockedReason: this.blockedReason } : {}),
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
   * Startup freezes immutable recovery-history inputs and classifies OUTSIDE
   * the canonical mutation barrier, then acquires the barrier only for
   * recovery/index/ref/worktree mutation. After the barrier is held, HEAD +
   * whole-L1 scan root + status ownership inputs are rechecked; drift releases
   * the barrier and bounds a recompute. Classification failure also rechecks
   * first: drift → retry, stable → fail-closed. This keeps multi-minute
   * classification off the 30s OFD lock so concurrent writers/startups do not
   * observe CANONICAL_MUTATION_BUSY solely because another process is classifying.
   */
  awaitStartup(): Promise<CanonicalRuntimeDiagnostics> {
    if (!this.startupPromise) {
      const created = this.runStartupOutsideMutationBarrier();
      this.startupPromise = created;
      void created.then(
        (diag) => {
          // blocked / drift-exhausted must NOT permanently cache: next enqueue
          // or consumer re-entry re-runs startup (park must not freeze forever).
          if (diag.startup === "blocked" && this.startupPromise === created) {
            this.startupPromise = undefined;
            if (this.startupState === "blocked") this.startupState = "not_started";
          }
        },
        () => {
          // Barrier acquisition rejects before the startup body's blocked-state
          // conversion. Evict that rejected instance promise so a repaired or
          // newly-uncontended repository can retry in this process.
          if (this.startupPromise === created) this.startupPromise = undefined;
        },
      );
    }
    return this.startupPromise;
  }

  private async freezeStartupClassificationInputs(): Promise<{
    head: string;
    scan: WholeL1ScanResult;
    scanRoot: string;
    statusHash: string;
  }> {
    // headBefore → scan/status → headAfter. Any HEAD movement during freeze is drift.
    const headBefore = await resolveRef(this.repo, this.options.refName);
    const scan = await scanWholeL1Validated({ abrainHome: this.repo });
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
    return { head: headAfter, scan, scanRoot, statusHash };
  }

  private async assertStartupClassificationInputsStable(frozen: {
    head: string;
    scanRoot: string;
    statusHash: string;
  }): Promise<void> {
    const currentHead = await resolveRef(this.repo, this.options.refName);
    const currentScan = await scanWholeL1Validated({ abrainHome: this.repo });
    const currentScanRoot = recoveryHistoryScanRoot(currentScan);
    const currentStatusHash = (await statusSnapshot(this.repo)).hash;
    if (currentHead !== frozen.head || currentScanRoot !== frozen.scanRoot || currentStatusHash !== frozen.statusHash) {
      throw new CanonicalGitRuntimeError("STARTUP_CLASSIFY_INPUT_DRIFT", "HEAD/scan-root/status drifted after outside immutable classification", {
        frozenHead: frozen.head,
        currentHead,
        frozenScanRoot: frozen.scanRoot,
        currentScanRoot,
        frozenStatusHash: frozen.statusHash,
        currentStatusHash,
      });
    }
  }

  private async classifyStartupHistoryOutsideBarrier(
    scan: WholeL1ScanResult,
    head: string,
    statusHash: string,
  ): Promise<CombinedRecoveryHistoryResult> {
    const delayMs = startupClassificationDelayMs();
    if (delayMs > 0) {
      this.record({ operation: "startup_classify", status: "test_delay", delayMs });
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    return this.classifyHistoricalRecoveryCached(scan, head, statusHash);
  }

  private async runStartupOutsideMutationBarrier(): Promise<CanonicalRuntimeDiagnostics> {
    if (!this.settings.enabled || !this.settings.valid) {
      this.startupState = "ready";
      this.record({ operation: "startup", status: "legacy_boundary", reason: this.settings.reason });
      return this.diagnostics();
    }

    this.startupState = "running";
    this.blockedReason = undefined;
    this.ownerAlert = false;

    const MAX_DRIFT_RETRIES = 4;
    const barrierOptions = this.options.startupBarrierTimeoutMs === undefined
      ? {}
      : { timeoutMs: this.options.startupBarrierTimeoutMs };

    for (let attempt = 0; attempt < MAX_DRIFT_RETRIES; attempt += 1) {
      let frozen: { head: string; scan: WholeL1ScanResult; scanRoot: string; statusHash: string } | undefined;
      let freezeError: unknown;
      try {
        frozen = await this.freezeStartupClassificationInputs();
      } catch (error) {
        freezeError = error;
        this.record({
          operation: "startup",
          status: "freeze_inputs_failed",
          attempt,
          reason: error instanceof Error ? error.message : String(error),
          ...(error instanceof CanonicalGitRuntimeError ? { code: error.code, detail: error.detail } : {}),
        });
      }

      let classificationError: unknown;
      if (frozen && !freezeError) {
        try {
          // Populates recoveryHistoryCache for the under-barrier cache hit path.
          await this.classifyStartupHistoryOutsideBarrier(frozen.scan, frozen.head, frozen.statusHash);
          this.record({
            operation: "startup_classify",
            status: "outside_barrier_ok",
            attempt,
            head: frozen.head,
            scanRoot: frozen.scanRoot,
            statusHash: frozen.statusHash,
          });
        } catch (error) {
          classificationError = error;
          this.record({
            operation: "startup_classify",
            status: "outside_barrier_failed",
            attempt,
            head: frozen.head,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      try {
        return await gitSingleFlight(this.repo, () => withCanonicalMutationBarrierInSingleFlight(this.repo, async () => {
          // Freeze/scan exceptions also enter the barrier for a stable recheck:
          // drift → retry outside; stable exception → fail-closed.
          if (freezeError) {
            if (freezeError instanceof CanonicalGitRuntimeError && freezeError.code === "STARTUP_CLASSIFY_INPUT_DRIFT") {
              this.recoveryHistoryCache = undefined;
              throw freezeError;
            }
            try {
              const refrozen = await this.freezeStartupClassificationInputs();
              this.recoveryHistoryCache = undefined;
              throw new CanonicalGitRuntimeError(
                "STARTUP_CLASSIFY_INPUT_DRIFT",
                "freeze/scan failed outside barrier but inputs stabilised under barrier; retrying",
                { prior: freezeError instanceof Error ? freezeError.message : String(freezeError), head: refrozen.head },
              );
            } catch (inner) {
              if (inner instanceof CanonicalGitRuntimeError && inner.code === "STARTUP_CLASSIFY_INPUT_DRIFT") {
                this.recoveryHistoryCache = undefined;
                throw inner;
              }
              throw freezeError;
            }
          }

          // Always recheck frozen inputs under the barrier before any
          // fail-closed decision or mutation. Drift releases the barrier
          // (throw STARTUP_CLASSIFY_INPUT_DRIFT) for a bounded outside retry.
          try {
            await this.assertStartupClassificationInputsStable(frozen!);
          } catch (error) {
            this.recoveryHistoryCache = undefined;
            throw error;
          }

          if (classificationError) {
            // Stable inputs + classification failure → fail-closed (no mutation).
            throw classificationError;
          }

          await recoverDeviceJoinJournal({ repo: this.repo });
          // recoverAtStartupUnlocked re-reads head/scan; cache hit keeps the
          // under-barrier window short after the outside classification.
          await this.recoverAtStartupUnlocked();
          const backlog = await this.requestBacklogPreflightUnlocked();
          if (backlog.status === "ready") {
            // Backlog receipts were validated with allowWriterTransaction=false.
            // This early skip avoids needless refreezes; the post-prune guard
            // in requestDrainUnlocked remains authoritative.
            if (isCanonicalMetadataOnlyCohort(backlog.receipts)) {
              this.record({ operation: "startup_backlog", status: "metadata_deferred", receiptCount: backlog.receipts.length });
            } else {
              if (!backlog.receipts.some((receipt) => isCanonicalContentOwner(receipt.owner))) {
                throw new CanonicalGitRuntimeError("STARTUP_CONTENT_AUTHORIZATION_REQUIRED", "startup generation requires validated Knowledge/Constraint L1/L2 content");
              }
              const drained = await this.requestDrainUnlocked(backlog.receipts, "startup-local-drain", "startup_content_backlog");
              if (drained.status !== "index_converged" && drained.status !== "empty" && drained.status !== "metadata_deferred" && drained.status !== "consumed") {
                throw new CanonicalGitRuntimeError("STARTUP_DRAIN_NOT_DURABLE", `startup local drain ended in ${drained.status}: ${drained.reason ?? "no reason"}`, { drained });
              }
            }
          } else if (backlog.status === "blocked") throw new CanonicalGitRuntimeError("STARTUP_BACKLOG_BLOCKED", backlog.reason ?? "backlog preflight blocked");

          // Final post-mutation classification: if head/scan match the frozen
          // inputs the outside result is reused via cache; otherwise classify
          // under the barrier only for the (usually small) residual delta.
          // Large post-mutation reclassify is rare on cold start with empty backlog.
          const finalScan = await scanWholeL1Validated({ abrainHome: this.repo });
          const finalHead = await resolveRef(this.repo, this.options.refName);
          const finalStatusHash = (await statusSnapshot(this.repo)).hash;
          await this.classifyHistoricalRecoveryCached(finalScan, finalHead, finalStatusHash);
          const finalRecovery = recoverOpenRecoveryEpisodesV3FromScan(finalScan);
          if (finalRecovery.quarantined.length) {
            throw new CanonicalGitRuntimeError(
              "RECOVERY_QUARANTINED",
              `active v3 recovery classification failed: ${quarantineReason("v3", finalRecovery.quarantined)}`,
              { protocol: "v3", quarantined: finalRecovery.quarantined },
            );
          }
          this.startupState = "ready";
          this.record({ operation: "startup", status: "local_ready", attempt });
          return this.diagnostics();
        }, barrierOptions));
      } catch (error) {
        if (error instanceof CanonicalMutationBarrierError) {
          // Preserve rejection+eviction semantics for barrier acquisition.
          throw error;
        }
        if (
          error instanceof CanonicalGitRuntimeError
          && error.code === "STARTUP_CLASSIFY_INPUT_DRIFT"
          && attempt < MAX_DRIFT_RETRIES - 1
        ) {
          this.record({
            operation: "startup",
            status: "classify_input_drift_retry",
            attempt,
            reason: error.message,
            detail: error.detail,
          });
          continue;
        }
        this.startupState = "blocked";
        this.blockedReason = error instanceof Error ? error.message : String(error);
        this.ownerAlert = this.blockedReason.includes("owner_alert=true");
        this.record({
          operation: "startup",
          status: "blocked",
          reason: this.blockedReason,
          attempt,
          ...(error instanceof CanonicalGitRuntimeError && error.code === "STARTUP_CLASSIFY_INPUT_DRIFT"
            ? { drift_exhausted: true }
            : {}),
          ...(this.ownerAlert ? { ownerAlert: true } : {}),
        });
        return this.diagnostics();
      }
    }

    this.startupState = "blocked";
    this.blockedReason = "STARTUP_CLASSIFY_INPUT_DRIFT: exceeded bounded recompute attempts";
    this.record({ operation: "startup", status: "blocked", reason: this.blockedReason, drift_exhausted: true });
    return this.diagnostics();
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
    const history = combined.v2;
    const v3History = combined.v3!;
    this.record({ operation: "classify_v2_history", status: "accepted", episodes: history.episodes.length, joins: history.joins.length, consumed: history.consumedEventIds.length, writableFrontierCount: history.writableFrontierCount });
    this.record({ operation: "classify_v3_history", status: "accepted", candidates: v3History.candidates.length, joins: v3History.joins.length, open: v3History.openEpisodeIds.length, terminal: v3History.terminalEpisodeIds.length });
    const recovered = recoverOpenRecoveryEpisodesV3FromScan(scan);
    if (recovered.quarantined.length) throw new CanonicalGitRuntimeError("RECOVERY_QUARANTINED", `active v3 recovery classification failed: ${quarantineReason("v3", recovered.quarantined)}`, { protocol: "v3", quarantined: recovered.quarantined });
    for (const initial of recovered.open) {
      let settled = false;
      for (let step = 0; step < RECOVERY_LANE_BUDGETS.drain * 2 + 2; step += 1) {
        const cursor = recoveryEpisodeCursorV3(initial.episodeId, initial.operation, await readRecoveryEventsV3(this.repo, initial.episodeId));
        if (cursor.complete || cursor.terminal) { settled = true; break; }
        let slot = cursor.pendingSlot;
        if (slot === null) {
          const claim = await claimNextRecoverySlotV3({ abrainHome: this.repo, operation: cursor.operation });
          if (claim.status === "complete" || claim.status === "terminal") { settled = true; break; }
          slot = claim.slot;
        }
        const action = await recoverDrainSlotV3({
          abrainHome: this.repo,
          repo: this.repo,
          operation: cursor.operation,
          slot,
          prePublishCheck: () => this.mutationPreflight(),
          preConvergeCheck: () => preflightSharedIndexLock(this.repo),
        });
        this.record({ operation: "recover_drain_v3", episodeId: cursor.episodeId, slot, action });
      }
      const final = recoveryEpisodeCursorV3(initial.episodeId, initial.operation, await readRecoveryEventsV3(this.repo, initial.episodeId));
      if (!settled && !final.complete && !final.terminal) {
        throw new CanonicalGitRuntimeError("RECOVERY_V3_LIVENESS", "startup could not settle an open v3 episode within its fixed slot budget", { episodeId: initial.episodeId, lastClaimedSlot: final.lastClaimedSlot });
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
  private async recoverMetadataCheckpointIndexUnlocked(): Promise<void> {
    const head = await resolveRef(this.repo, this.options.refName);
    const parentLine = (await git(this.repo, ["rev-list", "--parents", "-n", "1", head], 5_000)).trim().split(/\s+/);
    if (parentLine.length !== 2 || parentLine[0] !== head) return;
    const parent = parentLine[1]!;
    const paths = nulPaths(await gitBuffer(this.repo, ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", parent, head]));
    if (!paths.length) return;

    const scan = await scanWholeL1Validated({ abrainHome: this.repo });
    const records = new Map(scan.all.map((record) => [record.relativePath, record]));
    if (paths.some((rel) => !isRecoveryMetadataRecord(records.get(rel)))) return;
    await this.classifyHistoricalRecoveryCached(scan, head);

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
      if (row.paths.some((rel) => !allowed.has(rel))) {
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
    if (after.rows.length) throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_RECOVERY_INCOMPLETE", "metadata checkpoint index recovery did not restore a clean repository");
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
      refName: this.options.refName,
      candidate: prepared.candidate,
      frozenCommit: prepared.frozenCommit,
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
    if (finalStatus.rows.length) throw new CanonicalGitRuntimeError("DEVICE_JOIN_METADATA_VERIFY_DIRTY", "metadata checkpoint did not leave a clean repository");
    this.record({ operation: "metadata_checkpoint", status: "index_converged", commit: prepared.candidate, cohortSize: prepared.entries.length });
    return prepared.candidate;
  }

  requestBacklogPreflight(): Promise<BacklogPreflightResult> {
    return gitSingleFlight(this.repo, () => this.requestBacklogPreflightUnlocked());
  }

  private async requestBacklogPreflightUnlocked(): Promise<BacklogPreflightResult> {
    if (!this.settings.enabled || !this.settings.valid) return { status: "empty", statusHash: sha256Hex("disabled"), receipts: [], ownership: {} };
    await assertProvenanceFrozen(this.sourceRoot, this.settings.settingsPath, this.loadedProvenance);
    await assertRepoMutationPreflight(this.repo, this.options.refName);
    await preflightSharedIndexLock(this.repo);
    const first = await statusSnapshot(this.repo);
    const ownershipContext = await buildCanonicalOwnershipContext({ abrainHome: this.repo });
    const receipts: ProducedArtifact[] = [];
    const ownership: Record<string, string[]> = { knowledge: [], constraint: [], canonical_path: [] };
    try {
      for (const row of first.rows) {
        const canonicalPath = row.paths.some((item) => item.startsWith("l1/") || item.startsWith("l2/"));
        if (row.x !== " " && row.x !== "?") {
          if (canonicalPath) throw new CanonicalGitRuntimeError("STAGED_DIRTY_BLOCKED", "staged canonical path cannot be inferred by startup ownership", { path: row.path, status: row.status });
          continue;
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
    if (startup.startup === "blocked") return { status: "blocked", localCommit: "not_published", reason: startup.blockedReason, ...(startup.ownerAlert ? { ownerAlert: true } : {}) };
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
        if (row.path.startsWith("l1/") || row.path.startsWith("l2/")) {
          throw new CanonicalGitRuntimeError("STAGED_DIRTY_BLOCKED", "staged canonical path outside the receipt cohort blocks drain", { path: row.path });
        }
        // Exact-cohort convergence preserves unrelated staged entries byte-for-
        // byte; they are intentionally outside this transaction.
        continue;
      }
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
      const action = await recoverDrainSlotV3({
        abrainHome: this.repo,
        repo: this.repo,
        operation,
        slot: claim.slot,
        prePublishCheck: () => this.mutationPreflight(),
        preConvergeCheck: () => preflightSharedIndexLock(this.repo),
      });
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
    let action: Awaited<ReturnType<typeof recoverDrainSlotV3>>;
    try {
      action = await recoverDrainSlotV3({
        abrainHome: this.repo,
        repo: this.repo,
        operation,
        slot: claim.slot,
        prePublishCheck: async () => {
          await this.mutationPreflight();
          for (const item of validated) await readArtifactBytes(this.repo, item.receipt);
        },
        preConvergeCheck: () => preflightSharedIndexLock(this.repo),
      });
    } catch (error) {
      const current = await resolveRef(this.repo, this.options.refName);
      const refPublished = await gitIsAncestor(this.repo, prepared.candidate, current);
      let durablePublishedFact = false;
      try {
        const state = foldRecoveryEventsV3(await readRecoveryEventsV3(this.repo, episodeId)).get(claim.slot);
        durablePublishedFact = !!state?.published && !state.aborted;
      } catch {
        // Candidate ancestry remains an independent irreversible publication
        // fact even when recovery metadata itself is quarantined.
      }
      if (refPublished || durablePublishedFact) {
        const reason = error instanceof Error ? error.message : String(error);
        this.record({ operation: "drain_v3", episodeId, slot: claim.slot, action: "published_pending", candidate: prepared.candidate, cohort: prepared.cohortManifestRoot, reason });
        return { status: "blocked", commit: prepared.candidate, episodeId, slot: claim.slot, localCommit: "published", reason };
      }
      throw error;
    }
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

function canonicalStartupKey(options: CanonicalGitRuntimeOptions): string {
  return JSON.stringify([
    path.resolve(options.abrainHome),
    path.resolve(options.settingsPath ?? defaultSettingsPath()),
    path.resolve(options.sourceRoot ?? path.join(__dirname, "..", "..")),
    options.refName ?? "refs/heads/main",
    options.startupBarrierTimeoutMs ?? null,
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

/** Return the one process-global in-flight/successful startup promise for this
 * runtime. Rejections are evicted so a repaired repo can retry in-process. */
export function getCanonicalStartupPromise(options: CanonicalGitRuntimeOptions): Promise<CanonicalRuntimeDiagnostics> {
  const state = globalState();
  const key = canonicalStartupKey(options);
  const existing = state.startupPromises.get(key);
  if (existing) return existing;
  const created = (async () => (await getCanonicalGitRuntime(options)).awaitStartup())();
  state.startupPromises.set(key, created);
  void created.then(
    (diag) => {
      // blocked is retryable: park forever is forbidden. Evict so the next
      // enqueue / consumer re-entry re-runs startup against a repaired repo.
      if (diag.startup === "blocked" && state.startupPromises.get(key) === created) {
        state.startupPromises.delete(key);
      }
    },
    () => {
      // Identity guard prevents an older rejection from deleting a replacement
      // promise installed for the same key (the promise-cache ABA race).
      if (state.startupPromises.get(key) === created) state.startupPromises.delete(key);
    },
  );
  return created;
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
}): void {
  reportCanonicalStartupState(
    startupConsumerState(options.runtime, options.consumerId),
    options.message,
    options.type,
  );
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
    try {
      diagnostics = await getCanonicalStartupPromise(runtime);
    } catch (error) {
      const latest = state.latest;
      state.latest = undefined;
      reportCanonicalStartupState(
        state,
        latest?.errorMessage(error) ?? `canonical startup threw: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }

    // Repeated /new, /resume, or /reload calls replace a pending continuation.
    // If another session starts while onReady is running, execute the new latest
    // continuation next; no task ever retains a session-bound UI object.
    while (state.latest) {
      const invocation = state.latest;
      state.latest = undefined;
      try {
        if (diagnostics.startup === "ready") await invocation.onReady(diagnostics);
        else {
          await invocation.onBlocked?.(diagnostics);
          reportCanonicalStartupState(state, invocation.blockedMessage(diagnostics), "warning");
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
