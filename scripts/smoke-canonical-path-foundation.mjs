#!/usr/bin/env node
/** Canonical-path R3.4.2 P1-S3 foundation smoke. Synthetic fixtures only. */
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
const durable = jiti(path.join(repoRoot, "extensions/_shared/durable-write.ts"));
const transition = jiti(path.join(repoRoot, "extensions/_shared/transition-register.ts"));
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-canonical-foundation-${label}-`));
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

function writeEnvelope(abrainHome, envelope, relativePath = l1.expectedL1EventRelativePath(envelope.event_id)) {
  const file = path.join(abrainHome, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, "utf8");
  return file;
}

function standardEnvelopes() {
  return [
    envelopeFor("knowledge-evidence-envelope/v1", activeBody("knowledge")),
    envelopeFor("constraint-evidence-envelope/v1", activeBody("constraint-evidence")),
    envelopeFor("constraint-projection-envelope/v1", activeBody("constraint-projection")),
  ];
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function strictDurableResidueName(eventId, loop, index) {
  const nonce = (loop * 32 + index).toString(16).padStart(16, "0");
  return `.${eventId}.json.${process.pid}.${Date.now() + loop}.${nonce}.tmp`;
}

async function scanWithoutRawEnoent(options, label) {
  try {
    return await l1.scanWholeL1Validated(options);
  } catch (err) {
    const text = String(err?.stack || err?.message || err);
    if (err?.code === "ENOENT" || text.includes("ENOENT: no such file or directory")) {
      throw new Error(`${label}: raw ENOENT escaped scanWholeL1Validated: ${text}`);
    }
    throw err;
  }
}

console.log("canonical-path P1-S3 foundation smoke");

await check("registry loads, validates, freezes, and declares only approved schema names", () => {
  const registry = l1.loadL1SchemaRegistry();
  assert(registry.schema_version === "l1-schema-role-registry/v2", `unexpected registry schema: ${registry.schema_version}`);
  assert(registry.entries.length === 16, `expected 16 entries, got ${registry.entries.length}`);
  assert(Object.isFrozen(registry) && Object.isFrozen(registry.entries), "registry is mutable");
  const active = l1.lookupL1SchemaRoles(registry, { phase: "active" });
  const legacy = l1.lookupL1SchemaRoles(registry, { phase: "legacy_read_only" });
  const future = l1.lookupL1SchemaRoles(registry, { phase: "phase_disabled" });
  const definedInactive = l1.lookupL1SchemaRoles(registry, { phase: "defined_inactive" });
  assert(active.length === 5, `expected 5 active entries, got ${active.length}`);
  assert(legacy.length === 2, `expected 2 legacy-read-only entries, got ${legacy.length}`);
  assert(future.length === 6, `expected 6 future entries, got ${future.length}`);
  assert(definedInactive.length === 3, `expected 3 defined-inactive entries, got ${definedInactive.length}`);
  const drainRecovery = active.find((entry) => entry.envelope_schema === "local-drain-recovery-envelope/v3");
  assert(drainRecovery && drainRecovery.role === "meta" && !drainRecovery.fold_eligible && drainRecovery.write_enabled, "local-drain-recovery-envelope/v3 must be active write-enabled meta-only");
  assert(JSON.stringify(legacy.map((entry) => entry.envelope_schema).sort()) === JSON.stringify(["drain-recovery-envelope/v1", "local-drain-recovery-envelope/v2"]), "v1/v2 recovery must be strict legacy read-only");
  assert(legacy.every((entry) => !entry.write_enabled && !entry.fold_eligible), "legacy recovery schemas must be non-writable and non-foldable");
  const futureNames = future.map((entry) => entry.envelope_schema).sort();
  assert(JSON.stringify(futureNames) === JSON.stringify([
    "constraint-genesis/v1",
    "knowledge-apply-receipt/v1",
    "knowledge-candidate-observation/v1",
    "knowledge-curator-attempt/v1",
    "knowledge-curator-decision/v1",
    "proposition-projection-envelope/v1",
  ]), `future schema names drifted: ${JSON.stringify(futureNames)}`);
  assert(future.every((entry) => entry.role === "meta" && !entry.write_enabled && !entry.fold_eligible), "future entries are not disabled meta-only declarations");
  const propositionContracts = definedInactive.map((entry) => entry.envelope_schema).sort();
  assert(JSON.stringify(propositionContracts) === JSON.stringify([
    "proposition-evidence-envelope/v1",
    "proposition-genesis-envelope/v1",
    "proposition-lifecycle-envelope/v1",
  ]), `defined-inactive proposition schemas drifted: ${JSON.stringify(propositionContracts)}`);
  assert(definedInactive.every((entry) => entry.domain === "proposition" && !entry.write_enabled && !entry.fold_eligible && entry.body_schema && entry.event_types?.length && entry.producers?.length), "defined-inactive proposition contracts are not complete disabled declarations");
});

await check("registry rejects duplicate envelope and body registrations", async () => {
  const raw = clone(l1.loadL1SchemaRegistry());
  raw.entries.push(clone(raw.entries[0]));
  await expectCode("L1_REGISTRY_DUPLICATE", () => l1.validateL1SchemaRegistry(raw));
  const bodyDuplicate = clone(l1.loadL1SchemaRegistry());
  bodyDuplicate.entries[1].body_schema = bodyDuplicate.entries[0].body_schema;
  await expectCode("L1_REGISTRY_DUPLICATE", () => l1.validateL1SchemaRegistry(bodyDuplicate));
});

await check("registry queries roles by envelope/body/domain/role/producer/event type", () => {
  const registry = l1.loadL1SchemaRegistry();
  const queries = [
    [{ envelopeSchema: "knowledge-evidence-envelope/v1" }, "knowledge-evidence-envelope/v1"],
    [{ bodySchema: "constraint-evidence-event/v1" }, "constraint-evidence-envelope/v1"],
    [{ domain: "constraint", role: "evidence" }, "constraint-evidence-envelope/v1"],
    [{ producer: "sediment.constraint-compiler" }, "constraint-projection-envelope/v1"],
    [{ eventType: "knowledge_entry_observed" }, "knowledge-evidence-envelope/v1"],
    [{ eventType: "action_outcome_observed" }, "outcome-evidence-envelope/v1"],
  ];
  for (const [query, expected] of queries) {
    const matches = l1.lookupL1SchemaRoles(registry, query);
    assert(matches.length === 1 && matches[0].envelope_schema === expected, `query mismatch: ${JSON.stringify(query)}`);
  }
});

await check("shared JCS is deterministic, hashes envelopes, and rejects invalid Unicode", async () => {
  const canonical = jcs.canonicalizeJcs({ z: 0, a: [1, { y: true, x: "ok" }] });
  assert(canonical === '{"a":[1,{"x":"ok","y":true}],"z":0}', canonical);
  const envelope = standardEnvelopes()[0];
  const validated = l1.validateL1Envelope(envelope, { registry: l1.loadL1SchemaRegistry() });
  assert(validated.envelopeHash === jcs.sha256Hex(jcs.canonicalizeJcs(envelope)), "envelope JCS hash mismatch");
  let rejected = false;
  try { jcs.canonicalizeJcs({ bad: "\ud800" }); } catch { rejected = true; }
  assert(rejected, "lone surrogate was accepted");
});

await check("all three existing schemas validate with body/event/domain/producer roles", () => {
  const registry = l1.loadL1SchemaRegistry();
  const expected = [
    ["knowledge", "canonical"],
    ["constraint", "evidence"],
    ["constraint", "canonical"],
  ];
  for (const [index, envelope] of standardEnvelopes().entries()) {
    const result = l1.validateL1Envelope(envelope, { registry });
    assert(result.registration.domain === expected[index][0], `domain mismatch at ${index}`);
    assert(result.registration.role === expected[index][1], `role mismatch at ${index}`);
    assert(result.eventId === result.bodyHash, `event/body hash mismatch at ${index}`);
  }
});

await check("unknown schema fails closed instead of becoming foreign-skip", async () => {
  const registry = l1.loadL1SchemaRegistry();
  const envelope = envelopeFor("unknown-envelope/v1", { fixture: "unknown" });
  await expectCode("L1_SCHEMA_UNKNOWN", () => l1.validateL1Envelope(envelope, { registry }));
  const home = tempHome("unknown");
  try {
    writeEnvelope(home, envelope);
    await expectCode("L1_SCHEMA_UNKNOWN", () => l1.scanWholeL1Validated({ abrainHome: home, registry, domains: ["constraint"] }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("producer, body schema, domain, and writer role mismatches fail closed", async () => {
  const registry = l1.loadL1SchemaRegistry();
  const badProducer = envelopeFor("knowledge-evidence-envelope/v1", activeBody("knowledge", { producer: { name: "foreign.writer", version: "smoke" } }));
  await expectCode("L1_PRODUCER_MISMATCH", () => l1.validateL1Envelope(badProducer, { registry }));
  const badBodySchema = envelopeFor("knowledge-evidence-envelope/v1", activeBody("knowledge", { event_schema_version: "constraint-evidence-event/v1" }));
  await expectCode("L1_SCHEMA_ROLE_MISMATCH", () => l1.validateL1Envelope(badBodySchema, { registry }));
  const badDomain = envelopeFor("knowledge-evidence-envelope/v1", activeBody("knowledge", { intent: { domain_hint: "constraint" } }));
  await expectCode("L1_SCHEMA_ROLE_MISMATCH", () => l1.validateL1Envelope(badDomain, { registry }));
  const valid = standardEnvelopes()[0];
  await expectCode("L1_SCHEMA_ROLE_MISMATCH", () => l1.validateL1Envelope(valid, { registry, expected: { role: "evidence" } }));
});

await check("body hash and event_id mismatches fail closed", async () => {
  const registry = l1.loadL1SchemaRegistry();
  const badBody = clone(standardEnvelopes()[0]);
  badBody.body.fixture = "tampered";
  await expectCode("L1_HASH_MISMATCH", () => l1.validateL1Envelope(badBody, { registry }));
  const badEvent = clone(standardEnvelopes()[0]);
  badEvent.event_id = "0".repeat(64);
  await expectCode("L1_HASH_MISMATCH", () => l1.validateL1Envelope(badEvent, { registry }));
});

await check("filename, shard, relative path, and absolute path are content-address checked", async () => {
  const registry = l1.loadL1SchemaRegistry();
  const envelope = standardEnvelopes()[0];
  const id = envelope.event_id;
  const valid = l1.expectedL1EventRelativePath(id);
  const otherId = `${id[0] === "0" ? "1" : "0"}${id.slice(1)}`;
  await expectCode("L1_PATH_MISMATCH", () => l1.validateL1Envelope(envelope, { registry, relativePath: valid.replace(`${id}.json`, `${otherId}.json`) }));
  await expectCode("L1_PATH_MISMATCH", () => l1.validateL1Envelope(envelope, { registry, relativePath: valid.replace(`/${id.slice(2, 4)}/`, "/ff/") }));
  await expectCode("L1_PATH_MISMATCH", () => l1.validateL1Envelope(envelope, { registry, relativePath: `l1/events/${valid}` }));
  await expectCode("L1_PATH_MISMATCH", () => l1.validateL1Envelope(envelope, { registry, abrainHome: "/tmp/abrain", filePath: "/tmp/outside.json", relativePath: valid }));
});

await check("whole-L1 scan validates everything before immutable role/domain filtering", async () => {
  const home = tempHome("scan");
  try {
    const existing = standardEnvelopes();
    for (const envelope of existing) writeEnvelope(home, envelope);
    const future = envelopeFor("knowledge-candidate-observation/v1", { fixture: "future-meta-only" });
    writeEnvelope(home, future);
    const result = await l1.scanWholeL1Validated({
      abrainHome: home,
      domains: ["constraint"],
      roles: ["evidence"],
    });
    assert(result.all.length === 4, `all=${result.all.length}`);
    assert(result.selected.length === 1 && result.selected[0].registration.envelope_schema === "constraint-evidence-envelope/v1", "constraint evidence selection mismatch");
    assert(result.foreignSkipped.length === 2, `foreign=${result.foreignSkipped.length}`);
    assert(result.phaseDisabledShadow.length === 1, `future=${result.phaseDisabledShadow.length}`);
    assert(result.foldable.length === 1 && !result.foldable.some((item) => item.eventId === future.event_id), "future meta entered foldable result");
    assert(Object.isFrozen(result) && Object.isFrozen(result.all) && Object.isFrozen(result.all[0].envelope), "scan result is mutable");
    assert(result.tempResidue.length === 0, "unexpected temp residue");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("whole-L1 scan tolerates durable-write temp residue but fails other stray names closed", async () => {
  const home = tempHome("temp-residue");
  try {
    const envelope = standardEnvelopes()[0];
    writeEnvelope(home, envelope);
    const shardDir = path.dirname(l1.expectedL1EventPath(home, envelope.event_id));
    const residueName = `.${envelope.event_id}.json.12345.1760000000000.0a1b2c3d4e5f6071.tmp`;
    fs.writeFileSync(path.join(shardDir, residueName), "partial");
    const tolerated = await l1.scanWholeL1Validated({ abrainHome: home });
    assert(tolerated.all.length === 1, `expected one event, got ${tolerated.all.length}`);
    assert(tolerated.tempResidue.length === 1 && tolerated.tempResidue[0].endsWith(residueName), "temp residue not surfaced");
    fs.writeFileSync(path.join(shardDir, "stray.json"), "{}");
    await expectCode("L1_PATH_MISMATCH", () => l1.scanWholeL1Validated({ abrainHome: home }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("whole-L1 scanner retains canonical visibility while tolerating only durable temp-leaf disappearance", async () => {
  const home = tempHome("scanner-race");
  try {
    const envelope = standardEnvelopes()[0];
    const content = `${JSON.stringify(envelope)}\n`;
    const targetPath = l1.expectedL1EventPath(home, envelope.event_id);
    const shardDir = path.dirname(targetPath);
    fs.mkdirSync(shardDir, { recursive: true });
    const firstStatus = await durable.durableAtomicCreateFile(targetPath, content, { mode: 0o600 });
    assert(firstStatus === "created", `initial durable create status=${firstStatus}`);

    for (let loop = 0; loop < 50; loop += 1) {
      const residues = [];
      for (let index = 0; index < 8; index += 1) {
        const residue = path.join(shardDir, strictDurableResidueName(envelope.event_id, loop, index));
        fs.writeFileSync(residue, "partial", "utf8");
        residues.push(residue);
      }
      const writers = Array.from({ length: 4 }, () => durable.durableAtomicCreateFile(targetPath, content, { mode: 0o600 }));
      const scan = scanWithoutRawEnoent({ abrainHome: home }, `loop ${loop}`);
      await immediate();
      await Promise.all(residues.map((file) => fs.promises.rm(file, { force: true })));
      const result = await scan;
      const statuses = await Promise.all(writers);
      assert(statuses.every((status) => status === "identical"), `loop ${loop}: non-identical durable status ${statuses.join(",")}`);
      assert(result.all.some((record) => record.eventId === envelope.event_id), `loop ${loop}: canonical target missing from scan`);
    }

    const final = await scanWithoutRawEnoent({ abrainHome: home }, "final");
    assert(final.all.length === 1 && final.all[0].eventId === envelope.event_id, "final canonical target did not validate");
    assert(final.tempResidue.length === 0, `final temp residue remained: ${JSON.stringify(final.tempResidue)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("writer preflight accepts active schema and rejects phase-disabled future schema", async () => {
  const home = tempHome("writer");
  try {
    const active = standardEnvelopes()[0];
    const activePath = l1.expectedL1EventPath(home, active.event_id);
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    const validated = await l1.validateL1WritePreflight({
      abrainHome: home,
      envelope: active,
      targetPath: activePath,
      expected: { domain: "knowledge", role: "canonical", producer: "sediment.knowledge-event-writer" },
    });
    assert(validated.registration.write_enabled, "active writer was not enabled");
    const future = envelopeFor("knowledge-curator-attempt/v1", { fixture: "future" });
    const futurePath = l1.expectedL1EventPath(home, future.event_id);
    fs.mkdirSync(path.dirname(futurePath), { recursive: true });
    await expectCode("L1_SCHEMA_WRITE_DISABLED", () => l1.validateL1WritePreflight({ abrainHome: home, envelope: future, targetPath: futurePath }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("scanner and writer reject symlink path escapes via lstat plus realpath", async () => {
  const home = tempHome("symlink");
  const outside = tempHome("outside");
  try {
    const envelope = standardEnvelopes()[0];
    const root = path.join(home, "l1", "events", "sha256");
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(outside, path.join(root, envelope.event_id.slice(0, 2)), "dir");
    await expectCode("L1_SYMLINK_REJECTED", () => l1.scanWholeL1Validated({ abrainHome: home }));
    await expectCode("L1_SYMLINK_REJECTED", () => l1.validateL1WritePreflight({
      abrainHome: home,
      envelope,
      targetPath: l1.expectedL1EventPath(home, envelope.event_id),
    }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

await check("whole-L1 scan rejects non-regular event-tree entries", async () => {
  const home = tempHome("non-regular");
  try {
    const id = "ab" + "cd" + "0".repeat(60);
    fs.mkdirSync(path.join(home, "l1", "events", "sha256", "ab", "cd", `${id}.json`), { recursive: true });
    await expectCode("L1_NON_REGULAR", () => l1.scanWholeL1Validated({ abrainHome: home }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("transition machine schema has stable unique IDs and exact canonical phase authorization", () => {
  const register = transition.loadTransitionRegister();
  const summary = transition.summarizeTransitionRegister(register);
  assert(summary.total === 36 && summary.active === 33 && summary.gated === 3, JSON.stringify(summary));
  assert(Object.isFrozen(register) && Object.isFrozen(register.transitions), "transition register is mutable");
  const canonical = Object.fromEntries(summary.canonicalPath.map((entry) => [entry.id, `${entry.phaseStatus}/${entry.authorizationStatus}`]));
  assert(canonical["canonical_path.p1"] === "completed/authorized", "P1 status/auth mismatch");
  for (const phase of ["p2", "p3", "p4a", "p4b"]) {
    assert(canonical[`canonical_path.${phase}`] === "blocked/not_authorized", `${phase} status/auth mismatch`);
  }
  const proposition = Object.fromEntries(register.transitions
    .filter((entry) => entry.partition === "proposition")
    .map((entry) => [entry.id, `${entry.phase_status}/${entry.authorization_status}`]));
  assert(proposition["proposition.adr0040-p1a-knowledge-pull-shadow-foundation"] === "completed/authorized", "ADR0040 P1a status/auth mismatch");
  assert(proposition["proposition.adr0040-p1b-knowledge-pull-consumer"] === "completed/authorized", "ADR0040 P1b shadow experiment status/auth mismatch");
  const p1b = register.transitions.find((entry) => entry.id === "proposition.adr0040-p1b-knowledge-pull-consumer");
  assert(p1b.current.includes("P1 consumer parity/read flip is not complete"), "ADR0040 P1b completion lost the consumer/read-flip boundary");
  assert(proposition["proposition.adr0040-p2a1-policy-push-projector-preview"] === "completed/authorized", "ADR0040 P2a.1 status/auth mismatch");
  assert(proposition["proposition.adr0040-p2a21-policy-push-publication-contract-preview"] === "completed/authorized", "ADR0040 P2a.2.1 contract status/auth mismatch");
  assert(proposition["proposition.adr0040-p2a2-policy-push-shadow-publication"] === "completed/authorized", "ADR0040 P2a.2 publication status/auth mismatch");
  assert(proposition["proposition.adr0040-p2b-policy-push-stable-view"] === "completed/authorized", "ADR0040 P2b/D3 completion status/auth mismatch");
  const p2b = register.transitions.find((entry) => entry.id === "proposition.adr0040-p2b-policy-push-stable-view");
  assert(p2b.current.includes("D3-PUB") && p2b.current.includes("policy-stable-view-runtime-flip"), "ADR0040 P2b completion lost the later Policy runtime-flip boundary");
  assert(proposition["proposition.adr0040-policy-stable-view-runtime-flip"] === "completed/authorized", "ADR0040 Policy stable-view runtime flip status/auth mismatch");
  const policyFlip = register.transitions.find((entry) => entry.id === "proposition.adr0040-policy-stable-view-runtime-flip");
  assert(policyFlip.current.includes("D3-v2") && policyFlip.current.includes("does NOT authorize"), "Policy runtime flip lost residual-block boundary");
  for (const phase of ["p3-d3-v2-session-start", "p3-runtime-read-flips", "p4-legacy-authority-retirement"]) {
    assert(proposition[`proposition.adr0040-${phase}`] === "blocked/separate_authorization_required", `ADR0040 ${phase} status/auth mismatch`);
  }
  const d3v2 = register.transitions.find((entry) => entry.id === "proposition.adr0040-p3-d3-v2-session-start");
  assert(d3v2 && d3v2.phase_status === "blocked" && d3v2.authorization_status === "separate_authorization_required", "ADR0040 D3-v2 session_start must remain blocked/separate_authorization_required");
  // Loader does not expose free-form summary; machine JSON next_action/current still load.
  assert(d3v2.current && /execution-ready|session_start|Policy stable-view/.test(d3v2.current), "ADR0040 D3-v2 session_start current lost blocked/Policy-boundary");
  const residualP3 = register.transitions.find((entry) => entry.id === "proposition.adr0040-p3-runtime-read-flips");
  assert(residualP3.current.includes("policy-stable-view-runtime-flip") && residualP3.current.includes("blocked"), "residual P3 lost Policy-completed vs residual-blocked split");
  for (const entry of register.transitions) {
    for (const field of ["entered", "review_by", "exit", "evidence", "owner", "consumer", "renewal_count", "risk_class"]) {
      assert(Object.hasOwn(entry, field), `${entry.id} missing ${field}`);
    }
  }
});

await check("transition validator rejects duplicate IDs and authorization drift", async () => {
  const duplicate = clone(transition.loadTransitionRegister());
  duplicate.transitions[1].id = duplicate.transitions[0].id;
  await expectCode("TRANSITION_REGISTER_DUPLICATE", () => transition.validateTransitionRegister(duplicate));
  const unauthorized = clone(transition.loadTransitionRegister());
  unauthorized.transitions.find((entry) => entry.id === "canonical_path.p2").authorization_status = "authorized";
  await expectCode("TRANSITION_CANONICAL_PHASE_INVALID", () => transition.validateTransitionRegister(unauthorized));
});

await check("transition JSON completely maps human sections and deterministic Markdown mirror", async () => {
  const register = transition.loadAndValidateTransitionRegister();
  const markdown = fs.readFileSync(path.join(repoRoot, "docs/transition-register.md"), "utf8");
  transition.validateTransitionRegisterMarkdown(register, markdown);
  const drifted = markdown.replace("`canonical_path.p2` | canonical_path P2 | `blocked`", "`canonical_path.p2` | canonical_path P2 | `in_progress`");
  await expectCode("TRANSITION_MARKDOWN_DRIFT", () => transition.validateTransitionRegisterMarkdown(register, drifted));
});

await check("deterministic transition CLI and read-only startup consumer are wired", () => {
  const run = spawnSync(process.execPath, [path.join(repoRoot, "scripts/validate-transition-register.mjs"), "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert(run.status === 0, run.stderr || `CLI status ${run.status}`);
  const output = JSON.parse(run.stdout);
  assert(output.total === 36 && output.active === 33 && output.gated === 3 && output.canonicalPath.length === 5, run.stdout);
  const startupSource = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf8");
  assert(startupSource.includes("loadAndValidateTransitionRegister();"), "session startup does not consume machine transition register");
  assert(startupSource.includes("transition register invalid"), "startup validation failure is not surfaced");
});

console.log();
if (failures.length) {
  console.log(`FAIL - ${failures.length}/${passed + failures.length} canonical-path foundation check(s) failed.`);
  process.exit(1);
}
console.log(`PASS - ${passed} canonical-path foundation check(s) passed.`);
