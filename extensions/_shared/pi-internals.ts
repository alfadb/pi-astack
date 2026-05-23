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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// ── State ────────────────────────────────────────────────────────────────

/** Results of startup integrity checks. */
interface StartupCheckResult {
  api: string;
  available: boolean;
  error?: string;
}

const startupResults: StartupCheckResult[] = [];

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

  // Check 2: future internal APIs go here
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
