/**
 * causal-anchor.ts — ADR 0027 C6 cross-layer causal trace anchor.
 *
 * Maintains process-level (session_id, turn_id) state via pi lifecycle
 * events. All pi-astack audit / ledger writers MUST attach the anchor so
 * that cross-layer join — `tail audit.jsonl | jq -r 'select(.session_id==X
 * and .turn_id==Y)'` — works as the only required key for tracing a user
 * turn across L1 (sediment / abrain / model-fallback) and L2 (dispatch /
 * sub-agent / multi-view) loops.
 *
 * # Why our own `turn_id`, not pi's `TurnStartEvent.turnIndex`
 *
 * pi's `turnIndex` resets to 0 on every `agent_start` (verified at
 * core/agent-session.js:351). That is an *inner-loop* counter — tool-call
 * rounds within a single user prompt. ADR 0027 C6 explicitly says
 * `turn_id` is "user single prompt/response round-trip level, monotonic".
 * Those are different semantics. We increment our own counter on
 * `before_agent_start` (fired once per user prompt submission) so the
 * counter is monotonic across the user session.
 *
 * # Anchor derivation rules (per ADR 0027 C6)
 *
 *   - L1 task inherits the current main-session `(session_id, turn_id)`
 *   - L2 sub-task adds `subturn` field but DOES NOT modify the anchor —
 *     so a cross-layer join key stays stable
 *   - dispatch_agent / dispatch_parallel MUST inject the anchor into the
 *     sub-agent's prompt (so the LLM knows where it is in the trace tree)
 *     and into the dispatch audit log
 *
 * # Failure semantics (ADR 0027 C5 fail-degrade)
 *
 * If the anchor cannot be resolved (e.g., audit write fires before any
 * `session_start` — like during smoke tests, or an extension activates
 * before pi has bound a SessionManager), `getCurrentAnchor()` returns
 * `undefined`. Callers MUST still write the log line — observability
 * priority is higher than anchor completeness. `spreadAnchor(undefined)`
 * returns `{}` so the spread is safe in all contexts.
 *
 * # Sub-agent identity
 *
 * `sub_agent_label` is an optional human-readable role tag (e.g.,
 * "review-opus", "smoke-probe"). It is NOT a join key (subturn is) —
 * just diagnostic context, freely settable by dispatch callers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubAgentSession } from "./pi-internals";

// ── Public types ────────────────────────────────────────────────────────

export interface CausalAnchor {
  session_id: string;
  /** Monotonic user-level turn counter (NOT pi's tool-call turnIndex). */
  turn_id: number;
  /** Set only on sub-agent anchors derived from a parent main-session anchor. */
  subturn?: number;
  /** Optional diagnostic role tag for the sub-agent. Not a join key. */
  sub_agent_label?: string;
}

// ── Process-level state ─────────────────────────────────────────────────

let _currentSessionId: string | undefined;
/** User-level turn counter. -1 means "not yet bumped" (no before_agent_start
 *  has fired since session_start). First user prompt → 0. */
let _currentTurnId = -1;
/** Per-(session_id, turn_id) sub-agent sequence counter — keyed
 *  `${session_id}|${turn_id}`. Bumped each time `deriveSubAgentAnchor` is
 *  called within the same parent turn, so dispatch_parallel of N sub-agents
 *  produces subturn=1..N stably across retries (Map persists in-process). */
const _subturnCounters = new Map<string, number>();

// ── Lifecycle binding ───────────────────────────────────────────────────

/** Register session/turn tracking. Call once per extension activate(pi).
 *
 *  # Why both handlers gate on isSubAgentSession(ctx)
 *
 *  Per ADR 0027 PR-B, dispatch's shared loader has `noExtensions: false`,
 *  which means dispatch (and every other pi-astack extension) ALSO
 *  activates in that shared loader — not just in main pi's loader. The
 *  shared loader's ExtensionRunner is what fires session_start /
 *  before_agent_start for every sub-agent AgentSession spawned via
 *  createAgentSession. Module-level state (_currentSessionId, _currentTurnId)
 *  is shared across both runtimes because Node module cache is process-wide.
 *
 *  Without the guard, a sub-agent's session_start would:
 *    1. fire with ctx.sessionManager = the sub-agent's inMemory SessionManager
 *    2. clobber `_currentSessionId` from the main-session ID to the
 *       (ephemeral) sub-agent inMemory ID
 *    3. break `getCurrentAnchor()` from that moment on, since main session's
 *       subsequent audit writes would carry the sub-agent's session_id.
 *
 *  The WeakSet-based `isSubAgentSession(ctx)` check (from pi-internals.ts)
 *  makes both handlers no-op when running inside a marked sub-agent
 *  context, preserving the main-session anchor as single source of truth.
 *
 *  Sub-agent anchors are explicitly derived via `deriveSubAgentAnchor`
 *  by dispatch BEFORE spawning, not by lifecycle events. */
export function bindLifecycle(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    // ADR 0027 PR-B: sub-agent session_start MUST NOT overwrite main-session
    // anchor. The sub-agent's anchor was already derived by dispatch.
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;

    try {
      const sm = (ctx as { sessionManager?: { getSessionId?(): string | null | undefined } })?.sessionManager;
      const id = typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
      _currentSessionId = id ?? undefined;
      _currentTurnId = -1; // next before_agent_start will bump to 0
    } catch {
      // Defensive: extension lifecycle must never throw.
    }
  });
  pi.on("before_agent_start", (_event: unknown, ctx: unknown) => {
    // ADR 0027 PR-B: sub-agent before_agent_start MUST NOT bump main-session
    // turn counter. Sub-agent runs are NOT user turns.
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;

    // Fired once per user prompt submission — perfect monotonic bump point.
    _currentTurnId++;
  });
}

// ── Read API ────────────────────────────────────────────────────────────

/** Current main-session anchor. Returns undefined when:
 *  - bindLifecycle has not been called yet, OR
 *  - session_start hasn't fired (very early extension activate), OR
 *  - before_agent_start hasn't fired yet (between session_start and first user prompt)
 *
 *  Callers (audit writers) MUST NOT block on undefined — write the log
 *  line with whatever they have (per C5 fail-degrade). spreadAnchor()
 *  handles undefined gracefully. */
export function getCurrentAnchor(): CausalAnchor | undefined {
  if (!_currentSessionId || _currentTurnId < 0) return undefined;
  return {
    session_id: _currentSessionId,
    turn_id: _currentTurnId,
  };
}

/** Derive an anchor for a sub-agent dispatched from the current main turn.
 *
 *  Per ADR 0027 C6: the sub-agent inherits `(session_id, turn_id)`
 *  unchanged (so cross-layer join still works), AND gains a `subturn`
 *  field monotonically per parent turn. dispatch_parallel of N tasks
 *  produces subturn=1..N (in call order).
 *
 *  Returns undefined when parent anchor is undefined — caller (dispatch)
 *  should still spawn the sub-agent but log "anchor unavailable" rather
 *  than block. */
export function deriveSubAgentAnchor(
  parent: CausalAnchor | undefined,
  subAgentLabel?: string,
): CausalAnchor | undefined {
  if (!parent) return undefined;
  const key = `${parent.session_id}|${parent.turn_id}`;
  const next = (_subturnCounters.get(key) ?? 0) + 1;
  _subturnCounters.set(key, next);
  return {
    session_id: parent.session_id,
    turn_id: parent.turn_id,
    subturn: next,
    ...(subAgentLabel ? { sub_agent_label: subAgentLabel } : {}),
  };
}

// ── Formatting helpers ──────────────────────────────────────────────────

/** Format an anchor as a prompt header block for sub-agents.
 *
 *  Sub-agent LLMs see this at the top of their prompt so they know where
 *  they are in the trace tree. The block is XML-ish (recognizable by
 *  both LLMs and grep/jq tooling), and includes the marker comment so
 *  downstream parsers can locate it without false positives.
 *
 *  Example output:
 *
 *      <!-- pi-astack/causal-anchor: ADR 0027 C6 -->
 *      <causal_anchor session_id="019e..." turn_id="3" subturn="1" sub_agent_label="review-opus"/>
 */
export function formatAnchorPromptBlock(anchor: CausalAnchor): string {
  const attrs: string[] = [
    `session_id="${anchor.session_id}"`,
    `turn_id="${anchor.turn_id}"`,
  ];
  if (anchor.subturn !== undefined) attrs.push(`subturn="${anchor.subturn}"`);
  if (anchor.sub_agent_label) {
    // Escape quote in label defensively — labels are caller-supplied.
    const safe = String(anchor.sub_agent_label).replace(/"/g, '&quot;');
    attrs.push(`sub_agent_label="${safe}"`);
  }
  return [
    "<!-- pi-astack/causal-anchor: ADR 0027 C6 -->",
    `<causal_anchor ${attrs.join(" ")}/>`,
  ].join("\n");
}

/** Spread anchor fields into an audit log entry object.
 *
 *  Returns the partial object that can be spread INTO a log entry:
 *
 *      const anchor = getCurrentAnchor();
 *      const entry = {
 *        timestamp: ...,
 *        operation: "dispatch_start",
 *        ...spreadAnchor(anchor),  // → session_id, turn_id, subturn?
 *        ... // other fields
 *      };
 *
 *  When anchor is undefined returns `{}` — spread is safe, entry still
 *  writes (per C5 fail-degrade). Absent fields are preferred over null
 *  so downstream `jq 'select(.session_id == X)'` queries work correctly. */
export function spreadAnchor(anchor: CausalAnchor | undefined): Record<string, unknown> {
  if (!anchor) return {};
  const out: Record<string, unknown> = {
    session_id: anchor.session_id,
    turn_id: anchor.turn_id,
  };
  if (anchor.subturn !== undefined) out.subturn = anchor.subturn;
  if (anchor.sub_agent_label) out.sub_agent_label = anchor.sub_agent_label;
  return out;
}

// ── Test-only ───────────────────────────────────────────────────────────

/** Test-only: reset all internal state. Production code MUST NOT call. */
export function _resetCausalAnchorForTests(): void {
  _currentSessionId = undefined;
  _currentTurnId = -1;
  _subturnCounters.clear();
}

/** Test-only: directly set the current anchor (bypassing lifecycle events).
 *  Useful for unit tests that exercise derive/format helpers without
 *  spinning up a real ExtensionAPI. */
export function _setCurrentAnchorForTests(sessionId: string | undefined, turnId: number): void {
  _currentSessionId = sessionId;
  _currentTurnId = turnId;
}
