import type { SearchBackend, SearchOpts, SearchResult } from "../types";
import { resolveSecret } from "../utils/secret";
import { combineSignals } from "../utils/url-guard";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

/**
 * Brave Search API backend. Built-in default search backend for the
 * web-search extension per ADR 0027 PR-A. Split out of the former
 * monolithic BraveProvider (which bundled search + fetch); the fetch
 * side now lives in providers/brave-fetch.ts and is provider-independent.
 *
 * Hardening from PR-A review (commit f4fc560 multi-LLM review):
 *   - search() consumes opts.signal (combined with timeout via
 *     AbortSignal.any) — caller cancel propagates to HTTP
 *   - count clamp is integer-rounded — Brave API gets no fractional
 *   - error body is truncated and never echoes the API key
 */
export class BraveSearchBackend implements SearchBackend {
  readonly name = "brave";

  constructor(
    private readonly opts: {
      apiKey?: string;
      apiKeyEnv: string;
      defaultCount: number;
      timeoutMs: number;
    },
  ) {}

  private getApiKey(): string {
    // Priority 1: provider-specific webSearch.brave.apiKey, falling back
    // to the legacy webSearch.apiKey ("!command" / "$ENV" / literal) —
    // lets the key live in a single secrets file instead of an env var.
    if (this.opts.apiKey) {
      const resolved = resolveSecret(this.opts.apiKey);
      if (resolved) return resolved;
      // Never echo the configured value — it may be a secret literal or
      // reveal the secrets path. The field name alone is enough to fix.
      throw new Error(
        `web-search/brave: webSearch.brave.apiKey is set but resolved empty ` +
        `(the referenced command produced no output, or the env var is ` +
        `missing). Check webSearch.brave.apiKey in ` +
        `~/.pi/agent/pi-astack-settings.json.`,
      );
    }
    // Priority 2: provider-specific / legacy env var (webSearch.brave.apiKeyEnv
    // or webSearch.apiKeyEnv).
    const key = process.env[this.opts.apiKeyEnv];
    if (!key) {
      throw new Error(
        `web-search/brave: no API key. Set webSearch.brave.apiKey (e.g. ` +
        `"!jq -r --arg k brave '.[$k]' $HOME/.pi/secrets.json") or the ` +
        `${this.opts.apiKeyEnv} env var in ~/.pi/agent/pi-astack-settings.json. ` +
        `Get a free Brave Search API key at ` +
        `https://api-dashboard.search.brave.com/app/keys.`,
      );
    }
    return key;
  }

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const apiKey = this.getApiKey();
    // count is always Brave-bound: clamp to [1,20] and integer-round.
    // Floor first to handle non-integer caller input (e.g. 5.7 → 5).
    const rawCount = Math.floor(opts?.count ?? this.opts.defaultCount);
    const count = Math.max(1, Math.min(rawCount || 1, 20));
    const country = (opts?.country ?? "US").toUpperCase();
    const signal = combineSignals([
      opts?.signal,
      AbortSignal.timeout(this.opts.timeoutMs),
    ]);

    const params = new URLSearchParams({
      q: query,
      count: String(count),
      country,
    });
    if (opts?.freshness) params.append("freshness", opts.freshness);

    const url = `${BRAVE_API_URL}?${params.toString()}`;
    // Brave API endpoint is fixed and trusted — no need to route through
    // safeFetch (which is for arbitrary user-provided URLs in fetch()).
    const response = await globalThis.fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal,
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
}
