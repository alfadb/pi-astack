#!/usr/bin/env node
/** Production-connected, non-delegating ADR 0042 shadow smoke. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dispatchPath = path.join(root, "extensions/dispatch/index.ts");
const bridgePath = path.join(root, "extensions/dispatch/delegation-shadow-bridge.ts");
const piInternalsPath = path.join(root, "extensions/_shared/pi-internals.ts");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const dispatch = await jiti.import(dispatchPath);
const bridge = await jiti.import(bridgePath);
const piInternals = await jiti.import(piInternalsPath);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-shadow-smoke-"));

const failures = [];
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`);
  }
}
function assert(condition, message = "assertion failed") {
  if (!condition) throw new Error(message);
}
function config(overrides = {}) {
  return {
    mode: "shadow",
    maxDepth: 2,
    maxDescendantRuns: 8,
    maxConcurrentLeaves: 4,
    maxAcceptedRuns: 8,
    maxActiveExecutions: 4,
    maxOpenSessions: 4,
    maxRuntimeMs: 60_000,
    allowedModels: ["openai/model-a"],
    allowedTools: ["dispatch_agent", "dispatch_parallel", "read"],
    allowedProfiles: ["read_only", "implementation"],
    allowsMutation: false,
    ...overrides,
  };
}
function task(overrides = {}) {
  return {
    model: "openai/model-a",
    profile: "read_only",
    tools: ["read"],
    allowsMutation: false,
    inputText: "SHADOW_PROMPT_BODY_MUST_NOT_APPEAR",
    ...overrides,
  };
}
function rowsAt(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  return text ? text.split("\n").map(JSON.parse) : [];
}
async function withBinding(label, delegation, run, options = {}) {
  const manager = {};
  const auditPath = path.join(tempRoot, label, "audit.jsonl");
  const binding = bridge.createShadowWorkerBinding(manager, delegation, {
    projectRoot: tempRoot,
    auditPath,
    ...(options.rootRef ? { rootRef: options.rootRef } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const registry = options.registry ?? ["read", "bash", "dispatch_agent", "dispatch_parallel"];
  const activeRegistry = options.activeRegistry ?? registry;
  bridge.activateShadowWorkerBinding(manager, {
    getAllTools: () => registry.map((name) => ({ name })),
    getActiveToolNames: () => [...activeRegistry],
  });
  try {
    return await run({ manager, auditPath, binding });
  } finally {
    await bridge.shutdownShadowWorkerBinding(manager, "smoke_cleanup");
  }
}
async function evaluate(manager, nestedTask = task(), signal) {
  return bridge.evaluateShadowDispatchIfBound(manager, {
    operation: "dispatch_agent",
    tasks: [nestedTask],
    ...(signal ? { signal } : {}),
  });
}

console.log("ADR 0042 non-delegating shadow smoke");

console.log("\n[schema and dynamic structural boundary]");
await check("schema/config accept only exact explicit shadow budgets and sets", () => {
  assert(bridge.validateShadowDelegation(config()).ok);
  for (const bad of [
    { ...config(), mode: "other" },
    { ...config(), maxDepth: -1 },
    { ...config(), maxRuntimeMs: Number.POSITIVE_INFINITY },
    { ...config(), maxAcceptedRuns: 1.5 },
    { ...config(), allowedTools: ["read", "read"] },
    { ...config(), extra: true },
  ]) {
    assert(!bridge.validateShadowDelegation(bad).ok, `accepted malformed config: ${JSON.stringify(bad)}`);
  }
});

await check("default remains five denies and shadow removes only explicit authorized dispatch names", () => {
  const five = ["dispatch_agent", "dispatch_parallel", "workflow_run", "prompt_user", "vault_release"];
  assert(JSON.stringify(dispatch.resolveSubAgentExcludeTools(undefined)) === JSON.stringify(five));
  const delegation = config();
  assert(JSON.stringify(dispatch.resolveSubAgentExcludeTools("read,dispatch_agent", delegation)) ===
    JSON.stringify(["dispatch_parallel", "workflow_run", "prompt_user", "vault_release"]));
  assert(JSON.stringify(dispatch.resolveSubAgentExcludeTools("read", delegation)) === JSON.stringify(five));
  assert(!dispatch.validateTools("read", delegation).ok);
  assert(!dispatch.validateTools(undefined, delegation).ok);
  assert(!dispatch.validateTools("read,dispatch_agent", config({ allowedTools: ["read"] })).ok);
  assert(!dispatch.validateTools("read,workflow_run", delegation).ok);
  assert(!dispatch.validateTools("read,prompt_user", delegation).ok);
  assert(!dispatch.validateTools("read,vault_release", delegation).ok);
});

console.log("\n[real SDK registered execute]");
let sessionStarts = 0;
const settingsManager = SettingsManager.inMemory();
const agentDir = path.join(tempRoot, "agent");
const resourceLoader = new DefaultResourceLoader({
  cwd: tempRoot,
  agentDir,
  settingsManager,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [
    { name: "dispatch-production", factory: dispatch.default },
    {
      name: "session-counter",
      factory: (pi) => {
        pi.on("session_start", () => { sessionStarts++; });
        for (const name of ["workflow_run", "prompt_user", "vault_release"]) {
          pi.registerTool({
            name,
            label: name,
            description: `Excluded structural probe ${name}`,
            parameters: Type.Object({}),
            async execute() {
              throw new Error(`${name}_must_never_execute`);
            },
          });
        }
      },
    },
  ],
});
await resourceLoader.reload();
const realManager = SessionManager.inMemory(tempRoot);
piInternals.markSessionAsSubAgent(realManager);
const realAuditPath = path.join(tempRoot, "real-sdk", "audit.jsonl");
const realConfig = config({
  allowedTools: [
    "dispatch_agent",
    "dispatch_parallel",
    "read",
    "workflow_run",
    "prompt_user",
    "vault_release",
  ],
  maxDescendantRuns: 8,
  maxAcceptedRuns: 8,
  maxConcurrentLeaves: 4,
  maxActiveExecutions: 4,
  maxOpenSessions: 4,
});
bridge.createShadowWorkerBinding(realManager, realConfig, {
  projectRoot: tempRoot,
  auditPath: realAuditPath,
  rootRef: `shadowreal.${process.pid}`,
});
const realTools = "read,dispatch_agent,dispatch_parallel";
const { session: realSession } = await createAgentSession({
  cwd: tempRoot,
  tools: realTools.split(","),
  excludeTools: dispatch.resolveSubAgentExcludeTools(realTools, realConfig),
  settingsManager,
  resourceLoader,
  sessionManager: realManager,
});
bridge.activateShadowWorkerBinding(realManager, realSession);
const baselineSessionStarts = sessionStarts;

await check("real first-level session exposes only explicitly requested shadow dispatch tools", () => {
  const active = new Set(realSession.getActiveToolNames());
  assert(active.has("read") && active.has("dispatch_agent") && active.has("dispatch_parallel"));
  assert(!active.has("workflow_run") && !active.has("prompt_user") && !active.has("vault_release"));
  assert(realSession.sessionId && typeof realSession.sessionId === "string", "real SDK session identity missing");
});

const throwingRegistry = new Proxy({}, {
  get() { throw new Error("normal_dispatch_runner_was_reached"); },
});
const realContext = {
  cwd: tempRoot,
  sessionManager: realManager,
  modelRegistry: throwingRegistry,
};
const signal = new AbortController().signal;
const realAgentTool = realSession.getToolDefinition("dispatch_agent");
const realParallelTool = realSession.getToolDefinition("dispatch_parallel");
assert(realAgentTool && typeof realAgentTool.execute === "function", "registered dispatch_agent definition missing");
assert(realParallelTool && typeof realParallelTool.execute === "function", "registered dispatch_parallel definition missing");

await check("unmarked real SessionManager retains the normal root dispatch path", async () => {
  const rootManager = SessionManager.inMemory(tempRoot);
  const result = await realAgentTool.execute("root-agent", {
    model: "openai/not-registered",
    thinking: "low",
    prompt: "ROOT_MODEL_NOT_FOUND_BODY",
    tools: "read",
  }, signal, undefined, {
    cwd: tempRoot,
    sessionManager: rootManager,
    modelRegistry: { find: () => undefined },
  });
  assert(result.details.kind === "dispatch_agent_result", "root dispatch was redirected into shadow");
  assert(result.details.failureType === "model_not_found");
  assert(sessionStarts === baselineSessionStarts, "model-not-found root path created a worker session");
});

await check("delegation without an explicit dispatch request creates no binding", async () => {
  const rootManager = SessionManager.inMemory(tempRoot);
  const result = await realAgentTool.execute("invalid-delegation", {
    model: "openai/model-a",
    thinking: "low",
    prompt: "INVALID_DELEGATION_BODY",
    tools: "read",
    delegation: realConfig,
  }, signal, undefined, {
    cwd: tempRoot,
    sessionManager: rootManager,
    modelRegistry: throwingRegistry,
  });
  assert(result.isError && result.details.kind === "tool_rejected");
  assert(String(result.details.reason).includes("invalid_shadow_delegation"));
  assert(!bridge.hasShadowWorkerBinding(rootManager), "invalid delegation allocated a shadow binding");
  assert(sessionStarts === baselineSessionStarts, "invalid delegation entered the runner");
});

await check("marked real SessionManager without binding fails closed before runner lookup", async () => {
  const unboundManager = SessionManager.inMemory(tempRoot);
  piInternals.markSessionAsSubAgent(unboundManager);
  const unboundContext = { ...realContext, sessionManager: unboundManager };
  const agentResult = await realAgentTool.execute("unbound-agent", {
    model: "openai/model-a",
    thinking: "low",
    prompt: "UNBOUND_AGENT_BODY",
    tools: "read",
  }, signal, undefined, unboundContext);
  const parallelResult = await realParallelTool.execute("unbound-parallel", {
    tasks: [
      { model: "openai/model-a", thinking: "low", prompt: "UNBOUND_ONE", tools: "read" },
      { model: "openai/model-a", thinking: "low", prompt: "UNBOUND_TWO", tools: "read" },
    ],
  }, signal, undefined, unboundContext);
  for (const result of [agentResult, parallelResult]) {
    assert(result.isError && result.details.kind === "shadow_no_delegate");
    assert(result.details.decision === "would_deny");
    assert(result.details.reason_code === "shadow_binding_missing");
  }
  assert(sessionStarts === baselineSessionStarts, "unbound direct execute created another SDK session");
});

await check("missing execute context is rejected structurally", async () => {
  const result = await realAgentTool.execute("missing-context", {
    model: "openai/model-a",
    thinking: "low",
    prompt: "MISSING_CONTEXT_BODY",
    tools: "read",
  }, signal, undefined, undefined);
  assert(result.isError && result.details.reason_code === "dispatch_context_missing");
});

await check("real dispatch_agent execute returns allow sentinel without another session", async () => {
  const result = await realAgentTool.execute("shadow-agent", {
    model: "openai/model-a",
    thinking: "low",
    prompt: "REAL_AGENT_PROMPT_BODY_MUST_NOT_APPEAR",
    tools: "read",
    taskProfile: "read_only",
  }, signal, undefined, realContext);
  assert(result.details.kind === "shadow_no_delegate" && result.details.decision === "would_allow");
  assert(result.details.tasks[0].reason_code === "shadow_no_delegate");
  assert(sessionStarts === baselineSessionStarts, "nested execute created another SDK session");
  assert(!JSON.stringify(result).includes("REAL_AGENT_PROMPT_BODY_MUST_NOT_APPEAR"));
});

await check("real dispatch_parallel execute evaluates siblings and never enters normal runner", async () => {
  const result = await realParallelTool.execute("shadow-parallel", {
    tasks: [
      { model: "openai/model-a", thinking: "low", prompt: "PARALLEL_SECRET_ONE", tools: "read", taskProfile: "read_only" },
      { model: "openai/model-a", thinking: "low", prompt: "PARALLEL_SECRET_TWO", tools: "read", taskProfile: "read_only" },
    ],
  }, signal, undefined, realContext);
  assert(result.details.kind === "shadow_no_delegate" && result.details.decision === "would_allow");
  assert(result.details.tasks.length === 2 && result.details.tasks.every((entry) => entry.decision === "would_allow"));
  assert(sessionStarts === baselineSessionStarts, "parallel shadow created another SDK session");
  const serialized = JSON.stringify(result);
  assert(!serialized.includes("PARALLEL_SECRET_ONE") && !serialized.includes("PARALLEL_SECRET_TWO"));
});

await check("required shadow audit has allow+terminal rows and no input body", async () => {
  const rows = rowsAt(realAuditPath);
  assert(rows.length === 6, `expected 6 rows for three accepted evaluations, got ${rows.length}`);
  assert(rows.every((row) => row.execution_mode === "shadow" && row.audit_version === 4));
  assert(rows.filter((row) => row.row_kind === "delegation_authorization").length === 3);
  assert(rows.filter((row) => row.row_kind === "delegation_lifecycle").length === 3);
  const text = fs.readFileSync(realAuditPath, "utf8");
  for (const body of ["REAL_AGENT_PROMPT_BODY_MUST_NOT_APPEAR", "PARALLEL_SECRET_ONE", "PARALLEL_SECRET_TWO"]) {
    assert(!text.includes(body), `audit leaked input body ${body}`);
  }
  assert((fs.statSync(realAuditPath).mode & 0o777) === 0o600);
  assert((fs.statSync(path.dirname(realAuditPath)).mode & 0o777) === 0o700);
});

await check("excluded structural descriptors never become shadow registry authority", async () => {
  for (const name of ["workflow_run", "prompt_user", "vault_release"]) {
    const result = await bridge.evaluateShadowDispatchIfBound(realManager, {
      operation: "dispatch_agent",
      tasks: [task({ tools: [name] })],
    });
    assert(result.details.decision === "would_deny", `${name} unexpectedly allowed`);
    assert(result.details.reason_code === "tool_unavailable", `${name} denied as ${result.details.reason_code}`);
  }
});

await bridge.shutdownShadowWorkerBinding(realManager, "held_execute_shutdown");
await check("held real execute references fail closed after binding shutdown", async () => {
  const agentResult = await realAgentTool.execute("closed-agent", {
    model: "openai/model-a",
    thinking: "low",
    prompt: "CLOSED_AGENT_BODY",
    tools: "read",
  }, signal, undefined, realContext);
  const parallelResult = await realParallelTool.execute("closed-parallel", {
    tasks: [
      { model: "openai/model-a", thinking: "low", prompt: "CLOSED_ONE", tools: "read" },
      { model: "openai/model-a", thinking: "low", prompt: "CLOSED_TWO", tools: "read" },
    ],
  }, signal, undefined, realContext);
  for (const result of [agentResult, parallelResult]) {
    assert(result.isError && result.details.kind === "shadow_no_delegate");
    assert(result.details.decision === "would_deny");
    assert(result.details.reason_code === "shadow_binding_missing");
  }
  assert(sessionStarts === baselineSessionStarts, "closed direct execute created another SDK session");
});

await dispatch.disposeSubAgentSession(realSession, realManager);
await check("dispose emits shutdown and leaves the weak binding invalid", () => {
  assert(!bridge.hasShadowWorkerBinding(realManager));
});

console.log("\n[deny matrix and lifecycle]");
const denialCases = [
  ["depth", config({ maxDepth: 0 }), task(), "depth_exhausted", {}],
  ["runs", config({ maxDescendantRuns: 0 }), task(), "descendant_runs_exhausted", {}],
  ["leaves", config({ maxConcurrentLeaves: 0 }), task(), "concurrent_leaves_exhausted", {}],
  ["accepted", config({ maxAcceptedRuns: 0 }), task(), "accepted_run_budget_exhausted", {}],
  ["active", config({ maxActiveExecutions: 0 }), task(), "active_execution_budget_exhausted", {}],
  ["open", config({ maxOpenSessions: 0 }), task(), "open_session_budget_exhausted", {}],
  ["model", config(), task({ model: "openai/model-z" }), "capability_escalation", {}],
  ["profile", config(), task({ profile: "heavy" }), "capability_escalation", {}],
  ["registry", config({ allowedTools: ["dispatch_agent", "unknown_tool"] }), task({ tools: ["unknown_tool"] }), "tool_unavailable", {}],
  ["mutation", config({ allowedTools: ["dispatch_agent", "bash"], allowsMutation: false }), task({ tools: ["bash"], allowsMutation: true }), "mutation_not_authorized", {}],
];
for (const [label, delegation, nestedTask, expected, options] of denialCases) {
  await check(`${label} denial is structured, durable, and non-delegating`, async () => {
    await withBinding(`deny-${label}`, delegation, async ({ manager, auditPath }) => {
      const result = await evaluate(manager, nestedTask);
      assert(result.details.decision === "would_deny", `${label} unexpectedly allowed`);
      assert(result.details.reason_code === expected,
        `${label} expected ${expected}, got ${result.details.reason_code}`);
      const rows = rowsAt(auditPath);
      assert(rows.at(-1)?.row_kind === "delegation_denial" && rows.at(-1)?.execution_mode === "shadow");
      assert(!fs.readFileSync(auditPath, "utf8").includes(nestedTask.inputText));
    }, options);
  });
}

await check("expired capability denies without delegating", async () => {
  let now = 100;
  await withBinding("deny-expired", config({ maxRuntimeMs: 10 }), async ({ manager }) => {
    now = 110;
    const result = await evaluate(manager);
    assert(result.details.decision === "would_deny");
    assert(result.details.reason_code === "expired_capability");
  }, { clock: () => now });
});

await check("inactive descriptors are excluded while active mutation descriptors are preserved", async () => {
  await withBinding("active-registry-intersection", config({
    allowedTools: ["dispatch_agent", "bash", "workflow_run", "prompt_user", "vault_release"],
    allowsMutation: true,
  }), async ({ manager }) => {
    const bashResult = await evaluate(manager, task({ tools: ["bash"], allowsMutation: true }));
    assert(bashResult.details.decision === "would_allow", "active bash descriptor was lost");
    for (const name of ["workflow_run", "prompt_user", "vault_release"]) {
      const result = await evaluate(manager, task({ tools: [name] }));
      assert(result.details.decision === "would_deny", `${name} descriptor bypassed active registry`);
      assert(result.details.reason_code === "tool_unavailable");
    }
  }, {
    registry: ["bash", "workflow_run", "prompt_user", "vault_release"],
    activeRegistry: ["bash"],
  });
});

await check("revoked capability remains bound only to return a structured deny", async () => {
  await withBinding("deny-revoked", config(), async ({ manager }) => {
    assert(await bridge.revokeShadowWorkerBinding(manager));
    const result = await evaluate(manager);
    assert(result.details.decision === "would_deny" && result.details.reason_code === "revoked_capability");
  });
});

await check("pre-aborted authorization denies and writes audit", async () => {
  await withBinding("deny-abort", config(), async ({ manager, auditPath }) => {
    const controller = new AbortController();
    controller.abort();
    const result = await evaluate(manager, task(), controller.signal);
    assert(result.details.decision === "would_deny" && result.details.reason_code === "authorization_aborted");
    assert(rowsAt(auditPath).at(-1)?.reason_code === "authorization_aborted");
  });
});

await check("parallel sibling leaf budget cannot be oversold", async () => {
  await withBinding("parallel-leaf", config({
    maxDescendantRuns: 2,
    maxAcceptedRuns: 2,
    maxConcurrentLeaves: 1,
    maxActiveExecutions: 2,
    maxOpenSessions: 2,
  }), async ({ manager }) => {
    const result = await bridge.evaluateShadowDispatchIfBound(manager, {
      operation: "dispatch_parallel",
      tasks: [task({ inputText: "leaf-one" }), task({ inputText: "leaf-two" })],
    });
    assert(result.details.decision === "would_deny");
    assert(result.details.tasks.filter((entry) => entry.decision === "would_allow").length === 1);
    assert(result.details.tasks.filter((entry) => entry.reason_code === "concurrent_leaves_exhausted").length === 1);
  });
});

await check("two jiti copies share the same SessionManager binding", async () => {
  const bridgeA = await createJiti(import.meta.url, { moduleCache: false }).import(bridgePath);
  const bridgeB = await createJiti(import.meta.url, { moduleCache: false }).import(bridgePath);
  const manager = {};
  bridgeA.createShadowWorkerBinding(manager, config(), {
    projectRoot: tempRoot,
    auditPath: path.join(tempRoot, "jiti", "audit.jsonl"),
    rootRef: `shadowjiti.${process.pid}`,
  });
  try {
    assert(bridgeB.hasShadowWorkerBinding(manager));
    bridgeB.activateShadowWorkerBinding(manager, {
      getAllTools: () => [{ name: "read" }],
      getActiveToolNames: () => ["read"],
    });
    const result = await bridgeB.evaluateShadowDispatchIfBound(manager, {
      operation: "dispatch_agent",
      tasks: [task()],
    });
    assert(result.details.decision === "would_allow");
  } finally {
    await bridgeB.shutdownShadowWorkerBinding(manager, "jiti_cleanup");
  }
});

await check("shutdown releases a process root claim for exact reuse", async () => {
  const rootRef = `shadowreuse.${process.pid}`;
  const first = {};
  bridge.createShadowWorkerBinding(first, config(), {
    projectRoot: tempRoot,
    auditPath: path.join(tempRoot, "reuse", "first.jsonl"),
    rootRef,
  });
  let collision = false;
  try {
    bridge.createShadowWorkerBinding({}, config(), {
      projectRoot: tempRoot,
      auditPath: path.join(tempRoot, "reuse", "collision.jsonl"),
      rootRef,
    });
  } catch (error) {
    collision = error?.code === "shadow_root_claimed";
  }
  assert(collision, "duplicate root claim was accepted");
  await bridge.shutdownShadowWorkerBinding(first, "release_claim");
  const second = {};
  bridge.createShadowWorkerBinding(second, config(), {
    projectRoot: tempRoot,
    auditPath: path.join(tempRoot, "reuse", "second.jsonl"),
    rootRef,
  });
  assert(bridge.hasShadowWorkerBinding(second));
  await bridge.shutdownShadowWorkerBinding(second, "reuse_cleanup");
});

console.log("\n[source invariants]");
await check("shadow evaluator source has no session creation or normal runner path", () => {
  const source = fs.readFileSync(bridgePath, "utf8");
  for (const forbidden of ["create" + "AgentSession", "run" + "InProcess", ".pro" + "mpt("]) {
    assert(!source.includes(forbidden), `shadow bridge contains forbidden source token ${forbidden}`);
  }
  assert(source.includes("SHADOW_NO_DELEGATE_SENTINEL"));
});

await check("delegation schemas and execution-mode types contain no alternate mode", () => {
  const source = [bridgePath, path.join(root, "extensions/dispatch/delegation-audit.ts")]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert(!/execution_mode\s*[:=][^\n]*[\"']live[\"']|mode:\s*[\"']live[\"']/.test(source));
});

console.log(`\npass=${passed}, fail=${failures.length}`);
if (failures.length > 0) process.exit(1);
