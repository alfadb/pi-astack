import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import {
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1WritePreflight,
} from "./l1-schema-registry";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID,
  PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER,
  appendFixedProductionPropositionEvidenceSandbox,
  prepareFixedProductionPropositionEvidenceTuple,
} from "./proposition-evidence-writer";
import {
  PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING,
  computeCurrentPropositionSchemaAnchors,
  summarizePropositionGenesisScan,
  writeProductionPropositionGenesis,
} from "./proposition-genesis-writer";
import {
  PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
  buildPropositionKnowledgeShadow,
  readLatestPropositionKnowledgeShadow,
} from "./proposition-knowledge-shadow";
import { verifyFixedP1bAttestation } from "./proposition-p1b-transcript";

export const PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA = "proposition-p1b-production-preview-dossier/v2" as const;
export const PROPOSITION_P1B_HARD_ABRAIN_REALPATH = "/home/worker/.abrain" as const;
export const PROPOSITION_P1B_PREVIEW_DOSSIER_RELATIVE_PATH = "docs/evidence/2026-07-13-adr0040-p1b-production-preview-dossier-v2.json" as const;
export const PROPOSITION_P1B_PREVIEW_V1_DOSSIER_RELATIVE_PATH = "docs/evidence/2026-07-13-adr0040-p1b-production-preview-dossier.json" as const;
export const PROPOSITION_P1B_PREVIEW_V1_DOSSIER_HASH = "40ed913881b58ff796c630e3e6fa52c2b8003901081154d4f234255355d291e5" as const;
export const PROPOSITION_P1B_PREVIEW_CLI = "scripts/dossier-proposition-p1b-production-preview.mjs" as const;

export interface PropositionP1bPreviewDossier {
  schema_version: typeof PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_algorithm: "sha256";
  dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted";
  dossier_hash: string;
  mode: "read_only_preview";
  supersession: Readonly<Record<string, unknown>>;
  authorization: Readonly<Record<string, unknown>>;
  review: Readonly<Record<string, unknown>>;
  attestation: Readonly<Record<string, unknown>>;
  tuple: Readonly<Record<string, unknown>>;
  registry: Readonly<Record<string, unknown>>;
  production_prestate: Readonly<Record<string, unknown>>;
  existing_shadow: Readonly<Record<string, unknown>>;
  expected_post_shadow: Readonly<Record<string, unknown>>;
  sandbox_equivalence: Readonly<Record<string, unknown>>;
  mutation_proof: Readonly<Record<string, unknown>>;
}

interface InventorySummary {
  schema_version: "proposition-p1b-whole-abrain-snapshot/v1";
  scope: "all_abrain_entries";
  entry_count: number;
  directory_count: number;
  file_count: number;
  symlink_count: number;
  bytes: number;
  rows_hash: string;
  snapshot_hash: string;
}

export class PropositionP1bPreviewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionP1bPreviewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function buildPropositionP1bProductionPreview(options: {
  abrainHome: string;
  outputPath: string;
  repoRoot?: string;
  registryPath?: string;
}): Promise<PropositionP1bPreviewDossier> {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const outputPath = await assertFixedPreviewOutputPath(options.outputPath, repoRoot, { allowExistingIdentical: true });
  const abrainHome = await assertHardProductionAbrain(options.abrainHome);
  const registryPath = path.resolve(options.registryPath ?? path.join(repoRoot, "schemas/l1-schema-role-registry.json"));
  const registry = loadL1SchemaRegistry(registryPath);
  const before = await captureWholeAbrainSnapshot(abrainHome);
  const attestation = await verifyFixedP1bAttestation();
  const tuple = await prepareFixedProductionPropositionEvidenceTuple({ abrainHome, registryPath });
  await assertReadonlyTargetAbsent(abrainHome, tuple.target_path);

  const scan = await scanWholeL1Validated({ abrainHome, registry });
  const summary = summarizePropositionGenesisScan(scan);
  const proposition = scan.all.filter((record) => record.registration.domain === "proposition");
  const exactPrestate = proposition.length === 1
    && proposition[0]!.eventId === PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID
    && summary.productionGenesis === 1
    && summary.propositionEvidence === 0
    && summary.propositionLifecycle === 0
    && summary.propositionProjection === 0
    && summary.propositionSelected === 0
    && summary.propositionFoldable === 0;
  if (!exactPrestate) throw failure("PROPOSITION_P1B_PRODUCTION_PRESTATE_INVALID", "production must contain exactly the fixed genesis and zero post-genesis proposition records", { summary, ids: proposition.map((record) => record.eventId) });

  const genericGate = await genericGateCode(abrainHome, tuple, registry);
  if (genericGate !== "L1_SCHEMA_WRITE_DISABLED") throw failure("PROPOSITION_P1B_GENERIC_GATE_DRIFT", "generic proposition write gate is not disabled", { genericGate });
  const currentAnchors = await computeCurrentPropositionSchemaAnchors(registryPath);
  const existingShadow = await readLatestPropositionKnowledgeShadow({ abrainHome });
  if (existingShadow.manifest.result.card_count !== 0 || existingShadow.manifest.source.proposition_event_count !== 1) {
    throw failure("PROPOSITION_P1B_EXISTING_SHADOW_INVALID", "production shadow must still be the genesis-only zero-card bundle");
  }

  const expected = await buildExpectedPostShadowInSandbox({ repoRoot, registryPath, tuple });
  const after = await captureWholeAbrainSnapshot(abrainHome);
  if (before.snapshot_hash !== after.snapshot_hash) {
    throw failure("PROPOSITION_P1B_PREVIEW_MUTATION_DETECTED", "whole abrain changed during read-only preview", { before: before.snapshot_hash, after: after.snapshot_hash });
  }
  if (await pathExists(tuple.target_path)) throw failure("PROPOSITION_P1B_TARGET_APPEARED", "production target appeared during preview", { targetPath: tuple.target_path });

  const dossier: PropositionP1bPreviewDossier = {
    schema_version: PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted",
    dossier_hash: "",
    mode: "read_only_preview",
    supersession: {
      generation: "v2",
      supersedes_schema_version: "proposition-p1b-production-preview-dossier/v1",
      supersedes_relative_path: PROPOSITION_P1B_PREVIEW_V1_DOSSIER_RELATIVE_PATH,
      supersedes_dossier_hash: PROPOSITION_P1B_PREVIEW_V1_DOSSIER_HASH,
      reason: "P1b preview T0 BLOCK remediation hardens authorization negation, recovery zero-mutation intent validation, append-only whole-L1 scanning, and offline smoke isolation evidence",
      frozen_tuple_unchanged: true,
      expected_post_shadow_unchanged: true,
      production_execution_remains_unauthorized: true,
    },
    authorization: {
      design_authorized: true,
      production_execution_authorized: false,
      authorization_status: "not_execution_authorized",
      production_executor_must_fail_without_fresh_exact_ratification: true,
      generic_write_enablement_authorized: false,
      runtime_consumer_authorized: false,
      l2_write_authorized: false,
      legacy_mutation_authorized: false,
      preview_cli: PROPOSITION_P1B_PREVIEW_CLI,
      output_path: outputPath,
    },
    review: {
      phase: "ADR0040-P1b",
      round: "R4",
      result: "unanimous_ACCEPT",
      vendors: ["OpenAI", "Anthropic", "DeepSeek", "Moonshot", "MiniMax", "Z.ai"],
      accepted_scope: "repo_plus_read_only_preview_only",
    },
    attestation,
    tuple: {
      event_id: tuple.event_id,
      body_hash: tuple.envelope.body_hash,
      canonical_envelope_bytes_sha256: tuple.canonical_envelope_bytes_sha256,
      canonical_envelope_bytes_utf8: tuple.canonical_envelope_json,
      relative_path: tuple.relative_path,
      target_path: tuple.target_path,
      target_absent: true,
      envelope: tuple.envelope,
      source_event_id_is_null: tuple.envelope.body.facets.provenance_authority.source_event_id === null,
      trigger_ref: tuple.envelope.body.facets.trigger.trigger_ref,
      fixed_tuple_only: true,
    },
    registry: {
      path: registryPath,
      current: currentAnchors,
      production_genesis_historical_provenance: PROPOSITION_PRODUCTION_GENESIS_HISTORICAL_BINDING,
      historical_binding_is_not_current_registry_invariant: true,
      evidence_registration: registry.entries.find((entry) => entry.envelope_schema === "proposition-evidence-envelope/v1"),
      generic_validateL1WritePreflight: { code: genericGate },
    },
    production_prestate: {
      exact_genesis_plus_zero_evidence: true,
      proposition_count: proposition.length,
      production_genesis_count: summary.productionGenesis,
      evidence_count: summary.propositionEvidence,
      lifecycle_count: summary.propositionLifecycle,
      projection_count: summary.propositionProjection,
      selected_count: summary.propositionSelected,
      foldable_count: summary.propositionFoldable,
      target_absent: true,
    },
    existing_shadow: {
      root_relative_path: PROPOSITION_KNOWLEDGE_SHADOW_ROOT_RELATIVE,
      bundle_hash: existingShadow.manifest.bundle_hash,
      manifest_exact_bytes_sha256: sha256Hex(existingShadow.bytes["manifest.json"]),
      artifact_rows: existingShadow.manifest.artifacts,
      card_count: existingShadow.manifest.result.card_count,
      source_event_count: existingShadow.manifest.source.proposition_event_count,
      no_runtime_consumer: existingShadow.manifest.authority === "shadow_pull_only_no_runtime_consumer",
    },
    expected_post_shadow: expected.post_shadow,
    sandbox_equivalence: expected.equivalence,
    mutation_proof: {
      scope: "whole_real_abrain_before_after_preview",
      before,
      after,
      unchanged: before.snapshot_hash === after.snapshot_hash,
      target_absent_after: true,
      real_abrain_files_created: [],
      real_abrain_files_modified: [],
      real_abrain_files_removed: [],
      repo_dossier_write_occurs_after_this_proof: true,
    },
  };
  dossier.dossier_hash = selfHashPropositionP1bPreviewDossier(dossier);
  validatePropositionP1bPreviewDossier(dossier);
  return deepFreeze(dossier);
}

export async function writePropositionP1bProductionPreview(options: {
  abrainHome: string;
  outputPath: string;
  repoRoot?: string;
  registryPath?: string;
}): Promise<{ dossier: PropositionP1bPreviewDossier; status: DurableCreateStatus; raw_sha256: string }> {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const outputPath = await assertFixedPreviewOutputPath(options.outputPath, repoRoot, { allowExistingIdentical: true });
  const dossier = await buildPropositionP1bProductionPreview({ ...options, repoRoot, outputPath });
  const raw = `${JSON.stringify(dossier, null, 2)}\n`;
  const status = await durableAtomicCreateFile(outputPath, raw, { mode: 0o644 });
  if (status === "collision") throw failure("PROPOSITION_P1B_PREVIEW_OUTPUT_COLLISION", "preview dossier path exists with different bytes", { outputPath });
  const readback = await fs.readFile(outputPath, "utf-8");
  if (readback !== raw) throw failure("PROPOSITION_P1B_PREVIEW_OUTPUT_READBACK_MISMATCH", "preview dossier readback differs from written bytes");
  return deepFreeze({ dossier, status, raw_sha256: sha256Hex(raw) });
}

export function selfHashPropositionP1bPreviewDossier(dossier: PropositionP1bPreviewDossier): string {
  const clone = JSON.parse(JSON.stringify(dossier));
  delete clone.dossier_hash;
  return jcsSha256Hex(clone);
}

export function validatePropositionP1bPreviewDossier(dossier: PropositionP1bPreviewDossier): void {
  if (dossier.schema_version !== PROPOSITION_P1B_PREVIEW_DOSSIER_SCHEMA || dossier.mode !== "read_only_preview") throw failure("PROPOSITION_P1B_PREVIEW_DOSSIER_INVALID", "preview dossier schema or mode mismatch");
  if (!/^[0-9a-f]{64}$/.test(dossier.dossier_hash) || selfHashPropositionP1bPreviewDossier(dossier) !== dossier.dossier_hash) throw failure("PROPOSITION_P1B_PREVIEW_DOSSIER_INVALID", "preview dossier self-hash mismatch");
  if (dossier.supersession.supersedes_dossier_hash !== PROPOSITION_P1B_PREVIEW_V1_DOSSIER_HASH || dossier.supersession.supersedes_relative_path !== PROPOSITION_P1B_PREVIEW_V1_DOSSIER_RELATIVE_PATH || dossier.supersession.production_execution_remains_unauthorized !== true) throw failure("PROPOSITION_P1B_PREVIEW_DOSSIER_INVALID", "preview supersession binding drifted");
  if (dossier.authorization.production_execution_authorized !== false || dossier.authorization.design_authorized !== true) throw failure("PROPOSITION_P1B_PREVIEW_DOSSIER_INVALID", "preview authorization boundary drifted");
  if (dossier.production_prestate.exact_genesis_plus_zero_evidence !== true || dossier.production_prestate.evidence_count !== 0) throw failure("PROPOSITION_P1B_PREVIEW_DOSSIER_INVALID", "preview production prestate drifted");
  if (dossier.mutation_proof.unchanged !== true || dossier.mutation_proof.target_absent_after !== true) throw failure("PROPOSITION_P1B_PREVIEW_DOSSIER_INVALID", "preview zero-mutation proof failed");
  if (dossier.expected_post_shadow.card_count !== 1 || dossier.expected_post_shadow.source_event_count !== 2) throw failure("PROPOSITION_P1B_PREVIEW_DOSSIER_INVALID", "expected post shadow is not exactly one card from genesis plus one evidence event");
}

async function buildExpectedPostShadowInSandbox(options: {
  repoRoot: string;
  registryPath: string;
  tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionEvidenceTuple>>;
}): Promise<{ post_shadow: Readonly<Record<string, unknown>>; equivalence: Readonly<Record<string, unknown>> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-proposition-p1b-preview-"));
  try {
    const genesis = await writeProductionPropositionGenesis({ sandboxAbrainHome: home, registryPath: options.registryPath });
    const evidence = await appendFixedProductionPropositionEvidenceSandbox({ sandboxAbrainHome: home, registryPath: options.registryPath });
    if (genesis.tuple.event_id !== PROPOSITION_P1B_FIXED_GENESIS_EVENT_ID || evidence.tuple.event_id !== options.tuple.event_id || evidence.tuple.canonical_envelope_json !== options.tuple.canonical_envelope_json) {
      throw failure("PROPOSITION_P1B_SANDBOX_EQUIVALENCE_FAILED", "sandbox tuple bytes differ from production preview tuple");
    }
    const bundle = await buildPropositionKnowledgeShadow({ abrainHome: home, repoRoot: options.repoRoot, registryPath: options.registryPath });
    if (bundle.cards.cards.length !== 1 || bundle.cards.cards[0]!.source_event_id !== options.tuple.event_id || bundle.cards.cards[0]!.statement !== options.tuple.envelope.body.proposition.statement) {
      throw failure("PROPOSITION_P1B_EXPECTED_SHADOW_INVALID", "sandbox expected shadow did not produce exactly the fixed proposition card");
    }
    return deepFreeze({
      post_shadow: {
        bundle_hash: bundle.manifest.bundle_hash,
        manifest_exact_bytes_sha256: sha256Hex(bundle.bytes["manifest.json"]),
        artifact_rows: bundle.manifest.artifacts,
        artifact_exact_bytes_sha256: {
          cards: sha256Hex(bundle.bytes["cards.json"]),
          diagnostics: sha256Hex(bundle.bytes["diagnostics.json"]),
          exclusions: sha256Hex(bundle.bytes["exclusions.json"]),
        },
        source_event_count: bundle.manifest.source.proposition_event_count,
        source_genesis_count: bundle.manifest.source.proposition_genesis_count,
        source_evidence_count: bundle.manifest.source.proposition_evidence_count,
        source_selected_count: bundle.manifest.source.proposition_selected_count,
        source_foldable_count: bundle.manifest.source.proposition_foldable_count,
        card_count: bundle.manifest.result.card_count,
        exclusion_count: bundle.manifest.result.exclusion_count,
        diagnostic_count: bundle.manifest.result.diagnostic_count,
        disposition_reason: bundle.manifest.result.disposition_reason,
        expected_card: bundle.cards.cards[0],
        bytes: bundle.bytes,
      },
      equivalence: {
        sandbox_only: true,
        sandbox_removed_after: true,
        genesis_event_id_equal: true,
        evidence_event_id_equal: true,
        evidence_canonical_bytes_equal: true,
        first_write_status: evidence.status,
        immediate_rerun_status: evidence.immediate_rerun_status,
        generic_write_gate: evidence.generic_write_gate,
      },
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function captureWholeAbrainSnapshot(abrainHome: string): Promise<InventorySummary> {
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  let directories = 0;
  let files = 0;
  let symlinks = 0;
  let bytes = 0;
  const walk = async (file: string): Promise<void> => {
    const stat = await fs.lstat(file);
    const rel = path.relative(abrainHome, file).split(path.sep).join("/") || ".";
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(file);
      symlinks += 1;
      rows.push({ path: rel, kind: "symlink", target, target_sha256: sha256Hex(target) });
      return;
    }
    if (stat.isDirectory()) {
      directories += 1;
      rows.push({ path: rel, kind: "directory" });
      for (const child of (await fs.readdir(file)).sort(compareCodeUnits)) await walk(path.join(file, child));
      return;
    }
    if (stat.isFile()) {
      const content = await fs.readFile(file);
      files += 1;
      bytes += content.length;
      rows.push({ path: rel, kind: "file", bytes: content.length, sha256: sha256Hex(content) });
      return;
    }
    throw failure("PROPOSITION_P1B_ABRAIN_NON_REGULAR", "whole-abrain snapshot found an unsupported entry", { path: file });
  };
  await walk(abrainHome);
  rows.sort((left, right) => compareCodeUnits(String(left.path), String(right.path)));
  const rowsHash = jcsSha256Hex(rows);
  return deepFreeze({
    schema_version: "proposition-p1b-whole-abrain-snapshot/v1",
    scope: "all_abrain_entries",
    entry_count: rows.length,
    directory_count: directories,
    file_count: files,
    symlink_count: symlinks,
    bytes,
    rows_hash: rowsHash,
    snapshot_hash: jcsSha256Hex({ rows_hash: rowsHash, entry_count: rows.length, directory_count: directories, file_count: files, symlink_count: symlinks, bytes }),
  });
}

async function assertHardProductionAbrain(input: string): Promise<string> {
  const resolved = path.resolve(input);
  if (resolved !== PROPOSITION_P1B_HARD_ABRAIN_REALPATH) throw failure("PROPOSITION_P1B_REAL_ABRAIN_REQUIRED", "preview requires exact /home/worker/.abrain", { actual: resolved });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(resolved) !== resolved) throw failure("PROPOSITION_P1B_REAL_ABRAIN_REQUIRED", "production abrain path or realpath is unsafe");
  return resolved;
}

async function assertReadonlyTargetAbsent(abrainHome: string, targetPath: string): Promise<void> {
  if (!isPathInside(abrainHome, targetPath)) throw failure("PROPOSITION_P1B_PATH_ESCAPE", "preview target escapes production abrain");
  let current = abrainHome;
  const relativeParent = path.relative(abrainHome, path.dirname(targetPath));
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_P1B_PATH_UNSAFE", "preview target directory chain is unsafe", { path: current });
  }
  const leaf = await fs.lstat(targetPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (leaf) throw failure("PROPOSITION_P1B_TARGET_EXISTS", "read-only preview requires the fixed production target to remain absent", { targetPath });
}

async function genericGateCode(abrainHome: string, tuple: Awaited<ReturnType<typeof prepareFixedProductionPropositionEvidenceTuple>>, registry: ReturnType<typeof loadL1SchemaRegistry>): Promise<string> {
  try {
    await validateL1WritePreflight({
      abrainHome,
      envelope: tuple.envelope,
      targetPath: tuple.target_path,
      registry,
      expected: { domain: "proposition", role: "evidence", producer: PROPOSITION_PRODUCTION_EVIDENCE_PRODUCER },
    });
    return "UNEXPECTED_SUCCESS";
  } catch (err) {
    return errorCode(err);
  }
}

async function assertFixedPreviewOutputPath(input: string, repoRoot: string, options: { allowExistingIdentical: boolean }): Promise<string> {
  const expected = path.resolve(repoRoot, ...PROPOSITION_P1B_PREVIEW_DOSSIER_RELATIVE_PATH.split("/"));
  const resolved = path.resolve(input);
  if (resolved !== expected) throw failure("PROPOSITION_P1B_PREVIEW_OUTPUT_INVALID", `preview output must be ${expected}`, { actual: resolved });
  let current = path.parse(repoRoot).root;
  for (const part of path.relative(current, path.dirname(expected)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("PROPOSITION_P1B_PREVIEW_OUTPUT_UNSAFE", "preview output ancestor is a symlink or non-directory", { path: current });
  }
  const leaf = await fs.lstat(expected).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile() || !options.allowExistingIdentical)) throw failure("PROPOSITION_P1B_PREVIEW_OUTPUT_UNSAFE", "preview output leaf is unsafe or already exists", { expected });
  return expected;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, (err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return false;
    throw err;
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "ERROR";
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionP1bPreviewError {
  return new PropositionP1bPreviewError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
