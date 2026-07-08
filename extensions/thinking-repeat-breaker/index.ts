import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { uniqueSessionKey } from "../_shared/session-key";
import {
  buildThinkingRepeatBreakerMessage,
  evaluateThinkingDelta,
  newThinkingRepeatBreakerState,
  resolveThinkingRepeatBreakerSettings,
  type ThinkingRepeatBreakerState,
  type ThinkingRepeatBreakerTrip,
} from "../_shared/thinking-repeat-detector";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-astack-settings.json");
const SETTINGS_ENV_KEYS = [
  "PI_ASTACK_THINKING_REPEAT_BREAKER_ENABLED",
  "PI_ASTACK_DISABLE_THINKING_REPEAT_BREAKER",
  "PI_ASTACK_THINKING_REPEAT_BREAKER_CONSECUTIVE_THRESHOLD",
  "PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_DETECTION_ENABLED",
  "PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_CYCLE_LENGTH",
  "PI_ASTACK_THINKING_REPEAT_BREAKER_CYCLE_REPEAT_THRESHOLD",
  "PI_ASTACK_THINKING_REPEAT_BREAKER_MIN_SEGMENT_CHARS",
  "PI_ASTACK_THINKING_REPEAT_BREAKER_MAX_BUFFER_CHARS",
  "PI_ASTACK_THINKING_REPEAT_BREAKER_ABORT_ON_TRIP",
] as const;
let cachedSettingsKey = "";
let cachedSettings: ReturnType<typeof resolveThinkingRepeatBreakerSettings> | undefined;

function settingsEnvKey(): string {
  return SETTINGS_ENV_KEYS.map((key) => `${key}=${process.env[key] ?? ""}`).join("\0");
}

function readSettings(): ReturnType<typeof resolveThinkingRepeatBreakerSettings> {
  try {
    const stat = statSync(SETTINGS_PATH);
    const key = `${stat.mtimeMs}:${stat.size}:${settingsEnvKey()}`;
    if (cachedSettings && cachedSettingsKey === key) return cachedSettings;
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    cachedSettings = resolveThinkingRepeatBreakerSettings(raw);
    cachedSettingsKey = key;
    return cachedSettings;
  } catch {
    cachedSettings = resolveThinkingRepeatBreakerSettings(undefined);
    cachedSettingsKey = "";
    return cachedSettings;
  }
}

function sessionIdOf(ctx: ExtensionContext): string {
  return uniqueSessionKey(ctx);
}

function tripReason(trip: ThinkingRepeatBreakerTrip, settings: ReturnType<typeof resolveThinkingRepeatBreakerSettings>): string {
  if (trip.reason === "consecutive") {
    return `consecutive repeats ${trip.consecutive} > ${settings.consecutiveThreshold}`;
  }
  if (trip.reason === "cycle") {
    return `cycle repeats ${trip.cycleRepeats ?? settings.cycleRepeatThreshold} rounds with period ${trip.cycleLength ?? "?"}`;
  }
  return "current agent run already tripped";
}

export default function (pi: ExtensionAPI): void {
  const states = new Map<string, ThinkingRepeatBreakerState>();
  let settings = readSettings();

  const reloadSettings = () => {
    settings = readSettings();
  };

  const dropState = (_event: unknown, ctx: ExtensionContext) => {
    reloadSettings();
    states.delete(sessionIdOf(ctx));
  };

  pi.on("session_start", dropState);
  pi.on("agent_start", dropState);
  pi.on("agent_end", dropState);
  pi.on("session_shutdown", dropState);

  pi.on("message_update", (event, ctx) => {
    const assistant = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } } | undefined)?.assistantMessageEvent;
    if (!assistant || assistant.type !== "thinking_delta") return;

    const delta = typeof assistant.delta === "string" ? assistant.delta : "";
    if (!delta) return;

    if (!settings.enabled) return;

    const sessionId = sessionIdOf(ctx);

    let state = states.get(sessionId);
    if (!state) {
      state = newThinkingRepeatBreakerState();
      states.set(sessionId, state);
    }

    const verdict = evaluateThinkingDelta(state, delta, settings);
    if (!verdict.block || verdict.reason === "already_tripped") return;

    const message = buildThinkingRepeatBreakerMessage(verdict, settings);
    const trigger = tripReason(verdict, settings);

    try {
      pi.appendEntry("thinking-repeat-breaker", {
        sessionId,
        trigger,
        reason: verdict.reason,
        fingerprintSummary: verdict.fingerprintSummary,
        segmentStats: verdict.segmentStats,
        consecutive: verdict.consecutive,
        cycleLength: verdict.cycleLength,
        cycleRepeats: verdict.cycleRepeats,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Audit is best-effort.
    }

    if (ctx.hasUI) {
      try {
        ctx.ui.notify(message, "error");
      } catch {
        // Notification is best-effort.
      }
    }

    if (settings.abortOnTrip) {
      setTimeout(() => {
        try {
          ctx.abort();
        } catch {
          // Abort is best-effort.
        }
      }, 0);
    }
  });
}
