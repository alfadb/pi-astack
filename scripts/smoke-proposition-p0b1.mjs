#!/usr/bin/env node
/** ADR0040 P0b.1 sandbox-only production genesis writer/dossier smoke. */
import { spawnSync } from "node:child_process";
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
const writer = jiti(path.join(repoRoot, "extensions/_shared/proposition-genesis-writer.ts"));
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-proposition-p0b1-${label}-`));
}

function writeEnvelope(abrainHome, envelope) {
  const file = l1.expectedL1EventPath(abrainHome, envelope.event_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, l1.canonicalL1EnvelopeJson(envelope), "utf8");
  return file;
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function selfHashDossier(dossier) {
  const copy = clone(dossier);
  delete copy.dossier_hash;
  return jcs.jcsSha256Hex(copy);
}

console.log("ADR0040 P0b.1 proposition production genesis sandbox smoke");

await check("production genesis producer is registered but remains defined-inactive/non-writable", () => {
  const registry = l1.loadL1SchemaRegistry();
  const genesis = l1.resolveL1EnvelopeSchema(registry, prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA);
  assert(genesis.phase === "defined_inactive", `phase=${genesis.phase}`);
  assert(genesis.write_enabled === false && genesis.fold_eligible === false, "genesis registration became writable/foldable");
  assert(genesis.producers.includes(prop.PROPOSITION_SCHEMA_CONTRACT_PRODUCER), "schema contract producer missing");
  assert(genesis.producers.includes(prop.PROPOSITION_PRODUCTION_GENESIS_PRODUCER), "production genesis producer missing");
});

await check("production tuple preserves historical registry/schema provenance across current registry evolution", async () => {
  const home = tempHome("tuple");
  try {
    const tuple = await writer.prepareProductionPropositionGenesisTuple({ sandboxAbrainHome: home });
    const body = tuple.envelope.body;
    assert(body.epoch.epoch_id === prop.PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, "epoch id drifted");
    assert(body.epoch.genesis_scope === "production", "genesis scope drifted");
    assert(body.contract.kind === "production_genesis", "contract kind drifted");
    assert(body.producer.name === prop.PROPOSITION_PRODUCTION_GENESIS_PRODUCER, "producer drifted");
    const historical = writer.PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING;
    const current = await writer.computeCurrentPropositionSchemaAnchors();
    assert(body.contract.binding.manifest.registry.registry_id === tuple.registry_id, "historical registry id not bound");
    assert(body.contract.binding.manifest.registry.registry_canonical_sha256 === historical.registry_canonical_sha256, "historical registry canonical hash not bound");
    assert(body.contract.binding.manifest.registry.registry_file_sha256 === historical.registry_file_sha256, "historical registry file hash not bound");
    assert(body.contract.binding.manifest.proposition_schema_contract.schema_contract_hash === historical.proposition_schema_contract_hash, "historical schema contract hash not bound");
    assert(body.contract.binding.manifest_hash === historical.binding_manifest_hash, "historical binding manifest hash mismatch");
    assert(current.registry_file_sha256 !== historical.registry_file_sha256, "current registry was incorrectly required to equal genesis provenance");
    assert(current.proposition_schema_contract_hash !== historical.proposition_schema_contract_hash, "current schema contract was incorrectly required to equal genesis provenance");
    assert(!Object.hasOwn(body.epoch, "genesis_event_id"), "genesis body must not self-reference its event id");
    assert(tuple.event_id === tuple.envelope.body_hash, "event_id/body_hash mismatch");
    assert(tuple.relative_path === l1.expectedL1EventRelativePath(tuple.event_id), "relative path mismatch");
    assert(tuple.canonical_envelope_json === l1.canonicalL1EnvelopeJson(tuple.envelope), "canonical envelope bytes mismatch");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("generic validateL1WritePreflight still rejects proposition production genesis", async () => {
  const home = tempHome("generic-gate");
  try {
    const tuple = await writer.prepareProductionPropositionGenesisTuple({ sandboxAbrainHome: home });
    await expectCode("L1_SCHEMA_WRITE_DISABLED", () => l1.validateL1WritePreflight({
      abrainHome: home,
      envelope: tuple.envelope,
      targetPath: tuple.target_path,
      expected: {
        envelopeSchema: prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
        domain: "proposition",
        role: "meta",
        producer: prop.PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
        eventType: "proposition_genesis_declared",
      },
    }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("fresh sandbox writes exactly one inactive production genesis and idempotent rerun is identical", async () => {
  const home = tempHome("fresh");
  try {
    const beforeFiles = listFiles(home);
    assert(beforeFiles.length === 0, "fresh sandbox was not empty");
    const first = await writer.writeProductionPropositionGenesis({ sandboxAbrainHome: home });
    assert(first.status === "created", `first status=${first.status}`);
    assert(first.before.total === 0, `before total=${first.before.total}`);
    assert(first.after.total === 1, `after total=${first.after.total}`);
    assert(first.after.propositionGenesis === 1 && first.after.productionGenesis === 1, "expected one production genesis");
    assert(first.after.schemaContractGenesis === 0, "schema contract genesis must not be written");
    assert(first.after.selected === 0 && first.after.foldable === 0, "inactive genesis entered selected/foldable sets");
    assert(first.after.propositionEvidence === 0 && first.after.propositionLifecycle === 0 && first.after.propositionProjection === 0, "non-genesis proposition event appeared");
    const reader = await writer.readProductionPropositionGenesisEvent({ sandboxAbrainHome: home, eventId: first.tuple.event_id });
    assert(reader.byte_identical, "reader did not return byte-identical canonical fixture");
    assert(reader.raw === first.tuple.canonical_envelope_json, "raw reader bytes differ from writer bytes");
    const afterFirst = listFiles(home);
    assert(JSON.stringify(afterFirst) === JSON.stringify([first.tuple.relative_path]), `unexpected files: ${JSON.stringify(afterFirst)}`);
    const second = await writer.writeProductionPropositionGenesis({ sandboxAbrainHome: home });
    assert(second.status === "identical", `second status=${second.status}`);
    assert(second.tuple.event_id === first.tuple.event_id, "idempotent rerun event id drifted");
    assert(JSON.stringify(listFiles(home)) === JSON.stringify(afterFirst), "idempotent rerun changed file inventory");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("same event id with different on-disk bytes fails no-replace collision", async () => {
  const home = tempHome("collision");
  try {
    const tuple = await writer.prepareProductionPropositionGenesisTuple({ sandboxAbrainHome: home });
    fs.mkdirSync(path.dirname(tuple.target_path), { recursive: true });
    fs.writeFileSync(tuple.target_path, `${JSON.stringify(tuple.envelope, null, 2)}\n`, "utf8");
    await expectCode("PROPOSITION_GENESIS_COLLISION", () => writer.writeProductionPropositionGenesis({ sandboxAbrainHome: home }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("same epoch drift hard-fails before another production genesis can be accepted", async () => {
  const home = tempHome("epoch-drift");
  try {
    const first = await writer.writeProductionPropositionGenesis({ sandboxAbrainHome: home });
    const driftBody = clone(first.tuple.envelope.body);
    driftBody.contract.notes = "same epoch drift fixture";
    const driftEnvelope = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, driftBody);
    assert(driftEnvelope.event_id !== first.tuple.event_id, "drift fixture did not change event id");
    writeEnvelope(home, driftEnvelope);
    await expectCode("PROPOSITION_GENESIS_EPOCH_DRIFT", () => writer.writeProductionPropositionGenesis({ sandboxAbrainHome: home }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("new production epoch hard-fails instead of creating a second epoch", async () => {
  const home = tempHome("epoch-conflict");
  try {
    const tuple = await writer.prepareProductionPropositionGenesisTuple({ sandboxAbrainHome: home });
    const otherBody = clone(tuple.envelope.body);
    otherBody.epoch.epoch_id = "adr0040-other-production-genesis-v1";
    otherBody.contract.binding.manifest.epoch_id = otherBody.epoch.epoch_id;
    otherBody.contract.binding.manifest_hash = jcs.jcsSha256Hex(otherBody.contract.binding.manifest);
    const otherEnvelope = prop.buildPropositionEnvelope(prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA, otherBody);
    writeEnvelope(home, otherEnvelope);
    await expectCode("PROPOSITION_GENESIS_EPOCH_CONFLICT", () => writer.writeProductionPropositionGenesis({ sandboxAbrainHome: home }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("sandbox guard rejects real abrain and symlink homes before write", async () => {
  await expectCode("PROPOSITION_GENESIS_REAL_ABRAIN_REJECTED", () => writer.writeProductionPropositionGenesis({ sandboxAbrainHome: "/home/worker/.abrain" }));
  const real = tempHome("symlink-real");
  const link = path.join(os.tmpdir(), `pi-astack-proposition-p0b1-link-${process.pid}-${Date.now()}`);
  try {
    fs.symlinkSync(real, link, "dir");
    await expectCode("PROPOSITION_GENESIS_SYMLINK_REJECTED", () => writer.writeProductionPropositionGenesis({ sandboxAbrainHome: link }));
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

await check("dossier CLI is machine-readable self-hashed and records sandbox-only mutation inventory", () => {
  const home = tempHome("dossier");
  try {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/dossier-proposition-p0b1-sandbox.mjs"), "--abrain", home], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert(result.status === 0, `dossier exited ${result.status}: ${result.stderr}`);
    const dossier = JSON.parse(result.stdout);
    assert(dossier.schema_version === "proposition-p0b1-sandbox-dossier/v1", "dossier schema drifted");
    assert(dossier.dossier_hash === selfHashDossier(dossier), "dossier self hash mismatch");
    assert(dossier.genesis.first_write_status === "created", "dossier first write was not created");
    assert(dossier.genesis.idempotent_rerun_status === "identical", "dossier rerun was not identical");
    assert(dossier.genesis.reader_byte_identical === true, "dossier reader fixture was not byte-identical");
    assert(dossier.write_gates.generic_validateL1WritePreflight.code === "L1_SCHEMA_WRITE_DISABLED", "generic write gate did not remain disabled");
    assert(dossier.after.acceptance_counts.exactly_one_defined_inactive_genesis, "dossier did not record exactly one inactive genesis");
    assert(dossier.after.acceptance_counts.selected_zero && dossier.after.acceptance_counts.foldable_zero, "dossier selected/foldable counts not zero");
    assert(dossier.after.acceptance_counts.evidence_zero && dossier.after.acceptance_counts.lifecycle_zero && dossier.after.acceptance_counts.projection_zero, "dossier non-genesis proposition count not zero");
    assert(dossier.mutation_inventory.no_l2_state_or_legacy_mutation === true, "dossier recorded L2/state/legacy mutation");
    assert(JSON.stringify(dossier.mutation_inventory.first_write.classes.l1_events) === JSON.stringify([dossier.genesis.relative_path]), "dossier L1 mutation inventory mismatch");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("P0b.1 CLI refuses the real /home/worker/.abrain path", () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/dossier-proposition-p0b1-sandbox.mjs"), "--abrain", "/home/worker/.abrain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert(result.status !== 0, "real abrain CLI invocation unexpectedly succeeded");
  assert(result.stderr.includes("PROPOSITION_GENESIS_REAL_ABRAIN_REJECTED"), result.stderr);
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
