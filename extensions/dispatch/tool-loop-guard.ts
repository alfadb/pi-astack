/**
 * E — tool idle-loop guard.
 *
 * Detects a tool "spin": the SAME (toolName, arguments) issued CONSECUTIVELY
 * (back-to-back, with no different tool call in between). On the Nth such
 * consecutive identical call (N = threshold) the call is suppressed and a
 * reflection nudge is returned to the model instead of executing again.
 *
 * Consecutive-only is the deliberate false-positive floor: any different tool
 * call resets the streak, so legitimate patterns — read-after-edit, spaced
 * re-runs of a test between other work, polling that interleaves other calls —
 * never trip it. Only a genuine back-to-back repeat with no intervening action
 * (where the result provably will not change) is suppressed. The guard is
 * stateless beyond a tiny per-session {lastSig, consecutive}; it is reset each
 * turn (agent_start) so a streak never carries across turns.
 *
 * Pure logic only (no fs / pi). Wiring + settings read live in index.ts; the
 * smoke unit-tests these functions.
 */

export interface ToolLoopState {
  lastSig: string | null;
  consecutive: number;
}

export function newToolLoopState(): ToolLoopState {
  return { lastSig: null, consecutive: 0 };
}

/** Stable signature for (toolName, input): key-sorted JSON so argument key
 *  order never changes identity. */
export function toolCallSignature(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input)}`;
}

function stableStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export interface ToolLoopVerdict {
  /** True when this call should be suppressed (not executed). */
  block: boolean;
  /** How many times this exact signature has now repeated consecutively. */
  consecutive: number;
}

/**
 * Update `state` with a new call signature and decide whether to suppress.
 * A signature different from the last resets the streak to 1. The call is
 * blocked once the consecutive count reaches `threshold` (and stays blocked
 * for every further identical repeat until the signature changes).
 */
export function evaluateToolLoop(state: ToolLoopState, sig: string, threshold: number): ToolLoopVerdict {
  if (sig === state.lastSig) {
    state.consecutive += 1;
  } else {
    state.lastSig = sig;
    state.consecutive = 1;
  }
  return { block: state.consecutive >= threshold, consecutive: state.consecutive };
}

/** The reflection surfaced to the model in place of the suppressed result. */
export function buildLoopReflection(toolName: string, consecutive: number): string {
  return (
    `Idle-loop guard: \`${toolName}\` was called ${consecutive} times in a row with identical arguments, ` +
    `so this repeat was NOT executed — the result cannot differ from the previous identical call. ` +
    `Re-read that previous result instead of repeating. If you are waiting for something to change, ` +
    `re-calling with the same arguments will not change it. To proceed, take a different action or vary ` +
    `the arguments (any difference bypasses this guard).`
  );
}

export interface IdleLoopGuardSettings {
  enabled: boolean;
  /** Consecutive-identical count at which suppression starts (>= 2). */
  threshold: number;
}

export const IDLE_LOOP_GUARD_DEFAULTS: IdleLoopGuardSettings = { enabled: true, threshold: 3 };

/** Resolve guard settings from a parsed pi-astack-settings.json object
 *  (`dispatch.idleLoopGuard`). Pure; fail-open to defaults. */
export function resolveIdleLoopGuardSettings(rawSettings: unknown): IdleLoopGuardSettings {
  const root = (rawSettings && typeof rawSettings === "object" ? rawSettings : {}) as Record<string, unknown>;
  const dispatch = (root.dispatch && typeof root.dispatch === "object" ? root.dispatch : {}) as Record<string, unknown>;
  const g = (dispatch.idleLoopGuard && typeof dispatch.idleLoopGuard === "object" ? dispatch.idleLoopGuard : {}) as Record<string, unknown>;
  const enabled = typeof g.enabled === "boolean" ? g.enabled : IDLE_LOOP_GUARD_DEFAULTS.enabled;
  const threshold =
    typeof g.threshold === "number" && Number.isFinite(g.threshold) && g.threshold >= 2
      ? Math.floor(g.threshold)
      : IDLE_LOOP_GUARD_DEFAULTS.threshold;
  return { enabled, threshold };
}
