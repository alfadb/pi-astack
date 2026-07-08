/**
 * Global repeated tool-call circuit breaker.
 *
 * Pure per-agent-run accounting for identical tool invocations. The runtime
 * extension wires this into pi's shared `tool_call` hook so it applies to the
 * current agent run, including dispatch-spawned AgentSessions.
 */

export interface ToolCircuitBreakerSettings {
  enabled: boolean;
  /** Deprecated/ignored at runtime; kept for config compatibility and diagnostics only. */
  totalThreshold: number;
  /** Block after this many consecutive calls with the same fingerprint. */
  consecutiveThreshold: number;
  /** Enable periodic tail-pattern detection across multiple tool fingerprints. */
  cycleDetectionEnabled: boolean;
  /** Maximum cycle length considered by the tail-pattern detector. */
  maxCycleLength: number;
  /** Block after this many full cycle rounds appear at the tail. */
  cycleRepeatThreshold: number;
  /** Ask pi to abort the active agent after returning the blocking tool error. */
  abortOnTrip: boolean;
  /** Bound per-process memory for old agent runs. */
  maxSessions: number;
  /** Bound per-agent-run memory for unique fingerprints. */
  maxFingerprints: number;
}

export const TOOL_CIRCUIT_BREAKER_LIMITS = {
  maxCycleLength: 32,
  cycleRepeatThreshold: 20,
} as const;

export const TOOL_CIRCUIT_BREAKER_DEFAULTS: ToolCircuitBreakerSettings = {
  enabled: true,
  totalThreshold: 8,
  consecutiveThreshold: 4,
  cycleDetectionEnabled: true,
  maxCycleLength: 10,
  cycleRepeatThreshold: 5,
  abortOnTrip: true,
  maxSessions: 128,
  maxFingerprints: 1024,
};

export interface ToolFingerprintStats {
  total: number;
}

export interface ToolCircuitBreakerTrip {
  toolName: string;
  fingerprint: string;
  fingerprintSummary: string;
  total: number;
  consecutive: number;
  reason: "consecutive" | "cycle" | "already_tripped";
  cycleLength?: number;
  cycleRepeats?: number;
}

export interface ToolCircuitBreakerState {
  lastFingerprint: string | null;
  consecutive: number;
  counts: Map<string, ToolFingerprintStats>;
  recentFingerprints: string[];
  tripped?: ToolCircuitBreakerTrip;
}

export type ToolCircuitBreakerVerdict =
  | { block: false; toolName: string; fingerprint: string; fingerprintSummary: string; total: number; consecutive: number }
  | ({ block: true } & ToolCircuitBreakerTrip);

export function newToolCircuitBreakerState(): ToolCircuitBreakerState {
  return { lastFingerprint: null, consecutive: 0, counts: new Map(), recentFingerprints: [] };
}

export function normalizeToolArgs(input: unknown): string {
  return stableStringify(input, new WeakSet<object>());
}

export function toolCallFingerprint(toolName: string, input: unknown): string {
  return `${toolName}::${normalizeToolArgs(input)}`;
}

export function summarizeFingerprint(fingerprint: string): string {
  return `hash:${fnv1a32(fingerprint)} len:${fingerprint.length}`;
}

export function evaluateToolCircuitBreaker(
  state: ToolCircuitBreakerState,
  toolName: string,
  input: unknown,
  settings: ToolCircuitBreakerSettings = TOOL_CIRCUIT_BREAKER_DEFAULTS,
): ToolCircuitBreakerVerdict {
  const fingerprint = toolCallFingerprint(toolName, input);
  const fingerprintSummary = summarizeFingerprint(fingerprint);

  if (state.tripped) {
    return { block: true, ...state.tripped, reason: "already_tripped" };
  }

  if (fingerprint === state.lastFingerprint) {
    state.consecutive += 1;
  } else {
    state.lastFingerprint = fingerprint;
    state.consecutive = 1;
  }

  state.recentFingerprints.push(fingerprint);
  pruneRecentFingerprints(state.recentFingerprints, settings.maxCycleLength, settings.cycleRepeatThreshold);

  const prior = state.counts.get(fingerprint)?.total ?? 0;
  const total = prior + 1;
  state.counts.set(fingerprint, { total });
  pruneOldest(state.counts, settings.maxFingerprints);

  const consecutiveTrip = state.consecutive > settings.consecutiveThreshold;
  const cycleTrip = !consecutiveTrip ? detectCycleTail(state.recentFingerprints, settings) : null;
  const reason = consecutiveTrip ? "consecutive" : cycleTrip ? "cycle" : undefined;

  if (!reason) {
    return { block: false, toolName, fingerprint, fingerprintSummary, total, consecutive: state.consecutive };
  }

  const trip: ToolCircuitBreakerTrip = {
    toolName,
    fingerprint,
    fingerprintSummary,
    total,
    consecutive: state.consecutive,
    reason,
    ...(cycleTrip ?? {}),
  };
  state.tripped = trip;
  return { block: true, ...trip };
}

export function buildToolCircuitBreakerMessage(
  trip: ToolCircuitBreakerTrip,
  settings: ToolCircuitBreakerSettings = TOOL_CIRCUIT_BREAKER_DEFAULTS,
): string {
  const trigger = trip.reason === "consecutive"
    ? `consecutive repeats ${trip.consecutive} > ${settings.consecutiveThreshold}`
    : trip.reason === "cycle"
      ? `cycle repeats ${trip.cycleRepeats ?? settings.cycleRepeatThreshold} rounds with period ${trip.cycleLength ?? "?"}`
      : "current agent run already tripped";

  return [
    "Tool-call circuit breaker tripped.",
    `Tool: ${trip.toolName}`,
    `Fingerprint: ${trip.fingerprintSummary}`,
    `Counts: total=${trip.total}, consecutive=${trip.consecutive}`,
    trip.reason === "cycle" && trip.cycleLength !== undefined && trip.cycleRepeats !== undefined
      ? `Cycle: length=${trip.cycleLength}, repeats=${trip.cycleRepeats}`
      : undefined,
    `Trigger: ${trigger}`,
    trip.reason === "cycle"
      ? "This current agent run is being stopped because it repeatedly cycled through the same tail pattern of tool calls. Do not retry the same sequence; inspect the earlier result or change approach."
      : "This current agent run is being stopped because it repeatedly requested the exact same tool call with the same normalized arguments. Do not retry the same call; inspect the previous result or change approach.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function resolveToolCircuitBreakerSettings(
  rawSettings: unknown,
  env: Record<string, string | undefined> = process.env,
): ToolCircuitBreakerSettings {
  const root = asRecord(rawSettings);
  const cfg = asRecord(root.toolCircuitBreaker);
  const defaults = TOOL_CIRCUIT_BREAKER_DEFAULTS;

  const resolved: ToolCircuitBreakerSettings = {
    enabled: boolOr(cfg.enabled, defaults.enabled),
    totalThreshold: intAtLeast(cfg.totalThreshold, defaults.totalThreshold, 1),
    consecutiveThreshold: intAtLeast(cfg.consecutiveThreshold, defaults.consecutiveThreshold, 1),
    cycleDetectionEnabled: boolOr(cfg.cycleDetectionEnabled, defaults.cycleDetectionEnabled),
    maxCycleLength: intAtLeast(cfg.maxCycleLength, defaults.maxCycleLength, 2),
    cycleRepeatThreshold: intAtLeast(cfg.cycleRepeatThreshold, defaults.cycleRepeatThreshold, 2),
    abortOnTrip: boolOr(cfg.abortOnTrip, defaults.abortOnTrip),
    maxSessions: intAtLeast(cfg.maxSessions, defaults.maxSessions, 1),
    maxFingerprints: intAtLeast(cfg.maxFingerprints, defaults.maxFingerprints, 16),
  };

  if (env.PI_ASTACK_DISABLE_TOOL_CIRCUIT_BREAKER === "1") resolved.enabled = false;
  if (env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED !== undefined) {
    resolved.enabled = parseEnvBool(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED, resolved.enabled);
  }
  resolved.totalThreshold = intAtLeast(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD, resolved.totalThreshold, 1);
  resolved.consecutiveThreshold = intAtLeast(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD, resolved.consecutiveThreshold, 1);
  if (env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED !== undefined) {
    resolved.cycleDetectionEnabled = parseEnvBool(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED, resolved.cycleDetectionEnabled);
  }
  resolved.maxCycleLength = intAtLeast(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_MAX_CYCLE_LENGTH, resolved.maxCycleLength, 2);
  resolved.cycleRepeatThreshold = intAtLeast(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_REPEAT_THRESHOLD, resolved.cycleRepeatThreshold, 2);
  if (env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP !== undefined) {
    resolved.abortOnTrip = parseEnvBool(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP, resolved.abortOnTrip);
  }

  resolved.maxCycleLength = clampInt(
    resolved.maxCycleLength,
    2,
    TOOL_CIRCUIT_BREAKER_LIMITS.maxCycleLength,
  );
  resolved.cycleRepeatThreshold = clampInt(
    resolved.cycleRepeatThreshold,
    2,
    TOOL_CIRCUIT_BREAKER_LIMITS.cycleRepeatThreshold,
  );

  return resolved;
}

export function pruneOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function pruneRecentFingerprints(recentFingerprints: string[], maxCycleLength: number, cycleRepeatThreshold: number): void {
  const maxSize = Math.max(1, maxCycleLength * cycleRepeatThreshold);
  while (recentFingerprints.length > maxSize) recentFingerprints.shift();
}

function detectCycleTail(
  recentFingerprints: string[],
  settings: Pick<ToolCircuitBreakerSettings, "cycleDetectionEnabled" | "maxCycleLength" | "cycleRepeatThreshold">,
): { cycleLength: number; cycleRepeats: number } | null {
  if (!settings.cycleDetectionEnabled) return null;
  if (settings.cycleRepeatThreshold < 2 || settings.maxCycleLength < 2) return null;

  const requiredTail = settings.cycleRepeatThreshold * 2;
  if (recentFingerprints.length < requiredTail) return null;

  const maxCycleLength = Math.min(settings.maxCycleLength, Math.floor(recentFingerprints.length / settings.cycleRepeatThreshold));
  for (let cycleLength = 2; cycleLength <= maxCycleLength; cycleLength++) {
    const cycleRepeats = settings.cycleRepeatThreshold;
    const windowSize = cycleLength * cycleRepeats;
    if (windowSize > recentFingerprints.length) continue;

    const start = recentFingerprints.length - windowSize;
    const pattern = recentFingerprints.slice(start, start + cycleLength);
    if (new Set(pattern).size < 2) continue;

    let matched = true;
    for (let i = cycleLength; i < windowSize; i++) {
      if (recentFingerprints[start + i] !== pattern[i % cycleLength]) {
        matched = false;
        break;
      }
    }

    if (matched) return { cycleLength, cycleRepeats };
  }

  return null;
}

function stableStringify(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value) ?? "null";
  if (t === "bigint") return JSON.stringify(String(value));
  if (t === "function" || t === "symbol") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, seen)).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '"[Circular]"';
    seen.add(obj);
    const keys = Object.keys(obj).sort();
    const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`).join(",");
    seen.delete(obj);
    return `{${body}}`;
  }
  return JSON.stringify(String(value));
}

function fnv1a32(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseEnvBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function intAtLeast(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
