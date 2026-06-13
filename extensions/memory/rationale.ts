import type { Jsonish, MemoryEntry } from "./types";
import type { DirectionImpact } from "./direction-impact";
import { parseDirectionImpact } from "./direction-impact";

/**
 * Rationale rendering path — ADR 0034 §2.3 (Accepted 2026-06-13).
 *
 * Renders an audit-grade rationale for a design decision from STORED memory
 * data only. The cardinal HARD CONSTRAINT (acceptance ⑧): when abrain has no
 * rationale for the target, it returns an explicit "missing" render pointing at
 * git/docs/code evidence — it NEVER fabricates a rationale. Grounding is
 * structural: every rendered section is copied/extracted from the entry's stored
 * fields; sections with no stored data are reported as "not recorded in abrain",
 * not invented.
 *
 * Per Phase-0 revision #8, the render always surfaces the pinned `source_ref`
 * (path#heading@SHA) so a human can detect source drift.
 */

export interface RationaleEvidence {
  memorySlug?: string;
  /** pinned source_ref (path#heading@SHA) — surfaced so drift is detectable. */
  sourceRef?: string;
  /** code symbols / file refs extracted from the stored body (grounded, not invented). */
  codeSymbols: string[];
}

export interface RationaleRender {
  found: boolean;
  slug: string;
  shortAnswer?: string;
  whyDesigned?: string;
  rejectedAlternatives?: string;
  directionImpact: DirectionImpact[];
  evidence: RationaleEvidence;
  confidence?: number;
  /** Honest gaps: low confidence, missing source_ref, unrecorded alternatives, etc. */
  gaps: string[];
  /** Only set when found === false: the explicit no-fabrication fallback message. */
  missingMessage?: string;
}

function scalarString(value: Jsonish | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Strip a leading `# Title` and return the first substantive paragraph. */
function firstParagraph(md: string): string | undefined {
  const withoutTitle = md.replace(/^#\s+.*$/m, "").trim();
  const para = withoutTitle.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 0);
  return para || undefined;
}

/** Extract the body of a `## <heading>` section matching `re`, until the next `##`. */
function extractSection(md: string, re: RegExp): string | undefined {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)$/);
    if (h && re.test(h[1])) { start = i + 1; break; }
  }
  if (start < 0) return undefined;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  const text = out.join("\n").trim();
  return text || undefined;
}

/**
 * Best-effort, GROUNDED extraction of code symbols / file refs from stored text.
 * Only returns tokens that literally appear in the body — never synthesized.
 */
function extractCodeSymbols(md: string): string[] {
  const found = new Set<string>();
  // inline code spans `...`
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim();
    // keep code-ish tokens (file paths, symbols, file::method, file.ts:NN)
    if (/[./:]/.test(tok) && /[A-Za-z]/.test(tok) && tok.length <= 120) found.add(tok);
  }
  // bare file::symbol or file.ext:line patterns outside code spans
  for (const m of md.matchAll(/\b([\w./-]+\.(?:ts|tsx|js|mjs|md)(?:::[\w]+|:\d+)?)\b/g)) {
    found.add(m[1]);
  }
  return Array.from(found).slice(0, 30);
}

const REJECTED_RE = /被拒|拒绝|rejected|alternative|备选|取舍|tradeoff|trade-off|考虑过/i;
const WHY_RE = /为何|为什么|rationale|理由|根因|动机|why|decision|背景|context/i;
const LOW_CONFIDENCE = 5;

/**
 * Render a rationale from a resolved entry (or null). Pure / total / never
 * fabricates. `entry === null` → the explicit missing fallback (acceptance ⑧).
 */
export function renderRationaleFromEntry(slug: string, entry: MemoryEntry | null): RationaleRender {
  if (!entry) {
    return {
      found: false,
      slug,
      directionImpact: [],
      evidence: { codeSymbols: [] },
      gaps: ["no abrain memory entry for this slug"],
      missingMessage:
        `abrain has no rationale entry for "${slug}". Do NOT fabricate one — ` +
        `consult git history, the ADR source docs, and code evidence directly.`,
    };
  }

  const sourceRef = scalarString(entry.frontmatter.source_ref);
  const directionImpact = entry.directionImpact && entry.directionImpact.length > 0
    ? entry.directionImpact
    : parseDirectionImpact(entry.frontmatter.direction_impact).impacts;

  const body = (entry.compiledTruth || "").trim();
  const gaps: string[] = [];

  // The compiled-truth body IS the recorded rationale; we only format it.
  const whyDesigned = body
    ? (extractSection(body, WHY_RE) || body)
    : undefined;
  if (!body) gaps.push("entry has no compiled rationale body (only frontmatter)");

  const shortAnswer = body ? firstParagraph(body) : undefined;

  // Rejected alternatives only if literally recorded; otherwise an honest gap.
  const rejectedAlternatives = body ? extractSection(body, REJECTED_RE) : undefined;
  if (!rejectedAlternatives) gaps.push("rejected alternatives not recorded in this entry");

  if (!sourceRef) gaps.push("no source_ref (pinned SHA) — provenance/drift not tracked");
  if (typeof entry.confidence === "number" && entry.confidence < LOW_CONFIDENCE) {
    gaps.push(`low confidence (${entry.confidence}/10)`);
  }

  return {
    found: true,
    slug: entry.slug,
    ...(shortAnswer ? { shortAnswer } : {}),
    ...(whyDesigned ? { whyDesigned } : {}),
    ...(rejectedAlternatives ? { rejectedAlternatives } : {}),
    directionImpact,
    evidence: {
      memorySlug: entry.slug,
      ...(sourceRef ? { sourceRef } : {}),
      codeSymbols: extractCodeSymbols(body),
    },
    confidence: entry.confidence,
    gaps,
  };
}

/**
 * Async convenience: resolve a slug via an injected resolver, then render.
 * Production passes a memory loader; smoke passes a stub. The resolver returning
 * null is the only "missing" trigger — render still never fabricates.
 */
export async function renderRationale(
  slug: string,
  resolve: (slug: string) => Promise<MemoryEntry | null>,
): Promise<RationaleRender> {
  let entry: MemoryEntry | null = null;
  try {
    entry = await resolve(slug);
  } catch {
    entry = null;
  }
  return renderRationaleFromEntry(slug, entry);
}

/** Human-readable audit rendering. Missing → the explicit fallback, nothing else. */
export function formatRationale(r: RationaleRender): string {
  if (!r.found) {
    return [
      `# Rationale: ${r.slug}`,
      "",
      `⚠️ ${r.missingMessage}`,
      "",
      "Evidence to consult directly (abrain has none):",
      "- git history (blame / log on the relevant ADR + code)",
      "- docs/adr/ source + docs/direction.md / docs/requirements.md",
      "- the implementing code symbols",
    ].join("\n");
  }
  const lines: string[] = [`# Rationale: ${r.slug}`, ""];
  if (r.shortAnswer) lines.push(`**短答**：${r.shortAnswer}`, "");
  if (r.whyDesigned) lines.push("## 为何如此设计", "", r.whyDesigned, "");
  lines.push("## 被拒方案", "", r.rejectedAlternatives || "_(not recorded in abrain — consult ADR source / git)_", "");
  if (r.directionImpact.length > 0) {
    lines.push("## direction_impact", "");
    for (const di of r.directionImpact) {
      lines.push(`- ${di.relation} → ${di.ref} (escalation: ${di.escalation}${di.proposalRef ? `, proposal: ${di.proposalRef}` : ""})`);
    }
    lines.push("");
  }
  lines.push("## 证据", "");
  lines.push(`- memory slug: ${r.evidence.memorySlug ?? "—"}`);
  lines.push(`- source_ref (pinned): ${r.evidence.sourceRef ?? "— (no pinned SHA — drift not detectable)"}`);
  if (r.evidence.codeSymbols.length > 0) lines.push(`- code symbols: ${r.evidence.codeSymbols.join(", ")}`);
  lines.push("");
  lines.push("## 置信与缺口", "");
  lines.push(`- confidence: ${typeof r.confidence === "number" ? `${r.confidence}/10` : "—"}`);
  if (r.gaps.length > 0) for (const g of r.gaps) lines.push(`- gap: ${g}`);
  else lines.push("- no notable gaps");
  return lines.join("\n");
}
