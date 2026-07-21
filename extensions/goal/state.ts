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
import { createHash, randomBytes } from "node:crypto";

export const GOAL_SCHEMA_VERSION = 2 as const;
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

export type GoalSource =
  | { type: "objective" }
  | { type: "doc"; doc_path: string; doc_display_path: string; doc_hash: string };

export interface GoalState {
  schema_version: typeof GOAL_SCHEMA_VERSION;
  /** Stable id; PR-7 stamps it into the `[pi-goal-continuation goal_id=...]`
   *  transcript prefix for provenance isolation. */
  goal_id: string;
  session_id: string;
  /** Objective is kept for v1 compatibility and injection/status summaries. */
  objective: string;
  /** ADR 0033 GoalState v2 discriminant. Missing on legacy v1 => objective. */
  source: GoalSource;
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

export function sanitizeDocDisplayPath(text: string): string {
  return sanitizeGoalText(text).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 500);
}

export function expandGoalDocPath(docArgRaw: string, cwd: string): { fp?: string; displayPath?: string; error?: string } {
  const raw = docArgRaw.trim();
  if (!raw) return { error: "empty doc path" };
  const fp0 = raw === "~" ? osHomedirCompat() : raw.startsWith("~/") ? path.join(osHomedirCompat(), raw.slice(2)) : raw;
  return { fp: path.isAbsolute(fp0) ? fp0 : path.resolve(cwd, fp0), displayPath: sanitizeDocDisplayPath(raw) };
}

function osHomedirCompat(): string {
  // Avoid importing node:os into this pure-ish state module just for one call;
  // HOME is set in every supported pi runtime. Fallback keeps tests stable.
  return process.env.HOME || "/";
}

export function readGoalDoc(docPath: string, maxChars = 16_384): { ok: true; text: string; hash: string; truncated: boolean } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(docPath, "utf-8");
    const safe = sanitizeGoalText(raw).replace(/<\/goal-doc>/gi, "＜/goal-doc＞");
    const hash = createHash("sha256").update(raw, "utf-8").digest("hex").slice(0, 16);
    if (safe.length <= maxChars) return { ok: true, text: safe, hash, truncated: false };
    const half = Math.max(1, Math.floor((Math.max(120, maxChars) - 120) / 2));
    return {
      ok: true,
      hash,
      truncated: true,
      text: `${safe.slice(0, half)}\n\n[... goal document middle truncated; judge did NOT see omitted content ...]\n\n${safe.slice(-half)}`,
    };
  } catch (e: unknown) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export function newDocGoalState(args: {
  sessionId: string;
  cwd: string;
  doc: string;
  successCriteria?: string[];
  maxContinuations?: number;
  maxWallMinutes?: number;
  anchor?: string;
  now?: Date;
}): { ok: true; state: GoalState } | { ok: false; error: string } {
  const resolved = expandGoalDocPath(args.doc, args.cwd);
  if (!resolved.fp || resolved.error) return { ok: false, error: resolved.error ?? "invalid doc path" };
  const doc = readGoalDoc(resolved.fp);
  if (!doc.ok) return { ok: false, error: `cannot read goal doc ${resolved.fp}: ${doc.error}` };
  const title = firstDocTitle(doc.text) ?? path.basename(resolved.fp);
  return { ok: true, state: newGoalState({
    sessionId: args.sessionId,
    objective: `doc:${resolved.displayPath} — ${title}`,
    successCriteria: args.successCriteria,
    maxContinuations: args.maxContinuations,
    maxWallMinutes: args.maxWallMinutes,
    anchor: args.anchor,
    now: args.now,
    source: { type: "doc", doc_path: resolved.fp, doc_display_path: resolved.displayPath ?? args.doc, doc_hash: doc.hash },
  }) };
}

function firstDocTitle(text: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(text);
  return m?.[1]?.trim().slice(0, 120) || undefined;
}

export function getGoalSource(state: GoalState): GoalSource {
  return state.source ?? { type: "objective" };
}

export function newGoalState(args: {
  sessionId: string;
  objective: string;
  successCriteria?: string[];
  maxContinuations?: number;
  maxWallMinutes?: number;
  anchor?: string;
  now?: Date;
  source?: GoalSource;
}): GoalState {
  const ts = (args.now ?? new Date()).toISOString();
  return {
    schema_version: GOAL_SCHEMA_VERSION,
    goal_id: newGoalId(),
    session_id: args.sessionId,
    objective: sanitizeGoalText(args.objective).slice(0, MAX_OBJECTIVE_CHARS),
    source: args.source ?? { type: "objective" },
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

export type GoalAction = "pause" | "resume" | "clear" | "stop";

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
    case "stop":
      if (state.status !== "active") return { ok: false, error: `cannot stop a ${state.status} goal` };
      return { ok: true, state: { ...next("paused"), status_note: opts?.note ?? "stopped: auto-continue disabled after current turn" } };
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
  | { sub: "set"; objective: string; doc?: string; criteria: string[]; maxContinuations?: number; maxMinutes?: number }
  | { sub: "pause" | "resume" | "clear" | "stop" | "status" }
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
  if (sub === "pause" || sub === "resume" || sub === "clear" || sub === "stop") {
    return { sub };
  }
  if (sub !== "set") {
    return { sub: "error", error: `unknown subcommand "${sub}" (set|pause|resume|stop|clear|status)` };
  }
  let objective = rest;
  let doc: string | undefined;
  let criteria: string[] = [];
  let maxContinuations: number | undefined;
  let maxMinutes: number | undefined;
  // Extract KNOWN --flag=value only (value optionally double-quoted).
  // gpt R1 N2: an unknown `--trace-id=abc` inside the objective text must
  // survive verbatim, not be silently swallowed. Duplicate known flags are
  // last-wins (documented, not an error — gpt R1 N3).
  objective = objective.replace(/--(doc|criteria|max-continuations|max-minutes)=("([^"]*)"|(\S+))/g, (_all, key: string, _q, quoted: string | undefined, bare: string | undefined) => {
    const value = quoted ?? bare ?? "";
    if (key === "doc") doc = value.trim();
    else if (key === "criteria") criteria = value.split(";").map((s) => s.trim()).filter(Boolean);
    else if (key === "max-continuations") maxContinuations = Number(value);
    else if (key === "max-minutes") maxMinutes = Number(value);
    return "";
  }).replace(/\s+/g, " ").trim();
  if (doc && objective) return { sub: "error", error: "set accepts either objective text OR --doc=<path>, not both" };
  if (!doc && !objective) return { sub: "error", error: "set requires an objective or --doc=<path>" };
  return { sub: "set", objective: objective || "", ...(doc ? { doc } : {}), criteria, ...(maxContinuations !== undefined ? { maxContinuations } : {}), ...(maxMinutes !== undefined ? { maxMinutes } : {}) };
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

export function normalizeGoalState(parsed: unknown): GoalState | null {
  const p = parsed as Partial<GoalState> | null | undefined;
  if (!p || typeof p.objective !== "string") return null;
  const schemaVersion = (p as { schema_version?: number }).schema_version;
  if (schemaVersion !== 1 && schemaVersion !== GOAL_SCHEMA_VERSION) return null;
  const status: GoalStatus = p.status === "active" || p.status === "paused" || p.status === "achieved" || p.status === "abandoned" ? p.status : "paused";
  const budget = p.budget && typeof p.budget === "object" ? p.budget as Partial<GoalBudget> : {};
  const counters = p.counters && typeof p.counters === "object" ? p.counters as Partial<GoalCounters> : {};
  return {
    ...(p as GoalState),
    schema_version: GOAL_SCHEMA_VERSION,
    goal_id: sanitizeGoalText(String(p.goal_id ?? "g-unknown")).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "g-unknown",
    session_id: sanitizeGoalText(String(p.session_id ?? "")).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80),
    objective: sanitizeGoalText(p.objective).slice(0, MAX_OBJECTIVE_CHARS),
    source: p.source?.type === "doc"
      ? { ...p.source, doc_display_path: sanitizeDocDisplayPath(String(p.source.doc_display_path ?? "")), doc_hash: String(p.source.doc_hash ?? "").replace(/[^a-fA-F0-9]/g, "").slice(0, 64) }
      : { type: "objective" },
    success_criteria: (Array.isArray(p.success_criteria) ? p.success_criteria : [])
      .map((c) => sanitizeGoalText(String(c)).slice(0, MAX_CRITERION_CHARS))
      .filter(Boolean)
      .slice(0, MAX_CRITERIA),
    status,
    budget: {
      max_continuations: clampInt(budget.max_continuations, 0, 100, DEFAULT_MAX_CONTINUATIONS),
      max_wall_minutes: clampInt(budget.max_wall_minutes, 1, 24 * 60, DEFAULT_MAX_WALL_MINUTES),
    },
    counters: { continuations_used: clampInt(counters.continuations_used, 0, 10_000, 0) },
    created: typeof p.created === "string" ? sanitizeGoalText(p.created).slice(0, 80) : new Date(0).toISOString(),
    updated: typeof p.updated === "string" ? sanitizeGoalText(p.updated).slice(0, 80) : new Date(0).toISOString(),
    ...(p.status_note ? { status_note: sanitizeGoalText(String(p.status_note)).slice(0, 300) } : {}),
  } as GoalState;
}

export function loadGoalFile(cwd: string, sessionId: string): GoalState | null {
  try {
    const raw = fs.readFileSync(goalFilePath(cwd, sessionId), "utf-8");
    return normalizeGoalState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function goalStateCasValue(state: GoalState): Record<string, unknown> {
  const source = getGoalSource(state);
  return {
    schema_version: state.schema_version,
    goal_id: state.goal_id,
    session_id: state.session_id,
    objective: state.objective,
    source: source.type === "doc"
      ? {
        type: "doc",
        doc_path: source.doc_path,
        doc_display_path: source.doc_display_path,
        doc_hash: source.doc_hash,
      }
      : { type: "objective" },
    success_criteria: [...state.success_criteria],
    status: state.status,
    budget: {
      max_continuations: state.budget.max_continuations,
      max_wall_minutes: state.budget.max_wall_minutes,
    },
    counters: { continuations_used: state.counters.continuations_used },
    anchor: state.anchor,
    created: state.created,
    updated: state.updated,
    status_note: state.status_note,
  };
}

/** Exact logical-state comparison for compensating Goal events and view CAS.
 * `updated` is intentionally included: a same-goal/same-counter progress
 * update must make an old continuation precharge ineligible for rollback. */
export function goalStateMatchesCas(actual: GoalState | null, expected: GoalState): actual is GoalState {
  if (!actual) return false;
  return JSON.stringify(goalStateCasValue(actual)) === JSON.stringify(goalStateCasValue(expected));
}

interface GoalFileWriteLocks {
  tails: Map<string, Promise<void>>;
}

const GOAL_FILE_WRITE_LOCKS = Symbol.for("pi-astack/goal/file-write-locks/v1");
const goalFileLockHost = globalThis as typeof globalThis & Record<PropertyKey, unknown>;

function goalFileWriteLocks(): GoalFileWriteLocks {
  const current = goalFileLockHost[GOAL_FILE_WRITE_LOCKS] as GoalFileWriteLocks | undefined;
  if (current) return current;
  const created: GoalFileWriteLocks = { tails: new Map() };
  goalFileLockHost[GOAL_FILE_WRITE_LOCKS] = created;
  return created;
}

async function withGoalFileWriteLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const locks = goalFileWriteLocks();
  const previous = locks.tails.get(target) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.tails.set(target, current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (locks.tails.get(target) === current) locks.tails.delete(target);
  }
}

async function writeGoalFileUnlocked(cwd: string, state: GoalState): Promise<boolean> {
  try {
    const dir = goalDir(cwd);
    await fsp.mkdir(dir, { recursive: true });
    const target = goalFilePath(cwd, state.session_id);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await fsp.rename(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** Atomic write (tmp + rename) — a torn goal file must never poison
 *  injection; loadGoalFile fail-closes to null on parse errors anyway. */
export async function saveGoalFile(cwd: string, state: GoalState): Promise<boolean> {
  const target = goalFilePath(cwd, state.session_id);
  return withGoalFileWriteLock(target, () => writeGoalFileUnlocked(cwd, state));
}

export type GoalFileCasResult = "saved" | "mismatch" | "write_failed";

/** Compare-and-swap a materialized Goal view under the same process-global
 * lock used by ordinary writes. The expected full state includes `updated`,
 * status, budgets, and source metadata, so restoration cannot erase newer
 * progress merely because goal_id/counter happen to match. */
export async function saveGoalFileIfCurrent(
  cwd: string,
  expected: GoalState,
  next: GoalState,
): Promise<GoalFileCasResult> {
  const target = goalFilePath(cwd, expected.session_id);
  return withGoalFileWriteLock(target, async () => {
    const current = loadGoalFile(cwd, expected.session_id);
    if (!goalStateMatchesCas(current, expected)) return "mismatch";
    return await writeGoalFileUnlocked(cwd, next) ? "saved" : "write_failed";
  });
}

/** Remove the materialized view for one session (reconcile: the current
 *  branch carries NO goal events → the view is stale by definition —
 *  e.g. /tree switched to a pre-goal branch point). Best-effort. */
export async function removeGoalFile(cwd: string, sessionId: string): Promise<boolean> {
  const target = goalFilePath(cwd, sessionId);
  return withGoalFileWriteLock(target, async () => {
    try {
      await fsp.unlink(target);
      return true;
    } catch {
      return false;
    }
  });
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

/** R4' anti-write-only-loop (PR-7): append a goal outcome row to
 *  .pi-astack/goal/outcome-ledger.jsonl. Best-effort sync append — callers
 *  run in bg hooks where a throw would be swallowed anyway. The row shape
 *  is goal-owned (NOT sediment's OutcomeRow); sediment may READ this file
 *  in a future aggregator feed but never the reverse. */
export function appendGoalOutcome(cwd: string, row: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(goalDir(cwd), { recursive: true });
    fs.appendFileSync(path.join(goalDir(cwd), "outcome-ledger.jsonl"), `${JSON.stringify(row)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Detached auto-continue and delivery audit. This ledger is deliberately
 * separate from outcome-ledger: transport failures are operational facts,
 * not goal outcomes. */
export function appendGoalAutoContinueAudit(cwd: string, row: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(goalDir(cwd), { recursive: true });
    fs.appendFileSync(path.join(goalDir(cwd), "auto-continue-ledger.jsonl"), `${JSON.stringify(row)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ── event-source replay (fork/resume reconcile) ────────────────────────

/** Replay pi-goal-event entries (event source) to the latest state.
 * Ordinary events carry a full state snapshot and are last-write-wins.
 * `continuation_restore` is a compensating CAS event: it applies only when
 * replay has reached the exact precharged state recorded in `cas_expected`.
 * This keeps the original debit event immutable while making restoration
 * deterministic across fork/resume/reload and harmless after newer events. */
export function replayGoalEvents(entries: unknown[]): GoalState | null {
  let latest: GoalState | null = null;
  for (const e of entries) {
    const entry = e as { type?: string; customType?: string; data?: { action?: unknown; state?: GoalState; cas_expected?: GoalState } };
    if (entry?.type !== "custom" || entry.customType !== GOAL_EVENT_TYPE) continue;
    const s = normalizeGoalState(entry.data?.state);
    if (!s) continue;
    if (entry.data?.action === "continuation_restore") {
      const expected = normalizeGoalState(entry.data.cas_expected);
      if (expected && goalStateMatchesCas(latest, expected)) latest = s;
      continue;
    }
    latest = s;
  }
  return latest;
}

// ── injection block (time-injector pattern) ────────────────────────────

const BEGIN_MARKER = "<!-- pi-astack/goal: active goal (user-set via /goal, C4' authorized) -->";
const END_MARKER = "<!-- /pi-astack/goal -->";

export function formatGoalBlock(state: GoalState, ledgerBlock?: string): string {
  const source = getGoalSource(state);
  const lines = [
    BEGIN_MARKER,
    `## Active goal (goal_id=${state.goal_id})`,
    `Objective: ${state.objective}`,
  ];
  if (source.type === "doc") {
    lines.push(`Goal document: ${source.doc_display_path}`);
    lines.push("Read/update that document for the full plan. Mark `[x]/[~]` yourself; a `[x]` only counts as verified when goal_check has recorded matching, non-stale evidence (else it renders `[!]`).");
  }
  if (ledgerBlock) {
    // Live ledger hot-zone (doc goals): cross-checked criteria w/ claimed|verified.
    lines.push(ledgerBlock);
  } else if (state.success_criteria.length > 0) {
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
  if (!state) return "no goal set (use /goal set <objective> or goal_set doc/objective)";
  const source = getGoalSource(state);
  const src = source.type === "doc" ? ` | doc: ${source.doc_display_path}` : "";
  const crit = state.success_criteria.length ? ` | criteria: ${state.success_criteria.join("; ")}` : "";
  const note = state.status_note ? ` | note: ${state.status_note}` : "";
  return `[${state.status}] ${state.objective}${src}${crit} | continuations ${state.counters.continuations_used}/${state.budget.max_continuations} | wall cap ${state.budget.max_wall_minutes}min | id ${state.goal_id}${note}`;
}

export const __TEST = { BEGIN_MARKER, END_MARKER };
