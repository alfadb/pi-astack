/**
 * rule-writer — ADR 0023 D5 write-path: rule-specific substrate.
 *
 * This module holds the PURE, side-effect-free rule logic (draft type, hint
 * sanitize + fallback, kind/size lints, markdown build). The fs-bound
 * orchestration (`writeAbrainRule` + lifecycle writers, mirroring
 * `writeAbrainWorkflow`) and `lintRuleBudget` (reads the rules dir) live in
 * `writer.ts` and call into these helpers. Splitting the pure logic out keeps
 * the rule-specific contract unit-testable without a real abrain tree.
 *
 * Invariants implemented here:
 *  - INV-R4 (kind 限制): `lintRuleKind` — always ∈ {maxim,preference,anti-pattern};
 *    listed rejects {fact,smell}.
 *  - lintRuleAlwaysSize: always-tier body ≤ 300 UTF-16 code units (D2 §134).
 *  - D5.1 `sanitizeRuleHint`: hint is injected into the system prompt every
 *    session, so it is a noise-promotion surface (NOT adversarial prompt
 *    injection — see ADR §1.4). Structural reject/strip rules below.
 *  - body_hash: D5.1 — frontmatter carries sha256(body) so the rule-injector
 *    can detect hint/body drift on compose.
 *  - F-W2 provenance: `derives_from` / `promoted_from` / `source_body_hash`
 *    link a promoted rule back to its source knowledge entry (reconciliation
 *    anchor for the deferred region-move).
 */

import * as crypto from "node:crypto";

import { redactCredentials } from "../abrain/redact";
import { ENTRY_KINDS, ENTRY_STATUSES, type EntryKind, type EntryStatus } from "./validation";

export type RuleTier = "always" | "listed";
export type RuleScope = "global" | { projectId: string };

/** ADR 0023 D5 RuleDraft (R4-simplified: no evidenceSource/evidenceQuote/
 *  userBackingTurnIndex). `scope` is "global" or a project binding. */
export interface RuleDraft {
  title: string;
  body: string;
  zone: "rules";
  tier: RuleTier;
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
  // F-W2 provenance link (knowledge -> rules promotion reconciliation anchor)
  derivesFrom?: string[];
  promotedFrom?: string;
  sourceBodyHash?: string;
}

export type LintResult = { ok: true } | { ok: false; reason: string };
export type HintResult = { ok: true; clean: string } | { ok: false; reason: string };

const ALWAYS_KINDS: ReadonlySet<string> = new Set(["maxim", "preference", "anti-pattern"]);
const LISTED_REJECT_KINDS: ReadonlySet<string> = new Set(["fact", "smell"]);

/** INV-R4: tier=always requires kind ∈ {maxim,preference,anti-pattern};
 *  tier=listed rejects kind ∈ {fact,smell}. */
export function lintRuleKind(kind: string, tier: RuleTier): LintResult {
  if (!(ENTRY_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `unknown kind "${kind}" (must be one of: ${ENTRY_KINDS.join(", ")})` };
  }
  if (tier === "always") {
    if (!ALWAYS_KINDS.has(kind)) {
      return { ok: false, reason: `always-tier rule requires kind ∈ {maxim, preference, anti-pattern}, got "${kind}"` };
    }
  } else if (LISTED_REJECT_KINDS.has(kind)) {
    return { ok: false, reason: `listed-tier rule rejects kind ∈ {fact, smell}, got "${kind}"` };
  }
  return { ok: true };
}

/** always-tier compiled body must be ≤ 300 UTF-16 code units (D2 §134).
 *  listed-tier has no body-size cap (it injects only a hint, not the body). */
export const ALWAYS_BODY_MAX_CODE_UNITS = 300;
export function lintRuleAlwaysSize(body: string, tier: RuleTier): LintResult {
  if (tier !== "always") return { ok: true };
  const n = body.length; // UTF-16 code units; CJK counts 1 each (D2 note)
  if (n > ALWAYS_BODY_MAX_CODE_UNITS) {
    return { ok: false, reason: `always-tier body is ${n} code units (> ${ALWAYS_BODY_MAX_CODE_UNITS}); demote to listed or shorten` };
  }
  return { ok: true };
}

export const HINT_MAX_CODE_UNITS = 80;
export const HINT_HARD_REJECT_CODE_UNITS = 120;

/** D5.1 sanitizeRuleHint. Order: structural rejects → strips → length →
 *  credential redaction. The hint rides into the system prompt every session,
 *  so the goal is preventing accidental NOISE promotion (a stray markdown/
 *  control sequence becoming a system instruction), not adversarial defense. */
export function sanitizeRuleHint(raw: unknown): HintResult {
  if (typeof raw !== "string") return { ok: false, reason: "hint_not_a_string" };
  let s = raw;
  // (2) control chars incl. \n \r \t and ANSI ESC (\x1B) -> reject (hint is single-line)
  if (/[\u0000-\u001F]/.test(s)) return { ok: false, reason: "control_char" };
  // (3) HTML comment + abrain section markers -> reject (injection-section breakout)
  if (/<!--|-->|BEGIN_ABRAIN_RULES|END_ABRAIN_RULES/.test(s)) return { ok: false, reason: "comment_or_section_marker" };
  // (5) code fence -> reject
  if (s.includes("```")) return { ok: false, reason: "code_fence" };
  // (6) tool/role pseudo-instructions -> reject
  if (/(^|\s)(system|assistant|developer)\s*:|ignore previous|run tool|调用工具/i.test(s)) {
    return { ok: false, reason: "role_pseudo_instruction" };
  }
  // (4) strip markdown links / images
  s = s.replace(/!?\[[^\]]*\]\([^)]*\)/g, "");
  // (7) strip bidi override / zero-width (ANSI ESC already rejected at step 2)
  s = s.replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g, "");
  s = s.trim();
  // (1) length: > 120 reject; else truncate to 80 + ellipsis
  if (s.length > HINT_HARD_REJECT_CODE_UNITS) return { ok: false, reason: "hint_too_long" };
  if (s.length > HINT_MAX_CODE_UNITS) s = `${s.slice(0, HINT_MAX_CODE_UNITS).trimEnd()}…`;
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
    const res = sanitizeRuleHint(stripped);
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

/** Compute the canonical rule entry id. Tier is part of the id so the same
 *  slug can legitimately exist at both tiers during a promote/demote. */
export function ruleEntryId(slug: string, tier: RuleTier, scope: RuleScope): RuleEntryId {
  if (scope === "global") {
    return { slug, id: `rule:global:${tier}:${slug}`, scope: "global" };
  }
  return { slug, id: `rule:project:${scope.projectId}:${tier}:${slug}`, scope: "project", projectId: scope.projectId };
}

export function ruleBodyHash(body: string): string {
  return crypto.createHash("sha256").update(body, "utf-8").digest("hex");
}

/** Build the rule markdown (frontmatter + body + timeline). Assumes `draft.body`
 *  is already sanitized (writeAbrainRule runs sanitizeForMemory upstream) and
 *  `draft.hint`, when present, already passed sanitizeRuleHint. */
export function buildRuleMarkdown(draft: RuleDraft, slug: string): string {
  const ts = new Date().toISOString();
  const status: EntryStatus = draft.status ?? "active";
  if (!(ENTRY_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`buildRuleMarkdown: invalid status "${status}"`);
  }
  const idInfo = ruleEntryId(slug, draft.tier, draft.scope);
  const bodyHash = ruleBodyHash(draft.body);

  const fm: string[] = ["---"];
  fm.push(`id: ${yamlScalar(idInfo.id)}`);
  fm.push(`title: ${yamlScalar(draft.title)}`);
  fm.push(`scope: ${idInfo.scope}`);
  if (idInfo.projectId) fm.push(`project_id: ${yamlScalar(idInfo.projectId)}`);
  fm.push(`kind: ${yamlScalar(draft.kind)}`);
  fm.push(`status: ${yamlScalar(status)}`);
  fm.push(`confidence: ${clampConfidence(draft.entryConfidence)}`);
  fm.push(`tier: ${draft.tier}`);
  if (draft.hint) fm.push(`hint: ${yamlScalar(draft.hint)}`);
  fm.push(`body_hash: ${bodyHash}`);
  fm.push(...yamlList("trigger_phrases", draft.triggerPhrases ?? []));
  fm.push(...yamlList("tags", draft.tags ?? []));
  fm.push(...yamlList("derives_from", draft.derivesFrom ?? []));
  if (draft.promotedFrom) fm.push(`promoted_from: ${yamlScalar(draft.promotedFrom)}`);
  if (draft.sourceBodyHash) fm.push(`source_body_hash: ${draft.sourceBodyHash}`);
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
