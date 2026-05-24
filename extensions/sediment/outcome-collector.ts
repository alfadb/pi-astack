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

interface OutcomeRow {
  ts: string;
  session_id: string;
  entry_slug: string;
  /** Source of this outcome signal */
  source: "memory-footnote" | "tool-result";
  /** Only for footnotes: the LLM's self-assessed usage classification */
  used?: "decisive" | "confirmatory" | "retrieved-unused";
  /** Only for footnotes: counterfactual explanation */
  counterfactual?: string;
  /** For tool-result rows: how many times this entry appeared in results */
  retrieval_count: number;
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
  }>;
  dropped: DroppedFootnote[];
} {
  const entries: Array<{
    entry_slug: string;
    used: "decisive" | "confirmatory" | "retrieved-unused";
    counterfactual: string;
  }> = [];
  const dropped: DroppedFootnote[] = [];

  // Find all ```memory-footnote blocks
  const fenceRegex = /```memory-footnote\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = match[1].trim();
    const blockPreview = body.slice(0, 200);

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

    const counterfactual = entry.counterfactual ?? "";
    entries.push({ entry_slug: slug, used, counterfactual });
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
  const seen = new Map<string, OutcomeRow>(); // key = slug|source

  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "";

    if (type === "message" && e.message && typeof e.message === "object") {
      const msg = e.message as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role : "";
      const text = extractText(msg.content);

      // ── Source A: Tool results ──────────────────────────────
      if (role === "toolResult") {
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
        if (!["memory_search", "memory_get", "memory_decide"].includes(toolName)) continue;

        let results: Array<{ slug?: unknown }> = [];
        try {
          if (typeof msg.content === "string") {
            const parsed = JSON.parse(msg.content);
            if (Array.isArray(parsed)) results = parsed;
            else if (parsed && typeof parsed === "object") {
              if (Array.isArray(parsed.cards ?? parsed.results)) results = parsed.cards ?? parsed.results;
              else if (typeof parsed.slug === "string") results = [parsed];
            }
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content as Array<Record<string, unknown>>) {
              if (block.type !== "text" || typeof block.text !== "string") continue;
              try {
                const parsed = JSON.parse(block.text);
                if (Array.isArray(parsed)) results = parsed;
                else if (parsed && typeof parsed === "object") {
                  if (Array.isArray(parsed.cards ?? parsed.results)) results = parsed.cards ?? parsed.results;
                  else if (typeof parsed.slug === "string") results = [parsed];
                }
              } catch { /* skip non-JSON */ }
            }
          }
        } catch { /* skip */ }

        for (const item of results) {
          const slug = item && typeof item === "object"
            ? String((item as any).slug ?? (item as any).id ?? "")
            : "";
          if (!slug) continue;

          const bareSlug = sanitizeSlug(slug);
          const key = `${bareSlug}|tool-result`;
          const existing = seen.get(key);
          if (existing) {
            existing.retrieval_count++;
          } else {
            const row: OutcomeRow = { ts, session_id: sessionId, entry_slug: bareSlug, source: "tool-result", retrieval_count: 1 };
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
          const key = `${fn.entry_slug}|memory-footnote`;
          if (seen.has(key)) continue; // dedupe: one footnote per entry per session
          const row: OutcomeRow = {
            ts,
            session_id: sessionId,
            entry_slug: fn.entry_slug,
            source: "memory-footnote",
            used: fn.used,
            counterfactual: fn.counterfactual,
            retrieval_count: 1,
          };
          seen.set(key, row);
          rows.push(row);
        }
      }
    }
  }

  return { rows, dropped };
}

/**
 * Append outcome rows to the ledger file. Best-effort — never throws.
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
    const lines = rows.map((row) =>
      JSON.stringify({ ...row, project_root: projectRoot ?? "" }) + "\n",
    ).join("");
    fs.appendFileSync(
      path.join(dir, "outcome-ledger.jsonl"),
      lines,
      "utf-8",
    );
  } catch {
    // best-effort
  }
}
