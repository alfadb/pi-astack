import * as os from "node:os";

export interface SanitizeResult {
  ok: boolean;
  text?: string;
  error?: string;
  replacements: string[];
}

// Patterns are checked in order. The list deliberately mixes hard
// vendor formats (sk-..., AKIA..., gh*_, eyJ.eyJ.<sig>) with shape-based
// heuristics (PEM blocks, secret-looking assignments, scheme://creds).
//
// Credential matches are REDACTED, not used to abort the whole sediment
// run. The security invariant is "raw secret never crosses the LLM/audit/
// memory boundary"; the product invariant is "useful surrounding context
// can still be sedimented with typed placeholders". If a pattern cannot be
// safely localized after Unicode normalization, we conservatively redact the
// containing line.
//
// ADR 0016 retained sensitive-info as the one justified mechanical safety
// boundary. The boundary now blocks plaintext, not knowledge extraction.
type CredentialPattern = {
  name: string;
  re: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
};

function secretPlaceholder(name: string): string {
  return `[SECRET:${name}]`;
}

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  {
    name: "pem_private_key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  { name: "anthropic_api_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai_api_key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "jwt_token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Header-only fallback for malformed/truncated PEM snippets.
  { name: "pem_private_key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Any RFC-ish scheme with embedded user:pass@ credentials, including
  // empty username forms such as redis://:password@host. This catches
  // neo4j+s://, clickhouse://, mssql://, ftp://, sqlalchemy+driver://...
  // without redacting harmless localhost DSNs like redis://localhost:6379.
  { name: "connection_url", re: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>/:@]*:[^\s"'<>@]+@[^\s"'<>]+/gi },
  // Round 8 P1 (opus R8 audit): vendor-format tokens missing from R7:
  //   - Bearer <token>: Authorization header form — widely pasted from
  //     curl debug output / browser devtools
  //   - xoxa/xoxb/xoxp/xoxr-... Slack tokens
  //   - AIza... Google API keys (35 chars, dash + underscore allowed)
  //   - sk_live_ / sk_test_ / pk_live_ / rk_live_... Stripe keys (underscore)
  { name: "bearer_token", re: /\bBearer\s+([A-Za-z0-9._\-/+=]{20,})\b/g, replace: () => `Bearer ${secretPlaceholder("bearer_token")}` },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe_key", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  // Generic assignment runs after vendor-format tokens so KEY=<vendor-token>
  // keeps the more specific placeholder (e.g. STRIPE_SECRET_KEY=[SECRET:stripe_key]).
  // Keyword set includes common aliases that were silently bypassing the gate:
  //   - passwd / passphrase  — widely used in Linux/SSH contexts
  //   - access[_-]?key       — AWS / GCP / Azure naming
  //   - private[_-]?key      — "PRIVATE_KEY=..." assignment form
  //   - client[_-]?secret    — OAuth 2 / OIDC
  //   - bearer (Authorization header alias)
  {
    name: "generic_secret_assignment",
    re: /(?<!\[)\b(api[_-]?key|token|secret|password|passwd|passphrase|access[_-]?key|private[_-]?key|client[_-]?secret|bearer)(\s*[:=]\s*['"]?)[A-Za-z0-9_./+\-=!@#$%^&*?:~]{16,}/gi,
    replace: (_match, key, sep) => `${key}${sep}${secretPlaceholder("generic_secret_assignment")}`,
  },
  // Conservative short-value catch: only strong credential keywords, value
  // length 8-15, and the value must look secret-like (letter plus digit or
  // punctuation). This avoids redacting benign states like "password: required".
  {
    name: "short_secret_assignment",
    re: /(?<!\[)\b(password|passwd|passphrase|client[_-]?secret|private[_-]?key)(\s*[:=]\s*['"]?)(?=[A-Za-z0-9_./+\-=!@#$%^&*?:~]{8,15}(?=$|[\s"'<>]))(?=[A-Za-z0-9_./+\-=!@#$%^&*?:~]*[A-Za-z])(?=[A-Za-z0-9_./+\-=!@#$%^&*?:~]*(?:\d|[.\/+\-=!@#$%^&*?:~]))[A-Za-z0-9_./+\-=!@#$%^&*?:~]{8,15}/gi,
    replace: (_match, key, sep) => `${key}${sep}${secretPlaceholder("short_secret_assignment")}`,
  },
];

// Round 8 P1 (opus R8 audit): Unicode bypass shapes — zero-width spaces
// and bidi/RTL overrides between e.g. `pass` and `word` defeat the
// `\b` boundary and keyword tokenization. Strip these before matching.
// ADR 0027 C6: after NFKC, fold only a minimal credential-keyword
// homoglyph set in the scan buffer, leaving non-redacted source text intact.
const INVISIBLE_BYPASS_CHARS = /[\u200B-\u200D\u2060\u202A-\u202E\u00AD\uFEFF]/g;
const CREDENTIAL_KEYWORD_CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0455": "s", "\u043a": "k",
  "\u03b1": "a", "\u03b5": "e", "\u03bf": "o", "\u03c1": "p", "\u03c7": "x", "\u03c5": "y", "\u03ba": "k",
};
const CREDENTIAL_KEYWORD_CONFUSABLE_RE = /[\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0456\u0455\u043a\u03b1\u03b5\u03bf\u03c1\u03c7\u03c5\u03ba]/g;
const PEM_END_LINE_RE = /-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/;
const PEM_BODY_LINE_RE = /^(?:[A-Za-z0-9+/=]{8,}|Proc-Type:.*|DEK-Info:.*|Version:.*)$/;

function foldCredentialKeywordConfusables(input: string): string {
  return input.replace(CREDENTIAL_KEYWORD_CONFUSABLE_RE, (ch) => CREDENTIAL_KEYWORD_CONFUSABLES[ch] ?? ch);
}

function addReplacement(replacements: string[], name: string): void {
  if (!replacements.includes(name)) replacements.push(name);
}

function redactCredentialPatterns(input: string, replacements: string[]): string {
  let text = input;

  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.re.lastIndex = 0;
    let matched = false;
    text = text.replace(pattern.re, (...args: unknown[]) => {
      matched = true;
      const match = String(args[0] ?? "");
      const maybeNamedGroups = args[args.length - 1];
      const hasNamedGroups = typeof maybeNamedGroups === "object" && maybeNamedGroups !== null;
      const captureEnd = args.length - (hasNamedGroups ? 3 : 2);
      const groups = args.slice(1, captureEnd).map((group) => typeof group === "string" ? group : "");
      return pattern.replace
        ? pattern.replace(match, ...groups)
        : secretPlaceholder(pattern.name);
    });
    pattern.re.lastIndex = 0;
    if (matched) addReplacement(replacements, `credential:${pattern.name}`);
  }

  // Round 8 P1 (opus R8 audit): pre-normalize for regex scanning so
  // zero-width / bidi-control bypass forms don't dodge keyword matching.
  // Replacement offsets in the normalized buffer are not reliable, so any
  // remaining normalized-only hit redacts the containing line. This keeps
  // the rest of a transcript window usable while preventing raw leakage.
  const lines = text.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "\n" || line === "\r\n") continue;
    const scanLine = foldCredentialKeywordConfusables(line.normalize("NFKC").replace(INVISIBLE_BYPASS_CHARS, ""));
    for (const pattern of CREDENTIAL_PATTERNS) {
      pattern.re.lastIndex = 0;
      const hit = pattern.re.test(scanLine);
      pattern.re.lastIndex = 0;
      if (hit) {
        lines[i] = secretPlaceholder(pattern.name);
        if (pattern.name === "pem_private_key") {
          for (let j = i + 1; j < lines.length; j += 1) {
            const nextLine = lines[j];
            if (nextLine === "\n" || nextLine === "\r\n") continue;
            const scanNextLine = foldCredentialKeywordConfusables(nextLine.normalize("NFKC").replace(INVISIBLE_BYPASS_CHARS, "")).trim();
            if (!scanNextLine) break;
            if (PEM_END_LINE_RE.test(scanNextLine) || PEM_BODY_LINE_RE.test(scanNextLine)) {
              lines[j] = secretPlaceholder(pattern.name);
              if (PEM_END_LINE_RE.test(scanNextLine)) break;
              continue;
            }
            break;
          }
          addReplacement(replacements, `credential:${pattern.name}:block`);
        }
        addReplacement(replacements, `credential:${pattern.name}:line`);
        break;
      }
    }
  }

  return lines.join("");
}

export function sanitizeForMemory(input: string): SanitizeResult {
  const replacements: string[] = [];
  let text = redactCredentialPatterns(input, replacements);

  const home = os.homedir();
  if (home && text.includes(home)) {
    text = text.split(home).join("$HOME");
    replacements.push("home_path");
  }

  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  ipRe.lastIndex = 0;
  if (ipRe.test(text)) {
    ipRe.lastIndex = 0;
    text = text.replace(ipRe, "[HOST]");
    replacements.push("ip_address");
  }

  const emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  emailRe.lastIndex = 0;
  if (emailRe.test(text)) {
    emailRe.lastIndex = 0;
    text = text.replace(emailRe, "[EMAIL]");
    replacements.push("email");
  }

  return { ok: true, text, replacements };
}
