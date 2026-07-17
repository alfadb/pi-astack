import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalL1BodyHash,
  canonicalL1EnvelopeHash,
  canonicalL1EnvelopeJson,
  expectedL1EventPath,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1WritePreflight,
  type L1SchemaRoleRegistry,
  type ValidatedL1ScanRecord,
} from "./l1-schema-registry";
import { jcsSha256Hex, sha256Hex } from "./jcs";
import {
  PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
  PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
  PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
  PROPOSITION_SCHEMA_CONTRACT_SCHEMA,
} from "./proposition";
import {
  prepareFixedProductionPropositionGenesisTuple,
  summarizePropositionGenesisScan,
  validateProductionPropositionGenesisTuple,
  writeProductionPropositionGenesis,
  type FixedProductionPropositionGenesisTuple,
} from "./proposition-genesis-writer";

export const PROPOSITION_P0B2_PREVIEW_DOSSIER_SCHEMA = "proposition-p0b2-production-preview-dossier/v1" as const;
export const PROPOSITION_P0B2_HARD_ABRAIN_REALPATH = "/home/worker/.abrain" as const;
export const PROPOSITION_P0B2_PREVIEW_CLI = "scripts/dossier-proposition-p0b2-production-preview.mjs" as const;

export interface PropositionProductionPreviewOptions {
  abrainHome: string;
  outputPath: string;
  causalAnchor: string;
  registryPath?: string;
  repoRoot?: string;
  includeSmokeEvidence?: boolean;
}

export interface PropositionProductionPreviewDossier {
  schema_version: typeof PROPOSITION_P0B2_PREVIEW_DOSSIER_SCHEMA;
  dossier_canonicalization: "RFC8785-JCS";
  dossier_hash_algorithm: "sha256";
  dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted";
  dossier_hash: string;
  generated_at_utc: string;
  repo_root: string;
  mode: "preview";
  authorization: Readonly<Record<string, unknown>>;
  causal_anchor: Readonly<Record<string, unknown>>;
  target: Readonly<Record<string, unknown>>;
  event: Readonly<Record<string, unknown>>;
  registry: Readonly<Record<string, unknown>>;
  proposition_schema_contract: Readonly<Record<string, unknown>>;
  preflight: Readonly<Record<string, unknown>>;
  before: Readonly<Record<string, unknown>>;
  selected_foldable: Readonly<Record<string, unknown>>;
  consumer_deterministic_artifacts: Readonly<Record<string, unknown>>;
  sandbox_equivalence: Readonly<Record<string, unknown>>;
  expected_mutation_inventory: Readonly<Record<string, unknown>>;
  evidence: Readonly<Record<string, unknown>>;
}

export class PropositionProductionPreviewError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionProductionPreviewError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function throwExecuteNotAuthorized(): never {
  throw failure("NOT_AUTHORIZED", "ADR0040 P0b2 production genesis execute is not authorized; only --preview is currently allowed");
}

export async function buildProductionPropositionGenesisPreviewDossier(options: PropositionProductionPreviewOptions): Promise<PropositionProductionPreviewDossier> {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(__dirname, "..", ".."));
  const outputPath = assertOutputPath(options.outputPath);
  const causalAnchor = parseCausalAnchor(options.causalAnchor);
  const abrain = await resolveHardProductionAbrainHome(options.abrainHome);
  const registryPath = path.resolve(options.registryPath ?? path.join(repoRoot, "schemas/l1-schema-role-registry.json"));
  const registry = loadL1SchemaRegistry(registryPath);
  const tuple = await prepareFixedProductionPropositionGenesisTuple({
    abrainHome: abrain.resolved,
    abrainRealpath: abrain.realpath,
    registryPath,
  });
  validateProductionPropositionGenesisTuple(tuple, registry);

  const targetPathPreflight = await assertReadonlyTargetPathPreflight(abrain.resolved, tuple);
  const beforeInventory = await collectBeforeInventory(abrain.resolved, registry, tuple);
  const scan = await scanWholeL1Validated({ abrainHome: abrain.resolved, registry });
  const scanSummary = summarizePropositionGenesisScan(scan);
  const propositionRecords = scan.all.filter((record) => record.registration.domain === "proposition");
  const epochCheck = assertZeroPropositionEventsAndEpochUnique(propositionRecords, tuple);
  const genericGate = await expectCode(() => validateL1WritePreflight({
    abrainHome: abrain.resolved,
    envelope: tuple.envelope,
    targetPath: tuple.target_path,
    registry,
    expected: {
      envelopeSchema: PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
      domain: "proposition",
      role: "meta",
      producer: PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
      eventType: "proposition_genesis_declared",
    },
  }));
  if (genericGate.code !== "L1_SCHEMA_WRITE_DISABLED") {
    throw failure("PROPOSITION_P0B2_GENERIC_PREFLIGHT_DRIFT", "generic L1 write preflight did not stay disabled for proposition genesis", { genericGate });
  }

  const sandboxEquivalence = await verifySandboxEquivalence(tuple, registryPath);
  const smokeEvidence = options.includeSmokeEvidence === false ? skippedSmokeEvidence() : runSmokeEvidence(repoRoot);
  const selectedIds = scan.selected.map((record) => record.eventId).sort(compareCodeUnits);
  const foldableIds = scan.foldable.map((record) => record.eventId).sort(compareCodeUnits);
  const definedInactiveIds = scan.definedInactiveShadow.map((record) => record.eventId).sort(compareCodeUnits);
  const bodyCanonicalSha256 = canonicalL1BodyHash(tuple.envelope.body);
  const envelopeCanonicalSha256 = canonicalL1EnvelopeHash(tuple.envelope);
  const canonicalBytesSha256 = sha256Hex(tuple.canonical_envelope_json);
  const binding = tuple.envelope.body.contract.kind === "production_genesis" ? tuple.envelope.body.contract.binding : null;
  if (!binding) throw failure("PROPOSITION_P0B2_BINDING_MISSING", "production genesis tuple did not carry a binding manifest");

  const dossier: PropositionProductionPreviewDossier = {
    schema_version: PROPOSITION_P0B2_PREVIEW_DOSSIER_SCHEMA,
    dossier_canonicalization: "RFC8785-JCS",
    dossier_hash_algorithm: "sha256",
    dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted",
    dossier_hash: "",
    generated_at_utc: new Date().toISOString(),
    repo_root: repoRoot,
    mode: "preview",
    authorization: {
      execute_allowed: false,
      execute_block_code: "NOT_AUTHORIZED",
      preview_only: true,
      preview_cli: PROPOSITION_P0B2_PREVIEW_CLI,
      hard_abrain_realpath: PROPOSITION_P0B2_HARD_ABRAIN_REALPATH,
      output_path_required: true,
    },
    causal_anchor: causalAnchor,
    target: {
      abrain_home: abrain.resolved,
      abrain_realpath: abrain.realpath,
      hard_realpath_required: PROPOSITION_P0B2_HARD_ABRAIN_REALPATH,
      output_path: outputPath,
      target_path: tuple.target_path,
      relative_path: tuple.relative_path,
      target_absent: targetPathPreflight.target_absent,
      target_parent_exists: targetPathPreflight.parent_exists,
      missing_target_parent_components: targetPathPreflight.missing_parent_components,
      symlink_path_preflight: targetPathPreflight,
    },
    event: {
      event_id: tuple.event_id,
      body_hash: tuple.envelope.body_hash,
      event_id_equals_body_hash: tuple.event_id === tuple.envelope.body_hash,
      body_canonical_sha256: bodyCanonicalSha256,
      envelope_canonical_sha256: envelopeCanonicalSha256,
      canonical_envelope_bytes_sha256: canonicalBytesSha256,
      canonical_envelope_bytes_utf8: tuple.canonical_envelope_json,
      canonical_envelope_json_matches_shared_jcs: tuple.canonical_envelope_json === canonicalL1EnvelopeJson(tuple.envelope),
      envelope: tuple.envelope,
      body: tuple.envelope.body,
    },
    registry: {
      path: tuple.registry_path,
      registry_id: tuple.registry_id,
      registry_canonical_sha256: tuple.registry_canonical_sha256,
      registry_file_sha256: tuple.registry_file_sha256,
      storage_root_relative_path: registry.storage.root_relative_path,
      proposition_genesis_registration: registry.entries.find((entry) => entry.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA),
    },
    proposition_schema_contract: {
      schema_version: PROPOSITION_SCHEMA_CONTRACT_SCHEMA,
      schema_contract_hash: tuple.proposition_schema_contract_hash,
      binding_schema_version: binding.binding_schema_version,
      binding_manifest_hash: tuple.binding_manifest_hash,
      binding_manifest_hash_from_event: binding.manifest_hash,
      binding_manifest_hash_matches: binding.manifest_hash === tuple.binding_manifest_hash,
      binding_manifest: binding.manifest,
    },
    preflight: {
      whole_l1: {
        ok: true,
        scan_summary: scanSummary,
        total: scan.all.length,
        selected: scan.selected.length,
        foldable: scan.foldable.length,
        temp_residue: scan.tempResidue.length,
      },
      zero_proposition_events: propositionRecords.length === 0,
      proposition_event_count: propositionRecords.length,
      epoch_uniqueness: epochCheck,
      registry_schema_binding: {
        ok: true,
        tuple_validated_with_shared_validator: true,
        registry_canonical_sha256: tuple.registry_canonical_sha256,
        registry_file_sha256: tuple.registry_file_sha256,
        proposition_schema_contract_hash: tuple.proposition_schema_contract_hash,
        binding_manifest_hash: tuple.binding_manifest_hash,
      },
      symlink_path: targetPathPreflight,
      target_absent: targetPathPreflight.target_absent,
      generic_validateL1WritePreflight: genericGate,
    },
    before: beforeInventory,
    selected_foldable: {
      selected_count: selectedIds.length,
      selected_event_ids_sha256: jcsSha256Hex(selectedIds),
      selected_event_ids: selectedIds,
      foldable_count: foldableIds.length,
      foldable_event_ids_sha256: jcsSha256Hex(foldableIds),
      foldable_event_ids: foldableIds,
      defined_inactive_shadow_count: definedInactiveIds.length,
      defined_inactive_shadow_event_ids_sha256: jcsSha256Hex(definedInactiveIds),
      defined_inactive_shadow_event_ids: definedInactiveIds,
      proposition_selected_count: scan.selected.filter((record) => record.registration.domain === "proposition").length,
      proposition_foldable_count: scan.foldable.filter((record) => record.registration.domain === "proposition").length,
    },
    consumer_deterministic_artifacts: {
      whole_l1_selected_event_ids_sha256: jcsSha256Hex(selectedIds),
      whole_l1_foldable_event_ids_sha256: jcsSha256Hex(foldableIds),
      proposition_shadow: {
        selected_count: 0,
        foldable_count: 0,
        event_count: 0,
        event_ids_sha256: jcsSha256Hex([]),
      },
      projector_outputs_generated: false,
      runtime_read_flip: false,
      notes: "P0b2 preview only computes deterministic scan/selection artifacts; it does not run proposition projectors or consumers.",
    },
    sandbox_equivalence: sandboxEquivalence,
    expected_mutation_inventory: {
      authorization_state: "execute_not_authorized",
      future_files: [tuple.relative_path],
      future_file_count: 1,
      future_file_sha256: canonicalBytesSha256,
      creates: [tuple.relative_path],
      modifies: [],
      removes: [],
      l2: [],
      state: [],
      rules: [],
      knowledge: [],
      projects: [],
      only_future_file: true,
      no_real_abrain_mutation_performed: true,
    },
    evidence: {
      p0a_p0b1_smoke: smokeEvidence,
      execute_blocked: {
        code: "NOT_AUTHORIZED",
        execute_allowed: false,
        command: `node ${PROPOSITION_P0B2_PREVIEW_CLI} --execute`,
      },
    },
  };
  dossier.dossier_hash = selfHashDossier(dossier);
  return deepFreeze(dossier);
}

export async function writeProductionPreviewDossier(options: PropositionProductionPreviewOptions): Promise<PropositionProductionPreviewDossier> {
  const dossier = await buildProductionPropositionGenesisPreviewDossier(options);
  const outPath = assertOutputPath(options.outputPath);
  await prepareOutputPathForWrite(outPath);
  await fs.writeFile(outPath, `${JSON.stringify(dossier, null, 2)}\n`, { encoding: "utf-8", mode: 0o644 });
  return dossier;
}

function assertOutputPath(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw failure("PROPOSITION_P0B2_OUTPUT_REQUIRED", "--out must be an explicit preview dossier path outside /home/worker/.abrain");
  const outPath = path.resolve(value);
  if (outPath === PROPOSITION_P0B2_HARD_ABRAIN_REALPATH || isPathInside(PROPOSITION_P0B2_HARD_ABRAIN_REALPATH, outPath)) {
    throw failure("PROPOSITION_P0B2_OUTPUT_IN_ABRAIN", "preview dossier output must not be written under the real abrain home", { outPath });
  }
  return outPath;
}

async function prepareOutputPathForWrite(outPath: string): Promise<void> {
  const parent = path.dirname(outPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o755 });
  const realAbrain = await fs.realpath(PROPOSITION_P0B2_HARD_ABRAIN_REALPATH).catch(() => PROPOSITION_P0B2_HARD_ABRAIN_REALPATH);
  const parentReal = await fs.realpath(parent);
  if (parentReal === realAbrain || isPathInside(realAbrain, parentReal)) {
    throw failure("PROPOSITION_P0B2_OUTPUT_IN_ABRAIN", "preview dossier output parent resolves under the real abrain home", { outPath, parentReal, realAbrain });
  }
  const stat = await fs.lstat(outPath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_OUTPUT_SYMLINK_REJECTED", "preview dossier output must not be a symlink", { outPath });
  if (!stat.isFile()) throw failure("PROPOSITION_P0B2_OUTPUT_NON_REGULAR", "preview dossier output must be a regular file when it exists", { outPath });
  const outReal = await fs.realpath(outPath);
  if (outReal === realAbrain || isPathInside(realAbrain, outReal)) {
    throw failure("PROPOSITION_P0B2_OUTPUT_IN_ABRAIN", "preview dossier output resolves under the real abrain home", { outPath, outReal, realAbrain });
  }
}

function parseCausalAnchor(value: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "string" || !value.trim()) throw failure("PROPOSITION_P0B2_CAUSAL_ANCHOR_REQUIRED", "--causal-anchor is required for production preview evidence");
  const raw = value.trim();
  if (!raw.includes("<causal_anchor") || !/session_id="[^"]+"/.test(raw) || !/turn_id="[^"]+"/.test(raw)) {
    throw failure("PROPOSITION_P0B2_CAUSAL_ANCHOR_REQUIRED", "--causal-anchor must include a causal_anchor element with session_id and turn_id", { raw_sha256: sha256Hex(raw) });
  }
  return deepFreeze({
    raw,
    raw_sha256: sha256Hex(raw),
    session_id: matchAttr(raw, "session_id"),
    turn_id: matchAttr(raw, "turn_id"),
    subturn: matchAttr(raw, "subturn"),
    sub_agent_label: matchAttr(raw, "sub_agent_label"),
  });
}

async function resolveHardProductionAbrainHome(input: string): Promise<{ resolved: string; realpath: string }> {
  if (typeof input !== "string" || !input.trim()) throw failure("PROPOSITION_P0B2_REAL_TARGET_REQUIRED", "--abrain /home/worker/.abrain is required");
  const resolved = path.resolve(input);
  if (resolved !== PROPOSITION_P0B2_HARD_ABRAIN_REALPATH) {
    throw failure("PROPOSITION_P0B2_REAL_TARGET_REQUIRED", "P0b2 production preview is hard-limited to --abrain /home/worker/.abrain", { actual: resolved });
  }
  await assertExistingDirectoryChainNoSymlinkReadonly(path.parse(resolved).root, resolved, { allowMissingTail: false });
  const stat = await fs.lstat(resolved).catch((err: unknown) => {
    throw failure("PROPOSITION_P0B2_REAL_TARGET_REQUIRED", "hard production abrain path must exist", { error: errorMessage(err) });
  });
  if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", "hard production abrain path must not be a symlink", { path: resolved });
  if (!stat.isDirectory()) throw failure("PROPOSITION_P0B2_NON_DIRECTORY", "hard production abrain path must be a directory", { path: resolved });
  const realpath = await fs.realpath(resolved);
  if (realpath !== PROPOSITION_P0B2_HARD_ABRAIN_REALPATH) {
    throw failure("PROPOSITION_P0B2_REAL_TARGET_REQUIRED", "production preview requires realpath /home/worker/.abrain", { resolved, realpath });
  }
  return { resolved, realpath };
}

async function assertReadonlyTargetPathPreflight(abrainHome: string, tuple: FixedProductionPropositionGenesisTuple): Promise<Readonly<Record<string, unknown>>> {
  const expectedTarget = expectedL1EventPath(abrainHome, tuple.event_id);
  if (tuple.target_path !== expectedTarget) throw failure("PROPOSITION_P0B2_TARGET_MISMATCH", "target path does not derive from event_id and hard abrain home", { expectedTarget, actual: tuple.target_path });
  if (!isPathInside(abrainHome, tuple.target_path)) throw failure("PROPOSITION_P0B2_PATH_ESCAPE", "target path escapes hard abrain home", { targetPath: tuple.target_path });
  const parent = path.dirname(tuple.target_path);
  const chain = await assertExistingDirectoryChainNoSymlinkReadonly(abrainHome, parent, { allowMissingTail: true });
  const stat = await fs.lstat(tuple.target_path).catch((err: unknown) => {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  });
  if (stat) {
    throw failure("PROPOSITION_P0B2_TARGET_EXISTS", "production preview requires the future genesis target to be absent", { targetPath: tuple.target_path });
  }
  return deepFreeze({
    ok: true,
    abrain_home: abrainHome,
    target_path: tuple.target_path,
    relative_path: tuple.relative_path,
    target_absent: true,
    parent_path: parent,
    parent_exists: chain.missing.length === 0,
    missing_parent_components: chain.missing,
    checked_existing_directories: chain.checked,
    created_directories: [],
    created_files: [],
  });
}

async function assertExistingDirectoryChainNoSymlinkReadonly(root: string, targetDir: string, options: { allowMissingTail: boolean }): Promise<{ checked: string[]; missing: string[] }> {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(targetDir);
  const relative = path.relative(rootResolved, targetResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("PROPOSITION_P0B2_PATH_ESCAPE", "directory chain escapes root", { root: rootResolved, targetDir: targetResolved });
  const checked: string[] = [];
  let current = rootResolved;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", `symlink in directory chain: ${current}`);
  if (!rootStat.isDirectory()) throw failure("PROPOSITION_P0B2_NON_DIRECTORY", `directory chain root is not a directory: ${current}`);
  checked.push(current);
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    const stat = await fs.lstat(current).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat) {
      if (!options.allowMissingTail) throw failure("PROPOSITION_P0B2_PATH_MISSING", `missing directory in chain: ${current}`);
      return { checked, missing: components.slice(index) };
    }
    if (stat.isSymbolicLink()) throw failure("PROPOSITION_P0B2_SYMLINK_REJECTED", `symlink in directory chain: ${current}`);
    if (!stat.isDirectory()) throw failure("PROPOSITION_P0B2_NON_DIRECTORY", `directory chain component is not a directory: ${current}`);
    checked.push(current);
  }
  return { checked, missing: [] };
}

async function collectBeforeInventory(abrainHome: string, registry: L1SchemaRoleRegistry, tuple: FixedProductionPropositionGenesisTuple): Promise<Readonly<Record<string, unknown>>> {
  const scan = await scanWholeL1Validated({ abrainHome, registry });
  const l1Ids = scan.all.map((record) => record.eventId).sort(compareCodeUnits);
  const l1Paths = scan.all.map((record) => record.relativePath ?? "").sort(compareCodeUnits);
  const surfaces = {
    l2: await collectSurface(abrainHome, ["l2"]),
    state: await collectSurface(abrainHome, [".state"]),
    rules: await collectSurface(abrainHome, ["rules", ...projectChildSurfaceRoots(abrainHome, "rules")]),
    knowledge: await collectSurface(abrainHome, ["knowledge", ...projectChildSurfaceRoots(abrainHome, "knowledge")]),
    projects_relevant_surfaces: await collectSurface(abrainHome, ["projects"]),
  };
  return deepFreeze({
    generated_before_preview_write: true,
    l1_existing_ids: {
      count: l1Ids.length,
      ids_sha256: jcsSha256Hex(l1Ids),
      relative_paths_sha256: jcsSha256Hex(l1Paths),
      ids: l1Ids,
    },
    surfaces,
    combined_snapshot_sha256: jcsSha256Hex({ l1Ids, l1Paths, surfaces }),
    target_preimage: {
      target_path: tuple.target_path,
      relative_path: tuple.relative_path,
      existed_before: fss.existsSync(tuple.target_path),
    },
    scan_summary: summarizePropositionGenesisScan(scan),
  });
}

function projectChildSurfaceRoots(abrainHome: string, childName: string): string[] {
  const projectsRoot = path.join(abrainHome, "projects");
  if (!fss.existsSync(projectsRoot)) return [];
  return fss.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fss.existsSync(path.join(projectsRoot, entry.name, childName)))
    .map((entry) => `projects/${entry.name}/${childName}`)
    .sort(compareCodeUnits);
}

async function collectSurface(root: string, relativeRoots: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
  const entries: Array<Readonly<Record<string, unknown>>> = [];
  const roots: string[] = [];
  for (const rel of relativeRoots) {
    const full = path.join(root, ...rel.split("/"));
    if (!fss.existsSync(full)) continue;
    roots.push(rel);
    await walkInventoryRoot(root, full, entries);
  }
  entries.sort((left, right) => compareCodeUnits(String(left.path), String(right.path)));
  return deepFreeze({
    roots,
    exists: roots.length > 0,
    entry_count: entries.length,
    entries_sha256: jcsSha256Hex(entries),
    entries,
  });
}

async function walkInventoryRoot(root: string, full: string, out: Array<Readonly<Record<string, unknown>>>): Promise<void> {
  const stat = await fs.lstat(full);
  const rel = path.relative(root, full).split(path.sep).join("/");
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(full);
    out.push(deepFreeze({ path: rel, type: "symlink", link_target: link, link_target_sha256: sha256Hex(link) }));
    return;
  }
  if (stat.isDirectory()) {
    out.push(deepFreeze({ path: rel, type: "directory" }));
    const children = (await fs.readdir(full, { withFileTypes: true })).map((entry) => entry.name).sort(compareCodeUnits);
    for (const child of children) await walkInventoryRoot(root, path.join(full, child), out);
    return;
  }
  if (stat.isFile()) {
    out.push(deepFreeze({ path: rel, type: "file", size: stat.size, sha256: sha256Hex(await fs.readFile(full)) }));
    return;
  }
  out.push(deepFreeze({ path: rel, type: "other" }));
}

function assertZeroPropositionEventsAndEpochUnique(records: readonly ValidatedL1ScanRecord[], tuple: FixedProductionPropositionGenesisTuple): Readonly<Record<string, unknown>> {
  const productionGenesis = records.filter((record) => isProductionGenesisRecord(record));
  const epochs = productionGenesis.map((record) => String((record.body.epoch as Record<string, unknown>).epoch_id)).sort(compareCodeUnits);
  if (records.length !== 0) {
    throw failure("PROPOSITION_P0B2_PROPOSITION_EVENTS_PRESENT", "production preview requires zero existing proposition events in the real abrain", {
      propositionCount: records.length,
      productionGenesisCount: productionGenesis.length,
      epochs,
      expectedEpoch: tuple.epoch_id,
    });
  }
  return deepFreeze({
    ok: true,
    proposition_event_count: 0,
    production_genesis_count: 0,
    existing_epoch_ids: epochs,
    expected_epoch_id: PROPOSITION_PRODUCTION_GENESIS_EPOCH_ID,
    expected_event_id: tuple.event_id,
  });
}

function isProductionGenesisRecord(record: ValidatedL1ScanRecord): boolean {
  return record.registration.envelope_schema === PROPOSITION_GENESIS_ENVELOPE_SCHEMA
    && isRecord(record.body.epoch)
    && record.body.epoch.genesis_scope === "production"
    && isRecord(record.body.contract)
    && record.body.contract.kind === "production_genesis";
}

async function verifySandboxEquivalence(tuple: FixedProductionPropositionGenesisTuple, registryPath: string): Promise<Readonly<Record<string, unknown>>> {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-proposition-p0b2-equivalence-"));
  let payload: Record<string, unknown> | null = null;
  try {
    const result = await writeProductionPropositionGenesis({ sandboxAbrainHome: sandbox, registryPath });
    const raw = await fs.readFile(result.tuple.target_path, "utf-8");
    const ok = result.tuple.event_id === tuple.event_id
      && result.tuple.envelope.body_hash === tuple.envelope.body_hash
      && result.tuple.canonical_envelope_json === tuple.canonical_envelope_json
      && raw === tuple.canonical_envelope_json;
    if (!ok) throw failure("PROPOSITION_P0B2_SANDBOX_EQUIVALENCE_FAILED", "sandbox writer bytes did not match production preview tuple", { sandboxEventId: result.tuple.event_id, previewEventId: tuple.event_id });
    payload = {
      ok: true,
      sandbox_abrain_home: sandbox,
      sandbox_write_status: result.status,
      sandbox_event_id: result.tuple.event_id,
      preview_event_id: tuple.event_id,
      event_id_equal: result.tuple.event_id === tuple.event_id,
      body_hash_equal: result.tuple.envelope.body_hash === tuple.envelope.body_hash,
      canonical_bytes_sha256: sha256Hex(raw),
      canonical_bytes_equal: raw === tuple.canonical_envelope_json,
      selected_zero: result.after.selected === 0,
      foldable_zero: result.after.foldable === 0,
      proposition_summary_after: result.after,
    };
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
  if (!payload) throw failure("PROPOSITION_P0B2_SANDBOX_EQUIVALENCE_FAILED", "sandbox equivalence did not produce a result");
  return deepFreeze({ ...payload, removed_after: !fss.existsSync(sandbox) });
}

async function expectCode(fn: () => Promise<unknown>): Promise<Readonly<Record<string, unknown>>> {
  try {
    await fn();
    return deepFreeze({ ok: false, code: null, message: "operation unexpectedly succeeded" });
  } catch (err) {
    return deepFreeze({
      ok: true,
      code: errorCode(err),
      message: errorMessage(err),
    });
  }
}

function runSmokeEvidence(repoRoot: string): Readonly<Record<string, unknown>> {
  return deepFreeze({
    p0a: runSmoke(repoRoot, "scripts/smoke-proposition-p0a.mjs"),
    p0b1: runSmoke(repoRoot, "scripts/smoke-proposition-p0b1.mjs"),
  });
}

function skippedSmokeEvidence(): Readonly<Record<string, unknown>> {
  return deepFreeze({
    p0a: { skipped: true, reason: "includeSmokeEvidence=false" },
    p0b1: { skipped: true, reason: "includeSmokeEvidence=false" },
  });
}

function runSmoke(repoRoot: string, script: string): Readonly<Record<string, unknown>> {
  const result = spawnSync(process.execPath, [path.join(repoRoot, script)], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return deepFreeze({
    command: `node ${script}`,
    status: result.status,
    signal: result.signal,
    ok: result.status === 0,
    stdout_sha256: sha256Hex(result.stdout ?? ""),
    stderr_sha256: sha256Hex(result.stderr ?? ""),
    stdout_tail: tail(result.stdout ?? ""),
    stderr_tail: tail(result.stderr ?? ""),
  });
}

function selfHashDossier(dossier: PropositionProductionPreviewDossier): string {
  const clone = JSON.parse(JSON.stringify(dossier));
  delete clone.dossier_hash;
  return jcsSha256Hex(clone);
}

function tail(value: string): string {
  const lines = value.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - 12)).join("\n");
}

function matchAttr(raw: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]+)"`).exec(raw);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(code: string, message: string, detail?: Record<string, unknown>): PropositionProductionPreviewError {
  return new PropositionProductionPreviewError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
