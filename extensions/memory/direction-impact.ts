import type { Jsonish } from "./types";

/**
 * direction_impact — ADR 0034 §2.2 (Accepted 2026-06-13).
 *
 * Records that a memory entry (typically an ingested ADR-mechanism detail)
 * touches a consensus-layer invariant / requirement, plus the escalation
 * state of that touch. This is the structured return path of the README §4
 * 承重墙: when a detail `narrows`/`weakens`/`conflicts` with a direction
 * invariant, it MUST be escalated — never silently accepted.
 *
 * ENCODING (flat frontmatter, NOT a nested map). parser.ts::parseFrontmatter
 * skips indented continuation lines (`if (/^\s/.test(line)) continue;`) so a
 * nested YAML mapping is unparseable; the only structures it round-trips are
 * top-level scalars and `- item` lists. We therefore encode each impact as a
 * single pipe-delimited string and store them as a YAML list:
 *
 *   direction_impact:
 *     - "weakens | direction.md#INV-AUTONOMY | required | docs/notes/foo.md"
 *     - "supports | requirements.md#REQ-003 | none"
 *
 * A single impact may also be inline: `direction_impact: touches | direction.md#INV-INVISIBILITY | none`.
 *
 * Field order: "<relation> | <ref> | <escalation>[ | <proposal_ref>]".
 * proposal_ref is the optional tail (may itself contain spaces).
 */

export const DIRECTION_IMPACT_RELATIONS = [
  "supports", "depends_on", "touches", "narrows", "weakens", "conflicts",
] as const;
export type DirectionImpactRelation = typeof DIRECTION_IMPACT_RELATIONS[number];

export const DIRECTION_IMPACT_ESCALATIONS = [
  "none", "required", "proposed", "accepted", "rejected",
] as const;
export type DirectionImpactEscalation = typeof DIRECTION_IMPACT_ESCALATIONS[number];

/**
 * 红线 (ADR 0034 §2.2 / acceptance ⑦): a detail whose relation is one of these
 * MUST carry an escalation other than "none" — it cannot be silently accepted.
 */
export const ESCALATION_REQUIRED_RELATIONS: ReadonlySet<string> = new Set([
  "narrows", "weakens", "conflicts",
]);

/** ref must anchor a direction.md#INV-* or requirements.md#REQ-* target. */
const REF_RE = /^(direction\.md#INV-[A-Za-z0-9-]+|requirements\.md#REQ-[A-Za-z0-9-]+)$/;

export interface DirectionImpact {
  relation: DirectionImpactRelation;
  ref: string;
  escalation: DirectionImpactEscalation;
  proposalRef?: string;
  /** Original frontmatter string, preserved for diagnostics. */
  raw: string;
}

export interface DirectionImpactIssue {
  severity: "error" | "warning";
  message: string;
  raw: string;
}

export interface DirectionImpactParse {
  impacts: DirectionImpact[];
  issues: DirectionImpactIssue[];
}

/** Normalize a raw frontmatter value (string | string[] | absent) to a list. */
function toRawList(value: Jsonish | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((s) => s.length > 0);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const s = String(value).trim();
    return s ? [s] : [];
  }
  // Object form is unsupported (parser.ts cannot produce a nested map here).
  return [];
}

/**
 * Parse + validate a `direction_impact` frontmatter value. Pure / total /
 * never throws. Invalid rows are dropped from `impacts` and reported in
 * `issues`; callers (lint.ts read-side, validation.ts write-side) surface them.
 */
export function parseDirectionImpact(value: Jsonish | undefined): DirectionImpactParse {
  const impacts: DirectionImpact[] = [];
  const issues: DirectionImpactIssue[] = [];

  for (const raw of toRawList(value)) {
    const parts = raw.split("|").map((p) => p.trim());
    if (parts.length < 3) {
      issues.push({
        severity: "error",
        raw,
        message: `direction_impact must be "<relation> | <ref> | <escalation>[ | <proposal_ref>]"`,
      });
      continue;
    }
    const relation = parts[0];
    const ref = parts[1];
    const escalation = parts[2];
    const proposalRef = parts.length > 3 ? parts.slice(3).join(" | ").trim() : undefined;

    let ok = true;
    if (!(DIRECTION_IMPACT_RELATIONS as readonly string[]).includes(relation)) {
      issues.push({
        severity: "error",
        raw,
        message: `invalid relation "${relation}" (must be one of: ${DIRECTION_IMPACT_RELATIONS.join(", ")})`,
      });
      ok = false;
    }
    if (!REF_RE.test(ref)) {
      issues.push({
        severity: "error",
        raw,
        message: `invalid ref "${ref}" (must be direction.md#INV-* or requirements.md#REQ-*)`,
      });
      ok = false;
    }
    if (!(DIRECTION_IMPACT_ESCALATIONS as readonly string[]).includes(escalation)) {
      issues.push({
        severity: "error",
        raw,
        message: `invalid escalation "${escalation}" (must be one of: ${DIRECTION_IMPACT_ESCALATIONS.join(", ")})`,
      });
      ok = false;
    }
    // 红线: narrows/weakens/conflicts must be escalated (not silently accepted).
    if (ok && ESCALATION_REQUIRED_RELATIONS.has(relation) && escalation === "none") {
      issues.push({
        severity: "error",
        raw,
        message: `relation "${relation}" touches a direction invariant and MUST be escalated — escalation must not be "none" (ADR 0034 §2.2 承重墙)`,
      });
      ok = false;
    }

    if (ok) {
      impacts.push({
        relation: relation as DirectionImpactRelation,
        ref,
        escalation: escalation as DirectionImpactEscalation,
        ...(proposalRef ? { proposalRef } : {}),
        raw,
      });
    }
  }

  return { impacts, issues };
}
