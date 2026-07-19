#!/usr/bin/env node
/** ADR0040 strict stable-view reader and single-session rule-injector smoke. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const ts = require("typescript");
const jiti = createJiti(repoRoot, { interopDefault: true });
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const reader = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts"));
const proposition = jiti(path.join(repoRoot, "extensions/_shared/proposition.ts"));
const contract = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-contract.ts"));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-reader-"));
const sourceAbrain = path.join(tmpRoot, "source-abrain");
const emptySourceAbrain = path.join(tmpRoot, "empty-source-abrain");
const multiSourceAbrain = path.join(tmpRoot, "multi-source-abrain");
const excludedCommitmentSourceAbrain = path.join(tmpRoot, "excluded-commitment-source-abrain");
const publishedAbrain = path.join(tmpRoot, "published-abrain");
const emptyPublishedAbrain = path.join(tmpRoot, "empty-published-abrain");
const multiPublishedAbrain = path.join(tmpRoot, "multi-published-abrain");
const excludedCommitmentPublishedAbrain = path.join(tmpRoot, "excluded-commitment-published-abrain");
const sessionId = "019f569c-40d3-73f0-9a5f-666b395f6b9a";
const sessionFile = path.join(tmpRoot, "sessions", `${sessionId}.jsonl`);
const FIVE = ["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"];
const eventIds = [
  "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6",
  "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
  "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585",
];
let settings;
let passed = 0;
const failures = [];
let bundle;
let projectOnlyPublishedAbrain;
let projectOnlyBundleHash;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error?.message || error}`);
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error?.message || error}`);
  }
}

function stableRoot(abrain) {
  return path.join(abrain, ...publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"));
}

function bundleDirectory(abrain) {
  const value = fs.readlinkSync(path.join(stableRoot(abrain), "latest"));
  return path.join(stableRoot(abrain), value);
}

function clonePublished(label, source = publishedAbrain) {
  const target = path.join(tmpRoot, label);
  fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
  return target;
}

function sessionManager(id = sessionId, persisted = true) {
  return {
    getSessionId: () => id,
    getSessionFile: () => persisted ? sessionFile : undefined,
  };
}

function read(abrain, overrides = {}) {
  return reader.readPropositionPolicyStableViewForRuntime({
    abrainHome: abrain,
    settings: overrides.settings ?? settings,
    sessionManager: overrides.sessionManager ?? sessionManager(),
    ...(overrides.activeProjectId ? { activeProjectId: overrides.activeProjectId } : {}),
    ...(overrides.nowMs === undefined ? {} : { nowMs: overrides.nowMs }),
  });
}

function eventPath(home, eventId) {
  return path.join(home, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}

function policyFacets(spatialScope, causalParents = [], policy = true, quoteSha256 = null) {
  return {
    provenance_authority: { source_kind: "user", authority_kind: "user_attested", source_event_id: null, quote_sha256: quoteSha256 },
    spatial_scope: spatialScope,
    temporal_horizon: { horizon: "durable", valid_from: null, valid_until: null },
    trigger: { trigger_kind: "user_directive", trigger_ref: "fixture:adr0040-reader-excluded-commitments" },
    maturity: { state: "accepted", review_state: "reviewed" },
    contestability: { status: "uncontested", counterevidence_event_ids: [] },
    confidence: { score: 1, basis: "witnessed" },
    sensitivity: { classification: "public", handling: "none" },
    consumer_hints: { retrieval: true, policy, notes: [] },
    lineage: { causal_parents: causalParents, derives_from: [], supersedes: [] },
  };
}

function policyEvidenceEnvelope(statement, spatialScope) {
  return proposition.buildPropositionEnvelope(proposition.PROPOSITION_EVIDENCE_ENVELOPE_SCHEMA, {
    event_schema_version: proposition.PROPOSITION_EVIDENCE_BODY_SCHEMA,
    event_type: "proposition_observed",
    producer: { name: proposition.PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: "reader-full-bundle-fixture/v1" },
    epoch: { epoch_id: proposition.PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, genesis_event_id: eventIds[1] },
    proposition: { modality: "normative", statement, language: "en" },
    facets: policyFacets(spatialScope, [], true, hash(statement)),
  });
}

function policyLifecycleEnvelope(operation, targetEventId) {
  const eventType = operation === "archive" ? "proposition_archive_declared" : "proposition_reactivate_declared";
  return proposition.buildPropositionEnvelope(proposition.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, {
    event_schema_version: proposition.PROPOSITION_LIFECYCLE_BODY_SCHEMA,
    event_type: eventType,
    producer: { name: proposition.PROPOSITION_SCHEMA_CONTRACT_PRODUCER, version: "reader-full-bundle-fixture/v1" },
    epoch: { epoch_id: proposition.PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID, genesis_event_id: eventIds[1] },
    lifecycle: { operation, modality: "meta-lifecycle", effect: "declared_only", target_event_ids: [targetEventId], reason: `${operation} reader fixture` },
    facets: policyFacets({ scope_level: "global", project_id: null, domain: null }, [targetEventId], false),
  });
}

function writePropositionEnvelope(home, envelope) {
  const target = eventPath(home, envelope.event_id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, canonicalJson(envelope), "utf8");
}

function copySourceL1() {
  fs.mkdirSync(sourceAbrain, { recursive: true });
  for (const eventId of eventIds) {
    const target = eventPath(sourceAbrain, eventId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(eventPath("/home/worker/.abrain", eventId), target);
  }
  fs.cpSync(sourceAbrain, emptySourceAbrain, { recursive: true });
  fs.unlinkSync(eventPath(emptySourceAbrain, eventIds[0]));
  fs.cpSync(sourceAbrain, multiSourceAbrain, { recursive: true });
  const sourceEnvelope = JSON.parse(fs.readFileSync(eventPath(sourceAbrain, eventIds[0]), "utf8"));
  const statement = "Project-scoped policy fixture remains visible only in its active project.";
  sourceEnvelope.body.proposition.statement = statement;
  sourceEnvelope.body.facets.provenance_authority.quote_sha256 = hash(statement);
  sourceEnvelope.body.facets.spatial_scope = { scope_level: "project", project_id: "fixture-project", domain: null };
  sourceEnvelope.body.facets.trigger.trigger_ref = "fixture:adr0040-reader-multi-item";
  const eventId = hash(canonical(sourceEnvelope.body));
  sourceEnvelope.event_id = eventId;
  sourceEnvelope.body_hash = eventId;
  const target = eventPath(multiSourceAbrain, eventId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, canonicalJson(sourceEnvelope), "utf8");

  fs.mkdirSync(excludedCommitmentSourceAbrain, { recursive: true });
  const genesisTarget = eventPath(excludedCommitmentSourceAbrain, eventIds[1]);
  fs.mkdirSync(path.dirname(genesisTarget), { recursive: true });
  fs.copyFileSync(eventPath("/home/worker/.abrain", eventIds[1]), genesisTarget);
  const originalUnrepresentable = policyEvidenceEnvelope(
    "Original domain-scoped policy remains excluded because runtime scope cannot represent it.",
    { scope_level: "domain", project_id: null, domain: "engineering" },
  );
  const reactivated = policyEvidenceEnvelope(
    "Reactivated policy remains excluded from the original-only stable view.",
    { scope_level: "global", project_id: null, domain: null },
  );
  const archive = policyLifecycleEnvelope("archive", reactivated.event_id);
  const reactivate = policyLifecycleEnvelope("reactivate", archive.event_id);
  for (const envelope of [originalUnrepresentable, reactivated, archive, reactivate]) writePropositionEnvelope(excludedCommitmentSourceAbrain, envelope);

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, "{}\n", "utf8");
  for (const targetHome of [publishedAbrain, emptyPublishedAbrain, multiPublishedAbrain, excludedCommitmentPublishedAbrain]) fs.mkdirSync(targetHome, { recursive: true });
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function canonicalJson(value) {
  return `${canonical(value)}\n`;
}

function row(name, raw) {
  return { name, bytes: Buffer.byteLength(raw), sha256: hash(raw) };
}

function rewriteCrossProject(abrain) {
  const oldDir = bundleDirectory(abrain);
  const artifacts = Object.fromEntries(FIVE.map((name) => [name, fs.readFileSync(path.join(oldDir, name), "utf8")]));
  const view = JSON.parse(artifacts["view.json"]);
  const parity = JSON.parse(artifacts["parity.json"]);
  const manifest = JSON.parse(artifacts["manifest.json"]);
  const item = view.items[0];
  item.scope = { scope_level: "project", project_id: "other-project", domain: null };
  item.scope_sha256 = hash(canonical(item.scope));
  item.source_provenance[0].scope_sha256 = item.scope_sha256;
  const itemBase = { ...item };
  delete itemBase.item_payload_sha256;
  item.item_payload_sha256 = hash(canonical(itemBase));
  parity.deterministic_render.items_hash = hash(canonical(view.items));
  parity.scope_lineage.commitments[0].scope_sha256 = item.scope_sha256;
  parity.scope_lineage.commitments_hash = hash(canonical(parity.scope_lineage.commitments));
  artifacts["view.json"] = canonicalJson(view);
  artifacts["parity.json"] = canonicalJson(parity);
  manifest.stable_view.item_hashes = [item.item_payload_sha256];
  manifest.stable_view.item_hashes_hash = hash(canonical(manifest.stable_view.item_hashes));
  manifest.stable_view.scope_summary = {
    global_item_count: 0,
    project_item_count: 1,
    project_ids: ["other-project"],
    project_ids_hash: hash(canonical(["other-project"])),
  };
  rebuildInnerCompilerManifestBinding(manifest, artifacts);
  manifest.stable_view.non_manifest_artifact_rows = ["diagnostics.json", "parity.json", "view.json", "view.md"].map((name) => row(name, artifacts[name]));
  delete manifest.bundle_hash;
  delete manifest.manifest_hash;
  const bundleHash = hash(canonical(manifest));
  manifest.bundle_hash = bundleHash;
  manifest.manifest_hash = bundleHash;
  artifacts["manifest.json"] = canonicalJson(manifest);
  const newDir = path.join(path.dirname(oldDir), bundleHash);
  fs.renameSync(oldDir, newDir);
  for (const name of FIVE) fs.writeFileSync(path.join(newDir, name), artifacts[name], "utf8");
  const latest = path.join(stableRoot(abrain), "latest");
  fs.unlinkSync(latest);
  fs.symlinkSync(`bundles/${bundleHash}`, latest, "dir");
  return bundleHash;
}

function rewriteProvenanceAttack(abrain, mode) {
  const oldDir = bundleDirectory(abrain);
  const artifacts = Object.fromEntries(FIVE.map((name) => [name, fs.readFileSync(path.join(oldDir, name), "utf8")]));
  const view = JSON.parse(artifacts["view.json"]);
  const parity = JSON.parse(artifacts["parity.json"]);
  const manifest = JSON.parse(artifacts["manifest.json"]);
  const item = view.items[0];
  if (mode === "duplicate") item.source_provenance.push(JSON.parse(JSON.stringify(item.source_provenance[0])));
  else item.source_provenance[0].source_body_sha256 = "f".repeat(64);
  const itemBase = { ...item };
  delete itemBase.item_payload_sha256;
  item.item_payload_sha256 = hash(canonical(itemBase));
  parity.deterministic_render.items_hash = hash(canonical(view.items));
  artifacts["view.json"] = canonicalJson(view);
  artifacts["parity.json"] = canonicalJson(parity);
  manifest.stable_view.item_hashes = [item.item_payload_sha256];
  manifest.stable_view.item_hashes_hash = hash(canonical(manifest.stable_view.item_hashes));
  rebuildInnerCompilerManifestBinding(manifest, artifacts);
  manifest.stable_view.non_manifest_artifact_rows = ["diagnostics.json", "parity.json", "view.json", "view.md"].map((name) => row(name, artifacts[name]));
  delete manifest.bundle_hash;
  delete manifest.manifest_hash;
  const bundleHash = hash(canonical(manifest));
  manifest.bundle_hash = bundleHash;
  manifest.manifest_hash = bundleHash;
  artifacts["manifest.json"] = canonicalJson(manifest);
  const newDir = path.join(path.dirname(oldDir), bundleHash);
  fs.renameSync(oldDir, newDir);
  for (const name of FIVE) fs.writeFileSync(path.join(newDir, name), artifacts[name], "utf8");
  const latest = path.join(stableRoot(abrain), "latest");
  fs.unlinkSync(latest);
  fs.symlinkSync(`bundles/${bundleHash}`, latest, "dir");
  return bundleHash;
}

function rewriteItemLimitAttack(abrain) {
  const oldDir = bundleDirectory(abrain);
  const manifestPath = path.join(oldDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.stable_view.item_count = reader.PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_ITEMS + 1;
  manifest.stable_view.item_hashes = Array.from({ length: manifest.stable_view.item_count }, (_, index) => hash(`limit:${index}`));
  manifest.stable_view.item_hashes_hash = hash(canonical(manifest.stable_view.item_hashes));
  manifest.stable_view.scope_summary.global_item_count = manifest.stable_view.item_count;
  manifest.stable_view.scope_summary.project_item_count = 0;
  delete manifest.bundle_hash;
  delete manifest.manifest_hash;
  const bundleHash = hash(canonical(manifest));
  manifest.bundle_hash = bundleHash;
  manifest.manifest_hash = bundleHash;
  const newDir = path.join(path.dirname(oldDir), bundleHash);
  fs.renameSync(oldDir, newDir);
  fs.writeFileSync(path.join(newDir, "manifest.json"), canonicalJson(manifest), "utf8");
  const latest = path.join(stableRoot(abrain), "latest");
  fs.unlinkSync(latest);
  fs.symlinkSync(`bundles/${bundleHash}`, latest, "dir");
  return bundleHash;
}

function rewriteBundleDirectory(abrain, oldDir, artifacts, manifest) {
  delete manifest.bundle_hash;
  delete manifest.manifest_hash;
  const bundleHash = hash(canonical(manifest));
  manifest.bundle_hash = bundleHash;
  manifest.manifest_hash = bundleHash;
  artifacts["manifest.json"] = canonicalJson(manifest);
  const newDir = path.join(path.dirname(oldDir), bundleHash);
  fs.renameSync(oldDir, newDir);
  for (const name of FIVE) fs.writeFileSync(path.join(newDir, name), artifacts[name], "utf8");
  const latest = path.join(stableRoot(abrain), "latest");
  fs.unlinkSync(latest);
  fs.symlinkSync(`bundles/${bundleHash}`, latest, "dir");
  return bundleHash;
}

function rebuildInnerCompilerManifestBinding(manifest, artifacts) {
  const compilerArtifactRows = contract.PROPOSITION_POLICY_STABLE_VIEW_COMPILER_ARTIFACT_NAMES.map((name) => row(name, artifacts[name]));
  const base = contract.buildPropositionPolicyStableViewCompilerManifestBase({
    compileKey: manifest.compiler.compile_key,
    sourceBundleHash: manifest.projection.bundle_hash,
    compileProfileHash: manifest.compiler.compile_profile.profile_hash,
    decisionIdentity: manifest.compiler.decision_identity,
    fixtureSynthetic: false,
    resultKind: manifest.stable_view.result_kind,
    artifactRows: compilerArtifactRows,
    sourceClosure: manifest.stable_view.source_closure,
  });
  const manifestHash = hash(canonical(base));
  const raw = canonicalJson({ ...base, manifest_hash: manifestHash });
  manifest.compiler.compiler_output_manifest_hash = manifestHash;
  manifest.compiler.compiler_output_manifest_raw_sha256 = hash(raw);
}

function rewriteInternalSourceIdAttack(abrain) {
  const oldDir = bundleDirectory(abrain);
  const artifacts = Object.fromEntries(FIVE.map((name) => [name, fs.readFileSync(path.join(oldDir, name), "utf8")]));
  const diagnostics = JSON.parse(artifacts["diagnostics.json"]);
  const parity = JSON.parse(artifacts["parity.json"]);
  const manifest = JSON.parse(artifacts["manifest.json"]);
  const oldSourceId = diagnostics.diagnostics[0].source_event_id;
  const replacementSourceId = hash("fully-rehashed-internal-source-id");
  diagnostics.diagnostics[0].source_event_id = replacementSourceId;
  const disposition = parity.source_conservation.dispositions.find((rowValue) => rowValue.source_event_id === oldSourceId);
  assert(disposition, "excluded parity disposition missing from source-ID attack fixture");
  disposition.source_event_id = replacementSourceId;
  parity.source_conservation.dispositions.sort((left, right) => left.source_event_id.localeCompare(right.source_event_id));
  const sourceIds = parity.source_conservation.dispositions.map((rowValue) => rowValue.source_event_id);
  parity.source_conservation.source_event_ids_hash = hash(canonical(sourceIds));
  parity.source_conservation.dispositions_hash = hash(canonical(parity.source_conservation.dispositions));
  parity.source_conservation.diagnostics_hash = hash(canonical(diagnostics.diagnostics));
  manifest.stable_view.source_closure = {
    source_event_count: parity.source_conservation.source_event_count,
    source_event_ids_hash: parity.source_conservation.source_event_ids_hash,
    dispositions_hash: parity.source_conservation.dispositions_hash,
    diagnostic_count: parity.source_conservation.diagnostic_count,
    diagnostics_hash: parity.source_conservation.diagnostics_hash,
  };
  artifacts["diagnostics.json"] = canonicalJson(diagnostics);
  artifacts["parity.json"] = canonicalJson(parity);
  rebuildInnerCompilerManifestBinding(manifest, artifacts);
  manifest.stable_view.non_manifest_artifact_rows = ["diagnostics.json", "parity.json", "view.json", "view.md"].map((name) => row(name, artifacts[name]));
  return rewriteBundleDirectory(abrain, oldDir, artifacts, manifest);
}

function rewriteCompilerManifestHashAttack(abrain) {
  const oldDir = bundleDirectory(abrain);
  const artifacts = Object.fromEntries(FIVE.map((name) => [name, fs.readFileSync(path.join(oldDir, name), "utf8")]));
  const manifest = JSON.parse(artifacts["manifest.json"]);
  manifest.compiler.compiler_output_manifest_hash = "f".repeat(64);
  manifest.compiler.compiler_output_manifest_raw_sha256 = "e".repeat(64);
  return rewriteBundleDirectory(abrain, oldDir, artifacts, manifest);
}

function rewriteExcludedCommitmentShapeAttack(abrain) {
  const oldDir = bundleDirectory(abrain);
  const artifacts = Object.fromEntries(FIVE.map((name) => [name, fs.readFileSync(path.join(oldDir, name), "utf8")]));
  const parity = JSON.parse(artifacts["parity.json"]);
  const manifest = JSON.parse(artifacts["manifest.json"]);
  const excluded = parity.scope_lineage.commitments.find((commitment) => commitment.item_id === null);
  assert(excluded, "excluded commitment attack fixture has no excluded commitment");
  excluded.statement_sha256 = "not-a-sha256";
  parity.scope_lineage.commitments_hash = hash(canonical(parity.scope_lineage.commitments));
  artifacts["parity.json"] = canonicalJson(parity);
  rebuildInnerCompilerManifestBinding(manifest, artifacts);
  manifest.stable_view.non_manifest_artifact_rows = ["diagnostics.json", "parity.json", "view.json", "view.md"].map((name) => row(name, artifacts[name]));
  return rewriteBundleDirectory(abrain, oldDir, artifacts, manifest);
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function stageRuleInjector(outRoot) {
  const files = [
    ["extensions/abrain/rule-injector/index.ts", "abrain/rule-injector/index.js"],
    ["extensions/abrain/rule-injector/dualread-audit.ts", "abrain/rule-injector/dualread-audit.js"],
    ["extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts", "abrain/rule-injector/proposition-policy-stable-view-reader.js"],
    ["extensions/abrain/rule-injector/proposition-policy-stable-view-runtime-audit.ts", "abrain/rule-injector/proposition-policy-stable-view-runtime-audit.js"],
    ["extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-runtime-audit.ts", "abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-runtime-audit.js"],
    ["extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.ts", "abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.js"],
    ["extensions/_shared/footer-status.ts", "_shared/footer-status.js"],
    ["extensions/_shared/runtime.ts", "_shared/runtime.js"],
    ["extensions/_shared/durable-write.ts", "_shared/durable-write.js"],
    ["extensions/_shared/jcs.ts", "_shared/jcs.js"],
    ["extensions/_shared/proposition.ts", "_shared/proposition.js"],
    ["extensions/_shared/proposition-policy-stable-view-contract.ts", "_shared/proposition-policy-stable-view-contract.js"],
    ["extensions/_shared/l1-schema-registry.ts", "_shared/l1-schema-registry.js"],
    ["extensions/_shared/canonical-l2-contract.ts", "_shared/canonical-l2-contract.js"],
    ["extensions/_shared/retained-directory-ofd-lock.ts", "_shared/retained-directory-ofd-lock.js"],
    ["extensions/_shared/proposition-lifecycle-freshness-production-core.ts", "_shared/proposition-lifecycle-freshness-production-core.js"],
    ["extensions/_shared/typescript-static-dependency-graph.ts", "_shared/typescript-static-dependency-graph.js"],
    ["extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts", "_shared/proposition-lifecycle-freshness-d3-v2-session-start.js"],
    ["extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-activation.ts", "_shared/proposition-lifecycle-freshness-d3-v2-session-start-activation.js"],
    ["extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-fence.ts", "_shared/proposition-lifecycle-freshness-d3-v2-session-start-fence.js"],
    ["extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-rollback.ts", "_shared/proposition-lifecycle-freshness-d3-v2-session-start-rollback.js"],
    ["extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts", "_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.js"],
    ["extensions/_shared/retained-fd-create-only.ts", "_shared/retained-fd-create-only.js"],
    ["extensions/_shared/strict-json.ts", "_shared/strict-json.js"],
    ["extensions/_shared/trusted-session-transcript.ts", "_shared/trusted-session-transcript.js"],
    ["extensions/memory/parser.ts", "memory/parser.js"],
    ["extensions/memory/direction-impact.ts", "memory/direction-impact.js"],
    ["extensions/memory/utils.ts", "memory/utils.js"],
    ["extensions/memory/settings.ts", "memory/settings.js"],
    ["extensions/sediment/settings.ts", "sediment/settings.js"],
    ["extensions/sediment/knowledge-evidence.ts", "sediment/knowledge-evidence.js"],
  ];
  writeFile(path.join(outRoot, "_shared", "pi-internals.js"), `module.exports = {
  isSubAgentSession: (ctx) => ctx && ctx.__subagent === true,
};\n`);
  // Default-off D3-v2 adapter pulls typescript only for static graph tooling; fixture never builds manifests.
  writeFile(path.join(outRoot, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", main: "index.js" }));
  writeFile(path.join(outRoot, "node_modules", "typescript", "index.js"), `module.exports = {
  ScriptTarget: { ES2022: 9 },
  ModuleKind: { CommonJS: 1, ESNext: 99 },
  ModuleResolutionKind: { NodeNext: 99 },
  createSourceFile() { return { statements: [], forEachChild() {} }; },
  createProgram() { return { getSourceFile() { return null; }, getTypeChecker() { return { getSymbolAtLocation() { return null; } }; } }; },
  sys: { fileExists() { return false; }, readFile() { return undefined; }, writeFile() {}, resolvePath(p) { return p; } },
};\n`);
  for (const [source, target] of files) writeFile(path.join(outRoot, target), transpile(path.join(repoRoot, source)));
  fs.mkdirSync(path.join(outRoot, "schemas"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(outRoot, "schemas", "l1-schema-role-registry.json"));
}

function writeLegacyRule(abrain) {
  const file = path.join(abrain, "rules", "always", "legacy-fallback.md");
  writeFile(file, [
    "---",
    "title: Legacy Fallback",
    "kind: pattern",
    "status: active",
    "confidence: 9",
    "must_do_summary: Preserve exact legacy fallback bytes.",
    "---",
    "# Legacy Fallback",
    "",
    "Legacy body.",
    "",
  ].join("\n"));
}

function writeValidCompiledView(abrain) {
  const latest = path.join(abrain, ".state", "sediment", "constraint-shadow", "latest");
  writeFile(path.join(latest, "decision.json"), JSON.stringify({
    schemaVersion: "constraint-shadow-decision/v1",
    constraints: [{ scope: { kind: "global" }, injectMode: "always" }],
  }, null, 2));
  writeFile(path.join(latest, "compiled-view.md"), "## Global always\n\n### ADR0039 Compiled Fixture\n- Existing compiled decision remains authoritative on ADR0040 not-ok.\n");
  writeFile(path.join(latest, "event-coverage.json"), JSON.stringify({
    schemaVersion: "constraint-event-coverage/v1",
    summary: { coverageRatio: 1, injectableCoverageRatio: 1, queuedEvents: 0, appendFailedEvents: 0 },
    rows: [],
  }, null, 2));
}

function refreshLatestPublication(abrain) {
  const latest = path.join(stableRoot(abrain), "latest");
  const value = fs.readlinkSync(latest);
  fs.unlinkSync(latest);
  fs.symlinkSync(value, latest, "dir");
}

async function assertZeroItemRuleInjectorE2E(label, abrain, expectedBundleHash) {
  writeLegacyRule(abrain);
  writeValidCompiledView(abrain);
  const runtimeHome = path.join(tmpRoot, `runtime-home-zero-${label}`);
  writeFile(path.join(runtimeHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
    ruleInjector: {
      compiledViewInjection: {
        enabled: true,
        fallbackToLegacyOnError: false,
        requireFresh: false,
        staleAfterMs: 86400000,
        maxReadBytes: 1000000,
        minCoverageRatio: 1,
      },
      propositionPolicyStableViewInjection: {
        enabled: true,
        selector: { session_ids: [sessionId] },
        expectedBundleHash,
        maxSelectionAgeMs: 300000,
        maxReadBytes: reader.PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_MAX_READ_BYTES_LIMIT,
      },
    },
  }, null, 2));
  const outRoot = path.join(tmpRoot, `compiled-runtime-zero-${label}`);
  stageRuleInjector(outRoot);
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousAbrain = process.env.ABRAIN_ROOT;
  try {
    process.env.HOME = runtimeHome;
    process.env.USERPROFILE = runtimeHome;
    process.env.ABRAIN_ROOT = abrain;
    const stagedRequire = createRequire(path.join(outRoot, "runner.cjs"));
    const injector = stagedRequire("./abrain/rule-injector/index.js");
    const events = new Map();
    const statuses = [];
    injector.default({
      on(name, handler) { events.set(name, handler); },
      registerCommand() {},
    });
    const ctx = {
      cwd: tmpRoot,
      sessionManager: sessionManager(),
      ui: { setStatus(_key, value) { statuses.push(String(value)); }, notify() {} },
    };
    refreshLatestPublication(abrain);
    await events.get("session_start")({ reason: "startup" }, ctx);
    const result = await events.get("before_agent_start")({ systemPrompt: "BASE", prompt: `zero-item-${label}` }, ctx);
    const prompt = result?.systemPrompt ?? "";
    assert((prompt.match(/BEGIN_ABRAIN_RULES/g) ?? []).length === 1, `${label} zero-item prompt fence count differs`);
    assert(prompt.includes("source=proposition-policy-stable-view"), `${label} zero-item selected stable source missing`);
    const payloadStart = prompt.indexOf("-->\n") + 4;
    const payloadEnd = prompt.indexOf("<!-- END_ABRAIN_RULES -->");
    assert(payloadStart >= 4 && payloadEnd >= payloadStart && prompt.slice(payloadStart, payloadEnd) === "", `${label} zero-item stable payload is not empty`);
    assert(!prompt.includes("ADR0039 Compiled Fixture") && !prompt.includes("Legacy Fallback"), `${label} zero-item path fell back to ADR0039/legacy`);
    assert(statuses.at(-1) === `🧠 rules: policy stable-view 0 items (0 B, bundle ${expectedBundleHash.slice(0, 8)}…)`, `${label} zero-item footer differs: ${statuses.at(-1)}`);
    const auditFile = path.join(runtimeHome, ".pi", ".pi-astack", "adr0040-policy-stable-view-runtime-audit.jsonl");
    const auditRow = readJsonLines(auditFile).at(-1);
    assert(auditRow?.decision === "policy_stable_view_injected" && auditRow.reason === "selected_valid"
      && auditRow.item_count === 0 && auditRow.view_bytes === 0, `${label} zero-item audit differs`);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    if (previousAbrain === undefined) delete process.env.ABRAIN_ROOT; else process.env.ABRAIN_ROOT = previousAbrain;
  }
}

console.log("ADR0040 strict stable-view reader smoke");
copySourceL1();

try {
  await asyncCheck("publisher fixture prepares one valid fixed-path runtime bundle", async () => {
    bundle = await publisher.buildPropositionPolicyStableViewMvpBundle({ sourceAbrainHome: sourceAbrain, repoRoot });
    settings = {
      enabled: true,
      selector: { session_ids: [sessionId] },
      expectedBundleHash: bundle.bundle_hash,
      maxSelectionAgeMs: 300000,
      maxReadBytes: 262144,
    };
    const result = publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: publishedAbrain, bundle });
    assert(result.stable_item_count === 1 && result.view_utf8_bytes === 341, "published fixture shape differs");
  });

  await asyncCheck("real P2a/compiler/publisher/reader chain handles 0 and 2-item mixed-scope sources", async () => {
    const emptyBundle = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: emptySourceAbrain, repoRoot });
    const multiBundle = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: multiSourceAbrain, repoRoot });
    publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: emptyPublishedAbrain, bundle: emptyBundle });
    publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: multiPublishedAbrain, bundle: multiBundle });
    const emptySettings = { ...settings, expectedBundleHash: emptyBundle.bundle_hash };
    const multiSettings = { ...settings, expectedBundleHash: multiBundle.bundle_hash };
    const emptyResult = read(emptyPublishedAbrain, { settings: emptySettings });
    assert(emptyBundle.source_bundle.manifest.result.entry_count === 0 && emptyBundle.source_bundle.manifest.result.exclusion_count === 1, "zero-candidate P2a counts differ");
    assert(emptyResult.ok && emptyResult.itemCount === 0 && emptyResult.viewMd === "" && emptyResult.viewBytes === 0, `empty result=${JSON.stringify(emptyResult)}`);
    const fullView = JSON.parse(multiBundle.artifacts["view.json"]);
    const globalItems = fullView.items.filter((item) => item.scope.scope_level === "global");
    const projectItems = fullView.items.filter((item) => item.scope.scope_level === "project" && item.scope.project_id === "fixture-project");
    assert(multiBundle.source_bundle.manifest.source.input_event_ids.length === 4
      && multiBundle.source_bundle.manifest.result.entry_count === 2 && fullView.items.length === 2
      && globalItems.length === 1 && projectItems.length === 1, "2-item mixed-scope source counts differ");
    const noProject = read(multiPublishedAbrain, { settings: multiSettings });
    const wrongProject = read(multiPublishedAbrain, { settings: multiSettings, activeProjectId: "other-project" });
    const matchingProject = read(multiPublishedAbrain, { settings: multiSettings, activeProjectId: "fixture-project" });
    const expectedGlobal = `${globalItems.map((item) => item.statement).join("\n\n")}\n`;
    assert(noProject.ok && noProject.itemCount === 1 && noProject.viewMd === expectedGlobal, `mixed no-project=${JSON.stringify(noProject)}`);
    assert(wrongProject.ok && wrongProject.itemCount === 1 && wrongProject.viewMd === expectedGlobal, `mixed wrong-project=${JSON.stringify(wrongProject)}`);
    assert(matchingProject.ok && matchingProject.itemCount === 2 && matchingProject.viewMd === multiBundle.artifacts["view.md"], `mixed matching=${JSON.stringify(matchingProject)}`);
  });

  await asyncCheck("real full bundle accepts excluded original unrepresentable scope and excluded reactivated commitments", async () => {
    const commitmentBundle = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: excludedCommitmentSourceAbrain, repoRoot });
    const view = JSON.parse(commitmentBundle.artifacts["view.json"]);
    const parity = JSON.parse(commitmentBundle.artifacts["parity.json"]);
    const candidates = commitmentBundle.manifest.candidate_dispositions.dispositions;
    const activations = parity.scope_lineage.commitments.map((row) => row.lifecycle_activation).sort();
    assert(commitmentBundle.source_bundle.manifest.result.entry_count === 2
      && commitmentBundle.source_bundle.manifest.result.exclusion_count === 0
      && candidates.length === 2 && candidates.every((row) => row.disposition === "excluded"), "excluded commitment candidate accounting differs");
    assert(JSON.stringify(activations) === JSON.stringify(["original", "reactivated"]), `excluded lifecycle activations=${JSON.stringify(activations)}`);
    assert(view.items.length === 0 && commitmentBundle.artifacts["view.md"] === "", "excluded commitments emitted a view item");
    publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: excludedCommitmentPublishedAbrain, bundle: commitmentBundle });
    const result = read(excludedCommitmentPublishedAbrain, { settings: { ...settings, expectedBundleHash: commitmentBundle.bundle_hash } });
    assert(result.ok && result.itemCount === 0 && result.viewMd === "" && result.viewBytes === 0, `excluded commitment result=${JSON.stringify(result)}`);
  });

  check("reader is default-off, selector-only, artifact-bound, and strictly bounded", () => {
    const resolved = reader.resolvePropositionPolicyStableViewInjectionSettings({
      maxReadBytes: Number.MAX_SAFE_INTEGER,
      maxSelectionAgeMs: Number.MAX_SAFE_INTEGER,
      expectedBundleHash: bundle.bundle_hash.toUpperCase(),
      selector: { session_ids: [" x ", "x"] },
    });
    assert(resolved.enabled === false, "reader default enabled");
    assert(resolved.expectedBundleHash === null, "non-lowercase expected hash was accepted");
    assert(resolved.maxSelectionAgeMs === 3600000, "maxSelectionAgeMs upper cap missing");
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
    assert(schema.properties.ruleInjector.properties.propositionPolicyStableViewInjection.properties.maxSelectionAgeMs.maximum === 3600000,
      "settings schema maxSelectionAgeMs upper cap differs");
    assert(resolved.maxReadBytes === 262144, "maxReadBytes upper cap missing");
    assert(JSON.stringify(resolved.selector.session_ids) === JSON.stringify(["x"]), "selector normalization differs");
    const disabled = read(publishedAbrain, { settings: resolved });
    assert(!disabled.ok && disabled.reason === "disabled", `disabled result=${JSON.stringify(disabled)}`);
    const unbound = read(publishedAbrain, { settings: { ...resolved, enabled: true, selector: { session_ids: [sessionId] } } });
    assert(!unbound.ok && unbound.reason === "expected_bundle_hash_missing", `unbound result=${JSON.stringify(unbound)}`);
    const minimum = reader.resolvePropositionPolicyStableViewInjectionSettings({ maxSelectionAgeMs: 1 });
    assert(minimum.maxSelectionAgeMs === 1000, "maxSelectionAgeMs lower cap missing");
  });

  check("unselected and ephemeral sessions never read or select the stable view", () => {
    const unselected = read(publishedAbrain, { sessionManager: sessionManager("other-session", true) });
    const ephemeral = read(publishedAbrain, { sessionManager: sessionManager(sessionId, false) });
    assert(!unselected.ok && unselected.reason === "unselected_session", `unselected=${JSON.stringify(unselected)}`);
    assert(!ephemeral.ok && ephemeral.reason === "ephemeral_session", `ephemeral=${JSON.stringify(ephemeral)}`);
  });

  check("fresh selected persisted session reads the exact configured nonempty view.md", () => {
    const result = read(publishedAbrain);
    assert(result.ok, `selected read failed: ${JSON.stringify(result)}`);
    assert(result.viewMd === bundle.artifacts["view.md"], "reader changed view.md bytes");
    assert(result.itemCount === 1 && result.viewBytes === 341 && result.bundleHash === bundle.bundle_hash, "selected metadata differs");
    assert(result.selectionAgeMs >= 0 && result.selectionAgeMs <= settings.maxSelectionAgeMs, "fresh selection age metadata differs");
  });

  check("expected bundle mismatch fails before artifact use and age boundary is exact", () => {
    const unexpected = read(publishedAbrain, { settings: { ...settings, expectedBundleHash: "0".repeat(64) } });
    assert(!unexpected.ok && unexpected.reason === "unexpected_bundle_hash", `unexpected=${JSON.stringify(unexpected)}`);
    const latestStat = fs.lstatSync(path.join(stableRoot(publishedAbrain), "latest"));
    const publishedAt = Math.max(latestStat.mtimeMs, latestStat.ctimeMs);
    const boundary = read(publishedAbrain, { nowMs: publishedAt + settings.maxSelectionAgeMs });
    const expired = read(publishedAbrain, { nowMs: publishedAt + settings.maxSelectionAgeMs + 1 });
    assert(boundary.ok && boundary.selectionAgeMs === settings.maxSelectionAgeMs, `boundary=${JSON.stringify(boundary)}`);
    assert(!expired.ok && expired.reason === "selection_expired", `expired=${JSON.stringify(expired)}`);
  });

  check("invalid manifest, hash mismatch, partial bundle, oversize, and symlink latest all fail closed", () => {
    const invalid = clonePublished("attack-invalid-manifest");
    const invalidManifest = path.join(bundleDirectory(invalid), "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(invalidManifest, "utf8"));
    parsed.authority = "foreign";
    fs.writeFileSync(invalidManifest, canonicalJson(parsed));
    const invalidResult = read(invalid);
    assert(!invalidResult.ok && invalidResult.reason === "manifest_identity", `invalid=${JSON.stringify(invalidResult)}`);

    const mismatch = clonePublished("attack-hash-mismatch");
    fs.appendFileSync(path.join(bundleDirectory(mismatch), "view.md"), "tampered\n");
    const mismatchResult = read(mismatch);
    assert(!mismatchResult.ok && ["artifact_hash_mismatch", "view_md_mismatch"].includes(mismatchResult.reason), `mismatch=${JSON.stringify(mismatchResult)}`);

    const partial = clonePublished("attack-partial");
    fs.unlinkSync(path.join(bundleDirectory(partial), "parity.json"));
    const partialResult = read(partial);
    assert(!partialResult.ok && partialResult.reason === "partial_or_foreign", `partial=${JSON.stringify(partialResult)}`);

    const oversize = read(publishedAbrain, { settings: { ...settings, maxReadBytes: 1024 } });
    assert(!oversize.ok && oversize.reason === "oversize", `oversize=${JSON.stringify(oversize)}`);

    const symlink = clonePublished("attack-latest-symlink");
    const latest = path.join(stableRoot(symlink), "latest");
    fs.unlinkSync(latest);
    fs.symlinkSync("../../escape", latest, "dir");
    const symlinkResult = read(symlink);
    assert(!symlinkResult.ok && symlinkResult.reason === "latest_invalid", `symlink=${JSON.stringify(symlinkResult)}`);
  });

  check("fully rehashed duplicate/conflicting provenance and item-count overflow fail closed", () => {
    for (const mode of ["duplicate", "conflict"]) {
      const attacked = clonePublished(`attack-provenance-${mode}`);
      const attackedHash = rewriteProvenanceAttack(attacked, mode);
      const result = read(attacked, { settings: { ...settings, expectedBundleHash: attackedHash } });
      assert(!result.ok && result.reason === "view_provenance", `${mode} provenance=${JSON.stringify(result)}`);
    }
    const overLimit = clonePublished("attack-item-limit");
    const overLimitHash = rewriteItemLimitAttack(overLimit);
    const limitResult = read(overLimit, { settings: { ...settings, expectedBundleHash: overLimitHash } });
    assert(!limitResult.ok && limitResult.reason === "stable_contract", `item limit=${JSON.stringify(limitResult)}`);
  });

  check("fully rehashed internal source-ID replacement cannot detach parity from canonical evidence accounting", () => {
    const attacked = clonePublished("attack-internal-source-id");
    const attackedHash = rewriteInternalSourceIdAttack(attacked);
    const result = read(attacked, { settings: { ...settings, expectedBundleHash: attackedHash } });
    assert(!result.ok && result.reason === "source_conservation", `source-ID replacement=${JSON.stringify(result)}`);
  });

  check("fully rehashed excluded commitment with malformed statement hash fails strict shape validation", () => {
    const attacked = clonePublished("attack-excluded-commitment-shape", excludedCommitmentPublishedAbrain);
    const attackedHash = rewriteExcludedCommitmentShapeAttack(attacked);
    const result = read(attacked, { settings: { ...settings, expectedBundleHash: attackedHash } });
    assert(!result.ok && result.reason === "hash_mismatch", `excluded commitment shape=${JSON.stringify(result)}`);
  });

  check("fully rehashed arbitrary compiler manifest hashes fail reconstructable inner-manifest binding", () => {
    const attacked = clonePublished("attack-compiler-manifest-hashes");
    const attackedHash = rewriteCompilerManifestHashAttack(attacked);
    const result = read(attacked, { settings: { ...settings, expectedBundleHash: attackedHash } });
    assert(!result.ok && result.reason === "compiler_manifest_binding", `compiler manifest hashes=${JSON.stringify(result)}`);
  });

  check("project-scoped items are deterministically filtered for mismatched/unbound projects and visible only to the matching project", () => {
    projectOnlyPublishedAbrain = clonePublished("mixed-scope-project-filter");
    projectOnlyBundleHash = rewriteCrossProject(projectOnlyPublishedAbrain);
    const crossSettings = { ...settings, expectedBundleHash: projectOnlyBundleHash };
    const mismatched = read(projectOnlyPublishedAbrain, { activeProjectId: "current-project", settings: crossSettings });
    const unbound = read(projectOnlyPublishedAbrain, { settings: crossSettings });
    const matching = read(projectOnlyPublishedAbrain, { activeProjectId: "other-project", settings: crossSettings });
    assert(mismatched.ok && mismatched.itemCount === 0 && mismatched.viewMd === "" && mismatched.viewBytes === 0, `mismatched=${JSON.stringify(mismatched)}`);
    assert(unbound.ok && unbound.itemCount === 0 && unbound.viewMd === "" && unbound.viewBytes === 0, `unbound=${JSON.stringify(unbound)}`);
    assert(matching.ok && matching.itemCount === 1 && matching.viewMd === bundle.artifacts["view.md"], `matching=${JSON.stringify(matching)}`);
  });

  await asyncCheck("rule injector keeps selected valid empty and project-filtered-to-zero views on ADR0040 with dynamic zero counts", async () => {
    const emptyBundleHash = fs.readlinkSync(path.join(stableRoot(emptyPublishedAbrain), "latest")).split("/").at(-1);
    assert(typeof emptyBundleHash === "string" && typeof projectOnlyBundleHash === "string", "zero-item E2E bundle identity missing");
    await assertZeroItemRuleInjectorE2E("valid-empty", emptyPublishedAbrain, emptyBundleHash);
    await assertZeroItemRuleInjectorE2E("project-filter-zero", projectOnlyPublishedAbrain, projectOnlyBundleHash);
  });

  await asyncCheck("rule injector uses one ADR0040 fence only on success; every not-ok preserves the compiled decision", async () => {
    writeLegacyRule(publishedAbrain);
    writeValidCompiledView(publishedAbrain);
    const runtimeHome = path.join(tmpRoot, "runtime-home");
    writeFile(path.join(runtimeHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
      ruleInjector: {
        compiledViewInjection: {
          enabled: true,
          fallbackToLegacyOnError: false,
          requireFresh: false,
          staleAfterMs: 86400000,
          maxReadBytes: 1000000,
          minCoverageRatio: 1,
        },
        propositionPolicyStableViewInjection: {
          enabled: true,
          selector: { session_ids: [sessionId] },
          expectedBundleHash: bundle.bundle_hash,
          maxSelectionAgeMs: 1000,
          maxReadBytes: 262144,
        },
      },
    }, null, 2));
    const outRoot = path.join(tmpRoot, "compiled-runtime");
    stageRuleInjector(outRoot);
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousAbrain = process.env.ABRAIN_ROOT;
    const originalRandomBytes = crypto.randomBytes;
    const fixedNonce = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    try {
      process.env.HOME = runtimeHome;
      process.env.USERPROFILE = runtimeHome;
      process.env.ABRAIN_ROOT = publishedAbrain;
      crypto.randomBytes = () => Buffer.from(fixedNonce);
      const stagedRequire = createRequire(path.join(outRoot, "runner.cjs"));
      const injector = stagedRequire("./abrain/rule-injector/index.js");
      const events = new Map();
      const commands = new Map();
      injector.default({
        on(name, handler) { events.set(name, handler); },
        registerCommand(name, options) { commands.set(name, options); },
      });
      const sessionStart = events.get("session_start");
      const beforeAgent = events.get("before_agent_start");
      assert(typeof sessionStart === "function" && typeof beforeAgent === "function", "rule-injector handlers missing");
      assert(typeof commands.get("rule")?.handler === "function", "rule-injector reload command missing");
      const notifications = [];
      const statuses = [];
      const ctx = {
        cwd: tmpRoot,
        sessionManager: sessionManager(),
        ui: {
          setStatus(key, value) { statuses.push([String(key), String(value)]); },
          notify(message, type) { notifications.push([String(message), type]); },
        },
      };
      const lastFooter = () => statuses.at(-1)?.[1] ?? "";
      const audit = stagedRequire("./abrain/rule-injector/proposition-policy-stable-view-runtime-audit.js");
      const auditFile = path.join(runtimeHome, ".pi", ".pi-astack", "adr0040-policy-stable-view-runtime-audit.jsonl");
      assert(audit.PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_FILE === auditFile, "runtime audit path is not fixed under ~/.pi/.pi-astack");
      refreshLatestPublication(publishedAbrain);
      await sessionStart({ reason: "startup" }, ctx);
      const selectedUserText = "ADR0040 runtime success correlation text";
      const selectedStartedAt = Date.now();
      const selected = await beforeAgent({ systemPrompt: "BASE", prompt: selectedUserText }, ctx);
      const selectedFinishedAt = Date.now();
      const prompt = selected?.systemPrompt ?? "";
      assert((prompt.match(/BEGIN_ABRAIN_RULES/g) ?? []).length === 1, "selected prompt contains multiple rule fences");
      assert(prompt.includes("source=proposition-policy-stable-view"), "selected source marker missing");
      assert((prompt.split(bundle.artifacts["view.md"]).length - 1) === 1, "exact view.md was not injected once");
      assert(!prompt.includes("Legacy Fallback"), "selected path added a second legacy fence");
      const payloadStart = prompt.indexOf("-->\n") + 4;
      const payloadEnd = prompt.indexOf("<!-- END_ABRAIN_RULES -->");
      assert(prompt.slice(payloadStart, payloadEnd) === bundle.artifacts["view.md"], "fence payload is not exact view.md bytes");

      const expectedStableFooter = `🧠 rules: policy stable-view 1 item (341 B, bundle ${bundle.bundle_hash.slice(0, 8)}…)`;
      assert(lastFooter() === expectedStableFooter, `stable footer differs: ${lastFooter()}`);
      injector.refreshRulesFooterRealtime(tmpRoot, injector.resolveRuleInjectorSettings());
      assert(lastFooter() === expectedStableFooter, `watcher refresh replaced stable footer: ${lastFooter()}`);
      await sessionStart({ reason: "same-session-refresh" }, ctx);
      assert(lastFooter() === expectedStableFooter, `session_start replaced stable footer: ${lastFooter()}`);
      await commands.get("rule").handler("reload", ctx);
      assert(lastFooter() === expectedStableFooter, `/rule reload replaced stable footer: ${lastFooter()}`);

      assert(fs.existsSync(auditFile), "selected success did not create the fixed runtime audit");
      const successRaw = fs.readFileSync(auditFile, "utf8");
      const successRows = readJsonLines(auditFile);
      assert(successRows.length === 1, `selected success audit row count=${successRows.length}`);
      const successRow = successRows[0];
      assert(successRaw === `${canonical(successRow)}\n`, "runtime audit is not one canonical JSON line");
      assert(successRow.schema === "adr0040-policy-stable-view-runtime-audit" && successRow.version === 1, "runtime audit schema/version differs");
      const expectedAuditKeys = [
        "begin_fence_count", "bundle_hash", "contains_compiled_marker", "contains_legacy_catalog_marker",
        "contains_policy_stable_marker", "decision", "end_fence_count", "item_count", "latest_user_text_bytes",
        "latest_user_text_sha256", "manifest_hash", "pid", "reason", "rendered_prompt_bytes",
        "rendered_prompt_sha256", "schema", "session_id", "timestamp", "version", "view_bytes", "view_md_hash",
      ];
      assert(JSON.stringify(Object.keys(successRow).sort()) === JSON.stringify(expectedAuditKeys), "runtime audit fields exceed or miss the allowlist");
      assert(successRow.pid === process.pid && successRow.session_id === sessionId, "runtime audit pid/session correlation differs");
      assert(!Object.hasOwn(successRow, "latest_user_message_id"), "before_agent_start claimed an unavailable current user message id");
      assert(successRow.latest_user_text_sha256 === hash(selectedUserText)
        && successRow.latest_user_text_bytes === Buffer.byteLength(selectedUserText), "runtime audit user text hash/bytes differ");
      const successTimestamp = Date.parse(successRow.timestamp);
      assert(successTimestamp >= selectedStartedAt && successTimestamp <= selectedFinishedAt, "runtime audit timestamp does not correlate with the hook call");
      assert(successRow.decision === "policy_stable_view_injected" && successRow.reason === "selected_valid", "success audit decision/reason differs");
      assert(successRow.bundle_hash === bundle.bundle_hash && successRow.manifest_hash === bundle.bundle_hash, "success audit bundle/manifest hash differs");
      assert(successRow.view_md_hash === hash(bundle.artifacts["view.md"])
        && successRow.view_bytes === Buffer.byteLength(bundle.artifacts["view.md"])
        && successRow.item_count === 1, "success audit stable-view metadata differs");
      assert(successRow.rendered_prompt_sha256 === hash(prompt)
        && successRow.rendered_prompt_bytes === Buffer.byteLength(prompt), "success audit rendered prompt hash/bytes differ");
      assert(successRow.begin_fence_count === 1 && successRow.end_fence_count === 1
        && successRow.contains_policy_stable_marker === true
        && successRow.contains_compiled_marker === false
        && successRow.contains_legacy_catalog_marker === false, "success audit fence/marker proof differs");
      assert(!successRaw.includes(selectedUserText)
        && !successRaw.includes(bundle.artifacts["view.md"].trim())
        && !successRaw.includes("Legacy body."), "runtime audit leaked user or policy/legacy prompt body");
      if (process.platform !== "win32") {
        assert((fs.statSync(path.dirname(auditFile)).mode & 0o777) === 0o700, "runtime audit parent mode is not 0700");
        assert((fs.statSync(auditFile).mode & 0o777) === 0o600, "runtime audit file mode is not 0600");
      }

      const fixedCache = injector.scanRules({ abrainHome: publishedAbrain, cwd: tmpRoot, nonce: fixedNonce.toString("hex") });
      const runtimeSettings = injector.resolveRuleInjectorSettings();
      const normalDecision = injector.decideRuntimeRuleInjection({
        cache: fixedCache,
        globalSettings: runtimeSettings,
        runtimeSettings,
        liveCanary: { active: false },
      });
      assert(normalDecision.decision === "compiled_injected" && normalDecision.injection, "fixture normal path is not compiled");
      const expectedCompiled = `BASE\n\n${normalDecision.injection}`;
      const unselectedCtx = { ...ctx, sessionManager: sessionManager("other-session", true) };
      const unselected = await beforeAgent({ systemPrompt: "BASE", prompt: "unselected audit noise" }, unselectedCtx);
      assert(unselected?.systemPrompt === expectedCompiled, "unselected result bypassed the existing compiled decision");
      assert(lastFooter().includes("rules: compiled 1 always, 0 listed"), `unselected footer lost normal compiled source: ${lastFooter()}`);
      assert(!lastFooter().includes("policy stable-view") && !lastFooter().includes("policy fallback"), `unselected footer gained policy status: ${lastFooter()}`);
      assert(readJsonLines(auditFile).length === 1, "unselected session wrote a runtime audit row");

      const viewPath = path.join(bundleDirectory(publishedAbrain), "view.md");
      const originalView = fs.readFileSync(viewPath, "utf8");
      fs.appendFileSync(viewPath, "tamper\n");
      const fallbackUserText = "ADR0040 runtime fallback correlation text";
      const invalid = await beforeAgent({ systemPrompt: "BASE", prompt: fallbackUserText }, ctx);
      fs.writeFileSync(viewPath, originalView, "utf8");
      assert(invalid?.systemPrompt === expectedCompiled, "invalid selected result bypassed the existing compiled decision");
      assert(!invalid.systemPrompt.includes("Legacy Fallback"), "invalid selected result composed raw legacy");
      const fallbackRows = readJsonLines(auditFile);
      assert(fallbackRows.length === 2, `selected fallback audit row count=${fallbackRows.length}`);
      const fallbackRow = fallbackRows[1];
      assert(fallbackRow.decision === "normal_path_fallback"
        && ["artifact_hash_mismatch", "view_md_mismatch"].includes(fallbackRow.reason), "fallback audit decision/reason differs");
      assert(lastFooter().includes("rules: compiled 1 always, 0 listed")
        && lastFooter().endsWith(`policy fallback: ${fallbackRow.reason}`), `invalid selected footer does not reflect actual compiled fallback: ${lastFooter()}`);
      assert(fallbackRow.session_id === sessionId && fallbackRow.latest_user_text_sha256 === hash(fallbackUserText)
        && fallbackRow.latest_user_text_bytes === Buffer.byteLength(fallbackUserText), "fallback audit request correlation differs");
      assert(fallbackRow.bundle_hash === null && fallbackRow.manifest_hash === null
        && fallbackRow.view_md_hash === null && fallbackRow.view_bytes === null && fallbackRow.item_count === null, "fallback audit claimed stable-view metadata");
      assert(fallbackRow.rendered_prompt_sha256 === hash(expectedCompiled)
        && fallbackRow.rendered_prompt_bytes === Buffer.byteLength(expectedCompiled), "fallback audit normal-path prompt hash/bytes differ");
      assert(fallbackRow.begin_fence_count === 1 && fallbackRow.end_fence_count === 1
        && fallbackRow.contains_policy_stable_marker === false
        && fallbackRow.contains_compiled_marker === true
        && fallbackRow.contains_legacy_catalog_marker === false, "fallback audit normal-path fence/markers differ");
      const fallbackRaw = fs.readFileSync(auditFile, "utf8").split("\n")[1];
      assert(!fallbackRaw.includes(fallbackUserText)
        && !fallbackRaw.includes("ADR0039 Compiled Fixture")
        && !fallbackRaw.includes("Legacy body."), "fallback audit leaked user/compiled/legacy body");

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      const expired = await beforeAgent({ systemPrompt: "BASE", prompt: "expired correlation" }, ctx);
      assert(expired?.systemPrompt === expectedCompiled, "expired selected result bypassed the existing compiled decision");
      assert(!expired.systemPrompt.includes("Legacy Fallback"), "expired selected result composed raw legacy");
      assert(readJsonLines(auditFile).at(-1)?.reason === "selection_expired", "expired selected fallback was not audited");
      assert(lastFooter().includes("rules: compiled 1 always, 0 listed")
        && lastFooter().endsWith("policy fallback: selection_expired"), `expired footer does not show actual compiled fallback: ${lastFooter()}`);

      const legacyFallbackHome = path.join(tmpRoot, "runtime-home-legacy-fallback");
      writeFile(path.join(legacyFallbackHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
        ruleInjector: {
          compiledViewInjection: {
            enabled: false,
            fallbackToLegacyOnError: true,
            requireFresh: false,
            staleAfterMs: 86400000,
            maxReadBytes: 1000000,
            minCoverageRatio: 1,
          },
          propositionPolicyStableViewInjection: {
            enabled: true,
            selector: { session_ids: [sessionId] },
            expectedBundleHash: bundle.bundle_hash,
            maxSelectionAgeMs: 1000,
            maxReadBytes: 262144,
          },
        },
      }, null, 2));
      const legacyFallbackOut = path.join(tmpRoot, "compiled-runtime-legacy-fallback");
      stageRuleInjector(legacyFallbackOut);
      try {
        process.env.HOME = legacyFallbackHome;
        process.env.USERPROFILE = legacyFallbackHome;
        const legacyRequire = createRequire(path.join(legacyFallbackOut, "runner.cjs"));
        const legacyInjector = legacyRequire("./abrain/rule-injector/index.js");
        const legacyEvents = new Map();
        const legacyStatuses = [];
        legacyInjector.default({
          on(name, handler) { legacyEvents.set(name, handler); },
          registerCommand() {},
        });
        const legacyCtx = {
          cwd: tmpRoot,
          sessionManager: sessionManager(),
          ui: {
            setStatus(_key, value) { legacyStatuses.push(String(value)); },
            notify() {},
          },
        };
        await legacyEvents.get("session_start")({ reason: "startup" }, legacyCtx);
        const legacyFallback = await legacyEvents.get("before_agent_start")({ systemPrompt: "BASE", prompt: "legacy fallback correlation" }, legacyCtx);
        assert(legacyFallback?.systemPrompt?.includes("## Rules Catalog (curated by sediment)"), "expired selected legacy fixture did not inject the legacy catalog");
        assert(legacyStatuses.at(-1) === "🧠 rules: legacy 1 always, 0 listed; policy fallback: selection_expired",
          `expired selected legacy footer differs: ${legacyStatuses.at(-1)}`);
      } finally {
        process.env.HOME = runtimeHome;
        process.env.USERPROFILE = runtimeHome;
      }

      const beforeSubagentRows = readJsonLines(auditFile).length;
      const subagent = await beforeAgent({ systemPrompt: "BASE", prompt: "subagent noise" }, { ...ctx, __subagent: true });
      assert(subagent === undefined, "subagent received stable, compiled, or legacy injection");
      assert(readJsonLines(auditFile).length === beforeSubagentRows, "subagent wrote a runtime audit row");

      fs.rmSync(auditFile);
      const externalAuditTarget = path.join(tmpRoot, "external-audit-target.jsonl");
      fs.writeFileSync(externalAuditTarget, "external-keep\n", { mode: 0o644 });
      fs.symlinkSync(externalAuditTarget, auditFile);
      refreshLatestPublication(publishedAbrain);
      const originalConsoleError = console.error;
      const auditErrors = [];
      console.error = (...args) => { auditErrors.push(args.join(" ")); };
      let symlinkAuditResult;
      try {
        symlinkAuditResult = await beforeAgent({ systemPrompt: "BASE", prompt: "symlink audit rejection" }, ctx);
      } finally {
        console.error = originalConsoleError;
      }
      assert(symlinkAuditResult?.systemPrompt?.includes("source=proposition-policy-stable-view"), "symlink audit rejection changed prompt selection");
      assert(fs.readFileSync(externalAuditTarget, "utf8") === "external-keep\n", "symlink audit rejection touched external target");
      assert(fs.lstatSync(auditFile).isSymbolicLink(), "symlink audit path was replaced");
      assert(auditErrors.some((line) => line.includes("not a regular non-symlink file"))
        && notifications.some(([message]) => message.includes("runtime audit write failed")), "symlink audit failure was not surfaced");

      fs.rmSync(auditFile);
      fs.writeFileSync(auditFile, Buffer.alloc(audit.PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_MAX_BYTES, 0x20), { mode: 0o600 });
      refreshLatestPublication(publishedAbrain);
      const sizeErrors = [];
      console.error = (...args) => { sizeErrors.push(args.join(" ")); };
      let sizeCapResult;
      try {
        sizeCapResult = await beforeAgent({ systemPrompt: "BASE", prompt: "size cap audit rejection" }, ctx);
      } finally {
        console.error = originalConsoleError;
      }
      assert(sizeCapResult?.systemPrompt?.includes("source=proposition-policy-stable-view"), "size-cap audit rejection changed prompt selection");
      assert(fs.statSync(auditFile).size === audit.PROPOSITION_POLICY_STABLE_VIEW_RUNTIME_AUDIT_MAX_BYTES, "size-cap audit rejection changed the capped file");
      assert(sizeErrors.some((line) => line.includes("8 MiB hard cap")), "size-cap audit failure was not surfaced");

      const disabledHome = path.join(tmpRoot, "runtime-home-disabled");
      writeFile(path.join(disabledHome, ".pi", "agent", "pi-astack-settings.json"), JSON.stringify({
        ruleInjector: {
          compiledViewInjection: {
            enabled: true,
            fallbackToLegacyOnError: false,
            requireFresh: false,
            staleAfterMs: 86400000,
            maxReadBytes: 1000000,
            minCoverageRatio: 1,
          },
          propositionPolicyStableViewInjection: {
            enabled: false,
            selector: { session_ids: [sessionId] },
            expectedBundleHash: bundle.bundle_hash,
            maxSelectionAgeMs: 1000,
            maxReadBytes: 262144,
          },
        },
      }, null, 2));
      const disabledOutRoot = path.join(tmpRoot, "compiled-runtime-disabled");
      stageRuleInjector(disabledOutRoot);
      process.env.HOME = disabledHome;
      process.env.USERPROFILE = disabledHome;
      const disabledRequire = createRequire(path.join(disabledOutRoot, "runner.cjs"));
      const disabledInjector = disabledRequire("./abrain/rule-injector/index.js");
      const disabledEvents = new Map();
      disabledInjector.default({ on(name, handler) { disabledEvents.set(name, handler); }, registerCommand() {} });
      const disabledCtx = { cwd: tmpRoot, sessionManager: sessionManager(), ui: { setStatus() {}, notify() {} } };
      await disabledEvents.get("session_start")({ reason: "startup" }, disabledCtx);
      const disabledResult = await disabledEvents.get("before_agent_start")({ systemPrompt: "BASE", prompt: "disabled audit noise" }, disabledCtx);
      assert(disabledResult?.systemPrompt === expectedCompiled, "disabled stable-view reader changed normal compiled path");
      const disabledAuditFile = path.join(disabledHome, ".pi", ".pi-astack", "adr0040-policy-stable-view-runtime-audit.jsonl");
      assert(!fs.existsSync(disabledAuditFile), "disabled stable-view reader wrote a runtime audit row");
    } finally {
      crypto.randomBytes = originalRandomBytes;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
      if (previousAbrain === undefined) delete process.env.ABRAIN_ROOT; else process.env.ABRAIN_ROOT = previousAbrain;
    }
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; hash/age-bound reader, exact single-fence success, unchanged compiled decision on not-ok, scope, session, and subagent boundaries verified`);
