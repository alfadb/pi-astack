import type { WebSearchProvider } from "./types";
import { BraveProvider } from "./providers/brave";
import type { WebSearchSettings } from "./settings";

/**
 * Built-in provider factory. V1 — closed switch-case. V2 will open
 * a public `registerWebSearchProvider(name, factory)` hook so other
 * extensions can register providers without modifying this file
 * (mirroring pi SDK's `pi.registerProvider` ecosystem hook for LLM
 * backends).
 *
 * To add a new built-in provider:
 *   1. Implement WebSearchProvider in providers/<name>.ts
 *   2. Add a case in the switch below
 *   3. Document its settings in pi-astack-settings.schema.json under
 *      webSearch.provider enum + add provider-specific fields if needed
 */
export function createProvider(settings: WebSearchSettings): WebSearchProvider {
  switch (settings.provider) {
    case "brave":
      return new BraveProvider({
        apiKeyEnv: settings.apiKeyEnv,
        defaultCount: settings.defaultCount,
        timeoutMs: settings.timeout,
      });
    default:
      throw new Error(
        `web-search: unknown provider "${settings.provider}". ` +
        `Built-in providers: brave. Set webSearch.provider in ` +
        `~/.pi/agent/pi-astack-settings.json.`,
      );
  }
}
