/**
 * multiview-staging-io — read/write/delete for `multiview-pending`
 * staging entries (ADR 0025 P0.5 R-series review batch 3a-ii).
 *
 * On-disk layout:
 *   <STAGING_DIR>/<isoTs-with-colons-replaced>-<slug>.json
 *   (shared with provisional-correction staging files; see
 *    multiview-staging-types.ts file header for co-tenancy rationale)
 *
 * Cross-device race: NONE. `~/.abrain/.state/` is gitignored
 * (`.gitignore` line 2), so staging files do not propagate across
 * devices via abrain git-sync. The original design review (deepseek
 * D2.2B) flagged a "device A deletes staging mid-replay while device B
 * has stale copy → duplicate brain write" race; verifying ground truth
 * showed this race does not exist. As a result, this module does NOT
 * implement optimistic locking, git fetch checks, or retryable/
 * context-only split. See the 2026-05-24 discovery commit
 * (b08ad0d) for the full reasoning.
 *
 * Process-level concurrency: pi runs as a single process per device, so
 * multiple writers racing the same staging slug is also out of scope.
 * If a user runs two pi instances on one machine they may get duplicate
 * staging entries (each instance hashes a different timestamp into the
 * slug); replay still works because each entry is processed at most
 * once before being deleted.
 *
 * Hard limits enforced here (see multiview-staging-types.ts constants):
 *   - PROPOSER_RAW_TEXT_CAP (4000) applied to:
 *       entry.proposer_raw_text
 *       entry.pass1_verdict?.raw  (if present)
 *       entry.pass2_verdict?.raw  (if present)
 *   - validateMultiviewPendingConsistency runs before write; on
 *     non-null return, writer THROWS (not silent skip) so caller
 *     learns about the bug.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { STAGING_DIR } from "./staging-loader";
import type {
  MultiviewPendingEntry,
  MultiviewPendingFileOnDisk,
  SlugInputs,
} from "./multiview-staging-types";
import {
  MULTIVIEW_PENDING_SCHEMA_VERSION,
  PROPOSER_RAW_TEXT_CAP,
  validateMultiviewPendingConsistency,
} from "./multiview-staging-types";

// ── Slug generation ──────────────────────────────────────────────────────

/**
 * Generate `multiview-pending-{hash8}` slug from a candidate's
 * compiledTruth + ISO timestamp. The timestamp differentiator means
 * two replays of the same candidate at different moments produce
 * different slugs — protects against the pathological case where a
 * writer crashes mid-replay and leaves the old file undeleted.
 *
 * Collision probability: sha256-derived, 2^32 namespace for the first
 * 8 hex chars. With O(100) staging entries per device lifetime,
 * collision probability ~10^-7 — acceptable.
 */
export function generateMultiviewPendingSlug(inputs: SlugInputs): string {
  const hash = crypto
    .createHash("sha256")
    .update(inputs.compiledTruth)
    .update("\n")
    .update(inputs.isoTs)
    .digest("hex")
    .slice(0, 8);
  return `multiview-pending-${hash}`;
}

// ── File name encoding ───────────────────────────────────────────────────

/**
 * Build the on-disk filename for an entry. Mirrors writeStagingEntry's
 * convention (staging-loader.ts:84): ISO timestamp with colons + dots
 * replaced by dashes, joined to the slug with a `-`.
 *
 * Example: `2026-05-24T15-32-10-321Z-multiview-pending-a1b2c3d4.json`
 *
 * The transformation keeps filenames sortable by chronology (sorting
 * alphabetically equals chronologically, used by loadMultiviewPending
 * to surface oldest entries first).
 */
function buildFilename(entry: MultiviewPendingEntry): string {
  return `${entry.created.replace(/[:.]/g, "-")}-${entry.slug}.json`;
}

// ── Clip helpers ─────────────────────────────────────────────────────────

/**
 * Truncate a string to PROPOSER_RAW_TEXT_CAP, appending "…[truncated]"
 * marker when actually truncated. Returns the original input if it
 * already fits, so unchanged content avoids the marker bloat.
 */
function clipForStaging(text: string): string {
  if (text.length <= PROPOSER_RAW_TEXT_CAP) return text;
  return text.slice(0, PROPOSER_RAW_TEXT_CAP) + "…[truncated]";
}

// Per-field caps (separate from PROPOSER_RAW_TEXT_CAP so changes don't
// cascade). Tuned per deepseek 3a-ii review I2: candidate_snapshot.
// compiledTruth is the highest bloat risk (curator-side
// settings.maxEntryChars allows 30,000 chars, but replay's
// renderCandidate only needs enough context for the reviewer to judge;
// matching PROPOSER_RAW_TEXT_CAP = 4000 is sufficient).
const CANDIDATE_COMPILED_TRUTH_CAP = PROPOSER_RAW_TEXT_CAP;  // 4000
const CANDIDATE_SUMMARY_CAP = 1000;
const REVIEWER_FREEFORM_CAP = 2000;  // reasoning / rationale / quote etc.

/**
 * Apply staging-time field caps to an entry. Returns a new entry —
 * caller's reference is NOT mutated. This is DEFENSIVE: the IO layer
 * is the contract surface guaranteeing "no matter what the caller
 * passes in, disk doesn't bloat unboundedly". Callers may pre-clip
 * (and 3b SHOULD because it knows the runMultiView prompt budget),
 * but we never assume they did.
 *
 * Capped fields and their rationale:
 *   proposer_raw_text                            → 4000 (matches Pass 2 prompt cap)
 *   pass1_verdict.raw / pass2_verdict.raw        → 4000 (full reviewer output)
 *   candidate_snapshot.compiledTruth             → 4000 (P1 from review I2; main bloat risk)
 *   candidate_snapshot.summary                   → 1000
 *   candidate_snapshot.title                     → NOT capped (typically <200)
 *   pass1_verdict.reasoning / .key_evidence_quote
 *     / .strongest_objection_to_your_own_op      → 2000
 *   pass2_verdict.rationale / .anchor_bias_self_check
 *     / .devils_advocate_objection               → 2000
 *   pass2_verdict.missed_evidence_quote          → 2000
 *
 * Worst-case per-entry size after caps: ~30KB JSON
 * (3 × 4000 + 1000 + 6 × 2000 + frontmatter + serialization overhead).
 * With max ~20 entries in staging dir, total ~600KB bound — acceptable.
 */
function applyFieldCaps(entry: MultiviewPendingEntry): MultiviewPendingEntry {
  const out: MultiviewPendingEntry = {
    ...entry,
    proposer_raw_text: clipForStaging(entry.proposer_raw_text),
    candidate_snapshot: {
      ...entry.candidate_snapshot,
      compiledTruth: clipTo(entry.candidate_snapshot.compiledTruth, CANDIDATE_COMPILED_TRUTH_CAP),
      ...(entry.candidate_snapshot.summary !== undefined && {
        summary: clipTo(entry.candidate_snapshot.summary, CANDIDATE_SUMMARY_CAP),
      }),
    },
  };
  if (entry.pass1_verdict) {
    out.pass1_verdict = {
      ...entry.pass1_verdict,
      raw: clipForStaging(entry.pass1_verdict.raw),
      ...(entry.pass1_verdict.reasoning !== undefined && {
        reasoning: clipTo(entry.pass1_verdict.reasoning, REVIEWER_FREEFORM_CAP),
      }),
      ...(entry.pass1_verdict.key_evidence_quote !== undefined && {
        key_evidence_quote: clipTo(entry.pass1_verdict.key_evidence_quote, REVIEWER_FREEFORM_CAP),
      }),
      ...(entry.pass1_verdict.strongest_objection_to_your_own_op !== undefined && {
        strongest_objection_to_your_own_op: clipTo(
          entry.pass1_verdict.strongest_objection_to_your_own_op, REVIEWER_FREEFORM_CAP),
      }),
    };
  }
  if (entry.pass2_verdict) {
    out.pass2_verdict = {
      ...entry.pass2_verdict,
      raw: clipForStaging(entry.pass2_verdict.raw),
      ...(entry.pass2_verdict.rationale !== undefined && {
        rationale: clipTo(entry.pass2_verdict.rationale, REVIEWER_FREEFORM_CAP),
      }),
      ...(entry.pass2_verdict.anchor_bias_self_check !== undefined && {
        anchor_bias_self_check: clipTo(
          entry.pass2_verdict.anchor_bias_self_check, REVIEWER_FREEFORM_CAP),
      }),
      ...(entry.pass2_verdict.devils_advocate_objection !== undefined && {
        devils_advocate_objection: clipTo(
          entry.pass2_verdict.devils_advocate_objection, REVIEWER_FREEFORM_CAP),
      }),
      ...(entry.pass2_verdict.missed_evidence_quote !== undefined &&
          entry.pass2_verdict.missed_evidence_quote !== null && {
        missed_evidence_quote: clipTo(
          entry.pass2_verdict.missed_evidence_quote, REVIEWER_FREEFORM_CAP),
      }),
    };
  }
  return out;
}

/** Generic clip helper used by per-field caps. Same shape as
 *  clipForStaging but with arbitrary cap so the bigger function can
 *  use multiple thresholds. */
function clipTo(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "…[truncated]";
}

// ── Write ────────────────────────────────────────────────────────────────

/**
 * Persist a multiview-pending entry to disk. Throws on consistency
 * violation (state/verdict mismatch — see validateMultiviewPendingConsistency)
 * because that is a programmer error in the caller, not a transient
 * I/O failure to swallow.
 *
 * Filesystem errors (ENOSPC, EACCES, etc.) propagate — caller (the
 * runMultiView 3b rewrite) decides whether to log + fall through OR
 * surface the error. Unlike the metrics sidecar, staging IO is NOT
 * best-effort: if we can't write the entry, the brain write would have
 * been silently dropped, and we want loud failure for that.
 *
 * Contrast with `writeStagingEntry` (staging-loader.ts) which silently
 * swallows IO errors — that's correct for provisional-correction
 * staging (best-effort context for future classifier runs, lossy is
 * acceptable). multiview-pending is brain-write replacement, lossy
 * is NOT acceptable.
 *
 * Caller contract reminders:
 *   - All required fields per multiview-staging-types.ts D1.G must
 *     be present. The IO layer does NOT verify (deepseek 3a-ii review
 *     I1: redundant for programmatic callers); missing fields will
 *     surface at replay time as runMultiView arg validation failures.
 *   - Length caps are applied DEFENSIVELY here. Caller may pre-clip
 *     but is not required to.
 *
 * Returns the absolute path of the written file so the caller can log
 * it to audit.
 */
export function writeMultiviewPending(entry: MultiviewPendingEntry): string {
  const validationError = validateMultiviewPendingConsistency(entry);
  if (validationError) {
    throw new Error(`writeMultiviewPending: ${validationError}`);
  }

  const capped = applyFieldCaps(entry);
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const filename = buildFilename(capped);
  const absPath = path.join(STAGING_DIR, filename);
  const file: MultiviewPendingFileOnDisk = {
    schema_version: MULTIVIEW_PENDING_SCHEMA_VERSION,
    entry: capped,
  };
  fs.writeFileSync(absPath, JSON.stringify(file, null, 2), "utf-8");
  return absPath;
}

// ── Load ─────────────────────────────────────────────────────────────────

/**
 * Result of loadMultiviewPending. `entries` is sorted oldest-first
 * (chronological) so the replay routine can fairly process the longest-
 * waiting entries first. `totalFound` is the count BEFORE applying any
 * caller-side limit (3c-i replay caps at MAX_REPLAY_PER_AGENT_END);
 * useful for monitoring "are we falling behind?".
 */
export interface MultiviewPendingLoadResult {
  entries: MultiviewPendingEntry[];
  totalFound: number;
  skippedCount: number;  // corrupt files / schema mismatches / wrong kind
}

/**
 * Load ALL multiview-pending entries from disk. Single-device by
 * construction (no cross-device race; see file header). Does NOT filter
 * by staleness or retry count — that's the replay routine's job (3c-i)
 * because terminal-skip needs to write an audit row before deletion.
 *
 * Co-tenancy guard (per multiview-staging-types.ts file header, S1
 * follow-up): EVERY file in STAGING_DIR is parsed and the discriminator
 * `kind === "multiview-pending"` is checked explicitly. Files with
 * other kinds (provisional-correction, future kinds) are skipped
 * silently. Files with NO `kind` field, wrong schema_version, or
 * unparseable JSON are also skipped and counted in `skippedCount`.
 *
 * Forward-compat note (deepseek 3a-ii review I5): a future v2
 * entry on disk is skipped silently here. We emit a `console.debug`
 * line in that case so a dogfooder grepping their stderr can spot
 * the silent-skip pile-up. Audit-row-level signaling is deferred
 * to 3c-i which will report load stats per agent_end.
 *
 * Sort order: oldest first (chronological), determined by parsing
 * `entry.created` as ISO timestamp. Files with unparseable timestamps
 * are skipped.
 */
export function loadMultiviewPending(): MultiviewPendingLoadResult {
  const entries: MultiviewPendingEntry[] = [];
  let skippedCount = 0;

  if (!fs.existsSync(STAGING_DIR)) {
    return { entries, totalFound: 0, skippedCount: 0 };
  }

  let files: string[];
  try {
    files = fs.readdirSync(STAGING_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return { entries, totalFound: 0, skippedCount: 0 };
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(STAGING_DIR, file), "utf-8");
      const parsed = JSON.parse(raw) as Partial<MultiviewPendingFileOnDisk>;

      // Schema version guard: skip unknown versions (forward compat
      // — a future v2 entry on disk is not parseable here, but also
      // not crashable). Emit a debug line so dogfooders can grep their
      // logs and notice silent skip pile-up (review I5).
      if (parsed.schema_version !== MULTIVIEW_PENDING_SCHEMA_VERSION) {
        console.debug(
          `[multiview-staging-io] skipping v${String(parsed.schema_version)} entry (current v${MULTIVIEW_PENDING_SCHEMA_VERSION}): ${file}`,
        );
        continue;
      }

      // Co-tenancy discriminator: explicitly skip non-multiview entries.
      // Provisional-correction files share this dir and will appear here.
      const entry = parsed.entry;
      if (!entry || entry.kind !== "multiview-pending") continue;

      // Timestamp guard: skip entries with corrupted `created`.
      const createdMs = Date.parse(entry.created);
      if (!Number.isFinite(createdMs)) {
        skippedCount++;
        continue;
      }

      // Light shape guard before pushing — required string fields
      // present? (defensive against hand-edited or truncated files)
      if (typeof entry.slug !== "string" || typeof entry.multiview_state !== "string") {
        skippedCount++;
        continue;
      }

      entries.push(entry);
    } catch {
      // unparseable JSON, file vanished mid-read, etc.
      skippedCount++;
    }
  }

  // Chronological sort: oldest first. Stable for equal timestamps
  // (unlikely with millisecond precision but cheap guarantee).
  entries.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

  return { entries, totalFound: entries.length, skippedCount };
}

// ── Delete ───────────────────────────────────────────────────────────────

/**
 * Remove a multiview-pending entry from disk by slug. Returns true if
 * a file was deleted, false if no matching file was found (or any IO
 * error). Used by replay (3c-i) after successful brain write OR after
 * terminal skip.
 *
 * The filename was built with a timestamp prefix we don't have at
 * delete time — so we readdir + find the suffix-matching file. O(N)
 * but N ≤ ~20 typically, trivial.
 *
 * Process-level concurrency: not a concern. pi runs as a single Node
 * process per device, fs operations are synchronous and not
 * interleavable, so the readdir → unlink window cannot observe a
 * partially-written file from a concurrent write (the writer's
 * `writeFileSync` is also synchronous, and would block this delete
 * until complete — see file header concurrency note).
 *
 * Best-effort: missing file is NOT an error (idempotent). Filesystem
 * errors (EACCES) are swallowed; the caller can detect failure via
 * the false return value but cannot get the underlying errno. If a
 * stronger contract is needed later, add a variant that throws.
 */
export function deleteMultiviewPending(slug: string): boolean {
  if (!fs.existsSync(STAGING_DIR)) return false;
  const suffix = `-${slug}.json`;

  try {
    const files = fs.readdirSync(STAGING_DIR);
    const matches = files.filter((f) => f.endsWith(suffix));
    if (matches.length === 0) return false;

    let deletedAny = false;
    for (const f of matches) {
      try {
        fs.unlinkSync(path.join(STAGING_DIR, f));
        deletedAny = true;
      } catch {
        // continue trying others (pathological dup case)
      }
    }
    return deletedAny;
  } catch {
    return false;
  }
}

// ── Stats (for monitoring / audit) ───────────────────────────────────────

/**
 * Count multiview-pending entries currently on disk. Uses filename
 * pattern match — every multiview-pending file's name contains
 * `-multiview-pending-` because buildFilename concatenates the slug
 * which always starts with `multiview-pending-`. This avoids the
 * readFileSync + JSON.parse cost of inspecting every staging file,
 * which matters when the staging dir grows or count is called
 * frequently (audit row injection).
 *
 * Trade-off vs loadMultiviewPending's stricter parsing: pattern match
 * cannot detect corrupt files OR wrong schema_version. Both cases
 * still get counted here; loadMultiviewPending filters them. Acceptable
 * because count is monitoring / observability use, not gate-keeping.
 */
export function countMultiviewPending(): number {
  if (!fs.existsSync(STAGING_DIR)) return 0;
  try {
    return fs
      .readdirSync(STAGING_DIR)
      .filter((f) => f.includes("-multiview-pending-") && f.endsWith(".json"))
      .length;
  } catch {
    return 0;
  }
}
