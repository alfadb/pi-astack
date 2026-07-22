/**
 * Offline amplifying delegation broker composition.
 *
 * This broker authorizes one tree node and issues one opaque child capability.
 * Provider concurrency is deliberately absent: a future runtime adapter must
 * acquire leases around actual provider requests, not around session lifetime.
 */

import {
  attenuateDelegationCapabilityForBroker,
  inspectDelegationCapabilityForBroker,
  resolveDelegationCapabilityForBroker,
  revokeDelegationCapabilityForBroker,
  type DelegationAttenuation,
  type DelegationCapabilityBrokerInspection,
  type DelegationCapabilityGrant,
  type DelegationCapabilityHandle,
  type DelegationConstraint,
  type DelegationToolDescriptor,
} from "./delegation-capability";
import {
  DELEGATION_AUDIT_VERSION,
  RequiredDelegationAuditWriter,
  toDelegationAuditBudget,
  type DelegationAuthorizationAuditEvent,
  type DelegationDenialAuditEvent,
  type DelegationExecutionMode,
  type DelegationLifecycleAuditEvent,
} from "./delegation-audit";
import {
  TreeGovernor,
  type TreeAuthorizationReservation,
  type TreeTerminalState,
} from "./tree-governor";

export interface DelegationConstraintContext {
  provider: string;
  model: string;
  profile: string;
  tools: readonly string[];
  allowsMutation: boolean;
  deadlineMs: number;
  remainingDepth: number;
  maxDescendantRuns: number;
  maxConcurrentLeaves: number;
}

export type DelegationConstraintEnforcer = (
  constraints: readonly DelegationConstraint[],
  context: DelegationConstraintContext,
) => void | Promise<void>;

export interface DelegationBrokerDependencies {
  governor: TreeGovernor;
  executionMode: DelegationExecutionMode;
  audit:
    | { mode: "off" }
    | { mode: "required"; writer: RequiredDelegationAuditWriter };
  constraintEnforcer?: DelegationConstraintEnforcer;
  clock?: () => number;
}

export interface DelegationDelegateInput {
  capability: DelegationCapabilityHandle;
  grant: DelegationCapabilityGrant;
  reservation: TreeAuthorizationReservation;
}

export interface DelegationDelegateResult<T> {
  value: T;
  abort?: (terminal: TreeTerminalState) => void;
}

export interface DelegationBrokerRequest<T> {
  parentCapability: DelegationCapabilityHandle;
  attenuation: DelegationAttenuation;
  registry: readonly DelegationToolDescriptor[];
  provider: string;
  model: string;
  profile: string;
  parentNodeRef?: string;
  signal?: AbortSignal;
  delegate: (input: DelegationDelegateInput) => DelegationDelegateResult<T>;
}

export interface DelegationBrokerResult<T> {
  nodeRef: string;
  capability: DelegationCapabilityHandle;
  grant: DelegationCapabilityGrant;
  value: T;
}

export type DelegationBrokerErrorCode =
  | "capability_binding_mismatch"
  | "provider_model_mismatch"
  | "model_not_authorized"
  | "profile_not_authorized"
  | "constraint_enforcer_required"
  | "invalid_delegation_result";

export class DelegationBrokerError extends Error {
  constructor(readonly code: DelegationBrokerErrorCode, message: string) {
    super(message);
    this.name = "DelegationBrokerError";
  }
}

interface CapabilityAuditIdentity {
  capabilityId: string;
  capabilityVersion: number;
  revocationGeneration: number;
}

interface DenialContext {
  requestRef: string;
  parentRef: string;
  requestedDepth: number;
  reservation?: TreeAuthorizationReservation;
}

interface RequestSequenceState {
  next: number;
}

const REQUEST_SEQUENCE_KEY = Symbol.for("pi-astack/dispatch/delegation-broker-request-sequence/v1");
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const REASON_SEMANTIC_FIELD = /prompt|task|reasoning|secret|credential|password|chainofthought/;

function requestSequenceState(): RequestSequenceState {
  const root = globalThis as Record<symbol, unknown>;
  let state = root[REQUEST_SEQUENCE_KEY] as RequestSequenceState | undefined;
  if (!state || typeof state.next !== "number") {
    state = { next: 1 };
    root[REQUEST_SEQUENCE_KEY] = state;
  }
  return state;
}

function nextRequestRef(rootRef: string): string {
  return `${rootRef}.request.${requestSequenceState().next++}`;
}

function childAuditIdentity(nodeRef: string): CapabilityAuditIdentity {
  return {
    capabilityId: `${nodeRef}.cap`,
    capabilityVersion: 1,
    revocationGeneration: 0,
  };
}

function assertCapabilityBinding(
  inspection: DelegationCapabilityBrokerInspection,
  governor: TreeGovernor,
  requestedParentRef: string,
): void {
  if (inspection.rootRef !== governor.config.rootRef || inspection.holderNodeRef !== requestedParentRef) {
    throw new DelegationBrokerError(
      "capability_binding_mismatch",
      "delegation capability is not bound to this governor and exact parent node",
    );
  }
}

function assertSelection(
  grant: DelegationCapabilityGrant,
  provider: string,
  model: string,
  profile: string,
): void {
  const modelProvider = model.split("/")[0];
  if (!modelProvider || modelProvider !== provider) {
    throw new DelegationBrokerError(
      "provider_model_mismatch",
      `provider ${provider} does not own model ${model}`,
    );
  }
  if (!grant.models.includes(model)) {
    throw new DelegationBrokerError("model_not_authorized", `model ${model} is not authorized`);
  }
  if (!grant.profiles.includes(profile)) {
    throw new DelegationBrokerError("profile_not_authorized", `profile ${profile} is not authorized`);
  }
}

function authorizationEvent(
  executionMode: DelegationExecutionMode,
  requestRef: string,
  reservation: TreeAuthorizationReservation,
  provider: string,
  model: string,
  profile: string,
  grant: DelegationCapabilityGrant,
): DelegationAuthorizationAuditEvent {
  const identity = childAuditIdentity(reservation.nodeRef);
  return {
    audit_version: DELEGATION_AUDIT_VERSION,
    execution_mode: executionMode,
    row_kind: "delegation_authorization",
    operation: "delegation_authorize",
    decision: "allow",
    phase: "authorized_pre_delegate",
    request_ref: requestRef,
    root_lineage_ref: reservation.rootRef,
    lineage_ref: reservation.nodeRef,
    parent_lineage_ref: reservation.parentRef,
    node_depth: reservation.nodeDepth,
    provider,
    model,
    profile,
    tools: grant.tools,
    allows_mutation: grant.allowsMutation,
    capability_id: identity.capabilityId,
    capability_version: identity.capabilityVersion,
    revocation_generation: identity.revocationGeneration,
    remaining_depth: grant.maxDepth,
    max_descendant_runs: grant.maxDescendantRuns,
    max_concurrent_leaves: grant.maxConcurrentLeaves,
    deadline_ms: grant.deadlineMs,
    constraint_kinds: [...new Set(grant.constraints.map((constraint) => constraint.kind))].sort(),
    budget_before: toDelegationAuditBudget(reservation.budgetBefore),
    budget_after: toDelegationAuditBudget(reservation.budgetAfter),
  };
}

function safeOptionalName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\0]/.test(value)
    ? value
    : undefined;
}

function safeReasonCode(value: unknown, fallback: string): string {
  const raw = String(value ?? "");
  return REASON_CODE.test(raw) && !REASON_SEMANTIC_FIELD.test(raw) ? raw : fallback;
}

function safeAuditRef(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    !UUID_LIKE.test(value);
}

function reasonCode(error: unknown): string {
  const raw = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return safeReasonCode(raw, "authorization_failed");
}

function denialEvent(
  executionMode: DelegationExecutionMode,
  rootRef: string,
  context: DenialContext,
  error: unknown,
  selection: { provider: string; model: string; profile: string },
): DelegationDenialAuditEvent {
  const reservation = context.reservation;
  const requestRef = safeAuditRef(context.requestRef) ? context.requestRef : "delegation.request.fallback";
  const provider = safeOptionalName(selection.provider);
  const model = safeOptionalName(selection.model);
  const profile = safeOptionalName(selection.profile);
  return {
    audit_version: DELEGATION_AUDIT_VERSION,
    execution_mode: executionMode,
    row_kind: "delegation_denial",
    operation: "delegation_authorize",
    decision: "deny",
    request_ref: requestRef,
    root_lineage_ref: safeAuditRef(rootRef) ? rootRef : requestRef,
    lineage_ref: safeAuditRef(reservation?.nodeRef) ? reservation.nodeRef : requestRef,
    parent_lineage_ref: safeAuditRef(reservation?.parentRef ?? context.parentRef)
      ? (reservation?.parentRef ?? context.parentRef)
      : requestRef,
    node_depth: reservation?.nodeDepth ?? context.requestedDepth,
    reason_code: reasonCode(error),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(profile ? { profile } : {}),
  };
}

function lifecycleEvent(
  executionMode: DelegationExecutionMode,
  requestRef: string,
  reservation: TreeAuthorizationReservation,
  terminal: TreeTerminalState,
): DelegationLifecycleAuditEvent {
  const identity = childAuditIdentity(reservation.nodeRef);
  return {
    audit_version: DELEGATION_AUDIT_VERSION,
    execution_mode: executionMode,
    row_kind: "delegation_lifecycle",
    operation: "delegation_lifecycle",
    request_ref: requestRef,
    root_lineage_ref: reservation.rootRef,
    lineage_ref: reservation.nodeRef,
    parent_lineage_ref: reservation.parentRef,
    node_depth: reservation.nodeDepth,
    capability_id: identity.capabilityId,
    capability_version: identity.capabilityVersion,
    revocation_generation: identity.revocationGeneration,
    terminal_kind: terminal.kind,
    terminal_source: terminal.source,
    reason_code: safeReasonCode(terminal.reasonCode, "terminal_reason_invalid"),
  };
}

function prospectiveDepth(governor: TreeGovernor, parentRef: string): number {
  if (parentRef === governor.config.rootRef) return 1;
  return (governor.snapshot().nodes.find((node) => node.nodeRef === parentRef)?.nodeDepth ?? 0) + 1;
}

export class DelegationBroker {
  private readonly clock: () => number;

  constructor(private readonly dependencies: DelegationBrokerDependencies) {
    this.clock = dependencies.clock ?? Date.now;
    if (dependencies.audit.mode === "required" && !dependencies.audit.writer) {
      throw new Error("required delegation audit mode needs a writer");
    }
  }

  async authorizeAndDelegate<T>(request: DelegationBrokerRequest<T>): Promise<DelegationBrokerResult<T>> {
    const governor = this.dependencies.governor;
    const parentRef = request.parentNodeRef ?? governor.config.rootRef;
    const denialContext: DenialContext = {
      requestRef: nextRequestRef(governor.config.rootRef),
      parentRef,
      requestedDepth: prospectiveDepth(governor, parentRef),
    };
    let delegationEntered = false;
    let childHandle: DelegationCapabilityHandle | undefined;
    let delegated: DelegationDelegateResult<T> | undefined;
    let lifecycleClosed = false;

    const closeLifecycleQueued = (
      reservation: TreeAuthorizationReservation,
      terminal: TreeTerminalState,
    ): void => {
      if (lifecycleClosed) return;
      lifecycleClosed = true;
      if (childHandle) {
        try { revokeDelegationCapabilityForBroker(childHandle); } catch { /* Identity was never issued or already invalid. */ }
      }
      if (["abort", "revoked", "shutdown", "deadline"].includes(terminal.source)) {
        try { delegated?.abort?.(terminal); } catch { /* Abort hooks cannot rewrite terminal state. */ }
      }
      if (this.dependencies.audit.mode === "required") {
        this.dependencies.audit.writer.enqueueLifecycle(
          lifecycleEvent(this.dependencies.executionMode, denialContext.requestRef, reservation, terminal),
        );
      }
    };

    try {
      let parentInspection = inspectDelegationCapabilityForBroker(request.parentCapability);
      assertCapabilityBinding(parentInspection, governor, parentRef);
      let committedGrant = resolveDelegationCapabilityForBroker(
        request.parentCapability,
        request.attenuation,
        request.registry,
        this.clock(),
      );
      assertSelection(committedGrant, request.provider, request.model, request.profile);
      if (committedGrant.constraints.length > 0 && !this.dependencies.constraintEnforcer) {
        throw new DelegationBrokerError(
          "constraint_enforcer_required",
          "typed delegation constraints require an amplifying-broker enforcer",
        );
      }

      const result = await governor.authorizeAndDelegate({
        ...(request.parentNodeRef ? { parentNodeRef: request.parentNodeRef } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        beforeDelegate: async (reservation) => {
          denialContext.reservation = reservation;
          parentInspection = inspectDelegationCapabilityForBroker(request.parentCapability);
          assertCapabilityBinding(parentInspection, governor, reservation.parentRef);
          committedGrant = resolveDelegationCapabilityForBroker(
            request.parentCapability,
            request.attenuation,
            request.registry,
            this.clock(),
          );
          assertSelection(committedGrant, request.provider, request.model, request.profile);
          await this.dependencies.constraintEnforcer?.(committedGrant.constraints, {
            provider: request.provider,
            model: request.model,
            profile: request.profile,
            tools: committedGrant.tools,
            allowsMutation: committedGrant.allowsMutation,
            deadlineMs: committedGrant.deadlineMs,
            remainingDepth: committedGrant.maxDepth,
            maxDescendantRuns: committedGrant.maxDescendantRuns,
            maxConcurrentLeaves: committedGrant.maxConcurrentLeaves,
          });
          if (this.dependencies.audit.mode === "required") {
            await this.dependencies.audit.writer.appendAuthorizationBeforeDelegate(
              authorizationEvent(
                this.dependencies.executionMode,
                denialContext.requestRef,
                reservation,
                request.provider,
                request.model,
                request.profile,
                committedGrant,
              ),
            );
          }
          parentInspection = inspectDelegationCapabilityForBroker(request.parentCapability);
          assertCapabilityBinding(parentInspection, governor, reservation.parentRef);
          committedGrant = resolveDelegationCapabilityForBroker(
            request.parentCapability,
            request.attenuation,
            request.registry,
            this.clock(),
          );
          assertSelection(committedGrant, request.provider, request.model, request.profile);
        },
        beforeCommit: (reservation) => {
          const child = attenuateDelegationCapabilityForBroker(
            request.parentCapability,
            request.attenuation,
            request.registry,
            this.clock(),
            {
              rootRef: reservation.rootRef,
              holderNodeRef: reservation.nodeRef,
              parentNodeRef: reservation.parentRef,
              nodeDepth: reservation.nodeDepth,
            },
          );
          childHandle = child.handle;
          committedGrant = child.grant;
        },
        delegate: (reservation) => {
          delegationEntered = true;
          if (!childHandle) {
            throw new DelegationBrokerError("invalid_delegation_result", "capability reservation was not committed");
          }
          delegated = request.delegate({
            capability: childHandle,
            grant: committedGrant,
            reservation,
          });
          if (!delegated || typeof delegated !== "object" || !("value" in delegated)) {
            throw new DelegationBrokerError("invalid_delegation_result", "delegate must return DelegationDelegateResult");
          }
          return {
            value: {
              nodeRef: reservation.nodeRef,
              capability: childHandle,
              grant: committedGrant,
              value: delegated.value,
            },
            onTerminal: (terminal) => closeLifecycleQueued(reservation, terminal),
          };
        },
      });
      return result.value;
    } catch (error) {
      if (delegationEntered && denialContext.reservation) {
        const reservation = denialContext.reservation;
        const terminal = governor.snapshot().nodes.find((node) => node.nodeRef === reservation.nodeRef)?.terminal;
        if (!lifecycleClosed) {
          lifecycleClosed = true;
          if (childHandle) {
            try { revokeDelegationCapabilityForBroker(childHandle); } catch { /* Child identity may not have been issued. */ }
          }
          if (terminal && this.dependencies.audit.mode === "required") {
            this.dependencies.audit.writer.enqueueLifecycle(
              lifecycleEvent(this.dependencies.executionMode, denialContext.requestRef, reservation, terminal),
            );
          }
        }
      } else if (this.dependencies.audit.mode === "required") {
        try {
          await this.dependencies.audit.writer.appendDenial(denialEvent(
            this.dependencies.executionMode,
            governor.config.rootRef,
            denialContext,
            error,
            { provider: request.provider, model: request.model, profile: request.profile },
          ));
        } catch (auditError) {
          this.dependencies.audit.writer.reportBackgroundError(auditError);
        }
      }
      throw error;
    }
  }
}
