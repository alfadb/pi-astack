/**
 * goal extension — state model (PR-6 / P1a, impl-plan 2026-06-10 Phase P1).
 *
 * Design (plan §P1):
 *   - `.pi-astack/goal/<sessionId>.json` is a MATERIALIZED VIEW;
 *     `pi.appendEntry("pi-goal-event", ...)` rows in the session are the
 *     EVENT SOURCE. On session_start the view is reconciled from events so
 *     session fork/resume cannot drift the goal silently (events live in
 *     the session tree and fork WITH it; the json file does not).
 *   - status machine: active ⇄ paused → abandoned (clear); achieved is a
 *     terminal status reserved for PR-7's auto-continue judge (the type
 *     carries it now so the schema does not break later).
 *   - budget{max_continuations, max_wall_minutes} + counters are SET here
 *     but only CONSUMED by PR-7 (auto-continue). PR-6 never continues.
 *   - C4' authorization: a goal only exists when the USER ran /goal set.
 *     No autonomous path creates goal state.
 *
 * This module is pure logic + fs helpers (no pi API) so the smoke can
 * exercise the full state machine via jiti without an extension host.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export const GOAL_SCHEMA_VERSION = 1 as const;
export const GOAL_EVENT_TYPE = "pi-goal-event";

export type GoalStatus = "active" | "paused" | "achieved" | "abandoned";

export interface GoalBudget {
  max_continuations: number;
  max_wall_minutes: number;
}

export interface GoalCounters {
  /** Incremented by PR-7 auto-continue (pre-decrement discipline). */
  continuations_used: number;
}

export interface GoalState {
  schema_version: typeof GOAL_SCHEMA_VERSION;
  /** Stable id; PR-7 stamps it into the `[pi-goal-continuation goal_id=...]`
   *  transcript prefix for provenance isolation. */
  goal_id: string;
  session_id: string;
  objective: string;
  success_criteria: string[];
  status: GoalStatus;
  budget: GoalBudget;
  counters: GoalCounters;
  /** C6 causal anchor at set-time (best-effort; absent outside anchor ctx). */
  anchor?: string;
  created: string;
  updated: string;
  /** Free-form note for the latest transition (pause reason, clear note). */
  status_note?: string;
}

export const DEFAULT_MAX_CONTINUATIONS = 10;
export const DEFAULT_MAX_WALL_MINUTES = 120;

/** Injection-cost caps (deepseek R1 N1): the block rides EVERY turn's
 *  system prompt, so free text gets hard length ceilings. */
export const MAX_OBJECTIVE_CHARS = 2000;
export const MAX_CRITERION_CHARS = 300;
export const MAX_CRITERIA = 10;

/** Neutralize text destined for the injection block (opus R1 N2 /
 *  deepseek R1 N2+N4): an objective containing the literal block
 *  END_MARKER would make stripGoalBlock's lazy regex terminate early →
 *  un-stripped residue ACCUMULATES across turns. HTML-comment tokens are
 *  swapped for fullwidth lookalikes (LLM-readable, regex-inert) and
 *  control chars (except \n \t) including bidi overrides are dropped. */
export function sanitizeGoalText(text: string): string {
  return text
    .replace(/<!--/g, "＜!--")
    .replace(/-->/g, "--＞")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();
}

// ── construction & transitions ─────────────────────────────────────────

export function newGoalId(): string {
  return `g-${randomBytes(4).toString("hex")}`;
}

export function newGoalState(args: {
  sessionId: string;
  objective: string;
  successCriteria?: string[];
  maxContinuations?: number;
  maxWallMinutes?: number;
  anchor?: string;
  now?: Date;
}): GoalState {
  const ts = (args.now ?? new Date()).toISOString();
  return {
    schema_version: GOAL_SCHEMA_VERSION,
    goal_id: newGoalId(),
    session_id: args.sessionId,
    objective: sanitizeGoalText(args.objective).slice(0, MAX_OBJECTIVE_CHARS),
    success_criteria: (args.successCriteria ?? [])
      .map((c) => sanitizeGoalText(c).slice(0, MAX_CRITERION_CHARS))
      .filter(Boolean)
      .slice(0, MAX_CRITERIA),
    status: "active",
    budget: {
      max_continuations: clampInt(args.maxContinuations, 0, 100, DEFAULT_MAX_CONTINUATIONS),
      max_wall_minutes: clampInt(args.maxWallMinutes, 1, 24 * 60, DEFAULT_MAX_WALL_MINUTES),
    },
    counters: { continuations_used: 0 },
    ...(args.anchor ? { anchor: args.anchor } : {}),
    created: ts,
    updated: ts,
  };
}

export type GoalAction = "pause" | "resume" | "clear";

/** Pure transition. Returns the next state or an error string; never throws.
 *  set is NOT here — it constructs a fresh state (newGoalState) and may
 *  legally replace an existing goal in any status (user re-authorization). */
export function applyGoalAction(
  state: GoalState | null,
  action: GoalAction,
  opts?: { note?: string; now?: Date },
): { ok: true; state: GoalState } | { ok: false; error: string } {
  if (!state) return { ok: false, error: "no goal set (use /goal set <objective>)" };
  const ts = (opts?.now ?? new Date()).toISOString();
  const next = (status: GoalStatus): GoalState => ({
    ...state,
    status,
    updated: ts,
    ...(opts?.note ? { status_note: opts.note } : {}),
  });
  switch (action) {
    case "pause":
      if (state.status !== "active") return { ok: false, error: `cannot pause a ${state.status} goal` };
      return { ok: true, state: next("paused") };
    case "resume":
      if (state.status !== "paused") return { ok: false, error: `cannot resume a ${state.status} goal` };
      return { ok: true, state: next("active") };
    case "clear":
      if (state.status === "achieved" || state.status === "abandoned") {
        return { ok: false, error: `goal already ${state.status}` };
      }
      return { ok: true, state: next("abandoned") };
  }
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

// ── command argument parsing ───────────────────────────────────────────

export type ParsedGoalCommand =
  | { sub: "set"; objective: string; criteria: string[]; maxContinuations?: number; maxMinutes?: number }
  | { sub: "pause" | "resume" | "clear" | "status" }
  | { sub: "error"; error: string };

/** Parse `/goal ...` arguments.
 *  set syntax: `set <objective text> [--criteria="a;b"] [--max-continuations=N] [--max-minutes=M]`
 *  Criteria split on `;`. Quoted flag values may contain spaces. */
export function parseGoalArgs(raw: string): ParsedGoalCommand {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "status") return { sub: "status" };
  const m = /^(\S+)([\s\S]*)$/.exec(trimmed);
  const sub = m ? m[1] : trimmed;
  const rest = m ? m[2].trim() : "";
  if (sub === "pause" || sub === "resume" || sub === "clear") {
    return { sub };
  }
  if (sub !== "set") {
    return { sub: "error", error: `unknown subcommand "${sub}" (set|pause|resume|clear|status)` };
  }
  let objective = rest;
  let criteria: string[] = [];
  let maxContinuations: number | undefined;
  let maxMinutes: number | undefined;
  // Extract KNOWN --flag=value only (value optionally double-quoted).
  // gpt R1 N2: an unknown `--trace-id=abc` inside the objective text must
  // survive verbatim, not be silently swallowed. Duplicate known flags are
  // last-wins (documented, not an error — gpt R1 N3).
  objective = objective.replace(/--(criteria|max-continuations|max-minutes)=("([^"]*)"|(\S+))/g, (_all, key: string, _q, quoted: string | undefined, bare: string | undefined) => {
    const value = quoted ?? bare ?? "";
    if (key === "criteria") criteria = value.split(";").map((s) => s.trim()).filter(Boolean);
    else if (key === "max-continuations") maxContinuations = Number(value);
    else if (key === "max-minutes") maxMinutes = Number(value);
    return "";
  }).replace(/\s+/g, " ").trim();
  if (!objective) return { sub: "error", error: "set requires an objective: /goal set <objective>" };
  return { sub: "set", objective, criteria, ...(maxContinuations !== undefined ? { maxContinuations } : {}), ...(maxMinutes !== undefined ? { maxMinutes } : {}) };
}

// ── materialized view (fs) ─────────────────────────────────────────────

export function goalDir(cwd: string): string {
  return path.join(cwd, ".pi-astack", "goal");
}

export function goalFilePath(cwd: string, sessionId: string): string {
  // sessionId is generated by pi (uuid-ish) but sanitize defensively —
  // it lands in a filename.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return path.join(goalDir(cwd), `${safe}.json`);
}

export function loadGoalFile(cwd: string, sessionId: string): GoalState | null {
  try {
    const raw = fs.readFileSync(goalFilePath(cwd, sessionId), "utf-8");
    const parsed = JSON.parse(raw) as GoalState;
    if (parsed && parsed.schema_version === GOAL_SCHEMA_VERSION && typeof parsed.objective === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename) — a torn goal file must never poison
 *  injection; loadGoalFile fail-closes to null on parse errors anyway. */
export async function saveGoalFile(cwd: string, state: GoalState): Promise<boolean> {
  try {
    const dir = goalDir(cwd);
    await fsp.mkdir(dir, { recursive: true });
    const target = goalFilePath(cwd, state.session_id);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await fsp.rename(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** Remove the materialized view for one session (reconcile: the current
 *  branch carries NO goal events → the view is stale by definition —
 *  e.g. /tree switched to a pre-goal branch point). Best-effort. */
export async function removeGoalFile(cwd: string, sessionId: string): Promise<boolean> {
  try {
    await fsp.unlink(goalFilePath(cwd, sessionId));
    return true;
  } catch {
    return false;
  }
}

/** GC stale materialized views. mtime-based (plan: "按 mtime + session 不存在
 *  清理" — session-existence is not reliably checkable from cwd, so age is
 *  the implemented criterion; the current session's file is always kept).
 *  Best-effort: errors are swallowed, returns #removed. */
export async function gcStaleGoalFiles(cwd: string, opts: { keepSessionId?: string; maxAgeDays: number; now?: Date }): Promise<number> {
  let removed = 0;
  const cutoff = (opts.now ?? new Date()).getTime() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
  const keep = opts.keepSessionId ? path.basename(goalFilePath(cwd, opts.keepSessionId)) : undefined;
  let files: string[] = [];
  try {
    files = await fsp.readdir(goalDir(cwd));
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f === keep) continue;
    const fp = path.join(goalDir(cwd), f);
    try {
      // lstat + regular-file check (gpt R1 N4): never follow a symlink's
      // target mtime, and never unlink non-regular entries.
      const st = await fsp.lstat(fp);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        await fsp.unlink(fp);
        removed++;
      }
    } catch { /* raced or unreadable — skip */ }
  }
  return removed;
}

// ── event-source replay (fork/resume reconcile) ────────────────────────

/** Replay pi-goal-event entries (event source) to the latest state.
 *  Each event carries a full state snapshot (`data.state`) — replay is
 *  last-write-wins, no folding needed. Malformed entries are skipped. */
export function replayGoalEvents(entries: unknown[]): GoalState | null {
  let latest: GoalState | null = null;
  for (const e of entries) {
    const entry = e as { type?: string; customType?: string; data?: { state?: GoalState } };
    if (entry?.type !== "custom" || entry.customType !== GOAL_EVENT_TYPE) continue;
    const s = entry.data?.state;
    if (s && s.schema_version === GOAL_SCHEMA_VERSION && typeof s.objective === "string") {
      latest = s;
    }
  }
  return latest;
}

// ── injection block (time-injector pattern) ────────────────────────────

const BEGIN_MARKER = "<!-- pi-astack/goal: active goal (user-set via /goal, C4' authorized) -->";
const END_MARKER = "<!-- /pi-astack/goal -->";

export function formatGoalBlock(state: GoalState): string {
  const lines = [
    BEGIN_MARKER,
    `## Active goal (goal_id=${state.goal_id})`,
    `Objective: ${state.objective}`,
  ];
  if (state.success_criteria.length > 0) {
    lines.push("Success criteria:");
    for (const c of state.success_criteria) lines.push(`- ${c}`);
  }
  lines.push(
    `Status: ${state.status} | set ${state.created.slice(0, 16).replace("T", " ")}Z | continuations ${state.counters.continuations_used}/${state.budget.max_continuations}`,
    "Discipline: keep this turn's work aligned to the objective (it survives compaction via this block).",
    "When the goal is ACHIEVED or BLOCKED, state so explicitly in your reply; the user manages lifecycle via /goal.",
    END_MARKER,
  );
  return lines.join("\n");
}

export function stripGoalBlock(prompt: string): string {
  const re = new RegExp(
    `(?:\\n*)${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}(?:\\n*)`,
    "g",
  );
  return prompt.replace(re, "\n\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Human-facing /goal status text. */
export function formatGoalStatus(state: GoalState | null): string {
  if (!state) return "no goal set (use /goal set <objective>)";
  const crit = state.success_criteria.length ? ` | criteria: ${state.success_criteria.join("; ")}` : "";
  const note = state.status_note ? ` | note: ${state.status_note}` : "";
  return `[${state.status}] ${state.objective}${crit} | continuations ${state.counters.continuations_used}/${state.budget.max_continuations} | wall cap ${state.budget.max_wall_minutes}min | id ${state.goal_id}${note}`;
}

export const __TEST = { BEGIN_MARKER, END_MARKER };
