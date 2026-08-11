/**
 * Public types for the web-search extension. Stable contract that
 * provider implementations and tool wiring depend on.
 *
 * Per ADR 0027 (CSDLAS) PR-A: web_search / web_fetch are L2-worker
 * read tools, exposed to sub-agents by default. Backends are pluggable
 * (built-in Brave + Serper search; local fetch with SSRF guard; future
 * Google CSE / Kagi / Bing / Tavily / Jina Reader / SearXNG) so
 * different users / scenarios can swap providers without touching tool
 * callers.
 *
 * Search and fetch were split into independent contracts (SearchBackend
 * / FetchBackend) so a search provider (e.g. Serper) can be swapped
 * without dragging in a fetch implementation: web_fetch always uses the
 * same local fetch backend regardless of which search backend is
 * active. WebSearchProvider is kept as a backward-compatible alias for
 * providers that implement both sides.
 */

/** Search backend contract. V1 backend selection is via
 *  settings.webSearch.provider (switch-case in registry.ts); V2 will
 *  open a public registerSearchBackend() hook similar to pi's
 *  registerProvider for LLM backends. */
export interface SearchBackend {
  readonly name: string;
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
}

/** Fetch backend contract — the local fetch implementation with SSRF /
 *  redirect / content-type / byte-cap hardening (provider-independent). */
export interface FetchBackend {
  readonly name: string;
  fetch(url: string, opts?: FetchOpts): Promise<FetchResult>;
}

/** Backward-compatible alias for providers that implement both sides. */
export interface WebSearchProvider extends SearchBackend, FetchBackend {}

export interface SearchOpts {
  /** Result count, 1..20. Default: settings.webSearch.defaultCount. */
  count?: number;
  /** Time-window filter. All backends accept Brave-format relative
   *  tokens ('pd' / 'pw' / 'pm' / 'py'). Explicit date ranges
   *  ('YYYY-MM-DDtoYYYY-MM-DD') are supported by the Brave backend only
   *  — the Serper backend fails closed on anything but pd/pw/pm/py.
   *  The format is implementation-defined per provider. */
  freshness?: string;
  /** ISO 3166 alpha-2 country code (e.g. "US", "DE"). Default: "US". */
  country?: string;
  /** Abort signal for cancellation. Combined with the provider's
   *  internal timeout via AbortSignal.any. */
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Free-form age string from backend (e.g. "2 days ago"). Optional. */
  age?: string;
}

export interface FetchOpts {
  /** Truncate returned content to this many bytes. Default: 50_000.
   *  Also bounds the raw network read (provider may read up to
   *  maxBytes * 4 bytes from the wire to leave room for HTML→markdown
   *  shrinkage). */
  maxBytes?: number;
  /** Abort signal for cancellation. Combined with the provider's
   *  internal timeout via AbortSignal.any. */
  signal?: AbortSignal;
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
