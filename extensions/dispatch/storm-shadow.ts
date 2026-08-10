/**
 * S3 storm-rule shadow evaluator (living plan 2026-08-10 STORM-SHADOW).
 *
 * PURE state machine over a stream of PRE-PROJECTED safe event descriptors.
 * It produces `would_abort` counterfactual verdicts for candidate storm rules
 * and NEVER changes control flow: no termination claim, no abort, no dispose,
 * no interception, no throttling, and no total tool cap. The runInProcess
 * wiring feeds real SDK events here (projected into safe fields + opaque
 * signature HMACs OUTSIDE this module) and appends verdicts to the dispatch
 * audit (row_kind=worker_run_shadow_event); the verdict is a shadow signal
 * only and can never influence termination claims or session disposal.
 *
 * This module imports nothing but a type: no crypto, no fs, no governor, no
 * control-flow surface. All classification of raw event payloads and all
 * audit-HMAC computation happen in the wiring (extensions/dispatch/index.ts)
 * inside fail-open try/catch; feed() only ever receives safe booleans and an
 * opaque `{key_id, digest}` signature.
 *
 * Candidate A — post-cap exact schema-rejection signature:
 *   The cap is a READ-ONLY MIRROR of the existing governor observer
 *   `toolObservers.schemaErrorStorm.observeAfter` (default 3; the governor
 *   itself keeps its own copy, stays observe-only, and is unchanged). Every
 *   REAL tool_execution_end schema rejection reuses the governor's own
 *   classifier to build an exact identity (tool name + closed error class +
 *   field path + bounded normalized descriptor), which the wiring persists
 *   and compares ONLY as the project audit HMAC (key_id + digest) — raw text /
 *   field path / tool args / normalized descriptor never leave the wiring.
 *   The exact-identity fields are SAME-SOURCE with the governor's own
 *   classifier (schemaErrorDescriptor), but the project audit HMAC is
 *   cross-process stable (PERSISTENT project key, strict path only), NOT the
 *   governor's process-random privateCorrelationHash. STRICT KEY AVAILABILITY
 *   IS AN ELIGIBILITY PREREQUISITE: the wiring builds the signature only via
 *   auditHmacHexStrict; when the persistent key is unavailable it fails open
 *   to schemaRejection=false with no signature (the event is not eligible and
 *   the worker continues) — an ephemeral key is never generated and never
 *   accepted as eligible. The state machine compares the unambiguous composite
 *   key_id:digest (algorithm fixed), never the digest alone, so different keys
 *   with the same digest never merge. Different signatures never merge;
 *   the same signature is recounted consecutively and inside a rolling window
 *   (deterministic, so replay reproduces verdicts). Reaching observeAfter on
 *   one signature is the cap boundary (post_cap=true, no abort); EXCEEDING
 *   the cap on subsequent same-signature rejections produces would_abort
 *   (versioned equivalent boundaries: consecutive count > capAfter, or window
 *   count >= windowLimit). post_cap is a per-signature / per-segment state,
 *   so consecutive schema rejections in one production run genuinely reach it.
 *
 * Candidate B — effective progress semantics:
 *   Effective progress (successful tool result; assistant response with real
 *   visible text that COMPLETED) resets/segments the candidate. Pure toolUse
 *   messages are NEVER progress (neutral, basis `tool_use_only`). Provider
 *   request / retry / schema rejection / failed tool / error response /
 *   empty visible retry do NOT reset. Unknown events are never guessed: they
 *   neither count nor reset.
 *
 * Anti-sticky trip reporting: after the first trip of a segment (first_trip),
 * neutral events report would_abort=false with already_tripped=true instead
 * of repeating would_abort; a reset (effective progress) opens a new segment.
 *
 * Recomputability: feed() is deterministic given the same pre-projected event
 * sequence; replayStormShadow() reproduces verdicts for verification.
 */

import type { WorkerRunAuditCorrelation } from "./worker-run-governor";

export const STORM_SHADOW_RULE_VERSION = "dispatch-storm-shadow/v4";
export const STORM_SHADOW_RULE_ID = "storm/post-cap-schema-rejection-signature/v1";
export const STORM_SHADOW_SIGNATURE_DOMAIN = "dispatch/storm-shadow/schema-rejection-signature/v2";
export const STORM_SHADOW_ROW_KIND = "worker_run_shadow_event";
export const STORM_SHADOW_SIGNAL = "storm_shadow";
export const STORM_SHADOW_COUNTERFACTUAL_ACTION = "would_abort_only_no_control_effect";

/** Shadow-only version constants for the rolling window of candidate A. */
export const STORM_SHADOW_WINDOW_SIZE = 6;
export const STORM_SHADOW_WINDOW_LIMIT = 4;

export interface StormShadowSettings {
  /** Read-only mirror of governor toolObservers.schemaErrorStorm.observeAfter.
   *  Reaching this count on one signature = cap boundary (post_cap);
   *  exceeding it on the SAME signature produces would_abort. */
  capAfter: number;
  /** Shadow-only version constant. */
  windowSize: number;
  /** Shadow-only version constant. */
  windowLimit: number;
}

export const DEFAULT_STORM_SHADOW_SETTINGS: StormShadowSettings = {
  // Mirrors the governor's default schemaErrorStorm.observeAfter (3).
  capAfter: 3,
  windowSize: STORM_SHADOW_WINDOW_SIZE,
  windowLimit: STORM_SHADOW_WINDOW_LIMIT,
};

/** Opaque project-audit HMAC of an exact schema-rejection identity. The raw
 *  identity (tool name + error class + field path + bounded normalized
 *  descriptor) is never persisted — only key_id + digest. The digest is the
 *  project audit HMAC (cross-process stable PERSISTENT project key, strict
 *  path only — never the process-random ephemeral fallback), NOT the
 *  governor's process-random privateCorrelationHash. Strict key availability
 *  is an ELIGIBILITY PREREQUISITE: when the persistent key is unavailable the
 *  wiring fails open to schemaRejection=false with no signature, so an
 *  ephemeral key is never generated and never accepted as eligible. */
export interface OpaqueSignature {
  algorithm: "hmac-sha256";
  key_id: string;
  digest: string;
}

/** Unambiguous internal comparison key for an opaque signature: key_id + digest
 *  (algorithm is fixed to "hmac-sha256" by the OpaqueSignature type, so it is
 *  not part of the key). Two signatures with the same digest but DIFFERENT
 *  key_ids NEVER merge — the state machine compares this composite key, never
 *  the digest alone. Both fields are hex strings, so the ":" separator is
 *  unambiguous. */
function signatureComparisonKey(signature: OpaqueSignature): string {
  return `${signature.key_id}:${signature.digest}`;
}

/**
 * Pre-projected, safe event descriptors. The pure state machine NEVER sees a
 * raw assistant message / tool result payload: raw payloads are classified in
 * the wiring (fail-open) and only these booleans / the opaque signature reach
 * feed().
 */
export type StormShadowEventInput =
  | {
      kind: "tool_execution_end";
      isError: boolean;
      schemaRejection: boolean;
      /** Opaque HMAC of the exact schema-rejection identity. Present exactly
       *  when schemaRejection === true (pre-projected by the wiring). */
      signature?: OpaqueSignature;
    }
  | {
      kind: "assistant_response";
      /** True when the message contains non-empty visible text parts. */
      hasVisibleText: boolean;
      /** True when the assistant turn reached a normal terminal stop reason
       *  ("stop" / "end_turn"); toolUse / length / error / aborted are not. */
      completed: boolean;
      /** True when the message carries a provider error (stopReason "error"
       *  or an errorMessage). */
      errorResponse: boolean;
      /** True when the retryable empty-visible-output marker is set. */
      emptyVisibleRetry: boolean;
      /** True for a pure tool-use message (no visible text, stopReason
       *  "toolUse"): never progress. */
      toolUseOnly: boolean;
    }
  | { kind: "provider_request" }
  | { kind: "provider_retry" }
  | { kind: "unknown"; eventType?: string };

export type StormProgressVerdict = "progress" | "not_progress" | "unknown";

export type StormProgressBasis =
  | "successful_tool_response"
  | "visible_assistant_response"
  | "tool_use_only"
  | "incomplete_assistant_response"
  | "non_visible_assistant_response"
  | "error_response"
  | "provider_request"
  | "provider_retry"
  | "schema_rejection"
  | "failed_tool_response"
  | "empty_visible_retry"
  | "unknown_event";

export interface StormShadowObservation {
  event_kind: string;
  progress_verdict: StormProgressVerdict;
  progress_basis: StormProgressBasis;
  segment: number;
  /** Per-signature / per-segment cap-boundary state: the current signature's
   *  count has reached capAfter (governor observeAfter mirror). Meaningful for
   *  eligible schema-rejection events; for neutral events it reflects the last
   *  eligible signature's state. */
  post_cap: boolean;
  cap_after: number;
  consecutive_count: number;
  window_count: number;
  window_size: number;
  window_limit: number;
  would_abort: boolean;
  would_abort_basis: "consecutive" | "rolling_window" | null;
  /** True exactly on the first crossing event of a segment. */
  first_trip: boolean;
  /** True for events after the first trip of a segment that do NOT themselves
   *  cross the cap (neutral events report would_abort=false + already_tripped
   *  instead of sticky-repeating would_abort). */
  already_tripped: boolean;
  signature_hmac?: OpaqueSignature;
}

export interface StormShadowSnapshot {
  segment: number;
  post_cap: boolean;
  consecutive_count: number;
  window_count: number;
  /** Composite comparison keys (key_id:digest) of the eligible signatures in
   *  the rolling window — never the digest alone. */
  window: string[];
  tripped: boolean;
}

/**
 * Candidate B: classify a pre-projected event as effective progress, not
 * progress, or unknown. Only "progress" resets/segments the candidate.
 */
export function classifyStormProgress(input: StormShadowEventInput): {
  verdict: StormProgressVerdict;
  basis: StormProgressBasis;
} {
  switch (input.kind) {
    case "assistant_response": {
      if (input.emptyVisibleRetry) return { verdict: "not_progress", basis: "empty_visible_retry" };
      if (input.errorResponse) return { verdict: "not_progress", basis: "error_response" };
      if (input.hasVisibleText && input.completed) return { verdict: "progress", basis: "visible_assistant_response" };
      if (input.hasVisibleText) return { verdict: "not_progress", basis: "incomplete_assistant_response" };
      if (input.toolUseOnly) return { verdict: "not_progress", basis: "tool_use_only" };
      return { verdict: "not_progress", basis: "non_visible_assistant_response" };
    }
    case "tool_execution_end":
      if (input.isError !== true) return { verdict: "progress", basis: "successful_tool_response" };
      return input.schemaRejection === true
        ? { verdict: "not_progress", basis: "schema_rejection" }
        : { verdict: "not_progress", basis: "failed_tool_response" };
    case "provider_request":
      return { verdict: "not_progress", basis: "provider_request" };
    case "provider_retry":
      return { verdict: "not_progress", basis: "provider_retry" };
    default:
      return { verdict: "unknown", basis: "unknown_event" };
  }
}

/**
 * Audit write predicate: keep shadow audit rows bounded while staying
 * replayable. Rows are written only for events that are state-relevant:
 * real schema rejections (candidate A evidence), effective progress (reset /
 * segment evidence), the first trip, and the transition into an
 * already-tripped episode (one marker row per episode). Pure neutral events
 * (provider request / retry / failed tool / unknown / neutral assistant
 * responses) change no state and are NOT written; because they change no
 * state, replaying only the written events reproduces identical verdicts.
 */
export function shouldWriteStormShadowAudit(
  previous: StormShadowObservation | undefined,
  observation: StormShadowObservation,
  input: StormShadowEventInput,
): boolean {
  if (input.kind === "tool_execution_end" && input.schemaRejection === true) return true;
  if (observation.progress_verdict === "progress") return true;
  if (observation.first_trip) return true;
  if (observation.already_tripped && (previous === undefined || previous.already_tripped !== true)) return true;
  // One neutral marker per segment documenting the pure-toolUse verdict
  // (never progress). Bounded by segments, which only effective progress
  // advances.
  if (observation.progress_basis === "tool_use_only" && (previous === undefined || previous.segment !== observation.segment)) return true;
  return false;
}

export class StormShadow {
  private segment = 0;
  private consecutiveCount = 0;
  /** Composite comparison key (key_id:digest) of the last eligible signature. */
  private lastEligibleSignature: string | null = null;
  private window: Array<{ signature: string; seq: number }> = [];
  private seq = 0;
  private tripped = false;

  constructor(private readonly settings: StormShadowSettings = DEFAULT_STORM_SHADOW_SETTINGS) {}

  snapshot(): StormShadowSnapshot {
    return {
      segment: this.segment,
      post_cap: this.postCapFor(this.lastEligibleSignature, this.consecutiveCount),
      consecutive_count: this.consecutiveCount,
      window_count: this.windowCountFor(this.lastEligibleSignature),
      window: this.window.map((entry) => entry.signature),
      tripped: this.tripped,
    };
  }

  /** Observe one pre-projected event. Pure: returns a verdict record only. */
  feed(input: StormShadowEventInput): StormShadowObservation {
    this.seq++;
    const progress = classifyStormProgress(input);

    // Candidate B: effective progress resets/segments the candidate and opens
    // a fresh trip episode.
    if (progress.verdict === "progress") {
      this.segment++;
      this.consecutiveCount = 0;
      this.lastEligibleSignature = null;
      this.window = [];
      this.tripped = false;
    }

    // Candidate A gate: only REAL schema rejections with an opaque signature
    // are eligible. A schemaRejection flag without a signature (fail-open
    // classification fallback, e.g. strict project key unavailable) is NOT
    // eligible. The internal comparison key is the unambiguous composite
    // key_id:digest (algorithm fixed) — two signatures with the same digest
    // but different key_ids NEVER merge.
    const eligible =
      input.kind === "tool_execution_end" && input.schemaRejection === true && input.signature !== undefined;
    let signatureKey: string | undefined;
    if (eligible && input.kind === "tool_execution_end" && input.signature) {
      signatureKey = signatureComparisonKey(input.signature);
      if (this.lastEligibleSignature === null || signatureKey !== this.lastEligibleSignature) {
        // Exact same-signature counting: a different signature (key_id or
        // digest) starts a fresh streak (signatures never merge).
        this.consecutiveCount = 1;
      } else {
        this.consecutiveCount++;
      }
      this.lastEligibleSignature = signatureKey;
      this.window.push({ signature: signatureKey, seq: this.seq });
      if (this.window.length > this.settings.windowSize) this.window.shift();
    }

    const consecutive = this.consecutiveCount;
    const windowCount = eligible && signatureKey !== undefined
      ? this.windowCountFor(signatureKey)
      : this.windowCountFor(this.lastEligibleSignature);
    // Versioned equivalent boundaries: exceeding the cap consecutively
    // (count > capAfter) or same-signature density inside the rolling window
    // (count >= windowLimit) both produce would_abort.
    const crosses =
      eligible &&
      (consecutive > this.settings.capAfter || windowCount >= this.settings.windowLimit);
    const firstTrip = crosses === true && !this.tripped;
    if (firstTrip) this.tripped = true;
    const alreadyTripped = !crosses && this.tripped;

    return {
      event_kind: input.kind,
      progress_verdict: progress.verdict,
      progress_basis: progress.basis,
      segment: this.segment,
      post_cap: this.postCapFor(signatureKey ?? this.lastEligibleSignature, consecutive),
      cap_after: this.settings.capAfter,
      consecutive_count: consecutive,
      window_count: windowCount,
      window_size: this.settings.windowSize,
      window_limit: this.settings.windowLimit,
      would_abort: crosses === true,
      would_abort_basis: crosses ? (consecutive > this.settings.capAfter ? "consecutive" : "rolling_window") : null,
      first_trip: firstTrip,
      already_tripped: alreadyTripped,
      ...(input.kind === "tool_execution_end" && input.signature ? { signature_hmac: input.signature } : {}),
    };
  }

  private postCapFor(signature: string | null, consecutive: number): boolean {
    if (signature === null) return false;
    return consecutive >= this.settings.capAfter || this.windowCountFor(signature) >= this.settings.capAfter;
  }

  private windowCountFor(signature: string | null): number {
    if (signature === null) return 0;
    return this.window.reduce((count, entry) => count + (entry.signature === signature ? 1 : 0), 0);
  }
}

/** Audit row for one shadow observation. Additive v5 row; no raw text. */
export function buildStormShadowAuditEvent(
  workerRunId: string,
  correlation: WorkerRunAuditCorrelation,
  observation: StormShadowObservation,
): Record<string, unknown> {
  return {
    operation: "worker_run_event",
    row_kind: STORM_SHADOW_ROW_KIND,
    worker_run_id: workerRunId,
    rule_version: STORM_SHADOW_RULE_VERSION,
    rule_id: STORM_SHADOW_RULE_ID,
    signal: STORM_SHADOW_SIGNAL,
    mode: "observe",
    counterfactual_action: STORM_SHADOW_COUNTERFACTUAL_ACTION,
    event_kind: observation.event_kind,
    progress_verdict: observation.progress_verdict,
    progress_basis: observation.progress_basis,
    segment: observation.segment,
    post_cap: observation.post_cap,
    cap_after: observation.cap_after,
    consecutive_count: observation.consecutive_count,
    window_count: observation.window_count,
    window_size: observation.window_size,
    window_limit: observation.window_limit,
    would_abort: observation.would_abort,
    ...(observation.would_abort_basis ? { would_abort_basis: observation.would_abort_basis } : {}),
    first_trip: observation.first_trip,
    already_tripped: observation.already_tripped,
    ...(observation.signature_hmac ? { signature_hmac: observation.signature_hmac } : {}),
    ...(correlation.dispatchToolCallId ? { dispatch_tool_call_id: correlation.dispatchToolCallId } : {}),
    ...(correlation.dispatchRunId ? { dispatch_run_id: correlation.dispatchRunId } : {}),
    ...(correlation.taskIndex !== undefined ? { task_index: correlation.taskIndex } : {}),
    ...(correlation.taskCount !== undefined ? { task_count: correlation.taskCount } : {}),
    ...(correlation.task ? { task: correlation.task } : {}),
    ...(correlation.workflowRunId ? { workflow_run_id: correlation.workflowRunId } : {}),
    ...(correlation.workflowStageId ? { workflow_stage_id: correlation.workflowStageId } : {}),
    ...(correlation.workflow ? { workflow: correlation.workflow } : {}),
  };
}

/**
 * Deterministic replay for verification (STORM-SHADOW-EVIDENCE recomputability):
 * feeding the same PRE-PROJECTED event sequence reproduces the same verdict
 * sequence. Signatures are opaque inputs here — they must be rebuilt with the
 * same project audit HMAC (key_id + digest) as the original run.
 */
export function replayStormShadow(
  events: StormShadowEventInput[],
  settings: StormShadowSettings = DEFAULT_STORM_SHADOW_SETTINGS,
): { observations: StormShadowObservation[]; final: StormShadowSnapshot } {
  const shadow = new StormShadow(settings);
  const observations = events.map((event) => shadow.feed(event));
  return { observations, final: shadow.snapshot() };
}
