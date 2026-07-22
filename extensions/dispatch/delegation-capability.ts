/**
 * Opaque, in-process delegation capabilities for a future nested-dispatch broker.
 *
 * Handles are unforgeable by object shape: validity is an object-identity lookup
 * in a process-global WeakMap. Lineage bindings and revocation cells are
 * broker-only records and must never be serialized or exposed to an LLM.
 */

import { isAbsolute, normalize, relative } from "node:path";

declare const delegationCapabilityBrand: unique symbol;

export interface DelegationCapabilityHandle {
  readonly [delegationCapabilityBrand]: true;
}

export type DelegationConstraint =
  | { kind: "workspace_roots"; roots: readonly string[] }
  | { kind: "tool_schema"; tool: string; schemaId: string }
  | { kind: "max_output_bytes"; bytes: number };

export interface DelegationCapabilitySpec {
  rootRef: string;
  tools: readonly string[];
  models: readonly string[];
  profiles: readonly string[];
  deadlineMs: number;
  maxDepth: number;
  maxDescendantRuns: number;
  maxConcurrentLeaves: number;
  allowsMutation: boolean;
  constraints?: readonly DelegationConstraint[];
}

export interface DelegationAttenuation {
  tools?: readonly string[];
  models?: readonly string[];
  profiles?: readonly string[];
  deadlineMs?: number;
  maxDepth?: number;
  maxDescendantRuns?: number;
  maxConcurrentLeaves?: number;
  allowsMutation?: boolean;
  additionalConstraints?: readonly DelegationConstraint[];
}

export interface DelegationToolDescriptor {
  name: string;
  mutation: "none" | "host";
}

/** Authority only. Lineage bindings and capability identity are deliberately absent. */
export interface DelegationCapabilityGrant {
  tools: readonly string[];
  models: readonly string[];
  profiles: readonly string[];
  deadlineMs: number;
  maxDepth: number;
  maxDescendantRuns: number;
  maxConcurrentLeaves: number;
  allowsMutation: boolean;
  constraints: readonly DelegationConstraint[];
}

export interface DelegationCapabilityChildBinding {
  rootRef: string;
  holderNodeRef: string;
  parentNodeRef: string;
  nodeDepth: number;
}

/** Trusted broker inspection only. Never place this object in a model-visible payload. */
export interface DelegationCapabilityBrokerInspection {
  rootRef: string;
  holderNodeRef: string;
  parentNodeRef: string;
  nodeDepth: number;
  capabilityId: string;
  capabilityVersion: number;
  revocationGeneration: number;
}

/** Dynamic branch state. This contains counters only, never authority identity. */
export interface DelegationCapabilityBudgetSnapshot {
  remainingDescendantRuns: number;
  activeDescendantLeaves: number;
  maxDescendantRuns: number;
  maxConcurrentLeaves: number;
}

export type DelegationCapabilityErrorCode =
  | "invalid_capability"
  | "revoked_capability"
  | "expired_capability"
  | "invalid_spec"
  | "depth_exhausted"
  | "descendant_runs_exhausted"
  | "concurrent_leaves_exhausted"
  | "capability_escalation"
  | "capability_lineage_mismatch"
  | "tool_unavailable"
  | "mutation_not_authorized";

export class DelegationCapabilityError extends Error {
  constructor(readonly code: DelegationCapabilityErrorCode, message: string) {
    super(message);
    this.name = "DelegationCapabilityError";
  }
}

interface RevocationCell {
  generation: number;
  revoked: boolean;
}

interface RevocationLink {
  cell: RevocationCell;
  issuedGeneration: number;
}

interface BranchAccountingNode {
  parent?: BranchAccountingNode;
  children: Set<BranchAccountingNode>;
  open: boolean;
  consumedDescendantRuns: number;
  maxDescendantRuns: number;
  maxConcurrentLeaves: number;
}

interface CapabilityRecord extends DelegationCapabilityGrant, DelegationCapabilityBrokerInspection {
  ownRevocation: RevocationCell;
  revocationChain: readonly RevocationLink[];
  branchNode: BranchAccountingNode;
}

interface CapabilitySharedState {
  records: WeakMap<object, CapabilityRecord>;
}

const CAPABILITY_STATE_KEY = Symbol.for("pi-astack/dispatch/delegation-capability/v2");
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function sharedState(): CapabilitySharedState {
  const root = globalThis as Record<symbol, unknown>;
  let state = root[CAPABILITY_STATE_KEY] as CapabilitySharedState | undefined;
  if (!state || !(state.records instanceof WeakMap)) {
    state = { records: new WeakMap<object, CapabilityRecord>() };
    root[CAPABILITY_STATE_KEY] = state;
  }
  return state;
}

function fail(code: DelegationCapabilityErrorCode, message: string): never {
  throw new DelegationCapabilityError(code, message);
}

function finiteNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    return fail("invalid_spec", `${field} must be a finite non-negative integer`);
  }
  return value;
}

function auditSafeRef(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 96 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
    UUID_LIKE.test(value)
  ) {
    return fail("invalid_spec", `${field} must be a short audit-safe reference`);
  }
  return value;
}

function validateName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\s\0]/.test(value)) {
    return fail("invalid_spec", `${field} entries must be non-empty names without whitespace`);
  }
  return value;
}

function strictBoolean(value: unknown, field: string): boolean {
  if (value !== true && value !== false) return fail("invalid_spec", `${field} must be boolean`);
  return value;
}

function normalizedNames(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values)) return fail("invalid_spec", `${field} must be an array`);
  const names = values.map((value) => validateName(value, field));
  if (new Set(names).size !== names.length) return fail("invalid_spec", `${field} must not contain duplicates`);
  return Object.freeze([...names].sort());
}

function normalizedConstraint(constraint: DelegationConstraint): DelegationConstraint {
  if (!constraint || typeof constraint !== "object") return fail("invalid_spec", "constraint must be an object");
  if (constraint.kind === "workspace_roots") {
    if (!Array.isArray(constraint.roots) || constraint.roots.length === 0) {
      return fail("invalid_spec", "workspace_roots requires at least one root");
    }
    const roots = constraint.roots.map((root) => {
      if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) {
        return fail("invalid_spec", "workspace_roots entries must be absolute paths");
      }
      return normalize(root);
    });
    return Object.freeze({ kind: "workspace_roots", roots: Object.freeze([...new Set(roots)].sort()) });
  }
  if (constraint.kind === "tool_schema") {
    return Object.freeze({
      kind: "tool_schema",
      tool: validateName(constraint.tool, "tool_schema.tool"),
      schemaId: validateName(constraint.schemaId, "tool_schema.schemaId"),
    });
  }
  if (constraint.kind === "max_output_bytes") {
    return Object.freeze({
      kind: "max_output_bytes",
      bytes: finiteNonNegativeInteger(constraint.bytes, "max_output_bytes.bytes"),
    });
  }
  return fail("invalid_spec", "unknown delegation constraint kind");
}

function constraintKey(constraint: DelegationConstraint): string {
  if (constraint.kind === "workspace_roots") return constraint.kind;
  if (constraint.kind === "tool_schema") return `${constraint.kind}:${constraint.tool}`;
  return constraint.kind;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizedConstraints(values: readonly DelegationConstraint[] | undefined): readonly DelegationConstraint[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) return fail("invalid_spec", "constraints must be an array");
  const byKey = new Map<string, DelegationConstraint>();
  for (const raw of values) {
    const constraint = normalizedConstraint(raw);
    const key = constraintKey(constraint);
    const existing = byKey.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(constraint)) {
      return fail("invalid_spec", `constraints contain conflicting ${key} entries`);
    }
    byKey.set(key, constraint);
  }
  return Object.freeze([...byKey.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, value]) => value));
}

function pathIsWithin(parentRoot: string, childRoot: string): boolean {
  const displacement = relative(parentRoot, childRoot);
  return displacement === "" || (!displacement.startsWith("..") && !isAbsolute(displacement));
}

function narrowedConstraints(
  parentConstraints: readonly DelegationConstraint[],
  additionalConstraints: readonly DelegationConstraint[] | undefined,
): readonly DelegationConstraint[] {
  const childConstraints = normalizedConstraints(additionalConstraints);
  const result = new Map(parentConstraints.map((constraint) => [constraintKey(constraint), constraint]));

  for (const child of childConstraints) {
    const key = constraintKey(child);
    const parent = result.get(key);
    if (child.kind === "workspace_roots" && parent?.kind === "workspace_roots") {
      const outside = child.roots.filter((root) => !parent.roots.some((parentRoot) => pathIsWithin(parentRoot, root)));
      if (outside.length > 0) {
        return fail("capability_escalation", `workspace_roots attempted to escape parent roots: ${outside.join(", ")}`);
      }
      result.set(key, child);
      continue;
    }
    if (child.kind === "max_output_bytes" && parent?.kind === "max_output_bytes") {
      if (child.bytes > parent.bytes) {
        return fail("capability_escalation", "max_output_bytes cannot exceed the parent limit");
      }
      result.set(key, child);
      continue;
    }
    if (child.kind === "tool_schema" && parent?.kind === "tool_schema") {
      if (child.schemaId !== parent.schemaId) {
        return fail("capability_escalation", `tool_schema for ${child.tool} cannot replace the parent schemaId`);
      }
      continue;
    }
    result.set(key, child);
  }

  return Object.freeze([...result.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, value]) => value));
}

function normalizeSpec(spec: DelegationCapabilitySpec): {
  rootRef: string;
  grant: DelegationCapabilityGrant;
} {
  if (!spec || typeof spec !== "object") return fail("invalid_spec", "capability spec must be an object");
  const rootRef = auditSafeRef(spec.rootRef, "rootRef");
  if (rootRef.length > 64) return fail("invalid_spec", "rootRef must be at most 64 characters");
  const grant = Object.freeze({
    tools: normalizedNames(spec.tools, "tools"),
    models: normalizedNames(spec.models, "models"),
    profiles: normalizedNames(spec.profiles, "profiles"),
    deadlineMs: finiteNonNegativeInteger(spec.deadlineMs, "deadlineMs"),
    maxDepth: finiteNonNegativeInteger(spec.maxDepth, "maxDepth"),
    maxDescendantRuns: finiteNonNegativeInteger(spec.maxDescendantRuns, "maxDescendantRuns"),
    maxConcurrentLeaves: finiteNonNegativeInteger(spec.maxConcurrentLeaves, "maxConcurrentLeaves"),
    allowsMutation: strictBoolean(spec.allowsMutation, "allowsMutation"),
    constraints: normalizedConstraints(spec.constraints),
  });
  return { rootRef, grant };
}

function createHandle(record: CapabilityRecord): DelegationCapabilityHandle {
  const handle = Object.freeze(Object.create(null)) as DelegationCapabilityHandle;
  sharedState().records.set(handle as object, Object.freeze(record));
  return handle;
}

function issuedRecordFor(handle: DelegationCapabilityHandle): CapabilityRecord {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    return fail("invalid_capability", "delegation capability handle is not an object identity");
  }
  const record = sharedState().records.get(handle as object);
  if (!record) return fail("invalid_capability", "delegation capability handle was not issued by this process");
  return record;
}

function recordFor(handle: DelegationCapabilityHandle): CapabilityRecord {
  const record = issuedRecordFor(handle);
  for (const link of record.revocationChain) {
    if (link.cell.revoked || link.cell.generation !== link.issuedGeneration) {
      return fail("revoked_capability", "delegation capability or an ancestor has been revoked");
    }
  }
  return record;
}

function inspectionFrom(record: CapabilityRecord): DelegationCapabilityBrokerInspection {
  return Object.freeze({
    rootRef: record.rootRef,
    holderNodeRef: record.holderNodeRef,
    parentNodeRef: record.parentNodeRef,
    nodeDepth: record.nodeDepth,
    capabilityId: record.capabilityId,
    capabilityVersion: record.capabilityVersion,
    revocationGeneration: record.revocationGeneration,
  });
}

function assertSubset(child: readonly string[], parent: readonly string[], field: string): void {
  const allowed = new Set(parent);
  const extras = child.filter((value) => !allowed.has(value));
  if (extras.length > 0) {
    fail("capability_escalation", `${field} attempted to add unauthorized values: ${extras.join(", ")}`);
  }
}

function accountingLineage(node: BranchAccountingNode): BranchAccountingNode[] {
  const lineage: BranchAccountingNode[] = [];
  let current: BranchAccountingNode | undefined = node;
  while (current) {
    lineage.push(current);
    current = current.parent;
  }
  return lineage;
}

function remainingDescendantRuns(node: BranchAccountingNode): number {
  return Math.min(...accountingLineage(node).map(
    (entry) => Math.max(0, entry.maxDescendantRuns - entry.consumedDescendantRuns),
  ));
}

function activeDescendantLeaves(node: BranchAccountingNode): number {
  let leaves = 0;
  for (const child of node.children) {
    if (!child.open) continue;
    const below = activeDescendantLeaves(child);
    leaves += below === 0 ? 1 : below;
  }
  return leaves;
}

function closeBranchSubtree(node: BranchAccountingNode): void {
  if (!node.open) return;
  node.open = false;
  for (const child of node.children) closeBranchSubtree(child);
}

function reserveChildBranch(
  parent: BranchAccountingNode,
  grant: DelegationCapabilityGrant,
): BranchAccountingNode {
  const lineage = accountingLineage(parent);
  if (lineage.some((entry) => entry.consumedDescendantRuns >= entry.maxDescendantRuns)) {
    return fail("descendant_runs_exhausted", "an ancestor descendant-run budget is exhausted");
  }

  const child: BranchAccountingNode = {
    parent,
    children: new Set<BranchAccountingNode>(),
    open: true,
    consumedDescendantRuns: 0,
    maxDescendantRuns: grant.maxDescendantRuns,
    maxConcurrentLeaves: grant.maxConcurrentLeaves,
  };
  parent.children.add(child);
  try {
    for (const entry of lineage) {
      if (activeDescendantLeaves(entry) > entry.maxConcurrentLeaves) {
        return fail("concurrent_leaves_exhausted", "an ancestor concurrent-leaf budget is exhausted");
      }
    }
  } catch (error) {
    parent.children.delete(child);
    throw error;
  }
  for (const entry of lineage) entry.consumedDescendantRuns++;
  return child;
}

function attenuationGrant(parent: CapabilityRecord, attenuation: DelegationAttenuation): DelegationCapabilityGrant {
  if (parent.maxDepth === 0) return fail("depth_exhausted", "delegation capability has no remaining depth");
  const dynamicRemainingRuns = remainingDescendantRuns(parent.branchNode);
  if (dynamicRemainingRuns === 0) {
    return fail("descendant_runs_exhausted", "delegation capability has no descendant-run budget remaining");
  }
  if (parent.maxConcurrentLeaves === 0) {
    return fail("concurrent_leaves_exhausted", "delegation capability allows no concurrent descendant leaves");
  }
  const tools = attenuation.tools === undefined ? parent.tools : normalizedNames(attenuation.tools, "tools");
  const models = attenuation.models === undefined ? parent.models : normalizedNames(attenuation.models, "models");
  const profiles = attenuation.profiles === undefined ? parent.profiles : normalizedNames(attenuation.profiles, "profiles");
  assertSubset(tools, parent.tools, "tools");
  assertSubset(models, parent.models, "models");
  assertSubset(profiles, parent.profiles, "profiles");

  const deadlineMs = attenuation.deadlineMs === undefined
    ? parent.deadlineMs
    : finiteNonNegativeInteger(attenuation.deadlineMs, "deadlineMs");
  if (deadlineMs > parent.deadlineMs) return fail("capability_escalation", "child deadline cannot exceed parent deadline");

  const depthCeiling = parent.maxDepth - 1;
  const maxDepth = attenuation.maxDepth === undefined
    ? depthCeiling
    : finiteNonNegativeInteger(attenuation.maxDepth, "maxDepth");
  if (maxDepth > depthCeiling) {
    return fail("capability_escalation", "child maxDepth must decay by at least one");
  }

  const staticRunCeiling = parent.maxDescendantRuns - 1;
  const dynamicRunCeiling = dynamicRemainingRuns - 1;
  const runCeiling = Math.min(staticRunCeiling, dynamicRunCeiling);
  const maxDescendantRuns = attenuation.maxDescendantRuns === undefined
    ? runCeiling
    : finiteNonNegativeInteger(attenuation.maxDescendantRuns, "maxDescendantRuns");
  if (maxDescendantRuns > staticRunCeiling) {
    return fail("capability_escalation", "child maxDescendantRuns must decay by at least one");
  }
  if (maxDescendantRuns > dynamicRunCeiling) {
    return fail("descendant_runs_exhausted", "child maxDescendantRuns exceeds the actual ancestor budget remaining");
  }

  const maxConcurrentLeaves = attenuation.maxConcurrentLeaves === undefined
    ? parent.maxConcurrentLeaves
    : finiteNonNegativeInteger(attenuation.maxConcurrentLeaves, "maxConcurrentLeaves");
  if (maxConcurrentLeaves > parent.maxConcurrentLeaves) {
    return fail("capability_escalation", "child maxConcurrentLeaves cannot exceed parent ceiling");
  }

  const allowsMutation = attenuation.allowsMutation === undefined
    ? parent.allowsMutation
    : strictBoolean(attenuation.allowsMutation, "allowsMutation");
  if (allowsMutation && !parent.allowsMutation) return fail("capability_escalation", "child cannot add mutation authority");

  const constraints = narrowedConstraints(parent.constraints, attenuation.additionalConstraints);
  return Object.freeze({
    tools,
    models,
    profiles,
    deadlineMs,
    maxDepth,
    maxDescendantRuns,
    maxConcurrentLeaves,
    allowsMutation,
    constraints,
  });
}

function assertDynamicRegistry(grant: DelegationCapabilityGrant, registry: readonly DelegationToolDescriptor[]): void {
  if (!Array.isArray(registry)) return fail("invalid_spec", "tool registry must be an array");
  const descriptors = new Map<string, DelegationToolDescriptor>();
  for (const raw of registry) {
    if (!raw || typeof raw !== "object") return fail("invalid_spec", "tool descriptor must be an object");
    const name = validateName(raw.name, "tool registry name");
    if (raw.mutation !== "none" && raw.mutation !== "host") {
      return fail("invalid_spec", `tool ${name} must declare mutation as none or host`);
    }
    if (descriptors.has(name)) return fail("invalid_spec", `tool registry contains duplicate ${name}`);
    descriptors.set(name, { name, mutation: raw.mutation });
  }
  for (const name of grant.tools) {
    const descriptor = descriptors.get(name);
    if (!descriptor) return fail("tool_unavailable", `tool ${name} is not in the current target registry`);
    const hostMutation = descriptor.mutation === "host" || name === "bash" || name === "edit" || name === "write";
    if (hostMutation && !grant.allowsMutation) {
      return fail("mutation_not_authorized", `tool ${name} requires explicit host-mutation authority`);
    }
  }
}

export interface DelegationCapabilityController {
  currentHandle(): DelegationCapabilityHandle;
  revoke(): number;
  renew(): DelegationCapabilityHandle;
  generation(): number;
}

/** Create a root authority already bound to its owning governor root. */
export function createDelegationCapability(spec: DelegationCapabilitySpec): DelegationCapabilityController {
  const normalized = normalizeSpec(spec);
  const rootRevocation: RevocationCell = { generation: 0, revoked: false };
  const branchRoot: BranchAccountingNode = {
    children: new Set<BranchAccountingNode>(),
    open: true,
    consumedDescendantRuns: 0,
    maxDescendantRuns: normalized.grant.maxDescendantRuns,
    maxConcurrentLeaves: normalized.grant.maxConcurrentLeaves,
  };
  const issue = (): DelegationCapabilityHandle => {
    const issuedGeneration = rootRevocation.generation;
    return createHandle({
      ...normalized.grant,
      rootRef: normalized.rootRef,
      holderNodeRef: normalized.rootRef,
      parentNodeRef: normalized.rootRef,
      nodeDepth: 0,
      capabilityId: `${normalized.rootRef}.cap.root`,
      capabilityVersion: issuedGeneration + 1,
      revocationGeneration: issuedGeneration,
      ownRevocation: rootRevocation,
      revocationChain: Object.freeze([{ cell: rootRevocation, issuedGeneration }]),
      branchNode: branchRoot,
    });
  };
  let current = issue();
  return Object.freeze({
    currentHandle: () => current,
    revoke: () => {
      if (!rootRevocation.revoked) {
        rootRevocation.generation++;
        rootRevocation.revoked = true;
        closeBranchSubtree(branchRoot);
      }
      return rootRevocation.generation;
    },
    renew: () => {
      rootRevocation.revoked = false;
      branchRoot.open = true;
      current = issue();
      return current;
    },
    generation: () => rootRevocation.generation,
  });
}

/** Broker-only lineage/identity view. */
export function inspectDelegationCapabilityForBroker(
  handle: DelegationCapabilityHandle,
): DelegationCapabilityBrokerInspection {
  return inspectionFrom(recordFor(handle));
}

/** Broker-only revocation of one node identity; descendants fail through their ancestor chain. */
export function revokeDelegationCapabilityForBroker(handle: DelegationCapabilityHandle): number {
  const record = issuedRecordFor(handle);
  if (!record.ownRevocation.revoked) {
    record.ownRevocation.generation++;
    record.ownRevocation.revoked = true;
    closeBranchSubtree(record.branchNode);
  }
  return record.ownRevocation.generation;
}

/** Broker-only dynamic budget view used for non-sensitive outcomes and audit. */
export function inspectDelegationCapabilityBudgetForBroker(
  handle: DelegationCapabilityHandle,
): DelegationCapabilityBudgetSnapshot {
  const record = recordFor(handle);
  return Object.freeze({
    remainingDescendantRuns: remainingDescendantRuns(record.branchNode),
    activeDescendantLeaves: activeDescendantLeaves(record.branchNode),
    maxDescendantRuns: record.maxDescendantRuns,
    maxConcurrentLeaves: record.maxConcurrentLeaves,
  });
}

/** Resolve authority without exposing its hidden lineage binding. */
export function resolveDelegationCapabilityForBroker(
  handle: DelegationCapabilityHandle,
  attenuation: DelegationAttenuation,
  registry: readonly DelegationToolDescriptor[],
  nowMs: number,
): DelegationCapabilityGrant {
  const parent = recordFor(handle);
  const now = finiteNonNegativeInteger(nowMs, "nowMs");
  if (now >= parent.deadlineMs) return fail("expired_capability", "delegation capability deadline has elapsed");
  const grant = attenuationGrant(parent, attenuation ?? {});
  if (now >= grant.deadlineMs) return fail("expired_capability", "child delegation deadline has elapsed");
  assertDynamicRegistry(grant, registry);
  return grant;
}

/** Create a separately revocable child only after governor authorization succeeds. */
export function attenuateDelegationCapabilityForBroker(
  handle: DelegationCapabilityHandle,
  attenuation: DelegationAttenuation,
  registry: readonly DelegationToolDescriptor[],
  nowMs: number,
  binding: DelegationCapabilityChildBinding,
): { handle: DelegationCapabilityHandle; grant: DelegationCapabilityGrant } {
  const parent = recordFor(handle);
  const rootRef = auditSafeRef(binding?.rootRef, "binding.rootRef");
  const holderNodeRef = auditSafeRef(binding?.holderNodeRef, "binding.holderNodeRef");
  const parentNodeRef = auditSafeRef(binding?.parentNodeRef, "binding.parentNodeRef");
  const nodeDepth = finiteNonNegativeInteger(binding?.nodeDepth, "binding.nodeDepth");
  if (
    rootRef !== parent.rootRef ||
    parentNodeRef !== parent.holderNodeRef ||
    nodeDepth !== parent.nodeDepth + 1
  ) {
    return fail("capability_lineage_mismatch", "child capability binding does not extend its exact parent lineage");
  }
  const capabilityId = auditSafeRef(`${holderNodeRef}.cap`, "capabilityId");
  const grant = resolveDelegationCapabilityForBroker(handle, attenuation, registry, nowMs);
  const ownRevocation: RevocationCell = { generation: 0, revoked: false };
  const revocationChain = Object.freeze([
    ...parent.revocationChain,
    { cell: ownRevocation, issuedGeneration: 0 },
  ]);
  const branchNode = reserveChildBranch(parent.branchNode, grant);
  return {
    handle: createHandle({
      ...grant,
      rootRef,
      holderNodeRef,
      parentNodeRef,
      nodeDepth,
      capabilityId,
      capabilityVersion: 1,
      revocationGeneration: 0,
      ownRevocation,
      revocationChain,
      branchNode,
    }),
    grant,
  };
}
