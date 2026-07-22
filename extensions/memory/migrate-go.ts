import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MemorySettings } from "./settings";
import {
  defaultConfidence,
  extractTitle,
  inferKindFromPath,
  parseFrontmatter,
  scalarString,
  scalarNumber,
  splitCompiledTruth,
  splitFrontmatter,
} from "./parser";
import { isEmptyFrontmatterValue, markdownFilesForTarget, REQUIRED_FRONTMATTER_FIELDS } from "./lint";
import { legacyPensieveSeedFor, legacyPensieveSeedPrunedReason } from "./legacy-seeds";
import { clamp, normalizeBareSlug, prettyPath, titleFromSlug, throwIfAborted } from "./utils";
import { collectGitAuthorTimes, type GitAuthorTimes } from "./git-times";
import { withCanonicalMutationBarrier } from "../_shared/canonical-mutation-barrier";
import { canonicalGitRuntimeEnabled } from "../_shared/canonical-git-runtime";
import {
  abrainProjectDir,
  abrainProjectWorkflowsDir,
  abrainSedimentAuditPath,
  abrainWorkflowsDir,
  formatLocalIsoTimestamp,
  resolveActiveProject,
  validateAbrainProjectId,
} from "../_shared/runtime";

const execFileAsync = promisify(execFile);

/* ────────────────────────────────────────────────────────────────────────
 * Per-repo migration executor: .pensieve/ → ~/.abrain/projects/<id>/
 *
 * Spec: docs/migration/abrain-pensieve-migration.md §3
 *
 * Why a separate module from migrate.ts?
 *   - migrate.ts is a read-only planner that outputs a report. It infers
 *     a "what would change" view of a single .pensieve. Reused here for
 *     frontmatter normalization decisions (defaults, kind, status,
 *     confidence) so we don't drift from the planner.
 *   - migrate-go.ts is the actual writer. It owns precondition checks,
 *     entry routing (knowledge kind dir vs. workflows lane), atomic
 *     file moves, and the two paired git commits.
 *
 * Why not call sediment.writeProjectEntry per entry?
 *   - writeProjectEntry timestamps `created`/`updated` at "now" and
 *     emits a Timeline line "created by sediment project writer".
 *     For migration we preserve the original entry timestamps and add
 *     a Timeline note "migrated-from-legacy" instead. Reusing the writer
 *     would rewrite history.
 *   - writeProjectEntry targets <projectRoot>/.pensieve/<kind-dir>/, but
 *     migration target is ~/.abrain/projects/<id>/<kind-dir>/.
 *   - writeProjectEntry does per-entry git commit + lock; for a one-shot
 *     migration of 200+ entries we batch a single commit per side instead.
 *
 * Pipeline routing uses sediment.writeAbrainWorkflow (B1) because workflows
 * have a different schema (trigger/body/cross_project) and a separate
 * audit lane. That writer is the only place workflows can be created.
 * ──────────────────────────────────────────────────────────────────── */

export interface MigrationGoOptions {
  /** Absolute path to <cwd>/.pensieve. Project root is inferred as its parent. */
  pensieveTarget: string;
  /** Absolute path to ~/.abrain (env ABRAIN_ROOT or default os.homedir()/.abrain). */
  abrainHome: string;
  /** Optional assertion from caller; preflight independently resolves ADR 0017 strict binding and rejects mismatches. */
  projectId?: string;
  /** Override timestamp for migrated-from-legacy timeline; tests use this for stability. */
  migrationTimestamp?: string;
  cwd?: string;
  signal?: AbortSignal;
  settings: MemorySettings;
}

export interface MigrationGoEntryReport {
  source: string;
  target: string;
  slug: string;
  title: string;
  kind: string;
  route: "knowledge" | "workflow-project" | "workflow-cross-project";
  action: "migrated" | "skipped" | "pruned" | "failed";
  reason?: string;
  /** notes from analyzeEntry frontmatter normalization, e.g.
   *  ["missing frontmatter"], ["frontmatter-unparseable"],
   *  ["missing schema_version", "missing kind"]. Empty for entries that
   *  arrived with fully-populated, parseable frontmatter. Round 6 sonnet
   *  P1 audit fix: previously computed inside analyzeEntry but silently
   *  dropped when populating the entry report — the
   *  "frontmatter-unparseable" branch was dead code from a reporter
   *  standpoint. Now surfaced so reviewers can see what was synthesized. */
  normalizationNotes?: string[];
}

export interface MigrationGoResult {
  ok: boolean;
  projectId: string;
  projectIdSource: "strict-binding";
  parentRepoRoot: string;
  abrainProjectDir: string;
  entries: MigrationGoEntryReport[];
  movedCount: number;
  workflowCount: number;
  skippedCount: number;
  seedPrunedCount: number;
  failedCount: number;
  /** Number of successfully removed legacy source files that were not tracked
   *  by the parent git repo (including files hidden by .gitignore). These
   *  cannot be restored by parent reset/revert; abrain is the full copy. */
  untrackedSourceCount: number;
  parentCommitSha?: string | null;
  abrainCommitSha?: string | null;
  /** Git commit failures after entry-level migration work finished. Empty
   *  for clean success and for legitimate "nothing to commit" cases (e.g.
   *  untracked-only source cleanup). Non-empty makes `ok` false. */
  commitErrors: string[];
  /** HEAD sha of parent repo *before* migration started. Use for safe
   *  rollback when the parent repo was clean at migration start; if the
   *  parent was dirty, summary avoids suggesting `git reset --hard` because
   *  it would destroy unrelated work. */
  parentPreSha?: string | null;
  /** Whether parent `git status --porcelain` was empty at migration start.
   *  Informational only: dirty source repos are allowed post-B5. */
  parentRepoWasClean: boolean;
  /** HEAD sha of abrain repo *before* migration started. */
  abrainPreSha?: string | null;
  /** Reports from B4 step 6 (spec §3 step 6): rebuilt graph + markdown index
   *  on the abrain projects/<id>/ side so memory_list / facade can see the
   *  freshly-migrated entries without waiting for a doctor-lite run. */
  graphRebuilt?: { nodeCount: number; edgeCount: number } | null;
  markdownIndexRebuilt?: { entryCount: number; kindCount: number } | null;
  preconditionFailures: string[];
}

interface PreflightOutcome {
  ok: boolean;
  projectId: string;
  projectIdSource: "strict-binding";
  parentRepoRoot: string;
  /** HEAD sha of parent repo at preflight time. Captured so the migration
   *  summary can print a rollback command anchored on a concrete SHA rather
   *  than `HEAD~1` (which is wrong when sediment commits concurrently or
   *  the migration produces N+1 abrain commits). */
  parentPreSha?: string | null;
  /** Whether parent `git status --porcelain` was empty at preflight time.
   *  Dirty is allowed; this only controls rollback wording. */
  parentRepoWasClean: boolean;
  /** HEAD sha of abrain repo at preflight time. Same rationale. */
  abrainPreSha?: string | null;
  failures: string[];
}

function gitReadEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

async function gitHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      env: gitReadEnvironment(),
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/* ── Git helpers (small wrappers; throw → caller decides) ──────────── */

async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      env: gitReadEnvironment(),
      timeout: 3000,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gitIsClean(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain"], {
      env: gitReadEnvironment(),
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim().length === 0;
  } catch { return false; }
}

function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) return null;
  let p = line.slice(3);
  const arrow = p.lastIndexOf(" -> ");
  if (arrow >= 0) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) {
    try { p = JSON.parse(p); }
    catch { p = p.slice(1, -1); }
  }
  return p || null;
}

async function gitDirtyPathSet(cwd: string, scopeAbs: string): Promise<Set<string>> {
  try {
    const relScope = path.relative(cwd, scopeAbs) || ".";
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain", "--", relScope], {
      env: gitReadEnvironment(),
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = new Set<string>();
    for (const line of stdout.split("\n")) {
      const p = parsePorcelainPath(line.trimEnd());
      if (p) out.add(path.resolve(cwd, p));
    }
    return out;
  } catch { return new Set(); }
}

async function gitIsTracked(cwd: string, file: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", cwd, "ls-files", "--error-unmatch", "--", file], {
      env: gitReadEnvironment(),
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch { return false; }
}

function errorText(err: unknown): string {
  const anyErr = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string; code?: unknown };
  const stderr = typeof anyErr?.stderr === "string" ? anyErr.stderr : Buffer.isBuffer(anyErr?.stderr) ? anyErr.stderr.toString("utf-8") : "";
  const stdout = typeof anyErr?.stdout === "string" ? anyErr.stdout : Buffer.isBuffer(anyErr?.stdout) ? anyErr.stdout.toString("utf-8") : "";
  return (stderr || stdout || anyErr?.message || String(err)).trim().replace(/\s+/g, " ").slice(0, 500);
}

interface SourceRemoval {
  rel: string;
  tracked: boolean;
}

async function gitRmOrUnlink(cwd: string, file: string): Promise<SourceRemoval> {
  return withCanonicalMutationBarrier(cwd, () => gitRmOrUnlinkUnlocked(cwd, file));
}

async function gitRmOrUnlinkUnlocked(cwd: string, file: string): Promise<SourceRemoval> {
  const rel = path.relative(cwd, file);
  const tracked = await gitIsTracked(cwd, file);
  if (tracked) {
    try {
      await execFileAsync("git", ["-C", cwd, "rm", "-q", "-f", "--", file], { timeout: 5000, maxBuffer: 64 * 1024 });
    } catch (gitRmErr) {
      try {
        await fs.unlink(file);
      } catch (unlinkErr: any) {
        if (unlinkErr?.code !== "ENOENT") {
          throw new Error(`failed to remove migrated source ${rel}: git rm failed (${errorText(gitRmErr)}); unlink failed (${errorText(unlinkErr)})`);
        }
      }
      try {
        await execFileAsync("git", ["-C", cwd, "rm", "-q", "-f", "--cached", "--", file], { timeout: 5000, maxBuffer: 64 * 1024 });
      } catch (cachedErr) {
        throw new Error(`failed to stage migrated source removal ${rel}: git rm failed (${errorText(gitRmErr)}); git rm --cached failed (${errorText(cachedErr)})`);
      }
    }
  } else {
    try {
      await fs.unlink(file);
    } catch (unlinkErr: any) {
      if (unlinkErr?.code !== "ENOENT") {
        throw new Error(`failed to remove untracked migrated source ${rel}: ${errorText(unlinkErr)}`);
      }
    }
  }
  if (fsSync.existsSync(file)) {
    throw new Error(`failed to remove migrated source ${rel}: source still exists after removal`);
  }
  return { rel, tracked };
}

interface GitCommitOutcome {
  sha: string | null;
  error?: string;
  nothingToCommit?: boolean;
}

/**
 * Stage and commit changes in `cwd`.
 *
 * `pathspecs` switches parent-side commits into "commit only these exact
 * migrated source files" mode. This matters because B5+ migration no longer
 * requires the source repo or `.pensieve/` to be clean/tracked: pre-existing
 * staged changes (including `.pensieve/state.md` support files) MUST NOT
 * piggyback into the migration commit. Parent-side deletions are staged by
 * `git rm -f`; untracked source files are removed from disk and produce no
 * parent git commit entry. Pass `null` for the abrain side, where the whole
 * repo is the migration domain and `git add -A` is correct.
 */
async function gitCommitAll(
  cwd: string,
  message: string,
  pathspecs: string[] | null = null,
): Promise<GitCommitOutcome> {
  // Keep the complete index mutation under the shared ordering: the
  // process-local singleflight turn is acquired before the cross-process OFD
  // lease, and reentrant callers already holding the lease do not queue behind
  // themselves.
  return withCanonicalMutationBarrier(cwd, () => gitCommitAllUnlocked(cwd, message, pathspecs));
}

async function gitCommitAllUnlocked(
  cwd: string,
  message: string,
  pathspecs: string[] | null = null,
): Promise<GitCommitOutcome> {
  try {
    if (pathspecs && pathspecs.length === 0) return { sha: null, nothingToCommit: true };
    if (!pathspecs) {
      await execFileAsync("git", ["-C", cwd, "add", "-A"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    }
    const uniquePathspecs = pathspecs ? Array.from(new Set(pathspecs)) : null;
    const commitArgs = uniquePathspecs
      ? ["-C", cwd, "commit", "-m", message, "--", ...uniquePathspecs]
      : ["-C", cwd, "commit", "-m", message];
    await execFileAsync("git", commitArgs, { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      env: gitReadEnvironment(),
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    return { sha: stdout.trim() || null };
  } catch (err) {
    const msg = errorText(err);
    if (/nothing to commit|no changes added|no changes/i.test(msg)) return { sha: null, nothingToCommit: true };
    return { sha: null, error: msg || "git commit failed" };
  }
}

/* ── Preflight (§2 preconditions) ──────────────────────────────────── */

export async function preflightMigrationGo(opts: MigrationGoOptions): Promise<PreflightOutcome> {
  const failures: string[] = [];
  const pensieveAbs = path.resolve(opts.pensieveTarget);

  // Resolve parent repo root: git toplevel of the .pensieve's parent
  const inferredParent = path.dirname(pensieveAbs);
  const parentRepoRoot = (await gitToplevel(inferredParent)) ?? inferredParent;

  let pensieveTargetUsable = true;
  let parentRepoWasClean = false;
  if (path.basename(pensieveAbs) !== ".pensieve") {
    failures.push(`pensieve target must be the project .pensieve directory: ${pensieveAbs}`);
    pensieveTargetUsable = false;
  }
  try {
    const targetStat = fsSync.lstatSync(pensieveAbs);
    if (targetStat.isSymbolicLink()) {
      failures.push(`pensieve target must be a real project .pensieve directory, not a symlink: ${pensieveAbs}`);
      pensieveTargetUsable = false;
    } else if (!targetStat.isDirectory()) {
      failures.push(`pensieve target must be a directory: ${pensieveAbs}`);
      pensieveTargetUsable = false;
    }
  } catch {
    failures.push(`pensieve target not found: ${pensieveAbs}`);
    pensieveTargetUsable = false;
  }
  if (!fsSync.existsSync(opts.abrainHome)) {
    failures.push(`abrain home not found: ${opts.abrainHome}`);
  }

  // Project id resolution (ADR 0017 / B4.5): migration no longer decides
  // identity. It verifies the current repo is strict-bound via
  // .abrain-project.json + abrain registry + local-map, then uses that
  // bound project id. No git-remote/cwd fallback and no --project override:
  // typo-safe identity is a precondition.
  const binding = resolveActiveProject(parentRepoRoot, { abrainHome: opts.abrainHome });
  let projectId = "";
  const projectIdSource: "strict-binding" = "strict-binding";
  if (!binding.activeProject) {
    failures.push(`project binding status=${binding.reason}: run ${binding.reason === "manifest_missing" ? "`/abrain bind --project=<id>`" : "`/abrain bind`"} first; /memory migrate no longer infers project id`);
  } else {
    projectId = binding.activeProject.projectId;
    const expectedPensieve = path.join(binding.activeProject.projectRoot, ".pensieve");
    if (path.resolve(pensieveAbs) !== path.resolve(expectedPensieve)) {
      failures.push(`pensieve target ${pensieveAbs} is not the strict-bound project .pensieve (${expectedPensieve})`);
    }
    if (binding.activeProject.projectRoot !== path.resolve(parentRepoRoot)) {
      failures.push(`project binding root mismatch: binding root ${binding.activeProject.projectRoot} != target repo root ${parentRepoRoot}`);
    }
    if (opts.projectId && opts.projectId !== projectId) {
      failures.push(`project id mismatch: active binding is "${projectId}" but caller supplied "${opts.projectId}"`);
    }
    try { validateAbrainProjectId(projectId); }
    catch (e) { failures.push(`invalid project id "${projectId}": ${(e as Error).message}`); }
  }

  // Source repo sanity: after B5 cutover, `.pensieve/` is a legacy input
  // snapshot, not the canonical store. Do NOT require the parent repo to be
  // clean and do NOT require `.pensieve/` files to be git-tracked: untracked
  // or dirty memory is precisely what the user may want to migrate away
  // from. Parent-side cleanup commits use an exact pathspec and never sweep
  // unrelated staged changes.
  if (fsSync.existsSync(parentRepoRoot)) {
    parentRepoWasClean = await gitIsClean(parentRepoRoot);
    if (pensieveTargetUsable) {
      // .pensieve must contain at least one user-facing .md entry (derived
      // .state/.index files don't count). Without this, --go would commit
      // an empty migration and confuse the operator into thinking it ran.
      const userEntries = (await markdownFilesForTarget(pensieveAbs, opts.settings, opts.signal, { includeIgnored: true }))
        .filter((file) => isMigratableSource(file, pensieveAbs));
      if (userEntries.length === 0) {
        failures.push(`pensieve has no user entries to migrate at ${pensieveAbs} (only derived/support .state/.index/state.md files remain; migration is likely already complete)`);
      }
    }
  } else {
    failures.push(`parent repo root not found: ${parentRepoRoot}`);
  }

  // abrain repo must be clean
  if (fsSync.existsSync(opts.abrainHome)) {
    const abrainTopl = await gitToplevel(opts.abrainHome);
    if (!abrainTopl) {
      failures.push(`abrain home is not a git repo: ${opts.abrainHome}`);
    } else {
      const abrainClean = await gitIsClean(abrainTopl);
      if (!abrainClean) {
        failures.push(`abrain repo not clean: ${abrainTopl} (commit or stash before migrating)`);
      }
    }
  }

  // Capture pre-migration HEAD SHAs so the summary can print accurate
  // rollback commands anchored on a concrete commit (rather than HEAD~1
  // which is wrong when abrain has N workflow commits + 1 migrate(in) commit,
  // or when sediment auto-commits land concurrently).
  const parentPreSha = failures.length === 0 ? await gitHeadSha(parentRepoRoot) : null;
  const abrainPreSha = failures.length === 0 ? await gitHeadSha(opts.abrainHome) : null;

  return {
    ok: failures.length === 0,
    projectId,
    projectIdSource,
    parentRepoRoot,
    parentPreSha,
    parentRepoWasClean,
    abrainPreSha,
    failures,
  };
}

/* ── Per-entry analysis (route + normalized content) ───────────────── */

interface AnalyzedEntry {
  sourceAbs: string;
  relSource: string;        // relative to pensieveTarget
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  isPipeline: boolean;
  crossProject: boolean;
  route: "knowledge" | "workflow-project" | "workflow-cross-project";
  targetAbs: string;
  normalizedMarkdown: string;
  /** legacy entries with missing frontmatter, etc., that we filled in */
  normalizationNotes: string[];
}

const KNOWLEDGE_KIND_DIR: Record<string, string> = {
  maxim: "maxims",
  decision: "decisions",
  "anti-pattern": "knowledge",
  pattern: "knowledge",
  fact: "knowledge",
  preference: "knowledge",
  smell: "staging",
};

function kindDirectory(kind: string, status: string): string {
  if (status === "archived") return "archive";
  return KNOWLEDGE_KIND_DIR[kind] ?? "knowledge";
}

function unsupportedMigrationSource(relSource: string): string | null {
  const parts = relSource.split(/[\\/]+/).filter(Boolean);
  const shortTerm = parts[0] === "short-term";
  const head = shortTerm ? parts[1] : parts[0];
  if (!head || head === "state.md") return "support file outside memory entry directories";
  if (head === "pipelines") return null;
  if (["maxims", "decisions", "knowledge", "staging", "archive"].includes(head)) return null;
  return `unsupported memory directory: ${head}`;
}

function isMigratableSource(file: string, pensieveAbs: string): boolean {
  return unsupportedMigrationSource(path.relative(pensieveAbs, file)) === null;
}

function nowIsoLocal(): string {
  return formatLocalIsoTimestamp();
}

/* ── Timestamp recovery: git + fs + frontmatter triangulation ─────── */

/**
 * Normalize a frontmatter date scalar to a comparable ISO string.
 *
 * Legacy `.pensieve/` entries overwhelmingly carry `created: YYYY-MM-DD`
 * (matching the file slug prefix); a small minority carry full ISO
 * (e.g. `created: 2026-05-13T16:00:00.000+08:00`). We expand bare
 * YYYY-MM-DD to local-tz midnight so YYYY-MM-DD `2026-04-30` sorts
 * BEFORE a same-day git commit `2026-04-30T16:43:21+08:00`. Author
 * declared "on 4-30" → midnight is the most conservative reading.
 *
 * Returns null for unparseable input — caller treats as "no signal".
 */
function normalizeFmDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    return formatLocalIsoTimestamp(d);
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return formatLocalIsoTimestamp(d);
}

/**
 * Read fs.stat-derived ISO timestamps. `birthtimeMs` is only honored
 * when > 0 and finite — on filesystems without statx support Node
 * silently falls back to ctime or 0, both of which would corrupt the
 * min() result for `created`. `mtimeMs` is always present (any file
 * has a last-write time) so we always return it.
 */
async function readFsTimes(fileAbs: string): Promise<{ birthtime: string | null; mtime: string | null }> {
  try {
    const stat = await fs.stat(fileAbs);
    const birthtime =
      stat.birthtimeMs > 0 && Number.isFinite(stat.birthtimeMs)
        ? formatLocalIsoTimestamp(new Date(stat.birthtimeMs))
        : null;
    const mtime =
      Number.isFinite(stat.mtimeMs)
        ? formatLocalIsoTimestamp(new Date(stat.mtimeMs))
        : null;
    return { birthtime, mtime };
  } catch {
    return { birthtime: null, mtime: null };
  }
}

/**
 * Resolve `created` to the EARLIEST credible signal:
 *
 *   min(frontmatter.created, git-author-first, fs.birthtime)
 *
 * Why min works for all three:
 *   - `frontmatter.created` is authoring-time declaration; rarely
 *     ahead of reality, often slug-derived YYYY-MM-DD midnight.
 *   - `git-author-first` is the time the file first entered git;
 *     always ≥ real authoring time (you write, then commit).
 *   - `fs.birthtime` is inode creation time. For a file you authored
 *     locally and never re-checked-out, this is the REAL creation
 *     time and is typically EARLIER than the git commit. For a file
 *     pulled from `git clone`, birthtime = clone time and is
 *     typically LATER than git-author-first; min() naturally lets
 *     git win in that case.
 *
 * Both "clone-then-work" and "local-from-zero" workflows fall out
 * correctly without special-casing.
 *
 * Fallback chain when all three are missing: migrationTimestamp.
 */
async function resolveCreated(
  fileAbs: string,
  // 2026-05-24 fix: align with scalarString(value: Jsonish | undefined).
  // resolveUpdated below tightened the same way; both feed the same
  // parser-produced frontmatter shape (Record<string, Jsonish>).
  frontmatter: Record<string, import("./types").Jsonish>,
  gitTimes: GitAuthorTimes,
  migrationTimestamp: string,
): Promise<string> {
  const candidates: string[] = [];
  const fmCreated = scalarString(frontmatter.created);
  if (fmCreated) {
    const iso = normalizeFmDate(fmCreated);
    if (iso) candidates.push(iso);
  }
  const gitFirst = gitTimes.firstByPath.get(fileAbs);
  if (gitFirst) candidates.push(gitFirst);
  const fsTimes = await readFsTimes(fileAbs);
  if (fsTimes.birthtime) candidates.push(fsTimes.birthtime);
  return pickByEpoch(candidates, "min") ?? migrationTimestamp;
}

/**
 * Resolve `updated` to the LATEST credible signal — but asymmetric
 * vs `resolveCreated`: fs.mtime is NOT included for clean tracked files.
 * Reason: clone / checkout / git restore rewrite mtime to the filesystem-
 * write moment, producing a false "recently modified" signal for files
 * untouched since the last `git pull`. Trusting git-last-touch over fs.mtime
 * keeps clean tracked files honest.
 *
 * For untracked files (`git log` returns nothing), fs.mtime is the only
 * modification signal. For dirty tracked files (allowed post-B5), fs.mtime
 * is included because the working-tree edit is exactly what we migrate.
 */
async function resolveUpdated(
  fileAbs: string,
  // 2026-05-24 fix: same as resolveCreated above — align with scalarString.
  frontmatter: Record<string, import("./types").Jsonish>,
  gitTimes: GitAuthorTimes,
  migrationTimestamp: string,
  sourceDirty: boolean,
): Promise<string> {
  const candidates: string[] = [];
  const gitLast = gitTimes.lastByPath.get(fileAbs);
  if (gitLast) candidates.push(gitLast);
  const fmUpdated = scalarString(frontmatter.updated);
  if (fmUpdated) {
    const iso = normalizeFmDate(fmUpdated);
    if (iso) candidates.push(iso);
  }
  if (!gitLast || sourceDirty) {
    // Untracked file: fs.mtime is the only modification signal.
    // Dirty tracked file: working-tree mtime is the current migrated edit.
    const fsTimes = await readFsTimes(fileAbs);
    if (fsTimes.mtime) candidates.push(fsTimes.mtime);
  }
  // Future-date guard: an author may have erroneously written
  // `fm.updated: 2099-01-01`. Under max() that value would silently
  // dominate git-author-last and poison the migrated entry. Cap
  // candidates at the EARLIER of migrationTimestamp and real wall
  // clock — nothing can have been modified after migration ran AND
  // nothing can have been modified after the real present. Using
  // min(migrationTimestamp, Date.now()) keeps production behavior
  // bounded by migrationTimestamp (what callers pass), while tests
  // that fabricate a far-future migrationTimestamp still see the
  // guard engage at real-now.
  // `created` does not need this guard: min() naturally rejects
  // future-dated frontmatter as long as ANY past signal exists.
  const migrationEpoch = Date.parse(migrationTimestamp);
  const wallEpoch = Date.now();
  const capEpoch = Number.isFinite(migrationEpoch)
    ? Math.min(migrationEpoch, wallEpoch)
    : wallEpoch;
  const safe = candidates.filter((iso) => {
    const e = Date.parse(iso);
    return Number.isFinite(e) && e <= capEpoch;
  });
  return pickByEpoch(safe, "max") ?? migrationTimestamp;
}

/**
 * Pick the min/max of a list of ISO timestamps by their UTC epoch, NOT
 * by lexicographic string sort. ISO 8601 strings only sort
 * lexicographically when their timezone offsets are identical:
 *
 *   "2026-04-30T00:00:00+08:00"  semantically = 2026-04-29T16:00:00Z
 *   "2026-04-30T00:00:00+00:00"  semantically = 2026-04-30T00:00:00Z
 *
 * Lexicographically the +00:00 string is "smaller", but the +08:00
 * instant is actually earlier (-8h). Real legacy frontmatter mixes
 * bare `YYYY-MM-DD` (normalized to local-tz midnight), `Z`-suffixed
 * UTC, and `+08:00` tagged values — string sort would silently pick
 * the wrong candidate when these collide.
 *
 * Unparseable candidates (Date.parse returns NaN) are dropped; if
 * every candidate is unparseable we return undefined and caller falls
 * back to migrationTimestamp.
 */
function pickByEpoch(candidates: string[], mode: "min" | "max"): string | undefined {
  let bestIso: string | undefined;
  let bestEpoch: number | undefined;
  for (const iso of candidates) {
    const epoch = Date.parse(iso);
    if (!Number.isFinite(epoch)) continue;
    if (bestEpoch === undefined) {
      bestEpoch = epoch;
      bestIso = iso;
      continue;
    }
    if (mode === "min" ? epoch < bestEpoch : epoch > bestEpoch) {
      bestEpoch = epoch;
      bestIso = iso;
    }
  }
  return bestIso;
}

function buildNormalizedFrontmatter(input: {
  projectId: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  created: string;
  updated: string;
  preservedFields: Record<string, string>;
}): string {
  // Canonical field order, mirrors sediment writer + buildMarkdown layout.
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: project:${input.projectId}:${input.slug}`);
  lines.push("scope: project");
  lines.push(`kind: ${input.kind}`);
  lines.push(`status: ${input.status}`);
  lines.push(`confidence: ${input.confidence}`);
  lines.push("schema_version: 1");
  lines.push(`title: ${yamlScalar(input.title)}`);
  lines.push(`created: ${yamlScalar(input.created)}`);
  lines.push(`updated: ${yamlScalar(input.updated)}`);
  for (const [key, value] of Object.entries(input.preservedFields)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9._\-/+:@ ]+$/.test(value) && !/^[\s\-?:]/.test(value)) return value;
  return JSON.stringify(value);
}

function preservedFrontmatterLines(text: string, droppedKeys: Set<string>): Record<string, string> {
  // Extract raw line values for fields we want to preserve verbatim (e.g.
  // tags lists, trigger_phrases, relations). We don't parse YAML; we keep
  // the line as-is from the original frontmatter so list rendering stays
  // valid. Frontmatter block-level fields with `:` followed by newline
  // (multi-line values) are kept as a contiguous block.
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  let currentKey: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (!currentKey) return;
    if (droppedKeys.has(currentKey)) { currentKey = null; currentLines = []; return; }
    result[currentKey] = currentLines.length === 1
      ? currentLines[0]!
      : currentLines.join("\n").trimEnd();
    currentKey = null;
    currentLines = [];
  };
  for (const line of lines) {
    if (line === "---") continue;
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (m && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = m[1]!;
      currentLines = [m[2]!.replace(/^\s/, "")];
    } else if (currentKey) {
      currentLines.push(line);
    }
  }
  flush();
  return result;
}

function isPipelinePath(relPath: string): boolean {
  // Legacy pipeline locations: top-level `pipelines/` or nested
  // `short-term/pipelines/`. Filename convention is run-when-*.md
  // but not all legacy entries follow it, so trust the dir first.
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  return parts.includes("pipelines");
}

function readBool(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return false;
}

async function analyzeEntry(
  file: string,
  pensieveRoot: string,
  projectId: string,
  abrainHome: string,
  migrationTimestamp: string,
  gitTimes: GitAuthorTimes,
  dirtySourcePaths: Set<string>,
  _settings: MemorySettings,
): Promise<AnalyzedEntry> {
  // markdownFilesForTarget already filters .index/, .state/, .git/, and
  // _index.md (via IGNORE_DIRS + listFilesWithRg globs + the explicit
  // basename filter in lint.ts:231), so no per-entry derived-file guard
  // is reachable here.
  const relSource = path.relative(pensieveRoot, file);

  const raw = await fs.readFile(file, "utf-8");
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const { compiledTruth, timeline } = splitCompiledTruth(body);

  const id = scalarString(frontmatter.id);
  const pathSlug = path.basename(file, path.extname(file)) === "content"
    ? path.basename(path.dirname(file))
    : path.basename(file, path.extname(file));
  const slug = normalizeBareSlug(id?.replace(/^project:[^:]+:/, "") || pathSlug || extractTitle(body) || "entry");
  const title = scalarString(frontmatter.title) || extractTitle(body) || titleFromSlug(slug);
  const status = scalarString(frontmatter.status) || "active";

  const isPipeline = isPipelinePath(relSource) || scalarString(frontmatter.kind) === "pipeline";
  const crossProject = readBool(frontmatter.cross_project);

  /* ── pipeline routing ── */
  if (isPipeline) {
    const targetDir = crossProject
      ? abrainWorkflowsDir(abrainHome)
      : abrainProjectWorkflowsDir(abrainHome, projectId);
    const targetAbs = path.join(targetDir, `${slug}.md`);
    // Workflow markdown is built by writeAbrainWorkflow; we pass through the
    // raw legacy body as-is and let the writer regenerate frontmatter + Timeline.
    // The route flag tells runMigrationGo which writer to invoke.
    return {
      sourceAbs: file,
      relSource,
      slug,
      title,
      kind: "workflow",
      status,
      confidence: 5,
      isPipeline: true,
      crossProject,
      route: crossProject ? "workflow-cross-project" : "workflow-project",
      targetAbs,
      normalizedMarkdown: "",  // not used for workflows; writer rebuilds
      normalizationNotes: [],
    };
  }

  /* ── knowledge-kind routing ── */
  const inferredKind = scalarString(frontmatter.kind) || scalarString(frontmatter.type) || inferKindFromPath(relSource);
  const kind = legacyKindNormalize(inferredKind);
  const confidence = clamp(
    scalarNumber(frontmatter.confidence) ?? defaultConfidence(kind),
    0,
    10,
  );
  // `created` / `updated` triangulate frontmatter, git author-date,
  // and fs.birthtime/mtime; see resolveCreated / resolveUpdated for
  // the min/max policies. Pre-`git-times` versions hard-coded
  // migrationTimestamp here, which made every legacy entry look
  // "created today" — destroying time-aware LLM rerank signal.
  // (Old comment kept for context):
  // Both `created` and `updated` default to the full ISO migrationTimestamp
  // when the source frontmatter is missing them. Earlier we used
  // `migrationTimestamp.slice(0, 10)` for `created` (YYYY-MM-DD only) but
  // sediment's own `buildMarkdown` (writer.ts) writes both as full ISO via
  // `nowIso()`, so the date-only form was a per-migration inconsistency
  // (Round 5 audit, deepseek-v4-pro P1). Caveat: this still overwrites
  // the *original* creation date when the source had none recorded —
  // there is no reliable byte-accurate "created" signal in legacy
  // .pensieve/ entries that didn't carry one in frontmatter.
  const created = await resolveCreated(file, frontmatter, gitTimes, migrationTimestamp);
  const updated = await resolveUpdated(file, frontmatter, gitTimes, migrationTimestamp, dirtySourcePaths.has(path.resolve(file)));

  const notes: string[] = [];
  if (!frontmatterText) {
    notes.push("missing frontmatter");
  } else if (Object.keys(frontmatter).length === 0) {
    // frontmatterText was non-empty but parseFrontmatter (lenient line-by-
    // line key:value regex) didn't recognize a single field. The entry is
    // either corrupted YAML, indented-only content, or uses syntax the
    // parser doesn't handle (e.g. nested mappings without keys). Surface
    // this distinctly from "missing frontmatter" so reviewers don't think
    // the migration silently filled defaults on a fully-populated entry.
    notes.push("frontmatter-unparseable");
  }
  if (isEmptyFrontmatterValue(frontmatter.schema_version)) notes.push("missing schema_version");
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (isEmptyFrontmatterValue(frontmatter[field])) notes.push(`missing ${field}`);
  }
  if (timeline.length === 0) notes.push("missing Timeline entries");
  if (!/^##\s+Timeline\s*$/m.test(body)) notes.push("missing ## Timeline heading");

  const preserved = preservedFrontmatterLines(frontmatterText, new Set([
    "id", "scope", "kind", "type", "status", "confidence", "schema_version",
    "title", "created", "updated",
  ]));

  const newFrontmatter = buildNormalizedFrontmatter({
    projectId,
    slug,
    title,
    kind,
    status,
    confidence,
    created,
    updated,
    preservedFields: preserved,
  });

  // Build body: keep compiledTruth + ensure `# <title>` heading + reattach
  // Timeline (preserving existing entries, prepending migrated-from-legacy).
  const newBody = buildNormalizedBody(title, compiledTruth, timeline, migrationTimestamp);
  const normalizedMarkdown = `${newFrontmatter}\n\n${newBody}\n`;

  const kindDir = kindDirectory(kind, status);
  const targetAbs = path.join(abrainProjectDir(abrainHome, projectId), kindDir, `${slug}.md`);

  return {
    sourceAbs: file,
    relSource,
    slug,
    title,
    kind,
    status,
    confidence,
    isPipeline: false,
    crossProject: false,
    route: "knowledge",
    targetAbs,
    normalizedMarkdown,
    normalizationNotes: notes,
  };
}

function legacyKindNormalize(kindOrType: string): string {
  const k = (kindOrType || "").toLowerCase().trim();
  if (k === "maxim") return "maxim";
  if (k === "decision") return "decision";
  if (k === "pattern") return "pattern";
  if (k === "anti-pattern" || k === "antipattern") return "anti-pattern";
  if (k === "preference") return "preference";
  if (k === "smell") return "smell";
  if (k === "knowledge") return "fact";   // legacy alias → fact
  if (k === "fact") return "fact";
  return "fact";
}

function buildNormalizedBody(
  title: string,
  compiledTruth: string,
  timeline: string[],
  migrationTimestamp: string,
): string {
  let main = compiledTruth.trim();
  // Defense against frontmatter break-out (same trick as sediment writer):
  // body line that is exactly `---` would re-open frontmatter on next parse.
  main = main.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(main)) main = `# ${title}\n\n${main}`;
  const tlLines = ["## Timeline", ""];
  // Round 7 P0 (sonnet audit fix): legacy timeline rows come first (oldest
  // first), then the migration meta-row last (newest). Previously the
  // migration row was pushed BEFORE the legacy rows, producing reverse-
  // chronological output:
  //   - 2026-05-12T... | migration | migrated-from-legacy   ← NEWEST first (wrong)
  //   - 2026-05-08      | smoke | captured | ok               ← OLDER second
  // That tripped lint T5 chronological-order warning on every migrated
  // entry with a non-empty legacy timeline, and made LLM stage-2 rerank
  // read the migration meta as "most recent state".
  for (const line of timeline) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // existing lines already start with `- ts | ...`; keep verbatim
    tlLines.push(trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`);
  }
  tlLines.push(`- ${migrationTimestamp} | migration | migrated-from-legacy | one-shot per-repo migration to abrain projects substrate`);
  return `${main.trim()}\n\n${tlLines.join("\n")}`;
}

/* ── Run (write + commit) ──────────────────────────────────────────── */

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  // Round 8 P1 (deepseek R8 audit): finally-cleanup the tmp file so
  // crash-between-writeFile-and-rename doesn't leak `.tmp-*` artifacts.
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function runMigrationGo(opts: MigrationGoOptions): Promise<MigrationGoResult> {
  if (canonicalGitRuntimeEnabled()) {
    throw new Error("CANONICAL_MIGRATION_REQUIRES_EVENT_IMPORT: /memory migrate --go cannot write legacy Markdown while canonicalGitRuntime is enabled");
  }
  const abrainHome = path.resolve(opts.abrainHome);
  try {
    await fs.access(abrainHome);
  } catch {
    // Preserve the regular preflight result when the configured home is absent;
    // the OFD lease requires an existing real directory.
    return runMigrationGoUnlocked(opts);
  }
  return withCanonicalMutationBarrier(abrainHome, () => runMigrationGoUnlocked(opts));
}

async function runMigrationGoUnlocked(opts: MigrationGoOptions): Promise<MigrationGoResult> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const pensieveAbs = path.resolve(opts.pensieveTarget);
  const abrainHome = path.resolve(opts.abrainHome);
  const migrationTimestamp = opts.migrationTimestamp || nowIsoLocal();

  const pre = await preflightMigrationGo(opts);
  if (!pre.ok) {
    return {
      ok: false,
      projectId: pre.projectId,
      projectIdSource: pre.projectIdSource,
      parentRepoRoot: pre.parentRepoRoot,
      abrainProjectDir: pre.projectId ? abrainProjectDir(abrainHome, pre.projectId) : "",
      entries: [],
      movedCount: 0,
      workflowCount: 0,
      skippedCount: 0,
      seedPrunedCount: 0,
      failedCount: 0,
      untrackedSourceCount: 0,
      commitErrors: [],
      parentPreSha: pre.parentPreSha ?? null,
      parentRepoWasClean: pre.parentRepoWasClean,
      abrainPreSha: pre.abrainPreSha ?? null,
      preconditionFailures: pre.failures,
    };
  }

  const projectId = pre.projectId;
  const parentRepoRoot = pre.parentRepoRoot;
  const projectAbrainDir = abrainProjectDir(abrainHome, projectId);

  // Lazy import to avoid pulling sediment into the memory module's eager
  // dependency graph. The writer module is independently bundled.
  const { writeAbrainWorkflow } = await import("../sediment/writer");
  const { DEFAULT_SEDIMENT_SETTINGS } = await import("../sediment/settings");

  const files = await markdownFilesForTarget(pensieveAbs, opts.settings, opts.signal, { includeIgnored: true });
  // Batch git author-date lookup for the whole .pensieve scope. One
  // subprocess pair (first-add + last-touch) replaces O(N) per-file
  // git log calls and keeps the 364-file ~/.pi migration well under a
  // second. analyzeEntry pulls per-file ISOs out of these maps; empty
  // maps are a safe degenerate (resolveCreated/Updated fall back to
  // fs.birthtime/mtime and frontmatter).
  const gitTimes = await collectGitAuthorTimes(parentRepoRoot, pensieveAbs, opts.signal);
  const dirtySourcePaths = await gitDirtyPathSet(parentRepoRoot, pensieveAbs);
  const entries: MigrationGoEntryReport[] = [];
  let movedCount = 0;
  let workflowCount = 0;
  let skippedCount = 0;
  let seedPrunedCount = 0;
  let failedCount = 0;
  let untrackedSourceCount = 0;
  const parentRemovedPaths: string[] = [];

  for (const file of files) {
    throwIfAborted(opts.signal);
    const relSource = path.relative(pensieveAbs, file);
    const unsupported = unsupportedMigrationSource(relSource);
    if (unsupported) {
      skippedCount += 1;
      const slug = normalizeBareSlug(path.basename(file, path.extname(file)) || "support-file");
      entries.push({
        source: relSource,
        target: "",
        slug,
        title: titleFromSlug(slug),
        kind: "support",
        route: "knowledge",
        action: "skipped",
        reason: unsupported,
      });
      continue;
    }
    try {
      const raw = await fs.readFile(file, "utf-8");
      const { frontmatterText } = splitFrontmatter(raw);
      const seed = legacyPensieveSeedFor(relSource, parseFrontmatter(frontmatterText));
      if (seed) {
        // P0 fix (2026-05-14 audit): extract-disposition seeds reference a
        // canonical global copy that may not exist yet. If the globalTarget
        // file is missing, DO NOT prune — the content would be permanently
        // lost. Fail the entry instead so the operator can create the
        // canonical copy first.
        if (seed.globalTarget) {
          const globalCopy = path.join(abrainHome, seed.globalTarget);
          try {
            await fs.access(globalCopy);
          } catch {
            skippedCount += 1;
            failedCount += 1;
            entries.push({
              source: relSource,
              target: seed.globalTarget,
              slug: seed.slug,
              title: seed.title,
              kind: seed.kind,
              route: seed.kind === "workflow" ? "workflow-cross-project" : "knowledge",
              action: "failed",
              reason: `extract seed's canonical copy not found in abrain: ${seed.globalTarget}. Create it first (e.g. copy the file manually into ~/.abrain/${seed.globalTarget}) or the content will be lost on prune.`,
            });
            continue;
          }
        }
        const removal = await gitRmOrUnlink(parentRepoRoot, file);
        if (removal.tracked) parentRemovedPaths.push(removal.rel);
        else untrackedSourceCount += 1;
        skippedCount += 1;
        seedPrunedCount += 1;
        entries.push({
          source: relSource,
          // For "extract" seeds target points at the canonical global copy;
          // for "obsolete" seeds there is no global copy and target is "".
          target: seed.globalTarget ?? "",
          slug: seed.slug,
          title: seed.title,
          kind: seed.kind,
          route: seed.kind === "workflow" ? "workflow-cross-project" : "knowledge",
          action: "pruned",
          reason: legacyPensieveSeedPrunedReason(seed),
        });
        continue;
      }

      const analyzed = await analyzeEntry(file, pensieveAbs, projectId, abrainHome, migrationTimestamp, gitTimes, dirtySourcePaths, opts.settings);

      if (analyzed.isPipeline) {
        const raw = await fs.readFile(file, "utf-8");
        const { body } = splitFrontmatter(raw);
        const { compiledTruth, timeline } = splitCompiledTruth(body);
        // Trigger heuristic: explicit `trigger:` frontmatter wins; else look
        // for "**Trigger**:" line in body; else use a generic placeholder.
        const fm = parseFrontmatter(splitFrontmatter(raw).frontmatterText);
        const trigger = scalarString(fm.trigger)
          || (compiledTruth.match(/\*\*Trigger\*\*:\s*(.+)/i)?.[1]?.trim())
          || `migrated pipeline: ${analyzed.title}`;

        // workflowBody: drop existing `# <title>` since the writer prepends
        // one. Preserve everything else as-is; timeline gets regenerated
        // by writer (B1 deliberately drops legacy Timeline to keep audit
        // history single-source). We add legacy Timeline as a note paragraph
        // so the data isn't lost.
        let workflowBody = compiledTruth.trim();
        workflowBody = workflowBody.replace(/^#\s+.*$/m, "").trim();
        if (timeline.length > 0) {
          workflowBody += `\n\n### Legacy Timeline\n${timeline.map((line) => line.trim().startsWith("- ") ? line.trim() : `- ${line.trim()}`).join("\n")}`;
        }
        if (workflowBody.length < 20) {
          workflowBody = `${workflowBody}\n\n(migrated from ${prettyPath(file, cwd)}; body recovered as-is)`;
        }

        const result = await writeAbrainWorkflow(
          {
            title: analyzed.title,
            trigger,
            body: workflowBody,
            crossProject: analyzed.crossProject,
            projectId: analyzed.crossProject ? undefined : projectId,
            slug: analyzed.slug,
            timelineNote: "migrated from legacy .pensieve/pipelines/",
          },
          { abrainHome, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true } },
        );
        const notes = analyzed.normalizationNotes.length > 0 ? analyzed.normalizationNotes : undefined;
        if (result.status === "created") {
          let removal: SourceRemoval;
          try {
            removal = await gitRmOrUnlink(parentRepoRoot, file);
          } catch (removeErr) {
            // Avoid leaving a workflow target that will collide on retry if
            // the legacy source could not be removed. If the workflow writer
            // already committed the create, the final abrain commit below will
            // record this cleanup deletion; either way result.ok becomes false.
            await fs.unlink(result.path).catch(() => {});
            throw removeErr;
          }
          if (removal.tracked) parentRemovedPaths.push(removal.rel);
          else untrackedSourceCount += 1;
          workflowCount += 1;
          entries.push({
            source: relSource,
            target: path.relative(abrainHome, result.path),
            slug: result.slug,
            title: analyzed.title,
            kind: "workflow",
            route: analyzed.route,
            action: "migrated",
            normalizationNotes: notes,
          });
        } else {
          failedCount += 1;
          entries.push({
            source: relSource,
            target: path.relative(abrainHome, result.path),
            slug: result.slug,
            title: analyzed.title,
            kind: "workflow",
            route: analyzed.route,
            action: "failed",
            reason: result.reason || result.status,
            normalizationNotes: notes,
          });
        }
        continue;
      }

      // knowledge route: atomic write + git rm source
      const knowledgeNotes = analyzed.normalizationNotes.length > 0 ? analyzed.normalizationNotes : undefined;
      if (fsSync.existsSync(analyzed.targetAbs)) {
        failedCount += 1;
        entries.push({
          source: relSource,
          target: path.relative(abrainHome, analyzed.targetAbs),
          slug: analyzed.slug,
          title: analyzed.title,
          kind: analyzed.kind,
          route: "knowledge",
          action: "failed",
          reason: "target already exists in abrain projects dir (slug collision)",
          normalizationNotes: knowledgeNotes,
        });
        continue;
      }
      await atomicWrite(analyzed.targetAbs, analyzed.normalizedMarkdown);
      let removal: SourceRemoval;
      try {
        removal = await gitRmOrUnlink(parentRepoRoot, file);
      } catch (removeErr) {
        // If we cannot remove the legacy source, do not leave an orphaned
        // abrain copy that will collide on retry. Workflows are harder to
        // roll back because writeAbrainWorkflow may have committed already;
        // knowledge writes are local atomic files and can be cleaned here.
        await fs.unlink(analyzed.targetAbs).catch(() => {});
        throw removeErr;
      }
      if (removal.tracked) parentRemovedPaths.push(removal.rel);
      else untrackedSourceCount += 1;
      movedCount += 1;
      entries.push({
        source: relSource,
        target: path.relative(abrainHome, analyzed.targetAbs),
        slug: analyzed.slug,
        title: analyzed.title,
        kind: analyzed.kind,
        route: "knowledge",
        action: "migrated",
        normalizationNotes: knowledgeNotes,
      });
    } catch (e: unknown) {
      failedCount += 1;
      entries.push({
        source: relSource,
        target: "",
        slug: "",
        title: "",
        kind: "",
        route: "knowledge",
        action: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // B4 spec §3 step 6: rebuild abrain projects/<id>/.index/graph.json +
  // _index.md so memory_list / facade can read the migrated entries
  // immediately. We do this before the abrain commit so the index files
  // ship inside the same commit. Failures are non-fatal (commit still
  // happens; user can run `/memory rebuild --graph|--index` manually).
  let graphRebuilt: { nodeCount: number; edgeCount: number } | null = null;
  let markdownIndexRebuilt: { entryCount: number; kindCount: number } | null = null;
  if (movedCount > 0) {
    try {
      const { rebuildGraphIndex } = await import("./graph");
      const { rebuildMarkdownIndex } = await import("./index-file");
      const gReport = await rebuildGraphIndex(projectAbrainDir, opts.settings, opts.signal, cwd);
      graphRebuilt = { nodeCount: gReport.nodeCount, edgeCount: gReport.edgeCount };
      const mReport = await rebuildMarkdownIndex(projectAbrainDir, opts.settings, opts.signal, cwd);
      markdownIndexRebuilt = { entryCount: mReport.entryCount, kindCount: mReport.kindCount };
    } catch {
      // Non-fatal: leave nulls; user can run /memory rebuild manually.
      graphRebuilt = null;
      markdownIndexRebuilt = null;
    }
  }

  // Single commit per side (workflow writer already committed individual
  // workflows in abrain; we commit any leftover staged changes — typically
  // the knowledge mv-ins + the rebuilt index files. In case
  // writeAbrainWorkflow's gitCommit hit a soft failure we don't want to
  // leave orphans).
  const parentBasename = path.basename(parentRepoRoot);
  // Parent side: commit only exact tracked legacy source paths that were
  // successfully removed by this run. This isolates unrelated staged changes
  // both outside `.pensieve/` and inside support files such as state.md.
  // Round 7 P0-D legacy `.pensieve/MIGRATED_TO_ABRAIN` guard removed in
  // the 2026-05-13 sediment cutover. The guard's only job was to reject
  // post-migration `.pensieve/` sediment writes during the B5 transition
  // window. After the cutover, sediment writer no longer touches
  // `.pensieve/` under any condition, so the guard has no remaining
  // reader. Strict binding (`<projectRoot>/.abrain-project.json` +
  // `<abrainHome>/projects/<id>/_project.json`) is now the only
  // post-migration identity contract. New migrations leave `.pensieve/`
  // empty (or with whatever the user kept manually); doctor-lite
  // identifies a directory as already-migrated by absence of entries
  // plus presence of the abrain project counterpart, not by a flag file.
  //
  // Round 8 P1 (sonnet R8 audit fix): write a single migration audit row
  // to the abrain-side sediment audit log so post-migration forensics
  // can reconstruct "which entries came from which project's .pensieve
  // at what time". Previously the only persisted migration trail was the
  // parent + abrain git commit messages (entry-count only, no per-entry
  // source→target mapping). Crashes mid-migration left no jsonl record
  // of which entries were already written. Best-effort: if audit append
  // fails (ENOSPC etc), do NOT block the migration return — the abrain
  // git history still has the canonical truth.
  try {
    const auditPath = abrainSedimentAuditPath(abrainHome);
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    const row = {
      timestamp: migrationTimestamp,
      operation: "migrate_go",
      lane: "system",
      projectId,
      projectIdSource: pre.projectIdSource,
      parentRepoRoot,
      abrainProjectDir: projectAbrainDir,
      movedCount,
      workflowCount,
      skippedCount,
      seedPrunedCount,
      failedCount,
      untrackedSourceCount,
      parentPreSha: pre.parentPreSha ?? null,
      parentRepoWasClean: pre.parentRepoWasClean,
      abrainPreSha: pre.abrainPreSha ?? null,
      // Per-entry mapping. Limit to avoid huge audit lines on giant
      // migrations — first 200 entries inline, rest summarized by count.
      entries: entries.slice(0, 200).map((e) => ({
        source: e.source,
        target: e.target,
        slug: e.slug,
        kind: e.kind,
        route: e.route,
        action: e.action,
        ...(e.reason ? { reason: e.reason } : {}),
      })),
      entries_total: entries.length,
      entries_truncated: entries.length > 200,
    };
    await fs.appendFile(auditPath, JSON.stringify(row) + "\n", "utf-8");
  } catch {
    // best-effort — audit failure does not abort migration
  }
  const seedPrunedSuffix = seedPrunedCount > 0 ? ` + ${seedPrunedCount} seed pruned` : "";
  const parentCommit = await gitCommitAll(
    parentRepoRoot,
    `chore: migrate .pensieve → ~/.abrain/projects/${projectId} (${movedCount + workflowCount} entries${seedPrunedSuffix})`,
    parentRemovedPaths,
  );
  // Abrain side: whole repo IS the migration target (knowledge entries +
  // rebuilt index files + workflow commits' staging), so add -A is correct.
  const abrainCommit = await gitCommitAll(
    abrainHome,
    `migrate(in): ${projectId} (${movedCount} knowledge + ${workflowCount} workflow entries from ${parentBasename})`,
  );
  const parentCommitSha = parentCommit.sha;
  const abrainCommitSha = abrainCommit.sha;
  const commitErrors = [
    ...(parentCommit.error ? [`parent git commit failed: ${parentCommit.error}`] : []),
    ...(abrainCommit.error ? [`abrain git commit failed: ${abrainCommit.error}`] : []),
  ];

  return {
    ok: failedCount === 0 && commitErrors.length === 0,
    projectId,
    projectIdSource: pre.projectIdSource,
    parentRepoRoot,
    abrainProjectDir: projectAbrainDir,
    entries,
    movedCount,
    workflowCount,
    skippedCount,
    seedPrunedCount,
    failedCount,
    untrackedSourceCount,
    parentCommitSha,
    abrainCommitSha,
    commitErrors,
    parentPreSha: pre.parentPreSha ?? null,
    parentRepoWasClean: pre.parentRepoWasClean,
    abrainPreSha: pre.abrainPreSha ?? null,
    graphRebuilt,
    markdownIndexRebuilt,
    preconditionFailures: [],
  };
}

/* ── Pretty-print summary for /memory migrate --go output ──────────── */

export function formatMigrationGoSummary(result: MigrationGoResult, cwd: string = process.cwd()): string {
  const lines: string[] = [];
  if (!result.ok && result.preconditionFailures.length > 0 && result.entries.length === 0) {
    lines.push(`Migration aborted: ${result.preconditionFailures.length} precondition(s) failed.`);
    for (const f of result.preconditionFailures) lines.push(`  - ${f}`);
    return lines.join("\n");
  }
  const partial = result.failedCount > 0 || !result.ok;
  lines.push(
    `${partial ? "Migration partially completed" : "Migration complete"}: projectId=${result.projectId} (${result.projectIdSource})`,
    `  moved (knowledge): ${result.movedCount}`,
    `  routed (workflow): ${result.workflowCount}`,
    ...(result.seedPrunedCount > 0 ? [`  pruned (legacy seed): ${result.seedPrunedCount}`] : []),
    ...(result.untrackedSourceCount > 0 ? [`  untracked/ignored sources migrated: ${result.untrackedSourceCount}`] : []),
    `  skipped: ${result.skippedCount}`,
    `  failed: ${result.failedCount}`,
    `  parent commit: ${result.parentCommitSha ?? "(none — no changes staged)"}`,
    `  abrain commit: ${result.abrainCommitSha ?? "(none — no changes staged)"}`,
  );
  if (partial) {
    lines.push(`  ⚠️  partial migration: failed entries remain in .pensieve for retry. Re-run /memory migrate --go after fixing the failures.`);
  }
  if (result.commitErrors?.length) {
    lines.push("", "Git commit errors:");
    for (const err of result.commitErrors) lines.push(`  - ${err}`);
  }
  if (result.failedCount > 0) {
    lines.push("", "Failures:");
    for (const entry of result.entries.filter((e) => e.action === "failed").slice(0, 10)) {
      lines.push(`  - ${entry.source} → ${entry.target}: ${entry.reason}`);
    }
    if (result.failedCount > 10) lines.push(`  ... ${result.failedCount - 10} more failure(s) omitted`);
  }
  lines.push(
  );

  if (result.graphRebuilt) {
    lines.push(
      `  graph index rebuilt: ${result.graphRebuilt.nodeCount} node(s), ${result.graphRebuilt.edgeCount} edge(s)`,
    );
  }
  if (result.markdownIndexRebuilt) {
    lines.push(
      `  markdown index rebuilt: ${result.markdownIndexRebuilt.entryCount} entry(s), ${result.markdownIndexRebuilt.kindCount} kind group(s)`,
    );
  }
  if (!result.graphRebuilt && !result.markdownIndexRebuilt && result.movedCount > 0) {
    lines.push(`  ⚠️  index rebuild failed; run \`/memory rebuild --graph\` + \`/memory rebuild --index\` on ${result.abrainProjectDir}`);
  }

  // Rollback hint: abrain side is still required clean, so pre-migration SHA
  // reset is safe there. Parent side is different after B5: dirty/untracked
  // source repos are allowed, so a blanket `git reset --hard <parentPreSha>`
  // would destroy unrelated work. Only print it when parent was clean.
  lines.push("", `Rollback (if needed):`);
  const hasUntrackedSources = result.untrackedSourceCount > 0;
  if (result.parentPreSha && result.parentRepoWasClean !== false && !hasUntrackedSources) {
    lines.push(`  cd ${prettyPath(result.parentRepoRoot, cwd)} && git reset --hard ${result.parentPreSha}`);
  } else if (result.parentCommitSha) {
    lines.push(
      `  # Parent repo was dirty or ignored/untracked sources were migrated; do NOT reset --hard unless unrelated work is saved.`,
      `  # If migrated .pensieve entries had uncommitted or ignored/untracked content, abrain is the only full copy; copy them back before resetting abrain.`,
      `  cd ${prettyPath(result.parentRepoRoot, cwd)} && git revert -n ${result.parentCommitSha}  # optional; review before commit`,
    );
  } else {
    lines.push(
      `  # Parent source repo had no migration commit to undo (likely ignored/untracked-only .pensieve entries).`,
      `  # If you need the legacy files back, recover them from the abrain migrated copies before resetting abrain.`,
    );
  }
  if (result.abrainPreSha) {
    lines.push(`  cd ~/.abrain && git reset --hard ${result.abrainPreSha}`);
  } else {
    lines.push(`  cd ~/.abrain && git reset --hard HEAD~1  # ⚠️  pre-migration SHA not captured`);
  }
  lines.push(
    `  # Note: abrain may have multiple commits from this migration (N workflows + 1 migrate-in).`,
    `  # The abrain reset above targets the SHA captured before *any* of them landed.`,
  );
  return lines.join("\n");
}
