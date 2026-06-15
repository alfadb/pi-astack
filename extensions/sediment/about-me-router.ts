/**
 * Lane G / About-me router (ADR 0021)
 *
 * Implements the deterministic router specified in ADR 0014 §3.5 for Lane G
 * writes. Three stages:
 *
 *   Stage 1 — Lane allowlist (deterministic, this file)
 *     Lane "about_me" can ONLY route to identity/skills/habits/staging.
 *     Lane G hard exclusions (rule 4 of validateRouteDecision): NEVER
 *     knowledge/workflows/projects.
 *
 *   Stage 2 — Aboutness classifier (LLM, NOT implemented in G1 — see
 *     ADR 0021 phase G3). For G1, the caller (fence extractor or
 *     /about-me slash) supplies an explicit `region` and confidence;
 *     the LLM step lands in a later phase.
 *
 *   Stage 3 — Staging gate (this file)
 *     routing_confidence < ROUTING_CONFIDENCE_THRESHOLD → must route
 *     to "staging" region; any other region throws RouterError so the
 *     writer rejects + writes a route_rejected audit.
 *
 * This module deliberately has ZERO runtime dependencies on writer.ts,
 * memory parsers, or sediment LLM kernels — it is a pure validator so
 * any caller (writer, extractor smoke, future curator pre-check) can
 * compose it without circular import.
 */

export type AboutMeLane = "about_me";
export type AboutMeRegion = "identity" | "skills" | "habits" | "staging";

export interface RouteDecision {
  lane: AboutMeLane;
  chosen_region: AboutMeRegion;
  route_candidates: AboutMeRegion[];
  routing_reason: string;
  routing_confidence: number;
}

export class RouterError extends Error {
  readonly rule: number;
  constructor(rule: number, message: string) {
    super(message);
    this.name = "RouterError";
    this.rule = rule;
  }
}

/** Routing-confidence floor for the (future) G3 LLM region classifier path.
 *
 * AI-Native flip/removal condition (REQ-003 / direction.md §2 — transition-state
 * mechanical gate must declare its removal condition):
 *   - This floor applies ONLY to the G3 path where an LLM classifier emits
 *     region + routing_confidence for fences that OMIT an explicit region.
 *   - In G1/G2 the fence carries a user-attested `region:` header → confidence
 *     defaults to 1.0, so this floor never fires on the current (shipped) path.
 *   - REMOVE this constant (route region selection entirely through the
 *     classifier's own prompt-level self-assessment) once the G3 classifier
 *     ships AND its downstream-grounded region accuracy is validated. Until
 *     then it stays as the documented transition guard, NOT a permanent gate.
 * Default per ADR 0014 §3.5 v1.2 (was "configurable later via
 * ~/.abrain/.state/facade-config.yaml in G4"). */
export const ROUTING_CONFIDENCE_THRESHOLD = 0.6;

/** Lane allowlist per ADR 0014 §3.5 Stage 1.  Hard-coded to defeat any
 *  future "lane forgot to declare allowlist" regression — adding a new
 *  region (e.g. "values") requires an explicit edit here, not a config
 *  change. */
export const LANE_G_ALLOWED_REGIONS: ReadonlyArray<AboutMeRegion> = Object.freeze([
  "identity",
  "skills",
  "habits",
  "staging",
]);

/** Regions Lane G must NEVER write to (per ADR 0014 §3.5 rule 4).
 *  Kept as a separate explicit blocklist for grep-ability + so a future
 *  rename of `knowledge` / `workflows` / `projects` won't silently break
 *  the exclusion. */
const LANE_G_HARD_EXCLUDED_REGIONS = Object.freeze<string[]>([
  "knowledge",
  "workflows",
  "projects",
  "vault",
]);

/**
 * Enforceable router gate per ADR 0014 §3.5 v1.2 (Round 4 GPT P1-N4).
 *
 * Throws RouterError on any of the 6 rules listed below. Writer MUST call
 * this before any markdown write — see writeAbrainAboutMe.
 *
 * Rules:
 *   1. lane allowlist                — chosen_region must be in LANE_G_ALLOWED_REGIONS
 *   2. chosen ∈ candidates           — chosen_region must appear in route_candidates
 *   3. confidence gate               — confidence < threshold ⇒ must be staging
 *   4. Lane G hard exclusions        — chosen_region must NOT be knowledge/workflows/projects/vault
 *   5. (Lane C-only — not enforced for about_me lane in this validator)
 *   6. fields completeness           — all 5 fields must be present + non-empty
 */
export function validateRouteDecision(d: RouteDecision): void {
  // Rule 6: fields completeness — check first so other rule failures
  // have non-empty data to reference.
  if (!d || typeof d !== "object") {
    throw new RouterError(6, "RouteDecision: not an object");
  }
  if (d.lane !== "about_me") {
    throw new RouterError(6, `RouteDecision.lane: only "about_me" supported by this validator, got ${JSON.stringify(d.lane)}`);
  }
  if (typeof d.chosen_region !== "string" || d.chosen_region.length === 0) {
    throw new RouterError(6, `RouteDecision.chosen_region: missing or empty`);
  }
  if (!Array.isArray(d.route_candidates) || d.route_candidates.length === 0) {
    throw new RouterError(6, `RouteDecision.route_candidates: missing or empty array`);
  }
  if (typeof d.routing_reason !== "string" || d.routing_reason.trim().length === 0) {
    throw new RouterError(6, `RouteDecision.routing_reason: missing or empty`);
  }
  if (typeof d.routing_confidence !== "number" || !Number.isFinite(d.routing_confidence)) {
    throw new RouterError(6, `RouteDecision.routing_confidence: must be a finite number`);
  }
  if (d.routing_confidence < 0 || d.routing_confidence > 1) {
    throw new RouterError(6, `RouteDecision.routing_confidence: out of [0,1] range, got ${d.routing_confidence}`);
  }

  // Rule 4: Lane G hard exclusions (check BEFORE rule 1 so the error
  // message is specific to the policy violation, not just "not in list").
  if (LANE_G_HARD_EXCLUDED_REGIONS.includes(d.chosen_region)) {
    throw new RouterError(
      4,
      `Lane G cannot write to ${d.chosen_region} (about-me is about ME, not the world); use a different lane`,
    );
  }

  // Rule 1: lane allowlist.
  if (!LANE_G_ALLOWED_REGIONS.includes(d.chosen_region)) {
    throw new RouterError(
      1,
      `chosen_region ${JSON.stringify(d.chosen_region)} not in Lane G allowlist [${LANE_G_ALLOWED_REGIONS.join(", ")}]`,
    );
  }

  // Rule 2: chosen ∈ candidates. Allows downgrade-to-staging where
  // staging is added to candidates by Stage 3 itself; the writer's
  // caller must include "staging" in candidates if staging is chosen.
  if (!d.route_candidates.includes(d.chosen_region)) {
    throw new RouterError(
      2,
      `chosen_region ${JSON.stringify(d.chosen_region)} not in route_candidates [${d.route_candidates.join(", ")}]`,
    );
  }

  // Rule 3: confidence gate.
  if (d.routing_confidence < ROUTING_CONFIDENCE_THRESHOLD && d.chosen_region !== "staging") {
    throw new RouterError(
      3,
      `routing_confidence ${d.routing_confidence} < threshold ${ROUTING_CONFIDENCE_THRESHOLD} must route to "staging", got ${d.chosen_region}`,
    );
  }
}

/**
 * Apply Stage 3 staging downgrade automatically. Returns a normalized
 * decision where low-confidence cases are forced to `staging` (preserving
 * the original chosen_region inside route_candidates so audit retains it).
 *
 * Caller can use this to convert a raw Stage 2 LLM output into a
 * validateRouteDecision-ready RouteDecision; this is the recommended
 * composition path for the future G3 LLM classifier.
 */
export function applyStagingDowngrade(raw: RouteDecision): RouteDecision {
  if (raw.routing_confidence >= ROUTING_CONFIDENCE_THRESHOLD) return raw;
  if (raw.chosen_region === "staging") return raw;
  // Build the downgraded candidates list:
  //   1. preserve every original candidate (for review-staging audit)
  //   2. ensure original chosen_region is in there (caller may have passed
  //      chosen separately from candidates)
  //   3. ALWAYS append "staging" — it's the new chosen_region; without
  //      this validateRouteDecision rule 2 (chosen ∈ candidates) would
  //      reject our own downgrade output. Discovered by smoke 2026-05-15.
  const candidates: AboutMeRegion[] = [...raw.route_candidates];
  if (!candidates.includes(raw.chosen_region)) candidates.unshift(raw.chosen_region);
  if (!candidates.includes("staging")) candidates.push("staging");
  return {
    ...raw,
    chosen_region: "staging",
    route_candidates: candidates,
    routing_reason: `${raw.routing_reason} (downgraded: confidence ${raw.routing_confidence} < ${ROUTING_CONFIDENCE_THRESHOLD})`,
  };
}
