/**
 * Visible-thinking repeat breaker.
 *
 * Pure per-agent-run accounting for streaming assistant thinking deltas.
 * The runtime extension only feeds visible `thinking_delta.delta` text into
 * this module; final text, text deltas, and encrypted reasoning are ignored.
 */

export interface ThinkingRepeatBreakerSettings {
  enabled: boolean;
  consecutiveThreshold: number;
  cycleDetectionEnabled: boolean;
  maxCycleLength: number;
  cycleRepeatThreshold: number;
  minSegmentChars: number;
  maxBufferChars: number;
  abortOnTrip: boolean;
}

export const THINKING_REPEAT_BREAKER_LIMITS = {
  minSegmentChars: 32,
  minBufferChars: 256,
  maxSegmentChars: 512,
  maxBufferChars: 16384,
  maxCycleLength: 32,
  cycleRepeatThreshold: 20,
} as const;

export const THINKING_REPEAT_BREAKER_DEFAULTS: ThinkingRepeatBreakerSettings = {
  enabled: true,
  consecutiveThreshold: 4,
  cycleDetectionEnabled: true,
  maxCycleLength: 10,
  cycleRepeatThreshold: 5,
  minSegmentChars: 80,
  maxBufferChars: 8192,
  abortOnTrip: true,
};

export interface ThinkingRepeatSegmentStats {
  rawChars: number;
  normalizedChars: number;
  bufferChars: number;
  segmentsSeen: number;
}

export interface ThinkingRepeatBreakerTrip {
  fingerprint: string;
  fingerprintSummary: string;
  consecutive: number;
  segmentStats: ThinkingRepeatSegmentStats;
  reason: "consecutive" | "cycle" | "already_tripped";
  cycleLength?: number;
  cycleRepeats?: number;
}

export interface ThinkingRepeatBreakerState {
  buffer: string;
  lastFingerprint: string | null;
  consecutive: number;
  recentFingerprints: string[];
  segmentsSeen: number;
  tripped?: ThinkingRepeatBreakerTrip;
}

export type ThinkingRepeatBreakerVerdict =
  | ({ block: false; fingerprint?: string; fingerprintSummary?: string; segmentStats?: ThinkingRepeatSegmentStats } & Pick<ThinkingRepeatBreakerTrip, "consecutive">)
  | ({ block: true } & ThinkingRepeatBreakerTrip);

export function newThinkingRepeatBreakerState(): ThinkingRepeatBreakerState {
  return { buffer: "", lastFingerprint: null, consecutive: 0, recentFingerprints: [], segmentsSeen: 0 };
}

export function normalizeThinkingText(input: string): string {
  return String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintThinkingText(input: string): string {
  return fnv1a32(normalizeThinkingText(input));
}

export function summarizeThinkingFingerprint(fingerprint: string, normalizedChars: number): string {
  return `hash:${fingerprint} len:${normalizedChars}`;
}

export function evaluateThinkingDelta(
  state: ThinkingRepeatBreakerState,
  delta: string,
  settings: ThinkingRepeatBreakerSettings = THINKING_REPEAT_BREAKER_DEFAULTS,
): ThinkingRepeatBreakerVerdict {
  state.buffer = capBuffer(state.buffer, settings.maxBufferChars);

  if (state.tripped) {
    return { block: true, ...state.tripped, reason: "already_tripped" };
  }

  const deltaText = typeof delta === "string" ? delta : "";
  let deltaOffset = 0;
  let skipNextLf = false;
  let window = state.buffer;
  let windowOffset = 0;
  let lastVerdict: ThinkingRepeatBreakerVerdict | undefined;

  while (true) {
    const filled = fillWindowFromDelta(window, windowOffset, deltaText, deltaOffset, skipNextLf, settings.maxBufferChars);
    window = filled.window;
    windowOffset = filled.windowOffset;
    deltaOffset = filled.deltaOffset;
    skipNextLf = filled.skipNextLf;

    const next = takeNextSegment(window, windowOffset, settings);
    if (!next) break;

    windowOffset = next.nextOffset;
    const normalized = normalizeThinkingText(next.segment);
    if (!normalized) continue;

    state.segmentsSeen += 1;
    const fingerprint = fingerprintThinkingText(normalized);
    const fingerprintSummary = summarizeThinkingFingerprint(fingerprint, normalized.length);

    if (fingerprint === state.lastFingerprint) {
      state.consecutive += 1;
    } else {
      state.lastFingerprint = fingerprint;
      state.consecutive = 1;
    }

    state.recentFingerprints.push(fingerprint);
    pruneRecentFingerprints(state.recentFingerprints, settings.maxCycleLength, settings.cycleRepeatThreshold);

    const segmentStats: ThinkingRepeatSegmentStats = {
      rawChars: next.segment.length,
      normalizedChars: normalized.length,
      bufferChars: retainedBufferLength(window, windowOffset, settings.maxBufferChars),
      segmentsSeen: state.segmentsSeen,
    };

    const consecutiveTrip = state.consecutive > settings.consecutiveThreshold;
    const cycleTrip = !consecutiveTrip ? detectCycleTail(state.recentFingerprints, settings) : null;

    if (consecutiveTrip || cycleTrip) {
      state.buffer = retainBuffer(window, windowOffset, settings.maxBufferChars);
      segmentStats.bufferChars = state.buffer.length;
      const trip: ThinkingRepeatBreakerTrip = {
        fingerprint,
        fingerprintSummary,
        consecutive: state.consecutive,
        segmentStats,
        reason: consecutiveTrip ? "consecutive" : "cycle",
        ...(cycleTrip ?? {}),
      };
      state.tripped = trip;
      return { block: true, ...trip };
    }

    lastVerdict = { block: false, fingerprint, fingerprintSummary, consecutive: state.consecutive, segmentStats };
  }

  state.buffer = retainBuffer(window, windowOffset, settings.maxBufferChars);
  return lastVerdict ?? { block: false, consecutive: state.consecutive };
}

export function buildThinkingRepeatBreakerMessage(
  trip: ThinkingRepeatBreakerTrip,
  settings: ThinkingRepeatBreakerSettings = THINKING_REPEAT_BREAKER_DEFAULTS,
): string {
  const trigger = trip.reason === "consecutive"
    ? `consecutive repeats ${trip.consecutive} > ${settings.consecutiveThreshold}`
    : trip.reason === "cycle"
      ? `cycle repeats ${trip.cycleRepeats ?? settings.cycleRepeatThreshold} rounds with period ${trip.cycleLength ?? "?"}`
      : "current agent run already tripped";

  return [
    "Thinking-repeat breaker tripped.",
    `Fingerprint: ${trip.fingerprintSummary}`,
    `Segment stats: raw=${trip.segmentStats.rawChars}, normalized=${trip.segmentStats.normalizedChars}, buffer=${trip.segmentStats.bufferChars}, segments=${trip.segmentStats.segmentsSeen}`,
    trip.reason === "cycle" && trip.cycleLength !== undefined && trip.cycleRepeats !== undefined
      ? `Cycle: length=${trip.cycleLength}, repeats=${trip.cycleRepeats}`
      : undefined,
    `Trigger: ${trigger}`,
    trip.reason === "cycle"
      ? "This current agent run is being stopped because visible thinking deltas repeated the same tail pattern of segments."
      : "This current agent run is being stopped because visible thinking deltas repeated the same normalized segment too many times in a row.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function resolveThinkingRepeatBreakerSettings(
  rawSettings: unknown,
  env: Record<string, string | undefined> = process.env,
): ThinkingRepeatBreakerSettings {
  const root = asRecord(rawSettings);
  const cfg = asRecord(root.thinkingRepeatBreaker);
  const defaults = THINKING_REPEAT_BREAKER_DEFAULTS;

  const resolved: ThinkingRepeatBreakerSettings = {
    enabled: boolOr(cfg.enabled, defaults.enabled),
    consecutiveThreshold: intAtLeast(cfg.consecutiveThreshold, defaults.consecutiveThreshold, 1),
    cycleDetectionEnabled: boolOr(cfg.cycleDetectionEnabled, defaults.cycleDetectionEnabled),
    maxCycleLength: intAtLeast(cfg.maxCycleLength, defaults.maxCycleLength, 2),
    cycleRepeatThreshold: intAtLeast(cfg.cycleRepeatThreshold, defaults.cycleRepeatThreshold, 2),
    minSegmentChars: intAtLeast(cfg.minSegmentChars, defaults.minSegmentChars, THINKING_REPEAT_BREAKER_LIMITS.minSegmentChars),
    maxBufferChars: intAtLeast(cfg.maxBufferChars, defaults.maxBufferChars, THINKING_REPEAT_BREAKER_LIMITS.minBufferChars),
    abortOnTrip: boolOr(cfg.abortOnTrip, defaults.abortOnTrip),
  };

  if (env.PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED !== undefined) {
    resolved.enabled = parseEnvBool(env.PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED, resolved.enabled);
  }
  if (env.PI_ASTACK_DISABLE_THINKING_REPEAT_BREAKER === "1") resolved.enabled = false;

  resolved.consecutiveThreshold = intAtLeast(
    env.PI_ASTACK_THINKING_REPEAT_BREAKER_CONSECUTIVE_THRESHOLD,
    resolved.consecutiveThreshold,
    1,
  );
  if (env.PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED !== undefined) {
    resolved.cycleDetectionEnabled = parseEnvBool(env.PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED, resolved.cycleDetectionEnabled);
  }
  resolved.maxCycleLength = intAtLeast(
    env.PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_CYCLE_LENGTH,
    resolved.maxCycleLength,
    2,
  );
  resolved.cycleRepeatThreshold = intAtLeast(
    env.PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_REPEAT_THRESHOLD,
    resolved.cycleRepeatThreshold,
    2,
  );
  resolved.minSegmentChars = intAtLeast(
    env.PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS,
    resolved.minSegmentChars,
    THINKING_REPEAT_BREAKER_LIMITS.minSegmentChars,
  );
  resolved.maxBufferChars = intAtLeast(
    env.PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_BUFFER_CHARS,
    resolved.maxBufferChars,
    THINKING_REPEAT_BREAKER_LIMITS.minBufferChars,
  );
  if (env.PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP !== undefined) {
    resolved.abortOnTrip = parseEnvBool(env.PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP, resolved.abortOnTrip);
  }

  resolved.maxCycleLength = clampInt(resolved.maxCycleLength, 2, THINKING_REPEAT_BREAKER_LIMITS.maxCycleLength);
  resolved.cycleRepeatThreshold = clampInt(resolved.cycleRepeatThreshold, 2, THINKING_REPEAT_BREAKER_LIMITS.cycleRepeatThreshold);
  resolved.minSegmentChars = clampInt(
    resolved.minSegmentChars,
    THINKING_REPEAT_BREAKER_LIMITS.minSegmentChars,
    THINKING_REPEAT_BREAKER_LIMITS.maxSegmentChars,
  );
  resolved.maxBufferChars = clampInt(
    resolved.maxBufferChars,
    Math.max(THINKING_REPEAT_BREAKER_LIMITS.minBufferChars, resolved.minSegmentChars),
    THINKING_REPEAT_BREAKER_LIMITS.maxBufferChars,
  );

  return resolved;
}

function takeNextSegment(
  buffer: string,
  offset: number,
  settings: Pick<ThinkingRepeatBreakerSettings, "minSegmentChars" | "maxBufferChars">,
): { segment: string; nextOffset: number } | null {
  const available = buffer.length - offset;
  if (available < settings.minSegmentChars) return null;

  const limit = offset + Math.min(available, settings.maxBufferChars);
  const searchStart = offset + settings.minSegmentChars;
  const paragraphIndex = buffer.indexOf("\n\n", searchStart);
  if (paragraphIndex >= 0 && paragraphIndex + 2 <= limit) {
    const cut = paragraphIndex + 2;
    return { segment: buffer.slice(offset, cut), nextOffset: cut };
  }

  const newlineIndex = buffer.indexOf("\n", searchStart);
  if (newlineIndex >= 0 && newlineIndex < limit) {
    const cut = newlineIndex + 1;
    return { segment: buffer.slice(offset, cut), nextOffset: cut };
  }

  const cut = offset + settings.minSegmentChars;
  return { segment: buffer.slice(offset, cut), nextOffset: cut };
}

function fillWindowFromDelta(
  window: string,
  windowOffset: number,
  delta: string,
  deltaOffset: number,
  skipNextLf: boolean,
  maxBufferChars: number,
): { window: string; windowOffset: number; deltaOffset: number; skipNextLf: boolean } {
  if (windowOffset > 0 && (windowOffset >= 4096 || windowOffset * 2 >= window.length)) {
    window = window.slice(windowOffset);
    windowOffset = 0;
  }

  const room = maxBufferChars - (window.length - windowOffset);
  if (room <= 0 || deltaOffset >= delta.length) {
    return { window, windowOffset, deltaOffset, skipNextLf };
  }

  let appended = "";
  while (appended.length < room && deltaOffset < delta.length) {
    const ch = delta[deltaOffset++];
    if (skipNextLf) {
      skipNextLf = false;
      if (ch === "\n") continue;
    }
    if (ch === "\r") {
      appended += "\n";
      skipNextLf = true;
    } else {
      appended += ch;
    }
  }

  return { window: window + appended, windowOffset, deltaOffset, skipNextLf };
}

function retainedBufferLength(buffer: string, offset: number, maxBufferChars: number): number {
  return Math.min(Math.max(0, buffer.length - offset), normalizedBufferLimit(maxBufferChars));
}

function retainBuffer(buffer: string, offset: number, maxBufferChars: number): string {
  return capBuffer(buffer.slice(offset), maxBufferChars);
}

function capBuffer(buffer: string, maxBufferChars: number): string {
  const limit = normalizedBufferLimit(maxBufferChars);
  if (limit === 0) return "";
  return buffer.length <= limit ? buffer : buffer.slice(-limit);
}

function normalizedBufferLimit(maxBufferChars: number): number {
  return Math.max(0, Math.floor(maxBufferChars));
}

function detectCycleTail(
  recentFingerprints: string[],
  settings: Pick<ThinkingRepeatBreakerSettings, "cycleDetectionEnabled" | "maxCycleLength" | "cycleRepeatThreshold">,
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

function pruneRecentFingerprints(recentFingerprints: string[], maxCycleLength: number, cycleRepeatThreshold: number): void {
  const maxSize = Math.max(1, maxCycleLength * cycleRepeatThreshold);
  while (recentFingerprints.length > maxSize) recentFingerprints.shift();
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
