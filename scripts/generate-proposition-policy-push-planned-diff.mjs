#!/usr/bin/env node
/** ADR0040 P2a.2 canonical production planned-diff generator. Never publishes or writes abrain. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const evidence = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-publication-evidence.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));
const publication = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow-publication.ts"));
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));

const EXPECTED_BUNDLE_HASH = "dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0";
const EXPECTED_RELATIVE_PATH = `docs/evidence/adr0040-p2a2-publication-review-${EXPECTED_BUNDLE_HASH}/planned-publication-diff.json`;

function fail(code, message, detail) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.detail = detail;
  throw error;
}

function assertUnchanged(before, after, code) {
  const diff = publication.diffPublicationInventory(before.rows, after.rows);
  if (before.summary.snapshot_hash !== after.summary.snapshot_hash
    || diff.created.length || diff.modified.length || diff.removed.length) {
    fail(code, "whole production abrain changed during planned-diff generation", {
      before: before.summary.snapshot_hash,
      after: after.summary.snapshot_hash,
      diff,
    });
  }
}

async function requireAbsentTarget() {
  const observation = await publication.previewProductionPublicationTarget({
    abrainHome: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME,
  });
  if (observation.target_root !== publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET
    || observation.target_relative_name !== publication.PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE
    || observation.state !== "absent"
    || observation.ancestor_chain_safe !== true
    || observation.read_only !== true) {
    fail("PLANNED_DIFF_TARGET_NOT_ABSENT", "exact production publication target must be safely absent", { observation });
  }
  return observation;
}

async function main() {
  if (process.argv.length !== 2) fail("PLANNED_DIFF_ARGUMENTS_FORBIDDEN", "this exact production generator accepts no arguments");
  const abrainHome = publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME;
  if (path.resolve(abrainHome) !== "/home/worker/.abrain") fail("PLANNED_DIFF_HARD_ROOT_DRIFT", "hard production abrain root drifted");
  if (evidence.publicationPlannedDiffRelative(EXPECTED_BUNDLE_HASH) !== EXPECTED_RELATIVE_PATH) {
    fail("PLANNED_DIFF_PATH_DRIFT", "content-addressed planned-diff path drifted");
  }

  const targetBefore = await requireAbsentTarget();
  const before = await publication.capturePublicationWholeSnapshot(abrainHome);
  const bundle = await shadow.buildPropositionPolicyPushShadow({
    abrainHome,
    repoRoot,
    registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json"),
  });
  shadow.validatePropositionPolicyPushBundle(bundle);
  if (bundle.manifest.bundle_hash !== EXPECTED_BUNDLE_HASH) {
    fail("PLANNED_DIFF_BUNDLE_DRIFT", "current production semantic bundle is not the authorized review bundle", {
      expected: EXPECTED_BUNDLE_HASH,
      actual: bundle.manifest.bundle_hash,
    });
  }
  const captured = await publication.capturePublicationWholeSnapshot(abrainHome);
  assertUnchanged(before, captured, "PLANNED_DIFF_SOURCE_DRIFT");
  await requireAbsentTarget();

  const plan = evidence.buildPlannedPublicationDiff({
    abrainHome,
    targetRelativeName: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
    bundle,
    snapshot: captured,
  });
  evidence.validatePlannedPublicationDiff(plan, {
    bundle,
    abrainHome,
    targetRelativeName: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
  });
  const status = await evidence.writePublicationEvidenceArtifact(repoRoot, EXPECTED_RELATIVE_PATH, plan);

  const outputPath = path.join(repoRoot, ...EXPECTED_RELATIVE_PATH.split("/"));
  const raw = await fs.readFile(outputPath);
  const parsed = JSON.parse(raw.toString("utf8"));
  const expectedRaw = Buffer.from(`${jcs.canonicalizeJcs(plan)}\n`, "utf8");
  if (!raw.equals(expectedRaw) || jcs.canonicalizeJcs(parsed) !== jcs.canonicalizeJcs(plan)) {
    fail("PLANNED_DIFF_READBACK", "durable artifact is not the exact canonical generated plan");
  }
  evidence.validatePlannedPublicationDiff(parsed, {
    bundle,
    abrainHome,
    targetRelativeName: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE,
  });

  const after = await publication.capturePublicationWholeSnapshot(abrainHome);
  assertUnchanged(before, after, "PLANNED_DIFF_ABRAIN_MUTATION");
  const targetAfter = await requireAbsentTarget();
  process.stdout.write(`${JSON.stringify({
    status,
    relative_path: EXPECTED_RELATIVE_PATH,
    planned_diff_sha256: parsed.planned_diff_sha256,
    raw_sha256: jcs.sha256Hex(raw),
    snapshot_hash: captured.summary.snapshot_hash,
    expected_final_created_inventory: parsed.exact_final_mutation_inventory.created,
    production_proof: {
      whole_abrain_unchanged: true,
      before_snapshot_hash: before.summary.snapshot_hash,
      after_snapshot_hash: after.summary.snapshot_hash,
      target_before: targetBefore.state,
      target_after: targetAfter.state,
    },
  }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.code || "PLANNED_DIFF_GENERATION_FAILED"}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
