import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export interface WebSearchSettings {
  /** Backend provider name. Built-in: "brave". V2 will accept names
   *  registered via registerWebSearchProvider(). Default: "brave". */
  provider: string;
  /** Env var name to read API key from. Default: "BRAVE_API_KEY" — same
   *  as the existing brave-search skill, so users with ~/.profile setup
   *  need zero migration. When switching providers, set this to that
   *  provider's expected key env name (e.g. "KAGI_API_KEY"). */
  apiKeyEnv: string;
  /** Default search result count when caller omits `count`. 1..20.
   *  Default: 5. */
  defaultCount: number;
  /** Network timeout in ms for both search and fetch. Default: 15000. */
  timeout: number;
}

const DEFAULTS: WebSearchSettings = {
  provider: "brave",
  apiKeyEnv: "BRAVE_API_KEY",
  defaultCount: 5,
  timeout: 15_000,
};

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number"
    ? v
    : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function loadWebSearchSettings(): WebSearchSettings {
  let raw: unknown = {};
  try {
    const txt = fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf8");
    raw = JSON.parse(txt);
  } catch { /* file missing or unparseable → use defaults */ }

  const sec = (raw as Record<string, unknown>)?.webSearch as
    Record<string, unknown> | undefined;
  if (!sec || typeof sec !== "object") return { ...DEFAULTS };

  return {
    provider: asString(sec.provider, DEFAULTS.provider),
    apiKeyEnv: asString(sec.apiKeyEnv, DEFAULTS.apiKeyEnv),
    defaultCount: Math.max(
      1,
      Math.min(20, Math.floor(asNumber(sec.defaultCount, DEFAULTS.defaultCount))),
    ),
    timeout: Math.max(1000, asNumber(sec.timeout, DEFAULTS.timeout)),
  };
}
