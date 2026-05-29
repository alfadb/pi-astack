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
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as pathLib from "node:path";
import * as crypto from "node:crypto";
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

// State below is stored on `globalThis[Symbol.for(...)]` so all extension
// instances of this module — each loaded by a separate jiti instance with
// moduleCache:false — share the SAME state. See R4 NEW-P0 fix doc below.
//
// ## Why globalThis singleton (R4 NEW-P0 critical)
//
// pi's extension loader creates a fresh `jiti` instance per extension
// (`core/extensions/loader.js:265: createJiti(..., { moduleCache: false })`)
// AND `moduleCache: false` ALSO disables jiti's nested-import cache: each
// extension that imports `_shared/causal-anchor.ts` gets its OWN copy of
// the module, including separate `currentSessionId`, `currentTurnId`,
// `subturnCounters`, and `triggerAnchorALS` instances.
//
// Empirically verified (R4 jiti probe):
//   - main pi loads dispatch via jiti1 → dispatch.causal-anchor instance A
//   - main pi loads memory via jiti2 → memory.causal-anchor instance B
//   - A.runWithTriggerAnchor(…) writes ALS in A only
//   - B.getCurrentAnchor() reads ALS from B → sees nothing
//
// This breaks ALL cross-extension cross-cutting concerns: R3 sub-agent
// anchor scope, P1-3 memory/llm-search anchor retrofit, even the live
// anchor state read by any extension other than dispatch (only dispatch
// calls bindLifecycle).
//
// Fix: store all shared state on `globalThis[Symbol.for("…")]`. Symbol.for()
// gives a process-wide registry keyed by string — different module instances
// calling `Symbol.for("same-key")` get the SAME symbol → SAME slot on
// globalThis → SAME state object.
//
// ## Versioning
//
// The key includes `/v1` so a future state-shape change can bump the
// version and old + new state can coexist briefly during rollouts.

const _STATE_KEY = Symbol.for("pi-astack/causal-anchor/state/v1");

type CausalAnchorState = {
  currentSessionId: string | undefined;
  /** -1 means "not yet bumped" (no before_agent_start has fired). First user prompt → 0. */
  currentTurnId: number;
  /** Per-(session_id, turn_id) sub-agent sequence counter, keyed `${session_id}|${turn_id}`.
   *  dispatch_parallel of N tasks produces subturn=1..N stably. */
  subturnCounters: Map<string, number>;
  /** AsyncLocalStorage holder for runWithTriggerAnchor trigger-time snapshot.
   *  Same ALS instance shared across all module imports → cross-extension
   *  scope visibility (e.g., dispatch sets scope, sub-agent's memory_decide reads it). */
  triggerAnchorALS: AsyncLocalStorage<{ anchor: CausalAnchor | undefined }>;
  /** Per-turn idempotency flag for the before_agent_start bump. Set true
   *  by the first bump handler that fires in a turn, reset to false on
   *  agent_end / session_start. This lets MULTIPLE extensions register a
   *  bump handler (so each anchor CONSUMER — e.g. memory's Path A injector —
   *  can guarantee a bump runs before its own before_agent_start reader by
   *  binding ahead of it on the same pi) WITHOUT double-incrementing
   *  currentTurnId: only the first bump per turn counts. Replaces the old
   *  registration-time `lifecycleBound` guard, which made a consumer's
   *  bindLifecycle a no-op when dispatch bound first — leaving the bump on a
   *  DIFFERENT pi that could fire AFTER the consumer (the live
   *  anchor_missing-on-Path-A bug, 2026-05-29). */
  turnAlreadyBumped: boolean;
};

function _getState(): CausalAnchorState {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[_STATE_KEY] as CausalAnchorState | undefined;
  if (!state) {
    state = {
      currentSessionId: undefined,
      currentTurnId: -1,
      subturnCounters: new Map<string, number>(),
      triggerAnchorALS: new AsyncLocalStorage<{ anchor: CausalAnchor | undefined }>(),
      turnAlreadyBumped: false,
    };
    g[_STATE_KEY] = state;
  }
  return state;
}

/* ALS instance is part of the globalThis singleton (see _getState above).
 * The doc block below preserves the R1 P0-β design rationale; the ALS
 * itself lives on state.triggerAnchorALS so cross-extension scopes propagate.
 *
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
// (legacy ALS variable removed; lives in state.triggerAnchorALS now)

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
 *  by dispatch BEFORE spawning, not by lifecycle events.
 *
 *  # Multi-binder + per-turn idempotency (ADR 0027 C6, hardened 2026-05-29)
 *
 *  Safe to call from MULTIPLE extensions, and EVERY call registers handlers
 *  (no registration-time no-op). Double-increment is prevented at FIRE time
 *  by `state.turnAlreadyBumped`: the first before_agent_start bump handler to
 *  fire in a turn increments currentTurnId and sets the flag; later bump
 *  handlers in the same turn skip; agent_end / session_start reset the flag.
 *
 *  Why every caller registers (not first-only): an anchor CONSUMER that runs
 *  inside before_agent_start (e.g. memory's Path A injector) must guarantee a
 *  bump fires BEFORE its own read. The only way it can is to register its OWN
 *  bump handler ahead of its reader on the SAME pi (handlers on one pi fire in
 *  registration order). The old first-only guard defeated this: when dispatch
 *  bound first, the consumer's bindLifecycle no-op'd and the bump lived on
 *  dispatch's pi, which could fire AFTER the consumer's reader → the live
 *  anchor_missing-on-Path-A bug. With per-turn idempotency, the consumer can
 *  safely register its own ordered bump without inflating turn_id. */
export function bindLifecycle(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    // ADR 0027 PR-B: sub-agent session_start MUST NOT overwrite main-session
    // anchor. The sub-agent's anchor was already derived by dispatch.
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;

    try {
      const sm = (ctx as { sessionManager?: { getSessionId?(): string | null | undefined } })?.sessionManager;
      const id = typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
      const state = _getState();
      state.currentSessionId = id ?? undefined;
      state.currentTurnId = -1; // next before_agent_start will bump to 0
      state.turnAlreadyBumped = false;
    } catch {
      // Defensive: extension lifecycle must never throw.
    }
  });
  pi.on("before_agent_start", (_event: unknown, ctx: unknown) => {
    // ADR 0027 PR-B: sub-agent before_agent_start MUST NOT bump main-session
    // turn counter. Sub-agent runs are NOT user turns.
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;

    // Per-turn idempotent bump: only the FIRST bump handler to fire this turn
    // increments. Lets multiple extensions register ordered bump handlers
    // (so consumers can guarantee bump-before-read) without double-counting.
    const state = _getState();
    if (!state.turnAlreadyBumped) {
      state.currentTurnId++;
      state.turnAlreadyBumped = true;
    }
  });
  pi.on("agent_end", (_event: unknown, ctx: unknown) => {
    // Reset the per-turn bump flag so the NEXT turn's before_agent_start
    // bumps again. agent_end fires once per turn (incl. error/abort), after
    // the agent loop, so it is the reliable per-turn edge. Sub-agent agent_end
    // must NOT touch the main flag.
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    _getState().turnAlreadyBumped = false;
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
  const state = _getState();
  // (1) trigger-time scope override (ALS) takes precedence
  const scoped = state.triggerAnchorALS.getStore();
  if (scoped) return scoped.anchor;
  // (2) live module state
  if (!state.currentSessionId || state.currentTurnId < 0) return undefined;
  return {
    session_id: state.currentSessionId,
    turn_id: state.currentTurnId,
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
  return _getState().triggerAnchorALS.run({ anchor }, fn);
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
  const counters = _getState().subturnCounters;
  const key = `${parent.session_id}|${parent.turn_id}`;
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
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
  // ADR 0027 PR-B+ R1 P1-8: device_id disambiguates anchors across devices
  // sharing the same ~/.abrain via ADR 0020 git-sync. Without this field,
  // two devices producing identical (session_id=UUID, turn_id=0) rows
  // would collide in cross-device jq joins. Adding device_id keeps the
  // 3-tuple (device_id, session_id, turn_id) globally unique. Resolved
  // lazily once per process; returns undefined-not-set if filesystem
  // resolve fails (best-effort, never throws).
  const did = getDeviceId();
  if (did) out.device_id = did;
  return out;
}

// ── Device id (P1-8) ────────────────────────────────────────
//
// Resolves a stable per-device identifier persisted at
// `~/.abrain/.state/device-id`. Generated on first call; subsequent
// calls hit the in-memory cache.
//
// # Why not hostname / machine-id
//
//   - `os.hostname()` changes when user renames their machine, breaks
//     audit join continuity
//   - `/etc/machine-id` is Linux-only and root-readable assumption is
//     fragile across platforms
//   - PI-astack abrain home is the natural per-user / per-device scope:
//     a fresh ~/.abrain on a new device is a new device by definition
//
// # Failure mode
//
// If the abrain home doesn't exist (very early startup, before any
// pi-astack ext has touched the filesystem) OR if write permission is
// denied (rare; user's own ~/.abrain), returns `undefined`. Spread is
// safe; rows simply won't carry device_id this run.

let _cachedDeviceId: string | null | undefined = undefined;

function abrainStateDir(): string {
  // Resolve the canonical user-global abrain home INLINE. We intentionally do
  // NOT import _shared/runtime: causal-anchor is a low-level module that the
  // isolation smokes compile standalone (copied alone into /tmp), so it must
  // stay dependency-free. This mirrors resolveUserGlobalAbrainHome() EXACTLY
  // (ABRAIN_ROOT || ~/.abrain) so device-id co-locates with outcome-ledger /
  // path-a-ledger under one abrain home, and tests pointing ABRAIN_ROOT at a
  // tmp dir stay sandboxed instead of touching the real ~/.abrain. ABRAIN_HOME
  // is deliberately NOT consulted (no other consumer honors it; the canonical
  // env is ABRAIN_ROOT). device-id is per-abrain-home by design.
  const home = process.env.ABRAIN_ROOT
    ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
    : pathLib.join(os.homedir(), ".abrain");
  return pathLib.join(home, ".state");
}

/** Return the stable device-id for this machine + user, or undefined if
 *  the filesystem resolve fails. Cached after first successful call.
 *  Result of `undefined` is also cached (don't retry filesystem on every
 *  spreadAnchor invocation in this process). */
export function getDeviceId(): string | undefined {
  if (_cachedDeviceId !== undefined) return _cachedDeviceId ?? undefined;
  try {
    const stateDir = abrainStateDir();
    const file = pathLib.join(stateDir, "device-id");
    if (fsSync.existsSync(file)) {
      const raw = fsSync.readFileSync(file, "utf-8").trim();
      // Validate: just check it looks like an id (alnum + dash, 8-40 chars).
      if (/^[A-Za-z0-9-]{8,64}$/.test(raw)) {
        _cachedDeviceId = raw;
        return raw;
      }
      // Corrupted file content: log once and treat as missing; do NOT
      // auto-rewrite (could be a sync conflict that needs operator
      // attention).
      console.warn(
        `pi-astack: device-id at ${file} has unexpected format; ignoring (rows won't carry device_id). Inspect and delete to regenerate.`,
      );
      _cachedDeviceId = null;
      return undefined;
    }
    // Generate + persist
    fsSync.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const newId = crypto.randomUUID();
    // Atomic write: tmp + rename, so concurrent processes can't observe a
    // half-written file (one will win, the other reads the winner's value).
    const tmpFile = pathLib.join(stateDir, `device-id.${process.pid}.tmp`);
    fsSync.writeFileSync(tmpFile, newId + "\n", { mode: 0o600 });
    try {
      // rename is atomic on POSIX; on a race the other process's rename wins
      // first, our subsequent rename overwrites. Either way the file ends up
      // with A or B uniformly; we then read whichever landed (next call).
      fsSync.renameSync(tmpFile, file);
    } catch {
      try { fsSync.unlinkSync(tmpFile); } catch {}
    }
    // Re-read the file to canonicalize (in case of cross-process race the
    // file may now hold the OTHER process's id, not ours).
    try {
      const canonical = fsSync.readFileSync(file, "utf-8").trim();
      if (/^[A-Za-z0-9-]{8,64}$/.test(canonical)) {
        _cachedDeviceId = canonical;
        return canonical;
      }
    } catch {}
    _cachedDeviceId = newId;
    return newId;
  } catch (err) {
    // Filesystem unavailable / permission denied — cache the failure to
    // avoid retry loops; rows won't carry device_id this run.
    _cachedDeviceId = null;
    return undefined;
  }
}

/** Test-only: clear the device-id cache so a subsequent call re-resolves
 *  from disk. Production must not call. */
export function _resetDeviceIdCacheForTests(): void {
  _cachedDeviceId = undefined;
}

// ── Test-only ───────────────────────────────────────────────────────────

/** Test-only: reset all internal state. Production code MUST NOT call. */
export function _resetCausalAnchorForTests(): void {
  const state = _getState();
  state.currentSessionId = undefined;
  state.currentTurnId = -1;
  state.subturnCounters.clear();
  state.turnAlreadyBumped = false;
  // ALS is per-async-context; no global reset needed. Any test that wants
  // to assert "no scope active" should just call getCurrentAnchor() outside
  // any runWithTriggerAnchor() block.
}

/** Test-only: directly set the current anchor (bypassing lifecycle events).
 *  Useful for unit tests that exercise derive/format helpers without
 *  spinning up a real ExtensionAPI. */
export function _setCurrentAnchorForTests(sessionId: string | undefined, turnId: number): void {
  const state = _getState();
  state.currentSessionId = sessionId;
  state.currentTurnId = turnId;
}
