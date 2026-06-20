/**
 * goal extension — evidence ledger + plan.md parser + cross-check (v1 spike).
 *
 * Design source: docs/notes/2026-06-20-goal-complete-design.md §0.2 (G1-G6).
 *
 * Two-books model: plan.md is the human-readable "claim book" (AI writes
 * `[x]/[~]` via the normal edit tool — this module NEVER writes user docs,
 * G2). `pi-goal-evidence` events are the machine-replayable "execution
 * book" (SOT). A `[x]` only renders as verified when a matching, non-stale
 * evidence record exists; otherwise it downgrades to `[!]` (unverified) or
 * stale. "Verification not by the same AI" = the OS/git process boundary,
 * recorded by goal_check, is the trust boundary — not a second LLM.
 *
 * This module is PURE logic (only node:crypto for hashing) so the smoke can
 * exercise replay/fold/parse/cross-check via jiti without an extension host.
 * The impure shell-exec lives in exec.ts; the tool wiring lives in index.ts.
 */

import { createHash } from "node:crypto";

export const GOAL_EVIDENCE_EVENT_TYPE = "pi-goal-evidence";
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export type EvidenceKind = "cmd" | "file" | "git";
export type EvidenceStatus = "verified" | "failed";

export interface EvidenceResult {
  exit?: number;
  stdout_sha?: string;
  stderr_sha?: string;
  truncated?: boolean;
  timed_out?: boolean;
  duration_ms?: number;
  // file: kind
  size?: number;
  mtime_ms?: number;
  content_sha?: string;
  // git: kind
  object_sha?: string;
  subject?: string;
}

/** Snapshot of the inputs a verification depended on (G6 drift lock). */
export interface InputFingerprint {
  /** sha of the criterion line text at check time. */
  criterion_text_sha: string;
  /** sha of the evidence expression (e.g. the cmd string). */
  evidence_sha?: string;
  /** declared input files -> content sha at check time (optional). */
  file_shas?: Record<string, string>;
}

export interface EvidenceRecord {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  goal_id: string;
  session_id: string;
  criterion_id: string;
  kind: EvidenceKind;
  /** the evidence expression as given, e.g. "cmd:npm run smoke:x". */
  raw: string;
  status: EvidenceStatus;
  result: EvidenceResult;
  input_fp: InputFingerprint;
  /** compact causal anchor (session:turn) when available. */
  turn?: string;
  ts: string;
}

// ── hashing ────────────────────────────────────────────────────────────

export function sha256short(s: string, n = 16): string {
  return createHash("sha256").update(s, "utf-8").digest("hex").slice(0, n);
}

/** Canonical text used for the criterion fingerprint: trimmed, whitespace
 *  collapsed, so cosmetic reflow does not falsely invalidate evidence but
 *  any semantic edit does. */
export function criterionFingerprintText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function criterionTextSha(text: string): string {
  return sha256short(criterionFingerprintText(text));
}

// ── evidence record construction / normalization ───────────────────────

const EVIDENCE_KINDS: readonly EvidenceKind[] = ["cmd", "file", "git"];

function isKind(v: unknown): v is EvidenceKind {
  return typeof v === "string" && (EVIDENCE_KINDS as readonly string[]).includes(v);
}

/** Defensive parse of an event payload into an EvidenceRecord (mirror of
 *  normalizeGoalState): malformed rows fold to null and are skipped, never
 *  throw, so a torn/forged event cannot poison replay. */
export function normalizeEvidenceRecord(parsed: unknown): EvidenceRecord | null {
  const p = parsed as Partial<EvidenceRecord> | null | undefined;
  if (!p || typeof p !== "object") return null;
  if (typeof p.criterion_id !== "string" || !p.criterion_id) return null;
  if (!isKind(p.kind)) return null;
  const status: EvidenceStatus = p.status === "verified" ? "verified" : "failed";
  const fp = (p.input_fp && typeof p.input_fp === "object" ? p.input_fp : {}) as Partial<InputFingerprint>;
  const result = (p.result && typeof p.result === "object" ? p.result : {}) as EvidenceResult;
  const fileShas: Record<string, string> = {};
  if (fp.file_shas && typeof fp.file_shas === "object") {
    for (const [k, v] of Object.entries(fp.file_shas)) {
      if (typeof v === "string") fileShas[String(k)] = v;
    }
  }
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    goal_id: String(p.goal_id ?? "").slice(0, 80) || "g-unknown",
    session_id: String(p.session_id ?? "").slice(0, 80),
    criterion_id: p.criterion_id.slice(0, 120),
    kind: p.kind,
    raw: String(p.raw ?? "").slice(0, 2000),
    status,
    result,
    input_fp: {
      criterion_text_sha: String(fp.criterion_text_sha ?? ""),
      ...(fp.evidence_sha ? { evidence_sha: String(fp.evidence_sha) } : {}),
      ...(Object.keys(fileShas).length ? { file_shas: fileShas } : {}),
    },
    ...(p.turn ? { turn: String(p.turn).slice(0, 120) } : {}),
    ts: typeof p.ts === "string" ? p.ts : new Date(0).toISOString(),
  };
}

export function makeEvidenceRecord(args: {
  goalId: string;
  sessionId: string;
  criterionId: string;
  criterionText: string;
  kind: EvidenceKind;
  raw: string;
  status: EvidenceStatus;
  result: EvidenceResult;
  evidenceSha?: string;
  fileShas?: Record<string, string>;
  turn?: string;
  now?: Date;
}): EvidenceRecord {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    goal_id: args.goalId,
    session_id: args.sessionId,
    criterion_id: args.criterionId,
    kind: args.kind,
    raw: args.raw,
    status: args.status,
    result: args.result,
    input_fp: {
      criterion_text_sha: criterionTextSha(args.criterionText),
      ...(args.evidenceSha ? { evidence_sha: args.evidenceSha } : {}),
      ...(args.fileShas && Object.keys(args.fileShas).length ? { file_shas: args.fileShas } : {}),
    },
    ...(args.turn ? { turn: args.turn } : {}),
    ts: (args.now ?? new Date()).toISOString(),
  };
}

// ── replay / fold (G1) ─────────────────────────────────────────────────

/** Replay pi-goal-evidence events into a per-criterion APPEND history.
 *  Unlike replayGoalEvents (last-write-wins full-state snapshot), evidence
 *  is ACCUMULATED: every goal_check appends one record; we keep the full
 *  ordered list per criterion_id INCLUDING failures, for audit / "tried &
 *  failed before passing" / re-verification (G1). Branch order is the
 *  caller's getBranch() (root→leaf), so chronological order is preserved. */
export interface ReplayOpts {
  /** When set, fold ONLY records whose goal_id matches (gc-archive: a
   *  previous/abandoned goal's evidence on the same plan.md must not leak
   *  into a new goal_id). Omit to fold all (backward compatible). */
  goalId?: string;
}

/** Extract pi-goal-evidence records from branch entries in chronological
 *  (root->leaf) order, optionally scoped to one goal_id. Shared base for
 *  the grouped and flat replays. */
export function replayGoalEvidenceFlat(entries: unknown[], opts?: ReplayOpts): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const e of entries) {
    const entry = e as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== GOAL_EVIDENCE_EVENT_TYPE) continue;
    const rec = normalizeEvidenceRecord(entry.data);
    if (!rec) continue;
    if (opts?.goalId && rec.goal_id !== opts.goalId) continue;
    out.push(rec);
  }
  return out;
}

export function replayGoalEvidenceEvents(entries: unknown[], opts?: ReplayOpts): Map<string, EvidenceRecord[]> {
  const byCriterion = new Map<string, EvidenceRecord[]>();
  for (const rec of replayGoalEvidenceFlat(entries, opts)) {
    const list = byCriterion.get(rec.criterion_id) ?? [];
    list.push(rec);
    byCriterion.set(rec.criterion_id, list);
  }
  return byCriterion;
}

/** The most recent VERIFIED record for a criterion (latest wins), or
 *  undefined if it was never verified (or only ever failed). The "still
 *  valid" judgement (staleness) is applied separately by the cross-check. */
export function latestVerified(records: EvidenceRecord[] | undefined): EvidenceRecord | undefined {
  if (!records) return undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].status === "verified") return records[i];
  }
  return undefined;
}

// ── staleness (G6) ─────────────────────────────────────────────────────

export interface CurrentFingerprint {
  criterion_text_sha: string;
  /** current content sha for declared input files (caller resolves via fs). */
  file_shas?: Record<string, string>;
}

/** A verified record is STALE when the criterion text changed since the
 *  check, or any declared input file's current sha differs from the
 *  snapshot. This is the anti-drift lock: "edit the wording / drift the
 *  code, keep the green check" is impossible (G6). */
export function isEvidenceStale(rec: EvidenceRecord, current: CurrentFingerprint): boolean {
  if (rec.input_fp.criterion_text_sha !== current.criterion_text_sha) return true;
  const snap = rec.input_fp.file_shas ?? {};
  const cur = current.file_shas ?? {};
  for (const [p, snapSha] of Object.entries(snap)) {
    if (cur[p] !== snapSha) return true;
  }
  return false;
}

// ── plan.md parser (G5) ────────────────────────────────────────────────

export type CriterionMark = " " | "x" | "~";

export interface ParsedCriterion {
  id: string;
  /** text after the `(id)` marker (full remainder of the line). */
  text: string;
  rawMark: CriterionMark;
  lineIndex: number;
  hasId: boolean;
  rawLine: string;
}

// `- [x] (id) text...` — checkbox, optional `(id)`, then text.
const CRITERION_RE = /^\s*[-*]\s*\[([ xX~])\]\s*(?:\(([A-Za-z0-9][A-Za-z0-9_-]*)\)\s*)?(.*)$/;

/** Parse acceptance-criteria checkbox lines from a plan.md. Lines without
 *  an explicit `(id)` are returned in `missingId` so the caller can warn +
 *  suggest (G5: explicit id is SOT; slug/hash was rejected because cosmetic
 *  text edits would orphan evidence). */
export function parsePlanCriteria(planText: string): {
  criteria: ParsedCriterion[];
  missingId: ParsedCriterion[];
  duplicateIds: string[];
} {
  const lines = planText.split(/\r?\n/);
  const criteria: ParsedCriterion[] = [];
  const missingId: ParsedCriterion[] = [];
  const seen = new Map<string, number>();
  const duplicateIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CRITERION_RE.exec(lines[i]);
    if (!m) continue;
    const rawMark = (m[1] === "X" ? "x" : m[1]) as CriterionMark;
    const id = m[2] ?? "";
    const text = (m[3] ?? "").trim();
    const c: ParsedCriterion = { id, text, rawMark, lineIndex: i, hasId: Boolean(m[2]), rawLine: lines[i] };
    if (!c.hasId) { missingId.push(c); continue; }
    const prev = seen.get(id);
    if (prev !== undefined) { if (!duplicateIds.includes(id)) duplicateIds.push(id); }
    seen.set(id, i);
    criteria.push(c);
  }
  return { criteria, missingId, duplicateIds };
}

// ── cross-check / render (G2 + G6) ─────────────────────────────────────

export type DisplayStatus =
  | "todo"             // [ ]
  | "done-unverified"  // [~]
  | "verified"         // [x] with matching, non-stale evidence
  | "unverified"       // [x] claim with NO evidence -> [!]
  | "stale";           // [x] verified but inputs/text drifted -> [!]

export interface CriterionRender {
  id: string;
  text: string;
  display: DisplayStatus;
  glyph: string;
  note?: string;
}

const GLYPH: Record<DisplayStatus, string> = {
  "todo": "[ ]",
  "done-unverified": "[~]",
  "verified": "[x]",
  "unverified": "[!]",
  "stale": "[!]",
};

export interface CrossCheckResult {
  rendered: CriterionRender[];
  claimed: number;   // count of `[x]` lines (AI's claims)
  verified: number;  // count that actually have matching non-stale evidence
  unverified: number;
  stale: number;
}

/** Cross-check parsed criteria against the evidence ledger and compute the
 *  display status of each. `currentFileSha` lets the caller resolve declared
 *  input-file shas from the live fs (injected for purity/testability). */
export function crossCheck(
  criteria: ParsedCriterion[],
  evidenceByCriterion: Map<string, EvidenceRecord[]>,
  opts?: { currentFileSha?: (path: string) => string | undefined },
): CrossCheckResult {
  const rendered: CriterionRender[] = [];
  let claimed = 0, verified = 0, unverified = 0, stale = 0;
  for (const c of criteria) {
    if (c.rawMark === " ") {
      rendered.push({ id: c.id, text: c.text, display: "todo", glyph: GLYPH.todo });
      continue;
    }
    if (c.rawMark === "~") {
      rendered.push({ id: c.id, text: c.text, display: "done-unverified", glyph: GLYPH["done-unverified"] });
      continue;
    }
    // rawMark === "x" -> a claim that needs evidence backing
    claimed++;
    const rec = latestVerified(evidenceByCriterion.get(c.id));
    if (!rec) {
      unverified++;
      rendered.push({ id: c.id, text: c.text, display: "unverified", glyph: GLYPH.unverified, note: "未经系统验证" });
      continue;
    }
    const cur: CurrentFingerprint = {
      criterion_text_sha: criterionTextSha(c.text),
      ...(rec.input_fp.file_shas && opts?.currentFileSha
        ? { file_shas: Object.fromEntries(Object.keys(rec.input_fp.file_shas).map((p) => [p, opts.currentFileSha!(p) ?? ""])) }
        : {}),
    };
    if (isEvidenceStale(rec, cur)) {
      stale++;
      rendered.push({ id: c.id, text: c.text, display: "stale", glyph: GLYPH.stale, note: "证据已过期(文本/输入漂移)，须 re-check" });
      continue;
    }
    verified++;
    rendered.push({ id: c.id, text: c.text, display: "verified", glyph: GLYPH.verified });
  }
  return { rendered, claimed, verified, unverified, stale };
}

// ── hot-zone render (claimed vs verified) ──────────────────────────────

export const MAX_HOTZONE_CHARS = 2000; // ~500 tokens budget proxy

/** Render the cross-checked criteria into the hot-zone criteria block, with
 *  a `claimed N | verified M` summary. Over budget: drop already-verified
 *  lines first (least urgent), then emit an over-budget marker — never
 *  silently truncate the unverified/stale/todo lines that drive next action. */
export function renderCriteriaHotzone(xc: CrossCheckResult, maxChars = MAX_HOTZONE_CHARS): string {
  const summary = `验收: claimed ${xc.claimed} | verified ${xc.verified}`
    + (xc.unverified ? ` | 未验证 ${xc.unverified}` : "")
    + (xc.stale ? ` | stale ${xc.stale}` : "");
  const order: Record<DisplayStatus, number> = { unverified: 0, stale: 1, todo: 2, "done-unverified": 3, verified: 4 };
  const sorted = [...xc.rendered].sort((a, b) => order[a.display] - order[b.display]);
  const lines: string[] = [];
  let used = summary.length;
  let dropped = 0;
  for (const r of sorted) {
    const line = `- ${r.glyph} (${r.id}) ${r.text}${r.note ? `  ← ${r.note}` : ""}`;
    if (used + line.length + 1 > maxChars && r.display === "verified") { dropped++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const head = dropped ? `${summary}（已折叠 ${dropped} 条 verified 省预算）` : summary;
  return [head, ...lines].join("\n");
}

// ── plan.md section extraction (current-state + decision-log) ────────

/** Pull the `## 当前状态` block and `## 决策日志` lines out of a plan.md so the
 *  hot-zone can inject the live current-state + recent decisions alongside the
 *  cross-checked criteria. Heading match is language-tolerant. */
export function extractPlanSections(planText: string): { currentState?: string; recentDecisions: string[] } {
  const lines = planText.split(/\r?\n/);
  let stateLines: string[] | undefined;
  let decisionLines: string[] | undefined;
  let mode: "none" | "state" | "decisions" = "none";
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (/当前状态|current state/i.test(line)) { mode = "state"; stateLines = []; continue; }
      if (/决策日志|decision log/i.test(line)) { mode = "decisions"; decisionLines = []; continue; }
      mode = "none"; continue;
    }
    if (mode === "state" && stateLines) stateLines.push(line);
    else if (mode === "decisions" && decisionLines) decisionLines.push(line);
  }
  const cs = stateLines ? stateLines.join("\n").trim() : "";
  const dec = (decisionLines ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  return { ...(cs ? { currentState: cs } : {}), recentDecisions: dec };
}

// ── v2: judge ledger summary ───────────────────────────────────────────

/** Compact the cross-check into a judge-facing evidence summary (v2 judge-ev):
 *  the auto-continue judge must treat ONLY system-verified criteria as proven,
 *  never a bare `[x]`. Verified / unverified[!] / stale are grouped as DATA. */
export function summarizeLedgerForJudge(xc: CrossCheckResult): string {
  const pick = (d: DisplayStatus) => xc.rendered.filter((r) => r.display === d).map((r) => `(${r.id}) ${r.text}`);
  const verified = pick("verified");
  const unverified = pick("unverified");
  const stale = pick("stale");
  const lines: string[] = [
    `system-verified ${verified.length} / claimed ${xc.claimed} — ONLY verified criteria (a real goal_check recorded matching, non-stale evidence) count as proven:`,
    ...(verified.length ? verified.map((t) => `  [verified] ${t}`) : ["  (none verified yet)"]),
  ];
  if (unverified.length) lines.push("claimed-but-UNVERIFIED (a [x] with NO evidence — do NOT treat as achieved):", ...unverified.map((t) => `  [!] ${t}`));
  if (stale.length) lines.push("STALE (evidence drifted, must re-check — do NOT treat as achieved):", ...stale.map((t) => `  [stale] ${t}`));
  return lines.join("\n");
}

// ── v2: evidence-log render (goal_status visualization) ────────────────

function relAge(tsMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Render the recent N checks for goal_status (v2 status-viz): newest-last,
 *  one line per check with criterion / kind / outcome / relative age. */
export function renderEvidenceLog(records: EvidenceRecord[], n = 8, nowMs = Date.now()): string {
  if (!records.length) return "证据账: (空 — 尚无 goal_check)";
  const recent = records.slice(-Math.max(1, n));
  const lines = recent.map((r) => {
    const mark = r.status === "verified" ? "✓" : "✗";
    const t = Date.parse(r.ts);
    const age = Number.isFinite(t) ? relAge(t, nowMs) : "?";
    const detail = r.kind === "cmd" ? `exit ${r.result.exit ?? "?"}` : r.kind === "file" ? `${r.result.size ?? "?"}B` : (r.result.object_sha ?? "").slice(0, 12);
    return `  ${mark} (${r.criterion_id}) ${r.kind}:${detail} · ${age}`;
  });
  return [`证据账（最近 ${recent.length}/${records.length} 条 check）:`, ...lines].join("\n");
}

// ── v2: GC / archive + stale-by-time ───────────────────────────────────

export interface GcResult { kept: EvidenceRecord[]; archived: number; }

/** Compact an evidence list (v2 gc-archive): per criterion keep the latest
 *  verified record (= current state) plus the last K failures (audit of
 *  "tried & failed"); drop older redundant records. Order preserved. The
 *  event log itself is append-only/immutable; this bounds derived views. */
export function gcEvidence(records: EvidenceRecord[], opts?: { keepFailuresPerCriterion?: number }): GcResult {
  const keepFail = Math.max(0, opts?.keepFailuresPerCriterion ?? 2);
  const byCrit = new Map<string, EvidenceRecord[]>();
  for (const r of records) { const l = byCrit.get(r.criterion_id) ?? []; l.push(r); byCrit.set(r.criterion_id, l); }
  const keep = new Set<EvidenceRecord>();
  for (const list of byCrit.values()) {
    for (let i = list.length - 1; i >= 0; i--) { if (list[i].status === "verified") { keep.add(list[i]); break; } }
    let f = 0;
    for (let i = list.length - 1; i >= 0 && f < keepFail; i--) { if (list[i].status === "failed") { keep.add(list[i]); f++; } }
  }
  const kept = records.filter((r) => keep.has(r));
  return { kept, archived: records.length - kept.length };
}

/** Inactivity hint (v2 gc-archive): is the goal's newest evidence older than
 *  thresholdDays? plan.md is never auto-deleted; this only surfaces a hint. */
export function staleByTime(records: EvidenceRecord[], thresholdDays: number, nowMs = Date.now()): { stale: boolean; lastTs?: string; ageDays?: number } {
  let lastMs = 0, lastTs: string | undefined;
  for (const r of records) { const t = Date.parse(r.ts); if (Number.isFinite(t) && t > lastMs) { lastMs = t; lastTs = r.ts; } }
  if (!lastTs) return { stale: false };
  const ageDays = (nowMs - lastMs) / 86400000;
  return { stale: ageDays > thresholdDays, lastTs, ageDays };
}

// ── v2: dedup cache ────────────────────────────────────────────────────

function fpEqual(a: InputFingerprint, b: InputFingerprint): boolean {
  if (a.criterion_text_sha !== b.criterion_text_sha) return false;
  if ((a.evidence_sha ?? "") !== (b.evidence_sha ?? "")) return false;
  const af = a.file_shas ?? {}, bf = b.file_shas ?? {};
  const ak = Object.keys(af), bk = Object.keys(bf);
  if (ak.length !== bk.length) return false;
  for (const k of ak) { if (af[k] !== bf[k]) return false; }
  return true;
}

/** dedup-cache (v2): the latest VERIFIED record whose input fingerprint
 *  EXACTLY matches `fp` (same criterion text + evidence expr + input-file
 *  shas). A hit means re-running would reproduce the same verified result
 *  with nothing drifted, so the caller may skip the (costly) command. */
export function findCachedVerified(records: EvidenceRecord[] | undefined, fp: InputFingerprint): EvidenceRecord | undefined {
  if (!records) return undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].status === "verified" && fpEqual(records[i].input_fp, fp)) return records[i];
  }
  return undefined;
}
