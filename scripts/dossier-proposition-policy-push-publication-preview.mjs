#!/usr/bin/env node
/** ADR0040 P2a.2.1 real read-only publication-contract preview. Never publishes to abrain. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const preview = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow-publication-preview.ts"));
const publication = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow-publication.ts"));

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

async function main() {
  if (process.argv.includes("--execute") || process.argv.includes("--publish") || process.argv.includes("--force")) {
    throw new preview.PropositionPolicyPushP2a21PreviewError("NOT_AUTHORIZED", "P2a.2.1 is repo contract plus read-only preview only; actual publication is blocked");
  }
  const result = await preview.writePropositionPolicyPushP2a21ProductionPreview({
    abrainHome: arg("abrain", publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME),
    repoRoot,
    outputPath: arg("out", path.join(repoRoot, preview.PROPOSITION_POLICY_PUSH_P2A21_DOSSIER_RELATIVE_PATH)),
    registryPath: arg("registry", path.join(repoRoot, "schemas/l1-schema-role-registry.json")),
  });
  process.stdout.write(`${JSON.stringify({
    dossier_hash: result.dossier.dossier_hash,
    dossier_raw_sha256: result.raw_sha256,
    dossier_write_status: result.status,
    manifest_schema_version: result.dossier.semantic_bundle.manifest_schema_version,
    bundle_hash: result.dossier.semantic_bundle.bundle_hash,
    manifest_sha256: result.dossier.semantic_bundle.manifest_sha256,
    production_result: {
      entries: result.dossier.semantic_bundle.entry_count,
      exclusions: result.dossier.semantic_bundle.exclusion_count,
      diagnostics: result.dossier.semantic_bundle.diagnostic_count,
    },
    target_state: result.dossier.target_observation.after.state,
    whole_abrain_unchanged: result.dossier.mutation_proof.unchanged,
    authoritative_source_closure_hash: result.dossier.authoritative_source_closure.closure_hash,
    authoritative_source_inventory_hash: result.dossier.authoritative_source_closure.executable_source_inventory.inventory_hash,
    actual_publication_status: result.dossier.authorization.actual_publication_status,
    next_required_gate: result.dossier.authorization.next_required_gate,
  }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.code || "PROPOSITION_POLICY_PUSH_P2A21_PREVIEW_FAILED"}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
