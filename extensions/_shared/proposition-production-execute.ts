import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import {
  canonicalL1BodyHash,
  canonicalL1EnvelopeHash,
  canonicalL1EnvelopeJson,
  expectedL1EventPath,
  expectedL1EventRelativePath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
  validateL1WritePreflight,
  type L1EnvelopeExpectation,
  type ValidatedL1ScanRecord,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import { jcsSha256Hex, sha256Hex } from "./jcs";
import {
  PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
  validatePropositionGenesisBody,
  type PropositionGenesisBodyV1,
  type PropositionL1Envelope,
} from "./proposition";
import {
  prepareFixedProductionPropositionGenesisTuple,
  summarizePropositionGenesisScan,
  validateProductionPropositionGenesisTuple,
  type FixedProductionPropositionGenesisTuple,
} from "./proposition-genesis-writer";
import {
  PROPOSITION_P0B2_HARD_ABRAIN_REALPATH,
  PROPOSITION_P0B2_PREVIEW_DOSSIER_SCHEMA,
} from "./proposition-production-preview";

export const PROPOSITION_P0B2_RATIFICATION_RECORD_SCHEMA = "proposition-p0b2-production-ratification-record/v1" as const;
export const PROPOSITION_P0B2_EXECUTION_INTENT_SCHEMA = "proposition-p0b2-production-execution-intent/v1" as const;
export const PROPOSITION_P0B2_POST_EXECUTE_DOSSIER_SCHEMA = "proposition-p0b2-production-post-execute-dossier/v1" as const;
export const PROPOSITION_P0B2_EXECUTE_CLI = "scripts/execute-proposition-p0b2-production-genesis.mjs" as const;
export const PROPOSITION_P0B2_SESSION_ROOT = "/home/worker/.pi/agent/sessions" as const;
export const PROPOSITION_P0B2_EVIDENCE_RELATIVE_DIR = "docs/evidence" as const;

export const PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH = "68151ee7cba08585ea1bb4627371087b751bba29309dac0d88165e3781a82043" as const;
export const PROPOSITION_P0B2_EXPECTED_EVENT_ID = "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3" as const;
export const PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256 = "d9c811f6cef676031a1513e6b1c09f2501b32ff4ea459cca3275c31d56176da5" as const;
export const PROPOSITION_P0B2_EXPECTED_ENVELOPE_CANONICAL_SHA256 = "6b8f2e96a3ce6170de0bc95ef00ce98c13a9f1bec1a7e35c26745039002fec76" as const;
export const PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH = "l1/events/sha256/39/75/3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3.json" as const;
export const PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH = "/home/worker/.abrain/l1/events/sha256/39/75/3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3.json" as const;
export const PROPOSITION_P0B2_EXPECTED_REGISTRY_ID = "pi-astack-local-convergence-r9" as const;
export const PROPOSITION_P0B2_EXPECTED_REGISTRY_CANONICAL_SHA256 = "6f82d86ccfadb9eefc89501febf7bd94cca8fd4bb45190e797c7ed4b911580e0" as const;
export const PROPOSITION_P0B2_EXPECTED_REGISTRY_FILE_SHA256 = "e89cb9009d7180bf1fab0fd285bc2832ec2d2a8f8d7663260eeb85182599f6d2" as const;
export const PROPOSITION_P0B2_EXPECTED_SCHEMA_CONTRACT_HASH = "18bbb496bfc0ec977b916f8869dbbb6f9e3dcd72e8edd1a829a9f40832eee32a" as const;
export const PROPOSITION_P0B2_EXPECTED_BINDING_MANIFEST_HASH = "173b3ece666c5a18455d66e08480cf99c3e44ce8e604b0711f44d1fae7fe2a2f" as const;

export const PROPOSITION_P0B2_AUTHORIZATION_NEGATION_TERMS = ["不授权", "拒绝", "不要", "取消", "撤回", "禁止", "no", "not", "deny", "reject", "revoke"] as const;
export const PROPOSITION_P0B2_AUTHORIZATION_TEMPLATE_VERSION = "adr0040-p0b2-exact-chinese-authorization/v1" as const;

export function buildPropositionP0b2ExactAuthorizationTemplate(output: { path: string; repo_relative_path: string; repo_relative_path_sha256: string }): string {
  return [
    "我明确授权ADR0040 P0b2 executor执行一次生产写入",
    `preview dossier hash=${PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH}`,
    `event id=${PROPOSITION_P0B2_EXPECTED_EVENT_ID}`,
    `canonical envelope bytes sha256=${PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256}`,
    `real abrain=${PROPOSITION_P0B2_HARD_ABRAIN_REALPATH}`,
    `target relative path=${PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH}`,
    `output path=${output.path}`,
    `output relative path=${output.repo_relative_path}`,
    `output relative path sha256=${output.repo_relative_path_sha256}`,
    "仅写入一个不可变event",
    "除此之外不修改生产数据。",
  ].join("；");
}

export const PROPOSITION_P0B2_RATIFICATION_RECORD_MACHINE_SCHEMA = deepFreeze({
  schema_version: PROPOSITION_P0B2_RATIFICATION_RECORD_SCHEMA,
  canonicalization: "RFC8785-JCS",
  hash_algorithm: "sha256",
  required_exact_bindings: {
    preview_dossier_schema_version: PROPOSITION_P0B2_PREVIEW_DOSSIER_SCHEMA,
    preview_dossier_hash: PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH,
    event_id: PROPOSITION_P0B2_EXPECTED_EVENT_ID,
    canonical_envelope_bytes_sha256: PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256,
    target_path: PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH,
    relative_path: PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH,
  },
  required_authorization_evidence: {
    real_record_kind: "real_user_ratification",
    evidence_kind: "explicit_user_ratification",
    exact_authorization_template_version: PROPOSITION_P0B2_AUTHORIZATION_TEMPLATE_VERSION,
    negation_terms_rejected_before_positive_template: PROPOSITION_P0B2_AUTHORIZATION_NEGATION_TERMS,
    causal_anchor_required: true,
    transcript_evidence_required: true,
    trusted_session_root: PROPOSITION_P0B2_SESSION_ROOT,
    unique_session_header_required: true,
    session_id_must_match_causal_anchor: true,
    continuous_parent_chain_required: true,
    target_message_parent_and_line_bound: true,
    transcript_prefix_sha256_including_target_message_required: true,
    session_relative_path_required: true,
    user_message_text_sha256_required: true,
    caller_supplied_raw_text_prohibited: true,
  },
  authorized_actions: {
    min_items: 1,
    max_items: 1,
    action: "append_l1_event",
    cardinality: "exactly_one",
    prohibited_mutation_classes: ["l2", "state", "rules", "knowledge", "projects", "legacy"],
  },
  fail_closed_default: "NOT_AUTHORIZED",
} as const);

export const PROPOSITION_P0B2_POST_EXECUTE_DOSSIER_MACHINE_SCHEMA = deepFreeze({
  schema_version: PROPOSITION_P0B2_POST_EXECUTE_DOSSIER_SCHEMA,
  canonicalization: "RFC8785-JCS",
  hash_algorithm: "sha256",
  required_sections: ["authorization", "inputs", "target", "event", "registry", "preflight", "execution_intent", "write", "readback", "scans", "selected_foldable", "surfaces", "mutation_inventory", "evidence"],
  required_success_invariants: {
    event_id: PROPOSITION_P0B2_EXPECTED_EVENT_ID,
    canonical_envelope_bytes_sha256: PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256,
    immediate_rerun_status: "identical",
    actual_file_create_count: 1,
    actual_file_create: PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH,
    selected_unchanged: true,
    foldable_unchanged: true,
    generic_write_gate: "L1_SCHEMA_WRITE_DISABLED",
    no_l2_state_or_legacy_change: true,
  },
} as const);

export interface PropositionProductionExecuteOptions {
  abrainHome: string;
  previewDossierPath: string;
  ratificationRecordPath: string;
  outputPath: string;
  registryPath?: string;
  repoRoot?: string;
  allowSyntheticRatificationForSandboxOnly?: boolean;
}

export interface PropositionProductionPostExecuteDossier {
  schema_version: typeof PROPOSITION_P0B2_POST_EXECUTE_DOSSIER_SCHEMA;
  dossier_canonicalization: "RFC8785-JCS";
  dossier_hash_algorithm: "sha256";
  dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this post-execute dossier object with dossier_hash omitted";
  dossier_hash: string;
  generated_at_utc: string;
  repo_root: string;
  mode: "execute";
  authorization: Readonly<Record<string, unknown>>;
  inputs: Readonly<Record<string, unknown>>;
  target: Readonly<Record<string, unknown>>;
  event: Readonly<Record<string, unknown>>;
  registry: Readonly<Record<string, unknown>>;
  preflight: Readonly<Record<string, unknown>>;
  execution_intent: Readonly<Record<string, unknown>>;
  write: Readonly<Record<string, unknown>>;
  readback: Readonly<Record<string, unknown>>;
  scans: Readonly<Record<string, unknown>>;
  selected_foldable: Readonly<Record<string, unknown>>;
  surfaces: Readonly<Record<string, unknown>>;
  mutation_inventory: Readonly<Record<string, unknown>>;
  evidence: Readonly<Record<string, unknown>>;
}

interface LoadedJsonFile {
  path: string;
  raw: string;
  raw_sha256: string;
  parsed: unknown;
}

interface EvidenceFilePathInfo {
  path: string;
  evidence_dir: string;
  repo_relative_path: string;
  repo_relative_path_sha256: string;
}

interface TrustedSessionPathInfo {
  path: string;
  trusted_root: string;
  relative_path: string;
}

interface JsonlLineInfo {
  line_number: number;
  text: string;
  end_including_newline: number;
}

interface TranscriptUserMessageEvidence {
  session_id: string;
  role: "user";
  text: string;
  parent_id: string | null;
  line_number: number;
  prefix_sha256: string;
}

interface ExecutionIntentWriteResult {
  path: string;
  raw_sha256: string;
  intent_hash: string;
  status: DurableCreateStatus | "existing_valid";
  intent: Readonly<Record<string, unknown>>;
}

interface ExecutedProductionGenesisReadback {
  event_id: string;
  relative_path: string;
  target_path: string;
  raw: string;
  canonical_envelope_json: string;
  byte_identical: boolean;
  envelope: PropositionL1Envelope<PropositionGenesisBodyV1>;
}

export class PropositionProductionExecuteError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionProductionExecuteError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function writeProductionExecuteDossier(options: PropositionProductionExecuteOptions): Promise<PropositionProductionPostExecuteDossier> {
  const dossier = await executeProductionPropositionGenesis(options);
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const outInfo = await assertPostDossierOutputPathPreflight(options.outputPath, path.resolve(options.abrainHome), repoRoot);
  const status = await durableAtomicCreateFile(outInfo.path, `${JSON.stringify(dossier, null, 2)}\n`, { mode: 0o644 });
  if (status !== "created") {
    throw failure("PROPOSITION_P0B2_OUTPUT_EXISTS", "post-execute dossier output already exists; refusing to overwrite", { outputPath: outInfo.path, status });
  }
  return dossier;
}

export async function preflightProductionPropositionGenesisExecute(options: PropositionProductionExecuteOptions): Promise<Readonly<Record<string, unknown>>> {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  assertRatificationRecordPathPresent(options.ratificationRecordPath);
  const preview = await loadAndValidatePreviewDossier(options.previewDossierPath);
  if (options.allowSyntheticRatificationForSandboxOnly === true) {
    throw notAuthorized("PREFLIGHT_REQUIRES_PRODUCTION_MODE", "production execute preflight only accepts real production ratification records");
  }
  const abrain = await resolveExecuteAbrainHome(options.abrainHome, "production");
  const outInfo = await assertPostDossierOutputPathPreflight(options.outputPath, abrain.resolved, repoRoot);
  const registryPath = path.resolve(options.registryPath ?? path.join(repoRoot, "schemas/l1-schema-role-registry.json"));
  const registry = loadL1SchemaRegistry(registryPath);
  const tuple = await prepareFixedProductionPropositionGenesisTuple({
    abrainHome: abrain.resolved,
    abrainRealpath: abrain.realpath,
    registryPath,
  });
  validateProductionPropositionGenesisTuple(tuple, registry);
  assertFixedProductionTuple(tuple);
  const ratification = await loadAndValidateRatificationRecord(options.ratificationRecordPath, {
    abrainHome: abrain.resolved,
    abrainMode: "production",
    tuple,
    output: outInfo,
    repoRoot,
  });
  assertPreviewMatchesTuple(preview.parsed, tuple);

  const targetPreflight = await analyzeTargetWritePreflight(abrain.resolved, tuple);
  const intentPath = executionIntentPath(repoRoot, tuple, outInfo);
  if (path.resolve(intentPath) === outInfo.path) {
    throw failure("PROPOSITION_P0B2_OUTPUT_INTENT_PATH_COLLISION", "post dossier output path must not equal the execution-intent path", { outputPath: outInfo.path, intentPath });
  }
  const allowedDurableCreateTargets = [tuple.target_path, intentPath, outInfo.path];
  const beforeInventory = await collectFullInventory(abrain.resolved, allowedDurableCreateTargets);
  const beforeSurfaces = await collectProtectedSurfaces(abrain.resolved);
  const beforeScan = await scanWholeL1Validated({ abrainHome: abrain.resolved, registry });
  const genericGateBefore = await expectCode(() => validateL1WritePreflight({
    abrainHome: abrain.resolved,
    envelope: tuple.envelope,
    targetPath: tuple.target_path,
    registry,
    expected: propositionGenesisExpectation(),
  }));
  assertGenericGateDisabled(genericGateBefore, "preflight");
  const recoveryCandidate = targetPreflight.recovery_candidate === true;
  const beforeEpoch = recoveryCandidate ? null : assertPreExecuteEpochState(beforeScan, tuple);
  const intentExists = await fs.lstat(intentPath).then((stat: { isFile: () => boolean }) => stat.isFile(), (err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return false;
    throw err;
  });

  return deepFreeze({
    schema_version: "proposition-p0b2-production-execute-preflight/v1",
    ok: true,
    repo_root: repoRoot,
    abrain_home: abrain.resolved,
    abrain_realpath: abrain.realpath,
    preview_dossier_hash: PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH,
    ratification_record_hash: ratification.record_hash,
    ratification_record_path: ratification.path,
    output_path: outInfo.path,
    output_repo_relative_path: outInfo.repo_relative_path,
    output_repo_relative_path_sha256: outInfo.repo_relative_path_sha256,
    target_preflight: targetPreflight,
    intent_path: intentPath,
    intent_exists: intentExists,
    recovery_candidate: recoveryCandidate,
    before_epoch: beforeEpoch,
    before_inventory_entries_sha256: beforeInventory.entries_sha256,
    before_surfaces: beforeSurfaces,
    before_scan: summarizeScanForDossier(beforeScan),
    generic_validateL1WritePreflight_before: genericGateBefore,
  });
}

export async function executeProductionPropositionGenesis(options: PropositionProductionExecuteOptions): Promise<PropositionProductionPostExecuteDossier> {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  assertRatificationRecordPathPresent(options.ratificationRecordPath);
  const preview = await loadAndValidatePreviewDossier(options.previewDossierPath);
  const abrainMode = options.allowSyntheticRatificationForSandboxOnly === true ? "sandbox" : "production";
  const abrain = await resolveExecuteAbrainHome(options.abrainHome, abrainMode);
  const outInfo = await assertPostDossierOutputPathPreflight(options.outputPath, abrain.resolved, repoRoot);
  const registryPath = path.resolve(options.registryPath ?? path.join(repoRoot, "schemas/l1-schema-role-registry.json"));
  const registry = loadL1SchemaRegistry(registryPath);
  const tuple = await prepareFixedProductionPropositionGenesisTuple({
    abrainHome: abrain.resolved,
    abrainRealpath: abrain.realpath,
    registryPath,
  });
  validateProductionPropositionGenesisTuple(tuple, registry);
  assertFixedProductionTuple(tuple);
  const ratification = await loadAndValidateRatificationRecord(options.ratificationRecordPath, {
    abrainHome: abrain.resolved,
    abrainMode,
    tuple,
    output: outInfo,
    repoRoot,
  });
  assertPreviewMatchesTuple(preview.parsed, tuple);

  const targetPreflight = await analyzeTargetWritePreflight(abrain.resolved, tuple);
  const intentPath = executionIntentPath(repoRoot, tuple, outInfo);
  if (path.resolve(intentPath) === outInfo.path) {
    throw failure("PROPOSITION_P0B2_OUTPUT_INTENT_PATH_COLLISION", "post dossier output path must not equal the execution-intent path", { outputPath: outInfo.path, intentPath });
  }

  let intentWrite: ExecutionIntentWriteResult;
  let firstStatus: DurableCreateStatus;
  let firstReadback: ExecutedProductionGenesisReadback;
  let immediateRerunStatus: DurableCreateStatus;
  let secondReadback: ExecutedProductionGenesisReadback;
  const recoveryMode = targetPreflight.recovery_candidate === true;
  const allowedDurableCreateTargets = [tuple.target_path, intentPath, outInfo.path];

  if (recoveryMode) {
    intentWrite = await loadExistingExecutionIntent(intentPath, { repoRoot, abrain, tuple, output: outInfo, ratification, preview });
    firstStatus = "identical";
    firstReadback = await readExecutedProductionGenesis({ abrainHome: abrain.resolved, eventId: tuple.event_id, registryPath });
    if (!firstReadback.byte_identical) {
      throw failure("PROPOSITION_P0B2_READBACK_MISMATCH", "recovery target is not byte-identical to fixed canonical bytes", { targetPath: tuple.target_path });
    }
  } else {
    const beforeInventory = await collectFullInventory(abrain.resolved, allowedDurableCreateTargets);
    const beforeSurfaces = await collectProtectedSurfaces(abrain.resolved);
    const beforeScan = await scanWholeL1Validated({ abrainHome: abrain.resolved, registry });
    const beforeEpoch = assertPreExecuteEpochState(beforeScan, tuple);
    const genericGateBefore = await expectCode(() => validateL1WritePreflight({
      abrainHome: abrain.resolved,
      envelope: tuple.envelope,
      targetPath: tuple.target_path,
      registry,
      expected: propositionGenesisExpectation(),
    }));
    assertGenericGateDisabled(genericGateBefore, "before");
    const intent = buildExecutionIntent({
      repoRoot,
      abrain,
      tuple,
      output: outInfo,
      ratification,
      preview,
      targetPreflight,
      beforeInventory,
      beforeSurfaces,
      beforeScan,
      beforeEpoch,
      genericGateBefore,
    });
    intentWrite = await createOrLoadExecutionIntent(intentPath, intent, { repoRoot, abrain, tuple, output: outInfo, ratification, preview });

    await createTargetParentNoSymlink(abrain.resolved, tuple.target_path);
    firstStatus = await durableAtomicCreateFile(tuple.target_path, tuple.canonical_envelope_json, { mode: 0o600 });
    if (firstStatus === "collision") {
      throw failure("PROPOSITION_P0B2_COLLISION", "production genesis target exists with different bytes; refusing replacement", { targetPath: tuple.target_path, eventId: tuple.event_id });
    }
    firstReadback = await readExecutedProductionGenesis({ abrainHome: abrain.resolved, eventId: tuple.event_id, registryPath });
    if (!firstReadback.byte_identical) {
      throw failure("PROPOSITION_P0B2_READBACK_MISMATCH", "on-disk production genesis is not byte-identical to fixed canonical bytes", { targetPath: tuple.target_path });
    }
  }

  immediateRerunStatus = await durableAtomicCreateFile(tuple.target_path, tuple.canonical_envelope_json, { mode: 0o600 });
  if (immediateRerunStatus !== "identical") {
    throw failure("PROPOSITION_P0B2_IDEMPOTENT_RERUN_FAILED", "immediate no-replace rerun was not identical", { status: immediateRerunStatus, targetPath: tuple.target_path });
  }
  secondReadback = await readExecutedProductionGenesis({ abrainHome: abrain.resolved, eventId: tuple.event_id, registryPath });
  if (!secondReadback.byte_identical) {
    throw failure("PROPOSITION_P0B2_READBACK_MISMATCH", "post-rerun production genesis is not byte-identical to fixed canonical bytes", { targetPath: tuple.target_path });
  }

  const afterScan = await scanWholeL1Validated({ abrainHome: abrain.resolved, registry });
  const afterEpoch = assertPostExecuteEpochState(afterScan, tuple);
  const afterSurfaces = await collectProtectedSurfaces(abrain.resolved);
  const afterInventory = await collectFullInventory(abrain.resolved, allowedDurableCreateTargets);
  const genericGateAfter = await expectCode(() => validateL1WritePreflight({
    abrainHome: abrain.resolved,
    envelope: tuple.envelope,
    targetPath: tuple.target_path,
    registry,
    expected: propositionGenesisExpectation(),
  }));
  assertGenericGateDisabled(genericGateAfter, "after");

  const beforeScanDossier = intentBeforeScanForDossier(intentWrite.intent);
  const beforeScanSummary = record(beforeScanDossier.summary, "PROPOSITION_P0B2_INTENT_INVALID", "intent before scan summary must be an object");
  const genericGateBefore = intentGenericGateBefore(intentWrite.intent);
  const selectedFoldable = compareSelectedFoldableFromIntent(intentWrite.intent, afterScan);
  const surfaces = compareProtectedSurfaces(intentBeforeSurfaces(intentWrite.intent), afterSurfaces);
  const mutationInventory = buildMutationInventory(intentBeforeInventory(intentWrite.intent), afterInventory, tuple);
  if (!selectedFoldable.selected_unchanged || !selectedFoldable.foldable_unchanged) {
    throw failure("PROPOSITION_P0B2_SELECTED_FOLDABLE_DRIFT", "selected/foldable whole-L1 sets changed during production genesis append/recovery", selectedFoldable);
  }
  if (!surfaces.no_l2_state_or_legacy_change) {
    throw failure("PROPOSITION_P0B2_SURFACE_MUTATION", "L2/state/legacy surfaces changed during production genesis append/recovery", surfaces);
  }
  if (!mutationInventory.only_allowed_mutation) {
    throw failure("PROPOSITION_P0B2_UNEXPECTED_MUTATION", "production genesis append/recovery observed mutations outside the target file and required parent directories", mutationInventory);
  }

  const dossier: PropositionProductionPostExecuteDossier = {
    schema_version: PROPOSITION_P0B2_POST_EXECUTE_DOSSIER_SCHEMA,
    dossier_canonicalization: "RFC8785-JCS",
    dossier_hash_algorithm: "sha256",
    dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this post-execute dossier object with dossier_hash omitted",
    dossier_hash: "",
    generated_at_utc: new Date().toISOString(),
    repo_root: repoRoot,
    mode: "execute",
    authorization: {
      ratification_schema_version: PROPOSITION_P0B2_RATIFICATION_RECORD_SCHEMA,
      ratification_record_hash: ratification.record_hash,
      ratification_record_path: ratification.path,
      ratification_record_raw_sha256: ratification.raw_sha256,
      synthetic_fixture: ratification.synthetic_fixture,
      production_usable: ratification.production_usable,
      authorization_evidence: ratification.authorization_evidence,
      authorized_action_count: 1,
      authorized_action: ratification.authorized_action,
      output_binding: ratification.output_binding,
      execute_cli: PROPOSITION_P0B2_EXECUTE_CLI,
      no_env_bypass_or_force: true,
    },
    inputs: {
      preview_dossier_path: preview.path,
      preview_dossier_raw_sha256: preview.raw_sha256,
      preview_dossier_hash: PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH,
      post_dossier_output_path: outInfo.path,
      post_dossier_output_repo_relative_path: outInfo.repo_relative_path,
      post_dossier_output_repo_relative_path_sha256: outInfo.repo_relative_path_sha256,
    },
    target: {
      mode: abrainMode,
      abrain_home: abrain.resolved,
      abrain_realpath: abrain.realpath,
      hard_realpath_required_for_production: PROPOSITION_P0B2_HARD_ABRAIN_REALPATH,
      target_path: tuple.target_path,
      relative_path: tuple.relative_path,
      target_preflight: targetPreflight,
      recovery_mode: recoveryMode,
    },
    event: {
      event_id: tuple.event_id,
      body_hash: tuple.envelope.body_hash,
      body_canonical_sha256: canonicalL1BodyHash(tuple.envelope.body),
      envelope_canonical_sha256: canonicalL1EnvelopeHash(tuple.envelope),
      canonical_envelope_bytes_sha256: sha256Hex(tuple.canonical_envelope_json),
      canonical_envelope_bytes_utf8: tuple.canonical_envelope_json,
      canonical_envelope_json_matches_shared_jcs: tuple.canonical_envelope_json === canonicalL1EnvelopeJson(tuple.envelope),
      envelope: tuple.envelope,
    },
    registry: {
      path: tuple.registry_path,
      registry_id: tuple.registry_id,
      registry_canonical_sha256: tuple.registry_canonical_sha256,
      registry_file_sha256: tuple.registry_file_sha256,
      proposition_schema_contract_hash: tuple.proposition_schema_contract_hash,
      binding_manifest_hash: tuple.binding_manifest_hash,
      binding_matches_fixed_preview: true,
    },
    preflight: {
      before_epoch: intentBeforeEpoch(intentWrite.intent),
      target_absent: targetPreflight.target_absent,
      recovery_candidate: recoveryMode,
      whole_l1_before: {
        ok: true,
        scan_summary: beforeScanSummary,
        total: beforeScanSummary.total,
      },
      registry_schema_binding: {
        ok: true,
        tuple_validated_with_shared_validator: true,
        registry_canonical_sha256: tuple.registry_canonical_sha256,
        registry_file_sha256: tuple.registry_file_sha256,
        proposition_schema_contract_hash: tuple.proposition_schema_contract_hash,
        binding_manifest_hash: tuple.binding_manifest_hash,
      },
      generic_validateL1WritePreflight_before: genericGateBefore,
    },
    execution_intent: {
      schema_version: PROPOSITION_P0B2_EXECUTION_INTENT_SCHEMA,
      path: intentWrite.path,
      raw_sha256: intentWrite.raw_sha256,
      intent_hash: intentWrite.intent_hash,
      no_replace_status: intentWrite.status,
      target_bound: true,
      bytes_bound: true,
      output_bound: true,
      ratification_bound: true,
      transcript_bound: true,
    },
    write: {
      first_status: firstStatus,
      immediate_rerun_status: immediateRerunStatus,
      created_then_identical: firstStatus === "created" && immediateRerunStatus === "identical",
      recovered_from_intent: recoveryMode,
      first_readback_byte_identical: firstReadback.byte_identical,
      second_readback_byte_identical: secondReadback.byte_identical,
      durable_create_primitive: "durableAtomicCreateFile",
    },
    readback: {
      event_id: secondReadback.event_id,
      relative_path: secondReadback.relative_path,
      target_path: secondReadback.target_path,
      raw_sha256: sha256Hex(secondReadback.raw),
      byte_identical: secondReadback.byte_identical,
      canonical_envelope_json_matches_fixed_tuple: secondReadback.raw === tuple.canonical_envelope_json,
    },
    scans: {
      before: beforeScanDossier,
      after: summarizeScanForDossier(afterScan),
      after_epoch: afterEpoch,
    },
    selected_foldable: selectedFoldable,
    surfaces,
    mutation_inventory: mutationInventory,
    evidence: {
      generic_validateL1WritePreflight_after: genericGateAfter,
      no_l2_state_or_legacy_change: surfaces.no_l2_state_or_legacy_change,
      no_runtime_read_flip: true,
      no_generic_proposition_write_enablement: genericGateBefore.code === "L1_SCHEMA_WRITE_DISABLED" && genericGateAfter.code === "L1_SCHEMA_WRITE_DISABLED",
      no_legacy_authority_retirement: true,
      failure_semantics: "success is claimed only if all authorization, transcript, output, intent, write/recovery, readback, idempotent rerun, scan, surface, and mutation checks pass",
    },
  };
  dossier.dossier_hash = selfHashPostExecuteDossier(dossier);
  const validationErrors = validatePostExecuteDossier(dossier);
  if (validationErrors.length) {
    throw failure("PROPOSITION_P0B2_POST_DOSSIER_INVALID", "post-execute dossier failed its validator", { validationErrors });
  }
  return deepFreeze(dossier);
}

export function selfHashRatificationRecord(record: Readonly<Record<string, unknown>>): string {
  const clone = JSON.parse(JSON.stringify(record));
  delete clone.record_hash;
  return jcsSha256Hex(clone);
}

export function selfHashExecutionIntent(intent: Readonly<Record<string, unknown>>): string {
  const clone = JSON.parse(JSON.stringify(intent));
  delete clone.intent_hash;
  return jcsSha256Hex(clone);
}

export function selfHashPostExecuteDossier(dossier: PropositionProductionPostExecuteDossier): string {
  const clone = JSON.parse(JSON.stringify(dossier));
  delete clone.dossier_hash;
  return jcsSha256Hex(clone);
}

export function validatePostExecuteDossier(input: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) return ["dossier must be an object"];
  const dossier = input as Record<string, unknown>;
  if (dossier.schema_version !== PROPOSITION_P0B2_POST_EXECUTE_DOSSIER_SCHEMA) errors.push("schema_version mismatch");
  if (dossier.mode !== "execute") errors.push("mode must be execute");
  if (typeof dossier.dossier_hash !== "string" || !isSha256(dossier.dossier_hash)) errors.push("dossier_hash must be sha256");
  else if (selfHashPostExecuteDossier(dossier as unknown as PropositionProductionPostExecuteDossier) !== dossier.dossier_hash) errors.push("dossier_hash self hash mismatch");

  const write = objectAt(dossier.write);
  if (!write) errors.push("write missing");
  else {
    if (write.first_status !== "created" && write.first_status !== "identical") errors.push("write.first_status must be created or identical");
    if (write.immediate_rerun_status !== "identical") errors.push("write.immediate_rerun_status must be identical");
    if (write.first_readback_byte_identical !== true || write.second_readback_byte_identical !== true) errors.push("readback byte identity missing");
  }

  const event = objectAt(dossier.event);
  if (!event) errors.push("event missing");
  else {
    if (event.event_id !== PROPOSITION_P0B2_EXPECTED_EVENT_ID) errors.push("event_id mismatch");
    if (event.canonical_envelope_bytes_sha256 !== PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256) errors.push("canonical bytes hash mismatch");
  }

  const selected = objectAt(dossier.selected_foldable);
  if (!selected) errors.push("selected_foldable missing");
  else {
    if (selected.selected_unchanged !== true) errors.push("selected set changed");
    if (selected.foldable_unchanged !== true) errors.push("foldable set changed");
  }

  const surfaces = objectAt(dossier.surfaces);
  if (!surfaces) errors.push("surfaces missing");
  else if (surfaces.no_l2_state_or_legacy_change !== true) errors.push("L2/state/legacy surface changed");

  const mutation = objectAt(dossier.mutation_inventory);
  if (!mutation) errors.push("mutation_inventory missing");
  else {
    if (mutation.only_allowed_mutation !== true) errors.push("unexpected mutation detected");
    if (mutation.actual_file_create_count !== 1) errors.push("expected exactly one file create");
    const actualFiles = arrayAt(mutation.actual_file_creates);
    if (!actualFiles || actualFiles[0] !== PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH) errors.push("actual file create is not the fixed target");
    if (arrayAt(mutation.actual_file_modifies)?.length !== 0) errors.push("file modifies not empty");
    if (arrayAt(mutation.actual_removes)?.length !== 0) errors.push("removes not empty");
  }

  const evidence = objectAt(dossier.evidence);
  const genericAfter = objectAt(evidence?.generic_validateL1WritePreflight_after);
  if (!genericAfter || genericAfter.code !== "L1_SCHEMA_WRITE_DISABLED") errors.push("generic write gate after did not remain disabled");
  if (evidence?.no_generic_proposition_write_enablement !== true) errors.push("generic write enablement changed");
  if (evidence?.no_runtime_read_flip !== true) errors.push("runtime read flip changed");
  return errors;
}

function assertRatificationRecordPathPresent(value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw notAuthorized("RATIFICATION_RECORD_REQUIRED", "--ratification-record is required before any production genesis execute write");
  }
}

async function loadAndValidatePreviewDossier(value: string): Promise<LoadedJsonFile> {
  const loaded = await loadJsonFile(value, "preview dossier", "PREVIEW_DOSSIER_INVALID");
  const dossier = record(loaded.parsed, "PREVIEW_DOSSIER_INVALID", "preview dossier must be an object");
  if (dossier.schema_version !== PROPOSITION_P0B2_PREVIEW_DOSSIER_SCHEMA) {
    throw notAuthorized("PREVIEW_DOSSIER_SCHEMA_MISMATCH", "preview dossier schema_version is not the exact P0b2 preview schema", { actual: dossier.schema_version });
  }
  if (dossier.dossier_hash !== PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH) {
    throw notAuthorized("PREVIEW_DOSSIER_HASH_MISMATCH", "preview dossier hash is not the exact ratifiable P0b2 preview hash", { actual: dossier.dossier_hash });
  }
  const clone = JSON.parse(JSON.stringify(dossier));
  delete clone.dossier_hash;
  const actualSelfHash = jcsSha256Hex(clone);
  if (actualSelfHash !== PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH) {
    throw notAuthorized("PREVIEW_DOSSIER_SELF_HASH_MISMATCH", "preview dossier self-hash does not match the exact ratifiable hash", { expected: PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH, actual: actualSelfHash });
  }
  assertPreviewConstants(dossier);
  return loaded;
}

async function loadAndValidateRatificationRecord(value: string, options: {
  abrainHome: string;
  abrainMode: "production" | "sandbox";
  tuple: FixedProductionPropositionGenesisTuple;
  output: EvidenceFilePathInfo;
  repoRoot: string;
}): Promise<Readonly<Record<string, unknown>>> {
  assertRatificationRecordPathPresent(value);
  const loaded = await loadJsonFile(value, "ratification record", "RATIFICATION_RECORD_INVALID").catch((err: unknown) => {
    throw notAuthorized("RATIFICATION_RECORD_UNREADABLE", "ratification record is missing or unreadable", { error: errorMessage(err) });
  });
  try {
    const root = record(loaded.parsed, "RATIFICATION_RECORD_INVALID", "ratification record must be an object");
    exactKeys(root, [
      "schema_version",
      "record_canonicalization",
      "record_hash_algorithm",
      "record_hash_scope",
      "record_hash",
      "record_kind",
      "synthetic_fixture",
      "synthetic_fixture_scope",
      "preview_dossier",
      "post_execute_dossier_output",
      "authorization_evidence",
      "authorized_actions",
      "constraints",
    ], "ratification record");
    exact(root.schema_version, PROPOSITION_P0B2_RATIFICATION_RECORD_SCHEMA, "schema_version");
    exact(root.record_canonicalization, "RFC8785-JCS", "record_canonicalization");
    exact(root.record_hash_algorithm, "sha256", "record_hash_algorithm");
    exact(root.record_hash_scope, "sha256 over RFC8785-JCS UTF-8 bytes of this ratification record object with record_hash omitted", "record_hash_scope");
    sha256HexString(root.record_hash, "record_hash");
    const actualRecordHash = selfHashRatificationRecord(root);
    if (root.record_hash !== actualRecordHash) {
      throw notAuthorized("RATIFICATION_RECORD_HASH_MISMATCH", "ratification record self-hash is invalid", { expected: root.record_hash, actual: actualRecordHash });
    }

    const synthetic = boolean(root.synthetic_fixture, "synthetic_fixture");
    const recordKind = oneOf(root.record_kind, ["real_user_ratification", "synthetic_test_fixture"] as const, "record_kind");
    const scope = record(root.synthetic_fixture_scope, "RATIFICATION_RECORD_INVALID", "synthetic_fixture_scope must be an object");
    exactKeys(scope, ["valid_for", "not_valid_for_abrain_home"], "synthetic_fixture_scope");
    const validFor = oneOf(scope.valid_for, ["production", "test_sandbox_only"] as const, "synthetic_fixture_scope.valid_for");
    if (synthetic) {
      if (recordKind !== "synthetic_test_fixture" || validFor !== "test_sandbox_only" || scope.not_valid_for_abrain_home !== PROPOSITION_P0B2_HARD_ABRAIN_REALPATH) {
        throw notAuthorized("SYNTHETIC_RATIFICATION_INVALID", "synthetic ratification records must be explicitly sandbox-only and not valid for real abrain");
      }
      if (options.abrainMode !== "sandbox") {
        throw notAuthorized("SYNTHETIC_RATIFICATION_REJECTED", "synthetic ratification records are rejected on the production execute path");
      }
    } else {
      if (recordKind !== "real_user_ratification" || validFor !== "production" || scope.not_valid_for_abrain_home !== null) {
        throw notAuthorized("RATIFICATION_RECORD_INVALID", "real ratification records must be production scoped and non-synthetic");
      }
      if (options.abrainMode !== "production") {
        throw notAuthorized("REAL_RATIFICATION_REQUIRES_PRODUCTION", "real ratification records are not accepted for sandbox execution");
      }
    }

    validateRatificationPreviewBinding(root.preview_dossier);
    const outputBinding = validateRatificationOutputBinding(root.post_execute_dossier_output, options.output);
    const evidence = await validateAuthorizationEvidence(root.authorization_evidence, {
      synthetic,
      tuple: options.tuple,
      output: options.output,
      repoRoot: options.repoRoot,
    });
    const action = validateExactlyOneAuthorizedAction(root.authorized_actions, options.abrainHome, options.tuple, synthetic);
    validateRatificationConstraints(root.constraints);
    return deepFreeze({
      ...root,
      path: loaded.path,
      raw_sha256: loaded.raw_sha256,
      record_hash: root.record_hash,
      synthetic_fixture: synthetic,
      production_usable: !synthetic,
      authorization_evidence: evidence,
      authorized_action: action,
      output_binding: outputBinding,
    });
  } catch (err) {
    if (err instanceof PropositionProductionExecuteError && err.code === "NOT_AUTHORIZED") throw err;
    throw notAuthorized("RATIFICATION_RECORD_INVALID", "ratification record failed validation", { error: errorMessage(err), code: errorCode(err) });
  }
}

function validateRatificationPreviewBinding(input: unknown): void {
  const preview = record(input, "RATIFICATION_RECORD_INVALID", "preview_dossier must be an object");
  exactKeys(preview, ["schema_version", "dossier_hash", "event_id", "canonical_envelope_bytes_sha256", "target_path", "relative_path"], "preview_dossier");
  exact(preview.schema_version, PROPOSITION_P0B2_PREVIEW_DOSSIER_SCHEMA, "preview_dossier.schema_version");
  exact(preview.dossier_hash, PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH, "preview_dossier.dossier_hash");
  exact(preview.event_id, PROPOSITION_P0B2_EXPECTED_EVENT_ID, "preview_dossier.event_id");
  exact(preview.canonical_envelope_bytes_sha256, PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256, "preview_dossier.canonical_envelope_bytes_sha256");
  exact(preview.target_path, PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH, "preview_dossier.target_path");
  exact(preview.relative_path, PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH, "preview_dossier.relative_path");
}

function validateRatificationOutputBinding(input: unknown, output: EvidenceFilePathInfo): Readonly<Record<string, unknown>> {
  const binding = record(input, "RATIFICATION_RECORD_INVALID", "post_execute_dossier_output must be an object");
  exactKeys(binding, ["path", "repo_relative_path", "repo_relative_path_sha256"], "post_execute_dossier_output");
  if (binding.path !== null) exact(binding.path, output.path, "post_execute_dossier_output.path");
  exact(binding.repo_relative_path, output.repo_relative_path, "post_execute_dossier_output.repo_relative_path");
  exact(binding.repo_relative_path_sha256, output.repo_relative_path_sha256, "post_execute_dossier_output.repo_relative_path_sha256");
  return deepFreeze({
    path: binding.path,
    repo_relative_path: binding.repo_relative_path,
    repo_relative_path_sha256: binding.repo_relative_path_sha256,
  });
}

async function validateAuthorizationEvidence(input: unknown, options: {
  synthetic: boolean;
  tuple: FixedProductionPropositionGenesisTuple;
  output: EvidenceFilePathInfo;
  repoRoot: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const evidence = record(input, "RATIFICATION_RECORD_INVALID", "authorization_evidence must be an object");
  if (options.synthetic) {
    exactKeys(evidence, ["evidence_kind", "authorized_by", "authorization_causal_anchor", "authorization_text", "authorization_text_sha256"], "authorization_evidence");
    exact(evidence.evidence_kind, "synthetic_test_fixture", "authorization_evidence.evidence_kind");
    exact(evidence.authorized_by, "test_fixture", "authorization_evidence.authorized_by");
    const text = nonEmptyString(evidence.authorization_text, "authorization_evidence.authorization_text");
    exact(evidence.authorization_text_sha256, sha256Hex(text), "authorization_evidence.authorization_text_sha256");
    if (!text.includes("SYNTHETIC") || !text.includes(PROPOSITION_P0B2_HARD_ABRAIN_REALPATH)) {
      throw notAuthorized("SYNTHETIC_RATIFICATION_INVALID", "synthetic authorization text must clearly state it is synthetic and not valid for real abrain");
    }
    const anchor = validateCausalAnchor(evidence.authorization_causal_anchor, "authorization_evidence.authorization_causal_anchor");
    return deepFreeze({ ...evidence, authorization_causal_anchor: anchor });
  }

  exactKeys(evidence, ["evidence_kind", "authorized_by", "transcript_evidence"], "authorization_evidence");
  exact(evidence.evidence_kind, "explicit_user_ratification", "authorization_evidence.evidence_kind");
  exact(evidence.authorized_by, "user", "authorization_evidence.authorized_by");
  const transcript = await validateTranscriptEvidence(evidence.transcript_evidence, options);
  return deepFreeze({
    evidence_kind: "explicit_user_ratification",
    authorized_by: "user",
    transcript_evidence: transcript,
  });
}

async function validateTranscriptEvidence(input: unknown, options: {
  tuple: FixedProductionPropositionGenesisTuple;
  output: EvidenceFilePathInfo;
  repoRoot: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const evidence = record(input, "RATIFICATION_RECORD_INVALID", "transcript_evidence must be an object");
  exactKeys(evidence, [
    "session_jsonl_path",
    "session_jsonl_relative_path",
    "session_id",
    "message_id",
    "message_parent_id",
    "message_line_number",
    "timestamp",
    "role",
    "text_sha256",
    "transcript_prefix_sha256",
    "authorization_causal_anchor",
  ], "transcript_evidence");
  const sessionInfo = await assertTrustedSessionJsonlPath(nonEmptyString(evidence.session_jsonl_path, "transcript_evidence.session_jsonl_path"));
  exact(evidence.session_jsonl_relative_path, sessionInfo.relative_path, "transcript_evidence.session_jsonl_relative_path");
  const evidenceSessionId = nonEmptyString(evidence.session_id, "transcript_evidence.session_id");
  const messageId = nonEmptyString(evidence.message_id, "transcript_evidence.message_id");
  const messageParentId = nullableString(evidence.message_parent_id, "transcript_evidence.message_parent_id");
  const messageLineNumber = positiveInteger(evidence.message_line_number, "transcript_evidence.message_line_number");
  const timestamp = nonEmptyString(evidence.timestamp, "transcript_evidence.timestamp");
  exact(evidence.role, "user", "transcript_evidence.role");
  sha256HexString(evidence.text_sha256, "transcript_evidence.text_sha256");
  const prefixSha256 = sha256HexString(evidence.transcript_prefix_sha256, "transcript_evidence.transcript_prefix_sha256");
  const anchor = validateCausalAnchor(evidence.authorization_causal_anchor, "transcript_evidence.authorization_causal_anchor");
  exact(evidenceSessionId, anchor.session_id, "transcript_evidence.session_id");
  const found = await validateTrustedTranscriptChainAndFindUserMessage(sessionInfo, {
    sessionId: evidenceSessionId,
    messageId,
    parentId: messageParentId,
    lineNumber: messageLineNumber,
    timestamp,
    prefixSha256,
  });
  exact(found.role, "user", "transcript message role");
  exact(evidence.text_sha256, sha256Hex(found.text), "transcript_evidence.text_sha256");
  if (anchor.session_id !== found.session_id) {
    throw notAuthorized("TRANSCRIPT_ANCHOR_SESSION_MISMATCH", "causal anchor session_id does not match the session JSONL header", { anchorSessionId: anchor.session_id, sessionId: found.session_id });
  }
  assertTranscriptTextBindsAuthorization(found.text, { tuple: options.tuple, output: options.output });
  return deepFreeze({
    session_jsonl_path: sessionInfo.path,
    session_jsonl_relative_path: sessionInfo.relative_path,
    session_id: evidenceSessionId,
    message_id: messageId,
    message_parent_id: messageParentId,
    message_line_number: messageLineNumber,
    timestamp,
    role: "user",
    text_sha256: evidence.text_sha256,
    transcript_prefix_sha256: prefixSha256,
    authorization_causal_anchor: anchor,
    verified_text_binding: {
      authorization_template_version: PROPOSITION_P0B2_AUTHORIZATION_TEMPLATE_VERSION,
      preview_dossier_hash: PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH,
      event_id: options.tuple.event_id,
      canonical_envelope_bytes_sha256: PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256,
      real_abrain_home: PROPOSITION_P0B2_HARD_ABRAIN_REALPATH,
      output_path: options.output.path,
      output_repo_relative_path: options.output.repo_relative_path,
      output_repo_relative_path_sha256: options.output.repo_relative_path_sha256,
      target_relative_path: options.tuple.relative_path,
      exactly_one_event: true,
      no_other_production_data_modified: true,
    },
  });
}

async function assertTrustedSessionJsonlPath(input: string): Promise<TrustedSessionPathInfo> {
  if (!path.isAbsolute(input)) {
    throw notAuthorized("TRANSCRIPT_SESSION_PATH_NOT_ABSOLUTE", "transcript evidence session_jsonl_path must be absolute", { path: input });
  }
  const resolved = path.resolve(input);
  if (resolved !== input || path.extname(resolved) !== ".jsonl") {
    throw notAuthorized("TRANSCRIPT_SESSION_PATH_INVALID", "transcript evidence must point to an absolute .jsonl file", { path: input });
  }
  const rootReal = await fs.realpath(PROPOSITION_P0B2_SESSION_ROOT);
  await assertNoSymlinkDirectoryChainAuth(rootReal, path.dirname(resolved));
  const stat = await fs.lstat(resolved).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) throw notAuthorized("TRANSCRIPT_SESSION_NOT_FOUND", "transcript evidence session JSONL file does not exist", { path: resolved });
  if (stat.isSymbolicLink()) throw notAuthorized("TRANSCRIPT_SESSION_SYMLINK_REJECTED", "transcript evidence session JSONL file must not be a symlink", { path: resolved });
  if (!stat.isFile()) throw notAuthorized("TRANSCRIPT_SESSION_NON_REGULAR", "transcript evidence session JSONL path must be a regular file", { path: resolved });
  const real = await fs.realpath(resolved);
  if (!isPathInside(rootReal, real)) {
    throw notAuthorized("TRANSCRIPT_SESSION_PATH_ESCAPE", "transcript evidence realpath escapes the trusted sessions root", { path: resolved, realpath: real, trustedRoot: rootReal });
  }
  const relativePath = path.relative(rootReal, real).split(path.sep).join("/");
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw notAuthorized("TRANSCRIPT_SESSION_PATH_ESCAPE", "transcript evidence relative path escapes the trusted sessions root", { path: resolved, realpath: real, trustedRoot: rootReal, relativePath });
  }
  return deepFreeze({ path: real, trusted_root: rootReal, relative_path: relativePath });
}

async function assertNoSymlinkDirectoryChainAuth(rootReal: string, targetDir: string): Promise<void> {
  const root = path.resolve(rootReal);
  const target = path.resolve(targetDir);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw notAuthorized("TRANSCRIPT_SESSION_PATH_ESCAPE", "transcript evidence path escapes the trusted sessions root", { root, targetDir: target });
  }
  let current = root;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw notAuthorized("TRANSCRIPT_SESSION_ROOT_INVALID", "trusted sessions root must be a real directory", { root });
  }
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat) throw notAuthorized("TRANSCRIPT_SESSION_PATH_MISSING", "transcript evidence directory does not exist", { path: current });
    if (stat.isSymbolicLink()) throw notAuthorized("TRANSCRIPT_SESSION_SYMLINK_REJECTED", "transcript evidence directory chain must not contain symlinks", { path: current });
    if (!stat.isDirectory()) throw notAuthorized("TRANSCRIPT_SESSION_NON_DIRECTORY", "transcript evidence directory chain component is not a directory", { path: current });
  }
}

async function validateTrustedTranscriptChainAndFindUserMessage(session: TrustedSessionPathInfo, target: {
  sessionId: string;
  messageId: string;
  parentId: string | null;
  lineNumber: number;
  timestamp: string;
  prefixSha256: string;
}): Promise<TranscriptUserMessageEvidence> {
  const raw = await fs.readFile(session.path);
  const lines = splitJsonlLines(raw, session.path);
  if (lines.length === 0) throw notAuthorized("TRANSCRIPT_SESSION_HEADER_MISSING", "transcript evidence session JSONL is empty", { sessionPath: session.path });

  let headerSessionId: string | null = null;
  let previousId: string | null = null;
  let found: TranscriptUserMessageEvidence | null = null;
  const seenIds = new Set<string>();

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch (err) {
      throw notAuthorized("TRANSCRIPT_JSONL_INVALID", "transcript evidence session JSONL contains invalid JSON", { sessionPath: session.path, line: line.line_number, error: errorMessage(err) });
    }
    if (!isRecord(parsed)) {
      throw notAuthorized("TRANSCRIPT_JSONL_INVALID", "transcript evidence session JSONL line must be an object", { sessionPath: session.path, line: line.line_number });
    }
    const entry = parsed;
    if (entry.type === "session") {
      if (line.line_number !== 1 || headerSessionId !== null) {
        throw notAuthorized("TRANSCRIPT_SESSION_HEADER_INVALID", "transcript evidence must contain exactly one type=session header as the first JSONL line", { sessionPath: session.path, line: line.line_number });
      }
      const sessionId = nonEmptyString(entry.id, "session.id");
      if (seenIds.has(sessionId)) throw notAuthorized("TRANSCRIPT_DUPLICATE_ID", "transcript evidence JSONL contains duplicate ids", { id: sessionId, line: line.line_number });
      seenIds.add(sessionId);
      headerSessionId = sessionId;
      continue;
    }

    if (headerSessionId === null) {
      throw notAuthorized("TRANSCRIPT_SESSION_HEADER_MISSING", "transcript evidence session JSONL is missing a type=session header before entries", { sessionPath: session.path, line: line.line_number });
    }
    const id = nonEmptyString(entry.id, `transcript line ${line.line_number}.id`);
    const parentId = nullableString(entry.parentId, `transcript line ${line.line_number}.parentId`);
    if (seenIds.has(id)) throw notAuthorized("TRANSCRIPT_DUPLICATE_ID", "transcript evidence JSONL contains duplicate ids", { id, line: line.line_number });
    seenIds.add(id);
    if (parentId !== previousId) {
      throw notAuthorized("TRANSCRIPT_PARENT_CHAIN_BROKEN", "transcript evidence parentId chain is not linearly reachable from after the session header", { line: line.line_number, id, parentId, expectedParentId: previousId });
    }
    previousId = id;

    if (id !== target.messageId) continue;
    if (found) throw notAuthorized("TRANSCRIPT_DUPLICATE_ID", "transcript evidence target message id appears more than once", { messageId: target.messageId, line: line.line_number });
    if (entry.type !== "message") {
      throw notAuthorized("TRANSCRIPT_TARGET_NOT_USER_MESSAGE", "transcript evidence target id does not refer to a message entry", { messageId: target.messageId, line: line.line_number, type: entry.type });
    }
    const message = objectAt(entry.message);
    if (!message || message.role !== "user") {
      throw notAuthorized("TRANSCRIPT_TARGET_NOT_USER_MESSAGE", "transcript evidence target message is not role=user", { messageId: target.messageId, line: line.line_number });
    }
    if (entry.timestamp !== target.timestamp) {
      throw notAuthorized("TRANSCRIPT_TARGET_TIMESTAMP_MISMATCH", "transcript evidence target message timestamp does not match ratification", { messageId: target.messageId, expected: target.timestamp, actual: entry.timestamp });
    }
    found = {
      session_id: headerSessionId,
      role: "user",
      text: extractTranscriptMessageText(message.content),
      parent_id: parentId,
      line_number: line.line_number,
      prefix_sha256: sha256Hex(raw.subarray(0, line.end_including_newline)),
    };
  }

  if (headerSessionId === null) throw notAuthorized("TRANSCRIPT_SESSION_HEADER_MISSING", "transcript evidence session JSONL has no type=session header", { sessionPath: session.path });
  if (headerSessionId !== target.sessionId) {
    throw notAuthorized("TRANSCRIPT_SESSION_ID_MISMATCH", "transcript evidence session id does not match ratification and causal anchor", { expected: target.sessionId, actual: headerSessionId, relativePath: session.relative_path });
  }
  if (!found) {
    throw notAuthorized("TRANSCRIPT_TARGET_NOT_IN_CHAIN", "transcript evidence target user message is not present in the verified parent chain", { sessionPath: session.path, messageId: target.messageId });
  }
  if (found.parent_id !== target.parentId) {
    throw notAuthorized("TRANSCRIPT_TARGET_PARENT_MISMATCH", "transcript evidence target message parentId does not match ratification", { messageId: target.messageId, expected: target.parentId, actual: found.parent_id });
  }
  if (found.line_number !== target.lineNumber) {
    throw notAuthorized("TRANSCRIPT_TARGET_LINE_MISMATCH", "transcript evidence target message line number does not match ratification", { messageId: target.messageId, expected: target.lineNumber, actual: found.line_number });
  }
  if (found.prefix_sha256 !== target.prefixSha256) {
    throw notAuthorized("TRANSCRIPT_PREFIX_SHA256_MISMATCH", "transcript evidence prefix hash including the target user message does not match ratification", { messageId: target.messageId, expected: target.prefixSha256, actual: found.prefix_sha256 });
  }
  return found;
}

function splitJsonlLines(raw: Buffer, sessionPath: string): JsonlLineInfo[] {
  const lines: JsonlLineInfo[] = [];
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    const contentEnd = index > start && raw[index - 1] === 0x0d ? index - 1 : index;
    const text = raw.subarray(start, contentEnd).toString("utf-8");
    if (!text.trim()) throw notAuthorized("TRANSCRIPT_JSONL_INVALID", "transcript evidence session JSONL contains a blank line", { sessionPath, line: lineNumber });
    lines.push({ line_number: lineNumber, text, end_including_newline: index + 1 });
    start = index + 1;
    lineNumber += 1;
  }
  if (start < raw.length) {
    const text = raw.subarray(start).toString("utf-8");
    if (!text.trim()) throw notAuthorized("TRANSCRIPT_JSONL_INVALID", "transcript evidence session JSONL contains a blank final line", { sessionPath, line: lineNumber });
    lines.push({ line_number: lineNumber, text, end_including_newline: raw.length });
  }
  return lines;
}

function extractTranscriptMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
    if (text) return text;
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  throw notAuthorized("TRANSCRIPT_USER_TEXT_UNREADABLE", "transcript user message text is not in a supported text shape");
}

function assertTranscriptTextBindsAuthorization(text: string, options: { tuple: FixedProductionPropositionGenesisTuple; output: EvidenceFilePathInfo }): void {
  const negation = findAuthorizationNegation(text);
  if (negation) {
    throw notAuthorized("TRANSCRIPT_TEXT_NEGATED_AUTHORIZATION", "user transcript text contains a negation term, so it cannot authorize production append", { term: negation });
  }
  const expected = normalizeAuthorizationTemplateText(buildPropositionP0b2ExactAuthorizationTemplate(options.output));
  const normalized = normalizeAuthorizationTemplateText(text);
  const occurrences = countExactOccurrences(normalized, expected);
  if (occurrences !== 1) {
    throw notAuthorized("TRANSCRIPT_TEXT_NOT_EXPLICIT_AUTHORIZATION", "user transcript text must contain exactly one normalized ADR0040 P0b2 Chinese authorization template with all exact bindings", {
      authorization_template_version: PROPOSITION_P0B2_AUTHORIZATION_TEMPLATE_VERSION,
      expected_template_sha256: sha256Hex(expected),
      occurrences,
      previewHash: normalized.includes(PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH),
      eventId: normalized.includes(options.tuple.event_id),
      canonicalBytes: normalized.includes(PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256),
      realAbrain: normalized.includes(PROPOSITION_P0B2_HARD_ABRAIN_REALPATH),
      outputPath: normalized.includes(options.output.path),
      outputRelativePath: normalized.includes(options.output.repo_relative_path),
      outputRelativePathSha256: normalized.includes(options.output.repo_relative_path_sha256),
      targetRelativePath: normalized.includes(options.tuple.relative_path),
    });
  }
}

function normalizeAuthorizationTemplateText(value: string): string {
  return value.replace(/[\t\n\v\f\r ]+/g, " ").trim();
}

function countExactOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function findAuthorizationNegation(text: string): string | null {
  for (const term of PROPOSITION_P0B2_AUTHORIZATION_NEGATION_TERMS) {
    if (/^[a-z]+$/.test(term)) {
      const re = new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, "i");
      if (re.test(text)) return term;
    } else if (text.includes(term)) {
      return term;
    }
  }
  return null;
}

function validateExactlyOneAuthorizedAction(input: unknown, abrainHome: string, tuple: FixedProductionPropositionGenesisTuple, synthetic: boolean): Readonly<Record<string, unknown>> {
  if (!Array.isArray(input) || input.length !== 1) {
    throw notAuthorized("RATIFICATION_ACTION_COUNT_INVALID", "ratification must authorize exactly one action");
  }
  const action = record(input[0], "RATIFICATION_RECORD_INVALID", "authorized action must be an object");
  exactKeys(action, [
    "action",
    "cardinality",
    "abrain_home",
    "target_path",
    "relative_path",
    "event_id",
    "canonical_envelope_bytes_sha256",
    "allowed_write_statuses",
    "prohibited_mutation_classes",
  ], "authorized action");
  exact(action.action, "append_l1_event", "authorized action.action");
  exact(action.cardinality, "exactly_one", "authorized action.cardinality");
  exact(action.abrain_home, abrainHome, "authorized action.abrain_home");
  exact(action.target_path, tuple.target_path, "authorized action.target_path");
  exact(action.relative_path, PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH, "authorized action.relative_path");
  exact(action.relative_path, tuple.relative_path, "authorized action.relative_path");
  exact(action.event_id, PROPOSITION_P0B2_EXPECTED_EVENT_ID, "authorized action.event_id");
  exact(action.canonical_envelope_bytes_sha256, PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256, "authorized action.canonical_envelope_bytes_sha256");
  exactStringArray(action.allowed_write_statuses, ["created", "identical"], "authorized action.allowed_write_statuses");
  exactStringArray(action.prohibited_mutation_classes, ["l2", "state", "rules", "knowledge", "projects", "legacy"], "authorized action.prohibited_mutation_classes");
  if (!synthetic) {
    exact(action.abrain_home, PROPOSITION_P0B2_HARD_ABRAIN_REALPATH, "authorized action.abrain_home");
    exact(action.target_path, PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH, "authorized action.target_path");
  } else if (action.target_path === PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH || action.abrain_home === PROPOSITION_P0B2_HARD_ABRAIN_REALPATH) {
    throw notAuthorized("SYNTHETIC_RATIFICATION_INVALID", "synthetic authorized action must not target real abrain");
  }
  return deepFreeze(action);
}

function validateRatificationConstraints(input: unknown): void {
  const constraints = record(input, "RATIFICATION_RECORD_INVALID", "constraints must be an object");
  exactKeys(constraints, [
    "no_l2_state_legacy_mutation",
    "generic_write_gate_must_remain",
    "post_execute_dossier_outside_abrain",
    "no_runtime_read_flip",
    "no_legacy_authority_retirement",
  ], "constraints");
  exact(constraints.no_l2_state_legacy_mutation, true, "constraints.no_l2_state_legacy_mutation");
  exact(constraints.generic_write_gate_must_remain, "L1_SCHEMA_WRITE_DISABLED", "constraints.generic_write_gate_must_remain");
  exact(constraints.post_execute_dossier_outside_abrain, true, "constraints.post_execute_dossier_outside_abrain");
  exact(constraints.no_runtime_read_flip, true, "constraints.no_runtime_read_flip");
  exact(constraints.no_legacy_authority_retirement, true, "constraints.no_legacy_authority_retirement");
}

async function loadJsonFile(value: string, label: string, code: string): Promise<LoadedJsonFile> {
  if (typeof value !== "string" || !value.trim()) throw failure(code, `${label} path is required`);
  const filePath = path.resolve(value);
  const raw = await fs.readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw failure(code, `${label} is not valid JSON`, { path: filePath, error: errorMessage(err) });
  }
  return { path: filePath, raw, raw_sha256: sha256Hex(raw), parsed };
}

function assertPreviewMatchesTuple(input: unknown, tuple: FixedProductionPropositionGenesisTuple): void {
  const dossier = record(input, "PREVIEW_DOSSIER_INVALID", "preview dossier must be an object");
  assertPreviewConstants(dossier);
  const event = record(dossier.event, "PREVIEW_DOSSIER_INVALID", "preview dossier event must be an object");
  if (event.canonical_envelope_bytes_utf8 !== tuple.canonical_envelope_json) {
    throw notAuthorized("PREVIEW_CANONICAL_BYTES_MISMATCH", "preview canonical envelope bytes do not match the fixed production tuple");
  }
}

function assertPreviewConstants(dossier: Record<string, unknown>): void {
  const event = record(dossier.event, "PREVIEW_DOSSIER_INVALID", "preview dossier event must be an object");
  const target = record(dossier.target, "PREVIEW_DOSSIER_INVALID", "preview dossier target must be an object");
  const registry = record(dossier.registry, "PREVIEW_DOSSIER_INVALID", "preview dossier registry must be an object");
  const schema = record(dossier.proposition_schema_contract, "PREVIEW_DOSSIER_INVALID", "preview dossier proposition_schema_contract must be an object");
  exact(event.event_id, PROPOSITION_P0B2_EXPECTED_EVENT_ID, "preview.event.event_id");
  exact(event.body_hash, PROPOSITION_P0B2_EXPECTED_EVENT_ID, "preview.event.body_hash");
  exact(event.body_canonical_sha256, PROPOSITION_P0B2_EXPECTED_EVENT_ID, "preview.event.body_canonical_sha256");
  exact(event.envelope_canonical_sha256, PROPOSITION_P0B2_EXPECTED_ENVELOPE_CANONICAL_SHA256, "preview.event.envelope_canonical_sha256");
  exact(event.canonical_envelope_bytes_sha256, PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256, "preview.event.canonical_envelope_bytes_sha256");
  exact(target.abrain_realpath, PROPOSITION_P0B2_HARD_ABRAIN_REALPATH, "preview.target.abrain_realpath");
  exact(target.target_path, PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH, "preview.target.target_path");
  exact(target.relative_path, PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH, "preview.target.relative_path");
  exact(registry.registry_id, PROPOSITION_P0B2_EXPECTED_REGISTRY_ID, "preview.registry.registry_id");
  exact(registry.registry_canonical_sha256, PROPOSITION_P0B2_EXPECTED_REGISTRY_CANONICAL_SHA256, "preview.registry.registry_canonical_sha256");
  exact(registry.registry_file_sha256, PROPOSITION_P0B2_EXPECTED_REGISTRY_FILE_SHA256, "preview.registry.registry_file_sha256");
  exact(schema.schema_contract_hash, PROPOSITION_P0B2_EXPECTED_SCHEMA_CONTRACT_HASH, "preview.proposition_schema_contract.schema_contract_hash");
  exact(schema.binding_manifest_hash, PROPOSITION_P0B2_EXPECTED_BINDING_MANIFEST_HASH, "preview.proposition_schema_contract.binding_manifest_hash");
}

function assertFixedProductionTuple(tuple: FixedProductionPropositionGenesisTuple): void {
  exact(tuple.event_id, PROPOSITION_P0B2_EXPECTED_EVENT_ID, "tuple.event_id");
  exact(tuple.relative_path, PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH, "tuple.relative_path");
  exact(tuple.registry_id, PROPOSITION_P0B2_EXPECTED_REGISTRY_ID, "tuple.registry_id");
  exact(tuple.registry_canonical_sha256, PROPOSITION_P0B2_EXPECTED_REGISTRY_CANONICAL_SHA256, "tuple.registry_canonical_sha256");
  exact(tuple.registry_file_sha256, PROPOSITION_P0B2_EXPECTED_REGISTRY_FILE_SHA256, "tuple.registry_file_sha256");
  exact(tuple.proposition_schema_contract_hash, PROPOSITION_P0B2_EXPECTED_SCHEMA_CONTRACT_HASH, "tuple.proposition_schema_contract_hash");
  exact(tuple.binding_manifest_hash, PROPOSITION_P0B2_EXPECTED_BINDING_MANIFEST_HASH, "tuple.binding_manifest_hash");
  exact(sha256Hex(tuple.canonical_envelope_json), PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256, "tuple.canonical_envelope_json sha256");
}

async function resolveExecuteAbrainHome(input: string, mode: "production" | "sandbox"): Promise<{ resolved: string; realpath: string }> {
  if (typeof input !== "string" || !input.trim()) throw failure("PROPOSITION_P0B2_REAL_TARGET_REQUIRED", "--abrain must be explicit");
  const resolved = path.resolve(input);
  if (mode === "production") {
    if (resolved !== PROPOSITION_P0B2_HARD_ABRAIN_REALPATH) {
      throw failure("PROPOSITION_P0B2_REAL_TARGET_REQUIRED", "production execute requires explicit --abrain /home/worker/.abrain", { actual: resolved });
    }
    await assertExistingDirectoryChainNoSymlink(path.parse(resolved).root, resolved, { allowMissingTail: false });
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", "production abrain path must not be a symlink", { path: resolved });
    if (!stat.isDirectory()) throw failure("PROPOSITION_P0B2_NON_DIRECTORY", "production abrain path must be a directory", { path: resolved });
    const realpath = await fs.realpath(resolved);
    if (realpath !== PROPOSITION_P0B2_HARD_ABRAIN_REALPATH) {
      throw failure("PROPOSITION_P0B2_REAL_TARGET_REQUIRED", "production execute requires realpath /home/worker/.abrain", { resolved, realpath });
    }
    return { resolved, realpath };
  }

  await rejectRealAbrain(resolved);
  const tmpRoot = await fs.realpath(os.tmpdir());
  if (!isPathInside(tmpRoot, resolved) || resolved === tmpRoot) {
    throw failure("PROPOSITION_P0B2_SANDBOX_REQUIRED", `sandbox execute fixture must be inside ${tmpRoot}`, { actual: resolved });
  }
  await assertExistingDirectoryChainNoSymlink(tmpRoot, path.dirname(resolved), { allowMissingTail: false });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", "sandbox abrain path must not be a symlink", { path: resolved });
  if (!stat.isDirectory()) throw failure("PROPOSITION_P0B2_NON_DIRECTORY", "sandbox abrain path must be a directory", { path: resolved });
  const realpath = await fs.realpath(resolved);
  await rejectRealAbrain(realpath);
  if (!isPathInside(tmpRoot, realpath)) throw failure("PROPOSITION_P0B2_PATH_ESCAPE", "sandbox realpath escapes temp root", { resolved, realpath, tmpRoot });
  return { resolved, realpath };
}

async function assertPostDossierOutputPathPreflight(value: string, abrainHome: string, repoRoot: string): Promise<EvidenceFilePathInfo> {
  if (typeof value !== "string" || !value.trim()) throw failure("PROPOSITION_P0B2_OUTPUT_REQUIRED", "--out must be an explicit post-execute dossier path in repo docs/evidence");
  const outPath = path.resolve(value);
  const evidenceDir = path.join(repoRoot, ...PROPOSITION_P0B2_EVIDENCE_RELATIVE_DIR.split("/"));
  await assertExistingDirectoryChainNoSymlink(path.parse(evidenceDir).root, evidenceDir, { allowMissingTail: false });
  const evidenceReal = await fs.realpath(evidenceDir);
  if (path.dirname(outPath) !== evidenceDir) {
    throw failure("PROPOSITION_P0B2_OUTPUT_NOT_IN_EVIDENCE_DIR", "post-execute dossier output must be a direct file under repo docs/evidence", { outPath, evidenceDir });
  }
  if (path.extname(outPath) !== ".json") {
    throw failure("PROPOSITION_P0B2_OUTPUT_EXTENSION_INVALID", "post-execute dossier output must be a .json evidence file", { outPath });
  }
  if (outPath === path.resolve(abrainHome) || isPathInside(abrainHome, outPath) || outPath === PROPOSITION_P0B2_HARD_ABRAIN_REALPATH || isPathInside(PROPOSITION_P0B2_HARD_ABRAIN_REALPATH, outPath)) {
    throw failure("PROPOSITION_P0B2_OUTPUT_IN_ABRAIN", "post-execute dossier output must not be under abrain", { outPath, abrainHome });
  }
  const parentReal = await fs.realpath(path.dirname(outPath));
  if (parentReal !== evidenceReal) {
    throw failure("PROPOSITION_P0B2_OUTPUT_SYMLINK_REJECTED", "post-execute dossier output parent must resolve to repo docs/evidence without symlinks", { outPath, parentReal, evidenceReal });
  }
  const stat = await fs.lstat(outPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (stat?.isSymbolicLink()) throw failure("PROPOSITION_P0B2_OUTPUT_SYMLINK_REJECTED", "post-execute dossier output must not be a symlink", { outPath });
  if (stat) throw failure("PROPOSITION_P0B2_OUTPUT_EXISTS", "post-execute dossier output must not already exist", { outPath });
  const repoRelative = repoRelativePath(repoRoot, outPath);
  return deepFreeze({
    path: outPath,
    evidence_dir: evidenceDir,
    repo_relative_path: repoRelative,
    repo_relative_path_sha256: sha256Hex(repoRelative),
  });
}

async function analyzeTargetWritePreflight(abrainHome: string, tuple: FixedProductionPropositionGenesisTuple): Promise<Readonly<Record<string, unknown>>> {
  const expectedTarget = expectedL1EventPath(abrainHome, tuple.event_id);
  if (tuple.target_path !== expectedTarget) throw failure("PROPOSITION_P0B2_TARGET_MISMATCH", "target path does not derive from event_id and abrain home", { expectedTarget, actual: tuple.target_path });
  if (tuple.relative_path !== expectedL1EventRelativePath(tuple.event_id)) throw failure("PROPOSITION_P0B2_TARGET_MISMATCH", "relative target path does not derive from event_id", { actual: tuple.relative_path });
  if (!isPathInside(abrainHome, tuple.target_path)) throw failure("PROPOSITION_P0B2_PATH_ESCAPE", "target path escapes abrain home", { targetPath: tuple.target_path });
  const parent = path.dirname(tuple.target_path);
  const chain = await assertExistingDirectoryChainNoSymlink(abrainHome, parent, { allowMissingTail: true });
  const stat = await fs.lstat(tuple.target_path).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) {
    return deepFreeze({
      ok: true,
      abrain_home: abrainHome,
      target_path: tuple.target_path,
      relative_path: tuple.relative_path,
      target_absent: true,
      target_exists: false,
      recovery_candidate: false,
      parent_path: parent,
      parent_exists: chain.missing.length === 0,
      missing_parent_components: chain.missing,
      checked_existing_directories: chain.checked,
    });
  }
  if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", "target leaf must not be a symlink", { targetPath: tuple.target_path });
  if (!stat.isFile()) throw failure("PROPOSITION_P0B2_NON_REGULAR", "target path must be a regular file", { targetPath: tuple.target_path });
  await assertExistingFileNoSymlink(abrainHome, tuple.target_path);
  const existing = await fs.readFile(tuple.target_path, "utf-8");
  const existingSha256 = sha256Hex(existing);
  if (existing !== tuple.canonical_envelope_json) {
    throw failure("PROPOSITION_P0B2_COLLISION", "production genesis target exists with different bytes; refusing replacement", { targetPath: tuple.target_path, existingSha256, expectedSha256: sha256Hex(tuple.canonical_envelope_json) });
  }
  return deepFreeze({
    ok: true,
    abrain_home: abrainHome,
    target_path: tuple.target_path,
    relative_path: tuple.relative_path,
    target_absent: false,
    target_exists: true,
    target_existing_identical: true,
    target_existing_sha256: existingSha256,
    recovery_candidate: true,
    parent_path: parent,
    parent_exists: true,
    missing_parent_components: [],
    checked_existing_directories: chain.checked,
  });
}

async function createTargetParentNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  await assertExistingDirectoryChainNoSymlink(abrainHome, path.dirname(targetPath), { allowMissingTail: true });
  const homeReal = await fs.realpath(abrainHome);
  const parent = path.dirname(targetPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertExistingDirectoryChainNoSymlink(abrainHome, parent, { allowMissingTail: false });
  const parentReal = await fs.realpath(parent);
  if (!isPathInside(homeReal, parentReal)) throw failure("PROPOSITION_P0B2_PATH_ESCAPE", "target parent realpath escapes abrain home", { parentReal, homeReal });
  const leaf = await fs.lstat(targetPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (leaf?.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", "target leaf must not be a symlink", { targetPath });
}

function executionIntentPath(repoRoot: string, tuple: FixedProductionPropositionGenesisTuple, output: EvidenceFilePathInfo): string {
  const name = `adr0040-p0b2-execution-intent-${tuple.event_id.slice(0, 16)}-${output.repo_relative_path_sha256.slice(0, 16)}.json`;
  return path.join(repoRoot, ...PROPOSITION_P0B2_EVIDENCE_RELATIVE_DIR.split("/"), name);
}

function buildExecutionIntent(input: {
  repoRoot: string;
  abrain: { resolved: string; realpath: string };
  tuple: FixedProductionPropositionGenesisTuple;
  output: EvidenceFilePathInfo;
  ratification: Readonly<Record<string, unknown>>;
  preview: LoadedJsonFile;
  targetPreflight: Readonly<Record<string, unknown>>;
  beforeInventory: InventorySnapshot;
  beforeSurfaces: Readonly<Record<string, unknown>>;
  beforeScan: WholeL1ScanResult;
  beforeEpoch: Readonly<Record<string, unknown>>;
  genericGateBefore: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  const authorizationEvidence = objectAt(input.ratification.authorization_evidence) ?? {};
  const transcriptEvidence = objectAt(authorizationEvidence.transcript_evidence);
  const intent: Record<string, unknown> = {
    schema_version: PROPOSITION_P0B2_EXECUTION_INTENT_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    intent_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this execution-intent object with intent_hash omitted",
    intent_hash: "",
    repo_root: input.repoRoot,
    mode: "execute",
    preview_dossier: {
      path: input.preview.path,
      raw_sha256: input.preview.raw_sha256,
      dossier_hash: PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH,
    },
    target: {
      abrain_home: input.abrain.resolved,
      abrain_realpath: input.abrain.realpath,
      target_path: input.tuple.target_path,
      relative_path: input.tuple.relative_path,
      event_id: input.tuple.event_id,
    },
    event: {
      event_id: input.tuple.event_id,
      canonical_envelope_bytes_sha256: sha256Hex(input.tuple.canonical_envelope_json),
      canonical_envelope_json: input.tuple.canonical_envelope_json,
    },
    output: {
      path: input.output.path,
      repo_relative_path: input.output.repo_relative_path,
      repo_relative_path_sha256: input.output.repo_relative_path_sha256,
    },
    ratification: {
      path: input.ratification.path,
      raw_sha256: input.ratification.raw_sha256,
      record_hash: input.ratification.record_hash,
      synthetic_fixture: input.ratification.synthetic_fixture,
      production_usable: input.ratification.production_usable,
      authorization_evidence_sha256: jcsSha256Hex(authorizationEvidence),
      transcript_evidence_sha256: transcriptEvidence ? jcsSha256Hex(transcriptEvidence) : null,
    },
    preflight: {
      target_preflight: input.targetPreflight,
      before_epoch: input.beforeEpoch,
      before_inventory: {
        entries_sha256: input.beforeInventory.entries_sha256,
        entries: input.beforeInventory.entries,
      },
      before_surfaces: input.beforeSurfaces,
      before_scan: summarizeScanForDossier(input.beforeScan),
      generic_validateL1WritePreflight_before: input.genericGateBefore,
    },
  };
  intent.intent_hash = selfHashExecutionIntent(intent);
  return deepFreeze(intent);
}

async function createOrLoadExecutionIntent(intentPath: string, intent: Readonly<Record<string, unknown>>, context: ExecutionIntentValidationContext): Promise<ExecutionIntentWriteResult> {
  await assertEvidenceFileTarget(intentPath, context.repoRoot, "execution intent");
  const content = `${JSON.stringify(intent, null, 2)}\n`;
  const status = await durableAtomicCreateFile(intentPath, content, { mode: 0o644 });
  if (status === "created") {
    return { path: intentPath, raw_sha256: sha256Hex(content), intent_hash: String(intent.intent_hash), status, intent };
  }
  if (status === "identical") {
    return loadAndValidateExecutionIntent(intentPath, context, status);
  }
  return loadAndValidateExecutionIntent(intentPath, context, "existing_valid");
}

async function loadExistingExecutionIntent(intentPath: string, context: ExecutionIntentValidationContext): Promise<ExecutionIntentWriteResult> {
  await assertEvidenceFileTarget(intentPath, context.repoRoot, "execution intent");
  const stat = await fs.lstat(intentPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) {
    throw failure("PROPOSITION_P0B2_RECOVERY_INTENT_MISSING", "target already exists with matching bytes but the required execution-intent record is missing", { intentPath, targetPath: context.tuple.target_path });
  }
  return loadAndValidateExecutionIntent(intentPath, context, "existing_valid");
}

interface ExecutionIntentValidationContext {
  repoRoot: string;
  abrain: { resolved: string; realpath: string };
  tuple: FixedProductionPropositionGenesisTuple;
  output: EvidenceFilePathInfo;
  ratification: Readonly<Record<string, unknown>>;
  preview: LoadedJsonFile;
}

async function loadAndValidateExecutionIntent(intentPath: string, context: ExecutionIntentValidationContext, status: DurableCreateStatus | "existing_valid"): Promise<ExecutionIntentWriteResult> {
  const loaded = await loadJsonFile(intentPath, "execution intent", "PROPOSITION_P0B2_INTENT_INVALID").catch((err: unknown) => {
    throw failure("PROPOSITION_P0B2_INTENT_INVALID", "execution-intent record is unreadable", { intentPath, error: errorMessage(err) });
  });
  const intent = record(loaded.parsed, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent must be an object");
  exact(intent.schema_version, PROPOSITION_P0B2_EXECUTION_INTENT_SCHEMA, "execution_intent.schema_version");
  exact(intent.canonicalization, "RFC8785-JCS", "execution_intent.canonicalization");
  exact(intent.hash_algorithm, "sha256", "execution_intent.hash_algorithm");
  exact(intent.intent_hash_scope, "sha256 over RFC8785-JCS UTF-8 bytes of this execution-intent object with intent_hash omitted", "execution_intent.intent_hash_scope");
  sha256HexString(intent.intent_hash, "execution_intent.intent_hash");
  const actualHash = selfHashExecutionIntent(intent);
  if (intent.intent_hash !== actualHash) throw failure("PROPOSITION_P0B2_INTENT_HASH_MISMATCH", "execution-intent self-hash is invalid", { expected: intent.intent_hash, actual: actualHash, intentPath });
  exact(intent.repo_root, context.repoRoot, "execution_intent.repo_root");
  exact(intent.mode, "execute", "execution_intent.mode");

  const preview = record(intent.preview_dossier, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent preview_dossier must be an object");
  exact(preview.path, context.preview.path, "execution_intent.preview_dossier.path");
  exact(preview.raw_sha256, context.preview.raw_sha256, "execution_intent.preview_dossier.raw_sha256");
  exact(preview.dossier_hash, PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH, "execution_intent.preview_dossier.dossier_hash");

  const target = record(intent.target, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent target must be an object");
  exact(target.abrain_home, context.abrain.resolved, "execution_intent.target.abrain_home");
  exact(target.abrain_realpath, context.abrain.realpath, "execution_intent.target.abrain_realpath");
  exact(target.target_path, context.tuple.target_path, "execution_intent.target.target_path");
  exact(target.relative_path, context.tuple.relative_path, "execution_intent.target.relative_path");
  exact(target.event_id, context.tuple.event_id, "execution_intent.target.event_id");

  const event = record(intent.event, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent event must be an object");
  exact(event.event_id, context.tuple.event_id, "execution_intent.event.event_id");
  exact(event.canonical_envelope_bytes_sha256, PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256, "execution_intent.event.canonical_envelope_bytes_sha256");
  exact(event.canonical_envelope_json, context.tuple.canonical_envelope_json, "execution_intent.event.canonical_envelope_json");

  const output = record(intent.output, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent output must be an object");
  exact(output.path, context.output.path, "execution_intent.output.path");
  exact(output.repo_relative_path, context.output.repo_relative_path, "execution_intent.output.repo_relative_path");
  exact(output.repo_relative_path_sha256, context.output.repo_relative_path_sha256, "execution_intent.output.repo_relative_path_sha256");

  const ratification = record(intent.ratification, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent ratification must be an object");
  exact(ratification.path, context.ratification.path, "execution_intent.ratification.path");
  exact(ratification.raw_sha256, context.ratification.raw_sha256, "execution_intent.ratification.raw_sha256");
  exact(ratification.record_hash, context.ratification.record_hash, "execution_intent.ratification.record_hash");
  exact(ratification.synthetic_fixture, context.ratification.synthetic_fixture, "execution_intent.ratification.synthetic_fixture");
  exact(ratification.production_usable, context.ratification.production_usable, "execution_intent.ratification.production_usable");
  const authorizationEvidence = objectAt(context.ratification.authorization_evidence) ?? {};
  exact(ratification.authorization_evidence_sha256, jcsSha256Hex(authorizationEvidence), "execution_intent.ratification.authorization_evidence_sha256");
  const transcriptEvidence = objectAt(authorizationEvidence.transcript_evidence);
  exact(ratification.transcript_evidence_sha256, transcriptEvidence ? jcsSha256Hex(transcriptEvidence) : null, "execution_intent.ratification.transcript_evidence_sha256");

  const preflight = record(intent.preflight, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent preflight must be an object");
  record(preflight.target_preflight, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent target_preflight must be an object");
  record(preflight.before_epoch, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_epoch must be an object");
  const beforeInventory = record(preflight.before_inventory, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_inventory must be an object");
  sha256HexString(beforeInventory.entries_sha256, "execution_intent.preflight.before_inventory.entries_sha256");
  if (!Array.isArray(beforeInventory.entries)) throw failure("PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_inventory.entries must be an array");
  record(preflight.before_surfaces, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_surfaces must be an object");
  record(preflight.before_scan, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_scan must be an object");
  record(preflight.generic_validateL1WritePreflight_before, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent generic preflight must be an object");
  return { path: loaded.path, raw_sha256: loaded.raw_sha256, intent_hash: String(intent.intent_hash), status, intent: deepFreeze(intent) };
}

async function assertEvidenceFileTarget(filePath: string, repoRoot: string, label: string): Promise<void> {
  const evidenceDir = path.join(repoRoot, ...PROPOSITION_P0B2_EVIDENCE_RELATIVE_DIR.split("/"));
  await assertExistingDirectoryChainNoSymlink(path.parse(evidenceDir).root, evidenceDir, { allowMissingTail: false });
  if (path.dirname(path.resolve(filePath)) !== evidenceDir) {
    throw failure("PROPOSITION_P0B2_EVIDENCE_PATH_INVALID", `${label} must be a direct file under repo docs/evidence`, { filePath, evidenceDir });
  }
  const parentReal = await fs.realpath(path.dirname(filePath));
  const evidenceReal = await fs.realpath(evidenceDir);
  if (parentReal !== evidenceReal) throw failure("PROPOSITION_P0B2_EVIDENCE_SYMLINK_REJECTED", `${label} parent must not traverse symlinks`, { filePath, parentReal, evidenceReal });
  const stat = await fs.lstat(filePath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (stat?.isSymbolicLink()) throw failure("PROPOSITION_P0B2_EVIDENCE_SYMLINK_REJECTED", `${label} file must not be a symlink`, { filePath });
  if (stat && !stat.isFile()) throw failure("PROPOSITION_P0B2_EVIDENCE_NON_REGULAR", `${label} path must be a regular file when it exists`, { filePath });
}

function intentPreflight(intent: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return record(intent.preflight, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent preflight must be an object");
}

function intentBeforeScanForDossier(intent: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return deepFreeze(record(intentPreflight(intent).before_scan, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_scan must be an object"));
}

function intentBeforeEpoch(intent: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return deepFreeze(record(intentPreflight(intent).before_epoch, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_epoch must be an object"));
}

function intentGenericGateBefore(intent: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return deepFreeze(record(intentPreflight(intent).generic_validateL1WritePreflight_before, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent generic gate must be an object"));
}

function intentBeforeSurfaces(intent: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return deepFreeze(record(intentPreflight(intent).before_surfaces, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_surfaces must be an object"));
}

function intentBeforeInventory(intent: Readonly<Record<string, unknown>>): InventorySnapshot {
  const beforeInventory = record(intentPreflight(intent).before_inventory, "PROPOSITION_P0B2_INTENT_INVALID", "execution intent before_inventory must be an object");
  const snapshot = inventorySnapshotFromEntries(beforeInventory.entries);
  exact(beforeInventory.entries_sha256, snapshot.entries_sha256, "execution_intent.preflight.before_inventory.entries_sha256");
  return snapshot;
}

function inventorySnapshotFromEntries(input: unknown): InventorySnapshot {
  if (!Array.isArray(input)) throw failure("PROPOSITION_P0B2_INTENT_INVALID", "inventory entries must be an array");
  const entries = input.map((item, index) => {
    const entry = record(item, "PROPOSITION_P0B2_INTENT_INVALID", `inventory entry ${index} must be an object`);
    const rel = nonEmptyString(entry.path, `inventory entry ${index}.path`);
    const type = oneOf(entry.type, ["directory", "file", "symlink", "other"] as const, `inventory entry ${index}.type`);
    const out: InventoryEntry = { path: rel, type };
    if (entry.size !== undefined) out.size = Number(entry.size);
    if (entry.sha256 !== undefined) out.sha256 = sha256HexString(entry.sha256, `inventory entry ${index}.sha256`);
    if (entry.link_target !== undefined) out.link_target = nonEmptyString(entry.link_target, `inventory entry ${index}.link_target`);
    if (entry.link_target_sha256 !== undefined) out.link_target_sha256 = sha256HexString(entry.link_target_sha256, `inventory entry ${index}.link_target_sha256`);
    return out;
  }).sort((left, right) => compareCodeUnits(left.path, right.path));
  return deepFreeze({ entries, entries_sha256: jcsSha256Hex(entries), byPath: new Map(entries.map((entry) => [entry.path, entry])) });
}

function compareSelectedFoldableFromIntent(intent: Readonly<Record<string, unknown>>, after: WholeL1ScanResult): Readonly<Record<string, unknown>> {
  const before = intentBeforeScanForDossier(intent);
  const beforeSelected = exactStringArrayValue(before.selected_event_ids, "execution_intent.before_scan.selected_event_ids").sort(compareCodeUnits);
  const beforeFoldable = exactStringArrayValue(before.foldable_event_ids, "execution_intent.before_scan.foldable_event_ids").sort(compareCodeUnits);
  const beforeDefinedInactive = exactStringArrayValue(before.defined_inactive_shadow_event_ids, "execution_intent.before_scan.defined_inactive_shadow_event_ids").sort(compareCodeUnits);
  const afterSelected = after.selected.map((record) => record.eventId).sort(compareCodeUnits);
  const afterFoldable = after.foldable.map((record) => record.eventId).sort(compareCodeUnits);
  return deepFreeze({
    before_selected_count: beforeSelected.length,
    after_selected_count: afterSelected.length,
    before_selected_event_ids_sha256: jcsSha256Hex(beforeSelected),
    after_selected_event_ids_sha256: jcsSha256Hex(afterSelected),
    selected_unchanged: jcsSha256Hex(beforeSelected) === jcsSha256Hex(afterSelected),
    before_foldable_count: beforeFoldable.length,
    after_foldable_count: afterFoldable.length,
    before_foldable_event_ids_sha256: jcsSha256Hex(beforeFoldable),
    after_foldable_event_ids_sha256: jcsSha256Hex(afterFoldable),
    foldable_unchanged: jcsSha256Hex(beforeFoldable) === jcsSha256Hex(afterFoldable),
    before_defined_inactive_shadow_count: beforeDefinedInactive.length,
    after_defined_inactive_shadow_count: after.definedInactiveShadow.length,
  });
}

function repoRelativePath(repoRoot: string, filePath: string): string {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw failure("PROPOSITION_P0B2_EVIDENCE_PATH_INVALID", "path is not inside repo root", { repoRoot, filePath });
  }
  return relative.split(path.sep).join("/");
}

async function assertExistingDirectoryChainNoSymlink(root: string, targetDir: string, options: { allowMissingTail: boolean }): Promise<{ checked: string[]; missing: string[] }> {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(targetDir);
  const relative = path.relative(rootResolved, targetResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("PROPOSITION_P0B2_PATH_ESCAPE", "directory chain escapes root", { root: rootResolved, targetDir: targetResolved });
  const checked: string[] = [];
  let current = rootResolved;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", `symlink in directory chain: ${current}`);
  if (!rootStat.isDirectory()) throw failure("PROPOSITION_P0B2_NON_DIRECTORY", `directory chain root is not a directory: ${current}`);
  checked.push(current);
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    const stat = await fs.lstat(current).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat) {
      if (!options.allowMissingTail) throw failure("PROPOSITION_P0B2_PATH_MISSING", `missing directory in chain: ${current}`);
      return { checked, missing: components.slice(index) };
    }
    if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", `symlink in directory chain: ${current}`);
    if (!stat.isDirectory()) throw failure("PROPOSITION_P0B2_NON_DIRECTORY", `directory chain component is not a directory: ${current}`);
    checked.push(current);
  }
  return { checked, missing: [] };
}

function assertPreExecuteEpochState(scan: WholeL1ScanResult, tuple: FixedProductionPropositionGenesisTuple): Readonly<Record<string, unknown>> {
  const proposition = scan.all.filter((record) => record.registration.domain === "proposition");
  if (proposition.length !== 0) {
    throw failure("PROPOSITION_P0B2_PROPOSITION_EVENTS_PRESENT", "execute requires zero existing proposition events before the production genesis append", {
      propositionCount: proposition.length,
      expectedEventId: tuple.event_id,
    });
  }
  return deepFreeze({
    ok: true,
    proposition_event_count: 0,
    production_genesis_count: 0,
    expected_epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    expected_event_id: tuple.event_id,
  });
}

function assertPostExecuteEpochState(scan: WholeL1ScanResult, tuple: FixedProductionPropositionGenesisTuple): Readonly<Record<string, unknown>> {
  const proposition = scan.all.filter((record) => record.registration.domain === "proposition");
  const productionGenesis = proposition.filter(isProductionGenesisRecord);
  if (proposition.length !== 1 || productionGenesis.length !== 1 || productionGenesis[0]?.eventId !== tuple.event_id) {
    throw failure("PROPOSITION_P0B2_POST_EPOCH_INVALID", "post-execute L1 must contain exactly the fixed production genesis and no other proposition events", {
      propositionCount: proposition.length,
      productionGenesisCount: productionGenesis.length,
      eventIds: proposition.map((record) => record.eventId).sort(compareCodeUnits),
      expectedEventId: tuple.event_id,
    });
  }
  return deepFreeze({
    ok: true,
    proposition_event_count: 1,
    production_genesis_count: 1,
    expected_epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    expected_event_id: tuple.event_id,
  });
}

function isProductionGenesisRecord(record: ValidatedL1ScanRecord): boolean {
  return record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA
    && isRecord(record.body.epoch)
    && record.body.epoch.genesis_scope === "production"
    && isRecord(record.body.contract)
    && record.body.contract.kind === "production_genesis";
}

async function readExecutedProductionGenesis(options: { abrainHome: string; eventId: string; registryPath: string }): Promise<ExecutedProductionGenesisReadback> {
  const registry = loadL1SchemaRegistry(options.registryPath);
  const targetPath = expectedL1EventPath(options.abrainHome, options.eventId);
  const relativePath = expectedL1EventRelativePath(options.eventId);
  await assertExistingFileNoSymlink(options.abrainHome, targetPath);
  const raw = await fs.readFile(targetPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw failure("PROPOSITION_P0B2_READBACK_INVALID", "production genesis event is not valid JSON", { error: errorMessage(err), targetPath });
  }
  const validated = validateL1Envelope(parsed, {
    registry,
    abrainHome: options.abrainHome,
    filePath: targetPath,
    relativePath,
    expected: propositionGenesisExpectation(),
  });
  const body = validatePropositionGenesisBody(validated.body) as PropositionGenesisBodyV1;
  if (body.epoch.epoch_id !== PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID || body.epoch.genesis_scope !== "production") {
    throw failure("PROPOSITION_P0B2_READBACK_INVALID", "readback event is not the fixed production genesis", { targetPath });
  }
  const envelope = parsed as PropositionL1Envelope<PropositionGenesisBodyV1>;
  const canonicalEnvelopeJson = canonicalL1EnvelopeJson(envelope);
  return deepFreeze({
    event_id: options.eventId,
    relative_path: relativePath,
    target_path: targetPath,
    raw,
    canonical_envelope_json: canonicalEnvelopeJson,
    byte_identical: raw === canonicalEnvelopeJson,
    envelope,
  });
}

async function assertExistingFileNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  await assertExistingDirectoryChainNoSymlink(abrainHome, path.dirname(targetPath), { allowMissingTail: false });
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", "target file is a symlink", { targetPath });
  if (!stat.isFile()) throw failure("PROPOSITION_P0B2_NON_REGULAR", "target path is not a regular file", { targetPath });
  const homeReal = await fs.realpath(abrainHome);
  const fileReal = await fs.realpath(targetPath);
  if (!isPathInside(homeReal, fileReal)) throw failure("PROPOSITION_P0B2_PATH_ESCAPE", "target file realpath escapes abrain home", { fileReal, homeReal });
}

function propositionGenesisExpectation(): L1EnvelopeExpectation {
  return {
    envelopeSchema: PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
    domain: "proposition",
    role: "meta",
    producer: PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
    eventType: "proposition_genesis_declared",
  };
}

async function expectCode(fn: () => Promise<unknown>): Promise<Readonly<Record<string, unknown>>> {
  try {
    await fn();
    return deepFreeze({ ok: false, code: null, message: "operation unexpectedly succeeded" });
  } catch (err) {
    return deepFreeze({ ok: true, code: errorCode(err), message: errorMessage(err) });
  }
}

function assertGenericGateDisabled(gate: Readonly<Record<string, unknown>>, phase: string): void {
  if (gate.code !== "L1_SCHEMA_WRITE_DISABLED") {
    throw failure("PROPOSITION_P0B2_GENERIC_PREFLIGHT_DRIFT", `generic L1 write preflight did not stay disabled ${phase} execute`, { gate });
  }
}

interface InventoryEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size?: number;
  sha256?: string;
  link_target?: string;
  link_target_sha256?: string;
}

interface InventorySnapshot {
  entries: readonly InventoryEntry[];
  entries_sha256: string;
  byPath: ReadonlyMap<string, InventoryEntry>;
}

async function collectFullInventory(root: string, allowedDurableCreateTargets: readonly string[] = []): Promise<InventorySnapshot> {
  const entries: InventoryEntry[] = [];
  if (fss.existsSync(root)) await walkInventoryRoot(root, root, entries, { includeRoot: false, allowedDurableCreateTargets });
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return deepFreeze({ entries, entries_sha256: jcsSha256Hex(entries), byPath: new Map(entries.map((entry) => [entry.path, entry])) });
}

async function walkInventoryRoot(root: string, full: string, out: InventoryEntry[], options: { includeRoot: boolean; allowedDurableCreateTargets?: readonly string[] }): Promise<void> {
  const stat = await fs.lstat(full).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) return;
  if (isAllowedDurableCreateTempArtifact(full, stat, options.allowedDurableCreateTargets ?? [])) return;
  const rel = path.relative(root, full).split(path.sep).join("/");
  if (rel || options.includeRoot) {
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(full).catch((err: unknown) => {
        if (isNodeError(err) && err.code === "ENOENT") return null;
        throw err;
      });
      if (link === null) return;
      out.push({ path: rel, type: "symlink", link_target: link, link_target_sha256: sha256Hex(link) });
      return;
    }
    if (stat.isFile()) {
      const content = await fs.readFile(full).catch((err: unknown) => {
        if (isNodeError(err) && err.code === "ENOENT") return null;
        throw err;
      });
      if (content === null) return;
      out.push({ path: rel, type: "file", size: stat.size, sha256: sha256Hex(content) });
      return;
    }
    if (!stat.isDirectory()) {
      out.push({ path: rel, type: "other" });
      return;
    }
    out.push({ path: rel, type: "directory" });
  }
  if (!stat.isDirectory()) return;
  const children = await fs.readdir(full, { withFileTypes: true }).then(
    (entries) => entries.map((entry) => entry.name).sort(compareCodeUnits),
    (err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return [];
      throw err;
    },
  );
  for (const child of children) await walkInventoryRoot(root, path.join(full, child), out, { includeRoot: true, allowedDurableCreateTargets: options.allowedDurableCreateTargets });
}

function isAllowedDurableCreateTempArtifact(full: string, stat: fss.Stats, allowedTargets: readonly string[]): boolean {
  if (!stat.isFile()) return false;
  const resolved = path.resolve(full);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  return allowedTargets.some((target) => {
    const targetResolved = path.resolve(target);
    return path.dirname(targetResolved) === dir && durableAtomicCreateTempBasenameRegex(path.basename(targetResolved)).test(base);
  });
}

function durableAtomicCreateTempBasenameRegex(targetBasename: string): RegExp {
  return new RegExp(`^\\.${escapeRegExp(targetBasename)}\\.\\d+\\.\\d+\\.[0-9a-f]{16}\\.tmp$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectProtectedSurfaces(abrainHome: string): Promise<Readonly<Record<string, unknown>>> {
  return deepFreeze({
    l2: await collectSurface(abrainHome, ["l2"]),
    state: await collectSurface(abrainHome, [".state"]),
    rules: await collectSurface(abrainHome, ["rules", ...projectChildSurfaceRoots(abrainHome, "rules")]),
    knowledge: await collectSurface(abrainHome, ["knowledge", ...projectChildSurfaceRoots(abrainHome, "knowledge")]),
    projects: await collectSurface(abrainHome, ["projects"]),
  });
}

function projectChildSurfaceRoots(abrainHome: string, childName: string): string[] {
  const projectsRoot = path.join(abrainHome, "projects");
  if (!fss.existsSync(projectsRoot)) return [];
  return fss.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fss.existsSync(path.join(projectsRoot, entry.name, childName)))
    .map((entry) => `projects/${entry.name}/${childName}`)
    .sort(compareCodeUnits);
}

async function collectSurface(root: string, relativeRoots: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
  const entries: InventoryEntry[] = [];
  const roots: string[] = [];
  for (const rel of relativeRoots) {
    const full = path.join(root, ...rel.split("/"));
    if (!fss.existsSync(full)) continue;
    roots.push(rel);
    await walkInventoryRoot(root, full, entries, { includeRoot: true });
  }
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return deepFreeze({ roots, exists: roots.length > 0, entry_count: entries.length, entries_sha256: jcsSha256Hex(entries), entries });
}

function compareProtectedSurfaces(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const keys = ["l2", "state", "rules", "knowledge", "projects"];
  const comparisons: Record<string, unknown> = {};
  let ok = true;
  for (const key of keys) {
    const beforeSurface = record(before[key], "PROPOSITION_P0B2_SURFACE_INVALID", `before ${key} surface must be an object`);
    const afterSurface = record(after[key], "PROPOSITION_P0B2_SURFACE_INVALID", `after ${key} surface must be an object`);
    const unchanged = beforeSurface.entries_sha256 === afterSurface.entries_sha256 && beforeSurface.entry_count === afterSurface.entry_count;
    ok = ok && unchanged;
    comparisons[key] = {
      unchanged,
      before_entries_sha256: beforeSurface.entries_sha256,
      after_entries_sha256: afterSurface.entries_sha256,
      before_entry_count: beforeSurface.entry_count,
      after_entry_count: afterSurface.entry_count,
    };
  }
  return deepFreeze({ no_l2_state_or_legacy_change: ok, comparisons });
}

function compareSelectedFoldable(before: WholeL1ScanResult, after: WholeL1ScanResult): Readonly<Record<string, unknown>> {
  const beforeSelected = before.selected.map((record) => record.eventId).sort(compareCodeUnits);
  const afterSelected = after.selected.map((record) => record.eventId).sort(compareCodeUnits);
  const beforeFoldable = before.foldable.map((record) => record.eventId).sort(compareCodeUnits);
  const afterFoldable = after.foldable.map((record) => record.eventId).sort(compareCodeUnits);
  return deepFreeze({
    before_selected_count: beforeSelected.length,
    after_selected_count: afterSelected.length,
    before_selected_event_ids_sha256: jcsSha256Hex(beforeSelected),
    after_selected_event_ids_sha256: jcsSha256Hex(afterSelected),
    selected_unchanged: jcsSha256Hex(beforeSelected) === jcsSha256Hex(afterSelected),
    before_foldable_count: beforeFoldable.length,
    after_foldable_count: afterFoldable.length,
    before_foldable_event_ids_sha256: jcsSha256Hex(beforeFoldable),
    after_foldable_event_ids_sha256: jcsSha256Hex(afterFoldable),
    foldable_unchanged: jcsSha256Hex(beforeFoldable) === jcsSha256Hex(afterFoldable),
    before_defined_inactive_shadow_count: before.definedInactiveShadow.length,
    after_defined_inactive_shadow_count: after.definedInactiveShadow.length,
  });
}

function summarizeScanForDossier(scan: WholeL1ScanResult): Readonly<Record<string, unknown>> {
  const selectedIds = scan.selected.map((record) => record.eventId).sort(compareCodeUnits);
  const foldableIds = scan.foldable.map((record) => record.eventId).sort(compareCodeUnits);
  const definedInactiveIds = scan.definedInactiveShadow.map((record) => record.eventId).sort(compareCodeUnits);
  return deepFreeze({
    summary: summarizePropositionGenesisScan(scan),
    selected_event_ids_sha256: jcsSha256Hex(selectedIds),
    foldable_event_ids_sha256: jcsSha256Hex(foldableIds),
    defined_inactive_shadow_event_ids_sha256: jcsSha256Hex(definedInactiveIds),
    selected_event_ids: selectedIds,
    foldable_event_ids: foldableIds,
    defined_inactive_shadow_event_ids: definedInactiveIds,
  });
}

function buildMutationInventory(before: InventorySnapshot, after: InventorySnapshot, tuple: FixedProductionPropositionGenesisTuple): Readonly<Record<string, unknown>> {
  const created = after.entries.filter((entry) => !before.byPath.has(entry.path)).map((entry) => entry.path).sort(compareCodeUnits);
  const removed = before.entries.filter((entry) => !after.byPath.has(entry.path)).map((entry) => entry.path).sort(compareCodeUnits);
  const modified = after.entries
    .filter((entry) => before.byPath.has(entry.path) && entryFingerprint(before.byPath.get(entry.path)!) !== entryFingerprint(entry))
    .map((entry) => entry.path)
    .sort(compareCodeUnits);
  const createdFiles = created.filter((rel) => after.byPath.get(rel)?.type === "file");
  const createdDirs = created.filter((rel) => after.byPath.get(rel)?.type === "directory");
  const allowedDirs = allowedParentDirectories(tuple.relative_path).filter((rel) => createdDirs.includes(rel));
  const unexpectedCreates = created.filter((rel) => rel !== tuple.relative_path && !allowedDirs.includes(rel));
  const unexpectedModifies = modified;
  const unexpectedRemoves = removed;
  const onlyAllowed = createdFiles.length === 1
    && createdFiles[0] === tuple.relative_path
    && unexpectedCreates.length === 0
    && unexpectedModifies.length === 0
    && unexpectedRemoves.length === 0;
  return deepFreeze({
    before_inventory_sha256: before.entries_sha256,
    after_inventory_sha256: after.entries_sha256,
    created,
    modified,
    removed,
    actual_file_creates: createdFiles,
    actual_file_create_count: createdFiles.length,
    actual_directory_creates: createdDirs,
    allowed_directory_creates: allowedDirs,
    unexpected_creates: unexpectedCreates,
    actual_file_modifies: modified.filter((rel) => after.byPath.get(rel)?.type === "file" || before.byPath.get(rel)?.type === "file"),
    actual_removes: removed,
    only_allowed_mutation: onlyAllowed,
    no_l2_state_or_legacy_change_claimed_separately: true,
    expected_file_append: tuple.relative_path,
  });
}

function allowedParentDirectories(relativeFile: string): string[] {
  const parts = relativeFile.split("/").slice(0, -1);
  const out: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) out.push(parts.slice(0, index).join("/"));
  return out;
}

function entryFingerprint(entry: InventoryEntry): string {
  return jcsSha256Hex(entry);
}

async function rejectRealAbrain(candidate: string): Promise<void> {
  const realCandidates = new Set([path.resolve(PROPOSITION_P0B2_HARD_ABRAIN_REALPATH), path.resolve(os.homedir(), ".abrain")]);
  const resolved = path.resolve(candidate);
  if (realCandidates.has(resolved)) throw failure("PROPOSITION_P0B2_REAL_ABRAIN_REJECTED", "sandbox execute fixture refuses the real abrain home", { path: resolved });
  const candidateReal = await fs.realpath(resolved).catch(() => resolved);
  for (const realCandidate of realCandidates) {
    const realAbrain = await fs.realpath(realCandidate).catch(() => realCandidate);
    if (candidateReal === realAbrain) throw failure("PROPOSITION_P0B2_REAL_ABRAIN_REJECTED", "sandbox execute fixture refuses the real abrain home realpath", { path: resolved, realpath: candidateReal });
  }
}

function validateCausalAnchor(input: unknown, at: string): Readonly<Record<string, unknown>> {
  const anchor = record(input, "RATIFICATION_RECORD_INVALID", `${at} must be an object`);
  exactKeys(anchor, ["raw", "raw_sha256", "session_id", "turn_id", "subturn", "sub_agent_label"], at);
  const raw = nonEmptyString(anchor.raw, `${at}.raw`);
  if (!raw.includes("<causal_anchor") || !/session_id=\"[^\"]+\"/.test(raw) || !/turn_id=\"[^\"]+\"/.test(raw)) {
    throw notAuthorized("RATIFICATION_CAUSAL_ANCHOR_INVALID", "authorization evidence must carry a causal_anchor with session_id and turn_id");
  }
  exact(anchor.raw_sha256, sha256Hex(raw), `${at}.raw_sha256`);
  const parsed = parseCausalAnchorAttrs(raw);
  exact(anchor.session_id, parsed.session_id, `${at}.session_id`);
  exact(anchor.turn_id, parsed.turn_id, `${at}.turn_id`);
  exact(anchor.subturn, parsed.subturn, `${at}.subturn`);
  exact(anchor.sub_agent_label, parsed.sub_agent_label, `${at}.sub_agent_label`);
  return deepFreeze(anchor);
}

function parseCausalAnchorAttrs(raw: string): { session_id: string; turn_id: string; subturn: string | null; sub_agent_label: string | null } {
  const sessionId = matchAttr(raw, "session_id");
  const turnId = matchAttr(raw, "turn_id");
  if (!sessionId || !turnId) throw notAuthorized("RATIFICATION_CAUSAL_ANCHOR_INVALID", "causal_anchor raw is missing session_id or turn_id");
  return {
    session_id: sessionId,
    turn_id: turnId,
    subturn: matchAttr(raw, "subturn"),
    sub_agent_label: matchAttr(raw, "sub_agent_label"),
  };
}

function matchAttr(raw: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]+)"`).exec(raw);
  return match?.[1] ?? null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} keys mismatch`, { expected, actual });
  }
}

function exact(value: unknown, expected: unknown, at: string): void {
  if (value !== expected) throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} mismatch`, { expected, actual: value });
}

function exactStringArray(value: unknown, expected: readonly string[], at: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} mismatch`, { expected, actual: value });
  }
}

function exactStringArrayValue(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw failure("PROPOSITION_P0B2_INTENT_INVALID", `${at} must be a string array`, { actual: value });
  }
  return [...value] as string[];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} must be one of ${allowed.join(", ")}`, { actual: value });
  }
  return value as T;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} must be boolean`, { actual: value });
  return value;
}

function nullableString(value: unknown, at: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} must be null or a non-empty string`, { actual: value });
  return value;
}

function positiveInteger(value: unknown, at: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} must be a positive integer`, { actual: value });
  return Number(value);
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} must be a non-empty string`, { actual: value });
  return value;
}

function sha256HexString(value: unknown, at: string): string {
  if (typeof value !== "string" || !isSha256(value)) throw notAuthorized("RATIFICATION_RECORD_INVALID", `${at} must be lowercase SHA-256 hex`, { actual: value });
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function record(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw failure(code, message);
  return value;
}

function objectAt(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function arrayAt(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function notAuthorized(reason: string, message: string, detail: Record<string, unknown> = {}): PropositionProductionExecuteError {
  return failure("NOT_AUTHORIZED", message, { reason, ...detail });
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionProductionExecuteError {
  return new PropositionProductionExecuteError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (value instanceof Map) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
