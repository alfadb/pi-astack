import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
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

function readSettings(): ReturnType<typeof resolveThinkingRepeatBreakerSettings> {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-astack-settings.json"), "utf-8"));
    return resolveThinkingRepeatBreakerSettings(raw);
  } catch {
    return resolveThinkingRepeatBreakerSettings(undefined);
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
