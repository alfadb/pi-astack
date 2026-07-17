import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, durableAtomicWriteFile, type DurableCreateStatus } from "./durable-write";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { loadL1SchemaRegistry } from "./l1-schema-registry";
import {
  PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS,
  PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
  validatePropositionPolicyPushBundle,
  type PropositionPolicyPushBundle,
} from "./proposition-policy-push-shadow";
import { buildTypescriptStaticDependencyGraph, validateTypescriptStaticDependencyGraph } from "./typescript-static-dependency-graph";

export const PROPOSITION_POLICY_PUSH_PUBLICATION_PLAN_V2_SCHEMA = "proposition-policy-push-publication-plan/v2" as const;
export const PROPOSITION_POLICY_PUSH_DRIFT_REGISTRY_SCHEMA = "proposition-policy-push-execution-drift-registry/v1" as const;
export const PROPOSITION_POLICY_PUSH_PUBLICATION_REVIEW_V2_SCHEMA = "proposition-policy-push-publication-review/v2" as const;
export const PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_V3_SCHEMA = "proposition-policy-push-publication-intent/v3" as const;
export const PROPOSITION_POLICY_PUSH_HARD_ABRAIN = "/home/worker/.abrain" as const;
export const PROPOSITION_POLICY_PUSH_TARGET_RELATIVE = ".state/sediment/proposition-policy-push-shadow/v1" as const;
export const PROPOSITION_POLICY_PUSH_HARD_TARGET = `${PROPOSITION_POLICY_PUSH_HARD_ABRAIN}/${PROPOSITION_POLICY_PUSH_TARGET_RELATIVE}` as const;
export const PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH = "dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0" as const;
export const PROPOSITION_POLICY_PUSH_V1_PLAN_RAW_SHA256 = "7cd37d339625be77a11bc2c51a9abcf2a95776d8433f9fdaa1ce83fc9acbbe8f" as const;
export const PROPOSITION_POLICY_PUSH_V1_PLAN_RELATIVE = `docs/evidence/adr0040-p2a2-publication-review-${PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH}/planned-publication-diff.json` as const;
export const PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE = `docs/evidence/adr0040-p2a2-publication-review-${PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH}/publication-plan-v2.json` as const;
export const PROPOSITION_POLICY_PUSH_RUNTIME_SETTINGS = "/home/worker/.pi/agent/pi-astack-settings.json" as const;
export const PROPOSITION_POLICY_PUSH_PRODUCTION_CLI = "scripts/publish-proposition-policy-push-shadow.mjs" as const;
export const PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V1_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a22-live-publication-read-only-preview-dossier.json" as const;
export const PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V2_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a22-live-publication-read-only-preview-dossier-v2.json" as const;
export const PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V3_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a22-live-publication-read-only-preview-dossier-v3.json" as const;
export const PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V4_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a22-live-publication-read-only-preview-dossier-v4.json" as const;
export const PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V5_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a22-live-publication-read-only-preview-dossier-v5.json" as const;

const PLAN_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this publication plan with plan_hash omitted" as const;
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
const SHA256 = /^[0-9a-f]{64}$/;
const REVIEW_VENDORS = Object.freeze([
  { vendor: "Anthropic", file_name: "01-anthropic.json" },
  { vendor: "DeepSeek", file_name: "02-deepseek.json" },
  { vendor: "MiniMax", file_name: "03-minimax.json" },
  { vendor: "Moonshot", file_name: "04-moonshot.json" },
  { vendor: "OpenAI", file_name: "05-openai.json" },
  { vendor: "Z.ai", file_name: "06-zai.json" },
] as const);

export const PROPOSITION_POLICY_PUSH_HISTORICAL_EVIDENCE = Object.freeze([
  { generation: "p2a21-v1", relative_path: "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier.json", schema_version: "proposition-policy-push-publication-contract-dossier/v1", content_hash: "9bb992493a30883a1bdcd2ea0631b90354dcc8c274b77a0bbd17ab821d7c7716", raw_sha256: "810ff59ae174e52bc5a49f6e7e9c508965956122e7746b99f30f8a468c051554" },
  { generation: "p2a21-v2", relative_path: "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier-v2.json", schema_version: "proposition-policy-push-publication-contract-dossier/v2", content_hash: "94b2abbc707b117a239ae9e60086ea0bc78a97565b637f4abedb450b20643268", raw_sha256: "b4b3b96d4f20b3617a4ae8a0de090e16e9de6dfbf32a34fe6238f711c0acb029" },
  { generation: "p2a21-v3", relative_path: "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier-v3.json", schema_version: "proposition-policy-push-publication-contract-dossier/v3", content_hash: "a87dbcecc48e6330608d562de5f29c9d168fbe7c36cdab1362970119664bf0f5", raw_sha256: "fe4bc1df10ffbc572a3eb269dca05b6f51c9961b957fffa2ce45ffee4e555de4" },
  { generation: "p2a21-v4", relative_path: "docs/evidence/2026-07-14-adr0040-p2a21-production-read-only-preview-dossier-v4.json", schema_version: "proposition-policy-push-publication-contract-dossier/v4", content_hash: "d6b6d30562007340899fabe73b05fa88ea6dafd7ec849e6f4261692464712fc9", raw_sha256: "d4a5e662db8b792041069b7721c3e15cea358e097cb896b807b9d6fc99363bad" },
  { generation: "p2a22-v1", relative_path: PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V1_RELATIVE, schema_version: "proposition-policy-push-live-publication-contract-dossier/v1", content_hash: "cde72953ff5122d44c7ee4492b0c148226f73948191c15d87b5743f61e1faa4a", raw_sha256: "d32fc467fab06230337151b49044f0e9ebca8dbc3c3e165c2543fb73097b2bc7" },
  { generation: "p2a22-v2", relative_path: PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V2_RELATIVE, schema_version: "proposition-policy-push-live-publication-contract-dossier/v2", content_hash: "06de041f9dfd2b4218d4565566f9017be1a48dcfa37b42d1dc04662a98995f6e", raw_sha256: "6166c0b7e93ef0d357e3a435731daa3164796e2a38511e4e68968beba2cc0378" },
  { generation: "p2a22-v3", relative_path: PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V3_RELATIVE, schema_version: "proposition-policy-push-live-publication-contract-dossier/v3", content_hash: "9282d75394c820f6b2e8e3d266274723ff7ba2cbd35d9a9054e284f4e35a185b", raw_sha256: "9b402b42b4411816cec8eb36d311878fc6a81488754196f1d3bddc791eefd54f" },
  { generation: "p2a22-v4", relative_path: PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V4_RELATIVE, schema_version: "proposition-policy-push-live-publication-contract-dossier/v4", content_hash: "c99c2cf022416a2dff3185befe4830aaf82c5155d912cd7b9e91cfca247ecab5", raw_sha256: "fa3c271e72f07a300110c2dbb64869ccad1f2008d71af5fe0d5dc903cd55c27e" },
] as const);

const PACKAGE_COMMANDS = Object.freeze({
  "generate:proposition-policy-push-publication-plan-v2": "node scripts/generate-proposition-policy-push-publication-plan-v2.mjs",
  "preview:proposition-policy-push-live-publication": "node scripts/preview-proposition-policy-push-live-publication.mjs",
  "publish:proposition-policy-push-shadow": "node scripts/publish-proposition-policy-push-shadow.mjs",
  "smoke:proposition-policy-push-live-publication-p2a22": "node scripts/smoke-proposition-policy-push-live-publication-p2a22.mjs",
} as const);

const FORBIDDEN_RUNTIME_PUBLICATION_PATHS = Object.freeze([
  PROPOSITION_POLICY_PUSH_PRODUCTION_CLI,
  "extensions/_shared/proposition-policy-push-live-publication-plan.ts",
  "extensions/_shared/proposition-policy-push-live-publication.ts",
  "extensions/_shared/proposition-policy-push-shadow-publication.ts",
  "scripts/proposition-policy-push-bootstrap-helper.mjs",
  "scripts/proposition-policy-push-installer-helper.mjs",
  "scripts/proposition-policy-push-confinement-probe.mjs",
] as const);

export const PROPOSITION_POLICY_PUSH_REVIEW_V2_VENDORS = REVIEW_VENDORS;
export const PROPOSITION_POLICY_PUSH_DRIFT_PATHS = Object.freeze([
  ".state/memory/path-a-ledger.jsonl",
  ".state/git-sync.jsonl",
  ".state/sediment/constraint-shadow/session-start-dualread/audit.jsonl",
] as const);

const SOURCE_PATHS = Object.freeze([
  ...PROPOSITION_POLICY_PUSH_REQUIRED_SOURCE_PATHS,
  "package.json",
  PROPOSITION_POLICY_PUSH_PRODUCTION_CLI,
  "extensions/_shared/proposition-policy-push-live-publication-plan.ts",
  "extensions/_shared/proposition-policy-push-live-publication.ts",
  "extensions/_shared/proposition-policy-push-publication-evidence.ts",
  "extensions/_shared/proposition-policy-push-shadow-publication.ts",
  "extensions/_shared/proposition-p1b-transcript.ts",
  "extensions/_shared/durable-write.ts",
  "extensions/_shared/jcs.ts",
  "extensions/_shared/typescript-static-dependency-graph.ts",
  "scripts/proposition-policy-push-bootstrap-helper.mjs",
  "scripts/proposition-policy-push-installer-helper.mjs",
  "scripts/proposition-policy-push-confinement-probe.mjs",
  "scripts/generate-proposition-policy-push-publication-plan-v2.mjs",
  "scripts/preview-proposition-policy-push-live-publication.mjs",
  "scripts/smoke-proposition-policy-push-live-publication-p2a22.mjs",
] as const);

export interface StaticInventoryRow {
  relative_name: string;
  kind: "directory" | "file" | "symlink";
  bytes: number;
  sha256: string;
  symlink_value: string | null;
  mode: number;
  uid: number;
  gid: number;
  children: readonly string[] | null;
}

export interface PublicationPlanV2 {
  schema_version: typeof PROPOSITION_POLICY_PUSH_PUBLICATION_PLAN_V2_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  plan_hash_scope: typeof PLAN_HASH_SCOPE;
  artifact_nature: "static_future_review_and_user_authorization_target_not_execution_result";
  deployment: Readonly<Record<string, unknown>>;
  bundle: Readonly<Record<string, unknown>>;
  exact_final_inventory: readonly StaticInventoryRow[];
  proposition_anchors: Readonly<Record<string, unknown>>;
  drift_registry: Readonly<Record<string, unknown>>;
  forensic_contract: Readonly<Record<string, unknown>>;
  confinement: Readonly<Record<string, unknown>>;
  execution_contract: Readonly<Record<string, unknown>>;
  historical_v1: Readonly<Record<string, unknown>>;
  prohibited_bindings: Readonly<Record<string, boolean>>;
  plan_hash: string;
}

export class PropositionPolicyPushPlanV2Error extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyPushPlanV2Error";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function publicationReviewV2RelativePaths(): readonly string[] {
  const root = path.posix.dirname(PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE);
  return Object.freeze(REVIEW_VENDORS.map((row) => `${root}/v2-reviews/${row.file_name}`));
}

export function publicationIntentV3Relative(): string {
  return `${path.posix.dirname(PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE)}/publication-intent-v3.json`;
}

export function canonicalJson(value: unknown): string {
  return `${canonicalizeJcs(value)}\n`;
}

export async function buildPublicationPlanV2(options: {
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
}): Promise<PublicationPlanV2> {
  const repoRoot = path.resolve(options.repoRoot);
  validatePropositionPolicyPushBundle(options.bundle);
  if (options.bundle.manifest.bundle_hash !== PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH) fail("PLAN_BUNDLE_DRIFT", "semantic bundle hash differs from the frozen P2a.2 bundle", { actual: options.bundle.manifest.bundle_hash });
  const historicalEvidence = await validateHistoricalPublicationEvidence(repoRoot);
  const artifactRows = ARTIFACT_NAMES.map((name) => deepFreeze({ name, bytes: Buffer.byteLength(options.bundle.bytes[name]), sha256: sha256Hex(options.bundle.bytes[name]) }));
  const exactFinalInventory = buildExactFinalInventory(options.bundle, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
  const propositionAnchors = await capturePropositionAnchors(repoRoot, options.bundle);
  const driftRegistry = buildDriftRegistry();
  const confinement = await captureConfinementAnchors(repoRoot);
  const base = {
    schema_version: PROPOSITION_POLICY_PUSH_PUBLICATION_PLAN_V2_SCHEMA,
    canonicalization: "RFC8785-JCS" as const,
    hash_algorithm: "sha256" as const,
    plan_hash_scope: PLAN_HASH_SCOPE,
    artifact_nature: "static_future_review_and_user_authorization_target_not_execution_result" as const,
    deployment: {
      abrain_home: PROPOSITION_POLICY_PUSH_HARD_ABRAIN,
      target_relative_name: PROPOSITION_POLICY_PUSH_TARGET_RELATIVE,
      target_root: PROPOSITION_POLICY_PUSH_HARD_TARGET,
      target_prestate: "absent_or_exact_same_plan_recoverable_partial",
      bootstrap_writable_bind: `${PROPOSITION_POLICY_PUSH_HARD_ABRAIN}/.state/sediment`,
      installer_writable_bind: PROPOSITION_POLICY_PUSH_HARD_TARGET,
      runtime_consumer: false,
      authority: "inert_shadow_only",
    },
    bundle: {
      manifest_schema_version: PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA,
      bundle_hash: options.bundle.manifest.bundle_hash,
      manifest_sha256: sha256Hex(options.bundle.bytes["manifest.json"]),
      artifact_rows: Object.freeze(artifactRows),
      exact_result: deepFreeze({ ...options.bundle.manifest.result }),
      bundle_relative_name: `bundles/${options.bundle.manifest.bundle_hash}`,
      latest_relative_symlink_value: `bundles/${options.bundle.manifest.bundle_hash}`,
    },
    exact_final_inventory: exactFinalInventory,
    proposition_anchors: propositionAnchors,
    drift_registry: driftRegistry,
    forensic_contract: {
      git_scope: ".git typed read-only probes with GIT_OPTIONAL_LOCKS=0; metadata drift recorded",
      corresponding_worktree_change: "protected_drift_fail_closed",
      protected_scope: "every non-target abrain path except the exact three registered streams and .git metadata",
      protected_equality: "canonical per-path type/content/symlink/mode/uid/gid/dev/inode/non-target-children equality with timestamps omitted",
      allowed_directory_listing_effect: "only exact target entry and its ancestor components",
      unknown_drift: "fail_closed",
    },
    confinement,
    execution_contract: {
      review_gate: "six fixed-order canonical v2 review bytes unanimously SIGN this exact plan raw/content hash",
      user_gate: "fresh exact trusted role=user transcript authorization binds plan, reviews, bundle, target, drift registry, helpers, runtime, and source hashes",
      manifests: ["proposition-policy-push-bootstrap-manifest/v1", "proposition-policy-push-installer-manifest/v1"],
      package_commands: PACKAGE_COMMANDS,
      production_entrypoint: PROPOSITION_POLICY_PUSH_PRODUCTION_CLI,
      production_package_argv: ["node", PROPOSITION_POLICY_PUSH_PRODUCTION_CLI],
      confined_exec_chain: ["/proc/self/fd/3 (opened verified bwrap)", "/run/pi-astack/node (opened verified Node bind)", "/run/pi-astack/helper.mjs (opened verified helper bind)"],
      forensic_command: ["/usr/bin/git", "--no-optional-locks", "-C", PROPOSITION_POLICY_PUSH_HARD_ABRAIN, "<fixed read-only probe args>"],
      bwrap: "fail_closed_no_unconfined_fallback",
      namespaces: ["user", "mount", "pid", "network", "ipc", "uts", "cgroup"],
      environment: "clearenv_then_only_explicit_PATH_LANG_LC_ALL_plus_bwrap_generated_PWD",
      capabilities: "drop_ALL",
      file_descriptors: "bwrap executes through its inherited verified FD; bwrap consumes exact writable/manifest/bwrap/runtime/helper/bundle FDs into mounts or data and closes them before helper exec",
      bootstrap_kernel_surface: "parent_wide_verified_.state/sediment_bind",
      bootstrap_behavior_surface: "reviewed_helper_and_postcheck_hardcoded_to_proposition-policy-push-shadow/v1",
      installer_kernel_surface: "verified_target_bind_fd_only",
      transaction: "lock_free_no_replace_recoverable_exact_same_plan_inside_target",
      independent_verdicts: ["confinement", "target", "protected", "drift", "runtime"],
      completion: "logical_AND_of_all_five_verdicts",
      post_creation_failure: "completion_false_target_inert",
      same_plan_rerun: "allowed_only_while_all_static_plan_anchors_remain_exact",
      anchor_advance: "existing_target_cannot_be_retrospectively_blessed_fresh_plan_review_or_separate_cleanup_required",
    },
    historical_v1: {
      relative_path: PROPOSITION_POLICY_PUSH_V1_PLAN_RELATIVE,
      raw_sha256: PROPOSITION_POLICY_PUSH_V1_PLAN_RAW_SHA256,
      preservation: "raw_bytes_immutable_historical_not_future_review_target",
      dossier_rows: historicalEvidence,
    },
    prohibited_bindings: {
      live_whole_abrain_snapshot: false,
      git_head: false,
      volatile_timestamps: false,
    },
  };
  const plan = deepFreeze({ ...base, plan_hash: jcsSha256Hex(base) }) as PublicationPlanV2;
  validatePublicationPlanV2(plan, { bundle: options.bundle });
  return plan;
}

export async function writePublicationPlanV2(options: {
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  outputPath: string;
}): Promise<{ plan: PublicationPlanV2; status: DurableCreateStatus | "replaced"; raw_sha256: string }> {
  const repoRoot = path.resolve(options.repoRoot);
  const expected = path.join(repoRoot, ...PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE.split("/"));
  if (path.resolve(options.outputPath) !== expected) fail("PLAN_OUTPUT_PATH", "v2 plan output path differs", { expected, actual: path.resolve(options.outputPath) });
  const plan = await buildPublicationPlanV2({ repoRoot, bundle: options.bundle });
  const raw = canonicalJson(plan);
  let status: DurableCreateStatus | "replaced" = await durableAtomicCreateFile(expected, raw, { mode: 0o644 });
  if (status === "collision") {
    const gatedPaths = [...publicationReviewV2RelativePaths(), publicationIntentV3Relative()];
    for (const relative of gatedPaths) {
      try {
        await fs.lstat(path.join(repoRoot, ...relative.split("/")));
        fail("PLAN_OUTPUT_REVIEWED", "cannot replace a plan after review or intent evidence exists", { relative });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
    await durableAtomicWriteFile(expected, raw, { mode: 0o644 });
    status = "replaced";
  }
  if (await fs.readFile(expected, "utf8") !== raw) fail("PLAN_OUTPUT_READBACK", "v2 plan readback differs");
  return deepFreeze({ plan, status, raw_sha256: sha256Hex(raw) });
}

export function validatePublicationPlanV2(plan: PublicationPlanV2, context?: { bundle?: PropositionPolicyPushBundle }): void {
  exactKeys(asRecord(plan), ["schema_version", "canonicalization", "hash_algorithm", "plan_hash_scope", "artifact_nature", "deployment", "bundle", "exact_final_inventory", "proposition_anchors", "drift_registry", "forensic_contract", "confinement", "execution_contract", "historical_v1", "prohibited_bindings", "plan_hash"], "plan");
  if (plan.schema_version !== PROPOSITION_POLICY_PUSH_PUBLICATION_PLAN_V2_SCHEMA || plan.canonicalization !== "RFC8785-JCS" || plan.hash_algorithm !== "sha256" || plan.plan_hash_scope !== PLAN_HASH_SCOPE || plan.artifact_nature !== "static_future_review_and_user_authorization_target_not_execution_result") fail("PLAN_INVALID", "plan identity differs");
  const deployment = asRecord(plan.deployment);
  if (deployment.abrain_home !== PROPOSITION_POLICY_PUSH_HARD_ABRAIN || deployment.target_root !== PROPOSITION_POLICY_PUSH_HARD_TARGET || deployment.target_relative_name !== PROPOSITION_POLICY_PUSH_TARGET_RELATIVE || deployment.runtime_consumer !== false || deployment.authority !== "inert_shadow_only") fail("PLAN_INVALID", "deployment differs");
  const bundle = asRecord(plan.bundle);
  if (bundle.bundle_hash !== PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH || bundle.manifest_schema_version !== PROPOSITION_POLICY_PUSH_SHADOW_MANIFEST_SCHEMA) fail("PLAN_INVALID", "bundle identity differs");
  assertHash(bundle.manifest_sha256, "plan.bundle.manifest_sha256");
  if (context?.bundle) {
    validatePropositionPolicyPushBundle(context.bundle);
    if (bundle.bundle_hash !== context.bundle.manifest.bundle_hash || bundle.manifest_sha256 !== sha256Hex(context.bundle.bytes["manifest.json"])) fail("PLAN_STALE", "plan bundle bytes differ from current semantic bundle");
    const expectedRows = ARTIFACT_NAMES.map((name) => ({ name, bytes: Buffer.byteLength(context.bundle!.bytes[name]), sha256: sha256Hex(context.bundle!.bytes[name]) }));
    if (canonicalizeJcs(bundle.artifact_rows) !== canonicalizeJcs(expectedRows)) fail("PLAN_STALE", "plan artifact rows differ from current semantic bundle");
  }
  if (!Array.isArray(plan.exact_final_inventory) || !plan.exact_final_inventory.length) fail("PLAN_INVALID", "final inventory is empty");
  validateStaticInventory(plan.exact_final_inventory);
  validateDriftRegistry(plan.drift_registry);
  const historical = asRecord(plan.historical_v1);
  if (historical.relative_path !== PROPOSITION_POLICY_PUSH_V1_PLAN_RELATIVE
    || historical.raw_sha256 !== PROPOSITION_POLICY_PUSH_V1_PLAN_RAW_SHA256
    || canonicalizeJcs(historical.dossier_rows) !== canonicalizeJcs(PROPOSITION_POLICY_PUSH_HISTORICAL_EVIDENCE)) fail("PLAN_INVALID", "historical evidence binding differs");
  const execution = asRecord(plan.execution_contract);
  if (canonicalizeJcs(execution.package_commands) !== canonicalizeJcs(PACKAGE_COMMANDS)
    || execution.production_entrypoint !== PROPOSITION_POLICY_PUSH_PRODUCTION_CLI
    || canonicalizeJcs(execution.production_package_argv) !== canonicalizeJcs(["node", PROPOSITION_POLICY_PUSH_PRODUCTION_CLI])) fail("PLAN_INVALID", "production executable/package command binding differs");
  const anchors = asRecord(plan.proposition_anchors);
  const runtime = asRecord(anchors.runtime);
  if (runtime.publication_modules_runtime_reachable !== false
    || !Array.isArray(runtime.forbidden_publication_reachable_paths)
    || runtime.forbidden_publication_reachable_paths.length !== 0
    || canonicalizeJcs(runtime.forbidden_publication_paths) !== canonicalizeJcs(FORBIDDEN_RUNTIME_PUBLICATION_PATHS)) fail("PLAN_RUNTIME_REACHABILITY", "runtime publication reachability evidence differs");
  const prohibited = asRecord(plan.prohibited_bindings);
  if (prohibited.live_whole_abrain_snapshot !== false || prohibited.git_head !== false || prohibited.volatile_timestamps !== false) fail("PLAN_INVALID", "prohibited binding appeared");
  const forbiddenText = canonicalizeJcs(plan).toLowerCase();
  if (forbiddenText.includes("whole_abrain_snapshot_hash") || forbiddenText.includes('"head"')) fail("PLAN_INVALID", "plan text binds a forbidden live snapshot or HEAD");
  assertHash(plan.plan_hash, "plan.plan_hash");
  const base = { ...plan } as Record<string, unknown>;
  delete base.plan_hash;
  if (jcsSha256Hex(base) !== plan.plan_hash) fail("PLAN_INVALID", "plan self-hash differs");
}

export async function validateCurrentStaticPlanAnchors(options: {
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  plan: PublicationPlanV2;
}): Promise<void> {
  validatePublicationPlanV2(options.plan, { bundle: options.bundle });
  const rebuilt = await buildPublicationPlanV2({ repoRoot: options.repoRoot, bundle: options.bundle });
  if (canonicalizeJcs(rebuilt) !== canonicalizeJcs(options.plan)) fail("STATIC_ANCHOR_DRIFT", "current static plan anchors differ from the reviewed v2 plan", { expected: options.plan.plan_hash, actual: rebuilt.plan_hash });
}

function buildExactFinalInventory(bundle: PropositionPolicyPushBundle, uid: number, gid: number): readonly StaticInventoryRow[] {
  const target = PROPOSITION_POLICY_PUSH_TARGET_RELATIVE;
  const bundleRoot = `${target}/bundles`;
  const bundleDir = `${bundleRoot}/${bundle.manifest.bundle_hash}`;
  const latestValue = `bundles/${bundle.manifest.bundle_hash}`;
  const rows: StaticInventoryRow[] = [
    directoryRow(".state/sediment/proposition-policy-push-shadow", ["v1"], uid, gid),
    directoryRow(target, ["bundles", "latest"], uid, gid),
    directoryRow(bundleRoot, [bundle.manifest.bundle_hash], uid, gid),
    directoryRow(bundleDir, [...ARTIFACT_NAMES], uid, gid),
    ...ARTIFACT_NAMES.map((name) => ({ relative_name: `${bundleDir}/${name}`, kind: "file" as const, bytes: Buffer.byteLength(bundle.bytes[name]), sha256: sha256Hex(bundle.bytes[name]), symlink_value: null, mode: 0o600, uid, gid, children: null })),
    { relative_name: `${target}/latest`, kind: "symlink", bytes: 0, sha256: sha256Hex(latestValue), symlink_value: latestValue, mode: 0o777, uid, gid, children: null },
  ];
  rows.sort((left, right) => compare(left.relative_name, right.relative_name));
  return Object.freeze(rows.map((row) => deepFreeze(row)));
}

function directoryRow(relativeName: string, children: readonly string[], uid: number, gid: number): StaticInventoryRow {
  return { relative_name: relativeName, kind: "directory", bytes: 0, sha256: jcsSha256Hex({ kind: "directory", children }), symlink_value: null, mode: 0o700, uid, gid, children: Object.freeze([...children].sort(compare)) };
}

async function capturePropositionAnchors(repoRoot: string, bundle: PropositionPolicyPushBundle): Promise<Readonly<Record<string, unknown>>> {
  const inputIds = [...bundle.manifest.source.input_event_ids];
  const eventRows = [] as Array<Record<string, unknown>>;
  for (const eventId of inputIds) {
    const relative = `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
    const file = path.join(PROPOSITION_POLICY_PUSH_HARD_ABRAIN, ...relative.split("/"));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) fail("PLAN_EVENT_ANCHOR", "proposition event anchor is unsafe", { eventId });
    const bytes = await fs.readFile(file);
    eventRows.push({ event_id: eventId, relative_path: relative, bytes: bytes.length, sha256: sha256Hex(bytes) });
  }
  const registryFile = path.join(repoRoot, "schemas/l1-schema-role-registry.json");
  const registryRaw = await fs.readFile(registryFile);
  const registry = loadL1SchemaRegistry(registryFile);
  const propositionFile = await readSourceRow(repoRoot, "extensions/_shared/proposition.ts");
  const projectorFile = await readSourceRow(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts");
  const lifecycleFile = await readSourceRow(repoRoot, "extensions/_shared/proposition-lifecycle-resolver.ts");
  const packageRaw = await fs.readFile(path.join(repoRoot, "package.json"));
  const pkg = JSON.parse(packageRaw.toString("utf8")) as { pi?: { extensions?: unknown }; scripts?: Record<string, unknown> };
  const extensionRoots = pkg.pi?.extensions;
  if (!Array.isArray(extensionRoots) || extensionRoots.some((value) => typeof value !== "string")) fail("PLAN_RUNTIME_ANCHOR", "package pi.extensions is invalid");
  for (const [name, command] of Object.entries(PACKAGE_COMMANDS)) if (pkg.scripts?.[name] !== command) fail("PLAN_PACKAGE_COMMAND_DRIFT", "publication package command differs", { name, expected: command, actual: pkg.scripts?.[name] });
  const runtimeGraph = buildTypescriptStaticDependencyGraph({ repoRoot, roots: extensionRoots as string[] });
  validateTypescriptStaticDependencyGraph(runtimeGraph);
  const publicationGraph = buildProductionPublicationDependencyGraph(repoRoot);
  const runtimePaths = new Set(runtimeGraph.files.map((row) => row.path));
  const forbiddenReachable = FORBIDDEN_RUNTIME_PUBLICATION_PATHS.filter((relative) => runtimePaths.has(relative));
  if (forbiddenReachable.length > 0) fail("PLAN_RUNTIME_REACHABILITY", "publication code is reachable from package runtime roots", { forbiddenReachable });
  const settingsRaw = await fs.readFile(PROPOSITION_POLICY_PUSH_RUNTIME_SETTINGS);
  return deepFreeze({
    events: Object.freeze(eventRows),
    frontier: { input_event_ids: Object.freeze(inputIds), input_event_ids_hash: bundle.manifest.source.input_event_ids_hash, event_rows_hash: jcsSha256Hex(eventRows) },
    schema: { proposition_contract_source: propositionFile, schema_contract_hash: "18bbb496bfc0ec977b916f8869dbbb6f9e3dcd72e8edd1a829a9f40832eee32a" },
    registry: { relative_path: "schemas/l1-schema-role-registry.json", registry_id: registry.registry_id, raw_sha256: sha256Hex(registryRaw), canonical_sha256: jcsSha256Hex(JSON.parse(registryRaw.toString("utf8"))) },
    projector: {
      source: projectorFile,
      lifecycle_resolver_source: lifecycleFile,
      source_input_event_ids_hash: bundle.manifest.source.input_event_ids_hash,
      source_resolution_inventory_hash: bundle.manifest.source.source_resolution_inventory_hash,
      source_dependency_graph_hash: buildTypescriptStaticDependencyGraph({ repoRoot, roots: ["extensions/_shared/proposition-policy-push-shadow.ts"] }).graph_hash,
      bundle_hash: bundle.manifest.bundle_hash,
    },
    runtime: {
      package_json_sha256: sha256Hex(packageRaw),
      package_commands: PACKAGE_COMMANDS,
      extension_roots_count: extensionRoots.length,
      extension_roots_hash: jcsSha256Hex(extensionRoots),
      extension_dependency_graph: runtimeGraph,
      extension_dependency_graph_hash: runtimeGraph.graph_hash,
      production_publication_dependency_graph: publicationGraph,
      production_publication_dependency_graph_hash: publicationGraph.graph_hash,
      forbidden_publication_paths: FORBIDDEN_RUNTIME_PUBLICATION_PATHS,
      forbidden_publication_reachable_paths: Object.freeze(forbiddenReachable),
      settings_path: PROPOSITION_POLICY_PUSH_RUNTIME_SETTINGS,
      settings_raw_sha256: sha256Hex(settingsRaw),
      publication_modules_runtime_reachable: forbiddenReachable.length > 0,
    },
  });
}

function buildDriftRegistry(): Readonly<Record<string, unknown>> {
  const rows = [
    {
      relative_path: PROPOSITION_POLICY_PUSH_DRIFT_PATHS[0],
      row_schema: "memory-path-a-ledger-row/v1-structural",
      required: { ts: "nonempty_string", inject_id: "nonempty_string", outcome: "nonempty_string", prompt_chars: "nonnegative_integer", total_duration_ms: "nonnegative_number" },
      native_ids: ["inject_id", "session_id", "turn_id"],
    },
    {
      relative_path: PROPOSITION_POLICY_PUSH_DRIFT_PATHS[1],
      row_schema: "git-sync-event/v1-structural",
      required: { ts: "nonempty_string", op: "push|fetch|sync|writer_publication", result: "nonempty_string" },
      native_ids: [],
    },
    {
      relative_path: PROPOSITION_POLICY_PUSH_DRIFT_PATHS[2],
      row_schema: "rule-injector-dualread-audit/v1",
      required: { schemaVersion: "rule-injector-dualread-audit/v1", observedAtUtc: "nonempty_string", status: "nonempty_string", latencyMs: "nonnegative_number" },
      native_ids: [],
    },
  ];
  const base = {
    schema_version: PROPOSITION_POLICY_PUSH_DRIFT_REGISTRY_SCHEMA,
    scope: "exact_paths_no_patterns",
    resolution: "execution_time_realpath_regular_non_symlink_open_no_follow_same_dev_inode_pinned",
    prefix: "explicit_cutoff_size_complete_newline_exact_bytes_and_sha256",
    suffix: "complete_newline_path_specific_schema_valid_jsonl_with_byte_offsets_raw_row_hashes_and_native_ids_where_present",
    replacement_or_truncation: "fail_closed",
    torn_append: "fail_closed_retry",
    disjointness: "exact paths must be disjoint from target and protected scope",
    rows: Object.freeze(rows.map((row) => deepFreeze(row))),
  };
  return deepFreeze({ ...base, registry_hash: jcsSha256Hex(base) });
}

function validateDriftRegistry(input: Readonly<Record<string, unknown>>): void {
  const registry = asRecord(input);
  exactKeys(registry, ["schema_version", "scope", "resolution", "prefix", "suffix", "replacement_or_truncation", "torn_append", "disjointness", "rows", "registry_hash"], "drift_registry");
  if (registry.schema_version !== PROPOSITION_POLICY_PUSH_DRIFT_REGISTRY_SCHEMA || registry.scope !== "exact_paths_no_patterns") fail("PLAN_INVALID", "drift registry identity differs");
  const rows = array(registry.rows, "drift_registry.rows").map(asRecord);
  if (canonicalizeJcs(rows.map((row) => row.relative_path)) !== canonicalizeJcs(PROPOSITION_POLICY_PUSH_DRIFT_PATHS)) fail("PLAN_INVALID", "drift paths differ");
  for (const row of rows) {
    if (typeof row.relative_path !== "string" || row.relative_path === PROPOSITION_POLICY_PUSH_TARGET_RELATIVE || row.relative_path.startsWith(`${PROPOSITION_POLICY_PUSH_TARGET_RELATIVE}/`)) fail("PLAN_INVALID", "drift path overlaps target");
  }
  assertHash(registry.registry_hash, "drift_registry.registry_hash");
  const base = { ...registry };
  delete base.registry_hash;
  if (jcsSha256Hex(base) !== registry.registry_hash) fail("PLAN_INVALID", "drift registry self-hash differs");
}

function buildProductionPublicationDependencyGraph(repoRoot: string) {
  const graph = buildTypescriptStaticDependencyGraph({
    repoRoot,
    roots: [PROPOSITION_POLICY_PUSH_PRODUCTION_CLI],
    explicitFiles: [
      "package.json",
      "scripts/proposition-policy-push-bootstrap-helper.mjs",
      "scripts/proposition-policy-push-confinement-probe.mjs",
      "scripts/proposition-policy-push-installer-helper.mjs",
    ],
  });
  validateTypescriptStaticDependencyGraph(graph, { requiredPaths: [PROPOSITION_POLICY_PUSH_PRODUCTION_CLI, "extensions/_shared/proposition-policy-push-live-publication-plan.ts", "extensions/_shared/proposition-policy-push-live-publication.ts"] });
  return graph;
}

async function captureConfinementAnchors(repoRoot: string): Promise<Readonly<Record<string, unknown>>> {
  const bwrapPath = await fs.realpath("/usr/bin/bwrap");
  const bwrapRaw = await fs.readFile(bwrapPath);
  const nodePath = await fs.realpath(process.execPath);
  const nodeRaw = await fs.readFile(nodePath);
  const gitPath = await fs.realpath("/usr/bin/git");
  const gitRaw = await fs.readFile(gitPath);
  const version = execFileSync(bwrapPath, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }).trim();
  const gitVersion = execFileSync(gitPath, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }).trim();
  if (version !== "bubblewrap 0.11.0") fail("PLAN_BWRAP_VERSION", "installed bubblewrap version differs", { version });
  const publicationGraph = buildProductionPublicationDependencyGraph(repoRoot);
  const sourcePaths = [...new Set([...SOURCE_PATHS, ...publicationGraph.files.map((row) => row.path)])].sort(compare);
  const sourceRows = [] as Array<Readonly<Record<string, unknown>>>;
  for (const relative of sourcePaths) sourceRows.push(await readSourceRow(repoRoot, relative));
  const sourceBase = { scope: "closed production CLI dependency graph plus every reviewed package command, plan/orchestrator/helper/probe/generator/preview/smoke and semantic dependency byte", rows: Object.freeze(sourceRows) };
  const sourceInventory = deepFreeze({ ...sourceBase, inventory_hash: jcsSha256Hex(sourceBase) });
  return deepFreeze({
    bubblewrap: { path: bwrapPath, version, bytes: bwrapRaw.length, sha256: sha256Hex(bwrapRaw), bind_method: "bind-fd_and_ro-bind-fd_supported_by_installed_0.11.0" },
    runtime_executable: { path: nodePath, bytes: nodeRaw.length, sha256: sha256Hex(nodeRaw), handoff: "verified_ro_bind_fd_to_fixed_sandbox_path" },
    forensic_executable: { path: gitPath, version: gitVersion, bytes: gitRaw.length, sha256: sha256Hex(gitRaw), command_policy: "fixed read-only git probes with GIT_OPTIONAL_LOCKS=0 and no caller arguments" },
    bootstrap: sourceRows.find((row) => row.path === "scripts/proposition-policy-push-bootstrap-helper.mjs"),
    installer: sourceRows.find((row) => row.path === "scripts/proposition-policy-push-installer-helper.mjs"),
    effectiveness_probe: sourceRows.find((row) => row.path === "scripts/proposition-policy-push-confinement-probe.mjs"),
    source_inventory: sourceInventory,
  });
}

async function readSourceRow(repoRoot: string, relative: string): Promise<Readonly<Record<string, unknown>>> {
  const file = path.join(repoRoot, ...relative.split("/"));
  const bytes = await readRegularExactBytes(file, "PLAN_SOURCE", { relative });
  return deepFreeze({ path: relative, bytes: bytes.length, sha256: sha256Hex(bytes) });
}

function validateStaticInventory(rows: readonly StaticInventoryRow[]): void {
  const names = rows.map((row) => row.relative_name);
  if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && compare(names[index - 1]!, name) >= 0)) fail("PLAN_INVALID", "final inventory is not sorted unique");
  for (const row of rows) {
    exactKeys(asRecord(row), ["relative_name", "kind", "bytes", "sha256", "symlink_value", "mode", "uid", "gid", "children"], "final inventory row");
    if (!row.relative_name.startsWith(".state/sediment/proposition-policy-push-shadow") || !["directory", "file", "symlink"].includes(row.kind)) fail("PLAN_INVALID", "final inventory row escapes target ownership");
    assertHash(row.sha256, "final inventory row sha256");
  }
}

export async function validateHistoricalPublicationEvidence(repoRootInput: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const repoRoot = path.resolve(repoRootInput);
  const v1 = await readRegularExactBytes(path.join(repoRoot, ...PROPOSITION_POLICY_PUSH_V1_PLAN_RELATIVE.split("/")), "PLAN_HISTORY", { generation: "p2a21-plan-v1" });
  if (sha256Hex(v1) !== PROPOSITION_POLICY_PUSH_V1_PLAN_RAW_SHA256) fail("PLAN_HISTORY_DRIFT", "historical v1 plan bytes differ");
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  for (const expected of PROPOSITION_POLICY_PUSH_HISTORICAL_EVIDENCE) {
    const raw = await readRegularExactBytes(path.join(repoRoot, ...expected.relative_path.split("/")), "PLAN_HISTORY", { generation: expected.generation });
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
    catch (error) { fail("PLAN_HISTORY_DRIFT", "historical dossier JSON is malformed", { generation: expected.generation, error: error instanceof Error ? error.message : String(error) }); }
    const base = { ...parsed };
    delete base.dossier_hash;
    if (sha256Hex(raw) !== expected.raw_sha256
      || parsed.schema_version !== expected.schema_version
      || parsed.dossier_hash !== expected.content_hash
      || jcsSha256Hex(base) !== expected.content_hash) fail("PLAN_HISTORY_DRIFT", "historical dossier bytes or identity differ", { generation: expected.generation });
    rows.push(deepFreeze({ ...expected }));
  }
  return Object.freeze(rows);
}

async function readRegularExactBytes(file: string, code: string, detail: Record<string, unknown>): Promise<Buffer> {
  const resolved = path.resolve(file);
  const named = await fs.lstat(resolved);
  if (named.isSymbolicLink() || !named.isFile() || await fs.realpath(resolved) !== resolved) fail(`${code}_UNSAFE`, "regular-file anchor is unsafe", detail);
  const handle = await fs.open(resolved, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) fail(`${code}_RACE`, "regular-file anchor changed while opened", detail);
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(bytes, 0, opened.size, 0);
    const openedAfter = await handle.stat();
    const namedAfter = await fs.lstat(resolved);
    if (bytesRead !== opened.size
      || openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino || openedAfter.size !== opened.size
      || namedAfter.isSymbolicLink() || !namedAfter.isFile()
      || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino
      || await fs.realpath(resolved) !== resolved) fail(`${code}_RACE`, "regular-file anchor changed while read", detail);
    return bytes;
  } finally { await handle.close(); }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compare);
  const wanted = [...expected].sort(compare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("PLAN_INVALID", `${at} keys differ`, { actual, wanted });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PLAN_INVALID", "expected object");
  return value as Record<string, unknown>;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("PLAN_INVALID", `${at} must be an array`);
  return value;
}

function assertHash(value: unknown, at: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("PLAN_INVALID", `${at} must be SHA-256`);
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionPolicyPushPlanV2Error(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
