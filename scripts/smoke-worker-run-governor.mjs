#!/usr/bin/env node
/** Offline worker-run governor v2 smoke, plus a local faux AgentSession race. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const V = await jiti.import(path.join(root, "extensions/_shared/visible-text-repeat-detector.ts"));
const G = await jiti.import(path.join(root, "extensions/dispatch/worker-run-governor.ts"));
const D = await jiti.import(path.join(root, "extensions/dispatch/index.ts"));

let pass = 0;
let fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`); }
}
function unitOf(period) {
  return Array.from({ length: period }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
}
function threshold(period) {
  if (period <= 16) return Math.max(4096, period * 64);
  if (period <= 128) return Math.max(6144, period * 16);
  if (period <= 1024) return Math.max(8192, period * 8);
  return Math.max(24576, period * 6);
}
function chunks(value, seed = 0x12345678) {
  const out = [];
  let i = 0;
  let x = seed >>> 0;
  while (i < value.length) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const size = 1 + (x % 311);
    out.push(value.slice(i, i + size));
    i += size;
  }
  return out;
}
function feed(value, seed) {
  const detector = new V.VisibleTextRepeatDetector();
  detector.messageStart();
  let verdict = { trip: false };
  for (const chunk of chunks(value, seed)) {
    verdict = detector.pushDelta(chunk);
    if (verdict.trip) break;
  }
  if (!verdict.trip) verdict = detector.messageEnd();
  return { detector, verdict };
}
function fnv1a32(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function nonRepeatingFixture(length, seed) {
  let x = seed >>> 0;
  const parts = [];
  for (let offset = 0; offset < length; offset += 8192) {
    let part = "";
    const width = Math.min(8192, length - offset);
    for (let i = 0; i < width; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      part += String.fromCharCode(33 + ((x >>> 0) % 90));
    }
    parts.push(part);
  }
  return parts.join("");
}
function measureDetector(value) {
  const detector = new V.VisibleTextRepeatDetector();
  detector.messageStart();
  const heapStart = process.memoryUsage().heapUsed;
  let maxHeap = heapStart;
  const started = performance.now();
  let verdict = { trip: false };
  for (let offset = 0, n = 0; offset < value.length; offset += 4093, n++) {
    verdict = detector.pushDelta(value.slice(offset, offset + 4093));
    if ((n & 15) === 0) maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
    if (verdict.trip) break;
  }
  if (!verdict.trip) verdict = detector.messageEnd();
  maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
  return { verdict, elapsedMs: performance.now() - started, heapGrowth: Math.max(0, maxHeap - heapStart) };
}

async function realAgentSessionEmptyRaceSmoke() {
  const Pi = await import("@earendil-works/pi-coding-agent");
  const codingAgentDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const compatPath = path.join(codingAgentDist, "../node_modules/@earendil-works/pi-ai/dist/compat.js");
  const Faux = await import(pathToFileURL(compatPath).href);
  const settingsManager = Pi.SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 8, baseDelayMs: 1 },
    compaction: { enabled: false },
  });
  // pi 0.80.10: AuthStorage / ModelRegistry.inMemory are no longer the public
  // createAgentSession path. Use ModelRuntime + registerProvider so faux has
  // configured auth (setRuntimeApiKey alone is not enough — getAuth requires
  // the provider to exist in the runtime catalog).
  if (typeof Pi.ModelRuntime?.create !== "function") {
    throw new Error("ModelRuntime.create missing — need @earendil-works/pi-coding-agent >= 0.80.10");
  }
  const modelRuntime = await Pi.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const resourceLoader = new Pi.DefaultResourceLoader({
    cwd: root,
    agentDir: fs.mkdtempSync(path.join(os.tmpdir(), "worker-governor-agent-")),
    settingsManager,
    systemPromptOverride: () => "Offline worker governor smoke.",
    extensionFactories: [(pi) => {
      pi.on("message_end", (event) => {
        const message = event.message;
        if (message?.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) return;
        const text = message.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
        if (text.trim() !== "" || !message.content.some((part) => part?.type === "text")) return;
        return { message: { ...message, stopReason: "error", errorMessage: "provider returned error: ended without visible assistant text after thinking" } };
      });
    }],
  });
  await resourceLoader.reload();

  const faux = Faux.registerFauxProvider({ tokensPerSecond: 0 });
  const fauxModel = faux.getModel();
  modelRuntime.registerProvider("faux", {
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
  faux.setResponses(Array.from({ length: 8 }, () => Faux.fauxAssistantMessage([{ type: "text", text: "" }])));
  const governor = new G.WorkerRunGovernor("real-agent-empty", "read_only", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS, root);
  let session;
  let terminalCallCount;
  let terminalMessage;
  let autoRetryStartCount = 0;
  let autoRetryStartsAfterTerminal = 0;
  try {
    ({ session } = await Pi.createAgentSession({
      cwd: root,
      model: fauxModel,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: Pi.SessionManager.inMemory(root),
      tools: [],
    }));
    void governor.termination.then(() => session.abort());
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") {
        autoRetryStartCount++;
        if (terminalCallCount !== undefined) autoRetryStartsAfterTerminal++;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      if (event.message.errorMessage !== "provider returned error: ended without visible assistant text after thinking") return;
      const decision = governor.observe({ signal: "empty_visible_retry", action: "count_empty_visible_retry" });
      if (decision?.mode === "abort") {
        D.markGovernorTerminalAssistantMessage(event.message, decision);
        terminalCallCount = faux.state.callCount;
        terminalMessage = { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage };
      }
    });
    try { await session.prompt("return an empty response"); } catch { /* terminal abort may reject prompt */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      terminalCallCount,
      finalCallCount: faux.state.callCount,
      autoRetryStartCount,
      autoRetryStartsAfterTerminal,
      terminalMessage,
      terminal: governor.terminalDecision,
    };
  } finally {
    try { session?.dispose(); } catch { /* best effort */ }
    faux.unregister();
  }
}

console.log("worker-run governor v2 smoke\n");
console.log("[visible exact-tail]");
for (const period of [1, 7, 80, 144, 1000, 4096]) {
  const chars = threshold(period) + period + 512;
  const text = unitOf(period).repeat(Math.ceil(chars / period));
  const a = feed(text, period * 17 + 3).verdict;
  const b = feed(text, period * 29 + 11).verdict;
  check(`period ${period} trips across random chunkings`, a.trip && b.trip, JSON.stringify({ a, b }));
  check(`period ${period} exact period/threshold`, a.metrics?.period === period && a.metrics.repeated_chars >= threshold(period), JSON.stringify(a.metrics));
}

const whitespaceUnit = "甲\t乙\n\r\n丙\u00a0😀丁";
const whitespaceText = whitespaceUnit.repeat(2000);
const wholeWhitespace = V.scanVisibleTextForRepeat(whitespaceText);
const splitWhitespace = feed(whitespaceText, 99).verdict;
check("incremental Unicode whitespace collapse is chunk-boundary independent", wholeWhitespace.trip === splitWhitespace.trip && wholeWhitespace.metrics?.period === splitWhitespace.metrics?.period);

const structuredUnits = {
  code: "const value = input[index] ?? 0;\n",
  json: '{"id":1,"status":"ok"}\n',
  log: "2026-07-11T10:08:00Z ERROR request=42 status=500\n",
  table: "| 42 | repeated-row | failed |\n",
  diff: "- old repeated value\n+ new repeated value\n",
  base64: `${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(3)}=\n`,
};
for (const [name, unit] of Object.entries(structuredUnits)) {
  const detector = new V.VisibleTextRepeatDetector();
  detector.messageStart();
  const verdict = detector.pushDelta(unit.repeat(Math.ceil(30000 / unit.length)));
  const snapshot = detector.snapshot();
  check(`repeating structured ${name} remains observe-only at ordinary thresholds`, !verdict.trip && snapshot.candidate_structured_ratio >= 0.6, JSON.stringify(snapshot));
}
const structuredUnit = structuredUnits.json;
const structuredDetector = new V.VisibleTextRepeatDetector();
structuredDetector.messageStart();
let structured = structuredDetector.pushDelta(structuredUnit.repeat(Math.ceil(130000 / structuredUnit.length)));
check("structured repetition does not trip before 131072 repeated chars", !structured.trip, JSON.stringify(structured.metrics));
structured = structuredDetector.pushDelta(structuredUnit.repeat(200));
if (!structured.trip) structured = structuredDetector.messageEnd();
check("structured repetition trips only at elevated threshold and >=32 rounds", structured.trip && structured.metrics?.structured && structured.metrics.repeated_chars >= 131072 && structured.metrics.rounds >= 32, JSON.stringify(structured.metrics));

const normalFixtures = {
  chinese: Array.from({ length: 7000 }, (_, i) => `第${i}段讨论不同的工程约束与验证证据。`).join("\n"),
  code: Array.from({ length: 3500 }, (_, i) => `const value_${i} = input[${i}] ?? ${i};`).join("\n"),
  json: JSON.stringify(Array.from({ length: 3500 }, (_, i) => ({ id: i, value: `v${i}` }))),
  log: Array.from({ length: 3500 }, (_, i) => `2026-07-11T10:${String(i % 60).padStart(2, "0")}:00Z INFO request=${i} status=${200 + (i % 5)}`).join("\n"),
  table: ["| id | value |", "|---:|:------|", ...Array.from({ length: 3500 }, (_, i) => `| ${i} | row-${i} |`)].join("\n"),
  diff: Array.from({ length: 3500 }, (_, i) => `-${i}: old-${i}\n+${i}: new-${i}`).join("\n"),
};
for (const [name, text] of Object.entries(normalFixtures)) {
  check(`normal long ${name} does not trip`, !feed(text, text.length).verdict.trip);
}
const bounded = feed(normalFixtures.chinese.repeat(2), 44).detector.snapshot();
check("normalized ring remains bounded to 64 KiB", bounded.ring_chars <= V.VISIBLE_TEXT_RING_CHARS, JSON.stringify(bounded));

const finalOnly = V.scanVisibleTextForRepeat(unitOf(144).repeat(100));
check("final-only one-shot fallback detects exact repeat", finalOnly.trip && finalOnly.metrics?.period === 144);
const streamedNormal = feed("这是流式正常文本。".repeat(50), 5).verdict;
const mismatchedFinal = V.scanVisibleTextForRepeat(unitOf(80).repeat(120));
check("stream/final mismatch can be scanned independently", !streamedNormal.trip && mismatchedFinal.trip);

const isolatedA = new V.VisibleTextRepeatDetector();
const isolatedB = new V.VisibleTextRepeatDetector();
isolatedA.messageStart(); isolatedB.messageStart();
const isolatedTrip = isolatedA.pushDelta(unitOf(7).repeat(700));
const isolatedNormal = isolatedB.pushDelta("互不相同的正常输出 1 2 3");
check("visible detector state is isolated per worker", isolatedTrip.trip && !isolatedNormal.trip && !isolatedB.snapshot().tripped);

const syntheticUnit = unitOf(144);
const synthetic = syntheticUnit.repeat(Math.ceil(286236 / syntheticUnit.length)).slice(0, 286236);
const syntheticRun = feed(synthetic, 20260711).verdict;
check("286236-char period-144 synthetic trips by 24576 repeated-tail chars", syntheticRun.trip && syntheticRun.metrics?.period === 144 && syntheticRun.metrics.repeated_chars <= 24576, JSON.stringify(syntheticRun.metrics));
const boundedResult = D.buildRepetitiveOutputPartial(synthetic, syntheticRun.metrics);
check("dispatch repetitive partial is UTF-8 bounded and excludes the complete tail", Buffer.byteLength(boundedResult, "utf8") < Buffer.byteLength(synthetic, "utf8") && !boundedResult.includes(synthetic) && boundedResult.includes("signal=repetitive_output"));
const multibytePartial = D.buildRepetitiveOutputPartial("汉😀".repeat(40000), syntheticRun.metrics);
check("dispatch repetitive partial including marker is strictly <=65536 UTF-8 bytes", Buffer.byteLength(multibytePartial, "utf8") <= 65536, String(Buffer.byteLength(multibytePartial, "utf8")));
check("UTF-8 partial truncation preserves complete code points", Buffer.from(multibytePartial, "utf8").toString("utf8") === multibytePartial && !multibytePartial.includes("�"));

const framedCycle = unitOf(80).repeat(120);
const laterStructured = `${'{"later":true,"kind":"log"}\n2026-07-11T10:08:00Z ERROR secret=late\n'.repeat(5000)}`;
const framedWholeDetector = new V.VisibleTextRepeatDetector();
framedWholeDetector.messageStart();
let framedWhole = framedWholeDetector.pushDelta(framedCycle + laterStructured);
if (!framedWhole.trip) framedWhole = framedWholeDetector.messageEnd();
const framedSplit = feed(framedCycle + laterStructured, 0x7f3c).verdict;
check("single large delta cannot classify an earlier CJK cycle using later JSON/log text", framedWhole.trip && framedWhole.metrics?.structured === false, JSON.stringify(framedWhole.metrics));
check("single delta and random splits trip at identical framed position and metrics", JSON.stringify(framedWhole.metrics) === JSON.stringify(framedSplit.metrics), JSON.stringify({ whole: framedWhole.metrics, split: framedSplit.metrics }));

const collisionA = "afibybifyxaj";
const collisionB = "enafmrgdqlct";
check("equal-length distinct FNV32 collision fixture is valid", collisionA !== collisionB && collisionA.length === collisionB.length && fnv1a32(collisionA) === fnv1a32(collisionB));
let independentScanCalls = 0;
const collisionReconcile = D.reconcileFinalVisibleRepeat({ trip: false }, collisionB, (text) => {
  independentScanCalls++;
  return { trip: text === collisionB };
});
check("final reconciliation forces an independent scan despite an old fingerprint collision", collisionReconcile.trip && independentScanCalls === 1);

const detectorSource = fs.readFileSync(path.join(root, "extensions/_shared/visible-text-repeat-detector.ts"), "utf8");
check("detector no longer allocates rolling Uint32Array tables per checkpoint", !/Uint32Array|rollingHash|substringHash/.test(detectorSource));
for (const [label, size, maxMs] of [["200K", 200000, 10000], ["1M", 1000000, 30000]]) {
  const perf = measureDetector(nonRepeatingFixture(size, size ^ 0x51f15e));
  check(`${label} non-repeating detector performance remains bounded`, !perf.verdict.trip && perf.elapsedMs < maxMs, JSON.stringify(perf));
  check(`${label} detector heap growth remains far below GiB scale`, perf.heapGrowth < 256 * 1024 * 1024, JSON.stringify(perf));
}

console.log("\n[worker state machine]");
const defaults = G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS;
const provider = new G.WorkerRunGovernor("provider-run", "read_only", defaults, root, 1000);
const requestedCap = provider.observe({ signal: "requested_output_cap", requestedOutputCap: 128000 });
for (let i = 0; i < 20; i++) provider.observe({ signal: "provider_request" }, 1001 + i);
check("provider request count and requested output cap are observe-only", requestedCap?.mode === "observe" && !provider.terminalDecision && provider.snapshot().counters.provider_request_count === 20 && provider.snapshot().requested_output_cap === 128000);

const observeAssistant = (governor, message) => governor.observe({
  signal: "assistant_response",
  providerProgress: D.isProviderProgressAssistantMessage(message),
  action: "smoke_observe_assistant_response",
});
const cleanVisible = (text = "recovered") => ({ stopReason: "stop", content: [{ type: "text", text }] });

const sparse = new G.WorkerRunGovernor("provider-sparse", "read_only", defaults, root);
let sparseRetry;
for (let i = 0; i < 5; i++) {
  sparseRetry = sparse.observe({ signal: "provider_retry" });
  observeAssistant(sparse, cleanVisible(`recovered-${i}`));
}
const sparseCounters = sparse.snapshot().counters;
check("sparse fifth lifetime retry reports the consecutive budget without terminating", !sparse.terminalDecision && sparseRetry?.mode === "observe" && sparseRetry.count === 1 && sparseRetry.limit === 4 && sparseRetry.counters.provider_retry_count === 5 && sparseRetry.counters.provider_retry_consecutive_count === 1 && sparseCounters.provider_retry_count === 5 && sparseCounters.provider_retry_consecutive_count === 0, JSON.stringify({ decision: sparseRetry, snapshot: sparse.snapshot() }));

const consecutive = new G.WorkerRunGovernor("provider-consecutive", "read_only", defaults, root);
let consecutiveDecision;
for (let i = 0; i < 5; i++) consecutiveDecision = consecutive.observe({ signal: "provider_retry" });
check("consecutive fifth retry terminates", consecutiveDecision?.failureType === "provider_retry_budget_exceeded" && consecutiveDecision.budget_kind === "consecutive" && consecutiveDecision.count === 5 && consecutiveDecision.limit === 4, JSON.stringify(consecutiveDecision));

const resetThenConsecutive = new G.WorkerRunGovernor("provider-reset-then-consecutive", "read_only", defaults, root);
for (let i = 0; i < 4; i++) resetThenConsecutive.observe({ signal: "provider_retry" });
observeAssistant(resetThenConsecutive, cleanVisible("progress resets the first streak"));
let resetThenConsecutiveDecision;
for (let i = 0; i < 5; i++) resetThenConsecutiveDecision = resetThenConsecutive.observe({ signal: "provider_retry" });
check("progress resets the streak and the fifth retry in the new consecutive run terminates", resetThenConsecutiveDecision?.mode === "abort" && resetThenConsecutiveDecision.budget_kind === "consecutive" && resetThenConsecutiveDecision.count === 5 && resetThenConsecutiveDecision.limit === 4 && resetThenConsecutiveDecision.counters.provider_retry_count === 9, JSON.stringify(resetThenConsecutiveDecision));

function replayRetryWindow(id, observations) {
  const governor = new G.WorkerRunGovernor(id, "read_only", defaults, root);
  let decision;
  for (const observation of observations) {
    decision = observation === "r"
      ? governor.observe({ signal: "provider_retry" })
      : observeAssistant(governor, cleanVisible());
    if (decision?.mode === "abort") break;
  }
  return { governor, decision };
}
const tenOfFourteen = replayRetryWindow("provider-window-10", "rrrprrrprrprrp");
check("10 retries in 14 observations do not terminate", !tenOfFourteen.governor.terminalDecision && tenOfFourteen.governor.snapshot().counters.provider_retry_window_retry_count === 10 && tenOfFourteen.governor.snapshot().counters.provider_retry_window_observation_count === 14, JSON.stringify(tenOfFourteen.governor.snapshot()));
const elevenOfFourteen = replayRetryWindow("provider-window-11", "rrrprrrprrrprr");
check("11 retries in 14 observations terminate on rolling budget", elevenOfFourteen.decision?.failureType === "provider_retry_budget_exceeded" && elevenOfFourteen.decision.budget_kind === "rolling_window" && elevenOfFourteen.decision.count === 11 && elevenOfFourteen.decision.limit === 10 && elevenOfFourteen.decision.window_size === 14, JSON.stringify(elevenOfFourteen.decision));

const alternatingErrors = new G.WorkerRunGovernor("provider-alternating-errors", "read_only", defaults, root);
let alternatingDecision;
for (let i = 0; i < 5; i++) {
  observeAssistant(alternatingErrors, { stopReason: "error", errorMessage: "HTTP 503", content: [{ type: "text", text: "partial" }] });
  alternatingDecision = alternatingErrors.observe({ signal: "provider_retry" });
}
check("captured alternating error-response/retry replay still terminates", alternatingDecision?.budget_kind === "consecutive" && alternatingDecision.count === 5, JSON.stringify(alternatingDecision));

const nonProgressMessages = [
  { stopReason: "stop", content: [{ type: "thinking", thinking: "internal only" }] },
  { stopReason: "stop", content: [{ type: "text", text: "   " }] },
  { stopReason: "error", errorMessage: "HTTP 503", content: [{ type: "text", text: "partial" }] },
  { stopReason: "abort", content: [{ type: "text", text: "partial" }] },
  { stopReason: "length", content: [{ type: "text", text: "partial" }] },
];
const nonProgressDecisions = nonProgressMessages.map((message, index) => {
  const governor = new G.WorkerRunGovernor(`provider-non-progress-${index}`, "read_only", defaults, root);
  for (let i = 0; i < 4; i++) governor.observe({ signal: "provider_retry" });
  observeAssistant(governor, message);
  return governor.observe({ signal: "provider_retry" });
});
check("thinking-only, empty-visible, error, abort, and length responses do not reset consecutive retry budget", nonProgressMessages.every((message) => !D.isProviderProgressAssistantMessage(message)) && nonProgressDecisions.every((decision) => decision?.budget_kind === "consecutive" && decision.count === 5), JSON.stringify(nonProgressDecisions));
check("clean toolUse or pi-ai stop with visible text is provider progress", D.isProviderProgressAssistantMessage({ stopReason: "toolUse", content: [{ type: "thinking", thinking: "x" }] }) && D.isProviderProgressAssistantMessage(cleanVisible()) && !D.isProviderProgressAssistantMessage({ stopReason: "toolUse", errorMessage: "failed" }));
check("non-normalized end_turn spellings are not provider progress", !D.isProviderProgressAssistantMessage({ stopReason: "end_turn", content: [{ type: "text", text: "done" }] }) && !D.isProviderProgressAssistantMessage({ stopReason: "endTurn", content: [{ type: "text", text: "done" }] }));

const toolSuccess = new G.WorkerRunGovernor("provider-tool-success", "read_only", defaults, root);
for (let i = 0; i < 4; i++) toolSuccess.observe({ signal: "provider_retry" });
toolSuccess.observeToolEnd("read", { content: [{ type: "text", text: "ok" }] }, false, "tool-ok");
const afterToolSuccess = toolSuccess.observe({ signal: "provider_retry" });
check("successful tool response is not double-counted as provider progress", afterToolSuccess?.budget_kind === "consecutive" && toolSuccess.snapshot().counters.successful_tool_response_count === 1 && toolSuccess.snapshot().counters.provider_retry_window_progress_count === 0, JSON.stringify(afterToolSuccess));

for (const [signal, failureType] of [
  ["empty_visible_retry", "empty_visible_retry_budget_exceeded"],
  ["full_output_cap_hit", "full_output_cap_budget_exceeded"],
]) {
  const governor = new G.WorkerRunGovernor(`${signal}-run`, "read_only", defaults);
  let terminal;
  for (let i = 0; i < 3; i++) terminal = governor.observe({ signal });
  check(`${signal} stops on third hit`, terminal?.mode === "abort" && terminal.failureType === failureType && terminal.count === 3, JSON.stringify(terminal));
}
const noUsage = new G.WorkerRunGovernor("no-usage", "read_only", defaults);
noUsage.observe({ signal: "empty_visible_retry" });
noUsage.observe({ signal: "empty_visible_retry" });
const noUsageStop = noUsage.observe({ signal: "empty_visible_retry" });
check("missing usage does not prevent empty-visible budget stop", noUsageStop?.failureType === "empty_visible_retry_budget_exceeded");
check("toolUse at or above usage ratio is not a full-cap hit", !D.isFullOutputCapHit("toolUse", 1000, 1000, 0.98));
check("ordinary stop at usage ratio remains a full-cap hit", D.isFullOutputCapHit("stop", 980, 1000, 0.98));
check("explicit length and max_tokens remain full-cap hits without usage", D.isFullOutputCapHit("length", undefined, undefined, 0.98) && D.isFullOutputCapHit("max_tokens", undefined, undefined, 0.98));

const taskGovernor = new G.WorkerRunGovernor("task-run", "implementation", defaults);
const checkpoint = taskGovernor.observe({ signal: "task_governor_checkpoint", count: 120, limit: 120 });
const auditPause = taskGovernor.observe({ signal: "task_governor_audit_pause", count: 180, limit: 180 });
const freshAuth = taskGovernor.observe({ signal: "task_governor_fresh_auth", count: 240, limit: 240, action: "audit_fresh_auth_due_no_total_tool_limit" });
for (let i = 0; i < 1000; i++) taskGovernor.observeToolStart("ls", {}, `tool-${i}`);
check("task-governor stages remain observe-only", checkpoint?.mode === "observe" && auditPause?.mode === "observe" && freshAuth?.mode === "observe" && freshAuth.failureType === undefined && freshAuth.action === "audit_fresh_auth_due_no_total_tool_limit");
check("1000 cumulative tool calls remain non-terminal and auditable", !taskGovernor.terminalDecision && taskGovernor.snapshot().counters.tool_call_count === 1000, JSON.stringify(taskGovernor.snapshot()));
check("task-governor stage counters record each emitted stage once", taskGovernor.snapshot().counters.task_governor_checkpoint_count === 1 && taskGovernor.snapshot().counters.task_governor_audit_pause_count === 1 && taskGovernor.snapshot().counters.task_governor_fresh_auth_count === 1, JSON.stringify(taskGovernor.snapshot().counters));

const pagination = new G.WorkerRunGovernor("pagination", "read_only", defaults, root);
let paginationObservation;
for (let i = 0; i < 8; i++) paginationObservation = pagination.observeToolStart("read", { path: "src/a.ts", offset: 1 + i * 100, limit: 100 }, `p-${i}`) ?? paginationObservation;
check("increasing read pagination does not report churn", !paginationObservation && pagination.snapshot().counters.same_file_small_read_churn_count === 0);
const churn = new G.WorkerRunGovernor("churn", "read_only", defaults, root);
let churnObservation;
for (let i = 0; i < 5; i++) churnObservation = churn.observeToolStart("read", { path: "src/a.ts", offset: 1, limit: 80 }, `c-${i}`) ?? churnObservation;
check("high-overlap small reads report observe-only churn", churnObservation?.signal === "same_file_small_read_churn" && churnObservation.mode === "observe" && churnObservation.coverage === "post_execution_only");
const exactOverlapSettings = structuredClone(defaults);
exactOverlapSettings.toolObservers.sameFileSmallReadChurn.observeAfter = 1;
const exactOverlap = new G.WorkerRunGovernor("exact-overlap", "read_only", exactOverlapSettings, root);
exactOverlap.observeToolStart("read", { path: "src/exact.ts", offset: 1, limit: 100 }, "e-1");
const exactOverlapObservation = exactOverlap.observeToolStart("read", { path: "src/exact.ts", offset: 21, limit: 100 }, "e-2");
check("exact 80 percent sliding overlap reports at observeAfter", exactOverlapObservation?.signal === "same_file_small_read_churn", JSON.stringify(exactOverlapObservation));
const pathEvictionSettings = structuredClone(exactOverlapSettings);
pathEvictionSettings.toolObservers.sameFileSmallReadChurn.maxTrackedPaths = 2;
const pathEviction = new G.WorkerRunGovernor("path-eviction", "read_only", pathEvictionSettings, root);
for (const name of ["a.ts", "b.ts", "c.ts"]) pathEviction.observeToolStart("read", { path: `src/${name}`, offset: 1, limit: 20 });
const evictedPathFirst = pathEviction.observeToolStart("read", { path: "src/a.ts", offset: 1, limit: 20 });
const evictedPathSecond = pathEviction.observeToolStart("read", { path: "src/a.ts", offset: 1, limit: 20 });
check("tracked-path map evicts exactly at maxTrackedPaths boundary", !evictedPathFirst && evictedPathSecond?.signal === "same_file_small_read_churn");

const schemaFix = new G.WorkerRunGovernor("schema-fix", "read_only", defaults);
const schemaError = { content: [{ type: "text", text: "schema validation: required property 'path' is missing" }] };
schemaFix.observeToolEnd("read", schemaError, true, "s1");
schemaFix.observeToolEnd("read", { content: [{ type: "text", text: "ok" }] }, false, "s2");
let schemaObs;
for (let i = 0; i < 3; i++) schemaObs = schemaFix.observeToolEnd("read", schemaError, true, `s${i + 3}`) ?? schemaObs;
check("one corrected schema error does not count as a storm, sustained same shape does", schemaObs?.signal === "schema_error_storm" && schemaObs.mode === "observe" && schemaObs.coverage === "post_execution_only");
const secretToken = "TOP_SECRET_7f3c";
const fullSchemaError = `schema validation full error: required parameter '${secretToken}' is missing from path /private/${secretToken}`;
const privacyGovernor = new G.WorkerRunGovernor("schema-privacy", "read_only", defaults);
let privacyObservation;
for (let i = 0; i < 3; i++) privacyObservation = privacyGovernor.observeToolEnd("read", { content: [{ type: "text", text: fullSchemaError }] }, true, `privacy-${i}`) ?? privacyObservation;
const privacyAuditJson = JSON.stringify(G.buildWorkerRunAuditEvent(privacyObservation));
check("schema audit shape is a fixed errorClass category", privacyObservation?.shape === "missing_required", JSON.stringify(privacyObservation));
check("schema audit HMAC correlation is opaque SHA-256", /^[0-9a-f]{64}$/.test(privacyObservation?.hash ?? ""), String(privacyObservation?.hash));
check("schema audit excludes field token and complete error text", !privacyAuditJson.includes(secretToken) && !privacyAuditJson.includes(fullSchemaError), privacyAuditJson);
const shapeEvictionSettings = structuredClone(defaults);
shapeEvictionSettings.toolObservers.schemaErrorStorm.observeAfter = 2;
shapeEvictionSettings.toolObservers.schemaErrorStorm.maxTrackedShapes = 2;
const shapeEviction = new G.WorkerRunGovernor("shape-eviction", "read_only", shapeEvictionSettings);
const shapeError = (field) => ({ content: [{ type: "text", text: `schema validation: required parameter '${field}' is missing` }] });
for (const field of ["alpha", "beta", "gamma"]) shapeEviction.observeToolEnd("read", shapeError(field), true);
const evictedShapeFirst = shapeEviction.observeToolEnd("read", shapeError("alpha"), true);
const evictedShapeSecond = shapeEviction.observeToolEnd("read", shapeError("alpha"), true);
check("schema-shape map evicts exactly at maxTrackedShapes boundary", !evictedShapeFirst && evictedShapeSecond?.signal === "schema_error_storm");
check("tool observers never terminate the worker", !schemaFix.terminalDecision && !churn.terminalDecision);

const auditDecision = new G.WorkerRunGovernor("audit-run", "research", defaults).observe({
  signal: "repetitive_output", hash: "deadbeef", count: 8192, action: "abort_session_return_bounded_partial",
});
const audit = G.buildWorkerRunAuditEvent(auditDecision, {
  dispatchToolCallId: "tool-call-1", taskIndex: 2, taskCount: 3, task: "dispatch[2]",
  workflowRunId: "wf-1", workflowStageId: "stage-a", workflow: "wf-1",
});
const auditJson = JSON.stringify(audit);
check("worker_run_event carries correlation, counters, thresholds, terminal source", audit.row_kind === "worker_run_event" && audit.dispatch_tool_call_id === "tool-call-1" && audit.workflow_run_id === "wf-1" && audit.worker_run_id === "audit-run" && audit.counters && audit.thresholds && audit.termination_source === "worker_run_governor");
const rollingAudit = G.buildWorkerRunAuditEvent(elevenOfFourteen.decision);
check("rolling retry audit uniquely explains the terminal budget", rollingAudit.rule_version === "dispatch-worker-run-governor/v2" && rollingAudit.budget_kind === "rolling_window" && rollingAudit.window_size === 14 && rollingAudit.count === 11 && rollingAudit.limit === 10 && rollingAudit.counters.provider_retry_count === 11 && rollingAudit.counters.provider_retry_consecutive_count === 2 && rollingAudit.counters.provider_retry_window_retry_count === 11 && rollingAudit.counters.provider_retry_window_progress_count === 3 && rollingAudit.thresholds.provider_retry_limit === 4 && rollingAudit.thresholds.provider_retry_window_size === 14 && rollingAudit.thresholds.provider_retry_window_limit === 10, JSON.stringify(rollingAudit));
for (const forbidden of ["prompt", "text", "tool_output", "reasoning", "credential", "secret-value"]) {
  check(`worker_run_event excludes ${forbidden}`, !auditJson.toLowerCase().includes(`\"${forbidden}\"`));
}

console.log("\n[real AgentSession empty-visible race]");
const realRace = await realAgentSessionEmptyRaceSmoke();
check("real faux AgentSession reaches governor terminal on third empty response", realRace.terminal?.failureType === "empty_visible_retry_budget_exceeded" && realRace.terminalCallCount === 3, JSON.stringify(realRace));
check("terminal empty response is synchronously rewritten non-retryable", realRace.terminalMessage?.stopReason === "aborted" && String(realRace.terminalMessage?.errorMessage).includes(D.WORKER_RUN_GOVERNOR_TERMINAL_ERROR), JSON.stringify(realRace.terminalMessage));
check("provider callCount cannot increase after terminal message_end", realRace.finalCallCount === realRace.terminalCallCount, JSON.stringify(realRace));
check("no auto_retry_start occurs after governor terminal", realRace.autoRetryStartCount === 2 && realRace.autoRetryStartsAfterTerminal === 0, JSON.stringify(realRace));

const source = fs.readFileSync(path.join(root, "extensions/dispatch/index.ts"), "utf8");
check("subscriber detects only assistant text_delta", /assistantMessageEvent\?\.type === "text_delta"/.test(source) && /event\.message\?\.role === "assistant"/.test(source));
check("streamed final is not appended into detector twice", /Final reconciliation always uses a fresh detector/.test(source) && /visibleDetector\.pushDelta\(finalText\)/.test(source) === false);
check("final reconciliation contains no FNV-plus-length equality shortcut", !/rawTextFingerprint|visibleTextFingerprint|responseStreamFingerprint/.test(source));
check("legacy task governor no longer owns a second termination promise", !/governorPromise|resolveGovernorStop|dispatch\.task_governor/.test(source));
check("all governance terminal outputs use the UTF-8 bounded partial path", /governanceOutputOverride \?\? boundedUtf8Prefix\(finalOutput \|\| responsePartial\)/.test(source));
check("reasoning trace remains thinking-only", !/visibleDetector[\s\S]{0,200}reasoningTrace\.write/.test(source));

console.log(`\npass=${pass}, fail=${fail}`);
if (fail) process.exit(1);
