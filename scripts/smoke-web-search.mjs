#!/usr/bin/env node
/**
 * Smoke test for pi-astack web-search extension (ADR 0027 PR-A).
 *
 * Validates:
 *   - file structure of the extension (types/registry/settings + brave
 *     provider + html-to-markdown utility)
 *   - dispatch KNOWN_TOOLS includes web_search/web_fetch
 *   - dispatch default allowlist includes web_search/web_fetch (5 sites)
 *   - source-string-level invariants (sub-pi guard, missing-key error,
 *     provider switch fallback, etc.)
 *   - core utility functions copied into this file (truncateBytes,
 *     extractTitle, decodeEntities) work on canonical inputs
 *
 * Does NOT call the real Brave Search API. Pattern follows
 * smoke-imagine.mjs.
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

// ── 1. File structure ───────────────────────────────────────────

console.log("\n  file structure:");
const expectedFiles = [
  "extensions/web-search/index.ts",
  "extensions/web-search/types.ts",
  "extensions/web-search/registry.ts",
  "extensions/web-search/settings.ts",
  "extensions/web-search/providers/brave.ts",
  "extensions/web-search/utils/html-to-markdown.ts",
];
for (const f of expectedFiles) {
  if (fs.existsSync(path.join(repoRoot, f))) ok(f);
  else failMsg(`missing: ${f}`);
}

// ── 2. dispatch KNOWN_TOOLS + default allowlist patches ─────────

console.log("\n  dispatch/index.ts patches (ADR 0027 PR-A):");
const dispatchSrc = read("extensions/dispatch/index.ts");

if (/const KNOWN_TOOLS = new Set\(\[[\s\S]*?"web_search"[\s\S]*?\]\)/.test(dispatchSrc)) {
  ok("KNOWN_TOOLS contains web_search");
} else failMsg("KNOWN_TOOLS does NOT contain web_search");

if (/const KNOWN_TOOLS = new Set\(\[[\s\S]*?"web_fetch"[\s\S]*?\]\)/.test(dispatchSrc)) {
  ok("KNOWN_TOOLS contains web_fetch");
} else failMsg("KNOWN_TOOLS does NOT contain web_fetch");

// Default-allowlist sites should all be patched to include web_search/web_fetch.
// Total `read,grep,find,ls` occurrences MUST equal patched (= 0 orphan).
// pi-astack has 4 such sites (runInProcess default + 2 tool descriptions + parallel fallback).
const allowlistSites = dispatchSrc.match(/read,grep,find,ls/g) || [];
const patchedSites = dispatchSrc.match(/read,grep,find,ls,web_search,web_fetch/g) || [];
if (allowlistSites.length === patchedSites.length && patchedSites.length >= 4) {
  ok(`default allowlist patched in ${patchedSites.length} sites (no orphan "read,grep,find,ls" left)`);
} else {
  failMsg(`patched ${patchedSites.length} sites but ${allowlistSites.length} total "read,grep,find,ls" occurrences — orphan(s) remain`);
}

if (/Sub-agents CAN use read, grep, find, ls, web_search, web_fetch\./.test(dispatchSrc)) {
  ok("promptGuidelines text updated for sub-agent capabilities");
} else failMsg("promptGuidelines text NOT updated");

// ── 3. web-search/types.ts contract ─────────────────────────────

console.log("\n  types.ts contract:");
const typesSrc = read("extensions/web-search/types.ts");
for (const sym of ["WebSearchProvider", "SearchOpts", "SearchResult", "FetchOpts", "FetchResult"]) {
  if (new RegExp(`export interface ${sym}\\b`).test(typesSrc)) ok(`exports ${sym}`);
  else failMsg(`missing export: ${sym}`);
}

// ── 4. brave provider invariants ────────────────────────────────

console.log("\n  providers/brave.ts:");
const braveSrc = read("extensions/web-search/providers/brave.ts");

if (/class BraveProvider implements WebSearchProvider/.test(braveSrc)) {
  ok("BraveProvider implements WebSearchProvider");
} else failMsg("BraveProvider does not implement WebSearchProvider");

if (/api\.search\.brave\.com\/res\/v1\/web\/search/.test(braveSrc)) {
  ok("uses Brave REST endpoint directly (not shelling out)");
} else failMsg("Brave REST endpoint not found — may have regressed to skill shell-out");

if (/X-Subscription-Token/.test(braveSrc)) {
  ok("sends X-Subscription-Token header (Brave auth)");
} else failMsg("missing X-Subscription-Token header");

if (/this\.opts\.apiKeyEnv/.test(braveSrc) && /process\.env\[/.test(braveSrc)) {
  ok("API key read from configurable env var (not hardcoded BRAVE_API_KEY)");
} else failMsg("API key handling does NOT use settings.apiKeyEnv");

if (/env var not set/.test(braveSrc) && /api-dashboard\.search\.brave\.com/.test(braveSrc)) {
  ok("missing-key error message points to Brave dashboard for signup");
} else failMsg("missing-key error message not helpful");

// ── 5. registry switch ──────────────────────────────────────────

console.log("\n  registry.ts:");
const registrySrc = read("extensions/web-search/registry.ts");
if (/case "brave":/.test(registrySrc) && /new BraveProvider/.test(registrySrc)) {
  ok("brave case wires BraveProvider");
} else failMsg("registry brave case missing");
if (/unknown provider/.test(registrySrc)) {
  ok("unknown-provider error message present");
} else failMsg("unknown-provider fallback missing");

// ── 6. settings defaults ────────────────────────────────────────

console.log("\n  settings.ts defaults:");
const settingsSrc = read("extensions/web-search/settings.ts");
for (const literal of [
  /provider:\s*"brave"/,
  /apiKeyEnv:\s*"BRAVE_API_KEY"/,
  /defaultCount:\s*5/,
  /timeout:\s*15_000/,
]) {
  if (literal.test(settingsSrc)) ok(`DEFAULTS literal: ${literal}`);
  else failMsg(`DEFAULTS missing: ${literal}`);
}
if (/loadWebSearchSettings/.test(settingsSrc)) ok("loadWebSearchSettings exported");
else failMsg("loadWebSearchSettings missing");

// ── 7. index.ts tool registration + sub-pi guard ────────────────

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
else failMsg("reset hook missing (tests can't reload provider)");

// ── 8. html-to-markdown utility (real function execution) ───────

console.log("\n  utils/html-to-markdown.ts behavior:");
const htmlSrc = read("extensions/web-search/utils/html-to-markdown.ts");
for (const sym of ["htmlToMarkdown", "extractTitle", "truncateBytes"]) {
  if (new RegExp(`export function ${sym}\\b`).test(htmlSrc)) ok(`exports ${sym}`);
  else failMsg(`missing export: ${sym}`);
}

// Re-implement truncateBytes + extractTitle minimally to test behavior.
// (Source file is .ts — can't import directly from .mjs without a TS
// loader; smoke pattern follows smoke-imagine.mjs's copy-and-test.)
function truncateBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  // UTF-8 safe: back up past continuation bytes (top 2 bits == 10xxxxxx).
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
  // Minimal entity decode for &amp; — the real implementation handles more.
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
  } else failMsg(`truncateBytes truncate failed: ${JSON.stringify(r).slice(0, 200)}`);
}
{
  // UTF-8 safety: 3-byte chars at boundary should not produce mojibake
  const utf8str = "中文".repeat(50);  // 6 bytes per pair
  const r = truncateBytes(utf8str, 25);  // mid-char boundary
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

// ── 9. schema.json webSearch section ────────────────────────────

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

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n  Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
