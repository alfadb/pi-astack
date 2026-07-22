/**
 * Deterministic prompt-revision proposal read model.
 *
 * Proposals always receive an autonomous terminal disposition. LLM claims,
 * consensus, footnotes, silence, or exposure cannot reopen a proposal; only a
 * newly observed independent outcome Evidence Event that is both reliably
 * attributed and bound to this proposal's stable proposal_id can do so.
 * Ordinary project outcomes lack proposal_id and therefore fail closed to
 * defer_until_new_evidence. This module never modifies prompt files or
 * promptVersion settings; a future dedicated producer may emit proposal-bound
 * attributed outcomes without auto-applying prompt changes.
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
import { resolveIndependentOutcomeEvidenceEventIds } from "./outcome-evidence";
import type { AggregatorSummary } from "./aggregator";
import type { SedimentSettings } from "./settings";

export type PromptRevisionProposalStatus = "accepted_for_future_revision" | "rejected" | "deferred_until_new_evidence" | "superseded";
export type PromptRevisionDispositionDecision = "accept_for_future_revision" | "reject" | "defer_until_new_evidence";
export type PromptRevisionTargetPrompt = keyof SedimentSettings["promptVersion"];
export type PromptRevisionSignalSource = "classifier_health" | "evolution_hypothesis";

export interface PromptRevisionAgentDisposition {
  decision: PromptRevisionDispositionDecision;
  reason: string;
  ts: string;
  actor: "sediment.prompt-revision-agent";
  independent_evidence_event_ids: string[];
}

export interface PromptRevisionProposalRow {
  schema_version: 2;
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
  requires_human_review: false;
  applied_to_disk: false;
  recurrence_count: number;
  first_seen: string;
  last_seen: string;
  audit_trace_anchors: string[];
  source_signal: PromptRevisionSignalSource;
  agent_disposition: PromptRevisionAgentDisposition;
  seen_independent_evidence_event_ids: string[];
  reopen_count: number;
  last_reopened_at?: string;
  /** Historical v1 fields are audit-only and never restore a human queue. */
  legacy_review?: {
    status?: string;
    disposition?: Record<string, unknown>;
    operator_review?: Record<string, unknown>;
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
  independent_evidence_event_ids?: string[];
  agent_disposition?: {
    decision?: PromptRevisionDispositionDecision;
    reason?: string;
  };
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
    const text = clip(item, maxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxCount) break;
  }
  return out;
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
    } finally { fs.closeSync(fd); }
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const out: T[] = [];
    for (const line of raw.split("\n").map((item) => item.trim()).filter(Boolean)) {
      try { out.push(JSON.parse(line) as T); } catch { /* derived corrupt line ignored */ }
    }
    return out;
  } catch { return []; }
}

function validTargetPrompt(value: unknown, settings: SedimentSettings): PromptRevisionTargetPrompt | undefined {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(settings.promptVersion, value)
    ? value as PromptRevisionTargetPrompt
    : undefined;
}

function validSource(value: unknown): PromptRevisionSignalSource | undefined {
  return value === "classifier_health" || value === "evolution_hypothesis" ? value : undefined;
}

function requestedDecision(value: unknown): { decision: PromptRevisionDispositionDecision; reason: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const decision = row.decision === "accept_for_future_revision" || row.decision === "reject" || row.decision === "defer_until_new_evidence"
    ? row.decision
    : undefined;
  const reason = clip(row.reason);
  return decision && reason ? { decision, reason } : undefined;
}

function statusForDecision(decision: PromptRevisionDispositionDecision): PromptRevisionProposalStatus {
  if (decision === "accept_for_future_revision") return "accepted_for_future_revision";
  if (decision === "reject") return "rejected";
  return "deferred_until_new_evidence";
}

function containsForbiddenPromptDiffField(row: Record<string, unknown>): boolean {
  return Object.keys(row).some((key) => {
    const normalized = key.toLowerCase();
    return normalized.includes("diff") || normalized.includes("patch") || normalized === "full_prompt" || normalized === "prompt_full_text";
  });
}

function stableProposalId(row: Pick<PromptRevisionProposalRow, "project_root" | "target_prompt" | "current_version" | "problem_pattern">): string {
  const basis = [row.project_root, row.target_prompt, row.current_version, row.problem_pattern].join("\0");
  return `prp-${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

function legacyReview(row: Record<string, unknown>): PromptRevisionProposalRow["legacy_review"] | undefined {
  if (row.schema_version === 2 && row.legacy_review && typeof row.legacy_review === "object") return row.legacy_review as PromptRevisionProposalRow["legacy_review"];
  const status = typeof row.status === "string" ? row.status : undefined;
  const disposition = row.disposition && typeof row.disposition === "object" ? row.disposition as Record<string, unknown> : undefined;
  const operatorReview = row.operator_review && typeof row.operator_review === "object" ? row.operator_review as Record<string, unknown> : undefined;
  if (!status && !disposition && !operatorReview) return undefined;
  return { ...(status ? { status } : {}), ...(disposition ? { disposition } : {}), ...(operatorReview ? { operator_review: operatorReview } : {}) };
}

function normalizeRow(row: unknown, settings: SedimentSettings): PromptRevisionProposalRow | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as Record<string, unknown>;
  if (containsForbiddenPromptDiffField(raw)) return null;
  const projectRoot = normalizeProjectRoot(raw.project_root);
  const targetPrompt = validTargetPrompt(raw.target_prompt, settings);
  const sourceSignal = validSource(raw.source_signal);
  const problemPattern = clip(raw.problem_pattern);
  const falsifier = clip(raw.falsifier);
  const proposedChangeSummary = clip(raw.proposed_change_summary);
  const evidenceQuotes = clipList(raw.evidence_quotes, EVIDENCE_QUOTE_MAX_COUNT, EVIDENCE_QUOTE_MAX_CHARS);
  const auditTraceAnchors = clipList(raw.audit_trace_anchors, AUDIT_ANCHOR_MAX_COUNT, AUDIT_ANCHOR_MAX_CHARS);
  if (!projectRoot || !targetPrompt || !sourceSignal || !problemPattern || !falsifier || !proposedChangeSummary || evidenceQuotes.length === 0 || auditTraceAnchors.length === 0) return null;
  const ts = typeof raw.ts === "string" && raw.ts ? raw.ts : formatLocalIsoTimestamp();
  const currentVersion = typeof raw.current_version === "string" && raw.current_version ? clip(raw.current_version, 80) : settings.promptVersion[targetPrompt];
  const base = { project_root: projectRoot, target_prompt: targetPrompt, current_version: currentVersion, problem_pattern: problemPattern };
  const proposalId = typeof raw.proposal_id === "string" && raw.proposal_id
    ? raw.proposal_id
    : stableProposalId(base as Pick<PromptRevisionProposalRow, "project_root" | "target_prompt" | "current_version" | "problem_pattern">);
  // Fail closed unless evidence is attributed and exactly bound to this proposal.
  const verifiedIds = resolveIndependentOutcomeEvidenceEventIds(
    raw.independent_evidence_event_ids ?? raw.seen_independent_evidence_event_ids ?? (raw.agent_disposition as Record<string, unknown> | undefined)?.independent_evidence_event_ids,
    projectRoot,
    { requireReliableAttribution: true, targetProposalId: proposalId },
  );
  const requested = requestedDecision(raw.agent_disposition ?? raw.requested_disposition);
  const decision: PromptRevisionDispositionDecision = verifiedIds.length > 0 && requested ? requested.decision : "defer_until_new_evidence";
  const reason = verifiedIds.length > 0 && requested
    ? requested.reason
    : "No new independent outcome evidence is bound to this proposal; LLM signal/consensus alone cannot authorize prompt revision.";
  const legacy = legacyReview(raw);
  return {
    schema_version: 2,
    ts,
    ...base,
    proposal_id: proposalId,
    evidence_quotes: evidenceQuotes,
    falsifier,
    proposed_change_summary: proposedChangeSummary,
    status: statusForDecision(decision),
    requires_human_review: false,
    applied_to_disk: false,
    recurrence_count: typeof raw.recurrence_count === "number" && Number.isFinite(raw.recurrence_count) ? Math.max(1, Math.floor(raw.recurrence_count)) : 1,
    first_seen: typeof raw.first_seen === "string" && raw.first_seen ? raw.first_seen : ts,
    last_seen: typeof raw.last_seen === "string" && raw.last_seen ? raw.last_seen : ts,
    audit_trace_anchors: auditTraceAnchors,
    source_signal: sourceSignal,
    agent_disposition: {
      decision,
      reason,
      ts: typeof (raw.agent_disposition as Record<string, unknown> | undefined)?.ts === "string" ? String((raw.agent_disposition as Record<string, unknown>).ts) : ts,
      actor: "sediment.prompt-revision-agent",
      independent_evidence_event_ids: verifiedIds,
    },
    seen_independent_evidence_event_ids: verifiedIds,
    reopen_count: typeof raw.reopen_count === "number" && Number.isFinite(raw.reopen_count) ? Math.max(0, Math.floor(raw.reopen_count)) : 0,
    ...(typeof raw.last_reopened_at === "string" && raw.last_reopened_at ? { last_reopened_at: raw.last_reopened_at } : {}),
    ...(legacy ? { legacy_review: legacy } : {}),
  };
}

function mergeProposal(existing: PromptRevisionProposalRow, incoming: PromptRevisionProposalRow): PromptRevisionProposalRow {
  const newEvidence = incoming.seen_independent_evidence_event_ids.filter((id) => !existing.seen_independent_evidence_event_ids.includes(id));
  const reopened = newEvidence.length > 0;
  const disposition = reopened ? incoming.agent_disposition : existing.agent_disposition;
  const allEvidence = mergeStringLists(existing.seen_independent_evidence_event_ids, incoming.seen_independent_evidence_event_ids, 100);
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
    status: statusForDecision(disposition.decision),
    requires_human_review: false,
    applied_to_disk: false,
    agent_disposition: { ...disposition, independent_evidence_event_ids: allEvidence },
    seen_independent_evidence_event_ids: allEvidence,
    reopen_count: existing.reopen_count + (reopened ? 1 : 0),
    ...(reopened ? { last_reopened_at: incoming.ts } : existing.last_reopened_at ? { last_reopened_at: existing.last_reopened_at } : {}),
    ...(existing.legacy_review ? { legacy_review: existing.legacy_review } : {}),
  };
}

export function appendPromptRevisionProposals(rows: unknown[], settings: SedimentSettings): AppendPromptRevisionProposalsResult {
  try {
    const normalized = (Array.isArray(rows) ? rows : []).map((row) => normalizeRow(row, settings));
    const valid = normalized.filter((row): row is PromptRevisionProposalRow => row !== null);
    const invalidCount = normalized.length - valid.length;
    if (valid.length === 0) {
      return { ok: true, written: false, proposals_upserted: 0, rows_total: readPromptRevisionProposals(settings).length, invalid_count: invalidCount };
    }
    const locked = withFileLock(promptRevisionProposalsLockPath(), () => {
      const existing = readJsonlTail<unknown>(promptRevisionProposalsPath()).map((row) => normalizeRow(row, settings)).filter((row): row is PromptRevisionProposalRow => row !== null);
      const byId = new Map(existing.map((row) => [row.proposal_id, row]));
      for (const row of valid) byId.set(row.proposal_id, byId.has(row.proposal_id) ? mergeProposal(byId.get(row.proposal_id)!, row) : row);
      const allRows = [...byId.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen) || a.proposal_id.localeCompare(b.proposal_id)).slice(0, PROPOSALS_MAX_ROWS);
      const enriched = allRows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(promptRevisionProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return allRows.length;
    });
    if (!locked.ok) return { ok: false, written: false, proposals_upserted: 0, rows_total: 0, invalid_count: invalidCount, error: "proposal_lock_contention" };
    return { ok: true, written: true, proposals_upserted: valid.length, rows_total: locked.value, invalid_count: invalidCount };
  } catch (error) {
    return { ok: false, written: false, proposals_upserted: 0, rows_total: 0, invalid_count: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readPromptRevisionProposals(settings: SedimentSettings, projectRoot?: string): PromptRevisionProposalRow[] {
  const rows = readJsonlTail<unknown>(promptRevisionProposalsPath()).map((row) => normalizeRow(row, settings)).filter((row): row is PromptRevisionProposalRow => row !== null);
  if (!projectRoot) return rows;
  const normalized = normalizeProjectRoot(projectRoot);
  return rows.filter((row) => row.project_root === normalized);
}

function promptRevisionSignals(summary: AggregatorSummary | (Partial<AggregatorSummary> & Record<string, unknown>)): PromptRevisionSignalEnvelope {
  const direct = (summary as Record<string, unknown>).prompt_revision_signals;
  if (direct && typeof direct === "object") return direct as PromptRevisionSignalEnvelope;
  const promptNative = (summary as Record<string, unknown>).prompt_native;
  const nested = promptNative && typeof promptNative === "object"
    ? (promptNative as Record<string, unknown>).prompt_revision_signals
    : undefined;
  return nested && typeof nested === "object" ? nested as PromptRevisionSignalEnvelope : {};
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
    if (!signal || typeof signal !== "object" || signal.signal_type !== "classifier_prompt_pattern" || signal.reinforced !== true) continue;
    const targetPrompt = validTargetPrompt(signal.target_prompt, settings);
    const sourceSignal = validSource(signal.source_signal);
    if (!targetPrompt || !sourceSignal) continue;
    const row = normalizeRow({
      schema_version: 2,
      ts,
      project_root: projectRoot,
      target_prompt: targetPrompt,
      current_version: settings.promptVersion[targetPrompt],
      problem_pattern: signal.problem_pattern,
      evidence_quotes: signal.evidence_quotes,
      falsifier: signal.falsifier,
      proposed_change_summary: signal.proposed_change_summary,
      recurrence_count: 1,
      first_seen: ts,
      last_seen: ts,
      audit_trace_anchors: signal.audit_trace_anchors,
      source_signal: sourceSignal,
      independent_evidence_event_ids: signal.independent_evidence_event_ids ?? [],
      agent_disposition: signal.agent_disposition ?? { decision: "defer_until_new_evidence", reason: "Awaiting a new independent outcome Evidence Event." },
    }, settings);
    if (row) rows.push(row);
  }
  return rows;
}
