import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { uniqueSessionKey } from "../_shared/session-key";
import {
  buildToolCircuitBreakerMessage,
  evaluateToolCircuitBreaker,
  newToolCircuitBreakerState,
  resolveToolCircuitBreakerSettings,
  type ToolCircuitBreakerState,
  type ToolCircuitBreakerTrip,
} from "../_shared/tool-circuit-breaker";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-astack-settings.json");
const SETTINGS_ENV_KEYS = [
  "PI_ASTACK_DISABLE_TOOL_CIRCUIT_BREAKER",
  "PI_ASTACK_TOOL_CIRCUIT_BREAKER_ENABLED",
  "PI_ASTACK_TOOL_CIRCUIT_BREAKER_TOTAL_THRESHOLD",
  "PI_ASTACK_TOOL_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD",
  "PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_DETECTION_ENABLED",
  "PI_ASTACK_TOOL_CIRCUIT_BREAKER_MAX_CYCLE_LENGTH",
  "PI_ASTACK_TOOL_CIRCUIT_BREAKER_CYCLE_REPEAT_THRESHOLD",
  "PI_ASTACK_TOOL_CIRCUIT_BREAKER_ABORT_ON_TRIP",
] as const;
let cachedSettingsKey = "";
let cachedSettings: ReturnType<typeof resolveToolCircuitBreakerSettings> | undefined;

function settingsEnvKey(): string {
  return SETTINGS_ENV_KEYS.map((key) => `${key}=${process.env[key] ?? ""}`).join("\0");
}

function readSettings(): ReturnType<typeof resolveToolCircuitBreakerSettings> {
  try {
    const stat = statSync(SETTINGS_PATH);
    const key = `${stat.mtimeMs}:${stat.size}:${settingsEnvKey()}`;
    if (cachedSettings && cachedSettingsKey === key) return cachedSettings;
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    cachedSettings = resolveToolCircuitBreakerSettings(raw);
    cachedSettingsKey = key;
    return cachedSettings;
  } catch {
    cachedSettings = resolveToolCircuitBreakerSettings(undefined);
    cachedSettingsKey = "";
    return cachedSettings;
  }
}

function sessionIdOf(ctx: ExtensionContext): string {
  return uniqueSessionKey(ctx);
}

function logTrip(sessionId: string, trip: ToolCircuitBreakerTrip): void {
  try {
    console.warn(
      `[pi-astack/tool-circuit-breaker] session=${sessionId} tool=${trip.toolName} ` +
      `fingerprint=${trip.fingerprintSummary} total=${trip.total} consecutive=${trip.consecutive} ` +
      `reason=${trip.reason}` +
      (trip.reason === "cycle" && trip.cycleLength && trip.cycleRepeats
        ? ` cycleLength=${trip.cycleLength} cycleRepeats=${trip.cycleRepeats}`
        : ""),
    );
  } catch {
    // Diagnostics only.
  }
}

function pruneInactiveSessions(states: Map<string, ToolCircuitBreakerState>, activeSessionId: string, maxSessions: number): void {
  for (const sessionId of states.keys()) {
    if (states.size <= maxSessions) return;
    if (sessionId !== activeSessionId) states.delete(sessionId);
  }
}

export default function (pi: ExtensionAPI) {
  const states = new Map<string, ToolCircuitBreakerState>();

  const dropSession = (_event: unknown, ctx: ExtensionContext) => {
    states.delete(sessionIdOf(ctx));
  };

  pi.on("session_start", dropSession);
  pi.on("agent_start", dropSession);
  pi.on("agent_end", dropSession);
  pi.on("session_shutdown", dropSession);

  pi.on("tool_call", (event, ctx) => {
    const settings = readSettings();
    if (!settings.enabled) return undefined;

    const sessionId = sessionIdOf(ctx);
    pruneInactiveSessions(states, sessionId, settings.maxSessions);

    let state = states.get(sessionId);
    if (!state) {
      state = newToolCircuitBreakerState();
      states.set(sessionId, state);
    }

    const verdict = evaluateToolCircuitBreaker(state, String(event.toolName), event.input, settings);
    if (!verdict.block) return undefined;

    const message = buildToolCircuitBreakerMessage(verdict, settings);

    try {
      pi.appendEntry("tool-circuit-breaker", {
        sessionId,
        toolName: verdict.toolName,
        fingerprintSummary: verdict.fingerprintSummary,
        total: verdict.total,
        consecutive: verdict.consecutive,
        cycleLength: verdict.cycleLength,
        cycleRepeats: verdict.cycleRepeats,
        trigger: verdict.reason,
        thresholds: {
          consecutive: settings.consecutiveThreshold,
          cycleRepeat: settings.cycleRepeatThreshold,
          maxCycleLength: settings.maxCycleLength,
        },
        deprecatedTotalThreshold: settings.totalThreshold,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Session audit is best-effort; the blocking tool result remains authoritative.
    }

    logTrip(sessionId, verdict);

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
          // Abort is best-effort; the hook still blocks this tool call.
        }
      }, 0);
    }

    return { block: true, reason: message };
  });
}
