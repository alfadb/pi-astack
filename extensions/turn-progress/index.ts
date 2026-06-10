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
 *     footer status AND a one-line pre-working widget here so the user
 *     gets immediate visual confirmation that pi heard them. A stale
 *     timer fallback guards against early-exit paths in prompt() (input
 *     handlers returning `handled`, missing model/key, compaction
 *     failures) where neither agent_start nor agent_end would fire to
 *     clear the indicators.
 *
 *   Layer B  (light prototype monkey-patch)
 *     We patch `ExtensionRunner.prototype.emitBeforeAgentStart` so that
 *     each time the loop is about to invoke a per-extension handler, we
 *     update the footer status and pre-working widget to show which
 *     extension is running. This turns the previously-invisible serial
 *     chain into a live progress readout like `⠋ memory` using the same
 *     spinner frames as pi's native Working loader.
 *
 * Both layers degrade independently. If the patch fails to install (pi
 * upgrade changed the runner shape), Layer A still works and the user
 * sees an animated `preparing…` footer plus `Working… preparing turn`
 * widget until pi's own spinner takes over.
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
 *     Disables Layer B only; Layer A (preparing… banner + widget) still
 *     works. /reload will restore the pristine prototype.
 *
 *   PI_ASTACK_TURN_PROGRESS_NO_WIDGET=1
 *     Disables only the pre-working widget; footer status remains.
 *
 * These vars are read at activate() time. Changing them mid-session has
 * no effect until /reload.
 *
 * ## Sub-agent skip
 *
 * The `ExtensionRunner` prototype is process-wide, so the patch fires
 * inside dispatch-spawned sub-agents too. We don't unconditionally
 * suppress the patch (sub-agent has a no-op uiContext so setStatus /
 * setWidget calls are harmless), but every lifecycle handler that
 * captures `ctx.ui.setStatus` / `ctx.ui.setWidget` into module state
 * MUST gate on `isSubAgentSession(ctx)` — otherwise a sub-agent's
 * `input` hook overwrites the main session's captured UI references
 * with the sub-agent's no-op, killing Layer B's updates for the
 * duration of the sub-agent run. This invariant is documented in
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
const WIDGET_KEY = "turn-progress-pre-working";
const WIDGET_PLACEMENT = "aboveEditor" as const;

// Keep this in sync with @earendil-works/pi-tui's Loader defaults so the
// pre-working indicator visually matches pi's native Working spinner.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

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
 * 120s is a conservative heuristic for the PRE-before_agent_start window
 * only: long enough to cover slow pre-prompt compaction and queued-input
 * while an existing turn is still streaming, but still bounded so true
 * early-exit stale indicators do not linger forever.
 *
 * Once Layer B sees the first before_agent_start handler-bearing
 * extension, it replaces this short timer with the long watchdog below.
 * This is critical because Path A memory injection can legitimately run
 * for 40–90s; the old 30s timer cleared the footer mid-injection,
 * making users see "indicator disappeared but pi is still waiting".
 */
const STALE_TIMEOUT_MS = 120_000;

/** Long watchdog used after the before_agent_start chain has definitely
 *  begun. agent_start / agent_end are still the normal clear edges; this
 *  only prevents a genuinely stuck chain from leaving a footer forever. */
const BEFORE_AGENT_START_WATCHDOG_MS = 5 * 60_000;

// ── Shared state on globalThis ──────────────────────────────────────
//
// Same rationale as pi-internals.ts: jiti loads each extension in its
// own instance with moduleCache:false, so module-level lets are NOT
// shared between extensions. We must use globalThis[Symbol.for(...)]
// for the captured setStatus reference and patched-flag to survive
// across module instances.

type SetStatusFn = (key: string, text: string | undefined) => void;
type SetWidgetFn = (
  key: string,
  content: string[] | undefined,
  options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

interface TurnProgressState {
  /** Captured setStatus arrow (bound to its UI instance). Layer B reads
   *  this; Layer A writes it on each `input` event from the MAIN session. */
  setStatus: SetStatusFn | undefined;
  /** Captured setWidget arrow (bound to its UI instance) for the
   *  non-footer pre-working row. */
  setWidget: SetWidgetFn | undefined;
  /** Captured theme.fg("accent", ...) for spinner colouring. */
  themeAccent: ((s: string) => string) | undefined;
  /** Captured theme.fg("muted", ...) for Working/status text colouring. */
  themeMuted: ((s: string) => string) | undefined;
  /** Current raw footer label (without spinner frame), if visible. */
  statusLabel: string | undefined;
  /** Current raw widget label (without spinner frame / Working prefix), if visible. */
  widgetLabel: string | undefined;
  /** Shared spinner frame for footer + widget. */
  spinnerFrameIndex: number;
  /** Interval that animates the pre-working spinner. */
  spinnerTimer: ReturnType<typeof setInterval> | undefined;
  /** True once installEmitPatch has succeeded on the runner prototype. */
  patched: boolean;
  /** Active status-clear timer: short preflight stale fallback before
   *  Layer B starts, then a long watchdog while before_agent_start runs. */
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
      setWidget: undefined,
      themeAccent: undefined,
      themeMuted: undefined,
      statusLabel: undefined,
      widgetLabel: undefined,
      spinnerFrameIndex: 0,
      spinnerTimer: undefined,
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
 *    C:\\…\\pi-astack\\extensions\\memory\\index.ts → "memory"
 *    /…/pi-astack/extensions/abrain/index.ts   → "abrain"
 *    <inline:foo>                              → "<inline:foo>"
 */
export function extractShortName(extPath: string): string {
  if (extPath.startsWith("<") && extPath.endsWith(">")) return extPath;
  // Normalize Windows separators, then strip trailing slash and take the
  // directory name above the file.
  const normalized = extPath.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash < 0) return trimmed || extPath;
  const beforeFile = trimmed.slice(0, lastSlash);
  const dirSlash = beforeFile.lastIndexOf("/");
  const shortName = dirSlash < 0 ? beforeFile : beforeFile.slice(dirSlash + 1);
  if (!shortName) return trimmed.slice(lastSlash + 1) || extPath;
  return shortName;
}

function formatSpinnerText(state: TurnProgressState, label: string): string {
  const accent = state.themeAccent ?? ((s: string) => s);
  const muted = state.themeMuted ?? ((s: string) => s);
  const frame = SPINNER_FRAMES[state.spinnerFrameIndex % SPINNER_FRAMES.length] ?? "";
  const indicator = frame.length > 0 ? `${accent(frame)} ` : "";
  return `${indicator}${muted(label)}`;
}

function formatLine(state: TurnProgressState, shortName: string): string {
  return formatSpinnerText(state, shortName);
}

function formatPreparing(state: TurnProgressState): string {
  return formatSpinnerText(state, "preparing…");
}

function formatWidget(state: TurnProgressState, label: string): string[] {
  return [formatSpinnerText(state, `Working… ${label}`)];
}

function formatWidgetPreparing(state: TurnProgressState): string[] {
  return formatWidget(state, "preparing turn");
}

function formatWidgetLine(state: TurnProgressState, shortName: string): string[] {
  return formatWidget(state, shortName);
}

function formatWidgetAwaitingModel(state: TurnProgressState): string[] {
  return formatWidget(state, "awaiting model…");
}

/** Honest terminal label for the HANDOFF window after the before_agent_start
 *  chain completes but before agent_start fires.
 *
 *  Accuracy note (verified against pi-agent-core agent-loop.js): agent_start
 *  is emitted at the START of the agent loop, BEFORE the provider request
 *  (`emit(agent_start)` → … → runLoop/stream). turn-progress clears the
 *  footer on agent_start. So this label covers the post-chain handoff
 *  (append custom messages, apply system prompt, enter agent.prompt) — NOT
 *  the provider time-to-first-token (the native Working spinner owns that,
 *  after agent_start). Without this label the footer froze on the LAST
 *  handler's extension name (e.g. the chain-tail time-injector),
 *  misattributing the handoff window to an extension. */
function formatAwaitingModel(state: TurnProgressState): string {
  return formatSpinnerText(state, "awaiting model…");
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

function armStatusClearTimer(state: TurnProgressState, timeoutMs: number): void {
  clearStaleTimer(state);
  state.staleTimer = setTimeout(() => {
    state.staleTimer = undefined;
    clearIndicatorsIfCaptured(state);
  }, timeoutMs);
  // Unref so this timer never holds the event loop open at exit.
  // Not all runtimes implement .unref(), so guard.
  const tref = state.staleTimer as unknown as { unref?: () => void };
  if (typeof tref.unref === "function") tref.unref();
}

function setStatusIfCaptured(state: TurnProgressState, text: string | undefined): void {
  if (typeof state.setStatus !== "function") return;
  try {
    state.setStatus(STATUS_KEY, text);
  } catch {
    // best-effort
  }
}

function setWidgetIfCaptured(state: TurnProgressState, content: string[] | undefined): void {
  if (typeof state.setWidget !== "function") return;
  try {
    state.setWidget(WIDGET_KEY, content, { placement: WIDGET_PLACEMENT });
  } catch {
    // best-effort
  }
}

function hasVisibleIndicator(state: TurnProgressState): boolean {
  return state.statusLabel !== undefined || state.widgetLabel !== undefined;
}

function refreshAnimatedIndicators(state: TurnProgressState): void {
  if (state.statusLabel !== undefined) {
    setStatusIfCaptured(state, formatSpinnerText(state, state.statusLabel));
  }
  if (state.widgetLabel !== undefined) {
    setWidgetIfCaptured(state, formatWidget(state, state.widgetLabel));
  }
}

function stopSpinnerTimer(state: TurnProgressState): void {
  if (state.spinnerTimer !== undefined) {
    clearInterval(state.spinnerTimer);
    state.spinnerTimer = undefined;
  }
}

function startSpinnerTimerIfNeeded(state: TurnProgressState): void {
  if (state.spinnerTimer !== undefined || !hasVisibleIndicator(state)) return;
  state.spinnerTimer = setInterval(() => {
    if (!hasVisibleIndicator(state)) {
      stopSpinnerTimer(state);
      return;
    }
    state.spinnerFrameIndex = (state.spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
    refreshAnimatedIndicators(state);
  }, SPINNER_INTERVAL_MS);
  const tref = state.spinnerTimer as unknown as { unref?: () => void };
  if (typeof tref.unref === "function") tref.unref();
}

function syncSpinnerTimer(state: TurnProgressState): void {
  if (hasVisibleIndicator(state)) {
    startSpinnerTimerIfNeeded(state);
  } else {
    stopSpinnerTimer(state);
  }
}

function setStatusLabelIfCaptured(state: TurnProgressState, label: string | undefined): void {
  const wasVisible = hasVisibleIndicator(state);
  if (label !== undefined && typeof state.setStatus !== "function") {
    state.statusLabel = undefined;
    syncSpinnerTimer(state);
    return;
  }
  state.statusLabel = label;
  if (!wasVisible && label !== undefined) state.spinnerFrameIndex = 0;
  setStatusIfCaptured(state, label === undefined ? undefined : formatSpinnerText(state, label));
  syncSpinnerTimer(state);
}

function setWidgetLabelIfCaptured(state: TurnProgressState, label: string | undefined): void {
  const wasVisible = hasVisibleIndicator(state);
  if (label !== undefined && typeof state.setWidget !== "function") {
    state.widgetLabel = undefined;
    syncSpinnerTimer(state);
    return;
  }
  state.widgetLabel = label;
  if (!wasVisible && label !== undefined) state.spinnerFrameIndex = 0;
  setWidgetIfCaptured(state, label === undefined ? undefined : formatWidget(state, label));
  syncSpinnerTimer(state);
}

/** Clear the footer status using the most recently captured setStatus
 *  (which is bound to the main session's UI, never the sub-agent's). */
function clearStatusIfCaptured(state: TurnProgressState): void {
  setStatusLabelIfCaptured(state, undefined);
}

function clearWidgetIfCaptured(state: TurnProgressState): void {
  setWidgetLabelIfCaptured(state, undefined);
}

function clearIndicatorsIfCaptured(state: TurnProgressState): void {
  clearStatusIfCaptured(state);
  clearWidgetIfCaptured(state);
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

    // Skip instrumentation if we don't have captured main-session UI
    // references yet (first-ever turn before Layer A fires) or if
    // we're inside a sub-agent runner (no real UI to update).
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
    // Sub-agent UI gate (3-T0 P2): the patch is process-wide and
    // captured UI functions resolve to the MAIN session. Without this,
    // a dispatch-spawned sub-agent's before_agent_start chain would write
    // to the MAIN footer/widget — and the terminal "awaiting model…"
    // would LINGER, since the sub-agent's own agent_start clear is itself
    // isSubAgentSession-gated. Gate all UI WRITES (never handler
    // execution) on main-session, honoring the module-wide invariant.
    const shouldLabel =
      (!!captured || typeof state.setWidget === "function") &&
      !isSubAgentSession(baseCtx as { sessionManager?: unknown });
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
    // Track whether Layer B labeled at least one handler-bearing extension.
    // Only then is there a stale ext-name to correct with the terminal
    // "awaiting model…" status after the loop (zero-handler chains leave
    // Layer A's preparing… banner untouched — no regression).
    let anyHandlerLabeled = false;

    for (const ext of exts) {
      // Defensive hardening #2: optional chaining on ext.handlers.
      const handlers = ext.handlers?.get("before_agent_start");
      if (!handlers || handlers.length === 0) continue;

      // INSTRUMENT: announce which extension is starting (main session only).
      if (shouldLabel) {
        if (!anyHandlerLabeled) {
          // P0 fix: Layer A's 120s stale fallback only belongs to the
          // pre-before_agent_start window. Once we are about to run the
          // first real handler, replace it with a long watchdog so slow
          // but healthy Path A memory injection remains visible until
          // agent_start clears the footer.
          armStatusClearTimer(state, BEFORE_AGENT_START_WATCHDOG_MS);
        }
        anyHandlerLabeled = true;
        const shortName = extractShortName(ext.path ?? "<unknown>");
        setStatusLabelIfCaptured(state, shortName);
        setWidgetLabelIfCaptured(state, shortName);
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

    // turn-progress fix (footer freeze): the chain is done. Replace the
    // last per-extension label with an honest terminal "awaiting model…"
    // for the post-chain handoff window (NOT provider TTFT — see
    // formatAwaitingModel's accuracy note), so that window is not
    // misattributed to whichever extension ran last (e.g. the chain-tail
    // time-injector). Gated on anyHandlerLabeled (⇒ shouldLabel was true,
    // i.e. main session AND ≥1 ext labeled) so zero-handler chains and
    // sub-agents keep their prior footer untouched. agent_start clears it.
    //
    // No yieldToEventLoop() here (unlike the per-ext label): the caller's
    // next await (entering agent.prompt → agent loop) provides the tick
    // that flushes this to the TUI. Adding a yield would inject latency
    // into every turn's hot path for no benefit.
    if (shouldLabel && anyHandlerLabeled) {
      setStatusLabelIfCaptured(state, "awaiting model…");
      setWidgetLabelIfCaptured(state, "awaiting model…");
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
  const disableWidget = disableAll || process.env.PI_ASTACK_TURN_PROGRESS_NO_WIDGET === "1";

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
    // doesn't reuse stale main-session UI references.
    clearStaleTimer(state);
    clearIndicatorsIfCaptured(state);
    state.setStatus = undefined;
    state.setWidget = undefined;
    state.themeAccent = undefined;
    state.themeMuted = undefined;
    return;
  }

  if (disableWidget) {
    clearWidgetIfCaptured(state);
    state.setWidget = undefined;
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

  // Layer A: capture setStatus + setWidget + theme, set preparing…
  // banner and pre-working row, yield for TUI flush. Gated on:
  //   - not a sub-agent session (prevents overwriting main-session
  //     captured UI refs with sub-agent's no-op);
  //   - input source is "interactive" (skips programmatic /extension
  //     submissions that don't represent a user pressing Enter).
  pi.on("input", async (event, ctx) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    const source = (event as { source?: string }).source;
    if (source !== undefined && source !== "interactive") return;

    const ui = (ctx as {
      ui?: {
        setStatus?: SetStatusFn;
        setWidget?: SetWidgetFn;
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
    if (!disableWidget && typeof ui.setWidget === "function") {
      state.setWidget = ui.setWidget.bind(ui);
    } else {
      state.setWidget = undefined;
    }

    const fg = ui.theme?.fg;
    if (typeof fg === "function") {
      const theme = ui.theme!;
      state.themeAccent = (s: string) => fg.call(theme, "accent", s);
      state.themeMuted = (s: string) => fg.call(theme, "muted", s);
    } else {
      state.themeAccent = undefined;
      state.themeMuted = undefined;
    }

    setStatusLabelIfCaptured(state, "preparing…");
    setWidgetLabelIfCaptured(state, "preparing turn");

    // Short stale-status fallback: if the prompt exits before Layer B
    // enters before_agent_start, clear ourselves. Once Layer B sees the
    // first handler-bearing extension, it replaces this with the long
    // before_agent_start watchdog.
    armStatusClearTimer(state, STALE_TIMEOUT_MS);

    // Critical: yield so the TUI render loop gets a chance to flush
    // the new status before downstream synchronous work
    // (_checkCompaction, emitBeforeAgentStart) takes over.
    await yieldToEventLoop();
  });

  // Clear on agent_start — pi's native Working spinner now takes over.
  pi.on("agent_start", (_event, ctx) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    clearStaleTimer(state);
    clearIndicatorsIfCaptured(state);
  });

  // Belt-and-suspenders: agent_end clears too, in case agent_start
  // never fired (e.g. before_agent_start handler threw, prompt was
  // queued during streaming and never produced a fresh agent_start).
  pi.on("agent_end", (_event, ctx) => {
    if (isSubAgentSession(ctx as { sessionManager?: unknown })) return;
    clearStaleTimer(state);
    clearIndicatorsIfCaptured(state);
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
  WIDGET_KEY,
  STALE_TIMEOUT_MS,
  BEFORE_AGENT_START_WATCHDOG_MS,
  SPINNER_INTERVAL_MS,
  installEmitPatch,
  restoreEmitPatch,
  getState,
};
