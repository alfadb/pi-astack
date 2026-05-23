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
import * as os from "node:os";

const OUTCOME_LEDGER_DIR = path.join(
  os.homedir(), ".pi", ".pi-astack", "sediment",
);

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
  /** For footnotes: parse status. "ok" = valid used value;
   *  "invalid_used" = LLM wrote unrecognized value, defaulted to confirmatory. */
  footnote_parse_status?: "ok" | "invalid_used";
  /** For tool-result rows: how many times this entry appeared in results */
  retrieval_count: number;
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
 * Parse a ```memory-footnote fenced block from text.
 * Returns { entry, used, counterfactual } or null.
 */
function parseMemoryFootnote(text: string): Array<{
  entry_slug: string;
  used: "decisive" | "confirmatory" | "retrieved-unused";
  counterfactual: string;
  parse_status: "ok" | "invalid_used";
}> {
  const results: Array<{
    entry_slug: string;
    used: "decisive" | "confirmatory" | "retrieved-unused";
    counterfactual: string;
    parse_status: "ok" | "invalid_used";
  }> = [];

  // Find all ```memory-footnote blocks
  const fenceRegex = /```memory-footnote\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = match[1].trim();
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

    const slug = sanitizeSlug(entry.entry ?? entry.slug ?? "");
    const usedRaw = (entry.used ?? "").toLowerCase().trim();
    let used: "decisive" | "confirmatory" | "retrieved-unused" = "confirmatory";
    let footnoteParseStatus: "ok" | "invalid_used" = "ok";
    if (usedRaw === "decisive") {
      used = "decisive";
    } else if (usedRaw === "confirmatory") {
      used = "confirmatory";
    } else if (usedRaw === "retrieved-unused") {
      used = "retrieved-unused";
    } else {
      // Unknown used value — default to confirmatory but mark parse status
      footnoteParseStatus = "invalid_used";
    }

    const counterfactual = entry.counterfactual ?? "";

    if (slug) {
      results.push({ entry_slug: slug, used, counterfactual, parse_status: footnoteParseStatus });
    }
  }

  return results;
}

/**
 * Collect outcomes from the conversation branch.
 * Combines mechanical retrieval tracking + self-report footnote parsing.
 */
export function collectOutcomes(
  branch: unknown[],
  sessionId: string,
): OutcomeRow[] {
  const ts = new Date().toISOString();
  const rows: OutcomeRow[] = [];
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
        const footnotes = parseMemoryFootnote(text);
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
            footnote_parse_status: fn.parse_status,
            retrieval_count: 1,
          };
          seen.set(key, row);
          rows.push(row);
        }
      }
    }
  }

  return rows;
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
    fs.mkdirSync(OUTCOME_LEDGER_DIR, { recursive: true });
    const lines = rows.map((row) =>
      JSON.stringify({ ...row, project_root: projectRoot ?? "" }) + "\n",
    ).join("");
    fs.appendFileSync(
      path.join(OUTCOME_LEDGER_DIR, "outcome-ledger.jsonl"),
      lines,
      "utf-8",
    );
  } catch {
    // best-effort
  }
}
