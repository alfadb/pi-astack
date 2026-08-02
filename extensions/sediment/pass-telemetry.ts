/**
 * Pass-local instrumentation for worker receipt/result telemetry (R7).
 *
 * Counts only events that actually succeed inside the current agent_end /
 * worker **attempt**. Never forges historical receipts; never backfills.
 *
 * ALS scope = one agent_end pass (or one worker more-loop iteration that
 * enters runSedimentAgentEndPass). Nested detached work inherits the store.
 *
 * Semantics (closed):
 *  - missing telemetry_semantics on a receipt/result = **unknown**
 *    (pre-R7 / fail path / not claimed). Never invent counters.
 *  - legacy_unknown = R7-aware success path without a pass store; memory_*
 *    compatibility placeholders must not be read as real zeros.
 *  - attempt_instrumented = counters for **this attempt only** (more-loop
 *    iterations may sum inside one attempt). NOT terminal lifetime, NOT
 *    cross-attempt cumulative (already_processed returns the durable receipt).
 *
 * Coverage note: knowledge_l1_events_created is Knowledge L1 only
 * (append status=appended). It is not a whole-L1 counter. Publication /
 * outbox enqueue is intentionally not claimed here — only count that when a
 * real outbox enqueue success path is instrumented with accepted semantics.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Closed telemetry semantics for memory_writes / memory_decisions / L1 counters. */
export const SEDIMENT_TELEMETRY_SEMANTICS = [
  "legacy_unknown",
  "attempt_instrumented",
] as const;
export type SedimentTelemetrySemantics = (typeof SEDIMENT_TELEMETRY_SEMANTICS)[number];
const TELEMETRY_SEMANTICS_SET = new Set<string>(SEDIMENT_TELEMETRY_SEMANTICS);

export function isSedimentTelemetrySemantics(value: unknown): value is SedimentTelemetrySemantics {
  return typeof value === "string" && TELEMETRY_SEMANTICS_SET.has(value);
}

export interface PassTelemetryCounters {
  /**
   * Newly created Knowledge L1 events this pass (append status=appended only).
   * Not whole-L1; not idempotent_duplicate / collision / fail.
   */
  knowledge_l1_events_created: number;
  /** Curator decisions executed this pass (including skip). */
  memory_decisions: number;
  /** Successful brain writes this pass (created/updated/merged/archived/superseded/deleted). */
  memory_writes: number;
}

export interface PassTelemetrySnapshot extends PassTelemetryCounters {
  /** Always attempt_instrumented when a pass store is active. */
  telemetry_semantics: "attempt_instrumented";
}

interface PassTelemetryStore extends PassTelemetryCounters {}

const passTelemetryALS = new AsyncLocalStorage<PassTelemetryStore>();

function emptyCounters(): PassTelemetryCounters {
  return {
    knowledge_l1_events_created: 0,
    memory_decisions: 0,
    memory_writes: 0,
  };
}

/** Run `fn` under a fresh pass-local counter store. Nested calls nest ALS. */
export function runWithPassTelemetry<T>(fn: () => T): T {
  return passTelemetryALS.run(emptyCounters(), fn);
}

/** Async variant — ALS store is active for the full await of `fn`. */
export async function runWithPassTelemetryAsync<T>(fn: () => Promise<T>): Promise<T> {
  return passTelemetryALS.run(emptyCounters(), fn);
}

export function getPassTelemetryStore(): PassTelemetryStore | undefined {
  return passTelemetryALS.getStore();
}

function bump(field: keyof PassTelemetryCounters, n = 1): void {
  const store = passTelemetryALS.getStore();
  if (!store) return;
  if (!Number.isFinite(n) || n <= 0) return;
  store[field] += Math.floor(n);
}

/**
 * Count a newly appended Knowledge L1 event (status=appended only).
 * Call from the real append success path — never from idempotent/collision.
 */
export function notePassKnowledgeL1EventCreated(count = 1): void {
  bump("knowledge_l1_events_created", count);
}

/** Count a curator decision that was considered (including skip). */
export function notePassMemoryDecision(count = 1): void {
  bump("memory_decisions", count);
}

/** Count a successful brain write status. */
export function notePassMemoryWrite(count = 1): void {
  bump("memory_writes", count);
}

/**
 * Snapshot current pass counters. Returns null when no pass store is active
 * (honest missing — callers must not invent zeros as "attempt_instrumented").
 */
export function snapshotPassTelemetry(): PassTelemetrySnapshot | null {
  const store = passTelemetryALS.getStore();
  if (!store) return null;
  return {
    telemetry_semantics: "attempt_instrumented",
    knowledge_l1_events_created: store.knowledge_l1_events_created,
    memory_decisions: store.memory_decisions,
    memory_writes: store.memory_writes,
  };
}

/** Closed optional fields for worker receipt / result (additive). */
export interface WorkerTelemetryFields {
  /**
   * Closed: legacy_unknown | attempt_instrumented.
   * Absent on pre-R7 / fail receipts = unknown (do not invent).
   */
  telemetry_semantics?: SedimentTelemetrySemantics;
  /** Present only when telemetry_semantics=attempt_instrumented. */
  knowledge_l1_events_created?: number;
}

export function telemetryFieldsFromPass(
  snapshot: PassTelemetrySnapshot | null | undefined,
): WorkerTelemetryFields {
  if (!snapshot || snapshot.telemetry_semantics !== "attempt_instrumented") {
    // Compatibility path: memory_writes/decisions remain separate; mark legacy.
    return { telemetry_semantics: "legacy_unknown" };
  }
  return {
    telemetry_semantics: "attempt_instrumented",
    knowledge_l1_events_created: Math.max(0, Math.floor(snapshot.knowledge_l1_events_created)),
  };
}

/**
 * Parse optional telemetry fields from a receipt/result object.
 * Missing telemetry_semantics → treat as unknown (do not invent attempt_instrumented zeros).
 */
export function readWorkerTelemetryFields(raw: Record<string, unknown>): WorkerTelemetryFields {
  const semantics = raw.telemetry_semantics;
  if (!isSedimentTelemetrySemantics(semantics)) {
    return {};
  }
  if (semantics === "legacy_unknown") {
    return { telemetry_semantics: "legacy_unknown" };
  }
  const out: WorkerTelemetryFields = { telemetry_semantics: "attempt_instrumented" };
  if (
    typeof raw.knowledge_l1_events_created === "number"
    && Number.isSafeInteger(raw.knowledge_l1_events_created)
    && raw.knowledge_l1_events_created >= 0
  ) {
    out.knowledge_l1_events_created = raw.knowledge_l1_events_created;
  }
  return out;
}
