#!/usr/bin/env node
/**
 * LIVE API smoke for the pi-astack web-search extension.
 *
 * This is NOT a mock: it reads the real ~/.pi/agent/pi-astack-settings.json
 * through the extension's own settings.ts loader and resolves API keys
 * through the same resolveSecret path the extension uses (webSearch.brave
 * / serper credential blocks; legacy webSearch.apiKey fallback). Requires
 * network access and live keys.
 *
 * It accepts the CURRENT configuration rather than hardcoding expectations:
 *   - the main provider is whatever webSearch.provider selects (tested via
 *     a real call);
 *   - the Serper backend is tested when serper credentials are configured;
 *   - one real shadow row is produced when shadow A/B is enabled.
 * Pass --dual to EXPLICITLY require the full Brave-main + Serper-shadow
 * A/B setup (brave + serper credentials AND shadow enabled with provider
 * serper, sampleRate > 0, logUrls=false); the check fails if the current
 * config does not match.
 *
 * Call budget: one real call per tested provider. Shadow row reuses the
 * Serper result in-memory (no extra HTTP). Use --serper-only to hit
 * Serper alone.
 *
 * Never prints API keys or full snippets. Output is provider, count,
 * latency, and a hostname/domain overview.
 *
 * Usage:
 *   node scripts/smoke-web-search-live.mjs "QUERY" [COUNTRY] [FRESHNESS]
 *   node scripts/smoke-web-search-live.mjs --dual "QUERY" [COUNTRY] [FRESHNESS]
 *   node scripts/smoke-web-search-live.mjs --serper-only "QUERY" [COUNTRY] [FRESHNESS]
 *
 * Default query/country: the current task's real research need, country US.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

const settingsMod = await jiti.import(path.join(repoRoot, "extensions/web-search/settings.ts"));
const registryMod = await jiti.import(path.join(repoRoot, "extensions/web-search/registry.ts"));
const shadowMod = await jiti.import(path.join(repoRoot, "extensions/web-search/shadow.ts"));

// ── CLI ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let serperOnly = false;
let dual = false;
while (args.length > 0 && args[0].startsWith("--")) {
  if (args[0] === "--serper-only") { serperOnly = true; args.shift(); }
  else if (args[0] === "--dual") { dual = true; args.shift(); }
  else {
    console.error(`unknown flag ${args[0]}`);
    process.exit(2);
  }
}
const query = args[0] ?? "pi coding agent ExtensionContext ctx.cwd custom tool";
const country = (args[1] ?? "US").toUpperCase();
const freshness = args[2] ?? undefined;
if (args.length > 3) {
  console.error(`usage: node scripts/smoke-web-search-live.mjs [--dual] [--serper-only] "QUERY" [COUNTRY] [FRESHNESS]`);
  process.exit(2);
}
if (serperOnly && dual) {
  console.error("--serper-only and --dual are mutually exclusive");
  process.exit(2);
}

let failed = false;
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed = true; console.log(`  ✗ ${msg}`); }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return "(unparseable)"; }
}
function overview(name, results, latencyMs) {
  const domains = [...new Set(results.map((r) => hostOf(r.url)))];
  console.log(`  ${String(name).padEnd(6)} count=${results.length} latency=${Math.round(latencyMs)}ms domains=${domains.join(", ")}`);
}

// ── Real settings + backends ───────────────────────────────────

console.log("\n  loading real settings (~/.pi/agent/pi-astack-settings.json):");
const settings = settingsMod.loadWebSearchSettings();
console.log(`  main provider: ${settings.provider}`);
console.log(`  brave.apiKey configured: ${settings.brave.apiKey !== ""}`);
console.log(`  serper.apiKey configured: ${settings.serper.apiKey !== ""}`);
console.log(`  shadow: enabled=${settings.shadow.enabled} provider=${settings.shadow.provider} sampleRate=${settings.shadow.sampleRate} logUrls=${settings.shadow.logUrls}`);

if (dual) {
  check(settings.provider === "brave", `--dual: main provider is brave (got ${settings.provider})`);
  check(settings.brave.apiKey !== "", "--dual: webSearch.brave.apiKey configured (command channel)");
  check(settings.serper.apiKey !== "", "--dual: webSearch.serper.apiKey configured (command channel)");
  check(settings.shadow.enabled && settings.shadow.provider === "serper" && settings.shadow.sampleRate > 0 && settings.shadow.logUrls === false,
    "--dual: shadow enabled: provider serper, sampleRate > 0, logUrls false (hash mode)");
}

const searchOpts = { count: 5, country, ...(freshness ? { freshness } : {}) };
console.log(`\n  query: ${JSON.stringify(query)} | country=${country}${freshness ? ` | freshness=${freshness}` : ""}`);

// ── Real main-provider call ────────────────────────────────────

let mainResults = [];
let mainLatencyMs = 0;
let mainName = settings.provider;
if (!serperOnly) {
  console.log(`\n  main provider "${settings.provider}" (real API):`);
  const mainBackend = registryMod.createSearchBackend(settings.provider, settings);
  const t0 = performance.now();
  mainResults = await mainBackend.search(query, searchOpts);
  mainLatencyMs = performance.now() - t0;
  // HTTP 2xx is implied: the backend throws on !response.ok, so a return
  // means success. Non-empty + legal URLs are asserted explicitly.
  assert(mainResults.length > 0, "main provider returned >= 1 result");
  assert(mainResults.every((r) => isHttpUrl(r.url)), "main URLs are legal http(s) URLs");
  overview(mainName, mainResults, mainLatencyMs);
}

// ── Real Serper call (when configured / --serper-only) ─────────

let serperResults = [];
let serperLatencyMs = 0;
const serperConfigured = settings.serper.apiKey !== "" || settings.serper.apiKeyEnv !== "";
if (serperOnly || dual || (serperConfigured && !serperOnly)) {
  console.log("\n  serper (real API):");
  const serper = registryMod.createSearchBackend("serper", settings);
  const t1 = performance.now();
  serperResults = await serper.search(query, searchOpts);
  serperLatencyMs = performance.now() - t1;
  assert(serperResults.length > 0, "serper returned >= 1 result");
  assert(serperResults.every((r) => isHttpUrl(r.url)), "serper URLs are legal http(s) URLs");
  overview("serper", serperResults, serperLatencyMs);
} else {
  console.log("\n  serper (skipped — not configured)");
}

// ── Real shadow row (logUrls=false) ────────────────────────────

console.log("\n  shadow row (logUrls=false, real Serper as shadow):");
if (settings.shadow.enabled && settings.shadow.provider === "serper" && serperResults.length > 0 && !serperOnly) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-web-search-live-"));
  try {
    const logPath = path.join(tmp, "shadow.jsonl");
    await shadowMod.runShadowSearch({
      query,
      callId: "live-smoke-call-id",
      opts: searchOpts,
      primaryName: mainName,
      shadow: { name: "serper", search: async (q, o) => serperResults },
      primaryResults: mainResults,
      primaryLatencyMs: mainLatencyMs,
      config: { provider: "serper", sampleRate: 1, logPath, logUrls: false },
      projectRoot: tmp,
    });
    const rawLog = fs.readFileSync(logPath, "utf8");
    const row = JSON.parse(rawLog.trim().split("\n").slice(-1)[0]);

    assert(row.primary.status === "ok" && row.shadow.status === "ok",
      "shadow row: primary + shadow both ok");
    assert(Number.isInteger(row.primary.resultCount) && row.primary.resultCount > 0,
      "shadow row: primary resultCount present");
    assert(Number.isInteger(row.shadow.resultCount) && row.shadow.resultCount > 0,
      "shadow row: shadow resultCount present");
    assert(Number.isInteger(row.overlap) && row.overlap >= 0 && row.overlap <= 10,
      "shadow row: top-k overlap present (0..10)");
    assert(Number.isInteger(row.effectiveTopK) && row.effectiveTopK <= 10,
      "shadow row: effectiveTopK present (<= 10)");
    check(true, `primary=${row.primary.status}/${row.primary.resultCount} shadow=${row.shadow.status}/${row.shadow.resultCount} overlap=${row.overlap} effectiveTopK=${row.effectiveTopK} (topK=${row.topK})`);

    // Privacy: raw query absent; a real snippet fragment absent; log row
    // fields are a strict whitelist (no key / body / error text / paths).
    assert(!rawLog.includes(query), "raw query NOT in shadow log");
    const sampleSnippet = (mainResults[0]?.snippet ?? "").slice(0, 60).trim();
    if (sampleSnippet) {
      assert(!rawLog.includes(sampleSnippet), "snippet fragment NOT in shadow log");
    }
    const allowed = new Set([
      "schemaVersion", "timestamp", "checksum", "queryHash", "callIdHash",
      "primaryProvider", "shadowProvider", "opts", "primary", "shadow",
      "topK", "effectiveTopK", "overlap",
      "primaryUrlHashes", "shadowUrlHashes", "primaryDomains", "shadowDomains",
    ]);
    for (const k of Object.keys(row)) {
      assert(allowed.has(k), `shadow log field "${k}" not in whitelist`);
    }
    assert(!rawLog.includes("X-API-KEY") && !rawLog.includes("X-Subscription-Token"),
      "no auth header names in shadow log");
    assert(Array.isArray(row.primaryDomains) && row.primaryDomains.length > 0,
      "primaryDomains present (authority analysis)");
    assert(row.primaryDomains.every((d) => typeof d === "string" && !d.includes("/") && !d.includes("?")),
      "domains carry no path/query");
    check(true, `primaryDomains (${row.primaryDomains.length}): ${[...new Set(row.primaryDomains)].join(", ")}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.log("  (skipped — shadow not enabled, or --serper-only mode)");
}

console.log(`\n  live smoke: ${failed ? "FAILED" : "PASSED"}`);
process.exit(failed ? 1 : 0);
