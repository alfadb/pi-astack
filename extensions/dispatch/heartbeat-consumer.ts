/**
 * heartbeat-consumer.ts — ADR 0027 §C2' Stage 1c consumer-side liveness
 * detection (the deferred half of the heartbeat channel).
 *
 * # What this solves
 *
 * Stage 1b (extensions/_shared/heartbeat.ts) ships the WRITER: a periodic
 * beat to an independent trace channel. Stage 1c (this file) ships the
 * READER: given a heartbeat trace, decide whether the producer is alive,
 * has terminated cleanly, or is presumed hung/dead — and, for the
 * hung/dead case, derive the canonical `terminal_state: "cancelled"` +
 * `cancel_source: "timeout"` fields (ADR 0027 §C5 schema).
 *
 * # Scope: what staleness CAN and CANNOT detect (read before wiring)
 *
 * The writer (Stage 1b) emits beats from an unconditional `setInterval`,
 * NOT from task-progress milestones (dispatch never calls handle.beat()).
 * Staleness therefore tracks the liveness of the writer's BEAT-EMITTING
 * EVENT LOOP, not logical task progress. Concretely:
 *
 *   - DETECTS (when observed by a reader whose own loop is alive — i.e.
 *     a cross-process or out-of-band reader): the producer's event loop
 *     stopped emitting beats — process death, a hard crash, or a
 *     synchronous wedge that froze the loop. The trace's last beat goes
 *     stale → cancelled/timeout.
 *   - DOES NOT DETECT: a producer ASYNC-hung inside an LLM/network await
 *     that never resolves. Its event loop stays alive, so `setInterval`
 *     keeps firing "alive" beats and the verdict stays `alive` forever.
 *     That class ("hung in an LLM call") is covered ONLY by the dispatch
 *     `timeoutMs` Promise.race, NOT by this channel.
 *   - IN-PROCESS CAVEAT: pi runs sub-agents in the parent's process, so a
 *     synchronous wedge that stops the writer's timer ALSO blocks any
 *     in-process poller — meaning the reliable guarantee is cross-process
 *     / post-mortem observation, not same-process early detection.
 *
 * This is a narrower guarantee than "distinguishes still-working /
 * crashed / hung-in-LLM-call". Do NOT advertise the hung-LLM case until
 * the writer is made progress-driven (a Stage 1d+ change: dispatch must
 * beat() at genuine progress points and staleness must key off progress
 * beats). The verdict + terminal-state math below is correct within THIS
 * scope.
 *
 * # C3' infra layer
 *
 * Pure structured infra: deterministic staleness math, no LLM, no
 * prompt-native judgment. ADR 0027 §C3' explicitly places multi-agent
 * coordination / liveness / cancellation in the structured infra layer.
 *
 * # Liveness verdict semantics
 *
 *   alive    — last beat is recent (missed beats < threshold).
 *   stale    — missed beats >= threshold → presumed hung/dead. Maps to
 *              cancelled/timeout.
 *   stopped  — last beat phase === "stopping": the writer terminated
 *              cleanly (NOT a timeout). The writer best-effort unlinks the
 *              trace after the stopping beat, so observing a "stopping"
 *              beat means the unlink lost the race — still a clean stop.
 *   unknown  — no trace file / no parseable beats. This is intentionally
 *              ambiguous: it conflates "never started" with "cleanly
 *              stopped and unlinked" (the common terminal state). Callers
 *              MUST NOT treat unknown as a timeout — absence of a trace is
 *              not evidence of a hang.
 *
 * # Why a missed-beat THRESHOLD (not a single missed beat)
 *
 * A single missed interval is normal jitter (GC pause, slow disk flush,
 * an LLM call that briefly exceeds the interval between phase beats). The
 * default threshold of 3 missed beats (= 3 × intervalMs, ~45s at the 15s
 * writer default) is well under a typical 30-minute dispatch timeout while
 * being long enough that ordinary jitter never trips it.
 *
 * # Stage 1d (live in-process polling) is DEFERRED — do not reflexively build it
 *
 * A 3-model blind DESIGN review (opus-4-8 / gpt-5.5 / deepseek-v4-pro,
 * unanimous) concluded that wiring this consumer into the dispatch runtime
 * IN-PROCESS adds ZERO hang-detection capability over the existing
 * `runInProcess` Promise.race(timeoutMs). The truth table all three derived
 * independently:
 *   - async hang (stuck LLM await): event loop alive → timer keeps beating
 *     → verdict stays alive; only timeoutMs catches it (status quo).
 *   - synchronous wedge: the in-process poller is on the SAME frozen loop →
 *     it can't run to observe.
 *   - process death: the poller dies with the producer.
 * The only column where staleness is observable is a CROSS-PROCESS reader,
 * which does not exist (dispatch sub-agents share the parent process).
 * Building it now would be ADR 0024 §10 "infra for imagined load".
 *
 * Concrete triggers that should gate building Stage 1d (and in what form):
 *   1. A cross-process / multi-host L2 topology lands (dispatch spawns
 *      child processes/workers, OR a supervisor reads traces it does not
 *      itself produce) → then THIS consumer (as-is) gains real value for
 *      the sync-wedge / process-death classes.
 *   2. Dogfood shows REAL async-hang waste (sub-agents repeatedly burning
 *      toward the 30-min timeoutMs stuck in LLM calls) AND timeout tuning
 *      can't solve it → then build the PROGRESS-DRIVEN variant (dispatch
 *      calls handle.beat() at token/tool-round milestones so staleness
 *      means "no task progress"), NOT a poller against today's timer beats.
 * Until one of these is observed, the consumer stays a tested foundation.
 *
 * Also out of scope: audit row v3 `heartbeat_trace_path` enrichment.
 */

import {
  readHeartbeatTrace,
  heartbeatTracePath,
  heartbeatTracePathsForAnchor,
  type HeartbeatBeat,
  type HeartbeatPhase,
} from "../_shared/heartbeat";
import type { CausalAnchor } from "../_shared/causal-anchor";
import { buildTerminalStateFields, type TerminalStateFields } from "./terminal-state";

/** Liveness verdict for a heartbeat trace. See file header for semantics. */
export type LivenessVerdict = "alive" | "stale" | "stopped" | "unknown";

/** Default missed-beat threshold before a trace is judged stale. */
export const DEFAULT_MISSED_BEAT_THRESHOLD = 3;

/** Fallback interval when no beat carries interval_ms. Mirrors the writer's
 *  DEFAULT_INTERVAL_MS (15s) which is not exported; kept in sync manually. */
const FALLBACK_INTERVAL_MS = 15_000;

/** Structured result of a liveness assessment. All diagnostic fields are
 *  optional so a consumer can log exactly what it needs. */
export interface LivenessAssessment {
  verdict: LivenessVerdict;
  /** Human-readable explanation of the verdict. */
  reason: string;
  /** Phase of the last beat observed (when any beats were parsed). */
  lastPhase?: HeartbeatPhase;
  /** seq of the last beat. */
  lastSeq?: number;
  /** Number of beats parsed from the trace. */
  beatCount?: number;
  /** Interval used for staleness math (from the started beat, or fallback). */
  observedIntervalMs?: number;
  /** Wall-clock ms between the last beat and `now` (may be negative on skew). */
  msSinceLastBeat?: number;
  /** floor(elapsed / interval): how many expected beats are missing. */
  missedBeats?: number;
  /** True when seq numbers are not contiguous 1..N (dropped/flush-lost
   *  beats); undefined when no beat carries a seq (not assessable).
   *  DIAGNOSTIC ONLY — never affects the verdict. */
  seqGap?: boolean;
}

/** Options for assessLiveness. */
export interface AssessOptions {
  /** Epoch ms for "now". Default Date.now(). Injectable for deterministic tests. */
  now?: number;
  /** Missed-beat threshold (>=). Default DEFAULT_MISSED_BEAT_THRESHOLD. */
  missedBeatThreshold?: number;
  /** Interval to assume when no beat carries interval_ms. Default 15s. */
  fallbackIntervalMs?: number;
}

/**
 * Assess liveness from an already-parsed list of beats. Pure + deterministic.
 *
 * Order of decisions:
 *   1. No beats → unknown (ambiguous: never-started OR cleanly-stopped-unlinked).
 *   2. Last beat phase === "stopping" → stopped (clean termination).
 *   3. Unparseable last ts → unknown (cannot do staleness math).
 *   4. missedBeats >= threshold → stale (→ cancelled/timeout).
 *   5. otherwise → alive.
 */
export function assessLiveness(beats: HeartbeatBeat[], opts: AssessOptions = {}): LivenessAssessment {
  const now = opts.now ?? Date.now();
  const threshold = Math.max(1, opts.missedBeatThreshold ?? DEFAULT_MISSED_BEAT_THRESHOLD);
  // Floor mirrors the writer's own clamp (heartbeat.ts uses Math.max(1_000, …))
  // so a caller passing a tiny fallback cannot make e.g. 3ms read as 3 missed
  // beats → false stale (3-T0 P2). Default FALLBACK_INTERVAL_MS is already 15s.
  const fallbackInterval = Math.max(1_000, opts.fallbackIntervalMs ?? FALLBACK_INTERVAL_MS);

  if (beats.length === 0) {
    return {
      verdict: "unknown",
      reason:
        "no heartbeat trace / no parseable beats (never started, OR cleanly " +
        "stopped and unlinked — absence is NOT evidence of a hang)",
    };
  }

  const last = beats[beats.length - 1];
  const beatCount = beats.length;
  const lastSeq = typeof last.seq === "number" ? last.seq : undefined;

  // seq-gap diagnostic (NEVER drives the verdict): a contiguous 1..N trace
  // has max(seq) === count. undefined = "not assessable" (no seq fields) so
  // a seqless trace is not misreported as gap-free (3-T0 NIT). reduce, not
  // Math.max(...spread), so a pathologically large trace cannot RangeError
  // the argument list (3-T0 NIT).
  const seqs = beats
    .map((b) => b.seq)
    .filter((s): s is number => typeof s === "number");
  const maxSeq = seqs.reduce((m, s) => (s > m ? s : m), 0);
  const seqGap: boolean | undefined = seqs.length > 0 ? maxSeq !== seqs.length : undefined;

  if (last.phase === "stopping") {
    return {
      verdict: "stopped",
      reason: "last beat phase=stopping → producer terminated cleanly",
      lastPhase: "stopping",
      lastSeq,
      beatCount,
      seqGap,
    };
  }

  // interval_ms is written on the "started" beat only; find any beat that
  // carries it, else fall back. (A trace whose started beat was lost to a
  // partial read still degrades gracefully to the fallback interval.)
  const withInterval = beats.find(
    (b) => typeof b.interval_ms === "number" && b.interval_ms > 0,
  );
  const observedIntervalMs =
    withInterval && typeof withInterval.interval_ms === "number"
      ? withInterval.interval_ms
      : fallbackInterval;

  const lastTs = Date.parse(last.ts);
  if (Number.isNaN(lastTs)) {
    return {
      verdict: "unknown",
      reason: `last beat ts unparseable: ${JSON.stringify(last.ts)}`,
      lastPhase: last.phase,
      lastSeq,
      beatCount,
      observedIntervalMs,
      seqGap,
    };
  }

  const msSinceLastBeat = now - lastTs;
  // Clock skew / future ts → treat as a just-emitted beat (0 elapsed).
  const elapsed = msSinceLastBeat > 0 ? msSinceLastBeat : 0;
  const missedBeats = Math.floor(elapsed / observedIntervalMs);

  const base = {
    lastPhase: last.phase,
    lastSeq,
    beatCount,
    observedIntervalMs,
    msSinceLastBeat,
    missedBeats,
    seqGap,
  };

  if (missedBeats >= threshold) {
    return {
      verdict: "stale",
      reason:
        `${missedBeats} missed beats (>= threshold ${threshold}); ` +
        `${msSinceLastBeat}ms since last ${last.phase} beat at ` +
        `interval ${observedIntervalMs}ms → presumed hung/dead`,
      ...base,
    };
  }

  return {
    verdict: "alive",
    reason:
      `${missedBeats} missed beats (< threshold ${threshold}); ` +
      `${msSinceLastBeat}ms since last ${last.phase} beat`,
    ...base,
  };
}

/** Read a trace file and assess. Missing file OR no parseable beats →
 *  unknown (via the empty-beats path). Malformed lines are individually
 *  skipped by readHeartbeatTrace, so a PARTIALLY-corrupt trace still
 *  assesses its surviving beats (it does not collapse to unknown). Never
 *  throws. */
export function assessLivenessFromTrace(
  tracePath: string,
  opts?: AssessOptions,
): LivenessAssessment {
  return assessLiveness(readHeartbeatTrace(tracePath), opts);
}

/** Convenience: resolve the trace path from an anchor, then assess. */
export function assessLivenessForAnchor(
  projectRoot: string,
  anchor: CausalAnchor,
  opts?: AssessOptions,
): LivenessAssessment {
  for (const tracePath of heartbeatTracePathsForAnchor(projectRoot, anchor)) {
    const assessment = assessLivenessFromTrace(tracePath, opts);
    if (assessment.verdict !== "unknown") return assessment;
  }
  return assessLivenessFromTrace(heartbeatTracePath(projectRoot, anchor), opts);
}

/**
 * Map a STALE liveness verdict to canonical terminal-state fields.
 *
 * Returns null for every non-stale verdict — only a presumed-hung producer
 * maps to a terminal state, and only to cancelled/timeout. We deliberately
 * route through the single source of truth `buildTerminalStateFields`
 * (a synthetic `failureType: "timeout"` result + explicit cancelSource)
 * so the cancelled schema (cancel_source / cleanup_done / resumable) stays
 * identical to the dispatch-timeout path.
 *
 * ⚠ Stage 1d wiring contract — a live poller MUST honor ALL of:
 *   1. TASK-SETTLEMENT PRECONDITION: only materialize this result while the
 *      task promise is still UNSETTLED, and re-check settlement once more
 *      before writing it. A child can complete at the same instant the
 *      heartbeat crosses the stale threshold; writing cancelled without a
 *      final recheck emits a spurious cancellation for a task that actually
 *      finished (3-T0 P1).
 *   2. `unknown` is terminal-NEUTRAL forever. Never promote alive→unknown
 *      (the clean-stop unlink path) into a cancellation.
 *   3. assessment.reason is NOT carried into the returned fields (the §C5
 *      cancelled schema has no `reason` slot). The caller MUST log
 *      assessment.reason separately for the audit trail (3-T0 P2).
 *   4. cleanup_done is `true` here as a best-effort/optimistic v1 value. It
 *      was vacuously clean while dispatch was read-only; after the 2026-06-16
 *      env-gate removal a mutating worker CAN leave partial side effects on an
 *      externally-observed hang. Accepted residual (git-is-recovery is the
 *      real backstop, single-user threat model) rather than a cleanup-
 *      accounting engine; tighten to unknown/false only if a real audit
 *      consumer ever needs it.
 *
 * Scope reminder: `stale` only fires when the writer's beat loop stopped
 * (see file header). An async hang with a live event loop is NEVER `stale`
 * here — that is the dispatch timeoutMs's job.
 */
export function terminalStateFromLiveness(
  assessment: LivenessAssessment,
): TerminalStateFields | null {
  if (assessment.verdict !== "stale") return null;
  return buildTerminalStateFields(
    { failureType: "timeout", error: `heartbeat timeout: ${assessment.reason}` },
    { cancelSource: "timeout" },
  );
}
