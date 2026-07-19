#!/usr/bin/env node
/** Rebuild/verify R4.1 live dossier and frozen production read-only preview. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const r4 = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts"));
const evidence = jiti(path.join(repoRoot, r4.D3_V2_R4_EVIDENCE_MODULE));

const argv = process.argv.slice(2);
const write = argv[0] === "--write";
const verify = argv[0] === "--verify";
if (argv.length > 1 || (argv.length === 1 && !write && !verify)) throw new Error("usage: dossier [--write|--verify]");

const dossierPath = path.join(repoRoot, r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE);
const previewPath = path.join(repoRoot, r4.D3_V2_R4_PREVIEW_RELATIVE);
const settingsBeforeBuild = write ? fs.readFileSync(r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH) : null;
const rebuilt = verify ? null : evidence.buildD3V2R4LiveEvidence(repoRoot);

if (write) {
  const settingsAfterBuild = fs.readFileSync(r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH);
  const beforeHash = sha256(settingsBeforeBuild);
  const afterHash = sha256(settingsAfterBuild);
  if (!settingsBeforeBuild.equals(settingsAfterBuild) || beforeHash !== rebuilt.dossier.settings.pre_identity.raw_sha256 || afterHash !== beforeHash) {
    throw new Error(`live settings drifted during evidence rebuild; refusing to overwrite dossier/preview (before=${beforeHash} after=${afterHash})`);
  }
  fs.writeFileSync(dossierPath, rebuilt.dossierRaw, { encoding: "utf8", mode: 0o644 });
  fs.writeFileSync(previewPath, rebuilt.previewRaw, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ written: [dossierPath, previewPath], revision: r4.D3_V2_R4_REVISION, dossier_hash: rebuilt.dossier.dossier_hash, preview_hash: rebuilt.preview.preview_hash, operator_manifest_hash: rebuilt.preview.operator_manifest_hash, authorization_status: "NOT_AUTHORIZED" })}\n`);
} else if (verify) {
  const verified = evidence.loadVerifiedD3V2R4ProductionEvidence(repoRoot, { mode: "preview" });
  process.stdout.write(`${JSON.stringify({ verified: true, revision: r4.D3_V2_R4_REVISION, dossier_hash: verified.preview.dossier.self_hash, preview_hash: verified.preview.preview_hash, operator_manifest_hash: verified.preview.operator_manifest_hash, authorization_status: "NOT_AUTHORIZED" })}\n`);
} else {
  process.stdout.write(rebuilt.dossierRaw);
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}
