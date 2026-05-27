/**
 * Public types for the web-search extension. Stable contract that
 * provider implementations and tool wiring depend on.
 *
 * Per ADR 0027 (CSDLAS) PR-A: web_search / web_fetch are L2-worker
 * read tools, exposed to sub-agents by default. Backend is pluggable
 * (built-in Brave; future Google CSE / Kagi / Bing / Serper / Tavily /
 * Jina Reader / SearXNG) so different users / scenarios can swap
 * providers without touching tool callers.
 */

/** Web search backend contract. V1 backend selection is via
 *  settings.webSearch.provider (switch-case in registry.ts); V2 will
 *  open a public registerWebSearchProvider() hook similar to pi's
 *  registerProvider for LLM backends. */
export interface WebSearchProvider {
  readonly name: string;
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  fetch(url: string, opts?: FetchOpts): Promise<FetchResult>;
}

export interface SearchOpts {
  /** Result count, 1..20. Default: settings.webSearch.defaultCount. */
  count?: number;
  /** Brave-compatible freshness: 'pd' (day) / 'pw' (week) / 'pm' (month) /
   *  'py' (year) / 'YYYY-MM-DDtoYYYY-MM-DD'. Other providers may map. */
  freshness?: string;
  /** ISO 3166 alpha-2 country code (e.g. "US", "DE"). Default: "US". */
  country?: string;
  /** Per-call timeout override (ms). Default: settings.webSearch.timeout. */
  timeoutMs?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Free-form age string from backend (e.g. "2 days ago"). Optional. */
  age?: string;
}

export interface FetchOpts {
  /** Truncate returned content to this many bytes. Default: 50_000. */
  maxBytes?: number;
  /** Per-call timeout override (ms). Default: settings.webSearch.timeout. */
  timeoutMs?: number;
}

export interface FetchResult {
  url: string;
  title?: string;
  /** Markdown-ish text. Built-in BraveProvider uses a minimal regex
   *  extractor — "good enough for LLM", not "lossless". For higher
   *  fidelity, register a provider backed by Jina Reader / Mercury
   *  Parser / similar reader service. */
  content: string;
  contentType?: string;
  /** True if content was truncated to fit maxBytes. */
  truncated?: boolean;
}
