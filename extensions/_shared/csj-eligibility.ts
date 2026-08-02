/**
 * C3 — Executable CSJ eligibility predicate (CsjEligibility).
 * Pure recovery v3 + 0|1 bind only. Any false clause → no CAS.
 */

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
// Lazy-import bind-intent / runtime helpers to avoid cycles:
// canonical-git-runtime → csj → eligibility → abrain/bind-intent → runtime
import {
  decodePreparedRecoveryEvent,
  frozenIndexSnapshotRootV3,
  recoverOpenRecoveryEpisodesFromScan,
  recoverOpenRecoveryEpisodesV3FromScan,
  type RecoveryEpisodeCursorV3,
  type RecoveryOperationV3,
} from "./convergence-recovery";
import {
  fullIndexFingerprint,
  isAncestor,
  LOCAL_DRAIN_PROTOCOL_V3,
  snapshotIndexEntries,
  verifyCandidateShape,
  type PreparedCohortEntry,
  type PreparedExactCohortCommit,
} from "./git-exact-cohort";
import { sha256Hex } from "./jcs";
import {
  deviceJoinJournalPresent,
} from "./l1-validated-scan-cache";
import {
  expectedL1EventRelativePath,
  loadL1SchemaRegistry,
  resolveL1EnvelopeSchema,
  scanWholeL1Validated,
  validateL1Envelope,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import {
  classifyRecoveryHistory,
  type CombinedRecoveryHistoryResult,
} from "./recovery-history-classifier";

const execFileAsync = promisify(execFile);
const L1_PREFIX = "l1/events/sha256/";
const RECOVERY_V3_SCHEMA = "local-drain-recovery-envelope/v3";
const PROJECT_JSON_RE = /^projects\/[A-Za-z0-9._-]+\/_project\.json$/;

export class CsjEligibilityError extends Error {
  readonly code: string;
  readonly clause: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(clause: string, code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CsjEligibilityError";
    this.code = code;
    this.clause = clause;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface CsjFreezeBind {
  readonly itemId: string;
  readonly pending: true;
  readonly path: string;
  readonly mode: "100644";
  readonly blobBytes: string;
  readonly blobBytesSha256: string;
}

export interface CsjEligibilityContext {
  readonly abrainHome: string;
  readonly repo: string;
  readonly refName: string;
  readonly episode: RecoveryEpisodeCursorV3;
  readonly prepared: PreparedExactCohortCommit;
  readonly operation: RecoveryOperationV3;
  readonly frozenIndexSnapshot: ReadonlyMap<string, string>;
  readonly head: string;
  readonly base: string;
  readonly candidate: string;
  readonly entries: readonly PreparedCohortEntry[];
  readonly scan: WholeL1ScanResult;
  readonly history: CombinedRecoveryHistoryResult;
  readonly freezeBind: CsjFreezeBind | null;
  readonly worktreeFreeze: ReadonlyArray<{ path: string; mode: "100644"; bytesSha256: string; blobOid: string }>;
  readonly noncohortIndexFingerprint: string;
  readonly statusHash: string;
}

export interface CsjEligibilityResult {
  readonly eligible: true;
  readonly context: CsjEligibilityContext;
}

async function gitText(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return String(stdout);
}

async function gitCatFileExists(repo: string, oid: string, expectedType?: string): Promise<boolean> {
  try {
    await gitText(repo, ["cat-file", "-e", oid]);
    if (!expectedType) return true;
    const type = (await gitText(repo, ["cat-file", "-t", oid])).trim();
    return type === expectedType;
  } catch {
    return false;
  }
}

async function treeEntry(repo: string, commit: string, relPath: string): Promise<{ mode: string; oid: string } | null> {
  const raw = (await gitText(repo, ["ls-tree", "-z", commit, "--", relPath])).replace(/\0$/, "");
  if (!raw.trim()) return null;
  const tab = raw.indexOf("\t");
  if (tab < 0) return null;
  const meta = raw.slice(0, tab).split(/\s+/);
  if (meta.length < 3) return null;
  return { mode: meta[0]!, oid: meta[2]! };
}

async function blobOrAbsent(repo: string, commit: string, relPath: string): Promise<string | null> {
  const entry = await treeEntry(repo, commit, relPath);
  return entry ? `${entry.mode}:${entry.oid}` : null;
}

function fail(clause: string, code: string, message: string, detail?: Record<string, unknown>): never {
  throw new CsjEligibilityError(clause, code, message, detail);
}

/**
 * Evaluate full CsjEligibility for the unique open prepared v3 episode.
 * Throws CsjEligibilityError on first false clause.
 */
export async function evaluateCsjEligibility(options: {
  abrainHome: string;
  repo: string;
  refName: string;
  scan?: WholeL1ScanResult;
  history?: CombinedRecoveryHistoryResult;
  episode?: RecoveryEpisodeCursorV3;
}): Promise<CsjEligibilityResult> {
  const abrainHome = path.resolve(options.abrainHome);
  const repo = path.resolve(options.repo);
  const refName = options.refName;

  const {
    assertRepoMutationPreflightForCsj,
    preflightSharedIndexLock,
    statusSnapshot,
  } = await import("./canonical-git-runtime");
  // E18/E20/E22/E23 — existing preflight APIs
  try {
    await assertRepoMutationPreflightForCsj(repo, refName);
  } catch (error) {
    fail("E18-E23", "CSJ_PREFLIGHT_FAILED", error instanceof Error ? error.message : String(error));
  }
  try {
    await preflightSharedIndexLock(repo);
  } catch (error) {
    fail("E23", "CSJ_INDEX_LOCK", error instanceof Error ? error.message : String(error));
  }

  // E21
  if (await deviceJoinJournalPresent(abrainHome)) {
    fail("E21", "CSJ_DEVICE_JOIN_JOURNAL", "device-join journal present");
  }

  const head = (await gitText(repo, ["rev-parse", "--verify", `${refName}^{commit}`])).trim();
  const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: repo });
  const history = options.history ?? await classifyRecoveryHistory({ repo, scan, head, symbolicRef: refName });

  // E17
  if (history.status !== "accepted" || history.quarantined.length > 0 || !history.v3 || history.v3.status !== "accepted") {
    fail("E17", "CSJ_HISTORY_NOT_ACCEPTED", "HEAD history not accepted", { status: history.status, quarantine: history.quarantined.length });
  }

  const v2Open = recoverOpenRecoveryEpisodesFromScan(scan);
  const v3Open = recoverOpenRecoveryEpisodesV3FromScan(scan);
  const openAll = [...v2Open.open, ...v3Open.open];
  const quarantineCount = v2Open.quarantined.length + v3Open.quarantined.length;

  // E1
  if (v2Open.open.length !== 0) fail("E1", "CSJ_OPEN_NOT_UNIQUE", "open v2 episode present");
  if (openAll.length !== 1) fail("E1", "CSJ_OPEN_NOT_UNIQUE", "v2∪v3 open count must be exactly 1", { openCount: openAll.length });
  const episode = options.episode ?? v3Open.open[0];
  if (!episode || episode.episodeId !== openAll[0]!.episodeId) {
    fail("E1", "CSJ_OPEN_NOT_UNIQUE", "unique open is not the prepared v3 episode");
  }
  if (episode.pendingSlot === null) fail("E1", "CSJ_OPEN_NOT_PREPARED", "open episode has no pending slot");
  const state = episode.folded.get(episode.pendingSlot);
  if (!state?.claimed || !state.prepared || state.published || state.converged || state.aborted || state.terminal) {
    fail("E1", "CSJ_OPEN_NOT_PREPARED", "episode is not prepared open v3", {
      claimed: !!state?.claimed,
      prepared: !!state?.prepared,
      published: !!state?.published,
      converged: !!state?.converged,
      aborted: !!state?.aborted,
      terminal: !!state?.terminal,
    });
  }

  // E2
  if (quarantineCount !== 0) fail("E2", "CSJ_QUARANTINE", "quarantine_count must be 0", { quarantineCount });

  // E3
  if (state.published) fail("E3", "CSJ_PUBLISHED_NONZERO", "Published(E) forbids CSJ");

  const { prepared, snapshot } = decodePreparedRecoveryEvent(
    state.prepared,
    repo,
    refName,
    LOCAL_DRAIN_PROTOCOL_V3,
  );
  const base = prepared.frozenCommit;
  const candidate = prepared.candidate;
  const entries = prepared.entries;
  const operation = episode.operation;

  // E4
  const parentsRaw = (await gitText(repo, ["rev-list", "--parents", "-n", "1", candidate])).trim().split(/\s+/);
  if (parentsRaw.length !== 2 || parentsRaw[1] !== base) {
    fail("E4", "CSJ_PARENT_SHAPE", "candidate.parents must be exactly [base]", { parents: parentsRaw.slice(1), base });
  }
  if (!await verifyCandidateShape(repo, candidate, { frozenCommit: base, newTree: prepared.newTree })) {
    fail("E4", "CSJ_SHAPE", "verifyCandidateShape failed");
  }
  if (operation.cohort_semantic_root !== prepared.cohortManifestRoot) {
    fail("E4", "CSJ_OPERATION_ROOT", "cohort_semantic_root mismatch");
  }
  const frozenRoot = frozenIndexSnapshotRootV3(entries, snapshot);
  if (operation.frozen_index_snapshot_root !== frozenRoot) {
    fail("E4", "CSJ_FROZEN_INDEX_ROOT", "frozen_index_snapshot_root mismatch");
  }
  if (!await gitCatFileExists(repo, candidate, "commit")) fail("E4", "CSJ_OBJECT_MISSING", "candidate commit missing");
  if (!await gitCatFileExists(repo, base, "commit")) fail("E4", "CSJ_OBJECT_MISSING", "base commit missing");
  for (const entry of entries) {
    if (entry.op === "put" && !await gitCatFileExists(repo, entry.blobOid, "blob")) {
      fail("E4", "CSJ_OBJECT_MISSING", "cohort blob missing", { path: entry.path });
    }
  }

  // E5 / E6
  if (!await isAncestor(repo, base, head)) fail("E5", "CSJ_BASE_NOT_ANCESTOR", "base is not ancestor of HEAD");
  if (head === base) fail("E6", "CSJ_ANTICHAIN_FALSE", "HEAD equals base; use recover only");
  if (await isAncestor(repo, candidate, head)) fail("E6", "CSJ_ANTICHAIN_FALSE", "candidate already ancestor of HEAD");
  if (await isAncestor(repo, head, candidate)) fail("E6", "CSJ_ANTICHAIN_FALSE", "HEAD is ancestor of candidate");

  // E7 only put
  for (const entry of entries) {
    if (entry.op !== "put") fail("E7", "CSJ_NOT_ONLY_PUT", "CSJ requires only put entries", { path: entry.path, op: entry.op });
  }

  const registry = loadL1SchemaRegistry();
  const l1Entries = entries.filter((entry) => entry.path.startsWith(L1_PREFIX));
  const nonL1 = entries.filter((entry) => !entry.path.startsWith(L1_PREFIX));

  // E8–E12 L1 constraints
  for (const entry of l1Entries) {
    if (entry.mode !== "100644") fail("E8", "CSJ_L1_MODE", "L1 put mode must be 100644", { path: entry.path, mode: entry.mode });
    const bytes = Buffer.from(await gitText(repo, ["cat-file", "blob", entry.blobOid]), "binary");
    // cat-file via text may corrupt binary; use buffer path:
  }
  // re-read blobs as buffers
  for (const entry of l1Entries) {
    const { stdout } = await execFileAsync("git", ["-C", repo, "cat-file", "blob", entry.blobOid], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    const bytes = stdout as Buffer;
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
      fail("E9", "CSJ_L1_PARSE", "L1 entry is not JSON", { path: entry.path });
    }
    const validated = validateL1Envelope(parsed, {
      registry,
      abrainHome: repo,
      relativePath: entry.path,
      filePath: path.join(repo, entry.path),
    });
    if (validated.registration.envelope_schema !== RECOVERY_V3_SCHEMA) {
      fail("E9", "CSJ_L1_SCHEMA", "L1 must be local-drain-recovery-envelope/v3", { path: entry.path, schema: validated.registration.envelope_schema });
    }
    if (validated.registration.domain !== "canonical_path") fail("E10", "CSJ_DOMAIN", "domain must be canonical_path", { path: entry.path });
    if (validated.registration.role !== "meta") fail("E10", "CSJ_ROLE", "role must be meta", { path: entry.path });
    if (validated.registration.fold_eligible !== false) fail("E11", "CSJ_FOLD_ELIGIBLE", "fold_eligible must be false", { path: entry.path });
    const expectedPath = expectedL1EventRelativePath(validated.eventId);
    if (entry.path !== expectedPath) fail("E8", "CSJ_L1_PATH", "path must equal expectedL1EventRelativePath", { path: entry.path, expectedPath });
    if (!entry.path.startsWith(L1_PREFIX)) fail("E8", "CSJ_L1_PREFIX", "path must start with L1 prefix");
  }

  // E13–E15 non-L1 bind
  if (nonL1.length > 1) fail("E13", "CSJ_NONL1_COUNT", "non-L1 count must be 0|1", { count: nonL1.length });
  let freezeBind: CsjFreezeBind | null = null;
  if (nonL1.length === 1) {
    const p = nonL1[0]!;
    if (!PROJECT_JSON_RE.test(p.path)) fail("E13", "CSJ_NONL1_PATH", "non-L1 path must be projects/<slug>/_project.json", { path: p.path });
    if (p.mode !== "100644") fail("E13", "CSJ_NONL1_MODE", "bind put mode must be 100644");
    const { listAbrainBindIntentPending } = await import("../abrain/bind-intent");
    const pending = await listAbrainBindIntentPending(abrainHome);
    if (pending.length !== 1) fail("E14", "CSJ_BIND_PENDING", "exactly one pending bind intent required", { count: pending.length });
    const intent = pending[0]!;
    const { stdout } = await execFileAsync("git", ["-C", repo, "cat-file", "blob", p.blobOid], {
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    const blobBytes = (stdout as Buffer).toString("utf8");
    if (p.path !== intent.registryRelativePath) fail("E14", "CSJ_BIND_PATH", "bind path mismatch");
    if (blobBytes !== intent.registryBytes) fail("E14", "CSJ_BIND_BYTES", "bind bytes mismatch");
    freezeBind = Object.freeze({
      itemId: intent.itemId,
      pending: true as const,
      path: intent.registryRelativePath,
      mode: "100644" as const,
      blobBytes,
      blobBytesSha256: sha256Hex(blobBytes),
    });
    // E15
    const headBlob = await blobOrAbsent(repo, head, p.path);
    const baseBlob = await blobOrAbsent(repo, base, p.path);
    if (headBlob !== baseBlob) fail("E15", "CSJ_NONL1_HEAD_BASE", "HEAD and base must share nonL1 blob-or-absent");
  }

  // E16 cohort path base==head entry
  for (const entry of entries) {
    const baseE = await treeEntry(repo, base, entry.path);
    const headE = await treeEntry(repo, head, entry.path);
    const same = (!baseE && !headE) || (!!baseE && !!headE && baseE.mode === headE.mode && baseE.oid === headE.oid);
    if (!same) fail("E16", "CSJ_COHORT_PATH_BASE_HEAD", "cohort path base entry must equal HEAD entry", { path: entry.path });
  }

  // E16b L1(base) ⊆ L1(HEAD)
  const baseL1 = await listL1Tree(repo, base);
  const headL1 = await listL1Tree(repo, head);
  for (const [rel, entry] of baseL1) {
    const atHead = headL1.get(rel);
    if (!atHead || atHead.mode !== entry.mode || atHead.oid !== entry.oid) {
      fail("E16b", "CSJ_L1_APPEND_ONLY", "L1(base) must be subset of L1(HEAD)", { path: rel });
    }
  }

  // E19 remote behind 0 — fail closed on unreadable remote/rev-list.
  // CsjEligibilityError (behind!=0) must never be swallowed by a broad catch.
  let remotesRaw: string;
  try {
    remotesRaw = await gitText(repo, ["remote"]);
  } catch (error) {
    fail("E19", "CSJ_REMOTE_UNREADABLE", "git remote unreadable; fail closed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const remotes = remotesRaw.trim().split("\n").filter(Boolean);
  if (remotes.length > 0) {
    // @{u} requires the short branch name; refs/heads/X@{u} is not accepted by git.
    const branchShort = refName.startsWith("refs/heads/") ? refName.slice("refs/heads/".length) : refName;
    let upstream = "";
    try {
      upstream = (await gitText(repo, ["rev-parse", "--abbrev-ref", `${branchShort}@{u}`])).trim();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stderr = error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: Buffer | string }).stderr ?? "")
        : "";
      const combined = `${msg}\n${stderr}`;
      // Only the explicit "no upstream configured" case is soft-ok.
      if (!/no upstream configured/i.test(combined)) {
        fail("E19", "CSJ_REMOTE_UNREADABLE", "upstream rev-parse unreadable; fail closed", { cause: combined.trim() });
      }
      upstream = "";
    }
    if (upstream) {
      let behind: string;
      try {
        behind = (await gitText(repo, ["rev-list", "--count", `HEAD..${upstream}`])).trim();
      } catch (error) {
        fail("E19", "CSJ_REMOTE_UNREADABLE", "rev-list behind count unreadable; fail closed", {
          upstream,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (!/^\d+$/.test(behind)) {
        fail("E19", "CSJ_REMOTE_UNREADABLE", "rev-list behind count not an integer; fail closed", { upstream, behind });
      }
      if (behind !== "0") {
        fail("E19", "CSJ_REMOTE_BEHIND", "remote behind must be 0", { upstream, behind });
      }
    }
  }

  // E24/E28 worktree preimage: every path prefix component is lstat
  // non-symlink / non-gitlink / within real repo; final is regular 100644 bytes==blob.
  const worktreeFreeze: Array<{ path: string; mode: "100644"; bytesSha256: string; blobOid: string }> = [];
  for (const entry of entries) {
    const clause = entry.path.startsWith(L1_PREFIX) ? "E24" : "E28";
    await assertSafeCohortWorktreePath(repo, entry.path, clause);
    const abs = path.join(repo, ...entry.path.split("/").filter(Boolean));
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) {
      fail(clause, "CSJ_WORKTREE_SYMLINK", "cohort path must be regular non-symlink file", { path: entry.path });
    }
    if ((st.mode & 0o111) !== 0) {
      fail(clause, "CSJ_WORKTREE_MODE", "worktree executable bit not allowed; mode must be 100644", { path: entry.path });
    }
    const bytes = await fsp.readFile(abs);
    const { stdout } = await execFileAsync("git", ["-C", repo, "cat-file", "blob", entry.blobOid], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    const blob = stdout as Buffer;
    if (!bytes.equals(blob)) fail(clause, "CSJ_WORKTREE_BYTES", "worktree bytes must equal target blob", { path: entry.path });
    if (entry.mode !== "100644") fail(clause, "CSJ_ENTRY_MODE", "entry.mode must be 100644", { path: entry.path });
    worktreeFreeze.push({ path: entry.path, mode: "100644", bytesSha256: sha256Hex(bytes), blobOid: entry.blobOid });
  }

  // E26 index frozen or target — null current does NOT unconditionally pass.
  // currentIndex(path) ∈ { frozenIndexSnapshot(path), target(M,path) } (spec §5.7).
  const currentIndex = await snapshotIndexEntries(repo, entries.map((e) => e.path));
  for (const entry of entries) {
    const frozen = snapshot.get(entry.path) ?? null;
    const current = currentIndex.get(entry.path) ?? null;
    const target = `${entry.mode} ${entry.blobOid} 0`;
    if (current !== frozen && current !== target) {
      fail("E26", "CSJ_INDEX_DRIFT", "cohort index not in {frozen, target}", { path: entry.path, current, frozen, target });
    }
  }

  // E27 noncohort fingerprint
  const cohortSet = new Set(entries.map((e) => e.path));
  const noncohortIndexFingerprint = await fullIndexFingerprint(repo, cohortSet);
  const status = await statusSnapshot(repo);

  // E28 prefix/symlink/gitlink checks applied above via assertSafeCohortWorktreePath.
  // E29 covered by mode/path checks on put entries.

  // E30 LSEA — caller frame admits authority; eligibility does not re-lease.

  void resolveL1EnvelopeSchema;

  return Object.freeze({
    eligible: true as const,
    context: Object.freeze({
      abrainHome,
      repo,
      refName,
      episode,
      prepared,
      operation,
      frozenIndexSnapshot: snapshot,
      head,
      base,
      candidate,
      entries,
      scan,
      history,
      freezeBind,
      worktreeFreeze: Object.freeze(worktreeFreeze),
      noncohortIndexFingerprint,
      statusHash: status.hash,
    }),
  });
}

/**
 * E24/E28: every progressive path prefix must lstat as non-symlink,
 * non-gitlink, and resolve within the real repository root. Final component
 * must exist (caller then checks regular-file + bytes).
 */
async function assertSafeCohortWorktreePath(repo: string, relPath: string, clause: "E24" | "E28"): Promise<void> {
  if (typeof relPath !== "string" || !relPath || relPath.startsWith("/") || relPath.includes("\0")) {
    fail(clause, "CSJ_PATH_INVALID", "cohort path must be a non-empty relative path", { path: relPath });
  }
  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail(clause, "CSJ_PATH_INVALID", "cohort path must not contain empty/./.. components", { path: relPath });
  }
  let repoReal: string;
  try {
    repoReal = await fsp.realpath(repo);
  } catch (error) {
    fail(clause, "CSJ_REPO_UNREADABLE", "repository realpath unreadable", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let cur = repo;
  for (let i = 0; i < parts.length; i += 1) {
    cur = path.join(cur, parts[i]!);
    const prefixRel = parts.slice(0, i + 1).join("/");
    let st: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      st = await fsp.lstat(cur);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        fail(clause, "CSJ_WORKTREE_ABSENT", i === parts.length - 1
          ? "cohort path worktree must exist (no clean-absent)"
          : "cohort path prefix component missing",
        { path: relPath, prefix: prefixRel });
      }
      throw error;
    }
    if (st.isSymbolicLink()) {
      fail(clause, "CSJ_WORKTREE_SYMLINK", "cohort path prefix must not be a symlink", {
        path: relPath,
        prefix: prefixRel,
      });
    }
    // gitlink (submodule) is mode 160000 in the index — refuse if present.
    try {
      const indexLine = (await gitText(repo, ["ls-files", "-s", "--", prefixRel])).trim();
      if (indexLine) {
        const mode = indexLine.split(/\s+/)[0] ?? "";
        if (mode === "160000") {
          fail(clause, "CSJ_WORKTREE_GITLINK", "cohort path prefix must not be a gitlink/submodule", {
            path: relPath,
            prefix: prefixRel,
          });
        }
      }
    } catch (error) {
      fail(clause, "CSJ_INDEX_UNREADABLE", "git ls-files unreadable while checking gitlink", {
        path: relPath,
        prefix: prefixRel,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (i < parts.length - 1) {
      if (!st.isDirectory()) {
        fail(clause, "CSJ_PATH_NOT_DIR", "cohort path intermediate component must be a directory", {
          path: relPath,
          prefix: prefixRel,
        });
      }
    }
    // Keep every resolved prefix inside the real repo (no escape via mount/symlink races
    // already refused above; realpath of existing non-symlink path).
    let curReal: string;
    try {
      curReal = await fsp.realpath(cur);
    } catch (error) {
      fail(clause, "CSJ_PATH_REALPATH", "cohort path prefix realpath unreadable", {
        path: relPath,
        prefix: prefixRel,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (curReal !== repoReal && !curReal.startsWith(`${repoReal}${path.sep}`)) {
      fail(clause, "CSJ_PATH_ESCAPE", "cohort path prefix escapes real repository root", {
        path: relPath,
        prefix: prefixRel,
        curReal,
        repoReal,
      });
    }
  }
}

async function listL1Tree(repo: string, commit: string): Promise<Map<string, { mode: string; oid: string }>> {
  const raw = await gitText(repo, ["ls-tree", "-r", "-z", commit, "--", L1_PREFIX]);
  const map = new Map<string, { mode: string; oid: string }>();
  for (const record of raw.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const rel = record.slice(tab + 1);
    if (meta.length >= 3) map.set(rel, { mode: meta[0]!, oid: meta[2]! });
  }
  return map;
}

/** Re-check bind freeze at Cert.F. */
export async function recheckCsjBindFreeze(abrainHome: string, freeze: CsjFreezeBind | null): Promise<void> {
  if (!freeze) return;
  const { listAbrainBindIntentPending } = await import("../abrain/bind-intent");
  const pending = await listAbrainBindIntentPending(abrainHome);
  if (pending.length !== 1) fail("E14", "CSJ_BIND_PENDING", "pending bind count drifted", { count: pending.length });
  const intent = pending[0]!;
  if (intent.itemId !== freeze.itemId) fail("E14", "CSJ_BIND_ITEM", "bind itemId drifted");
  if (intent.registryRelativePath !== freeze.path) fail("E14", "CSJ_BIND_PATH", "bind path drifted");
  if (intent.registryBytes !== freeze.blobBytes) fail("E14", "CSJ_BIND_BYTES", "bind bytes drifted");
}
