/**
 * sediment evolution-ledger — L1 self-state for aggregator advisories.
 *
 * This is the first persistent sink for the prompt-native skeptical historian
 * that is still safely outside the durable memory corpus. It turns each
 * aggregator v1 output into an internal, cross-run hypothesis lifecycle:
 *
 *   promoted_advisory      → proposed / reinforced
 *   demoted_signal         → contested
 *   withdraw_acknowledgment → withdrawn
 *
 * ADR 0024/0027 boundary:
 *   - COGNITIVE: the skeptical-historian LLM decides what to promote/demote.
 *   - INFRA: this module only records those judgments as sidecar state.
 *
 * The ledger NEVER writes markdown memory entries, NEVER asks the user, and
 * NEVER authorizes archive/update/create actions. Errors are kept as learning
 * material for the next LLM reflection cycle, not blocked by mechanical gates.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import type {
  AcknowledgmentEntry,
  DemotedSignal,
  PromptNativeOutput,
  PromotedAdvisory,
} from "./aggregator-llm";

export type EvolutionLedgerStatus = "proposed" | "reinforced" | "contested" | "withdrawn";
export type EvolutionLedgerEventSource = "promoted_advisory" | "demoted_signal" | "previous_acknowledgment";

export interface EvolutionLedgerHistoryItem {
  ts: string;
  source: EvolutionLedgerEventSource;
  status_after: EvolutionLedgerStatus;
  severity?: PromotedAdvisory["severity"];
  acknowledgment_status?: AcknowledgmentEntry["status"];
  message?: string;
  reason?: string;
}

export interface EvolutionLedgerEntry {
  schema_version: 1;
  /** Stable per-project advisory identity: kind + slug, kind + message hash, or unresolved kind-only signal. */
  key: string;
  project_root: string;
  kind: string;
  slug?: string;
  status: EvolutionLedgerStatus;
  first_seen: string;
  last_seen: string;
  /** Number of prompt-native promoted_advisory observations. */
  seen_count: number;
  /** Number of prompt-native demoted_signal observations. */
  demoted_count: number;
  acknowledgment_count: number;
  withdrawn_count: number;
  last_severity?: PromotedAdvisory["severity"];
  last_message?: string;
  last_reasoning?: string;
  last_falsifier?: string;
  last_evidence_quotes?: string[];
  last_demoted_reason?: string;
  last_acknowledgment_status?: AcknowledgmentEntry["status"];
  last_acknowledgment_reason?: string;
  history_tail: EvolutionLedgerHistoryItem[];
}

export interface EvolutionLedgerHypothesisSummary {
  key: string;
  kind: string;
  slug?: string;
  status: EvolutionLedgerStatus;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  demoted_count: number;
  acknowledgment_count: number;
  withdrawn_count: number;
  last_severity?: PromotedAdvisory["severity"];
  last_message?: string;
  last_reasoning?: string;
  last_falsifier?: string;
  last_evidence_quotes?: string[];
  last_demoted_reason?: string;
  last_acknowledgment_status?: AcknowledgmentEntry["status"];
  last_acknowledgment_reason?: string;
}

export interface EvolutionLedgerSummary {
  project_root: string;
  rows_considered: number;
  matching_rows: number;
  active_hypotheses: EvolutionLedgerHypothesisSummary[];
  contested_hypotheses: EvolutionLedgerHypothesisSummary[];
  withdrawn_hypotheses: EvolutionLedgerHypothesisSummary[];
}

export interface MergeEvolutionLedgerOptions {
  projectRoot: string;
  promptNative: PromptNativeOutput;
  now?: Date;
}

export interface MergeEvolutionLedgerResult {
  ok: boolean;
  written: boolean;
  promoted_count: number;
  demoted_count: number;
  acknowledgment_count: number;
  entries_written: number;
  error?: string;
}

const EVOLUTION_LEDGER_MAX_ROWS = 500;
const EVOLUTION_LEDGER_TAIL_READ_BYTES = 2 * 1024 * 1024;
const HISTORY_TAIL_MAX = 8;
const SUMMARY_LIMIT_PER_BUCKET = 12;
const STRING_FIELD_MAX_CHARS = 1_000;
const QUOTE_MAX_CHARS = 500;

export function evolutionLedgerPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "evolution-ledger.jsonl");
}

function clip(s: unknown, max = STRING_FIELD_MAX_CHARS): string {
  const text = typeof s === "string" ? s : String(s ?? "");
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function normalizeKind(kind: unknown): string {
  const text = typeof kind === "string" && kind.trim() ? kind.trim() : "unknown";
  return text.replace(/\s+/g, "_").slice(0, 120);
}

function normalizeProjectRoot(projectRoot: unknown): string {
  return typeof projectRoot === "string" && projectRoot.trim()
    ? path.resolve(projectRoot)
    : "";
}

function advisoryKey(kind: unknown, slug?: unknown, message?: unknown): string {
  const k = normalizeKind(kind);
  if (typeof slug === "string" && slug.trim()) return `${k}::slug:${slug.trim()}`;
  const basis = `${k}\n${typeof message === "string" ? message : ""}`;
  const digest = crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12);
  return `${k}::message:${digest}`;
}

function compoundKey(entry: Pick<EvolutionLedgerEntry, "project_root" | "key">): string {
  return `${normalizeProjectRoot(entry.project_root)}\u0000${entry.key}`;
}

function explicitAdvisoryKey(key: unknown, kind: string): string | undefined {
  const text = typeof key === "string" && key.trim() ? key.trim().slice(0, 240) : "";
  return text && text.startsWith(`${kind}::`) ? text : undefined;
}

function readJsonl<T = Record<string, unknown>>(filePath: string, maxBytes = EVOLUTION_LEDGER_TAIL_READ_BYTES): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = maxBytes > 0 && stat.size > maxBytes ? stat.size - maxBytes : 0;
    const fd = fs.openSync(filePath, "r");
    let raw = "";
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      raw = buffer.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const out: T[] = [];
    for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
      try { out.push(JSON.parse(line) as T); } catch { /* corrupt ledger line: ignored */ }
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeEntry(row: unknown): EvolutionLedgerEntry | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const key = typeof r.key === "string" && r.key.trim() ? r.key.trim() : "";
  const projectRoot = normalizeProjectRoot(r.project_root);
  const kind = normalizeKind(r.kind);
  if (!key || !projectRoot) return null;
  const status: EvolutionLedgerStatus =
    r.status === "reinforced" || r.status === "contested" || r.status === "withdrawn" || r.status === "proposed"
      ? r.status
      : "proposed";
  const firstSeen = typeof r.first_seen === "string" ? r.first_seen : "";
  const lastSeen = typeof r.last_seen === "string" ? r.last_seen : firstSeen;
  const history = Array.isArray(r.history_tail) ? r.history_tail : [];
  const entry: EvolutionLedgerEntry = {
    schema_version: 1,
    key,
    project_root: projectRoot,
    kind,
    ...(typeof r.slug === "string" && r.slug ? { slug: r.slug } : {}),
    status,
    first_seen: firstSeen || lastSeen || formatLocalIsoTimestamp(),
    last_seen: lastSeen || firstSeen || formatLocalIsoTimestamp(),
    seen_count: typeof r.seen_count === "number" && Number.isFinite(r.seen_count) ? Math.max(0, Math.floor(r.seen_count)) : 0,
    demoted_count: typeof r.demoted_count === "number" && Number.isFinite(r.demoted_count) ? Math.max(0, Math.floor(r.demoted_count)) : 0,
    acknowledgment_count: typeof r.acknowledgment_count === "number" && Number.isFinite(r.acknowledgment_count) ? Math.max(0, Math.floor(r.acknowledgment_count)) : 0,
    withdrawn_count: typeof r.withdrawn_count === "number" && Number.isFinite(r.withdrawn_count) ? Math.max(0, Math.floor(r.withdrawn_count)) : 0,
    history_tail: history
      .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
      .slice(-HISTORY_TAIL_MAX)
      .map((h) => ({
        ts: typeof h.ts === "string" ? h.ts : "",
        source: h.source === "demoted_signal" || h.source === "previous_acknowledgment" ? h.source : "promoted_advisory",
        status_after: h.status_after === "reinforced" || h.status_after === "contested" || h.status_after === "withdrawn" ? h.status_after : "proposed",
        ...(h.severity === "info" || h.severity === "warning" || h.severity === "critical" ? { severity: h.severity } : {}),
        ...(h.acknowledgment_status === "still_acknowledged" || h.acknowledgment_status === "withdraw_acknowledgment" || h.acknowledgment_status === "no_change" ? { acknowledgment_status: h.acknowledgment_status } : {}),
        ...(typeof h.message === "string" ? { message: clip(h.message) } : {}),
        ...(typeof h.reason === "string" ? { reason: clip(h.reason) } : {}),
      })),
  };
  if (r.last_severity === "info" || r.last_severity === "warning" || r.last_severity === "critical") entry.last_severity = r.last_severity;
  if (typeof r.last_message === "string") entry.last_message = clip(r.last_message);
  if (typeof r.last_reasoning === "string") entry.last_reasoning = clip(r.last_reasoning);
  if (typeof r.last_falsifier === "string") entry.last_falsifier = clip(r.last_falsifier);
  if (Array.isArray(r.last_evidence_quotes)) entry.last_evidence_quotes = r.last_evidence_quotes.filter((q): q is string => typeof q === "string").slice(0, 5).map((q) => clip(q, QUOTE_MAX_CHARS));
  if (typeof r.last_demoted_reason === "string") entry.last_demoted_reason = clip(r.last_demoted_reason);
  if (r.last_acknowledgment_status === "still_acknowledged" || r.last_acknowledgment_status === "withdraw_acknowledgment" || r.last_acknowledgment_status === "no_change") entry.last_acknowledgment_status = r.last_acknowledgment_status;
  if (typeof r.last_acknowledgment_reason === "string") entry.last_acknowledgment_reason = clip(r.last_acknowledgment_reason);
  return entry;
}

function readEvolutionEntries(): EvolutionLedgerEntry[] {
  const file = evolutionLedgerPath();
  return readJsonl<unknown>(file).map(normalizeEntry).filter((e): e is EvolutionLedgerEntry => e !== null);
}

function appendHistory(
  entry: EvolutionLedgerEntry,
  item: Omit<EvolutionLedgerHistoryItem, "status_after">,
): void {
  entry.history_tail = [
    ...entry.history_tail,
    {
      ...item,
      ...(item.message ? { message: clip(item.message) } : {}),
      ...(item.reason ? { reason: clip(item.reason) } : {}),
      status_after: entry.status,
    },
  ].slice(-HISTORY_TAIL_MAX);
}

function entryFor(
  map: Map<string, EvolutionLedgerEntry>,
  projectRoot: string,
  key: string,
  kind: string,
  ts: string,
  slug?: string,
): EvolutionLedgerEntry {
  const ck = `${projectRoot}\u0000${key}`;
  const existing = map.get(ck);
  if (existing) return existing;
  const entry: EvolutionLedgerEntry = {
    schema_version: 1,
    key,
    project_root: projectRoot,
    kind,
    ...(slug ? { slug } : {}),
    status: "proposed",
    first_seen: ts,
    last_seen: ts,
    seen_count: 0,
    demoted_count: 0,
    acknowledgment_count: 0,
    withdrawn_count: 0,
    history_tail: [],
  };
  map.set(ck, entry);
  return entry;
}

function uniqueUnsluggedEntryForKind(
  map: Map<string, EvolutionLedgerEntry>,
  projectRoot: string,
  kind: string,
): EvolutionLedgerEntry | undefined {
  const candidates = [...map.values()].filter((entry) => (
    normalizeProjectRoot(entry.project_root) === projectRoot
    && normalizeKind(entry.kind) === kind
    && !entry.slug
    && entry.key.startsWith(`${kind}::message:`)
  ));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Identity convergence (dogfood-driven, 2026-06-03): a hypothesis often enters
 * first as a slug-less `kind::message:<hash>` row (free-form advisory message,
 * no stable slug), then a LATER run refers to the SAME belief by a stable slug.
 * Without convergence those become two forked identities and the
 * reinforced/contested/withdrawn lifecycle — the whole point of the loop — gets
 * diluted across runs.
 *
 * When a slug appears for a kind whose only slug-less row is a SINGLE
 * `kind::message:*` entry, re-key that row onto the slug identity and carry its
 * accumulated counts + history forward. This is a quiet correctness merge, not
 * a mechanical gate: it fires ONLY when exactly one unslugged row exists, so it
 * never guesses between competing beliefs (multiple unslugged rows → no merge,
 * the slug forks a fresh row and the next LLM reflection cycle reconciles). If
 * the slug identity already exists, it is preferred and no merge happens.
 *
 * Residual risk (accepted as learning material, not gated): identity is keyed
 * at project+kind granularity with no message/semantic similarity check, so a
 * single accumulated slug-less row of a BROAD kind could be re-keyed onto an
 * unrelated slug of that same kind. The prompt mitigates this upstream by
 * telling the LLM to assign stable per-belief slugs; a wrong merge here is
 * visible self-state the next reflection cycle can contest/withdraw.
 */
function adoptUnsluggedAlias(
  map: Map<string, EvolutionLedgerEntry>,
  projectRoot: string,
  kind: string,
  slug: string,
): EvolutionLedgerEntry | undefined {
  const slugKey = advisoryKey(kind, slug, undefined);
  const slugCk = `${projectRoot}\u0000${slugKey}`;
  if (map.has(slugCk)) return undefined;
  const orphan = uniqueUnsluggedEntryForKind(map, projectRoot, kind);
  if (!orphan) return undefined;
  map.delete(`${projectRoot}\u0000${orphan.key}`);
  orphan.key = slugKey;
  orphan.slug = slug;
  map.set(slugCk, orphan);
  return orphan;
}

function entryForSignal(
  map: Map<string, EvolutionLedgerEntry>,
  projectRoot: string,
  kind: string,
  ts: string,
  slug?: string,
  explicitKey?: unknown,
): EvolutionLedgerEntry {
  if (slug) {
    return adoptUnsluggedAlias(map, projectRoot, kind, slug)
      ?? entryFor(map, projectRoot, advisoryKey(kind, slug, undefined), kind, ts, slug);
  }

  const key = explicitAdvisoryKey(explicitKey, kind);
  if (key) return entryFor(map, projectRoot, key, kind, ts);

  const existing = uniqueUnsluggedEntryForKind(map, projectRoot, kind);
  if (existing) return existing;

  return entryFor(map, projectRoot, `${kind}::unspecified`, kind, ts);
}

function statusAfterPromotion(entry: EvolutionLedgerEntry): EvolutionLedgerStatus {
  if (entry.demoted_count > 0 && entry.demoted_count >= entry.seen_count) return "contested";
  return entry.seen_count >= 2 ? "reinforced" : "proposed";
}

function statusAfterAcknowledgment(entry: EvolutionLedgerEntry, ack: AcknowledgmentEntry): EvolutionLedgerStatus {
  if (ack.status === "withdraw_acknowledgment") return "withdrawn";
  if (entry.status === "withdrawn") return "withdrawn";
  if (entry.demoted_count > 0 && entry.demoted_count >= entry.seen_count) return "contested";
  return entry.seen_count >= 2 ? "reinforced" : "proposed";
}

export function mergeEvolutionLedger(options: MergeEvolutionLedgerOptions): MergeEvolutionLedgerResult {
  try {
    const now = options.now ?? new Date();
    const ts = formatLocalIsoTimestamp(now);
    const projectRoot = normalizeProjectRoot(options.projectRoot);
    const promptNative = options.promptNative;
    const promoted = Array.isArray(promptNative.promoted_advisories) ? promptNative.promoted_advisories : [];
    const demoted = Array.isArray(promptNative.demoted_signals) ? promptNative.demoted_signals : [];
    const acknowledgments = Array.isArray(promptNative.previous_acknowledgments) ? promptNative.previous_acknowledgments : [];

    if (!projectRoot || promoted.length + demoted.length + acknowledgments.length === 0) {
      return { ok: true, written: false, promoted_count: promoted.length, demoted_count: demoted.length, acknowledgment_count: acknowledgments.length, entries_written: readEvolutionEntries().length };
    }

    const map = new Map<string, EvolutionLedgerEntry>();
    for (const entry of readEvolutionEntries()) map.set(compoundKey(entry), entry);

    for (const advisory of promoted) {
      const kind = normalizeKind(advisory.kind);
      const slug = typeof advisory.slug === "string" && advisory.slug.trim() ? advisory.slug.trim() : undefined;
      const entry = slug
        ? (adoptUnsluggedAlias(map, projectRoot, kind, slug)
          ?? entryFor(map, projectRoot, advisoryKey(kind, slug, undefined), kind, ts, slug))
        : entryFor(map, projectRoot, advisoryKey(kind, undefined, advisory.message), kind, ts);
      entry.last_seen = ts;
      entry.seen_count += 1;
      entry.last_severity = advisory.severity;
      entry.last_message = clip(advisory.message);
      entry.last_reasoning = clip(advisory.reasoning);
      entry.last_falsifier = clip(advisory.falsifier);
      entry.last_evidence_quotes = Array.isArray(advisory.evidence_quotes)
        ? advisory.evidence_quotes.filter((q): q is string => typeof q === "string").slice(0, 5).map((q) => clip(q, QUOTE_MAX_CHARS))
        : [];
      entry.status = statusAfterPromotion(entry);
      appendHistory(entry, {
        ts,
        source: "promoted_advisory",
        severity: advisory.severity,
        message: advisory.message,
        reason: advisory.reasoning,
      });
    }

    for (const signal of demoted) {
      const kind = normalizeKind(signal.kind);
      const slug = typeof signal.slug === "string" && signal.slug.trim() ? signal.slug.trim() : undefined;
      const entry = entryForSignal(map, projectRoot, kind, ts, slug, signal.key);
      entry.last_seen = ts;
      entry.demoted_count += 1;
      entry.last_demoted_reason = clip(signal.reason);
      entry.status = "contested";
      appendHistory(entry, {
        ts,
        source: "demoted_signal",
        reason: signal.reason,
      });
    }

    for (const ack of acknowledgments) {
      const kind = normalizeKind(ack.kind);
      const slug = typeof ack.slug === "string" && ack.slug.trim() ? ack.slug.trim() : undefined;
      const entry = entryForSignal(map, projectRoot, kind, ts, slug, ack.key);
      entry.last_seen = ts;
      entry.acknowledgment_count += 1;
      entry.last_acknowledgment_status = ack.status;
      entry.last_acknowledgment_reason = clip(ack.reason);
      if (ack.status === "withdraw_acknowledgment") entry.withdrawn_count += 1;
      entry.status = statusAfterAcknowledgment(entry, ack);
      appendHistory(entry, {
        ts,
        source: "previous_acknowledgment",
        acknowledgment_status: ack.status,
        reason: ack.reason,
      });
    }

    const rows = [...map.values()]
      .sort((a, b) => (b.last_seen > a.last_seen ? 1 : b.last_seen < a.last_seen ? -1 : a.key.localeCompare(b.key)))
      .slice(0, EVOLUTION_LEDGER_MAX_ROWS);
    const file = evolutionLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const enrichedRows = rows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
    fs.writeFileSync(file, enrichedRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
    return {
      ok: true,
      written: true,
      promoted_count: promoted.length,
      demoted_count: demoted.length,
      acknowledgment_count: acknowledgments.length,
      entries_written: rows.length,
    };
  } catch (e) {
    return {
      ok: false,
      written: false,
      promoted_count: options.promptNative.promoted_advisories?.length ?? 0,
      demoted_count: options.promptNative.demoted_signals?.length ?? 0,
      acknowledgment_count: options.promptNative.previous_acknowledgments?.length ?? 0,
      entries_written: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function toSummary(entry: EvolutionLedgerEntry): EvolutionLedgerHypothesisSummary {
  return {
    key: entry.key,
    kind: entry.kind,
    ...(entry.slug ? { slug: entry.slug } : {}),
    status: entry.status,
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    seen_count: entry.seen_count,
    demoted_count: entry.demoted_count,
    acknowledgment_count: entry.acknowledgment_count,
    withdrawn_count: entry.withdrawn_count,
    ...(entry.last_severity ? { last_severity: entry.last_severity } : {}),
    ...(entry.last_message ? { last_message: entry.last_message } : {}),
    ...(entry.last_reasoning ? { last_reasoning: entry.last_reasoning } : {}),
    ...(entry.last_falsifier ? { last_falsifier: entry.last_falsifier } : {}),
    ...(entry.last_evidence_quotes ? { last_evidence_quotes: entry.last_evidence_quotes } : {}),
    ...(entry.last_demoted_reason ? { last_demoted_reason: entry.last_demoted_reason } : {}),
    ...(entry.last_acknowledgment_status ? { last_acknowledgment_status: entry.last_acknowledgment_status } : {}),
    ...(entry.last_acknowledgment_reason ? { last_acknowledgment_reason: entry.last_acknowledgment_reason } : {}),
  };
}

function sortHypotheses(a: EvolutionLedgerEntry, b: EvolutionLedgerEntry): number {
  const rank = (e: EvolutionLedgerEntry): number => {
    if (e.status === "reinforced") return 3;
    if (e.status === "proposed") return 2;
    if (e.status === "contested") return 1;
    return 0;
  };
  return rank(b) - rank(a)
    || (b.seen_count + b.demoted_count + b.acknowledgment_count) - (a.seen_count + a.demoted_count + a.acknowledgment_count)
    || (b.last_seen > a.last_seen ? 1 : b.last_seen < a.last_seen ? -1 : a.key.localeCompare(b.key));
}

export function summarizeEvolutionLedger(options: { projectRoot: string; limitPerBucket?: number }): EvolutionLedgerSummary {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const limit = Math.max(1, Math.floor(options.limitPerBucket ?? SUMMARY_LIMIT_PER_BUCKET));
  const rows = readEvolutionEntries();
  const matching = rows.filter((row) => normalizeProjectRoot(row.project_root) === projectRoot).sort(sortHypotheses);
  const active = matching.filter((row) => row.status === "proposed" || row.status === "reinforced").slice(0, limit).map(toSummary);
  const contested = matching.filter((row) => row.status === "contested").slice(0, limit).map(toSummary);
  const withdrawn = matching.filter((row) => row.status === "withdrawn").slice(0, limit).map(toSummary);
  return {
    project_root: projectRoot,
    rows_considered: rows.length,
    matching_rows: matching.length,
    active_hypotheses: active,
    contested_hypotheses: contested,
    withdrawn_hypotheses: withdrawn,
  };
}
