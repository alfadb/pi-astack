#!/usr/bin/env node
/** ADR0040 P1a deterministic proposition Knowledge pull shadow builder. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-knowledge-shadow.ts"));
const durable = jiti(path.join(repoRoot, "extensions/_shared/durable-write.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw Object.assign(new Error(`missing required --${name}`), { code: "PROPOSITION_KNOWLEDGE_SHADOW_CLI_USAGE" });
}

function rejectDossierPath(message, detail = {}) {
  throw Object.assign(new Error(message), { code: "PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_PATH_REJECTED", detail });
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertExistingDirectoryChainNoSymlink(base, target) {
  const root = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(root, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) rejectDossierPath("dossier directory chain escapes trusted base", { root, target: resolvedTarget });
  let current = root;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); } catch (err) {
      rejectDossierPath("dossier directory chain must already exist", { current, error: err?.code || String(err) });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) rejectDossierPath("dossier directory chain must not contain symlinks or non-directories", { current });
  }
}

function validateDossierOutputPath(dossierArg, abrainHome) {
  if (!path.isAbsolute(dossierArg) || path.resolve(dossierArg) !== dossierArg) {
    rejectDossierPath("--dossier must be a canonical absolute path under repo docs/evidence", { dossierArg });
  }
  const outputPath = dossierArg;
  const evidenceDir = path.join(repoRoot, "docs", "evidence");
  assertExistingDirectoryChainNoSymlink(path.parse(evidenceDir).root, evidenceDir);
  const evidenceReal = fs.realpathSync(evidenceDir);
  if (evidenceReal !== evidenceDir || path.dirname(outputPath) !== evidenceDir) {
    rejectDossierPath("--dossier must be a direct file under the real repo docs/evidence directory", { outputPath, evidenceDir, evidenceReal });
  }
  if (path.extname(outputPath) !== ".json") rejectDossierPath("--dossier must name a .json evidence file", { outputPath });

  const abrainCandidates = new Set([path.resolve(abrainHome), "/home/worker/.abrain"]);
  for (const candidate of [...abrainCandidates]) {
    try { abrainCandidates.add(fs.realpathSync(candidate)); } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  for (const candidate of abrainCandidates) {
    if (pathInside(candidate, outputPath)) rejectDossierPath("--dossier must not be inside abrain", { outputPath, abrain: candidate });
  }

  let leaf = null;
  try { leaf = fs.lstatSync(outputPath); } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (leaf?.isSymbolicLink()) rejectDossierPath("--dossier leaf symlinks are forbidden", { outputPath });
  if (leaf && !leaf.isFile()) rejectDossierPath("--dossier must be absent or an existing regular file eligible only for exact-identical idempotence", { outputPath });
  return {
    path: outputPath,
    repoRelativePath: path.relative(repoRoot, outputPath).split(path.sep).join("/"),
  };
}

async function main() {
  const abrainHome = path.resolve(arg("abrain"));
  const registryPath = path.resolve(arg("registry", path.join(repoRoot, "schemas/l1-schema-role-registry.json")));
  const runtimeConfigPath = path.resolve(arg("runtime-config", path.join(repoRoot, "..", "..", "pi-astack-settings.json")));
  const dossierArg = process.argv.some((value) => value === "--dossier" || value.startsWith("--dossier=")) ? arg("dossier") : null;
  const requestedDossierOutput = dossierArg ? validateDossierOutputPath(dossierArg, abrainHome) : null;
  const result = await shadow.runPropositionKnowledgeShadowP1a({
    abrainHome,
    repoRoot,
    registryPath,
    runtimeConfigPath,
    dossierOutput: requestedDossierOutput ? { repoRelativePath: requestedDossierOutput.repoRelativePath } : undefined,
  });
  let dossierOutput = null;
  if (requestedDossierOutput) {
    const beforeWriteOutput = validateDossierOutputPath(requestedDossierOutput.path, abrainHome);
    const dossierBytes = shadow.canonicalPropositionKnowledgeShadowDossierJson(result.dossier);
    const status = await durable.durableAtomicCreateFile(beforeWriteOutput.path, dossierBytes, { mode: 0o600 });
    if (status === "collision") throw Object.assign(new Error("dossier target exists with different bytes; only exact-identical idempotence is allowed"), { code: "PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_COLLISION" });
    const afterWriteOutput = validateDossierOutputPath(beforeWriteOutput.path, abrainHome);
    const readBack = fs.readFileSync(afterWriteOutput.path, "utf8");
    if (readBack !== dossierBytes) throw Object.assign(new Error("dossier readback differs"), { code: "PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_READBACK" });
    dossierOutput = {
      path: requestedDossierOutput.path,
      repo_relative_path: requestedDossierOutput.repoRelativePath,
      status,
      exact_bytes_sha256: jcs.sha256Hex(dossierBytes),
      dossier_hash: result.dossier.dossier_hash,
      mutation_domain: "repo_evidence_outside_abrain",
      included_in_abrain_mutation_claim: false,
      write_sequence: "after_abrain_after_snapshot_and_dossier_finalization",
      readback_byte_identical: true,
    };
  }
  process.stdout.write(`${jcs.canonicalizeJcs({
    status: "ok",
    bundle_hash: result.publication.bundle.manifest.bundle_hash,
    bundle_status: result.publication.bundle_status,
    latest_status: result.publication.latest_status,
    card_count: result.publication.bundle.manifest.result.card_count,
    exclusion_count: result.publication.bundle.manifest.result.exclusion_count,
    diagnostic_count: result.publication.bundle.manifest.result.diagnostic_count,
    disposition_reason: result.publication.bundle.manifest.result.disposition_reason,
    abrain_mutation_claim: result.dossier.mutation_inventory,
    dossier: dossierOutput,
  })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.code || "PROPOSITION_KNOWLEDGE_SHADOW_CLI_FAILED"}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
