import type { FetchBackend, FetchOpts, FetchResult } from "../types";
import { htmlToMarkdown, extractTitle, truncateBytes } from "../utils/html-to-markdown";
import {
  safeFetch,
  combineSignals,
  UrlGuardError,
} from "../utils/url-guard";

const DEFAULT_FETCH_MAX_BYTES = 50_000;
const FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Absolute hard cap on raw bytes read from a single fetch — defends
// against pathological maxBytes values or unbounded streams.
const ABSOLUTE_MAX_RAW_BYTES = 5_000_000;

/**
 * Local web-fetch backend for web_fetch. Split out of the former
 * monolithic BraveProvider: fetch is provider-independent — it is a
 * local HTTP fetch with HTML→markdown extraction, not a Brave API call.
 *
 * `name` stays "brave" for output compatibility: web_fetch provenance
 * ("Provider: brave") and details.provider are unchanged by the
 * search/fetch split, so callers and tests keep seeing the same shape.
 *
 * Hardening from PR-A review (commit f4fc560 multi-LLM review):
 *   - fetch() consumes opts.signal (combined with timeout via
 *     AbortSignal.any) — caller cancel propagates to HTTP
 *   - fetch() routes through safeFetch (manual redirect + per-hop
 *     assertUrlSafe) — SSRF / DNS-rebinding closed
 *   - body is streamed with cumulative byte limit (not response.text()
 *     reading the whole body unconditionally) — memory bound
 *   - content-type whitelist refuses binary/unknown types instead of
 *     producing mojibake from Buffer.toString("utf8")
 */
export class BraveFetchBackend implements FetchBackend {
  readonly name = "brave";

  constructor(
    private readonly opts: {
      timeoutMs: number;
      allowPrivateNetworks: boolean;
    },
  ) {}

  async fetch(url: string, opts?: FetchOpts): Promise<FetchResult> {
    const maxBytes = opts?.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
    // Raw network read cap: HTML→markdown typically shrinks 2-4×, so
    // give the network read 4× maxBytes plus a floor of 200KB. Capped
    // by ABSOLUTE_MAX_RAW_BYTES to prevent pathological values.
    const maxRawBytes = Math.min(
      Math.max(maxBytes * 4, 200_000),
      ABSOLUTE_MAX_RAW_BYTES,
    );
    const signal = combineSignals([
      opts?.signal,
      AbortSignal.timeout(this.opts.timeoutMs),
    ]);

    let response: Response;
    try {
      response = await safeFetch(
        url,
        {
          headers: {
            "User-Agent": FETCH_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal,
        },
        {
          allowPrivateNetworks: this.opts.allowPrivateNetworks,
          maxRedirects: 5,
        },
      );
    } catch (e) {
      // Re-throw UrlGuardError with web-search context so caller's
      // tool-level error renderer points at the right config knob.
      if (e instanceof UrlGuardError) {
        throw new Error(`web_fetch refused: ${e.message}`);
      }
      throw e;
    }

    if (!response.ok) {
      throw new Error(`web_fetch HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    if (!isTextLikeContentType(contentType)) {
      // Drain and discard the body so the connection can be reused.
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw new Error(
        `web_fetch refusing non-text content-type: ${contentType ?? "unknown"}. ` +
        `Supported: text/html, text/plain, text/markdown, application/json, application/xml.`,
      );
    }

    const { raw, truncated: rawTruncated } = await readUpToBytes(
      response,
      maxRawBytes,
    );

    const isHtml = !contentType || /text\/html|application\/xhtml/i.test(contentType);
    const title = isHtml ? extractTitle(raw) : undefined;
    const body = isHtml ? htmlToMarkdown(raw) : raw;
    const { text, truncated: outputTruncated } = truncateBytes(body, maxBytes);
    const truncated = rawTruncated || outputTruncated;

    return {
      url,
      ...(title ? { title } : {}),
      content: text,
      ...(contentType ? { contentType } : {}),
      ...(truncated ? { truncated } : {}),
    };
  }
}

// ── Helpers (file-local) ────────────────────────────────────────

/**
 * Content-type whitelist. Rejecting binary types here prevents
 * Buffer.toString("utf8") from producing mojibake on PDFs / images
 * (review feedback from GPT-5.5 / DeepSeek).
 *
 * Unknown / missing content-type is permitted (best-effort treat as
 * HTML) — many static file servers omit the header on .html.
 */
function isTextLikeContentType(ct: string | undefined): boolean {
  if (!ct) return true;
  if (/^text\/html\b/i.test(ct)) return true;
  if (/^application\/xhtml\b/i.test(ct)) return true;
  if (/^text\/(plain|markdown|x-markdown|csv|x-rst|x-org)\b/i.test(ct)) return true;
  if (/^application\/(json|xml|ld\+json|[\w.-]+\+xml|[\w.-]+\+json)\b/i.test(ct)) return true;
  if (/^text\/(?!html|plain|markdown|x-markdown|csv|x-rst|x-org)/i.test(ct)) return true;
  return false;
}

/**
 * Stream a response body up to maxRawBytes, decoding as UTF-8 with a
 * streaming TextDecoder so multi-byte chars at chunk boundaries don't
 * corrupt. Cancels the reader once over budget — does NOT swallow the
 * whole body unconditionally (defends against pathological responses).
 */
async function readUpToBytes(
  response: Response,
  maxRawBytes: number,
): Promise<{ raw: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streamable body (rare path) — fall back to text() with the
    // same byte cap by reading and then truncating. text() respects
    // the Response's already-set content-length but we still need to
    // protect against missing/lying content-length.
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > maxRawBytes) {
      const buf = Buffer.from(raw, "utf8").subarray(0, maxRawBytes);
      return { raw: buf.toString("utf8"), truncated: true };
    }
    return { raw, truncated: false };
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let acc = "";
  let totalBytes = 0;
  let truncated = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      acc += decoder.decode(value, { stream: true });
      if (totalBytes >= maxRawBytes) {
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
    acc += decoder.decode(); // flush
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { raw: acc, truncated };
}
