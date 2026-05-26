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

import { AgentSession, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  loadingAnimation?: { stop?(): void } | undefined;
  statusContainer?: { clear?(): void; addChild?(child: unknown): void };
  ui?: { terminal?: { setProgress?(active: boolean): void }; requestRender?(): void };
  createWorkingLoader?(): unknown;
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
const TURN_BOUNDARY_PATCH_VERSION = "2026-05-26.turn-boundary-compaction.v2";
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

async function runTurnBoundaryCompaction(session: InternalAgentSessionLike, turnContext?: PrepareNextTurnContext, signal?: AbortSignal): Promise<AgentLoopTurnUpdate | undefined> {
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
    for (const hook of hooks) {
      try {
        await hook.onComplete?.({ session, usage: selected.usage, sessionId: selected.sessionId, elapsedMs, result: !!result });
      } catch {
        // Hook errors must never interrupt the agent loop.
      }
    }
    if (!result || signal?.aborted) return undefined;

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
    const turnContext = isPrepareNextTurnContext(signalOrContext) ? signalOrContext : undefined;
    const signal = isAbortSignal(signalOrContext) ? signalOrContext : signalSource?.signal ?? agent.signal;
    let previousUpdate: AgentLoopTurnUpdate | undefined;
    if (originalPrepareNextTurn) {
      previousUpdate = await originalPrepareNextTurn(isPrepareNextTurnContext(signalOrContext) && signal ? signal : signalOrContext, signalSource);
    }
    if (signal?.aborted) return previousUpdate;

    const ourUpdate = await runTurnBoundaryCompaction(session, turnContext, signal);
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
  const result = event.result;
  if (!result || typeof result !== "object") return false;
  return event.reason === "threshold" && event.willRetry === true && event.willContinue !== true;
}

function restoreWorkingLoaderIfContinuing(mode: InternalInteractiveModeLike): void {
  try {
    if (!mode.session?.isStreaming || !mode.workingVisible) return;
    mode.loadingAnimation?.stop?.();
    mode.loadingAnimation = undefined;
    if (mode.settingsManager?.getShowTerminalProgress?.()) {
      mode.ui?.terminal?.setProgress?.(true);
    }
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
