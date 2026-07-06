import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildToolCircuitBreakerMessage,
  evaluateToolCircuitBreaker,
  newToolCircuitBreakerState,
  resolveToolCircuitBreakerSettings,
  type ToolCircuitBreakerState,
  type ToolCircuitBreakerTrip,
} from "../_shared/tool-circuit-breaker";

function readSettings(): ReturnType<typeof resolveToolCircuitBreakerSettings> {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-astack-settings.json"), "utf-8"));
    return resolveToolCircuitBreakerSettings(raw);
  } catch {
    return resolveToolCircuitBreakerSettings(undefined);
  }
}

function sessionIdOf(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager as unknown as {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  try {
    return String(sm.getSessionId?.() ?? sm.getSessionFile?.() ?? "ephemeral");
  } catch {
    return "ephemeral";
  }
}

function logTrip(sessionId: string, trip: ToolCircuitBreakerTrip): void {
  try {
    console.warn(
      `[pi-astack/tool-circuit-breaker] session=${sessionId} tool=${trip.toolName} ` +
      `fingerprint=${trip.fingerprintSummary} total=${trip.total} consecutive=${trip.consecutive} ` +
      `reason=${trip.reason}`,
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
        trigger: verdict.reason,
        thresholds: {
          total: settings.totalThreshold,
          consecutive: settings.consecutiveThreshold,
        },
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
