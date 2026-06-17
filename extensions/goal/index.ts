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
import { isGoalContinuationText } from "../_shared/goal-continuation";
import { isSubAgentSession } from "../_shared/pi-internals";
import { wrapVolatile } from "../_shared/volatile-suffix";
import { Type } from "typebox";
import { runAutoContinueOnce } from "./continue";
import { packGoalJudgeWindow, runGoalJudge } from "./judge";
import {
  appendGoalOutcome,
  applyGoalAction,
  formatGoalBlock,
  formatGoalStatus,
  getGoalSource,
  gcStaleGoalFiles,
  GOAL_EVENT_TYPE,
  loadGoalFile,
  newDocGoalState,
  newGoalState,
  parseGoalArgs,
  readGoalDoc,
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
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "").join("");
  return "";
}

export function isCurrentTurnGoalContinuation(sm: unknown): boolean {
  try {
    const branch = (sm as { getBranch?(): unknown[] })?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
      if (e?.type === "message" && e.message?.role === "user") return isGoalContinuationText(extractMessageText(e.message.content));
    }
    return true; // fail-closed for goal_set/resume authority creation
  } catch {
    return true;
  }
}

function wrapText(text: string, details: unknown, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

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

  const setGoal = async (args: { objective?: string; doc?: string; criteria?: string[]; maxContinuations?: number; maxMinutes?: number }, ctx: any) => {
    const settings = resolveGoalSettings();
    if (!settings.enabled) return { ok: false as const, error: "goal extension disabled", details: { kind: "goal_disabled" } };
    const cwd = ctx.cwd ?? process.cwd();
    const sessionId = readSessionId(ctx.sessionManager);
    if (!sessionId) return { ok: false as const, error: "goal requires a persisted session", details: { kind: "no_persisted_session" } };
    if (isCurrentTurnGoalContinuation(ctx.sessionManager)) return { ok: false as const, error: "goal_set rejected in goal-continuation machine turn", details: { kind: "machine_turn_rejected" } };
    if (args.doc && args.objective) return { ok: false as const, error: "goal_set accepts either objective or doc, not both", details: { kind: "invalid_args" } };
    const current = loadGoalFile(cwd, sessionId);
    let state: GoalState;
    if (args.doc) {
      const res = newDocGoalState({
        sessionId, cwd, doc: args.doc, successCriteria: args.criteria ?? [],
        maxContinuations: args.maxContinuations ?? settings.defaultMaxContinuations,
        maxWallMinutes: args.maxMinutes ?? settings.defaultMaxWallMinutes,
        anchor: anchorTag(getCurrentAnchor()),
      });
      if (!res.ok) return { ok: false as const, error: res.error, details: { kind: "doc_unreadable", doc: args.doc } };
      state = res.state;
    } else if (args.objective) {
      state = newGoalState({
        sessionId, objective: args.objective, successCriteria: args.criteria ?? [],
        maxContinuations: args.maxContinuations ?? settings.defaultMaxContinuations,
        maxWallMinutes: args.maxMinutes ?? settings.defaultMaxWallMinutes,
        anchor: anchorTag(getCurrentAnchor()),
      });
    } else {
      return { ok: false as const, error: "goal_set requires objective or doc", details: { kind: "invalid_args" } };
    }
    const eventOk = appendGoalEvent("set", state);
    const saved = await saveGoalFile(cwd, state);
    const replaced = current && (current.status === "active" || current.status === "paused")
      ? ` (replaced previous: ${current.objective.slice(0, 60)})` : "";
    const source = getGoalSource(state);
    const text = saved
      ? `🎯 goal set: ${state.objective}${replaced}${source.type === "doc" ? `\n  doc: ${source.doc_display_path}` : ""}`
      : "goal event recorded but view file write FAILED (injection may lag until next transition)";
    if (!eventOk) ctx.ui?.notify?.("goal event log append FAILED — this goal may not survive session fork/resume reconcile", "warning");
    ctx.ui?.notify?.(text, saved ? "info" : "warning");
    return { ok: true as const, text, state };
  };

  const actGoal = async (action: "pause" | "resume" | "clear" | "stop", ctx: any) => {
    const settings = resolveGoalSettings();
    if (!settings.enabled) return { ok: false as const, error: "goal extension disabled", details: { kind: "goal_disabled" } };
    const cwd = ctx.cwd ?? process.cwd();
    const sessionId = readSessionId(ctx.sessionManager);
    if (!sessionId) return { ok: false as const, error: "goal requires a persisted session", details: { kind: "no_persisted_session" } };
    if (action === "resume" && isCurrentTurnGoalContinuation(ctx.sessionManager)) return { ok: false as const, error: "goal_resume rejected in goal-continuation machine turn", details: { kind: "machine_turn_rejected" } };
    const current = loadGoalFile(cwd, sessionId);
    const res = applyGoalAction(current, action, action === "stop" ? { note: "stopped: auto-continue disabled after current turn" } : undefined);
    if (!res.ok) return { ok: false as const, error: res.error, details: { kind: "invalid_transition" } };
    const evOk = appendGoalEvent(action, res.state);
    if (!evOk) ctx.ui?.notify?.("goal event log append FAILED — transition may not survive fork/resume reconcile", "warning");
    await saveGoalFile(cwd, res.state);
    if (action === "clear") {
      appendGoalOutcome(cwd, {
        type: "goal_outcome", goal_id: res.state.goal_id, session_id: sessionId,
        outcome: "abandoned", objective: res.state.objective.slice(0, 200),
        continuations_used: res.state.counters.continuations_used, ts: new Date().toISOString(),
      });
    }
    const verb = action === "clear" ? "abandoned" : res.state.status;
    const text = `goal ${verb}: ${res.state.objective.slice(0, 80)}`;
    ctx.ui?.notify?.(text, "info");
    return { ok: true as const, text, state: res.state };
  };

  // ── ADR 0033 primary tool surface ─────────────────────────────
  pi.registerTool({
    name: "goal_status",
    label: "Goal Status",
    description: "Read the current session goal state. Read-only.",
    promptSnippet: "goal_status() — read current goal status",
    parameters: Type.Object({}),
    prepareArguments() { return {}; },
    async execute(_id, _params, _signal, _onUpdate, ctx: any) {
      const sessionId = readSessionId(ctx.sessionManager);
      const state = sessionId ? loadGoalFile(ctx.cwd ?? process.cwd(), sessionId) : null;
      return wrapText(formatGoalStatus(state), { kind: "goal_status", state });
    },
  });

  pi.registerTool({
    name: "goal_set",
    label: "Goal Set",
    description: "Set or replace the current session goal from either objective text or a planning document path. Tell-not-ask.",
    promptSnippet: "goal_set(objective?, doc?, criteria?, maxContinuations?, maxMinutes?) — set session goal",
    parameters: Type.Object({
      objective: Type.Optional(Type.String()),
      doc: Type.Optional(Type.String()),
      criteria: Type.Optional(Type.Array(Type.String())),
      maxContinuations: Type.Optional(Type.Number()),
      maxMinutes: Type.Optional(Type.Number()),
    }),
    prepareArguments(rawArgs) {
      const a = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
      return {
        ...(typeof a.objective === "string" ? { objective: a.objective } : {}),
        ...(typeof a.doc === "string" ? { doc: a.doc } : {}),
        ...(Array.isArray(a.criteria) ? { criteria: a.criteria.map(String) } : {}),
        ...(typeof a.maxContinuations === "number" ? { maxContinuations: a.maxContinuations } : {}),
        ...(typeof a.maxMinutes === "number" ? { maxMinutes: a.maxMinutes } : {}),
      };
    },
    async execute(_id, params: any, _signal, _onUpdate, ctx: any) {
      const r = await setGoal(params, ctx);
      return r.ok ? wrapText(r.text, { kind: "goal_set", state: r.state }) : wrapText(`✗ goal_set: ${r.error}`, r.details, true);
    },
  });

  for (const [toolName, action] of [["goal_pause", "pause"], ["goal_resume", "resume"], ["goal_stop", "stop"], ["goal_clear", "clear"]] as const) {
    pi.registerTool({
      name: toolName,
      label: toolName.replace("_", " "),
      description: `${action} the current session goal. Tell-not-ask.`,
      promptSnippet: `${toolName}() — ${action} current goal`,
      parameters: Type.Object({}),
      prepareArguments() { return {}; },
      async execute(_id, _params, _signal, _onUpdate, ctx: any) {
        const r = await actGoal(action, ctx);
        return r.ok ? wrapText(r.text, { kind: toolName, state: r.state }) : wrapText(`✗ ${toolName}: ${r.error}`, r.details, true);
      },
    });
  }

  pi.registerCommand("goal", {
    description:
      "Session goal: /goal set <objective> [--criteria=\"a;b\"] [--max-continuations=N] [--max-minutes=M] | pause | resume | stop | clear | status. Active goal is re-injected every turn (compaction-drift guard). Auto-continue ships separately behind goal.autoContinue.",
    getArgumentCompletions(prefix: string) {
      const items = ["set ", "pause", "resume", "stop", "clear", "status"];
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
        const r = await setGoal({ objective: parsed.objective || undefined, doc: parsed.doc, criteria: parsed.criteria, maxContinuations: parsed.maxContinuations, maxMinutes: parsed.maxMinutes }, ctx);
        if (!r.ok) notify(`/goal set: ${r.error}`, "warning");
        return;
      }
      // pause / resume / stop / clear — share tool helper so W1'
      // machine-turn rejection for resume cannot drift between slash and tool paths.
      const r = await actGoal(parsed.sub, ctx);
      if (!r.ok) {
        notify(`/goal ${parsed.sub}: ${r.error}`, "warning");
        return;
      }
      if (parsed.sub === "resume") {
        const elapsedMin = (Date.now() - Date.parse(r.state.created)) / 60_000;
        if (Number.isFinite(elapsedMin) && elapsedMin > r.state.budget.max_wall_minutes) {
          notify(`⚠️ wall clock already exhausted (${Math.floor(elapsedMin)}min > ${r.state.budget.max_wall_minutes}min) — auto-continue will re-pause; use a fresh /goal set --max-minutes=N to reset`, "warning");
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
    // Wrap volatile: goal status changes per-turn; time-injector hoists it to
    // the prompt suffix so the session-stable prefix stays cache-valid.
    const block = wrapVolatile(formatGoalBlock(state));
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
    if (ctx.signal?.aborted) {
      const stopped = { ...state, status: "paused" as const, status_note: "stopped: user abort/ESC", updated: new Date().toISOString() };
      const evOk = appendGoalEvent("stop", stopped);
      if (!evOk) try { ctx.ui?.notify?.("goal event log append FAILED — stop may not survive reconcile", "warning" as never); } catch { /* noop */ }
      await saveGoalFile(cwd, stopped);
      try { ctx.ui?.notify?.("goal stopped: user abort/ESC", "info" as never); } catch { /* noop */ }
      return;
    }
    if (autoContinueInFlight.has(sessionId)) return;
    autoContinueInFlight.add(sessionId);
    try {
      const branch = (ctx.sessionManager as unknown as { getBranch?(): unknown[] })?.getBranch?.() ?? [];
      const source = getGoalSource(state);
      let goalDoc: { path: string; content: string; truncated?: boolean } | undefined;
      if (source.type === "doc") {
        const doc = readGoalDoc(source.doc_path);
        if (!doc.ok) {
          const paused = { ...state, status: "paused" as const, status_note: `goal doc unreadable: ${doc.error}`, updated: new Date().toISOString() };
          const evOk = appendGoalEvent("pause", paused);
          if (!evOk) try { ctx.ui?.notify?.("goal event log append FAILED — unreadable-doc pause may not survive reconcile", "warning" as never); } catch { /* noop */ }
          const saved = await saveGoalFile(cwd, paused);
          if (!saved) try { ctx.ui?.notify?.("goal view write FAILED — unreadable-doc pause may not be visible until retry", "warning" as never); } catch { /* noop */ }
          try { ctx.ui?.notify?.(`goal paused: document unreadable (${doc.error})`, "warning" as never); } catch { /* noop */ }
          return;
        }
        goalDoc = { path: source.doc_display_path, content: doc.text, ...(doc.truncated ? { truncated: true } : {}) };
      }
      await runAutoContinueOnce({
        state,
        judge: () => runGoalJudge(
          {
            objective: state.objective,
            successCriteria: state.success_criteria,
            ...(goalDoc ? { goalDoc } : {}),
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
        isStillActive: async (next) => {
          if (ctx.signal?.aborted) {
            const stopped = { ...next, status: "paused" as const, status_note: "stopped: user abort/ESC", updated: new Date().toISOString() };
            const evOk = appendGoalEvent("stop", stopped);
            if (!evOk) try { ctx.ui?.notify?.("goal event log append FAILED — stop may not survive reconcile", "warning" as never); } catch { /* noop */ }
            await saveGoalFile(cwd, stopped);
            return false;
          }
          const latest = loadGoalFile(cwd, sessionId);
          return !!latest && latest.goal_id === next.goal_id && latest.status === "active" && latest.counters.continuations_used === next.counters.continuations_used;
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
