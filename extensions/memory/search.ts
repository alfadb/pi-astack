import type { MemorySettings } from "./settings";
import type { ListFilters, MemoryEntry, SearchFilters, SearchParams } from "./types";
import { relationValues, tokenize } from "./parser";
import { clamp, normalizeBareSlug, stableUnique } from "./utils";

export function entryMatchesFilters(entry: MemoryEntry, filters?: SearchFilters): boolean {
  if (filters?.kinds?.length) {
    const kinds = new Set(filters.kinds.map((k) => k.toLowerCase()));
    if (!kinds.has(entry.kind.toLowerCase())) return false;
  }

  if (filters?.status?.length) {
    // AX-MATURITY (ADR 0028 v1.1): `deprecated` folds to `superseded` at parse
    // time, so a status:["deprecated"] filter must also fold or it would match
    // ZERO entries (no read-model entry is ever `deprecated`). (audit P2.)
    const statuses = new Set(filters.status.map((s) => {
      const v = s.toLowerCase();
      return v === "deprecated" ? "superseded" : v;
    }));
    if (!statuses.has("all") && !statuses.has(entry.status.toLowerCase())) return false;
  } else {
    // AX-MATURITY (ADR 0028 v1.1 §12): default search excludes both retired
    // states. `archived` AND `superseded` are "replaced/retired, reference-only"
    // and must NOT surface alongside active (the prior code excluded only
    // archived, so superseded/deprecated entries rendered as if still live).
    // `deprecated` folds to `superseded` at parse time (parser.normalizeStatus),
    // so checking superseded covers it. `contested` + `provisional` stay visible.
    const s = entry.status.toLowerCase();
    if (s === "archived" || s === "superseded") return false;
  }

  return true;
}

function documentFrequencies(entries: MemoryEntry[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const entry of entries) {
    for (const token of entry.tokenCounts.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return df;
}

function textScoreEntry(
  entry: MemoryEntry,
  query: string,
  queryTerms: string[],
  df: Map<string, number>,
  docCount: number,
): number {
  const q = query.trim().toLowerCase();
  const titleLower = entry.title.toLowerCase();
  const slugLower = entry.slug.toLowerCase();
  const compiledLower = entry.compiledTruth.toLowerCase();

  let textScore = 0;
  for (const term of queryTerms) {
    const tf = (entry.tokenCounts.get(term) ?? 0) / Math.sqrt(entry.tokenTotal);
    const idf = Math.log(1 + docCount / (1 + (df.get(term) ?? 0))) + 1;
    textScore += tf * idf;

    if (titleLower.includes(term)) textScore += 2.0;
    if (slugLower.includes(term)) textScore += 1.2;
  }

  if (q && titleLower.includes(q)) textScore += 3.0;
  if (q && compiledLower.includes(q)) textScore += 1.5;
  return textScore;
}

function finalRankScore(entry: MemoryEntry, normalizedTextScore: number, settings: MemorySettings): number {
  const confidenceFactor = Math.max(0.1, entry.confidence / 10);
  const projectBoost = entry.scope === "project" ? settings.projectBoost : 1;
  return normalizedTextScore * confidenceFactor * projectBoost;
}

/** @deprecated BM25 search — dead code kept for potential offline diagnostics CLI.
 *  No caller in extensions/. ADR 0015 LLM retrieval fully replaces this path. */
export function searchEntries(entries: MemoryEntry[], params: SearchParams, settings: MemorySettings) {
  const query = String(params.query ?? "").trim();
  const filters = params.filters ?? {};
  const limit = clamp(
    Math.floor(filters.limit ?? settings.defaultLimit),
    1,
    settings.maxLimit,
  );

  if (!query) return [];

  const filtered = entries.filter((entry) => entryMatchesFilters(entry, filters));
  const queryTerms = stableUnique(tokenize(query));
  const df = documentFrequencies(filtered);
  const textScored = filtered
    .map((entry) => ({ entry, textScore: textScoreEntry(entry, query, queryTerms, df, filtered.length || 1) }))
    .filter((item) => item.textScore > 0);

  if (textScored.length === 0) return [];

  const minText = Math.min(...textScored.map((item) => item.textScore));
  const maxText = Math.max(...textScored.map((item) => item.textScore));
  const range = maxText - minText;
  const scored = textScored
    .map(({ entry, textScore }) => {
      const normalizedTextScore = range === 0 ? 1 : (textScore - minText) / range;
      return { entry, rawScore: finalRankScore(entry, normalizedTextScore, settings) };
    })
    .filter((item) => item.rawScore > 0)
    .sort((a, b) => b.rawScore - a.rawScore);

  const maxScore = scored[0]?.rawScore || 1;
  return scored.slice(0, limit).map(({ entry, rawScore }) => ({
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    score: Number((rawScore / maxScore).toFixed(4)),
    kind: entry.kind,
    status: entry.status,
    confidence: entry.confidence,
    degraded: false,
    related_slugs: entry.relatedSlugs.slice(0, 5),
  }));
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function listEntries(entries: MemoryEntry[], filters: ListFilters, settings: MemorySettings) {
  const limit = clamp(
    Math.floor(filters.limit ?? settings.defaultLimit),
    1,
    settings.maxLimit,
  );
  const start = parseCursor(filters.cursor);

  // Facade (memory-architecture.md §3 + brain-redesign-spec.md §4.3): list does
  // NOT filter by scope or expose scope to the LLM. Results are merged across
  // all stores; ordering is by updated/created/confidence/slug only.
  const filtered = entries
    .filter((entry) => entryMatchesFilters(entry, filters))
    .sort((a, b) => {
      const au = a.updated || a.created || "";
      const bu = b.updated || b.created || "";
      if (au !== bu) return bu.localeCompare(au);
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return a.slug.localeCompare(b.slug);
    });

  const page = filtered.slice(start, start + limit);
  const next = start + limit < filtered.length ? String(start + limit) : undefined;

  return {
    entries: page.map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      kind: entry.kind,
      status: entry.status,
      confidence: entry.confidence,
      updated: entry.updated,
      created: entry.created,
      summary: entry.summary,
    })),
    ...(next ? { next_cursor: next } : {}),
  };
}

export function findEntry(entries: MemoryEntry[], slugRaw: string): { entry?: MemoryEntry; alternatives: MemoryEntry[] } {
  const slug = normalizeBareSlug(slugRaw);
  const matches = entries.filter((entry) => entry.slug === slug || normalizeBareSlug(entry.id || "") === slug);
  matches.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return (b.updated || b.created || "").localeCompare(a.updated || a.created || "");
  });
  return { entry: matches[0], alternatives: matches.slice(1) };
}

/** Lightweight meta projection for neighbor/related lists — no scope/source_path leak. */
function entryMeta(entry: MemoryEntry) {
  return {
    slug: entry.slug,
    title: entry.title,
    kind: entry.kind,
    status: entry.status,
    confidence: entry.confidence,
    summary: entry.summary,
  };
}

export function serializeEntry(entry: MemoryEntry, entries: MemoryEntry[], includeRelated: boolean, alternatives: MemoryEntry[]) {
  const related = includeRelated
    ? entry.relatedSlugs
      .map((slug) => findEntry(entries, slug).entry)
      .filter((e): e is MemoryEntry => !!e)
      .slice(0, 10)
      .map(entryMeta)
    : undefined;

  return {
    slug: entry.slug,
    id: entry.id,
    title: entry.title,
    scope: entry.scope,
    kind: entry.kind,
    status: entry.status,
    confidence: entry.confidence,
    created: entry.created,
    updated: entry.updated,
    source_path: entry.displayPath,
    summary: entry.summary,
    trigger_phrases: relationValues(entry.frontmatter.trigger_phrases),
    related_slugs: entry.relatedSlugs,
    frontmatter: entry.frontmatter,
    compiled_truth: entry.compiledTruth,
    timeline: entry.timeline,
    ...(includeRelated ? { related_entries: related ?? [] } : {}),
    ...(alternatives.length ? { also_found: alternatives.map((a) => ({ slug: a.slug, scope: a.scope, source_path: a.displayPath })) } : {}),
  };
}

interface NeighborResult {
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  edge_type: string;
  direction: "outgoing" | "incoming";
  distance: number;
}

function oneHopNeighbors(entries: MemoryEntry[], slug: string): NeighborResult[] {
  const targetSlug = normalizeBareSlug(slug);
  const out: NeighborResult[] = [];
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const target = bySlug.get(targetSlug);

  if (target) {
    for (const edge of target.relations) {
      const neighbor = bySlug.get(edge.to);
      if (!neighbor) continue;
      out.push({
        ...entryMeta(neighbor),
        edge_type: edge.type,
        direction: "outgoing",
        distance: 1,
      });
    }
  }

  for (const entry of entries) {
    if (entry.slug === targetSlug) continue;
    for (const edge of entry.relations) {
      if (edge.to !== targetSlug) continue;
      out.push({
        ...entryMeta(entry),
        edge_type: edge.type,
        direction: "incoming",
        distance: 1,
      });
    }
  }

  const seen = new Set<string>();
  return out.filter((n) => {
    const sig = `${n.slug}\0${n.edge_type}\0${n.direction}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

export function neighbors(entries: MemoryEntry[], slug: string, hop: number, max: number): NeighborResult[] {
  const start = normalizeBareSlug(slug);
  const results: NeighborResult[] = [];
  const seen = new Set([start]);
  let frontier = [start];

  for (let distance = 1; distance <= hop && frontier.length > 0; distance++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const n of oneHopNeighbors(entries, current)) {
        const item = { ...n, distance };
        if (!results.some((r) => r.slug === item.slug && r.edge_type === item.edge_type && r.direction === item.direction)) {
          results.push(item);
        }
        if (!seen.has(n.slug)) {
          seen.add(n.slug);
          next.push(n.slug);
        }
        if (results.length >= max) return results;
      }
    }
    frontier = next;
  }

  return results.slice(0, max);
}
