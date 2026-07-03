#!/usr/bin/env node
/**
 * Smoke: ADR 0027 §C5 v1 dispatch audit row schema integration
 *
 * Locks the actual on-disk audit row contract that dispatch_agent and
 * dispatch_parallel produce. This is the integration counterpart to
 * smoke-c5-terminal-state.mjs (which tests pure helpers only).
 *
 * R6 fix: this smoke was missing — Opus P1-4 + DeepSeek NIT-3 + GPT-5.5
 * P2-2 all flagged that the v1 contract should be locked at the audit
 * row level, not just the helper function level.
 *
 * Strategy: parse `extensions/dispatch/index.ts` as text to verify
 * structural invariants of each audit-write site. This is source-level
 * static analysis, not a runtime mock — chosen because actually running
 * dispatch requires real LLM + pi runtime + AgentSession. The source
 * grep is sufficient to catch the regression classes Opus P1-4 listed:
 *
 *   1. Reordering ...tsFields and failure_type so one stomps the other
 *   2. Dropping ...tsFields from one audit site but keeping in another
 *   3. aggregateAnchor.subturn=0 and sub_agent_label being refactored away
 *   4. audit_version: 3 bump being silently rolled back
 *   5. PR-C heartbeat trace enrichment missing from v3 audit rows
 *   6. PR-C per-file audit singleFlight chain missing from append path
 *
 * Each invariant is asserted by reading the file and grepping for the
 * exact code shape; refactors that change the shape MUST update this
 * smoke to keep the v1 contract explicit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const dispatchSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/dispatch/index.ts"),
  "utf-8",
);
const tsSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/dispatch/terminal-state.ts"),
  "utf-8",
);

console.log("Section: audit version bump");

check("DISPATCH_AUDIT_VERSION = 3 (Stage 1c heartbeat enrichment)", () => {
  if (!/const DISPATCH_AUDIT_VERSION = 3;/.test(dispatchSrc)) {
    throw new Error("expected DISPATCH_AUDIT_VERSION = 3; v3 adds heartbeat_trace_path enrichment");
  }
});

check("appendDispatchAudit serializes per-file writes through singleFlight", () => {
  const expected = [
    /Symbol\.for\("pi-astack\/dispatch\/audit-singleflight\/v1"\)/,
    /const prior = chains\.get\(auditPath\) \?\? Promise\.resolve\(\)/,
    /const next = prior\.catch\(\(\) => \{\}\)\.then\(async \(\) => \{/,
    /if \(chains\.get\(auditPath\) === next\) chains\.delete\(auditPath\)/,
  ];
  for (const re of expected) {
    if (!re.test(dispatchSrc)) throw new Error(`dispatch audit singleFlight invariant missing: ${re}`);
  }
});

check("ADR strict scope: TerminalStateFields documents field scope", () => {
  // The terminal-state.ts header documents which fields apply to which state.
  const expectedDocs = [
    /failed.*\breason\b.*rollback_done/s,
    /degraded.*what_dropped.*alt_path/s,
    /cancelled.*cancel_source.*cleanup_done/s,
  ];
  for (const re of expectedDocs) {
    if (!re.test(tsSrc)) {
      throw new Error(`terminal-state.ts header missing ADR scope doc for pattern ${re}`);
    }
  }
});

console.log("\nSection: dispatch_agent audit write sites");

check("dispatch_agent normal-execution audit writes ...tsFields", () => {
  // The normal-completion audit write site for dispatch_agent.
  // Look for "operation: \"dispatch_agent\"" with ...tsFields in the
  // same audit row.
  const m = dispatchSrc.match(
    /operation:\s*"dispatch_agent"[\s\S]{0,3000}?\}\s*,\s*\)\s*;/g,
  );
  if (!m || m.length === 0) {
    throw new Error("could not locate dispatch_agent audit write block");
  }
  // We expect TWO sites: the normal-execution one and the tool_rejected
  // one (R6 P1-3 fix). Both should spread ...tsFields (or its variant
  // ...rejectTsFields). Verify both spread some buildTerminalStateFields
  // result.
  for (const block of m) {
    const hasSpread = /\.\.\.\w*tsFields\b/.test(block);
    if (!hasSpread) {
      throw new Error(
        `dispatch_agent audit block missing ...tsFields spread:\n${block.slice(0, 400)}...`,
      );
    }
  }
});

check("dispatch_agent tool_rejected writes audit row (R6 P1-3 fix)", () => {
  // Look for tool_rejected audit write inside dispatch_agent execute().
  // It must include failure_type: "tool_rejected" AND spread rejectTsFields.
  // Search the file for both the rejection branch and the audit row.
  // Use a heuristic: there is a `failure_type: "tool_rejected"` and
  // operation: "dispatch_agent" present after some "tool_rejected" guard.
  const match = dispatchSrc.match(
    /toolCheck\.ok[\s\S]{0,2500}?failure_type:\s*"tool_rejected"/,
  );
  if (!match) {
    throw new Error(
      "expected dispatch_agent to write tool_rejected audit row " +
      "(see R6 P1-3 fix — GPT-5.5 P1-3 found it was missing)",
    );
  }
  // And it must spread a tsFields-shaped object (rejectTsFields).
  if (!/\.\.\.rejectTsFields\b/.test(dispatchSrc)) {
    throw new Error("dispatch_agent tool_rejected branch must spread ...rejectTsFields");
  }
});

console.log("\nSection: dispatch_parallel.task audit write sites");

check("dispatch_parallel per-task normal write spreads ...taskTsFields", () => {
  // The normal completion per-task audit row.
  const m = dispatchSrc.match(
    /operation:\s*"dispatch_parallel\.task"[\s\S]{0,1500}?\}\s*\)\s*;/g,
  );
  if (!m || m.length < 2) {
    // Two sites: the normal one and the tool_rejected one (parallel had it
    // from the start; R6 also added row_kind to both).
    throw new Error(
      `expected \u22652 dispatch_parallel.task audit write sites; got ${m?.length ?? 0}`,
    );
  }
  for (const block of m) {
    const hasSpread = /\.\.\.\w*[Tt]sFields\b/.test(block);
    if (!hasSpread) {
      throw new Error(
        `dispatch_parallel.task audit block missing ...*tsFields spread:\n${block.slice(0, 400)}...`,
      );
    }
  }
});

check("dispatch_parallel.task carries row_kind:\"task\" (R6 P2-1 fix)", () => {
  // Both per-task audit sites must include row_kind:"task" so jq queries
  // can disambiguate aggregate from task rows.
  const m = dispatchSrc.match(
    /operation:\s*"dispatch_parallel\.task"[\s\S]{0,1500}?\}\s*\)\s*;/g,
  );
  if (!m) throw new Error("could not locate dispatch_parallel.task blocks");
  for (const block of m) {
    if (!/row_kind:\s*"task"/.test(block)) {
      throw new Error(`dispatch_parallel.task block missing row_kind:"task":\n${block.slice(0, 400)}...`);
    }
  }
});

console.log("\nSection: dispatch_parallel.summary aggregate audit row");

check("dispatch_parallel.summary aggregate row exists with row_kind:\"aggregate\"", () => {
  if (!/operation:\s*"dispatch_parallel\.summary"/.test(dispatchSrc)) {
    throw new Error("missing dispatch_parallel.summary aggregate audit row");
  }
  if (!/row_kind:\s*"aggregate"/.test(dispatchSrc)) {
    throw new Error("aggregate row must carry row_kind:\"aggregate\" (R6 P2-1 fix)");
  }
});

check("aggregate uses subturn=0 sentinel + sub_agent_label", () => {
  // The aggregate anchor is built ad-hoc with subturn:0. This is the
  // reserved sentinel separating aggregate rows from per-task subturn=1..N.
  if (!/subturn:\s*0/.test(dispatchSrc)) {
    throw new Error("aggregate anchor missing subturn:0 sentinel");
  }
  if (!/sub_agent_label:\s*"dispatch_parallel\.summary"/.test(dispatchSrc)) {
    throw new Error("aggregate anchor missing sub_agent_label");
  }
});

check("aggregate spreads ...aggregateTsFields", () => {
  // The aggregate row body must spread the aggregate terminal state fields.
  const block = dispatchSrc.match(
    /operation:\s*"dispatch_parallel\.summary"[\s\S]{0,1500}?\}\s*\)\s*;/,
  );
  if (!block) throw new Error("could not locate aggregate audit block");
  if (!/\.\.\.aggregateTsFields/.test(block[0])) {
    throw new Error("aggregate block missing ...aggregateTsFields spread");
  }
});

console.log("\nSection: aggregate cancelSource override (R6 P1-2 fix)");

check("aggregate inferParallelTerminalState receives cancelSource override", () => {
  // The fix: inferParallelTerminalState must get { cancelSource: signal.aborted ? "user" : undefined }
  // so aggregate and per-task rows cannot diverge on cancel_source.
  const m = dispatchSrc.match(
    /inferParallelTerminalState\([\s\S]{0,800}?\)/,
  );
  if (!m) throw new Error("could not locate inferParallelTerminalState call");
  if (!/signal\.aborted\s*\?\s*"user"\s*:\s*undefined/.test(m[0])) {
    throw new Error(
      "inferParallelTerminalState call missing { cancelSource: signal.aborted ? \"user\" : undefined } " +
      "(R6 GPT-5.5 P1-2 fix)",
    );
  }
});

console.log("\nSection: results-array hole handling (R6 P1-1 fix)");

check("taskSummaries derives from materializedResults (R7: single source of truth)", () => {
  // R6 GPT-5.5 P1-1: results array is `new Array(tasks.length)` — holes
  // appear when workers `return` early on abort. R6 built taskSummaries
  // via for-loop materializing holes. R7 unified this: holes are
  // materialized ONCE into a dense `materializedResults` array, and
  // taskSummaries derives from it via .map. The hole synthesis still
  // exists (in the materializedResults construction); this smoke check
  // is updated to lock the R7 shape (single source of truth) rather than
  // the R6 shape (duplicated hole logic).
  const block = dispatchSrc.match(/taskSummaries[\s\S]{0,1500}?const aggregateTsFields/);
  if (!block) throw new Error("could not locate taskSummaries build block");
  if (!/taskSummaries:\s*TaskSummary\[\]\s*=\s*materializedResults\.map/.test(block[0])) {
    throw new Error(
      "R7 invariant: taskSummaries must derive from materializedResults.map, " +
      "NOT a separate hole-materialization for-loop. The hole synthesis lives " +
      "in materializedResults construction (single source of truth).",
    );
  }
  // The hole materialization itself must still exist somewhere upstream
  // (in materializedResults construction).
  if (!/parent abort before worker claim/i.test(dispatchSrc)) {
    throw new Error(
      "missing the 'parent abort before worker claim' materialization branch; without it, " +
      "results holes would make aggregate undercount and possibly report completed when fan-out was aborted",
    );
  }
});

console.log("\nSection: tool-block progress state machine");

check("DispatchState union includes 'degraded' AND 'cancelled'", () => {
  if (!/type DispatchState =[^;]*"degraded"/.test(dispatchSrc)) {
    throw new Error("DispatchState missing 'degraded' member");
  }
  if (!/type DispatchState =[^;]*"cancelled"/.test(dispatchSrc)) {
    throw new Error("DispatchState missing 'cancelled' member (R6 DeepSeek P2-3 fix)");
  }
});

check("tool-block progress renderer surfaces degraded and cancelled states", () => {
  if (!/renderDispatchProgressLines/.test(dispatchSrc)) {
    throw new Error("renderDispatchProgressLines missing");
  }
  if (!/snapshot\.state/.test(dispatchSrc)) {
    throw new Error("tool-block progress renderer must include snapshot.state");
  }
  if (!/state === "cancelled"/.test(dispatchSrc)) {
    throw new Error("tool-block progress renderer must distinguish cancelled tasks");
  }
});

check("tool-block progress uses a responsive text table", () => {
  if (!/class DispatchToolResultView/.test(dispatchSrc)) {
    throw new Error("dispatch tool results must render through a width-aware component");
  }
  if (!/renderDispatchProgressLines\(this\.progress,\s*this\.renderedAt,\s*safeWidth\)/.test(dispatchSrc)) {
    throw new Error("dispatch progress must render with the real component width");
  }
  if (!/function renderDispatchTaskTable/.test(dispatchSrc)) {
    throw new Error("dispatch progress task table renderer missing");
  }
  if (!/chooseDispatchProgressColumns\(width,\s*indexWidth\)/.test(dispatchSrc)) {
    throw new Error("dispatch progress table must select columns by width");
  }
});

check("tool-block progress labels counts and heartbeat/progress age", () => {
  if (!/formatProgressCounts\(snapshot\.counts,\s*snapshot\.countsLabel\)/.test(dispatchSrc)) {
    throw new Error("progress header must render labelled counts instead of positional 0/0/1/1 counters");
  }
  if (/hb:/.test(dispatchSrc)) {
    throw new Error("progress rows must not render terse hb:reason fields");
  }
  if (!dispatchSrc.includes("${reason} ${formatProgressDuration(hbMs)} ago")) {
    throw new Error("progress rows must render progress reason with an explicit age");
  }
});

check("tool-block progress tracks sub-agent tool call counts", () => {
  if (!/toolCallCount\?: number/.test(dispatchSrc)) {
    throw new Error("Dispatch progress tasks and AgentResult must carry toolCallCount");
  }
  if (!/eventType === "tool_execution_start"\) toolCallCount\+\+/.test(dispatchSrc)) {
    throw new Error("runInProcess must count actual sub-agent tool_execution_start events");
  }
  if (!/onProgress\?\.\(\{ reason, at: lastProgressAt, heartbeatTracePath: heartbeat\.tracePath, toolCallCount \}\)/.test(dispatchSrc)) {
    throw new Error("runInProcess progress updates must include toolCallCount");
  }
  if (!/case "tools": return \{ key, label: "Tools"/.test(dispatchSrc)) {
    throw new Error("dispatch progress table must expose a Tools column");
  }
});

check("collapsed tool result preview skips markdown/table metadata", () => {
  if (!/function dispatchOutputPreview\(body: string\)/.test(dispatchSrc)) {
    throw new Error("dispatchOutputPreview helper missing");
  }
  if (!dispatchSrc.includes("if (/^#{1,6}\\s/.test(line)) return false;")) {
    throw new Error("collapsed preview must skip markdown headings before selecting output preview");
  }
  if (!dispatchSrc.includes("if (/^\\|/.test(line)) return false;")) {
    throw new Error("collapsed preview must skip markdown tables before selecting output preview");
  }
  if (!dispatchSrc.includes("if (/^_serial sum:/.test(line)) return false;")) {
    throw new Error("collapsed preview must skip dispatch_parallel timing metadata");
  }
  if (!dispatchSrc.includes("truncateDisplayText(`output: ${preview}`, safeWidth)")) {
    throw new Error("collapsed preview must label the selected user-visible output line using actual width");
  }
});

check("finalState mapping preserves cancelled (does not collapse to failed)", () => {
  // R6 DeepSeek P2-3 fix
  if (!/aggregateTsFields\.terminal_state\s*===\s*"cancelled"\s*\?\s*"cancelled"/.test(dispatchSrc)) {
    throw new Error(
      "finalState must map cancelled→cancelled (not failed); previously collapsed, hiding user-abort signal in progress UI",
    );
  }
});

check("single-task dispatch_agent progress also maps cancelled (R7.1 P2 fix)", () => {
  // R7.1 GPT-5.5 + DeepSeek unanimous P2: dispatch_agent was previously
  // `result.error ? "failed" : "completed"` — collapsing user-abort and
  // timeout into failed despite the audit/details correctly showing
  // terminal_state:"cancelled". Stage 1b heartbeat relies on the
  // single-task progress state reading cancelled so this symmetry must be locked.
  if (!/singleTaskFinalState:\s*DispatchState/.test(dispatchSrc)) {
    throw new Error(
      "dispatch_agent progress must derive a DispatchState from terminal_state, " +
      "not from result.error alone",
    );
  }
  if (!/result\.failureType\s*===\s*"aborted"\s*\|\|\s*result\.failureType\s*===\s*"timeout"\s*\|\|\s*result\.failureType\s*===\s*"timeout_partial"\s*\n\s*\?\s*"cancelled"/.test(dispatchSrc)) {
    throw new Error(
      "dispatch_agent progress must map aborted/timeout/timeout_partial to cancelled",
    );
  }
});

console.log("\nSection: tool result details surface terminalState");

check("dispatch_agent details include terminalState", () => {
  const block = dispatchSrc.match(
    /kind:\s*"dispatch_agent_result"[\s\S]{0,800}?\}/,
  );
  if (!block) throw new Error("could not locate dispatch_agent_result details");
  if (!/terminalState:\s*tsFields\.terminal_state/.test(block[0])) {
    throw new Error("dispatch_agent details missing terminalState surface");
  }
});

check("dispatch_parallel summary details include terminalState", () => {
  // R7: the details block now embeds tasks: tasks.map(...) which is
  // longer; bumped block window so the aggregate terminalState assertion
  // is captured before the closer.
  const block = dispatchSrc.match(
    /kind:\s*"dispatch_parallel_summary"[\s\S]{0,3000}?\}\s*,/,
  );
  if (!block) throw new Error("could not locate dispatch_parallel_summary details");
  if (!/terminalState:\s*aggregateTsFields\.terminal_state/.test(block[0])) {
    throw new Error("dispatch_parallel details missing aggregate terminalState surface");
  }
});

check("per-task details include terminalState (R7: derived from materializedResults)", () => {
  // R7 P1 fix changed the lookup pattern: const r = materializedResults[i];
  // terminalState: inferTerminalState(r). The previous pattern
  // `inferTerminalState(results[i])` is gone (deliberately) because
  // results[i] could be undefined for holes.
  if (!/terminalState:\s*inferTerminalState\(r\)/.test(dispatchSrc)) {
    throw new Error(
      "per-task details must call inferTerminalState(r) where r = materializedResults[i] (R7 P1-A fix). " +
      "Previously used results[i] which yielded inconsistent state for holes.",
    );
  }
});

console.log("\nSection: heartbeat audit enrichment");

check("dispatch imports and applies heartbeat consumer as audit-only enrichment", () => {
  if (!/import \{ assessLivenessForAnchor \} from "\.\/heartbeat-consumer"/.test(dispatchSrc)) {
    throw new Error("dispatch must import heartbeat consumer assessment helper");
  }
  if (!/const enrichHeartbeat = \(result:\s*AgentResult\):\s*AgentResult => \{[\s\S]{0,900}?assessLivenessForAnchor\(heartbeatProjectRoot, heartbeatAnchor\)/.test(dispatchSrc)) {
    throw new Error("runInProcess must assess heartbeat liveness inside enrichHeartbeat");
  }
  if (!/return enrichHeartbeat\(resultWithBudget\)/.test(dispatchSrc)) {
    throw new Error("runInProcess must enrich settled results with heartbeat trace/liveness before returning");
  }
  if (/terminalStateFromLiveness\(heartbeat_liveness\)/.test(dispatchSrc)) {
    throw new Error("post-settlement heartbeat enrichment must be audit-only; do not mutate settled terminal state");
  }
});

check("runtime audit rows carry heartbeat_trace_path when available", () => {
  const agentRuntime = dispatchSrc.match(
    /operation:\s*"dispatch_agent"[\s\S]{0,3000}?heartbeat_trace_path[\s\S]{0,800}?\}\s*,\s*\)\s*;/,
  );
  if (!agentRuntime) {
    throw new Error("dispatch_agent runtime audit row missing heartbeat_trace_path enrichment");
  }
  const parallelRuntime = dispatchSrc.match(
    /operation:\s*"dispatch_parallel\.task"[\s\S]{0,3000}?heartbeat_trace_path[\s\S]{0,800}?\}\s*\)\s*;/,
  );
  if (!parallelRuntime) {
    throw new Error("dispatch_parallel.task runtime audit row missing heartbeat_trace_path enrichment");
  }
});

console.log("\nSection: backward compat");

check("legacy result:\"ok\"|\"fail\" field retained on all audit rows", () => {
  // All audit write sites (dispatch_agent normal, dispatch_agent tool_rejected,
  // dispatch_parallel.task normal, dispatch_parallel.task tool_rejected,
  // dispatch_parallel.summary) must still have a `result:` field for
  // backward compat. R7 changed the aggregate row from
  //   result: failed > 0 ? "fail" : "ok"
  // to derive from terminal_state via aggregateLegacyResult identifier:
  //   result: aggregateLegacyResult
  // so the regex needs to allow that form too.
  const sites = dispatchSrc.match(
    /operation:\s*"dispatch_(?:agent|parallel\.task|parallel\.summary)"[\s\S]{0,3000}?\}\s*\)\s*;/g,
  );
  if (!sites || sites.length < 5) {
    throw new Error(`expected \u22655 audit write sites; got ${sites?.length ?? 0}`);
  }
  for (const block of sites) {
    if (!/result:\s*(?:"|res\.error|result\.error|aggregateLegacyResult\b)/.test(block)) {
      throw new Error(
        `audit block missing legacy result field (backward compat):\n${block.slice(0, 400)}...`,
      );
    }
  }
});

check("legacy failure_type retained on error-path audit rows", () => {
  // failure_type should still appear in error-path audit rows for backward
  // compat with consumers that haven't migrated to terminal_state.
  if (!/failure_type:\s*"tool_rejected"/.test(dispatchSrc)) {
    throw new Error("failure_type:\"tool_rejected\" must still appear in error rows for backward compat");
  }
  if (!/failure_type:\s*res\.failureType/.test(dispatchSrc)) {
    throw new Error("failure_type: res.failureType retained for backward compat");
  }
  if (!/failure_type:\s*result\.failureType/.test(dispatchSrc)) {
    throw new Error("failure_type: result.failureType retained for backward compat");
  }
});

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ all C5 audit-row schema invariants hold`);
