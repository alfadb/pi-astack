import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import { loadL1SchemaRegistry, scanWholeL1Validated, validateL1WritePreflight } from "./l1-schema-registry";
import { jcsSha256Hex, sha256Hex } from "./jcs";
import {
  PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID,
  PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER,
  durableAppendFixedProductionPropositionEvidence,
  prepareFixedProductionPropositionEvidenceTuple,
} from "./proposition-evidence-writer";
import {
  PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
  publishPropositionKnowledgeShadow,
  readLatestPropositionKnowledgeShadow,
} from "./proposition-knowledge-shadow";
import {
  PROPOSITION_P1B_HARD_ABRAIN_REALPATH,
  PROPOSITION_P1B_PREVIEW_DOSSIER_RELATIVE_PATH,
  PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA,
  selfHashPropositionP1bPreviewDossier,
  type PropositionP1bPreviewDossier,
} from "./proposition-p1b-production-preview";
import {
  PROPOSITION_P1B_ATTESTATION_LINE,
  PROPOSITION_P1B_SESSION_ID,
  type TranscriptMessageBinding,
  verifyTrustedCurrentSessionUserMessage,
} from "./proposition-p1b-transcript";

export const PROPOSITION_P1B_RATIFICATION_RECORD_SCHEMA = "proposition-p1b-production-ratification-record/v1" as const;
export const PROPOSITION_P1B_EXECUTION_INTENT_SCHEMA = "proposition-p1b-production-execution-intent/v1" as const;
export const PROPOSITION_P1B_POST_EXECUTE_DOSSIER_SCHEMA = "proposition-p1b-production-post-execute-dossier/v1" as const;
export const PROPOSITION_P1B_EXECUTE_CLI = "scripts/execute-proposition-p1b-production-evidence.mjs" as const;
export const PROPOSITION_P1B_PREVIEW_DOSSIER_HASH = "74f87839b029208093f7c37d3705e9f8d008e8bbd81872e0f09f75b529b4b4b0" as const;
export const PROPOSITION_P1B_EXPECTED_EVENT_ID = "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585" as const;
export const PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256 = "872d68f57fc6f8c194c6afa428863c43b4f588c21dae7451d396a4b1c7f8d35b" as const;
export const PROPOSITION_P1B_EXPECTED_RELATIVE_PATH = "l1/events/sha256/be/ee/beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585.json" as const;
export const PROPOSITION_P1B_EXPECTED_REAL_TARGET_PATH = `${PROPOSITION_P1B_HARD_ABRAIN_REALPATH}/${PROPOSITION_P1B_EXPECTED_RELATIVE_PATH}` as const;
export const PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH = "7ec9bab9b741d078c917e6f8cd97cbb46d1f3a3c046e0f7f7bac1730edf0d139" as const;
export const PROPOSITION_P1B_EXPECTED_SHADOW_MANIFEST_SHA256 = "326744c6d59afc750681494f9947e01cdafcf4b081f6267607975d87158c4f54" as const;
export const PROPOSITION_P1B_EXPECTED_SHADOW_CARDS_SHA256 = "ae8602fc19f38376338c2b4350c048214a3f8981076512e55fcd513002aee45e" as const;
export const PROPOSITION_P1B_EXPECTED_SHADOW_DIAGNOSTICS_SHA256 = "2cc0d8df63e7aab5eb67233207750783ca9f0a0b14a989ac9db670920a5c23dc" as const;
export const PROPOSITION_P1B_EXPECTED_SHADOW_EXCLUSIONS_SHA256 = "288aa5e5f8093f78b0b71ea1e080c232fa0f0294a07048f67e0a72ec48afce2d" as const;
export const PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH = "docs/evidence/2026-07-13-adr0040-p1b-production-post-execute-dossier.json" as const;
export const PROPOSITION_P1B_RATIFICATION_RELATIVE_PATH = "docs/evidence/2026-07-13-adr0040-p1b-production-ratification-record.json" as const;
export const PROPOSITION_P1B_AUTHORIZATION_TEMPLATE_VERSION = "adr0040-p1b-exact-chinese-production-authorization/v2" as const;
export const PROPOSITION_P1B_AUTHORIZATION_NEGATION_TERMS = ["不授权", "拒绝", "不要", "取消", "撤回", "禁止", "no", "not", "deny", "reject", "revoke"] as const;
export const PROPOSITION_P1B_SYNTHETIC_AUTHORIZATION_TEXT = "SYNTHETIC ADR0040 P1b FIXED TUPLE SANDBOX ONLY" as const;

export interface PropositionP1bExecuteOptions {
  abrainHome: string;
  previewDossierPath: string;
  ratificationRecordPath: string;
  outputPath: string;
  repoRoot?: string;
  registryPath?: string;
  allowSyntheticRatificationForSandboxOnly?: boolean;
}

interface LoadedRatification {
  path: string;
  raw_sha256: string;
  record_hash: string;
  synthetic: boolean;
  transcript_evidence: Readonly<Record<string, unknown>> | null;
  record: Readonly<Record<string, unknown>>;
}

interface SnapshotSummary {
  schema_version: "proposition-p1b-protected-abrain-snapshot/v1";
  scope: "all_abrain_entries_excluding_only_declared_execution_targets";
  excluded_exact_rows: readonly string[];
  excluded_subtree: string;
  entry_count: number;
  file_count: number;
  directory_count: number;
  symlink_count: number;
  bytes: number;
  rows_hash: string;
  snapshot_hash: string;
}

export class PropositionP1bExecuteError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionP1bExecuteError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function buildPropositionP1bExactAuthorizationTemplate(repoRoot = path.resolve(__dirname, "..", "..")): string {
  const postPath = path.resolve(repoRoot, ...PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH.split("/"));
  return [
    "我明确授权ADR0040 P1b executor执行一次生产写入",
    `preview dossier hash=${PROPOSITION_P1B_PREVIEW_DOSSIER_HASH}`,
    `event id=${PROPOSITION_P1B_EXPECTED_EVENT_ID}`,
    `canonical envelope bytes sha256=${PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256}`,
    `real abrain=${PROPOSITION_P1B_HARD_ABRAIN_REALPATH}`,
    `target relative path=${PROPOSITION_P1B_EXPECTED_RELATIVE_PATH}`,
    `post-execute dossier path=${postPath}`,
    `post-execute dossier relative path=${PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH}`,
    `post-execute dossier relative path sha256=${sha256Hex(PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH)}`,
    `expected shadow bundle hash=${PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH}`,
    `expected shadow manifest sha256=${PROPOSITION_P1B_EXPECTED_SHADOW_MANIFEST_SHA256}`,
    `expected shadow cards sha256=${PROPOSITION_P1B_EXPECTED_SHADOW_CARDS_SHA256}`,
    `expected shadow diagnostics sha256=${PROPOSITION_P1B_EXPECTED_SHADOW_DIAGNOSTICS_SHA256}`,
    `expected shadow exclusions sha256=${PROPOSITION_P1B_EXPECTED_SHADOW_EXCLUSIONS_SHA256}`,
    "仅追加一个不可变L1 event并发布一个确定性shadow bundle及latest",
    "不写L2、不接入live consumer、不修改legacy authority",
    "除此之外不修改生产数据。",
  ].join("；");
}

export async function preflightPropositionP1bProductionExecute(options: PropositionP1bExecuteOptions): Promise<Readonly<Record<string, unknown>>> {
  if (options.allowSyntheticRatificationForSandboxOnly) throw notAuthorized("PRODUCTION_PREFLIGHT_REJECTS_SYNTHETIC", "production preflight never accepts synthetic ratification");
  const context = await prepareExecutionContext(options, "production");
  const target = await inspectTarget(context.tuple.target_path, context.tuple.canonical_envelope_json);
  if (!target.absent) throw failure("PROPOSITION_P1B_TARGET_EXISTS", "fresh production preflight requires the fixed target to be absent");
  const scan = await scanWholeL1Validated({ abrainHome: context.abrainHome, registry: context.registry });
  assertScanState(scan, { evidenceCount: 0 });
  const gate = await genericGate(context.abrainHome, context.tuple, context.registry);
  if (gate !== "L1_SCHEMA_WRITE_DISABLED") throw failure("PROPOSITION_P1B_GENERIC_GATE_DRIFT", "generic proposition write gate changed", { gate });
  return deepFreeze({
    schema_version: "proposition-p1b-production-execute-preflight/v1",
    ok: true,
    authorization: "fresh_exact_transcript_ratification_validated",
    preview_dossier_hash: PROPOSITION_P1B_PREVIEW_DOSSIER_HASH,
    ratification_record_hash: context.ratification.record_hash,
    event_id: context.tuple.event_id,
    canonical_envelope_bytes_sha256: context.tuple.canonical_envelope_bytes_sha256,
    target_path: context.tuple.target_path,
    target_absent: true,
    production_prestate: "exact_genesis_plus_zero_evidence",
    generic_write_gate: gate,
    expected_shadow_bundle_hash: PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH,
    output_path: context.outputPath,
    intent_path: context.intentPath,
  });
}

export async function executePropositionP1b(options: PropositionP1bExecuteOptions): Promise<Readonly<Record<string, unknown>>> {
  const mode = options.allowSyntheticRatificationForSandboxOnly ? "sandbox" : "production";
  const context = await prepareExecutionContext(options, mode);
  const targetState = await inspectTarget(context.tuple.target_path, context.tuple.canonical_envelope_json);
  const recovery = !targetState.absent;
  const beforeScan = await scanWholeL1Validated({ abrainHome: context.abrainHome, registry: context.registry });
  assertScanState(beforeScan, { evidenceCount: recovery ? 1 : 0, expectedEvidenceId: recovery ? context.tuple.event_id : undefined });
  const gateBefore = await genericGate(context.abrainHome, context.tuple, context.registry);
  if (gateBefore !== "L1_SCHEMA_WRITE_DISABLED") throw failure("PROPOSITION_P1B_GENERIC_GATE_DRIFT", "generic proposition write gate changed before execute", { gateBefore });
  const beforeProtected = await captureProtectedSnapshot(context.abrainHome, context.tuple.relative_path);

  await assertOptionalRegularFileNoSymlink(context.intentPath, "execution intent");
  const intent = buildExecutionIntent({
    mode,
    abrainHome: context.abrainHome,
    outputPath: context.outputPath,
    tuple: context.tuple,
    ratification: context.ratification,
    beforeProtected,
  });
  let intentStatus: DurableCreateStatus | "existing_valid";
  if (recovery) {
    await loadAndValidateExistingExecutionIntent(context.intentPath, intent, context.tuple.target_path);
    intentStatus = "existing_valid";
  } else {
    intentStatus = await durableAtomicCreateFile(context.intentPath, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
    if (intentStatus === "collision") throw failure("PROPOSITION_P1B_INTENT_COLLISION", "execution intent exists with different bytes", { intentPath: context.intentPath });
    if (intentStatus === "identical") await loadAndValidateExecutionIntent(context.intentPath, intent);
  }

  const append = await durableAppendFixedProductionPropositionEvidence({
    abrainHome: context.abrainHome,
    registryPath: context.registryPath,
    requireFreshPrestate: !recovery,
  });
  if (recovery && append.status !== "identical") throw failure("PROPOSITION_P1B_RECOVERY_TARGET_MISMATCH", "recovery target was not identical");
  const publication = await publishPropositionKnowledgeShadow({ abrainHome: context.abrainHome, repoRoot: context.repoRoot, registryPath: context.registryPath });
  assertExpectedShadow(publication.bundle);
  const latest = await readLatestPropositionKnowledgeShadow({ abrainHome: context.abrainHome });
  assertExpectedShadow(latest);

  const afterScan = await scanWholeL1Validated({ abrainHome: context.abrainHome, registry: context.registry });
  assertScanState(afterScan, { evidenceCount: 1, expectedEvidenceId: context.tuple.event_id });
  const gateAfter = await genericGate(context.abrainHome, context.tuple, context.registry);
  if (gateAfter !== "L1_SCHEMA_WRITE_DISABLED") throw failure("PROPOSITION_P1B_GENERIC_GATE_DRIFT", "generic proposition write gate changed after execute", { gateAfter });
  const afterProtected = await captureProtectedSnapshot(context.abrainHome, context.tuple.relative_path);
  if (beforeProtected.snapshot_hash !== afterProtected.snapshot_hash) {
    throw failure("PROPOSITION_P1B_PROTECTED_ABRAIN_MUTATION", "abrain changed outside the exact event target and proposition shadow prefix", { before: beforeProtected.snapshot_hash, after: afterProtected.snapshot_hash });
  }
  const rawTarget = await fs.readFile(context.tuple.target_path, "utf-8");
  if (rawTarget !== context.tuple.canonical_envelope_json) throw failure("PROPOSITION_P1B_READBACK_MISMATCH", "production evidence target bytes differ from preview");

  const dossierBase = {
    schema_version: PROPOSITION_P1B_POST_EXECUTE_DOSSIER_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this post-execute dossier object with dossier_hash omitted",
    mode,
    authorization: {
      ratification_record_path: context.ratification.path,
      ratification_record_hash: context.ratification.record_hash,
      ratification_record_raw_sha256: context.ratification.raw_sha256,
      synthetic_fixture: context.ratification.synthetic,
      transcript_evidence: context.ratification.transcript_evidence,
      exact_authorization_template_version: PROPOSITION_P1B_AUTHORIZATION_TEMPLATE_VERSION,
      no_env_or_force_bypass: true,
    },
    preview: {
      schema_version: PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA,
      dossier_hash: PROPOSITION_P1B_PREVIEW_DOSSIER_HASH,
      path: context.previewPath,
    },
    event: {
      event_id: context.tuple.event_id,
      relative_path: context.tuple.relative_path,
      target_path: context.tuple.target_path,
      canonical_envelope_bytes_sha256: context.tuple.canonical_envelope_bytes_sha256,
      readback_sha256: sha256Hex(rawTarget),
      readback_byte_identical: true,
      first_status: append.status,
      immediate_rerun_status: append.immediate_rerun_status,
    },
    execution_intent: {
      path: context.intentPath,
      intent_hash: intent.intent_hash,
      no_replace_status: intentStatus,
      intent_before_append: true,
      recovery,
    },
    shadow: {
      root_relative_path: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
      bundle_hash: latest.manifest.bundle_hash,
      bundle_status: publication.bundle_status,
      latest_status: publication.latest_status,
      manifest_exact_bytes_sha256: sha256Hex(latest.bytes["manifest.json"]),
      artifact_rows: latest.manifest.artifacts,
      card_count: latest.manifest.result.card_count,
      source_event_count: latest.manifest.source.proposition_event_count,
      source_evidence_count: latest.manifest.source.proposition_evidence_count,
      exact_one_expected_card: latest.cards.cards.length === 1 && latest.cards.cards[0]!.source_event_id === context.tuple.event_id,
    },
    invariants: {
      exactly_one_l1_event_added: !recovery ? afterScan.all.length === beforeScan.all.length + 1 : afterScan.all.length === beforeScan.all.length,
      production_proposition_count: afterScan.all.filter((record) => record.registration.domain === "proposition").length,
      production_evidence_count: afterScan.all.filter((record) => record.registration.envelope_schema === "proposition-evidence-envelope/v1").length,
      proposition_selected_count: afterScan.selected.filter((record) => record.registration.domain === "proposition").length,
      proposition_foldable_count: afterScan.foldable.filter((record) => record.registration.domain === "proposition").length,
      generic_write_gate_before: gateBefore,
      generic_write_gate_after: gateAfter,
      whole_abrain_protected_snapshot_before: beforeProtected,
      whole_abrain_protected_snapshot_after: afterProtected,
      protected_abrain_unchanged: beforeProtected.snapshot_hash === afterProtected.snapshot_hash,
      no_l2_write: true,
      no_live_consumer_wiring: true,
      no_legacy_mutation: true,
      no_registry_mutation: true,
    },
    output: {
      path: context.outputPath,
      repo_relative_path: mode === "production" ? PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH : null,
      write_policy: "durable_no_replace_after_all_abrain_postconditions",
    },
  };
  const dossier = deepFreeze({ ...dossierBase, dossier_hash: jcsSha256Hex(dossierBase) });
  validatePostExecuteDossier(dossier);
  return dossier;
}

export async function writePropositionP1bPostExecuteDossier(options: PropositionP1bExecuteOptions): Promise<Readonly<Record<string, unknown>>> {
  const mode = options.allowSyntheticRatificationForSandboxOnly ? "sandbox" : "production";
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const outputPath = await assertOutputPath(options.outputPath, repoRoot, mode);
  const existing = await fs.lstat(outputPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (existing) throw failure("PROPOSITION_P1B_POST_DOSSIER_EXISTS", "post-execute dossier output must be absent before execute", { outputPath });
  const dossier = await executePropositionP1b({ ...options, repoRoot, outputPath });
  const raw = `${JSON.stringify(dossier, null, 2)}\n`;
  const status = await durableAtomicCreateFile(outputPath, raw, { mode: 0o644 });
  if (status !== "created") throw failure("PROPOSITION_P1B_POST_DOSSIER_EXISTS", "post-execute dossier no-replace create did not create", { status });
  if (await fs.readFile(outputPath, "utf-8") !== raw) throw failure("PROPOSITION_P1B_POST_DOSSIER_READBACK_MISMATCH", "post-execute dossier readback mismatch");
  return dossier;
}

export function selfHashPropositionP1bRatificationRecord(record: Readonly<Record<string, unknown>>): string {
  const clone = JSON.parse(JSON.stringify(record));
  delete clone.record_hash;
  return jcsSha256Hex(clone);
}

export function validatePostExecuteDossier(input: Readonly<Record<string, unknown>>): void {
  if (input.schema_version !== PROPOSITION_P1B_POST_EXECUTE_DOSSIER_SCHEMA) throw failure("PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier schema mismatch");
  const claimed = input.dossier_hash;
  const clone = JSON.parse(JSON.stringify(input));
  delete clone.dossier_hash;
  if (typeof claimed !== "string" || jcsSha256Hex(clone) !== claimed) throw failure("PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier self-hash mismatch");
  const event = record(input.event, "PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier event section missing");
  if (event.event_id !== PROPOSITION_P1B_EXPECTED_EVENT_ID || event.canonical_envelope_bytes_sha256 !== PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256 || event.immediate_rerun_status !== "identical") throw failure("PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier event invariant mismatch");
  const shadow = record(input.shadow, "PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier shadow section missing");
  if (shadow.bundle_hash !== PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH || shadow.card_count !== 1 || shadow.exact_one_expected_card !== true) throw failure("PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier shadow invariant mismatch");
  const invariants = record(input.invariants, "PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier invariants missing");
  if (invariants.protected_abrain_unchanged !== true || invariants.generic_write_gate_after !== "L1_SCHEMA_WRITE_DISABLED" || invariants.no_l2_write !== true || invariants.no_live_consumer_wiring !== true || invariants.no_legacy_mutation !== true) throw failure("PROPOSITION_P1B_POST_DOSSIER_INVALID", "post dossier protected invariants failed");
}

async function prepareExecutionContext(options: PropositionP1bExecuteOptions, mode: "production" | "sandbox") {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const registryPath = path.resolve(options.registryPath ?? path.join(repoRoot, "schemas/l1-schema-role-registry.json"));
  const abrainHome = await assertExecutionAbrain(options.abrainHome, mode);
  const outputPath = await assertOutputPath(options.outputPath, repoRoot, mode);
  const previewPath = await loadAndValidatePreview(options.previewDossierPath, repoRoot);
  if (!options.ratificationRecordPath) throw notAuthorized("RATIFICATION_REQUIRED", "a fresh exact transcript ratification record is required");
  const tuple = await prepareFixedProductionPropositionEvidenceTuple({ abrainHome, registryPath });
  assertTupleConstants(tuple);
  const ratification = await loadAndValidateRatification(options.ratificationRecordPath, { mode, repoRoot, abrainHome, outputPath, tuple });
  const registry = loadL1SchemaRegistry(registryPath);
  const intentPath = executionIntentPath(outputPath, repoRoot, mode);
  return { repoRoot, registryPath, registry, abrainHome, outputPath, previewPath, tuple, ratification, intentPath };
}

async function loadAndValidatePreview(input: string, repoRoot: string): Promise<string> {
  const expected = path.resolve(repoRoot, ...PROPOSITION_P1B_PREVIEW_DOSSIER_RELATIVE_PATH.split("/"));
  if (path.resolve(input) !== expected) throw notAuthorized("PREVIEW_PATH_MISMATCH", "executor requires the exact P1b preview dossier path");
  await assertRequiredRegularFileNoSymlink(expected, "preview dossier");
  const parsed = JSON.parse(await fs.readFile(expected, "utf-8")) as PropositionP1bPreviewDossier;
  if (parsed.schema_version !== PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA || parsed.dossier_hash !== PROPOSITION_P1B_PREVIEW_DOSSIER_HASH || selfHashPropositionP1bPreviewDossier(parsed) !== PROPOSITION_P1B_PREVIEW_DOSSIER_HASH) throw notAuthorized("PREVIEW_HASH_MISMATCH", "preview dossier is not the exact ratifiable self-hashed artifact");
  if (parsed.tuple.event_id !== PROPOSITION_P1B_EXPECTED_EVENT_ID || parsed.tuple.canonical_envelope_bytes_sha256 !== PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256 || parsed.expected_post_shadow.bundle_hash !== PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH) throw notAuthorized("PREVIEW_BINDING_MISMATCH", "preview tuple or expected shadow binding drifted");
  return expected;
}

async function loadAndValidateRatification(input: string, context: {
  mode: "production" | "sandbox";
  repoRoot: string;
  abrainHome: string;
  outputPath: string;
  tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionEvidenceTuple>>;
}): Promise<LoadedRatification> {
  try {
    const resolved = path.resolve(input);
    if (context.mode === "production") {
      const expected = path.resolve(context.repoRoot, ...PROPOSITION_P1B_RATIFICATION_RELATIVE_PATH.split("/"));
      if (resolved !== expected) throw notAuthorized("RATIFICATION_PATH_MISMATCH", "production ratification record must use the fixed docs/evidence path");
    } else if (!isPathInside(await fs.realpath(os.tmpdir()), resolved)) {
      throw notAuthorized("SYNTHETIC_RATIFICATION_PATH_MISMATCH", "sandbox ratification record must be under the system temp root");
    }
    await assertRequiredRegularFileNoSymlink(resolved, "ratification record");
    const raw = await fs.readFile(resolved, "utf-8");
    const root = record(JSON.parse(raw), "NOT_AUTHORIZED", "ratification record must be an object");
    exactKeys(root, ["schema_version", "canonicalization", "hash_algorithm", "record_hash_scope", "record_hash", "record_kind", "synthetic_fixture", "preview", "post_execute_dossier", "authorization_evidence", "authorized_actions", "constraints"], "ratification record");
    exact(root.schema_version, PROPOSITION_P1B_RATIFICATION_RECORD_SCHEMA, "schema_version");
    exact(root.canonicalization, "RFC8785-JCS", "canonicalization");
    exact(root.hash_algorithm, "sha256", "hash_algorithm");
    exact(root.record_hash_scope, "sha256 over RFC8785-JCS UTF-8 bytes of this ratification record object with record_hash omitted", "record_hash_scope");
    assertSha(root.record_hash, "record_hash");
    if (selfHashPropositionP1bRatificationRecord(root) !== root.record_hash) throw notAuthorized("RATIFICATION_SELF_HASH_MISMATCH", "ratification record self-hash is invalid");
    validatePreviewBinding(root.preview);
    validateOutputBinding(root.post_execute_dossier, context.outputPath, context.repoRoot, context.mode);
    validateAuthorizedActions(root.authorized_actions, context);
    validateConstraints(root.constraints);

    const synthetic = root.synthetic_fixture === true;
    let transcriptEvidence: Readonly<Record<string, unknown>> | null = null;
    if (context.mode === "production") {
      if (synthetic || root.record_kind !== "real_user_ratification") throw notAuthorized("SYNTHETIC_RATIFICATION_REJECTED", "production executor accepts only a real user ratification");
      const evidence = record(root.authorization_evidence, "NOT_AUTHORIZED", "real authorization evidence must be an object");
      exactKeys(evidence, ["evidence_kind", "authorized_by", "transcript_evidence"], "authorization_evidence");
      exact(evidence.evidence_kind, "explicit_user_ratification", "authorization_evidence.evidence_kind");
      exact(evidence.authorized_by, "user", "authorization_evidence.authorized_by");
      const binding = validateTranscriptBinding(evidence.transcript_evidence);
      const verified = await verifyTrustedCurrentSessionUserMessage(binding, { requireFreshAfterAttestation: true });
      assertPropositionP1bExactAuthorizationText(verified.text, context.repoRoot);
      const { text: _text, ...safeEvidence } = verified;
      transcriptEvidence = deepFreeze({ ...safeEvidence, caller_supplied_raw_text: false, exact_template_verified_from_trusted_jsonl: true });
    } else {
      if (!synthetic || root.record_kind !== "synthetic_test_fixture") throw notAuthorized("SANDBOX_RATIFICATION_REQUIRED", "sandbox executor accepts only an explicit synthetic fixture record");
      const evidence = record(root.authorization_evidence, "NOT_AUTHORIZED", "synthetic authorization evidence must be an object");
      exactKeys(evidence, ["evidence_kind", "authorized_by", "authorization_text", "authorization_text_sha256"], "authorization_evidence");
      exact(evidence.evidence_kind, "synthetic_test_fixture", "authorization_evidence.evidence_kind");
      exact(evidence.authorized_by, "test_fixture", "authorization_evidence.authorized_by");
      exact(evidence.authorization_text, PROPOSITION_P1B_SYNTHETIC_AUTHORIZATION_TEXT, "authorization_evidence.authorization_text");
      exact(evidence.authorization_text_sha256, sha256Hex(PROPOSITION_P1B_SYNTHETIC_AUTHORIZATION_TEXT), "authorization_evidence.authorization_text_sha256");
    }
    return deepFreeze({ path: resolved, raw_sha256: sha256Hex(raw), record_hash: String(root.record_hash), synthetic, transcript_evidence: transcriptEvidence, record: root });
  } catch (err) {
    if (err instanceof PropositionP1bExecuteError && err.code === "NOT_AUTHORIZED") throw err;
    throw notAuthorized(errorCode(err), "ratification record failed closed validation", { error: errorMessage(err) });
  }
}

function validatePreviewBinding(input: unknown): void {
  const value = record(input, "NOT_AUTHORIZED", "preview binding must be an object");
  exactKeys(value, ["schema_version", "dossier_hash", "event_id", "canonical_envelope_bytes_sha256", "target_path", "relative_path", "expected_shadow_bundle_hash"], "preview binding");
  exact(value.schema_version, PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA, "preview.schema_version");
  exact(value.dossier_hash, PROPOSITION_P1B_PREVIEW_DOSSIER_HASH, "preview.dossier_hash");
  exact(value.event_id, PROPOSITION_P1B_EXPECTED_EVENT_ID, "preview.event_id");
  exact(value.canonical_envelope_bytes_sha256, PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256, "preview.canonical_envelope_bytes_sha256");
  exact(value.target_path, PROPOSITION_P1B_EXPECTED_REAL_TARGET_PATH, "preview.target_path");
  exact(value.relative_path, PROPOSITION_P1B_EXPECTED_RELATIVE_PATH, "preview.relative_path");
  exact(value.expected_shadow_bundle_hash, PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, "preview.expected_shadow_bundle_hash");
}

function validateOutputBinding(input: unknown, outputPath: string, repoRoot: string, mode: "production" | "sandbox"): void {
  const value = record(input, "NOT_AUTHORIZED", "post dossier output binding must be an object");
  exactKeys(value, ["path", "repo_relative_path", "repo_relative_path_sha256"], "post_execute_dossier");
  exact(value.path, outputPath, "post_execute_dossier.path");
  if (mode === "production") {
    exact(value.repo_relative_path, PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH, "post_execute_dossier.repo_relative_path");
    exact(value.repo_relative_path_sha256, sha256Hex(PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH), "post_execute_dossier.repo_relative_path_sha256");
    exact(outputPath, path.resolve(repoRoot, ...PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH.split("/")), "post_execute_dossier.path");
  } else {
    exact(value.repo_relative_path, null, "post_execute_dossier.repo_relative_path");
    exact(value.repo_relative_path_sha256, null, "post_execute_dossier.repo_relative_path_sha256");
  }
}

function validateAuthorizedActions(input: unknown, context: {
  mode: "production" | "sandbox";
  abrainHome: string;
  tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionEvidenceTuple>>;
}): void {
  if (!Array.isArray(input) || input.length !== 2) throw notAuthorized("AUTHORIZED_ACTION_CARDINALITY", "ratification must authorize exactly the fixed L1 append and deterministic shadow publication");
  const event = record(input[0], "NOT_AUTHORIZED", "first authorized action must be an object");
  exactKeys(event, ["action", "cardinality", "abrain_home", "target_path", "relative_path", "event_id", "canonical_envelope_bytes_sha256", "allowed_write_statuses"], "authorized_actions[0]");
  exact(event.action, "append_fixed_l1_event", "authorized_actions[0].action");
  exact(event.cardinality, "exactly_one", "authorized_actions[0].cardinality");
  exact(event.abrain_home, context.abrainHome, "authorized_actions[0].abrain_home");
  exact(event.target_path, context.tuple.target_path, "authorized_actions[0].target_path");
  exact(event.relative_path, PROPOSITION_P1B_EXPECTED_RELATIVE_PATH, "authorized_actions[0].relative_path");
  exact(event.event_id, PROPOSITION_P1B_EXPECTED_EVENT_ID, "authorized_actions[0].event_id");
  exact(event.canonical_envelope_bytes_sha256, PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256, "authorized_actions[0].canonical_envelope_bytes_sha256");
  if (JSON.stringify(event.allowed_write_statuses) !== JSON.stringify(["created", "identical"])) throw notAuthorized("AUTHORIZED_ACTION_INVALID", "fixed event allowed statuses must be created/identical");

  const shadow = record(input[1], "NOT_AUTHORIZED", "second authorized action must be an object");
  exactKeys(shadow, ["action", "cardinality", "root_relative_path", "bundle_hash", "manifest_sha256", "cards_sha256", "diagnostics_sha256", "exclusions_sha256", "latest_pointer"], "authorized_actions[1]");
  exact(shadow.action, "publish_deterministic_shadow_bundle", "authorized_actions[1].action");
  exact(shadow.cardinality, "exactly_one", "authorized_actions[1].cardinality");
  exact(shadow.root_relative_path, PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE, "authorized_actions[1].root_relative_path");
  exact(shadow.bundle_hash, PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, "authorized_actions[1].bundle_hash");
  exact(shadow.manifest_sha256, PROPOSITION_P1B_EXPECTED_SHADOW_MANIFEST_SHA256, "authorized_actions[1].manifest_sha256");
  exact(shadow.cards_sha256, PROPOSITION_P1B_EXPECTED_SHADOW_CARDS_SHA256, "authorized_actions[1].cards_sha256");
  exact(shadow.diagnostics_sha256, PROPOSITION_P1B_EXPECTED_SHADOW_DIAGNOSTICS_SHA256, "authorized_actions[1].diagnostics_sha256");
  exact(shadow.exclusions_sha256, PROPOSITION_P1B_EXPECTED_SHADOW_EXCLUSIONS_SHA256, "authorized_actions[1].exclusions_sha256");
  exact(shadow.latest_pointer, `${PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE}/latest`, "authorized_actions[1].latest_pointer");
}

function validateConstraints(input: unknown): void {
  const value = record(input, "NOT_AUTHORIZED", "ratification constraints must be an object");
  exactKeys(value, ["generic_write_gate_must_remain", "no_l2_write", "no_live_consumer_wiring", "no_legacy_mutation", "no_registry_mutation", "no_environment_or_force_bypass"], "constraints");
  exact(value.generic_write_gate_must_remain, "L1_SCHEMA_WRITE_DISABLED", "constraints.generic_write_gate_must_remain");
  for (const key of ["no_l2_write", "no_live_consumer_wiring", "no_legacy_mutation", "no_registry_mutation", "no_environment_or_force_bypass"]) exact(value[key], true, `constraints.${key}`);
}

function validateTranscriptBinding(input: unknown): TranscriptMessageBinding {
  const value = record(input, "NOT_AUTHORIZED", "transcript evidence must be an object");
  exactKeys(value, ["session_jsonl_path", "session_jsonl_relative_path", "session_id", "message_id", "message_parent_id", "message_line_number", "timestamp", "role", "text_sha256", "transcript_prefix_bytes", "transcript_prefix_sha256"], "transcript_evidence");
  if (value.session_id !== PROPOSITION_P1B_SESSION_ID || value.role !== "user" || typeof value.message_id !== "string" || value.message_line_number === PROPOSITION_P1B_ATTESTATION_LINE) throw notAuthorized("TRANSCRIPT_BINDING_INVALID", "ratification transcript binding is not a fresh current-session user message");
  return value as unknown as TranscriptMessageBinding;
}

export function assertPropositionP1bExactAuthorizationText(text: string, repoRoot = path.resolve(__dirname, "..", "..")): void {
  const normalized = normalizeAuthorizationText(text);
  const negation = findAuthorizationNegation(normalized);
  if (negation) throw notAuthorized("TRANSCRIPT_TEXT_NEGATED_AUTHORIZATION", "ratification text contains a negation or revocation term", { term: negation });
  const marker = "我明确授权ADR0040 P1b executor执行一次生产写入";
  if (countOccurrences(normalized, marker) > 1) throw notAuthorized("TRANSCRIPT_TEXT_DUPLICATED_AUTHORIZATION", "authorization template must occur exactly once");
  const expected = normalizeAuthorizationText(buildPropositionP1bExactAuthorizationTemplate(repoRoot));
  if (normalized !== expected) throw notAuthorized("TRANSCRIPT_TEXT_NOT_EXACT_AUTHORIZATION", "trusted user message is not the exact normalized P1b authorization template");
}

function findAuthorizationNegation(text: string): string | null {
  for (const term of PROPOSITION_P1B_AUTHORIZATION_NEGATION_TERMS) {
    if (/^[a-z]+$/.test(term)) {
      if (new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, "i").test(text)) return term;
    } else if (text.includes(term)) {
      return term;
    }
  }
  return null;
}

function normalizeAuthorizationText(text: string): string {
  return text.replace(/[\t\n\v\f\r ]+/g, " ").trim();
}

function buildExecutionIntent(input: {
  mode: "production" | "sandbox";
  abrainHome: string;
  outputPath: string;
  tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionEvidenceTuple>>;
  ratification: LoadedRatification;
  beforeProtected: SnapshotSummary;
}): Readonly<Record<string, unknown>> {
  const base = {
    schema_version: PROPOSITION_P1B_EXECUTION_INTENT_SCHEMA,
    mode: input.mode,
    preview_dossier_hash: PROPOSITION_P1B_PREVIEW_DOSSIER_HASH,
    ratification_record_hash: input.ratification.record_hash,
    abrain_home: input.abrainHome,
    target_path: input.tuple.target_path,
    relative_path: input.tuple.relative_path,
    event_id: input.tuple.event_id,
    canonical_envelope_bytes_sha256: input.tuple.canonical_envelope_bytes_sha256,
    expected_shadow_bundle_hash: PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH,
    output_path: input.outputPath,
    protected_prestate_snapshot_hash: input.beforeProtected.snapshot_hash,
    recovery_protocol: "same intent permits exact target/shadow completion after interruption",
    action_limits: {
      exactly_one_fixed_l1_event: true,
      exactly_one_deterministic_shadow_bundle_and_latest: true,
      no_l2_live_consumer_or_legacy_mutation: true,
    },
  };
  return deepFreeze({ ...base, intent_hash: jcsSha256Hex(base) });
}

async function loadAndValidateExistingExecutionIntent(intentPath: string, expected: Readonly<Record<string, unknown>>, targetPath: string): Promise<void> {
  const stat = await fs.lstat(intentPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) throw failure("PROPOSITION_P1B_RECOVERY_INTENT_MISSING", "target exists but the required prior execution intent is missing", { intentPath, targetPath });
  await loadAndValidateExecutionIntent(intentPath, expected);
}

async function loadAndValidateExecutionIntent(intentPath: string, expected: Readonly<Record<string, unknown>>): Promise<void> {
  await assertRequiredRegularFileNoSymlink(intentPath, "execution intent");
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(await fs.readFile(intentPath, "utf-8")), "PROPOSITION_P1B_INTENT_INVALID", "execution intent must be an object");
  } catch (err) {
    if (err instanceof PropositionP1bExecuteError) throw err;
    throw failure("PROPOSITION_P1B_INTENT_INVALID", "execution intent is unreadable or invalid JSON", { intentPath, error: errorMessage(err) });
  }
  if (parsed.schema_version !== PROPOSITION_P1B_EXECUTION_INTENT_SCHEMA || typeof parsed.intent_hash !== "string" || !/^[0-9a-f]{64}$/.test(parsed.intent_hash)) {
    throw failure("PROPOSITION_P1B_INTENT_INVALID", "execution intent schema or hash field is invalid", { intentPath });
  }
  const clone = JSON.parse(JSON.stringify(parsed));
  delete clone.intent_hash;
  if (jcsSha256Hex(clone) !== parsed.intent_hash) throw failure("PROPOSITION_P1B_INTENT_HASH_MISMATCH", "execution intent self-hash is invalid", { intentPath });
  if (parsed.intent_hash !== expected.intent_hash || jcsSha256Hex(parsed) !== jcsSha256Hex(expected)) {
    throw failure("PROPOSITION_P1B_INTENT_BINDING_MISMATCH", "execution intent is not fully bound to the current preview, ratification, tuple, output, and protected prestate", { intentPath });
  }
}

async function inspectTarget(targetPath: string, expectedBytes: string): Promise<{ absent: boolean; identical: boolean }> {
  const stat = await fs.lstat(targetPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) return { absent: true, identical: false };
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure("PROPOSITION_P1B_TARGET_UNSAFE", "fixed target exists as symlink or non-file");
  const raw = await fs.readFile(targetPath, "utf-8");
  if (raw !== expectedBytes) throw failure("PROPOSITION_P1B_COLLISION", "fixed target exists with different bytes");
  return { absent: false, identical: true };
}

function assertScanState(scan: Awaited<ReturnType<typeof scanWholeL1Validated>>, options: { evidenceCount: number; expectedEvidenceId?: string }): void {
  const proposition = scan.all.filter((record) => record.registration.domain === "proposition");
  const genesis = proposition.filter((record) => record.registration.envelope_schema === "proposition-genesis-envelope/v1");
  const evidence = proposition.filter((record) => record.registration.envelope_schema === "proposition-evidence-envelope/v1");
  const other = proposition.filter((record) => !["proposition-genesis-envelope/v1", "proposition-evidence-envelope/v1"].includes(record.registration.envelope_schema));
  if (genesis.length !== 1 || genesis[0]!.eventId !== PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID || evidence.length !== options.evidenceCount || other.length) throw failure("PROPOSITION_P1B_EXECUTE_STATE_INVALID", "proposition L1 state is outside the exact P1b cardinality", { genesis: genesis.map((record) => record.eventId), evidence: evidence.map((record) => record.eventId), other: other.map((record) => record.eventId) });
  if (options.expectedEvidenceId && evidence[0]?.eventId !== options.expectedEvidenceId) throw failure("PROPOSITION_P1B_EXECUTE_STATE_INVALID", "existing evidence is not the fixed P1b event");
  if (scan.selected.some((record) => record.registration.domain === "proposition") || scan.foldable.some((record) => record.registration.domain === "proposition")) throw failure("PROPOSITION_P1B_EXECUTE_STATE_INVALID", "inactive proposition entered selected/foldable sets");
}

function assertExpectedShadow(bundle: Awaited<ReturnType<typeof readLatestPropositionKnowledgeShadow>>): void {
  if (bundle.manifest.bundle_hash !== PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH
    || sha256Hex(bundle.bytes["manifest.json"]) !== PROPOSITION_P1B_EXPECTED_SHADOW_MANIFEST_SHA256
    || sha256Hex(bundle.bytes["cards.json"]) !== PROPOSITION_P1B_EXPECTED_SHADOW_CARDS_SHA256
    || sha256Hex(bundle.bytes["diagnostics.json"]) !== PROPOSITION_P1B_EXPECTED_SHADOW_DIAGNOSTICS_SHA256
    || sha256Hex(bundle.bytes["exclusions.json"]) !== PROPOSITION_P1B_EXPECTED_SHADOW_EXCLUSIONS_SHA256
    || bundle.cards.cards.length !== 1
    || bundle.cards.cards[0]!.source_event_id !== PROPOSITION_P1B_EXPECTED_EVENT_ID) {
    throw failure("PROPOSITION_P1B_SHADOW_MISMATCH", "published shadow does not match previewed deterministic bytes");
  }
}

async function genericGate(abrainHome: string, tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionEvidenceTuple>>, registry: ReturnType<typeof loadL1SchemaRegistry>): Promise<string> {
  try {
    await validateL1WritePreflight({ abrainHome, envelope: tuple.envelope, targetPath: tuple.target_path, registry, expected: { domain: "proposition", role: "evidence", producer: PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER } });
    return "UNEXPECTED_SUCCESS";
  } catch (err) {
    return errorCode(err);
  }
}

async function captureProtectedSnapshot(abrainHome: string, eventRelativePath: string): Promise<SnapshotSummary> {
  const exactExcluded = new Set<string>();
  const parts = eventRelativePath.split("/");
  for (let index = 1; index <= parts.length; index += 1) exactExcluded.add(parts.slice(0, index).join("/"));
  const shadowPrefix = PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE;
  const shadowParts = shadowPrefix.split("/");
  for (let index = 1; index <= shadowParts.length; index += 1) exactExcluded.add(shadowParts.slice(0, index).join("/"));
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let bytes = 0;
  const walk = async (file: string): Promise<void> => {
    const rel = path.relative(abrainHome, file).split(path.sep).join("/") || ".";
    if (rel === shadowPrefix) return;
    const stat = await fs.lstat(file);
    const excludeRow = exactExcluded.has(rel);
    if (stat.isSymbolicLink()) {
      if (!excludeRow) {
        const target = await fs.readlink(file);
        symlinkCount += 1;
        rows.push({ path: rel, kind: "symlink", target, target_sha256: sha256Hex(target) });
      }
      return;
    }
    if (stat.isDirectory()) {
      if (!excludeRow) {
        directoryCount += 1;
        rows.push({ path: rel, kind: "directory" });
      }
      for (const child of (await fs.readdir(file)).sort(compareCodeUnits)) await walk(path.join(file, child));
      return;
    }
    if (stat.isFile()) {
      if (!excludeRow) {
        const content = await fs.readFile(file);
        fileCount += 1;
        bytes += content.length;
        rows.push({ path: rel, kind: "file", bytes: content.length, sha256: sha256Hex(content) });
      }
      return;
    }
    throw failure("PROPOSITION_P1B_PROTECTED_ABRAIN_UNSAFE", "protected snapshot found unsupported entry", { file });
  };
  await walk(abrainHome);
  rows.sort((left, right) => compareCodeUnits(String(left.path), String(right.path)));
  const rowsHash = jcsSha256Hex(rows);
  return deepFreeze({
    schema_version: "proposition-p1b-protected-abrain-snapshot/v1",
    scope: "all_abrain_entries_excluding_only_declared_execution_targets",
    excluded_exact_rows: Object.freeze([...exactExcluded].sort(compareCodeUnits)),
    excluded_subtree: shadowPrefix,
    entry_count: rows.length,
    file_count: fileCount,
    directory_count: directoryCount,
    symlink_count: symlinkCount,
    bytes,
    rows_hash: rowsHash,
    snapshot_hash: jcsSha256Hex({ rows_hash: rowsHash, entry_count: rows.length, file_count: fileCount, directory_count: directoryCount, symlink_count: symlinkCount, bytes }),
  });
}

async function assertExecutionAbrain(input: string, mode: "production" | "sandbox"): Promise<string> {
  const resolved = path.resolve(input);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(resolved) !== resolved) throw failure("PROPOSITION_P1B_ABRAIN_UNSAFE", "execute abrain must be an exact non-symlink directory");
  if (mode === "production") {
    if (resolved !== PROPOSITION_P1B_HARD_ABRAIN_REALPATH) throw notAuthorized("REAL_ABRAIN_REQUIRED", "production executor is hard-limited to /home/worker/.abrain");
  } else {
    const tmp = await fs.realpath(os.tmpdir());
    if (!isPathInside(tmp, resolved) || resolved === tmp || resolved === PROPOSITION_P1B_HARD_ABRAIN_REALPATH) throw failure("PROPOSITION_P1B_SANDBOX_REQUIRED", "sandbox execute abrain must be below the system temp root");
  }
  return resolved;
}

async function assertOutputPath(input: string, repoRoot: string, mode: "production" | "sandbox"): Promise<string> {
  const resolved = path.resolve(input);
  if (mode === "production") {
    const expected = path.resolve(repoRoot, ...PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH.split("/"));
    if (resolved !== expected) throw notAuthorized("POST_DOSSIER_PATH_MISMATCH", "production post dossier must use the fixed docs/evidence path");
  } else {
    const tmp = await fs.realpath(os.tmpdir());
    if (!isPathInside(tmp, resolved)) throw failure("PROPOSITION_P1B_SANDBOX_OUTPUT_INVALID", "sandbox post dossier must be below the system temp root");
  }
  const parent = path.dirname(resolved);
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || await fs.realpath(parent) !== parent) throw failure("PROPOSITION_P1B_OUTPUT_UNSAFE", "post dossier parent is unsafe");
  const leaf = await fs.lstat(resolved).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile())) throw failure("PROPOSITION_P1B_OUTPUT_UNSAFE", "post dossier leaf is unsafe");
  return resolved;
}

async function assertRequiredRegularFileNoSymlink(file: string, label: string): Promise<void> {
  const stat = await fs.lstat(file).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") throw failure("PROPOSITION_P1B_PATH_MISSING", `${label} does not exist`, { file });
    throw err;
  });
  if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) {
    throw failure("PROPOSITION_P1B_PATH_UNSAFE", `${label} must be a non-symlink regular file with exact realpath`, { file });
  }
}

async function assertOptionalRegularFileNoSymlink(file: string, label: string): Promise<void> {
  const stat = await fs.lstat(file).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) {
    throw failure("PROPOSITION_P1B_PATH_UNSAFE", `${label} must be absent or a non-symlink regular file with exact realpath`, { file });
  }
}

function executionIntentPath(outputPath: string, repoRoot: string, mode: "production" | "sandbox"): string {
  if (mode === "production") return path.resolve(repoRoot, "docs/evidence", `adr0040-p1b-execution-intent-${PROPOSITION_P1B_EXPECTED_EVENT_ID.slice(0, 16)}-${sha256Hex(PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH).slice(0, 16)}.json`);
  return path.join(path.dirname(outputPath), `.adr0040-p1b-execution-intent-${PROPOSITION_P1B_EXPECTED_EVENT_ID.slice(0, 16)}.json`);
}

function assertTupleConstants(tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionEvidenceTuple>>): void {
  if (tuple.event_id !== PROPOSITION_P1B_EXPECTED_EVENT_ID || tuple.canonical_envelope_bytes_sha256 !== PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256 || tuple.relative_path !== PROPOSITION_P1B_EXPECTED_RELATIVE_PATH) throw failure("PROPOSITION_P1B_TUPLE_DRIFT", "fixed writer tuple does not match preview anchors");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw notAuthorized("RATIFICATION_SHAPE_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
}

function exact(actual: unknown, expected: unknown, at: string): void {
  if (actual !== expected) throw notAuthorized("RATIFICATION_BINDING_MISMATCH", `${at} mismatch`, { actual, expected });
}

function assertSha(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw notAuthorized("RATIFICATION_SHAPE_INVALID", `${at} must be lowercase SHA-256`);
  return value;
}

function record(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (code === "NOT_AUTHORIZED") throw notAuthorized("RATIFICATION_SHAPE_INVALID", message);
    throw failure(code, message);
  }
  return value as Record<string, unknown>;
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) >= 0) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "ERROR";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notAuthorized(reason: string, message: string, detail?: Record<string, unknown>): PropositionP1bExecuteError {
  return new PropositionP1bExecuteError("NOT_AUTHORIZED", `${reason}: ${message}`, { reason, ...detail });
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionP1bExecuteError {
  return new PropositionP1bExecuteError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
