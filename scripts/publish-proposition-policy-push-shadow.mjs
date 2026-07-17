#!/usr/bin/env node
/** ADR0040 P2a.2 confined production orchestrator. Default-denied by fixed v2 gates. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));
const live = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-live-publication.ts"));
const plan = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-live-publication-plan.ts"));

async function main() {
  if (process.argv.length !== 2) throw new live.PropositionPolicyPushLivePublicationError("NOT_AUTHORIZED", "the confined production orchestrator accepts no caller paths, force flags, or overrides");
  const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: plan.PROPOSITION_POLICY_PUSH_HARD_ABRAIN, repoRoot, registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json") });
  const result = await live.executeProductionPublicationV2({ repoRoot, bundle });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.completion !== true) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.code || "PROPOSITION_POLICY_PUSH_PUBLICATION_FAILED"}: ${error?.message || String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
});
