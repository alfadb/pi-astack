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
import { isGoalContinuationText, parseGoalContinuationMessage } from "../_shared/goal-continuation";
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
import {
  GOAL_EVIDENCE_EVENT_TYPE,
  makeEvidenceRecord,
  parsePlanCriteria,
  replayGoalEvidenceEvents,
  replayGoalEvidenceFlat,
  crossCheck,
  renderCriteriaHotzone,
  extractPlanSections,
  summarizeLedgerForJudge,
  renderEvidenceLog,
  gcEvidence,
  staleByTime,
  findCachedVerified,
  criterionTextSha,
  sha256short,
  type EvidenceKind,
  type InputFingerprint,
} from "./evidence";
import { runEvidenceCmd, fileContentSha, resolveFileFacts } from "./exec";

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
  /** P1: an issued continuation intent whose follow-up never got consumed
   *  (e.g. a fire-and-forget sendUserMessage that silently failed) would
   *  otherwise wedge the pending gate forever. Past this age it is treated
   *  as abandoned so auto-continue can recover. */
  pendingContinuationStaleMinutes: number;
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
  pendingContinuationStaleMinutes: 10,
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
    pendingContinuationStaleMinutes: num(cfg.pendingContinuationStaleMinutes, DEFAULTS.pendingContinuationStaleMinutes, 1, 24 * 60),
  };
}

/** Compact textual form of the C6 causal anchor for the goal record. */
function anchorTag(a: { session_id: string; turn_id: number; subturn?: number } | undefined): string | undefined {
  if (!a) return undefined;
  return `${a.session_id}:${a.turn_id}${a.subturn !== undefined ? `.${a.subturn}` : ""}`;
}

/** Build the live ledger hot-zone for a doc goal: parse plan.md criteria,
 *  cross-check against replayed pi-goal-evidence events, render claimed|
 *  verified + per-criterion glyphs (G2/G6). Fail-safe: returns undefined on
 *  any error so before_agent_start degrades to the pointer-only block. */
function buildLedgerHotzone(docPath: string, branch: unknown[], cwd: string, goalId?: string): string | undefined {
  try {
    const planText = fsSync.readFileSync(docPath, "utf-8");
    const { criteria, missingId } = parsePlanCriteria(planText);
    if (criteria.length === 0 && missingId.length === 0) return undefined;
    const evidence = replayGoalEvidenceEvents(branch, goalId ? { goalId } : undefined);
    const xc = crossCheck(criteria, evidence, { currentFileSha: (p) => fileContentSha(p, cwd) });
    const sections = extractPlanSections(planText);
    const parts: string[] = [];
    if (sections.currentState) parts.push(`当前状态:\n${sections.currentState}`);
    parts.push(renderCriteriaHotzone(xc));
    const recent = sections.recentDecisions.slice(-3);
    if (recent.length) parts.push(`最近决策:\n${recent.join("\n")}`);
    let block = parts.join("\n");
    if (missingId.length) {
      block += `\n⚠ ${missingId.length} 条验收缺 \`(id)\`，goal_check 无法定位——补成 \`- [ ] (some-id) ...\``;
    }
    return block;
  } catch {
    return undefined;
  }
}

/** v2 judge-ev: build the cross-check ledger summary fed to the auto-continue
 *  judge so it counts only system-verified criteria, never a bare `[x]`.
 *  Scoped to the active goal_id (gc-archive). Fail-safe undefined. */
function buildJudgeLedger(docPath: string, branch: unknown[], cwd: string, goalId?: string): string | undefined {
  try {
    const planText = fsSync.readFileSync(docPath, "utf-8");
    const { criteria } = parsePlanCriteria(planText);
    if (!criteria.length) return undefined;
    const evidence = replayGoalEvidenceEvents(branch, goalId ? { goalId } : undefined);
    const xc = crossCheck(criteria, evidence, { currentFileSha: (p) => fileContentSha(p, cwd) });
    if (!xc.claimed && !xc.verified) return undefined;
    return summarizeLedgerForJudge(xc);
  } catch {
    return undefined;
  }
}

/** v2 status-viz: evidence-account block for goal_status — cross-check summary
 *  + GC'd recent checks + stale-by-time inactivity hint. Scoped to the active
 *  goal_id. Read-only, doc goals only. Fail-safe undefined. */
function buildStatusEvidenceBlock(state: GoalState, branch: unknown[], cwd: string): string | undefined {
  try {
    const src = getGoalSource(state);
    if (src.type !== "doc") return undefined;
    const flat = replayGoalEvidenceFlat(branch, { goalId: state.goal_id });
    if (!flat.length) return undefined;
    const parts: string[] = [];
    let planText: string | undefined;
    try { planText = fsSync.readFileSync(src.doc_path, "utf-8"); } catch { planText = undefined; }
    if (planText) {
      const { criteria } = parsePlanCriteria(planText);
      if (criteria.length) {
        const xc = crossCheck(criteria, replayGoalEvidenceEvents(branch, { goalId: state.goal_id }), { currentFileSha: (p) => fileContentSha(p, cwd) });
        parts.push(`验收: claimed ${xc.claimed} | verified ${xc.verified}`
          + (xc.unverified ? ` | 未验证 ${xc.unverified}` : "")
          + (xc.stale ? ` | stale ${xc.stale}` : ""));
      }
    }
    const gc = gcEvidence(flat);
    parts.push(renderEvidenceLog(gc.kept, 8));
    if (gc.archived) parts.push(`  (另有 ${gc.archived} 条冗余记录可归档)`);
    const st = staleByTime(flat, 7);
    if (st.stale && st.ageDays !== undefined) parts.push(`⚠ 该 goal 已 ${st.ageDays.toFixed(0)} 天无 check 活动（plan.md 不自动删，按需 re-check 或 goal_clear）`);
    return parts.join("\n");
  } catch {
    return undefined;
  }
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

function lastAssistantMessage(event: unknown): { role?: string; stopReason?: string; errorMessage?: string } | undefined {
  const messages = (event as { messages?: unknown[] } | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.role === "assistant") return msg;
  }
  return undefined;
}

export function goalAutoContinueSkipReason(event: unknown): "no_assistant" | "assistant_error" | "assistant_aborted" | "assistant_truncated" | undefined {
  const last = lastAssistantMessage(event);
  if (!last) return "no_assistant";
  if (last.stopReason === "error" || (typeof last.errorMessage === "string" && last.errorMessage.length > 0)) return "assistant_error";
  if (last.stopReason === "aborted") return "assistant_aborted";
  // A truncated turn (hit the output-token ceiling) is an incomplete answer;
  // judging it would assess half a response. Skip — the runtime/user drives
  // the next step, and a later clean agent_end re-opens auto-continue.
  if (last.stopReason === "length" || last.stopReason === "max_tokens") return "assistant_truncated";
  return undefined;
}

export function hasUnconsumedGoalContinuation(branch: unknown[], goalId: string, opts?: { now?: number; maxPendingAgeMs?: number }): boolean {
  let latestIntentHash: string | undefined;
  let latestIntentIndex = -1;
  let latestIntentTs: number | undefined;
  let latestConsumedIndex = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i] as { type?: string; customType?: string; data?: { goal_id?: unknown; message_hash?: unknown; ts?: unknown }; message?: { role?: string; content?: unknown } };
    if (entry?.type === "custom" && entry.customType === "pi-goal-continuation" && entry.data?.goal_id === goalId && typeof entry.data.message_hash === "string") {
      latestIntentHash = entry.data.message_hash;
      latestIntentIndex = i;
      latestConsumedIndex = -1;
      latestIntentTs = typeof entry.data.ts === "string" ? Date.parse(entry.data.ts) : undefined;
      continue;
    }
    if (entry?.type === "message" && entry.message?.role === "user") {
      const text = extractMessageText(entry.message.content);
      const parsed = parseGoalContinuationMessage(text);
      if (parsed?.goalId !== goalId) continue;
      const hash = createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
      if (!latestIntentHash || hash === latestIntentHash) latestConsumedIndex = i;
    }
  }
  const pending = latestIntentIndex >= 0 && latestConsumedIndex < latestIntentIndex;
  if (!pending) return false;
  // Staleness escape hatch: a never-consumed intent past the age bound is
  // treated as abandoned (its follow-up likely never reached the queue), so
  // a single dropped send cannot wedge auto-continue forever.
  const maxAge = opts?.maxPendingAgeMs;
  if (typeof maxAge === "number" && maxAge > 0 && typeof latestIntentTs === "number" && Number.isFinite(latestIntentTs)) {
    const now = opts?.now ?? Date.now();
    if (now - latestIntentTs > maxAge) return false;
  }
  return true;
}

const GOAL_CONTINUATION_IDLE_TIMEOUT_MS = 30_000;
const GOAL_CONTINUATION_IDLE_POLL_MS = 100;

export type DeferredGoalContinuationResult =
  | { action: "sent_direct" }
  | { action: "queued_followup"; reason: "idle_timeout" | "direct_send_failed" }
  | { action: "abandoned"; reason: "state_changed" | "send_failed" };

export interface DeferredGoalContinuationDeps {
  message: string;
  goalId: string;
  expectedContinuationsUsed: number;
  appendIntent: () => void;
  loadState: () => GoalState | null;
  isIdle: () => boolean;
  hasPendingMessages?: () => boolean;
  /** May return a promise (pi.sendUserMessage is async): awaited so a
   *  rejection — e.g. the idle-check→send race where a user prompt just
   *  started and prompt() throws — is handled here instead of becoming an
   *  unhandled rejection. */
  sendDirect: (message: string) => void | Promise<void>;
  sendFollowUp: (message: string) => void | Promise<void>;
  notify: (message: string, type?: string) => void;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function scheduleGoalContinuationAfterIdle(deps: DeferredGoalContinuationDeps): Promise<DeferredGoalContinuationResult> {
  deps.appendIntent();
  const timeoutMs = deps.timeoutMs ?? GOAL_CONTINUATION_IDLE_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? GOAL_CONTINUATION_IDLE_POLL_MS;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const started = now();

  // Cross a timer boundary so sendUserMessage never runs synchronously inside
  // the agent_end handler even if ctx.isIdle() already reports true.
  await sleep(0);

  for (;;) {
    let idle = false;
    let pending = false;
    try { idle = deps.isIdle(); } catch { idle = false; }
    try { pending = deps.hasPendingMessages?.() ?? false; } catch { pending = true; }
    if (idle && !pending) break;
    if (now() - started >= timeoutMs) {
      deps.notify("goal auto-continue delayed send timed out waiting for idle; queued as follow-up instead", "warning");
      try {
        await deps.sendFollowUp(deps.message);
      } catch (err) {
        deps.notify(`goal auto-continue follow-up queueing failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
        return { action: "abandoned", reason: "send_failed" };
      }
      return { action: "queued_followup", reason: "idle_timeout" };
    }
    await sleep(Math.max(1, Math.min(pollMs, timeoutMs - (now() - started))));
  }

  const latest = deps.loadState();
  if (!latest || latest.goal_id !== deps.goalId || latest.status !== "active" || latest.counters.continuations_used !== deps.expectedContinuationsUsed) {
    deps.notify("goal auto-continue delayed send abandoned: goal state changed before idle", "info");
    return { action: "abandoned", reason: "state_changed" };
  }

  try {
    await deps.sendDirect(deps.message);
  } catch (directErr) {
    // Race window: a user prompt can start between the idle check and the
    // send, making the bare prompt() path throw. Degrade to followUp
    // queueing (drained at that turn's end) — never worse than the old
    // behavior, never an unhandled rejection.
    deps.notify(`goal auto-continue direct send failed (${directErr instanceof Error ? directErr.message : String(directErr)}); queued as follow-up instead`, "warning");
    try {
      await deps.sendFollowUp(deps.message);
    } catch (fallbackErr) {
      deps.notify(`goal auto-continue follow-up fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`, "warning");
      return { action: "abandoned", reason: "send_failed" };
    }
    return { action: "queued_followup", reason: "direct_send_failed" };
  }
  return { action: "sent_direct" };
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

  /** Append a pi-goal-evidence event (execution book, SOT). Same fail-soft
   *  shape as appendGoalEvent; the materialized view is replay-derived. */
  const appendEvidence = (rec: unknown): boolean => {
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void })
        .appendEntry?.(GOAL_EVIDENCE_EVENT_TYPE, rec);
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
      const cwd = ctx.cwd ?? process.cwd();
      const sessionId = readSessionId(ctx.sessionManager);
      const state = sessionId ? loadGoalFile(cwd, sessionId) : null;
      let text = formatGoalStatus(state);
      if (state) {
        const branch = (ctx.sessionManager as { getBranch?(): unknown[] })?.getBranch?.() ?? [];
        const evBlock = buildStatusEvidenceBlock(state, branch, cwd);
        if (evBlock) text += `\n\n${evBlock}`;
      }
      return wrapText(text, { kind: "goal_status", state });
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

  // ── goal_check: record system-run evidence for a doc criterion (v1) ──
  const runGoalCheck = async (
    params: { criterion_id: string; evidence: string; inputs?: string[] },
    ctx: any,
  ) => {
    const settings = resolveGoalSettings();
    if (!settings.enabled) return { ok: false as const, error: "goal extension disabled", details: { kind: "goal_disabled" } };
    const cwd = ctx.cwd ?? process.cwd();
    const sessionId = readSessionId(ctx.sessionManager);
    if (!sessionId) return { ok: false as const, error: "goal_check requires a persisted session (sub-agent/ephemeral has no event log)", details: { kind: "no_persisted_session" } };
    // G4: a machine/continuation turn (auto-continue judge) must not self-verify.
    if (isCurrentTurnGoalContinuation(ctx.sessionManager)) return { ok: false as const, error: "goal_check rejected in auto-continue/machine turn (the judge must not verify its own output)", details: { kind: "machine_turn_rejected" } };
    const state = loadGoalFile(cwd, sessionId);
    if (!state || state.status !== "active") return { ok: false as const, error: "no active goal (goal_set first)", details: { kind: "no_active_goal" } };
    const src = getGoalSource(state);
    if (src.type !== "doc") return { ok: false as const, error: "goal_check needs a doc-based goal: goal_set(doc=plan.md)", details: { kind: "not_doc_goal" } };
    let planText: string;
    try { planText = fsSync.readFileSync(src.doc_path, "utf-8"); }
    catch { return { ok: false as const, error: `cannot read goal doc: ${src.doc_display_path}`, details: { kind: "doc_unreadable" } }; }
    const { criteria } = parsePlanCriteria(planText);
    const crit = criteria.find((c) => c.id === params.criterion_id);
    if (!crit) return { ok: false as const, error: `unknown criterion id "${params.criterion_id}"; available: ${criteria.map((c) => c.id).join(", ") || "(none — add a (id) marker)"}`, details: { kind: "unknown_criterion" } };
    const ev = String(params.evidence ?? "").trim();
    const m = /^(cmd|file|git):([\s\S]+)$/.exec(ev);
    if (!m) return { ok: false as const, error: "evidence must be cmd:<shell> | file:<path> | git:<sha>", details: { kind: "bad_evidence" } };
    const kind = m[1] as EvidenceKind;
    const arg = m[2].trim();
    const inputs = Array.isArray(params.inputs) ? params.inputs.map(String) : [];
    const fileShas: Record<string, string> = {};
    for (const p of inputs) { const sha = fileContentSha(p, cwd); if (sha) fileShas[p] = sha; }
    // v2 dedup-cache: skip re-running an expensive cmd when an identical
    // fingerprint (criterion text + evidence expr + declared input shas) was
    // already verified for THIS goal and nothing drifted. Gated on declared
    // inputs so an undeclared-dependency cmd is never falsely cached — the
    // fingerprint must capture what the command actually depends on.
    if (kind === "cmd" && inputs.length > 0) {
      const wantFp: InputFingerprint = {
        criterion_text_sha: criterionTextSha(crit.text),
        evidence_sha: sha256short(ev),
        ...(Object.keys(fileShas).length ? { file_shas: fileShas } : {}),
      };
      const branch = (ctx.sessionManager as { getBranch?(): unknown[] })?.getBranch?.() ?? [];
      const prior = replayGoalEvidenceEvents(branch, { goalId: state.goal_id }).get(crit.id);
      const cached = findCachedVerified(prior, wantFp);
      if (cached) {
        return { ok: true as const, status: "verified" as const, text: `✓ verified (${crit.id}): cached — 声明输入未变，跳过重跑 cmd（命中既有证据）。可标/留 \`[x]\`。`, record: cached };
      }
    }
    let result: Record<string, unknown>;
    let status: "verified" | "failed";
    let summary: string;
    if (kind === "cmd") {
      const out = await runEvidenceCmd(arg, { cwd, timeoutMs: settings.judgeTimeoutMs });
      result = { exit: out.exit, stdout_sha: out.stdout_sha, stderr_sha: out.stderr_sha, truncated: out.truncated, timed_out: out.timed_out, duration_ms: out.duration_ms };
      status = out.status;
      summary = out.status === "verified" ? "cmd exit 0" : `cmd ${out.reason ?? `exit ${out.exit}`}`;
    } else if (kind === "file") {
      const f = resolveFileFacts(arg, cwd);
      result = { size: f.size, mtime_ms: f.mtime_ms, content_sha: f.content_sha };
      status = f.exists && (f.size ?? 0) > 0 ? "verified" : "failed";
      if (f.content_sha) fileShas[arg] = f.content_sha;
      summary = status === "verified" ? `file present (${f.size}B)` : `file missing/empty: ${arg}`;
    } else {
      // git: verify an object/ref exists in the repo at cwd.
      if (!/^[0-9a-zA-Z._\/-]{1,120}$/.test(arg)) return { ok: false as const, error: "git: sha/ref must match [0-9a-zA-Z._/-]", details: { kind: "bad_evidence" } };
      const out = await runEvidenceCmd(`git cat-file -e ${arg}`, { cwd, timeoutMs: settings.judgeTimeoutMs });
      result = { exit: out.exit, object_sha: arg };
      status = out.status;
      summary = status === "verified" ? `git object ${arg} exists` : `git object not found: ${arg}`;
    }
    const rec = makeEvidenceRecord({
      goalId: state.goal_id, sessionId, criterionId: crit.id, criterionText: crit.text,
      kind, raw: ev, status, result, evidenceSha: sha256short(ev),
      fileShas, turn: anchorTag(getCurrentAnchor()),
    });
    const appended = appendEvidence(rec);
    const verdict = status === "verified" ? "✓ verified" : "✗ failed";
    const guide = status === "verified"
      ? "现在可在 plan.md 标/留 `[x]`，注入时会判为 verified。"
      : "保持 `[ ]/[~]`，勿打 `[x]`（会渲染 `[!]`）。";
    const text = `${verdict} (${crit.id}): ${summary}. ${guide}${appended ? "" : " [警告: 证据事件 append 失败]"}`;
    return { ok: true as const, status, text, record: rec };
  };

  pi.registerTool({
    name: "goal_check",
    label: "Goal Check",
    description: "Record system-run evidence that an acceptance criterion (by its plan.md (id)) passed. evidence = cmd:<shell> (really executed) | file:<path> | git:<sha>. Does NOT edit plan.md — you mark [x] yourself; matching non-stale evidence is what upgrades that [x] to 'verified' at injection (no evidence → [!]; criterion text or declared input drift → stale). Optional inputs=[files] are fingerprinted. Blocked in auto-continue turns.",
    promptSnippet: "goal_check(criterion_id, evidence, inputs?) — record system-verified evidence for a plan.md criterion",
    parameters: Type.Object({
      criterion_id: Type.String(),
      evidence: Type.String(),
      inputs: Type.Optional(Type.Array(Type.String())),
    }),
    prepareArguments(rawArgs) {
      const a = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
      return {
        criterion_id: String(a.criterion_id ?? ""),
        evidence: String(a.evidence ?? ""),
        ...(Array.isArray(a.inputs) ? { inputs: a.inputs.map(String) } : {}),
      };
    },
    async execute(_id, params: any, _signal, _onUpdate, ctx: any) {
      const r = await runGoalCheck(params, ctx);
      return r.ok ? wrapText(r.text, { kind: "goal_check", status: r.status, record: r.record }) : wrapText(`✗ goal_check: ${r.error}`, r.details, true);
    },
  });

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
    // Doc goals: build the live ledger hot-zone (cross-checked criteria) and
    // inject it instead of the static success_criteria. Fail-safe to pointer.
    let ledgerBlock: string | undefined;
    const src = getGoalSource(state);
    if (src.type === "doc") {
      const branch = (ctx.sessionManager as unknown as { getBranch?(): unknown[] })?.getBranch?.() ?? [];
      ledgerBlock = buildLedgerHotzone(src.doc_path, branch, ctx.cwd ?? process.cwd(), state.goal_id);
    }
    // Wrap volatile: goal status changes per-turn; time-injector hoists it to
    // the prompt suffix so the session-stable prefix stays cache-valid.
    const block = wrapVolatile(formatGoalBlock(state, ledgerBlock));
    const next = `${stripGoalBlock(current).replace(/\n+$/, "")}\n\n${block}\n`;
    return { systemPrompt: next };
  });

  // ── PR-7 auto-continue (goal.autoContinue, default OFF) ──
  // Re-entrancy shape: the continuation turn re-enters agent_end by
  // design; the loop is bounded because the budget counter is
  // PRE-DECREMENTED and persisted before each send (continue.ts). The
  // in-flight set guards against overlapping agent_end emissions only.
  const autoContinueInFlight = new Set<string>();
  pi.on("agent_end", async (event, ctx) => {
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
    const skipReason = goalAutoContinueSkipReason(event);
    if (skipReason) {
      try { ctx.ui?.notify?.(`goal auto-continue skipped: ${skipReason}`, "info" as never); } catch { /* noop */ }
      return;
    }
    const branch = (ctx.sessionManager as unknown as { getBranch?(): unknown[] })?.getBranch?.() ?? [];
    if (hasUnconsumedGoalContinuation(branch, state.goal_id, { maxPendingAgeMs: settings.pendingContinuationStaleMinutes * 60_000 })) {
      try { ctx.ui?.notify?.("goal auto-continue skipped: pending continuation already queued", "info" as never); } catch { /* noop */ }
      return;
    }
    if (autoContinueInFlight.has(sessionId)) return;
    autoContinueInFlight.add(sessionId);
    try {
      const source = getGoalSource(state);
      let goalDoc: { path: string; content: string; truncated?: boolean } | undefined;
      let judgeLedger: string | undefined;
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
        judgeLedger = buildJudgeLedger(source.doc_path, branch, cwd, state.goal_id);
      }
      await runAutoContinueOnce({
        state,
        judge: () => runGoalJudge(
          {
            objective: state.objective,
            successCriteria: state.success_criteria,
            ...(goalDoc ? { goalDoc } : {}),
            ...(judgeLedger ? { evidenceLedger: judgeLedger } : {}),
            recentTranscript: packGoalJudgeWindow(branch),
            continuationsUsed: state.counters.continuations_used,
            maxContinuations: state.budget.max_continuations,
          },
          { judgeModel: settings.judgeModel, judgeTimeoutMs: settings.judgeTimeoutMs, modelRegistry: ctx.modelRegistry },
        ),
        sendContinuation: (message) => {
          const expectedContinuationsUsed = state.counters.continuations_used + 1;
          void scheduleGoalContinuationAfterIdle({
            message,
            goalId: state.goal_id,
            expectedContinuationsUsed,
            appendIntent: () => {
              // §P1 hard-constraint 2b (gpt R1): DEDICATED event-layer ledger —
              // record the SEND INTENT before dispatch. During the delayed
              // idle window this also keeps the pending-continuation gate shut.
              try {
                (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("pi-goal-continuation", {
                  goal_id: state.goal_id,
                  session_id: sessionId,
                  continuations_used: expectedContinuationsUsed,
                  message_hash: createHash("sha256").update(message, "utf-8").digest("hex").slice(0, 12),
                  ts: new Date().toISOString(),
                });
              } catch { /* ledger is best-effort */ }
            },
            loadState: () => loadGoalFile(cwd, sessionId),
            isIdle: () => ctx.isIdle(),
            hasPendingMessages: () => ctx.hasPendingMessages(),
            sendDirect: (m) => pi.sendUserMessage(m),
            sendFollowUp: (m) => pi.sendUserMessage(m, { deliverAs: "followUp" }),
            notify: (msg, type) => { try { ctx.ui?.notify?.(msg, type as never); } catch { /* ui may be absent in print mode */ } },
          }).catch((err) => {
            try { ctx.ui?.notify?.(`goal auto-continue delayed send failed: ${err instanceof Error ? err.message : String(err)}`, "warning" as never); } catch { /* noop */ }
          });
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
