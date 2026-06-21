import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { MemorySettings } from "./settings";
import type { Jsonish, MemoryEntry, RelationEdge, RelationScope, StoreRef, Scope } from "./types";
import { compareTimestamps, normalizeBareSlug, prettyPath, stableUnique, titleFromSlug, throwIfAborted } from "./utils";
import { parseDirectionImpact } from "./direction-impact";
import { resolveActiveProject, abrainProjectDir } from "../_shared/runtime";
import { resolveSedimentSettings } from "../sediment/settings";
import { readKnowledgeProjectionStores, readKnowledgeStableViewStores } from "../sediment/knowledge-evidence";

const execFileAsync = promisify(execFile);

const IGNORE_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".state", ".index", ".cache",
]);

// World-store extra ignores. The world store root is `~/.abrain/`, which
// also contains `projects/` (per-project sediment writes), `vault/`
// (encrypted secrets), and `rules/` (ADR 0023-R5 session-start injected
// rules). All must be excluded from normal world memory scans:
//   - `projects/` entries are project-scoped knowledge owned by the
//     active-project store, not world knowledge; including them would
//     leak other projects into the curator neighbor pool.
//   - `vault/` is encrypted/structured secret material, never markdown
//     intended for memory_search.
//   - `rules/` has a dedicated push-injection path. Leaving it in the
//     pull-search corpus would duplicate rules as ordinary knowledge and
//     could make memory_get(scoped listed slug) ambiguous.
// listFilesWithRg already excludes these via --glob; the walker fallback
// must mirror that behaviour or the safety contract regresses whenever
// rg is missing/timeout/failed.
const WORLD_EXTRA_IGNORE_DIRS = new Set(["projects", "vault", "rules", "l1", "l2"]);

// Project store STAGING exclusion (ADR 0021 invariant #7 + ADR 0014 §3.5
// staging lifecycle): the Lane G router downgrades low-confidence about-me
// samples into `projects/<id>/observations/staging/`, where they wait for
// G4 `review-staging` triage. Until reviewed they MUST NOT enter
// memory_search rerank candidates — they're unclassified noise from the
// LLM-facing view. `observations/staging` + `observations/staging/rejected`
// are both relpath-anchored under the project store root. Matched in two
// layers: listFilesWithRg --glob (primary path), walkMarkdownFiles
// opts.ignoreRelPaths (fallback when rg missing).
const STAGING_IGNORE_REL_PATHS = new Set<string>([
  "observations/staging",
  "observations/staging/rejected",
]);

// Canonical kind/status enum guard (read side). The write side
// (sediment/validation.ts::ENTRY_KINDS / ENTRY_STATUSES) is the source of
// truth; we mirror it here ONLY for normalization so the LLM-facing card
// never surfaces non-enum values. Do NOT import from sediment to avoid a
// memory → sediment dependency (memory is read-only, sediment depends on
// memory). Keep these two lists in sync manually.
const CANONICAL_KINDS = new Set([
  "maxim", "decision", "anti-pattern", "pattern", "fact", "preference", "smell",
]);
const CANONICAL_STATUSES = new Set([
  "provisional", "active", "contested", "deprecated", "superseded", "archived",
]);

// AX-PROVENANCE (ADR 0028 §12): read-side mirror of
// sediment/validation.ts::PROVENANCE_CLASSES. Keep local to avoid a memory →
// sediment dependency; legacy entries lacking the field default to
// assistant-observed so the axis is always present in parsed MemoryEntry.
const CANONICAL_PROVENANCE = new Set([
  "user-expressed", "assistant-observed", "content-in-transcript",
]);

// Legacy alias folding. The `pipeline` and `knowledge` kinds existed in
// pre-v7 pensieve entries and remain produced by inferKindFromPath as a
// READ-ONLY fallback for entries without `frontmatter.kind`. They are
// NOT in ENTRY_KINDS; before this fold the LLM saw kind values that the
// memory_search tool description never declared, which broke the doc
// contract ("Valid kinds: maxim/decision/anti-pattern/pattern/fact/
// preference/smell"). Fold to the closest canonical kind here; preserve
// the original in entry.legacyKind for doctor diagnostics.
const LEGACY_KIND_FOLD: Record<string, string> = {
  pipeline: "pattern",   // workflow-shaped templates ≈ patterns
  knowledge: "fact",     // declarative knowledge ≈ facts
};

export function normalizeKind(raw: string): { kind: string; legacyKind?: string } {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { kind: "fact", legacyKind: raw || undefined };
  if (CANONICAL_KINDS.has(trimmed)) return { kind: trimmed };
  const folded = LEGACY_KIND_FOLD[trimmed];
  if (folded) return { kind: folded, legacyKind: trimmed };
  // Unknown kind — fall back to the most neutral canonical value so the
  // entry remains searchable instead of silently dropping; expose the
  // raw value via legacyKind so /memory doctor can flag it.
  return { kind: "fact", legacyKind: trimmed };
}

export function normalizeStatus(raw: string | undefined): { status: string; legacyStatus?: string } {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { status: "active" };
  // AX-MATURITY (ADR 0028 v1.1 §12): `deprecated` FOLDS into `superseded`
  // (both = "replaced, reference-only"). New writes should not use deprecated;
  // existing deprecated entries read as superseded so the default search
  // exclusion applies uniformly. Original preserved for diagnostics.
  if (trimmed === "deprecated") return { status: "superseded", legacyStatus: "deprecated" };
  if (CANONICAL_STATUSES.has(trimmed)) return { status: trimmed };
  // Unknown status → provisional (neutral; visible — NOT subject to the default
  // archived/superseded exclusion in search.ts::entryMatchesFilters, so a
  // degraded entry still surfaces). Original preserved for diagnostics.
  return { status: "provisional", legacyStatus: trimmed };
}

const RELATION_KEYS = new Set([
  "relates_to",
  "derives_from",
  "superseded_by",
  "applied_in",
  "contested_with",
  "references",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "by", "as", "at", "from", "this", "that",
  "it", "its", "into", "via", "not", "no", "do", "does", "did", "use", "using",
]);

export function resolveStores(cwdRaw: string | undefined, settings: MemorySettings): StoreRef[] {
  const cwd = path.resolve(cwdRaw || process.cwd());
  const stores: StoreRef[] = [];

  // Resolve abrain home once (used by both project-dual and world)
  const abrainHome = path.resolve(
    process.env.ABRAIN_ROOT
      ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
      : path.join(os.homedir(), ".abrain"),
  );
  const abrainExists = fsSync.existsSync(abrainHome) && fsSync.statSync(abrainHome).isDirectory();

  // STORE PRIORITY (post-B5 cutover, 2026-05-13). Order matters: it is
  // also the dedup priority — when the same bare slug appears in multiple
  // stores, the FIRST one wins (see loadEntries below). Do not reorder
  // without re-reading the audit notes in docs/audits/.
  //
  //   1. abrain project store — PRIMARY post-B5. Canonical write target
  //      for sediment; the only place new entries should appear.
  //   2. world store — ~/.abrain/, scoped knowledge. Searched after
  //      project so a project-scoped same-slug override wins.
  //   3. legacy .pensieve/ — FALLBACK ONLY for repos that have not been
  //      migrated. sediment no longer writes here; if the same slug
  //      already exists in an abrain store, the .pensieve copy is stale
  //      and must NOT shadow the canonical entry.
  //
  // Resolve active project once (shared between abrain-project and legacy
  // .pensieve anchor) to keep both stores consistent with strict binding.
  let activeProjectRoot: string | null = null;
  let abrainProjDir: string | null = null;
  if (abrainExists) {
    try {
      const resolved = resolveActiveProject(cwd, { abrainHome });
      if (resolved.activeProject) {
        const dir = abrainProjectDir(abrainHome, resolved.activeProject.projectId);
        if (fsSync.existsSync(dir) && fsSync.statSync(dir).isDirectory()) {
          abrainProjDir = dir;
        }
        if (resolved.activeProject.projectRoot) {
          activeProjectRoot = resolved.activeProject.projectRoot;
        }
      }
    } catch {
      // Strict binding resolution failure → no project store / legacy stays at cwd.
    }
  }

  // 1. Abrain project store (PRIMARY)
  if (abrainProjDir) {
    stores.push({ scope: "project", root: abrainProjDir, label: "abrain-project" });
  }

  // 2. World store: ~/.abrain/ (knowledge/, workflows/, etc.)
  if (settings.includeWorld && abrainExists) {
    stores.push({ scope: "world", root: abrainHome, label: "world" });
  }

  // 3. Legacy .pensieve/ FALLBACK. Anchored at active project root (not
  //    raw cwd) so launching pi from a subdirectory still finds the
  //    legacy tree; falls back to cwd if active project resolution did
  //    not succeed (unbound repo).
  const legacyAnchor = activeProjectRoot ?? cwd;
  const legacyRoot = path.join(legacyAnchor, ".pensieve");
  if (fsSync.existsSync(legacyRoot) && fsSync.statSync(legacyRoot).isDirectory()) {
    stores.push({ scope: "project", root: legacyRoot, label: "legacy-pensieve" });
  }

  return stores;
}

export function splitFrontmatter(raw: string): { frontmatterText: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatterText: "", body: raw };
  }

  // Accept both common forms:
  //   ---\nfrontmatter\n---\nbody
  //   ---\nfrontmatter\n---        (empty body / EOF after closing fence)
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) return { frontmatterText: "", body: raw };
  return { frontmatterText: match[1], body: match[2] ?? "" };
}

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function parseScalar(raw: string): Jsonish {
  let s = stripInlineComment(raw).trim();
  if (!s) return "";

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }

  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((part) => parseScalar(part.trim()))
      .filter((part) => part !== "");
  }

  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseFrontmatter(text: string): Record<string, Jsonish> {
  const out: Record<string, Jsonish> = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const key = match[1];
    const rest = (match[2] ?? "").trim();

    if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i++;
        block.push(lines[i].replace(/^\s+/, ""));
      }
      out[key] = rest.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
      continue;
    }

    if (rest === "") {
      const arr: Jsonish[] = [];
      let consumed = false;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const item = next.match(/^\s+-\s+(.*)$/);
        if (!item) break;
        consumed = true;
        i++;
        arr.push(parseScalar(item[1]));
      }
      out[key] = consumed ? arr : {};
      continue;
    }

    out[key] = parseScalar(rest);
  }

  return out;
}

export function extractTitle(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

export function splitCompiledTruth(body: string): { compiledTruth: string; timeline: string[] } {
  const normalized = body.replace(/\r\n/g, "\n");
  const match = /^##\s+Timeline\s*$/m.exec(normalized);
  if (!match) return { compiledTruth: normalized.trim(), timeline: [] };

  const compiled = normalized.slice(0, match.index).trim();
  const timelineRaw = normalized.slice(match.index + match[0].length).trim();
  const timeline = timelineRaw
    ? timelineRaw.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim())
    : [];
  return { compiledTruth: compiled, timeline };
}

function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeSummary(compiledTruth: string, fallbackTitle: string): string {
  const withoutTitle = compiledTruth
    .replace(/^#\s+.*$/m, "")
    .replace(/^---$/gm, "");
  const paragraphs = withoutTitle
    .split(/\n\s*\n/g)
    .map((p) => markdownToPlain(p))
    .filter((p) => p.length >= 20);
  const selected = paragraphs[0] || markdownToPlain(withoutTitle) || fallbackTitle;
  return selected.length > 240 ? `${selected.slice(0, 237)}...` : selected;
}

/**
 * Infer entry kind from directory path.
 *
 * Authoritative kind set (write side, see extensions/sediment/validation.ts
 * ENTRY_KINDS) is 7: maxim / decision / pattern / anti-pattern / fact /
 * preference / smell. Writer only produces these.
 *
 * The two extra returns below — `"pipeline"` and `"knowledge"` — are READ-ONLY
 * LEGACY ALIASES for pre-frontmatter pensieve entries that pre-date the v7
 * frontmatter+compiled-truth format. Modern entries always carry an explicit
 * `kind:` field in frontmatter (see parser.ts:~357 priority chain:
 * `frontmatter.kind || frontmatter.type || inferKindFromPath`), so this fallback
 * only triggers on legacy data without frontmatter.kind.
 *
 * Pipeline kind is being phased out: per ADR 0014 v7.1 abrain redesign,
 * pipeline-shaped entries ("run-when-*.md" task blueprints) belong in
 * abrain `workflows/` zone, not in project knowledge. B1 shipped the abrain
 * workflows lane writer; until every legacy repo has migrated, parser keeps
 * the alias so existing legacy `pipelines/` and top-level `knowledge/`
 * directories remain readable.
 *
 * Do not add new kind aliases here — extend ENTRY_KINDS instead.
 */
export function inferKindFromPath(relPath: string): string {
  const parts = relPath.split(/[\\/]+/);
  const dirs = new Set(parts.slice(0, -1));
  if (dirs.has("maxims")) return "maxim";
  if (dirs.has("decisions")) return "decision";
  if (dirs.has("patterns")) return "pattern";
  if (dirs.has("anti-patterns")) return "anti-pattern";
  if (dirs.has("facts")) return "fact";
  if (dirs.has("staging")) return "smell";
  // Legacy aliases — see JSDoc above. Do not extend.
  if (dirs.has("pipelines")) return "pipeline";
  if (dirs.has("knowledge")) return "knowledge";
  return "fact";
}

export function defaultConfidence(kind: string): number {
  switch (kind) {
    case "maxim": return 7;
    case "fact": return 5;
    case "knowledge": return 5;
    case "preference": return 5;
    case "pipeline": return 5;
    case "smell": return 2;
    case "decision": return 3;
    case "pattern": return 3;
    case "anti-pattern": return 3;
    default: return 3;
  }
}

export function scalarString(value: Jsonish | undefined): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function scalarNumber(value: Jsonish | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function relationValues(value: Jsonish | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  return [];
}

// Strip fenced code blocks (``` ... ```) and inline code spans (`...`)
// so wikilink-shaped examples inside code do not pollute the graph.
function stripCode(body: string): string {
  let out = body.replace(/```[\s\S]*?```/g, "");
  out = out.replace(/`[^`\n]*`/g, "");
  return out;
}

const KNOWN_SCOPE_PREFIXES: ReadonlySet<RelationScope> = new Set(["world", "workflow", "project"]);

export interface WikilinkTarget {
  slug: string;
  scope?: RelationScope;
  qualifier?: string;
}

/**
 * Parse a wikilink target (or any "slug-like" relation value) into a
 * structured tuple of {slug, scope, qualifier}. Recognises:
 *
 *   `[[foo]]`                 → {slug:"foo"}
 *   `[[world:foo]]`           → {slug:"foo", scope:"world"}
 *   `[[workflow:foo]]`        → {slug:"foo", scope:"workflow"}
 *   `[[project:pi:foo]]`      → {slug:"foo", scope:"project", qualifier:"pi"}
 *   `[[person:alfadb]]`       → {slug:"alfadb", scope:"unknown", qualifier:"person"}
 *   `abrain://world/p/foo`    → {slug:"foo", scope:"world"}
 *   `abrain://projects/<id>/x/foo` → {slug:"foo", scope:"project", qualifier:"<id>"}
 *
 * Empty / unparseable input → {slug:""}. Caller filters empties.
 *
 * NOTE: This is the canonical wikilink scope parser. `normalizeBareSlug`
 * is the legacy bare-slug normalizer that silently DROPS the prefix —
 * still used for id-suffix extraction and filename slugging, but no longer
 * used for relation-target parsing where we need scope information.
 */
export function parseWikilinkTarget(raw: string): WikilinkTarget {
  let s = String(raw || "").trim();
  if (!s) return { slug: "" };
  s = s.replace(/^\[\[/, "").replace(/\]\]$/, "");
  // Strip alias / anchor; pi-astack data has 0 of these in pi-global but
  // wikilink spec allows them.
  s = s.split("|")[0]!.split("#")[0]!.trim();
  if (!s) return { slug: "" };

  // abrain:// URL form (legacy / prototype shape; seen in pi-global
  // frontmatter `relates_to` from May 2026 spec drafts).
  const urlMatch = /^abrain:\/\/([^/]+)\/(.+)$/i.exec(s);
  if (urlMatch) {
    const head = urlMatch[1]!.toLowerCase();
    const tail = urlMatch[2]!;
    if (head === "world" || head === "workflow") {
      return { slug: normalizeBareSlug(tail), scope: head as RelationScope };
    }
    if (head === "projects") {
      const projectMatch = /^([^/]+)\/(.+)$/.exec(tail);
      if (projectMatch) {
        return { slug: normalizeBareSlug(projectMatch[2]!), scope: "project", qualifier: projectMatch[1] };
      }
    }
    // Unrecognised abrain:// host; fall through to bare normalize.
    return { slug: normalizeBareSlug(tail) };
  }

  // Prefix form: <head>:<tail>
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const head = s.slice(0, colonIdx);
    const tail = s.slice(colonIdx + 1);
    if (head === "world" || head === "workflow") {
      return { slug: normalizeBareSlug(tail), scope: head as RelationScope };
    }
    if (head === "project") {
      // `project:<id>:<slug>` — split off project id.
      const innerIdx = tail.indexOf(":");
      if (innerIdx > 0) {
        return {
          slug: normalizeBareSlug(tail.slice(innerIdx + 1)),
          scope: "project",
          qualifier: tail.slice(0, innerIdx),
        };
      }
      // `project:<slug>` without id — treat as plain slug, no scope.
      return { slug: normalizeBareSlug(tail) };
    }
    if (!KNOWN_SCOPE_PREFIXES.has(head as RelationScope)) {
      // user-defined typed link (`person:`, `company:`, etc.)
      return { slug: normalizeBareSlug(tail), scope: "unknown", qualifier: head };
    }
  }

  return { slug: normalizeBareSlug(s) };
}

function extractBodyWikilinkTargets(body: string): WikilinkTarget[] {
  const out: WikilinkTarget[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  const stripped = stripCode(body);
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    const tgt = parseWikilinkTarget(match[1]!);
    if (tgt.slug) out.push(tgt);
  }
  // De-duplicate by (slug, scope, qualifier) tuple to preserve scope
  // diversity (project entry MAY legitimately reference both bare `foo`
  // and `world:foo` if they have distinct meanings).
  const seen = new Set<string>();
  return out.filter((t) => {
    const sig = `${t.slug}\0${t.scope ?? ""}\0${t.qualifier ?? ""}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

function extractRelations(frontmatter: Record<string, Jsonish>, body: string): RelationEdge[] {
  const edges: RelationEdge[] = [];

  for (const key of RELATION_KEYS) {
    for (const raw of relationValues(frontmatter[key])) {
      const tgt = parseWikilinkTarget(raw);
      if (!tgt.slug) continue;
      const edge: RelationEdge = { to: tgt.slug, type: key, source: "frontmatter" };
      if (tgt.scope) edge.scope = tgt.scope;
      if (tgt.qualifier) edge.qualifier = tgt.qualifier;
      edges.push(edge);
    }
  }

  for (const tgt of extractBodyWikilinkTargets(body)) {
    const edge: RelationEdge = { to: tgt.slug, type: "references", source: "body_wikilink" };
    if (tgt.scope) edge.scope = tgt.scope;
    if (tgt.qualifier) edge.qualifier = tgt.qualifier;
    edges.push(edge);
  }

  const seen = new Set<string>();
  return edges.filter((edge) => {
    const sig = `${edge.to}\0${edge.type}\0${edge.source}\0${edge.scope ?? ""}\0${edge.qualifier ?? ""}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

export function tokenize(text: string): string[] {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/@#.:\\/\-]+/g, " ");
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export async function parseEntry(file: string, store: StoreRef, cwd: string): Promise<MemoryEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }

  const relPath = path.relative(store.root, file);
  const { frontmatterText, body } = splitFrontmatter(raw);
  // Skip files without frontmatter. Canonical memory entries ALWAYS
  // have schema v1 frontmatter (`---` ... `---`); plain markdown like
  // README.md / CHANGELOG.md / docs would otherwise be coerced into
  // degraded entries (kind=fact, status=active by default) and
  // pollute search results. Discovered when initializing ~/.abrain/
  // and finding the README.md indexed as a memory entry.
  if (!frontmatterText.trim()) return null;
  const frontmatter = parseFrontmatter(frontmatterText);
  const { compiledTruth, timeline } = splitCompiledTruth(body);

  const id = scalarString(frontmatter.id);
  const pathSlug = path.basename(file, path.extname(file)) === "content"
    ? path.basename(path.dirname(file))
    : path.basename(file, path.extname(file));
  const slug = normalizeBareSlug(id || pathSlug || extractTitle(body) || "entry");

  const title = scalarString(frontmatter.title) || extractTitle(body) || titleFromSlug(slug);
  const rawKind = scalarString(frontmatter.kind) || scalarString(frontmatter.type) || inferKindFromPath(relPath);
  const rawStatus = scalarString(frontmatter.status) || "active";
  // Normalize to canonical enum (2026-05-15 audit fix). entry.kind /
  // entry.status now always come from sediment/validation.ts's enum;
  // non-canonical values are preserved in legacyKind / legacyStatus for
  // diagnostics and never leak to the LLM-facing normalized card.
  const kindNorm = normalizeKind(rawKind);
  const statusNorm = normalizeStatus(rawStatus);
  const kind = kindNorm.kind;
  const status = statusNorm.status;
  // confidence default uses the NORMALIZED kind so the heuristic remains
  // stable as new legacy aliases get folded.
  const confidence = Math.min(10, Math.max(0, scalarNumber(frontmatter.confidence) ?? defaultConfidence(kind)));
  const provenanceRaw = scalarString(frontmatter.provenance);
  const provenance = provenanceRaw && CANONICAL_PROVENANCE.has(provenanceRaw)
    ? provenanceRaw
    : "assistant-observed";
  const scopeRaw = scalarString(frontmatter.scope);
  const scope: Scope = scopeRaw === "world" || scopeRaw === "project" ? scopeRaw : store.scope;
  const summary = makeSummary(compiledTruth, title);
  const relations = extractRelations(frontmatter, body);
  // ADR 0034 §2.2: parse + validate direction_impact. Invalid rows are dropped
  // here (and surfaced separately by lint/doctor); the entry only carries valid
  // ones so downstream queryability (acceptance ⑥) sees a clean structured list.
  const directionImpact = parseDirectionImpact(frontmatter.direction_impact).impacts;
  const relatedSlugs = stableUnique(relations.map((edge) => edge.to)).slice(0, 20);
  const tokens = tokenize(`${title}\n${slug}\n${compiledTruth}`);

  return {
    slug,
    ...(id ? { id } : {}),
    scope,
    kind,
    status,
    ...(kindNorm.legacyKind ? { legacyKind: kindNorm.legacyKind } : {}),
    ...(statusNorm.legacyStatus ? { legacyStatus: statusNorm.legacyStatus } : {}),
    confidence,
    provenance,
    title,
    summary,
    created: scalarString(frontmatter.created),
    updated: scalarString(frontmatter.updated),
    sourcePath: file,
    displayPath: prettyPath(file, cwd),
    storeRoot: store.root,
    frontmatter,
    compiledTruth,
    timeline,
    relatedSlugs,
    relations,
    ...(directionImpact.length ? { directionImpact } : {}),
    tokenCounts: tokenCounts(tokens),
    tokenTotal: Math.max(1, tokens.length),
  };
}

export async function listFilesWithRg(
  root: string,
  signal?: AbortSignal,
  opts: { includeIgnored?: boolean; excludeStaging?: boolean; noHomeExclusions?: boolean } = {},
): Promise<string[] | null> {
  // P1-A audit fix 2026-05-16 (round 3, gpt-5.5): staging exclusion is
  // now opt-in. Previously it was hardcoded — but listFilesWithRg is a
  // GENERIC markdown enumerator used by lint.ts::markdownFilesForTarget,
  // migrate.ts, and migrate-go.ts. Hardcoding facade policy here
  // polluted lint / migrate enumeration: `pi memory lint <target>`
  // would skip any observations/staging/ subtree even when the user
  // wants to lint them (G4 review-staging will need this). Caller in
  // scanStore (project store) explicitly opts in; other callers don't.
  const stagingGlobs = opts.excludeStaging
    ? [
        // Defense-in-depth (P2-B audit note 2026-05-16): the second
        // pattern is a strict subset of the first (** is recursive), so
        // technically redundant; kept as an explicit declaration for
        // grep-ability when readers search for "rejected".
        "!**/observations/staging/**",
        "!**/observations/staging/rejected/**",
      ]
    : [];
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--files",
        ...(opts.includeIgnored ? ["--no-ignore"] : []),
        "--glob", "*.md",
        "--glob", "!**/.state/**",
        "--glob", "!**/.index/**",
        "--glob", "!**/.git/**",
        // World store root is ~/.abrain/ which contains projects/<id>/, vault/,
        // ADR 0023 rules/, plus ADR 0039 l1/ (json Evidence Events) and l2/ (the
        // projection view). Exclude them from the ordinary memory_search corpus;
        // projections are read via the dedicated stable-view / overlay readers,
        // rules via a dedicated push-injection path. Default ON (preserves world
        // + lint/migrate behavior). ADR 0039: rg outputs ABSOLUTE paths and
        // matches --glob against the FULL path, so a stable-view store rooted
        // UNDER ~/.abrain/l2/ would have its entire tree dropped by !**/l2/**.
        // Such stores set noHomeExclusions=true to opt out.
        ...(opts.noHomeExclusions
          ? []
          : [
              "--glob", "!**/projects/**",
              "--glob", "!**/vault/**",
              "--glob", "!**/rules/**",
              "--glob", "!**/l1/**",
              "--glob", "!**/l2/**",
            ]),
        ...stagingGlobs.flatMap((g) => ["--glob", g]),
        root,
      ],
      { signal, timeout: 3_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export async function walkMarkdownFiles(
  root: string,
  maxEntries: number,
  signal?: AbortSignal,
  opts: { extraIgnoreDirs?: Set<string>; ignoreRelPaths?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const out: string[] = [];
  const extraIgnore = opts.extraIgnoreDirs;
  const ignoreRelPaths = opts.ignoreRelPaths;

  async function walk(dir: string) {
    throwIfAborted(signal);
    if (out.length >= maxEntries) return;

    // Relpath-anchored skip (ADR 0021 invariant #7 mirror of rg --glob
    // staging exclusion). Different from `extraIgnoreDirs` (basename-only)
    // because basename `"staging"` would over-match any directory called
    // "staging" anywhere; we want only `observations/staging` under the
    // store root.
    if (ignoreRelPaths) {
      const rel = path.relative(root, dir).replace(/\\/g, "/");
      if (ignoreRelPaths.has(rel)) return;
    }

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (extraIgnore && extraIgnore.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_index.md") {
        out.push(abs);
      }
    }
  }

  await walk(root);
  return out;
}

export async function scanStore(
  store: StoreRef,
  cwd: string,
  settings: MemorySettings,
  signal?: AbortSignal,
): Promise<MemoryEntry[]> {
  throwIfAborted(signal);
  // ADR 0039 B-prep blocker③: a store may carry a pre-bounded file allow-list
  // (knowledge projection OVERLAY reader enforcing count/token/time caps). When
  // present, read ONLY those files — do NOT walk the dir — so the overlay budget
  // is authoritative. All other stores leave `files` undefined and walk fully.
  if (store.files) {
    const entries: MemoryEntry[] = [];
    for (const file of store.files.slice(0, settings.maxEntries)) {
      throwIfAborted(signal);
      const entry = await parseEntry(path.resolve(file), store, cwd);
      if (entry) entries.push(entry);
    }
    return entries;
  }
  // P1-A audit fix 2026-05-16 (round 3): only project store opts into
  // staging exclusion. World store doesn't need it (staging lives under
  // projects/ which is already in WORLD_EXTRA_IGNORE_DIRS).
  const rgFiles = await listFilesWithRg(store.root, signal, {
    excludeStaging: store.scope === "project",
    // ADR 0039: the stable-view projection stores are rooted UNDER ~/.abrain/l2/,
    // so the home exclusions (which match rg's absolute paths, incl. !**/l2/**)
    // would drop their entire tree. They opt out; every other store keeps the
    // default-on home exclusions (unchanged world / project / lint / migrate).
    noHomeExclusions: store.label === "knowledge-stable-project" || store.label === "knowledge-stable-world",
  });
  // World walker MUST exclude `projects/`, `vault/`, and `rules/` to
  // mirror the rg --glob exclusions. Without this, an `rg`-missing host
  // would leak other projects' sediment writes, encrypted vault material,
  // or dedicated push-injected rules into memory_search results.
  // (gpt-5.5 audit, 2026-05-15; rules added by ADR 0023-R5)
  const extraIgnoreDirs = store.scope === "world" ? WORLD_EXTRA_IGNORE_DIRS : undefined;
  // Project walker MUST exclude observations/staging/* per ADR 0021
  // invariant #7. Project `rules/` remains in the project scan root only
  // for exact debug reads if a future caller explicitly wants it; the R5
  // injection path does not depend on memory_search.
  // World store needs no staging exclusion because staging entries live
  // under projects/<id>/ which is already excluded by WORLD_EXTRA_IGNORE_DIRS
  // above. (Lane G P0-B audit fix 2026-05-16)
  const ignoreRelPaths = store.scope === "project" ? STAGING_IGNORE_REL_PATHS : undefined;
  const files = (rgFiles ?? await walkMarkdownFiles(store.root, settings.maxEntries, signal, { extraIgnoreDirs, ignoreRelPaths }))
    .filter((file) => path.basename(file) !== "_index.md")
    .slice(0, settings.maxEntries);

  const entries: MemoryEntry[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    const entry = await parseEntry(path.resolve(file), store, cwd);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ADR0039 A6 (R3 4xT0): legacy-read tripwire. Counts winning entries that
// surfaced from a legacy markdown store (abrain-project / world / legacy-pensieve)
// rather than the L2 projection. Under `projection_only` this MUST stay 0 — any
// non-zero is a silent-legacy-resurrection anomaly, logged LOUD + diagnostic
// (never swallowed). In legacy / projection_with_legacy_fallback modes a non-zero
// count is the expected baseline (legacy still fills gaps), which proves the
// instrument works and lets a post-flip run assert the drop to 0.
const LEGACY_STORE_LABELS = new Set(["abrain-project", "world", "legacy-pensieve"]);
let legacyColdReadTotal = 0;
let legacyColdReadLast = 0;
let legacyColdReadAnomalies = 0;
export function getLegacyColdReadStats(): { total: number; last: number; anomalies: number } {
  return { total: legacyColdReadTotal, last: legacyColdReadLast, anomalies: legacyColdReadAnomalies };
}
function recordLegacyColdRead(legacyWinners: number, readMode: string, abrainHome: string): void {
  legacyColdReadLast = legacyWinners;
  legacyColdReadTotal += legacyWinners;
  if (readMode === "projection_only" && legacyWinners > 0) {
    legacyColdReadAnomalies += legacyWinners;
    // LOUD: projection_only must never surface legacy markdown. Do not swallow.
    console.warn(`[ADR0039 A6] legacy_cold_access anomaly: ${legacyWinners} winning entries from legacy stores under projection_only`);
    try {
      const diagDir = path.join(abrainHome, ".state", "sediment");
      fsSync.mkdirSync(diagDir, { recursive: true });
      fsSync.appendFileSync(
        path.join(diagDir, "legacy-cold-access.jsonl"),
        `${JSON.stringify({ schemaVersion: "legacy-cold-access/v1", atUtc: new Date().toISOString(), legacyWinners, readMode })}\n`,
        "utf-8",
      );
    } catch { /* diagnostic is best-effort; the LOUD warn is the primary signal */ }
  }
}

export async function loadEntries(
  cwdRaw: string | undefined,
  settings: MemorySettings,
  signal?: AbortSignal,
): Promise<MemoryEntry[]> {
  const cwd = path.resolve(cwdRaw || process.cwd());
  const stores = resolveStores(cwd, settings);
  const abrainHome = path.resolve(
    process.env.ABRAIN_ROOT
      ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
      : path.join(os.homedir(), ".abrain"),
  );
  // ADR0039 A6: hoisted to function scope so the legacy-read tripwire below can
  // see the mode after the (optional) projection-store assembly.
  let readMode = "legacy";
  try {
    const resolved = resolveActiveProject(cwd, { abrainHome });
    const projectId = resolved.activeProject?.projectId;
    const sediment = resolveSedimentSettings();
    // ADR 0039 Phase C: three-state canonical read source (hot flag).
    readMode = sediment.knowledgeProjector?.canonicalReadMode ?? "legacy";
    if (readMode !== "legacy") {
      // The UNBOUNDED stable-view projection becomes a PRIMARY store at the FRONT,
      // winning over legacy via first-store-wins. projection_only removes legacy
      // from the winning pool entirely (stable view + bounded overlay only).
      const stableView = await readKnowledgeStableViewStores({ abrainHome, projectId, settings: sediment });
      if (readMode === "projection_only") stores.length = 0;
      stores.unshift(...stableView);
    }
    // Bounded hot overlay is always appended LAST (recent-events bridge, gap-fill
    // only; loses dedup to whatever is ahead of it). In "legacy" mode this is the
    // sole projection contribution; in projection modes it backstops the stable view.
    const overlayStores = await readKnowledgeProjectionStores({ abrainHome, projectId, settings: sediment });
    stores.push(...overlayStores);
  } catch {
    // Projection overlay/stable-view is optional; canonical stores remain read truth.
  }
  if (stores.length === 0) return [];

  // Round 7 P1 (gpt-5.5 audit fix): identify abort errors and rethrow.
  // Previously `.catch(() => [])` swallowed AbortError too, turning user
  // cancellation into "no memory found" — LLMs and humans then misread
  // the empty result as evidence of fact.
  const batches = await Promise.all(
    stores.map((store) => scanStore(store, cwd, settings, signal).catch((err: unknown) => {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
      return [];
    })),
  );

  // Dedup across stores. Store priority is fixed in resolveStores:
  //   abrain-project > world > legacy-pensieve
  // The first occurrence of a given slug wins UNCONDITIONALLY across
  // stores — abrain-project canonical entries must never be shadowed by
  // a stale legacy .pensieve copy with a higher (legacy) confidence
  // value. (B5 cutover semantics; 2026-05-15 memory audit fix.)
  //
  // Within the same store the same slug should not appear twice; if it
  // does (e.g. duplicate frontmatter id), keep the higher-confidence
  // entry, then more-recently-updated entry. compareTimestamps is
  // Date.parse-based (TZ aware) so date-only vs full ISO formats compare
  // correctly. (Round 7 P1 sonnet audit fix.)
  const seen = new Map<string, { entry: MemoryEntry; storeIndex: number }>();
  for (let i = 0; i < batches.length; i++) {
    for (const entry of batches[i]) {
      const existing = seen.get(entry.slug);
      if (!existing) {
        seen.set(entry.slug, { entry, storeIndex: i });
        continue;
      }
      // Cross-store: earlier store always wins (B5 priority).
      if (i !== existing.storeIndex) continue;
      // Same-store tiebreak: confidence then updated.
      if (entry.confidence > existing.entry.confidence) {
        seen.set(entry.slug, { entry, storeIndex: i });
      } else if (entry.confidence === existing.entry.confidence) {
        const eu = entry.updated || entry.created;
        const xu = existing.entry.updated || existing.entry.created;
        if (compareTimestamps(eu, xu) > 0) seen.set(entry.slug, { entry, storeIndex: i });
      }
    }
  }

  // ADR0039 A6 (R3): legacy-read tripwire — count winners sourced from a legacy
  // markdown store. Steady-state under projection_only must be 0 (loud otherwise).
  let legacyWinners = 0;
  for (const { storeIndex } of seen.values()) {
    if (LEGACY_STORE_LABELS.has(stores[storeIndex]?.label ?? "")) legacyWinners += 1;
  }
  recordLegacyColdRead(legacyWinners, readMode, abrainHome);

  return Array.from(seen.values()).map((v) => v.entry);
}
