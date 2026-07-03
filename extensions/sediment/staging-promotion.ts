/**
 * staging-promotion — ADR 0025 §4.1.5 Stage 5 follow-up:
 * multi-view gated promotion of `promote_candidate` staging entries to
 * durable memory entries.
 *
 * A single LLM (resolver or age-out reviewer) CANNOT promote a provisional
 * staging hypothesis to durable memory — ADR 0025 §3.1 A' layer / §4.4
 * requires multi-view verification for any non-trivial durable write. This
 * executor picks up the advisory `promote_candidate` flags set by
 * staging-resolver and staging-ageout and runs them through the SAME
 * runMultiView gate + executeCuratorDecisionToBrain writer used by the
 * multi-view staging replay path.
 *
 * Design invariants:
 *   - NON-DESTRUCTIVE: a staging file is NEVER unlinked. Outcomes are
 *     recorded on the entry (promotion_outcome, promoted_at, etc.).
 *   - DEDUP before write: exact slug + quote containment + Jaccard similarity
 *     against existing durable entries. Duplicates are marked
 *     `promotion_outcome: duplicate` and `attribution_pending: false`.
 *   - Debounce: an entry with `promotion_attempted_at` within 14 days is
 *     skipped so transient failures / rejected candidates are not re-promoted
 *     every agent_end.
 *   - Default off: controlled by `settings.stagingPromotionEnabled`; the
 *     executor also respects `autoLlmWriteEnabled` (false/staging-only means
 *     no durable writes, so promotion is skipped).
 *   - Idempotent: a successfully promoted entry has `attribution_pending`
 *     flipped to false; re-runs ignore it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { slugify } from "../memory/utils";
import { scanStore } from "../memory/parser";
import { DEFAULT_SETTINGS as DEFAULT_MEMORY_SETTINGS } from "../memory/settings";
import type { MemoryEntry } from "../memory/types";
import type { CuratorDecision } from "./curator";
import { runMultiView, type MultiViewResult } from "./multi-view";
import { detectProjectDuplicate, type DedupeMatch } from "./dedupe";
import { executeCuratorDecisionToBrain } from "./curator-decision-writer";
import type { ProjectEntryDraft, WriteProjectEntryResult } from "./writer";
import { listRulesInScope } from "./writer";
import type { SedimentSettings } from "./settings";
import type { CorrectionSignal } from "./correction-pipeline";
import type { StagingEntry, StagingFileOnDisk } from "./staging-types";
import { stagingDir } from "./staging-loader";
import { loadMultiviewPending } from "./multiview-staging-io";
import {
  abrainKnowledgeDir,
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";

export const STAGING_PROMOTION_PROMPT_VERSION = "v1";

// ── Tunables ──────────────────────────────────────────────────────────

/** Promotion is expensive (multi-view + durable write); daily cadence
 *  matches the archive-reactivation / age-out cost envelope. */
const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Oldest-first cap per run; excess rolls into the next debounced run. */
const MAX_PROMOTE_PER_RUN = 3;
/** Don't re-attempt a rejected / transiently-failed promotion within this
 *  many days. Spec is 14 days — not 4 weeks; reviewers sometimes misread
 *  the unit. */
const PROMOTION_ATTEMPT_DEBOUNCE_DAYS = 14;
/** Advisory lock stale window. */
const LOCK_STALE_MS = 30 * 60 * 1000;
/** Jaccard threshold for near-duplicate body detection. Mirrors the
 *  conservative writer-side rule semantic dedup threshold family. */
const SEMANTIC_SIMILARITY_THRESHOLD = 0.75;
/** FIX-3a: short source quotes ("use yarn") must not be treated as
 *  contained duplicates; require at least this many normalized chars. */
const QUOTE_CONTAINMENT_MIN_CHARS = 40;
/** Cap compiledTruth so the reviewer prompt stays bounded. */
const MAX_COMPILED_TRUTH_CHARS = 8000;
const MAX_PROMOTION_SLUG_CHARS = 80;
const MAX_PROMOTION_TITLE_CHARS = 120;

// ── Types ───────────────────────────────────────────────────────────────

export interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export interface StagingPromotionResult {
  ok: boolean;
  skipped?:
    | "disabled"
    | "debounced"
    | "no_candidates"
    | "model_registry_unavailable"
    | "concurrent_run";
  degraded?: boolean;
  reviewed_count: number;
  promoted_slugs: string[];
  promoted_to_slugs: string[];
  rejected_slugs: string[];
  duplicate_slugs: string[];
  staged_for_replay_slugs: string[];
  model?: string;
  durationMs: number;
  error?: string;
}

interface PromotionCandidate {
  file: string; // absolute path
  entry: StagingEntry;
}

interface PromotionSelectionContext {
  projectRoot?: string;
  projectId?: string;
  abrainHome?: string;
}

export interface DuplicateCheckResult {
  duplicate: boolean;
  reason?: "exact_slug" | "quote_contained" | "jaccard_similar";
  match?: DedupeMatch | { slug: string; title: string; kind: string; status: string; source_path: string };
  score?: number;
}

// ── Sidecar paths (per-project last-run debounce; user-global lock + ledger) ─────

export function stagingPromotionLastRunPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack", "sediment", "staging-promotion-last-run.json");
}

export function stagingPromotionLockPath(): string {
  // FIX-2c: the promotion queue is user-global (all projects share one
  // staging/ dir under ~/.abrain/.state/), so the advisory lock must be
  // global too. Project-scoped locks allowed two projects to drain the
  // same queue concurrently.
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "staging-promotion.lock");
}

export function stagingPromotionLedgerPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "staging-promotion-ledger.jsonl");
}

function readLastRunMs(projectRoot: string): number | null {
  try {
    const file = stagingPromotionLastRunPath(projectRoot);
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
    const file = stagingPromotionLastRunPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ last_run_ts: formatLocalIsoTimestamp(now), status }, null, 2) + "\n", "utf-8");
  } catch {
    /* best-effort: missing last_run only means next agent_end retries sooner */
  }
}

function appendLedgerRow(row: Record<string, unknown>): void {
  try {
    const file = stagingPromotionLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const enriched = { ...spreadAnchor(getCurrentAnchor()), ...row };
    fs.appendFileSync(file, JSON.stringify(enriched) + "\n", "utf-8");
  } catch {
    /* observability — never throw out of agent_end bg */
  }
}

// ── Minimal advisory lock ───────────────────────────────────────────────

interface StagingPromotionLockClaim {
  pid: number;
  host: string;
  started_at: string;
  nonce: string;
}

function parseLockClaim(raw: string): StagingPromotionLockClaim | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StagingPromotionLockClaim>;
    if (!parsed || typeof parsed !== "object") return null;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.started_at !== "string" ||
      typeof parsed.nonce !== "string"
    ) {
      return null;
    }
    return { pid: parsed.pid, host: parsed.host, started_at: parsed.started_at, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

function claimsMatch(a: StagingPromotionLockClaim, b: StagingPromotionLockClaim): boolean {
  return a.pid === b.pid && a.host === b.host && a.started_at === b.started_at && a.nonce === b.nonce;
}

function tryAcquireLock(now: Date): StagingPromotionLockClaim | null {
  const file = stagingPromotionLockPath();
  const claim: StagingPromotionLockClaim = {
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

function releaseLock(claim: StagingPromotionLockClaim | null): void {
  if (!claim) return;
  try {
    const file = stagingPromotionLockPath();
    const current = parseLockClaim(fs.readFileSync(file, "utf-8"));
    if (!current || !claimsMatch(current, claim)) return;
    fs.unlinkSync(file);
  } catch { /* best-effort */ }
}

// ── Candidate selection ─────────────────────────────────────────────────

async function entryMatchesPromotionProject(entry: StagingEntry, ctx?: PromotionSelectionContext): Promise<boolean> {
  if (!ctx) return true;
  const currentRoot = ctx.projectRoot ? path.resolve(ctx.projectRoot) : undefined;
  const currentId = ctx.projectId;

  // FIX-2b: explicit origin takes precedence.
  if (entry.origin_project_id || entry.origin_project_root) {
    const rootMatch = currentRoot && entry.origin_project_root
      ? path.resolve(entry.origin_project_root) === currentRoot
      : false;
    const idMatch = currentId && entry.origin_project_id
      ? entry.origin_project_id === currentId
      : false;
    return Boolean(rootMatch || idMatch);
  }

  // Legacy entry without origin: only claim it if its target slug exists in
  // the current project's durable store. Legacy entries with neither origin
  // nor target_entry_slug are unowned residue and are skipped by every project
  // until an explicit backfill claims them.
  const targetSlug = entry.correction_signal?.target_entry_slug;
  if (!targetSlug || !ctx.abrainHome || !currentId) return false;
  const scanRoot = path.join(ctx.abrainHome, "projects", currentId);
  const dup = await detectProjectDuplicate(scanRoot, "", { slug: targetSlug });
  return dup.duplicate;
}

/** Load promote-candidate staging entries (oldest first, capped).
 *  Selects: provisional-correction, attribution_pending=true,
 *  (resolver_disposition=promote_candidate OR aged_out_decision=promote_candidate),
 *  NOT soft_archived, NOT attempted within the debounce window,
 *  and (FIX-2) only entries that belong to the current project.
 *
 *  Ownership rules (when ctx is provided):
 *    - explicit origin_project_id/root matching current project → select;
 *    - no origin but target_entry_slug resolves in current project store →
 *      select (legacy back-compat);
 *    - no origin AND no target_entry_slug → permanently skip in every
 *      project until a backfill claims it (unowned legacy residue);
 *    - otherwise → leave in the global pool for its owning project.
 *  FIX-6: also skip any entry whose slug is referenced by an existing
 *  multiview-pending replay file (source_staging_slug), because the A'
 *  replay lane owns the candidate until that file resolves.
 */
export async function selectPromoteCandidates(
  now: Date = new Date(),
  max: number = MAX_PROMOTE_PER_RUN,
  ctx?: PromotionSelectionContext,
): Promise<PromotionCandidate[]> {
  const out: PromotionCandidate[] = [];
  const debounceCutoff = now.getTime() - PROMOTION_ATTEMPT_DEBOUNCE_DAYS * 24 * 60 * 60 * 1000;
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

  // FIX-6: any provisional entry that already has a multiview-pending replay
  // twin is owned by the A' replay lane until that twin resolves.
  let pendingSourceSlugs: Set<string> | undefined;
  try {
    pendingSourceSlugs = new Set(
      loadMultiviewPending()
        .entries
        .map((e) => e.source_staging_slug)
        .filter((s): s is string => !!s),
    );
  } catch {
    pendingSourceSlugs = new Set();
  }

  const seenSlugs = new Set<string>();

  for (const f of files) {
    if (out.length >= max) break;
    const abs = path.join(dir, f);
    try {
      const parsed: StagingFileOnDisk = JSON.parse(fs.readFileSync(abs, "utf-8"));
      const entry = parsed?.entry;
      if (!entry || entry.kind !== "provisional-correction") continue;
      if (entry.attribution_pending !== true) continue;
      if (entry.lifecycle_state === "soft_archived") continue;
      const isPromoteCandidate =
        entry.resolver_disposition === "promote_candidate" ||
        entry.aged_out_decision === "promote_candidate";
      if (!isPromoteCandidate) continue;
      if (entry.promotion_attempted_at) {
        const attempted = Date.parse(entry.promotion_attempted_at);
        if (Number.isFinite(attempted) && attempted >= debounceCutoff) continue;
      }
      if (pendingSourceSlugs?.has(entry.slug)) continue;

      if (!await entryMatchesPromotionProject(entry, ctx)) continue;
      if (seenSlugs.has(entry.slug)) continue;
      seenSlugs.add(entry.slug);

      out.push({ file: abs, entry });
    } catch {
      /* corrupted file — skip */
    }
  }
  return out;
}

async function findPromotionClusterSiblings(
  representative: PromotionCandidate,
  ctx?: PromotionSelectionContext,
): Promise<PromotionCandidate[]> {
  const out: PromotionCandidate[] = [];
  let dir: string;
  try {
    dir = stagingDir();
    if (!fs.existsSync(dir)) return out;
  } catch {
    return out;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return out;
  }

  for (const f of files) {
    const abs = path.join(dir, f);
    if (abs === representative.file) continue;
    try {
      const parsed: StagingFileOnDisk = JSON.parse(fs.readFileSync(abs, "utf-8"));
      const entry = parsed?.entry;
      if (!entry || entry.slug !== representative.entry.slug) continue;
      if (entry.kind !== "provisional-correction") continue;
      if (entry.attribution_pending !== true) continue;
      if (entry.lifecycle_state === "soft_archived") continue;
      const isPromoteCandidate =
        entry.resolver_disposition === "promote_candidate" ||
        entry.aged_out_decision === "promote_candidate";
      if (!isPromoteCandidate) continue;
      if (!await entryMatchesPromotionProject(entry, ctx)) continue;
      out.push({ file: abs, entry });
    } catch {
      /* corrupted sibling file — skip */
    }
  }
  return out;
}

// ── Draft reconstruction from staging entry ─────────────────────────────

export type PromotionIdentity =
  | { ok: true; slug: string; title: string; source: "explicit" | "fallback" }
  | { ok: false; reason: "invalid_slug_candidate" };

function asciiSlugify80(input: string): string {
  return String(input || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_PROMOTION_SLUG_CHARS)
    .replace(/-+$/g, "");
}

function looksLikeMetaSlug(slug: string): boolean {
  const parts = slug.split("-").filter(Boolean);
  if (parts.length === 0) return true;
  if (slug === "slug" || slug === "durable-entry" || slug === "memory-entry") return true;
  if (/^(an?|the)-entry-(capturing|describing|recording)/.test(slug)) return true;
  if (/^(need|needs|needed|requires|required)-/.test(slug)) return true;
  if (/^(an?|the)-durable-(entry|memory)-/.test(slug)) return true;
  if (/^(remember|capture|record)-that-/.test(slug)) return true;
  if (parts.length > 12 && /(?:^|-)(entry|capturing|describing|principle|that|should|must)(?:-|$)/.test(slug)) return true;
  return false;
}

function isValidPromotionSlug(slug: string): boolean {
  return slug.length > 0 &&
    slug.length <= MAX_PROMOTION_SLUG_CHARS &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    !looksLikeMetaSlug(slug);
}

function titleFromPromotionSlug(slug: string): string {
  const title = slug
    .split("-")
    .filter(Boolean)
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ")
    .trim();
  return title.slice(0, MAX_PROMOTION_TITLE_CHARS) || "Provisional staging candidate";
}

function cleanMetaRequestText(raw: string): string {
  let text = String(raw || "").trim();
  const labeled = text.match(/(?:描述|原则|内容|description|principle|body)\s*[:：]\s*([\s\S]+)$/i);
  if (labeled?.[1]?.trim()) text = labeled[1].trim();
  text = text
    .replace(/slug\s*(?:可能为|可为|如|为|建议为|may be|could be|should be|suggest(?:ed|ion)?(?:\s+is)?)?\s*[:：]?\s*[`"'“‘][A-Za-z0-9][A-Za-z0-9_-]{2,120}[`"'”’]/giu, "")
    .replace(/slug\s*(?:可能为|可为|如|为|建议为|may be|could be|should be|suggest(?:ed|ion)?(?:\s+is)?)?\s*[:：]?\s*[A-Za-z0-9][A-Za-z0-9_-]{2,120}/giu, "")
    .replace(/[`"“”‘’]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^(需要一个|需要一条|请创建一条|请记录一条|an entry capturing|an entry describing|a durable entry capturing|a durable memory capturing)\s*/i, "").trim();
  return text;
}

function extractExplicitSlugSuggestion(entry: StagingEntry): string | null {
  const texts = [
    entry.hypothesis,
    entry.correction_signal?.scope_description,
    entry.correction_signal?.correction_intent,
    ...((entry.source_utterance ?? []).map((u) => u.quote)),
    ...(entry.suggested_resolution_paths ?? []),
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  const patterns = [
    /slug\s*(?:可能为|可为|如|为|建议为|may be|could be|should be|suggest(?:ed|ion)?(?:\s+is)?)?\s*[:：]?\s*[`"'“‘]([A-Za-z0-9][A-Za-z0-9_-]{2,120})[`"'”’]/iu,
    /slug\s*(?:可能为|可为|如|为|建议为|may be|could be|should be|suggest(?:ed|ion)?(?:\s+is)?)\s+([A-Za-z0-9][A-Za-z0-9_-]{2,120})/iu,
    /slug\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9_-]{2,120})/iu,
  ];

  for (const text of texts) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match?.[1]) continue;
      const slug = asciiSlugify80(match[1]);
      if (isValidPromotionSlug(slug)) return slug;
    }
    for (const match of text.matchAll(/`([A-Za-z0-9][A-Za-z0-9_-]{2,120})`/g)) {
      const slug = asciiSlugify80(match[1]);
      if (isValidPromotionSlug(slug)) return slug;
    }
  }
  return null;
}

function fallbackSlugSeed(entry: StagingEntry): string {
  const candidates = [
    cleanMetaRequestText(entry.hypothesis ?? ""),
    entry.correction_signal?.scope_description,
    entry.correction_signal?.correction_intent,
    entry.source_utterance?.[0]?.quote,
  ];
  return candidates.find((s) => typeof s === "string" && s.trim().length > 0)?.trim() ?? "";
}

function resolvePromotionIdentity(entry: StagingEntry): PromotionIdentity {
  const explicitSlug = extractExplicitSlugSuggestion(entry);
  if (explicitSlug) {
    return { ok: true, slug: explicitSlug, title: titleFromPromotionSlug(explicitSlug), source: "explicit" };
  }

  const seed = fallbackSlugSeed(entry);
  const slug = asciiSlugify80(seed);
  if (!isValidPromotionSlug(slug)) return { ok: false, reason: "invalid_slug_candidate" };
  const titleSeed = cleanMetaRequestText(seed);
  const title = titleSeed && asciiSlugify80(titleSeed) === slug
    ? titleSeed.slice(0, MAX_PROMOTION_TITLE_CHARS)
    : titleFromPromotionSlug(slug);
  return { ok: true, slug, title: title.trim() || titleFromPromotionSlug(slug), source: "fallback" };
}

function canonicalPromotedSlug(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const slug = asciiSlugify80(raw);
  return isValidPromotionSlug(slug) ? slug : fallback;
}

/** Rebuild a ProjectEntryDraft from a provisional-correction staging entry.
 *  This is the analog of multiview-staging-replay's `draftFromSnapshot`,
 *  adapted to the different shape of a classifier staging entry. */
export function buildDraftFromStagingEntry(entry: StagingEntry, identity: PromotionIdentity = resolvePromotionIdentity(entry)): ProjectEntryDraft {
  const cs = entry.correction_signal;
  const quote = entry.source_utterance?.[0]?.quote ?? "";
  const title = identity.ok ? identity.title : "Provisional staging candidate";
  const hypothesis = cleanMetaRequestText(entry.hypothesis ?? "") || entry.hypothesis || "";

  const bodyParts: string[] = [hypothesis];
  if (quote) {
    bodyParts.push("", `Source quote: "${quote}"`);
  }
  if (cs?.correction_intent) {
    bodyParts.push(`Intent: ${cs.correction_intent}`);
  }
  if (cs?.scope_description) {
    bodyParts.push(`Scope: ${cs.scope_description}`);
  }
  let compiledTruth = bodyParts.join("\n").trim();
  if (compiledTruth.length > MAX_COMPILED_TRUTH_CHARS) {
    compiledTruth = compiledTruth.slice(0, MAX_COMPILED_TRUTH_CHARS) + "…";
  }

  const triggerPhrases = (entry.source_utterance ?? [])
    .map((u) => u.quote)
    .filter(Boolean)
    .slice(0, 5);

  const draft: ProjectEntryDraft = {
    title,
    kind: "fact",
    compiledTruth,
    status: "active",
    // FIX-7a: default to the same neutral confidence the classifier uses
    // for uncertain signals; FIX-1 forces multi-view review regardless.
    confidence: cs?.confidence ?? 5,
    // AX-PROVENANCE: staging promotion is a meta-curator path, not a direct
    // user attestation; mark as assistant-observed so downstream provenance
    // consumers do not treat a promoted classifier guess as user-expressed.
    provenance: "assistant-observed",
    ...(triggerPhrases.length > 0 ? { triggerPhrases } : {}),
    timelineNote: `Promoted from staging ${entry.slug} via multi-view gate`,
  };
  return draft;
}

/** Build the proposer CuratorDecision that represents what the staging
 *  entry is asking for. Non-directive durable signals become a knowledge
 *  create; directive-shaped signals become a rules-zone create so the
 *  multi-view trigger sees the high-blast-radius zone. */
export function buildProposerDecisionFromStagingEntry(entry: StagingEntry): CuratorDecision {
  const cs = entry.correction_signal;
  const rationale = `Staging promotion candidate ${entry.slug}: ${entry.hypothesis ?? ""}`;
  if (cs?.is_directive === true) {
    return {
      op: "create",
      zone: "rules",
      injectMode: "listed",
      ruleScope: "project",
      rationale,
      ...(cs?.target_entry_slug ? { derives_from: [cs.target_entry_slug] } : {}),
    };
  }
  return {
    op: "create",
    rationale,
    ...(cs?.target_entry_slug ? { derives_from: [cs.target_entry_slug] } : {}),
  };
}

// ── Neighbor loading (best-effort context) ──────────────────────────────

async function loadPromotionNeighbors(entry: StagingEntry, projectRoot: string): Promise<MemoryEntry[]> {
  const targetSlug = entry.correction_signal?.target_entry_slug as string | undefined;
  if (!targetSlug) return [];
  try {
    const memSettings = (await import("../memory/settings")).resolveSettings();
    const all = await (await import("../memory/parser")).loadEntries(projectRoot, memSettings, undefined);
    const target = all.find((e: MemoryEntry) => e.slug === targetSlug);
    return target ? [target] : [];
  } catch {
    return [];
  }
}

// ── Duplicate detection ─────────────────────────────────────────────────

function normalizeDedupText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  const tokens = normalizeDedupText(text)
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return new Set(tokens);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

interface DedupeEntry {
  slug: string;
  title: string;
  kind: string;
  status: string;
  source_path: string;
  compiledTruth: string;
}

function toDedupeEntry(e: MemoryEntry): DedupeEntry {
  return {
    slug: e.slug,
    title: e.title,
    kind: e.kind,
    status: e.status,
    source_path: e.displayPath,
    compiledTruth: e.compiledTruth,
  };
}

function correctionSignalFromStaging(entry: StagingEntry): CorrectionSignal | null {
  if (!entry.correction_signal) return null;
  const { is_directive, quote_multi_match, quote_matched_roles, ...rest } = entry.correction_signal;
  return {
    ...rest,
    ...(typeof is_directive === "boolean" ? { is_directive } : {}),
    ...(typeof quote_multi_match === "boolean" ? { quote_multi_match } : {}),
    ...(Array.isArray(quote_matched_roles) ? { quote_matched_roles } : {}),
  };
}

/** Collect active durable entries from current L1/L2 projections:
 *  project knowledge, global knowledge, global rules, and project rules. */
async function loadPromotionDedupeCorpus(
  abrainHome: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<DedupeEntry[]> {
  const out: DedupeEntry[] = [];

  try {
    const projectRoot = path.join(abrainHome, "projects", projectId);
    const projectEntries = await scanStore(
      { scope: "project", root: projectRoot, label: "project" },
      projectRoot,
      DEFAULT_MEMORY_SETTINGS,
      signal,
    );
    out.push(...projectEntries.filter((e) => e.status === "active").map(toDedupeEntry));
  } catch {
    /* best-effort */
  }

  try {
    const worldRoot = abrainKnowledgeDir(abrainHome);
    const worldEntries = await scanStore(
      { scope: "world", root: worldRoot, label: "world" },
      worldRoot,
      DEFAULT_MEMORY_SETTINGS,
      signal,
    );
    out.push(...worldEntries.filter((e) => e.status === "active").map(toDedupeEntry));
  } catch {
    /* best-effort */
  }

  try {
    for (const r of listRulesInScope(abrainHome, "global", undefined)) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      out.push({
        slug: r.slug,
        title: r.title,
        kind: "rule",
        status: "active",
        source_path: r.body.slice(0, 200),
        compiledTruth: r.body,
      });
    }
  } catch {
    /* best-effort */
  }

  try {
    for (const r of listRulesInScope(abrainHome, "project", projectId)) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      out.push({
        slug: r.slug,
        title: r.title,
        kind: "rule",
        status: "active",
        source_path: r.body.slice(0, 200),
        compiledTruth: r.body,
      });
    }
  } catch {
    /* best-effort */
  }

  return out;
}

/** Check whether the candidate is already represented by an existing durable
 *  entry. Uses the same storage-level exact-slug guard as the writer plus a
 *  deterministic semantic scan (quote containment + Jaccard) over current
 *  L1/L2 projections: project knowledge, global knowledge, and rules zones. */
export async function findSemanticDuplicate(
  entry: StagingEntry,
  draft: ProjectEntryDraft,
  abrainHome: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<DuplicateCheckResult> {
  const scanRoot = path.join(abrainHome, "projects", projectId);

  // 1. Exact slug collision (same deterministic guard the writer uses).
  const slug = slugify(draft.title);
  const exact = await detectProjectDuplicate(scanRoot, draft.title, { slug, signal });
  if (exact.duplicate && exact.match) {
    return { duplicate: true, reason: "exact_slug", match: exact.match };
  }

  // 2. Semantic scan over active durable entries across all relevant zones.
  try {
    const entries = await loadPromotionDedupeCorpus(abrainHome, projectId, signal);
    const draftNorm = normalizeDedupText(draft.compiledTruth);

    for (const e of entries) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");

      // Quote containment: if any source utterance is already verbatim
      // represented in an active entry, treat as duplicate — but only for
      // quotes long enough to be meaningfully unique (FIX-3a).
      for (const q of entry.source_utterance ?? []) {
        if (!q.quote) continue;
        const qNorm = normalizeDedupText(q.quote);
        if (qNorm.length < QUOTE_CONTAINMENT_MIN_CHARS) continue;
        if (normalizeDedupText(e.compiledTruth).includes(qNorm)) {
          return {
            duplicate: true,
            reason: "quote_contained",
            match: {
              slug: e.slug,
              title: e.title,
              kind: e.kind,
              status: e.status,
              source_path: e.source_path,
            },
          };
        }
      }

      // Jaccard near-duplicate on compiledTruth.
      const sim = jaccardSimilarity(draft.compiledTruth, e.compiledTruth);
      if (sim >= SEMANTIC_SIMILARITY_THRESHOLD) {
        return {
          duplicate: true,
          reason: "jaccard_similar",
          score: Math.round(sim * 100) / 100,
          match: {
            slug: e.slug,
            title: e.title,
            kind: e.kind,
            status: e.status,
            source_path: e.source_path,
          },
        };
      }
    }
  } catch {
    // Best-effort: a failed scan must NOT block promotion (data loss is
    // worse than a possible duplicate, and the writer's exact-slug gate is
    // the final backstop).
  }

  return { duplicate: false };
}

// ── Atomic staging-file write ───────────────────────────────────────────

function writeStagingFileAtomic(file: string, entry: StagingEntry): void {
  const payload: StagingFileOnDisk = { schema_version: 1, entry };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** Apply the promotion outcome to the staging entry on disk.
 *  FIX-4: re-read the on-disk file and merge only promotion-related
 *  fields so concurrent resolver/age-out writes in the same window are
 *  not clobbered by this lane's stale snapshot.
 *  FIX-7c: the timestamp is taken at write time, not at the run start. */
export function applyPromotionOutcome(
  file: string,
  _entry: StagingEntry,
  _now: Date,
  outcome: "duplicate" | "promoted" | "rejected" | "error" | "staged_for_replay" | "cluster_sibling" | "sibling_deferred",
  promotedToSlug?: string,
  promotionRationale?: string,
): void {
  let latest: StagingEntry;
  try {
    const parsed: StagingFileOnDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    latest = parsed.entry;
  } catch {
    // If re-read fails, fall back to the in-memory snapshot so we still
    // record an outcome rather than silently dropping it.
    latest = _entry;
  }

  const tsNow = new Date();
  latest.promotion_attempted_at = formatLocalIsoTimestamp(tsNow);
  latest.promotion_outcome = outcome;
  if (promotionRationale) {
    latest.promotion_rationale = promotionRationale;
  }
  if (outcome === "promoted") {
    latest.attribution_pending = false;
    latest.promoted_at = formatLocalIsoTimestamp(tsNow);
    if (promotedToSlug) latest.promoted_to_slug = promotedToSlug;
  } else if (outcome === "duplicate" || outcome === "cluster_sibling") {
    latest.attribution_pending = false;
    if (promotedToSlug) latest.promoted_to_slug = promotedToSlug;
  } else if (outcome === "sibling_deferred") {
    latest.attribution_pending = true;
  }
  writeStagingFileAtomic(file, latest);
}

async function markClusterSiblings(
  representative: PromotionCandidate,
  now: Date,
  representativeOutcome: "duplicate" | "promoted" | "rejected" | "error" | "staged_for_replay",
  promotedToSlug: string | undefined,
  ctx: PromotionSelectionContext,
): Promise<boolean> {
  const siblings = await findPromotionClusterSiblings(representative, ctx);
  let ok = true;
  for (const sibling of siblings) {
    try {
      if (representativeOutcome === "promoted" || representativeOutcome === "duplicate") {
        applyPromotionOutcome(
          sibling.file,
          sibling.entry,
          now,
          "cluster_sibling",
          promotedToSlug,
          `cluster_sibling:${representative.entry.slug} representative_outcome=${representativeOutcome}`,
        );
      } else {
        applyPromotionOutcome(
          sibling.file,
          sibling.entry,
          now,
          "sibling_deferred",
          undefined,
          `sibling_deferred:${representative.entry.slug} representative_outcome=${representativeOutcome}`,
        );
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

// ── Multi-view + brain-write dispatch ───────────────────────────────────

export interface RunStagingPromotionOptions {
  projectRoot: string;
  abrainHome: string;
  projectId: string;
  settings: SedimentSettings;
  modelRegistry?: ModelRegistryLike;
  signal?: AbortSignal;
  sessionId?: string;
  minIntervalMs?: number;
  now?: Date;
  /** Test injection: replace the real multi-view reviewer. */
  runMultiView?: (args: Parameters<typeof runMultiView>[0]) => Promise<MultiViewResult>;
  /** Test injection: replace the real durable writer. Should return the
   *  written slug on success or throw on failure. */
  writeApprovedToBrain?: (decision: CuratorDecision, candidate: ProjectEntryDraft) => Promise<string>;
}

export async function runStagingPromotionIfDue(options: RunStagingPromotionOptions): Promise<StagingPromotionResult> {
  const t0 = Date.now();
  const now = options.now ?? new Date();
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const base: Omit<StagingPromotionResult, "ok" | "durationMs"> = {
    reviewed_count: 0,
    promoted_slugs: [],
    promoted_to_slugs: [],
    rejected_slugs: [],
    duplicate_slugs: [],
    staged_for_replay_slugs: [],
  };

  // Master kill switch.
  if (!options.settings.stagingPromotionEnabled) {
    return { ok: true, skipped: "disabled", ...base, durationMs: Date.now() - t0 };
  }

  // Respect the durable-write tristate: false / "staging-only" means no
  // durable brain writes, so promotion must not run.
  if (options.settings.autoLlmWriteEnabled !== true) {
    return { ok: true, skipped: "disabled", ...base, durationMs: Date.now() - t0 };
  }

  // 1. Debounce.
  const lastRunMs = readLastRunMs(options.projectRoot);
  if (lastRunMs !== null && now.getTime() - lastRunMs < minIntervalMs) {
    return { ok: true, skipped: "debounced", ...base, durationMs: Date.now() - t0 };
  }

  // 2. Candidates (FIX-2: project-attributed only; FIX-6: skip entries
  //    with an active multiview-pending replay twin).
  const promotionCtx: PromotionSelectionContext = {
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    abrainHome: options.abrainHome,
  };
  const candidates = await selectPromoteCandidates(now, MAX_PROMOTE_PER_RUN, promotionCtx);
  if (candidates.length === 0) {
    writeLastRun(options.projectRoot, now, "skipped");
    return { ok: true, skipped: "no_candidates", ...base, durationMs: Date.now() - t0 };
  }

  // 3. Model availability (don't write last_run on hard-unavailable so the
  //    next agent_end retries once a model is configured).
  if (!options.modelRegistry) {
    return { ok: true, skipped: "model_registry_unavailable", ...base, reviewed_count: candidates.length, durationMs: Date.now() - t0 };
  }

  // 4. Lock (FIX-2c: user-global because the queue is user-global).
  const lockClaim = tryAcquireLock(now);
  if (!lockClaim) {
    return { ok: true, skipped: "concurrent_run", ...base, reviewed_count: candidates.length, durationMs: Date.now() - t0 };
  }

  const result: StagingPromotionResult = { ok: true, ...base, durationMs: 0 };
  let degraded = false;

  try {
    for (const candidate of candidates) {
      if (options.signal?.aborted) break;
      result.reviewed_count++;
      const entry = candidate.entry;
      const identity = resolvePromotionIdentity(entry);
      if (!identity.ok) {
        degraded = true;
        try {
          applyPromotionOutcome(candidate.file, entry, now, "error", undefined, identity.reason);
          if (!await markClusterSiblings(candidate, now, "error", undefined, promotionCtx)) degraded = true;
          result.rejected_slugs.push(entry.slug);
        } catch {
          degraded = true;
        }
        continue;
      }
      const draft = buildDraftFromStagingEntry(entry, identity);

      // ── Dedup gate ──
      let dup: DuplicateCheckResult;
      try {
        dup = await findSemanticDuplicate(
          entry,
          draft,
          options.abrainHome,
          options.projectId,
          options.signal,
        );
      } catch {
        dup = { duplicate: false };
      }
      if (dup.duplicate) {
        try {
          const matchedSlug = dup.match?.slug;
          const promotedToSlug = matchedSlug ? canonicalPromotedSlug(matchedSlug, identity.slug) : identity.slug;
          const rationale = dup.reason
            ? `duplicate:${dup.reason}${matchedSlug ? ` against ${matchedSlug}` : ""}${dup.score ? ` score=${dup.score}` : ""}`
            : "duplicate detected";
          applyPromotionOutcome(candidate.file, entry, now, "duplicate", promotedToSlug, rationale);
          if (!await markClusterSiblings(candidate, now, "duplicate", promotedToSlug, promotionCtx)) degraded = true;
          result.duplicate_slugs.push(entry.slug);
        } catch {
          degraded = true;
        }
        continue;
      }

      // ── Reconstruct + multi-view gate ──
      const proposerDecision = buildProposerDecisionFromStagingEntry(entry);
      const neighbors = await loadPromotionNeighbors(entry, options.projectRoot);
      const correctionSignal = correctionSignalFromStaging(entry);

      let mvResult: MultiViewResult;
      try {
        const mv = options.runMultiView ?? runMultiView;
        mvResult = await mv({
          proposerDecision,
          proposerRawText: entry.hypothesis ?? "",
          candidate: draft,
          neighbors,
          correctionSignal,
          settings: options.settings,
          modelRegistry: options.modelRegistry,
          signal: options.signal,
          originProjectId: options.projectId,
          originProjectRoot: options.projectRoot,
          // FIX-1a: force the A' reviewer gate regardless of confidence.
          forceTrigger: true,
          // FIX-6: link the pending replay file back to this staging entry.
          sourceStagingSlug: entry.slug,
          sourceStagingFile: candidate.file,
        });
      } catch (e: unknown) {
        // Transient multi-view framework error — keep staging active, debounce.
        degraded = true;
        try {
          applyPromotionOutcome(candidate.file, entry, now, "error");
          if (!await markClusterSiblings(candidate, now, "error", undefined, promotionCtx)) degraded = true;
          result.rejected_slugs.push(entry.slug);
        } catch {
          degraded = true;
        }
        const message = e instanceof Error ? e.message : String(e);
        appendLedgerRow({
          op: "staging_promote",
          ok: false,
          degraded: true,
          reviewed_count: result.reviewed_count,
          slug: entry.slug,
          error: message.slice(0, 500),
          session_id: options.sessionId,
          prompt_version: STAGING_PROMOTION_PROMPT_VERSION,
        });
        continue;
      }

      // FIX-1b: untriggered multi-view must never reach a durable write.
      if (!mvResult.triggered) {
        degraded = true;
        try {
          applyPromotionOutcome(candidate.file, entry, now, "error", undefined, "multi-view did not trigger despite forceTrigger");
          if (!await markClusterSiblings(candidate, now, "error", undefined, promotionCtx)) degraded = true;
          result.rejected_slugs.push(entry.slug);
        } catch {
          degraded = true;
        }
        continue;
      }

      // FIX-6: transient reviewer failure → staged_for_replay, owned by the
      // multiview-pending replay lane. Keep attribution_pending true.
      if (mvResult.staged || (mvResult.final_decision.op === "skip" && mvResult.final_decision.reason === "multiview_staged_for_replay")) {
        try {
          const rationale = mvResult.staged
            ? `staged for replay as ${mvResult.staged.slug} (state=${mvResult.staged.state})`
            : "multiview_staged_for_replay";
          applyPromotionOutcome(candidate.file, entry, now, "staged_for_replay", undefined, rationale);
          if (!await markClusterSiblings(candidate, now, "staged_for_replay", undefined, promotionCtx)) degraded = true;
          result.staged_for_replay_slugs.push(entry.slug);
        } catch {
          degraded = true;
        }
        continue;
      }

      // Multi-view explicitly rejected the candidate.
      if (mvResult.final_decision.op === "skip") {
        try {
          applyPromotionOutcome(candidate.file, entry, now, "rejected", undefined, mvResult.final_decision.reason);
          if (!await markClusterSiblings(candidate, now, "rejected", undefined, promotionCtx)) degraded = true;
          result.rejected_slugs.push(entry.slug);
        } catch {
          degraded = true;
        }
        continue;
      }

      // ── Durable write ──
      let promotedSlug: string | undefined;
      try {
        let writeResults: WriteProjectEntryResult[];
        if (options.writeApprovedToBrain) {
          promotedSlug = await options.writeApprovedToBrain(mvResult.final_decision, draft);
          writeResults = [{
            slug: promotedSlug,
            path: "",
            status: "created",
            sessionId: options.sessionId,
          }];
        } else {
          writeResults = await executeCuratorDecisionToBrain({
            decision: mvResult.final_decision,
            draft,
            projectRoot: options.projectRoot,
            abrainHome: options.abrainHome,
            projectId: options.projectId,
            settings: options.settings,
            dryRun: false,
            sessionId: options.sessionId,
            auditContext: {
              lane: "staging_promotion",
              sessionId: options.sessionId,
            },
            createTimelineNote: `Promoted from staging ${entry.slug} by multi-view gate`,
          });
        }

        // FIX-5: only a real durable write counts as promoted.
        const deduped = writeResults.filter(isWriterDedupeResult);
        if (deduped.length === writeResults.length && writeResults.length > 0) {
          const first = writeResults[0];
          const matchedSlug = first?.dedupedAgainst ?? first?.slug;
          const promotedToSlug = canonicalPromotedSlug(matchedSlug, identity.slug);
          const rationale = `writer dedupe: ${first?.reason ?? "unknown"}`;
          applyPromotionOutcome(candidate.file, entry, now, "duplicate", promotedToSlug, rationale);
          if (!await markClusterSiblings(candidate, now, "duplicate", promotedToSlug, promotionCtx)) degraded = true;
          result.duplicate_slugs.push(entry.slug);
          continue;
        }
        const rejected = writeResults.find((r) => r.status === "rejected");
        if (rejected) {
          throw new Error(`writer rejected op=${mvResult.final_decision.op}: ${rejected.reason || "unknown"}`);
        }
        const nonDedupeSkip = writeResults.find((r) => r.status === "skipped" && !isWriterDedupeResult(r));
        if (nonDedupeSkip) {
          throw new Error(`writer skipped op=${mvResult.final_decision.op}: ${nonDedupeSkip.reason || "unknown"}`);
        }
        promotedSlug = canonicalPromotedSlug(writeResults[0]?.slug ?? promotedSlug, identity.slug);
        try {
          applyPromotionOutcome(candidate.file, entry, now, "promoted", promotedSlug);
          if (!await markClusterSiblings(candidate, now, "promoted", promotedSlug, promotionCtx)) degraded = true;
          result.promoted_slugs.push(entry.slug);
          result.promoted_to_slugs.push(promotedSlug);
        } catch {
          degraded = true;
        }
      } catch (e: unknown) {
        // Writer failure / non-dedupe skip — keep staging active for retry.
        degraded = true;
        try {
          applyPromotionOutcome(candidate.file, entry, now, "error", undefined, e instanceof Error ? e.message : String(e));
          if (!await markClusterSiblings(candidate, now, "error", undefined, promotionCtx)) degraded = true;
          result.rejected_slugs.push(entry.slug);
        } catch {
          degraded = true;
        }
        const message = e instanceof Error ? e.message : String(e);
        appendLedgerRow({
          op: "staging_promote",
          ok: false,
          degraded: true,
          reviewed_count: result.reviewed_count,
          slug: entry.slug,
          error: message.slice(0, 500),
          session_id: options.sessionId,
          prompt_version: STAGING_PROMOTION_PROMPT_VERSION,
        });
      }
    }

    // FIX-7b: ok = !degraded. A run that only duplicates/promotes some
    // entries but hits writer/multi-view framework errors is degraded, not ok.
    result.ok = !degraded;
    result.degraded = degraded || undefined;
    result.durationMs = Date.now() - t0;

    writeLastRun(options.projectRoot, now, result.ok && !degraded ? "ok" : degraded ? "degraded" : "skipped");
    appendLedgerRow({
      op: "staging_promote",
      ok: result.ok,
      degraded: result.degraded ?? false,
      reviewed_count: result.reviewed_count,
      promoted_slugs: result.promoted_slugs,
      promoted_to_slugs: result.promoted_to_slugs,
      rejected_slugs: result.rejected_slugs,
      duplicate_slugs: result.duplicate_slugs,
      staged_for_replay_slugs: result.staged_for_replay_slugs,
      session_id: options.sessionId,
      prompt_version: STAGING_PROMOTION_PROMPT_VERSION,
      duration_ms: result.durationMs,
    });

    return result;
  } finally {
    releaseLock(lockClaim);
  }
}

/** FIX-5: detect a writer result that represents a duplicate/no-op rather
 *  than a real write. executeCuratorDecisionToBrain adapts rules-zone
 *  dedupe/similar_found results to the shared shape as status "skipped"
 *  with dedupedAgainst and a duplicate-ish reason. */
function isWriterDedupeResult(r: WriteProjectEntryResult): boolean {
  if (r.status !== "skipped") return false;
  if (r.dedupedAgainst) return true;
  const reason = r.reason ?? "";
  return /duplicate|similar|unchanged/.test(reason);
}
