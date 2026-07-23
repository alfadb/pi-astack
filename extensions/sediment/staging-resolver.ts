/**
 * staging-resolver — active batch resolution of provisional staging
 * hypotheses (ADR 0025 §4.1.5.1, "choice 1: batch scan").
 *
 * The active-correction classifier parks durable-but-unattributable
 * hypotheses as `provisional-correction` staging entries
 * (`~/.abrain/.state/sediment/staging/*.json`). Before this module, those
 * entries were only *lazily* resolved — the classifier checked them as
 * context when a future utterance happened to be relevant (§4.1.3 step 6).
 * Most were never seen and piled up to the 30-day age-out, producing a
 * `staging_backlog` aggregator hit every run.
 *
 * This module schedules a debounced batch pass from sediment `agent_end`:
 * it loads the pending hypotheses and asks an LLM resolver to TRIAGE each
 * one — `likely_noise` (deprioritize) vs `plausible` (keep) — and to flag
 * `promote_candidate` for clearly-durable ones.
 *
 * NON-DESTRUCTIVE (R1 opus P1): the resolver NEVER removes a hypothesis from
 * the learning loop. These are already-classified-durable signals; terminally
 * discarding one on a single LLM's lone judgement — while promotion is
 * multi-view-gated — would be a backwards data-conservation asymmetry. So the
 * resolver only ANNOTATES the staging file (resolver_disposition +
 * resolver_reviewed_at + rationale) and leaves attribution_pending untouched.
 * Retirement stays the job of the time-bounded age-out (ADR 0025 §4.1.5 /
 * §4.6 reviewer), which is the user-accepted default the resolver does not
 * pre-empt. Selection deprioritizes recently-reviewed entries so the resolver
 * doesn't re-burn tokens on the same hypotheses every run.
 *
 * v1 scope: triage + promote-candidate flagging. Actual promotion of a
 * hypothesis to a durable entry MUST pass multi-view (ADR 0025 §4.4) and is
 * deferred to a follow-up; the resolver only sets the advisory flag and keeps
 * such entries pending so the existing classifier/multi-view path can promote
 * them. (Same "primitive first" staging as hard_archive.)
 *
 * Concurrency: staging lives under `.state/` (single-device, git-ignored,
 * not synced), so the only race is two local pi processes. A debounce +
 * minimal advisory lock bound that; triage is idempotent (re-annotating an
 * entry just rewrites the same disposition), and selection's re-review window
 * means a lost lock race at worst re-reviews a few entries once.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SedimentSettings } from "./settings";
import { stagingDir, STALE_DAYS } from "./staging-loader";
import type { StagingEntry, StagingFileOnDisk } from "./staging-types";
import { formatLocalIsoTimestamp, ensureUserGlobalSidecarMigrated, userGlobalSedimentDir } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { auditStreamSimple } from "../_shared/llm-audit";
import { recordProvisionalLifecycleFailure, refreshLifecycleConvergenceReadModel } from "./lifecycle-convergence";

export const STAGING_RESOLVER_PROMPT_VERSION = "v1";

// ── Tunables ──────────────────────────────────────────────────────────
/** Default debounce: staging churns faster than archived entries, so a
 *  6h cadence keeps the backlog worked without per-turn LLM cost. */
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Hypotheses triaged per run. Excess rolls into the next debounced run
 *  (oldest-first selection drains the tail). */
const MAX_RESOLVE_PER_RUN = 15;
/** Don't re-triage an entry the resolver already reviewed within this many
 *  days — bounds token cost and lets a triaged disposition stick. */
const RE_REVIEW_DAYS = 7;
/** Entries older than this are left for the age-out / archive path, not
 *  triaged here. Imported from staging-loader so the resolver and loader
 *  never disagree on what "stale" means (R1 NIT: single source of truth). */
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

export type StagingResolverDecisionKind = "likely_noise" | "plausible";

export interface StagingResolverDecision {
  slug: string;
  decision: StagingResolverDecisionKind;
  promote_candidate: boolean;
  rationale: string;
}

export interface StagingResolverLlmOutput {
  decisions: StagingResolverDecision[];
}

export interface StagingResolverResult {
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
  /** Hypotheses triaged as likely-noise this run (deprioritized, NOT
   *  removed from the loop). */
  likely_noise_slugs: string[];
  plausible_count: number;
  promote_candidates: string[];
  model?: string;
  durationMs: number;
  error?: string;
}

interface StagingCandidate {
  file: string; // absolute path
  entry: StagingEntry;
}

// ── Sidecar paths (per-project debounce + lock; user-global ledger) ─────

export function stagingResolverLastRunPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "staging-resolver-last-run.json");
}

export function stagingResolverLockPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "staging-resolver.lock");
}

export function stagingResolverLedgerPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "staging-resolver-ledger.jsonl");
}

function readLastRunMs(projectRoot: string): number | null {
  try {
    const file = stagingResolverLastRunPath(projectRoot);
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
    const file = stagingResolverLastRunPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ last_run_ts: formatLocalIsoTimestamp(now), status }, null, 2) + "\n", "utf-8");
  } catch {
    /* best-effort: missing last_run only means next agent_end retries sooner */
  }
}

function appendLedgerRow(row: Record<string, unknown>): void {
  try {
    const file = stagingResolverLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const enriched = { ...spreadAnchor(getCurrentAnchor()), ...row };
    fs.appendFileSync(file, JSON.stringify(enriched) + "\n", "utf-8");
  } catch {
    /* observability — never throw out of agent_end bg */
  }
}

// ── Minimal advisory lock ───────────────────────────────────────────────

interface StagingResolverLockClaim {
  pid: number;
  host: string;
  started_at: string;
  nonce: string;
}

function parseLockClaim(raw: string): StagingResolverLockClaim | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StagingResolverLockClaim>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number" || typeof parsed.host !== "string" || typeof parsed.started_at !== "string" || typeof parsed.nonce !== "string") return null;
    return { pid: parsed.pid, host: parsed.host, started_at: parsed.started_at, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

function claimsMatch(a: StagingResolverLockClaim, b: StagingResolverLockClaim): boolean {
  return a.pid === b.pid && a.host === b.host && a.started_at === b.started_at && a.nonce === b.nonce;
}

/** Acquire a best-effort lock. Returns a claim on success. If a stale lock
 *  (older than LOCK_STALE_MS) is present it is reclaimed. */
function tryAcquireLock(projectRoot: string, now: Date): StagingResolverLockClaim | null {
  const file = stagingResolverLockPath(projectRoot);
  const claim: StagingResolverLockClaim = {
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
    // Exists — check staleness.
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

function releaseLock(projectRoot: string, claim: StagingResolverLockClaim | null): void {
  if (!claim) return;
  try {
    const file = stagingResolverLockPath(projectRoot);
    const current = parseLockClaim(fs.readFileSync(file, "utf-8"));
    if (!current || !claimsMatch(current, claim)) return;
    fs.unlinkSync(file);
  } catch { /* best-effort */ }
}

// ── Candidate scan ──────────────────────────────────────────────────────

/** Load pending provisional-correction staging candidates (oldest first,
 *  capped). Skips stale (>30d) entries (those go to the age-out path) and
 *  already-resolved entries. Exported for smoke coverage. */
export function selectStagingCandidates(now: Date = new Date(), max: number = MAX_RESOLVE_PER_RUN): StagingCandidate[] {
  const out: StagingCandidate[] = [];
  const staleCutoff = now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const reReviewCutoff = now.getTime() - RE_REVIEW_DAYS * 24 * 60 * 60 * 1000;
  let dir: string;
  try {
    dir = stagingDir();
    if (!fs.existsSync(dir)) return out;
  } catch {
    return out;
  }
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); // chronological (ISO ts in name) → oldest first
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
      // Stage 4 (ADR 0025 §4.1.5 / §4.6.6): defensive — a soft-archived
      // hypothesis has been retired by the age-out reviewer; the resolver
      // must not re-triage it (it's already out of the active backlog).
      // In practice soft_archived implies aged-out (≥30d) so the staleCutoff
      // check below would also skip it, but this keeps the intent explicit.
      if (entry.lifecycle_state === "soft_archived") continue;
      const created = Date.parse(entry.created);
      if (!Number.isFinite(created) || created < staleCutoff) continue;
      // Deprioritize: skip entries the resolver already triaged recently so
      // it doesn't re-burn tokens on the same hypotheses every run. They stay
      // in the loop (attribution_pending untouched) and age out normally.
      if (entry.resolver_reviewed_at) {
        const reviewed = Date.parse(entry.resolver_reviewed_at);
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

const RESOLVER_PROMPT_FILENAME = "staging-resolver-v1.md";
let _cachedPrompt: string | undefined;
function loadResolverPrompt(): string {
  if (_cachedPrompt !== undefined) return _cachedPrompt;
  _cachedPrompt = fs.readFileSync(path.join(__dirname, "prompts", RESOLVER_PROMPT_FILENAME), "utf-8");
  return _cachedPrompt;
}

function clip(text: string, cap: number): string {
  if (!text) return "";
  return text.length <= cap ? text : text.slice(0, cap) + "…";
}

export function buildResolverPrompt(candidates: StagingCandidate[], windowText: string, now: Date = new Date()): string {
  const lines: string[] = [loadResolverPrompt(), "", "## Pending hypotheses to triage", ""];
  const nowMs = now.getTime();
  for (const c of candidates) {
    const e = c.entry;
    const ageDays = Number.isFinite(Date.parse(e.created))
      ? Math.max(0, Math.floor((nowMs - Date.parse(e.created)) / (24 * 60 * 60 * 1000)))
      : 0;
    const quote = e.source_utterance?.[0]?.quote ?? "";
    lines.push(`### ${e.slug}  (age ~${ageDays}d, classifier confidence ${e.correction_signal?.confidence ?? "?"})`);
    lines.push(`hypothesis: ${clip(e.hypothesis ?? "", MAX_HYPOTHESIS_CHARS)}`);
    if (quote) lines.push(`user_quote: ${clip(quote, MAX_QUOTE_CHARS)}`);
    lines.push("");
  }
  if (windowText && windowText.trim()) {
    lines.push("## Recent conversation window (context only)", "", clip(windowText.trim(), MAX_WINDOW_CHARS), "");
  }
  return lines.join("\n");
}

// ── Output parsing (tolerant; default-conservative = keep) ───────────────

function extractJsonBlock(rawText: string): string {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(rawText);
  if (fence && fence[1]) return fence[1].trim();
  const first = rawText.indexOf("{");
  const last = rawText.lastIndexOf("}");
  if (first >= 0 && last > first) return rawText.slice(first, last + 1);
  return rawText.trim();
}

/** Parse resolver LLM output. Tolerant of extra fields. Unknown decision
 *  values default to `keep` (conservative). Throws only on unparseable
 *  JSON — caller treats throw as degraded → keep everything. Exported for
 *  smoke coverage. */
export function parseStagingResolverOutput(rawText: string): StagingResolverLlmOutput {
  const parsed = JSON.parse(extractJsonBlock(rawText)) as Record<string, unknown>;
  const decisionsRaw = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const decisions: StagingResolverDecision[] = [];
  for (const item of decisionsRaw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = typeof obj.slug === "string" ? obj.slug.trim() : "";
    if (!slug) continue;
    const decision: StagingResolverDecisionKind = obj.decision === "likely_noise" ? "likely_noise" : "plausible";
    decisions.push({
      slug,
      decision,
      promote_candidate: obj.promote_candidate === true,
      rationale: typeof obj.rationale === "string" ? obj.rationale.slice(0, 500) : "",
    });
  }
  return { decisions };
}

// ── Apply ────────────────────────────────────────────────────────────────

/** Pure transform: annotate a pending entry with the resolver's triage
 *  disposition. NON-DESTRUCTIVE — attribution_pending is left untouched, so
 *  the hypothesis stays in the learning loop and ages out normally; only the
 *  triage metadata + reviewed-at timestamp are added. Exported for smoke
 *  coverage. */
export function annotateEntry(
  entry: StagingEntry,
  now: Date,
  disposition: NonNullable<StagingEntry["resolver_disposition"]>,
  rationale: string,
): StagingEntry {
  const reviewedAt = formatLocalIsoTimestamp(now);
  return {
    ...entry,
    // NOTE: we deliberately do NOT bump `updated` here (R2 opus/deepseek NIT):
    // `resolver_reviewed_at` is the semantically meaningful triage timestamp,
    // and bumping `updated` could look like fresh USER activity to any future
    // recency consumer. Triage is system activity, not user activity.
    resolver_reviewed_at: reviewedAt,
    resolver_disposition: disposition,
    resolver_rationale: rationale.slice(0, 500),
    lifecycle_attempt: entry.lifecycle_attempt ?? 0,
    lifecycle_failure_class: "semantic_defer",
    lifecycle_next_retry_not_before: new Date(now.getTime() + RE_REVIEW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    lifecycle_deadline: new Date(now.getTime() + (RE_REVIEW_DAYS + 14) * 24 * 60 * 60 * 1000).toISOString(),
    lifecycle_new_evidence_trigger: "new_matching_correction_evidence|resolver_due|ageout_threshold",
    lifecycle_terminal_at: undefined,
    lifecycle_terminal_reason: undefined,
  };
}

function writeStagingFile(file: string, entry: StagingEntry): void {
  const payload: StagingFileOnDisk = { schema_version: 1, entry };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export interface ApplyResult {
  likelyNoise: string[];
  promoteCandidates: string[];
  plausible: number;
}

/** Apply resolver triage to the loaded candidates: annotate each with its
 *  disposition (likely_noise / plausible / promote_candidate) + reviewed-at,
 *  WITHOUT touching attribution_pending (non-destructive — see module/file
 *  docstrings). promote_candidate wins over the decision field (a promote
 *  candidate is always "plausible"-or-better and kept for the durable path).
 *  A failed write is skipped silently (next run re-reviews it). Exported for
 *  smoke coverage of the real on-disk path. */
export function applyResolverDecisions(
  candidates: StagingCandidate[],
  output: StagingResolverLlmOutput,
  now: Date,
): ApplyResult {
  const decisionBySlug = new Map(output.decisions.map((d) => [d.slug, d]));
  const likelyNoise: string[] = [];
  const promoteCandidates: string[] = [];
  let plausible = 0;
  for (const c of candidates) {
    const d = decisionBySlug.get(c.entry.slug);
    const promote = d?.promote_candidate === true;
    const disposition: NonNullable<StagingEntry["resolver_disposition"]> = promote
      ? "promote_candidate"
      : d?.decision === "likely_noise"
        ? "likely_noise"
        : "plausible";
    try {
      writeStagingFile(c.file, annotateEntry(c.entry, now, disposition, d?.rationale ?? ""));
    } catch {
      continue; // write failed → leave un-annotated; next run re-reviews
    }
    if (promote) promoteCandidates.push(c.entry.slug);
    else if (disposition === "likely_noise") likelyNoise.push(c.entry.slug);
    else plausible++;
  }
  return { likelyNoise, promoteCandidates, plausible };
}

// ── LLM invocation ───────────────────────────────────────────────────────

function parseModelRef(spec: string | undefined): { provider: string; id: string } | null {
  if (!spec) return null;
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx >= spec.length - 1) return null;
  return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

async function invokeResolver(
  fullPrompt: string,
  settings: SedimentSettings,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
): Promise<{ rawText: string; model: string; skipReason?: StagingResolverResult["skipped"] }> {
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

  const finalMsg = await auditStreamSimple(
    process.cwd(),
    { module: "sediment", operation: "staging_resolver", model_ref: modelSpec, prompt_chars: fullPrompt.length },
    piAi,
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
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    throw new Error(finalMsg.errorMessage || finalMsg.stopReason);
  }
  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!rawText) throw new Error("staging-resolver returned empty text");
  return { rawText, model: modelSpec };
}

// ── Main entry ───────────────────────────────────────────────────────────

export interface RunStagingResolverOptions {
  projectRoot: string;
  windowText?: string;
  settings: SedimentSettings;
  modelRegistry?: ModelRegistryLike;
  signal?: AbortSignal;
  sessionId?: string;
  minIntervalMs?: number;
  now?: Date;
}

export async function runStagingResolverIfDue(options: RunStagingResolverOptions): Promise<StagingResolverResult> {
  const t0 = Date.now();
  const now = options.now ?? new Date();
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const base: Omit<StagingResolverResult, "ok" | "durationMs"> = {
    reviewed_count: 0,
    likely_noise_slugs: [],
    plausible_count: 0,
    promote_candidates: [],
  };

  // 1. Debounce.
  const lastRunMs = readLastRunMs(options.projectRoot);
  if (lastRunMs !== null && now.getTime() - lastRunMs < minIntervalMs) {
    return { ok: true, skipped: "debounced", ...base, durationMs: Date.now() - t0 };
  }

  // 2. Candidates.
  const candidates = selectStagingCandidates(now);
  if (candidates.length === 0) {
    writeLastRun(options.projectRoot, now, "skipped");
    return { ok: true, skipped: "no_candidates", ...base, durationMs: Date.now() - t0 };
  }

  // 3. Model availability (don't write last_run on hard-unavailable so the
  //    next agent_end retries once a model is configured).
  if (!options.modelRegistry) {
    recordProvisionalLifecycleFailure(candidates.map((candidate) => candidate.file), "provider", "model_registry_available|resolver_due", now);
    refreshLifecycleConvergenceReadModel(now);
    return { ok: true, skipped: "model_registry_unavailable", ...base, reviewed_count: candidates.length, durationMs: Date.now() - t0 };
  }

  // 4. Lock (cede this run on contention; do NOT advance debounce).
  const lockClaim = tryAcquireLock(options.projectRoot, now);
  if (!lockClaim) {
    return { ok: true, skipped: "concurrent_run", ...base, reviewed_count: candidates.length, durationMs: Date.now() - t0 };
  }

  try {
    // 5. Build prompt + invoke LLM. buildResolverPrompt() reads the prompt
    // file from disk; a missing/unreadable prompt must DEGRADE, not throw out
    // of this fire-and-forget bg fn (deepseek R1 P0). So it lives INSIDE the
    // inner try whose catch writes last_run(degraded) + a ledger row.
    let rawText: string;
    let model: string;
    try {
      const prompt = buildResolverPrompt(candidates, options.windowText ?? "", now);
      const inv = await invokeResolver(prompt, options.settings, options.modelRegistry, options.signal);
      if (inv.skipReason) {
        // model_not_found / auth_unavailable are persistent misconfigs: write
        // last_run (debounce) + a breadcrumb so silent non-execution is
        // detectable (R1 opus/gpt P2) without scanning every single turn.
        writeLastRun(options.projectRoot, now, "skipped");
        appendLedgerRow({ op: "staging_resolve", ok: false, skipped: inv.skipReason, reviewed_count: candidates.length, model: inv.model, session_id: options.sessionId, prompt_version: STAGING_RESOLVER_PROMPT_VERSION });
        recordProvisionalLifecycleFailure(candidates.map((candidate) => candidate.file), "provider", "provider_or_auth_recovered|resolver_due", now);
        refreshLifecycleConvergenceReadModel(now);
        return { ok: true, skipped: inv.skipReason, ...base, reviewed_count: candidates.length, model: inv.model, durationMs: Date.now() - t0 };
      }
      rawText = inv.rawText;
      model = inv.model;
    } catch (e: unknown) {
      writeLastRun(options.projectRoot, now, "degraded");
      const error = e instanceof Error ? e.message : String(e);
      appendLedgerRow({ op: "staging_resolve", ok: false, degraded: true, reviewed_count: candidates.length, error: error.slice(0, 500), session_id: options.sessionId, prompt_version: STAGING_RESOLVER_PROMPT_VERSION });
      recordProvisionalLifecycleFailure(candidates.map((candidate) => candidate.file), "transient", "provider_or_transport_recovered|resolver_due", now);
      refreshLifecycleConvergenceReadModel(now);
      return { ok: false, degraded: true, ...base, reviewed_count: candidates.length, error: error.slice(0, 500), durationMs: Date.now() - t0 };
    }

    // 6. Parse (degraded → keep everything).
    let output: StagingResolverLlmOutput;
    try {
      output = parseStagingResolverOutput(rawText);
    } catch {
      writeLastRun(options.projectRoot, now, "degraded");
      appendLedgerRow({ op: "staging_resolve", ok: false, degraded: true, reviewed_count: candidates.length, error: "unparseable_llm_output", session_id: options.sessionId, prompt_version: STAGING_RESOLVER_PROMPT_VERSION });
      recordProvisionalLifecycleFailure(candidates.map((candidate) => candidate.file), "parse", "new_parseable_reviewer_output|resolver_due", now);
      refreshLifecycleConvergenceReadModel(now);
      return { ok: false, degraded: true, ...base, reviewed_count: candidates.length, model, durationMs: Date.now() - t0 };
    }

    // 7. Apply triage (non-destructive: annotate disposition; attribution_pending untouched).
    const { likelyNoise, promoteCandidates, plausible } = applyResolverDecisions(candidates, output, now);

    writeLastRun(options.projectRoot, now, "ok");
    appendLedgerRow({
      op: "staging_resolve",
      ok: true,
      reviewed_count: candidates.length,
      likely_noise_count: likelyNoise.length,
      plausible_count: plausible,
      promote_candidate_count: promoteCandidates.length,
      likely_noise_slugs: likelyNoise,
      promote_candidates: promoteCandidates,
      model,
      session_id: options.sessionId,
      prompt_version: STAGING_RESOLVER_PROMPT_VERSION,
    });
    refreshLifecycleConvergenceReadModel(now);
    return {
      ok: true,
      reviewed_count: candidates.length,
      likely_noise_slugs: likelyNoise,
      plausible_count: plausible,
      promote_candidates: promoteCandidates,
      model,
      durationMs: Date.now() - t0,
    };
  } finally {
    releaseLock(options.projectRoot, lockClaim);
  }
}
