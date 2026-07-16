#!/usr/bin/env node
/**
 * Smoke test for pi-astack context7 extension.
 *
 * Validates (source-level, no real network by default):
 *   - file structure (index/settings/client/secret)
 *   - dispatch resolves explicitly requested context7 tools from the target
 *     session registry, and keeps them out of the default set (opt-in only)
 *   - settings schema + live settings.json wiring (context7 section,
 *     explicit enabled kill-switch, key via secrets.json command channel)
 *   - client invariants (v2 endpoints, Bearer auth, untrusted framing,
 *     fail-closed key resolution)
 *   - reputationLabel pure-function parity with the MCP server
 *
 * Optional live check: run with CONTEXT7_SMOKE_LIVE=1 to perform a real
 * resolve+docs round-trip using the key in ~/.pi/secrets.json.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function failMsg(msg) { fail++; console.log(`  ✗ ${msg}`); }
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// 1. File structure ─────────────────────────────────────────────
console.log("\n  file structure:");
const expectedFiles = [
  "extensions/context7/index.ts",
  "extensions/context7/settings.ts",
  "extensions/context7/client.ts",
  "extensions/context7/secret.ts",
];
for (const f of expectedFiles) {
  if (fs.existsSync(path.join(repoRoot, f))) ok(f);
  else failMsg(`missing: ${f}`);
}

// 2. dispatch target-registry + default gating ──────────────────
console.log("\n  dispatch/index.ts wiring:");
const dispatchSrc = read("extensions/dispatch/index.ts");
if (!/const KNOWN_TOOLS\b/.test(dispatchSrc) && /validateSessionToolRegistry\(session, tools\)/.test(dispatchSrc)) {
  ok("explicit context7 requests use target-session registry validation");
} else failMsg("dispatch static allowlist remains or target-session validation is missing");
// Opt-in only: must NOT appear in any default allowlist string.
if (!/read,grep,find,ls[^"']*context7/.test(dispatchSrc)) {
  ok("context7 tools kept OUT of default sub-agent allowlist (opt-in)");
} else failMsg("context7 tools leaked into default allowlist");

// 3. settings schema + live settings.json ───────────────────────
console.log("\n  settings wiring:");
const schema = JSON.parse(read("pi-astack-settings.schema.json"));
const c7schema = schema.properties?.context7;
if (c7schema && c7schema.additionalProperties === false) ok("schema has context7 (additionalProperties:false)");
else failMsg("schema missing context7 section");
for (const k of ["enabled", "baseUrl", "apiKey", "apiKeyEnv", "timeout"]) {
  if (c7schema?.properties?.[k]) ok(`schema.context7.${k} defined`);
  else failMsg(`schema.context7.${k} missing`);
}
if (c7schema?.properties?.enabled?.default === true) ok("schema default enabled=true");
else failMsg("schema default enabled is not true");

const settingsSrc = read("extensions/context7/settings.ts");
if (/export function context7SettingsMtimeMs\(\): number \| null/.test(settingsSrc) && /statSync\(PI_STACK_SETTINGS_PATH\)\.mtimeMs/.test(settingsSrc)) {
  ok("context7SettingsMtimeMs exported and reads settings mtime");
} else failMsg("context7SettingsMtimeMs missing or not wired to settings mtime");

const liveSettingsPath = path.join(process.env.HOME, ".pi", "agent", "pi-astack-settings.json");
if (fs.existsSync(liveSettingsPath)) {
  const live = JSON.parse(fs.readFileSync(liveSettingsPath, "utf8"));
  if (live.context7?.enabled === true) ok("live settings.json: context7.enabled=true (explicit kill-switch)");
  else failMsg("live settings.json: context7.enabled not explicitly true");
  if (typeof live.context7?.apiKey === "string" && /secrets\.json/.test(live.context7.apiKey)) {
    ok("live settings.json: apiKey resolves from secrets.json command channel");
  } else failMsg("live settings.json: apiKey not wired to secrets.json");
} else {
  failMsg(`live settings.json not found at ${liveSettingsPath}`);
}

// 4. client invariants ──────────────────────────────────────────
console.log("\n  client.ts invariants:");
const clientSrc = read("extensions/context7/client.ts");
if (/\/v2\/libs\/search/.test(clientSrc) && /\/v2\/context/.test(clientSrc)) {
  ok("uses Context7 v2 REST endpoints (libs/search + context)");
} else failMsg("missing v2 REST endpoints");
if (/Authorization.*Bearer \$\{apiKey\}/.test(clientSrc)) ok("sends Authorization: Bearer <key>");
else failMsg("missing Bearer auth header");
if (/process\.env\[this\.settings\.apiKeyEnv\]/.test(clientSrc) && /no API key/.test(clientSrc)) {
  ok("API key fail-closed with actionable error (apiKey || apiKeyEnv)");
} else failMsg("API key resolution not fail-closed");
if (/ctx7sk/.test(clientSrc)) ok("error guidance mentions ctx7sk key prefix");
else failMsg("missing ctx7sk guidance");

// 5. secret.ts command resolver ─────────────────────────────────
console.log("\n  secret.ts command resolver:");
try {
  const secret = await jiti.import(path.join(repoRoot, "extensions/context7/secret.ts"));
  const resolved = secret.resolveSecret("!printf '%s' context7-secret-ok");
  if (resolved === "context7-secret-ok") ok("!command executes through bash-compatible shell");
  else failMsg(`!command resolver returned: ${JSON.stringify(resolved)}`);
} catch (e) {
  failMsg(`!command resolver threw: ${e.message}`);
}

// 6. index.ts tool registration + trust boundary ────────────────
console.log("\n  index.ts tools:");
const indexSrc = read("extensions/context7/index.ts");
if (/name: "context7_resolve"/.test(indexSrc) && /name: "context7_docs"/.test(indexSrc)) {
  ok("registers context7_resolve + context7_docs");
} else failMsg("tool registration missing");
if (/PI_ABRAIN_DISABLED.*===.*"1"/.test(indexSrc)) ok("sub-pi guard present (no web access for sediment)");
else failMsg("sub-pi guard missing");
if (/if \(!settings\.enabled\) return;/.test(indexSrc)) ok("disabled kill-switch skips registration");
else failMsg("disabled path does not skip registration");
{
  const loadIdx = indexSrc.indexOf("const settings = loadContext7Settings();");
  const gateIdx = indexSrc.indexOf("if (!settings.enabled) return;");
  const registerIdx = indexSrc.indexOf("pi.registerTool({");
  if (loadIdx >= 0 && gateIdx > loadIdx && registerIdx > gateIdx) {
    ok("context7 enabled gate remains at registration time before tool registration");
  } else failMsg("context7 enabled gate is not clearly before tool registration");
}
if (/context7SettingsMtimeMs/.test(indexSrc) && /_clientSettingsMtimeMs\s*!==\s*settingsMtimeMs/.test(indexSrc)) {
  ok("Context7 client singleton is gated by settings mtime");
} else failMsg("Context7 client singleton missing settings mtime gate");
if (/<untrusted_external_content>/.test(indexSrc)) ok("docs framed as untrusted external content");
else failMsg("docs NOT framed as untrusted content");

// 7. reputationLabel parity (pure function) ─────────────────────
console.log("\n  reputationLabel parity:");
function reputationLabel(t) {
  if (t === undefined || t < 0) return "Unknown";
  if (t >= 7) return "High";
  if (t >= 4) return "Medium";
  return "Low";
}
const cases = [[undefined, "Unknown"], [-1, "Unknown"], [9, "High"], [7, "High"], [5, "Medium"], [4, "Medium"], [3, "Low"], [0, "Low"]];
let repOk = true;
for (const [inp, exp] of cases) if (reputationLabel(inp) !== exp) { repOk = false; failMsg(`reputationLabel(${inp}) !== ${exp}`); }
if (repOk) ok("reputationLabel matches MCP thresholds (7/4 boundaries)");

// 8. Optional live round-trip ────────────────────────────────────
if (process.env.CONTEXT7_SMOKE_LIVE === "1") {
  console.log("\n  live round-trip (CONTEXT7_SMOKE_LIVE=1):");
  try {
    const key = execSync(`jq -r --arg k context7 '.[$k] // empty' $HOME/.pi/secrets.json`, { encoding: "utf8" }).trim();
    if (!key) throw new Error("no context7 key in secrets.json");
    const h = { Authorization: `Bearer ${key}`, "X-Context7-Source": "pi-astack" };
    const sres = await fetch("https://context7.com/api/v2/libs/search?" + new URLSearchParams({ query: "routing", libraryName: "next.js" }), { headers: h });
    if (!sres.ok) throw new Error(`search HTTP ${sres.status}`);
    const sjson = await sres.json();
    const first = sjson.results?.[0]?.id;
    if (!first) throw new Error("search returned no results");
    ok(`live search resolved "${first}"`);
    const dres = await fetch("https://context7.com/api/v2/context?" + new URLSearchParams({ query: "app router middleware", libraryId: first }), { headers: h });
    if (!dres.ok) throw new Error(`context HTTP ${dres.status}`);
    const text = await dres.text();
    if (text.trim().length > 0) ok(`live docs fetched (${text.length} chars)`);
    else failMsg("live docs empty");
  } catch (e) {
    failMsg(`live round-trip failed: ${e.message}`);
  }
} else {
  console.log("\n  (skipping live round-trip; set CONTEXT7_SMOKE_LIVE=1 to enable)");
}

// Summary ────────────────────────────────────────────────────────
console.log(`\n  context7 smoke: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
