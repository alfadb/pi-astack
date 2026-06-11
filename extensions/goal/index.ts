/**
 * goal extension — PR-6 / P1a (impl-plan 2026-06-10 Phase P1).
 *
 * Scope of THIS PR: state + /goal commands + per-turn injection. NO
 * auto-continue — `agent_end` is deliberately not subscribed; the
 * continuation judge, budget pre-decrement re-entrancy guard, and the
 * `[pi-goal-continuation goal_id=...]` provenance isolation all land in
 * PR-7 behind `goal.autoContinue` (default off).
 *
 * Behavior:
 *   - /goal set <objective> [--criteria="a;b"] [--max-continuations=N]
 *     [--max-minutes=M] — C4' authorization: only the USER creates goals.
 *     /goal pause | resume | clear | status manage the lifecycle.
 *   - Every transition appends a `pi-goal-event` custom entry (event
 *     source, forks with the session tree) AND rewrites the materialized
 *     view `.pi-astack/goal/<sessionId>.json`.
 *   - before_agent_start injects the ACTIVE goal at the system-prompt
 *     tail (time-injector pattern: end-append for prompt-cache safety,
 *     marker dedupe) — this is the anti-compaction-drift mechanism.
 *   - session_start reconciles the view from events (fork/resume drift)
 *     and GCs stale view files by mtime.
 *
 * Kill switch: settings `goal.enabled` (default true — inert until the
 * user sets a goal, so default-on adds zero behavior on its own).
 */

import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentAnchor } from "../_shared/causal-anchor";
import { isSubAgentSession } from "../_shared/pi-internals";
import { runAutoContinueOnce } from "./continue";
import { packGoalJudgeWindow, runGoalJudge } from "./judge";
import {
  appendGoalOutcome,
  applyGoalAction,
  formatGoalBlock,
  formatGoalStatus,
  gcStaleGoalFiles,
  GOAL_EVENT_TYPE,
  loadGoalFile,
  newGoalState,
  parseGoalArgs,
  removeGoalFile,
  replayGoalEvents,
  saveGoalFile,
  stripGoalBlock,
  type GoalState,
} from "./state";

// ── settings ───────────────────────────────────────────────────────────

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

interface GoalSettings {
  enabled: boolean;
  gcMaxAgeDays: number;
  defaultMaxContinuations: number;
  defaultMaxWallMinutes: number;
  /** PR-7 kill switch — default OFF: the continuation loop only runs when
   *  the user has BOTH set a goal (C4') and opted into auto-continue. */
  autoContinue: boolean;
  judgeModel: string;
  judgeTimeoutMs: number;
}

const DEFAULTS: GoalSettings = {
  enabled: true,
  gcMaxAgeDays: 14,
  defaultMaxContinuations: 10,
  defaultMaxWallMinutes: 120,
  autoContinue: false,
  // No model hardcoded in code: pi-astack-settings.json is the single source
  // of truth. Empty default → fail-closed at goal judge.
  judgeModel: "",
  judgeTimeoutMs: 45_000,
};

function resolveGoalSettings(): GoalSettings {
  let cfg: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    if (raw && typeof raw.goal === "object" && raw.goal !== null) cfg = raw.goal as Record<string, unknown>;
  } catch { /* missing/unparseable settings → defaults */ }
  const num = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fb;
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    gcMaxAgeDays: num(cfg.gcMaxAgeDays, DEFAULTS.gcMaxAgeDays, 1, 365),
    defaultMaxContinuations: num(cfg.defaultMaxContinuations, DEFAULTS.defaultMaxContinuations, 0, 100),
    defaultMaxWallMinutes: num(cfg.defaultMaxWallMinutes, DEFAULTS.defaultMaxWallMinutes, 1, 24 * 60),
    autoContinue: typeof cfg.autoContinue === "boolean" ? cfg.autoContinue : DEFAULTS.autoContinue,
    judgeModel: typeof cfg.judgeModel === "string" && cfg.judgeModel.trim() ? cfg.judgeModel.trim() : DEFAULTS.judgeModel,
    judgeTimeoutMs: num(cfg.judgeTimeoutMs, DEFAULTS.judgeTimeoutMs, 5_000, 300_000),
  };
}

/** Compact textual form of the C6 causal anchor for the goal record. */
function anchorTag(a: { session_id: string; turn_id: number; subturn?: number } | undefined): string | undefined {
  if (!a) return undefined;
  return `${a.session_id}:${a.turn_id}${a.subturn !== undefined ? `.${a.subturn}` : ""}`;
}

// ── session helpers ────────────────────────────────────────────────────

/** Mirror of sediment's readSessionId: id only counts when the session is
 *  PERSISTED (getSessionFile truthy) — ephemeral (-p/print) sessions have
 *  no event log to reconcile against, so goal state would be write-only. */
function readSessionId(sm: unknown): string | undefined {
  const m = sm as { getSessionId?(): string | undefined | null; getSessionFile?(): string | undefined | null } | undefined;
  if (!m || typeof m.getSessionId !== "function") return undefined;
  try {
    if (typeof m.getSessionFile === "function" && !m.getSessionFile()) return undefined;
    const id = m.getSessionId();
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

// ── extension entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_GOAL === "1") return;

  /** Returns false when the event could not be appended — the caller
   *  surfaces that (gpt R2 ②: a silent append failure breaks the
   *  events≥view invariant; the reconcile pass would then converge the
   *  view back to event truth, i.e. drop the transition on next start). */
  const appendGoalEvent = (action: string, state: GoalState): boolean => {
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void })
        .appendEntry?.(GOAL_EVENT_TYPE, { action, state });
      return true;
    } catch {
      return false;
    }
  };

  pi.registerCommand("goal", {
    description:
      "Session goal: /goal set <objective> [--criteria=\"a;b\"] [--max-continuations=N] [--max-minutes=M] | pause | resume | clear | status. Active goal is re-injected every turn (compaction-drift guard). Auto-continue ships separately behind goal.autoContinue.",
    getArgumentCompletions(prefix: string) {
      const items = ["set ", "pause", "resume", "clear", "status"];
      const filtered = items.filter((i) => i.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      const settings = resolveGoalSettings();
      const notify = (msg: string, type?: string) => ctx.ui.notify(msg, type as never);
      if (!settings.enabled) {
        notify("goal extension disabled (settings goal.enabled=false)", "warning");
        return;
      }
      const cwd = ctx.cwd ?? process.cwd();
      const sessionId = readSessionId(ctx.sessionManager);
      if (!sessionId) {
        notify("/goal requires a persisted session (ephemeral session has no event log)", "warning");
        return;
      }
      const parsed = parseGoalArgs(args);
      if (parsed.sub === "error") {
        notify(`/goal: ${parsed.error}`, "warning");
        return;
      }
      const current = loadGoalFile(cwd, sessionId);
      if (parsed.sub === "status") {
        notify(formatGoalStatus(current), "info");
        return;
      }
      if (parsed.sub === "set") {
        const state = newGoalState({
          sessionId,
          objective: parsed.objective,
          successCriteria: parsed.criteria,
          maxContinuations: parsed.maxContinuations ?? settings.defaultMaxContinuations,
          maxWallMinutes: parsed.maxMinutes ?? settings.defaultMaxWallMinutes,
          anchor: anchorTag(getCurrentAnchor()),
        });
        // Event BEFORE view (opus R1 N1): events are the source of truth;
        // writing the derived view first opens a crash window where an OLDER
        // event replays over a NEWER view at the next reconcile.
        const eventOk = appendGoalEvent("set", state);
        const saved = await saveGoalFile(cwd, state);
        const replaced = current && (current.status === "active" || current.status === "paused")
          ? ` (replaced previous: ${current.objective.slice(0, 60)})` : "";
        if (!eventOk) notify("goal event log append FAILED — this goal may not survive session fork/resume reconcile", "warning");
        notify(saved
          ? `🎯 goal set: ${state.objective}${replaced} — injected every turn; /goal status to inspect`
          : "goal event recorded but view file write FAILED (injection may lag until next transition)", saved ? "info" : "warning");
        return;
      }
      // pause / resume / clear
      const res = applyGoalAction(current, parsed.sub);
      if (!res.ok) {
        notify(`/goal ${parsed.sub}: ${res.error}`, "warning");
        return;
      }
      const evOk = appendGoalEvent(parsed.sub, res.state); // event-first (opus R1 N1)
      if (!evOk) notify("goal event log append FAILED — transition may not survive fork/resume reconcile", "warning");
      await saveGoalFile(cwd, res.state);
      // R4' (PR-7; closes opus PR-6 N4): user abandonment is a terminal
      // outcome — ledger it like achieved/blocked so the goal loop's
      // results stay observable.
      if (parsed.sub === "clear") {
        appendGoalOutcome(cwd, {
          type: "goal_outcome", goal_id: res.state.goal_id, session_id: sessionId,
          outcome: "abandoned", objective: res.state.objective.slice(0, 200),
          continuations_used: res.state.counters.continuations_used, ts: new Date().toISOString(),
        });
      }
      const verb = parsed.sub === "clear" ? "abandoned" : res.state.status;
      notify(`goal ${verb}: ${res.state.objective.slice(0, 80)}`, "info");
      // opus R1 N3 UX: resuming a goal whose wall clock is already exhausted
      // will immediately re-pause at the next agent_end — say so up front.
      if (parsed.sub === "resume") {
        const elapsedMin = (Date.now() - Date.parse(res.state.created)) / 60_000;
        if (Number.isFinite(elapsedMin) && elapsedMin > res.state.budget.max_wall_minutes) {
          notify(`⚠️ wall clock already exhausted (${Math.floor(elapsedMin)}min > ${res.state.budget.max_wall_minutes}min) — auto-continue will re-pause; use a fresh /goal set --max-minutes=N to reset`, "warning");
        }
      }
    },
  });

  // R4' note (opus R1 N4, explicit deferral): the goal_outcome injection-
  // ledger row for achieved/blocked/abandoned ships with PR-7 — the
  // anti-write-only-loop concern only bites once auto-continue makes the
  // goal interact with sediment; PR-6's injection is system-prompt-only
  // and stripped on clear.

  // Per-turn injection of the ACTIVE goal (anti-compaction-drift).
  pi.on("before_agent_start", async (event, ctx) => {
    const settings = resolveGoalSettings();
    if (!settings.enabled) return;
    // Sub-agents get their task brief from the dispatch prompt; injecting
    // the PARENT session's goal there would shadow the sub-task framing
    // (same reasoning as abrain/rule-injector, opposite of time-injector).
    if (isSubAgentSession(ctx as never)) return;
    const sessionId = readSessionId(ctx.sessionManager);
    if (!sessionId) return;
    const state = loadGoalFile(ctx.cwd ?? process.cwd(), sessionId);
    if (!state || state.status !== "active") {
      // Stale-block hygiene: a goal that just got cleared must not keep
      // riding a previously injected block.
      const cleaned = stripGoalBlock((event as { systemPrompt?: string }).systemPrompt ?? "");
      return { systemPrompt: cleaned };
    }
    const current = (event as { systemPrompt?: string }).systemPrompt ?? "";
    const block = formatGoalBlock(state);
    const next = `${stripGoalBlock(current).replace(/\n+$/, "")}\n\n${block}\n`;
    return { systemPrompt: next };
  });

  // ── PR-7 auto-continue (goal.autoContinue, default OFF) ──
  // Re-entrancy shape: the continuation turn re-enters agent_end by
  // design; the loop is bounded because the budget counter is
  // PRE-DECREMENTED and persisted before each send (continue.ts). The
  // in-flight set guards against overlapping agent_end emissions only.
  const autoContinueInFlight = new Set<string>();
  pi.on("agent_end", async (_event, ctx) => {
    const settings = resolveGoalSettings();
    if (!settings.enabled || !settings.autoContinue) return;
    if (isSubAgentSession(ctx as never)) return;
    const cwd = ctx.cwd ?? process.cwd();
    const sessionId = readSessionId(ctx.sessionManager);
    if (!sessionId) return;
    const state = loadGoalFile(cwd, sessionId);
    if (!state || state.status !== "active") return;
    if (autoContinueInFlight.has(sessionId)) return;
    autoContinueInFlight.add(sessionId);
    try {
      const branch = (ctx.sessionManager as unknown as { getBranch?(): unknown[] })?.getBranch?.() ?? [];
      await runAutoContinueOnce({
        state,
        judge: () => runGoalJudge(
          {
            objective: state.objective,
            successCriteria: state.success_criteria,
            recentTranscript: packGoalJudgeWindow(branch),
            continuationsUsed: state.counters.continuations_used,
            maxContinuations: state.budget.max_continuations,
          },
          { judgeModel: settings.judgeModel, judgeTimeoutMs: settings.judgeTimeoutMs, modelRegistry: ctx.modelRegistry },
        ),
        sendContinuation: (message) => {
          // §P1 hard-constraint 2b (gpt R1): DEDICATED event-layer ledger —
          // a typed custom entry recording the SEND INTENT before dispatch,
          // so the injected user message can be cross-checked against this
          // trace (sendUserMessage is fire-and-forget; transport failures
          // are invisible to us — budget already pre-spent, conservative
          // direction, and this ledger row marks the intent either way).
          try {
            (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("pi-goal-continuation", {
              goal_id: state.goal_id,
              session_id: sessionId,
              continuations_used: state.counters.continuations_used + 1,
              message_hash: createHash("sha256").update(message, "utf-8").digest("hex").slice(0, 12),
              ts: new Date().toISOString(),
            });
          } catch { /* ledger is best-effort */ }
          // deliverAs:"followUp" per the runtime contract (official examples
          // git-merge-and-resolve.ts / reload-runtime.ts both use it from
          // event handlers): queued if anything is still executing, delivered
          // immediately when idle. Never bare-call from agent_end.
          (pi as unknown as { sendUserMessage(content: string, opts?: { deliverAs?: string }): void })
            .sendUserMessage(message, { deliverAs: "followUp" });
        },
        notify: (msg, type) => { try { ctx.ui?.notify?.(msg, type as never); } catch { /* ui may be absent in print mode */ } },
        appendEvent: appendGoalEvent,
        saveState: (s) => saveGoalFile(cwd, s),
        appendOutcome: (row) => { appendGoalOutcome(cwd, row as unknown as Record<string, unknown>); },
      });
    } catch { /* auto-continue is best-effort bg work; never break agent_end */ }
    finally {
      autoContinueInFlight.delete(sessionId);
    }
  });

  // Fork/resume reconcile (events win) + stale view GC.
  pi.on("session_start", async (_event, ctx) => {
    const settings = resolveGoalSettings();
    if (!settings.enabled) return;
    const cwd = ctx.cwd ?? process.cwd();
    const sessionId = readSessionId(ctx.sessionManager);
    if (sessionId) {
      try {
        // gpt R1 BLOCKING fix: replay from getBranch() (root→current-leaf
        // path), NOT getEntries() — the latter is the FULL session tree, so
        // after a /tree branch switch an abandoned branch's later goal
        // events (clear/set) would win the last-write replay and overwrite
        // this branch's state. No getBranch → SKIP reconcile (fail-safe:
        // the view file stays; never reconcile against tree-wide events).
        const sm = ctx.sessionManager as unknown as { getBranch?(): unknown[] };
        const branch = typeof sm?.getBranch === "function" ? sm.getBranch() : null;
        if (branch) {
          const fromEvents = replayGoalEvents(branch);
          if (fromEvents) {
            // Events win unconditionally (event-first write ordering makes
            // events ≥ view; unconditional save avoids the key-order-fragile
            // JSON.stringify equality — opus R1 N3 / gpt R1 N5). session_id
            // is re-stamped so a fork (new id, inherited branch events)
            // lands its OWN view file instead of mutating the parent's.
            await saveGoalFile(cwd, { ...fromEvents, session_id: sessionId } as GoalState);
          } else {
            // gpt R2 residual fix: the current branch carries NO goal events
            // (e.g. /tree switched to a pre-goal branch point, or the event
            // append failed) → any view file for this session is stale by
            // the events-as-truth invariant. Remove it so before_agent_start
            // stops injecting an abandoned branch's goal.
            await removeGoalFile(cwd, sessionId);
          }
        }
      } catch { /* reconcile is best-effort */ }
    }
    void gcStaleGoalFiles(cwd, { keepSessionId: sessionId, maxAgeDays: settings.gcMaxAgeDays }).catch(() => 0);
  });
}
