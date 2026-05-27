/**
 * web-search extension for pi-astack.
 *
 * Registers two read-only tools — web_search and web_fetch — backed by
 * a pluggable WebSearchProvider abstraction (types.ts). Built-in
 * provider: Brave Search API (providers/brave.ts). User switches
 * backends via webSearch.provider in pi-astack-settings.json.
 *
 * ADR 0027 (CSDLAS) PR-A context:
 *   - C1' L1↔L2 共生 + Tier-2 worker 应能读外部环境 → web_search /
 *     web_fetch 是 sub-agent default-allowlist 成员
 *   - C3' infra 层 structured → tool schema 化（不走 bash + skill 脚本）
 *   - extensions/dispatch/index.ts KNOWN_TOOLS + default allowlist
 *     patched in the same commit; sub-agents get these tools without
 *     an explicit `tools` allowlist parameter.
 *
 * Backend swap: built-in is Brave (~80 LOC direct HTTP call); future
 * providers (Google CSE / Kagi / Bing / Serper / Tavily / Jina Reader /
 * SearXNG) plug in via registry.ts switch-case in V1, and via a public
 * registerWebSearchProvider() hook in V2.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadWebSearchSettings } from "./settings";
import { createProvider } from "./registry";
import type { WebSearchProvider, SearchResult } from "./types";

// Lazy provider — instantiated on first tool call so settings reload
// without process restart works (e.g. user edits settings during
// session, next call picks up new provider).
let _provider: WebSearchProvider | undefined;
function getProvider(): WebSearchProvider {
  if (!_provider) _provider = createProvider(loadWebSearchSettings());
  return _provider;
}

/** Reset hook for tests / future settings hot-reload. Exported for
 *  smoke scripts; not registered as a tool. */
export function resetWebSearchProvider(): void {
  _provider = undefined;
}

function formatSearchResults(
  providerName: string,
  query: string,
  results: SearchResult[],
): string {
  if (results.length === 0) {
    return `(${providerName}) No results for: ${query}`;
  }
  const lines: string[] = [
    `(${providerName}) ${results.length} results for: ${query}`,
    "",
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`--- Result ${i + 1} ---`);
    lines.push(`Title: ${r.title}`);
    lines.push(`Link: ${r.url}`);
    if (r.age) lines.push(`Age: ${r.age}`);
    lines.push(`Snippet: ${r.snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // ADR 0014 §6: sub-pi (sediment / multi-view internal sub-processes)
  // should not have web access. Skip registration when running as sub-pi.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web via a configurable backend (default: Brave Search). " +
      "Returns a list of result records with title, url, snippet, age. " +
      "Use for documentation, facts, news, or any task that needs " +
      "external knowledge beyond the local repo or brain.",
    promptSnippet: "web_search(query, count?, freshness?, country?)",
    promptGuidelines: [
      "Use web_search before assuming external facts (library docs, API specs, news). Cite results in your reasoning.",
      "Pair with web_fetch when a snippet is not enough: search → pick a url → fetch full page.",
      "freshness values: 'pd' (last day), 'pw' (week), 'pm' (month), 'py' (year), or 'YYYY-MM-DDtoYYYY-MM-DD' date range.",
      "Backend is pluggable via webSearch.provider in pi-astack-settings.json — default is Brave.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query string (required)" }),
      count: Type.Optional(Type.Number({ description: "Number of results, 1..20. Default: settings.webSearch.defaultCount (5)." })),
      freshness: Type.Optional(Type.String({ description: "Filter by time: 'pd' / 'pw' / 'pm' / 'py' / 'YYYY-MM-DDtoYYYY-MM-DD'." })),
      country: Type.Optional(Type.String({ description: "ISO 3166 alpha-2 country code (e.g. US, DE). Default: US." })),
    }),

    prepareArguments(rawArgs: unknown) {
      const a = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>) : {};
      const out: Record<string, unknown> = { query: String(a.query ?? "") };
      if (typeof a.count === "number") out.count = a.count;
      else if (typeof a.count === "string" && a.count.trim()) {
        const n = parseInt(a.count, 10);
        if (Number.isFinite(n)) out.count = n;
      }
      if (typeof a.freshness === "string" && a.freshness.trim()) out.freshness = a.freshness.trim();
      if (typeof a.country === "string" && a.country.trim()) out.country = a.country.trim().toUpperCase();
      return out as { query: string; count?: number; freshness?: string; country?: string };
    },

    async execute(
      _id: string,
      params: { query: string; count?: number; freshness?: string; country?: string },
      _signal: AbortSignal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
      if (!params.query) {
        return {
          content: [{ type: "text" as const, text: "❌ web_search: query is required and must be non-empty." }],
          details: { error: "empty query" },
          isError: true,
        };
      }
      try {
        const provider = getProvider();
        const results = await provider.search(params.query, {
          ...(params.count !== undefined ? { count: params.count } : {}),
          ...(params.freshness !== undefined ? { freshness: params.freshness } : {}),
          ...(params.country !== undefined ? { country: params.country } : {}),
        });
        const text = formatSearchResults(provider.name, params.query, results);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            provider: provider.name,
            query: params.query,
            count: results.length,
            results,
          },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `❌ web_search failed: ${msg}` }],
          details: { error: msg },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetch a URL and return its readable content as markdown. Use " +
      "after web_search to read full pages, or directly when you have " +
      "a known URL (docs link, GitHub README, etc.).",
    promptSnippet: "web_fetch(url, maxBytes?)",
    promptGuidelines: [
      "Prefer web_fetch over raw HTTP — it strips nav/footer/script and returns markdown.",
      "Default maxBytes is 50000; raise only if the page is genuinely large and you need it all.",
      "Backend is the same as web_search (pluggable; default Brave provider uses a minimal HTML→markdown extractor — good for 80% of docs/blog pages).",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to fetch (http:// or https://)" }),
      maxBytes: Type.Optional(Type.Number({ description: "Truncate content to this many bytes. Default: 50000." })),
    }),

    prepareArguments(rawArgs: unknown) {
      const a = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>) : {};
      const out: Record<string, unknown> = { url: String(a.url ?? "") };
      if (typeof a.maxBytes === "number") out.maxBytes = a.maxBytes;
      else if (typeof a.maxBytes === "string" && a.maxBytes.trim()) {
        const n = parseInt(a.maxBytes, 10);
        if (Number.isFinite(n)) out.maxBytes = n;
      }
      return out as { url: string; maxBytes?: number };
    },

    async execute(
      _id: string,
      params: { url: string; maxBytes?: number },
      _signal: AbortSignal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
      if (!params.url || !/^https?:\/\//i.test(params.url)) {
        return {
          content: [{ type: "text" as const, text: "❌ web_fetch: url must be an absolute http(s) URL." }],
          details: { error: "invalid url" },
          isError: true,
        };
      }
      try {
        const provider = getProvider();
        const result = await provider.fetch(
          params.url,
          params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : undefined,
        );
        const header = result.title
          ? `# ${result.title}\n${result.url}\n\n`
          : `${result.url}\n\n`;
        return {
          content: [{ type: "text" as const, text: header + result.content }],
          details: {
            provider: provider.name,
            url: result.url,
            title: result.title,
            contentType: result.contentType,
            truncated: result.truncated ?? false,
            bytes: Buffer.byteLength(result.content, "utf8"),
          },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `❌ web_fetch failed: ${msg}` }],
          details: { error: msg },
          isError: true,
        };
      }
    },
  });
}
