import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, durableAtomicWriteFile } from "../_shared/durable-write";
import { isCanonicalMutationAuthorityError } from "../_shared/canonical-mutation-authority";
import { withCanonicalMutationBarrier } from "../_shared/canonical-mutation-barrier";
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
      // v1 may use several fences; v2 uses one fence with `---` records.
      // Scan every target field so repeated entry/slug records all join to
      // their exact exposures instead of silently retaining only the first.
      const target = /^(?:entry|slug):\s*(\S+)\s*$/gm;
      let slugMatch: RegExpExecArray | null;
      while ((slugMatch = target.exec(match[1] ?? "")) !== null) {
        const slug = slugMatch[1]!.replace(/^project:[^:]+:/, "").replace(/^(world|workflow):/, "").replace(/:/g, "-").trim();
        if (slug) slugs.add(slug);
      }
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
  // Tracked L1 mutation: barrier owns preflight + mkdir + create so authority
  // closes before the first write and concurrent CAS is OFD-serialized.
  try {
    return await withCanonicalMutationBarrier(abrainHome, async () => {
      await validateL1WritePreflight({
        abrainHome,
        envelope,
        targetPath: filePath,
        expected: { domain: "knowledge", role: "evidence", producer: OUTCOME_EVIDENCE_PRODUCER },
      });
      await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const raw = `${canonicalizeJcs(envelope)}\n`;
      const result = await durableAtomicCreateFile(filePath, raw);
      if (result === "collision") return { ok: false, status: "collision" as const, eventId: envelope.event_id, filePath, envelope, error: "content_address_collision" };
      return { ok: true, status: result === "created" ? "appended" as const : "idempotent_duplicate" as const, eventId: envelope.event_id, filePath, envelope };
    });
  } catch (error) {
    if (isCanonicalMutationAuthorityError(error)) throw error;
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
  /** Candidate L1 event files visited during the hardened walk (includes foreign schemas). */
  candidates: number;
  /** Loud per-file diagnostics. A single foreign/invalid event never blanks the whole index. */
  diagnostics: string[];
  error?: string;
}

export const OUTCOME_EVIDENCE_INDEX_REBUILD_CHILD_RELATIVE = "scripts/outcome-evidence-index-rebuild-child.mjs" as const;
export const OUTCOME_EVIDENCE_INDEX_REBUILD_CHILD_RESULT_SCHEMA = "outcome-evidence-index-rebuild-child-result/v1" as const;

export interface OutcomeEvidenceIndexIsolatedRebuildResult extends OutcomeEvidenceIndexRebuildResult {
  mode: "child";
  wall_time_ms: number;
  child_pid?: number;
  exit_code?: number | null;
  signal?: string | null;
  stderr: string;
  diagnostics_total: number;
  diagnostics_truncated: boolean;
}

export interface OutcomeEvidenceIsolatedRebuildTestControls {
  /** Child-only synthetic CPU busy wait so smokes can prove parent event-loop liveness. */
  childBusyMs?: number;
}

const OUTCOME_INDEX_ISOLATED_STATE_KEY = Symbol.for("pi-astack/sediment/outcome-evidence-index-isolated-rebuild/v1");
/** Bumped when process-global isolated-rebuild state shape changes (active children + exit hook). */
const OUTCOME_INDEX_ISOLATED_STATE_VERSION = 2;
const OUTCOME_INDEX_CHILD_TIMEOUT_MS = 10 * 60 * 1000;
const OUTCOME_INDEX_CHILD_MAX_STDOUT_BYTES = 256 * 1024;
const OUTCOME_INDEX_CHILD_MAX_STDERR_BYTES = 64 * 1024;
const OUTCOME_INDEX_CHILD_MAX_ARG_BYTES = 4096;
const OUTCOME_INDEX_CHILD_DIAGNOSTICS_CAP = 32;

interface OutcomeIndexIsolatedState {
  version: number;
  inFlight: Map<string, Promise<OutcomeEvidenceIndexIsolatedRebuildResult>>;
  /** Live rebuild children still running; used for best-effort parent-exit kill. */
  activeChildren: Set<ChildProcess>;
  /** Shared process `exit` hook — installed only while activeChildren is non-empty. */
  exitHook?: () => void;
}

let isolatedRebuildTestControls: OutcomeEvidenceIsolatedRebuildTestControls = {};

/** Test-only controls for the isolated rebuild child (never used on production hot paths). */
export function __TEST_setOutcomeEvidenceIsolatedRebuildControls(
  controls: OutcomeEvidenceIsolatedRebuildTestControls = {},
): void {
  isolatedRebuildTestControls = { ...controls };
}

/** Test-only: pids of currently tracked isolated rebuild children. */
export function __TEST_getOutcomeEvidenceIsolatedRebuildChildPids(): number[] {
  const pids: number[] = [];
  for (const child of outcomeIndexIsolatedState().activeChildren) {
    if (typeof child.pid === "number" && Number.isFinite(child.pid) && child.pid > 0) {
      pids.push(child.pid);
    }
  }
  return pids;
}

function outcomeIndexIsolatedState(): OutcomeIndexIsolatedState {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[OUTCOME_INDEX_ISOLATED_STATE_KEY] as Partial<OutcomeIndexIsolatedState> | undefined;
  if (!state || typeof state !== "object" || state.version !== OUTCOME_INDEX_ISOLATED_STATE_VERSION) {
    state = {
      version: OUTCOME_INDEX_ISOLATED_STATE_VERSION,
      inFlight: new Map(),
      activeChildren: new Set(),
    };
    g[OUTCOME_INDEX_ISOLATED_STATE_KEY] = state;
    return state as OutcomeIndexIsolatedState;
  }
  if (!(state.inFlight instanceof Map)) state.inFlight = new Map();
  if (!(state.activeChildren instanceof Set)) state.activeChildren = new Set();
  return state as OutcomeIndexIsolatedState;
}

function killIsolatedRebuildChild(child: ChildProcess): void {
  try {
    if (child.killed) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
  } catch {
    /* already reaped / ESRCH */
  }
}

function ensureIsolatedRebuildExitHook(state: OutcomeIndexIsolatedState): void {
  if (state.exitHook) return;
  const exitHook = () => {
    for (const child of state.activeChildren) killIsolatedRebuildChild(child);
  };
  state.exitHook = exitHook;
  process.on("exit", exitHook);
}

function releaseIsolatedRebuildExitHook(state: OutcomeIndexIsolatedState): void {
  if (!state.exitHook || state.activeChildren.size > 0) return;
  process.removeListener("exit", state.exitHook);
  state.exitHook = undefined;
}

function trackIsolatedRebuildChild(child: ChildProcess): void {
  const state = outcomeIndexIsolatedState();
  state.activeChildren.add(child);
  ensureIsolatedRebuildExitHook(state);
  // Keep the ChildProcess and its stdio handles referenced so a normal await
  // (including bare top-level await with no other live handles) observes close
  // and settles instead of Node exiting early with code 13. Explicit process
  // exit still best-effort kills active children via the shared exit hook.
}

function untrackIsolatedRebuildChild(child: ChildProcess): void {
  const state = outcomeIndexIsolatedState();
  state.activeChildren.delete(child);
  releaseIsolatedRebuildExitHook(state);
}

/**
 * Guard child stream/process event callbacks against uncaughtException.
 * Optional onThrow lets critical paths (especially `close`) still settle the
 * rebuild Promise with a structured failure instead of leaving it pending.
 */
function isolatedRebuildSafeCallback<
  T extends unknown[],
>(fn: (...args: T) => void, onThrow?: (error: unknown) => void): (...args: T) => void {
  return (...args: T) => {
    try {
      fn(...args);
    } catch (error) {
      try {
        onThrow?.(error);
      } catch {
        /* final error boundary for isolated rebuild I/O callbacks */
      }
    }
  };
}

function resolvePiAstackPackageRoot(): string {
  // jiti loads this module as CJS, so __dirname is the portable package-relative anchor.
  return path.resolve(__dirname, "..", "..");
}

function isolatedRebuildFailure(
  resolvedHome: string,
  error: string,
  extra: Partial<OutcomeEvidenceIndexIsolatedRebuildResult> = {},
): OutcomeEvidenceIndexIsolatedRebuildResult {
  return {
    ok: false,
    rows: 0,
    candidates: 0,
    diagnostics: [],
    diagnostics_total: 0,
    diagnostics_truncated: false,
    error,
    mode: "child",
    wall_time_ms: 0,
    stderr: "",
    ...extra,
  };
}

function runOutcomeEvidenceIndexIsolatedRebuild(resolvedHome: string): Promise<OutcomeEvidenceIndexIsolatedRebuildResult> {
  const started = Date.now();
  const packageRoot = resolvePiAstackPackageRoot();
  const script = path.join(packageRoot, ...OUTCOME_EVIDENCE_INDEX_REBUILD_CHILD_RELATIVE.split("/"));
  if (!fs.existsSync(script)) {
    return Promise.resolve(isolatedRebuildFailure(resolvedHome, `child_script_missing:${script}`, { wall_time_ms: Date.now() - started }));
  }
  const args = [script, "--abrain-home", resolvedHome];
  const busyMs = isolatedRebuildTestControls.childBusyMs;
  if (typeof busyMs === "number" && Number.isFinite(busyMs) && busyMs > 0) {
    args.push("--test-busy-ms", String(Math.min(Math.floor(busyMs), 30_000)));
  }
  for (const value of args) {
    if (value.includes("\0") || Buffer.byteLength(value) > OUTCOME_INDEX_CHILD_MAX_ARG_BYTES) {
      return Promise.resolve(isolatedRebuildFailure(resolvedHome, "child_arg_invalid", { wall_time_ms: Date.now() - started }));
    }
  }
  // Fixed argv only: never shell, never pass source/user content, never inherit caller AbortSignal.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH && process.env.PATH.length <= 16 * 1024 ? process.env.PATH : "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OutcomeEvidenceIndexIsolatedRebuildResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        cwd: packageRoot,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // Keep the child in the same process group by default so we can SIGKILL on timeout;
        // do not detach (would orphan) and do not pass signal/AbortSignal from foreground ctx.
        // Non-detached alone does not stop orphans on parent death — shared process exit hook
        // best-effort kills tracked children (listener is installed only while active).
        windowsHide: true,
      });
    } catch (error) {
      return finish(isolatedRebuildFailure(resolvedHome, `child_spawn_failed:${error instanceof Error ? error.message : String(error)}`, {
        wall_time_ms: Date.now() - started,
      }));
    }

    trackIsolatedRebuildChild(child);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let protocolError: string | undefined;
    let spawnError: Error | undefined;
    const timer = setTimeout(isolatedRebuildSafeCallback(() => {
      protocolError = `child_timeout:${OUTCOME_INDEX_CHILD_TIMEOUT_MS}ms`;
      killIsolatedRebuildChild(child);
    }), OUTCOME_INDEX_CHILD_TIMEOUT_MS);
    // Timeout must not alone pin the event loop; close/error paths clear it on settle.
    timer.unref?.();

    const stderrTextNow = (): string =>
      Buffer.concat(stderr).toString("utf8").slice(0, OUTCOME_INDEX_CHILD_MAX_STDERR_BYTES);

    const failStructured = (error: string, extra: Partial<OutcomeEvidenceIndexIsolatedRebuildResult> = {}): void => {
      clearTimeout(timer);
      untrackIsolatedRebuildChild(child);
      killIsolatedRebuildChild(child);
      finish(isolatedRebuildFailure(resolvedHome, error, {
        wall_time_ms: Date.now() - started,
        child_pid: child.pid,
        stderr: stderrTextNow(),
        ...extra,
      }));
    };

    child.stdout?.on("data", isolatedRebuildSafeCallback((chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTCOME_INDEX_CHILD_MAX_STDOUT_BYTES) {
        protocolError = "child_stdout_limit";
        killIsolatedRebuildChild(child);
        return;
      }
      stdout.push(chunk);
    }));
    child.stderr?.on("data", isolatedRebuildSafeCallback((chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > OUTCOME_INDEX_CHILD_MAX_STDERR_BYTES) {
        // Keep a bounded prefix; still kill so a noisy child cannot run unbounded.
        protocolError = protocolError ?? "child_stderr_limit";
        killIsolatedRebuildChild(child);
        return;
      }
      stderr.push(chunk);
    }));
    // Stream errors must never surface as uncaughtException and must settle the Promise.
    child.stdout?.on("error", isolatedRebuildSafeCallback((error: Error) => {
      protocolError = protocolError ?? `child_stdout_error:${error.message}`;
      failStructured(protocolError);
    }));
    child.stderr?.on("error", isolatedRebuildSafeCallback((error: Error) => {
      protocolError = protocolError ?? `child_stderr_error:${error.message}`;
      failStructured(protocolError);
    }));
    child.once("error", isolatedRebuildSafeCallback((error: Error) => { spawnError = error; }));
    child.once("close", isolatedRebuildSafeCallback((code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      untrackIsolatedRebuildChild(child);
      const wall_time_ms = Date.now() - started;
      const stderrText = stderrTextNow();
      if (protocolError) {
        return finish(isolatedRebuildFailure(resolvedHome, protocolError, {
          wall_time_ms,
          child_pid: child.pid,
          exit_code: code,
          signal,
          stderr: stderrText,
        }));
      }
      if (spawnError) {
        return finish(isolatedRebuildFailure(resolvedHome, `child_spawn_failed:${spawnError.message}`, {
          wall_time_ms,
          child_pid: child.pid,
          exit_code: code,
          signal,
          stderr: stderrText,
        }));
      }
      if (signal) {
        return finish(isolatedRebuildFailure(resolvedHome, `child_signal:${signal}`, {
          wall_time_ms,
          child_pid: child.pid,
          exit_code: code,
          signal,
          stderr: stderrText,
        }));
      }
      const raw = Buffer.concat(stdout).toString("utf8").trim();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch {
        return finish(isolatedRebuildFailure(resolvedHome, `child_protocol_invalid:${stderrText ? stderrText.slice(0, 200) : "invalid_json"}`, {
          wall_time_ms,
          child_pid: child.pid,
          exit_code: code,
          signal,
          stderr: stderrText,
        }));
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return finish(isolatedRebuildFailure(resolvedHome, "child_protocol_invalid:not_object", {
          wall_time_ms,
          child_pid: child.pid,
          exit_code: code,
          signal,
          stderr: stderrText,
        }));
      }
      const row = parsed as Record<string, unknown>;
      if (row.schema_version !== OUTCOME_EVIDENCE_INDEX_REBUILD_CHILD_RESULT_SCHEMA || typeof row.ok !== "boolean") {
        return finish(isolatedRebuildFailure(resolvedHome, "child_protocol_invalid:schema", {
          wall_time_ms,
          child_pid: child.pid,
          exit_code: code,
          signal,
          stderr: stderrText,
        }));
      }
      const diagnostics = Array.isArray(row.diagnostics)
        ? row.diagnostics.filter((item): item is string => typeof item === "string").slice(0, OUTCOME_INDEX_CHILD_DIAGNOSTICS_CAP)
        : [];
      const diagnostics_total = typeof row.diagnostics_total === "number" && Number.isFinite(row.diagnostics_total)
        ? Math.max(0, Math.floor(row.diagnostics_total))
        : diagnostics.length;
      const result: OutcomeEvidenceIndexIsolatedRebuildResult = {
        ok: row.ok === true,
        rows: typeof row.rows === "number" && Number.isFinite(row.rows) ? Math.max(0, Math.floor(row.rows)) : 0,
        candidates: typeof row.candidates === "number" && Number.isFinite(row.candidates) ? Math.max(0, Math.floor(row.candidates)) : 0,
        diagnostics,
        diagnostics_total,
        diagnostics_truncated: row.diagnostics_truncated === true || diagnostics_total > diagnostics.length,
        ...(typeof row.error === "string" && row.error ? { error: row.error } : row.ok === true ? {} : { error: "index_rebuild_failed" }),
        mode: "child",
        wall_time_ms: typeof row.wall_time_ms === "number" && Number.isFinite(row.wall_time_ms)
          ? Math.max(0, Math.floor(row.wall_time_ms))
          : wall_time_ms,
        child_pid: typeof row.pid === "number" && Number.isFinite(row.pid) ? Math.floor(row.pid) : child.pid,
        exit_code: code,
        signal,
        stderr: stderrText,
      };
      // Non-zero exit without an explicit rebuild error is still a visible failure.
      if (code !== 0 && result.ok) {
        result.ok = false;
        result.error = result.error ?? `child_exit_${code}`;
      }
      return finish(result);
    }, (error) => {
      // Close-handler throws must not leave the rebuild Promise pending forever.
      failStructured(
        `child_close_handler_failed:${error instanceof Error ? error.message : String(error)}`,
        { exit_code: child.exitCode, signal: child.signalCode },
      );
    }));
  });
}

/**
 * Production live rebuild: runs the existing sync rebuild in a fixed Node child
 * process so CPU/FS/JSON.parse never block the pi main event loop.
 * Process-global singleflight is keyed by resolved abrainHome; concurrent
 * callers for the same home share one child and all await index convergence.
 * Always settles (never rejects) so live paths cannot leak unhandled rejections.
 */
export function rebuildOutcomeEvidenceIndexIsolated(
  abrainHome = resolveUserGlobalAbrainHome(),
): Promise<OutcomeEvidenceIndexIsolatedRebuildResult> {
  const key = path.resolve(abrainHome);
  const state = outcomeIndexIsolatedState();
  const existing = state.inFlight.get(key);
  if (existing) return existing;
  const created = runOutcomeEvidenceIndexIsolatedRebuild(key).finally(() => {
    if (state.inFlight.get(key) === created) state.inFlight.delete(key);
  });
  state.inFlight.set(key, created);
  return created;
}

/** Deterministic L3/read-model rebuild. L1 files remain the only semantic SOT.
 *  Synchronous API for explicit CLI/tests. Production live paths must use
 *  {@link rebuildOutcomeEvidenceIndexIsolated} so the pi event loop stays free.
 */
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
      return { rows: rows.length, candidates: files.length, diagnostics };
    });
    if (!locked.ok) return { ok: false, rows: 0, candidates: 0, diagnostics: [], error: "index_lock_contention" };
    return { ok: true, rows: locked.value.rows, candidates: locked.value.candidates, diagnostics: locked.value.diagnostics };
  } catch (error) {
    return { ok: false, rows: 0, candidates: 0, diagnostics: [], error: error instanceof Error ? error.message : String(error) };
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
    const rebuilt = await rebuildOutcomeEvidenceIndexIsolated(abrainHome);
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
  const rebuilt = await rebuildOutcomeEvidenceIndexIsolated(abrainHome);
  const error = !rejudge.ok
    ? (rejudge.error ?? rejudge.status)
    : !rebuilt.ok
      ? (rebuilt.error ?? "index_rebuild_failed")
      : undefined;
  return {
    correction: correction.eventId,
    ...(rejudge.ok && rejudge.eventId ? { rejudge: rejudge.eventId } : {}),
    status,
    ...(error ? { error } : {}),
  };
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
  const rebuilt = await rebuildOutcomeEvidenceIndexIsolated(abrainHome);
  const error = !rejudge.ok
    ? (rejudge.error ?? rejudge.status)
    : !rebuilt.ok
      ? (rebuilt.error ?? "index_rebuild_failed")
      : undefined;
  return {
    exposures: exposures.map((item) => item.eventId),
    outcome: outcome.eventId,
    ...(rejudge.ok && rejudge.eventId ? { rejudge: rejudge.eventId } : {}),
    attribution: "unknown",
    ...(error ? { error } : {}),
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
  if (appended.ok) {
    const rebuilt = await rebuildOutcomeEvidenceIndexIsolated(abrainHome);
    if (!rebuilt.ok) {
      // Keep append success semantics (fixture already durable in L1) but surface
      // rebuild failure loudly through the existing optional error field.
      const rebuildError = rebuilt.error ?? "index_rebuild_failed";
      console.error(
        `[outcome-evidence] isolated index rebuild failed after fixture append event_id=${appended.eventId ?? "unknown"}: ${rebuildError}`,
      );
      return { ...appended, error: rebuildError };
    }
  }
  return appended;
}
