/**
 * Shared runtime utilities for pi-astack extensions.
 *
 * - Local-timezone ISO 8601 timestamp (replaces UTC `toISOString()`)
 * - Path resolvers that route per-extension state/log files into
 *   `<projectRoot>/.pi-astack/<module>/...` rather than the legacy
 *   `<projectRoot>/.pensieve/.state/...` location.
 *
 * Boundary:
 * - `.pi-astack/<module>/`  — runtime state, audit logs, locks
 * - `.pensieve/`            — legacy read-only migration source (B5 cutover:
 *                             2026-05-13 — sediment no longer writes here;
 *                             entries migrate to ~/.abrain/projects/<id>/)
 *
 * This file deliberately has zero imports from sibling extensions.
 */
import * as fs from "node:fs";
import { execFileSync as nodeExecFileSync } from "node:child_process";
import * as path from "node:path";

/**
 * Format a Date as ISO 8601 with the LOCAL timezone offset, e.g.:
 *
 *   2026-05-08T14:08:38.295+08:00
 *
 * (Replaces `new Date().toISOString()` which always emits UTC.)
 *
 * Stable across DST transitions because the offset is computed from the
 * Date instance at the moment of formatting.
 */
export function formatLocalIsoTimestamp(d: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  const second = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  // getTimezoneOffset returns minutes WEST of UTC (positive for negative
  // offsets), so flip the sign to get the conventional "+08:00".
  const offsetMin = -d.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offsetMins = pad(Math.abs(offsetMin) % 60);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${offsetSign}${offsetHours}:${offsetMins}`;
}

/** Root for all pi-astack runtime artifacts within a given project. */
export function piAstackRoot(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack");
}

/** Per-module subdirectory under `.pi-astack/`. */
export function piAstackModuleDir(projectRoot: string, module: string): string {
  return path.join(piAstackRoot(projectRoot), module);
}

/* -------- sediment ----------------------------------------------------- */

export function sedimentDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "sediment");
}
export function sedimentAuditPath(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "audit.jsonl");
}
export function sedimentCheckpointPath(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "checkpoint.json");
}
export function sedimentLocksDir(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "locks");
}
/* -------- memory ------------------------------------------------------- */

export function memoryDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "memory");
}
export function memoryMigrationReportPath(projectRoot: string): string {
  return path.join(memoryDir(projectRoot), "migration-report.md");
}
export function memorySearchMetricsPath(projectRoot: string): string {
  return path.join(memoryDir(projectRoot), "search-metrics.jsonl");
}

/* -------- compaction-tuner -------------------------------------------- */

export function compactionTunerDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "compaction-tuner");
}
export function compactionTunerAuditPath(projectRoot: string): string {
  return path.join(compactionTunerDir(projectRoot), "audit.jsonl");
}

/* -------- model-fallback ----------------------------------------------- */

export function modelFallbackDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "model-fallback");
}
export function modelFallbackCanaryPath(projectRoot: string): string {
  return path.join(modelFallbackDir(projectRoot), "canary.log");
}
/** Legacy home-level location, used to be `~/.pi-extensions/model-fallback.log`. */
export function legacyModelFallbackCanaryPath(home: string): string {
  return path.join(home, ".pi-extensions", "model-fallback.log");
}
export function legacyRetryStreamEofPath(home: string): string {
  return path.join(home, ".pi-extensions", "retry-stream-eof.log");
}

/* -------- legacy fallback paths ---------------------------------------- *
 * Returned alongside the canonical paths so consumers can read either
 * location during the transition window. Once existing data is migrated,
 * these can be removed.                                                    */

export function legacySedimentAuditPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "sediment-events.jsonl");
}
export function legacySedimentCheckpointPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "sediment-checkpoint.json");
}
export function legacySedimentLocksDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "locks");
}
// Note: `legacyMemoryMigrationReportPath()` was removed in Round 6 audit
// (gpt-5.5 P2) — no caller existed. The path it used to compute
// (`<projectRoot>/.pensieve/.state/migration-report.md`) belonged to an
// earlier per-file migration substrate that B3+B7 (commit `b33f0e4`)
// already stripped. Re-add only if a future per-file workflow re-emerges.

/* -------- abrain project identity ------------------------------------- *
 * ADR 0017 strict binding: callers must resolve project identity from the
 * three explicit binding artifacts. Shell cwd/git remote alone never grants
 * project-scoped write/vault privileges. */

// ADR 0017 / B4.5 Project Binding Strict Mode ----------------------
//
// project id is the only durable identity. cwd and git remote are merely
// local locator signals and MUST NOT grant project-scoped write/vault
// privileges by themselves. A project is considered bound only when all
// three artifacts agree:
//   1. <project>/.abrain-project.json              (portable identity claim)
//   2. ~/.abrain/projects/<id>/_project.json       (abrain tracked registry)
//   3. ~/.abrain/.state/projects/local-map.json    (local path authorization)

export interface AbrainProjectManifest {
  schema_version: 1;
  project_id: string;
}

export interface AbrainProjectRegistry {
  schema_version: 1;
  project_id: string;
  created_at: string;
  updated_at: string;
}

export interface AbrainLocalProjectPath {
  path: string;
  first_seen: string;
  last_seen: string;
  confirmed_at: string;
}

export interface AbrainLocalProjectMap {
  schema_version: 1;
  projects: Record<string, { paths: AbrainLocalProjectPath[] }>;
}

export type ActiveProjectMatchKind = "strict_local_map";

export interface ActiveProjectResolution {
  projectId: string;
  matchedBy: ActiveProjectMatchKind;
  cwd: string;
  lookupCwd: string;
  projectRoot: string;
  manifestPath: string;
  registryPath: string;
  localMapPath: string;
  localPath: AbrainLocalProjectPath;
  manifest: AbrainProjectManifest;
  registry: AbrainProjectRegistry;
  gitRoot?: string;
}

export type ProjectBindingStatus =
  | "manifest_missing"
  | "manifest_invalid"
  | "registry_missing"
  | "registry_mismatch"
  | "path_unconfirmed"
  | "path_conflict"
  | "invalid_cwd";

export type ResolveActiveProjectResult =
  | { activeProject: ActiveProjectResolution; reason?: undefined }
  | {
      activeProject: null;
      reason: ProjectBindingStatus;
      cwd: string;
      projectRoot?: string;
      projectId?: string;
      manifestPath?: string;
      registryPath?: string;
      localMapPath?: string;
      gitRoot?: string;
      detail?: string;
    };

export interface ResolveActiveProjectOptions {
  abrainHome: string;
  existsSync?: (file: string) => boolean;
  readFileSync?: (file: string, encoding: BufferEncoding) => string;
  execFileSync?: (file: string, args: string[], options: { cwd?: string; encoding: BufferEncoding; stdio?: Array<"ignore" | "pipe">; timeout?: number }) => string;
}

export interface BrainPaths {
  abrainHome: string;
  projectsDir: string;
  projectDir: string;
  projectVaultDir: string;
  manifestPath?: string;
  registryPath: string;
  localMapPath: string;
}

export function abrainProjectsDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), "projects");
}

export const ABRAIN_PROJECT_MANIFEST = ".abrain-project.json";
export const ABRAIN_PROJECT_REGISTRY = "_project.json";

export function abrainProjectManifestPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ABRAIN_PROJECT_MANIFEST);
}

export function abrainProjectRegistryPath(abrainHome: string, projectId: string): string {
  return path.join(abrainProjectDir(abrainHome, projectId), ABRAIN_PROJECT_REGISTRY);
}

export function abrainProjectLocalMapPath(abrainHome: string): string {
  return path.join(abrainStateDir(abrainHome), "projects", "local-map.json");
}

export function abrainProjectDir(abrainHome: string, projectId: string): string {
  validateAbrainProjectId(projectId);
  return path.join(abrainProjectsDir(abrainHome), projectId);
}
export function abrainProjectVaultDir(abrainHome: string, projectId: string): string {
  return path.join(abrainProjectDir(abrainHome, projectId), "vault");
}

// ── abrain workflows zone (B1: pipeline-shaped entries归宿) ──────
// Top-level workflows/ holds cross-project workflows (e.g. run-when-reviewing-code);
// projects/<id>/workflows/ holds project-specific ones (e.g. run-when-updating-claude-plugins).
export function abrainWorkflowsDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), "workflows");
}
export function abrainKnowledgeDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), "knowledge");
}
export function abrainProjectWorkflowsDir(abrainHome: string, projectId: string): string {
  return path.join(abrainProjectDir(abrainHome, projectId), "workflows");
}

// ── Lane G zones (ADR 0021): identity / skills / habits ───────────────────────────
// Three top-level zones under ~/.abrain/ that hold about-me declarations
// routed by sediment from `MEMORY-ABOUT-ME:` fences / `/about-me` slash.
// All three sit directly under abrainHome (not under projects/), because
// Lane G writes are *about alfadb*, cross-project.
//   - identity/   — stable self-description (values / cognitive profile)
//   - skills/     — technical / meta-capability inventory
//   - habits/     — observed recurring behavioral patterns
// Slug uniqueness is enforced ACROSS the three zones (identity+skills+
// habits) by writeAbrainAboutMe's dedupe scan; staging entries are NOT
// in the slug-collision space because they're date+pid+epoch-keyed,
// not slug-keyed. See ADR 0021 invariant #1.
export function abrainIdentityDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), "identity");
}
export function abrainSkillsDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), "skills");
}
export function abrainHabitsDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), "habits");
}
/**
 * Resolve the Lane G writer target directory by region.
 * Throws on unknown region — caller MUST validate the region via
 * validateRouteDecision (ADR 0014 §3.5) before invoking the writer.
 */
export function abrainAboutMeDirByRegion(
  abrainHome: string,
  region: "identity" | "skills" | "habits",
): string {
  switch (region) {
    case "identity": return abrainIdentityDir(abrainHome);
    case "skills": return abrainSkillsDir(abrainHome);
    case "habits": return abrainHabitsDir(abrainHome);
    default: {
      const r: never = region;
      throw new Error(`abrainAboutMeDirByRegion: unknown region ${String(r)}`);
    }
  }
}

// ── abrain-side sediment bookkeeping ──────────────────────────────
// Mirrors project-side `.pi-astack/sediment/{audit.jsonl, locks/}` layout under
// `<abrainHome>/.state/sediment/` so abrain workflow writer can reuse the same
// substrate pattern (lock + atomic write + audit) without colliding with the
// project-side audit stream. `.state/` namespace is already used by vault
// (vault-events.jsonl); sediment lives alongside as a sibling subdir.
export function abrainStateDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state");
}
export function abrainSedimentDir(abrainHome: string): string {
  return path.join(abrainStateDir(abrainHome), "sediment");
}
export function abrainSedimentAuditPath(abrainHome: string): string {
  return path.join(abrainSedimentDir(abrainHome), "audit.jsonl");
}
/** ADR 0025 P0: sidecar staging directory for provisional classifier
 *  hypotheses with attribution_pending=true. Lives alongside checkpoint
 *  under `<abrainHome>/.state/sediment/`. */
export function abrainSedimentStagingPath(abrainHome: string): string {
  return path.join(abrainSedimentDir(abrainHome), "staging");
}
export function abrainSedimentLocksDir(abrainHome: string): string {
  return path.join(abrainSedimentDir(abrainHome), "locks");
}
/**
 * List every project id that has a directory under ~/.abrain/projects/.
 * Skips entries that fail validateAbrainProjectId (defense against
 * traversal / leading-dot files / files mistakenly placed in projects/).
 * Read-only: does not create or migrate anything.
 */
export function listAbrainProjects(abrainHome: string): string[] {
  const root = abrainProjectsDir(abrainHome);
  if (!fs.existsSync(root)) return [];
  const ids: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    try { validateAbrainProjectId(id); } catch { continue; }
    ids.push(id);
  }
  ids.sort();
  return ids;
}

export function resolveBrainPaths(abrainHome: string, projectId: string): BrainPaths {
  const root = path.resolve(abrainHome);
  return {
    abrainHome: root,
    projectsDir: abrainProjectsDir(root),
    projectDir: abrainProjectDir(root, projectId),
    projectVaultDir: abrainProjectVaultDir(root, projectId),
    registryPath: abrainProjectRegistryPath(root, projectId),
    localMapPath: abrainProjectLocalMapPath(root),
  };
}

export function validateAbrainProjectId(projectId: string): void {
  if (!projectId) throw new Error("project id cannot be empty");
  if (projectId.length > 128) throw new Error(`project id too long (${projectId.length} > 128)`);
  if (projectId.startsWith(".")) throw new Error(`project id cannot start with '.': ${projectId}`);
  if (projectId.includes("/") || projectId.includes("\\")) throw new Error(`project id cannot contain path separators: ${projectId}`);
  if (projectId.includes("..")) throw new Error(`project id cannot contain '..': ${projectId}`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(projectId)) throw new Error(`project id must match [a-zA-Z0-9_.-]+: ${projectId}`);
}

function parseJsonFile<T>(raw: string, label: string): T {
  try { return JSON.parse(raw) as T; }
  catch (e: any) { throw new Error(`${label} is not valid JSON: ${e?.message ?? String(e)}`); }
}

export function normalizeProjectRoot(cwd: string, opts: ResolveActiveProjectOptions): { cwd: string; projectRoot: string; gitRoot?: string } {
  const normalizedCwd = path.resolve(cwd);
  const gitRoot = findGitRoot(normalizedCwd, opts);
  return { cwd: normalizedCwd, projectRoot: gitRoot ?? normalizedCwd, gitRoot };
}

export function parseAbrainProjectManifest(raw: string): AbrainProjectManifest {
  const parsed = parseJsonFile<Partial<AbrainProjectManifest>>(raw, ABRAIN_PROJECT_MANIFEST);
  if (parsed.schema_version !== 1) throw new Error(`unsupported ${ABRAIN_PROJECT_MANIFEST} schema_version: ${String(parsed.schema_version)}`);
  const projectId = String(parsed.project_id ?? "").trim();
  validateAbrainProjectId(projectId);
  return { schema_version: 1, project_id: projectId };
}

export function parseAbrainProjectRegistry(raw: string): AbrainProjectRegistry {
  const parsed = parseJsonFile<Partial<AbrainProjectRegistry>>(raw, ABRAIN_PROJECT_REGISTRY);
  if (parsed.schema_version !== 1) throw new Error(`unsupported ${ABRAIN_PROJECT_REGISTRY} schema_version: ${String(parsed.schema_version)}`);
  const projectId = String(parsed.project_id ?? "").trim();
  validateAbrainProjectId(projectId);
  const createdAt = typeof parsed.created_at === "string" && parsed.created_at.trim() ? parsed.created_at : formatLocalIsoTimestamp();
  const updatedAt = typeof parsed.updated_at === "string" && parsed.updated_at.trim() ? parsed.updated_at : createdAt;
  return { schema_version: 1, project_id: projectId, created_at: createdAt, updated_at: updatedAt };
}

export function emptyAbrainLocalProjectMap(): AbrainLocalProjectMap {
  return { schema_version: 1, projects: {} };
}

export function parseAbrainLocalProjectMap(raw: string): AbrainLocalProjectMap {
  const parsed = parseJsonFile<Partial<AbrainLocalProjectMap>>(raw, "local-map.json");
  if (parsed.schema_version !== 1) throw new Error(`unsupported local-map.json schema_version: ${String(parsed.schema_version)}`);
  const projectsRaw = parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {};
  const projects: AbrainLocalProjectMap["projects"] = {};
  for (const [projectId, value] of Object.entries(projectsRaw)) {
    try { validateAbrainProjectId(projectId); } catch { continue; }
    const pathsRaw = (value as any)?.paths;
    if (!Array.isArray(pathsRaw)) { projects[projectId] = { paths: [] }; continue; }
    const paths: AbrainLocalProjectPath[] = [];
    for (const p of pathsRaw) {
      if (!p || typeof p !== "object") continue;
      const pathValue = typeof (p as any).path === "string" ? path.resolve((p as any).path) : "";
      if (!pathValue) continue;
      const now = formatLocalIsoTimestamp();
      paths.push({
        path: pathValue,
        first_seen: typeof (p as any).first_seen === "string" ? (p as any).first_seen : now,
        last_seen: typeof (p as any).last_seen === "string" ? (p as any).last_seen : now,
        confirmed_at: typeof (p as any).confirmed_at === "string" ? (p as any).confirmed_at : now,
      });
    }
    projects[projectId] = { paths };
  }
  return { schema_version: 1, projects };
}

async function atomicWriteText(file: string, content: string): Promise<void> {
  const fsPromises = await import("node:fs/promises");
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  try {
    await fsPromises.writeFile(tmp, content, "utf-8");
    await fsPromises.rename(tmp, file);
  } finally {
    await fsPromises.unlink(tmp).catch(() => {});
  }
}

// ── .state/ gitignore shared logic ────────────────────────────────────
//
// P1-2 audit fix 2026-05-16 (round 4 opus-4-7 + deepseek-v4-pro):
// two earlier rounds had .state/ gitignore inserted in two places:
//   (a) bindAbrainProject (this file, async, atomicWriteText)
//   (b) ensureAbrainStateGitignored (abrain/brain-layout.ts, sync,
//       fs.writeFileSync + renameSync)
// Both used the same regex but as independent literals — a regex tweak
// in one would silently diverge from the other. The constants below are
// the single source of truth; both call sites now compose them.
export const ABRAIN_STATE_GITIGNORE_LINE = ".state/\n";
export const ABRAIN_STATE_GITIGNORE_REGEX: RegExp = /(^|\n)\.state\/?(\n|$)/;

/** Returns the gitignore content with `.state/` ensured, or null if no
 *  change is needed (line already present). Pure: no I/O. */
export function computeAbrainStateGitignoreNext(raw: string): string | null {
  if (ABRAIN_STATE_GITIGNORE_REGEX.test(raw)) return null;
  return `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}${ABRAIN_STATE_GITIGNORE_LINE}`;
}

export interface FileLockOptions {
  timeoutMs: number;
  staleMs: number;
  retryMs?: number;
  label?: string;
}

export interface FileLockHandle {
  lockPath: string;
  token: string;
  release(): Promise<void>;
}

interface FileLockRecord {
  pid?: number;
  token?: string;
  created_at?: string;
  label?: string;
}

function makeFileLockToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function parseFileLockRecord(raw: string): FileLockRecord {
  try {
    const parsed = JSON.parse(raw) as FileLockRecord;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function pidAppearsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means a process exists but this user cannot signal it.
    return err?.code === "EPERM";
  }
}

async function releaseFileLockIfOwner(lockPath: string, token: string): Promise<void> {
  const fsPromises = await import("node:fs/promises");
  try {
    const raw = await fsPromises.readFile(lockPath, "utf-8");
    const record = parseFileLockRecord(raw);
    if (record.token !== token) return;
    await fsPromises.unlink(lockPath).catch(() => {});
  } catch {}
}

async function tryStealStaleFileLock(lockPath: string, staleMs: number): Promise<boolean> {
  const fsPromises = await import("node:fs/promises");
  let raw: string;
  let statMtimeMs: number;
  try {
    const stat = await fsPromises.stat(lockPath);
    statMtimeMs = stat.mtimeMs;
    if (Date.now() - statMtimeMs <= staleMs) return false;
    raw = await fsPromises.readFile(lockPath, "utf-8");
  } catch {
    return false;
  }

  const record = parseFileLockRecord(raw);
  if (pidAppearsAlive(record.pid)) return false;

  // Owner-token guard: re-read immediately before unlink so a stale-lock
  // stealer never deletes a fresh lock that appeared between stat/read and
  // unlink. Legacy token-less locks fall back to exact raw-content match.
  try {
    const currentRaw = await fsPromises.readFile(lockPath, "utf-8");
    const current = parseFileLockRecord(currentRaw);
    if (record.token) {
      if (current.token !== record.token) return false;
    } else if (currentRaw !== raw) {
      return false;
    }
    const currentStat = await fsPromises.stat(lockPath);
    if (Date.now() - currentStat.mtimeMs <= staleMs) return false;
    await fsPromises.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

export async function acquireFileLock(lockPath: string, opts: FileLockOptions): Promise<FileLockHandle> {
  const fsPromises = await import("node:fs/promises");
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  const token = makeFileLockToken();
  const retryMs = opts.retryMs ?? 50;
  const start = Date.now();
  while (true) {
    try {
      const handle = await fsPromises.open(lockPath, "wx");
      let acquired = false;
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          token,
          created_at: formatLocalIsoTimestamp(),
          label: opts.label,
        }) + "\n", "utf-8");
        await handle.close();
        acquired = true;
      } finally {
        if (!acquired) {
          await handle.close().catch(() => {});
          // We just created this path via O_EXCL and have not returned an
          // acquired handle to callers yet, so no successor can legitimately
          // own this lock. Unlink directly instead of token-matching: write
          // failures can leave an empty/partial JSON record with no token,
          // and close failures can leave a live-pid token that nobody can
          // release.
          await fsPromises.unlink(lockPath).catch(() => {});
        }
      }
      return {
        lockPath,
        token,
        release: () => releaseFileLockIfOwner(lockPath, token),
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      await tryStealStaleFileLock(lockPath, opts.staleMs);
      if (Date.now() - start > opts.timeoutMs) throw new Error(`${opts.label ?? "file"} lock timeout after ${opts.timeoutMs}ms: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

export async function withFileLock<T>(lockPath: string, opts: FileLockOptions, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireFileLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

async function withAbrainProjectStateLock<T>(abrainHome: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(abrainStateDir(abrainHome), "projects", "local-map.lock");
  return withFileLock(lockPath, { timeoutMs: 5000, staleMs: 30_000, retryMs: 50, label: "local_map" }, fn);
}

export interface BindAbrainProjectResult {
  projectId: string;
  projectRoot: string;
  manifestPath: string;
  registryPath: string;
  localMapPath: string;
  abrainGitignorePath: string;
  manifestCreated: boolean;
  registryCreated: boolean;
  localPathAdded: boolean;
  abrainGitignoreUpdated: boolean;
}

export async function bindAbrainProject(opts: {
  abrainHome: string;
  cwd: string;
  projectId?: string;
  now?: string;
  existsSync?: (file: string) => boolean;
  readFileSync?: (file: string, encoding: BufferEncoding) => string;
  execFileSync?: ResolveActiveProjectOptions["execFileSync"];
}): Promise<BindAbrainProjectResult> {
  const now = opts.now ?? formatLocalIsoTimestamp();
  const exists = opts.existsSync ?? fs.existsSync;
  const read = opts.readFileSync ?? fs.readFileSync;
  const rootInfo = normalizeProjectRoot(opts.cwd, { abrainHome: opts.abrainHome, execFileSync: opts.execFileSync });
  const projectRoot = rootInfo.projectRoot;
  const manifestPath = abrainProjectManifestPath(projectRoot);

  let projectId = opts.projectId?.trim();
  let manifestCreated = false;
  let manifestToWrite: AbrainProjectManifest | null = null;
  if (projectId) validateAbrainProjectId(projectId);
  if (exists(manifestPath)) {
    const manifest = parseAbrainProjectManifest(read(manifestPath, "utf-8"));
    if (projectId && manifest.project_id !== projectId) {
      throw new Error(`manifest_conflict: ${ABRAIN_PROJECT_MANIFEST} already declares project_id=${manifest.project_id}; refusing to bind to ${projectId}`);
    }
    projectId = manifest.project_id;
  } else {
    if (!projectId) throw new Error(`manifest_missing: run /abrain bind --project=<id> to create ${ABRAIN_PROJECT_MANIFEST}`);
    manifestToWrite = { schema_version: 1, project_id: projectId };
    manifestCreated = true;
  }

  const registryPath = abrainProjectRegistryPath(opts.abrainHome, projectId!);
  let registryCreated = false;
  let registryToWrite: AbrainProjectRegistry;
  if (exists(registryPath)) {
    const registry = parseAbrainProjectRegistry(read(registryPath, "utf-8"));
    if (registry.project_id !== projectId) {
      throw new Error(`registry_mismatch: ${registryPath} declares project_id=${registry.project_id}; expected ${projectId}`);
    }
    registryToWrite = { ...registry, updated_at: now };
  } else {
    registryToWrite = { schema_version: 1, project_id: projectId!, created_at: now, updated_at: now };
    registryCreated = true;
  }

  return await withAbrainProjectStateLock(opts.abrainHome, async () => {
    const localMapPath = abrainProjectLocalMapPath(opts.abrainHome);
    let localMap = emptyAbrainLocalProjectMap();
    if (exists(localMapPath)) localMap = parseAbrainLocalProjectMap(read(localMapPath, "utf-8"));

    const normalizedPath = path.resolve(projectRoot);
    for (const [otherProjectId, info] of Object.entries(localMap.projects)) {
      if (otherProjectId === projectId) continue;
      if (info.paths.some((p) => path.resolve(p.path) === normalizedPath)) {
        throw new Error(`path_conflict: ${normalizedPath} is already confirmed for project ${otherProjectId}`);
      }
    }

    const entry = localMap.projects[projectId!] ?? { paths: [] };
    const existingPath = entry.paths.find((p) => path.resolve(p.path) === normalizedPath);
    let localPathAdded = false;
    if (existingPath) {
      existingPath.last_seen = now;
    } else {
      entry.paths.push({ path: normalizedPath, first_seen: now, last_seen: now, confirmed_at: now });
      localPathAdded = true;
    }
    localMap.projects[projectId!] = entry;

    // P1-2 audit fix 2026-05-16 (round 4): use the shared pure helper
    // computeAbrainStateGitignoreNext() instead of duplicating the
    // regex and append logic inline. activate()'s
    // ensureAbrainStateGitignored() composes the same helper from
    // brain-layout.ts; both paths now share one source of truth.
    const abrainGitignorePath = path.join(path.resolve(opts.abrainHome), ".gitignore");
    const gitignoreRaw = exists(abrainGitignorePath) ? read(abrainGitignorePath, "utf-8") : "";
    const gitignoreToWrite = computeAbrainStateGitignoreNext(gitignoreRaw);
    const abrainGitignoreUpdated = gitignoreToWrite !== null;

    if (gitignoreToWrite !== null) {
      await atomicWriteText(abrainGitignorePath, gitignoreToWrite);
    }
    if (manifestToWrite) {
      await atomicWriteText(manifestPath, JSON.stringify(manifestToWrite, null, 2) + "\n");
    }
    await atomicWriteText(registryPath, JSON.stringify(registryToWrite, null, 2) + "\n");
    await atomicWriteText(localMapPath, JSON.stringify(localMap, null, 2) + "\n");

    return { projectId: projectId!, projectRoot, manifestPath, registryPath, localMapPath, abrainGitignorePath, manifestCreated, registryCreated, localPathAdded, abrainGitignoreUpdated };
  });
}

function findGitRoot(cwd: string, opts: ResolveActiveProjectOptions): string | undefined {
  const exec = opts.execFileSync ?? nodeExecFileSync;
  try {
    return path.resolve(exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim());
  } catch {
    return undefined;
  }
}

export function resolveActiveProject(cwd: string, opts: ResolveActiveProjectOptions): ResolveActiveProjectResult {
  let rootInfo: { cwd: string; projectRoot: string; gitRoot?: string };
  try { rootInfo = normalizeProjectRoot(cwd, opts); }
  catch {
    return { activeProject: null, reason: "invalid_cwd", cwd };
  }

  const exists = opts.existsSync ?? fs.existsSync;
  const read = opts.readFileSync ?? fs.readFileSync;
  const manifestPath = abrainProjectManifestPath(rootInfo.projectRoot);
  if (!exists(manifestPath)) {
    return { activeProject: null, reason: "manifest_missing", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, manifestPath, gitRoot: rootInfo.gitRoot };
  }

  let manifest: AbrainProjectManifest;
  try { manifest = parseAbrainProjectManifest(read(manifestPath, "utf-8")); }
  catch (e: any) {
    return { activeProject: null, reason: "manifest_invalid", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, manifestPath, gitRoot: rootInfo.gitRoot, detail: e?.message ?? String(e) };
  }

  const projectId = manifest.project_id;
  const registryPath = abrainProjectRegistryPath(opts.abrainHome, projectId);
  const localMapPath = abrainProjectLocalMapPath(opts.abrainHome);
  if (!exists(registryPath)) {
    return { activeProject: null, reason: "registry_missing", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, projectId, manifestPath, registryPath, localMapPath, gitRoot: rootInfo.gitRoot };
  }

  let registry: AbrainProjectRegistry;
  try { registry = parseAbrainProjectRegistry(read(registryPath, "utf-8")); }
  catch (e: any) {
    return { activeProject: null, reason: "registry_mismatch", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, projectId, manifestPath, registryPath, localMapPath, gitRoot: rootInfo.gitRoot, detail: e?.message ?? String(e) };
  }
  if (registry.project_id !== projectId) {
    return { activeProject: null, reason: "registry_mismatch", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, projectId, manifestPath, registryPath, localMapPath, gitRoot: rootInfo.gitRoot, detail: `registry project_id=${registry.project_id} does not match manifest project_id=${projectId}` };
  }

  let localMap = emptyAbrainLocalProjectMap();
  if (exists(localMapPath)) {
    try { localMap = parseAbrainLocalProjectMap(read(localMapPath, "utf-8")); }
    catch (e: any) {
      return { activeProject: null, reason: "path_unconfirmed", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, projectId, manifestPath, registryPath, localMapPath, gitRoot: rootInfo.gitRoot, detail: e?.message ?? String(e) };
    }
  }

  const normalizedProjectRoot = path.resolve(rootInfo.projectRoot);
  for (const [otherProjectId, info] of Object.entries(localMap.projects)) {
    if (otherProjectId === projectId) continue;
    if (info.paths.some((p) => path.resolve(p.path) === normalizedProjectRoot)) {
      return { activeProject: null, reason: "path_conflict", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, projectId, manifestPath, registryPath, localMapPath, gitRoot: rootInfo.gitRoot, detail: `${normalizedProjectRoot} is confirmed for project ${otherProjectId}` };
    }
  }

  const localPath = localMap.projects[projectId]?.paths.find((p) => path.resolve(p.path) === normalizedProjectRoot);
  if (!localPath) {
    return { activeProject: null, reason: "path_unconfirmed", cwd: rootInfo.cwd, projectRoot: rootInfo.projectRoot, projectId, manifestPath, registryPath, localMapPath, gitRoot: rootInfo.gitRoot };
  }

  return {
    activeProject: {
      projectId,
      matchedBy: "strict_local_map",
      cwd: rootInfo.cwd,
      lookupCwd: normalizedProjectRoot,
      projectRoot: normalizedProjectRoot,
      manifestPath,
      registryPath,
      localMapPath,
      localPath,
      manifest,
      registry,
      gitRoot: rootInfo.gitRoot,
    },
  };
}

/* -------- one-shot legacy data migration ------------------------------ *
 * Moves pi-astack-owned state files from the legacy `.pensieve/.state/`
 * location to `.pi-astack/<module>/`. Idempotent and racy-safe enough for
 * single-process use: skips if the target already exists.
 *
 * Called from `appendAudit` and `loadCheckpoint` so the move happens at
 * the first runtime touch after a code upgrade, with no separate user
 * script required. A per-project flag avoids re-running per call.        */

const migrated = new Set<string>();

export async function ensureSedimentLegacyMigrated(projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  // Per-process flag avoids re-statting on every audit append. Cleared on
  // process restart, so post-restart migrations re-run once if a stray
  // legacy file showed up since last cycle.
  if (migrated.has(root)) return;
  migrated.add(root);

  const fs = await import("node:fs/promises");
  const fsSync = await import("node:fs");

  /**
   * Move legacy audit file to canonical location. If both exist (e.g.,
   * a stray write happened between two restarts of mixed code paths),
   * APPEND the legacy content to canonical and remove legacy. Care is
   * taken to produce exactly one `\n` between rows: never zero (would
   * fuse two JSONL lines) and never two+ (would inject blank rows that
   * pass `if (!line.trim()) continue` filters but waste readers' time).
   */
  async function migrateAuditFile(oldPath: string, newPath: string): Promise<void> {
    const oldExists = fsSync.existsSync(oldPath);
    if (!oldExists) return;
    const newExists = fsSync.existsSync(newPath);
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    if (!newExists) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (e: any) {
        if (e?.code === "EXDEV") {
          await fs.copyFile(oldPath, newPath);
          await fs.unlink(oldPath);
          return;
        }
        throw e;
      }
    }
    // Both exist: append legacy content to canonical, then remove legacy.
    const legacyRaw = await fs.readFile(oldPath, "utf-8");
    // Strip leading/trailing whitespace, collapse internal blank lines.
    // Each non-empty line must end with exactly one `\n` in the output.
    const lines = legacyRaw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0) {
      // Ensure canonical ends with `\n` so the appended block doesn't
      // accidentally fuse onto the previous final row. Standard JSONL
      // append-writes always close with `\n`, so this is usually a no-op.
      const newEndsWithNL = await fileEndsWithNewline(newPath);
      const prefix = newEndsWithNL ? "" : "\n";
      await fs.appendFile(newPath, prefix + lines.join("\n") + "\n", "utf-8");
    }
    await fs.unlink(oldPath);
  }

  async function fileEndsWithNewline(file: string): Promise<boolean> {
    const stat = await fs.stat(file);
    if (stat.size === 0) return true;
    const fd = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(1);
      await fd.read(buf, 0, 1, stat.size - 1);
      return buf[0] === 0x0a;
    } finally {
      await fd.close();
    }
  }

  /**
   * Move legacy checkpoint to canonical location. If both exist, prefer
   * the LATER `lastProcessedEntryId` (or canonical when ambiguous) so we
   * don't replay already-processed entries. Stale legacy gets removed.
   */
  async function migrateCheckpointFile(oldPath: string, newPath: string): Promise<void> {
    const oldExists = fsSync.existsSync(oldPath);
    if (!oldExists) return;
    const newExists = fsSync.existsSync(newPath);
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    if (!newExists) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (e: any) {
        if (e?.code === "EXDEV") {
          await fs.copyFile(oldPath, newPath);
          await fs.unlink(oldPath);
          return;
        }
        throw e;
      }
    }
    // Both exist: keep canonical (assumed authoritative under new code),
    // unlink legacy.
    await fs.unlink(oldPath);
  }

  await migrateAuditFile(legacySedimentAuditPath(root), sedimentAuditPath(root));
  await migrateCheckpointFile(legacySedimentCheckpointPath(root), sedimentCheckpointPath(root));
  // Locks are ephemeral; do not migrate.
}

/* -------- ensure .pi-astack/ is in project .gitignore ----------------- *
 * Round 9 P0 (sonnet R9-5 fix): `.pi-astack/` holds local runtime state —
 * sediment/audit.jsonl, sediment/checkpoint*.json, memory/search-metrics.
 * jsonl, model-fallback/canary.log, compaction-tuner/audit.jsonl. These
 * files contain LLM raw responses, query text, error messages — anything
 * that downstream LLM input could echo. If the user's project repo
 * doesn't have `.pi-astack/` in `.gitignore`, `git add .` accidentally
 * stages them, then `git commit && git push` exfiltrates to a public
 * remote.
 *
 * Auto-append on first touch (sediment first audit, first search
 * metrics, first migration audit). Idempotent + per-process cached.
 *
 * Only writes the entry when the projectRoot is the root of a git repo
 * (toplevel == projectRoot). For subdirectories of a parent repo or
 * non-repos, skip silently — the user can manually add the entry to
 * the parent .gitignore if they need it.                                 */

const gitignoreEnsured = new Set<string>();
const PI_ASTACK_GITIGNORE_ENTRY = ".pi-astack/";
const PI_ASTACK_GITIGNORE_HEADER = "# pi-astack runtime state (audit logs, checkpoints, search metrics)";

export async function ensureProjectGitignoredOnce(projectRoot: string): Promise<
  { added: true; gitignorePath: string } | { added: false; reason: string }
> {
  const root = path.resolve(projectRoot);
  if (gitignoreEnsured.has(root)) return { added: false, reason: "cached" };
  gitignoreEnsured.add(root);

  const fs = await import("node:fs/promises");
  const fsSync = await import("node:fs");

  // Skip if not a git repo OR projectRoot is a subdirectory (not the toplevel).
  // We only auto-add on the actual repo root — subdirs would write to
  // the wrong .gitignore (or worse, create one that overrides parent).
  const gitDir = path.join(root, ".git");
  if (!fsSync.existsSync(gitDir)) return { added: false, reason: "not_a_git_repo" };

  const gitignorePath = path.join(root, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf-8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") return { added: false, reason: `read_failed: ${e?.code ?? "?"}` };
  }
  // Strict membership check: scan trimmed lines. Match BOTH `.pi-astack/`
  // AND `.pi-astack` (without trailing slash) since both syntactically
  // ignore the directory and tree.
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === PI_ASTACK_GITIGNORE_ENTRY || l === ".pi-astack")) {
    return { added: false, reason: "already_present" };
  }

  // Append; preserve trailing newline if existing has one (don't fuse).
  const needsLeadingNL = existing.length > 0 && !existing.endsWith("\n");
  const block = `${needsLeadingNL ? "\n" : ""}${existing ? "\n" : ""}${PI_ASTACK_GITIGNORE_HEADER}\n${PI_ASTACK_GITIGNORE_ENTRY}\n`;
  try {
    await fs.appendFile(gitignorePath, block, "utf-8");
    return { added: true, gitignorePath };
  } catch (e: any) {
    // best-effort: do not block audit appends if .gitignore can't be
    // written (read-only fs, EACCES, etc). Reset cache so next call
    // can retry.
    gitignoreEnsured.delete(root);
    return { added: false, reason: `append_failed: ${e?.code ?? "?"}` };
  }
}
