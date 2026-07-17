import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { durableAtomicCreateFile, fsyncDirectory, type DurableCreateStatus } from "./durable-write";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  PROPOSITION_POLICY_PUSH_REVIEW_VENDORS,
  buildPlannedPublicationDiff,
  buildPublicationReviewOutput,
  publicationIntentRelative,
  publicationPlannedDiffRelative,
  publicationReviewRelativePaths,
  readPublicationEvidenceBinding,
  validatePublicationEvidenceBinding,
  validatePublicationEvidenceImmediatelyBeforeMutation,
  writePublicationEvidenceArtifact,
  type PlannedPublicationDiff,
  type PublicationEvidenceBinding,
  type PublicationReviewVendor,
} from "./proposition-policy-push-publication-evidence";
import {
  PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
  validatePropositionPolicyPushBundle,
  type PropositionPolicyPushBundle,
} from "./proposition-policy-push-shadow";
import {
  verifyTrustedCurrentSessionUserMessage,
  type TranscriptMessageBinding,
} from "./proposition-p1b-transcript";

export const PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE = ".state/sediment/proposition-policy-push-shadow/v1" as const;
export const PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME = "/home/worker/.abrain" as const;
export const PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET = `${PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME}/${PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE}` as const;
export const PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_SCHEMA = "proposition-policy-push-publication-intent/v2" as const;
export const PROPOSITION_POLICY_PUSH_PUBLICATION_SNAPSHOT_SCHEMA = "proposition-policy-push-publication-whole-snapshot/v1" as const;
export const PROPOSITION_POLICY_PUSH_PUBLICATION_CLI = "scripts/publish-proposition-policy-push-shadow.mjs" as const;

const INTENT_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this intent object with intent_hash omitted" as const;
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type ArtifactName = typeof ARTIFACT_NAMES[number];
type PublicationMode = "production" | "sandbox_test";

export interface PublicationInventoryRow {
  relative_name: string;
  kind: "directory" | "file" | "symlink";
  bytes: number;
  sha256: string;
  symlink_value: string | null;
}

export interface PublicationWholeSnapshot {
  schema_version: typeof PROPOSITION_POLICY_PUSH_PUBLICATION_SNAPSHOT_SCHEMA;
  scope: "whole_abrain_no_carve_out";
  entry_count: number;
  directory_count: number;
  file_count: number;
  symlink_count: number;
  bytes: number;
  inventory_hash: string;
  snapshot_hash: string;
}

export interface PublicationSnapshotCapture {
  summary: PublicationWholeSnapshot;
  rows: readonly PublicationInventoryRow[];
}

export interface PublicationIntent {
  schema_version: typeof PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  intent_hash_scope: typeof INTENT_HASH_SCOPE;
  mode: PublicationMode;
  action: "publish_one_content_addressed_policy_shadow_bundle_and_relative_latest";
  authorization: {
    kind: "exact_role_user_transcript_authorization" | "synthetic_test_fixture";
    role: "user" | "test_fixture";
    authorization_text_sha256: string;
    transcript: TranscriptMessageBinding | null;
  };
  publication_evidence: PublicationEvidenceBinding;
  deployment: {
    repo_root: string;
    abrain_home: string;
    target_root: string;
    target_relative_name: typeof PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE;
    bundle_relative_name: string;
    latest_relative_symlink_value: string;
  };
  bundle: {
    manifest_schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA;
    bundle_hash: string;
    manifest_sha256: string;
    artifact_rows: readonly { name: ArtifactName; bytes: number; sha256: string }[];
    authority: "shadow_push_only_no_runtime_consumer";
    runtime_consumer: false;
    semantics: "relevance_only_no_injection_verdict";
    result: { entry_count: number; exclusion_count: number; diagnostic_count: number };
  };
  prestate: {
    target_absent: true;
    whole_abrain_snapshot_hash: string;
  };
  recovery: {
    state_machine: "absent_or_staging_partial_or_bundle_ready_or_complete";
    exact_same_intent_only: true;
    foreign_or_malformed_state: "fail_closed";
  };
  constraints: {
    no_environment_or_force_bypass: true;
    no_runtime_consumer: true;
    no_l1_write: true;
    no_l2_write: true;
    no_legacy_mutation: true;
    immutable_bundle_no_replace: true;
    atomic_relative_latest_symlink_no_replace: true;
    full_abrain_mutation_inventory_required: true;
  };
  intent_hash: string;
}

export interface PublicationResult {
  status: "created" | "identical" | "recovered";
  initial_state: PublicationRecoveryState;
  final_state: "complete";
  bundle_hash: string;
  bundle_directory: string;
  latest_symlink: string;
  latest_value: string;
  intent_hash: string;
  mutation_proof: {
    before: PublicationWholeSnapshot;
    after: PublicationWholeSnapshot;
    exact_diff: ReturnType<typeof diffPublicationInventory>;
    mutation_whitelist_valid: true;
    protected_outside_target_before_hash: string;
    protected_outside_target_after_hash: string;
    protected_outside_target_unchanged: true;
  };
}

export type PublicationRecoveryState = "absent" | "staging_partial" | "bundle_ready" | "complete";

export class PropositionPolicyPushPublicationError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyPushPublicationError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function buildPublicationAuthorizationText(input: {
  evidence: PublicationEvidenceBinding;
  repoRoot: string;
  bundleHash: string;
  manifestSha256: string;
}): string {
  validatePublicationEvidenceBinding(input.evidence, input.bundleHash);
  const reviews = input.evidence.review_record.signs.map((sign) =>
    `${sign.vendor}|${sign.model}|${sign.verdict}|${sign.relative_path}|raw sha256=${sign.raw_sha256}|planned diff sha256=${sign.planned_diff_sha256}`,
  ).join(", ");
  return [
    "I explicitly authorize ADR0040 P2a.2 actual publication",
    `planned publication diff path=${input.evidence.planned_diff_artifact.relative_path}`,
    `planned publication diff raw sha256=${input.evidence.planned_diff_artifact.raw_sha256}`,
    `planned publication diff content sha256=${input.evidence.planned_diff_artifact.planned_diff_sha256}`,
    `six-review record sha256=${input.evidence.review_record.review_record_sha256}`,
    `repo root=${path.resolve(input.repoRoot)}`,
    `review artifact bindings=${reviews}`,
    "I attest these six exact review artifact bytes represent the named vendor/model reviews; the code verifies bytes and metadata, not cryptographic vendor provenance",
    `semantic manifest schema=${PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA}`,
    `bundle hash=${input.bundleHash}`,
    `manifest sha256=${input.manifestSha256}`,
    `abrain home=${PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME}`,
    `target root=${PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET}`,
    "publish exactly one immutable content-addressed bundle and relative latest symlink",
    "no L1 write, no L2 write, no runtime consumer, and no legacy authority mutation",
    "no other production mutation is authorized",
  ].join("; ");
}

export function buildPublicationIntent(input: {
  mode: PublicationMode;
  abrainHome: string;
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  wholeAbrainSnapshotHash: string;
  publicationEvidence: PublicationEvidenceBinding;
  authorization: PublicationIntent["authorization"];
}): PublicationIntent {
  validatePropositionPolicyPushBundle(input.bundle);
  assertSha256(input.wholeAbrainSnapshotHash, "wholeAbrainSnapshotHash");
  validatePublicationEvidenceBinding(input.publicationEvidence, input.bundle.manifest.bundle_hash);
  const abrainHome = path.resolve(input.abrainHome);
  const repoRoot = path.resolve(input.repoRoot);
  const targetRoot = path.join(abrainHome, ...PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE.split("/"));
  const artifactRows = ARTIFACT_NAMES.map((name) => deepFreeze({
    name,
    bytes: Buffer.byteLength(input.bundle.bytes[name]),
    sha256: sha256Hex(input.bundle.bytes[name]),
  }));
  const intentBase = {
    schema_version: PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    intent_hash_scope: INTENT_HASH_SCOPE,
    mode: input.mode,
    action: "publish_one_content_addressed_policy_shadow_bundle_and_relative_latest" as const,
    authorization: deepFreeze({ ...input.authorization }),
    publication_evidence: deepFreeze({ ...input.publicationEvidence }),
    deployment: {
      repo_root: repoRoot,
      abrain_home: abrainHome,
      target_root: targetRoot,
      target_relative_name: PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
      bundle_relative_name: `bundles/${input.bundle.manifest.bundle_hash}`,
      latest_relative_symlink_value: `bundles/${input.bundle.manifest.bundle_hash}`,
    },
    bundle: {
      manifest_schema_version: PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
      bundle_hash: input.bundle.manifest.bundle_hash,
      manifest_sha256: sha256Hex(input.bundle.bytes["manifest.json"]),
      artifact_rows: Object.freeze(artifactRows),
      authority: "shadow_push_only_no_runtime_consumer" as const,
      runtime_consumer: false as const,
      semantics: "relevance_only_no_injection_verdict" as const,
      result: { ...input.bundle.manifest.result },
    },
    prestate: {
      target_absent: true as const,
      whole_abrain_snapshot_hash: input.wholeAbrainSnapshotHash,
    },
    recovery: {
      state_machine: "absent_or_staging_partial_or_bundle_ready_or_complete" as const,
      exact_same_intent_only: true as const,
      foreign_or_malformed_state: "fail_closed" as const,
    },
    constraints: {
      no_environment_or_force_bypass: true as const,
      no_runtime_consumer: true as const,
      no_l1_write: true as const,
      no_l2_write: true as const,
      no_legacy_mutation: true as const,
      immutable_bundle_no_replace: true as const,
      atomic_relative_latest_symlink_no_replace: true as const,
      full_abrain_mutation_inventory_required: true as const,
    },
  };
  const intent = deepFreeze({ ...intentBase, intent_hash: jcsSha256Hex(intentBase) });
  validatePublicationIntentShape(intent, { mode: input.mode, abrainHome, repoRoot, bundle: input.bundle });
  return intent;
}

export async function writePublicationIntent(file: string, intent: PublicationIntent): Promise<DurableCreateStatus> {
  validatePublicationIntentSelfHash(intent);
  const resolved = path.resolve(file);
  await assertSafeRegularFileLocation(resolved, "publication intent", { allowMissingLeaf: true });
  const status = await durableAtomicCreateFile(resolved, canonicalJson(intent), { mode: 0o600 });
  if (status === "collision") throw failure("PROPOSITION_POLICY_PUSH_INTENT_COLLISION", "intent path contains different bytes", { file: resolved });
  if (await fs.readFile(resolved, "utf-8") !== canonicalJson(intent)) throw failure("PROPOSITION_POLICY_PUSH_INTENT_READBACK", "intent readback mismatch", { file: resolved });
  return status;
}

export async function publishPropositionPolicyPushShadow(options: {
  abrainHome: string;
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  intentPath?: string;
}): Promise<PublicationResult> {
  if (!options.intentPath) throw notAuthorized("INTENT_REQUIRED", "an exact durable publication intent is required before mutation");
  return publishInternal({
    abrainHome: options.abrainHome,
    repoRoot: options.repoRoot,
    bundle: options.bundle,
    intentPath: options.intentPath,
    mode: "production",
  });
}

export async function readPublishedPropositionPolicyPushShadow(options: { abrainHome: string }): Promise<PropositionPolicyPushBundle> {
  const abrainHome = await assertAbrainHome(options.abrainHome, "production");
  return readPublishedInternal(abrainHome);
}

export async function previewProductionPublicationTarget(options: { abrainHome: string }): Promise<Readonly<Record<string, unknown>>> {
  const abrainHome = await assertAbrainHome(options.abrainHome, "production");
  const targetRoot = expectedTargetRoot(abrainHome);
  await assertTargetAncestorSafety(abrainHome, targetRoot);
  const target = await lstatIfPresent(targetRoot);
  if (target) {
    if (target.isSymbolicLink() || !target.isDirectory() || await fs.realpath(targetRoot) !== targetRoot) {
      throw failure("PROPOSITION_POLICY_PUSH_TARGET_UNSAFE", "production target exists with unsafe type or realpath", { targetRoot });
    }
    throw failure("PROPOSITION_POLICY_PUSH_TARGET_PRESENT", "P2a.2.1 preview requires the hard production target to remain absent", { targetRoot });
  }
  return deepFreeze({
    target_root: targetRoot,
    target_relative_name: PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
    state: "absent",
    ancestor_chain_safe: true,
    read_only: true,
  });
}

export async function capturePublicationWholeSnapshot(abrainHomeInput: string): Promise<PublicationSnapshotCapture> {
  const abrainHome = path.resolve(abrainHomeInput);
  const stat = await fs.lstat(abrainHome);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(abrainHome) !== abrainHome) {
    throw failure("PROPOSITION_POLICY_PUSH_SNAPSHOT_UNSAFE", "snapshot root must be an exact non-symlink directory", { abrainHome });
  }
  const rows = await inventoryTree(abrainHome);
  const inventoryHash = jcsSha256Hex(rows);
  const summary = deepFreeze({
    schema_version: PROPOSITION_POLICY_PUSH_PUBLICATION_SNAPSHOT_SCHEMA,
    scope: "whole_abrain_no_carve_out" as const,
    entry_count: rows.length,
    directory_count: rows.filter((row) => row.kind === "directory").length,
    file_count: rows.filter((row) => row.kind === "file").length,
    symlink_count: rows.filter((row) => row.kind === "symlink").length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    inventory_hash: inventoryHash,
    snapshot_hash: jcsSha256Hex({ scope: "whole_abrain_no_carve_out", rows }),
  });
  return deepFreeze({ summary, rows });
}

interface PublishInternalOptions {
  abrainHome: string;
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  intentPath: string;
  mode: PublicationMode;
  targetRootOverrideForTest?: string;
  testCrashAt?: "ancestor_partial" | "staging_partial" | "bundle_ready" | "complete_latest";
}

async function publishInternal(options: PublishInternalOptions): Promise<PublicationResult> {
  validatePropositionPolicyPushBundle(options.bundle);
  const abrainHome = await assertAbrainHome(options.abrainHome, options.mode);
  const repoRoot = path.resolve(options.repoRoot);
  const expectedTarget = expectedTargetRoot(abrainHome);
  const targetRoot = path.resolve(options.targetRootOverrideForTest ?? expectedTarget);
  if (targetRoot !== expectedTarget) throw failure("PROPOSITION_POLICY_PUSH_PATH_ESCAPE", "publication target is not the exact hard relative target", { targetRoot, expectedTarget });
  await assertTargetAncestorSafety(abrainHome, targetRoot);
  const before = await capturePublicationWholeSnapshot(abrainHome);
  const protectedBeforeHash = protectedOutsideTargetHash(before.rows, abrainHome, targetRoot);
  const intent = await loadAndValidatePublicationIntent({
    file: options.intentPath,
    mode: options.mode,
    abrainHome,
    repoRoot,
    bundle: options.bundle,
  });
  const initialState = await inspectPublicationState({ targetRoot, bundle: options.bundle, intentHash: intent.intent_hash });
  try {
    const plannedDiff = await validatePublicationEvidenceImmediatelyBeforeMutation({
      repoRoot,
      abrainHome,
      targetRelativeName: PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
      bundle: options.bundle,
      currentSnapshot: before,
      binding: intent.publication_evidence,
    });
    if (intent.prestate.whole_abrain_snapshot_hash !== plannedDiff.absent_prestate.snapshot_hash) {
      throw notAuthorized("PRESTATE_BINDING_DRIFT", "intent prestate does not equal the evidence-bound reconstructed absent prestate", {
        intent: intent.prestate.whole_abrain_snapshot_hash,
        planned: plannedDiff.absent_prestate.snapshot_hash,
      });
    }
  } catch (err) {
    throw notAuthorized("PUBLICATION_EVIDENCE_INVALID", "planned diff or durable review artifact validation failed immediately before mutation", {
      source_code: errorCode(err),
      error: errorMessage(err),
    });
  }

  const bundlesRoot = path.join(targetRoot, "bundles");
  const bundleDir = path.join(bundlesRoot, options.bundle.manifest.bundle_hash);
  const stagingRoot = path.join(targetRoot, "staging");
  const stageDir = path.join(stagingRoot, intent.intent_hash);
  const latest = path.join(targetRoot, "latest");
  const latestValue = `bundles/${options.bundle.manifest.bundle_hash}`;

  if (initialState !== "complete") {
    await ensureDirectoryChainNoSymlink(abrainHome, stageDir, (createdDirectory) => {
      if (createdDirectory === path.dirname(targetRoot)) crashAtTestTransition(options, "ancestor_partial");
    });
    await assertPartialBundleDirectory(stageDir, options.bundle.bytes);
    for (const [index, name] of ARTIFACT_NAMES.entries()) {
      await writeConvergentStagingFile(path.join(stageDir, name), options.bundle.bytes[name]);
      if (index === 0) crashAtTestTransition(options, "staging_partial");
    }
    await fsyncDirectory(stageDir);

    await ensureDirectoryChainNoSymlink(abrainHome, bundleDir);
    await assertPartialBundleDirectory(bundleDir, options.bundle.bytes);
    for (const name of ARTIFACT_NAMES) {
      await linkNoReplaceExact(path.join(stageDir, name), path.join(bundleDir, name), options.bundle.bytes[name]);
    }
    await fsyncDirectory(bundleDir);
    await fsyncDirectory(bundlesRoot);
    await assertExactBundleDirectory(bundleDir, options.bundle.bytes);
    crashAtTestTransition(options, "bundle_ready");

    await cleanupExactStage(stageDir, stagingRoot, options.bundle.bytes);
    const latestState = await lstatIfPresent(latest);
    if (!latestState) {
      try {
        await fs.symlink(latestValue, latest, "dir");
        await fsyncDirectory(targetRoot);
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        await assertExactLatest(latest, latestValue);
      }
    } else {
      await assertExactLatest(latest, latestValue);
    }
    await settleExactStage(stageDir, stagingRoot, options.bundle.bytes);
    crashAtTestTransition(options, "complete_latest");
  }

  const published = await readPublishedInternal(abrainHome);
  if (published.manifest.bundle_hash !== options.bundle.manifest.bundle_hash) throw failure("PROPOSITION_POLICY_PUSH_PUBLICATION_READBACK", "published bundle hash differs after readback");
  const finalState = await inspectPublicationState({ targetRoot, bundle: options.bundle, intentHash: intent.intent_hash });
  if (finalState !== "complete") throw failure("PROPOSITION_POLICY_PUSH_RECOVERY_STATE", "publication did not reach complete state", { finalState });
  await assertNoPublicationLocks(targetRoot);
  const after = await capturePublicationWholeSnapshot(abrainHome);
  const protectedAfterHash = protectedOutsideTargetHash(after.rows, abrainHome, targetRoot);
  if (protectedBeforeHash !== protectedAfterHash) throw failure("PROPOSITION_POLICY_PUSH_PROTECTED_MUTATION", "abrain changed outside the exact publication target", { protectedBeforeHash, protectedAfterHash });
  const exactDiff = diffPublicationInventory(before.rows, after.rows);
  assertMutationWhitelist({ abrainHome, targetRoot, bundleHash: options.bundle.manifest.bundle_hash, intentHash: intent.intent_hash, diff: exactDiff });
  const status: PublicationResult["status"] = initialState === "absent" ? "created" : initialState === "complete" ? "identical" : "recovered";
  return deepFreeze({
    status,
    initial_state: initialState,
    final_state: "complete" as const,
    bundle_hash: options.bundle.manifest.bundle_hash,
    bundle_directory: bundleDir,
    latest_symlink: latest,
    latest_value: latestValue,
    intent_hash: intent.intent_hash,
    mutation_proof: {
      before: before.summary,
      after: after.summary,
      exact_diff: exactDiff,
      mutation_whitelist_valid: true as const,
      protected_outside_target_before_hash: protectedBeforeHash,
      protected_outside_target_after_hash: protectedAfterHash,
      protected_outside_target_unchanged: true as const,
    },
  });
}

async function loadAndValidatePublicationIntent(options: {
  file: string;
  mode: PublicationMode;
  abrainHome: string;
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
}): Promise<PublicationIntent> {
  try {
    const file = path.resolve(options.file);
    if (isPathInside(options.abrainHome, file)) throw notAuthorized("INTENT_INSIDE_ABRAIN", "durable authorization intent must exist outside abrain before mutation");
    if (options.mode === "production") {
      const expected = productionIntentPath(options.repoRoot, options.bundle.manifest.bundle_hash);
      if (file !== expected) throw notAuthorized("INTENT_PATH_MISMATCH", "production intent must use the exact content-bound repo evidence path", { file, expected });
    } else {
      const tempReal = await fs.realpath(os.tmpdir());
      if (!isPathInside(tempReal, file)) throw notAuthorized("SANDBOX_INTENT_PATH", "sandbox intent must remain under the real system temp root");
    }
    await assertSafeRegularFileLocation(file, "publication intent", { allowMissingLeaf: false });
    const raw = await fs.readFile(file, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw notAuthorized("INTENT_MALFORMED", "publication intent is not valid JSON", { error: errorMessage(err) });
    }
    const intent = parsed as PublicationIntent;
    if (raw !== canonicalJson(intent)) throw notAuthorized("INTENT_BYTES_NONCANONICAL", "publication intent must be exact RFC8785/JCS bytes plus one newline");
    validatePublicationIntentShape(intent, options);
    validatePublicationIntentSelfHash(intent);
    if (options.mode === "production") {
      if (intent.authorization.kind !== "exact_role_user_transcript_authorization" || intent.authorization.role !== "user" || !intent.authorization.transcript) {
        throw notAuthorized("ROLE_USER_REQUIRED", "production publication requires an exact role=user transcript authorization");
      }
      const verified = await verifyTrustedCurrentSessionUserMessage(intent.authorization.transcript, { requireFreshAfterAttestation: true });
      const expectedText = buildPublicationAuthorizationText({
        evidence: intent.publication_evidence,
        repoRoot: intent.deployment.repo_root,
        bundleHash: intent.bundle.bundle_hash,
        manifestSha256: intent.bundle.manifest_sha256,
      });
      if (verified.text !== expectedText || sha256Hex(verified.text) !== intent.authorization.authorization_text_sha256) {
        throw notAuthorized("AUTHORIZATION_TEXT_MISMATCH", "trusted role=user message is not the exact hash-bound publication authorization");
      }
    } else if (intent.authorization.kind !== "synthetic_test_fixture" || intent.authorization.role !== "test_fixture" || intent.authorization.transcript !== null) {
      throw notAuthorized("SANDBOX_INTENT_REQUIRED", "sandbox publisher accepts only a synthetic test fixture intent");
    }
    return deepFreeze(intent);
  } catch (err) {
    if (err instanceof PropositionPolicyPushPublicationError && err.code === "NOT_AUTHORIZED") throw err;
    throw notAuthorized("INTENT_VALIDATION_FAILED", "publication intent failed closed validation", { error: errorMessage(err), source_code: errorCode(err) });
  }
}

function validatePublicationIntentShape(intent: PublicationIntent, context: { mode: PublicationMode; abrainHome: string; repoRoot: string; bundle: PropositionPolicyPushBundle }): void {
  exactKeys(asRecord(intent), ["schema_version", "canonicalization", "hash_algorithm", "intent_hash_scope", "mode", "action", "authorization", "publication_evidence", "deployment", "bundle", "prestate", "recovery", "constraints", "intent_hash"], "intent");
  exactKeys(asRecord(intent.authorization), ["kind", "role", "authorization_text_sha256", "transcript"], "intent.authorization");
  exactKeys(asRecord(intent.deployment), ["repo_root", "abrain_home", "target_root", "target_relative_name", "bundle_relative_name", "latest_relative_symlink_value"], "intent.deployment");
  exactKeys(asRecord(intent.bundle), ["manifest_schema_version", "bundle_hash", "manifest_sha256", "artifact_rows", "authority", "runtime_consumer", "semantics", "result"], "intent.bundle");
  exactKeys(asRecord(intent.bundle.result), ["entry_count", "exclusion_count", "diagnostic_count"], "intent.bundle.result");
  exactKeys(asRecord(intent.prestate), ["target_absent", "whole_abrain_snapshot_hash"], "intent.prestate");
  exactKeys(asRecord(intent.recovery), ["state_machine", "exact_same_intent_only", "foreign_or_malformed_state"], "intent.recovery");
  exactKeys(asRecord(intent.constraints), ["no_environment_or_force_bypass", "no_runtime_consumer", "no_l1_write", "no_l2_write", "no_legacy_mutation", "immutable_bundle_no_replace", "atomic_relative_latest_symlink_no_replace", "full_abrain_mutation_inventory_required"], "intent.constraints");
  if (intent.schema_version !== PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_SCHEMA
    || intent.canonicalization !== "RFC8785-JCS"
    || intent.hash_algorithm !== "sha256"
    || intent.intent_hash_scope !== INTENT_HASH_SCOPE
    || intent.mode !== context.mode
    || intent.action !== "publish_one_content_addressed_policy_shadow_bundle_and_relative_latest") throw notAuthorized("INTENT_SHAPE", "intent identity or mode drifted");
  assertSha256(intent.authorization.authorization_text_sha256, "intent.authorization.authorization_text_sha256");
  if (intent.deployment.repo_root !== context.repoRoot
    || intent.deployment.abrain_home !== context.abrainHome
    || intent.deployment.target_root !== expectedTargetRoot(context.abrainHome)
    || intent.deployment.target_relative_name !== PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE
    || intent.deployment.bundle_relative_name !== `bundles/${context.bundle.manifest.bundle_hash}`
    || intent.deployment.latest_relative_symlink_value !== `bundles/${context.bundle.manifest.bundle_hash}`) throw notAuthorized("INTENT_DEPLOYMENT_BINDING", "intent deployment binding is foreign");
  const expectedRows = ARTIFACT_NAMES.map((name) => ({ name, bytes: Buffer.byteLength(context.bundle.bytes[name]), sha256: sha256Hex(context.bundle.bytes[name]) }));
  if (intent.bundle.manifest_schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA
    || intent.bundle.bundle_hash !== context.bundle.manifest.bundle_hash
    || intent.bundle.manifest_sha256 !== sha256Hex(context.bundle.bytes["manifest.json"])
    || canonicalizeJcs(intent.bundle.artifact_rows) !== canonicalizeJcs(expectedRows)
    || intent.bundle.authority !== "shadow_push_only_no_runtime_consumer"
    || intent.bundle.runtime_consumer !== false
    || intent.bundle.semantics !== "relevance_only_no_injection_verdict"
    || canonicalizeJcs(intent.bundle.result) !== canonicalizeJcs(context.bundle.manifest.result)) throw notAuthorized("INTENT_BUNDLE_BINDING", "intent bundle binding is foreign");
  validatePublicationEvidenceBinding(intent.publication_evidence, context.bundle.manifest.bundle_hash);
  if (intent.prestate.target_absent !== true) throw notAuthorized("INTENT_PRESTATE", "intent must be created against an absent target");
  assertSha256(intent.prestate.whole_abrain_snapshot_hash, "intent.prestate.whole_abrain_snapshot_hash");
  if (intent.recovery.state_machine !== "absent_or_staging_partial_or_bundle_ready_or_complete"
    || intent.recovery.exact_same_intent_only !== true
    || intent.recovery.foreign_or_malformed_state !== "fail_closed"
    || Object.values(intent.constraints).some((value) => value !== true)) throw notAuthorized("INTENT_CONSTRAINTS", "intent recovery or mutation constraints drifted");
}

function validatePublicationIntentSelfHash(intent: PublicationIntent): void {
  assertSha256(intent.intent_hash, "intent.intent_hash");
  const base = { ...intent } as Record<string, unknown>;
  delete base.intent_hash;
  if (jcsSha256Hex(base) !== intent.intent_hash) throw notAuthorized("INTENT_SELF_HASH", "publication intent self-hash mismatch");
}

async function inspectPublicationState(options: { targetRoot: string; bundle: PropositionPolicyPushBundle; intentHash: string }): Promise<PublicationRecoveryState> {
  const root = await lstatIfPresent(options.targetRoot);
  if (!root) return "absent";
  if (root.isSymbolicLink() || !root.isDirectory() || await fs.realpath(options.targetRoot) !== options.targetRoot) throw failure("PROPOSITION_POLICY_PUSH_TARGET_UNSAFE", "publication target is a symlink, non-directory, or foreign realpath");
  const allowedRoot = new Set(["bundles", "latest", "staging"]);
  for (const name of await fs.readdir(options.targetRoot)) if (!allowedRoot.has(name)) throw failure("PROPOSITION_POLICY_PUSH_FOREIGN_STATE", "publication root contains a foreign entry", { name });
  const bundlesRoot = path.join(options.targetRoot, "bundles");
  const bundleDir = path.join(bundlesRoot, options.bundle.manifest.bundle_hash);
  const stagingRoot = path.join(options.targetRoot, "staging");
  const stageDir = path.join(stagingRoot, options.intentHash);
  const bundles = await lstatIfPresent(bundlesRoot);
  let bundleReady = false;
  let bundlePartial = false;
  if (bundles) {
    if (bundles.isSymbolicLink() || !bundles.isDirectory() || await fs.realpath(bundlesRoot) !== bundlesRoot) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_UNSAFE", "bundles root is unsafe");
    const children = await fs.readdir(bundlesRoot);
    for (const child of children) if (child !== options.bundle.manifest.bundle_hash) throw failure("PROPOSITION_POLICY_PUSH_FOREIGN_STATE", "bundles root contains a foreign bundle", { child });
    if (children.includes(options.bundle.manifest.bundle_hash)) {
      const names = await assertPartialBundleDirectory(bundleDir, options.bundle.bytes, { allowPrefixBytes: false });
      bundleReady = names.length === ARTIFACT_NAMES.length;
      bundlePartial = !bundleReady;
      if (bundleReady) await assertExactBundleDirectory(bundleDir, options.bundle.bytes);
    }
  }
  let stagingPartial = false;
  const staging = await lstatIfPresent(stagingRoot);
  if (staging) {
    if (staging.isSymbolicLink() || !staging.isDirectory() || await fs.realpath(stagingRoot) !== stagingRoot) throw failure("PROPOSITION_POLICY_PUSH_STAGING_UNSAFE", "staging root is unsafe");
    const children = await fs.readdir(stagingRoot);
    for (const child of children) if (child !== options.intentHash) throw failure("PROPOSITION_POLICY_PUSH_TEMP_RESIDUE", "foreign staging residue fails closed", { child });
    if (children.includes(options.intentHash)) {
      await assertPartialBundleDirectory(stageDir, options.bundle.bytes, { allowPrefixBytes: true });
      stagingPartial = true;
    }
  }
  const latest = path.join(options.targetRoot, "latest");
  const latestStat = await lstatIfPresent(latest);
  if (latestStat) {
    await assertExactLatest(latest, `bundles/${options.bundle.manifest.bundle_hash}`);
    if (!bundleReady) throw failure("PROPOSITION_POLICY_PUSH_RECOVERY_STATE", "latest cannot precede an exact final bundle");
    return stagingPartial ? "staging_partial" : "complete";
  }
  if (bundleReady && !stagingPartial) return "bundle_ready";
  if (stagingPartial || bundlePartial || root) return "staging_partial";
  return "absent";
}

async function readPublishedInternal(abrainHome: string): Promise<PropositionPolicyPushBundle> {
  const targetRoot = expectedTargetRoot(abrainHome);
  await assertTargetAncestorSafety(abrainHome, targetRoot);
  const latest = path.join(targetRoot, "latest");
  const latestStat = await fs.lstat(latest).catch((err: unknown) => {
    if (isNodeErrorCode(err, "ENOENT")) throw failure("PROPOSITION_POLICY_PUSH_PUBLICATION_MISSING", "latest is missing");
    throw err;
  });
  if (!latestStat.isSymbolicLink()) throw failure("PROPOSITION_POLICY_PUSH_LATEST_UNSAFE", "latest is not a symlink");
  const value = await fs.readlink(latest);
  const match = /^bundles\/([0-9a-f]{64})$/.exec(value);
  if (!match) throw failure("PROPOSITION_POLICY_PUSH_LATEST_UNSAFE", "latest value is not a direct relative bundle reference", { value });
  const bundleDir = path.join(targetRoot, "bundles", match[1]!);
  const bundle = await readExactBundleDirectory(bundleDir);
  if (bundle.manifest.bundle_hash !== match[1]) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_IDENTITY", "directory, latest, and manifest bundle hashes disagree");
  return bundle;
}

async function readExactBundleDirectory(bundleDir: string): Promise<PropositionPolicyPushBundle> {
  const stat = await fs.lstat(bundleDir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(bundleDir) !== bundleDir) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_UNSAFE", "bundle directory is unsafe", { bundleDir });
  const names = (await fs.readdir(bundleDir)).sort(compareCodeUnits);
  if (canonicalizeJcs(names) !== canonicalizeJcs([...ARTIFACT_NAMES].sort(compareCodeUnits))) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_COLLISION", "bundle directory has missing or extra artifacts", { names });
  const bytes = {} as Record<ArtifactName, string>;
  for (const name of ARTIFACT_NAMES) {
    const file = path.join(bundleDir, name);
    const fileStat = await fs.lstat(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || await fs.realpath(file) !== file) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_UNSAFE", "bundle artifact is unsafe", { file });
    bytes[name] = await fs.readFile(file, "utf-8");
  }
  const bundle = deepFreeze({
    manifest: JSON.parse(bytes["manifest.json"]),
    entries: JSON.parse(bytes["entries.json"]),
    exclusions: JSON.parse(bytes["exclusions.json"]),
    diagnostics: JSON.parse(bytes["diagnostics.json"]),
    bytes,
  }) as PropositionPolicyPushBundle;
  validatePropositionPolicyPushBundle(bundle);
  return bundle;
}

async function assertExactBundleDirectory(bundleDir: string, expected: PropositionPolicyPushBundle["bytes"]): Promise<void> {
  const actual = await readExactBundleDirectory(bundleDir);
  for (const name of ARTIFACT_NAMES) if (actual.bytes[name] !== expected[name]) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_COLLISION", "existing bundle bytes differ", { bundleDir, name });
}

async function assertPartialBundleDirectory(
  bundleDir: string,
  expected: PropositionPolicyPushBundle["bytes"],
  options: { allowPrefixBytes?: boolean } = {},
): Promise<readonly string[]> {
  const stat = await fs.lstat(bundleDir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(bundleDir) !== bundleDir) throw failure("PROPOSITION_POLICY_PUSH_STAGING_UNSAFE", "partial bundle directory is unsafe", { bundleDir });
  const names = (await fs.readdir(bundleDir)).sort(compareCodeUnits);
  for (const name of names) {
    if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) throw failure("PROPOSITION_POLICY_PUSH_TEMP_RESIDUE", "partial bundle contains a foreign artifact", { name });
    const file = path.join(bundleDir, name);
    const fileStat = await fs.lstat(file);
    const actual = await fs.readFile(file);
    const wanted = Buffer.from(expected[name as ArtifactName], "utf-8");
    const validBytes = options.allowPrefixBytes
      ? actual.length <= wanted.length && actual.equals(wanted.subarray(0, actual.length))
      : actual.equals(wanted);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || await fs.realpath(file) !== file || !validBytes) {
      throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_COLLISION", "partial artifact is unsafe or different", { name });
    }
  }
  return Object.freeze(names);
}

async function assertExactLatest(latest: string, expectedValue: string): Promise<void> {
  const stat = await fs.lstat(latest);
  if (!stat.isSymbolicLink()) throw failure("PROPOSITION_POLICY_PUSH_LATEST_UNSAFE", "latest exists as a non-symlink", { latest });
  const value = await fs.readlink(latest);
  if (value !== expectedValue || path.isAbsolute(value) || value.includes("..") || !/^bundles\/[0-9a-f]{64}$/.test(value)) {
    throw failure("PROPOSITION_POLICY_PUSH_LATEST_UNSAFE", "latest symlink is foreign or escapes", { value, expectedValue });
  }
}

async function writeConvergentStagingFile(file: string, content: string): Promise<void> {
  const expected = Buffer.from(content, "utf-8");
  let handle: fs.FileHandle | undefined;
  try {
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (err) {
      if (!isNodeErrorCode(err, "EEXIST")) throw err;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_COLLISION", "staging artifact is unsafe", { file });
      const actual = await fs.readFile(file);
      if (actual.length > expected.length || !actual.equals(expected.subarray(0, actual.length))) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_COLLISION", "staging artifact is not an exact recoverable prefix", { file });
      if (actual.equals(expected)) return;
      handle = await fs.open(file, "r+");
    }
    let offset = 0;
    while (offset < expected.length) {
      const result = await handle.write(expected, offset, expected.length - offset, offset);
      if (result.bytesWritten <= 0) throw failure("PROPOSITION_POLICY_PUSH_STAGING_WRITE", "staging artifact write made no progress", { file });
      offset += result.bytesWritten;
    }
    await handle.truncate(expected.length);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const actual = await fs.readFile(file);
  if (!actual.equals(expected)) throw failure("PROPOSITION_POLICY_PUSH_STAGING_WRITE", "staging artifact readback differs", { file });
}

async function linkNoReplaceExact(source: string, target: string, expected: string): Promise<void> {
  try {
    await fs.link(source, target);
    await fsyncDirectory(path.dirname(target));
  } catch (err) {
    if (!isNodeErrorCode(err, "EEXIST")) {
      if (isNodeErrorCode(err, "ENOENT") && await exactRegularFileOrMissing(target, expected)) return;
      throw err;
    }
  }
  if (!await exactRegularFileOrMissing(target, expected)) throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_COLLISION", "final artifact collision", { target });
}

async function exactRegularFileOrMissing(file: string, expected: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    return !stat.isSymbolicLink() && stat.isFile() && await fs.realpath(file) === file && await fs.readFile(file, "utf-8") === expected;
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return false;
    throw err;
  }
}

async function cleanupExactStage(stageDir: string, stagingRoot: string, expected: PropositionPolicyPushBundle["bytes"]): Promise<void> {
  const names = await fs.readdir(stageDir).catch((err: unknown) => {
    if (isNodeErrorCode(err, "ENOENT")) return [] as string[];
    throw err;
  });
  for (const name of names) if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) throw failure("PROPOSITION_POLICY_PUSH_TEMP_RESIDUE", "staging cleanup encountered a foreign artifact", { name });
  for (const name of ARTIFACT_NAMES) {
    const file = path.join(stageDir, name);
    const stat = await lstatIfPresent(file);
    if (!stat) continue;
    if (!await exactRegularFileOrMissing(file, expected[name])) {
      if (!await lstatIfPresent(file)) continue;
      throw failure("PROPOSITION_POLICY_PUSH_BUNDLE_COLLISION", "staging cleanup encountered foreign bytes", { file });
    }
    await fs.unlink(file).catch((err: unknown) => { if (!isNodeErrorCode(err, "ENOENT")) throw err; });
  }
  await fs.rmdir(stageDir).catch((err: unknown) => { if (!isNodeErrorCode(err, "ENOENT") && !isNodeErrorCode(err, "ENOTEMPTY")) throw err; });
  await fs.rmdir(stagingRoot).catch((err: unknown) => { if (!isNodeErrorCode(err, "ENOENT") && !isNodeErrorCode(err, "ENOTEMPTY")) throw err; });
}

async function settleExactStage(stageDir: string, stagingRoot: string, expected: PropositionPolicyPushBundle["bytes"]): Promise<void> {
  let stableAbsent = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await cleanupExactStage(stageDir, stagingRoot, expected);
    if (!await lstatIfPresent(stageDir) && !await lstatIfPresent(stagingRoot)) {
      stableAbsent += 1;
      if (stableAbsent >= 3) return;
    } else {
      stableAbsent = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw failure("PROPOSITION_POLICY_PUSH_CONCURRENT_TIMEOUT", "exact staging residue did not converge after bounded lock-free cleanup");
}

function crashAtTestTransition(options: PublishInternalOptions, transition: NonNullable<PublishInternalOptions["testCrashAt"]>): void {
  if (options.mode === "sandbox_test" && options.testCrashAt === transition) process.kill(process.pid, "SIGKILL");
}

async function assertNoPublicationLocks(targetRoot: string): Promise<void> {
  const names = await fs.readdir(targetRoot);
  if (names.some((name) => name.toLowerCase().includes("lock"))) throw failure("PROPOSITION_POLICY_PUSH_LOCK_RESIDUE", "publication target contains lock residue", { names });
}

async function assertAbrainHome(input: string, mode: PublicationMode): Promise<string> {
  const resolved = path.resolve(input);
  await assertExistingDirectoryChainNoSymlink(path.parse(resolved).root, resolved);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(resolved) !== resolved) throw failure("PROPOSITION_POLICY_PUSH_ABRAIN_UNSAFE", "abrain home is not an exact non-symlink directory");
  if (mode === "production") {
    if (resolved !== PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME) throw notAuthorized("HARD_ABRAIN_REQUIRED", "publisher is hard-limited to /home/worker/.abrain");
  } else {
    const tempReal = await fs.realpath(os.tmpdir());
    if (!isPathInside(tempReal, resolved) || resolved === tempReal || resolved === PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME) throw failure("PROPOSITION_POLICY_PUSH_SANDBOX_REQUIRED", "sandbox abrain must be a real directory below the system temp root");
  }
  return resolved;
}

async function assertTargetAncestorSafety(abrainHome: string, targetRoot: string): Promise<void> {
  if (targetRoot !== expectedTargetRoot(abrainHome) || !isPathInside(abrainHome, targetRoot)) throw failure("PROPOSITION_POLICY_PUSH_PATH_ESCAPE", "target escapes or differs from exact publication root");
  let current = abrainHome;
  for (const component of PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE.split("/")) {
    current = path.join(current, component);
    const stat = await lstatIfPresent(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(current) !== current) throw failure("PROPOSITION_POLICY_PUSH_TARGET_UNSAFE", "target ancestor is a symlink, non-directory, or foreign realpath", { current });
  }
}

async function ensureDirectoryChainNoSymlink(
  abrainHome: string,
  target: string,
  afterDurableCreate?: (directory: string) => void,
): Promise<void> {
  if (!isPathInside(abrainHome, target)) throw failure("PROPOSITION_POLICY_PUSH_PATH_ESCAPE", "directory create target escapes abrain", { target });
  let current = abrainHome;
  for (const component of path.relative(abrainHome, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let created = false;
    try {
      await fs.mkdir(current, { mode: 0o700 });
      await fsyncDirectory(path.dirname(current));
      created = true;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(current) !== current) throw failure("PROPOSITION_POLICY_PUSH_TARGET_UNSAFE", "created/existing directory chain is unsafe", { current });
    if (created) afterDurableCreate?.(current);
  }
}

async function assertExistingDirectoryChainNoSymlink(start: string, target: string): Promise<void> {
  let current = path.resolve(start);
  for (const component of path.relative(current, path.resolve(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_POLICY_PUSH_PATH_UNSAFE", "directory chain contains a symlink or non-directory", { current });
  }
}

async function assertSafeRegularFileLocation(file: string, label: string, options: { allowMissingLeaf: boolean }): Promise<void> {
  const parent = path.dirname(file);
  await assertExistingDirectoryChainNoSymlink(path.parse(parent).root, parent);
  if (await fs.realpath(parent) !== parent) throw failure("PROPOSITION_POLICY_PUSH_PATH_UNSAFE", `${label} parent realpath differs`, { parent });
  const stat = await lstatIfPresent(file);
  if (!stat) {
    if (!options.allowMissingLeaf) throw notAuthorized("INTENT_MISSING", `${label} is missing`, { file });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) throw failure("PROPOSITION_POLICY_PUSH_PATH_UNSAFE", `${label} is a symlink, non-file, or foreign realpath`, { file });
}

async function inventoryTree(root: string): Promise<readonly PublicationInventoryRow[]> {
  const rows: PublicationInventoryRow[] = [];
  const walk = async (file: string): Promise<void> => {
    const stat = await fs.lstat(file);
    const relativeName = relativeUnix(root, file) || ".";
    if (stat.isSymbolicLink()) {
      const value = await fs.readlink(file);
      rows.push({ relative_name: relativeName, kind: "symlink", bytes: 0, sha256: sha256Hex(value), symlink_value: value });
      return;
    }
    if (stat.isDirectory()) {
      rows.push({ relative_name: relativeName, kind: "directory", bytes: 0, sha256: jcsSha256Hex({ kind: "directory" }), symlink_value: null });
      for (const child of (await fs.readdir(file)).sort(compareCodeUnits)) await walk(path.join(file, child));
      return;
    }
    if (!stat.isFile()) throw failure("PROPOSITION_POLICY_PUSH_SNAPSHOT_UNSUPPORTED", "snapshot found an unsupported filesystem entry", { file });
    const content = await fs.readFile(file);
    rows.push({ relative_name: relativeName, kind: "file", bytes: content.length, sha256: sha256Hex(content), symlink_value: null });
  };
  await walk(root);
  rows.sort((left, right) => compareCodeUnits(left.relative_name, right.relative_name));
  return Object.freeze(rows);
}

export function diffPublicationInventory(before: readonly PublicationInventoryRow[], after: readonly PublicationInventoryRow[]) {
  const beforeMap = new Map(before.map((row) => [row.relative_name, row]));
  const afterMap = new Map(after.map((row) => [row.relative_name, row]));
  return deepFreeze({
    created: after.filter((row) => !beforeMap.has(row.relative_name)),
    modified: after.filter((row) => beforeMap.has(row.relative_name) && canonicalizeJcs(beforeMap.get(row.relative_name)) !== canonicalizeJcs(row)),
    removed: before.filter((row) => !afterMap.has(row.relative_name)),
  });
}

function protectedOutsideTargetHash(rows: readonly PublicationInventoryRow[], abrainHome: string, targetRoot: string): string {
  const targetRelative = relativeUnix(abrainHome, targetRoot);
  const ancestors = new Set<string>();
  const parts = targetRelative.split("/");
  for (let index = 1; index < parts.length; index += 1) ancestors.add(parts.slice(0, index).join("/"));
  const protectedRows = rows.filter((row) => row.relative_name !== targetRelative
    && !row.relative_name.startsWith(`${targetRelative}/`)
    && !ancestors.has(row.relative_name));
  return jcsSha256Hex(protectedRows);
}

function assertMutationWhitelist(options: {
  abrainHome: string;
  targetRoot: string;
  bundleHash: string;
  intentHash: string;
  diff: ReturnType<typeof diffPublicationInventory>;
}): void {
  const target = relativeUnix(options.abrainHome, options.targetRoot);
  const allowedCreated = new Set<string>();
  const parts = target.split("/");
  for (let index = 1; index <= parts.length; index += 1) allowedCreated.add(parts.slice(0, index).join("/"));
  allowedCreated.add(`${target}/bundles`);
  allowedCreated.add(`${target}/bundles/${options.bundleHash}`);
  for (const name of ARTIFACT_NAMES) allowedCreated.add(`${target}/bundles/${options.bundleHash}/${name}`);
  allowedCreated.add(`${target}/latest`);
  const stagePrefix = `${target}/staging/${options.intentHash}`;
  if (options.diff.created.some((row) => !allowedCreated.has(row.relative_name))
    || options.diff.modified.length > 0
    || options.diff.removed.some((row) => row.relative_name !== `${target}/staging` && row.relative_name !== stagePrefix && !row.relative_name.startsWith(`${stagePrefix}/`))) {
    throw failure("PROPOSITION_POLICY_PUSH_MUTATION_WHITELIST", "publication diff exceeds the exact mutation whitelist", { diff: options.diff, allowedCreated: [...allowedCreated].sort(compareCodeUnits) });
  }
}

function productionIntentPath(repoRoot: string, bundleHash: string): string {
  return path.join(repoRoot, ...publicationIntentRelative(bundleHash).split("/"));
}

function expectedTargetRoot(abrainHome: string): string {
  return path.join(abrainHome, ...PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE.split("/"));
}

function canonicalJson(value: unknown): string {
  return `${canonicalizeJcs(value)}\n`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw notAuthorized("SHAPE_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
}

function assertSha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw notAuthorized("HASH_INVALID", `${at} must be lowercase SHA-256`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw notAuthorized("SHAPE_INVALID", "expected object");
  return value as Record<string, unknown>;
}

async function lstatIfPresent(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(file);
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return null;
    throw err;
  }
}

function isAlreadyExists(err: unknown): boolean {
  return isNodeErrorCode(err, "EEXIST") || isNodeErrorCode(err, "ENOTEMPTY");
}

function isNodeErrorCode(err: unknown, code: string): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeUnix(parent: string, child: string): string {
  return path.relative(parent, child).split(path.sep).join("/");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "ERROR";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notAuthorized(reason: string, message: string, detail?: Record<string, unknown>): PropositionPolicyPushPublicationError {
  return new PropositionPolicyPushPublicationError("NOT_AUTHORIZED", `${reason}: ${message}`, { reason, ...detail });
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionPolicyPushPublicationError {
  return new PropositionPolicyPushPublicationError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

async function buildSyntheticIntentFixture(options: {
  abrainHome: string;
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  foreignAbrainHome?: string;
}): Promise<PublicationIntent> {
  const boundHome = options.foreignAbrainHome ?? options.abrainHome;
  const snapshot = await capturePublicationWholeSnapshot(boundHome);
  const plan = buildPlannedPublicationDiff({
    abrainHome: boundHome,
    targetRelativeName: PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
    bundle: options.bundle,
    snapshot,
  });
  const planRelative = publicationPlannedDiffRelative(options.bundle.manifest.bundle_hash);
  await writePublicationEvidenceArtifact(options.repoRoot, planRelative, plan);
  const reviewPaths = publicationReviewRelativePaths(options.bundle.manifest.bundle_hash);
  for (const [index, spec] of PROPOSITION_POLICY_PUSH_REVIEW_VENDORS.entries()) {
    const output = buildPublicationReviewOutput({
      vendor: spec.vendor as PublicationReviewVendor,
      model: `synthetic-${index + 1}`,
      plannedDiffRelativePath: planRelative,
      plannedDiffSha256: plan.planned_diff_sha256,
    });
    await writePublicationEvidenceArtifact(options.repoRoot, reviewPaths[index]!, output);
  }
  const evidence = await readPublicationEvidenceBinding({ repoRoot: options.repoRoot, bundle: options.bundle, expectedPlan: plan });
  return buildPublicationIntent({
    mode: "sandbox_test",
    abrainHome: boundHome,
    repoRoot: options.repoRoot,
    bundle: options.bundle,
    wholeAbrainSnapshotHash: snapshot.summary.snapshot_hash,
    publicationEvidence: evidence,
    authorization: {
      kind: "synthetic_test_fixture",
      role: "test_fixture",
      authorization_text_sha256: sha256Hex("synthetic-test-fixture-authorization"),
      transcript: null,
    },
  });
}

async function publishSandboxFixture(options: {
  abrainHome: string;
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  intentPath?: string;
  targetRootOverrideForTest?: string;
  testCrashAt?: "ancestor_partial" | "staging_partial" | "bundle_ready" | "complete_latest";
}): Promise<PublicationResult> {
  if (!options.intentPath) throw notAuthorized("INTENT_REQUIRED", "sandbox fixture also requires a durable intent");
  return publishInternal({ ...options, intentPath: options.intentPath, mode: "sandbox_test" });
}

async function readSandboxFixture(abrainHomeInput: string): Promise<PropositionPolicyPushBundle> {
  const abrainHome = await assertAbrainHome(abrainHomeInput, "sandbox_test");
  return readPublishedInternal(abrainHome);
}

export const __TEST = Object.freeze({
  buildSyntheticIntentFixture,
  publishSandboxFixture,
  readSandboxFixture,
  productionIntentPath,
  diffInventory: diffPublicationInventory,
});
