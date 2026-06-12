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
  // Assert the DEFAULT constants, not resolveSettings() — the latter reflects
  // the LIVE project config. Model refs must stay out of code defaults and be
  // provided by pi-astack-settings.json.
  const r = { pathA: settings.DEFAULT_PATH_A_SETTINGS };
  check("pathA.enabled default true", r.pathA.enabled === true);
  check("pathA.queryRewriterModel default empty", r.pathA.queryRewriterModel === "");
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

// Redirect ABRAIN_ROOT (the canonical abrain-home env) to a tmpdir so the
// ledger doesn't pollute the real user home.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-path-a-"));
const origHome = process.env.ABRAIN_ROOT;
process.env.ABRAIN_ROOT = tmpHome;

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
  if (origHome === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = origHome;
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
  const r = await rewriter.rewriteUserMessageToSearchQuery("", [], { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, { queryRewriterModel: "provider-a/model-a", queryRewriterTimeoutMs: 15000 });
  check("empty msg + empty history → useful=false fast-path",
    r.useful === false && r.reason === "empty_input");
}
// Very short msg + no history → fast-path skip
{
  const r = await rewriter.rewriteUserMessageToSearchQuery("ok", [], { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, { queryRewriterModel: "provider-a/model-a", queryRewriterTimeoutMs: 15000 });
  check("3-char msg + no history → useful=false",
    r.useful === false && r.reason === "input_too_short_no_history");
}
// Short msg + WITH history → no fast-path skip (history may disambiguate)
{
  // Will fail at "model not found" because we give bogus registry, but the
  // important thing is it didn't short-circuit at input length.
  const r = await rewriter.rewriteUserMessageToSearchQuery("继续", [{role:"user",text:"用 pnpm 不是挑吗"},{role:"assistant",text:"是的..."}], { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false }) }, { queryRewriterModel: "provider-a/model-a", queryRewriterTimeoutMs: 15000 });
  check("short msg + history → not short-circuited",
    r.useful === false && r.reason !== "input_too_short_no_history" && r.history_turn_count === 2);
}

// ────────────────────────────────────────────────────────────────
console.log("\n[5] llm-search Stage 2 verdict parsing");
const search = jiti(path.join(repoRoot, "extensions/memory/llm-search.ts"));
check("llmSearchEntries exported", typeof search.llmSearchEntries === "function");
check("llmSearchEntriesWithVerdict exported", typeof search.llmSearchEntriesWithVerdict === "function");

// resultCard projection: lock that it intentionally does NOT include
// compiledTruth (search tool API contract), which is why path-A injector
// must hydrate via entry slug lookup. If a future refactor accidentally
// adds compiledTruth to resultCard, that's a leak of full body to all
// memory_search tool consumers — NOT what we want. This assertion locks
// the contract.
//
// We can't directly export resultCard (it's private), so we test via the
// behavior: spy that llmSearchEntries result shape, when normally returned
// by mock pipeline, doesn't carry compiledTruth as a top-level field.
// Since we can't run real search without LLM, we settle for source check.
const llmSearchSource = fs.readFileSync(path.join(repoRoot, "extensions/memory/llm-search.ts"), "utf-8");
check("resultCard intentionally omits compiledTruth (search tool contract)",
  !/function resultCard[\s\S]*?compiledTruth/.test(llmSearchSource));
check("Stage 1 candidate selector uses full-body v3 surface (F18)",
  /STAGE1_CANDIDATE_SURFACE = "full_body_v3"/.test(llmSearchSource) &&
  /function entryForStage1[\s\S]*?##### compiled_truth[\s\S]*?##### timeline/.test(llmSearchSource) &&
  /surface:\$\{STAGE1_CANDIDATE_SURFACE\}/.test(llmSearchSource));
check("Stage 1 prompt instructs reading compiled_truth and timeline (F18)",
  /compiled_truth, and timeline before selecting candidates/.test(llmSearchSource) &&
  /body evidence \(compiled_truth\/timeline\)/.test(llmSearchSource));
check("search metrics record stage1_surface for before\/after comparison (F18)",
  /stage1_surface: STAGE1_CANDIDATE_SURFACE/.test(llmSearchSource));

// ────────────────────────────────────────────────────────────────
console.log("\n[6] inject block must hydrate compiledTruth from entries (bug fix lock)");
// GPT-5.5 3-T0 evaluation 2026-05-28 P0 bug: memory-context-injector
// previously read h.compiledTruth ?? h.body ?? "" off resultCard, which
// NEVER had compiledTruth. inject was emitting empty excerpts. Lock the
// fix at source level: injector must call entriesBySlug.get() to hydrate.
const injectorSource = fs.readFileSync(path.join(repoRoot, "extensions/memory/memory-context-injector.ts"), "utf-8");
check("injector imports MemoryEntry from ./types (not ./entries) — bug 1 fix",
  /import type \{ MemoryEntry \} from "\.\/types";/.test(injectorSource));
// LIVE-CAUGHT REGRESSION (2026-05-29): loadEntries was imported from ./decide,
// which does NOT export it (parser.ts does) → Path A errored at step 3
// ("_decide.loadEntries is not a function") on every real turn. The no-LLM
// smoke paths return BEFORE step 3 so this slipped. Lock the correct source.
check("injector imports loadEntries from ./parser (./decide has no loadEntries)",
  /import \{ loadEntries \} from "\.\/parser";/.test(injectorSource));
check("injector does NOT import loadEntries from ./decide (live runtime bug)",
  !/import \{ loadEntries \} from "\.\/decide";/.test(injectorSource));
check("injector hydrates hits via entriesBySlug.get() — bug 2 fix",
  /entriesBySlug = new Map\(entries\.map\(/.test(injectorSource) &&
  /fullEntry\.compiledTruth/.test(injectorSource));
check("injector has skipped_hit_hydration_empty failure path (defense in depth)",
  /skipped_hit_hydration_empty/.test(injectorSource));
check("injector buildInjectBlock no longer reads h.body fallback (post-fix cleanup)",
  !/h\.compiledTruth \?\? h\.body \?\? ""/.test(injectorSource));
check("path-A ledger search block records stage1_surface (F18 before/after comparison)",
  /stage1_surface: search\.stage1CandidateSurface/.test(injectorSource));

// ────────────────────────────────────────────────────────────────
console.log("\n[7] path-a-ledger carries ADR 0027 C6 causal anchor (ADR 0026 §5.1 join)");
const anchorMod = jiti(path.join(repoRoot, "extensions/_shared/causal-anchor.ts"));
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-path-a-anchor-"));
  // A DIFFERENT dir wired to the legacy ABRAIN_HOME var — it MUST be ignored
  // (canonical env is ABRAIN_ROOT). Proves the §5.1 co-location fix.
  const tmpBogusHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-path-a-bogus-"));
  const prevRoot = process.env.ABRAIN_ROOT;
  const prevHome = process.env.ABRAIN_HOME;
  process.env.ABRAIN_ROOT = tmpRoot;
  process.env.ABRAIN_HOME = tmpBogusHome;
  // device-id must resolve under the OVERRIDDEN abrain home, not real $HOME.
  anchorMod._resetDeviceIdCacheForTests?.();
  const tmpHome2 = tmpRoot;
  try {
    // Anchor SET (simulating a bound session mid-turn). State lives on a
    // globalThis Symbol singleton, so the injector's own causal-anchor
    // import reads the same state this smoke writes (jiti instances differ).
    anchorMod._setCurrentAnchorForTests("smoke-session-xyz", 7);
    const r = await injector.tryInjectRelevantMemoryContext("用 pnpm 还是 yarn?", { cwd: tmpHome2 });
    check("anchored: row carries session_id from getCurrentAnchor()", r.rowWritten.session_id === "smoke-session-xyz");
    check("anchored: row carries turn_id from getCurrentAnchor()", r.rowWritten.turn_id === 7);
    check("anchored: anchor_missing NOT set when anchor present", r.rowWritten.anchor_missing === undefined);

    // Anchor MISSING (pre-lifecycle): row still written, flagged (C5 fail-degrade).
    anchorMod._resetCausalAnchorForTests();
    const r2 = await injector.tryInjectRelevantMemoryContext("用 pnpm 还是 yarn?", { cwd: tmpHome2 });
    check("unanchored: row sets anchor_missing=true", r2.rowWritten.anchor_missing === true);
    check("unanchored: no session_id leaked", r2.rowWritten.session_id === undefined);
    check("unanchored: no turn_id leaked", r2.rowWritten.turn_id === undefined);

    // On-disk ledger reflects the anchored row → §5.1 join key realizable.
    const lp = path.join(tmpHome2, ".state", "memory", "path-a-ledger.jsonl");
    const rows = fs.readFileSync(lp, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    check("ledger has an anchored row with BOTH join keys (session_id+turn_id)",
      rows.some((row) => row.session_id === "smoke-session-xyz" && row.turn_id === 7));
    // §5.1 co-location (gpt-5.5 R2 P1): path-a-ledger AND device-id must both
    // resolve under ABRAIN_ROOT (same home as outcome-ledger), NOT the legacy
    // ABRAIN_HOME var, so the (session_id, turn_id) join surface stays under
    // one abrain home.
    check("device-id resolved under ABRAIN_ROOT, not real $HOME",
      fs.existsSync(path.join(tmpRoot, ".state", "device-id")));
    check("path-a-ledger lands under ABRAIN_ROOT (canonical home)",
      fs.existsSync(path.join(tmpRoot, ".state", "memory", "path-a-ledger.jsonl")));
    check("legacy ABRAIN_HOME is IGNORED (no ledger written under it)",
      !fs.existsSync(path.join(tmpBogusHome, ".state", "memory", "path-a-ledger.jsonl")));
  } finally {
    anchorMod._resetDeviceIdCacheForTests?.();
    anchorMod._resetCausalAnchorForTests();
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
    if (prevHome === undefined) delete process.env.ABRAIN_HOME;
    else process.env.ABRAIN_HOME = prevHome;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpBogusHome, { recursive: true, force: true }); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────
console.log("\n[8] prompt faithfulness: rewriter cost-bias stripped; aggregator stale text dropped");
{
  const qrSrc = fs.readFileSync(path.join(repoRoot, "extensions/memory/prompts/query-rewriter-v2.md"), "utf-8");
  check("rewriter: 'Over-extraction is success' cost-bias removed", !/Over-extraction is success/.test(qrSrc));
  check("rewriter: 'Wasting stage-2 cost' skip-framing removed", !/Wasting stage-2 cost/.test(qrSrc));
  check("rewriter: explicit cost-not-a-constraint direction present",
    /cost\s+is NOT a criterion/i.test(qrSrc) || /retrieval cost is not a constraint/i.test(qrSrc));
  check("rewriter: legitimate useful=false cases still documented",
    /pure\s+acks?/i.test(qrSrc) && /no\s+(?:searchable|retrievable)\s+(?:historical\s+)?intent/i.test(qrSrc));

  const aggSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/prompts/aggregator-skeptical-historian-v1.md"), "utf-8");
  check("aggregator: stale 'archive-reactivation reviewer ... NOT implemented' removed",
    !/archive-reactivation reviewer \(ADR 0025 §4\.6\) NOT implemented/.test(aggSrc));
}

// ────────────────────────────────────────────────────────────────
console.log("\n[9] causal-anchor: multi-binder + per-turn idempotent bump (LIVE anchor_missing fix)");
{
  anchorMod._resetCausalAnchorForTests();
  // Fake pi capturing handlers per event name.
  const handlers = { session_start: [], before_agent_start: [], agent_end: [] };
  const fakePi = { on(evt, fn) { (handlers[evt] ||= []).push(fn); } };
  // Two extensions (e.g. dispatch + memory) BOTH call bindLifecycle. Unlike
  // the old first-only guard, EVERY call now registers — so a consumer can
  // register its own bump ahead of its reader. Double-counting is prevented
  // at FIRE time by the per-turn flag, not at registration time.
  anchorMod.bindLifecycle(fakePi);
  anchorMod.bindLifecycle(fakePi);
  check("multi-binder: 2 binds register 2 before_agent_start bump handlers", handlers.before_agent_start.length === 2);
  check("multi-binder: agent_end reset handler registered", handlers.agent_end.length === 2);
  const fakeCtx = { sessionManager: { getSessionId: () => "sess-lifecycle" } };
  handlers.session_start.forEach((h) => h(null, fakeCtx));
  // One turn fires BOTH bump handlers; per-turn flag → only the first counts.
  handlers.before_agent_start.forEach((h) => h(null, fakeCtx));
  const a = anchorMod.getCurrentAnchor();
  check("per-turn idempotent: 2 bump handlers in one turn → turn_id 0 (not 2)",
    !!a && a.session_id === "sess-lifecycle" && a.turn_id === 0);
  // Next turn: agent_end resets the flag, then before_agent_start → exactly +1.
  handlers.agent_end.forEach((h) => h(null, fakeCtx));
  handlers.before_agent_start.forEach((h) => h(null, fakeCtx));
  check("next turn (after agent_end reset) → turn_id 1 (single bump)", anchorMod.getCurrentAnchor().turn_id === 1);
  // Without an agent_end reset, re-firing before_agent_start must NOT bump.
  handlers.before_agent_start.forEach((h) => h(null, fakeCtx));
  check("same-turn re-fire (no agent_end) does NOT bump", anchorMod.getCurrentAnchor().turn_id === 1);
  anchorMod._resetCausalAnchorForTests();
}

// Source-order contract: memory/index.ts must call bindLifecycle BEFORE
// wiring the Path A before_agent_start handler, so the turn-bump fires ahead
// of the Path A reader irrespective of cross-extension load order.
{
  const memIdxSrc = fs.readFileSync(path.join(repoRoot, "extensions/memory/index.ts"), "utf-8");
  const bindIdx = memIdxSrc.indexOf("bindCausalAnchorLifecycle(pi)");
  const pathAIdx = memIdxSrc.indexOf("Path A: always-on relevant-memory injection");
  check("memory/index.ts binds causal-anchor lifecycle before Path A handler",
    bindIdx > 0 && pathAIdx > 0 && bindIdx < pathAIdx);
}

// ────────────────────────────────────────────────────────────────
// [10] would have caught the LIVE anchor_missing bug. It loads the REAL
// memory extension, simulates dispatch binding the anchor lifecycle FIRST
// (the live condition that made memory's bind a no-op under the old
// registration guard), then fires memory's before_agent_start handlers in
// registration order and asserts the Path A ledger row carries the anchor.
console.log("\n[10] LIVE end-to-end: dispatch-binds-first, memory Path A still resolves the anchor");
{
  anchorMod._resetCausalAnchorForTests();
  const memMod = jiti(path.join(repoRoot, "extensions/memory/index.ts"));
  const memoryExt = memMod.default ?? memMod;
  // (a) dispatch binds the anchor lifecycle FIRST (separate pi).
  const dispatchEvt = {};
  anchorMod.bindLifecycle({ on(e, fn) { (dispatchEvt[e] ||= []).push(fn); } });
  // (b) memory activates (separate pi); capture its handlers in reg order.
  const memEvt = {};
  const memPi = {
    on(e, fn) { (memEvt[e] ||= []).push(fn); },
    registerTool() {},
    registerCommand() {},
  };
  const tmpH = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-e2e-anchor-"));
  const prevR = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = tmpH;
  try {
    memoryExt(memPi);
    const ctx = { sessionManager: { getSessionId: () => "e2e-sess" }, modelRegistry: undefined, cwd: tmpH };
    // session_start fires on all extensions.
    (dispatchEvt.session_start || []).forEach((h) => h({}, ctx));
    (memEvt.session_start || []).forEach((h) => h({}, ctx));
    // Fire MEMORY's before_agent_start handlers in registration order — under
    // the fix this is [memoryBump, footnote, pathA]; the OLD guard would have
    // left memory with [footnote, pathA] (bump only on dispatch's pi) and the
    // ledger row would be anchor_missing.
    for (const h of (memEvt.before_agent_start || [])) {
      await h({ systemPrompt: "", prompt: "用 pnpm 还是 yarn?" }, ctx);
    }
    const lp = path.join(tmpH, ".state", "memory", "path-a-ledger.jsonl");
    const rows = fs.readFileSync(lp, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const last = rows[rows.length - 1];
    check("LIVE: Path A ledger row carries session_id (memory's own bump fired before its reader)",
      last.session_id === "e2e-sess", JSON.stringify(last));
    check("LIVE: Path A ledger row carries turn_id 0", last.turn_id === 0, JSON.stringify(last));
    check("LIVE: Path A row is NOT anchor_missing (the bug)", last.anchor_missing === undefined, JSON.stringify(last));
  } finally {
    if (prevR === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevR;
    anchorMod._resetCausalAnchorForTests();
    try { fs.rmSync(tmpH, { recursive: true, force: true }); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────
console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log("FAILURES — investigate before commit");
  process.exit(1);
}
process.exit(0);
