/**
 * rule-writer — ADR 0023 D5 write-path: rule-specific substrate.
 *
 * This module holds the PURE, side-effect-free rule logic (draft type, hint
 * sanitize + fallback, kind/size lints, markdown build). The fs-bound
 * orchestration (`writeAbrainRule` + lifecycle writers, mirroring
 * `writeAbrainWorkflow`) and budget telemetry live in `writer.ts` and call
 * into these helpers. Splitting the pure logic out keeps the rule-specific
 * contract unit-testable without a real abrain tree.
 *
 * Invariants implemented here:
 *  - INV-R4 (kind 限制): `lintRuleKind` — always ∈ {maxim,preference,anti-pattern};
 *    listed rejects {fact,smell}.
 *  - lintRuleAlwaysSize: always-mode body ≤ 300 UTF-16 code units (D2 §134).
 *  - D5.1 `sanitizeRuleHint`: hint may surface as the catalog summary fallback
 *    every session, so it remains a noise-promotion surface (NOT adversarial
 *    prompt injection — see ADR §1.4). Structural reject/strip rules below.
 *  - body_hash: D5.1 — frontmatter carries sha256(body) so downstream readers
 *    can detect hint/body drift.
 *  - F-W2 provenance: `derives_from` / `promoted_from` / `source_body_hash`
 *    link a promoted rule back to its source knowledge entry (reconciliation
 *    anchor for the deferred region-move).
 */

import * as crypto from "node:crypto";

import { redactCredentials } from "../abrain/redact";
import { ENTRY_KINDS, ENTRY_STATUSES, PROVENANCE_CLASSES, type EntryKind, type EntryStatus, type ProvenanceClass } from "./validation";

/** ADR 0028 §12.3: the rules-subsystem injection-budget axis is named
 *  INJECT-MODE (values unchanged: always/listed), renamed away from "tier" so
 *  it can no longer be confused with the ADR 0028 GTIER write-path predicate
 *  (Tier-1/Tier-2). Directory names (`rules/always|listed/`) and the rule id
 *  format (`rule:<scope>:<mode>:<slug>`) embed the VALUES and are unchanged. */
export type RuleInjectMode = "always" | "listed";
export type RuleScope = "global" | { projectId: string };

/** ADR 0023 D5 RuleDraft (R4-simplified: no evidenceSource/evidenceQuote/
 *  userBackingTurnIndex). `scope` is "global" or a project binding. */
export interface RuleDraft {
  title: string;
  body: string;
  zone: "rules";
  injectMode: RuleInjectMode;
  scope: RuleScope;
  kind: EntryKind;
  hint?: string;
  entryConfidence: number;
  routingConfidence: number;
  triggerPhrases?: string[];
  tags?: string[];
  status?: EntryStatus;
  slug?: string;
  routingReason: string;
  sessionId?: string;
  // AX-PROVENANCE (ADR 0028 v1.1 §12): stored ground-truth-strength axis, set
  // deterministically from the originating turn.role. The Tier-1 path sets
  // 'user-expressed' explicitly; buildRuleMarkdown defaults to 'assistant-observed'
  // (conservative) when unset so an autonomous-curator rule is not mislabeled.
  provenance?: ProvenanceClass;
  // F-W2 provenance link (knowledge -> rules promotion reconciliation anchor)
  derivesFrom?: string[];
  promotedFrom?: string;
  sourceBodyHash?: string;
}

export type LintResult = { ok: true } | { ok: false; reason: string };
export type HintResult = { ok: true; clean: string } | { ok: false; reason: string };

const ALWAYS_KINDS: ReadonlySet<string> = new Set(["maxim", "preference", "anti-pattern"]);
const LISTED_REJECT_KINDS: ReadonlySet<string> = new Set(["fact", "smell"]);

/** INV-R4: inject_mode=always requires kind ∈ {maxim,preference,anti-pattern};
 *  inject_mode=listed rejects kind ∈ {fact,smell}. */
export function lintRuleKind(kind: string, injectMode: RuleInjectMode): LintResult {
  if (!(ENTRY_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `unknown kind "${kind}" (must be one of: ${ENTRY_KINDS.join(", ")})` };
  }
  if (injectMode === "always") {
    if (!ALWAYS_KINDS.has(kind)) {
      return { ok: false, reason: `always-mode rule requires kind ∈ {maxim, preference, anti-pattern}, got "${kind}"` };
    }
  } else if (LISTED_REJECT_KINDS.has(kind)) {
    return { ok: false, reason: `listed-mode rule rejects kind ∈ {fact, smell}, got "${kind}"` };
  }
  return { ok: true };
}

/** always-mode body size THRESHOLD = 300 UTF-16 code units (D2 §134).
 *  listed mode has no body-size cap because full bodies are read on demand; the
 *  session prompt only receives compact catalog rows.
 *
 *  NOTE (T0 panel 2026-06-07): this is a DEMOTE threshold, not a reject gate.
 *  `writeAbrainRule` auto-demotes an over-threshold always rule to listed rather
 *  than rejecting it. With catalog injection, the threshold now preserves the
 *  stronger always-mode signal as a compact imperative essence. */
// ADR 0024 §7.6 边界注记 (PR-B1 2026-06-12, 盲审收敛 deepseek 5.3): 本阈值属
// **infra 层注入预算约束**（仅 demote 注入模式 always→listed、不影响是否写入），
// **不适用 §7.6 过渡态门的 flip 条件要求**。forward-looking：若未来 curator 获得
// inject_mode 语义裁决能力（LLM 判断长规则是否值得 always），本阈值退为兜底。
export const ALWAYS_BODY_MAX_CODE_UNITS = 300;
export function lintRuleAlwaysSize(body: string, injectMode: RuleInjectMode): LintResult {
  if (injectMode !== "always") return { ok: true };
  const n = body.length; // UTF-16 code units; CJK counts 1 each (D2 note)
  if (n > ALWAYS_BODY_MAX_CODE_UNITS) {
    return { ok: false, reason: `always-mode body is ${n} code units (> ${ALWAYS_BODY_MAX_CODE_UNITS}); demote to listed or shorten` };
  }
  return { ok: true };
}

export const HINT_MAX_CODE_UNITS = 80;
export const HINT_HARD_REJECT_CODE_UNITS = 120;

/** D5.1 sanitizeRuleHint. Order: structural rejects → strips → length →
 *  credential redaction. The hint may become a catalog-row summary every
 *  session, so the goal is preventing accidental NOISE promotion (a stray
 *  markdown/control sequence becoming a system instruction), not adversarial
 *  defense. */
export function sanitizeRuleHint(raw: unknown): HintResult {
  if (typeof raw !== "string") return { ok: false, reason: "hint_not_a_string" };
  let s = raw;
  // (0) strip bidi override / zero-width FIRST. Audit P1-b (2026-06-07): doing
  //     this AFTER the structural rejects let an attacker interleave a
  //     zero-width char to evade them (`` `\u200B`` `` defeats the fence check,
  //     `<!\u200B--` defeats the comment check). The hint may surface in every
  //     session's catalog, so the strip must precede every structural test.
  s = s.replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g, "");
  // (1) strip markdown links/images BEFORE the structural rejects too. Audit
  //     round-2 P1 (2026-06-07): the strip running AFTER the checks let a link
  //     placed INSIDE a forbidden token reassemble it post-strip — e.g.
  //     `` ``[a](b)` `` passes the fence check (no ```), then the strip deletes
  //     `[a](b)` leaving ```` ``` ````. This fires on benign content too
  //     (ruleHintFallback derives hints from body lines with links + backticks).
  //     Stripping first makes the checks see the reassembled string.
  s = s.replace(/!?\[[^\]]*\]\([^)]*\)/g, "");
  // (2) control chars incl. \n \r \t, ANSI ESC (\x1B), DEL + C1 -> reject (hint is single-line)
  if (/[\u0000-\u001F\u007F-\u009F]/.test(s)) return { ok: false, reason: "control_char" };
  // (3) HTML comment + abrain section markers -> reject (injection-section breakout)
  if (/<!--|-->|BEGIN_ABRAIN_RULES|END_ABRAIN_RULES/.test(s)) return { ok: false, reason: "comment_or_section_marker" };
  // (5) code fence -> reject
  if (s.includes("```")) return { ok: false, reason: "code_fence" };
  // (6) tool/role pseudo-instructions -> reject
  if (/(^|\s)(system|assistant|developer)\s*:|ignore previous|run tool|调用工具/i.test(s)) {
    return { ok: false, reason: "role_pseudo_instruction" };
  }
  s = s.trim();
  // (1) length: > 120 reject; else truncate to 80 + ellipsis
  if (s.length > HINT_HARD_REJECT_CODE_UNITS) return { ok: false, reason: "hint_too_long" };
  // .replace strips a trailing lone high-surrogate left when slice() cuts a
  // pair (audit P2, 2026-06-07): avoids a cosmetic � glyph in the hint.
  if (s.length > HINT_MAX_CODE_UNITS) s = `${s.slice(0, HINT_MAX_CODE_UNITS).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
  // (8) credential redaction
  s = redactCredentials(s);
  if (!s.trim()) return { ok: false, reason: "empty_after_sanitize" };
  return { ok: true, clean: s };
}

/** D5.1 hint fallback: derive a hint from the body when none was provided.
 *  First non-empty, non-fence, non-heading line; strip leading markdown
 *  markers; then run the full sanitizeRuleHint. Returns null if no usable
 *  line survives sanitization (caller writes the rule without a hint). */
export function ruleHintFallback(body: string): string | null {
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; } // toggle + skip fence marker
    if (inFence) continue;                                        // skip fenced code content
    if (!line) continue;
    if (line === "---") continue;
    if (/^#{1,6}\s/.test(line)) continue;
    const stripped = line
      .replace(/^[-*+>\s]+/, "")        // list / blockquote markers
      .replace(/^\d+\.\s+/, "")         // ordered list
      .replace(/^\*\*|\*\*$/g, "")      // bold wrappers
      .trim();
    if (!stripped) continue;
    // Audit P1 (2026-06-07): a DERIVED hint must TRUNCATE an over-long line, not
    // skip it. sanitizeRuleHint hard-rejects > HINT_HARD_REJECT_CODE_UNITS, so the
    // old code skipped a long substantive first line and landed on a short
    // afterthought/footnote line — catastrophic for auto-demoted always rules
    // (their bodies ARE long, so the first real line is usually > 120). Pre-clip
    // the candidate so the hint comes from the rule's actual opening line.
    const candidate = stripped.length > HINT_HARD_REJECT_CODE_UNITS
      ? stripped.slice(0, HINT_HARD_REJECT_CODE_UNITS).replace(/[\uD800-\uDBFF]$/, "") // drop lone surrogate from a mid-pair cut
      : stripped;
    const res = sanitizeRuleHint(candidate);
    if (res.ok) return res.clean;
  }
  return null;
}

function yamlScalar(s: string): string {
  // JSON double-quoted strings are valid YAML flow scalars; safe for the
  // single-line slug/title/hint/reason fields written here.
  return JSON.stringify(s);
}

function yamlList(key: string, arr: readonly string[]): string[] {
  const clean = arr.map((v) => String(v).trim()).filter(Boolean);
  if (clean.length === 0) return [];
  return [`${key}:`, ...clean.map((v) => `  - ${yamlScalar(v)}`)];
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(0, Math.round(n)));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export interface RuleEntryId {
  slug: string;
  id: string;
  scope: "global" | "project";
  projectId?: string;
}

/** Compute the canonical rule entry id. The inject mode is part of the id so
 *  the same slug can legitimately exist at both modes during a promote/demote.
 *  (Id format embeds the VALUE, e.g. `rule:global:always:<slug>` — stable
 *  across the §12.3 axis rename.) */
export function ruleEntryId(slug: string, injectMode: RuleInjectMode, scope: RuleScope): RuleEntryId {
  if (scope === "global") {
    return { slug, id: `rule:global:${injectMode}:${slug}`, scope: "global" };
  }
  return { slug, id: `rule:project:${scope.projectId}:${injectMode}:${slug}`, scope: "project", projectId: scope.projectId };
}

export function ruleBodyHash(body: string): string {
  return crypto.createHash("sha256").update(body, "utf-8").digest("hex");
}

/** #2 semantic dedup (T0 consensus 2026-06-07): normalize a rule body to a
 *  comparable token set — drop headings/timeline/markdown markers, lowercase,
 *  split on non-alphanumerics, keep tokens ≥ 2 chars. Used to detect a re-stated
 *  rule (the glab rule was stated twice + had 2 staging entries) so promotion
 *  STRENGTHENS an existing near-match rather than writing a duplicate. */
export function normalizeRuleBodyTokens(body: string): Set<string> {
  const text = body
    .replace(/^##\s*Timeline[\s\S]*$/m, "") // drop the timeline section
    .replace(/^#.*$/gm, "")                  // drop headings
    .replace(/[`*_>#~\[\]()\-]/g, " ")        // drop markdown markers
    .toLowerCase();
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2));
}

/** Jaccard similarity (0..1) of two rule bodies' normalized token sets. */
export function ruleBodySimilarity(a: string, b: string): number {
  const sa = normalizeRuleBodyTokens(a);
  const sb = normalizeRuleBodyTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Default Jaccard threshold above which two rule bodies are 'the same rule
 *  restated'. Audit P1 (2026-06-07): 0.7 FALSE-MERGED short Chinese rules that
 *  differ only in one salient token ('用 pnpm 管理...' vs '用 yarn 管理...' = Jaccard
 *  0.75 — opposite tools, same boilerplate). Raised to 0.85: a false merge LOSES
 *  a distinct rule's intent (worse), while a missed dedup only leaves a harmless
 *  duplicate. Near-verbatim restatements still clear 0.85. */
export const RULE_DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** Build the rule markdown (frontmatter + body + timeline). Assumes `draft.body`
 *  is already sanitized (writeAbrainRule runs sanitizeForMemory upstream) and
 *  `draft.hint`, when present, already passed sanitizeRuleHint. */
export function buildRuleMarkdown(draft: RuleDraft, slug: string): string {
  const ts = new Date().toISOString();
  const status: EntryStatus = draft.status ?? "active";
  if (!(ENTRY_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`buildRuleMarkdown: invalid status "${status}"`);
  }
  const idInfo = ruleEntryId(slug, draft.injectMode, draft.scope);
  const bodyHash = ruleBodyHash(draft.body);

  const fm: string[] = ["---"];
  fm.push(`id: ${yamlScalar(idInfo.id)}`);
  fm.push(`title: ${yamlScalar(draft.title)}`);
  fm.push(`scope: ${idInfo.scope}`);
  if (idInfo.projectId) fm.push(`project_id: ${yamlScalar(idInfo.projectId)}`);
  fm.push(`kind: ${yamlScalar(draft.kind)}`);
  fm.push(`status: ${yamlScalar(status)}`);
  // AX-PROVENANCE: record the TRUE source. Default to assistant-observed
  // (conservative) so a rule created by the autonomous curator/extractor is NOT
  // mislabeled user-expressed; the Tier-1 path sets provenance=user-expressed
  // explicitly (audit P1 2026-06-07).
  const provenance: ProvenanceClass = draft.provenance && (PROVENANCE_CLASSES as readonly string[]).includes(draft.provenance)
    ? draft.provenance : "assistant-observed";
  fm.push(`provenance: ${yamlScalar(provenance)}`);
  fm.push(`confidence: ${clampConfidence(draft.entryConfidence)}`);
  // ADR 0028 §12.3: frontmatter key renamed tier -> inject_mode. Reads are
  // directory-derived (rules/always|listed/), so legacy files keeping a stale
  // `tier:` line need no migration — the line is cosmetic and dies on rewrite.
  fm.push(`inject_mode: ${yamlScalar(draft.injectMode)}`);
  if (draft.hint) fm.push(`hint: ${yamlScalar(draft.hint)}`);
  fm.push(`body_hash: ${bodyHash}`);
  fm.push(...yamlList("trigger_phrases", draft.triggerPhrases ?? []));
  fm.push(...yamlList("tags", draft.tags ?? []));
  fm.push(...yamlList("derives_from", draft.derivesFrom ?? []));
  if (draft.promotedFrom) fm.push(`promoted_from: ${yamlScalar(draft.promotedFrom)}`);
  if (draft.sourceBodyHash) fm.push(`source_body_hash: ${yamlScalar(draft.sourceBodyHash)}`);
  fm.push(`routing_reason: ${yamlScalar(draft.routingReason)}`);
  fm.push(`routing_confidence: ${clamp01(draft.routingConfidence)}`);
  fm.push(`created: ${yamlScalar(ts)}`);
  fm.push(`updated: ${yamlScalar(ts)}`);
  fm.push(`schema_version: 1`);
  fm.push("---");

  let body = draft.body.trim();
  body = body.replace(/^---$/gm, " ---"); // frontmatter break-out guard
  if (!/^#\s+/m.test(body)) body = `# ${draft.title}\n\n${body}`;

  const timeline = `## Timeline\n- ${ts} | ${draft.sessionId || "sediment"} | created | ${draft.routingReason}`;
  return `${fm.join("\n")}\n\n${body.trim()}\n\n${timeline}\n`;
}
