#!/usr/bin/env node
/** Focused S1 smoke for dispatch termination and bounded session closure. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AgentSession,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const D = await jiti.import(path.join(root, "extensions/dispatch/index.ts"));
const G = await jiti.import(path.join(root, "extensions/dispatch/worker-run-governor.ts"));
const T = await jiti.import(path.join(root, "extensions/dispatch/terminal-state.ts"));

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
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function assertAttribution(result, source) {
  assert(result.cancelSource === source, `cancelSource=${result.cancelSource}, expected ${source}`);
  assert(result.terminationSource === source, `terminationSource=${result.terminationSource}, expected ${source}`);
}
function assertClosureEvidence(result, owner, lifecyclePath, closureStatus, runSettled = true) {
  const evidence = result.terminationClosure;
  assert(evidence, `terminationClosure missing: ${JSON.stringify(result)}`);
  assert(evidence.termination_owner === owner, `termination_owner=${evidence.termination_owner}, expected ${owner}`);
  assert(evidence.lifecycle_path === lifecyclePath, `lifecycle_path=${evidence.lifecycle_path}, expected ${lifecyclePath}`);
  assert(evidence.closure_status === closureStatus, `closure_status=${evidence.closure_status}, expected ${closureStatus}`);
  assert(evidence.run_settled === runSettled, `run_settled=${evidence.run_settled}, expected ${runSettled}`);
  assert(evidence.cleanup_done === result.cleanupDone, `cleanup evidence mismatch: ${JSON.stringify(evidence)}`);
  assert(evidence.post_claim_provider_start_count === 0, `post-claim provider starts: ${JSON.stringify(evidence)}`);
  assert(evidence.post_claim_tool_start_count === 0, `post-claim tool starts: ${JSON.stringify(evidence)}`);
  assert(
    JSON.stringify(result.workerRunGovernance?.termination_closure) === JSON.stringify(evidence),
    "governance summary must project the same lifecycle evidence values",
  );
}
async function assertObservationWindow(faux, providerCount, label) {
  await sleep(150);
  assert(faux.state.callCount === providerCount, `${label}: provider grew ${providerCount}->${faux.state.callCount}`);
}
function nonRepeatingText(length) {
  let x = 0x12345678;
  let out = "";
  while (out.length < length) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += `${(x >>> 0).toString(36)}:${out.length}\n`;
  }
  return out.slice(0, length);
}

console.log("dispatch terminal closure S1 smoke\n");
console.log("[termination authority and disposal state]");

for (const first of ["timeout", "parent", "worker_run_governor"]) {
  await check(`${first} wins timeout/parent/governor race exactly once`, async () => {
    let claims = 0;
    const termination = new D.FirstWriterTermination(() => { claims++; });
    const order = [first, ...["timeout", "parent", "worker_run_governor"].filter((owner) => owner !== first)];
    const evidence = { timeout: "timeout", parent: "parent", worker_run_governor: "worker_run_governor" };
    const accepted = order.map((owner) => termination.tryClaim(owner, { output: `${owner}-partial` }, evidence[owner]));
    const claim = await termination.termination;
    assert(accepted.filter(Boolean).length === 1, `accepted=${JSON.stringify(accepted)}`);
    assert(claims === 1, `onClaim invoked ${claims} times`);
    assert(claim.owner === first && claim.evidence === evidence[first], JSON.stringify(claim));
    assert(claim.value.output === `${first}-partial`, `partial=${claim.value.output}`);
  });
}

await check("cancelled cleanup is evidence-based and partial remains visible", () => {
  const closed = T.buildTerminalStateFields({ error: "timeout", failureType: "timeout", cleanupDone: true });
  const unproven = T.buildTerminalStateFields({ error: "timeout", failureType: "timeout", cleanupDone: false });
  assert(closed.cleanup_done === true, JSON.stringify(closed));
  assert(unproven.cleanup_done === false, JSON.stringify(unproven));
  const rendered = D.formatResult("dispatch", "faux/faux-1", {
    output: "preserved parent partial",
    error: "aborted by parent signal",
    failureType: "aborted",
    durationMs: 1,
  });
  assert(rendered.includes("preserved parent partial"), rendered);
});

await check("normal disposal upgrades synchronously to immediate without double dispose", async () => {
  let disposed = 0;
  let releaseShutdown;
  const shutdown = new Promise((resolve) => { releaseShutdown = resolve; });
  const session = {
    extensionRunner: { hasHandlers: () => true, emit: () => shutdown },
    dispose() { disposed++; },
  };
  const normal = D.disposeSubAgentSession(session);
  assert(disposed === 0, "normal cleanup disposed before session_shutdown settled");
  const immediate = D.disposeSubAgentSession(session, { immediate: true });
  assert(disposed === 1, "immediate upgrade did not synchronously dispose");
  releaseShutdown();
  assert(await normal === true && await immediate === true, "upgraded disposal did not resolve true");
  assert(disposed === 1, `dispose called ${disposed} times`);
});

await check("normal and abnormal session_shutdown hangs are bounded and still dispose", async () => {
  for (const immediate of [false, true]) {
    let disposed = 0;
    let rejectShutdown;
    const shutdown = new Promise((_, reject) => { rejectShutdown = reject; });
    const session = {
      extensionRunner: { hasHandlers: () => true, emit: () => shutdown },
      dispose() { disposed++; },
    };
    const started = Date.now();
    const pending = D.disposeSubAgentSession(session, { immediate });
    if (immediate) assert(disposed === 1, "abnormal disposal was not synchronous");
    const done = await pending;
    const elapsed = Date.now() - started;
    assert(done === false, `${immediate ? "abnormal" : "normal"} timed-out shutdown reported success`);
    assert(disposed === 1, `${immediate ? "abnormal" : "normal"} dispose called ${disposed} times`);
    assert(elapsed >= D.SESSION_SHUTDOWN_WAIT_MS - 100, `returned too early at ${elapsed}ms`);
    assert(elapsed < D.SESSION_SHUTDOWN_WAIT_MS + 1500, `returned too late at ${elapsed}ms`);
    rejectShutdown(new Error(`late ${immediate ? "abnormal" : "normal"} shutdown rejection`));
    await sleep(20);
  }
});

const codingAgentDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const compatPath = path.join(codingAgentDist, "../node_modules/@earendil-works/pi-ai/dist/compat.js");
const Faux = await import(pathToFileURL(compatPath).href);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-terminal-closure-"));
const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
const faux = Faux.registerFauxProvider({
  provider: "faux-closure",
  tokensPerSecond: 0,
  models: [{ id: "closure-1", name: "Closure Faux", maxTokens: 16384 }],
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

async function runProduction({
  responses,
  controller = new AbortController(),
  timeoutMs = 1000,
  maxRuntimeMs = 4000,
  tools = "read",
  onProgress,
}) {
  faux.setResponses(responses);
  const providerBefore = faux.state.callCount;
  const result = await D.runInProcess(
    modelName,
    "off",
    "execute the scripted faux response",
    controller.signal,
    timeoutMs,
    registry,
    tools,
    {
      projectRoot: tempRoot,
      parentContextFiles: [],
      maxRuntimeMs,
      onProgress,
    },
  );
  return { result, providerBefore, providerAfter: faux.state.callCount };
}

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

console.log("\n[production runInProcess with real SDK and faux provider]");
try {
  await check("parent claim in prompt_start pre-run window starts no provider even when early dispose is a no-op", async () => {
    const controller = new AbortController();
    let promptStarts = 0;
    const originalDispose = AgentSession.prototype.dispose;
    AgentSession.prototype.dispose = function noOpBeforeActiveRun() {};
    try {
      const run = await runProduction({
        responses: [Faux.fauxAssistantMessage("must never start")],
        controller,
        onProgress: ({ reason }) => {
          if (reason === "prompt_start") {
            promptStarts++;
            controller.abort({ kind: "parent" });
          }
        },
      });
      assert(promptStarts === 1, `promptStarts=${promptStarts}`);
      assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
      assert(run.result.failureType === "aborted", JSON.stringify(run.result));
      assertAttribution(run.result, "parent");
      assert(run.result.cleanupDone === true, `cleanupDone=${run.result.cleanupDone}`);
      assertClosureEvidence(run.result, "parent", "abnormal", "complete");
      await assertObservationWindow(faux, run.providerAfter, "preflight parent claim");
    } finally {
      AgentSession.prototype.dispose = originalDispose;
    }
  });

  await check("production late run rejection claims crash and remains handled", async () => {
    const originalPrompt = AgentSession.prototype.prompt;
    const hostile = Object.create(null, {
      message: {
        get() { throw new Error("late run rejection message getter"); },
      },
    });
    AgentSession.prototype.prompt = async function rejectAfterPreflightBoundary() {
      await sleep(20);
      throw hostile;
    };
    try {
      const run = await runProduction({
        responses: [Faux.fauxAssistantMessage("must not call provider")],
      });
      assert(run.result.failureType === "crash", JSON.stringify(run.result));
      assert(run.result.error === "late run rejection message getter", JSON.stringify(run.result));
      assert(run.result.cleanupDone === true, `cleanupDone=${run.result.cleanupDone}`);
      assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
    } finally {
      AgentSession.prototype.prompt = originalPrompt;
    }
  });

  await check("normal long bash completes without a generic duration cap", async () => {
    const run = await runProduction({
      tools: "bash",
      timeoutMs: 1000,
      maxRuntimeMs: 4000,
      responses: [
        Faux.fauxAssistantMessage(
          Faux.fauxToolCall("bash", { command: "node -e \"setTimeout(() => {}, 250)\"" }, { id: "normal-bash" }),
          { stopReason: "toolUse" },
        ),
        Faux.fauxAssistantMessage("normal long tool complete"),
      ],
    });
    assert(!run.result.error, JSON.stringify(run.result));
    assert(run.result.toolCallCount === 1, `toolCallCount=${run.result.toolCallCount}`);
    assert(run.result.cleanupDone === true, `cleanupDone=${run.result.cleanupDone}`);
    assertClosureEvidence(run.result, "run", "normal", "complete");
    assert(run.providerAfter === run.providerBefore + 2, `provider calls=${run.providerAfter - run.providerBefore}`);
  });

  await check("stuck bash parent abort kills the pid tree and activity stays flat", async () => {
    const marker = path.join(tempRoot, `bash-tree-${Date.now()}.json`);
    const script = [
      "const fs=require('fs')",
      "const {spawn}=require('child_process')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      `fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]))`,
      "setInterval(()=>{},1000)",
    ].join(";");
    const command = `node -e ${JSON.stringify(script)}`;
    const controller = new AbortController();
    faux.setResponses([
      Faux.fauxAssistantMessage([
        Faux.fauxText("partial before stuck bash"),
        Faux.fauxToolCall("bash", { command }, { id: "stuck-bash" }),
      ], { stopReason: "toolUse" }),
      Faux.fauxAssistantMessage("must never follow the aborted tool"),
    ]);
    const providerBefore = faux.state.callCount;
    const pending = D.runInProcess(
      modelName, "off", "run the stuck bash tree", controller.signal, 1000,
      registry, "bash", {
        projectRoot: tempRoot,
        parentContextFiles: [],
        maxRuntimeMs: 4000,
      },
    );
    await waitUntil(() => fs.existsSync(marker), 3000, "bash pid tree marker");
    const pids = JSON.parse(fs.readFileSync(marker, "utf8"));
    controller.abort({ kind: "parent" });
    const result = await pending;
    assert(result.failureType === "aborted", JSON.stringify(result));
    assertAttribution(result, "parent");
    assert(result.cleanupDone === true, `cleanupDone=${result.cleanupDone}`);
    assertClosureEvidence(result, "parent", "abnormal", "complete");
    assert(result.output.includes("partial before stuck bash"), `partial=${JSON.stringify(result.output)}`);
    assert(result.toolCallCount === 1, `toolCallCount=${result.toolCallCount}`);
    await waitUntil(() => pids.every((pid) => !processExists(pid)), 3000, `bash pid tree exit ${pids.join(",")}`);
    const providerAfter = faux.state.callCount;
    assert(providerAfter === providerBefore + 1, `provider calls=${providerAfter - providerBefore}`);
    await assertObservationWindow(faux, providerAfter, "stuck bash parent abort");
  });

  await check("idle timeout is bounded and reports cleanup false when provider ignores abort", async () => {
    const never = () => new Promise(() => {});
    const started = Date.now();
    const run = await runProduction({
      responses: [never],
      timeoutMs: 60,
      maxRuntimeMs: 1000,
    });
    const elapsed = Date.now() - started;
    assert(run.result.failureType === "timeout", JSON.stringify(run.result));
    assert(run.result.timeoutKind === "idle", `timeoutKind=${run.result.timeoutKind}`);
    assertAttribution(run.result, "timeout");
    assert(run.result.cleanupDone === false, `cleanupDone=${run.result.cleanupDone}`);
    assertClosureEvidence(run.result, "timeout", "abnormal", "complete", false);
    assert(elapsed >= D.TERMINAL_CLOSURE_WAIT_MS, `returned before bounded join: ${elapsed}ms`);
    assert(elapsed < D.TERMINAL_CLOSURE_WAIT_MS + 1500, `bounded join exceeded: ${elapsed}ms`);
    assert(run.providerAfter === run.providerBefore + 1, `provider calls=${run.providerAfter - run.providerBefore}`);
    await assertObservationWindow(faux, run.providerAfter, "idle timeout");
  });

  await check("max-runtime timeout preserves partial and closes cleanly", async () => {
    const slowFaux = Faux.registerFauxProvider({
      provider: "faux-max-runtime",
      tokensPerSecond: 1200,
      tokenSize: { min: 1, max: 1 },
      models: [{ id: "max-runtime-1", name: "Max Runtime Faux", maxTokens: 16384 }],
    });
    const model = slowFaux.getModel();
    modelRuntime.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: "offline-smoke-key",
      authHeader: true,
      models: [{ ...model }],
    });
    const before = slowFaux.state.callCount;
    slowFaux.setResponses([Faux.fauxAssistantMessage(nonRepeatingText(20000))]);
    try {
      const result = await D.runInProcess(
        `${model.provider}/${model.id}`, "off", "stream until max runtime",
        new AbortController().signal, 80, registry, "read", {
          projectRoot: tempRoot,
          parentContextFiles: [],
          maxRuntimeMs: 140,
        },
      );
      assert(result.failureType === "timeout_partial", JSON.stringify(result));
      assert(result.timeoutKind === "max_runtime", `timeoutKind=${result.timeoutKind}`);
      assertAttribution(result, "timeout");
      assert(result.output.length > 0, "partial output was dropped");
      assert(result.cleanupDone === true, `cleanupDone=${result.cleanupDone}`);
      assertClosureEvidence(result, "timeout", "abnormal", "complete");
      assert(slowFaux.state.callCount === before + 1, `provider calls=${slowFaux.state.callCount - before}`);
      await assertObservationWindow(slowFaux, slowFaux.state.callCount, "max runtime");
    } finally {
      slowFaux.unregister();
      modelRuntime.unregisterProvider(model.provider);
    }
  });

  await check("governor terminal seals the message, preserves partial, and closes cleanly", async () => {
    const repeated = "governed repeated output ".repeat(1600);
    const run = await runProduction({
      responses: [Faux.fauxAssistantMessage(repeated)],
      timeoutMs: 1000,
      maxRuntimeMs: 4000,
    });
    assert(run.result.failureType === "repetitive_output", JSON.stringify(run.result));
    assert(run.result.terminationSource === "worker_run_governor", `terminationSource=${run.result.terminationSource}`);
    assert(run.result.cancelSource === undefined || run.result.cancelSource === "unknown", `cancelSource=${run.result.cancelSource}`);
    assert(run.result.output.length > 0, "governor partial was dropped");
    assert(run.result.cleanupDone === true, `cleanupDone=${run.result.cleanupDone}`);
    assertClosureEvidence(run.result, "worker_run_governor", "abnormal", "complete");
    assert(run.providerAfter === run.providerBefore + 1, `provider calls=${run.providerAfter - run.providerBefore}`);
    await assertObservationWindow(faux, run.providerAfter, "governor terminal");
  });

  await check("target-session tool refusal disposes and projects cleanup consistently", async () => {
    const run = await runProduction({
      responses: [Faux.fauxAssistantMessage("must not call provider")],
      tools: "definitely_missing_tool",
    });
    assert(run.result.failureType === "tool_rejected", JSON.stringify(run.result));
    assert(run.result.cleanupDone === true, `cleanupDone=${run.result.cleanupDone}`);
    assertClosureEvidence(run.result, "run", "normal", "complete");
    assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
  });

  await check("parent abort at prompt_end cannot rewrite a successful run (run-terminal seal)", async () => {
    const controller = new AbortController();
    let promptEnds = 0;
    const run = await runProduction({
      responses: [Faux.fauxAssistantMessage("sealed success text")],
      controller,
      onProgress: ({ reason }) => {
        if (reason === "prompt_end") {
          promptEnds++;
          controller.abort({ kind: "parent" });
        }
      },
    });
    assert(promptEnds === 1, `promptEnds=${promptEnds}`);
    assert(!run.result.error, JSON.stringify(run.result));
    assert(run.result.output.includes("sealed success text"), `output=${JSON.stringify(run.result.output)}`);
    assert(run.result.cleanupDone === true, `cleanupDone=${run.result.cleanupDone}`);
    assert(run.providerAfter === run.providerBefore + 1, `provider calls=${run.providerAfter - run.providerBefore}`);
  });

  await check("hanging session_shutdown with short idle/maxRuntime cannot turn a successful prompt into timeout", async () => {
    await withHangingSessionShutdown(async () => {
      const started = Date.now();
      const run = await runProduction({
        responses: [Faux.fauxAssistantMessage("success despite hanging shutdown")],
        timeoutMs: 100,
        maxRuntimeMs: 800,
      });
      const elapsed = Date.now() - started;
      assert(!run.result.error, JSON.stringify(run.result));
      assert(run.result.output.includes("success despite hanging shutdown"), `output=${JSON.stringify(run.result.output)}`);
      assert(run.result.cleanupDone === false, `cleanupDone=${run.result.cleanupDone} (hanging shutdown must stay honest)`);
      assertClosureEvidence(run.result, "run", "normal", "incomplete");
      assert(elapsed >= D.SESSION_SHUTDOWN_WAIT_MS - 100, `returned before bounded shutdown wait: ${elapsed}ms`);
      assert(elapsed < D.SESSION_SHUTDOWN_WAIT_MS + 1500, `bounded shutdown wait exceeded: ${elapsed}ms`);
    });
  });

  await check("tool_rejected with hanging session_shutdown survives late parent abort (sealed)", async () => {
    await withHangingSessionShutdown(async () => {
      const controller = new AbortController();
      const pending = runProduction({
        responses: [Faux.fauxAssistantMessage("must not call provider")],
        tools: "definitely_missing_tool",
        controller,
        timeoutMs: 1000,
        maxRuntimeMs: 4000,
      });
      await sleep(150);
      controller.abort({ kind: "parent" });
      const run = await pending;
      assert(run.result.failureType === "tool_rejected", JSON.stringify(run.result));
      assert(run.result.error.includes("tool_rejected"), JSON.stringify(run.result.error));
      assert(run.result.cleanupDone === false, `cleanupDone=${run.result.cleanupDone} (hanging shutdown must stay honest)`);
      assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
    });
  });

  await check("tool_rejected with hanging session_shutdown survives short idle timeout (sealed)", async () => {
    await withHangingSessionShutdown(async () => {
      const run = await runProduction({
        responses: [Faux.fauxAssistantMessage("must not call provider")],
        tools: "definitely_missing_tool",
        timeoutMs: 100,
        maxRuntimeMs: 800,
      });
      assert(run.result.failureType === "tool_rejected", JSON.stringify(run.result));
      assert(run.result.error.includes("tool_rejected"), JSON.stringify(run.result.error));
      assert(run.result.cleanupDone === false, `cleanupDone=${run.result.cleanupDone} (hanging shutdown must stay honest)`);
      assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
    });
  });

  await check("prompt crash with hanging session_shutdown survives late parent abort (sealed)", async () => {
    const originalPrompt = AgentSession.prototype.prompt;
    AgentSession.prototype.prompt = async function crashPrompt() {
      await sleep(5);
      throw new Error("provider rate limit exceeded");
    };
    try {
      await withHangingSessionShutdown(async () => {
        const controller = new AbortController();
        const pending = runProduction({
          responses: [Faux.fauxAssistantMessage("must not call provider")],
          controller,
          timeoutMs: 1000,
          maxRuntimeMs: 4000,
        });
        await sleep(150);
        controller.abort({ kind: "parent" });
        const run = await pending;
        assert(run.result.failureType === "rate_limit", JSON.stringify(run.result));
        assert(run.result.error.includes("provider rate limit exceeded"), JSON.stringify(run.result.error));
        assert(run.result.cleanupDone === false, `cleanupDone=${run.result.cleanupDone} (hanging shutdown must stay honest)`);
        assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
      });
    } finally {
      AgentSession.prototype.prompt = originalPrompt;
    }
  });

  await check("prompt crash with hanging session_shutdown survives short idle timeout (sealed)", async () => {
    const originalPrompt = AgentSession.prototype.prompt;
    AgentSession.prototype.prompt = async function crashPrompt() {
      await sleep(5);
      throw new Error("provider rate limit exceeded");
    };
    try {
      await withHangingSessionShutdown(async () => {
        const run = await runProduction({
          responses: [Faux.fauxAssistantMessage("must not call provider")],
          timeoutMs: 100,
          maxRuntimeMs: 800,
        });
        assert(run.result.failureType === "rate_limit", JSON.stringify(run.result));
        assert(run.result.error.includes("provider rate limit exceeded"), JSON.stringify(run.result.error));
        assert(run.result.cleanupDone === false, `cleanupDone=${run.result.cleanupDone} (hanging shutdown must stay honest)`);
        assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
      });
    } finally {
      AgentSession.prototype.prompt = originalPrompt;
    }
  });

  await check("parent abort before run start still wins (pre-run first-writer preserved)", async () => {
    const controller = new AbortController();
    controller.abort({ kind: "parent" });
    const run = await runProduction({
      responses: [Faux.fauxAssistantMessage("must never start")],
      controller,
    });
    assert(run.result.failureType === "aborted", JSON.stringify(run.result));
    assertAttribution(run.result, "parent");
    assert(run.result.cleanupDone === true, `cleanupDone=${run.result.cleanupDone}`);
    assert(run.providerAfter === run.providerBefore, `provider calls=${run.providerAfter - run.providerBefore}`);
  });
} finally {
  faux.unregister();
  modelRuntime.unregisterProvider(fauxModel.provider);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

await check("1000 tool observations remain non-terminal (no generic cap)", () => {
  const governor = new G.WorkerRunGovernor("closure-no-cap", G.DEFAULT_WORKER_RUN_GOVERNOR_SETTINGS, root);
  for (let i = 0; i < 1000; i++) governor.observeToolStart("ls", {}, `tool-${i}`);
  assert(!governor.terminalDecision, JSON.stringify(governor.terminalDecision));
  assert(governor.snapshot().counters.tool_call_count === 1000, JSON.stringify(governor.snapshot()));
});

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} dispatch terminal closure checks`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) {
  console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
}
process.exit(1);
