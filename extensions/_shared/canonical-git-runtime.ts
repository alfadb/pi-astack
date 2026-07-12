import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  prepareExactCohortCommit,
  refContainsCohort,
  resolveRef,
  snapshotIndexEntries,
  type CohortPlanEntry,
} from "./git-exact-cohort";
import { gitSingleFlight } from "./git-singleflight";
import { parseGitStatusPorcelainV1Z, type GitPorcelainV1Record } from "./git-z-parser";
import {
  claimNextRecoverySlot,
  foldRecoveryEvents,
  readRecoveryEvents,
  recoverDrainSlot,
  recoverOpenRecoveryEpisodes,
  recordDrainPrepared,
  resolveRecoveryEpisode,
} from "./convergence-recovery";
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
export const P1_RESTART_PROBE_ENV = "PI_ASTACK_P1_RESTART_PROBE" as const;
export const CONTROLLED_STOP_AFTER_PREPARED = "CONTROLLED_STOP_AFTER_PREPARED" as const;
const P1_RESTART_PROBE_VERSION = 1 as const;
const P1_RESTART_PROBE_BOUNDARY = "commit_prepared" as const;
const P1_RESTART_PROBE_MAX_LIFETIME_MS = 15 * 60 * 1_000;
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface P1RestartProbe {
  version: typeof P1_RESTART_PROBE_VERSION;
  runId: string;
  boundary: typeof P1_RESTART_PROBE_BOUNDARY;
  expectedHead: string;
  expiresAtUtc: string;
  expiresAtMs: number;
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
  loadedProvenance: readonly LoadedProvenanceEntry[];
  implementationFingerprint: string;
  tail: readonly Record<string, unknown>[];
}

export interface BacklogPreflightResult {
  status: "ready" | "empty" | "blocked";
  statusHash: string;
  receipts: readonly ProducedArtifact[];
  ownership: Readonly<Record<string, readonly string[]>>;
  reason?: string;
}

export interface DrainResult {
  status: "disabled" | "empty" | "blocked" | "index_converged" | "consumed";
  commit?: string;
  candidate?: string;
  episodeId?: string;
  slot?: number;
  localCommit: "not_published" | "published" | "index_converged";
  reason?: string;
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

export interface CanonicalGitRuntimeOptions {
  abrainHome: string;
  settingsPath?: string;
  sourceRoot?: string;
  refName?: string;
}

export interface CanonicalGitRuntime {
  awaitStartup(): Promise<CanonicalRuntimeDiagnostics>;
  recoverAtStartup(): Promise<void>;
  requestDrain(receipts: readonly ProducedArtifact[], message?: string): Promise<DrainResult>;
  requestBacklogPreflight(): Promise<BacklogPreflightResult>;
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
  consumedP1RestartProbeRunIds: Set<string>;
}

function globalState(): GlobalRuntimeState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[GLOBAL_KEY] as Partial<GlobalRuntimeState> | undefined;
  if (!existing) {
    const created: GlobalRuntimeState = { apiVersion: API_VERSION, runtimes: new Map(), consumedP1RestartProbeRunIds: new Set() };
    global[GLOBAL_KEY] = created;
    return created;
  }
  if (existing.apiVersion !== API_VERSION || !(existing.runtimes instanceof Map)) {
    throw new CanonicalGitRuntimeError("RUNTIME_SINGLETON_SPLIT", "incompatible process-global canonical runtime singleton");
  }
  if (!(existing.consumedP1RestartProbeRunIds instanceof Set)) existing.consumedP1RestartProbeRunIds = new Set();
  return existing as GlobalRuntimeState;
}

function parseP1RestartProbe(raw: string | undefined, nowMs = Date.now()): P1RestartProbe | undefined {
  if (raw === undefined) return undefined;
  const fail = (message: string): never => {
    throw new CanonicalGitRuntimeError("P1_RESTART_PROBE_INVALID", `${P1_RESTART_PROBE_ENV} ${message}`);
  };
  if (!raw || raw.includes("\n") || raw.includes("\r")) fail("must be one non-empty JSON line");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
  const probe = value as Record<string, unknown>;
  const expectedKeys = ["version", "runId", "boundary", "expectedHead", "expiresAtUtc"];
  if (Object.keys(probe).join("\0") !== expectedKeys.join("\0")) fail(`must have exact ordered keys ${expectedKeys.join("/")}`);
  if (probe.version !== P1_RESTART_PROBE_VERSION) fail(`version must be ${P1_RESTART_PROBE_VERSION}`);
  const runId = typeof probe.runId === "string" && RUN_ID_PATTERN.test(probe.runId)
    ? probe.runId
    : fail("runId must be a canonical lowercase UUID");
  if (probe.boundary !== P1_RESTART_PROBE_BOUNDARY) fail(`boundary must be ${P1_RESTART_PROBE_BOUNDARY}`);
  const expectedHead = typeof probe.expectedHead === "string" && OID_PATTERN.test(probe.expectedHead)
    ? probe.expectedHead
    : fail("expectedHead must be a lowercase 40- or 64-hex Git OID");
  const expiresAtUtc = typeof probe.expiresAtUtc === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(probe.expiresAtUtc)
    ? probe.expiresAtUtc
    : fail("expiresAtUtc must be canonical UTC with milliseconds");
  const expiresAtMs = Date.parse(expiresAtUtc);
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== expiresAtUtc) fail("expiresAtUtc is invalid");
  if (expiresAtMs <= nowMs) fail("is expired");
  if (expiresAtMs - nowMs > P1_RESTART_PROBE_MAX_LIFETIME_MS) fail("expiresAtUtc must be no more than 15 minutes in the future");
  if (JSON.stringify({ version: P1_RESTART_PROBE_VERSION, runId, boundary: P1_RESTART_PROBE_BOUNDARY, expectedHead, expiresAtUtc }) !== raw) {
    fail("must use the exact compact schema encoding");
  }
  return Object.freeze({ version: P1_RESTART_PROBE_VERSION, runId, boundary: P1_RESTART_PROBE_BOUNDARY, expectedHead, expiresAtUtc, expiresAtMs });
}

function assertP1RestartProbeFresh(probe: P1RestartProbe, nowMs = Date.now()): void {
  if (probe.expiresAtMs <= nowMs) {
    throw new CanonicalGitRuntimeError("P1_RESTART_PROBE_EXPIRED", `${P1_RESTART_PROBE_ENV} expired before the prepared boundary`, { runId: probe.runId, expiresAtUtc: probe.expiresAtUtc });
  }
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
    ["git-z-parser", path.join(sourceRoot, "extensions/_shared/git-z-parser.ts")],
    ["recovery", path.join(sourceRoot, "extensions/_shared/convergence-recovery.ts")],
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
  if (rel === "l2/views/constraint/latest/compiled-view.md") return "constraint_l2";
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

function knowledgeIdentityFromL2Path(rel: string): string {
  const prefix = "l2/views/knowledge/latest/";
  if (!rel.startsWith(prefix) || !rel.endsWith(".md")) throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_PATH", "unexpected knowledge L2 path", { rel });
  const parts = rel.slice(prefix.length, -3).split("/");
  if (parts.length === 2 && parts[0] === "world") return `world::${parts[1]}`;
  if (parts.length === 3 && parts[0] === "projects") return `project:${parts[1]}:${parts[2]}`;
  throw new CanonicalGitRuntimeError("KNOWLEDGE_L2_PATH", "knowledge L2 path does not encode a canonical identity", { rel });
}

function nulPaths(buffer: Buffer): string[] {
  return buffer.toString("utf-8").split("\0").filter(Boolean);
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

  const projections = scan.selected.filter((record) => record.registration.envelope_schema === "constraint-projection-envelope/v1");
  projections.sort((left, right) => {
    const leftAt = String(left.body.created_at_utc ?? "");
    const rightAt = String(right.body.created_at_utc ?? "");
    return compareAscii(rightAt, leftAt) || compareAscii(right.eventId, left.eventId);
  });
  let constraint: CanonicalOwnershipContext["_constraint"];
  if (projections.length) {
    const latest = projections[0]!;
    const projection = await import("../sediment/constraint-compiler/projection");
    const render = await import("../sediment/constraint-compiler/render");
    const decision = projection.normalizeDecisionForProjection(latest.body.validated_decision as never) as never;
    const rendered = render.renderConstraintL2View(decision, latest.eventId);
    const sourceIds = Array.from(new Set([
      latest.eventId,
      ...(Array.isArray(latest.body.input_event_ids) ? latest.body.input_event_ids : []),
      ...(Array.isArray(latest.body.causal_parents) ? latest.body.causal_parents : []),
    ].filter((value): value is string => typeof value === "string"))).sort(compareAscii);
    constraint = { sourceIds: Object.freeze(sourceIds), markdown: rendered.markdown, projectionEventId: latest.eventId };
  }

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
  if (rel !== "l2/views/knowledge/latest/manifest.json") throw new CanonicalGitRuntimeError("KNOWLEDGE_MANIFEST_PATH", "unexpected knowledge manifest path", { rel });
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
  if (rel !== "l2/views/constraint/latest/compiled-view.md") throw new CanonicalGitRuntimeError("CONSTRAINT_L2_PATH", "unexpected constraint L2 path", { rel });
  if (context?._constraint) {
    if (!bytes.equals(Buffer.from(context._constraint.markdown, "utf-8"))) {
      throw new CanonicalGitRuntimeError("CONSTRAINT_L2_MISMATCH", "constraint L2 is not byte-equal to latest projection decision", { rel, eventId: context._constraint.projectionEventId });
    }
    return context._constraint.sourceIds;
  }
  const scan = await scanWholeL1Validated({ abrainHome: repo, domains: ["constraint"], roles: ["canonical"] });
  const projections = scan.selected.filter((record) => record.registration.envelope_schema === "constraint-projection-envelope/v1");
  if (projections.length === 0) throw new CanonicalGitRuntimeError("CONSTRAINT_L2_UNOWNED", "constraint L2 has no committed-or-worktree projection decision");
  projections.sort((left, right) => {
    const leftAt = String(left.body.created_at_utc ?? "");
    const rightAt = String(right.body.created_at_utc ?? "");
    return compareAscii(rightAt, leftAt) || compareAscii(right.eventId, left.eventId);
  });
  const latest = projections[0]!;
  const projection = await import("../sediment/constraint-compiler/projection");
  const render = await import("../sediment/constraint-compiler/render");
  const decision = projection.normalizeDecisionForProjection(latest.body.validated_decision as never) as never;
  const rendered = render.renderConstraintL2View(decision, latest.eventId);
  if (!bytes.equals(Buffer.from(rendered.markdown, "utf-8"))) {
    throw new CanonicalGitRuntimeError("CONSTRAINT_L2_MISMATCH", "constraint L2 is not byte-equal to latest projection decision", { rel, eventId: latest.eventId });
  }
  return Object.freeze([latest.eventId]);
}

function assertP1RestartProbeSource(
  probe: P1RestartProbe,
  validated: readonly { receipt: ProducedArtifact; content?: Buffer }[],
  context: CanonicalOwnershipContext,
): void {
  const knowledgeSources: Array<{ eventId: string; sourceRef: string | null; newlyProduced: boolean }> = [];
  for (const item of validated) {
    if (item.receipt.owner !== "knowledge_l1" || !item.content) continue;
    const envelope = JSON.parse(item.content.toString("utf-8")) as Record<string, any>;
    const body = envelope.body as Record<string, any>;
    const producer = body?.producer;
    const sourceRef = body?.source?.source_ref;
    const eventId = path.basename(item.receipt.path, ".json");
    const newlyProduced = !context.headPaths.has(item.receipt.path);
    knowledgeSources.push({ eventId, sourceRef: typeof sourceRef === "string" ? sourceRef : null, newlyProduced });
    if (
      newlyProduced
      && producer?.name === "sediment.knowledge-event-writer"
      && typeof sourceRef === "string"
      && sourceRef.startsWith("sediment:auto_write:")
    ) return;
  }
  throw new CanonicalGitRuntimeError(
    "P1_RESTART_PROBE_SOURCE_MISMATCH",
    `${P1_RESTART_PROBE_ENV} requires a newly produced active Knowledge L1 receipt from sediment:auto_write`,
    { runId: probe.runId, knowledgeSources },
  );
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
  } else if (receipt.path === "l2/views/knowledge/latest/manifest.json") {
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
  private frozenOwnershipContext?: { statusHash: string; context: CanonicalOwnershipContext };
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

  diagnostics(): CanonicalRuntimeDiagnostics {
    return Object.freeze({
      apiVersion: API_VERSION,
      repo: this.repo,
      settings: this.settings,
      startup: this.startupState,
      ...(this.blockedReason ? { blockedReason: this.blockedReason } : {}),
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

  awaitStartup(): Promise<CanonicalRuntimeDiagnostics> {
    if (!this.startupPromise) {
      this.startupPromise = gitSingleFlight(this.repo, async () => {
        if (!this.settings.enabled || !this.settings.valid) {
          this.startupState = "ready";
          this.record({ operation: "startup", status: "legacy_boundary", reason: this.settings.reason });
          return this.diagnostics();
        }
        this.startupState = "running";
        this.blockedReason = undefined;
        try {
          await this.recoverAtStartupUnlocked();
          const backlog = await this.requestBacklogPreflightUnlocked();
          if (backlog.status === "ready") {
            const drained = await this.requestDrainUnlocked(backlog.receipts, "startup-local-drain", false);
            if (drained.status !== "index_converged" && drained.status !== "empty" && drained.status !== "consumed") throw new CanonicalGitRuntimeError("STARTUP_DRAIN_NOT_DURABLE", `startup local drain ended in ${drained.status}`, { drained });
          } else if (backlog.status === "blocked") throw new CanonicalGitRuntimeError("STARTUP_BACKLOG_BLOCKED", backlog.reason ?? "backlog preflight blocked");
          const finalRecovery = await recoverOpenRecoveryEpisodes(this.repo);
          if (finalRecovery.quarantined.length) throw new CanonicalGitRuntimeError("RECOVERY_QUARANTINED", "active v2 recovery is malformed", { episodes: finalRecovery.quarantined.map((item) => item.episodeId) });
          if (finalRecovery.terminal.length) throw new CanonicalGitRuntimeError("OWNER_INTERVENTION_REQUIRED", "active v2 terminal is absorbing for the current generation", { episodes: finalRecovery.terminal.map((item) => item.episodeId) });
          this.startupState = "ready";
          this.record({ operation: "startup", status: "local_ready" });
        } catch (error) {
          this.startupState = "blocked";
          this.blockedReason = error instanceof Error ? error.message : String(error);
          this.record({ operation: "startup", status: "blocked", reason: this.blockedReason });
        }
        return this.diagnostics();
      });
    }
    return this.startupPromise;
  }

  async recoverAtStartup(): Promise<void> {
    return gitSingleFlight(this.repo, () => this.recoverAtStartupUnlocked());
  }

  private async recoverAtStartupUnlocked(): Promise<void> {
    await this.mutationPreflight();
    const recovered = await recoverOpenRecoveryEpisodes(this.repo);
    if (recovered.quarantined.length) throw new CanonicalGitRuntimeError("RECOVERY_QUARANTINED", "active v2 recovery is malformed", { episodes: recovered.quarantined.map((item) => item.episodeId) });
    if (recovered.terminal.length) throw new CanonicalGitRuntimeError("OWNER_INTERVENTION_REQUIRED", "active v2 terminal is absorbing for the current generation", { episodes: recovered.terminal.map((item) => item.episodeId) });
    for (const cursor of recovered.open) {
      if (cursor.pendingSlot === null) continue;
      const action = await recoverDrainSlot({
        abrainHome: this.repo,
        repo: this.repo,
        symbolicRef: this.options.refName,
        episodeId: cursor.episodeId,
        slot: cursor.pendingSlot,
        prePublishCheck: () => this.mutationPreflight(),
        preConvergeCheck: () => preflightSharedIndexLock(this.repo),
      });
      this.record({ operation: "recover_drain", episodeId: cursor.episodeId, slot: cursor.pendingSlot, action });
    }
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
    // This is the only probe env read. Startup/recovery/backlog paths call the
    // unlocked method directly and never observe or consume the probe.
    const probe = parseP1RestartProbe(process.env[P1_RESTART_PROBE_ENV]);
    if (probe) {
      if (globalState().consumedP1RestartProbeRunIds.has(probe.runId)) {
        return { status: "blocked", localCommit: "not_published", reason: "P1_RESTART_PROBE_RUN_ALREADY_CONSUMED" };
      }
      if (this.startupState !== "ready") {
        throw new CanonicalGitRuntimeError("P1_RESTART_PROBE_STEADY_STATE_REQUIRED", `${P1_RESTART_PROBE_ENV} may be armed only after startup is ready`, { runId: probe.runId, startup: this.startupState });
      }
    }
    const startup = probe ? this.diagnostics() : await this.awaitStartup();
    if (startup.startup === "blocked") return { status: "blocked", localCommit: "not_published", reason: startup.blockedReason };
    return gitSingleFlight(this.repo, () => this.requestDrainUnlocked(receipts, message, true, probe));
  }

  private async requestDrainUnlocked(receipts: readonly ProducedArtifact[], message: string, allowNextGeneration: boolean, probe?: P1RestartProbe): Promise<DrainResult> {
    if (probe && !allowNextGeneration) throw new CanonicalGitRuntimeError("P1_RESTART_PROBE_PATH_INVALID", "restart probe reached a non-steady-state drain path");
    if (probe && globalState().consumedP1RestartProbeRunIds.has(probe.runId)) {
      return { status: "blocked", localCommit: "not_published", reason: "P1_RESTART_PROBE_RUN_ALREADY_CONSUMED" };
    }
    if (!this.settings.enabled || !this.settings.valid) return { status: "disabled", localCommit: "not_published" };
    await this.mutationPreflight();
    if (probe) {
      assertP1RestartProbeFresh(probe);
      const currentHead = await resolveRef(this.repo, this.options.refName);
      if (currentHead !== probe.expectedHead) {
        throw new CanonicalGitRuntimeError("P1_RESTART_PROBE_HEAD_MISMATCH", `${P1_RESTART_PROBE_ENV} expectedHead does not match the current symbolic ref`, { runId: probe.runId, expectedHead: probe.expectedHead, currentHead });
      }
    }
    const seen = new Set<string>();
    const currentStatus = await statusSnapshot(this.repo);
    const frozen = this.frozenOwnershipContext;
    this.frozenOwnershipContext = undefined;
    const ownershipContext = frozen?.statusHash === currentStatus.hash
      ? frozen.context
      : await buildCanonicalOwnershipContext({ abrainHome: this.repo });
    const validated: Array<{ receipt: ProducedArtifact; content?: Buffer }> = [];
    for (const input of receipts) {
      if (seen.has(input.path)) throw new CanonicalGitRuntimeError("RECEIPT_DUPLICATE", "duplicate artifact receipt", { path: input.path });
      seen.add(input.path);
      validated.push(await validateReceipt(this.repo, input, true, ownershipContext));
    }
    if (probe) assertP1RestartProbeSource(probe, validated, ownershipContext);
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
    if (probe) {
      assertP1RestartProbeFresh(probe);
      if (frozenCommit !== probe.expectedHead) {
        throw new CanonicalGitRuntimeError("P1_RESTART_PROBE_HEAD_MISMATCH", `${P1_RESTART_PROBE_ENV} expectedHead changed during the ownership freeze`, { runId: probe.runId, expectedHead: probe.expectedHead, currentHead: frozenCommit });
      }
    }
    const rawPlan: CohortPlanEntry[] = validated.map(({ receipt, content }) => receipt.op === "delete"
      ? { path: receipt.path, op: "delete" }
      : { path: receipt.path, op: "put", mode: receipt.mode!, content: content! });
    const plan = await pruneNoops(this.repo, frozenCommit, rawPlan);
    if (!plan.length) return { status: "empty", commit: frozenCommit, localCommit: "not_published" };
    const frozenIndexSnapshot = await snapshotIndexEntries(this.repo, plan.map((entry) => entry.path));
    if (probe) assertP1RestartProbeFresh(probe);
    const episode = await resolveRecoveryEpisode({ abrainHome: this.repo, symbolicRef: this.options.refName, allowNextGeneration });
    const claim = await claimNextRecoverySlot({ abrainHome: this.repo, episodeId: episode.episodeId, lane: "drain" });
    if (!claim.shouldExecute || claim.slot === null) return { status: "consumed", episodeId: episode.episodeId, slot: claim.slot ?? undefined, localCommit: "not_published", reason: claim.status };
    await preflightSharedIndexLock(this.repo);
    const prepared = await prepareExactCohortCommit({ repo: this.repo, refName: this.options.refName, frozenCommit, plan, message });
    await recordDrainPrepared({ abrainHome: this.repo, episodeId: episode.episodeId, slot: claim.slot, prepared, frozenIndexSnapshot });
    if (probe) {
      globalState().consumedP1RestartProbeRunIds.add(probe.runId);
      this.record({ operation: "drain", action: "controlled_stop_after_prepared", runId: probe.runId, episodeId: episode.episodeId, slot: claim.slot, candidate: prepared.candidate, cohort: prepared.cohortManifestRoot });
      return {
        status: "blocked",
        candidate: prepared.candidate,
        episodeId: episode.episodeId,
        slot: claim.slot,
        localCommit: "not_published",
        reason: CONTROLLED_STOP_AFTER_PREPARED,
      };
    }
    let action: Awaited<ReturnType<typeof recoverDrainSlot>>;
    try {
      action = await recoverDrainSlot({
        abrainHome: this.repo,
        repo: this.repo,
        symbolicRef: this.options.refName,
        episodeId: episode.episodeId,
        slot: claim.slot,
        prePublishCheck: async () => {
          await this.mutationPreflight();
          for (const item of validated) await readArtifactBytes(this.repo, item.receipt);
        },
        preConvergeCheck: () => preflightSharedIndexLock(this.repo),
      });
    } catch (error) {
      const current = await resolveRef(this.repo, this.options.refName);
      const refPublished = await gitIsAncestor(this.repo, prepared.candidate, current)
        || await refContainsCohort(this.repo, this.options.refName, prepared.entries);
      let durablePublishedFact = false;
      try {
        const state = foldRecoveryEvents(await readRecoveryEvents(this.repo, episode.episodeId, "drain")).get(claim.slot);
        durablePublishedFact = !!state?.published && !state.aborted;
      } catch {
        // Ref/cohort containment below remains an independent irreversible
        // publication fact even when recovery metadata itself is quarantined.
      }
      if (refPublished || durablePublishedFact) {
        const reason = error instanceof Error ? error.message : String(error);
        this.record({ operation: "drain", episodeId: episode.episodeId, slot: claim.slot, action: "published_pending", candidate: prepared.candidate, cohort: prepared.cohortManifestRoot, reason });
        return { status: "blocked", commit: prepared.candidate, episodeId: episode.episodeId, slot: claim.slot, localCommit: "published", reason };
      }
      throw error;
    }
    this.record({ operation: "drain", episodeId: episode.episodeId, slot: claim.slot, action, candidate: prepared.candidate, cohort: prepared.cohortManifestRoot });
    if (action !== "index_converged" && action !== "already_complete") return { status: "blocked", episodeId: episode.episodeId, slot: claim.slot, localCommit: "not_published", reason: action };
    return { status: "index_converged", commit: await resolveRef(this.repo, this.options.refName), episodeId: episode.episodeId, slot: claim.slot, localCommit: "index_converged" };
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

export async function awaitCanonicalGitStartup(options: CanonicalGitRuntimeOptions): Promise<CanonicalRuntimeDiagnostics> {
  return (await getCanonicalGitRuntime(options)).awaitStartup();
}

export async function requestCanonicalDrain(options: CanonicalGitRuntimeOptions & { receipts: readonly ProducedArtifact[]; message?: string }): Promise<DrainResult> {
  return (await getCanonicalGitRuntime(options)).requestDrain(options.receipts, options.message);
}
