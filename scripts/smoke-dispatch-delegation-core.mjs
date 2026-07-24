#!/usr/bin/env node
/** Deterministic ADR 0042 delegation core smoke. No LLM request is made. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript");
const root = path.resolve(here, "..");
const dispatchDir = path.join(root, "extensions/dispatch");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const C = await jiti.import(path.join(dispatchDir, "delegation-capability.ts"));
const T = await jiti.import(path.join(dispatchDir, "tree-governor.ts"));
const P = await jiti.import(path.join(dispatchDir, "process-provider-limiter.ts"));
const A = await jiti.import(path.join(dispatchDir, "delegation-audit.ts"));
const B = await jiti.import(path.join(dispatchDir, "delegation-broker.ts"));

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
async function expectCode(promiseOrFn, code) {
  try {
    if (typeof promiseOrFn === "function") await promiseOrFn();
    else await promiseOrFn;
  } catch (error) {
    assert(error?.code === code, `expected code ${code}, got ${error?.code}: ${error?.message}`);
    return error;
  }
  throw new Error(`expected ${code} rejection`);
}
async function expectReject(promiseOrFn) {
  try {
    if (typeof promiseOrFn === "function") await promiseOrFn();
    else await promiseOrFn;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}
function registration(value, onTerminal) {
  return { value, ...(onTerminal ? { onTerminal } : {}) };
}
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
function capabilitySpec(rootRef, overrides = {}) {
  return {
    rootRef,
    tools: ["read"],
    models: ["openai/model-a"],
    profiles: ["read_only"],
    deadlineMs: 10_000,
    maxDepth: 4,
    maxDescendantRuns: 8,
    maxConcurrentLeaves: 4,
    allowsMutation: false,
    ...overrides,
  };
}
function governor(rootRef, overrides = {}, clock = () => 100) {
  return new T.TreeGovernor({
    rootRef,
    deadlineMs: 10_000,
    maxAcceptedRuns: 8,
    maxActiveExecutions: 8,
    maxOpenSessions: 8,
    ...overrides,
  }, clock);
}
function brokerRequest(capability, overrides = {}) {
  return {
    parentCapability: capability,
    attenuation: { tools: ["read"] },
    registry: [{ name: "read", mutation: "none" }],
    provider: "openai",
    model: "openai/model-a",
    profile: "read_only",
    delegate: () => ({ value: "delegated" }),
    ...overrides,
  };
}
function rowsAt(auditPath) {
  if (!fs.existsSync(auditPath)) return [];
  const text = fs.readFileSync(auditPath, "utf8").trim();
  return text ? text.split("\n").map(JSON.parse) : [];
}
function sourceFilesUnder(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(target));
    else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(target);
  }
  return files;
}
function dependencySpecifiers(file, source) {
  const scriptKind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers = [];
  const collect = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return specifiers;
}

console.log("ADR 0042 delegation core smoke");

console.log("\n[real SDK dynamic registry]");
let realRegistry;
await check("real pi SDK target registry supplies built-in and dynamically registered tools", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-real-sdk-agent-"));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerTool({
        name: "dynamic_delegation_probe",
        label: "Dynamic delegation probe",
        description: "Offline registry probe",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    tools: ["read", "bash", "dynamic_delegation_probe"],
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
  });
  try {
    const active = new Set(session.getActiveToolNames());
    assert(active.has("read") && active.has("bash") && active.has("dynamic_delegation_probe"));
    realRegistry = session.getAllTools()
      .filter((tool) => active.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        mutation: ["bash", "edit", "write"].includes(tool.name) ? "host" : "none",
      }));
  } finally {
    session.dispose();
  }
});

console.log("\n[opaque capability, lineage, and attenuation]");
const rootCapability = C.createDelegationCapability(capabilitySpec("caproot", {
  tools: ["read", "bash", "dynamic_delegation_probe"],
  models: ["openai/model-a", "xai/model-b"],
  profiles: ["read_only", "implementation"],
  allowsMutation: true,
}));
const rootHandle = rootCapability.currentHandle();

await check("a shaped or copied object cannot forge an opaque handle", async () => {
  await expectCode(() => C.resolveDelegationCapabilityForBroker(
    Object.freeze(Object.create(null)), {}, realRegistry, 100,
  ), "invalid_capability");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(
    { ...rootHandle }, {}, realRegistry, 100,
  ), "invalid_capability");
});

let attenuated;
await check("authority, descendant-run, and leaf ceilings only attenuate", () => {
  attenuated = C.attenuateDelegationCapabilityForBroker(rootHandle, {
    tools: ["dynamic_delegation_probe", "read"],
    models: ["openai/model-a"],
    profiles: ["read_only"],
    deadlineMs: 9_000,
    maxDepth: 2,
    maxDescendantRuns: 3,
    maxConcurrentLeaves: 2,
    allowsMutation: false,
  }, realRegistry, 100, {
    rootRef: "caproot", holderNodeRef: "caproot.1", parentNodeRef: "caproot", nodeDepth: 1,
  });
  assert(JSON.stringify(attenuated.grant.tools) === JSON.stringify(["dynamic_delegation_probe", "read"]));
  assert(attenuated.grant.maxDepth === 2 && attenuated.grant.maxDescendantRuns === 3);
  assert(attenuated.grant.maxConcurrentLeaves === 2 && !attenuated.grant.allowsMutation);
  assert(!("rootRef" in attenuated.grant) && !("holderNodeRef" in attenuated.grant), "binding leaked into grant");
  assert(Reflect.ownKeys(attenuated.handle).length === 0, "opaque handle exposes fields");
});

await check("every attempted capability upgrade or lineage confusion is rejected", async () => {
  await expectCode(() => C.resolveDelegationCapabilityForBroker(rootHandle, {
    tools: ["read", "write"],
  }, [...realRegistry, { name: "write", mutation: "host" }], 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(attenuated.handle, {
    models: ["xai/model-b"],
  }, realRegistry, 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(attenuated.handle, {
    deadlineMs: 9_001,
  }, realRegistry, 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(attenuated.handle, {
    maxDepth: 2,
  }, realRegistry, 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(attenuated.handle, {
    maxDescendantRuns: 3,
  }, realRegistry, 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(attenuated.handle, {
    maxConcurrentLeaves: 3,
  }, realRegistry, 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(attenuated.handle, {
    allowsMutation: true,
  }, realRegistry, 100), "capability_escalation");
  await expectCode(() => C.attenuateDelegationCapabilityForBroker(
    rootHandle, {}, realRegistry, 100,
    { rootRef: "other", holderNodeRef: "other.1", parentNodeRef: "other", nodeDepth: 1 },
  ), "capability_lineage_mismatch");
});

await check("typed constraints narrow canonically and reject every same-kind expansion", async () => {
  const constrained = C.createDelegationCapability(capabilitySpec("narrowing", {
    constraints: [
      { kind: "workspace_roots", roots: ["/safe/./"] },
      { kind: "max_output_bytes", bytes: 1024 },
      { kind: "tool_schema", tool: "read", schemaId: "schema.v1" },
    ],
  }));
  const registry = [{ name: "read", mutation: "none" }];
  const narrowed = C.resolveDelegationCapabilityForBroker(constrained.currentHandle(), {
    additionalConstraints: [
      { kind: "workspace_roots", roots: ["/safe/sub/../sub"] },
      { kind: "max_output_bytes", bytes: 512 },
      { kind: "tool_schema", tool: "write_preview", schemaId: "schema.preview.v1" },
    ],
  }, registry, 100);
  const workspace = narrowed.constraints.find((constraint) => constraint.kind === "workspace_roots");
  const bytes = narrowed.constraints.find((constraint) => constraint.kind === "max_output_bytes");
  assert(JSON.stringify(workspace?.roots) === JSON.stringify(["/safe/sub"]), "workspace roots were not canonical child roots");
  assert(bytes?.bytes === 512, "output byte limit did not narrow");
  assert(narrowed.constraints.filter((constraint) => constraint.kind === "tool_schema").length === 2);

  await expectCode(() => C.resolveDelegationCapabilityForBroker(constrained.currentHandle(), {
    additionalConstraints: [{ kind: "workspace_roots", roots: ["/unsafe"] }],
  }, registry, 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(constrained.currentHandle(), {
    additionalConstraints: [{ kind: "max_output_bytes", bytes: 1025 }],
  }, registry, 100), "capability_escalation");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(constrained.currentHandle(), {
    additionalConstraints: [{ kind: "tool_schema", tool: "read", schemaId: "schema.v2" }],
  }, registry, 100), "capability_escalation");
});

await check("dynamic registry absence and non-sandbox bash mutation are fail-closed", async () => {
  await expectCode(() => C.resolveDelegationCapabilityForBroker(rootHandle, {
    tools: ["dynamic_delegation_probe", "read"],
  }, realRegistry.filter((tool) => tool.name !== "dynamic_delegation_probe"), 100), "tool_unavailable");
  const readOnlyRoot = C.createDelegationCapability(capabilitySpec("readonly", {
    tools: ["bash"], maxDepth: 1, maxDescendantRuns: 1, maxConcurrentLeaves: 1,
  }));
  await expectCode(() => C.resolveDelegationCapabilityForBroker(
    readOnlyRoot.currentHandle(), { tools: ["bash"] }, [{ name: "bash", mutation: "none" }], 10,
  ), "mutation_not_authorized");
});

await check("each child has its own revocation cell and retains its ancestor chain", async () => {
  const controller = C.createDelegationCapability(capabilitySpec("revchain"));
  const parent = controller.currentHandle();
  const childA = C.attenuateDelegationCapabilityForBroker(parent, {}, [{ name: "read", mutation: "none" }], 100, {
    rootRef: "revchain", holderNodeRef: "revchain.1", parentNodeRef: "revchain", nodeDepth: 1,
  });
  const childB = C.attenuateDelegationCapabilityForBroker(parent, {}, [{ name: "read", mutation: "none" }], 100, {
    rootRef: "revchain", holderNodeRef: "revchain.2", parentNodeRef: "revchain", nodeDepth: 1,
  });
  const grandchildA = C.attenuateDelegationCapabilityForBroker(childA.handle, {}, [{ name: "read", mutation: "none" }], 100, {
    rootRef: "revchain", holderNodeRef: "revchain.3", parentNodeRef: "revchain.1", nodeDepth: 2,
  });
  C.revokeDelegationCapabilityForBroker(childA.handle);
  await expectCode(() => C.resolveDelegationCapabilityForBroker(childA.handle, {}, realRegistry, 100), "revoked_capability");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(grandchildA.handle, {}, realRegistry, 100), "revoked_capability");
  assert(C.resolveDelegationCapabilityForBroker(childB.handle, {}, realRegistry, 100).maxDepth === 2);
  controller.revoke();
  await expectCode(() => C.resolveDelegationCapabilityForBroker(childB.handle, {}, realRegistry, 100), "revoked_capability");
  const renewed = controller.renew();
  const inspection = C.inspectDelegationCapabilityForBroker(renewed);
  assert(inspection.capabilityVersion === 2 && inspection.revocationGeneration === 1);
});

console.log("\n[TreeGovernor]");
await check("two concurrent authorizations serialize and cannot oversell", async () => {
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const tree = governor("concurrent", { maxAcceptedRuns: 1, maxActiveExecutions: 2, maxOpenSessions: 2 });
  const first = tree.authorizeAndDelegate({ beforeDelegate: () => barrier, delegate: () => registration("first") });
  const second = tree.authorizeAndDelegate({ delegate: () => registration("second") });
  await tick();
  assert(tree.snapshot().budgets.acceptedRuns === 0);
  releaseBarrier();
  const accepted = await first;
  await expectCode(second, "accepted_run_budget_exhausted");
  assert(accepted.reservation.nodeRef === "concurrent.1");
  await tree.settleNode(accepted.reservation.nodeRef, { kind: "completed", reasonCode: "done" });
});

await check("reservation sequence is consumed by a failed pre-delegation hook", async () => {
  const tree = governor("holes", { maxAcceptedRuns: 1 });
  let deniedRef;
  await expectReject(tree.authorizeAndDelegate({
    beforeDelegate: (reservation) => { deniedRef = reservation.nodeRef; throw new Error("deny"); },
    delegate: () => registration("never"),
  }));
  const accepted = await tree.authorizeAndDelegate({ delegate: () => registration("next") });
  assert(deniedRef === "holes.1" && accepted.reservation.nodeRef === "holes.2");
  assert(tree.snapshot().budgets.acceptedRuns === 1);
});

await check("an accepted delegation failure spends the run and releases active/open counts", async () => {
  const tree = governor("delegatefail", { maxAcceptedRuns: 2, maxActiveExecutions: 1, maxOpenSessions: 1 });
  await expectCode(tree.authorizeAndDelegate({
    delegate: () => { throw Object.assign(new Error("synthetic delegation failure"), { code: "delegation_failed" }); },
  }), "delegation_failed");
  const snapshot = tree.snapshot();
  assert(snapshot.budgets.acceptedRuns === 1);
  assert(snapshot.budgets.activeExecutions === 0 && snapshot.budgets.openSessions === 0);
  assert(snapshot.nodes[0].terminal?.source === "delegation_error");
});

await check("waiting parent releases active capacity while retaining an open session", async () => {
  const tree = governor("waittree", { maxAcceptedRuns: 2, maxActiveExecutions: 1, maxOpenSessions: 2 });
  const parent = await tree.authorizeAndDelegate({ delegate: () => registration("parent") });
  await tree.pauseExecution(parent.reservation.nodeRef);
  const child = await tree.authorizeAndDelegate({
    parentNodeRef: parent.reservation.nodeRef,
    delegate: () => registration("child"),
  });
  await tree.requestResume(parent.reservation.nodeRef);
  let snapshot = tree.snapshot();
  assert(snapshot.budgets.activeExecutions === 1 && snapshot.budgets.openSessions === 2);
  assert(snapshot.nodes.find((node) => node.nodeRef === parent.reservation.nodeRef)?.state === "waiting");
  await tree.settleNode(child.reservation.nodeRef, { kind: "completed", reasonCode: "child_done" });
  snapshot = tree.snapshot();
  assert(snapshot.nodes.find((node) => node.nodeRef === parent.reservation.nodeRef)?.state === "active");
  await tree.settleNode(parent.reservation.nodeRef, { kind: "completed", reasonCode: "parent_done" });
});

await check("eligible resume is FIFO and an ineligible head cannot starve a later waiter", async () => {
  const tree = governor("eligible", { maxAcceptedRuns: 3, maxActiveExecutions: 2, maxOpenSessions: 3 });
  const head = await tree.authorizeAndDelegate({ delegate: () => registration("head") });
  const blocker = await tree.authorizeAndDelegate({ parentNodeRef: head.reservation.nodeRef, delegate: () => registration("blocker") });
  await tree.waitForChildren(head.reservation.nodeRef);
  const later = await tree.authorizeAndDelegate({ delegate: () => registration("later") });
  await tree.pauseExecution(later.reservation.nodeRef);
  await tree.requestResume(later.reservation.nodeRef);
  let snapshot = tree.snapshot();
  assert(snapshot.nodes.find((node) => node.nodeRef === later.reservation.nodeRef)?.state === "active");
  await tree.settleNode(later.reservation.nodeRef, { kind: "completed", reasonCode: "later_done" });
  await tree.settleNode(blocker.reservation.nodeRef, { kind: "completed", reasonCode: "blocker_done" });
  snapshot = tree.snapshot();
  assert(snapshot.nodes.find((node) => node.nodeRef === head.reservation.nodeRef)?.state === "active");
  await tree.settleNode(head.reservation.nodeRef, { kind: "completed", reasonCode: "head_done" });
});

await check("callback-chain reentry rejects deterministically while external concurrency still queues", async () => {
  const tree = governor("reentrant", { maxAcceptedRuns: 1 });
  let entered;
  const callbackEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const first = tree.authorizeAndDelegate({
    beforeDelegate: async () => {
      await expectCode(tree.beginDrain(), "reentrant_operation");
      entered();
      await barrier;
    },
    delegate: () => registration("run"),
  });
  await callbackEntered;
  const external = tree.beginDrain();
  release();
  const accepted = await first;
  const drainedState = await external;
  assert(drainedState.mode === "draining", "external operation was misclassified as reentrant");
  await tree.settleNode(accepted.reservation.nodeRef, { kind: "completed", reasonCode: "done" });
  assert(tree.snapshot().mode === "terminal");
});

await check("delegation-created immediate and promise continuations can queue governor operations", async () => {
  const settleTree = governor("delegationcontinuation", { maxAcceptedRuns: 1 });
  let settleFromImmediate;
  let terminalContinuation;
  const settledRun = await settleTree.authorizeAndDelegate({
    delegate: (reservation) => {
      settleFromImmediate = new Promise((resolve, reject) => {
        setImmediate(() => settleTree.settleNode(
          reservation.nodeRef,
          { kind: "completed", reasonCode: "delegation_continuation_done" },
        ).then(resolve, reject));
      });
      return registration("run", () => {
        terminalContinuation = Promise.resolve().then(() => settleTree.beginDrain("terminal_continuation_done"));
      });
    },
  });
  await settleFromImmediate;
  await terminalContinuation;
  assert(settleTree.snapshot().nodes.find((node) => node.nodeRef === settledRun.reservation.nodeRef)?.terminal?.source === "settled");
  assert(settleTree.snapshot().rootTerminal?.reasonCode === "terminal_continuation_done");

  const abortTree = governor("promisecontinuation", { maxAcceptedRuns: 1 });
  let abortFromPromise;
  const abortedRun = await abortTree.authorizeAndDelegate({
    delegate: (reservation) => {
      abortFromPromise = Promise.resolve().then(() => abortTree.abortSubtree(reservation.nodeRef, "continuation_abort"));
      return registration("run");
    },
  });
  await abortFromPromise;
  assert(abortTree.snapshot().nodes.find((node) => node.nodeRef === abortedRun.reservation.nodeRef)?.terminal?.source === "abort");
});

await check("subtree and root terminals are first-wins and idempotent", async () => {
  const tree = governor("terminal", { maxAcceptedRuns: 2 });
  const parent = await tree.authorizeAndDelegate({ delegate: () => registration("parent") });
  const child = await tree.authorizeAndDelegate({ parentNodeRef: parent.reservation.nodeRef, delegate: () => registration("child") });
  const revoked = await tree.revokeSubtree(parent.reservation.nodeRef, "policy_revoked");
  const repeated = await tree.abortSubtree(parent.reservation.nodeRef, "late_abort");
  assert(revoked.source === "revoked" && repeated.source === "revoked");
  assert(tree.snapshot().nodes.find((node) => node.nodeRef === child.reservation.nodeRef)?.terminal?.source === "revoked");
  const firstRoot = await tree.shutdown("first_shutdown");
  const secondRoot = await tree.shutdown("second_shutdown");
  assert(firstRoot.rootTerminal?.reasonCode === "first_shutdown" && secondRoot.rootTerminal?.reasonCode === "first_shutdown");
});

await check("deadline, drain, abort, revoke, and shutdown paths fail closed", async () => {
  let now = 100;
  const deadlineTree = governor("deadline", { deadlineMs: 200, maxAcceptedRuns: 1 }, () => now);
  now = 200;
  assert((await deadlineTree.expire()).rootTerminal?.source === "deadline");
  await expectCode(deadlineTree.authorizeAndDelegate({ delegate: () => registration("late") }), "root_deadline_elapsed");

  const drainTree = governor("drain", { maxAcceptedRuns: 2, maxActiveExecutions: 1, maxOpenSessions: 1 });
  const run = await drainTree.authorizeAndDelegate({ delegate: () => registration("run") });
  await drainTree.beginDrain();
  await expectCode(drainTree.authorizeAndDelegate({ delegate: () => registration("denied") }), "tree_not_accepting");
  await drainTree.settleNode(run.reservation.nodeRef, { kind: "completed", reasonCode: "done" });
  assert(drainTree.snapshot().rootTerminal?.source === "drained");

  for (const [rootRef, method, source] of [
    ["abortall", "abortAll", "abort"],
    ["revokeall", "revokeAll", "revoked"],
    ["shutdownall", "shutdown", "shutdown"],
  ]) {
    const tree = governor(rootRef, { maxAcceptedRuns: 1 });
    await tree.authorizeAndDelegate({ delegate: () => registration("run") });
    const stopped = await tree[method]();
    assert(stopped.rootTerminal?.source === source && stopped.budgets.openSessions === 0);
  }
});

console.log("\n[process provider limiter]");
await check("two jiti copies share a provider FIFO and preserve strict order", async () => {
  const modulePath = path.join(dispatchDir, "process-provider-limiter.ts");
  const PA = await createJiti(import.meta.url, { moduleCache: false }).import(modulePath);
  const PB = await createJiti(import.meta.url, { moduleCache: false }).import(modulePath);
  const scope = `delegation-fifo-${process.pid}`;
  const a = new PA.ProcessProviderLimiter({ scope, limits: { openai: 1 } });
  const b = new PB.ProcessProviderLimiter({ scope, limits: { openai: 1 } });
  const lease1 = await a.acquire("openai");
  const order = [];
  const second = b.acquire("openai").then((lease) => { order.push("second"); return lease; });
  const third = a.acquire("openai").then((lease) => { order.push("third"); return lease; });
  lease1.release();
  const lease2 = await second;
  await tick();
  assert(JSON.stringify(order) === JSON.stringify(["second"]));
  lease2.release();
  const lease3 = await third;
  assert(JSON.stringify(order) === JSON.stringify(["second", "third"]));
  lease3.release();
});

await check("aborted waiter is removed and limit zero rejects provider_disabled immediately", async () => {
  const limiter = new P.ProcessProviderLimiter({ scope: `delegation-abort-${process.pid}`, limits: { xai: 1 } });
  const lease = await limiter.acquire("xai");
  const controller = new AbortController();
  const waiter = limiter.acquire("xai", { signal: controller.signal });
  controller.abort();
  await expectCode(waiter, "acquire_aborted");
  assert(limiter.snapshot().providers.xai.pending === 0);
  lease.release();

  const disabled = new P.ProcessProviderLimiter({ scope: `delegation-disabled-${process.pid}`, limits: { xai: 0 } });
  await expectCode(disabled.acquire("xai"), "provider_disabled");
  assert(disabled.snapshot().providers.xai.active === 0 && disabled.snapshot().providers.xai.pending === 0);
});

console.log("\n[required audit and amplifying broker]");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-audit-smoke-"));
const auditPath = path.join(tempRoot, "private", "delegation-v4.jsonl");
const writer = new A.RequiredDelegationAuditWriter(auditPath, () => new Date("2026-07-22T08:00:00.000Z"));
const budget = {
  accepted_runs: 0, active_executions: 0, open_sessions: 0,
  max_accepted_runs: 1, max_active_executions: 1, max_open_sessions: 1,
};
const authorization = {
  audit_version: 4,
  execution_mode: "offline",
  row_kind: "delegation_authorization",
  operation: "delegation_authorize",
  decision: "allow",
  phase: "authorized_pre_delegate",
  request_ref: "audit.request.1",
  root_lineage_ref: "audit",
  lineage_ref: "audit.1",
  parent_lineage_ref: "audit",
  node_depth: 1,
  provider: "openai",
  model: "openai/model-a",
  profile: "read_only",
  tools: ["read"],
  allows_mutation: false,
  capability_id: "audit.1.cap",
  capability_version: 1,
  revocation_generation: 0,
  remaining_depth: 0,
  max_descendant_runs: 0,
  max_concurrent_leaves: 1,
  deadline_ms: 1_000,
  constraint_kinds: [],
  budget_before: budget,
  budget_after: { ...budget, accepted_runs: 1, active_executions: 1, open_sessions: 1 },
};

await check("required authorization is append+sync before delegation with private permissions", async () => {
  let delegationObservedRows = 0;
  const value = await writer.authorizeThenDelegate(authorization, () => {
    delegationObservedRows = rowsAt(auditPath).length;
    return "delegated";
  });
  assert(value === "delegated" && delegationObservedRows === 1);
  assert((fs.statSync(auditPath).mode & 0o777) === 0o600);
  assert((fs.statSync(path.dirname(auditPath)).mode & 0o777) === 0o700);
});

await check("required audit I/O failure prevents delegation", async () => {
  const blockerPath = path.join(tempRoot, "not-a-directory");
  fs.writeFileSync(blockerPath, "block directory creation");
  const failingWriter = new A.RequiredDelegationAuditWriter(path.join(blockerPath, "audit.jsonl"));
  let delegationCalled = false;
  await expectReject(failingWriter.authorizeThenDelegate(authorization, () => { delegationCalled = true; }));
  assert(!delegationCalled);
});

await check("closed v4 denial schema carries request/root/lineage/parent/depth and available selection", async () => {
  await writer.appendDenial({
    audit_version: 4,
    execution_mode: "offline",
    row_kind: "delegation_denial",
    operation: "delegation_authorize",
    decision: "deny",
    request_ref: "audit.request.2",
    root_lineage_ref: "audit",
    lineage_ref: "audit.denied",
    parent_lineage_ref: "audit",
    node_depth: 1,
    reason_code: "capability_escalation",
    provider: "openai",
    model: "openai/model-a",
    profile: "read_only",
  });
  const rows = rowsAt(auditPath);
  assert(rows.length === 2 && rows.every((row) => row.audit_version === 4));
  assert(rows[1].request_ref === "audit.request.2" && rows[1].node_depth === 1);
  assert(!rows.some((row) => "session_id" in row || "prompt" in row || "handle" in row));
});

await check("privacy rejects semantic fields, UUID substrings, unsafe refs/reasons, handles, and schema extras", async () => {
  const uuid = "019f887b-5b54-75be-9b36-e7993f834ab7";
  const unsafe = [
    { raw_prompt: "hidden" },
    { task_text: "hidden" },
    { secret: "sk-0123456789abcdefghijklmnop" },
    { chain_of_thought: "private" },
    { payload: rootCapability.currentHandle() },
    { lineage: `prefix.${uuid}.suffix` },
  ];
  for (const value of unsafe) assert(!A.validateDelegationAuditPrivacy(value).ok);
  assert(A.validateDelegationAuditPrivacy(authorization).ok);
  await expectReject(() => A.assertDelegationAuditEvent({ ...authorization, raw_prompt: "forbidden" }));
  await expectReject(() => A.assertDelegationAuditEvent({ ...authorization, request_ref: `prefix.${uuid}.suffix` }));
  await expectReject(() => A.assertDelegationAuditEvent({
    audit_version: 4,
    execution_mode: "offline",
    row_kind: "delegation_denial",
    operation: "delegation_authorize",
    decision: "deny",
    request_ref: "reason.request.1",
    root_lineage_ref: "reason",
    lineage_ref: "reason.denied",
    parent_lineage_ref: "reason",
    node_depth: 1,
    reason_code: "prompt_injection",
  }));
  await expectCode(() => C.createDelegationCapability(capabilitySpec(`root.${uuid}.suffix`)), "invalid_spec");
  await expectCode(() => governor(`root.${uuid}.suffix`), "invalid_config");
});

await check("flush aggregates and reports every observed background audit error", async () => {
  const aggregateWriter = new A.RequiredDelegationAuditWriter(path.join(tempRoot, "aggregate", "audit.jsonl"));
  const first = new Error("first background failure");
  const second = new Error("second background failure");
  aggregateWriter.reportBackgroundError(first);
  aggregateWriter.reportBackgroundError(second);
  const aggregate = await expectReject(aggregateWriter.flush());
  assert(aggregate?.name === "DelegationAuditBackgroundError");
  assert(aggregate.errors?.length === 2 && aggregate.errors[0] === first && aggregate.errors[1] === second);
  await aggregateWriter.flush();
});

await check("cross-governor capability replay is denied and durably audited", async () => {
  const cap = C.createDelegationCapability(capabilitySpec("treeA"));
  const treeB = governor("treeB", { maxAcceptedRuns: 1 });
  const replayPath = path.join(tempRoot, "replay", "audit.jsonl");
  const replayWriter = new A.RequiredDelegationAuditWriter(replayPath);
  const replayBroker = new B.DelegationBroker({
    governor: treeB,
    executionMode: "offline",
    audit: { mode: "required", writer: replayWriter },
    clock: () => 100,
  });
  let delegated = false;
  await expectCode(replayBroker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    delegate: () => { delegated = true; return { value: "bad" }; },
  })), "capability_binding_mismatch");
  assert(!delegated && treeB.snapshot().budgets.acceptedRuns === 0);
  const [row] = rowsAt(replayPath);
  assert(row.row_kind === "delegation_denial" && row.root_lineage_ref === "treeB");
  assert(row.reason_code === "capability_binding_mismatch");
});

await check("dynamic descendant runs are consumed per holder and never refunded on settle", async () => {
  const cap = C.createDelegationCapability(capabilitySpec("dynamicruns", {
    maxDescendantRuns: 2,
    maxConcurrentLeaves: 2,
  }));
  const tree = governor("dynamicruns", { maxAcceptedRuns: 3 });
  const broker = new B.DelegationBroker({
    governor: tree,
    executionMode: "offline",
    audit: { mode: "off" },
    clock: () => 100,
  });
  const first = await broker.authorizeAndDelegate(brokerRequest(cap.currentHandle()));
  await tree.settleNode(first.nodeRef, { kind: "completed", reasonCode: "first_done" });
  const second = await broker.authorizeAndDelegate(brokerRequest(cap.currentHandle()));
  await tree.settleNode(second.nodeRef, { kind: "completed", reasonCode: "second_done" });
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle())), "descendant_runs_exhausted");
  const budget = C.inspectDelegationCapabilityBudgetForBroker(cap.currentHandle());
  assert(budget.remainingDescendantRuns === 0 && budget.activeDescendantLeaves === 0);
  assert(tree.snapshot().budgets.acceptedRuns === 2, "denied third run reached TreeGovernor commit");
});

await check("all ancestor concurrent-leaf ceilings constrain sibling branches", async () => {
  const cap = C.createDelegationCapability(capabilitySpec("dynamicleaves", {
    maxDescendantRuns: 6,
    maxConcurrentLeaves: 1,
  }));
  const tree = governor("dynamicleaves", { maxAcceptedRuns: 6 });
  const broker = new B.DelegationBroker({
    governor: tree,
    executionMode: "offline",
    audit: { mode: "off" },
    clock: () => 100,
  });
  const parent = await broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    attenuation: { tools: ["read"], maxConcurrentLeaves: 1 },
  }));
  const grandchild = await broker.authorizeAndDelegate(brokerRequest(parent.capability, {
    parentNodeRef: parent.nodeRef,
  }));
  assert(C.inspectDelegationCapabilityBudgetForBroker(cap.currentHandle()).activeDescendantLeaves === 1);
  await expectCode(broker.authorizeAndDelegate(brokerRequest(parent.capability, {
    parentNodeRef: parent.nodeRef,
  })), "concurrent_leaves_exhausted");
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle())), "concurrent_leaves_exhausted");
  assert(tree.snapshot().budgets.acceptedRuns === 2, "leaf denials reached TreeGovernor commit");
  await tree.settleNode(grandchild.nodeRef, { kind: "completed", reasonCode: "grandchild_done" });
  assert(C.inspectDelegationCapabilityBudgetForBroker(cap.currentHandle()).activeDescendantLeaves === 1,
    "open parent did not become the sole ancestor leaf");
  await tree.settleNode(parent.nodeRef, { kind: "completed", reasonCode: "parent_done" });
  assert(C.inspectDelegationCapabilityBudgetForBroker(cap.currentHandle()).activeDescendantLeaves === 0);
});

await check("same-holder concurrent authorization cannot oversell one descendant run", async () => {
  const cap = C.createDelegationCapability(capabilitySpec("holderrace", {
    maxDescendantRuns: 1,
    maxConcurrentLeaves: 2,
  }));
  const tree = governor("holderrace", { maxAcceptedRuns: 2 });
  const broker = new B.DelegationBroker({
    governor: tree,
    executionMode: "offline",
    audit: { mode: "off" },
    clock: () => 100,
  });
  const outcomes = await Promise.allSettled([
    broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), { delegate: () => ({ value: "first" }) })),
    broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), { delegate: () => ({ value: "second" }) })),
  ]);
  assert(outcomes.filter((result) => result.status === "fulfilled").length === 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert(rejected?.reason?.code === "descendant_runs_exhausted");
  assert(tree.snapshot().budgets.acceptedRuns === 1);
  const accepted = outcomes.find((result) => result.status === "fulfilled")?.value;
  await tree.settleNode(accepted.nodeRef, { kind: "completed", reasonCode: "done" });
});

await check("delegation failure releases active leaf but does not refund descendant run", async () => {
  const cap = C.createDelegationCapability(capabilitySpec("branchdelegatefail", {
    maxDescendantRuns: 1,
    maxConcurrentLeaves: 1,
  }));
  const tree = governor("branchdelegatefail", { maxAcceptedRuns: 2 });
  const broker = new B.DelegationBroker({
    governor: tree,
    executionMode: "offline",
    audit: { mode: "off" },
    clock: () => 100,
  });
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    delegate: () => { throw Object.assign(new Error("synthetic"), { code: "synthetic_delegation_failure" }); },
  })), "synthetic_delegation_failure");
  const budget = C.inspectDelegationCapabilityBudgetForBroker(cap.currentHandle());
  assert(budget.activeDescendantLeaves === 0 && budget.remainingDescendantRuns === 0);
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle())), "descendant_runs_exhausted");
  assert(tree.snapshot().budgets.acceptedRuns === 1);
});

await check("subtree terminal revokes that node and descendants without killing a sibling", async () => {
  const cap = C.createDelegationCapability(capabilitySpec("revoketree"));
  const tree = governor("revoketree");
  const broker = new B.DelegationBroker({ governor: tree, executionMode: "offline", audit: { mode: "off" }, clock: () => 100 });
  const childA = await broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), { delegate: () => ({ value: "a" }) }));
  const childB = await broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), { delegate: () => ({ value: "b" }) }));
  const grandchildA = await broker.authorizeAndDelegate(brokerRequest(childA.capability, {
    parentNodeRef: childA.nodeRef,
    delegate: () => ({ value: "aa" }),
  }));
  await expectCode(broker.authorizeAndDelegate(brokerRequest(childB.capability, {
    parentNodeRef: childA.nodeRef,
  })), "capability_binding_mismatch");
  await tree.revokeSubtree(childA.nodeRef, "policy_revoked");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(childA.capability, {}, [{ name: "read", mutation: "none" }], 100), "revoked_capability");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(grandchildA.capability, {}, [{ name: "read", mutation: "none" }], 100), "revoked_capability");
  await expectCode(broker.authorizeAndDelegate(brokerRequest(childA.capability, {
    parentNodeRef: childA.nodeRef,
  })), "revoked_capability");
  assert(C.resolveDelegationCapabilityForBroker(childB.capability, {}, [{ name: "read", mutation: "none" }], 100));
  const grandchildB = await broker.authorizeAndDelegate(brokerRequest(childB.capability, {
    parentNodeRef: childB.nodeRef,
    delegate: () => ({ value: "bb" }),
  }));
  await tree.settleNode(grandchildB.nodeRef, { kind: "completed", reasonCode: "bb_done" });
  await tree.settleNode(childB.nodeRef, { kind: "completed", reasonCode: "b_done" });
});

await check("broker delegation holds no provider lease and limit=1 remains available to a real request", async () => {
  const cap = C.createDelegationCapability(capabilitySpec("nolease", {
    constraints: [{ kind: "max_output_bytes", bytes: 4096 }],
  }));
  const tree = governor("nolease", { maxAcceptedRuns: 1 });
  const limiter = new P.ProcessProviderLimiter({ scope: `broker-no-lease-${process.pid}`, limits: { openai: 1 } });
  const brokerAuditPath = path.join(tempRoot, "nolease", "audit.jsonl");
  const brokerWriter = new A.RequiredDelegationAuditWriter(brokerAuditPath);
  const broker = new B.DelegationBroker({
    governor: tree,
    executionMode: "offline",
    audit: { mode: "required", writer: brokerWriter },
    constraintEnforcer: (constraints) => assert(constraints[0]?.kind === "max_output_bytes"),
    clock: () => 100,
  });
  let realRequestLease;
  const result = await broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    delegate: (input) => {
      assert(!("providerLease" in input), "broker leaked a lifecycle provider lease into delegation");
      assert(limiter.snapshot().providers.openai.active === 0);
      realRequestLease = limiter.acquire("openai");
      return { value: "offline" };
    },
  }));
  const lease = await realRequestLease;
  assert(lease.provider === "openai" && limiter.snapshot().providers.openai.active === 1);
  lease.release();
  await tree.settleNode(result.nodeRef, { kind: "completed", reasonCode: "done" });
  await brokerWriter.flush();
  const rows = rowsAt(brokerAuditPath);
  assert(rows.map((row) => row.row_kind).join(",") === "delegation_authorization,delegation_lifecycle");
  await expectCode(() => C.resolveDelegationCapabilityForBroker(result.capability, {}, [{ name: "read", mutation: "none" }], 100), "revoked_capability");
});

await check("audit success followed by abort closes one lineage and next attempt uses another", async () => {
  const abortController = new AbortController();
  const phantomPath = path.join(tempRoot, "phantom", "audit.jsonl");
  class AbortAfterAuthorizationWriter extends A.RequiredDelegationAuditWriter {
    async appendAuthorizationBeforeDelegate(event) {
      const receipt = await super.appendAuthorizationBeforeDelegate(event);
      abortController.abort();
      return receipt;
    }
  }
  const phantomWriter = new AbortAfterAuthorizationWriter(phantomPath);
  const cap = C.createDelegationCapability(capabilitySpec("phantom"));
  const tree = governor("phantom", { maxAcceptedRuns: 1 });
  const broker = new B.DelegationBroker({
    governor: tree,
    executionMode: "offline",
    audit: { mode: "required", writer: phantomWriter },
    clock: () => 100,
  });
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    signal: abortController.signal,
  })), "authorization_aborted");
  let rows = rowsAt(phantomPath);
  assert(rows.length === 2 && rows[0].row_kind === "delegation_authorization" && rows[1].row_kind === "delegation_denial");
  assert(rows[0].lineage_ref === rows[1].lineage_ref && rows[0].request_ref === rows[1].request_ref);
  assert(tree.snapshot().budgets.acceptedRuns === 0 && tree.snapshot().nodes.length === 0);

  const accepted = await broker.authorizeAndDelegate(brokerRequest(cap.currentHandle()));
  rows = rowsAt(phantomPath);
  const authorizationRows = rows.filter((row) => row.row_kind === "delegation_authorization");
  assert(authorizationRows.length === 2 && authorizationRows[0].lineage_ref !== authorizationRows[1].lineage_ref);
  assert(authorizationRows[0].lineage_ref === "phantom.1" && authorizationRows[1].lineage_ref === "phantom.2");
  await tree.settleNode(accepted.nodeRef, { kind: "completed", reasonCode: "done" });
  await phantomWriter.flush();
});

await check("capability freshness is rechecked after the required audit barrier", async () => {
  const freshnessPath = path.join(tempRoot, "freshness", "audit.jsonl");
  const freshnessWriter = new A.RequiredDelegationAuditWriter(freshnessPath);
  const cap = C.createDelegationCapability(capabilitySpec("freshclock", { deadlineMs: 200 }));
  const tree = governor("freshclock", { maxAcceptedRuns: 1 });
  const times = [100, 100, 200];
  const broker = new B.DelegationBroker({
    governor: tree,
    executionMode: "offline",
    audit: { mode: "required", writer: freshnessWriter },
    clock: () => times.shift() ?? 200,
  });
  let delegated = false;
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    delegate: () => { delegated = true; return { value: "late" }; },
  })), "expired_capability");
  const rows = rowsAt(freshnessPath);
  assert(!delegated && rows.map((row) => row.row_kind).join(",") === "delegation_authorization,delegation_denial");
  assert(rows[0].lineage_ref === rows[1].lineage_ref && rows[1].reason_code === "expired_capability");
});

await check("delegation error remains primary when required lifecycle audit also fails", async () => {
  const lifecyclePath = path.join(tempRoot, "delegate-lifecycle-io-failure", "audit.jsonl");
  const lifecycleError = new Error("synthetic lifecycle I/O failure");
  class LifecycleFailureWriter extends A.RequiredDelegationAuditWriter {
    appendLifecycle() {
      return Promise.reject(lifecycleError);
    }
  }
  const lifecycleWriter = new LifecycleFailureWriter(lifecyclePath);
  const cap = C.createDelegationCapability(capabilitySpec("lifecycleio"));
  const tree = governor("lifecycleio", { maxAcceptedRuns: 1 });
  const broker = new B.DelegationBroker({ governor: tree, executionMode: "offline", audit: { mode: "required", writer: lifecycleWriter }, clock: () => 100 });
  const delegationError = Object.assign(new Error("original delegation failure"), { code: "delegation_failed" });
  const received = await expectReject(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    delegate: () => { throw delegationError; },
  })));
  assert(received === delegationError, "lifecycle audit failure replaced the original delegation error");
  const aggregate = await expectReject(lifecycleWriter.flush());
  assert(aggregate?.errors?.length === 1 && aggregate.errors[0] === lifecycleError);
  assert(rowsAt(lifecyclePath).map((row) => row.row_kind).join(",") === "delegation_authorization");
});

await check("accepted delegation failure writes lifecycle, not denial, and revokes the issued handle", async () => {
  const failurePath = path.join(tempRoot, "delegate-failure", "audit.jsonl");
  const failureWriter = new A.RequiredDelegationAuditWriter(failurePath);
  const cap = C.createDelegationCapability(capabilitySpec("brokerdelegatefail"));
  const tree = governor("brokerdelegatefail", { maxAcceptedRuns: 1 });
  const broker = new B.DelegationBroker({ governor: tree, executionMode: "offline", audit: { mode: "required", writer: failureWriter }, clock: () => 100 });
  let issued;
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    delegate: ({ capability }) => {
      issued = capability;
      throw Object.assign(new Error("synthetic"), { code: "synthetic_delegation_failure" });
    },
  })), "synthetic_delegation_failure");
  await failureWriter.flush();
  const rows = rowsAt(failurePath);
  assert(rows.map((row) => row.row_kind).join(",") === "delegation_authorization,delegation_lifecycle");
  assert(rows[1].terminal_source === "delegation_error" && rows[0].lineage_ref === rows[1].lineage_ref);
  assert(tree.snapshot().budgets.acceptedRuns === 1);
  await expectCode(() => C.resolveDelegationCapabilityForBroker(issued, {}, [{ name: "read", mutation: "none" }], 100), "revoked_capability");
});

await check("unsafe caller lineage falls back to request_ref without replacing the original deny", async () => {
  const rootRef = "unsafeparent";
  const cap = C.createDelegationCapability(capabilitySpec(rootRef));
  const tree = governor(rootRef, { maxAcceptedRuns: 1 });
  const fallbackPath = path.join(tempRoot, "unsafe-parent", "audit.jsonl");
  const fallbackWriter = new A.RequiredDelegationAuditWriter(fallbackPath);
  const broker = new B.DelegationBroker({ governor: tree, executionMode: "offline", audit: { mode: "required", writer: fallbackWriter }, clock: () => 100 });
  const unsafeParent = "caller.019f887b-5b54-75be-9b36-e7993f834ab7.lineage";
  await expectCode(broker.authorizeAndDelegate(brokerRequest(cap.currentHandle(), {
    parentNodeRef: unsafeParent,
  })), "capability_binding_mismatch");
  const [row] = rowsAt(fallbackPath);
  assert(row?.row_kind === "delegation_denial" && row.reason_code === "capability_binding_mismatch");
  assert(row.parent_lineage_ref === row.request_ref && !row.parent_lineage_ref.includes("019f887b"));
});

await check("capability, selection, constraint, governor, abort, and deadline denies all append denial", async () => {
  const cases = [
    ["capability", "invalid_capability", ({ request }) => ({ ...request, parentCapability: Object.freeze(Object.create(null)) })],
    ["provider", "provider_model_mismatch", ({ request }) => ({ ...request, provider: "xai" })],
    ["model", "model_not_authorized", ({ request }) => ({ ...request, model: "openai/model-z" })],
    ["profile", "profile_not_authorized", ({ request }) => ({ ...request, profile: "implementation" })],
    ["constraint", "constraint_enforcer_required", ({ request, rootRef }) => {
      const constrained = C.createDelegationCapability(capabilitySpec(rootRef, { constraints: [{ kind: "max_output_bytes", bytes: 1 }] }));
      return { ...request, parentCapability: constrained.currentHandle() };
    }],
    ["governor", "accepted_run_budget_exhausted", ({ request }) => request],
    ["abort", "authorization_aborted", ({ request }) => {
      const controller = new AbortController();
      controller.abort();
      return { ...request, signal: controller.signal };
    }],
    ["deadline", "root_deadline_elapsed", ({ request }) => request],
  ];
  for (const [label, expected, mutate] of cases) {
    const rootRef = `deny${label}`;
    const cap = C.createDelegationCapability(capabilitySpec(rootRef, { deadlineMs: 20_000 }));
    const limits = label === "governor" ? { maxAcceptedRuns: 0 } : {};
    const clock = label === "deadline" ? () => 10_000 : () => 100;
    const tree = governor(rootRef, { deadlineMs: label === "deadline" ? 10_000 : 20_000, ...limits }, clock);
    const denyPath = path.join(tempRoot, "deny", `${label}.jsonl`);
    const denyWriter = new A.RequiredDelegationAuditWriter(denyPath);
    const broker = new B.DelegationBroker({ governor: tree, executionMode: "offline", audit: { mode: "required", writer: denyWriter }, clock });
    const request = mutate({ request: brokerRequest(cap.currentHandle()), rootRef });
    await expectCode(broker.authorizeAndDelegate(request), expected);
    const [row] = rowsAt(denyPath);
    assert(row?.row_kind === "delegation_denial" && row.reason_code === expected, `${label} denial row missing`);
    assert(row.provider === request.provider && row.model === request.model && row.profile === request.profile);
  }
});

console.log("\n[source isolation and current enforcement]");
await check("production imports delegation core only through the shadow bridge", () => {
  const coreModuleNames = new Set([
    "delegation-capability", "delegation-broker", "tree-governor",
    "process-provider-limiter", "delegation-audit",
  ]);
  const shadowModuleName = "delegation-shadow-bridge";
  const newModuleFiles = new Set(
    [...coreModuleNames, shadowModuleName].map((name) => path.join(dispatchDir, `${name}.ts`)),
  );
  for (const file of sourceFilesUnder(path.join(root, "extensions"))) {
    if (newModuleFiles.has(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of dependencySpecifiers(file, source)) {
      const importedName = path.basename(specifier).replace(/\.[^.]+$/, "");
      assert(!coreModuleNames.has(importedName), `${path.relative(root, file)} bypasses the shadow bridge via ${specifier}`);
      if (importedName === shadowModuleName) {
        assert(file === path.join(dispatchDir, "index.ts"), `${path.relative(root, file)} imports the shadow bridge`);
      }
    }
  }
});

await check("new core has no pi activation, live nested session, prompt, or broker provider lease path", () => {
  const files = [
    "delegation-capability.ts", "delegation-broker.ts", "tree-governor.ts",
    "process-provider-limiter.ts", "delegation-audit.ts", "delegation-shadow-bridge.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(dispatchDir, file), "utf8");
    assert(!/\bcreateAgentSession\b|\.prompt\s*\(|\bregisterTool\s*\(|\bExtensionAPI\b/.test(source), `${file} contains a live runtime path`);
  }
  const brokerSource = fs.readFileSync(path.join(dispatchDir, "delegation-broker.ts"), "utf8");
  assert(!/ProcessProviderLimiter|ProviderLease|providerLimiter/.test(brokerSource), "broker still owns a provider lease");
});

await check("production dispatch still enforces exactly five structural denies twice", () => {
  const source = fs.readFileSync(path.join(dispatchDir, "index.ts"), "utf8");
  const match = source.match(/const DISABLED_SUBAGENT_TOOLS = \[([\s\S]*?)\] as const;/);
  const actual = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  const expected = ["dispatch_agent", "dispatch_parallel", "workflow_run", "prompt_user", "vault_release"];
  assert(JSON.stringify(actual) === JSON.stringify(expected), `deny set drift: ${actual}`);
  assert(/DISABLED_SUBAGENT_TOOL_NAMES\.has\(normalized\)/.test(source));
  assert(/excludeTools:\s*resolveSubAgentExcludeTools\(toolAllowlist, executionContext\?\.delegation\)/.test(source));
  assert(/return DISABLED_SUBAGENT_TOOLS\.filter\(\(name\) => !shadowGranted\.has\(name\)\)/.test(source));
});

console.log(`\npass=${passed}, fail=${failures.length}`);
if (failures.length > 0) process.exit(1);
