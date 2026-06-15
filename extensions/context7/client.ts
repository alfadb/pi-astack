/**
 * Context7 REST client — thin wrapper over the same two HTTP endpoints
 * the official `@upstash/context7-mcp` server calls (v3.2.x):
 *
 *   - GET {base}/v2/libs/search?query=<task>&libraryName=<name>
 *       → JSON { results: SearchResult[], error?, searchFilterApplied? }
 *   - GET {base}/v2/context?query=<task>&libraryId=<id>
 *       → text/plain documentation + code snippets (already reranked
 *         server-side against `query`)
 *
 * Auth: `Authorization: Bearer <ctx7sk...>`. We deliberately do NOT
 * replicate the MCP server's optional client-IP encryption / Clerk
 * OAuth telemetry — those are for Context7's per-IP rate accounting and
 * are not required to call the API with a key.
 *
 * Per pi: this is an infra-layer capability schematized as a tool
 * (ADR 0027 C3'), structurally a sibling of web-search. The returned
 * docs are UNTRUSTED external content — the tool layer wraps them in
 * <untrusted_external_content> tags (see index.ts).
 */
import { resolveSecret } from "./secret";
import type { Context7Settings } from "./settings";

/** Header value identifying this client to Context7 telemetry. */
const CLIENT_SOURCE = "pi-astack";
const CLIENT_VERSION = "1.0.0";

/** Library candidate returned by the search endpoint. Field set mirrors
 *  `@upstash/context7-mcp` formatSearchResult (utils.js). Every field
 *  past `id`/`title`/`description` is optional / best-effort. */
export interface Context7Library {
  id: string;
  title?: string;
  description?: string;
  totalSnippets?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
  source?: string;
}

interface SearchResponse {
  results?: Context7Library[];
  error?: string;
  searchFilterApplied?: boolean;
}

export class Context7Error extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "Context7Error";
  }
}

/** Combine optional caller signal with an internal timeout signal. */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  if (valid.length === 1) return valid[0];
  return AbortSignal.any(valid);
}

export class Context7Client {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly settings: Context7Settings) {
    this.baseUrl = settings.baseUrl;
    this.timeoutMs = settings.timeout;
  }

  /** Resolve the API key once per call (resolveSecret caches !command
   *  output for the process lifetime). Fails closed with an actionable
   *  message when neither apiKey nor apiKeyEnv yields a value. */
  private getApiKey(): string {
    if (this.settings.apiKey) {
      const resolved = resolveSecret(this.settings.apiKey);
      if (resolved) return resolved;
      throw new Context7Error(
        `context7: context7.apiKey is set but resolved empty (command ` +
        `produced no output, or referenced env var is missing): ` +
        `${this.settings.apiKey}`,
      );
    }
    const key = process.env[this.settings.apiKeyEnv];
    if (!key) {
      throw new Context7Error(
        `context7: no API key. Set context7.apiKey (e.g. ` +
        `"!jq -r --arg k context7 '.[$k] // empty' $HOME/.pi/secrets.json") ` +
        `or the ${this.settings.apiKeyEnv} env var in ` +
        `~/.pi/agent/pi-astack-settings.json. Create a key at ` +
        `https://context7.com/dashboard (keys start with "ctx7sk").`,
      );
    }
    return key;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      "Authorization": `Bearer ${apiKey}`,
      "X-Context7-Source": CLIENT_SOURCE,
      "X-Context7-Server-Version": CLIENT_VERSION,
    };
  }

  private async parseError(response: Response, hasKey: boolean): Promise<string> {
    let serverMsg = "";
    try {
      const json = await response.json() as { message?: string };
      if (json?.message) serverMsg = json.message;
    } catch { /* not JSON */ }
    if (serverMsg) return serverMsg;
    switch (response.status) {
      case 401:
        return "Invalid API key. Context7 keys start with 'ctx7sk'. Check context7.apiKey / secrets.json.";
      case 404:
        return "Library not found. Use context7_resolve to get a valid Context7-compatible library ID first.";
      case 429:
        return hasKey
          ? "Rate limited or quota exceeded. Upgrade at https://context7.com/plans for higher limits."
          : "Rate limited. Create a free API key at https://context7.com/dashboard for higher limits.";
      default:
        return `Context7 request failed with HTTP ${response.status}.`;
    }
  }

  /** Search for libraries matching `libraryName`; `query` is the user's
   *  task and drives server-side relevance ranking. */
  async search(
    libraryName: string,
    query: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ results: Context7Library[]; searchFilterApplied: boolean }> {
    const apiKey = this.getApiKey();
    const url = new URL(`${this.baseUrl}/v2/libs/search`);
    url.searchParams.set("query", query || libraryName);
    url.searchParams.set("libraryName", libraryName);

    const signal = combineSignals([opts?.signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await globalThis.fetch(url, { headers: this.headers(apiKey), signal });
    if (!response.ok) {
      throw new Context7Error(await this.parseError(response, true), response.status);
    }
    const data = await response.json() as SearchResponse;
    if (data.error) throw new Context7Error(data.error);
    return {
      results: Array.isArray(data.results) ? data.results : [],
      searchFilterApplied: Boolean(data.searchFilterApplied),
    };
  }

  /** Fetch reranked documentation for a resolved library ID. `query` is
   *  the user's task and drives server-side reranking. Returns raw
   *  text (UNTRUSTED — caller must frame it as external content). */
  async docs(
    libraryId: string,
    query: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    const apiKey = this.getApiKey();
    const url = new URL(`${this.baseUrl}/v2/context`);
    url.searchParams.set("query", query);
    url.searchParams.set("libraryId", libraryId);

    const signal = combineSignals([opts?.signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await globalThis.fetch(url, { headers: this.headers(apiKey), signal });
    if (!response.ok) {
      throw new Context7Error(await this.parseError(response, true), response.status);
    }
    return (await response.text()) ?? "";
  }
}

/** Source-reputation numeric → label, mirroring the MCP server's
 *  getSourceReputationLabel so output reads identically. */
export function reputationLabel(trustScore: number | undefined): string {
  if (trustScore === undefined || trustScore < 0) return "Unknown";
  if (trustScore >= 7) return "High";
  if (trustScore >= 4) return "Medium";
  return "Low";
}

/** Render a single library candidate, mirroring the MCP formatter. */
export function formatLibrary(lib: Context7Library): string {
  const lines = [
    `- Title: ${lib.title ?? "(untitled)"}`,
    `- Context7-compatible library ID: ${lib.id}`,
    `- Description: ${lib.description ?? ""}`,
  ];
  if (lib.totalSnippets !== undefined && lib.totalSnippets !== -1) {
    lines.push(`- Code Snippets: ${lib.totalSnippets}`);
  }
  lines.push(`- Source Reputation: ${reputationLabel(lib.trustScore)}`);
  if (lib.benchmarkScore !== undefined && lib.benchmarkScore > 0) {
    lines.push(`- Benchmark Score: ${lib.benchmarkScore}`);
  }
  if (lib.versions && lib.versions.length > 0) {
    lines.push(`- Versions: ${lib.versions.join(", ")}`);
  }
  if (lib.source) lines.push(`- Source: ${lib.source}`);
  return lines.join("\n");
}
