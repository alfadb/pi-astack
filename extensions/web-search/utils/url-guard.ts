/**
 * URL safety gate for outbound fetches.
 *
 * Per ADR 0027 PR-A review (commit f4fc560 multi-LLM review): sub-agent
 * has web_fetch in its default allowlist (extensions/dispatch/index.ts),
 * so any malicious prompt in a repo AGENTS.md or fetched page can attempt
 * to coerce fetches to internal targets:
 *   - cloud metadata services (AWS 169.254.169.254 / GCP / Azure)
 *   - localhost-bound dev services (Postgres / Redis / Consul / Ollama)
 *   - RFC1918 / link-local / loopback / CGNAT ranges
 *   - IPv6 ULA / link-local / loopback / IPv4-mapped
 *
 * Per ADR 0024 §3 + ADR 0027 C3': SSRF is *infra* layer — LLM cannot
 * inspect the IP behind a hostname, sub-agent self-discipline is
 * unreliable (it's the attack target itself). Code-level block is
 * the correct path; this does NOT violate AI-Native.
 *
 * Escape hatch: webSearch.allowPrivateNetworks=true in settings (for
 * developers wanting to fetch their own localhost / dev mock servers).
 */

import { promises as dns } from "node:dns";

export interface UrlGuardOptions {
  /** When true, skip the private-network block (developer mode). Default: false. */
  allowPrivateNetworks?: boolean;
  /** Max redirect hops for safeFetch. Default: 5. */
  maxRedirects?: number;
}

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlGuardError";
  }
}

// ── IP range checks ─────────────────────────────────────────────

/** Block 100.64.0.0/10 (CGNAT, RFC 6598) — covers 100.64..100.127 */
function isCgnat(ip: string): boolean {
  if (!ip.startsWith("100.")) return false;
  const second = parseInt(ip.split(".")[1] || "0", 10);
  return Number.isFinite(second) && second >= 64 && second <= 127;
}

/** Block 172.16.0.0/12 (RFC1918) — covers 172.16..172.31 */
function isPrivate172(ip: string): boolean {
  if (!ip.startsWith("172.")) return false;
  const second = parseInt(ip.split(".")[1] || "0", 10);
  return Number.isFinite(second) && second >= 16 && second <= 31;
}

function isPrivateIPv4(ip: string): boolean {
  // Quick prefix matches first.
  if (ip.startsWith("0.")) return true;          // 0.0.0.0/8 — current network
  if (ip.startsWith("10.")) return true;         // RFC1918
  if (ip.startsWith("127.")) return true;        // loopback
  if (ip.startsWith("169.254.")) return true;    // link-local + cloud metadata
  if (ip.startsWith("192.168.")) return true;    // RFC1918
  if (ip.startsWith("192.0.0.")) return true;    // RFC 7335 IETF reserved
  if (ip.startsWith("192.0.2.")) return true;    // TEST-NET-1
  if (ip.startsWith("198.51.100.")) return true; // TEST-NET-2
  if (ip.startsWith("203.0.113.")) return true;  // TEST-NET-3
  if (ip.startsWith("224.") || ip.startsWith("225.") || ip.startsWith("226.") ||
      ip.startsWith("227.") || ip.startsWith("228.") || ip.startsWith("229.") ||
      ip.startsWith("230.") || ip.startsWith("231.") || ip.startsWith("232.") ||
      ip.startsWith("233.") || ip.startsWith("234.") || ip.startsWith("235.") ||
      ip.startsWith("236.") || ip.startsWith("237.") || ip.startsWith("238.") ||
      ip.startsWith("239.")) return true;        // 224/4 multicast
  if (isPrivate172(ip)) return true;
  if (isCgnat(ip)) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true;           // loopback / unspecified
  if (lc.startsWith("fe80:") || lc.startsWith("fe80::")) return true;  // link-local fe80::/10
  if (lc.startsWith("fec0:") || lc.startsWith("fec0::")) return true;  // site-local (deprecated)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(lc)) return true;      // ULA fc00::/7
  if (lc.startsWith("ff")) return true;                   // multicast ff00::/8
  if (lc.startsWith("::ffff:")) {                         // IPv4-mapped
    const v4 = lc.replace(/^::ffff:/, "");
    return isPrivateIPv4(v4);
  }
  return false;
}

// ── Hostname blacklist (before DNS, defense in depth) ───────────

const BLOCKED_HOST_LITERALS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);

function isBlockedHostLiteral(host: string): boolean {
  const h = host.toLowerCase();
  if (BLOCKED_HOST_LITERALS.has(h)) return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;       // mDNS
  if (h.endsWith(".internal")) return true;    // cloud internal naming
  return false;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Validate a URL is safe to fetch. Throws UrlGuardError on:
 *   - non-http(s) scheme
 *   - malformed URL
 *   - blocked hostname literal (localhost / .local / cloud metadata)
 *   - hostname resolves to ANY private/loopback/link-local/multicast IP
 *
 * Resolves both IPv4 and IPv6 via dns.lookup({all:true}); if ANY address
 * is private we reject (don't let mixed public+private resolutions
 * through — partial DNS rebinding protection).
 *
 * Returns the parsed URL on success.
 */
export async function assertUrlSafe(
  url: string,
  opts?: UrlGuardOptions,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlGuardError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlGuardError(`Non-http(s) URL rejected: ${parsed.protocol}`);
  }

  if (opts?.allowPrivateNetworks) return parsed;

  const host = parsed.hostname.toLowerCase();
  if (isBlockedHostLiteral(host)) {
    throw new UrlGuardError(
      `Blocked hostname literal: ${host}. ` +
      `Set webSearch.allowPrivateNetworks=true to allow internal/dev fetches.`,
    );
  }

  // Strip IPv6 brackets if any (URL.hostname can return "[::1]" for IPv6).
  const hostNoBrackets = host.replace(/^\[|\]$/g, "");

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostNoBrackets, { all: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UrlGuardError(`DNS resolution failed for ${host}: ${msg}`);
  }

  if (addresses.length === 0) {
    throw new UrlGuardError(`DNS returned no addresses for ${host}`);
  }

  for (const a of addresses) {
    const blocked = a.family === 6 ? isPrivateIPv6(a.address) : isPrivateIPv4(a.address);
    if (blocked) {
      throw new UrlGuardError(
        `URL resolves to blocked IP: ${host} → ${a.address} ` +
        `(private/loopback/link-local/multicast). ` +
        `Set webSearch.allowPrivateNetworks=true to override.`,
      );
    }
  }

  return parsed;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Safe-redirect fetch wrapper: uses redirect:"manual", validates each
 * 3xx Location target through assertUrlSafe before following. Closes
 * the DNS-rebinding / redirect-to-internal attack vector that
 * `redirect: "follow"` opens.
 *
 * Returns the final Response.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
  opts: UrlGuardOptions,
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let currentUrl = url;
  let hops = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await assertUrlSafe(currentUrl, opts);
    const response = await globalThis.fetch(currentUrl, {
      ...init,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const next = response.headers.get("location");
    if (!next) return response;
    hops++;
    if (hops > maxRedirects) {
      throw new UrlGuardError(
        `Too many redirects (${hops} > ${maxRedirects}) starting from ${url}`,
      );
    }
    // Resolve relative Location against current URL.
    currentUrl = new URL(next, currentUrl).toString();
  }
}

/**
 * Combine multiple AbortSignals into one. If any input signal aborts,
 * the returned signal aborts with the same reason. Uses native
 * AbortSignal.any when available (Node 20.3+), falls back to manual
 * wiring otherwise. Filters out undefined inputs.
 */
export function combineSignals(
  signals: (AbortSignal | undefined)[],
): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => s !== undefined);
  if (valid.length === 0) return new AbortController().signal;
  if (valid.length === 1) return valid[0];
  const Any = (AbortSignal as unknown as {
    any?: (s: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof Any === "function") return Any(valid);
  // Manual fallback (Node < 20.3).
  const ctrl = new AbortController();
  for (const s of valid) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
