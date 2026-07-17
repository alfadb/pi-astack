import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  buildTypescriptStaticDependencyGraph,
  extractJitiRepoModules,
  validateTypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";
import {
  REAL_POLICY_APPEND_STAGE3_OUTPUTS,
  REAL_POLICY_APPEND_POST_RELATIVE,
  __STAGE2_TEST,
  captureRealPolicyAppendExecutionClosure,
  closeRealPolicyAppendExecutionClosureHandles,
  executeRealPolicyAppendProduction,
} from "./proposition-real-policy-append-production-execute";
import {
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_CONTRACT_SCHEMA,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED_SPEC_FIELDS,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA,
  verifyFreshRealPolicyAppendStage2Authorization,
} from "./proposition-real-policy-append-transcript";
import {
  REAL_POLICY_APPEND_ABSOLUTE_TARGET,
  REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256,
  REAL_POLICY_APPEND_EVENT_ID,
  REAL_POLICY_APPEND_RELATIVE_TARGET,
  REAL_POLICY_APPEND_SECOND_SHARD,
  fixedRealPolicyAppendTuple,
} from "./proposition-real-policy-append-writer";

export const REAL_POLICY_APPEND_PREVIEW_SCHEMA = "adr0040-real-policy-proposition-append-execution-ready-preview-dossier/v1" as const;
export const REAL_POLICY_APPEND_PREVIEW_RELATIVE = "docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-execution-ready-preview-dossier.json" as const;
export const REAL_POLICY_APPEND_PROTOCOL_HASH = "b53bc2692fc65f478301597756217a097bb2b2627a74c4c3ef5cd82ef1684a76" as const;
export const REAL_POLICY_APPEND_HARD_ABRAIN = "/home/worker/.abrain" as const;
export const REAL_POLICY_APPEND_HARD_REPO = "/home/worker/.pi/agent/skills/pi-astack" as const;
export const REAL_POLICY_APPEND_STAGE2_PATHS = Object.freeze([
  "extensions/_shared/proposition-real-policy-append-writer.ts",
  "extensions/_shared/proposition-real-policy-append-transcript.ts",
  "extensions/_shared/proposition-real-policy-append-production-preview.ts",
  "extensions/_shared/proposition-real-policy-append-production-execute.ts",
  "scripts/dossier-proposition-real-policy-append-production-preview.mjs",
  "scripts/execute-proposition-real-policy-append-evidence.mjs",
  "scripts/smoke-proposition-real-policy-append.mjs",
  REAL_POLICY_APPEND_PREVIEW_RELATIVE,
] as const);

const DOSSIER_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted and no LF" as const;
const DESIGN_PLAN = "docs/evidence/adr0040-real-policy-proposition-append-design/append-authorization-plan.json";
const DESIGN_DOSSIER = "docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-read-only-preview-dossier.json";
const DESIGN_ROWS = Object.freeze([
  { path: DESIGN_PLAN, raw: "06a2915ecf88022e861295f9e844ae96b2ea3543b544e44ebe7426ac54d609a5", self: "1505659abc5a6ea56aa5c45bb5140b6ed8433a24e9d7410d34c0411042019478", field: "plan_hash" },
  { path: DESIGN_DOSSIER, raw: "08cd956a1ba382c239ecd447159e510e8597a0d7cb6a0fd9dd4a2d4de7b347d9", self: "c6a1d9ae759b282b110ae55a9c6bc0fc65bf63c4d172ca62c20d1a3cc4b34ec1", field: "dossier_hash" },
  { path: "docs/evidence/adr0040-real-policy-proposition-append-design/reviews/01-anthropic.json", raw: "f6f258c404b57703bc9e04e7aa34a61e5c22f37501a31b0ee97fba488b211f68", self: "861a1c5754c3445600feaf5aae2cceb4e63026c79e6b30ac6dec2979bd07b436", field: "review_hash" },
  { path: "docs/evidence/adr0040-real-policy-proposition-append-design/reviews/02-deepseek.json", raw: "b0cd7f17efb87bd3c3584999fce0e3ab464dd6e4ebce79e7db26f7e6c1b9e252", self: "fefb55b8db4be2bcb3a43916f20c6a452426d11a3ea2172d5498763fc2cfff3a", field: "review_hash" },
  { path: "docs/evidence/adr0040-real-policy-proposition-append-design/reviews/03-minimax.json", raw: "d0b3e21a4af4cdb77b575d1272b08f5a72257fe31b27ef89a51b84bf24d352e1", self: "cde660f5517e650067b723a012ab642fcfb28a12a0c0ef7c24e722754be36088", field: "review_hash" },
  { path: "docs/evidence/adr0040-real-policy-proposition-append-design/reviews/04-moonshot.json", raw: "871dc9ad2efa44a68c5f94ad6dc9e64f6790ae957b6162d5b476d9f411b7cbb2", self: "5fc2566a879c26237a690bed16de7eb7a5585b89cf0efb76b3a7fafb6a67a6cf", field: "review_hash" },
  { path: "docs/evidence/adr0040-real-policy-proposition-append-design/reviews/05-openai.json", raw: "f7d8e0023477cd3ed218d34980725b5ff275132b47990f7e30982ef06f6a42dd", self: "8294bdb432e881de244470c5b14cafa8662bf08064ecefc192ea7e269186b91e", field: "review_hash" },
  { path: "docs/evidence/adr0040-real-policy-proposition-append-design/reviews/06-zai.json", raw: "e085a35d254db258b5fcd7ace9b1c981d1eff06c367956f23ab2fef5ba53699d", self: "021486e9f6b4662091192fe38f3d79a82da92d683c8349542c0a3259718cb68b", field: "review_hash" },
]);
const SOURCE_FILES = Object.freeze(REAL_POLICY_APPEND_STAGE2_PATHS.slice(0, 7));
const O_PATH = 0x200000;
const ZFS_MAGIC = 0x2fc12fc1;

interface InventoryCapture {
  summary: Readonly<Record<string, unknown>>;
  rows: readonly Readonly<Record<string, unknown>>[];
  proposition: readonly Readonly<Record<string, unknown>>[];
}

interface PreviewHardAnchorCapture {
  anchors: Readonly<Record<string, unknown>>;
  hard_anchor_hash: string;
  target: Readonly<Record<string, unknown>>;
  productionFacts: Readonly<Record<string, unknown>>;
  downstream: Readonly<Record<string, unknown>>;
  platformClosure: Readonly<Record<string, unknown>>;
  sourceClosure: Readonly<Record<string, unknown>>;
}

export class RealPolicyAppendPreviewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "RealPolicyAppendPreviewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildRealPolicyAppendProductionPreview(options: {
  repoRoot: string;
  abrainHome: string;
  sandboxRoot: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const repoRoot = exactDirectory(options.repoRoot, "repository root");
  const abrainHome = exactDirectory(options.abrainHome, "production abrain");
  const sandboxRoot = exactDirectory(options.sandboxRoot, "disposable Stage2 sandbox");
  if (repoRoot !== REAL_POLICY_APPEND_HARD_REPO || abrainHome !== REAL_POLICY_APPEND_HARD_ABRAIN) fail("REAL_POLICY_APPEND_PRODUCTION_ROOT", "preview requires the exact production repository and .abrain roots", { repoRoot, abrainHome });
  if (isInside(repoRoot, sandboxRoot) || isInside(abrainHome, sandboxRoot) || !isInside("/home/worker", sandboxRoot)) fail("REAL_POLICY_APPEND_SANDBOX_ROOT", "disposable sandbox must be outside repo and .abrain on /home/worker", { sandboxRoot });
  assertStage2AndStage3Leaves(repoRoot, { stage2SourcesPresent: true, dossierMayExist: true });
  const runnerPreflight = captureStage2RunnerPreflight(repoRoot);

  const authorization = verifyFreshRealPolicyAppendStage2Authorization();
  const design = captureDesignBindings(repoRoot);
  const tuple = fixedRealPolicyAppendTuple();
  const zfs = captureZfsProof({ repoRoot, abrainHome, sandboxRoot });
  const repoBefore = captureNoFollowInventory(repoRoot, new Set(REAL_POLICY_APPEND_STAGE2_PATHS));
  const abrainBefore = captureAmbientInventoryEvidence(abrainHome);
  const C0a = capturePreviewHardAnchors({ repoRoot, abrainHome });
  const target = C0a.target;
  const productionFacts = C0a.productionFacts;
  const downstream = C0a.downstream;
  const platform = C0a.platformClosure;
  const sourceClosure = C0a.sourceClosure;
  const platformForProof = captureRealPolicyAppendExecutionClosure(repoRoot);
  let lockProof: Readonly<Record<string, unknown>>;
  let bwrapProof: Readonly<Record<string, unknown>>;
  try {
    lockProof = await proveSameOfdFlock({ sandboxRoot, node: platformForProof.handles.node, flock: platformForProof.handles.flock });
    bwrapProof = proveEffectiveBwrap({ node: platformForProof.handles.node, bwrap: platformForProof.handles.bwrap });
  } finally { closeRealPolicyAppendExecutionClosureHandles(platformForProof.handles); }
  const durability = proveDurabilityAndCrashRecovery({ repoRoot, sandboxRoot });
  const C0b = capturePreviewHardAnchors({ repoRoot, abrainHome });
  if (C0a.hard_anchor_hash !== C0b.hard_anchor_hash) fail("REAL_POLICY_APPEND_C0_DRIFT", "C0a and C0b hard anchors differ", { C0a_hash: C0a.hard_anchor_hash, C0b_hash: C0b.hard_anchor_hash });

  let defaultDeny: Readonly<Record<string, unknown>>;
  try {
    executeRealPolicyAppendProduction({ repoRoot });
    fail("REAL_POLICY_APPEND_DEFAULT_DENY", "production execute unexpectedly returned");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error) || String((error as { code?: unknown }).code) !== "NOT_AUTHORIZED") throw error;
    defaultDeny = deepFreeze({ code: "NOT_AUTHORIZED", reason: (error as { detail?: { reason?: unknown } }).detail?.reason ?? null, production_checks_before_denial: false });
  }

  const repoAfter = captureNoFollowInventory(repoRoot, new Set(REAL_POLICY_APPEND_STAGE2_PATHS));
  const abrainAfter = captureAmbientInventoryEvidence(abrainHome);
  const repoEqual = canonicalizeJcs(repoBefore.rows) === canonicalizeJcs(repoAfter.rows);
  if (!repoEqual) fail("REAL_POLICY_APPEND_MUTATION", "production repository paths outside the exact Stage2 inventory changed during preview", { repoBefore: repoBefore.summary, repoAfter: repoAfter.summary });
  const C1 = capturePreviewHardAnchors({ repoRoot, abrainHome });
  if (C0a.hard_anchor_hash !== C1.hard_anchor_hash || C0b.hard_anchor_hash !== C1.hard_anchor_hash) fail("REAL_POLICY_APPEND_C1_DRIFT", "C1 hard anchors differ from C0", { C0a_hash: C0a.hard_anchor_hash, C0b_hash: C0b.hard_anchor_hash, C1_hash: C1.hard_anchor_hash });
  const wholeAbrainEvidence = summarizeWholeAbrainEvidence(abrainBefore, abrainAfter);
  const finalTarget = C1.target;
  assertStage2AndStage3Leaves(repoRoot, { stage2SourcesPresent: true, dossierMayExist: true });

  const runnerPreflightPaths = arrayField(runnerPreflight.paths, "runner preflight paths");
  const pathInventory = REAL_POLICY_APPEND_STAGE2_PATHS.map((relative, index) => ({
    relative_path: relative,
    stage2_role: index < 7 ? "source_or_executable" : "self_hashed_generated_preview_dossier",
    state_before_stage2: "attested_by_stage2_authorization_and_runner_preflight",
    state_before_stage2_evidence_scope: "historical original Stage2 creation requirement; current remediation rerun observes existing authorized leaves and does not falsely claim to reobserve absence",
    state_at_current_runner_preflight: asRecord(runnerPreflightPaths[index], `runner preflight path ${index}`).observed_state,
    runner_preflight_record_hash: runnerPreflight.record_hash,
    source_closure_binding: index < 7 ? "exact_bytes_in_source_closure" : "path_and_cycle_break_contract_in_source_closure_then_self_hash_binds_closure",
  }));
  const assertions = deepFreeze({
    recorded_exact_role_user_stage2_authorization_reverified: authorization.recorded_coordinate_and_prefix_verified && authorization.append_only_suffix_permitted,
    stage3_not_authorized: authorization.stage3_authorized === false,
    design_raw_self_and_protocol_valid: design.protocol_hash === REAL_POLICY_APPEND_PROTOCOL_HASH,
    fixed_private_tuple_exact: tuple.event_id === REAL_POLICY_APPEND_EVENT_ID && tuple.canonical_envelope_raw_sha256 === REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256 && tuple.caller_supplied_tuple_fields.length === 0,
    real_production_data_observed: asRecord(productionFacts.proposition_prestate, "production proposition prestate").exact === true,
    real_zfs_no_fallback: zfs.all_zfs === true,
    repo_paths_outside_exact_stage2_inventory_unchanged: repoEqual,
    hard_anchor_C0a_C0b_C1_equal: C0a.hard_anchor_hash === C0b.hard_anchor_hash && C0b.hard_anchor_hash === C1.hard_anchor_hash,
    target_second_shard_and_event_temp_absent: finalTarget.target_state === "absent" && finalTarget.second_shard_state === "absent" && finalTarget.event_temp_state === "absent_by_absent_second_shard",
    node_procfs_flock_loader_dso_jcs_bwrap_closure_valid: platform.complete === true,
    same_ofd_success_busy_sigkill_valid: lockProof.success && lockProof.busy && lockProof.holder_sigkill_release,
    effective_bwrap_denial_valid: bwrapProof.effective === true,
    repo_event_hardlink_fsync_dirfd_sigkill_valid: durability.complete === true,
    complete_source_closure_valid: sourceClosure.closure_hash === jcsSha256Hex(sourceClosure.preimage),
    p2a_p2b_runtime_bound: downstream.valid === true,
    production_execute_default_denied: defaultDeny.code === "NOT_AUTHORIZED",
    no_stage3_repo_output: REAL_POLICY_APPEND_STAGE3_OUTPUTS.every((relative) => !lstatMaybe(path.join(repoRoot, ...relative.split("/")))),
    no_stage3_authorization_text_generated: true,
  });
  if (Object.values(assertions).some((value) => value !== true)) fail("REAL_POLICY_APPEND_ASSERTION", "execution-ready preview assertion failed", { assertions });

  const dossierBase = deepFreeze({
    schema_version: REAL_POLICY_APPEND_PREVIEW_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    dossier_hash_scope: DOSSIER_HASH_SCOPE,
    mode: "real_production_real_zfs_execution_ready_read_only_preview",
    authorization,
    design_bindings: design,
    fixed_tuple: tuple,
    production_prestate: productionFacts,
    target_observation: { before: target, after: finalTarget, hard_anchor_equal: canonicalizeJcs(target) === canonicalizeJcs(finalTarget) },
    hard_anchor_observations: { C0a: C0a.anchors, C0b: C0b.anchors, C1: C1.anchors, C0a_hash: C0a.hard_anchor_hash, C0b_hash: C0b.hard_anchor_hash, C1_hash: C1.hard_anchor_hash },
    real_zfs: zfs,
    platform_closure: platform,
    flock_proof: lockProof,
    effective_bwrap_proof: bwrapProof,
    durability_and_crash_recovery: durability,
    downstream_bindings: downstream,
    source_closure: sourceClosure,
    production_mutation_proof: {
      repo_existing_paths_excluding_exact_stage2_leaves: { before: repoBefore.summary, after: repoAfter.summary, equal: repoEqual },
      whole_abrain_evidence_only: wholeAbrainEvidence,
    },
    stage2_runner_preflight: runnerPreflight,
    stage2_path_inventory: pathInventory,
    stage3_authorization_contract: stage3AuthorizationContract(),
    stage3_boundary: {
      authorized: false,
      production_append_executed: false,
      exact_repo_outputs: REAL_POLICY_APPEND_STAGE3_OUTPUTS,
      outputs_absent: true,
      authorization_text_generated: false,
      next_gate: "another fresh exact role=user Stage3 authorization binding this source closure and dossier is required",
    },
    default_deny: defaultDeny,
    assertions,
  });
  const dossier = deepFreeze({ ...dossierBase, dossier_hash: jcsSha256Hex(dossierBase) });
  validateRealPolicyAppendPreviewDossier(dossier);
  return dossier;
}

export function writeRealPolicyAppendProductionPreview(options: { repoRoot: string; abrainHome: string; sandboxRoot: string; outputPath: string }): Promise<Readonly<Record<string, unknown>>> {
  return buildRealPolicyAppendProductionPreview(options).then((dossier) => {
    const expected = path.join(path.resolve(options.repoRoot), ...REAL_POLICY_APPEND_PREVIEW_RELATIVE.split("/"));
    const output = path.resolve(options.outputPath);
    if (output !== expected) fail("REAL_POLICY_APPEND_DOSSIER_PATH", "preview dossier output must be the exact Stage2 leaf", { output, expected });
    const raw = `${canonicalizeJcs(dossier)}\n`;
    let previousRawSha256: string | undefined;
    if (lstatMaybe(output)) {
      const previous = readOpenedRegular(output, "predecessor execution-ready preview dossier");
      try {
        const parsed = parseCanonical(previous.raw, "predecessor execution-ready preview dossier");
        const base = { ...parsed };
        delete base.dossier_hash;
        if (parsed.schema_version !== REAL_POLICY_APPEND_PREVIEW_SCHEMA || parsed.dossier_hash !== jcsSha256Hex(base)) fail("REAL_POLICY_APPEND_DOSSIER_PATH", "existing Stage2 dossier is not an exact self-valid predecessor");
        previousRawSha256 = previous.raw_sha256;
      } finally { fs.closeSync(previous.fd); }
    }
    const staged = __STAGE2_TEST.stageRepoArtifact({ directory: path.dirname(output), finalName: path.basename(output), raw, mode: 0o644, replaceExistingRawSha256: previousRawSha256 });
    const readback = readOpenedRegular(output, "generated preview dossier");
    try { if (!readback.raw.equals(Buffer.from(raw))) fail("REAL_POLICY_APPEND_DOSSIER_READBACK", "preview dossier readback differs"); }
    finally { fs.closeSync(readback.fd); }
    return deepFreeze({ dossier, raw_sha256: sha256Hex(raw), bytes: Buffer.byteLength(raw), status: previousRawSha256 ? "replaced_exact_predecessor" : staged.status });
  });
}

export function validateRealPolicyAppendPreviewDossier(input: Readonly<Record<string, unknown>>): void {
  if (input.schema_version !== REAL_POLICY_APPEND_PREVIEW_SCHEMA || input.canonicalization !== "RFC8785-JCS" || input.hash_algorithm !== "sha256" || input.dossier_hash_scope !== DOSSIER_HASH_SCOPE || input.mode !== "real_production_real_zfs_execution_ready_read_only_preview") fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "dossier identity differs");
  const base = { ...input };
  delete base.dossier_hash;
  if (typeof input.dossier_hash !== "string" || input.dossier_hash !== jcsSha256Hex(base)) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "dossier self-hash differs");
  const assertions = asRecord(input.assertions, "assertions");
  if (Object.values(assertions).some((value) => value !== true)) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "dossier contains a false assertion");
  const stage3 = asRecord(input.stage3_boundary, "stage3_boundary");
  if (stage3.authorized !== false || stage3.production_append_executed !== false || stage3.outputs_absent !== true || stage3.authorization_text_generated !== false) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "Stage3 boundary differs");
  const closure = asRecord(input.source_closure, "source_closure");
  if (closure.closure_hash !== jcsSha256Hex(closure.preimage)) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "source closure hash differs");
  const preimage = asRecord(closure.preimage, "source closure preimage");
  if (canonicalizeJcs(input.platform_closure) !== canonicalizeJcs(preimage.external_execution_closure)) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "platform closure and complete source closure external object differ");
  const hardAnchors = asRecord(input.hard_anchor_observations, "hard anchor observations");
  if (hardAnchors.C0a_hash !== hardAnchors.C0b_hash || hardAnchors.C0b_hash !== hardAnchors.C1_hash
    || hardAnchors.C0a_hash !== jcsSha256Hex(asRecord(hardAnchors.C0a, "C0a hard anchors"))
    || hardAnchors.C0b_hash !== jcsSha256Hex(asRecord(hardAnchors.C0b, "C0b hard anchors"))
    || hardAnchors.C1_hash !== jcsSha256Hex(asRecord(hardAnchors.C1, "C1 hard anchors"))) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "hard anchor observations differ");
  const mutationProof = asRecord(input.production_mutation_proof, "production mutation proof");
  const wholeAbrainEvidence = asRecord(mutationProof.whole_abrain_evidence_only, "whole .abrain evidence");
  if (wholeAbrainEvidence.scope !== "whole_abrain_evidence_only_not_a_hard_anchor_or_gate" || typeof wholeAbrainEvidence.before_inventory_hash !== "string" || typeof wholeAbrainEvidence.after_inventory_hash !== "string" || !Number.isSafeInteger(wholeAbrainEvidence.delta_count) || typeof wholeAbrainEvidence.ambient_drift_observed !== "boolean" || Object.prototype.hasOwnProperty.call(wholeAbrainEvidence, "equal")) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "whole .abrain record is not evidence-only");
  const runner = asRecord(input.stage2_runner_preflight, "stage2 runner preflight");
  const runnerBase = { ...runner };
  delete runnerBase.record_hash;
  if (runner.record_hash !== jcsSha256Hex(runnerBase) || runner.historical_absence_reobserved !== false) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "Stage2 runner preflight binding differs");
  const contract = asRecord(input.stage3_authorization_contract, "Stage3 authorization contract");
  const contractBase = { ...contract };
  delete contractBase.contract_hash;
  if (contract.contract_hash !== jcsSha256Hex(contractBase)
    || contract.schema_version !== REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_CONTRACT_SCHEMA
    || contract.authorization_spec_schema !== REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA
    || contract.renderer !== REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER
    || contract.renderer_definition_sha256 !== sha256Hex(REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION)
    || canonicalizeJcs(contract.required_spec_fields) !== canonicalizeJcs([...REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED_SPEC_FIELDS])
    || contract.exact_full_text_hash_and_bytes_required !== true
    || contract.exact_text_hash_computed_only_after_explicit_stage3_request !== true
    || contract.latest_role_user_required !== true
    || contract.continuous_parent_chain_required !== true
    || contract.fresh_after_stage2_required !== true
    || contract.authorization_text_generated !== false
    || contract.current_stage2_message_can_satisfy !== false) fail("REAL_POLICY_APPEND_DOSSIER_INVALID", "Stage3 authorization contract differs");
}

function stage3AuthorizationContract(): Readonly<Record<string, unknown>> {
  const base = deepFreeze({
    schema_version: REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_CONTRACT_SCHEMA,
    authorization_spec_schema: REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA,
    renderer: REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER,
    renderer_definition_sha256: sha256Hex(REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION),
    required_spec_fields: [...REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED_SPEC_FIELDS],
    exact_full_text_hash_and_bytes_required: true,
    exact_text_hash_computed_only_after_explicit_stage3_request: true,
    latest_role_user_required: true,
    continuous_parent_chain_required: true,
    fresh_after_stage2_required: true,
    authorization_text_generated: false,
    current_stage2_message_can_satisfy: false,
  });
  return deepFreeze({ ...base, contract_hash: jcsSha256Hex(base) });
}

function captureStage2RunnerPreflight(repoRoot: string): Readonly<Record<string, unknown>> {
  const paths = REAL_POLICY_APPEND_STAGE2_PATHS.map((relative) => {
    const file = path.join(repoRoot, ...relative.split("/"));
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("REAL_POLICY_APPEND_STAGE2_INVENTORY", "current remediation runner found an unsafe Stage2 leaf", { relative });
    const opened = readOpenedRegular(file, `Stage2 runner preflight ${relative}`);
    try { return deepFreeze({ relative_path: relative, observed_state: "present_existing_authorized_regular", bytes: opened.raw.length, raw_sha256: opened.raw_sha256, identity: opened.identity }); }
    finally { fs.closeSync(opened.fd); }
  });
  const base = deepFreeze({
    schema_version: "adr0040-real-policy-proposition-append-stage2-runner-preflight/v1",
    observation_scope: "current remediation rerun, not the historical instant before original create-only Stage2",
    historical_absence_reobserved: false,
    historical_creation_requirement_attested_by_authorization: true,
    authorization_message_id: "d1d44f44",
    authorization_text_sha256: "20c69a2684298d675fd3b6eeb53adeecaa380fd75139e1503e45255e91fa0c4d",
    exact_path_count: paths.length,
    paths,
  });
  return deepFreeze({ ...base, record_hash: jcsSha256Hex(base) });
}

function captureDesignBindings(repoRoot: string): Readonly<Record<string, unknown>> {
  const parsed: Record<string, Record<string, unknown>> = {};
  const rows = DESIGN_ROWS.map((binding) => {
    const opened = readOpenedRegular(path.join(repoRoot, ...binding.path.split("/")), binding.path);
    if (opened.raw_sha256 !== binding.raw) fail("REAL_POLICY_APPEND_DESIGN_RAW", "design binding raw hash differs", { path: binding.path, actual: opened.raw_sha256 });
    const value = parseCanonical(opened.raw, binding.path);
    const claimed = value[binding.field];
    const base = { ...value };
    delete base[binding.field];
    if (claimed !== binding.self || jcsSha256Hex(base) !== binding.self) fail("REAL_POLICY_APPEND_DESIGN_SELF", "design binding self hash differs", { path: binding.path });
    parsed[binding.path] = value;
    return deepFreeze({ relative_path: binding.path, bytes: opened.raw.length, raw_sha256: binding.raw, self_hash_field: binding.field, self_hash: binding.self });
  });
  const planProtocol = parsed[DESIGN_PLAN]!.round_13_protocol;
  const dossierProtocol = parsed[DESIGN_DOSSIER]!.round_13_protocol;
  const planHash = jcsSha256Hex(planProtocol);
  const dossierHash = jcsSha256Hex(dossierProtocol);
  if (planHash !== REAL_POLICY_APPEND_PROTOCOL_HASH || dossierHash !== REAL_POLICY_APPEND_PROTOCOL_HASH || canonicalizeJcs(planProtocol) !== canonicalizeJcs(dossierProtocol)) fail("REAL_POLICY_APPEND_PROTOCOL", "complete Round13 protocol binding differs");
  for (const review of DESIGN_ROWS.slice(2)) {
    const value = parsed[review.path]!;
    if (value.reviewed_protocol_hash !== REAL_POLICY_APPEND_PROTOCOL_HASH || value.verdict !== "SIGN") fail("REAL_POLICY_APPEND_REVIEW", "review protocol or verdict differs", { path: review.path });
  }
  return deepFreeze({ protocol_hash: planHash, plan_and_dossier_protocol_equal: true, artifacts: rows, reviews_sign: 6 });
}

function captureNoFollowInventory(root: string, excluded: Set<string>): InventoryCapture {
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  const proposition: Array<Readonly<Record<string, unknown>>> = [];
  const walk = (file: string): void => {
    const relative = unixRelative(root, file) || ".";
    if (excluded.has(relative)) return;
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink()) {
      const fd = fs.openSync(file, O_PATH | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        const target = fs.readlinkSync(file);
        const after = fs.lstatSync(file);
        if (!opened.isSymbolicLink() || !sameIdentity(before, after) || before.dev !== opened.dev || before.ino !== opened.ino) fail("REAL_POLICY_APPEND_INVENTORY_RACE", "symlink changed", { relative });
        rows.push(deepFreeze({ path: relative, kind: "symlink", mode: before.mode & 0o7777, uid: before.uid, gid: before.gid, nlink: before.nlink, bytes: Buffer.byteLength(target), sha256: sha256Hex(target), target }));
      } finally { fs.closeSync(fd); }
      return;
    }
    if (before.isDirectory()) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) fail("REAL_POLICY_APPEND_INVENTORY_RACE", "directory opened identity differs", { relative });
        const children = fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare);
        const includedChildren = children.filter((name) => !excluded.has(relative === "." ? name : `${relative}/${name}`));
        rows.push(deepFreeze({ path: relative, kind: "directory", mode: before.mode & 0o7777, uid: before.uid, gid: before.gid, nlink: before.nlink, children_sha256: jcsSha256Hex(includedChildren) }));
        for (const child of includedChildren) walk(path.join(file, child));
        const after = fs.fstatSync(fd);
        if (!sameIdentity(opened, after) || canonicalizeJcs(includedChildren) !== canonicalizeJcs(fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare).filter((name) => !excluded.has(relative === "." ? name : `${relative}/${name}`)))) fail("REAL_POLICY_APPEND_INVENTORY_RACE", "directory changed during inventory", { relative });
      } finally { fs.closeSync(fd); }
      return;
    }
    if (!before.isFile()) fail("REAL_POLICY_APPEND_INVENTORY_TYPE", "inventory found an unsupported entry", { relative });
    const opened = readOpenedRegular(file, relative);
    rows.push(deepFreeze({ path: relative, kind: "file", mode: before.mode & 0o7777, uid: before.uid, gid: before.gid, nlink: before.nlink, bytes: opened.raw.length, sha256: opened.raw_sha256 }));
    if (relative.startsWith("l1/events/sha256/") && opened.raw.includes(Buffer.from("proposition-"))) {
      try {
        const envelope = JSON.parse(opened.raw.toString("utf8")) as Record<string, unknown>;
        const body = asRecord(envelope.body, `${relative}.body`);
        if (typeof body.event_schema_version === "string" && body.event_schema_version.startsWith("proposition-")) proposition.push(deepFreeze({ relative_path: relative, event_id: envelope.event_id, envelope_schema: envelope.schema, body_schema: body.event_schema_version, event_type: body.event_type, bytes: opened.raw.length, raw_sha256: opened.raw_sha256 }));
      } catch (error) { fail("REAL_POLICY_APPEND_PROPOSITION_JSON", "proposition-like event is invalid JSON", { relative, error: errorMessage(error) }); }
    }
  };
  walk(root);
  rows.sort((left, right) => compare(String(left.path), String(right.path)));
  proposition.sort((left, right) => compare(String(left.event_id), String(right.event_id)));
  const summary = deepFreeze({
    schema_version: "adr0040-real-policy-no-follow-inventory/v1",
    root,
    entry_count: rows.length,
    directories: rows.filter((row) => row.kind === "directory").length,
    files: rows.filter((row) => row.kind === "file").length,
    symlinks: rows.filter((row) => row.kind === "symlink").length,
    bytes: rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    inventory_hash: jcsSha256Hex(rows),
    symlink_observations: rows.filter((row) => row.kind === "symlink").map((row) => ({ path: row.path, target: row.target })),
  });
  return deepFreeze({ summary, rows, proposition });
}

function captureAmbientInventoryEvidence(abrainHome: string): InventoryCapture {
  let lastRace: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try { return captureNoFollowInventory(abrainHome, new Set()); }
    catch (error) {
      if (!(error instanceof RealPolicyAppendPreviewError) || error.code !== "REAL_POLICY_APPEND_INVENTORY_RACE") throw error;
      lastRace = error;
    }
  }
  fail("REAL_POLICY_APPEND_AMBIENT_EVIDENCE", "whole .abrain evidence could not be captured after bounded no-follow retries", { attempts: 5, last_error: errorMessage(lastRace) });
}

function summarizeWholeAbrainEvidence(before: InventoryCapture, after: InventoryCapture): Readonly<Record<string, unknown>> {
  const beforeByPath = new Map(before.rows.map((row) => [String(row.path), row]));
  const afterByPath = new Map(after.rows.map((row) => [String(row.path), row]));
  const created: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [at, row] of afterByPath) {
    const previous = beforeByPath.get(at);
    if (!previous) created.push(at);
    else if (canonicalizeJcs(previous) !== canonicalizeJcs(row)) modified.push(at);
  }
  for (const at of beforeByPath.keys()) if (!afterByPath.has(at)) removed.push(at);
  const categories = [
    { category: "created", paths: created },
    { category: "modified", paths: modified },
    { category: "removed", paths: removed },
  ].map((entry) => deepFreeze({ category: entry.category, count: entry.paths.length, paths_sha256: jcsSha256Hex(entry.paths) }));
  const deltaCount = created.length + modified.length + removed.length;
  return deepFreeze({
    scope: "whole_abrain_evidence_only_not_a_hard_anchor_or_gate",
    before_inventory_hash: before.summary.inventory_hash,
    after_inventory_hash: after.summary.inventory_hash,
    before_summary: before.summary,
    after_summary: after.summary,
    delta_count: deltaCount,
    delta_categories: categories,
    delta_paths_hash: jcsSha256Hex({ created, modified, removed }),
    ambient_drift_observed: deltaCount !== 0,
  });
}

function captureStage3PrewriteAbsence(repoRoot: string, abrainHome: string): Readonly<Record<string, unknown>> {
  const target = captureTargetAbsence(abrainHome);
  const outputs = REAL_POLICY_APPEND_STAGE3_OUTPUTS.map((relative) => {
    if (lstatMaybe(path.join(repoRoot, ...relative.split("/")))) fail("REAL_POLICY_APPEND_STAGE3_PRESENT", "Stage3 output exists before Stage3", { relative });
    return deepFreeze({ relative_path: relative, state: "absent" });
  });
  return deepFreeze({ target, exact_repo_outputs: outputs, all_stage3_outputs_absent: true });
}

function capturePreviewHardAnchors(options: { repoRoot: string; abrainHome: string }): PreviewHardAnchorCapture {
  const stage3Prewrite = captureStage3PrewriteAbsence(options.repoRoot, options.abrainHome);
  const productionFacts = validateProductionFacts(options.repoRoot, options.abrainHome);
  const downstream = captureDownstreamBindings(options.repoRoot, options.abrainHome);
  const platform = captureRealPolicyAppendExecutionClosure(options.repoRoot);
  try {
    const sourceClosure = captureSourceClosure({ repoRoot: options.repoRoot, externalClosure: platform.evidence });
    const sourcePreimage = asRecord(sourceClosure.preimage, "source closure preimage");
    const tuple = fixedRealPolicyAppendTuple();
    const anchors = deepFreeze({
      schema_version: "adr0040-real-policy-proposition-append-preview-hard-anchors/v1",
      target_and_stage3_prewrite: stage3Prewrite,
      fixed_tuple: { event_id: tuple.event_id, target_path: tuple.absolute_target_path, canonical_envelope_raw_sha256: tuple.canonical_envelope_raw_sha256, caller_supplied_tuple_fields: tuple.caller_supplied_tuple_fields },
      proposition_prestate: asRecord(productionFacts.proposition_prestate, "production proposition prestate"),
      registry: asRecord(productionFacts.registry, "production registry"),
      p2a: asRecord(productionFacts.p2a, "production P2a"),
      p2b1: asRecord(downstream.p2b1, "downstream P2b1"),
      runtime: asRecord(sourcePreimage.runtime, "source closure runtime"),
      source_closure: { closure_hash: sourceClosure.closure_hash, source_rows_hash: jcsSha256Hex(arrayField(sourcePreimage.source_rows, "source closure rows")), external_execution_closure_hash: jcsSha256Hex(asRecord(sourcePreimage.external_execution_closure, "source closure external execution closure")) },
    });
    return deepFreeze({ anchors, hard_anchor_hash: jcsSha256Hex(anchors), target: asRecord(stage3Prewrite.target, "Stage3 prewrite target"), productionFacts, downstream, platformClosure: platform.evidence, sourceClosure });
  } finally { closeRealPolicyAppendExecutionClosureHandles(platform.handles); }
}

function capturePropositionPrestate(abrainHome: string): readonly Readonly<Record<string, unknown>>[] {
  const root = path.join(abrainHome, "l1/events/sha256");
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  const walk = (directory: string): void => {
    const named = fs.lstatSync(directory);
    if (named.isSymbolicLink() || !named.isDirectory()) fail("REAL_POLICY_APPEND_PROPOSITION_SCAN", "proposition event tree directory is unsafe", { directory });
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino) fail("REAL_POLICY_APPEND_PROPOSITION_SCAN", "proposition event directory identity differs", { directory });
      const names = fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare);
      for (const name of names) {
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) fail("REAL_POLICY_APPEND_PROPOSITION_SCAN", "proposition event tree contains a symlink", { file });
        if (stat.isDirectory()) { walk(file); continue; }
        if (!stat.isFile()) fail("REAL_POLICY_APPEND_PROPOSITION_SCAN", "proposition event tree contains a non-regular entry", { file });
        const openedFile = readOpenedRegular(file, `proposition event ${file}`);
        try {
          if (!openedFile.raw.includes(Buffer.from("proposition-"))) continue;
          const envelope = JSON.parse(openedFile.raw.toString("utf8")) as Record<string, unknown>;
          const body = asRecord(envelope.body, "proposition event body");
          if (typeof body.event_schema_version === "string" && body.event_schema_version.startsWith("proposition-")) rows.push(deepFreeze({ event_id: envelope.event_id, raw_sha256: openedFile.raw_sha256, relative_path: unixRelative(abrainHome, file) }));
        } finally { fs.closeSync(openedFile.fd); }
      }
      if (!sameIdentity(opened, fs.fstatSync(fd)) || canonicalizeJcs(names) !== canonicalizeJcs(fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare))) fail("REAL_POLICY_APPEND_PROPOSITION_SCAN", "proposition event directory changed during capture", { directory });
    } finally { fs.closeSync(fd); }
  };
  walk(root);
  rows.sort((left, right) => compare(String(left.event_id), String(right.event_id)));
  return deepFreeze(rows);
}

function validateProductionFacts(repoRoot: string, abrainHome: string): Readonly<Record<string, unknown>> {
  const expected = ["3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3", "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585"];
  const proposition = capturePropositionPrestate(abrainHome);
  const ids = proposition.map((row) => String(row.event_id)).sort(compare);
  const exact = canonicalizeJcs(ids) === canonicalizeJcs(expected);
  if (!exact) fail("REAL_POLICY_APPEND_PRODUCTION_PRESTATE", "production proposition state is not exact genesis plus beee evidence", { ids });
  const registry = readOpenedRegular(path.join(repoRoot, "schemas/l1-schema-role-registry.json"), "L1 registry");
  let registryValue: Record<string, unknown>;
  try { registryValue = JSON.parse(registry.raw.toString("utf8")) as Record<string, unknown>; }
  finally { fs.closeSync(registry.fd); }
  const propositionRegistry = Array.isArray(registryValue.entries)
    ? registryValue.entries.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.domain === "proposition")
    : [];
  if (propositionRegistry.length !== 4 || propositionRegistry.some((entry) => entry.write_enabled !== false || entry.fold_eligible !== false)) fail("REAL_POLICY_APPEND_REGISTRY_GATE", "proposition registry generic write/fold gate is not disabled");
  const genericGate = "L1_SCHEMA_WRITE_DISABLED";
  const p2aRoot = path.join(abrainHome, ".state/sediment/proposition-policy-push-shadow/v1");
  const latest = readOpenedSymlink(path.join(p2aRoot, "latest"), "P2a latest");
  const bundleHash = latest.target.replace(/^bundles\//, "");
  const bundleRoot = path.join(p2aRoot, "bundles", bundleHash);
  const manifestOpened = readOpenedRegular(path.join(bundleRoot, "manifest.json"), "P2a manifest");
  let manifest: Record<string, unknown>;
  try { manifest = parseCanonical(manifestOpened.raw, "P2a manifest"); }
  finally { fs.closeSync(manifestOpened.fd); }
  const bundleInventory = captureNoFollowInventory(bundleRoot, new Set());
  if (bundleHash !== "dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0" || manifest.bundle_hash !== bundleHash || asRecord(manifest.result, "P2a result").entry_count !== 0) fail("REAL_POLICY_APPEND_P2A_PRESTATE", "P2a live bundle differs");
  return deepFreeze({
    abrain_home: abrainHome,
    proposition_prestate: { exact, event_ids: ids, proposition_count: ids.length, genesis_count: 1, evidence_count: 1, lifecycle_count: 0, projection_count: 0, selected_count: 0, foldable_count: 0 },
    registry: { bytes: registry.raw.length, raw_sha256: registry.raw_sha256, registry_id: registryValue.registry_id, generic_write_gate: genericGate },
    p2a: { bundle_hash: bundleHash, latest_value: latest.target, manifest_raw_sha256: manifestOpened.raw_sha256, bundle_inventory_hash: bundleInventory.summary.inventory_hash, counts: manifest.result, runtime_consumer: false },
  });
}

function captureDownstreamBindings(repoRoot: string, abrainHome: string): Readonly<Record<string, unknown>> {
  const p2bPlan = readOpenedRegular(path.join(repoRoot, "docs/evidence/adr0040-p2b1-stable-view-design/implementation-authorization-plan.json"), "P2b plan");
  const p2bDossier = readOpenedRegular(path.join(repoRoot, "docs/evidence/2026-07-14-adr0040-p2b1-production-read-only-preview-dossier.json"), "P2b dossier");
  const plan = parseCanonical(p2bPlan.raw, "P2b plan");
  const dossier = parseCanonical(p2bDossier.raw, "P2b dossier");
  if (p2bPlan.raw_sha256 !== "44df57357ff0e32602a08171fb57d73872f8ef43a6df08d5d3369cfe28921ca5" || plan.plan_hash !== "b985654d88783e39f5d07d35fa42a5bfcf892eb7dcaa07eaa2314b623be07ce0"
    || p2bDossier.raw_sha256 !== "2d9d1cf3913aac68b7bc5c463577e9dfc1861196b805bb2058c352e29e722c71" || dossier.dossier_hash !== "dd58e8aef05f97dd6c9f0b491ee19ba97a0d9cc803c9a091e2d0c2593245520b") fail("REAL_POLICY_APPEND_P2B_BINDING", "P2b plan/dossier binding differs");
  const transitionOpened = readOpenedRegular(path.join(repoRoot, "docs/transition-register.machine.json"), "transition register");
  const transition = JSON.parse(transitionOpened.raw.toString("utf8")) as unknown;
  fs.closeSync(transitionOpened.fd);
  const matches: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => { if (Array.isArray(value)) value.forEach(walk); else if (isRecord(value)) { if (value.id === "proposition.adr0040-p2b-policy-push-stable-view") matches.push(value); Object.values(value).forEach(walk); } };
  walk(transition);
  if (matches.length !== 1 || matches[0]!.phase_status !== "blocked" || matches[0]!.authorization_status !== "separate_authorization_required") fail("REAL_POLICY_APPEND_P2B_STATUS", "P2b is not blocked/separate authorization");
  const p2aLatest = readOpenedSymlink(path.join(abrainHome, ".state/sediment/proposition-policy-push-shadow/v1/latest"), "P2a latest downstream");
  return deepFreeze({ valid: true, p2a: { latest_value: p2aLatest.target, bundle_hash: p2aLatest.target.replace(/^bundles\//, ""), runtime_consumer: false }, p2b1: { plan_raw_sha256: p2bPlan.raw_sha256, plan_hash: plan.plan_hash, dossier_raw_sha256: p2bDossier.raw_sha256, dossier_hash: dossier.dossier_hash, phase_status: "blocked", authorization_status: "separate_authorization_required", production_destination_defined: false, runtime_reachable: false } });
}

function captureZfsProof(input: { repoRoot: string; abrainHome: string; sandboxRoot: string }): Readonly<Record<string, unknown>> {
  const findmnt = readOpenedRegular("/usr/bin/findmnt", "findmnt");
  const roots = [input.repoRoot, input.abrainHome, input.sandboxRoot];
  const rows = roots.map((root) => {
    const result = spawnSync("/proc/self/fd/3", ["-J", "-T", root, "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", findmnt.fd] });
    if (result.error || result.status !== 0 || result.signal || result.stderr) fail("REAL_POLICY_APPEND_ZFS", "verified findmnt failed", { root, status: result.status, signal: result.signal, stderr: result.stderr });
    const parsed = JSON.parse(result.stdout) as { filesystems?: Array<Record<string, unknown>> };
    const mount = parsed.filesystems?.[0];
    const statfs = fs.statfsSync(root);
    const type = Number(statfs.type);
    if (!mount || mount.fstype !== "zfs" || type !== ZFS_MAGIC) fail("REAL_POLICY_APPEND_ZFS", "required root is not real ZFS", { root, mount, type });
    return deepFreeze({ root, mount_target: mount.target, source: mount.source, fstype: mount.fstype, options: mount.options, statfs_type_hex: type.toString(16), statfs_bsize: Number(statfs.bsize) });
  });
  fs.closeSync(findmnt.fd);
  return deepFreeze({ proof: "verified_findmnt_plus_kernel_statfs_magic", no_fallback: true, zfs_magic_hex: ZFS_MAGIC.toString(16), roots: rows, all_zfs: rows.every((row) => row.fstype === "zfs" && row.statfs_type_hex === ZFS_MAGIC.toString(16)) });
}

function captureTargetAbsence(abrainHome: string): Readonly<Record<string, unknown>> {
  const components = REAL_POLICY_APPEND_RELATIVE_TARGET.split("/");
  let current = abrainHome;
  const openedAncestors: Array<Readonly<Record<string, unknown>>> = [];
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    const stat = lstatMaybe(current);
    if (!stat) break;
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { const opened = fs.fstatSync(fd); if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) fail("REAL_POLICY_APPEND_TARGET_ANCESTOR", "event ancestor identity differs", { current }); openedAncestors.push({ path: unixRelative(abrainHome, current), dev: Number(opened.dev), ino: Number(opened.ino), mode: opened.mode & 0o7777, uid: opened.uid, gid: opened.gid, nlink: opened.nlink }); }
    finally { fs.closeSync(fd); }
  }
  if (lstatMaybe(REAL_POLICY_APPEND_ABSOLUTE_TARGET) || lstatMaybe(REAL_POLICY_APPEND_SECOND_SHARD)) fail("REAL_POLICY_APPEND_TARGET_PRESENT", "Stage2 requires target and second shard absent");
  return deepFreeze({ target_path: REAL_POLICY_APPEND_ABSOLUTE_TARGET, target_state: "absent", second_shard_path: REAL_POLICY_APPEND_SECOND_SHARD, second_shard_state: "absent", event_temp_state: "absent_by_absent_second_shard", ancestor_chain: openedAncestors, no_follow: true });
}

interface PlatformHandle { path: string; fd: number; raw: Buffer; raw_sha256: string; identity: Readonly<Record<string, unknown>> }

async function proveSameOfdFlock(options: { sandboxRoot: string; node: PlatformHandle; flock: PlatformHandle }): Promise<Readonly<Record<string, unknown>>> {
  const root = path.join(options.sandboxRoot, "work", "flock-proof");
  removeIfPresent(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const lockFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const acquired = spawnFlock(lockFd, options.flock.fd);
    if (acquired.status !== 0 || acquired.signal || acquired.stderr) fail("REAL_POLICY_APPEND_FLOCK", "same-OFD acquisition failed", acquired as unknown as Record<string, unknown>);
    const contenderFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const busy = spawnFlock(contenderFd, options.flock.fd);
    if (busy.status !== 1 || busy.signal) fail("REAL_POLICY_APPEND_FLOCK", "contender did not return BUSY", busy as unknown as Record<string, unknown>);
    fs.closeSync(lockFd);
    const released = spawnFlock(contenderFd, options.flock.fd);
    fs.closeSync(contenderFd);
    if (released.status !== 0 || released.signal) fail("REAL_POLICY_APPEND_FLOCK", "parent close did not release same OFD", released as unknown as Record<string, unknown>);

    const holderCode = `const fs=require("node:fs"),cp=require("node:child_process");const d=process.argv[1];const l=fs.openSync(d,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const r=cp.spawnSync("/proc/self/fd/4",["-xn","3"],{stdio:["ignore","pipe","pipe",l,4],env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"}});if(r.status!==0)process.exit(80);process.stdout.write("READY\\n");setInterval(()=>{},1000);`;
    const holder = spawn("/proc/self/fd/3", ["-e", holderCode, root], { env: {}, stdio: ["ignore", "pipe", "pipe", options.node.fd, options.flock.fd] });
    await waitForReady(holder);
    const sigkillContenderFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const sigkillBusy = spawnFlock(sigkillContenderFd, options.flock.fd);
    if (sigkillBusy.status !== 1) fail("REAL_POLICY_APPEND_FLOCK", "SIGKILL holder did not hold lock", { status: sigkillBusy.status });
    holder.kill("SIGKILL");
    const holderClose = await waitForClose(holder);
    if (holderClose.signal !== "SIGKILL") fail("REAL_POLICY_APPEND_FLOCK", "holder did not terminate by SIGKILL", holderClose as unknown as Record<string, unknown>);
    const afterKill = spawnFlock(sigkillContenderFd, options.flock.fd);
    fs.closeSync(sigkillContenderFd);
    if (afterKill.status !== 0 || afterKill.signal) fail("REAL_POLICY_APPEND_FLOCK", "SIGKILL did not release holder OFD", afterKill as unknown as Record<string, unknown>);
    return deepFreeze({ executable_sha256: options.flock.raw_sha256, same_ofd_parent_retained_after_child_exit: true, success: true, busy: true, busy_status: 1, parent_close_release: true, holder_sigkill_release: true, lock_artifacts_created: [], advisory_scope: "official executors only" });
  } finally { removeIfPresent(root); }
}

function proveEffectiveBwrap(options: { node: PlatformHandle; bwrap: PlatformHandle }): Readonly<Record<string, unknown>> {
  const hostNamespaces = namespaceRows();
  const code = `const fs=require("node:fs"),net=require("node:net");function open(p){try{const f=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);fs.closeSync(f);return{denied:false,code:null}}catch(e){return{denied:["EROFS","EACCES","EPERM"].includes(e.code),code:e.code}}}function ns(n){try{return fs.readlinkSync("/proc/self/ns/"+n)}catch{return null}}const status=fs.readFileSync("/proc/self/status","utf8").split("\\n").find(x=>x.startsWith("CapEff:"));const base={namespaces:Object.fromEntries(["user","mnt","pid","net","ipc","uts","cgroup"].map(n=>[n,ns(n)])),cap_eff:status.split(/\\s+/)[1],abrain:open("/home/worker/.abrain/l1/events/sha256/39/75/3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3.json"),repo:open("/home/worker/.pi/agent/skills/pi-astack/package.json")};const s=net.createConnection({host:"198.51.100.1",port:9});const done=x=>{base.network=x;process.stdout.write(JSON.stringify(base)+"\\n")};const t=setTimeout(()=>{s.destroy();done({denied:true,code:"TIMEOUT"})},500);s.once("connect",()=>{clearTimeout(t);s.destroy();done({denied:false,code:null})});s.once("error",e=>{clearTimeout(t);done({denied:true,code:e.code})});`;
  const args = [
    "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C", "--setenv", "LC_ALL", "C",
    "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--remount-ro", "/tmp", "--tmpfs", "/run", "--dir", "/run/pi-astack",
    "--ro-bind-fd", "4", "/run/pi-astack/node", "--remount-ro", "/run", "--chdir", "/", "--", "/run/pi-astack/node", "-e", code,
  ];
  const result = spawnSync("/proc/self/fd/3", args, { encoding: "utf8", env: {}, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe", options.bwrap.fd, options.node.fd] });
  if (result.error || result.status !== 0 || result.signal || result.stderr) fail("REAL_POLICY_APPEND_BWRAP", "bubblewrap effectiveness probe failed", { error: result.error?.message, status: result.status, signal: result.signal, stderr: result.stderr, stdout: result.stdout });
  const observed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  const sandboxNamespaces = asRecord(observed.namespaces, "bwrap namespaces");
  const separated = Object.keys(hostNamespaces).every((name) => typeof sandboxNamespaces[name] === "string" && sandboxNamespaces[name] !== hostNamespaces[name]);
  const effective = observed.cap_eff === "0000000000000000" && asRecord(observed.abrain, "bwrap abrain").denied === true && asRecord(observed.repo, "bwrap repo").denied === true && asRecord(observed.network, "bwrap network").denied === true && separated;
  if (!effective) fail("REAL_POLICY_APPEND_BWRAP", "bubblewrap did not effectively deny host writes/network/capabilities", { observed, hostNamespaces, separated });
  return deepFreeze({ effective, executable_sha256: options.bwrap.raw_sha256, node_sha256: options.node.raw_sha256, host_namespaces: hostNamespaces, sandbox_namespaces: sandboxNamespaces, all_namespaces_separate: separated, zero_effective_capabilities: true, production_abrain_writable_open_denied: true, production_repo_writable_open_denied: true, network_denied: true, mutation_attempt: "writable-open-only-no-content-write", fallback: "none_fail_closed" });
}

function proveDurabilityAndCrashRecovery(options: { repoRoot: string; sandboxRoot: string }): Readonly<Record<string, unknown>> {
  const root = path.join(options.sandboxRoot, "work", "durability-proof");
  removeIfPresent(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const executeRelative = "extensions/_shared/proposition-real-policy-append-production-execute.ts";
  const worker = `const path=require("node:path");const {createRequire}=require("node:module");const [repo,root,kind,stage]=process.argv.slice(1);const require2=createRequire(path.join(repo,"package.json"));const {createJiti}=require2("jiti");const j=createJiti(repo,{interopDefault:true,fsCache:false,moduleCache:false});const m=j(path.join(repo,"${executeRelative}"));if(kind==="event")m.__STAGE2_TEST.convergeFixedEvent({abrainHome:root,intentHash:"${"a".repeat(64)}",crashAt:stage});else m.__STAGE2_TEST.stageRepoArtifact({directory:root,finalName:"artifact.json",raw:"{\\\"proof\\\":true}\\n",crashAt:stage});`;
  const eventRows: Array<Readonly<Record<string, unknown>>> = [];
  const repoRows: Array<Readonly<Record<string, unknown>>> = [];
  try {
    for (const stage of ["S0", "S2", "S3"] as const) {
      const home = path.join(root, `event-${stage}`);
      fs.mkdirSync(path.join(home, "l1/events/sha256/1c"), { recursive: true, mode: 0o700 });
      const child = spawnSync(process.execPath, ["-e", worker, options.repoRoot, home, "event", stage], { encoding: "utf8" });
      if (child.signal !== "SIGKILL") fail("REAL_POLICY_APPEND_EVENT_CRASH", "event boundary worker did not SIGKILL", { stage, status: child.status, signal: child.signal, stderr: child.stderr });
      const observed = __STAGE2_TEST.classifyFixedEventState({ abrainHome: home, intentHash: "a".repeat(64) });
      const recovered = __STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash: "a".repeat(64) });
      const rerun = __STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash: "a".repeat(64) });
      eventRows.push(deepFreeze({ crash_after: stage, durable_state_observed: observed, recovery_final: recovered.final_state, identical_rerun: rerun.identical, target_sha256: sha256Hex(fs.readFileSync(path.join(home, ...REAL_POLICY_APPEND_RELATIVE_TARGET.split("/")))) }));
    }
    for (const stage of ["temp", "linked"] as const) {
      const directory = path.join(root, `repo-${stage}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      const child = spawnSync(process.execPath, ["-e", worker, options.repoRoot, directory, "repo", stage], { encoding: "utf8" });
      if (child.signal !== "SIGKILL") fail("REAL_POLICY_APPEND_REPO_CRASH", "repo boundary worker did not SIGKILL", { stage, status: child.status, signal: child.signal, stderr: child.stderr });
      const recovered = __STAGE2_TEST.stageRepoArtifact({ directory, finalName: "artifact.json", raw: "{\"proof\":true}\n" });
      const rerun = __STAGE2_TEST.stageRepoArtifact({ directory, finalName: "artifact.json", raw: "{\"proof\":true}\n" });
      repoRows.push(deepFreeze({ crash_after: stage, recovery_status: recovered.status, rerun_status: rerun.status, final_sha256: sha256Hex(fs.readFileSync(path.join(directory, "artifact.json"))), residues: fs.readdirSync(directory).filter((name) => name.startsWith(".")) }));
    }
    const procDir = path.join(root, "procfd");
    fs.mkdirSync(procDir, { mode: 0o700 });
    const proc = __STAGE2_TEST.procfdDirectory(procDir);
    try {
      const file = path.join(proc.path, "relative-create");
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { writeAll(fd, Buffer.from("dirfd\n")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.fsyncSync(proc.fd);
    } finally { fs.closeSync(proc.fd); }
    const complete = eventRows.every((row) => row.recovery_final === "S4" && row.identical_rerun === true && row.target_sha256 === REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256)
      && repoRows.every((row) => row.rerun_status === "identical" && Array.isArray(row.residues) && row.residues.length === 0)
      && fs.readFileSync(path.join(procDir, "relative-create"), "utf8") === "dirfd\n";
    if (!complete) fail("REAL_POLICY_APPEND_DURABILITY", "ZFS durability proof is incomplete", { eventRows, repoRows });
    return deepFreeze({ complete, filesystem: "real ZFS disposable sandbox", hardlink_no_replace: true, file_fsync: true, directory_fsync: true, procfs_dirfd_relative_create: true, deterministic_repo_staging: repoRows, event_s0_s4_sigkill_boundaries: eventRows, production_abrain_touched: false, production_repo_staging_touched: false });
  } finally { removeIfPresent(root); }
}

function captureSourceClosure(options: { repoRoot: string; externalClosure: Readonly<Record<string, unknown>> }): Readonly<Record<string, unknown>> {
  const entrypoints = {
    dossier: "scripts/dossier-proposition-real-policy-append-production-preview.mjs",
    execute: "scripts/execute-proposition-real-policy-append-evidence.mjs",
    smoke: "scripts/smoke-proposition-real-policy-append.mjs",
  } as const;
  const dynamicModules = Object.fromEntries(Object.entries(entrypoints).map(([name, entrypoint]) => [name, extractJitiRepoModules({ repoRoot: options.repoRoot, entrypoint, repoRootIdentifiers: ["repoRoot", "sourceRoot"] })]));
  const graphs = Object.fromEntries(Object.entries(dynamicModules).map(([name, roots]) => {
    const graph = buildTypescriptStaticDependencyGraph({ repoRoot: options.repoRoot, roots: roots as readonly string[] });
    validateTypescriptStaticDependencyGraph(graph);
    return [name, graph];
  }));
  const packageOpened = readOpenedRegular(path.join(options.repoRoot, "package.json"), "package.json source closure");
  fs.closeSync(packageOpened.fd);
  const pkg = JSON.parse(packageOpened.raw.toString("utf8")) as { pi?: { extensions?: string[] } };
  const runtimeRoots = pkg.pi?.extensions ?? [];
  const runtimeGraph = buildTypescriptStaticDependencyGraph({ repoRoot: options.repoRoot, roots: runtimeRoots });
  validateTypescriptStaticDependencyGraph(runtimeGraph);
  const forbidden = new Set(REAL_POLICY_APPEND_STAGE2_PATHS);
  const runtimeReachableStage2 = runtimeGraph.files.map((row) => row.path).filter((relative) => forbidden.has(relative as typeof REAL_POLICY_APPEND_STAGE2_PATHS[number]));
  if (runtimeReachableStage2.length || runtimeGraph.unresolved_dynamic_loaders.length) fail("REAL_POLICY_APPEND_RUNTIME_REACHABLE", "Stage2 surface is reachable from runtime roots", { runtimeReachableStage2 });
  const graphPaths = new Set<string>(Object.values(graphs).flatMap((graph) => (graph as ReturnType<typeof buildTypescriptStaticDependencyGraph>).files.map((row) => row.path)));
  const entrypointPaths = Object.values(entrypoints);
  for (const required of SOURCE_FILES) {
    if (!graphPaths.has(required) && !entrypointPaths.includes(required as typeof entrypointPaths[number])) fail("REAL_POLICY_APPEND_SOURCE_CLOSURE", "Stage2 source is absent from the executable-entrypoint plus TS-graph union", { required });
  }
  const dependencyPaths = [...new Set([...graphPaths, ...entrypointPaths, "package.json", ...DESIGN_ROWS.map((row) => row.path)])].sort(compare);
  const rows = dependencyPaths.map((relative) => {
    const opened = readOpenedRegular(path.join(options.repoRoot, ...relative.split("/")), `source closure ${relative}`);
    fs.closeSync(opened.fd);
    const roles = [SOURCE_FILES.includes(relative as typeof SOURCE_FILES[number]) ? "stage2_new_source" : null, graphPaths.has(relative) ? "reachable_static_dependency" : null, relative === "package.json" ? "runtime_root_registry" : null, DESIGN_ROWS.some((row) => row.path === relative) ? "authorized_design_binding" : null].filter((role): role is string => role !== null).sort(compare);
    return deepFreeze({ path: relative, bytes: opened.raw.length, sha256: opened.raw_sha256, roles });
  });
  const preimage = deepFreeze({
    schema_version: "adr0040-real-policy-proposition-append-stage2-source-closure/v1",
    claim: "closed_world_stage2_js_entrypoints_ast_jiti_roots_transitive_ts_dependencies_runtime_unreachability_design_bindings_and_external_execution_closure",
    stage2_path_inventory: REAL_POLICY_APPEND_STAGE2_PATHS,
    dossier_cycle_break: { path: REAL_POLICY_APPEND_PREVIEW_RELATIVE, content_hash_in_closure: null, rule: "dossier self-hash binds this closure; closure binds dossier path and schema but excludes dossier bytes to avoid an impossible cryptographic fixed point" },
    executable_entrypoints: entrypoints,
    dynamic_jiti_modules: dynamicModules,
    typescript_dependency_graphs: graphs,
    source_rows: rows,
    runtime: { package_json_sha256: packageOpened.raw_sha256, extension_roots: runtimeRoots, extension_roots_hash: jcsSha256Hex(runtimeRoots), dependency_graph: runtimeGraph, stage2_reachable_paths: runtimeReachableStage2, unreachable: true },
    external_execution_closure: options.externalClosure,
  });
  return deepFreeze({ preimage, closure_hash: jcsSha256Hex(preimage) });
}

function assertStage2AndStage3Leaves(repoRoot: string, options: { stage2SourcesPresent: boolean; dossierMayExist: boolean }): void {
  for (const [index, relative] of REAL_POLICY_APPEND_STAGE2_PATHS.entries()) {
    const stat = lstatMaybe(path.join(repoRoot, ...relative.split("/")));
    const expected = index < 7 && options.stage2SourcesPresent ? "present" : index === 7 && options.dossierMayExist ? "either" : "absent";
    if (expected === "present" && (!stat || stat.isSymbolicLink() || !stat.isFile())) fail("REAL_POLICY_APPEND_STAGE2_INVENTORY", "required Stage2 source is absent/unsafe", { relative });
    if (expected === "absent" && stat) fail("REAL_POLICY_APPEND_STAGE2_INVENTORY", "unauthorized Stage2 leaf is already present", { relative });
  }
  for (const relative of REAL_POLICY_APPEND_STAGE3_OUTPUTS) if (lstatMaybe(path.join(repoRoot, ...relative.split("/")))) fail("REAL_POLICY_APPEND_STAGE3_PRESENT", "Stage3 output exists during Stage2", { relative });
}

function readOpenedRegular(fileInput: string, label: string): PlatformHandle {
  const file = path.resolve(fileInput);
  assertAncestorsNoSymlink(file);
  const named = fs.lstatSync(file);
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(file) !== file) fail("REAL_POLICY_APPEND_OPEN_UNSAFE", `${label} is not an exact regular file`, { file });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) { fs.closeSync(fd); fail("REAL_POLICY_APPEND_OPEN_RACE", `${label} opened identity differs`, { file }); }
  const raw = fs.readFileSync(fd);
  const after = fs.fstatSync(fd);
  if (!sameIdentity(opened, after) || raw.length !== opened.size) { fs.closeSync(fd); fail("REAL_POLICY_APPEND_OPEN_RACE", `${label} changed while read`, { file }); }
  return { path: file, fd, raw, raw_sha256: sha256Hex(raw), identity: deepFreeze({ dev: Number(opened.dev), ino: Number(opened.ino), size: opened.size, mode: opened.mode, uid: opened.uid, gid: opened.gid, nlink: opened.nlink, mtime_ms: opened.mtimeMs, ctime_ms: opened.ctimeMs }) };
}

function readOpenedSymlink(file: string, label: string): { target: string; identity: Readonly<Record<string, unknown>> } {
  assertAncestorsNoSymlink(file);
  const named = fs.lstatSync(file);
  if (!named.isSymbolicLink()) fail("REAL_POLICY_APPEND_OPEN_UNSAFE", `${label} is not a symlink`);
  const fd = fs.openSync(file, O_PATH | fs.constants.O_NOFOLLOW);
  try { const opened = fs.fstatSync(fd); const target = fs.readlinkSync(file); const after = fs.lstatSync(file); if (!opened.isSymbolicLink() || !sameIdentity(named, after) || opened.dev !== named.dev || opened.ino !== named.ino) fail("REAL_POLICY_APPEND_OPEN_RACE", `${label} changed while read`); return { target, identity: deepFreeze({ dev: Number(opened.dev), ino: Number(opened.ino), mode: opened.mode, uid: opened.uid, gid: opened.gid, nlink: opened.nlink }) }; }
  finally { fs.closeSync(fd); }
}

function spawnFlock(lockFd: number, flockFd: number): { status: number | null; signal: NodeJS.Signals | null; stderr: string } {
  const result = spawnSync("/proc/self/fd/4", ["-xn", "3"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", lockFd, flockFd] });
  if (result.error) fail("REAL_POLICY_APPEND_FLOCK", "flock spawn failed", { error: result.error.message });
  return { status: result.status, signal: result.signal, stderr: result.stderr };
}

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("holder READY timeout")), 5000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { output += chunk; if (output.includes("READY\n")) { clearTimeout(timer); resolve(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status, signal) => { if (!output.includes("READY\n")) { clearTimeout(timer); reject(new Error(`holder closed before READY status=${status} signal=${signal}`)); } });
  });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<{ status: number | null; signal: NodeJS.Signals | null }> { return new Promise((resolve) => child.once("close", (status, signal) => resolve({ status, signal }))); }
function namespaceRows(): Record<string, string | null> { return Object.fromEntries(["user", "mnt", "pid", "net", "ipc", "uts", "cgroup"].map((name) => { try { return [name, fs.readlinkSync(`/proc/self/ns/${name}`)]; } catch { return [name, null]; } })); }
function parseCanonical(raw: Buffer, label: string): Record<string, unknown> { let value: unknown; try { value = JSON.parse(raw.toString("utf8")); } catch (error) { fail("REAL_POLICY_APPEND_JSON", `${label} is invalid JSON`, { error: errorMessage(error) }); } if (!isRecord(value) || `${canonicalizeJcs(value)}\n` !== raw.toString("utf8")) fail("REAL_POLICY_APPEND_JCS", `${label} is not exact JCS plus LF`); return value; }
function assertAncestorsNoSymlink(file: string): void { let current = path.parse(path.resolve(file)).root; for (const component of path.relative(current, path.dirname(path.resolve(file))).split(path.sep).filter(Boolean)) { current = path.join(current, component); const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("REAL_POLICY_APPEND_ANCESTOR", "path ancestor is a symlink or non-directory", { current }); } }
function fsyncDirectory(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeAll(fd: number, bytes: Buffer): void { let offset = 0; while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset); if (written <= 0) fail("REAL_POLICY_APPEND_WRITE", "write made no progress"); offset += written; } }
function exactDirectory(input: string, label: string): string { const resolved = path.resolve(input); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) fail("REAL_POLICY_APPEND_DIRECTORY", `${label} is not exact`, { resolved }); return resolved; }
export const __STAGE2_PREVIEW_TEST = Object.freeze({ summarizeWholeAbrainEvidence });

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function asRecord(value: unknown, at: string): Record<string, unknown> { if (!isRecord(value)) fail("REAL_POLICY_APPEND_SHAPE", `${at} must be an object`); return value; }
function arrayField(value: unknown, at: string): unknown[] { if (!Array.isArray(value)) fail("REAL_POLICY_APPEND_SHAPE", `${at} must be an array`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function removeIfPresent(file: string): void { fs.rmSync(file, { recursive: true, force: true }); }
function isInside(parent: string, child: string): boolean { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative)); }
function unixRelative(parent: string, child: string): string { return path.relative(parent, child).split(path.sep).join("/"); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { throw new RealPolicyAppendPreviewError(code, message, detail); }
function deepFreeze<T>(value: T): T { if (Buffer.isBuffer(value)) return value; if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
