/**
 * staging-ageout — prompt-driven age-out of provisional staging hypotheses
 * (ADR 0025 §4.1.5 "30-day age-out" + §4.6.6 "shared reviewer discipline").
 *
 * # Where this sits in the staging lifecycle
 *
 *   pending ──resolver(<30d, non-destructive triage)──▶ resolver-triaged
 *          └──────────────────────── age ≥ 30d ───────────────────────┐
 *                                                                      ▼
 *   [THIS MODULE] aged-out reviewer (≥30d, ~24h debounce) ── decision ─┤
 *      ├ keep_aging        → re-review later (reversible, loses nothing)
 *      ├ soft_archive      → lifecycle_state="soft_archived" + aged_out_at
 *      │                     (REVERSIBLE: file retained, dropped from the
 *      │                      active backlog; NEVER unlinked)
 *      └ promote_candidate → advisory flag (ADVISORY ONLY — promotion to a
 *                            durable entry MUST pass multi-view §4.4; the
 *                            entry stays active + attribution_pending)
 *
 * # Why soft-archive ONLY (no unlink) — the load-bearing constraint
 *
 * Staging files live in `~/.abrain/.state/sediment/staging/`, which is
 * git-IGNORED (`.abrain/.gitignore` line 2: `.state/`). So unlinking a staging
 * file is IRREVERSIBLE — there is no `git rm` history to recover from. ADR
 * §4.6's "hard-delete is fine because git history recovers it" rationale is
 * load-bearing for DURABLE entries and simply does not hold here. Therefore
 * Stage 4 only ever flips a lifecycle field; the mechanical N-day-window →
 * hard-delete (unlink) is a deferred follow-up (Stage 5), to be gated on a
 * recovery primitive (tombstone / trash dir / move-to-tracked-archive).
 *
 * # A-layer (§4.4) compliance — promotion is NOT done here
 *
 * A single LLM CANNOT promote a hypothesis to a durable entry. This reviewer
 * only sets the `promote_candidate` advisory flag and leaves the entry active
 * + attribution_pending so the existing multi-view path can pick it up. When
 * multi-view is unavailable the entry stays staging-pending (debounced via
 * aged_out_reviewed_at), never discarded — honoring the
 * multi-view-reviewer-unavailable-fallback anti-pattern.
 *
 * # ADR 0027 C3' boundary
 *   - INFRA: file IO (scan staging / atomic rewrite / write audit/ledger)
 *   - COGNITIVE: the keep_aging / soft_archive / promote_candidate decision is
 *     the LLM reviewer's. No mechanical TTL gate inside the cognitive layer —
 *     age is a TRIGGER (cheap candidate filter), not the decision.
 *
 * Concurrency: staging is single-device (.state, not git-synced), so the only
 * race is two local pi processes. A 24h debounce + advisory lock bound that;
 * apply is idempotent (re-applying rewrites the same fields) and uses an
 * atomic tmp+rename so a crash mid-write never corrupts a hypothesis file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SedimentSettings } from "./settings";
import { AGEOUT_RE_REVIEW_DAYS, stagingDir, STALE_DAYS } from "./staging-loader";
import type { StagingEntry, StagingFileOnDisk } from "./staging-types";
import { formatLocalIsoTimestamp, ensureUserGlobalSidecarMigrated, userGlobalSedimentDir } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";

export const STAGING_AGEOUT_PROMPT_VERSION = "v1";

// ── Tunables ──────────────────────────────────────────────────────────
/** Aged-out entries are old + low-churn; a daily cadence matches the
 *  archive-reactivation reviewer's cost envelope (~one LLM call/day). */
const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Hypotheses reviewed per run (excess rolls into the next daily run via
 *  oldest-first selection). */
const MAX_AGEOUT_PER_RUN = 20;
const MAX_HYPOTHESIS_CHARS = 600;
const MAX_QUOTE_CHARS = 400;
const MAX_WINDOW_CHARS = 4000;
/** Advisory lock stale window. */
const LOCK_STALE_MS = 30 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────

export interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export type StagingAgeOutDecisionKind = "keep_aging" | "soft_archive" | "promote_candidate";

export interface StagingAgeOutDecision {
  slug: string;
  decision: StagingAgeOutDecisionKind;
  rationale: string;
}

export interface StagingAgeOutLlmOutput {
  decisions: StagingAgeOutDecision[];
}

export interface StagingAgeOutResult {
  ok: boolean;
  skipped?:
    | "debounced"
    | "no_candidates"
    | "model_registry_unavailable"
    | "auth_unavailable"
    | "model_not_found"
    | "concurrent_run";
  degraded?: boolean;
  reviewed_count: number;
  /** Hypotheses retired (reversible soft-archive) this run. */
  soft_archived_slugs: string[];
  kept_aging_count: number;
  promote_candidates: string[];
  model?: string;
  durationMs: number;
  error?: string;
}

interface AgeOutCandidate {
  file: string; // absolute path
  entry: StagingEntry;
}

// ── Sidecar paths (per-project debounce + lock; user-global ledger) ─────

export function stagingAgeOutLastRunPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "staging-ageout-last-run.json");
}

export function stagingAgeOutLockPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "staging-ageout.lock");
}

export function stagingAgeOutLedgerPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "staging-ageout-ledger.jsonl");
}

function readLastRunMs(projectRoot: string): number | null {
  try {
    const file = stagingAgeOutLastRunPath(projectRoot);
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
    const file = stagingAgeOutLastRunPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ last_run_ts: formatLocalIsoTimestamp(now), status }, null, 2) + "\n", "utf-8");
  } catch {
    /* best-effort: missing last_run only means next agent_end retries sooner */
  }
}

function appendLedgerRow(row: Record<string, unknown>): void {
  try {
    const file = stagingAgeOutLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const enriched = { ...spreadAnchor(getCurrentAnchor()), ...row };
    fs.appendFileSync(file, JSON.stringify(enriched) + "\n", "utf-8");
  } catch {
    /* observability — never throw out of agent_end bg */
  }
}

// ── Minimal advisory lock (own lock; independent of the resolver's) ─────

interface StagingAgeOutLockClaim {
  pid: number;
  host: string;
  started_at: string;
  nonce: string;
}

function parseLockClaim(raw: string): StagingAgeOutLockClaim | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StagingAgeOutLockClaim>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || typeof parsed.host !== "string" || typeof parsed.started_at !== "string" || typeof parsed.nonce !== "string") return null;
    return { pid: parsed.pid, host: parsed.host, started_at: parsed.started_at, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

function claimsMatch(a: StagingAgeOutLockClaim, b: StagingAgeOutLockClaim): boolean {
  return a.pid === b.pid && a.host === b.host && a.started_at === b.started_at && a.nonce === b.nonce;
}

function tryAcquireLock(projectRoot: string, now: Date): StagingAgeOutLockClaim | null {
  const file = stagingAgeOutLockPath(projectRoot);
  const claim: StagingAgeOutLockClaim = {
    pid: process.pid,
    host: os.hostname(),
    started_at: formatLocalIsoTimestamp(now),
    nonce: Math.random().toString(36).slice(2, 14),
  };
  const payload = JSON.stringify(claim, null, 2) + "\n";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  try {
    fs.writeFileSync(file, payload, { flag: "wx" });
    return claim;
  } catch {
    try {
      const st = fs.statSync(file);
      if (now.getTime() - st.mtimeMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(file); } catch { /* race: someone else reclaimed */ }
        try { fs.writeFileSync(file, payload, { flag: "wx" }); return claim; } catch { return null; }
      }
    } catch {
      /* stat failed — treat as locked */
    }
    return null;
  }
}

function releaseLock(projectRoot: string, claim: StagingAgeOutLockClaim | null): void {
  if (!claim) return;
  try {
    const file = stagingAgeOutLockPath(projectRoot);
    const current = parseLockClaim(fs.readFileSync(file, "utf-8"));
    if (!current || !claimsMatch(current, claim)) return;
    fs.unlinkSync(file);
  } catch { /* best-effort */ }
}

// ── Candidate scan ──────────────────────────────────────────────────────

/** Load aged-out provisional-correction candidates (oldest first, capped).
 *  Selects entries that are: provisional-correction, attribution_pending,
 *  AGED PAST STALE_DAYS (the inverse of the resolver, which skips these), NOT
 *  already soft-archived, and NOT reviewed by the age-out reviewer within the
 *  re-review window. Exported for smoke coverage. */
export function selectAgeOutCandidates(now: Date = new Date(), max: number = MAX_AGEOUT_PER_RUN): AgeOutCandidate[] {
  const out: AgeOutCandidate[] = [];
  const staleCutoff = now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const reReviewCutoff = now.getTime() - AGEOUT_RE_REVIEW_DAYS * 24 * 60 * 60 * 1000;
  let dir: string;
  try {
    dir = stagingDir();
    if (!fs.existsSync(dir)) return out;
  } catch {
    return out;
  }
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); // chronological → oldest first
  } catch {
    return out;
  }
  for (const f of files) {
    if (out.length >= max) break;
    const abs = path.join(dir, f);
    try {
      const parsed: StagingFileOnDisk = JSON.parse(fs.readFileSync(abs, "utf-8"));
      const entry = parsed?.entry;
      if (!entry || entry.kind !== "provisional-correction") continue;
      if (entry.attribution_pending !== true) continue;
      // Already retired by a prior age-out run → leave it (Stage 5 will
      // hard-delete). soft_archived is the orthogonal backlog axis.
      if (entry.lifecycle_state === "soft_archived") continue;
      const created = Date.parse(entry.created);
      // ONLY aged-out entries (≥ STALE_DAYS). Fresh ones are the resolver's.
      if (!Number.isFinite(created) || created >= staleCutoff) continue;
      // Re-review debounce: skip entries this reviewer saw recently so a
      // keep_aging verdict isn't re-litigated every day.
      if (entry.aged_out_reviewed_at) {
        const reviewed = Date.parse(entry.aged_out_reviewed_at);
        if (Number.isFinite(reviewed) && reviewed >= reReviewCutoff) continue;
      }
      out.push({ file: abs, entry });
    } catch {
      /* corrupted file — skip */
    }
  }
  return out;
}

// ── Prompt assembly ──────────────────────────────────────────────────────

const AGEOUT_PROMPT_FILENAME = "staging-ageout-reviewer-v1.md";
let _cachedPrompt: string | undefined;
function loadAgeOutPrompt(): string {
  if (_cachedPrompt !== undefined) return _cachedPrompt;
  _cachedPrompt = fs.readFileSync(path.join(__dirname, "prompts", AGEOUT_PROMPT_FILENAME), "utf-8");
  return _cachedPrompt;
}

function clip(text: string, cap: number): string {
  if (!text) return "";
  return text.length <= cap ? text : text.slice(0, cap) + "…";
}

export function buildAgeOutPrompt(candidates: AgeOutCandidate[], windowText: string, now: Date = new Date()): string {
  const lines: string[] = [loadAgeOutPrompt(), "", "## Aged-out hypotheses to review", ""];
  const nowMs = now.getTime();
  for (const c of candidates) {
    const e = c.entry;
    const ageDays = Number.isFinite(Date.parse(e.created))
      ? Math.max(0, Math.floor((nowMs - Date.parse(e.created)) / (24 * 60 * 60 * 1000)))
      : 0;
    const quote = e.source_utterance?.[0]?.quote ?? "";
    const prior = e.resolver_disposition ? `, resolver_disposition ${e.resolver_disposition}` : "";
    lines.push(`### ${e.slug}  (age ~${ageDays}d, classifier confidence ${e.correction_signal?.confidence ?? "?"}${prior})`);
    lines.push(`hypothesis: ${clip(e.hypothesis ?? "", MAX_HYPOTHESIS_CHARS)}`);
    if (quote) lines.push(`user_quote: ${clip(quote, MAX_QUOTE_CHARS)}`);
    lines.push("");
  }
  if (windowText && windowText.trim()) {
    lines.push("## Recent conversation window (context only)", "", clip(windowText.trim(), MAX_WINDOW_CHARS), "");
  }
  return lines.join("\n");
}

// ── Output parsing (tolerant; default-conservative = keep_aging) ─────────

function extractJsonBlock(rawText: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(rawText);
  if (fence && fence[1]) return fence[1].trim();
  const first = rawText.indexOf("{");
  const last = rawText.lastIndexOf("}");
  if (first >= 0 && last > first) return rawText.slice(first, last + 1);
  return rawText.trim();
}

/** Parse age-out reviewer output. Tolerant of extra fields. Unknown decision
 *  values default to `keep_aging` (conservative — nothing retired). Throws
 *  only on unparseable JSON — caller treats throw as degraded → keep
 *  everything aging. Exported for smoke coverage. */
export function parseStagingAgeOutOutput(rawText: string): StagingAgeOutLlmOutput {
  const parsed = JSON.parse(extractJsonBlock(rawText)) as Record<string, unknown>;
  const decisionsRaw = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const decisions: StagingAgeOutDecision[] = [];
  for (const item of decisionsRaw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = typeof obj.slug === "string" ? obj.slug.trim() : "";
    if (!slug) continue;
    const d = obj.decision;
    const decision: StagingAgeOutDecisionKind =
      d === "soft_archive" ? "soft_archive" : d === "promote_candidate" ? "promote_candidate" : "keep_aging";
    decisions.push({
      slug,
      decision,
      rationale: typeof obj.rationale === "string" ? obj.rationale.slice(0, 500) : "",
    });
  }
  return { decisions };
}

// ── Apply ────────────────────────────────────────────────────────────────

/** Pure transform: stamp the age-out reviewer's disposition onto an entry.
 *  REVERSIBLE — soft_archive only flips lifecycle_state + sets aged_out_at;
 *  the file is never unlinked. attribution_pending is left UNTOUCHED (see
 *  staging-types.ts). `updated` is deliberately NOT bumped — this is system
 *  lifecycle, not fresh user activity. Exported for smoke coverage. */
export function annotateAgeOut(
  entry: StagingEntry,
  now: Date,
  decision: StagingAgeOutDecisionKind,
  rationale: string,
): StagingEntry {
  const reviewedAt = formatLocalIsoTimestamp(now);
  const next: StagingEntry = {
    ...entry,
    aged_out_reviewed_at: reviewedAt,
    aged_out_decision: decision,
    aged_out_rationale: rationale.slice(0, 500),
    aged_out_prompt_version: STAGING_AGEOUT_PROMPT_VERSION,
  };
  if (decision === "soft_archive") {
    next.lifecycle_state = "soft_archived";
    next.aged_out_at = reviewedAt;
  }
  // keep_aging / promote_candidate: stay active (lifecycle_state untouched);
  // promote_candidate is advisory only (multi-view §4.4 still gates promotion).
  return next;
}

/** Atomic write: tmp + rename so a crash mid-write never corrupts the file. */
function writeStagingFileAtomic(file: string, entry: StagingEntry): void {
  const payload: StagingFileOnDisk = { schema_version: 1, entry };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export interface AgeOutApplyResult {
  softArchived: string[];
  promoteCandidates: string[];
  keptAging: number;
}

/** Apply the reviewer's decisions to the loaded candidates. Unlisted slugs
 *  default to keep_aging. A failed write is skipped (next run re-reviews it).
 *  Exported for smoke coverage of the real on-disk path. */
export function applyAgeOutDecisions(
  candidates: AgeOutCandidate[],
  output: StagingAgeOutLlmOutput,
  now: Date,
): AgeOutApplyResult {
  const decisionBySlug = new Map(output.decisions.map((d) => [d.slug, d]));
  const softArchived: string[] = [];
  const promoteCandidates: string[] = [];
  let keptAging = 0;
  for (const c of candidates) {
    const d = decisionBySlug.get(c.entry.slug);
    const decision: StagingAgeOutDecisionKind = d?.decision ?? "keep_aging";
    try {
      writeStagingFileAtomic(c.file, annotateAgeOut(c.entry, now, decision, d?.rationale ?? ""));
    } catch {
      continue; // write failed → leave as-is; next run re-reviews
    }
    if (decision === "soft_archive") softArchived.push(c.entry.slug);
    else if (decision === "promote_candidate") promoteCandidates.push(c.entry.slug);
    else keptAging++;
  }
  return { softArchived, promoteCandidates, keptAging };
}

// ── LLM invocation ───────────────────────────────────────────────────────

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
): Promise<{ rawText: string; model: string; skipReason?: StagingAgeOutResult["skipped"] }> {
  const modelSpec = settings.aggregatorModel || settings.curatorModel;
  const parsed = parseModelRef(modelSpec);
  if (!parsed) return { rawText: "", model: modelSpec, skipReason: "model_not_found" };
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) return { rawText: "", model: modelSpec, skipReason: "model_not_found" };
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return { rawText: "", model: modelSpec, skipReason: "auth_unavailable" };

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
  if (!rawText) throw new Error("staging-ageout reviewer returned empty text");
  return { rawText, model: modelSpec };
}

// ── Main entry ───────────────────────────────────────────────────────────

export interface RunStagingAgeOutOptions {
  projectRoot: string;
  windowText?: string;
  settings: SedimentSettings;
  modelRegistry?: ModelRegistryLike;
  signal?: AbortSignal;
  sessionId?: string;
  minIntervalMs?: number;
  now?: Date;
}

export async function runStagingAgeOutIfDue(options: RunStagingAgeOutOptions): Promise<StagingAgeOutResult> {
  const t0 = Date.now();
  const now = options.now ?? new Date();
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const base: Omit<StagingAgeOutResult, "ok" | "durationMs"> = {
    reviewed_count: 0,
    soft_archived_slugs: [],
    kept_aging_count: 0,
    promote_candidates: [],
  };

  // 1. Debounce.
  const lastRunMs = readLastRunMs(options.projectRoot);
  if (lastRunMs !== null && now.getTime() - lastRunMs < minIntervalMs) {
    return { ok: true, skipped: "debounced", ...base, durationMs: Date.now() - t0 };
  }

  // 2. Candidates.
  const candidates = selectAgeOutCandidates(now);
  if (candidates.length === 0) {
    writeLastRun(options.projectRoot, now, "skipped");
    return { ok: true, skipped: "no_candidates", ...base, durationMs: Date.now() - t0 };
  }

  // 3. Model availability (don't write last_run on hard-unavailable so the
  //    next agent_end retries once a model is configured).
  if (!options.modelRegistry) {
    return { ok: true, skipped: "model_registry_unavailable", ...base, reviewed_count: candidates.length, durationMs: Date.now() - t0 };
  }

  // 4. Lock (cede this run on contention; do NOT advance debounce).
  const lockClaim = tryAcquireLock(options.projectRoot, now);
  if (!lockClaim) {
    return { ok: true, skipped: "concurrent_run", ...base, reviewed_count: candidates.length, durationMs: Date.now() - t0 };
  }

  try {
    // 5. Build prompt + invoke LLM. loadAgeOutPrompt() reads the prompt file
    // from disk; a missing/unreadable prompt must DEGRADE, not throw out of
    // this fire-and-forget bg fn — so it lives INSIDE the inner try.
    let rawText: string;
    let model: string;
    try {
      const prompt = buildAgeOutPrompt(candidates, options.windowText ?? "", now);
      const inv = await invokeReviewer(prompt, options.settings, options.modelRegistry, options.signal);
      if (inv.skipReason) {
        writeLastRun(options.projectRoot, now, "skipped");
        appendLedgerRow({ op: "staging_ageout", ok: false, skipped: inv.skipReason, reviewed_count: candidates.length, model: inv.model, session_id: options.sessionId, prompt_version: STAGING_AGEOUT_PROMPT_VERSION });
        return { ok: true, skipped: inv.skipReason, ...base, reviewed_count: candidates.length, model: inv.model, durationMs: Date.now() - t0 };
      }
      rawText = inv.rawText;
      model = inv.model;
    } catch (e: unknown) {
      writeLastRun(options.projectRoot, now, "degraded");
      const error = e instanceof Error ? e.message : String(e);
      appendLedgerRow({ op: "staging_ageout", ok: false, degraded: true, reviewed_count: candidates.length, error: error.slice(0, 500), session_id: options.sessionId, prompt_version: STAGING_AGEOUT_PROMPT_VERSION });
      return { ok: false, degraded: true, ...base, reviewed_count: candidates.length, error: error.slice(0, 500), durationMs: Date.now() - t0 };
    }

    // 6. Parse (degraded → keep everything aging).
    let output: StagingAgeOutLlmOutput;
    try {
      output = parseStagingAgeOutOutput(rawText);
    } catch {
      writeLastRun(options.projectRoot, now, "degraded");
      appendLedgerRow({ op: "staging_ageout", ok: false, degraded: true, reviewed_count: candidates.length, error: "unparseable_llm_output", session_id: options.sessionId, prompt_version: STAGING_AGEOUT_PROMPT_VERSION });
      return { ok: false, degraded: true, ...base, reviewed_count: candidates.length, model, durationMs: Date.now() - t0 };
    }

    // 7. Apply (reversible: soft_archive flips lifecycle_state, never unlinks).
    const { softArchived, promoteCandidates, keptAging } = applyAgeOutDecisions(candidates, output, now);

    writeLastRun(options.projectRoot, now, "ok");
    appendLedgerRow({
      op: "staging_ageout",
      ok: true,
      reviewed_count: candidates.length,
      soft_archived_count: softArchived.length,
      kept_aging_count: keptAging,
      promote_candidate_count: promoteCandidates.length,
      soft_archived_slugs: softArchived,
      promote_candidates: promoteCandidates,
      model,
      session_id: options.sessionId,
      prompt_version: STAGING_AGEOUT_PROMPT_VERSION,
    });
    return {
      ok: true,
      reviewed_count: candidates.length,
      soft_archived_slugs: softArchived,
      kept_aging_count: keptAging,
      promote_candidates: promoteCandidates,
      model,
      durationMs: Date.now() - t0,
    };
  } finally {
    releaseLock(options.projectRoot, lockClaim);
  }
}
