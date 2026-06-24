import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendConstraintEvidenceEvent, constraintEvidenceAllowedStateRoot, guardConstraintEvidencePath, type ConstraintEvidenceAppendResult } from "./append";
import { sha256Hex } from "./hash-envelope";
import type { ConstraintEvidenceEventBodyV1, ConstraintEvidenceScopeContext } from "./types";
import { CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION } from "./types";

export interface ConstraintEvidenceTier1SignalInput {
  user_quote?: string | null;
  correction_intent?: string | null;
  scope_description?: string | null;
  confidence?: number | null;
  provenance?: string | null;
  quote_source?: string | null;
  is_directive?: boolean | null;
}

export interface ConstraintEvidenceTier1DraftInput {
  title: string;
  body: string;
  entryConfidence: number;
  triggerPhrases?: string[];
  // ADR0039 injectMode carry-through: the Tier-1 rule draft already decides
  // always|listed (buildTier1RuleDraft hardcodes "always" today). Recording it
  // on the evidence event lets the constraint compiler emit a real injectMode
  // for event-sourced constraints instead of defaulting to "none" (which made
  // project-scoped constraints non-injectable).
  injectMode?: "always" | "listed";
}

export interface BuildTier1ConstraintEvidenceEventOptions {
  signal: ConstraintEvidenceTier1SignalInput;
  draft: ConstraintEvidenceTier1DraftInput;
  sessionId: string;
  turnId: string;
  projectId: string;
  cwd: string;
  createdAtUtc: string;
  correlationId: string;
  candidateId: string;
  settingsHash?: string;
  deviceId?: string;
}

export interface AppendTier1ConstraintEvidenceEventOptions extends BuildTier1ConstraintEvidenceEventOptions {
  abrainHome: string;
}

export interface AppendTier1ConstraintEvidenceEventResult {
  body: ConstraintEvidenceEventBodyV1;
  append: ConstraintEvidenceAppendResult;
  auditPath?: string;
  statusPath?: string;
}

export async function appendTier1ConstraintEvidenceEvent(
  options: AppendTier1ConstraintEvidenceEventOptions,
): Promise<AppendTier1ConstraintEvidenceEventResult> {
  const body = buildTier1ConstraintEvidenceEventBody(options);
  const append = await appendConstraintEvidenceEvent({ abrainHome: options.abrainHome, body });
  const state = await writeRuntimeState({ ...options, body, append });
  return { body, append, ...state };
}

export function buildTier1ConstraintEvidenceEventBody(
  options: BuildTier1ConstraintEvidenceEventOptions,
): ConstraintEvidenceEventBodyV1 {
  const quote = normalizedQuote(options.signal, options.draft);
  const scope = conservativeScopeContext(options);
  const quoteHash = sha256Hex(quote);
  return {
    event_schema_version: CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION,
    event_type: "constraint_signal_observed",
    created_at_utc: options.createdAtUtc,
    device_id: options.deviceId || "unknown-device",
    producer_nonce: deterministicProducerNonce(options, quoteHash),
    actor: { role: "user", id: "agent-end-tier1" },
    causal_parents: [],
    session_id: options.sessionId,
    turn_id: options.turnId,
    source: {
      channel: "agent_end",
      source_role: "user",
      source_ref: `agent_end:${options.sessionId}/${options.turnId}:${options.candidateId}`,
      quote_hash: quoteHash,
    },
    intent: {
      domain_hint: "constraint",
      operation_hint: "create",
      confidence: clampConfidence(options.signal.confidence ?? options.draft.entryConfidence),
    },
    payload: {
      sanitized_quote: quote,
      candidate_constraint_text: options.draft.body,
      candidate_title: options.draft.title,
      candidate_trigger_phrases: triggerPhrases(options.signal, options.draft),
      candidate_applies_when: options.signal.scope_description || "durable user directive observed in agent_end",
      candidate_priority_hint: options.draft.injectMode ?? "unknown",
    },
    scope,
    sanitizer: {
      sanitizer_name: "sediment.correction-pipeline",
      sanitizer_version: "v1",
      status: "passed",
      replacements_count: 0,
    },
    neighbor_summary: {
      retrieval_mode: "readonly",
      input_hash: sha256Hex(`${options.sessionId}\n${options.turnId}\n${quoteHash}`),
      neighbor_refs: [],
      summary: "PR5 runtime integration records witnessed Tier-1 signal before legacy rule adjudication; no live memory neighbors are queried by the event writer.",
    },
    producer: {
      name: "sediment.constraint-event-writer",
      version: "adr0039-p2-pr5",
      code_version: "agent-end-tier1-default-off",
      ...(options.settingsHash ? { settings_hash: options.settingsHash } : {}),
    },
    legacy_parallel_write: {
      attempted: true,
      legacy_path_kind: "tier1_ruleset_adjudicator",
      legacy_operation_hint: "create",
      legacy_audit_ref: `audit:${options.sessionId}:${options.turnId}:${options.candidateId}`,
    },
    privacy: { contains_user_quote: true, redaction_level: "none" },
  };
}

async function writeRuntimeState(options: AppendTier1ConstraintEvidenceEventOptions & {
  body: ConstraintEvidenceEventBodyV1;
  append: ConstraintEvidenceAppendResult;
}): Promise<{ auditPath?: string; statusPath?: string }> {
  const stateRoot = constraintEvidenceAllowedStateRoot(options.abrainHome);
  const auditPath = path.join(stateRoot, "runtime", "append-audit.jsonl");
  const statusPath = path.join(stateRoot, "runtime", "projection-status.jsonl");
  const auditGuard = guardConstraintEvidencePath({ abrainHome: options.abrainHome, targetPath: auditPath, allowState: true });
  const statusGuard = guardConstraintEvidencePath({ abrainHome: options.abrainHome, targetPath: statusPath, allowState: true });
  if (!auditGuard.ok || !statusGuard.ok) return {};
  const observedAtUtc = options.createdAtUtc;
  const eventId = options.append.eventId ?? options.body.source.quote_hash;
  const diagnostics = options.append.diagnostics.map((diagnostic) => diagnostic.code);
  const auditRow = {
    schemaVersion: "constraint-evidence-runtime-audit/v1",
    observedAtUtc,
    sessionId: options.sessionId,
    turnId: options.turnId,
    correlationId: options.correlationId,
    candidateId: options.candidateId,
    ok: options.append.ok,
    status: options.append.status,
    eventId,
    filePath: options.append.filePath ?? null,
    diagnostics,
    sanitizedQuoteHash: options.body.source.quote_hash,
    retryEligible: options.append.ok ? false : options.append.status === "write_failed",
  };
  const statusRow = {
    eventId,
    status: options.append.ok ? "queued" : "append_failed",
    observedAtUtc,
  };
  try {
    await appendJsonLine(auditPath, auditRow);
    await appendJsonLine(statusPath, statusRow);
    return { auditPath, statusPath };
  } catch {
    return {};
  }
}

async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

function normalizedQuote(
  signal: ConstraintEvidenceTier1SignalInput,
  draft: ConstraintEvidenceTier1DraftInput,
): string {
  const quote = typeof signal.user_quote === "string" ? signal.user_quote.trim() : "";
  if (quote) return quote;
  return draft.body.trim() || draft.title.trim() || "Tier-1 user directive observed in agent_end";
}

function conservativeScopeContext(options: BuildTier1ConstraintEvidenceEventOptions): ConstraintEvidenceScopeContext {
  const text = `${options.signal.scope_description ?? ""}\n${options.signal.correction_intent ?? ""}\n${options.signal.user_quote ?? ""}`;
  if (/(全局|所有项目|任何项目|global|all projects|cross-project)/i.test(text)) {
    return {
      active_project_binding: {
        project_id: options.projectId,
        binding_reason: "active project binding at agent_end",
        cwd_hash: sha256Hex(options.cwd),
      },
      scope_hint: { kind: "global", evidence: "explicit global wording in witnessed signal" },
      scope_confidence: 0.7,
    };
  }
  if (options.projectId) {
    return {
      active_project_binding: {
        project_id: options.projectId,
        binding_reason: "active project binding at agent_end",
        cwd_hash: sha256Hex(options.cwd),
      },
      scope_hint: { kind: "project", project_id: options.projectId, evidence: "no explicit global evidence at append time" },
      scope_confidence: 0.65,
    };
  }
  return {
    active_project_binding: { binding_reason: "no active project binding available at append time" },
    scope_hint: { kind: "unknown", reason: "no project binding available at append time" },
    scope_confidence: 0.2,
  };
}

function deterministicProducerNonce(options: BuildTier1ConstraintEvidenceEventOptions, quoteHash: string): string {
  return sha256Hex([
    "adr0039-p2-pr5",
    options.sessionId,
    options.turnId,
    options.candidateId,
    quoteHash,
  ].join("\n"));
}

function clampConfidence(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, Number(value) / 10));
}

function triggerPhrases(
  _signal: ConstraintEvidenceTier1SignalInput,
  draft: ConstraintEvidenceTier1DraftInput,
): string[] {
  const out = new Set<string>();
  for (const phrase of draft.triggerPhrases ?? []) {
    const normalized = phrase.trim();
    if (normalized) out.add(normalized);
  }
  return [...out].sort();
}
