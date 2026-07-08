import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

/** Default Context7 REST API base. The official MCP server reads
 *  CONTEXT7_API_URL || `${CONTEXT7_BASE_URL}/api`; we expose the same
 *  override through settings.context7.baseUrl for self-hosted /
 *  enterprise endpoints. */
const DEFAULT_BASE_URL = "https://context7.com/api";

export interface Context7Settings {
  /** Master enable flag. When false the extension registers no tools.
   *  Per the "runtime kill-switch flags must be explicit in settings
   *  JSON" rule this is written explicitly in pi-astack-settings.json;
   *  the code default is true so projects that consume pi-astack without
   *  configuring a context7 section still get the tools. Default: true. */
  enabled: boolean;
  /** Context7 REST API base (no trailing slash). Default:
   *  "https://context7.com/api". */
  baseUrl: string;
  /** Direct API key value, resolved with pi's config-value semantics:
   *  "!command" runs a shell command and uses its stdout (e.g.
   *  "!jq -r --arg k context7 '.[$k] // empty' $HOME/.pi/secrets.json");
   *  "$VAR" / "${VAR}" interpolate env vars; anything else is a literal.
   *  Takes priority over apiKeyEnv. Context7 keys start with "ctx7sk".
   *  Empty/unset → fall back to apiKeyEnv. Default: "" (unset). */
  apiKey: string;
  /** Env var name to read the API key from when apiKey is unset.
   *  Default: "CONTEXT7_API_KEY". */
  apiKeyEnv: string;
  /** Network timeout in ms for both resolve and docs calls. Docs
   *  reranking can be slower than search, so the default is higher than
   *  web-search's. Minimum 1000. Default: 20000. */
  timeout: number;
}

const DEFAULTS: Context7Settings = {
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  apiKey: "",
  apiKeyEnv: "CONTEXT7_API_KEY",
  timeout: 20_000,
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

export function context7SettingsMtimeMs(): number | null {
  try {
    return fsSync.statSync(PI_STACK_SETTINGS_PATH).mtimeMs;
  } catch {
    return null;
  }
}

export function loadContext7Settings(): Context7Settings {
  let raw: unknown = {};
  let parseError: Error | null = null;
  try {
    const txt = fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf8");
    raw = JSON.parse(txt);
  } catch (e) {
    // ENOENT (file missing) is silent — user just hasn't created
    // settings, defaults apply. Other errors (JSON syntax) are warned
    // so misconfigurations don't silently fall back to defaults.
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "ENOENT") {
      /* silent */
    } else {
      parseError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (parseError) {
    console.warn(
      `[context7] Failed to parse ${PI_STACK_SETTINGS_PATH}: ` +
      `${parseError.message}. Using default context7 settings.`,
    );
  }

  const sec = (raw as Record<string, unknown>)?.context7 as
    Record<string, unknown> | undefined;
  if (!sec || typeof sec !== "object") return { ...DEFAULTS };

  return {
    enabled: asBoolean(sec.enabled, DEFAULTS.enabled),
    baseUrl: asString(sec.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ""),
    apiKey: asString(sec.apiKey, DEFAULTS.apiKey),
    apiKeyEnv: asString(sec.apiKeyEnv, DEFAULTS.apiKeyEnv),
    timeout: Math.max(1000, asNumber(sec.timeout, DEFAULTS.timeout)),
  };
}
