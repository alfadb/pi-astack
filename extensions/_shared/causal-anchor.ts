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

import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * ADR 0027 PR-B+ R1 P0-β — trigger-time anchor snapshot storage.
 *
 * # Problem this solves
 *
 * sediment's `agent_end` handler does ~60s of fire-and-forget LLM work
 * (Lane C extractor, curator). The handler returns its promise to pi
 * immediately, but the bg work continues. If the user submits the NEXT
 * prompt before that bg work completes:
 *   1. `before_agent_start` fires for turn N+1 → bumps `_currentTurnId`
 *      from N to N+1
 *   2. The still-running bg writer calls `getCurrentAnchor()` → returns
 *      `{session_id, turn_id: N+1}` instead of the trigger-time `N`
 *   3. Audit row for work TRIGGERED by turn N gets written with turn N+1's
 *      anchor → cross-layer join key is WRONG
 *
 * R1 review (3-LLM consensus, P0-β) flagged this as making C6 join key
 * "observability retrofit, not strict causal provenance".
 *
 * # Mechanism
 *
 * `AsyncLocalStorage` from `node:async_hooks` propagates per-async-context
 * state through promise chains, including fire-and-forget promises created
 * INSIDE a `.run()` scope (they capture the store at creation, not at
 * consumption). Lifecycle handlers wrap their body in
 * `runWithTriggerAnchor(getCurrentAnchor(), () => ...)`. All
 * `getCurrentAnchor()` calls from inside that scope — even from a 60s-later
 * background writer — see the SNAPSHOTTED anchor, not the live state.
 *
 * # Why a holder object
 *
 * `als.getStore()` returns the stored value OR `undefined` when no scope.
 * To distinguish "scope active with no-anchor (undefined deliberately set)"
 * from "no scope, fall back to live", we wrap in `{ anchor: ... }`. When
 * `getStore()` returns a holder, scope is active (even if `anchor` itself
 * is undefined). When `getStore()` returns undefined, no scope is active.
 *
 * # Edge cases
 *
 *   - Sub-agent dispatched FROM inside a scope: dispatch.execute reads
 *     `getCurrentAnchor()` synchronously (still inside scope) → sub-agent
 *     gets the trigger-time parent anchor. ✓
 *   - Pi processing the NEXT user prompt: that's a NEW event from pi's
 *     input loop, NOT an async resource spawned from sediment's scope.
 *     ALS does NOT leak across event sources. ✓
 *   - Multiple lifecycle handlers running concurrently: each
 *     `runWithTriggerAnchor` creates its own ALS context. ✓
 */
const _triggerAnchorALS = new AsyncLocalStorage<{ anchor: CausalAnchor | undefined }>();

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

/** Current main-session anchor.
 *
 *  Resolution order (per ADR 0027 PR-B+ R1 P0-β):
 *   1. If running inside `runWithTriggerAnchor(anchor, ...)` scope, return
 *      that scope's snapshotted anchor (even if it's `undefined`). This
 *      is the trigger-time guarantee for long-running async writers.
 *   2. Otherwise, return the LIVE module-level `(session_id, turn_id)`.
 *      Used for synchronous reads at trigger sites (e.g., dispatch.execute
 *      reading the current parent anchor).
 *
 *  Returns undefined when (live path):
 *   - bindLifecycle has not been called yet, OR
 *   - session_start hasn't fired (very early extension activate), OR
 *   - before_agent_start hasn't fired yet (between session_start and first user prompt)
 *
 *  Callers (audit writers) MUST NOT block on undefined — write the log
 *  line with whatever they have (per C5 fail-degrade). spreadAnchor()
 *  handles undefined gracefully. */
export function getCurrentAnchor(): CausalAnchor | undefined {
  // (1) trigger-time scope override (ALS) takes precedence
  const scoped = _triggerAnchorALS.getStore();
  if (scoped) return scoped.anchor;
  // (2) live module state
  if (!_currentSessionId || _currentTurnId < 0) return undefined;
  return {
    session_id: _currentSessionId,
    turn_id: _currentTurnId,
  };
}

/** Run `fn` inside a trigger-anchor scope. All `getCurrentAnchor()` calls
 *  inside the scope — including those from fire-and-forget promises
 *  created during the scope's synchronous body — will return `anchor`
 *  even after the live module-level turn counter advances.
 *
 *  Lifecycle handlers that trigger fire-and-forget audit writers (sediment
 *  `agent_end`, compaction-tuner `agent_end`, etc.) MUST wrap their body
 *  in this scope. Synchronous handlers don't need it (live anchor still
 *  reflects trigger turn).
 *
 *  Example:
 *
 *      pi.on("agent_end", async (event, ctx) => {
 *        if (isSubAgentSession(ctx)) return;
 *        return runWithTriggerAnchor(getCurrentAnchor(), async () => {
 *          // ... all bg work; every getCurrentAnchor() call inside this
 *          //     closure sees the trigger-turn anchor, not later live state.
 *          fireAndForgetBgWriter();  // also inherits scope ✓
 *        });
 *      });
 */
export function runWithTriggerAnchor<T>(
  anchor: CausalAnchor | undefined,
  fn: () => T,
): T {
  return _triggerAnchorALS.run({ anchor }, fn);
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
  // ALS is per-async-context; no global reset needed. Any test that wants
  // to assert "no scope active" should just call getCurrentAnchor() outside
  // any runWithTriggerAnchor() block.
}

/** Test-only: directly set the current anchor (bypassing lifecycle events).
 *  Useful for unit tests that exercise derive/format helpers without
 *  spinning up a real ExtensionAPI. */
export function _setCurrentAnchorForTests(sessionId: string | undefined, turnId: number): void {
  _currentSessionId = sessionId;
  _currentTurnId = turnId;
}
