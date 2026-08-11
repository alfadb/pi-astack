/**
 * Shadow A/B telemetry for the web-search extension.
 *
 * When enabled (webSearch.shadow.enabled, default OFF) a deterministic
 * sample of web_search calls also runs the configured shadow search
 * backend in the background. The main provider response is never
 * affected: shadow failures are swallowed and only a best-effort JSONL
 * row is appended to `<projectRoot>/.pi-astack/web-search/shadow.jsonl`
 * (or webSearch.shadow.logPath — absolute paths only; relative paths are
 * rejected at settings load and fail closed to the default).
 *
 * Sampling is per *call event*: the gate is a pure sha256 of
 * (query, toolCallId), so the same event is reproducible while repeated
 * queries with different tool-call ids can land in different buckets.
 * The gate is deliberately key-less — it only decides whether a shadow
 * runs and never lands in the log, so sampling never triggers audit-key
 * creation.
 *
 * Privacy: the raw query is never logged — only a keyed HMAC digest
 * (auditHmacHex against the project-bound audit key under
 * `<projectRoot>/.pi-astack/llm-audit/`, 0700 dir / 0600 key file).
 * Snippets are never logged. By default (logUrls=false) result URLs are
 * logged only as HMAC digests (URL normalized BEFORE hashing) plus a
 * hostname-domain overview; set webSearch.shadow.logUrls=true to log
 * strictly normalized URLs instead (userinfo, fragments and ALL query
 * parameters stripped — tokens can never reach the log). The hostname
 * domain list is a deliberate authority-analysis signal and may reveal
 * which sites are of interest. Backend errors are reduced to a
 * normalized errorKind (+ a bare HTTP status number when available).
 * API keys / headers / full responses are never logged.
 *
 * Note: we deliberately do NOT describe these digests as "irreversible"
 * — they are keyed HMACs whose key material lives on this machine, so
 * the protection is key hygiene (per-project, mode-locked), not math.
 *
 * Cancellation: the shadow deliberately does NOT receive the caller's
 * signal — a main request that is cancelled after returning must not
 * kill its shadow. Boundedness comes from the backend's own
 * AbortSignal.timeout (settings.webSearch.timeout).
 *
 * Bounding: at most MAX_CONCURRENT_SHADOW_RUNS background searches run
 * at once — excess samples are dropped, never queued unboundedly — and
 * every promise rejection is consumed (no unhandled rejections).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SearchBackend, SearchResult } from "./types";
import { auditHmacHex } from "../_shared/audit-hmac";
import { ensureProjectGitignoredOnce, formatLocalIsoTimestamp } from "../_shared/runtime";

export const SHADOW_SCHEMA_VERSION = 2;
export const DEFAULT_SHADOW_LOG_RELATIVE = path.join(".pi-astack", "web-search", "shadow.jsonl");
/** Top-k used for the URL overlap metric. */
export const SHADOW_OVERLAP_TOP_K = 10;

const MAX_CONCURRENT_SHADOW_RUNS = 2;

/** HMAC domains for auditHmacHex — separates correlation namespaces so a
 *  digest can never be cross-replayed between query/url/call-id. */
const HMAC_DOMAIN_QUERY = "web-search-query";
const HMAC_DOMAIN_URL = "web-search-url";
const HMAC_DOMAIN_CALL_ID = "web-search-call-id";

export interface ShadowConfig {
  /** Shadow search backend provider name (must differ from main). */
  provider: string;
  /** Deterministic sampling rate, 0..1. */
  sampleRate: number;
  /** Absolute log path override; "" → <projectRoot>/DEFAULT_SHADOW_LOG_RELATIVE.
   *  Relative paths are rejected at settings load (fail closed to ""). */
  logPath: string;
  /** Log normalized URLs (true) or URL HMAC digests + hostname-domain
   *  overview (false, default). URL normalization strips userinfo,
   *  fragments and ALL query parameters; raw query + snippets are never
   *  logged either way. Hostname domains are a deliberate authority-
   *  analysis signal and may reveal site interests. */
  logUrls: boolean;
}

/** Normalized shadow-error categories. Raw provider error text (which
 *  may echo the request or sensitive upstream responses) is never
 *  logged — only the category and, when available, a bare HTTP status
 *  number. */
export type ShadowErrorKind =
  | "timeout"
  | "abort"
  | "http_4xx"
  | "http_5xx"
  | "auth"
  | "rate_limit"
  | "unsupported"
  | "other";

function extractHttpStatus(message: string): number | undefined {
  const m = message.match(/HTTP\s+(\d{3})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

/** Classify a shadow backend error into a safe, loggable category. */
export function classifyShadowError(e: unknown): { kind: ShadowErrorKind; status?: number } {
  if (e instanceof Error) {
    // AbortSignal.timeout() rejects with TimeoutError in Node/undici;
    // a plain AbortError means the request was aborted otherwise.
    if (e.name === "TimeoutError") return { kind: "timeout" };
    if (e.name === "AbortError") return { kind: "abort" };
    const status = extractHttpStatus(e.message);
    if (status !== undefined) {
      if (status === 401 || status === 403) return { kind: "auth", status };
      if (status === 429) return { kind: "rate_limit", status };
      if (status >= 400 && status < 500) return { kind: "http_4xx", status };
      if (status >= 500 && status < 600) return { kind: "http_5xx", status };
    }
    if (/not supported|unknown freshness/i.test(e.message)) return { kind: "unsupported" };
  }
  return { kind: "other" };
}

/** Hostname-only extraction for authority-quality analysis
 *  (logUrls=false). Never includes path/query/port; unparseable URLs
 *  are skipped by the caller. */
export function extractDomain(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainList(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const d = extractDomain(u);
    if (d) out.push(d);
  }
  return out;
}

// ── Deterministic call-event sampling ─────────────────────────

/** Uniform [0,1) sample fraction derived from (query, toolCallId) — the
 *  same call event always makes the same sampling decision (no RNG,
 *  reproducible A/B); repeated queries with different tool-call ids can
 *  fall into different buckets. Pure sha256, never persisted: this is a
 *  sampling gate, not a privacy record — persisted values are HMAC'd at
 *  write time (auditHash below), keeping key creation and sampling
 *  decoupled. */
export function sampleFraction(query: string, callId: string): number {
  const hash = crypto.createHash("sha256")
    .update(query, "utf8")
    .update("\u0000")
    .update(callId, "utf8")
    .digest();
  return hash.readUInt32BE(0) / 0x1_0000_0000;
}

/** Deterministic sample gate: true when the call event's stable fraction
 *  is below the configured rate. sampleRate is clamped to [0,1]; 0 disables. */
export function shouldSampleShadow(query: string, callId: string, sampleRate: number): boolean {
  if (!(sampleRate > 0)) return false;
  return sampleFraction(query, callId) < Math.min(1, sampleRate);
}

/** Keyed HMAC (project-bound audit key) for any value written to the
 *  shadow log — query, URLs, tool-call id. Returns the algorithm /
 *  key_id / digest triple so the log row is self-describing. The key
 *  material lives in <projectRoot>/.pi-astack/llm-audit/ (0700 dir /
 *  0600 key file); digests are only meaningful to the same project.
 *  Deliberately NOT described as "irreversible": with key material
 *  available the value can be recovered — the protection is key hygiene,
 *  not math. */
export function auditHash(
  projectRoot: string,
  domain: string,
  value: string,
): { algorithm: string; key_id: string; digest: string } {
  return auditHmacHex(projectRoot, domain, value);
}

// ── URL normalization + overlap ─────────────────────────────────

/** Light URL normalization for overlap comparison: lowercase host,
 *  drop fragment / default port / utm_* tracking params / trailing
 *  slash on path. Unparseable URLs compare as-is. Keeps other query
 *  params so pagination/context query strings don't collide. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const defaultPort =
      (u.protocol === "https:" && u.port === "443") ||
      (u.protocol === "http:" && u.port === "80");
    if (defaultPort) u.port = "";
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    if (u.pathname.endsWith("/") && u.pathname !== "/") u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

/** Strict normalization for anything that reaches the log (logUrls=true
 *  URLs AND the pre-HMAC normalization for hash mode): strips userinfo,
 *  fragments and EVERY query parameter so tokens / credentials /
 *  tracking payloads can never be logged or baked into a digest that
 *  leaks query-string structure. */
export function normalizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.toLowerCase();
    const defaultPort =
      (u.protocol === "https:" && u.port === "443") ||
      (u.protocol === "http:" && u.port === "80");
    if (defaultPort) u.port = "";
    if (u.pathname.endsWith("/") && u.pathname !== "/") u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

/** Count of shared URLs between the top-k of each result list. */
export function topKOverlap(a: string[], b: string[], k = SHADOW_OVERLAP_TOP_K): number {
  const pa = new Set(a.slice(0, k).map(normalizeUrl));
  const pb = new Set(b.slice(0, k).map(normalizeUrl));
  let overlap = 0;
  for (const x of pa) if (pb.has(x)) overlap++;
  return overlap;
}

// ── Bounded background runner + best-effort log ─────────────────

/** Process-global concurrency guard for background shadow searches. */
let activeShadowRuns = 0;

/** Per-path serialized append chains so concurrent shadow rows for the
 *  same log file never interleave mid-line. */
const shadowLogChains = new Map<string, Promise<void>>();

export interface ShadowRunInput {
  query: string;
  /** Tool-call id of the web_search event (causal anchor). Logged as an
   *  HMAC digest so a row can be correlated back to its trigger event
   *  without persisting the raw id. */
  callId: string;
  opts: { count?: number; freshness?: string; country?: string };
  primaryName: string;
  shadow: SearchBackend;
  primaryResults: SearchResult[];
  primaryLatencyMs: number;
  config: ShadowConfig;
  projectRoot: string;
}

/** Schedule a best-effort shadow search. Never throws, never affects the
 *  caller's result. Drops the sample (not queues it) when the concurrency
 *  budget is already consumed. */
export function scheduleShadowSearch(input: ShadowRunInput): void {
  if (activeShadowRuns >= MAX_CONCURRENT_SHADOW_RUNS) return;
  activeShadowRuns++;
  runShadowSearch(input)
    .catch(() => { /* shadow is telemetry — never surface */ })
    .finally(() => { activeShadowRuns--; });
}

/** Run one shadow search + append one JSONL row. Fully non-throwing. */
export async function runShadowSearch(input: ShadowRunInput): Promise<void> {
  const shadowStarted = performance.now();
  let shadowStatus: "ok" | "error" = "error";
  let shadowLatencyMs = 0;
  let shadowResults: SearchResult[] = [];
  let shadowErrorKind: ShadowErrorKind | undefined;
  let shadowErrorStatus: number | undefined;
  try {
    shadowResults = await input.shadow.search(input.query, {
      ...(input.opts.count !== undefined ? { count: input.opts.count } : {}),
      ...(input.opts.freshness !== undefined ? { freshness: input.opts.freshness } : {}),
      ...(input.opts.country !== undefined ? { country: input.opts.country } : {}),
    });
    shadowStatus = "ok";
  } catch (e) {
    // Normalized category only — never the raw provider error text.
    const cls = classifyShadowError(e);
    shadowErrorKind = cls.kind;
    shadowErrorStatus = cls.status;
  } finally {
    shadowLatencyMs = performance.now() - shadowStarted;
  }

  try {
    // Primary side is always ok here — the shadow only runs after a
    // successful main search (index.ts schedules it post-success).
    const primaryUrls = input.primaryResults.map((r) => r.url);
    const shadowUrls = shadowResults.map((r) => r.url);
    const bothOk = shadowStatus === "ok";
    // effectiveTopK reflects how many pairs were actually comparable
    // (shadow error → nothing comparable → null, not a misleading 10).
    const effectiveTopK = bothOk
      ? Math.min(SHADOW_OVERLAP_TOP_K, input.primaryResults.length, shadowResults.length)
      : null;
    const overlap = bothOk ? topKOverlap(primaryUrls, shadowUrls) : null;

    const queryHmac = auditHash(input.projectRoot, HMAC_DOMAIN_QUERY, input.query);
    const row: Record<string, unknown> = {
      schemaVersion: SHADOW_SCHEMA_VERSION,
      timestamp: formatLocalIsoTimestamp(),
      // Row-level HMAC metadata — all digests in this row share this key.
      hmac: { algorithm: queryHmac.algorithm, key_id: queryHmac.key_id },
      queryHash: queryHmac.digest,
      // Causal anchor: HMAC of the web_search tool-call id.
      callIdHash: auditHash(input.projectRoot, HMAC_DOMAIN_CALL_ID, input.callId).digest,
      primaryProvider: input.primaryName,
      shadowProvider: input.shadow.name,
      opts: input.opts,
      primary: {
        status: "ok",
        latencyMs: Math.round(input.primaryLatencyMs),
        resultCount: input.primaryResults.length,
      },
      shadow: {
        status: shadowStatus,
        latencyMs: Math.round(shadowLatencyMs),
        resultCount: shadowResults.length,
        ...(shadowStatus === "error" ? { errorKind: shadowErrorKind ?? "other" } : {}),
        ...(shadowErrorStatus !== undefined ? { errorStatus: shadowErrorStatus } : {}),
      },
      topK: SHADOW_OVERLAP_TOP_K,
      effectiveTopK,
      overlap,
    };
    if (input.config.logUrls) {
      row.primaryUrls = primaryUrls.map(normalizeUrlForLog);
      row.shadowUrls = shadowUrls.map(normalizeUrlForLog);
    } else {
      // URL normalized BEFORE hashing (query params / userinfo / fragments
      // are stripped first so digests carry no query-string structure).
      row.primaryUrlHashes = primaryUrls.map(
        (u) => auditHash(input.projectRoot, HMAC_DOMAIN_URL, normalizeUrlForLog(u)).digest,
      );
      row.shadowUrlHashes = shadowUrls.map(
        (u) => auditHash(input.projectRoot, HMAC_DOMAIN_URL, normalizeUrlForLog(u)).digest,
      );
      // Hostname-domain overview for authority-source quality analysis —
      // never includes paths, queries, ports or fragments. Deliberate
      // signal: it may still reveal which sites are of interest.
      row.primaryDomains = domainList(primaryUrls);
      row.shadowDomains = domainList(shadowUrls);
    }
    const logPath = resolveShadowLogPath(input.config, input.projectRoot);
    if (!input.config.logPath) {
      // Default log path lives under <projectRoot>/.pi-astack/ — keep it
      // out of git so `git add .` can't stage digests/domains. Best-effort:
      // only git repo roots are touched (see runtime helper). Custom
      // absolute logPath overrides are the user's own surface.
      try {
        await ensureProjectGitignoredOnce(input.projectRoot);
      } catch {
        /* best-effort — never block telemetry on .gitignore */
      }
    }
    await appendShadowLogRow(logPath, row);
  } catch {
    /* log write failure is best-effort — swallow */
  }
}

function resolveShadowLogPath(config: ShadowConfig, projectRoot: string): string {
  if (config.logPath) {
    // settings.ts already fails closed on relative paths; second line
    // of defense so a bad override can never write to a relative target.
    return path.isAbsolute(config.logPath)
      ? config.logPath
      : path.join(projectRoot || process.cwd(), DEFAULT_SHADOW_LOG_RELATIVE);
  }
  return path.join(projectRoot || process.cwd(), DEFAULT_SHADOW_LOG_RELATIVE);
}

/**
 * Serialized per-path append; errors swallowed so telemetry can never
 * break the caller.
 *
 * RESIDUAL BOUNDARY: at current volume (a few rows/min, ~1-10KB rows) a
 * per-path in-process promise chain is sufficient — O_APPEND writes of a
 * single line are atomic on POSIX for these sizes, and there is no
 * cross-process writer by construction (each pi process owns its shadow
 * rows for its own project). If volume grows (size caps / rotation) or a
 * second writer process ever appears (e.g. a dedicated shadow daemon),
 * this needs a real rotation policy + cross-process append lock —
 * deliberately not built now.
 */
function appendShadowLogRow(logPath: string, row: Record<string, unknown>): Promise<void> {
  const resolved = path.resolve(logPath);
  const prior = shadowLogChains.get(resolved) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, JSON.stringify(row) + "\n", { encoding: "utf8" });
  });
  shadowLogChains.set(resolved, next.catch(() => {}));
  return next;
}

/** Reset process-global shadow state. Exported for tests. */
export function resetShadowState(): void {
  activeShadowRuns = 0;
  shadowLogChains.clear();
}
