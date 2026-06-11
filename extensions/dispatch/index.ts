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
 *   - No PI_ABRAIN_DISABLED env passthrough (v3+ uses isSubAgentSession
 *     via WeakSet marker on the sub-agent's SessionManager — see
 *     _shared/pi-internals.ts and ADR 0027 PR-B)
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
import { markSessionAsSubAgent, bindSubAgentBoundarySentinel } from "../_shared/pi-internals";
import {
  bindLifecycle as bindCausalAnchorLifecycle,
  runWithTriggerAnchor,
  getCurrentAnchor,
  deriveSubAgentAnchor,
  formatAnchorPromptBlock,
  spreadAnchor,
  type CausalAnchor,
} from "../_shared/causal-anchor";
import { dispatchAuditPath } from "../_shared/runtime";
import {
  buildTerminalStateFields,
  inferParallelTerminalState,
  inferTerminalState,
  type TaskSummary,
} from "./terminal-state";
import { startHeartbeat, type HeartbeatHandle } from "../_shared/heartbeat";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
// PR-10 (ADR 0032 §8): MAX_CONCURRENCY / DEFAULT_TIMEOUT_MS exported as part
// of the shared runner API surface — the workflow engine mirrors the same
// global cap (W12) and per-unit timeout default instead of duplicating
// literals that could drift.
export const MAX_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

/** Known tool names accepted by validateTools — used to reject unknown
 *  names early (SDK would silently ignore them, leaving the sub-agent
 *  with zero tools and a confusing "I don't have access to tools"
 *  response).
 *
 *  Members:
 *  - read/bash/edit/write/grep/find/ls — pi SDK built-in base tools
 *    (must stay in sync with createCodingTools / createReadOnlyTools)
 *  - web_search/web_fetch — pi-astack web-search extension (ADR 0027
 *    PR-A: L2 worker read tools, exposed to sub-agents by default)
 *  - memory_search/memory_get/memory_list/memory_neighbors/memory_decide —
 *    pi-astack abrain extension (ADR 0027 PR-B: L2 workers grown on L1 hub
 *    need brain read access for the symbiosis loop)
 *  - vision — pi-astack vision extension (image analysis, read-only)
 *
 *  Deliberately NOT included (extension-loaded but kept out of sub-agents):
 *  - vault_release: secret release, main-session-only (ADR 0014 §6)
 *  - prompt_user: user interaction, sub-agent can't reach user
 *  - imagine: image generation, expensive + main-session-only by design
 *  - final_answer: main-session terminal wrapper from tool-contract;
 *    exposing it would break dispatch result extraction semantics
 *  - dispatch_agent/dispatch_parallel: nested dispatch forbidden (would
 *    explode token cost + violate ADR 0027 C5 fail-fast invariant) */
const KNOWN_TOOLS = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "web_search", "web_fetch",
  "memory_search", "memory_get", "memory_list", "memory_neighbors", "memory_decide",
  "vision",
]);

// ── ADR 0027 C6a: dispatch audit log ────────────────────────────

/** Audit row schema version. Increment when adding non-additive fields.
 *
 *  v1 → v2 (ADR 0027 §C5 v1, 2026-05-28): added `terminal_state` taxonomy
 *  + per-state side-effect fields (cancel_source / cleanup_done /
 *  rollback_done / what_dropped / alt_path / resumable). Legacy `result:
 *  "ok"|"fail"` and `failure_type` are RETAINED for backward compatibility
 *  with audit consumers that haven't been updated. `terminal_state` is
 *  ADDITIVE — readers can pick either schema, but new analysis tooling
 *  should prefer `terminal_state` because it distinguishes cancelled vs
 *  failed and surfaces degraded outcomes that the old binary schema
 *  collapses into "fail". */
const DISPATCH_AUDIT_VERSION = 2;

/** Append one row to `<projectRoot>/.pi-astack/dispatch/audit.jsonl`.
 *  Best-effort: any failure (disk full / permission / fs error) is
 *  swallowed so audit logging never breaks the dispatch path. The
 *  `console.warn` is rate-limited by Node's once-per-event-loop dedup
 *  in practice; if audit truly fails for every call there will be a
 *  modest log spam but no functional impact (per C5 fail-degrade). */
async function appendDispatchAudit(
  projectRoot: string,
  anchor: CausalAnchor | undefined,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    const auditPath = dispatchAuditPath(projectRoot);
    await mkdir(dirname(auditPath), { recursive: true });
    const row = {
      timestamp: new Date().toISOString(),
      audit_version: DISPATCH_AUDIT_VERSION,
      pid: process.pid,
      ...spreadAnchor(anchor),
      ...event,
    };
    await appendFile(auditPath, `${JSON.stringify(row)}\n`, "utf-8");
  } catch (err) {
    // Audit failure must not break dispatch. Log + continue.
    try {
      console.warn(
        `pi-astack/dispatch: audit append failed (${(err as Error)?.message ?? "unknown"}); ` +
        `dispatch continues, but trace chain for this row is missing.`,
      );
    } catch { /* truly best-effort */ }
  }
}

// ── Footer status state machine ─────────────────────────────────

const DISPATCH_STATUS_KEY = FOOTER_STATUS_KEYS.dispatch;

/** Footer state machine state. v2 (2026-05-28) adds `degraded` and
 *  `cancelled` to surface ADR 0027 §C5 distinctions in the UI:
 *    degraded  — dispatch_parallel partial-success (some tasks succeeded)
 *    cancelled — task(s) externally terminated (user abort, timeout)
 *  Single-task dispatch_agent never enters `degraded` (aggregate-only). */
type DispatchState = "idle" | "running" | "completed" | "failed" | "degraded" | "cancelled";

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
    case "degraded":  return `🟡 dispatch${c}${dur}`;
    case "cancelled": return `🚫 dispatch${c}${dur}`;
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

// PR-10 (ADR 0032 §8): exported — the workflow production runner routes its
// per-stage tool allowlist through the SAME gate (nested-dispatch rejection +
// PI_MULTI_AGENT_ALLOW_MUTATING env check inherit with the API, not by copy).
export function validateTools(toolsStr: string | undefined): ToolValidation {
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
  // Network (Node ECONNRESET/ETIMEDOUT/ENOTFOUND/etc., plus undici fetch errors,
  // plus upstream-gateway SSE-disconnect markers from sub2api / proxy gateways).
  // The "upstream stream disconnected" / "stream_read_error" / "unexpected eof"
  // family arrives in errorMessage when the SSE upstream (Anthropic / OpenAI edge)
  // does HTTP/2 GOAWAY mid-stream; gateway wraps it as an SSE error frame. Once
  // model-fallback prepends the RETRYABLE_PREFIX ("connection lost —") on the
  // sub-agent path (Handler A, see model-fallback/index.ts I-6), pi auto-retries.
  // After all retries exhaust we still want failureType="network" (transient)
  // rather than fallback "agent_error" (generic) so the audit row is precise.
  if (/econnreset|etimedout|enotfound|eai_again|econnrefused|fetch failed|network error|socket hang up|tls.*handshake|upstream.*disconnect|stream.?read.?error|unexpected eof|connection lost/.test(m)) return "network";
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

export interface AgentResult {
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
// PR-10 (ADR 0032 §8): the shared-infra promise lives on a globalThis
// Symbol.for slot, NOT a module-level variable. pi loads extensions via jiti
// with moduleCache:false, so the workflow extension importing runInProcess
// from this module gets its OWN module copy (heartbeat.ts R4 NEW-P0 lesson;
// same pattern as _SHARED_LOADER_FLAG_KEY below) — a module-level cache here
// would mean two resourceLoader.reload() passes and two shared sub-agent
// extension stacks. The globalThis slot collapses all copies to one infra.
const _SHARED_INFRA_KEY = Symbol.for("pi-astack/dispatch/shared-infra/v1");

type SharedInfra = { settingsManager: any; resourceLoader: any };

function _sharedInfraSlot(): { value?: Promise<SharedInfra> } {
  const g = globalThis as Record<symbol, unknown>;
  let slot = g[_SHARED_INFRA_KEY] as { value?: Promise<SharedInfra> } | undefined;
  if (!slot) {
    slot = {};
    g[_SHARED_INFRA_KEY] = slot;
  }
  return slot;
}

/** ADR 0027 PR-B+ R1 P1-1 (sub-agent boundary sentinel): when this flag is
 *  true, `dispatch.activate(pi)` is being called from inside the shared
 *  sub-agent loader (via resourceLoader.reload below). In that runtime,
 *  every session_start fires for a sub-agent — the perfect probe site to
 *  verify SessionManager passthrough invariant. See pi-internals.ts.
 *
 *  R4 NEW-P0 fix: stored on globalThis singleton so the flag set by
 *  main-pi's dispatch instance is visible to the shared-loader's dispatch
 *  instance (different jiti, different module copies otherwise). */
const _SHARED_LOADER_FLAG_KEY = Symbol.for("pi-astack/dispatch/activating-shared-loader/v1");

function _setActivatingInSharedLoader(v: boolean): void {
  (globalThis as Record<symbol, unknown>)[_SHARED_LOADER_FLAG_KEY] = v;
}

function _isActivatingInSharedLoaderInternal(): boolean {
  return Boolean((globalThis as Record<symbol, unknown>)[_SHARED_LOADER_FLAG_KEY]);
}

/** Public for tests / diagnostics. Returns true during the brief window
 *  resourceLoader.reload() is initializing the shared sub-agent extensions. */
export function _isActivatingInSharedLoader(): boolean {
  return _isActivatingInSharedLoaderInternal();
}

function getSharedInfra(): Promise<{
  settingsManager: any;
  resourceLoader: any;
}> {
  const slot = _sharedInfraSlot();
  if (!slot.value) {
    slot.value = (async () => {
      const settingsManager = (SettingsManager.create as (
        cwd: string,
        agentDir?: string,
        options?: { projectTrusted?: boolean },
      ) => any)(process.cwd(), getAgentDir(), { projectTrusted: false });
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        settingsManager,
        // ADR 0027 PR-B: sub-agents load the full GLOBAL extension stack so
        // they can read brain (memory_*), use web tools, etc. Main-session-only
        // lifecycle handlers (sediment / compaction-tuner / model-fallback /
        // persistent-input-history / model-curator / rule-injector) gate
        // themselves OFF via isSubAgentSession(ctx) — the SessionManager
        // passed to createAgentSession below is marked before use.
        //
        // pi 0.79.0 Project Trust: keep the shared sub-agent loader explicitly
        // untrusted for project-local inputs. There is currently no trustworthy
        // bridge from the main session's per-cwd trust decision into this shared
        // in-process loader, so it must load user/global extensions only. The
        // SettingsManager.create call above passes { projectTrusted:false };
        // noExtensions remains false to retain global pi-astack tools/prompts.
        // (Previously noExtensions: true to enforce ADR 0014 §6, replaced
        // by handler-level guards via pi-internals.ts WeakSet marker.)
        noExtensions: false,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      // ADR 0027 PR-B+ R1 P1-1: arm the boundary sentinel for activate() calls
      // happening inside this reload. The flag is process-wide globalThis
      // singleton (R4 NEW-P0 fix) so the shared-loader's dispatch instance
      // (DIFFERENT jiti module copy from main pi's dispatch) reads the same
      // flag value.
      _setActivatingInSharedLoader(true);
      try {
        await resourceLoader.reload();
      } finally {
        _setActivatingInSharedLoader(false);
      }
      return { settingsManager, resourceLoader };
    })();
    // P1 fix: don't cache failures. If init throws, clear the promise so
    // the next dispatch call retries rather than permanently failing.
    const created = slot.value;
    created.catch(() => {
      if (slot.value === created) slot.value = undefined;
    });
  }
  return slot.value;
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
 *   - `tools` allowlist is EXCLUSIVE: createAgentSession exposes only the
 *     listed tools, so extension-registered tools (vault_release,
 *     prompt_user) are NOT callable even though noExtensions:false loads
 *     the full extension stack. KNOWN_TOOLS also excludes them, so a caller
 *     cannot request them via `tools=`. (Was noExtensions:true in v2;
 *     replaced by allowlist + isSubAgentSession guards — see getSharedInfra
 *     and scripts/smoke-dispatch-subagent-tool-allowlist.mjs.)
 *   - default allowlist is read-only
 *   - `SessionManager.inMemory()` prevents session file writes
 *   - PI_MULTI_AGENT_ALLOW_MUTATING=1 gate still enforced
 * This is acceptable because typical dispatch usage calls remote LLM APIs
 * for analysis — sub-agents don't execute local code.
 */
export async function runInProcess(
  modelStr: string,
  thinking: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
  modelRegistry: any,
  toolAllowlist?: string,
  /** ADR 0027 §C2' v1 Stage 1b: anchor + projectRoot needed for the
   *  independent heartbeat liveness channel. When undefined the
   *  heartbeat handle is a no-op (fail-open) and runInProcess works
   *  identically to pre-Stage-1b for callers that don't pass anchor. */
  heartbeatCtx?: { anchor?: CausalAnchor; projectRoot?: string },
): Promise<AgentResult> {
  const start = Date.now();

  // ADR 0027 §C2' Stage 1b heartbeat. Start BEFORE createAgentSession
  // (so caller can detect a session-construction hang) and stop on
  // every terminal path (success / error / timeout / abort). The
  // handle is a no-op when anchor / projectRoot is missing, so this
  // is safe even on legacy call sites that don't pass heartbeatCtx.
  const heartbeat: HeartbeatHandle = startHeartbeat({
    anchor: heartbeatCtx?.anchor,
    projectRoot: heartbeatCtx?.projectRoot ?? process.cwd(),
    startedNote: `model=${modelStr}`,
  });

  // R8 P1 fix (Opus P0-A + GPT-5.5 P1-1 + DeepSeek P1-2 unanimous):
  // wrap the entire body in try/finally so heartbeat.stop() fires on
  // EVERY terminal path — including the early returns below
  // (model_not_found, signal pre-aborted) and any throw from
  // getSharedInfra / createAgentSession. Previous implementation only
  // called stop() after Promise.race, so early returns leaked the
  // setInterval timer + on-disk trace file + globalThis registry entry.
  // heartbeat.stop() is idempotent + best-effort, so wrapping is
  // mechanically safe.
  try {

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

  // Build tool allowlist.
  //
  // Default = read-only safe set + web read tools (ADR 0027 PR-A) + memory
  // read/decide tools (ADR 0027 PR-B+ R1 P1-2 Route A' synthesis).
  //
  // Why memory_* in default:
  //   - ADR 0027 C1' L1→L2 symbiosis: sub-agent worker should be able to
  //     read user's long-term preferences / past lessons / architecture
  //     decisions to ground its task. PR-B's noExtensions=false started
  //     this; default allowlist now finishes it.
  //   - DeepSeek T0 vote: "PR-B intentionally did NOT gate
  //     memory.before_agent_start → design intent was sub-agent reads brain".
  //   - P0-α (sediment masks sub-agent toolResult) closed the
  //     self-exciting-loop risk; this default is now safe.
  //
  // Why NOT memory_list:
  //   - memory_list is a broad-inventory/management tool, not targeted
  //     retrieval. sub-agent workers don't need to enumerate the entire
  //     brain; they need to look up specific things (memory_search) or
  //     read a specific entry (memory_get) or fetch related ones
  //     (memory_neighbors) or get a decision brief (memory_decide).
  //   - DeepSeek + GPT-5.5 T0 votes both flagged memory_list as too wide.
  //
  // Caller can always override with explicit `tools=...`. memory_list is
  // in KNOWN_TOOLS so callers wanting it can pass it explicitly.
  const tools = (toolAllowlist || "read,grep,find,ls,web_search,web_fetch,memory_search,memory_get,memory_neighbors,memory_decide")
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
      // ADR 0027 PR-B: mark this SessionManager as sub-agent so that
      // lifecycle handlers in sediment / compaction-tuner / model-fallback /
      // persistent-input-history / model-curator / abrain rule-injector
      // can detect via isSubAgentSession(ctx) and skip main-session-only
      // side effects. Must happen BEFORE createAgentSession() because pi
      // fires session_start synchronously inside session construction.
      const subAgentSm = SessionManager.inMemory(process.cwd());
      markSessionAsSubAgent(subAgentSm);

      // Create session
      const result = await createAgentSession({
        model,
        thinkingLevel: thinking as any, // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
        tools,
        modelRegistry,
        settingsManager,
        resourceLoader,
        sessionManager: subAgentSm,
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
  } finally {
    // ADR 0027 §C2' Stage 1b R8 P1 fix: heartbeat.stop() in finally
    // closes the lifecycle on EVERY terminal path. Idempotent +
    // best-effort — will never throw out of finally. Covers:
    //   - normal Promise.race resolution (success / agent_error)
    //   - timeout firing
    //   - early return for model_not_found (3 unanimous P1)
    //   - early return for pre-aborted signal
    //   - getSharedInfra rejection (Opus P1-C)
    //   - any unexpected throw from session/prompt path
    heartbeat.stop();
  }
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

  // ADR 0027 PR-B+ R1 P1-1: if we're activating inside the shared
  // sub-agent loader, install the SessionManager passthrough boundary
  // sentinel. This pi.on("session_start") listener runs in the sub-agent
  // runtime and will detect (loud-warn) if pi upgrade ever wraps
  // SessionManager in a Proxy/facade, breaking the WeakSet identity
  // assumption. Probe is one-shot per process. We do NOT install on the
  // main pi runtime because in main pi, session_start is for the main
  // session (not a sub-agent) and would always look unmarked.
  if (_isActivatingInSharedLoaderInternal()) {
    bindSubAgentBoundarySentinel(pi);
  }

  // ADR 0027 C6a: bind dispatch (canonical anchor owner) to lifecycle events
  // so the main-session (session_id, turn_id) is tracked process-wide and
  // available to every audit writer via getCurrentAnchor().
  //
  // Note: this activate function ALSO runs in the shared sub-agent loader
  // (PR-B set noExtensions: false on _sharedInfraPromise). bindLifecycle
  // registers session_start / before_agent_start / agent_end handlers on
  // EVERY call (it is NOT a first-only no-op — the old registration guard was
  // removed 2026-05-29 because it caused the live anchor_missing bug). Calling
  // it from multiple runners/extensions is safe: the before_agent_start bump
  // is idempotent PER TURN (state.turnAlreadyBumped, reset on
  // agent_end/session_start), so turn_id still advances exactly once per turn.
  // All three handlers self-gate on isSubAgentSession(ctx), so the shared
  // sub-agent loader's registrations never touch the main anchor; sub-agent
  // anchors are derived via deriveSubAgentAnchor + runWithTriggerAnchor.
  // See causal-anchor.ts bindLifecycle doc.
  bindCausalAnchorLifecycle(pi);

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
      "Run a SINGLE sub-agent task in-process. For 2+ independent tasks, use dispatch_parallel instead " +
      "(calling dispatch_agent N times runs them serially, wasting wall-clock time). " +
      "The sub-agent is an independent in-process AgentSession (not a subprocess), capable of multi-turn " +
      "tool calling (read, grep, find, ls). Mutating tools (bash, edit, write) " +
      "are blocked by default.",
    promptSnippet: "dispatch_agent(model, thinking, prompt, tools?, timeoutMs?) — SINGLE task only",
    promptGuidelines: [
      "Use dispatch_agent ONLY for a single analysis/reasoning task. For 2+ tasks, use dispatch_parallel.",
      "⚠️ Anti-pattern: calling dispatch_agent 3 times for 3 models. Each call blocks for the sub-agent to finish, so 3×30s=90s vs dispatch_parallel which runs them in parallel (~30s).",
      "Sub-agents CAN use read, grep, find, ls, web_search, web_fetch. Mutating tools (bash, edit, write) require PI_MULTI_AGENT_ALLOW_MUTATING=1.",
      "The sub-agent is an independent AgentSession — its context does NOT count against your token budget.",
    ],
    parameters: Type.Object({
      model: Type.String({ description: 'Provider/model in `provider/model-id` format. Must be a model registered in pi-astack-settings.json → modelCurator.providers.' }),
      thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
      prompt: Type.String({ description: "Prompt sent to this task" }),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool names allowlist (default: read,grep,find,ls,web_search,web_fetch,memory_search,memory_get,memory_neighbors,memory_decide). Mutating tools (bash/edit/write) require PI_MULTI_AGENT_ALLOW_MUTATING=1, and nested dispatch_agent/dispatch_parallel is always rejected." })),
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
        // ADR 0027 §C5 v1 P1 fix (R6 GPT-5.5 P1-3): tool_rejected is a
        // pre-flight failure. C5's "every L2 task has explicit terminal
        // state" contract requires this row to be audited. Previously
        // this path returned without writing audit, missing the row for
        // dispatch_agent while dispatch_parallel.task did emit it. Add
        // the audit row here so dispatch_agent has parity.
        const rejectResult: AgentResult = {
          output: "",
          error: `tool_rejected: ${toolCheck.reason}`,
          failureType: "tool_rejected",
          durationMs: 0,
        };
        const rejectAnchor = deriveSubAgentAnchor(getCurrentAnchor(), "dispatch_agent");
        const rejectTsFields = buildTerminalStateFields(rejectResult);
        void appendDispatchAudit(ctx.cwd || process.cwd(), rejectAnchor, {
          operation: "dispatch_agent",
          // R7 NIT fix (DeepSeek NIT-1): dispatch_parallel.task carries
          // row_kind:"task"; dispatch_agent should match for symmetry so
          // jq queries filtering by row_kind catch both.
          row_kind: "task",
          model: params.model,
          thinking: params.thinking,
          tools: params.tools ?? null,
          prompt_chars: typeof params.prompt === "string" ? params.prompt.length : 0,
          duration_ms: 0,
          result: "fail",
          ...rejectTsFields,
          failure_type: "tool_rejected",
          output_chars: 0,
        });
        return {
          content: [{ type: "text" as const, text: `❌ ${toolCheck.reason}` }],
          // pi SDK 0.75: AgentToolResult.details is required. Carry the
          // rejection reason as structured detail so UI / log consumers
          // can branch on `details.kind === "tool_rejected"`.
          details: {
            kind: "tool_rejected",
            reason: toolCheck.reason,
            terminalState: rejectTsFields.terminal_state,
            ...(rejectAnchor ? { anchor: rejectAnchor } : {}),
          },
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

      // ADR 0027 C6a: derive sub-agent anchor from main-session parent anchor.
      // - parentAnchor may be undefined (e.g., dispatch_agent called before any
      //   user turn — extremely rare but possible in test fixtures). In that
      //   case subAnchor is also undefined; we still spawn the sub-agent but
      //   trace chain for this row is broken (audit log records anchor absent).
      // - The anchor block is prepended to the prompt so the sub-agent LLM
      //   knows its position in the trace tree (per C6 "L2 must know its anchor").
      const parentAnchor = getCurrentAnchor();
      const subAnchor = deriveSubAgentAnchor(parentAnchor, "dispatch_agent");
      const prompt = subAnchor
        ? `${formatAnchorPromptBlock(subAnchor)}\n\n${params.prompt}`
        : params.prompt;

      let result: AgentResult;
      try {
        // ADR 0027 PR-B+ R3 fix (Opus + GPT-5.5): wrap sub-agent execution
        // in runWithTriggerAnchor(subAnchor) so getCurrentAnchor() inside
        // the sub-agent runtime (via shared loader's pi-astack extensions)
        // returns the SUB-AGENT anchor (with subturn), not the main-session
        // anchor. This makes:
        //   - memory_decide produces ${sid}|${tid}.${subturn}|${seq}
        //     decision_brief_id per ADR 0026 §5.1 (was: ${sid}|${tid}|${seq}
        //     missing subturn before this fix)
        //   - memory search-metrics rows carry subturn
        //   - any anchor-aware audit writer in the sub-agent runtime
        //     attributes to (session_id, turn_id, subturn) correctly
        // ALS propagates through await chains and fire-and-forget
        // promises created inside the sub-agent's tool callbacks.
        result = await runWithTriggerAnchor(subAnchor, () =>
          runInProcess(
            params.model, params.thinking, prompt,
            signal, timeoutMs, ctx.modelRegistry, params.tools || undefined,
            // ADR 0027 §C2' Stage 1b heartbeat: thread anchor + cwd so
            // runInProcess can write the liveness channel. subAnchor is
            // the per-dispatch sub-agent anchor; ctx.cwd is the project
            // root. Both are also used by C6 audit so no new state.
            { anchor: subAnchor, projectRoot: ctx.cwd || process.cwd() },
          ),
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
      // R7.1 P2 fix (GPT-5.5 + DeepSeek unanimous): single-task footer
      // must map terminal_state instead of collapsing cancelled into
      // failed. dispatch_parallel.execute already does this (line
      // ~1467); dispatch_agent was inconsistent. Stage 1b heartbeat
      // will need this symmetry so a heartbeat-driven cancellation
      // shows 🚫 not ⚠️ .
      const singleTaskFinalState: DispatchState = !result.error
        ? "completed"
        : result.failureType === "aborted" || result.failureType === "timeout" || result.failureType === "timeout_partial"
          ? "cancelled"
          : "failed";
      const isOk = !result.error;
      applyDispatchStatus(
        ctx, singleTaskFinalState,
        { running: 0, failed: isOk ? 0 : 1, success: isOk ? 1 : 0, total: 1 },
        durationMs,
      );

      // ADR 0027 C6a + §C5 v1: dispatch audit row — cross-layer join key
      // for tracing a user turn through L1 (sediment / abrain) and L2
      // (this row + any sub-agent self-traces). v2 schema adds
      // terminal_state + side-effect fields. cancelSource heuristic: if
      // signal.aborted fired, prefer "user" (parent abort); the
      // buildTerminalStateFields default would otherwise infer from
      // failureType="timeout" → "timeout", missing the case where the
      // parent signal fires before the timeout. Best-effort:
      // appendDispatchAudit swallows IO errors so audit failures never
      // break the dispatch path.
      const tsFields = buildTerminalStateFields(result, {
        cancelSource: signal.aborted ? "user" : undefined,
      });
      void appendDispatchAudit(
        ctx.cwd || process.cwd(),
        subAnchor,
        {
          operation: "dispatch_agent",
          // R7 NIT fix (DeepSeek NIT-1): symmetry with dispatch_parallel.task.
          row_kind: "task",
          model: params.model,
          thinking: params.thinking,
          tools: params.tools ?? null,
          prompt_chars: typeof params.prompt === "string" ? params.prompt.length : 0,
          duration_ms: durationMs,
          result: result.error ? "fail" : "ok",
          ...tsFields,
          ...(result.failureType ? { failure_type: result.failureType } : {}),
          ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
          output_chars: result.output?.length ?? 0,
          ...(result.usage
            ? {
                tokens_in: result.usage.input,
                tokens_out: result.usage.output,
                cost: result.usage.cost,
              }
            : {}),
        },
      );

      const text = formatResult("dispatch", params.model, result);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          kind: "dispatch_agent_result",
          model: params.model,
          durationMs,
          ok: !result.error,
          // ADR 0027 §C5 v1: surface terminal_state so the caller LLM can
          // distinguish cancelled (timeout / user abort) from failed.
          terminalState: tsFields.terminal_state,
          ...(tsFields.cancel_source ? { cancelSource: tsFields.cancel_source } : {}),
          ...(subAnchor ? { anchor: subAnchor } : {}),
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
      "Example: dispatch_parallel([{model:'provider-a/model-a', thinking:'high', prompt:'audit docs'}, {model:'provider-b/model-b', thinking:'high', prompt:'audit code'}, {model:'provider-c/model-c', thinking:'high', prompt:'audit architecture'}]) → all 3 run concurrently, results returned together. Use different providers per task for cross-vendor blind reviews.",
      `Concurrency: up to ${MAX_PARALLEL} tasks accepted; ${MAX_CONCURRENCY} run at once, others queue. Choose models from DIFFERENT providers for diversity.`,
      "For reasoning-only tasks, omit tools (sub-agent uses built-in read/grep/find/ls).",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          model: Type.String({ description: 'Provider/model in `provider/model-id` format. Must be a model registered in pi-astack-settings.json → modelCurator.providers.' }),
          thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
          prompt: Type.String({ description: "Prompt sent to this task" }),
          tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist for this task (default: read,grep,find,ls,web_search,web_fetch,memory_search,memory_get,memory_neighbors,memory_decide)." })),
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

      // ADR 0027 C6a: capture parent anchor ONCE before worker fan-out so
      // all N tasks share the same parent. Each task derives its own
      // subturn inside the worker loop (deriveSubAgentAnchor maintains
      // per-(session_id, turn_id) counter, so subturns are 1..N in call order).
      const parentAnchor = getCurrentAnchor();
      const projectRoot = ctx.cwd || process.cwd();

      const results: AgentResult[] = new Array(tasks.length);
      const taskAnchors: Array<CausalAnchor | undefined> = new Array(tasks.length);
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
          // ADR 0027 C6a: derive this task's sub-agent anchor. Label
          // includes task index so audit consumers can correlate to the
          // tasks[] array position. subturn is auto-incremented inside
          // deriveSubAgentAnchor and stable across retry loops.
          const subAnchor = deriveSubAgentAnchor(parentAnchor, `dispatch_parallel[${i}]`);
          taskAnchors[i] = subAnchor;
          const taskStart = Date.now();
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
              // Audit even for rejected tasks — the rejection itself is
              // part of the trace ("tried task X but tool allowlist refused").
              // ADR 0027 §C5 v1: tool_rejected is a pre-flight failure →
              // terminal_state = failed, with vacuous rollback/cleanup.
              const rejectedTsFields = buildTerminalStateFields(res);
              void appendDispatchAudit(projectRoot, subAnchor, {
                operation: "dispatch_parallel.task",
                row_kind: "task",
                task_index: i,
                task_count: total,
                model: t.model,
                thinking: t.thinking,
                tools: t.tools ?? null,
                prompt_chars: typeof t.prompt === "string" ? t.prompt.length : 0,
                duration_ms: 0,
                result: "fail",
                ...rejectedTsFields,
                failure_type: "tool_rejected",
                output_chars: 0,
              });
              continue;
            }
            const prompt = subAnchor
              ? `${formatAnchorPromptBlock(subAnchor)}\n\n${t.prompt}`
              : t.prompt;
            // ADR 0027 PR-B+ R3 fix: per-task subAnchor scope. Each
            // dispatch_parallel task gets its own subturn via
            // deriveSubAgentAnchor; runWithTriggerAnchor isolates this
            // task's anchor from sibling tasks' anchors (ALS is per
            // async-context, sibling fan-out tasks each get their own).
            // Without this wrap, all N tasks' memory_decide calls would
            // use the parent (main) anchor without distinguishing which
            // task produced which brief.
            res = await runWithTriggerAnchor(subAnchor, () =>
              runInProcess(
                t.model, t.thinking, prompt,
                signal, t.timeoutMs ?? timeoutMs, ctx.modelRegistry,
                t.tools || "read,grep,find,ls,web_search,web_fetch,memory_search,memory_get,memory_neighbors,memory_decide",
                // Stage 1b heartbeat ctx. Per-task subAnchor (subturn
                // 1..N) gives each task its own heartbeat file under
                // .pi-astack/dispatch/heartbeat/.
                { anchor: subAnchor, projectRoot },
              ),
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

          // ADR 0027 C6a + §C5 v1: per-task audit row. Cross-layer
          // consumers join on (session_id, turn_id, subturn) to
          // reconstruct one dispatch_parallel invocation's full sub-agent
          // fan-out. v2 schema adds per-task terminal_state. Parent
          // signal: distinguish parent abort ("user") from per-task
          // timeout — same logic as dispatch_agent above.
          const taskTsFields = buildTerminalStateFields(res, {
            cancelSource: signal.aborted ? "user" : undefined,
          });
          void appendDispatchAudit(projectRoot, subAnchor, {
            operation: "dispatch_parallel.task",
            row_kind: "task",
            task_index: i,
            task_count: total,
            model: t.model,
            thinking: t.thinking,
            tools: t.tools ?? null,
            prompt_chars: typeof t.prompt === "string" ? t.prompt.length : 0,
            duration_ms: Date.now() - taskStart,
            result: res.error ? "fail" : "ok",
            ...taskTsFields,
            ...(res.failureType ? { failure_type: res.failureType } : {}),
            ...(res.stopReason ? { stop_reason: res.stopReason } : {}),
            output_chars: res.output?.length ?? 0,
            ...(res.usage
              ? {
                  tokens_in: res.usage.input,
                  tokens_out: res.usage.output,
                  cost: res.usage.cost,
                }
              : {}),
          });
        }
      };

      const workers = new Array(Math.min(MAX_CONCURRENCY, total)).fill(null).map(() => worker());
      await Promise.allSettled(workers);
      const totalWallMs = Date.now() - dispatchStart;
      const totalWall = (totalWallMs / 1000).toFixed(1);

      // ADR 0027 §C5 v1 R7 P1 fix (Opus P1-A + GPT-5.5 P1-1 unanimous):
      // R6 only materialized hole slots inside taskSummaries (the input to
      // inferParallelTerminalState). But `results[]` itself stayed sparse,
      // so every OTHER downstream surface (details.tasks, markdown table,
      // summary counters, legacy `result`, hasErrors, output rendering)
      // saw the original holes and produced caller-visible contradictions:
      //   - details.tasks[hole].ok was true (!undefined === true)
      //   - details.tasks[hole].terminalState was "failed"
      //     (yet aggregate said cancelled)
      //   - legacy `result: "ok"` with terminal_state: "cancelled" on all-holes
      //   - markdown table silently skipped holes — LLM saw "3 tasks" but
      //     only 2 rows, the third invisible
      //
      // R7 builds ONE dense materializedResults array and replaces every
      // downstream `results[i]?...` pattern. Hole synthesis matches the
      // shape used in taskSummaries (failureType: "aborted") so terminal_
      // state classification is identical across all consumers.
      const materializedResults: AgentResult[] = tasks.map((_t: any, i: number) => {
        const r = results[i];
        if (r) return r;
        return {
          output: "",
          error: "task did not start (parent abort before worker claim)",
          failureType: "aborted",
          durationMs: 0,
        };
      });

      // taskSummaries now derives from the dense array — single source of
      // truth, no duplicated hole-materialization logic.
      const taskSummaries: TaskSummary[] = materializedResults.map((r, i) => ({
        result: r,
        label: tasks[i]?.model ?? `task[${i}]`,
      }));
      // R6 P1 fix (GPT-5.5 P1-2): thread parent-abort context into aggregate.
      const aggregateTsFields = inferParallelTerminalState(taskSummaries, {
        cancelSource: signal.aborted ? "user" : undefined,
      });
      // R6 P2 fix (DeepSeek P2-3): footer state machine now surfaces
      // cancelled distinctly from failed.
      const finalState: DispatchState =
        aggregateTsFields.terminal_state === "completed" ? "completed"
        : aggregateTsFields.terminal_state === "degraded" ? "degraded"
        : aggregateTsFields.terminal_state === "cancelled" ? "cancelled"
        : "failed";

      // R7 P1 fix: counters derive from materialized array, so holes are
      // attributed (they count as failed-or-not-completed). Previously
      // `success` and `failed` were incremented in the worker loop, which
      // never ran for hole slots — task_count ≠ success + failed.
      const successCount = materializedResults.filter((r) => !r.error).length;
      const failedCount = materializedResults.filter((r) => !!r.error).length;
      applyDispatchStatus(
        ctx, finalState,
        { running: 0, failed: failedCount, success: successCount, total },
        totalWallMs,
      );

      // ADR 0027 §C5 v1: aggregate dispatch_parallel.summary audit row.
      // Prior to v1 only per-task rows existed, so cross-layer consumers had
      // to re-aggregate failed/ok counts to know if the whole invocation
      // succeeded. v1 emits a single summary row with the aggregate
      // terminal_state (completed / degraded / failed / cancelled) so
      // downstream readers can join the fan-out via (session_id, turn_id,
      // subturn=0). subturn=0 is reserved for the aggregate row; per-task
      // rows carry subturn=1..N.
      const aggregateAnchor = parentAnchor
        ? { ...parentAnchor, subturn: 0, sub_agent_label: "dispatch_parallel.summary" }
        : undefined;
      // R6 P2 (GPT-5.5 P2-1): add explicit row_kind so jq queries don't
      // confuse the aggregate row with a task row. Per-task rows carry
      // row_kind="task" (set below in the worker loop edit).
      // R7 P1 fix: derive `result` from aggregate terminal_state so it can
      // never disagree (e.g., all-holes → result was "ok" + terminal_state
      // "cancelled" in R6). Mapping: completed → ok, everything else → fail
      // (preserves backward-compat with legacy consumers reading binary
      // ok/fail). Stronger semantics live in `terminal_state`.
      const aggregateLegacyResult =
        aggregateTsFields.terminal_state === "completed" ? "ok" : "fail";
      void appendDispatchAudit(projectRoot, aggregateAnchor, {
        operation: "dispatch_parallel.summary",
        row_kind: "aggregate",
        task_count: total,
        // R7: counters now reflect materialized array (holes counted as
        // failed). Previously this could leave failed_count=0 + holes,
        // breaking task_count = success + failed invariant.
        success_count: successCount,
        failed_count: failedCount,
        duration_ms: totalWallMs,
        serial_estimate_ms: materializedResults.reduce((s, r) => s + r.durationMs, 0),
        max_single_ms: Math.max(0, ...materializedResults.map((r) => r.durationMs)),
        result: aggregateLegacyResult,
        ...aggregateTsFields,
      });

      // Build summary. R7 uses materializedResults so holes contribute
      // durationMs:0 instead of being filtered out (which would have
      // silently underestimated serial_estimate when the fan-out aborted).
      const serialEstimate = materializedResults.reduce((s, r) => s + r.durationMs, 0);
      const maxSingle = Math.max(0, ...materializedResults.map((r) => r.durationMs));

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

      // R7 P1 fix (DeepSeek P2-3): iterate materializedResults so hole
      // tasks are NOT silently skipped from the table. A task that the
      // parent aborted before worker-claim is shown as 🚫 cancelled with
      // duration 0, so the caller LLM can see the full picture rather
      // than wondering why a "3 tasks" header shows only 2 rows.
      for (let i = 0; i < materializedResults.length; i++) {
        const r = materializedResults[i];
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        const ts = inferTerminalState(r);
        let status: string;
        if (!r.error) {
          status = "✅";
        } else if (ts === "cancelled") {
          status = `🚫 ${r.failureType ?? "cancelled"}`;
        } else {
          status = `❌ ${r.failureType ?? "error"}`;
        }
        lines.push(`| ${i + 1} | ${tasks[i].model} | ${dur} | ${status} |`);
      }
      lines.push("");

      for (let i = 0; i < materializedResults.length; i++) {
        const r = materializedResults[i];
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        const usageStr = r.usage
          ? ` ↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`
          : "";

        lines.push(`### ${i + 1}. ${tasks[i].model} (${dur}${usageStr ? ` — ${usageStr}` : ""})`);

        if (r.error) {
          // R7: cancelled tasks render with 🚫 in the per-task detail
          // section too, matching the table prefix. Without this, the
          // table shows 🚫 but the detail shows ❌ — inconsistent.
          const detailTs = inferTerminalState(r);
          const prefix = detailTs === "cancelled" ? "🚫" : "❌";
          const failureTag = r.failureType ? ` [${r.failureType}]` : "";
          lines.push(`${prefix}${failureTag} ${r.error}`);
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

      // R7 P1 fix: hasErrors derives from aggregate terminal_state so the
      // isError flag is consistent with all other surfaces. Previously
      // `results.some(r => r?.error)` could be false when all slots were
      // holes (no completed task at all) — isError would not fire even
      // though the dispatch was effectively cancelled.
      const hasErrors = aggregateTsFields.terminal_state !== "completed";
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          kind: "dispatch_parallel_summary",
          taskCount: tasks.length,
          // R7: counter consistency with audit row.
          success: successCount,
          failed: failedCount,
          totalWallMs,
          serialEstimateMs: serialEstimate,
          maxSingleMs: maxSingle,
          // ADR 0027 §C5 v1: surface aggregate terminal_state to the
          // caller LLM so it can read the dispatch outcome (degraded /
          // failed) without re-aggregating per-task error fields.
          terminalState: aggregateTsFields.terminal_state,
          ...(aggregateTsFields.what_dropped ? { whatDropped: aggregateTsFields.what_dropped } : {}),
          ...(aggregateTsFields.alt_path ? { altPath: aggregateTsFields.alt_path } : {}),
          // R7 P1 fix (Opus P1-A + GPT-5.5 P1-1 + DeepSeek P2-1):
          // details.tasks uses materializedResults so hole slots produce
          // consistent (ok=false, terminalState=cancelled, failureType=
          // aborted) entries instead of the previous contradictory
          // (ok=true, terminalState=failed, no error) shape.
          tasks: tasks.map((t: any, i: number) => {
            const r = materializedResults[i];
            return {
              model: t.model,
              durationMs: r.durationMs,
              ok: !r.error,
              ...(r.error ? { error: r.error, failureType: r.failureType } : {}),
              ...(r.usage ? { usage: r.usage } : {}),
              terminalState: inferTerminalState(r),
            };
          }),
        },
        ...(hasErrors ? { isError: true } : {}),
      };
    },
  });
}
