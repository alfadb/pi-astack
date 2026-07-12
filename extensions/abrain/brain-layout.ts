/**
 * abrain — brain directory layout bootstrap.
 *
 * Ensures the abrain directory structure exists under ~/.abrain/.
 * Per brain-redesign-spec.md §1, ADR 0014 §D1, and ADR 0023-R5:
 *
 *   ~/.abrain/
 *   ├── identity/     # Lane G: about-me declarations
 *   ├── skills/       # Lane G: skill definitions
 *   ├── habits/       # Lane G: habit/preference tracking
 *   ├── workflows/    # workflow lane (B1, 2026-05-12): writeAbrainWorkflow
 *   ├── projects/     # Lane C target: per-project memory (B4 /memory migrate --go)
 *   ├── knowledge/    # Lane A: cross-project world knowledge
 *   ├── vault/        # Lane V: encrypted secrets (created by /vault init)
 *   └── rules/        # ADR 0023-R5 read-path: session-start injected rules
 *
 * Idempotent: safe to call on every boot; only creates missing dirs.
 * Creates with mode 0o700 (owner-only, consistent with vault security posture).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeAbrainStateGitignoreNext } from "../_shared/runtime";

/**
 * All top-level zone directory names. Ordered for readability in ls output.
 */
const BRAIN_ZONES = [
  "identity",
  "skills",
  "habits",
  "workflows",
  "projects",
  "knowledge",
  "vault",
  "rules",
] as const;

/** Per-zone metadata: which lane owns it, whether it holds markdown entries.
 *
 *  Note: workflows is its own lane (writer = `writeAbrainWorkflow`, audit
 *  row carries `lane: "workflow"`). It used to be grouped under Lane G
 *  (about-me) in early ADR 0014 drafts, but B1 (2026-05-12) shipped it as
 *  an independent lane with its own lock + audit + commit path. ZONE_META
 *  is documentation-only; it is currently unused by any handler
 *  (`/sediment status` was envisioned as a consumer but never wired up).
 *  The writer enum (`lane: "workflow"` etc.) is the source of truth. */
const ZONE_META: Record<string, { lane: string; description: string }> = {
  identity:  { lane: "G (about-me)",        description: "user identity declarations, /about-me output" },
  skills:    { lane: "G (about-me)",        description: "skill definitions and proficiency" },
  habits:    { lane: "G (about-me)",        description: "habit tracking and preferences" },
  workflows: { lane: "workflow (auto+user)", description: "workflow / pipeline definitions; written by writeAbrainWorkflow (B1)" },
  projects:  { lane: "C (curator)",         description: "per-project memory (migration target from .pensieve/, see B4 /memory migrate --go)" },
  knowledge: { lane: "A (agent)",           description: "cross-project world knowledge" },
  vault:     { lane: "V (vault)",           description: "age-encrypted secrets (managed by /vault init)" },
  rules:     { lane: "rules (read-path)",   description: "session-start injected behavioral rules (ADR 0023-R5 read-only path)" },
};

export type LegacyAdr0039HookCleanupStatus =
  | "already_completed"
  | "removed"
  | "missing"
  | "preserved_symlink"
  | "preserved_non_regular"
  | "preserved_non_exact"
  | "failed";

export interface LegacyAdr0039HookCleanupResult {
  ok: boolean;
  removed: boolean;
  status: LegacyAdr0039HookCleanupStatus;
  legacyBodySha256: string;
  warning?: string;
}

const LEGACY_ADR0039_PRE_PUSH_HOOK_MARKER = "# pi-astack ADR0039 pre-push hook v1";

function shSingleQuoteLegacyHookPath(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return "'<path contains control characters; edit the hook manually>'";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Reconstruct the sole published ADR0039 pre-push body template.
 *
 * Git history f97ff9c..c992ef6 published one template; c992ef6^ and c992ef6
 * are byte-identical at this function. The two absolute paths were bound by
 * the installer, so relocation intentionally makes the candidate non-exact.
 */
export function legacyAdr0039PrePushHookBytes(abrainHomeInput: string, repoRootInput: string): Buffer {
  const abrainHome = path.resolve(abrainHomeInput);
  const scriptPath = path.join(path.resolve(repoRootInput), "scripts", "pre-push-adr0039-reconcile.mjs");
  return Buffer.from([
    "#!/bin/sh",
    LEGACY_ADR0039_PRE_PUSH_HOOK_MARKER,
    "command -v node >/dev/null 2>&1 || exit 0",
    `SCRIPT=${shSingleQuoteLegacyHookPath(scriptPath)}`,
    `ABRAIN_HOME=${shSingleQuoteLegacyHookPath(abrainHome)}`,
    "if [ ! -f \"$SCRIPT\" ]; then",
    "  echo \"WARN - pi-astack ADR0039 pre-push hook script missing; allowing push (runtime pushAsync gate remains primary).\" >&2",
    "  exit 0",
    "fi",
    "exec node \"$SCRIPT\" --abrain \"$ABRAIN_HOME\"",
    "",
  ].join("\n"), "utf8");
}

const LEGACY_HOOK_CLEANUP_MIGRATION = "adr0039-pre-push-v1-removal";

interface LegacyHookRemovalEvidence {
  actualBodySha256: string;
  actualSize: number;
  expectedSize: number;
  actualMode: string;
  actualDev: string;
  actualIno: string;
  openedFdFstatVerified: true;
  finalPathLstatVerified: true;
}

function appendLegacyHookCleanupAudit(
  abrainHome: string,
  result: string,
  reason: string,
  legacyBodySha256: string,
  machineEvidence?: LegacyHookRemovalEvidence,
): void {
  try {
    const stateDir = path.join(abrainHome, ".state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, "legacy-hook-cleanup.jsonl"), `${JSON.stringify({
      ts: new Date().toISOString(),
      op: "legacy_hook_cleanup",
      migration: LEGACY_HOOK_CLEANUP_MIGRATION,
      result,
      reason,
      legacyBodySha256,
      ...(machineEvidence ?? {}),
    })}\n`, "utf8");
  } catch {
    // Migration diagnostics are best-effort and never gate local startup.
  }
}

function markLegacyHookCleanupCompleted(markerPath: string, result: string, legacyBodySha256: string): void {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      migration: LEGACY_HOOK_CLEANUP_MIGRATION,
      completedAt: new Date().toISOString(),
      result,
      legacyBodySha256,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    // A missing marker can only cause a later idempotent retry.
  }
}

function structuralGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  env.LANG = "C";
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function structuralGitPath(abrainHome: string, arg: "--show-toplevel" | "--absolute-git-dir"): string {
  const raw = execFileSync("git", ["-C", abrainHome, "rev-parse", arg], {
    encoding: "utf8",
    env: structuralGitEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3_000,
  }).replace(/\r?\n$/, "");
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) throw new Error(`invalid ${arg}`);
  return raw;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

/**
 * Remove only the exact pre-4c49584 pi-owned hook from the historical default
 * `<absolute-git-dir>/hooks/pre-push` location. The retired installer skipped
 * installation when core.hooksPath was set, so active hook configuration is
 * deliberately irrelevant to this one-way migration.
 */
export function cleanupLegacyAdr0039PrePushHook(
  abrainHomeInput: string,
  options: { repoRoot?: string; beforeFinalLstatForTest?: () => void } = {},
): LegacyAdr0039HookCleanupResult {
  const abrainHome = path.resolve(abrainHomeInput);
  const repoRoot = path.resolve(options.repoRoot ?? process.env.PI_ASTACK_REPO_ROOT ?? path.resolve(__dirname, "..", ".."));
  const expected = legacyAdr0039PrePushHookBytes(abrainHome, repoRoot);
  const legacyBodySha256 = createHash("sha256").update(expected).digest("hex");
  const completionMarker = path.join(abrainHome, ".state", "migrations", `${LEGACY_HOOK_CLEANUP_MIGRATION}.json`);
  try {
    if (fs.lstatSync(completionMarker).isFile()) {
      return { ok: true, removed: false, status: "already_completed", legacyBodySha256 };
    }
  } catch {
    // Absent/unreadable local marker falls through to the fail-soft attempt.
  }
  const finish = (
    status: LegacyAdr0039HookCleanupStatus,
    reason: string,
    warning?: string,
    machineEvidence?: LegacyHookRemovalEvidence,
  ): LegacyAdr0039HookCleanupResult => {
    appendLegacyHookCleanupAudit(abrainHome, status, reason, legacyBodySha256, machineEvidence);
    if (status !== "failed" && status !== "already_completed") {
      markLegacyHookCleanupCompleted(completionMarker, status, legacyBodySha256);
    }
    return {
      ok: status === "already_completed" || status === "removed" || status === "missing",
      removed: status === "removed",
      status,
      legacyBodySha256,
      ...(warning ? { warning } : {}),
    };
  };

  let gitDir: string;
  try {
    const canonicalAbrainHome = fs.realpathSync(abrainHome);
    const topLevelRaw = structuralGitPath(abrainHome, "--show-toplevel");
    const gitDirRaw = structuralGitPath(abrainHome, "--absolute-git-dir");
    if (!path.isAbsolute(topLevelRaw) || !path.isAbsolute(gitDirRaw)) throw new Error("Git returned a non-absolute structural path");
    if (fs.realpathSync(topLevelRaw) !== canonicalAbrainHome) throw new Error("abrain path is not the repository top-level");
    gitDir = fs.realpathSync(gitDirRaw);
    if (!fs.statSync(gitDir).isDirectory()) throw new Error("Git directory is not a directory");
  } catch {
    return finish("failed", "git_structure_invalid", "legacy ADR0039 hook cleanup could not validate the local abrain Git structure; no hook was changed");
  }

  const hooksDir = path.join(gitDir, "hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  if (path.dirname(hooksDir) !== gitDir || path.dirname(hookPath) !== hooksDir) {
    return finish("failed", "hook_path_escape", "legacy ADR0039 hook cleanup rejected a Git hook path escape; no hook was changed");
  }

  let hooksBefore: fs.BigIntStats;
  try {
    hooksBefore = fs.lstatSync(hooksDir, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return finish("missing", "historical_hooks_directory_absent");
    return finish("failed", "hooks_parent_lstat_failed", "legacy ADR0039 hook cleanup could not inspect the historical hooks directory; no hook was changed");
  }
  if (hooksBefore.isSymbolicLink() || !hooksBefore.isDirectory()) {
    return finish("failed", "hooks_parent_not_plain_directory", "legacy ADR0039 hook cleanup rejected a symlink or non-directory hooks parent; no hook was changed");
  }
  try {
    if (fs.realpathSync(hooksDir) !== hooksDir) throw new Error("hooks parent escaped Git directory");
  } catch {
    return finish("failed", "hooks_parent_path_escape", "legacy ADR0039 hook cleanup rejected a hooks parent path escape; no hook was changed");
  }

  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(hookPath, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return finish("missing", "historical_default_hook_absent");
    return finish("failed", "hook_lstat_failed", "legacy ADR0039 hook cleanup could not inspect the historical default hook; no hook was changed");
  }
  if (before.isSymbolicLink()) {
    return finish("preserved_symlink", "hook_is_symlink", "legacy ADR0039 hook cleanup preserved a symlink at the historical default hook path");
  }
  if (!before.isFile()) {
    return finish("preserved_non_regular", "hook_is_not_regular_file", "legacy ADR0039 hook cleanup preserved a non-regular historical default hook");
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(hookPath, fs.constants.O_RDONLY | noFollow);
  } catch {
    return finish("failed", "hook_read_failed", "legacy ADR0039 hook cleanup could not open the historical default hook; no hook was changed");
  }

  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(opened, before)) {
      return finish("failed", "hook_changed_during_open", "legacy ADR0039 hook cleanup observed a concurrent hook change; no hook was changed");
    }
    if (opened.size !== BigInt(expected.length)) {
      return finish("preserved_non_exact", "hook_size_not_legacy_exact", "legacy ADR0039 hook cleanup preserved a custom or modified historical default hook");
    }

    const actual = fs.readFileSync(fd);
    const afterRead = fs.fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(opened, afterRead) || actual.length !== expected.length) {
      return finish("failed", "hook_changed_during_read", "legacy ADR0039 hook cleanup observed a concurrent hook change; no hook was changed");
    }
    if (!actual.equals(expected)) {
      return finish("preserved_non_exact", "hook_bytes_not_legacy_exact", "legacy ADR0039 hook cleanup preserved a custom or modified historical default hook");
    }

    const actualBodySha256 = createHash("sha256").update(actual).digest("hex");
    options.beforeFinalLstatForTest?.();

    try {
      const hooksCurrent = fs.lstatSync(hooksDir, { bigint: true });
      if (hooksCurrent.isSymbolicLink() || !hooksCurrent.isDirectory() || !sameFileIdentity(hooksCurrent, hooksBefore)) {
        return finish("failed", "hooks_parent_changed_before_unlink", "legacy ADR0039 hook cleanup observed a concurrent hooks parent change; no hook was changed");
      }
      const current = fs.lstatSync(hookPath, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !sameFileSnapshot(current, afterRead)) {
        return finish("failed", "hook_changed_before_unlink", "legacy ADR0039 hook cleanup observed a concurrent hook change; no hook was changed");
      }
      fs.unlinkSync(hookPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return finish("failed", "hook_changed_before_unlink", "legacy ADR0039 hook cleanup observed a concurrent hook change; no hook was changed");
      }
      return finish("failed", "hook_unlink_failed", "legacy ADR0039 hook cleanup could not remove the exact legacy hook; local startup continues");
    }

    return finish("removed", "exact_pi_owned_legacy_hook_removed", undefined, {
      actualBodySha256,
      actualSize: actual.length,
      expectedSize: expected.length,
      actualMode: `0o${Number(opened.mode & 0o7777n).toString(8)}`,
      actualDev: opened.dev.toString(),
      actualIno: opened.ino.toString(),
      openedFdFstatVerified: true,
      finalPathLstatVerified: true,
    });
  } catch {
    return finish("failed", "hook_read_failed", "legacy ADR0039 hook cleanup could not read the historical default hook; no hook was changed");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create or verify the abrain zone directory layout under abrainHome.
 *
 * - Idempotent: skips already-existing zones.
 * - Creates with mode 0o700 (rwx------).
 * - Returns the set of zones that were created (empty on subsequent boots).
 * - Does NOT throw for individual mkdir failures; returns them as warnings.
 *   The only hard error is when abrainHome itself cannot be resolved/created.
 *
 * Called from activate() on every boot — cheap (7 stat calls, no mkdir
 * unless first boot or zone was manually deleted).
 */
export function ensureBrainLayout(abrainHome: string): { created: string[]; warnings: string[] } {
  const resolved = path.resolve(abrainHome);
  const created: string[] = [];
  const warnings: string[] = [];

  // Ensure abrain root exists
  if (!fs.existsSync(resolved)) {
    try {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    } catch (err: any) {
      throw new Error(`cannot create abrain root ${resolved}: ${err.message}`);
    }
  }

  const rootStat = fs.statSync(resolved);
  if (!rootStat.isDirectory()) {
    throw new Error(`abrain root is not a directory: ${resolved}`);
  }

  for (const zone of BRAIN_ZONES) {
    const dir = path.join(resolved, zone);
    if (fs.existsSync(dir)) {
      // Already exists — verify it's a directory
      try {
        const s = fs.statSync(dir);
        if (!s.isDirectory()) {
          warnings.push(`${zone}: exists but is not a directory`);
        }
      } catch (err: any) {
        warnings.push(`${zone}: stat failed: ${err.message}`);
      }
      continue;
    }

    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      created.push(zone);
      if (zone === "rules") {
        fs.mkdirSync(path.join(dir, "always"), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(dir, "listed"), { recursive: true, mode: 0o700 });
      }
    } catch (err: any) {
      warnings.push(`${zone}: mkdir failed: ${err.message}`);
    }
  }

  // ADR 0023-R5 read path: rules has two read-only injection modes (ADR 0028
  // §12.3 renamed the axis away from "tier"; directory names embed the values).
  // Ensure subdirs even when a pre-existing `rules/` directory was created
  // by hand or by an older build before the mode directories existed.
  const rulesDir = path.join(resolved, "rules");
  if (fs.existsSync(rulesDir)) {
    for (const mode of ["always", "listed"] as const) {
      const modeDir = path.join(rulesDir, mode);
      try {
        if (!fs.existsSync(modeDir)) fs.mkdirSync(modeDir, { mode: 0o700 });
      } catch (err: any) {
        warnings.push(`rules/${mode}: mkdir failed: ${err.message}`);
      }
    }
  }

  return { created, warnings };
}

/**
 * Ensure `<abrainHome>/.gitignore` contains a `.state/` line.
 *
 * P1-C audit fix 2026-05-16 (round 3 gpt-5.5): previously the `.state/`
 * gitignore line was only appended when `/abrain bind` ran
 * (`_shared/runtime.ts::bindAbrainProject`). If a user had a git-inited
 * `~/.abrain` but never bound a project, Lane G `route_rejected` orphan
 * samples would land in `.state/sediment/orphan-rejects/<file>.md`
 * (containing sanitized user title/body) and `git add .` could carry
 * them to the abrain remote.
 *
 * Now invoked from abrain `activate()` (after `ensureBrainLayout`) so the
 * gitignore guard exists before any writer can fire.
 *
 * Idempotent: only writes when the line is missing.
 *
 * Returns:
 *   - { updated: false } if the line is already present. (If `abrainHome`
 *     doesn't exist yet the underlying `writeFileSync` would ENOENT —
 *     caller is expected to ensure the directory first, typically via
 *     `ensureBrainLayout()`.)
 *   - { updated: true, path } when the line was just appended.
 *
 * P2-A audit fix 2026-05-16 (round 4 opus-4-7): write is now ATOMIC
 * (tmp + rename) instead of bare writeFileSync. `.gitignore` is the
 * single guard preventing `.state/` (vault-events.jsonl, sediment
 * audit.jsonl, orphan-rejects samples) from being `git add .`ed into
 * the abrain remote. A crash mid-write previously could leave a 0-byte
 * .gitignore, invalidating the guard until next boot.
 */
export function ensureAbrainStateGitignored(abrainHome: string): { updated: boolean; path: string } {
  const resolved = path.resolve(abrainHome);
  const gitignorePath = path.join(resolved, ".gitignore");
  const raw = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
  // Single-source-of-truth: regex + line text live in _shared/runtime.ts
  // (P1-2 audit fix 2026-05-16 round 4). bindAbrainProject uses the same
  // helper via the async path; this function is the sync activate-time
  // path. Independent write impls (sync renameSync vs async
  // atomicWriteText) are necessary because activate() can't await.
  const next = computeAbrainStateGitignoreNext(raw);
  if (next === null) {
    return { updated: false, path: gitignorePath };
  }
  // Atomic write: same-partition rename is POSIX-atomic; on Windows node
  // falls back to an equivalent atomic-on-success operation.
  const tmp = `${gitignorePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, next, "utf-8");
  fs.renameSync(tmp, gitignorePath);
  return { updated: true, path: gitignorePath };
}

/**
 * Get lane and description metadata for a zone name.
 * Returns undefined for unknown zone names.
 */
// Note: `zoneMeta()` accessor was removed in Round 6 audit (gpt-5.5 P2)
// — no caller existed. Re-add it if `/sediment status` or any other
// surface starts rendering ZONE_META at runtime.
