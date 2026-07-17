#!/usr/bin/env node
/** ADR0040 P1b production executor. Fails closed without a fresh exact transcript ratification. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const execute = jiti(path.join(repoRoot, "extensions/_shared/proposition-p1b-production-execute.ts"));

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

async function main() {
  const forbidden = ["--force", "--yes", "--bypass", "--authorization-text"].find((flag) => process.argv.includes(flag));
  if (forbidden) throw new execute.PropositionP1bExecuteError("NOT_AUTHORIZED", `unsupported bypass/raw-text option: ${forbidden}`);
  const dossier = await execute.writePropositionP1bPostExecuteDossier({
    abrainHome: arg("abrain"),
    previewDossierPath: arg("preview-dossier"),
    ratificationRecordPath: arg("ratification-record"),
    outputPath: arg("out"),
    registryPath: arg("registry", path.join(repoRoot, "schemas/l1-schema-role-registry.json")),
    repoRoot,
  });
  process.stdout.write(`${JSON.stringify(dossier, null, process.argv.includes("--compact") ? 0 : 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.code || "PROPOSITION_P1B_EXECUTE_FAILED"}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
