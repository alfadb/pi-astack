#!/usr/bin/env node
/**
 * Smoke test for pi-astack web-search extension (ADR 0027 PR-A + PR-A
 * review fixes from commit after f4fc560).
 *
 * Validates:
 *   - file structure (types/registry/settings + brave provider +
 *     html-to-markdown utility + url-guard SSRF defense)
 *   - dispatch KNOWN_TOOLS includes web_search/web_fetch
 *   - dispatch default allowlist includes web_search/web_fetch (4 sites,
 *     no orphan)
 *   - source-string-level invariants (sub-pi guard, missing-key error,
 *     provider switch fallback, signal pass-through, untrusted-content
 *     framing, SSRF guard wired, content-type whitelist, streamed body)
 *   - core utility functions copied into this file (truncateBytes,
 *     extractTitle, isPrivateIPv4/v6) work on canonical inputs
 *
 * Does NOT call the real Brave Search API or do DNS lookups. Pattern
 * follows smoke-imagine.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function failMsg(msg) { fail++; console.log(`  ✗ ${msg}`); }

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// 1. File structure ─────────────────────────────────────────────

console.log("\n  file structure:");
const expectedFiles = [
  "extensions/web-search/index.ts",
  "extensions/web-search/types.ts",
  "extensions/web-search/registry.ts",
  "extensions/web-search/settings.ts",
  "extensions/web-search/providers/brave.ts",
  "extensions/web-search/utils/html-to-markdown.ts",
  "extensions/web-search/utils/url-guard.ts",
];
for (const f of expectedFiles) {
  if (fs.existsSync(path.join(repoRoot, f))) ok(f);
  else failMsg(`missing: ${f}`);
}

// 2. dispatch KNOWN_TOOLS + default allowlist patches ───────────

console.log("\n  dispatch/index.ts patches (ADR 0027 PR-A):");
const dispatchSrc = read("extensions/dispatch/index.ts");

if (/const KNOWN_TOOLS = new Set\(\[[\s\S]*?"web_search"[\s\S]*?\]\)/.test(dispatchSrc)) {
  ok("KNOWN_TOOLS contains web_search");
} else failMsg("KNOWN_TOOLS does NOT contain web_search");

if (/const KNOWN_TOOLS = new Set\(\[[\s\S]*?"web_fetch"[\s\S]*?\]\)/.test(dispatchSrc)) {
  ok("KNOWN_TOOLS contains web_fetch");
} else failMsg("KNOWN_TOOLS does NOT contain web_fetch");

// Default-allowlist sites should all be patched. Total
// `read,grep,find,ls` occurrences MUST equal patched (= 0 orphan).
const allowlistSites = dispatchSrc.match(/read,grep,find,ls/g) || [];
const patchedSites = dispatchSrc.match(/read,grep,find,ls,web_search,web_fetch/g) || [];
if (allowlistSites.length === patchedSites.length && patchedSites.length >= 4) {
  ok(`default allowlist patched in ${patchedSites.length} sites (no orphan)`);
} else {
  failMsg(`patched ${patchedSites.length} sites but ${allowlistSites.length} total occurrences — orphan(s) remain`);
}

if (/Sub-agents CAN use read, grep, find, ls, web_search, web_fetch\./.test(dispatchSrc)) {
  ok("promptGuidelines text updated for sub-agent capabilities");
} else failMsg("promptGuidelines text NOT updated");

// 3. types.ts contract ──────────────────────────────────────────

console.log("\n  types.ts contract:");
const typesSrc = read("extensions/web-search/types.ts");
for (const sym of ["WebSearchProvider", "SearchOpts", "SearchResult", "FetchOpts", "FetchResult"]) {
  if (new RegExp(`export interface ${sym}\\b`).test(typesSrc)) ok(`exports ${sym}`);
  else failMsg(`missing export: ${sym}`);
}

// PR-A review fix: dead timeoutMs field removed; signal added.
if (!/timeoutMs\?:/.test(typesSrc)) ok("dead timeoutMs field removed from types.ts");
else failMsg("types.ts still has dead timeoutMs field");
if (/signal\?:\s*AbortSignal/.test(typesSrc)) ok("signal?: AbortSignal added to opts");
else failMsg("types.ts missing signal? field");

// 4. brave provider invariants ──────────────────────────────────

console.log("\n  providers/brave.ts:");
const braveSrc = read("extensions/web-search/providers/brave.ts");

if (/class BraveProvider implements WebSearchProvider/.test(braveSrc)) {
  ok("BraveProvider implements WebSearchProvider");
} else failMsg("BraveProvider does not implement WebSearchProvider");

if (/api\.search\.brave\.com\/res\/v1\/web\/search/.test(braveSrc)) {
  ok("uses Brave REST endpoint directly (not shelling out)");
} else failMsg("Brave REST endpoint not found");

if (/X-Subscription-Token/.test(braveSrc)) {
  ok("sends X-Subscription-Token header (Brave auth)");
} else failMsg("missing X-Subscription-Token header");

if (/this\.opts\.apiKeyEnv/.test(braveSrc) && /process\.env\[/.test(braveSrc)) {
  ok("API key read from configurable env var (not hardcoded BRAVE_API_KEY)");
} else failMsg("API key handling does NOT use settings.apiKeyEnv");

if (/env var not set/.test(braveSrc) && /api-dashboard\.search\.brave\.com/.test(braveSrc)) {
  ok("missing-key error message points to Brave dashboard for signup");
} else failMsg("missing-key error message not helpful");

// PR-A review fix A1: routes web_fetch through safeFetch (SSRF guard).
if (/safeFetch\(/.test(braveSrc) && /allowPrivateNetworks/.test(braveSrc)) {
  ok("web_fetch routes through safeFetch with allowPrivateNetworks plumbed");
} else failMsg("web_fetch does NOT route through safeFetch — SSRF defense missing");

// PR-A review fix A2: signal combined with timeout via combineSignals.
if (/combineSignals/.test(braveSrc) && /opts\?\.signal/.test(braveSrc)) {
  ok("caller signal combined with timeout (combineSignals used)");
} else failMsg("caller signal NOT combined — cancel won't propagate");

// PR-A review fix A3: count is integer-rounded before clamp.
if (/Math\.floor\(opts\?\.count/.test(braveSrc)) {
  ok("count is Math.floor()'d before clamping (no fractional to Brave)");
} else failMsg("count NOT integer-rounded — 5.7 would pass through");

// PR-A review fix A4: stream-based maxBytes (not blanket response.text()).
if (/response\.body\?\.getReader/.test(braveSrc) && /TextDecoder/.test(braveSrc)) {
  ok("fetch uses streamed body reader with TextDecoder");
} else failMsg("fetch still uses unbounded response.text() — memory pressure risk");

// PR-A review fix A5: content-type whitelist.
if (/isTextLikeContentType/.test(braveSrc)) {
  ok("content-type whitelist (isTextLikeContentType) present");
} else failMsg("no content-type whitelist — binary content would be mojibake");

// Absolute hard cap to prevent pathological maxBytes.
if (/ABSOLUTE_MAX_RAW_BYTES/.test(braveSrc)) {
  ok("ABSOLUTE_MAX_RAW_BYTES hard cap present");
} else failMsg("missing absolute hard cap on raw read bytes");

// 5. registry switch ────────────────────────────────────────────

console.log("\n  registry.ts:");
const registrySrc = read("extensions/web-search/registry.ts");
if (/case "brave":/.test(registrySrc) && /new BraveProvider/.test(registrySrc)) {
  ok("brave case wires BraveProvider");
} else failMsg("registry brave case missing");
if (/unknown provider/.test(registrySrc)) {
  ok("unknown-provider error message present");
} else failMsg("unknown-provider fallback missing");
if (/BUILTIN_PROVIDERS/.test(registrySrc)) {
  ok("BUILTIN_PROVIDERS list named for unknown-provider error");
} else failMsg("registry.ts missing BUILTIN_PROVIDERS");
if (/allowPrivateNetworks:\s*settings\.allowPrivateNetworks/.test(registrySrc)) {
  ok("allowPrivateNetworks plumbed to provider constructor");
} else failMsg("allowPrivateNetworks not plumbed to provider");

// 6. settings defaults ──────────────────────────────────────────

console.log("\n  settings.ts defaults:");
const settingsSrc = read("extensions/web-search/settings.ts");
for (const literal of [
  /provider:\s*"brave"/,
  /apiKeyEnv:\s*"BRAVE_API_KEY"/,
  /defaultCount:\s*5/,
  /timeout:\s*15_000/,
  /allowPrivateNetworks:\s*false/,
]) {
  if (literal.test(settingsSrc)) ok(`DEFAULTS literal: ${literal}`);
  else failMsg(`DEFAULTS missing: ${literal}`);
}
if (/loadWebSearchSettings/.test(settingsSrc)) ok("loadWebSearchSettings exported");
else failMsg("loadWebSearchSettings missing");
if (/console\.warn/.test(settingsSrc) && /Failed to parse/.test(settingsSrc)) {
  ok("settings.ts JSON parse error warns (not silently swallowed)");
} else failMsg("settings.ts still silently swallows JSON parse errors");

// 7. index.ts tool registration + sub-pi guard ──────────────────

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

// PR-A review fix A2: signal pass-through (no more `_signal`).
if (/signal:\s*AbortSignal/.test(indexSrc) && !/\b_signal:\s*AbortSignal/.test(indexSrc)) {
  ok("execute() uses `signal`, not `_signal` (cancel is wired)");
} else failMsg("execute() still ignores caller signal");
if (/provider\.search\([^)]*signal/.test(indexSrc.replace(/\s+/g, " "))) {
  ok("signal passed to provider.search()");
} else failMsg("provider.search() called without signal");
if (/provider\.fetch\([^)]*signal/.test(indexSrc.replace(/\s+/g, " "))) {
  ok("signal passed to provider.fetch()");
} else failMsg("provider.fetch() called without signal");

// PR-A review fix B1: untrusted-content framing + trust-boundary guideline.
if (/<untrusted_external_content>/.test(indexSrc) && /<\/untrusted_external_content>/.test(indexSrc)) {
  ok("web_fetch wraps content in <untrusted_external_content> tags");
} else failMsg("web_fetch does NOT wrap returned content with untrusted-content tags");
if (/TRUST BOUNDARY/.test(indexSrc) && /DATA, not COMMANDS/.test(indexSrc)) {
  ok("promptGuidelines contains trust-boundary instruction");
} else failMsg("promptGuidelines missing trust-boundary instruction");
if (/SSRF/.test(indexSrc)) ok("promptGuidelines mentions SSRF escape hatch");
else failMsg("SSRF mention missing from promptGuidelines");
if (/Privacy:/.test(indexSrc) || /privacy/i.test(indexSrc)) ok("promptGuidelines mentions privacy");
else failMsg("privacy guideline missing");

// 8. html-to-markdown utility (real function execution) ─────────

console.log("\n  utils/html-to-markdown.ts behavior:");
const htmlSrc = read("extensions/web-search/utils/html-to-markdown.ts");
for (const sym of ["htmlToMarkdown", "extractTitle", "truncateBytes"]) {
  if (new RegExp(`export function ${sym}\\b`).test(htmlSrc)) ok(`exports ${sym}`);
  else failMsg(`missing export: ${sym}`);
}

// PR-A review fix A3 (Opus): <code> processed BEFORE <a> so
// `<a><code>fn</code></a>` becomes `[`fn`](href)` not `[fn](href)`.
{
  const codeIdx = htmlSrc.indexOf("Inline code FIRST");
  const linkIdx = htmlSrc.indexOf("// 5. Links:");
  if (codeIdx > 0 && linkIdx > codeIdx) {
    ok("html-to-markdown: <code> processed before <a> (link+code fidelity)");
  } else failMsg("html-to-markdown: link/code order may be wrong");
}

function truncateBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  const cut = buf.subarray(0, end).toString("utf8");
  return {
    text: cut + `\n\n[…truncated to ${maxBytes} bytes; total was ${buf.byteLength} bytes]`,
    truncated: true,
  };
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const t = m[1].trim().replace(/&amp;/g, "&").replace(/\s+/g, " ");
  return t || undefined;
}

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

// 9. schema.json webSearch section ──────────────────────────────

console.log("\n  pi-astack-settings.schema.json:");
const schemaSrc = read("pi-astack-settings.schema.json");
const schema = JSON.parse(schemaSrc);
if (schema.properties?.webSearch?.type === "object") ok("webSearch section exists at top level");
else failMsg("webSearch section missing or malformed");

const ws = schema.properties?.webSearch?.properties;
if (ws?.provider?.enum?.includes("brave")) ok("provider enum includes brave");
else failMsg("provider enum missing brave");
if (ws?.apiKeyEnv?.default === "BRAVE_API_KEY") ok("apiKeyEnv default is BRAVE_API_KEY");
else failMsg("apiKeyEnv default not BRAVE_API_KEY");
if (ws?.defaultCount?.maximum === 20 && ws?.defaultCount?.minimum === 1) {
  ok("defaultCount range 1..20");
} else failMsg("defaultCount range incorrect");
if (ws?.timeout?.minimum >= 1000) ok("timeout minimum >= 1000ms");
else failMsg("timeout minimum incorrect");
if (ws?.allowPrivateNetworks?.type === "boolean" && ws?.allowPrivateNetworks?.default === false) {
  ok("allowPrivateNetworks default is false (SSRF off by default)");
} else failMsg("allowPrivateNetworks field missing or wrong default");

// 10. url-guard SSRF defense ────────────────────────────────────

console.log("\n  utils/url-guard.ts (SSRF defense):");
const guardSrc = read("extensions/web-search/utils/url-guard.ts");

for (const sym of ["assertUrlSafe", "safeFetch", "combineSignals"]) {
  if (new RegExp(`export (function|class|async function) ${sym}\\b`).test(guardSrc)) ok(`exports ${sym}`);
  else failMsg(`url-guard missing export: ${sym}`);
}
if (/export class UrlGuardError/.test(guardSrc)) ok("exports UrlGuardError");
else failMsg("url-guard missing UrlGuardError class");

// Real function execution: re-implement isPrivateIPv4 + isPrivateIPv6.
function isPrivate172(ip) {
  if (!ip.startsWith("172.")) return false;
  const second = parseInt(ip.split(".")[1] || "0", 10);
  return Number.isFinite(second) && second >= 16 && second <= 31;
}
function isCgnat(ip) {
  if (!ip.startsWith("100.")) return false;
  const second = parseInt(ip.split(".")[1] || "0", 10);
  return Number.isFinite(second) && second >= 64 && second <= 127;
}
function isPrivateIPv4(ip) {
  if (ip.startsWith("0.")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (isPrivate172(ip)) return true;
  if (isCgnat(ip)) return true;
  return false;
}
function isPrivateIPv6(ip) {
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true;
  if (lc.startsWith("fe80:") || lc.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{0,2}:/i.test(lc)) return true;
  if (lc.startsWith("::ffff:")) {
    const v4 = lc.replace(/^::ffff:/, "");
    return isPrivateIPv4(v4);
  }
  return false;
}

for (const ip of [
  "127.0.0.1",
  "169.254.169.254",
  "10.0.0.1", "10.255.255.255",
  "172.16.0.1", "172.31.255.255",
  "192.168.1.1",
  "100.64.0.1", "100.127.255.255",
  "0.0.0.0",
]) {
  if (isPrivateIPv4(ip)) ok(`blocks IPv4 ${ip}`);
  else failMsg(`isPrivateIPv4(${ip}) returned false`);
}

for (const ip of [
  "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1",
]) {
  if (!isPrivateIPv4(ip)) ok(`allows public IPv4 ${ip}`);
  else failMsg(`isPrivateIPv4(${ip}) wrongly returned true`);
}

for (const ip of [
  "::1",
  "fe80::1",
  "fc00::1", "fd00::1",
  "::ffff:127.0.0.1",
  "::ffff:169.254.169.254",
]) {
  if (isPrivateIPv6(ip)) ok(`blocks IPv6 ${ip}`);
  else failMsg(`isPrivateIPv6(${ip}) returned false`);
}

for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111"]) {
  if (!isPrivateIPv6(ip)) ok(`allows public IPv6 ${ip}`);
  else failMsg(`isPrivateIPv6(${ip}) wrongly returned true`);
}

// Blocked hostname literals (source-string check).
for (const literal of ['"localhost"', '"metadata.google.internal"']) {
  if (guardSrc.includes(literal)) ok(`BLOCKED_HOST_LITERALS contains ${literal}`);
  else failMsg(`BLOCKED_HOST_LITERALS missing ${literal}`);
}

// safeFetch must use redirect:"manual" + cap hops.
if (/redirect:\s*"manual"/.test(guardSrc)) {
  ok("safeFetch uses redirect:\"manual\"");
} else failMsg("safeFetch missing manual redirect handling");
if (/Too many redirects/.test(guardSrc)) ok("safeFetch caps redirect hops");
else failMsg("safeFetch missing redirect cap");

// combineSignals uses AbortSignal.any.
if (/AbortSignal\.any/.test(guardSrc) || /Any\(valid\)/.test(guardSrc)) {
  ok("combineSignals uses native AbortSignal.any (Node 20.3+)");
} else failMsg("combineSignals does NOT use AbortSignal.any");

// Summary ───────────────────────────────────────────────────────

console.log(`\n  Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
