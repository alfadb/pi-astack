import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { jcsSha256Hex, sha256Hex } from "./jcs";
import { isCanonicalCohortPath } from "./l1-schema-registry";

const execFileAsync = promisify(execFile);

/** Canonical-path R3.4.2 P1-S1: exact-cohort Git commit primitive.
 *
 *  Commits are prepared on a TEMPORARY `GIT_INDEX_FILE` (the shared index is
 *  never touched during freeze→CAS), verified with an exact `diff-tree`
 *  against the cohort plan (no extra, missing, or divergent path/blob/mode),
 *  created with `commit-tree`, and published with
 *  `update-ref <ref> <candidate> <frozen>` optimistic CAS. After successful
 *  publication the SHARED index is converged for the exact cohort paths only
 *  (to CURRENT HEAD), preserving non-cohort staged entries byte-for-byte and
 *  never touching the worktree. No `reset --hard`, no force checkout, no
 *  cross-instance presence or lease.
 */

export type CohortOp = "put" | "delete";

export interface CohortPlanEntry {
  /** Canonical repo-relative path with forward slashes. */
  path: string;
  op: CohortOp;
  /** Blob mode for `put` entries (default 100644). */
  mode?: "100644" | "100755";
  /** Exact bytes for `put` entries. */
  content?: Buffer | string;
}

export interface PreparedCohortEntry {
  path: string;
  op: CohortOp;
  mode: string;
  /** Git blob OID for `put` entries; empty for deletes. */
  blobOid: string;
  /** SHA-256 of the exact bytes for `put` entries; empty for deletes. */
  bytesSha256: string;
}

export interface PreparedExactCohortCommit {
  repo: string;
  refName: string;
  frozenCommit: string;
  newTree: string;
  candidate: string;
  cohortManifestRoot: string;
  entries: readonly PreparedCohortEntry[];
}

export type PublishStatus = "published" | "already_published" | "remote_contained" | "cas_conflict";

export interface PublishResult {
  status: PublishStatus;
  currentRef: string;
}

export class GitExactCohortError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "GitExactCohortError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

const GIT_ENV = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

const ALLOWED_GIT_EXTRA_ENV = new Set([
  "GIT_INDEX_FILE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

function gitEnvironment(extraEnv: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!ALLOWED_GIT_EXTRA_ENV.has(key)) {
      throw new GitExactCohortError("GIT_ENV_INVALID", `Git extra environment key is not allowlisted: ${key}`);
    }
    env[key] = value;
  }
  return { ...env, ...GIT_ENV };
}

const COHORT_MANIFEST_DOMAIN = "pi-astack/local-drain/cohort-semantic-manifest/v2";
const COHORT_MANIFEST_DOMAIN_V3 = "pi-astack/local-drain/cohort-semantic-manifest/v3";
export const LOCAL_DRAIN_PROTOCOL_V2 = "local-drain-recovery/v2" as const;
export const LOCAL_DRAIN_PROTOCOL_V3 = "local-drain-recovery/v3" as const;
export type LocalDrainProtocolVersion = typeof LOCAL_DRAIN_PROTOCOL_V2 | typeof LOCAL_DRAIN_PROTOCOL_V3;
const DRAIN_IDENTITY = Object.freeze({
  name: "pi-astack-local-drain",
  email: "local-drain@pi-astack.invalid",
});

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function git(repo: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: gitEnvironment(extraEnv),
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function gitExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

async function gitIndexInfo(repo: string, records: readonly string[]): Promise<void> {
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "--literal-pathspecs", "update-index", "-z", "--index-info"], {
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`git update-index --index-info exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`) as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        error.code = code ?? undefined;
        error.stdout = Buffer.concat(stdout).toString("utf8");
        error.stderr = Buffer.concat(stderr).toString("utf8");
        reject(error);
      }
    });
    child.stdin.end(records.join(""));
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      const text = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}` : String(error);
      if (attempt >= 5 || !/index\.lock.*(?:exists|file exists)/is.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export function validateCohortPlan(entries: readonly CohortPlanEntry[]): readonly CohortPlanEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const rel = entry.path;
    if (!isCanonicalCohortPath(rel)) throw new GitExactCohortError("COHORT_PATH_INVALID", `cohort path is not canonical repo-relative: ${rel}`);
    if (seen.has(rel)) throw new GitExactCohortError("COHORT_PATH_DUPLICATE", `duplicate cohort path: ${rel}`);
    seen.add(rel);
    if (entry.op === "put") {
      if (entry.content === undefined) throw new GitExactCohortError("COHORT_PLAN_INVALID", `put entry has no content: ${rel}`);
      if (entry.mode !== undefined && entry.mode !== "100644" && entry.mode !== "100755") {
        throw new GitExactCohortError("COHORT_PLAN_INVALID", `invalid put mode for ${rel}: ${String(entry.mode)}`);
      }
    } else if (entry.op === "delete") {
      if (entry.content !== undefined || entry.mode !== undefined) {
        throw new GitExactCohortError("COHORT_PLAN_INVALID", `delete entry may not carry content or mode: ${rel}`);
      }
    } else {
      throw new GitExactCohortError("COHORT_PLAN_INVALID", `unknown cohort op for ${rel}`);
    }
  }
  return [...entries].sort((a, b) => compareAscii(a.path, b.path));
}

export function stableCohortSemanticManifest(entries: readonly PreparedCohortEntry[], protocolVersion: LocalDrainProtocolVersion = LOCAL_DRAIN_PROTOCOL_V2): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: protocolVersion,
    entries: Object.freeze([...entries]
      .sort((a, b) => compareAscii(a.path, b.path))
      .map((entry) => Object.freeze({ path: entry.path, op: entry.op, mode: entry.mode, bytes_sha256: entry.bytesSha256 }))),
  });
}

export function cohortManifestRoot(entries: readonly PreparedCohortEntry[], protocolVersion: LocalDrainProtocolVersion = LOCAL_DRAIN_PROTOCOL_V2): string {
  const domain = protocolVersion === LOCAL_DRAIN_PROTOCOL_V3 ? COHORT_MANIFEST_DOMAIN_V3 : COHORT_MANIFEST_DOMAIN;
  return sha256Hex(`${domain}\n${JSON.stringify(stableCohortSemanticManifest(entries, protocolVersion))}`);
}

export function cohortPlanSemanticRoot(entries: readonly CohortPlanEntry[], protocolVersion: LocalDrainProtocolVersion): string {
  const normalized = validateCohortPlan(entries).map((entry): PreparedCohortEntry => {
    if (entry.op === "delete") return { path: entry.path, op: "delete", mode: "000000", blobOid: "", bytesSha256: "" };
    const bytes = typeof entry.content === "string" ? Buffer.from(entry.content, "utf-8") : entry.content!;
    return { path: entry.path, op: "put", mode: entry.mode ?? "100644", blobOid: "", bytesSha256: sha256Hex(bytes) };
  });
  return cohortManifestRoot(normalized, protocolVersion);
}

export function deterministicDrainCommitMessage(manifestRoot: string, protocolVersion: LocalDrainProtocolVersion = LOCAL_DRAIN_PROTOCOL_V2): string {
  if (!/^[0-9a-f]{64}$/.test(manifestRoot)) throw new GitExactCohortError("COHORT_MANIFEST_INVALID", "manifest root must be SHA-256 hex");
  return `pi-astack local drain\n\nprotocol: ${protocolVersion}\nmanifest: ${manifestRoot}`;
}

export async function resolveRef(repo: string, refName: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", `${refName}^{commit}`])).trim();
}

/** Snapshot the shared-index stage entries for the given exact paths.
 *  Returns map path → `mode oid stage` (or absent when unstaged). */
export async function snapshotIndexEntries(repo: string, paths: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const stdout = await git(repo, ["ls-files", "-z", "--stage", "--", ...paths]);
  for (const record of stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new GitExactCohortError("OWNED_INDEX_CONFLICT", "unparseable owned index entry");
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const relPath = record.slice(tab + 1);
    if (meta.length !== 3 || meta[2] !== "0" || out.has(relPath)) {
      throw new GitExactCohortError("OWNED_INDEX_CONFLICT", `owned path has non-stage-0 or duplicate index entries: ${relPath}`, {
        path: relPath,
        stage: meta[2] ?? null,
        duplicate: out.has(relPath),
      });
    }
    out.set(relPath, `${meta[0]} ${meta[1]} ${meta[2]}`);
  }
  return out;
}

export async function fullIndexFingerprint(repo: string, excludePaths: ReadonlySet<string>): Promise<string> {
  const stdout = await git(repo, ["ls-files", "-z", "--stage"]);
  const records = stdout.split("\0").filter(Boolean).filter((record) => {
    const tab = record.indexOf("\t");
    return tab < 0 || !excludePaths.has(record.slice(tab + 1));
  });
  return sha256Hex(records.sort(compareAscii).join("\0"));
}

/** Prepare an exact cohort after the caller has removed every no-op entry.
 *  A plan entry must describe a real frozen-tree delta; callers must skip the
 *  operation entirely when no entries remain. */
export async function prepareExactCohortCommit(options: {
  repo: string;
  refName: string;
  frozenCommit: string;
  plan: readonly CohortPlanEntry[];
  message: string;
  protocolVersion?: LocalDrainProtocolVersion;
}): Promise<PreparedExactCohortCommit> {
  const repo = path.resolve(options.repo);
  const plan = validateCohortPlan(options.plan);
  if (plan.length === 0) throw new GitExactCohortError("COHORT_EMPTY", "empty cohort plan must be skipped by the caller");
  const tmpIndex = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "pi-astack-cohort-index-")), "index");
  const indexEnv = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(repo, ["read-tree", options.frozenCommit], indexEnv);
    const prepared: PreparedCohortEntry[] = [];
    for (const entry of plan) {
      if (entry.op === "delete") {
        await git(repo, ["update-index", "--force-remove", "--", entry.path], indexEnv);
        prepared.push({ path: entry.path, op: "delete", mode: "000000", blobOid: "", bytesSha256: "" });
        continue;
      }
      const bytes = typeof entry.content === "string" ? Buffer.from(entry.content, "utf-8") : entry.content!;
      const tmpBlob = path.join(path.dirname(tmpIndex), `blob-${randomBytes(6).toString("hex")}`);
      await fsp.writeFile(tmpBlob, bytes);
      const blobOid = (await git(repo, ["hash-object", "-w", "--", tmpBlob])).trim();
      await fsp.rm(tmpBlob, { force: true });
      const mode = entry.mode ?? "100644";
      await git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${blobOid},${entry.path}`], indexEnv);
      prepared.push({ path: entry.path, op: "put", mode, blobOid, bytesSha256: sha256Hex(bytes) });
    }
    const newTree = (await git(repo, ["write-tree"], indexEnv)).trim();

    // Exact diff verification: the frozen→new tree delta must equal the plan
    // path-for-path, blob-for-blob, mode-for-mode. Anything extra, missing, or
    // divergent fails closed before a commit object is created.
    const diffOut = await git(repo, ["diff-tree", "-r", "-z", "--no-renames", options.frozenCommit, newTree]);
    const observed = new Map<string, { dstMode: string; dstOid: string; status: string }>();
    const tokens = diffOut.split("\0").filter(Boolean);
    for (let index = 0; index < tokens.length; index += 2) {
      const meta = tokens[index]!;
      const relPath = tokens[index + 1];
      if (relPath === undefined) throw new GitExactCohortError("TREE_MISMATCH", "unparseable diff-tree output");
      const parts = meta.replace(/^:/, "").split(/\s+/);
      observed.set(relPath, { dstMode: parts[1]!, dstOid: parts[3]!, status: parts[4]! });
    }
    if (observed.size !== prepared.length) {
      throw new GitExactCohortError("TREE_MISMATCH", "tree delta size does not match cohort plan", {
        expected: prepared.length,
        actual: observed.size,
        extraPaths: [...observed.keys()].filter((p) => !prepared.some((e) => e.path === p)).slice(0, 5),
      });
    }
    for (const entry of prepared) {
      const seen = observed.get(entry.path);
      if (!seen) throw new GitExactCohortError("TREE_MISMATCH", `planned path missing from tree delta: ${entry.path}`);
      if (entry.op === "delete") {
        if (seen.status !== "D") throw new GitExactCohortError("TREE_MISMATCH", `expected delete for ${entry.path}, got ${seen.status}`);
      } else {
        if (seen.status !== "A" && seen.status !== "M") throw new GitExactCohortError("TREE_MISMATCH", `expected add/modify for ${entry.path}, got ${seen.status}`);
        if (seen.dstOid !== entry.blobOid) throw new GitExactCohortError("TREE_MISMATCH", `blob OID mismatch for ${entry.path}`, { expected: entry.blobOid, actual: seen.dstOid });
        if (seen.dstMode !== entry.mode) throw new GitExactCohortError("TREE_MISMATCH", `mode mismatch for ${entry.path}`, { expected: entry.mode, actual: seen.dstMode });
      }
    }

    const protocolVersion = options.protocolVersion ?? LOCAL_DRAIN_PROTOCOL_V2;
    const manifestRoot = cohortManifestRoot(prepared, protocolVersion);
    const parentEpochText = (await git(repo, ["show", "-s", "--format=%ct", options.frozenCommit])).trim();
    const parentEpoch = /^\d+$/.test(parentEpochText) ? parentEpochText : "0";
    const stableDate = `${parentEpoch} +0000`;
    // `options.message` is intentionally excluded from commit bytes. It is a
    // caller diagnostic only; protocol + semantic manifest define the commit.
    const candidate = (await git(repo, ["commit-tree", newTree, "-p", options.frozenCommit, "-m", deterministicDrainCommitMessage(manifestRoot, protocolVersion)], {
      GIT_AUTHOR_NAME: DRAIN_IDENTITY.name,
      GIT_AUTHOR_EMAIL: DRAIN_IDENTITY.email,
      GIT_AUTHOR_DATE: stableDate,
      GIT_COMMITTER_NAME: DRAIN_IDENTITY.name,
      GIT_COMMITTER_EMAIL: DRAIN_IDENTITY.email,
      GIT_COMMITTER_DATE: stableDate,
    })).trim();
    return Object.freeze({
      repo,
      refName: options.refName,
      frozenCommit: options.frozenCommit,
      newTree,
      candidate,
      cohortManifestRoot: manifestRoot,
      entries: Object.freeze(prepared),
    });
  } finally {
    await fsp.rm(path.dirname(tmpIndex), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `update-ref <ref> <candidate> <frozen>` optimistic CAS. On failure the ref
 *  and worktree are untouched; the candidate object simply stays unreachable. */
export async function publishExactCohortCommit(options: {
  repo: string;
  refName: string;
  candidate: string;
  frozenCommit: string;
}): Promise<PublishResult> {
  try {
    await git(options.repo, ["update-ref", options.refName, options.candidate, options.frozenCommit]);
    return { status: "published", currentRef: options.candidate };
  } catch (updateError) {
    let currentRef: string;
    try {
      currentRef = await resolveRef(options.repo, options.refName);
    } catch {
      throw updateError;
    }
    if (currentRef === options.candidate) return { status: "already_published", currentRef };
    try {
      await git(options.repo, ["merge-base", "--is-ancestor", options.candidate, currentRef]);
      return { status: "remote_contained", currentRef };
    } catch (ancestryError) {
      if (gitExitCode(ancestryError) !== 1) throw ancestryError;
      if (currentRef !== options.frozenCommit) return { status: "cas_conflict", currentRef };
      throw updateError;
    }
  }
}

export interface IndexConvergenceResult {
  converged: readonly string[];
  preIndexFingerprint: string;
  postIndexFingerprint: string;
}

/** Post-publication exact-cohort shared-index convergence (R3.4.1 §1).
 *
 *  Converges ONLY the cohort paths to CURRENT HEAD blob/mode through the
 *  shared index (git takes its own index.lock). A cohort path whose staged
 *  entry changed relative to the freeze-time snapshot AND does not already
 *  equal the HEAD target is an owned-path conflict: fail closed, never
 *  overwrite. Non-cohort staged entries and the worktree are never touched. */
export async function convergeExactCohortIndex(options: {
  repo: string;
  refName?: string;
  cohortPaths: readonly string[];
  frozenIndexSnapshot: ReadonlyMap<string, string>;
}): Promise<IndexConvergenceResult> {
  const repo = path.resolve(options.repo);
  const cohortSet = new Set(options.cohortPaths);
  const preIndexFingerprint = await fullIndexFingerprint(repo, cohortSet);

  // Current publication-ref targets for each cohort path.
  const headEntries = new Map<string, { mode: string; oid: string }>();
  if (options.cohortPaths.length > 0) {
    const stdout = await git(repo, ["ls-tree", "-z", options.refName ?? "HEAD", "--", ...options.cohortPaths]);
    for (const record of stdout.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      if (tab < 0) throw new GitExactCohortError("OWNED_INDEX_CONFLICT", "unparseable publication-ref tree entry");
      const meta = record.slice(0, tab).split(/\s+/);
      const relPath = record.slice(tab + 1);
      if (!cohortSet.has(relPath)) continue;
      if (meta.length !== 3 || !["100644", "100755", "120000", "160000"].includes(meta[0]!) || headEntries.has(relPath)) {
        throw new GitExactCohortError("OWNED_INDEX_CONFLICT", `publication ref has an unsupported or duplicate owned path: ${relPath}`);
      }
      headEntries.set(relPath, { mode: meta[0]!, oid: meta[2]! });
    }
  }
  const current = await snapshotIndexEntries(repo, options.cohortPaths);

  // Validate every owned path before changing any shared-index entry. A
  // conflict on a later path must not leave an earlier path half-converged.
  const updates: Array<{ relPath: string; target?: { mode: string; oid: string } }> = [];
  for (const relPath of options.cohortPaths) {
    const target = headEntries.get(relPath);
    const targetLine = target ? `${target.mode} ${target.oid} 0` : undefined;
    const now = current.get(relPath);
    const frozen = options.frozenIndexSnapshot.get(relPath);
    if (now === targetLine) continue;
    if (now !== frozen) {
      throw new GitExactCohortError("OWNED_INDEX_CONFLICT", `unexpected staged change on owned cohort path: ${relPath}`, {
        frozen: frozen ?? null,
        current: now ?? null,
        target: targetLine ?? null,
      });
    }
    updates.push({ relPath, ...(target ? { target } : {}) });
  }

  // One update-index process owns one index lock and applies the complete
  // prevalidated batch. No path is visible half-converged.
  if (updates.length > 0) {
    const objectFormat = (await git(repo, ["rev-parse", "--show-object-format"])).trim();
    const zeroOid = "0".repeat(objectFormat === "sha256" ? 64 : 40);
    await gitIndexInfo(repo, updates.map(({ relPath, target }) => target
      ? `${target.mode} ${target.oid}\t${relPath}\0`
      : `0 ${zeroOid}\t${relPath}\0`));
  }
  const converged = updates.map(({ relPath }) => relPath);

  // Post-verification: cohort index entries equal the publication ref; non-cohort entries
  // preserved byte-for-byte.
  const after = await snapshotIndexEntries(repo, options.cohortPaths);
  for (const relPath of options.cohortPaths) {
    const target = headEntries.get(relPath);
    const targetLine = target ? `${target.mode} ${target.oid} 0` : undefined;
    if (after.get(relPath) !== targetLine) {
      throw new GitExactCohortError("INDEX_CONVERGE_FAILED", `cohort index entry did not converge: ${relPath}`);
    }
  }
  const postIndexFingerprint = await fullIndexFingerprint(repo, cohortSet);
  if (postIndexFingerprint !== preIndexFingerprint) {
    throw new GitExactCohortError("NON_COHORT_INDEX_MUTATED", "non-cohort staged entries changed during convergence", {
      pre: preIndexFingerprint,
      post: postIndexFingerprint,
    });
  }
  return { converged: Object.freeze(converged), preIndexFingerprint, postIndexFingerprint };
}

/** True when the current ref tree already contains the exact cohort bytes. */
export async function refContainsCohort(repo: string, refName: string, prepared: readonly PreparedCohortEntry[]): Promise<boolean> {
  const paths = prepared.map((entry) => entry.path);
  const stdout = await git(repo, ["ls-tree", "-z", refName, "--", ...paths]);
  const inTree = new Map<string, string>();
  for (const record of stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    inTree.set(record.slice(tab + 1), `${meta[0]} ${meta[2]}`);
  }
  for (const entry of prepared) {
    const found = inTree.get(entry.path);
    if (entry.op === "delete") {
      if (found !== undefined) return false;
    } else if (found !== `${entry.mode} ${entry.blobOid}`) {
      return false;
    }
  }
  return true;
}

/** Candidate shape verification for restart recovery (R3.4.1 §3): the
 *  candidate itself must have the prepared parent and tree. Descendant
 *  changes after the candidate are legitimate and are NOT checked here. */
export async function verifyCandidateShape(repo: string, candidate: string, expected: { frozenCommit: string; newTree: string }): Promise<boolean> {
  try {
    const parent = (await git(repo, ["rev-parse", `${candidate}^`])).trim();
    const tree = (await git(repo, ["rev-parse", `${candidate}^{tree}`])).trim();
    return parent === expected.frozenCommit && tree === expected.newTree;
  } catch {
    return false;
  }
}

export async function isAncestor(repo: string, maybeAncestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", maybeAncestor, descendant]);
    return true;
  } catch (error) {
    if (gitExitCode(error) !== 1) throw error;
    return false;
  }
}

export { jcsSha256Hex as recoveryDomainHash };
