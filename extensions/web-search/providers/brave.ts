import type { WebSearchProvider, SearchOpts, SearchResult, FetchOpts, FetchResult } from "../types";
import { htmlToMarkdown, extractTitle, truncateBytes } from "../utils/html-to-markdown";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_FETCH_MAX_BYTES = 50_000;
const FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Brave Search API backend. Built-in default for the web-search
 * extension per ADR 0027 PR-A decision #1: direct API call (not shell
 * out to skill script) — cleaner error handling, structured audit,
 * one fewer process per call.
 *
 * `fetch()` uses the provider-agnostic htmlToMarkdown utility (which
 * has no Brave coupling); future provider implementations (e.g.
 * JinaReaderProvider) can override fetch() with a richer reader service.
 *
 * API key source: process.env[opts.apiKeyEnv] — defaults to
 * BRAVE_API_KEY for zero-migration compat with the existing
 * brave-search skill (users keep their ~/.profile setup as-is).
 */
export class BraveProvider implements WebSearchProvider {
  readonly name = "brave";

  constructor(
    private readonly opts: {
      apiKeyEnv: string;
      defaultCount: number;
      timeoutMs: number;
    },
  ) {}

  private getApiKey(): string {
    const key = process.env[this.opts.apiKeyEnv];
    if (!key) {
      throw new Error(
        `web-search/brave: ${this.opts.apiKeyEnv} env var not set. ` +
        `Get a free Brave Search API key at ` +
        `https://api-dashboard.search.brave.com/app/keys, then either ` +
        `set the env var or switch webSearch.provider in ` +
        `~/.pi/agent/pi-astack-settings.json.`,
      );
    }
    return key;
  }

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const apiKey = this.getApiKey();
    const count = Math.max(1, Math.min(opts?.count ?? this.opts.defaultCount, 20));
    const country = (opts?.country ?? "US").toUpperCase();
    const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs;

    const params = new URLSearchParams({
      q: query,
      count: String(count),
      country,
    });
    if (opts?.freshness) params.append("freshness", opts.freshness);

    const url = `${BRAVE_API_URL}?${params.toString()}`;
    const response = await globalThis.fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Brave Search API HTTP ${response.status} ${response.statusText}` +
        (errBody ? ` — ${errBody.slice(0, 300)}` : ""),
      );
    }

    const data = await response.json() as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
    };

    const results: SearchResult[] = [];
    for (const r of data.web?.results ?? []) {
      if (results.length >= count) break;
      results.push({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
        ...(r.age ? { age: r.age } : {}),
      });
    }
    return results;
  }

  async fetch(url: string, opts?: FetchOpts): Promise<FetchResult> {
    const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs;
    const maxBytes = opts?.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;

    const response = await globalThis.fetch(url, {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`web_fetch HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    const raw = await response.text();

    // For non-HTML content types, return raw text truncated — no markdown extraction.
    const isHtml = !contentType || /text\/html|application\/xhtml/i.test(contentType);
    if (!isHtml) {
      const { text, truncated } = truncateBytes(raw, maxBytes);
      return {
        url,
        content: text,
        ...(contentType ? { contentType } : {}),
        ...(truncated ? { truncated } : {}),
      };
    }

    const title = extractTitle(raw);
    const markdown = htmlToMarkdown(raw);
    const { text, truncated } = truncateBytes(markdown, maxBytes);

    return {
      url,
      ...(title ? { title } : {}),
      content: text,
      ...(contentType ? { contentType } : {}),
      ...(truncated ? { truncated } : {}),
    };
  }
}
