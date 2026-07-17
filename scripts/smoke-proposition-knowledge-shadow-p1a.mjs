#!/usr/bin/env node
/** ADR0040 P1a proposition Knowledge pull shadow foundation smoke. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const prop = jiti(path.join(repoRoot, "extensions/_shared/proposition.ts"));
const genesisWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-genesis-writer.ts"));
const resolver = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-resolver.ts"));
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-knowledge-shadow.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const EXPECTED_REGISTRY_FILE_SHA256 = "1780f3745fbe251a10ae797f23106290f7df70c13a979514ac0bbb2a3f30246d";
const EXPECTED_PROPOSITION_FILE_SHA256 = "e08efd8f6ec9a9f4668cf36df81d421841dae19603c61c6ee52c42f3ac743766";
const registryPath = path.join(repoRoot, "schemas/l1-schema-role-registry.json");
const propositionPath = path.join(repoRoot, "extensions/_shared/proposition.ts");
const runtimeConfigPath = path.join(path.dirname(repoRoot), "pi-astack-settings.json");
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
  try { await fn(); } catch (err) { caught = err; }
  assert(caught, `expected ${code}, operation succeeded`);
  assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  return caught;
}

function tempHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-proposition-p1a-${label}-`));
}

let evidenceFixtureCounter = 0;
function evidenceFixturePath(label) {
  evidenceFixtureCounter += 1;
  return path.join(repoRoot, "docs", "evidence", `.smoke-proposition-p1a-${process.pid}-${evidenceFixtureCounter}-${label}.json`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeEnvelope(home, envelope) {
  const file = l1.expectedL1EventPath(home, envelope.event_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, l1.canonicalL1EnvelopeJson(envelope), "utf8");
  return envelope;
}

function envelopeFor(schema, body) {
  return prop.buildPropositionEnvelope(schema, body);
}

function spatialScope(level, value = null) {
  if (level === "global") return { scope_level: "global", project_id: null, domain: null };
  if (level === "project") return { scope_level: "project", project_id: value || "pi-astack", domain: null };
  if (level === "domain") return { scope_level: "domain", project_id: null, domain: value || "engineering" };
  return { scope_level: level, project_id: null, domain: null };
}

function facets(genesisId, options = {}) {
  const causalParents = options.causalParents || [genesisId];
  return {
    provenance_authority: {
      source_kind: "user",
      authority_kind: "user_attested",
      source_event_id: null,
      quote_sha256: null,
    },
    spatial_scope: options.scope || spatialScope("global"),
    temporal_horizon: options.temporal || { horizon: "durable", valid_from: null, valid_until: null },
    trigger: { trigger_kind: "user_directive", trigger_ref: "adr0040-p1a-fixture" },
    maturity: { state: "accepted", review_state: "reviewed" },
    contestability: options.contestability || { status: "uncontested", counterevidence_event_ids: [] },
    confidence: { score: 1, basis: "witnessed" },
    sensitivity: options.sensitivity || { classification: "public", handling: "none" },
    consumer_hints: options.hints || { retrieval: true, policy: false, notes: [] },
    lineage: {
      causal_parents: causalParents,
      derives_from: [genesisId],
      supersedes: options.supersedes || [],
    },
  };
}

function evidenceBody(genesisId, statement, options = {}) {
  return {
    event_schema_version: prop.PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: { name: prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: "p1a-fixture/v1" },
    epoch: { epoch_id: prop.PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, genesis_event_id: genesisId },
    proposition: { modality: options.modality || "descriptive", statement, language: options.language || "en" },
    facets: facets(genesisId, options),
  };
}

function lifecycleBody(genesisId, operation, targets, options = {}) {
  const eventType = {
    retract: "proposition_retract_declared",
    rescope: "proposition_rescope_declared",
    supersede: "proposition_supersede_declared",
    archive: "proposition_archive_declared",
    reactivate: "proposition_reactivate_declared",
  }[operation];
  return {
    event_schema_version: prop.PROPOSITION_LIFECYCLE_BODY_SCHEMA,
    event_type: eventType,
    producer: { name: prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: "p1a-fixture/v1" },
    epoch: { epoch_id: prop.PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, genesis_event_id: genesisId },
    lifecycle: {
      operation,
      modality: "meta-lifecycle",
      effect: "declared_only",
      target_event_ids: targets,
      reason: `${operation} fixture declaration`,
    },
    facets: facets(genesisId, {
      causalParents: targets,
      scope: options.scope || spatialScope("global"),
      supersedes: options.supersedes || [],
    }),
  };
}

function legacyKnowledgeEnvelope() {
  const body = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    producer: { name: "sediment.knowledge-event-writer", version: "fixture" },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    fixture: "must-not-enter-proposition-shadow",
  };
  const bodyHash = l1.canonicalL1BodyHash(body);
  return {
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

async function genesis(home) {
  const tuple = await genesisWriter.prepareFixedProductionPropositionGenesisTuple({ abrainHome: home, registryPath });
  writeEnvelope(home, tuple.envelope);
  return tuple;
}

async function buildRichFixture(home, insertion = "forward") {
  const tuple = await genesis(home);
  const genesisId = tuple.event_id;
  const events = [];
  const addEvidence = (statement, options) => {
    const event = envelopeFor(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(genesisId, statement, options));
    events.push(event);
    return event;
  };
  const addLifecycle = (operation, targets, options) => {
    const event = envelopeFor(prop.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, lifecycleBody(genesisId, operation, targets, options));
    events.push(event);
    return event;
  };

  const oldNormative = addEvidence("Use the project formatter exactly.", { modality: "normative", scope: spatialScope("project") });
  const rescope = addLifecycle("rescope", [oldNormative.event_id], { scope: spatialScope("global") });
  const archive = addLifecycle("archive", [rescope.event_id]);
  const reactivate = addLifecycle("reactivate", [archive.event_id]);
  const replacement = addEvidence("Use the repository formatter exactly.", { modality: "normative", scope: spatialScope("global"), supersedes: [oldNormative.event_id] });
  addLifecycle("supersede", [reactivate.event_id, replacement.event_id], { supersedes: [oldNormative.event_id] });

  const retractable = addEvidence("The resolver preserves explicit chains.", { modality: "descriptive", scope: spatialScope("global") });
  const retract = addLifecycle("retract", [retractable.event_id]);
  addLifecycle("reactivate", [retract.event_id]);

  addEvidence("Lifecycle declarations are audit metadata.", { modality: "meta-lifecycle", scope: spatialScope("global") });
  addEvidence("Consumer hint twin statement.", { modality: "descriptive", scope: spatialScope("project"), hints: { retrieval: true, policy: false, notes: ["fixture-a"] } });
  addEvidence("Consumer hint twin statement.", { modality: "descriptive", scope: spatialScope("project"), hints: { retrieval: false, policy: true, notes: ["fixture-b"] } });
  addEvidence("SECRET-FIXTURE-TEXT-must-not-leak", { sensitivity: { classification: "secret", handling: "none" } });
  addEvidence("ADJACENT-FIXTURE-TEXT-must-not-leak", { sensitivity: { classification: "secret_adjacent", handling: "none" } });
  addEvidence("WITHHOLD-FIXTURE-TEXT-must-not-leak", { sensitivity: { classification: "sensitive", handling: "withhold" } });
  addEvidence("REDACT-FIXTURE-TEXT-must-not-leak", { sensitivity: { classification: "sensitive", handling: "redact" } });
  addEvidence("UNRESOLVED-SCOPE-TEXT-must-not-leak", { scope: spatialScope("unknown") });
  addEvidence("TEMPORAL-FIXTURE-TEXT-must-not-leak", { temporal: { horizon: "bounded", valid_from: "2026-01-01T00:00:00Z", valid_until: "2026-12-31T00:00:00Z" } });
  addEvidence("CONTESTED-FIXTURE-TEXT-must-not-leak", { contestability: { status: "contested", counterevidence_event_ids: [] } });

  const ordered = insertion === "reverse" ? [...events].reverse() : events;
  for (const event of ordered) writeEnvelope(home, event);
  writeEnvelope(home, legacyKnowledgeEnvelope());
  return { tuple, events, oldNormative, replacement, retractable };
}

function walkSourceFiles(root) {
  const output = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else if (/\.(?:ts|js|mjs)$/.test(name)) output.push(file);
    }
  };
  walk(root);
  return output;
}

console.log("ADR0040 P1a proposition Knowledge pull shadow smoke");

await check("current registry advances only for the P1b producer while genesis provenance remains historical", async () => {
  assert(jcs.sha256Hex(fs.readFileSync(registryPath)) === EXPECTED_REGISTRY_FILE_SHA256, "registry bytes drifted");
  assert(jcs.sha256Hex(fs.readFileSync(propositionPath)) === EXPECTED_PROPOSITION_FILE_SHA256, "proposition.ts bytes drifted");
  const registry = l1.loadL1SchemaRegistry(registryPath);
  const evidence = l1.resolveL1EnvelopeSchema(registry, "proposition-evidence-envelope/v1");
  assert(evidence.producers.includes("pi-astack.proposition-production-evidence-writer"), "P1b dedicated evidence producer missing");
  assert(evidence.phase === "defined_inactive" && !evidence.write_enabled && !evidence.fold_eligible, "P1b registry delta changed evidence phase/body flags");
  const anchors = await genesisWriter.computeCurrentPropositionSchemaAnchors(registryPath);
  assert(anchors.proposition_schema_contract_hash === "4b7a9d28b64040eb55471b72e865ed11970d11be223979fb1566ebe65ab46d2e", "current proposition schema contract hash drifted");
  assert(genesisWriter.PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING.registry_file_sha256 === "e89cb9009d7180bf1fab0fd285bc2832ec2d2a8f8d7663260eeb85182599f6d2", "historical genesis registry provenance drifted");
  const projection = l1.resolveL1EnvelopeSchema(registry, "proposition-projection-envelope/v1");
  assert(projection.phase === "phase_disabled" && projection.body_schema === undefined && !projection.write_enabled && !projection.fold_eligible, "projection envelope contract activated");
});

await check("whole-L1 fixture resolves all five operations without consumer-specific latest-wins", async () => {
  const home = tempHome("rich");
  try {
    const fixture = await buildRichFixture(home);
    const scan = await l1.scanWholeL1Validated({ abrainHome: home });
    const propositionRecords = scan.definedInactiveShadow.filter((record) => record.registration.domain === "proposition");
    const first = resolver.resolvePropositionLifecycleEffectiveState(propositionRecords, { expectedGenesisEventId: fixture.tuple.event_id });
    const reversed = resolver.resolvePropositionLifecycleEffectiveState([...propositionRecords].reverse(), { expectedGenesisEventId: fixture.tuple.event_id });
    assert(jcs.canonicalizeJcs(first) === jcs.canonicalizeJcs(reversed), "resolver depends on input order");
    const operations = new Set(first.states.flatMap((state) => state.lifecycle_lineage.map((entry) => entry.operation)));
    assert(["retract", "rescope", "supersede", "archive", "reactivate"].every((operation) => operations.has(operation)), `operation set incomplete: ${[...operations]}`);
    const old = first.states.find((state) => state.source_event_id === fixture.oldNormative.event_id);
    const replacement = first.states.find((state) => state.source_event_id === fixture.replacement.event_id);
    const reactivated = first.states.find((state) => state.source_event_id === fixture.retractable.event_id);
    assert(old?.disposition === "superseded" && old.superseded_by_event_id === fixture.replacement.event_id, "supersede chain did not resolve explicitly");
    assert(replacement?.disposition === "active", "replacement evidence not active");
    assert(reactivated?.disposition === "active" && reactivated.activation === "reactivated", "retract/reactivate chain did not resolve");
    assert(scan.all.some((record) => record.registration.domain === "knowledge") && !first.input_event_ids.includes(legacyKnowledgeEnvelope().event_id), "legacy event entered resolver input");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("cards preserve exact evidence while exclusions and diagnostics omit statement text", async () => {
  const home = tempHome("cards");
  try {
    const fixture = await buildRichFixture(home);
    const bundle = await shadow.buildPropositionKnowledgeShadow({ abrainHome: home, repoRoot, registryPath });
    shadow.validatePropositionKnowledgeShadowBundle(bundle);
    const statements = bundle.cards.cards.map((card) => card.statement);
    assert(statements.includes("Use the repository formatter exactly."), "normative pull-shadow card missing");
    assert(statements.includes("The resolver preserves explicit chains."), "descriptive reactivated card missing");
    assert(!statements.includes("Use the project formatter exactly."), "superseded evidence became a card");
    assert(bundle.cards.cards.some((card) => card.scope.scope_level === "global") && bundle.cards.cards.some((card) => card.scope.scope_level === "project"), "two scope fixture not preserved");
    assert(bundle.exclusions.exclusions.some((item) => item.modality === "meta-lifecycle" && item.reason_codes.includes("meta_lifecycle_not_searchable")), "meta-lifecycle evidence not excluded");
    const twins = bundle.cards.cards.filter((card) => card.statement === "Consumer hint twin statement.");
    assert(twins.length === 2, "consumer hints changed Knowledge shadow inclusion");
    assert(twins.some((card) => card.original_facets.consumer_hints.retrieval === false && card.original_facets.consumer_hints.policy === true), "consumer hints were not retained exactly");
    assert(bundle.cards.cards.some((card) => card.modality === "normative") && bundle.cards.cards.some((card) => card.modality === "descriptive"), "searchable modality fixture incomplete");
    const reasonSet = new Set(bundle.exclusions.exclusions.flatMap((item) => item.reason_codes));
    for (const reason of ["sensitivity_secret", "sensitivity_secret_adjacent", "sensitivity_withhold", "unsupported_redaction", "unresolved_scope", "temporal_context_required", "contestability_contested"]) {
      assert(reasonSet.has(reason), `missing disposition ${reason}`);
    }
    const nonCardBytes = `${bundle.bytes["manifest.json"]}${bundle.bytes["exclusions.json"]}${bundle.bytes["diagnostics.json"]}`;
    for (const marker of ["SECRET-FIXTURE-TEXT", "ADJACENT-FIXTURE-TEXT", "WITHHOLD-FIXTURE-TEXT", "REDACT-FIXTURE-TEXT", "UNRESOLVED-SCOPE-TEXT", "TEMPORAL-FIXTURE-TEXT", "CONTESTED-FIXTURE-TEXT"]) {
      assert(!nonCardBytes.includes(marker), `${marker} leaked outside cards`);
      assert(!bundle.bytes["cards.json"].includes(marker), `${marker} leaked into cards`);
    }
    const serializedCards = bundle.bytes["cards.json"].toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const forbidden of ["injectmode", "priority", "always", "listed", "policyeligibility", "sessionstarteligibility"]) assert(!serializedCards.includes(forbidden), `${forbidden} was derived into cards`);
    assert(bundle.manifest.source.non_proposition_event_consumed_count === 0, "legacy event consumption count nonzero");
    assert(bundle.manifest.source.scanner === "scanWholeL1Validated" && bundle.manifest.source.consumed_classification === "defined-inactive-shadow", "whole-L1 source contract missing");
    assert(bundle.manifest.projection_envelope_contract.phase === "phase_disabled", "projection envelope phase changed");
    assert(bundle.manifest.epoch.genesis_event_id === fixture.tuple.event_id, "fixed genesis not retained");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("unknown parent, cross epoch, cycle, invalid target and branch ambiguity fail closed", async () => {
  const home = tempHome("faults");
  try {
    const tuple = await genesis(home);
    const a = writeEnvelope(home, envelopeFor(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(tuple.event_id, "Fault node A.")));
    const b = writeEnvelope(home, envelopeFor(prop.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(tuple.event_id, "Fault node B.")));
    const scan = await l1.scanWholeL1Validated({ abrainHome: home });
    const records = scan.definedInactiveShadow.filter((record) => record.registration.domain === "proposition");
    const aRecord = records.find((record) => record.eventId === a.event_id);
    const bRecord = records.find((record) => record.eventId === b.event_id);
    const replaceRecord = (target, body) => records.map((record) => record.eventId === target.eventId ? { ...record, body } : record);

    const unknownBody = clone(aRecord.body);
    unknownBody.facets.lineage.causal_parents = ["f".repeat(64)];
    await expectCode("PROPOSITION_LIFECYCLE_UNKNOWN_PARENT", () => resolver.resolvePropositionLifecycleEffectiveState(replaceRecord(aRecord, unknownBody), { expectedGenesisEventId: tuple.event_id }));

    const crossBody = clone(aRecord.body);
    crossBody.epoch.epoch_id = "adr0040-other-epoch";
    await expectCode("PROPOSITION_LIFECYCLE_CROSS_EPOCH", () => resolver.resolvePropositionLifecycleEffectiveState(replaceRecord(aRecord, crossBody), { expectedGenesisEventId: tuple.event_id }));

    const cycleA = clone(aRecord.body);
    const cycleB = clone(bRecord.body);
    cycleA.facets.lineage.causal_parents = [b.event_id];
    cycleB.facets.lineage.causal_parents = [a.event_id];
    const cycleRecords = records.map((record) => record.eventId === a.event_id ? { ...record, body: cycleA } : record.eventId === b.event_id ? { ...record, body: cycleB } : record);
    await expectCode("PROPOSITION_LIFECYCLE_CYCLE", () => resolver.resolvePropositionLifecycleEffectiveState(cycleRecords, { expectedGenesisEventId: tuple.event_id }));

    const invalidLifecycle = envelopeFor(prop.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, lifecycleBody(tuple.event_id, "retract", [tuple.event_id]));
    const invalidRecord = {
      ...aRecord,
      eventId: invalidLifecycle.event_id,
      bodyHash: invalidLifecycle.body_hash,
      envelopeHash: l1.canonicalL1EnvelopeHash(invalidLifecycle),
      envelope: invalidLifecycle,
      body: invalidLifecycle.body,
      registration: l1.resolveL1EnvelopeSchema(l1.loadL1SchemaRegistry(), prop.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA),
    };
    await expectCode("PROPOSITION_LIFECYCLE_TARGET_MATRIX_INVALID", () => resolver.resolvePropositionLifecycleEffectiveState([...records, invalidRecord], { expectedGenesisEventId: tuple.event_id }));

    const branch1 = envelopeFor(prop.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, lifecycleBody(tuple.event_id, "archive", [a.event_id]));
    const branch2 = envelopeFor(prop.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, lifecycleBody(tuple.event_id, "retract", [a.event_id]));
    writeEnvelope(home, branch1);
    writeEnvelope(home, branch2);
    const branchScan = await l1.scanWholeL1Validated({ abrainHome: home });
    await expectCode("PROPOSITION_LIFECYCLE_AMBIGUOUS_STATE", () => resolver.resolvePropositionLifecycleEffectiveState(branchScan.definedInactiveShadow.filter((record) => record.registration.domain === "proposition"), { expectedGenesisEventId: tuple.event_id }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("input permutation and repeated builds produce identical RFC8785/JCS bundle bytes", async () => {
  const firstHome = tempHome("perm-a");
  const secondHome = tempHome("perm-b");
  try {
    await buildRichFixture(firstHome, "forward");
    await buildRichFixture(secondHome, "reverse");
    const first = await shadow.buildPropositionKnowledgeShadow({ abrainHome: firstHome, repoRoot, registryPath });
    const repeated = await shadow.buildPropositionKnowledgeShadow({ abrainHome: firstHome, repoRoot, registryPath });
    const permuted = await shadow.buildPropositionKnowledgeShadow({ abrainHome: secondHome, repoRoot, registryPath });
    assert(first.manifest.bundle_hash === repeated.manifest.bundle_hash && first.manifest.bundle_hash === permuted.manifest.bundle_hash, "bundle hash changed across build/permutation");
    for (const name of ["manifest.json", "cards.json", "exclusions.json", "diagnostics.json"]) {
      assert(first.bytes[name] === repeated.bytes[name] && first.bytes[name] === permuted.bytes[name], `${name} bytes changed across build/permutation`);
      assert(first.bytes[name] === `${jcs.canonicalizeJcs(JSON.parse(first.bytes[name]))}\n`, `${name} is not canonical JCS bytes`);
    }
    assert(!/generated|timestamp|mtime|wall.?clock|random/i.test(first.bytes["manifest.json"]), "nondeterministic field entered manifest");
  } finally {
    fs.rmSync(firstHome, { recursive: true, force: true });
    fs.rmSync(secondHome, { recursive: true, force: true });
  }
});

await check("latest reader rejects renamed bundle identity and symlinked bundle ancestors", async () => {
  const renamedHome = tempHome("reader-renamed");
  const ancestorHome = tempHome("reader-ancestor");
  try {
    await genesis(renamedHome);
    const publication = await shadow.publishPropositionKnowledgeShadow({ abrainHome: renamedHome, repoRoot, registryPath });
    const root = publication.root;
    const renamedHash = "f".repeat(64);
    const renamedDir = path.join(root, "bundles", renamedHash);
    fs.renameSync(publication.bundle_dir, renamedDir);
    fs.unlinkSync(publication.latest_path);
    fs.symlinkSync(`bundles/${renamedHash}`, publication.latest_path, "dir");
    await expectCode("PROPOSITION_KNOWLEDGE_SHADOW_BUNDLE_ID_MISMATCH", () => shadow.readLatestPropositionKnowledgeShadow({ abrainHome: renamedHome }));

    await genesis(ancestorHome);
    const ancestorPublication = await shadow.publishPropositionKnowledgeShadow({ abrainHome: ancestorHome, repoRoot, registryPath });
    const bundles = path.join(ancestorPublication.root, "bundles");
    const bundlesReal = path.join(ancestorPublication.root, "bundles-real");
    fs.renameSync(bundles, bundlesReal);
    fs.symlinkSync("bundles-real", bundles, "dir");
    await expectCode("PROPOSITION_KNOWLEDGE_SHADOW_PATH_UNSAFE", () => shadow.readLatestPropositionKnowledgeShadow({ abrainHome: ancestorHome }));
  } finally {
    fs.rmSync(renamedHome, { recursive: true, force: true });
    fs.rmSync(ancestorHome, { recursive: true, force: true });
  }
});

await check("dossier ancestor and leaf symlink escapes fail before shadow mutation or claims", async () => {
  const home = tempHome("dossier-symlinks");
  const outside = tempHome("dossier-outside");
  const leaf = evidenceFixturePath("leaf-symlink");
  try {
    await genesis(home);
    const rogueParent = path.join(home, "rogue-dossier-parent");
    fs.mkdirSync(rogueParent);
    const linkedParent = path.join(outside, "linked-parent");
    fs.symlinkSync(rogueParent, linkedParent, "dir");
    const escapedOutput = path.join(linkedParent, "escaped.json");
    const parentRejected = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts/project-proposition-knowledge-shadow.mjs"),
      "--abrain", home,
      "--registry", registryPath,
      "--runtime-config", runtimeConfigPath,
      "--dossier", escapedOutput,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert(parentRejected.status !== 0 && parentRejected.stderr.includes("PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_PATH_REJECTED"), parentRejected.stderr);
    assert(parentRejected.stdout.trim() === "", "rejected ancestor symlink emitted dossier claims");
    assert(!fs.existsSync(path.join(rogueParent, "escaped.json")), "ancestor symlink created a rogue abrain dossier");
    assert(!fs.existsSync(path.join(home, ".state/sediment/proposition-knowledge-shadow/v1/latest")), "ancestor symlink rejection happened after shadow mutation");

    const rogueLeaf = path.join(home, "rogue-leaf.json");
    fs.symlinkSync(rogueLeaf, leaf);
    const leafRejected = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts/project-proposition-knowledge-shadow.mjs"),
      "--abrain", home,
      "--registry", registryPath,
      "--runtime-config", runtimeConfigPath,
      "--dossier", leaf,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert(leafRejected.status !== 0 && leafRejected.stderr.includes("PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_PATH_REJECTED"), leafRejected.stderr);
    assert(leafRejected.stdout.trim() === "", "rejected leaf symlink emitted dossier claims");
    assert(!fs.existsSync(rogueLeaf), "leaf symlink created a rogue abrain dossier");
    assert(!fs.existsSync(path.join(home, ".state/sediment/proposition-knowledge-shadow/v1/latest")), "leaf symlink rejection happened after shadow mutation");
  } finally {
    if (fs.lstatSync(leaf, { throwIfNoEntry: false })) fs.unlinkSync(leaf);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

await check("CLI publishes an atomic four-file latest bundle and a self-hashed dossier", async () => {
  const home = tempHome("cli");
  const dossier = evidenceFixturePath("cli");
  try {
    const tuple = await genesis(home);
    fs.mkdirSync(path.join(home, ".state", "sediment", "proposition-knowledge-shadow"), { recursive: true });
    const rejected = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts/project-proposition-knowledge-shadow.mjs"),
      "--abrain", home,
      "--registry", registryPath,
      "--runtime-config", runtimeConfigPath,
      "--dossier", path.join(home, "forbidden-dossier.json"),
    ], { cwd: repoRoot, encoding: "utf8" });
    assert(rejected.status !== 0 && rejected.stderr.includes("PROPOSITION_KNOWLEDGE_SHADOW_DOSSIER_PATH_REJECTED"), "abrain-internal dossier path was not rejected");
    assert(!fs.existsSync(path.join(home, ".state/sediment/proposition-knowledge-shadow/v1/latest")), "path rejection happened after shadow mutation");
    const beforeRegistry = fs.readFileSync(registryPath);
    const beforeProposition = fs.readFileSync(propositionPath);
    const run = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts/project-proposition-knowledge-shadow.mjs"),
      "--abrain", home,
      "--registry", registryPath,
      "--runtime-config", runtimeConfigPath,
      "--dossier", dossier,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert(run.status === 0, `CLI failed: ${run.stderr}`);
    const summary = JSON.parse(run.stdout);
    assert(summary.card_count === 0 && summary.disposition_reason === "genesis_only_no_post_genesis_propositions", "genesis-only result drifted");
    assert(summary.dossier.status === "created" && summary.dossier.included_in_abrain_mutation_claim === false && summary.dossier.readback_byte_identical === true, "CLI dossier write receipt drifted");
    const latest = path.join(home, ".state/sediment/proposition-knowledge-shadow/v1/latest");
    assert(fs.lstatSync(latest).isSymbolicLink(), "latest is not an atomic symlink pointer");
    const names = fs.readdirSync(latest).sort();
    assert(JSON.stringify(names) === JSON.stringify(["cards.json", "diagnostics.json", "exclusions.json", "manifest.json"]), `bundle file set=${names}`);
    const readBack = await shadow.readLatestPropositionKnowledgeShadow({ abrainHome: home });
    assert(readBack.manifest.bundle_hash === summary.bundle_hash, "latest readback bundle differs");
    const dossierObject = JSON.parse(fs.readFileSync(dossier, "utf8"));
    shadow.validateDossierSelfHash(dossierObject);
    assert(dossierObject.schema_version === "proposition-knowledge-pull-shadow-p1a-dossier/v2", "dossier schema did not advance to v2");
    assert(dossierObject.source.proposition_count === 1 && dossierObject.source.evidence_count === 0 && dossierObject.source.lifecycle_count === 0, "dossier source count drifted");
    assert(dossierObject.source.selected_count === 0 && dossierObject.source.foldable_count === 0, "dossier selected/foldable drifted");
    assert(dossierObject.source.generic_write_gate === "L1_SCHEMA_WRITE_DISABLED", "generic gate changed");
    assert(dossierObject.shadow.card_count === 0 && dossierObject.shadow.disposition_reason === "genesis_only_no_post_genesis_propositions", "dossier production reason drifted");
    assert(dossierObject.mutation_inventory.claim_scope === "all_abrain_entries_before_after", "mutation claim is not whole-abrain scoped");
    assert(dossierObject.mutation_inventory.protected_scope.unchanged === true && dossierObject.assertions.full_abrain_outside_shadow_unchanged === true, "full protected abrain snapshot changed");
    assert(dossierObject.mutation_inventory.shadow_scope.allowed === true, "exact shadow inventory was not accepted");
    assert(dossierObject.mutation_inventory.repo_evidence_write.included_in_abrain_mutation_claim === false, "repo dossier was included in abrain-only claim");
    assert(dossierObject.mutation_inventory.repo_evidence_write.write_sequence === "after_abrain_after_snapshot_and_dossier_finalization", "repo dossier write sequencing missing");
    assert(JSON.stringify([...beforeRegistry]) === JSON.stringify([...fs.readFileSync(registryPath)]), "registry bytes changed during CLI");
    assert(JSON.stringify([...beforeProposition]) === JSON.stringify([...fs.readFileSync(propositionPath)]), "proposition.ts bytes changed during CLI");
    const second = spawnSync(process.execPath, [path.join(repoRoot, "scripts/project-proposition-knowledge-shadow.mjs"), "--abrain", home, "--registry", registryPath, "--runtime-config", runtimeConfigPath], { cwd: repoRoot, encoding: "utf8" });
    assert(second.status === 0, `CLI rerun failed: ${second.stderr}`);
    const secondSummary = JSON.parse(second.stdout);
    assert(secondSummary.bundle_hash === summary.bundle_hash && secondSummary.bundle_status === "identical", "CLI rerun not byte-stable/idempotent");
    assert(secondSummary.abrain_mutation_claim.protected_scope.unchanged === true, "rerun protected abrain snapshot changed");
    assert(tuple.event_id === readBack.manifest.epoch.genesis_event_id, "latest fixed genesis mismatch");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dossier, { force: true });
  }
});

await check("validator rejects derived authority fields and statement-bearing diagnostics", async () => {
  const home = tempHome("validator");
  try {
    await buildRichFixture(home);
    const bundle = await shadow.buildPropositionKnowledgeShadow({ abrainHome: home, repoRoot, registryPath });
    const derived = clone(bundle);
    derived.cards.cards[0].priority = 1;
    await expectCode("PROPOSITION_KNOWLEDGE_SHADOW_DERIVED_AUTHORITY_FORBIDDEN", () => shadow.validatePropositionKnowledgeShadowBundle(derived));
    const extra = clone(bundle);
    extra.manifest.unapproved = true;
    await expectCode("PROPOSITION_KNOWLEDGE_SHADOW_SCHEMA_INVALID", () => shadow.validatePropositionKnowledgeShadowBundle(extra));
    const leaked = clone(bundle);
    leaked.diagnostics.diagnostics[0].statement = "must never persist";
    leaked.bytes["diagnostics.json"] = `${jcs.canonicalizeJcs(leaked.diagnostics)}\n`;
    await expectCode("PROPOSITION_KNOWLEDGE_SHADOW_SECRET_LEAK", () => shadow.validatePropositionKnowledgeShadowBundle(leaked));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("memory, sediment, rule injector and lifecycle hooks have no shadow import or registration", () => {
  const runtimeRoots = [
    path.join(repoRoot, "extensions/memory"),
    path.join(repoRoot, "extensions/sediment"),
    path.join(repoRoot, "extensions/abrain/rule-injector"),
  ];
  const runtimeFiles = runtimeRoots.flatMap(walkSourceFiles).concat([
    path.join(repoRoot, "extensions/abrain/index.ts"),
    path.join(repoRoot, "extensions/_shared/runtime.ts"),
  ]);
  const offenders = runtimeFiles.filter((file) => /proposition-(?:knowledge-shadow|lifecycle-resolver)|proposition-knowledge-shadow/i.test(fs.readFileSync(file, "utf8")));
  assert(offenders.length === 0, `runtime import/registration found: ${offenders.map((file) => path.relative(repoRoot, file)).join(", ")}`);
  const parserSearch = ["extensions/memory/parser.ts", "extensions/memory/search.ts", "extensions/memory/llm-search.ts"];
  assert(parserSearch.every((rel) => !/proposition-knowledge-shadow/i.test(fs.readFileSync(path.join(repoRoot, rel), "utf8"))), "memory parser/search wired shadow");
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert(pkg.pi.extensions.every((entry) => !/proposition/i.test(entry)), "shadow registered as runtime extension");
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
