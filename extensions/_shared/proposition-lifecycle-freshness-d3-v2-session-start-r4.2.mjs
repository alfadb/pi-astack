#!/usr/bin/env node
/**
 * ADR0040 D3-v2 session_start R4.2 static-contract/dynamic-capsule operator.
 * Production mutation is default-deny and derives text only from the bound
 * trusted transcript. Disposable fixtures use explicit test-only capabilities.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DYNAMIC_SENTINEL,
  GIT_COMMIT,
  HASH64,
  MAX_OBJECT_BYTES,
  MAX_SESSION_BYTES,
  MAX_STATIC_BYTES,
  NONCE32,
  REVISION,
  R42Error,
  SCHEMAS,
  SETTINGS_KEY,
  SOURCE_COMMIT_BINDING,
  STAGE_STATE,
  STATIC_SENTINEL,
  activationNonce,
  addSelfHash,
  adoptionPhrase,
  asObject,
  assertAbsolutePath,
  assertGitCommit,
  assertHash,
  assertRelativePath,
  assertSafeInteger,
  assertSafeSessionId,
  buildActivation,
  buildActivationHashInputs,
  buildAdoptionAuthorizationFields,
  buildIntent,
  buildOperationTuple,
  buildReceipt,
  buildRuntimeAuditObject,
  canonicalObjectBytes,
  canonicalizeJcs,
  captureSettingsA,
  classifySettingsAgainstTuple,
  cloneJson,
  compareUtf8,
  computeCommitToken,
  continuePhrase,
  decodeCanonicalBase64,
  deepFreeze,
  exactKeys,
  fail,
  fullIdentityFromBigintStat,
  initialPhrase,
  jcsSha256,
  noConcreteSourceOid,
  nonV2Projection,
  openRetainedTranscript,
  operationId,
  parseStrictJson,
  recoveryPhrase,
  renderDesiredSubtree,
  renderSettingsB,
  runtimeAuditIdempotencyKey,
  runtimeAuditTempDispositionPhrase,
  runtimeEnablePhrase,
  sha256,
  stagedTempDispositionPhrase,
  validateActivation,
  validateActivationAgainstIntent,
  validateDesiredTemplate,
  validateFullIdentity,
  validateIntent,
  validateIntentAgainstStatic,
  validateOperationTuple,
  validateOperationTupleAgainstStatic,
  validatePersistedDesiredSubtree,
  validateReceipt,
  validateReceiptAgainstClosure,
  validateRuntimeAuditObject,
  validateSelfHash,
  validateSessionBinding,
  validateSettingsMetadataPolicy,
  verifySessionPrefix,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs";
import {
  PUBLICATION_SCHEMAS,
  assertR42Platform,
  bootstrapControl,
  convergePendingToFinal,
  linkFinalIdempotent,
  openAnchoredDirectory,
  pendingBasename,
  readAnchoredFile,
  stagedPublish,
  stagedTempBasename,
  unlinkPendingIdempotent,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-r4.2-staged-publication.mjs";

export const MODULE_PATH = "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs";
export const CORE_PATH = "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs";
export const STAGED_PATH = "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-staged-publication.mjs";
export const CLI_PATH = "scripts/operate-proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs";
export const GENERATOR_PATH = "scripts/generate-proposition-lifecycle-freshness-d3-v2-session-start-r4.2-artifacts.mjs";
export const SMOKE_PATH = "scripts/smoke-proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs";
export const RUNTIME_CONTROL_PATH = "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-r42-runtime-control.ts";
export const RUNTIME_RESOLVER_PATH = "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.ts";
export const RUNTIME_SETTINGS_RESOLVER_PATH = "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts";
export const RULE_INJECTOR_PATH = "extensions/abrain/rule-injector/index.ts";

export const ARTIFACT_PATHS = Object.freeze({
  source_manifest: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-source-manifest.json",
  adapter_manifest: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-adapter-manifest.json",
  operator_manifest: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-operator-manifest.json",
  static_contract: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-static-contract.json",
  static_dossier: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-static-dossier.json",
  static_preview_template: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-static-preview-template.json",
  post_dossier: "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4.2-post-dossier.json",
});

export const PRODUCTION = Object.freeze({
  target_session_id: "019f6f1d-cc5c-7fcf-bcee-18dd618656ff",
  target_sessions_root: "/home/worker/.pi/agent/sessions",
  target_session_path: "/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-17T08-07-31-677Z_019f6f1d-cc5c-7fcf-bcee-18dd618656ff.jsonl",
  authorization_session_id: "019f77f6-899b-7fa0-ad5f-e1d8bb1ceadc",
  authorization_sessions_root: "/home/worker/.pi/agent/sessions",
  authorization_session_path: "/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-19T01-21-13-627Z_019f77f6-899b-7fa0-ad5f-e1d8bb1ceadc.jsonl",
  settings_path: "/home/worker/.pi/agent/pi-astack-settings.json",
  control_root: "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4.2",
  rollback_root: "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4.2-rollback",
  runtime_audit_base: "/home/worker/.pi/.pi-astack",
  runtime_audit_root: "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start-runtime-audit/r4.2",
  legacy_r4_1_audit_history: "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start-runtime-audit.jsonl",
  old_activation_root: "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/activations",
  quarantine_target: "/home/worker/.pi/agent/sessions/--home-worker-.pi--/.adr0040-r4.2-quarantine-019f6f1d-cc5c-7fcf-bcee-18dd618656ff.jsonl",
  rollback_authorization_path: "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4.2-rollback-authorization.json",
  production_target_authorization_path: "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4.2-production-target-authorization.json",
});

const MANIFEST_ARTIFACT_SET = new Set(Object.values(ARTIFACT_PATHS));
const MANIFEST_COMMON = ["relative_path", "schema_version", "revision", "kind", "closure_rows", "graph_hash", "source_closure_hash", "file_count", "self_hash"];
const SOURCE_MANIFEST_KEYS = [...MANIFEST_COMMON, "critical_required_paths", "clean_closure_policy"];
const ADAPTER_MANIFEST_KEYS = [...MANIFEST_COMMON, "staged_publication_schema", "link_final_schema", "unlink_pending_schema", "staged_temp_path_schema", "dependency_pins"];
const OPERATOR_MANIFEST_KEYS = [...MANIFEST_COMMON, "operator_entry", "cli_entry", "generator_entry", "schema_entries"];
const STATIC_CONTRACT_KEYS = ["schema_version", "revision", "canonicalization", "source_manifest", "adapter_manifest", "operator_manifest", "artifact_paths", "target_session_binding", "authorization_transcript_binding", "d3_identities", "settings_contract", "control_paths", "rollback_paths", "runtime_audit_paths", "residuals", "static_contract_hash"];
const STATIC_DOSSIER_KEYS = ["schema_version", "revision", "static_contract", "static_contract_hash", "assertions", "source_closure_result", "preview_template_identity", "stage_state", "dossier_hash"];
const STATIC_PREVIEW_KEYS = ["schema_version", "revision", "static_contract_hash", "source_commit_binding", "artifact_paths", "allowed_v2_prestate", "desired_v2_template", "mutation_read_set", "mutation_write_set", "conflict_rules", "dynamic_field_names", "zero_write_assertions", "stage_state", "preview_hash"];

function gitEnv() { return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }; }
function gitBuffer(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "buffer", env: gitEnv(), maxBuffer: 128 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}
function gitText(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", env: gitEnv(), maxBuffer: 128 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function lstatMaybe(file, bigint = false) {
  try { return fs.lstatSync(file, bigint ? { bigint: true } : undefined); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function readStaticArtifact(repoRoot, relative, label) {
  assertRelativePath(relative, `${label}.relative_path`);
  const file = path.join(repoRoot, ...relative.split("/"));
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATIC_BYTES) fail("R42_ARTIFACT_FILE", `${label} is not a bounded regular file`);
  const raw = fs.readFileSync(file);
  const value = asObject(parseStrictJson(raw, { maxBytes: MAX_STATIC_BYTES }), label);
  if (`${canonicalizeJcs(value)}\n` !== raw.toString("utf8")) fail("R42_ARTIFACT_CANONICAL", `${label} is not exact JCS+LF`);
  return deepFreeze({ relative_path: relative, file, raw, raw_sha256: sha256(raw), value });
}

export function parseDirectDependencies(repoRoot, relativePath, rawInput = undefined, options = {}) {
  assertRelativePath(relativePath);
  const raw = rawInput ?? fs.readFileSync(path.join(repoRoot, ...relativePath.split("/")));
  const pathExists = options.pathExists ?? ((candidate) => fs.existsSync(path.join(repoRoot, ...candidate.split("/"))));
  if (typeof pathExists !== "function") fail("R42_DEPENDENCY_RESOLVER", "dependency pathExists must be a function");
  const ext = path.posix.extname(relativePath);
  if (![".mjs", ".js", ".ts", ".mts", ".cts"].includes(ext)) return [];
  const text = raw.toString("utf8");
  const imports = new Set();
  const patterns = [/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
      if (!pathExists(resolved)) {
        const candidates = [".mjs", ".js", ".ts", ".mts", ".cts"].map((suffix) => `${resolved}${suffix}`);
        resolved = candidates.find((candidate) => pathExists(candidate)) ?? resolved;
      }
      assertRelativePath(resolved, `dependency of ${relativePath}`);
      imports.add(resolved);
    }
  }
  return [...imports].sort(compareUtf8);
}

function closureFormula(kind, rows) {
  const graphHash = jcsSha256(rows);
  const sourceClosureHash = sha256(Buffer.concat([
    Buffer.from(`adr0040-d3-v2-session-start-r4.2-${kind}-source-closure/v1\0`, "utf8"),
    Buffer.from(graphHash, "ascii"),
  ]));
  return { graphHash, sourceClosureHash };
}

function validateClosureRows(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) fail("R42_MANIFEST_ROWS", `${label} closure rows must be non-empty`);
  const paths = [];
  for (const [index, rowInput] of rows.entries()) {
    const row = exactKeys(rowInput, ["relative_path", "raw_sha256", "dependencies"], `${label}.closure_rows[${index}]`);
    assertRelativePath(row.relative_path);
    assertHash(row.raw_sha256, `${label}.closure_rows[${index}].raw_sha256`);
    if (!Array.isArray(row.dependencies)) fail("R42_MANIFEST_DEPENDENCIES", `${label} dependencies must be an array`);
    const dependencies = row.dependencies.map((item) => assertRelativePath(item)).sort(compareUtf8);
    if (canonicalizeJcs(dependencies) !== canonicalizeJcs(row.dependencies) || new Set(dependencies).size !== dependencies.length) fail("R42_MANIFEST_DEPENDENCIES", `${label} dependencies are not sorted unique`);
    if (MANIFEST_ARTIFACT_SET.has(row.relative_path) || row.dependencies.some((item) => MANIFEST_ARTIFACT_SET.has(item))) fail("R42_MANIFEST_FIXED_POINT", `${label} includes a committed input artifact in closure`);
    paths.push(row.relative_path);
  }
  const sorted = [...paths].sort(compareUtf8);
  if (canonicalizeJcs(sorted) !== canonicalizeJcs(paths) || new Set(paths).size !== paths.length) fail("R42_MANIFEST_SORT", `${label} closure paths are not bytewise sorted unique`);
  return rows;
}

export function validateStandaloneManifest(value, expectedKind, repoRoot = undefined) {
  const expectedKeys = expectedKind === "source" ? SOURCE_MANIFEST_KEYS : expectedKind === "adapter" ? ADAPTER_MANIFEST_KEYS : OPERATOR_MANIFEST_KEYS;
  const manifest = exactKeys(value, expectedKeys, `${expectedKind}_manifest`);
  const expectedSchema = SCHEMAS[`${expectedKind}_manifest`];
  if (manifest.schema_version !== expectedSchema || manifest.revision !== REVISION || manifest.kind !== expectedKind || manifest.relative_path !== ARTIFACT_PATHS[`${expectedKind}_manifest`]) fail("R42_MANIFEST_SCHEMA", `${expectedKind} manifest identity differs`);
  validateClosureRows(manifest.closure_rows, `${expectedKind}_manifest`);
  assertSafeInteger(manifest.file_count, `${expectedKind}.file_count`, { min: 1 });
  if (manifest.file_count !== manifest.closure_rows.length) fail("R42_MANIFEST_COUNT", `${expectedKind} file_count differs`);
  const formula = closureFormula(expectedKind, manifest.closure_rows);
  if (manifest.graph_hash !== formula.graphHash || manifest.source_closure_hash !== formula.sourceClosureHash) fail("R42_MANIFEST_GRAPH_HASH", `${expectedKind} graph/source closure hash differs`);
  validateSelfHash(manifest, "self_hash", `${expectedKind}_manifest`);
  noConcreteSourceOid(manifest, `${expectedKind}_manifest`);
  if (Object.keys(manifest).some((key) => key === "raw_sha256" || key.includes("self_raw") || key === "source_commit" || key === "head_commit")) fail("R42_MANIFEST_FIXED_POINT", `${expectedKind} manifest contains a forbidden self-raw/source field`);
  if (expectedKind === "source") {
    if (!Array.isArray(manifest.critical_required_paths) || manifest.critical_required_paths.length === 0 || manifest.clean_closure_policy !== "tracked_nonignored_live_equals_head_no_shadow") fail("R42_SOURCE_MANIFEST_POLICY", "source manifest policy differs");
    const critical = manifest.critical_required_paths.map((item) => assertRelativePath(item)).sort(compareUtf8);
    if (canonicalizeJcs(critical) !== canonicalizeJcs(manifest.critical_required_paths) || critical.some((item) => MANIFEST_ARTIFACT_SET.has(item))) fail("R42_SOURCE_MANIFEST_POLICY", "critical paths differ or include committed inputs");
  } else if (expectedKind === "adapter") {
    if (manifest.staged_publication_schema !== SCHEMAS.staged_publish || manifest.link_final_schema !== SCHEMAS.link_final || manifest.unlink_pending_schema !== SCHEMAS.unlink_pending || manifest.staged_temp_path_schema !== SCHEMAS.staged_temp_path) fail("R42_ADAPTER_SCHEMA_PIN", "adapter primitive schema pins differ");
    if (!Array.isArray(manifest.dependency_pins) || manifest.dependency_pins.length === 0) fail("R42_ADAPTER_DEPENDENCY_PIN", "adapter dependency pins are empty");
    const pinKeys = [];
    for (const pin of manifest.dependency_pins) {
      exactKeys(pin, ["relative_path", "raw_sha256", "role"], "adapter dependency pin");
      assertRelativePath(pin.relative_path); assertHash(pin.raw_sha256);
      if (!["staged_publication", "idempotent_link_unlink", "anchored_io", "strict_json", "retained_auth_reverify"].includes(pin.role) || pin.relative_path.includes("r4.ts") || pin.relative_path.includes("retained-fd-create-only")) fail("R42_ADAPTER_R41_REUSE", "adapter dependency pin is invalid or names R4.1 publication");
      pinKeys.push(`${pin.relative_path}\0${pin.role}`);
    }
    if (new Set(pinKeys).size !== pinKeys.length || canonicalizeJcs([...pinKeys].sort(compareUtf8)) !== canonicalizeJcs(pinKeys)) fail("R42_ADAPTER_DEPENDENCY_PIN", "adapter dependency pins are not bytewise sorted unique");
  } else {
    for (const field of ["operator_entry", "cli_entry", "generator_entry"]) validateClosureProjection(manifest[field], manifest, `operator.${field}`);
    if (!Array.isArray(manifest.schema_entries) || manifest.schema_entries.length === 0) fail("R42_OPERATOR_SCHEMA_ENTRY", "operator schema_entries are empty");
    const schemaPaths = [];
    for (const item of manifest.schema_entries) { validateClosureProjection(item, manifest, "operator.schema_entry"); schemaPaths.push(item.relative_path); }
    if (new Set(schemaPaths).size !== schemaPaths.length || canonicalizeJcs([...schemaPaths].sort(compareUtf8)) !== canonicalizeJcs(schemaPaths)) fail("R42_OPERATOR_SCHEMA_ENTRY", "operator schema entries are not bytewise sorted unique");
  }
  if (repoRoot) {
    for (const row of manifest.closure_rows) {
      const file = path.join(repoRoot, ...row.relative_path.split("/"));
      const stat = lstatMaybe(file);
      if (!stat?.isFile() || stat.isSymbolicLink()) fail("R42_MANIFEST_LIVE", `${row.relative_path} is not a safe live source file`);
      const raw = fs.readFileSync(file);
      if (sha256(raw) !== row.raw_sha256 || canonicalizeJcs(parseDirectDependencies(repoRoot, row.relative_path, raw)) !== canonicalizeJcs(row.dependencies)) fail("R42_MANIFEST_LIVE", `${row.relative_path} live hash/dependencies differ`);
    }
  }
  return manifest;
}

function validateClosureProjection(value, manifest, label) {
  const projection = exactKeys(value, ["relative_path", "raw_sha256"], label);
  const row = manifest.closure_rows.find((item) => item.relative_path === projection.relative_path);
  if (!row || row.raw_sha256 !== projection.raw_sha256) fail("R42_CLOSURE_PROJECTION", `${label} does not match a unique closure row`);
  return projection;
}

function manifestProjection(manifest) {
  return {
    relative_path: manifest.relative_path,
    kind: manifest.kind,
    self_hash: manifest.self_hash,
    graph_hash: manifest.graph_hash,
    source_closure_hash: manifest.source_closure_hash,
    file_count: manifest.file_count,
  };
}

function validateManifestProjection(value, manifest, label) {
  const projection = exactKeys(value, ["relative_path", "kind", "self_hash", "graph_hash", "source_closure_hash", "file_count"], label);
  if (canonicalizeJcs(projection) !== canonicalizeJcs(manifestProjection(manifest))) fail("R42_STATIC_MANIFEST_PROJECTION", `${label} differs from standalone manifest`);
  return projection;
}

export function validateStaticContract(value, manifests = undefined) {
  const contract = exactKeys(value, STATIC_CONTRACT_KEYS, "static_contract");
  if (contract.schema_version !== SCHEMAS.static_contract || contract.revision !== REVISION || contract.canonicalization !== "RFC8785-JCS") fail("R42_STATIC_CONTRACT_SCHEMA", "static contract identity differs");
  if (manifests) {
    validateManifestProjection(contract.source_manifest, manifests.source, "static_contract.source_manifest");
    validateManifestProjection(contract.adapter_manifest, manifests.adapter, "static_contract.adapter_manifest");
    validateManifestProjection(contract.operator_manifest, manifests.operator, "static_contract.operator_manifest");
  } else {
    for (const kind of ["source", "adapter", "operator"]) exactKeys(contract[`${kind}_manifest`], ["relative_path", "kind", "self_hash", "graph_hash", "source_closure_hash", "file_count"], `static_contract.${kind}_manifest`);
  }
  if (canonicalizeJcs(contract.artifact_paths) !== canonicalizeJcs(ARTIFACT_PATHS)) fail("R42_ARTIFACT_PATHS", "static contract artifact paths differ");
  validateSessionBinding(contract.target_session_binding, "target_session_binding");
  validateSessionBinding(contract.authorization_transcript_binding, "authorization_transcript_binding");
  if (contract.target_session_binding.session_id === contract.authorization_transcript_binding.session_id || contract.target_session_binding.session_file.path === contract.authorization_transcript_binding.session_file.path || (contract.target_session_binding.session_file.dev === contract.authorization_transcript_binding.session_file.dev && contract.target_session_binding.session_file.ino === contract.authorization_transcript_binding.session_file.ino)) fail("R42_SESSION_ALIAS", "target/auth bindings alias");
  validateD3(contract.d3_identities);
  validateSettingsContract(contract.settings_contract);
  validateStaticControlPaths(contract.control_paths);
  validateRollbackPaths(contract.rollback_paths, contract.control_paths.control_root);
  validateRuntimeAuditPaths(contract.runtime_audit_paths);
  validateResiduals(contract.residuals);
  assertHash(contract.static_contract_hash, "static_contract_hash");
  const preimage = { ...contract }; delete preimage.static_contract_hash;
  if (contract.static_contract_hash !== jcsSha256(preimage)) fail("R42_STATIC_CONTRACT_HASH", "static contract top-level hash differs");
  validateDesiredTemplate(contract.settings_contract.desired_v2_template);
  noConcreteSourceOid(contract, "static_contract");
  return contract;
}

function validateD3(value) {
  const d3 = exactKeys(value, ["selection_hash", "head_hash", "proof_hash", "intent_hash", "stable_bundle_hash", "p2a_bundle_hash", "generation", "selection_seq"], "d3_identities");
  for (const field of ["selection_hash", "head_hash", "proof_hash", "intent_hash", "stable_bundle_hash", "p2a_bundle_hash"]) assertHash(d3[field], `d3.${field}`);
  assertSafeInteger(d3.generation, "d3.generation"); assertSafeInteger(d3.selection_seq, "d3.selection_seq");
}

function validateSettingsContract(value) {
  const settings = exactKeys(value, ["settings_path", "allowed_v2_prestate", "allowed_metadata_policy", "transformer_version", "desired_v2_template", "settings_temp_relative_template", "mutation_read_set", "mutation_write_set", "conflict_rules"], "settings_contract");
  assertAbsolutePath(settings.settings_path);
  if (canonicalizeJcs(settings.allowed_v2_prestate) !== '["absent","disabled_empty"]' || settings.transformer_version !== SCHEMAS.transformer || settings.settings_temp_relative_template !== ".pi-astack-settings.json.adr0040-r4.2.{operation_id}.settings.stage.{invocation_nonce}.tmp") fail("R42_SETTINGS_CONTRACT", "settings contract fixed values differ");
  validateSettingsMetadataPolicy(settings.allowed_metadata_policy);
  validateDesiredTemplate(settings.desired_v2_template);
  for (const field of ["mutation_read_set", "mutation_write_set", "conflict_rules"]) assertSortedUniqueStrings(settings[field], `settings_contract.${field}`);
}

function validateStaticControlPaths(value) {
  const control = exactKeys(value, ["control_root", "intent_relative_template", "activation_relative_template", "receipt_relative_template", "intent_pending_relative_template", "activation_pending_relative_template", "receipt_pending_relative_template", "intent_temp_relative_template", "activation_temp_relative_template", "receipt_temp_relative_template", "invocation_nonce_pattern", "bootstrap_prefix_states", "directory_mode", "same_device_required", "no_symlink_required", "no_extras_required", "operator_audit_relative"], "control_paths");
  assertAbsolutePath(control.control_root);
  const exact = {
    intent_relative_template: "intents/{operation_id}.json", activation_relative_template: "activations/{operation_id}.json", receipt_relative_template: "receipts/{operation_id}.json",
    intent_pending_relative_template: "intents/.{operation_id}.intent.pending", activation_pending_relative_template: "activations/.{operation_id}.activation.pending", receipt_pending_relative_template: "receipts/.{operation_id}.receipt.pending",
    intent_temp_relative_template: "intents/.{operation_id}.intent.stage.{invocation_nonce}.tmp", activation_temp_relative_template: "activations/.{operation_id}.activation.stage.{invocation_nonce}.tmp", receipt_temp_relative_template: "receipts/.{operation_id}.receipt.stage.{invocation_nonce}.tmp",
    invocation_nonce_pattern: "^[0-9a-f]{32}$", operator_audit_relative: "operator-audit.jsonl",
  };
  for (const [field, expected] of Object.entries(exact)) if (control[field] !== expected) fail("R42_CONTROL_PATHS", `${field} differs`);
  if (canonicalizeJcs(control.bootstrap_prefix_states) !== '["root_absent","root_empty","root_plus_intents","root_plus_intents_activations","root_plus_intents_activations_receipts"]' || control.directory_mode !== 448 || control.same_device_required !== true || control.no_symlink_required !== true || control.no_extras_required !== true) fail("R42_CONTROL_PATHS", "control bootstrap contract differs");
}

function validateRollbackPaths(value, controlRoot) {
  const rollback = exactKeys(value, ["rollback_root", "state_root", "quarantine_target", "old_activation_root", "distinct_non_nested_control_root", "initial_state", "materialization_policy"], "rollback_paths");
  for (const field of ["rollback_root", "state_root", "quarantine_target", "old_activation_root"]) assertAbsolutePath(rollback[field], `rollback.${field}`);
  if (rollback.rollback_root !== rollback.state_root || rollback.distinct_non_nested_control_root !== true || rollback.initial_state !== "absent_pre_s2" || rollback.materialization_policy !== "three_independent_gates_then_create_only" || pathsAlias(controlRoot, rollback.rollback_root)) fail("R42_ROLLBACK_PATHS", "rollback/control contract differs");
}

function validateRuntimeAuditPaths(value) {
  const keys = ["audit_base", "audit_base_dev", "audit_base_uid", "audit_base_gid", "audit_base_mode", "runtime_audit_parent_relative", "runtime_audit_leaf_relative", "runtime_audit_root", "bootstrap_schema_pin", "bootstrap_prefix_states", "directory_mode", "single_user_uid_assumption", "same_device_required", "no_symlink_required", "no_extras_required", "final_relative_template", "temp_relative_template", "r4_2_audit_schema_pin", "legacy_r4_1_history_path", "legacy_history_not_terminal_gate", "max_object_bytes", "max_root_entries", "required_before_first_injection", "idempotency_scope"];
  const audit = exactKeys(value, keys, "runtime_audit_paths");
  for (const field of ["audit_base", "runtime_audit_root", "legacy_r4_1_history_path"]) assertAbsolutePath(audit[field], `runtime_audit.${field}`);
  for (const field of ["audit_base_dev", "audit_base_uid", "audit_base_gid", "audit_base_mode", "directory_mode", "max_object_bytes", "max_root_entries"]) assertSafeInteger(audit[field], `runtime_audit.${field}`);
  if (audit.runtime_audit_parent_relative !== "adr0040-d3-v2-session-start-runtime-audit" || audit.runtime_audit_leaf_relative !== "r4.2" || audit.bootstrap_schema_pin !== SCHEMAS.runtime_audit_bootstrap || canonicalizeJcs(audit.bootstrap_prefix_states) !== '["audit_base_only","parent_empty","parent_plus_leaf"]' || audit.directory_mode !== 448 || audit.final_relative_template !== "{idempotency_key}.json" || audit.temp_relative_template !== ".{idempotency_key}.runtime-audit.stage.{invocation_nonce}.tmp" || audit.r4_2_audit_schema_pin !== SCHEMAS.runtime_audit_object || audit.max_object_bytes !== MAX_OBJECT_BYTES || audit.max_root_entries !== 4096 || audit.idempotency_scope !== "per_receipt_immutable_object") fail("R42_RUNTIME_AUDIT_PATHS", "runtime audit fixed contract differs");
  for (const flag of ["single_user_uid_assumption", "same_device_required", "no_symlink_required", "no_extras_required", "legacy_history_not_terminal_gate", "required_before_first_injection"]) if (audit[flag] !== true) fail("R42_RUNTIME_AUDIT_PATHS", `${flag} differs`);
}

function validateResiduals(value) {
  const residuals = exactKeys(value, ["accepted_residual_ids", "non_v2_semantic_not_raw_preservation", "foreign_corrupt_authority_incident_boundary", "compliant_staged_temp_has_fresh_disposition", "persistent_noncooperative_drift_bounded_exit", "corrupt_authority_requires_external_protocol", "direct_receipt_pending_nonexact_B_failclosed", "token_not_secret"], "residuals");
  assertSortedUniqueStrings(residuals.accepted_residual_ids, "accepted_residual_ids");
  if (!residuals.accepted_residual_ids.includes("direct_receipt_pending_nonexact_B_requires_restore_exact_B_or_separate_disposition")) fail("R42_RESIDUAL", "direct pending residual is absent");
  for (const field of Object.keys(residuals).filter((key) => key !== "accepted_residual_ids")) if (residuals[field] !== true) fail("R42_RESIDUAL", `${field} differs`);
}

function assertSortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) fail("R42_SORTED_STRINGS", `${label} must be non-empty strings`);
  const sorted = [...value].sort(compareUtf8);
  if (new Set(sorted).size !== sorted.length || canonicalizeJcs(sorted) !== canonicalizeJcs(value)) fail("R42_SORTED_STRINGS", `${label} is not bytewise sorted unique`);
}

function pathsAlias(leftInput, rightInput) {
  const left = path.resolve(leftInput); const right = path.resolve(rightInput);
  const lr = path.relative(left, right); const rl = path.relative(right, left);
  return left === right || (lr && !lr.startsWith("..") && !path.isAbsolute(lr)) || (rl && !rl.startsWith("..") && !path.isAbsolute(rl));
}

export function validateStaticDossier(value, bundle) {
  const dossier = exactKeys(value, STATIC_DOSSIER_KEYS, "static_dossier");
  if (dossier.schema_version !== SCHEMAS.static_dossier || dossier.revision !== REVISION || dossier.stage_state !== STAGE_STATE) fail("R42_STATIC_DOSSIER_SCHEMA", "static dossier identity differs");
  if (canonicalizeJcs(dossier.static_contract) !== canonicalizeJcs(bundle.contract.value) || dossier.static_contract_hash !== bundle.contract.value.static_contract_hash) fail("R42_STATIC_DOSSIER_CONTRACT", "dossier static contract differs");
  if (Object.keys(dossier.assertions).length === 0 || !Object.values(dossier.assertions).every((item) => item === true)) fail("R42_STATIC_DOSSIER_ASSERTION", "dossier assertions are not all true");
  const closure = exactKeys(dossier.source_closure_result, ["source_commit_binding", "source_manifest", "adapter_manifest", "operator_manifest", "closure_validated", "critical_artifact_existence_policy_validated"], "source_closure_result");
  if (closure.source_commit_binding !== SOURCE_COMMIT_BINDING || closure.closure_validated !== true || closure.critical_artifact_existence_policy_validated !== true) fail("R42_DOSSIER_CLOSURE", "dossier source closure policy differs");
  for (const kind of ["source", "adapter", "operator"]) {
    const identity = exactKeys(closure[`${kind}_manifest`], ["relative_path", "kind", "raw_sha256", "self_hash", "graph_hash", "source_closure_hash", "file_count"], `${kind} manifest validation identity`);
    const manifest = bundle[kind].value;
    const expected = { ...manifestProjection(manifest), raw_sha256: bundle[kind].raw_sha256 };
    if (canonicalizeJcs(identity) !== canonicalizeJcs(expected)) fail("R42_DOSSIER_MANIFEST_IDENTITY", `${kind} manifest validation identity differs`);
  }
  const previewIdentity = exactKeys(dossier.preview_template_identity, ["relative_path", "raw_sha256", "self_hash"], "preview_template_identity");
  if (canonicalizeJcs(previewIdentity) !== canonicalizeJcs({ relative_path: ARTIFACT_PATHS.static_preview_template, raw_sha256: bundle.preview.raw_sha256, self_hash: bundle.preview.value.preview_hash })) fail("R42_DOSSIER_PREVIEW_IDENTITY", "preview identity differs");
  validateSelfHash(dossier, "dossier_hash", "static_dossier");
  noConcreteSourceOid(dossier, "static_dossier");
  return dossier;
}

export function validateStaticPreviewTemplate(value, contract) {
  const preview = exactKeys(value, STATIC_PREVIEW_KEYS, "static_preview_template");
  if (preview.schema_version !== SCHEMAS.static_preview_template || preview.revision !== REVISION || preview.static_contract_hash !== contract.static_contract_hash || preview.source_commit_binding !== SOURCE_COMMIT_BINDING || preview.stage_state !== STAGE_STATE) fail("R42_STATIC_PREVIEW_SCHEMA", "static preview template identity differs");
  if (canonicalizeJcs(preview.artifact_paths) !== canonicalizeJcs(ARTIFACT_PATHS) || canonicalizeJcs(preview.allowed_v2_prestate) !== canonicalizeJcs(contract.settings_contract.allowed_v2_prestate) || canonicalizeJcs(preview.desired_v2_template) !== canonicalizeJcs(contract.settings_contract.desired_v2_template) || canonicalizeJcs(preview.mutation_read_set) !== canonicalizeJcs(contract.settings_contract.mutation_read_set) || canonicalizeJcs(preview.mutation_write_set) !== canonicalizeJcs(contract.settings_contract.mutation_write_set) || canonicalizeJcs(preview.conflict_rules) !== canonicalizeJcs(contract.settings_contract.conflict_rules)) fail("R42_STATIC_PREVIEW_CONTRACT", "static preview does not project contract exactly");
  assertSortedUniqueStrings(preview.dynamic_field_names, "dynamic_field_names");
  if (!preview.dynamic_field_names.includes("source_commit") || Object.keys(preview.zero_write_assertions).length === 0 || !Object.values(preview.zero_write_assertions).every((flag) => flag === true)) fail("R42_STATIC_PREVIEW_ZERO_WRITE", "static preview dynamic/zero-write contract differs");
  validateSelfHash(preview, "preview_hash", "static_preview_template");
  noConcreteSourceOid(preview, "static_preview_template");
  return preview;
}

export function loadAndValidateStaticBundle(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput);
  const source = readStaticArtifact(repoRoot, ARTIFACT_PATHS.source_manifest, "source_manifest");
  const adapter = readStaticArtifact(repoRoot, ARTIFACT_PATHS.adapter_manifest, "adapter_manifest");
  const operator = readStaticArtifact(repoRoot, ARTIFACT_PATHS.operator_manifest, "operator_manifest");
  // Static artifact validation is content-only. Live source cleanliness and
  // HEAD:path equality belong exclusively to sourceGuard/readiness.
  validateStandaloneManifest(source.value, "source");
  validateStandaloneManifest(adapter.value, "adapter");
  validateStandaloneManifest(operator.value, "operator");
  const union = new Map();
  for (const manifest of [adapter.value, operator.value]) for (const row of manifest.closure_rows) {
    const existing = union.get(row.relative_path);
    if (existing && canonicalizeJcs(existing) !== canonicalizeJcs(row)) fail("R42_MANIFEST_OVERLAP", `overlap row ${row.relative_path} differs`);
    union.set(row.relative_path, row);
  }
  for (const critical of source.value.critical_required_paths) {
    const row = source.value.closure_rows.find((item) => item.relative_path === critical);
    if (!row) fail("R42_SOURCE_UNION", `critical path ${critical} is absent from source union`);
    union.set(critical, row);
  }
  const expectedSource = [...union.values()].sort((left, right) => compareUtf8(left.relative_path, right.relative_path));
  if (canonicalizeJcs(expectedSource) !== canonicalizeJcs(source.value.closure_rows)) fail("R42_SOURCE_UNION", "source rows are not exact adapter/operator/critical union");
  const contract = readStaticArtifact(repoRoot, ARTIFACT_PATHS.static_contract, "static_contract");
  validateStaticContract(contract.value, { source: source.value, adapter: adapter.value, operator: operator.value });
  const preview = readStaticArtifact(repoRoot, ARTIFACT_PATHS.static_preview_template, "static_preview_template");
  validateStaticPreviewTemplate(preview.value, contract.value);
  const dossier = readStaticArtifact(repoRoot, ARTIFACT_PATHS.static_dossier, "static_dossier");
  const bundle = { repoRoot, source, adapter, operator, contract, preview, dossier };
  validateStaticDossier(dossier.value, bundle);
  return deepFreeze(bundle);
}

function exactGitObjectCommit(repoRoot, commitInput) {
  const result = gitText(repoRoot, ["rev-parse", "--verify", `${commitInput}^{commit}`]);
  const commit = result.stdout.trim();
  if (result.status !== 0 || !GIT_COMMIT.test(commit) || commit !== commitInput) fail("R42_SOURCE_COMMIT_OBJECT", "source_commit is not the exact repository commit object");
  return commit;
}

function gitBlob(repoRoot, commit, relative) {
  const result = gitBuffer(repoRoot, ["cat-file", "blob", `${commit}:${relative}`]);
  if (result.status !== 0) fail("R42_SOURCE_BLOB", `${relative} is absent from ${commit}`);
  return result.stdout;
}

function pathCleanAtWorktree(repoRoot, relative) {
  const status = gitText(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", relative]);
  const ignored = gitText(repoRoot, ["check-ignore", "--no-index", "-q", "--", relative]);
  if (status.status !== 0 || status.stdout !== "" || ignored.status === 0) fail("R42_SOURCE_SHADOW", `${relative} has staged/unstaged/untracked/ignored shadow`, { status: status.stdout });
}

export function sourceGuard(repoRootInput, sourceCommit, bundleInput = undefined) {
  const repoRoot = path.resolve(repoRootInput);
  assertGitCommit(sourceCommit);
  const bundle = bundleInput ?? loadAndValidateStaticBundle(repoRoot);
  exactGitObjectCommit(repoRoot, sourceCommit);
  const headResult = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headResult.status !== 0 || headResult.stdout.trim() !== sourceCommit) fail("R42_SOURCE_HEAD", "live HEAD differs from persisted source_commit");
  const rows = [...bundle.source.value.closure_rows];
  const artifacts = Object.values(ARTIFACT_PATHS).filter((item) => item !== ARTIFACT_PATHS.post_dossier);
  const paths = [...new Set([...artifacts, ...rows.map((row) => row.relative_path)])].sort(compareUtf8);
  const rowByPath = new Map(rows.map((row) => [row.relative_path, row]));
  const validation = [];
  for (const relative of paths) {
    pathCleanAtWorktree(repoRoot, relative);
    const livePath = path.join(repoRoot, ...relative.split("/"));
    const stat = lstatMaybe(livePath);
    if (!stat?.isFile() || stat.isSymbolicLink()) fail("R42_SOURCE_FILE", `${relative} is not a safe live regular file`);
    const live = fs.readFileSync(livePath);
    const expected = gitBlob(repoRoot, sourceCommit, relative);
    if (!live.equals(expected)) fail("R42_SOURCE_LIVE_BLOB", `${relative} live bytes differ from ${sourceCommit}:path`);
    const row = rowByPath.get(relative);
    if (row) {
      if (sha256(live) !== row.raw_sha256 || canonicalizeJcs(parseDirectDependencies(repoRoot, relative, live)) !== canonicalizeJcs(row.dependencies)) fail("R42_SOURCE_MANIFEST_ROW", `${relative} hash/dependencies differ from source manifest`);
    }
    validation.push({ relative_path: relative, raw_sha256: sha256(live), artifact_input: artifacts.includes(relative), closure_row: Boolean(row) });
  }
  const headAfter = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headAfter.status !== 0 || headAfter.stdout.trim() !== sourceCommit) fail("R42_SOURCE_HEAD_DRIFT", "HEAD changed during source guard");
  return deepFreeze({ source_commit: sourceCommit, paths: validation, path_count: validation.length, source_guard_passed: true });
}

export function inspectSourceReadiness(repoRoot, bundle = undefined) {
  const head = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const sourceCommit = head.status === 0 && GIT_COMMIT.test(head.stdout.trim()) ? head.stdout.trim() : null;
  if (!sourceCommit) return deepFreeze({ ready: false, source_commit: null, reason: "HEAD_COMMIT_UNAVAILABLE" });
  try {
    const report = sourceGuard(repoRoot, sourceCommit, bundle);
    return deepFreeze({ ready: true, source_commit: sourceCommit, source_guard: report });
  } catch (error) {
    return deepFreeze({ ready: false, source_commit: sourceCommit, reason: error.code ?? "R42_SOURCE_NOT_READY", error: error.message });
  }
}

function settingsReadiness(contract) {
  try {
    const A = captureSettingsA(contract.settings_contract.settings_path, contract.settings_contract.allowed_metadata_policy);
    return deepFreeze({ ready: true, allowed_v2_prestate: A.allowed_v2_prestate, raw_sha256: A.raw_sha256, non_v2_jcs_hash: A.non_v2_jcs_hash, metadata: A.full_identity });
  } catch (error) { return deepFreeze({ ready: false, reason: error.code ?? "R42_SETTINGS_NOT_READY", error: error.message }); }
}

function sessionReadiness(contract) {
  const result = {};
  for (const [field, binding] of [["target", contract.target_session_binding], ["authorization", contract.authorization_transcript_binding]]) {
    let retained;
    try {
      const attestation = verifySessionPrefix(binding);
      retained = openRetainedTranscript(binding);
      const boundary = retained.boundary();
      result[field] = { ready: true, attestation, trusted_v3_full_transcript_boundary: boundary };
    } catch (error) { result[field] = { ready: false, reason: error.code ?? "R42_SESSION_NOT_READY", error: error.message }; }
    finally { retained?.close(); }
  }
  result.distinct = contract.target_session_binding.session_id !== contract.authorization_transcript_binding.session_id;
  return deepFreeze(result);
}

function controlReadiness(contract) {
  const control = lstatMaybe(contract.control_paths.control_root);
  const rollback = lstatMaybe(contract.rollback_paths.rollback_root);
  return deepFreeze({
    control_root_absent: control === null,
    control_root_state: control === null ? "root_absent" : "existing_requires_bounded_classification",
    rollback_root_absent: rollback === null,
    runtime_audit_root_absent: lstatMaybe(contract.runtime_audit_paths.runtime_audit_root) === null,
  });
}

export function buildDynamicReadOnlyReport(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput);
  const bundle = loadAndValidateStaticBundle(repoRoot);
  const contract = bundle.contract.value;
  const base = {
    schema_version: SCHEMAS.dynamic_report,
    revision: REVISION,
    static_contract_hash: contract.static_contract_hash,
    settings_readiness: settingsReadiness(contract),
    source_readiness: inspectSourceReadiness(repoRoot, bundle),
    session_readiness: sessionReadiness(contract),
    control_readiness: controlReadiness(contract),
    unbound_simulation: { performed: false, token_derived: false, operation_id_derived: false },
    authoritative: false,
  };
  return addSelfHash(base, "report_hash");
}

export function buildInitialDynamicPreview(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput);
  const bundle = loadAndValidateStaticBundle(repoRoot);
  const firstHead = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const sourceCommit = firstHead.stdout.trim();
  if (firstHead.status !== 0 || !GIT_COMMIT.test(sourceCommit)) fail("R42_INITIAL_PREVIEW_SOURCE", "current HEAD commit unavailable");
  const source = sourceGuard(repoRoot, sourceCommit, bundle);
  const retained = openRetainedTranscript(bundle.contract.value.authorization_transcript_binding);
  try {
    const boundary = retained.boundary();
    sourceGuard(repoRoot, sourceCommit, bundle);
    const contract = bundle.contract.value;
    const phrase = initialPhrase({ static_contract_hash: contract.static_contract_hash, source_commit: sourceCommit, target_session_id: contract.target_session_binding.session_id, preview_transcript_prefix_sha256: boundary.prefix_sha256 });
    const artifactIdentities = [bundle.source, bundle.adapter, bundle.operator, bundle.contract, bundle.dossier, bundle.preview].map((artifact) => ({ relative_path: artifact.relative_path, raw_sha256: artifact.raw_sha256, tracked: true, nonignored: true, live_equals_source_commit: true, clean: true })).sort((left, right) => compareUtf8(left.relative_path, right.relative_path));
    const base = {
      schema_version: SCHEMAS.initial_dynamic_preview,
      revision: REVISION,
      static_contract_hash: contract.static_contract_hash,
      source_commit: sourceCommit,
      target_session_id: contract.target_session_binding.session_id,
      target_session_binding_hash: jcsSha256(contract.target_session_binding),
      authorization_transcript_binding_hash: jcsSha256(contract.authorization_transcript_binding),
      source_manifest_identity: manifestProjection(bundle.source.value),
      adapter_manifest_identity: manifestProjection(bundle.adapter.value),
      operator_manifest_identity: manifestProjection(bundle.operator.value),
      critical_artifact_validation_identities: artifactIdentities,
      closure_readiness: { ready: true, source_guard_path_count: source.path_count, source_closure_hash: bundle.source.value.source_closure_hash },
      control_readiness: controlReadiness(contract),
      rollback_root_absent: lstatMaybe(contract.rollback_paths.rollback_root) === null,
      preview_transcript_prefix_bytes: boundary.prefix_bytes,
      preview_transcript_prefix_sha256: boundary.prefix_sha256,
      exact_authorization_phrase: phrase,
      authoritative: false,
    };
    return addSelfHash(base, "preview_hash");
  } finally { retained.close(); }
}

const PRODUCTION_AUTHORITY = Symbol("r4.2-production-authority");

function assertProductionContract(contract) {
  const exactPaths = {
    settings_path: PRODUCTION.settings_path,
    control_root: PRODUCTION.control_root,
    rollback_root: PRODUCTION.rollback_root,
    old_activation_root: PRODUCTION.old_activation_root,
    quarantine_target: PRODUCTION.quarantine_target,
    runtime_audit_root: PRODUCTION.runtime_audit_root,
    legacy_r4_1_history_path: PRODUCTION.legacy_r4_1_audit_history,
  };
  if (contract.target_session_binding.session_id !== PRODUCTION.target_session_id || contract.target_session_binding.sessions_root !== PRODUCTION.target_sessions_root || contract.target_session_binding.session_file.path !== PRODUCTION.target_session_path) fail("R42_PRODUCTION_BINDING", "production target binding differs from fixed target");
  if (contract.authorization_transcript_binding.session_id !== PRODUCTION.authorization_session_id || contract.authorization_transcript_binding.sessions_root !== PRODUCTION.authorization_sessions_root || contract.authorization_transcript_binding.session_file.path !== PRODUCTION.authorization_session_path) fail("R42_PRODUCTION_BINDING", "production authorization binding differs from fixed transcript");
  const actual = {
    settings_path: contract.settings_contract.settings_path,
    control_root: contract.control_paths.control_root,
    rollback_root: contract.rollback_paths.rollback_root,
    old_activation_root: contract.rollback_paths.old_activation_root,
    quarantine_target: contract.rollback_paths.quarantine_target,
    runtime_audit_root: contract.runtime_audit_paths.runtime_audit_root,
    legacy_r4_1_history_path: contract.runtime_audit_paths.legacy_r4_1_history_path,
  };
  if (canonicalizeJcs(actual) !== canonicalizeJcs(exactPaths) || contract.runtime_audit_paths.audit_base !== PRODUCTION.runtime_audit_base) fail("R42_PRODUCTION_BINDING", "production static paths differ from fixed paths");
  return contract;
}

function assertOldActivationAndPreS2Absent(contract) {
  if (lstatMaybe(contract.rollback_paths.old_activation_root)) fail("R42_FOREIGN_ACTIVATION", "old activation root must be strictly absent");
  if (lstatMaybe(contract.rollback_paths.rollback_root)) fail("R42_ROLLBACK_PREEXISTS", "rollback root must be strictly absent before S2");
  if (lstatMaybe(contract.rollback_paths.quarantine_target)) fail("R42_QUARANTINE_PREEXISTS", "quarantine target must be absent");
}

function assertSettingsStaticConflicts(A, contract) {
  const rule = asObject(A.parsed.ruleInjector, "settings.ruleInjector");
  const v1 = rule.propositionPolicyStableViewInjection;
  if (v1 && typeof v1 === "object" && !Array.isArray(v1)) {
    const ids = v1.selector && typeof v1.selector === "object" && !Array.isArray(v1.selector) ? v1.selector.session_ids : null;
    if (Array.isArray(ids) && ids.includes(contract.target_session_binding.session_id)) fail("R42_SELECTOR_CONFLICT", "target already appears in v1 selector");
  }
  assertOldActivationAndPreS2Absent(contract);
}

export function createInvocationMutationTracker() {
  let count = 0; let operationIdValue = null; let coordinateHashValue = null;
  return Object.freeze({
    afterMutation() { count += 1; },
    bindOperationId(value) { operationIdValue = assertHash(value, "tracked operation_id"); },
    bindCoordinateHash(value) { coordinateHashValue = assertHash(value, "tracked coordinate_hash"); },
    attach(error) {
      if (!error || typeof error !== "object") return;
      const local = Number.isSafeInteger(error.mutationCount) ? error.mutationCount : 0;
      error.mutationCount = Math.max(count, local);
      error.status = error.mutationCount === 0 ? "ZERO_WRITE_HALT" : "NO_FURTHER_WRITE";
      if (operationIdValue) error.operationId = operationIdValue;
      if (coordinateHashValue) error.coordinateHash = coordinateHashValue;
    },
    get count() { return count; },
  });
}

function makeProductionMutationArgs({ repoRoot, bundle, retained, exactText, requiredAfter, coordinate, sourceCommit, afterMutation }) {
  const contract = bundle.contract.value;
  const verify = () => {
    const current = retained.verifyLatestExact({ exactText, maximumAgeMs: 7_200_000, requiredAfter });
    if (coordinate && canonicalizeJcs(current) !== canonicalizeJcs(coordinate)) fail("R42_AUTH_TOCTOU", "latest exact production coordinate changed");
    return current;
  };
  return Object.freeze({
    environment: "production",
    [PRODUCTION_AUTHORITY]: true,
    authorization: { verify },
    sourceCommit,
    sourceGuard() { sourceGuard(repoRoot, sourceCommit, bundle); return true; },
    targetGuard() { verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding); },
    afterMutation,
  });
}

function assertExactRetainedA(lock, contract, A) {
  const current = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
  if (!current.raw.equals(A.raw) || !sameFullIdentity(current.identity, A.full_identity)) fail("R42_A_REVALIDATION", "settings A changed during bounded pre/post-bootstrap revalidation");
}

function assertEmptyInitialInventory(contract) {
  const state = scanControlInventory(contract);
  if (state.rows.length !== 0 || state.settings_temps.length !== 0 || state.operation_id !== null) fail("R42_INITIAL_CONTROL_NOT_EMPTY", "initial execute requires an empty canonical bootstrap prefix");
  return state;
}

export function executeProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput);
  const bundle = loadAndValidateStaticBundle(repoRoot);
  const contract = assertProductionContract(bundle.contract.value);
  const readiness = inspectSourceReadiness(repoRoot, bundle);
  if (!readiness.ready) fail("S2_NOT_AUTHORIZED", "production execute requires the six artifacts and source closure to be exact current HEAD blobs", { source_readiness: readiness });
  const sourceCommit = readiness.source_commit;
  const retained = openRetainedTranscript(contract.authorization_transcript_binding);
  const mutations = createInvocationMutationTracker();
  let lock;
  try {
    const candidate = retained.latestUserCandidate({ maximumAgeMs: 7_200_000 });
    const phrase = initialPhrase({ static_contract_hash: contract.static_contract_hash, source_commit: sourceCommit, target_session_id: contract.target_session_binding.session_id, preview_transcript_prefix_sha256: candidate.previous_boundary.prefix_sha256 });
    if (candidate.text !== phrase) fail("S2_NOT_AUTHORIZED", "latest production coordinate is not the exact R4.2 initial phrase derived from retained preview boundary/current source");
    const requiredAfter = { line: candidate.previous_boundary.latest_line, timestamp: candidate.previous_boundary.timestamp, prefix_bytes: candidate.previous_boundary.prefix_bytes };
    const coordinate = retained.verifyLatestExact({ exactText: phrase, maximumAgeMs: 7_200_000, requiredAfter }); mutations.bindCoordinateHash(coordinate.coordinate_hash);
    lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
    sourceGuard(repoRoot, sourceCommit, bundle);
    verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
    const A = captureSettingsA(contract.settings_contract.settings_path, contract.settings_contract.allowed_metadata_policy);
    assertSettingsStaticConflicts(A, contract);
    const token = computeCommitToken({ staticContractHash: contract.static_contract_hash, coordinateHash: coordinate.coordinate_hash, preRaw: A.raw, sourceCommit, targetSessionId: contract.target_session_binding.session_id });
    const desired = renderDesiredSubtree(contract.settings_contract.desired_v2_template, contract.static_contract_hash, token);
    const B = renderSettingsB({ preParsed: A.parsed, desiredV2: desired });
    const tuple = buildOperationTuple({
      staticContractHash: contract.static_contract_hash, sourceCommit,
      sourceManifestHash: contract.source_manifest.self_hash, sourceClosureHash: contract.source_manifest.source_closure_hash,
      coordinate, initialPreviewTranscriptPrefixSha256: candidate.previous_boundary.prefix_sha256,
      targetSessionBinding: contract.target_session_binding, authorizationTranscriptBinding: contract.authorization_transcript_binding,
      d3Identities: contract.d3_identities, adapterManifestHash: contract.adapter_manifest.self_hash, operatorManifestHash: contract.operator_manifest.self_hash,
      settingsPath: contract.settings_contract.settings_path, prestateA: A, desiredV2: desired, expectedBRawSha256: B.raw_sha256, commitToken: token,
      staticPathPins: staticPathPins(contract), safetyContract: safetyContract(contract),
    });
    validateOperationTupleAgainstStatic(tuple, contract);
    const id = operationId(tuple); mutations.bindOperationId(id); const paths = operationPaths(contract, id);
    const intent = buildIntent({ tuple, controlPaths: paths }); validateIntentAgainstStatic(intent, contract);
    const activation = buildActivation({ intent, staticContract: contract }); validateActivationAgainstIntent(activation, intent, contract);
    assertExactRetainedA(lock, contract, A); assertEmptyInitialInventory(contract); assertOldActivationAndPreS2Absent(contract);
    const gateArgs = makeProductionMutationArgs({ repoRoot, bundle, retained, exactText: phrase, requiredAfter, coordinate, sourceCommit, afterMutation: mutations.afterMutation });
    const guardState = createMutationGuard(gateArgs, phrase, requiredAfter);
    const boot = bootstrapControl({ controlRoot: contract.control_paths.control_root, guard: guardState.guard, afterMutation: mutations.afterMutation }); boot.root.close();
    sourceGuard(repoRoot, sourceCommit, bundle); assertExactRetainedA(lock, contract, A); assertEmptyInitialInventory(contract); assertOldActivationAndPreS2Absent(contract);
    publishAuthority({ contract, operationId: id, kind: "intent", value: intent, guard: guardState.guard, nonce: randomInvocationNonce(), afterMutation: mutations.afterMutation });
    publishAuthority({ contract, operationId: id, kind: "activation", value: activation, guard: guardState.guard, nonce: randomInvocationNonce(), afterMutation: mutations.afterMutation });
    assertExactRetainedA(lock, contract, A);
    const cas = settingsCas({ contract, tuple, B, guard: guardState.guard, nonce: randomInvocationNonce(), lock, afterMutation: mutations.afterMutation });
    const receipt = buildReceipt({ intent, activation, completionAuthorization: { kind: "initial_execute", coordinate, coordinate_hash: coordinate.coordinate_hash }, mode: "direct", postWitness: { actual_B_full_identity: cas.identity, actual_B_full_identity_recoverable: true } });
    validateReceiptAgainstClosure(receipt, intent, activation, contract);
    publishAuthority({ contract, operationId: id, kind: "receipt", value: receipt, guard: guardState.guard, nonce: randomInvocationNonce(), afterMutation: mutations.afterMutation });
    const terminal = verifyProductionTerminal(contract, { settingsLock: lock });
    return deepFreeze({ status: "bound", mode: "direct", operation_id: id, intent_hash: intent.intent_hash, activation_object_hash: activation.activation_object_hash, receipt_hash: receipt.receipt_hash, commit_token: token, source_commit: sourceCommit, runtime_audit_required_before_first_injection: true, terminal_verified: terminal.operation_id === id });
  } catch (error) { mutations.attach(error); throw error; }
  finally { lock?.close(); retained.close(); }
}

function readAuthorityCandidate(row, kind) {
  if (!row?.parsed || row.mode !== 0o600 || row.uid !== process.getuid?.() || row.gid !== process.getgid?.() || (row.nlink !== 1 && row.nlink !== 2)) fail("R42_AUTHORITY_CANDIDATE", `${kind} authority candidate metadata/bytes differ`);
  const value = kind === "intent" ? validateIntent(row.parsed) : kind === "activation" ? validateActivation(row.parsed) : validateReceipt(row.parsed);
  const hashField = kind === "intent" ? "intent_hash" : kind === "activation" ? "activation_object_hash" : "receipt_hash";
  const raw = canonicalObjectBytes(value, hashField, { label: kind });
  if (sha256(raw) !== row.raw_sha256_or_unreadable_reason) fail("R42_AUTHORITY_CANDIDATE", `${kind} authority candidate raw bytes are not exact canonical object bytes`);
  return { value, raw };
}

function assertFinalPendingPair(finalRow, pendingRow, label) {
  if (!finalRow || !pendingRow || finalRow.dev !== pendingRow.dev || finalRow.ino !== pendingRow.ino || finalRow.nlink !== 2 || pendingRow.nlink !== 2 || finalRow.raw_sha256_or_unreadable_reason !== pendingRow.raw_sha256_or_unreadable_reason) fail("R42_AUTHORITY_PAIR", `${label} final+pending is not same-inode/same-bytes nlink-2`);
}

function convergeAuthorityState({ contract, state, kind, expected, guard, linkOnly = false, afterMutation }) {
  const finalRow = state.inventory.rows.find((row) => row.kind === kind && row.role === "final");
  const pendingRow = state.inventory.rows.find((row) => row.kind === kind && row.role === "pending");
  const tempRow = state.inventory.rows.find((row) => row.kind === kind && row.role === "temp");
  const expectedHash = kind === "intent" ? expected.intent_hash : kind === "activation" ? expected.activation_object_hash : expected.receipt_hash;
  const bytes = canonicalObjectBytes(expected, kind === "intent" ? "intent_hash" : kind === "activation" ? "activation_object_hash" : "receipt_hash", { label: kind });
  for (const row of [finalRow, pendingRow].filter(Boolean)) {
    const candidate = readAuthorityCandidate(row, kind);
    if (canonicalizeJcs(candidate.value) !== canonicalizeJcs(expected) || row.raw_sha256_or_unreadable_reason !== sha256(bytes)) fail("R42_AUTHORITY_EXPECTED", `${kind} candidate differs from independently rebuilt expected authority`);
  }
  const parent = openAnchoredDirectory(path.join(contract.control_paths.control_root, kind === "intent" ? "intents" : kind === "activation" ? "activations" : "receipts"), { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.() });
  try {
    if (tempRow) {
      if (!pendingRow || tempRow.dev !== pendingRow.dev || tempRow.ino !== pendingRow.ino || tempRow.nlink !== 2 || pendingRow.nlink !== 2 || tempRow.raw_sha256_or_unreadable_reason !== pendingRow.raw_sha256_or_unreadable_reason) fail("R42_AUTHORITY_TEMP", `${kind} prior temp is not the normal same-inode pending cleanup state`);
      guard(`unlinkat_${kind}_same_inode_temp`); fs.unlinkSync(parent.child(tempRow.name)); afterMutation?.({ syscall: `unlinkat_${kind}_same_inode_temp` });
      guard(`fsync_${kind}_parent_after_same_inode_temp`); fs.fsyncSync(parent.fd); afterMutation?.({ syscall: `fsync_${kind}_parent_after_same_inode_temp` });
    }
    if (finalRow && pendingRow) {
      assertFinalPendingPair(finalRow, pendingRow, kind);
      if (linkOnly) return deepFreeze({ status: "final_plus_pending", expected_hash: expectedHash });
      unlinkPendingIdempotent({ schema: SCHEMAS.unlink_pending, parent, finalBasename: finalRow.name, pendingBasename: pendingRow.name, bytes, guard, afterMutation });
      return deepFreeze({ status: "final_only", expected_hash: expectedHash });
    }
    if (pendingRow) {
      const linked = linkFinalIdempotent({ schema: SCHEMAS.link_final, parent, finalBasename: `${state.operationId}.json`, pendingBasename: pendingRow.name, bytes, guard, afterMutation });
      if (linkOnly) return deepFreeze({ status: linked.status, expected_hash: expectedHash });
      unlinkPendingIdempotent({ schema: SCHEMAS.unlink_pending, parent, finalBasename: `${state.operationId}.json`, pendingBasename: pendingRow.name, bytes, guard, mutationState: { mutationCount: linked.mutation_count }, afterMutation });
      return deepFreeze({ status: "final_only", expected_hash: expectedHash });
    }
    if (finalRow) {
      if (finalRow.nlink !== 1) fail("R42_AUTHORITY_FINAL", `${kind} final-only nlink differs`);
      return deepFreeze({ status: "final_only", expected_hash: expectedHash });
    }
    return deepFreeze({ status: "absent", expected_hash: expectedHash });
  } finally { parent.close(); }
}

export function progressRequiredAfter(baseCoordinate, state, settingsPath) {
  let timestampMs = Date.parse(baseCoordinate.timestamp);
  if (!Number.isFinite(timestampMs)) fail("R42_AUTH_FLOOR", "authorization floor timestamp is invalid");
  const paths = new Set([...(state?.inventory?.rows ?? []).map((row) => row.path), ...(state?.inventory?.settings_temps ?? []).map((row) => row.path), ...(settingsPath ? [settingsPath] : [])]);
  for (const file of paths) {
    const stat = lstatMaybe(file);
    if (stat) timestampMs = Math.max(timestampMs, stat.ctimeMs);
  }
  return { line: baseCoordinate.message_line_number, timestamp: new Date(timestampMs).toISOString(), prefix_bytes: baseCoordinate.transcript_prefix_bytes };
}

function loadCanonicalIntentCandidate(contract, state) {
  const rows = state.inventory.rows.filter((row) => row.kind === "intent");
  if (rows.length < 1 || rows.length > 2) fail("R42_CONTINUE_INTENT", "continue requires one canonical intent pending/final identity");
  if (state.intentFinal && state.intentPending) assertFinalPendingPair(state.intentFinal, state.intentPending, "intent");
  const preferred = state.intentFinal ?? state.intentPending;
  return validateIntentAgainstStatic(readAuthorityCandidate(preferred, "intent").value, contract);
}

export function continueProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const retained = openRetainedTranscript(contract.authorization_transcript_binding); const mutations = createInvocationMutationTracker(); let lock;
  try {
    let state = classifyOperation(contract);
    if (!state.operationId) fail("R42_CONTINUE_OPERATION", "continue requires a sole persisted operation");
    mutations.bindOperationId(state.operationId);
    if (state.inventory.settings_temps.length || state.inventory.rows.some((row) => row.role === "temp" && !(row.nlink === 2 && state.inventory.rows.some((pending) => pending.role === "pending" && pending.kind === row.kind && pending.dev === row.dev && pending.ino === row.ino)))) fail("R42_CONTINUE_TEMP", "continue is blocked by a disposition-required temp");
    const intent = loadCanonicalIntentCandidate(contract, state); const tuple = intent.operation_tuple;
    if (intent.operation_id !== state.operationId) fail("R42_CONTINUE_OPERATION", "inventory operation id differs from canonical tuple");
    sourceGuard(repoRoot, tuple.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
    if (state.receiptFinal && !state.receiptPending) return deepFreeze({ status: "terminal_verified", operation_id: state.operationId, receipt_hash: verifyProductionTerminal(contract).receipt.receipt_hash, rewritten: false, runtime_audit_required_before_first_injection: true });
    if (state.receiptPending) fail("R42_RECEIPT_RECOVERY_REQUIRED", "receipt pending requires --recover-receipt and its exact mode-specific gate");
    const currentRaw = fs.readFileSync(contract.settings_contract.settings_path); const current = classifySettingsAgainstTuple(currentRaw, tuple);
    if (current.state === "C") {
      if (state.intentPending) fail("R42_ADOPTION_I_PENDING", "C with I/p cannot emit adoption preview or converge I");
      lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
      const first = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
      const second = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
      if (!first.raw.equals(second.raw) || !sameFullIdentity(first.identity, second.identity)) fail("R42_ADOPTION_C_DRIFT", "C changed during retained-lock back-to-back reads");
      sourceGuard(repoRoot, tuple.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
      return buildAdoptionPreviewFixture({ contract, currentRaw: second.raw });
    }
    if (current.state !== "A" && current.state !== "B") fail("R42_CONTINUE_SETTINGS", "continue current settings is neither exact tuple A/B nor legal C");
    const phrase = continuePhrase({ operation_id: state.operationId, static_contract_hash: tuple.static_contract_hash, source_commit: tuple.source_commit });
    const requiredAfter = { line: tuple.initial_authorization_coordinate.message_line_number, timestamp: tuple.initial_authorization_coordinate.timestamp, prefix_bytes: tuple.initial_authorization_coordinate.transcript_prefix_bytes };
    const coordinate = retained.verifyLatestExact({ exactText: phrase, maximumAgeMs: 7_200_000, requiredAfter }); mutations.bindCoordinateHash(coordinate.coordinate_hash);
    lock ??= acquireRetainedSettingsLock(contract.settings_contract.settings_path);
    sourceGuard(repoRoot, tuple.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
    const gateArgs = makeProductionMutationArgs({ repoRoot, bundle, retained, exactText: phrase, requiredAfter, coordinate, sourceCommit: tuple.source_commit, afterMutation: mutations.afterMutation }); const guardState = createMutationGuard(gateArgs, phrase, requiredAfter);
    state = classifyOperation(contract); const currentIntent = loadCanonicalIntentCandidate(contract, state);
    if (canonicalizeJcs(currentIntent) !== canonicalizeJcs(intent)) fail("R42_CONTINUE_DRIFT", "intent/inventory changed before continue mutation");
    convergeAuthorityState({ contract, state, kind: "intent", expected: intent, guard: guardState.guard, afterMutation: mutations.afterMutation });
    state = classifyOperation(contract);
    const activation = buildActivation({ intent, staticContract: contract }); validateActivationAgainstIntent(activation, intent, contract);
    const activationState = convergeAuthorityState({ contract, state, kind: "activation", expected: activation, guard: guardState.guard, afterMutation: mutations.afterMutation });
    if (activationState.status === "absent") publishAuthority({ contract, operationId: state.operationId, kind: "activation", value: activation, guard: guardState.guard, nonce: randomInvocationNonce(), afterMutation: mutations.afterMutation });
    const live = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path)); const liveClass = classifySettingsAgainstTuple(live.raw, tuple);
    let postIdentity;
    if (liveClass.state === "A") {
      const B = renderSettingsB({ preParsed: parseStrictJson(decodeCanonicalBase64(tuple.prestate_A.raw_base64)), desiredV2: tuple.desired_v2_subtree });
      postIdentity = settingsCas({ contract, tuple, B, guard: guardState.guard, nonce: randomInvocationNonce(), lock, afterMutation: mutations.afterMutation }).identity;
    } else if (liveClass.state === "B") postIdentity = live.identity;
    else fail("R42_CONTINUE_DRIFT", "settings left exact A/B before direct completion");
    const receipt = buildReceipt({ intent, activation, completionAuthorization: { kind: "fresh_continue", coordinate, coordinate_hash: coordinate.coordinate_hash }, mode: "direct", postWitness: { actual_B_full_identity: postIdentity, actual_B_full_identity_recoverable: true } });
    validateReceiptAgainstClosure(receipt, intent, activation, contract);
    publishAuthority({ contract, operationId: state.operationId, kind: "receipt", value: receipt, guard: guardState.guard, nonce: randomInvocationNonce(), afterMutation: mutations.afterMutation });
    verifyProductionTerminal(contract, { settingsLock: lock });
    return deepFreeze({ status: "bound", mode: "direct", operation_id: state.operationId, receipt_hash: receipt.receipt_hash, runtime_audit_required_before_first_injection: true });
  } catch (error) { mutations.attach(error); throw error; }
  finally { lock?.close(); retained.close(); }
}

export function adoptAmbientStateProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const retained = openRetainedTranscript(contract.authorization_transcript_binding); const mutations = createInvocationMutationTracker(); let lock;
  try {
    let state = classifyOperation(contract);
    if (!state.operationId) fail("R42_ADOPTION_OPERATION", "adoption requires a sole operation");
    mutations.bindOperationId(state.operationId);
    if (state.receiptFinal && !state.receiptPending) return deepFreeze({ status: "terminal_verified", operation_id: state.operationId, receipt_hash: verifyProductionTerminal(contract).receipt.receipt_hash, rewritten: false, runtime_audit_required_before_first_injection: true });
    if (state.receiptPending) fail("R42_RECEIPT_RECOVERY_REQUIRED", "adoption receipt pending requires --recover-receipt");
    lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
    const previewRead = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    const preview = buildAdoptionPreviewFixture({ contract, currentRaw: previewRead.raw });
    const intent = validateIntentAgainstStatic(loadFinalObject(contract, "intent", state.operationId).value, contract); const tuple = intent.operation_tuple;
    const requiredAfter = { line: tuple.initial_authorization_coordinate.message_line_number, timestamp: tuple.initial_authorization_coordinate.timestamp, prefix_bytes: tuple.initial_authorization_coordinate.transcript_prefix_bytes };
    const coordinate = retained.verifyLatestExact({ exactText: preview.exact_authorization_phrase, maximumAgeMs: 7_200_000, requiredAfter }); mutations.bindCoordinateHash(coordinate.coordinate_hash);
    sourceGuard(repoRoot, tuple.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
    const gateArgs = makeProductionMutationArgs({ repoRoot, bundle, retained, exactText: preview.exact_authorization_phrase, requiredAfter, coordinate, sourceCommit: tuple.source_commit, afterMutation: mutations.afterMutation }); const guardState = createMutationGuard(gateArgs, preview.exact_authorization_phrase, requiredAfter);
    state = classifyOperation(contract);
    if (state.intentPending || state.receiptFinal || state.receiptPending || state.inventory.settings_temps.length || state.inventory.rows.some((row) => row.role === "temp" && row.kind !== "activation")) fail("R42_ADOPTION_INVENTORY", "adoption inventory changed or contains a forbidden pending/temp");
    const activation = buildActivation({ intent, staticContract: contract }); validateActivationAgainstIntent(activation, intent, contract);
    const activationState = convergeAuthorityState({ contract, state, kind: "activation", expected: activation, guard: guardState.guard, afterMutation: mutations.afterMutation });
    if (activationState.status === "absent") {
      if (preview.activation_absent !== true) fail("R42_ADOPTION_B0", "activation became absent after preview declared existing V");
      publishAuthority({ contract, operationId: state.operationId, kind: "activation", value: activation, guard: guardState.guard, nonce: randomInvocationNonce(), afterMutation: mutations.afterMutation });
    }
    const first = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    const second = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    if (!first.raw.equals(second.raw) || !sameFullIdentity(first.identity, second.identity) || sha256(second.raw) !== preview.current_C_raw_sha256) fail("R42_ADOPTION_C_DRIFT", "C changed during the sole retained-lock back-to-back read group");
    const current = classifySettingsAgainstTuple(second.raw, tuple);
    if (current.state !== "C" || current.non_v2_jcs_hash !== preview.current_C_non_v2_jcs_hash) fail("R42_ADOPTION_C_DRIFT", "current C no longer matches preview raw/non-v2/v2/token binding");
    sourceGuard(repoRoot, tuple.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
    state = classifyOperation(contract);
    if (!state.intentFinal || state.intentPending || !state.activationFinal || state.activationPending || state.receiptFinal || state.receiptPending || state.inventory.rows.some((row) => row.role === "temp") || state.inventory.settings_temps.length) fail("R42_ADOPTION_REVALIDATION", "I/V/R inventory did not stabilize at A entry");
    validateActivationAgainstIntent(loadFinalObject(contract, "activation", state.operationId).value, intent, contract);
    const receipt = buildReceipt({ intent, activation, completionAuthorization: { kind: "ambient_state_adoption", coordinate, coordinate_hash: coordinate.coordinate_hash }, mode: "ambient_state_adoption", postWitness: { current_C_full_identity: second.identity, current_C_raw_sha256: second.identity.raw_sha256, current_C_non_v2_jcs_hash: current.non_v2_jcs_hash, activation_absent_at_preview: preview.activation_absent, actual_B_full_identity_recoverable: false, cas_A_to_B_history_proven: false, reason: "state_adoption_only_cas_A_to_B_history_not_proven" } });
    validateReceiptAgainstClosure(receipt, intent, activation, contract);
    publishAuthority({ contract, operationId: state.operationId, kind: "receipt", value: receipt, guard: guardState.guard, nonce: randomInvocationNonce(), afterMutation: mutations.afterMutation });
    verifyProductionTerminal(contract, { settingsLock: lock });
    return deepFreeze({ status: "bound", mode: "ambient_state_adoption", operation_id: state.operationId, receipt_hash: receipt.receipt_hash, cas_A_to_B_history_proven: false, actual_B_full_identity_recoverable: false, runtime_audit_required_before_first_injection: true });
  } catch (error) { mutations.attach(error); throw error; }
  finally { lock?.close(); retained.close(); }
}

function validateReceiptRecoveryLocked({ contract, lock, intent, activation, receipt, pendingBinding, syscall }) {
  const state = classifyOperation(contract);
  const pendingMayBeAbsent = syscall === "fsync_parent_after_pending_unlink";
  if (!state.operationId || state.operationId !== intent.operation_id || !state.intentFinal || state.intentPending || !state.activationFinal || state.activationPending || (!state.receiptPending && !(pendingMayBeAbsent && state.receiptFinal)) || state.inventory.settings_temps.length) fail("R42_RECOVERY_STATE", "receipt recovery closure changed under the retained settings lock");
  const allowedTemp = state.inventory.rows.filter((row) => row.role === "temp");
  if (allowedTemp.some((row) => !(row.kind === "receipt" && state.receiptPending && row.dev === state.receiptPending.dev && row.ino === state.receiptPending.ino && row.nlink === 2))) fail("R42_RECOVERY_TEMP", "receipt recovery contains a non-matching temp");
  const liveIntent = validateIntentAgainstStatic(loadFinalObject(contract, "intent", state.operationId).value, contract);
  const liveActivation = validateActivationAgainstIntent(loadFinalObject(contract, "activation", state.operationId).value, liveIntent, contract);
  if (canonicalizeJcs(liveIntent) !== canonicalizeJcs(intent) || canonicalizeJcs(liveActivation) !== canonicalizeJcs(activation)) fail("R42_RECOVERY_DRIFT", "I/V closure changed during receipt recovery");
  const row = state.receiptFinal ?? state.receiptPending;
  const liveReceipt = validateReceiptAgainstClosure(readAuthorityCandidate(row, "receipt").value, liveIntent, liveActivation, contract);
  if (canonicalizeJcs(liveReceipt) !== canonicalizeJcs(receipt)) fail("R42_RECOVERY_DRIFT", "receipt bytes changed during recovery");
  const pending = state.receiptPending;
  if (pending) {
    if (pending.path !== pendingBinding.path || pending.dev !== pendingBinding.dev || pending.ino !== pendingBinding.ino) fail("R42_RECOVERY_DRIFT", "receipt pending path/inode changed during recovery");
    if (state.receiptFinal) assertFinalPendingPair(state.receiptFinal, pending, "receipt");
  } else if (!state.receiptFinal || state.receiptFinal.nlink !== 1) fail("R42_RECOVERY_DRIFT", "post-unlink receipt final is absent or not sole nlink-1 authority");
  if (syscall === "unlinkat_pending" && !state.receiptFinal) fail("R42_RECOVERY_DRIFT", "pending unlink requires an exact final+pending pair");
  const settings = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
  const current = classifySettingsAgainstTuple(settings.raw, intent.operation_tuple);
  if (receipt.mode === "direct" && current.state !== "B") fail("R42_DIRECT_PENDING_NONEXACT_B", "direct R/p remains fail-closed until exact B is externally restored");
  if (receipt.mode === "ambient_state_adoption" && !["B", "C"].includes(current.state)) fail("R42_ADOPTION_PENDING_STATE", "adoption receipt recovery requires runtime-compatible B/C");
  return { state, current };
}

export function recoverReceiptProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const retained = openRetainedTranscript(contract.authorization_transcript_binding); const mutations = createInvocationMutationTracker();
  const lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
  try {
    let state = classifyOperation(contract);
    if (!state.operationId || !state.intentFinal || state.intentPending || !state.activationFinal || state.activationPending || !state.receiptPending || state.inventory.settings_temps.length) fail("R42_RECOVERY_STATE", "receipt recovery requires canonical I/V final and R/p or R+R/p");
    mutations.bindOperationId(state.operationId);
    const intent = validateIntentAgainstStatic(loadFinalObject(contract, "intent", state.operationId).value, contract);
    const activation = validateActivationAgainstIntent(loadFinalObject(contract, "activation", state.operationId).value, intent, contract);
    const receipt = validateReceiptAgainstClosure(readAuthorityCandidate(state.receiptFinal ?? state.receiptPending, "receipt").value, intent, activation, contract);
    const pendingBinding = { path: state.receiptPending.path, dev: state.receiptPending.dev, ino: state.receiptPending.ino };
    validateReceiptRecoveryLocked({ contract, lock, intent, activation, receipt, pendingBinding, syscall: "entry" });
    const fields = { operation_id: state.operationId, receipt_hash: receipt.receipt_hash, pending_path: pendingBinding.path, pending_dev: pendingBinding.dev, pending_ino: pendingBinding.ino, mode: receipt.mode, static_contract_hash: intent.operation_tuple.static_contract_hash, commit_token: intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id, source_commit: intent.operation_tuple.source_commit };
    const phrase = recoveryPhrase(fields); const completion = receipt.completion_authorization.coordinate;
    const requiredAfter = { line: completion.message_line_number, timestamp: completion.timestamp, prefix_bytes: completion.transcript_prefix_bytes };
    const coordinate = retained.verifyLatestExact({ exactText: phrase, maximumAgeMs: 7_200_000, requiredAfter }); mutations.bindCoordinateHash(coordinate.coordinate_hash);
    sourceGuard(repoRoot, intent.operation_tuple.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
    const gateArgs = makeProductionMutationArgs({ repoRoot, bundle, retained, exactText: phrase, requiredAfter, coordinate, sourceCommit: intent.operation_tuple.source_commit, afterMutation: mutations.afterMutation }); const guardState = createMutationGuard(gateArgs, phrase, requiredAfter);
    const recoveryGuard = (syscall) => {
      validateReceiptRecoveryLocked({ contract, lock, intent, activation, receipt, pendingBinding, syscall });
      return guardState.guard(syscall);
    };
    state = validateReceiptRecoveryLocked({ contract, lock, intent, activation, receipt, pendingBinding, syscall: "pre_convergence" }).state;
    const wasFinal = Boolean(state.receiptFinal);
    const result = convergeAuthorityState({ contract, state, kind: "receipt", expected: receipt, guard: recoveryGuard, linkOnly: !wasFinal, afterMutation: mutations.afterMutation });
    if (!wasFinal) return deepFreeze({ status: "receipt_final_plus_pending", mode: receipt.mode, operation_id: state.operationId, same_invocation_pending_unlink_forbidden: true, mutation_count: result.mutation_count ?? null });
    const terminal = verifyProductionTerminal(contract, { settingsLock: lock });
    return deepFreeze({ status: "terminal_verified", mode: receipt.mode, operation_id: state.operationId, receipt_hash: terminal.receipt.receipt_hash, runtime_audit_required_before_first_injection: true });
  } catch (error) { mutations.attach(error); throw error; }
  finally { lock.close(); retained.close(); }
}

export function previewStagedTempDispositionProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const readiness = inspectSourceReadiness(repoRoot, bundle);
  const preview = previewStagedTempDispositionFixture({ contract, sourceCommit: readiness.ready ? readiness.source_commit : undefined });
  sourceGuard(repoRoot, preview.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
  return preview;
}

export function disposeStagedTempProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const preview = previewStagedTempDispositionProduction(repoRoot); const retained = openRetainedTranscript(contract.authorization_transcript_binding); const mutations = createInvocationMutationTracker(); mutations.bindOperationId(preview.operation_id); let lock;
  try {
    if (preview.temp_kind === "settings_cas_stage") {
      lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
      const lockedPreview = previewStagedTempDispositionProduction(repoRoot);
      if (lockedPreview.preview_hash !== preview.preview_hash) fail("R42_TEMP_DISPOSITION_DRIFT", "settings temp disposition preview changed while acquiring the retained settings lock");
    }
    const state = classifyOperation(contract); const intentRow = state.intentFinal ?? state.intentPending ?? state.inventory.rows.find((row) => row.kind === "intent" && row.role === "temp" && row.parsed?.schema_version === SCHEMAS.intent);
    const intent = intentRow ? validateIntentAgainstStatic(readAuthorityCandidate(intentRow, "intent").value, contract) : null;
    const initial = intent?.operation_tuple.initial_authorization_coordinate ?? { message_line_number: 0, timestamp: new Date(0).toISOString(), transcript_prefix_bytes: 0 };
    const requiredAfter = progressRequiredAfter(initial, state, contract.settings_contract.settings_path);
    const coordinate = retained.verifyLatestExact({ exactText: preview.exact_authorization_phrase, maximumAgeMs: 7_200_000, requiredAfter }); mutations.bindCoordinateHash(coordinate.coordinate_hash);
    const args = makeProductionMutationArgs({ repoRoot, bundle, retained, exactText: preview.exact_authorization_phrase, requiredAfter, coordinate, sourceCommit: preview.source_commit, afterMutation: mutations.afterMutation });
    return disposeStagedTempFixture({ ...args, contract, sourceCommit: preview.source_commit });
  } catch (error) { mutations.attach(error); throw error; }
  finally { lock?.close(); retained.close(); }
}

function readProductionAuthorizationObject(file, label) {
  const captured = readBoundedProductionFile(file, label);
  const value = asObject(parseStrictJson(captured.raw, { maxBytes: MAX_OBJECT_BYTES }), label);
  if (`${canonicalizeJcs(value)}\n` !== captured.raw.toString("utf8")) fail("R42_ROLLBACK_AUTH_CANONICAL", `${label} is not exact JCS+LF`);
  return value;
}

function readBoundedProductionFile(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_OBJECT_BYTES || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.() || stat.gid !== process.getgid?.() || stat.nlink !== 1) fail("R42_PRODUCTION_AUTH_FILE", `${label} metadata is unsafe`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd); const raw = fs.readFileSync(fd); const after = fs.fstatSync(fd); const named = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.dev !== named.dev || after.ino !== named.ino || raw.length !== before.size) fail("R42_PRODUCTION_AUTH_FILE", `${label} changed while read`);
    return { raw, stat: before };
  } finally { fs.closeSync(fd); }
}

export function rollbackGateProduction(repoRootInput, options = {}) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const terminal = verifyProductionTerminal(contract, { allowMaterializedRollbackRoot: options.allowMaterializedRollbackRoot === true, ...(options.settingsLock ? { settingsLock: options.settingsLock } : {}) });
  sourceGuard(repoRoot, terminal.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
  const rollbackAuthorization = readProductionAuthorizationObject(PRODUCTION.rollback_authorization_path, "rollback authorization");
  const productionTargetAuthorization = readProductionAuthorizationObject(PRODUCTION.production_target_authorization_path, "production target authorization");
  const gate = evaluateRollbackGate({ contract, activation: terminal.activation, rollbackAuthorization, productionTargetAuthorization });
  if (!gate.authorized || terminal.receipt.activation_object_hash !== terminal.activation.activation_object_hash || terminal.receipt.static_contract_hash !== contract.static_contract_hash || terminal.receipt.commit_token !== terminal.activation.commit_token || terminal.intent.operation_tuple.static_path_pins.rollback_root !== contract.rollback_paths.rollback_root) fail("R42_ROLLBACK_GATE", "production rollback three-door/terminal closure failed");
  const root = lstatMaybe(contract.rollback_paths.rollback_root);
  const rootStateAllowed = options.allowMaterializedRollbackRoot === true
    ? Boolean(root?.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o7777) === 0o700 && root.uid === process.getuid?.() && root.gid === process.getgid?.() && fs.readdirSync(contract.rollback_paths.rollback_root).length === 0)
    : root === null;
  if (!rootStateAllowed) fail("R42_ROLLBACK_ROOT_STATE", "rollback root state differs from this syscall checkpoint");
  return deepFreeze({ authorized: true, operation_id: terminal.operation_id, activation_object_hash: terminal.activation.activation_object_hash, receipt_hash: terminal.receipt.receipt_hash, static_contract_hash: contract.static_contract_hash, commit_token: terminal.intent.operation_tuple.commit_token, source_commit: terminal.source_commit, rollback_root_absent: root === null, materialization_allowed: root === null });
}

export function rollbackProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path); const mutations = createInvocationMutationTracker(); let parent;
  try {
    const first = rollbackGateProduction(repoRoot, { settingsLock: lock });
    if (!first.materialization_allowed) fail("R42_ROLLBACK_EEXIST", "rollback root must be strictly absent before create-only materialization");
    mutations.bindOperationId(first.operation_id);
    parent = openAnchoredDirectory(path.dirname(contract.rollback_paths.rollback_root));
    rollbackGateProduction(repoRoot, { settingsLock: lock });
    try { fs.mkdirSync(parent.child(path.basename(contract.rollback_paths.rollback_root)), { mode: 0o700 }); mutations.afterMutation(); }
    catch (error) { if (error?.code === "EEXIST") fail("R42_ROLLBACK_EEXIST", "rollback mkdir EEXIST is never idempotent success"); throw error; }
    rollbackGateProduction(repoRoot, { allowMaterializedRollbackRoot: true, settingsLock: lock });
    fs.fsyncSync(parent.fd); mutations.afterMutation();
    rollbackGateProduction(repoRoot, { allowMaterializedRollbackRoot: true, settingsLock: lock });
    return deepFreeze({ status: "rollback_root_materialized", operation_id: first.operation_id, rollback_root: contract.rollback_paths.rollback_root, selector_disabled: false, quarantine_performed: false, independent_authorization_required_for_any_rollback_face: true });
  } catch (error) { mutations.attach(error); throw error; }
  finally { parent?.close(); lock.close(); }
}

export function assertProductionMutationNotAuthorized(repoRootInput, mode) {
  const repoRoot = path.resolve(repoRootInput);
  const bundle = loadAndValidateStaticBundle(repoRoot);
  const readiness = inspectSourceReadiness(repoRoot, bundle);
  fail("S2_NOT_AUTHORIZED", `production ${mode} has no applicable exact R4.2 coordinate/state`, { source_readiness: readiness });
}

function assertFixtureRoot(fixtureRootInput, paths) {
  const root = assertAbsolutePath(path.resolve(fixtureRootInput), "fixtureRoot");
  const tmp = path.resolve(os.tmpdir());
  if (root === tmp || !root.startsWith(`${tmp}${path.sep}`)) fail("R42_FIXTURE_ROOT", "fixture mutations are allowed only below the OS temp root");
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail("R42_FIXTURE_PATH", `${resolved} escapes fixture root`);
    if (Object.values(PRODUCTION).some((hard) => typeof hard === "string" && path.isAbsolute(hard) && (resolved === hard || resolved.startsWith(`${hard}${path.sep}`)))) fail("R42_FIXTURE_PRODUCTION", `${resolved} aliases a production hard path`);
  }
  return root;
}

export function buildFixtureContract(baseContractInput, fixture) {
  const base = cloneJson(validateStaticContract(baseContractInput));
  assertFixtureRoot(fixture.root, [fixture.settingsPath, fixture.controlRoot, fixture.rollbackRoot, fixture.runtimeAuditBase, fixture.runtimeAuditRoot, fixture.oldActivationRoot, fixture.quarantineTarget]);
  base.target_session_binding = cloneJson(fixture.targetSessionBinding);
  base.authorization_transcript_binding = cloneJson(fixture.authorizationTranscriptBinding);
  base.settings_contract.settings_path = fixture.settingsPath;
  base.settings_contract.desired_v2_template.selector.session_ids = [fixture.targetSessionBinding.session_id];
  base.settings_contract.desired_v2_template.r4Binding.controlRoot = fixture.controlRoot;
  base.settings_contract.desired_v2_template.r4Binding.settingsPath = fixture.settingsPath;
  base.control_paths.control_root = fixture.controlRoot;
  base.rollback_paths.rollback_root = fixture.rollbackRoot;
  base.rollback_paths.state_root = fixture.rollbackRoot;
  base.rollback_paths.old_activation_root = fixture.oldActivationRoot;
  base.rollback_paths.quarantine_target = fixture.quarantineTarget;
  base.runtime_audit_paths.audit_base = fixture.runtimeAuditBase;
  const baseStat = fs.lstatSync(fixture.runtimeAuditBase);
  base.runtime_audit_paths.audit_base_dev = baseStat.dev;
  base.runtime_audit_paths.audit_base_uid = baseStat.uid;
  base.runtime_audit_paths.audit_base_gid = baseStat.gid;
  base.runtime_audit_paths.audit_base_mode = baseStat.mode & 0o7777;
  base.runtime_audit_paths.runtime_audit_root = fixture.runtimeAuditRoot;
  base.runtime_audit_paths.legacy_r4_1_history_path = path.join(fixture.root, "legacy-r4.1-audit.jsonl");
  delete base.static_contract_hash;
  base.static_contract_hash = jcsSha256(base);
  validateStaticContract(base);
  return deepFreeze(base);
}

export function buildFixtureCoordinate({ binding, text, line = 2, timestamp = new Date().toISOString(), prefixBytes = 256, parentId = "fixture-parent" }) {
  validateSessionBinding(binding);
  const base = {
    schema_version: SCHEMAS.trusted_coordinate,
    session_jsonl_path: binding.session_file.path,
    session_id: binding.session_id,
    session_dev: binding.session_file.dev,
    session_ino: binding.session_file.ino,
    message_id: sha256(`${line}\0${text}`).slice(0, 16),
    message_parent_id: parentId,
    message_line_number: line,
    timestamp,
    role: "user",
    text_utf8_bytes: Buffer.byteLength(text),
    text_sha256: sha256(text),
    transcript_prefix_bytes: prefixBytes,
    transcript_prefix_sha256: sha256(`fixture-prefix-${line}`),
    active_parent_chain_hash: sha256(`fixture-chain-${line}`),
    continuous_parent_chain_verified: true,
    latest_role_user_message_verified: true,
    standalone_single_text_part_verified: true,
    fresh_verified: true,
    caller_supplied_raw_text: false,
  };
  return addSelfHash(base, "coordinate_hash");
}

function fixtureAuthorization(args, expectedText, requiredAfter = null) {
  const fixture = args.environment === "fixture" && args.testOnly === true;
  const production = args.environment === "production" && args[PRODUCTION_AUTHORITY] === true;
  if ((!fixture && !production) || !args.authorization || typeof args.authorization.verify !== "function") fail("R42_AUTHORITY_CONTEXT", "mutation requires a sealed fixture or production retained-transcript authority context");
  const coordinate = args.authorization.verify({ expectedText, requiredAfter });
  if (coordinate.text_sha256 !== sha256(expectedText) || coordinate.text_utf8_bytes !== Buffer.byteLength(expectedText)) fail("R42_AUTH_EXACT", "authorization coordinate text differs");
  return coordinate;
}

function createMutationGuard(args, expectedText, requiredAfter = null) {
  let calls = 0;
  const beforeSource = (syscall) => {
    calls += 1;
    const coordinate = fixtureAuthorization(args, expectedText, requiredAfter);
    args.targetGuard?.({ syscall, call: calls, coordinate });
    args.onGuard?.({ syscall, call: calls, coordinate });
    return Object.freeze({ syscall, call: calls, coordinate });
  };
  const sourceLast = (validation) => {
    if (!validation || validation.call !== calls || validation.syscall === undefined) fail("R42_FIXTURE_SOURCE_GUARD", "source guard is not paired with the latest auth/target validation");
    if (args.sourceGuard?.({ syscall: validation.syscall, call: validation.call, sourceCommit: args.sourceCommit }) !== true) fail("R42_FIXTURE_SOURCE_GUARD", `${validation.syscall} source guard failed`);
    return true;
  };
  return Object.freeze({
    guard(syscall) {
      return sourceLast(beforeSource(syscall));
    },
    beforeSource,
    sourceLast,
    get calls() { return calls; },
  });
}

function operationPaths(contract, id) {
  assertHash(id);
  const root = contract.control_paths.control_root;
  return deepFreeze({
    intent: path.join(root, "intents", `${id}.json`),
    activation: path.join(root, "activations", `${id}.json`),
    receipt: path.join(root, "receipts", `${id}.json`),
    operator_audit: path.join(root, "operator-audit.jsonl"),
  });
}

function staticPathPins(contract) {
  return deepFreeze({
    control_root: contract.control_paths.control_root,
    rollback_root: contract.rollback_paths.rollback_root,
    runtime_audit_root: contract.runtime_audit_paths.runtime_audit_root,
    legacy_r4_1_audit_history: contract.runtime_audit_paths.legacy_r4_1_history_path,
    operator_audit: path.join(contract.control_paths.control_root, "operator-audit.jsonl"),
    old_activation_root: contract.rollback_paths.old_activation_root,
    quarantine_target: contract.rollback_paths.quarantine_target,
    settings_path: contract.settings_contract.settings_path,
  });
}

function safetyContract(contract) {
  return deepFreeze({
    bind_existing_only: true,
    v2_only_write: true,
    non_v2_jcs_carry_forward: true,
    non_v2_raw_not_reviewed: true,
    staged_create_only_authority: true,
    intent_pending_publication_consumes_coordinate: true,
    authority_pending_never_incrementally_written: true,
    r4_2_primitive_only: true,
    per_syscall_retained_auth_reverify: true,
    per_mutating_syscall_source_guard: true,
    bounded_drift_exit_no_auto_loop: true,
    corrupt_authority_no_auto_delete: true,
    compliant_temp_requires_exact_fresh_disposition: true,
    rollback_root_absent_pre_s2: true,
    rollback_not_pre_authorized: true,
    accepted_residual_ids: contract.residuals.accepted_residual_ids,
  });
}

function publishAuthority({ contract, operationId: id, kind, value, guard, nonce, afterMutation }) {
  const directoryName = kind === "intent" ? "intents" : kind === "activation" ? "activations" : "receipts";
  const parent = openAnchoredDirectory(path.join(contract.control_paths.control_root, directoryName), { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.() });
  try {
    const bytes = canonicalObjectBytes(value, kind === "intent" ? "intent_hash" : kind === "activation" ? "activation_object_hash" : "receipt_hash", { label: kind, maxBytes: MAX_OBJECT_BYTES });
    const pending = pendingBasename(id, kind);
    const final = `${id}.json`;
    const temp = stagedTempBasename(id, kind, nonce);
    const staged = stagedPublish({ schema: SCHEMAS.staged_publish, parent, operationId: id, kind, finalBasename: final, pendingBasename: pending, tempBasename: temp, nonce, bytes, guard, afterMutation, validateObject: kind === "intent" ? validateIntent : kind === "activation" ? validateActivation : validateReceipt });
    const converged = convergePendingToFinal({ parent, finalBasename: final, pendingBasename: pending, bytes, guard, afterMutation, mutationState: { mutationCount: staged.mutation_count } });
    return deepFreeze({ ...converged, bytes, value });
  } finally { parent.close(); }
}

function acquireRetainedSettingsLock(settingsPath) {
  assertR42Platform();
  const directory = path.dirname(settingsPath);
  const named = fs.lstatSync(directory);
  if (named.isSymbolicLink() || !named.isDirectory()) fail("R42_OFD_DIRECTORY", "settings parent is unsafe");
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
  let flockFd;
  try {
    const flockNamed = fs.lstatSync("/usr/bin/flock");
    if (flockNamed.isSymbolicLink() || !flockNamed.isFile()) fail("R42_OFD_FLOCK", "/usr/bin/flock is unsafe");
    flockFd = fs.openSync("/usr/bin/flock", fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const result = spawnSync("/proc/self/fd/4", ["-xn", "3"], { cwd: "/", env: gitEnv(), stdio: ["ignore", "ignore", "ignore", fd, flockFd] });
    if (result.status === 1) fail("R42_OFD_BUSY", "settings parent cooperative OFD lock is busy");
    if (result.status !== 0 || result.error || result.signal) fail("R42_OFD_FLOCK", "pinned flock failed");
    const opened = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(directory);
    if (opened.dev !== namedAfter.dev || opened.ino !== namedAfter.ino) fail("R42_OFD_RACE", "settings parent changed during lock");
    let closed = false;
    return Object.freeze({ fd, directory, child: (name) => `/proc/self/fd/${fd}/${name}`, close() { if (!closed) { closed = true; fs.closeSync(fd); } } });
  } catch (error) { fs.closeSync(fd); throw error; }
  finally { if (flockFd !== undefined) fs.closeSync(flockFd); }
}

function readRetainedSettings(lock, basename, maxBytes = MAX_OBJECT_BYTES) {
  const child = lock.child(basename);
  const named = fs.lstatSync(child, { bigint: true });
  if (named.isSymbolicLink() || !named.isFile() || named.size > BigInt(maxBytes)) fail("R42_SETTINGS_RETAINED", "retained settings target is unsafe");
  const fd = fs.openSync(child, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const namedAfter = fs.lstatSync(child, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.dev !== namedAfter.dev || before.ino !== namedAfter.ino || before.size !== BigInt(raw.length)) fail("R42_SETTINGS_RETAINED_RACE", "retained settings changed while read");
    return deepFreeze({ raw, identity: fullIdentityFromBigintStat(before, raw) });
  } finally { fs.closeSync(fd); }
}

function sameFullIdentity(left, right) { return canonicalizeJcs(left) === canonicalizeJcs(right); }

function readExactFd(fd, bytes, label) {
  const raw = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const count = fs.readSync(fd, raw, offset, bytes - offset, offset);
    if (count <= 0) fail("R42_RETAINED_FD_READ", `${label} made no progress`);
    offset += count;
  }
  return raw;
}

function readExactRuntimeAuditFd(parent, basename, fd, expectedRaw, expectedIdentity, label) {
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(expectedRaw.length)) fail("R42_RUNTIME_AUDIT_FINAL_FD", `${label} fd is not the exact bounded regular file`);
  const raw = readExactFd(fd, expectedRaw.length, label);
  const after = fs.fstatSync(fd, { bigint: true });
  const named = fs.lstatSync(parent.child(basename), { bigint: true });
  if (named.isSymbolicLink() || !named.isFile() || before.dev !== named.dev || before.ino !== named.ino) fail("R42_RUNTIME_AUDIT_FINAL_INODE", `${label} fd/path inode differs`);
  const beforeIdentity = fullIdentityFromBigintStat(before, raw);
  const afterIdentity = fullIdentityFromBigintStat(after, raw);
  const namedIdentity = fullIdentityFromBigintStat(named, raw);
  if (!raw.equals(expectedRaw)
    || !sameFullIdentity(beforeIdentity, afterIdentity)
    || !sameFullIdentity(afterIdentity, namedIdentity)
    || (expectedIdentity && !sameFullIdentity(namedIdentity, expectedIdentity))) {
    fail("R42_RUNTIME_AUDIT_FINAL_READBACK", `${label} exact bytes/identity changed`);
  }
  validateRuntimeAuditObject(parseStrictJson(raw));
  return deepFreeze({ raw, identity: namedIdentity });
}

function settingsCas({ contract, tuple, B, guard, nonce, afterMutation, lock }) {
  const settingsPath = contract.settings_contract.settings_path;
  const basename = path.basename(settingsPath);
  const A = tuple.prestate_A.full_identity;
  const pre = readRetainedSettings(lock, basename);
  if (!sameFullIdentity(pre.identity, A) || !pre.raw.equals(decodeCanonicalBase64(tuple.prestate_A.raw_base64))) fail("R42_CAS_PREIMAGE", "settings immediate preimage differs from tuple A");
  if (jcsSha256(nonV2Projection(parseStrictJson(pre.raw))) !== tuple.prestate_A.non_v2_jcs_hash || B.non_v2_jcs_hash !== tuple.prestate_A.non_v2_jcs_hash) fail("R42_CAS_NON_V2", "A/B non-v2 hash differs");
  const tempBase = `.pi-astack-settings.json.adr0040-r4.2.${operationId(tuple)}.settings.stage.${nonce}.tmp`;
  const temp = lock.child(tempBase);
  let fd = null;
  const state = { mutations: 0 };
  const mutate = (name, fn) => { if (guard(name) !== true) fail("R42_CAS_GUARD", `${name} guard failed`); const result = fn(); state.mutations += 1; afterMutation?.({ syscall: name, mutationCount: state.mutations }); return result; };
  try {
    try {
      fd = mutate("openat_settings_temp_create", () => fs.openSync(temp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600));
    } catch (error) {
      if (error?.code === "EEXIST") {
        const wrapped = new R42Error("R42_SETTINGS_TEMP_EEXIST", "settings CAS temp O_EXCL raced with an existing inode", { path: path.join(path.dirname(settingsPath), tempBase) });
        wrapped.mutationCount = state.mutations;
        wrapped.status = state.mutations === 0 ? "ZERO_WRITE_HALT" : "NO_FURTHER_WRITE";
        throw wrapped;
      }
      throw error;
    }
    mutate("fchown_settings_temp", () => fs.fchownSync(fd, A.uid, A.gid));
    mutate("fchmod_settings_temp", () => fs.fchmodSync(fd, A.mode));
    let offset = 0;
    while (offset < B.raw.length) {
      const written = mutate("write_settings_temp", () => fs.writeSync(fd, B.raw, offset, B.raw.length - offset, offset));
      if (written <= 0) fail("R42_CAS_WRITE", "settings temp write made no progress");
      offset += written;
    }
    mutate("fdatasync_settings_temp", () => fs.fdatasyncSync(fd));
    mutate("fsync_settings_temp", () => fs.fsyncSync(fd));
    const tempRaw = readExactFd(fd, B.raw.length, "settings CAS temp");
    const tempStat = fs.fstatSync(fd, { bigint: true });
    const tempIdentity = fullIdentityFromBigintStat(tempStat, tempRaw);
    if (!tempRaw.equals(B.raw) || tempIdentity.mode !== A.mode || tempIdentity.uid !== A.uid || tempIdentity.gid !== A.gid || tempIdentity.nlink !== 1) fail("R42_CAS_TEMP_READBACK", "settings temp bytes/metadata differ");
    const finalCheck = readRetainedSettings(lock, basename);
    if (!sameFullIdentity(finalCheck.identity, A) || !finalCheck.raw.equals(pre.raw)) fail("R42_CAS_FINAL_PREIMAGE", "settings final A check differs");
    mutate("renameat_settings_A_to_B", () => fs.renameSync(temp, lock.child(basename)));
    mutate("fsync_settings_parent", () => fs.fsyncSync(lock.fd));
    const post = readRetainedSettings(lock, basename);
    if (!post.raw.equals(B.raw) || post.identity.raw_sha256 !== tuple.expected_B_raw_sha256 || post.identity.mode !== A.mode || post.identity.uid !== A.uid || post.identity.gid !== A.gid || post.identity.nlink !== 1) fail("R42_CAS_POST", "settings B readback differs");
    return deepFreeze({ status: "written", identity: post.identity, mutations: state.mutations });
  } finally { if (fd !== null) fs.closeSync(fd); }
}

function randomInvocationNonce() { return cryptoRandomHex(); }
function cryptoRandomHex() { return (awaitlessRandomBytes()).toString("hex"); }
function awaitlessRandomBytes() {
  // Imported lazily to keep attempt/nonce creation at the call site and never
  // accept caller bytes. Node's WebCrypto is process-local and CSPRNG-backed.
  const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes); return Buffer.from(bytes);
}

function fixturePhraseBoundary(args) { return args.authorization.previewBoundaryHash ?? sha256("fixture-preview-boundary"); }

export function executeFixture(args) {
  const contract = validateStaticContract(args.contract);
  assertFixtureRoot(args.fixtureRoot, [contract.settings_contract.settings_path, contract.control_paths.control_root, contract.rollback_paths.rollback_root, contract.runtime_audit_paths.runtime_audit_root]);
  assertGitCommit(args.sourceCommit);
  if (lstatMaybe(contract.rollback_paths.rollback_root)) fail("R42_ROLLBACK_PREEXISTS", "rollback root must be absent before S2");
  if (args.sourceGuard?.({ syscall: "branch_entry", call: 0, sourceCommit: args.sourceCommit }) !== true) fail("R42_FIXTURE_SOURCE_GUARD", "branch-entry source guard failed");
  const expectedInitial = initialPhrase({ static_contract_hash: contract.static_contract_hash, source_commit: args.sourceCommit, target_session_id: contract.target_session_binding.session_id, preview_transcript_prefix_sha256: fixturePhraseBoundary(args) });
  const coordinate = fixtureAuthorization(args, expectedInitial, args.authorization.previewBoundary ?? null);
  const lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
  let controlRoot;
  try {
    const A = captureSettingsA(contract.settings_contract.settings_path, contract.settings_contract.allowed_metadata_policy);
    const token = computeCommitToken({ staticContractHash: contract.static_contract_hash, coordinateHash: coordinate.coordinate_hash, preRaw: A.raw, sourceCommit: args.sourceCommit, targetSessionId: contract.target_session_binding.session_id });
    const desired = renderDesiredSubtree(contract.settings_contract.desired_v2_template, contract.static_contract_hash, token);
    const B = renderSettingsB({ preParsed: A.parsed, desiredV2: desired });
    const tuple = buildOperationTuple({
      staticContractHash: contract.static_contract_hash, sourceCommit: args.sourceCommit,
      sourceManifestHash: contract.source_manifest.self_hash, sourceClosureHash: contract.source_manifest.source_closure_hash,
      coordinate, initialPreviewTranscriptPrefixSha256: fixturePhraseBoundary(args),
      targetSessionBinding: contract.target_session_binding, authorizationTranscriptBinding: contract.authorization_transcript_binding,
      d3Identities: contract.d3_identities, adapterManifestHash: contract.adapter_manifest.self_hash, operatorManifestHash: contract.operator_manifest.self_hash,
      settingsPath: contract.settings_contract.settings_path, prestateA: A, desiredV2: desired, expectedBRawSha256: B.raw_sha256, commitToken: token,
      staticPathPins: staticPathPins(contract), safetyContract: safetyContract(contract),
    });
    const id = operationId(tuple);
    const paths = operationPaths(contract, id);
    const intent = buildIntent({ tuple, controlPaths: paths });
    const activation = buildActivation({ intent, staticContract: contract });
    const guardState = createMutationGuard(args, expectedInitial, args.authorization.previewBoundary ?? null);
    const boot = bootstrapControl({ controlRoot: contract.control_paths.control_root, guard: guardState.guard, afterMutation: args.afterMutation });
    controlRoot = boot.root;
    controlRoot.close(); controlRoot = null;
    const nonceI = args.nonces?.intent ?? randomInvocationNonce();
    publishAuthority({ contract, operationId: id, kind: "intent", value: intent, guard: guardState.guard, nonce: nonceI, afterMutation: args.afterMutation });
    const nonceV = args.nonces?.activation ?? randomInvocationNonce();
    publishAuthority({ contract, operationId: id, kind: "activation", value: activation, guard: guardState.guard, nonce: nonceV, afterMutation: args.afterMutation });
    const current = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    if (!current.raw.equals(A.raw)) fail("R42_EXECUTE_A_DRIFT", "settings A drifted before CAS");
    const cas = settingsCas({ contract, tuple, B, guard: guardState.guard, nonce: args.nonces?.settings ?? randomInvocationNonce(), afterMutation: args.afterMutation, lock });
    const completion = { kind: "initial_execute", coordinate, coordinate_hash: coordinate.coordinate_hash };
    const receipt = buildReceipt({ intent, activation, completionAuthorization: completion, mode: "direct", postWitness: { actual_B_full_identity: cas.identity, actual_B_full_identity_recoverable: true } });
    publishAuthority({ contract, operationId: id, kind: "receipt", value: receipt, guard: guardState.guard, nonce: args.nonces?.receipt ?? randomInvocationNonce(), afterMutation: args.afterMutation });
    return deepFreeze({ status: "bound", mode: "direct", operation_id: id, intent_hash: intent.intent_hash, activation_object_hash: activation.activation_object_hash, receipt_hash: receipt.receipt_hash, commit_token: token, source_commit: args.sourceCommit, runtime_audit_required_before_first_injection: true, mutation_guard_calls: guardState.calls });
  } finally { controlRoot?.close(); lock.close(); }
}

function scanAuthorityDirectory(contract, kind, rootDev) {
  const dirName = kind === "intent" ? "intents" : kind === "activation" ? "activations" : "receipts";
  const dir = path.join(contract.control_paths.control_root, dirName);
  const stat = lstatMaybe(dir);
  if (!stat) return { entries: [], directory: dir };
  const assertMetadata = (current) => {
    if (current.isSymbolicLink() || !current.isDirectory() || (current.mode & 0o7777) !== 0o700 || current.uid !== process.getuid?.() || current.gid !== process.getgid?.() || current.dev !== rootDev) fail("R42_CONTROL_DIRECTORY", `${dirName} metadata is unsafe`);
  };
  assertMetadata(stat);
  const names = fs.readdirSync(dir).sort(compareUtf8);
  const after = fs.lstatSync(dir);
  assertMetadata(after);
  if (stat.dev !== after.dev || stat.ino !== after.ino) fail("R42_CONTROL_DIRECTORY", `${dirName} inode changed during inventory`);
  if (names.length > 3) fail("R42_CONTROL_BOUND", `${dirName} exceeds final/pending/temp bound`);
  return { entries: names, directory: dir };
}

function readInventoryFile(file, stat, label) {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(MAX_OBJECT_BYTES)) fail("R42_CONTROL_FILE", `${file} is unsafe or oversized`);
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) {
    const reason = error?.code === "EACCES" ? "unreadable_eacces" : error?.code === "EIO" ? "unreadable_eio" : "unreadable_changed_during_read";
    return { raw: null, parsed: null, raw_sha256_or_unreadable_reason: reason, classification: `${label}_unreadable` };
  }
  let parsed = null;
  try { parsed = parseStrictJson(raw, { maxBytes: MAX_OBJECT_BYTES }); }
  catch { /* readable corrupt residue still reports its exact raw SHA */ }
  return { raw, parsed, raw_sha256_or_unreadable_reason: sha256(raw), classification: parsed ? `${label}_candidate` : `${label}_readable_corrupt` };
}

export function scanControlInventory(contractInput) {
  const contract = validateStaticContract(contractInput);
  const root = contract.control_paths.control_root;
  const rootStat = lstatMaybe(root);
  if (!rootStat) return deepFreeze({ bootstrap_state: "root_absent", operation_id: null, rows: [], settings_temps: [], inventory_hash: jcsSha256({ control: [], settings_temps: [] }) });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o7777) !== 0o700 || rootStat.uid !== process.getuid?.() || rootStat.gid !== process.getgid?.()) fail("R42_CONTROL_ROOT", "control root metadata is unsafe");
  const top = fs.readdirSync(root).sort(compareUtf8);
  if (top.length > 4 || top.some((name) => !["intents", "activations", "receipts", "operator-audit.jsonl"].includes(name))) fail("R42_CONTROL_TOP", "control top-level inventory differs");
  if (top.includes("operator-audit.jsonl")) {
    const audit = fs.lstatSync(path.join(root, "operator-audit.jsonl"));
    if (audit.isSymbolicLink() || !audit.isFile() || audit.uid !== process.getuid?.() || audit.gid !== process.getgid?.() || audit.dev !== rootStat.dev) fail("R42_CONTROL_AUDIT", "operator audit metadata is unsafe");
  }
  const rows = [];
  const ids = new Set();
  for (const kind of ["intent", "activation", "receipt"]) {
    const scanned = scanAuthorityDirectory(contract, kind, rootStat.dev);
    for (const name of scanned.entries) {
      const final = /^([0-9a-f]{64})\.json$/.exec(name);
      const pending = new RegExp(`^\\.([0-9a-f]{64})\\.${kind}\\.pending$`).exec(name);
      const temp = new RegExp(`^\\.([0-9a-f]{64})\\.${kind}\\.stage\\.([0-9a-f]{32})\\.tmp$`).exec(name);
      if (!final && !pending && !temp) fail("R42_CONTROL_FOREIGN", `foreign ${kind} entry ${name}`);
      const id = (final ?? pending ?? temp)[1]; ids.add(id);
      const file = path.join(scanned.directory, name);
      const stat = fs.lstatSync(file, { bigint: true });
      const read = readInventoryFile(file, stat, `${kind}_${final ? "final" : pending ? "pending" : "temp"}`);
      rows.push({ kind, name, path: file, operation_id: id, role: final ? "final" : pending ? "pending" : "temp", dev: Number(stat.dev), ino: Number(stat.ino), mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), gid: Number(stat.gid), nlink: Number(stat.nlink), size: Number(stat.size), raw_sha256_or_unreadable_reason: read.raw_sha256_or_unreadable_reason, classification: read.classification, parsed: read.parsed });
    }
  }
  const settingsParent = path.dirname(contract.settings_contract.settings_path);
  const settingsPattern = /^\.pi-astack-settings\.json\.adr0040-r4\.2\.([0-9a-f]{64})\.settings\.stage\.([0-9a-f]{32})\.tmp$/;
  const settingsNames = fs.readdirSync(settingsParent).filter((name) => settingsPattern.test(name)).sort(compareUtf8);
  if (settingsNames.length > 1) fail("R42_SETTINGS_TEMP_BOUND", "settings parent contains more than one R4.2 CAS temp");
  const settingsTemps = settingsNames.map((name) => {
    const match = settingsPattern.exec(name); const id = match[1]; ids.add(id);
    const file = path.join(settingsParent, name); const stat = fs.lstatSync(file, { bigint: true });
    const read = readInventoryFile(file, stat, "settings_cas_temp");
    return { kind: "settings", name, path: file, operation_id: id, role: "temp", temp_kind: "settings_cas_stage", dev: Number(stat.dev), ino: Number(stat.ino), mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), gid: Number(stat.gid), nlink: Number(stat.nlink), size: Number(stat.size), raw_sha256_or_unreadable_reason: read.raw_sha256_or_unreadable_reason, classification: read.classification, parsed: read.parsed };
  });
  if (rows.length > 9 || ids.size > 1) fail("R42_CONTROL_OPERATION", "control/settings inventory has more than one operation or exceeds bound");
  rows.sort((left, right) => compareUtf8(left.path, right.path));
  const serial = rows.map(({ parsed, ...row }) => row); const serialSettings = settingsTemps.map(({ parsed, ...row }) => row);
  return deepFreeze({ bootstrap_state: top.includes("receipts") ? "root_plus_intents_activations_receipts" : "partial", operation_id: ids.size === 1 ? [...ids][0] : null, rows, settings_temps: settingsTemps, inventory_hash: jcsSha256({ control: serial, settings_temps: serialSettings }) });
}

function loadFinalObject(contract, kind, id) {
  const directory = kind === "intent" ? "intents" : kind === "activation" ? "activations" : "receipts";
  const parent = openAnchoredDirectory(path.join(contract.control_paths.control_root, directory), { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.() });
  try {
    const basename = `${id}.json`;
    const held = readAnchoredFile(parent, basename, { label: `canonical ${kind}`, maxBytes: MAX_OBJECT_BYTES, mode: 0o600, nlink: 1, uid: process.getuid?.(), gid: process.getgid?.(), strictJson: true });
    const raw = held.raw; const value = parseStrictJson(raw, { maxBytes: MAX_OBJECT_BYTES });
    if (`${canonicalizeJcs(value)}\n` !== raw.toString("utf8")) fail("R42_AUTHORITY_CANONICAL", `${kind} is not exact JCS+LF`);
    if (kind === "intent") validateIntent(value); else if (kind === "activation") validateActivation(value); else validateReceipt(value);
    return { file: path.join(parent.path, basename), raw, value, stat: fs.lstatSync(parent.child(basename)), identity: held.identity };
  } finally { parent.close(); }
}

function classifyOperation(contract) {
  const inventory = scanControlInventory(contract);
  if (!inventory.operation_id) return { inventory, operationId: null };
  const id = inventory.operation_id;
  const by = (kind, role) => inventory.rows.find((row) => row.kind === kind && row.role === role);
  return { inventory, operationId: id, intentFinal: by("intent", "final"), intentPending: by("intent", "pending"), activationFinal: by("activation", "final"), activationPending: by("activation", "pending"), receiptFinal: by("receipt", "final"), receiptPending: by("receipt", "pending") };
}

export function buildAdoptionPreviewFixture(args) {
  const contract = validateStaticContract(args.contract);
  const state = classifyOperation(contract);
  if (!state.intentFinal || state.intentPending || state.receiptFinal || state.receiptPending || state.inventory.rows.some((row) => row.role === "temp") || state.inventory.settings_temps.length !== 0) fail("R42_ADOPTION_INVENTORY", "adoption preview requires sole final intent, no receipt/I-pending/temp");
  const intent = validateIntentAgainstStatic(loadFinalObject(contract, "intent", state.operationId).value, contract);
  const tuple = intent.operation_tuple;
  const current = args.currentRaw ? Buffer.from(args.currentRaw) : fs.readFileSync(contract.settings_contract.settings_path);
  const classification = classifySettingsAgainstTuple(current, tuple);
  if (classification.state !== "C") fail("R42_ADOPTION_STATE", "current settings is not C");
  const inputs = buildActivationHashInputs({ intent, staticContract: contract });
  const activation = buildActivation({ intent, staticContract: contract });
  const activationRows = state.inventory.rows.filter((row) => row.kind === "activation");
  if (activationRows.length > 2) fail("R42_ADOPTION_ACTIVATION", "activation inventory exceeds pending/final bound");
  for (const row of activationRows) {
    if (!row.parsed || row.mode !== 0o600 || row.uid !== process.getuid?.() || row.gid !== process.getgid?.() || canonicalizeJcs(validateActivationAgainstIntent(row.parsed, intent, contract)) !== canonicalizeJcs(activation)) fail("R42_ADOPTION_ACTIVATION", "existing activation final/pending differs from deterministic expected V");
  }
  if (state.activationFinal && state.activationPending) {
    if (state.activationFinal.dev !== state.activationPending.dev || state.activationFinal.ino !== state.activationPending.ino || state.activationFinal.nlink !== 2 || state.activationPending.nlink !== 2 || state.activationFinal.raw_sha256_or_unreadable_reason !== state.activationPending.raw_sha256_or_unreadable_reason) fail("R42_ADOPTION_ACTIVATION", "V+V/p is not an exact same-inode pair");
  } else if (state.activationFinal && state.activationFinal.nlink !== 1) fail("R42_ADOPTION_ACTIVATION", "V final is not nlink-1");
  else if (state.activationPending && state.activationPending.nlink !== 1) fail("R42_ADOPTION_ACTIVATION", "V/p is not nlink-1");
  const activationAbsent = !state.activationFinal && !state.activationPending;
  const fields = buildAdoptionAuthorizationFields({
    intent,
    staticContract: contract,
    currentCRawSha256: classification.raw_sha256,
    currentCNonV2JcsHash: classification.non_v2_jcs_hash,
    activationAbsent,
  });
  const base = { schema_version: SCHEMAS.adoption_preview, revision: REVISION, op_id: fields.operation_id, static_contract_hash: fields.static_contract_hash, commit_token: fields.commit_token, current_C_raw_sha256: fields.current_C_raw_sha256, current_C_non_v2_jcs_hash: fields.current_C_non_v2_jcs_hash, target_session_id: fields.target_session_id, source_commit: fields.source_commit, activation_absent: fields.activation_absent, activation_hash_inputs: inputs, activation_hash_inputs_hash: fields.activation_hash_inputs_hash, expected_activation_object_hash: fields.expected_activation_object_hash, exact_authorization_phrase: adoptionPhrase(fields), authoritative: false };
  return addSelfHash(base, "preview_hash");
}

export function adoptAmbientStateFixture(args) {
  const contract = validateStaticContract(args.contract);
  const lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
  try {
    let state = classifyOperation(contract);
    const lockedPreviewRead = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    const preview = buildAdoptionPreviewFixture({ ...args, currentRaw: lockedPreviewRead.raw });
    if (args.sourceGuard?.({ syscall: "branch_entry", call: 0, sourceCommit: preview.source_commit }) !== true) fail("R42_FIXTURE_SOURCE_GUARD", "adoption source entry guard failed");
    const coordinate = fixtureAuthorization(args, preview.exact_authorization_phrase, args.authorization.previewBoundary ?? null);
    const guardState = createMutationGuard(args, preview.exact_authorization_phrase, args.authorization.previewBoundary ?? null);
    const id = preview.op_id;
    const intent = validateIntentAgainstStatic(loadFinalObject(contract, "intent", id).value, contract);
    const activation = buildActivation({ intent, staticContract: contract });
    const activationState = convergeAuthorityState({ contract, state, kind: "activation", expected: activation, guard: guardState.guard, afterMutation: args.afterMutation });
    if (activationState.status === "absent") {
      if (preview.activation_absent !== true) fail("R42_ADOPTION_B0", "activation became absent after preview declared existing V");
      publishAuthority({ contract, operationId: id, kind: "activation", value: activation, guard: guardState.guard, nonce: args.nonces?.activation ?? randomInvocationNonce(), afterMutation: args.afterMutation });
    }
    const first = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    const second = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    if (!first.raw.equals(second.raw) || !sameFullIdentity(first.identity, second.identity) || sha256(second.raw) !== preview.current_C_raw_sha256) fail("R42_ADOPTION_C_DRIFT", "C changed during the retained-lock back-to-back read group");
    const current = classifySettingsAgainstTuple(second.raw, intent.operation_tuple);
    if (current.state !== "C" || current.non_v2_jcs_hash !== preview.current_C_non_v2_jcs_hash) fail("R42_ADOPTION_C_DRIFT", "current C no longer matches the preview binding");
    state = classifyOperation(contract);
    if (!state.intentFinal || state.intentPending || !state.activationFinal || state.activationPending || state.receiptFinal || state.receiptPending || state.inventory.rows.some((row) => row.role === "temp") || state.inventory.settings_temps.length) fail("R42_ADOPTION_REVALIDATION", "I/V/R inventory did not stabilize at adoption receipt entry");
    validateActivationAgainstIntent(loadFinalObject(contract, "activation", id).value, intent, contract);
    const receipt = buildReceipt({
      intent, activation,
      completionAuthorization: { kind: "ambient_state_adoption", coordinate, coordinate_hash: coordinate.coordinate_hash },
      mode: "ambient_state_adoption",
      postWitness: { current_C_full_identity: second.identity, current_C_raw_sha256: second.identity.raw_sha256, current_C_non_v2_jcs_hash: current.non_v2_jcs_hash, activation_absent_at_preview: preview.activation_absent, actual_B_full_identity_recoverable: false, cas_A_to_B_history_proven: false, reason: "state_adoption_only_cas_A_to_B_history_not_proven" },
    });
    validateReceiptAgainstClosure(receipt, intent, activation, contract);
    publishAuthority({ contract, operationId: id, kind: "receipt", value: receipt, guard: guardState.guard, nonce: args.nonces?.receipt ?? randomInvocationNonce(), afterMutation: args.afterMutation });
    verifyTerminalFixture(contract, { settingsLock: lock });
    return deepFreeze({ status: "bound", mode: "ambient_state_adoption", operation_id: id, receipt_hash: receipt.receipt_hash, cas_A_to_B_history_proven: false, actual_B_full_identity_recoverable: false, runtime_audit_required_before_first_injection: true });
  } finally { lock.close(); }
}

export function continueFixture(args) {
  const contract = validateStaticContract(args.contract);
  const lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
  try {
    let state = classifyOperation(contract);
    if (!state.operationId) fail("R42_CONTINUE_INTENT", "continue requires a sole canonical intent identity");
    if (state.inventory.settings_temps.length || state.inventory.rows.some((row) => row.role === "temp" && !(row.nlink === 2 && state.inventory.rows.some((pending) => pending.role === "pending" && pending.kind === row.kind && pending.dev === row.dev && pending.ino === row.ino)))) fail("R42_CONTINUE_TEMP", "continue is blocked by a disposition-required temp");
    const intent = loadCanonicalIntentCandidate(contract, state);
    if (intent.operation_id !== state.operationId) fail("R42_CONTINUE_OPERATION", "inventory operation id differs from canonical tuple");
    const tuple = intent.operation_tuple;
    if (state.receiptFinal && !state.receiptPending) {
      const terminal = verifyTerminalFixture(contract, { settingsLock: lock });
      return deepFreeze({ status: "terminal_verified", operation_id: state.operationId, receipt_hash: terminal.receipt.receipt_hash, rewritten: false, runtime_audit_required_before_first_injection: true });
    }
    if (state.receiptPending) fail("R42_RECEIPT_RECOVERY_REQUIRED", "receipt pending requires the receipt recovery gate");
    const firstCurrent = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    const classification = classifySettingsAgainstTuple(firstCurrent.raw, tuple);
    if (classification.state === "C") {
      if (state.intentPending) fail("R42_ADOPTION_I_PENDING", "C with I/p cannot emit an adoption preview or converge I");
      const secondCurrent = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
      if (!firstCurrent.raw.equals(secondCurrent.raw) || !sameFullIdentity(firstCurrent.identity, secondCurrent.identity)) fail("R42_ADOPTION_C_DRIFT", "C changed during retained-lock back-to-back reads");
      return buildAdoptionPreviewFixture({ ...args, currentRaw: secondCurrent.raw });
    }
    if (classification.state !== "A" && classification.state !== "B") fail("R42_CONTINUE_SETTINGS", "continue settings is neither exact A/B nor legal C preview candidate");
    const expected = continuePhrase({ operation_id: state.operationId, static_contract_hash: tuple.static_contract_hash, source_commit: tuple.source_commit });
    const requiredAfter = { line: tuple.initial_authorization_coordinate.message_line_number, timestamp: tuple.initial_authorization_coordinate.timestamp, prefix_bytes: tuple.initial_authorization_coordinate.transcript_prefix_bytes };
    const coordinate = fixtureAuthorization(args, expected, requiredAfter);
    const guardState = createMutationGuard(args, expected, requiredAfter);
    convergeAuthorityState({ contract, state, kind: "intent", expected: intent, guard: guardState.guard, afterMutation: args.afterMutation });
    state = classifyOperation(contract);
    const activation = buildActivation({ intent, staticContract: contract });
    const activationState = convergeAuthorityState({ contract, state, kind: "activation", expected: activation, guard: guardState.guard, afterMutation: args.afterMutation });
    if (activationState.status === "absent") publishAuthority({ contract, operationId: state.operationId, kind: "activation", value: activation, guard: guardState.guard, nonce: args.nonces?.activation ?? randomInvocationNonce(), afterMutation: args.afterMutation });
    const live = readRetainedSettings(lock, path.basename(contract.settings_contract.settings_path));
    const liveClass = classifySettingsAgainstTuple(live.raw, tuple);
    let postIdentity;
    if (liveClass.state === "A") {
      const B = renderSettingsB({ preParsed: parseStrictJson(decodeCanonicalBase64(tuple.prestate_A.raw_base64)), desiredV2: tuple.desired_v2_subtree });
      postIdentity = settingsCas({ contract, tuple, B, guard: guardState.guard, nonce: args.nonces?.settings ?? randomInvocationNonce(), afterMutation: args.afterMutation, lock }).identity;
    } else if (liveClass.state === "B") postIdentity = live.identity;
    else fail("R42_CONTINUE_DRIFT", "settings left exact A/B before direct completion");
    const receipt = buildReceipt({ intent, activation, completionAuthorization: { kind: "fresh_continue", coordinate, coordinate_hash: coordinate.coordinate_hash }, mode: "direct", postWitness: { actual_B_full_identity: postIdentity, actual_B_full_identity_recoverable: true } });
    validateReceiptAgainstClosure(receipt, intent, activation, contract);
    publishAuthority({ contract, operationId: state.operationId, kind: "receipt", value: receipt, guard: guardState.guard, nonce: args.nonces?.receipt ?? randomInvocationNonce(), afterMutation: args.afterMutation });
    verifyTerminalFixture(contract, { settingsLock: lock });
    return deepFreeze({ status: "bound", mode: "direct", operation_id: state.operationId, receipt_hash: receipt.receipt_hash, runtime_audit_required_before_first_injection: true });
  } finally { lock.close(); }
}

function recoverReceiptConvergenceFixture(args, expectedPhase) {
  const contract = validateStaticContract(args.contract);
  const lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
  try {
    let state = classifyOperation(contract);
    if (!state.operationId || !state.intentFinal || state.intentPending || !state.activationFinal || state.activationPending || !state.receiptPending) fail("R42_RECOVERY_STATE", "receipt recovery requires canonical I/V final and receipt pending authority");
    if (expectedPhase === "pending_only" && state.receiptFinal) fail("R42_RECOVERY_STATE", "pending recovery requires pending-only receipt");
    if (expectedPhase === "final_plus_pending" && !state.receiptFinal) fail("R42_RECOVERY_STATE", "cleanup requires final+pending receipt");
    const intent = validateIntentAgainstStatic(loadFinalObject(contract, "intent", state.operationId).value, contract);
    const activation = validateActivationAgainstIntent(loadFinalObject(contract, "activation", state.operationId).value, intent, contract);
    const receipt = validateReceiptAgainstClosure(readAuthorityCandidate(state.receiptFinal ?? state.receiptPending, "receipt").value, intent, activation, contract);
    const pendingBinding = { path: state.receiptPending.path, dev: state.receiptPending.dev, ino: state.receiptPending.ino };
    validateReceiptRecoveryLocked({ contract, lock, intent, activation, receipt, pendingBinding, syscall: "entry" });
    const tuple = intent.operation_tuple;
    const phrase = recoveryPhrase({ operation_id: state.operationId, receipt_hash: receipt.receipt_hash, pending_path: pendingBinding.path, pending_dev: pendingBinding.dev, pending_ino: pendingBinding.ino, mode: receipt.mode, static_contract_hash: tuple.static_contract_hash, commit_token: tuple.commit_token, target_session_id: contract.target_session_binding.session_id, source_commit: tuple.source_commit });
    const requiredAfter = { line: receipt.completion_authorization.coordinate.message_line_number, timestamp: receipt.completion_authorization.coordinate.timestamp, prefix_bytes: receipt.completion_authorization.coordinate.transcript_prefix_bytes };
    fixtureAuthorization(args, phrase, requiredAfter);
    const guardState = createMutationGuard(args, phrase, requiredAfter);
    const recoveryGuard = (syscall) => {
      validateReceiptRecoveryLocked({ contract, lock, intent, activation, receipt, pendingBinding, syscall });
      return guardState.guard(syscall);
    };
    state = validateReceiptRecoveryLocked({ contract, lock, intent, activation, receipt, pendingBinding, syscall: "pre_convergence" }).state;
    const result = convergeAuthorityState({ contract, state, kind: "receipt", expected: receipt, guard: recoveryGuard, linkOnly: expectedPhase === "pending_only", afterMutation: args.afterMutation });
    if (expectedPhase === "pending_only") return deepFreeze({ status: "receipt_final_plus_pending", mode: receipt.mode, operation_id: state.operationId, same_invocation_pending_unlink_forbidden: true, mutation_count: result.mutation_count ?? null });
    const terminal = verifyTerminalFixture(contract, { settingsLock: lock });
    return deepFreeze({ status: "terminal_verified", mode: receipt.mode, operation_id: state.operationId, receipt_hash: terminal.receipt.receipt_hash, mutation_count: result.mutation_count ?? null });
  } finally { lock.close(); }
}

export function recoverReceiptPendingFixture(args) {
  return recoverReceiptConvergenceFixture(args, "pending_only");
}

export function cleanupReceiptFinalPendingFixture(args) {
  return recoverReceiptConvergenceFixture(args, "final_plus_pending");
}

function relationForTemp(row, state) {
  const pending = state.inventory.rows.find((item) => item.kind === row.kind && item.role === "pending");
  const final = state.inventory.rows.find((item) => item.kind === row.kind && item.role === "final");
  return { pending_relation: pending ? (pending.dev === row.dev && pending.ino === row.ino && pending.raw_sha256_or_unreadable_reason === row.raw_sha256_or_unreadable_reason && row.nlink === 2 ? "same_inode_exact_bytes_nlink2" : "foreign") : "absent", final_relation: final ? "present" : "absent" };
}

export function previewStagedTempDispositionFixture(args) {
  const contract = validateStaticContract(args.contract);
  const state = classifyOperation(contract);
  const temps = [...state.inventory.rows.filter((row) => row.role === "temp"), ...state.inventory.settings_temps];
  if (temps.length !== 1) fail("R42_TEMP_DISPOSITION_COUNT", "exactly one R4.2 authority/settings temp is required");
  const row = temps[0];
  let relation;
  let tempKind;
  const intent = state.intentFinal ? loadFinalObject(contract, "intent", state.operationId).value : null;
  if (row.kind === "settings") {
    if (!intent) fail("R42_TEMP_DISPOSITION_SETTINGS_INTENT", "settings CAS temp requires canonical final intent");
    const current = classifySettingsAgainstTuple(fs.readFileSync(contract.settings_contract.settings_path), intent.operation_tuple);
    if (current.state !== "A" && current.state !== "B") fail("R42_TEMP_DISPOSITION_RELATION", "settings CAS target is neither exact tuple A nor exact tuple B");
    if (row.mode !== intent.operation_tuple.prestate_A.full_identity.mode || row.uid !== intent.operation_tuple.prestate_A.full_identity.uid || row.gid !== intent.operation_tuple.prestate_A.full_identity.gid || row.nlink !== 1) fail("R42_TEMP_DISPOSITION_RELATION", "settings CAS temp metadata differs from tuple A");
    if (current.state === "B" && row.raw_sha256_or_unreadable_reason !== intent.operation_tuple.expected_B_raw_sha256) fail("R42_TEMP_DISPOSITION_RELATION", "settings CAS temp beside exact B is not redundant exact B bytes");
    relation = { pending_relation: "not_applicable_settings_cas", final_relation: current.state === "A" ? "settings_target_exact_A" : "settings_target_exact_B" };
    tempKind = "settings_cas_stage";
  } else {
    relation = relationForTemp(row, state);
    if (relation.pending_relation !== "absent" || relation.final_relation !== "absent" || row.nlink !== 1 || row.mode !== 0o600 || row.uid !== process.getuid?.() || row.gid !== process.getgid?.()) fail("R42_TEMP_DISPOSITION_RELATION", "authority temp is not an eligible nlink-1 nonauthority residue");
    tempKind = `${row.kind}_stage`;
  }
  const stagedIntent = !intent && row.kind === "intent" && row.parsed?.schema_version === SCHEMAS.intent ? validateIntentAgainstStatic(row.parsed, contract) : null;
  const sourceCommit = intent?.source_commit ?? stagedIntent?.source_commit ?? args.sourceCommit;
  assertGitCommit(sourceCommit, "staged temp disposition source_commit");
  const fields = { operation_id: state.operationId, static_contract_hash: contract.static_contract_hash, source_commit: sourceCommit, target_session_id: contract.target_session_binding.session_id, control_inventory_hash: state.inventory.inventory_hash, temp_kind: tempKind, temp_path: row.path, temp_dev: row.dev, temp_ino: row.ino, temp_raw_sha256_or_unreadable_reason: row.raw_sha256_or_unreadable_reason, temp_size: row.size, temp_mode: row.mode, temp_uid: row.uid, temp_gid: row.gid, temp_nlink: row.nlink, ...relation };
  const inventory = [...state.inventory.rows, ...state.inventory.settings_temps].map(({ parsed, ...item }) => item).sort((left, right) => compareUtf8(left.path, right.path));
  const base = { schema_version: SCHEMAS.staged_temp_disposition_preview, revision: REVISION, operation_id: fields.operation_id, static_contract_hash: fields.static_contract_hash, source_commit: fields.source_commit, target_session_id: fields.target_session_id, control_inventory: inventory, control_inventory_hash: fields.control_inventory_hash, temp_kind: fields.temp_kind, temp_path: fields.temp_path, temp_dev: fields.temp_dev, temp_ino: fields.temp_ino, temp_raw_sha256_or_unreadable_reason: fields.temp_raw_sha256_or_unreadable_reason, temp_size: fields.temp_size, temp_mode: fields.temp_mode, temp_uid: fields.temp_uid, temp_gid: fields.temp_gid, temp_nlink: fields.temp_nlink, pending_relation: fields.pending_relation, final_relation: fields.final_relation, action: "unlink_nonauthority_temp", exact_authorization_phrase: stagedTempDispositionPhrase(fields), authoritative: false };
  return addSelfHash(base, "preview_hash");
}

export function disposeStagedTempFixture(args) {
  const preview = previewStagedTempDispositionFixture(args);
  fixtureAuthorization(args, preview.exact_authorization_phrase, args.authorization.previewBoundary ?? null);
  const guardState = createMutationGuard(args, preview.exact_authorization_phrase);
  const parentOptions = preview.temp_kind === "settings_cas_stage" ? {} : { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.() };
  const parent = openAnchoredDirectory(path.dirname(preview.temp_path), parentOptions);
  try {
    const before = fs.lstatSync(parent.child(path.basename(preview.temp_path)));
    const currentInventory = scanControlInventory(validateStaticContract(args.contract));
    if (currentInventory.inventory_hash !== preview.control_inventory_hash || before.dev !== preview.temp_dev || before.ino !== preview.temp_ino || before.nlink !== 1 || (before.mode & 0o7777) !== preview.temp_mode || before.uid !== preview.temp_uid || before.gid !== preview.temp_gid) fail("R42_TEMP_DISPOSITION_DRIFT", "temp inode/metadata/inventory relation changed");
    guardState.guard("unlinkat_staged_temp"); fs.unlinkSync(parent.child(path.basename(preview.temp_path)));
    args.afterMutation?.({ syscall: "unlinkat_staged_temp", mutationCount: 1 });
    guardState.guard("fsync_staged_temp_parent"); fs.fsyncSync(parent.fd);
    args.afterMutation?.({ syscall: "fsync_staged_temp_parent", mutationCount: 2 });
    if (lstatMaybe(preview.temp_path)) fail("R42_TEMP_DISPOSITION_READBACK", "temp remains after disposition");
    const post = scanControlInventory(validateStaticContract(args.contract));
    if (post.rows.some((row) => row.path === preview.temp_path) || post.settings_temps.some((row) => row.path === preview.temp_path)) fail("R42_TEMP_DISPOSITION_READBACK", "disposed temp remains in bounded inventory");
    return deepFreeze({ status: "disposed", action: preview.action, operation_advanced: false, coordinate_consumed: false, must_reauthorize_operation: true });
  } finally { parent.close(); }
}

export function verifyTerminalFixture(contractInput, options = {}) {
  const contract = validateStaticContract(contractInput);
  const state = classifyOperation(contract);
  if (!state.operationId || !state.intentFinal || !state.activationFinal || !state.receiptFinal || state.intentPending || state.activationPending || state.receiptPending || state.inventory.rows.some((row) => row.role === "temp") || state.inventory.settings_temps.length !== 0) fail("R42_RUNTIME_TERMINAL", "I/V/R are not sole final-only authority");
  for (const row of [state.intentFinal, state.activationFinal, state.receiptFinal]) if (row.nlink !== 1 || row.mode !== 0o600 || row.uid !== process.getuid?.() || row.gid !== process.getgid?.() || !row.parsed) fail("R42_RUNTIME_AUTHORITY_METADATA", "terminal authority metadata/bytes differ");
  const intent = validateIntentAgainstStatic(loadFinalObject(contract, "intent", state.operationId).value, contract);
  const activation = validateActivationAgainstIntent(loadFinalObject(contract, "activation", state.operationId).value, intent, contract);
  const receipt = validateReceiptAgainstClosure(loadFinalObject(contract, "receipt", state.operationId).value, intent, activation, contract);
  const currentRaw = options.settingsLock
    ? readRetainedSettings(options.settingsLock, path.basename(contract.settings_contract.settings_path)).raw
    : fs.readFileSync(contract.settings_contract.settings_path);
  const current = classifySettingsAgainstTuple(currentRaw, intent.operation_tuple);
  if (!["B", "C"].includes(current.state)) fail("R42_RUNTIME_SETTINGS", "current v2/static/token is not runtime-compatible");
  if (lstatMaybe(contract.rollback_paths.old_activation_root)) fail("R42_RUNTIME_OLD_ACTIVATION", "old activation root must be strictly absent");
  const rollback = lstatMaybe(contract.rollback_paths.rollback_root);
  if (rollback) {
    if (!options.allowMaterializedRollbackRoot || rollback.isSymbolicLink() || !rollback.isDirectory() || (rollback.mode & 0o7777) !== 0o700 || rollback.uid !== process.getuid?.() || rollback.gid !== process.getgid?.() || fs.readdirSync(contract.rollback_paths.rollback_root).length !== 0) fail("R42_RUNTIME_ROLLBACK", "rollback root exists outside the exact rollback mkdir/fsync checkpoint");
  }
  if (lstatMaybe(contract.rollback_paths.quarantine_target)) fail("R42_RUNTIME_QUARANTINE", "quarantine target exists");
  verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
  return deepFreeze({ operation_id: state.operationId, intent, activation, receipt, settings_state: current.state, settings_classification: current, source_commit: intent.source_commit });
}

function verifyProductionTerminal(contract, options = {}) {
  const terminal = verifyTerminalFixture(contract, options);
  const tuple = terminal.intent.operation_tuple;
  const retained = openRetainedTranscript(contract.authorization_transcript_binding);
  try {
    const exactInitial = initialPhrase({
      static_contract_hash: tuple.static_contract_hash,
      source_commit: tuple.source_commit,
      target_session_id: tuple.target_session_binding.session_id,
      preview_transcript_prefix_sha256: tuple.initial_preview_transcript_prefix_sha256,
    });
    retained.verifyRecorded({ coordinate: tuple.initial_authorization_coordinate, exactText: exactInitial });
    const completion = terminal.receipt.completion_authorization;
    if (completion.kind === "initial_execute") {
      retained.verifyRecorded({ coordinate: completion.coordinate, exactText: exactInitial });
    } else if (completion.kind === "fresh_continue") {
      retained.verifyRecorded({ coordinate: completion.coordinate, exactText: continuePhrase({ operation_id: terminal.operation_id, static_contract_hash: tuple.static_contract_hash, source_commit: tuple.source_commit }) });
    } else {
      const witness = terminal.receipt.post_witness;
      const fields = buildAdoptionAuthorizationFields({ intent: terminal.intent, staticContract: contract, currentCRawSha256: witness.current_C_raw_sha256, currentCNonV2JcsHash: witness.current_C_non_v2_jcs_hash, activationAbsent: witness.activation_absent_at_preview });
      retained.verifyRecorded({ coordinate: completion.coordinate, exactText: adoptionPhrase(fields) });
    }
    return terminal;
  } finally { retained.close(); }
}

const processAttempts = new Map();
const consumedAttempts = new Set();
const coordinateAttempt = new Map();
const runtimePreviewBoundaries = new Map();

export function buildRuntimeEnablePreviewFixture(args) {
  const contract = validateStaticContract(args.contract);
  const terminal = verifyTerminalFixture(contract);
  let attempt;
  do { attempt = randomInvocationNonce(); } while (processAttempts.has(attempt));
  const key = runtimeAuditIdempotencyKey({ operation_id: terminal.operation_id, receipt_hash: terminal.receipt.receipt_hash, activation_object_hash: terminal.activation.activation_object_hash, static_contract_hash: terminal.intent.operation_tuple.static_contract_hash, commit_token: terminal.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id });
  const audit = buildRuntimeAuditObject({ idempotency_key: key, operation_id: terminal.operation_id, receipt_hash: terminal.receipt.receipt_hash, activation_object_hash: terminal.activation.activation_object_hash, static_contract_hash: terminal.intent.operation_tuple.static_contract_hash, commit_token: terminal.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id });
  const boundary = args.authorization.boundary?.() ?? { prefix_bytes: 256, prefix_sha256: sha256(`runtime-preview-${attempt}`), latest_line: terminal.receipt.completion_authorization.coordinate.message_line_number };
  runtimePreviewBoundaries.set(attempt, { ...boundary, timestamp: args.authorization.previewTimestamp ?? new Date(0).toISOString() });
  const finalPath = path.join(contract.runtime_audit_paths.runtime_audit_root, `${key}.json`);
  const fields = { attempt_id: attempt, operation_id: terminal.operation_id, receipt_hash: terminal.receipt.receipt_hash, activation_object_hash: terminal.activation.activation_object_hash, static_contract_hash: terminal.intent.operation_tuple.static_contract_hash, commit_token: terminal.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id, source_commit: terminal.source_commit, idempotency_key: key, final_path: finalPath, audit_object_hash: audit.audit_object_hash };
  const base = { schema_version: SCHEMAS.runtime_enable_preview, revision: REVISION, ...fields, preview_transcript_prefix_bytes: boundary.prefix_bytes, preview_transcript_prefix_sha256: boundary.prefix_sha256, action: "durably_materialize_or_confirm_runtime_audit_then_allow_one_first_injection", exact_authorization_phrase: runtimeEnablePhrase(fields), authoritative: false };
  const preview = addSelfHash(base, "preview_hash");
  processAttempts.set(attempt, { preview_hash: preview.preview_hash, issued_at_ms: args.nowMs ?? Date.now() });
  return preview;
}

function bootstrapRuntimeAudit(contract, guard, afterMutation) {
  const audit = contract.runtime_audit_paths;
  const base = openAnchoredDirectory(audit.audit_base, { mode: audit.audit_base_mode, uid: audit.audit_base_uid, gid: audit.audit_base_gid, dev: audit.audit_base_dev });
  const state = { count: 0 };
  const mutate = (name, fn) => { guard(name); const result = fn(); state.count += 1; afterMutation?.({ syscall: name, mutationCount: state.count }); return result; };
  try {
    const parentPath = path.join(audit.audit_base, audit.runtime_audit_parent_relative);
    if (!lstatMaybe(parentPath)) {
      mutate("mkdirat_runtime_audit_parent", () => fs.mkdirSync(base.child(audit.runtime_audit_parent_relative), { mode: 0o700 }));
      mutate("fsync_runtime_audit_base", () => fs.fsyncSync(base.fd));
    } else mutate("fsync_existing_runtime_audit_base", () => fs.fsyncSync(base.fd));
    const parent = openAnchoredDirectory(parentPath, { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.(), dev: audit.audit_base_dev });
    try {
      const names = fs.readdirSync(parentPath).sort(compareUtf8);
      if (names.some((name) => name !== audit.runtime_audit_leaf_relative)) fail("R42_RUNTIME_BOOTSTRAP_EXTRA", "runtime audit parent has extras");
      const rootPath = audit.runtime_audit_root;
      if (!lstatMaybe(rootPath)) {
        mutate("mkdirat_runtime_audit_leaf", () => fs.mkdirSync(parent.child(audit.runtime_audit_leaf_relative), { mode: 0o700 }));
        mutate("fsync_runtime_audit_parent", () => fs.fsyncSync(parent.fd));
      } else mutate("fsync_existing_runtime_audit_parent", () => fs.fsyncSync(parent.fd));
      return { mutationCount: state.count, root: openAnchoredDirectory(rootPath, { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.(), dev: audit.audit_base_dev }) };
    } finally { parent.close(); }
  } finally { base.close(); }
}

export function materializeRuntimeAuditFixture(args) {
  const contract = validateStaticContract(args.contract);
  const preview = validateSelfHash(exactKeys(args.preview, ["schema_version", "revision", "attempt_id", "operation_id", "receipt_hash", "activation_object_hash", "static_contract_hash", "commit_token", "target_session_id", "source_commit", "idempotency_key", "final_path", "audit_object_hash", "preview_transcript_prefix_bytes", "preview_transcript_prefix_sha256", "action", "exact_authorization_phrase", "authoritative", "preview_hash"], "runtime_enable_preview"), "preview_hash", "runtime_enable_preview");
  if (preview.schema_version !== SCHEMAS.runtime_enable_preview || preview.revision !== REVISION || preview.authoritative !== false || preview.action !== "durably_materialize_or_confirm_runtime_audit_then_allow_one_first_injection") fail("R42_RUNTIME_PREVIEW_SCHEMA", "runtime enable preview identity differs");
  const attemptState = processAttempts.get(preview.attempt_id);
  if (consumedAttempts.has(preview.attempt_id) || !attemptState || attemptState.preview_hash !== preview.preview_hash) fail("R42_RUNTIME_ATTEMPT", "attempt is absent, foreign, changed, or consumed");
  const attemptAgeMs = (args.nowMs ?? Date.now()) - attemptState.issued_at_ms;
  if (!Number.isFinite(attemptAgeMs) || attemptAgeMs < 0 || attemptAgeMs > (args.maximumAttemptAgeMs ?? 120_000)) fail("R42_RUNTIME_ATTEMPT_STALE", "runtime attempt is outside the freshness window");
  const settingsLock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
  const verifyTerminal = () => args.terminalVerifier?.({ settingsLock }) ?? verifyTerminalFixture(contract, { settingsLock });
  let decision = "selected_zero_injection";
  try {
    const boundary = runtimePreviewBoundaries.get(preview.attempt_id);
    if (!boundary || boundary.prefix_bytes !== preview.preview_transcript_prefix_bytes || boundary.prefix_sha256 !== preview.preview_transcript_prefix_sha256) fail("R42_RUNTIME_PREVIEW_BOUNDARY", "runtime preview boundary is absent or differs from process-local state");
    const terminalBeforeAuth = verifyTerminal();
    const expectedKey = runtimeAuditIdempotencyKey({ operation_id: terminalBeforeAuth.operation_id, receipt_hash: terminalBeforeAuth.receipt.receipt_hash, activation_object_hash: terminalBeforeAuth.activation.activation_object_hash, static_contract_hash: terminalBeforeAuth.intent.operation_tuple.static_contract_hash, commit_token: terminalBeforeAuth.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id });
    const expectedObject = buildRuntimeAuditObject({ idempotency_key: expectedKey, operation_id: terminalBeforeAuth.operation_id, receipt_hash: terminalBeforeAuth.receipt.receipt_hash, activation_object_hash: terminalBeforeAuth.activation.activation_object_hash, static_contract_hash: terminalBeforeAuth.intent.operation_tuple.static_contract_hash, commit_token: terminalBeforeAuth.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id });
    const expectedFields = { operation_id: terminalBeforeAuth.operation_id, receipt_hash: terminalBeforeAuth.receipt.receipt_hash, activation_object_hash: terminalBeforeAuth.activation.activation_object_hash, static_contract_hash: terminalBeforeAuth.intent.operation_tuple.static_contract_hash, commit_token: terminalBeforeAuth.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id, source_commit: terminalBeforeAuth.source_commit, idempotency_key: expectedKey, final_path: path.join(contract.runtime_audit_paths.runtime_audit_root, `${expectedKey}.json`), audit_object_hash: expectedObject.audit_object_hash };
    for (const [field, expected] of Object.entries(expectedFields)) if (preview[field] !== expected) fail("R42_RUNTIME_CALLER_PREVIEW", `runtime preview.${field} differs from terminal-derived expected value`);
    if (preview.exact_authorization_phrase !== runtimeEnablePhrase({ attempt_id: preview.attempt_id, ...expectedFields })) fail("R42_RUNTIME_CALLER_PREVIEW", "runtime preview phrase was not derived from terminal closure/process attempt");
    const requiredAfter = { line: boundary.latest_line, timestamp: boundary.timestamp, prefix_bytes: boundary.prefix_bytes };
    const coordinate = fixtureAuthorization(args, preview.exact_authorization_phrase, requiredAfter);
    const guardState = createMutationGuard(args, preview.exact_authorization_phrase, requiredAfter);
    const priorAttempt = coordinateAttempt.get(coordinate.coordinate_hash);
    if (priorAttempt && priorAttempt !== preview.attempt_id) fail("R42_RUNTIME_COORDINATE_REUSE", "coordinate is bound to another attempt");
    coordinateAttempt.set(coordinate.coordinate_hash, preview.attempt_id);
    const terminal = verifyTerminal();
    if (terminal.operation_id !== preview.operation_id || terminal.receipt.receipt_hash !== preview.receipt_hash) fail("R42_RUNTIME_PREVIEW_DRIFT", "terminal closure differs from runtime preview");
    const auditObject = buildRuntimeAuditObject({ idempotency_key: preview.idempotency_key, operation_id: preview.operation_id, receipt_hash: preview.receipt_hash, activation_object_hash: preview.activation_object_hash, static_contract_hash: preview.static_contract_hash, commit_token: preview.commit_token, target_session_id: preview.target_session_id });
    if (auditObject.audit_object_hash !== preview.audit_object_hash) fail("R42_RUNTIME_AUDIT_HASH", "runtime audit expected hash differs");
    const bootstrap = bootstrapRuntimeAudit(contract, guardState.guard, args.afterMutation);
    let root = bootstrap.root;
    try {
      const bytes = canonicalObjectBytes(auditObject, "audit_object_hash", { label: "runtime audit" });
      const finalBase = `${preview.idempotency_key}.json`;
      const allowedTemp = new RegExp(`^\\.${preview.idempotency_key}\\.runtime-audit\\.stage\\.[0-9a-f]{32}\\.tmp$`);
      const inventory = root.names();
      if (inventory.length > contract.runtime_audit_paths.max_root_entries || inventory.some((name) => name !== finalBase && !allowedTemp.test(name))) fail("R42_RUNTIME_AUDIT_INVENTORY", "runtime audit root exceeds bounds or contains a foreign key/path");
      const finalPath = root.child(finalBase);
      const existingTemps = inventory.filter((name) => allowedTemp.test(name));
      if (lstatMaybe(finalPath) && existingTemps.length !== 0) {
        if (existingTemps.length !== 1) fail("R42_RUNTIME_AUDIT_TEMP", "multiple runtime audit temps require external incident handling");
        const tempBase = existingTemps[0]; const tempPath = root.child(tempBase); const tempStat = fs.lstatSync(tempPath); const finalStat = fs.lstatSync(finalPath);
        if (tempStat.dev !== finalStat.dev || tempStat.ino !== finalStat.ino || tempStat.nlink !== 2 || finalStat.nlink !== 2) fail("R42_RUNTIME_AUDIT_TEMP_DISPOSITION_REQUIRED", "separate-inode runtime audit temp requires dedicated disposition before a new attempt");
        readAnchoredFile(root, tempBase, { label: "same-inode runtime audit temp", mode: 0o600, nlink: 2, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
        readAnchoredFile(root, finalBase, { label: "same-inode runtime audit final", mode: 0o600, nlink: 2, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
        guardState.guard("unlinkat_same_inode_runtime_audit_temp"); fs.unlinkSync(tempPath);
        guardState.guard("fsync_runtime_audit_root_after_same_inode_temp"); fs.fsyncSync(root.fd);
      }
      if (!lstatMaybe(finalPath)) {
        if (existingTemps.length > 1) fail("R42_RUNTIME_AUDIT_TEMP", "multiple runtime audit temps require external incident handling");
        const tempBase = existingTemps[0] ?? `.${preview.idempotency_key}.runtime-audit.stage.${randomInvocationNonce()}.tmp`;
        const tempPath = root.child(tempBase);
        let fd;
        if (existingTemps.length) {
          const existing = readAnchoredFile(root, tempBase, { label: "existing runtime audit temp", mode: 0o600, nlink: 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
          if (!existing.raw.equals(bytes)) fail("R42_RUNTIME_AUDIT_TEMP", "existing runtime audit temp is not exact expected bytes and requires disposition");
          fd = fs.openSync(tempPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
          guardState.guard("fdatasync_existing_runtime_audit_temp"); fs.fdatasyncSync(fd);
        } else {
          guardState.guard("openat_runtime_audit_temp_create");
          try { fd = fs.openSync(tempPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
          catch (error) { if (error?.code === "EEXIST") fail("R42_RUNTIME_AUDIT_TEMP_EEXIST", "runtime audit temp O_EXCL raced"); throw error; }
          let offset = 0;
          while (offset < bytes.length) { guardState.guard("write_runtime_audit_temp"); const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset); if (written <= 0) fail("R42_RUNTIME_AUDIT_TEMP", "runtime audit write made no progress"); offset += written; }
          guardState.guard("fdatasync_runtime_audit_temp"); fs.fdatasyncSync(fd);
        }
        try {
          if (!readExactFd(fd, bytes.length, "runtime audit temp").equals(bytes)) fail("R42_RUNTIME_AUDIT_TEMP", "runtime audit temp readback differs");
          guardState.guard("linkat_runtime_audit_final");
          try { fs.linkSync(tempPath, finalPath); }
          catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const existingFinal = readAnchoredFile(root, finalBase, { label: "runtime audit EEXIST final", mode: 0o600, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
            const tempStat = fs.fstatSync(fd); const finalStat = fs.lstatSync(finalPath);
            if (!(existingFinal.raw.equals(bytes) && ((finalStat.dev === tempStat.dev && finalStat.ino === tempStat.ino && finalStat.nlink === 2) || (finalStat.nlink === 1 && tempStat.nlink === 1)))) fail("R42_RUNTIME_AUDIT_EEXIST", "runtime audit final EEXIST relation differs");
          }
          guardState.guard("fsync_runtime_audit_root_after_link"); fs.fsyncSync(root.fd);
          guardState.guard("unlinkat_runtime_audit_temp"); fs.unlinkSync(tempPath);
          guardState.guard("fsync_runtime_audit_root_after_unlink"); fs.fsyncSync(root.fd);
        } finally { fs.closeSync(fd); }
      }
      // Validate the retained final inode and exact object before refreshing it.
      // The post-fdatasync fd/path readback rejects a path swap during the guard.
      const preRefreshFinal = readAnchoredFile(root, finalBase, { label: "runtime audit final before refresh", mode: 0o600, nlink: 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
      validateRuntimeAuditObject(parseStrictJson(preRefreshFinal.raw));
      const finalFd = fs.openSync(finalPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        readExactRuntimeAuditFd(root, finalBase, finalFd, bytes, preRefreshFinal.identity, "runtime audit final before fdatasync");
        guardState.guard("fdatasync_runtime_audit_final"); fs.fdatasyncSync(finalFd);
        readExactRuntimeAuditFd(root, finalBase, finalFd, bytes, preRefreshFinal.identity, "runtime audit final after fdatasync");
      } finally { fs.closeSync(finalFd); }
      guardState.guard("fsync_runtime_audit_root_final"); fs.fsyncSync(root.fd);
      args.afterMutation?.({ syscall: "fsync_runtime_audit_root_final", mutationCount: null });
      const final = readAnchoredFile(root, finalBase, { label: "runtime audit final", mode: 0o600, nlink: 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
      validateRuntimeAuditObject(parseStrictJson(final.raw));

      // Complete every decision-time protocol read while the settings lock is
      // retained. No callback or protocol I/O is permitted after sourceLast.
      const prepared = args.prepareInjection?.({ terminal, auditObject, preview });
      args.decisionTimeRevalidate?.();
      const decisionTerminal = verifyTerminal();
      if (decisionTerminal.operation_id !== preview.operation_id || decisionTerminal.receipt.receipt_hash !== preview.receipt_hash || decisionTerminal.activation.activation_object_hash !== preview.activation_object_hash) fail("R42_RUNTIME_PREVIEW_DRIFT", "decision-time terminal closure differs from runtime preview");
      args.revalidatePrepared?.(prepared, { terminal: decisionTerminal, auditObject, preview });
      const decisionFinal = readAnchoredFile(root, finalBase, { label: "decision-time runtime audit final", mode: 0o600, nlink: 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw: bytes, strictJson: true });
      validateRuntimeAuditObject(parseStrictJson(decisionFinal.raw));

      const decisionAttempt = processAttempts.get(preview.attempt_id);
      const decisionAttemptAgeMs = (args.nowMs ?? Date.now()) - (decisionAttempt?.issued_at_ms ?? Number.NaN);
      if (consumedAttempts.has(preview.attempt_id) || !decisionAttempt || decisionAttempt.preview_hash !== preview.preview_hash) fail("R42_RUNTIME_ATTEMPT", "decision-time attempt is absent, foreign, changed, or consumed");
      if (!Number.isFinite(decisionAttemptAgeMs) || decisionAttemptAgeMs < 0 || decisionAttemptAgeMs > (args.maximumAttemptAgeMs ?? 120_000)) fail("R42_RUNTIME_ATTEMPT_STALE", "decision-time runtime attempt is outside the freshness window");
      const decisionBoundary = runtimePreviewBoundaries.get(preview.attempt_id);
      if (!decisionBoundary || decisionBoundary.prefix_bytes !== preview.preview_transcript_prefix_bytes || decisionBoundary.prefix_sha256 !== preview.preview_transcript_prefix_sha256) fail("R42_RUNTIME_PREVIEW_BOUNDARY", "decision-time runtime preview boundary differs");
      if (coordinateAttempt.get(coordinate.coordinate_hash) !== preview.attempt_id) fail("R42_RUNTIME_COORDINATE_REUSE", "decision-time coordinate/attempt binding differs");

      const allowed = deepFreeze({ status: "allow_one_first_injection_decision", attempt_id: preview.attempt_id, audit_object_hash: auditObject.audit_object_hash, audit_final_path: preview.final_path, attempt_persisted: false, injection_performed: false, ...(prepared === undefined ? {} : { prepared }) });
      root.close();
      root = null;
      const beforeFinalSource = guardState.beforeSource("decision_time_revalidation");
      if (beforeFinalSource.coordinate.coordinate_hash !== coordinate.coordinate_hash) fail("R42_RUNTIME_COORDINATE_REUSE", "decision-time authorization coordinate differs from the attempt-bound coordinate");
      guardState.sourceLast(beforeFinalSource);
      decision = "allow_one_first_injection_decision";
      return allowed;
    } finally { root?.close(); }
  } finally {
    settingsLock.close();
    consumedAttempts.add(preview.attempt_id);
    if (decision !== "allow_one_first_injection_decision") args.onSelectedZero?.();
  }
}

const runtimeFixtureStates = new Map();
const runtimeProductionStates = new Map();

function runtimeProductionStateKey(contract, operationIdInput) { return `${contract.control_paths.control_root}\0${operationIdInput}`; }

export function runtimeEnableFixture(args, options = {}) {
  const contract = validateStaticContract(args.contract);
  const terminal = verifyTerminalFixture(contract);
  const key = runtimeProductionStateKey(contract, terminal.operation_id);
  const existing = runtimeFixtureStates.get(key);
  if (!existing) {
    const preview = buildRuntimeEnablePreviewFixture(args);
    runtimeFixtureStates.set(key, { preview, receipt_hash: terminal.receipt.receipt_hash, activation_object_hash: terminal.activation.activation_object_hash });
    return deepFreeze({ status: "runtime_enable_authorization_required", decision: "selected_zero_injection", preview, exact_authorization_phrase: preview.exact_authorization_phrase, injection_performed: false });
  }
  if (existing.receipt_hash !== terminal.receipt.receipt_hash || existing.activation_object_hash !== terminal.activation.activation_object_hash) {
    runtimeFixtureStates.delete(key);
    fail("R42_RUNTIME_PREVIEW_DRIFT", "terminal closure changed between same-process runtime turns");
  }
  try {
    return materializeRuntimeAuditFixture({ ...args, preview: existing.preview, prepareInjection: options.prepareInjection, revalidatePrepared: options.revalidatePrepared, decisionTimeRevalidate: options.decisionTimeRevalidate });
  } finally { runtimeFixtureStates.delete(key); }
}

export function buildRuntimeEnablePreviewProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value); const terminal = verifyProductionTerminal(contract);
  sourceGuard(repoRoot, terminal.source_commit, bundle); verifySessionPrefix(contract.target_session_binding); verifySessionPrefix(contract.authorization_transcript_binding);
  const key = runtimeProductionStateKey(contract, terminal.operation_id); const existing = runtimeProductionStates.get(key);
  if (existing) {
    if (existing.preview.receipt_hash === terminal.receipt.receipt_hash && existing.preview.activation_object_hash === terminal.activation.activation_object_hash && existing.preview.source_commit === terminal.source_commit) return existing.preview;
    existing.retained.close(); runtimeProductionStates.delete(key);
  }
  const retained = openRetainedTranscript(contract.authorization_transcript_binding); const boundary = retained.boundary();
  const authorization = { boundary: () => boundary, previewTimestamp: boundary.timestamp };
  try {
    const preview = buildRuntimeEnablePreviewFixture({ contract, authorization });
    runtimeProductionStates.set(key, { repoRoot, bundle, contract, terminal, retained, boundary, preview });
    return preview;
  } catch (error) { retained.close(); throw error; }
}

export function runtimeEnableProduction(repoRootInput, options = {}) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value); const terminal = verifyProductionTerminal(contract);
  const key = runtimeProductionStateKey(contract, terminal.operation_id); let state = runtimeProductionStates.get(key);
  if (!state) {
    const preview = buildRuntimeEnablePreviewProduction(repoRoot);
    return deepFreeze({ status: "runtime_enable_authorization_required", decision: "selected_zero_injection", preview, injection_performed: false });
  }
  if (state.repoRoot !== repoRoot || state.preview.receipt_hash !== terminal.receipt.receipt_hash || state.preview.activation_object_hash !== terminal.activation.activation_object_hash || state.preview.source_commit !== terminal.source_commit) {
    state.retained.close(); runtimeProductionStates.delete(key);
    const preview = buildRuntimeEnablePreviewProduction(repoRoot);
    return deepFreeze({ status: "runtime_terminal_drift_repreview_required", decision: "selected_zero_injection", preview, injection_performed: false });
  }
  const requiredAfter = { line: state.boundary.latest_line, timestamp: state.boundary.timestamp, prefix_bytes: state.boundary.prefix_bytes };
  let coordinate;
  try {
    coordinate = state.retained.verifyLatestExact({ exactText: state.preview.exact_authorization_phrase, maximumAgeMs: 7_200_000, requiredAfter });
  }
  catch (error) { return deepFreeze({ status: "runtime_enable_authorization_required", decision: "selected_zero_injection", reason: error.code ?? "R42_RUNTIME_AUTH_REQUIRED", preview: state.preview, injection_performed: false }); }
  sourceGuard(repoRoot, terminal.source_commit, bundle); verifyProductionTerminal(contract);
  const mutations = createInvocationMutationTracker(); mutations.bindOperationId(terminal.operation_id); mutations.bindCoordinateHash(coordinate.coordinate_hash);
  const args = makeProductionMutationArgs({ repoRoot, bundle, retained: state.retained, exactText: state.preview.exact_authorization_phrase, requiredAfter, coordinate, sourceCommit: terminal.source_commit, afterMutation: mutations.afterMutation });
  try {
    return materializeRuntimeAuditFixture({ ...args, contract, preview: state.preview, terminalVerifier: ({ settingsLock }) => verifyProductionTerminal(contract, { settingsLock }), prepareInjection: options.prepareInjection, revalidatePrepared: options.revalidatePrepared, decisionTimeRevalidate() { options.beforeDecisionTimeRevalidate?.(); } });
  } catch (error) { mutations.attach(error); throw error; }
  finally { state.retained.close(); runtimeProductionStates.delete(key); }
}

export function previewRuntimeAuditTempDispositionFixture(args) {
  const contract = validateStaticContract(args.contract);
  const root = contract.runtime_audit_paths.runtime_audit_root;
  const names = fs.readdirSync(root).filter((name) => /^\.[0-9a-f]{64}\.runtime-audit\.stage\.[0-9a-f]{32}\.tmp$/.test(name)).sort(compareUtf8);
  if (names.length !== 1) fail("R42_RUNTIME_TEMP_COUNT", "one runtime audit temp is required");
  const tempPath = path.join(root, names[0]);
  const stat = fs.lstatSync(tempPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail("R42_RUNTIME_TEMP_METADATA", "runtime audit disposition temp must be a nlink-1 regular non-symlink file");
  const terminal = verifyTerminalFixture(contract);
  const key = runtimeAuditIdempotencyKey({ operation_id: terminal.operation_id, receipt_hash: terminal.receipt.receipt_hash, activation_object_hash: terminal.activation.activation_object_hash, static_contract_hash: terminal.intent.operation_tuple.static_contract_hash, commit_token: terminal.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id });
  if (names[0].slice(1, 65) !== key) fail("R42_RUNTIME_TEMP_KEY", "runtime audit temp key differs from terminal-derived idempotency key");
  const expected = buildRuntimeAuditObject({ idempotency_key: key, operation_id: terminal.operation_id, receipt_hash: terminal.receipt.receipt_hash, activation_object_hash: terminal.activation.activation_object_hash, static_contract_hash: terminal.intent.operation_tuple.static_contract_hash, commit_token: terminal.intent.operation_tuple.commit_token, target_session_id: contract.target_session_binding.session_id });
  const expectedRaw = canonicalObjectBytes(expected, "audit_object_hash", { label: "runtime audit" });
  const finalPath = path.join(root, `${key}.json`); const finalStat = lstatMaybe(finalPath);
  if (finalStat) {
    const parent = openAnchoredDirectory(root, { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.() });
    try { readAnchoredFile(parent, `${key}.json`, { label: "runtime audit final", mode: 0o600, nlink: 1, uid: process.getuid?.(), gid: process.getgid?.(), expectedRaw, strictJson: true }); }
    finally { parent.close(); }
    if (finalStat.dev === stat.dev && finalStat.ino === stat.ino) fail("R42_RUNTIME_TEMP_RELATION", "runtime temp disposition cannot unlink the final inode");
  }
  let descriptor;
  try { descriptor = sha256(fs.readFileSync(tempPath)); }
  catch (error) { descriptor = error?.code === "EACCES" ? "unreadable_eacces" : error?.code === "EIO" ? "unreadable_eio" : "unreadable_changed_during_read"; }
  const fields = { idempotency_key: key, temp_path: tempPath, temp_dev: stat.dev, temp_ino: stat.ino, temp_raw_sha256_or_unreadable_reason: descriptor, temp_size: stat.size, temp_mode: stat.mode & 0o7777, temp_uid: stat.uid, temp_gid: stat.gid, temp_nlink: stat.nlink, final_relation: finalStat ? "exact_expected_separate_inode" : "absent", static_contract_hash: terminal.intent.operation_tuple.static_contract_hash, receipt_hash: terminal.receipt.receipt_hash, source_commit: terminal.source_commit, target_session_id: contract.target_session_binding.session_id };
  const base = { schema_version: SCHEMAS.runtime_audit_temp_disposition_preview, revision: REVISION, ...fields, action: "unlink_runtime_audit_temp", exact_authorization_phrase: runtimeAuditTempDispositionPhrase(fields), authoritative: false };
  return addSelfHash(base, "preview_hash");
}

export function disposeRuntimeAuditTempFixture(args) {
  const preview = previewRuntimeAuditTempDispositionFixture(args);
  fixtureAuthorization(args, preview.exact_authorization_phrase, args.requiredAfter ?? null);
  const guard = createMutationGuard(args, preview.exact_authorization_phrase, args.requiredAfter ?? null);
  const root = openAnchoredDirectory(path.dirname(preview.temp_path), { mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.() });
  try {
    const stat = fs.lstatSync(preview.temp_path);
    let descriptor;
    try { descriptor = sha256(fs.readFileSync(preview.temp_path)); }
    catch (error) { descriptor = error?.code === "EACCES" ? "unreadable_eacces" : error?.code === "EIO" ? "unreadable_eio" : "unreadable_changed_during_read"; }
    if (stat.dev !== preview.temp_dev || stat.ino !== preview.temp_ino || stat.nlink !== 1 || stat.size !== preview.temp_size || (stat.mode & 0o7777) !== preview.temp_mode || stat.uid !== preview.temp_uid || stat.gid !== preview.temp_gid || descriptor !== preview.temp_raw_sha256_or_unreadable_reason) fail("R42_RUNTIME_TEMP_DRIFT", "runtime temp identity/metadata/raw descriptor differs");
    const revalidated = previewRuntimeAuditTempDispositionFixture(args);
    if (revalidated.preview_hash !== preview.preview_hash) fail("R42_RUNTIME_TEMP_DRIFT", "runtime temp disposition preview changed before unlink");
    guard.guard("unlinkat_runtime_audit_disposition_temp"); fs.unlinkSync(preview.temp_path); args.afterMutation?.({ syscall: "unlinkat_runtime_audit_disposition_temp", mutationCount: 1 });
    guard.guard("fsync_runtime_audit_disposition_root"); fs.fsyncSync(root.fd); args.afterMutation?.({ syscall: "fsync_runtime_audit_disposition_root", mutationCount: 2 });
    if (lstatMaybe(preview.temp_path)) fail("R42_RUNTIME_TEMP_READBACK", "runtime audit temp remains after disposition");
    return deepFreeze({ status: "disposed", injection_performed: false, requires_new_runtime_attempt: true });
  } finally { root.close(); }
}

export function previewRuntimeAuditTempDispositionProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value);
  const preview = previewRuntimeAuditTempDispositionFixture({ contract }); sourceGuard(repoRoot, preview.source_commit, bundle); return preview;
}

export function disposeRuntimeAuditTempProduction(repoRootInput) {
  const repoRoot = path.resolve(repoRootInput); const bundle = loadAndValidateStaticBundle(repoRoot); const contract = assertProductionContract(bundle.contract.value); const preview = previewRuntimeAuditTempDispositionProduction(repoRoot);
  const terminal = verifyProductionTerminal(contract); const retained = openRetainedTranscript(contract.authorization_transcript_binding); const mutations = createInvocationMutationTracker(); mutations.bindOperationId(terminal.operation_id);
  try {
    const completion = terminal.receipt.completion_authorization.coordinate;
    const requiredAfter = progressRequiredAfter(completion, { inventory: { rows: [{ path: preview.temp_path }, { path: path.join(contract.runtime_audit_paths.runtime_audit_root, `${preview.idempotency_key}.json`) }], settings_temps: [] } }, null);
    const coordinate = retained.verifyLatestExact({ exactText: preview.exact_authorization_phrase, maximumAgeMs: 7_200_000, requiredAfter }); mutations.bindCoordinateHash(coordinate.coordinate_hash);
    const args = makeProductionMutationArgs({ repoRoot, bundle, retained, exactText: preview.exact_authorization_phrase, requiredAfter, coordinate, sourceCommit: terminal.source_commit, afterMutation: mutations.afterMutation });
    return disposeRuntimeAuditTempFixture({ ...args, contract, requiredAfter });
  } catch (error) { mutations.attach(error); throw error; }
  finally { retained.close(); }
}

export function evaluateRollbackGate({ contract: contractInput, activation, rollbackAuthorization, productionTargetAuthorization }) {
  const contract = validateStaticContract(contractInput);
  validateActivation(activation);
  const rollback = validateSelfHash(exactKeys(rollbackAuthorization, ["schema_version", "revision", "operation_id", "activation_object_hash", "static_contract_hash", "commit_token", "rollback_face", "state_root", "authorization_hash"], "rollback_authorization"), "authorization_hash", "rollback_authorization");
  const target = validateSelfHash(exactKeys(productionTargetAuthorization, ["schema_version", "revision", "operation_id", "settings_path", "target_session_path", "quarantine_target", "rollback_root", "control_root", "authorization_hash"], "production_target_authorization"), "authorization_hash", "production_target_authorization");
  const valid = rollback.schema_version === SCHEMAS.rollback_authorization
    && target.schema_version === SCHEMAS.production_target_authorization
    && rollback.revision === REVISION && target.revision === REVISION
    && rollback.operation_id === activation.operation_id && target.operation_id === activation.operation_id
    && rollback.activation_object_hash === activation.activation_object_hash
    && rollback.static_contract_hash === activation.static_contract_hash
    && rollback.commit_token === activation.commit_token
    && rollback.rollback_face === "heavy"
    && rollback.state_root === activation.rollback_target
    && activation.rollback_target === activation.activation_hash_inputs.rollback_target
    && activation.rollback_target === contract.rollback_paths.rollback_root
    && activation.quarantine_target === contract.rollback_paths.quarantine_target
    && activation.session_file.path === contract.target_session_binding.session_file.path
    && target.settings_path === contract.settings_contract.settings_path
    && target.target_session_path === activation.session_file.path
    && target.quarantine_target === activation.quarantine_target
    && target.rollback_root === activation.rollback_target
    && target.control_root === contract.control_paths.control_root;
  return deepFreeze({ authorized: valid, three_independent_gates_required: true, rollback_root_absent: lstatMaybe(contract.rollback_paths.rollback_root) === null, materialization_allowed: valid && lstatMaybe(contract.rollback_paths.rollback_root) === null });
}

export function materializeRollbackFixture(args) {
  if (args.rollbackPhrase !== undefined) fail("R42_ROLLBACK_PHRASE_SUBSTITUTION", "a transcript phrase cannot replace the three independent rollback authorization objects");
  const contract = validateStaticContract(args.contract);
  assertFixtureRoot(args.fixtureRoot, [contract.rollback_paths.rollback_root]);
  const lock = acquireRetainedSettingsLock(contract.settings_contract.settings_path);
  const parent = openAnchoredDirectory(path.dirname(contract.rollback_paths.rollback_root));
  let mutationCount = 0;
  const revalidate = (syscall, allowMaterializedRoot) => {
    const terminal = verifyTerminalFixture(contract, { allowMaterializedRollbackRoot: allowMaterializedRoot, settingsLock: lock });
    if (canonicalizeJcs(terminal.activation) !== canonicalizeJcs(args.activation)) fail("R42_ROLLBACK_GATE", "caller activation is not the sole terminal activation");
    const gate = evaluateRollbackGate({ contract, activation: terminal.activation, rollbackAuthorization: args.rollbackAuthorization, productionTargetAuthorization: args.productionTargetAuthorization });
    if (!gate.authorized || (!allowMaterializedRoot && !gate.materialization_allowed)) fail("R42_ROLLBACK_GATE", "rollback three-gate materialization predicate failed");
    if (args.sourceGuard?.({ syscall, call: mutationCount + 1, sourceCommit: terminal.source_commit }) !== true) fail("R42_FIXTURE_SOURCE_GUARD", `${syscall} rollback source guard failed`);
    args.targetGuard?.({ syscall, call: mutationCount + 1 });
  };
  try {
    revalidate("mkdirat_rollback_root", false);
    try { fs.mkdirSync(parent.child(path.basename(contract.rollback_paths.rollback_root)), { mode: 0o700 }); }
    catch (error) { if (error?.code === "EEXIST") fail("R42_ROLLBACK_EEXIST", "rollback mkdir EEXIST is never idempotent success"); throw error; }
    mutationCount += 1; args.afterMutation?.({ syscall: "mkdirat_rollback_root", mutationCount });
    revalidate("fsync_rollback_parent", true);
    fs.fsyncSync(parent.fd); mutationCount += 1; args.afterMutation?.({ syscall: "fsync_rollback_parent", mutationCount });
    revalidate("rollback_materialization_readback", true);
    return deepFreeze({ status: "rollback_root_materialized", rollback_executed: false, selector_disabled: false, quarantine_performed: false });
  } finally { parent.close(); lock.close(); }
}

export function buildPostDossierFixture(contractInput) {
  const contract = validateStaticContract(contractInput);
  const terminal = verifyTerminalFixture(contract);
  const tuple = terminal.intent.operation_tuple;
  const base = {
    schema_version: SCHEMAS.post_dossier,
    revision: REVISION,
    static_contract_hash: tuple.static_contract_hash,
    operation_id: terminal.operation_id,
    intent_hash: terminal.intent.intent_hash,
    activation_object_hash: terminal.activation.activation_object_hash,
    receipt_hash: terminal.receipt.receipt_hash,
    prestate_A_identity: tuple.prestate_A.full_identity,
    prestate_A_raw_sha256: tuple.prestate_A.raw_sha256,
    expected_B_raw_sha256: tuple.expected_B_raw_sha256,
    commit_token: tuple.commit_token,
    receipt_mode: terminal.receipt.mode,
    post_witness: terminal.receipt.post_witness,
    source_closure: { source_commit: tuple.source_commit, source_manifest_hash: tuple.source_manifest_hash, source_closure_hash: tuple.source_closure_hash },
    session_authorization_closure: { target_session_binding: tuple.target_session_binding, authorization_transcript_binding: tuple.authorization_transcript_binding, initial_coordinate_hash: tuple.initial_coordinate_hash, completion_coordinate_hash: terminal.receipt.completion_authorization.coordinate_hash },
    publication_recovery_history: { durable_facts_only: true, intent: "final_only", activation: "final_only", receipt: "final_only", recovery_gate_use_count_not_claimed: true },
    residuals: contract.residuals,
    completion_state: "completed",
  };
  return addSelfHash(base, "dossier_hash");
}
