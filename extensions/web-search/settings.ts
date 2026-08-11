import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Test hook (smoke scripts): point settings loading at a temp file so
// tests never touch the real ~/.pi/agent/pi-astack-settings.json. Unset
// in normal operation.
const SETTINGS_PATH_ENV = "PI_ASTACK_WEB_SEARCH_SETTINGS_PATH";

const DEFAULT_PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

function settingsPath(): string {
  const override = process.env[SETTINGS_PATH_ENV];
  return override ? path.resolve(override) : DEFAULT_PI_STACK_SETTINGS_PATH;
}

export interface ProviderCredentialSettings {
  /** Direct API key value, resolved with pi's config-value semantics:
   *  "!command" runs a shell command and uses its stdout (e.g.
   *  "!jq -r --arg k brave '.[$k]' $HOME/.pi/secrets.json"); "$VAR" /
   *  "${VAR}" interpolate env vars; anything else is a literal. Takes
   *  priority over apiKeyEnv. Empty/unset → fall back to apiKeyEnv. */
  apiKey: string;
  /** Env var name to read API key from. */
  apiKeyEnv: string;
}

export interface ShadowSettings {
  /** Master switch. Default: false — shadow A/B is opt-in. */
  enabled: boolean;
  /** Shadow search backend provider name. Must differ from
   *  webSearch.provider; misconfigured/unknown names disable the shadow
   *  with a warning (never breaks the main tool). Default: "serper". */
  provider: string;
  /** Deterministic sampling rate 0..1, keyed on the call event
   *  (query + tool-call id): the same event always makes the same
   *  sampling decision (no RNG); repeated queries with different
   *  tool-call ids can fall in different buckets. Default: 0. */
  sampleRate: number;
  /** Absolute log path override. "" → <projectRoot>/.pi-astack/web-search/
   *  shadow.jsonl. Relative paths are rejected at load (fail closed to
   *  "" with a warning). Default: "". */
  logPath: string;
  /** Log normalized result URLs (true) or URL HMAC digests + hostname
   *  domains (false, default). URL normalization strips userinfo,
   *  fragments and ALL query parameters; raw query + snippets are never
   *  logged either way. Hostname domains are a deliberate authority-
   *  analysis signal and may still reveal site interests. */
  logUrls: boolean;
}

export interface WebSearchSettings {
  /** Backend provider name. Built-in: "brave" | "serper". V2 will
   *  accept names registered via registerSearchBackend(). Default:
   *  "brave". */
  provider: string;
  /** Brave credentials (provider-specific — never shared with Serper). */
  brave: ProviderCredentialSettings;
  /** Serper credentials (provider-specific — never shared with Brave). */
  serper: ProviderCredentialSettings;
  /** Legacy Brave API key (migration path). Superseded by brave.apiKey;
   *  kept so existing webSearch.apiKey / apiKeyEnv configs keep working
   *  for the Brave backend without edits. Serper never reads these. */
  apiKey: string;
  /** Legacy Brave key env var name. Superseded by brave.apiKeyEnv. */
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
  /** Shadow A/B telemetry (opt-in, default off). */
  shadow: ShadowSettings;
}

const DEFAULTS: WebSearchSettings = {
  provider: "brave",
  brave: { apiKey: "", apiKeyEnv: "BRAVE_API_KEY" },
  serper: { apiKey: "", apiKeyEnv: "SERPER_API_KEY" },
  apiKey: "",
  apiKeyEnv: "BRAVE_API_KEY",
  defaultCount: 5,
  timeout: 15_000,
  allowPrivateNetworks: false,
  shadow: {
    enabled: false,
    provider: "serper",
    sampleRate: 0,
    logPath: "",
    logUrls: false,
  },
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

/** Shadow log path: non-empty values MUST be absolute. Relative paths
 *  fail closed to "" (default <projectRoot>/.pi-astack/...) with a
 *  warning — a relative override would write somewhere surprising (and
 *  outside .pi-astack, skipping the gitignore guard). */
function shadowLogPath(shadowObj: Record<string, unknown>): string {
  const raw = asString(shadowObj.logPath, "");
  if (!raw) return raw;
  if (path.isAbsolute(raw)) return raw;
  console.warn(
    `[web-search] webSearch.shadow.logPath must be an absolute path; ` +
    `ignoring "${raw}" and using the default ` +
    `<projectRoot>/.pi-astack/web-search/shadow.jsonl.`,
  );
  return "";
}

/** Read an optional provider-specific credentials block
 *  (webSearch.<name>.apiKey / apiKeyEnv) with fallback to legacy keys. */
function loadCredentials(
  sec: Record<string, unknown>,
  name: string,
  legacy: { apiKey: string; apiKeyEnv: string },
  defaults: ProviderCredentialSettings,
): ProviderCredentialSettings {
  const block = sec[name];
  const obj = block && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : {};
  return {
    apiKey: asString(obj.apiKey, legacy.apiKey),
    apiKeyEnv: asString(obj.apiKeyEnv, legacy.apiKeyEnv) || defaults.apiKeyEnv,
  };
}

export function webSearchSettingsMtimeMs(): number | null {
  try {
    return fsSync.statSync(settingsPath()).mtimeMs;
  } catch {
    return null;
  }
}

export function loadWebSearchSettings(): WebSearchSettings {
  let raw: unknown = {};
  let parseError: Error | null = null;
  try {
    const txt = fsSync.readFileSync(settingsPath(), "utf8");
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
      `[web-search] Failed to parse ${settingsPath()}: ` +
      `${parseError.message}. Using default webSearch settings.`,
    );
  }

  const sec = (raw as Record<string, unknown>)?.webSearch as
    Record<string, unknown> | undefined;
  if (!sec || typeof sec !== "object") return { ...DEFAULTS };

  const legacyApiKey = asString(sec.apiKey, DEFAULTS.apiKey);
  const legacyApiKeyEnv = asString(sec.apiKeyEnv, DEFAULTS.apiKeyEnv);

  const shadowBlock = sec.shadow;
  const shadowObj = shadowBlock && typeof shadowBlock === "object" && !Array.isArray(shadowBlock)
    ? (shadowBlock as Record<string, unknown>)
    : {};

  return {
    provider: asString(sec.provider, DEFAULTS.provider),
    brave: loadCredentials(sec, "brave", { apiKey: legacyApiKey, apiKeyEnv: legacyApiKeyEnv }, DEFAULTS.brave),
    serper: loadCredentials(sec, "serper", { apiKey: "", apiKeyEnv: "" }, DEFAULTS.serper),
    apiKey: legacyApiKey,
    apiKeyEnv: legacyApiKeyEnv,
    defaultCount: Math.max(
      1,
      Math.min(20, Math.floor(asNumber(sec.defaultCount, DEFAULTS.defaultCount))),
    ),
    timeout: Math.max(1000, asNumber(sec.timeout, DEFAULTS.timeout)),
    allowPrivateNetworks: asBoolean(sec.allowPrivateNetworks, DEFAULTS.allowPrivateNetworks),
    shadow: {
      enabled: asBoolean(shadowObj.enabled, DEFAULTS.shadow.enabled),
      provider: asString(shadowObj.provider, DEFAULTS.shadow.provider),
      sampleRate: Math.max(
        0,
        Math.min(1, asNumber(shadowObj.sampleRate, DEFAULTS.shadow.sampleRate)),
      ),
      logPath: shadowLogPath(shadowObj),
      logUrls: asBoolean(shadowObj.logUrls, DEFAULTS.shadow.logUrls),
    },
  };
}
