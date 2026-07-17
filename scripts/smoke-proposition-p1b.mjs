#!/usr/bin/env node
/** ADR0040 P1b repo + read-only preview and sandbox executor smoke. Never executes production append. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { snapshotProtectedAbrain, snapshotPropositionProductionTargets } from "./proposition-smoke-protected-snapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const execute = jiti(path.join(repoRoot, "extensions/_shared/proposition-p1b-production-execute.ts"));
const preview = jiti(path.join(repoRoot, "extensions/_shared/proposition-p1b-production-preview.ts"));
const writer = jiti(path.join(repoRoot, "extensions/_shared/proposition-evidence-writer.ts"));
const genesis = jiti(path.join(repoRoot, "extensions/_shared/proposition-genesis-writer.ts"));
const shadow = jiti(path.join(repoRoot, "extensions/_shared/proposition-knowledge-shadow.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const registryPath = path.join(repoRoot, "schemas/l1-schema-role-registry.json");
const previewPath = path.join(repoRoot, preview.PROPOSITION_P1B_PREVIEW_DOSSIER_RELATIVE_PATH);
const realAbrain = "/home/worker/.abrain";
const realTarget = execute.PROPOSITION_P1B_EXPECTED_REAL_TARGET_PATH;
const realPost = path.join(repoRoot, execute.PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH);
const realIntent = path.join(repoRoot, "docs/evidence", `adr0040-p1b-execution-intent-${execute.PROPOSITION_P1B_EXPECTED_EVENT_ID.slice(0, 16)}-${jcs.sha256Hex(execute.PROPOSITION_P1B_POST_DOSSIER_RELATIVE_PATH).slice(0, 16)}.json`);
const PUBLISHER_STRESS_CONCURRENCY = 128;
const PRODUCTION_GENESIS_EVENT_ID = "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3";
const P1B_PRODUCTION_EVENT_ID = "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585";
const REAL_POLICY_PRODUCTION_EVENT_ID = "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6";
const EXPECTED_PRODUCTION_PROPOSITION_EVENT_IDS = Object.freeze([
  PRODUCTION_GENESIS_EVENT_ID,
  P1B_PRODUCTION_EVENT_ID,
  REAL_POLICY_PRODUCTION_EVENT_ID,
].sort());

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

async function expectReason(reason, fn) {
  const caught = await expectCode("NOT_AUTHORIZED", fn);
  assert(caught.detail?.reason === reason, `expected reason ${reason}, got ${JSON.stringify(caught.detail)}`);
  return caught;
}

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-proposition-p1b-${label}-`));
}

async function sandbox(label) {
  const root = tempRoot(label);
  const home = path.join(root, "abrain");
  fs.mkdirSync(home);
  await genesis.writeProductionPropositionGenesis({ sandboxAbrainHome: home, registryPath });
  return { root, home, out: path.join(root, "post.json"), ratification: path.join(root, "ratification.json") };
}

function syntheticRecord(home, out, authorizationText = execute.PROPOSITION_P1B_SYNTHETIC_AUTHORIZATION_TEXT) {
  const tupleTarget = l1.expectedL1EventPath(home, execute.PROPOSITION_P1B_EXPECTED_EVENT_ID);
  const record = {
    schema_version: execute.PROPOSITION_P1B_RATIFICATION_RECORD_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    record_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this ratification record object with record_hash omitted",
    record_hash: "",
    record_kind: "synthetic_test_fixture",
    synthetic_fixture: true,
    preview: {
      schema_version: preview.PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA,
      dossier_hash: execute.PROPOSITION_P1B_PREVIEW_DOSSIER_HASH,
      event_id: execute.PROPOSITION_P1B_EXPECTED_EVENT_ID,
      canonical_envelope_bytes_sha256: execute.PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256,
      target_path: execute.PROPOSITION_P1B_EXPECTED_REAL_TARGET_PATH,
      relative_path: execute.PROPOSITION_P1B_EXPECTED_RELATIVE_PATH,
      expected_shadow_bundle_hash: execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH,
    },
    post_execute_dossier: {
      path: out,
      repo_relative_path: null,
      repo_relative_path_sha256: null,
    },
    authorization_evidence: {
      evidence_kind: "synthetic_test_fixture",
      authorized_by: "test_fixture",
      authorization_text: authorizationText,
      authorization_text_sha256: jcs.sha256Hex(authorizationText),
    },
    authorized_actions: [
      {
        action: "append_fixed_l1_event",
        cardinality: "exactly_one",
        abrain_home: home,
        target_path: tupleTarget,
        relative_path: execute.PROPOSITION_P1B_EXPECTED_RELATIVE_PATH,
        event_id: execute.PROPOSITION_P1B_EXPECTED_EVENT_ID,
        canonical_envelope_bytes_sha256: execute.PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256,
        allowed_write_statuses: ["created", "identical"],
      },
      {
        action: "publish_deterministic_shadow_bundle",
        cardinality: "exactly_one",
        root_relative_path: shadow.PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
        bundle_hash: execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH,
        manifest_sha256: execute.PROPOSITION_P1B_EXPECTED_SHADOW_MANIFEST_SHA256,
        cards_sha256: execute.PROPOSITION_P1B_EXPECTED_SHADOW_CARDS_SHA256,
        diagnostics_sha256: execute.PROPOSITION_P1B_EXPECTED_SHADOW_DIAGNOSTICS_SHA256,
        exclusions_sha256: execute.PROPOSITION_P1B_EXPECTED_SHADOW_EXCLUSIONS_SHA256,
        latest_pointer: `${shadow.PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE}/latest`,
      },
    ],
    constraints: {
      generic_write_gate_must_remain: "L1_SCHEMA_WRITE_DISABLED",
      no_l2_write: true,
      no_live_consumer_wiring: true,
      no_legacy_mutation: true,
      no_registry_mutation: true,
      no_environment_or_force_bypass: true,
    },
  };
  record.record_hash = execute.selfHashPropositionP1bRatificationRecord(record);
  return record;
}

function writeRecord(file, record) {
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function options(fixture) {
  return {
    abrainHome: fixture.home,
    previewDossierPath: previewPath,
    ratificationRecordPath: fixture.ratification,
    outputPath: fixture.out,
    registryPath,
    repoRoot,
    allowSyntheticRatificationForSandboxOnly: true,
  };
}

function sandboxIntentPath(fixture) {
  return path.join(path.dirname(fixture.out), `.adr0040-p1b-execution-intent-${execute.PROPOSITION_P1B_EXPECTED_EVENT_ID.slice(0, 16)}.json`);
}

function shadowRoot(home) {
  return path.join(home, ...shadow.PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE.split("/"));
}

function durableTempResidues(root) {
  const residues = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (/^\..+\.tmp$/.test(entry.name)) residues.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return residues.sort();
}

async function assertSingleShadowPublication(home, expectedHash, expectedCardCount) {
  const root = shadowRoot(home);
  const rootEntries = fs.readdirSync(root, { withFileTypes: true });
  assert(JSON.stringify(rootEntries.map((entry) => entry.name).sort()) === JSON.stringify(["bundles", "latest"]), `shadow root entries=${JSON.stringify(rootEntries.map((entry) => entry.name).sort())}`);
  const bundles = fs.readdirSync(path.join(root, "bundles"), { withFileTypes: true });
  assert(bundles.length === 1 && bundles[0].isDirectory() && bundles[0].name === expectedHash, `shadow bundle entries=${JSON.stringify(bundles.map((entry) => ({ name: entry.name, directory: entry.isDirectory() })))}`);
  const latestPath = path.join(root, "latest");
  assert(fs.lstatSync(latestPath).isSymbolicLink(), "latest is not a symlink");
  assert(fs.readlinkSync(latestPath) === `bundles/${expectedHash}`, `latest target=${fs.readlinkSync(latestPath)}`);
  const latest = await shadow.readLatestPropositionKnowledgeShadow({ abrainHome: home });
  assert(latest.manifest.bundle_hash === expectedHash && latest.cards.cards.length === expectedCardCount, "latest validated bundle/card count mismatch");
}

function assertNoRejectedRecoveryArtifacts(fixture) {
  assert(!fs.existsSync(sandboxIntentPath(fixture)), "rejected recovery created an execution intent");
  assert(!fs.existsSync(shadowRoot(fixture.home)), "rejected recovery created a shadow bundle");
  assert(!fs.existsSync(fixture.out), "rejected recovery created a post dossier");
  assert(durableTempResidues(fixture.root).length === 0, `rejected recovery left temp residue: ${JSON.stringify(durableTempResidues(fixture.root))}`);
}

console.log("ADR0040 P1b repo + read-only production preview smoke");

await check("dedicated producer is the only registry delta and generic write gate remains disabled", async () => {
  const registry = l1.loadL1SchemaRegistry(registryPath);
  const evidence = l1.resolveL1EnvelopeSchema(registry, "proposition-evidence-envelope/v1");
  assert(evidence.phase === "defined_inactive" && !evidence.write_enabled && !evidence.fold_eligible, "evidence entry phase/body flags changed");
  assert(JSON.stringify(evidence.producers) === JSON.stringify(["pi-astack.proposition-schema-contract", writer.PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER]), `producer allowlist drifted: ${JSON.stringify(evidence.producers)}`);
  const tuple = await writer.prepareFixedProductionPropositionEvidenceTuple({ abrainHome: realAbrain, registryPath });
  await expectCode("L1_SCHEMA_WRITE_DISABLED", () => l1.validateL1WritePreflight({ abrainHome: realAbrain, envelope: tuple.envelope, targetPath: tuple.target_path, registry }));
});

await check("fixed tuple is exact and the dedicated writer refuses every altered tuple", async () => {
  const tuple = await writer.prepareFixedProductionPropositionEvidenceTuple({ abrainHome: realAbrain, registryPath });
  assert(tuple.event_id === execute.PROPOSITION_P1B_EXPECTED_EVENT_ID, "event id drifted");
  assert(tuple.canonical_envelope_bytes_sha256 === execute.PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256, "canonical bytes hash drifted");
  assert(tuple.envelope.body.proposition.language === "zh" && tuple.envelope.body.proposition.modality === "normative", "language/modality drifted");
  assert(tuple.envelope.body.facets.provenance_authority.source_event_id === null, "transcript message id leaked into source_event_id");
  assert(tuple.envelope.body.facets.trigger.trigger_ref === writer.PROPOSITION_P1B_FIXED_TRIGGER_REF, "trigger ref drifted");
  assert(Object.values(tuple.envelope.body.facets.lineage).every((value) => Array.isArray(value) && value.length === 0), "lineage arrays are not empty");
  const altered = JSON.parse(JSON.stringify(tuple.envelope));
  altered.body.proposition.language = "zh-CN";
  await expectCode("PROPOSITION_P1B_TUPLE_REFUSED", () => writer.assertExactFixedProductionPropositionEvidenceTuple(altered));
});

await check("production genesis binding remains historical while current registry/schema anchors advance", async () => {
  const anchors = await genesis.computeCurrentPropositionSchemaAnchors(registryPath);
  const historical = genesis.PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING;
  assert(anchors.registry_file_sha256 === "1780f3745fbe251a10ae797f23106290f7df70c13a979514ac0bbb2a3f30246d", "current registry file anchor drifted");
  assert(anchors.proposition_schema_contract_hash === "4b7a9d28b64040eb55471b72e865ed11970d11be223979fb1566ebe65ab46d2e", "current schema contract anchor drifted");
  assert(anchors.registry_file_sha256 !== historical.registry_file_sha256 && anchors.proposition_schema_contract_hash !== historical.proposition_schema_contract_hash, "current anchors were conflated with historical genesis provenance");
  const tuple = await genesis.prepareFixedProductionPropositionGenesisTuple({ abrainHome: realAbrain, registryPath });
  assert(tuple.event_id === writer.PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID, "historical genesis event id changed");
  assert(tuple.registry_file_sha256 === historical.registry_file_sha256, "historical genesis registry provenance changed");
});

await check("exact production authorization accepts canonical/diagnostics and rejects every negation before positive matching", async () => {
  const exactTemplate = execute.buildPropositionP1bExactAuthorizationTemplate(repoRoot);
  assert(exactTemplate.includes("canonical envelope bytes") && exactTemplate.includes("diagnostics sha256"), "real template no longer exercises ASCII substring false-positive cases");
  execute.assertPropositionP1bExactAuthorizationText(exactTemplate, repoRoot);
  for (const term of execute.PROPOSITION_P1B_AUTHORIZATION_NEGATION_TERMS) {
    const variant = /^[a-z]+$/.test(term) ? `${term}; ${exactTemplate}` : `前缀${term}后缀；${exactTemplate}`;
    await expectReason("TRANSCRIPT_TEXT_NEGATED_AUTHORIZATION", () => execute.assertPropositionP1bExactAuthorizationText(variant, repoRoot));
  }
  await expectReason("TRANSCRIPT_TEXT_DUPLICATED_AUTHORIZATION", () => execute.assertPropositionP1bExactAuthorizationText(`${exactTemplate}；${exactTemplate}`, repoRoot));
});

await check("superseding committed preview and current protected production surfaces validate read-only", async () => {
  const before = snapshotPropositionProductionTargets(realAbrain, [execute.PROPOSITION_P1B_EXPECTED_RELATIVE_PATH]);
  const committed = JSON.parse(fs.readFileSync(previewPath, "utf8"));
  preview.validatePropositionP1bPreviewDossier(committed);
  assert(committed.dossier_hash === execute.PROPOSITION_P1B_PREVIEW_DOSSIER_HASH, "committed preview dossier hash drifted");
  assert(committed.mutation_proof.unchanged === true && committed.mutation_proof.target_absent_after === true, "committed production full-snapshot proof failed");
  assert(committed.attestation.message_id === "e5b235e8" && committed.attestation.message_line_number === 145, "attestation transcript binding drifted");
  const tuple = await writer.prepareFixedProductionPropositionEvidenceTuple({ abrainHome: realAbrain, registryPath });
  assert(tuple.event_id === execute.PROPOSITION_P1B_EXPECTED_EVENT_ID && tuple.canonical_envelope_bytes_sha256 === execute.PROPOSITION_P1B_EXPECTED_CANONICAL_BYTES_SHA256, "current fixed tuple drifted");
  const after = snapshotPropositionProductionTargets(realAbrain, [execute.PROPOSITION_P1B_EXPECTED_RELATIVE_PATH]);
  assert(before.sha256 === after.sha256 && before.count === after.count, "P1b read-only checks changed real owned proposition targets");
});

await check("missing, bad and duplicated synthetic ratification fail closed before sandbox append", async () => {
  const fixture = await sandbox("ratification-faults");
  try {
    const missing = { ...options(fixture), ratificationRecordPath: "" };
    await expectCode("NOT_AUTHORIZED", () => execute.executePropositionP1b(missing));
    assert(!fs.existsSync(l1.expectedL1EventPath(fixture.home, execute.PROPOSITION_P1B_EXPECTED_EVENT_ID)), "missing ratification appended evidence");

    const bad = syntheticRecord(fixture.home, fixture.out);
    bad.record_hash = "0".repeat(64);
    writeRecord(fixture.ratification, bad);
    await expectCode("NOT_AUTHORIZED", () => execute.executePropositionP1b(options(fixture)));
    assert(!fs.existsSync(l1.expectedL1EventPath(fixture.home, execute.PROPOSITION_P1B_EXPECTED_EVENT_ID)), "bad ratification appended evidence");

    const duplicated = syntheticRecord(fixture.home, fixture.out, `${execute.PROPOSITION_P1B_SYNTHETIC_AUTHORIZATION_TEXT} ${execute.PROPOSITION_P1B_SYNTHETIC_AUTHORIZATION_TEXT}`);
    writeRecord(fixture.ratification, duplicated);
    await expectCode("NOT_AUTHORIZED", () => execute.executePropositionP1b(options(fixture)));
    assert(!fs.existsSync(l1.expectedL1EventPath(fixture.home, execute.PROPOSITION_P1B_EXPECTED_EVENT_ID)), "duplicated ratification appended evidence");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check(`fresh absent shadow root survives ${PUBLISHER_STRESS_CONCURRENCY}-way publisher mkdir pressure with typed convergence`, async () => {
  const fixture = await sandbox("publisher-stress");
  try {
    assert(!fs.existsSync(shadowRoot(fixture.home)), "publisher pressure fixture shadow root was not fresh");
    const publications = await Promise.all(Array.from({ length: PUBLISHER_STRESS_CONCURRENCY }, () => (
      shadow.publishPropositionKnowledgeShadow({ abrainHome: fixture.home, repoRoot, registryPath })
    )));
    const expectedHash = publications[0].bundle.manifest.bundle_hash;
    assert(publications.every((publication) => Object.isFrozen(publication) && publication.latest_status === "published" && ["created", "identical"].includes(publication.bundle_status)), "publisher pressure returned an untyped result");
    assert(publications.filter((publication) => publication.bundle_status === "created").length === 1, "publisher pressure did not have exactly one bundle creator");
    assert(publications.every((publication) => publication.bundle.manifest.bundle_hash === expectedHash), "publisher pressure bundle hashes differ");
    await assertSingleShadowPublication(fixture.home, expectedHash, 0);
    assert(durableTempResidues(fixture.root).length === 0, `publisher pressure left temp residue: ${JSON.stringify(durableTempResidues(fixture.root))}`);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check("sandbox execution creates one fixed event and exactly one non-empty expected shadow card", async () => {
  const fixture = await sandbox("execute");
  try {
    writeRecord(fixture.ratification, syntheticRecord(fixture.home, fixture.out));
    const dossier = await execute.writePropositionP1bPostExecuteDossier(options(fixture));
    execute.validatePostExecuteDossier(dossier);
    assert(dossier.event.first_status === "created" && dossier.event.immediate_rerun_status === "identical", "event no-replace statuses drifted");
    assert(dossier.execution_intent.no_replace_status === "created" && dossier.execution_intent.intent_before_append === true, "fresh execution did not durably create intent before append");
    assert(dossier.shadow.bundle_hash === execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH && dossier.shadow.card_count === 1, "shadow output drifted");
    assert(dossier.invariants.protected_abrain_unchanged === true && dossier.invariants.generic_write_gate_after === "L1_SCHEMA_WRITE_DISABLED", "protected invariants failed");
    const latest = await shadow.readLatestPropositionKnowledgeShadow({ abrainHome: fixture.home });
    assert(latest.cards.cards.length === 1 && latest.cards.cards[0].source_event_id === execute.PROPOSITION_P1B_EXPECTED_EVENT_ID, "latest shadow card mismatch");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check("fresh absent shadow root with concurrent identical sandbox executors converges on one event, one bundle and no temp residue", async () => {
  const fixture = await sandbox("concurrent");
  try {
    writeRecord(fixture.ratification, syntheticRecord(fixture.home, fixture.out));
    assert(!fs.existsSync(shadowRoot(fixture.home)), "concurrent executor fixture shadow root was not fresh");
    const [left, right] = await Promise.all([execute.executePropositionP1b(options(fixture)), execute.executePropositionP1b(options(fixture))]);
    assert(Object.isFrozen(left) && Object.isFrozen(right), "concurrent executors returned an untyped result");
    assert([left.event.first_status, right.event.first_status].includes("created"), "neither concurrent executor created the event");
    assert(left.shadow.bundle_hash === right.shadow.bundle_hash && left.shadow.bundle_hash === execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, "concurrent bundle hashes differ");
    const scan = await l1.scanWholeL1Validated({ abrainHome: fixture.home, registryPath });
    assert(scan.all.filter((record) => record.registration.domain === "proposition").length === 2, "concurrent execution did not converge to genesis+one evidence");
    await assertSingleShadowPublication(fixture.home, execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, 1);
    assert(durableTempResidues(fixture.root).length === 0, `concurrent executor temp residue remained: ${JSON.stringify(durableTempResidues(fixture.root))}`);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check("orphan identical target without intent rejects before any recovery mutation", async () => {
  const fixture = await sandbox("orphan-target");
  try {
    writeRecord(fixture.ratification, syntheticRecord(fixture.home, fixture.out));
    const appended = await writer.appendFixedProductionPropositionEvidenceSandbox({ sandboxAbrainHome: fixture.home, registryPath });
    assert(appended.status === "created", "orphan fixture did not create the target");
    const before = snapshotProtectedAbrain(fixture.home);
    await expectCode("PROPOSITION_P1B_RECOVERY_INTENT_MISSING", () => execute.executePropositionP1b(options(fixture)));
    const after = snapshotProtectedAbrain(fixture.home);
    assert(before.sha256 === after.sha256 && before.count === after.count, "orphan-target rejection mutated protected sandbox surfaces");
    assertNoRejectedRecoveryArtifacts(fixture);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check("identical target with malformed intent rejects with intent and all target surfaces unchanged", async () => {
  const fixture = await sandbox("bad-intent");
  try {
    writeRecord(fixture.ratification, syntheticRecord(fixture.home, fixture.out));
    await writer.appendFixedProductionPropositionEvidenceSandbox({ sandboxAbrainHome: fixture.home, registryPath });
    const intentPath = sandboxIntentPath(fixture);
    fs.writeFileSync(intentPath, "{}\n", "utf8");
    const intentBefore = fs.readFileSync(intentPath, "utf8");
    const before = snapshotProtectedAbrain(fixture.home);
    await expectCode("PROPOSITION_P1B_INTENT_INVALID", () => execute.executePropositionP1b(options(fixture)));
    const after = snapshotProtectedAbrain(fixture.home);
    assert(before.sha256 === after.sha256 && before.count === after.count, "bad-intent rejection mutated protected sandbox surfaces");
    assert(fs.readFileSync(intentPath, "utf8") === intentBefore, "bad intent was replaced or modified");
    assert(!fs.existsSync(shadowRoot(fixture.home)), "bad-intent rejection created a shadow bundle");
    assert(!fs.existsSync(fixture.out), "bad-intent rejection created a post dossier");
    assert(durableTempResidues(fixture.root).length === 0, `bad-intent rejection left temp residue: ${JSON.stringify(durableTempResidues(fixture.root))}`);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check("concurrent recoveries validate one prior intent and converge without dossier or temp creation", async () => {
  const fixture = await sandbox("concurrent-recovery");
  try {
    writeRecord(fixture.ratification, syntheticRecord(fixture.home, fixture.out));
    const first = await execute.executePropositionP1b(options(fixture));
    assert(first.event.first_status === "created", "concurrent-recovery fixture did not create the event");
    fs.rmSync(shadowRoot(fixture.home), { recursive: true, force: true });
    assert(!fs.existsSync(shadowRoot(fixture.home)), "concurrent recovery shadow root removal failed");
    const [left, right] = await Promise.all([
      execute.executePropositionP1b(options(fixture)),
      execute.executePropositionP1b(options(fixture)),
    ]);
    assert(Object.isFrozen(left) && Object.isFrozen(right), "concurrent recoveries returned an untyped result");
    assert(left.execution_intent.no_replace_status === "existing_valid" && right.execution_intent.no_replace_status === "existing_valid", "concurrent recovery did not validate the prior intent");
    assert(left.event.first_status === "identical" && right.event.first_status === "identical", "concurrent recovery did not preserve the identical event");
    assert(left.shadow.bundle_hash === right.shadow.bundle_hash && left.shadow.bundle_hash === execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, "concurrent recovery shadow hashes differ");
    await assertSingleShadowPublication(fixture.home, execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, 1);
    assert(!fs.existsSync(fixture.out), "direct concurrent recovery created a post dossier");
    assert(durableTempResidues(fixture.root).length === 0, `concurrent recovery left temp residue: ${JSON.stringify(durableTempResidues(fixture.root))}`);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check("event-created interruption recovers from identical intent and rebuilds deterministic shadow", async () => {
  const fixture = await sandbox("recovery");
  try {
    writeRecord(fixture.ratification, syntheticRecord(fixture.home, fixture.out));
    const first = await execute.executePropositionP1b(options(fixture));
    assert(first.event.first_status === "created", "first execution did not create event");
    fs.rmSync(path.join(fixture.home, ...shadow.PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE.split("/")), { recursive: true, force: true });
    const recovered = await execute.executePropositionP1b(options(fixture));
    assert(recovered.execution_intent.recovery === true && recovered.execution_intent.no_replace_status === "existing_valid", "recovery did not validate and reuse the prior intent");
    assert(recovered.event.first_status === "identical" && recovered.shadow.bundle_hash === execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, "recovery did not converge event/shadow");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

await check("symlink, output path and target identity attacks fail closed", async () => {
  const fixture = await sandbox("path-attacks");
  const outside = tempRoot("outside");
  const linkedHome = path.join(fixture.root, "linked-abrain");
  try {
    writeRecord(fixture.ratification, syntheticRecord(fixture.home, fixture.out));
    fs.symlinkSync(fixture.home, linkedHome, "dir");
    await expectCode("PROPOSITION_P1B_ABRAIN_UNSAFE", () => execute.executePropositionP1b({ ...options(fixture), abrainHome: linkedHome }));

    const ratificationLink = path.join(fixture.root, "ratification-link.json");
    fs.symlinkSync(fixture.ratification, ratificationLink);
    await expectCode("NOT_AUTHORIZED", () => execute.executePropositionP1b({ ...options(fixture), ratificationRecordPath: ratificationLink }));

    const symlinkOut = path.join(fixture.root, "symlink-post.json");
    fs.symlinkSync(path.join(outside, "rogue.json"), symlinkOut);
    await expectCode("PROPOSITION_P1B_OUTPUT_UNSAFE", () => execute.writePropositionP1bPostExecuteDossier({ ...options(fixture), outputPath: symlinkOut }));
    assert(!fs.existsSync(path.join(outside, "rogue.json")), "output symlink created rogue file");

    const target = l1.expectedL1EventPath(fixture.home, execute.PROPOSITION_P1B_EXPECTED_EVENT_ID);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}\n", "utf8");
    await expectCode("PROPOSITION_P1B_COLLISION", () => execute.executePropositionP1b(options(fixture)));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

await check("production executor missing-ratification path remains fail-closed without mutating completed production artifacts", async () => {
  const before = snapshotPropositionProductionTargets(realAbrain, [execute.PROPOSITION_P1B_EXPECTED_RELATIVE_PATH]);
  await expectCode("NOT_AUTHORIZED", () => execute.preflightPropositionP1bProductionExecute({
    abrainHome: realAbrain,
    previewDossierPath: previewPath,
    ratificationRecordPath: "",
    outputPath: realPost,
    registryPath,
    repoRoot,
  }));
  const after = snapshotPropositionProductionTargets(realAbrain, [execute.PROPOSITION_P1B_EXPECTED_RELATIVE_PATH]);
  assert(before.sha256 === after.sha256 && before.count === after.count, "missing-ratification preflight changed real owned proposition targets");
  assert(fs.existsSync(realTarget), "completed production target disappeared after missing-ratification preflight");
  assert(fs.existsSync(realPost), "completed production post dossier disappeared after missing-ratification preflight");
  assert(fs.existsSync(realIntent), "completed production intent disappeared after missing-ratification preflight");
});

await check("real production has the three known proposition events while the P1b shadow remains the beee card", async () => {
  const scan = await l1.scanWholeL1Validated({ abrainHome: realAbrain, registryPath });
  const proposition = scan.all.filter((record) => record.registration.domain === "proposition");
  const productionIds = proposition.map((record) => record.eventId).sort();
  assert(JSON.stringify(productionIds) === JSON.stringify(EXPECTED_PRODUCTION_PROPOSITION_EVENT_IDS), `live proposition ids=${JSON.stringify(productionIds)}`);
  assert(!scan.selected.some((record) => record.registration.domain === "proposition"), "completed proposition entered selected set");
  assert(!scan.foldable.some((record) => record.registration.domain === "proposition"), "completed proposition entered foldable set");
  const tuple = await writer.prepareFixedProductionPropositionEvidenceTuple({ abrainHome: realAbrain, registryPath });
  assert(fs.readFileSync(realTarget, "utf8") === tuple.canonical_envelope_json, "completed production target bytes drifted");
  const latest = await shadow.readLatestPropositionKnowledgeShadow({ abrainHome: realAbrain });
  assert(latest.manifest.bundle_hash === execute.PROPOSITION_P1B_EXPECTED_SHADOW_BUNDLE_HASH, "completed production shadow bundle hash drifted");
  assert(latest.cards.cards.length === 1 && latest.cards.cards[0].source_event_id === P1B_PRODUCTION_EVENT_ID, "completed production shadow card drifted");
  assert(latest.manifest.result.exclusion_count === 0 && latest.manifest.result.diagnostic_count === 0, "completed production shadow emitted exclusions or diagnostics");
  const post = JSON.parse(fs.readFileSync(realPost, "utf8"));
  execute.validatePostExecuteDossier(post);
  const intent = JSON.parse(fs.readFileSync(realIntent, "utf8"));
  const intentHash = intent.intent_hash;
  delete intent.intent_hash;
  assert(jcs.jcsSha256Hex(intent) === intentHash, "completed production intent self-hash drifted");
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
