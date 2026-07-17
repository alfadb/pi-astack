#!/usr/bin/env node
/** ADR0040 P0a repo-only proposition schema/registry/validator smoke. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const prop = jiti(path.join(repoRoot, "extensions/_shared/proposition.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function expectCode(code, fn) {
  let caught;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(caught, `expected ${code}, but operation succeeded`);
  assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  return caught;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-proposition-p0a-${label}-`));
}

function producer() {
  return { name: prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: "p0a-smoke" };
}

function genesisBody(overrides = {}) {
  return {
    event_schema_version: prop.PROPOSITION_GENESIS_BODY_SCHEMA,
    event_type: "proposition_genesis_declared",
    producer: producer(),
    epoch: { epoch_id: "adr0040-p0a-smoke-epoch", genesis_scope: "schema_contract" },
    contract: {
      kind: "schema_contract",
      cutover_policy: "no_migration",
      production_genesis_required: true,
      p0_effect: "defined_inactive_only",
      legacy_domains: ["rules", "constraint", "knowledge"],
      notes: "P0a defines repo-side contracts only; production genesis is P0b.",
    },
    ...overrides,
  };
}

function facets(genesisEventId, causalParents = []) {
  return {
    provenance_authority: {
      source_kind: "user",
      authority_kind: "user_attested",
      source_event_id: null,
      quote_sha256: null,
    },
    spatial_scope: {
      scope_level: "project",
      project_id: "pi-astack",
      domain: "proposition",
    },
    temporal_horizon: {
      horizon: "durable",
      valid_from: null,
      valid_until: null,
    },
    trigger: {
      trigger_kind: "user_directive",
      trigger_ref: "adr0040-p0a-smoke",
    },
    maturity: {
      state: "accepted",
      review_state: "reviewed",
    },
    contestability: {
      status: "uncontested",
      counterevidence_event_ids: [],
    },
    confidence: {
      score: 1,
      basis: "witnessed",
    },
    sensitivity: {
      classification: "public",
      handling: "none",
    },
    consumer_hints: {
      retrieval: true,
      policy: true,
      notes: ["consumer-specific projection remains future work"],
    },
    lineage: {
      causal_parents: causalParents,
      derives_from: [genesisEventId],
      supersedes: [],
    },
  };
}

function evidenceBody(genesisEventId, overrides = {}) {
  return {
    event_schema_version: prop.PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: producer(),
    epoch: { epoch_id: "adr0040-p0a-smoke-epoch", genesis_event_id: genesisEventId },
    proposition: {
      modality: "normative",
      statement: "P0a proposition schemas are defined but inactive.",
      language: "en",
    },
    facets: facets(genesisEventId, [genesisEventId]),
    ...overrides,
  };
}

function lifecycleBody(operation, targetEventId, genesisEventId, overrides = {}) {
  const eventType = {
    retract: "proposition_retract_declared",
    rescope: "proposition_rescope_declared",
    supersede: "proposition_supersede_declared",
    archive: "proposition_archive_declared",
    reactivate: "proposition_reactivate_declared",
    cutover: "proposition_cutover_declared",
  }[operation];
  const parents = operation === "cutover" ? [] : [targetEventId];
  return {
    event_schema_version: prop.PROPOSITION_LIFECYCLE_BODY_SCHEMA,
    event_type: eventType,
    producer: producer(),
    epoch: { epoch_id: "adr0040-p0a-smoke-epoch", genesis_event_id: genesisEventId },
    lifecycle: {
      operation,
      modality: "meta-lifecycle",
      effect: "declared_only",
      target_event_ids: operation === "cutover" ? [] : [targetEventId],
      reason: `${operation} contract shape smoke`,
    },
    facets: facets(genesisEventId, parents),
    ...overrides,
  };
}

function activeBody(kind, overrides = {}) {
  if (kind === "knowledge") {
    return {
      event_schema_version: "knowledge-evidence-event/v1",
      event_type: "knowledge_entry_observed",
      intent: { domain_hint: "knowledge", operation_hint: "create" },
      producer: { name: "sediment.knowledge-event-writer", version: "smoke" },
      fixture: "knowledge",
      ...overrides,
    };
  }
  if (kind === "constraint-evidence") {
    return {
      event_schema_version: "constraint-evidence-event/v1",
      event_type: "constraint_signal_observed",
      intent: { domain_hint: "constraint", operation_hint: "create" },
      producer: { name: "sediment.constraint-event-writer", version: "smoke" },
      fixture: "constraint-evidence",
      ...overrides,
    };
  }
  return {
    event_schema_version: "constraint-projection-event/v1",
    event_type: "constraint_compiled_view_produced",
    producer: { name: "sediment.constraint-compiler", version: "smoke" },
    fixture: "constraint-projection",
    ...overrides,
  };
}

function envelopeFor(schema, body) {
  const bodyHash = l1.canonicalL1BodyHash(body);
  return {
    schema,
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

function standardEnvelopes() {
  return [
    envelopeFor("knowledge-evidence-envelope/v1", activeBody("knowledge")),
    envelopeFor("constraint-evidence-envelope/v1", activeBody("constraint-evidence")),
    envelopeFor("constraint-projection-envelope/v1", activeBody("constraint-projection")),
  ];
}

function writeEnvelope(abrainHome, envelope, relativePath = l1.expectedL1EventRelativePath(envelope.event_id)) {
  const file = path.join(abrainHome, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, "utf8");
  return file;
}

function walkFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkFiles(full, output);
    else output.push(full);
  }
  return output;
}

console.log("ADR0040 P0a proposition schema/registry smoke");

await check("registry stays backward-compatible and adds only disabled proposition declarations", () => {
  const registry = l1.loadL1SchemaRegistry();
  const activeNames = l1.lookupL1SchemaRoles(registry, { phase: "active" }).map((entry) => entry.envelope_schema).sort();
  assert(JSON.stringify(activeNames) === JSON.stringify([
    "constraint-evidence-envelope/v1",
    "constraint-projection-envelope/v1",
    "knowledge-evidence-envelope/v1",
    "local-drain-recovery-envelope/v2",
  ]), `active schemas changed: ${JSON.stringify(activeNames)}`);
  const defined = l1.lookupL1SchemaRoles(registry, { domain: "proposition", phase: "defined_inactive" });
  assert(defined.length === 3, `defined-inactive proposition count=${defined.length}`);
  for (const entry of defined) {
    assert(entry.write_enabled === false && entry.fold_eligible === false, `${entry.envelope_schema} became writable/foldable`);
    assert(entry.body_schema && entry.event_types?.length && entry.producers?.includes(prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER), `${entry.envelope_schema} missing full contract`);
  }
  const evidence = l1.resolveL1EnvelopeSchema(registry, "proposition-evidence-envelope/v1");
  assert(JSON.stringify(evidence.producers) === JSON.stringify([
    prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER,
    "pi-astack.proposition-production-evidence-writer",
  ]), `evidence producer allowlist drifted: ${JSON.stringify(evidence.producers)}`);
  const lifecycle = l1.resolveL1EnvelopeSchema(registry, "proposition-lifecycle-envelope/v1");
  assert(JSON.stringify(lifecycle.producers) === JSON.stringify([prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER]), "lifecycle producer allowlist changed");
  const projection = l1.resolveL1EnvelopeSchema(registry, "proposition-projection-envelope/v1");
  assert(projection.phase === "phase_disabled" && !projection.body_schema && !projection.write_enabled && !projection.fold_eligible, "projection placeholder froze a P2 body or became active");
});

await check("defined_inactive registry combinations fail closed", async () => {
  const registry = clone(l1.loadL1SchemaRegistry());
  registry.entries.find((entry) => entry.envelope_schema === "proposition-evidence-envelope/v1").write_enabled = true;
  await expectCode("L1_REGISTRY_INVALID", () => l1.validateL1SchemaRegistry(registry));

  const foldable = clone(l1.loadL1SchemaRegistry());
  foldable.entries.find((entry) => entry.envelope_schema === "proposition-lifecycle-envelope/v1").fold_eligible = true;
  await expectCode("L1_REGISTRY_INVALID", () => l1.validateL1SchemaRegistry(foldable));

  const incomplete = clone(l1.loadL1SchemaRegistry());
  delete incomplete.entries.find((entry) => entry.envelope_schema === "proposition-genesis-envelope/v1").producers;
  await expectCode("L1_REGISTRY_INVALID", () => l1.validateL1SchemaRegistry(incomplete));

  const disabledWithBody = clone(l1.loadL1SchemaRegistry());
  disabledWithBody.entries.find((entry) => entry.envelope_schema === "proposition-projection-envelope/v1").body_schema = "proposition-projection-event/v1";
  await expectCode("L1_REGISTRY_INVALID", () => l1.validateL1SchemaRegistry(disabledWithBody));
});

await check("proposition envelope roundtrips through JCS/hash and L1 validation", () => {
  const registry = l1.loadL1SchemaRegistry();
  const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
  const evidence = prop.buildPropositionEnvelope(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(genesis.event_id));
  const canonical = prop.canonicalPropositionEnvelopeJson(evidence);
  assert(canonical === `${jcs.canonicalizeJcs(evidence)}\n`, "proposition canonical envelope JSON does not use shared JCS");
  assert(evidence.event_id === evidence.body_hash && evidence.event_id === l1.canonicalL1BodyHash(evidence.body), "event/body hash mismatch");
  const validatedGenesis = l1.validateL1Envelope(genesis, { registry });
  const validatedEvidence = l1.validateL1Envelope(evidence, { registry });
  assert(validatedGenesis.registration.phase === "defined_inactive", "genesis registration became active");
  assert(validatedEvidence.registration.domain === "proposition" && validatedEvidence.registration.role === "evidence", "evidence role mismatch");
});

await check("proposition write preflight is disabled by default", async () => {
  const home = tempHome("preflight");
  try {
    const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
    const evidence = prop.buildPropositionEnvelope(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(genesis.event_id));
    const target = l1.expectedL1EventPath(home, evidence.event_id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await expectCode("L1_SCHEMA_WRITE_DISABLED", () => l1.validateL1WritePreflight({
      abrainHome: home,
      envelope: evidence,
      targetPath: target,
      expected: { domain: "proposition", role: "evidence", producer: prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER },
    }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("projection placeholder write preflight is disabled", async () => {
  const home = tempHome("projection-preflight");
  try {
    const projection = envelopeFor("proposition-projection-envelope/v1", { placeholder: "phase-disabled" });
    const target = l1.expectedL1EventPath(home, projection.event_id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await expectCode("L1_SCHEMA_WRITE_DISABLED", () => l1.validateL1WritePreflight({
      abrainHome: home,
      envelope: projection,
      targetPath: target,
      expected: { domain: "proposition", role: "meta" },
    }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("registered proposition producer mismatch fails closed", async () => {
  const registry = l1.loadL1SchemaRegistry();
  const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
  const badProducer = evidenceBody(genesis.event_id, { producer: { name: "pi-astack.unregistered-producer", version: "smoke" } });
  const envelope = envelopeFor(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, badProducer);
  await expectCode("L1_PRODUCER_MISMATCH", () => l1.validateL1Envelope(envelope, { registry }));
});

await check("forbidden projector-derived fields are rejected as canonical proposition fields", async () => {
  const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
  const badInjectMode = evidenceBody(genesis.event_id, { injectMode: "always" });
  await expectCode("PROPOSITION_FORBIDDEN_CANONICAL_FIELD", () => prop.validatePropositionEvidenceBody(badInjectMode));
  const badPriority = evidenceBody(genesis.event_id);
  badPriority.facets.consumer_hints.priority = 1;
  await expectCode("PROPOSITION_FORBIDDEN_CANONICAL_FIELD", () => prop.validatePropositionEvidenceBody(badPriority));
  const badSessionStart = evidenceBody(genesis.event_id);
  badSessionStart.facets.consumer_hints.session_start_eligibility = true;
  await expectCode("PROPOSITION_FORBIDDEN_CANONICAL_FIELD", () => prop.validatePropositionEvidenceBody(badSessionStart));
});

await check("facet orthogonality is structural and fail-closed", async () => {
  const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
  const missingFacet = evidenceBody(genesis.event_id);
  delete missingFacet.facets.contestability;
  await expectCode("PROPOSITION_FACET_INVALID", () => prop.validatePropositionEvidenceBody(missingFacet));

  const mixedFacet = evidenceBody(genesis.event_id);
  mixedFacet.facets.confidence.scope_level = "global";
  await expectCode("PROPOSITION_FACET_INVALID", () => prop.validatePropositionEvidenceBody(mixedFacet));

  const topLevelAuthority = evidenceBody(genesis.event_id, { authority_kind: "user_attested" });
  await expectCode("PROPOSITION_FACET_INVALID", () => prop.validatePropositionEvidenceBody(topLevelAuthority));
});

await check("temporal facets require strict RFC3339 UTC timestamps", async () => {
  const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
  const valid = evidenceBody(genesis.event_id);
  valid.facets.temporal_horizon.valid_from = "2026-07-12T00:00:00Z";
  valid.facets.temporal_horizon.valid_until = "2026-07-13T00:00:00.000Z";
  prop.validatePropositionEvidenceBody(valid);

  for (const timestamp of ["2026", "2026-07-12", "2026-07-12T00:00:00+08:00", "2026-02-30T00:00:00Z"]) {
    const invalid = evidenceBody(genesis.event_id);
    invalid.facets.temporal_horizon.valid_from = timestamp;
    await expectCode("PROPOSITION_BODY_INVALID", () => prop.validatePropositionEvidenceBody(invalid));
  }
});

await check("lifecycle grammar validates parents and remains declared-only", async () => {
  const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
  const evidence = prop.buildPropositionEnvelope(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(genesis.event_id));
  for (const operation of ["retract", "rescope", "supersede", "archive", "reactivate"]) {
    prop.validatePropositionLifecycleBody(lifecycleBody(operation, evidence.event_id, genesis.event_id));
  }
  prop.validatePropositionLifecycleBody(lifecycleBody("cutover", evidence.event_id, genesis.event_id));

  const noParent = lifecycleBody("retract", evidence.event_id, genesis.event_id);
  noParent.facets.lineage.causal_parents = [];
  await expectCode("PROPOSITION_LIFECYCLE_PARENT_REQUIRED", () => prop.validatePropositionLifecycleBody(noParent));

  const wrongParent = lifecycleBody("supersede", evidence.event_id, genesis.event_id);
  wrongParent.facets.lineage.causal_parents = [genesis.event_id];
  await expectCode("PROPOSITION_LIFECYCLE_TARGET_PARENT_MISMATCH", () => prop.validatePropositionLifecycleBody(wrongParent));

  const cutoverWithTarget = lifecycleBody("cutover", evidence.event_id, genesis.event_id);
  cutoverWithTarget.lifecycle.target_event_ids = [evidence.event_id];
  cutoverWithTarget.facets.lineage.causal_parents = [evidence.event_id];
  await expectCode("PROPOSITION_LIFECYCLE_TARGET_PARENT_MISMATCH", () => prop.validatePropositionLifecycleBody(cutoverWithTarget));

  const fakeEffect = lifecycleBody("archive", evidence.event_id, genesis.event_id);
  fakeEffect.lifecycle.effect = "applied";
  await expectCode("PROPOSITION_BODY_INVALID", () => prop.validatePropositionLifecycleBody(fakeEffect));

  const badParentShape = lifecycleBody("rescope", evidence.event_id, genesis.event_id);
  badParentShape.facets.lineage.causal_parents = ["not-a-sha"];
  await expectCode("PROPOSITION_EVENT_ID_INVALID", () => prop.validatePropositionLifecycleBody(badParentShape));
});

await check("genesis contract defines no-migration identity boundary without production genesis", async () => {
  const body = genesisBody();
  const envelope = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, body);
  assert(envelope.body.epoch.epoch_id === "adr0040-p0a-smoke-epoch", "epoch id not explicit");
  assert(envelope.event_id.length === 64, "genesis event id must be content-addressed");
  assert(envelope.body.epoch.genesis_scope === "schema_contract", "P0a genesis scope drifted");
  assert(envelope.body.contract.kind === "schema_contract", "P0a genesis kind drifted");
  assert(envelope.body.contract.cutover_policy === "no_migration", "cutover policy drifted");
  assert(envelope.body.contract.production_genesis_required === true, "P0a must leave production genesis to P0b");
  const invalid = genesisBody({ contract: { ...body.contract, production_genesis_required: false } });
  await expectCode("PROPOSITION_BODY_INVALID", () => prop.validatePropositionGenesisBody(invalid));
  const schemaProductionMismatch = genesisBody({ epoch: { ...body.epoch, genesis_scope: "production" } });
  await expectCode("PROPOSITION_GENESIS_SCOPE_MISMATCH", () => prop.validatePropositionGenesisBody(schemaProductionMismatch));
  const productionSchemaMismatch = genesisBody({ contract: { ...body.contract, kind: "production_genesis" } });
  await expectCode("PROPOSITION_GENESIS_SCOPE_MISMATCH", () => prop.validatePropositionGenesisBody(productionSchemaMismatch));
});

await check("whole-L1 synthetic fixture keeps proposition unselected and old fold set unchanged", async () => {
  const home = tempHome("scan");
  try {
    const old = standardEnvelopes();
    for (const envelope of old) writeEnvelope(home, envelope);
    const before = await l1.scanWholeL1Validated({ abrainHome: home });
    const beforeSelected = before.selected.map((record) => record.eventId).sort();
    const beforeFoldable = before.foldable.map((record) => record.eventId).sort();

    const genesis = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, genesisBody());
    const evidence = prop.buildPropositionEnvelope(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(genesis.event_id));
    const lifecycle = prop.buildPropositionEnvelope(prop.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, lifecycleBody("archive", evidence.event_id, genesis.event_id));
    for (const envelope of [genesis, evidence, lifecycle]) writeEnvelope(home, envelope);

    const after = await l1.scanWholeL1Validated({ abrainHome: home });
    assert(JSON.stringify(after.selected.map((record) => record.eventId).sort()) === JSON.stringify(beforeSelected), "defined-inactive proposition changed selected set");
    assert(JSON.stringify(after.foldable.map((record) => record.eventId).sort()) === JSON.stringify(beforeFoldable), "defined-inactive proposition changed foldable set");
    assert(after.definedInactiveShadow.length === 3, `definedInactiveShadow=${after.definedInactiveShadow.length}`);
    const propositionOnly = await l1.scanWholeL1Validated({ abrainHome: home, domains: ["proposition"] });
    assert(propositionOnly.selected.length === 0 && propositionOnly.foldable.length === 0, "proposition selector selected inactive events");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("legacy knowledge/constraint/projection events are outside proposition selector", async () => {
  const home = tempHome("no-migration");
  try {
    for (const envelope of standardEnvelopes()) writeEnvelope(home, envelope);
    const scan = await l1.scanWholeL1Validated({ abrainHome: home, domains: ["proposition"] });
    assert(scan.selected.length === 0 && scan.foldable.length === 0, "legacy events were selected by proposition domain");
    assert(scan.foreignSkipped.length === 3, `foreignSkipped=${scan.foreignSkipped.length}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("real L1 read-only scan has zero selected proposition records", async () => {
  const abrainHome = process.env.ABRAIN_HOME || path.join(os.homedir(), ".abrain");
  if (!fs.existsSync(abrainHome)) {
    console.log(`        SKIP: ${abrainHome} does not exist`);
    return;
  }
  const scan = await l1.scanWholeL1Validated({ abrainHome, domains: ["proposition"] });
  assert(scan.selected.length === 0, `real proposition selected=${scan.selected.length}`);
  assert(scan.foldable.length === 0, `real proposition foldable=${scan.foldable.length}`);
});

await check("legacy surfaces allow only the authorized stable-view reader/audit runtime integration", () => {
  const roots = [
    "extensions/sediment/knowledge-evidence.ts",
    "extensions/sediment/constraint-evidence",
    "extensions/sediment/constraint-compiler",
    "extensions/abrain/rule-injector",
  ];
  const authorized = new Map([
    ["extensions/abrain/rule-injector/index.ts", [
      'from "./proposition-policy-stable-view-reader"',
      'from "./proposition-policy-stable-view-runtime-audit"',
    ]],
    ["extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts", [
      'from "../../_shared/proposition-policy-stable-view-contract"',
    ]],
    ["extensions/abrain/rule-injector/proposition-policy-stable-view-runtime-audit.ts", [
      'from "../../_shared/jcs"',
      'from "./proposition-policy-stable-view-reader"',
    ]],
  ]);
  const authorizedSeen = new Set();
  const offenders = [];
  for (const rel of roots) {
    const full = path.join(repoRoot, rel);
    const files = fs.statSync(full).isDirectory() ? walkFiles(full) : [full];
    for (const file of files) {
      if (!/\.(ts|js|mjs|md)$/.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (!/proposition(?:-|_|\b)/i.test(text)) continue;
      const relative = path.relative(repoRoot, file);
      const requiredReferences = authorized.get(relative);
      if (!requiredReferences) {
        offenders.push(relative);
        continue;
      }
      for (const reference of requiredReferences) assert(text.includes(reference), `${relative} missing authorized reference ${reference}`);
      authorizedSeen.add(relative);
    }
  }
  assert(offenders.length === 0, `unexpected proposition runtime integrations: ${offenders.join(", ")}`);
  assert(JSON.stringify([...authorizedSeen].sort()) === JSON.stringify([...authorized.keys()].sort()), `authorized stable-view integration set differs: ${JSON.stringify([...authorizedSeen].sort())}`);
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
