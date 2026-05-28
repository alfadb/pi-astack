#!/usr/bin/env node
/**
 * smoke-memory-path-a — unit smoke for ADR 0026 path A (2026-05-28
 * §3.1 walk-back). Covers:
 *
 *   1. parseRewriterOutput — tolerant JSON parsing of query-rewriter
 *      LLM output (bare / fenced / prose-wrapped / malformed)
 *   2. settings.pathA — default resolution + override merging
 *   3. memory-context-injector — outcome paths without real LLM:
 *      - skipped_disabled
 *      - skipped_no_model_registry
 *      - skipped_invalid_model_registry
 *
 * 不打实际 LLM (rewriter / search) — 那些是 dogfood 信号,通过 path-a-ledger
 * 在真实 pi 运行时收集; unit smoke 只锁 deterministic logic.
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`);
  }
}

// ────────────────────────────────────────────────────────────────
console.log("\n[1] parseRewriterOutput");
const rewriter = jiti(path.join(repoRoot, "extensions/memory/query-rewriter.ts"));

// bare JSON: useful=false
{
  const r = rewriter.parseRewriterOutput('{"useful": false, "reason": "pure ack"}');
  check("bare JSON useful=false", r.useful === false && r.reason === "pure ack");
}
// bare JSON: useful=true with query
{
  const r = rewriter.parseRewriterOutput('{"useful": true, "query": "pnpm vs yarn for monorepo"}');
  check("bare JSON useful=true", r.useful === true && r.query === "pnpm vs yarn for monorepo");
}
// fenced JSON
{
  const r = rewriter.parseRewriterOutput('```json\n{"useful": true, "query": "React Router v6 vs v7"}\n```');
  check("fenced JSON", r.useful === true && r.query.includes("React Router"));
}
// prose-wrapped JSON
{
  const r = rewriter.parseRewriterOutput('Sure, here is the result:\n\n{"useful": false, "reason": "no intent"}\n\nThat is all.');
  check("prose-wrapped JSON", r.useful === false && r.reason === "no intent");
}
// useful=true but query too short → downgrade to useful=false
{
  const r = rewriter.parseRewriterOutput('{"useful": true, "query": "ab"}');
  check("useful=true short query → false", r.useful === false && r.reason === "llm_marked_useful_but_query_too_short");
}
// useful=true but missing query
{
  const r = rewriter.parseRewriterOutput('{"useful": true}');
  check("useful=true missing query → false", r.useful === false);
}
// useful field missing entirely → treat as false
{
  const r = rewriter.parseRewriterOutput('{"foo": "bar"}');
  check("missing useful → false", r.useful === false);
}
// completely malformed
{
  const r = rewriter.parseRewriterOutput("not even close to json");
  check("malformed → false with reason", r.useful === false && r.reason.startsWith("json_parse_failure"));
}
// empty
{
  const r = rewriter.parseRewriterOutput("");
  check("empty → false", r.useful === false && r.reason === "empty_llm_output");
}
// long query gets capped (v2 raised cap to 2000)
{
  const longQuery = "x".repeat(2500);
  const r = rewriter.parseRewriterOutput(`{"useful": true, "query": "${longQuery}"}`);
  check("v2: long query capped to ≤2001", r.useful === true && r.query.length <= 2001);
}
// medium query (in v2 sweet spot) not truncated
{
  const midQuery = "x".repeat(500);
  const r = rewriter.parseRewriterOutput(`{"useful": true, "query": "${midQuery}"}`);
  check("v2: 500-char query not truncated", r.useful === true && r.query.length === 500);
}
// JSON with extra fields ignored
{
  const r = rewriter.parseRewriterOutput('{"useful": true, "query": "select database", "extra_field": "ignored"}');
  check("extra fields ignored", r.useful === true && r.query === "select database");
}

// ──────────────────────────────────────────────────────────────
console.log("\n[2] settings.pathA defaults");
const settings = jiti(path.join(repoRoot, "extensions/memory/settings.ts"));
{
  const r = settings.resolveSettings();
  check("pathA.enabled default true", r.pathA.enabled === true);
  check("pathA.queryRewriterModel default flash", r.pathA.queryRewriterModel === "deepseek/deepseek-v4-flash");
  check("pathA.queryRewriterTimeoutMs default 15000", r.pathA.queryRewriterTimeoutMs === 15000);
  check("pathA.historyMaxTurns default 4", r.pathA.historyMaxTurns === 4);
  check("pathA.historyMaxCharsPerTurn default 2000", r.pathA.historyMaxCharsPerTurn === 2000);
  check("pathA.searchLimit default 5", r.pathA.searchLimit === 5);
  check("pathA.injectMaxEntries default 5", r.pathA.injectMaxEntries === 5);
  check("pathA.entryExcerptChars default 800", r.pathA.entryExcerptChars === 800);
}

// ────────────────────────────────────────────────────────────────
console.log("\n[3] memory-context-injector outcomes (no-LLM paths)");
const injector = jiti(path.join(repoRoot, "extensions/memory/memory-context-injector.ts"));

// Build a fake SessionManager-shape for history extraction smoke (no real pi).
const fakeSessionManager = {
  buildSessionContext() {
    return {
      messages: [
        { role: "user", content: "帮我看 sediment 这个模块的架构" },
        { role: "assistant", content: [{ type: "text", text: "sediment 有 6 条能力点..." }] },
        { role: "tool", content: "<irrelevant>" },  // should be filtered out
        { role: "user", content: "改成异步行不行" },
        { role: "assistant", content: [{ type: "text", text: "可以，但你要考虑..." }] },
        // current-user duplicate (should be deduped):
        { role: "user", content: "改成异步行不行" },
      ],
    };
  },
};

// Redirect ABRAIN_HOME to a tmpdir so ledger doesn't pollute real user home.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-path-a-"));
const origHome = process.env.ABRAIN_HOME;
process.env.ABRAIN_HOME = tmpHome;

try {
  // outcome: skipped_no_model_registry (ctx.modelRegistry undefined)
  {
    const r = await injector.tryInjectRelevantMemoryContext("用 pnpm 还是 yarn?", { cwd: tmpHome });
    check("skipped_no_model_registry outcome", r.rowWritten.outcome === "skipped_no_model_registry");
    check("no inject block returned", !r.block);
  }
  // outcome: skipped_invalid_model_registry + history extraction wired
  {
    const r = await injector.tryInjectRelevantMemoryContext("改成异步行不行", {
      cwd: tmpHome,
      modelRegistry: { wat: "no .find / .getApiKeyAndHeaders" },
      sessionManager: fakeSessionManager,
    });
    check("skipped_invalid_model_registry outcome", r.rowWritten.outcome === "skipped_invalid_model_registry");
  }
  // Verify ledger rows actually written
  const ledgerPath = path.join(tmpHome, ".state", "memory", "path-a-ledger.jsonl");
  const ledgerExists = fs.existsSync(ledgerPath);
  check("ledger file created", ledgerExists);
  if (ledgerExists) {
    const lines = fs.readFileSync(ledgerPath, "utf-8").split("\n").filter(l => l.trim());
    check("ledger has ≥2 rows", lines.length >= 2);
    const lastRow = JSON.parse(lines[lines.length - 1]);
    check("ledger row schema (ts/outcome/inject_id)",
      typeof lastRow.ts === "string" &&
      typeof lastRow.outcome === "string" &&
      typeof lastRow.inject_id === "string" &&
      lastRow.inject_id.startsWith("path-a-"));
    // The second row (sessionManager + history) should have history_turn_count.
    // history has 4 user/assistant turns after filtering tool + deduping last user.
    check("v2: ledger row carries history_turn_count",
      typeof lastRow.history_turn_count === "number");
    check("v2: history_turn_count > 0 with fake session",
      lastRow.history_turn_count > 0);
    // Filtered: tool role excluded; deduped: last 'user' matching current prompt excluded.
    // So expected ≤ 5 (3 user + 2 assistant, last user deduped → 4 turns) capped to historyMaxTurns=4.
    check("v2: history_turn_count ≤ historyMaxTurns=4",
      lastRow.history_turn_count <= 4);
  }
} finally {
  if (origHome === undefined) delete process.env.ABRAIN_HOME;
  else process.env.ABRAIN_HOME = origHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
console.log("\n[4] rewriter v2 signature: history is required positional arg");
// Smoke that signature changed: 2nd positional is history array.
// We don't actually call LLM here (no model registry needed for static
// shape check). Just ensure the function expects 5 args.
check("rewriter accepts 5 args (msg, history, registry, settings, signal?)",
  rewriter.rewriteUserMessageToSearchQuery.length >= 4);
// Empty history + empty message should fast-path with no LLM call.
{
  const r = await rewriter.rewriteUserMessageToSearchQuery("", [], { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, { queryRewriterModel: "deepseek/deepseek-v4-flash", queryRewriterTimeoutMs: 15000 });
  check("empty msg + empty history → useful=false fast-path",
    r.useful === false && r.reason === "empty_input");
}
// Very short msg + no history → fast-path skip
{
  const r = await rewriter.rewriteUserMessageToSearchQuery("ok", [], { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, { queryRewriterModel: "deepseek/deepseek-v4-flash", queryRewriterTimeoutMs: 15000 });
  check("3-char msg + no history → useful=false",
    r.useful === false && r.reason === "input_too_short_no_history");
}
// Short msg + WITH history → no fast-path skip (history may disambiguate)
{
  // Will fail at "model not found" because we give bogus registry, but the
  // important thing is it didn't short-circuit at input length.
  const r = await rewriter.rewriteUserMessageToSearchQuery("继续", [{role:"user",text:"用 pnpm 不是挑吗"},{role:"assistant",text:"是的..."}], { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, { queryRewriterModel: "deepseek/deepseek-v4-flash", queryRewriterTimeoutMs: 15000 });
  check("short msg + history → not short-circuited",
    r.useful === false && r.reason !== "input_too_short_no_history" && r.history_turn_count === 2);
}

// ────────────────────────────────────────────────────────────────
console.log("\n[5] llm-search Stage 2 verdict parsing");
const search = jiti(path.join(repoRoot, "extensions/memory/llm-search.ts"));
// Note: parseFinalPicksWithVerdict is internal, but we test the API
// surface: llmSearchEntries (legacy hits-only) AND verdict via
// llmSearchEntriesWithVerdict are exported. Their internal parse path
// is the same.
check("llmSearchEntries exported", typeof search.llmSearchEntries === "function");
check("llmSearchEntriesWithVerdict exported", typeof search.llmSearchEntriesWithVerdict === "function");

// ────────────────────────────────────────────────────────────────
console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log("FAILURES — investigate before commit");
  process.exit(1);
}
process.exit(0);
