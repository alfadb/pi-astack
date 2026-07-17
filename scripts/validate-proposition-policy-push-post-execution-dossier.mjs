#!/usr/bin/env node
/** ADR0040 P2a.2 post-execution evidence validator. Performs read-only verification only. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));
const planApi = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-live-publication-plan.ts"));
const publication = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-live-publication.ts"));
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));

const DOSSIER_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a2-production-post-execution-dossier.json";
const REPLAY_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a22-production-nonzero-append-replay-dossier.json";
const PREVIEW_RELATIVE = "docs/evidence/2026-07-14-adr0040-p2a22-live-publication-read-only-preview-dossier-v5.json";
const EXPECTED_PLAN_HASH = "3177101400ceed3b5da86d6d6d99a1b269d8deef9b9bd418cfbaa33ad0c91f0a";
const EXPECTED_TARGET_INVENTORY_HASH = "ee29acf5f4fc106156999f6685baf407eaf1aa523e6d2f5a292de3d4be4edb4d";
const FIVE_VERDICTS = Object.freeze(["confinement", "drift", "protected", "runtime", "target"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function asRecord(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function canonicalEqual(actual, expected, label) {
  assert(jcs.canonicalizeJcs(actual) === jcs.canonicalizeJcs(expected), `${label} differs`);
}

function selfHash(value, key) {
  const base = { ...asRecord(value, key) };
  delete base[key];
  return jcs.jcsSha256Hex(base);
}

function validateSha256Fields(value, at) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateSha256Fields(child, `${at}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childAt = `${at}.${key}`;
    if (key === "sha256" || key.endsWith("_sha256") || key.endsWith("_hash")) {
      assert(typeof child === "string" && SHA256_PATTERN.test(child), `${childAt} must be a lowercase 64-character SHA-256 value`);
    }
    validateSha256Fields(child, childAt);
  }
}

async function readCanonical(relative, label, selfHashKey = null) {
  assert(typeof relative === "string" && relative.length > 0 && !path.isAbsolute(relative), `${label} path must be repository-relative`);
  const file = path.join(repoRoot, ...relative.split("/"));
  assert(path.resolve(file).startsWith(`${repoRoot}${path.sep}`), `${label} path escapes the repository`);
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert(await fs.realpath(file) === file, `${label} path must be canonical`);
  const raw = await fs.readFile(file);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const canonical = Buffer.from(`${jcs.canonicalizeJcs(value)}\n`, "utf8");
  assert(raw.equals(canonical), `${label} bytes are not canonical RFC8785-JCS plus one newline`);
  validateSha256Fields(value, label);
  if (selfHashKey) {
    const expected = asRecord(value, label)[selfHashKey];
    assert(typeof expected === "string" && selfHash(value, selfHashKey) === expected, `${label} ${selfHashKey} is invalid`);
  }
  return Object.freeze({ value, raw, raw_sha256: jcs.sha256Hex(raw) });
}

function requireTrueFields(record, fields, label) {
  for (const field of fields) assert(record[field] === true, `${label}.${field} must be true`);
}

async function main() {
  assert(process.argv.length === 2, "this validator accepts no arguments");

  const dossierArtifact = await readCanonical(DOSSIER_RELATIVE, "post-execution dossier", "dossier_hash");
  const dossier = asRecord(dossierArtifact.value, "post-execution dossier");
  assert(dossier.schema_version === "proposition-policy-push-production-post-execution-dossier/v1", "post-execution dossier schema differs");
  assert(dossier.canonicalization === "RFC8785-JCS" && dossier.hash_algorithm === "sha256", "post-execution dossier canonicalization differs");

  const dossierPlan = asRecord(dossier.plan, "dossier.plan");
  assert(dossierPlan.relative_path === planApi.PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE, "dossier plan path differs");
  const planArtifact = await readCanonical(dossierPlan.relative_path, "publication plan", "plan_hash");
  const plan = asRecord(planArtifact.value, "publication plan");
  const recomputedPlanHash = selfHash(plan, "plan_hash");
  assert(recomputedPlanHash === EXPECTED_PLAN_HASH, "recomputed publication plan hash differs from the frozen plan hash");
  assert(plan.plan_hash === recomputedPlanHash, "publication plan self-hash differs");
  assert(dossierPlan.plan_hash === plan.plan_hash && dossierPlan.recomputed_plan_hash === recomputedPlanHash, "dossier plan content-hash binding differs");
  assert(dossierPlan.raw_sha256 === planArtifact.raw_sha256, "dossier plan raw hash differs");
  assert(dossierPlan.bundle_hash === plan.bundle.bundle_hash, "dossier plan bundle hash differs");
  assert(dossierPlan.drift_registry_hash === plan.drift_registry.registry_hash, "dossier drift registry hash differs");
  assert(dossierPlan.source_inventory_hash === plan.confinement.source_inventory.inventory_hash, "dossier source inventory hash differs");

  const bundle = await shadow.buildPropositionPolicyPushShadow({
    abrainHome: planApi.PROPOSITION_POLICY_PUSH_HARD_ABRAIN,
    repoRoot,
    registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json"),
  });
  const gate = await publication.validatePublicationGatesV2({ repoRoot, bundle, mode: "production" });
  assert(gate.plan_hash === plan.plan_hash && gate.plan_raw_sha256 === planArtifact.raw_sha256, "validated publication gate plan binding differs");

  const dossierIntent = asRecord(dossier.intent, "dossier.intent");
  assert(dossierIntent.relative_path === planApi.publicationIntentV3Relative(), "dossier intent path differs");
  const intentArtifact = await readCanonical(dossierIntent.relative_path, "publication intent", "intent_hash");
  const intent = asRecord(intentArtifact.value, "publication intent");
  assert(dossierIntent.bytes === intentArtifact.raw.length && dossierIntent.canonical_bytes_valid === true, "dossier intent byte binding differs");
  assert(dossierIntent.raw_sha256 === intentArtifact.raw_sha256, "dossier intent raw hash differs");
  assert(dossierIntent.intent_hash === intent.intent_hash && dossierIntent.recomputed_intent_hash === selfHash(intent, "intent_hash"), "dossier intent self-hash binding differs");
  assert(gate.intent_hash === intent.intent_hash, "validated publication gate intent differs");
  assert(intent.plan_hash === plan.plan_hash && intent.plan_raw_sha256 === planArtifact.raw_sha256 && intent.plan_relative_path === dossierPlan.relative_path, "intent plan binding differs");

  const dossierAuthorization = asRecord(dossier.authorization, "dossier.authorization");
  const intentAuthorization = asRecord(intent.authorization, "intent.authorization");
  canonicalEqual({
    authorization_text_sha256: dossierAuthorization.authorization_text_sha256,
    kind: dossierAuthorization.kind,
    role: dossierAuthorization.role,
    transcript: dossierAuthorization.transcript,
  }, intentAuthorization, "dossier authorization binding");
  requireTrueFields(dossierAuthorization, [
    "continuous_parent_chain_verified",
    "exact_generated_text_verified",
    "fresh_after_frozen_p1b_attestation",
    "latest_role_user_message_verified",
    "unique_message_id_verified",
  ], "dossier.authorization");

  const expectedReviewPaths = planApi.publicationReviewV2RelativePaths();
  const dossierReviews = dossier.reviews;
  assert(Array.isArray(dossierReviews) && dossierReviews.length === expectedReviewPaths.length && dossierReviews.length === 6, "dossier must bind exactly six reviews");
  canonicalEqual(dossierReviews, intent.reviews, "dossier and intent review bindings");
  canonicalEqual(dossierReviews, gate.reviews, "dossier and validated gate review bindings");
  for (const [index, bindingValue] of dossierReviews.entries()) {
    const binding = asRecord(bindingValue, `dossier.reviews[${index}]`);
    assert(binding.relative_path === expectedReviewPaths[index], `review ${index + 1} path differs`);
    const reviewArtifact = await readCanonical(binding.relative_path, `review ${index + 1}`);
    const review = asRecord(reviewArtifact.value, `review ${index + 1}`);
    assert(reviewArtifact.raw_sha256 === binding.raw_sha256, `review ${index + 1} raw hash differs`);
    assert(review.vendor === binding.vendor && review.model === binding.model && review.verdict === "SIGN" && binding.verdict === "SIGN", `review ${index + 1} identity or verdict differs`);
    assert(review.plan_hash === plan.plan_hash && review.plan_raw_sha256 === planArtifact.raw_sha256 && review.reviewed_plan_relative_path === dossierPlan.relative_path, `review ${index + 1} plan binding differs`);
  }

  const dossierReplay = asRecord(dossier.replay_dossier, "dossier.replay_dossier");
  assert(dossierReplay.relative_path === REPLAY_RELATIVE, "replay dossier path differs");
  const replayArtifact = await readCanonical(REPLAY_RELATIVE, "append replay dossier", "dossier_hash");
  const replay = asRecord(replayArtifact.value, "append replay dossier");
  assert(dossierReplay.raw_sha256 === replayArtifact.raw_sha256, "replay dossier raw hash differs");
  assert(dossierReplay.dossier_hash === replay.dossier_hash && dossierReplay.recomputed_dossier_hash === selfHash(replay, "dossier_hash"), "replay dossier self-hash binding differs");
  canonicalEqual(dossierReplay.acceptance, replay.acceptance, "replay acceptance binding");
  requireTrueFields(asRecord(replay.acceptance, "replay.acceptance"), Object.keys(replay.acceptance), "replay.acceptance");
  assert(replay.plan.relative_path === dossierPlan.relative_path && replay.plan.raw_sha256 === planArtifact.raw_sha256 && replay.plan.plan_hash === plan.plan_hash && replay.plan.self_hash_valid === true, "replay plan binding differs");
  assert(replay.source_integrity.plan_bytes_modified === false && replay.source_integrity.source_bytes_modified === false && replay.static_runtime.equal === true, "replay source/runtime integrity differs");

  const previewBinding = asRecord(asRecord(asRecord(dossier.evidence, "dossier.evidence").confinement, "dossier.evidence.confinement").pre_execution_preview, "pre-execution preview binding");
  assert(previewBinding.relative_path === PREVIEW_RELATIVE, "pre-execution preview path differs");
  const previewArtifact = await readCanonical(PREVIEW_RELATIVE, "pre-execution preview dossier", "dossier_hash");
  const preview = asRecord(previewArtifact.value, "pre-execution preview dossier");
  assert(previewBinding.raw_sha256 === previewArtifact.raw_sha256 && previewBinding.dossier_hash === preview.dossier_hash, "pre-execution preview hash binding differs");
  assert(preview.preview_contract_ready === true && preview.actual_execution_completion === false && preview.abrain_mutation_by_preview === false, "pre-execution preview status differs");
  assert(preview.plan.relative_path === dossierPlan.relative_path && preview.plan.raw_sha256 === planArtifact.raw_sha256 && preview.plan.plan_hash === plan.plan_hash && preview.plan.drift_registry_hash === plan.drift_registry.registry_hash, "pre-execution preview plan binding differs");
  requireTrueFields(asRecord(preview.verdicts, "preview.verdicts"), FIVE_VERDICTS, "preview.verdicts");

  const executionResult = asRecord(asRecord(dossier.cli, "dossier.cli").execution_result, "dossier.cli.execution_result");
  const executionVerdicts = asRecord(executionResult.verdicts, "execution result verdicts");
  assert(Object.keys(executionVerdicts).sort().join("|") === [...FIVE_VERDICTS].sort().join("|"), "execution result must contain exactly five verdicts");
  requireTrueFields(executionVerdicts, FIVE_VERDICTS, "execution result verdicts");
  assert(executionResult.completion === FIVE_VERDICTS.every((name) => executionVerdicts[name] === true), "execution completion is not the AND of five verdicts");
  assert(executionResult.completion === true && executionResult.target_inert === true, "execution did not complete with an inert target");
  const dossierVerdicts = asRecord(dossier.verdicts, "dossier.verdicts");
  requireTrueFields(dossierVerdicts, ["completion", ...FIVE_VERDICTS, "target_inert", "source_static_plan_unchanged"], "dossier.verdicts");

  const currentInventory = await publication.captureExactFinalInventory(planApi.PROPOSITION_POLICY_PUSH_HARD_ABRAIN);
  validateSha256Fields(currentInventory, "current target inventory");
  canonicalEqual(currentInventory, plan.exact_final_inventory, "current target and plan inventory");
  const targetAfter = asRecord(asRecord(asRecord(dossier.evidence, "dossier.evidence").target, "dossier.evidence.target").after, "dossier target after");
  canonicalEqual(currentInventory, targetAfter.inventory, "current target and dossier inventory");
  const targetInventoryHash = jcs.jcsSha256Hex(currentInventory);
  assert(targetInventoryHash === EXPECTED_TARGET_INVENTORY_HASH && targetAfter.inventory_hash === targetInventoryHash, "current target inventory hash differs");
  assert(targetAfter.exact_plan_inventory_equal === true && targetAfter.no_staging_residue === true && targetAfter.no_unauthorized_siblings === true && targetAfter.state === "complete", "dossier target completion evidence differs");

  const runtimePlan = asRecord(asRecord(plan.proposition_anchors, "plan.proposition_anchors").runtime, "plan runtime anchors");
  const runtimeEvidence = asRecord(asRecord(dossier.evidence, "dossier.evidence").runtime, "dossier runtime evidence");
  const runtimeBefore = asRecord(runtimeEvidence.before, "dossier runtime before");
  const runtimeAfter = asRecord(runtimeEvidence.after, "dossier runtime after");
  assert(plan.deployment.runtime_consumer === false && plan.deployment.authority === "inert_shadow_only", "plan runtime authority is not inert shadow-only");
  assert(runtimePlan.publication_modules_runtime_reachable === false && Array.isArray(runtimePlan.forbidden_publication_reachable_paths) && runtimePlan.forbidden_publication_reachable_paths.length === 0, "publication modules are runtime reachable in the plan");
  assert(runtimeBefore.publication_modules_runtime_reachable === false && runtimeAfter.publication_modules_runtime_reachable === false && runtimeAfter.forbidden_publication_reachable_paths.length === 0, "dossier runtime reachability differs");
  assert(runtimeBefore.runtime_dependency_graph_hash === runtimePlan.extension_dependency_graph_hash && runtimeAfter.runtime_dependency_graph_hash === runtimePlan.extension_dependency_graph_hash, "dossier runtime graph binding differs");
  assert(runtimeBefore.bundle_hash === plan.bundle.bundle_hash && runtimeAfter.bundle_hash === plan.bundle.bundle_hash && runtimeEvidence.inert_shadow_only === true, "dossier runtime bundle or inertness differs");
  assert(dossier.restart.required === false, "inert publication unexpectedly requires restart");

  const sourceInventoryHash = plan.confinement.source_inventory.inventory_hash;
  const sourceStatic = asRecord(asRecord(dossier.evidence, "dossier.evidence").source_static, "dossier source static evidence");
  for (const side of ["before", "after"]) {
    const value = asRecord(sourceStatic[side], `dossier source static ${side}`);
    assert(value.plan_hash === plan.plan_hash && value.plan_raw_sha256 === planArtifact.raw_sha256 && value.source_inventory_hash === sourceInventoryHash, `dossier source static ${side} binding differs`);
  }
  assert(sourceStatic.unchanged === true && sourceStatic.after.static_plan_rebuild_equal === true, "source/static plan was not unchanged");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    validator: "read_only",
    dossier: {
      relative_path: DOSSIER_RELATIVE,
      raw_sha256: dossierArtifact.raw_sha256,
      dossier_hash: dossier.dossier_hash,
    },
    plan: {
      relative_path: dossierPlan.relative_path,
      raw_sha256: planArtifact.raw_sha256,
      plan_hash: plan.plan_hash,
      recomputed_plan_hash: recomputedPlanHash,
      source_inventory_hash: sourceInventoryHash,
      static_plan_rebuild_equal: true,
    },
    reviews: { count: dossierReviews.length, unanimous_sign: true },
    transcript_binding: "verified_by_existing_trusted_session_verifier",
    completion: { value: true, five_verdicts: Object.fromEntries(FIVE_VERDICTS.map((name) => [name, true])) },
    runtime_inert: true,
    target_inventory_hash: targetInventoryHash,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`POST_EXECUTION_DOSSIER_INVALID: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
