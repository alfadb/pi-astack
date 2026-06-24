/**
 * archive-reactivation — ADR 0025 §4.6 prompt-native reactivation reviewer.
 *
 * Closes Stage 2 of the ADR 0024/0027 implementation roadmap. Pre-R8 the
 * sediment subsystem could SOFT-ARCHIVE entries (`status=archived` +
 * `archive_at` timestamp via writer.ts), but had no way to undo the
 * archival when the user's natural conversation showed the preference
 * was actively in use again. ADR 0025 §4.6 specifies a prompt-native
 * reviewer; this module implements its v1.
 *
 * # Flow
 *
 *   1. Schedule from sediment agent_end (debounced ~24h) so the cost
 *      is bounded (~one LLM call per day).
 *   2. Load all archived entries; filter to those with
 *      `archive_at` within the recent window OR no archive_at (legacy
 *      pre-§4.6 entries get reviewed once-ever).
 *   3. Build a single batched prompt: prompt template + summary of each
 *      archived entry (slug + compiledTruth + archive_at) + recent
 *      conversation window.
 *   4. LLM returns strict JSON with one decision per slug:
 *        keep_archived | reactivate | hard_archive_recommended
 *   5. For `reactivate`: call writer.updateProjectEntry to flip status.
 *      For others: audit-log only.
 *   6. Write last_run timestamp for debounce.
 *
 * # ADR 0024 invariants
 *
 *   - INV-INVISIBILITY: the reviewer never asks the user anything. Its
 *     decisions are audit + (for reactivate) direct mutation via writer.
 *     The fact that an entry was reactivated may surface in
 *     `formatSedimentNotify` like any other create/update, which is
 *     INV-INVISIBILITY-legal ("tells the user, doesn't ask").
 *   - AI-Native (§3): the decision is prompt-native. Age window
 *     (30 days) is a TRIGGER hint (cheap filter for candidates), not
 *     a decision gate — the reviewer can keep_archived entries within
 *     the window and can recommend hard_archive for any entry it sees
 *     as evidence-discontinued.
 *
 * # ADR 0027 C3' compliance
 *
 *   - INFRA: file IO (read entries / write audit / call writer)
 *   - COGNITIVE: the keep/reactivate/hard_archive decision is the LLM's
 *
 * No mechanical thresholds (e.g., "auto-reactivate if mentioned > 3
 * times") inside the cognitive layer. The reviewer prompt is the only
 * decision maker.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import type { SedimentSettings } from "./settings";
import type { ModelRegistryLike } from "./llm-extractor";
import type { MemoryEntry } from "../memory/types";
import { sanitizeForMemory } from "./sanitizer";

// ── Types ─────────────────────────────────────────────────────────────

export type ArchiveReactivationDecision =
  | "keep_archived"
  | "reactivate"
  | "hard_archive_recommended";

export interface ArchiveReactivationEntryDecision {
  slug: string;
  decision: ArchiveReactivationDecision;
  rationale: string;
  archived_quote: string;
  user_quote: string;
  age_days_approx: number;
}

export interface ArchiveReactivationLlmOutput {
  decisions: ArchiveReactivationEntryDecision[];
}

export interface ArchiveReactivationResult {
  ok: boolean;
  /** When the reviewer skipped without invoking LLM (debounce, no
   *  candidates, no model registry, or another pi instance currently
   *  holds the per-project lock — concurrent_run). */
  skipped?: "debounced" | "no_candidates" | "model_registry_unavailable" | "auth_unavailable" | "model_not_found" | "concurrent_run";
  /** Set on degraded fallback: LLM call or parse failed. */
  degraded?: boolean;
  degraded_reason?: string;
  reviewed_count: number;
  /** R1 P1-A: number of archived entries that didn’t make it into
   *  this batch (will surface in next round-robin run). */
  deferred_count?: number;
  decisions: ArchiveReactivationEntryDecision[];
  /** Slugs that were actually flipped archived→active. Preserved for
   *  backward compat with R1–R7 audit row consumers. */
  reactivated_slugs: string[];
  /** R8 NIT (Opus): full {slug, scope} so callers can render notify
   *  with correct scope (world entries previously got mis-labelled as
   *  [project]). Same length and order as reactivated_slugs. */
  reactivated_entries?: Array<{ slug: string; scope: "project" | "world" }>;
  llm_duration_ms?: number;
  llm_model?: string;
  duration_ms: number;
}

// ── Path helpers ──────────────────────────────────────────────────────

/** Per-project advisory file lock to prevent two pi instances attached
 *  to the SAME project from running the reviewer concurrently.
 *  Cross-project runs are independent (each project has its own lock).
 *  Cross-device runs each maintain their own lock (gitignored), the
 *  duplicate-cost acceptance documented in ADR 0020. */
export function archiveReactivationLockPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".pi-astack",
    "sediment",
    "archive-reactivation.lock",
  );
}

/** Per-project last-run timestamp file. Matches aggregator pattern. */
export function archiveReactivationLastRunPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".pi-astack",
    "sediment",
    "archive-reactivation-last-run.json",
  );
}

/** User-global ledger file capturing every decision row, for cross-
 *  project trend analysis and aggregator p15 visibility. */
export function archiveReactivationLedgerPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "archive-reactivation-ledger.jsonl");
}

function readLastRunMs(projectRoot: string): number | null {
  try {
    const file = archiveReactivationLastRunPath(projectRoot);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const ts = parsed?.last_run_ts;
    if (typeof ts !== "string") return null;
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function writeLastRun(projectRoot: string, now: Date, status: "ok" | "degraded" | "skipped"): void {
  try {
    const file = archiveReactivationLastRunPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      JSON.stringify({ last_run_ts: formatLocalIsoTimestamp(now), status }, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    // Best-effort; missing last_run only means next agent_end retries sooner.
  }
}

// ── Advisory file lock (concurrent-run protection) ──────────────────

/** Stale window. Generous — a healthy LLM call finishes in < 5 min;
 *  30 min covers worst-case stuck-network without false-stealing
 *  active runs. */
const LOCK_STALE_MS = 30 * 60 * 1000;

export interface ArchiveReactivationLockClaim {
  pid: number;
  host: string;
  started_at: string;
  /** R7 P2 fix (GPT-5.5): per-acquire random nonce so owner-aware
   *  release can distinguish two acquires with identical (pid, host,
   *  started_at) — e.g. after fork() or wall-clock collision. */
  nonce?: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 = check existence/permission without actually signalling
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process. EPERM = exists but the signaller can’t
    // signal it (still alive, owned by another user). Anything else
    // we treat as “unknown — don’t assume dead”.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return true;
  }
}

function parseLockClaim(raw: string): ArchiveReactivationLockClaim | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj?.pid === "number" &&
      typeof obj?.host === "string" &&
      typeof obj?.started_at === "string"
    ) {
      const claim: ArchiveReactivationLockClaim = {
        pid: obj.pid,
        host: obj.host,
        started_at: obj.started_at,
      };
      // nonce is optional (older locks without nonce still parse).
      if (typeof obj.nonce === "string") claim.nonce = obj.nonce;
      return claim;
    }
    return null;
  } catch {
    return null;
  }
}

function isStaleLock(claim: ArchiveReactivationLockClaim, now: Date): boolean {
  const startedMs = Date.parse(claim.started_at);
  if (!Number.isFinite(startedMs)) return true; // malformed timestamp → stale
  if (now.getTime() - startedMs > LOCK_STALE_MS) return true;
  // Same-host PID check: if the process is gone, the lock is stale
  // regardless of timestamp. We only trust this signal on the same
  // host — cross-host PIDs are meaningless.
  if (claim.host === os.hostname() && !isProcessAlive(claim.pid)) return true;
  return false;
}

/**
 * Try to acquire the per-project archive-reactivation lock.
 *
 * Returns `{ acquired: true, claim }` on success. The caller MUST pass
 * `claim` back to `releaseArchiveReactivationLock()` so we can verify
 * ownership before unlinking — R7 audit P2 fix (GPT-5.5): otherwise a
 * holder that woke up AFTER a stale-steal would blindly unlink the
 * stealer’s lock and reopen the concurrency window.
 *
 * On contention returns `{ acquired: false, existingClaim? }` and the
 * caller MUST treat the run as skipped — critically, do NOT write
 * last_run, because we don’t want to extend the 24h debounce just
 * because another instance grabbed the lock first.
 *
 * Stale-lock policy: if the existing lock’s started_at is older than
 * LOCK_STALE_MS, OR its PID is known-dead on the same host, we steal
 * it. There’s a tiny TOCTOU window between read-stale and steal-write
 * where two concurrent stealers could both succeed; in that case both
 * will run and both will release, costing one extra LLM call. Bounded
 * and acceptable.
 *
 * Exported for smoke coverage.
 */
export function tryAcquireArchiveReactivationLock(
  projectRoot: string,
  now: Date,
): { acquired: boolean; claim?: ArchiveReactivationLockClaim; existingClaim?: ArchiveReactivationLockClaim; stoleFrom?: ArchiveReactivationLockClaim } {
  const file = archiveReactivationLockPath(projectRoot);
  // R7 P2 fix (GPT-5.5): include a per-acquire random nonce so two
  // processes with identical (pid, host, started_at) — e.g. fork() —
  // can’t accidentally release each other’s lock. The nonce never
  // leaves the lock file; the smoke test exercises this.
  const claim: ArchiveReactivationLockClaim = {
    pid: process.pid,
    host: os.hostname(),
    started_at: formatLocalIsoTimestamp(now),
    nonce: Math.random().toString(36).slice(2, 14),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    // Can’t even create the directory. Fail closed.
    return { acquired: false };
  }
  try {
    fs.writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", { flag: "wx" });
    return { acquired: true, claim };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      // Unexpected IO error — fail closed rather than risk concurrent run.
      return { acquired: false };
    }
    // Lock file exists. Inspect for staleness.
    let existing: ArchiveReactivationLockClaim | null = null;
    try {
      existing = parseLockClaim(fs.readFileSync(file, "utf-8"));
    } catch {
      // Read failed; treat as unreadable.
    }
    if (!existing) {
      // Malformed / unreadable lock file. Don’t blindly steal — we
      // can’t prove it’s stale. Skip this run; a future run will
      // succeed once the operator cleans up or the file ages out.
      return { acquired: false };
    }
    if (isStaleLock(existing, now)) {
      try {
        // flag: 'w' = truncate-or-create. Bounded-cost TOCTOU.
        fs.writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", { flag: "w" });
        return { acquired: true, claim, stoleFrom: existing };
      } catch {
        return { acquired: false, existingClaim: existing };
      }
    }
    return { acquired: false, existingClaim: existing };
  }
}

/**
 * Helper: compare two lock claims structurally. Used by release to
 * verify ownership before unlinking. Two claims are equal iff every
 * field matches — pid, host, started_at, AND nonce.
 */
function claimsMatch(a: ArchiveReactivationLockClaim, b: ArchiveReactivationLockClaim): boolean {
  return a.pid === b.pid && a.host === b.host && a.started_at === b.started_at && a.nonce === b.nonce;
}

/**
 * Release the lock — owner-aware (R7 P2 fix, GPT-5.5).
 *
 * Behavior:
 *   - If `claim` is provided: read the current lock file, compare to
 *     `claim` structurally, and unlink ONLY if it matches. This
 *     prevents the “woke-up-after-steal” footgun where the original
 *     holder would unlink the stealer’s lock and reopen the
 *     concurrency window.
 *   - If `claim` is omitted (legacy callers / smoke teardown): fall
 *     back to unconditional unlink with a console.warn so misuse is
 *     visible. New code should ALWAYS pass the claim from acquire.
 *
 * Best-effort throughout: missing file is fine (we already lost it
 * via stale steal, or someone manually cleaned up). IO errors are
 * swallowed.
 *
 * Exported for smoke coverage.
 */
export function releaseArchiveReactivationLock(
  projectRoot: string,
  claim?: ArchiveReactivationLockClaim,
): { released: boolean; reason?: "missing" | "not_owner" | "unreadable" | "io_error" } {
  const file = archiveReactivationLockPath(projectRoot);
  if (claim === undefined) {
    // Legacy / teardown path. Unlink unconditionally but log so misuse
    // shows up in audit.
    try {
      fs.unlinkSync(file);
      return { released: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { released: false, reason: "missing" };
      return { released: false, reason: "io_error" };
    }
  }
  // Owner-aware path. Read → compare → unlink atomically (best-effort
  // — there’s still a microscopic TOCTOU window between readFile and
  // unlink, but the comparison guard means a stealer who overwrote
  // between our acquire and release would NOT match this claim).
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { released: false, reason: "missing" };
    return { released: false, reason: "io_error" };
  }
  const current = parseLockClaim(raw);
  if (!current) return { released: false, reason: "unreadable" };
  if (!claimsMatch(current, claim)) {
    // Not ours — someone stole. Leave it alone.
    return { released: false, reason: "not_owner" };
  }
  try {
    fs.unlinkSync(file);
    return { released: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { released: false, reason: "missing" };
    return { released: false, reason: "io_error" };
  }
}

function appendLedgerRow(row: Record<string, unknown>): void {
  try {
    const file = archiveReactivationLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const enriched = { ...spreadAnchor(getCurrentAnchor()), ...row };
    fs.appendFileSync(file, JSON.stringify(enriched) + "\n", "utf-8");
  } catch {
    // Ledger is observability — never throw out of agent_end bg.
  }
}

// ── Prompt assembly ───────────────────────────────────────────────────

const REVIEWER_PROMPT_FILENAME = "archive-reactivation-reviewer-v1.md";

let _cachedPrompt: string | undefined;
function loadReviewerPrompt(): string {
  if (_cachedPrompt !== undefined) return _cachedPrompt;
  _cachedPrompt = fs.readFileSync(
    path.join(__dirname, "prompts", REVIEWER_PROMPT_FILENAME),
    "utf-8",
  );
  return _cachedPrompt;
}

/** Cap per-entry compiledTruth before passing to the LLM. Keeps the
 *  reviewer prompt size bounded even when archived entries are large. */
const MAX_ENTRY_TRUTH_CHARS = 1200;
/** Cap conversation window after sanitization. */
const MAX_WINDOW_CHARS = 8000;
/** Cap total entries reviewed in one batched call. The reviewer can
 *  inspect ~N archived entries before context starts hurting attention.
 *  Excess entries roll into the next debounced run via the round-robin
 *  cursor below (R1 P1-A fix — plain DESC slice would starve tail). */
const MAX_ENTRIES_PER_RUN = 20;

/** Per-project sidecar file recording the LAST REVIEWED TIMESTAMP
 *  (not archive_at) for each slug. Used by selectReviewCandidates to
 *  enforce fair LRU round-robin across >20 archived entries.
 *  Per-project so cross-project state stays isolated; intentionally
 *  not gitsync’d (multi-device divergence is acceptable cost duplication,
 *  see R2 DeepSeek P2-2 — decisions are idempotent). */
function reviewedAtPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".pi-astack",
    "sediment",
    "archive-reactivation-reviewed-at.json",
  );
}

function readReviewedAtMap(projectRoot: string): Map<string, string> {
  try {
    const file = reviewedAtPath(projectRoot);
    if (!fs.existsSync(file)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (typeof v === "string") out.set(k, v);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Sidecar size cap. At 24h debounce with 20 reviews per run + average
 *  archive churn well under 100/year, 5000 is generous headroom. */
const REVIEWED_AT_MAX_ENTRIES = 5000;

function writeReviewedAtMap(projectRoot: string, map: Map<string, string>): void {
  try {
    const file = reviewedAtPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // R2 P2-1 fix (Opus): keep the NEWEST entries when truncating.
    // Previously walked `map.entries()` and took the first 5000, but
    // Map iteration is insertion order — freshly-reviewed slugs that
    // were already in the map don’t reorder on `set()`. The old code
    // would drop the most recently reviewed slugs once the map
    // exceeded the cap, inverting the design intent. We now sort by
    // timestamp DESC and keep the newest.
    let entries = Array.from(map.entries());
    if (entries.length > REVIEWED_AT_MAX_ENTRIES) {
      entries.sort((a, b) => (Date.parse(b[1]) || 0) - (Date.parse(a[1]) || 0));
      entries = entries.slice(0, REVIEWED_AT_MAX_ENTRIES);
    }
    const obj: Record<string, string> = Object.fromEntries(entries);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  } catch {
    // Sidecar is best-effort; missing it just resets round-robin.
  }
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "…[truncated]";
}

function ageDays(archiveAt: string | undefined, now: Date): number {
  if (!archiveAt) return 0;
  const ms = Date.parse(archiveAt);
  if (!Number.isFinite(ms)) return 0;
  const days = Math.floor((now.getTime() - ms) / (24 * 60 * 60 * 1000));
  return Math.max(0, days);
}

function entryArchiveAt(entry: MemoryEntry): string | undefined {
  const raw = entry.frontmatter?.archive_at;
  return typeof raw === "string" ? raw : undefined;
}

/** Best-effort fallback timestamp for legacy archived entries that
 *  predate ADR 0025 §4.6 (no `archive_at` field in frontmatter).
 *  Walks: archive_at → frontmatter.updated → frontmatter.created.
 *  Returns null when none parseable, in which case ageDays() degrades
 *  to 0 (same default-conservative path the prompt already documents).
 *
 *  Fix for R1 P1-D (DeepSeek): without this fallback, legacy entries
 *  permanently show age=0 in the reviewer prompt and can never be
 *  recommended for hard_archive even when they’re truly stale. */
function effectiveArchiveAt(entry: MemoryEntry): { value: string | undefined; source: "archive_at" | "updated" | "created" | "unknown" } {
  const v = entryArchiveAt(entry);
  if (v && Number.isFinite(Date.parse(v))) return { value: v, source: "archive_at" };
  const fm = (entry.frontmatter ?? {}) as Record<string, unknown>;
  const updated = typeof fm.updated === "string" ? fm.updated : undefined;
  if (updated && Number.isFinite(Date.parse(updated))) return { value: updated, source: "updated" };
  const created = typeof fm.created === "string" ? fm.created : undefined;
  if (created && Number.isFinite(Date.parse(created))) return { value: created, source: "created" };
  return { value: undefined, source: "unknown" };
}

interface PromptBuildResult {
  fullPrompt: string;
  reviewed: MemoryEntry[];
}

/**
 * Round-robin candidate selection (R2 — R1 P1-A regression fix).
 *
 * R1 used `priority = max(sinceArchive, sinceReview)`. R2 audits
 * (Opus + GPT-5.5) showed this is mathematically equivalent to plain
 * `archive_at DESC` for any entry that has been reviewed at least
 * once, because `sinceArchive` monotonically dominates `sinceReview`
 * after first review (`sinceArchive` was already ≥ `sinceReview` at
 * archival, and both grow at the same rate after). Starvation
 * re-emerged after one round-robin cycle.
 *
 * R2 formula: **`sinceReview` is the PRIMARY sort key.** Never-reviewed
 * entries get `lastReviewedMs = 0` so `sinceReview = nowMs` — they
 * win until they’ve been reviewed at least once. After that, the
 * entry with the longest wait-since-review wins, regardless of
 * archive age. This is the correct LRU semantics for fair review.
 *
 * Tie-break: archive_at DESC (recent archives preferred when waits
 * are equal), then slug ASC (deterministic).
 *
 * Properties (verified by behavioral smoke, NOT just source grep):
 *   - With MAX entries: all reviewed every run.
 *   - With 2×MAX: each entry reviewed every other run — union of
 *     two consecutive batches = full archived set.
 *   - With N×MAX (N≥2): max wait = ceil(N) runs.
 *   - Exported for smoke coverage.
 */
export function selectReviewCandidates(
  archivedEntries: MemoryEntry[],
  reviewedAt: Map<string, string>,
  now: Date,
  cap: number,
): MemoryEntry[] {
  const nowMs = now.getTime();
  type Scored = { entry: MemoryEntry; sinceReviewMs: number; archiveMs: number };
  const scored: Scored[] = archivedEntries.map((entry) => {
    const eff = effectiveArchiveAt(entry);
    const archiveRaw = eff.value ? Date.parse(eff.value) : 0;
    // Clamp future-dated stamps: they shouldn’t produce negative
    // wait. R2 NEW P2-4 (GPT-5.5): malformed `updated`/`created` in
    // the future would otherwise yield negative sinceReview and
    // demote the entry inappropriately.
    const archiveMs = archiveRaw > 0 && archiveRaw <= nowMs ? archiveRaw : 0;
    const lastReviewedStr = reviewedAt.get(entry.slug);
    const lastReviewedRaw = lastReviewedStr ? Date.parse(lastReviewedStr) : 0;
    const lastReviewedMs = lastReviewedRaw > 0 && lastReviewedRaw <= nowMs ? lastReviewedRaw : 0;
    // Never-reviewed: 0 → nowMs (full positive). This makes
    // never-reviewed entries strictly outrank all reviewed entries
    // (whose sinceReview ≤ nowMs - 1ms at minimum), giving the
    // LRU semantics the design requires.
    const sinceReviewMs = nowMs - lastReviewedMs;
    return { entry, sinceReviewMs, archiveMs };
  });
  scored.sort((a, b) => {
    if (b.sinceReviewMs !== a.sinceReviewMs) return b.sinceReviewMs - a.sinceReviewMs;
    if (b.archiveMs !== a.archiveMs) return b.archiveMs - a.archiveMs;
    return a.entry.slug.localeCompare(b.entry.slug);
  });
  return scored.slice(0, cap).map((s) => s.entry);
}

// Exported for smoke coverage — makes effectiveArchiveAt observable
// without relying on the prompt text rendering.
export { effectiveArchiveAt };

function buildReviewerPrompt(
  reviewed: MemoryEntry[],
  windowText: string,
  now: Date,
): PromptBuildResult {
  const inputBlocks = reviewed.map((entry) => {
    const eff = effectiveArchiveAt(entry);
    const age = ageDays(eff.value, now);
    const stampLabel = eff.source === "archive_at"
      ? `archive_at: ${eff.value}`
      : eff.source === "unknown"
        ? "archive_at: (missing — treat age as 0)"
        : `archive_at: (missing — fallback to frontmatter.${eff.source}: ${eff.value})`;
    return [
      `## ${entry.slug}`,
      `kind: ${entry.kind} | scope: ${entry.scope} | confidence: ${entry.confidence}`,
      stampLabel,
      `age_days_at_review: ${age}`,
      "compiledTruth:",
      clip(entry.compiledTruth ?? "", MAX_ENTRY_TRUTH_CHARS),
    ].join("\n");
  });

  const cappedWindow = clip(windowText, MAX_WINDOW_CHARS);

  const prompt = loadReviewerPrompt();
  const inputSection = [
    "# INPUT",
    "",
    "## Recent conversation window",
    "",
    "```",
    cappedWindow,
    "```",
    "",
    "## Archived entries under review",
    "",
    inputBlocks.length === 0 ? "(none)" : inputBlocks.join("\n\n---\n\n"),
  ].join("\n");

  const fullPrompt = `${prompt}\n\n---\n\n${inputSection}`;
  return { fullPrompt, reviewed };
}

// ── Parser (strict JSON, defensive defaults) ──────────────────────────

function extractJsonBlock(rawText: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(rawText);
  if (fence && fence[1]) return fence[1].trim();
  const first = rawText.indexOf("{");
  const last = rawText.lastIndexOf("}");
  if (first >= 0 && last > first) return rawText.slice(first, last + 1);
  return rawText.trim();
}

const VALID_DECISIONS: ReadonlySet<ArchiveReactivationDecision> = new Set([
  "keep_archived",
  "reactivate",
  "hard_archive_recommended",
]);

/**
 * Parse reviewer LLM output. Tolerant of additional fields; strict on
 * required fields. Throws only on completely unparseable JSON —
 * caller treats throw as degraded fallback.
 *
 * Exported for smoke coverage.
 */
export function parseArchiveReactivationOutput(
  rawText: string,
): ArchiveReactivationLlmOutput {
  const block = extractJsonBlock(rawText);
  const parsed = JSON.parse(block) as Record<string, unknown>;
  const decisionsRaw = Array.isArray(parsed.decisions) ? parsed.decisions : [];

  const decisions: ArchiveReactivationEntryDecision[] = [];
  for (const item of decisionsRaw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = typeof obj.slug === "string" ? obj.slug.trim() : "";
    if (!slug) continue;
    const decisionRaw = typeof obj.decision === "string" ? obj.decision : "";
    const isValid = VALID_DECISIONS.has(decisionRaw as ArchiveReactivationDecision);
    if (!isValid && decisionRaw) {
      // R10 DeepSeek NIT: surface drift between prompt evolution and
      // VALID_DECISIONS. Without this warn, a model emitting a new
      // (intended) decision type would be silently mapped to
      // keep_archived and the maintainer might not notice for weeks.
      // We DON'T fail — default-conservative behavior is preserved —
      // we just leave a breadcrumb on stderr.
      // eslint-disable-next-line no-console
      console.warn(`[archive-reactivation] unknown decision type ${JSON.stringify(decisionRaw)} from LLM; defaulting to keep_archived. If this is an intentional new decision, add it to VALID_DECISIONS and bump promptVersion.archiveReactivationReviewer.`);
    }
    const decision: ArchiveReactivationDecision = isValid
      ? (decisionRaw as ArchiveReactivationDecision)
      : "keep_archived"; // default-conservative
    decisions.push({
      slug,
      decision,
      rationale: typeof obj.rationale === "string" ? obj.rationale.slice(0, 500) : "",
      archived_quote: typeof obj.archived_quote === "string" ? obj.archived_quote.slice(0, 500) : "",
      user_quote: typeof obj.user_quote === "string" ? obj.user_quote.slice(0, 500) : "",
      age_days_approx:
        typeof obj.age_days_approx === "number" ? Math.max(0, Math.floor(obj.age_days_approx)) : 0,
    });
  }
  return { decisions };
}

// ── LLM invocation ────────────────────────────────────────────────────

function parseModelRef(spec: string | undefined): { provider: string; id: string } | null {
  if (!spec) return null;
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx >= spec.length - 1) return null;
  return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

async function invokeReviewer(
  fullPrompt: string,
  settings: SedimentSettings,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
): Promise<{ rawText: string; model: string; durationMs: number; skipReason?: ArchiveReactivationResult["skipped"] }> {
  const t0 = Date.now();
  // Reuse aggregatorModel (deepseek-v4-pro by default — same reasoning
  // tier needed). Falls back to curatorModel when aggregatorModel empty.
  const modelSpec = settings.aggregatorModel || settings.curatorModel;
  const parsed = parseModelRef(modelSpec);
  if (!parsed) {
    return { rawText: "", model: modelSpec, durationMs: 0, skipReason: "model_not_found" };
  }
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    return { rawText: "", model: modelSpec, durationMs: 0, skipReason: "model_not_found" };
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return { rawText: "", model: modelSpec, durationMs: 0, skipReason: "auth_unavailable" };
  }

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai/compat");

  const stream = piAi.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: fullPrompt }] }] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      timeoutMs: settings.aggregatorTimeoutMs ?? settings.curatorTimeoutMs,
      maxRetries: settings.aggregatorMaxRetries ?? 1,
    },
  );
  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    throw new Error(finalMsg.errorMessage || finalMsg.stopReason);
  }
  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!rawText) throw new Error("archive-reactivation reviewer returned empty text");
  return { rawText, model: modelSpec, durationMs: Date.now() - t0 };
}

// ── Main entry ────────────────────────────────────────────────────────

const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RunArchiveReactivationOptions {
  projectRoot: string;
  /** All currently-archived entries to consider. Caller passes the
   *  output of memory parser filtered to status==="archived". */
  archivedEntries: MemoryEntry[];
  /** Recent conversation text (sediment's run window text, already
   *  sanitized by caller via sanitizeForMemory). */
  windowText: string;
  settings: SedimentSettings;
  modelRegistry?: ModelRegistryLike;
  signal?: AbortSignal;
  sessionId?: string;
  /** When provided, the reviewer calls this to actually flip status
   *  for reactivate decisions. Not exported to caller via a writer
   *  reference because circular import — caller injects the closure.
   *  Signature carries `scope` so world-scoped entries route to
   *  the correct sub-tree (R1 P1-B fix — prior signature defaulted
   *  to project and silently failed for world entries). */
  reactivateEntry?: (slug: string, scope: "project" | "world", rationale: string) => Promise<{ ok: boolean; error?: string }>;
  /** Minimum interval between runs (debounce). Default 24h. */
  minIntervalMs?: number;
  now?: Date;
}

export async function runArchiveReactivationIfDue(
  options: RunArchiveReactivationOptions,
): Promise<ArchiveReactivationResult> {
  const t0 = Date.now();
  const now = options.now ?? new Date();
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const lastRunMs = readLastRunMs(options.projectRoot);
  if (lastRunMs !== null && now.getTime() - lastRunMs < minIntervalMs) {
    return {
      ok: true,
      skipped: "debounced",
      reviewed_count: 0,
      decisions: [],
      reactivated_slugs: [],
      duration_ms: Date.now() - t0,
    };
  }
  if (options.archivedEntries.length === 0) {
    writeLastRun(options.projectRoot, now, "skipped");
    return {
      ok: true,
      skipped: "no_candidates",
      reviewed_count: 0,
      decisions: [],
      reactivated_slugs: [],
      duration_ms: Date.now() - t0,
    };
  }
  if (!options.modelRegistry || typeof options.modelRegistry.find !== "function") {
    writeLastRun(options.projectRoot, now, "skipped");
    return {
      ok: true,
      skipped: "model_registry_unavailable",
      reviewed_count: 0,
      decisions: [],
      reactivated_slugs: [],
      duration_ms: Date.now() - t0,
    };
  }

  // Concurrent-run protection (per-project advisory file lock).
  // Two pi instances on the same project + same debounce window
  // would otherwise both pass the readLastRunMs check and both fire
  // the LLM. The lock acquires AFTER all skip-checks (so contention
  // only happens for runs that would actually invoke the LLM) and
  // BEFORE candidate selection / LLM call / writer mutations.
  //
  // Critical: on contention we return skipped:"concurrent_run"
  // WITHOUT writing last_run. That way the losing instance’s
  // 24h debounce is unaffected — it’s simply ceded this run to the
  // winner, not consumed its own quota.
  const lock = tryAcquireArchiveReactivationLock(options.projectRoot, now);
  if (!lock.acquired) {
    return {
      ok: true,
      skipped: "concurrent_run",
      reviewed_count: 0,
      decisions: [],
      reactivated_slugs: [],
      duration_ms: Date.now() - t0,
    };
  }
  const ownClaim = lock.claim;

  try {
  // Sanitize the conversation window once (the prompt template + entry
  // content is author-controlled).
  const sanitized = sanitizeForMemory(options.windowText);
  const windowText = sanitized.ok ? (sanitized.text ?? options.windowText) : `[redacted: ${sanitized.error}]`;

  // R1 P1-A fix: round-robin candidate selection with per-slug
  // last_reviewed_at sidecar. Replaces plain archive_at DESC slice.
  const reviewedAtMap = readReviewedAtMap(options.projectRoot);
  const reviewed = selectReviewCandidates(
    options.archivedEntries,
    reviewedAtMap,
    now,
    MAX_ENTRIES_PER_RUN,
  );
  const deferredCount = Math.max(0, options.archivedEntries.length - reviewed.length);
  const { fullPrompt } = buildReviewerPrompt(reviewed, windowText, now);

  // Run the LLM.
  let rawText: string;
  let model: string;
  let llmDurationMs: number;
  let skipReason: ArchiveReactivationResult["skipped"] | undefined;
  try {
    const r = await invokeReviewer(fullPrompt, options.settings, options.modelRegistry, options.signal);
    rawText = r.rawText;
    model = r.model;
    llmDurationMs = r.durationMs;
    skipReason = r.skipReason;
  } catch (e) {
    writeLastRun(options.projectRoot, now, "degraded");
    return {
      ok: false,
      degraded: true,
      degraded_reason: `llm_call_failure: ${e instanceof Error ? e.message : String(e)}`,
      reviewed_count: reviewed.length,
      // R4 GPT P2 fix: also surface deferred_count on degraded path
      // so audit row’s archived_total correctly reflects batch pressure
      // even when the LLM call fails.
      deferred_count: deferredCount,
      decisions: [],
      reactivated_slugs: [],
      duration_ms: Date.now() - t0,
    };
  }
  if (skipReason) {
    writeLastRun(options.projectRoot, now, "skipped");
    return {
      ok: true,
      skipped: skipReason,
      reviewed_count: 0,
      decisions: [],
      reactivated_slugs: [],
      duration_ms: Date.now() - t0,
    };
  }

  // Parse strict JSON.
  let parsed: ArchiveReactivationLlmOutput;
  try {
    parsed = parseArchiveReactivationOutput(rawText);
  } catch (e) {
    writeLastRun(options.projectRoot, now, "degraded");
    return {
      ok: false,
      degraded: true,
      degraded_reason: `parse_failure: ${e instanceof Error ? e.message : String(e)}`,
      reviewed_count: reviewed.length,
      // R4 GPT P2 fix: also surface deferred_count on degraded path.
      deferred_count: deferredCount,
      decisions: [],
      reactivated_slugs: [],
      llm_duration_ms: llmDurationMs,
      llm_model: model,
      duration_ms: Date.now() - t0,
    };
  }

  // Defensive: ensure every reviewed slug appears in decisions. Any
  // missing slug is treated as `keep_archived` (default-conservative).
  const decisionMap = new Map(parsed.decisions.map((d) => [d.slug, d] as const));
  const completeDecisions: ArchiveReactivationEntryDecision[] = reviewed.map((entry) => {
    const found = decisionMap.get(entry.slug);
    if (found) return found;
    return {
      slug: entry.slug,
      decision: "keep_archived",
      rationale: "decision missing from LLM output; defaulted to keep_archived",
      archived_quote: "",
      user_quote: "",
      age_days_approx: ageDays(entryArchiveAt(entry), now),
    };
  });

  // R1 P1-C fix + R3 hardening (Opus P2-R3-1 + GPT R2-RESIDUAL-2):
  // reactivate quote substring guard.
  //
  // Before applying a reactivate decision, verify the LLM’s
  // archived_quote is a substring of the reviewed entry’s
  // compiledTruth AND user_quote is a substring of the sanitized
  // window. This is the safety valve against (a) prompt-injection
  // sneaking through, (b) model hallucination of a bridge that
  // doesn’t exist, and (c) format drift where the model emits
  // {decision:"reactivate"} with no quotes at all. Failed guards
  // downgrade to keep_archived and log guard_failed in the ledger.
  //
  // R3 hardening + R4 nit (Opus + GPT-5.5): minimum quote length.
  // Without a floor, a model emitting `archived_quote: "."` +
  // `user_quote: "the"` would trivially substring-match both texts,
  // fully bypassing the guard. 12 UTF-8 BYTES = roughly 3 ASCII words
  // OR 4 CJK characters — enough signal to ground a real bridge,
  // short enough that a verbatim copy of a meaningful phrase passes.
  //
  // R4 NIT fix: use Buffer.byteLength("utf8") rather than .length
  // (UTF-16 code units). With .length, CJK quotes required 12 chars
  // (~36 bytes), much stricter than the prompt promised. Now CJK
  // can pass with 4 characters = 12 bytes as documented.
  const MIN_QUOTE_BYTES = 12;
  const qBytes = (s: string) => Buffer.byteLength(s, "utf8");
  const reviewedByslug = new Map(reviewed.map((e) => [e.slug, e] as const));
  const guardedDecisions: ArchiveReactivationEntryDecision[] = completeDecisions.map((d) => {
    if (d.decision !== "reactivate") return d;
    const entry = reviewedByslug.get(d.slug);
    const truth = (entry?.compiledTruth ?? "").trim();
    const aq = (d.archived_quote ?? "").trim();
    const uq = (d.user_quote ?? "").trim();
    if (!aq || !uq) {
      return { ...d, decision: "keep_archived", rationale: `reactivate_guard_failed: empty_quote (had aq=${qBytes(aq)}B uq=${qBytes(uq)}B); original_rationale=${d.rationale.slice(0, 200)}` };
    }
    if (qBytes(aq) < MIN_QUOTE_BYTES || qBytes(uq) < MIN_QUOTE_BYTES) {
      return { ...d, decision: "keep_archived", rationale: `reactivate_guard_failed: quote_too_short (aq=${qBytes(aq)}B uq=${qBytes(uq)}B, min=${MIN_QUOTE_BYTES}B); original_rationale=${d.rationale.slice(0, 200)}` };
    }
    // archived_quote MUST be a literal substring of the entry’s
    // compiledTruth. As a side-effect, an empty truth rejects every
    // non-empty aq via the standard `"".includes(non-empty)` returning
    // false — so the previous R1 guard (which had a `truth &&` short-
    // circuit) had a hole where empty truth would silently bypass the
    // check. The unconditional form below closes that (R3 NIT-1, Opus).
    if (!truth.includes(aq)) {
      return { ...d, decision: "keep_archived", rationale: `reactivate_guard_failed: archived_quote_not_substring; original_rationale=${d.rationale.slice(0, 200)}` };
    }
    if (!windowText.includes(uq)) {
      return { ...d, decision: "keep_archived", rationale: `reactivate_guard_failed: user_quote_not_substring; original_rationale=${d.rationale.slice(0, 200)}` };
    }
    return d;
  });

  // Apply reactivate decisions.
  const reactivatedSlugs: string[] = [];
  const reactivatedEntries: Array<{ slug: string; scope: "project" | "world" }> = [];
  for (const d of guardedDecisions) {
    if (d.decision !== "reactivate") continue;
    if (!options.reactivateEntry) continue;
    // R1 P1-B fix: pass scope so world-scoped entries reactivate
    // against the correct store.
    const entry = reviewedByslug.get(d.slug);
    const scope: "project" | "world" = entry?.scope === "world" ? "world" : "project";
    try {
      const r = await options.reactivateEntry(d.slug, scope, d.rationale);
      if (r.ok) {
        reactivatedSlugs.push(d.slug);
        reactivatedEntries.push({ slug: d.slug, scope });
      }
      // Audit the application result on ledger.
      appendLedgerRow({
        ts: formatLocalIsoTimestamp(now),
        project_root: path.resolve(options.projectRoot),
        ...(options.sessionId ? { session_id_local: options.sessionId } : {}),
        operation: "archive_reactivation_apply",
        slug: d.slug,
        scope,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (e) {
      appendLedgerRow({
        ts: formatLocalIsoTimestamp(now),
        project_root: path.resolve(options.projectRoot),
        ...(options.sessionId ? { session_id_local: options.sessionId } : {}),
        operation: "archive_reactivation_apply",
        slug: d.slug,
        scope,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Write one ledger row per decision (post-guard, independent of
  // apply outcome). Guard downgrades show up as `keep_archived` with
  // rationale prefix `reactivate_guard_failed:` for easy `jq` filtering.
  for (const d of guardedDecisions) {
    appendLedgerRow({
      ts: formatLocalIsoTimestamp(now),
      project_root: path.resolve(options.projectRoot),
      ...(options.sessionId ? { session_id_local: options.sessionId } : {}),
      operation: "archive_reactivation_decision",
      slug: d.slug,
      decision: d.decision,
      rationale: d.rationale,
      age_days_approx: d.age_days_approx,
    });
  }

  // R1 P1-A fix: update per-slug reviewed_at sidecar so next run’s
  // round-robin priorities reflect this batch. We mark reviewed slugs
  // by their `now` timestamp; non-reviewed (deferred) slugs keep
  // their prior value (or none, which is treated as +Infinity wait).
  const nowIso = formatLocalIsoTimestamp(now);
  for (const entry of reviewed) {
    reviewedAtMap.set(entry.slug, nowIso);
  }
  writeReviewedAtMap(options.projectRoot, reviewedAtMap);

  writeLastRun(options.projectRoot, now, "ok");
  return {
    ok: true,
    reviewed_count: reviewed.length,
    deferred_count: deferredCount,
    decisions: guardedDecisions,
    reactivated_slugs: reactivatedSlugs,
    reactivated_entries: reactivatedEntries,
    llm_duration_ms: llmDurationMs,
    llm_model: model,
    duration_ms: Date.now() - t0,
  };
  } finally {
    // R7 P2 fix (GPT-5.5): owner-aware release. Pass our claim so a
    // stealer’s lock is not blindly unlinked when we wake up after
    // exceeding the stale window. Lock is per-project so missing-file
    // result is harmless and expected when we lost ownership.
    //
    // R8 P2 fix (Opus): observe release outcome. `not_owner` is the
    // ONLY runtime evidence that a stale-steal race fired — if we
    // silently drop it, operators can’t calibrate the 30-min stale
    // window. Record diagnostic ledger rows for not_owner / unreadable
    // / io_error so this signal makes it to the user-global ledger.
    const releaseResult = releaseArchiveReactivationLock(options.projectRoot, ownClaim);
    if (releaseResult.reason && releaseResult.reason !== "missing") {
      appendLedgerRow({
        ts: formatLocalIsoTimestamp(now),
        project_root: path.resolve(options.projectRoot),
        ...(options.sessionId ? { session_id_local: options.sessionId } : {}),
        operation: "archive_reactivation_lock_release_anomaly",
        reason: releaseResult.reason,
        held_claim: ownClaim,
      });
    }
  }
}
