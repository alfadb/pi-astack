import type { DirectionImpact } from "./direction-impact";

export type Scope = "project" | "world";

export type Jsonish = string | number | boolean | null | Jsonish[] | { [k: string]: Jsonish };

export interface StoreRef {
  scope: Scope;
  root: string;
  label: string;
  /** ADR 0039 B-prep blocker③: optional bounded file allow-list. When set,
   *  scanStore reads ONLY these files instead of walking `root`. Used by the
   *  knowledge projection OVERLAY reader to enforce count/token/time caps
   *  (freshest-within-budget); all other stores leave it undefined (full walk). */
  files?: string[];
}

export interface MemoryEntry {
  slug: string;
  id?: string;
  scope: Scope;
  /**
   * Normalized kind — ALWAYS one of the canonical 7 enum values
   * (maxim/decision/anti-pattern/pattern/fact/preference/smell) per
   * sediment/validation.ts::ENTRY_KINDS. Legacy aliases
   * (`pipeline`/`knowledge`) and unknown values are folded into the
   * closest canonical kind by parser.ts::normalizeKind. The original
   * raw value, if non-canonical, is preserved in `legacyKind` for
   * doctor/migration diagnostics; the LLM only ever sees normalized
   * `kind`. (2026-05-15 memory audit fix.)
   */
  kind: string;
  /**
   * Normalized status — ALWAYS one of the canonical 6 enum values per
   * sediment/validation.ts::ENTRY_STATUSES. Unknown values fold to
   * `provisional` (neutral; not subject to the default archived
   * exclusion). Original preserved in `legacyStatus`. (2026-05-15.)
   */
  status: string;
  /** Original frontmatter kind if it was non-canonical / legacy alias. */
  legacyKind?: string;
  /** Original frontmatter status if it was non-canonical. */
  legacyStatus?: string;
  confidence: number;
  /** AX-PROVENANCE (ADR 0028 §12): stored ground-truth-strength axis.
   *  Defaults to assistant-observed for legacy entries lacking frontmatter. */
  provenance: string;
  title: string;
  summary: string;
  created?: string;
  updated?: string;
  sourcePath: string;
  displayPath: string;
  storeRoot: string;
  frontmatter: Record<string, Jsonish>;
  compiledTruth: string;
  timeline: string[];
  relatedSlugs: string[];
  relations: RelationEdge[];
  /** ADR 0034 §2.2 direction_impact: parsed + validated touches on consensus
   *  invariants/requirements. Absent when frontmatter has none. Invalid rows
   *  are dropped here (surfaced by lint/doctor), so this only holds valid ones. */
  directionImpact?: DirectionImpact[];
  tokenCounts: Map<string, number>;
  tokenTotal: number;
}

/**
 * Resolved scope hint for a wikilink / relation target.
 *
 *   - `world`    : explicit `[[world:foo]]` / `abrain://world/...`
 *                  → resolve against `~/.abrain/knowledge/`
 *   - `workflow` : explicit `[[workflow:foo]]` / `abrain://workflow/...`
 *                  → resolve against `~/.abrain/workflows/`
 *   - `project`  : explicit `[[project:<id>:foo]]` / `abrain://projects/<id>/...`
 *                  Cross-project reference; `qualifier` carries `<id>`.
 *                  Currently parsed but not resolved by buildGraphSnapshot.
 *   - `unknown`  : user-defined typed-link prefix (e.g. `[[person:alfadb]]`,
 *                  `[[company:openai]]`). `qualifier` carries the prefix.
 *                  Slug extraction still works; not used for scope routing.
 *   - undefined  : implicit bare `[[foo]]` — resolve project-internal,
 *                  optionally fall back to global (transitional compatibility).
 */
export type RelationScope = "world" | "workflow" | "project" | "unknown";

export interface RelationEdge {
  to: string;
  type: string;
  source: "frontmatter" | "body_wikilink";
  /** Explicit scope from a prefixed wikilink / URL. undefined = implicit. */
  scope?: RelationScope;
  /** Extra qualifier: project id when scope==="project"; raw prefix when
   *  scope==="unknown" (e.g. "person", "company"). */
  qualifier?: string;
}

export interface SearchParams {
  query: string;
  filters?: SearchFilters;
}

export interface SearchFilters {
  kinds?: string[];
  status?: string[];
  limit?: number;
}

export interface ListFilters extends SearchFilters {
  // scope intentionally not exposed to LLM (Facade per memory-architecture.md §3 +
  // brain-redesign-spec.md §4.3): list is a browse/debug surface, not a routing
  // selector. Internal callers needing scope routing should slice the loaded
  // entries array directly.
  cursor?: string;
}

export interface GetParams {
  slug: string;
  options?: { include_related?: boolean };
}
