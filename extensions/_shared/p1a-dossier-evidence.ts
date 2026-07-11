import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { foldRecoveryEvents, readRecoveryEvents, recoverOpenRecoveryEpisodes } from "./convergence-recovery";
import { cohortManifestRoot, verifyCandidateShape, type PreparedExactCohortCommit } from "./git-exact-cohort";
import { sha256Hex } from "./jcs";

const execFileAsync = promisify(execFile);
const GIT_OID_RE = /^[0-9a-f]{40,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface P1ADossierExecutionEvidence {
  candidate?: unknown;
  cohortManifestRoot?: unknown;
  cohortPaths?: unknown;
  published?: unknown;
  indexConverged?: unknown;
  remote?: unknown;
  postFreeze?: unknown;
  validation?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Shape-only validation. This function does not establish that any claimed
 * publication, convergence, preservation, or remote fact is true. Execute-mode
 * acceptance additionally requires verifyP1ADossierExecutionArtifact(). */
export function validateP1ADossierExecutionEvidence(value: unknown): string[] {
  const evidence = record(value);
  if (!evidence) return ["execution_evidence_missing"];
  const errors: string[] = [];
  const candidate = typeof evidence.candidate === "string" && /^[0-9a-f]{40,64}$/.test(evidence.candidate) ? evidence.candidate : null;
  const cohort = typeof evidence.cohortManifestRoot === "string" && /^[0-9a-f]{64}$/.test(evidence.cohortManifestRoot) ? evidence.cohortManifestRoot : null;
  const paths = Array.isArray(evidence.cohortPaths) ? evidence.cohortPaths : [];
  const published = record(evidence.published);
  const converged = record(evidence.indexConverged);
  const remote = record(evidence.remote);
  const freeze = record(evidence.postFreeze);
  const validation = record(evidence.validation);
  if (!candidate) errors.push("candidate_missing");
  if (!cohort) errors.push("cohort_missing");
  if (paths.length === 0 || !paths.every((item) => typeof item === "string" && item.length > 0)) errors.push("cohort_paths_missing");
  if (!candidate || published?.candidate !== candidate || published.publication_confirmed !== true) errors.push("published_fact_missing");
  if (!candidate || converged?.candidate !== candidate) errors.push("index_convergence_fact_missing");
  if (remote?.status !== "ready" || remote.remoteContained !== true || remote.ahead !== 0 || remote.behind !== 0) errors.push("remote_exact_convergence_missing");
  if (
    freeze?.statusStable !== true
    || freeze.ownershipStable !== true
    || freeze.headStable !== true
    || freeze.indexStable !== true
    || freeze.remoteStable !== true
  ) errors.push("post_execute_freeze_missing");
  for (const key of [
    "startupReady",
    "exactCandidatePublished",
    "exactCohortBound",
    "exactIndexConverged",
    "headIsCandidate",
    "remoteContainsCandidate",
    "remoteExact",
    "nonCohortIndexAndWorktreePreserved",
    "worktreeBoundedToRecoveryTail",
    "boundedRecoveryTail",
    "recoveryClosed",
    "postStatusFreeze",
    "postOwnershipFreeze",
    "postHeadFreeze",
    "postIndexFreeze",
    "postRemoteFreeze",
  ]) {
    if (validation?.[key] !== true) errors.push(`validation_${key}_missing`);
  }
  return errors;
}

export interface P1ADossierArtifactVerification {
  ok: boolean;
  errors: readonly string[];
  reportExactSha256: string;
  recomputed: Readonly<Record<string, unknown>>;
}

export function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function gitBuffer(repo: string, args: readonly string[], timeout = 30_000): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: sanitizedGitEnvironment(),
    encoding: "buffer",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout as Buffer;
}

async function gitText(repo: string, args: readonly string[], timeout = 30_000): Promise<string> {
  return (await gitBuffer(repo, args, timeout)).toString("utf-8").trim();
}

async function gitRemoteText(repo: string, args: readonly string[], timeout = 30_000): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: { ...env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf-8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

function reportPayload(value: unknown): unknown {
  const report = record(value);
  if (!report) return value;
  const { artifactVerification: _ignored, ...payload } = report;
  return payload;
}

export function computeP1ADossierReportExactHash(value: unknown): string {
  return sha256Hex(`${JSON.stringify(reportPayload(value), null, 2)}\n`);
}

function preparedFromBody(body: Record<string, unknown>): PreparedExactCohortCommit | null {
  const rawEntries = Array.isArray(body.entries) ? body.entries : [];
  const entries: PreparedExactCohortCommit["entries"][number][] = [];
  for (const value of rawEntries) {
    const entry = record(value);
    if (
      !entry
      || typeof entry.path !== "string"
      || (entry.op !== "put" && entry.op !== "delete")
      || typeof entry.mode !== "string"
      || typeof entry.blobOid !== "string"
      || typeof entry.bytesSha256 !== "string"
    ) return null;
    entries.push({
      path: entry.path,
      op: entry.op,
      mode: entry.mode,
      blobOid: entry.blobOid,
      bytesSha256: entry.bytesSha256,
    });
  }
  const required = ["repo", "ref_name", "frozen_commit", "new_tree", "candidate", "cohort_manifest_root"] as const;
  if (entries.length === 0 || required.some((key) => typeof body[key] !== "string" || !(body[key] as string))) return null;
  return {
    repo: body.repo as string,
    refName: body.ref_name as string,
    frozenCommit: body.frozen_commit as string,
    newTree: body.new_tree as string,
    candidate: body.candidate as string,
    cohortManifestRoot: body.cohort_manifest_root as string,
    entries,
  };
}

function parseStageZero(raw: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of raw.toString("utf-8").split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const meta = row.slice(0, tab).trim().split(/\s+/);
    if (meta.length === 3 && meta[2] === "0") result.set(row.slice(tab + 1), `${meta[0]} ${meta[1]} 0`);
  }
  return result;
}

function parseTreeStageZero(raw: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of raw.toString("utf-8").split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const meta = row.slice(0, tab).trim().split(/\s+/);
    if (meta.length === 3) result.set(row.slice(tab + 1), `${meta[0]} ${meta[2]} 0`);
  }
  return result;
}

async function worktreeHash(repo: string, relativePath: string): Promise<string | null> {
  try { return sha256Hex(await fs.readFile(path.join(repo, ...relativePath.split("/")))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/** Recomputes execute evidence from Git, remote advertisement, recovery L1,
 * the shared index, and current worktree. Report booleans are never inputs to
 * these facts; they are checked only after the independent recomputation. */
export async function verifyP1ADossierExecutionArtifact(options: {
  abrainHome: string;
  report: unknown;
  expectedReportExactSha256: string;
  remote?: string;
  refName?: string;
}): Promise<P1ADossierArtifactVerification> {
  const repo = path.resolve(options.abrainHome);
  const report = record(options.report);
  const execution = record(report?.execution);
  const before = record(report?.before);
  const errors = validateP1ADossierExecutionEvidence(execution);
  const recomputed: Record<string, unknown> = {};
  const exactHash = computeP1ADossierReportExactHash(options.report);
  if (!SHA256_RE.test(options.expectedReportExactSha256) || exactHash !== options.expectedReportExactSha256) errors.push("report_exact_hash_mismatch");

  const candidate = typeof execution?.candidate === "string" && GIT_OID_RE.test(execution.candidate) ? execution.candidate : null;
  const episodeId = typeof execution?.episodeId === "string" ? execution.episodeId : null;
  const slot = Number.isInteger(execution?.slot) ? execution!.slot as number : null;
  let prepared: PreparedExactCohortCommit | null = null;
  if (episodeId && slot !== null) {
    try {
      const folded = foldRecoveryEvents(await readRecoveryEvents(repo, episodeId, "drain")).get(slot);
      prepared = folded?.prepared ? preparedFromBody(folded.prepared.body) : null;
      if (!prepared) errors.push("recovery_prepared_missing");
      if (!folded?.published || folded.published.body.candidate !== candidate || folded.published.body.publication_confirmed !== true) errors.push("recovery_published_missing");
      if (!folded?.converged || folded.converged.body.candidate !== candidate) errors.push("recovery_index_converged_missing");
    } catch (error) {
      errors.push(`recovery_read_failed:${(error as { code?: string })?.code ?? "unknown"}`);
    }
  } else {
    errors.push("recovery_binding_missing");
  }

  let cohortPaths: string[] = [];
  if (prepared && candidate) {
    cohortPaths = prepared.entries.map((entry) => entry.path).sort(compareUtf16CodeUnits);
    const root = cohortManifestRoot(prepared.entries);
    recomputed.cohortManifestRoot = root;
    recomputed.cohortPaths = cohortPaths;
    const reportedCohortPaths = Array.isArray(execution?.cohortPaths) ? execution.cohortPaths : [];
    if (
      reportedCohortPaths.length !== cohortPaths.length
      || cohortPaths.some((relativePath, index) => reportedCohortPaths[index] !== relativePath)
    ) errors.push("cohort_paths_mismatch");
    if (root !== prepared.cohortManifestRoot || root !== execution?.cohortManifestRoot) errors.push("cohort_manifest_root_mismatch");
    if (prepared.candidate !== candidate || path.resolve(prepared.repo) !== repo || !await verifyCandidateShape(repo, candidate, prepared)) errors.push("candidate_shape_mismatch");
  }

  let head: string | null = null;
  try {
    head = await gitText(repo, ["rev-parse", "HEAD^{commit}"], 5_000);
    recomputed.head = head;
    if (!candidate || head !== candidate) errors.push("head_not_candidate");
    if (candidate && cohortPaths.length) {
      const [indexRaw, treeRaw] = await Promise.all([
        gitBuffer(repo, ["ls-files", "-z", "--stage", "--", ...cohortPaths], 5_000),
        gitBuffer(repo, ["ls-tree", "-z", candidate, "--", ...cohortPaths], 5_000),
      ]);
      const index = parseStageZero(indexRaw);
      const tree = parseTreeStageZero(treeRaw);
      if (cohortPaths.some((item) => index.get(item) !== tree.get(item))) errors.push("cohort_index_not_converged");
    }
  } catch (error) {
    errors.push(`git_local_verify_failed:${(error as { code?: string | number })?.code ?? "unknown"}`);
  }

  const beforePathEvidence = record(before?.pathEvidence) ?? {};
  const cohortSet = new Set(cohortPaths);
  let nonCohortPreserved = true;
  for (const relativePath of Object.keys(beforePathEvidence).sort(compareUtf16CodeUnits)) {
    if (cohortSet.has(relativePath)) continue;
    const expected = record(beforePathEvidence[relativePath]);
    if (!expected) { nonCohortPreserved = false; continue; }
    try {
      const indexRaw = await gitBuffer(repo, ["ls-files", "--stage", "-z", "--", relativePath], 5_000);
      if (expected.worktreeSha256 !== await worktreeHash(repo, relativePath) || expected.indexEntrySha256 !== sha256Hex(indexRaw)) nonCohortPreserved = false;
    } catch { nonCohortPreserved = false; }
  }
  recomputed.nonCohortIndexAndWorktreePreserved = nonCohortPreserved;
  if (!nonCohortPreserved) errors.push("noncohort_not_preserved");

  try {
    const remote = options.remote ?? "origin";
    const refName = options.refName ?? "refs/heads/main";
    const advertisement = await gitRemoteText(repo, ["ls-remote", "--refs", remote, refName]);
    const fields = advertisement.split(/\s+/);
    const remoteCommit = fields.length === 2 && fields[1] === refName && GIT_OID_RE.test(fields[0]!) ? fields[0]! : null;
    if (!remoteCommit) throw new Error("remote advertisement missing exact ref");
    const counts = (await gitText(repo, ["rev-list", "--left-right", "--count", `${remoteCommit}...${head}`], 10_000)).split(/\s+/).map(Number);
    recomputed.remoteCommit = remoteCommit;
    recomputed.behind = counts[0];
    recomputed.ahead = counts[1];
    if (!candidate || remoteCommit !== candidate || counts[0] !== 0 || counts[1] !== 0) errors.push("remote_not_exact_ahead0");
  } catch (error) {
    recomputed.remoteErrorSha256 = sha256Hex(error instanceof Error ? error.message : String(error));
    errors.push("remote_query_failed");
  }

  try {
    const recovery = await recoverOpenRecoveryEpisodes(repo);
    recomputed.recovery = { open: recovery.open.length, terminal: recovery.terminal.length, quarantined: recovery.quarantined.length };
    if (recovery.terminal.length) errors.push("terminal_recovery_present");
    if (recovery.open.length) errors.push("open_recovery_present");
    if (recovery.quarantined.length) errors.push("quarantined_recovery_present");
  } catch (error) {
    errors.push(`recovery_scan_failed:${(error as { code?: string })?.code ?? "unknown"}`);
  }

  const unique = Object.freeze([...new Set(errors)].sort(compareUtf16CodeUnits));
  return Object.freeze({ ok: unique.length === 0, errors: unique, reportExactSha256: exactHash, recomputed: Object.freeze(recomputed) });
}
