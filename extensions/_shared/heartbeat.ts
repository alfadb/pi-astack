/**
 * heartbeat.ts — ADR 0027 §C2' v1 Stage 1b independent liveness channel.
 *
 * # What this solves
 *
 * ADR 0027 §C2' declares heartbeat is necessary because stigmergy has a
 * structural blind spot in completion semantics: a missing trace mutation
 * can mean any of (a) producer still working, (b) producer crashed,
 * (c) producer hung inside an LLM call. The three cases are physically
 * indistinguishable from artifact-channel observation alone.
 *
 * Heartbeat writes a periodic beat to an INDEPENDENT trace channel
 * (separate file path from dispatch audit). Caller polls the heartbeat
 * file; absence of N consecutive expected beats lets the caller safely
 * infer `terminal_state: "cancelled"` with `cancel_source: "timeout"`
 * via Stage 1a's terminal_state schema.
 *
 * # v1 scope (Stage 1b)
 *
 *   - Writer side only.
 *   - File-based liveness channel (file watcher / poll consumer is
 *     Stage 1c).
 *   - Path: `<projectRoot>/.pi-astack/dispatch/heartbeat/${session_id}_${turn_id}_${subturn}.jsonl`
 *     (R1 §4.3 sketch).
 *   - Each beat is one JSONL line carrying the anchor + ts + phase + pid.
 *   - Best-effort: any write failure is swallowed; dispatch never blocks
 *     on heartbeat IO (parity with appendDispatchAudit's fail-degrade).
 *   - Fail-open: if anchor is undefined (e.g., dispatch fires before
 *     before_agent_start ever ran), heartbeat is skipped entirely so
 *     dispatch continues. The trace file path needs anchor to be unique.
 *   - File cleanup on stop: best-effort unlink so .pi-astack/dispatch/
 *     heartbeat/ doesn't accumulate after a long-running dogfood session.
 *     If cleanup fails, the file remains as a historical record.
 *
 * # NOT in v1 (deferred to Stage 1c+)
 *
 *   - Consumer-side staleness detection.
 *   - Automatic dispatch-tool-level timeout reduction based on missed
 *     heartbeat (caller still observes the existing dispatch timeoutMs).
 *   - Heartbeat for non-dispatch L2 tasks (sediment auto-write, etc.) —
 *     scope is dispatch only in v1.
 *
 * # C3' infra layer
 *
 * The writer is pure structured infra. No LLM, no prompt-native judgment.
 * Phase values are a small fixed enum (started / alive / stopping) so
 * grep/jq tooling can mechanically reason about file content.
 *
 * # R4 jiti singleton compliance
 *
 * Active HeartbeatHandle registry is stored on
 * `globalThis[Symbol.for("pi-astack/heartbeat/state/v1")]` per the R4
 * NEW-P0 lesson (jiti `moduleCache: false` means each extension that
 * imports this module gets its own copy of module-level Maps otherwise).
 * Different extensions all share the same registry.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spreadAnchor } from "./causal-anchor";
import type { CausalAnchor } from "./causal-anchor";

/** Fixed phase taxonomy (C3' infra: structured, not free-form). */
export type HeartbeatPhase = "started" | "alive" | "stopping";

/** Heartbeat schema version. Stage 1c consumers should branch on this to
 *  tolerate future additive fields. Bump only when shape changes
 *  non-additively. */
export const HEARTBEAT_SCHEMA_VERSION = 1;

/** One heartbeat trace line on disk. */
export interface HeartbeatBeat {
  ts: string;
  phase: HeartbeatPhase;
  pid: number;
  /** Schema version (R8 GPT-5.5 P2-1 / DeepSeek P2-1): lets Stage 1c
   *  consumers branch on schema shape without inferring from absent
   *  fields. Always equal to HEARTBEAT_SCHEMA_VERSION in v1. */
  schema_version: number;
  /** Monotonic per-handle beat counter (1 for started, then 2..N for
   *  alive/stopping). Lets a consumer detect dropped beats from disk
   *  flush failures or partial reads even when ts gap is normal. */
  seq: number;
  /** Interval the writer is configured to emit alive beats at, in
   *  milliseconds. Set on the FIRST beat only (started); consumers cache
   *  it for subsequent staleness math. Stage 1c uses this to compute
   *  `expected_next_beat_at = last_ts + interval_ms` and detect missed
   *  beats reliably without hardcoding the dispatch default. */
  interval_ms?: number;
  /** Spread anchor fields: session_id, turn_id, subturn?, sub_agent_label?,
   *  device_id?. Always present in v1 (heartbeat is skipped when anchor
   *  is undefined; see startHeartbeat). */
  session_id?: string;
  turn_id?: number;
  subturn?: number;
  sub_agent_label?: string;
  device_id?: string;
  /** Optional caller-supplied diagnostic. Not used by the consumer. */
  note?: string;
}

/** Handle returned by startHeartbeat. Owner is responsible for calling
 *  stop() when the task ends (success, error, abort, timeout — all paths). */
export interface HeartbeatHandle {
  /** Whether this handle is actively writing beats. False after stop()
   *  or when startHeartbeat returned a no-op handle (anchor missing /
   *  IO error during setup). */
  readonly active: boolean;
  /** Write one beat immediately (in addition to the periodic timer).
   *  Useful for phase transitions: "now starting prompt", "now waiting
   *  for stream". Safe to call after stop() — becomes a no-op. */
  beat(phase: HeartbeatPhase, note?: string): void;
  /** Stop the periodic timer, write a final "stopping" beat, and best-
   *  effort unlink the trace file. Idempotent: subsequent calls no-op. */
  stop(): void;
  /** Inspect the resolved trace file path (undefined for no-op handles).
   *  Exposed for tests and audit-row enrichment. */
  readonly tracePath: string | undefined;
}

/** Configuration for startHeartbeat. */
export interface HeartbeatOptions {
  /** Used to derive the per-task trace file path. If undefined, the
   *  returned handle is a no-op (heartbeat skipped fail-open). */
  anchor: CausalAnchor | undefined;
  /** Root for the .pi-astack/dispatch/heartbeat/ subdirectory. */
  projectRoot: string;
  /** Interval between automatic "alive" beats, in milliseconds. Default
   *  15s (long enough to be cheap, short enough that 3 misses = 45s
   *  beats well under a typical 30min dispatch timeout). */
  intervalMs?: number;
  /** Optional first-beat note. Useful for setup-phase diagnostics. */
  startedNote?: string;
}

// ── globalThis singleton (R4 NEW-P0 lesson) ───────────────────────────

const _STATE_KEY = Symbol.for("pi-astack/heartbeat/state/v1");

interface HeartbeatState {
  /** Map keyed by tracePath. Lets us detect duplicate start requests
   *  for the same anchor (would normally only happen in tests, but a
   *  defensive guard is cheap). Value is the handle. */
  active: Map<string, HeartbeatHandle>;
}

function _getState(): HeartbeatState {
  const g = globalThis as Record<symbol, unknown>;
  let s = g[_STATE_KEY] as HeartbeatState | undefined;
  if (!s) {
    s = { active: new Map() };
    g[_STATE_KEY] = s;
  }
  return s;
}

// ── Path resolution ───────────────────────────────────────────────────

/** Build the heartbeat trace file path from an anchor. Returns undefined
 *  when anchor is missing the join key components (session_id, turn_id)
 *  — heartbeat is skipped in that case (fail-open).
 *
 *  Filename format: `${session_id}_${turn_id}_${subturn}.jsonl`
 *  When `subturn` is undefined (main session dispatch_agent without a
 *  derived sub-anchor), it defaults to 0 in the filename so two
 *  unrelated dispatches in the same turn don't collide.
 *
 *  Exported for tests + Stage 1c consumer code that needs to find
 *  heartbeat files for a given anchor. */
export function heartbeatTracePath(
  projectRoot: string,
  anchor: CausalAnchor,
): string {
  const subturn = anchor.subturn ?? 0;
  return path.join(
    projectRoot,
    ".pi-astack",
    "dispatch",
    "heartbeat",
    `${anchor.session_id}_${anchor.turn_id}_${subturn}.jsonl`,
  );
}

// ── Writer ────────────────────────────────────────────────────────────

const NO_OP_HANDLE: HeartbeatHandle = Object.freeze({
  active: false,
  beat: () => {},
  stop: () => {},
  tracePath: undefined,
});

const DEFAULT_INTERVAL_MS = 15_000;

/** Append one beat synchronously. Best-effort: any exception (IO error
 *  AND any other failure mode) is swallowed so dispatch never blocks on
 *  heartbeat write failure. The narrow read is "observability is
 *  optional"; we'd rather lose a beat than break dispatch. */
function appendBeat(filePath: string, beat: HeartbeatBeat): void {
  try {
    const line = JSON.stringify(beat) + "\n";
    fs.appendFileSync(filePath, line, { encoding: "utf-8" });
  } catch {
    // Any failure (IO error, serialization, etc.) swallowed. Heartbeat
    // is pure observability; never blocks dispatch.
  }
}

/** Start a heartbeat writer for the given anchor + project root.
 *
 *  Returns a no-op HeartbeatHandle when:
 *    - anchor is undefined (e.g., dispatch fires before
 *      before_agent_start has run — extremely rare),
 *    - the trace directory cannot be created (permissions / disk),
 *  so the caller can unconditionally `start()` then `stop()` without
 *  needing to branch on success.
 *
 *  v1 always starts the heartbeat regardless of expected duration —
 *  the cost is trivial (one file write every 15s). ADR 0027 §C2''s
 *  condition "expected execution > caller timeout × 50%" is left for
 *  Stage 1c when consumer detection lands; until then, blanket
 *  heartbeats give Stage 1c something to read. */
export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  if (!opts.anchor || !opts.anchor.session_id) {
    return NO_OP_HANDLE;
  }

  const tracePath = heartbeatTracePath(opts.projectRoot, opts.anchor);
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  } catch {
    return NO_OP_HANDLE;
  }

  const intervalMs = Math.max(1_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const anchor = opts.anchor;
  const state = _getState();

  // Defensive: if the same trace path is already active, return existing
  // handle. This protects against accidental double-start (test fixtures,
  // rapid retry loops). The existing handle is the canonical writer.
  const existing = state.active.get(tracePath);
  if (existing) return existing;

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let nextSeq = 1;

  /** Write a beat. The `force` flag bypasses the `stopped` guard so
   *  stop() can emit the terminal "stopping" beat even after setting
   *  the guard (R8 unanimous P1 fix: previous stop() set stopped=true
   *  BEFORE calling writeOne("stopping"), so the writeOne guard silently
   *  swallowed the terminal beat; stage 1c consumers had no way to
   *  distinguish clean stop from writer crash without cross-referencing
   *  audit). */
  function writeOne(phase: HeartbeatPhase, opts: { note?: string; force?: boolean } = {}): void {
    if (stopped && !opts.force) return;
    const beat: HeartbeatBeat = {
      ts: new Date().toISOString(),
      phase,
      pid: process.pid,
      schema_version: HEARTBEAT_SCHEMA_VERSION,
      seq: nextSeq++,
      // R8 P2-1 (GPT-5.5 + DeepSeek): expose interval on the started
      // beat so consumers don't hardcode the dispatch default. Repeating
      // it on every beat is wasted bytes but lets a consumer that only
      // reads the last line still know the contract. v1 chose started-only.
      ...(phase === "started" ? { interval_ms: intervalMs } : {}),
      ...spreadAnchor(anchor),
      ...(opts.note ? { note: opts.note } : {}),
    };
    appendBeat(tracePath, beat);
  }

  // Initial "started" beat so consumers see the trace channel exists
  // immediately, not after the first interval tick.
  writeOne("started", { note: opts.startedNote });

  timer = setInterval(() => writeOne("alive"), intervalMs);
  // Don't keep the Node process alive for heartbeat alone — when the
  // dispatch tool resolves, the process should be allowed to exit
  // naturally even if stop() hasn't been called yet (defensive against
  // caller forgetting to stop on an error path).
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  const handle: HeartbeatHandle = {
    get active() {
      return !stopped;
    },
    beat(phase: HeartbeatPhase, note?: string) {
      writeOne(phase, { note });
    },
    stop() {
      if (stopped) return;
      // Write the terminal "stopping" beat BEFORE flipping the guard so
      // it actually lands on disk (force:true is belt-and-suspenders).
      writeOne("stopping", { force: true });
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      // Best-effort cleanup: delete the trace file so .pi-astack/
      // dispatch/heartbeat/ doesn't accumulate stale files over a
      // long-running dogfood session. If unlink fails the file
      // remains as a stale record — non-fatal, swept by an external
      // gc if needed.
      try {
        fs.unlinkSync(tracePath);
      } catch {
        // ENOENT / EACCES / etc. — non-fatal.
      }
      state.active.delete(tracePath);
    },
    tracePath,
  };
  state.active.set(tracePath, handle);
  return handle;
}

// ── Read-side helpers (used by tests + Stage 1c consumer) ─────────────

/** Sanity ceiling for a heartbeat trace read (3-T0 P2). A real trace is
 *  ~120 beats × ~200 B ≈ 24 KB (15s interval over a 30-min dispatch, then
 *  unlinked on stop). 1 MB (~5000 beats) is far beyond any legitimate
 *  trace; above it we refuse the read rather than risk OOM on a writer-bug
 *  / orphan-append / tampered file. */
const MAX_TRACE_BYTES = 1024 * 1024;

/** Read all beats from a heartbeat trace file. Returns [] when the file
 *  is missing, oversized, or corrupt (per-line skip). Exposed for Stage 1c
 *  consumer code and for smoke tests. */
export function readHeartbeatTrace(tracePath: string): HeartbeatBeat[] {
  let raw: string;
  try {
    // Size guard BEFORE slurping: stat is O(1) and bounds the read so a
    // pathologically large trace cannot OOM the consumer (or RangeError a
    // downstream spread). Oversized → [] (treated as no parseable beats).
    if (fs.statSync(tracePath).size > MAX_TRACE_BYTES) return [];
    raw = fs.readFileSync(tracePath, "utf-8");
  } catch {
    return [];
  }
  const beats: HeartbeatBeat[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.ts === "string") {
        beats.push(parsed as HeartbeatBeat);
      }
    } catch {
      // Skip malformed line.
    }
  }
  return beats;
}

/** Tests + diagnostics: clear the active handles registry. Production
 *  never needs this because stop() removes the entry. */
export function _resetHeartbeatRegistryForTests(): void {
  _getState().active.clear();
}
