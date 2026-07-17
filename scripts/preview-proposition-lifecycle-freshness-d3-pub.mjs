#!/usr/bin/env node
/** ADR0040 D3-PUB real-production read-only preview and frozen evidence generator. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertD3PubRuntimeEntryPolicy,
  canonicalizeBuiltinJcs,
  prepareD3PubCleanExecution,
} from "./proposition-lifecycle-freshness-d3-pub-bootstrap.mjs";

assertD3PubRuntimeEntryPolicy();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PREVIEW_MODULE_RELATIVE = "extensions/_shared/proposition-lifecycle-freshness-production-preview.ts";

export async function runD3PubReadOnlyPreview(options = {}) {
  const prepared = prepareD3PubCleanExecution({ repoRoot });
  try {
    const preview = prepared.loadCleanModule(PREVIEW_MODULE_RELATIVE);
    const result = await preview.buildD3PubProductionReadOnlyPreview({ repoRoot, abrainHome: "/home/worker/.abrain", capsule: prepared.capsule });
    const written = preview.writeD3PubPreviewEvidence({ repoRoot, result });
    return Object.freeze({
      schema_version: "adr0040-d3-pub-preview-command-result/v1",
      dossier_hash: result.dossier.dossier_hash,
      plan_hash: result.plan.plan_hash,
      capsule_hash: result.capsule.capsule_hash,
      commit_oid: result.capsule.commit_oid,
      counts: result.plan.artifacts.counts,
      generation: result.plan.generation,
      selection_seq: result.plan.selection_seq,
      production_l1_before_hash: result.productionBefore.production_l1.snapshot_hash,
      production_l1_after_hash: result.productionAfter.production_l1.snapshot_hash,
      publication_roots_before_hash: result.productionBefore.publication_roots.snapshot_hash,
      publication_roots_after_hash: result.productionAfter.publication_roots.snapshot_hash,
      production_unchanged: canonicalizeBuiltinJcs(result.productionBefore) === canonicalizeBuiltinJcs(result.productionAfter),
      production_publisher_called: false,
      fresh_ratification_present: false,
      default_deny: true,
      clean_bootstrap: {
        external_tools_resolved_within_clean_tree: prepared.externalToolResolution.all_resolved_within_clean_tree,
        jiti_entry_relative_path: path.relative(prepared.cleanTree, prepared.externalToolResolution.jiti_entry_resolved_path).split(path.sep).join("/"),
        typescript_entry_relative_path: path.relative(prepared.cleanTree, prepared.externalToolResolution.typescript_entry_resolved_path).split(path.sep).join("/"),
      },
      written,
    });
  } finally {
    prepared.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stderr.write("D3_PUB_PREVIEW_ARGUMENTS_FORBIDDEN: preview accepts no mutation or authorization arguments\n");
    process.exitCode = 1;
  } else {
    runD3PubReadOnlyPreview()
      .then((result) => process.stdout.write(`${canonicalizeBuiltinJcs(result)}\n`))
      .catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
  }
}
