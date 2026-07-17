#!/usr/bin/env node
/** ADR0040 P2a.2.2 real production read-only live-system preview. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const api = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-live-publication.ts"));
const durable = jiti(path.join(repoRoot, "extensions/_shared/durable-write.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));
const planApi = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-live-publication-plan.ts"));

async function main() {
  if (process.argv.length !== 2) throw Object.assign(new Error("the exact production preview accepts no arguments"), { code: "P2A22_PREVIEW_ARGUMENTS_FORBIDDEN" });
  const preview = await api.buildProductionReadOnlyPreview({ repoRoot, abrainHome: planApi.PROPOSITION_POLICY_PUSH_HARD_ABRAIN });
  const dossier = api.finalizeDossier(preview);
  const output = path.join(repoRoot, ...api.PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_RELATIVE.split("/"));
  const raw = `${jcs.canonicalizeJcs(dossier)}\n`;
  const status = await durable.durableAtomicCreateFile(output, raw, { mode: 0o644 });
  if (status === "collision") throw Object.assign(new Error("authoritative dossier path contains different bytes"), { code: "P2A22_DOSSIER_COLLISION" });
  process.stdout.write(`${JSON.stringify({
    status,
    relative_path: api.PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_RELATIVE,
    dossier_hash: dossier.dossier_hash,
    raw_sha256: jcs.sha256Hex(raw),
    plan_hash: dossier.plan.plan_hash,
    plan_raw_sha256: dossier.plan.raw_sha256,
    drift_registry_hash: dossier.plan.drift_registry_hash,
    total_live_suffix_bytes: dossier.drift.total_suffix_bytes,
    append_liveness_observed: dossier.drift.append_liveness_observed,
    protected_equal_without_whole_tree_gate: dossier.protected.equal,
    target_after: dossier.target.after,
    verdicts: dossier.verdicts,
    actual_publication: dossier.authorization.actual_publication,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code || "P2A22_PREVIEW_FAILED"}: ${error?.message || String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
});
