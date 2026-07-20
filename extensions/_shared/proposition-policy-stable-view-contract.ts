export const PROPOSITION_POLICY_STABLE_VIEW_CONTRACT_RELATIVE = "extensions/_shared/proposition-policy-stable-view-contract.ts" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_MAX_ITEMS = 128 as const;
export const PROPOSITION_POLICY_STABLE_VIEW_MAX_STATEMENT_UTF8_BYTES = 8_192 as const;
export const PROPOSITION_POLICY_STABLE_VIEW_MAX_PAYLOAD_UTF8_BYTES = 131_072 as const;
export const PROPOSITION_POLICY_STABLE_VIEW_MAX_CANONICAL_INPUT_EVENTS = 4_096 as const;
export const PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES = 196_608 as const;
export const PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES = 262_144 as const;

export const PROPOSITION_POLICY_STABLE_VIEW_COMPILER_MANIFEST_SCHEMA = "proposition-policy-stable-view-manifest/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_COMPILER_MANIFEST_AUTHORITY = "production_policy_projection_for_sole_persisted_main_session_rule_source" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_COMPILER_MANIFEST_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object with manifest_hash omitted" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_COMPILER_ARTIFACT_NAMES = Object.freeze([
  "view.json",
  "view.md",
  "diagnostics.json",
  "parity.json",
] as const);

export interface PropositionPolicyStableViewCompilerManifestBaseInput {
  compileKey: string;
  sourceBundleHash: string;
  compileProfileHash: string;
  decisionIdentity: string;
  fixtureSynthetic: boolean;
  resultKind: "ready_empty" | "ready_nonempty";
  artifactRows: readonly Readonly<{ name: string; bytes: number; sha256: string }>[];
  sourceClosure: Readonly<Record<string, unknown>>;
}

/** Pure contract reconstruction shared by compiler and artifact-only validators. */
export function buildPropositionPolicyStableViewCompilerManifestBase(
  input: PropositionPolicyStableViewCompilerManifestBaseInput,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_COMPILER_MANIFEST_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    authority: PROPOSITION_POLICY_STABLE_VIEW_COMPILER_MANIFEST_AUTHORITY,
    compile_key: input.compileKey,
    source_bundle_hash: input.sourceBundleHash,
    compile_profile_hash: input.compileProfileHash,
    decision_identity: input.decisionIdentity,
    fixture_synthetic: input.fixtureSynthetic,
    result_kind: input.resultKind,
    artifact_rows: input.artifactRows,
    source_closure: input.sourceClosure,
    runtime_unreachability: {
      compiler_exports_injection_capability: false,
      verification_required_before_preview_acceptance: true,
    },
    manifest_hash_scope: PROPOSITION_POLICY_STABLE_VIEW_COMPILER_MANIFEST_HASH_SCOPE,
  };
}
