#!/usr/bin/env node
/** ADR0040 P2a.2.2 static publication-plan/v2 generator. Never mutates abrain. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const planApi = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-live-publication-plan.ts"));
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));

async function main() {
  if (process.argv.length !== 2) throw Object.assign(new Error("the exact v2 plan generator accepts no arguments"), { code: "PLAN_V2_ARGUMENTS_FORBIDDEN" });
  if (fs.existsSync(planApi.PROPOSITION_POLICY_PUSH_HARD_TARGET)) throw Object.assign(new Error("the hard production target must be absent for static v2 plan generation"), { code: "PLAN_V2_TARGET_PRESENT" });
  const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: planApi.PROPOSITION_POLICY_PUSH_HARD_ABRAIN, repoRoot, registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json") });
  const result = await planApi.writePublicationPlanV2({ repoRoot, bundle, outputPath: path.join(repoRoot, ...planApi.PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE.split("/")) });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    relative_path: planApi.PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE,
    schema_version: result.plan.schema_version,
    plan_hash: result.plan.plan_hash,
    raw_sha256: result.raw_sha256,
    bundle_hash: result.plan.bundle.bundle_hash,
    drift_registry_hash: result.plan.drift_registry.registry_hash,
    binds_live_whole_abrain_snapshot: false,
    binds_git_head: false,
    historical_v1_raw_sha256: result.plan.historical_v1.raw_sha256,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code || "PLAN_V2_GENERATION_FAILED"}: ${error?.message || String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
});
