import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { foldRecoveryEvents, recoverOpenRecoveryEpisodesFromScan, readRecoveryEvents } from "./convergence-recovery";
import { cohortManifestRoot, verifyCandidateShape, type PreparedExactCohortCommit } from "./git-exact-cohort";
import { sha256Hex } from "./jcs";
import { isCanonicalCohortPath, isGitOid, scanWholeL1Validated } from "./l1-schema-registry";

const execFileAsync = promisify(execFile);
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface P1ADossierLegacyResidue {
  path: string;
  status: "??" | " M";
  eventId: string;
  envelopeSchema: string;
  bodySchema: string;
  eventType: string;
  phase: "legacy_read_only";
}

export interface P1ADossierExecutionEvidence {
  candidate?: unknown;
  cohortManifestRoot?: unknown;
  cohortPaths?: unknown;
  published?: unknown;
  indexConverged?: unknown;
  postFreeze?: unknown;
  validation?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf16CodeUnits);
  const wanted = [...expected].sort(compareUtf16CodeUnits);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

const EXECUTION_KEYS = [
  "startup", "blockedReason", "candidate", "cohortManifestRoot", "episodeId", "slot", "cohortPaths",
  "published", "indexConverged", "evidenceErrors", "postFreeze", "validation",
] as const;
const POST_FREEZE_KEYS = [
  "statusStable", "ownershipStable", "headStable", "indexStable", "firstStatusSha256", "secondStatusSha256",
  "firstOwnershipSha256", "secondOwnershipSha256",
] as const;
const VALIDATION_KEYS = [
  "startupReady", "wholeL1Strict", "runtimeModeLocalConvergenceV2", "exactCandidatePublished", "exactCohortBound",
  "exactRefCasPublished", "exactIndexConverged", "nonCohortIndexAndWorktreePreserved", "worktreeBoundedToRecoveryTail",
  "boundedRecoveryTail", "recoveryClosed", "restartContinuity", "postStatusFreeze", "postOwnershipFreeze",
  "postHeadFreeze", "postIndexFreeze", "evidenceComplete",
] as const;
const OWNERSHIP_PREFLIGHT_KEYS = ["status", "dirtyCount", "instrumentation", "ownerProofs", "blockedPaths", "legacyResidue"] as const;
const LEGACY_RESIDUE_KEYS = ["path", "status", "eventId", "envelopeSchema", "bodySchema", "eventType", "phase"] as const;
const L1_EVENT_PATH_RE = /^l1\/events\/sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/;
const VERSIONED_SCHEMA_RE = /^[a-z0-9][a-z0-9-]*\/v[1-9][0-9]*$/;

export function validateP1ADossierOwnershipPreflightEvidence(value: unknown): string[] {
  const evidence = record(value);
  if (!evidence) return ["ownership_preflight_evidence_missing"];
  const errors: string[] = [];
  if (!exactKeys(evidence, OWNERSHIP_PREFLIGHT_KEYS)) errors.push("ownership_preflight_shape_mismatch");
  if (!Number.isSafeInteger(evidence.dirtyCount) || (evidence.dirtyCount as number) < 0) errors.push("ownership_dirty_count_invalid");
  if (!record(evidence.instrumentation) || !Array.isArray(evidence.ownerProofs) || !Array.isArray(evidence.blockedPaths) || !Array.isArray(evidence.legacyResidue)) errors.push("ownership_preflight_arrays_invalid");
  if (evidence.status !== "blocked" && evidence.status !== "accepted" && evidence.status !== "empty") errors.push("ownership_preflight_status_invalid");
  const residues = Array.isArray(evidence.legacyResidue) ? evidence.legacyResidue : [];
  let previous: string | null = null;
  for (const value of residues) {
    const residue = record(value);
    if (!residue || !exactKeys(residue, LEGACY_RESIDUE_KEYS)) {
      errors.push("legacy_residue_shape_mismatch");
      continue;
    }
    const match = typeof residue.path === "string" ? L1_EVENT_PATH_RE.exec(residue.path) : null;
    if (!match || match[1] !== match[3]!.slice(0, 2) || match[2] !== match[3]!.slice(2, 4) || residue.eventId !== match[3]) errors.push("legacy_residue_path_event_mismatch");
    if (residue.status !== "??" && residue.status !== " M") errors.push("legacy_residue_status_invalid");
    if (typeof residue.envelopeSchema !== "string" || !VERSIONED_SCHEMA_RE.test(residue.envelopeSchema) || typeof residue.bodySchema !== "string" || !VERSIONED_SCHEMA_RE.test(residue.bodySchema)) errors.push("legacy_residue_schema_invalid");
    if (typeof residue.eventType !== "string" || !residue.eventType || residue.phase !== "legacy_read_only") errors.push("legacy_residue_classification_invalid");
    if (previous !== null && typeof residue.path === "string" && compareUtf16CodeUnits(previous, residue.path) >= 0) errors.push("legacy_residue_order_invalid");
    if (typeof residue.path === "string") previous = residue.path;
  }
  return [...new Set(errors)].sort(compareUtf16CodeUnits);
}

/** Local-only CC-P1A-r8 execution schema. Remote delivery fields are not
 * optional diagnostics: their presence is a schema error. */
export function validateP1ADossierExecutionEvidence(value: unknown): string[] {
  const evidence = record(value);
  if (!evidence) return ["execution_evidence_missing"];
  const errors: string[] = [];
  if (!exactKeys(evidence, EXECUTION_KEYS)) errors.push("execution_shape_mismatch");
  const candidate = isGitOid(evidence.candidate) ? evidence.candidate : null;
  const cohort = typeof evidence.cohortManifestRoot === "string" && SHA256_RE.test(evidence.cohortManifestRoot) ? evidence.cohortManifestRoot : null;
  const paths = Array.isArray(evidence.cohortPaths) ? evidence.cohortPaths : [];
  const published = record(evidence.published);
  const converged = record(evidence.indexConverged);
  const freeze = record(evidence.postFreeze);
  const validation = record(evidence.validation);
  if (evidence.startup !== "ready" || evidence.blockedReason !== null) errors.push("startup_not_ready");
  if (typeof evidence.episodeId !== "string" || !SHA256_RE.test(evidence.episodeId) || !Number.isInteger(evidence.slot) || (evidence.slot as number) < 1 || (evidence.slot as number) > 5) errors.push("recovery_binding_invalid");
  if (!Array.isArray(evidence.evidenceErrors) || evidence.evidenceErrors.length !== 0) errors.push("execution_reported_errors");
  if (!candidate) errors.push("candidate_missing");
  if (!cohort) errors.push("cohort_missing");
  if (paths.length === 0 || !paths.every(isCanonicalCohortPath) || paths.some((item, index) => index > 0 && compareUtf16CodeUnits(paths[index - 1] as string, item as string) >= 0)) errors.push("cohort_paths_invalid");
  if (!candidate || published?.candidate !== candidate || published.publication_confirmed !== true) errors.push("published_fact_missing");
  if (!candidate || converged?.candidate !== candidate) errors.push("index_convergence_fact_missing");
  if (!freeze || !exactKeys(freeze, POST_FREEZE_KEYS) || freeze.statusStable !== true || freeze.ownershipStable !== true || freeze.headStable !== true || freeze.indexStable !== true) errors.push("post_execute_freeze_missing");
  if (!validation || !exactKeys(validation, VALIDATION_KEYS)) errors.push("validation_shape_mismatch");
  for (const key of VALIDATION_KEYS) if (validation?.[key] !== true) errors.push(`validation_${key}_missing`);
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
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  return { ...env, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

async function gitBuffer(repo: string, args: readonly string[], timeout = 30_000): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], { env: sanitizedGitEnvironment(), encoding: "buffer", timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout as Buffer;
}

async function gitText(repo: string, args: readonly string[], timeout = 30_000): Promise<string> {
  return (await gitBuffer(repo, args, timeout)).toString("utf-8").trim();
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
  let previous: string | null = null;
  for (const value of rawEntries) {
    const entry = record(value);
    if (!entry || !isCanonicalCohortPath(entry.path) || (previous !== null && compareUtf16CodeUnits(previous, entry.path) >= 0) || (entry.op !== "put" && entry.op !== "delete") || typeof entry.mode !== "string" || typeof entry.blobOid !== "string" || typeof entry.bytesSha256 !== "string") return null;
    previous = entry.path;
    entries.push({ path: entry.path, op: entry.op, mode: entry.mode, blobOid: entry.blobOid, bytesSha256: entry.bytesSha256 });
  }
  const required = ["symbolic_ref", "frozen_commit", "new_tree", "candidate", "cohort_manifest_root"] as const;
  if (entries.length === 0 || required.some((key) => typeof body[key] !== "string" || !(body[key] as string))) return null;
  return { repo: "", refName: body.symbolic_ref as string, frozenCommit: body.frozen_commit as string, newTree: body.new_tree as string, candidate: body.candidate as string, cohortManifestRoot: body.cohort_manifest_root as string, entries };
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
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw error; }
}

/** Recomputes CC-P1A-r8 acceptance exclusively from local Git, whole-L1,
 * recovery events, the shared index, and the worktree. */
export async function verifyP1ADossierExecutionArtifact(options: {
  abrainHome: string;
  report: unknown;
  expectedReportExactSha256: string;
}): Promise<P1ADossierArtifactVerification> {
  const repo = path.resolve(options.abrainHome);
  const report = record(options.report);
  const execution = record(report?.execution);
  const before = record(report?.before);
  const settings = record(report?.settings);
  const ownershipPreflight = record(report?.ownershipPreflight);
  const errors = [
    ...validateP1ADossierExecutionEvidence(execution),
    ...validateP1ADossierOwnershipPreflightEvidence(ownershipPreflight),
  ];
  const recomputed: Record<string, unknown> = {};
  const exactHash = computeP1ADossierReportExactHash(options.report);
  if (!SHA256_RE.test(options.expectedReportExactSha256) || exactHash !== options.expectedReportExactSha256) errors.push("report_exact_hash_mismatch");
  if (settings?.mode !== "local_convergence_v2" || settings.enabled !== true || settings.valid !== true) errors.push("runtime_mode_not_enabled_local_v2");

  const candidate = typeof execution?.candidate === "string" && GIT_OID_RE.test(execution.candidate) ? execution.candidate : null;
  const episodeId = typeof execution?.episodeId === "string" ? execution.episodeId : null;
  const slot = Number.isInteger(execution?.slot) ? execution!.slot as number : null;
  let prepared: PreparedExactCohortCommit | null = null;
  if (episodeId && slot !== null) {
    try {
      const folded = foldRecoveryEvents(await readRecoveryEvents(repo, episodeId, "drain")).get(slot);
      prepared = folded?.prepared ? preparedFromBody(folded.prepared.body) : null;
      if (prepared) prepared.repo = repo;
      if (!prepared) errors.push("recovery_prepared_missing");
      if (!folded?.published || folded.published.body.candidate !== candidate || folded.published.body.publication_confirmed !== true) errors.push("recovery_published_missing");
      if (!folded?.converged || folded.converged.body.candidate !== candidate) errors.push("recovery_index_converged_missing");
    } catch (error) { errors.push(`recovery_read_failed:${(error as { code?: string })?.code ?? "unknown"}`); }
  } else errors.push("recovery_binding_missing");

  let cohortPaths: string[] = [];
  if (prepared && candidate) {
    cohortPaths = prepared.entries.map((entry) => entry.path);
    const root = cohortManifestRoot(prepared.entries);
    recomputed.cohortManifestRoot = root;
    recomputed.cohortPaths = cohortPaths;
    const reported = Array.isArray(execution?.cohortPaths) ? execution.cohortPaths : [];
    if (reported.length !== cohortPaths.length || cohortPaths.some((relativePath, index) => reported[index] !== relativePath)) errors.push("cohort_paths_mismatch");
    if (root !== prepared.cohortManifestRoot || root !== execution?.cohortManifestRoot) errors.push("cohort_manifest_root_mismatch");
    if (prepared.candidate !== candidate || !await verifyCandidateShape(repo, candidate, prepared)) errors.push("candidate_shape_mismatch");
  }

  try {
    const head = await gitText(repo, ["rev-parse", "HEAD^{commit}"], 5_000);
    recomputed.head = head;
    if (!candidate || head !== candidate) errors.push("ref_not_exact_candidate");
    if (candidate && cohortPaths.length) {
      const [indexRaw, treeRaw] = await Promise.all([gitBuffer(repo, ["ls-files", "-z", "--stage", "--", ...cohortPaths], 5_000), gitBuffer(repo, ["ls-tree", "-z", candidate, "--", ...cohortPaths], 5_000)]);
      const index = parseStageZero(indexRaw);
      const tree = parseTreeStageZero(treeRaw);
      if (cohortPaths.some((item) => index.get(item) !== tree.get(item))) errors.push("cohort_index_not_converged");
    }
  } catch (error) { errors.push(`git_local_verify_failed:${(error as { code?: string | number })?.code ?? "unknown"}`); }

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
    const scan = await scanWholeL1Validated({ abrainHome: repo });
    recomputed.wholeL1 = {
      all: scan.all.length,
      historicalV2: scan.all.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v2").length,
      activeV3: scan.selected.filter((item) => item.registration.envelope_schema === "local-drain-recovery-envelope/v3").length,
      legacyReadOnly: scan.legacyReadOnly.length,
    };
    const beforeStatus = record(before?.status);
    const statusRows = Array.isArray(beforeStatus?.records) ? beforeStatus.records : [];
    const statusByPath = new Map<string, string>();
    for (const value of statusRows) {
      const row = record(value);
      if (typeof row?.path === "string" && (row.status === "??" || row.status === " M")) statusByPath.set(row.path, row.status);
    }
    const expectedLegacyResidue = scan.legacyReadOnly.flatMap((item): P1ADossierLegacyResidue[] => {
      const relativePath = item.relativePath;
      const status = relativePath ? statusByPath.get(relativePath) : undefined;
      if (!relativePath || (status !== "??" && status !== " M")) return [];
      return [{
        path: relativePath,
        status,
        eventId: item.eventId,
        envelopeSchema: item.registration.envelope_schema,
        bodySchema: item.registration.body_schema!,
        eventType: String(item.body.event_type),
        phase: "legacy_read_only",
      }];
    }).sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    recomputed.legacyResidue = expectedLegacyResidue;
    if (JSON.stringify(ownershipPreflight?.legacyResidue) !== JSON.stringify(expectedLegacyResidue)) errors.push("legacy_residue_recompute_mismatch");
    const recovery = recoverOpenRecoveryEpisodesFromScan(scan);
    recomputed.recovery = { open: recovery.open.length, terminal: recovery.terminal.length, quarantined: recovery.quarantined.length };
    if (recovery.terminal.length) errors.push("terminal_recovery_present");
    if (recovery.open.length) errors.push("open_recovery_present");
    if (recovery.quarantined.length) errors.push("quarantined_recovery_present");
  } catch (error) { errors.push(`whole_l1_scan_failed:${(error as { code?: string })?.code ?? "unknown"}`); }

  const unique = Object.freeze([...new Set(errors)].sort(compareUtf16CodeUnits));
  return Object.freeze({ ok: unique.length === 0, errors: unique, reportExactSha256: exactHash, recomputed: Object.freeze(recomputed) });
}
