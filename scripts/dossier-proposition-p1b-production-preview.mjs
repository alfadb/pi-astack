#!/usr/bin/env node
/** ADR0040 P1b read-only production evidence preview. Never appends production L1. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const preview = jiti(path.join(repoRoot, "extensions/_shared/proposition-p1b-production-preview.ts"));

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

async function main() {
  if (process.argv.includes("--execute")) {
    throw new preview.PropositionP1bPreviewError("NOT_AUTHORIZED", "P1b production append is not authorized; this CLI is read-only preview only");
  }
  const result = await preview.writePropositionP1bProductionPreview({
    abrainHome: arg("abrain"),
    outputPath: arg("out"),
    registryPath: arg("registry", path.join(repoRoot, "schemas/l1-schema-role-registry.json")),
    repoRoot,
  });
  process.stdout.write(`${JSON.stringify({ ...result.dossier, dossier_file_raw_sha256: result.raw_sha256, dossier_write_status: result.status }, null, process.argv.includes("--compact") ? 0 : 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.code || "PROPOSITION_P1B_PREVIEW_FAILED"}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
