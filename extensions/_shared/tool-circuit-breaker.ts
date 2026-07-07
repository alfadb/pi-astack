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
  /** Ask pi to abort the active agent after returning the blocking tool error. */
  abortOnTrip: boolean;
  /** Bound per-process memory for old agent runs. */
  maxSessions: number;
  /** Bound per-agent-run memory for unique fingerprints. */
  maxFingerprints: number;
}

export const TOOL_CIRCUIT_BREAKER_DEFAULTS: ToolCircuitBreakerSettings = {
  enabled: true,
  totalThreshold: 8,
  consecutiveThreshold: 4,
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
  reason: "consecutive" | "already_tripped";
}

export interface ToolCircuitBreakerState {
  lastFingerprint: string | null;
  consecutive: number;
  counts: Map<string, ToolFingerprintStats>;
  tripped?: ToolCircuitBreakerTrip;
}

export type ToolCircuitBreakerVerdict =
  | { block: false; toolName: string; fingerprint: string; fingerprintSummary: string; total: number; consecutive: number }
  | ({ block: true } & ToolCircuitBreakerTrip);

export function newToolCircuitBreakerState(): ToolCircuitBreakerState {
  return { lastFingerprint: null, consecutive: 0, counts: new Map() };
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

  const prior = state.counts.get(fingerprint)?.total ?? 0;
  const total = prior + 1;
  state.counts.set(fingerprint, { total });
  pruneOldest(state.counts, settings.maxFingerprints);

  const reason = state.consecutive > settings.consecutiveThreshold ? "consecutive" : undefined;

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
    : "current agent run already tripped";

  return [
    "Tool-call circuit breaker tripped.",
    `Tool: ${trip.toolName}`,
    `Fingerprint: ${trip.fingerprintSummary}`,
    `Counts: total=${trip.total}, consecutive=${trip.consecutive}`,
    `Trigger: ${trigger}`,
    "This current agent run is being stopped because it repeatedly requested the exact same tool call with the same normalized arguments. Do not retry the same call; inspect the previous result or change approach.",
  ].join("\n");
}

export function resolveToolCircuitBreakerSettings(
  rawSettings: unknown,
  env: Record<string, string | undefined> = process.env,
): ToolCircuitBreakerSettings {
  const root = asRecord(rawSettings);
  const cfg = asRecord(root.toolCircuitBreaker);
  const legacyDispatch = asRecord(root.dispatch);
  const legacyIdleLoop = asRecord(legacyDispatch.idleLoopGuard);

  const hasNewConfig = Object.keys(cfg).length > 0;
  const defaults = TOOL_CIRCUIT_BREAKER_DEFAULTS;

  let enabled = boolOr(cfg.enabled, defaults.enabled);
  if (!hasNewConfig && typeof legacyIdleLoop.enabled === "boolean" && legacyIdleLoop.enabled === false) {
    enabled = false;
  }

  const resolved: ToolCircuitBreakerSettings = {
    enabled,
    totalThreshold: intAtLeast(cfg.totalThreshold, defaults.totalThreshold, 1),
    consecutiveThreshold: intAtLeast(cfg.consecutiveThreshold, defaults.consecutiveThreshold, 1),
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
  if (env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP !== undefined) {
    resolved.abortOnTrip = parseEnvBool(env.PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP, resolved.abortOnTrip);
  }

  return resolved;
}

export function pruneOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
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
