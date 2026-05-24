/**
 * dispatch extension for pi-astack — delegate tasks to sub-agents.
 *
 * v3 (2026-05-23): In-process migration. Replaces subprocess pi spawning
 * (v2, 2026-05-06) with pi SDK's createAgentSession() — the Z-layer API
 * that pi now provides. Each dispatch runs an independent AgentSession
 * in-process with its own model, thinking level, and tool allowlist.
 *
 * Benefits over subprocess (v2):
 *   - Zero spawn overhead
 *   - No orphan process management (signals, _activeChildren, detached, etc.)
 *   - No double-layer timeout (D-state hang protection)
 *   - No temp file writes for prompts
 *   - No input-history pollution (no second pi instance)
 *   - No PI_ABRAIN_DISABLED env passthrough
 *   - 1:1 tool loop (pi runtime handles it, same as v2)
 *   - JSON event stream via subscribe() (same observability as v2)
 *
 * Cost: shares process space with parent pi. Acceptable because dispatch
 * sub-agents run LLM inference on remote APIs — they don't execute local
 * code unless PI_MULTI_AGENT_ALLOW_MUTATING=1 is set.
 *
 * Registers:
 *   dispatch_agent    — single task
 *   dispatch_parallel — parallel tasks (max 16)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { coerceTasksParam, normalizeTaskSpec } from "./input-compat";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";

// ── Constants ───────────────────────────────────────────────────

// 2026-05-24 fix: pi SDK 0.75 ToolDefinition.prepareArguments is typed
// (args: unknown) => Static<TParams>. Local closures previously declared
// (args: Record<string, unknown>) which is more restrictive (contravariant
// position) and doesn't assign. This helper narrows safely and lets the
// tool registrations below keep their internal `args.foo` access style.
// Reject Array.isArray so prepareArguments doesn't silently accept
// `dispatch_agent([{...}])` instead of `dispatch_agent({...})`.
function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

const MAX_PARALLEL = 16;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

/** Known tool names that pi SDK registers as built-in base tools.
 *  Used by validateTools to reject unknown tool names early — the SDK
 *  silently ignores unknown names, which would leave the sub-agent with
 *  zero tools and a confusing "I don't have access to tools" response.
 *  Must stay in sync with pi SDK's createCodingTools / createReadOnlyTools. */
const KNOWN_TOOLS = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls",
]);

// ── Footer status state machine ─────────────────────────────────

const DISPATCH_STATUS_KEY = FOOTER_STATUS_KEYS.dispatch;

type DispatchState = "idle" | "running" | "completed" | "failed";

interface DispatchCounts {
  running: number;
  failed: number;
  success: number;
  total: number;
}

export function renderDispatchStatus(
  state: DispatchState,
  counts?: DispatchCounts,
  durationMs?: number,
): string {
  const c = counts
    ? ` ${counts.running}/${counts.failed}/${counts.success}/${counts.total}`
    : "";
  const dur = typeof durationMs === "number"
    ? ` (${(durationMs / 1000).toFixed(1)}s)`
    : "";
  switch (state) {
    case "idle":      return "💤 dispatch idle";
    case "running":   return `📡 dispatch${c}`;
    case "completed": return `✅ dispatch${c}${dur}`;
    case "failed":    return `⚠️  dispatch${c}${dur}`;
    default:          return `❓ dispatch (${state})${c}${dur}`;
  }
}

function applyDispatchStatus(
  ctx: { ui?: { setStatus?(extId: string, message?: string): void } },
  state: DispatchState,
  counts?: DispatchCounts,
  durationMs?: number,
): void {
  const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
  if (!setStatusRaw) return;
  try {
    setStatusRaw(DISPATCH_STATUS_KEY, renderDispatchStatus(state, counts, durationMs));
  } catch { /* best-effort */ }
}

// ── Tool validation ─────────────────────────────────────────────

interface ToolValidation {
  ok: boolean;
  reason?: string;
}

function validateTools(toolsStr: string | undefined): ToolValidation {
  if (!toolsStr) return { ok: true };

  const names = toolsStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

  for (const name of names) {
    if (name === "dispatch_agent" || name === "dispatch_parallel") {
      return { ok: false, reason: `nested dispatch not allowed` };
    }
    if (!KNOWN_TOOLS.has(name)) {
      return { ok: false, reason: `unknown tool "${name}". Known tools: ${[...KNOWN_TOOLS].join(", ")}` };
    }
    if (MUTATING_TOOLS.has(name)) {
      if (process.env.PI_MULTI_AGENT_ALLOW_MUTATING !== "1") {
        return { ok: false, reason: `mutating tool "${name}" requires PI_MULTI_AGENT_ALLOW_MUTATING=1` };
      }
    }
  }

  return { ok: true };
}

// ── In-process agent ────────────────────────────────────────────

/** Categorised failure modes for observability. Ordered by lifecycle stage. */
type FailureType =
  // pre-flight: failed before any LLM call
  | "model_not_found"   // model string couldn't be resolved in registry
  | "tool_rejected"     // validateTools rejected the tool allowlist
  | "auth"              // API key missing, expired, or permission denied (HTTP 401/403)
  // in-flight transient: pi-ai's auto_retry already burned attempts; surfaced after retries exhausted
  | "rate_limit"        // HTTP 429 / quota exceeded
  | "network"           // DNS / TLS / connection reset / fetch failed
  | "server_error"      // HTTP 5xx / overloaded / bad gateway
  // in-flight terminal: agent stopped with bad outcome
  | "context_overflow"  // prompt exceeded model's max context window
  | "agent_error"       // generic agent stopReason="error" (no specific classification)
  | "retry_exhausted"   // pi-ai auto_retry exhausted maxRetries
  | "truncated"         // stopReason="length" (max tokens) or "abort" (provider cut stream)
  // lifecycle
  | "timeout"           // dispatch tool timed out (no output captured)
  | "timeout_partial"   // dispatch tool timed out but some output was captured
  | "aborted"           // user abort (ESC) or parent signal
  // fallback
  | "crash";            // unexpected exception that didn't match any pattern

// Negative lookahead: 3-digit number followed by a time unit is NOT an HTTP
// status code. Prevents "retry after 401 ms" / "timeout after 500 ms" from
// being misclassified as auth/server_error (P2-1 from R2 review).
const NOT_TIME_UNIT = String.raw`(?!\s*(?:ms|sec|seconds?|min|minutes?|hours?|days?)\b)`;

/**
 * Internal pattern-matching core for classifyError. Returns undefined when
 * no pattern matches, so the caller can decide between fallback and
 * retry_exhausted (see classifyWithRetry).
 */
function matchErrorCategory(msg: string | undefined): FailureType | undefined {
  if (!msg) return undefined;
  const m = msg.toLowerCase();
  // Auth: HTTP 401/403 (with NOT_TIME_UNIT guard) OR explicit auth keywords.
  if (
    new RegExp(String.raw`\b(?:401|403)\b` + NOT_TIME_UNIT).test(m) ||
    /unauthorized|forbidden|invalid api key|authentication failed|permission denied|no api key|expired token|bearer.*invalid|credentials/.test(m)
  ) return "auth";
  // Rate limit
  if (
    new RegExp(String.raw`\b429\b` + NOT_TIME_UNIT).test(m) ||
    /rate.?limit|quota.*exceed|too many requests/.test(m)
  ) return "rate_limit";
  // Context overflow
  if (/context.?length|prompt too long|context window|max.?tokens|token.?limit|context_length_exceeded/.test(m)) return "context_overflow";
  // Network (Node ECONNRESET/ETIMEDOUT/ENOTFOUND/etc., plus undici fetch errors)
  if (/econnreset|etimedout|enotfound|eai_again|econnrefused|fetch failed|network error|socket hang up|tls.*handshake/.test(m)) return "network";
  // Server error (5xx, with NOT_TIME_UNIT guard) OR explicit server keywords.
  if (
    new RegExp(String.raw`\b5\d\d\b` + NOT_TIME_UNIT).test(m) ||
    /server error|overloaded|service unavailable|bad gateway|internal server/.test(m)
  ) return "server_error";
  return undefined;
}

/**
 * Best-effort classification of raw error messages into FailureType.
 * pi-ai prefixes HTTP status codes to errorMessage (see pi-ai CHANGELOG),
 * so regex matching on those is a stable contract for status-based errors.
 *
 * Returns `fallback` when no pattern matches (default "crash").
 *
 * Edge cases handled:
 *  - "retry after 401 ms" → fallback (not auth) via NOT_TIME_UNIT guard
 *  - "timeout after 500 ms" → fallback (not server_error) via NOT_TIME_UNIT guard
 */
export function classifyError(
  msg: string | undefined,
  fallback: FailureType = "crash",
): FailureType {
  return matchErrorCategory(msg) ?? fallback;
}

/**
 * P0 fix (R2 review): when the agent reports an error AND retries were
 * exhausted, prefer the specific HTTP/network category over "retry_exhausted".
 * Calling code wants to know "you got rate-limited 3 times" not "some retry
 * gave up".
 *
 * Priority order:
 *   1. Specific category from message (auth / rate_limit / network / server_error / context_overflow)
 *   2. retry_exhausted (if retryHistory.finalOutcome === "exhausted")
 *   3. fallback (caller-specified — typically "agent_error" or "crash")
 */
export function classifyWithRetry(
  msg: string | undefined,
  retryHistory: AgentResult["retryHistory"] | undefined,
  fallback: FailureType = "crash",
): FailureType {
  const specific = matchErrorCategory(msg);
  if (specific) return specific;
  if (retryHistory?.finalOutcome === "exhausted") return "retry_exhausted";
  return fallback;
}

/**
 * Merge an assistant `message_end` event into the running finalOutput.
 * Returns the new finalOutput value: the turn's concatenated text if
 * non-empty, otherwise the prior value unchanged.
 *
 * R3 P0 fix: previous version unconditionally wiped finalOutput at the
 * start of each assistant turn, then conditionally re-assigned. Net effect
 * was that any turn without text content (tool-only turn, error turn)
 * wiped earlier turns' meaningful text — defeating both the R2 P2-3
 * preservation goal and the PARTIAL_OUTPUT_FAILURES expansion for
 * agent_error / retry_exhausted (no data to render).
 *
 * Exported for direct smoke-test coverage so this regression cannot recur
 * silently inside the subscribe callback.
 */
export function mergeAssistantTurn(
  prev: string,
  message: { content?: Array<{ type: string; text?: string }> } | null | undefined,
): string {
  if (!message?.content) return prev;
  let turnText = "";
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") {
      turnText += part.text;
    }
  }
  return turnText.length > 0 ? turnText : prev;
}

interface AgentResult {
  output: string;
  error?: string;
  /** Machine-readable failure category. Undefined on success. */
  failureType?: FailureType;
  stopReason?: string;
  durationMs: number;
  usage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
  /** Retry history from pi's auto_retry_start / auto_retry_end events.
   *  Undefined when no retries occurred. Populated in-process via
   *  subscribe() — same semantics as v2 subprocess. */
  retryHistory?: {
    entries: Array<{
      attempt: number;
      errorPreview?: string;
      delayMs?: number;
      startedAt: number;
    }>;
    finalOutcome?: "succeeded" | "exhausted";
    finalAttempt?: number;
    finalError?: string;
  };
}

/**
 * Resolve a "provider/modelId" string to a Model object via ModelRegistry.
 * Tries built-in model lookup first, then falls back to getAll() iteration.
 */
function resolveModel(
  modelStr: string,
  modelRegistry: ReturnType<typeof import("@earendil-works/pi-coding-agent").ModelRegistry.prototype.getAll> extends never ? never : any,
): any {
  // Use ModelRegistry.find for direct lookup
  const parts = modelStr.split("/");
  if (parts.length < 2) {
    return undefined;
  }
  const provider = parts[0]!;
  const modelId = parts.slice(1).join("/");
  return (modelRegistry as any).find?.(provider, modelId);
}

/**
 * Lazy-initialised, shared across all runInProcess calls within one
 * extension instance. SettingsManager + ResourceLoader are expensive
 * to create (disk I/O), so we create them once and reuse.
 *
 * Initialization is async so the first dispatch call pays the cost;
 * subsequent calls hit the cache. On failure, the cache is cleared
 * so the next call retries rather than permanently failing.
 *
 * ASSUMPTION: sub-agents do not modify settings or subscribe to
 * resourceLoader events, so sharing across concurrent AgentSessions
 * is safe. If a future SDK version adds mutable state to resourceLoader,
 * this cache must become per-session.
 */
let _sharedInfraPromise: Promise<{
  settingsManager: any;
  resourceLoader: any;
}> | undefined = undefined;

function getSharedInfra(): Promise<{
  settingsManager: any;
  resourceLoader: any;
}> {
  if (!_sharedInfraPromise) {
    _sharedInfraPromise = (async () => {
      const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      return { settingsManager, resourceLoader };
    })();
    // P1 fix: don't cache failures. If init throws, clear the promise so
    // the next dispatch call retries rather than permanently failing.
    _sharedInfraPromise.catch(() => {
      _sharedInfraPromise = undefined;
    });
  }
  return _sharedInfraPromise;
}

/**
 * Run a single agent in-process via createAgentSession().
 *
 * Creates an independent AgentSession with its own model, thinking level,
 * and tool allowlist. Collects output via subscribe(). Supports abort
 * (via AbortSignal) and timeout (via Promise.race).
 *
 * SECURITY (ADR 0014): v3 in-process dispatch does NOT provide the OS-level
 * process isolation that v2 subprocess spawn did. Sub-agents share the
 * parent's memory space, AuthStorage, and file system view. Mitigations:
 *   - `noExtensions: true` prevents extension tools (vault, etc.) from
 *     appearing in the sub-agent's tool list
 *   - `tools` allowlist restricts to read-only by default
 *   - `SessionManager.inMemory()` prevents session file writes
 *   - PI_MULTI_AGENT_ALLOW_MUTATING=1 gate still enforced
 * This is acceptable because typical dispatch usage calls remote LLM APIs
 * for analysis — sub-agents don't execute local code.
 */
async function runInProcess(
  modelStr: string,
  thinking: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
  modelRegistry: any,
  toolAllowlist?: string,
): Promise<AgentResult> {
  const start = Date.now();

  // Resolve model
  const model = resolveModel(modelStr, modelRegistry);
  if (!model) {
    return {
      output: "",
      error: `Model not found: ${modelStr}`,
      failureType: "model_not_found",
      durationMs: Date.now() - start,
    };
  }

  // Build tool allowlist (default: read-only safe set)
  const tools = (toolAllowlist || "read,grep,find,ls")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const { settingsManager, resourceLoader } = await getSharedInfra();

  // Local AbortController: merged from parent signal + timeout.
  // P1 fix: this closes the window where timeout fires before createAgentSession()
  // resolves. Without it, the agent would run a full turn and discard results.
  // The local signal is checked after session creation — it does NOT get passed
  // to createAgentSession() or prompt() (SDK doesn't accept AbortSignal).
  // The actual in-flight abort is handled by session.abort().
  const localCtl = new AbortController();
  const localSignal = localCtl.signal;

  let session: any = undefined;
  let settled = false;

  // Output collection.
  // finalOutput is the LAST assistant turn that produced text. Subscribe
  // only overwrites it when the current turn has non-empty text, so a
  // final error turn (no text content) doesn't wipe the meaningful output
  // from a prior turn (R2 P2-3 fix).
  let finalOutput = "";
  // Typed shape used by the agent_error branch; declared as `any` here
  // because TS strict-mode flow analysis treats closure writes in
  // subscribe() as opaque to outer reads, narrowing strict types to
  // `never`. We snapshot to a typed local at the read site instead.
  let lastAssistant: any = null;
  let usage: AgentResult["usage"] | undefined;
  let stopReason: string | undefined;

  // Retry observability (P1 fix: restore retryHistory from auto_retry_* events)
  const retryHistory: AgentResult["retryHistory"] = { entries: [] };

  // Handle abort. Calls session.abort() (best-effort, fire-and-forget) +
  // localCtl.abort() (checked post-session-creation).
  // Cross-path idempotence: abortOnce guards prevent double-abort from onAbort
  // + bail path + catch path all firing session.abort().
  let abortOnce = false;
  const abortSessionOnce = () => {
    if (abortOnce) return;
    abortOnce = true;
    try { void session?.abort?.()?.catch?.(() => {}); } catch { /* best-effort */ }
  };

  const onAbort = () => {
    if (settled) return;
    settled = true;
    localCtl.abort();
    abortSessionOnce();
  };

  if (signal.aborted) {
    return { output: "", error: "aborted before start", failureType: "aborted", durationMs: Date.now() - start };
  }
  signal.addEventListener("abort", onAbort, { once: true });

  // Timeout: race against session.prompt().
  // Note: Promise.race means timeout and normal completion may race;
  // if the agent finishes in the same microtask as the timeout, the
  // winner is non-deterministic. When timeout wins but finalOutput has
  // content, we surface it as a partial result rather than a bare timeout.
  //
  // Also non-deterministic by design: if agent reaches stopReason="length"
  // (truncation) in the same microtask the timeout fires, the result is
  // either `truncated` (runPromise wins) or `timeout_partial` (timeoutPromise
  // wins). Both are correct — the partial output is preserved in either
  // case, so the caller is not misled.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<AgentResult>((resolve) => {
    timeoutId = setTimeout(() => {
      onAbort();
      const hasPartial = finalOutput.length > 0;
      resolve({
        output: finalOutput,
        error: hasPartial
          ? `timeout after ${timeoutMs}ms (partial output captured)`
          : `timeout after ${timeoutMs}ms`,
        failureType: hasPartial ? "timeout_partial" : "timeout",
        durationMs: Date.now() - start,
        usage,
        stopReason,
        retryHistory: retryHistory.entries.length > 0 ? retryHistory : undefined,
      });
    }, timeoutMs);
    timeoutId!.unref();
  });

  const runPromise = (async (): Promise<AgentResult> => {
    try {
      // Create session
      const result = await createAgentSession({
        model,
        thinkingLevel: thinking as any, // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
        tools,
        modelRegistry,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(process.cwd()),
      });
      session = result.session;

      // If aborted during session creation, bail.
      // Check BOTH the parent signal AND our local signal (which timeout triggers).
      // P1 fix: without localSignal check, timeout that fires before this point
      // would be silently ignored and the agent would run a full turn.
      if (signal.aborted || localSignal.aborted) {
        abortSessionOnce();
        session.dispose();
        signal.removeEventListener("abort", onAbort);
        return { output: "", error: "aborted", failureType: "aborted", durationMs: Date.now() - start };
      }

      // Subscribe to collect output and retry history.
      // NOTE: subscribe callbacks are serialized by the agent core — no
      // concurrent invocations — so retryHistory.entries.push is safe.
      const unsub = session.subscribe((event: any) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          lastAssistant = event.message;
          // R3 P0 fix: use mergeAssistantTurn (pure, tested) instead of
          // inline merge — the inline version had an unconditional wipe
          // that defeated R2 P2-3 multi-turn preservation. See mergeAssistantTurn
          // docstring for details.
          finalOutput = mergeAssistantTurn(finalOutput, event.message);
          if (event.message.usage) {
            usage = {
              input: event.message.usage.input ?? 0,
              output: event.message.usage.output ?? 0,
              total: event.message.usage.totalTokens ?? 0,
              cost: event.message.usage.cost?.total ?? 0,
            };
          }
          stopReason = event.message.stopReason;
        }
        // P1 fix: restore retry observability from auto_retry_* events.
        // These fire inside the AgentSession's own retry loop (pi-ai level),
        // independent of model-fallback retries.
        if (event.type === "auto_retry_start") {
          retryHistory.entries.push({
            attempt: typeof event.attempt === "number" ? event.attempt : retryHistory.entries.length + 1,
            errorPreview: typeof event.errorMessage === "string"
              ? event.errorMessage.slice(0, 120).replace(/\s+/g, " ").trim()
              : undefined,
            delayMs: typeof event.delayMs === "number" ? event.delayMs : undefined,
            startedAt: Date.now(),
          });
        }
        if (event.type === "auto_retry_end") {
          retryHistory.finalOutcome = event.success ? "succeeded" : "exhausted";
          if (typeof event.attempt === "number") {
            retryHistory.finalAttempt = event.attempt;
          }
          if (typeof event.finalError === "string" && event.finalError) {
            retryHistory.finalError = event.finalError.slice(0, 200);
          }
        }
      });

      // Run agent (this blocks until agent finishes or aborts)
      await session.prompt(prompt);

      unsub();
      session.dispose();
      signal.removeEventListener("abort", onAbort);

      const durationMs = Date.now() - start;

      // Truncation: max-tokens ("length") or provider stream abort ("abort").
      // P0 fix: these were previously returned as success with truncated output;
      // now surfaced as failures so the caller knows the output is incomplete.
      if (stopReason === "length" || stopReason === "abort") {
        return {
          output: finalOutput,
          error: stopReason === "length"
            ? "output truncated (max tokens reached)"
            : "stream aborted by provider",
          failureType: "truncated",
          stopReason,
          durationMs,
          usage,
          retryHistory: retryHistory.entries.length > 0 ? retryHistory : undefined,
        };
      }

      // Agent reported error: stopReason=="error" OR errorMessage set on last assistant
      // (defensive: some providers may set errorMessage with stopReason="end_turn").
      // Snapshot to a fresh local so TS strict-mode flow analysis doesn't narrow
      // the closure-captured `lastAssistant` to never on the read sites below.
      // R3 P2-2 fix: typeof guard on errorMessage — if a future SDK version
      // returns a non-string (object, etc.), classifyError's toLowerCase() would
      // throw. Coerce to undefined unless we got a real string.
      const la = lastAssistant as { errorMessage?: unknown } | null;
      const errorMessage =
        typeof la?.errorMessage === "string" ? la.errorMessage : undefined;
      const agentReportedError = stopReason === "error" || !!errorMessage;
      if (agentReportedError) {
        // R3-r3 P1 fix: use || not ?? — SDK could in theory send
        // stopReason="error" with errorMessage="" (empty string). With ??,
        // baseError would be "", and downstream `if (result.error)` would
        // treat the falsy empty string as success, silently dropping the
        // error. || fallback catches empty string too.
        const baseError = errorMessage || "pi reported error";
        // R2 P0 fix: prefer specific HTTP category over retry_exhausted.
        // "retried 3 times then got 429" should surface as rate_limit, not
        // retry_exhausted — calling code needs the root cause.
        const ft = classifyWithRetry(baseError, retryHistory, "agent_error");
        return {
          output: finalOutput,
          error: baseError,
          failureType: ft,
          stopReason: stopReason ?? "error",
          durationMs,
          usage,
          retryHistory: retryHistory.entries.length > 0 ? retryHistory : undefined,
        };
      }

      return {
        output: finalOutput || "(no output)",
        stopReason,
        durationMs,
        usage,
        retryHistory: retryHistory.entries.length > 0 ? retryHistory : undefined,
      };
    } catch (err: any) {
      abortSessionOnce();
      try { session?.dispose?.(); } catch { /* best-effort */ }
      signal.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - start;
      const errMsg = err?.message ?? String(err);
      // R2 P0 fix: catch path is the MOST COMMON retry-exhausted route
      // (pi-ai rejects session.prompt() when auto_retry_end(success=false)).
      // Must:
      //   1. Use classifyWithRetry so retry_exhausted is actually reachable here
      //   2. Include retryHistory so callers can see what was tried
      return {
        output: finalOutput,
        error: errMsg,
        failureType: classifyWithRetry(errMsg, retryHistory, "crash"),
        durationMs,
        usage,
        retryHistory: retryHistory.entries.length > 0 ? retryHistory : undefined,
      };
    }
  })();

  const result = await Promise.race([runPromise, timeoutPromise]);
  if (timeoutId) clearTimeout(timeoutId);
  settled = true;
  return result;
}

// ── Result formatting ───────────────────────────────────────────

/**
 * One-line retry summary. Returns empty string when no retries.
 */
export function formatRetrySummary(history?: AgentResult["retryHistory"]): string {
  if (!history || !history.entries || history.entries.length === 0) return "";
  const n = history.entries.length;
  const word = n === 1 ? "attempt" : "attempts";
  let outcome: string;
  if (history.finalOutcome === "succeeded") outcome = "recovered ✓";
  else if (history.finalOutcome === "exhausted") outcome = "all failed ✗";
  else outcome = "status unknown";
  const firstErr = history.entries[0]?.errorPreview;
  const errPart = firstErr ? ` (first error: "${firstErr}")` : "";
  const finalErr = history.finalOutcome === "exhausted" && history.finalError
    ? ` (final: "${history.finalError.slice(0, 100)}")` : "";
  return `retries: ${n} ${word}, ${outcome}${errPart}${finalErr}`;
}

/** Failure types that captured meaningful partial output before failing.
 *  formatResult and dispatch_parallel detail rendering surface this output
 *  alongside the error so the caller can use whatever was produced.
 *
 *  R2 P1 fix: includes agent_error and retry_exhausted — these paths run
 *  through `subscribe()` which captures finalOutput from any prior
 *  assistant message_end, so sub-agent text that was already produced
 *  before failure should NOT be dropped. The risk of "leaking" output
 *  doesn't apply: this is always the sub-agent's own text, never
 *  upstream/runtime state. */
const PARTIAL_OUTPUT_FAILURES: ReadonlySet<FailureType> = new Set([
  "timeout_partial",
  "truncated",
  "agent_error",
  "retry_exhausted",
]);

export function formatResult(
  label: string,
  model: string,
  result: AgentResult,
): string {
  const dur = `${(result.durationMs / 1000).toFixed(1)}s`;
  const usageStr = result.usage
    ? ` ↑${result.usage.input} ↓${result.usage.output} $${result.usage.cost.toFixed(4)}`
    : "";
  const retryLine = formatRetrySummary(result.retryHistory);
  const retrySuffix = retryLine ? `\n_${retryLine}_` : "";

  if (result.error) {
    const failureLabel = result.failureType
      ? `[${result.failureType}] ` : "";
    // Include stopReason when it adds context (suppress redundant "error")
    const stopInfo = result.stopReason && result.stopReason !== "error"
      ? ` (stop=${result.stopReason})` : "";
    // P0 fix: render partial output for timeout_partial / truncated.
    // These failure modes captured meaningful content before failing,
    // hiding it defeats the purpose of the classification.
    const showPartial = result.output && result.failureType
      && PARTIAL_OUTPUT_FAILURES.has(result.failureType);
    const partialBlock = showPartial
      ? `\n\n_partial output (${result.output.length} chars):_\n\n${result.output}`
      : "";
    return `## ${label} (${model}) ❌ ${dur}\n${failureLabel}${result.error}${stopInfo}${usageStr ? `\n_${usageStr}_` : ""}${retrySuffix}${partialBlock}`;
  }

  return `## ${label} (${model}) ✅ ${dur}${usageStr ? ` _${usageStr}_` : ""}${retrySuffix}\n\n${result.output}`;
}

// ── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Sub-pi guard: in v3 (in-process), this guard is still useful for
  // the edge case where dispatch tools are loaded in an intentional
  // sub-process (not our concern, but belt-and-suspenders).
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  // Footer status: reset to idle on session/agent boundaries.
  pi.on("session_start", async (_event: unknown, ctx: any) => {
    applyDispatchStatus(ctx, "idle");
  });
  pi.on("agent_start", async (_event: unknown, ctx: any) => {
    applyDispatchStatus(ctx, "idle");
  });

  // ═══════════════════════════════════════════════════════════════
  // dispatch_agent
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Spawn a SINGLE sub-agent. For 2+ independent tasks, use dispatch_parallel instead " +
      "(calling dispatch_agent N times runs them serially, wasting wall-clock time). " +
      "The sub-agent runs as an in-process AgentSession, capable of multi-turn " +
      "tool calling (read, grep, find, ls). Mutating tools (bash, edit, write) " +
      "are blocked by default.",
    promptSnippet: "dispatch_agent(model, thinking, prompt, tools?, timeoutMs?) — SINGLE task only",
    promptGuidelines: [
      "Use dispatch_agent ONLY for a single analysis/reasoning task. For 2+ tasks, use dispatch_parallel.",
      "⚠️ Anti-pattern: calling dispatch_agent 3 times for 3 models. Each call blocks for the sub-agent to finish, so 3×30s=90s vs dispatch_parallel which runs them in parallel (~30s).",
      "Sub-agents CAN use read, grep, find, ls. Mutating tools require PI_MULTI_AGENT_ALLOW_MUTATING=1.",
      "The sub-agent is an independent AgentSession — its context does NOT count against your token budget.",
    ],
    parameters: Type.Object({
      model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
      thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
      prompt: Type.String({ description: "Prompt sent to this task" }),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool names allowlist (default: read,grep,find,ls). Mutating tools (bash/edit/write) require PI_MULTI_AGENT_ALLOW_MUTATING=1, and nested dispatch_agent/dispatch_parallel is always rejected." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in ms (default 1800000 = 30min)" })),
    }),

    prepareArguments(rawArgs: unknown) {
      const args = asRecord(rawArgs);
      const n = normalizeTaskSpec(args);
      // Conditional spread for optional fields: SDK schema infers
      // `tools?: string` / `timeoutMs?: number` (optional, not
      // `T | undefined`). Returning `{ tools: undefined }` literally
      // would conflict under exactOptionalPropertyTypes; spreading
      // only when present yields `tools?: string` shape.
      return {
        model: n.model,
        thinking: n.thinking,
        prompt: n.prompt,
        ...(n.tools !== undefined ? { tools: n.tools } : {}),
        ...(n.timeoutMs !== undefined ? { timeoutMs: n.timeoutMs } : {}),
      };
    },

    // 2026-05-24 fix: pi SDK 0.75 narrowing pattern follows the memory
    // extension lead (extensions/memory/index.ts) — keep `signal:
    // AbortSignal` (matches existing internal `signal.aborted` usage)
    // and `_onUpdate: unknown` (`any` widens the return type and breaks
    // strict-function-types assignment to ToolDefinition.execute).
    //
    // Explicit Promise<{...; details: unknown}> annotation prevents TS
    // from locking TDetails to the first return's specific shape (which
    // happens with bare `async execute` — then subsequent returns with
    // different details shapes fail to assign to that locked TDetails).
    // This matches what memory/index.ts does via wrapToolResult.
    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: unknown, ctx: any): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
      const toolCheck = validateTools(params.tools);
      if (!toolCheck.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ ${toolCheck.reason}` }],
          // pi SDK 0.75: AgentToolResult.details is required. Carry the
          // rejection reason as structured detail so UI / log consumers
          // can branch on `details.kind === "tool_rejected"`.
          details: { kind: "tool_rejected", reason: toolCheck.reason },
          // isError is a pi-SDK excess property (not in AgentToolResult<T>
          // strict type) but pi runtime honors it. Spread instead of
          // literal-property so the inferred return type tags it as
          // optional and stays assignable to AgentToolResult.
          ...{ isError: true },
        };
      }

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const startedAt = Date.now();
      applyDispatchStatus(ctx, "running", { running: 1, failed: 0, success: 0, total: 1 });

      let result: AgentResult;
      try {
        result = await runInProcess(
          params.model, params.thinking, params.prompt,
          signal, timeoutMs, ctx.modelRegistry, params.tools || undefined,
        );
      } catch (err: any) {
        // Outer safety-net catch — reachable when:
        //  - getSharedInfra() rejects (settings/resource init failure) before
        //    runInProcess's internal try wraps the session promise;
        //  - synchronous throws in runInProcess setup (param destructuring etc.).
        // Not reachable for in-flight session/retry failures — those are
        // caught inside runInProcess and returned as AgentResult.
        // No retryHistory exists at this scope, so classifyError (not
        // classifyWithRetry) is the correct call.
        const rawMsg = err?.message ?? String(err);
        result = {
          output: "",
          error: `dispatch crashed: ${rawMsg}`,
          failureType: classifyError(rawMsg, "crash"),
          durationMs: Date.now() - startedAt,
        };
      }

      const durationMs = Date.now() - startedAt;
      if (result.error) {
        applyDispatchStatus(ctx, "failed", { running: 0, failed: 1, success: 0, total: 1 }, durationMs);
      } else {
        applyDispatchStatus(ctx, "completed", { running: 0, failed: 0, success: 1, total: 1 }, durationMs);
      }

      const text = formatResult("dispatch", params.model, result);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          kind: "dispatch_agent_result",
          model: params.model,
          durationMs,
          ok: !result.error,
          ...(result.error ? { error: result.error, failureType: result.failureType } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        },
        ...(result.error ? { isError: true } : {}),
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // dispatch_parallel
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "dispatch_parallel",
    label: "Dispatch Parallel",
    description:
      "Run multiple sub-agents IN PARALLEL. Each is an independent in-process AgentSession. " +
      "Results are collected when ALL complete. This is the primary tool for " +
      "multi-model analysis — do NOT call dispatch_agent N times instead. " +
      "Mutating tools blocked by default. " +
      `Up to ${MAX_PARALLEL} tasks per call; up to ${MAX_CONCURRENCY} run concurrently.`,
    promptSnippet: "dispatch_parallel([{model, thinking, prompt}, ...], timeoutMs?) — parallel execution",
    promptGuidelines: [
      "Use dispatch_parallel EVERY TIME you have 2+ independent analysis tasks with different models. All tasks run in parallel — do NOT call dispatch_agent N times.",
      "Example: dispatch_parallel([{model:'claude-opus-4-7', thinking:'high', prompt:'audit docs'}, {model:'gpt-5.5', thinking:'high', prompt:'audit code'}, {model:'deepseek-v4-pro', thinking:'high', prompt:'audit architecture'}]) → all 3 run concurrently, results returned together.",
      `Concurrency: up to ${MAX_PARALLEL} tasks accepted; ${MAX_CONCURRENCY} run at once, others queue. Choose models from DIFFERENT providers for diversity.`,
      "For reasoning-only tasks, omit tools (sub-agent uses built-in read/grep/find/ls).",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
          thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
          prompt: Type.String({ description: "Prompt sent to this task" }),
          tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist for this task (default: read,grep,find,ls)." })),
          timeoutMs: Type.Optional(Type.Number({ description: "Per-task timeout in ms (default 1800000 = 30min)" })),
        }),
        { description: `Array of task specifications (max ${MAX_PARALLEL})` },
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Default per-task timeout in ms (default 1800000 = 30min)" })),
    }),

    prepareArguments(rawArgs: unknown) {
      const args = asRecord(rawArgs);
      const rawTasks = (args as any).tasks;
      const raw = coerceTasksParam(rawTasks);
      if (!Array.isArray(raw) || raw.length === 0) {
        const got =
          rawTasks === undefined
            ? "undefined"
            : typeof rawTasks === "string"
              ? `string of length ${rawTasks.length} starting with ${JSON.stringify(rawTasks.slice(0, 40))}`
              : `${typeof rawTasks} (${Array.isArray(rawTasks) ? "empty array" : "non-array"})`;
        throw new Error(
          `dispatch_parallel: 'tasks' must be a non-empty array of task objects {model, thinking, prompt}. ` +
            `Got ${got}. ` +
            `Pass tasks directly as a JSON array — do NOT wrap the entire array in a JSON string. ` +
            `If your prompt contains quote characters, the host's tool-call serializer handles escaping; ` +
            `you only need to author the array structurally.`,
        );
      }
      const tasks = raw.slice(0, MAX_PARALLEL).map((t: unknown) => {
        const n = normalizeTaskSpec(t);
        return {
          model: n.model,
          thinking: n.thinking,
          prompt: n.prompt,
          ...(n.tools !== undefined ? { tools: n.tools } : {}),
          ...(n.timeoutMs !== undefined ? { timeoutMs: n.timeoutMs } : {}),
        };
      });
      const topTimeoutMs = (args as any).timeoutMs;
      return {
        tasks,
        ...(topTimeoutMs !== undefined ? { timeoutMs: topTimeoutMs } : {}),
      };
    },

    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: unknown, ctx: any): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
      const tasks = params.tasks ?? [];
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No tasks provided." }],
          details: { kind: "dispatch_parallel_no_tasks" },
          ...{ isError: true },
        };
      }
      if (tasks.length === 1) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ dispatch_parallel requires 2+ tasks. You provided 1 task.\n\n` +
              `For a single task, use dispatch_agent instead — it has the same ` +
              `model/thinking/prompt/timeoutMs parameters and returns a simpler result. ` +
              `dispatch_parallel exists ONLY for parallel multi-model analysis; ` +
              `calling it with 1 task wastes the parallelism infrastructure and makes ` +
              `the output harder to read (table format for a single row).`,
          }],
          details: { kind: "dispatch_parallel_single_task_rejected", suggestion: "use dispatch_agent" },
          ...{ isError: true },
        };
      }

      const dispatchStart = Date.now();
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const results: AgentResult[] = new Array(tasks.length);
      let nextIdx = 0;
      let running = 0;
      let success = 0;
      let failed = 0;
      const total = tasks.length;

      const updateRunning = () =>
        applyDispatchStatus(ctx, "running", { running, failed, success, total });
      updateRunning();

      const worker = async () => {
        while (true) {
          if (signal.aborted || ctx.signal?.aborted) return;
          const i = nextIdx++;
          if (i >= total) return;
          const t = tasks[i];

          running++;
          updateRunning();
          let res: AgentResult;
          try {
            const toolCheck = validateTools(t.tools);
            if (!toolCheck.ok) {
              res = {
                output: "",
                error: `task[${i}] rejected: ${toolCheck.reason}`,
                failureType: "tool_rejected",
                durationMs: 0,
              };
              results[i] = res;
              running--;
              failed++;
              updateRunning();
              continue;
            }
            res = await runInProcess(
              t.model, t.thinking, t.prompt,
              signal, t.timeoutMs ?? timeoutMs, ctx.modelRegistry,
              t.tools || "read,grep,find,ls",
            );
          } catch (err: any) {
            // Outer safety-net catch — reachable for getSharedInfra() init
            // failure and synchronous throws in runInProcess setup. In-flight
            // session/retry failures are caught inside runInProcess. No
            // retryHistory at this scope, classifyError is correct.
            const rawMsg = err?.message ?? String(err);
            res = {
              output: "",
              error: `dispatch crashed: ${rawMsg}`,
              failureType: classifyError(rawMsg, "crash"),
              durationMs: 0,
            };
          }
          results[i] = res;
          running--;
          if (res.error) failed++;
          else success++;
          updateRunning();
        }
      };

      const workers = new Array(Math.min(MAX_CONCURRENCY, total)).fill(null).map(() => worker());
      await Promise.allSettled(workers);
      const totalWallMs = Date.now() - dispatchStart;
      const totalWall = (totalWallMs / 1000).toFixed(1);
      const finalState: DispatchState = failed > 0 ? "failed" : "completed";
      applyDispatchStatus(
        ctx, finalState,
        { running: 0, failed, success, total },
        totalWallMs,
      );

      // Build summary
      const serialEstimate = results.filter((r): r is AgentResult => r != null).reduce((s, r) => s + r.durationMs, 0);
      const maxSingle = Math.max(0, ...results.filter((r): r is AgentResult => r != null).map((r) => r.durationMs));

      const lines: string[] = [
        `## Dispatch Results (${tasks.length} tasks, ${totalWall}s total)`,
      ];
      if (tasks.length > 1) {
        const parallelRatio = (serialEstimate / (maxSingle || 1)).toFixed(1);
        lines.push(
          `_serial sum: ${(serialEstimate / 1000).toFixed(1)}s → ` +
          `parallel actual: ${totalWall}s (${parallelRatio}× speedup)_\n`,
        );
      }
      lines.push("");
      lines.push(`| # | Model | Duration | Status |`);
      lines.push(`|---|-------|----------|--------|`);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r) continue;
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        // P1 fix: surface failureType in summary table so the caller sees
        // root cause at-a-glance across 16 parallel tasks without scrolling.
        const status = r.error
          ? `❌ ${r.failureType ?? "error"}`
          : "✅";
        lines.push(`| ${i + 1} | ${tasks[i].model} | ${dur} | ${status} |`);
      }
      lines.push("");

      for (let i = 0; i < results.length; i++) {
        if (!results[i]) continue;
        const r = results[i];
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        const usageStr = r.usage
          ? ` ↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`
          : "";

        lines.push(`### ${i + 1}. ${tasks[i].model} (${dur}${usageStr ? ` — ${usageStr}` : ""})`);

        if (r.error) {
          const failureTag = r.failureType ? ` [${r.failureType}]` : "";
          lines.push(`❌${failureTag} ${r.error}`);
          // R2 P1-2 fix: render retry summary in error branch too.
          // dispatch_parallel previously only rendered retry info via
          // formatResult in dispatch_agent — parallel inlined its own
          // rendering and dropped retryHistory entirely.
          const retryLine = formatRetrySummary(r.retryHistory);
          if (retryLine) lines.push(`_${retryLine}_`);
          // P0 fix: render partial output for partial-capture failure types
          // (timeout_partial, truncated, agent_error, retry_exhausted).
          if (r.output && r.failureType && PARTIAL_OUTPUT_FAILURES.has(r.failureType)) {
            lines.push("");
            lines.push(`_partial output (${r.output.length} chars):_`);
            lines.push("");
            lines.push(r.output);
          }
        } else {
          // R2 P1-2 fix: also render retry summary on success (e.g., recovered
          // after 2 retries) — retry observability shouldn't disappear in
          // success paths.
          const retryLine = formatRetrySummary(r.retryHistory);
          if (retryLine) lines.push(`_${retryLine}_`);
          lines.push(r.output);
        }
        lines.push("");
      }

      const hasErrors = results.some((r) => r?.error);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          kind: "dispatch_parallel_summary",
          taskCount: tasks.length,
          success,
          failed,
          totalWallMs,
          serialEstimateMs: serialEstimate,
          maxSingleMs: maxSingle,
          tasks: tasks.map((t: any, i: number) => ({
            model: t.model,
            durationMs: results[i]?.durationMs ?? 0,
            ok: !results[i]?.error,
            ...(results[i]?.error ? { error: results[i].error, failureType: results[i].failureType } : {}),
            ...(results[i]?.usage ? { usage: results[i].usage } : {}),
          })),
        },
        ...(hasErrors ? { isError: true } : {}),
      };
    },
  });
}
