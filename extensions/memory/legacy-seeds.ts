/**
 * Legacy Pensieve bootstrap seeds.
 *
 * The archived pre-rewrite Pensieve skill (see
 * `~/.pi/archived/pensieve-pre-rewrite/.src/templates/` and
 * `init-project-data.sh`) copied these files into every project's `.pensieve/`
 * on first init. They are not project-local knowledge: per-repo migration
 * must prune them from `.pensieve/` so they don't pollute
 * `~/.abrain/projects/<id>/`.
 *
 * Two prune categories:
 *
 *   - `extract`: legacy seed whose canonical copy is the alfadb-curated entry
 *     in `~/.abrain/knowledge/<file>.md` (manually refined from the template).
 *     The 5 knowledge/maxim seeds fall here: Linus/Ousterhout/Google taste
 *     review and 4 derived maxims.
 *
 *   - `obsolete`: legacy seed whose design no longer matches pi-astack. The
 *     4 `pipelines/run-when-*.md` workflow seeds fall here:
 *     - `run-when-committing` told the main session to manually decide
 *       whether to sediment and then call `self-improve.md`; modern
 *       pi-astack runs sediment automatically on `agent_end`, and AGENTS.md
 *       forbids the main session from writing memory directly.
 *     - `run-when-planning` is already covered by AGENTS.md "动手前先查
 *       pensieve" + `memory_search`; the seed's `grep .pensieve/...` flow
 *       is dead.
 *     - `run-when-reviewing-code` task blueprint is reasonable but its
 *       sediment step conflicts with auto-write; a user-level
 *       `prompts/review.md` template is the right surface today.
 *     - `run-when-syncing-to-main` is Pensieve's own zh→main translation
 *       process; project-specific, not cross-project useful.
 *     These seeds are pruned without a global replacement.
 */

export type LegacyPensieveSeedKind = "maxim" | "fact" | "workflow";
export type LegacyPensieveSeedDisposition = "extract" | "obsolete";

export interface LegacyPensieveSeed {
  relPath: string;
  id: string;
  slug: string;
  title: string;
  kind: LegacyPensieveSeedKind;
  disposition: LegacyPensieveSeedDisposition;
  /** Canonical global copy under `~/.abrain/...`. Only set when
   *  `disposition === "extract"`. */
  globalTarget?: string;
  /** Free-form note explaining why the seed is `obsolete`. Only set when
   *  `disposition === "obsolete"`. */
  obsoleteReason?: string;
}

const LEGACY_PENSIEVE_SEEDS: LegacyPensieveSeed[] = [
  {
    relPath: "knowledge/taste-review/content.md",
    id: "taste-review-content",
    slug: "taste-review-content",
    title: "代码品味审查知识库",
    kind: "fact",
    disposition: "extract",
    globalTarget: "knowledge/taste-review-content.md",
  },
  {
    relPath: "maxims/eliminate-special-cases-by-redesigning-data-flow.md",
    id: "eliminate-special-cases-by-redesigning-data-flow",
    slug: "eliminate-special-cases-by-redesigning-data-flow",
    title: "Eliminate special cases by redesigning data flow",
    kind: "maxim",
    disposition: "extract",
    globalTarget: "knowledge/eliminate-special-cases-by-redesigning-data-flow.md",
  },
  {
    relPath: "maxims/prefer-pragmatic-solutions-over-theoretical-completeness.md",
    id: "prefer-pragmatic-solutions-over-theoretical-completeness",
    slug: "prefer-pragmatic-solutions-over-theoretical-completeness",
    title: "Prefer pragmatic solutions over theoretical completeness",
    kind: "maxim",
    disposition: "extract",
    globalTarget: "knowledge/prefer-pragmatic-solutions-over-theoretical-completeness.md",
  },
  {
    relPath: "maxims/preserve-user-visible-behavior-as-a-hard-rule.md",
    id: "preserve-user-visible-behavior-as-a-hard-rule",
    slug: "preserve-user-visible-behavior-as-a-hard-rule",
    title: "Preserve user-visible behavior as a hard rule",
    kind: "maxim",
    disposition: "extract",
    globalTarget: "knowledge/preserve-user-visible-behavior-as-a-hard-rule.md",
  },
  {
    relPath: "maxims/reduce-complexity-before-adding-branches.md",
    id: "reduce-complexity-before-adding-branches",
    slug: "reduce-complexity-before-adding-branches",
    title: "Reduce complexity before adding branches",
    kind: "maxim",
    disposition: "extract",
    globalTarget: "knowledge/reduce-complexity-before-adding-branches.md",
  },
  {
    relPath: "pipelines/run-when-committing.md",
    id: "run-when-committing",
    slug: "run-when-committing",
    title: "提交 Pipeline",
    kind: "workflow",
    disposition: "obsolete",
    obsoleteReason: "sediment auto-writes on agent_end; main session must not call legacy self-improve",
  },
  {
    relPath: "pipelines/run-when-planning.md",
    id: "run-when-planning",
    slug: "run-when-planning",
    title: "规划前知识检索 Pipeline",
    kind: "workflow",
    disposition: "obsolete",
    obsoleteReason: "covered by AGENTS.md '动手前先查 pensieve' + memory_search; legacy grep paths dead",
  },
  {
    relPath: "pipelines/run-when-reviewing-code.md",
    id: "run-when-reviewing-code",
    slug: "run-when-reviewing-code",
    title: "代码审查 Pipeline",
    kind: "workflow",
    disposition: "obsolete",
    obsoleteReason: "sediment auto-writes on agent_end; user-level review prompts/template is the right surface",
  },
  {
    relPath: "pipelines/run-when-syncing-to-main.md",
    id: "run-when-syncing-to-main",
    slug: "run-when-syncing-to-main",
    title: "Sync to Main Pipeline",
    kind: "workflow",
    disposition: "obsolete",
    obsoleteReason: "Pensieve project-specific zh→main translation; not cross-project useful",
  },
];

const LEGACY_PENSIEVE_SEEDS_BY_PATH = new Map(
  LEGACY_PENSIEVE_SEEDS.map((seed) => [seed.relPath, seed]),
);

function normalizeRelPath(relPath: string): string {
  return relPath.split(/[\\/]+/).filter(Boolean).join("/");
}

// 2026-05-24 fix: align with parser.parseFrontmatter return shape
// (Record<string, Jsonish>). Was `unknown` — type noise only (function
// does its own typeof narrowing so runtime unaffected), but tightening
// the contract makes callers fail at compile time when they pass a
// non-frontmatter object by mistake.
function frontmatterString(frontmatter: Record<string, import("./types").Jsonish>, key: string): string {
  const value = frontmatter[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeLegacyId(id: string): string {
  return id.replace(/^project:[^:]+:/, "").replace(/^workflow:/, "").trim();
}

export function legacyPensieveSeedFor(
  relSource: string,
  // 2026-05-24 fix: align with parser.parseFrontmatter return shape.
  frontmatter: Record<string, import("./types").Jsonish>,
): LegacyPensieveSeed | null {
  const seed = LEGACY_PENSIEVE_SEEDS_BY_PATH.get(normalizeRelPath(relSource));
  if (!seed) return null;

  const id = normalizeLegacyId(frontmatterString(frontmatter, "id"));
  const name = frontmatterString(frontmatter, "name");

  // Path alone would be too broad: users can intentionally create a project
  // entry with a formerly-seeded filename. Require the original seed identity
  // (id, or name for legacy pipelines) to avoid pruning user-authored data.
  if (id === seed.id || name === seed.id) return seed;
  return null;
}

export function legacyPensieveSeedDryRunReason(seed: LegacyPensieveSeed): string {
  if (seed.disposition === "extract" && seed.globalTarget) {
    return `legacy Pensieve seed; canonical copy at global abrain ${seed.globalTarget}`;
  }
  return `legacy Pensieve seed (obsolete: ${seed.obsoleteReason ?? "design no longer matches pi-astack"})`;
}

export function legacyPensieveSeedPrunedReason(seed: LegacyPensieveSeed): string {
  if (seed.disposition === "extract" && seed.globalTarget) {
    return `legacy Pensieve seed pruned; canonical copy lives at global abrain ${seed.globalTarget}`;
  }
  return `legacy Pensieve seed pruned (obsolete: ${seed.obsoleteReason ?? "design no longer matches pi-astack"})`;
}
