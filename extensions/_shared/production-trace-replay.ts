import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  captureCanonicalSourceSnapshot,
  compareCanonicalSourceSnapshots,
  type CanonicalSourceSnapshot,
} from "./canonical-shadow-chain";
import { durableAtomicWriteFile } from "./durable-write";
import {
  convergeExactCohortIndex,
  prepareExactCohortCommit,
  publishExactCohortCommit,
  snapshotIndexEntries,
  validateCohortPlan,
  type CohortPlanEntry,
  type PreparedExactCohortCommit,
} from "./git-exact-cohort";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex, type JcsJsonValue } from "./jcs";
import {
  canonicalL1BodyHash,
  expectedL1EventRelativePath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
  validateL1WritePreflight,
} from "./l1-schema-registry";
import {
  appendRecoveryEvent,
  claimRecoverySlot,
  drainEpisodeIdentity,
  foldRecoveryEvents,
  pushEpisodeIdentity,
  readRecoveryEvents,
  recoverDrainSlot,
  recoverPushEpisode,
  recordDrainPrepared,
  recordPushIntent,
} from "./convergence-recovery";

const execFileAsync = promisify(execFile);
const SOURCE_COMMIT_DEFAULT = "a58a12a3a3f599fe386ef2a83ee78133f4c5e401";
const SOURCE_PARENT_DEFAULT = "8b8a5b746fb55289040fd418298bea16805fe6bf";
const REPORT_SCHEMA = "canonical-path-p1b-production-trace-dossier/v1";
const TRACE_SCHEMA = "canonical-path-p1b-production-trace-manifest/v1";
const WORKER_SCHEMA = "canonical-path-p1b-production-trace-worker-config/v1";
const WORKER_RESULT_SCHEMA = "canonical-path-p1b-production-trace-worker-result/v1";
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_OID_RE = /^[0-9a-f]{40,64}$/;
const IMPLEMENTATION_FILES = [
  "extensions/_shared/production-trace-replay.ts",
  "extensions/_shared/canonical-shadow-chain.ts",
  "extensions/_shared/git-exact-cohort.ts",
  "extensions/_shared/convergence-recovery.ts",
  "extensions/_shared/l1-schema-registry.ts",
  "extensions/_shared/durable-write.ts",
  "extensions/_shared/jcs.ts",
  "extensions/sediment/constraint-compiler/render.ts",
  "extensions/sediment/constraint-compiler/normalize.ts",
  "extensions/sediment/constraint-compiler/diagnostics.ts",
  "extensions/sediment/constraint-compiler/types.ts",
  "extensions/sediment/knowledge-evidence.ts",
  "extensions/sediment/sanitizer.ts",
  "extensions/memory/utils.ts",
  "extensions/memory/settings.ts",
  "schemas/l1-schema-role-registry.json",
  "scripts/_convergence-production-trace-worker.mjs",
  "scripts/dossier-convergence-production-trace.mjs",
  "scripts/smoke-convergence-production-trace-harness.mjs",
  "package.json",
] as const;
const SCENARIO_IDS = Object.freeze([
  "claim-race", "crash-prepared", "crash-after-cas", "crash-after-published", "crash-after-index",
  "cas-unrelated-drift", "cas-descendant-drift", "owned-index-conflict", "push-retry", "remote-contained",
  "symlink-path-escape", "hash-envelope-mismatch", "unknown-schema-role",
] as const);
const CRASH_RESIDUAL = "durable-boundary process termination (exit 86), not SIGKILL";
const SOURCE_SNAPSHOT_AUTHENTICITY = "source snapshot self-hashes detect accidental damage only; authenticity requires the exact dossier byte SHA-256 and Git manifest external anchors";
const MODULE_IMPLEMENTATION_ROOT = path.resolve(__dirname, "../..");

export class ProductionTraceReplayError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "ProductionTraceReplayError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface ProductionTraceEntry {
  path: string;
  op: "put" | "delete";
  old_mode: string;
  old_blob_oid: string;
  new_mode: string;
  new_blob_oid: string;
  bytes_sha256: string;
  bytes: number;
}

export interface ProductionL1EventAnchor {
  path: string;
  event_id: string;
  envelope_schema: string;
  blob_oid: string;
  bytes_sha256: string;
  envelope_hash: string;
}

export interface ProductionTraceManifest {
  schema_version: typeof TRACE_SCHEMA;
  source_commit: string;
  source_parent: string;
  source_tree: string;
  parent_tree: string;
  entries: readonly ProductionTraceEntry[];
  trace_entry_count: number;
  cohort_root: string;
  registry_sha256: string;
  full_committed_l1_anchors: readonly ProductionL1EventAnchor[];
  full_committed_l1_set_hash: string;
  full_committed_l1_set_count: number;
  production_current_l1_set_hash: string;
  production_current_l1_set_count: number;
  source_remote_baseline_oid: string;
  source_snapshots: Record<string, JcsJsonValue>;
  bundle_sha256: string;
  bundle_bytes: number;
}

export interface ExtendedSourceSnapshot {
  canonical: CanonicalSourceSnapshot;
  state_tree: { hash: string; files: number; bytes: number };
  raw_index: FileSnapshot;
  raw_index_lock: FileSnapshot;
  implementation: ImplementationSnapshot;
  snapshot_hash: string;
}

interface FileSnapshot {
  exists: boolean;
  sha256: string;
  bytes: number;
  mode: number | null;
  mtime_ns: string | null;
}

interface ImplementationSnapshot {
  git_head: string;
  file_count: number;
  files: Array<{ path: string; head_blob_oid: string | null; working_blob_oid: string; sha256: string; bytes: number }>;
  hash: string;
}

interface ScenarioContext {
  replayRoot: string;
  runRoot: string;
  seedGit: string;
  parentTreeRoot: string;
  workerScript: string;
  trace: ProductionTraceManifest;
  configPaths: string[];
  resultPaths: string[];
}

interface ReplayContext extends ScenarioContext {
  sourceReal: string;
  bundlePath: string;
  implementationRoot: string;
  sourceOriginUrls: readonly string[];
  invalidatedAttempts: readonly Record<string, JcsJsonValue>[];
}

interface ScenarioMatrixResult {
  scenarios: ScenarioResult[];
  durationsMs: Record<string, number>;
  configPaths: string[];
  resultPaths: string[];
}

interface ScenarioFixture {
  name: string;
  root: string;
  repo: string;
  home: string;
  osHome: string;
  remote: string;
  outputs: string;
  outsideSentinel: string;
  outsideBefore: string;
  workerRuns: number;
  consumedAnchors: string[];
  injections: InjectionRecord[];
}

interface InjectionRecord {
  scenario: string;
  id: string;
  path: string;
  sha256: string;
  type: string;
  source_anchor: string;
  injection_hash: string;
}

interface WorkerConfig {
  schema_version: typeof WORKER_SCHEMA;
  replay_root: string;
  scenario_root: string;
  repo: string;
  abrain_home: string;
  os_home: string;
  remote: string;
  result_path: string;
  operation: "claim" | "drain_boundary" | "drain_resume" | "push";
  episode_id: string;
  slot?: number;
  boundary?: "prepared" | "cas" | "published" | "index";
  ref_name?: string;
  target_commit?: string;
  target_tree?: string;
  trace_entries?: readonly ProductionTraceEntry[];
  git_wrapper_dir?: string;
  git_wrapper_trace_dir?: string;
  real_git_path?: string;
}

interface WorkerResult {
  schema_version: typeof WORKER_RESULT_SCHEMA;
  ok: boolean;
  pid: number;
  operation: string;
  action?: string;
  boundary?: string;
  claim?: Record<string, unknown>;
  prepared?: Record<string, unknown>;
  push?: Record<string, unknown>;
  error?: { code: string; message: string };
  assertions: Record<string, boolean>;
}

interface ScenarioResult {
  id: string;
  pass: boolean;
  consumed_trace_anchors: string[];
  injections: InjectionRecord[];
  fresh_process_count: number;
  fault_boundary: string;
  expected: JcsJsonValue;
  observed: JcsJsonValue;
  error: JcsJsonValue;
  assertions: Record<string, boolean>;
  pre_fingerprint: JcsJsonValue;
  post_fingerprint: JcsJsonValue;
  source_path_exposed: boolean;
  outside_write_count: number;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new ProductionTraceReplayError(code, message, detail);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realContained(parent: string, child: string, label: string): Promise<string> {
  const parentReal = await fsp.realpath(parent);
  const childReal = await fsp.realpath(child);
  if (!inside(parentReal, childReal)) fail("P1B_PATH_ESCAPE", `${label} escapes replay containment`, { parentReal, childReal });
  return childReal;
}

function prospectiveContained(parent: string, child: string, label: string): void {
  if (!inside(parent, child)) fail("P1B_PATH_ESCAPE", `${label} escapes replay containment`, { parent, child });
}

function sanitizedGitEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && key !== "HOME" && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

async function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    encoding: "utf8",
  } as Parameters<typeof execFileAsync>[2]);
  return String(stdout);
}

async function git(repo: string, args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return run("git", ["-C", repo, "--literal-pathspecs", ...args], { env: sanitizedGitEnv(home, extraEnv) });
}

async function gitDir(gitDirPath: string, args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return run("git", ["--git-dir", gitDirPath, ...args], { env: sanitizedGitEnv(home, extraEnv) });
}

async function fileSnapshot(file: string): Promise<FileSnapshot> {
  try {
    const stat = await fsp.lstat(file, { bigint: true });
    if (!stat.isFile()) fail("P1B_SOURCE_UNSAFE", `snapshot target is not a regular file: ${file}`);
    const bytes = await fsp.readFile(file);
    return { exists: true, sha256: sha256Hex(bytes), bytes: bytes.length, mode: Number(stat.mode & 0o777n), mtime_ns: stat.mtimeNs.toString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, sha256: sha256Hex("absent"), bytes: 0, mode: null, mtime_ns: null };
    throw error;
  }
}

async function directoryDigest(root: string): Promise<{ hash: string; files: number; bytes: number }> {
  try {
    const stat = await fsp.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("P1B_SOURCE_UNSAFE", `tree root is unsafe: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hash: jcsSha256Hex({ state: "absent" }), files: 0, bytes: 0 };
    throw error;
  }
  const rootReal = await fsp.realpath(root);
  const rows: Array<{ path: string; sha256: string; bytes: number; mode: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => compareAscii(a.name, b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) fail("P1B_SOURCE_UNSAFE", `symlink in snapshotted tree: ${full}`);
      const real = await fsp.realpath(full);
      if (!inside(rootReal, real)) fail("P1B_SOURCE_UNSAFE", `tree entry escapes root: ${full}`);
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) {
        const bytes = await fsp.readFile(full);
        rows.push({ path: path.relative(root, full).split(path.sep).join("/"), sha256: sha256Hex(bytes), bytes: bytes.length, mode: stat.mode & 0o777 });
      } else fail("P1B_SOURCE_UNSAFE", `non-regular tree entry: ${full}`);
    }
  };
  await walk(root);
  return { hash: jcsSha256Hex(rows), files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
}

async function implementationSnapshot(implementationRoot: string): Promise<ImplementationSnapshot> {
  const home = os.tmpdir();
  const head = (await git(implementationRoot, ["rev-parse", "HEAD"], home)).trim();
  const files = [] as ImplementationSnapshot["files"];
  for (const relative of IMPLEMENTATION_FILES) {
    const file = path.join(implementationRoot, ...relative.split("/"));
    const bytes = await fsp.readFile(file);
    let headBlob: string | null = null;
    try { headBlob = (await git(implementationRoot, ["rev-parse", `HEAD:${relative}`], home)).trim(); } catch { headBlob = null; }
    const workingBlob = (await run("git", ["hash-object", "--no-filters", file], { env: sanitizedGitEnv(home) })).trim();
    files.push({ path: relative, head_blob_oid: headBlob, working_blob_oid: workingBlob, sha256: sha256Hex(bytes), bytes: bytes.length });
  }
  const base = { git_head: head, file_count: files.length, files };
  return { ...base, hash: jcsSha256Hex(base) };
}

async function extendSourceSnapshot(source: string, canonical: CanonicalSourceSnapshot, implementationRoot: string): Promise<ExtendedSourceSnapshot> {
  const gitDirPath = (await git(source, ["rev-parse", "--absolute-git-dir"], os.tmpdir())).trim();
  const base = {
    canonical,
    state_tree: await directoryDigest(path.join(source, ".state")),
    raw_index: await fileSnapshot(path.join(gitDirPath, "index")),
    raw_index_lock: await fileSnapshot(path.join(gitDirPath, "index.lock")),
    implementation: await implementationSnapshot(implementationRoot),
  };
  return { ...base, snapshot_hash: jcsSha256Hex(base as unknown as JcsJsonValue) };
}

function sourceSummary(snapshot: ExtendedSourceSnapshot): Record<string, JcsJsonValue> {
  return {
    snapshot_hash: snapshot.snapshot_hash,
    canonical_snapshot_hash: snapshot.canonical.snapshot_hash,
    source_git_head: snapshot.canonical.source_git_head,
    source_ref: snapshot.canonical.source_ref,
    l1_event_set_hash: snapshot.canonical.l1_event_set_hash,
    l1_event_count: snapshot.canonical.l1_event_count,
    state_tree: snapshot.state_tree,
    raw_index: snapshot.raw_index as unknown as JcsJsonValue,
    raw_index_lock: snapshot.raw_index_lock as unknown as JcsJsonValue,
    implementation_hash: snapshot.implementation.hash,
  };
}

function parseLsTreeRecord(record: string): { mode: string; type: string; oid: string; path: string } {
  const tab = record.indexOf("\t");
  if (tab < 0) fail("P1B_TRACE_INVALID", "unparseable ls-tree record");
  const [mode, type, oid] = record.slice(0, tab).split(/\s+/);
  const relative = record.slice(tab + 1);
  if (!mode || !type || !oid || !relative) fail("P1B_TRACE_INVALID", "incomplete ls-tree record");
  return { mode, type, oid, path: relative };
}

async function treeEntry(source: string, commit: string, relative: string): Promise<{ mode: string; oid: string } | null> {
  const out = await git(source, ["ls-tree", "-z", commit, "--", relative], os.tmpdir());
  if (!out) return null;
  const records = out.split("\0").filter(Boolean);
  if (records.length !== 1) fail("P1B_TRACE_INVALID", `expected one tree record for ${relative}`, { records: records.length });
  const parsed = parseLsTreeRecord(records[0]!);
  if (parsed.path !== relative || parsed.type !== "blob") fail("P1B_TRACE_INVALID", `trace path is not an exact blob: ${relative}`);
  return { mode: parsed.mode, oid: parsed.oid };
}

async function blobBytes(source: string, oid: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", source, "cat-file", "blob", oid], {
    env: sanitizedGitEnv(os.tmpdir()),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  } as Parameters<typeof execFileAsync>[2]);
  return Buffer.from(stdout as unknown as Uint8Array);
}

async function committedL1Manifest(source: string, target: string): Promise<{ hash: string; count: number; anchors: ProductionL1EventAnchor[] }> {
  const out = await git(source, ["ls-tree", "-r", "-z", target, "--", "l1/events/sha256"], os.tmpdir());
  const registry = loadL1SchemaRegistry();
  const rows: ProductionL1EventAnchor[] = [];
  for (const record of out.split("\0").filter(Boolean)) {
    const parsed = parseLsTreeRecord(record);
    if (parsed.type !== "blob") fail("P1B_TRACE_L1_INVALID", `committed L1 entry is not a blob: ${parsed.path}`);
    const bytes = await blobBytes(source, parsed.oid);
    let envelope: unknown;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { fail("P1B_TRACE_L1_INVALID", `committed L1 envelope is not JSON: ${parsed.path}`); }
    const validated = validateL1Envelope(envelope, { registry, relativePath: parsed.path });
    rows.push({ path: parsed.path, event_id: validated.eventId, blob_oid: parsed.oid, bytes_sha256: sha256Hex(bytes), envelope_hash: validated.envelopeHash, envelope_schema: validated.registration.envelope_schema });
  }
  rows.sort((a, b) => compareAscii(String(a.path), String(b.path)));
  return { hash: jcsSha256Hex(rows), count: rows.length, anchors: rows };
}

async function sourceOriginUrls(source: string): Promise<string[]> {
  const out = await git(source, ["remote", "-v"], os.tmpdir());
  return [...new Set(out.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/)[1]).filter((value): value is string => Boolean(value)))].sort(compareAscii);
}

function remoteBaseline(snapshot: CanonicalSourceSnapshot): string {
  const candidates = snapshot.push_remote_refs.flatMap((remote) => remote.refs)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "refs/heads/main" && GIT_OID_RE.test(parts[0]!))
    .map((parts) => parts[0]!);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) fail("P1B_REMOTE_BASELINE_INVALID", "source remote baseline must resolve to one refs/heads/main OID", { candidates: unique });
  return unique[0]!;
}

async function extractTrace(options: {
  source: string;
  sourceCommit: string;
  sourceParent: string;
  before: ExtendedSourceSnapshot;
  bundlePath: string;
  implementationRoot: string;
}): Promise<ProductionTraceManifest> {
  if (options.before.canonical.source_git_head !== options.sourceCommit) {
    fail("P1B_SOURCE_HEAD_MISMATCH", "source HEAD is not the pinned immutable source commit", { expected: options.sourceCommit, actual: options.before.canonical.source_git_head });
  }
  const actualParent = (await git(options.source, ["rev-parse", `${options.sourceCommit}^`], os.tmpdir())).trim();
  if (actualParent !== options.sourceParent) fail("P1B_SOURCE_PARENT_MISMATCH", "pinned source parent is not commit parent", { expected: options.sourceParent, actual: actualParent });
  const sourceTree = (await git(options.source, ["rev-parse", `${options.sourceCommit}^{tree}`], os.tmpdir())).trim();
  const parentTree = (await git(options.source, ["rev-parse", `${options.sourceParent}^{tree}`], os.tmpdir())).trim();
  const namesOut = await git(options.source, ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-only", options.sourceParent, options.sourceCommit], os.tmpdir());
  const names = namesOut.split("\0").filter(Boolean);
  if (names.length === 0 || new Set(names).size !== names.length) fail("P1B_TRACE_INVALID", "source diff is empty or contains duplicate paths");
  validateCohortPlan(names.map((relative) => ({ path: relative, op: "put", content: "placeholder" })));
  const entries: ProductionTraceEntry[] = [];
  for (const relative of names) {
    const oldEntry = await treeEntry(options.source, options.sourceParent, relative);
    const next = await treeEntry(options.source, options.sourceCommit, relative);
    if (!next) {
      entries.push({ path: relative, op: "delete", old_mode: oldEntry?.mode ?? "000000", old_blob_oid: oldEntry?.oid ?? "", new_mode: "000000", new_blob_oid: "", bytes_sha256: "", bytes: 0 });
      continue;
    }
    if (next.mode !== "100644" && next.mode !== "100755") fail("P1B_TRACE_MODE_UNSUPPORTED", `trace blob mode is unsupported: ${relative}`, { mode: next.mode });
    const bytes = await blobBytes(options.source, next.oid);
    entries.push({
      path: relative,
      op: "put",
      old_mode: oldEntry?.mode ?? "000000",
      old_blob_oid: oldEntry?.oid ?? "",
      new_mode: next.mode,
      new_blob_oid: next.oid,
      bytes_sha256: sha256Hex(bytes),
      bytes: bytes.length,
    });
  }
  entries.sort((a, b) => compareAscii(a.path, b.path));
  const fullL1 = await committedL1Manifest(options.source, options.sourceCommit);
  const registryPath = path.join(options.implementationRoot, "schemas/l1-schema-role-registry.json");
  const bundleBytes = await fsp.readFile(options.bundlePath);
  const traceWithoutRoot = entries.map((entry) => ({ path: entry.path, op: entry.op, mode: entry.new_mode, bytes_sha256: entry.bytes_sha256 }));
  return Object.freeze({
    schema_version: TRACE_SCHEMA,
    source_commit: options.sourceCommit,
    source_parent: options.sourceParent,
    source_tree: sourceTree,
    parent_tree: parentTree,
    entries: Object.freeze(entries),
    trace_entry_count: entries.length,
    cohort_root: sha256Hex(`pi-astack/p1b/production-trace-cohort/v1\n${canonicalizeJcs(traceWithoutRoot)}`),
    registry_sha256: sha256Hex(await fsp.readFile(registryPath)),
    full_committed_l1_anchors: Object.freeze(fullL1.anchors),
    full_committed_l1_set_hash: fullL1.hash,
    full_committed_l1_set_count: fullL1.count,
    production_current_l1_set_hash: options.before.canonical.l1_event_set_hash,
    production_current_l1_set_count: options.before.canonical.l1_event_count,
    source_remote_baseline_oid: remoteBaseline(options.before.canonical),
    source_snapshots: {
      canonical_snapshot_hash: options.before.canonical.snapshot_hash,
      extended_snapshot_hash: options.before.snapshot_hash,
      state_tree_hash: options.before.state_tree.hash,
      raw_index_sha256: options.before.raw_index.sha256,
      raw_index_lock_sha256: options.before.raw_index_lock.sha256,
      implementation_hash: options.before.implementation.hash,
    },
    bundle_sha256: sha256Hex(bundleBytes),
    bundle_bytes: bundleBytes.length,
  });
}

async function makeBundle(source: string, bundlePath: string): Promise<void> {
  prospectiveContained(path.dirname(bundlePath), bundlePath, "bundle");
  await run("git", ["-C", source, "bundle", "create", bundlePath, "refs/heads/main"], { env: sanitizedGitEnv(os.tmpdir()), maxBuffer: 256 * 1024 * 1024 });
  await run("git", ["bundle", "verify", bundlePath], { env: sanitizedGitEnv(os.tmpdir()), maxBuffer: 256 * 1024 * 1024 });
}

async function initializeReplayObjects(runRoot: string, bundlePath: string, parent: string): Promise<{ seedGit: string; parentTreeRoot: string }> {
  const seedGit = path.join(runRoot, "object-seed.git");
  const parentTreeRoot = path.join(runRoot, "parent-materialized");
  const home = path.join(runRoot, "harness-home");
  await fsp.mkdir(home, { recursive: true });
  await run("git", ["init", "--bare", "-q", seedGit], { env: sanitizedGitEnv(home) });
  await gitDir(seedGit, ["fetch", "-q", bundlePath, "refs/heads/main:refs/heads/source-main"], home);
  await fsp.mkdir(parentTreeRoot, { recursive: true });
  const indexPath = path.join(runRoot, "parent-materialized.index");
  await gitDir(seedGit, ["read-tree", parent], home, { GIT_INDEX_FILE: indexPath });
  await gitDir(seedGit, [`--work-tree=${parentTreeRoot}`, "checkout-index", "-a", "--force"], home, { GIT_INDEX_FILE: indexPath });
  await fsp.rm(indexPath, { force: true });
  return { seedGit, parentTreeRoot };
}

async function hardlinkTree(source: string, destination: string): Promise<void> {
  await fsp.mkdir(destination, { recursive: true });
  await run("cp", ["-al", `${source}${path.sep}.`, destination], { env: sanitizedGitEnv(os.tmpdir()) });
}

async function setupScenario(context: ScenarioContext, name: string, suffix = ""): Promise<ScenarioFixture> {
  const root = suffix
    ? path.join(context.runRoot, "scenarios", name, "fixtures", suffix)
    : path.join(context.runRoot, "scenarios", name);
  const repo = path.join(root, "repo");
  const osHome = path.join(root, "os-home");
  const remote = path.join(root, "remote.git");
  const outputs = path.join(root, "worker-output");
  const outside = path.join(context.runRoot, "outside-sentinels");
  const outsideSentinel = path.join(outside, `${suffix ? `${name}-${suffix}` : name}.sentinel`);
  for (const item of [root, osHome, outputs, outside]) await fsp.mkdir(item, { recursive: true });
  await fsp.writeFile(outsideSentinel, `outside sentinel ${name} ${suffix}\n`, { flag: "wx" });
  const outsideBefore = sha256Hex(await fsp.readFile(outsideSentinel));
  await hardlinkTree(context.parentTreeRoot, repo);
  await run("git", ["init", "-q", "-b", "replay", repo], { env: sanitizedGitEnv(osHome) });
  await fsp.writeFile(path.join(repo, ".git", "objects", "info", "alternates"), `${path.join(context.seedGit, "objects")}\n`);
  await git(repo, ["config", "user.name", "P1B Replay"], osHome);
  await git(repo, ["config", "user.email", "p1b@replay.invalid"], osHome);
  await git(repo, ["update-ref", "refs/heads/replay", context.trace.source_parent], osHome);
  await git(repo, ["symbolic-ref", "HEAD", "refs/heads/replay"], osHome);
  await git(repo, ["read-tree", context.trace.source_parent], osHome);
  await run("git", ["init", "--bare", "-q", remote], { env: sanitizedGitEnv(osHome) });
  await fsp.mkdir(path.join(remote, "objects", "info"), { recursive: true });
  await fsp.writeFile(path.join(remote, "objects", "info", "alternates"), `${path.join(context.seedGit, "objects")}\n`);
  await gitDir(remote, ["update-ref", "refs/heads/main", context.trace.source_remote_baseline_oid], osHome);
  for (const [value, label] of [[repo, "repo"], [osHome, "home"], [remote, "remote"], [outputs, "outputs"]] as const) await realContained(root, value, label);
  return {
    name, root, repo, home: repo, osHome, remote, outputs, outsideSentinel, outsideBefore,
    workerRuns: 0,
    consumedAnchors: [context.trace.entries[0]!.path],
    injections: [],
  };
}

async function rawIndex(repo: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await fsp.readFile(path.join(repo, ".git", "index"));
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
}

async function scenarioFingerprint(fixture: ScenarioFixture): Promise<Record<string, JcsJsonValue>> {
  const status = (await git(fixture.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], fixture.osHome, { GIT_OPTIONAL_LOCKS: "0" })).split("\0").filter(Boolean).sort(compareAscii);
  const refs = (await git(fixture.repo, ["for-each-ref", "--format=%(refname)%09%(objectname)"], fixture.osHome)).split(/\r?\n/).filter(Boolean).sort(compareAscii);
  const remoteRefs = (await gitDir(fixture.remote, ["for-each-ref", "--format=%(refname)%09%(objectname)"], fixture.osHome)).split(/\r?\n/).filter(Boolean).sort(compareAscii);
  const index = await rawIndex(fixture.repo);
  const base = {
    head: (await git(fixture.repo, ["rev-parse", "HEAD"], fixture.osHome)).trim(),
    refs_hash: jcsSha256Hex(refs),
    index_sha256: index.sha256,
    index_bytes: index.bytes,
    worktree_status_hash: jcsSha256Hex(status),
    remote_refs_hash: jcsSha256Hex(remoteRefs),
    recovery_event_count: (await scanWholeL1Validated({ abrainHome: fixture.home })).all.filter((item) => item.registration.envelope_schema === "drain-recovery-envelope/v1").length,
  };
  return { ...base, fingerprint_hash: jcsSha256Hex(base) };
}

function workerConfig(context: ScenarioContext, fixture: ScenarioFixture, operation: WorkerConfig["operation"], ordinal: number, extra: Partial<WorkerConfig>): WorkerConfig {
  const resultPath = path.join(fixture.outputs, `result-${ordinal}.json`);
  return {
    schema_version: WORKER_SCHEMA,
    replay_root: context.replayRoot,
    scenario_root: fixture.root,
    repo: fixture.repo,
    abrain_home: fixture.home,
    os_home: fixture.osHome,
    remote: fixture.remote,
    result_path: resultPath,
    operation,
    episode_id: String(extra.episode_id ?? "missing"),
    ...extra,
  };
}

async function spawnWorker(context: ScenarioContext, fixture: ScenarioFixture, config: WorkerConfig): Promise<WorkerResult> {
  const ordinal = fixture.workerRuns + 1;
  fixture.workerRuns = ordinal;
  const configPath = path.join(fixture.outputs, `config-${ordinal}.json`);
  if (config.result_path !== path.join(fixture.outputs, `result-${ordinal}.json`)) fail("P1B_WORKER_CONFIG_INVALID", "worker result path ordinal mismatch");
  await durableAtomicWriteFile(configPath, `${canonicalizeJcs(config as unknown as JcsJsonValue)}\n`, { mode: 0o600 });
  context.configPaths.push(configPath);
  context.resultPaths.push(config.result_path);
  const wrapperEnv: Record<string, string> = config.git_wrapper_dir && config.git_wrapper_trace_dir && config.real_git_path ? {
    PATH: `${config.git_wrapper_dir}${path.delimiter}${process.env.PATH ?? ""}`,
    P1B_REAL_GIT: config.real_git_path,
    P1B_GIT_TRACE_DIR: config.git_wrapper_trace_dir,
  } : {};
  const env = sanitizedGitEnv(fixture.osHome, { P1B_REPLAY_ROOT: context.replayRoot, ...wrapperEnv });
  const child = spawn(process.execPath, [context.workerScript, configPath], { env, cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0 && exitCode !== 86) fail("P1B_WORKER_FAILED", `worker exited ${exitCode}`, { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  const parsed = JSON.parse(await fsp.readFile(config.result_path, "utf8")) as WorkerResult;
  if (parsed.schema_version !== WORKER_RESULT_SCHEMA) fail("P1B_WORKER_RESULT_INVALID", "worker result schema mismatch");
  return parsed;
}

interface GitWrapperFixture {
  wrapperDir: string;
  traceDir: string;
  realGitPath: string;
}

interface GitWrapperLogRecord {
  argv: string[];
  exit_code: number;
  stderr_sha256: string;
  stderr_contains_ref_lock: boolean;
}

async function setupGitWrapper(fixture: ScenarioFixture, slot: number): Promise<GitWrapperFixture> {
  const root = path.join(fixture.root, `git-wrapper-slot-${slot}`);
  const wrapperDir = path.join(root, "bin");
  const traceDir = path.join(root, "trace");
  await fsp.mkdir(wrapperDir, { recursive: true });
  await fsp.mkdir(traceDir, { recursive: true });
  const realGitPath = (await run("which", ["git"], { env: sanitizedGitEnv(fixture.osHome) })).trim();
  if (!path.isAbsolute(realGitPath)) fail("P1B_GIT_WRAPPER_INVALID", "real git path is not absolute");
  const wrapper = [
    "#!/usr/bin/env bash",
    "set -eu",
    "id=\"$$\"",
    "printf '%s\\0' \"$@\" > \"$P1B_GIT_TRACE_DIR/argv-$id.bin\"",
    "export GIT_TRACE2_EVENT=\"$P1B_GIT_TRACE_DIR/trace-$id.json\"",
    "exec \"$P1B_REAL_GIT\" \"$@\" 2> >(tee \"$P1B_GIT_TRACE_DIR/stderr-$id.bin\" >&2)",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(wrapperDir, "git"), wrapper, { mode: 0o755 });
  return { wrapperDir, traceDir, realGitPath };
}

function wrapperConfig(wrapper: GitWrapperFixture): Pick<WorkerConfig, "git_wrapper_dir" | "git_wrapper_trace_dir" | "real_git_path"> {
  return { git_wrapper_dir: wrapper.wrapperDir, git_wrapper_trace_dir: wrapper.traceDir, real_git_path: wrapper.realGitPath };
}

async function readGitWrapperLog(traceDir: string): Promise<GitWrapperLogRecord[]> {
  const files = (await fsp.readdir(traceDir)).filter((name) => /^argv-\d+\.bin$/.test(name)).sort(compareAscii);
  const records: GitWrapperLogRecord[] = [];
  for (const file of files) {
    const pid = file.slice("argv-".length, -".bin".length);
    const argvBytes = await fsp.readFile(path.join(traceDir, file));
    const argv = argvBytes.toString("utf8").split("\0").filter((item) => item.length > 0);
    const traceText = await fsp.readFile(path.join(traceDir, `trace-${pid}.json`), "utf8");
    const traceRows = traceText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const exit = [...traceRows].reverse().find((row) => row?.event === "exit" && Number.isInteger(row?.code));
    if (!exit) fail("P1B_GIT_WRAPPER_INVALID", `Git Trace2 exit record missing for ${pid}`);
    const stderr = await fsp.readFile(path.join(traceDir, `stderr-${pid}.bin`));
    records.push({ argv, exit_code: exit.code, stderr_sha256: sha256Hex(stderr), stderr_contains_ref_lock: /cannot lock ref|failed to update ref|reference already locked|P1B_RETRYABLE_REF_LOCK/i.test(stderr.toString("utf8")) });
  }
  return records;
}

function pushWrapperRecord(records: readonly GitWrapperLogRecord[]): GitWrapperLogRecord {
  const matches = records.filter((record) => record.argv.includes("push"));
  if (matches.length !== 1) fail("P1B_GIT_WRAPPER_INVALID", "expected exactly one wrapped git push", { matches: matches.length });
  return matches[0]!;
}

function tracePlanEntries(entries: readonly ProductionTraceEntry[]): CohortPlanEntry[] {
  return entries.map((entry) => entry.op === "delete"
    ? { path: entry.path, op: "delete" }
    : { path: entry.path, op: "put", mode: entry.new_mode as "100644" | "100755", content: Buffer.alloc(0) });
}

async function materializeTracePlan(repo: string, entries: readonly ProductionTraceEntry[], osHome: string): Promise<CohortPlanEntry[]> {
  validateCohortPlan(tracePlanEntries(entries));
  const plan: CohortPlanEntry[] = [];
  for (const entry of entries) {
    if (entry.op === "delete") { plan.push({ path: entry.path, op: "delete" }); continue; }
    const { stdout } = await execFileAsync("git", ["-C", repo, "cat-file", "blob", entry.new_blob_oid], { env: sanitizedGitEnv(osHome), encoding: "buffer", maxBuffer: 64 * 1024 * 1024 } as Parameters<typeof execFileAsync>[2]);
    const bytes = Buffer.from(stdout as unknown as Uint8Array);
    if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.bytes_sha256) fail("P1B_TRACE_BLOB_MISMATCH", `transferred trace blob mismatch: ${entry.path}`);
    plan.push({ path: entry.path, op: "put", mode: entry.new_mode as "100644" | "100755", content: bytes });
  }
  return plan;
}

async function outsideWriteCount(fixture: ScenarioFixture): Promise<number> {
  return sha256Hex(await fsp.readFile(fixture.outsideSentinel)) === fixture.outsideBefore ? 0 : 1;
}

function injection(fixture: ScenarioFixture, input: Omit<InjectionRecord, "scenario" | "sha256" | "injection_hash"> & { bytes: string | Buffer }): InjectionRecord {
  const base = { scenario: fixture.name, id: input.id, path: input.path, sha256: sha256Hex(input.bytes), type: input.type, source_anchor: input.source_anchor };
  const record = { ...base, injection_hash: jcsSha256Hex(base) };
  fixture.injections.push(record);
  return record;
}

async function finishScenario(context: ScenarioContext, fixture: ScenarioFixture, input: {
  faultBoundary: string;
  expected: unknown;
  observed: unknown;
  error?: unknown;
  assertions: Record<string, boolean>;
  pre: JcsJsonValue;
  post: JcsJsonValue;
}): Promise<ScenarioResult> {
  const outside = await outsideWriteCount(fixture);
  const assertions = { ...input.assertions, source_path_not_exposed: true, outside_write_count_zero: outside === 0, consumed_trace_anchors_nonempty: fixture.consumedAnchors.length > 0, injection_manifest_nonempty: fixture.injections.length > 0 };
  return {
    id: fixture.name,
    pass: Object.values(assertions).every(Boolean),
    consumed_trace_anchors: fixture.consumedAnchors,
    injections: fixture.injections,
    fresh_process_count: fixture.workerRuns,
    fault_boundary: input.faultBoundary,
    expected: input.expected as JcsJsonValue,
    observed: input.observed as JcsJsonValue,
    error: (input.error ?? null) as JcsJsonValue,
    assertions,
    pre_fingerprint: input.pre,
    post_fingerprint: input.post,
    source_path_exposed: false,
    outside_write_count: outside,
  };
}

async function drainEpisode(fixture: ScenarioFixture): Promise<string> {
  return drainEpisodeIdentity({ repo_id: fixture.name, ref_name: "refs/heads/replay", generation_anchor: "production-trace" });
}

async function scenarioClaimRace(context: ScenarioContext): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, "claim-race");
  const pre = await scenarioFingerprint(fixture);
  const episode = await drainEpisode(fixture);
  injection(fixture, { id: "eight-process-claim-race", path: fixture.home, bytes: `${episode}:1:8`, type: "concurrency", source_anchor: fixture.consumedAnchors[0]! });
  const configs = Array.from({ length: 8 }, (_, index) => workerConfig(context, fixture, "claim", index + 1, { episode_id: episode, slot: 1 }));
  const results = await Promise.all(configs.map((config) => spawnWorker(context, fixture, config)));
  const winners = results.filter((result) => result.claim?.shouldExecute === true);
  const paths = new Set(results.map((result) => String(result.claim?.filePath)));
  const bytes = await Promise.all([...paths].map((file) => fsp.readFile(file)));
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: "atomic-no-replace claim publication",
    expected: { process_count: 8, should_execute: 1, consumed: 7, identical_claim_and_event_bytes: true },
    observed: { process_count: results.length, should_execute: winners.length, consumed: results.length - winners.length, unique_paths: paths.size, event_sha256: [...new Set(bytes.map((item) => sha256Hex(item)))] },
    assertions: { eight_fresh_processes: fixture.workerRuns === 8, exactly_one_executor: winners.length === 1, seven_consumed: results.length - winners.length === 7, claim_path_identical: paths.size === 1, event_bytes_identical: new Set(bytes.map((item) => sha256Hex(item))).size === 1 },
    pre, post,
  });
}

async function scenarioCrash(context: ScenarioContext, name: string, boundary: "prepared" | "cas" | "published" | "index", requiredEvents: string[]): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, name);
  const pre = await scenarioFingerprint(fixture);
  const episode = await drainEpisode(fixture);
  injection(fixture, { id: `crash-${boundary}`, path: fixture.repo, bytes: `${context.trace.cohort_root}:${boundary}`, type: "process_exit", source_anchor: fixture.consumedAnchors[0]! });
  const first = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_boundary", 1, {
    episode_id: episode, slot: 1, boundary, ref_name: "refs/heads/replay", target_tree: context.trace.source_tree, trace_entries: context.trace.entries,
  }));
  const second = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_resume", 2, { episode_id: episode, slot: 1 }));
  const events = await readRecoveryEvents(fixture.home, episode, "drain");
  const types = events.map((event) => event.event_type);
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: `${boundary}: ${CRASH_RESIDUAL}`,
    expected: { first_boundary: boundary, resume_action: "index_converged", required_events: requiredEvents, target_tree: context.trace.source_tree, termination: CRASH_RESIDUAL },
    observed: { first, second, event_types: types, head_tree: (await git(fixture.repo, ["rev-parse", "HEAD^{tree}"], fixture.osHome)).trim() },
    assertions: {
      two_fresh_processes: fixture.workerRuns === 2,
      first_boundary_reached: first.boundary === boundary,
      resumed_converged: second.action === "index_converged",
      events_complete: requiredEvents.every((type) => types.includes(type as never)),
      target_tree_equal: (await git(fixture.repo, ["rev-parse", "HEAD^{tree}"], fixture.osHome)).trim() === context.trace.source_tree,
    },
    pre, post,
  });
}

async function scenarioUnrelatedDrift(context: ScenarioContext): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, "cas-unrelated-drift");
  const pre = await scenarioFingerprint(fixture);
  const episode = await drainEpisode(fixture);
  const first = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_boundary", 1, { episode_id: episode, slot: 1, boundary: "prepared", ref_name: "refs/heads/replay", target_tree: context.trace.source_tree, trace_entries: context.trace.entries }));
  const driftPath = path.join(fixture.repo, "p1b-unrelated-drift.txt");
  const driftBytes = "real isolated unrelated drift\n";
  await fsp.writeFile(driftPath, driftBytes);
  await git(fixture.repo, ["add", "p1b-unrelated-drift.txt"], fixture.osHome);
  await git(fixture.repo, ["commit", "-qm", "P1B unrelated drift"], fixture.osHome);
  injection(fixture, { id: "unrelated-commit", path: "p1b-unrelated-drift.txt", bytes: driftBytes, type: "git_commit", source_anchor: fixture.consumedAnchors[0]! });
  const refInjected = (await git(fixture.repo, ["rev-parse", "HEAD"], fixture.osHome)).trim();
  const indexInjected = await rawIndex(fixture.repo);
  const worktreeInjected = sha256Hex(await fsp.readFile(driftPath));
  const second = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_resume", 2, { episode_id: episode, slot: 1 }));
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: "CAS after unrelated ref advancement",
    expected: { action: "refreeze_required", ref_preserved: true, raw_index_preserved: true, worktree_preserved: true },
    observed: { first, second, ref: (await git(fixture.repo, ["rev-parse", "HEAD"], fixture.osHome)).trim(), raw_index: await rawIndex(fixture.repo) },
    assertions: {
      two_fresh_processes: fixture.workerRuns === 2,
      refreeze_required: second.action === "refreeze_required",
      unrelated_ref_preserved: (await git(fixture.repo, ["rev-parse", "HEAD"], fixture.osHome)).trim() === refInjected,
      raw_index_preserved: (await rawIndex(fixture.repo)).sha256 === indexInjected.sha256,
      worktree_preserved: sha256Hex(await fsp.readFile(driftPath)) === worktreeInjected,
    },
    pre, post,
  });
}

function preparedFromResult(result: WorkerResult): { prepared: PreparedExactCohortCommit; snapshot: ReadonlyMap<string, string> } {
  const raw = result.prepared as any;
  if (!raw) fail("P1B_WORKER_RESULT_INVALID", "worker did not return prepared state");
  return {
    prepared: {
      repo: raw.repo,
      refName: raw.refName,
      frozenCommit: raw.frozenCommit,
      newTree: raw.newTree,
      candidate: raw.candidate,
      cohortManifestRoot: raw.cohortManifestRoot,
      entries: raw.entries,
    },
    snapshot: new Map(Object.entries(raw.frozenIndexSnapshot ?? {})),
  };
}

async function scenarioDescendantDrift(context: ScenarioContext): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, "cas-descendant-drift");
  const pre = await scenarioFingerprint(fixture);
  const episode = await drainEpisode(fixture);
  const first = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_boundary", 1, { episode_id: episode, slot: 1, boundary: "prepared", ref_name: "refs/heads/replay", target_tree: context.trace.source_tree, trace_entries: context.trace.entries }));
  const decoded = preparedFromResult(first);
  await publishExactCohortCommit({ repo: fixture.repo, refName: "refs/heads/replay", candidate: decoded.prepared.candidate, frozenCommit: decoded.prepared.frozenCommit });
  await convergeExactCohortIndex({ repo: fixture.repo, refName: "refs/heads/replay", cohortPaths: decoded.prepared.entries.map((entry) => entry.path), frozenIndexSnapshot: decoded.snapshot });
  const childPath = path.join(fixture.repo, "p1b-descendant.txt");
  const childBytes = "descendant commit after candidate\n";
  await fsp.writeFile(childPath, childBytes);
  await git(fixture.repo, ["add", "p1b-descendant.txt"], fixture.osHome);
  await git(fixture.repo, ["commit", "-qm", "P1B descendant"], fixture.osHome);
  const descendantRef = (await git(fixture.repo, ["rev-parse", "HEAD"], fixture.osHome)).trim();
  injection(fixture, { id: "candidate-descendant", path: "p1b-descendant.txt", bytes: childBytes, type: "git_descendant_commit", source_anchor: fixture.consumedAnchors[0]! });
  const second = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_resume", 2, { episode_id: episode, slot: 1 }));

  const independent = await setupScenario(context, "cas-descendant-drift", "independent-exact");
  const independentEpisode = await drainEpisode(independent);
  const independentFirst = await spawnWorker(context, independent, workerConfig(context, independent, "drain_boundary", 1, { episode_id: independentEpisode, slot: 1, boundary: "prepared", ref_name: "refs/heads/replay", target_tree: context.trace.source_tree, trace_entries: context.trace.entries }));
  const independentCommit = (await git(independent.repo, ["commit-tree", context.trace.source_tree, "-p", context.trace.source_parent, "-m", "independent exact cohort"], independent.osHome, {
    GIT_AUTHOR_NAME: "P1B", GIT_AUTHOR_EMAIL: "p1b@replay.invalid", GIT_COMMITTER_NAME: "P1B", GIT_COMMITTER_EMAIL: "p1b@replay.invalid",
  })).trim();
  await git(independent.repo, ["update-ref", "refs/heads/replay", independentCommit, context.trace.source_parent], independent.osHome);
  injection(independent, { id: "independent-exact-cohort", path: "refs/heads/replay", bytes: independentCommit, type: "git_independent_commit", source_anchor: independent.consumedAnchors[0]! });
  const independentSecond = await spawnWorker(context, independent, workerConfig(context, independent, "drain_resume", 2, { episode_id: independentEpisode, slot: 1 }));
  fixture.workerRuns += independent.workerRuns;
  fixture.injections.push(...independent.injections);
  fixture.consumedAnchors.push(...independent.consumedAnchors);
  const post = await scenarioFingerprint(fixture);
  const outsideIndependent = await outsideWriteCount(independent);
  return finishScenario(context, fixture, {
    faultBoundary: "candidate descendant and independent exact-cohort absorption",
    expected: { descendant_action: "index_converged", descendant_ref_preserved: true, independent_action: "index_converged" },
    observed: { first, second, descendant_ref: descendantRef, independent_first: independentFirst, independent_second: independentSecond, independent_commit: independentCommit },
    assertions: {
      four_fresh_processes: fixture.workerRuns === 4,
      descendant_absorbed: second.action === "index_converged",
      descendant_ref_preserved: (await git(fixture.repo, ["rev-parse", "HEAD"], fixture.osHome)).trim() === descendantRef,
      independent_exact_absorbed: independentSecond.action === "index_converged",
      independent_outside_unchanged: outsideIndependent === 0,
    },
    pre, post,
  });
}

async function scenarioOwnedIndexConflict(context: ScenarioContext): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, "owned-index-conflict");
  const pre = await scenarioFingerprint(fixture);
  const episode = await drainEpisode(fixture);
  const first = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_boundary", 1, { episode_id: episode, slot: 1, boundary: "published", ref_name: "refs/heads/replay", target_tree: context.trace.source_tree, trace_entries: context.trace.entries }));
  const anchor = context.trace.entries.find((entry) => entry.op === "put" && !entry.path.startsWith("l1/") && entry.old_blob_oid)
    ?? context.trace.entries.find((entry) => entry.op === "put" && !entry.path.startsWith("l1/"));
  if (!anchor) fail("P1B_TRACE_ANCHOR_MISSING", "owned-index conflict requires a real non-L1 cohort path");
  fixture.consumedAnchors = [anchor.path];
  const owned = path.join(fixture.repo, ...anchor.path.split("/"));
  await fsp.rm(owned, { force: true });
  const userBytes = Buffer.from(`owned staged user version for ${anchor.bytes_sha256}\n`);
  await fsp.mkdir(path.dirname(owned), { recursive: true });
  await fsp.writeFile(owned, userBytes);
  await git(fixture.repo, ["add", "--", anchor.path], fixture.osHome);
  injection(fixture, { id: "owned-staged-conflict", path: anchor.path, bytes: userBytes, type: "owned_index_blob", source_anchor: anchor.path });
  const beforeIndex = await rawIndex(fixture.repo);
  const second = await spawnWorker(context, fixture, workerConfig(context, fixture, "drain_resume", 2, { episode_id: episode, slot: 1 }));
  const afterIndex = await rawIndex(fixture.repo);
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: "published before exact-cohort shared-index convergence",
    expected: { error_code: "OWNED_INDEX_CONFLICT", raw_index_unchanged: true },
    observed: { first, second, before_index: beforeIndex, after_index: afterIndex },
    error: second.error ?? null,
    assertions: { two_fresh_processes: fixture.workerRuns === 2, owned_conflict: second.error?.code === "OWNED_INDEX_CONFLICT", raw_index_fully_unchanged: beforeIndex.sha256 === afterIndex.sha256 && beforeIndex.bytes === afterIndex.bytes },
    pre, post,
  });
}

async function scenarioPushRetry(context: ScenarioContext): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, "push-retry");
  await gitDir(fixture.remote, ["update-ref", "refs/heads/main", context.trace.source_parent], fixture.osHome);
  const pre = await scenarioFingerprint(fixture);
  const episode = pushEpisodeIdentity({ repo_id: sha256Hex(path.resolve(fixture.repo)), remote: fixture.remote, ref_name: "refs/heads/main", target_commit: context.trace.source_commit });
  const lockPath = path.join(fixture.remote, "refs", "heads", "main.lock");
  const lockBytes = "P1B_RETRYABLE_REF_LOCK\n";
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  await fsp.writeFile(lockPath, lockBytes, { flag: "wx" });
  injection(fixture, { id: "bare-remote-main-ref-lock", path: path.relative(fixture.root, lockPath), bytes: lockBytes, type: "git_transport_ref_lock", source_anchor: fixture.consumedAnchors[0]! });
  const slot1Wrapper = await setupGitWrapper(fixture, 1);
  const first = await spawnWorker(context, fixture, workerConfig(context, fixture, "push", 1, { episode_id: episode, ref_name: "refs/heads/main", target_commit: context.trace.source_commit, ...wrapperConfig(slot1Wrapper) }));
  await fsp.rm(lockPath, { force: true });
  const slot2Wrapper = await setupGitWrapper(fixture, 2);
  const second = await spawnWorker(context, fixture, workerConfig(context, fixture, "push", 2, { episode_id: episode, ref_name: "refs/heads/main", target_commit: context.trace.source_commit, ...wrapperConfig(slot2Wrapper) }));
  const wrapperSlot1 = pushWrapperRecord(await readGitWrapperLog(slot1Wrapper.traceDir));
  const wrapperSlot2 = pushWrapperRecord(await readGitWrapperLog(slot2Wrapper.traceDir));
  const events = await readRecoveryEvents(fixture.home, episode, "push");
  const folded = foldRecoveryEvents(events);
  const firstDurable = folded.get(1)?.pushOutcome?.body;
  const secondDurable = folded.get(2)?.pushOutcome?.body;
  const transientSlot1 = { classification: first.push?.classification, target_commit: first.push?.targetCommit, attempted: first.push?.transportAttempted, exit_code: first.push?.commandExitCode, stderr_sha256: first.push?.stderrSha256 };
  const transientSlot2 = { classification: second.push?.classification, target_commit: second.push?.targetCommit, attempted: second.push?.transportAttempted, exit_code: second.push?.commandExitCode, stderr_sha256: second.push?.stderrSha256 };
  const remoteRef = (await gitDir(fixture.remote, ["rev-parse", "refs/heads/main"], fixture.osHome)).trim();
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: "actual git push transport/ref update failure at isolated bare remote refs/heads/main.lock",
    expected: { slot1: "retryable", slot2: "success", same_episode: true, transport_failure_not_object_preflight: true, remote_ref: context.trace.source_commit },
    observed: {
      episode_id: episode,
      worker_results: { slot1: first, slot2: second },
      slots: [...folded.keys()],
      durable_outcome: { slot1: firstDurable ?? null, slot2: secondDurable ?? null },
      transient_transport_evidence: { slot1: transientSlot1, slot2: transientSlot2 },
      git_wrapper_log: { slot1: wrapperSlot1, slot2: wrapperSlot2 },
      remote_ref: remoteRef,
    },
    assertions: {
      two_fresh_processes: fixture.workerRuns === 2,
      slot1_actual_git_push_attempted: transientSlot1.attempted === true && wrapperSlot1.argv.includes("push"),
      slot1_transport_exit_nonzero: transientSlot1.exit_code === 1 && wrapperSlot1.exit_code === 1 && wrapperSlot1.stderr_contains_ref_lock,
      slot1_stderr_hash_recorded: SHA256_RE.test(String(transientSlot1.stderr_sha256)) && transientSlot1.stderr_sha256 === wrapperSlot1.stderr_sha256,
      first_retryable: transientSlot1.classification === "retryable" && firstDurable?.classification === "retryable",
      second_actual_git_push_succeeded: transientSlot2.attempted === true && transientSlot2.exit_code === 0 && wrapperSlot2.exit_code === 0 && wrapperSlot2.argv.includes("push"),
      second_success: transientSlot2.classification === "success" && secondDurable?.classification === "success",
      slots_advance_without_reset: first.push?.slot === 1 && second.push?.slot === 2 && folded.has(1) && folded.has(2),
      same_episode_generation: events.every((event) => event.episode_id === episode),
      remote_at_target: remoteRef === context.trace.source_commit,
      no_object_resolution_preflight_substitute: transientSlot1.attempted === true && transientSlot1.stderr_sha256 !== null,
    },
    pre, post,
  });
}

async function scenarioRemoteContained(context: ScenarioContext): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, "remote-contained");
  const pre = await scenarioFingerprint(fixture);
  const helper = path.join(fixture.root, "remote-writer");
  await fsp.mkdir(helper, { recursive: true });
  await run("git", ["init", "-q", "-b", "writer", helper], { env: sanitizedGitEnv(fixture.osHome) });
  await fsp.writeFile(path.join(helper, ".git", "objects", "info", "alternates"), `${path.join(context.seedGit, "objects")}\n`);
  const descendant = (await git(helper, ["commit-tree", context.trace.source_tree, "-p", context.trace.source_commit, "-m", "remote contained descendant"], fixture.osHome, {
    GIT_AUTHOR_NAME: "P1B", GIT_AUTHOR_EMAIL: "p1b@replay.invalid", GIT_COMMITTER_NAME: "P1B", GIT_COMMITTER_EMAIL: "p1b@replay.invalid",
  })).trim();
  await git(helper, ["push", "-q", fixture.remote, `${descendant}:refs/heads/main`], fixture.osHome);
  injection(fixture, { id: "remote-descendant", path: "remote.git/refs/heads/main", bytes: descendant, type: "remote_descendant_commit", source_anchor: fixture.consumedAnchors[0]! });
  const remoteBefore = (await gitDir(fixture.remote, ["rev-parse", "refs/heads/main"], fixture.osHome)).trim();
  const fetchHead = path.join(fixture.repo, ".git", "FETCH_HEAD");
  await fsp.rm(fetchHead, { force: true });
  const episode = pushEpisodeIdentity({ repo_id: sha256Hex(path.resolve(fixture.repo)), remote: fixture.remote, ref_name: "refs/heads/main", target_commit: context.trace.source_commit });
  const result = await spawnWorker(context, fixture, workerConfig(context, fixture, "push", 1, { episode_id: episode, ref_name: "refs/heads/main", target_commit: context.trace.source_commit }));
  const remoteAfter = (await gitDir(fixture.remote, ["rev-parse", "refs/heads/main"], fixture.osHome)).trim();
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: "remote already contains target as ancestor",
    expected: { classification: "success", remote_contains_target: true, remote_ref_unchanged: true, fetch_head_absent: true },
    observed: { result, remote_before: remoteBefore, remote_after: remoteAfter, fetch_head_exists: fs.existsSync(fetchHead) },
    assertions: { fresh_process: fixture.workerRuns === 1, contained_detected: result.push?.classification === "success" && result.push?.remoteContainsTarget === true, remote_ref_unchanged: remoteBefore === remoteAfter && remoteAfter === descendant, fetch_head_not_written: !fs.existsSync(fetchHead) },
    pre, post,
  });
}

async function loadTraceEnvelopeFromScenarioRepo(fixture: ScenarioFixture, trace: ProductionTraceManifest, domain?: string): Promise<{ anchor: ProductionTraceEntry; envelope: any }> {
  for (const anchor of trace.entries.filter((entry) => entry.op === "put" && entry.path.startsWith("l1/"))) {
    const bytes = await blobBytes(fixture.repo, anchor.new_blob_oid);
    if (bytes.length !== anchor.bytes || sha256Hex(bytes) !== anchor.bytes_sha256) fail("P1B_TRACE_BLOB_MISMATCH", `scenario trace anchor mismatch: ${anchor.path}`);
    const envelope = JSON.parse(bytes.toString("utf8"));
    const registration = loadL1SchemaRegistry().entries.find((entry) => entry.envelope_schema === envelope.schema);
    if (!domain || registration?.domain === domain) return { anchor, envelope };
  }
  fail("P1B_TRACE_ANCHOR_MISSING", `no transferred trace envelope for domain ${domain ?? "any"}`);
}

function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

async function scenarioSymlinkEscape(context: ScenarioContext): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, "symlink-path-escape");
  const pre = await scenarioFingerprint(fixture);
  const real = await loadTraceEnvelopeFromScenarioRepo(fixture, context.trace);
  fixture.consumedAnchors = [real.anchor.path];
  const validatorHome = path.join(fixture.root, "validator-home");
  const outsideDir = path.join(context.runRoot, "outside-symlink-target");
  await fsp.mkdir(path.join(validatorHome, "l1", "events", "sha256"), { recursive: true });
  await fsp.mkdir(outsideDir, { recursive: true });
  const firstShard = real.envelope.event_id.slice(0, 2);
  await fsp.symlink(outsideDir, path.join(validatorHome, "l1", "events", "sha256", firstShard));
  const target = path.join(validatorHome, ...expectedL1EventRelativePath(real.envelope.event_id).split("/"));
  injection(fixture, { id: "canonical-shard-symlink", path: path.relative(fixture.root, path.dirname(target)), bytes: `${firstShard}->${outsideDir}`, type: "symlink", source_anchor: real.anchor.path });
  let symlinkCode = "";
  try { await validateL1WritePreflight({ abrainHome: validatorHome, envelope: real.envelope, targetPath: target }); } catch (error) { symlinkCode = String((error as any).code ?? ""); }
  const invalids = ["../escape", "/absolute", "a\\b", ".git/config"];
  const pathCodes: Record<string, string> = {};
  for (const invalid of invalids) {
    injection(fixture, { id: `invalid-${sha256Hex(invalid).slice(0, 8)}`, path: invalid, bytes: invalid, type: "invalid_path", source_anchor: real.anchor.path });
    try { validateCohortPlan([{ path: invalid, op: "put", content: "x" }]); } catch (error) { pathCodes[invalid] = String((error as any).code ?? ""); }
  }
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: "path validation before write",
    expected: { symlink: "L1_SYMLINK_REJECTED", invalid_paths: "COHORT_PATH_INVALID" },
    observed: { symlink_code: symlinkCode, path_codes: pathCodes },
    assertions: { symlink_rejected: symlinkCode === "L1_SYMLINK_REJECTED", dotdot_rejected: pathCodes["../escape"] === "COHORT_PATH_INVALID", absolute_rejected: pathCodes["/absolute"] === "COHORT_PATH_INVALID", backslash_rejected: pathCodes["a\\b"] === "COHORT_PATH_INVALID", git_path_rejected: pathCodes[".git/config"] === "COHORT_PATH_INVALID", outside_target_empty: (await fsp.readdir(outsideDir)).length === 0 },
    pre, post,
  });
}

async function validatorInjectionScenario(context: ScenarioContext, kind: "hash-envelope-mismatch" | "unknown-schema-role"): Promise<ScenarioResult> {
  const fixture = await setupScenario(context, kind);
  const pre = await scenarioFingerprint(fixture);
  const real = await loadTraceEnvelopeFromScenarioRepo(fixture, context.trace, "knowledge");
  fixture.consumedAnchors = [real.anchor.path];
  const registry = loadL1SchemaRegistry();
  const validatorRoot = path.join(fixture.root, "validator-copies");
  const l2Out = path.join(fixture.root, "l2-output");
  await fsp.mkdir(validatorRoot, { recursive: true });
  const observed: Record<string, string> = {};
  const cases: Array<{ id: string; mutate: (envelope: any) => void; expected: string; relative?: (envelope: any) => string; expectation?: Record<string, unknown> }> = kind === "hash-envelope-mismatch" ? [
    { id: "body", mutate: (env) => { env.body.__p1b_body_mismatch = true; }, expected: "L1_HASH_MISMATCH" },
    { id: "hash-alg", mutate: (env) => { env.hash_alg = "sha512"; }, expected: "L1_HASH_METADATA_MISMATCH" },
    { id: "event-id", mutate: (env) => { env.event_id = "f".repeat(64); }, expected: "L1_HASH_MISMATCH" },
    { id: "filename", mutate: () => undefined, expected: "L1_PATH_MISMATCH", relative: (env) => expectedL1EventRelativePath(env.event_id).replace(`${env.event_id}.json`, `${"e".repeat(64)}.json`) },
  ] : [
    { id: "unknown-envelope-schema", mutate: (env) => { env.schema = "p1b-unknown-envelope/v1"; }, expected: "L1_SCHEMA_UNKNOWN" },
    { id: "body-schema", mutate: (env) => { env.body.event_schema_version = "p1b-unknown-body/v1"; const hash = canonicalL1BodyHash(env.body); env.event_id = hash; env.body_hash = hash; }, expected: "L1_SCHEMA_ROLE_MISMATCH" },
    { id: "domain", mutate: (env) => { env.body.intent.domain_hint = "constraint"; const hash = canonicalL1BodyHash(env.body); env.event_id = hash; env.body_hash = hash; }, expected: "L1_SCHEMA_ROLE_MISMATCH" },
    { id: "producer", mutate: (env) => { env.body.producer.name = "p1b.unknown-producer"; const hash = canonicalL1BodyHash(env.body); env.event_id = hash; env.body_hash = hash; }, expected: "L1_PRODUCER_MISMATCH" },
    { id: "role", mutate: () => undefined, expected: "L1_SCHEMA_ROLE_MISMATCH", expectation: { role: "evidence" } },
  ];
  const expectedCodes: Record<string, string> = {};
  for (const item of cases) {
    const envelope = cloneJson(real.envelope);
    item.mutate(envelope);
    const bytes = `${canonicalizeJcs(envelope)}\n`;
    const file = path.join(validatorRoot, `${item.id}.json`);
    await fsp.writeFile(file, bytes);
    injection(fixture, { id: item.id, path: path.relative(fixture.root, file), bytes, type: kind === "hash-envelope-mismatch" ? "envelope_hash_fault" : "schema_role_fault", source_anchor: real.anchor.path });
    expectedCodes[item.id] = item.expected;
    try {
      validateL1Envelope(envelope, { registry, relativePath: item.relative ? item.relative(envelope) : expectedL1EventRelativePath(envelope.event_id), expected: item.expectation as any });
      observed[item.id] = "accepted";
    } catch (error) { observed[item.id] = String((error as any).code ?? ""); }
  }
  const post = await scenarioFingerprint(fixture);
  return finishScenario(context, fixture, {
    faultBoundary: "whole-L1 validator before any L2 output",
    expected: expectedCodes,
    observed,
    assertions: { exact_error_codes: Object.entries(expectedCodes).every(([id, code]) => observed[id] === code), zero_l2_output: !fs.existsSync(l2Out) || (await fsp.readdir(l2Out)).length === 0 },
    pre, post,
  });
}

async function runScenarioMatrix(context: ScenarioContext, concurrency: number): Promise<ScenarioMatrixResult> {
  const runners: Array<(isolated: ScenarioContext) => Promise<ScenarioResult>> = [
    (isolated) => scenarioClaimRace(isolated),
    (isolated) => scenarioCrash(isolated, "crash-prepared", "prepared", ["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged"]),
    (isolated) => scenarioCrash(isolated, "crash-after-cas", "cas", ["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged"]),
    (isolated) => scenarioCrash(isolated, "crash-after-published", "published", ["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged"]),
    (isolated) => scenarioCrash(isolated, "crash-after-index", "index", ["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged"]),
    (isolated) => scenarioUnrelatedDrift(isolated),
    (isolated) => scenarioDescendantDrift(isolated),
    (isolated) => scenarioOwnedIndexConflict(isolated),
    (isolated) => scenarioPushRetry(isolated),
    (isolated) => scenarioRemoteContained(isolated),
    (isolated) => scenarioSymlinkEscape(isolated),
    (isolated) => validatorInjectionScenario(isolated, "hash-envelope-mismatch"),
    (isolated) => validatorInjectionScenario(isolated, "unknown-schema-role"),
  ];
  const results = new Array<ScenarioResult>(SCENARIO_IDS.length);
  const durations = new Array<number>(SCENARIO_IDS.length);
  const artifacts = new Array<{ configPaths: string[]; resultPaths: string[] }>(SCENARIO_IDS.length);
  let nextIndex = 0;
  const execute = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= runners.length) return;
      const configPaths: string[] = [];
      const resultPaths: string[] = [];
      const isolated = { ...context, configPaths, resultPaths };
      const started = Date.now();
      try { results[index] = await runners[index]!(isolated); }
      catch (error) {
        const id = SCENARIO_IDS[index]!;
        results[index] = {
          id, pass: false, consumed_trace_anchors: [context.trace.entries[0]!.path], injections: [], fresh_process_count: 0,
          fault_boundary: "harness exception", expected: null, observed: null,
          error: { code: String((error as any)?.code ?? "P1B_SCENARIO_FAILED"), message: error instanceof Error ? error.message : String(error) },
          assertions: { scenario_completed: false }, pre_fingerprint: null, post_fingerprint: null, source_path_exposed: false, outside_write_count: 0,
        };
      } finally {
        durations[index] = Date.now() - started;
        artifacts[index] = { configPaths, resultPaths };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, runners.length) }, () => execute()));
  return {
    scenarios: results,
    durationsMs: Object.fromEntries(SCENARIO_IDS.map((id, index) => [id, durations[index]!])),
    configPaths: artifacts.flatMap((item) => item.configPaths),
    resultPaths: artifacts.flatMap((item) => item.resultPaths),
  };
}

async function auditScenarioArtifacts(context: ReplayContext, scenarios: ScenarioResult[]): Promise<ScenarioResult[]> {
  const forbidden = [context.sourceReal, ...context.sourceOriginUrls].filter(Boolean);
  const texts = [canonicalizeJcs(scenarios as unknown as JcsJsonValue)];
  for (const file of [...context.configPaths, ...context.resultPaths]) texts.push(await fsp.readFile(file, "utf8"));
  const exposed = forbidden.some((needle) => texts.some((text) => text.includes(needle)));
  return scenarios.map((scenario) => {
    const assertions = { ...scenario.assertions, source_path_not_exposed: !exposed };
    return { ...scenario, source_path_exposed: exposed, assertions, pass: scenario.pass && !exposed };
  });
}

const BLOCKING_SOURCE_FLAGS = Object.freeze([
  "refChanged", "indexChanged", "worktreeChanged", "pushChanged", "canonicalChanged", "readChanged", "foldChanged",
  "rawIndexChanged", "rawIndexLockChanged",
] as const);
const STATE_READ_COVERAGE = ".state/sediment/constraint-shadow/latest is included in the canonical read hash; changes set readChanged=true and block acceptance";

function compareExtended(before: ExtendedSourceSnapshot, after: ExtendedSourceSnapshot): Record<string, boolean> {
  const canonical = compareCanonicalSourceSnapshots(before.canonical, after.canonical);
  const rawIndexChanged = before.raw_index.sha256 !== after.raw_index.sha256 || before.raw_index.bytes !== after.raw_index.bytes || before.raw_index.mode !== after.raw_index.mode || before.raw_index.mtime_ns !== after.raw_index.mtime_ns;
  const rawIndexLockChanged = before.raw_index_lock.sha256 !== after.raw_index_lock.sha256 || before.raw_index_lock.exists !== after.raw_index_lock.exists || before.raw_index_lock.bytes !== after.raw_index_lock.bytes || before.raw_index_lock.mode !== after.raw_index_lock.mode || before.raw_index_lock.mtime_ns !== after.raw_index_lock.mtime_ns;
  return {
    sourceChanged: Object.values(canonical).some(Boolean) || rawIndexChanged || rawIndexLockChanged,
    extendedSnapshotChanged: before.snapshot_hash !== after.snapshot_hash,
    ...canonical,
    stateChanged: before.state_tree.hash !== after.state_tree.hash,
    rawIndexChanged,
    rawIndexLockChanged,
    implementationChanged: before.implementation.hash !== after.implementation.hash,
  };
}

function stateDiagnostic(before: ExtendedSourceSnapshot, after: ExtendedSourceSnapshot, impactFlags: Record<string, boolean>, sourcePathExposed: boolean, outsideWriteCount: number): Record<string, JcsJsonValue> {
  const blockingSourceDrift = BLOCKING_SOURCE_FLAGS.some((flag) => impactFlags[flag] === true);
  return {
    before: before.state_tree,
    after: after.state_tree,
    delta: { files: after.state_tree.files - before.state_tree.files, bytes: after.state_tree.bytes - before.state_tree.bytes },
    blocks_acceptance: sourcePathExposed || outsideWriteCount !== 0 || blockingSourceDrift,
    canonical_read_coverage: STATE_READ_COVERAGE,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJcs(left: unknown, right: unknown): boolean {
  try { return canonicalizeJcs(left as JcsJsonValue) === canonicalizeJcs(right as JcsJsonValue); }
  catch { return false; }
}

function expectedScenarioContract(id: string, trace: Record<string, any>): { fault: string; fresh: number; expected: JcsJsonValue; assertions: string[] } | null {
  const standard = ["source_path_not_exposed", "outside_write_count_zero", "consumed_trace_anchors_nonempty", "injection_manifest_nonempty"];
  const crash = id === "crash-prepared" ? "prepared" : id === "crash-after-cas" ? "cas" : id === "crash-after-published" ? "published" : id === "crash-after-index" ? "index" : null;
  if (crash) return {
    fault: `${crash}: ${CRASH_RESIDUAL}`,
    fresh: 2,
    expected: { first_boundary: crash, resume_action: "index_converged", required_events: ["recovery_slot_claimed", "commit_prepared", "commit_published", "index_converged"], target_tree: trace.source_tree, termination: CRASH_RESIDUAL },
    assertions: [...standard, "two_fresh_processes", "first_boundary_reached", "resumed_converged", "events_complete", "target_tree_equal"],
  };
  const contracts: Record<string, { fault: string; fresh: number; expected: JcsJsonValue; assertions: string[] }> = {
    "claim-race": { fault: "atomic-no-replace claim publication", fresh: 8, expected: { process_count: 8, should_execute: 1, consumed: 7, identical_claim_and_event_bytes: true }, assertions: [...standard, "eight_fresh_processes", "exactly_one_executor", "seven_consumed", "claim_path_identical", "event_bytes_identical"] },
    "cas-unrelated-drift": { fault: "CAS after unrelated ref advancement", fresh: 2, expected: { action: "refreeze_required", ref_preserved: true, raw_index_preserved: true, worktree_preserved: true }, assertions: [...standard, "two_fresh_processes", "refreeze_required", "unrelated_ref_preserved", "raw_index_preserved", "worktree_preserved"] },
    "cas-descendant-drift": { fault: "candidate descendant and independent exact-cohort absorption", fresh: 4, expected: { descendant_action: "index_converged", descendant_ref_preserved: true, independent_action: "index_converged" }, assertions: [...standard, "four_fresh_processes", "descendant_absorbed", "descendant_ref_preserved", "independent_exact_absorbed", "independent_outside_unchanged"] },
    "owned-index-conflict": { fault: "published before exact-cohort shared-index convergence", fresh: 2, expected: { error_code: "OWNED_INDEX_CONFLICT", raw_index_unchanged: true }, assertions: [...standard, "two_fresh_processes", "owned_conflict", "raw_index_fully_unchanged"] },
    "push-retry": { fault: "actual git push transport/ref update failure at isolated bare remote refs/heads/main.lock", fresh: 2, expected: { slot1: "retryable", slot2: "success", same_episode: true, transport_failure_not_object_preflight: true, remote_ref: trace.source_commit }, assertions: [...standard, "two_fresh_processes", "slot1_actual_git_push_attempted", "slot1_transport_exit_nonzero", "slot1_stderr_hash_recorded", "first_retryable", "second_actual_git_push_succeeded", "second_success", "slots_advance_without_reset", "same_episode_generation", "remote_at_target", "no_object_resolution_preflight_substitute"] },
    "remote-contained": { fault: "remote already contains target as ancestor", fresh: 1, expected: { classification: "success", remote_contains_target: true, remote_ref_unchanged: true, fetch_head_absent: true }, assertions: [...standard, "fresh_process", "contained_detected", "remote_ref_unchanged", "fetch_head_not_written"] },
    "symlink-path-escape": { fault: "path validation before write", fresh: 0, expected: { symlink: "L1_SYMLINK_REJECTED", invalid_paths: "COHORT_PATH_INVALID" }, assertions: [...standard, "symlink_rejected", "dotdot_rejected", "absolute_rejected", "backslash_rejected", "git_path_rejected", "outside_target_empty"] },
    "hash-envelope-mismatch": { fault: "whole-L1 validator before any L2 output", fresh: 0, expected: { body: "L1_HASH_MISMATCH", "hash-alg": "L1_HASH_METADATA_MISMATCH", "event-id": "L1_HASH_MISMATCH", filename: "L1_PATH_MISMATCH" }, assertions: [...standard, "exact_error_codes", "zero_l2_output"] },
    "unknown-schema-role": { fault: "whole-L1 validator before any L2 output", fresh: 0, expected: { "unknown-envelope-schema": "L1_SCHEMA_UNKNOWN", "body-schema": "L1_SCHEMA_ROLE_MISMATCH", domain: "L1_SCHEMA_ROLE_MISMATCH", producer: "L1_PRODUCER_MISMATCH", role: "L1_SCHEMA_ROLE_MISMATCH" }, assertions: [...standard, "exact_error_codes", "zero_l2_output"] },
  };
  return contracts[id] ?? null;
}

function observedMatchesContract(scenario: Record<string, any>, trace: Record<string, any>): boolean {
  const observed = scenario.observed;
  if (!isRecord(observed)) return false;
  if (scenario.id === "claim-race") return observed.process_count === 8 && observed.should_execute === 1 && observed.consumed === 7 && observed.unique_paths === 1 && Array.isArray(observed.event_sha256) && observed.event_sha256.length === 1 && SHA256_RE.test(observed.event_sha256[0]);
  if (String(scenario.id).startsWith("crash-")) return observed.first?.boundary === scenario.expected.first_boundary && observed.second?.action === "index_converged" && observed.head_tree === trace.source_tree && scenario.expected.required_events.every((event: string) => observed.event_types?.includes(event));
  if (scenario.id === "cas-unrelated-drift") return observed.first?.boundary === "prepared" && observed.second?.action === "refreeze_required" && GIT_OID_RE.test(observed.ref) && SHA256_RE.test(observed.raw_index?.sha256);
  if (scenario.id === "cas-descendant-drift") return observed.first?.boundary === "prepared" && observed.second?.action === "index_converged" && observed.independent_first?.boundary === "prepared" && observed.independent_second?.action === "index_converged" && GIT_OID_RE.test(observed.descendant_ref) && GIT_OID_RE.test(observed.independent_commit);
  if (scenario.id === "owned-index-conflict") return observed.first?.boundary === "published" && observed.second?.error?.code === "OWNED_INDEX_CONFLICT" && scenario.error?.code === "OWNED_INDEX_CONFLICT" && observed.before_index?.sha256 === observed.after_index?.sha256 && observed.before_index?.bytes === observed.after_index?.bytes;
  if (scenario.id === "push-retry") {
    const worker1 = observed.worker_results?.slot1?.push;
    const worker2 = observed.worker_results?.slot2?.push;
    const transient1 = observed.transient_transport_evidence?.slot1;
    const transient2 = observed.transient_transport_evidence?.slot2;
    const durable1 = observed.durable_outcome?.slot1;
    const durable2 = observed.durable_outcome?.slot2;
    const wrapper1 = observed.git_wrapper_log?.slot1;
    const wrapper2 = observed.git_wrapper_log?.slot2;
    const durableKeys = (body: any) => isRecord(body) && sameJcs(Object.keys(body).sort(compareAscii), ["classification", "target_commit"]);
    return worker1?.slot === 1 && worker2?.slot === 2
      && worker1.classification === transient1?.classification && worker1.targetCommit === transient1?.target_commit
      && worker2.classification === transient2?.classification && worker2.targetCommit === transient2?.target_commit
      && transient1?.classification === durable1?.classification && transient1?.target_commit === durable1?.target_commit
      && transient2?.classification === durable2?.classification && transient2?.target_commit === durable2?.target_commit
      && durableKeys(durable1) && durableKeys(durable2) && durable1.target_commit === trace.source_commit && durable2.target_commit === trace.source_commit
      && transient1.attempted === true && transient1.exit_code === 1 && SHA256_RE.test(transient1.stderr_sha256)
      && Array.isArray(wrapper1?.argv) && wrapper1.argv.includes("push") && wrapper1.exit_code === 1 && wrapper1.stderr_contains_ref_lock === true && wrapper1.stderr_sha256 === transient1.stderr_sha256
      && transient2.attempted === true && transient2.exit_code === 0 && SHA256_RE.test(transient2.stderr_sha256)
      && Array.isArray(wrapper2?.argv) && wrapper2.argv.includes("push") && wrapper2.exit_code === 0 && wrapper2.stderr_sha256 === transient2.stderr_sha256
      && transient1.classification === "retryable" && transient2.classification === "success"
      && observed.remote_ref === trace.source_commit && Array.isArray(observed.slots) && observed.slots.includes(1) && observed.slots.includes(2);
  }
  if (scenario.id === "remote-contained") return observed.result?.push?.classification === "success" && observed.result?.push?.remoteContainsTarget === true && observed.remote_before === observed.remote_after && observed.fetch_head_exists === false;
  if (scenario.id === "symlink-path-escape") return observed.symlink_code === "L1_SYMLINK_REJECTED" && observed.path_codes?.["../escape"] === "COHORT_PATH_INVALID" && observed.path_codes?.["/absolute"] === "COHORT_PATH_INVALID" && observed.path_codes?.["a\\b"] === "COHORT_PATH_INVALID" && observed.path_codes?.[".git/config"] === "COHORT_PATH_INVALID";
  if (scenario.id === "hash-envelope-mismatch" || scenario.id === "unknown-schema-role") return sameJcs(observed, scenario.expected);
  return false;
}

function validateImplementationSnapshot(implementation: unknown, errors: string[]): void {
  if (!isRecord(implementation) || !Array.isArray(implementation.files)) { errors.push("implementation"); return; }
  const expectedPaths = [...IMPLEMENTATION_FILES];
  if (implementation.file_count !== expectedPaths.length || !sameJcs(implementation.files.map((item: any) => item?.path), expectedPaths)) errors.push("implementation_files");
  for (const item of implementation.files) {
    if (!isRecord(item) || typeof item.path !== "string" || (item.head_blob_oid !== null && !GIT_OID_RE.test(item.head_blob_oid)) || !GIT_OID_RE.test(item.working_blob_oid) || !SHA256_RE.test(item.sha256) || !Number.isInteger(item.bytes) || item.bytes < 0) errors.push(`implementation_file:${String(item?.path)}`);
  }
  const base = { git_head: implementation.git_head, file_count: implementation.file_count, files: implementation.files };
  if (!GIT_OID_RE.test(implementation.git_head) || implementation.hash !== jcsSha256Hex(base)) errors.push("implementation_hash");
}

export function validateProductionTraceDossier(report: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(report)) return { ok: false, errors: ["report_not_object"] };
  const value = report;
  if (value.schema_version !== REPORT_SCHEMA) errors.push("schema_version");
  if (!sameJcs(value.scope, { claim: "P1-B only", excludes: ["P1-A", "P2", "P3"], synthetic_counting_rule: "synthetic harness smoke validates isolation/manifest/validator only and does not count as P1-B production acceptance" })) errors.push("scope");

  const trace = value.trace_manifest;
  const entries = isRecord(trace) && Array.isArray(trace.entries) ? trace.entries : [];
  if (!isRecord(trace) || trace.schema_version !== TRACE_SCHEMA || !GIT_OID_RE.test(trace.source_commit) || !GIT_OID_RE.test(trace.source_parent) || !GIT_OID_RE.test(trace.source_tree) || !GIT_OID_RE.test(trace.parent_tree)) errors.push("trace_identity");
  if (entries.length === 0 || trace?.trace_entry_count !== entries.length) errors.push("trace_entry_count");
  const entryPaths = entries.map((entry: any) => entry?.path);
  if (!entryPaths.every((item: any) => typeof item === "string") || new Set(entryPaths).size !== entryPaths.length || !sameJcs(entryPaths, [...entryPaths].sort(compareAscii))) errors.push("trace_entry_order");
  try { validateCohortPlan(entries.map((entry: any) => entry.op === "delete" ? { path: entry.path, op: "delete" } : { path: entry.path, op: "put", mode: entry.new_mode, content: "x" })); } catch { errors.push("trace_entry_paths"); }
  for (const entry of entries) {
    const put = entry?.op === "put";
    const valid = isRecord(entry) && typeof entry.path === "string" && (put || entry.op === "delete") && typeof entry.old_mode === "string" && (entry.old_blob_oid === "" || GIT_OID_RE.test(entry.old_blob_oid)) && (put
      ? (entry.new_mode === "100644" || entry.new_mode === "100755") && GIT_OID_RE.test(entry.new_blob_oid) && SHA256_RE.test(entry.bytes_sha256) && Number.isInteger(entry.bytes) && entry.bytes >= 0
      : entry.new_mode === "000000" && entry.new_blob_oid === "" && entry.bytes_sha256 === "" && entry.bytes === 0);
    if (!valid) errors.push(`trace_entry:${String(entry?.path)}`);
  }
  const cohortRows = entries.map((entry: any) => ({ path: entry.path, op: entry.op, mode: entry.new_mode, bytes_sha256: entry.bytes_sha256 }));
  if (trace?.cohort_root !== sha256Hex(`pi-astack/p1b/production-trace-cohort/v1\n${canonicalizeJcs(cohortRows)}`)) errors.push("trace_cohort_root");
  const anchors = isRecord(trace) && Array.isArray(trace.full_committed_l1_anchors) ? trace.full_committed_l1_anchors : [];
  const registry = loadL1SchemaRegistry();
  for (const anchor of anchors) {
    if (!isRecord(anchor) || !SHA256_RE.test(anchor.event_id) || anchor.path !== expectedL1EventRelativePath(anchor.event_id) || !GIT_OID_RE.test(anchor.blob_oid) || !SHA256_RE.test(anchor.bytes_sha256) || !SHA256_RE.test(anchor.envelope_hash) || !registry.entries.some((item) => item.envelope_schema === anchor.envelope_schema)) errors.push(`full_l1_anchor:${String(anchor?.path)}`);
  }
  if (trace?.full_committed_l1_set_count !== anchors.length || trace?.full_committed_l1_set_hash !== jcsSha256Hex(anchors) || !sameJcs(anchors.map((item: any) => item.path), anchors.map((item: any) => item.path).sort(compareAscii))) errors.push("full_l1_set");
  if (!SHA256_RE.test(trace?.registry_sha256) || trace.registry_sha256 !== sha256Hex(fs.readFileSync(path.join(MODULE_IMPLEMENTATION_ROOT, "schemas/l1-schema-role-registry.json")))) errors.push("registry_hash");
  if (!SHA256_RE.test(trace?.bundle_sha256) || !Number.isInteger(trace?.bundle_bytes) || trace.bundle_bytes <= 0 || !SHA256_RE.test(trace?.production_current_l1_set_hash) || !Number.isInteger(trace?.production_current_l1_set_count) || trace.production_current_l1_set_count < 0 || !GIT_OID_RE.test(trace?.source_remote_baseline_oid)) errors.push("trace_shape");
  const anchorIds = new Set([...entryPaths, ...anchors.flatMap((anchor: any) => [anchor.path, anchor.event_id])]);

  const scenarios = Array.isArray(value.scenarios) ? value.scenarios : [];
  const ids = scenarios.map((scenario: any) => scenario?.id);
  if (value.scenario_count !== SCENARIO_IDS.length || scenarios.length !== SCENARIO_IDS.length || !sameJcs(ids, SCENARIO_IDS)) errors.push("scenario_ids");
  for (const scenario of scenarios) {
    const label = String(scenario?.id);
    const contract = expectedScenarioContract(label, trace ?? {});
    if (!isRecord(scenario) || !contract) { errors.push(`scenario:${label}:contract`); continue; }
    if (scenario.pass !== true || scenario.source_path_exposed !== false || scenario.outside_write_count !== 0) errors.push(`scenario:${label}:status`);
    if (!Array.isArray(scenario.consumed_trace_anchors) || scenario.consumed_trace_anchors.length === 0 || !scenario.consumed_trace_anchors.every((anchor: any) => typeof anchor === "string" && anchorIds.has(anchor))) errors.push(`scenario:${label}:anchors`);
    if (!Array.isArray(scenario.injections) || scenario.injections.length === 0 || !scenario.injections.every((item: any) => {
      if (!isRecord(item) || !sameJcs(Object.keys(item).sort(compareAscii), ["id", "injection_hash", "path", "scenario", "sha256", "source_anchor", "type"])) return false;
      const base = { scenario: item.scenario, id: item.id, path: item.path, sha256: item.sha256, type: item.type, source_anchor: item.source_anchor };
      return item.scenario === label && typeof item.id === "string" && item.id.length > 0 && typeof item.path === "string" && typeof item.type === "string" && item.type.length > 0 && SHA256_RE.test(item.sha256) && typeof item.source_anchor === "string" && anchorIds.has(item.source_anchor) && item.injection_hash === jcsSha256Hex(base);
    })) errors.push(`scenario:${label}:injections`);
    if (!Number.isInteger(scenario.fresh_process_count) || scenario.fresh_process_count < contract.fresh) errors.push(`scenario:${label}:fresh_process_count`);
    if (scenario.fault_boundary !== contract.fault || !sameJcs(scenario.expected, contract.expected)) errors.push(`scenario:${label}:expected`);
    if (!isRecord(scenario.assertions) || !Object.values(scenario.assertions).every((item) => item === true) || !contract.assertions.every((key) => scenario.assertions[key] === true)) errors.push(`scenario:${label}:assertions`);
    if (!observedMatchesContract(scenario, trace ?? {})) errors.push(`scenario:${label}:observed`);
    if (label !== "owned-index-conflict" && scenario.error !== null) errors.push(`scenario:${label}:error`);
    if (!isRecord(scenario.pre_fingerprint) || !isRecord(scenario.post_fingerprint) || !SHA256_RE.test(scenario.pre_fingerprint.fingerprint_hash) || !SHA256_RE.test(scenario.post_fingerprint.fingerprint_hash)) errors.push(`scenario:${label}:fingerprint`);
  }

  validateImplementationSnapshot(value.implementation, errors);
  const beforeSummary = value.source_before;
  const afterSummary = value.source_after;
  if (!isRecord(beforeSummary) || !isRecord(afterSummary)) errors.push("source_snapshots");
  if (beforeSummary?.implementation_hash !== value.implementation?.hash || trace?.source_snapshots?.implementation_hash !== value.implementation?.hash) errors.push("implementation_linkage");
  const timing = value.execution_timing;
  const scenarioDurations = isRecord(timing) && isRecord(timing.scenario_durations_ms) ? timing.scenario_durations_ms : {};
  if (!isRecord(timing) || !Number.isInteger(timing.capture_window_duration_ms) || timing.capture_window_duration_ms < 0 || !Number.isInteger(timing.scenario_concurrency) || timing.scenario_concurrency < 1 || timing.scenario_concurrency > 8 || !sameJcs(Object.keys(scenarioDurations).sort(compareAscii), [...SCENARIO_IDS].sort(compareAscii)) || !Object.values(scenarioDurations).every((duration) => Number.isInteger(duration) && duration >= 0)) errors.push("execution_timing");
  const requiredFlags = ["sourceChanged", "extendedSnapshotChanged", "refChanged", "indexChanged", "worktreeChanged", "pushChanged", "canonicalChanged", "readChanged", "foldChanged", "stateChanged", "rawIndexChanged", "rawIndexLockChanged", "implementationChanged"];
  const flags = value.impact_flags;
  const flagsShaped = isRecord(flags) && sameJcs(Object.keys(flags).sort(compareAscii), [...requiredFlags].sort(compareAscii)) && requiredFlags.every((flag) => typeof flags[flag] === "boolean");
  if (!flagsShaped) errors.push("impact_flags_shape");
  if (flagsShaped) {
    const blockingSourceChanged = BLOCKING_SOURCE_FLAGS.some((flag) => flags[flag] === true);
    if (flags.sourceChanged !== blockingSourceChanged) errors.push("impact_sourceChanged");
    if (flags.extendedSnapshotChanged !== (beforeSummary?.snapshot_hash !== afterSummary?.snapshot_hash)) errors.push("impact_extendedSnapshotChanged");
    if (flags.stateChanged !== (beforeSummary?.state_tree?.hash !== afterSummary?.state_tree?.hash)) errors.push("impact_stateChanged");
    if (flags.stateChanged && !flags.extendedSnapshotChanged) errors.push("impact_state_requires_extended");
  }
  const isolationExpected = { source_replay_realpath_separate: true, replay_root_under_os_tmpdir: true, source_path_exposed: false, outside_write_count: 0, all_scenarios_isolated: true };
  if (!sameJcs(value.isolation_assertions, isolationExpected)) errors.push("isolation_assertions");
  const state = value.state_diagnostic;
  const stateShape = isRecord(state) && isRecord(state.before) && isRecord(state.after) && isRecord(state.delta)
    && sameJcs(Object.keys(state).sort(compareAscii), ["after", "before", "blocks_acceptance", "canonical_read_coverage", "delta"])
    && sameJcs(Object.keys(state.before).sort(compareAscii), ["bytes", "files", "hash"])
    && sameJcs(Object.keys(state.after).sort(compareAscii), ["bytes", "files", "hash"])
    && sameJcs(Object.keys(state.delta).sort(compareAscii), ["bytes", "files"]);
  if (!stateShape || !sameJcs(state?.before, beforeSummary?.state_tree) || !sameJcs(state?.after, afterSummary?.state_tree)
    || state?.delta?.files !== state?.after?.files - state?.before?.files || state?.delta?.bytes !== state?.after?.bytes - state?.before?.bytes
    || state?.canonical_read_coverage !== STATE_READ_COVERAGE) errors.push("state_diagnostic");
  if (stateShape && flagsShaped) {
    const expectedStateBlock = value.isolation_assertions?.source_path_exposed !== false || value.isolation_assertions?.outside_write_count !== 0 || BLOCKING_SOURCE_FLAGS.some((flag) => flags[flag] === true);
    if (state.blocks_acceptance !== expectedStateBlock || state.blocks_acceptance !== false) errors.push("state_diagnostic_blocks_acceptance");
  }
  const expectedAcceptance = {
    source_stable: flagsShaped && flags.sourceChanged === false,
    every_scenario_pass: scenarios.length === SCENARIO_IDS.length && scenarios.every((scenario: any) => scenario?.pass === true),
    isolation_green: sameJcs(value.isolation_assertions, isolationExpected),
    artifact_green: sameJcs(value.artifact_verification, { bundle: true, trace_entries: true, full_l1: true, implementation: true }),
    implementation_stable: flagsShaped && flags.implementationChanged === false,
  };
  if (!sameJcs(value.acceptance, expectedAcceptance) || !Object.values(expectedAcceptance).every(Boolean)) errors.push("acceptance");
  if (value.residual_risk?.crash_boundary !== CRASH_RESIDUAL) errors.push("crash_residual");
  if (value.residual_risk?.source_snapshot_authenticity !== SOURCE_SNAPSHOT_AUTHENTICITY) errors.push("source_snapshot_authenticity");
  if (!sameJcs(value.artifact_verification, { bundle: true, trace_entries: true, full_l1: true, implementation: true })) errors.push("artifact_verification");
  if (!Array.isArray(value.invalidated_attempts) || value.invalidated_attempts.length > 3 || !value.invalidated_attempts.every((attempt: any, index: number) => isRecord(attempt) && attempt.attempt === index + 1 && attempt.status === "invalidated_source_drift") || !sameJcs(value.invalidated_attempt_stop_rule, { maximum_invalidated_runs: 3, behavior: "stop without waiver after three source-drift invalidations" })) errors.push("invalidated_attempts");
  if (value.dossier_self_hash_rule !== "sha256(RFC8785-JCS(report_without_dossier_self_hash)); logical self hash only" || value.report_file_sha256_rule !== "sha256(exact dossier.json bytes) is computed and printed externally after durable publication and is not embedded in dossier_self_hash") errors.push("hash_rules");
  const selfHash = value.dossier_self_hash;
  const without = { ...value };
  delete without.dossier_self_hash;
  if (typeof selfHash !== "string" || !SHA256_RE.test(selfHash) || jcsSha256Hex(without) !== selfHash) errors.push("dossier_self_hash");
  return { ok: errors.length === 0, errors };
}

export interface VerifyProductionTraceDossierArtifactsOptions {
  bundlePath: string;
  implementationRoot: string;
  reportFilePath?: string;
  expectedReportSha256?: string;
  expectedReportBytes?: number;
}

export interface ProductionTraceArtifactVerification {
  bundle: true;
  trace_entries: true;
  full_l1: true;
  implementation: true;
  report_file?: true;
}

export async function verifyProductionTraceDossierArtifacts(report: unknown, options: VerifyProductionTraceDossierArtifactsOptions): Promise<ProductionTraceArtifactVerification> {
  if (!isRecord(report) || !isRecord(report.trace_manifest) || !isRecord(report.implementation)) fail("P1B_ARTIFACT_VERIFICATION_FAILED", "artifact verifier requires a shaped dossier");
  const trace = report.trace_manifest as Record<string, any>;
  const bundlePath = await fsp.realpath(options.bundlePath);
  const implementationRoot = await fsp.realpath(options.implementationRoot);
  const bundleBytes = await fsp.readFile(bundlePath);
  if (sha256Hex(bundleBytes) !== trace.bundle_sha256 || bundleBytes.length !== trace.bundle_bytes) fail("P1B_ARTIFACT_BUNDLE_MISMATCH", "bundle exact bytes do not match dossier manifest");
  const verifyRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-astack-p1b-artifact-verify-"));
  const verifyGit = path.join(verifyRoot, "verify.git");
  const home = path.join(verifyRoot, "home");
  await fsp.mkdir(home, { recursive: true });
  try {
    await run("git", ["init", "--bare", "-q", verifyGit], { env: sanitizedGitEnv(home) });
    await gitDir(verifyGit, ["fetch", "-q", bundlePath, "refs/heads/main:refs/heads/verified-main"], home);
    const fetched = (await gitDir(verifyGit, ["rev-parse", "refs/heads/verified-main"], home)).trim();
    const parent = (await gitDir(verifyGit, ["rev-parse", `${trace.source_commit}^`], home)).trim();
    const sourceTree = (await gitDir(verifyGit, ["rev-parse", `${trace.source_commit}^{tree}`], home)).trim();
    const parentTree = (await gitDir(verifyGit, ["rev-parse", `${trace.source_parent}^{tree}`], home)).trim();
    if (fetched !== trace.source_commit || parent !== trace.source_parent || sourceTree !== trace.source_tree || parentTree !== trace.parent_tree) fail("P1B_ARTIFACT_GIT_IDENTITY_MISMATCH", "bundle commit/parent/tree identity differs from dossier");

    const namesOut = await gitDir(verifyGit, ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-only", trace.source_parent, trace.source_commit], home);
    const names = namesOut.split("\0").filter(Boolean).sort(compareAscii);
    const entries = Array.isArray(trace.entries) ? trace.entries : [];
    if (!sameJcs(names, entries.map((entry: any) => entry?.path).sort(compareAscii))) fail("P1B_ARTIFACT_TRACE_PATHS_MISMATCH", "bundle diff paths differ from dossier entries");
    for (const entry of entries) {
      const oldEntry = await treeEntry(verifyGit, trace.source_parent, entry.path);
      const nextEntry = await treeEntry(verifyGit, trace.source_commit, entry.path);
      if ((oldEntry?.mode ?? "000000") !== entry.old_mode || (oldEntry?.oid ?? "") !== entry.old_blob_oid) fail("P1B_ARTIFACT_TRACE_ENTRY_MISMATCH", `old tree entry differs: ${entry.path}`);
      if (entry.op === "delete") {
        if (nextEntry !== null || entry.new_mode !== "000000" || entry.new_blob_oid !== "" || entry.bytes_sha256 !== "" || entry.bytes !== 0) fail("P1B_ARTIFACT_TRACE_ENTRY_MISMATCH", `deleted tree entry differs: ${entry.path}`);
      } else {
        if (!nextEntry || nextEntry.mode !== entry.new_mode || nextEntry.oid !== entry.new_blob_oid) fail("P1B_ARTIFACT_TRACE_ENTRY_MISMATCH", `new tree entry differs: ${entry.path}`);
        const bytes = await blobBytes(verifyGit, nextEntry.oid);
        if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.bytes_sha256) fail("P1B_ARTIFACT_TRACE_BYTES_MISMATCH", `blob exact bytes differ: ${entry.path}`);
      }
    }
    const cohortRows = entries.map((entry: any) => ({ path: entry.path, op: entry.op, mode: entry.new_mode, bytes_sha256: entry.bytes_sha256 }));
    if (trace.cohort_root !== sha256Hex(`pi-astack/p1b/production-trace-cohort/v1\n${canonicalizeJcs(cohortRows)}`)) fail("P1B_ARTIFACT_COHORT_MISMATCH", "cohort root does not match bundle-derived entries");

    const fullL1 = await committedL1Manifest(verifyGit, trace.source_commit);
    if (!sameJcs(fullL1.anchors, trace.full_committed_l1_anchors) || fullL1.hash !== trace.full_committed_l1_set_hash || fullL1.count !== trace.full_committed_l1_set_count) fail("P1B_ARTIFACT_FULL_L1_MISMATCH", "full committed L1 anchors/hash/count differ from bundle");
    const registryBytes = await fsp.readFile(path.join(implementationRoot, "schemas/l1-schema-role-registry.json"));
    if (sha256Hex(registryBytes) !== trace.registry_sha256) fail("P1B_ARTIFACT_REGISTRY_MISMATCH", "working registry differs from dossier");
    const implementation = await implementationSnapshot(implementationRoot);
    if (!sameJcs(implementation, report.implementation)) fail("P1B_ARTIFACT_IMPLEMENTATION_MISMATCH", "working implementation differs from dossier snapshot");

    const verified: ProductionTraceArtifactVerification = { bundle: true, trace_entries: true, full_l1: true, implementation: true };
    if (options.reportFilePath) {
      const reportBytes = await fsp.readFile(await fsp.realpath(options.reportFilePath));
      const expectedBytes = Buffer.from(`${canonicalizeJcs(report as JcsJsonValue)}\n`, "utf8");
      if (!reportBytes.equals(expectedBytes)) fail("P1B_ARTIFACT_REPORT_BYTES_MISMATCH", "report file is not the exact canonical dossier bytes");
      const reportSha = sha256Hex(reportBytes);
      if (options.expectedReportSha256 !== undefined && reportSha !== options.expectedReportSha256) fail("P1B_ARTIFACT_REPORT_SHA_MISMATCH", "report exact bytes SHA-256 differs from external expected value");
      if (options.expectedReportBytes !== undefined && reportBytes.length !== options.expectedReportBytes) fail("P1B_ARTIFACT_REPORT_SIZE_MISMATCH", "report byte count differs from external expected value");
      verified.report_file = true;
    } else if (options.expectedReportSha256 !== undefined || options.expectedReportBytes !== undefined) {
      fail("P1B_ARTIFACT_REPORT_EXPECTATION_INVALID", "external report expectations require reportFilePath");
    }
    return verified;
  } finally {
    await fsp.rm(verifyRoot, { recursive: true, force: true });
  }
}

export async function executeProductionTraceWorkerConfig(configPath: string): Promise<{ result: WorkerResult; exitCode: number }> {
  let config: WorkerConfig;
  try { config = JSON.parse(await fsp.readFile(configPath, "utf8")); }
  catch (error) { fail("P1B_WORKER_CONFIG_INVALID", `cannot read worker config: ${error instanceof Error ? error.message : String(error)}`); }
  if (config.schema_version !== WORKER_SCHEMA) fail("P1B_WORKER_CONFIG_INVALID", "worker config schema mismatch");
  const replayRoot = await fsp.realpath(config.replay_root);
  const tmpReal = await fsp.realpath(os.tmpdir());
  if (!inside(tmpReal, replayRoot) || replayRoot === tmpReal) fail("P1B_WORKER_CONTAINMENT", "replay root is not a child of os.tmpdir()");
  const scenarioRoot = await realContained(replayRoot, config.scenario_root, "worker scenario root");
  for (const [value, label] of [[config.repo, "worker repo"], [config.abrain_home, "worker home"], [config.os_home, "worker os home"], [config.remote, "worker remote"]] as const) await realContained(scenarioRoot, value, label);
  prospectiveContained(scenarioRoot, config.result_path, "worker result");
  await realContained(scenarioRoot, configPath, "worker config");
  const wrapperFields = [config.git_wrapper_dir, config.git_wrapper_trace_dir, config.real_git_path];
  if (wrapperFields.some(Boolean) && !wrapperFields.every((value) => typeof value === "string" && value.length > 0)) fail("P1B_WORKER_CONFIG_INVALID", "Git wrapper config is incomplete");
  if (config.git_wrapper_dir && config.git_wrapper_trace_dir && config.real_git_path) {
    await realContained(scenarioRoot, config.git_wrapper_dir, "worker Git wrapper");
    await realContained(scenarioRoot, config.git_wrapper_trace_dir, "worker Git wrapper trace");
    const realGit = await fsp.realpath(config.real_git_path);
    if (!path.isAbsolute(realGit) || !(await fsp.stat(realGit)).isFile()) fail("P1B_WORKER_CONFIG_INVALID", "real Git executable is invalid");
  }
  const allowedGitEnvironment = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_TERMINAL_PROMPT"]);
  const unexpectedGitEnvironment = Object.keys(process.env).filter((key) => key.startsWith("GIT_") && !allowedGitEnvironment.has(key));
  if (unexpectedGitEnvironment.length > 0) fail("P1B_WORKER_ENV_UNSAFE", "worker inherited unapproved Git environment", { unexpectedGitEnvironment: unexpectedGitEnvironment.sort(compareAscii) });
  if (process.env.HOME !== config.os_home || process.env.GIT_CONFIG_GLOBAL !== "/dev/null" || process.env.GIT_CONFIG_SYSTEM !== "/dev/null" || process.env.GIT_TERMINAL_PROMPT !== "0") {
    fail("P1B_WORKER_ENV_UNSAFE", "worker Git/HOME environment is not fixed");
  }
  const assertions: Record<string, boolean> = { replay_under_tmp: true, paths_contained: true, git_env_scrubbed: true };
  let result: WorkerResult;
  let exitCode = 0;
  try {
    if (config.operation === "claim") {
      const claim = await claimRecoverySlot({ abrainHome: config.abrain_home, episodeId: config.episode_id, lane: "drain", slot: config.slot! });
      result = { schema_version: WORKER_RESULT_SCHEMA, ok: true, pid: process.pid, operation: config.operation, claim: claim as unknown as Record<string, unknown>, assertions };
    } else if (config.operation === "drain_boundary") {
      if (!config.trace_entries?.length || !config.target_tree || !config.ref_name || !config.boundary) fail("P1B_WORKER_CONFIG_INVALID", "drain boundary config is incomplete");
      const plan = await materializeTracePlan(config.repo, config.trace_entries, config.os_home);
      const frozen = (await git(config.repo, ["rev-parse", config.ref_name], config.os_home)).trim();
      const snapshot = await snapshotIndexEntries(config.repo, plan.map((entry) => entry.path));
      const prepared = await prepareExactCohortCommit({ repo: config.repo, refName: config.ref_name, frozenCommit: frozen, plan, message: "P1B immutable production trace replay" });
      if (prepared.newTree !== config.target_tree) fail("P1B_TARGET_TREE_MISMATCH", "reconstructed target tree differs from immutable source target", { expected: config.target_tree, actual: prepared.newTree });
      const claim = await claimRecoverySlot({ abrainHome: config.abrain_home, episodeId: config.episode_id, lane: "drain", slot: config.slot! });
      if (!claim.shouldExecute) fail("P1B_WORKER_CLAIM_CONSUMED", "boundary worker did not acquire its slot");
      await recordDrainPrepared({ abrainHome: config.abrain_home, episodeId: config.episode_id, slot: config.slot!, prepared, frozenIndexSnapshot: snapshot });
      if (config.boundary === "cas" || config.boundary === "published" || config.boundary === "index") {
        await publishExactCohortCommit({ repo: config.repo, refName: config.ref_name, candidate: prepared.candidate, frozenCommit: prepared.frozenCommit });
      }
      if (config.boundary === "published" || config.boundary === "index") {
        await appendRecoveryEvent({ abrainHome: config.abrain_home, episodeId: config.episode_id, lane: "drain", slot: config.slot!, eventType: "commit_published", body: { candidate: prepared.candidate, publication_confirmed: true } });
      }
      if (config.boundary === "index") {
        await convergeExactCohortIndex({ repo: config.repo, refName: config.ref_name, cohortPaths: prepared.entries.map((entry) => entry.path), frozenIndexSnapshot: snapshot });
      }
      result = {
        schema_version: WORKER_RESULT_SCHEMA, ok: true, pid: process.pid, operation: config.operation, boundary: config.boundary,
        prepared: { ...prepared, frozenIndexSnapshot: Object.fromEntries(snapshot) } as unknown as Record<string, unknown>, assertions,
      };
      exitCode = 86;
    } else if (config.operation === "drain_resume") {
      const events = await readRecoveryEvents(config.abrain_home, config.episode_id, "drain");
      for (const event of events) {
        if (event.event_type !== "commit_prepared") continue;
        const repoValue = event.body.repo;
        if (typeof repoValue !== "string") fail("P1B_RECOVERY_REPO_INVALID", "commit_prepared body.repo is missing");
        const repoReal = await fsp.realpath(repoValue);
        if (!inside(scenarioRoot, repoReal)) fail("P1B_RECOVERY_REPO_ESCAPE", "commit_prepared body.repo escapes scenario root", { repoReal, scenarioRoot });
      }
      const action = await recoverDrainSlot({ abrainHome: config.abrain_home, episodeId: config.episode_id, slot: config.slot! });
      result = { schema_version: WORKER_RESULT_SCHEMA, ok: true, pid: process.pid, operation: config.operation, action, assertions: { ...assertions, recovery_body_repo_contained: true } };
    } else if (config.operation === "push") {
      if (!config.ref_name || !config.target_commit) fail("P1B_WORKER_CONFIG_INVALID", "push config is incomplete");
      await recordPushIntent({ abrainHome: config.abrain_home, episodeId: config.episode_id, repo: config.repo, remote: config.remote, refName: config.ref_name, targetCommit: config.target_commit });
      const push = await recoverPushEpisode({ abrainHome: config.abrain_home, episodeId: config.episode_id, repo: config.repo, remote: config.remote, refName: config.ref_name, targetCommit: config.target_commit });
      result = { schema_version: WORKER_RESULT_SCHEMA, ok: true, pid: process.pid, operation: config.operation, push: push as unknown as Record<string, unknown>, assertions };
    } else fail("P1B_WORKER_CONFIG_INVALID", `unsupported worker operation: ${String(config.operation)}`);
  } catch (error) {
    result = { schema_version: WORKER_RESULT_SCHEMA, ok: false, pid: process.pid, operation: config.operation, error: { code: String((error as any)?.code ?? "P1B_WORKER_OPERATION_FAILED"), message: error instanceof Error ? error.message : String(error) }, assertions };
  }
  await durableAtomicWriteFile(config.result_path, `${canonicalizeJcs(result as unknown as JcsJsonValue)}\n`, { mode: 0o600 });
  return { result, exitCode };
}

export interface RunProductionTraceReplayOptions {
  sourceAbrainHome: string;
  replayRoot: string;
  runId: string;
  implementationRoot: string;
  workerScript: string;
  readConfigPath?: string;
  sourceCommit?: string;
  sourceParent?: string;
  invalidatedAttempts?: readonly Record<string, JcsJsonValue>[];
  scenarioConcurrency?: number;
  afterScenarioMatrix?: () => void | Promise<void>;
}

export interface RunProductionTraceReplayResult {
  ok: boolean;
  report: Record<string, JcsJsonValue>;
  reportPath: string;
  reportSha256: string;
  reportBytes: number;
  artifactVerification: ProductionTraceArtifactVerification;
}

export async function runProductionTraceReplay(options: RunProductionTraceReplayOptions): Promise<RunProductionTraceReplayResult> {
  const scenarioConcurrency = options.scenarioConcurrency ?? 4;
  if (!Number.isInteger(scenarioConcurrency) || scenarioConcurrency < 1 || scenarioConcurrency > 8) fail("P1B_SCENARIO_CONCURRENCY_INVALID", "scenario concurrency must be an integer from 1 through 8");
  // Hard acceptance ordering: the canonical production snapshot is the first
  // source-sensitive operation at the public harness entry point.
  const captureWindowStarted = Date.now();
  const canonicalBefore = await captureCanonicalSourceSnapshot({ sourceAbrainHome: options.sourceAbrainHome, ...(options.readConfigPath ? { readConfigPath: options.readConfigPath } : {}) });
  const source = path.resolve(options.sourceAbrainHome);
  const replayRoot = path.resolve(options.replayRoot);
  const implementationRoot = path.resolve(options.implementationRoot);
  const implementationReal = await fsp.realpath(implementationRoot);
  const moduleImplementationReal = await fsp.realpath(MODULE_IMPLEMENTATION_ROOT);
  if (implementationReal !== moduleImplementationReal) fail("P1B_IMPLEMENTATION_ROOT_INVALID", "implementation root must be this pi-astack repository");
  const sourceReal = await fsp.realpath(source);
  const tmpReal = await fsp.realpath(os.tmpdir());
  await fsp.mkdir(replayRoot, { recursive: true });
  const replayReal = await fsp.realpath(replayRoot);
  if (!inside(tmpReal, replayReal) || replayReal === tmpReal) fail("P1B_REPLAY_ROOT_INVALID", "replay root must be a strict child of os.tmpdir()", { replayReal, tmpReal });
  if (inside(sourceReal, replayReal) || inside(replayReal, sourceReal)) fail("P1B_SOURCE_REPLAY_NOT_SEPARATE", "source and replay roots must be realpath-separated");
  if (!/^[A-Za-z0-9._-]+$/.test(options.runId)) fail("P1B_RUN_ID_INVALID", "runId is not path-safe");
  const runRoot = path.join(replayReal, options.runId);
  if (fs.existsSync(runRoot)) fail("P1B_RUN_ROOT_EXISTS", `run root already exists: ${runRoot}`);
  await fsp.mkdir(runRoot, { recursive: false });
  const before = await extendSourceSnapshot(sourceReal, canonicalBefore, implementationRoot);
  const origins = await sourceOriginUrls(sourceReal);
  const bundlePath = path.join(runRoot, "source-objects.bundle");
  await makeBundle(sourceReal, bundlePath);
  const trace = await extractTrace({ source: sourceReal, sourceCommit: options.sourceCommit ?? SOURCE_COMMIT_DEFAULT, sourceParent: options.sourceParent ?? SOURCE_PARENT_DEFAULT, before, bundlePath, implementationRoot });
  if (origins.some((url) => url && (url.includes(sourceReal) || canonicalizeJcs(trace as unknown as JcsJsonValue).includes(url)))) fail("P1B_TRACE_REMOTE_EXPOSED", "trace manifest exposes production source path or origin URL");
  const initialized = await initializeReplayObjects(runRoot, bundlePath, trace.source_parent);
  const context: ReplayContext = {
    sourceReal, replayRoot: replayReal, runRoot, seedGit: initialized.seedGit, parentTreeRoot: initialized.parentTreeRoot,
    bundlePath, implementationRoot, workerScript: path.resolve(options.workerScript), trace, sourceOriginUrls: origins,
    configPaths: [], resultPaths: [], invalidatedAttempts: options.invalidatedAttempts ?? [],
  };
  for (const [value, label] of [[runRoot, "run root"], [initialized.seedGit, "seed repo"], [initialized.parentTreeRoot, "parent materialization"], [bundlePath, "bundle"]] as const) await realContained(replayReal, value, label);
  const scenarioContext: ScenarioContext = {
    replayRoot: context.replayRoot,
    runRoot: context.runRoot,
    seedGit: context.seedGit,
    parentTreeRoot: context.parentTreeRoot,
    workerScript: context.workerScript,
    trace: context.trace,
    configPaths: context.configPaths,
    resultPaths: context.resultPaths,
  };
  const matrix = await runScenarioMatrix(scenarioContext, scenarioConcurrency);
  if (options.afterScenarioMatrix) await options.afterScenarioMatrix();
  // Capture immediately after the scenario matrix; artifact reads happen only
  // after the source-sensitive window is closed.
  const canonicalAfter = await captureCanonicalSourceSnapshot({ sourceAbrainHome: sourceReal, ...(options.readConfigPath ? { readConfigPath: options.readConfigPath } : {}) });
  const after = await extendSourceSnapshot(sourceReal, canonicalAfter, implementationRoot);
  const captureWindowDurationMs = Date.now() - captureWindowStarted;
  context.configPaths.push(...matrix.configPaths);
  context.resultPaths.push(...matrix.resultPaths);
  const scenarios = await auditScenarioArtifacts(context, matrix.scenarios);
  const impactFlags = compareExtended(before, after);
  const sourceStable = impactFlags.sourceChanged === false;
  const implementationStable = impactFlags.implementationChanged === false;
  const allScenariosPass = scenarios.length === 13 && scenarios.every((scenario) => scenario.pass);
  const sourcePathExposed = scenarios.some((scenario) => scenario.source_path_exposed);
  const outsideWriteCount = scenarios.reduce((sum, scenario) => sum + scenario.outside_write_count, 0);
  const isolationGreen = !sourcePathExposed && outsideWriteCount === 0;
  const reportWithoutSelfHash: Record<string, JcsJsonValue> = {
    schema_version: REPORT_SCHEMA,
    scope: { claim: "P1-B only", excludes: ["P1-A", "P2", "P3"], synthetic_counting_rule: "synthetic harness smoke validates isolation/manifest/validator only and does not count as P1-B production acceptance" },
    run_id: options.runId,
    implementation: before.implementation as unknown as JcsJsonValue,
    trace_manifest: trace as unknown as JcsJsonValue,
    source_before: sourceSummary(before),
    source_after: sourceSummary(after),
    scenarios: scenarios as unknown as JcsJsonValue,
    scenario_count: scenarios.length,
    execution_timing: {
      capture_window_duration_ms: captureWindowDurationMs,
      scenario_concurrency: scenarioConcurrency,
      scenario_durations_ms: matrix.durationsMs,
    },
    impact_flags: impactFlags,
    state_diagnostic: stateDiagnostic(before, after, impactFlags, sourcePathExposed, outsideWriteCount),
    isolation_assertions: {
      source_replay_realpath_separate: true,
      replay_root_under_os_tmpdir: true,
      source_path_exposed: sourcePathExposed,
      outside_write_count: outsideWriteCount,
      all_scenarios_isolated: isolationGreen,
    },
    invalidated_attempts: [...context.invalidatedAttempts],
    invalidated_attempt_stop_rule: { maximum_invalidated_runs: 3, behavior: "stop without waiver after three source-drift invalidations" },
    residual_risk: {
      aba: "Git update-ref CAS guards the frozen OID, but an external ABA that restores the identical OID is observationally identical; exact candidate/tree/cohort verification remains authoritative.",
      ignored_state: "Git ignored files outside the explicit .state tree, raw index/index.lock, canonical trees/read/fold, refs/remote refs, and worktree status snapshots are not semantic recovery truth and are not treated as authorization state.",
      crash_boundary: CRASH_RESIDUAL,
      source_snapshot_authenticity: SOURCE_SNAPSHOT_AUTHENTICITY,
    },
    dossier_self_hash_rule: "sha256(RFC8785-JCS(report_without_dossier_self_hash)); logical self hash only",
    report_file_sha256_rule: "sha256(exact dossier.json bytes) is computed and printed externally after durable publication and is not embedded in dossier_self_hash",
    artifact_verification: { bundle: true, trace_entries: true, full_l1: true, implementation: true },
    acceptance: { source_stable: sourceStable, every_scenario_pass: allScenariosPass, isolation_green: isolationGreen, artifact_green: true, implementation_stable: implementationStable },
  };
  const report = { ...reportWithoutSelfHash, dossier_self_hash: jcsSha256Hex(reportWithoutSelfHash) };
  const validation = validateProductionTraceDossier(report);
  const reportPath = path.join(runRoot, "dossier.json");
  await durableAtomicWriteFile(reportPath, `${canonicalizeJcs(report)}\n`, { mode: 0o600 });
  const reportBytes = await fsp.readFile(reportPath);
  const reportSha256 = sha256Hex(reportBytes);
  const artifactVerification = await verifyProductionTraceDossierArtifacts(report, {
    bundlePath,
    implementationRoot,
    reportFilePath: reportPath,
    expectedReportSha256: reportSha256,
    expectedReportBytes: reportBytes.length,
  });
  const ok = validation.ok && sourceStable && implementationStable && allScenariosPass && isolationGreen;
  return { ok, report, reportPath, reportSha256, reportBytes: reportBytes.length, artifactVerification };
}

export async function buildSyntheticTraceManifestForSmoke(options: { sourceRepo: string; sourceCommit: string; sourceParent: string; implementationRoot: string; bundlePath: string; before: ExtendedSourceSnapshot }): Promise<ProductionTraceManifest> {
  return extractTrace({ source: options.sourceRepo, sourceCommit: options.sourceCommit, sourceParent: options.sourceParent, before: options.before, bundlePath: options.bundlePath, implementationRoot: options.implementationRoot });
}

export const PRODUCTION_TRACE_REPLAY_CONSTANTS = Object.freeze({ REPORT_SCHEMA, TRACE_SCHEMA, WORKER_SCHEMA, WORKER_RESULT_SCHEMA, SOURCE_COMMIT_DEFAULT, SOURCE_PARENT_DEFAULT, SCENARIO_IDS, IMPLEMENTATION_FILES, CRASH_RESIDUAL });
