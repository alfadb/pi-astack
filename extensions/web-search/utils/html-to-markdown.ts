/**
 * Minimal HTML → markdown extraction. Self-contained — no jsdom /
 * readability / turndown dependency. Per ADR 0027 PR-A decision:
 * keep web-search extension dependency-free for MVP; if Readability-
 * grade fidelity becomes blocking, add a Jina Reader / Mercury Parser
 * provider as a new WebSearchProvider implementation rather than
 * bloating the brave provider with heavy deps.
 *
 * Quality: good enough for 80% of documentation / blog / news pages.
 * Known limitations: heavy JavaScript SPAs (returns near-empty), complex
 * tables (loses structure), math (LaTeX raw), syntax-highlighted code
 * blocks (only basic <pre><code> recovered).
 */

const STRIP_TAGS = [
  "head", "script", "style", "noscript", "iframe",
  "nav", "header", "footer", "aside", "form", "button", "svg",
];

function stripTagBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    out = out.replace(re, "");
    // Also strip self-closing or unmatched-open of these structural tags
    const selfRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    out = out.replace(selfRe, "");
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF
        ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF
        ? String.fromCodePoint(code) : "";
    });
}

/** Inner-text helper — strips tags + decodes entities, used inside
 *  block-level transforms. Whitespace collapsed to single space. */
function stripInline(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const t = decodeEntities(m[1].trim()).replace(/\s+/g, " ");
  return t || undefined;
}

export function htmlToMarkdown(html: string): string {
  // 1. Strip structural / non-content tags.
  let out = stripTagBlocks(html, STRIP_TAGS);

  // 2. Pre/code blocks (run BEFORE headings/links so their inner content
  //    isn't accidentally transformed).
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_m, t) => `\n\n\`\`\`\n${decodeEntities(String(t).replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`);

  // 3. Headings h1..h6.
  for (let i = 1; i <= 6; i++) {
    const re = new RegExp(`<h${i}\\b[^>]*>([\\s\\S]*?)<\\/h${i}>`, "gi");
    out = out.replace(re, (_m, t) => `\n\n${"#".repeat(i)} ${stripInline(String(t))}\n\n`);
  }

  // 4. Inline code FIRST (before links): so `<a><code>fn</code></a>`
  //    becomes `<a>`fn`</a>` and then `[`fn`](href)` after step 5.
  //    Original order processed links first — stripInline ate the
  //    inner `<code>` tag, producing `[fn](href)` without backticks.
  //    Caught by ADR 0027 PR-A review (Opus). MDN / Rust std docs
  //    heavy on `<a><code>...</code></a>` benefit directly.
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_m, t) => `\`${stripInline(String(t))}\``);

  // 5. Links: <a href="X">Y</a> → [Y](X). Empty-text links dropped.
  //    stripInline drops HTML tags but preserves backticks from step 4.
  out = out.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, text) => {
      const t = stripInline(String(text));
      return t ? `[${t}](${href})` : "";
    });

  // 6. Bold / em.
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _tag, t) => `**${stripInline(String(t))}**`);
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _tag, t) => `*${stripInline(String(t))}*`);

  // 7. List items.
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    (_m, t) => `\n- ${stripInline(String(t))}`);

  // 8. Paragraphs / line breaks.
  out = out.replace(/<p\b[^>]*>/gi, "\n\n");
  out = out.replace(/<\/p>/gi, "");
  out = out.replace(/<br\b[^>]*\/?>/gi, "\n");

  // 9. Strip remaining tags.
  out = out.replace(/<[^>]+>/g, "");

  // 10. Decode entities (catches anything that survived above).
  out = decodeEntities(out);

  // 11. Collapse whitespace.
  out = out
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^ +| +$/gm, "")
    .trim();

  return out;
}

export function truncateBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  // UTF-8 safe truncation: back up past continuation bytes (bytes with
  // top 2 bits == 10xxxxxx) so we never land mid-codepoint. Without
  // this, Buffer.toString("utf8") emits U+FFFD at the boundary.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  const cut = buf.subarray(0, end).toString("utf8");
  return {
    text: cut + `\n\n[…truncated to ${maxBytes} bytes; total was ${buf.byteLength} bytes]`,
    truncated: true,
  };
}
