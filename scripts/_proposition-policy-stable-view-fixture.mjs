import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

/** Build the exact canonical ADR0040 3-event production shape without reading a live abrain. */
export async function preparePropositionPolicyStableViewFixture(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const abrainHome = path.resolve(options.abrainHome);
  const jiti = createJiti(repoRoot, { interopDefault: true });
  const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
  const genesisWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-genesis-writer.ts"));
  const evidenceWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-evidence-writer.ts"));
  const policyWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-real-policy-append-writer.ts"));
  const registryPath = path.join(repoRoot, "schemas", "l1-schema-role-registry.json");

  fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
  const genesis = await genesisWriter.prepareFixedProductionPropositionGenesisTuple({ abrainHome, registryPath });
  const evidence = evidenceWriter.buildFixedProductionPropositionEvidenceEnvelope();
  const policy = policyWriter.fixedRealPolicyAppendTuple().envelope;
  const envelopes = options.includePolicy === false ? [genesis.envelope, evidence] : [genesis.envelope, evidence, policy];
  for (const envelope of envelopes) {
    const file = l1.expectedL1EventPath(abrainHome, envelope.event_id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, l1.canonicalL1EnvelopeJson(envelope), { encoding: "utf8", mode: 0o600 });
  }
  if (options.createSedimentRoot !== false) {
    fs.mkdirSync(path.join(abrainHome, ".state", "sediment"), { recursive: true, mode: 0o700 });
  }
  return Object.freeze({
    abrainHome,
    eventIds: Object.freeze(envelopes.map((envelope) => envelope.event_id).sort()),
    genesisEventId: genesis.event_id,
    policyEventId: options.includePolicy === false ? undefined : policy.event_id,
  });
}
