#!/usr/bin/env node
/** ADR0040 P2a.1 real read-only policy push shadow preview. Never publishes to abrain or .state. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const preview = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow-preview.ts"));

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

async function main() {
  if (process.argv.includes("--execute") || process.argv.includes("--publish")) {
    throw new preview.PropositionPolicyPushPreviewError("NOT_AUTHORIZED", "P2a.1 is build-only read-only preview; abrain and .state publication are forbidden");
  }
  const result = await preview.writePropositionPolicyPushProductionPreview({
    abrainHome: arg("abrain"),
    outputPath: arg("out", path.join(repoRoot, preview.PROPOSITION_POLICY_PUSH_PREVIEW_DOSSIER_RELATIVE_PATH)),
    registryPath: arg("registry", path.join(repoRoot, "schemas/l1-schema-role-registry.json")),
    runtimeConfigPath: arg("runtime-config", path.join(repoRoot, "..", "..", "pi-astack-settings.json")),
    repoRoot,
  });
  process.stdout.write(`${JSON.stringify({
    dossier_hash: result.dossier.dossier_hash,
    dossier_file_raw_sha256: result.raw_sha256,
    dossier_write_status: result.status,
    bundle_hash: result.dossier.preview.bundle_hash,
    manifest_sha256: result.dossier.preview.manifest_exact_bytes_sha256,
    artifact_rows: result.dossier.preview.artifact_rows,
    result: {
      entry_count: result.dossier.preview.entry_count,
      exclusion_count: result.dossier.preview.exclusion_count,
      diagnostic_count: result.dossier.preview.diagnostic_count,
      source_event_id: result.dossier.preview.production_exclusion.source_event_id,
      reason_code: result.dossier.preview.production_exclusion.reason_code,
    },
    whole_abrain_unchanged: result.dossier.mutation_proof.unchanged,
    next_gate: result.dossier.authorization.p2a2_status,
  }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.code || "PROPOSITION_POLICY_PUSH_PREVIEW_FAILED"}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
