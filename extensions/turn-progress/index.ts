/**
 * turn-progress extension for pi-astack — make the "I pressed Enter but
 * nothing seems to be happening" gap visible.
 *
 * ## The gap this fixes
 *
 * pi's native `Working...` spinner is created inside InteractiveMode's
 * `case "agent_start":` event branch
 * (pi-coding-agent/dist/modes/interactive/interactive-mode.js:2147-2169,
 * with `createWorkingLoader()` at L2167). But `agent_start` only fires
 * AFTER the entire `before_agent_start` extension chain has been awaited
 * serially inside `ExtensionRunner.emitBeforeAgentStart`
 * (pi-coding-agent/dist/core/extensions/runner.js:700-748) plus an
 * optional pre-flight `_checkCompaction` LLM call. In a stack like ours
 * (time-injector → abrain/rule-injector → sediment → model-curator →
 * memory ×2, where memory does ADR-0015 two-stage LLM rerank) that gap
 * is routinely 1–10s, and on user-perceived timing it looks like "pi
 * froze". The relevant brain entry is
 * `pi-extension-hook-handlers-are-awaited-synchronously`.
 *
 * ## Two layers of indicator
 *
 *   Layer A  (public-API only)
 *     pi.on("input") is the EARLIEST extension hook in
 *     `AgentSession.prompt()` (the user-message path) — it fires before
 *     `_checkCompaction` and before `emitBeforeAgentStart`. We set a
 *     footer status here so the user gets immediate visual confirmation
 *     that pi heard them. A stale-status timer fallback guards against
 *     early-exit paths in prompt() (input handlers returning `handled`,
 *     missing model/key, compaction failures) where neither agent_start
 *     nor agent_end would fire to clear the status.
 *
 *   Layer B  (light prototype monkey-patch)
 *     We patch `ExtensionRunner.prototype.emitBeforeAgentStart` so that
 *     each time the loop is about to invoke a per-extension handler, we
 *     update the footer status to show which extension is running. This
 *     turns the previously-invisible serial chain into a live progress
 *     readout like `⏳ memory`.
 *
 * Both layers degrade independently. If the patch fails to install (pi
 * upgrade changed the runner shape), Layer A still works and the user
 * sees a static `⏳ preparing…` until pi's own spinner takes over.
 *
 * ## Why a monkey-patch is appropriate here
 *
 * pi already exposes `pi-internals.ts`-style patches in this repo
 * (turn-boundary compaction, sub-agent boundary sentinel). The
 * `ExtensionRunner` class is a public export of
 * `@earendil-works/pi-coding-agent`, so prototype patching is the
 * sanctioned in-extension escape hatch for behaviour pi doesn't yet
 * expose as a hook. Idempotent via a `Symbol.for(...)` guard, and we
 * stash the original under a separate symbol so opt-out can restore
 * pristine behaviour at /reload time.
 *
 * ## Why yieldToEventLoop() is needed
 *
 * `ctx.ui.setStatus(...)` only schedules a render via
 * `ui.requestRender()` — actual paint happens on the next event-loop
 * tick. Without an explicit yield, the entire chain
 * `input handlers → _checkCompaction → emitBeforeAgentStart` runs
 * synchronously (each `await` resolves immediately) and the TUI never
 * gets a chance to flush the new status to screen until much later. The
 * yield is one tick — sub-millisecond in practice — but it's what makes
 * the indicator actually appear.
 *
 * ## Opt-out
 *
 *   PI_ASTACK_DISABLE_TURN_PROGRESS=1
 *     Disables both layers. If the prototype was already patched in a
 *     previous load, /reload will restore the pristine method. Full
 *     process restart is not required.
 *
 *   PI_ASTACK_TURN_PROGRESS_NO_PATCH=1
 *     Disables Layer B only; Layer A (preparing… banner) still works.
 *     /reload will restore the pristine prototype.
 *
 * Both vars are read at activate() time. Changing them mid-session has
 * no effect until /reload.
 *
 * ## Sub-agent skip
 *
 * The `ExtensionRunner` prototype is process-wide, so the patch fires
 * inside dispatch-spawned sub-agents too. We don't unconditionally
 * suppress the patch (sub-agent has a no-op uiContext so setStatus
 * calls are harmless), but every lifecycle handler that captures
 * `ctx.ui.setStatus` into module state MUST gate on
 * `isSubAgentSession(ctx)` — otherwise a sub-agent's `input` hook
 * overwrites the main session's captured setStatus reference with the
 * sub-agent's no-op, killing Layer B's status updates for the duration
 * of the sub-agent run. This invariant is documented in
 * `_shared/pi-internals.ts` under "Sub-agent session marker".
 *
 * ## Compatibility with non-pi runtimes
 *
 * `setImmediate` is a Node-specific extension; on Bun, Deno, browsers,
 * or constrained environments (Termux) it may be absent. `yieldToEventLoop()`
 * picks `setImmediate` when present, else falls back to `setTimeout(_, 0)`.
 */

import {
  ExtensionRunner,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";
import { isSubAgentSession } from "../_shared/pi-internals";

// ── Symbols (named to match pi-internals.ts convention so grep can ──
//    find every prototype-patch site in this repo from one term) ──
//
// Convention: TURN_PROGRESS_<METHOD>_<KIND>. The state symbol uses the
// /v1 suffix so a future major rework can bump it without colliding
// with the previous module-instance's state.

const PATCH_VERSION = "2026-05-29.turn-progress.v1";
const TURN_PROGRESS_EMIT_BEFORE_AGENT_START_PATCHED = Symbol.for(
  "pi-astack.turn-progress.ExtensionRunner.emitBeforeAgentStart.patched",
);
const TURN_PROGRESS_ORIGINAL_EMIT_BEFORE_AGENT_START = Symbol.for(
  "pi-astack.turn-progress.ExtensionRunner.emitBeforeAgentStart.original",
);
const TURN_PROGRESS_STATE_KEY = Symbol.for("pi-astack.turn-progress.state/v1");

const STATUS_KEY = FOOTER_STATUS_KEYS.turnProgress;

/**
 * Stale-status timeout. If a turn enters `input` but neither
 * `agent_start` nor `agent_end` fires within this window, the status
 * is cleared automatically. Covers prompt() early-exit paths:
 *   - input handler returns { action: "handled" } (no agent run)
 *   - no model / missing API key (throws before _runAgentPrompt)
 *   - streaming-in-progress: message goes to steer/followUp queue,
 *     no new agent_start fires until the current turn ends
 *   - _checkCompaction failure paths
 *
 * 30s is a soft heuristic — long enough that a slow memory rerank
 * won't trigger a false clear, short enough that a stuck status
 * doesn't sit for minutes.
 */
const STALE_TIMEOUT_MS = 30_000;

// ── Shared state on globalThis ──────────────────────────────────────
//
// Same rationale as pi-internals.ts: jiti loads each extension in its
// own instance with moduleCache:false, so module-level lets are NOT
// shared between extensions. We must use globalThis[Symbol.for(...)]
// for the captured setStatus reference and patched-flag to survive
// across module instances.

type SetStatusFn = (key: string, text: string | undefined) => void;

interface TurnProgressState {
  /** Captured setStatus arrow (bound to its UI instance). Layer B reads
   *  this; Layer A writes it on each `input` event from the MAIN session. */
  setStatus: SetStatusFn | undefined;
  /** Captured theme.fg("accent", ...) for status text colouring. */
  themeAccent: ((s: string) => string) | undefined;
  /** True once installEmitPatch has succeeded on the runner prototype. */
  patched: boolean;
  /** One-shot timer reference for the stale-status fallback (Layer A). */
  staleTimer: ReturnType<typeof setTimeout> | undefined;
  /** warnOnce dedup. */
  warned: Set<string>;
}

function getState(): TurnProgressState {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[TURN_PROGRESS_STATE_KEY] as TurnProgressState | undefined;
  if (!state) {
    state = {
      setStatus: undefined,
      themeAccent: undefined,
      patched: false,
      staleTimer: undefined,
      warned: new Set<string>(),
    };
    g[TURN_PROGRESS_STATE_KEY] = state;
  }
  return state;
}

function warnOnce(state: TurnProgressState, tag: string, msg: string): void {
  if (state.warned.has(tag)) return;
  state.warned.add(tag);
  // Don't use process.stderr.write: pi captures stderr into the TUI
  // footer area (anti-pattern: stderr-write-leaks-to-pi-tui).
  console.warn(`pi-astack/turn-progress: ${msg}`);
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Yield one event-loop tick so the TUI render loop can flush. Picks
 *  setImmediate when present (Node) and falls back to setTimeout(_, 0)
 *  on Bun/browsers/etc. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** Extract a short, user-facing name from an extension path. pi-astack
 *  layout (verified against pi's loader.js:resolveExtensionEntries) is
 *  always `.../<name>/index.ts` — the dirname's basename IS the short
 *  name. Falls back to a sensible default for unusual layouts.
 *
 *  Examples:
 *    /…/pi-astack/extensions/memory/index.ts   → "memory"
 *    /…/pi-astack/extensions/abrain/index.ts   → "abrain"
 *    <inline:foo>                              → "<inline:foo>"
 */
export function extractShortName(extPath: string): string {
  if (extPath.startsWith("<") && extPath.endsWith(">")) return extPath;
  // Strip trailing slash, take the directory name above the file.
  const trimmed = extPath.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash < 0) return trimmed || extPath;
  const beforeFile = trimmed.slice(0, lastSlash);
  const dirSlash = beforeFile.lastIndexOf("/");
  const shortName = dirSlash < 0 ? beforeFile : beforeFile.slice(dirSlash + 1);
  if (!shortName) return trimmed.slice(lastSlash + 1) || extPath;
  return shortName;
}

function formatLine(state: TurnProgressState, shortName: string): string {
  const accent = state.themeAccent ?? ((s: string) => s);
  return accent(`⏳ ${shortName}`);
}

function formatPreparing(state: TurnProgressState): string {
  const accent = state.themeAccent ?? ((s: string) => s);
  return accent("⏳ preparing…");
}

/** Cancel any pending stale-status timer. Called whenever agent_start /
 *  agent_end fires (normal completion path) or when a fresh `input`
 *  arrives (replaces the previous timer). */
function clearStaleTimer(state: TurnProgressState): void {
  if (state.staleTimer !== undefined) {
    clearTimeout(state.staleTimer);
    state.staleTimer = undefined;
  }
}

/** Clear the footer status using the most recently captured setStatus
 *  (which is bound to the main session's UI, never the sub-agent's). */
function clearStatusIfCaptured(state: TurnProgressState): void {
  if (typeof state.setStatus !== "function") return;
  try {
    state.setStatus(STATUS_KEY, undefined);
  } catch {
    // best-effort
  }
}

// ── Layer B: prototype patch ────────────────────────────────────────

interface RunnerInstance {
  extensions?: Array<{ path?: string; handlers?: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>> }>;
  createContext?: () => Record<PropertyKey, unknown>;
  assertActive?: () => void;
  emitError?: (info: { extensionPath?: string; event?: string; error?: string; stack?: string }) => void;
}

type EmitBeforeAgentStartFn = (
  this: RunnerInstance,
  prompt: string,
  images: unknown,
  systemPrompt: string,
  systemPromptOptions: unknown,
) => Promise<{ messages?: unknown[]; systemPrompt?: string } | undefined>;

type HandlerResult =
  | { message?: unknown; systemPrompt?: string }
  | undefined
  | void;

/**
 * Install the per-handler progress patch on ExtensionRunner.prototype.
 * Returns true on success, false if any precondition (prototype shape,
 * method presence) is not met. Idempotent — re-calling is a no-op.
 *
 * ## Strategy: mirror pi's loop, instrument it
 *
 * We replace `emitBeforeAgentStart` with a behaviourally-equivalent
 * re-implementation that adds setStatus calls between extensions.
 *
 * Two **intentional** deviations from pi's exact behaviour, both
 * defensive hardening rather than semantic drift:
 *
 *   1. `assertActive` is called only when present (typeof guard). pi's
 *      original calls it unconditionally; in practice every real
 *      ExtensionRunner has it. The guard exists so a future pi version
 *      that omits the method doesn't immediately crash this patch —
 *      we'd rather degrade than blow up. Documented hardening.
 *
 *   2. `ext.handlers` is read via optional chaining. pi's original
 *      assumes it's always a Map. Same rationale.
 *
 * Everything else mirrors line-for-line. `emitError` calls are NOT
 * try/wrapped — they propagate exactly as in pi's source, so any error
 * listener that throws aborts the loop just like upstream.
 *
 * ## Pi version this mirrors
 *
 * Source: pi-coding-agent/dist/core/extensions/runner.js:700-748
 * Verified shape:
 *   - per-extension serial for-of over `this.extensions`
 *   - per-extension `handlers.get("before_agent_start")` may be undef/empty
 *   - per-handler serial await
 *   - shared `ctx` built once with `getSystemPrompt()` returning the
 *     LIVE currentSystemPrompt (closure-captured) so handlers in later
 *     extensions see earlier extensions' mutations
 *   - per-handler try/catch routing to `this.emitError(...)` with
 *     {extensionPath, event, error, stack}
 *   - return shape: undefined when no mutation, else
 *     { messages?: [...], systemPrompt?: string }
 *
 * The smoke `scripts/smoke-turn-progress.mjs` re-verifies this contract
 * by spawning a mini runner with two extensions and asserting the
 * merged systemPrompt + messages match what an un-patched runner would
 * produce, AND it reads the real pi runner.js source and asserts the
 * upstream method body contains the expected anchor lines — so a pi
 * upgrade that changes loop semantics is caught loudly.
 */
function installEmitPatch(proto: Record<PropertyKey, unknown>): boolean {
  const state = getState();
  if (proto[TURN_PROGRESS_EMIT_BEFORE_AGENT_START_PATCHED] === PATCH_VERSION) {
    state.patched = true;
    return true;
  }

  const original = proto["emitBeforeAgentStart"];
  if (typeof original !== "function") {
    warnOnce(
      state,
      "no-emit-method",
      "ExtensionRunner.prototype.emitBeforeAgentStart is missing — pi may " +
        "have been upgraded with a different runner shape. Layer B " +
        "(per-handler progress) disabled; Layer A (preparing… banner) " +
        "still works.",
    );
    return false;
  }

  // Always stash the most-recently-seen pristine original so opt-out
  // restoration can reach it. The guard prevents overwriting with our
  // own wrapper if installEmitPatch is called a second time across
  // module reloads (PATCH_VERSION marker handles the no-op case but a
  // future version bump would re-enter this block — then we MUST keep
  // the original ref the FIRST install captured, not the wrapped one).
  if (!proto[TURN_PROGRESS_ORIGINAL_EMIT_BEFORE_AGENT_START]) {
    proto[TURN_PROGRESS_ORIGINAL_EMIT_BEFORE_AGENT_START] = original;
  }

  const wrapped: EmitBeforeAgentStartFn = async function emitBeforeAgentStartInstrumented(
    this,
    prompt,
    images,
    systemPrompt,
    systemPromptOptions,
  ) {
    const exts = Array.isArray(this.extensions) ? this.extensions : undefined;

    // Skip instrumentation if we don't have a captured main-session
    // setStatus reference yet (first-ever turn before Layer A fires)
    // or if we're inside a sub-agent runner (no real UI to update).
    // The pre-check on this.createContext / emitError mirrors the
    // contract pi's original requires; both the original AND the mirror
    // need them, so missing-affordance branches degrade to no-op
    // (returning undefined is semantically equivalent to "no handlers
    // mutated anything" — safe).
    const captured = state.setStatus;
    if (
      !exts ||
      typeof this.createContext !== "function" ||
      typeof this.emitError !== "function"
    ) {
      // Degraded no-op: no UI work, no handler invocation. The same
      // call on the pristine original would crash on missing methods.
      warnOnce(
        state,
        "missing-runner-affordances",
        "ExtensionRunner instance missing createContext or emitError — " +
          "skipping before_agent_start. Likely an unusual runtime mode.",
      );
      return undefined;
    }

    // ── Begin pi.emitBeforeAgentStart mirror ───────────────────────
    // Lines below correspond 1:1 to runner.js:700-748. Two defensive
    // typeof / optional-chain hardenings documented above; everything
    // else is exact behavioural equivalence.

    let currentSystemPrompt = systemPrompt;
    const baseCtx = this.createContext();
    const ctx: Record<PropertyKey, unknown> = Object.defineProperties(
      {} as Record<PropertyKey, unknown>,
      Object.getOwnPropertyDescriptors(baseCtx),
    );
    ctx.getSystemPrompt = () => {
      // Defensive hardening #1: typeof guard. pi calls unconditionally.
      if (typeof this.assertActive === "function") this.assertActive();
      return currentSystemPrompt;
    };

    const messages: unknown[] = [];
    let systemPromptModified = false;

    for (const ext of exts) {
      // Defensive hardening #2: optional chaining on ext.handlers.
      const handlers = ext.handlers?.get("before_agent_start");
      if (!handlers || handlers.length === 0) continue;

      // INSTRUMENT: announce which extension is starting.
      if (captured) {
        const shortName = extractShortName(ext.path ?? "<unknown>");
        try {
          captured(STATUS_KEY, formatLine(state, shortName));
        } catch {
          // setStatus errors must not affect pi's loop.
        }
        // Yield once before the handler runs so the TUI flushes the
        // new status. Sub-millisecond cost; without it, fast-but-many
        // extensions render as a single flash at the end.
        await yieldToEventLoop();
      }

      for (const handler of handlers) {
        try {
          const event = {
            type: "before_agent_start",
            prompt,
            images,
            systemPrompt: currentSystemPrompt,
            systemPromptOptions,
          };
          const handlerResult = (await handler(event, ctx)) as HandlerResult;
          if (handlerResult) {
            const result = handlerResult as { message?: unknown; systemPrompt?: string };
            if (result.message) {
              messages.push(result.message);
            }
            if (result.systemPrompt !== undefined) {
              currentSystemPrompt = result.systemPrompt;
              systemPromptModified = true;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          // emitError propagates exactly like pi's source — if an error
          // listener throws, the agent loop aborts here, same as upstream.
          // No try/catch wrapping (review feedback: behaviour must match
          // pi's contract exactly, no silent observability swallow).
          this.emitError!({
            extensionPath: ext.path,
            event: "before_agent_start",
            error: message,
            stack,
          });
        }
      }
    }

    if (messages.length > 0 || systemPromptModified) {
      return {
        messages: messages.length > 0 ? messages : undefined,
        systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
      };
    }
    return undefined;
    // ── End pi.emitBeforeAgentStart mirror ─────────────────────────
  };

  (proto as Record<PropertyKey, unknown>)["emitBeforeAgentStart"] = wrapped;
  proto[TURN_PROGRESS_EMIT_BEFORE_AGENT_START_PATCHED] = PATCH_VERSION;
  state.patched = true;
  return true;
}

/**
 * Restore the pristine `emitBeforeAgentStart` on the given prototype.
 * Used by the opt-out env-var paths so that a /reload with the var set
 * fully clears Layer B's footprint. Returns true if a restoration
 * happened, false if there was nothing to restore (never patched, or
 * already restored).
 */
export function restoreEmitPatch(proto: Record<PropertyKey, unknown>): boolean {
  if (proto[TURN_PROGRESS_EMIT_BEFORE_AGENT_START_PATCHED] === undefined) {
    return false;
  }
  const original = proto[TURN_PROGRESS_ORIGINAL_EMIT_BEFORE_AGENT_START];
  if (typeof original !== "function") {
    // We marked it as patched but lost the original — defensive.
    // Don't unmark, just bail; manual intervention is safer than
    // pretending we restored something we can't.
    return false;
  }
  proto["emitBeforeAgentStart"] = original;
  delete proto[TURN_PROGRESS_EMIT_BEFORE_AGENT_START_PATCHED];
  delete proto[TURN_PROGRESS_ORIGINAL_EMIT_BEFORE_AGENT_START];
  const state = getState();
  state.patched = false;
  return true;
}

// ── Extension entry point ───────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const state = getState();
  const proto = (ExtensionRunner as unknown as { prototype?: Record<PropertyKey, unknown> })
    .prototype;

  // Both env vars are honoured at activate time. If we previously
  // patched (e.g. a prior /reload without the var set), restore the
  // prototype now so /reload-with-var-set actually undoes the patch.
  const disableAll = process.env.PI_ASTACK_DISABLE_TURN_PROGRESS === "1";
  const disablePatch = disableAll || process.env.PI_ASTACK_TURN_PROGRESS_NO_PATCH === "1";

  if (proto && disablePatch) {
    try {
      restoreEmitPatch(proto);
    } catch (err) {
      warnOnce(
        state,
        "restore-throw",
        `restoreEmitPatch threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (disableAll) {
    // Layer A also clears any stale captured state so a re-enable later
    // doesn't reuse a stale setStatus reference.
    state.setStatus = undefined;
    state.themeAccent = undefined;
    clearStaleTimer(state);
    return;
  }

  // Install Layer B unless explicitly disabled. ExtensionRunner is
  // class-imported above; its prototype is final by the time activate
  // runs. If pi upgraded and removed/renamed the method,
  // installEmitPatch warns once and we degrade to Layer-A-only.
  if (!disablePatch) {
    try {
      if (proto) {
        installEmitPatch(proto);
      } else {
        warnOnce(
          state,
          "no-proto",
          "ExtensionRunner.prototype is missing — Layer B disabled.",
        );
      }
    } catch (err) {
      warnOnce(
        state,
        "patch-throw",
        `Layer B install threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Layer A: capture setStatus + theme, set preparing… banner, yield
  // for TUI flush. Gated on:
  //   - not a sub-agent session (prevents overwriting main-session
  //     captured setStatus with sub-agent's no-op);
  //   - input source is "interactive" (skips programmatic /extension
  //     submissions that don't represent a user pressing Enter).
  pi.on("input", async (event, ctx) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    const source = (event as { source?: string }).source;
    if (source !== undefined && source !== "interactive") return;

    const ui = (ctx as {
      ui?: {
        setStatus?: SetStatusFn;
        theme?: { fg?: (color: string, text: string) => string };
      };
    }).ui;
    if (!ui || typeof ui.setStatus !== "function") return;

    // Bind setStatus to ui so future calls survive even if pi changes
    // the implementation from an arrow to a method. Today it's an
    // arrow (interactive-mode.js:1540), so .bind is a no-op cost-wise
    // but a robustness gain.
    const boundSetStatus = ui.setStatus.bind(ui);
    state.setStatus = boundSetStatus;

    const fg = ui.theme?.fg;
    if (typeof fg === "function") {
      const theme = ui.theme!;
      state.themeAccent = (s: string) => fg.call(theme, "accent", s);
    } else {
      state.themeAccent = undefined;
    }

    try {
      boundSetStatus(STATUS_KEY, formatPreparing(state));
    } catch {
      // best-effort
    }

    // Stale-status fallback: if neither agent_start nor agent_end
    // clears within STALE_TIMEOUT_MS, clear ourselves. Covers early-
    // exit paths in prompt() (handler returned `handled`, missing
    // model/key, queued during streaming, compaction failures).
    clearStaleTimer(state);
    state.staleTimer = setTimeout(() => {
      state.staleTimer = undefined;
      clearStatusIfCaptured(state);
    }, STALE_TIMEOUT_MS);
    // Unref so this timer never holds the event loop open at exit.
    // Not all runtimes implement .unref(), so guard.
    const tref = state.staleTimer as unknown as { unref?: () => void };
    if (typeof tref.unref === "function") tref.unref();

    // Critical: yield so the TUI render loop gets a chance to flush
    // the new status before downstream synchronous work
    // (_checkCompaction, emitBeforeAgentStart) takes over.
    await yieldToEventLoop();
  });

  // Clear on agent_start — pi's native Working spinner now takes over.
  pi.on("agent_start", (_event, ctx) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    clearStaleTimer(state);
    clearStatusIfCaptured(state);
  });

  // Belt-and-suspenders: agent_end clears too, in case agent_start
  // never fired (e.g. before_agent_start handler threw, prompt was
  // queued during streaming and never produced a fresh agent_start).
  pi.on("agent_end", (_event, ctx) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    clearStaleTimer(state);
    clearStatusIfCaptured(state);
  });
}

// ── Test-only exports ───────────────────────────────────────────────

export const __TEST = {
  extractShortName,
  yieldToEventLoop,
  PATCH_VERSION,
  PATCH_MARKER: TURN_PROGRESS_EMIT_BEFORE_AGENT_START_PATCHED,
  ORIGINAL_MARKER: TURN_PROGRESS_ORIGINAL_EMIT_BEFORE_AGENT_START,
  STATE_KEY: TURN_PROGRESS_STATE_KEY,
  STATUS_KEY,
  STALE_TIMEOUT_MS,
  installEmitPatch,
  restoreEmitPatch,
  getState,
};
