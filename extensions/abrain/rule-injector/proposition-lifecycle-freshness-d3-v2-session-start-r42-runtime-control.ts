/// <reference types="node" />
/** R4.2 terminal + immutable runtime-audit gate for the real rule injector. */
import {
  classifyManagedSuffix,
  composeD3V2SessionStartInjection,
  readD3V2SessionStartForRuntime,
  sanitizeManagedRuleFences,
  type D3V2R42RuntimeActivation,
  type D3V2SessionStartInjectionSettings,
  type D3V2SessionStartRuntimeReadResult,
  type D3V2OwnFenceExpectation,
} from "../../_shared/proposition-lifecycle-freshness-d3-v2-session-start";
// The R4.2 authority implementation is deliberately Node-stdlib ESM so the
// committed CLI and the jiti-loaded runtime execute exactly the same bytes.
// @ts-ignore - local .mjs module is source-closure pinned and runtime validated.
import { runtimeEnableProduction } from "../../_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs";

export const D3_V2_R42_RUNTIME_CONTROL_SOURCE_MARKER =
  "source=proposition-lifecycle-freshness-d3-v2-r4.2-runtime-control" as const;

type D3V2R42RuntimeReadSuccess = Extract<D3V2SessionStartRuntimeReadResult, { ok: true }>;

interface D3V2R42PreparedInjection {
  systemPrompt: string;
  result: D3V2R42RuntimeReadSuccess;
  adapterManifestHash: string;
  idempotent: boolean;
}

type D3V2R42RuntimeGateResult =
  | {
    status: "allow_one_first_injection_decision";
    audit_object_hash: string;
    prepared?: D3V2R42PreparedInjection;
  }
  | {
    status: "runtime_enable_authorization_required" | "runtime_terminal_drift_repreview_required";
    reason?: string;
    preview?: Readonly<Record<string, unknown>>;
  };

export type D3V2R42RuntimeControlResult =
  | {
    ok: false;
    reason: string;
    error?: string;
    systemPrompt: string;
    runtimeEnablePreview?: Readonly<Record<string, unknown>>;
    runtimeEnableAuthorizationPhrase?: string;
  }
  | {
    ok: true;
    systemPrompt: string;
    result: D3V2R42RuntimeReadSuccess;
    adapterManifestHash: string;
    activationNonce: string;
    activationObjectHash: string;
    idempotent: boolean;
    auditObjectHash: string;
  };

export function decideD3V2R42RuntimeControl(args: {
  repoRoot: string;
  abrainHome: string;
  settings: D3V2SessionStartInjectionSettings;
  sessionManager?: unknown;
  activeProjectId?: string;
  currentSystemPrompt: string;
  controlRoot?: string;
}): D3V2R42RuntimeControlResult {
  const sanitizedBase = sanitizeManagedRuleFences(args.currentSystemPrompt);
  try {
    const adapterManifestHash = args.settings.adapterManifestHash;
    if (!adapterManifestHash) throw new Error("R4.2 settings adapter manifest hash is absent");
    const readCurrent = (activation: D3V2R42RuntimeActivation) => {
      const result = readD3V2SessionStartForRuntime({
        abrainHome: args.abrainHome,
        settings: args.settings,
        sessionManager: args.sessionManager,
        activeProjectId: args.activeProjectId,
        adapterManifestHash,
        r42Activation: activation,
        ...(args.controlRoot ? { controlRoot: args.controlRoot } : {}),
      });
      if (!result.ok) throw new Error(`${result.reason}: ${result.error ?? "R4.2 D3 read failed"}`);
      return result;
    };
    const gate = runtimeEnableProduction(args.repoRoot, {
      prepareInjection({ terminal }: { terminal: { activation: D3V2R42RuntimeActivation } }) {
        const result = readCurrent(terminal.activation);
        const sessionId = result.sessionId;
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
        if (classification.kind === "own") {
          return { systemPrompt: args.currentSystemPrompt, result, adapterManifestHash, idempotent: true };
        }
        const base = classification.kind === "absent" ? args.currentSystemPrompt : sanitizedBase;
        const systemPrompt = base.length === 0 ? exactFence : `${base}${base.endsWith("\n") ? "\n" : "\n\n"}${exactFence}`;
        return { systemPrompt, result, adapterManifestHash, idempotent: false };
      },
      revalidatePrepared(prepared: unknown, { terminal }: { terminal: { activation: D3V2R42RuntimeActivation } }) {
        const prior = prepared as Pick<D3V2R42PreparedInjection, "result"> | undefined;
        if (!prior?.result) throw new Error("R4.2 prepared D3 result is absent at decision-time revalidation");
        const current = readCurrent(terminal.activation);
        if (current.surfaceCombinationHash !== prior.result.surfaceCombinationHash
          || current.viewMd !== prior.result.viewMd
          || current.viewBytes !== prior.result.viewBytes
          || current.itemCount !== prior.result.itemCount
          || current.activationObjectHash !== prior.result.activationObjectHash
          || current.activationNonce !== prior.result.activationNonce
          || current.adapterManifestHash !== prior.result.adapterManifestHash) {
          throw new Error("R4.2 live D3 surface changed before the first-injection decision");
        }
      },
    }) as D3V2R42RuntimeGateResult;
    if (gate.status !== "allow_one_first_injection_decision") {
      const authorizationPhrase = gate.preview?.exact_authorization_phrase;
      return {
        ok: false,
        reason: gate.reason ?? gate.status,
        systemPrompt: sanitizedBase,
        ...(gate.preview
          ? {
            runtimeEnablePreview: gate.preview,
            ...(typeof authorizationPhrase === "string"
              ? { runtimeEnableAuthorizationPhrase: authorizationPhrase }
              : {}),
          }
          : {}),
      };
    }
    const prepared = gate.prepared;
    if (!prepared) throw new Error("R4.2 runtime gate allowed without a prepared in-memory injection result");
    return {
      ok: true,
      systemPrompt: prepared.systemPrompt,
      result: prepared.result,
      adapterManifestHash: prepared.adapterManifestHash,
      activationNonce: prepared.result.activationNonce,
      activationObjectHash: prepared.result.activationObjectHash,
      idempotent: prepared.idempotent,
      auditObjectHash: String(gate.audit_object_hash),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "r42_runtime_gate_failed",
      error: error instanceof Error ? error.message : String(error),
      systemPrompt: sanitizedBase,
    };
  }
}
