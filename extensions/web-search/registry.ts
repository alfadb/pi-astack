import type { SearchBackend, FetchBackend } from "./types";
import { BraveSearchBackend } from "./providers/brave-search";
import { BraveFetchBackend } from "./providers/brave-fetch";
import { SerperSearchBackend } from "./providers/serper";
import type { WebSearchSettings } from "./settings";
import type { ShadowConfig } from "./shadow";

/**
 * Built-in provider factory. V1 — closed switch-case. V2 will open
 * a public `registerSearchBackend(name, factory)` hook so other
 * extensions can register search backends without modifying this file
 * (mirroring pi SDK's `pi.registerProvider` ecosystem hook for LLM
 * backends).
 *
 * The former single WebSearchProvider (search + fetch) is split into
 * independent SearchBackend / FetchBackend: webSearch.provider selects
 * the search backend; web_fetch always uses the same local fetch
 * backend (providers/brave-fetch.ts) regardless of search provider —
 * and createFetchBackend() is independent of search config, so a typo'd
 * webSearch.provider can never break web_fetch. When shadow A/B is
 * enabled the shadow search backend is constructed alongside the main
 * one, so the settings-mtime hot-rebuild in index.ts rebuilds both
 * consistently.
 *
 * To add a new built-in search backend:
 *   1. Implement SearchBackend in providers/<name>.ts
 *   2. Add a case in createSearchBackend() below
 *   3. Document its settings in pi-astack-settings.schema.json under
 *      webSearch.provider enum + add provider-specific fields if needed
 */

export interface WebSearchBackends {
  /** Search backend selected by webSearch.provider. */
  search: SearchBackend;
  /** Fetch backend (local fetch; provider-independent). */
  fetch: FetchBackend;
  /** Shadow A/B search backend + config, or null when disabled /
   *  misconfigured (shadow never breaks the main tool). */
  shadow: { search: SearchBackend; config: ShadowConfig } | null;
}

/** Search side of the bundle: main backend + (when enabled) the shadow
 *  backend. Throws on an unknown main provider — that error is a
 *  web_search problem only and must never affect web_fetch (the fetch
 *  backend is built independently via createFetchBackend). */
export interface SearchBundle {
  search: SearchBackend;
  shadow: WebSearchBackends["shadow"];
}

/** Built-in search backend names. Mirror this when adding a new case to
 *  createSearchBackend() so the unknown-provider error stays accurate. */
const BUILTIN_SEARCH_BACKENDS = ["brave", "serper"] as const;

export function createSearchBackend(
  provider: string,
  settings: WebSearchSettings,
): SearchBackend {
  switch (provider) {
    case "brave":
      return new BraveSearchBackend({
        apiKey: settings.brave.apiKey,
        apiKeyEnv: settings.brave.apiKeyEnv,
        defaultCount: settings.defaultCount,
        timeoutMs: settings.timeout,
      });
    case "serper":
      return new SerperSearchBackend({
        apiKey: settings.serper.apiKey,
        apiKeyEnv: settings.serper.apiKeyEnv,
        defaultCount: settings.defaultCount,
        timeoutMs: settings.timeout,
      });
    default:
      throw new Error(
        `web-search: unknown provider "${provider}". ` +
        `Built-in providers: ${BUILTIN_SEARCH_BACKENDS.join(", ")}. ` +
        `Set webSearch.provider in ~/.pi/agent/pi-astack-settings.json.`,
      );
  }
}

/** Fetch backend construction is fully independent of search provider
 *  config: a typo'd webSearch.provider can never break web_fetch. */
export function createFetchBackend(settings: WebSearchSettings): FetchBackend {
  return new BraveFetchBackend({
    timeoutMs: settings.timeout,
    allowPrivateNetworks: settings.allowPrivateNetworks,
  });
}

/** Build the search bundle (main + shadow). Throws only on an unknown
 *  MAIN provider; shadow misconfiguration (unknown name, provider ==
 *  main) degrades to null with a warning and never breaks the main tool. */
export function createSearchBundle(settings: WebSearchSettings): SearchBundle {
  const search = createSearchBackend(settings.provider, settings);

  let shadow: WebSearchBackends["shadow"] = null;
  if (settings.shadow.enabled) {
    if (settings.shadow.provider === settings.provider) {
      console.warn(
        `[web-search] shadow provider "${settings.shadow.provider}" equals the ` +
        `main provider — shadow A/B is meaningless and disabled. Set ` +
        `webSearch.shadow.provider to a different backend.`,
      );
    } else {
      try {
        shadow = {
          search: createSearchBackend(settings.shadow.provider, settings),
          config: {
            provider: settings.shadow.provider,
            sampleRate: settings.shadow.sampleRate,
            logPath: settings.shadow.logPath,
            logUrls: settings.shadow.logUrls,
          },
        };
      } catch (e) {
        // Misconfigured shadow (e.g. unknown provider name) disables the
        // shadow with a warning — it must never break the main tool.
        console.warn(
          `[web-search] shadow provider "${settings.shadow.provider}" unavailable: ` +
          `${e instanceof Error ? e.message : String(e)}. Shadow A/B disabled.`,
        );
      }
    }
  }

  return { search, shadow };
}

export function createProvider(settings: WebSearchSettings): WebSearchBackends {
  const { search, shadow } = createSearchBundle(settings);
  return { search, fetch: createFetchBackend(settings), shadow };
}
