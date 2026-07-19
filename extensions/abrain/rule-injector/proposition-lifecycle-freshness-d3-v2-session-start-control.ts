/// <reference types="node" />
/**
 * ADR0040 D3-v2 session_start control-flow entry (R3.4).
 *
 * Flow for selected sessions:
 *  1) load+validate bound activation + live adapter manifest
 *  2) halt/taint check
 *  3) strict D3 read
 *  4) construct expected exact fence
 *  5) classify existing managed suffix (own/foreign/mixed/malformed)
 *  6) exact own after successful audit => idempotent keep
 *  7) foreign/malformed => sanitize in-memory, then inject v2 on success
 *     or return sanitized zero-rule prompt on failure
 *  Never keep v1/compiled/legacy fences on the selected path.
 */
import * as path from "node:path";
import { resolveActiveProject } from "../../_shared/runtime";
import {
  buildD3V2SessionStartAdapterManifest,
  composeD3V2SessionStartInjection,
  loadD3V2SessionStartBoundActivationObject,
  readD3V2SessionStartForRuntime,
  readD3V2SessionStartHaltOrTaint,
  sanitizeManagedRuleFences,
  selectD3V2SessionStartSession,
  validateD3V2SessionStartAdapterManifest,
  classifyManagedSuffix,
  type D3V2BoundActivationObject,
  type D3V2SessionStartInjectionSettings,
  type D3V2SessionStartRuntimeReadResult,
  type D3V2SessionStartSelection,
  type D3V2OwnFenceExpectation,
} from "../../_shared/proposition-lifecycle-freshness-d3-v2-session-start";
import {
  appendD3V2SessionStartRuntimeAudit,
  buildD3V2SessionStartRuntimeAuditRow,
  type D3V2SessionStartRuntimeAuditAppendResult,
} from "./proposition-lifecycle-freshness-d3-v2-runtime-audit";

export const D3_V2_SESSION_START_CONTROL_SOURCE_MARKER =
  "source=proposition-lifecycle-freshness-d3-v2" as const;

export interface D3V2SessionStartControlContext {
  repoRoot: string;
  abrainHome: string;
  cwd: string;
  settings: D3V2SessionStartInjectionSettings;
  sessionManager?: unknown;
  currentSystemPrompt: string;
  latestUserText: string;
  controlRoot?: string;
  auditFile?: string;
  activationRoot?: string;
  causalAnchor?: Readonly<Record<string, unknown>>;
}

export type D3V2SessionStartControlDecision =
  | {
    kind: "unselected";
    selection: D3V2SessionStartSelection;
  }
  | {
    kind: "selected_zero_injection";
    selection: Extract<D3V2SessionStartSelection, { selected: true }>;
    reason: string;
    error?: string;
    systemPrompt?: string;
    audit?: D3V2SessionStartRuntimeAuditAppendResult;
    adapterManifestHash?: string;
    activationNonce?: string;
  }
  | {
    kind: "selected_injected";
    selection: Extract<D3V2SessionStartSelection, { selected: true }>;
    systemPrompt: string;
    result: Extract<D3V2SessionStartRuntimeReadResult, { ok: true }>;
    adapterManifestHash: string;
    activationNonce: string;
    activationObjectHash: string;
    audit: D3V2SessionStartRuntimeAuditAppendResult;
    idempotent: boolean;
  };

/** Independent activeProjectId resolver for selected v2. */
export function resolveD3V2SessionStartActiveProjectId(args: {
  abrainHome: string;
  cwd: string;
}): string | undefined {
  try {
    const binding = resolveActiveProject(args.cwd, { abrainHome: args.abrainHome });
    return binding.activeProject?.projectId;
  } catch {
    return undefined;
  }
}

export function resolveCurrentD3V2SessionStartAdapterManifestHash(repoRoot: string): string {
  const manifest = buildD3V2SessionStartAdapterManifest({ repoRoot: path.resolve(repoRoot) });
  validateD3V2SessionStartAdapterManifest(manifest);
  return manifest.manifest_hash;
}

/**
 * Resolve bound activation for a selected session from settings path+hash.
 * Returns null + reason on failure (fail-closed).
 */
export function resolveSelectedBoundActivation(args: {
  settings: D3V2SessionStartInjectionSettings;
  activationRoot?: string;
}): { ok: true; activation: D3V2BoundActivationObject } | { ok: false; reason: string; error?: string } {
  try {
    if (!args.settings.activationObjectPath || !args.settings.activationObjectHash) {
      return { ok: false, reason: "activation_binding_missing" };
    }
    const activation = loadD3V2SessionStartBoundActivationObject({
      activationObjectPath: args.settings.activationObjectPath,
      activationObjectHash: args.settings.activationObjectHash,
      activationRoot: args.activationRoot,
    });
    return { ok: true, activation };
  } catch (error) {
    return {
      ok: false,
      reason: "activation_load_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Nonce is always the bound activation's unique nonce (never random at runtime). */
export function resolveD3V2SessionStartActivationNonce(activation: D3V2BoundActivationObject): string {
  return activation.activation_nonce;
}

export function decideD3V2SessionStartControl(args: D3V2SessionStartControlContext): D3V2SessionStartControlDecision {
  const selection = selectD3V2SessionStartSession({
    settings: args.settings,
    sessionManager: args.sessionManager,
  });
  if (!selection.selected || !selection.sessionId) {
    return { kind: "unselected", selection };
  }
  const selected = selection as Extract<D3V2SessionStartSelection, { selected: true }>;
  const sessionId = selected.sessionId!;

  // Always sanitize-capable base: foreign/malformed removal is in-memory only.
  const sanitizedBase = sanitizeManagedRuleFences(args.currentSystemPrompt);

  let adapterManifestHash: string;
  try {
    adapterManifestHash = resolveCurrentD3V2SessionStartAdapterManifestHash(args.repoRoot);
  } catch (error) {
    return zero(selected, "adapter_manifest_invalid", sanitizedBase, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const loaded = resolveSelectedBoundActivation({
    settings: args.settings,
    activationRoot: args.activationRoot,
  });
  if (!loaded.ok) {
    return zero(selected, loaded.reason, sanitizedBase, {
      error: loaded.error,
      adapterManifestHash,
    });
  }
  const activation = loaded.activation;
  const activationNonce = activation.activation_nonce;

  // Halt / taint before D3.
  const halt = readD3V2SessionStartHaltOrTaint({
    rollbackTarget: activation.rollback_target,
    activationNonce,
    sessionId,
  });
  if (halt.halted) {
    const haltReason = halt.kind === "halt"
      ? "halted"
      : halt.kind === "taint"
        ? "session_tainted"
        : "pending_rollback_intent";
    const audit = appendSelectedAudit({
      sessionId,
      latestUserText: args.latestUserText,
      decision: "selected_zero_injection",
      reason: haltReason,
      renderedPrompt: sanitizedBase,
      activationNonce,
      activationObjectHash: activation.activation_object_hash,
      authorizationCoordinateHash: activation.authorization_coordinate_hash,
      adapterManifestHash,
      causalAnchor: args.causalAnchor ?? { session_id: sessionId, halt: true, kind: halt.kind },
      auditFile: args.auditFile ?? activation.audit_target,
    });
    return zero(selected, haltReason, sanitizedBase, {
      error: halt.reason ?? undefined,
      audit,
      adapterManifestHash,
      activationNonce,
    });
  }

  const activeProjectId = resolveD3V2SessionStartActiveProjectId({
    abrainHome: args.abrainHome,
    cwd: args.cwd,
  });

  const result = readD3V2SessionStartForRuntime({
    abrainHome: args.abrainHome,
    settings: args.settings,
    sessionManager: args.sessionManager,
    activeProjectId,
    controlRoot: args.controlRoot,
    adapterManifestHash,
    activation,
    activationRoot: args.activationRoot,
  });

  if (!result.ok) {
    const audit = appendSelectedAudit({
      sessionId,
      latestUserText: args.latestUserText,
      decision: "selected_zero_injection",
      reason: result.reason,
      renderedPrompt: sanitizedBase,
      activationNonce,
      activationObjectHash: activation.activation_object_hash,
      authorizationCoordinateHash: activation.authorization_coordinate_hash,
      adapterManifestHash,
      causalAnchor: args.causalAnchor ?? { session_id: sessionId },
      auditFile: args.auditFile ?? activation.audit_target,
    });
    return zero(selected, result.reason, sanitizedBase, {
      error: result.error,
      audit,
      adapterManifestHash,
      activationNonce,
    });
  }

  const expected: D3V2OwnFenceExpectation = {
    session_id: sessionId,
    activation_nonce: result.activationNonce,
    activation_object_hash: result.activationObjectHash,
    selection: result.selectionHash,
    head: result.headHash,
    proof: result.proofHash,
    stable: result.stableBundleHash,
    adapter_manifest: result.adapterManifestHash,
    viewMd: result.viewMd,
  };
  const exactFence = composeD3V2SessionStartInjection(result, sessionId);
  const classification = classifyManagedSuffix(args.currentSystemPrompt, expected);

  // Exact own: idempotent keep after successful audit (no re-injection needed).
  if (classification.kind === "own") {
    const systemPrompt = args.currentSystemPrompt; // keep exact bytes
    const audit = appendSelectedAudit({
      sessionId,
      latestUserText: args.latestUserText,
      decision: "d3_v2_session_start_injected",
      reason: "exact_own_idempotent",
      renderedPrompt: systemPrompt,
      d3v2: result,
      activationNonce: result.activationNonce,
      activationObjectHash: result.activationObjectHash,
      authorizationCoordinateHash: result.authorizationCoordinateHash,
      adapterManifestHash,
      causalAnchor: args.causalAnchor ?? {
        session_id: sessionId,
        surface_combination_hash: result.surfaceCombinationHash,
        activation_object_hash: result.activationObjectHash,
      },
      auditFile: args.auditFile ?? activation.audit_target,
    });
    if (!audit.ok) {
      return zero(selected, "audit_append_failed", sanitizedBase, {
        error: audit.error,
        audit,
        adapterManifestHash,
        activationNonce: result.activationNonce,
      });
    }
    return {
      kind: "selected_injected",
      selection: selected,
      systemPrompt,
      result,
      adapterManifestHash,
      activationNonce: result.activationNonce,
      activationObjectHash: result.activationObjectHash,
      audit,
      idempotent: true,
    };
  }

  // foreign / mixed / malformed / absent → sanitize then inject v2.
  const base = classification.kind === "absent" ? args.currentSystemPrompt : sanitizedBase;
  const systemPrompt = base.length === 0 ? exactFence : `${base}${base.endsWith("\n") ? "\n" : "\n\n"}${exactFence}`;
  const audit = appendSelectedAudit({
    sessionId,
    latestUserText: args.latestUserText,
    decision: "d3_v2_session_start_injected",
    reason: result.reason,
    renderedPrompt: systemPrompt,
    d3v2: result,
    activationNonce: result.activationNonce,
    activationObjectHash: result.activationObjectHash,
    authorizationCoordinateHash: result.authorizationCoordinateHash,
    adapterManifestHash,
    causalAnchor: args.causalAnchor ?? {
      session_id: sessionId,
      surface_combination_hash: result.surfaceCombinationHash,
      activation_object_hash: result.activationObjectHash,
      authorization_coordinate_hash: result.authorizationCoordinateHash,
    },
    auditFile: args.auditFile ?? activation.audit_target,
  });
  if (!audit.ok) {
    // Audit failure => sanitized zero injection, no fallback.
    return zero(selected, "audit_append_failed", sanitizedBase, {
      error: audit.error,
      audit,
      adapterManifestHash,
      activationNonce: result.activationNonce,
    });
  }

  return {
    kind: "selected_injected",
    selection: selected,
    systemPrompt,
    result,
    adapterManifestHash,
    activationNonce: result.activationNonce,
    activationObjectHash: result.activationObjectHash,
    audit,
    idempotent: false,
  };
}

function zero(
  selection: Extract<D3V2SessionStartSelection, { selected: true }>,
  reason: string,
  sanitizedPrompt: string,
  extra: {
    error?: string;
    audit?: D3V2SessionStartRuntimeAuditAppendResult;
    adapterManifestHash?: string;
    activationNonce?: string;
  } = {},
): Extract<D3V2SessionStartControlDecision, { kind: "selected_zero_injection" }> {
  return {
    kind: "selected_zero_injection",
    selection,
    reason,
    systemPrompt: sanitizedPrompt,
    ...extra,
  };
}

function appendSelectedAudit(args: {
  sessionId: string;
  latestUserText: string;
  decision: "d3_v2_session_start_injected" | "selected_zero_injection";
  reason: string;
  renderedPrompt: string;
  d3v2?: Extract<D3V2SessionStartRuntimeReadResult, { ok: true }>;
  activationNonce: string;
  activationObjectHash?: string;
  authorizationCoordinateHash?: string;
  adapterManifestHash: string;
  causalAnchor?: Readonly<Record<string, unknown>>;
  auditFile?: string;
}): D3V2SessionStartRuntimeAuditAppendResult {
  const row = buildD3V2SessionStartRuntimeAuditRow({
    sessionId: args.sessionId,
    latestUserText: args.latestUserText,
    decision: args.decision,
    reason: args.reason,
    renderedPrompt: args.renderedPrompt,
    activationNonce: args.activationNonce,
    adapterManifestHash: args.adapterManifestHash,
    activationObjectHash: args.activationObjectHash,
    authorizationCoordinateHash: args.authorizationCoordinateHash,
    causalAnchor: args.causalAnchor ?? { session_id: args.sessionId },
    ...(args.d3v2 ? { d3v2: args.d3v2 } : {}),
  });
  return appendD3V2SessionStartRuntimeAudit(row, args.auditFile);
}
