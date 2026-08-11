#!/usr/bin/env node
/**
 * Smoke test for pi-astack web-search extension.
 *
 * Covers (ADR 0027 PR-A lineage + web-search vertical increment):
 *   - file structure (types/registry/settings + brave-search/serper
 *     search backends + brave-fetch + shadow + html-to-markdown +
 *     url-guard SSRF defense)
 *   - dispatch default tools include web_search/web_fetch (4 sites, no orphan)
 *   - dispatch uses target-session registry validation instead of a static
 *     tool-name allowlist
 *   - source-string-level invariants (sub-pi guard, missing-key error,
 *     signal pass-through, untrusted-content framing, SSRF guard wired,
 *     content-type whitelist, streamed body)
 *   - Brave fetch security regression (runtime, mock fetch): SSRF refusal,
 *     non-text content-type refusal, markdown extraction, byte-cap truncation
 *   - Serper backend (runtime, mock global fetch): POST endpoint + X-API-KEY,
 *     count→num / country→gl / freshness→tbs mapping, organic→SearchResult
 *     mapping, HTTP error truncation + no key leak, date-range fail-closed
 *   - shadow A/B: default off, deterministic call-event sampling (query +
 *     tool-call id), tool-level failure-does-not-affect-main, log row
 *     shape, no raw query / key / snippet in log, keyless checksum digests
 *     with algorithm recorded, logUrls=false → URL checksum digests
 *     digests + hostname domains (paths/queries never logged), logUrls=true
 *     → strictly normalized URLs (userinfo/fragment/all query params
 *     stripped), normalized errorKind (no raw provider error text),
 *     effectiveTopK + overlap=null on shadow error, default log path
 *     auto-gitignored in real git repos, caller abort after main success
 *     does not kill the shadow, bounded backend timeout
 *   - settings + provider factory: defaults, legacy Brave migration,
 *     Brave/Serper credential isolation, shadow config, relative
 *     logPath fail-closed, unknown provider, shadow==main warning
 *   - settings mtime hot reload (same path, brave→serper) + secret
 *     command cache cleared on reload; web_fetch survives a search-
 *     provider typo (fetch is independent of search config)
 *   - real url-guard / html-to-markdown module behavior (imported, not
 *     script copies): loopback / metadata / CGNAT / IPv6 ULA / multicast
 *     offline IP literals, truncateBytes / extractTitle / htmlToMarkdown
 *   - report-web-search-shadow.mjs aggregation over a temp JSONL
 *
 * Fully offline-deterministic: all HTTP is a mock global fetch; DNS is
 * avoided (SSRF test uses an IP literal; fetch tests run with
 * allowPrivateNetworks=true). Mock-fetch verification covers parsing and
 * error paths — it is NOT a substitute for real Serper API acceptance
 * (requires a live SERPER_API_KEY; see "not yet accepted" note at bottom).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function failMsg(msg) { fail++; console.log(`  ✗ ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else failMsg(msg); }

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// 1. File structure ─────────────────────────────────────────────

console.log("\n  file structure:");
const expectedFiles = [
  "extensions/web-search/index.ts",
  "extensions/web-search/types.ts",
  "extensions/web-search/registry.ts",
  "extensions/web-search/settings.ts",
  "extensions/web-search/shadow.ts",
  "extensions/web-search/providers/brave-search.ts",
  "extensions/web-search/providers/brave-fetch.ts",
  "extensions/web-search/providers/serper.ts",
  "extensions/web-search/utils/html-to-markdown.ts",
  "extensions/web-search/utils/url-guard.ts",
  "extensions/web-search/utils/secret.ts",
  "scripts/report-web-search-shadow.mjs",
];
for (const f of expectedFiles) {
  if (fs.existsSync(path.join(repoRoot, f))) ok(f);
  else failMsg(`missing: ${f}`);
}

// 2. dispatch default tools + dynamic registry validation ───────

console.log("\n  dispatch/index.ts patches (ADR 0027 PR-A):");
const dispatchSrc = read("extensions/dispatch/index.ts");

if (!/const KNOWN_TOOLS\b/.test(dispatchSrc) && /validateSessionToolRegistry\(session, tools\)/.test(dispatchSrc)) {
  ok("dispatch resolves web tools through the target session registry (no static allowlist)");
} else failMsg("dispatch still depends on a static tool allowlist or lacks target registry validation");

const allowlistSites = dispatchSrc.match(/read,grep,find,ls/g) || [];
const patchedSites = dispatchSrc.match(/read,grep,find,ls,web_search,web_fetch/g) || [];
if (allowlistSites.length === patchedSites.length && patchedSites.length >= 4) {
  ok(`default allowlist patched in ${patchedSites.length} sites (no orphan)`);
} else {
  failMsg(`patched ${patchedSites.length} sites but ${allowlistSites.length} total occurrences — orphan(s) remain`);
}

if (/Sub-agents default to read,grep,find,ls,web_search,web_fetch \+ memory read\./.test(dispatchSrc)) {
  ok("promptGuidelines text updated for sub-agent capabilities");
} else failMsg("promptGuidelines text NOT updated");

// 3. types.ts contract ──────────────────────────────────────────

console.log("\n  types.ts contract (search/fetch split):");
const typesSrc = read("extensions/web-search/types.ts");
for (const sym of ["SearchBackend", "FetchBackend", "WebSearchProvider", "SearchOpts", "SearchResult", "FetchOpts", "FetchResult"]) {
  if (new RegExp(`export interface ${sym}\\b`).test(typesSrc)) ok(`exports ${sym}`);
  else failMsg(`missing export: ${sym}`);
}
const searchBackendBody = typesSrc.match(/interface SearchBackend \{([\s\S]*?)\n\}/)?.[1] ?? "";
if (searchBackendBody.includes("search(query: string") && !searchBackendBody.includes("fetch(")) {
  ok("SearchBackend is search-only (fetch split out)");
} else failMsg("SearchBackend still bundles fetch");
if (/interface FetchBackend\b[\s\S]*?fetch\(url: string/.test(typesSrc)) {
  ok("FetchBackend owns fetch");
} else failMsg("FetchBackend missing fetch");
if (/interface WebSearchProvider extends SearchBackend, FetchBackend/.test(typesSrc)) {
  ok("WebSearchProvider kept as backward-compatible alias");
} else failMsg("WebSearchProvider compat alias missing");
if (/signal\?:\s*AbortSignal/.test(typesSrc)) ok("signal?: AbortSignal added to opts");
else failMsg("types.ts missing signal? field");

// 4. brave-search invariants ────────────────────────────────────

console.log("\n  providers/brave-search.ts:");
const braveSearchSrc = read("extensions/web-search/providers/brave-search.ts");

if (/class BraveSearchBackend implements SearchBackend/.test(braveSearchSrc)) {
  ok("BraveSearchBackend implements SearchBackend");
} else failMsg("BraveSearchBackend does not implement SearchBackend");

if (/api\.search\.brave\.com\/res\/v1\/web\/search/.test(braveSearchSrc)) {
  ok("uses Brave REST endpoint directly (not shelling out)");
} else failMsg("Brave REST endpoint not found");

if (/X-Subscription-Token/.test(braveSearchSrc)) {
  ok("sends X-Subscription-Token header (Brave auth)");
} else failMsg("missing X-Subscription-Token header");

if (/this\.opts\.apiKeyEnv/.test(braveSearchSrc) && /process\.env\[/.test(braveSearchSrc)) {
  ok("API key read from configurable env var (not hardcoded BRAVE_API_KEY)");
} else failMsg("API key handling does NOT use settings apiKeyEnv");

if (/api-dashboard\.search\.brave\.com/.test(braveSearchSrc) && /webSearch\.brave\.apiKey/.test(braveSearchSrc)) {
  ok("missing-key error message points to webSearch.brave.apiKey + Brave dashboard");
} else failMsg("missing-key error message not helpful");

if (/combineSignals/.test(braveSearchSrc) && /opts\?\.signal/.test(braveSearchSrc)) {
  ok("caller signal combined with timeout (combineSignals used)");
} else failMsg("caller signal NOT combined — cancel won't propagate");

if (/Math\.floor\(opts\?\.count/.test(braveSearchSrc)) {
  ok("count is Math.floor()'d before clamping (no fractional to Brave)");
} else failMsg("count NOT integer-rounded — 5.7 would pass through");

if (/resolved empty/.test(braveSearchSrc) && !/\$\{this\.opts\.apiKey\}/.test(braveSearchSrc)) {
  ok("empty-resolved apiKey error never echoes the configured value");
} else failMsg("empty-resolved apiKey error still echoes the config string");

// Behavior: a configured apiKey that resolves empty (missing env var) must
// throw an error that names the FIELD but never the raw config value.
{
  const braveMod = await jiti.import(path.join(repoRoot, "extensions/web-search/providers/brave-search.ts"));
  const rawConfig = "$PI_ASTACK_BRAVE_MISSING_ENV_XYZ";
  const bk = new braveMod.BraveSearchBackend({ apiKey: rawConfig, apiKeyEnv: "BRAVE_API_KEY", defaultCount: 5, timeoutMs: 15_000 });
  try {
    await bk.search("probe");
    failMsg("brave: empty-resolved apiKey did NOT throw");
  } catch (e) {
    const m = e.message;
    assert(/webSearch\.brave\.apiKey/.test(m) && /resolved empty/.test(m), "brave: error names the field + 'resolved empty'");
    assert(!m.includes(rawConfig), "brave: raw apiKey config string NOT echoed in error");
  }
}

// 5. brave-fetch invariants ─────────────────────────────────────

console.log("\n  providers/brave-fetch.ts (fetch security regression):");
const braveFetchSrc = read("extensions/web-search/providers/brave-fetch.ts");

if (/class BraveFetchBackend implements FetchBackend/.test(braveFetchSrc)) {
  ok("BraveFetchBackend implements FetchBackend");
} else failMsg("BraveFetchBackend does not implement FetchBackend");

if (/safeFetch\(/.test(braveFetchSrc) && /allowPrivateNetworks/.test(braveFetchSrc)) {
  ok("web_fetch routes through safeFetch with allowPrivateNetworks plumbed");
} else failMsg("web_fetch does NOT route through safeFetch — SSRF defense missing");

if (/response\.body\?\.getReader/.test(braveFetchSrc) && /TextDecoder/.test(braveFetchSrc)) {
  ok("fetch uses streamed body reader with TextDecoder");
} else failMsg("fetch still uses unbounded response.text() — memory pressure risk");

if (/isTextLikeContentType/.test(braveFetchSrc)) {
  ok("content-type whitelist (isTextLikeContentType) present");
} else failMsg("no content-type whitelist — binary content would be mojibake");

if (/ABSOLUTE_MAX_RAW_BYTES/.test(braveFetchSrc)) {
  ok("ABSOLUTE_MAX_RAW_BYTES hard cap present");
} else failMsg("missing absolute hard cap on raw read bytes");

// Runtime fetch behavior (mock global fetch; allowPrivateNetworks=true
// bypasses the DNS guard so tests stay offline-deterministic).
{
  const fetchMod = await jiti.import(path.join(repoRoot, "extensions/web-search/providers/brave-fetch.ts"));
  const oldFetch = globalThis.fetch;
  try {
    const fb = new fetchMod.BraveFetchBackend({ timeoutMs: 5_000, allowPrivateNetworks: true });

    globalThis.fetch = async () => new Response(
      "<html><head><title>Page Title</title></head><body><h1>Hello</h1><p>World text</p></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );
    const r = await fb.fetch("https://example.test/page", { maxBytes: 50_000 });
    assert(r.title === "Page Title", "fetch extracts <title>");
    assert(typeof r.content === "string" && r.content.includes("Hello"), "fetch converts HTML→markdown");
    assert(r.contentType === "text/html", "fetch reports content-type");

    globalThis.fetch = async () => new Response(
      "PDFDATA", { status: 200, headers: { "content-type": "application/pdf" } },
    );
    try {
      await fb.fetch("https://example.test/doc.pdf", { maxBytes: 50_000 });
      failMsg("non-text content-type NOT refused");
    } catch (e) {
      assert(/non-text content-type/.test(e.message), "non-text content-type refused");
    }

    globalThis.fetch = async () => new Response(
      "<html><body>" + "x".repeat(2_000) + "</body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );
    const r3 = await fb.fetch("https://example.test/big", { maxBytes: 100 });
    assert(r3.truncated === true && r3.content.length < 2_000, "maxBytes truncation applied");

    // SSRF: private IP literal is refused BEFORE any HTTP call; the DNS
    // check on an IP literal is local (no network) — stays offline.
    const fbStrict = new fetchMod.BraveFetchBackend({ timeoutMs: 5_000, allowPrivateNetworks: false });
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return new Response("x", { status: 200 }); };
    try {
      await fbStrict.fetch("http://127.0.0.1:8080/secret", { maxBytes: 1_000 });
      failMsg("SSRF: private IP fetch NOT refused");
    } catch (e) {
      assert(/web_fetch refused/.test(e.message) && !fetchCalled, "SSRF: private IP refused before HTTP (web_fetch refused)");
    }
  } catch (e) {
    failMsg(`fetch runtime regression threw: ${e.stack || e.message}`);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// 6. serper backend ─────────────────────────────────────────────

console.log("\n  providers/serper.ts:");
const serperSrc = read("extensions/web-search/providers/serper.ts");
for (const literal of [
  /google\.serper\.dev\/search/,
  /X-API-KEY/,
  /mapSerperFreshness/,
  /FRESHNESS_TBS/,
]) {
  if (literal.test(serperSrc)) ok(`source invariant: ${literal}`);
  else failMsg(`missing source invariant: ${literal}`);
}
assert(/qdr:d/.test(serperSrc) && /qdr:w/.test(serperSrc) && /qdr:m/.test(serperSrc) && /qdr:y/.test(serperSrc),
  "freshness map: pd/pw/pm/py → qdr:d/w/m/y");

{
  const serperMod = await jiti.import(path.join(repoRoot, "extensions/web-search/providers/serper.ts"));
  const mkBackend = (key = "serper-test-key") => new serperMod.SerperSearchBackend({
    apiKey: key, apiKeyEnv: "SERPER_API_KEY", defaultCount: 5, timeoutMs: 15_000,
  });

  // Freshness mapping (pure function).
  assert(serperMod.mapSerperFreshness("pd") === "qdr:d", "mapSerperFreshness pd → qdr:d");
  assert(serperMod.mapSerperFreshness("pw") === "qdr:w", "mapSerperFreshness pw → qdr:w");
  assert(serperMod.mapSerperFreshness("pm") === "qdr:m", "mapSerperFreshness pm → qdr:m");
  assert(serperMod.mapSerperFreshness("py") === "qdr:y", "mapSerperFreshness py → qdr:y");
  try {
    serperMod.mapSerperFreshness("2024-01-01to2024-02-01");
    failMsg("explicit date range NOT rejected (fail-closed violated)");
  } catch (e) {
    assert(/not supported/.test(e.message), "explicit date range fails closed with clear error");
  }
  try {
    serperMod.mapSerperFreshness("nonsense");
    failMsg("unknown freshness NOT rejected");
  } catch (e) {
    assert(/unknown freshness/.test(e.message), "unknown freshness rejected with clear error");
  }

  const oldFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        organic: [
          { title: "Result One", link: "https://one.example/a?utm_source=x", snippet: "snippet one", date: "2 days ago" },
          { title: "Result Two", link: "https://two.example/b", snippet: "snippet two" },
          { title: "Result Three", link: "https://three.example/c", snippet: "snippet three", date: "2024-01-15" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const results = await mkBackend().search("serper query", { count: 2, country: "de", freshness: "pw" });
    assert(calls.length === 1, "serper: exactly one HTTP call");
    assert(calls[0].url === "https://google.serper.dev/search", "serper: POSTs to google.serper.dev/search");
    assert(calls[0].init.method === "POST", "serper: uses POST");
    assert(calls[0].init.headers["X-API-KEY"] === "serper-test-key", "serper: sends X-API-KEY header");
    assert(calls[0].init.headers["Content-Type"] === "application/json", "serper: sends Content-Type: application/json");
    const body = JSON.parse(calls[0].init.body);
    assert(body.q === "serper query", "serper: body.q is the query");
    assert(body.num === 2, "serper: count → num (2)");
    assert(body.gl === "de", "serper: country → gl (lowercased, Google geolocation convention)");
    assert(body.tbs === "qdr:w", "serper: freshness pw → tbs qdr:w");
    assert(results.length === 2, "serper: response truncated to requested count (2)");
    assert(results[0].title === "Result One" && results[0].url === "https://one.example/a?utm_source=x" && results[0].snippet === "snippet one" && results[0].age === "2 days ago",
      "serper: organic title/link/snippet/date → title/url/snippet/age");
    assert(results[1].age === undefined, "serper: missing date → no age field");

    // count clamp (fractional + out-of-range) and default.
    calls.length = 0;
    await mkBackend().search("q2", { count: 7.7 });
    assert(JSON.parse(calls[0].init.body).num === 7, "serper: fractional count floored (7.7 → 7)");
    calls.length = 0;
    await mkBackend().search("q3", { count: 99 });
    assert(JSON.parse(calls[0].init.body).num === 20, "serper: count clamped to 20");
    calls.length = 0;
    await mkBackend().search("q4", { count: 0 });
    assert(JSON.parse(calls[0].init.body).num === 1, "serper: count clamped to 1");
    calls.length = 0;
    await mkBackend().search("q5");
    assert(JSON.parse(calls[0].init.body).num === 5, "serper: defaultCount 5 used when count omitted");

    // HTTP error: truncated body, never the key.
    globalThis.fetch = async () => new Response("rate limited: <secret>", { status: 429 });
    try {
      await mkBackend().search("q6");
      failMsg("serper: HTTP 429 NOT surfaced as error");
    } catch (e) {
      const m = e.message;
      assert(/Serper API HTTP 429/.test(m), "serper: HTTP status surfaced");
      assert(m.includes("<secret>"), "serper: error body truncated but included");
      assert(!m.includes("serper-test-key"), "serper: API key NEVER leaks into error");
    }

    // Empty-resolved configured apiKey: names the field, never the config
    // string (which may be a secret literal or reveal the secrets path).
    const rawSerperConfig = "$PI_ASTACK_SERPER_MISSING_ENV_XYZ";
    try {
      await mkBackend(rawSerperConfig).search("q7");
      failMsg("serper: empty-resolved apiKey did NOT throw");
    } catch (e) {
      const m = e.message;
      assert(/webSearch\.serper\.apiKey/.test(m) && /resolved empty/.test(m), "serper: error names the field + 'resolved empty'");
      assert(!m.includes(rawSerperConfig), "serper: raw apiKey config string NOT echoed in error");
    }
  } catch (e) {
    failMsg(`serper runtime threw: ${e.stack || e.message}`);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// 7. shadow A/B ─────────────────────────────────────────────────

console.log("\n  shadow.ts (A/B telemetry):");
const shadowMod = await jiti.import(path.join(repoRoot, "extensions/web-search/shadow.ts"));
const shadowSrc = read("extensions/web-search/shadow.ts");
for (const literal of [
  /MAX_CONCURRENT_SHADOW_RUNS\s*=\s*2/,
  /activeShadowRuns\s*>=\s*MAX_CONCURRENT_SHADOW_RUNS/,
  /classifyShadowError/,
  /errorKind/,
  /extractDomain/,
  /primaryDomains/,
]) {
  if (literal.test(shadowSrc)) ok(`shadow.ts source invariant: ${literal}`);
  else failMsg(`shadow.ts missing: ${literal}`);
}

// Deterministic call-event sampling (query + tool-call id).
assert(shadowMod.shouldSampleShadow("any query", "call-1", 0) === false, "sampleRate 0 → never samples");
assert(shadowMod.shouldSampleShadow("any query", "call-1", 1) === true, "sampleRate 1 → always samples");
{
  const f = shadowMod.sampleFraction("some query", "call-1");
  assert(Number.isFinite(f) && f >= 0 && f < 1, "sampleFraction ∈ [0,1)");
  const a = shadowMod.shouldSampleShadow("some query", "call-1", 0.5);
  const b = shadowMod.shouldSampleShadow("some query", "call-1", 0.5);
  assert(a === b, "same query + same call id + same rate → same decision (reproducible event)");
  // Different call ids for the same query can land in different buckets.
  const q = "call-id-bucket-probe";
  let idA = null; let idB = null;
  for (let i = 0; i < 200 && (idA === null || idB === null); i++) {
    const candidate = `call-${i}`;
    if (shadowMod.shouldSampleShadow(q, candidate, 0.5)) { if (idA === null) idA = candidate; }
    else { if (idB === null) idB = candidate; }
  }
  assert(idA !== null && idB !== null, "repeated query + different call ids → different buckets possible");
  // Find queries on both sides of a 0.5 rate to prove the gate discriminates.
  let inSample = null; let outSample = null;
  for (let i = 0; i < 200 && (!inSample || !outSample); i++) {
    const p = `determinism-probe-${i}`;
    if (shadowMod.shouldSampleShadow(p, "probe-call", 0.5)) inSample = inSample ?? p;
    else outSample = outSample ?? p;
  }
  assert(inSample !== null && outSample !== null, "sampling discriminates (found sampled + non-sampled probes at 0.5)");
}

// Keyless checksum correlation values (plain SHA-256, domain-framed): the
// log records algorithm/digest and never claims irreversibility.
{
  const h = shadowMod.checksumHex("web-search-query", "secret query");
  assert(h.algorithm === "sha256" && /^[0-9a-f]{64}$/.test(h.digest),
    "checksumHex → algorithm + 64-hex digest");
  const h2 = shadowMod.checksumHex("web-search-query", "secret query");
  assert(h.digest === h2.digest, "checksumHex deterministic for same domain+value");
  const h3 = shadowMod.checksumHex("web-search-query", "other query");
  assert(h.digest !== h3.digest, "checksumHex differs across values");
  const h4 = shadowMod.checksumHex("web-search-url", "secret query");
  assert(h.digest !== h4.digest, "checksumHex differs across domains (domain framing)");
  assert(!Object.hasOwn(h, "key_id"), "keyless checksum must not carry a key_id");
}

// URL normalization: overlap form keeps non-utm query params; log form
// strips userinfo / fragment / ALL query params (token avoidance).
assert(shadowMod.normalizeUrl("https://Example.COM:443/path/?utm_source=x&page=2#frag") === "https://example.com/path?page=2",
  "normalizeUrl lowercases host, drops default port, utm_* and fragment (keeps other params)");
assert(shadowMod.normalizeUrlForLog("https://user:pass@Example.COM:443/path/?utm_source=x&q=secret-token#frag") === "https://example.com/path",
  "normalizeUrlForLog strips userinfo, fragment, default port and ALL query params");
assert(shadowMod.normalizeUrlForLog("https://a.example/1?p=1") === shadowMod.normalizeUrlForLog("https://a.example/1?p=2"),
  "normalizeUrlForLog: different query params → same normalized URL");
assert(shadowMod.normalizeUrlForLog("not-a-url") === "not-a-url", "normalizeUrlForLog: unparseable URL passes through");
assert(shadowMod.topKOverlap(
  ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
  ["https://b.example/2/", "https://x.example/9", "https://a.example/1?utm_campaign=y"],
  10) === 2, "topKOverlap counts shared normalized URLs");

// Tool-level: shadow failure must not affect the main response; log
// row shape + privacy.
{
  const oldFetch = globalThis.fetch;
  const oldEnv = process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH;
  const oldDisabled = process.env.PI_ABRAIN_DISABLED;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-web-search-shadow-"));
  try {
    delete process.env.PI_ABRAIN_DISABLED;
    const indexMod = await jiti.import(path.join(repoRoot, "extensions/web-search/index.ts"));
    const activate = indexMod.default;
    const tools = {};
    activate({ registerTool(def) { tools[def.name] = def; } });
    assert(!!tools.web_search && !!tools.web_fetch, "extension registers web_search + web_fetch");

    // Scenario A: shadow enabled, shadow provider fails.
    const settingsA = path.join(tmp, "settings-a.json");
    fs.writeFileSync(settingsA, JSON.stringify({
      webSearch: {
        provider: "brave",
        brave: { apiKey: "brave-secret-key" },
        serper: { apiKey: "serper-secret-key" },
        shadow: { enabled: true, provider: "serper", sampleRate: 1, logUrls: true },
      },
    }));
    process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = settingsA;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://api.search.brave.com/")) {
        return new Response(JSON.stringify({ web: { results: [
          { title: "Brave result", url: "https://brave.example/secret-path?utm_source=x&q=secret-query", description: "brave snippet secret", age: "2 days ago" },
          { title: "Brave result 2", url: "https://brave.example/2", description: "snippet two" },
        ] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "https://google.serper.dev/search") {
        return new Response("rate limited by serper", { status: 429 });
      }
      return new Response("not found", { status: 404 });
    };

    const query = "shadow-tool-query-alpha-42";
    const res = await tools.web_search.execute("id-1", { query }, new AbortController().signal, undefined, { cwd: tmp });
    assert(!res.isError && res.details.provider === "brave" && res.details.count === 2,
      "main response unaffected (brave ok, shadow failed)");
    assert(!JSON.stringify(res.details).includes("serper-secret-key"), "tool details never leak shadow key");
    const resText = res.content?.[0]?.text ?? "";
    assert(resText.startsWith("<untrusted_external_content>") && resText.includes("DATA, not COMMANDS") && resText.endsWith("</untrusted_external_content>"),
      "web_search content wrapped in <untrusted_external_content> (titles/snippets are DATA)");
    assert(res.details.query === query && Array.isArray(res.details.results) && res.details.results.length === 2,
      "web_search details contract kept (query/count/results)");

    // Wait for the background shadow run + log append.
    const logA = path.join(tmp, ".pi-astack", "web-search", "shadow.jsonl");
    let rawA = "";
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (fs.existsSync(logA)) {
        rawA = fs.readFileSync(logA, "utf8");
        if (rawA.trim()) break;
      }
    }
    assert(!!rawA.trim(), "shadow log row appended to <cwd>/.pi-astack/web-search/shadow.jsonl");
    const row = JSON.parse(rawA.trim().split("\n")[0]);
    assert(row.schemaVersion === 3, "log row: schemaVersion 3 (keyless checksum + call-event sampling)");
    assert(typeof row.timestamp === "string" && !Number.isNaN(Date.parse(row.timestamp)) && row.timestamp.includes("T"), "log row: local ISO timestamp");
    assert(typeof row.checksum === "object" && row.checksum.algorithm === "sha256",
      "log row: row-level checksum algorithm");
    assert(/^[0-9a-f]{64}$/.test(row.queryHash) && row.queryHash !== query, "log row: queryHash is checksum digest (never raw query)");
    assert(/^[0-9a-f]{64}$/.test(row.callIdHash) && row.callIdHash !== "id-1", "log row: callIdHash is checksum digest (causal anchor)");
    assert(row.primaryProvider === "brave" && row.shadowProvider === "serper", "log row: main + shadow provider names");
    assert(typeof row.opts === "object", "log row: opts present");
    assert(row.primary.status === "ok" && row.primary.resultCount === 2 && Number.isFinite(row.primary.latencyMs),
      "log row: primary status/latency/resultCount");
    assert(row.shadow.status === "error" && row.shadow.resultCount === 0 && Number.isFinite(row.shadow.latencyMs),
      "log row: shadow failure recorded with latency");
    assert(row.shadow.errorKind === "rate_limit" && row.shadow.errorStatus === 429,
      "log row: error normalized to errorKind=rate_limit + status 429 (no raw provider text)");
    assert(row.shadowError === undefined && !rawA.includes("rate limited by serper"),
      "log row: raw provider error text never logged");
    assert(row.overlap === null && row.effectiveTopK === null && row.topK === 10,
      "log row: overlap + effectiveTopK null on shadow error (topK still recorded)");
    assert(Array.isArray(row.primaryUrls) && row.primaryUrls.includes("https://brave.example/secret-path"),
      "log row: logUrls=true URLs strictly normalized (query params stripped)");
    assert(row.primaryUrls.every((u) => !u.includes("?") && !u.includes("#") && !u.includes("@")),
      "log row: normalized URLs carry no query/fragment/userinfo");
    assert(Array.isArray(row.shadowUrls) && row.shadowUrls.length === 0, "log row: shadow URLs (empty on error)");
    for (const forbidden of [query, "id-1", "brave-secret-key", "serper-secret-key", "brave snippet secret", "snippet two", "rate limited by serper", "secret-query", "utm_source"]) {
      if (rawA.includes(forbidden)) failMsg(`shadow log leaked forbidden value: ${forbidden}`);
      else ok(`shadow log does not contain: ${forbidden}`);
    }

    // Scenario B: logUrls=false → URL hashes instead of URLs.
    shadowMod.resetShadowState();
    indexMod.resetWebSearchProvider();
    const settingsB = path.join(tmp, "settings-b.json");
    fs.writeFileSync(settingsB, JSON.stringify({
      webSearch: {
        provider: "brave",
        brave: { apiKey: "brave-secret-key" },
        shadow: { enabled: true, provider: "serper", sampleRate: 1, logUrls: false },
      },
    }));
    process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = settingsB;
    await tools.web_search.execute("id-2", { query: "shadow-tool-query-beta", count: 3 }, new AbortController().signal, undefined, { cwd: tmp });
    const logB = path.join(tmp, ".pi-astack", "web-search", "shadow.jsonl");
    let rawB = "";
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (fs.existsSync(logB)) {
        rawB = fs.readFileSync(logB, "utf8");
        if (rawB.trim().split("\n").length >= 2) break;
      }
    }
    const rowB = JSON.parse(rawB.trim().split("\n").slice(-1)[0]);
    assert(Array.isArray(rowB.primaryUrlHashes) && rowB.primaryUrls === undefined,
      "logUrls=false → URL checksum digests, no URLs");
    assert(!JSON.stringify(rowB).includes("https://brave.example/"), "logUrls=false → raw URLs absent from row");
    // URL normalized BEFORE hashing; digest is a keyless checksum of the
    // normalized URL (domain-framed), not a keyed HMAC.
    const expectedHash = shadowMod.checksumHex("web-search-url", shadowMod.normalizeUrlForLog("https://brave.example/secret-path?utm_source=x&q=secret-query")).digest;
    assert(/^[0-9a-f]{64}$/.test(expectedHash), "logUrls=false → URL digest is 64-hex checksum");
    assert(rowB.primaryUrlHashes.includes(expectedHash), "logUrls=false → digest matches checksum(normalizeUrlForLog(url))");
    assert(rowB.checksum && rowB.checksum.algorithm === "sha256",
      "logUrls=false → row-level checksum algorithm consistent");
    assert(Array.isArray(rowB.primaryDomains) && rowB.primaryDomains.includes("brave.example"),
      "logUrls=false → hostname domains present (authority analysis)");
    const rawBJson = JSON.stringify(rowB);
    assert(!rawBJson.includes("secret-path") && !rawBJson.includes("secret-query") && !rawBJson.includes("utm_source"),
      "logUrls=false → URL paths/queries never logged");
    assert(!rawB.includes("shadow-tool-query-beta") && !rawB.includes("brave-secret-key"),
      "logUrls=false → raw query + key absent from log file");

    // Scenario C: normalized errorKind (no raw provider error text) +
    // bounded backend timeout. Direct runShadowSearch calls (deterministic,
    // no scheduling races).
    {
      shadowMod.resetShadowState();
      const settingsModC = await jiti.import(path.join(repoRoot, "extensions/web-search/settings.ts"));
      const registryModC = await jiti.import(path.join(repoRoot, "extensions/web-search/registry.ts"));
      const errQuery = "shadow-error-query-with-secret";
      const fakeKey = "shadow-error-fake-key";
      const fakeSnippet = "shadow-error-snippet-secret";
      const errBody = JSON.stringify({ error: `boom ${errQuery} ${fakeKey} ${fakeSnippet}` });
      const mockBackend = (impl) => ({ name: "mock-serper", search: impl });
      const base = {
        query: errQuery,
        callId: "shadow-err-call-1",
        opts: { count: 3 },
        primaryName: "brave",
        primaryResults: [{ title: "t", url: "https://primary.example/ok", snippet: "s" }],
        primaryLatencyMs: 12,
        projectRoot: tmp,
      };
      const runAndRead = async (shadow, logFile) => {
        await shadowMod.runShadowSearch({
          ...base,
          shadow,
          config: { provider: "serper", sampleRate: 1, logPath: path.join(tmp, logFile), logUrls: false },
        });
        return fs.readFileSync(path.join(tmp, logFile), "utf8");
      };

      // C1: 429 with a body that echoes query/key/snippet → rate_limit.
      let raw = await runAndRead(mockBackend(async () => {
        throw new Error(`Serper API HTTP 429 Too Many Requests — ${errBody}`);
      }), "shadow-err-429.jsonl");
      let row = JSON.parse(raw.trim());
      assert(row.shadow.status === "error" && row.shadow.errorKind === "rate_limit" && row.shadow.errorStatus === 429,
        "errorKind: HTTP 429 → rate_limit (status kept, text dropped)");
      assert(row.overlap === null && row.effectiveTopK === null && row.topK === 10,
        "error row: overlap + effectiveTopK null, topK recorded");
      assert(/^[0-9a-f]{64}$/.test(row.callIdHash), "error row: callIdHash present (checksum causal anchor)");
      for (const f of [errQuery, fakeKey, fakeSnippet, "boom", "Too Many Requests"]) {
        if (raw.includes(f)) failMsg(`shadow error log leaked error text: ${f}`);
        else ok(`shadow error log does not contain: ${f}`);
      }
      assert(row.shadowError === undefined, "shadow error row has no raw-error-text field");

      // C2: 500 → http_5xx; C3: 401 → auth; C4: unsupported input → unsupported.
      raw = await runAndRead(mockBackend(async () => { throw new Error("Serper API HTTP 500 Internal Server Error"); }), "shadow-err-500.jsonl");
      row = JSON.parse(raw.trim());
      assert(row.shadow.errorKind === "http_5xx" && row.shadow.errorStatus === 500, "errorKind: HTTP 500 → http_5xx");
      raw = await runAndRead(mockBackend(async () => { throw new Error("Brave Search API HTTP 401 Unauthorized"); }), "shadow-err-401.jsonl");
      row = JSON.parse(raw.trim());
      assert(row.shadow.errorKind === "auth" && row.shadow.errorStatus === 401, "errorKind: HTTP 401 → auth");
      raw = await runAndRead(mockBackend(async () => { throw new Error('web-search/serper: unknown freshness value "xy"'); }), "shadow-err-unsupported.jsonl");
      row = JSON.parse(raw.trim());
      assert(row.shadow.errorKind === "unsupported", "errorKind: unknown freshness → unsupported");
      raw = await runAndRead(mockBackend(async () => { throw new TypeError("fetch failed"); }), "shadow-err-other.jsonl");
      row = JSON.parse(raw.trim());
      assert(row.shadow.errorKind === "other", "errorKind: network TypeError → other");

      // C5: real Serper backend + a fetch that never resolves → backend
      // AbortSignal.timeout bounds the shadow (settings.timeout=1000).
      const settingsC = path.join(tmp, "settings-c.json");
      fs.writeFileSync(settingsC, JSON.stringify({
        webSearch: { provider: "brave", brave: { apiKey: "brave-secret-key" }, serper: { apiKey: "serper-secret-key" }, timeout: 1000 },
      }));
      process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = settingsC;
      const serperBackend = registryModC.createSearchBackend("serper", settingsModC.loadWebSearchSettings());
      const oldFetchC = globalThis.fetch;
      globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        // Never resolves; rejects with TimeoutError when the backend's own
        // AbortSignal.timeout fires (bounded, not unbounded). Keep the event
        // loop alive — Node's AbortSignal.timeout timer is unref'd, so a
        // promise alone would let the process exit before the timeout.
        const keepAlive = setInterval(() => {}, 500);
        init?.signal?.addEventListener("abort", () => {
          clearInterval(keepAlive);
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          reject(err);
        });
      });
      try {
        raw = await runAndRead(serperBackend, "shadow-err-timeout.jsonl");
        row = JSON.parse(raw.trim());
        assert(row.shadow.status === "error" && row.shadow.errorKind === "timeout",
          "shadow time-bounded: hung backend aborted by its own timeout (errorKind=timeout)");
      } finally {
        globalThis.fetch = oldFetchC;
      }
    }

    // Scenario D: caller abort AFTER main success must not kill the shadow
    // (shadow is signal-free by design; bounded by its own timeout).
    {
      shadowMod.resetShadowState();
      indexMod.resetWebSearchProvider();
      const settingsD = path.join(tmp, "settings-d.json");
      fs.writeFileSync(settingsD, JSON.stringify({
        webSearch: {
          provider: "brave",
          brave: { apiKey: "brave-secret-key" },
          serper: { apiKey: "serper-secret-key" },
          shadow: { enabled: true, provider: "serper", sampleRate: 1, logUrls: false },
        },
      }));
      process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = settingsD;
      const oldFetchD = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://api.search.brave.com/")) {
          return new Response(JSON.stringify({ web: { results: [
            { title: "Brave result", url: "https://brave.example/1", description: "brave snippet secret" },
          ] } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url) === "https://google.serper.dev/search") {
          // Shadow is slower than the main call — still in flight when the
          // caller aborts after the main result returned.
          await new Promise((r) => setTimeout(r, 250));
          return new Response(JSON.stringify({ organic: [
            { title: "Serper result", link: "https://serper.example/1", snippet: "serper snippet secret" },
          ] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      };
      try {
        const controller = new AbortController();
        const resD = await tools.web_search.execute("id-3", { query: "shadow-abort-query", count: 2 }, controller.signal, undefined, { cwd: tmp });
        assert(!resD.isError && resD.details.provider === "brave", "abort scenario: main still succeeds");
        controller.abort(); // caller aborts AFTER main returned
        const logD = path.join(tmp, ".pi-astack", "web-search", "shadow.jsonl");
        let rawD = "";
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 50));
          if (fs.existsSync(logD)) {
            rawD = fs.readFileSync(logD, "utf8");
            if (rawD.trim().split("\n").length >= 3) break;
          }
        }
        const rowD = JSON.parse(rawD.trim().split("\n").slice(-1)[0]);
        assert(rowD.shadow.status === "ok" && rowD.shadow.resultCount === 1,
          "shadow completes despite caller abort after main success (signal-free)");
        assert(Number.isInteger(rowD.overlap) && rowD.overlap >= 0 && rowD.overlap <= 10, "abort scenario: overlap integer when both ok");
        assert(Number.isInteger(rowD.effectiveTopK) && rowD.effectiveTopK === 1,
          "abort scenario: effectiveTopK = min(topK, primary count, shadow count) = 1");
        assert(!rawD.includes("shadow-abort-query") && !rawD.includes("serper-secret-key") && !rawD.includes("serper snippet secret"),
          "abort scenario: no query/key/snippet in log");
      } finally {
        globalThis.fetch = oldFetchD;
      }
    }

    // Scenario E: default log path under <projectRoot>/.pi-astack/ is
    // auto-gitignored (real git repo) — and a non-repo is never touched.
    {
      shadowMod.resetShadowState();
      indexMod.resetWebSearchProvider();
      const repo = path.join(tmp, "git-repo");
      fs.mkdirSync(repo, { recursive: true });
      let gitInit = false;
      try {
        execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
        gitInit = true;
      } catch {
        gitInit = false;
      }
      if (gitInit) {
        const settingsE = path.join(tmp, "settings-e.json");
        fs.writeFileSync(settingsE, JSON.stringify({
          webSearch: {
            provider: "brave",
            brave: { apiKey: "brave-secret-key" },
            serper: { apiKey: "serper-secret-key" },
            shadow: { enabled: true, provider: "serper", sampleRate: 1, logUrls: false },
          },
        }));
        process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = settingsE;
        const oldFetchE = globalThis.fetch;
        globalThis.fetch = async (url) => {
          if (String(url).startsWith("https://api.search.brave.com/")) {
            return new Response(JSON.stringify({ web: { results: [
              { title: "Brave result", url: "https://brave.example/1", description: "s" },
              { title: "Brave result 2", url: "https://brave.example/2", description: "s2" },
            ] } }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (String(url) === "https://google.serper.dev/search") {
            return new Response(JSON.stringify({ organic: [
              { title: "Serper result", link: "https://serper.example/1", snippet: "s" },
            ] }), { status: 200, headers: { "content-type": "application/json" } });
          }
          return new Response("not found", { status: 404 });
        };
        try {
          await tools.web_search.execute("id-e1", { query: "gitignore-repo-query" }, new AbortController().signal, undefined, { cwd: repo });
          const logE = path.join(repo, ".pi-astack", "web-search", "shadow.jsonl");
          let gitignoreTxt = "";
          for (let i = 0; i < 100; i++) {
            await new Promise((r) => setTimeout(r, 50));
            const gi = path.join(repo, ".gitignore");
            if (fs.existsSync(logE) && fs.existsSync(gi)) {
              gitignoreTxt = fs.readFileSync(gi, "utf8");
              if (gitignoreTxt.includes(".pi-astack/")) break;
            }
          }
          assert(gitignoreTxt.includes(".pi-astack/"), "git repo: shadow default path auto-gitignored (.gitignore contains .pi-astack/)");
          assert(fs.existsSync(logE), "git repo: shadow row still written");
        } finally {
          globalThis.fetch = oldFetchE;
        }
      } else {
        ok("git binary unavailable — gitignore scenario skipped");
      }

      // Non-repo: shadow still logs, but no .gitignore is created.
      shadowMod.resetShadowState();
      indexMod.resetWebSearchProvider();
      const nonRepo = path.join(tmp, "non-repo");
      fs.mkdirSync(nonRepo, { recursive: true });
      const settingsE2 = path.join(tmp, "settings-e2.json");
      fs.writeFileSync(settingsE2, JSON.stringify({
        webSearch: {
          provider: "brave",
          brave: { apiKey: "brave-secret-key" },
          serper: { apiKey: "serper-secret-key" },
          shadow: { enabled: true, provider: "serper", sampleRate: 1, logUrls: false },
        },
      }));
      process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = settingsE2;
      await tools.web_search.execute("id-e2", { query: "non-repo-query" }, new AbortController().signal, undefined, { cwd: nonRepo });
      const logE2 = path.join(nonRepo, ".pi-astack", "web-search", "shadow.jsonl");
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (fs.existsSync(logE2)) break;
      }
      assert(fs.existsSync(logE2), "non-repo: shadow row still written");
      assert(!fs.existsSync(path.join(nonRepo, ".gitignore")), "non-repo: no .gitignore created");
    }
  } catch (e) {
    failMsg(`shadow tool-level test threw: ${e.stack || e.message}`);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv === undefined) delete process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH;
    else process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = oldEnv;
    if (oldDisabled === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = oldDisabled;
    shadowMod.resetShadowState();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 8. settings + provider factory ────────────────────────────────

console.log("\n  settings.ts + registry.ts factory:");
const settingsMod = await jiti.import(path.join(repoRoot, "extensions/web-search/settings.ts"));
const registryMod = await jiti.import(path.join(repoRoot, "extensions/web-search/registry.ts"));

{
  const oldEnv = process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-web-search-settings-"));
  try {
    const withSettings = async (webSearch, fn) => {
      const p = path.join(tmp, `s-${crypto.randomBytes(4).toString("hex")}.json`);
      fs.writeFileSync(p, JSON.stringify(webSearch === undefined ? {} : { webSearch }));
      process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = p;
      try { await fn(); } finally { delete process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH; }
    };

    // Defaults.
    await withSettings(undefined, async () => {
      const d = settingsMod.loadWebSearchSettings();
      assert(d.provider === "brave", "defaults: provider brave");
      assert(d.brave.apiKey === "" && d.brave.apiKeyEnv === "BRAVE_API_KEY", "defaults: brave legacy env BRAVE_API_KEY");
      assert(d.serper.apiKey === "" && d.serper.apiKeyEnv === "SERPER_API_KEY", "defaults: serper env SERPER_API_KEY");
      assert(d.apiKey === "" && d.apiKeyEnv === "BRAVE_API_KEY", "defaults: legacy keys kept");
      assert(d.shadow.enabled === false && d.shadow.provider === "serper" && d.shadow.sampleRate === 0 && d.shadow.logPath === "" && d.shadow.logUrls === false,
        "defaults: shadow off, provider serper, rate 0, logUrls false (URL hashes + domains)");
      const backends = registryMod.createProvider(d);
      assert(backends.search.name === "brave" && backends.fetch.name === "brave", "factory: brave search + local fetch");
      assert(backends.shadow === null, "factory: shadow null when disabled");
    });

    // Legacy Brave migration: webSearch.apiKey/apiKeyEnv flow into brave.
    await withSettings({ apiKey: "!echo legacy-key", apiKeyEnv: "OLD_BRAVE_ENV" }, async () => {
      const s = settingsMod.loadWebSearchSettings();
      assert(s.brave.apiKey === "!echo legacy-key" && s.brave.apiKeyEnv === "OLD_BRAVE_ENV",
        "legacy webSearch.apiKey/apiKeyEnv migrate to brave credentials");
      assert(s.serper.apiKey === "" && s.serper.apiKeyEnv === "SERPER_API_KEY",
        "legacy keys never leak into serper credentials");
    });

    // Provider-specific isolation: brave block overrides legacy; serper independent.
    await withSettings({
      apiKey: "legacy-brave",
      brave: { apiKey: "brave-new", apiKeyEnv: "BRAVE_NEW_ENV" },
      serper: { apiKey: "serper-key", apiKeyEnv: "SERPER_NEW_ENV" },
    }, async () => {
      const s = settingsMod.loadWebSearchSettings();
      assert(s.brave.apiKey === "brave-new" && s.brave.apiKeyEnv === "BRAVE_NEW_ENV",
        "brave.apiKey/apiKeyEnv take priority over legacy");
      assert(s.serper.apiKey === "serper-key" && s.serper.apiKeyEnv === "SERPER_NEW_ENV",
        "serper credentials independent from brave/legacy");
    });

    // Shadow config parse + sampleRate clamp.
    await withSettings({
      shadow: { enabled: true, provider: "brave", sampleRate: 2.5, logPath: "/tmp/x.jsonl", logUrls: false },
    }, async () => {
      const s = settingsMod.loadWebSearchSettings();
      assert(s.shadow.enabled === true && s.shadow.provider === "brave" && s.shadow.sampleRate === 1 &&
        s.shadow.logPath === "/tmp/x.jsonl" && s.shadow.logUrls === false,
        "shadow config parsed; sampleRate clamped to 1");
    });

    // Relative shadow.logPath fails closed to "" with a warning.
    await withSettings({
      shadow: { enabled: true, logPath: "relative/shadow.jsonl" },
    }, async () => {
      const warnings = [];
      const oldWarn = console.warn;
      console.warn = (m) => warnings.push(String(m));
      try {
        const s = settingsMod.loadWebSearchSettings();
        assert(s.shadow.logPath === "", "relative logPath fails closed to '' (default project path)");
        assert(warnings.some((w) => w.includes("logPath") && w.includes("absolute")),
          "relative logPath emits an absolute-path warning");
      } finally {
        console.warn = oldWarn;
      }
    });
    await withSettings({
      shadow: { enabled: true, logPath: "/abs/shadow.jsonl" },
    }, async () => {
      const s = settingsMod.loadWebSearchSettings();
      assert(s.shadow.logPath === "/abs/shadow.jsonl", "absolute logPath kept as-is");
    });

    // Factory with serper + shadow.
    await withSettings({
      provider: "serper",
      serper: { apiKey: "s1" },
      shadow: { enabled: true, provider: "brave", sampleRate: 0.25 },
    }, async () => {
      const s = settingsMod.loadWebSearchSettings();
      const b = registryMod.createProvider(s);
      assert(b.search.name === "serper", "factory: serper selected as main search");
      assert(b.fetch.name === "brave", "factory: fetch backend independent of search provider");
      assert(b.shadow !== null && b.shadow.search.name === "brave", "factory: shadow backend constructed with main");
      assert(b.shadow.config.sampleRate === 0.25 && b.shadow.config.provider === "brave", "factory: shadow config carried");
    });

    // Unknown provider fails closed for main; unknown shadow degrades to null.
    await withSettings({ provider: "kagi" }, async () => {
      try {
        registryMod.createProvider(settingsMod.loadWebSearchSettings());
        failMsg("factory: unknown main provider NOT rejected");
      } catch (e) {
        assert(/unknown provider "kagi"/.test(e.message) && /brave, serper/.test(e.message), "factory: unknown main provider error lists built-ins");
      }
    });
    await withSettings({
      provider: "brave",
      shadow: { enabled: true, provider: "not-a-provider", sampleRate: 1 },
    }, async () => {
      const b = registryMod.createProvider(settingsMod.loadWebSearchSettings());
      assert(b.shadow === null, "factory: unknown shadow provider degrades to null (never breaks main)");
    });

    // shadow.provider == main provider → warning + shadow null.
    await withSettings({
      provider: "brave",
      shadow: { enabled: true, provider: "brave", sampleRate: 1 },
    }, async () => {
      const warnings = [];
      const oldWarn = console.warn;
      console.warn = (m) => warnings.push(String(m));
      try {
        const b = registryMod.createProvider(settingsMod.loadWebSearchSettings());
        assert(b.shadow === null, "shadow==main → shadow null (A/B meaningless)");
        assert(warnings.some((w) => w.includes("equals the main provider")),
          "shadow==main emits a warning");
      } finally {
        console.warn = oldWarn;
      }
    });
  } catch (e) {
    failMsg(`settings/factory test threw: ${e.stack || e.message}`);
  } finally {
    if (oldEnv === undefined) delete process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH;
    else process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = oldEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 9. registry source invariants ─────────────────────────────────

console.log("\n  registry.ts:");
const registrySrc = read("extensions/web-search/registry.ts");
if (/case "brave":/.test(registrySrc) && /new BraveSearchBackend/.test(registrySrc)) {
  ok("brave case wires BraveSearchBackend");
} else failMsg("registry brave case missing");
if (/case "serper":/.test(registrySrc) && /new SerperSearchBackend/.test(registrySrc)) {
  ok("serper case wires SerperSearchBackend");
} else failMsg("registry serper case missing");
if (/unknown provider/.test(registrySrc)) {
  ok("unknown-provider error message present");
} else failMsg("unknown-provider fallback missing");
if (/BUILTIN_SEARCH_BACKENDS/.test(registrySrc) && /\["brave", "serper"\]/.test(registrySrc)) {
  ok("BUILTIN_SEARCH_BACKENDS lists brave + serper");
} else failMsg("registry.ts missing/outdated BUILTIN_SEARCH_BACKENDS");
if (/allowPrivateNetworks:\s*settings\.allowPrivateNetworks/.test(registrySrc)) {
  ok("allowPrivateNetworks plumbed to fetch backend");
} else failMsg("allowPrivateNetworks not plumbed to fetch backend");
if (/export function createFetchBackend/.test(registrySrc) && /export function createSearchBundle/.test(registrySrc)) {
  ok("createFetchBackend + createSearchBundle exported (independent construction)");
} else failMsg("fetch/search construction not split into independent factories");
if (/settings\.shadow\.enabled/.test(registrySrc) && /settings\.shadow\.provider === settings\.provider/.test(registrySrc)) {
  ok("shadow built only when enabled; shadow==main warned + nulled");
} else failMsg("shadow construction gating missing in registry");

// 10. settings source invariants ────────────────────────────────

console.log("\n  settings.ts defaults:");
const settingsSrc = read("extensions/web-search/settings.ts");
for (const literal of [
  /provider:\s*"brave"/,
  /apiKeyEnv:\s*"BRAVE_API_KEY"/,
  /apiKeyEnv:\s*"SERPER_API_KEY"/,
  /enabled:\s*false/,
  /sampleRate:\s*0/,
  /logUrls:\s*false/,
  /defaultCount:\s*5/,
  /timeout:\s*15_000/,
  /allowPrivateNetworks:\s*false/,
]) {
  if (literal.test(settingsSrc)) ok(`DEFAULTS literal: ${literal}`);
  else failMsg(`DEFAULTS missing: ${literal}`);
}
if (/loadWebSearchSettings/.test(settingsSrc)) ok("loadWebSearchSettings exported");
else failMsg("loadWebSearchSettings missing");
if (/export function webSearchSettingsMtimeMs\(\): number \| null/.test(settingsSrc) && /statSync\(settingsPath\(\)\)\.mtimeMs/.test(settingsSrc)) {
  ok("webSearchSettingsMtimeMs exported and reads settings mtime");
} else failMsg("webSearchSettingsMtimeMs missing or not wired to settings mtime");
if (/console\.warn/.test(settingsSrc) && /Failed to parse/.test(settingsSrc)) {
  ok("settings.ts JSON parse error warns (not silently swallowed)");
} else failMsg("settings.ts still silently swallows JSON parse errors");

// 11. secret.ts command resolver ────────────────────────────────

console.log("\n  utils/secret.ts command resolver:");
try {
  const secret = await jiti.import(path.join(repoRoot, "extensions/web-search/utils/secret.ts"));
  const resolved = secret.resolveSecret("!printf '%s' web-search-secret-ok");
  if (resolved === "web-search-secret-ok") ok("!command executes through bash-compatible shell");
  else failMsg(`!command resolver returned: ${JSON.stringify(resolved)}`);
} catch (e) {
  failMsg(`!command resolver threw: ${e.message}`);
}

// 12. index.ts tool registration + sub-pi guard ─────────────────

console.log("\n  index.ts tool registration + sub-pi guard:");
const indexSrc = read("extensions/web-search/index.ts");
if (/PI_ABRAIN_DISABLED.*===.*"1".*return/.test(indexSrc.replace(/\s+/g, " "))) {
  ok("sub-pi guard (ADR 0014 §6) present");
} else failMsg("sub-pi guard missing");

if (/name:\s*"web_search"/.test(indexSrc)) ok("registers web_search tool");
else failMsg("web_search tool not registered");
if (/name:\s*"web_fetch"/.test(indexSrc)) ok("registers web_fetch tool");
else failMsg("web_fetch tool not registered");
if (/resetWebSearchProvider/.test(indexSrc)) ok("resetWebSearchProvider hook exported");
else failMsg("reset hook missing");
if (/webSearchSettingsMtimeMs/.test(indexSrc) && /_backendsSettingsMtimeMs\s*===\s*settingsMtimeMs/.test(indexSrc)) {
  ok("backend revision gated by settings mtime (single revision gate)");
} else failMsg("backend revision missing settings mtime gate");
if (/clearSecretCache/.test(indexSrc)) {
  ok("clearSecretCache() called on settings reload (command cache must not survive edits)");
} else failMsg("clearSecretCache not wired into settings reload");
if (/getSearchBundle/.test(indexSrc) && /getFetchBackend/.test(indexSrc)) {
  ok("search bundle + fetch backend built independently (fetch survives search misconfig)");
} else failMsg("search/fetch not independently constructed in index.ts");
if (/scheduleShadowSearch/.test(indexSrc) && /shouldSampleShadow\(params\.query, id,/.test(indexSrc)) {
  ok("shadow scheduling wired into web_search execute (call-event sampling uses tool-call id)");
} else failMsg("shadow scheduling not wired with call-id sampling");
if (/callId: id/.test(indexSrc)) {
  ok("tool-call id passed to shadow (checksum causal anchor)");
} else failMsg("tool-call id not passed to shadow");
if (/primaryLatencyMs/.test(indexSrc) && /performance\.now\(\)/.test(indexSrc)) {
  ok("primary latency measured at tool layer (performance.now)");
} else failMsg("primary latency not measured at tool layer");
if (/signal:\s*AbortSignal/.test(indexSrc) && !/\b_signal:\s*AbortSignal/.test(indexSrc)) {
  ok("execute() uses `signal`, not `_signal` (cancel is wired)");
} else failMsg("execute() still ignores caller signal");
if (/search\.search\([^)]*signal/.test(indexSrc.replace(/\s+/g, " "))) {
  ok("signal passed to search backend");
} else failMsg("search backend called without signal");
if (/fetchBackend\.fetch\([^)]*signal/.test(indexSrc.replace(/\s+/g, " "))) {
  ok("signal passed to fetch backend");
} else failMsg("fetch backend called without signal");

if (/<untrusted_external_content>/.test(indexSrc) && /<\/untrusted_external_content>/.test(indexSrc)) {
  ok("web_fetch wraps content in <untrusted_external_content> tags");
} else failMsg("web_fetch does NOT wrap returned content with untrusted-content tags");
if (/web_search via \$\{search\.name\}/.test(indexSrc) && /untrusted_external_content/.test(indexSrc)) {
  ok("web_search results also wrapped in <untrusted_external_content> (titles/snippets are DATA)");
} else failMsg("web_search results NOT wrapped as untrusted content");
if (/TRUST BOUNDARY/.test(indexSrc) && /DATA, not COMMANDS/.test(indexSrc)) {
  ok("promptGuidelines contains trust-boundary instruction");
} else failMsg("promptGuidelines missing trust-boundary instruction");
if (/SSRF/.test(indexSrc)) ok("promptGuidelines mentions SSRF escape hatch");
else failMsg("SSRF mention missing from promptGuidelines");
if (/when shadow A\/B is enabled/i.test(indexSrc)) {
  ok("privacy guideline states sampled queries are sent to the shadow provider when enabled");
} else failMsg("privacy guideline missing shadow A/B disclosure");
if (/Serper backend supports just pd\/pw\/pm\/py/.test(indexSrc)) {
  ok("freshness guideline clarifies date ranges are Brave-only (Serper pd/pw/pm/py)");
} else failMsg("freshness guideline missing Brave-only date-range note");
if (/Privacy:/.test(indexSrc) || /privacy/i.test(indexSrc)) ok("promptGuidelines mentions privacy");
else failMsg("privacy guideline missing");

// 13. html-to-markdown utility (real function execution) ─────────

console.log("\n  utils/html-to-markdown.ts behavior:");
const htmlSrc = read("extensions/web-search/utils/html-to-markdown.ts");
for (const sym of ["htmlToMarkdown", "extractTitle", "truncateBytes"]) {
  if (new RegExp(`export function ${sym}\\b`).test(htmlSrc)) ok(`exports ${sym}`);
  else failMsg(`missing export: ${sym}`);
}

{
  const codeIdx = htmlSrc.indexOf("Inline code FIRST");
  const linkIdx = htmlSrc.indexOf("// 5. Links:");
  if (codeIdx > 0 && linkIdx > codeIdx) {
    ok("html-to-markdown: <code> processed before <a> (link+code fidelity)");
  } else failMsg("html-to-markdown: link/code order may be wrong");
}

// REAL module behavior — import the actual implementation, never a copy.
const htmlMod = await jiti.import(path.join(repoRoot, "extensions/web-search/utils/html-to-markdown.ts"));
const { truncateBytes, extractTitle, htmlToMarkdown } = htmlMod;
{
  const r = truncateBytes("hello world", 100);
  if (!r.truncated && r.text === "hello world") ok("truncateBytes passthrough when under limit");
  else failMsg(`truncateBytes passthrough failed: ${JSON.stringify(r)}`);
}
{
  const r = truncateBytes("a".repeat(500), 100);
  if (r.truncated && r.text.startsWith("a".repeat(100)) && r.text.includes("truncated to 100 bytes")) {
    ok("truncateBytes truncates + adds marker");
  } else failMsg(`truncateBytes truncate failed`);
}
{
  const utf8str = "中文".repeat(50);
  const r = truncateBytes(utf8str, 25);
  if (r.truncated && !r.text.includes("\uFFFD")) ok("truncateBytes UTF-8 safe (no replacement chars)");
  else failMsg("truncateBytes produced mojibake at UTF-8 boundary");
}
{
  const t = extractTitle("<html><head><title>Hello World</title></head></html>");
  if (t === "Hello World") ok("extractTitle basic case");
  else failMsg(`extractTitle returned: ${t}`);
}
{
  const t = extractTitle("<title>  Foo  Bar  </title>");
  if (t === "Foo Bar") ok("extractTitle collapses whitespace");
  else failMsg(`extractTitle whitespace: ${t}`);
}
{
  const t = extractTitle("<html><body>no title here</body></html>");
  if (t === undefined) ok("extractTitle returns undefined when no title");
  else failMsg(`extractTitle should be undefined, got: ${t}`);
}
{
  const md = htmlToMarkdown('<html><head><title>T</title></head><body><h1>Heading</h1><p>Some <strong>bold</strong> text.</p><a href="https://x.example"><code>fn()</code></a></body></html>');
  if (md.includes("# Heading") && md.includes("**bold**") && md.includes("[`fn()`](https://x.example)")) {
    ok("htmlToMarkdown: heading/bold/inline-code-inside-link fidelity");
  } else failMsg(`htmlToMarkdown output unexpected: ${JSON.stringify(md)}`);
}

// 14. schema.json webSearch section ─────────────────────────────

console.log("\n  pi-astack-settings.schema.json:");
const schemaSrc = read("pi-astack-settings.schema.json");
const schema = JSON.parse(schemaSrc);
if (schema.properties?.webSearch?.type === "object") ok("webSearch section exists at top level");
else failMsg("webSearch section missing or malformed");

const ws = schema.properties?.webSearch?.properties;
if (ws?.provider?.enum?.includes("brave") && ws?.provider?.enum?.includes("serper")) {
  ok("provider enum includes brave + serper");
} else failMsg("provider enum missing brave or serper");
if (ws?.brave?.properties?.apiKey && ws?.brave?.properties?.apiKeyEnv) ok("schema: brave credential block");
else failMsg("schema: brave credential block missing");
if (ws?.serper?.properties?.apiKey && ws?.serper?.properties?.apiKeyEnv) ok("schema: serper credential block");
else failMsg("schema: serper credential block missing");
if (ws?.shadow?.properties?.enabled?.default === false) ok("schema: shadow.enabled default false");
else failMsg("schema: shadow.enabled missing or wrong default");
if (ws?.shadow?.properties?.sampleRate?.minimum === 0 && ws?.shadow?.properties?.sampleRate?.maximum === 1) {
  ok("schema: shadow.sampleRate range 0..1");
} else failMsg("schema: shadow.sampleRate range incorrect");
if (ws?.shadow?.properties?.logUrls?.default === false) ok("schema: shadow.logUrls default false (hash mode)");
else failMsg("schema: shadow.logUrls missing or wrong default");
const shadowDesc = ws?.shadow?.description ?? "";
if (/keyless checksum/.test(shadowDesc) && !/sha256 of the query/.test(shadowDesc)) {
  ok("schema: shadow description uses keyless-checksum language (no bare-sha256 claim)");
} else failMsg("schema: shadow description missing keyless-checksum wording or still claims bare sha256");
if (/may still reveal which sites are of interest/.test(shadowDesc)) {
  ok("schema: domain cleartext disclosure stated (authority-analysis signal)");
} else failMsg("schema: missing domain-disclosure note");
if (/MUST be absolute/.test(ws?.shadow?.properties?.logPath?.description ?? "")) {
  ok("schema: shadow.logPath documented as absolute-only (relative fails closed)");
} else failMsg("schema: shadow.logPath absolute requirement missing");
if (/ALL query parameters/.test(ws?.shadow?.properties?.logUrls?.description ?? "")) {
  ok("schema: logUrls documented to strip userinfo/fragment/all query params");
} else failMsg("schema: logUrls strict normalization not documented");
if (ws?.apiKeyEnv?.default === "BRAVE_API_KEY") ok("apiKeyEnv default is BRAVE_API_KEY (legacy Brave migration)");
else failMsg("apiKeyEnv default not BRAVE_API_KEY");
if (ws?.defaultCount?.maximum === 20 && ws?.defaultCount?.minimum === 1) {
  ok("defaultCount range 1..20");
} else failMsg("defaultCount range incorrect");
if (ws?.timeout?.minimum >= 1000) ok("timeout minimum >= 1000ms");
else failMsg("timeout minimum incorrect");
if (ws?.allowPrivateNetworks?.type === "boolean" && ws?.allowPrivateNetworks?.default === false) {
  ok("allowPrivateNetworks default is false (SSRF off by default)");
} else failMsg("allowPrivateNetworks field missing or wrong default");

// 15. url-guard SSRF defense ────────────────────────────────────

console.log("\n  utils/url-guard.ts (SSRF defense):");
const guardSrc = read("extensions/web-search/utils/url-guard.ts");

for (const sym of ["assertUrlSafe", "safeFetch", "combineSignals"]) {
  if (new RegExp(`export (function|class|async function) ${sym}\\b`).test(guardSrc)) ok(`exports ${sym}`);
  else failMsg(`url-guard missing export: ${sym}`);
}
if (/export class UrlGuardError/.test(guardSrc)) ok("exports UrlGuardError");
else failMsg("url-guard missing UrlGuardError class");

// REAL module classification functions — never script copies. IP-literal
// checks are fully offline (no DNS).
const guardMod = await jiti.import(path.join(repoRoot, "extensions/web-search/utils/url-guard.ts"));
const { isPrivateIPv4, isPrivateIPv6, isPrivate172, isCgnat } = guardMod;
if (typeof isPrivateIPv4 !== "function" || typeof isPrivateIPv6 !== "function") {
  failMsg("url-guard module does not export isPrivateIPv4/isPrivateIPv6");
}

for (const ip of [
  "127.0.0.1",                      // loopback
  "169.254.169.254",                // link-local + cloud metadata
  "10.0.0.1", "10.255.255.255",     // RFC1918 10/8
  "172.16.0.1", "172.31.255.255",   // RFC1918 172.16/12
  "192.168.1.1",                    // RFC1918 192.168/16
  "100.64.0.1", "100.127.255.255",  // CGNAT 100.64/10 (RFC 6598)
  "0.0.0.0",                        // "this network"
  "192.0.2.1", "198.51.100.7", "203.0.113.9",  // TEST-NET-1/2/3
  "224.0.0.1", "239.255.255.250",  // multicast
  "192.0.0.8",                      // IETF reserved (RFC 7335)
]) {
  if (isPrivateIPv4(ip)) ok(`blocks IPv4 ${ip}`);
  else failMsg(`isPrivateIPv4(${ip}) returned false`);
}

for (const ip of [
  "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "9.9.9.9",
]) {
  if (!isPrivateIPv4(ip)) ok(`allows public IPv4 ${ip}`);
  else failMsg(`isPrivateIPv4(${ip}) wrongly returned true`);
}

for (const ip of [
  "::1",                            // IPv6 loopback
  "::",                             // unspecified
  "fe80::1",                        // IPv6 link-local
  "fec0::1",                        // site-local (deprecated)
  "fc00::1", "fd00::1", "fdff::1",  // IPv6 ULA fc00::/7
  "::ffff:127.0.0.1",               // IPv4-mapped loopback
  "::ffff:169.254.169.254",         // IPv4-mapped metadata
  "ff02::1",                        // IPv6 multicast
]) {
  if (isPrivateIPv6(ip)) ok(`blocks IPv6 ${ip}`);
  else failMsg(`isPrivateIPv6(${ip}) returned false`);
}

for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111", "2607:f8b0::1"]) {
  if (!isPrivateIPv6(ip)) ok(`allows public IPv6 ${ip}`);
  else failMsg(`isPrivateIPv6(${ip}) wrongly returned true`);
}

// Range-boundary helpers (real module).
if (isPrivate172("172.16.0.1") && isPrivate172("172.31.255.255") && !isPrivate172("172.15.0.1") && !isPrivate172("172.32.0.1")) {
  ok("isPrivate172: 172.16/12 boundaries exact");
} else failMsg("isPrivate172 boundary wrong");
if (isCgnat("100.64.0.1") && isCgnat("100.127.255.255") && !isCgnat("100.63.255.255") && !isCgnat("100.128.0.1")) {
  ok("isCgnat: 100.64/10 boundaries exact");
} else failMsg("isCgnat boundary wrong");

for (const literal of ['"localhost"', '"metadata.google.internal"']) {
  if (guardSrc.includes(literal)) ok(`BLOCKED_HOST_LITERALS contains ${literal}`);
  else failMsg(`BLOCKED_HOST_LITERALS missing ${literal}`);
}

if (/redirect:\s*"manual"/.test(guardSrc)) {
  ok("safeFetch uses redirect:\"manual\"");
} else failMsg("safeFetch missing manual redirect handling");
if (/Too many redirects/.test(guardSrc)) ok("safeFetch caps redirect hops");
else failMsg("safeFetch missing redirect cap");

if (/AbortSignal\.any/.test(guardSrc) || /Any\(valid\)/.test(guardSrc)) {
  ok("combineSignals uses native AbortSignal.any (Node 20.3+)");
} else failMsg("combineSignals does NOT use AbortSignal.any");

// 16. settings mtime hot reload + secret cache + fetch independence ──

console.log("\n  settings mtime hot reload + fetch independence:");
{
  const oldFetch = globalThis.fetch;
  const oldEnv = process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH;
  const oldDisabled = process.env.PI_ABRAIN_DISABLED;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-web-search-reload-"));
  try {
    delete process.env.PI_ABRAIN_DISABLED;
    const indexMod = await jiti.import(path.join(repoRoot, "extensions/web-search/index.ts"));
    const tools = {};
    indexMod.default({ registerTool(def) { tools[def.name] = def; } });
    const settingsPathFile = path.join(tmp, "settings.json");
    // Monotonic mtime bump: each bump must be STRICTLY greater than the
    // previous one. A plain Date.now()+60s can collide when two bumps land
    // in the same millisecond, and writeFileSync resets mtime to real-now
    // (below the future-bumped value), so a "max(now+60s, cur+1s)" helper
    // would still pick the same now+60s. A per-bump counter guarantees it.
    let bumpCounter = 0;
    const bumpMtime = () => {
      bumpCounter++;
      fs.utimesSync(settingsPathFile, new Date(), new Date(Date.now() + 60_000 + bumpCounter * 1000));
    };
    const mtime = () => fs.statSync(settingsPathFile).mtimeMs;

    // (a) Same settings path, brave → serper: mtime gate must rebuild the
    // bundle WITHOUT calling reset — the second call's details.provider
    // switches, proving hot reload.
    fs.writeFileSync(settingsPathFile, JSON.stringify({
      webSearch: { provider: "brave", brave: { apiKey: "brave-secret-key" }, serper: { apiKey: "serper-secret-key" } },
    }));
    process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = settingsPathFile;
    const m0 = mtime();
    globalThis.fetch = async (url) => {
      if (String(url).startsWith("https://api.search.brave.com/")) {
        return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://brave.example/1", description: "s" }] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "https://google.serper.dev/search") {
        return new Response(JSON.stringify({ organic: [{ title: "Serper", link: "https://serper.example/1", snippet: "s" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };
    const r1 = await tools.web_search.execute("id-h1", { query: "hot-reload-1" }, new AbortController().signal, undefined, { cwd: tmp });
    assert(!r1.isError && r1.details.provider === "brave", "hot reload: first call uses brave");
    fs.writeFileSync(settingsPathFile, JSON.stringify({
      webSearch: { provider: "serper", serper: { apiKey: "serper-secret-key" } },
    }));
    bumpMtime();
    const m1 = mtime();
    assert(m1 !== m0, "hot reload: settings mtime actually changed");
    const r2 = await tools.web_search.execute("id-h2", { query: "hot-reload-2" }, new AbortController().signal, undefined, { cwd: tmp });
    assert(!r2.isError && r2.details.provider === "serper", "hot reload: second call (same path, no reset) uses serper");

    // (b) clearSecretCache: a settings edit must invalidate cached command
    // output. Same command string reading a file whose content changed.
    const secretFile = path.join(tmp, "secret.txt");
    fs.writeFileSync(secretFile, "bad-key");
    fs.writeFileSync(settingsPathFile, JSON.stringify({
      webSearch: { provider: "brave", brave: { apiKey: `!cat ${secretFile}` } },
    }));
    bumpMtime();
    let lastToken = null;
    globalThis.fetch = async (url, init) => {
      lastToken = init?.headers?.["X-Subscription-Token"] ?? null;
      if (lastToken === "good-key") {
        return new Response(JSON.stringify({ web: { results: [{ title: "Good", url: "https://brave.example/g", description: "s" }] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("unauthorized", { status: 401 });
    };
    const r3 = await tools.web_search.execute("id-h3", { query: "secret-reload-1" }, new AbortController().signal, undefined, { cwd: tmp });
    assert(r3.isError === true && lastToken === "bad-key", "secret reload: first call resolves old command output (bad-key → 401)");
    fs.writeFileSync(secretFile, "good-key");
    fs.writeFileSync(settingsPathFile, JSON.stringify({
      webSearch: { provider: "brave", brave: { apiKey: `!cat ${secretFile}` } },
    }));
    bumpMtime();
    const r4 = await tools.web_search.execute("id-h4", { query: "secret-reload-2" }, new AbortController().signal, undefined, { cwd: tmp });
    assert(!r4.isError && r4.details.count === 1 && lastToken === "good-key",
      "secret reload: mtime change cleared command cache — next call uses the new value");

    // (c) Search-provider typo must NOT kill web_fetch: fetch is built
    // independently of search config (mock local fetch, offline).
    fs.writeFileSync(settingsPathFile, JSON.stringify({
      webSearch: { provider: "kagi", allowPrivateNetworks: true },
    }));
    bumpMtime();
    globalThis.fetch = async () => new Response(
      "<html><head><title>Fetch OK</title></head><body><h1>Hello</h1></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );
    const r5 = await tools.web_fetch.execute("id-h5", { url: "https://example.test/page" }, new AbortController().signal, undefined);
    assert(!r5.isError && r5.details.provider === "brave" && typeof r5.details.title === "string",
      "fetch independence: web_fetch works even with a typo'd search provider");
    const r6 = await tools.web_search.execute("id-h6", { query: "typo-provider" }, new AbortController().signal, undefined, { cwd: tmp });
    assert(r6.isError === true && /unknown provider "kagi"/.test(r6.details.error ?? ""),
      "fetch independence: web_search still surfaces the provider error");
  } catch (e) {
    failMsg(`hot reload / fetch independence test threw: ${e.stack || e.message}`);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv === undefined) delete process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH;
    else process.env.PI_ASTACK_WEB_SEARCH_SETTINGS_PATH = oldEnv;
    if (oldDisabled === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = oldDisabled;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 17. report-web-search-shadow.mjs aggregation (temp JSONL) ──────

console.log("\n  scripts/report-web-search-shadow.mjs aggregation:");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-web-search-report-"));
  try {
    const logFile = path.join(tmp, "shadow.jsonl");
    // 3 ok rows (latencies 10/20/30/40 across both providers counted
    // separately per provider) + 2 error rows with distinct errorKinds.
    const rows = [
      { schemaVersion: 2, timestamp: "2026-08-11T10:00:00.000+08:00", primaryProvider: "brave", shadowProvider: "serper",
        primary: { status: "ok", latencyMs: 10, resultCount: 5 }, shadow: { status: "ok", latencyMs: 20, resultCount: 4 },
        overlap: 3, effectiveTopK: 4, primaryDomains: ["a.example", "b.example"], shadowDomains: ["b.example", "c.example"] },
      { schemaVersion: 2, timestamp: "2026-08-11T10:00:01.000+08:00", primaryProvider: "brave", shadowProvider: "serper",
        primary: { status: "ok", latencyMs: 20, resultCount: 6 }, shadow: { status: "ok", latencyMs: 30, resultCount: 5 },
        overlap: 1, effectiveTopK: 5, primaryDomains: ["a.example"], shadowDomains: ["a.example"] },
      { schemaVersion: 2, timestamp: "2026-08-11T10:00:02.000+08:00", primaryProvider: "brave", shadowProvider: "serper",
        primary: { status: "ok", latencyMs: 30, resultCount: 7 }, shadow: { status: "ok", latencyMs: 40, resultCount: 6 },
        overlap: 2, effectiveTopK: 6, primaryDomains: ["b.example", "d.example"], shadowDomains: ["b.example"] },
      { schemaVersion: 2, timestamp: "2026-08-11T10:00:03.000+08:00", primaryProvider: "brave", shadowProvider: "serper",
        primary: { status: "ok", latencyMs: 40, resultCount: 8 }, shadow: { status: "ok", latencyMs: 50, resultCount: 7 },
        overlap: 0, effectiveTopK: 7, primaryDomains: ["a.example"], shadowDomains: ["d.example"] },
      { schemaVersion: 2, timestamp: "2026-08-11T10:00:04.000+08:00", primaryProvider: "brave", shadowProvider: "serper",
        primary: { status: "ok", latencyMs: 15, resultCount: 5 }, shadow: { status: "error", resultCount: 0, errorKind: "rate_limit", errorStatus: 429 },
        overlap: null, effectiveTopK: null, primaryDomains: ["c.example"], shadowDomains: [] },
      { schemaVersion: 2, timestamp: "2026-08-11T10:00:05.000+08:00", primaryProvider: "brave", shadowProvider: "serper",
        primary: { status: "ok", latencyMs: 16, resultCount: 5 }, shadow: { status: "error", resultCount: 0, errorKind: "timeout" },
        overlap: null, effectiveTopK: null, primaryDomains: ["a.example"], shadowDomains: [] },
    ];
    fs.writeFileSync(logFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { execFileSync } = await import("node:child_process");
    let out = "";
    try {
      out = execFileSync(process.execPath, [path.join(repoRoot, "scripts/report-web-search-shadow.mjs"), "--file", logFile], { encoding: "utf8" });
    } catch (e) {
      failMsg(`report script failed: ${e.message}`);
    }
    const jsonLine = out.split("\n").find((l) => l.startsWith("REPORT_JSON "));
    if (!jsonLine) {
      failMsg("report script did not emit REPORT_JSON");
    } else {
      const s = JSON.parse(jsonLine.slice("REPORT_JSON ".length));
      assert(s.totalRows === 6, `report: totalRows=6 (got ${s.totalRows})`);
      assert(s.okRows === 4 && s.errorRows === 2, `report: okRows=4 errorRows=2 (got ${s.okRows}/${s.errorRows})`);
      assert(s.providerPairs.length === 1 && s.providerPairs[0].pair === "brave->serper" && s.providerPairs[0].count === 6 && s.providerPairs[0].ok === 4,
        "report: provider pair brave->serper total=6 ok=4");
      assert(s.errorKinds.rate_limit === 1 && s.errorKinds.timeout === 1, "report: errorKinds rate_limit=1 timeout=1");
      // nearest-rank p50/p95 over [10,20,30,40,15,16] → p50=20, p95=40; shadow [20,30,40,50] → p50=30, p95=50.
      assert(s.primaryLatency.p50 === 20 && s.primaryLatency.p95 === 40, `report: primary latency p50=20 p95=40 (got ${JSON.stringify(s.primaryLatency)})`);
      assert(s.shadowLatency.p50 === 30 && s.shadowLatency.p95 === 50, `report: shadow latency p50=30 p95=50 (got ${JSON.stringify(s.shadowLatency)})`);
      assert(s.primaryResultCount.p50 === 6 && s.shadowResultCount.p50 === 5, "report: result-count p50 present (primary 6 / shadow 5)");
      assert(s.overlap.p50 === 1 && s.effectiveTopK.p50 === 5, "report: overlap/effectiveTopK p50 computed over ok rows");
      const topDomain = s.topDomains[0];
      assert(topDomain && topDomain.domain === "a.example" && topDomain.count === 5, `report: top domain a.example (5) (got ${JSON.stringify(s.topDomains[0])})`);
      assert(!out.includes("secret-query") && !out.includes("queryHash") && !out.includes("primaryUrlHashes"),
        "report: no query/hash/detail leakage in output");
    }

    // ENOENT: missing log file → empty report (exit 0, totalRows=0, file
    // kept, clear "no shadow samples yet" message, no stack trace).
    const missingFile = path.join(tmp, "no-such-shadow.jsonl");
    let outMissing = "";
    try {
      outMissing = execFileSync(process.execPath, [path.join(repoRoot, "scripts/report-web-search-shadow.mjs"), "--file", missingFile], { encoding: "utf8" });
      ok("report: missing log file exits 0 (no stack trace)");
    } catch (e) {
      failMsg(`report: missing log file should exit 0, got: ${e.message}`);
    }
    const missingJsonLine = outMissing.split("\n").find((l) => l.startsWith("REPORT_JSON "));
    if (!missingJsonLine) {
      failMsg("report: ENOENT case did not emit REPORT_JSON");
    } else {
      const s = JSON.parse(missingJsonLine.slice("REPORT_JSON ".length));
      assert(s.totalRows === 0 && s.okRows === 0 && s.errorRows === 0, "report: ENOENT → empty aggregate (totalRows=0)");
      assert(s.file === missingFile, "report: ENOENT keeps file field");
      assert(Array.isArray(s.providerPairs) && s.providerPairs.length === 0 && s.topDomains.length === 0,
        "report: ENOENT → empty providerPairs/topDomains");
      assert(s.primaryLatency.p50 === null && s.primaryLatency.n === 0 && s.overlap.p50 === null,
        "report: ENOENT → null latency/overlap aggregates");
    }
    assert(/no shadow samples yet/.test(outMissing), "report: ENOENT prints 'no shadow samples yet'");
    assert(!/Error:/.test(outMissing) && !/\n\s+at /.test(outMissing), "report: ENOENT prints no stack trace");

    // Non-ENOENT read errors (e.g. a directory) must still fail.
    try {
      execFileSync(process.execPath, [path.join(repoRoot, "scripts/report-web-search-shadow.mjs"), "--file", tmp], { encoding: "utf8" });
      failMsg("report: directory path (EISDIR) should still fail");
    } catch (e) {
      assert(/cannot read shadow log/.test(e.stderr ?? ""), "report: non-ENOENT read error still fails with clear message");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Summary ───────────────────────────────────────────────────────

console.log(`\n  Results: ${pass} passed, ${fail} failed`);
console.log(
  "  Note: mock-fetch verification covers request shaping / parsing / error " +
  "paths deterministically; real Serper API acceptance (live SERPER_API_KEY, " +
  "network) is NOT covered here.",
);
if (fail > 0) process.exit(1);
