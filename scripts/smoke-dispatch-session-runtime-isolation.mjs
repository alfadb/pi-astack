#!/usr/bin/env node
/**
 * Real SDK smoke for dispatch sub-agent loader/runtime lifecycle isolation.
 *
 * No prompt is sent and ModelRuntime has network model loading disabled. The
 * inline extension captures each ExtensionAPI so overlapping sessions prove
 * that bindCore, shutdown, and dispose only affect their own runtime.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJiti } from "jiti";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatchPath = path.join(repoRoot, "extensions/dispatch/index.ts");
const piInternalsPath = path.join(repoRoot, "extensions/_shared/pi-internals.ts");
const shadowBridgePath = path.join(repoRoot, "extensions/dispatch/delegation-shadow-bridge.ts");
const dispatchSource = fs.readFileSync(dispatchPath, "utf8");
const jiti = createJiti(import.meta.url);
const dispatch = await jiti.import(dispatchPath);
const piInternals = await jiti.import(piInternalsPath);
const shadowBridge = await jiti.import(shadowBridgePath);

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function activeToolNames(api) {
  return api.getActiveTools()
    .map((tool) => typeof tool === "string" ? tool : tool.name)
    .sort();
}

console.log("dispatch per-session ExtensionRuntime isolation");

await check("production resources and disposal are session-owned", () => {
  assert(
    /const \{ settingsManager, resourceLoader \} = await createSubAgentSessionResources\(\{[\s\S]{0,120}?parentContextFiles,?[\s\S]{0,40}?\}\)/.test(dispatchSource)
      || /const \{ settingsManager, resourceLoader \} = await createSubAgentSessionResources\(/.test(dispatchSource),
    "runInProcess does not create resources per invocation",
  );
  assert(
    /parentContextFiles/.test(dispatchSource.match(/await createSubAgentSessionResources\([\s\S]{0,200}?\)/)?.[0] ?? ""),
    "runInProcess must pass parentContextFiles into createSubAgentSessionResources",
  );
  assert(
    !/pi-astack\/dispatch\/shared-infra/.test(dispatchSource),
    "obsolete shared loader cache is still present",
  );
  for (const obsolete of [
    "_SHARED_LOADER_FLAG_KEY",
    "_isActivatingInSharedLoader",
    "_beginSubAgentLoaderActivation",
    "_endSubAgentLoaderActivation",
    "activating-shared-loader",
  ]) {
    assert(!dispatchSource.includes(obsolete), `obsolete activation signal remains: ${obsolete}`);
  }
  assert(
    /name: "pi-astack-dispatch-subagent-boundary-sentinel"/.test(dispatchSource),
    "sub-agent boundary sentinel is not a named inline extension",
  );
  assert(
    /extensionFactories: \[\s*\.\.\.\(options\.extensionFactories \?\? \[\]\),\s*subAgentBoundarySentinelExtension,\s*\]/.test(dispatchSource),
    "caller factories are not merged with the sentinel factory",
  );
  const runBlock = dispatchSource.match(/export async function runInProcess\([\s\S]*?\n}\n\n\/\/ ── Result formatting/);
  assert(runBlock, "could not locate runInProcess source block");
  assert(!/session(?:\?\.)?\.dispose\s*\(/.test(runBlock[0]), "runInProcess still directly disposes a session");
  assert(/await disposeSubAgentSession\(session, (?:subAgentSm|shadowSessionManager)\)/.test(runBlock[0]), "runInProcess does not use production disposal helper");
});

await check("legacy activation timing cannot bind the main runtime sentinel", async () => {
  const legacyKey = Symbol.for("pi-astack/dispatch/activating-shared-loader/v1");
  const previousDisabled = process.env.PI_ABRAIN_DISABLED;
  const handlers = new Map();
  const mainPi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
  };

  piInternals._resetSubAgentBoundaryProbeForTests();
  globalThis[legacyKey] = { count: 1 };
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    dispatch.default(mainPi);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, { sessionManager: {} });
    }
    assert(
      piInternals.getSubAgentBoundaryStatus() === "untested",
      "main runtime bound the sub-agent sentinel from a process-wide timing signal",
    );
  } finally {
    delete globalThis[legacyKey];
    piInternals._resetSubAgentBoundaryProbeForTests();
    if (previousDisabled === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = previousDisabled;
  }
});

await check("disposal remains fail-safe when shutdown emission throws", async () => {
  let shutdownEmits = 0;
  let disposeCalls = 0;
  const session = {
    extensionRunner: {
      hasHandlers: (event) => event === "session_shutdown",
      async emit() {
        shutdownEmits += 1;
        throw new Error("synthetic cleanup failure");
      },
    },
    dispose() {
      disposeCalls += 1;
    },
  };

  await Promise.all([
    dispatch.disposeSubAgentSession(session),
    dispatch.disposeSubAgentSession(session),
  ]);
  assert(shutdownEmits === 1, `shutdown emitted ${shutdownEmits} times`);
  assert(disposeCalls === 1, `dispose called ${disposeCalls} times after cleanup failure`);
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-runtime-isolation-"));

await check("shadow audit flush failure cannot reject cached disposal or replace worker result", async () => {
  const manager = SessionManager.inMemory(tempRoot);
  shadowBridge.createShadowWorkerBinding(manager, {
    mode: "shadow",
    maxDepth: 1,
    maxDescendantRuns: 1,
    maxConcurrentLeaves: 1,
    maxAcceptedRuns: 1,
    maxActiveExecutions: 1,
    maxOpenSessions: 1,
    maxRuntimeMs: 10_000,
    allowedModels: ["openai/model-a"],
    allowedTools: ["dispatch_agent", "read"],
    allowedProfiles: ["read_only"],
    allowsMutation: false,
  }, {
    projectRoot: tempRoot,
    auditPath: path.join(tempRoot, "flush-failure", "audit.jsonl"),
    rootRef: `shadowflush.${process.pid}`,
  });

  let shutdownStarts = 0;
  let shutdownEmits = 0;
  let disposeCalls = 0;
  const observedFailures = [];
  const session = {
    extensionRunner: {
      hasHandlers: (event) => event === "session_shutdown",
      async emit() { shutdownEmits += 1; },
    },
    dispose() { disposeCalls += 1; },
  };
  shadowBridge._setShadowBridgeTestHooksForTests({
    shutdownFlushFailure: Object.assign(new Error("SENSITIVE_SYNTHETIC_FLUSH_BODY"), {
      code: "shadow_audit_flush_failed",
    }),
    onShutdownStart: () => { shutdownStarts += 1; },
  });
  dispatch._setShadowShutdownFailureObserverForTests((event) => { observedFailures.push(event); });
  try {
    const workerResult = { output: "worker-success" };
    const result = await (async () => {
      await Promise.all([
        dispatch.disposeSubAgentSession(session, manager),
        dispatch.disposeSubAgentSession(session, manager),
      ]);
      return workerResult;
    })();
    assert(result === workerResult, "cleanup replaced the successful worker result");
    assert(shutdownStarts === 1, `shadow shutdown started ${shutdownStarts} times`);
    assert(shutdownEmits === 1, `session_shutdown emitted ${shutdownEmits} times`);
    assert(disposeCalls === 1, `session disposed ${disposeCalls} times`);
    assert(!shadowBridge.hasShadowWorkerBinding(manager), "failed flush left binding active");
    assert(observedFailures.length === 1, `observed ${observedFailures.length} shutdown failures`);
    assert(observedFailures[0].phase === "dispose");
    assert(observedFailures[0].reason_code === "shadow_audit_flush_failed");
    assert(!JSON.stringify(observedFailures).includes("SENSITIVE_SYNTHETIC_FLUSH_BODY"));
  } finally {
    shadowBridge._setShadowBridgeTestHooksForTests();
    dispatch._setShadowShutdownFailureObserverForTests();
  }
});

const agentDir = path.join(tempRoot, "agent");
fs.mkdirSync(agentDir);
const extensionApis = [];
const cleanupCounts = [];
const cleanupReasons = [];
const isolationTool = "runtime_isolation_probe";
const extensionFactory = (pi) => {
  const instance = extensionApis.length;
  extensionApis.push(pi);
  cleanupCounts.push(0);
  cleanupReasons.push([]);
  pi.on("session_shutdown", (event) => {
    cleanupCounts[instance] += 1;
    cleanupReasons[instance].push(event.reason);
  });
  pi.registerTool({
    name: isolationTool,
    label: "Runtime isolation probe",
    description: "Offline lifecycle probe",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
};

let sessionA;
let sessionB;
try {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });

  const resourcesA = await dispatch.createSubAgentSessionResources({
    cwd: tempRoot,
    agentDir,
    extensionFactories: [extensionFactory],
    parentContextFiles: [],
  });
  const apiA = extensionApis.at(-1);
  const runtimeA = resourcesA.resourceLoader.getExtensions().runtime;
  const sessionManagerA = SessionManager.inMemory(tempRoot, { sessionId: "runtime-isolation-a" });
  piInternals.markSessionAsSubAgent(sessionManagerA);
  ({ session: sessionA } = await createAgentSession({
    cwd: tempRoot,
    tools: [isolationTool],
    modelRuntime,
    settingsManager: resourcesA.settingsManager,
    resourceLoader: resourcesA.resourceLoader,
    sessionManager: sessionManagerA,
  }));
  // Headless createAgentSession() builds the runner but has no host binding
  // that emits session_start, so drive the public runner event explicitly.
  await sessionA.extensionRunner.emit({ type: "session_start", reason: "startup" });

  await check("sentinel is bound by the target loader factory", () => {
    assert(
      piInternals.getSubAgentBoundaryStatus() === "ok",
      `boundary status is ${piInternals.getSubAgentBoundaryStatus()}, expected ok`,
    );
  });

  const aBeforeB = activeToolNames(apiA);

  // Session A remains live while B loads extensions and binds its runner.
  const resourcesB = await dispatch.createSubAgentSessionResources({
    cwd: tempRoot,
    agentDir,
    extensionFactories: [extensionFactory],
    parentContextFiles: [],
  });
  const apiB = extensionApis.at(-1);
  const runtimeB = resourcesB.resourceLoader.getExtensions().runtime;
  const sessionManagerB = SessionManager.inMemory(tempRoot, { sessionId: "runtime-isolation-b" });
  piInternals.markSessionAsSubAgent(sessionManagerB);
  ({ session: sessionB } = await createAgentSession({
    cwd: tempRoot,
    tools: ["read"],
    modelRuntime,
    settingsManager: resourcesB.settingsManager,
    resourceLoader: resourcesB.resourceLoader,
    sessionManager: sessionManagerB,
  }));

  await check("overlapping sessions retain distinct active-tool views", () => {
    assert(apiA !== apiB, "inline extension API object was reused");
    assert(
      JSON.stringify(aBeforeB) === JSON.stringify([isolationTool]),
      `unexpected A tools before B: ${JSON.stringify(aBeforeB)}`,
    );
    assert(
      JSON.stringify(activeToolNames(apiA)) === JSON.stringify([isolationTool]),
      `creating B changed A's extension API view: ${JSON.stringify(activeToolNames(apiA))}`,
    );
    assert(
      JSON.stringify(activeToolNames(apiB)) === JSON.stringify(["read"]),
      `B extension API observed wrong tools: ${JSON.stringify(activeToolNames(apiB))}`,
    );
  });

  await check("loaders, event buses, settings, and runtimes are session-owned", () => {
    assert(resourcesA.resourceLoader !== resourcesB.resourceLoader, "loader identity is shared");
    assert(resourcesA.resourceLoader.eventBus !== resourcesB.resourceLoader.eventBus, "event bus identity is shared");
    assert(resourcesA.settingsManager !== resourcesB.settingsManager, "SettingsManager identity is shared");
    assert(runtimeA !== runtimeB, "ExtensionRuntime identity is shared");
  });

  await check("cleaning A once leaves B live and uncleaned", async () => {
    await Promise.all([
      dispatch.disposeSubAgentSession(sessionA),
      dispatch.disposeSubAgentSession(sessionA),
    ]);
    sessionA = undefined;
    assert(cleanupCounts[0] === 1, `A cleanup ran ${cleanupCounts[0]} times`);
    assert(cleanupReasons[0][0] === "quit", `A cleanup reason was ${cleanupReasons[0][0]}`);
    assert(cleanupCounts[1] === 0, `B cleanup ran early ${cleanupCounts[1]} times`);

    apiB.setActiveTools(["read"]);
    assert(
      JSON.stringify(activeToolNames(apiB)) === JSON.stringify(["read"]),
      "B ExtensionAPI became stale or remained bound to A after A cleanup",
    );
    let staleA = false;
    try {
      apiA.getActiveTools();
    } catch (error) {
      staleA = /stale/i.test(error instanceof Error ? error.message : String(error));
    }
    assert(staleA, "A ExtensionAPI should be stale after its own session is disposed");
  });

  await check("cleaning B also emits shutdown and disposes exactly once", async () => {
    await Promise.all([
      dispatch.disposeSubAgentSession(sessionB),
      dispatch.disposeSubAgentSession(sessionB),
    ]);
    sessionB = undefined;
    assert(cleanupCounts[0] === 1, `A cleanup changed to ${cleanupCounts[0]}`);
    assert(cleanupCounts[1] === 1, `B cleanup ran ${cleanupCounts[1]} times`);
    assert(cleanupReasons[1][0] === "quit", `B cleanup reason was ${cleanupReasons[1][0]}`);
  });
} finally {
  await dispatch.disposeSubAgentSession(sessionA);
  await dispatch.disposeSubAgentSession(sessionB);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log();
if (failures.length === 0) {
  console.log(`PASS - ${passed} dispatch runtime isolation checks`);
  process.exit(0);
}
console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
for (const { name, error } of failures) {
  console.error(`  ${name}: ${error instanceof Error ? error.stack : String(error)}`);
}
process.exit(1);
