import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, durableAtomicWriteFile } from "../_shared/durable-write";
import { canonicalizeJcs, jcsSha256Hex, normalizeJcsValueOmittingUndefined, sha256Hex } from "../_shared/jcs";
import {
  expectedL1EventPath,
  loadL1SchemaRegistry,
  validateL1Envelope,
  validateL1WritePreflight,
} from "../_shared/l1-schema-registry";
import { resolveUserGlobalAbrainHome } from "../_shared/runtime";
import { atomicWriteText, withFileLock } from "../_shared/sync-file-lock";
import { isMemoryEntryReadToolName } from "../_shared/tool-name-compat";
import { sanitizeForMemory } from "./sanitizer";

export const OUTCOME_EVIDENCE_ENVELOPE_SCHEMA = "outcome-evidence-envelope/v1" as const;
export const OUTCOME_EVIDENCE_BODY_SCHEMA = "outcome-evidence-event/v1" as const;
export const OUTCOME_EVIDENCE_INDEX_SCHEMA = "outcome-evidence-index/v1" as const;
export const OUTCOME_EVIDENCE_PRODUCER = "sediment.outcome-evidence-writer" as const;

export type OutcomeEvidenceEventType =
  | "memory_exposure_observed"
  | "action_outcome_observed"
  | "natural_correction_observed"
  | "outcome_rejudge_recorded"
  | "proposal_disposition_recorded";

export type OutcomeObservationKind =
  | "test"
  | "lint"
  | "build"
  | "workflow"
  | "tool"
  | "git_revert"
  | "git_rewrite"
  | "natural_correction";

export type OutcomeTerminalStatus = "passed" | "failed" | "degraded" | "cancelled" | "unknown";
export type OutcomeAttributionStatus = "attributed" | "corroborated" | "unknown";
export type OutcomeRejudgeDecision =
  | "supporting_evidence_observed"
  | "contradicting_evidence_observed"
  | "reconsider"
  | "defer_until_new_evidence";

export interface OutcomeEvidenceAttribution {
  status: OutcomeAttributionStatus;
  basis:
    | "exact_user_correction_target"
    | "independent_result_plus_exact_self_report"
    | "causal_anchor_only"
    | "no_reliable_join";
  memory_entry_slugs: string[];
  exposure_event_ids: string[];
  candidate_exposure_event_ids: string[];
  limitations: string[];
}

export interface OutcomeEvidenceBodyV1 {
  event_schema_version: typeof OUTCOME_EVIDENCE_BODY_SCHEMA;
  event_type: OutcomeEvidenceEventType;
  created_at_utc: string;
  device_id: string;
  producer_nonce: string;
  actor: { role: "user" | "assistant" | "system" | "tool"; id: string };
  causal_parents: string[];
  session_id: string;
  turn_id: string;
  source: {
    channel: "agent_end" | "tool_result" | "production_command" | "replay";
    source_role: "user" | "assistant" | "system" | "tool";
    source_ref: string;
    source_ref_hash: string;
  };
  intent: {
    domain_hint: "knowledge";
    operation_hint: "exposure" | "action_outcome" | "natural_correction" | "rejudge" | "proposal_disposition";
  };
  project: {
    project_root_hash: string;
  };
  payload: Record<string, unknown>;
  attribution: OutcomeEvidenceAttribution;
  evidence: {
    independence: "independent_execution" | "user_authored" | "self_report" | "exposure_only" | "llm_judgment";
    strength: "high" | "medium" | "insufficient";
    direct_memory_lifecycle_authority: false;
  };
  sanitizer: {
    sanitizer_name: "sediment.sanitizer";
    sanitizer_version: "v1";
    status: "passed" | "redacted" | "blocked";
    replacements_count: number;
    blocked_reason?: string;
  };
  producer: {
    name: typeof OUTCOME_EVIDENCE_PRODUCER;
    version: "rm-outcome-001-v1";
  };
}

export interface OutcomeEvidenceEnvelopeV1 {
  schema: typeof OUTCOME_EVIDENCE_ENVELOPE_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_alg: "sha256";
  event_id: string;
  body_hash: string;
  body: OutcomeEvidenceBodyV1;
}

export interface OutcomeEvidenceIndexRow {
  schema_version: typeof OUTCOME_EVIDENCE_INDEX_SCHEMA;
  event_id: string;
  event_type: OutcomeEvidenceEventType;
  created_at_utc: string;
  session_id: string;
  turn_id: string;
  project_root_hash: string;
  causal_parents: string[];
  observation_kind?: OutcomeObservationKind | "memory_exposure" | "rejudge" | "proposal_disposition";
  terminal_status?: OutcomeTerminalStatus;
  attribution_status: OutcomeAttributionStatus;
  memory_entry_slugs: string[];
  exposure_event_ids: string[];
  candidate_exposure_event_ids: string[];
  evidence_independence: OutcomeEvidenceBodyV1["evidence"]["independence"];
  evidence_strength: OutcomeEvidenceBodyV1["evidence"]["strength"];
  rejudge_decision?: OutcomeRejudgeDecision;
  proposal_id?: string;
}

export interface AppendOutcomeEvidenceResult {
  ok: boolean;
  status: "appended" | "idempotent_duplicate" | "invalid" | "blocked" | "collision" | "write_failed";
  eventId?: string;
  filePath?: string;
  envelope?: OutcomeEvidenceEnvelopeV1;
  error?: string;
}

export interface OutcomeEvidenceSpineSummary {
  events: number;
  exposures: number;
  outcomes: number;
  independent_outcomes: number;
  attributed: number;
  corroborated: number;
  unknown: number;
  rejudged: number;
  deferred_until_new_evidence: number;
  natural_corrections: number;
  recent_independent_evidence: Array<{
    event_id: string;
    observation_kind?: OutcomeEvidenceIndexRow["observation_kind"];
    terminal_status?: OutcomeTerminalStatus;
    attribution_status: OutcomeAttributionStatus;
    memory_entry_slugs: string[];
  }>;
  recent_independent_evidence_event_ids: string[];
}

interface ExposureRecord {
  eventId: string;
  slug: string;
  sourceKind: "path_a" | "memory_tool";
}

interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultRecord {
  id: string;
  name: string;
  content: string;
  details?: Record<string, unknown>;
  isError: boolean;
  createdAt: string;
}

interface PathALedgerRow {
  inject_id?: unknown;
  outcome?: unknown;
  injected_slugs?: unknown;
  session_id?: unknown;
  turn_id?: unknown;
  ts?: unknown;
  timestamp?: unknown;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_SOURCE_REF_CHARS = 240;
const MAX_COMMAND_CHARS = 2_000;
const deviceIdPromises = new Map<string, Promise<string>>();

function projectRootHash(projectRoot: string): string {
  return sha256Hex(path.resolve(projectRoot));
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function safeIso(value: unknown, fallback: Date = new Date()): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1_000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}

function sourceRefHash(sourceRef: string): string {
  return sha256Hex(sourceRef);
}

function stableOpaqueRef(prefix: string, value: unknown): string {
  return `${prefix}:${sha256Hex(stableString(value)).slice(0, 24)}`;
}

function stableString(value: unknown): string {
  try { return canonicalizeJcs(normalizeJcsValueOmittingUndefined(value)); }
  catch {
    try { return JSON.stringify(value) ?? String(value); }
    catch { return String(value); }
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const row = part as Record<string, unknown>;
    return row.type === "text" && typeof row.text === "string" ? row.text : "";
  }).join("");
}

function messageOf(entry: unknown): { entry: Record<string, unknown>; message: Record<string, unknown> } | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const outer = entry as Record<string, unknown>;
  if (outer.type === "message" && outer.message && typeof outer.message === "object") {
    return { entry: outer, message: outer.message as Record<string, unknown> };
  }
  if (typeof outer.role === "string") return { entry: outer, message: outer };
  return undefined;
}

function toolCallId(value: Record<string, unknown>): string | undefined {
  for (const key of ["toolCallId", "tool_call_id", "toolResultId", "tool_result_id", "id", "messageId", "message_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function parseJsonPayloads(text: string): unknown[] {
  const out: unknown[] = [];
  if (!text.trim()) return out;
  try { out.push(JSON.parse(text)); } catch { /* non-JSON tool text */ }
  return out;
}

function memorySlugsFromToolResult(result: ToolResultRecord): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const slug = value.replace(/^project:[^:]+:/, "").replace(/^(world|workflow):/, "").replace(/:/g, "-").trim();
    if (!slug || /[\s<>|\\/'"`,()\[\]{}]/.test(slug) || seen.has(slug)) return;
    seen.add(slug);
    slugs.push(slug);
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.slug === "string") add(row.slug);
    if (typeof row.id === "string" && !row.slug) add(row.id);
    for (const key of ["cards", "results", "entrySlugs", "entry_slugs", "_meta"]) {
      if (row[key] !== undefined) walk(row[key]);
    }
  };
  for (const payload of parseJsonPayloads(result.content)) walk(payload);
  if (result.details) walk(result.details);
  return slugs;
}

function parseMemoryFootnoteSlugs(branch: unknown[]): Set<string> {
  const slugs = new Set<string>();
  const fence = /```memory-footnote\s*\n([\s\S]*?)```/g;
  for (const raw of branch) {
    const item = messageOf(raw);
    if (!item || item.message.role !== "assistant") continue;
    const text = contentText(item.message.content);
    let match: RegExpExecArray | null;
    while ((match = fence.exec(text)) !== null) {
      const slugMatch = /^(?:entry|slug):\s*(\S+)\s*$/m.exec(match[1] ?? "");
      if (!slugMatch) continue;
      const slug = slugMatch[1]!.replace(/^project:[^:]+:/, "").replace(/^(world|workflow):/, "").replace(/:/g, "-").trim();
      if (slug) slugs.add(slug);
    }
  }
  return slugs;
}

function extractCallsAndResults(branch: unknown[]): { calls: Map<string, ToolCallRecord>; results: ToolResultRecord[] } {
  const calls = new Map<string, ToolCallRecord>();
  const results: ToolResultRecord[] = [];
  for (const raw of branch) {
    const item = messageOf(raw);
    if (!item) continue;
    const role = String(item.message.role ?? "");
    if (role === "assistant" && Array.isArray(item.message.content)) {
      for (const blockRaw of item.message.content) {
        if (!blockRaw || typeof blockRaw !== "object") continue;
        const block = blockRaw as Record<string, unknown>;
        if (block.type !== "toolCall") continue;
        const id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : undefined;
        const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : undefined;
        if (!id || !name) continue;
        const rawArgs = block.arguments ?? block.args ?? block.input;
        const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
        calls.set(id, { id, name, args });
      }
    }
    if (role !== "toolResult") continue;
    const id = toolCallId(item.message) ?? stableOpaqueRef("tool-result", {
      name: item.message.toolName,
      content: contentText(item.message.content).slice(0, 4_096),
      timestamp: item.message.timestamp ?? item.entry.timestamp,
    });
    const details = item.message.details && typeof item.message.details === "object" && !Array.isArray(item.message.details)
      ? item.message.details as Record<string, unknown>
      : undefined;
    results.push({
      id,
      name: typeof item.message.toolName === "string" ? item.message.toolName : calls.get(id)?.name ?? "unknown",
      content: contentText(item.message.content),
      ...(details ? { details } : {}),
      isError: item.message.isError === true,
      createdAt: safeIso(item.message.timestamp ?? item.entry.timestamp),
    });
  }
  return { calls, results };
}

/** Reject shell control/chaining and non-single-command shapes. */
function isSingleAnchoredCommand(command: string): boolean {
  const raw = command.trim();
  if (!raw || raw.length > MAX_COMMAND_CHARS) return false;
  // No newlines, shell control, redirection, substitution, or chaining.
  if (/[\r\n;|&`$(){}<>]/.test(raw)) return false;
  if (/\s(?:&&|\|\||>>|<<)\s/.test(` ${raw} `)) return false;
  return true;
}

/**
 * Terminal command classifier. Fail-closed: only a single command whose first
 * token is a known test/lint/build/git operation. Substring matches such as
 * `echo "git revert"`, `grep eslint`, or `git log --grep="npm test"` never count.
 */
function classifyCommand(command: string): OutcomeObservationKind | undefined {
  if (!isSingleAnchoredCommand(command)) return undefined;
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^git\s+revert(?:\s|$)/.test(normalized)) return "git_revert";
  if (/^git\s+(?:rebase|reset|cherry-pick)(?:\s|$)/.test(normalized)) return "git_rewrite";
  if (/^git\s+commit(?:\s|$)/.test(normalized) && /(?:\s|^)--amend(?:\s|$)/.test(normalized)) return "git_rewrite";
  if (/^(?:eslint|biome|ruff|golangci-lint)(?:\s|$)/.test(normalized)) return "lint";
  if (/^(?:npm|pnpm|yarn)(?:\s+run)?\s+lint(?:\s|$)/.test(normalized)) return "lint";
  if (/^tsc(?:\s|$)/.test(normalized)) return "build";
  if (/^(?:npm|pnpm|yarn)(?:\s+run)?\s+(?:build|typecheck)(?:\s|$)/.test(normalized)) return "build";
  if (/^(?:node|bun)\s+--test(?:\s|$)/.test(normalized)) return "test";
  if (/^(?:pytest|cargo\s+test|go\s+test)(?:\s|$)/.test(normalized)) return "test";
  if (/^(?:npm|pnpm|yarn)(?:\s+run)?\s+(?:test|smoke)(?:\s|$)/.test(normalized)) return "test";
  return undefined;
}

function hasStructuredTerminalResult(result: ToolResultRecord): boolean {
  if (!result.details) return false;
  return typeof result.details.ok === "boolean"
    || typeof result.details.status === "string"
    || typeof result.details.terminalState === "string"
    || typeof result.details.terminal_state === "string"
    || typeof result.details.exitCode === "number"
    || typeof result.details.exit_code === "number";
}

function classifyToolResult(result: ToolResultRecord, call?: ToolCallRecord): { kind: OutcomeObservationKind; action: Record<string, unknown> } | undefined {
  const name = result.name || call?.name || "unknown";
  if (name === "bash") {
    const command = typeof call?.args.command === "string" ? call.args.command : "";
    const kind = classifyCommand(command);
    if (!kind) return undefined;
    // Bash outcomes also require an explicit terminal exit code/status from the tool runtime.
    if (!hasStructuredTerminalResult(result) && !result.isError) return undefined;
    const sanitized = sanitizeForMemory(clip(command, MAX_COMMAND_CHARS));
    return {
      kind,
      action: {
        kind: "command",
        tool_name: "bash",
        tool_call_id: result.id,
        command: sanitized.text ?? "[redacted]",
        command_hash: sha256Hex(command),
      },
    };
  }
  if (name === "workflow_run" || name === "workflow_validate") {
    if (!hasStructuredTerminalResult(result)) return undefined;
    return { kind: "workflow", action: { kind: "workflow_tool", tool_name: name, tool_call_id: result.id } };
  }
  const detailsKind = typeof result.details?.kind === "string" ? result.details.kind : "";
  if (hasStructuredTerminalResult(result) && /^(?:dispatch_|goal_|workflow_|browser_|web_)/.test(`${name}:${detailsKind}`)) {
    return { kind: "tool", action: { kind: "structured_tool", tool_name: name, tool_call_id: result.id, details_kind: detailsKind || "unknown" } };
  }
  return undefined;
}

function terminalStatus(result: ToolResultRecord): OutcomeTerminalStatus {
  const terminal = result.details?.terminalState ?? result.details?.terminal_state ?? result.details?.status;
  if (terminal === "completed" || terminal === "passed" || terminal === "verified" || terminal === "ok" || terminal === "success") return "passed";
  if (terminal === "degraded") return "degraded";
  if (terminal === "cancelled" || terminal === "canceled") return "cancelled";
  if (terminal === "failed" || terminal === "error" || terminal === "rejected") return "failed";
  if (result.details?.ok === false || result.isError) return "failed";
  if (result.details?.ok === true) return "passed";
  const exitCode = result.details?.exitCode ?? result.details?.exit_code;
  if (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) return exitCode === 0 ? "passed" : "failed";
  return "unknown";
}

function sanitizerRecord(text: string): OutcomeEvidenceBodyV1["sanitizer"] {
  const result = sanitizeForMemory(text);
  const replacements = result.replacements?.length ?? 0;
  if (!result.ok) {
    return {
      sanitizer_name: "sediment.sanitizer",
      sanitizer_version: "v1",
      status: "blocked",
      replacements_count: replacements,
      blocked_reason: result.error || "sanitize_failed",
    };
  }
  return {
    sanitizer_name: "sediment.sanitizer",
    sanitizer_version: "v1",
    status: replacements > 0 ? "redacted" : "passed",
    replacements_count: replacements,
  };
}

async function readOrCreateDeviceId(abrainHome: string): Promise<string> {
  const root = path.resolve(abrainHome);
  const existingPromise = deviceIdPromises.get(root);
  if (existingPromise) return existingPromise;
  const promise = (async () => {
    const stateDir = path.join(root, ".state");
    const file = path.join(stateDir, "device-id");
    const existing = await fsp.readFile(file, "utf-8").catch((err: NodeJS.ErrnoException) => err.code === "ENOENT" ? "" : Promise.reject(err));
    if (/^[A-Za-z0-9-]{8,64}$/.test(existing.trim())) return existing.trim();
    const id = randomUUID();
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await durableAtomicWriteFile(file, `${id}\n`, { mode: 0o600 });
    return id;
  })();
  deviceIdPromises.set(root, promise);
  try { return await promise; }
  catch (error) { deviceIdPromises.delete(root); throw error; }
}

async function createBody(args: {
  abrainHome: string;
  eventType: OutcomeEvidenceEventType;
  createdAt: string;
  producerNonce: string;
  actor: OutcomeEvidenceBodyV1["actor"];
  causalParents?: string[];
  sessionId: string;
  turnId: string | number;
  source: Omit<OutcomeEvidenceBodyV1["source"], "source_ref_hash">;
  operationHint: OutcomeEvidenceBodyV1["intent"]["operation_hint"];
  projectRoot: string;
  payload: Record<string, unknown>;
  attribution: OutcomeEvidenceAttribution;
  independence: OutcomeEvidenceBodyV1["evidence"]["independence"];
  strength: OutcomeEvidenceBodyV1["evidence"]["strength"];
  sanitizerText?: string;
}): Promise<OutcomeEvidenceBodyV1> {
  const sourceRef = clip(args.source.source_ref, MAX_SOURCE_REF_CHARS);
  return {
    event_schema_version: OUTCOME_EVIDENCE_BODY_SCHEMA,
    event_type: args.eventType,
    created_at_utc: safeIso(args.createdAt),
    device_id: await readOrCreateDeviceId(args.abrainHome),
    producer_nonce: clip(args.producerNonce, 300),
    actor: args.actor,
    causal_parents: [...new Set(args.causalParents ?? [])].filter((id) => SHA256_RE.test(id)).sort(),
    session_id: args.sessionId || "unknown",
    turn_id: String(args.turnId ?? "unknown"),
    source: { ...args.source, source_ref: sourceRef, source_ref_hash: sourceRefHash(sourceRef) },
    intent: { domain_hint: "knowledge", operation_hint: args.operationHint },
    project: { project_root_hash: projectRootHash(args.projectRoot) },
    payload: normalizeJcsValueOmittingUndefined(args.payload) as Record<string, unknown>,
    attribution: {
      ...args.attribution,
      memory_entry_slugs: [...new Set(args.attribution.memory_entry_slugs)].sort(),
      exposure_event_ids: [...new Set(args.attribution.exposure_event_ids)].filter((id) => SHA256_RE.test(id)).sort(),
      candidate_exposure_event_ids: [...new Set(args.attribution.candidate_exposure_event_ids)].filter((id) => SHA256_RE.test(id)).sort(),
      limitations: [...new Set(args.attribution.limitations)].sort(),
    },
    evidence: {
      independence: args.independence,
      strength: args.strength,
      direct_memory_lifecycle_authority: false,
    },
    sanitizer: sanitizerRecord(args.sanitizerText ?? stableString(args.payload)),
    producer: { name: OUTCOME_EVIDENCE_PRODUCER, version: "rm-outcome-001-v1" },
  };
}

export function createOutcomeEvidenceEnvelope(body: OutcomeEvidenceBodyV1): OutcomeEvidenceEnvelopeV1 {
  const hash = jcsSha256Hex(body);
  return {
    schema: OUTCOME_EVIDENCE_ENVELOPE_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: hash,
    body_hash: hash,
    body,
  };
}

export function validateOutcomeEvidenceEnvelope(value: unknown): { ok: true; envelope: OutcomeEvidenceEnvelopeV1 } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "envelope_not_object" };
  const envelope = value as OutcomeEvidenceEnvelopeV1;
  if (envelope.schema !== OUTCOME_EVIDENCE_ENVELOPE_SCHEMA || envelope.canonicalization !== "RFC8785-JCS" || envelope.hash_alg !== "sha256") return { ok: false, error: "envelope_metadata_invalid" };
  if (!SHA256_RE.test(envelope.event_id) || envelope.event_id !== envelope.body_hash || envelope.event_id !== jcsSha256Hex(envelope.body)) return { ok: false, error: "envelope_hash_invalid" };
  const body = envelope.body;
  const eventTypes: OutcomeEvidenceEventType[] = ["memory_exposure_observed", "action_outcome_observed", "natural_correction_observed", "outcome_rejudge_recorded", "proposal_disposition_recorded"];
  if (!body || body.event_schema_version !== OUTCOME_EVIDENCE_BODY_SCHEMA || !eventTypes.includes(body.event_type)) return { ok: false, error: "body_schema_invalid" };
  if (!body.session_id || !body.turn_id || !body.device_id || !body.producer_nonce || !body.created_at_utc || Number.isNaN(Date.parse(body.created_at_utc))) return { ok: false, error: "body_identity_missing" };
  if (!Array.isArray(body.causal_parents) || !body.causal_parents.every((id) => SHA256_RE.test(id))) return { ok: false, error: "causal_parents_invalid" };
  if (!body.source || !["agent_end", "tool_result", "production_command", "replay"].includes(body.source.channel) || !body.source.source_ref || body.source.source_ref_hash !== sha256Hex(body.source.source_ref)) return { ok: false, error: "source_invalid" };
  if (!body.intent || body.intent.domain_hint !== "knowledge" || !["exposure", "action_outcome", "natural_correction", "rejudge", "proposal_disposition"].includes(body.intent.operation_hint)) return { ok: false, error: "intent_invalid" };
  if (!body.project || !SHA256_RE.test(body.project.project_root_hash)) return { ok: false, error: "project_invalid" };
  if (!body.attribution || !["attributed", "corroborated", "unknown"].includes(body.attribution.status) || !Array.isArray(body.attribution.memory_entry_slugs) || !Array.isArray(body.attribution.exposure_event_ids) || !Array.isArray(body.attribution.candidate_exposure_event_ids)) return { ok: false, error: "attribution_invalid" };
  if (![...body.attribution.exposure_event_ids, ...body.attribution.candidate_exposure_event_ids].every((id) => SHA256_RE.test(id))) return { ok: false, error: "attribution_event_ids_invalid" };
  if (!body.evidence || !["independent_execution", "user_authored", "self_report", "exposure_only", "llm_judgment"].includes(body.evidence.independence) || !["high", "medium", "insufficient"].includes(body.evidence.strength)) return { ok: false, error: "evidence_invalid" };
  if (body.producer?.name !== OUTCOME_EVIDENCE_PRODUCER || body.producer.version !== "rm-outcome-001-v1") return { ok: false, error: "body_role_invalid" };
  if (!body.sanitizer || !["passed", "redacted", "blocked"].includes(body.sanitizer.status)) return { ok: false, error: "sanitizer_invalid" };
  if (body.sanitizer.status === "blocked") return { ok: false, error: "sanitizer_blocked" };
  if (body.evidence.direct_memory_lifecycle_authority !== false) return { ok: false, error: "lifecycle_authority_invalid" };
  const expectedIndependence = body.event_type === "memory_exposure_observed"
    ? "exposure_only"
    : body.event_type === "natural_correction_observed"
      ? "user_authored"
      : body.event_type === "outcome_rejudge_recorded" || body.event_type === "proposal_disposition_recorded"
        ? "llm_judgment"
        : "independent_execution";
  if (body.evidence.independence !== expectedIndependence) return { ok: false, error: "event_independence_mismatch" };
  if (body.attribution.status === "unknown" && body.attribution.exposure_event_ids.length > 0) return { ok: false, error: "unknown_attribution_has_join" };
  // User-claimed target slugs may remain under unknown attribution, but only with an
  // explicit limitation. Downstream resolvers never treat unknown as reliable.
  if (body.attribution.status === "unknown" && body.attribution.memory_entry_slugs.length > 0 && body.attribution.limitations.length === 0) {
    return { ok: false, error: "unknown_attribution_claimed_targets_need_limitation" };
  }
  return { ok: true, envelope };
}

export async function appendOutcomeEvidenceEvent(abrainHome: string, body: OutcomeEvidenceBodyV1): Promise<AppendOutcomeEvidenceResult> {
  let envelope: OutcomeEvidenceEnvelopeV1;
  try { envelope = createOutcomeEvidenceEnvelope(body); }
  catch (error) { return { ok: false, status: "invalid", error: error instanceof Error ? error.message : String(error) }; }
  const validated = validateOutcomeEvidenceEnvelope(envelope);
  if (!validated.ok) return { ok: false, status: validated.error === "sanitizer_blocked" ? "blocked" : "invalid", envelope, eventId: envelope.event_id, error: validated.error };
  const filePath = expectedL1EventPath(abrainHome, envelope.event_id);
  try {
    await validateL1WritePreflight({
      abrainHome,
      envelope,
      targetPath: filePath,
      expected: { domain: "knowledge", role: "evidence", producer: OUTCOME_EVIDENCE_PRODUCER },
    });
    await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const raw = `${canonicalizeJcs(envelope)}\n`;
    const result = await durableAtomicCreateFile(filePath, raw);
    if (result === "collision") return { ok: false, status: "collision", eventId: envelope.event_id, filePath, envelope, error: "content_address_collision" };
    return { ok: true, status: result === "created" ? "appended" : "idempotent_duplicate", eventId: envelope.event_id, filePath, envelope };
  } catch (error) {
    return { ok: false, status: "write_failed", eventId: envelope.event_id, filePath, envelope, error: error instanceof Error ? error.message : String(error) };
  }
}

export function outcomeEvidenceIndexPath(abrainHome = resolveUserGlobalAbrainHome()): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "outcome-evidence-index.jsonl");
}

function outcomeEvidenceIndexLockPath(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "locks", "outcome-evidence-index.lock");
}

const OUTCOME_INDEX_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const SHARD_NAME_RE = /^[0-9a-f]{2}$/;
const EVENT_FILE_RE = /^[0-9a-f]{64}\.json$/;

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function assertNoSymlinkChain(start: string, end: string): string {
  let current = path.resolve(start);
  const target = path.resolve(end);
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) throw new Error(`symlink_loop:${current}`);
    seen.add(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symlink_rejected:${current}`);
    if (current === target) {
      if (!stat.isDirectory()) throw new Error(`not_directory:${current}`);
      return fs.realpathSync(current);
    }
    if (!stat.isDirectory()) throw new Error(`not_directory:${current}`);
    const rel = path.relative(current, target);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === "..") throw new Error(`path_escape:${target}`);
    const nextSeg = rel.split(path.sep)[0];
    if (!nextSeg || nextSeg === ".") throw new Error(`path_escape:${target}`);
    current = path.join(current, nextSeg);
  }
}

/** Hardened content-address walk (shard/path/symlink/regular-file/max-bytes). */
function listHardenedOutcomeCandidateFiles(abrainHome: string): { files: string[]; rootReal: string } {
  const resolvedHome = path.resolve(abrainHome);
  const homeStat = fs.lstatSync(resolvedHome);
  if (homeStat.isSymbolicLink()) throw new Error(`symlink_rejected:${resolvedHome}`);
  if (!homeStat.isDirectory()) throw new Error(`not_directory:${resolvedHome}`);
  const homeReal = fs.realpathSync(resolvedHome);
  const eventsRoot = path.join(resolvedHome, "l1", "events", "sha256");
  if (!fs.existsSync(eventsRoot)) return { files: [], rootReal: homeReal };
  const rootReal = assertNoSymlinkChain(resolvedHome, eventsRoot);
  if (!isPathInside(homeReal, rootReal)) throw new Error(`path_escape:${eventsRoot}`);
  const files: string[] = [];
  const depth1 = fs.readdirSync(eventsRoot, { withFileTypes: true });
  for (const d1 of depth1) {
    if (d1.name.startsWith(".")) continue;
    const p1 = path.join(eventsRoot, d1.name);
    const s1 = fs.lstatSync(p1);
    if (s1.isSymbolicLink()) throw new Error(`symlink_rejected:${p1}`);
    if (!s1.isDirectory() || !SHARD_NAME_RE.test(d1.name)) continue; // non-shard residue ignored at root
    const depth2 = fs.readdirSync(p1, { withFileTypes: true });
    for (const d2 of depth2) {
      if (d2.name.startsWith(".")) continue;
      const p2 = path.join(p1, d2.name);
      const s2 = fs.lstatSync(p2);
      if (s2.isSymbolicLink()) throw new Error(`symlink_rejected:${p2}`);
      if (!s2.isDirectory() || !SHARD_NAME_RE.test(d2.name)) continue;
      const leaves = fs.readdirSync(p2, { withFileTypes: true });
      for (const leaf of leaves) {
        if (leaf.name.startsWith(".") || leaf.name.endsWith(".tmp") || leaf.name.endsWith(".partial")) continue;
        const file = path.join(p2, leaf.name);
        const ls = fs.lstatSync(file);
        if (ls.isSymbolicLink()) throw new Error(`symlink_rejected:${file}`);
        if (!ls.isFile() || !EVENT_FILE_RE.test(leaf.name)) continue;
        if (ls.size > OUTCOME_INDEX_MAX_EVENT_BYTES) throw new Error(`event_too_large:${file}`);
        const real = fs.realpathSync(file);
        if (!isPathInside(rootReal, real)) throw new Error(`path_escape:${file}`);
        // Filename must match shard prefix.
        const id = leaf.name.slice(0, 64);
        if (id.slice(0, 2) !== d1.name || id.slice(2, 4) !== d2.name) continue;
        files.push(file);
      }
    }
  }
  return { files: files.sort(), rootReal };
}

function indexRow(envelope: OutcomeEvidenceEnvelopeV1): OutcomeEvidenceIndexRow {
  const body = envelope.body;
  const payload = body.payload;
  const observationKind = typeof payload.observation_kind === "string" ? payload.observation_kind as OutcomeEvidenceIndexRow["observation_kind"] : undefined;
  const terminal = typeof payload.terminal_status === "string" ? payload.terminal_status as OutcomeTerminalStatus : undefined;
  const decision = typeof payload.decision === "string" ? payload.decision as OutcomeRejudgeDecision : undefined;
  return {
    schema_version: OUTCOME_EVIDENCE_INDEX_SCHEMA,
    event_id: envelope.event_id,
    event_type: body.event_type,
    created_at_utc: body.created_at_utc,
    session_id: body.session_id,
    turn_id: body.turn_id,
    project_root_hash: body.project.project_root_hash,
    causal_parents: body.causal_parents,
    ...(observationKind ? { observation_kind: observationKind } : {}),
    ...(terminal ? { terminal_status: terminal } : {}),
    attribution_status: body.attribution.status,
    memory_entry_slugs: body.attribution.memory_entry_slugs,
    exposure_event_ids: body.attribution.exposure_event_ids,
    candidate_exposure_event_ids: body.attribution.candidate_exposure_event_ids,
    evidence_independence: body.evidence.independence,
    evidence_strength: body.evidence.strength,
    ...(decision ? { rejudge_decision: decision } : {}),
    ...(typeof payload.proposal_id === "string" ? { proposal_id: payload.proposal_id } : {}),
  };
}

export interface OutcomeEvidenceIndexRebuildResult {
  ok: boolean;
  rows: number;
  /** Loud per-file diagnostics. A single foreign/invalid event never blanks the whole index. */
  diagnostics: string[];
  error?: string;
}

/** Deterministic L3/read-model rebuild. L1 files remain the only semantic SOT. */
export function rebuildOutcomeEvidenceIndex(abrainHome = resolveUserGlobalAbrainHome()): OutcomeEvidenceIndexRebuildResult {
  const resolvedHome = path.resolve(abrainHome);
  try {
    const locked = withFileLock(outcomeEvidenceIndexLockPath(resolvedHome), () => {
      const diagnostics: string[] = [];
      const registry = loadL1SchemaRegistry();
      const { files } = listHardenedOutcomeCandidateFiles(resolvedHome);
      const rows: OutcomeEvidenceIndexRow[] = [];
      for (const file of files) {
        const relativePath = path.relative(resolvedHome, file).split(path.sep).join("/");
        let raw: string;
        try { raw = fs.readFileSync(file, "utf-8"); }
        catch (error) {
          diagnostics.push(`${relativePath}:read_failed:${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch {
          diagnostics.push(`${relativePath}:invalid_json`);
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          diagnostics.push(`${relativePath}:envelope_not_object`);
          continue;
        }
        const schema = (parsed as Record<string, unknown>).schema;
        if (schema !== OUTCOME_EVIDENCE_ENVELOPE_SCHEMA) {
          // Foreign L1 events are loud but non-fatal so legal outcomes remain indexable.
          diagnostics.push(`${relativePath}:foreign_schema:${String(schema ?? "missing")}`);
          continue;
        }
        const valid = validateOutcomeEvidenceEnvelope(parsed);
        if (!valid.ok) {
          diagnostics.push(`${relativePath}:outcome_invalid:${valid.error}`);
          continue;
        }
        try {
          validateL1Envelope(parsed, {
            registry,
            abrainHome: resolvedHome,
            filePath: file,
            relativePath,
            expected: { domain: "knowledge", role: "evidence", producer: OUTCOME_EVIDENCE_PRODUCER },
          });
        } catch (error) {
          diagnostics.push(`${relativePath}:registry_reject:${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        rows.push(indexRow(valid.envelope));
      }
      rows.sort((a, b) => a.created_at_utc.localeCompare(b.created_at_utc) || a.event_id.localeCompare(b.event_id));
      atomicWriteText(outcomeEvidenceIndexPath(resolvedHome), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
      return { rows: rows.length, diagnostics };
    });
    if (!locked.ok) return { ok: false, rows: 0, diagnostics: [], error: "index_lock_contention" };
    return { ok: true, rows: locked.value.rows, diagnostics: locked.value.diagnostics };
  } catch (error) {
    return { ok: false, rows: 0, diagnostics: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function readOutcomeEvidenceIndex(abrainHome = resolveUserGlobalAbrainHome()): OutcomeEvidenceIndexRow[] {
  try {
    if (!fs.existsSync(outcomeEvidenceIndexPath(abrainHome))) return [];
    const rows: OutcomeEvidenceIndexRow[] = [];
    for (const line of fs.readFileSync(outcomeEvidenceIndexPath(abrainHome), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as OutcomeEvidenceIndexRow;
        if (row.schema_version === OUTCOME_EVIDENCE_INDEX_SCHEMA && SHA256_RE.test(row.event_id)) rows.push(row);
      } catch { /* derived corrupt lines are ignored until rebuild */ }
    }
    return rows;
  } catch { return []; }
}

function currentPathAInjections(abrainHome: string, sessionId: string, turnId: string | number, injectIds?: Set<string>): Array<{ injectId: string; slug: string; createdAt: string }> {
  const file = path.join(path.resolve(abrainHome), ".state", "memory", "path-a-ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  const out: Array<{ injectId: string; slug: string; createdAt: string }> = [];
  const seen = new Set<string>();
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let row: PathALedgerRow;
      try { row = JSON.parse(line) as PathALedgerRow; } catch { continue; }
      if (row.outcome !== "injected" || row.session_id !== sessionId || String(row.turn_id) !== String(turnId) || typeof row.inject_id !== "string") continue;
      if (injectIds && !injectIds.has(row.inject_id)) continue;
      if (!Array.isArray(row.injected_slugs)) continue;
      for (const rawSlug of row.injected_slugs) {
        const slug = String(rawSlug ?? "").trim();
        const key = `${row.inject_id}|${slug}`;
        if (!slug || seen.has(key)) continue;
        seen.add(key);
        out.push({ injectId: row.inject_id, slug, createdAt: safeIso(row.ts ?? row.timestamp) });
      }
    }
  } catch { return []; }
  return out;
}

async function appendExposure(args: {
  abrainHome: string;
  projectRoot: string;
  sessionId: string;
  turnId: string | number;
  createdAt: string;
  sourceKind: "path_a" | "memory_tool";
  sourceRef: string;
  producerNonce: string;
  slug: string;
  toolName?: string;
}): Promise<ExposureRecord | undefined> {
  const body = await createBody({
    abrainHome: args.abrainHome,
    eventType: "memory_exposure_observed",
    createdAt: args.createdAt,
    producerNonce: args.producerNonce,
    actor: { role: "system", id: "memory-runtime" },
    sessionId: args.sessionId,
    turnId: args.turnId,
    source: { channel: args.sourceKind === "path_a" ? "agent_end" : "tool_result", source_role: "tool", source_ref: args.sourceRef },
    operationHint: "exposure",
    projectRoot: args.projectRoot,
    payload: {
      observation_kind: "memory_exposure",
      source_kind: args.sourceKind,
      entry_slug: args.slug,
      ...(args.toolName ? { tool_name: args.toolName } : {}),
    },
    attribution: {
      status: "unknown",
      basis: "no_reliable_join",
      memory_entry_slugs: [args.slug],
      exposure_event_ids: [],
      candidate_exposure_event_ids: [],
      limitations: ["exposure alone does not prove use or causal influence"],
    },
    independence: "exposure_only",
    strength: "insufficient",
  });
  const appended = await appendOutcomeEvidenceEvent(args.abrainHome, body);
  return appended.ok && appended.eventId ? { eventId: appended.eventId, slug: args.slug, sourceKind: args.sourceKind } : undefined;
}

async function appendRejudge(args: {
  abrainHome: string;
  projectRoot: string;
  sessionId: string;
  turnId: string | number;
  createdAt: string;
  outcomeEventId: string;
  attribution: OutcomeEvidenceAttribution;
  decision: OutcomeRejudgeDecision;
  reason: string;
}): Promise<AppendOutcomeEvidenceResult> {
  const body = await createBody({
    abrainHome: args.abrainHome,
    eventType: "outcome_rejudge_recorded",
    createdAt: args.createdAt,
    producerNonce: `rejudge:${args.outcomeEventId}`,
    actor: { role: "system", id: "sediment-outcome-rejudge" },
    causalParents: [args.outcomeEventId],
    sessionId: args.sessionId,
    turnId: args.turnId,
    source: { channel: "agent_end", source_role: "system", source_ref: `outcome:${args.outcomeEventId}` },
    operationHint: "rejudge",
    projectRoot: args.projectRoot,
    payload: {
      observation_kind: "rejudge",
      target_outcome_event_id: args.outcomeEventId,
      decision: args.decision,
      reason: clip(args.reason, 500),
      terminal: true,
      memory_lifecycle_change: false,
      prompt_file_change: false,
    },
    attribution: args.attribution,
    independence: "llm_judgment",
    strength: args.decision === "defer_until_new_evidence" ? "insufficient" : "medium",
  });
  return appendOutcomeEvidenceEvent(args.abrainHome, body);
}

export async function collectAndAppendOutcomeEvidence(args: {
  abrainHome?: string;
  projectRoot: string;
  sessionId: string;
  turnId: string | number;
  branch: unknown[];
}): Promise<{ exposures: string[]; outcomes: string[]; rejudges: string[]; errors: string[] }> {
  const abrainHome = path.resolve(args.abrainHome ?? resolveUserGlobalAbrainHome());
  const errors: string[] = [];
  const exposures: ExposureRecord[] = [];
  for (const row of currentPathAInjections(abrainHome, args.sessionId, args.turnId)) {
    const exposure = await appendExposure({
      abrainHome,
      projectRoot: args.projectRoot,
      sessionId: args.sessionId,
      turnId: args.turnId,
      createdAt: row.createdAt,
      sourceKind: "path_a",
      sourceRef: `path-a:${row.injectId}:${row.slug}`,
      producerNonce: `${row.injectId}:${row.slug}`,
      slug: row.slug,
    });
    if (exposure) exposures.push(exposure);
  }

  const parsed = extractCallsAndResults(args.branch);
  for (const result of parsed.results) {
    if (result.name !== "memory_search" && result.name !== "memory_decide" && !isMemoryEntryReadToolName(result.name)) continue;
    for (const slug of memorySlugsFromToolResult(result)) {
      const exposure = await appendExposure({
        abrainHome,
        projectRoot: args.projectRoot,
        sessionId: args.sessionId,
        turnId: args.turnId,
        createdAt: result.createdAt,
        sourceKind: "memory_tool",
        sourceRef: `tool-result:${result.id}:${slug}`,
        producerNonce: `${result.id}:${slug}`,
        slug,
        toolName: result.name,
      });
      if (exposure) exposures.push(exposure);
    }
  }

  const footnoteSlugs = parseMemoryFootnoteSlugs(args.branch);
  const outcomes: string[] = [];
  const rejudges: string[] = [];
  for (const result of parsed.results) {
    const call = parsed.calls.get(result.id);
    const classified = classifyToolResult(result, call);
    if (!classified) continue;
    const matchedExposures = exposures.filter((item) => footnoteSlugs.has(item.slug));
    const candidateIds = exposures.map((item) => item.eventId);
    const attribution: OutcomeEvidenceAttribution = matchedExposures.length > 0
      ? {
          status: "corroborated",
          basis: "independent_result_plus_exact_self_report",
          memory_entry_slugs: matchedExposures.map((item) => item.slug),
          exposure_event_ids: matchedExposures.map((item) => item.eventId),
          candidate_exposure_event_ids: candidateIds,
          limitations: ["self-report corroborates but does not independently prove causal influence", "no lifecycle action is authorized"],
        }
      : {
          status: "unknown",
          basis: candidateIds.length > 0 ? "causal_anchor_only" : "no_reliable_join",
          memory_entry_slugs: [],
          exposure_event_ids: [],
          candidate_exposure_event_ids: candidateIds,
          limitations: [candidateIds.length > 0 ? "same-turn exposure is not a reliable causal link" : "no memory exposure observed", "silence is not evidence of non-use"],
        };
    const status = terminalStatus(result);
    const body = await createBody({
      abrainHome,
      eventType: "action_outcome_observed",
      createdAt: result.createdAt,
      producerNonce: `tool-result:${result.id}`,
      actor: { role: "tool", id: result.name },
      causalParents: attribution.exposure_event_ids,
      sessionId: args.sessionId,
      turnId: args.turnId,
      source: { channel: "tool_result", source_role: "tool", source_ref: `tool-result:${result.id}` },
      operationHint: "action_outcome",
      projectRoot: args.projectRoot,
      payload: {
        observation_kind: classified.kind,
        action: classified.action,
        terminal_status: status,
        result: {
          is_error: result.isError,
          content_sha256: sha256Hex(result.content),
          content_bytes: Buffer.byteLength(result.content),
          details_sha256: result.details ? sha256Hex(stableString(result.details)) : null,
        },
      },
      attribution,
      independence: "independent_execution",
      strength: status === "unknown" ? "medium" : "high",
      sanitizerText: `${stableString(classified.action)}\n${result.content}`,
    });
    const appended = await appendOutcomeEvidenceEvent(abrainHome, body);
    if (!appended.ok || !appended.eventId) { errors.push(appended.error ?? appended.status); continue; }
    outcomes.push(appended.eventId);
    const decision: OutcomeRejudgeDecision = attribution.status === "corroborated"
      ? status === "failed" ? "contradicting_evidence_observed" : "supporting_evidence_observed"
      : "defer_until_new_evidence";
    const rejudge = await appendRejudge({
      abrainHome,
      projectRoot: args.projectRoot,
      sessionId: args.sessionId,
      turnId: args.turnId,
      createdAt: result.createdAt,
      outcomeEventId: appended.eventId,
      attribution,
      decision,
      reason: attribution.status === "unknown" ? "independent outcome exists but memory attribution is not reliable" : "independent outcome plus exact self-report is corroborating evidence only",
    });
    if (rejudge.ok && rejudge.eventId) rejudges.push(rejudge.eventId);
    else errors.push(rejudge.error ?? rejudge.status);
  }
  if (exposures.length || outcomes.length || rejudges.length) {
    const rebuilt = rebuildOutcomeEvidenceIndex(abrainHome);
    if (!rebuilt.ok) errors.push(rebuilt.error ?? "index_rebuild_failed");
  }
  return { exposures: exposures.map((item) => item.eventId), outcomes, rejudges, errors };
}

export async function appendNaturalCorrectionOutcomeEvidence(args: {
  abrainHome?: string;
  projectRoot: string;
  sessionId: string;
  turnId: string | number;
  targetSlug?: string | null;
  userQuote: string;
  provenance?: string;
  createdAt?: string;
}): Promise<{ correction?: string; rejudge?: string; status: OutcomeAttributionStatus; error?: string }> {
  if (args.provenance !== "user-expressed" || !args.userQuote.trim()) return { status: "unknown", error: "correction_not_user_authored" };
  const abrainHome = path.resolve(args.abrainHome ?? resolveUserGlobalAbrainHome());
  const slug = args.targetSlug?.trim() || "";
  const candidates = readOutcomeEvidenceIndex(abrainHome).filter((row) =>
    row.event_type === "memory_exposure_observed"
    && row.session_id === args.sessionId
    && row.turn_id === String(args.turnId)
    && (!slug || row.memory_entry_slugs.includes(slug)),
  );
  const status: OutcomeAttributionStatus = slug && candidates.length > 0 ? "corroborated" : "unknown";
  const attribution: OutcomeEvidenceAttribution = {
    status,
    basis: status === "corroborated" ? "exact_user_correction_target" : "no_reliable_join",
    // User-claimed targets may be retained under unknown, but only with limitations
    // below; lifecycle resolvers never treat unknown/corroborated as reliable.
    memory_entry_slugs: slug ? [slug] : [],
    exposure_event_ids: status === "corroborated" ? candidates.map((row) => row.event_id) : [],
    candidate_exposure_event_ids: candidates.map((row) => row.event_id),
    limitations: status === "corroborated"
      ? ["target association includes classifier judgment; rejudge may reconsider but cannot mutate lifecycle directly", "corroborated natural correction is not attributed lifecycle authority"]
      : slug
        ? ["natural correction target is user-claimed only and is not reliable lifecycle attribution", "downstream must never treat unknown claimed targets as reliable"]
        : ["natural correction has no reliable memory target join"],
  };
  const createdAt = args.createdAt ?? new Date().toISOString();
  const sanitizedQuote = sanitizeForMemory(args.userQuote);
  const body = await createBody({
    abrainHome,
    eventType: "natural_correction_observed",
    createdAt,
    producerNonce: `natural-correction:${sha256Hex(`${args.sessionId}\0${args.turnId}\0${args.userQuote}`)}`,
    actor: { role: "user", id: "conversation-user" },
    causalParents: attribution.exposure_event_ids,
    sessionId: args.sessionId,
    turnId: args.turnId,
    source: { channel: "agent_end", source_role: "user", source_ref: `user-correction:${sha256Hex(args.userQuote).slice(0, 24)}` },
    operationHint: "natural_correction",
    projectRoot: args.projectRoot,
    payload: {
      observation_kind: "natural_correction",
      target_entry_slug: slug || null,
      sanitized_quote: clip(sanitizedQuote.text ?? "[redacted]", 500),
      quote_sha256: sha256Hex(args.userQuote),
      terminal_status: "passed",
    },
    attribution,
    independence: "user_authored",
    strength: status === "corroborated" ? "high" : "medium",
    sanitizerText: args.userQuote,
  });
  const correction = await appendOutcomeEvidenceEvent(abrainHome, body);
  if (!correction.ok || !correction.eventId) return { status, error: correction.error ?? correction.status };
  const decision: OutcomeRejudgeDecision = status === "corroborated" ? "reconsider" : "defer_until_new_evidence";
  const rejudge = await appendRejudge({
    abrainHome,
    projectRoot: args.projectRoot,
    sessionId: args.sessionId,
    turnId: args.turnId,
    createdAt,
    outcomeEventId: correction.eventId,
    attribution,
    decision,
    reason: status === "corroborated" ? "user-authored correction warrants autonomous reconsideration without direct lifecycle mutation" : "user-authored correction preserved; target attribution remains unknown",
  });
  rebuildOutcomeEvidenceIndex(abrainHome);
  return { correction: correction.eventId, ...(rejudge.ok && rejudge.eventId ? { rejudge: rejudge.eventId } : {}), status, ...(!rejudge.ok ? { error: rejudge.error ?? rejudge.status } : {}) };
}

export async function recordProductionCommandOutcome(args: {
  abrainHome?: string;
  projectRoot: string;
  sessionId: string;
  turnId: string | number;
  injectIds?: string[];
  runId: string;
  startedAt: string;
  finishedAt: string;
  executable: string;
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  repositoryIdentity: {
    head_commit: string;
    branch: string | null;
    worktree_status_sha256: string;
    worktree_dirty: boolean;
  };
}): Promise<{ exposures: string[]; outcome?: string; rejudge?: string; attribution: OutcomeAttributionStatus; error?: string }> {
  const abrainHome = path.resolve(args.abrainHome ?? resolveUserGlobalAbrainHome());
  const exposures: ExposureRecord[] = [];
  const injectIds = args.injectIds?.length ? new Set(args.injectIds) : undefined;
  for (const row of currentPathAInjections(abrainHome, args.sessionId, args.turnId, injectIds)) {
    const exposure = await appendExposure({
      abrainHome,
      projectRoot: args.projectRoot,
      sessionId: args.sessionId,
      turnId: args.turnId,
      createdAt: row.createdAt,
      sourceKind: "path_a",
      sourceRef: `path-a:${row.injectId}:${row.slug}`,
      producerNonce: `${row.injectId}:${row.slug}`,
      slug: row.slug,
    });
    if (exposure) exposures.push(exposure);
  }
  const commandText = [args.executable, ...args.argv].join(" ");
  const kind = classifyCommand(commandText) ?? "tool";
  const attribution: OutcomeEvidenceAttribution = {
    status: "unknown",
    basis: exposures.length > 0 ? "causal_anchor_only" : "no_reliable_join",
    memory_entry_slugs: [],
    exposure_event_ids: [],
    candidate_exposure_event_ids: exposures.map((item) => item.eventId),
    limitations: [exposures.length > 0 ? "real same-turn exposure exists but does not prove command causation" : "no real exposure was available", "no synthetic attribution was added"],
  };
  const terminal: OutcomeTerminalStatus = args.signal ? "cancelled" : args.exitCode === 0 ? "passed" : args.exitCode === null ? "unknown" : "failed";
  const sanitizedCommand = sanitizeForMemory(clip(commandText, MAX_COMMAND_CHARS));
  const body = await createBody({
    abrainHome,
    eventType: "action_outcome_observed",
    createdAt: args.finishedAt,
    producerNonce: `production-command:${args.runId}`,
    actor: { role: "tool", id: "production-command-runner" },
    sessionId: args.sessionId,
    turnId: args.turnId,
    source: { channel: "production_command", source_role: "tool", source_ref: `production-command:${args.runId}` },
    operationHint: "action_outcome",
    projectRoot: args.projectRoot,
    payload: {
      observation_kind: kind,
      action: {
        kind: "production_command",
        executable: args.executable,
        command: sanitizedCommand.text ?? "[redacted]",
        command_sha256: sha256Hex(commandText),
        started_at: safeIso(args.startedAt),
        finished_at: safeIso(args.finishedAt),
      },
      terminal_status: terminal,
      repository_identity: {
        head_commit: args.repositoryIdentity.head_commit,
        branch: args.repositoryIdentity.branch,
        worktree_status_sha256: args.repositoryIdentity.worktree_status_sha256,
        worktree_dirty: args.repositoryIdentity.worktree_dirty,
      },
      result: {
        exit_code: args.exitCode,
        signal: args.signal,
        stdout_sha256: sha256Hex(args.stdout),
        stdout_bytes: args.stdout.length,
        stderr_sha256: sha256Hex(args.stderr),
        stderr_bytes: args.stderr.length,
      },
    },
    attribution,
    independence: "independent_execution",
    strength: terminal === "unknown" ? "medium" : "high",
    sanitizerText: commandText,
  });
  const outcome = await appendOutcomeEvidenceEvent(abrainHome, body);
  if (!outcome.ok || !outcome.eventId) return { exposures: exposures.map((item) => item.eventId), attribution: "unknown", error: outcome.error ?? outcome.status };
  const rejudge = await appendRejudge({
    abrainHome,
    projectRoot: args.projectRoot,
    sessionId: args.sessionId,
    turnId: args.turnId,
    createdAt: args.finishedAt,
    outcomeEventId: outcome.eventId,
    attribution,
    decision: "defer_until_new_evidence",
    reason: "real independent command result recorded; same-turn exposure is not enough for memory attribution",
  });
  rebuildOutcomeEvidenceIndex(abrainHome);
  return {
    exposures: exposures.map((item) => item.eventId),
    outcome: outcome.eventId,
    ...(rejudge.ok && rejudge.eventId ? { rejudge: rejudge.eventId } : {}),
    attribution: "unknown",
    ...(!rejudge.ok ? { error: rejudge.error ?? rejudge.status } : {}),
  };
}

export function summarizeOutcomeEvidenceSpine(projectRoot: string, cutoffMs = 0, abrainHome = resolveUserGlobalAbrainHome()): OutcomeEvidenceSpineSummary {
  const projectHash = projectRootHash(projectRoot);
  const rows = readOutcomeEvidenceIndex(abrainHome).filter((row) => row.project_root_hash === projectHash && Date.parse(row.created_at_utc) >= cutoffMs);
  const outcomes = rows.filter((row) => row.event_type === "action_outcome_observed" || row.event_type === "natural_correction_observed");
  const independent = outcomes.filter((row) => row.evidence_independence === "independent_execution" || row.evidence_independence === "user_authored");
  const rejudges = rows.filter((row) => row.event_type === "outcome_rejudge_recorded");
  return {
    events: rows.length,
    exposures: rows.filter((row) => row.event_type === "memory_exposure_observed").length,
    outcomes: outcomes.length,
    independent_outcomes: independent.length,
    attributed: outcomes.filter((row) => row.attribution_status === "attributed").length,
    corroborated: outcomes.filter((row) => row.attribution_status === "corroborated").length,
    unknown: outcomes.filter((row) => row.attribution_status === "unknown").length,
    rejudged: rejudges.length,
    deferred_until_new_evidence: rejudges.filter((row) => row.rejudge_decision === "defer_until_new_evidence").length,
    natural_corrections: rows.filter((row) => row.event_type === "natural_correction_observed").length,
    recent_independent_evidence: independent.slice(-20).map((row) => ({
      event_id: row.event_id,
      ...(row.observation_kind ? { observation_kind: row.observation_kind } : {}),
      ...(row.terminal_status ? { terminal_status: row.terminal_status } : {}),
      attribution_status: row.attribution_status,
      memory_entry_slugs: row.memory_entry_slugs,
    })),
    recent_independent_evidence_event_ids: independent.slice(-20).map((row) => row.event_id),
  };
}

export function resolveIndependentOutcomeEvidenceEventIds(
  ids: unknown,
  projectRoot?: string,
  options: {
    abrainHome?: string;
    targetSlug?: string;
    /** When set, only index rows whose payload-bound proposal_id matches exactly. */
    targetProposalId?: string;
    requireReliableAttribution?: boolean;
  } = {},
): string[] {
  if (!Array.isArray(ids)) return [];
  const requested = new Set(ids.filter((id): id is string => typeof id === "string" && SHA256_RE.test(id)));
  if (requested.size === 0) return [];
  const projectHash = projectRoot ? projectRootHash(projectRoot) : undefined;
  return readOutcomeEvidenceIndex(options.abrainHome)
    .filter((row) => requested.has(row.event_id))
    .filter((row) => row.evidence_independence === "independent_execution" || row.evidence_independence === "user_authored")
    .filter((row) => row.event_type === "action_outcome_observed" || row.event_type === "natural_correction_observed")
    .filter((row) => !projectHash || row.project_root_hash === projectHash)
    // Lifecycle-grade reliability requires true attribution. Corroborated
    // (footnote + self-report) is intentionally insufficient; when no attributed
    // producer exists, callers correctly fail closed via empty resolution.
    .filter((row) => !options.requireReliableAttribution || row.attribution_status === "attributed")
    .filter((row) => !options.targetSlug || row.memory_entry_slugs.includes(options.targetSlug))
    // Prompt-revision grade joins require a stable proposal_id bind. Ordinary
    // outcomes omit proposal_id, so they fail closed when a target is required.
    .filter((row) => !options.targetProposalId || row.proposal_id === options.targetProposalId)
    .map((row) => row.event_id)
    .sort();
}

export function outcomeEvidenceEventPath(abrainHome: string, eventId: string): string {
  return expectedL1EventPath(abrainHome, eventId);
}

/**
 * Fixture/helper: append one *attributed* independent action outcome for a slug.
 * Production collectors currently emit only corroborated/unknown; lifecycle stays
 * fail-closed until a real attributed producer exists. Tests that need archive
 * execution or proposal-bound prompt-revision unlock must seed through this
 * helper (or an equivalent valid L1 event). Optional proposalId is the future
 * dedicated-producer extension point for prompt-revision joins.
 */
export async function appendAttributedIndependentOutcomeFixture(args: {
  abrainHome?: string;
  projectRoot: string;
  targetSlug: string;
  /** Optional stable proposal bind for prompt-revision-grade joins. */
  proposalId?: string;
  sessionId?: string;
  turnId?: string | number;
  createdAt?: string;
  producerNonce?: string;
  observationKind?: OutcomeObservationKind;
  terminalStatus?: OutcomeTerminalStatus;
}): Promise<AppendOutcomeEvidenceResult> {
  const abrainHome = path.resolve(args.abrainHome ?? resolveUserGlobalAbrainHome());
  const createdAt = args.createdAt ?? new Date().toISOString();
  const sourceRef = `fixture-attributed:${args.targetSlug}:${args.producerNonce ?? createdAt}`;
  const body = await createBody({
    abrainHome,
    eventType: "action_outcome_observed",
    createdAt,
    producerNonce: args.producerNonce ?? `fixture-attributed:${args.targetSlug}:${createdAt}`,
    actor: { role: "tool", id: "fixture-runner" },
    sessionId: args.sessionId ?? "fixture-session",
    turnId: args.turnId ?? "fixture-turn",
    source: { channel: "tool_result", source_role: "tool", source_ref: sourceRef },
    operationHint: "action_outcome",
    projectRoot: args.projectRoot,
    payload: {
      observation_kind: args.observationKind ?? "test",
      terminal_status: args.terminalStatus ?? "failed",
      action: { kind: "fixture", tool_name: "fixture", command: "npm test" },
      fixture: true,
      ...(typeof args.proposalId === "string" && args.proposalId ? { proposal_id: args.proposalId } : {}),
    },
    attribution: {
      status: "attributed",
      basis: "exact_user_correction_target",
      memory_entry_slugs: [args.targetSlug],
      exposure_event_ids: [],
      candidate_exposure_event_ids: [],
      limitations: ["fixture attributed outcome for lifecycle gate tests only"],
    },
    independence: "independent_execution",
    strength: "high",
    sanitizerText: `fixture ${args.targetSlug}`,
  });
  const appended = await appendOutcomeEvidenceEvent(abrainHome, body);
  if (appended.ok) rebuildOutcomeEvidenceIndex(abrainHome);
  return appended;
}
