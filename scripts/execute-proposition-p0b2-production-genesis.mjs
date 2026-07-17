#!/usr/bin/env node
/** ADR0040 P0b2 production genesis execute gate. Real append requires a valid ratification record. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const execute = jiti(path.join(repoRoot, "extensions/_shared/proposition-production-execute.ts"));

function arg(name, def = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const dossier = await execute.writeProductionExecuteDossier({
    abrainHome: arg("abrain"),
    previewDossierPath: arg("preview-dossier"),
    ratificationRecordPath: arg("ratification-record"),
    outputPath: arg("out"),
    registryPath: arg("registry", path.join(repoRoot, "schemas/l1-schema-role-registry.json")),
    repoRoot,
  });
  process.stdout.write(`${JSON.stringify(dossier, null, hasFlag("compact") ? 0 : 2)}\n`);
}

main().catch((err) => {
  const code = err?.code || "PROPOSITION_P0B2_EXECUTE_FAILED";
  process.stderr.write(`${code}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
