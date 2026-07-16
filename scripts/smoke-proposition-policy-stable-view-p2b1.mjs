#!/usr/bin/env node
/** ADR0040 P2b.1 deterministic stable-view smoke. Synthetic writes stay in private temp only. */
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
const stable = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view.ts"));
const profilePath = path.join(repoRoot, "schemas/proposition-policy-stable-view-compile-profile-v1.json");
const profileRaw = fs.readFileSync(profilePath, "utf8");
const profile = JSON.parse(profileRaw);
const FIVE = ["view.json", "view.md", "diagnostics.json", "parity.json", "manifest.json"];
const FOUR = ["view.json", "view.md", "diagnostics.json", "parity.json"];
let passed = 0;
const failures = [];

function id(label) {
  return stable.stableViewSha256Hex(label);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error?.message || error}`);
  }
}

function expectError(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, `expected ${code || "failure"}, operation succeeded`);
  if (code) assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  return caught;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function entry(label, statement, scope, lineageLabels = []) {
  return {
    source_event_id: id(`source:${label}`),
    statement,
    effective_facets: { spatial_scope: scope },
    lifecycle: { lineage_event_ids: lineageLabels.map((value) => id(`lineage:${value}`)) },
  };
}

function documents(entries, sourceExclusions = []) {
  const exclusions = sourceExclusions.map((row) => ({ source_event_id: row.source_event_id }));
  const diagnostics = exclusions.map((row) => ({ source_event_id: row.source_event_id }));
  return {
    entries: { schema_version: "proposition-policy-push-shadow-entries/v1", entries },
    exclusions: { schema_version: "proposition-policy-push-shadow-exclusions/v1", exclusions },
    diagnostics: { schema_version: "proposition-policy-push-shadow-diagnostics/v1", diagnostics },
  };
}

function fixtureRequest(source, decisions) {
  const sourceBundleHash = stable.computeStableViewFixtureSourceBundleHash(source);
  return {
    source_bundle_hash: sourceBundleHash,
    source,
    compile_profile: profile,
    mode: "fixture",
    fixture_decision_set: {
      schema_version: "fixture-decision-set/v1",
      namespace: "adr0040-p2b1-sandbox-fixture-only",
      fixture_synthetic: true,
      source_bundle_hash: sourceBundleHash,
      decisions,
    },
  };
}

function realRequest(source) {
  assert(source.manifest && typeof source.manifest.bundle_hash === "string", "real source requires a self-hashed P2a manifest envelope");
  return { source_bundle_hash: source.manifest.bundle_hash, source, compile_profile: profile, mode: "real" };
}

function p2aEnvelope(source) {
  assert(source.exclusions.exclusions.length === 0 && source.diagnostics.diagnostics.length === 0, "synthetic P2a envelope helper supports candidate entries only");
  const epoch = { epoch_id: "adr0040-p2b1-synthetic-p2a-epoch", genesis_event_id: id("p2a-synthetic-genesis") };
  const facetsFor = (scope) => ({
    confidence: { basis: "witnessed", score: 1 },
    consumer_hints: { notes: [], policy: true, retrieval: true },
    contestability: { counterevidence_event_ids: [], status: "uncontested" },
    lineage: { causal_parents: [], derives_from: [], supersedes: [] },
    maturity: { review_state: "reviewed", state: "accepted" },
    provenance_authority: { authority_kind: "user_attested", quote_sha256: id("p2a-synthetic-quote"), source_event_id: null, source_kind: "user" },
    sensitivity: { classification: "public", handling: "none" },
    spatial_scope: scope,
    temporal_horizon: { horizon: "durable", valid_from: null, valid_until: null },
    trigger: { trigger_kind: "user_directive", trigger_ref: "fixture:p2b1" },
  });
  const fullEntries = source.entries.entries.map((candidate) => {
    const base = {
      schema_version: "proposition-policy-push-shadow-entry/v1",
      record_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this record object with record_hash omitted",
      source_event_id: candidate.source_event_id,
      source_epoch: epoch,
      candidate_face: "policy_push",
      candidate_semantics: "relevance_only_no_injection_verdict",
      statement: candidate.statement,
      language: "en",
      modality: "normative",
      effective_facets: facetsFor(candidate.effective_facets.spatial_scope),
      lifecycle: { disposition: "active", activation: "original", lineage_event_ids: [], lineage: [], terminal_event_id: candidate.source_event_id },
    };
    return { ...base, record_hash: stable.stableViewJcsSha256Hex(base) };
  }).sort((left, right) => left.source_event_id.localeCompare(right.source_event_id));
  const sourceDocuments = {
    entries: { schema_version: "proposition-policy-push-shadow-entries/v1", epoch_id: epoch.epoch_id, genesis_event_id: epoch.genesis_event_id, entries: fullEntries },
    exclusions: { schema_version: "proposition-policy-push-shadow-exclusions/v1", epoch_id: epoch.epoch_id, genesis_event_id: epoch.genesis_event_id, exclusions: [] },
    diagnostics: { schema_version: "proposition-policy-push-shadow-diagnostics/v1", epoch_id: epoch.epoch_id, genesis_event_id: epoch.genesis_event_id, diagnostics: [] },
  };
  const artifactRows = ["diagnostics", "entries", "exclusions"].map((key) => {
    const raw = canonicalJson(sourceDocuments[key]);
    return { bytes: Buffer.byteLength(raw), name: `${key}.json`, sha256: stable.stableViewSha256Hex(raw) };
  });
  const evidenceEventIds = fullEntries.map((entryValue) => entryValue.source_event_id);
  const inputEventIds = [epoch.genesis_event_id, ...evidenceEventIds].sort();
  const sourceResolutionInventory = fullEntries.map((entryValue) => ({
    source_event_id: entryValue.source_event_id,
    statement_sha256: stable.stableViewSha256Hex(entryValue.statement),
    language: entryValue.language,
    modality: entryValue.modality,
    effective_facets: entryValue.effective_facets,
    lifecycle: { ...entryValue.lifecycle, superseded_by_event_id: null },
  }));
  const manifestBase = clone(BOUND_REAL_SOURCE.manifest);
  delete manifestBase.bundle_hash;
  manifestBase.epoch = epoch;
  manifestBase.result = { entry_count: fullEntries.length, exclusion_count: 0, diagnostic_count: 0 };
  manifestBase.artifacts = artifactRows;
  manifestBase.source = {
    ...manifestBase.source,
    proposition_event_count: inputEventIds.length,
    proposition_genesis_count: 1,
    proposition_evidence_count: evidenceEventIds.length,
    proposition_lifecycle_count: 0,
    proposition_selected_count: 0,
    proposition_foldable_count: 0,
    input_event_ids: inputEventIds,
    input_event_ids_hash: stable.stableViewJcsSha256Hex(inputEventIds),
    evidence_event_ids: evidenceEventIds,
    evidence_event_ids_hash: stable.stableViewJcsSha256Hex(evidenceEventIds),
    lifecycle_event_ids: [],
    lifecycle_event_ids_hash: stable.stableViewJcsSha256Hex([]),
    source_resolution_inventory: sourceResolutionInventory,
    source_resolution_inventory_hash: stable.stableViewJcsSha256Hex(sourceResolutionInventory),
  };
  return { ...sourceDocuments, manifest: { ...manifestBase, bundle_hash: stable.stableViewJcsSha256Hex(manifestBase) } };
}

function canonicalJson(value) {
  return `${stable.stableViewCanonicalizeJcs(value)}\n`;
}

function base32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of Buffer.from(value, "utf8")) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

function ascii85(value) {
  const bytes = Buffer.from(value, "utf8");
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const length = Math.min(4, bytes.length - offset);
    let word = 0;
    for (let index = 0; index < 4; index += 1) word = (word * 256) + (index < length ? bytes[offset + index] : 0);
    const encoded = Array(5);
    for (let index = 4; index >= 0; index -= 1) {
      encoded[index] = String.fromCharCode((word % 85) + 33);
      word = Math.floor(word / 85);
    }
    output += encoded.slice(0, length + 1).join("");
  }
  return output;
}

function rot13(value) {
  return value.replace(/[A-Za-z]/g, (character) => String.fromCharCode((character <= "Z" ? 65 : 97) + ((character.charCodeAt(0) - (character <= "Z" ? 65 : 97) + 13) % 26)));
}

function percentUtf8(value, uppercase) {
  return [...Buffer.from(value, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0")[uppercase ? "toUpperCase" : "toLowerCase"]()}`).join("");
}

function novelTransform(value) {
  return [...Buffer.from(value, "utf8")].reverse().map((byte, index) => ((byte ^ ((index * 29 + 71) & 255)) + 256).toString(36)).join(".");
}

function receiptSet(result, offset = 0) {
  const second = String(offset).padStart(2, "0");
  return stable.buildStableViewReceipts(result, {
    requested_at_utc: `2026-07-14T05:20:${second}.000Z`,
    completed_at_utc: `2026-07-14T05:20:${second}.100Z`,
    observed_at_utc: `2026-07-14T05:20:${second}.200Z`,
  });
}

function rehashRealEnvelope(requestValue) {
  const attacked = clone(requestValue);
  attacked.source.manifest.artifacts = ["diagnostics", "entries", "exclusions"].map((key) => {
    const raw = canonicalJson(attacked.source[key]);
    return { bytes: Buffer.byteLength(raw), name: `${key}.json`, sha256: stable.stableViewSha256Hex(raw) };
  });
  const base = { ...attacked.source.manifest };
  delete base.bundle_hash;
  attacked.source.manifest.bundle_hash = stable.stableViewJcsSha256Hex(base);
  attacked.source_bundle_hash = attacked.source.manifest.bundle_hash;
  return attacked;
}

function parseArtifacts(artifacts) {
  return {
    view: JSON.parse(artifacts["view.json"]),
    md: artifacts["view.md"],
    diagnostics: JSON.parse(artifacts["diagnostics.json"]),
    parity: JSON.parse(artifacts["parity.json"]),
    manifest: JSON.parse(artifacts["manifest.json"]),
  };
}

function fullyRehashArtifacts(original, mutate) {
  const value = parseArtifacts(clone(original));
  mutate(value);
  for (const item of value.view.items) {
    item.statement_sha256 = stable.stableViewSha256Hex(item.statement);
    item.scope_sha256 = stable.stableViewJcsSha256Hex(item.scope);
    const itemBase = { ...item };
    delete itemBase.item_payload_sha256;
    item.item_payload_sha256 = stable.stableViewJcsSha256Hex(itemBase);
  }
  value.view.injectable_payload_utf8_bytes = Buffer.byteLength(value.md);
  value.view.injectable_payload_sha256 = stable.stableViewSha256Hex(value.md);
  const dispositions = value.parity.source_conservation.dispositions;
  const dispositionIds = dispositions.map((row) => row.source_event_id).sort();
  value.parity.source_conservation.source_event_count = dispositionIds.length;
  value.parity.source_conservation.source_event_ids_hash = stable.stableViewJcsSha256Hex(dispositionIds);
  value.parity.source_conservation.dispositions_hash = stable.stableViewJcsSha256Hex(dispositions);
  value.parity.source_conservation.diagnostic_count = value.diagnostics.diagnostics.length;
  value.parity.source_conservation.diagnostics_hash = stable.stableViewJcsSha256Hex(value.diagnostics.diagnostics);
  value.parity.deterministic_render.item_count = value.view.items.length;
  value.parity.deterministic_render.items_hash = stable.stableViewJcsSha256Hex(value.view.items);
  value.parity.deterministic_render.view_md_utf8_bytes = Buffer.byteLength(value.md);
  value.parity.deterministic_render.view_md_sha256 = stable.stableViewSha256Hex(value.md);
  value.parity.scope_lineage.source_entry_count = value.parity.scope_lineage.commitments.length;
  value.parity.scope_lineage.commitments_hash = stable.stableViewJcsSha256Hex(value.parity.scope_lineage.commitments);
  value.manifest.source_closure.source_event_count = dispositionIds.length;
  value.manifest.source_closure.source_event_ids_hash = stable.stableViewJcsSha256Hex(dispositionIds);
  value.manifest.source_closure.dispositions_hash = stable.stableViewJcsSha256Hex(dispositions);
  value.manifest.source_closure.diagnostic_count = value.diagnostics.diagnostics.length;
  value.manifest.source_closure.diagnostics_hash = stable.stableViewJcsSha256Hex(value.diagnostics.diagnostics);
  const bytes = {
    "view.json": canonicalJson(value.view),
    "view.md": value.md,
    "diagnostics.json": canonicalJson(value.diagnostics),
    "parity.json": canonicalJson(value.parity),
  };
  value.manifest.artifact_rows = FOUR.map((name) => ({ name, bytes: Buffer.byteLength(bytes[name]), sha256: stable.stableViewSha256Hex(bytes[name]) }));
  const manifestBase = { ...value.manifest };
  delete manifestBase.manifest_hash;
  value.manifest.manifest_hash = stable.stableViewJcsSha256Hex(manifestBase);
  return { ...bytes, "manifest.json": canonicalJson(value.manifest) };
}

const BOUND_REAL_SOURCE = {
  entries: { entries: [], epoch_id: "adr0040-production-genesis-v1", genesis_event_id: "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3", schema_version: "proposition-policy-push-shadow-entries/v1" },
  exclusions: { epoch_id: "adr0040-production-genesis-v1", exclusions: [{ filter_stage: "policy_hint", reason_code: "consumer_hints_policy_false", record_hash: "3588ca1d9e16f00d5a719e811ebd744eb6090f8878177bcae96a500c510fbe46", record_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this record object with record_hash omitted", schema_version: "proposition-policy-push-shadow-exclusion/v1", source_event_id: "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585" }], genesis_event_id: "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3", schema_version: "proposition-policy-push-shadow-exclusions/v1" },
  diagnostics: { diagnostics: [{ code: "POLICY_CANDIDATE_EXCLUDED", filter_stage: "policy_hint", reason_code: "consumer_hints_policy_false", record_hash: "5989786a51fecbfafef727e4208a42f75bc2ef81bb74717a4670a104feb640e3", record_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this record object with record_hash omitted", schema_version: "proposition-policy-push-shadow-diagnostic/v1", severity: "info", source_event_id: "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585" }], epoch_id: "adr0040-production-genesis-v1", genesis_event_id: "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3", schema_version: "proposition-policy-push-shadow-diagnostics/v1" },
  manifest: JSON.parse('{"artifacts":[{"bytes":675,"name":"diagnostics.json","sha256":"9daf2ec369ec6c70171da4c5683935ad61d42395ac7786b2c05474e781ccdfda"},{"bytes":205,"name":"entries.json","sha256":"ba5629a446c01874a0376c86fcea6c623509d50fe488547562175b6b27d16303"},{"bytes":619,"name":"exclusions.json","sha256":"c29e6b12cf0ba4b980202ae42807ee5b18fd1de3cf01c606a2f3bcf28382984f"}],"authority":"shadow_push_only_no_runtime_consumer","bundle_hash":"dfa3e81fce150bacf635a446d20055f96bc39df368f2c02d99c13342cdcaa5a0","bundle_hash_scope":"sha256 over RFC8785-JCS UTF-8 bytes of this manifest object with bundle_hash omitted","candidate_contract":{"face":"policy_push","runtime_consumer":false,"semantics":"relevance_only_no_injection_verdict"},"canonicalization":"RFC8785-JCS","epoch":{"epoch_id":"adr0040-production-genesis-v1","genesis_event_id":"3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3"},"exclusion_precedence":[{"rank":1,"reason_codes":["lifecycle_archived","lifecycle_retracted","lifecycle_superseded"],"stage":"lifecycle"},{"rank":2,"reason_codes":["safety_authority_not_attested"],"stage":"safety"},{"rank":3,"reason_codes":["scope_unresolved"],"stage":"scope"},{"rank":4,"reason_codes":["temporal_not_durable"],"stage":"temporal"},{"rank":5,"reason_codes":["sensitivity_not_public"],"stage":"sensitivity"},{"rank":6,"reason_codes":["contestability_not_uncontested"],"stage":"contestability"},{"rank":7,"reason_codes":["maturity_not_accepted_reviewed"],"stage":"maturity"},{"rank":8,"reason_codes":["modality_not_normative"],"stage":"modality"},{"rank":9,"reason_codes":["consumer_hints_policy_false"],"stage":"policy_hint"}],"hash_algorithm":"sha256","projection_envelope_contract":{"body_schema":null,"envelope_schema":"proposition-projection-envelope/v1","fold_eligible":false,"phase":"phase_disabled","write_enabled":false},"result":{"diagnostic_count":1,"entry_count":0,"exclusion_count":1},"schema_version":"proposition-policy-push-shadow-manifest/v2","source":{"consumed_classification":"defined-inactive-shadow","consumed_envelope_schemas":["proposition-evidence-envelope/v1","proposition-genesis-envelope/v1","proposition-lifecycle-envelope/v1"],"evidence_event_ids":["beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585"],"evidence_event_ids_hash":"42014fa54879ffb6d0c4a36e38847c10bf4132765afd7115963e247fdae6e281","input_event_ids":["3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3","beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585"],"input_event_ids_hash":"80de821038b3cfe4ec7b571ab88177be6af2b0fa4d5193d533092859b6a747bc","lifecycle_event_ids":[],"lifecycle_event_ids_hash":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","lifecycle_resolver_file_sha256":"4eb4d8a342a4bda93fb55e64a0ed579c9185aab29a7b67049cc23cf469491daa","lifecycle_resolver_schema":"proposition-lifecycle-effective-state/v1","non_proposition_event_consumed_count":0,"projector_file_sha256":"d907badcc65206c5b824875809b8d81ec448abbd83f36ea1790b878da699bb09","proposition_contract_file_sha256":"e08efd8f6ec9a9f4668cf36df81d421841dae19603c61c6ee52c42f3ac743766","proposition_event_count":2,"proposition_evidence_count":1,"proposition_foldable_count":0,"proposition_genesis_count":1,"proposition_lifecycle_count":0,"proposition_selected_count":0,"registry_file_sha256":"1780f3745fbe251a10ae797f23106290f7df70c13a979514ac0bbb2a3f30246d","scanner":"scanWholeL1Validated","source_resolution_inventory":[{"effective_facets":{"confidence":{"basis":"witnessed","score":1},"consumer_hints":{"notes":[],"policy":false,"retrieval":true},"contestability":{"counterevidence_event_ids":[],"status":"uncontested"},"lineage":{"causal_parents":[],"derives_from":[],"supersedes":[]},"maturity":{"review_state":"reviewed","state":"accepted"},"provenance_authority":{"authority_kind":"user_attested","quote_sha256":"b594404b6394f21f1e702b9af24ae5f5b371497492e29dfe8a16f1b9357217db","source_event_id":null,"source_kind":"user"},"sensitivity":{"classification":"public","handling":"none"},"spatial_scope":{"domain":null,"project_id":null,"scope_level":"global"},"temporal_horizon":{"horizon":"durable","valid_from":null,"valid_until":null},"trigger":{"trigger_kind":"user_directive","trigger_ref":"session:019f569c-40d3-73f0-9a5f-666b395f6b9a/message:e5b235e8"}},"language":"zh","lifecycle":{"activation":"original","disposition":"active","lineage":[],"lineage_event_ids":[],"superseded_by_event_id":null,"terminal_event_id":"beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585"},"modality":"normative","source_event_id":"beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585","statement_sha256":"b594404b6394f21f1e702b9af24ae5f5b371497492e29dfe8a16f1b9357217db"}],"source_resolution_inventory_hash":"4e89a1ebb75f584600358d7f7a54b17972c6c420d8277430be74e5b24e626281","whole_l1":true}}'),
};

const globalScope = { scope_level: "global", project_id: null, domain: null };
const projectScope = { scope_level: "project", project_id: "fixture-project", domain: null };
const alpha = entry("alpha", "Fixture alpha statement remains byte exact.", globalScope, ["alpha-1"]);
const beta = entry("beta", "Fixture merged statement remains byte exact.", projectScope, ["beta-1"]);
const gamma = entry("gamma", "Fixture merged statement remains byte exact.", projectScope, ["gamma-1", "gamma-2"]);
const delta = entry("delta", "Fixture excluded statement must never enter an artifact.", globalScope);
const alreadyExcluded = { source_event_id: id("source:already-excluded") };
const source = documents([alpha, beta, gamma, delta], [alreadyExcluded]);
const decisions = [
  { source_event_id: alpha.source_event_id, disposition: "included" },
  { source_event_id: beta.source_event_id, disposition: "merged", merge_group: "merge-beta-gamma" },
  { source_event_id: gamma.source_event_id, disposition: "merged", merge_group: "merge-beta-gamma" },
  { source_event_id: delta.source_event_id, disposition: "excluded" },
];
const request = fixtureRequest(source, decisions);
const compiled = stable.evaluatePropositionPolicyStableView(request);

console.log("ADR0040 P2b.1 stable-view smoke");

await check("compile profile is exact JCS+LF, self-hashed, and recursively forbids every accepted key", () => {
  const validated = stable.validateStableViewCompileProfile(profile);
  assert(profileRaw === `${stable.stableViewCanonicalizeJcs(profile)}\n`, "profile bytes are not canonical JCS+LF");
  assert(validated.profile_hash === "aa229d1703e2856ec92a19ff171fe49a145459a915500f362a20b4b2625d8ecd", "profile hash drifted");
  assert(profile.source_identity.real.contract === "self_bound_validated_p2a_bundle/v1", "real source profile is not generalized self-bound P2a");
  assert(profile.budget.max_items === 128 && profile.budget.max_statement_utf8_bytes === 8192
    && profile.budget.max_injectable_payload_utf8_bytes === 131072, "generalized compile hard limits drifted");
  const tampered = clone(profile);
  tampered.scope_preservation.nested = { Priority: 7 };
  const base = { ...tampered };
  delete base.profile_hash;
  tampered.profile_hash = stable.stableViewJcsSha256Hex(base);
  expectError(() => stable.validateStableViewCompileProfile(tampered));
});

await check("fixture namespace compiles deterministically with exact compile key and all-five artifact set", () => {
  assert(compiled.pipeline === "completed" && compiled.outcome_code === "ready_nonempty", `unexpected result ${compiled.pipeline}/${compiled.outcome_code}`);
  const repeated = stable.evaluatePropositionPolicyStableView(clone(request));
  assert(stable.stableViewCanonicalizeJcs(compiled) === stable.stableViewCanonicalizeJcs(repeated), "repeated compile differs");
  const decisionIdentity = stable.stableViewJcsSha256Hex({
    schema_version: "proposition-policy-stable-view-fixture-decision-identity/v1",
    fixture_decision_set: request.fixture_decision_set,
  });
  const expectedKey = stable.stableViewJcsSha256Hex({
    source_bundle_hash: request.source_bundle_hash,
    compile_profile_hash: profile.profile_hash,
    accepted_decision_hash_or_empty_sentinel: decisionIdentity,
  });
  assert(compiled.compile_key === expectedKey, "compile key formula differs");
  assert(JSON.stringify(Object.keys(compiled.artifacts).sort()) === JSON.stringify([...FIVE].sort()), "successful set is not all five");
  stable.validateStableArtifactSet(request, compiled.artifacts);
});

await check("source dispositions, diagnostic conservation, scope, lineage, and statement isolation are exact", () => {
  const artifact = parseArtifacts(compiled.artifacts);
  assert(artifact.view.items.length === 2, "fixture must yield included plus merged item");
  const dispositions = artifact.parity.source_conservation.dispositions;
  assert(dispositions.length === 5, "source universe disposition count differs");
  assert(dispositions.filter((row) => row.disposition === "included").length === 1, "included disposition missing");
  assert(dispositions.filter((row) => row.disposition === "merged").length === 2, "merged dispositions missing");
  assert(dispositions.filter((row) => row.disposition === "excluded").length === 2, "excluded dispositions missing");
  assert(artifact.diagnostics.diagnostics.length === 1, "source diagnostic was not conserved exactly once");
  for (const row of dispositions.filter((value) => value.disposition === "excluded")) {
    assert(row.filter_stage === "stable_view_disposition" && row.reason_code === "disposition_excluded", "excluded disposition metadata is not compiler-derived");
  }
  for (const diagnostic of artifact.diagnostics.diagnostics) {
    assert(diagnostic.code === "POLICY_CANDIDATE_EXCLUDED" && diagnostic.severity === "info", "diagnostic enum drifted");
    assert(diagnostic.filter_stage === "stable_view_disposition" && diagnostic.reason_code === "disposition_excluded", "diagnostic metadata is not compiler-derived");
  }
  stable.validateStableNonViewDocument("diagnostics", artifact.diagnostics);
  stable.validateStableNonViewDocument("parity", artifact.parity);
  stable.validateStableNonViewDocument("manifest", artifact.manifest);
  const nonView = `${compiled.artifacts["diagnostics.json"]}${compiled.artifacts["parity.json"]}${compiled.artifacts["manifest.json"]}`;
  for (const sourceEntry of [alpha, beta, gamma, delta]) assert(!nonView.includes(sourceEntry.statement), `statement leaked outside views: ${sourceEntry.source_event_id}`);
  assert(!compiled.artifacts["view.json"].includes(delta.statement) && !compiled.artifacts["view.md"].includes(delta.statement), "excluded statement leaked into view");
  assert(compiled.artifacts["view.md"].split(beta.statement).length - 1 === 1, "merged statement was rendered more than once");
  assert(artifact.parity.scope_lineage.commitments.length === 4, "scope/lineage commitments do not cover every source entry");
  const receipts = receiptSet(compiled, 0);
  stable.validateStableNonViewDocument("request_receipt", receipts.request_receipt);
  stable.validateStableNonViewDocument("outcome_receipt", receipts.outcome_receipt);
  stable.validateStableNonViewDocument("observation", receipts.observation);
  const receiptBytes = canonicalJson(receipts);
  for (const sourceEntry of [alpha, beta, gamma, delta]) {
    const forms = [sourceEntry.statement, Buffer.from(sourceEntry.statement).toString("base64"), Buffer.from(sourceEntry.statement).toString("hex"), encodeURIComponent(sourceEntry.statement)];
    for (const form of forms) assert(!receiptBytes.includes(form), `statement content leaked into receipts: ${sourceEntry.source_event_id}`);
  }
});

const boundRealRequest = realRequest(BOUND_REAL_SOURCE);
const boundReal = stable.evaluatePropositionPolicyStableView(boundRealRequest);
const queuedRequest = realRequest(p2aEnvelope(documents([alpha])));
const queuedResult = stable.evaluatePropositionPolicyStableView(queuedRequest);

await check("real empty source uses a self-bound P2a identity, sentinel, and zero payload bytes", () => {
  assert(boundReal.pipeline === "completed" && boundReal.outcome_code === "ready_empty", `real empty source did not complete: ${boundReal.outcome_code}`);
  assert(boundReal.decision_identity === "empty-source/no-decision/v1", "empty sentinel differs");
  const view = JSON.parse(boundReal.artifacts["view.json"]);
  assert(view.items.length === 0 && view.injectable_payload_utf8_bytes === 0 && boundReal.artifacts["view.md"] === "", "ready_empty carries content");
  assert(Object.keys(boundReal.artifacts).length === 5, "ready_empty is not all five");
  stable.validateStableArtifactSet(boundRealRequest, boundReal.artifacts);
});

await check("cryptographically self-bound real nonempty source queues without stable identity", () => {
  assert(queuedResult.pipeline === "queued" && queuedResult.outcome_code === "production_decision_required", `real nonempty source did not queue: ${queuedResult.outcome_code}`);
  assert(queuedResult.compile_key === null && queuedResult.manifest_hash === null && queuedResult.artifacts === null, "queued result emitted stable identity or artifacts");
});

await check("empty real and every real fixture crossover reject without any stable subset", () => {
  const empty = clone(boundRealRequest);
  empty.fixture_decision_set = clone(request.fixture_decision_set);
  const emptyRejected = stable.evaluatePropositionPolicyStableView(empty);
  assert(emptyRejected.pipeline === "rejected" && emptyRejected.outcome_code === "unexpected_decision_for_empty" && emptyRejected.artifacts === null, `empty real decision did not reject exactly: ${emptyRejected.outcome_code}`);
  const nonempty = clone(queuedRequest);
  nonempty.fixture_decision_set = clone(request.fixture_decision_set);
  const nonemptyRejected = stable.evaluatePropositionPolicyStableView(nonempty);
  assert(nonemptyRejected.pipeline === "rejected" && nonemptyRejected.outcome_code === "fixture_decision_for_real_rejected" && nonemptyRejected.artifacts === null, "fixture crossed into real compile");
});

await check("all-zero, mismatched, and arbitrary source hash pairs fail closed", () => {
  for (const badHash of ["0".repeat(64), id("mismatched-fixture-source")]) {
    const attacked = clone(request);
    attacked.source_bundle_hash = badHash;
    attacked.fixture_decision_set.source_bundle_hash = badHash;
    const result = stable.evaluatePropositionPolicyStableView(attacked);
    assert(result.pipeline === "rejected" && result.outcome_code === "fixture_source_bundle_hash_mismatch", `fixture hash attack escaped: ${result.outcome_code}`);
  }
  const allZeroReal = clone(boundRealRequest);
  allZeroReal.source_bundle_hash = "0".repeat(64);
  const zeroResult = stable.evaluatePropositionPolicyStableView(allZeroReal);
  assert(zeroResult.pipeline === "rejected" && zeroResult.outcome_code === "real_source_bundle_hash_mismatch", `all-zero real hash escaped: ${zeroResult.outcome_code}`);
  const arbitraryEmpty = stable.evaluatePropositionPolicyStableView(realRequest(p2aEnvelope(documents([]))));
  assert(arbitraryEmpty.pipeline === "completed" && arbitraryEmpty.outcome_code === "ready_empty"
    && arbitraryEmpty.artifacts["view.md"] === "", `valid generalized empty source did not compile: ${arbitraryEmpty.outcome_code}`);
  const fullyRehashedSourceMismatch = clone(queuedRequest);
  fullyRehashedSourceMismatch.source.entries.entries[0].statement = `${fullyRehashedSourceMismatch.source.entries.entries[0].statement} tampered`;
  const sourceMismatchResult = stable.evaluatePropositionPolicyStableView(rehashRealEnvelope(fullyRehashedSourceMismatch));
  assert(sourceMismatchResult.pipeline === "rejected" && sourceMismatchResult.outcome_code === "real_source_record_hash_mismatch", `fully rehashed source mismatch escaped: ${sourceMismatchResult.outcome_code}`);
});

await check("generalized real compiler handles 0/1/2+ candidates and input permutation deterministically", () => {
  const emptyRequest = realRequest(p2aEnvelope(documents([])));
  const oneRequest = realRequest(p2aEnvelope(documents([alpha])));
  const twoForward = realRequest(p2aEnvelope(documents([alpha, beta])));
  const twoReverse = realRequest(p2aEnvelope(documents([beta, alpha])));
  const emptyResult = stable.compilePropositionPolicyStableView(emptyRequest);
  const oneResult = stable.compilePropositionPolicyStableView(oneRequest);
  const forwardResult = stable.compilePropositionPolicyStableView(twoForward);
  const reverseResult = stable.compilePropositionPolicyStableView(twoReverse);
  assert(emptyResult.outcome_code === "ready_empty" && JSON.parse(emptyResult.artifacts["view.json"]).items.length === 0, "zero-candidate real compile differs");
  assert(oneResult.outcome_code === "ready_nonempty" && JSON.parse(oneResult.artifacts["view.json"]).items.length === 1, "one-candidate real compile differs");
  assert(forwardResult.outcome_code === "ready_nonempty" && JSON.parse(forwardResult.artifacts["view.json"]).items.length === 2, "2+ real compile differs");
  assert(stable.stableViewCanonicalizeJcs(forwardResult) === stable.stableViewCanonicalizeJcs(reverseResult), "real compile depends on input permutation");
  assert(stable.stableViewCanonicalizeJcs(forwardResult) === stable.stableViewCanonicalizeJcs(stable.compilePropositionPolicyStableView(clone(twoForward))), "real compile repeat is nondeterministic");
});

await check("the four observation tuples are exhaustive, receipt-bound, and health-derived", () => {
  const idle = stable.evaluatePropositionPolicyStableView(null);
  const rejectedRequest = clone(boundRealRequest);
  rejectedRequest.fixture_decision_set = clone(request.fixture_decision_set);
  const rejected = stable.evaluatePropositionPolicyStableView(rejectedRequest);
  const idleObservation = stable.buildStableViewObservation(idle, { observed_at_utc: "2026-07-14T05:20:00.000Z" });
  const sets = [receiptSet(compiled, 1), receiptSet(queuedResult, 2), receiptSet(rejected, 3)];
  const observations = [idleObservation, ...sets.map((value) => value.observation)];
  const tuples = observations.map(({ pipeline, freshness, selection, health }) => ({ pipeline, freshness, selection, health }));
  assert(stable.stableViewCanonicalizeJcs(tuples) === stable.stableViewCanonicalizeJcs(stable.stableViewLegalObservationTuples()), "observation tuples are not exact/exhaustive");
  const invalidSet = clone(sets[1]);
  invalidSet.observation.health = "ok";
  expectError(() => stable.validateStableViewReceiptSet(queuedResult, invalidSet), "observation_tuple_invalid");
});

await check("canonical request correlation and clock metadata stay outside compile and artifact identity", () => {
  const first = receiptSet(compiled, 4);
  const second = stable.buildStableViewReceipts(compiled, {
    requested_at_utc: "2030-01-01T00:00:00.000Z",
    completed_at_utc: "2030-01-01T00:00:01.000Z",
    observed_at_utc: "2030-01-01T00:00:02.000Z",
  });
  assert(first.outcome_receipt.compile_key === second.outcome_receipt.compile_key && first.outcome_receipt.compile_key === compiled.compile_key, "receipt metadata entered compile identity");
  assert(first.request_receipt.request_id === second.request_receipt.request_id && first.request_receipt.request_id === compiled.request_id, "request correlation did not derive from canonical raw request bytes");
  for (const receipts of [first, second]) stable.validateStableViewReceiptSet(compiled, receipts);
});

await check("queued and malformed-identity rejected requests always emit complete correlated receipt sets", () => {
  const malformed = clone(request);
  malformed.source_bundle_hash = "not-a-hash";
  malformed.fixture_decision_set.source_bundle_hash = "not-a-hash";
  const rejected = stable.evaluatePropositionPolicyStableView(malformed);
  assert(rejected.pipeline === "rejected" && rejected.outcome_code === "sha256_invalid", `malformed hash did not reject: ${rejected.outcome_code}`);
  assert(rejected.request_id === stable.stableViewSha256Hex(stable.stableViewCanonicalizeJcs(malformed)), "malformed request correlation is not canonical raw-request SHA-256");
  const queuedReceipts = receiptSet(queuedResult, 5);
  const rejectedReceipts = receiptSet(rejected, 6);
  for (const [result, receipts] of [[queuedResult, queuedReceipts], [rejected, rejectedReceipts]]) {
    stable.validateStableViewReceiptSet(result, receipts);
    assert(receipts.request_receipt.request_id === receipts.outcome_receipt.request_id && receipts.observation.request_id === result.request_id, "receipt request IDs diverged");
  }
});

await check("completed, queued, and rejected correlation substitution attacks fail closed", () => {
  const malformed = clone(request);
  malformed.compile_profile.profile_hash = "0".repeat(64);
  const rejected = stable.evaluatePropositionPolicyStableView(malformed);
  for (const [result, receipts] of [[compiled, receiptSet(compiled, 7)], [queuedResult, receiptSet(queuedResult, 8)], [rejected, receiptSet(rejected, 9)]]) {
    const observationAttack = clone(receipts);
    observationAttack.observation.request_id = id(`substitute-observation-${result.pipeline}`);
    expectError(() => stable.validateStableViewReceiptSet(result, observationAttack), "observation_correlation_mismatch");
    const outcomeAttack = clone(receipts);
    outcomeAttack.outcome_receipt.request_id = id(`substitute-outcome-${result.pipeline}`);
    const outcomeBase = { ...outcomeAttack.outcome_receipt };
    delete outcomeBase.receipt_hash;
    outcomeAttack.outcome_receipt.receipt_hash = stable.stableViewJcsSha256Hex(outcomeBase);
    outcomeAttack.observation.outcome_receipt_hash = outcomeAttack.outcome_receipt.receipt_hash;
    expectError(() => stable.validateStableViewReceiptSet(result, outcomeAttack), "receipt_correlation_mismatch");
  }
});

await check("fully rehashed receipt insertion of an arbitrary transform fails the closed-vocabulary validator", () => {
  const attacked = clone(receiptSet(compiled, 10));
  attacked.outcome_receipt.outcome_code = novelTransform(alpha.statement);
  const outcomeBase = { ...attacked.outcome_receipt };
  delete outcomeBase.receipt_hash;
  attacked.outcome_receipt.receipt_hash = stable.stableViewJcsSha256Hex(outcomeBase);
  attacked.observation.outcome_receipt_hash = attacked.outcome_receipt.receipt_hash;
  expectError(() => stable.validateStableViewReceiptSet(compiled, attacked), "non_view_string_not_closed");
});

await check("budget violations reject without truncation or partial artifacts", () => {
  const tooLong = entry("too-long", "x".repeat(profile.budget.max_statement_utf8_bytes + 1), globalScope);
  const oversized = fixtureRequest(documents([tooLong]), [{ source_event_id: tooLong.source_event_id, disposition: "included" }]);
  const result = stable.evaluatePropositionPolicyStableView(oversized);
  assert(result.pipeline === "rejected" && result.outcome_code === "budget_statement_bytes_exceeded", "oversized source did not reject at budget");
  assert(result.artifacts === null && result.compile_key === null && result.manifest_hash === null, "budget rejection emitted a partial set");
});

await check("fixture metadata schema rejects base32, rot13, ascii85, both percent cases, and novel transforms", () => {
  const transforms = [
    ["raw", alpha.statement],
    ["base32", base32(alpha.statement)],
    ["rot13", rot13(alpha.statement)],
    ["ascii85", ascii85(alpha.statement)],
    ["percent-lower", percentUtf8(alpha.statement, false)],
    ["percent-upper", percentUtf8(alpha.statement, true)],
    ["novel", novelTransform(alpha.statement)],
  ];
  for (const [label, leaked] of transforms) {
    const sourceAttack = documents([alpha], [{ source_event_id: id(`leak-source-${label}`) }]);
    sourceAttack.exclusions.exclusions[0].reason_code = leaked;
    sourceAttack.diagnostics.diagnostics[0].filter_stage = leaked;
    const sourceResult = stable.evaluatePropositionPolicyStableView(fixtureRequest(sourceAttack, [{ source_event_id: alpha.source_event_id, disposition: "included" }]));
    assert(sourceResult.pipeline === "rejected" && sourceResult.outcome_code === "object_keys_invalid", `${label} source metadata escaped: ${sourceResult.outcome_code}`);

    const decisionAttack = fixtureRequest(documents([alpha]), [{ source_event_id: alpha.source_event_id, disposition: "excluded", reason_code: leaked, filter_stage: leaked }]);
    const decisionResult = stable.evaluatePropositionPolicyStableView(decisionAttack);
    assert(decisionResult.pipeline === "rejected" && decisionResult.outcome_code === "object_keys_invalid", `${label} decision metadata escaped: ${decisionResult.outcome_code}`);
  }
});

await check("non-canonicalizable values are rejected at the receipt-producing wrapper boundary", () => {
  const unsupported = clone(request);
  unsupported.fixture_decision_set.decisions[0].unsupported = undefined;
  expectError(() => stable.evaluatePropositionPolicyStableView(unsupported), "noncanonical_value");
  const cyclic = {};
  cyclic.self = cyclic;
  expectError(() => stable.evaluatePropositionPolicyStableView(cyclic));
});

const attacks = [
  ["omission", "artifact_semantic_mismatch", (value) => { value.parity.source_conservation.dispositions.pop(); }],
  ["duplication", "artifact_semantic_mismatch", (value) => { value.parity.source_conservation.dispositions.push(clone(value.parity.source_conservation.dispositions[0])); }],
  ["foreign source", "artifact_semantic_mismatch", (value) => { value.parity.source_conservation.dispositions[0].source_event_id = id("foreign-source"); }],
  ["statement key leakage", "statement_isolation_violation", (value) => { value.diagnostics.diagnostics[0].statement = alpha.statement; }],
  ["statement value leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = alpha.statement; }],
  ["statement substring leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].filter_stage = `prefix:${alpha.statement}:suffix`; }],
  ["statement base64 leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = Buffer.from(alpha.statement).toString("base64"); }],
  ["statement base32 leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = base32(alpha.statement); }],
  ["statement rot13 leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = rot13(alpha.statement); }],
  ["statement ascii85 leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = ascii85(alpha.statement); }],
  ["statement lowercase percent leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = percentUtf8(alpha.statement, false); }],
  ["statement uppercase percent leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = percentUtf8(alpha.statement, true); }],
  ["statement hex leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = Buffer.from(alpha.statement).toString("hex"); }],
  ["novel arbitrary transform leakage", "non_view_string_not_closed", (value) => { value.diagnostics.diagnostics[0].reason_code = novelTransform(alpha.statement); }],
  ["statement view metadata leakage", "statement_isolation_violation", (value) => { value.view.items[0].scope.domain = alpha.statement; }],
  ["lineage omission", "artifact_semantic_mismatch", (value) => { value.view.items[0].source_lineage[0].lineage_event_ids = []; value.parity.scope_lineage.commitments[0].lineage_event_count = 0; value.parity.scope_lineage.commitments[0].lineage_event_ids_hash = stable.stableViewJcsSha256Hex([]); }],
  ["scope expansion", "artifact_semantic_mismatch", (value) => { value.view.items[0].scope = { scope_level: "global", project_id: null, domain: "expanded" }; value.parity.scope_lineage.commitments[0].scope_sha256 = stable.stableViewJcsSha256Hex(value.view.items[0].scope); }],
  ["render mismatch", "artifact_semantic_mismatch", (value) => { value.md = `${value.md}Injected render line.\n`; }],
];

for (const [name, code, mutate] of attacks) {
  await check(`fully rehashed adversarial ${name} fails closed`, () => {
    const attacked = fullyRehashArtifacts(compiled.artifacts, mutate);
    expectError(() => stable.validateStableArtifactSet(request, attacked), code);
  });
}

await check("partial artifact attack fails closed even when remaining artifacts are unchanged", () => {
  const partial = clone(compiled.artifacts);
  delete partial["parity.json"];
  expectError(() => stable.validateStableArtifactSet(request, partial), "object_keys_invalid");
});

await check("synthetic artifact materialization is confined to a disposable sandbox", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p2b1-smoke-"));
  try {
    const final = path.join(root, "all-five");
    const staging = path.join(root, "staging");
    fs.mkdirSync(staging, { mode: 0o700 });
    for (const name of FIVE) fs.writeFileSync(path.join(staging, name), compiled.artifacts[name], { flag: "wx", mode: 0o600 });
    fs.renameSync(staging, final);
    assert(JSON.stringify(fs.readdirSync(final).sort()) === JSON.stringify([...FIVE].sort()), "temp materialization is partial");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert(!fs.existsSync(root), "synthetic sandbox was not removed");
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; deterministic compiler, four tuples, fixture isolation, and adversarial closure verified`);
