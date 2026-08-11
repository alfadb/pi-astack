import type { SearchBackend, SearchOpts, SearchResult } from "../types";
import { resolveSecret } from "../utils/secret";
import { combineSignals } from "../utils/url-guard";

const SERPER_API_URL = "https://google.serper.dev/search";

// Serper proxies Google's tbs parameter. Relative freshness windows map
// 1:1 to qdr:* — reliable. Explicit date ranges are NOT supported (see
// mapSerperFreshness) and fail closed instead of being silently ignored.
const FRESHNESS_TBS: Record<string, string> = {
  pd: "qdr:d",
  pw: "qdr:w",
  pm: "qdr:m",
  py: "qdr:y",
};

/**
 * Serper.dev Google search backend (POST https://google.serper.dev/search,
 * X-API-KEY auth). Search-only — web_fetch keeps using the local
 * BraveFetchBackend regardless of which search backend is active.
 *
 * Hardening mirrors providers/brave-search.ts:
 *   - opts.signal combined with timeout via AbortSignal.any
 *   - count clamped to [1,20] and integer-rounded (Serper `num`)
 *   - error body truncated (300 chars) and never echoes the API key
 *   - freshness: pd/pw/pm/py → tbs qdr:d/w/m/y; anything else
 *     (including explicit date ranges) fails closed with a clear error
 */
export class SerperSearchBackend implements SearchBackend {
  readonly name = "serper";

  constructor(
    private readonly opts: {
      apiKey?: string;
      apiKeyEnv: string;
      defaultCount: number;
      timeoutMs: number;
    },
  ) {}

  private getApiKey(): string {
    // Provider-specific webSearch.serper.apiKey ("!command" / "$ENV" /
    // literal), same resolveSecret semantics as Brave. Deliberately NOT
    // shared with webSearch.apiKey/apiKeyEnv — those are Brave-migration
    // keys, so Brave/Serper credentials can never shadow each other.
    if (this.opts.apiKey) {
      const resolved = resolveSecret(this.opts.apiKey);
      if (resolved) return resolved;
      // Never echo the configured value — it may be a secret literal or
      // reveal the secrets path. The field name alone is enough to fix.
      throw new Error(
        `web-search/serper: webSearch.serper.apiKey is set but resolved empty ` +
        `(the referenced command produced no output, or the env var is ` +
        `missing). Check webSearch.serper.apiKey in ` +
        `~/.pi/agent/pi-astack-settings.json.`,
      );
    }
    const key = process.env[this.opts.apiKeyEnv];
    if (!key) {
      throw new Error(
        `web-search/serper: no API key. Set webSearch.serper.apiKey (e.g. ` +
        `"!jq -r --arg k serper '.[$k]' $HOME/.pi/secrets.json") or the ` +
        `${this.opts.apiKeyEnv} env var in ~/.pi/agent/pi-astack-settings.json. ` +
        `Get a free Serper API key at https://serper.dev.`,
      );
    }
    return key;
  }

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const apiKey = this.getApiKey();
    const rawCount = Math.floor(opts?.count ?? this.opts.defaultCount);
    const count = Math.max(1, Math.min(rawCount || 1, 20));
    const country = (opts?.country ?? "US").toUpperCase();
    const signal = combineSignals([
      opts?.signal,
      AbortSignal.timeout(this.opts.timeoutMs),
    ]);

    const body: Record<string, unknown> = {
      q: query,
      num: count,
      // Google geolocation (gl) uses lowercase ISO 3166-1 alpha-2 codes
      // (e.g. "us", "de"); Serper passes gl through verbatim.
      gl: country.toLowerCase(),
    };
    if (opts?.freshness) {
      // Throws on unsupported values (incl. explicit date ranges) — fail
      // closed rather than silently dropping the caller's time filter.
      body.tbs = mapSerperFreshness(opts.freshness);
    }

    const response = await globalThis.fetch(SERPER_API_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Serper API HTTP ${response.status} ${response.statusText}` +
        (errBody ? ` — ${errBody.slice(0, 300)}` : ""),
      );
    }

    const data = await response.json() as {
      organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
    };

    const results: SearchResult[] = [];
    for (const r of data.organic ?? []) {
      if (results.length >= count) break;
      results.push({
        title: r.title ?? "",
        url: r.link ?? "",
        snippet: r.snippet ?? "",
        ...(r.date ? { age: r.date } : {}),
      });
    }
    return results;
  }
}

/**
 * Map the tool's freshness token to Google's tbs value (Serper passes
 * tbs through verbatim). Relative windows map 1:1 and are reliable.
 * Explicit "YYYY-MM-DDtoYYYY-MM-DD" ranges have no stable tbs encoding
 * via Serper — failing closed with a clear error beats silently serving
 * an unfiltered (or wrongly filtered) result set.
 */
export function mapSerperFreshness(freshness: string): string {
  const key = freshness.trim().toLowerCase();
  const tbs = FRESHNESS_TBS[key];
  if (tbs) return tbs;
  if (/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error(
      `web-search/serper: explicit date range "${freshness}" is not supported by the ` +
      `Serper backend (Google tbs only maps relative windows pd/pw/pm/py). ` +
      `Use one of pd/pw/pm/py, or switch webSearch.provider to "brave" for ` +
      `date-range filtering.`,
    );
  }
  throw new Error(
    `web-search/serper: unknown freshness value "${freshness}". ` +
    `Supported: pd (last day), pw (last week), pm (last month), py (last year).`,
  );
}
