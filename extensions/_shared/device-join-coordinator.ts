import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONSTRAINT_L2_V1,
  KNOWLEDGE_L2_V1,
} from "./canonical-l2-contract";
import {
  assertCanonicalL2ReconcilerCoverage,
  buildCanonicalL2V1,
  selectCanonicalL2ReconcilerVersions,
} from "./canonical-l2-reconciler";
import {
  assertCanonicalMutationBarrierHeld,
  withCanonicalMutationBarrier,
} from "./canonical-mutation-barrier";
import { durableAtomicCreateFile, durableAtomicWriteFile, fsyncDirectory } from "./durable-write";
import { decodeCanonicalGitPath, parseGitStatusPorcelainV1Z } from "./git-z-parser";
import { scanWholeL1Validated, type WholeL1ScanResult } from "./l1-schema-registry";

const L1_PREFIX = "l1/events/sha256/";
const JOURNAL_RELATIVE = ".state/device-join-journal.v1.json";
const LEGACY_KNOWLEDGE_MANIFEST_IGNORE = `${KNOWLEDGE_L2_V1.canonicalRoot}/${KNOWLEDGE_L2_V1.manifestName}`;
const ATOMIC_TEMP_PROTOCOL = "pi-astack-device-join-atomic-v1";
const JOIN_MESSAGE = "pi-astack: deterministic device join\n";
const CANONICALIZE_MESSAGE = "pi-astack: canonical L2 migration\n";
const JOIN_DATE = "2000-01-01T00:00:00Z";
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;

export interface DeviceJoinTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

export type DeviceJoinTreeMap = ReadonlyMap<string, DeviceJoinTreeEntry>;

export class DeviceJoinError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "DeviceJoinError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface PreparedDeviceJoin {
  readonly status: "noop" | "fast_forward" | "join" | "canonicalize";
  readonly repo: string;
  readonly refName: string;
  readonly base: string;
  readonly localHead: string;
  readonly upstreamHead: string;
  readonly candidate: string;
  readonly tree: string;
  readonly candidateMap: DeviceJoinTreeMap;
}

export interface DeviceJoinPublishResult {
  readonly status: "noop" | "published" | "stale";
  readonly head: string;
  readonly candidate?: string;
}

interface DeviceJoinJournalEntry {
  path: string;
  before: DeviceJoinTreeEntry | null;
  after: DeviceJoinTreeEntry | null;
}

interface DeviceJoinJournal {
  schema_version: "abrain-device-join-journal/v1";
  ref_name: string;
  base: string;
  local_head: string;
  upstream_head: string;
  candidate: string;
  candidate_tree: string;
  delta: DeviceJoinJournalEntry[];
}

export type DeviceJoinCrashPhase =
  | "journal_written"
  | "cas_published"
  | "path_materialized"
  | "index_converged"
  | "verified";

export interface DeviceJoinPublishOptions {
  settleCanonical?: () => Promise<void>;
  crashHook?: (phase: DeviceJoinCrashPhase, detail?: { path?: string }) => Promise<void> | void;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new DeviceJoinError(code, message, detail);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function localGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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
    ...extra,
  };
}

async function runGitBuffer(
  repo: string,
  args: readonly string[],
  options: { input?: Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number; literalPathspecs?: boolean } = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...(options.literalPathspecs === false ? [] : ["--literal-pathspecs"]), ...args], {
      env: options.env ?? localGitEnvironment(),
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 30_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT) child.kill("SIGTERM");
      else stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_GIT_OUTPUT) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut && stdoutBytes <= MAX_GIT_OUTPUT) resolve(Buffer.concat(stdout));
      else {
        const error = new Error(`git ${args[0] ?? "command"} failed (${timedOut ? "timeout" : signal ?? code}): ${Buffer.concat(stderr).toString("utf-8").trim()}`) as Error & { code?: number | string | null; stderr?: string };
        error.code = timedOut ? "ETIMEDOUT" : code;
        error.stderr = Buffer.concat(stderr).toString("utf-8");
        reject(error);
      }
    });
    if (options.input) child.stdin!.end(options.input);
  });
}

async function runGit(repo: string, args: readonly string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number; literalPathspecs?: boolean } = {}): Promise<string> {
  return (await runGitBuffer(repo, args, options)).toString("utf-8");
}

async function resolveCommit(repo: string, ref: string): Promise<string> {
  const oid = (await runGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`], { timeoutMs: 5_000 })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) fail("DEVICE_JOIN_BAD_OID", "git returned an invalid commit object id", { ref, oid });
  return oid;
}

async function resolveSymbolicHead(repo: string): Promise<string> {
  const refName = (await runGit(repo, ["symbolic-ref", "-q", "HEAD"], { timeoutMs: 5_000 })).trim();
  if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(refName) || refName.includes("..")) {
    fail("DEVICE_JOIN_REF_UNSAFE", "device join requires a safe attached branch", { refName });
  }
  return refName;
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant], { timeoutMs: 10_000 });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

function validTrackedPath(value: string): boolean {
  if (!value || value.includes("\0") || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && parts[0] !== ".git";
}

export async function readCompleteTreeMap(repo: string, commit: string): Promise<DeviceJoinTreeMap> {
  const raw = await runGitBuffer(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], { timeoutMs: 30_000 });
  const map = new Map<string, DeviceJoinTreeEntry>();
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    if (end < 0) fail("DEVICE_JOIN_TREE_PARSE", "ls-tree output is missing a NUL terminator");
    const record = raw.subarray(offset, end);
    offset = end + 1;
    if (!record.length) fail("DEVICE_JOIN_TREE_PARSE", "ls-tree returned an empty record");
    const tab = record.indexOf(0x09);
    if (tab <= 0) fail("DEVICE_JOIN_TREE_PARSE", "ls-tree record has no path separator");
    const header = record.subarray(0, tab).toString("ascii");
    const [mode, type, oid, ...extra] = header.split(" ");
    let trackedPath: string;
    try { trackedPath = decodeCanonicalGitPath(record.subarray(tab + 1)); }
    catch (error) { fail("DEVICE_JOIN_TREE_PATH_UNSAFE", "ls-tree returned a noncanonical path", { error: String(error) }); }
    if (extra.length || !mode || !type || !oid || !validTrackedPath(trackedPath) || map.has(trackedPath)) {
      fail("DEVICE_JOIN_TREE_PARSE", "ls-tree returned an unsafe or duplicate entry", { path: trackedPath });
    }
    if (!/^(100644|100755|120000|160000)$/.test(mode) || !/^(blob|commit)$/.test(type) || !/^[0-9a-f]{40,64}$/.test(oid)) {
      fail("DEVICE_JOIN_TREE_ENTRY_UNSUPPORTED", "tracked entry mode/type/object is unsupported", { path: trackedPath, mode, type, oid });
    }
    if ((mode === "160000") !== (type === "commit")) fail("DEVICE_JOIN_TREE_ENTRY_UNSUPPORTED", "gitlink mode/type mismatch", { path: trackedPath });
    map.set(trackedPath, Object.freeze({ mode, type, oid }));
  }
  return map;
}

function sameEntry(left: DeviceJoinTreeEntry | undefined | null, right: DeviceJoinTreeEntry | undefined | null): boolean {
  return left === right || (!!left && !!right && left.mode === right.mode && left.type === right.type && left.oid === right.oid);
}

function isL1(trackedPath: string): boolean {
  return trackedPath.startsWith(L1_PREFIX);
}

export function isRegisteredCanonicalL2Path(trackedPath: string): boolean {
  return trackedPath === KNOWLEDGE_L2_V1.canonicalRoot
    || trackedPath.startsWith(`${KNOWLEDGE_L2_V1.canonicalRoot}/`)
    || trackedPath === CONSTRAINT_L2_V1.canonicalRoot
    || trackedPath.startsWith(`${CONSTRAINT_L2_V1.canonicalRoot}/`);
}

function unionL1(
  base: DeviceJoinTreeMap,
  local: DeviceJoinTreeMap,
  upstream: DeviceJoinTreeMap,
): Map<string, DeviceJoinTreeEntry> {
  const output = new Map<string, DeviceJoinTreeEntry>();
  const paths = new Set([...base.keys(), ...local.keys(), ...upstream.keys()].filter(isL1));
  for (const trackedPath of [...paths].sort(compareAscii)) {
    const b = base.get(trackedPath);
    const h = local.get(trackedPath);
    const u = upstream.get(trackedPath);
    if (b && (!sameEntry(b, h) || !sameEntry(b, u))) {
      fail("DEVICE_JOIN_L1_NOT_ADD_ONLY", "L1 history modified or deleted an existing path", { path: trackedPath });
    }
    if (!b && h && u && !sameEntry(h, u)) {
      fail("DEVICE_JOIN_L1_COLLISION", "both devices added the same L1 path with different mode/blob", { path: trackedPath });
    }
    const selected = h ?? u;
    if (selected) {
      if (selected.type !== "blob" || (selected.mode !== "100644" && selected.mode !== "100755")) {
        fail("DEVICE_JOIN_L1_TYPE_UNSUPPORTED", "L1 union accepts only regular blob entries", { path: trackedPath, mode: selected.mode, type: selected.type });
      }
      output.set(trackedPath, selected);
    }
  }
  return output;
}

async function readBlob(repo: string, oid: string): Promise<Buffer> {
  return runGitBuffer(repo, ["cat-file", "blob", oid], { timeoutMs: 30_000 });
}

async function readCandidateGitignore(repo: string, candidate: DeviceJoinTreeMap): Promise<{ entry: DeviceJoinTreeEntry; raw: string }> {
  const entry = candidate.get(".gitignore");
  if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    fail("DEVICE_JOIN_STATE_IGNORE_REQUIRED", "candidate tree must retain a regular .gitignore");
  }
  try {
    return { entry, raw: new TextDecoder("utf-8", { fatal: true }).decode(await readBlob(repo, entry.oid)) };
  } catch (error) {
    fail("DEVICE_JOIN_STATE_IGNORE_REQUIRED", "candidate .gitignore is not valid UTF-8", { error: String(error) });
  }
}

async function removeLegacyManifestIgnoreFromCandidate(repo: string, candidate: DeviceJoinTreeMap): Promise<Map<string, DeviceJoinTreeEntry>> {
  if (!candidate.has(LEGACY_KNOWLEDGE_MANIFEST_IGNORE)) return new Map(candidate);
  const { entry, raw } = await readCandidateGitignore(repo, candidate);
  const lines = raw.split("\n");
  const retained = lines.filter((line) => line.replace(/\r$/, "") !== LEGACY_KNOWLEDGE_MANIFEST_IGNORE);
  if (retained.length === lines.length) return new Map(candidate);
  const next = new Map(candidate);
  const oid = await hashBlob(repo, Buffer.from(retained.join("\n"), "utf-8"));
  next.set(".gitignore", Object.freeze({ ...entry, oid }));
  return next;
}

async function validateCandidateRepositoryContract(repo: string, candidate: DeviceJoinTreeMap): Promise<void> {
  const { raw } = await readCandidateGitignore(repo, candidate);
  if (!/(^|\n)\.state\/?(\n|$)/.test(raw)) {
    fail("DEVICE_JOIN_STATE_IGNORE_REQUIRED", "candidate .gitignore must retain the exact .state/ exclusion");
  }
  if (candidate.has(LEGACY_KNOWLEDGE_MANIFEST_IGNORE)
    && raw.split("\n").some((line) => line.replace(/\r$/, "") === LEGACY_KNOWLEDGE_MANIFEST_IGNORE)) {
    fail("DEVICE_JOIN_MANIFEST_IGNORE_RETAINED", "tracked canonical Knowledge manifest must not retain the legacy per-device ignore line");
  }
}

async function hashBlob(repo: string, bytes: Buffer): Promise<string> {
  const oid = (await runGit(repo, ["hash-object", "-w", "--stdin"], { input: bytes, timeoutMs: 30_000 })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) fail("DEVICE_JOIN_BAD_OID", "hash-object returned an invalid blob id", { oid });
  return oid;
}

async function validateParentL2Version(repo: string, map: DeviceJoinTreeMap): Promise<void> {
  const knowledgeMarkdown: string[] = [];
  let knowledgeManifest: string | null = null;
  let constraintMarkdown: string | null = null;
  for (const [trackedPath, entry] of map) {
    if (!isRegisteredCanonicalL2Path(trackedPath)) continue;
    if (entry.type !== "blob") fail("DEVICE_JOIN_L2_TYPE_UNSUPPORTED", "registered L2 must be blob-backed", { path: trackedPath });
    const text = (await readBlob(repo, entry.oid)).toString("utf-8");
    if (trackedPath === `${KNOWLEDGE_L2_V1.canonicalRoot}/${KNOWLEDGE_L2_V1.manifestName}`) knowledgeManifest = text;
    else if (trackedPath.startsWith(`${KNOWLEDGE_L2_V1.canonicalRoot}/`) && trackedPath.endsWith(".md")) knowledgeMarkdown.push(text);
    else if (trackedPath === CONSTRAINT_L2_V1.canonicalPath) constraintMarkdown = text;
  }
  selectCanonicalL2ReconcilerVersions({
    knowledgeMarkdown,
    knowledgeManifest,
    constraintMarkdown,
    constraintSourceTemplateVersions: [],
  });
}

async function buildRegisteredL2FromUnion(
  repo: string,
  l1: ReadonlyMap<string, DeviceJoinTreeEntry>,
  local: DeviceJoinTreeMap,
  upstream: DeviceJoinTreeMap,
): Promise<Map<string, DeviceJoinTreeEntry>> {
  assertCanonicalL2ReconcilerCoverage();
  await Promise.all([validateParentL2Version(repo, local), validateParentL2Version(repo, upstream)]);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-device-join-l1-"));
  try {
    for (const [trackedPath, entry] of l1) {
      const target = path.join(tempRoot, ...trackedPath.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await readBlob(repo, entry.oid), { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    const scan = await scanWholeL1Validated({ abrainHome: tempRoot });
    const templateVersions = scan.selected
      .filter((record) => record.registration.envelope_schema === "constraint-projection-envelope/v1")
      .map((record) => String(record.body.template_version ?? ""));
    selectCanonicalL2ReconcilerVersions({
      knowledgeMarkdown: [],
      knowledgeManifest: null,
      constraintMarkdown: null,
      constraintSourceTemplateVersions: templateVersions,
    });
    const rendered = buildCanonicalL2V1(scan as WholeL1ScanResult);
    const output = new Map<string, DeviceJoinTreeEntry>();
    for (const [trackedPath, bytes] of rendered) {
      output.set(trackedPath, Object.freeze({ mode: "100644", type: "blob", oid: await hashBlob(repo, bytes) }));
    }
    return output;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function validateLinearCanonicalTransition(
  repo: string,
  base: DeviceJoinTreeMap,
  candidate: DeviceJoinTreeMap,
): Promise<void> {
  const l1 = unionL1(base, base, candidate);
  const rebuiltL2 = await buildRegisteredL2FromUnion(repo, l1, base, candidate);
  const actualL2 = new Map([...candidate].filter(([trackedPath]) => isRegisteredCanonicalL2Path(trackedPath)));
  assertMapExact(rebuiltL2, actualL2, "DEVICE_JOIN_LINEAR_L2_MISMATCH");
}

function mergeOrdinaryPaths(
  base: DeviceJoinTreeMap,
  local: DeviceJoinTreeMap,
  upstream: DeviceJoinTreeMap,
): Map<string, DeviceJoinTreeEntry> {
  const output = new Map<string, DeviceJoinTreeEntry>();
  const paths = new Set([...base.keys(), ...local.keys(), ...upstream.keys()].filter((trackedPath) => !isL1(trackedPath) && !isRegisteredCanonicalL2Path(trackedPath)));
  for (const trackedPath of [...paths].sort(compareAscii)) {
    const b = base.get(trackedPath);
    const h = local.get(trackedPath);
    const u = upstream.get(trackedPath);
    const hChanged = !sameEntry(b, h);
    const uChanged = !sameEntry(b, u);
    let selected: DeviceJoinTreeEntry | undefined;
    if (!hChanged && !uChanged) selected = b;
    else if (hChanged && !uChanged) selected = h;
    else if (!hChanged && uChanged) selected = u;
    else if (sameEntry(h, u)) selected = h;
    else fail("DEVICE_JOIN_TRACKED_CONFLICT", "ordinary tracked path changed differently on both devices", { path: trackedPath });
    if (selected) output.set(trackedPath, selected);
  }
  return output;
}

async function assembleTree(repo: string, map: DeviceJoinTreeMap): Promise<string> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-device-join-index-"));
  const index = path.join(temp, "index");
  const env = localGitEnvironment({ GIT_INDEX_FILE: index });
  try {
    await runGit(repo, ["read-tree", "--empty"], { env });
    const records: Buffer[] = [];
    for (const [trackedPath, entry] of [...map].sort(([left], [right]) => compareAscii(left, right))) {
      records.push(Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t${trackedPath}\0`, "utf-8"));
    }
    if (records.length) await runGit(repo, ["update-index", "-z", "--index-info"], { env, input: Buffer.concat(records) });
    const tree = (await runGit(repo, ["write-tree"], { env })).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) fail("DEVICE_JOIN_BAD_OID", "write-tree returned an invalid tree id", { tree });
    const rebuilt = await readCompleteTreeMap(repo, tree);
    assertMapExact(map, rebuilt, "DEVICE_JOIN_CANDIDATE_TREE_MISMATCH");
    return tree;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function assertMapExact(expected: DeviceJoinTreeMap, actual: DeviceJoinTreeMap, code: string): void {
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  const mismatches = [...paths].filter((trackedPath) => !sameEntry(expected.get(trackedPath), actual.get(trackedPath))).sort(compareAscii);
  if (mismatches.length) fail(code, "tree map has missing, extra, or different entries", { paths: mismatches.slice(0, 20), count: mismatches.length });
}

function deterministicCommitEnvironment(): NodeJS.ProcessEnv {
  return localGitEnvironment({
    GIT_AUTHOR_NAME: "pi-astack device join",
    GIT_AUTHOR_EMAIL: "device-join@pi-astack.invalid",
    GIT_COMMITTER_NAME: "pi-astack device join",
    GIT_COMMITTER_EMAIL: "device-join@pi-astack.invalid",
    GIT_AUTHOR_DATE: JOIN_DATE,
    GIT_COMMITTER_DATE: JOIN_DATE,
  });
}

async function createJoinCommit(repo: string, tree: string, localHead: string, upstreamHead: string): Promise<string> {
  const candidate = (await runGit(repo, ["commit-tree", tree, "-p", localHead, "-p", upstreamHead], {
    env: deterministicCommitEnvironment(),
    input: Buffer.from(JOIN_MESSAGE, "utf-8"),
  })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(candidate)) fail("DEVICE_JOIN_BAD_OID", "commit-tree returned an invalid commit id", { candidate });
  return candidate;
}

async function createCanonicalizationCommit(repo: string, tree: string, parent: string): Promise<string> {
  const candidate = (await runGit(repo, ["commit-tree", tree, "-p", parent], {
    env: deterministicCommitEnvironment(),
    input: Buffer.from(CANONICALIZE_MESSAGE, "utf-8"),
  })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(candidate)) fail("DEVICE_JOIN_BAD_OID", "commit-tree returned an invalid canonicalization commit id", { candidate });
  return candidate;
}

export async function prepareDeviceJoin(options: { repo: string; upstreamRef?: string }): Promise<PreparedDeviceJoin> {
  const repo = await fs.realpath(path.resolve(options.repo));
  const refName = await resolveSymbolicHead(repo);
  const localHead = await resolveCommit(repo, "HEAD");
  const upstreamHead = await resolveCommit(repo, options.upstreamRef ?? "@{upstream}");
  if (localHead === upstreamHead) {
    const currentMap = await readCompleteTreeMap(repo, localHead);
    const candidateMap = await removeLegacyManifestIgnoreFromCandidate(repo, currentMap);
    await validateCandidateRepositoryContract(repo, candidateMap);
    if (sameEntry(candidateMap.get(".gitignore"), currentMap.get(".gitignore"))) {
      const tree = (await runGit(repo, ["rev-parse", `${localHead}^{tree}`])).trim();
      return Object.freeze({ status: "noop", repo, refName, base: localHead, localHead, upstreamHead, candidate: localHead, tree, candidateMap });
    }
    const tree = await assembleTree(repo, candidateMap);
    const candidate = await createCanonicalizationCommit(repo, tree, localHead);
    return Object.freeze({ status: "canonicalize", repo, refName, base: localHead, localHead, upstreamHead, candidate, tree, candidateMap });
  }
  if (await isAncestor(repo, upstreamHead, localHead)) {
    const [baseMap, localMap] = await Promise.all([readCompleteTreeMap(repo, upstreamHead), readCompleteTreeMap(repo, localHead)]);
    await validateLinearCanonicalTransition(repo, baseMap, localMap);
    const candidateMap = await removeLegacyManifestIgnoreFromCandidate(repo, localMap);
    await validateCandidateRepositoryContract(repo, candidateMap);
    if (sameEntry(candidateMap.get(".gitignore"), localMap.get(".gitignore"))) {
      const tree = (await runGit(repo, ["rev-parse", `${localHead}^{tree}`])).trim();
      return Object.freeze({ status: "noop", repo, refName, base: upstreamHead, localHead, upstreamHead, candidate: localHead, tree, candidateMap });
    }
    const tree = await assembleTree(repo, candidateMap);
    const candidate = await createCanonicalizationCommit(repo, tree, localHead);
    return Object.freeze({ status: "canonicalize", repo, refName, base: upstreamHead, localHead, upstreamHead, candidate, tree, candidateMap });
  }
  if (await isAncestor(repo, localHead, upstreamHead)) {
    const [baseMap, upstreamMap] = await Promise.all([readCompleteTreeMap(repo, localHead), readCompleteTreeMap(repo, upstreamHead)]);
    await validateLinearCanonicalTransition(repo, baseMap, upstreamMap);
    const candidateMap = await removeLegacyManifestIgnoreFromCandidate(repo, upstreamMap);
    await validateCandidateRepositoryContract(repo, candidateMap);
    if (sameEntry(candidateMap.get(".gitignore"), upstreamMap.get(".gitignore"))) {
      const tree = (await runGit(repo, ["rev-parse", `${upstreamHead}^{tree}`])).trim();
      return Object.freeze({ status: "fast_forward", repo, refName, base: localHead, localHead, upstreamHead, candidate: upstreamHead, tree, candidateMap });
    }
    const tree = await assembleTree(repo, candidateMap);
    const candidate = await createCanonicalizationCommit(repo, tree, upstreamHead);
    return Object.freeze({ status: "canonicalize", repo, refName, base: localHead, localHead, upstreamHead, candidate, tree, candidateMap });
  }
  const bases = (await runGit(repo, ["merge-base", "--all", localHead, upstreamHead], { timeoutMs: 30_000 }))
    .trim().split(/\s+/).filter(Boolean);
  if (bases.length !== 1) fail("DEVICE_JOIN_MERGE_BASE_AMBIGUOUS", "divergent heads require exactly one merge base", { bases });
  const base = bases[0]!;
  const [baseMap, localMap, upstreamMap] = await Promise.all([
    readCompleteTreeMap(repo, base),
    readCompleteTreeMap(repo, localHead),
    readCompleteTreeMap(repo, upstreamHead),
  ]);
  const l1 = unionL1(baseMap, localMap, upstreamMap);
  const l2 = await buildRegisteredL2FromUnion(repo, l1, localMap, upstreamMap);
  const ordinary = mergeOrdinaryPaths(baseMap, localMap, upstreamMap);
  const candidateMap = await removeLegacyManifestIgnoreFromCandidate(
    repo,
    new Map<string, DeviceJoinTreeEntry>([...ordinary, ...l1, ...l2]),
  );
  const expectedL1 = new Map([...localMap, ...upstreamMap].filter(([trackedPath]) => isL1(trackedPath)));
  assertMapExact(l1, expectedL1, "DEVICE_JOIN_L1_UNION_MISMATCH");
  for (const trackedPath of candidateMap.keys()) {
    if (isRegisteredCanonicalL2Path(trackedPath) && !l2.has(trackedPath)) fail("DEVICE_JOIN_L2_EXTRA", "candidate retained an unregistered-parent L2 path", { path: trackedPath });
  }
  await validateCandidateRepositoryContract(repo, candidateMap);
  const tree = await assembleTree(repo, candidateMap);
  const candidate = await createJoinCommit(repo, tree, localHead, upstreamHead);
  assertMapExact(candidateMap, await readCompleteTreeMap(repo, candidate), "DEVICE_JOIN_CANDIDATE_COMMIT_MISMATCH");
  return Object.freeze({ status: "join", repo, refName, base, localHead, upstreamHead, candidate, tree, candidateMap });
}

function journalPath(repo: string): string {
  return path.join(repo, ...JOURNAL_RELATIVE.split("/"));
}

function treeDelta(before: DeviceJoinTreeMap, after: DeviceJoinTreeMap): DeviceJoinJournalEntry[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort(compareAscii)
    .filter((trackedPath) => !sameEntry(before.get(trackedPath), after.get(trackedPath)))
    .map((trackedPath) => ({ path: trackedPath, before: before.get(trackedPath) ?? null, after: after.get(trackedPath) ?? null }));
}

function canonicalJournalJson(journal: DeviceJoinJournal): string {
  return `${JSON.stringify(journal)}\n`;
}

async function readJournal(repo: string): Promise<DeviceJoinJournal | null> {
  let raw: string;
  try { raw = await fs.readFile(journalPath(repo), "utf-8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("DEVICE_JOIN_JOURNAL_INVALID", "device join journal is not JSON"); }
  const journal = value as DeviceJoinJournal;
  if (!journal || journal.schema_version !== "abrain-device-join-journal/v1" || !Array.isArray(journal.delta)
    || !/^refs\/heads\//.test(journal.ref_name) || ![journal.base, journal.local_head, journal.upstream_head, journal.candidate, journal.candidate_tree].every((oid) => /^[0-9a-f]{40,64}$/.test(oid))) {
    fail("DEVICE_JOIN_JOURNAL_INVALID", "device join journal shape is invalid");
  }
  if (canonicalJournalJson(journal) !== raw) fail("DEVICE_JOIN_JOURNAL_NONCANONICAL", "device join journal bytes are not canonical");
  return journal;
}

async function writeJournal(repo: string, journal: DeviceJoinJournal): Promise<void> {
  const state = path.dirname(journalPath(repo));
  await fs.mkdir(state, { recursive: true });
  const stat = await fs.lstat(state);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("DEVICE_JOIN_STATE_UNSAFE", ".state must be a real directory");
  await durableAtomicWriteFile(journalPath(repo), canonicalJournalJson(journal), { mode: 0o600 });
}

async function clearJournal(repo: string): Promise<void> {
  try {
    await fs.unlink(journalPath(repo));
    await fsyncDirectory(path.dirname(journalPath(repo)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function sharedIndexTree(repo: string): Promise<string> {
  const tree = (await runGit(repo, ["write-tree"], { timeoutMs: 30_000 })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) fail("DEVICE_JOIN_INDEX_INVALID", "shared index did not write a tree", { tree });
  return tree;
}

async function expectedBlobBytes(repo: string, entry: DeviceJoinTreeEntry): Promise<Buffer> {
  if (entry.type !== "blob") fail("DEVICE_JOIN_MATERIALIZE_UNSUPPORTED", "changed gitlinks cannot be materialized", { entry });
  return readBlob(repo, entry.oid);
}

async function assertMaterializableDelta(repo: string, delta: readonly DeviceJoinJournalEntry[]): Promise<void> {
  for (const item of delta) {
    if (item.before?.mode === "160000" || item.after?.mode === "160000") {
      fail("DEVICE_JOIN_MATERIALIZE_UNSUPPORTED", "changed gitlinks must fail before journal publication", { path: item.path });
    }
    if (!item.after) continue;
    const bytes = await expectedBlobBytes(repo, item.after);
    if (item.after.mode === "120000" && (bytes.length === 0 || bytes.includes(0))) {
      fail("DEVICE_JOIN_SYMLINK_TARGET_UNSUPPORTED", "symlink target cannot be materialized by the host filesystem", { path: item.path });
    }
  }
}

async function lstatOrNull(target: string): Promise<fsSync.Stats | null> {
  try { return await fs.lstat(target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function worktreeMatches(repo: string, trackedPath: string, entry: DeviceJoinTreeEntry | null): Promise<boolean> {
  const target = path.join(repo, ...trackedPath.split("/"));
  const stat = await lstatOrNull(target);
  if (!entry) return stat === null || (stat.isDirectory() && !stat.isSymbolicLink());
  if (!stat) return false;
  if (entry.mode === "160000") {
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    try { return await resolveCommit(target, "HEAD") === entry.oid; } catch { return false; }
  }
  const bytes = await expectedBlobBytes(repo, entry);
  if (entry.mode === "120000") {
    if (!stat.isSymbolicLink()) return false;
    return Buffer.from(await fs.readlink(target), "utf-8").equals(bytes);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const mode = (stat.mode & 0o111) ? "100755" : "100644";
  return mode === entry.mode && (await fs.readFile(target)).equals(bytes);
}

async function assertDirectoryReplacementInventory(
  repo: string,
  delta: readonly DeviceJoinJournalEntry[],
  additionallyRemovable: readonly string[] = [],
): Promise<void> {
  const deleted = new Set([
    ...delta.filter((item) => item.after === null).map((item) => item.path),
    ...additionallyRemovable,
  ]);
  for (const item of delta) {
    if (!item.after) continue;
    const target = path.join(repo, ...item.path.split("/"));
    const stat = await lstatOrNull(target);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    const walk = async (directory: string): Promise<void> => {
      for (const child of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, child.name);
        if (child.isDirectory() && !child.isSymbolicLink()) await walk(absolute);
        else {
          const relative = path.relative(repo, absolute).split(path.sep).join("/");
          if (!deleted.has(relative)) {
            fail("DEVICE_JOIN_DIRECTORY_REPLACE_DIRTY", "directory-to-file transition contains an unknown or retained leaf", { path: item.path, leaf: relative });
          }
        }
      }
    };
    await walk(target);
  }
}

async function assertNoSymlinkParent(repo: string, trackedPath: string): Promise<void> {
  let current = repo;
  const parts = trackedPath.split("/").slice(0, -1);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) {
      await fs.mkdir(current);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("DEVICE_JOIN_WORKTREE_PARENT_UNSAFE", "tracked path parent is not a real directory", { path: trackedPath, parent: current });
  }
}

async function pruneEmptyParents(repo: string, start: string): Promise<void> {
  let current = start;
  while (current !== repo && current.startsWith(`${repo}${path.sep}`)) {
    const parent = path.dirname(current);
    try {
      await fs.rmdir(current);
      await fsyncDirectory(parent);
      current = parent;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") { current = parent; continue; }
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      throw error;
    }
  }
}

async function removeEmptyDirectoryTree(directory: string): Promise<void> {
  for (const child of await fs.readdir(directory, { withFileTypes: true })) {
    if (!child.isDirectory() || child.isSymbolicLink()) {
      fail("DEVICE_JOIN_REPLACE_TYPE_UNSAFE", "directory replacement retained a non-directory leaf", { directory, child: child.name });
    }
    await removeEmptyDirectoryTree(path.join(directory, child.name));
  }
  await fs.rmdir(directory);
}

function atomicTempPath(repo: string, trackedPath: string, entry: DeviceJoinTreeEntry): string {
  const target = path.join(repo, ...trackedPath.split("/"));
  return path.join(path.dirname(target), `.${path.basename(target)}.${ATOMIC_TEMP_PROTOCOL}.${entry.oid}.tmp`);
}

async function atomicMaterialize(repo: string, trackedPath: string, entry: DeviceJoinTreeEntry | null): Promise<void> {
  const target = path.join(repo, ...trackedPath.split("/"));
  if (!entry) {
    const stat = await lstatOrNull(target);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) fail("DEVICE_JOIN_DELETE_TYPE_UNSAFE", "tracked file deletion encountered a directory", { path: trackedPath });
    if (stat) {
      const parent = path.dirname(target);
      await fs.unlink(target);
      await fsyncDirectory(parent);
      await pruneEmptyParents(repo, parent);
    }
    return;
  }
  if (entry.mode === "160000") fail("DEVICE_JOIN_MATERIALIZE_UNSUPPORTED", "changed gitlinks are unsupported", { path: trackedPath });
  await assertNoSymlinkParent(repo, trackedPath);
  const existing = await lstatOrNull(target);
  if (existing?.isDirectory() && !existing.isSymbolicLink()) {
    await removeEmptyDirectoryTree(target);
    await fsyncDirectory(path.dirname(target));
  }
  const bytes = await expectedBlobBytes(repo, entry);
  const temp = atomicTempPath(repo, trackedPath, entry);
  try {
    if (entry.mode === "120000") {
      await fs.symlink(bytes.toString("utf-8"), temp);
    } else {
      const handle = await fs.open(temp, "wx", entry.mode === "100755" ? 0o755 : 0o644);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.chmod(temp, entry.mode === "100755" ? 0o755 : 0o644);
    }
    await fs.rename(temp, target);
    await fsyncDirectory(path.dirname(target));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function inventoryRegisteredL2(repo: string): Promise<string[]> {
  const files: string[] = [];
  for (const root of [KNOWLEDGE_L2_V1.canonicalRoot, CONSTRAINT_L2_V1.canonicalRoot]) {
    const absolute = path.join(repo, ...root.split("/"));
    const walk = async (dir: string): Promise<void> => {
      let entries: fsSync.Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(child);
        else files.push(path.relative(repo, child).split(path.sep).join("/"));
      }
    };
    await walk(absolute);
  }
  return files.sort(compareAscii);
}

async function pathIgnoredByCurrentWorktree(repo: string, trackedPath: string): Promise<boolean> {
  try {
    await runGit(repo, ["check-ignore", "-q", "--no-index", "--", trackedPath], { timeoutMs: 5_000, literalPathspecs: false });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

async function assertExistingParentsSafe(repo: string, trackedPath: string): Promise<void> {
  let current = repo;
  for (const part of trackedPath.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("DEVICE_JOIN_WORKTREE_PARENT_UNSAFE", "tracked path parent is not a real directory", { path: trackedPath, parent: current });
    }
  }
}

async function planLegacyRegisteredL2Normalization(
  repo: string,
  before: DeviceJoinTreeMap,
  after: DeviceJoinTreeMap,
  delta: readonly DeviceJoinJournalEntry[],
): Promise<string[]> {
  const removable = new Set<string>();
  for (const item of delta) {
    const beforeMatches = await worktreeMatches(repo, item.path, item.before);
    const afterMatches = await worktreeMatches(repo, item.path, item.after);
    if (beforeMatches || afterMatches) continue;
    const legacyOwnedCollision = item.before === null
      && item.after?.type === "blob"
      && isRegisteredCanonicalL2Path(item.path)
      && await pathIgnoredByCurrentWorktree(repo, item.path);
    const stat = legacyOwnedCollision ? await lstatOrNull(path.join(repo, ...item.path.split("/"))) : null;
    if (!legacyOwnedCollision || !stat || (!stat.isFile() && !stat.isSymbolicLink())) {
      fail("DEVICE_JOIN_WORKTREE_THIRD_STATE", "changed path is neither the exact H preimage nor M postimage", { path: item.path });
    }
    await assertExistingParentsSafe(repo, item.path);
    removable.add(item.path);
  }

  const known = new Set([...before.keys(), ...after.keys()].filter(isRegisteredCanonicalL2Path));
  for (const trackedPath of await inventoryRegisteredL2(repo)) {
    if (known.has(trackedPath)) continue;
    const stat = await lstatOrNull(path.join(repo, ...trackedPath.split("/")));
    if (!stat || (!stat.isFile() && !stat.isSymbolicLink()) || !(await pathIgnoredByCurrentWorktree(repo, trackedPath))) {
      fail("DEVICE_JOIN_L2_UNKNOWN", "registered L2 contains an untracked path outside the reconciler migration boundary", { path: trackedPath });
    }
    await assertExistingParentsSafe(repo, trackedPath);
    removable.add(trackedPath);
  }
  return [...removable].sort(compareAscii);
}

async function normalizeLegacyRegisteredL2(repo: string, removable: readonly string[]): Promise<void> {
  for (const trackedPath of removable) {
    const target = path.join(repo, ...trackedPath.split("/"));
    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if ((!stat.isFile() && !stat.isSymbolicLink()) || !(await pathIgnoredByCurrentWorktree(repo, trackedPath))) {
      fail("DEVICE_JOIN_L2_MIGRATION_DRIFT", "legacy registered L2 path changed before normalization", { path: trackedPath });
    }
    await fs.unlink(target);
    await fsyncDirectory(path.dirname(target));
    await pruneEmptyParents(repo, path.dirname(target));
  }
}

async function verifyChangedPathStates(repo: string, delta: readonly DeviceJoinJournalEntry[]): Promise<void> {
  for (const item of delta) {
    const before = await worktreeMatches(repo, item.path, item.before);
    const after = await worktreeMatches(repo, item.path, item.after);
    if (!before && !after) fail("DEVICE_JOIN_WORKTREE_THIRD_STATE", "journal path is neither the exact H preimage nor M postimage", { path: item.path });
  }
}

async function verifyUnchangedTrackedPaths(repo: string, before: DeviceJoinTreeMap, delta: readonly DeviceJoinJournalEntry[]): Promise<void> {
  const changed = new Set(delta.map((item) => item.path));
  for (const [trackedPath, entry] of before) {
    if (!changed.has(trackedPath) && !(await worktreeMatches(repo, trackedPath, entry))) {
      fail("DEVICE_JOIN_DIRTY_UNKNOWN", "unchanged tracked worktree path is not exact H before join", { path: trackedPath });
    }
  }
}

async function cleanupValidatedAtomicTemps(repo: string, delta: readonly DeviceJoinJournalEntry[]): Promise<void> {
  for (const item of delta) {
    if (!item.after || item.after.mode === "160000") continue;
    const temp = atomicTempPath(repo, item.path, item.after);
    const stat = await lstatOrNull(temp);
    if (!stat) continue;
    await assertExistingParentsSafe(repo, item.path);
    const expected = await expectedBlobBytes(repo, item.after);
    let valid = stat.uid === (typeof process.getuid === "function" ? process.getuid() : stat.uid);
    if (item.after.mode === "120000") {
      valid = valid && stat.isSymbolicLink() && Buffer.from(await fs.readlink(temp), "utf-8").equals(expected);
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= expected.length) {
      const partial = await fs.readFile(temp);
      valid = valid && partial.equals(expected.subarray(0, partial.length));
    } else {
      valid = false;
    }
    if (!valid) fail("DEVICE_JOIN_ATOMIC_TEMP_UNSAFE", "named atomic temp does not match the journal M blob prefix", { path: item.path, temp });
    await fs.unlink(temp);
    await fsyncDirectory(path.dirname(temp));
  }
}

async function verifyNoUnknownDirty(repo: string, delta: readonly DeviceJoinJournalEntry[]): Promise<void> {
  const allowed = new Set(delta.map((item) => item.path));
  const raw = await runGitBuffer(repo, ["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"]);
  let records;
  try { records = parseGitStatusPorcelainV1Z(raw); }
  catch (error) { fail("DEVICE_JOIN_STATUS_INVALID", "git status returned malformed or noncanonical paths", { error: String(error) }); }
  for (const record of records) {
    for (const trackedPath of record.paths) {
      if (!allowed.has(trackedPath)) {
        fail("DEVICE_JOIN_DIRTY_UNKNOWN", "dirty path is outside the complete H to M journal delta", { path: trackedPath, status: record.status });
      }
    }
  }
}

async function verifyRegisteredL2Inventory(repo: string, before: DeviceJoinTreeMap, after: DeviceJoinTreeMap): Promise<void> {
  const known = new Set([...before.keys(), ...after.keys()].filter(isRegisteredCanonicalL2Path));
  const unknown = (await inventoryRegisteredL2(repo)).filter((trackedPath) => !known.has(trackedPath));
  if (unknown.length) fail("DEVICE_JOIN_L2_UNKNOWN", "registered L2 contains an untracked or unjournaled path", { paths: unknown.slice(0, 20) });
}

async function materializeJournal(repo: string, journal: DeviceJoinJournal, options: DeviceJoinPublishOptions): Promise<void> {
  const before = await readCompleteTreeMap(repo, journal.local_head);
  const after = await readCompleteTreeMap(repo, journal.candidate);
  const expectedDelta = treeDelta(before, after);
  if (JSON.stringify(expectedDelta) !== JSON.stringify(journal.delta)) fail("DEVICE_JOIN_JOURNAL_DELTA_MISMATCH", "journal is not the complete exact H to M tracked delta");
  const candidateTree = (await runGit(repo, ["rev-parse", `${journal.candidate}^{tree}`])).trim();
  if (candidateTree !== journal.candidate_tree) fail("DEVICE_JOIN_JOURNAL_TREE_MISMATCH", "journal candidate tree differs from M");
  await verifyChangedPathStates(repo, journal.delta);
  await verifyNoUnknownDirty(repo, journal.delta);
  await verifyRegisteredL2Inventory(repo, before, after);

  const ordered = journal.delta.slice().sort((left, right) => {
    const leftDelete = left.after === null;
    const rightDelete = right.after === null;
    if (leftDelete !== rightDelete) return leftDelete ? -1 : 1;
    const leftDepth = left.path.split("/").length;
    const rightDepth = right.path.split("/").length;
    if (leftDelete && leftDepth !== rightDepth) return rightDepth - leftDepth;
    const rank = (item: DeviceJoinJournalEntry): number => isL1(item.path) ? 0 : isRegisteredCanonicalL2Path(item.path) ? 1 : 2;
    return rank(left) - rank(right) || leftDepth - rightDepth || compareAscii(left.path, right.path);
  });
  for (const item of ordered) {
    if (await worktreeMatches(repo, item.path, item.after)) continue;
    if (!(await worktreeMatches(repo, item.path, item.before))) fail("DEVICE_JOIN_WORKTREE_THIRD_STATE", "path changed after journal validation", { path: item.path });
    if (isL1(item.path)) {
      if (item.before || !item.after || item.after.type !== "blob") fail("DEVICE_JOIN_L1_MATERIALIZE_INVALID", "L1 materialization must be create-only", { path: item.path });
      await assertNoSymlinkParent(repo, item.path);
      const status = await durableAtomicCreateFile(path.join(repo, ...item.path.split("/")), await expectedBlobBytes(repo, item.after), {
        mode: item.after.mode === "100755" ? 0o755 : 0o644,
      });
      if (status === "collision") fail("DEVICE_JOIN_L1_CREATE_COLLISION", "L1 create-only materialization collided", { path: item.path });
    } else {
      await atomicMaterialize(repo, item.path, item.after);
    }
    await options.crashHook?.("path_materialized", { path: item.path });
  }
  await runGit(repo, ["read-tree", journal.candidate], { timeoutMs: 30_000 });
  await options.crashHook?.("index_converged");
  await verifyPublishedState(repo, journal.candidate, after, journal.delta);
  await options.crashHook?.("verified");
}

async function verifyPublishedState(
  repo: string,
  candidate: string,
  expected: DeviceJoinTreeMap,
  delta: readonly DeviceJoinJournalEntry[] = [],
): Promise<void> {
  if (await resolveCommit(repo, "HEAD") !== candidate) fail("DEVICE_JOIN_VERIFY_HEAD", "HEAD is not M after publication");
  const tree = (await runGit(repo, ["rev-parse", `${candidate}^{tree}`])).trim();
  if (await sharedIndexTree(repo) !== tree) fail("DEVICE_JOIN_VERIFY_INDEX", "shared index write-tree is not the M tree");
  for (const [trackedPath, entry] of expected) {
    if (!(await worktreeMatches(repo, trackedPath, entry))) fail("DEVICE_JOIN_VERIFY_WORKTREE", "tracked worktree path differs from M", { path: trackedPath });
  }
  for (const item of delta) {
    if (!(await worktreeMatches(repo, item.path, item.after))) {
      fail("DEVICE_JOIN_VERIFY_WORKTREE", "journal path is not the exact M postimage", { path: item.path });
    }
  }
  const status = await runGitBuffer(repo, ["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"]);
  if (status.length) fail("DEVICE_JOIN_VERIFY_DIRTY", "worktree/index are not clean after M materialization");
  const l1Expected = new Map([...expected].filter(([trackedPath]) => isL1(trackedPath)));
  const l2Expected = new Map([...expected].filter(([trackedPath]) => isRegisteredCanonicalL2Path(trackedPath)));
  const actual = await readCompleteTreeMap(repo, candidate);
  assertMapExact(l1Expected, new Map([...actual].filter(([trackedPath]) => isL1(trackedPath))), "DEVICE_JOIN_VERIFY_L1");
  assertMapExact(l2Expected, new Map([...actual].filter(([trackedPath]) => isRegisteredCanonicalL2Path(trackedPath))), "DEVICE_JOIN_VERIFY_L2");
  await verifyRegisteredL2Inventory(repo, expected, expected);
}

function journalForPrepared(prepared: PreparedDeviceJoin, before: DeviceJoinTreeMap): DeviceJoinJournal {
  return {
    schema_version: "abrain-device-join-journal/v1",
    ref_name: prepared.refName,
    base: prepared.base,
    local_head: prepared.localHead,
    upstream_head: prepared.upstreamHead,
    candidate: prepared.candidate,
    candidate_tree: prepared.tree,
    delta: treeDelta(before, prepared.candidateMap),
  };
}

async function assertJournalCandidateRecomputes(repo: string, journal: DeviceJoinJournal): Promise<void> {
  if (journal.candidate === journal.upstream_head) {
    if (journal.base !== journal.local_head || !(await isAncestor(repo, journal.local_head, journal.upstream_head))) {
      fail("DEVICE_JOIN_JOURNAL_CANDIDATE_INVALID", "fast-forward journal ancestry/base is invalid");
    }
    const [baseMap, candidateMap] = await Promise.all([
      readCompleteTreeMap(repo, journal.local_head),
      readCompleteTreeMap(repo, journal.upstream_head),
    ]);
    await validateLinearCanonicalTransition(repo, baseMap, candidateMap);
    await validateCandidateRepositoryContract(repo, candidateMap);
    const tree = (await runGit(repo, ["rev-parse", `${journal.candidate}^{tree}`])).trim();
    if (tree !== journal.candidate_tree) fail("DEVICE_JOIN_JOURNAL_CANDIDATE_INVALID", "fast-forward candidate tree differs from journal");
    return;
  }
  const localAncestor = await isAncestor(repo, journal.local_head, journal.upstream_head);
  const upstreamAncestor = await isAncestor(repo, journal.upstream_head, journal.local_head);
  if (localAncestor || upstreamAncestor) {
    const parent = localAncestor ? journal.upstream_head : journal.local_head;
    const expectedBase = localAncestor ? journal.local_head : journal.upstream_head;
    if (journal.base !== expectedBase) fail("DEVICE_JOIN_JOURNAL_CANDIDATE_INVALID", "canonicalization journal base does not match H/U ancestry");
    if (journal.local_head !== journal.upstream_head) {
      const [baseMap, parentMap] = await Promise.all([
        readCompleteTreeMap(repo, expectedBase),
        readCompleteTreeMap(repo, parent),
      ]);
      await validateLinearCanonicalTransition(repo, baseMap, parentMap);
    }
    const parentMap = await readCompleteTreeMap(repo, parent);
    const candidateMap = await removeLegacyManifestIgnoreFromCandidate(repo, parentMap);
    await validateCandidateRepositoryContract(repo, candidateMap);
    const tree = await assembleTree(repo, candidateMap);
    const candidate = await createCanonicalizationCommit(repo, tree, parent);
    if (tree !== journal.candidate_tree || candidate !== journal.candidate) {
      fail("DEVICE_JOIN_JOURNAL_CANDIDATE_INVALID", "journal canonicalization M does not recompute exactly", {
        expectedTree: tree,
        journalTree: journal.candidate_tree,
        expectedCandidate: candidate,
        journalCandidate: journal.candidate,
      });
    }
    return;
  }
  const bases = (await runGit(repo, ["merge-base", "--all", journal.local_head, journal.upstream_head], { timeoutMs: 30_000 }))
    .trim().split(/\s+/).filter(Boolean);
  if (bases.length !== 1 || bases[0] !== journal.base) fail("DEVICE_JOIN_JOURNAL_CANDIDATE_INVALID", "journal merge base is not the unique B", { bases, journalBase: journal.base });
  const [baseMap, localMap, upstreamMap] = await Promise.all([
    readCompleteTreeMap(repo, journal.base),
    readCompleteTreeMap(repo, journal.local_head),
    readCompleteTreeMap(repo, journal.upstream_head),
  ]);
  const l1 = unionL1(baseMap, localMap, upstreamMap);
  const l2 = await buildRegisteredL2FromUnion(repo, l1, localMap, upstreamMap);
  const ordinary = mergeOrdinaryPaths(baseMap, localMap, upstreamMap);
  const candidateMap = await removeLegacyManifestIgnoreFromCandidate(
    repo,
    new Map<string, DeviceJoinTreeEntry>([...ordinary, ...l1, ...l2]),
  );
  await validateCandidateRepositoryContract(repo, candidateMap);
  const tree = await assembleTree(repo, candidateMap);
  const candidate = await createJoinCommit(repo, tree, journal.local_head, journal.upstream_head);
  if (tree !== journal.candidate_tree || candidate !== journal.candidate) {
    fail("DEVICE_JOIN_JOURNAL_CANDIDATE_INVALID", "journal M does not recompute exactly from B/H/U", {
      expectedTree: tree,
      journalTree: journal.candidate_tree,
      expectedCandidate: candidate,
      journalCandidate: journal.candidate,
    });
  }
}

async function recoverDeviceJoinJournalUnderBarrier(repo: string, options: DeviceJoinPublishOptions = {}): Promise<DeviceJoinPublishResult | null> {
  assertCanonicalMutationBarrierHeld(repo);
  const journal = await readJournal(repo);
  if (!journal) return null;
  await assertJournalCandidateRecomputes(repo, journal);
  const symbolic = await resolveSymbolicHead(repo);
  if (symbolic !== journal.ref_name) fail("DEVICE_JOIN_JOURNAL_REF_MISMATCH", "journal branch differs from current symbolic HEAD", { symbolic, journalRef: journal.ref_name });
  const head = await resolveCommit(repo, "HEAD");
  if (head !== journal.local_head && head !== journal.candidate) fail("DEVICE_JOIN_JOURNAL_HEAD_THIRD_STATE", "HEAD is neither journal H nor M", { head });
  const before = await readCompleteTreeMap(repo, journal.local_head);
  const candidate = await readCompleteTreeMap(repo, journal.candidate);
  if (JSON.stringify(treeDelta(before, candidate)) !== JSON.stringify(journal.delta)) fail("DEVICE_JOIN_JOURNAL_DELTA_MISMATCH", "journal delta does not bind complete H to M trees");
  await assertMaterializableDelta(repo, journal.delta);
  await cleanupValidatedAtomicTemps(repo, journal.delta);
  await assertDirectoryReplacementInventory(repo, journal.delta);
  const indexTree = await sharedIndexTree(repo);
  const beforeTree = (await runGit(repo, ["rev-parse", `${journal.local_head}^{tree}`])).trim();
  if (indexTree !== beforeTree && indexTree !== journal.candidate_tree) fail("DEVICE_JOIN_INDEX_THIRD_STATE", "shared index is neither H nor M during recovery", { indexTree });
  await verifyChangedPathStates(repo, journal.delta);
  await verifyNoUnknownDirty(repo, journal.delta);
  if (head === journal.local_head) {
    await runGit(repo, ["update-ref", journal.ref_name, journal.candidate, journal.local_head], { timeoutMs: 10_000 });
    await options.crashHook?.("cas_published");
  }
  await materializeJournal(repo, journal, options);
  await clearJournal(repo);
  return { status: "published", head: journal.candidate, candidate: journal.candidate };
}

export function recoverDeviceJoinJournal(options: { repo: string; crashHook?: DeviceJoinPublishOptions["crashHook"] }): Promise<DeviceJoinPublishResult | null> {
  const repo = path.resolve(options.repo);
  return withCanonicalMutationBarrier(repo, () => recoverDeviceJoinJournalUnderBarrier(repo, { crashHook: options.crashHook }));
}

export function publishPreparedDeviceJoin(prepared: PreparedDeviceJoin, options: DeviceJoinPublishOptions = {}): Promise<DeviceJoinPublishResult> {
  return withCanonicalMutationBarrier(prepared.repo, async () => {
    const recovered = await recoverDeviceJoinJournalUnderBarrier(prepared.repo, options);
    if (recovered && recovered.head !== prepared.localHead) return { status: "stale", head: recovered.head };
    await options.settleCanonical?.();
    const current = await resolveCommit(prepared.repo, "HEAD");
    if (current !== prepared.localHead) return { status: "stale", head: current };
    if (prepared.status === "noop") return { status: "noop", head: current, candidate: current };
    const before = await readCompleteTreeMap(prepared.repo, prepared.localHead);
    assertMapExact(prepared.candidateMap, await readCompleteTreeMap(prepared.repo, prepared.candidate), "DEVICE_JOIN_PREPARED_DRIFT");
    await validateCandidateRepositoryContract(prepared.repo, prepared.candidateMap);
    const journal = journalForPrepared(prepared, before);
    const beforeTree = (await runGit(prepared.repo, ["rev-parse", `${prepared.localHead}^{tree}`])).trim();
    if (await sharedIndexTree(prepared.repo) !== beforeTree) fail("DEVICE_JOIN_INDEX_DIRTY", "shared index is not the exact H tree before join publication");
    await verifyUnchangedTrackedPaths(prepared.repo, before, journal.delta);
    await assertMaterializableDelta(prepared.repo, journal.delta);
    const legacyL2 = await planLegacyRegisteredL2Normalization(prepared.repo, before, prepared.candidateMap, journal.delta);
    await verifyNoUnknownDirty(prepared.repo, journal.delta);
    await assertDirectoryReplacementInventory(prepared.repo, journal.delta, legacyL2);
    await normalizeLegacyRegisteredL2(prepared.repo, legacyL2);
    await verifyChangedPathStates(prepared.repo, journal.delta);
    await verifyRegisteredL2Inventory(prepared.repo, before, prepared.candidateMap);
    await writeJournal(prepared.repo, journal);
    await options.crashHook?.("journal_written");
    try {
      await runGit(prepared.repo, ["update-ref", prepared.refName, prepared.candidate, prepared.localHead], { timeoutMs: 10_000 });
    } catch (error) {
      const now = await resolveCommit(prepared.repo, "HEAD");
      if (now === prepared.candidate) {
        await materializeJournal(prepared.repo, journal, options);
        await clearJournal(prepared.repo);
        return { status: "published", head: prepared.candidate, candidate: prepared.candidate };
      }
      if (now !== prepared.localHead) {
        // Our CAS did not publish M. The journal no longer has a recoverable
        // H/M HEAD domain, so remove our marker and force a fresh computation.
        await clearJournal(prepared.repo);
        return { status: "stale", head: now };
      }
      throw error;
    }
    await options.crashHook?.("cas_published");
    await materializeJournal(prepared.repo, journal, options);
    await clearJournal(prepared.repo);
    return { status: "published", head: prepared.candidate, candidate: prepared.candidate };
  });
}

export const __TEST = Object.freeze({
  JOURNAL_RELATIVE,
  treeDelta,
  sameEntry,
  unionL1,
  mergeOrdinaryPaths,
  worktreeMatches,
  atomicTempPath,
  recoverDeviceJoinJournalUnderBarrier,
  sha1Blob(bytes: Buffer): string {
    const header = Buffer.from(`blob ${bytes.length}\0`, "utf-8");
    return createHash("sha1").update(header).update(bytes).digest("hex");
  },
});
