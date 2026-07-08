/**
 * prompt-revision-proposals — R5 deterministic prompt revision dossier sidecar.
 *
 * This module records human-review prompt revision proposals only. It never
 * writes prompt files, never bumps promptVersion, never calls writer/curator /
 * archive / multi-view, and never creates a user-facing management surface.
 * Generation is gated by explicit reinforced prompt-level evidence; absent that
 * contract, the packager returns zero proposals instead of guessing from prose.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { atomicWriteText, withFileLock } from "../_shared/sync-file-lock";
import type { AggregatorSummary } from "./aggregator";
import type { SedimentSettings } from "./settings";

export type PromptRevisionProposalStatus = "proposed" | "under_review" | "accepted" | "rejected" | "deferred" | "superseded";
export type PromptRevisionDispositionDecision = "accept" | "reject" | "defer";
export type PromptRevisionTargetPrompt = keyof SedimentSettings["promptVersion"];
export type PromptRevisionSignalSource = "classifier_health" | "evolution_hypothesis";

export interface PromptRevisionDisposition {
  decision: PromptRevisionDispositionDecision;
  reason: string;
  ts?: string;
  operator?: string;
}

export interface PromptRevisionProposalRow {
  schema_version: 1;
  ts: string;
  project_root: string;
  proposal_id: string;
  target_prompt: PromptRevisionTargetPrompt;
  current_version: string;
  problem_pattern: string;
  evidence_quotes: string[];
  falsifier: string;
  proposed_change_summary: string;
  status: PromptRevisionProposalStatus;
  requires_human_review: true;
  applied_to_disk?: false;
  recurrence_count: number;
  first_seen: string;
  last_seen: string;
  audit_trace_anchors: string[];
  source_signal: PromptRevisionSignalSource;
  disposition?: PromptRevisionDisposition;
  operator_review?: {
    reviewer?: string;
    reviewed_at?: string;
    notes?: string;
  };
}

export interface PromptRevisionPatternSignal {
  signal_type: "classifier_prompt_pattern";
  reinforced: true;
  source_signal: PromptRevisionSignalSource;
  target_prompt: PromptRevisionTargetPrompt;
  problem_pattern: string;
  evidence_quotes: string[];
  falsifier: string;
  proposed_change_summary: string;
  audit_trace_anchors: string[];
}

export interface PromptRevisionSignalEnvelope {
  reinforced_classifier_prompt_patterns?: PromptRevisionPatternSignal[];
}

export interface AppendPromptRevisionProposalsResult {
  ok: boolean;
  written: boolean;
  proposals_upserted: number;
  rows_total: number;
  invalid_count: number;
  error?: string;
}

const PROPOSALS_MAX_ROWS = 1000;
const PROPOSALS_TAIL_READ_BYTES = 2 * 1024 * 1024;
const STRING_FIELD_MAX_CHARS = 1000;
// Evidence snippets are intentionally short: enough to audit the claim, not
// enough to preserve long user/private transcript text in a prompt dossier.
const EVIDENCE_QUOTE_MAX_CHARS = 240;
const EVIDENCE_QUOTE_MAX_COUNT = 5;
const AUDIT_ANCHOR_MAX_CHARS = 180;
const AUDIT_ANCHOR_MAX_COUNT = 8;

export function promptRevisionProposalsPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "prompt-revision-proposals.jsonl");
}

function promptRevisionProposalsLockPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "locks", "prompt-revision-proposals.lock");
}

function normalizeProjectRoot(value: unknown): string {
  return typeof value === "string" && value.trim() ? path.resolve(value) : "";
}

function clip(value: unknown, max = STRING_FIELD_MAX_CHARS): string {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function clipList(value: unknown, maxCount: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const clipped = clip(item, maxChars);
    if (!clipped || seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= maxCount) break;
  }
  return out;
}

function readJsonlTail<T = Record<string, unknown>>(filePath: string, maxBytes = PROPOSALS_TAIL_READ_BYTES): T[] {
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
      try { out.push(JSON.parse(line) as T); } catch { /* corrupt sidecar line ignored */ }
    }
    return out;
  } catch {
    return [];
  }
}

function validTargetPrompt(value: unknown, settings: SedimentSettings): PromptRevisionTargetPrompt | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return Object.prototype.hasOwnProperty.call(settings.promptVersion, value)
    ? value as PromptRevisionTargetPrompt
    : undefined;
}

function validStatus(value: unknown): PromptRevisionProposalStatus {
  return value === "under_review" || value === "accepted" || value === "rejected" || value === "deferred" || value === "superseded"
    ? value
    : "proposed";
}

function validSource(value: unknown): PromptRevisionSignalSource | undefined {
  return value === "classifier_health" || value === "evolution_hypothesis" ? value : undefined;
}

function normalizeDisposition(value: unknown): PromptRevisionDisposition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const decision = r.decision === "accept" || r.decision === "reject" || r.decision === "defer" ? r.decision : undefined;
  const reason = clip(r.reason, STRING_FIELD_MAX_CHARS);
  if (!decision || !reason) return undefined;
  return {
    decision,
    reason,
    ...(typeof r.ts === "string" && r.ts ? { ts: clip(r.ts, 120) } : {}),
    ...(typeof r.operator === "string" && r.operator ? { operator: clip(r.operator, 120) } : {}),
  };
}

function normalizeOperatorReview(value: unknown): PromptRevisionProposalRow["operator_review"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const reviewer = clip(r.reviewer, 120);
  const reviewedAt = clip(r.reviewed_at, 120);
  const notes = clip(r.notes, STRING_FIELD_MAX_CHARS);
  if (!reviewer && !reviewedAt && !notes) return undefined;
  return {
    ...(reviewer ? { reviewer } : {}),
    ...(reviewedAt ? { reviewed_at: reviewedAt } : {}),
    ...(notes ? { notes } : {}),
  };
}

function containsForbiddenPromptDiffField(row: Record<string, unknown>): boolean {
  for (const key of Object.keys(row)) {
    const normalized = key.toLowerCase();
    if (normalized.includes("diff") || normalized.includes("patch") || normalized === "full_prompt" || normalized === "prompt_full_text") return true;
  }
  return false;
}

function stableProposalId(row: Pick<PromptRevisionProposalRow, "project_root" | "target_prompt" | "current_version" | "problem_pattern">): string {
  const basis = [row.project_root, row.target_prompt, row.current_version, row.problem_pattern].join("\0");
  return `prp-${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

function normalizeRow(row: unknown, settings: SedimentSettings): PromptRevisionProposalRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (containsForbiddenPromptDiffField(r)) return null;
  const projectRoot = normalizeProjectRoot(r.project_root);
  const targetPrompt = validTargetPrompt(r.target_prompt, settings);
  const sourceSignal = validSource(r.source_signal);
  const problemPattern = clip(r.problem_pattern);
  const falsifier = clip(r.falsifier);
  const proposedChangeSummary = clip(r.proposed_change_summary);
  const evidenceQuotes = clipList(r.evidence_quotes, EVIDENCE_QUOTE_MAX_COUNT, EVIDENCE_QUOTE_MAX_CHARS);
  const auditTraceAnchors = clipList(r.audit_trace_anchors, AUDIT_ANCHOR_MAX_COUNT, AUDIT_ANCHOR_MAX_CHARS);
  if (!projectRoot || !targetPrompt || !sourceSignal || !problemPattern || !falsifier || !proposedChangeSummary) return null;
  if (evidenceQuotes.length === 0 || auditTraceAnchors.length === 0) return null;
  const ts = typeof r.ts === "string" && r.ts ? r.ts : formatLocalIsoTimestamp();
  const currentVersion = typeof r.current_version === "string" && r.current_version
    ? clip(r.current_version, 80)
    : settings.promptVersion[targetPrompt];
  const base = {
    project_root: projectRoot,
    target_prompt: targetPrompt,
    current_version: currentVersion,
    problem_pattern: problemPattern,
  };
  const normalized: PromptRevisionProposalRow = {
    schema_version: 1,
    ts,
    ...base,
    proposal_id: typeof r.proposal_id === "string" && r.proposal_id ? r.proposal_id : stableProposalId(base),
    evidence_quotes: evidenceQuotes,
    falsifier,
    proposed_change_summary: proposedChangeSummary,
    status: validStatus(r.status),
    requires_human_review: true,
    applied_to_disk: false,
    recurrence_count: typeof r.recurrence_count === "number" && Number.isFinite(r.recurrence_count) ? Math.max(1, Math.floor(r.recurrence_count)) : 1,
    first_seen: typeof r.first_seen === "string" && r.first_seen ? r.first_seen : ts,
    last_seen: typeof r.last_seen === "string" && r.last_seen ? r.last_seen : ts,
    audit_trace_anchors: auditTraceAnchors,
    source_signal: sourceSignal,
  };
  const disposition = normalizeDisposition(r.disposition);
  if (disposition) normalized.disposition = disposition;
  const operatorReview = normalizeOperatorReview(r.operator_review);
  if (operatorReview) normalized.operator_review = operatorReview;
  return normalized;
}

function mergeStringLists(a: string[], b: string[], maxCount: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...a, ...b]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= maxCount) break;
  }
  return out;
}

function mergeProposal(existing: PromptRevisionProposalRow, incoming: PromptRevisionProposalRow): PromptRevisionProposalRow {
  return {
    ...existing,
    ts: incoming.ts,
    last_seen: incoming.last_seen,
    recurrence_count: Math.max(1, existing.recurrence_count) + 1,
    current_version: incoming.current_version,
    problem_pattern: incoming.problem_pattern,
    evidence_quotes: mergeStringLists(incoming.evidence_quotes, existing.evidence_quotes, EVIDENCE_QUOTE_MAX_COUNT),
    falsifier: incoming.falsifier,
    proposed_change_summary: incoming.proposed_change_summary,
    audit_trace_anchors: mergeStringLists(incoming.audit_trace_anchors, existing.audit_trace_anchors, AUDIT_ANCHOR_MAX_COUNT),
    source_signal: incoming.source_signal,
    requires_human_review: true,
    applied_to_disk: false,
    // Human/operator review survives deterministic recurrence updates.
    ...(existing.disposition ? { disposition: existing.disposition } : {}),
    ...(existing.operator_review ? { operator_review: existing.operator_review } : {}),
  };
}

export function appendPromptRevisionProposals(
  rows: unknown[],
  settings: SedimentSettings,
): AppendPromptRevisionProposalsResult {
  try {
    const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) => normalizeRow(row, settings));
    const validRows = normalizedRows.filter((row): row is PromptRevisionProposalRow => row !== null);
    const invalidCount = normalizedRows.length - validRows.length;
    if (validRows.length === 0) {
      const existingCount = readPromptRevisionProposals(settings).length;
      return { ok: true, written: false, proposals_upserted: 0, rows_total: existingCount, invalid_count: invalidCount };
    }
    const locked = withFileLock(promptRevisionProposalsLockPath(), () => {
      const existing = readJsonlTail<unknown>(promptRevisionProposalsPath())
        .map((row) => normalizeRow(row, settings))
        .filter((row): row is PromptRevisionProposalRow => row !== null);
      const byId = new Map(existing.map((row) => [row.proposal_id, row]));
      let upserted = 0;
      for (const row of validRows) {
        const prev = byId.get(row.proposal_id);
        byId.set(row.proposal_id, prev ? mergeProposal(prev, row) : row);
        upserted++;
      }
      const allRows = [...byId.values()]
        .sort((a, b) => (b.last_seen > a.last_seen ? 1 : b.last_seen < a.last_seen ? -1 : a.proposal_id.localeCompare(b.proposal_id)))
        .slice(0, PROPOSALS_MAX_ROWS);
      const enriched = allRows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(promptRevisionProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return { upserted, rowsTotal: allRows.length };
    });
    if (!locked.ok) return { ok: false, written: false, proposals_upserted: 0, rows_total: 0, invalid_count: invalidCount, error: "proposal_lock_contention" };
    return { ok: true, written: true, proposals_upserted: locked.value.upserted, rows_total: locked.value.rowsTotal, invalid_count: invalidCount };
  } catch (e) {
    return { ok: false, written: false, proposals_upserted: 0, rows_total: 0, invalid_count: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export function readPromptRevisionProposals(settings: SedimentSettings, projectRoot?: string): PromptRevisionProposalRow[] {
  const rows = readJsonlTail<unknown>(promptRevisionProposalsPath())
    .map((row) => normalizeRow(row, settings))
    .filter((row): row is PromptRevisionProposalRow => row !== null);
  if (!projectRoot) return rows;
  const normalized = normalizeProjectRoot(projectRoot);
  return rows.filter((row) => row.project_root === normalized);
}

function promptRevisionSignals(summary: AggregatorSummary | (Partial<AggregatorSummary> & Record<string, unknown>)): PromptRevisionSignalEnvelope {
  const value = (summary as Record<string, unknown>).prompt_revision_signals;
  return value && typeof value === "object" ? value as PromptRevisionSignalEnvelope : {};
}

export function buildPromptRevisionProposalsFromAggregatorSummary(
  summary: AggregatorSummary | (Partial<AggregatorSummary> & Record<string, unknown>),
  settings: SedimentSettings,
  now: Date = new Date(),
): PromptRevisionProposalRow[] {
  const projectRoot = normalizeProjectRoot(summary.project_root);
  if (!projectRoot) return [];
  const ts = formatLocalIsoTimestamp(now);
  const signals = promptRevisionSignals(summary).reinforced_classifier_prompt_patterns;
  if (!Array.isArray(signals)) return [];
  const rows: PromptRevisionProposalRow[] = [];
  for (const signal of signals) {
    if (!signal || typeof signal !== "object") continue;
    if (signal.signal_type !== "classifier_prompt_pattern" || signal.reinforced !== true) continue;
    const targetPrompt = validTargetPrompt(signal.target_prompt, settings);
    const sourceSignal = validSource(signal.source_signal);
    if (!targetPrompt || !sourceSignal) continue;
    const row = normalizeRow({
      schema_version: 1,
      ts,
      project_root: projectRoot,
      target_prompt: targetPrompt,
      current_version: settings.promptVersion[targetPrompt],
      problem_pattern: signal.problem_pattern,
      evidence_quotes: signal.evidence_quotes,
      falsifier: signal.falsifier,
      proposed_change_summary: signal.proposed_change_summary,
      status: "proposed",
      requires_human_review: true,
      applied_to_disk: false,
      recurrence_count: 1,
      first_seen: ts,
      last_seen: ts,
      audit_trace_anchors: signal.audit_trace_anchors,
      source_signal: sourceSignal,
    }, settings);
    if (row) rows.push(row);
  }
  return rows;
}
