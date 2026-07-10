/**
 * pi-internals — centralized access to internal pi APIs not exposed
 * through the public ExtensionAPI.
 *
 * pi's extension sandbox deliberately narrows the types of ctx.sessionManager
 * and other objects to limit what extensions can do.  Some capabilities
 * (buildSessionContext for continuation-call caching) require accessing the
 * underlying SessionManager instance directly.
 *
 * This module provides:
 *   - Typed wrappers with runtime safety checks
 *   - Startup integrity verification (are the APIs still there?)
 *   - Graceful fallback when APIs change across pi versions
 *
 * ## Adding a new internal API:
 *   1. Add a getter function below with runtime type checks
 *   2. Add a check in STARTUP_CHECKS
 *   3. Use the getter in extension code instead of raw casts
 */

import { randomUUID } from "node:crypto";
import {
  AgentSession,
  CompactionSummaryMessageComponent,
  InteractiveMode,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// ── Types for internal APIs we depend on ─────────────────────────────────

/** Messages array from buildSessionContext (what pi sends to the LLM). */
export interface SessionMessages {
  messages: unknown[];
  thinkingLevel?: string;
  model?: { provider: string; modelId: string } | null;
}

/** Subset of SessionManager we need internally. */
interface InternalSessionManager {
  buildSessionContext?(): SessionMessages;
}

type AbortSignalSource = { signal?: AbortSignal };

type AgentLoopTurnUpdate = {
  context?: {
    systemPrompt: string;
    messages: unknown[];
    tools: unknown[];
  };
  model?: unknown;
  thinkingLevel?: string;
};

type PrepareNextTurnFn = (signalOrContext?: AbortSignal | PrepareNextTurnContext, signalSource?: AbortSignalSource) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;

type PrepareNextTurnContext = {
  message?: unknown;
  toolResults?: unknown[];
  context?: { messages?: unknown[] };
  newMessages?: unknown[];
};

type InteractiveHandleEventFn = (event: Record<string, unknown>) => Promise<void> | void;

interface InternalAgentLike {
  createLoopConfig?: (...args: unknown[]) => unknown;
  prepareNextTurn?: PrepareNextTurnFn;
  state?: {
    systemPrompt?: string;
    messages?: unknown[];
    tools?: unknown[];
    model?: unknown;
    thinkingLevel?: string;
  };
  followUp?(message: unknown): void;
  signal?: AbortSignal;
}

interface InternalAgentSessionLike {
  agent?: InternalAgentLike;
  model?: unknown;
  thinkingLevel?: string;
  isCompacting?: boolean;
  _buildRuntime?(...args: unknown[]): unknown;
  _emit?(event: Record<string, unknown>): void;
  _runAutoCompaction?(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean> | boolean;
  abortCompaction?(): void;
}

interface InternalInteractiveModeLike {
  session?: { isStreaming?: boolean };
  settingsManager?: { getShowTerminalProgress?(): boolean };
  workingVisible?: boolean;
  setWorkingVisible?(visible: boolean): void;
  loadingAnimation?: { stop?(): void } | undefined;
  statusContainer?: { clear?(): void; addChild?(child: unknown): void };
  ui?: { terminal?: { setProgress?(active: boolean): void }; requestRender?(): void };
  createWorkingLoader?(): unknown;
  chatContainer?: { children?: unknown[] };
  handleEvent?: InteractiveHandleEventFn;
}

export interface TurnBoundaryCompactionUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type TurnBoundaryCompactionDecision =
  | { decision: "trigger"; usage: TurnBoundaryCompactionUsage; sessionId: string }
  | { decision: "skip"; reason: string; usage?: TurnBoundaryCompactionUsage; sessionId?: string };

export interface TurnBoundaryCompactionHooks {
  shouldCompact(session: unknown): TurnBoundaryCompactionDecision | Promise<TurnBoundaryCompactionDecision>;
  onComplete?(info: { session: unknown; usage: TurnBoundaryCompactionUsage; sessionId: string; elapsedMs: number; result: boolean }): void | Promise<void>;
  onError?(info: { session: unknown; usage?: TurnBoundaryCompactionUsage; sessionId?: string; elapsedMs: number; error: Error }): void | Promise<void>;
  onUnavailable?(api: string): void;
  warn?: (msg: string) => void;
}

// ── State ────────────────────────────────────────────────────────────────

/** Results of startup integrity checks. */
interface StartupCheckResult {
  api: string;
  available: boolean;
  error?: string;
}

const startupResults: StartupCheckResult[] = [];
const TURN_BOUNDARY_BUILD_RUNTIME_PATCHED = Symbol.for("pi-astack.turn-boundary-compaction.AgentSession._buildRuntime.patched");
const TURN_BOUNDARY_ORIGINAL_BUILD_RUNTIME = Symbol.for("pi-astack.turn-boundary-compaction.AgentSession._buildRuntime.original");
const TURN_BOUNDARY_EMIT_PATCHED = Symbol.for("pi-astack.turn-boundary-compaction.AgentSession._emit.patched");
const TURN_BOUNDARY_ORIGINAL_EMIT = Symbol.for("pi-astack.turn-boundary-compaction.AgentSession._emit.original");
const TURN_BOUNDARY_PATCH_VERSION = "2026-07-10.turn-boundary-compaction.v3";
const TURN_BOUNDARY_INSTALLED_AGENT = Symbol.for("pi-astack.turn-boundary-compaction.agent.installed");
const TURN_BOUNDARY_AGENT_PREPARE_NEXT_TURN_ORIGINAL = Symbol.for("pi-astack.turn-boundary-compaction.agent.prepareNextTurn.original");
const TURN_BOUNDARY_AGENT_CREATE_LOOP_CONFIG_ORIGINAL = Symbol.for("pi-astack.turn-boundary-compaction.agent.createLoopConfig.original");
const INTERACTIVE_HANDLE_EVENT_PATCHED = Symbol.for("pi-astack.turn-boundary-compaction.InteractiveMode.handleEvent.patched");
const INTERACTIVE_ORIGINAL_HANDLE_EVENT = Symbol.for("pi-astack.turn-boundary-compaction.InteractiveMode.handleEvent.original");
const TURN_BOUNDARY_GLOBAL_STATE = Symbol.for("pi-astack.turn-boundary-compaction.global-state");

interface TurnBoundaryGlobalState {
  hooksByKey: Map<string, TurnBoundaryCompactionHooks>;
  activeContinuationCompactions: WeakSet<object>;
  patchVersion?: string;
}

const globalForTurnBoundary = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
const turnBoundaryState = (globalForTurnBoundary[TURN_BOUNDARY_GLOBAL_STATE] ??= {
  hooksByKey: new Map<string, TurnBoundaryCompactionHooks>(),
  activeContinuationCompactions: new WeakSet<object>(),
}) as TurnBoundaryGlobalState;

// ── Getters ──────────────────────────────────────────────────────────────

/**
 * Get the assembled session messages (system prompt + AGENTS.md +
 * conversation + latest response) from a SessionManager instance.
 *
 * Used by the sediment extractor for continuation-call prompt caching.
 * Falls back to undefined if the API is not available (e.g., pi version
 * mismatch, restricted sandbox).
 */
export function tryGetSessionMessages(
  sessionManager: unknown,
): unknown[] | undefined {
  if (!sessionManager) return undefined;

  try {
    const sm = sessionManager as InternalSessionManager;
    if (typeof sm.buildSessionContext !== "function") return undefined;

    const ctx = sm.buildSessionContext();
    if (!ctx || !Array.isArray(ctx.messages) || ctx.messages.length === 0) {
      return undefined;
    }

    return ctx.messages.slice(); // shallow snapshot — prevents concurrent mutation by main session
  } catch {
    return undefined;
  }
}

function getTurnBoundaryHookEntries(): [string, TurnBoundaryCompactionHooks][] {
  return [...turnBoundaryState.hooksByKey.entries()].sort(([a], [b]) => a.localeCompare(b));
}

async function notifyTurnBoundaryError(
  hooks: TurnBoundaryCompactionHooks[],
  info: { session: unknown; usage?: TurnBoundaryCompactionUsage; sessionId?: string; elapsedMs: number; error: Error },
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook.onError?.(info);
    } catch {
      // Hook errors must never interrupt the agent loop.
    }
  }
}

async function runTurnBoundaryCompaction(session: InternalAgentSessionLike, signal?: AbortSignal): Promise<AgentLoopTurnUpdate | undefined> {
  const hookEntries = getTurnBoundaryHookEntries();
  if (hookEntries.length === 0) return undefined;

  const hooks = hookEntries.map(([, hook]) => hook);
  const notifyUnavailable = (api: string) => {
    warnOnceIfUnavailable(api, hooks[0]?.warn);
    for (const hook of hooks) {
      try {
        hook.onUnavailable?.(api);
      } catch {
        // Unavailability callbacks are diagnostics only.
      }
    }
  };

  if (!session || !session.agent) {
    notifyUnavailable("AgentSession.agent");
    return undefined;
  }
  if (signal?.aborted) return undefined;
  if (session.isCompacting) return undefined;
  if (typeof session._runAutoCompaction !== "function") {
    notifyUnavailable("AgentSession._runAutoCompaction");
    return undefined;
  }

  let selected: { usage: TurnBoundaryCompactionUsage; sessionId: string } | undefined;
  for (const [, hook] of hookEntries) {
    let decision: TurnBoundaryCompactionDecision;
    try {
      decision = await hook.shouldCompact(session);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await notifyTurnBoundaryError([hook], { session, elapsedMs: 0, error: err });
      continue;
    }
    if (decision.decision !== "trigger") continue;
    selected = { usage: decision.usage, sessionId: decision.sessionId };
    break;
  }
  if (!selected) return undefined;

  const started = Date.now();
  let abortHandler: (() => void) | undefined;
  try {
    // Internal auto-compaction path: unlike the public compact action, this
    // does not disconnect/abort the active agent run. `willRetry=true` keeps
    // current pi queue flushing semantics safe while the event also carries
    // `willContinue=true` for UI state restoration.
    const compactionSession = session as object;
    turnBoundaryState.activeContinuationCompactions.add(compactionSession);
    const abortCompaction = typeof session.abortCompaction === "function"
      ? session.abortCompaction.bind(session)
      : undefined;
    abortHandler = abortCompaction ? () => abortCompaction() : undefined;
    if (abortHandler) signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) {
      abortHandler?.();
      return undefined;
    }
    const result = await session._runAutoCompaction("threshold", true);
    const elapsedMs = Date.now() - started;
    if (!result) {
      await notifyTurnBoundaryError(hooks, {
        session,
        usage: selected.usage,
        sessionId: selected.sessionId,
        elapsedMs,
        error: new Error("turn-boundary auto-compaction returned false"),
      });
      return undefined;
    }
    for (const hook of hooks) {
      try {
        await hook.onComplete?.({ session, usage: selected.usage, sessionId: selected.sessionId, elapsedMs, result: true });
      } catch {
        // Hook errors must never interrupt the agent loop.
      }
    }
    if (signal?.aborted) return undefined;

    const agentState = session.agent.state;
    if (!agentState || !Array.isArray(agentState.messages)) return undefined;
    return {
      context: {
        systemPrompt: typeof agentState.systemPrompt === "string" ? agentState.systemPrompt : "",
        messages: agentState.messages.slice(),
        tools: Array.isArray(agentState.tools) ? agentState.tools.slice() : [],
      },
      model: session.model ?? agentState.model,
      thinkingLevel: session.thinkingLevel ?? agentState.thinkingLevel,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await notifyTurnBoundaryError(hooks, {
      session,
      usage: selected.usage,
      sessionId: selected.sessionId,
      elapsedMs: Date.now() - started,
      error: err,
    });
    return undefined;
  } finally {
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
    }
    const compactionSession = session as object;
    setTimeout(() => {
      turnBoundaryState.activeContinuationCompactions.delete(compactionSession);
    }, 0);
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && "aborted" in value;
}

function isPrepareNextTurnContext(value: unknown): value is PrepareNextTurnContext {
  return !!value && typeof value === "object" && ("context" in value || "newMessages" in value || "toolResults" in value);
}

function isLoopConfig(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function installPrepareNextTurnOnSession(session: InternalAgentSessionLike): void {
  const agent = session?.agent;
  if (!agent) return;
  const agentRecord = agent as InternalAgentLike & Record<PropertyKey, unknown>;
  if (agentRecord[TURN_BOUNDARY_INSTALLED_AGENT] === TURN_BOUNDARY_PATCH_VERSION) return;

  const hasOriginalPrepareNextTurn = Object.prototype.hasOwnProperty.call(agentRecord, TURN_BOUNDARY_AGENT_PREPARE_NEXT_TURN_ORIGINAL);
  const originalPrepareNextTurn = hasOriginalPrepareNextTurn
    ? agentRecord[TURN_BOUNDARY_AGENT_PREPARE_NEXT_TURN_ORIGINAL] as PrepareNextTurnFn | undefined
    : typeof agent.prepareNextTurn === "function" ? agent.prepareNextTurn.bind(agent) : undefined;
  if (!hasOriginalPrepareNextTurn) {
    agentRecord[TURN_BOUNDARY_AGENT_PREPARE_NEXT_TURN_ORIGINAL] = originalPrepareNextTurn;
  }
  if (typeof agent.createLoopConfig === "function") {
    const originalCreateLoopConfig = agentRecord[TURN_BOUNDARY_AGENT_CREATE_LOOP_CONFIG_ORIGINAL] as ((...args: unknown[]) => unknown) | undefined
      ?? agent.createLoopConfig.bind(agent);
    agentRecord[TURN_BOUNDARY_AGENT_CREATE_LOOP_CONFIG_ORIGINAL] = originalCreateLoopConfig;
    agent.createLoopConfig = (...args: unknown[]) => {
      const config = originalCreateLoopConfig(...args);
      if (!isLoopConfig(config) || typeof agent.prepareNextTurn !== "function") return config;
      config.prepareNextTurn = async (turnContext?: PrepareNextTurnContext) => await agent.prepareNextTurn?.(turnContext, agent as AbortSignalSource);
      return config;
    };
  }

  agentRecord[TURN_BOUNDARY_INSTALLED_AGENT] = TURN_BOUNDARY_PATCH_VERSION;
  agent.prepareNextTurn = async (signalOrContext?: AbortSignal | PrepareNextTurnContext, signalSource?: AbortSignalSource) => {
    const signal = isAbortSignal(signalOrContext) ? signalOrContext : signalSource?.signal ?? agent.signal;
    let previousUpdate: AgentLoopTurnUpdate | undefined;
    if (originalPrepareNextTurn) {
      previousUpdate = await originalPrepareNextTurn(isPrepareNextTurnContext(signalOrContext) && signal ? signal : signalOrContext, signalSource);
    }
    if (signal?.aborted) return previousUpdate;

    const ourUpdate = await runTurnBoundaryCompaction(session, signal);
    if (!ourUpdate) return previousUpdate;
    return {
      ...previousUpdate,
      ...ourUpdate,
      context: ourUpdate.context ?? previousUpdate?.context,
      model: ourUpdate.model ?? previousUpdate?.model,
      thinkingLevel: ourUpdate.thinkingLevel ?? previousUpdate?.thinkingLevel,
    };
  };
}

function isContinuationCompactionEndEvent(event: Record<string, unknown>): boolean {
  if (event.type !== "compaction_end") return false;
  return event.reason === "threshold" && event.willRetry === true && event.willContinue !== true;
}

function restoreWorkingLoaderIfContinuing(mode: InternalInteractiveModeLike): void {
  try {
    if (!mode.session?.isStreaming || !mode.workingVisible) return;
    if (mode.settingsManager?.getShowTerminalProgress?.()) {
      mode.ui?.terminal?.setProgress?.(true);
    }

    // Current pi creates WorkingStatusIndicator through setWorkingVisible().
    // Prefer that path so this patch follows upstream behavior even when
    // the old createWorkingLoader helper is absent.
    if (typeof mode.setWorkingVisible === "function") {
      mode.setWorkingVisible(true);
      mode.ui?.requestRender?.();
      return;
    }

    mode.loadingAnimation?.stop?.();
    mode.loadingAnimation = undefined;
    mode.statusContainer?.clear?.();
    const loader = mode.createWorkingLoader?.();
    if (!loader) return;
    mode.loadingAnimation = loader as { stop?(): void };
    mode.statusContainer?.addChild?.(loader);
    mode.ui?.requestRender?.();
  } catch {
    // UI restoration is best-effort; never break event handling.
  }
}

function isSuccessfulCompactionEndEvent(event: Record<string, unknown>): boolean {
  return event.type === "compaction_end" && event.aborted !== true && !!event.result;
}

function isSpacerComponent(component: unknown): boolean {
  // Spacer can come from a different pi-tui module instance under jiti.
  if (!component || typeof component !== "object") return false;
  const candidate = component as {
    constructor?: { name?: string };
    lines?: unknown;
    setLines?: unknown;
    render?: unknown;
  };
  return candidate.constructor?.name === "Spacer"
    && typeof candidate.lines === "number"
    && typeof candidate.setLines === "function"
    && typeof candidate.render === "function";
}

function removeEarlierCompactionSummaries(mode: InternalInteractiveModeLike): boolean {
  const children = mode.chatContainer?.children;
  if (!Array.isArray(children)) return false;

  const summaryIndexes = children
    .map((child, index) => child instanceof CompactionSummaryMessageComponent ? index : -1)
    .filter((index) => index >= 0);
  if (summaryIndexes.length <= 1) return false;

  for (let i = summaryIndexes.length - 2; i >= 0; i--) {
    const summaryIndex = summaryIndexes[i];
    const removeSpacer = summaryIndex > 0 && isSpacerComponent(children[summaryIndex - 1]);
    children.splice(removeSpacer ? summaryIndex - 1 : summaryIndex, removeSpacer ? 2 : 1);
  }
  return true;
}

function installAgentSessionEmitWillContinuePatch(
  proto: InternalAgentSessionLike & Record<PropertyKey, unknown>,
  hooks: TurnBoundaryCompactionHooks,
): boolean {
  if (proto[TURN_BOUNDARY_EMIT_PATCHED] === TURN_BOUNDARY_PATCH_VERSION) return true;
  if (typeof proto._emit !== "function") {
    warnOnceIfUnavailable("AgentSession._emit", hooks.warn);
    hooks.onUnavailable?.("AgentSession._emit");
    return false;
  }

  const original = proto[TURN_BOUNDARY_ORIGINAL_EMIT] as InternalAgentSessionLike["_emit"] | undefined ?? proto._emit;
  proto[TURN_BOUNDARY_ORIGINAL_EMIT] = original;
  proto._emit = function patchedEmit(this: InternalAgentSessionLike, event: Record<string, unknown>): void {
    const patchedEvent = isContinuationCompactionEndEvent(event) && turnBoundaryState.activeContinuationCompactions.has(this as object)
      ? { ...event, willContinue: true }
      : event;
    return original.call(this, patchedEvent);
  };
  proto[TURN_BOUNDARY_EMIT_PATCHED] = TURN_BOUNDARY_PATCH_VERSION;
  return true;
}

function installInteractiveModeWillContinuePatch(hooks: TurnBoundaryCompactionHooks): boolean {
  const proto = (InteractiveMode as unknown as { prototype?: InternalInteractiveModeLike & Record<PropertyKey, unknown> }).prototype;
  if (!proto) {
    warnOnceIfUnavailable("InteractiveMode.prototype", hooks.warn);
    return false;
  }
  if (proto[INTERACTIVE_HANDLE_EVENT_PATCHED] === TURN_BOUNDARY_PATCH_VERSION) return true;
  if (typeof proto.handleEvent !== "function") {
    warnOnceIfUnavailable("InteractiveMode.handleEvent", hooks.warn);
    hooks.onUnavailable?.("InteractiveMode.handleEvent");
    return false;
  }

  const original = proto[INTERACTIVE_ORIGINAL_HANDLE_EVENT] as InteractiveHandleEventFn | undefined ?? proto.handleEvent;
  proto[INTERACTIVE_ORIGINAL_HANDLE_EVENT] = original;
  proto.handleEvent = async function patchedHandleEvent(this: InternalInteractiveModeLike, event: Record<string, unknown>): Promise<void> {
    await original.call(this, event);
    if (isSuccessfulCompactionEndEvent(event) && removeEarlierCompactionSummaries(this)) {
      this.ui?.requestRender?.();
    }
    if (event.type === "compaction_end" && event.willContinue === true) {
      restoreWorkingLoaderIfContinuing(this);
    }
  };
  proto[INTERACTIVE_HANDLE_EVENT_PATCHED] = TURN_BOUNDARY_PATCH_VERSION;
  return true;
}

/**
 * Install a process-wide AgentSession patch that runs registered hooks at
 * agent-core's turn boundary (`prepareNextTurn`), after tool results are
 * persisted and before the next provider request. The patch is idempotent
 * and degrades gracefully if pi internals change.
 */
export function installTurnBoundaryCompactionPatch(
  key: string,
  hooks: TurnBoundaryCompactionHooks,
): boolean {
  turnBoundaryState.hooksByKey.set(key, hooks);
  turnBoundaryState.patchVersion = TURN_BOUNDARY_PATCH_VERSION;

  const proto = (AgentSession as unknown as { prototype?: InternalAgentSessionLike & Record<PropertyKey, unknown> }).prototype;
  if (!proto) {
    warnOnceIfUnavailable("AgentSession.prototype", hooks.warn);
    return false;
  }

  installAgentSessionEmitWillContinuePatch(proto, hooks);
  installInteractiveModeWillContinuePatch(hooks);

  if (proto[TURN_BOUNDARY_BUILD_RUNTIME_PATCHED] === TURN_BOUNDARY_PATCH_VERSION) return true;
  if (typeof proto._buildRuntime !== "function") {
    warnOnceIfUnavailable("AgentSession._buildRuntime", hooks.warn);
    hooks.onUnavailable?.("AgentSession._buildRuntime");
    return false;
  }

  const original = proto[TURN_BOUNDARY_ORIGINAL_BUILD_RUNTIME] as InternalAgentSessionLike["_buildRuntime"] | undefined ?? proto._buildRuntime;
  proto[TURN_BOUNDARY_ORIGINAL_BUILD_RUNTIME] = original;
  proto._buildRuntime = function patchedBuildRuntime(this: InternalAgentSessionLike, ...args: unknown[]): unknown {
    const result = original.apply(this, args);
    try {
      installPrepareNextTurnOnSession(this);
    } catch {
      // Patch diagnostics are best-effort; never break pi startup/reload.
    }
    return result;
  };
  proto[TURN_BOUNDARY_BUILD_RUNTIME_PATCHED] = TURN_BOUNDARY_PATCH_VERSION;
  turnBoundaryState.patchVersion = TURN_BOUNDARY_PATCH_VERSION;
  return true;
}

/** Test-only reset for smoke tests. Does not unpatch AgentSession. */
export function _resetTurnBoundaryCompactionHooksForTests(): void {
  turnBoundaryState.hooksByKey.clear();
}

// ── Startup integrity checks ─────────────────────────────────────────────

interface PiInternalsOptions {
  /** Called to log a non-fatal warning (uses console.warn by default). */
  warn?: (msg: string) => void;
  /** ExtensionAPI instance for accessing ctx during startup. */
  pi?: ExtensionAPI;
}

/**
 * Verify that all internal APIs we depend on are accessible.
 *
 * Call once during extension activate().  Logs warnings for any missing
 * APIs but never throws — missing internal APIs degrade gracefully,
 * they don't crash pi.
 *
 * If pi is upgraded and an internal API changes, this gives the operator
 * a clear warning rather than a cryptic runtime error deep in the pipeline.
 */
export function verifyPiInternals(opts: PiInternalsOptions = {}): {
  allOk: boolean;
  results: StartupCheckResult[];
} {
  const warn = opts.warn ?? ((msg: string) => console.warn(`pi-astack: ${msg}`));
  const results: StartupCheckResult[] = [];

  // Check 1: buildSessionContext on SessionManager
  // We can't get a SessionManager instance at startup (it's per-session),
  // so we check by probing a known pattern: does getBranch exist AND can
  // we detect the SessionManager shape on a mock object?
  // More pragmatic: check when pi.on("session_start") fires, or check
  // when first agent_end has a real SessionManager.
  //
  // For now, we defer the actual check to first use and log then.
  // The startup check here is a placeholder for future checks.
  results.push({
    api: "SessionManager.buildSessionContext",
    available: true, // deferred check — see tryGetSessionMessages
  });

  // Check 2: AgentSession internals used by compaction-tuner's turn-boundary patch.
  const agentSessionProto = (AgentSession as unknown as { prototype?: InternalAgentSessionLike }).prototype;
  results.push({
    api: "AgentSession._buildRuntime",
    available: typeof agentSessionProto?._buildRuntime === "function",
  });
  results.push({
    api: "AgentSession._runAutoCompaction",
    available: typeof agentSessionProto?._runAutoCompaction === "function",
  });
  results.push({
    api: "AgentSession._emit",
    available: typeof agentSessionProto?._emit === "function",
  });
  const interactiveModeProto = (InteractiveMode as unknown as { prototype?: InternalInteractiveModeLike }).prototype;
  results.push({
    api: "InteractiveMode.handleEvent",
    available: typeof interactiveModeProto?.handleEvent === "function",
  });

  // Check 3: future internal APIs go here
  // results.push({ api: "SomeFutureAPI", available: ... });

  startupResults.length = 0;
  startupResults.push(...results);

  const allOk = results.every((r) => r.available);

  if (!allOk) {
    const missing = results.filter((r) => !r.available).map((r) => r.api);
    warn(
      `Some internal pi APIs are unavailable: ${missing.join(", ")}. ` +
      `This may happen after a pi upgrade. Related features will degrade gracefully.`,
    );
  }

  return { allOk, results };
}

/**
 * Log a one-time warning when an internal API is first found unavailable.
 * Uses a module-level Set to avoid spamming.
 */
const _warnedApis = new Set<string>();
/** Reset warned-API set (test-only). */
export function _resetWarnedApisForTests(): void {
  _warnedApis.clear();
}

export function warnOnceIfUnavailable(
  api: string,
  warn?: (msg: string) => void,
): void {
  if (_warnedApis.has(api)) return;
  _warnedApis.add(api);
  const w = warn ?? ((msg: string) => console.warn(`pi-astack: ${msg}`));
  w(
    `Internal pi API "${api}" is unavailable. ` +
    `This may happen after a pi upgrade. Related features will fall back to degraded mode.`,
  );
}

// ── Sub-agent session marker ─────────────────────────────────────────────
//
// ADR 0027 PR-B (Coupled Stigmergic Dual-Loop Agent System):
//
// dispatch_agent / dispatch_parallel spawn L2 worker AgentSessions in-process
// (v3 model, ADR 0009). Per ADR 0027 C1' L1↔L2 symbiosis, sub-agents should
// load the full extension stack so they can read brain (memory_*), use web
// tools (web_search/web_fetch), etc. — they are workers grown on the L1 hub,
// not isolated black boxes.
//
// BUT per ADR 0014 §6 + ADR 0025 INV-IMPLICIT-GROUND-TRUTH, several
// main-session-only lifecycle handlers must NOT fire in sub-agent context:
//
//   - sediment.agent_end: sub-agent output is a tool product, not user
//     conversation. Letting sediment extract from it pollutes the brain with
//     LLM-reasoning artifacts instead of user implicit signal.
//   - compaction-tuner.agent_end: tunes main-session compaction state from
//     sub-agent token usage — scope error.
//   - model-fallback.agent_end / .session_start: state-machine designed for
//     main session, fires once per sub-agent and corrupts fallback chain.
//   - persistent-input-history.session_start: loads user's input history
//     into the sub-agent editor — not meaningful, ResourceLoader-heavy.
//   - model-curator.session_start: applies provider whitelist; safe but
//     redundant per sub-agent spawn.
//   - abrain/rule-injector.session_start / .before_agent_start: injects
//     project rules into system prompt; sub-agent has a dispatch-provided
//     prompt, injection conflicts.
//
// In the v2 subprocess model these handlers gated on `PI_ABRAIN_DISABLED=1`,
// which dispatch passed via env to the child process. v3 in-process can't
// use env (shared with parent) so we need an explicit marker.
//
// Mechanism: dispatch calls `markSessionAsSubAgent(sm)` on the
// SessionManager instance it passes to createAgentSession. That call writes
// TWO process-global channels before any sub-agent lifecycle handler can run:
//
//   1. stable session id registry: `sm.getSessionId()` -> random nonce
//   2. WeakSet identity marker: `sm` object identity
//
// `isSubAgentSession(ctx)` checks the id registry first, then WeakSet. The id
// channel is robust if a future pi version wraps `ctx.sessionManager` in a
// Proxy/facade but still passes through method/property reads. The WeakSet
// channel remains the pre-existing fallback and covers the narrow future case
// where a stable id is not readable until inside createAgentSession: the SM is
// still marked before creation, and the first WeakSet hit backfills the id if
// it has become readable. Do NOT use ADR 0027 C6 causal session_id here: that
// id belongs to the parent/user session and would mark the main session as a
// sub-agent.
//
// Handlers do `if (isSubAgentSession(ctx)) return;` to opt out.
//
// Why WeakSet: ties marker lifetime to SessionManager instance — when the
// sub-agent disposes (dispose() drops its ref), the SessionManager becomes
// GC-eligible and falls out of the marker set automatically. No leak. The id
// registry is process-lifetime state keyed by pi's random session id; dispatch
// creates a bounded number of sub-agent sessions per process, so this is an
// acceptable diagnostic/safety registry.
//
// Why not monkey-patch: pi-internals already monkey-patches
// AgentSession.prototype._buildRuntime (turn-boundary compaction), and
// patches add upgrade-fragility surface. The explicit id channel plus WeakSet
// identity marker has no pi-internals coupling and stays correct across pi
// versions as long as ExtensionContext.sessionManager exposes the same stable
// session id.

// State below is stored on `globalThis[Symbol.for(...)]` so all extension
// instances of this module — each loaded by a separate jiti instance with
// moduleCache:false — share the SAME state.
//
// ## Why globalThis singleton (R4 NEW-P0 critical, same root cause as causal-anchor.ts)
//
// pi's extension loader creates a fresh `jiti` instance per extension and
// `moduleCache: false` disables nested-import cache. Empirically (R4 jiti
// probe), dispatch's pi-internals.ts is a DIFFERENT module instance from
// sediment's pi-internals.ts. Without globalThis sharing:
//   - dispatch.markSessionAsSubAgent(sm) writes to dispatch's WeakSet
//   - sediment.isSubAgentSession(ctx) reads sediment's DIFFERENT WeakSet → empty
//   - returns false → sediment.agent_end runs on sub-agent sessions →
//     INV-IMPLICIT-GROUND-TRUTH violation (sub-agent output learned as user signal)
//
// In production the sediment violation was masked by the orthogonal
// `if (!sessionId) return` ephemeral-session early-return (sub-agent uses
// SessionManager.inMemory() which has no session id). But all OTHER
// handlers (compaction-tuner, model-fallback, model-curator, persistent-
// input-history, abrain rule-injector) rely on isSubAgentSession() ALONE
// and have been silently firing in sub-agent contexts.
//
// Fix: state on globalThis so every module instance reads/writes the same
// WeakSet + boundary probe state.

const _SUB_AGENT_STATE_KEY = Symbol.for("pi-astack/pi-internals/sub-agent/v1");

type BoundaryUntrustedDiagnostic = {
  reason: string;
  timestamp: string;
  details?: Record<string, unknown>;
};

type SubAgentIdRegistration = {
  nonce: string;
  registeredAt: string;
};

type SubAgentState = {
  weakSet: WeakSet<object>;
  weakNonce: WeakMap<object, string>;
  idRegistry: Map<string, SubAgentIdRegistration>;
  boundaryProbeStatus: BoundaryProbeStatus;
  boundaryProbeDiagnostic: {
    observedSmType: string;
    observedSmKeys: string[];
    observedSessionId: string | null;
    idRegistered: boolean;
    weakMarked: boolean;
    weakSetSize: "weak-set-opaque";
    timestamp: string;
  } | null;
  boundaryUntrusted: boolean;
  boundaryUntrustedDiagnostic: BoundaryUntrustedDiagnostic | null;
};

function _getSubAgentState(): SubAgentState {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[_SUB_AGENT_STATE_KEY] as Partial<SubAgentState> | undefined;
  if (!state) {
    state = {};
    g[_SUB_AGENT_STATE_KEY] = state;
  }
  if (!(state.weakSet instanceof WeakSet)) state.weakSet = new WeakSet<object>();
  if (!(state.weakNonce instanceof WeakMap)) state.weakNonce = new WeakMap<object, string>();
  if (!(state.idRegistry instanceof Map)) state.idRegistry = new Map<string, SubAgentIdRegistration>();
  if (state.boundaryProbeStatus !== "ok" && state.boundaryProbeStatus !== "broken") {
    state.boundaryProbeStatus = "untested";
  }
  if (state.boundaryProbeDiagnostic === undefined) state.boundaryProbeDiagnostic = null;
  if (state.boundaryUntrusted !== true) state.boundaryUntrusted = false;
  if (state.boundaryUntrustedDiagnostic === undefined) state.boundaryUntrustedDiagnostic = null;
  return state as SubAgentState;
}

function readStableSessionIdFromSessionManager(sessionManager: unknown): string | null {
  if (sessionManager == null || typeof sessionManager !== "object") return null;
  const sm = sessionManager as { getSessionId?: unknown; sessionId?: unknown };
  try {
    if (typeof sm.getSessionId === "function") {
      const id = sm.getSessionId.call(sessionManager);
      if (typeof id === "string" && id.trim()) return id;
    }
  } catch {
    return null;
  }
  try {
    if (typeof sm.sessionId === "string" && sm.sessionId.trim()) return sm.sessionId;
  } catch {
    return null;
  }
  return null;
}

function registerSubAgentSessionId(state: SubAgentState, sessionId: string, nonce: string): void {
  state.idRegistry.set(sessionId, { nonce, registeredAt: new Date().toISOString() });
}

/** Mark a SessionManager instance as belonging to a dispatch-spawned sub-agent.
 *  Must be called BEFORE passing the SessionManager to createAgentSession,
 *  so that any session_start handler triggered during session creation
 *  already sees the mark.
 *
 *  Idempotent: re-marking the same instance is a no-op. */
export function markSessionAsSubAgent(sessionManager: object): void {
  if (sessionManager == null || typeof sessionManager !== "object") return;
  const state = _getSubAgentState();
  state.weakSet.add(sessionManager);
  const nonce = state.weakNonce.get(sessionManager) ?? randomUUID();
  state.weakNonce.set(sessionManager, nonce);
  const sessionId = readStableSessionIdFromSessionManager(sessionManager);
  if (sessionId) registerSubAgentSessionId(state, sessionId, nonce);
}

/** Whether a lifecycle handler is currently running inside a dispatch-spawned
 *  sub-agent session. Returns false in main session and in any session
 *  pi-astack did not explicitly mark (the safe default — extensions only
 *  opt out, never opt in).
 *
 *  Accepts any object with a `sessionManager` field (the ExtensionContext
 *  shape). Returns false on missing/null sessionManager rather than throwing,
 *  so handlers wrapping their entire body in this check stay robust against
 *  pi calling them with unexpected ctx shapes. */
export function isSubAgentSession(ctx: { sessionManager?: unknown } | undefined | null): boolean {
  if (!ctx) return false;
  const sm = ctx.sessionManager;
  if (sm == null || typeof sm !== "object") return false;
  const state = _getSubAgentState();
  const sessionId = readStableSessionIdFromSessionManager(sm);
  if (sessionId && state.idRegistry.has(sessionId)) return true;
  if (!state.weakSet.has(sm)) return false;
  if (sessionId) {
    const nonce = state.weakNonce.get(sm) ?? randomUUID();
    state.weakNonce.set(sm, nonce);
    registerSubAgentSessionId(state, sessionId, nonce);
  }
  return true;
}

export type SubAgentBoundarySignals = {
  sessionId: string | null;
  idRegistered: boolean;
  weakMarked: boolean;
};

export function inspectSubAgentBoundarySignals(
  ctx: { sessionManager?: unknown } | undefined | null,
): SubAgentBoundarySignals {
  const sm = ctx?.sessionManager;
  if (sm == null || typeof sm !== "object") {
    return { sessionId: null, idRegistered: false, weakMarked: false };
  }
  const state = _getSubAgentState();
  const sessionId = readStableSessionIdFromSessionManager(sm);
  return {
    sessionId,
    idRegistered: sessionId ? state.idRegistry.has(sessionId) : false,
    weakMarked: state.weakSet.has(sm),
  };
}

export function markSubAgentBoundaryUntrusted(
  reason: string,
  details?: Record<string, unknown>,
): void {
  const state = _getSubAgentState();
  state.boundaryUntrusted = true;
  state.boundaryUntrustedDiagnostic = {
    reason,
    timestamp: new Date().toISOString(),
    ...(details ? { details } : {}),
  };
}

export function isSubAgentBoundaryUntrusted(): boolean {
  return _getSubAgentState().boundaryUntrusted === true;
}

export function getSubAgentBoundaryUntrustedDiagnostic(): BoundaryUntrustedDiagnostic | null {
  const d = _getSubAgentState().boundaryUntrustedDiagnostic;
  return d ? { ...d, details: d.details ? { ...d.details } : undefined } : null;
}

/** Test-only: clear the marker set. Production code should never need this
 *  because the WeakSet self-clears on GC. */
export function _resetSubAgentMarkersForTests(): void {
  const state = _getSubAgentState();
  state.weakSet = new WeakSet<object>();
  state.weakNonce = new WeakMap<object, string>();
  state.idRegistry.clear();
}

// ── Sub-agent passthrough boundary sentinel (ADR 0027 PR-B+ R1 P1-1) ──
//
// The dual-channel `isSubAgentSession(ctx)` defense (above) is grounded in
// ONE critical invariant from pi's SDK:
//
//   ExtensionContext.sessionManager exposes a stable sub-agent session id
//   that matches the SessionManager dispatch registered before spawn.
//
// The WeakSet identity channel remains as a fallback for current passthrough
// behavior and for a possible id-generation window. If a future pi version
// wraps SessionManager in a Proxy / facade / Pick<> adapter, the id channel
// should still pass as long as `getSessionId()` / `sessionId` reads are
// forwarded. If both channels miss in the shared sub-agent loader, then:
//   1. dispatch called markSessionAsSubAgent(sm) before createAgentSession
//   2. session_start fired in a runtime that only hosts sub-agent sessions
//   3. neither registered id nor WeakSet identity matched ctx.sessionManager
//   4. sediment / model-fallback / etc. would run as if main session
//   5. sub-agent reasoning could be learned as user implicit truth signal
//      (violates ADR 0024 INV-IMPLICIT-GROUND-TRUTH and ADR 0027 PR-B)
//
// The failure mode is SILENT — nothing throws, audit rows look normal,
// just the brain slowly absorbs sub-agent reasoning as user signal. R1
// review (Opus, Step 5-3) called this "the most hidden time bomb".
//
// This sentinel detects the violation by registering a one-time probe on
// the SHARED SUB-AGENT LOADER's pi.on("session_start"). In the shared
// loader's runtime, EVERY session_start fires for a sub-agent (the loader
// only spawns sub-agent AgentSessions). So:
//
//   - if the id channel matches at session_start, the boundary is VERIFIED,
//     including Proxy/facade wrapping where WeakSet identity no longer matches
//   - if only WeakSet matches, the boundary is still safe for this event and
//     the id channel is backfilled when a stable id is readable
//   - if both channels miss, the boundary is UNTRUSTED → fail closed + loud alarm
//
// No race conditions: the shared loader is ONLY accessed via dispatch's
// runInProcess, which marks the SM before calling createAgentSession.
// Sub-agents do not spawn their own sub-agents (nested dispatch is
// forbidden per ADR 0027), so session_start in shared loader is always
// (markSessionAsSubAgent → createAgentSession → session_start) in that
// order with no interleaving from other code paths.
//
// Sentinel fires ONCE per process — the first sub-agent spawn is enough
// to prove the invariant. Subsequent spawns are no-op fast path.

type BoundaryProbeStatus = "untested" | "ok" | "broken";

/** Current sentinel status. "untested" until first sub-agent session_start;
 *  "ok" once verified; "broken" if invariant violation detected. */
export function getSubAgentBoundaryStatus(): BoundaryProbeStatus {
  return _getSubAgentState().boundaryProbeStatus;
}

/** Diagnostic snapshot of a detected mismatch. null when sentinel is OK
 *  or hasn't yet observed any session_start in shared loader. */
export function getSubAgentBoundaryDiagnostic(): SubAgentState["boundaryProbeDiagnostic"] {
  const d = _getSubAgentState().boundaryProbeDiagnostic;
  return d ? { ...d } : null;
}

/** Test-only: reset sentinel state. Production must not call. */
export function _resetSubAgentBoundaryProbeForTests(): void {
  const state = _getSubAgentState();
  state.boundaryProbeStatus = "untested";
  state.boundaryProbeDiagnostic = null;
  state.boundaryUntrusted = false;
  state.boundaryUntrustedDiagnostic = null;
}

/**
 * Bind the sub-agent boundary sentinel to a pi ExtensionAPI.
 *
 * MUST be called ONLY from inside the shared sub-agent loader's runtime
 * (where dispatch sets `_activatingInSharedLoader=true` before reload).
 * Calling from the main-pi runtime would falsely flag legitimate main
 * session_start events as boundary violations.
 *
 * Idempotent: safe to call multiple times; the sentinel listener is
 * one-shot and self-deregisters after the first verification.
 */
export function bindSubAgentBoundarySentinel(
  pi: ExtensionAPI,
  opts: { warn?: (msg: string) => void } = {},
): void {
  const warn = opts.warn ?? ((msg: string) => console.error(`pi-astack: ${msg}`));
  if (process.env.PI_ASTACK_SUPPRESS_BOUNDARY_SENTINEL === "1") return;

  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    // Idempotency: once we've verified OR detected breakage, stop probing.
    if (_getSubAgentState().boundaryProbeStatus !== "untested") return;

    const c = ctx as { sessionManager?: unknown } | undefined | null;
    const sm = c?.sessionManager;
    if (sm == null || typeof sm !== "object") {
      // No SM at all — odd, but not a boundary failure per se. Wait for
      // a more meaningful session_start.
      return;
    }

    const subAgentState = _getSubAgentState();
    const matched = isSubAgentSession(c);
    const signals = inspectSubAgentBoundarySignals(c);
    if (matched) {
      // The id channel may be the only hit when pi wraps the SessionManager
      // in a Proxy. The WeakSet channel may be the only hit during a future
      // id-generation window; isSubAgentSession backfills the id once readable.
      subAgentState.boundaryProbeStatus = "ok";
      return;
    }

    // In the shared sub-agent loader, session_start is supposed to be a
    // sub-agent session. If both channels miss, the boundary is untrusted.
    subAgentState.boundaryProbeStatus = "broken";
    subAgentState.boundaryProbeDiagnostic = {
      observedSmType: Object.prototype.toString.call(sm),
      observedSmKeys: (() => {
        try {
          return Object.keys(sm as object).slice(0, 10);
        } catch {
          return ["<unintrospectable>"];
        }
      })(),
      observedSessionId: signals.sessionId,
      idRegistered: signals.idRegistered,
      weakMarked: signals.weakMarked,
      weakSetSize: "weak-set-opaque",
      timestamp: new Date().toISOString(),
    };
    markSubAgentBoundaryUntrusted("subagent_boundary_probe_missed_both_channels", {
      observedSessionId: signals.sessionId,
      idRegistered: signals.idRegistered,
      weakMarked: signals.weakMarked,
    });

    warn(
      "\n\u2554" + "\u2550".repeat(78) + "\u2557\n" +
      "\u2551 \ud83d\udea8 PI-ASTACK CRITICAL: sub-agent boundary invariant VIOLATED                  \u2551\n" +
      "\u255a" + "\u2550".repeat(78) + "\u255d\n" +
      "\n" +
      "  markSessionAsSubAgent(sm) registered the sub-agent SessionManager\n" +
      "  before createAgentSession(), but the corresponding session_start\n" +
      "  event in the sub-agent runtime matched neither the stable session-id\n" +
      "  registry nor the WeakSet identity fallback.\n" +
      "\n" +
      "  Consequence: isSubAgentSession(ctx) cannot prove this is a\n" +
      "  sub-agent lifecycle handler, so without fail-closed guards:\n" +
      "    - sediment.agent_end will EXTRACT sub-agent reasoning as user implicit\n" +
      "      truth (violates ADR 0024 / ADR 0025 INV-IMPLICIT-GROUND-TRUTH)\n" +
      "    - compaction-tuner.agent_end will MIX sub-agent token usage into\n" +
      "      main-session compaction state\n" +
      "    - model-fallback / persistent-input-history / model-curator /\n" +
      "      abrain rule-injector will execute their main-only side effects\n" +
      "      INSIDE the sub-agent\n" +
      "\n" +
      "  Refs: ADR 0027 PR-B (sub-agent extension visibility), ADR 0014 §6\n" +
      "        (extension boundary), pi-internals.ts WeakSet section.\n" +
      "\n" +
      "  Likely cause: pi was upgraded and changed ExtensionContext\n" +
      "  sessionManager shape so neither getSessionId()/sessionId nor object\n" +
      "  identity reaches extensions. See pi-internals.ts sub-agent boundary\n" +
      "  section for the invariant documentation.\n" +
      "\n" +
      `  Observed SM diagnostic:\n` +
      `    type:  ${_getSubAgentState().boundaryProbeDiagnostic?.observedSmType}\n` +
      `    keys:  ${JSON.stringify(_getSubAgentState().boundaryProbeDiagnostic?.observedSmKeys)}\n` +
      `    id:    ${JSON.stringify(_getSubAgentState().boundaryProbeDiagnostic?.observedSessionId)}\n` +
      `    idReg: ${JSON.stringify(_getSubAgentState().boundaryProbeDiagnostic?.idRegistered)}\n` +
      `    weak:  ${JSON.stringify(_getSubAgentState().boundaryProbeDiagnostic?.weakMarked)}\n` +
      `    when:  ${_getSubAgentState().boundaryProbeDiagnostic?.timestamp}\n` +
      "\n" +
      "  Action: investigate pi SDK's ExtensionContext shape and adjust\n" +
      "  pi-internals.ts id/WeakSet marker mechanism. Mutating consumers\n" +
      "  will stop writing until the process restarts with a trusted boundary.\n" +
      "\n" +
      "  This warning fires ONCE per process. To suppress (NOT recommended)\n" +
      "  set PI_ASTACK_SUPPRESS_BOUNDARY_SENTINEL=1.\n"
    );
  });
}
