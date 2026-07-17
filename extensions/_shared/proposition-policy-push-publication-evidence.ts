import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, fsyncDirectory, type DurableCreateStatus } from "./durable-write";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
  validatePropositionPolicyPushBundle,
  type PropositionPolicyPushBundle,
} from "./proposition-policy-push-shadow";

export const PROPOSITION_POLICY_PUSH_PLANNED_DIFF_SCHEMA = "proposition-policy-push-planned-publication-diff/v1" as const;
export const PROPOSITION_POLICY_PUSH_REVIEW_OUTPUT_SCHEMA = "proposition-policy-push-review-output/v1" as const;
export const PROPOSITION_POLICY_PUSH_REVIEW_RECORD_SCHEMA = "proposition-policy-push-review-record/v1" as const;

const PLANNED_DIFF_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this planned diff object with planned_diff_sha256 omitted" as const;
const REVIEW_RECORD_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this review record with review_record_sha256 omitted" as const;
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const PROPOSITION_POLICY_PUSH_REVIEW_VENDORS = Object.freeze([
  { vendor: "Anthropic", file_name: "01-anthropic.json" },
  { vendor: "DeepSeek", file_name: "02-deepseek.json" },
  { vendor: "MiniMax", file_name: "03-minimax.json" },
  { vendor: "Moonshot", file_name: "04-moonshot.json" },
  { vendor: "OpenAI", file_name: "05-openai.json" },
  { vendor: "Z.ai", file_name: "06-zai.json" },
] as const);

export type PublicationReviewVendor = typeof PROPOSITION_POLICY_PUSH_REVIEW_VENDORS[number]["vendor"];
type ArtifactName = typeof ARTIFACT_NAMES[number];

export interface PublicationEvidenceInventoryRow {
  relative_name: string;
  kind: "directory" | "file" | "symlink";
  bytes: number;
  sha256: string;
  symlink_value: string | null;
}

export interface PublicationEvidenceSnapshotSummary {
  schema_version: string;
  scope: "whole_abrain_no_carve_out";
  entry_count: number;
  directory_count: number;
  file_count: number;
  symlink_count: number;
  bytes: number;
  inventory_hash: string;
  snapshot_hash: string;
}

export interface PublicationEvidenceSnapshotCapture {
  summary: PublicationEvidenceSnapshotSummary;
  rows: readonly PublicationEvidenceInventoryRow[];
}

export interface PlannedPublicationDiff {
  schema_version: typeof PROPOSITION_POLICY_PUSH_PLANNED_DIFF_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  planned_diff_hash_scope: typeof PLANNED_DIFF_HASH_SCOPE;
  artifact_nature: "deterministic_publication_plan_not_execution_result";
  deployment: {
    abrain_home: string;
    target_root: string;
    target_relative_name: string;
    target_prestate: "absent";
  };
  bundle: {
    manifest_schema_version: typeof PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA;
    bundle_hash: string;
    manifest_sha256: string;
    artifact_rows: readonly { name: ArtifactName; bytes: number; sha256: string }[];
  };
  absent_prestate: PublicationEvidenceSnapshotSummary;
  protected_prestate: {
    scope: "whole_abrain_outside_target_and_new_target_ancestors";
    entry_count: number;
    inventory_hash: string;
  };
  exact_final_mutation_inventory: {
    created: readonly PublicationEvidenceInventoryRow[];
    modified: readonly never[];
    removed: readonly never[];
  };
  transient_protocol: {
    staging_relative_name: string;
    deterministic_paths_only: true;
    no_lock_files_or_directories: true;
    final_files_no_replace: true;
    latest_relative_symlink_no_replace: true;
  };
  planned_diff_sha256: string;
}

export interface PublicationReviewOutput {
  schema_version: typeof PROPOSITION_POLICY_PUSH_REVIEW_OUTPUT_SCHEMA;
  canonicalization: "RFC8785-JCS";
  artifact_nature: "review_artifact_bytes_with_named_vendor_model_claim_requiring_trusted_user_attestation_not_cryptographic_vendor_provenance";
  vendor: PublicationReviewVendor;
  model: string;
  verdict: "SIGN";
  reviewed_planned_diff_relative_path: string;
  planned_diff_sha256: string;
}

export interface PublicationReviewSignBinding {
  vendor: PublicationReviewVendor;
  model: string;
  verdict: "SIGN";
  relative_path: string;
  raw_sha256: string;
  planned_diff_sha256: string;
}

export interface PublicationReviewRecord {
  schema_version: typeof PROPOSITION_POLICY_PUSH_REVIEW_RECORD_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  review_record_hash_scope: typeof REVIEW_RECORD_HASH_SCOPE;
  artifact_nature: "six_review_artifact_byte_bindings_plus_trusted_user_attestation_not_cryptographic_vendor_provenance";
  planned_diff_sha256: string;
  verdict: "unanimous_SIGN";
  signs: readonly PublicationReviewSignBinding[];
  review_record_sha256: string;
}

export interface PublicationEvidenceBinding {
  evidence_pack_relative_path: string;
  planned_diff_artifact: {
    relative_path: string;
    raw_sha256: string;
    planned_diff_sha256: string;
  };
  review_record: PublicationReviewRecord;
}

export class PropositionPolicyPushEvidenceError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyPushEvidenceError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function publicationEvidencePackRelative(bundleHash: string): string {
  assertSha256(bundleHash, "bundleHash");
  return `docs/evidence/adr0040-p2a2-publication-review-${bundleHash}`;
}

export function publicationPlannedDiffRelative(bundleHash: string): string {
  return `${publicationEvidencePackRelative(bundleHash)}/planned-publication-diff.json`;
}

export function publicationReviewRelativePaths(bundleHash: string): readonly string[] {
  const root = publicationEvidencePackRelative(bundleHash);
  return Object.freeze(PROPOSITION_POLICY_PUSH_REVIEW_VENDORS.map((row) => `${root}/${row.file_name}`));
}

export function publicationIntentRelative(bundleHash: string): string {
  return `${publicationEvidencePackRelative(bundleHash)}/publication-intent.json`;
}

export function buildPlannedPublicationDiff(options: {
  abrainHome: string;
  targetRelativeName: string;
  bundle: PropositionPolicyPushBundle;
  snapshot: PublicationEvidenceSnapshotCapture;
}): PlannedPublicationDiff {
  validatePropositionPolicyPushBundle(options.bundle);
  validateSnapshot(options.snapshot);
  const abrainHome = path.resolve(options.abrainHome);
  const targetRelativeName = normalizeRelative(options.targetRelativeName, "targetRelativeName");
  const targetRoot = path.join(abrainHome, ...targetRelativeName.split("/"));
  const rowMap = new Map(options.snapshot.rows.map((row) => [row.relative_name, row]));
  if ([...rowMap.keys()].some((name) => name === targetRelativeName || name.startsWith(`${targetRelativeName}/`))) {
    fail("PLANNED_DIFF_TARGET_PRESENT", "planned publication diff requires an absent target", { targetRelativeName });
  }

  const created: PublicationEvidenceInventoryRow[] = [];
  const parts = targetRelativeName.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    const relativeName = parts.slice(0, index).join("/");
    if (!rowMap.has(relativeName)) created.push(directoryRow(relativeName));
  }
  const bundleRelative = `${targetRelativeName}/bundles/${options.bundle.manifest.bundle_hash}`;
  for (const relativeName of [`${targetRelativeName}/bundles`, bundleRelative]) created.push(directoryRow(relativeName));
  for (const name of ARTIFACT_NAMES) {
    const bytes = Buffer.from(options.bundle.bytes[name], "utf-8");
    created.push({ relative_name: `${bundleRelative}/${name}`, kind: "file", bytes: bytes.length, sha256: sha256Hex(bytes), symlink_value: null });
  }
  const latestValue = `bundles/${options.bundle.manifest.bundle_hash}`;
  created.push({ relative_name: `${targetRelativeName}/latest`, kind: "symlink", bytes: 0, sha256: sha256Hex(latestValue), symlink_value: latestValue });
  created.sort((left, right) => compareCodeUnits(left.relative_name, right.relative_name));
  assertUniqueRows(created, "exact_final_mutation_inventory.created");

  const protectedRows = protectedPrestateRows(options.snapshot.rows, targetRelativeName, new Set(created.map((row) => row.relative_name)));
  const artifactRows = ARTIFACT_NAMES.map((name) => ({
    name,
    bytes: Buffer.byteLength(options.bundle.bytes[name]),
    sha256: sha256Hex(options.bundle.bytes[name]),
  }));
  const base = {
    schema_version: PROPOSITION_POLICY_PUSH_PLANNED_DIFF_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    planned_diff_hash_scope: PLANNED_DIFF_HASH_SCOPE,
    artifact_nature: "deterministic_publication_plan_not_execution_result" as const,
    deployment: {
      abrain_home: abrainHome,
      target_root: targetRoot,
      target_relative_name: targetRelativeName,
      target_prestate: "absent" as const,
    },
    bundle: {
      manifest_schema_version: PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
      bundle_hash: options.bundle.manifest.bundle_hash,
      manifest_sha256: sha256Hex(options.bundle.bytes["manifest.json"]),
      artifact_rows: Object.freeze(artifactRows),
    },
    absent_prestate: deepFreeze({ ...options.snapshot.summary }),
    protected_prestate: {
      scope: "whole_abrain_outside_target_and_new_target_ancestors" as const,
      entry_count: protectedRows.length,
      inventory_hash: jcsSha256Hex(protectedRows),
    },
    exact_final_mutation_inventory: {
      created: Object.freeze(created.map((row) => deepFreeze({ ...row }))),
      modified: Object.freeze([] as never[]),
      removed: Object.freeze([] as never[]),
    },
    transient_protocol: {
      staging_relative_name: `${targetRelativeName}/staging/<intent_hash>`,
      deterministic_paths_only: true as const,
      no_lock_files_or_directories: true as const,
      final_files_no_replace: true as const,
      latest_relative_symlink_no_replace: true as const,
    },
  };
  const planned = deepFreeze({ ...base, planned_diff_sha256: jcsSha256Hex(base) });
  validatePlannedPublicationDiff(planned, { bundle: options.bundle, abrainHome, targetRelativeName });
  return planned;
}

export function buildPublicationReviewOutput(input: {
  vendor: PublicationReviewVendor;
  model: string;
  plannedDiffRelativePath: string;
  plannedDiffSha256: string;
}): PublicationReviewOutput {
  if (!PROPOSITION_POLICY_PUSH_REVIEW_VENDORS.some((row) => row.vendor === input.vendor)) fail("REVIEW_OUTPUT_INVALID", "review vendor is not in the fixed roster");
  if (typeof input.model !== "string" || !input.model.trim()) fail("REVIEW_OUTPUT_INVALID", "review model must be non-empty");
  assertSha256(input.plannedDiffSha256, "plannedDiffSha256");
  return deepFreeze({
    schema_version: PROPOSITION_POLICY_PUSH_REVIEW_OUTPUT_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    artifact_nature: "review_artifact_bytes_with_named_vendor_model_claim_requiring_trusted_user_attestation_not_cryptographic_vendor_provenance" as const,
    vendor: input.vendor,
    model: input.model,
    verdict: "SIGN" as const,
    reviewed_planned_diff_relative_path: normalizeRelative(input.plannedDiffRelativePath, "plannedDiffRelativePath"),
    planned_diff_sha256: input.plannedDiffSha256,
  });
}

export async function writePublicationEvidenceArtifact(repoRootInput: string, relativePath: string, value: unknown): Promise<DurableCreateStatus> {
  const repoRoot = path.resolve(repoRootInput);
  await assertSafeRepoRoot(repoRoot);
  const file = path.join(repoRoot, ...normalizeRelative(relativePath, "relativePath").split("/"));
  assertInside(repoRoot, file, "evidence artifact");
  await ensureEvidenceParent(repoRoot, path.dirname(file));
  const raw = canonicalJson(value);
  const status = await durableAtomicCreateFile(file, raw, { mode: 0o600 });
  if (status === "collision") fail("PUBLICATION_EVIDENCE_COLLISION", "evidence artifact path contains different bytes", { relativePath });
  if (await fs.readFile(file, "utf-8") !== raw) fail("PUBLICATION_EVIDENCE_READBACK", "evidence artifact readback differs", { relativePath });
  return status;
}

export async function readPublicationEvidenceBinding(options: {
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  expectedPlan: PlannedPublicationDiff;
}): Promise<PublicationEvidenceBinding> {
  validatePropositionPolicyPushBundle(options.bundle);
  const repoRoot = path.resolve(options.repoRoot);
  const bundleHash = options.bundle.manifest.bundle_hash;
  const planRelative = publicationPlannedDiffRelative(bundleHash);
  const planRaw = await readExactRepoEvidenceFile(repoRoot, planRelative);
  const plan = parseCanonical<PlannedPublicationDiff>(planRaw, "planned diff artifact");
  validatePlannedPublicationDiff(plan, {
    bundle: options.bundle,
    abrainHome: options.expectedPlan.deployment.abrain_home,
    targetRelativeName: options.expectedPlan.deployment.target_relative_name,
  });
  if (canonicalizeJcs(plan) !== canonicalizeJcs(options.expectedPlan)) fail("PLANNED_DIFF_STALE", "durable planned diff artifact does not match the current deterministic plan");

  const signs: PublicationReviewSignBinding[] = [];
  const reviewPaths = publicationReviewRelativePaths(bundleHash);
  for (const [index, spec] of PROPOSITION_POLICY_PUSH_REVIEW_VENDORS.entries()) {
    const relativePath = reviewPaths[index]!;
    const raw = await readExactRepoEvidenceFile(repoRoot, relativePath);
    const output = parseCanonical<PublicationReviewOutput>(raw, `review output ${spec.vendor}`);
    validateReviewOutput(output, {
      vendor: spec.vendor,
      plannedDiffRelativePath: planRelative,
      plannedDiffSha256: plan.planned_diff_sha256,
    });
    signs.push({
      vendor: output.vendor,
      model: output.model,
      verdict: output.verdict,
      relative_path: relativePath,
      raw_sha256: sha256Hex(raw),
      planned_diff_sha256: output.planned_diff_sha256,
    });
  }
  const recordBase = {
    schema_version: PROPOSITION_POLICY_PUSH_REVIEW_RECORD_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    review_record_hash_scope: REVIEW_RECORD_HASH_SCOPE,
    artifact_nature: "six_review_artifact_byte_bindings_plus_trusted_user_attestation_not_cryptographic_vendor_provenance" as const,
    planned_diff_sha256: plan.planned_diff_sha256,
    verdict: "unanimous_SIGN" as const,
    signs: Object.freeze(signs.map((row) => deepFreeze({ ...row }))),
  };
  const reviewRecord = deepFreeze({ ...recordBase, review_record_sha256: jcsSha256Hex(recordBase) });
  validatePublicationReviewRecord(reviewRecord, bundleHash);
  return deepFreeze({
    evidence_pack_relative_path: publicationEvidencePackRelative(bundleHash),
    planned_diff_artifact: {
      relative_path: planRelative,
      raw_sha256: sha256Hex(planRaw),
      planned_diff_sha256: plan.planned_diff_sha256,
    },
    review_record: reviewRecord,
  });
}

export async function validatePublicationEvidenceImmediatelyBeforeMutation(options: {
  repoRoot: string;
  abrainHome: string;
  targetRelativeName: string;
  bundle: PropositionPolicyPushBundle;
  currentSnapshot: PublicationEvidenceSnapshotCapture;
  binding: PublicationEvidenceBinding;
}): Promise<PlannedPublicationDiff> {
  const repoRoot = path.resolve(options.repoRoot);
  const bundleHash = options.bundle.manifest.bundle_hash;
  validatePublicationEvidenceBinding(options.binding, bundleHash);
  const expectedPack = publicationEvidencePackRelative(bundleHash);
  if (options.binding.evidence_pack_relative_path !== expectedPack) fail("PUBLICATION_EVIDENCE_PATH", "intent evidence pack path differs from the exact content-bound path");

  const planRaw = await readExactRepoEvidenceFile(repoRoot, options.binding.planned_diff_artifact.relative_path);
  if (sha256Hex(planRaw) !== options.binding.planned_diff_artifact.raw_sha256) fail("PLANNED_DIFF_TAMPERED", "planned diff raw bytes changed after intent binding");
  const plan = parseCanonical<PlannedPublicationDiff>(planRaw, "planned diff artifact");
  validatePlannedPublicationDiff(plan, {
    bundle: options.bundle,
    abrainHome: path.resolve(options.abrainHome),
    targetRelativeName: options.targetRelativeName,
  });
  if (plan.planned_diff_sha256 !== options.binding.planned_diff_artifact.planned_diff_sha256) fail("PLANNED_DIFF_TAMPERED", "planned diff content hash differs from intent binding");

  const reconstructed = reconstructAbsentPrestate(options.currentSnapshot, plan);
  const currentPlan = buildPlannedPublicationDiff({
    abrainHome: options.abrainHome,
    targetRelativeName: options.targetRelativeName,
    bundle: options.bundle,
    snapshot: reconstructed,
  });
  if (canonicalizeJcs(currentPlan) !== canonicalizeJcs(plan)) fail("PLANNED_DIFF_STALE", "current canonical planned publication diff differs immediately before mutation");

  const reviewPaths = publicationReviewRelativePaths(bundleHash);
  for (const [index, spec] of PROPOSITION_POLICY_PUSH_REVIEW_VENDORS.entries()) {
    const sign = options.binding.review_record.signs[index]!;
    const expectedPath = reviewPaths[index]!;
    if (sign.vendor !== spec.vendor || sign.relative_path !== expectedPath) fail("REVIEW_RECORD_INVALID", "review order, vendor, or exact path drifted", { index });
    const raw = await readExactRepoEvidenceFile(repoRoot, expectedPath);
    if (sha256Hex(raw) !== sign.raw_sha256) fail("REVIEW_OUTPUT_TAMPERED", "review output raw bytes changed after intent binding", { vendor: spec.vendor });
    const output = parseCanonical<PublicationReviewOutput>(raw, `review output ${spec.vendor}`);
    validateReviewOutput(output, {
      vendor: spec.vendor,
      plannedDiffRelativePath: planRelativeFor(plan),
      plannedDiffSha256: currentPlan.planned_diff_sha256,
    });
    if (output.model !== sign.model || output.verdict !== sign.verdict || output.planned_diff_sha256 !== sign.planned_diff_sha256) {
      fail("REVIEW_RECORD_INVALID", "review output metadata differs from the intent review record", { vendor: spec.vendor });
    }
  }
  if (options.binding.review_record.planned_diff_sha256 !== currentPlan.planned_diff_sha256) fail("REVIEW_DIFF_STALE", "review record does not bind the current recomputed planned diff");
  return plan;
}

export function validatePublicationEvidenceBinding(binding: PublicationEvidenceBinding, bundleHash: string): void {
  exactKeys(asRecord(binding), ["evidence_pack_relative_path", "planned_diff_artifact", "review_record"], "evidence");
  exactKeys(asRecord(binding.planned_diff_artifact), ["relative_path", "raw_sha256", "planned_diff_sha256"], "evidence.planned_diff_artifact");
  const expectedPack = publicationEvidencePackRelative(bundleHash);
  if (binding.evidence_pack_relative_path !== expectedPack
    || binding.planned_diff_artifact.relative_path !== publicationPlannedDiffRelative(bundleHash)) fail("PUBLICATION_EVIDENCE_PATH", "evidence pack paths are not exact");
  assertSha256(binding.planned_diff_artifact.raw_sha256, "evidence.planned_diff_artifact.raw_sha256");
  assertSha256(binding.planned_diff_artifact.planned_diff_sha256, "evidence.planned_diff_artifact.planned_diff_sha256");
  validatePublicationReviewRecord(binding.review_record, bundleHash);
  if (binding.review_record.planned_diff_sha256 !== binding.planned_diff_artifact.planned_diff_sha256) fail("REVIEW_RECORD_INVALID", "planned diff and review record hashes differ");
}

export function validatePublicationReviewRecord(record: PublicationReviewRecord, bundleHash: string): void {
  exactKeys(asRecord(record), ["schema_version", "canonicalization", "hash_algorithm", "review_record_hash_scope", "artifact_nature", "planned_diff_sha256", "verdict", "signs", "review_record_sha256"], "review_record");
  if (record.schema_version !== PROPOSITION_POLICY_PUSH_REVIEW_RECORD_SCHEMA
    || record.canonicalization !== "RFC8785-JCS"
    || record.hash_algorithm !== "sha256"
    || record.review_record_hash_scope !== REVIEW_RECORD_HASH_SCOPE
    || record.artifact_nature !== "six_review_artifact_byte_bindings_plus_trusted_user_attestation_not_cryptographic_vendor_provenance"
    || record.verdict !== "unanimous_SIGN"
    || !Array.isArray(record.signs)
    || record.signs.length !== PROPOSITION_POLICY_PUSH_REVIEW_VENDORS.length) fail("REVIEW_RECORD_INVALID", "review record identity or cardinality invalid");
  assertSha256(record.planned_diff_sha256, "review_record.planned_diff_sha256");
  const expectedPaths = publicationReviewRelativePaths(bundleHash);
  const seenVendors = new Set<string>();
  const seenPaths = new Set<string>();
  for (const [index, sign] of record.signs.entries()) {
    exactKeys(asRecord(sign), ["vendor", "model", "verdict", "relative_path", "raw_sha256", "planned_diff_sha256"], `review_record.signs[${index}]`);
    const spec = PROPOSITION_POLICY_PUSH_REVIEW_VENDORS[index]!;
    if (sign.vendor !== spec.vendor
      || sign.relative_path !== expectedPaths[index]
      || sign.verdict !== "SIGN"
      || typeof sign.model !== "string" || !sign.model
      || sign.planned_diff_sha256 !== record.planned_diff_sha256
      || seenVendors.has(sign.vendor)
      || seenPaths.has(sign.relative_path)) fail("REVIEW_RECORD_INVALID", "reviews are missing, duplicated, reordered, or foreign", { index });
    seenVendors.add(sign.vendor);
    seenPaths.add(sign.relative_path);
    assertSha256(sign.raw_sha256, `review_record.signs[${index}].raw_sha256`);
  }
  assertSha256(record.review_record_sha256, "review_record.review_record_sha256");
  const base = { ...record } as Record<string, unknown>;
  delete base.review_record_sha256;
  if (jcsSha256Hex(base) !== record.review_record_sha256) fail("REVIEW_RECORD_INVALID", "review record self-hash mismatch");
}

export function validatePlannedPublicationDiff(plan: PlannedPublicationDiff, context: {
  bundle: PropositionPolicyPushBundle;
  abrainHome: string;
  targetRelativeName: string;
}): void {
  exactKeys(asRecord(plan), ["schema_version", "canonicalization", "hash_algorithm", "planned_diff_hash_scope", "artifact_nature", "deployment", "bundle", "absent_prestate", "protected_prestate", "exact_final_mutation_inventory", "transient_protocol", "planned_diff_sha256"], "planned_diff");
  if (plan.schema_version !== PROPOSITION_POLICY_PUSH_PLANNED_DIFF_SCHEMA
    || plan.canonicalization !== "RFC8785-JCS"
    || plan.hash_algorithm !== "sha256"
    || plan.planned_diff_hash_scope !== PLANNED_DIFF_HASH_SCOPE
    || plan.artifact_nature !== "deterministic_publication_plan_not_execution_result") fail("PLANNED_DIFF_INVALID", "planned diff identity drifted");
  exactKeys(asRecord(plan.deployment), ["abrain_home", "target_root", "target_relative_name", "target_prestate"], "planned_diff.deployment");
  const abrainHome = path.resolve(context.abrainHome);
  const targetRelativeName = normalizeRelative(context.targetRelativeName, "targetRelativeName");
  if (plan.deployment.abrain_home !== abrainHome
    || plan.deployment.target_root !== path.join(abrainHome, ...targetRelativeName.split("/"))
    || plan.deployment.target_relative_name !== targetRelativeName
    || plan.deployment.target_prestate !== "absent") fail("PLANNED_DIFF_INVALID", "planned diff deployment binding is foreign");
  exactKeys(asRecord(plan.bundle), ["manifest_schema_version", "bundle_hash", "manifest_sha256", "artifact_rows"], "planned_diff.bundle");
  const expectedArtifactRows = ARTIFACT_NAMES.map((name) => ({ name, bytes: Buffer.byteLength(context.bundle.bytes[name]), sha256: sha256Hex(context.bundle.bytes[name]) }));
  if (plan.bundle.manifest_schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA
    || plan.bundle.bundle_hash !== context.bundle.manifest.bundle_hash
    || plan.bundle.manifest_sha256 !== sha256Hex(context.bundle.bytes["manifest.json"])
    || canonicalizeJcs(plan.bundle.artifact_rows) !== canonicalizeJcs(expectedArtifactRows)) fail("PLANNED_DIFF_INVALID", "planned diff bundle binding is stale or foreign");
  validateSnapshot({ summary: plan.absent_prestate, rows: [] }, { allowRowsOmitted: true });
  exactKeys(asRecord(plan.protected_prestate), ["scope", "entry_count", "inventory_hash"], "planned_diff.protected_prestate");
  if (plan.protected_prestate.scope !== "whole_abrain_outside_target_and_new_target_ancestors"
    || !Number.isSafeInteger(plan.protected_prestate.entry_count) || plan.protected_prestate.entry_count < 0) fail("PLANNED_DIFF_INVALID", "protected prestate contract invalid");
  assertSha256(plan.protected_prestate.inventory_hash, "planned_diff.protected_prestate.inventory_hash");
  exactKeys(asRecord(plan.exact_final_mutation_inventory), ["created", "modified", "removed"], "planned_diff.exact_final_mutation_inventory");
  if (!Array.isArray(plan.exact_final_mutation_inventory.created)
    || !Array.isArray(plan.exact_final_mutation_inventory.modified) || plan.exact_final_mutation_inventory.modified.length
    || !Array.isArray(plan.exact_final_mutation_inventory.removed) || plan.exact_final_mutation_inventory.removed.length) fail("PLANNED_DIFF_INVALID", "planned final mutation inventory is not exact create-only");
  assertUniqueRows(plan.exact_final_mutation_inventory.created, "planned_diff.exact_final_mutation_inventory.created");
  exactKeys(asRecord(plan.transient_protocol), ["staging_relative_name", "deterministic_paths_only", "no_lock_files_or_directories", "final_files_no_replace", "latest_relative_symlink_no_replace"], "planned_diff.transient_protocol");
  if (plan.transient_protocol.staging_relative_name !== `${targetRelativeName}/staging/<intent_hash>`
    || Object.entries(plan.transient_protocol).some(([key, value]) => key !== "staging_relative_name" && value !== true)) fail("PLANNED_DIFF_INVALID", "transient lock-free protocol drifted");
  assertSha256(plan.planned_diff_sha256, "planned_diff.planned_diff_sha256");
  const base = { ...plan } as Record<string, unknown>;
  delete base.planned_diff_sha256;
  if (jcsSha256Hex(base) !== plan.planned_diff_sha256) fail("PLANNED_DIFF_INVALID", "planned diff self-hash mismatch");
}

async function ensureEvidenceParent(repoRoot: string, parent: string): Promise<void> {
  assertInside(repoRoot, parent, "evidence parent");
  const relative = path.relative(repoRoot, parent);
  let current = repoRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
      await fsyncDirectory(path.dirname(current));
    } catch (err) {
      if (!isNodeErrorCode(err, "EEXIST")) throw err;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(current) !== current) fail("PUBLICATION_EVIDENCE_PATH", "evidence ancestor is unsafe", { current });
  }
}

async function readExactRepoEvidenceFile(repoRoot: string, relativePath: string): Promise<Buffer> {
  await assertSafeRepoRoot(repoRoot);
  const normalized = normalizeRelative(relativePath, "evidence relative path");
  const file = path.join(repoRoot, ...normalized.split("/"));
  assertInside(repoRoot, file, "evidence file");
  const stat = await fs.lstat(file).catch((err: unknown) => {
    if (isNodeErrorCode(err, "ENOENT")) fail("PUBLICATION_EVIDENCE_MISSING", "required durable evidence file is missing", { relativePath: normalized });
    throw err;
  });
  if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) fail("PUBLICATION_EVIDENCE_PATH", "evidence file is a symlink, non-file, or foreign realpath", { relativePath: normalized });
  let current = repoRoot;
  for (const component of path.relative(repoRoot, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const ancestor = await fs.lstat(current);
    if (ancestor.isSymbolicLink() || !ancestor.isDirectory() || await fs.realpath(current) !== current) fail("PUBLICATION_EVIDENCE_PATH", "evidence ancestor is unsafe", { current });
  }
  return fs.readFile(file);
}

async function assertSafeRepoRoot(repoRoot: string): Promise<void> {
  const stat = await fs.lstat(repoRoot).catch((err: unknown) => {
    if (isNodeErrorCode(err, "ENOENT")) fail("PUBLICATION_EVIDENCE_PATH", "repo root is missing", { repoRoot });
    throw err;
  });
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(repoRoot) !== repoRoot) fail("PUBLICATION_EVIDENCE_PATH", "repo root is a symlink, non-directory, or foreign realpath", { repoRoot });
}

function reconstructAbsentPrestate(current: PublicationEvidenceSnapshotCapture, plan: PlannedPublicationDiff): PublicationEvidenceSnapshotCapture {
  validateSnapshot(current);
  const target = plan.deployment.target_relative_name;
  const plannedCreatedRows = new Map(plan.exact_final_mutation_inventory.created.map((row) => [row.relative_name, row]));
  const plannedCreated = new Set(plannedCreatedRows.keys());
  const rows = current.rows.filter((row) => {
    if (row.relative_name === target || row.relative_name.startsWith(`${target}/`)) return false;
    const expected = plannedCreatedRows.get(row.relative_name);
    if (expected) {
      if (canonicalizeJcs(row) !== canonicalizeJcs(expected)) fail("PLANNED_CREATED_STATE_DRIFT", "planned-created recovery row differs from the exact authorized row", { relative_name: row.relative_name });
      return false;
    }
    return true;
  });
  const summary = summarizeRows(rows, plan.absent_prestate.schema_version);
  if (canonicalizeJcs(summary) !== canonicalizeJcs(plan.absent_prestate)) fail("PLANNED_DIFF_STALE", "current state cannot reconstruct the exact bound absent prestate");
  const protectedRows = protectedPrestateRows(current.rows, target, plannedCreated);
  if (protectedRows.length !== plan.protected_prestate.entry_count || jcsSha256Hex(protectedRows) !== plan.protected_prestate.inventory_hash) {
    fail("PROTECTED_PRESTATE_DRIFT", "protected state outside the publication target changed after review");
  }
  return deepFreeze({ summary, rows: Object.freeze(rows.map((row) => deepFreeze({ ...row }))) });
}

function protectedPrestateRows(rows: readonly PublicationEvidenceInventoryRow[], target: string, plannedCreated: ReadonlySet<string>): PublicationEvidenceInventoryRow[] {
  return rows.filter((row) => row.relative_name !== target
    && !row.relative_name.startsWith(`${target}/`)
    && !plannedCreated.has(row.relative_name));
}

function summarizeRows(rows: readonly PublicationEvidenceInventoryRow[], schemaVersion: string): PublicationEvidenceSnapshotSummary {
  const ordered = [...rows].sort((left, right) => compareCodeUnits(left.relative_name, right.relative_name));
  return deepFreeze({
    schema_version: schemaVersion,
    scope: "whole_abrain_no_carve_out" as const,
    entry_count: ordered.length,
    directory_count: ordered.filter((row) => row.kind === "directory").length,
    file_count: ordered.filter((row) => row.kind === "file").length,
    symlink_count: ordered.filter((row) => row.kind === "symlink").length,
    bytes: ordered.reduce((sum, row) => sum + row.bytes, 0),
    inventory_hash: jcsSha256Hex(ordered),
    snapshot_hash: jcsSha256Hex({ scope: "whole_abrain_no_carve_out", rows: ordered }),
  });
}

function validateSnapshot(snapshot: PublicationEvidenceSnapshotCapture, options: { allowRowsOmitted?: boolean } = {}): void {
  const summary = snapshot.summary;
  exactKeys(asRecord(summary), ["schema_version", "scope", "entry_count", "directory_count", "file_count", "symlink_count", "bytes", "inventory_hash", "snapshot_hash"], "snapshot.summary");
  if (typeof summary.schema_version !== "string" || !summary.schema_version || summary.scope !== "whole_abrain_no_carve_out") fail("PLANNED_DIFF_INVALID", "snapshot identity invalid");
  for (const key of ["entry_count", "directory_count", "file_count", "symlink_count", "bytes"] as const) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) fail("PLANNED_DIFF_INVALID", `snapshot.${key} invalid`);
  }
  assertSha256(summary.inventory_hash, "snapshot.inventory_hash");
  assertSha256(summary.snapshot_hash, "snapshot.snapshot_hash");
  if (options.allowRowsOmitted) return;
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length !== summary.entry_count) fail("PLANNED_DIFF_INVALID", "snapshot rows/cardinality invalid");
  assertUniqueRows(snapshot.rows, "snapshot.rows");
  const recomputed = summarizeRows(snapshot.rows, summary.schema_version);
  if (canonicalizeJcs(recomputed) !== canonicalizeJcs(summary)) fail("PLANNED_DIFF_INVALID", "snapshot summary does not match rows");
}

function validateReviewOutput(output: PublicationReviewOutput, expected: {
  vendor: PublicationReviewVendor;
  plannedDiffRelativePath: string;
  plannedDiffSha256: string;
}): void {
  exactKeys(asRecord(output), ["schema_version", "canonicalization", "artifact_nature", "vendor", "model", "verdict", "reviewed_planned_diff_relative_path", "planned_diff_sha256"], "review_output");
  if (output.schema_version !== PROPOSITION_POLICY_PUSH_REVIEW_OUTPUT_SCHEMA
    || output.canonicalization !== "RFC8785-JCS"
    || output.artifact_nature !== "review_artifact_bytes_with_named_vendor_model_claim_requiring_trusted_user_attestation_not_cryptographic_vendor_provenance"
    || output.vendor !== expected.vendor
    || typeof output.model !== "string" || !output.model
    || output.verdict !== "SIGN"
    || output.reviewed_planned_diff_relative_path !== expected.plannedDiffRelativePath
    || output.planned_diff_sha256 !== expected.plannedDiffSha256) fail("REVIEW_OUTPUT_INVALID", "review output canonical metadata is missing, stale, or foreign", { expectedVendor: expected.vendor });
  assertSha256(output.planned_diff_sha256, "review_output.planned_diff_sha256");
}

function parseCanonical<T>(raw: Buffer, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch (err) {
    fail("PUBLICATION_EVIDENCE_MALFORMED", `${label} is not valid JSON`, { error: err instanceof Error ? err.message : String(err) });
  }
  if (!raw.equals(Buffer.from(canonicalJson(parsed), "utf-8"))) fail("PUBLICATION_EVIDENCE_NONCANONICAL", `${label} is not exact RFC8785-JCS plus one newline`);
  return parsed as T;
}

function planRelativeFor(plan: PlannedPublicationDiff): string {
  return publicationPlannedDiffRelative(plan.bundle.bundle_hash);
}

function directoryRow(relativeName: string): PublicationEvidenceInventoryRow {
  return { relative_name: relativeName, kind: "directory", bytes: 0, sha256: jcsSha256Hex({ kind: "directory" }), symlink_value: null };
}

function assertUniqueRows(rows: readonly PublicationEvidenceInventoryRow[], at: string): void {
  const names = rows.map((row) => row.relative_name);
  if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && compareCodeUnits(names[index - 1]!, name) >= 0)) fail("PLANNED_DIFF_INVALID", `${at} must be unique and sorted`);
  for (const [index, row] of rows.entries()) {
    exactKeys(asRecord(row), ["relative_name", "kind", "bytes", "sha256", "symlink_value"], `${at}[${index}]`);
    normalizeRelative(row.relative_name === "." ? "placeholder" : row.relative_name, `${at}[${index}].relative_name`);
    if (!["directory", "file", "symlink"].includes(row.kind) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) fail("PLANNED_DIFF_INVALID", `${at}[${index}] kind/bytes invalid`);
    assertSha256(row.sha256, `${at}[${index}].sha256`);
    if ((row.kind === "symlink") !== (typeof row.symlink_value === "string")) fail("PLANNED_DIFF_INVALID", `${at}[${index}] symlink value invalid`);
  }
}

function normalizeRelative(input: string, at: string): string {
  if (typeof input !== "string" || !input || path.isAbsolute(input) || input.includes("\\")) fail("PUBLICATION_EVIDENCE_PATH", `${at} must be a non-empty Unix relative path`);
  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) fail("PUBLICATION_EVIDENCE_PATH", `${at} is noncanonical or escapes`, { input });
  return normalized;
}

function assertInside(parent: string, child: string, label: string): void {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("PUBLICATION_EVIDENCE_PATH", `${label} escapes or equals repo root`, { child });
}

function canonicalJson(value: unknown): string {
  return `${canonicalizeJcs(value)}\n`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("PUBLICATION_EVIDENCE_SHAPE", `${at} has unexpected keys`, { actual, expected: wanted });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PUBLICATION_EVIDENCE_SHAPE", "expected object");
  return value as Record<string, unknown>;
}

function assertSha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("PUBLICATION_EVIDENCE_HASH", `${at} must be lowercase SHA-256`);
  return value;
}

function isNodeErrorCode(err: unknown, code: string): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionPolicyPushEvidenceError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
