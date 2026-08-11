#!/usr/bin/env node
/** Focused additive audit-v5 smoke: joins, closure evidence, retry privacy. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const A = await jiti.import(path.join(root, "extensions/dispatch/audit-v5.ts"));
const G = await jiti.import(path.join(root, "extensions/dispatch/worker-run-governor.ts"));
const T = await jiti.import(path.join(root, "extensions/dispatch/terminal-state.ts"));
const D = await jiti.import(path.join(root, "extensions/dispatch/index.ts"));
const W = await jiti.import(path.join(root, "extensions/workflow/executor.ts"));
const DT = await jiti.import(path.join(root, "extensions/dispatch/dispatch-trace.ts"));
const AH = await jiti.import(path.join(root, "extensions/_shared/audit-checksum.ts"));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Governor-disabled retry lifecycle regression — CHILD MODE.
// The parent spawns THIS script again with `--disabled-child <home> <projectRoot>`
// and a temp HOME, so readDispatchSettings() resolves a REAL settings file with
// workerRunGovernor.enabled=false (PI_CODING_AGENT_DIR keeps the real agent dir).
// It drives the REAL SDK AgentSession auto_retry_start / auto_retry_end event
// path through D.runInProcess with a faux provider and asserts the retry start
// row is still written via the dedicated audit-only builder (never a fabricated
// decision), pairs with the end row on the same worker/run/call joins, leaves
// the disabled governor counters at zero, triggers no termination, and leaks no
// raw text or fabricated stream attribution.
// ─────────────────────────────────────────────────────────────────────────────
async function runDisabledChild(home, projectRoot) {
  console.log("\ndispatch audit v5 — governor-disabled retry lifecycle regression (child)\n");

  await check("disabled governor config actually resolved via settings file", async () => {
    const settings = await jiti.import(path.join(root, "extensions/dispatch/settings.ts"));
    assert.equal(
      settings.readDispatchSettings().workerRunGovernor.enabled,
      false,
      "readDispatchSettings() must resolve enabled=false from the temp HOME settings file",
    );
  });

  const codingAgentDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const compatPath = path.join(codingAgentDist, "../node_modules/@earendil-works/pi-ai/dist/compat.js");
  const Faux = await import(pathToFileURL(compatPath).href);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const faux = Faux.registerFauxProvider({
    provider: "faux-audit-v5-retry-disabled",
    tokensPerSecond: 0,
    models: [{ id: "audit-v5-retry-disabled-1", name: "Audit V5 Retry Disabled Faux", maxTokens: 16384 }],
  });
  const fauxModel = faux.getModel();
  modelRuntime.registerProvider(fauxModel.provider, {
    baseUrl: fauxModel.baseUrl,
    api: fauxModel.api,
    apiKey: "offline-smoke-key",
    authHeader: true,
    models: [{
      id: fauxModel.id,
      name: fauxModel.name,
      api: fauxModel.api,
      reasoning: false,
      input: ["text", "image"],
      cost: fauxModel.cost,
      contextWindow: fauxModel.contextWindow,
      maxTokens: fauxModel.maxTokens,
    }],
  });
  const registry = new ModelRegistry(modelRuntime);
  const modelName = `${fauxModel.provider}/${fauxModel.id}`;

  const sdkRetrySettings = SettingsManager.prototype.getRetrySettings;
  SettingsManager.prototype.getRetrySettings = function auditV5FastRetry() {
    return { enabled: true, maxRetries: 3, baseDelayMs: 25 };
  };

  let rows = [];
  let result = null;
  let errorPreview = null;
  try {
    await check("disabled governor: retry lifecycle writes paired provider_retry start/end rows with real fields and zero governor counters", async () => {
      const dispatchTrace = DT.createDispatchTraceSink({
        runId: "dtr-auditv5-retry-disabled",
        parentSessionId: "session-auditv5-retry-disabled",
        parentToolCallId: "call-auditv5-retry-disabled",
        taskIndex: 0,
      });
      const promptText = "execute the scripted faux response PROMPT-SECRET-123";
      const secretError = "HTTP 503 Bearer secret-token stream disconnected tool_args={password:x} output=private";
      faux.setResponses([
        Faux.fauxAssistantMessage([Faux.fauxText("partial before retry")], { stopReason: "error", errorMessage: secretError }),
        Faux.fauxAssistantMessage("retry recovered OUTPUT-SECRET-999"),
      ]);
      const providerBefore = faux.state.callCount;
      result = await D.runInProcess(
        modelName, "off", promptText, new AbortController().signal, 3000, registry, "read",
        {
          projectRoot,
          parentContextFiles: [],
          maxRuntimeMs: 6000,
          reasoningTrace: { dispatchToolCallId: "call-auditv5-retry-disabled", taskIndex: 0, taskCount: 1 },
          dispatchTrace,
        },
      );

      // The retried call succeeded as a NORMAL run-owner success. The disabled
      // governor must not count the retry and must not trigger any termination.
      assert.equal(result.error, undefined, `result.error=${JSON.stringify(result.error)}`);
      assert.ok(String(result.output).includes("OUTPUT-SECRET-999"), `output=${JSON.stringify(result.output)}`);
      assert.equal(faux.state.callCount - providerBefore, 2, `provider calls=${faux.state.callCount - providerBefore}`);
      assert.equal(result.terminationClosure?.termination_owner, "run", JSON.stringify(result.terminationClosure));
      assert.equal(result.terminationClosure?.lifecycle_path, "normal", JSON.stringify(result.terminationClosure));
      assert.equal(result.workerRunGovernance?.counters?.provider_retry_count, 0,
        `disabled governor counted provider retries: ${JSON.stringify(result.workerRunGovernance?.counters)}`);

      // Read the audit jsonl and wait for the async end-row append to land.
      const auditPath = path.join(projectRoot, ".pi-astack", "dispatch", "audit.jsonl");
      assert.ok(fs.existsSync(auditPath), `audit.jsonl missing at ${auditPath}`);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        rows = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        if (rows.some((row) => row.signal === "provider_retry_end")) break;
        await sleep(25);
      }
      const startRows = rows.filter((row) => row.signal === "provider_retry_start");
      const endRows = rows.filter((row) => row.signal === "provider_retry_end");
      assert.equal(startRows.length, 1, `provider_retry_start rows=${startRows.length}`);
      assert.equal(endRows.length, 1, `provider_retry_end rows=${endRows.length} (${rows.map((row) => row.signal).join(",")})`);

      // Start row: real attempt/delay/outcome/classification/checksum, honest
      // audit-only projection (action says no governor transition).
      const startRow = startRows[0];
      assert.equal(startRow.retry_phase, "start");
      assert.equal(startRow.retry_attempt, 1);
      assert.equal(startRow.retry_max_attempts, 3);
      assert.equal(startRow.retry_delay_ms, 25);
      assert.equal(startRow.retry_outcome, "retrying");
      assert.equal(startRow.action, "audit_provider_retry_start_no_governor_transition");
      assert.equal(startRow.counters?.provider_retry_count, 0, JSON.stringify(startRow.counters));
      // Classification/fingerprint must match the ACTUAL error text the SDK
      // delivered (observed via retryHistory.errorPreview), never the raw text.
      errorPreview = result.retryHistory?.entries?.[0]?.errorPreview;
      assert.equal(typeof errorPreview, "string", "retryHistory errorPreview missing");
      assert.ok(errorPreview.length > 0 && errorPreview.length < 120, `errorPreview truncated at ${errorPreview.length} chars`);
      assert.equal(startRow.error_classification, A.classifyProviderRetryError(errorPreview, 503), `classification for observed error: ${errorPreview}`);
      assert.deepEqual(
        startRow.error_fingerprint,
        AH.auditChecksumHex("dispatch/provider-retry-error/v1", errorPreview),
        JSON.stringify(startRow.error_fingerprint),
      );

      // End row: additive recovered outcome, no fabricated HTTP/fingerprint.
      const endRow = endRows[0];
      assert.equal(endRow.retry_phase, "end");
      assert.equal(endRow.retry_outcome, "recovered");
      assert.equal(endRow.error_classification, "none");
      assert.equal(endRow.retry_attempt, 1);
      assert.equal(endRow.action, "audit_provider_retry_end_no_governor_transition");
      assert.equal(endRow.counters?.provider_retry_count, 0, JSON.stringify(endRow.counters));
      assert.ok(!Object.hasOwn(endRow, "http_status"), "end row fabricated an HTTP status");
      assert.ok(!Object.hasOwn(endRow, "error_fingerprint"), "end row fabricated a fingerprint");
    });

    await check("disabled governor: start/end join same worker/run/call and no raw text or stream attribution", async () => {
      assert.ok(rows.length > 0, "no audit rows from the disabled run (start-row check failed first)");
      const startRow = rows.find((row) => row.signal === "provider_retry_start");
      const endRow = rows.find((row) => row.signal === "provider_retry_end");
      assert.ok(startRow && endRow, "provider_retry start/end rows missing");

      // Join: same worker run, dispatch run, and tool call on both rows.
      const workerRunId = result?.workerRunGovernance?.worker_run_id;
      assert.equal(typeof workerRunId, "string", "worker_run_id missing from result governance summary");
      for (const row of [startRow, endRow]) {
        assert.equal(row.worker_run_id, workerRunId, JSON.stringify(row));
        assert.equal(row.dispatch_run_id, "dtr-auditv5-retry-disabled", JSON.stringify(row));
        assert.equal(row.dispatch_tool_call_id, "call-auditv5-retry-disabled", JSON.stringify(row));
        assert.equal(row.task_index, 0, JSON.stringify(row));
        assert.equal(row.task_count, 1, JSON.stringify(row));
        assert.equal(row.task, "dispatch[0]", JSON.stringify(row));
      }

      // Privacy: no raw error/prompt/tool args/output text anywhere, and error
      // text (including stream-like wording) must never fabricate a stream
      // termination source — the run settled as a normal run-owner success.
      const serialized = JSON.stringify(rows);
      for (const sensitive of [
        "HTTP 503 Bearer secret-token stream disconnected tool_args={password:x} output=private",
        "secret-token",
        "PROMPT-SECRET-123",
        "tool_args={password:x}",
        "output=private",
        "OUTPUT-SECRET-999",
        "connection lost — ",
      ]) {
        assert.ok(!serialized.includes(sensitive), `audit jsonl leaked ${JSON.stringify(sensitive)}`);
      }
      for (const row of rows) {
        assert.notEqual(row.termination_source, "stream", `fabricated stream source: ${JSON.stringify(row)}`);
        assert.notEqual(row.cancel_source, "stream", `fabricated stream source: ${JSON.stringify(row)}`);
      }
    });

    await check("disabled governor: start row builder is a pure snapshot projection (no counter mutation, no terminal)", async () => {
      // Unit-level double check on the dedicated builder semantics: building the
      // start row must never mutate the governor, even when the governor would
      // have observed the retry if enabled.
      const governor = new G.WorkerRunGovernor(
        "worker-v5-disabled-builder",
        { ...G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS, enabled: false },
        projectRoot,
        4000,
      );
      assert.equal(governor.observe({ signal: "provider_retry" }, 4010), undefined,
        "disabled governor observe() must return undefined");
      const before = governor.snapshot();
      const row = G.buildWorkerRunRetryStartAuditEvent(
        before,
        10,
        A.providerRetryAuditFields("start", {
          attempt: 1,
          maxAttempts: 3,
          delayMs: 25,
          errorMessage: "HTTP 503 stream disconnected secret-token",
        }),
        { dispatchToolCallId: "call-disabled-builder", dispatchRunId: "dtr-disabled-builder" },
      );
      const after = governor.snapshot();
      assert.deepEqual(after.counters, before.counters, "start row builder mutated governor counters");
      assert.deepEqual(after.terminal, before.terminal, "start row builder touched governor terminal");
      assert.equal(row.signal, "provider_retry_start");
      assert.equal(row.retry_phase, "start");
      assert.equal(row.retry_attempt, 1);
      assert.equal(row.retry_max_attempts, 3);
      assert.equal(row.retry_delay_ms, 25);
      assert.equal(row.retry_outcome, "retrying");
      assert.equal(row.error_classification, "server_error");
      assert.equal(row.worker_run_id, "worker-v5-disabled-builder");
      assert.equal(row.dispatch_run_id, "dtr-disabled-builder");
      assert.equal(row.dispatch_tool_call_id, "call-disabled-builder");
      assert.equal(row.action, "audit_provider_retry_start_no_governor_transition");
      const serialized = JSON.stringify(row);
      for (const forbidden of ["secret-token", "stream disconnected"]) {
        assert.ok(!serialized.includes(forbidden), `start row leaked ${forbidden}`);
      }
    });
  } finally {
    SettingsManager.prototype.getRetrySettings = sdkRetrySettings;
    faux.unregister();
    modelRuntime.unregisterProvider(fauxModel.provider);
  }
}

const disabledChildIdx = process.argv.indexOf("--disabled-child");
if (disabledChildIdx >= 0) {
  const disabledHome = process.argv[disabledChildIdx + 1];
  const disabledProjectRoot = process.argv[disabledChildIdx + 2];
  if (!disabledHome || !disabledProjectRoot) {
    console.error("--disabled-child requires <home> <projectRoot>");
    process.exit(2);
  }
  await runDisabledChild(disabledHome, disabledProjectRoot);
  process.exit(failures.length === 0 ? 0 : 1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-audit-v5-"));
const secretError = "HTTP 503 Bearer secret-token prompt=must-not-leak tool_args={password:x} output=private";

console.log("dispatch additive audit v5 smoke\n");

await check("retry start carries real attempt/delay/classification and keyed fingerprint only", () => {
  const fields = A.providerRetryAuditFields("start", {
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 4,
    delayMs: 125,
    errorMessage: secretError,
  });
  assert.equal(fields.retry_phase, "start");
  assert.equal(fields.retry_attempt, 2);
  assert.equal(fields.retry_max_attempts, 4);
  assert.equal(fields.retry_delay_ms, 125);
  assert.equal(fields.retry_outcome, "retrying");
  assert.equal(fields.error_classification, "server_error");
  assert.equal(fields.http_status, 503);
  assert.equal(fields.error_fingerprint?.algorithm, "sha256");
  assert.match(fields.error_fingerprint?.digest ?? "", /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(fields);
  for (const forbidden of ["secret-token", "must-not-leak", "password:x", "output=private", secretError]) {
    assert.ok(!serialized.includes(forbidden), `retry fields leaked ${forbidden}`);
  }
  const again = A.providerRetryAuditFields("start", { errorMessage: secretError });
  assert.equal(again.error_fingerprint?.digest, fields.error_fingerprint?.digest);
});

await check("retry end outcome is additive and absent HTTP status stays absent", () => {
  const recovered = A.providerRetryAuditFields("end", {
    type: "auto_retry_end",
    success: true,
    attempt: 2,
  });
  assert.equal(recovered.retry_outcome, "recovered");
  assert.equal(recovered.error_classification, "none");
  assert.ok(!Object.hasOwn(recovered, "http_status"));
  assert.ok(!Object.hasOwn(recovered, "error_fingerprint"));

  const exhausted = A.providerRetryAuditFields("end", {
    type: "auto_retry_end",
    success: false,
    attempt: 3,
    finalError: "rate limit reached without a numeric status",
  });
  assert.equal(exhausted.retry_outcome, "exhausted");
  assert.equal(exhausted.error_classification, "rate_limit");
  assert.ok(!Object.hasOwn(exhausted, "http_status"), "must not fabricate an HTTP code");

  const bareNumber = A.providerRetryAuditFields("end", {
    success: false,
    finalError: "retry observation 503 had no HTTP/status label",
  });
  assert.ok(!Object.hasOwn(bareNumber, "http_status"), "bare three-digit values are not HTTP evidence");

  const hostile = Object.create(null, {
    errorMessage: { get() { throw new Error("hostile retry getter"); } },
  });
  assert.deepEqual(A.providerRetryAuditFields("start", hostile), {
    retry_phase: "start",
    retry_outcome: "retrying",
    error_classification: "unknown",
  });
});

await check("worker_run_event joins worker, dispatch run, and call without raw error", () => {
  const governor = new G.WorkerRunGovernor("worker-v5-join", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS, tempRoot, 1000);
  const retry = A.providerRetryAuditFields("start", {
    attempt: 1,
    delayMs: 25,
    errorMessage: secretError,
  });
  const decision = governor.observe({ signal: "provider_retry" }, 1025);
  const row = G.buildWorkerRunAuditEvent(decision, {
    dispatchToolCallId: "call-v5",
    dispatchRunId: "dtr-v5",
    taskIndex: 0,
    taskCount: 1,
  }, retry);
  assert.equal(row.worker_run_id, "worker-v5-join");
  assert.equal(row.dispatch_tool_call_id, "call-v5");
  assert.equal(row.dispatch_run_id, "dtr-v5");
  assert.equal(row.retry_attempt, 1);
  assert.equal(row.error_classification, "server_error");
  assert.ok(!JSON.stringify(row).includes(secretError));
});

await check("auto_retry_end audit builder does not mutate governor counters or termination", () => {
  const governor = new G.WorkerRunGovernor("worker-v5-end", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS, tempRoot, 2000);
  governor.observe({ signal: "provider_retry" }, 2010);
  const before = governor.snapshot();
  const row = G.buildWorkerRunRetryOutcomeAuditEvent(
    before,
    50,
    A.providerRetryAuditFields("end", { success: false, attempt: 1, finalError: secretError }),
    { dispatchToolCallId: "call-end", dispatchRunId: "dtr-end" },
  );
  const after = governor.snapshot();
  assert.deepEqual(after.counters, before.counters);
  assert.deepEqual(after.terminal, before.terminal);
  assert.equal(row.retry_phase, "end");
  assert.equal(row.retry_outcome, "exhausted");
  assert.equal(row.signal, "provider_retry_end");
  assert.equal(row.action, "audit_provider_retry_end_no_governor_transition");
  const serialized = JSON.stringify(row);
  for (const sensitive of ["HTTP 503", "secret-token", "must-not-leak", "password:x", "output=private"]) {
    assert.ok(!serialized.includes(sensitive), `end row leaked ${sensitive}`);
  }
});

await check("task/details projection joins worker_run_id directly from governance summary", () => {
  const terminationClosure = {
    lifecycle_path: "preflight",
    termination_owner: "preflight",
    termination_claimed_at_ms: null,
    closure_status: "not_applicable",
    closure_completed_at_ms: null,
    bounded_wait_ms: 0,
    bounded_wait_limit_ms: 0,
    run_settled: true,
    session_closure_done: null,
    cleanup_done: true,
    post_claim_provider_start_count: 0,
    post_claim_tool_start_count: 0,
  };
  const result = {
    workerRunGovernance: {
      worker_run_id: "worker-task-v5",
      rule_version: "dispatch-worker-run-governor/v2",
      counters: {},
      thresholds: {},
    },
    terminationClosure,
  };
  assert.deepEqual(D.dispatchAuditV5Fields(result), {
    worker_run_id: "worker-task-v5",
    termination_closure: terminationClosure,
  });
  assert.deepEqual(D.dispatchDetailsV5Fields(result), {
    workerRunId: "worker-task-v5",
    terminationClosure,
  });
});

await check("stream attribution remains unknown without explicit lifecycle evidence", () => {
  const result = { error: "stream disconnected", failureType: "aborted", stopReason: "aborted" };
  assert.equal(T.resolveCancelSource(result), "unknown");
  assert.equal(T.resolveTerminationSource(result), "unknown");
  assert.equal(T.resolveTerminationSource(result, { abortEvidence: "stream" }), "stream");
});

await check("workflow projects shared summary/evidence without recomputing lifecycle", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-audit-v5-workflow-"));
  const rows = [];
  const evidence = {
    lifecycle_path: "normal",
    termination_owner: "run",
    termination_claimed_at_ms: 1234,
    closure_status: "complete",
    closure_completed_at_ms: 1240,
    bounded_wait_ms: 6,
    bounded_wait_limit_ms: 3000,
    run_settled: true,
    session_closure_done: true,
    cleanup_done: true,
    post_claim_provider_start_count: 0,
    post_claim_tool_start_count: 0,
  };
  const governance = {
    worker_run_id: "worker-workflow-v5",
    rule_version: "dispatch-worker-run-governor/v2",
    counters: {},
    thresholds: {},
    termination_closure: evidence,
  };
  const result = await W.executeWorkflow({
    doc: { schema_version: 1, name: "audit-v5", stages: [{ id: "a", kind: "agent", prompt: "x" }] },
    runId: "workflow-v5",
    runDir,
    runner: async () => ({
      output: "ok",
      durationMs: 10,
      cleanupDone: true,
      terminationClosure: evidence,
      workerRunGovernance: governance,
    }),
    readOnly: true,
    defaultModel: "provider/model",
    defaultThinking: "off",
    audit: (row) => rows.push(row),
  });
  assert.equal(result.stages.a.worker_run_id, "worker-workflow-v5");
  assert.deepEqual(result.stages.a.termination_closure, evidence);
  const stageRow = rows.find((row) => row.event === "stage_terminal" && row.stage === "a");
  assert.equal(stageRow.worker_run_id, "worker-workflow-v5");
  assert.deepEqual(stageRow.termination_closure, evidence);
});

await check("v5 source is additive: v4 fields and legacy row semantics remain", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/index.ts"), "utf8");
  assert.match(source, /export const DISPATCH_AUDIT_VERSION = 5;/);
  for (const legacy of ["terminal_state", "termination_source", "active_tool_count", "last_tool", "result: result.error ? \"fail\" : \"ok\""]) {
    assert.ok(source.includes(legacy), `missing legacy v4 field/semantic: ${legacy}`);
  }
  assert.equal((source.match(/\.\.\.dispatchAuditV5Fields\(/g) ?? []).length, 4, "all four task row writers need v5 projection");
  assert.match(source, /worker_run_id: value\.workerRunGovernance\.worker_run_id/);
  assert.match(source, /post_claim_provider_start_count/);
  assert.match(source, /post_claim_tool_start_count/);
  assert.doesNotMatch(source, /terminationSource\s*=.*stopReason|cancelSource\s*=.*errorMessage/);
});

// ─────────────────────────────────────────────────────────────────────────────
// sdk-equivalent runInProcess retry audit regression — NOT production
// acceptance. This section drives the REAL SDK AgentSession auto_retry_start /
// auto_retry_end event path through D.runInProcess with a faux provider and
// asserts the provider_retry start/end audit rows written to
// <projectRoot>/.pi-astack/dispatch/audit.jsonl: real attempt/delay/outcome,
// closed error classification, keyless checksum fingerprint (never raw text),
// worker/run/call join, governor counting (start only), no prompt/tool
// args/output leakage, and no stream attribution fabricated from error text.
// It is equivalence evidence only: deterministic faux-provider inputs, no
// live provider, no production acceptance claim.
// ─────────────────────────────────────────────────────────────────────────────
const sdkTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-audit-v5-sdk-"));
const codingAgentDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const compatPath = path.join(codingAgentDist, "../node_modules/@earendil-works/pi-ai/dist/compat.js");
const Faux = await import(pathToFileURL(compatPath).href);
const sdkModelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
const sdkFaux = Faux.registerFauxProvider({
  provider: "faux-audit-v5-retry",
  tokensPerSecond: 0,
  models: [{ id: "audit-v5-retry-1", name: "Audit V5 Retry Faux", maxTokens: 16384 }],
});
const sdkFauxModel = sdkFaux.getModel();
sdkModelRuntime.registerProvider(sdkFauxModel.provider, {
  baseUrl: sdkFauxModel.baseUrl,
  api: sdkFauxModel.api,
  apiKey: "offline-smoke-key",
  authHeader: true,
  models: [{
    id: sdkFauxModel.id,
    name: sdkFauxModel.name,
    api: sdkFauxModel.api,
    reasoning: false,
    input: ["text", "image"],
    cost: sdkFauxModel.cost,
    contextWindow: sdkFauxModel.contextWindow,
    maxTokens: sdkFauxModel.maxTokens,
  }],
});
const sdkRegistry = new ModelRegistry(sdkModelRuntime);
const sdkModelName = `${sdkFauxModel.provider}/${sdkFauxModel.id}`;
// Fast deterministic backoff: keep the real SDK retry state machine, shrink
// only the sleep so the smoke completes in milliseconds, not seconds.
const sdkRetrySettings = SettingsManager.prototype.getRetrySettings;
SettingsManager.prototype.getRetrySettings = function auditV5FastRetry() {
  return { enabled: true, maxRetries: 3, baseDelayMs: 25 };
};

let sdkRows = [];
let sdkResult = null;
let sdkErrorPreview = null;

console.log("\n[sdk-equivalent runInProcess retry audit regression (not production acceptance)]");
try {
  await check("sdk-equivalent: auto_retry lifecycle writes provider_retry start/end audit rows with real attempt/delay/outcome/classification/checksum (not production acceptance)", async () => {
    const dispatchTrace = DT.createDispatchTraceSink({
      runId: "dtr-auditv5-retry-sdk",
      parentSessionId: "session-auditv5-retry-sdk",
      parentToolCallId: "call-auditv5-retry-sdk",
      taskIndex: 0,
    });
    const promptText = "execute the scripted faux response PROMPT-SECRET-123";
    const secretError = "HTTP 503 Bearer secret-token stream disconnected tool_args={password:x} output=private";
    sdkFaux.setResponses([
      Faux.fauxAssistantMessage([Faux.fauxText("partial before retry")], { stopReason: "error", errorMessage: secretError }),
      Faux.fauxAssistantMessage("retry recovered OUTPUT-SECRET-999"),
    ]);
    const providerBefore = sdkFaux.state.callCount;
    sdkResult = await D.runInProcess(
      sdkModelName, "off", promptText, new AbortController().signal, 3000, sdkRegistry, "read",
      {
        projectRoot: sdkTempRoot,
        parentContextFiles: [],
        maxRuntimeMs: 6000,
        reasoningTrace: { dispatchToolCallId: "call-auditv5-retry-sdk", taskIndex: 0, taskCount: 1 },
        dispatchTrace,
      },
    );
    // The retried call succeeded: a normal run-terminal, never rewritten into a
    // timeout/abort by the retryable error text (stream attribution unclaimed).
    assert.equal(sdkResult.error, undefined, `result.error=${JSON.stringify(sdkResult.error)}`);
    assert.ok(String(sdkResult.output).includes("OUTPUT-SECRET-999"), `output=${JSON.stringify(sdkResult.output)}`);
    assert.equal(sdkFaux.state.callCount - providerBefore, 2, `provider calls=${sdkFaux.state.callCount - providerBefore}`);
    assert.equal(sdkResult.terminationClosure?.termination_owner, "run", JSON.stringify(sdkResult.terminationClosure));
    assert.equal(sdkResult.terminationClosure?.lifecycle_path, "normal", JSON.stringify(sdkResult.terminationClosure));
    assert.equal(sdkResult.workerRunGovernance?.counters?.provider_retry_count, 1, JSON.stringify(sdkResult.workerRunGovernance?.counters));

    // Read the audit jsonl and wait for the async end-row append to land.
    const auditPath = path.join(sdkTempRoot, ".pi-astack", "dispatch", "audit.jsonl");
    assert.ok(fs.existsSync(auditPath), `audit.jsonl missing at ${auditPath}`);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      sdkRows = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (sdkRows.some((row) => row.signal === "provider_retry_end")) break;
      await sleep(25);
    }
    const startRows = sdkRows.filter((row) => row.signal === "provider_retry");
    const endRows = sdkRows.filter((row) => row.signal === "provider_retry_end");
    assert.equal(startRows.length, 1, `provider_retry start rows=${startRows.length}`);
    assert.equal(endRows.length, 1, `provider_retry_end rows=${endRows.length} (${sdkRows.map((row) => row.signal).join(",")})`);

    // Start row: real attempt/delay/outcome/classification/checksum fields.
    const startRow = startRows[0];
    assert.equal(startRow.retry_phase, "start");
    assert.equal(startRow.retry_attempt, 1);
    assert.equal(startRow.retry_max_attempts, 3);
    assert.equal(startRow.retry_delay_ms, 25);
    assert.equal(startRow.retry_outcome, "retrying");
    assert.equal(startRow.action, "audit_provider_retry_against_consecutive_and_rolling_budgets");
    // Classification/fingerprint must match the ACTUAL error text the SDK
    // delivered (observed via retryHistory.errorPreview), never the raw text.
    sdkErrorPreview = sdkResult.retryHistory?.entries?.[0]?.errorPreview;
    assert.equal(typeof sdkErrorPreview, "string", "retryHistory errorPreview missing");
    assert.ok(sdkErrorPreview.length > 0 && sdkErrorPreview.length < 120, `errorPreview truncated at ${sdkErrorPreview.length} chars`);
    assert.equal(startRow.error_classification, A.classifyProviderRetryError(sdkErrorPreview, 503), `classification for observed error: ${sdkErrorPreview}`);
    assert.deepEqual(
      startRow.error_fingerprint,
      AH.auditChecksumHex("dispatch/provider-retry-error/v1", sdkErrorPreview),
      JSON.stringify(startRow.error_fingerprint),
    );
  });

  await check("sdk-equivalent: provider_retry_end joins same worker/run/call and leaves governor provider_retry_count unchanged (not production acceptance)", async () => {
    assert.ok(sdkRows.length > 0, "no audit rows from the sdk-equivalent run (start-row check failed first)");
    const startRow = sdkRows.find((row) => row.signal === "provider_retry");
    const endRow = sdkRows.find((row) => row.signal === "provider_retry_end");
    assert.ok(startRow && endRow, "provider_retry start/end rows missing");

    // End row: additive recovered outcome, no fabricated HTTP/fingerprint.
    assert.equal(endRow.retry_phase, "end");
    assert.equal(endRow.retry_outcome, "recovered");
    assert.equal(endRow.error_classification, "none");
    assert.equal(endRow.retry_attempt, 1);
    assert.equal(endRow.action, "audit_provider_retry_end_no_governor_transition");
    assert.ok(!Object.hasOwn(endRow, "http_status"), "end row fabricated an HTTP status");
    assert.ok(!Object.hasOwn(endRow, "error_fingerprint"), "end row fabricated a fingerprint");

    // Join: same worker run, dispatch run, and tool call on both rows.
    const workerRunId = sdkResult?.workerRunGovernance?.worker_run_id;
    assert.equal(typeof workerRunId, "string", "worker_run_id missing from result governance summary");
    for (const row of [startRow, endRow]) {
      assert.equal(row.worker_run_id, workerRunId, JSON.stringify(row));
      assert.equal(row.dispatch_run_id, "dtr-auditv5-retry-sdk", JSON.stringify(row));
      assert.equal(row.dispatch_tool_call_id, "call-auditv5-retry-sdk", JSON.stringify(row));
      assert.equal(row.task_index, 0, JSON.stringify(row));
      assert.equal(row.task_count, 1, JSON.stringify(row));
      assert.equal(row.task, "dispatch[0]", JSON.stringify(row));
    }

    // Governor: provider_retry_count increments on start only; the end event
    // must not re-observe the governor (additive snapshot only).
    assert.equal(startRow.counters?.provider_retry_count, 1, JSON.stringify(startRow.counters));
    assert.equal(endRow.counters?.provider_retry_count, 1, `end row re-observed governor: ${JSON.stringify(endRow.counters)}`);
  });

  await check("sdk-equivalent: audit jsonl carries no raw error/prompt/tool args/output text and no fabricated stream attribution (not production acceptance)", async () => {
    assert.ok(sdkRows.length > 0, "no audit rows from the sdk-equivalent run (start-row check failed first)");
    const serialized = JSON.stringify(sdkRows);
    for (const sensitive of [
      "HTTP 503 Bearer secret-token stream disconnected tool_args={password:x} output=private",
      "secret-token",
      "PROMPT-SECRET-123",
      "tool_args={password:x}",
      "output=private",
      "OUTPUT-SECRET-999",
      "connection lost — ",
    ]) {
      assert.ok(!serialized.includes(sensitive), `audit jsonl leaked ${JSON.stringify(sensitive)}`);
    }
    // Error text (including stream-like wording) must never push a stream
    // attribution: no row claims a stream termination source, and the run
    // itself settled as a normal run-owner success (asserted above).
    for (const row of sdkRows) {
      assert.notEqual(row.termination_source, "stream", `fabricated stream source: ${JSON.stringify(row)}`);
      assert.notEqual(row.cancel_source, "stream", `fabricated stream source: ${JSON.stringify(row)}`);
    }
  });
} finally {
  SettingsManager.prototype.getRetrySettings = sdkRetrySettings;
  sdkFaux.unregister();
  sdkModelRuntime.unregisterProvider(sdkFauxModel.provider);
  fs.rmSync(sdkTempRoot, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Governor-disabled retry lifecycle regression — PARENT side. Spawns this same
// script in child mode with a temp HOME (real settings file copy + dispatch.
// workerRunGovernor.enabled=false) and PI_CODING_AGENT_DIR pinned to the real
// agent dir, so runInProcess resolves a genuinely disabled governor config
// through the real settings path. The child asserts start/end pairing, zero
// governor counters, no termination, no raw text, and no stream fabrication.
// The enabled sdk-equivalent section above still proves the governor count is
// added exactly once (provider_retry_count start 0→1, end unchanged).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[governor-disabled retry lifecycle regression (real SDK runInProcess + faux provider, workerRunGovernor.enabled=false)]");
await check("governor-disabled config: real SDK runInProcess retry start/end rows still pair (temp HOME child process)", async () => {
  const realAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const disabledHome = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-audit-v5-disabled-home-"));
  const disabledProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-audit-v5-disabled-"));
  try {
    // Real settings copy + dispatch.workerRunGovernor.enabled=false override so
    // the rest of the loaded extension stack keeps its production config and
    // only the governor enable switch is flipped.
    let rawSettings = {};
    const liveSettingsPath = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");
    if (fs.existsSync(liveSettingsPath)) {
      rawSettings = JSON.parse(fs.readFileSync(liveSettingsPath, "utf8"));
    }
    const disabledSettings = {
      ...rawSettings,
      dispatch: {
        ...(rawSettings.dispatch ?? {}),
        workerRunGovernor: {
          ...(rawSettings.dispatch?.workerRunGovernor ?? {}),
          enabled: false,
        },
      },
    };
    const settingsDir = path.join(disabledHome, ".pi", "agent");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, "pi-astack-settings.json"), JSON.stringify(disabledSettings, null, 2));
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--disabled-child", disabledHome, disabledProjectRoot],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120000,
        env: { ...process.env, HOME: disabledHome, PI_CODING_AGENT_DIR: realAgentDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const childOut = (child.stdout || "") + (child.stderr || "");
    if (child.status !== 0) {
      const tail = childOut.trim().split(/\n/).slice(-14).join("\n");
      throw new Error(`disabled-governor child exited ${child.status ?? child.error?.message ?? "unknown"}:\n${tail}`);
    }
  } finally {
    fs.rmSync(disabledHome, { recursive: true, force: true });
    fs.rmSync(disabledProjectRoot, { recursive: true, force: true });
  }
});

try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} dispatch audit v5 checks`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
process.exit(1);
