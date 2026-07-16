#!/usr/bin/env node
/** ADR0040 P2a.1 policy push shadow projector and read-only preview smoke. */
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
const proposition = jiti(path.join(repoRoot, "extensions/_shared/proposition.ts"));
const genesisWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-genesis-writer.ts"));
const evidenceWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-evidence-writer.ts"));
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));
const preview = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow-preview.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const registryPath = path.join(repoRoot, "schemas/l1-schema-role-registry.json");
const EXPECTED_PRODUCTION_BUNDLE_HASH = "dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0";
const EXPECTED_PRODUCTION_ARTIFACT_HASHES = Object.freeze({
  "diagnostics.json": "9daf2ec369ec6c70171da4c5683935ad61d42395ac7786b2c05474e781ccdfda",
  "entries.json": "ba5629a446c01874a0376c86fcea6c623509d50fe488547562175b6b27d16303",
  "exclusions.json": "c29e6b12cf0ba4b980202ae42807ee5b18fd1de3cf01c606a2f3bcf28382984f",
  "manifest.json": "a9cd4467c9da352463b66a539077c03aef6aaf7f41bcfa9b8f611768223e40e8",
});
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-policy-push-${label}-`));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  return `${jcs.canonicalizeJcs(value)}\n`;
}

function rehashRecord(record) {
  const base = { ...record };
  delete base.record_hash;
  record.record_hash = jcs.jcsSha256Hex(base);
}

function rehashBundle(bundle) {
  for (const record of [...bundle.entries.entries, ...bundle.exclusions.exclusions, ...bundle.diagnostics.diagnostics]) rehashRecord(record);
  bundle.manifest.source.input_event_ids_hash = jcs.jcsSha256Hex(bundle.manifest.source.input_event_ids);
  bundle.manifest.source.evidence_event_ids_hash = jcs.jcsSha256Hex(bundle.manifest.source.evidence_event_ids);
  bundle.manifest.source.lifecycle_event_ids_hash = jcs.jcsSha256Hex(bundle.manifest.source.lifecycle_event_ids);
  bundle.manifest.source.source_resolution_inventory_hash = jcs.jcsSha256Hex(bundle.manifest.source.source_resolution_inventory);
  bundle.manifest.result.entry_count = bundle.entries.entries.length;
  bundle.manifest.result.exclusion_count = bundle.exclusions.exclusions.length;
  bundle.manifest.result.diagnostic_count = bundle.diagnostics.diagnostics.length;
  bundle.bytes["diagnostics.json"] = canonicalJson(bundle.diagnostics);
  bundle.bytes["entries.json"] = canonicalJson(bundle.entries);
  bundle.bytes["exclusions.json"] = canonicalJson(bundle.exclusions);
  bundle.manifest.artifacts = ["diagnostics.json", "entries.json", "exclusions.json"].map((name) => ({
    name,
    bytes: Buffer.byteLength(bundle.bytes[name]),
    sha256: jcs.sha256Hex(bundle.bytes[name]),
  }));
  const manifestBase = { ...bundle.manifest };
  delete manifestBase.bundle_hash;
  bundle.manifest.bundle_hash = jcs.jcsSha256Hex(manifestBase);
  bundle.bytes["manifest.json"] = canonicalJson(bundle.manifest);
  return bundle;
}

function writeEnvelope(home, envelope) {
  const file = l1.expectedL1EventPath(home, envelope.event_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, l1.canonicalL1EnvelopeJson(envelope), "utf8");
  return envelope;
}

function uncheckedEnvelope(schema, body) {
  const bodyHash = l1.canonicalL1BodyHash(body);
  return { schema, canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: bodyHash, body_hash: bodyHash, body };
}

async function writeGenesis(home) {
  const tuple = await genesisWriter.prepareFixedProductionPropositionGenesisTuple({ abrainHome: home, registryPath });
  writeEnvelope(home, tuple.envelope);
  return tuple;
}

function scope(level = "global") {
  if (level === "global") return { scope_level: "global", project_id: null, domain: null };
  if (level === "project") return { scope_level: "project", project_id: "pi-astack", domain: null };
  return { scope_level: level, project_id: null, domain: null };
}

function facets(options = {}) {
  return {
    provenance_authority: options.authority || { source_kind: "user", authority_kind: "user_attested", source_event_id: null, quote_sha256: null },
    spatial_scope: options.scope || scope(),
    temporal_horizon: options.temporal || { horizon: "durable", valid_from: null, valid_until: null },
    trigger: { trigger_kind: "user_directive", trigger_ref: "adr0040-p2a1-fixture" },
    maturity: options.maturity || { state: "accepted", review_state: "reviewed" },
    contestability: options.contestability || { status: "uncontested", counterevidence_event_ids: [] },
    confidence: { score: 1, basis: "witnessed" },
    sensitivity: options.sensitivity || { classification: "public", handling: "none" },
    consumer_hints: { retrieval: true, policy: options.policy ?? true, notes: [] },
    lineage: {
      causal_parents: options.causalParents || [],
      derives_from: options.derivesFrom || [],
      supersedes: options.supersedes || [],
    },
  };
}

function evidenceBody(genesisId, statement, options = {}) {
  return {
    event_schema_version: proposition.PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: { name: proposition.PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: "p2a1-fixture/v1" },
    epoch: { epoch_id: options.epochId || proposition.PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, genesis_event_id: genesisId },
    proposition: { modality: options.modality || "normative", statement, language: "en" },
    facets: facets(options),
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
    event_schema_version: proposition.PROPOSITION_LIFECYCLE_BODY_SCHEMA,
    event_type: eventType,
    producer: { name: proposition.PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: "p2a1-fixture/v1" },
    epoch: { epoch_id: proposition.PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, genesis_event_id: genesisId },
    lifecycle: { operation, modality: "meta-lifecycle", effect: "declared_only", target_event_ids: targets, reason: `${operation} fixture` },
    facets: facets({ causalParents: targets, supersedes: options.supersedes || [], policy: false }),
  };
}

function evidenceEnvelope(genesisId, statement, options = {}) {
  return proposition.buildPropositionEnvelope(proposition.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, evidenceBody(genesisId, statement, options));
}

function lifecycleEnvelope(genesisId, operation, targets, options = {}) {
  return proposition.buildPropositionEnvelope(proposition.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, lifecycleBody(genesisId, operation, targets, options));
}

function legacyKnowledgeEnvelope() {
  const body = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    producer: { name: "sediment.knowledge-event-writer", version: "fixture" },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    fixture: "legacy-input-must-not-enter-policy-push",
  };
  return uncheckedEnvelope("knowledge-evidence-envelope/v1", body);
}

async function buildPrecedenceFixture(home, insertion = "forward") {
  const genesis = await writeGenesis(home);
  const id = genesis.event_id;
  const events = [];
  const candidate = evidenceEnvelope(id, "CANDIDATE-STATEMENT-ONLY-IN-ENTRIES", { policy: true });
  const archived = evidenceEnvelope(id, "EXCLUDED-LIFECYCLE-TEXT", { policy: false, scope: scope("unknown"), temporal: { horizon: "bounded", valid_from: null, valid_until: null } });
  const archive = lifecycleEnvelope(id, "archive", [archived.event_id]);
  const unsafe = evidenceEnvelope(id, "EXCLUDED-SAFETY-TEXT", { policy: false, authority: { source_kind: "assistant", authority_kind: "inferred", source_event_id: null, quote_sha256: null }, scope: scope("unknown"), temporal: { horizon: "bounded", valid_from: null, valid_until: null } });
  const unresolvedScope = evidenceEnvelope(id, "EXCLUDED-SCOPE-TEXT", { policy: false, scope: scope("unknown"), temporal: { horizon: "bounded", valid_from: null, valid_until: null }, sensitivity: { classification: "secret", handling: "withhold" } });
  const temporal = evidenceEnvelope(id, "EXCLUDED-TEMPORAL-TEXT", { policy: false, temporal: { horizon: "bounded", valid_from: null, valid_until: null }, sensitivity: { classification: "secret", handling: "withhold" } });
  const sensitive = evidenceEnvelope(id, "EXCLUDED-SENSITIVITY-TEXT", { policy: false, sensitivity: { classification: "secret", handling: "withhold" }, contestability: { status: "contested", counterevidence_event_ids: [] } });
  const contested = evidenceEnvelope(id, "EXCLUDED-CONTESTABILITY-TEXT", { policy: false, contestability: { status: "contested", counterevidence_event_ids: [] }, maturity: { state: "draft", review_state: "unreviewed" } });
  const immature = evidenceEnvelope(id, "EXCLUDED-MATURITY-TEXT", { policy: false, maturity: { state: "draft", review_state: "unreviewed" }, modality: "descriptive" });
  const descriptive = evidenceEnvelope(id, "EXCLUDED-MODALITY-TEXT", { policy: false, modality: "descriptive" });
  const policyFalse = evidenceEnvelope(id, "EXCLUDED-POLICY-HINT-TEXT", { policy: false });
  events.push(candidate, archived, archive, unsafe, unresolvedScope, temporal, sensitive, contested, immature, descriptive, policyFalse);
  for (const event of insertion === "reverse" ? [...events].reverse() : events) writeEnvelope(home, event);
  writeEnvelope(home, legacyKnowledgeEnvelope());
  return { candidate, events };
}

const PRECEDENCE_ROWS = shadow.PROPOSITION_POLICY_PUSH_EXCLUSION_PRECEDENCE;

function optionsViolatingStages(indices) {
  const selected = new Set(indices);
  const options = { policy: !selected.has(8) };
  if (selected.has(1)) options.authority = { source_kind: "assistant", authority_kind: "inferred", source_event_id: null, quote_sha256: null };
  if (selected.has(2)) options.scope = scope("unknown");
  if (selected.has(3)) options.temporal = { horizon: "bounded", valid_from: null, valid_until: null };
  if (selected.has(4)) options.sensitivity = { classification: "secret", handling: "withhold" };
  if (selected.has(5)) options.contestability = { status: "contested", counterevidence_event_ids: [] };
  if (selected.has(6)) options.maturity = { state: "draft", review_state: "unreviewed" };
  if (selected.has(7)) options.modality = "descriptive";
  return options;
}

async function buildExhaustivePrecedenceFixture(home) {
  const genesis = await writeGenesis(home);
  const expected = new Map();
  const addCase = (label, indices) => {
    const source = writeEnvelope(home, evidenceEnvelope(genesis.event_id, `PRECEDENCE-${label}`, optionsViolatingStages(indices)));
    if (indices.includes(0)) writeEnvelope(home, lifecycleEnvelope(genesis.event_id, "archive", [source.event_id]));
    const first = Math.min(...indices);
    expected.set(source.event_id, { stage: PRECEDENCE_ROWS[first].stage, reason: PRECEDENCE_ROWS[first].reason_codes[0], label });
  };
  for (let earlier = 0; earlier < PRECEDENCE_ROWS.length; earlier += 1) {
    for (let later = earlier + 1; later < PRECEDENCE_ROWS.length; later += 1) addCase(`PAIR-${earlier}-${later}`, [earlier, later]);
  }
  for (let start = 0; start < PRECEDENCE_ROWS.length; start += 1) addCase(`SUFFIX-${start}`, Array.from({ length: PRECEDENCE_ROWS.length - start }, (_, index) => start + index));
  writeEnvelope(home, evidenceEnvelope(genesis.event_id, "PRECEDENCE-ELIGIBLE", { policy: true }));
  return expected;
}

async function buildLifecycleChainFixture(home) {
  const genesis = await writeGenesis(home);
  const source = writeEnvelope(home, evidenceEnvelope(genesis.event_id, "LIFECYCLE-CHAIN-CANDIDATE", { policy: true }));
  const archive = writeEnvelope(home, lifecycleEnvelope(genesis.event_id, "archive", [source.event_id]));
  const reactivate = writeEnvelope(home, lifecycleEnvelope(genesis.event_id, "reactivate", [archive.event_id]));
  const rescope = writeEnvelope(home, lifecycleEnvelope(genesis.event_id, "rescope", [reactivate.event_id]));
  return { source, archive, reactivate, rescope };
}

function createRuntimeGraphFixture(label) {
  const root = tempHome(`runtime-${label}`);
  const extensions = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).pi.extensions;
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { extensions } }), "utf8");
  for (const entry of extensions) {
    const file = path.join(root, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export default function fixture() {}\n", "utf8");
  }
  const projector = path.join(root, "extensions/_shared/proposition-policy-push-shadow.ts");
  const previewModule = path.join(root, "extensions/_shared/proposition-policy-push-shadow-preview.ts");
  fs.mkdirSync(path.dirname(projector), { recursive: true });
  fs.writeFileSync(projector, "export const projector = true;\n", "utf8");
  fs.writeFileSync(previewModule, "export const preview = true;\n", "utf8");
  return { root, extensions, firstRoot: path.join(root, extensions[0]) };
}

console.log("ADR0040 P2a.1 proposition policy push shadow smoke");

await check("synthetic policy=true candidate and total-order combination exclusions are exact", async () => {
  const home = tempHome("precedence");
  try {
    await buildPrecedenceFixture(home);
    const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot, registryPath });
    shadow.validatePropositionPolicyPushBundle(bundle);
    assert(bundle.entries.entries.length === 1, `entry count=${bundle.entries.entries.length}`);
    assert(bundle.entries.entries[0].statement === "CANDIDATE-STATEMENT-ONLY-IN-ENTRIES", "candidate statement missing");
    assert(bundle.entries.entries[0].candidate_semantics === "relevance_only_no_injection_verdict", "candidate acquired verdict semantics");
    const reasons = bundle.exclusions.exclusions.map((item) => item.reason_code);
    const expected = [
      "lifecycle_archived",
      "safety_authority_not_attested",
      "scope_unresolved",
      "temporal_not_durable",
      "sensitivity_not_public",
      "contestability_not_uncontested",
      "maturity_not_accepted_reviewed",
      "modality_not_normative",
      "consumer_hints_policy_false",
    ];
    assert(expected.every((reason) => reasons.includes(reason)), `missing total-order reasons: ${JSON.stringify(reasons)}`);
    assert(bundle.exclusions.exclusions.length === expected.length && bundle.diagnostics.diagnostics.length === expected.length, "one exclusion/diagnostic per excluded source not preserved");
    for (const exclusion of bundle.exclusions.exclusions) {
      const diagnostic = bundle.diagnostics.diagnostics.find((item) => item.source_event_id === exclusion.source_event_id);
      assert(diagnostic?.code === "POLICY_CANDIDATE_EXCLUDED" && diagnostic.reason_code === exclusion.reason_code && diagnostic.filter_stage === exclusion.filter_stage, "diagnostic source/reason mismatch");
    }
    assert(JSON.stringify(bundle.manifest.exclusion_precedence.map((row) => row.stage)) === JSON.stringify(["lifecycle", "safety", "scope", "temporal", "sensitivity", "contestability", "maturity", "modality", "policy_hint"]), "precedence stages drifted");
    assert(bundle.manifest.source.non_proposition_event_consumed_count === 0 && bundle.manifest.source.proposition_event_count === 12, "legacy input entered projector source");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("all 36 earlier/later precedence pairs and all 9 suffix combinations select the exact first reason", async () => {
  const home = tempHome("precedence-exhaustive");
  try {
    const expected = await buildExhaustivePrecedenceFixture(home);
    assert(expected.size === 45, `precedence case count=${expected.size}`);
    const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot, registryPath });
    const exclusions = new Map(bundle.exclusions.exclusions.map((row) => [row.source_event_id, row]));
    for (const [sourceEventId, wanted] of expected) {
      const actual = exclusions.get(sourceEventId);
      assert(actual, `${wanted.label} has no exclusion`);
      assert(actual.filter_stage === wanted.stage && actual.reason_code === wanted.reason, `${wanted.label} expected ${wanted.stage}/${wanted.reason}, got ${actual.filter_stage}/${actual.reason_code}`);
    }
    assert(bundle.exclusions.exclusions.length === 45, `exclusion count=${bundle.exclusions.exclusions.length}`);
    assert(bundle.entries.entries.length === 1, `eligible entry count=${bundle.entries.entries.length}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("candidate statement exists only in entries and every excluded statement is absent from all artifacts", async () => {
  const home = tempHome("text-isolation");
  try {
    await buildPrecedenceFixture(home);
    const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot, registryPath });
    const nonEntries = `${bundle.bytes["manifest.json"]}${bundle.bytes["exclusions.json"]}${bundle.bytes["diagnostics.json"]}`;
    assert(!nonEntries.includes("CANDIDATE-STATEMENT-ONLY-IN-ENTRIES"), "candidate statement leaked outside entries");
    assert(bundle.bytes["entries.json"].includes("CANDIDATE-STATEMENT-ONLY-IN-ENTRIES"), "candidate statement absent from entries");
    for (const marker of ["EXCLUDED-LIFECYCLE-TEXT", "EXCLUDED-SAFETY-TEXT", "EXCLUDED-SCOPE-TEXT", "EXCLUDED-TEMPORAL-TEXT", "EXCLUDED-SENSITIVITY-TEXT", "EXCLUDED-CONTESTABILITY-TEXT", "EXCLUDED-MATURITY-TEXT", "EXCLUDED-MODALITY-TEXT", "EXCLUDED-POLICY-HINT-TEXT"]) {
      assert(!Object.values(bundle.bytes).join("").includes(marker), `${marker} leaked into artifacts`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("production tuple yields exact zero entries, one policy-false exclusion and one matching diagnostic", async () => {
  const home = tempHome("production-tuple");
  try {
    await writeGenesis(home);
    writeEnvelope(home, evidenceWriter.buildFixedProductionPropositionEvidenceEnvelope());
    const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot, registryPath });
    const exclusion = bundle.exclusions.exclusions[0];
    const diagnostic = bundle.diagnostics.diagnostics[0];
    assert(bundle.entries.entries.length === 0 && bundle.exclusions.exclusions.length === 1 && bundle.diagnostics.diagnostics.length === 1, "production tuple result is not 0/1/1");
    assert(exclusion.source_event_id === shadow.PROPOSITION_POLICY_PUSH_PRODUCTION_EVENT_ID && exclusion.reason_code === "consumer_hints_policy_false" && exclusion.filter_stage === "policy_hint", "production exclusion drifted");
    assert(diagnostic.source_event_id === exclusion.source_event_id && diagnostic.reason_code === exclusion.reason_code && diagnostic.code === "POLICY_CANDIDATE_EXCLUDED", "production diagnostic drifted");
    assert(bundle.manifest.authority === "shadow_push_only_no_runtime_consumer" && !("published_to_abrain" in bundle.manifest.candidate_contract), "authority/deployment-neutral boundary drifted");
    assert(bundle.manifest.bundle_hash === EXPECTED_PRODUCTION_BUNDLE_HASH, `production bundle hash=${bundle.manifest.bundle_hash}`);
    for (const [name, expected] of Object.entries(EXPECTED_PRODUCTION_ARTIFACT_HASHES)) assert(jcs.sha256Hex(bundle.bytes[name]) === expected, `${name} hash=${jcs.sha256Hex(bundle.bytes[name])}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("retract and supersede resolve once and conserve every physical proposition record", async () => {
  const home = tempHome("retract-supersede");
  try {
    const genesis = await writeGenesis(home);
    const oldPolicy = writeEnvelope(home, evidenceEnvelope(genesis.event_id, "OLD-SUPERSEDED-POLICY", { policy: true }));
    const replacement = writeEnvelope(home, evidenceEnvelope(genesis.event_id, "REPLACEMENT-ACTIVE-POLICY", { policy: true, supersedes: [oldPolicy.event_id] }));
    const supersede = writeEnvelope(home, lifecycleEnvelope(genesis.event_id, "supersede", [oldPolicy.event_id, replacement.event_id], { supersedes: [oldPolicy.event_id] }));
    const retractable = writeEnvelope(home, evidenceEnvelope(genesis.event_id, "RETRACTED-POLICY", { policy: true }));
    const retract = writeEnvelope(home, lifecycleEnvelope(genesis.event_id, "retract", [retractable.event_id]));
    const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot, registryPath });
    const exclusionBySource = new Map(bundle.exclusions.exclusions.map((row) => [row.source_event_id, row]));
    assert(bundle.entries.entries.length === 1 && bundle.entries.entries[0].source_event_id === replacement.event_id, "replacement is not the only active policy entry");
    assert(exclusionBySource.get(oldPolicy.event_id)?.reason_code === "lifecycle_superseded", "superseded source disposition differs");
    assert(exclusionBySource.get(retractable.event_id)?.reason_code === "lifecycle_retracted", "retracted source disposition differs");
    assert(bundle.diagnostics.diagnostics.length === 2 && bundle.manifest.source.source_resolution_inventory.length === 3, "evidence disposition/diagnostic accounting differs");
    const physicalIds = [genesis.event_id, oldPolicy.event_id, replacement.event_id, supersede.event_id, retractable.event_id, retract.event_id].sort();
    assert(bundle.manifest.source.proposition_event_count === 6
      && bundle.manifest.source.proposition_evidence_count === 3
      && bundle.manifest.source.proposition_lifecycle_count === 2
      && JSON.stringify(bundle.manifest.source.input_event_ids) === JSON.stringify(physicalIds), "physical proposition input accounting is incomplete");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("record and bundle hashes plus repeated/permuted RFC8785/JCS bytes are identical", async () => {
  const forward = tempHome("permutation-forward");
  const reverse = tempHome("permutation-reverse");
  try {
    await buildPrecedenceFixture(forward, "forward");
    await buildPrecedenceFixture(reverse, "reverse");
    const first = await shadow.buildPropositionPolicyPushShadow({ abrainHome: forward, repoRoot, registryPath });
    const repeat = await shadow.buildPropositionPolicyPushShadow({ abrainHome: forward, repoRoot, registryPath });
    const permuted = await shadow.buildPropositionPolicyPushShadow({ abrainHome: reverse, repoRoot, registryPath });
    assert(first.manifest.bundle_hash === repeat.manifest.bundle_hash && first.manifest.bundle_hash === permuted.manifest.bundle_hash, "bundle hash depends on repeat/permutation");
    for (const name of ["entries.json", "exclusions.json", "diagnostics.json", "manifest.json"]) {
      assert(first.bytes[name] === repeat.bytes[name] && first.bytes[name] === permuted.bytes[name], `${name} depends on repeat/permutation`);
      assert(first.bytes[name] === `${jcs.canonicalizeJcs(JSON.parse(first.bytes[name]))}\n`, `${name} is not exact JCS bytes`);
      assert(!/generated|timestamp|mtime|wall.?clock|random|locale/i.test(first.bytes[name]), `${name} contains nondeterministic metadata`);
    }
    const records = [...first.entries.entries, ...first.exclusions.exclusions, ...first.diagnostics.diagnostics];
    for (const record of records) {
      const base = clone(record);
      const claimed = base.record_hash;
      delete base.record_hash;
      assert(jcs.jcsSha256Hex(base) === claimed, "record self hash mismatch");
    }
  } finally {
    fs.rmSync(forward, { recursive: true, force: true });
    fs.rmSync(reverse, { recursive: true, force: true });
  }
});

await check("unknown parent, cross epoch, cycle and branch faults fail the whole build", async () => {
  const unknownHome = tempHome("unknown-parent");
  const crossHome = tempHome("cross-epoch");
  const cycleHome = tempHome("cycle");
  const branchHome = tempHome("branch");
  try {
    const unknownGenesis = await writeGenesis(unknownHome);
    writeEnvelope(unknownHome, evidenceEnvelope(unknownGenesis.event_id, "unknown parent", { causalParents: ["f".repeat(64)] }));
    await expectCode("PROPOSITION_LIFECYCLE_UNKNOWN_PARENT", () => shadow.buildPropositionPolicyPushShadow({ abrainHome: unknownHome, repoRoot, registryPath }));

    const crossGenesis = await writeGenesis(crossHome);
    writeEnvelope(crossHome, evidenceEnvelope(crossGenesis.event_id, "cross epoch", { epochId: "adr0040-other-epoch" }));
    await expectCode("PROPOSITION_LIFECYCLE_CROSS_EPOCH", () => shadow.buildPropositionPolicyPushShadow({ abrainHome: crossHome, repoRoot, registryPath }));

    const cycleGenesis = await writeGenesis(cycleHome);
    const left = writeEnvelope(cycleHome, evidenceEnvelope(cycleGenesis.event_id, "cycle left"));
    const right = writeEnvelope(cycleHome, evidenceEnvelope(cycleGenesis.event_id, "cycle right"));
    const scan = await l1.scanWholeL1Validated({ abrainHome: cycleHome, registryPath });
    const clonedScan = clone(scan);
    const leftRecord = clonedScan.all.find((record) => record.eventId === left.event_id);
    const rightRecord = clonedScan.all.find((record) => record.eventId === right.event_id);
    leftRecord.body.facets.lineage.causal_parents = [right.event_id];
    rightRecord.body.facets.lineage.causal_parents = [left.event_id];
    for (const key of ["definedInactiveShadow"]) clonedScan[key] = clonedScan.all.filter((record) => record.classification === "defined-inactive-shadow");
    await expectCode("PROPOSITION_LIFECYCLE_CYCLE", () => shadow.__TEST.projectValidatedWholeL1(clonedScan, { repoRoot, registryPath }));

    const branchGenesis = await writeGenesis(branchHome);
    const source = writeEnvelope(branchHome, evidenceEnvelope(branchGenesis.event_id, "branch source"));
    writeEnvelope(branchHome, lifecycleEnvelope(branchGenesis.event_id, "archive", [source.event_id]));
    writeEnvelope(branchHome, lifecycleEnvelope(branchGenesis.event_id, "retract", [source.event_id]));
    await expectCode("PROPOSITION_LIFECYCLE_AMBIGUOUS_STATE", () => shadow.buildPropositionPolicyPushShadow({ abrainHome: branchHome, repoRoot, registryPath }));

    for (const home of [unknownHome, crossHome, cycleHome, branchHome]) assert(!fs.existsSync(path.join(home, ".state")), "failed build left a partial artifact");
  } finally {
    for (const home of [unknownHome, crossHome, cycleHome, branchHome]) fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("malformed or missing lifecycle fields fail scanner schema before projection without valid diagnostics", async () => {
  const home = tempHome("malformed");
  try {
    const genesis = await writeGenesis(home);
    const source = writeEnvelope(home, evidenceEnvelope(genesis.event_id, "malformed target"));
    const malformed = lifecycleBody(genesis.event_id, "archive", [source.event_id]);
    delete malformed.lifecycle.target_event_ids;
    writeEnvelope(home, uncheckedEnvelope(proposition.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, malformed));
    await expectCode("L1_BODY_SHAPE_MISMATCH", () => shadow.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot, registryPath }));
    assert(!fs.existsSync(path.join(home, ".state")), "schema failure produced a partial shadow artifact");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("closed-world validators reject normalized forbidden keys, extras, statement leaks and hash tampering", async () => {
  const home = tempHome("validators");
  try {
    const v1Path = path.join(repoRoot, preview.PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_RELATIVE_PATH);
    const v1Raw = fs.readFileSync(v1Path, "utf8");
    const v1Dossier = JSON.parse(v1Raw);
    preview.validatePropositionPolicyPushPreviewV1Dossier(v1Dossier);
    assert(v1Dossier.dossier_hash === preview.PROPOSITION_POLICY_PUSH_PREVIEW_V1_DOSSIER_HASH, "preserved v1 dossier self-hash drifted");
    assert(jcs.sha256Hex(v1Raw) === preview.PROPOSITION_POLICY_PUSH_PREVIEW_V1_RAW_SHA256, "preserved v1 dossier raw hash drifted");
    const v2Path = path.join(repoRoot, preview.PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_RELATIVE_PATH);
    const v2Raw = fs.readFileSync(v2Path, "utf8");
    const v2Dossier = JSON.parse(v2Raw);
    preview.validatePropositionPolicyPushPreviewV2Dossier(v2Dossier);
    assert(v2Dossier.dossier_hash === preview.PROPOSITION_POLICY_PUSH_PREVIEW_V2_DOSSIER_HASH, "preserved v2 dossier self-hash drifted");
    assert(jcs.sha256Hex(v2Raw) === preview.PROPOSITION_POLICY_PUSH_PREVIEW_V2_RAW_SHA256, "preserved v2 dossier raw hash drifted");

    await buildPrecedenceFixture(home);
    const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: home, repoRoot, registryPath });
    const variants = [
      ["entries", "Inject_Mode"],
      ["exclusions", "A-L-W-A-Y-S"],
      ["diagnostics", "Li_sted"],
      ["manifest", "Policy-Eligibility"],
    ];
    for (const [surface, key] of variants) {
      const altered = clone(bundle);
      altered[surface][key] = true;
      await expectCode("PROPOSITION_POLICY_PUSH_FORBIDDEN_FIELD", () => shadow.validatePropositionPolicyPushBundle(altered));
    }
    await expectCode("PROPOSITION_POLICY_PUSH_FORBIDDEN_FIELD", () => preview.validatePropositionPolicyPushPreviewDossier({ "Session_Start-Eligibility": true }));
    const extra = clone(bundle);
    extra.manifest.candidate_contract.extra = true;
    await expectCode("PROPOSITION_POLICY_PUSH_SCHEMA_INVALID", () => shadow.validatePropositionPolicyPushBundle(extra));
    const leak = clone(bundle);
    leak.exclusions.exclusions[0].statement = "forbidden text";
    await expectCode("PROPOSITION_POLICY_PUSH_STATEMENT_LEAK", () => shadow.validatePropositionPolicyPushBundle(leak));
    const tampered = clone(bundle);
    tampered.exclusions.exclusions[0].reason_code = "scope_unresolved";
    await expectCode("PROPOSITION_POLICY_PUSH_HASH_INVALID", () => shadow.validatePropositionPolicyPushBundle(tampered));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await check("semantic validator rejects fully rehashed omission, extra, duplicate, fabricated terminal, foreign, reordered, and gapped lineage", async () => {
  const partitionHome = tempHome("semantic-partition");
  const lifecycleHome = tempHome("semantic-lifecycle");
  try {
    await buildPrecedenceFixture(partitionHome);
    const partitionBundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: partitionHome, repoRoot, registryPath });

    const omission = clone(partitionBundle);
    omission.exclusions.exclusions.shift();
    omission.diagnostics.diagnostics.shift();
    rehashBundle(omission);
    await expectCode("PROPOSITION_POLICY_PUSH_COUNT_INVALID", () => shadow.validatePropositionPolicyPushBundle(omission));

    const extra = clone(partitionBundle);
    const extraExclusion = extra.exclusions.exclusions.shift();
    const extraDiagnostic = extra.diagnostics.diagnostics.shift();
    extraExclusion.source_event_id = "e".repeat(64);
    extraDiagnostic.source_event_id = extraExclusion.source_event_id;
    extra.exclusions.exclusions.push(extraExclusion);
    extra.diagnostics.diagnostics.push(extraDiagnostic);
    extra.exclusions.exclusions.sort((left, right) => left.source_event_id.localeCompare(right.source_event_id));
    extra.diagnostics.diagnostics.sort((left, right) => left.source_event_id.localeCompare(right.source_event_id));
    rehashBundle(extra);
    await expectCode("PROPOSITION_POLICY_PUSH_PARTITION_INVALID", () => shadow.validatePropositionPolicyPushBundle(extra));

    const duplicate = clone(partitionBundle);
    duplicate.exclusions.exclusions[1].source_event_id = duplicate.exclusions.exclusions[0].source_event_id;
    duplicate.diagnostics.diagnostics[1].source_event_id = duplicate.diagnostics.diagnostics[0].source_event_id;
    duplicate.exclusions.exclusions.sort((left, right) => left.source_event_id.localeCompare(right.source_event_id));
    duplicate.diagnostics.diagnostics.sort((left, right) => left.source_event_id.localeCompare(right.source_event_id));
    rehashBundle(duplicate);
    await expectCode("PROPOSITION_POLICY_PUSH_ORDER_INVALID", () => shadow.validatePropositionPolicyPushBundle(duplicate));

    await buildLifecycleChainFixture(lifecycleHome);
    const lifecycleBundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: lifecycleHome, repoRoot, registryPath });
    assert(lifecycleBundle.entries.entries[0].lifecycle.lineage.length === 3, "lifecycle adversarial fixture does not have three contiguous events");

    const fabricatedTerminal = clone(lifecycleBundle);
    fabricatedTerminal.manifest.source.source_resolution_inventory[0].lifecycle.terminal_event_id = "f".repeat(64);
    fabricatedTerminal.entries.entries[0].lifecycle.terminal_event_id = "f".repeat(64);
    rehashBundle(fabricatedTerminal);
    await expectCode("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", () => shadow.validatePropositionPolicyPushBundle(fabricatedTerminal));

    const foreignLifecycle = clone(lifecycleBundle);
    foreignLifecycle.manifest.source.source_resolution_inventory[0].lifecycle.lineage[1].event_id = "a".repeat(64);
    foreignLifecycle.manifest.source.source_resolution_inventory[0].lifecycle.lineage_event_ids[1] = "a".repeat(64);
    rehashBundle(foreignLifecycle);
    await expectCode("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", () => shadow.validatePropositionPolicyPushBundle(foreignLifecycle));

    const reordered = clone(lifecycleBundle);
    reordered.manifest.source.source_resolution_inventory[0].lifecycle.lineage.reverse();
    reordered.manifest.source.source_resolution_inventory[0].lifecycle.lineage_event_ids.reverse();
    rehashBundle(reordered);
    await expectCode("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", () => shadow.validatePropositionPolicyPushBundle(reordered));

    const gapped = clone(lifecycleBundle);
    gapped.manifest.source.source_resolution_inventory[0].lifecycle.lineage.splice(1, 1);
    gapped.manifest.source.source_resolution_inventory[0].lifecycle.lineage_event_ids.splice(1, 1);
    rehashBundle(gapped);
    await expectCode("PROPOSITION_POLICY_PUSH_SOURCE_RESOLUTION_INVALID", () => shadow.validatePropositionPolicyPushBundle(gapped));

    for (const altered of [omission, extra, duplicate, fabricatedTerminal, foreignLifecycle, reordered, gapped]) {
      for (const name of ["entries.json", "exclusions.json", "diagnostics.json", "manifest.json"]) assert(altered.bytes[name] === canonicalJson(JSON.parse(altered.bytes[name])), `${name} adversarial bytes are not exact JCS`);
    }
  } finally {
    fs.rmSync(partitionHome, { recursive: true, force: true });
    fs.rmSync(lifecycleHome, { recursive: true, force: true });
  }
});

await check("AST runtime graph covers all 25 roots and rejects transitive re-export and dynamic require while ignoring outside-root temp scripts", async () => {
  const corePath = path.join(repoRoot, "extensions/_shared/proposition-policy-push-shadow.ts");
  const coreSource = fs.readFileSync(corePath, "utf8");
  for (const forbidden of ["constraint-compiler", "event-scan", "compiled-view", "constraint-shadow", "proposition-knowledge-shadow", "readLatestPropositionKnowledgeShadow"]) assert(!coreSource.includes(forbidden), `core references ${forbidden}`);
  assert(coreSource.includes("scanWholeL1Validated") && coreSource.includes("resolvePropositionLifecycleEffectiveState"), "core does not directly reuse scanner/resolver");

  const actual = await preview.captureRuntimeIsolation(repoRoot);
  assert(actual.exact && actual.dependency_graph.roots.length === 25, "runtime graph does not cover exact package roots");
  assert(actual.package_pi_extensions_hash === preview.P1B_AUTHORIZED_PI_EXTENSIONS_JCS_SHA256, "package extension baseline hash drifted");
  assert(actual.runtime_violations.length === 0 && actual.dependency_graph.unresolved_dynamic_loaders.length === 0, "runtime graph has violations");
  assert(actual.dependency_graph.files.every((row) => !row.path.startsWith("scripts/") && !row.path.includes("_tmp_realpreview")), "runtime graph scanned a script outside runtime roots");

  const allowed = createRuntimeGraphFixture("outside-root");
  const reexport = createRuntimeGraphFixture("reexport");
  const dynamic = createRuntimeGraphFixture("dynamic");
  try {
    fs.writeFileSync(path.join(allowed.root, "_tmp_realpreview-adversarial.mjs"), 'export * from "./extensions/_shared/proposition-policy-push-shadow";\n', "utf8");
    const allowedResult = await preview.captureRuntimeIsolation(allowed.root);
    assert(allowedResult.exact && allowedResult.runtime_violations.length === 0, "outside-root temp script became a runtime consumer");

    const bridge = path.join(path.dirname(reexport.firstRoot), "bridge.ts");
    fs.writeFileSync(reexport.firstRoot, 'export * from "./bridge";\n', "utf8");
    fs.writeFileSync(bridge, 'export * from "../_shared/proposition-policy-push-shadow";\n', "utf8");
    await expectCode("PROPOSITION_POLICY_PUSH_RUNTIME_CONSUMER_DETECTED", () => preview.captureRuntimeIsolation(reexport.root));

    fs.writeFileSync(dynamic.firstRoot, 'const target = "./dynamic-target";\nrequire(target);\nexport default function fixture() {}\n', "utf8");
    await expectCode("STATIC_DEPENDENCY_DYNAMIC_LOADER", () => preview.captureRuntimeIsolation(dynamic.root));
  } finally {
    for (const fixture of [allowed, reexport, dynamic]) fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

await check("preview refuses publish/execute semantics and non-canonical dossier output before any abrain read", async () => {
  const wrongOutput = path.join(os.tmpdir(), `policy-push-wrong-${process.pid}.json`);
  await expectCode("PROPOSITION_POLICY_PUSH_DOSSIER_PATH_REJECTED", () => preview.buildPropositionPolicyPushProductionPreview({
    abrainHome: "/home/worker/.abrain",
    outputPath: wrongOutput,
    repoRoot,
    registryPath,
  }));
  assert(!fs.existsSync(wrongOutput), "rejected output path was created");
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
