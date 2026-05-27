/**
 * outcome-collector — P2 outcome self-report (ADR 0025 §4.2).
 *
 * Dual-source collection at agent_end:
 *   A. Mechanical: scan tool results for memory_search/get/decide invocations
 *      → record which entries were retrieved (retrieval_count).
 *   B. Self-report: scan assistant messages for ```memory-footnote fences
 *      → record DECISIVE / CONFIRMATORY / RETRIEVED-UNUSED + counterfactual.
 *
 * Both sources coexist in outcome-ledger.jsonl.  The aggregator (ADR 0025 §4.3)
 * and decision brief (ADR 0026 §3.4) consume the combined data.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureUserGlobalSidecarMigrated, userGlobalSedimentDir } from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { sanitizeForMemory } from "./sanitizer";

interface OutcomeRow {
  ts: string;
  session_id: string;
  entry_slug: string;
  /** Source of this outcome signal */
  source: "memory-footnote" | "tool-result";
  /** Stable per-event id used to prevent repeated agent_end scans from
   * appending the same branch evidence again. */
  event_id?: string;
  /** Only for footnotes: the LLM's self-assessed usage classification */
  used?: "decisive" | "confirmatory" | "retrieved-unused";
  /** Only for footnotes: counterfactual explanation */
  counterfactual?: string;
  /** For tool-result rows: how many times this entry appeared in results */
  retrieval_count: number;
  /** For memory_decide rows: stable id of the decision brief that retrieved this entry. */
  decision_brief_id?: string;
}

/**
 * A footnote that was parsed but failed validation. Per pattern
 * `outcome-footnote-handling-principle-prefer-loss-over-guessing`:
 * invalid footnotes go to audit.jsonl, NOT to outcome-ledger.jsonl.
 * The aggregator must see clean self-report data; "used: confirmatory
 * default on parse error" silently fabricates a usage signal.
 */
export interface DroppedFootnote {
  reason: "invalid_slug" | "invalid_used" | "empty_slug";
  raw_slug: string;
  raw_used?: string;
  /** First 200 chars of the fenced block for audit traceability */
  raw_block_preview?: string;
}

/**
 * Slug validation: an abrain entry slug is kebab-case ASCII or CJK,
 * no whitespace / placeholders / pipes / brackets. We are deliberately
 * permissive about CJK (e.g. multi-agent-review-必须结合真实运行验证 is
 * a legitimate slug in this codebase) but reject everything that looks
 * like a prompt-template placeholder (`<slug>`, `<id>`), separator
 * artifact (`used- decisive | ...`), or markdown bullet leakage.
 */
function isValidSlug(s: string): boolean {
  if (!s || s.length < 3) return false;
  // Reject angle-bracket placeholders, whitespace, pipes, slashes,
  // colons, quotes, brackets, parens, commas.
  if (/[\s<>|\\/:'"`,()\[\]{}]/.test(s)) return false;
  // Reject leading/trailing hyphen (markdown bullet artifact).
  if (s.startsWith("-") || s.endsWith("-")) return false;
  return true;
}

/**
 * Strip scope prefixes (project:xxx:, world:, workflow:) to get bare slug.
 */
function sanitizeSlug(raw: string): string {
  let slug = raw.replace(/^project:[^:]+:/, "");
  slug = slug.replace(/^(world|workflow):/, "");
  slug = slug.replace(/:/g, "-");
  return slug.trim();
}

/**
 * Extract text content from a message content field (string or ContentBlock[]).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (!part || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .join("");
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function toolResultEventId(msg: Record<string, unknown>, eventIndex: number, decisionBriefId?: string): string {
  const explicit = firstString(msg, ["toolCallId", "tool_call_id", "toolResultId", "tool_result_id", "id", "messageId", "message_id"]);
  if (explicit) return `tool:${explicit}`;
  if (decisionBriefId) return `decision:${decisionBriefId}`;
  const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
  const contentHash = stableHash(extractText(msg.content).slice(0, 4096));
  // Without a runtime toolCallId, prefer a content-derived fallback over
  // positional identity. It may undercount two identical tool results in one
  // session, but it will not overcount the same event after branch rewrite /
  // compaction shifts message indexes. True per-call identity requires pi to
  // persist toolCallId/messageId on toolResult messages.
  void eventIndex;
  return `tool:${toolName}:${contentHash}`;
}

function sanitizeAuditText(text: string, maxLen?: number): string {
  const sanitized = sanitizeForMemory(text);
  const value = sanitized.ok ? (sanitized.text ?? text) : `[redacted: ${sanitized.error || "sanitize_failed"}]`;
  return maxLen && value.length > maxLen ? value.slice(0, maxLen) : value;
}

function footnoteOutcomeEventId(
  entry: { entry_slug: string; used: string; counterfactual: string; decision_brief_id?: string },
  eventIndex: number,
): string {
  const counterfactualHash = stableHash(entry.counterfactual.slice(0, 1024));
  if (entry.decision_brief_id) {
    return `footnote:${entry.entry_slug}:${entry.decision_brief_id}:${entry.used}:${counterfactualHash}`;
  }
  // No decision_brief_id means no upstream stable call id. Prefer content
  // identity over positional identity so branch rewrite / compaction does
  // not double-count the same self-report. Duplicate identical footnotes in
  // one session may be undercounted; avoiding outcome inflation is safer.
  void eventIndex;
  return `footnote:${entry.entry_slug}:${entry.used}:${counterfactualHash}`;
}

/**
 * Parse all ```memory-footnote fenced blocks from text.
 *
 * Per pattern `outcome-footnote-handling-principle-prefer-loss-over-guessing`:
 *   - Invalid slug (placeholder like `<slug>`, whitespace, pipes, etc.) → dropped
 *   - Invalid `used` value (not in the 3-option taxonomy) → dropped
 *   - Both go to `dropped[]` for audit; only valid entries reach the ledger.
 */
function parseMemoryFootnote(text: string): {
  entries: Array<{
    entry_slug: string;
    used: "decisive" | "confirmatory" | "retrieved-unused";
    counterfactual: string;
    decision_brief_id?: string;
  }>;
  dropped: DroppedFootnote[];
} {
  const entries: Array<{
    entry_slug: string;
    used: "decisive" | "confirmatory" | "retrieved-unused";
    counterfactual: string;
    decision_brief_id?: string;
  }> = [];
  const dropped: DroppedFootnote[] = [];

  // Find all ```memory-footnote blocks
  const fenceRegex = /```memory-footnote\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = match[1].trim();
    const blockPreview = sanitizeAuditText(body, 200);

    // Parse YAML-like key: value pairs
    const entry: Record<string, string> = {};
    let currentKey = "";
    let currentValue = "";

    for (const line of body.split("\n")) {
      const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (kvMatch) {
        // Save previous key-value
        if (currentKey) entry[currentKey] = currentValue.trim();
        currentKey = kvMatch[1];
        currentValue = kvMatch[2];
      } else if (currentKey) {
        // Continuation line (multiline value)
        currentValue += "\n" + line;
      }
    }
    if (currentKey) entry[currentKey] = currentValue.trim();

    const rawSlug = (entry.entry ?? entry.slug ?? "").trim();
    const slug = sanitizeSlug(rawSlug);
    const usedRaw = (entry.used ?? "").toLowerCase().trim();

    // Slug validation first (cheap, deterministic).
    if (!slug) {
      dropped.push({ reason: "empty_slug", raw_slug: rawSlug, raw_used: usedRaw, raw_block_preview: blockPreview });
      continue;
    }
    if (!isValidSlug(slug)) {
      dropped.push({ reason: "invalid_slug", raw_slug: slug, raw_used: usedRaw, raw_block_preview: blockPreview });
      continue;
    }

    // Used-field validation. Per `outcome-footnote-handling-principle`:
    // do NOT default to confirmatory — that fabricates a usage signal.
    let used: "decisive" | "confirmatory" | "retrieved-unused";
    if (usedRaw === "decisive" || usedRaw === "confirmatory" || usedRaw === "retrieved-unused") {
      used = usedRaw;
    } else {
      dropped.push({ reason: "invalid_used", raw_slug: slug, raw_used: usedRaw, raw_block_preview: blockPreview });
      continue;
    }

    const counterfactual = sanitizeAuditText(entry.counterfactual ?? "");
    const decisionBriefId = (entry.decision_brief_id ?? entry.decisionBriefId ?? "").trim();
    entries.push({
      entry_slug: slug,
      used,
      counterfactual,
      ...(decisionBriefId ? { decision_brief_id: decisionBriefId } : {}),
    });
  }

  return { entries, dropped };
}

/**
 * Collect outcomes from the conversation branch.
 * Combines mechanical retrieval tracking + self-report footnote parsing.
 *
 * Returns `{ rows, dropped }`:
 *   - `rows` → write to outcome-ledger.jsonl (clean self-report data)
 *   - `dropped` → write to audit.jsonl as `outcome_footnote_parse_error`
 *     (per pattern `outcome-footnote-handling-principle-prefer-loss-over-guessing`)
 */
export function collectOutcomes(
  branch: unknown[],
  sessionId: string,
): { rows: OutcomeRow[]; dropped: DroppedFootnote[] } {
  const ts = new Date().toISOString();
  const rows: OutcomeRow[] = [];
  const dropped: DroppedFootnote[] = [];
  const seen = new Map<string, OutcomeRow>(); // key = slug|source|event

  let messageIndex = 0;
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "";

    if (type === "message" && e.message && typeof e.message === "object") {
      const eventIndex = messageIndex++;
      const msg = e.message as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role : "";
      const text = extractText(msg.content);

      // ── Source A: Tool results ──────────────────────────────
      if (role === "toolResult") {
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
        if (!["memory_search", "memory_get", "memory_decide"].includes(toolName)) continue;

        let results: Array<{ slug?: unknown }> = [];
        let decisionBriefId: string | undefined;
        const absorbParsedToolResult = (parsed: unknown): void => {
          if (Array.isArray(parsed)) {
            results.push(...parsed);
            return;
          }
          if (!parsed || typeof parsed !== "object") return;
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.decisionBriefId === "string") decisionBriefId = obj.decisionBriefId;
          if (typeof obj.decision_brief_id === "string") decisionBriefId = obj.decision_brief_id;
          if (Array.isArray(obj.cards)) results.push(...obj.cards as Array<{ slug?: unknown }>);
          if (Array.isArray(obj.results)) results.push(...obj.results as Array<{ slug?: unknown }>);
          if (Array.isArray(obj.entrySlugs)) {
            results.push(...obj.entrySlugs.map((slug) => ({ slug })));
          }
          if (Array.isArray(obj.entry_slugs)) {
            results.push(...obj.entry_slugs.map((slug) => ({ slug })));
          }
          // Backward compatibility: older memory_decide payloads exposed
          // top-level `_meta.results`. Current payloads only need
          // `_meta.entrySlugs` + `_meta.decisionBriefId`.
          if (obj._meta && typeof obj._meta === "object") {
            absorbParsedToolResult(obj._meta);
          }
          if (typeof obj.slug === "string") results.push({ slug: obj.slug });
        };
        try {
          if (typeof msg.content === "string") {
            absorbParsedToolResult(JSON.parse(msg.content));
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content as Array<Record<string, unknown>>) {
              if (block.type !== "text" || typeof block.text !== "string") continue;
              try { absorbParsedToolResult(JSON.parse(block.text)); }
              catch { /* skip non-JSON */ }
            }
          }
        } catch { /* skip */ }

        const toolEventId = toolResultEventId(msg, eventIndex, decisionBriefId);
        const slugsInThisToolResult = new Set<string>();
        for (const item of results) {
          const slug = item && typeof item === "object"
            ? String((item as any).slug ?? (item as any).id ?? "")
            : "";
          if (!slug) continue;

          const bareSlug = sanitizeSlug(slug);
          if (!isValidSlug(bareSlug)) continue;
          if (slugsInThisToolResult.has(bareSlug)) continue;
          slugsInThisToolResult.add(bareSlug);
          const key = `${bareSlug}|tool-result|${toolEventId}`;
          const existing = seen.get(key);
          if (existing) {
            existing.retrieval_count++;
          } else {
            const row: OutcomeRow = {
              ts,
              session_id: sessionId,
              entry_slug: bareSlug,
              source: "tool-result",
              event_id: toolEventId,
              retrieval_count: 1,
              ...(decisionBriefId && toolName === "memory_decide" ? { decision_brief_id: decisionBriefId } : {}),
            };
            seen.set(key, row);
            rows.push(row);
          }
        }
      }

      // ── Source B: Assistant footnotes ────────────────────────
      if (role === "assistant") {
        const { entries: footnotes, dropped: footnoteDropped } = parseMemoryFootnote(text);
        dropped.push(...footnoteDropped);
        for (const fn of footnotes) {
          const footnoteEventId = footnoteOutcomeEventId(fn, eventIndex);
          const key = `${fn.entry_slug}|memory-footnote|${footnoteEventId}`;
          if (seen.has(key)) continue; // dedupe repeated fence for same entry inside one assistant message
          const row: OutcomeRow = {
            ts,
            session_id: sessionId,
            entry_slug: fn.entry_slug,
            source: "memory-footnote",
            event_id: footnoteEventId,
            used: fn.used,
            counterfactual: fn.counterfactual,
            retrieval_count: 1,
            ...(fn.decision_brief_id ? { decision_brief_id: fn.decision_brief_id } : {}),
          };
          seen.set(key, row);
          rows.push(row);
        }
      }
    }
  }

  return { rows, dropped };
}

function outcomeLedgerDedupKey(row: Pick<OutcomeRow, "session_id" | "entry_slug" | "source" | "event_id" | "used" | "counterfactual" | "decision_brief_id">): string {
  if (row.event_id) return `${row.session_id}|${row.entry_slug}|${row.source}|${row.event_id}`;
  // Backward-compatible fallback for legacy rows written before event_id.
  // Keep this intentionally conservative: it dedupes old repeated full-branch
  // scans while still separating different decision briefs when present.
  const brief = row.decision_brief_id ? `|${row.decision_brief_id}` : "";
  if (row.source === "tool-result") return `${row.session_id}|${row.entry_slug}|tool-result${brief}`;
  return `${row.session_id}|${row.entry_slug}|memory-footnote|${row.used ?? ""}|${stableHash(row.counterfactual ?? "")}${brief}`;
}

/**
 * Append outcome rows to the ledger file. Best-effort — never throws.
 *
 * Live agent_end receives the full session branch every turn. Without a
 * durable ledger-level dedupe, the same earlier tool result / footnote would
 * be appended again on every later turn and poison ADR 0026 outcome weights.
 */
export function writeOutcomeLedger(
  rows: OutcomeRow[],
  projectRoot?: string,
): void {
  if (rows.length === 0) return;

  try {
    ensureUserGlobalSidecarMigrated();
    const dir = userGlobalSedimentDir();
    fs.mkdirSync(dir, { recursive: true });
    const ledgerPath = path.join(dir, "outcome-ledger.jsonl");
    const existing = new Set<string>();
    if (fs.existsSync(ledgerPath)) {
      const raw = fs.readFileSync(ledgerPath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<OutcomeRow>;
          if (parsed && typeof parsed === "object" && typeof parsed.session_id === "string" && typeof parsed.entry_slug === "string" && typeof parsed.source === "string") {
            existing.add(outcomeLedgerDedupKey(parsed as OutcomeRow));
          }
        } catch {
          // Ignore corrupt historical lines; readOutcomeLedger() has the same
          // best-effort posture.
        }
      }
    }

    const lines: string[] = [];
    for (const row of rows) {
      const key = outcomeLedgerDedupKey(row);
      if (existing.has(key)) continue;
      existing.add(key);
      // ADR 0027 PR-B+ R1 P1-3: attach causal anchor (session_id, turn_id)
      // for cross-layer join. row.session_id (per-event) wins over anchor
      // session_id when both present (spread order: anchor first). Caller
      // runs inside sediment agent_end ALS scope (P0-β), so getCurrentAnchor()
      // returns the trigger turn snapshot even when this writer completes
      // after user submits next prompt.
      lines.push(JSON.stringify({ ...spreadAnchor(getCurrentAnchor()), ...row, project_root: projectRoot ?? "" }) + "\n");
    }
    if (lines.length === 0) return;
    fs.appendFileSync(ledgerPath, lines.join(""), "utf-8");
  } catch {
    // best-effort
  }
}

// ── Read side (ADR 0026 §3.4) ─────────────────────────────────────────────
//
// The ledger above is the write side (agent_end → collect → append).
// ADR 0026 §3.4 "Outcome-driven recommendations" needs the read side:
// decide.ts wants to know, for each candidate memory entry returned by
// memory_search, "how was this entry treated by the LLM over the last
// N days?". The brain then weights its recommendation by activity.
//
// Design notes:
//
//   - Read is BEST-EFFORT: if the ledger doesn't exist yet (first session,
//     migration window, disk error) we return an empty array. decide.ts
//     handles "no outcome data" by simply not including the section.
//
//   - We deliberately do NOT cap memory by streaming the JSONL — current
//     volume is tiny (single user × N footnotes per session). If the file
//     grows beyond ~10MB we'll add rolling truncation upstream, not here.
//
//   - This is INFRA (read jsonl + count) per ADR 0024 §3 three-state
//     marking. The LLM-behavior layer (decide.ts prompt) stays purely
//     prompt-form: we hand the LLM raw counts and let it judge weight,
//     we do NOT apply a hard threshold like "if decisive_count < 3,
//     suppress recommendation". That would be Mech-on-LLM.

export interface LedgerOutcomeRow extends OutcomeRow {
  /** Optional — added by writeOutcomeLedger at write time. */
  project_root?: string;
}

/**
 * Read the full user-global outcome ledger. Returns an empty array on
 * any failure (missing file, partial line, parse error). Caller never
 * sees an exception. Order = file order (oldest-first append).
 */
export function readOutcomeLedger(): LedgerOutcomeRow[] {
  try {
    ensureUserGlobalSidecarMigrated();
    const dir = userGlobalSedimentDir();
    const filePath = path.join(dir, "outcome-ledger.jsonl");
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const rows: LedgerOutcomeRow[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && typeof parsed.entry_slug === "string") {
          rows.push(parsed as LedgerOutcomeRow);
        }
      } catch {
        // Skip corrupt line — do not throw out the entire history for
        // one bad row (typically a partial write at process kill).
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Per-entry activity summary over a recent time window. ADR 0026 §3.4
 * "high decisive + low unused → strong recommend; high unused → demote;
 * cold → weak reference" — but we surface RAW COUNTS not a precooked
 * label. The decide.ts prompt reads the counts and lets the LLM judge.
 *
 * `windowDays = 30` per ADR 0026 §3.4 default. If the window is too short
 * relative to user task cadence, decide.ts's prompt warns the LLM about
 * sample-size uncertainty.
 */
export interface EntryActivityStats {
  slug: string;
  decisive_count: number;
  confirmatory_count: number;
  retrieved_unused_count: number;
  /** Consecutive memory-footnote decisive self-reports at the tail of the window. */
  decisive_streak: number;
  /** True when recent decisive self-reports may be assistant self-reinforcement, not user reconfirmation. */
  possible_echo_chamber: boolean;
  /** Sum of mechanical retrieval counts from tool-result rows only. */
  total_retrievals: number;
  /** ISO timestamp of most recent ledger row for this slug, or null. */
  last_seen?: string;
}

/**
 * Summarize ledger rows for a specific set of slugs within `windowDays`.
 *
 * Returns one stats record per slug in `slugs` (in input order). Slugs
 * absent from the ledger get a zeroed record (NOT omitted) — decide.ts
 * needs to know "this entry has zero outcome history" vs "this entry has
 * been used decisively 10 times".
 */
export function summarizeEntryActivity(
  rows: LedgerOutcomeRow[],
  slugs: string[],
  windowDays: number = 30,
): EntryActivityStats[] {
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const slugSet = new Set(slugs);
  const byslug = new Map<string, EntryActivityStats>();
  for (const slug of slugs) {
    byslug.set(slug, {
      slug,
      decisive_count: 0,
      confirmatory_count: 0,
      retrieved_unused_count: 0,
      decisive_streak: 0,
      possible_echo_chamber: false,
      total_retrievals: 0,
    });
  }

  const footnoteRowsBySlug = new Map<string, LedgerOutcomeRow[]>();

  for (const row of rows) {
    if (!slugSet.has(row.entry_slug)) continue;
    const tsMs = Date.parse(row.ts);
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;

    const stats = byslug.get(row.entry_slug)!;
    if (row.source === "tool-result") {
      stats.total_retrievals += row.retrieval_count ?? 1;
    }
    if (row.source === "memory-footnote" && row.used) {
      if (row.used === "decisive") stats.decisive_count++;
      else if (row.used === "confirmatory") stats.confirmatory_count++;
      else if (row.used === "retrieved-unused") stats.retrieved_unused_count++;
      const list = footnoteRowsBySlug.get(row.entry_slug) ?? [];
      list.push(row);
      footnoteRowsBySlug.set(row.entry_slug, list);
    }
    if (!stats.last_seen || row.ts > stats.last_seen) {
      stats.last_seen = row.ts;
    }
  }

  for (const [slug, footnoteRows] of footnoteRowsBySlug.entries()) {
    const stats = byslug.get(slug)!;
    const ordered = footnoteRows.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let streak = 0;
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].used !== "decisive") break;
      streak++;
    }
    stats.decisive_streak = streak;
    stats.possible_echo_chamber = streak >= 5;
  }

  return slugs.map((slug) => byslug.get(slug)!);
}
