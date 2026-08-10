#!/usr/bin/env node
/**
 * S4 STORM-ENFORCE smoke (living plan 2026-08-10).
 *
 * The ONLY production-supported branch of the authorized rule
 * storm/post-cap-schema-rejection-signature/v1 is enforced: the exact
 * consecutive branch. The trigger is the full composite predicate — the same
 * strict exact composite signature in the same segment with
 * consecutive_count===4 && cap_after===3 && would_abort_basis==='consecutive'
 * — never would_abort / first_trip alone. Rolling-window trips NEVER enter
 * control (shadow-only). There is no total tool cap.
 *
 * Enforce requires governor.enabled && toolObservers.enabled &&
 * schemaErrorStorm.enabled && enforceConsecutiveExact && observeAfter===3.
 * The real abort decision flows through the governor's dedicated method
 * (enforceSchemaRejectionStorm, which never re-applies/increments counters)
 * → emitWorkerRunDecision → requestGovernorTermination →
 * FirstWriterTermination — no direct abort / tryClaim / new promise.
 *
 * Strict key unavailable → the schema classifier returns a safe closed
 * eligibility reason (strict_key_unavailable), the shadow candidate is not
 * eligible, enforce never triggers, and at most one worker_run_enforce_event
 * degradation row is written per run. Enforce enabled but observeAfter !== 3
 * → exactly one unsupported_cap marker per run, never an abort.
 *
 * Shadow rows stay mode=observe / counterfactual even when the consecutive
 * branch triggers; the governor's own schema_error_storm observer stays
 * observe-only and untouched.
 *
 * Real SDK runInProcess + faux provider: 4 consecutive same-signature schema
 * rejections — the 1st-3rd do NOT abort, the 4th aborts with
 * failureType=schema_rejection_storm_enforced (unique owner
 * worker_run_governor, cleanup done, post-claim provider/tool starts 0);
 * rolling-only A,A,B,A,A completes normally; rolling first trip then a later
 * consecutive 4 still aborts; observeAfter=5 never aborts + one
 * unsupported_cap marker; strict-key-unsafe dir never aborts + one
 * degradation row + no ephemeral signature.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { AgentSession, ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const S = await jiti.import(path.join(root, "extensions/dispatch/storm-shadow.ts"));
const G = await jiti.import(path.join(root, "extensions/dispatch/worker-run-governor.ts"));
const D = await jiti.import(path.join(root, "extensions/dispatch/index.ts"));
const DT = await jiti.import(path.join(root, "extensions/dispatch/dispatch-trace.ts"));
const AH = await jiti.import(path.join(root, "extensions/_shared/audit-hmac.ts"));
const TS = await jiti.import(path.join(root, "extensions/dispatch/terminal-state.ts"));

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

/** Make session_shutdown hang (never settle) for the duration of fn, so the
 *  bounded closure await is exercised while the run outcome is already fixed. */
async function withHangingSessionShutdown(fn) {
  const originalGetter = Object.getOwnPropertyDescriptor(AgentSession.prototype, "extensionRunner");
  let hangShutdown = true;
  Object.defineProperty(AgentSession.prototype, "extensionRunner", {
    configurable: true,
    get() {
      const real = originalGetter.get.call(this);
      if (!hangShutdown) return real;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "hasHandlers") {
            return (eventType) => eventType === "session_shutdown" ? true : target.hasHandlers(eventType);
          }
          if (prop === "emit") {
            return (event) => {
              if (event && typeof event === "object" && event.type === "session_shutdown") {
                return new Promise(() => {});
              }
              return target.emit(event);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(AgentSession.prototype, "extensionRunner", originalGetter);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-enforce-"));
const settings = {
  capAfter: S.DEFAULT_STORM_SHADOW_SETTINGS.capAfter,
  windowSize: S.STORM_SHADOW_WINDOW_SIZE,
  windowLimit: S.STORM_SHADOW_WINDOW_LIMIT,
};

// ── Opaque signatures (pre-projected exactly like the wiring builds them) ──
const sig = (toolName, errorClass, fieldPath, normalized) =>
  AH.auditHmacHexStrict(tempRoot, S.STORM_SHADOW_SIGNATURE_DOMAIN, JSON.stringify([toolName, errorClass, fieldPath, normalized]));
const A = sig("read", "missing_required", "path", "schema validation: required property 'path' is missing");
const B = sig("write", "missing_required", "path", "schema validation: required property 'path' is missing");
// Same tool/class/path, different bounded normalized descriptors (the real
// read tool's "Received arguments" JSON differs) — the P1 collision pair.
const A1 = sig("read", "missing_required", "must", "Validation failed for tool \"read\": - path: must have required properties path Received arguments: {}");
const A2 = sig("read", "missing_required", "must", "Validation failed for tool \"read\": - path: must have required properties path Received arguments: { \"limit\": 5 }");

// ── Pre-projected event factories (what the wiring feeds the state machine) ──
const rej = (signature = A) => ({ kind: "tool_execution_end", isError: true, schemaRejection: true, signature });
const toolOk = () => ({ kind: "tool_execution_end", isError: false, schemaRejection: false });
const visible = () => ({ kind: "assistant_response", hasVisibleText: true, completed: true, errorResponse: false, emptyVisibleRetry: false, toolUseOnly: false });

function run(events, extraSettings = settings) {
  const shadow = new S.StormShadow(extraSettings);
  const observations = events.map((event) => shadow.feed(event));
  return { observations, final: shadow.snapshot() };
}

// The S4 enforce predicate — mirrors the wiring predicate exactly: the same
// strict exact composite signature in the same segment with
// consecutive_count===4 && cap_after===3 && would_abort_basis==='consecutive'.
// Never would_abort / first_trip alone; rolling-window trips never match.
const enforcePredicate = (o) => o.consecutive_count === 4 && o.cap_after === 3 && o.would_abort_basis === "consecutive";

console.log("dispatch storm-rule enforce smoke\n");
console.log("[enforce predicate — pure state machine]");

await check("1st-3rd same-signature rejections never match the enforce predicate; the 4th does", () => {
  const { observations } = run([rej(), rej(), rej(), rej()]);
  assert.deepEqual(observations.map((o) => o.consecutive_count), [1, 2, 3, 4]);
  assert.deepEqual(observations.map((o) => o.would_abort), [false, false, false, true]);
  assert.deepEqual(observations.map(enforcePredicate), [false, false, false, true], "only the 4th consecutive same-signature rejection matches");
  assert.equal(observations[3].would_abort_basis, "consecutive");
  assert.equal(observations[3].cap_after, 3);
  assert.equal(observations[3].segment, 0, "same segment");
});

await check("rolling-only A,A,B,A,A produces a rolling shadow trip but never matches the consecutive predicate", () => {
  const { observations } = run([rej(A), rej(A), rej(B), rej(A), rej(A)]);
  const trips = observations.filter((o) => o.would_abort);
  assert.equal(trips.length, 1, JSON.stringify(observations.map((o) => ({ c: o.consecutive_count, w: o.window_count, a: o.would_abort, b: o.would_abort_basis }))));
  assert.equal(trips[0].would_abort_basis, "rolling_window");
  assert.equal(trips[0].first_trip, true);
  assert.ok(observations.every((o) => !enforcePredicate(o)), "rolling trip must never match the consecutive enforce predicate");
});

await check("rolling first trip then a later consecutive 4 still matches (even after rolling tripped)", () => {
  // A,A,B,A,A,A,A: the interleaved B breaks the consecutive streak, so the
  // rolling trip fires at the 5th event (window density 4) and the exact
  // consecutive 4 is reached at the 7th event — enforce must still match.
  const { observations } = run([rej(A), rej(A), rej(B), rej(A), rej(A), rej(A), rej(A)]);
  assert.deepEqual(observations.map(enforcePredicate), [false, false, false, false, false, false, true], "the 7th event (consecutive 4) matches even though rolling tripped at the 5th");
  assert.equal(observations[4].would_abort_basis, "rolling_window");
  assert.equal(observations[4].first_trip, true);
  assert.equal(observations[6].would_abort_basis, "consecutive");
  assert.equal(observations[6].consecutive_count, 4);
});

await check("different normalized descriptors never merge (A1/A2/A1/A2 never matches)", () => {
  const { observations } = run([rej(A1), rej(A2), rej(A1), rej(A2)]);
  assert.deepEqual(observations.map((o) => o.consecutive_count), [1, 1, 1, 1], "collision pair must never merge");
  assert.ok(observations.every((o) => !enforcePredicate(o)), "no same-signature consecutive 4 exists");
});

await check("successful tool resets: 3 rejections + success + 3 rejections never matches", () => {
  const { observations } = run([rej(), rej(), rej(), toolOk(), rej(), rej(), rej()]);
  assert.equal(observations[3].progress_verdict, "progress");
  assert.equal(observations[4].consecutive_count, 1, "success resets the streak");
  assert.ok(observations.every((o) => !enforcePredicate(o)), "no same-segment consecutive 4 exists");
});

await check("visible COMPLETED assistant response resets: 3 rejections + visible completion + 3 rejections never matches", () => {
  const { observations } = run([rej(), rej(), rej(), visible(), rej(), rej(), rej()]);
  assert.equal(observations[3].progress_verdict, "progress");
  assert.equal(observations[3].progress_basis, "visible_assistant_response");
  assert.equal(observations[4].consecutive_count, 1, "visible completion resets the streak");
  assert.ok(observations.every((o) => !enforcePredicate(o)));
});

await check("1000 rotating-signature rejections and successes never match (no total cap, no cross-signature merge)", () => {
  const signatures = [A, B, A1, A2, sig("ls", "missing_required", "path", "schema validation: required property 'path' is missing")];
  const events = [];
  for (let i = 0; i < 1000; i++) {
    events.push(rej(signatures[i % signatures.length]));
    if (i % 3 === 2) events.push(toolOk());
  }
  const { observations, final } = run(events);
  assert.ok(observations.every((o) => !enforcePredicate(o)), "no same-signature consecutive 4 across 1000 rotating events");
  assert.equal(final.tripped, false);
});

console.log("\n[governor enforce method — switch matrix and additive decision]");

const fullTrigger = (overrides = {}) => ({
  signature: A,
  segment: 0,
  consecutiveCount: 4,
  capAfter: 3,
  wouldAbortBasis: "consecutive",
  ...overrides,
});

await check("governor.enabled=false → no enforce decision", () => {
  const cfg = structuredClone(G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  cfg.enabled = false;
  const g = new G.WorkerRunGovernor("enforce-off", cfg);
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger()), undefined);
  assert.equal(g.terminalDecision, undefined);
});

await check("toolObservers.enabled=false → no enforce decision", () => {
  const cfg = structuredClone(G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  cfg.toolObservers.enabled = false;
  const g = new G.WorkerRunGovernor("enforce-tools-off", cfg);
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger()), undefined);
  assert.equal(g.terminalDecision, undefined);
});

await check("schemaErrorStorm.enabled=false → no enforce decision", () => {
  const cfg = structuredClone(G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  cfg.toolObservers.schemaErrorStorm.enabled = false;
  const g = new G.WorkerRunGovernor("enforce-schema-off", cfg);
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger()), undefined);
  assert.equal(g.terminalDecision, undefined);
});

await check("enforceConsecutiveExact=false → no enforce decision", () => {
  const cfg = structuredClone(G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  cfg.toolObservers.schemaErrorStorm.enforceConsecutiveExact = false;
  const g = new G.WorkerRunGovernor("enforce-exact-off", cfg);
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger()), undefined);
  assert.equal(g.terminalDecision, undefined);
});

await check("observeAfter=5 (enforce enabled) → no enforce decision (unsupported cap)", () => {
  const cfg = structuredClone(G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  cfg.toolObservers.schemaErrorStorm.observeAfter = 5;
  const g = new G.WorkerRunGovernor("enforce-unsupported-cap", cfg);
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger()), undefined);
  assert.equal(g.terminalDecision, undefined);
});

await check("rolling basis / wrong counts / wrong cap → no enforce decision", () => {
  const g = new G.WorkerRunGovernor("enforce-wrong-trigger", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger({ wouldAbortBasis: "rolling_window" })), undefined, "rolling basis must never enter control");
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger({ consecutiveCount: 3 })), undefined, "consecutive 3 is below the trigger");
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger({ capAfter: 5 })), undefined, "cap_after must be 3");
  assert.equal(g.terminalDecision, undefined);
});

await check("post-terminal / already-governor-terminal → no enforce decision", () => {
  const g = new G.WorkerRunGovernor("enforce-post-terminal", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  g.observe({ signal: "repetitive_output", action: "abort_session_return_bounded_partial" });
  assert.ok(g.terminalDecision, "governor must be terminal first");
  assert.equal(g.enforceSchemaRejectionStorm(fullTrigger()), undefined, "post-terminal must not emit");
});

await check("full trigger → abort decision with all additive fields and NO counter mutation", () => {
  const g = new G.WorkerRunGovernor("enforce-full", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  const before = g.snapshot();
  const decision = g.enforceSchemaRejectionStorm(fullTrigger());
  assert.ok(decision, "full trigger must produce an abort decision");
  assert.equal(decision.mode, "abort");
  assert.equal(decision.signal, "schema_rejection_storm_enforce");
  assert.equal(decision.failureType, "schema_rejection_storm_enforced");
  assert.equal(decision.termination_source, "worker_run_governor");
  assert.equal(decision.count, 4);
  assert.equal(decision.limit, 3);
  assert.equal(decision.budget_kind, "consecutive");
  assert.equal(decision.rule_id, "storm/post-cap-schema-rejection-signature/v1");
  assert.equal(decision.enforce_rule_version, "dispatch-storm-enforce/v1");
  assert.deepEqual(decision.signature_hmac, A);
  assert.equal(decision.segment, 0);
  assert.equal(decision.action, "abort_session_return_bounded_partial");
  // The enforce method never re-applies/increments governor counters.
  assert.deepEqual(g.snapshot().counters, before.counters, "enforce must not mutate governor counters");
  assert.equal(g.terminalDecision?.failureType, "schema_rejection_storm_enforced");
  // The audit row carries the additive fields.
  const row = G.buildWorkerRunAuditEvent(decision);
  assert.equal(row.signal, "schema_rejection_storm_enforce");
  assert.equal(row.mode, "abort");
  assert.equal(row.failure_type, "schema_rejection_storm_enforced");
  assert.equal(row.rule_id, "storm/post-cap-schema-rejection-signature/v1");
  assert.equal(row.enforce_rule_version, "dispatch-storm-enforce/v1");
  assert.deepEqual(row.signature_hmac, A);
  assert.equal(row.segment, 0);
  assert.equal(row.count, 4);
  assert.equal(row.limit, 3);
  assert.equal(row.budget_kind, "consecutive");
  assert.equal(row.termination_source, "worker_run_governor");
  // The governance summary projects the additive terminal fields.
  const summary = g.snapshot();
  assert.equal(summary.terminal?.failureType, "schema_rejection_storm_enforced");
  assert.equal(summary.terminal?.rule_id, "storm/post-cap-schema-rejection-signature/v1");
  assert.equal(summary.terminal?.enforce_rule_version, "dispatch-storm-enforce/v1");
  assert.equal(summary.terminal?.budget_kind, "consecutive");
  assert.equal(summary.terminal?.count, 4);
  assert.equal(summary.terminal?.limit, 3);
  assert.deepEqual(summary.terminal?.signature_hmac, A);
  assert.equal(summary.terminal?.segment, 0);
});

await check("degraded audit row (strict key unavailable) is a bounded worker_run_enforce_event projection", () => {
  const g = new G.WorkerRunGovernor("enforce-degraded", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  const row = G.buildStormEnforceDegradedAuditEvent(g.snapshot(), 123, { dispatchRunId: "dtr-x" });
  assert.equal(row.row_kind, "worker_run_enforce_event");
  assert.equal(row.signal, "schema_rejection_storm_enforce_degraded");
  assert.equal(row.mode, "observe");
  assert.equal(row.termination_source, "none");
  assert.equal(row.action, "audit_storm_enforce_degraded_strict_key_unavailable");
  assert.equal(row.rule_id, "storm/post-cap-schema-rejection-signature/v1");
  assert.equal(row.enforce_rule_version, "dispatch-storm-enforce/v1");
  assert.equal(row.dispatch_run_id, "dtr-x");
  assert.equal(g.terminalDecision, undefined, "degraded audit must never trigger termination");
});

await check("unsupported_cap marker row (observeAfter != 3) is a bounded worker_run_enforce_event projection", () => {
  const g = new G.WorkerRunGovernor("enforce-unsupported", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS);
  const row = G.buildStormEnforceUnsupportedCapAuditEvent(g.snapshot(), 0, {});
  assert.equal(row.row_kind, "worker_run_enforce_event");
  assert.equal(row.signal, "schema_rejection_storm_enforce_unsupported_cap");
  assert.equal(row.mode, "observe");
  assert.equal(row.termination_source, "none");
  assert.equal(row.action, "audit_storm_enforce_unsupported_cap_no_abort");
  assert.equal(row.observe_after, 3);
  assert.equal(g.terminalDecision, undefined, "unsupported_cap marker must never trigger termination");
});

console.log("\n[failure taxonomy / partial output]");

await check("schema_rejection_storm_enforced is in the failure taxonomy and renders partial output", () => {
  const partial = "PARTIAL_BEFORE_STORM_" + "Z".repeat(100);
  const text = D.formatResult("dispatch", "m", {
    output: partial,
    error: "schema rejection storm enforced: 4 consecutive same-signature rejections > limit 3",
    failureType: "schema_rejection_storm_enforced",
    durationMs: 100,
  });
  assert.ok(text.includes("[schema_rejection_storm_enforced]"), `missing failure prefix:\n${text}`);
  assert.ok(text.includes(partial), `schema_rejection_storm_enforced suppressed partial output:\n${text}`);
  // terminal-state attributes the failureType to worker_run_governor and maps
  // it to the failed terminal state.
  assert.equal(TS.resolveTerminationSource({ error: "x", failureType: "schema_rejection_storm_enforced" }), "worker_run_governor");
  assert.equal(TS.inferTerminalState({ error: "x", failureType: "schema_rejection_storm_enforced" }), "failed");
});

console.log("\n[source/behavior control-flow assertions]");

await check("storm-shadow.ts stays a pure state machine with no enforce surface", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/storm-shadow.ts"), "utf8");
  for (const forbidden of ["enforce", "requestGovernorTermination", "tryClaim", "AbortController", ".dispose(", ".abort(", "termination."]) {
    assert.ok(!source.includes(forbidden), `storm-shadow.ts must not reference ${forbidden}`);
  }
});

await check("the enforce decision flows ONLY through emitWorkerRunDecision → requestGovernorTermination → FirstWriterTermination", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/index.ts"), "utf8");
  // The enforce call site emits through the existing decision sink.
  assert.match(source, /if \(enforceDecision\) emitWorkerRunDecision\(enforceDecision\);/);
  // No direct abort / tryClaim / new promise / closure in the enforce wiring region.
  const start = source.indexOf("const shadowObservation = shadowFeed({");
  const end = source.indexOf("recordProgress(`event:${eventType}`)");
  assert.ok(start > 0 && end > start, "enforce wiring region missing");
  const region = source.slice(start, end);
  for (const forbidden of ["termination.tryClaim", "localCtl.abort", "new Promise", "startSessionClosure"]) {
    assert.ok(!region.includes(forbidden), `enforce wiring must not ${forbidden}`);
  }
  // The governor's dedicated method never re-applies/increments counters.
  const govSource = fs.readFileSync(path.join(root, "extensions/dispatch/worker-run-governor.ts"), "utf8");
  const methodStart = govSource.indexOf("enforceSchemaRejectionStorm(");
  const methodEnd = govSource.indexOf("snapshot(): WorkerRunGovernanceSummary");
  assert.ok(methodStart > 0 && methodEnd > methodStart, "enforceSchemaRejectionStorm missing");
  const method = govSource.slice(methodStart, methodEnd);
  for (const forbidden of ["applyCounter", "observeToolEnd", "schemaFailures", "successful_tool_response_count"]) {
    assert.ok(!method.includes(forbidden), `enforce method must not ${forbidden}`);
  }
  // The real abort path is intact and untouched (never hidden).
  assert.match(source, /if \(decision\.mode === "abort"\) requestGovernorTermination\(decision\);/);
  assert.match(source, /termination\.tryClaim\("worker_run_governor", result, "worker_run_governor"\)/);
});

await check("the enforce call is gated on the run being genuinely live (seal gate: !runTerminalSealed && termination.claim === undefined)", () => {
  const source = fs.readFileSync(path.join(root, "extensions/dispatch/index.ts"), "utf8");
  const start = source.indexOf("const shadowObservation = shadowFeed({");
  const end = source.indexOf("recordProgress(`event:${eventType}`)");
  assert.ok(start > 0 && end > start, "enforce wiring region missing");
  const region = source.slice(start, end);
  // The enforce call must be gated on the run being genuinely live: the run
  // terminal must not be sealed and no owner may have claimed. Otherwise a
  // fake abort decision would be constructed and persisted for an already
  // terminal run (sealed run-owned outcome or any owner claim).
  assert.match(
    region,
    /if \(shadowObservation && schemaShadow\.signature && !runTerminalSealed && termination\.claim === undefined\) \{/,
    "enforce call must be gated on !runTerminalSealed && termination.claim === undefined",
  );
  // The gate sits in the same branch immediately before the enforce call — no
  // other path can reach enforceSchemaRejectionStorm.
  const gateIdx = region.indexOf("!runTerminalSealed && termination.claim === undefined");
  const enforceIdx = region.indexOf("enforceSchemaRejectionStorm(");
  assert.ok(gateIdx > 0 && enforceIdx > gateIdx && enforceIdx - gateIdx < 400, "seal gate must precede the enforce call in the same branch");
  // FirstWriterTermination is untouched: the seal still only blocks external
  // claims via sealExternalClaims; the gate is wiring-side defense-in-depth.
  const fwt = source.slice(source.indexOf("export class FirstWriterTermination"), source.indexOf("export function providerFromModel"));
  assert.match(fwt, /sealExternalClaims\(\): void \{\s*this\.sealed = true;\s*\}/, "FirstWriterTermination seal semantics unchanged");
  assert.match(fwt, /if \(this\.sealed && owner !== "run"\) return false;/, "FirstWriterTermination claim gate unchanged");
});

console.log("\n[real SDK runInProcess + faux provider]");

const sdkTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-enforce-sdk-"));
fs.writeFileSync(path.join(sdkTempRoot, "ok.txt"), "hello storm enforce\n");
const codingAgentDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const compatPath = path.join(codingAgentDist, "../node_modules/@earendil-works/pi-ai/dist/compat.js");
const Faux = await import(pathToFileURL(compatPath).href);
const sdkModelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
const sdkFaux = Faux.registerFauxProvider({
  provider: "faux-storm-enforce",
  tokensPerSecond: 0,
  models: [{ id: "storm-enforce-1", name: "Storm Enforce Faux", maxTokens: 16384 }],
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

async function runSdk(scripted, runId, callId, sessionId, projectRoot = sdkTempRoot) {
  sdkFaux.setResponses(scripted);
  const dispatchTrace = DT.createDispatchTraceSink({
    runId,
    parentSessionId: sessionId,
    parentToolCallId: callId,
    taskIndex: 0,
  });
  const result = await D.runInProcess(
    sdkModelName, "off", "execute the scripted storm", new AbortController().signal, 8000, sdkRegistry, "read",
    {
      projectRoot,
      parentContextFiles: [],
      maxRuntimeMs: 20000,
      reasoningTrace: { dispatchToolCallId: callId, taskIndex: 0, taskCount: 1 },
      dispatchTrace,
    },
  );
  const auditPath = path.join(projectRoot, ".pi-astack", "dispatch", "audit.jsonl");
  assert.ok(fs.existsSync(auditPath), `audit.jsonl missing at ${auditPath}`);
  const deadline = Date.now() + 4000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (rows.some((row) => row.dispatch_run_id === runId && row.row_kind === "task")) break;
    await sleep(25);
  }
  return { result, rows: rows.filter((row) => row.dispatch_run_id === runId) };
}

try {
  await check("real SDK: 1st-3rd same-signature rejections do NOT abort; the 4th aborts with schema_rejection_storm_enforced (unique owner, cleanup, post-claim 0)", async () => {
    const run = { runId: "dtr-storm-enforce-4", callId: "call-storm-enforce-4", sessionId: "session-storm-enforce-4" };
    const { result, rows } = await runSdk([
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
    ], run.runId, run.callId, run.sessionId);
    // The run aborted on the 4th rejection with the enforce failure taxonomy.
    assert.equal(result.failureType, "schema_rejection_storm_enforced", JSON.stringify(result));
    assert.match(result.error ?? "", /schema rejection storm enforced/);
    assert.equal(result.terminationClosure?.termination_owner, "worker_run_governor", JSON.stringify(result.terminationClosure));
    assert.equal(result.terminationClosure?.lifecycle_path, "abnormal", JSON.stringify(result.terminationClosure));
    assert.equal(result.terminationClosure?.closure_status, "complete", JSON.stringify(result.terminationClosure));
    assert.equal(result.terminationClosure?.cleanup_done, true, JSON.stringify(result.terminationClosure));
    assert.equal(result.terminationClosure?.post_claim_provider_start_count, 0, JSON.stringify(result.terminationClosure));
    assert.equal(result.terminationClosure?.post_claim_tool_start_count, 0, JSON.stringify(result.terminationClosure));
    assert.equal(result.workerRunGovernance?.terminal?.failureType, "schema_rejection_storm_enforced");
    assert.equal(result.workerRunGovernance?.terminal?.rule_id, "storm/post-cap-schema-rejection-signature/v1");
    assert.equal(result.workerRunGovernance?.terminal?.enforce_rule_version, "dispatch-storm-enforce/v1");
    assert.equal(result.workerRunGovernance?.terminal?.budget_kind, "consecutive");
    assert.equal(result.workerRunGovernance?.terminal?.count, 4);
    assert.equal(result.workerRunGovernance?.terminal?.limit, 3);
    // Shadow rows: 4 schema rejections, ALL mode observe/counterfactual even
    // the one that triggered enforce.
    const shadowRows = rows.filter((row) => row.signal === "storm_shadow");
    const rejections = shadowRows.filter((row) => row.progress_basis === "schema_rejection");
    assert.equal(rejections.length, 4, JSON.stringify(shadowRows.map((r) => [r.event_kind, r.consecutive_count, r.would_abort])));
    assert.deepEqual(rejections.map((r) => r.consecutive_count), [1, 2, 3, 4]);
    assert.deepEqual(rejections.map((r) => r.would_abort), [false, false, false, true]);
    assert.ok(rejections.every((r) => r.mode === "observe" && r.counterfactual_action === "would_abort_only_no_control_effect"), "shadow rows stay observe/counterfactual even when consecutive triggers");
    assert.equal(rejections[3].would_abort_basis, "consecutive");
    assert.equal(rejections[3].cap_after, 3);
    assert.equal(rejections[3].segment, 0);
    // The enforce decision row carries the additive fields.
    const enforceRows = rows.filter((row) => row.signal === "schema_rejection_storm_enforce");
    assert.equal(enforceRows.length, 1, JSON.stringify(rows.map((r) => r.signal)));
    const er = enforceRows[0];
    assert.equal(er.mode, "abort");
    assert.equal(er.failure_type, "schema_rejection_storm_enforced");
    assert.equal(er.rule_id, "storm/post-cap-schema-rejection-signature/v1");
    assert.equal(er.enforce_rule_version, "dispatch-storm-enforce/v1");
    assert.equal(er.count, 4);
    assert.equal(er.limit, 3);
    assert.equal(er.budget_kind, "consecutive");
    assert.equal(er.segment, 0);
    assert.equal(er.termination_source, "worker_run_governor");
    assert.equal(er.action, "abort_session_return_bounded_partial");
    assert.match(er.signature_hmac?.digest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(er.signature_hmac?.key_id, rejections[0].signature_hmac?.key_id, "enforce signature must be the same strict project key as the shadow rows");
    // The governor's own schema observer stayed observe-only and untouched.
    const govStorm = rows.filter((row) => row.signal === "schema_error_storm");
    assert.ok(govStorm.length >= 1 && govStorm.every((row) => row.mode === "observe"), "governor schema_error_storm stays observe-only");
  });

  await check("real SDK: rolling-only A,A,B,A,A produces a rolling shadow trip but the run completes normally (rolling never enters control)", async () => {
    const run = { runId: "dtr-storm-enforce-rolling", callId: "call-storm-enforce-rolling", sessionId: "session-storm-enforce-rolling" };
    const { result, rows } = await runSdk([
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { limit: 5 })], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { path: "ok.txt", limit: 5 })], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage("final normal completion"),
    ], run.runId, run.callId, run.sessionId);
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.equal(result.failureType, undefined, JSON.stringify(result.failureType));
    assert.equal(result.output, "final normal completion", JSON.stringify(result.output));
    assert.equal(result.terminationClosure?.termination_owner, "run", JSON.stringify(result.terminationClosure));
    assert.equal(result.terminationClosure?.cleanup_done, true, JSON.stringify(result.terminationClosure));
    // The rolling trip produced a shadow row with basis rolling_window and NO
    // enforce row — rolling never enters control.
    const shadowRows = rows.filter((row) => row.signal === "storm_shadow");
    const rollingTrip = shadowRows.find((row) => row.would_abort === true);
    assert.ok(rollingTrip, "rolling trip shadow row must exist");
    assert.equal(rollingTrip.would_abort_basis, "rolling_window");
    assert.equal(rows.filter((row) => row.signal === "schema_rejection_storm_enforce").length, 0, "rolling trip must never enter control");
  });

  await check("real SDK: rolling first trip then a later consecutive 4 still aborts (even after rolling tripped)", async () => {
    const run = { runId: "dtr-storm-enforce-roll-then-consec", callId: "call-storm-enforce-roll-then-consec", sessionId: "session-storm-enforce-roll-then-consec" };
    // A,A,B,A,A,A,A: the interleaved read({limit:5}) breaks the consecutive
    // streak, so the rolling trip fires at the 5th rejection and the exact
    // consecutive 4 is reached at the 7th — the run aborts there.
    const { result, rows } = await runSdk([
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { limit: 5 })], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
    ], run.runId, run.callId, run.sessionId);
    assert.equal(result.failureType, "schema_rejection_storm_enforced", JSON.stringify(result));
    // The rolling trip shadow row exists AND the enforce row exists.
    const shadowRows = rows.filter((row) => row.signal === "storm_shadow");
    const rollingTrip = shadowRows.find((row) => row.would_abort === true && row.would_abort_basis === "rolling_window");
    assert.ok(rollingTrip, "rolling trip shadow row must exist");
    const enforceRows = rows.filter((row) => row.signal === "schema_rejection_storm_enforce");
    assert.equal(enforceRows.length, 1, JSON.stringify(rows.map((r) => r.signal)));
    assert.equal(enforceRows[0].count, 4);
    assert.equal(enforceRows[0].budget_kind, "consecutive");
  });

  await check("real SDK: observeAfter=5 (enforce enabled) never aborts and writes exactly one unsupported_cap marker", async () => {
    const settingsHome = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-enforce-home-"));
    const agentDir = path.join(settingsHome, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "pi-astack-settings.json"), JSON.stringify({
      dispatch: { workerRunGovernor: { toolObservers: { schemaErrorStorm: { observeAfter: 5 } } } },
    }));
    const prevHome = process.env.HOME;
    const prevUserprofile = process.env.USERPROFILE;
    try {
      process.env.HOME = settingsHome;
      process.env.USERPROFILE = settingsHome;
      const run = { runId: "dtr-storm-enforce-unsupported", callId: "call-storm-enforce-unsupported", sessionId: "session-storm-enforce-unsupported" };
      const { result, rows } = await runSdk([
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { path: "ok.txt", limit: 5 })], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage("final normal completion"),
      ], run.runId, run.callId, run.sessionId);
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.equal(result.failureType, undefined, JSON.stringify(result.failureType));
      assert.equal(result.output, "final normal completion", JSON.stringify(result.output));
      const markers = rows.filter((row) => row.signal === "schema_rejection_storm_enforce_unsupported_cap");
      assert.equal(markers.length, 1, JSON.stringify(rows.map((r) => r.signal)));
      assert.equal(markers[0].row_kind, "worker_run_enforce_event");
      assert.equal(markers[0].observe_after, 5);
      assert.equal(rows.filter((row) => row.signal === "schema_rejection_storm_enforce").length, 0, "unsupported cap must never abort");
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUserprofile;
      fs.rmSync(settingsHome, { recursive: true, force: true });
    }
  });

  await check("real SDK in an unsafe dir (strict key unavailable): no abort, exactly one degradation row, no ephemeral signature", async () => {
    const unsafeSdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-storm-enforce-unsafe-"));
    fs.writeFileSync(path.join(unsafeSdkRoot, "ok.txt"), "hello storm enforce\n");
    fs.mkdirSync(path.join(unsafeSdkRoot, ".pi-astack"), { mode: 0o700 });
    fs.mkdirSync(path.join(unsafeSdkRoot, ".pi-astack", "llm-audit"), { mode: 0o755 });
    try {
      const run = { runId: "dtr-storm-enforce-unsafe", callId: "call-storm-enforce-unsafe", sessionId: "session-storm-enforce-unsafe" };
      const { result, rows } = await runSdk([
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage([Faux.fauxToolCall("read", { path: "ok.txt", limit: 5 })], { stopReason: "toolUse" }),
        Faux.fauxAssistantMessage("final normal completion"),
      ], run.runId, run.callId, run.sessionId, unsafeSdkRoot);
      // Control flow is unaffected: the run completes normally even though the
      // strict key is unavailable and every schema rejection failed open.
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.equal(result.failureType, undefined, JSON.stringify(result.failureType));
      assert.equal(result.output, "final normal completion", JSON.stringify(result.output));
      assert.equal(result.terminationClosure?.lifecycle_path, "normal", JSON.stringify(result.terminationClosure));
      assert.equal(result.terminationClosure?.cleanup_done, true, JSON.stringify(result.terminationClosure));
      // Exactly one degradation row, never an abort.
      const degraded = rows.filter((row) => row.signal === "schema_rejection_storm_enforce_degraded");
      assert.equal(degraded.length, 1, JSON.stringify(rows.map((r) => r.signal)));
      assert.equal(degraded[0].row_kind, "worker_run_enforce_event");
      assert.equal(degraded[0].action, "audit_storm_enforce_degraded_strict_key_unavailable");
      assert.equal(rows.filter((row) => row.signal === "schema_rejection_storm_enforce").length, 0, "strict-key-unavailable must never abort");
      // No ephemeral key ever reaches the audit; no shadow signature exists.
      const serialized = JSON.stringify(rows);
      assert.ok(!serialized.includes("ephemeral-"), "no ephemeral key_id may ever reach the audit");
      const shadowRows = rows.filter((row) => row.signal === "storm_shadow");
      assert.equal(shadowRows.filter((row) => row.signature_hmac).length, 0, "no shadow signature when strict key unavailable");
    } finally {
      fs.rmSync(unsafeSdkRoot, { recursive: true, force: true });
    }
  });

  await check("real SDK: a late schema rejection after the run terminal is sealed never constructs/persists a fake enforce abort decision", async () => {
    // Reach the sealed-but-not-claimed state: the real prompt processes 3
    // schema rejections, then 4 provider errors exhaust the SDK retry budget
    // and the prompt throws — the catch path seals the run terminal
    // synchronously WITHOUT any owner claim (terminationRequested stays
    // false), and the bounded closure await (hanging session_shutdown) opens
    // a window for a late tool_execution_end. The wiring must not build and
    // persist an abort decision for an already-terminal run — the seal gate
    // (!runTerminalSealed && termination.claim === undefined) blocks it while
    // the shadow state machine still counts the late rejection.
    let capturedCallback;
    const originalSubscribe = AgentSession.prototype.subscribe;
    AgentSession.prototype.subscribe = function patchedSubscribe(cb) {
      capturedCallback = cb;
      return originalSubscribe.call(this, cb);
    };
    const originalRetry = SettingsManager.prototype.getRetrySettings;
    SettingsManager.prototype.getRetrySettings = function fastRetry() {
      return { enabled: true, maxRetries: 3, baseDelayMs: 25 };
    };
    try {
      await withHangingSessionShutdown(async () => {
        const run = { runId: "dtr-storm-enforce-seal-gate", callId: "call-storm-enforce-seal-gate", sessionId: "session-storm-enforce-seal-gate" };
        const pending = runSdk([
          Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
          Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
          Faux.fauxAssistantMessage([Faux.fauxToolCall("read", {})], { stopReason: "toolUse" }),
          Faux.fauxAssistantMessage([Faux.fauxText("partial before error")], { stopReason: "error", errorMessage: "provider rate limit exceeded" }),
          Faux.fauxAssistantMessage([Faux.fauxText("partial before error")], { stopReason: "error", errorMessage: "provider rate limit exceeded" }),
          Faux.fauxAssistantMessage([Faux.fauxText("partial before error")], { stopReason: "error", errorMessage: "provider rate limit exceeded" }),
          Faux.fauxAssistantMessage([Faux.fauxText("partial before error")], { stopReason: "error", errorMessage: "provider rate limit exceeded" }),
        ], run.runId, run.callId, run.sessionId);
        // Wait for the run to process the 3 real schema rejections (shadow rows
        // written), then let the retries exhaust + prompt throw + catch path
        // seal + closure start (hanging shutdown opens a bounded window).
        const auditPath = path.join(sdkTempRoot, ".pi-astack", "dispatch", "audit.jsonl");
        const deadline = Date.now() + 5000;
        let rejectionRows = [];
        while (Date.now() < deadline) {
          if (fs.existsSync(auditPath)) {
            const all = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
            rejectionRows = all.filter((r) => r.dispatch_run_id === run.runId && r.signal === "storm_shadow" && r.progress_basis === "schema_rejection");
            if (rejectionRows.length >= 3) break;
          }
          await sleep(25);
        }
        assert.ok(rejectionRows.length >= 3, `run must process 3 rejections first: ${JSON.stringify(rejectionRows.map((r) => r.consecutive_count))}`);
        await sleep(500); // retries exhaust + prompt throw + seal + closure start
        assert.ok(capturedCallback, "subscribe callback must have been captured");
        // Inject a 4th same-signature schema rejection AFTER the run terminal
        // is sealed. The shadow state machine still counts it (would_abort)
        // but the seal gate must prevent any enforce abort decision from being
        // built and persisted.
        capturedCallback({
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "late-tc",
          isError: true,
          result: { content: [{ type: "text", text: "Validation failed for tool \"read\":\n  - path: must have required properties path\n\nReceived arguments:\n{}" }] },
        });
        const { result, rows } = await pending;
        // The run failed with the provider error — never the storm enforce.
        assert.notEqual(result.failureType, "schema_rejection_storm_enforced", JSON.stringify(result));
        assert.ok(result.error, `run must have failed: ${JSON.stringify(result)}`);
        // The late event WAS processed by the shadow (4th rejection,
        // would_abort=true) — proving the callback ran — but NO enforce
        // decision was persisted.
        const shadowRows = rows.filter((row) => row.signal === "storm_shadow");
        const lateRejection = shadowRows.find((row) => row.consecutive_count === 4 && row.would_abort === true);
        assert.ok(lateRejection, `late 4th rejection must be shadow-counted: ${JSON.stringify(shadowRows.map((r) => [r.consecutive_count, r.would_abort, r.progress_basis]))}`);
        assert.equal(lateRejection.would_abort_basis, "consecutive");
        assert.equal(rows.filter((row) => row.signal === "schema_rejection_storm_enforce").length, 0, "seal gate must prevent a fake enforce abort decision");
      });
    } finally {
      AgentSession.prototype.subscribe = originalSubscribe;
      SettingsManager.prototype.getRetrySettings = originalRetry;
    }
  });
} finally {
  sdkFaux.unregister();
  sdkModelRuntime.unregisterProvider(sdkFauxModel.provider);
  fs.rmSync(sdkTempRoot, { recursive: true, force: true });
}

try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} dispatch storm-enforce checks`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
process.exit(1);
