import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import {
  buildStableViewReceipts,
  evaluatePropositionPolicyStableView,
  stableViewCanonicalizeJcs,
  stableViewSha256Hex,
  validateStableArtifactSet,
  validateStableNonViewDocument,
  validateStableViewCompileProfile,
  type StableArtifactSet,
} from "./proposition-policy-stable-view.ts";

export const PROPOSITION_POLICY_STABLE_VIEW_PREVIEW_HELPER_SCHEMA = "proposition-policy-stable-view-confined-preview-result/v1" as const;

const SANDBOX_ROOT = "/run/pi-astack";
const INPUT_ROOT = `${SANDBOX_ROOT}/input`;
const WORK_ROOT = `${SANDBOX_ROOT}/work`;
const REPOSITORY_ROOT = `${SANDBOX_ROOT}/repo`;
const ABRAIN_ROOT = `${SANDBOX_ROOT}/abrain`;
const OUTPUT_ROOT = `${WORK_ROOT}/output`;
const STAGING_ROOT = `${WORK_ROOT}/staging`;
const STABLE_DIRECTORY = "stable-artifacts";
const RECEIPT_DIRECTORY = "receipts";
const STABLE_NAMES = Object.freeze(["view.json", "view.md", "diagnostics.json", "parity.json", "manifest.json"] as const);
const JSON_RECEIPT_NAMES = Object.freeze(["request-receipt.json", "outcome-receipt.json", "observation.json"] as const);
const EXPECTED_ENVIRONMENT_KEYS = Object.freeze(["HOME", "PATH", "PWD", "TMPDIR"] as const);
const CREDENTIAL_KEY_PATTERN = /(api.?key|token|secret|password|credential|authorization|cookie|provider)/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class PropositionPolicyStableViewPreviewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyStableViewPreviewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function runConfinedStableViewPreview(options: {
  expected_source_bundle_hash: string;
  requested_at_utc: string;
}): Promise<Readonly<Record<string, unknown>>> {
  assertSandboxPaths();
  const executionStartedAt = new Date().toISOString();
  assertHash(options.expected_source_bundle_hash, "expected_source_bundle_hash");
  const environmentKeys = Object.keys(process.env).sort(compareCodeUnits);
  if (stableViewCanonicalizeJcs(environmentKeys) !== stableViewCanonicalizeJcs(EXPECTED_ENVIRONMENT_KEYS)) {
    fail("sandbox_environment_invalid", "sandbox environment contains unexpected keys", { environmentKeys });
  }
  if (process.env.PWD !== WORK_ROOT) fail("sandbox_working_directory_invalid", "sandbox-generated PWD differs from the private work mount", { pwd: process.env.PWD });
  if (environmentKeys.some((key) => CREDENTIAL_KEY_PATTERN.test(key))) fail("sandbox_credentials_present", "credential-shaped environment key reached the sandbox");
  const profileRaw = readRegularInput("profile.json");
  const entriesRaw = readRegularInput("entries.json");
  const exclusionsRaw = readRegularInput("exclusions.json");
  const diagnosticsRaw = readRegularInput("diagnostics.json");
  const manifestRaw = readRegularInput("source-manifest.json");
  const profile = validateStableViewCompileProfile(parseCanonicalJson(profileRaw, "profile.json"));
  const entries = parseCanonicalJson(entriesRaw, "entries.json") as Record<string, unknown>;
  const exclusions = parseCanonicalJson(exclusionsRaw, "exclusions.json") as Record<string, unknown>;
  const diagnostics = parseCanonicalJson(diagnosticsRaw, "diagnostics.json") as Record<string, unknown>;
  const sourceManifest = parseCanonicalJson(manifestRaw, "source-manifest.json") as Record<string, unknown>;
  validateBoundP2aSource({
    expectedSourceBundleHash: options.expected_source_bundle_hash,
    sourceManifest,
    artifactBytes: { "entries.json": entriesRaw, "exclusions.json": exclusionsRaw, "diagnostics.json": diagnosticsRaw },
    entries,
    exclusions,
    diagnostics,
  });

  const request = deepFreeze({
    source_bundle_hash: options.expected_source_bundle_hash,
    source: { entries, exclusions, diagnostics, manifest: sourceManifest },
    compile_profile: profile,
    mode: "real" as const,
  });
  const evaluation = evaluatePropositionPolicyStableView(request);
  if (evaluation.pipeline !== "completed" || evaluation.outcome_code !== "ready_empty" || !evaluation.artifacts) {
    fail("real_preview_not_ready_empty", "bound real source did not compile to ready_empty", { pipeline: evaluation.pipeline, outcome_code: evaluation.outcome_code });
  }
  validateStableArtifactSet(request, evaluation.artifacts);
  validateStableNonViewDocument("diagnostics", JSON.parse(evaluation.artifacts["diagnostics.json"]));
  validateStableNonViewDocument("parity", JSON.parse(evaluation.artifacts["parity.json"]));
  validateStableNonViewDocument("manifest", JSON.parse(evaluation.artifacts["manifest.json"]));
  const network = await probeNetworkDenied();
  const readOnly = {
    repository: probeWriteDenied(`${REPOSITORY_ROOT}/.adr0040-p2b1-write-probe`),
    abrain: probeWriteDenied(`${ABRAIN_ROOT}/.adr0040-p2b1-write-probe`),
  };
  const artifactRows = materializeAllFiveOrNone(evaluation.artifacts);
  const capabilities = effectiveCapabilities();
  if (capabilities !== "0000000000000000") fail("sandbox_capabilities_not_zero", "effective capabilities are nonzero", { capabilities });
  const namespaceIdentities = captureNamespaceIdentities();
  const view = JSON.parse(evaluation.artifacts["view.json"]) as Record<string, unknown>;
  const viewItems = Array.isArray(view.items) ? view.items : [];
  if (view.result_kind !== "ready_empty" || viewItems.length !== 0 || view.injectable_payload_utf8_bytes !== 0 || evaluation.artifacts["view.md"] !== "") {
    fail("real_preview_empty_contract_invalid", "ready_empty artifact carries an item or payload byte");
  }
  const completedAt = new Date().toISOString();
  const observedAt = new Date().toISOString();
  const receipts = buildStableViewReceipts(evaluation, {
    requested_at_utc: options.requested_at_utc,
    completed_at_utc: completedAt,
    observed_at_utc: observedAt,
  });
  validateStableNonViewDocument("request_receipt", receipts.request_receipt);
  validateStableNonViewDocument("outcome_receipt", receipts.outcome_receipt);
  validateStableNonViewDocument("observation", receipts.observation);
  const receiptRows = materializeReceipts(receipts);
  const receiptDocuments = preserveReceiptDocuments(receipts);
  const outputInventory = inventoryOutput();
  const timestampOrderValid = Date.parse(options.requested_at_utc) <= Date.parse(executionStartedAt)
    && Date.parse(executionStartedAt) <= Date.parse(completedAt) && Date.parse(completedAt) <= Date.parse(observedAt);
  if (!timestampOrderValid) fail("execution_timestamp_order_invalid", "execution and receipt timestamps are not monotonically ordered");
  const result = deepFreeze({
    schema_version: PROPOSITION_POLICY_STABLE_VIEW_PREVIEW_HELPER_SCHEMA,
    confinement: {
      environment_keys: environmentKeys,
      credential_shaped_environment_keys: environmentKeys.filter((key) => CREDENTIAL_KEY_PATTERN.test(key)),
      effective_capabilities_hex: capabilities,
      namespace_identities: namespaceIdentities,
      network,
      read_only: readOnly,
      writable_surface: WORK_ROOT,
    },
    source: {
      bundle_hash: options.expected_source_bundle_hash,
      candidate_entries: (entries.entries as unknown[]).length,
      exclusions: (exclusions.exclusions as unknown[]).length,
      diagnostics: (diagnostics.diagnostics as unknown[]).length,
      artifact_rows: [
        row("diagnostics.json", diagnosticsRaw),
        row("entries.json", entriesRaw),
        row("exclusions.json", exclusionsRaw),
        row("manifest.json", manifestRaw),
      ],
    },
    compile: {
      profile_hash: profile.profile_hash,
      decision_identity: evaluation.decision_identity,
      compile_key: evaluation.compile_key,
      manifest_hash: evaluation.manifest_hash,
      result_kind: evaluation.outcome_code,
      item_count: viewItems.length,
      injectable_payload_utf8_bytes: view.injectable_payload_utf8_bytes,
      artifact_rows: artifactRows,
      all_five_or_none: artifactRows.length === 5,
      non_view_closed_vocabulary_valid: true,
    },
    receipts: {
      request_id: evaluation.request_id,
      request_receipt_hash: receipts.request_receipt.receipt_hash,
      outcome_receipt_hash: receipts.outcome_receipt.receipt_hash,
      pipeline_tuple: {
        pipeline: receipts.observation.pipeline,
        freshness: receipts.observation.freshness,
        selection: receipts.observation.selection,
        health: receipts.observation.health,
      },
      injection_authority: receipts.observation.injection_authority,
      documents: receiptDocuments,
      rows: receiptRows,
    },
    execution_ordering: {
      requested_at_utc: options.requested_at_utc,
      execution_started_at_utc: executionStartedAt,
      completed_at_utc: completedAt,
      observed_at_utc: observedAt,
      stage_sequence: ["request_received", "source_validated", "compile_completed", "artifacts_validated", "confinement_probes_completed", "stable_artifacts_materialized", "completed_at_set", "observed_at_set", "receipts_materialized"],
      completed_at_set_after_execution: true,
      completed_at_set_after_artifact_validation: true,
      completed_at_set_after_confinement_probes: true,
      timestamp_order_valid: timestampOrderValid,
    },
    output_inventory: outputInventory,
  });
  return result;
}

function validateBoundP2aSource(options: {
  expectedSourceBundleHash: string;
  sourceManifest: Record<string, unknown>;
  artifactBytes: Record<"entries.json" | "exclusions.json" | "diagnostics.json", string>;
  entries: Record<string, unknown>;
  exclusions: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}): void {
  const manifest = options.sourceManifest;
  if (manifest.schema_version !== "proposition-policy-push-shadow-manifest/v2"
    || manifest.bundle_hash !== options.expectedSourceBundleHash
    || manifest.authority !== "shadow_push_only_no_runtime_consumer") {
    fail("p2a_manifest_identity_invalid", "published source manifest identity is invalid");
  }
  const result = asRecord(manifest.result, "source_manifest.result");
  if (result.entry_count !== 0 || result.exclusion_count !== 1 || result.diagnostic_count !== 1) fail("p2a_source_count_invalid", "published source is not exact 0/1/1", { result });
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 3) fail("p2a_artifact_rows_invalid", "published manifest artifact rows are invalid");
  for (const [name, raw] of Object.entries(options.artifactBytes)) {
    const artifact = (manifest.artifacts as Array<Record<string, unknown>>).find((candidate) => candidate.name === name);
    if (!artifact || artifact.bytes !== Buffer.byteLength(raw) || artifact.sha256 !== stableViewSha256Hex(raw)) fail("p2a_artifact_hash_invalid", "published source artifact bytes differ from manifest", { name });
  }
  const entries = options.entries.entries;
  const exclusions = options.exclusions.exclusions;
  const diagnostics = options.diagnostics.diagnostics;
  if (!Array.isArray(entries) || entries.length !== 0 || !Array.isArray(exclusions) || exclusions.length !== 1 || !Array.isArray(diagnostics) || diagnostics.length !== 1) fail("p2a_document_count_invalid", "published source documents are not exact 0/1/1");
  const exclusion = asRecord(exclusions[0], "source.exclusions[0]");
  const diagnostic = asRecord(diagnostics[0], "source.diagnostics[0]");
  if (exclusion.source_event_id !== diagnostic.source_event_id
    || exclusion.filter_stage !== diagnostic.filter_stage
    || exclusion.reason_code !== diagnostic.reason_code
    || diagnostic.code !== "POLICY_CANDIDATE_EXCLUDED"
    || diagnostic.severity !== "info") fail("p2a_diagnostic_conservation_invalid", "source exclusion and diagnostic do not exactly match");
}

function materializeAllFiveOrNone(artifacts: StableArtifactSet): readonly Readonly<Record<string, unknown>>[] {
  removeIfPresent(STAGING_ROOT);
  removeIfPresent(path.join(OUTPUT_ROOT, STABLE_DIRECTORY));
  fs.mkdirSync(STAGING_ROOT, { recursive: false, mode: 0o700 });
  try {
    for (const name of STABLE_NAMES) writeExclusive(path.join(STAGING_ROOT, name), artifacts[name]);
    const names = fs.readdirSync(STAGING_ROOT).sort(compareCodeUnits);
    if (stableViewCanonicalizeJcs(names) !== stableViewCanonicalizeJcs([...STABLE_NAMES].sort(compareCodeUnits))) fail("partial_stable_artifact_set", "staging does not contain all five exact artifacts", { names });
    fs.renameSync(STAGING_ROOT, path.join(OUTPUT_ROOT, STABLE_DIRECTORY));
  } catch (error) {
    removeIfPresent(STAGING_ROOT);
    removeIfPresent(path.join(OUTPUT_ROOT, STABLE_DIRECTORY));
    throw error;
  }
  return STABLE_NAMES.map((name) => row(name, artifacts[name]));
}

function materializeReceipts(receipts: Readonly<{ request_receipt: Readonly<Record<string, unknown>>; outcome_receipt: Readonly<Record<string, unknown>>; observation: Readonly<Record<string, unknown>> }>): readonly Readonly<Record<string, unknown>>[] {
  const directory = path.join(OUTPUT_ROOT, RECEIPT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const bytes = {
    "request-receipt.json": `${stableViewCanonicalizeJcs(receipts.request_receipt)}\n`,
    "outcome-receipt.json": `${stableViewCanonicalizeJcs(receipts.outcome_receipt)}\n`,
    "observation.json": `${stableViewCanonicalizeJcs(receipts.observation)}\n`,
  } as const;
  for (const name of JSON_RECEIPT_NAMES) writeExclusive(path.join(directory, name), bytes[name]);
  return JSON_RECEIPT_NAMES.map((name) => row(name, bytes[name]));
}

function preserveReceiptDocuments(receipts: Readonly<{ request_receipt: Readonly<Record<string, unknown>>; outcome_receipt: Readonly<Record<string, unknown>>; observation: Readonly<Record<string, unknown>> }>): Readonly<Record<string, unknown>> {
  const selfHashed = (name: string, value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
    const canonicalObject = deepClone(value);
    const preimageObject = { ...canonicalObject };
    const selfHash = preimageObject.receipt_hash;
    delete preimageObject.receipt_hash;
    const preimageBytes = stableViewCanonicalizeJcs(preimageObject);
    const raw = `${stableViewCanonicalizeJcs(canonicalObject)}\n`;
    if (selfHash !== stableViewSha256Hex(preimageBytes)) fail("receipt_preimage_binding_invalid", "receipt self-hash does not match preserved preimage", { name });
    return deepFreeze({
      name,
      self_hash_field: "receipt_hash",
      self_hash: selfHash,
      preimage: { canonical_object: preimageObject, canonical_utf8_bytes: Buffer.byteLength(preimageBytes), raw_sha256: stableViewSha256Hex(preimageBytes) },
      raw: { canonical_object: canonicalObject, canonical_utf8_bytes: Buffer.byteLength(raw), raw_sha256: stableViewSha256Hex(raw) },
    });
  };
  const observationObject = deepClone(receipts.observation);
  const observationRaw = `${stableViewCanonicalizeJcs(observationObject)}\n`;
  return deepFreeze({
    request_receipt: selfHashed("request-receipt.json", receipts.request_receipt),
    outcome_receipt: selfHashed("outcome-receipt.json", receipts.outcome_receipt),
    observation: {
      name: "observation.json",
      canonical_object: observationObject,
      canonical_utf8_bytes: Buffer.byteLength(observationRaw),
      raw_sha256: stableViewSha256Hex(observationRaw),
    },
  });
}

function inventoryOutput(): Readonly<Record<string, unknown>> {
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  const walk = (file: string): void => {
    const stat = fs.lstatSync(file);
    const relative = path.relative(OUTPUT_ROOT, file).split(path.sep).join("/") || ".";
    if (stat.isSymbolicLink()) fail("sandbox_output_symlink", "sandbox output contains a symlink", { relative });
    if (stat.isDirectory()) {
      const children = fs.readdirSync(file).sort(compareCodeUnits);
      rows.push(deepFreeze({ relative, kind: "directory", children }));
      for (const child of children) walk(path.join(file, child));
      return;
    }
    if (!stat.isFile()) fail("sandbox_output_unsupported", "sandbox output contains an unsupported entry", { relative });
    const raw = fs.readFileSync(file);
    rows.push(deepFreeze({ relative, kind: "file", bytes: raw.length, sha256: stableViewSha256Hex(raw) }));
  };
  walk(OUTPUT_ROOT);
  rows.sort((left, right) => compareCodeUnits(String(left.relative), String(right.relative)));
  return deepFreeze({ rows, inventory_hash: stableViewSha256Hex(stableViewCanonicalizeJcs(rows)) });
}

function probeWriteDenied(file: string): Readonly<Record<string, unknown>> {
  try {
    fs.writeFileSync(file, "write-probe\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { fs.unlinkSync(file); } catch { /* best-effort cleanup before failure */ }
    fail("sandbox_read_only_probe_succeeded", "read-only mount accepted a write", { file });
  } catch (error) {
    if (error instanceof PropositionPolicyStableViewPreviewError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unknown";
    if (!["EROFS", "EACCES", "EPERM"].includes(code)) fail("sandbox_read_only_probe_unexpected", "read-only probe failed for an unexpected reason", { file, code });
    return deepFreeze({ denied: true, code });
  }
}

async function probeNetworkDenied(): Promise<Readonly<Record<string, unknown>>> {
  const code = await new Promise<string>((resolve) => {
    const socket = net.createConnection({ host: "198.51.100.1", port: 9 });
    const timer = setTimeout(() => { socket.destroy(); resolve("TIMEOUT"); }, 1000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("CONNECTED"); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(String(error.code ?? "ERROR")); });
  });
  if (!["ENETUNREACH", "ENETDOWN", "EACCES", "EPERM"].includes(code)) fail("sandbox_network_not_proven_denied", "network probe did not fail closed", { code });
  return deepFreeze({ denied: true, code, target: "TEST-NET-2" });
}

function captureNamespaceIdentities(): Readonly<Record<string, string>> {
  const names = ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"];
  const output: Record<string, string> = {};
  for (const name of names) output[name] = fs.readlinkSync(`/proc/self/ns/${name}`);
  return deepFreeze(output);
}

function effectiveCapabilities(): string {
  const line = fs.readFileSync("/proc/self/status", "utf8").split("\n").find((candidate) => candidate.startsWith("CapEff:"));
  if (!line) fail("sandbox_capabilities_missing", "CapEff is absent from proc status");
  return line.split(":", 2)[1]!.trim().padStart(16, "0");
}

function readRegularInput(name: string): string {
  const file = path.join(INPUT_ROOT, name);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("sandbox_input_unsafe", "sandbox input is not a regular file", { name });
  return fs.readFileSync(file, "utf8");
}

function parseCanonicalJson(raw: string, name: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("sandbox_input_json_invalid", "sandbox input is invalid JSON", { name }); }
  if (`${stableViewCanonicalizeJcs(parsed)}\n` !== raw) fail("sandbox_input_not_canonical", "sandbox JSON input is not exact JCS plus LF", { name });
  return parsed;
}

function assertSandboxPaths(): void {
  for (const [file, kind] of [[INPUT_ROOT, "directory"], [OUTPUT_ROOT, "directory"], [REPOSITORY_ROOT, "directory"], [ABRAIN_ROOT, "directory"]] as const) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (kind === "directory" && !stat.isDirectory())) fail("sandbox_path_invalid", "required sandbox path is unsafe", { file });
  }
  if (fs.readdirSync(OUTPUT_ROOT).length !== 0) fail("sandbox_output_not_empty", "private output must start empty");
}

function writeExclusive(file: string, raw: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, raw, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeIfPresent(file: string): void {
  fs.rmSync(file, { recursive: true, force: true });
}

function row(name: string, raw: string | Buffer): Readonly<Record<string, unknown>> {
  return deepFreeze({ name, bytes: Buffer.byteLength(raw), sha256: stableViewSha256Hex(raw) });
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("object_expected", `${at} must be an object`);
  return value as Record<string, unknown>;
}

function assertHash(value: unknown, at: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("sha256_invalid", `${at} must be lowercase SHA-256`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepClone<T>(value: T): T {
  return JSON.parse(stableViewCanonicalizeJcs(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new PropositionPolicyStableViewPreviewError(code, message, detail);
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) fail("sandbox_argument_missing", "required helper argument is missing", { name });
  return process.argv[index + 1]!;
}

if (process.argv.includes("--confined-stable-view-helper")) {
  runConfinedStableViewPreview({
    expected_source_bundle_hash: argument("expected-source-bundle-hash"),
    requested_at_utc: argument("requested-at-utc"),
  }).then((result) => {
    process.stdout.write(`${stableViewCanonicalizeJcs(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error?.code ?? "stable_view_preview_failed"}: ${error?.message ?? String(error)}\n`);
    if (error?.detail) process.stderr.write(`${stableViewCanonicalizeJcs(error.detail)}\n`);
    process.exitCode = 1;
  });
}
