#!/usr/bin/env node
/**
 * Smoke: aggregator-llm.ts unit coverage for parseAggregatorOutput +
 * buildAggregatorPromptInput + loadAggregatorPrompt (ADR 0025 §4.3
 * Phase C.2, round-2 review Opus P1-4 follow-up).
 *
 * Why this exists: aggregator-llm.ts is 360 LOC with tolerant JSON
 * parsing that defaults missing fields and normalizes unknown enum
 * values. Real LLM outputs at runtime tend to vary — fenced vs bare
 * JSON, missing optional fields, extra prose around the JSON block.
 * Without unit coverage, a future refactor could silently lose
 * tolerance and start losing real LLM outputs to the degraded path.
 *
 * Approach: build an in-process test harness that imports
 * aggregator-llm via jiti (same loader pi uses at runtime) and
 * exercises parseAggregatorOutput / buildAggregatorPromptInput /
 * loadAggregatorPrompt against a fixture set covering:
 *
 *   - bare JSON
 *   - fenced ```json ... ``` JSON
 *   - JSON wrapped in surrounding prose
 *   - partial JSON (missing optional fields)
 *   - JSON with unknown severity / status enum values
 *   - empty arrays
 *   - completely malformed JSON (must throw, caller turns into degraded)
 *
 * All assertions are pure JS, no network call, no LLM. Runs in <1s.
 */

import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(path.join(repoRoot, "extensions/sediment/aggregator-llm.ts"));

const mod = jiti(path.join(repoRoot, "extensions/sediment/aggregator-llm.ts"));
const { loadAggregatorPrompt, buildAggregatorPromptInput, parseAggregatorOutput } = mod;

const failures = [];
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push({ name, err: e });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

console.log("Smoke: aggregator-llm.ts parse/build/load unit coverage\n");

// ──────────────────────────────────────────────────────────────────
// loadAggregatorPrompt
// ──────────────────────────────────────────────────────────────────

console.log("loadAggregatorPrompt");

check("loadAggregatorPrompt returns non-empty string", () => {
  const p = loadAggregatorPrompt();
  if (typeof p !== "string" || p.length < 1000) {
    throw new Error(`expected non-empty prompt string, got ${typeof p} length=${p?.length}`);
  }
});

check("loadAggregatorPrompt contains expected ADR anchors", () => {
  const p = loadAggregatorPrompt();
  const required = [
    "REVERSE-ANCHOR",
    "Schema is INFRA serialization",
    "skeptical historian",
    "INV-INVISIBILITY",
    "structural_context",
    "outcome_counterfactual_excerpts",
    "p15_watchdog_signals",
  ];
  for (const anchor of required) {
    if (!p.includes(anchor)) {
      throw new Error(`prompt missing required anchor: "${anchor}"`);
    }
  }
});

check("loadAggregatorPrompt is idempotent (cached)", () => {
  const p1 = loadAggregatorPrompt();
  const p2 = loadAggregatorPrompt();
  if (p1 !== p2) throw new Error("prompt cache should return identical reference");
});

// ──────────────────────────────────────────────────────────────────
// buildAggregatorPromptInput
// ──────────────────────────────────────────────────────────────────

console.log("\nbuildAggregatorPromptInput");

const minimalSummary = {
  ts: "2026-05-28T11:00:00.000+08:00",
  project_root: "/test/project",
  window_days: 30,
  audit: { rows_considered: 0, recent_rows: 0, operations: {}, skip_reasons: {}, error_like_count: 0 },
  outcome: { rows_considered: 0, window_rows: 0, slugs_seen: 0, high_unused: [], echo_chamber_candidates: [] },
  staging: { total_files: 0, provisional_pending: 0, provisional_stale: 0, multiview_pending: 0, soft_archived: 0 },
  search: { metrics_rows: 0, recent_rows: 0, total_results: 0, zero_result_count: 0 },
  per_turn_cost: { rows_attributed: 0, rows_unattributed: 0, turns_considered: 0, estimated_tokens_histogram: [], top_burners: [], totals: { tokens_in: 0, tokens_out: 0, estimated_tokens: 0, operations: {} }, estimated_tokens_by_operation: {} },
  advisories: [],
};

check("buildAggregatorPromptInput starts with INPUT FEED header", () => {
  const out = buildAggregatorPromptInput(minimalSummary);
  if (!out.startsWith("# INPUT FEED")) {
    throw new Error(`expected to start with '# INPUT FEED', got: ${out.slice(0, 80)}`);
  }
});

check("buildAggregatorPromptInput contains JSON code fence", () => {
  const out = buildAggregatorPromptInput(minimalSummary);
  if (!/```json[\s\S]+```/m.test(out)) {
    throw new Error("output missing ```json ... ``` fence");
  }
});

check("buildAggregatorPromptInput projects only whitelisted feeds (no leaks)", () => {
  const summaryWithSecret = {
    ...minimalSummary,
    // simulate a hypothetical future field that should NOT leak
    _internal_secret: "this should not appear in prompt",
    advisories: [{ kind: "test", severity: "warning", message: "hello" }],
  };
  const out = buildAggregatorPromptInput(summaryWithSecret);
  if (out.includes("_internal_secret") || out.includes("this should not appear")) {
    throw new Error("buildAggregatorPromptInput leaked non-whitelisted summary fields");
  }
  if (!out.includes("mechanical_suspicion_signals")) {
    throw new Error("buildAggregatorPromptInput should rename advisories \u2192 mechanical_suspicion_signals");
  }
});

check("buildAggregatorPromptInput preserves all 9 declared feeds when present", () => {
  const fullSummary = {
    ...minimalSummary,
    raw_distribution: { total_slugs: 5 },
    structural_context: [{ id: "test", description: "test", causes_advisory: "staging_backlog" }],
    outcome_counterfactual_excerpts: [{ slug: "x", used: "decisive", counterfactual: "q", ts: "2026-05-28T00:00:00Z" }],
    prior_aggregator_runs: [{ ts: "2026-05-27T00:00:00Z", project_root: "/p", advisory_kinds: {}, total_advisories: 0 }],
    classifier_health: { ok: true, quoteRate: 0.95, alternativeRate: 0.9, concreteSelfCritiqueRate: 0.92, sampleSize: 40, windowSize: 50, threshold: 0.4, advisories: [] },
    p15_watchdog_signals: { pass1_op_not_synthesizable_count: 0, candidate_lost_count: 0, multi_view_metrics: { pass1_call_count: 0, pass2_call_count: 0, ok_rate: 0, distinct_device_ids: 0 }, multiview_pending_queue: { total: 0, oldest_age_days: 0, max_retry_attempts: 0 }, pass1_op_type_breakdown: {}, pass1_op_type_breakdown_available: true },
    evolution_hypotheses: { project_root: "/p", rows_considered: 1, matching_rows: 1, active_hypotheses: [{ key: "k::slug:s", kind: "k", slug: "s", status: "proposed", first_seen: "2026-05-27T00:00:00Z", last_seen: "2026-05-27T00:00:00Z", seen_count: 1, demoted_count: 0, acknowledgment_count: 0, withdrawn_count: 0 }], contested_hypotheses: [], withdrawn_hypotheses: [] },
  };
  const out = buildAggregatorPromptInput(fullSummary);
  const required = [
    "mechanical_suspicion_signals",
    "raw_distribution_summary",
    "outcome_counterfactual_excerpts",
    "structural_context",
    "prior_aggregator_summaries",
    "classifier_health_window",
    "per_turn_cost_rollup",
    "p15_watchdog_signals",
    "evolution_hypotheses",
  ];
  for (const feed of required) {
    if (!out.includes(feed)) {
      throw new Error(`required feed missing in prompt input: "${feed}"`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────
// parseAggregatorOutput
// ──────────────────────────────────────────────────────────────────

console.log("\nparseAggregatorOutput");

const fullExampleOutput = {
  promoted_advisories: [{
    kind: "test_kind",
    severity: "warning",
    slug: "test-slug",
    message: "test message",
    reasoning: "test reasoning",
    falsifier: "test falsifier",
    evidence_quotes: ["quote 1", "quote 2"],
  }],
  demoted_signals: [{ kind: "demoted_test", slug: "d-slug", key: "demoted_test::message:abc123abc123", reason: "demote reason" }],
  previous_acknowledgments: [{ kind: "ack_test", slug: "a-slug", key: "ack_test::message:def456def456", status: "still_acknowledged", reason: "ack reason" }],
  trend_observations: [{ dimension: "quote", current: 0.55, baseline: 1.0, delta: -0.45, interpretation: "drop detected" }],
  reasoning_quality_self_check: {
    silence_audit: [{ candidate: "silenced_kind", evidence_discounted: "evidence", reason_dropped: "reason" }],
    promotion_audit: [{ kind: "promoted_kind", slug: "p-slug", strongest_reason_not_to_promote: "weak evidence", why_still_promote: "still", anchor_evidence: "quote" }],
    falsifiers_named_count: 1,
    disagreements_with_prior_runs: 0,
    would_propose_if_no_praise: true,
  },
};

check("parseAggregatorOutput accepts bare JSON", () => {
  const r = parseAggregatorOutput(JSON.stringify(fullExampleOutput));
  if (r.promoted_advisories.length !== 1) throw new Error(`expected 1 promoted, got ${r.promoted_advisories.length}`);
  if (r.promoted_advisories[0].kind !== "test_kind") throw new Error("kind not preserved");
  if (r.demoted_signals[0].key !== "demoted_test::message:abc123abc123") throw new Error("demoted key not preserved");
  if (r.previous_acknowledgments[0].key !== "ack_test::message:def456def456") throw new Error("ack key not preserved");
  if (r.reasoning_quality_self_check.falsifiers_named_count !== 1) throw new Error("falsifiers count not preserved");
});

check("parseAggregatorOutput accepts ```json fenced", () => {
  const wrapped = "Some thinking...\n```json\n" + JSON.stringify(fullExampleOutput) + "\n```\nDone.";
  const r = parseAggregatorOutput(wrapped);
  if (r.promoted_advisories.length !== 1) throw new Error("fenced parse failed");
});

check("parseAggregatorOutput accepts JSON wrapped in surrounding prose", () => {
  const wrapped = "I considered the input... my answer is " + JSON.stringify(fullExampleOutput) + " That's all.";
  const r = parseAggregatorOutput(wrapped);
  if (r.promoted_advisories.length !== 1) throw new Error("prose-wrapped parse failed");
});

check("parseAggregatorOutput defaults missing arrays to []", () => {
  const r = parseAggregatorOutput('{"promoted_advisories": []}');
  if (!Array.isArray(r.demoted_signals) || r.demoted_signals.length !== 0) throw new Error("demoted_signals should default to []");
  if (!Array.isArray(r.previous_acknowledgments) || r.previous_acknowledgments.length !== 0) throw new Error("previous_acknowledgments should default to []");
  if (!Array.isArray(r.trend_observations) || r.trend_observations.length !== 0) throw new Error("trend_observations should default to []");
  if (!Array.isArray(r.reasoning_quality_self_check.silence_audit)) throw new Error("silence_audit should default to []");
  if (!Array.isArray(r.reasoning_quality_self_check.promotion_audit)) throw new Error("promotion_audit should default to []");
});

check("parseAggregatorOutput defaults missing scalars to safe values", () => {
  const r = parseAggregatorOutput("{}");
  if (r.reasoning_quality_self_check.falsifiers_named_count !== 0) throw new Error("falsifiers_named_count should default to 0");
  if (r.reasoning_quality_self_check.disagreements_with_prior_runs !== 0) throw new Error("disagreements should default to 0");
  if (r.reasoning_quality_self_check.would_propose_if_no_praise !== false) throw new Error("would_propose_if_no_praise should default to false");
});

check("parseAggregatorOutput normalizes unknown severity to 'warning'", () => {
  const out = { promoted_advisories: [{ kind: "k", severity: "EXTREME_DANGER", message: "m", reasoning: "r", falsifier: "f", evidence_quotes: [] }] };
  const r = parseAggregatorOutput(JSON.stringify(out));
  if (r.promoted_advisories[0].severity !== "warning") {
    throw new Error(`unknown severity should default to 'warning', got ${r.promoted_advisories[0].severity}`);
  }
});

check("parseAggregatorOutput preserves valid severity values", () => {
  for (const sev of ["info", "warning", "critical"]) {
    const r = parseAggregatorOutput(JSON.stringify({ promoted_advisories: [{ kind: "k", severity: sev, message: "m", reasoning: "r", falsifier: "f", evidence_quotes: [] }] }));
    if (r.promoted_advisories[0].severity !== sev) {
      throw new Error(`valid severity ${sev} not preserved, got ${r.promoted_advisories[0].severity}`);
    }
  }
});

check("parseAggregatorOutput normalizes unknown ack status to 'no_change'", () => {
  const out = { previous_acknowledgments: [{ kind: "k", status: "MAYBE", reason: "r" }] };
  const r = parseAggregatorOutput(JSON.stringify(out));
  if (r.previous_acknowledgments[0].status !== "no_change") {
    throw new Error(`unknown status should default to 'no_change', got ${r.previous_acknowledgments[0].status}`);
  }
});

check("parseAggregatorOutput coerces non-string evidence_quotes to []", () => {
  const out = { promoted_advisories: [{ kind: "k", severity: "warning", message: "m", reasoning: "r", falsifier: "f", evidence_quotes: [42, null, "valid"] }] };
  const r = parseAggregatorOutput(JSON.stringify(out));
  // Filter keeps only strings.
  if (r.promoted_advisories[0].evidence_quotes.length !== 1 || r.promoted_advisories[0].evidence_quotes[0] !== "valid") {
    throw new Error(`non-string evidence_quotes should be filtered, got ${JSON.stringify(r.promoted_advisories[0].evidence_quotes)}`);
  }
});

// ── M3: lifecycle_proposal (Outcome→Entry feedback edge) ──────────────────
check("parseAggregatorOutput preserves a valid lifecycle_proposal on a promoted advisory", () => {
  const out = { promoted_advisories: [{
    kind: "outcome_entry", severity: "warning", slug: "stale-entry", message: "m", reasoning: "r", falsifier: "f", evidence_quotes: ["q"],
    lifecycle_proposal: { op: "archive", reason: "affirm_superseded", independent_evidence: "superseded by newer active entry X", falsifier: "if X is itself archived" },
  }] };
  const r = parseAggregatorOutput(JSON.stringify(out));
  const lp = r.promoted_advisories[0].lifecycle_proposal;
  if (!lp || lp.op !== "archive" || lp.reason !== "affirm_superseded") throw new Error(`lifecycle_proposal not preserved: ${JSON.stringify(lp)}`);
  if (lp.independent_evidence !== "superseded by newer active entry X" || !lp.falsifier) throw new Error(`lifecycle_proposal fields lost: ${JSON.stringify(lp)}`);
});

check("parseAggregatorOutput DROPS a lifecycle_proposal missing §4.2 independent_evidence", () => {
  const out = { promoted_advisories: [{
    kind: "outcome_entry", severity: "warning", slug: "s", message: "m", reasoning: "r", falsifier: "f", evidence_quotes: [],
    lifecycle_proposal: { op: "archive", reason: "affirm_stale", independent_evidence: "   ", falsifier: "f" },
  }] };
  const r = parseAggregatorOutput(JSON.stringify(out));
  if (r.promoted_advisories[0].lifecycle_proposal !== undefined) {
    throw new Error("proposal without independent evidence must be dropped (no usage-only demotion)");
  }
});

check("parseAggregatorOutput DROPS a lifecycle_proposal with an invalid op/reason enum", () => {
  const badOp = { promoted_advisories: [{ kind: "outcome_entry", severity: "warning", slug: "s", message: "m", reasoning: "r", falsifier: "f", evidence_quotes: [], lifecycle_proposal: { op: "delete", reason: "affirm_stale", independent_evidence: "e", falsifier: "f" } }] };
  if (parseAggregatorOutput(JSON.stringify(badOp)).promoted_advisories[0].lifecycle_proposal !== undefined) throw new Error("invalid op must drop proposal (delete is never synthesizable)");
  const badReason = { promoted_advisories: [{ kind: "outcome_entry", severity: "warning", slug: "s", message: "m", reasoning: "r", falsifier: "f", evidence_quotes: [], lifecycle_proposal: { op: "archive", reason: "because_i_said_so", independent_evidence: "e", falsifier: "f" } }] };
  if (parseAggregatorOutput(JSON.stringify(badReason)).promoted_advisories[0].lifecycle_proposal !== undefined) throw new Error("invalid reason must drop proposal");
});

check("parseAggregatorOutput coerces numeric trend values", () => {
  const out = { trend_observations: [{ dimension: "x", current: "0.55", baseline: "1.0", delta: -0.45, interpretation: "i" }] };
  const r = parseAggregatorOutput(JSON.stringify(out));
  if (typeof r.trend_observations[0].current !== "number" || r.trend_observations[0].current !== 0.55) {
    throw new Error(`string numeric current should coerce, got ${r.trend_observations[0].current} (${typeof r.trend_observations[0].current})`);
  }
});

check("parseAggregatorOutput THROWS on completely malformed JSON (caller turns to degraded)", () => {
  let thrown = false;
  try {
    parseAggregatorOutput("this is not JSON at all { ] [ ] ; { }");
  } catch {
    thrown = true;
  }
  if (!thrown) throw new Error("malformed JSON should throw — caller relies on this to set degraded_to_mechanical");
});

check("parseAggregatorOutput THROWS on completely empty input", () => {
  let thrown = false;
  try {
    parseAggregatorOutput("");
  } catch {
    thrown = true;
  }
  if (!thrown) throw new Error("empty input should throw");
});

check("parseAggregatorOutput handles empty promoted_advisories (modal success case)", () => {
  const r = parseAggregatorOutput(JSON.stringify({
    promoted_advisories: [],
    demoted_signals: [],
    previous_acknowledgments: [],
    trend_observations: [],
    reasoning_quality_self_check: {
      silence_audit: [{ candidate: "considered_then_dropped", evidence_discounted: "evidence", reason_dropped: "noise" }],
      promotion_audit: [],
      falsifiers_named_count: 0,
      disagreements_with_prior_runs: 0,
      would_propose_if_no_praise: true,
    },
  }));
  if (r.promoted_advisories.length !== 0) throw new Error("modal success should preserve empty promoted_advisories");
  if (r.reasoning_quality_self_check.silence_audit.length !== 1) throw new Error("silence_audit array should be preserved");
});

// ──────────────────────────────────────────────────────────────────
// Wrap-up
// ──────────────────────────────────────────────────────────────────

console.log(`\nTotal: ${total}  Passed: ${total - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — aggregator-llm.ts parse/build/load contract drifted.");
  process.exit(1);
}
