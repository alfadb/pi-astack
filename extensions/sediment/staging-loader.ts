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
export const STAGING_DIR = path.join(
  os.homedir(), ".abrain", ".state", "sediment", "staging",
);

const MAX_STAGING_ENTRIES = 10;  // K — token budget limits
const STALE_DAYS = 30;

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
    if (!fs.existsSync(STAGING_DIR)) return { entries, count: 0, staleCount: 0 };

    const files = fs.readdirSync(STAGING_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()  // alphabetical = chronological (ISO timestamps in filenames)
      .reverse(); // newest first

    for (const file of files) {
      if (entries.length >= MAX_STAGING_ENTRIES) break;

      try {
        const raw = fs.readFileSync(path.join(STAGING_DIR, file), "utf-8");
        const parsed: StagingFileOnDisk = JSON.parse(raw);

        if (!parsed.entry || !parsed.entry.attribution_pending) continue;

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
export function writeStagingEntry(entry: StagingEntry): void {
  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    const filename = `${entry.created.replace(/[:.]/g, "-")}-${entry.slug}.json`;
    const file: StagingFileOnDisk = { schema_version: 1, entry };
    fs.writeFileSync(
      path.join(STAGING_DIR, filename),
      JSON.stringify(file, null, 2),
      "utf-8",
    );
  } catch {
    // best-effort
  }
}

/**
 * Count total staging files (for inflation monitoring).
 */
export function stagingFileCount(): number {
  try {
    if (!fs.existsSync(STAGING_DIR)) return 0;
    return fs.readdirSync(STAGING_DIR).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
