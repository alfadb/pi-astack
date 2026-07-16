import {
  PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA,
  PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
  PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  type PropositionEvidenceBodyV1,
  type PropositionFacets,
  type PropositionGenesisBodyV1,
  type PropositionLifecycleBodyV1,
  type PropositionLifecycleOperation,
} from "./proposition";
import type { ValidatedL1ScanRecord } from "./l1-schema-registry";

export const PROPOSITION_LIFECYCLE_RESOLVER_SCHEMA = "proposition-lifecycle-effective-state/v1" as const;

export const PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX = deepFreeze({
  retract: {
    target_count: 1,
    state_target_kinds: ["evidence", "rescope", "reactivate"],
    replacement_target_kind: null,
    result: "retracted",
  },
  rescope: {
    target_count: 1,
    state_target_kinds: ["evidence", "rescope", "reactivate"],
    replacement_target_kind: null,
    result: "active",
  },
  supersede: {
    target_count: 2,
    state_target_kinds: ["evidence", "rescope", "reactivate"],
    replacement_target_kind: "evidence",
    result: "superseded",
  },
  archive: {
    target_count: 1,
    state_target_kinds: ["evidence", "rescope", "reactivate"],
    replacement_target_kind: null,
    result: "archived",
  },
  reactivate: {
    target_count: 1,
    state_target_kinds: ["retract", "archive"],
    replacement_target_kind: null,
    result: "active",
  },
} as const);

export type PropositionEffectiveDisposition = "active" | "retracted" | "archived" | "superseded";
export type PropositionScopeResolution = "resolved" | "unresolved";
type EffectiveLifecycleOperation = Exclude<PropositionLifecycleOperation, "cutover">;

export interface PropositionLifecycleLineageEntry {
  event_id: string;
  operation: PropositionLifecycleOperation;
  state_target_event_id: string;
  replacement_event_id: string | null;
}

export interface ResolvedPropositionState {
  source_event_id: string;
  epoch_id: string;
  genesis_event_id: string;
  proposition: PropositionEvidenceBodyV1["proposition"];
  original_facets: PropositionFacets;
  effective_facets: PropositionFacets;
  effective_scope_resolution: PropositionScopeResolution;
  lifecycle_lineage: readonly PropositionLifecycleLineageEntry[];
  lifecycle_event_ids: readonly string[];
  disposition: PropositionEffectiveDisposition;
  activation: "original" | "reactivated";
  terminal_event_id: string;
  superseded_by_event_id: string | null;
}

export interface PropositionLifecycleResolution {
  schema_version: typeof PROPOSITION_LIFECYCLE_RESOLVER_SCHEMA;
  epoch_id: string;
  genesis_event_id: string;
  input_event_ids: readonly string[];
  evidence_event_ids: readonly string[];
  lifecycle_event_ids: readonly string[];
  states: readonly ResolvedPropositionState[];
}

export class PropositionLifecycleResolutionError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionLifecycleResolutionError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

type NodeKind = "genesis" | "evidence" | PropositionLifecycleOperation;

interface ResolverNode {
  eventId: string;
  kind: NodeKind;
  record: ValidatedL1ScanRecord;
  body: PropositionGenesisBodyV1 | PropositionEvidenceBodyV1 | PropositionLifecycleBodyV1;
  epochId: string;
  genesisEventId: string | null;
}

export function resolvePropositionLifecycleEffectiveState(
  records: readonly ValidatedL1ScanRecord[],
  options: {
    expectedEpochId?: string;
    expectedGenesisEventId: string;
  },
): PropositionLifecycleResolution {
  const expectedEpochId = options.expectedEpochId ?? PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID;
  const orderedRecords = [...records].sort((left, right) => compareCodeUnits(left.eventId, right.eventId));
  const nodes = orderedRecords.map(toResolverNode);
  const byId = uniqueNodeMap(nodes);
  const genesisNodes = nodes.filter((node) => node.kind === "genesis");
  if (genesisNodes.length !== 1) {
    fail("PROPOSITION_LIFECYCLE_GENESIS_CARDINALITY", "resolver requires exactly one defined-inactive proposition production genesis", { count: genesisNodes.length });
  }
  const genesis = genesisNodes[0]!;
  assertProductionGenesis(genesis, expectedEpochId, options.expectedGenesisEventId);

  for (const node of nodes) {
    if (node.kind === "genesis") continue;
    if (node.epochId !== expectedEpochId || node.genesisEventId !== options.expectedGenesisEventId) {
      fail("PROPOSITION_LIFECYCLE_CROSS_EPOCH", "proposition event does not bind the fixed production epoch/genesis", {
        eventId: node.eventId,
        epochId: node.epochId,
        genesisEventId: node.genesisEventId,
      });
    }
  }

  const references = new Map<string, readonly string[]>();
  for (const node of nodes) {
    const refs = nodeReferences(node);
    for (const ref of refs) {
      const parent = byId.get(ref);
      if (!parent) {
        fail("PROPOSITION_LIFECYCLE_UNKNOWN_PARENT", "proposition topology references an unknown parent", { eventId: node.eventId, parentEventId: ref });
      }
      if (parent.kind !== "genesis" && parent.epochId !== node.epochId) {
        fail("PROPOSITION_LIFECYCLE_CROSS_EPOCH", "proposition topology crosses epochs", { eventId: node.eventId, parentEventId: ref });
      }
    }
    references.set(node.eventId, refs);
  }
  assertAcyclic(nodes, references);

  const lifecycleNodes = nodes.filter((node): node is ResolverNode & { body: PropositionLifecycleBodyV1; kind: EffectiveLifecycleOperation } => isLifecycleKind(node.kind));
  const evidenceNodes = nodes.filter((node): node is ResolverNode & { body: PropositionEvidenceBodyV1; kind: "evidence" } => node.kind === "evidence");
  const outgoing = new Map<string, ResolverNode & { body: PropositionLifecycleBodyV1; kind: EffectiveLifecycleOperation }>();
  const replacementByLifecycle = new Map<string, string>();

  for (const lifecycle of lifecycleNodes) {
    const matrix = PROPOSITION_LIFECYCLE_OPERATION_TARGET_MATRIX[lifecycle.kind];
    const targets = lifecycle.body.lifecycle.target_event_ids;
    if (targets.length !== matrix.target_count) {
      fail("PROPOSITION_LIFECYCLE_TARGET_MATRIX_INVALID", `${lifecycle.kind} requires exactly ${matrix.target_count} target(s)`, {
        eventId: lifecycle.eventId,
        targets: targets.length,
      });
    }
    const causalParents = lifecycle.body.facets.lineage.causal_parents;
    if (!sameStringSet(targets, causalParents)) {
      fail("PROPOSITION_LIFECYCLE_CAUSAL_MATRIX_INVALID", "lifecycle causal_parents must exactly equal ordered target membership", { eventId: lifecycle.eventId });
    }
    const stateTargetId = targets[0]!;
    const stateTarget = byId.get(stateTargetId)!;
    if (!matrix.state_target_kinds.includes(stateTarget.kind as never)) {
      fail("PROPOSITION_LIFECYCLE_TARGET_MATRIX_INVALID", `${lifecycle.kind} cannot target ${stateTarget.kind}`, {
        eventId: lifecycle.eventId,
        stateTargetEventId: stateTargetId,
        stateTargetKind: stateTarget.kind,
      });
    }
    const prior = outgoing.get(stateTargetId);
    if (prior) {
      fail("PROPOSITION_LIFECYCLE_AMBIGUOUS_STATE", "multiple lifecycle events branch from the same effective-state node", {
        stateTargetEventId: stateTargetId,
        lifecycleEventIds: [prior.eventId, lifecycle.eventId].sort(compareCodeUnits),
      });
    }
    outgoing.set(stateTargetId, lifecycle);

    if (lifecycle.kind === "supersede") {
      const replacementId = targets[1]!;
      const replacement = byId.get(replacementId)!;
      if (replacement.kind !== "evidence") {
        fail("PROPOSITION_LIFECYCLE_TARGET_MATRIX_INVALID", "supersede replacement target must be proposition evidence", {
          eventId: lifecycle.eventId,
          replacementEventId: replacementId,
          replacementKind: replacement.kind,
        });
      }
      replacementByLifecycle.set(lifecycle.eventId, replacementId);
    }
  }

  const claimedLifecycle = new Set<string>();
  const claimedReplacement = new Map<string, string>();
  const supersedeClaims = new Map<string, string>();
  const states: ResolvedPropositionState[] = [];

  for (const evidence of evidenceNodes) {
    let currentId = evidence.eventId;
    let disposition: PropositionEffectiveDisposition = "active";
    let activation: ResolvedPropositionState["activation"] = "original";
    let effectiveFacets = evidence.body.facets;
    let supersededBy: string | null = null;
    const lineage: PropositionLifecycleLineageEntry[] = [];
    const localSeen = new Set<string>([currentId]);

    while (outgoing.has(currentId)) {
      const lifecycle = outgoing.get(currentId)!;
      if (localSeen.has(lifecycle.eventId)) {
        fail("PROPOSITION_LIFECYCLE_CYCLE", "lifecycle state traversal encountered a cycle", { eventId: lifecycle.eventId });
      }
      localSeen.add(lifecycle.eventId);
      if (claimedLifecycle.has(lifecycle.eventId)) {
        fail("PROPOSITION_LIFECYCLE_AMBIGUOUS_STATE", "lifecycle event resolves into more than one proposition lineage", { eventId: lifecycle.eventId });
      }
      claimedLifecycle.add(lifecycle.eventId);
      const replacementId = replacementByLifecycle.get(lifecycle.eventId) ?? null;
      lineage.push(deepFreeze({
        event_id: lifecycle.eventId,
        operation: lifecycle.kind,
        state_target_event_id: currentId,
        replacement_event_id: replacementId,
      }));

      if (lifecycle.kind === "rescope") {
        effectiveFacets = deepFreeze({ ...effectiveFacets, spatial_scope: lifecycle.body.facets.spatial_scope });
        disposition = "active";
      } else if (lifecycle.kind === "retract") {
        disposition = "retracted";
      } else if (lifecycle.kind === "archive") {
        disposition = "archived";
      } else if (lifecycle.kind === "reactivate") {
        disposition = "active";
        activation = "reactivated";
      } else if (lifecycle.kind === "supersede") {
        disposition = "superseded";
        supersededBy = replacementId;
        const priorClaim = claimedReplacement.get(replacementId!);
        if (priorClaim) {
          fail("PROPOSITION_LIFECYCLE_AMBIGUOUS_STATE", "replacement evidence is claimed by multiple supersede lifecycle events", {
            replacementEventId: replacementId,
            lifecycleEventIds: [priorClaim, lifecycle.eventId].sort(compareCodeUnits),
          });
        }
        claimedReplacement.set(replacementId!, lifecycle.eventId);
        supersedeClaims.set(replacementId!, evidence.eventId);
      }
      currentId = lifecycle.eventId;
    }

    states.push(deepFreeze({
      source_event_id: evidence.eventId,
      epoch_id: evidence.epochId,
      genesis_event_id: evidence.genesisEventId!,
      proposition: evidence.body.proposition,
      original_facets: evidence.body.facets,
      effective_facets: effectiveFacets,
      effective_scope_resolution: scopeIsResolved(effectiveFacets.spatial_scope) ? "resolved" : "unresolved",
      lifecycle_lineage: Object.freeze(lineage),
      lifecycle_event_ids: Object.freeze(lineage.map((entry) => entry.event_id)),
      disposition,
      activation,
      terminal_event_id: currentId,
      superseded_by_event_id: supersededBy,
    }));
  }

  if (claimedLifecycle.size !== lifecycleNodes.length) {
    const unclaimed = lifecycleNodes.map((node) => node.eventId).filter((eventId) => !claimedLifecycle.has(eventId)).sort(compareCodeUnits);
    fail("PROPOSITION_LIFECYCLE_AMBIGUOUS_STATE", "lifecycle events are not rooted in exactly one proposition evidence lineage", { unclaimed });
  }

  for (const evidence of evidenceNodes) {
    const declared = [...evidence.body.facets.lineage.supersedes].sort(compareCodeUnits);
    const claimedRoot = supersedeClaims.get(evidence.eventId);
    const expected = claimedRoot ? [claimedRoot] : [];
    if (!sameOrderedStrings(declared, expected)) {
      fail("PROPOSITION_LIFECYCLE_SUPERSEDE_LINEAGE_INVALID", "replacement evidence supersedes lineage must exactly match its lifecycle claim", {
        eventId: evidence.eventId,
        declared,
        expected,
      });
    }
  }

  states.sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  return deepFreeze({
    schema_version: PROPOSITION_LIFECYCLE_RESOLVER_SCHEMA,
    epoch_id: expectedEpochId,
    genesis_event_id: options.expectedGenesisEventId,
    input_event_ids: Object.freeze(nodes.map((node) => node.eventId).sort(compareCodeUnits)),
    evidence_event_ids: Object.freeze(evidenceNodes.map((node) => node.eventId).sort(compareCodeUnits)),
    lifecycle_event_ids: Object.freeze(lifecycleNodes.map((node) => node.eventId).sort(compareCodeUnits)),
    states: Object.freeze(states),
  });
}

function toResolverNode(record: ValidatedL1ScanRecord): ResolverNode {
  if (record.classification !== "defined-inactive-shadow" || record.registration.domain !== "proposition" || record.registration.phase !== "defined_inactive") {
    fail("PROPOSITION_LIFECYCLE_INPUT_CLASS_INVALID", "resolver accepts only whole-L1 defined-inactive proposition records", {
      eventId: record.eventId,
      classification: record.classification,
      domain: record.registration.domain,
      phase: record.registration.phase,
    });
  }
  if (record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA) {
    const body = record.body as unknown as PropositionGenesisBodyV1;
    return { eventId: record.eventId, kind: "genesis", record, body, epochId: body.epoch.epoch_id, genesisEventId: null };
  }
  if (record.registration.envelope_schema === PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA) {
    const body = record.body as unknown as PropositionEvidenceBodyV1;
    return { eventId: record.eventId, kind: "evidence", record, body, epochId: body.epoch.epoch_id, genesisEventId: body.epoch.genesis_event_id };
  }
  if (record.registration.envelope_schema === PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA) {
    const body = record.body as unknown as PropositionLifecycleBodyV1;
    if (body.lifecycle.operation === "cutover") {
      fail("PROPOSITION_LIFECYCLE_TARGET_MATRIX_INVALID", "cutover is a genesis boundary declaration, not a P1a effective-state operation", { eventId: record.eventId });
    }
    return { eventId: record.eventId, kind: body.lifecycle.operation, record, body, epochId: body.epoch.epoch_id, genesisEventId: body.epoch.genesis_event_id };
  }
  fail("PROPOSITION_LIFECYCLE_INPUT_SCHEMA_INVALID", "resolver received an unsupported proposition schema", {
    eventId: record.eventId,
    schema: record.registration.envelope_schema,
  });
}

function assertProductionGenesis(node: ResolverNode, expectedEpochId: string, expectedGenesisEventId: string): void {
  const body = node.body as PropositionGenesisBodyV1;
  if (
    node.eventId !== expectedGenesisEventId
    || body.epoch.epoch_id !== expectedEpochId
    || body.epoch.genesis_scope !== "production"
    || body.contract.kind !== "production_genesis"
    || body.contract.cutover_policy !== "no_migration"
    || body.contract.p0_effect !== "defined_inactive_only"
  ) {
    fail("PROPOSITION_LIFECYCLE_GENESIS_MISMATCH", "resolver genesis is not the fixed no-migration production anchor", {
      eventId: node.eventId,
      epochId: body.epoch.epoch_id,
      genesisScope: body.epoch.genesis_scope,
      contractKind: body.contract.kind,
    });
  }
}

function nodeReferences(node: ResolverNode): readonly string[] {
  if (node.kind === "genesis") return Object.freeze([]);
  const body = node.body as PropositionEvidenceBodyV1 | PropositionLifecycleBodyV1;
  const refs = new Set<string>();
  refs.add(body.epoch.genesis_event_id);
  for (const eventId of body.facets.lineage.causal_parents) refs.add(eventId);
  for (const eventId of body.facets.lineage.derives_from) refs.add(eventId);
  for (const eventId of body.facets.lineage.supersedes) refs.add(eventId);
  for (const eventId of body.facets.contestability.counterevidence_event_ids) refs.add(eventId);
  if (isLifecycleKind(node.kind)) {
    for (const eventId of (body as PropositionLifecycleBodyV1).lifecycle.target_event_ids) refs.add(eventId);
  }
  return Object.freeze([...refs].sort(compareCodeUnits));
}

function uniqueNodeMap(nodes: readonly ResolverNode[]): Map<string, ResolverNode> {
  const output = new Map<string, ResolverNode>();
  for (const node of nodes) {
    if (output.has(node.eventId)) fail("PROPOSITION_LIFECYCLE_DUPLICATE_EVENT", "duplicate proposition event id", { eventId: node.eventId });
    output.set(node.eventId, node);
  }
  return output;
}

function assertAcyclic(nodes: readonly ResolverNode[], references: ReadonlyMap<string, readonly string[]>): void {
  const state = new Map<string, "visiting" | "visited">();
  const visit = (eventId: string, stack: readonly string[]): void => {
    const seen = state.get(eventId);
    if (seen === "visited") return;
    if (seen === "visiting") {
      fail("PROPOSITION_LIFECYCLE_CYCLE", "proposition causal topology contains a cycle", { cycle: [...stack, eventId] });
    }
    state.set(eventId, "visiting");
    for (const parent of references.get(eventId) ?? []) visit(parent, [...stack, eventId]);
    state.set(eventId, "visited");
  };
  for (const node of [...nodes].sort((left, right) => compareCodeUnits(left.eventId, right.eventId))) visit(node.eventId, []);
}

function scopeIsResolved(scope: PropositionFacets["spatial_scope"]): boolean {
  if (scope.scope_level === "global") return scope.project_id === null && scope.domain === null;
  if (scope.scope_level === "project") return typeof scope.project_id === "string" && scope.project_id.length > 0 && scope.domain === null;
  if (scope.scope_level === "domain") return typeof scope.domain === "string" && scope.domain.length > 0;
  return false;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return sameOrderedStrings([...left].sort(compareCodeUnits), [...right].sort(compareCodeUnits));
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isLifecycleKind(kind: NodeKind): kind is EffectiveLifecycleOperation {
  return kind === "retract" || kind === "rescope" || kind === "supersede" || kind === "archive" || kind === "reactivate";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionLifecycleResolutionError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
