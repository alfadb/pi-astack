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
   *  candidates, no model registry). */
  skipped?: "debounced" | "no_candidates" | "model_registry_unavailable" | "auth_unavailable" | "model_not_found";
  /** Set on degraded fallback: LLM call or parse failed. */
  degraded?: boolean;
  degraded_reason?: string;
  reviewed_count: number;
  decisions: ArchiveReactivationEntryDecision[];
  reactivated_slugs: string[];
  llm_duration_ms?: number;
  llm_model?: string;
  duration_ms: number;
}

// ── Path helpers ──────────────────────────────────────────────────────

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
 *  Excess entries roll into the next debounced run. */
const MAX_ENTRIES_PER_RUN = 20;

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

interface PromptBuildResult {
  fullPrompt: string;
  reviewed: MemoryEntry[];
}

function buildReviewerPrompt(
  archivedEntries: MemoryEntry[],
  windowText: string,
  now: Date,
): PromptBuildResult {
  // Order by archive_at descending (newest first) so the oldest entries
  // — which are the candidates for hard_archive_recommended — appear
  // last in the input. Tail-of-input placement is intentional: the
  // reviewer is asked to default-conservative, and entries that look
  // most relevant to the window (recent archives that the user may
  // still be tracking) get prioritized attention.
  const sorted = [...archivedEntries].sort((a, b) => {
    const aMs = Date.parse(entryArchiveAt(a) ?? "") || 0;
    const bMs = Date.parse(entryArchiveAt(b) ?? "") || 0;
    return bMs - aMs;
  });

  const reviewed = sorted.slice(0, MAX_ENTRIES_PER_RUN);

  const inputBlocks = reviewed.map((entry) => {
    const archiveAt = entryArchiveAt(entry);
    const age = ageDays(archiveAt, now);
    return [
      `## ${entry.slug}`,
      `kind: ${entry.kind} | scope: ${entry.scope} | confidence: ${entry.confidence}`,
      `archive_at: ${archiveAt ?? "(missing — treat age as 0)"}`,
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
    const decision: ArchiveReactivationDecision = VALID_DECISIONS.has(decisionRaw as ArchiveReactivationDecision)
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
  } = await import("@earendil-works/pi-ai");

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
   *  reference because circular import — caller injects the closure. */
  reactivateEntry?: (slug: string, rationale: string) => Promise<{ ok: boolean; error?: string }>;
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

  // Sanitize the conversation window once (the prompt template + entry
  // content is author-controlled).
  const sanitized = sanitizeForMemory(options.windowText);
  const windowText = sanitized.ok ? (sanitized.text ?? options.windowText) : `[redacted: ${sanitized.error}]`;

  const { fullPrompt, reviewed } = buildReviewerPrompt(
    options.archivedEntries,
    windowText,
    now,
  );

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

  // Apply reactivate decisions.
  const reactivatedSlugs: string[] = [];
  for (const d of completeDecisions) {
    if (d.decision !== "reactivate") continue;
    if (!options.reactivateEntry) continue;
    try {
      const r = await options.reactivateEntry(d.slug, d.rationale);
      if (r.ok) reactivatedSlugs.push(d.slug);
      // Audit the application result on ledger.
      appendLedgerRow({
        ts: formatLocalIsoTimestamp(now),
        project_root: path.resolve(options.projectRoot),
        ...(options.sessionId ? { session_id_local: options.sessionId } : {}),
        operation: "archive_reactivation_apply",
        slug: d.slug,
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
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Write one ledger row per decision (independent of apply outcome).
  for (const d of completeDecisions) {
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

  writeLastRun(options.projectRoot, now, "ok");
  return {
    ok: true,
    reviewed_count: reviewed.length,
    decisions: completeDecisions,
    reactivated_slugs: reactivatedSlugs,
    llm_duration_ms: llmDurationMs,
    llm_model: model,
    duration_ms: Date.now() - t0,
  };
}
