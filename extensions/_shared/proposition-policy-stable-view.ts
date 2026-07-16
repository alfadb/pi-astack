import { createHash } from "node:crypto";
import { validatePropositionEvidenceBody } from "./proposition";
import {
  PROPOSITION_POLICY_STABLE_VIEW_MAX_ITEMS,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_PAYLOAD_UTF8_BYTES,
  PROPOSITION_POLICY_STABLE_VIEW_MAX_STATEMENT_UTF8_BYTES,
  buildPropositionPolicyStableViewCompilerManifestBase,
} from "./proposition-policy-stable-view-contract";

export const PROPOSITION_POLICY_STABLE_VIEW_PROFILE_SCHEMA = "proposition-policy-stable-view-compile-profile/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_SCHEMA = "proposition-policy-stable-view/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_DIAGNOSTICS_SCHEMA = "proposition-policy-stable-view-diagnostics/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_PARITY_SCHEMA = "proposition-policy-stable-view-parity/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_MANIFEST_SCHEMA = "proposition-policy-stable-view-manifest/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_REQUEST_RECEIPT_SCHEMA = "proposition-policy-stable-view-compile-request-receipt/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_OUTCOME_RECEIPT_SCHEMA = "proposition-policy-stable-view-compile-outcome-receipt/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_OBSERVATION_SCHEMA = "proposition-policy-stable-view-observation/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_FIXTURE_SCHEMA = "fixture-decision-set/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_FIXTURE_NAMESPACE = "adr0040-p2b1-sandbox-fixture-only" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_FIXTURE_SOURCE_IDENTITY_SCHEMA = "proposition-policy-stable-view-fixture-source-identity/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_REAL_SOURCE_IDENTITY_SCHEMA = "proposition-policy-stable-view-real-source-identity/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_EMPTY_DECISION = "empty-source/no-decision/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION_SCHEMA = "proposition-policy-stable-view-policy-set-decision/v1" as const;
export const PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION = "validated_active_original_policy_candidates" as const;
/** Historical export retained for P2b1 callers; it no longer denotes a single candidate. */
export const PROPOSITION_POLICY_STABLE_VIEW_MVP_DECISION = PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION;

const PROFILE_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this profile object with profile_hash omitted" as const;
const MANIFEST_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object with manifest_hash omitted" as const;
const STABLE_ARTIFACT_NAMES = Object.freeze(["view.json", "view.md", "diagnostics.json", "parity.json", "manifest.json"] as const);
const MANIFEST_ARTIFACT_NAMES = Object.freeze(["view.json", "view.md", "diagnostics.json", "parity.json"] as const);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXPECTED_RULE_FAMILIES = Object.freeze(["deterministic_renderer", "scope_preservation", "budget_reject_without_truncation", "four_tuple_state_policy"] as const);
const EXPECTED_FORBIDDEN_KEYS = Object.freeze([
  "injectMode", "inject_mode", "always", "listed", "omitted", "priority", "policy_eligibility",
  "session_start_eligibility", "selection", "lkg", "ttl", "stale", "age_stale", "behind_source",
  "cross_source_compatibility", "rollback", "runtime_consumer", "production_target", "placement",
] as const);
const LEGAL_TUPLES = Object.freeze([
  Object.freeze({ pipeline: "idle", freshness: "unknown", selection: "none", health: "blocked" }),
  Object.freeze({ pipeline: "completed", freshness: "fresh", selection: "current", health: "ok" }),
  Object.freeze({ pipeline: "queued", freshness: "unknown", selection: "none", health: "blocked" }),
  Object.freeze({ pipeline: "rejected", freshness: "unknown", selection: "none", health: "blocked" }),
] as const);
const P2A_BUNDLE_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this manifest object with bundle_hash omitted" as const;
const P2A_RECORD_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this record object with record_hash omitted" as const;
const P2A_EXCLUSION_PRECEDENCE_HASH = "3288be448f40c13aefd88137eedf1fd05f38191f1a8adbcfc6d339bc5561ec9e";
const OUTPUT_DIAGNOSTIC_CODE = "POLICY_CANDIDATE_EXCLUDED" as const;
const OUTPUT_DIAGNOSTIC_SEVERITY = "info" as const;
const OUTPUT_EXCLUSION_FILTER_STAGE = "stable_view_disposition" as const;
const OUTPUT_EXCLUSION_REASON_CODE = "disposition_excluded" as const;
const OUTPUT_RENDERER = "ordered-statements-double-newline-terminal-newline-v1" as const;
const OUTPUT_AUTHORITY = "non_authoritative_repo_sandbox_only_no_runtime_consumer" as const;
const FIXTURE_DECISION_IDENTITY_SCHEMA = "proposition-policy-stable-view-fixture-decision-identity/v1" as const;
const REJECTED_OUTCOME_CODES = new Set([
  "array_expected", "artifact_bytes_invalid", "artifact_jcs_invalid", "artifact_json_invalid", "artifact_semantic_mismatch",
  "artifact_validation_request_not_completed", "budget_item_count_exceeded", "budget_payload_bytes_exceeded", "budget_statement_bytes_exceeded",
  "compile_profile_drift", "compile_profile_hash_mismatch", "duplicate_diagnostic", "duplicate_value", "fixture_decision_for_real_rejected",
  "fixture_decision_missing", "fixture_decisions_invalid", "fixture_disposition_invalid", "fixture_merge_group_invalid", "fixture_merge_not_byte_identical",
  "fixture_namespace_invalid", "fixture_requires_nonempty_source", "fixture_source_bundle_hash_mismatch", "fixture_source_conservation_invalid",
  "fixture_source_hash_mismatch", "fixture_source_manifest_rejected", "forbidden_key", "foreign_diagnostic", "hash_algorithm_invalid",
  "idle_receipt_correlation_invalid", "missing_disposition", "missing_or_duplicate_diagnostic", "non_view_scalar_invalid", "non_view_schema_invalid",
  "non_view_string_not_closed", "object_expected", "object_keys_invalid", "observation_artifact_identity_invalid", "observation_correlation_mismatch",
  "observation_identity_invalid", "observation_tuple_invalid", "pipeline_invalid", "ready_empty_invalid", "real_source_bundle_hash_mismatch",
  "real_source_diagnostic_contract_invalid", "real_source_entry_contract_invalid", "real_source_entry_lifecycle_invalid", "real_source_epoch_mismatch",
  "real_source_exclusion_contract_invalid", "real_source_manifest_artifact_mismatch", "real_source_manifest_count_invalid",
  "real_source_manifest_count_mismatch", "real_source_manifest_hash_mismatch", "real_source_manifest_identity_invalid",
  "real_source_profile_identity_mismatch", "real_source_record_hash_mismatch", "real_source_resolution_invalid", "receipt_artifact_identity_mismatch",
  "receipt_correlation_mismatch", "receipt_for_no_request", "receipt_hash_mismatch", "receipt_request_size_invalid", "receipt_schema_invalid",
  "receipt_timestamp_order_invalid", "request_correlation_invalid", "request_mode_invalid", "request_schema_invalid", "sha256_invalid",
  "sorted_unique_invalid", "source_conservation_invalid", "source_diagnostics_invalid", "source_entries_invalid", "source_exclusions_invalid",
  "source_statement_invalid", "statement_isolation_violation", "string_array_invalid", "string_invalid", "unexpected_compile_failure",
  "unexpected_decision_for_empty", "view_statement_invalid",
]);

const EXPECTED_PROFILE_BASE = deepFreeze({
  allowed_rule_families: EXPECTED_RULE_FAMILIES,
  budget: {
    max_injectable_payload_utf8_bytes: PROPOSITION_POLICY_STABLE_VIEW_MAX_PAYLOAD_UTF8_BYTES,
    max_items: PROPOSITION_POLICY_STABLE_VIEW_MAX_ITEMS,
    max_statement_utf8_bytes: PROPOSITION_POLICY_STABLE_VIEW_MAX_STATEMENT_UTF8_BYTES,
  },
  canonicalization: "RFC8785-JCS",
  determinism: {
    environment_independent: true,
    filesystem_order_independent: true,
    locale_independent: true,
    network_independent: true,
    provider_independent: true,
    wall_clock_independent: true,
  },
  four_tuple_state_policy: {
    axis_order: ["pipeline", "freshness", "selection-marker", "health"],
    tuples: [
      ["idle", "unknown", "none", "blocked"],
      ["completed", "fresh", "current", "ok"],
      ["queued", "unknown", "none", "blocked"],
      ["rejected", "unknown", "none", "blocked"],
    ],
  },
  hash_algorithm: "sha256",
  non_view_output_vocabulary: {
    diagnostic: { code: OUTPUT_DIAGNOSTIC_CODE, severity: OUTPUT_DIAGNOSTIC_SEVERITY },
    excluded_disposition: { filter_stage: OUTPUT_EXCLUSION_FILTER_STAGE, reason_code: OUTPUT_EXCLUSION_REASON_CODE },
    fixture_decision_identity_schema: FIXTURE_DECISION_IDENTITY_SCHEMA,
  },
  profile_hash_scope: PROFILE_HASH_SCOPE,
  recursively_forbidden_keys_case_insensitive: EXPECTED_FORBIDDEN_KEYS,
  renderer: {
    item_separator: "\n\n",
    nonempty_terminal_newline: true,
    ready_empty_utf8_bytes: 0,
    source: "view.json.items[].statement",
  },
  schema_version: PROPOSITION_POLICY_STABLE_VIEW_PROFILE_SCHEMA,
  scope_preservation: {
    merge_requires_byte_identical_scope: true,
    scope_source: "source_entry.effective_facets.spatial_scope",
  },
  source_identity: {
    fixture: {
      formula: "sha256(RFC8785-JCS({schema_version,source}))",
      schema_version: PROPOSITION_POLICY_STABLE_VIEW_FIXTURE_SOURCE_IDENTITY_SCHEMA,
    },
    real: {
      contract: "self_bound_validated_p2a_bundle/v1",
      formula: "sha256(RFC8785-JCS({schema_version,source_bundle_hash,source_artifact_rows}))",
      schema_version: PROPOSITION_POLICY_STABLE_VIEW_REAL_SOURCE_IDENTITY_SCHEMA,
    },
  },
});

export type StableArtifactName = typeof STABLE_ARTIFACT_NAMES[number];
export type StablePipeline = "idle" | "completed" | "queued" | "rejected";
export type StableFreshness = "fresh" | "unknown";
export type StableSelection = "current" | "none";
export type StableHealth = "ok" | "blocked";

export interface StableViewCompileProfile extends Record<string, unknown> {
  schema_version: typeof PROPOSITION_POLICY_STABLE_VIEW_PROFILE_SCHEMA;
  profile_hash: string;
  budget: {
    max_injectable_payload_utf8_bytes: number;
    max_items: number;
    max_statement_utf8_bytes: number;
  };
  recursively_forbidden_keys_case_insensitive: readonly string[];
}

export interface StableViewSourceBundle {
  entries: Readonly<Record<string, unknown>>;
  exclusions: Readonly<Record<string, unknown>>;
  diagnostics: Readonly<Record<string, unknown>>;
  manifest?: Readonly<Record<string, unknown>>;
}

export interface StableViewCompileRequest {
  source_bundle_hash: string;
  source: StableViewSourceBundle;
  compile_profile: StableViewCompileProfile;
  mode: "real" | "fixture";
  fixture_decision_set?: Readonly<Record<string, unknown>>;
}

export interface StableArtifactSet {
  readonly "view.json": string;
  readonly "view.md": string;
  readonly "diagnostics.json": string;
  readonly "parity.json": string;
  readonly "manifest.json": string;
}

export interface StableViewEvaluation {
  request_id: string | null;
  request_raw_sha256: string | null;
  request_raw_utf8_bytes: number | null;
  pipeline: StablePipeline;
  outcome_code: string;
  compile_key: string | null;
  manifest_hash: string | null;
  source_bundle_hash: string | null;
  compile_profile_hash: string | null;
  decision_identity: string | null;
  real_or_fixture: "real" | "fixture" | null;
  artifacts: StableArtifactSet | null;
}

interface RequestCorrelation {
  request_id: string;
  request_raw_sha256: string;
  request_raw_utf8_bytes: number;
}

export interface StableViewReceiptSet {
  request_receipt: Readonly<Record<string, unknown>>;
  outcome_receipt: Readonly<Record<string, unknown>>;
  observation: Readonly<Record<string, unknown>>;
}

interface ValidatedEntry {
  source_event_id: string;
  source_body_sha256: string;
  statement: string;
  statement_sha256: string;
  scope: Readonly<Record<string, unknown>>;
  scope_sha256: string;
  consumer_policy: boolean;
  lineage_event_ids: readonly string[];
  lifecycle: Readonly<{
    disposition: "active";
    activation: "original" | "reactivated";
    terminal_event_id: string;
  }>;
}

interface ValidatedExclusion {
  source_event_id: string;
}

interface ValidatedDiagnostic {
  source_event_id: string;
}

interface ValidatedSource {
  entries: readonly ValidatedEntry[];
  exclusions: readonly ValidatedExclusion[];
  diagnostics: readonly ValidatedDiagnostic[];
  universe: readonly string[];
}

interface ValidatedDecision {
  source_event_id: string;
  disposition: "included" | "merged" | "excluded";
  merge_group?: string;
}

export class PropositionPolicyStableViewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyStableViewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function stableViewCanonicalizeJcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("noncanonical_number", "JCS does not admit non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableViewCanonicalizeJcs(item)).join(",")}]`;
  if (!value || typeof value !== "object") fail("noncanonical_value", "JCS input contains an unsupported value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareCodeUnits).map((key) => {
    if (record[key] === undefined) fail("noncanonical_value", "JCS input contains undefined", { key });
    return `${JSON.stringify(key)}:${stableViewCanonicalizeJcs(record[key])}`;
  }).join(",")}}`;
}

export function stableViewSha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableViewJcsSha256Hex(value: unknown): string {
  return stableViewSha256Hex(stableViewCanonicalizeJcs(value));
}

export function validateStableViewCompileProfile(input: unknown): StableViewCompileProfile {
  const profile = asRecord(input, "compile_profile");
  exactKeys(profile, [...Object.keys(EXPECTED_PROFILE_BASE), "profile_hash"], "compile_profile");
  assertSha256(profile.profile_hash, "compile_profile.profile_hash");
  const base = { ...profile };
  delete base.profile_hash;
  if (stableViewCanonicalizeJcs(base) !== stableViewCanonicalizeJcs(EXPECTED_PROFILE_BASE)) {
    fail("compile_profile_drift", "compile profile values differ from the one accepted profile");
  }
  if (stableViewJcsSha256Hex(base) !== profile.profile_hash) fail("compile_profile_hash_mismatch", "compile profile self-hash is invalid");
  assertNoForbiddenKeys(profile, EXPECTED_FORBIDDEN_KEYS, "compile_profile");
  assertHashFields(profile, "compile_profile", false);
  return deepFreeze(profile) as StableViewCompileProfile;
}

export function computeStableViewFixtureSourceBundleHash(source: unknown): string {
  return stableViewJcsSha256Hex({ schema_version: PROPOSITION_POLICY_STABLE_VIEW_FIXTURE_SOURCE_IDENTITY_SCHEMA, source });
}

export function deriveStableViewRequestCorrelation(input: unknown): Readonly<RequestCorrelation> {
  const canonicalRaw = stableViewCanonicalizeJcs(input);
  const requestRawSha256 = stableViewSha256Hex(canonicalRaw);
  return deepFreeze({ request_id: requestRawSha256, request_raw_sha256: requestRawSha256, request_raw_utf8_bytes: Buffer.byteLength(canonicalRaw) });
}

export function evaluatePropositionPolicyStableView(input: unknown | null): StableViewEvaluation {
  if (input === null) return idleEvaluation();
  // The public evaluator accepts only the canonical JSON value domain. A wrapper must
  // reject unsupported/cyclic/undefined-bearing values before requesting receipts.
  const correlation = deriveStableViewRequestCorrelation(input);
  try {
    return evaluateAcceptedRequest(input, correlation);
  } catch (error) {
    const candidateCode = error instanceof PropositionPolicyStableViewError ? error.code : "unexpected_compile_failure";
    const code = REJECTED_OUTCOME_CODES.has(candidateCode) ? candidateCode : "unexpected_compile_failure";
    const request = isRecord(input) ? input as Partial<StableViewCompileRequest> : {};
    return deepFreeze({
      ...correlation,
      pipeline: "rejected" as const,
      outcome_code: code,
      compile_key: null,
      manifest_hash: null,
      source_bundle_hash: typeof request.source_bundle_hash === "string" && SHA256_PATTERN.test(request.source_bundle_hash) ? request.source_bundle_hash : null,
      compile_profile_hash: isRecord(request.compile_profile) && typeof request.compile_profile.profile_hash === "string" && SHA256_PATTERN.test(request.compile_profile.profile_hash) ? request.compile_profile.profile_hash : null,
      decision_identity: null,
      real_or_fixture: request.mode === "real" || request.mode === "fixture" ? request.mode : null,
      artifacts: null,
    });
  }
}

/**
 * Compile a validated P2a shadow bundle without rereading L1 or inferring any
 * runtime rule metadata. Every source candidate receives one deterministic
 * disposition. Only explicit policy=true, active/original candidates whose
 * scope is representable by the runtime reader are included.
 */
export function compilePropositionPolicyStableView(input: unknown): StableViewEvaluation {
  const correlation = deriveStableViewRequestCorrelation(input);
  const evaluated = evaluateAcceptedRequest(input, correlation);
  if (evaluated.pipeline === "completed") return evaluated;
  if (evaluated.pipeline !== "queued" || evaluated.outcome_code !== "production_decision_required") {
    fail("policy_source_not_queued", "policy-set compilation requires an otherwise-valid real request");
  }
  const request = input as StableViewCompileRequest;
  if (request.mode !== "real" || request.fixture_decision_set !== undefined) {
    fail("policy_request_invalid", "policy-set compilation accepts only a real request without fixture decisions");
  }
  const profile = validateStableViewCompileProfile(request.compile_profile);
  const source = validateSource(request.source, "real");
  validateRealSourceEnvelope(request.source_bundle_hash, request.source, source, profile);
  const decisions = deepFreeze(source.entries.map((candidate): ValidatedDecision => deepFreeze({
    source_event_id: candidate.source_event_id,
    disposition: candidate.consumer_policy
      && candidate.lifecycle.disposition === "active"
      && candidate.lifecycle.activation === "original"
      && runtimeScopeIsRepresentable(candidate.scope)
      ? "included"
      : "excluded",
  })));
  const decisionIdentity = stableViewJcsSha256Hex({
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION_SCHEMA,
    basis: PROPOSITION_POLICY_STABLE_VIEW_POLICY_SET_DECISION,
    source_bundle_hash: request.source_bundle_hash,
    candidate_dispositions: decisions,
  });
  return compileAccepted(request, profile, source, decisions, decisionIdentity, false, correlation);
}

/** Historical API alias retained with generalized set semantics. */
export function compilePropositionPolicyStableViewMvp(input: unknown): StableViewEvaluation {
  return compilePropositionPolicyStableView(input);
}

function evaluateAcceptedRequest(input: unknown, correlation: RequestCorrelation): StableViewEvaluation {
  const request = asRecord(input, "request");
  const keys = Object.keys(request);
  const allowedKeys = new Set(["source_bundle_hash", "source", "compile_profile", "mode", "fixture_decision_set"]);
  if (keys.some((key) => !allowedKeys.has(key))) fail("request_schema_invalid", "compile request contains an unsupported field");
  for (const required of ["source_bundle_hash", "source", "compile_profile", "mode"]) if (!(required in request)) fail("request_schema_invalid", "compile request is missing a required field", { required });
  const typed = request as unknown as StableViewCompileRequest;
  assertSha256(typed.source_bundle_hash, "request.source_bundle_hash");
  if (typed.mode !== "real" && typed.mode !== "fixture") fail("request_mode_invalid", "request mode must be real or fixture");
  const profile = validateStableViewCompileProfile(typed.compile_profile);
  const forbidden = profile.recursively_forbidden_keys_case_insensitive;
  assertNoForbiddenKeys({ entries: typed.source.entries, exclusions: typed.source.exclusions, diagnostics: typed.source.diagnostics }, forbidden, "request.source.documents");
  if (typed.fixture_decision_set !== undefined) {
    assertNoForbiddenKeys(typed.fixture_decision_set, forbidden, "request.fixture_decision_set");
    assertHashFields(typed.fixture_decision_set, "request.fixture_decision_set", false);
  }
  assertHashFields(typed.source, "request.source", false);
  const source = validateSource(typed.source, typed.mode);

  if (typed.mode === "real") {
    validateRealSourceEnvelope(typed.source_bundle_hash, typed.source, source, profile);
    if (source.entries.length === 0 && typed.fixture_decision_set !== undefined) fail("unexpected_decision_for_empty", "an empty real source rejects every supplied decision");
    if (source.entries.length > 0 && typed.fixture_decision_set !== undefined) fail("fixture_decision_for_real_rejected", "fixture decisions are byte-incompatible with real requests");
    if (source.entries.length > 0) return queuedEvaluation(typed, profile, correlation);
    return compileAccepted(typed, profile, source, [], PROPOSITION_POLICY_STABLE_VIEW_EMPTY_DECISION, false, correlation);
  }
  if (typed.source.manifest !== undefined) fail("fixture_source_manifest_rejected", "fixture source identity cannot carry a real P2a manifest");
  const expectedFixtureSourceHash = computeStableViewFixtureSourceBundleHash(typed.source);
  if (typed.source_bundle_hash !== expectedFixtureSourceHash) fail("fixture_source_bundle_hash_mismatch", "fixture source bundle hash does not match the domain-separated canonical source identity");
  if (source.entries.length === 0) fail("fixture_requires_nonempty_source", "fixture decisions are nonempty-sandbox-only");
  if (typed.fixture_decision_set === undefined) fail("fixture_decision_missing", "fixture mode requires its isolated decision set");
  const decisions = validateFixtureDecisionSet(typed.fixture_decision_set, typed.source_bundle_hash, source);
  const fixtureIdentity = stableViewJcsSha256Hex({ schema_version: FIXTURE_DECISION_IDENTITY_SCHEMA, fixture_decision_set: typed.fixture_decision_set });
  return compileAccepted(typed, profile, source, decisions, fixtureIdentity, true, correlation);
}

function validateSource(sourceInput: unknown, mode: "real" | "fixture"): ValidatedSource {
  const source = asRecord(sourceInput, "source");
  exactKeys(source, mode === "real" ? ["entries", "exclusions", "diagnostics", "manifest"] : ["entries", "exclusions", "diagnostics"], "source");
  const entriesDoc = asRecord(source.entries, "source.entries");
  const exclusionsDoc = asRecord(source.exclusions, "source.exclusions");
  const diagnosticsDoc = asRecord(source.diagnostics, "source.diagnostics");
  if (mode === "real") {
    exactKeys(entriesDoc, ["schema_version", "epoch_id", "genesis_event_id", "entries"], "source.entries");
    exactKeys(exclusionsDoc, ["schema_version", "epoch_id", "genesis_event_id", "exclusions"], "source.exclusions");
    exactKeys(diagnosticsDoc, ["schema_version", "epoch_id", "genesis_event_id", "diagnostics"], "source.diagnostics");
  }
  if (entriesDoc.schema_version !== "proposition-policy-push-shadow-entries/v1" || !Array.isArray(entriesDoc.entries)) fail("source_entries_invalid", "source entries document identity is invalid");
  if (exclusionsDoc.schema_version !== "proposition-policy-push-shadow-exclusions/v1" || !Array.isArray(exclusionsDoc.exclusions)) fail("source_exclusions_invalid", "source exclusions document identity is invalid");
  if (diagnosticsDoc.schema_version !== "proposition-policy-push-shadow-diagnostics/v1" || !Array.isArray(diagnosticsDoc.diagnostics)) fail("source_diagnostics_invalid", "source diagnostics document identity is invalid");

  const entries = entriesDoc.entries.map((raw, index): ValidatedEntry => {
    const at = `source.entries.entries[${index}]`;
    const entry = asRecord(raw, at);
    assertSha256(entry.source_event_id, `${at}.source_event_id`);
    if (typeof entry.statement !== "string" || !entry.statement.length) fail("source_statement_invalid", "source statement must be a nonempty string", { index });
    const facets = asRecord(entry.effective_facets, `${at}.effective_facets`);
    const scope = asRecord(facets.spatial_scope, `${at}.effective_facets.spatial_scope`);
    assertNoStatementKey(scope, `${at}.effective_facets.spatial_scope`);
    const lifecycle = asRecord(entry.lifecycle, `${at}.lifecycle`);
    let consumerPolicy = true;
    let activation: "original" | "reactivated" = "original";
    let terminalEventId = String(entry.source_event_id);
    if (mode === "real") {
      exactKeys(entry, ["schema_version", "record_hash_scope", "record_hash", "source_event_id", "source_epoch", "candidate_face", "candidate_semantics", "statement", "language", "modality", "effective_facets", "lifecycle"], at);
      if (entry.schema_version !== "proposition-policy-push-shadow-entry/v1" || entry.record_hash_scope !== P2A_RECORD_HASH_SCOPE
        || entry.candidate_face !== "policy_push" || entry.candidate_semantics !== "relevance_only_no_injection_verdict" || entry.modality !== "normative") fail("real_source_entry_contract_invalid", "real source entry is not an exact P2a candidate row", { index });
      validateRecordSelfHash(entry, at);
      const sourceEpoch = asRecord(entry.source_epoch, `${at}.source_epoch`);
      exactKeys(sourceEpoch, ["epoch_id", "genesis_event_id"], `${at}.source_epoch`);
      assertNonemptyString(entry.language, `${at}.language`);
      validatePropositionEvidenceBody({
        event_schema_version: "proposition-evidence-event/v1",
        event_type: "proposition_observed",
        producer: { name: "pi-astack.proposition-policy-stable-view-validator", version: "v1" },
        epoch: sourceEpoch,
        proposition: { modality: entry.modality, statement: entry.statement, language: entry.language },
        facets: entry.effective_facets,
      });
      const consumerHints = asRecord(facets.consumer_hints, `${at}.effective_facets.consumer_hints`);
      consumerPolicy = consumerHints.policy === true;
      exactKeys(lifecycle, ["disposition", "activation", "lineage_event_ids", "lineage", "terminal_event_id"], `${at}.lifecycle`);
      if (lifecycle.disposition !== "active" || !["original", "reactivated"].includes(String(lifecycle.activation)) || !Array.isArray(lifecycle.lineage)) fail("real_source_entry_lifecycle_invalid", "real source entry lifecycle is not active P2a state", { index });
      activation = lifecycle.activation as "original" | "reactivated";
      assertSha256(lifecycle.terminal_event_id, `${at}.lifecycle.terminal_event_id`);
      terminalEventId = String(lifecycle.terminal_event_id);
    }
    const lineage = stringArray(lifecycle.lineage_event_ids, `${at}.lifecycle.lineage_event_ids`, { allowEmpty: true });
    for (const [lineageIndex, id] of lineage.entries()) assertSha256(id, `${at}.lifecycle.lineage_event_ids[${lineageIndex}]`);
    assertUnique(lineage, `${at}.lifecycle.lineage_event_ids`);
    return deepFreeze({
      source_event_id: String(entry.source_event_id),
      source_body_sha256: String(entry.source_event_id),
      statement: entry.statement,
      statement_sha256: stableViewSha256Hex(entry.statement),
      scope: deepClone(scope),
      scope_sha256: stableViewJcsSha256Hex(scope),
      consumer_policy: consumerPolicy,
      lineage_event_ids: lineage,
      lifecycle: { disposition: "active", activation, terminal_event_id: terminalEventId },
    });
  }).sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));

  const exclusions = exclusionsDoc.exclusions.map((raw, index): ValidatedExclusion => {
    const exclusion = asRecord(raw, `source.exclusions.exclusions[${index}]`);
    if (mode === "real") {
      exactKeys(exclusion, ["schema_version", "record_hash_scope", "record_hash", "source_event_id", "filter_stage", "reason_code"], `source.exclusions.exclusions[${index}]`);
      if (exclusion.schema_version !== "proposition-policy-push-shadow-exclusion/v1" || exclusion.record_hash_scope !== P2A_RECORD_HASH_SCOPE) fail("real_source_exclusion_contract_invalid", "real source exclusion is not an exact P2a row", { index });
      assertNonemptyString(exclusion.filter_stage, `source.exclusions.exclusions[${index}].filter_stage`);
      assertNonemptyString(exclusion.reason_code, `source.exclusions.exclusions[${index}].reason_code`);
      validateRecordSelfHash(exclusion, `source.exclusions.exclusions[${index}]`);
    } else {
      exactKeys(exclusion, ["source_event_id"], `source.exclusions.exclusions[${index}]`);
    }
    assertSha256(exclusion.source_event_id, `source.exclusions.exclusions[${index}].source_event_id`);
    return deepFreeze({ source_event_id: String(exclusion.source_event_id) });
  }).sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));

  const diagnostics = diagnosticsDoc.diagnostics.map((raw, index): ValidatedDiagnostic => {
    const diagnostic = asRecord(raw, `source.diagnostics.diagnostics[${index}]`);
    if (mode === "real") {
      exactKeys(diagnostic, ["schema_version", "record_hash_scope", "record_hash", "code", "severity", "source_event_id", "filter_stage", "reason_code"], `source.diagnostics.diagnostics[${index}]`);
      if (diagnostic.schema_version !== "proposition-policy-push-shadow-diagnostic/v1" || diagnostic.record_hash_scope !== P2A_RECORD_HASH_SCOPE
        || diagnostic.code !== "POLICY_CANDIDATE_EXCLUDED" || diagnostic.severity !== "info") fail("real_source_diagnostic_contract_invalid", "real source diagnostic is not an exact P2a row", { index });
      assertNonemptyString(diagnostic.filter_stage, `source.diagnostics.diagnostics[${index}].filter_stage`);
      assertNonemptyString(diagnostic.reason_code, `source.diagnostics.diagnostics[${index}].reason_code`);
      validateRecordSelfHash(diagnostic, `source.diagnostics.diagnostics[${index}]`);
    } else {
      exactKeys(diagnostic, ["source_event_id"], `source.diagnostics.diagnostics[${index}]`);
    }
    assertSha256(diagnostic.source_event_id, `source.diagnostics.diagnostics[${index}].source_event_id`);
    return deepFreeze({ source_event_id: String(diagnostic.source_event_id) });
  }).sort(compareDiagnostics);

  assertSortedUnique(entries.map((entry) => entry.source_event_id), "source entry IDs", { allowEmpty: true });
  assertSortedUnique(exclusions.map((entry) => entry.source_event_id), "source exclusion IDs", { allowEmpty: true });
  const universe = [...entries.map((entry) => entry.source_event_id), ...exclusions.map((entry) => entry.source_event_id)].sort(compareCodeUnits);
  assertSortedUnique(universe, "source universe", { allowEmpty: true });
  const diagnosticKeys = diagnostics.map((row) => stableViewCanonicalizeJcs(row));
  if (new Set(diagnosticKeys).size !== diagnosticKeys.length) fail("duplicate_diagnostic", "source diagnostics contain a duplicate exact commitment");
  const universeSet = new Set(universe);
  for (const diagnostic of diagnostics) {
    if (!universeSet.has(diagnostic.source_event_id)) fail("foreign_diagnostic", "diagnostic source is absent from the source universe", { source_event_id: diagnostic.source_event_id });
  }
  for (const exclusion of exclusions) {
    const matching = diagnostics.filter((diagnostic) => diagnostic.source_event_id === exclusion.source_event_id);
    if (matching.length !== 1) fail("missing_or_duplicate_diagnostic", "each input exclusion requires one source-ID-only diagnostic commitment", { source_event_id: exclusion.source_event_id, matching: matching.length });
    if (mode === "real") {
      const rawExclusion = (exclusionsDoc.exclusions as Array<Record<string, unknown>>).find((row) => row.source_event_id === exclusion.source_event_id)!;
      const rawMatching = (diagnosticsDoc.diagnostics as Array<Record<string, unknown>>).filter((row) => row.source_event_id === exclusion.source_event_id
        && row.filter_stage === rawExclusion.filter_stage && row.reason_code === rawExclusion.reason_code);
      if (rawMatching.length !== 1) fail("missing_or_duplicate_diagnostic", "real P2a exclusion and diagnostic metadata do not exactly match", { source_event_id: exclusion.source_event_id, matching: rawMatching.length });
    }
  }
  return deepFreeze({ entries, exclusions, diagnostics, universe });
}

function validateRealSourceEnvelope(sourceBundleHash: string, input: StableViewSourceBundle, source: ValidatedSource, profile: StableViewCompileProfile): void {
  const manifest = asRecord(input.manifest, "source.manifest");
  exactKeys(manifest, ["schema_version", "canonicalization", "hash_algorithm", "bundle_hash_scope", "authority", "projection_envelope_contract", "candidate_contract", "epoch", "source", "exclusion_precedence", "result", "artifacts", "bundle_hash"], "source.manifest");
  const projection = asRecord(manifest.projection_envelope_contract, "source.manifest.projection_envelope_contract");
  const candidate = asRecord(manifest.candidate_contract, "source.manifest.candidate_contract");
  const epoch = asRecord(manifest.epoch, "source.manifest.epoch");
  const sourceContract = asRecord(manifest.source, "source.manifest.source");
  exactKeys(projection, ["envelope_schema", "phase", "body_schema", "write_enabled", "fold_eligible"], "source.manifest.projection_envelope_contract");
  exactKeys(candidate, ["face", "semantics", "runtime_consumer"], "source.manifest.candidate_contract");
  exactKeys(epoch, ["epoch_id", "genesis_event_id"], "source.manifest.epoch");
  exactKeys(sourceContract, ["scanner", "whole_l1", "consumed_classification", "consumed_envelope_schemas", "proposition_event_count", "proposition_genesis_count", "proposition_evidence_count", "proposition_lifecycle_count", "proposition_selected_count", "proposition_foldable_count", "non_proposition_event_consumed_count", "input_event_ids", "input_event_ids_hash", "evidence_event_ids", "evidence_event_ids_hash", "lifecycle_event_ids", "lifecycle_event_ids_hash", "source_resolution_inventory", "source_resolution_inventory_hash", "registry_file_sha256", "proposition_contract_file_sha256", "lifecycle_resolver_file_sha256", "projector_file_sha256", "lifecycle_resolver_schema"], "source.manifest.source");
  if (manifest.schema_version !== "proposition-policy-push-shadow-manifest/v2"
    || manifest.canonicalization !== "RFC8785-JCS" || manifest.hash_algorithm !== "sha256" || manifest.bundle_hash_scope !== P2A_BUNDLE_HASH_SCOPE
    || manifest.authority !== "shadow_push_only_no_runtime_consumer"
    || projection.envelope_schema !== "proposition-projection-envelope/v1" || projection.phase !== "phase_disabled" || projection.body_schema !== null || projection.write_enabled !== false || projection.fold_eligible !== false
    || candidate.face !== "policy_push" || candidate.semantics !== "relevance_only_no_injection_verdict" || candidate.runtime_consumer !== false
    || sourceContract.scanner !== "scanWholeL1Validated" || sourceContract.whole_l1 !== true || sourceContract.consumed_classification !== "defined-inactive-shadow"
    || sourceContract.proposition_selected_count !== 0 || sourceContract.proposition_foldable_count !== 0 || sourceContract.non_proposition_event_consumed_count !== 0
    || sourceContract.lifecycle_resolver_schema !== "proposition-lifecycle-effective-state/v1") {
    fail("real_source_manifest_identity_invalid", "real source manifest is not the exact inert P2a shadow contract");
  }
  const consumedSchemas = ["proposition-evidence-envelope/v1", "proposition-genesis-envelope/v1", "proposition-lifecycle-envelope/v1"];
  if (stableViewCanonicalizeJcs(sourceContract.consumed_envelope_schemas) !== stableViewCanonicalizeJcs(consumedSchemas)
    || stableViewJcsSha256Hex(manifest.exclusion_precedence) !== P2A_EXCLUSION_PRECEDENCE_HASH) fail("real_source_manifest_identity_invalid", "P2a source schemas or exclusion precedence differ");
  const precedence = array(manifest.exclusion_precedence, "source.manifest.exclusion_precedence").map((raw, index) => {
    const row = asRecord(raw, `source.manifest.exclusion_precedence[${index}]`);
    exactKeys(row, ["rank", "stage", "reason_codes"], `source.manifest.exclusion_precedence[${index}]`);
    return row;
  });
  const rawExclusions = asRecord(input.exclusions, "source.exclusions").exclusions as Array<Record<string, unknown>>;
  for (const exclusion of source.exclusions) {
    const raw = rawExclusions.find((candidate) => candidate.source_event_id === exclusion.source_event_id)!;
    const row = precedence.find((candidateRow) => candidateRow.stage === raw.filter_stage);
    if (!row || !Array.isArray(row.reason_codes) || !row.reason_codes.includes(raw.reason_code)) fail("real_source_exclusion_contract_invalid", "P2a exclusion stage/reason is outside exact precedence contract", { source_event_id: exclusion.source_event_id });
  }
  assertSha256(manifest.bundle_hash, "source.manifest.bundle_hash");
  if (manifest.bundle_hash !== sourceBundleHash) fail("real_source_bundle_hash_mismatch", "request source bundle hash differs from the self-hashed P2a manifest");
  const manifestBase = { ...manifest };
  delete manifestBase.bundle_hash;
  if (stableViewJcsSha256Hex(manifestBase) !== sourceBundleHash) fail("real_source_manifest_hash_mismatch", "P2a manifest self-hash does not bind the request source bundle hash");
  const result = asRecord(manifest.result, "source.manifest.result");
  exactKeys(result, ["entry_count", "exclusion_count", "diagnostic_count"], "source.manifest.result");
  const entriesDoc = asRecord(input.entries, "source.entries");
  const exclusionsDoc = asRecord(input.exclusions, "source.exclusions");
  const diagnosticsDoc = asRecord(input.diagnostics, "source.diagnostics");
  if (entriesDoc.epoch_id !== epoch.epoch_id || exclusionsDoc.epoch_id !== epoch.epoch_id || diagnosticsDoc.epoch_id !== epoch.epoch_id
    || entriesDoc.genesis_event_id !== epoch.genesis_event_id || exclusionsDoc.genesis_event_id !== epoch.genesis_event_id || diagnosticsDoc.genesis_event_id !== epoch.genesis_event_id) fail("real_source_epoch_mismatch", "P2a source document epoch differs from manifest");
  for (const [value, at] of [[epoch.genesis_event_id, "source.manifest.epoch.genesis_event_id"], [sourceContract.registry_file_sha256, "source.manifest.source.registry_file_sha256"], [sourceContract.proposition_contract_file_sha256, "source.manifest.source.proposition_contract_file_sha256"], [sourceContract.lifecycle_resolver_file_sha256, "source.manifest.source.lifecycle_resolver_file_sha256"], [sourceContract.projector_file_sha256, "source.manifest.source.projector_file_sha256"]] as const) assertSha256(value, at);
  const inputIds = sortedHashArray(sourceContract.input_event_ids, "source.manifest.source.input_event_ids", false);
  const evidenceIds = sortedHashArray(sourceContract.evidence_event_ids, "source.manifest.source.evidence_event_ids", true);
  const lifecycleIds = sortedHashArray(sourceContract.lifecycle_event_ids, "source.manifest.source.lifecycle_event_ids", true);
  if (sourceContract.input_event_ids_hash !== stableViewJcsSha256Hex(inputIds) || sourceContract.evidence_event_ids_hash !== stableViewJcsSha256Hex(evidenceIds)
    || sourceContract.lifecycle_event_ids_hash !== stableViewJcsSha256Hex(lifecycleIds)) fail("real_source_manifest_hash_mismatch", "P2a source event partition hashes differ");
  const expectedInputIds = [String(epoch.genesis_event_id), ...evidenceIds, ...lifecycleIds].sort(compareCodeUnits);
  for (const [key, value] of Object.entries(sourceContract)) if (key.endsWith("_count") && (!Number.isSafeInteger(value) || Number(value) < 0)) fail("real_source_manifest_count_invalid", "P2a source count is invalid", { key });
  if (!sameStrings(inputIds, expectedInputIds) || sourceContract.proposition_event_count !== inputIds.length || sourceContract.proposition_genesis_count !== 1
    || sourceContract.proposition_evidence_count !== evidenceIds.length || sourceContract.proposition_lifecycle_count !== lifecycleIds.length
    || Number(sourceContract.proposition_event_count) !== Number(sourceContract.proposition_genesis_count) + Number(sourceContract.proposition_evidence_count) + Number(sourceContract.proposition_lifecycle_count)) fail("real_source_manifest_count_invalid", "P2a event partition or counts differ");
  const inventory = array(sourceContract.source_resolution_inventory, "source.manifest.source.source_resolution_inventory");
  if (sourceContract.source_resolution_inventory_hash !== stableViewJcsSha256Hex(inventory)) fail("real_source_manifest_hash_mismatch", "P2a source resolution inventory hash differs");
  const inventoryIds = inventory.map((raw, index) => {
    const row = asRecord(raw, `source.manifest.source.source_resolution_inventory[${index}]`);
    exactKeys(row, ["source_event_id", "statement_sha256", "language", "modality", "effective_facets", "lifecycle"], `source.manifest.source.source_resolution_inventory[${index}]`);
    assertSha256(row.source_event_id, `source.manifest.source.source_resolution_inventory[${index}].source_event_id`);
    assertSha256(row.statement_sha256, `source.manifest.source.source_resolution_inventory[${index}].statement_sha256`);
    if (row.modality !== "normative") fail("real_source_resolution_invalid", "P2a source resolution modality differs", { index });
    validateP2aFacetsShape(row.effective_facets, `source.manifest.source.source_resolution_inventory[${index}].effective_facets`);
    const resolutionLifecycle = asRecord(row.lifecycle, `source.manifest.source.source_resolution_inventory[${index}].lifecycle`);
    exactKeys(resolutionLifecycle, ["disposition", "activation", "lineage_event_ids", "lineage", "terminal_event_id", "superseded_by_event_id"], `source.manifest.source.source_resolution_inventory[${index}].lifecycle`);
    if (!Array.isArray(resolutionLifecycle.lineage_event_ids) || !Array.isArray(resolutionLifecycle.lineage)) fail("real_source_resolution_invalid", "P2a source resolution lifecycle arrays are invalid", { index });
    const entry = source.entries.find((candidateEntry) => candidateEntry.source_event_id === row.source_event_id);
    if (entry) {
      const rawEntry = (entriesDoc.entries as Array<Record<string, unknown>>).find((candidateEntry) => candidateEntry.source_event_id === row.source_event_id)!;
      const expectedLifecycle = { ...asRecord(rawEntry.lifecycle, "source entry lifecycle"), superseded_by_event_id: null };
      if (stableViewSha256Hex(entry.statement) !== row.statement_sha256 || stableViewCanonicalizeJcs(rawEntry.effective_facets) !== stableViewCanonicalizeJcs(row.effective_facets)
        || stableViewCanonicalizeJcs(expectedLifecycle) !== stableViewCanonicalizeJcs(row.lifecycle)) fail("real_source_resolution_invalid", "P2a entry differs from manifest source-resolution commitment", { index });
    }
    return String(row.source_event_id);
  });
  assertSortedUnique(inventoryIds, "source.manifest.source.source_resolution_inventory IDs", { allowEmpty: true });
  if (!sameStrings(inventoryIds, evidenceIds) || !sameStrings(inventoryIds, source.universe)) fail("real_source_resolution_invalid", "P2a source resolution inventory does not exactly cover source dispositions");
  if (result.entry_count !== source.entries.length || result.exclusion_count !== source.exclusions.length || result.diagnostic_count !== source.diagnostics.length) {
    fail("real_source_manifest_count_mismatch", "P2a manifest result counts differ from canonical source documents");
  }
  const documentRows = sourceArtifactRows(input, false);
  if (!Array.isArray(manifest.artifacts) || stableViewCanonicalizeJcs(manifest.artifacts) !== stableViewCanonicalizeJcs(documentRows)) {
    fail("real_source_manifest_artifact_mismatch", "P2a manifest artifact rows do not bind the exact canonical source documents");
  }
  assertHashFields(manifest, "source.manifest", false);
  const realProfile = asRecord(asRecord(profile.source_identity, "compile_profile.source_identity").real, "compile_profile.source_identity.real");
  if (realProfile.contract !== "self_bound_validated_p2a_bundle/v1"
    || realProfile.schema_version !== PROPOSITION_POLICY_STABLE_VIEW_REAL_SOURCE_IDENTITY_SCHEMA
    || realProfile.formula !== "sha256(RFC8785-JCS({schema_version,source_bundle_hash,source_artifact_rows}))") {
    fail("real_source_profile_identity_mismatch", "real source profile does not accept exact self-bound validated P2a bundles");
  }
}

function sourceArtifactRows(input: StableViewSourceBundle, includeManifest: boolean): readonly Readonly<Record<string, unknown>>[] {
  const documents: Array<readonly [string, unknown]> = [
    ["diagnostics.json", input.diagnostics],
    ["entries.json", input.entries],
    ["exclusions.json", input.exclusions],
  ];
  if (includeManifest) documents.push(["manifest.json", input.manifest]);
  return deepFreeze(documents.map(([name, value]) => {
    const raw = canonicalJson(value);
    return { bytes: Buffer.byteLength(raw), name, sha256: stableViewSha256Hex(raw) };
  }));
}

function validateFixtureDecisionSet(input: unknown, sourceBundleHash: string, source: ValidatedSource): readonly ValidatedDecision[] {
  const fixture = asRecord(input, "fixture_decision_set");
  exactKeys(fixture, ["schema_version", "namespace", "fixture_synthetic", "source_bundle_hash", "decisions"], "fixture_decision_set");
  if (fixture.schema_version !== PROPOSITION_POLICY_STABLE_VIEW_FIXTURE_SCHEMA
    || fixture.namespace !== PROPOSITION_POLICY_STABLE_VIEW_FIXTURE_NAMESPACE
    || fixture.fixture_synthetic !== true) fail("fixture_namespace_invalid", "fixture decision set identity is invalid");
  if (fixture.source_bundle_hash !== sourceBundleHash) fail("fixture_source_hash_mismatch", "fixture decision set binds a different source bundle");
  if (!Array.isArray(fixture.decisions)) fail("fixture_decisions_invalid", "fixture decisions must be an array");
  const decisions = fixture.decisions.map((raw, index): ValidatedDecision => {
    const decision = asRecord(raw, `fixture_decision_set.decisions[${index}]`);
    assertSha256(decision.source_event_id, `fixture_decision_set.decisions[${index}].source_event_id`);
    if (decision.disposition === "included") {
      exactKeys(decision, ["source_event_id", "disposition"], `fixture_decision_set.decisions[${index}]`);
      return deepFreeze({ source_event_id: String(decision.source_event_id), disposition: "included" });
    }
    if (decision.disposition === "merged") {
      exactKeys(decision, ["source_event_id", "disposition", "merge_group"], `fixture_decision_set.decisions[${index}]`);
      assertNonemptyString(decision.merge_group, `fixture_decision_set.decisions[${index}].merge_group`);
      return deepFreeze({ source_event_id: String(decision.source_event_id), disposition: "merged", merge_group: String(decision.merge_group) });
    }
    if (decision.disposition === "excluded") {
      exactKeys(decision, ["source_event_id", "disposition"], `fixture_decision_set.decisions[${index}]`);
      return deepFreeze({ source_event_id: String(decision.source_event_id), disposition: "excluded" });
    }
    fail("fixture_disposition_invalid", "fixture disposition must be included, merged, or excluded", { index });
  }).sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  assertSortedUnique(decisions.map((decision) => decision.source_event_id), "fixture decision source IDs");
  const sourceIds = source.entries.map((entry) => entry.source_event_id);
  if (!sameStrings(sourceIds, decisions.map((decision) => decision.source_event_id))) fail("fixture_source_conservation_invalid", "fixture decisions must cover every candidate entry exactly once");
  const groups = new Map<string, ValidatedDecision[]>();
  for (const decision of decisions) if (decision.disposition === "merged") groups.set(decision.merge_group!, [...(groups.get(decision.merge_group!) ?? []), decision]);
  for (const [group, members] of groups) {
    if (members.length < 2) fail("fixture_merge_group_invalid", "a merge group must contain at least two sources", { group });
    const sourceEntries = members.map((member) => source.entries.find((entry) => entry.source_event_id === member.source_event_id)!);
    const statement = sourceEntries[0]!.statement;
    const scope = stableViewCanonicalizeJcs(sourceEntries[0]!.scope);
    if (sourceEntries.some((entry) => entry.statement !== statement || stableViewCanonicalizeJcs(entry.scope) !== scope)) {
      fail("fixture_merge_not_byte_identical", "merged sources must preserve byte-identical statements and scopes", { group });
    }
  }
  return deepFreeze(decisions);
}

function compileAccepted(
  input: StableViewCompileRequest,
  profile: StableViewCompileProfile,
  source: ValidatedSource,
  decisions: readonly ValidatedDecision[],
  decisionIdentity: string,
  fixtureSynthetic: boolean,
  correlation: RequestCorrelation,
): StableViewEvaluation {
  const compileKey = stableViewJcsSha256Hex({
    source_bundle_hash: input.source_bundle_hash,
    compile_profile_hash: profile.profile_hash,
    accepted_decision_hash_or_empty_sentinel: decisionIdentity,
  });
  const decisionBySource = new Map(decisions.map((decision) => [decision.source_event_id, decision]));
  const items: Array<Record<string, unknown>> = [];
  const dispositions: Array<Record<string, unknown>> = source.exclusions.map((exclusion) => ({
    source_event_id: exclusion.source_event_id,
    disposition: "excluded",
    item_id: null,
    filter_stage: OUTPUT_EXCLUSION_FILTER_STAGE,
    reason_code: OUTPUT_EXCLUSION_REASON_CODE,
  }));
  const scopeLineage: Array<Record<string, unknown>> = [];

  const included = source.entries.filter((entry) => decisionBySource.get(entry.source_event_id)?.disposition === "included");
  for (const entry of included) {
    const item = buildItem([entry], `included:${entry.source_event_id}`);
    items.push(item);
    dispositions.push({ source_event_id: entry.source_event_id, disposition: "included", item_id: item.item_id, filter_stage: null, reason_code: null });
  }
  const mergedGroups = new Map<string, ValidatedEntry[]>();
  for (const entry of source.entries) {
    const decision = decisionBySource.get(entry.source_event_id);
    if (decision?.disposition === "merged") mergedGroups.set(decision.merge_group!, [...(mergedGroups.get(decision.merge_group!) ?? []), entry]);
    if (decision?.disposition === "excluded") dispositions.push({
      source_event_id: entry.source_event_id, disposition: "excluded", item_id: null,
      filter_stage: OUTPUT_EXCLUSION_FILTER_STAGE, reason_code: OUTPUT_EXCLUSION_REASON_CODE,
    });
  }
  for (const [group, entries] of [...mergedGroups].sort(([left], [right]) => compareCodeUnits(left, right))) {
    entries.sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
    const item = buildItem(entries, `merged:${group}`);
    items.push(item);
    for (const entry of entries) dispositions.push({ source_event_id: entry.source_event_id, disposition: "merged", item_id: item.item_id, filter_stage: null, reason_code: null });
  }
  items.sort((left, right) => compareCodeUnits(String(left.item_id), String(right.item_id)));
  dispositions.sort((left, right) => compareCodeUnits(String(left.source_event_id), String(right.source_event_id)));

  for (const entry of source.entries) {
    const disposition = dispositions.find((row) => row.source_event_id === entry.source_event_id);
    if (!disposition) fail("missing_disposition", "candidate source has no output disposition", { source_event_id: entry.source_event_id });
    scopeLineage.push({
      source_event_id: entry.source_event_id,
      source_body_sha256: entry.source_body_sha256,
      statement_sha256: entry.statement_sha256,
      item_id: disposition.item_id,
      scope_sha256: stableViewJcsSha256Hex(entry.scope),
      lineage_event_ids_hash: stableViewJcsSha256Hex(entry.lineage_event_ids),
      lineage_event_count: entry.lineage_event_ids.length,
      lifecycle_disposition: entry.lifecycle.disposition,
      lifecycle_activation: entry.lifecycle.activation,
      lifecycle_terminal_event_id: entry.lifecycle.terminal_event_id,
    });
  }
  if (dispositions.length !== source.universe.length || !sameStrings(dispositions.map((row) => String(row.source_event_id)), source.universe)) {
    fail("source_conservation_invalid", "output dispositions do not exactly partition the source universe");
  }
  if (items.length > profile.budget.max_items) fail("budget_item_count_exceeded", "stable item budget exceeded without truncation", { items: items.length });
  for (const item of items) {
    const bytes = Buffer.byteLength(String(item.statement));
    if (bytes > profile.budget.max_statement_utf8_bytes) fail("budget_statement_bytes_exceeded", "statement budget exceeded without truncation", { bytes });
  }

  const viewMd = items.length === 0 ? "" : `${items.map((item) => String(item.statement)).join("\n\n")}\n`;
  const payloadBytes = Buffer.byteLength(viewMd);
  if (payloadBytes > profile.budget.max_injectable_payload_utf8_bytes) fail("budget_payload_bytes_exceeded", "injectable payload budget exceeded without truncation", { payloadBytes });
  const resultKind = items.length === 0 ? "ready_empty" : "ready_nonempty";
  const view = deepFreeze({
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_SCHEMA,
    compile_key: compileKey,
    source_bundle_hash: input.source_bundle_hash,
    compile_profile_hash: profile.profile_hash,
    decision_identity: decisionIdentity,
    fixture_synthetic: fixtureSynthetic,
    result_kind: resultKind,
    items: deepFreeze(items),
    injectable_payload_utf8_bytes: payloadBytes,
    injectable_payload_sha256: stableViewSha256Hex(viewMd),
  });
  const emittedDiagnostics = source.diagnostics.map((diagnostic) => deepFreeze({
    code: OUTPUT_DIAGNOSTIC_CODE,
    severity: OUTPUT_DIAGNOSTIC_SEVERITY,
    source_event_id: diagnostic.source_event_id,
    filter_stage: OUTPUT_EXCLUSION_FILTER_STAGE,
    reason_code: OUTPUT_EXCLUSION_REASON_CODE,
  }));
  const diagnostics = deepFreeze({
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_DIAGNOSTICS_SCHEMA,
    compile_key: compileKey,
    diagnostics: emittedDiagnostics,
  });
  const parity = deepFreeze({
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_PARITY_SCHEMA,
    compile_key: compileKey,
    source_conservation: {
      source_event_count: source.universe.length,
      source_event_ids_hash: stableViewJcsSha256Hex(source.universe),
      dispositions,
      dispositions_hash: stableViewJcsSha256Hex(dispositions),
      diagnostic_count: source.diagnostics.length,
      diagnostics_hash: stableViewJcsSha256Hex(emittedDiagnostics),
    },
    deterministic_render: {
      renderer: OUTPUT_RENDERER,
      item_count: items.length,
      items_hash: stableViewJcsSha256Hex(items),
      view_md_utf8_bytes: payloadBytes,
      view_md_sha256: stableViewSha256Hex(viewMd),
    },
    scope_lineage: {
      source_entry_count: source.entries.length,
      commitments: scopeLineage,
      commitments_hash: stableViewJcsSha256Hex(scopeLineage),
    },
    noninterference: {
      statement_keys_outside_view_items: 0,
      semantic_inference_operations: 0,
      external_authority_inputs: 0,
      source_statement_rewrites: 0,
    },
  });
  assertNoStatementKey(diagnostics, "diagnostics.json");
  assertNoStatementKey(parity, "parity.json");

  const preliminaryBytes: Record<string, string> = {
    "view.json": canonicalJson(view),
    "view.md": viewMd,
    "diagnostics.json": canonicalJson(diagnostics),
    "parity.json": canonicalJson(parity),
  };
  const artifactRows = MANIFEST_ARTIFACT_NAMES.map((name) => deepFreeze({
    name,
    bytes: Buffer.byteLength(preliminaryBytes[name]!),
    sha256: stableViewSha256Hex(preliminaryBytes[name]!),
  }));
  const sourceClosure = deepFreeze({
    source_event_count: source.universe.length,
    source_event_ids_hash: stableViewJcsSha256Hex(source.universe),
    dispositions_hash: stableViewJcsSha256Hex(dispositions),
    diagnostic_count: source.diagnostics.length,
    diagnostics_hash: stableViewJcsSha256Hex(emittedDiagnostics),
  });
  const manifestBase = deepFreeze(buildPropositionPolicyStableViewCompilerManifestBase({
    compileKey,
    sourceBundleHash: input.source_bundle_hash,
    compileProfileHash: profile.profile_hash,
    decisionIdentity,
    fixtureSynthetic,
    resultKind,
    artifactRows,
    sourceClosure,
  }));
  assertNoStatementKey(manifestBase, "manifest.json");
  const manifest = deepFreeze({ ...manifestBase, manifest_hash: stableViewJcsSha256Hex(manifestBase) });
  validateStableNonViewDocument("diagnostics", diagnostics);
  validateStableNonViewDocument("parity", parity);
  validateStableNonViewDocument("manifest", manifest);
  const artifacts = deepFreeze({
    ...preliminaryBytes,
    "manifest.json": canonicalJson(manifest),
  }) as unknown as StableArtifactSet;
  assertAllFive(artifacts);
  assertArtifactStatementIsolation(source, artifacts, { view, diagnostics, parity, manifest });
  assertHashFields({ view, diagnostics, parity, manifest }, "stable_artifacts", false);
  if (resultKind === "ready_empty" && (items.length !== 0 || payloadBytes !== 0 || viewMd !== "")) fail("ready_empty_invalid", "ready_empty must contain no item or payload byte");
  return deepFreeze({
    ...correlation,
    pipeline: "completed" as const,
    outcome_code: resultKind,
    compile_key: compileKey,
    manifest_hash: manifest.manifest_hash,
    source_bundle_hash: input.source_bundle_hash,
    compile_profile_hash: profile.profile_hash,
    decision_identity: decisionIdentity,
    real_or_fixture: input.mode,
    artifacts,
  });
}

function buildItem(entries: readonly ValidatedEntry[], identity: string): Record<string, unknown> {
  const orderedEntries = [...entries].sort((left, right) => compareCodeUnits(left.source_event_id, right.source_event_id));
  const sourceEventIds = orderedEntries.map((entry) => entry.source_event_id);
  const sourceLineage = orderedEntries.map((entry) => ({ source_event_id: entry.source_event_id, lineage_event_ids: entry.lineage_event_ids }));
  const sourceProvenance = orderedEntries.map((entry) => ({
    source_event_id: entry.source_event_id,
    source_body_sha256: entry.source_body_sha256,
    statement_sha256: entry.statement_sha256,
    scope_sha256: entry.scope_sha256,
    lineage_event_ids: entry.lineage_event_ids,
    lifecycle_disposition: entry.lifecycle.disposition,
    lifecycle_activation: entry.lifecycle.activation,
    lifecycle_terminal_event_id: entry.lifecycle.terminal_event_id,
  }));
  const itemBase = {
    item_id: stableViewJcsSha256Hex({ identity, source_event_ids: sourceEventIds }),
    statement: orderedEntries[0]!.statement,
    statement_sha256: orderedEntries[0]!.statement_sha256,
    scope: deepClone(orderedEntries[0]!.scope),
    scope_sha256: orderedEntries[0]!.scope_sha256,
    source_event_ids: sourceEventIds,
    source_lineage: sourceLineage,
    source_provenance: sourceProvenance,
  };
  return deepFreeze({ ...itemBase, item_payload_sha256: stableViewJcsSha256Hex(itemBase) });
}

export function validateStableArtifactSet(request: StableViewCompileRequest, artifacts: unknown): StableArtifactSet {
  const supplied = asRecord(artifacts, "artifact_set");
  exactKeys(supplied, STABLE_ARTIFACT_NAMES, "artifact_set");
  for (const name of STABLE_ARTIFACT_NAMES) if (typeof supplied[name] !== "string") fail("artifact_bytes_invalid", "every stable artifact must be supplied as exact UTF-8 bytes", { name });
  const view = parseCanonicalJson(String(supplied["view.json"]), "view.json");
  const diagnostics = parseCanonicalJson(String(supplied["diagnostics.json"]), "diagnostics.json");
  const parity = parseCanonicalJson(String(supplied["parity.json"]), "parity.json");
  const manifest = parseCanonicalJson(String(supplied["manifest.json"]), "manifest.json");
  const source = validateSource(request.source, request.mode);
  assertNoStatementKey(diagnostics, "diagnostics.json");
  assertNoStatementKey(parity, "parity.json");
  assertNoStatementKey(manifest, "manifest.json");
  validateStableNonViewDocument("diagnostics", diagnostics);
  validateStableNonViewDocument("parity", parity);
  validateStableNonViewDocument("manifest", manifest);
  assertArtifactStatementIsolation(source, supplied as unknown as StableArtifactSet, { view, diagnostics, parity, manifest });
  assertHashFields({ view, diagnostics, parity, manifest }, "stable_artifacts", false);
  const viewRecord = asRecord(view, "view.json");
  const items = array(viewRecord.items, "view.json.items");
  for (const [index, itemValue] of items.entries()) {
    const item = asRecord(itemValue, `view.json.items[${index}]`);
    if (typeof item.statement !== "string") fail("view_statement_invalid", "view item statement is missing", { index });
  }
  const expected = evaluatePropositionPolicyStableView(request);
  if (expected.pipeline !== "completed" || !expected.artifacts) fail("artifact_validation_request_not_completed", "artifact validation requires an accepted completed request");
  for (const name of STABLE_ARTIFACT_NAMES) if (supplied[name] !== expected.artifacts[name]) fail("artifact_semantic_mismatch", "artifact differs from deterministic reconstruction", { name });
  return expected.artifacts;
}

export function buildStableViewReceipts(result: StableViewEvaluation, metadata: {
  requested_at_utc: string;
  completed_at_utc: string;
  observed_at_utc: string;
}): Readonly<StableViewReceiptSet> {
  if (result.pipeline === "idle") fail("receipt_for_no_request", "idle observations do not have request or outcome receipts");
  assertSha256(result.request_id, "evaluation.request_id");
  assertSha256(result.request_raw_sha256, "evaluation.request_raw_sha256");
  if (result.request_id !== result.request_raw_sha256 || !Number.isSafeInteger(result.request_raw_utf8_bytes) || Number(result.request_raw_utf8_bytes) < 2) {
    fail("request_correlation_invalid", "evaluation lacks a canonical raw-request correlation identity");
  }
  const requested = assertUtcTimestamp(metadata.requested_at_utc, "metadata.requested_at_utc");
  const completed = assertUtcTimestamp(metadata.completed_at_utc, "metadata.completed_at_utc");
  const observed = assertUtcTimestamp(metadata.observed_at_utc, "metadata.observed_at_utc");
  if (requested > completed || completed > observed) fail("receipt_timestamp_order_invalid", "receipt timestamps are not requested <= completed <= observed");
  const requestBase = {
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_REQUEST_RECEIPT_SCHEMA,
    request_id: result.request_id,
    request_raw_utf8_bytes: result.request_raw_utf8_bytes,
    request_raw_sha256: result.request_raw_sha256,
    requested_at_unix_ms: requested,
    source_bundle_hash: result.source_bundle_hash,
    compile_profile_hash: result.compile_profile_hash,
    decision_identity: result.decision_identity,
    real_or_fixture: result.real_or_fixture,
  };
  const requestReceipt = deepFreeze({ ...requestBase, receipt_hash: stableViewJcsSha256Hex(requestBase) });
  const outcomeBase = {
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_OUTCOME_RECEIPT_SCHEMA,
    request_id: result.request_id,
    pipeline: result.pipeline,
    outcome_code: result.outcome_code,
    compile_key: result.pipeline === "completed" ? result.compile_key : null,
    manifest_hash: result.pipeline === "completed" ? result.manifest_hash : null,
    completed_at_unix_ms: completed,
  };
  const outcomeReceipt = deepFreeze({ ...outcomeBase, receipt_hash: stableViewJcsSha256Hex(outcomeBase) });
  const observation = buildStableViewObservation(result, {
    observed_at_utc: metadata.observed_at_utc,
    request_receipt_hash: String(requestReceipt.receipt_hash),
    outcome_receipt_hash: String(outcomeReceipt.receipt_hash),
  });
  const receipts = deepFreeze({ request_receipt: requestReceipt, outcome_receipt: outcomeReceipt, observation });
  validateStableNonViewDocument("request_receipt", requestReceipt);
  validateStableNonViewDocument("outcome_receipt", outcomeReceipt);
  validateStableNonViewDocument("observation", observation);
  validateStableViewReceiptSet(result, receipts);
  return receipts;
}

export function buildStableViewObservation(result: StableViewEvaluation, metadata: {
  observed_at_utc: string;
  request_receipt_hash?: string;
  outcome_receipt_hash?: string;
}): Readonly<Record<string, unknown>> {
  assertUtcTimestamp(metadata.observed_at_utc, "metadata.observed_at_utc");
  const idle = result.pipeline === "idle";
  if (!idle) {
    assertSha256(metadata.request_receipt_hash, "metadata.request_receipt_hash");
    assertSha256(metadata.outcome_receipt_hash, "metadata.outcome_receipt_hash");
  } else if (metadata.request_receipt_hash !== undefined || metadata.outcome_receipt_hash !== undefined) {
    fail("idle_receipt_correlation_invalid", "idle observation cannot bind request receipts");
  }
  const tuple = tupleForPipeline(result.pipeline);
  const observation = deepFreeze({
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_OBSERVATION_SCHEMA,
    observed_at_unix_ms: assertUtcTimestamp(metadata.observed_at_utc, "metadata.observed_at_utc"),
    request_id: result.request_id,
    request_receipt_hash: idle ? null : metadata.request_receipt_hash,
    outcome_receipt_hash: idle ? null : metadata.outcome_receipt_hash,
    pipeline: tuple.pipeline,
    freshness: tuple.freshness,
    selection: tuple.selection,
    health: tuple.health,
    compile_key: result.pipeline === "completed" ? result.compile_key : null,
    manifest_hash: result.pipeline === "completed" ? result.manifest_hash : null,
    injection_authority: false,
  });
  validateStableViewObservation(observation, {
    evaluation: result,
    request_receipt_hash: idle ? null : String(metadata.request_receipt_hash),
    outcome_receipt_hash: idle ? null : String(metadata.outcome_receipt_hash),
  });
  return observation;
}

export function validateStableViewObservation(input: unknown, binding: {
  evaluation: StableViewEvaluation;
  request_receipt_hash: string | null;
  outcome_receipt_hash: string | null;
}): void {
  validateStableNonViewDocument("observation", input);
  const observation = asRecord(input, "observation");
  exactKeys(observation, ["schema_version", "observed_at_unix_ms", "request_id", "request_receipt_hash", "outcome_receipt_hash", "pipeline", "freshness", "selection", "health", "compile_key", "manifest_hash", "injection_authority"], "observation");
  if (observation.schema_version !== PROPOSITION_POLICY_STABLE_VIEW_OBSERVATION_SCHEMA || observation.injection_authority !== false) fail("observation_identity_invalid", "observation identity or authority is invalid");
  assertUnixMilliseconds(observation.observed_at_unix_ms, "observation.observed_at_unix_ms");
  const tuple = { pipeline: observation.pipeline, freshness: observation.freshness, selection: observation.selection, health: observation.health };
  if (!LEGAL_TUPLES.some((legal) => stableViewCanonicalizeJcs(legal) === stableViewCanonicalizeJcs(tuple))) fail("observation_tuple_invalid", "observation is not one of the four exhaustive tuples");
  const expected = binding.evaluation;
  if (observation.pipeline !== expected.pipeline || observation.request_id !== expected.request_id
    || observation.request_receipt_hash !== binding.request_receipt_hash || observation.outcome_receipt_hash !== binding.outcome_receipt_hash) {
    fail("observation_correlation_mismatch", "observation does not bind the exact evaluation and receipt correlation");
  }
  const completed = observation.pipeline === "completed";
  if (completed) {
    assertSha256(observation.compile_key, "observation.compile_key");
    assertSha256(observation.manifest_hash, "observation.manifest_hash");
    if (observation.compile_key !== expected.compile_key || observation.manifest_hash !== expected.manifest_hash) fail("observation_artifact_identity_invalid", "completed observation differs from exact evaluation artifacts");
  } else if (observation.compile_key !== null || observation.manifest_hash !== null) {
    fail("observation_artifact_identity_invalid", "non-completed observations cannot carry stable artifact identity");
  }
  if (completed || expected.pipeline === "queued" || expected.pipeline === "rejected") {
    assertSha256(observation.request_id, "observation.request_id");
    assertSha256(observation.request_receipt_hash, "observation.request_receipt_hash");
    assertSha256(observation.outcome_receipt_hash, "observation.outcome_receipt_hash");
  } else if (observation.request_id !== null || observation.request_receipt_hash !== null || observation.outcome_receipt_hash !== null) {
    fail("idle_receipt_correlation_invalid", "idle observation carries request correlation");
  }
}

export function validateStableViewReceiptSet(result: StableViewEvaluation, input: unknown): void {
  if (result.pipeline === "idle") fail("receipt_for_no_request", "idle evaluation cannot have a receipt set");
  const receipts = asRecord(input, "receipts");
  exactKeys(receipts, ["request_receipt", "outcome_receipt", "observation"], "receipts");
  const request = asRecord(receipts.request_receipt, "request_receipt");
  const outcome = asRecord(receipts.outcome_receipt, "outcome_receipt");
  validateStableNonViewDocument("request_receipt", request);
  validateStableNonViewDocument("outcome_receipt", outcome);
  exactKeys(request, ["schema_version", "request_id", "request_raw_utf8_bytes", "request_raw_sha256", "requested_at_unix_ms", "source_bundle_hash", "compile_profile_hash", "decision_identity", "real_or_fixture", "receipt_hash"], "request_receipt");
  exactKeys(outcome, ["schema_version", "request_id", "pipeline", "outcome_code", "compile_key", "manifest_hash", "completed_at_unix_ms", "receipt_hash"], "outcome_receipt");
  if (request.schema_version !== PROPOSITION_POLICY_STABLE_VIEW_REQUEST_RECEIPT_SCHEMA || outcome.schema_version !== PROPOSITION_POLICY_STABLE_VIEW_OUTCOME_RECEIPT_SCHEMA) fail("receipt_schema_invalid", "receipt schema identity differs");
  for (const [value, at] of [[request.request_id, "request_receipt.request_id"], [request.request_raw_sha256, "request_receipt.request_raw_sha256"], [request.receipt_hash, "request_receipt.receipt_hash"], [outcome.request_id, "outcome_receipt.request_id"], [outcome.receipt_hash, "outcome_receipt.receipt_hash"]] as const) assertSha256(value, at);
  for (const [value, at] of [[request.source_bundle_hash, "request_receipt.source_bundle_hash"], [request.compile_profile_hash, "request_receipt.compile_profile_hash"]] as const) if (value !== null) assertSha256(value, at);
  assertUnixMilliseconds(request.requested_at_unix_ms, "request_receipt.requested_at_unix_ms");
  assertUnixMilliseconds(outcome.completed_at_unix_ms, "outcome_receipt.completed_at_unix_ms");
  if (request.request_id !== result.request_id || request.request_raw_sha256 !== result.request_raw_sha256 || request.request_id !== request.request_raw_sha256
    || request.request_raw_utf8_bytes !== result.request_raw_utf8_bytes || request.source_bundle_hash !== result.source_bundle_hash
    || request.compile_profile_hash !== result.compile_profile_hash || request.decision_identity !== result.decision_identity
    || request.real_or_fixture !== result.real_or_fixture || outcome.request_id !== result.request_id
    || outcome.pipeline !== result.pipeline || outcome.outcome_code !== result.outcome_code) {
    fail("receipt_correlation_mismatch", "receipt identity differs from the canonical request evaluation");
  }
  if (!Number.isSafeInteger(request.request_raw_utf8_bytes) || Number(request.request_raw_utf8_bytes) < 2) fail("receipt_request_size_invalid", "request raw canonical byte size is invalid");
  const requestBase = { ...request };
  delete requestBase.receipt_hash;
  const outcomeBase = { ...outcome };
  delete outcomeBase.receipt_hash;
  if (stableViewJcsSha256Hex(requestBase) !== request.receipt_hash || stableViewJcsSha256Hex(outcomeBase) !== outcome.receipt_hash) fail("receipt_hash_mismatch", "receipt self-hash differs from its exact canonical preimage");
  if (result.pipeline === "completed") {
    if (outcome.compile_key !== result.compile_key || outcome.manifest_hash !== result.manifest_hash) fail("receipt_artifact_identity_mismatch", "completed outcome differs from stable artifacts");
    assertSha256(outcome.compile_key, "outcome_receipt.compile_key");
    assertSha256(outcome.manifest_hash, "outcome_receipt.manifest_hash");
  } else if (outcome.compile_key !== null || outcome.manifest_hash !== null) fail("receipt_artifact_identity_mismatch", "non-completed outcome carries stable artifact identity");
  validateStableViewObservation(receipts.observation, {
    evaluation: result,
    request_receipt_hash: String(request.receipt_hash),
    outcome_receipt_hash: String(outcome.receipt_hash),
  });
  const observation = asRecord(receipts.observation, "observation");
  if (Number(request.requested_at_unix_ms) > Number(outcome.completed_at_unix_ms)
    || Number(outcome.completed_at_unix_ms) > Number(observation.observed_at_unix_ms)) {
    fail("receipt_timestamp_order_invalid", "receipt timestamps are not requested <= completed <= observed");
  }
}

export function stableViewLegalObservationTuples(): readonly Readonly<Record<string, string>>[] {
  return LEGAL_TUPLES;
}

function idleEvaluation(): StableViewEvaluation {
  return deepFreeze({
    request_id: null,
    request_raw_sha256: null,
    request_raw_utf8_bytes: null,
    pipeline: "idle" as const,
    outcome_code: "no_request",
    compile_key: null,
    manifest_hash: null,
    source_bundle_hash: null,
    compile_profile_hash: null,
    decision_identity: null,
    real_or_fixture: null,
    artifacts: null,
  });
}

function queuedEvaluation(input: StableViewCompileRequest, profile: StableViewCompileProfile, correlation: RequestCorrelation): StableViewEvaluation {
  return deepFreeze({
    ...correlation,
    pipeline: "queued" as const,
    outcome_code: "production_decision_required",
    compile_key: null,
    manifest_hash: null,
    source_bundle_hash: input.source_bundle_hash,
    compile_profile_hash: profile.profile_hash,
    decision_identity: null,
    real_or_fixture: "real" as const,
    artifacts: null,
  });
}

function tupleForPipeline(pipeline: StablePipeline): typeof LEGAL_TUPLES[number] {
  const tuple = LEGAL_TUPLES.find((candidate) => candidate.pipeline === pipeline);
  if (!tuple) fail("pipeline_invalid", "pipeline has no observation tuple", { pipeline });
  return tuple;
}

function assertAllFive(artifacts: StableArtifactSet): void {
  exactKeys(artifacts as unknown as Record<string, unknown>, STABLE_ARTIFACT_NAMES, "artifact_set");
}

function parseCanonicalJson(raw: string, at: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("artifact_json_invalid", `${at} is not JSON`); }
  if (`${stableViewCanonicalizeJcs(parsed)}\n` !== raw) fail("artifact_jcs_invalid", `${at} is not exact JCS plus LF`);
  return parsed;
}

function canonicalJson(value: unknown): string {
  return `${stableViewCanonicalizeJcs(value)}\n`;
}

export type StableNonViewDocumentKind = "diagnostics" | "parity" | "manifest" | "request_receipt" | "outcome_receipt" | "observation";

export function validateStableNonViewDocument(kind: StableNonViewDocumentKind, input: unknown): void {
  assertStableNonViewShape(kind, input);
  const hashPaths = new Set([
    "diagnostics:compile_key", "diagnostics:diagnostics[].source_event_id",
    "parity:compile_key", "parity:source_conservation.source_event_ids_hash", "parity:source_conservation.dispositions[].source_event_id",
    "parity:source_conservation.dispositions[].item_id", "parity:source_conservation.dispositions_hash", "parity:source_conservation.diagnostics_hash",
    "parity:deterministic_render.items_hash", "parity:deterministic_render.view_md_sha256", "parity:scope_lineage.commitments[].source_event_id",
    "parity:scope_lineage.commitments[].source_body_sha256", "parity:scope_lineage.commitments[].statement_sha256",
    "parity:scope_lineage.commitments[].item_id", "parity:scope_lineage.commitments[].scope_sha256",
    "parity:scope_lineage.commitments[].lineage_event_ids_hash", "parity:scope_lineage.commitments[].lifecycle_terminal_event_id",
    "parity:scope_lineage.commitments_hash",
    "manifest:compile_key", "manifest:source_bundle_hash", "manifest:compile_profile_hash", "manifest:artifact_rows[].sha256",
    "manifest:source_closure.source_event_ids_hash", "manifest:source_closure.dispositions_hash", "manifest:source_closure.diagnostics_hash",
    "manifest:manifest_hash", "request_receipt:request_id", "request_receipt:request_raw_sha256", "request_receipt:source_bundle_hash",
    "request_receipt:compile_profile_hash", "request_receipt:receipt_hash", "outcome_receipt:request_id", "outcome_receipt:compile_key",
    "outcome_receipt:manifest_hash", "outcome_receipt:receipt_hash", "observation:request_id", "observation:request_receipt_hash",
    "observation:outcome_receipt_hash", "observation:compile_key", "observation:manifest_hash",
  ]);
  const fixed = new Map<string, ReadonlySet<string>>([
    ["diagnostics:schema_version", new Set([PROPOSITION_POLICY_STABLE_VIEW_DIAGNOSTICS_SCHEMA])],
    ["diagnostics:diagnostics[].code", new Set([OUTPUT_DIAGNOSTIC_CODE])],
    ["diagnostics:diagnostics[].severity", new Set([OUTPUT_DIAGNOSTIC_SEVERITY])],
    ["diagnostics:diagnostics[].filter_stage", new Set([OUTPUT_EXCLUSION_FILTER_STAGE])],
    ["diagnostics:diagnostics[].reason_code", new Set([OUTPUT_EXCLUSION_REASON_CODE])],
    ["parity:schema_version", new Set([PROPOSITION_POLICY_STABLE_VIEW_PARITY_SCHEMA])],
    ["parity:source_conservation.dispositions[].disposition", new Set(["included", "merged", "excluded"])],
    ["parity:source_conservation.dispositions[].filter_stage", new Set([OUTPUT_EXCLUSION_FILTER_STAGE])],
    ["parity:source_conservation.dispositions[].reason_code", new Set([OUTPUT_EXCLUSION_REASON_CODE])],
    ["parity:deterministic_render.renderer", new Set([OUTPUT_RENDERER])],
    ["parity:scope_lineage.commitments[].lifecycle_disposition", new Set(["active"])],
    ["parity:scope_lineage.commitments[].lifecycle_activation", new Set(["original", "reactivated"])],
    ["manifest:schema_version", new Set([PROPOSITION_POLICY_STABLE_VIEW_MANIFEST_SCHEMA])],
    ["manifest:canonicalization", new Set(["RFC8785-JCS"])],
    ["manifest:hash_algorithm", new Set(["sha256"])],
    ["manifest:authority", new Set([OUTPUT_AUTHORITY])],
    ["manifest:result_kind", new Set(["ready_empty", "ready_nonempty"])],
    ["manifest:artifact_rows[].name", new Set(MANIFEST_ARTIFACT_NAMES)],
    ["manifest:manifest_hash_scope", new Set([MANIFEST_HASH_SCOPE])],
    ["request_receipt:schema_version", new Set([PROPOSITION_POLICY_STABLE_VIEW_REQUEST_RECEIPT_SCHEMA])],
    ["request_receipt:real_or_fixture", new Set(["real", "fixture"])],
    ["outcome_receipt:schema_version", new Set([PROPOSITION_POLICY_STABLE_VIEW_OUTCOME_RECEIPT_SCHEMA])],
    ["outcome_receipt:pipeline", new Set(["completed", "queued", "rejected"])],
    ["outcome_receipt:outcome_code", new Set(["ready_empty", "ready_nonempty", "production_decision_required", ...REJECTED_OUTCOME_CODES])],
    ["observation:schema_version", new Set([PROPOSITION_POLICY_STABLE_VIEW_OBSERVATION_SCHEMA])],
    ["observation:pipeline", new Set(["idle", "completed", "queued", "rejected"])],
    ["observation:freshness", new Set(["fresh", "unknown"])],
    ["observation:selection", new Set(["current", "none"])],
    ["observation:health", new Set(["ok", "blocked"])],
  ]);
  const pathKey = (segments: readonly (string | number)[]): string => segments.map((segment, index) => typeof segment === "number" ? "[]" : `${index > 0 ? "." : ""}${segment}`).join("");
  const walk = (value: unknown, segments: readonly (string | number)[]): void => {
    if (typeof value === "string") {
      const rule = `${kind}:${pathKey(segments)}`;
      if (hashPaths.has(rule)) {
        if (!SHA256_PATTERN.test(value)) fail("non_view_string_not_closed", "non-view identity is not exact lowercase SHA-256", { kind, path: pathKey(segments) });
        return;
      }
      if (segments[segments.length - 1] === "decision_identity") {
        if (value !== PROPOSITION_POLICY_STABLE_VIEW_EMPTY_DECISION && !SHA256_PATTERN.test(value)) fail("non_view_string_not_closed", "decision identity is neither the fixed empty sentinel nor exact lowercase SHA-256", { kind, path: pathKey(segments) });
        return;
      }
      const values = fixed.get(rule);
      if (!values?.has(value)) fail("non_view_string_not_closed", "non-view string is outside its exact compiler-owned vocabulary", { kind, path: pathKey(segments) });
      return;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) fail("non_view_scalar_invalid", "non-view numeric scalar must be a nonnegative safe-integer count", { kind, path: pathKey(segments) });
      return;
    }
    if (value === null || typeof value === "boolean") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, [...segments, index]));
      return;
    }
    if (!isRecord(value)) fail("non_view_scalar_invalid", "non-view document contains an unsupported scalar", { kind, path: pathKey(segments) });
    for (const [key, child] of Object.entries(value)) walk(child, [...segments, key]);
  };
  walk(input, []);
}

function assertStableNonViewShape(kind: StableNonViewDocumentKind, input: unknown): void {
  const document = asRecord(input, kind);
  if (kind === "diagnostics") {
    exactKeys(document, ["schema_version", "compile_key", "diagnostics"], kind);
    array(document.diagnostics, `${kind}.diagnostics`).forEach((value, index) => exactKeys(asRecord(value, `${kind}.diagnostics[${index}]`), ["code", "severity", "source_event_id", "filter_stage", "reason_code"], `${kind}.diagnostics[${index}]`));
    return;
  }
  if (kind === "parity") {
    exactKeys(document, ["schema_version", "compile_key", "source_conservation", "deterministic_render", "scope_lineage", "noninterference"], kind);
    const conservation = asRecord(document.source_conservation, `${kind}.source_conservation`);
    exactKeys(conservation, ["source_event_count", "source_event_ids_hash", "dispositions", "dispositions_hash", "diagnostic_count", "diagnostics_hash"], `${kind}.source_conservation`);
    array(conservation.dispositions, `${kind}.source_conservation.dispositions`).forEach((value, index) => exactKeys(asRecord(value, `${kind}.source_conservation.dispositions[${index}]`), ["source_event_id", "disposition", "item_id", "filter_stage", "reason_code"], `${kind}.source_conservation.dispositions[${index}]`));
    exactKeys(asRecord(document.deterministic_render, `${kind}.deterministic_render`), ["renderer", "item_count", "items_hash", "view_md_utf8_bytes", "view_md_sha256"], `${kind}.deterministic_render`);
    const scopeLineage = asRecord(document.scope_lineage, `${kind}.scope_lineage`);
    exactKeys(scopeLineage, ["source_entry_count", "commitments", "commitments_hash"], `${kind}.scope_lineage`);
    array(scopeLineage.commitments, `${kind}.scope_lineage.commitments`).forEach((value, index) => exactKeys(asRecord(value, `${kind}.scope_lineage.commitments[${index}]`), ["source_event_id", "source_body_sha256", "statement_sha256", "item_id", "scope_sha256", "lineage_event_ids_hash", "lineage_event_count", "lifecycle_disposition", "lifecycle_activation", "lifecycle_terminal_event_id"], `${kind}.scope_lineage.commitments[${index}]`));
    exactKeys(asRecord(document.noninterference, `${kind}.noninterference`), ["statement_keys_outside_view_items", "semantic_inference_operations", "external_authority_inputs", "source_statement_rewrites"], `${kind}.noninterference`);
    return;
  }
  if (kind === "manifest") {
    exactKeys(document, ["schema_version", "canonicalization", "hash_algorithm", "authority", "compile_key", "source_bundle_hash", "compile_profile_hash", "decision_identity", "fixture_synthetic", "result_kind", "artifact_rows", "source_closure", "runtime_unreachability", "manifest_hash_scope", "manifest_hash"], kind);
    array(document.artifact_rows, `${kind}.artifact_rows`).forEach((value, index) => exactKeys(asRecord(value, `${kind}.artifact_rows[${index}]`), ["name", "bytes", "sha256"], `${kind}.artifact_rows[${index}]`));
    exactKeys(asRecord(document.source_closure, `${kind}.source_closure`), ["source_event_count", "source_event_ids_hash", "dispositions_hash", "diagnostic_count", "diagnostics_hash"], `${kind}.source_closure`);
    exactKeys(asRecord(document.runtime_unreachability, `${kind}.runtime_unreachability`), ["compiler_exports_injection_capability", "verification_required_before_preview_acceptance"], `${kind}.runtime_unreachability`);
    return;
  }
  if (kind === "request_receipt") {
    exactKeys(document, ["schema_version", "request_id", "request_raw_utf8_bytes", "request_raw_sha256", "requested_at_unix_ms", "source_bundle_hash", "compile_profile_hash", "decision_identity", "real_or_fixture", "receipt_hash"], kind);
    return;
  }
  if (kind === "outcome_receipt") {
    exactKeys(document, ["schema_version", "request_id", "pipeline", "outcome_code", "compile_key", "manifest_hash", "completed_at_unix_ms", "receipt_hash"], kind);
    return;
  }
  exactKeys(document, ["schema_version", "observed_at_unix_ms", "request_id", "request_receipt_hash", "outcome_receipt_hash", "pipeline", "freshness", "selection", "health", "compile_key", "manifest_hash", "injection_authority"], kind);
}

function assertNoForbiddenKeys(value: unknown, keys: readonly string[], at: string): void {
  const forbidden = new Set(keys.map((key) => key.toLowerCase()));
  const walk = (current: unknown, currentAt: string): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => walk(child, `${currentAt}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (forbidden.has(key.toLowerCase())) fail("forbidden_key", "recursively forbidden key encountered", { at: `${currentAt}.${key}`, key });
      walk(child, `${currentAt}.${key}`);
    }
  };
  walk(value, at);
}

function assertNoStatementKey(value: unknown, at: string): void {
  const walk = (current: unknown, currentAt: string): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => walk(child, `${currentAt}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (key.toLowerCase() === "statement") fail("statement_isolation_violation", "statement key exists outside view.json.items[]", { at: `${currentAt}.${key}` });
      walk(child, `${currentAt}.${key}`);
    }
  };
  walk(value, at);
}

function assertArtifactStatementIsolation(source: ValidatedSource, artifacts: StableArtifactSet, parsed: {
  view: unknown;
  diagnostics: unknown;
  parity: unknown;
  manifest: unknown;
}): void {
  const statements = source.entries.map((entry) => entry.statement);
  if (!statements.length) return;
  for (const [name, value] of [["diagnostics.json", parsed.diagnostics], ["parity.json", parsed.parity], ["manifest.json", parsed.manifest]] as const) {
    assertNoStatementContent(value, statements, name, false);
  }
  assertNoStatementContent(parsed.view, statements, "view.json", true);
  const expectedMd = source.entries.length === 0 ? "" : undefined;
  if (expectedMd === "" && artifacts["view.md"] !== "") fail("statement_isolation_violation", "ready_empty view.md is not byte empty");
}

function assertNoStatementContent(value: unknown, statements: readonly string[], at: string, allowViewStatements: boolean): void {
  const scanString = (candidate: string, currentAt: string): void => {
    for (const statement of statements) {
      if (candidate.includes(statement)) fail("statement_isolation_violation", "raw source statement content exists outside the allowed view field", { at: currentAt, source_statement_sha256: stableViewSha256Hex(statement) });
    }
  };
  const walk = (current: unknown, path: readonly (string | number)[]): void => {
    if (typeof current === "string") {
      scanString(current, `${at}.${path.join(".")}`);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((child, index) => walk(child, [...path, index]));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const allowed = allowViewStatements && path.length === 2 && path[0] === "items" && typeof path[1] === "number" && key === "statement";
      if (allowed) continue;
      scanString(key, `${at}.${[...path, key].join(".")}#key`);
      walk(child, [...path, key]);
    }
  };
  walk(value, []);
}

function assertHashFields(value: unknown, at: string, allowNull: boolean): void {
  const walk = (current: unknown, currentAt: string): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => walk(child, `${currentAt}[${index}]`));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const childAt = `${currentAt}.${key}`;
      if (key === "hash_algorithm") {
        if (child !== "sha256") fail("hash_algorithm_invalid", `${childAt} must be the explicit sha256 algorithm marker`);
      } else if (key.endsWith("_hash_scope")) {
        assertNonemptyString(child, childAt);
      } else if (key === "sha256" || key.endsWith("_sha256") || key.endsWith("_hash")) {
        if (child === null && allowNull) continue;
        assertSha256(child, childAt);
      }
      walk(child, childAt);
    }
  };
  walk(value, at);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("object_keys_invalid", `${at} has unexpected keys`, { actual, expected: wanted });
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) fail("object_expected", `${at} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("array_expected", `${at} must be an array`);
  return value;
}

function stringArray(value: unknown, at: string, options: { allowEmpty?: boolean } = {}): readonly string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item)) fail("string_array_invalid", `${at} must be an array of nonempty strings`);
  return Object.freeze([...value] as string[]);
}

function validateP2aFacetsShape(value: unknown, at: string): void {
  const facets = asRecord(value, at);
  exactKeys(facets, ["confidence", "consumer_hints", "contestability", "lineage", "maturity", "provenance_authority", "sensitivity", "spatial_scope", "temporal_horizon", "trigger"], at);
  asRecord(facets.spatial_scope, `${at}.spatial_scope`);
}

function runtimeScopeIsRepresentable(value: Readonly<Record<string, unknown>>): boolean {
  return (value.scope_level === "global" && value.project_id === null && value.domain === null)
    || (value.scope_level === "project" && typeof value.project_id === "string" && value.project_id.length > 0 && value.domain === null);
}

function validateRecordSelfHash(record: Record<string, unknown>, at: string): void {
  assertSha256(record.record_hash, `${at}.record_hash`);
  const base = { ...record };
  delete base.record_hash;
  if (stableViewJcsSha256Hex(base) !== record.record_hash) fail("real_source_record_hash_mismatch", `${at} record self-hash differs`);
}

function sortedHashArray(value: unknown, at: string, allowEmpty: boolean): readonly string[] {
  const values = stringArray(value, at, { allowEmpty });
  for (const [index, item] of values.entries()) assertSha256(item, `${at}[${index}]`);
  assertSortedUnique(values, at, { allowEmpty });
  return values;
}

function assertSha256(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("sha256_invalid", `${at} must be lowercase SHA-256`);
}

function assertNonemptyString(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !value.length) fail("string_invalid", `${at} must be a nonempty string`);
}

function assertUtcTimestamp(value: unknown, at: string): number {
  if (typeof value !== "string") fail("timestamp_invalid", `${at} must be an exact UTC ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail("timestamp_invalid", `${at} must be an exact UTC ISO timestamp`);
  return milliseconds;
}

function assertUnixMilliseconds(value: unknown, at: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("timestamp_invalid", `${at} must be a nonnegative safe-integer Unix-millisecond count`);
}

function assertUnique(values: readonly string[], at: string): void {
  if (new Set(values).size !== values.length) fail("duplicate_value", `${at} contains duplicate values`);
}

function assertSortedUnique(values: readonly string[], at: string, options: { allowEmpty?: boolean } = {}): void {
  if ((!options.allowEmpty && values.length === 0) || new Set(values).size !== values.length || values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1]!, value) >= 0)) fail("sorted_unique_invalid", `${at} must be sorted unique`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareDiagnostics(left: ValidatedDiagnostic, right: ValidatedDiagnostic): number {
  return compareCodeUnits(stableViewCanonicalizeJcs(left), stableViewCanonicalizeJcs(right));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepClone<T>(value: T): T {
  return JSON.parse(stableViewCanonicalizeJcs(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionPolicyStableViewError(code, message, detail);
}
