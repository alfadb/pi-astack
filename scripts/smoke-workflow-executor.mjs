#!/usr/bin/env node
/**
 * Smoke test: PR-10/P2b workflow executor (ADR 0032 §8, W11/W12/W13).
 *
 * Locks:
 *  - W12: GLOBAL semaphore ≤ 4 across eager waves (opus R1 F1 shape:
 *    dry-run wave estimate passes but eager runtime demand is 5 —
 *    runtime semaphore must hold the 5th unit back).
 *  - W11: every non-completed record cites a deterministic
 *    failure_source (runner_terminal / output_write_failed /
 *    upstream_output_missing / run_timeout / external_abort /
 *    workflow_abort) — no LLM in the loop.
 *  - §7 degrade: degraded stage still produces output path with failure
 *    note; downstream receives {"upstream_status":"degraded"} marker;
 *    degraded list never silent. Degrade WITHOUT path → failed.
 *  - retry: bounded attempts; exhaust → failed → downstream cancelled.
 *  - C5 cancelled vs failed: external abort / run timeout → cancelled.
 *  - W13: anchorLabel threaded per unit (parallel children labeled
 *    parent/child).
 *  - resume forward-compat: state.json persists per-stage terminals.
 *  - §8 API boundary: production runner imports dispatch's runInProcess
 *    (shared API), not a copy.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const E = await jiti.import(`${repoRoot}/extensions/workflow/executor.ts`);
const D = await jiti.import(`${repoRoot}/extensions/workflow/dsl.ts`);

function tmpRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-wf-"));
}
const agent = (id, over = {}) => ({ id, kind: "agent", prompt: `do ${id}`, ...over });
const doc = (stages, over = {}) => ({ schema_version: 1, name: "t", stages, ...over });

/** Runner factory: per-stage behavior map. */
function makeRunner(behaviors = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const traceFields = (stageId, status = "complete") => ({
    reasoning_trace_path: `/tmp/workflow-reasoning-${stageId}-${status}.jsonl`,
    reasoning_chars: stageId.length,
    reasoning_chunks: 1,
    reasoning_truncated: false,
    reasoning_sha256: `sha-${stageId}-${status}`,
    reasoning_trace_status: status,
    reasoning_trace_bytes: 1024 + stageId.length,
  });
  const runner = async (req) => {
    calls.push({ stageId: req.stageId, workflowRunId: req.workflowRunId, anchorLabel: req.anchorLabel, model: req.model, tools: req.tools, prompt: req.prompt });
    active++;
    peak = Math.max(peak, active);
    try {
      const b = behaviors[req.stageId] ?? {};
      const delay = typeof b.delayMs === "function" ? b.delayMs() : (b.delayMs ?? 1);
      const slept = sleep(delay);
      if (req.signal) {
        await Promise.race([slept, new Promise((r) => req.signal.addEventListener("abort", r, { once: true }))]);
        if (req.signal.aborted) {
          return { output: "", error: "aborted in flight", failureType: "aborted", durationMs: delay, ...traceFields(req.stageId, "forced_incomplete") };
        }
      } else {
        await slept;
      }
      if (typeof b.fail === "function" ? b.fail() : b.fail) {
        return { output: b.partial ?? "", error: b.error ?? `${req.stageId} boom`, failureType: "agent_error", durationMs: delay, ...traceFields(req.stageId, b.traceStatus ?? "complete") };
      }
      return { output: `output of ${req.stageId}`, durationMs: delay, usage: { input: 1, output: 1, total: 2, cost: 0.001 }, ...traceFields(req.stageId) };
    } finally {
      active--;
    }
  };
  return { runner, calls, peak: () => peak };
}

const baseOpts = (runDir, runner, over = {}) => ({
  runId: "run1",
  runDir,
  runner,
  readOnly: true,
  defaultModel: "provider-a/model-a",
  defaultThinking: "medium",
  ...over,
});

console.log("workflow executor — PR-10/P2b (ADR 0032 §8, W11/W12/W13)");

await check("happy linear a→b: completed; trace files + state.json; downstream gets path+summary block", async () => {
  const runDir = tmpRunDir();
  const { runner, calls } = makeRunner();
  const r = await E.executeWorkflow({
    doc: doc([agent("a"), agent("b", { needs: ["a"] })]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "completed", `status=${r.status}`);
  assert(r.stages.a.status === "completed" && r.stages.b.status === "completed", JSON.stringify(r.stages));
  const fileA = path.join(runDir, "stage-a.md");
  assert(fs.existsSync(fileA), "stage-a.md written");
  const traceA = fs.readFileSync(fileA, "utf-8");
  assert(traceA.includes("assistant-observed (W10)") && traceA.includes("output of a"), "trace header + body");
  const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf-8"));
  assert(state.schema_version === 1 && state.status === "completed" && state.stages.a.status === "completed", "state.json persisted");
  const bCall = calls.find((c) => c.stageId === "b");
  assert(bCall.prompt.includes("<workflow-upstream>") && bCall.prompt.includes('"upstream_status":"completed"'), "upstream block present");
  assert(bCall.prompt.includes("stage-a.md") && bCall.prompt.includes("output of a"), "path + summary threaded");
  assert(r.stages.a.cost === 0.001, "cost recorded");
  assert(r.stages.a.reasoning_trace_path === "/tmp/workflow-reasoning-a-complete.jsonl", "success stage reasoning trace path recorded");
  assert(r.stages.a.reasoning_trace_status === "complete" && r.stages.a.reasoning_sha256 === "sha-a-complete", "success stage reasoning completeness recorded");
  assert(calls.find((c) => c.stageId === "a").workflowRunId === "run1", "runner receives workflowRunId for trace correlation");
  assert(Math.abs(r.totalCost - 0.002) < 1e-9, `run-level cost roll-up (got ${r.totalCost})`);
});

await check("W12: eager cross-wave overlap held to global cap 4 (opus F1 shape)", async () => {
  // dry-run wave estimate: [a,c]=2 then [p]=4 → est 4 PASSES. Eager
  // runtime: a finishes fast → p's 4 children launch while c still runs
  // → demand 5 → semaphore must queue the 5th unit.
  const runDir = tmpRunDir();
  const { runner, calls, peak } = makeRunner({
    a: { delayMs: 5 },
    c: { delayMs: 80 },
    c1: { delayMs: 30 }, c2: { delayMs: 30 }, c3: { delayMs: 30 }, c4: { delayMs: 30 },
  });
  const r = await E.executeWorkflow({
    doc: doc([
      agent("a"),
      agent("c"),
      { id: "p", kind: "parallel", needs: ["a"], children: [agent("c1"), agent("c2"), agent("c3"), agent("c4")] },
    ]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "completed", `status=${r.status}`);
  assert(calls.length === 6, `6 units ran (got ${calls.length})`);
  assert(peak() <= 4, `peak ${peak()} must be ≤ 4 (W12)`);
  assert(peak() === 4, `peak ${peak()} should reach the cap (demand was 5)`);
  assert(r.stages.p.status === "completed" && r.stages.p.output_paths.length === 4, "parallel aggregate completed");
});

await check("retry: fail once then succeed → completed with attempts=2", async () => {
  const runDir = tmpRunDir();
  let first = true;
  const { runner } = makeRunner({ a: { fail: () => { const f = first; first = false; return f; } } });
  const r = await E.executeWorkflow({
    doc: doc([agent("a", { on_fail: "retry", max_retries: 2 })]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "completed", `status=${r.status}`);
  assert(r.stages.a.attempts === 2, `attempts=${r.stages.a.attempts}`);
});

await check("retry exhaust → failed(runner_terminal) → downstream cancelled(workflow_abort) → run failed", async () => {
  const runDir = tmpRunDir();
  const { runner, calls } = makeRunner({ a: { fail: true } });
  const r = await E.executeWorkflow({
    doc: doc([agent("a", { on_fail: "retry", max_retries: 2 }), agent("b", { needs: ["a"] })]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.stages.a.status === "failed" && r.stages.a.failure_source === "runner_terminal", JSON.stringify(r.stages.a));
  assert(r.stages.a.attempts === 3, `attempts=${r.stages.a.attempts} (1 + 2 retries)`);
  assert(r.stages.b.status === "cancelled" && r.stages.b.failure_source === "workflow_abort", JSON.stringify(r.stages.b));
  assert(calls.filter((c) => c.stageId === "b").length === 0, "b never launched");
});

await check("governance terminal is non-retryable and governance fields reach stage/audit", async () => {
  const runDir = tmpRunDir();
  const rows = [];
  let calls = 0;
  const governance = {
    worker_run_id: "worker-gov-1",
    rule_version: "dispatch-worker-run-governor/v2",
    profile: "read_only",
    counters: {
      provider_request_count: 8,
      provider_retry_count: 8,
      provider_retry_consecutive_count: 8,
      provider_retry_window_observation_count: 8,
      provider_retry_window_retry_count: 8,
      provider_retry_window_progress_count: 0,
    },
    thresholds: { provider_retry_limit: 7, provider_retry_window_size: 14, provider_retry_window_limit: 10 },
    terminal: {
      signal: "provider_retry",
      termination_source: "worker_run_governor",
      failureType: "provider_retry_budget_exceeded",
      count: 8,
      limit: 7,
      budget_kind: "consecutive",
      action: "abort_session_return_bounded_partial",
    },
  };
  const r = await E.executeWorkflow({
    doc: doc([agent("a", { on_fail: "retry", max_retries: 3 })]),
    ...baseOpts(runDir, async () => {
      calls++;
      return {
        output: "bounded partial",
        error: "provider retry budget exceeded",
        failureType: "provider_retry_budget_exceeded",
        durationMs: 2,
        workerRunGovernance: governance,
      };
    }, { audit: (row) => rows.push(row) }),
  });
  assert(calls === 1, `governance terminal must not retry (calls=${calls})`);
  assert(r.stages.a.attempts === 1 && r.stages.a.failure_type === "provider_retry_budget_exceeded", JSON.stringify(r.stages.a));
  assert(r.stages.a.worker_run_governance?.worker_run_id === "worker-gov-1", JSON.stringify(r.stages.a));
  const row = rows.find((item) => item.event === "stage_terminal" && item.stage === "a");
  assert(row?.worker_run_governance?.terminal?.termination_source === "worker_run_governor", JSON.stringify(row));
  assert(row?.worker_run_governance?.rule_version === "dispatch-worker-run-governor/v2" && row?.worker_run_governance?.terminal?.budget_kind === "consecutive", JSON.stringify(row));
});

await check("retired cumulative tool budget is not an active workflow governance terminal", async () => {
  assert(!E.isNonRetryableGovernanceFailure("tool_budget_exceeded"), "retired tool budget must not remain in the active non-retryable set");
  assert(E.isNonRetryableGovernanceFailure("guardrail_stop"), "historical guardrail result parsing remains supported");
});

await check("degrade policy preserves bounded governance partial in output file", async () => {
  const runDir = tmpRunDir();
  let calls = 0;
  const r = await E.executeWorkflow({
    doc: doc([agent("a", { on_fail: "degrade" })]),
    ...baseOpts(runDir, async () => {
      calls++;
      return {
        output: "bounded partial from repetitive worker",
        error: "repetitive output stopped",
        failureType: "repetitive_output",
        durationMs: 2,
      };
    }),
  });
  assert(calls === 1 && r.stages.a.status === "degraded", JSON.stringify(r.stages.a));
  const body = fs.readFileSync(r.stages.a.output_path, "utf8");
  assert(body.includes("bounded partial from repetitive worker") && body.includes("failure_note"), body);
});

await check("thrown runner preserves standard reasoning trace fields in stage state and audit", async () => {
  const runDir = tmpRunDir();
  const auditRows = [];
  const thrown = new Error("production runner exploded");
  Object.assign(thrown, {
    reasoning_trace_path: "/tmp/workflow-thrown-trace.jsonl",
    reasoning_chars: 77,
    reasoning_chunks: 3,
    reasoning_truncated: true,
    reasoning_sha256: "sha-thrown",
    reasoning_trace_status: "write_failed",
    reasoning_trace_error_code: "terminal_sync:EIO",
    reasoning_trace_bytes: 4096,
    prompt: "must-not-duck-copy",
  });
  const r = await E.executeWorkflow({
    doc: doc([agent("a")]),
    ...baseOpts(runDir, async () => { throw thrown; }, { audit: (row) => auditRows.push(row) }),
  });
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.stages.a.reasoning_trace_path === "/tmp/workflow-thrown-trace.jsonl", JSON.stringify(r.stages.a));
  assert(r.stages.a.reasoning_trace_status === "write_failed", JSON.stringify(r.stages.a));
  assert(r.stages.a.reasoning_trace_error_code === "terminal_sync:EIO", JSON.stringify(r.stages.a));
  assert(r.stages.a.reasoning_trace_bytes === 4096 && r.stages.a.reasoning_sha256 === "sha-thrown", JSON.stringify(r.stages.a));
  assert(!Object.hasOwn(r.stages.a, "prompt"), "executor must only duck-copy standard trace fields");
  const terminal = auditRows.find((row) => row.event === "stage_terminal" && row.stage === "a");
  assert(terminal?.reasoning_trace_path === "/tmp/workflow-thrown-trace.jsonl", JSON.stringify(auditRows));
  assert(terminal?.reasoning_trace_status === "write_failed" && terminal?.reasoning_trace_error_code === "terminal_sync:EIO", JSON.stringify(terminal));
});

await check("§7 degrade: path produced → degraded; downstream runs with structured marker; never silent", async () => {
  const runDir = tmpRunDir();
  const { runner, calls } = makeRunner({ a: { fail: true, partial: "partial result", error: "tool exploded" } });
  const r = await E.executeWorkflow({
    doc: doc([agent("a", { on_fail: "degrade" }), agent("b", { needs: ["a"] })]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "degraded", `status=${r.status}`);
  assert(r.degraded.join() === "a", "degraded list carries a");
  assert(r.stages.a.status === "degraded" && r.stages.a.output_path, JSON.stringify(r.stages.a));
  assert(r.stages.a.reasoning_trace_path === "/tmp/workflow-reasoning-a-complete.jsonl", "degraded/error stage reasoning trace path recorded");
  assert(r.stages.a.reasoning_trace_status === "complete" && r.stages.a.reasoning_sha256 === "sha-a-complete", "degraded/error stage reasoning completeness recorded");
  const trace = fs.readFileSync(r.stages.a.output_path, "utf-8");
  assert(trace.includes("failure_note: tool exploded") && trace.includes("partial result"), "partial output + failure note in file");
  assert(r.stages.b.status === "completed", "downstream ran (degraded satisfies needs)");
  const bCall = calls.find((c) => c.stageId === "b");
  assert(bCall.prompt.includes('"upstream_status":"degraded"'), "structured degraded marker in downstream prompt");
  assert(r.stages.b.degraded_upstreams.join() === "a", "degraded_upstreams recorded");
});

await check("§7 degrade WITHOUT producible path → failed(output_write_failed) (W11 io-deterministic)", async () => {
  const runDir = tmpRunDir();
  const { runner } = makeRunner({ a: { fail: true } });
  const io = {
    mkdirp: (d) => fs.mkdirSync(d, { recursive: true }),
    writeFile: (f, c) => {
      if (f.endsWith("stage-a.md")) throw new Error("disk full");
      fs.writeFileSync(f, c, "utf-8");
    },
    exists: (f) => fs.existsSync(f),
  };
  const r = await E.executeWorkflow({
    doc: doc([agent("a", { on_fail: "degrade" })]),
    ...baseOpts(runDir, runner, { io }),
  });
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.stages.a.status === "failed" && r.stages.a.failure_source === "output_write_failed", JSON.stringify(r.stages.a));
  assert(r.degraded.length === 0, "not counted as degraded");
});

await check("abort policy: failure halts scheduling; in-flight sibling drains to completed", async () => {
  const runDir = tmpRunDir();
  const { runner } = makeRunner({ a: { fail: true, delayMs: 5 }, c: { delayMs: 60 } });
  const r = await E.executeWorkflow({
    doc: doc([agent("a"), agent("c"), agent("b", { needs: ["a"] })]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.stages.a.status === "failed", "a failed");
  assert(r.stages.c.status === "completed", `in-flight sibling drained (got ${r.stages.c.status})`);
  assert(r.stages.b.status === "cancelled" && r.stages.b.failure_source === "workflow_abort", JSON.stringify(r.stages.b));
});

await check("C5: external abort mid-run → in-flight cancelled(external_abort); run cancelled", async () => {
  const runDir = tmpRunDir();
  const { runner } = makeRunner({ a: { delayMs: 200 } });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  const r = await E.executeWorkflow({
    doc: doc([agent("a"), agent("b", { needs: ["a"] })]),
    ...baseOpts(runDir, runner, { signal: ctl.signal }),
  });
  assert(r.status === "cancelled", `status=${r.status}`);
  assert(r.stages.a.status === "cancelled" && r.stages.a.failure_source === "external_abort", JSON.stringify(r.stages.a));
  assert(r.stages.a.reasoning_trace_path === "/tmp/workflow-reasoning-a-forced_incomplete.jsonl", "abort stage reasoning trace path recorded");
  assert(r.stages.a.reasoning_trace_status === "forced_incomplete", "abort stage reasoning status recorded");
  assert(r.stages.b.status === "cancelled", "pending b cancelled");
});

await check("run timeout (injected now): pending stage cancelled(run_timeout)", async () => {
  const runDir = tmpRunDir();
  let t = 0;
  const { runner } = makeRunner({ a: { delayMs: 5 } });
  const r = await E.executeWorkflow({
    doc: doc([agent("a"), agent("b", { needs: ["a"] })], { timeout_minutes: 1 }),
    ...baseOpts(runDir, runner, {
      now: () => t,
      runner: async (req) => { t += 70_000; return runner(req); }, // a's run pushes past 60s deadline
    }),
  });
  assert(r.status === "cancelled", `status=${r.status}`);
  assert(r.stages.b.status === "cancelled" && r.stages.b.failure_source === "run_timeout", JSON.stringify(r.stages.b));
});

await check("§8 upstream path check: record present but file missing → failed(upstream_output_missing)", async () => {
  const runDir = tmpRunDir();
  const { runner } = makeRunner();
  let sabotage = false;
  const io = {
    mkdirp: (d) => fs.mkdirSync(d, { recursive: true }),
    writeFile: (f, c) => fs.writeFileSync(f, c, "utf-8"),
    exists: (f) => (sabotage && f.endsWith("stage-a.md") ? false : fs.existsSync(f)),
  };
  const r = await E.executeWorkflow({
    doc: doc([agent("a"), agent("b", { needs: ["a"] })]),
    ...baseOpts(runDir, runner, {
      io,
      notify: () => { sabotage = true; }, // first notify fires after a's terminal
    }),
  });
  assert(r.status === "failed", `status=${r.status}`);
  assert(r.stages.b.status === "failed" && r.stages.b.failure_source === "upstream_output_missing", JSON.stringify(r.stages.b));
});

await check("parallel degrade: failed child gets failure-note file; siblings keep outputs; aggregate degraded", async () => {
  const runDir = tmpRunDir();
  const { runner } = makeRunner({ c2: { fail: true, error: "c2 broke" } });
  const r = await E.executeWorkflow({
    doc: doc([
      { id: "p", kind: "parallel", on_fail: "degrade", children: [agent("c1"), agent("c2")] },
      agent("b", { needs: ["p"] }),
    ]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "degraded", `status=${r.status}`);
  assert(r.stages.p.status === "degraded", JSON.stringify(r.stages.p));
  assert(r.stages.c1.status === "completed" && r.stages.c2.status === "degraded", `${r.stages.c1.status}/${r.stages.c2.status}`);
  assert(fs.existsSync(path.join(runDir, "stage-c2.md")), "failed child still produced its path (§7)");
  assert(r.stages.b.status === "completed", "downstream ran");
  assert(r.degraded.includes("c2") && r.degraded.includes("p"), `degraded list: ${r.degraded}`);
});

await check("parallel retry: only failed child re-runs; aggregate completed", async () => {
  const runDir = tmpRunDir();
  let c2First = true;
  const { runner, calls } = makeRunner({ c2: { fail: () => { const f = c2First; c2First = false; return f; } } });
  const r = await E.executeWorkflow({
    doc: doc([{ id: "p", kind: "parallel", on_fail: "retry", max_retries: 1, children: [agent("c1"), agent("c2")] }]),
    ...baseOpts(runDir, runner),
  });
  assert(r.status === "completed", `status=${r.status}`);
  assert(calls.filter((c) => c.stageId === "c1").length === 1, "c1 ran once");
  assert(calls.filter((c) => c.stageId === "c2").length === 2, "c2 retried");
  // opus R1 NIT-1: child attempts must reflect real run count across waves.
  assert(r.stages.c1.attempts === 1 && r.stages.c2.attempts === 2, `child attempts c1=${r.stages.c1.attempts} c2=${r.stages.c2.attempts}`);
});

await check("W13: anchorLabel threaded per unit; parallel children labeled parent/child", async () => {
  const runDir = tmpRunDir();
  const { runner, calls } = makeRunner();
  await E.executeWorkflow({
    doc: doc([agent("a"), { id: "p", kind: "parallel", needs: ["a"], children: [agent("c1")] }]),
    ...baseOpts(runDir, runner),
  });
  assert(calls.find((c) => c.stageId === "a").anchorLabel === "workflow[t].stage[a]", "agent label");
  assert(calls.find((c) => c.stageId === "c1").anchorLabel === "workflow[t].stage[p/c1]", "child label");
});

await check("audit rows: stage_terminal per stage/child + run_terminal with degraded list", async () => {
  const runDir = tmpRunDir();
  const rows = [];
  const { runner } = makeRunner({ a: { fail: true, error: "x" } });
  await E.executeWorkflow({
    doc: doc([agent("a", { on_fail: "degrade" }), agent("b", { needs: ["a"] })]),
    ...baseOpts(runDir, runner, { audit: (row) => rows.push(row) }),
  });
  const stageRows = rows.filter((r) => r.event === "stage_terminal");
  const runRows = rows.filter((r) => r.event === "run_terminal");
  assert(stageRows.length === 2 && runRows.length === 1, `rows: ${JSON.stringify(rows.map((r) => r.event))}`);
  assert(runRows[0].status === "degraded" && runRows[0].degraded.join() === "a", "run row carries degraded list");
  assert(stageRows.every((r) => r.run_id === "run1"), "run_id threaded");
  assert(stageRows.every((r) => r.reasoning_trace_path && r.reasoning_trace_status === "complete"), `stage audit rows carry trace association: ${JSON.stringify(stageRows)}`);
  assert(stageRows.find((r) => r.stage === "a").reasoning_sha256 === "sha-a-complete", "stage audit row carries reasoning hash");
});

await check("validation re-enforced at execution entry (unvalidated doc rejected)", async () => {
  const runDir = tmpRunDir();
  const { runner } = makeRunner();
  let threw = false;
  try {
    await E.executeWorkflow({
      doc: doc([agent("a", { tools: ["dispatch_agent"] })]),
      ...baseOpts(runDir, runner),
    });
  } catch (e) {
    threw = true;
    assert(String(e.message).includes("failed validation"), e.message);
  }
  assert(threw, "executor must reject invalid docs");
});

await check("gpt R1 B1: --yes parsing is quote-aware (quoted '--yes' is path data, never a flag)", async () => {
  // bypass attempt: quoted path containing --yes must NOT confirm and must
  // NOT be rewritten to a different file.
  let p = D.parseWorkflowRunArgs('"foo --yes bar.json"');
  assert(p.confirmed === false, "quoted --yes must not confirm");
  assert(p.fileSpec === '"foo --yes bar.json"', `path preserved verbatim (got ${p.fileSpec})`);
  p = D.parseWorkflowRunArgs('"foo --yes bar.json" --yes');
  assert(p.confirmed === true && p.fileSpec === '"foo --yes bar.json"', "trailing unquoted --yes after quoted path confirms");
  p = D.parseWorkflowRunArgs("wf.json --yes");
  assert(p.confirmed === true && p.fileSpec === "wf.json", "plain trailing --yes confirms");
  p = D.parseWorkflowRunArgs("wf.json");
  assert(p.confirmed === false && p.fileSpec === "wf.json", "no flag → not confirmed");
  p = D.parseWorkflowRunArgs("--yes wf.json");
  assert(p.confirmed === false, "leading --yes is not the trailing token → not confirmed");
  p = D.parseWorkflowRunArgs("'wf.json' --yes");
  assert(p.confirmed === true && p.fileSpec === "'wf.json'", "single-quoted path + trailing --yes");
  // gpt R2 B1-R2: unmatched/mixed quotes are malformed — fail-closed, never
  // confirm, never rewrite.
  p = D.parseWorkflowRunArgs('"wf.json --yes');
  assert(p.confirmed === false && p.malformed === true && p.fileSpec === '"wf.json --yes', `unmatched leading quote fail-closed (got ${JSON.stringify(p)})`);
  p = D.parseWorkflowRunArgs('"a" --yes "b"');
  assert(p.confirmed === false && p.malformed === true, "mixed multi-quote spec → malformed, never confirms");
  // gpt R3-1: greedy-pair ambiguity killed — quoted content must be quote-free.
  p = D.parseWorkflowRunArgs('"a" --yes "b" --yes');
  assert(p.confirmed === false && p.malformed === true, "multi-quote + trailing --yes → malformed, never confirms");
  // gpt R3-2: empty quotes never confirm (and loader rejects empty args).
  p = D.parseWorkflowRunArgs('"" --yes');
  assert(p.confirmed === false && p.malformed === true, "empty-quoted path → malformed");
  p = D.parseWorkflowRunArgs('wf".json --yes');
  assert(p.confirmed === false && p.malformed === true, "mid-string quote → malformed, not confirmed");
  p = D.parseWorkflowRunArgs("wf.json'--yes");
  assert(p.confirmed === false && p.malformed === true, "stray quote glued to flag → malformed");
});

await check("ADR 0033 tool surface: workflow_run structurally disabled; other names registry-gated; constants drift-locked", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/workflow/index.ts"), "utf-8");
  for (const tool of ["workflow_validate", "workflow_list", "workflow_run"]) {
    assert(new RegExp(`name:\\s*[\"']${tool}[\"']`).test(src), `${tool} registered as LLM tool`);
  }
  assert(/registerCommand\("workflow"/.test(src), "slash command kept as direct/debug path");
  const workflowRunToolBlock = src.match(/name:\s*["']workflow_run["'][\s\S]*?async execute\([\s\S]*?\n    },\n  \}\);/)?.[0] ?? "";
  assert(workflowRunToolBlock && !/--yes/.test(workflowRunToolBlock), "workflow_run tool path has no --yes gate");
  assert(/Math\.min\(WORKFLOW_MAX_CONCURRENCY,\s*DISPATCH_MAX_CONCURRENCY\)/.test(src), "production call site clamps to both caps");
  const dispatchSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf-8");
  const disabledToolsBlock = dispatchSrc.match(/const DISABLED_SUBAGENT_TOOLS = \[[\s\S]*?\] as const;/)?.[0] ?? "";
  assert(/workflow_run/.test(disabledToolsBlock), "workflow_run remains structurally disabled for sub-agents");
  assert(!/workflow_validate|workflow_list/.test(disabledToolsBlock), "read-only workflow tools are resolved dynamically when explicitly requested");
  // literal-equality lock: dsl mirror === dispatch constant.
  const dm = /export const MAX_CONCURRENCY = (\d+);/.exec(dispatchSrc);
  assert(dm && Number(dm[1]) === D.WORKFLOW_MAX_CONCURRENCY, `dispatch MAX_CONCURRENCY (${dm?.[1]}) must equal dsl WORKFLOW_MAX_CONCURRENCY (${D.WORKFLOW_MAX_CONCURRENCY})`);
  const dt = /export const DEFAULT_TIMEOUT_MS = ([\d_]+);/.exec(dispatchSrc);
  const execSrc = fs.readFileSync(path.join(repoRoot, "extensions/workflow/executor.ts"), "utf-8");
  const et = /const DEFAULT_STAGE_TIMEOUT_MS = ([\d_]+);/.exec(execSrc);
  assert(dt && et && Number(dt[1].replace(/_/g, "")) === Number(et[1].replace(/_/g, "")), `timeout default drift: dispatch=${dt?.[1]} executor=${et?.[1]}`);
  assert(/perStageTimeoutMs:\s*DEFAULT_TIMEOUT_MS/.test(src), "production call site threads dispatch DEFAULT_TIMEOUT_MS");
  assert(/maxRuntimeMs:\s*req\.timeoutMs \?\? DEFAULT_TIMEOUT_MS/.test(src), "workflow preserves its wall-clock budget via dispatch maxRuntimeMs");
  assert(/reasoningTrace:\s*\{[\s\S]{0,180}?workflowRunId: req\.workflowRunId,[\s\S]{0,100}?workflowStageId: req\.stageId/.test(src), "workflow production runner enables per-stage reasoning trace");
  assert(/\.\.\.dispatchReasoningTraceFields\(result\)/.test(src), "workflow production runner returns reasoning trace fields");
  assert(/startsWith\("~\/"\)/.test(src) && /os\.homedir\(\)/.test(src), "loadWorkflowFile expands leading ~");
});

await check("ADR 0033 N5: production executor uses process-global workflow semaphore", async () => {
  const execSrc = fs.readFileSync(path.join(repoRoot, "extensions/workflow/executor.ts"), "utf-8");
  assert(/Symbol\.for\("pi-astack\/workflow\/global-semaphore\/v1"\)/.test(execSrc), "global semaphore key present");
  assert(/const sem = opts\.semaphore \?\? globalWorkflowSemaphore\(maxConcurrency\)/.test(execSrc), "production uses global semaphore unless test seam injected");
});

await check("§8 API boundary: production runner uses dispatch's exported runInProcess (no copy)", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/workflow/index.ts"), "utf-8");
  assert(/import\s*\{[\s\S]*?runInProcess[\s\S]*?\}\s*from\s*["']\.\.\/dispatch\/index["']/.test(src), "imports runInProcess from ../dispatch/index");
  assert(!/createAgentSession/.test(src), "workflow/index.ts must not re-implement the session loop");
  const dispatchSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf-8");
  assert(/export async function runInProcess\(/.test(dispatchSrc), "dispatch exports runInProcess");
  assert(/export function validateTools\(/.test(dispatchSrc), "dispatch exports validateTools (structural disabled-tool check)");
  assert(/export function validateSessionToolRegistry\(/.test(dispatchSrc), "dispatch exports target-session registry validation");
  assert(/export function enforceMutatingEnvGate\(/.test(dispatchSrc), "dispatch exports enforceMutatingEnvGate (W9 env gate, decoupled from validateTools 2026-06-16)");
  assert(/enforceMutatingEnvGate\(req\.tools\)/.test(src), "workflow production runner enforces the W9 mutating env gate locally (not inherited from validateTools)");
  assert(/Symbol\.for\("pi-astack\/dispatch\/shared-infra\/v1"\)/.test(dispatchSrc), "shared infra is globalThis singleton (jiti copy safety)");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (workflow executor).`
  : `FAIL — ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
