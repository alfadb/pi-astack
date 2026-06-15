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
  /** Direct API key value, resolved with pi's config-value semantics:
   *  "!command" runs a shell command and uses its stdout (e.g.
   *  "!jq -r --arg k brave '.[$k]' $HOME/.pi/secrets.json"); "$VAR" /
   *  "${VAR}" interpolate env vars; anything else is a literal. Takes
   *  priority over apiKeyEnv. Lets the key live in a single secrets
   *  file instead of an environment variable. Empty/unset → fall back
   *  to apiKeyEnv. Default: "" (unset). */
  apiKey: string;
  /** Env var name to read API key from. Default: "BRAVE_API_KEY" — same
   *  as the existing brave-search skill, so users with ~/.profile setup
   *  need zero migration. When switching providers, set this to that
   *  provider's expected key env name (e.g. "KAGI_API_KEY"). Used only
   *  when apiKey is unset. */
  apiKeyEnv: string;
  /** Default search result count when caller omits `count`. 1..20.
   *  Default: 5. */
  defaultCount: number;
  /** Network timeout in ms for both search and fetch. Default: 15000. */
  timeout: number;
  /** SSRF escape hatch — when true, web_fetch is permitted to access
   *  RFC1918 / loopback / link-local / cloud-metadata IPs. Default: false.
   *  Set true only on dev machines where you knowingly want sub-agents
   *  to be able to reach your local services (Ollama, dev servers). */
  allowPrivateNetworks: boolean;
}

const DEFAULTS: WebSearchSettings = {
  provider: "brave",
  apiKey: "",
  apiKeyEnv: "BRAVE_API_KEY",
  defaultCount: 5,
  timeout: 15_000,
  allowPrivateNetworks: false,
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

function asBoolean(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return fallback;
}

export function loadWebSearchSettings(): WebSearchSettings {
  let raw: unknown = {};
  let parseError: Error | null = null;
  try {
    const txt = fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf8");
    raw = JSON.parse(txt);
  } catch (e) {
    // ENOENT (file missing) is silent — user just hasn't created
    // settings. Other errors (JSON syntax error etc.) are warned so
    // misconfigurations don't silently use defaults. Per PR-A review.
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "ENOENT") {
      /* silent */
    } else {
      parseError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (parseError) {
    console.warn(
      `[web-search] Failed to parse ${PI_STACK_SETTINGS_PATH}: ` +
      `${parseError.message}. Using default webSearch settings.`,
    );
  }

  const sec = (raw as Record<string, unknown>)?.webSearch as
    Record<string, unknown> | undefined;
  if (!sec || typeof sec !== "object") return { ...DEFAULTS };

  return {
    provider: asString(sec.provider, DEFAULTS.provider),
    apiKey: asString(sec.apiKey, DEFAULTS.apiKey),
    apiKeyEnv: asString(sec.apiKeyEnv, DEFAULTS.apiKeyEnv),
    defaultCount: Math.max(
      1,
      Math.min(20, Math.floor(asNumber(sec.defaultCount, DEFAULTS.defaultCount))),
    ),
    timeout: Math.max(1000, asNumber(sec.timeout, DEFAULTS.timeout)),
    allowPrivateNetworks: asBoolean(sec.allowPrivateNetworks, DEFAULTS.allowPrivateNetworks),
  };
}
