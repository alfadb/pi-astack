/**
 * staging-loader — load pending provisional staging entries for classifier
 * context injection (ADR 0025 §4.1.5).
 *
 * Staging entries live in `~/.abrain/.state/sediment/staging/` (sidecar path,
 * NOT in the memory_search corpus). The loader reads the most recent K entries
 * so the classifier can decide whether the current utterance resolves any
 * pending hypotheses.
 *
 * P1: simple recency-based selection (most recent K).
 * P1.1 upgrade: LLM-based semantic relevance matching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { StagingEntry, StagingFileOnDisk } from "./staging-types";

/**
 * Shared staging directory for ALL staging kinds (provisional-correction,
 * multiview-pending, future kinds). Exported so sibling IO modules
 * (multiview-staging-io.ts) write to the same directory as this loader
 * reads, without duplicating the path. The directory is single-device
 * local: `~/.abrain/.gitignore` line 2 (`.state/`) excludes it from
 * git-sync, so no cross-device replay race exists (see
 * multiview-staging-types.ts file header for the D2 discovery write-up).
 */
export function stagingDir(): string {
  const abrainHome = process.env.ABRAIN_ROOT
    ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
    : path.join(os.homedir(), ".abrain");
  return path.join(abrainHome, ".state", "sediment", "staging");
}

/** Back-compat export for callers that only display the default path. */
export const STAGING_DIR = stagingDir();

const MAX_STAGING_ENTRIES = 10;  // K — token budget limits
/** Age beyond which a pending hypothesis is left to the age-out / archive
 *  path. Exported so staging-resolver shares one definition (no drift). */
export const STALE_DAYS = 30;

export interface StagingContext {
  entries: StagingEntry[];
  count: number;
  /** Stale entries that should be archived (age > 30 days, unresolved) */
  staleCount: number;
}

/**
 * Load the most recent pending staging entries for classifier context.
 * Skips stale entries (> 30 days since creation, unresolved).
 */
export function loadStagingContext(): StagingContext {
  const entries: StagingEntry[] = [];
  let staleCount = 0;
  const now = Date.now();
  const staleCutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;

  try {
    const dir = stagingDir();
    if (!fs.existsSync(dir)) return { entries, count: 0, staleCount: 0 };

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()  // alphabetical = chronological (ISO timestamps in filenames)
      .reverse(); // newest first

    for (const file of files) {
      if (entries.length >= MAX_STAGING_ENTRIES) break;

      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        const parsed: StagingFileOnDisk = JSON.parse(raw);

        if (!parsed.entry || !parsed.entry.attribution_pending) continue;

        // Stage 4 (ADR 0025 §4.1.5 / §4.6.6): soft-archived hypotheses are
        // retired by the age-out reviewer. Drop them from BOTH the active
        // context AND the staleCount — they have already been handled, so
        // they must not keep inflating the staging_backlog advisory. The
        // file stays on disk (reversible), it just stops being selected.
        if (parsed.entry.lifecycle_state === "soft_archived") continue;

        const created = Date.parse(parsed.entry.created);
        if (!Number.isFinite(created)) continue;

        if (created < staleCutoff) {
          staleCount++;
          continue;
        }

        entries.push(parsed.entry);
      } catch {
        // corrupted file — skip
      }
    }
  } catch {
    // directory doesn't exist or can't be read
  }

  return { entries, count: entries.length, staleCount };
}

/**
 * Write a new staging entry to disk.
 */
export function writeStagingEntry(entry: StagingEntry): boolean {
  try {
    const dir = stagingDir();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${entry.created.replace(/[:.]/g, "-")}-${entry.slug}.json`;
    const file: StagingFileOnDisk = { schema_version: 1, entry };
    fs.writeFileSync(
      path.join(dir, filename),
      JSON.stringify(file, null, 2),
      "utf-8",
    );
    return true;
  } catch {
    // best-effort, but REPORT failure: callers that rely on staging as a
    // no-loss safety net (correction-pipeline #1 / the short-window escalation)
    // must HOLD their checkpoint when the net did not actually persist, instead
    // of advancing past an un-staged + un-promoted signal (audit P0 2026-06-07).
    return false;
  }
}

/** F11 (PR-C): remove provisional staging twins once a deterministic Tier-1
 * direct write has durably captured the same user quote. Matching by slug is
 * stable across process restarts because buildProvisionalStagingEntry and the
 * tier1 cleanup path share buildProvisionalStagingSlug(). Best-effort: failed
 * deletes are reported via counters but never roll back the brain write. */
export function removeStagingEntriesBySlug(slug: string): { removed: number; failed: number } {
  let removed = 0;
  let failed = 0;
  try {
    const dir = stagingDir();
    if (!fs.existsSync(dir)) return { removed, failed };
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(`-${slug}.json`)) continue;
      try {
        fs.unlinkSync(path.join(dir, file));
        removed++;
      } catch {
        failed++;
      }
    }
  } catch {
    failed++;
  }
  return { removed, failed };
}

/**
 * Count total staging files (for raw disk-footprint monitoring). Includes
 * soft-archived (retired-but-not-deleted) files.
 */
export function stagingFileCount(): number {
  try {
    const dir = stagingDir();
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * Count ACTIVE staging files, EXCLUDING age-out soft-archived ones (Stage 4,
 * ADR 0025 §4.1.5 / §4.6.6). Use this for the classifier-over-production
 * inflation monitor: a soft-archived hypothesis was already retired by the
 * age-out reviewer and is only awaiting the deferred mechanical hard-delete
 * (Stage 5), so it must NOT count as evidence the classifier is
 * over-producing — otherwise the advisory fires perpetually as retired files
 * accumulate.
 */
export function stagingActiveFileCount(): number {
  let count = 0;
  try {
    const dir = stagingDir();
    if (!fs.existsSync(dir)) return 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed: StagingFileOnDisk = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (parsed?.entry?.lifecycle_state === "soft_archived") continue;
      } catch {
        // Corrupt file: count it (a real file on disk; conservative).
      }
      count++;
    }
  } catch {
    return count;
  }
  return count;
}
