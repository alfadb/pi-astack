/// <reference types="node" />

/**
 * Non-delegating delegation shadow bridge.
 *
 * Session identity is only a WeakMap key. Root claims contain opaque claim
 * tokens, never SessionManager or binding references, so abandoned sessions do
 * not become process-global strong roots.
 */

import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
  createDelegationCapability,
  inspectDelegationCapabilityBudgetForBroker,
  type DelegationCapabilityController,
  type DelegationToolDescriptor,
} from "./delegation-capability";
import { RequiredDelegationAuditWriter } from "./delegation-audit";
import { DelegationBroker } from "./delegation-broker";
import { TreeGovernor } from "./tree-governor";

const SHADOW_FIELDS = Object.freeze([
  "mode",
  "maxDepth",
  "maxDescendantRuns",
  "maxConcurrentLeaves",
  "maxAcceptedRuns",
  "maxActiveExecutions",
  "maxOpenSessions",
  "maxRuntimeMs",
  "allowedModels",
  "allowedTools",
  "allowedProfiles",
  "allowsMutation",
] as const);
const SHADOW_FIELD_SET = new Set<string>(SHADOW_FIELDS);
const HOST_MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

export const shadowDelegationSchema = Type.Object({
  mode: Type.Literal("shadow"),
  maxDepth: Type.Integer({ minimum: 0 }),
  maxDescendantRuns: Type.Integer({ minimum: 0 }),
  maxConcurrentLeaves: Type.Integer({ minimum: 0 }),
  maxAcceptedRuns: Type.Integer({ minimum: 0 }),
  maxActiveExecutions: Type.Integer({ minimum: 0 }),
  maxOpenSessions: Type.Integer({ minimum: 0 }),
  maxRuntimeMs: Type.Integer({ minimum: 0 }),
  allowedModels: Type.Array(Type.String(), { uniqueItems: true }),
  allowedTools: Type.Array(Type.String(), { uniqueItems: true }),
  allowedProfiles: Type.Array(Type.String(), { uniqueItems: true }),
  allowsMutation: Type.Boolean(),
}, { additionalProperties: false });

export interface ShadowDelegationConfig {
  mode: "shadow";
  maxDepth: number;
  maxDescendantRuns: number;
  maxConcurrentLeaves: number;
  maxAcceptedRuns: number;
  maxActiveExecutions: number;
  maxOpenSessions: number;
  maxRuntimeMs: number;
  allowedModels: readonly string[];
  allowedTools: readonly string[];
  allowedProfiles: readonly string[];
  allowsMutation: boolean;
}

export interface ShadowDelegationValidation {
  ok: boolean;
  value?: ShadowDelegationConfig;
  reasonCode?: string;
  reason?: string;
}

export interface ShadowNestedTask {
  model: string;
  profile: string;
  tools: readonly string[];
  allowsMutation: boolean;
  inputText: string;
}

export interface ShadowDispatchEvaluationRequest {
  operation: "dispatch_agent" | "dispatch_parallel";
  tasks: readonly ShadowNestedTask[];
  signal?: AbortSignal;
}

export interface ShadowRemainingBudget {
  descendant_runs: number;
  active_descendant_leaves: number;
  accepted_runs: number;
  active_executions: number;
  open_sessions: number;
  max_descendant_runs: number;
  max_concurrent_leaves: number;
  max_accepted_runs: number;
  max_active_executions: number;
  max_open_sessions: number;
  deadline_ms: number;
}

export interface ShadowTaskDecision {
  kind: "shadow_no_delegate";
  decision: "would_allow" | "would_deny";
  reason_code: string;
  root_lineage_ref: string;
  lineage_ref: string;
  parent_lineage_ref: string;
  node_depth: number;
  input_fingerprint: string;
  remaining: ShadowRemainingBudget;
}

export interface ShadowDispatchToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    kind: "shadow_no_delegate";
    operation: "dispatch_agent" | "dispatch_parallel";
    decision: "would_allow" | "would_deny";
    reason_code: string;
    tasks: readonly ShadowTaskDecision[];
    remaining: ShadowRemainingBudget;
  };
  isError?: boolean;
}

export function shadowDispatchDenyResult(
  operation: "dispatch_agent" | "dispatch_parallel",
  reasonCodeValue: string,
): ShadowDispatchToolResult {
  const remaining: ShadowRemainingBudget = {
    descendant_runs: 0,
    active_descendant_leaves: 0,
    accepted_runs: 0,
    active_executions: 0,
    open_sessions: 0,
    max_descendant_runs: 0,
    max_concurrent_leaves: 0,
    max_accepted_runs: 0,
    max_active_executions: 0,
    max_open_sessions: 0,
    deadline_ms: 0,
  };
  const details = {
    kind: "shadow_no_delegate" as const,
    operation,
    decision: "would_deny" as const,
    reason_code: reasonCodeValue,
    tasks: Object.freeze([]) as readonly ShadowTaskDecision[],
    remaining,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: true,
  };
}

interface SessionRegistryView {
  getAllTools(): Array<{ name: string }>;
  getActiveToolNames(): string[];
}

interface ShadowBinding {
  rootRef: string;
  config: ShadowDelegationConfig;
  deadlineMs: number;
  governor: TreeGovernor;
  controller: DelegationCapabilityController;
  writer: RequiredDelegationAuditWriter;
  claimToken: object;
  registry?: readonly DelegationToolDescriptor[];
  closed: boolean;
  shutdownPromise?: Promise<void>;
  clock: () => number;
}

interface ShadowBridgeTestHooks {
  shutdownFlushFailure: Error | undefined;
  onShutdownStart?: () => void;
}

interface ShadowSharedState {
  bindings: WeakMap<object, ShadowBinding>;
  claims: Map<string, object>;
  nextRoot: number;
  hmacKey: Buffer;
  testHooks?: ShadowBridgeTestHooks;
}

const SHADOW_STATE_KEY = Symbol.for("pi-astack/dispatch/delegation-shadow-bridge/v1");
const SHADOW_NO_DELEGATE_SENTINEL = Object.freeze(Object.create(null)) as Record<string, never>;

function sharedState(): ShadowSharedState {
  const root = globalThis as Record<symbol, unknown>;
  let state = root[SHADOW_STATE_KEY] as ShadowSharedState | undefined;
  if (
    !state ||
    !(state.bindings instanceof WeakMap) ||
    !(state.claims instanceof Map) ||
    !Buffer.isBuffer(state.hmacKey)
  ) {
    state = {
      bindings: new WeakMap<object, ShadowBinding>(),
      claims: new Map<string, object>(),
      nextRoot: 1,
      hmacKey: randomBytes(32),
    };
    root[SHADOW_STATE_KEY] = state;
  }
  return state;
}

function managerKey(value: unknown): object | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? value as object
    : undefined;
}

function finiteNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\0]/.test(value);
}

function canonicalNames(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw Object.assign(new Error(`${field} must be an array`), { code: "invalid_shadow_delegation" });
  if (!value.every(validName)) {
    throw Object.assign(new Error(`${field} entries must be exact non-empty names without whitespace`), {
      code: "invalid_shadow_delegation",
    });
  }
  if (new Set(value).size !== value.length) {
    throw Object.assign(new Error(`${field} must not contain duplicates`), { code: "invalid_shadow_delegation" });
  }
  return Object.freeze([...value].sort());
}

function parseShadowDelegation(value: unknown): ShadowDelegationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("delegation must be an exact object"), { code: "invalid_shadow_delegation" });
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  const missing = SHADOW_FIELDS.filter((field) => !(field in record));
  const extras = actualKeys.filter((field) => !SHADOW_FIELD_SET.has(field));
  if (missing.length > 0 || extras.length > 0) {
    throw Object.assign(
      new Error(`delegation fields differ: missing=[${missing.join(",")}] extra=[${extras.join(",")}]`),
      { code: "invalid_shadow_delegation" },
    );
  }
  if (record.mode !== "shadow") {
    throw Object.assign(new Error("delegation mode must be shadow"), { code: "invalid_shadow_delegation" });
  }
  for (const field of [
    "maxDepth",
    "maxDescendantRuns",
    "maxConcurrentLeaves",
    "maxAcceptedRuns",
    "maxActiveExecutions",
    "maxOpenSessions",
    "maxRuntimeMs",
  ] as const) {
    if (!finiteNonNegativeSafeInteger(record[field])) {
      throw Object.assign(new Error(`${field} must be a finite non-negative safe integer`), {
        code: "invalid_shadow_delegation",
      });
    }
  }
  if (record.allowsMutation !== true && record.allowsMutation !== false) {
    throw Object.assign(new Error("allowsMutation must be boolean"), { code: "invalid_shadow_delegation" });
  }
  return Object.freeze({
    mode: "shadow",
    maxDepth: record.maxDepth as number,
    maxDescendantRuns: record.maxDescendantRuns as number,
    maxConcurrentLeaves: record.maxConcurrentLeaves as number,
    maxAcceptedRuns: record.maxAcceptedRuns as number,
    maxActiveExecutions: record.maxActiveExecutions as number,
    maxOpenSessions: record.maxOpenSessions as number,
    maxRuntimeMs: record.maxRuntimeMs as number,
    allowedModels: canonicalNames(record.allowedModels, "allowedModels"),
    allowedTools: canonicalNames(record.allowedTools, "allowedTools"),
    allowedProfiles: canonicalNames(record.allowedProfiles, "allowedProfiles"),
    allowsMutation: record.allowsMutation as boolean,
  });
}

export function validateShadowDelegation(value: unknown): ShadowDelegationValidation {
  try {
    return { ok: true, value: parseShadowDelegation(value) };
  } catch (error) {
    return {
      ok: false,
      reasonCode: reasonCode(error, "invalid_shadow_delegation"),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function shadowDispatchToolsGranted(
  tools: readonly string[],
  delegation: unknown,
): ReadonlySet<string> {
  const parsed = validateShadowDelegation(delegation);
  if (!parsed.ok || !parsed.value) return new Set<string>();
  const requested = new Set(tools);
  const authorized = new Set(parsed.value.allowedTools);
  return new Set(["dispatch_agent", "dispatch_parallel"].filter(
    (name) => requested.has(name) && authorized.has(name),
  ));
}

function safeDeadline(nowMs: number, maxRuntimeMs: number): number {
  if (!finiteNonNegativeSafeInteger(nowMs)) {
    throw Object.assign(new Error("shadow clock must return a finite non-negative safe integer"), {
      code: "invalid_shadow_delegation",
    });
  }
  if (nowMs > Number.MAX_SAFE_INTEGER - maxRuntimeMs) {
    throw Object.assign(new Error("shadow root deadline overflows the safe integer domain"), {
      code: "invalid_shadow_delegation",
    });
  }
  return nowMs + maxRuntimeMs;
}

function nextRootRef(): string {
  const state = sharedState();
  return `shadow.${process.pid}.${state.nextRoot++}`;
}

function claimRoot(rootRef: string): object {
  const state = sharedState();
  if (state.claims.has(rootRef)) {
    throw Object.assign(new Error(`shadow root ${rootRef} is already claimed`), { code: "shadow_root_claimed" });
  }
  const token = Object.freeze(Object.create(null));
  state.claims.set(rootRef, token);
  return token;
}

function releaseRoot(rootRef: string, token: object): void {
  const claims = sharedState().claims;
  if (claims.get(rootRef) === token) claims.delete(rootRef);
}

export interface CreateShadowWorkerBindingOptions {
  projectRoot: string;
  auditPath?: string;
  rootRef?: string;
  clock?: () => number;
}

export function createShadowWorkerBinding(
  sessionManager: unknown,
  delegation: unknown,
  options: CreateShadowWorkerBindingOptions,
): { rootRef: string; deadlineMs: number; auditPath: string } {
  const key = managerKey(sessionManager);
  if (!key) throw Object.assign(new Error("SessionManager identity is required"), { code: "invalid_session_manager" });
  const config = parseShadowDelegation(delegation);
  const clock = options.clock ?? Date.now;
  const deadlineMs = safeDeadline(clock(), config.maxRuntimeMs);
  const rootRef = options.rootRef ?? nextRootRef();
  const claimToken = claimRoot(rootRef);
  try {
    const controller = createDelegationCapability({
      rootRef,
      tools: config.allowedTools,
      models: config.allowedModels,
      profiles: config.allowedProfiles,
      deadlineMs,
      maxDepth: config.maxDepth,
      maxDescendantRuns: config.maxDescendantRuns,
      maxConcurrentLeaves: config.maxConcurrentLeaves,
      allowsMutation: config.allowsMutation,
    });
    const governor = new TreeGovernor({
      rootRef,
      deadlineMs,
      maxAcceptedRuns: config.maxAcceptedRuns,
      maxActiveExecutions: config.maxActiveExecutions,
      maxOpenSessions: config.maxOpenSessions,
    }, clock);
    const auditPath = options.auditPath ?? join(
      resolve(options.projectRoot),
      ".pi-astack",
      "dispatch",
      "delegation-shadow-v4.jsonl",
    );
    const binding: ShadowBinding = {
      rootRef,
      config,
      deadlineMs,
      governor,
      controller,
      writer: new RequiredDelegationAuditWriter(auditPath),
      claimToken,
      closed: false,
      clock,
    };
    const existing = sharedState().bindings.get(key);
    if (existing && !existing.closed) {
      throw Object.assign(new Error("SessionManager already has a shadow binding"), {
        code: "shadow_binding_exists",
      });
    }
    sharedState().bindings.set(key, binding);
    return { rootRef, deadlineMs, auditPath };
  } catch (error) {
    releaseRoot(rootRef, claimToken);
    throw error;
  }
}

export function activateShadowWorkerBinding(
  sessionManager: unknown,
  session: SessionRegistryView,
): void {
  const key = managerKey(sessionManager);
  const binding = key ? sharedState().bindings.get(key) : undefined;
  if (!binding || binding.closed) return;
  const activeNames = new Set(session.getActiveToolNames().filter(validName));
  const descriptors = new Map<string, DelegationToolDescriptor>();
  for (const tool of session.getAllTools()) {
    if (!validName(tool?.name) || !activeNames.has(tool.name) || descriptors.has(tool.name)) continue;
    descriptors.set(tool.name, {
      name: tool.name,
      mutation: HOST_MUTATING_TOOLS.has(tool.name) ? "host" : "none",
    });
  }
  binding.registry = Object.freeze([...descriptors.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

/** Test-only fault injection for disposal isolation. Never include audit data in hooks. */
export function _setShadowBridgeTestHooksForTests(
  hooks?: { shutdownFlushFailure?: Error; onShutdownStart?: () => void },
): void {
  sharedState().testHooks = hooks
    ? { shutdownFlushFailure: hooks.shutdownFlushFailure, onShutdownStart: hooks.onShutdownStart }
    : undefined;
}

export function hasShadowWorkerBinding(sessionManager: unknown): boolean {
  const key = managerKey(sessionManager);
  const binding = key ? sharedState().bindings.get(key) : undefined;
  return !!binding && !binding.closed;
}

function inputFingerprint(input: string): string {
  return createHmac("sha256", sharedState().hmacKey).update(input, "utf8").digest("hex");
}

function reasonCode(error: unknown, fallback = "shadow_evaluation_failed"): string {
  const raw = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : fallback;
}

function remainingBudget(binding: ShadowBinding): ShadowRemainingBudget {
  const tree = binding.governor.snapshot().budgets;
  let descendantRuns = 0;
  let activeLeaves = 0;
  try {
    const capability = inspectDelegationCapabilityBudgetForBroker(binding.controller.currentHandle());
    descendantRuns = capability.remainingDescendantRuns;
    activeLeaves = capability.activeDescendantLeaves;
  } catch {
    // Revoked/closed roots expose no remaining authority.
  }
  return {
    descendant_runs: descendantRuns,
    active_descendant_leaves: activeLeaves,
    accepted_runs: tree.acceptedRuns,
    active_executions: tree.activeExecutions,
    open_sessions: tree.openSessions,
    max_descendant_runs: binding.config.maxDescendantRuns,
    max_concurrent_leaves: binding.config.maxConcurrentLeaves,
    max_accepted_runs: tree.maxAcceptedRuns,
    max_active_executions: tree.maxActiveExecutions,
    max_open_sessions: tree.maxOpenSessions,
    deadline_ms: binding.deadlineMs,
  };
}

function assertNoDelegationSentinel(value: unknown): asserts value is typeof SHADOW_NO_DELEGATE_SENTINEL {
  if (
    value !== SHADOW_NO_DELEGATE_SENTINEL ||
    Reflect.ownKeys(value as object).length !== 0 ||
    typeof (value as { abort?: unknown }).abort === "function" ||
    typeof (value as { dispose?: unknown }).dispose === "function" ||
    typeof (value as { subscribe?: unknown }).subscribe === "function"
  ) {
    throw Object.assign(new Error("shadow delegation adapter returned a runtime object"), {
      code: "shadow_delegation_invariant_failed",
    });
  }
}

async function evaluateTask(
  binding: ShadowBinding,
  task: ShadowNestedTask,
  signal: AbortSignal | undefined,
): Promise<ShadowTaskDecision> {
  const fingerprint = inputFingerprint(task.inputText);
  const fallback = {
    kind: "shadow_no_delegate" as const,
    root_lineage_ref: binding.rootRef,
    lineage_ref: binding.rootRef,
    parent_lineage_ref: binding.rootRef,
    node_depth: 1,
    input_fingerprint: fingerprint,
  };
  if (binding.closed) {
    return {
      ...fallback,
      decision: "would_deny",
      reason_code: "shadow_binding_closed",
      remaining: remainingBudget(binding),
    };
  }

  const broker = new DelegationBroker({
    governor: binding.governor,
    executionMode: "shadow",
    audit: { mode: "required", writer: binding.writer },
    clock: binding.clock,
  });
  let acceptedNodeRef: string | undefined;
  try {
    const result = await broker.authorizeAndDelegate({
      parentCapability: binding.controller.currentHandle(),
      attenuation: {
        tools: task.tools,
        models: [task.model],
        profiles: [task.profile],
        ...(task.allowsMutation ? {} : { allowsMutation: false }),
      },
      registry: binding.registry ?? [],
      provider: task.model.split("/")[0] ?? "",
      model: task.model,
      profile: task.profile,
      ...(signal ? { signal } : {}),
      delegate: () => {
        const value = SHADOW_NO_DELEGATE_SENTINEL;
        assertNoDelegationSentinel(value);
        return { value };
      },
    });
    acceptedNodeRef = result.nodeRef;
    assertNoDelegationSentinel(result.value);
    await binding.governor.settleNode(result.nodeRef, {
      kind: "completed",
      reasonCode: "shadow_no_delegate",
    });
    await binding.writer.flush();
    return {
      ...fallback,
      decision: "would_allow",
      reason_code: "shadow_no_delegate",
      lineage_ref: result.nodeRef,
      parent_lineage_ref: binding.rootRef,
      node_depth: 1,
      remaining: remainingBudget(binding),
    };
  } catch (error) {
    if (acceptedNodeRef) {
      try { await binding.governor.abortSubtree(acceptedNodeRef, "shadow_evaluation_failed"); } catch { /* first terminal wins */ }
    }
    try { await binding.writer.flush(); } catch { /* required writer failure is reflected by the original denial */ }
    return {
      ...fallback,
      decision: "would_deny",
      reason_code: reasonCode(error),
      remaining: remainingBudget(binding),
    };
  }
}

export async function evaluateShadowDispatchIfBound(
  sessionManager: unknown,
  request: ShadowDispatchEvaluationRequest,
): Promise<ShadowDispatchToolResult | undefined> {
  const key = managerKey(sessionManager);
  const binding = key ? sharedState().bindings.get(key) : undefined;
  if (!binding) return undefined;
  const decisions = await Promise.all(request.tasks.map(
    (task) => evaluateTask(binding, task, request.signal),
  ));
  const allowed = decisions.length > 0 && decisions.every((decision) => decision.decision === "would_allow");
  const reason = allowed
    ? "shadow_no_delegate"
    : decisions.find((decision) => decision.decision === "would_deny")?.reason_code ?? "shadow_no_tasks";
  const details = {
    kind: "shadow_no_delegate" as const,
    operation: request.operation,
    decision: allowed ? "would_allow" as const : "would_deny" as const,
    reason_code: reason,
    tasks: Object.freeze(decisions),
    remaining: remainingBudget(binding),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    ...(!allowed ? { isError: true } : {}),
  };
}

export async function revokeShadowWorkerBinding(
  sessionManager: unknown,
  reasonCodeValue = "shadow_revoked",
): Promise<boolean> {
  const key = managerKey(sessionManager);
  const binding = key ? sharedState().bindings.get(key) : undefined;
  if (!binding || binding.closed) return false;
  binding.controller.revoke();
  await binding.governor.revokeAll(reasonCodeValue);
  await binding.writer.flush();
  return true;
}

export async function shutdownShadowWorkerBinding(
  sessionManager: unknown,
  reasonCodeValue = "shadow_shutdown",
): Promise<boolean> {
  const key = managerKey(sessionManager);
  const binding = key ? sharedState().bindings.get(key) : undefined;
  if (!binding) return false;
  if (binding.shutdownPromise) {
    await binding.shutdownPromise;
    return true;
  }
  binding.closed = true;
  sharedState().bindings.delete(key!);
  binding.controller.revoke();
  binding.shutdownPromise = (async () => {
    try {
      try { sharedState().testHooks?.onShutdownStart?.(); } catch { /* test diagnostics are best-effort */ }
      await binding.governor.shutdown(reasonCodeValue);
      const hooks = sharedState().testHooks;
      const injectedFlushFailure = hooks?.shutdownFlushFailure;
      if (hooks) hooks.shutdownFlushFailure = undefined;
      if (injectedFlushFailure) throw injectedFlushFailure;
      await binding.writer.flush();
    } finally {
      releaseRoot(binding.rootRef, binding.claimToken);
    }
  })();
  await binding.shutdownPromise;
  return true;
}
