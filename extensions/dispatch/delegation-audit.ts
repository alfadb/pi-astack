/// <reference types="node" />

/** Required, privacy-constrained delegation audit schema v4. */

import { constants } from "node:fs";
import { mkdir, open, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export const DELEGATION_AUDIT_VERSION = 4 as const;
export type DelegationExecutionMode = "offline" | "shadow";

export interface DelegationAuditBudget {
  accepted_runs: number;
  active_executions: number;
  open_sessions: number;
  max_accepted_runs: number;
  max_active_executions: number;
  max_open_sessions: number;
}

interface DelegationLineageAuditFields {
  request_ref: string;
  root_lineage_ref: string;
  lineage_ref: string;
  parent_lineage_ref: string;
  node_depth: number;
}

interface DelegationCapabilityAuditFields {
  capability_id: string;
  capability_version: number;
  revocation_generation: number;
}

export interface DelegationAuthorizationAuditEvent extends DelegationLineageAuditFields, DelegationCapabilityAuditFields {
  audit_version: typeof DELEGATION_AUDIT_VERSION;
  execution_mode: DelegationExecutionMode;
  row_kind: "delegation_authorization";
  operation: "delegation_authorize";
  decision: "allow";
  phase: "authorized_pre_delegate";
  provider: string;
  model: string;
  profile: string;
  tools: readonly string[];
  allows_mutation: boolean;
  remaining_depth: number;
  max_descendant_runs: number;
  max_concurrent_leaves: number;
  deadline_ms: number;
  constraint_kinds: readonly string[];
  budget_before: DelegationAuditBudget;
  budget_after: DelegationAuditBudget;
}

export interface DelegationDenialAuditEvent extends DelegationLineageAuditFields {
  audit_version: typeof DELEGATION_AUDIT_VERSION;
  execution_mode: DelegationExecutionMode;
  row_kind: "delegation_denial";
  operation: "delegation_authorize";
  decision: "deny";
  reason_code: string;
  provider?: string;
  model?: string;
  profile?: string;
}

export interface DelegationLifecycleAuditEvent extends DelegationLineageAuditFields, DelegationCapabilityAuditFields {
  audit_version: typeof DELEGATION_AUDIT_VERSION;
  execution_mode: DelegationExecutionMode;
  row_kind: "delegation_lifecycle";
  operation: "delegation_lifecycle";
  terminal_kind: "completed" | "failed" | "cancelled";
  terminal_source: "settled" | "delegation_error" | "abort" | "revoked" | "shutdown" | "deadline" | "drained";
  reason_code: string;
}

export type DelegationAuditEvent =
  | DelegationAuthorizationAuditEvent
  | DelegationDenialAuditEvent
  | DelegationLifecycleAuditEvent;

export interface DelegationAuditReceipt {
  path: string;
  bytesSynced: number;
}

export interface DelegationAuditPrivacyVerdict {
  ok: boolean;
  issues: readonly string[];
}

export class DelegationAuditBackgroundError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super(`required delegation audit had ${errors.length} background error(s)`);
    this.name = "DelegationAuditBackgroundError";
  }
}

const AUDIT_CHAINS_KEY = Symbol.for("pi-astack/dispatch/delegation-required-audit/v2");
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const SECRET_LIKE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|api)[-_][A-Za-z0-9_-]{16,}/i;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const REASON_SEMANTIC_FIELD = /prompt|task|reasoning|secret|credential|password|chainofthought/;
const TOP_LEVEL_KEYS = new Set([
  "audit_version", "execution_mode", "row_kind", "operation", "decision", "phase", "request_ref",
  "root_lineage_ref", "lineage_ref", "parent_lineage_ref", "node_depth", "provider",
  "model", "profile", "tools", "allows_mutation", "capability_id", "capability_version",
  "revocation_generation", "remaining_depth", "max_descendant_runs", "max_concurrent_leaves",
  "deadline_ms", "constraint_kinds", "budget_before", "budget_after", "reason_code",
  "terminal_kind", "terminal_source", "timestamp", "pid",
]);
const BUDGET_KEYS = new Set([
  "accepted_runs", "active_executions", "open_sessions", "max_accepted_runs",
  "max_active_executions", "max_open_sessions",
]);
const LINEAGE_KEYS = [
  "request_ref", "root_lineage_ref", "lineage_ref", "parent_lineage_ref", "node_depth",
] as const;
const CAPABILITY_KEYS = ["capability_id", "capability_version", "revocation_generation"] as const;
const AUTHORIZATION_KEYS = new Set([
  "audit_version", "execution_mode", "row_kind", "operation", "decision", "phase", ...LINEAGE_KEYS,
  "provider", "model", "profile", "tools", "allows_mutation", ...CAPABILITY_KEYS,
  "remaining_depth", "max_descendant_runs", "max_concurrent_leaves", "deadline_ms",
  "constraint_kinds", "budget_before", "budget_after",
]);
const DENIAL_REQUIRED_KEYS = new Set([
  "audit_version", "execution_mode", "row_kind", "operation", "decision", ...LINEAGE_KEYS, "reason_code",
]);
const DENIAL_OPTIONAL_KEYS = new Set(["provider", "model", "profile"]);
const LIFECYCLE_KEYS = new Set([
  "audit_version", "execution_mode", "row_kind", "operation", ...LINEAGE_KEYS, ...CAPABILITY_KEYS,
  "terminal_kind", "terminal_source", "reason_code",
]);

function auditChains(): Map<string, Promise<void>> {
  const root = globalThis as Record<symbol, unknown>;
  let chains = root[AUDIT_CHAINS_KEY] as Map<string, Promise<void>> | undefined;
  if (!(chains instanceof Map)) {
    chains = new Map<string, Promise<void>>();
    root[AUDIT_CHAINS_KEY] = chains;
  }
  return chains;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.includes("prompt") ||
    normalized.includes("task") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("apikey") ||
    normalized.includes("password") ||
    normalized.includes("chainofthought") ||
    normalized === "cot" ||
    normalized.includes("reasoning") ||
    normalized.includes("handle") ||
    normalized.includes("sessionid") ||
    normalized.includes("rawsession");
}

function walkPrivacy(value: unknown, path: string, issues: string[], seen: WeakSet<object>): void {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (UUID_LIKE.test(value)) issues.push(`${path} contains a UUID-like raw session identifier`);
    if (SECRET_LIKE.test(value)) issues.push(`${path} contains secret-like material`);
    return;
  }
  if (typeof value !== "object") {
    issues.push(`${path} contains unsupported ${typeof value} data`);
    return;
  }
  if (seen.has(value)) {
    issues.push(`${path} contains a cycle`);
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkPrivacy(item, `${path}[${index}]`, issues, seen));
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    issues.push(`${path} contains a non-plain object (handles and runtime objects are forbidden)`);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(key)) issues.push(`${path}.${key} is a forbidden privacy field`);
    walkPrivacy(child, `${path}.${key}`, issues, seen);
  }
}

export function validateDelegationAuditPrivacy(value: unknown): DelegationAuditPrivacyVerdict {
  const issues: string[] = [];
  walkPrivacy(value, "$", issues, new WeakSet<object>());
  return { ok: issues.length === 0, issues: Object.freeze(issues) };
}

function finiteNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0;
}

function safeName(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\0]/.test(value);
}

function safeRef(value: unknown): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    !UUID_LIKE.test(value);
}

function safeReasonCode(value: unknown): boolean {
  return typeof value === "string" && REASON_CODE.test(value) && !REASON_SEMANTIC_FIELD.test(value);
}

function validBudget(value: unknown): value is DelegationAuditBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== BUDGET_KEYS.size || !entries.every(
    ([key, field]) => BUDGET_KEYS.has(key) && finiteNonNegativeInteger(field),
  )) return false;
  const budget = value as DelegationAuditBudget;
  return budget.accepted_runs <= budget.max_accepted_runs &&
    budget.active_executions <= budget.max_active_executions &&
    budget.open_sessions <= budget.max_open_sessions;
}

function assertExactKeys(event: object, expected: ReadonlySet<string>, rowKind: string): void {
  const actual = Object.keys(event);
  const missing = [...expected].filter((key) => !(key in event));
  const extra = actual.filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${rowKind} fields differ: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
  }
}

function assertLineage(event: Record<string, unknown>): void {
  for (const key of LINEAGE_KEYS.slice(0, 4)) {
    if (!safeRef(event[key])) throw new Error(`delegation audit ${key} is not audit-safe`);
  }
  if (!finiteNonNegativeInteger(event.node_depth)) throw new Error("delegation audit node_depth is invalid");
}

function assertCapability(event: Record<string, unknown>): void {
  if (!safeRef(event.capability_id)) throw new Error("delegation audit capability_id is not audit-safe");
  if (!finiteNonNegativeInteger(event.capability_version) || !finiteNonNegativeInteger(event.revocation_generation)) {
    throw new Error("delegation audit capability version fields are invalid");
  }
}

function assertClosedSchema(event: DelegationAuditEvent | Record<string, unknown>): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("delegation audit event must be an object");
  for (const key of Object.keys(event)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`delegation audit event contains unknown field ${key}`);
  }
  if (event.audit_version !== DELEGATION_AUDIT_VERSION) throw new Error("delegation audit event must use audit_version 4");
  if (event.execution_mode !== "offline" && event.execution_mode !== "shadow") {
    throw new Error("delegation audit execution_mode is invalid");
  }
  assertLineage(event as unknown as Record<string, unknown>);

  if (event.row_kind === "delegation_authorization") {
    assertExactKeys(event, AUTHORIZATION_KEYS, event.row_kind);
    const row = event as DelegationAuthorizationAuditEvent;
    assertCapability(row as unknown as Record<string, unknown>);
    if (row.operation !== "delegation_authorize" || row.decision !== "allow" || row.phase !== "authorized_pre_delegate") {
      throw new Error("delegation authorization event has invalid decision phase");
    }
    if (!safeName(row.provider) || !safeName(row.model) || !safeName(row.profile)) {
      throw new Error("delegation authorization selection fields are invalid");
    }
    if (!Array.isArray(row.tools) || !row.tools.every(safeName) || new Set(row.tools).size !== row.tools.length) {
      throw new Error("delegation authorization tools must be unique names");
    }
    if (row.allows_mutation !== true && row.allows_mutation !== false) throw new Error("allows_mutation must be boolean");
    for (const value of [row.remaining_depth, row.max_descendant_runs, row.max_concurrent_leaves, row.deadline_ms]) {
      if (!finiteNonNegativeInteger(value)) throw new Error("delegation authorization numeric field is invalid");
    }
    if (!Array.isArray(row.constraint_kinds) || !row.constraint_kinds.every(safeName)) {
      throw new Error("constraint_kinds must contain names only");
    }
    if (!validBudget(row.budget_before) || !validBudget(row.budget_after)) {
      throw new Error("delegation authorization budgets are invalid");
    }
    const before = row.budget_before;
    const after = row.budget_after;
    if (
      after.accepted_runs !== before.accepted_runs + 1 ||
      after.active_executions !== before.active_executions + 1 ||
      after.open_sessions !== before.open_sessions + 1 ||
      after.max_accepted_runs !== before.max_accepted_runs ||
      after.max_active_executions !== before.max_active_executions ||
      after.max_open_sessions !== before.max_open_sessions
    ) {
      throw new Error("delegation authorization budget transition must reserve exactly one run/session/execution");
    }
    return;
  }

  if (event.row_kind === "delegation_denial") {
    const actual = Object.keys(event);
    const missing = [...DENIAL_REQUIRED_KEYS].filter((key) => !(key in event));
    const extra = actual.filter((key) => !DENIAL_REQUIRED_KEYS.has(key) && !DENIAL_OPTIONAL_KEYS.has(key));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`delegation_denial fields differ: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
    }
    const row = event as DelegationDenialAuditEvent;
    if (row.operation !== "delegation_authorize" || row.decision !== "deny" || !safeReasonCode(row.reason_code)) {
      throw new Error("delegation denial event is invalid");
    }
    for (const value of [row.provider, row.model, row.profile]) {
      if (value !== undefined && !safeName(value)) throw new Error("delegation denial selection field is invalid");
    }
    return;
  }

  if (event.row_kind === "delegation_lifecycle") {
    assertExactKeys(event, LIFECYCLE_KEYS, event.row_kind);
    const row = event as DelegationLifecycleAuditEvent;
    assertCapability(row as unknown as Record<string, unknown>);
    if (
      row.operation !== "delegation_lifecycle" ||
      !["completed", "failed", "cancelled"].includes(row.terminal_kind) ||
      !["settled", "delegation_error", "abort", "revoked", "shutdown", "deadline", "drained"].includes(row.terminal_source) ||
      !safeReasonCode(row.reason_code)
    ) {
      throw new Error("delegation lifecycle event is invalid");
    }
    return;
  }
  throw new Error("unknown delegation audit row_kind");
}

export function assertDelegationAuditEvent(event: DelegationAuditEvent | Record<string, unknown>): void {
  const privacy = validateDelegationAuditPrivacy(event);
  if (!privacy.ok) throw new Error(`delegation audit privacy validation failed: ${privacy.issues.join("; ")}`);
  assertClosedSchema(event);
}

export function toDelegationAuditBudget(value: {
  acceptedRuns: number;
  activeExecutions: number;
  openSessions: number;
  maxAcceptedRuns: number;
  maxActiveExecutions: number;
  maxOpenSessions: number;
}): DelegationAuditBudget {
  const budget = {
    accepted_runs: value.acceptedRuns,
    active_executions: value.activeExecutions,
    open_sessions: value.openSessions,
    max_accepted_runs: value.maxAcceptedRuns,
    max_active_executions: value.maxActiveExecutions,
    max_open_sessions: value.maxOpenSessions,
  };
  if (!validBudget(budget)) throw new Error("delegation audit budget contains invalid values");
  return budget;
}

export class RequiredDelegationAuditWriter {
  private readonly background = new Set<Promise<DelegationAuditReceipt>>();
  private readonly backgroundErrors: unknown[] = [];

  constructor(
    readonly path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (typeof path !== "string" || path.length === 0) throw new Error("required delegation audit path is required");
  }

  appendAuthorizationBeforeDelegate(event: DelegationAuthorizationAuditEvent): Promise<DelegationAuditReceipt> {
    return this.appendRequired(event);
  }

  appendDenial(event: DelegationDenialAuditEvent): Promise<DelegationAuditReceipt> {
    return this.appendRequired(event);
  }

  appendLifecycle(event: DelegationLifecycleAuditEvent): Promise<DelegationAuditReceipt> {
    return this.appendRequired(event);
  }

  enqueueLifecycle(event: DelegationLifecycleAuditEvent): void {
    let pending: Promise<DelegationAuditReceipt>;
    try {
      pending = this.appendLifecycle(event);
    } catch (error) {
      this.reportBackgroundError(error);
      return;
    }
    this.background.add(pending);
    void pending.then(
      () => { this.background.delete(pending); },
      (error) => {
        this.background.delete(pending);
        this.reportBackgroundError(error);
      },
    );
  }

  reportBackgroundError(error: unknown): void {
    this.backgroundErrors.push(error);
  }

  async flush(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.all([...this.background].map((pending) => pending.then(() => undefined, () => undefined)));
    }
    if (this.backgroundErrors.length > 0) {
      const errors = this.backgroundErrors.splice(0, this.backgroundErrors.length);
      throw new DelegationAuditBackgroundError(Object.freeze(errors));
    }
  }

  async authorizeThenDelegate<T>(
    event: DelegationAuthorizationAuditEvent,
    delegate: () => T | Promise<T>,
  ): Promise<T> {
    await this.appendAuthorizationBeforeDelegate(event);
    return delegate();
  }

  private appendRequired(event: DelegationAuditEvent): Promise<DelegationAuditReceipt> {
    assertDelegationAuditEvent(event);
    const timestamp = this.clock().toISOString();
    const row = { timestamp, pid: process.pid, ...event };
    const privacy = validateDelegationAuditPrivacy(row);
    if (!privacy.ok) throw new Error(`delegation audit row privacy validation failed: ${privacy.issues.join("; ")}`);
    const line = `${JSON.stringify(row)}\n`;
    const chains = auditChains();
    const prior = chains.get(this.path) ?? Promise.resolve();
    let receipt: DelegationAuditReceipt | undefined;
    const next = prior.catch(() => undefined).then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
        constants.O_NOFOLLOW | constants.O_NONBLOCK;
      const handle = await open(this.path, flags, 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("required delegation audit target is not a regular file");
        await handle.chmod(0o600);
        await handle.writeFile(line, { encoding: "utf8" });
        await handle.sync();
        receipt = { path: this.path, bytesSynced: Buffer.byteLength(line, "utf8") };
      } finally {
        await handle.close();
      }
    });
    chains.set(this.path, next);
    return next.then(() => receipt!).finally(() => {
      if (chains.get(this.path) === next) chains.delete(this.path);
    });
  }
}
