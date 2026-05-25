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

  // ADR 0023-R5 read path: rules has two read-only injection tiers.
  // Ensure subdirs even when a pre-existing `rules/` directory was created
  // by hand or by an older build before tier directories existed.
  const rulesDir = path.join(resolved, "rules");
  if (fs.existsSync(rulesDir)) {
    for (const tier of ["always", "listed"] as const) {
      const tierDir = path.join(rulesDir, tier);
      try {
        if (!fs.existsSync(tierDir)) fs.mkdirSync(tierDir, { mode: 0o700 });
      } catch (err: any) {
        warnings.push(`rules/${tier}: mkdir failed: ${err.message}`);
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
