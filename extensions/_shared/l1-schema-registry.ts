import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { isPropositionEnvelopeSchema, validatePropositionBodyForEnvelope } from "./proposition";

export type L1SchemaDomain = "knowledge" | "constraint" | "canonical_path" | "proposition";
export type L1SchemaRole = "canonical" | "evidence" | "meta";
export type L1SchemaPhase = "active" | "legacy_read_only" | "phase_disabled" | "defined_inactive";

export interface L1SchemaRegistration {
  envelope_schema: string;
  body_schema?: string;
  domain: L1SchemaDomain;
  role: L1SchemaRole;
  phase: L1SchemaPhase;
  write_enabled: boolean;
  fold_eligible: boolean;
  event_types?: readonly string[];
  producers?: readonly string[];
  body_domain_path?: string;
}

export interface L1SchemaRoleRegistry {
  schema_version: "l1-schema-role-registry/v1";
  registry_id: string;
  storage: {
    root_relative_path: "l1/events/sha256";
    canonicalization: "RFC8785-JCS";
    hash_algorithm: "sha256";
    shard_width: 2;
    shard_depth: 2;
    file_extension: ".json";
  };
  entries: readonly L1SchemaRegistration[];
}

export interface L1SchemaLookup {
  envelopeSchema?: string;
  bodySchema?: string;
  domain?: L1SchemaDomain;
  role?: L1SchemaRole;
  producer?: string;
  eventType?: string;
  phase?: L1SchemaPhase;
}

export interface L1EnvelopeExpectation extends L1SchemaLookup {
  requireWriteEnabled?: boolean;
}

export interface ValidatedL1Envelope {
  envelope: Readonly<Record<string, unknown>>;
  body: Readonly<Record<string, unknown>>;
  registration: L1SchemaRegistration;
  eventId: string;
  bodyHash: string;
  envelopeHash: string;
  relativePath?: string;
  filePath?: string;
}

export type L1ScanClassification = "selected" | "foreign-skip" | "legacy-read-only" | "phase-disabled-shadow" | "defined-inactive-shadow";

export interface ValidatedL1ScanRecord extends ValidatedL1Envelope {
  classification: L1ScanClassification;
}

export interface WholeL1ScanOptions {
  abrainHome: string;
  registry?: L1SchemaRoleRegistry;
  registryPath?: string;
  domains?: readonly L1SchemaDomain[];
  roles?: readonly L1SchemaRole[];
  maxEventBytes?: number;
}

export interface WholeL1ScanResult {
  all: readonly ValidatedL1ScanRecord[];
  selected: readonly ValidatedL1ScanRecord[];
  foldable: readonly ValidatedL1ScanRecord[];
  foreignSkipped: readonly ValidatedL1ScanRecord[];
  legacyReadOnly: readonly ValidatedL1ScanRecord[];
  phaseDisabledShadow: readonly ValidatedL1ScanRecord[];
  definedInactiveShadow: readonly ValidatedL1ScanRecord[];
  /**
   * Crash residue of the durable atomic write protocol (`.{name}.….tmp`
   * dotfiles that never got renamed into place). These are not events and
   * never enter validation or folds; they are surfaced for diagnostics only.
   * Any other non-conforming name still fails the whole scan closed.
   */
  tempResidue: readonly string[];
}

interface L1ScanFileSystem {
  readdir(dir: string, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
  lstat(file: string): Promise<fs.Stats>;
  realpath(file: string): Promise<string>;
  readFile(file: string, encoding: BufferEncoding): Promise<string>;
}

const nodeL1ScanFileSystem: L1ScanFileSystem = {
  readdir: (dir, options) => fsp.readdir(dir, options),
  lstat: (file) => fsp.lstat(file),
  realpath: (file) => fsp.realpath(file),
  readFile: (file, encoding) => fsp.readFile(file, encoding),
};

export class L1SchemaRegistryError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "L1SchemaRegistryError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function defaultL1SchemaRegistryPath(): string {
  // Repo layout: extensions/_shared/ → <repo>/schemas/. Staged-transpile
  // layout (smoke scripts stage extensions/* into a temp root): _shared/ →
  // <stage>/schemas/. Resolve whichever exists; fail closed when neither does.
  const candidates = [
    path.resolve(__dirname, "..", "..", "schemas", "l1-schema-role-registry.json"),
    path.resolve(__dirname, "..", "schemas", "l1-schema-role-registry.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export function loadL1SchemaRegistry(registryPath = defaultL1SchemaRegistryPath()): L1SchemaRoleRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch (err) {
    throw failure("L1_REGISTRY_LOAD_FAILED", `cannot load registry ${registryPath}`, { error: errorMessage(err) });
  }
  return validateL1SchemaRegistry(parsed);
}

export function validateL1SchemaRegistry(input: unknown): L1SchemaRoleRegistry {
  const root = record(input, "L1_REGISTRY_INVALID", "registry must be an object");
  exactString(root.schema_version, "l1-schema-role-registry/v1", "schema_version");
  nonEmptyString(root.registry_id, "registry_id");
  const storage = record(root.storage, "L1_REGISTRY_INVALID", "storage must be an object");
  exactString(storage.root_relative_path, "l1/events/sha256", "storage.root_relative_path");
  exactString(storage.canonicalization, "RFC8785-JCS", "storage.canonicalization");
  exactString(storage.hash_algorithm, "sha256", "storage.hash_algorithm");
  exactNumber(storage.shard_width, 2, "storage.shard_width");
  exactNumber(storage.shard_depth, 2, "storage.shard_depth");
  exactString(storage.file_extension, ".json", "storage.file_extension");
  if (!Array.isArray(root.entries) || root.entries.length === 0) {
    throw failure("L1_REGISTRY_INVALID", "entries must be a non-empty array");
  }

  const envelopeSchemas = new Set<string>();
  const bodySchemas = new Set<string>();
  const entries = root.entries.map((raw, index): L1SchemaRegistration => {
    const at = `entries[${index}]`;
    const item = record(raw, "L1_REGISTRY_INVALID", `${at} must be an object`);
    const envelopeSchema = versionedName(item.envelope_schema, `${at}.envelope_schema`);
    if (envelopeSchemas.has(envelopeSchema)) throw failure("L1_REGISTRY_DUPLICATE", `duplicate envelope schema ${envelopeSchema}`);
    envelopeSchemas.add(envelopeSchema);
    const domain = oneOf(item.domain, ["knowledge", "constraint", "canonical_path", "proposition"] as const, `${at}.domain`);
    const role = oneOf(item.role, ["canonical", "evidence", "meta"] as const, `${at}.role`);
    const phase = oneOf(item.phase, ["active", "legacy_read_only", "phase_disabled", "defined_inactive"] as const, `${at}.phase`);
    const writeEnabled = boolean(item.write_enabled, `${at}.write_enabled`);
    const foldEligible = boolean(item.fold_eligible, `${at}.fold_eligible`);
    const bodySchema = item.body_schema === undefined ? undefined : versionedName(item.body_schema, `${at}.body_schema`);
    const eventTypes = item.event_types === undefined ? undefined : uniqueStrings(item.event_types, `${at}.event_types`);
    const producers = item.producers === undefined ? undefined : uniqueStrings(item.producers, `${at}.producers`);
    const bodyDomainPath = item.body_domain_path === undefined ? undefined : dottedPath(item.body_domain_path, `${at}.body_domain_path`);

    if (phase === "active" || phase === "legacy_read_only" || phase === "defined_inactive") {
      if (!bodySchema || !eventTypes?.length || !producers?.length) {
        throw failure("L1_REGISTRY_INVALID", `${at} registered body contract requires body_schema, event_types, and producers`);
      }
      if (phase === "active" && !writeEnabled) throw failure("L1_REGISTRY_INVALID", `${at} active registration must enable writes`);
      if (phase === "legacy_read_only" && (writeEnabled || foldEligible || role !== "meta")) {
        throw failure("L1_REGISTRY_INVALID", `${at} legacy-read-only registration must be non-writable, non-foldable meta`);
      }
      if (phase === "defined_inactive" && (writeEnabled || foldEligible)) {
        throw failure("L1_REGISTRY_INVALID", `${at} defined-inactive registration must be non-writable and non-foldable`);
      }
      if (bodySchemas.has(bodySchema)) throw failure("L1_REGISTRY_DUPLICATE", `duplicate body schema ${bodySchema}`);
      bodySchemas.add(bodySchema);
    } else {
      if (role !== "meta" || writeEnabled || foldEligible) {
        throw failure("L1_REGISTRY_INVALID", `${at} phase-disabled registration must be non-writable, non-foldable meta`);
      }
      if (bodySchema || eventTypes || producers || bodyDomainPath) {
        throw failure("L1_REGISTRY_INVALID", `${at} phase-disabled meta declaration must not invent an unapproved body schema, event type, or producer`);
      }
    }

    return {
      envelope_schema: envelopeSchema,
      ...(bodySchema ? { body_schema: bodySchema } : {}),
      domain,
      role,
      phase,
      write_enabled: writeEnabled,
      fold_eligible: foldEligible,
      ...(eventTypes ? { event_types: eventTypes } : {}),
      ...(producers ? { producers } : {}),
      ...(bodyDomainPath ? { body_domain_path: bodyDomainPath } : {}),
    };
  });

  return deepFreeze({
    schema_version: "l1-schema-role-registry/v1" as const,
    registry_id: root.registry_id as string,
    storage: {
      root_relative_path: "l1/events/sha256" as const,
      canonicalization: "RFC8785-JCS" as const,
      hash_algorithm: "sha256" as const,
      shard_width: 2 as const,
      shard_depth: 2 as const,
      file_extension: ".json" as const,
    },
    entries,
  });
}

export function lookupL1SchemaRoles(registry: L1SchemaRoleRegistry, query: L1SchemaLookup = {}): readonly L1SchemaRegistration[] {
  return Object.freeze(registry.entries.filter((entry) => (
    (query.envelopeSchema === undefined || entry.envelope_schema === query.envelopeSchema)
    && (query.bodySchema === undefined || entry.body_schema === query.bodySchema)
    && (query.domain === undefined || entry.domain === query.domain)
    && (query.role === undefined || entry.role === query.role)
    && (query.producer === undefined || entry.producers?.includes(query.producer) === true)
    && (query.eventType === undefined || entry.event_types?.includes(query.eventType) === true)
    && (query.phase === undefined || entry.phase === query.phase)
  )));
}

export function resolveL1EnvelopeSchema(registry: L1SchemaRoleRegistry, envelopeSchema: string): L1SchemaRegistration {
  const matches = lookupL1SchemaRoles(registry, { envelopeSchema });
  if (matches.length !== 1) {
    throw failure("L1_SCHEMA_UNKNOWN", `envelope schema is not registered: ${envelopeSchema}`, { matches: matches.length });
  }
  return matches[0]!;
}

export function canonicalL1BodyHash(body: unknown): string {
  return jcsSha256Hex(body);
}

export function canonicalL1EnvelopeHash(envelope: unknown): string {
  return jcsSha256Hex(envelope);
}

export function canonicalL1EnvelopeJson(envelope: unknown): string {
  return `${canonicalizeJcs(envelope)}\n`;
}

export function expectedL1EventRelativePath(eventId: string): string {
  assertSha256(eventId, "event id");
  return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

export function expectedL1EventPath(abrainHome: string, eventId: string): string {
  return path.resolve(abrainHome, ...expectedL1EventRelativePath(eventId).split("/"));
}

export function validateL1Envelope(
  input: unknown,
  options: {
    registry: L1SchemaRoleRegistry;
    abrainHome?: string;
    filePath?: string;
    relativePath?: string;
    expected?: L1EnvelopeExpectation;
  },
): ValidatedL1Envelope {
  const envelope = record(input, "L1_ENVELOPE_INVALID", "envelope must be an object");
  const schema = nonEmptyString(envelope.schema, "envelope.schema");
  const registration = resolveL1EnvelopeSchema(options.registry, schema);
  exactString(envelope.canonicalization, options.registry.storage.canonicalization, "envelope.canonicalization", "L1_HASH_METADATA_MISMATCH");
  exactString(envelope.hash_alg, options.registry.storage.hash_algorithm, "envelope.hash_alg", "L1_HASH_METADATA_MISMATCH");
  const eventId = assertSha256(envelope.event_id, "envelope.event_id");
  const bodyHash = assertSha256(envelope.body_hash, "envelope.body_hash");
  if (eventId !== bodyHash) throw failure("L1_HASH_MISMATCH", "event_id must equal body_hash", { eventId, bodyHash });
  const body = record(envelope.body, "L1_ENVELOPE_INVALID", "envelope.body must be an object");
  const computedBodyHash = canonicalL1BodyHash(body);
  if (computedBodyHash !== bodyHash) {
    throw failure("L1_HASH_MISMATCH", "body_hash does not match RFC8785/JCS body hash", { expected: bodyHash, actual: computedBodyHash });
  }

  if (registration.phase === "active" || registration.phase === "legacy_read_only" || registration.phase === "defined_inactive") validateActiveBodyContract(body, registration);
  if (isPropositionEnvelopeSchema(registration.envelope_schema)) {
    try {
      validatePropositionBodyForEnvelope(registration.envelope_schema, body);
    } catch (err) {
      throw failure("L1_BODY_SHAPE_MISMATCH", "proposition body contract validation failed", {
        error: errorMessage(err),
        propositionCode: err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "unknown",
      });
    }
  }
  if (registration.envelope_schema === "drain-recovery-envelope/v1") validateDrainRecoveryBody(body, 1);
  if (registration.envelope_schema === "local-drain-recovery-envelope/v2") validateDrainRecoveryBody(body, 2);
  validateExpectation(registration, body, options.expected);

  const expectedRelative = expectedL1EventRelativePath(eventId);
  const normalizedRelative = options.relativePath?.split(/[\\/]+/).join("/");
  if (normalizedRelative !== undefined && normalizedRelative !== expectedRelative) {
    throw failure("L1_PATH_MISMATCH", "event shard, filename, or relative path does not match event_id", { expected: expectedRelative, actual: normalizedRelative });
  }
  let normalizedFilePath: string | undefined;
  if (options.filePath !== undefined) {
    if (!options.abrainHome) throw failure("L1_PATH_MISMATCH", "abrainHome is required when filePath is supplied");
    normalizedFilePath = path.resolve(options.filePath);
    const expectedPath = expectedL1EventPath(options.abrainHome, eventId);
    if (normalizedFilePath !== expectedPath) {
      throw failure("L1_PATH_MISMATCH", "absolute event path does not match event_id", { expected: expectedPath, actual: normalizedFilePath });
    }
  }

  return deepFreeze({
    envelope,
    body,
    registration,
    eventId,
    bodyHash,
    envelopeHash: canonicalL1EnvelopeHash(envelope),
    ...(normalizedRelative ? { relativePath: normalizedRelative } : {}),
    ...(normalizedFilePath ? { filePath: normalizedFilePath } : {}),
  });
}

export async function validateL1WritePreflight(options: {
  abrainHome: string;
  envelope: unknown;
  targetPath: string;
  registry?: L1SchemaRoleRegistry;
  registryPath?: string;
  expected?: L1EnvelopeExpectation;
}): Promise<ValidatedL1Envelope> {
  const registry = options.registry ?? loadL1SchemaRegistry(options.registryPath);
  const abrainHome = path.resolve(options.abrainHome);
  const targetPath = path.resolve(options.targetPath);
  const relativePath = relativeUnix(abrainHome, targetPath);
  const validated = validateL1Envelope(options.envelope, {
    registry,
    abrainHome,
    filePath: targetPath,
    relativePath,
    expected: { ...options.expected, requireWriteEnabled: true },
  });
  await assertWritePathNoSymlink(abrainHome, targetPath);
  return validated;
}

export async function scanWholeL1Validated(options: WholeL1ScanOptions): Promise<WholeL1ScanResult> {
  return scanWholeL1ValidatedWithFileSystem(options, nodeL1ScanFileSystem);
}

async function scanWholeL1ValidatedWithFileSystem(options: WholeL1ScanOptions, scanFs: L1ScanFileSystem): Promise<WholeL1ScanResult> {
  const registry = options.registry ?? loadL1SchemaRegistry(options.registryPath);
  const abrainHome = path.resolve(options.abrainHome);
  const root = path.resolve(abrainHome, ...registry.storage.root_relative_path.split("/"));
  const maxEventBytes = options.maxEventBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) throw failure("L1_SCAN_INVALID_OPTIONS", "maxEventBytes must be a positive safe integer");
  if (!(await exists(root, scanFs))) return emptyScanResult();
  const rootReal = await assertExistingDirectoryChainNoSymlink(abrainHome, root, scanFs);
  const { files, tempResidue } = await listContentAddressedFiles(root, rootReal, scanFs);
  const records: ValidatedL1ScanRecord[] = [];
  const seenEventIds = new Set<string>();

  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = await scanFs.lstat(file);
    } catch (err) {
      if (isEnoent(err)) throw failure("L1_EVENT_DISAPPEARED", `selected event disappeared during scan: ${relativeUnix(abrainHome, file)}`, { error: errorMessage(err) });
      throw err;
    }
    if (!stat.isFile()) throw failure("L1_NON_REGULAR", `event path is not a regular file: ${file}`);
    if (stat.size > maxEventBytes) throw failure("L1_EVENT_TOO_LARGE", `event exceeds ${maxEventBytes} bytes: ${file}`, { size: stat.size });
    let real: string;
    try {
      real = await scanFs.realpath(file);
    } catch (err) {
      if (isEnoent(err)) throw failure("L1_EVENT_DISAPPEARED", `selected event disappeared during realpath: ${relativeUnix(abrainHome, file)}`, { error: errorMessage(err) });
      throw err;
    }
    if (!isPathInside(rootReal, real)) throw failure("L1_PATH_ESCAPE", `event realpath escapes L1 root: ${file}`, { real });
    const relativePath = relativeUnix(abrainHome, file);
    let raw: string;
    try {
      raw = await scanFs.readFile(file, "utf-8");
    } catch (err) {
      if (isEnoent(err)) throw failure("L1_EVENT_DISAPPEARED", `selected event disappeared during read: ${relativePath}`, { error: errorMessage(err) });
      throw failure("L1_ENVELOPE_INVALID", `event could not be read: ${relativePath}`, { error: errorMessage(err) });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw failure("L1_ENVELOPE_INVALID", `event is not valid JSON: ${relativePath}`, { error: errorMessage(err) });
    }
    const validated = validateL1Envelope(parsed, { registry, abrainHome, filePath: file, relativePath });
    if (seenEventIds.has(validated.eventId)) throw failure("L1_EVENT_DUPLICATE", `duplicate event id ${validated.eventId}`);
    seenEventIds.add(validated.eventId);
    const classification = classifyScanRecord(validated.registration, options);
    records.push(deepFreeze({ ...validated, classification }));
  }

  validateLegacyRecoveryCohorts(records);
  records.sort((left, right) => compareCodeUnits(left.relativePath ?? "", right.relativePath ?? ""));
  const all = Object.freeze(records.slice());
  const selected = Object.freeze(all.filter((item) => item.classification === "selected"));
  const result: WholeL1ScanResult = {
    all,
    selected,
    foldable: Object.freeze(selected.filter((item) => item.registration.fold_eligible)),
    foreignSkipped: Object.freeze(all.filter((item) => item.classification === "foreign-skip")),
    legacyReadOnly: Object.freeze(all.filter((item) => item.classification === "legacy-read-only")),
    phaseDisabledShadow: Object.freeze(all.filter((item) => item.classification === "phase-disabled-shadow")),
    definedInactiveShadow: Object.freeze(all.filter((item) => item.classification === "defined-inactive-shadow")),
    tempResidue: Object.freeze(tempResidue.slice().sort(compareCodeUnits)),
  };
  return deepFreeze(result);
}

function validateActiveBodyContract(body: Record<string, unknown>, registration: L1SchemaRegistration): void {
  if (body.event_schema_version !== registration.body_schema) {
    throw failure("L1_SCHEMA_ROLE_MISMATCH", "body schema does not match registered envelope role", { envelopeSchema: registration.envelope_schema, expected: registration.body_schema, actual: body.event_schema_version });
  }
  if (typeof body.event_type !== "string" || !registration.event_types?.includes(body.event_type)) {
    throw failure("L1_EVENT_TYPE_MISMATCH", "event type is not registered for envelope schema", { envelopeSchema: registration.envelope_schema, actual: body.event_type });
  }
  const producer = record(body.producer, "L1_PRODUCER_MISMATCH", "body.producer must be an object");
  const producerName = nonEmptyString(producer.name, "body.producer.name", "L1_PRODUCER_MISMATCH");
  nonEmptyString(producer.version, "body.producer.version", "L1_PRODUCER_MISMATCH");
  if (!registration.producers?.includes(producerName)) {
    throw failure("L1_PRODUCER_MISMATCH", "producer is not registered for envelope schema", { envelopeSchema: registration.envelope_schema, producer: producerName });
  }
  if (registration.body_domain_path) {
    const actualDomain = readDotted(body, registration.body_domain_path);
    if (actualDomain !== registration.domain) {
      throw failure("L1_SCHEMA_ROLE_MISMATCH", "body domain does not match registered envelope domain", { path: registration.body_domain_path, expected: registration.domain, actual: actualDomain });
    }
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw failure("L1_BODY_SHAPE_MISMATCH", `${at} has unexpected keys`, { actual, expected: wanted });
  }
}

function recoveryString(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw failure("L1_BODY_SHAPE_MISMATCH", `${at} is invalid`);
  }
  return value;
}

/** Lexical, clone-neutral path contract shared by recovery schema validation,
 * exact-cohort preparation, and restart decoding. */
export function isCanonicalCohortPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && segments[0] !== ".git";
}

function validatePreparedEntries(value: unknown, at: string, requireSorted: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw failure("L1_BODY_SHAPE_MISMATCH", `${at} must be a non-empty array`);
  const paths: string[] = [];
  let previous: string | null = null;
  for (const [index, raw] of value.entries()) {
    const entry = record(raw, "L1_BODY_SHAPE_MISMATCH", `${at}[${index}] must be an object`);
    exactKeys(entry, ["path", "op", "mode", "blobOid", "bytesSha256"], `${at}[${index}]`);
    const rel = recoveryString(entry.path, `${at}[${index}].path`);
    if (!isCanonicalCohortPath(rel) || (previous !== null && (rel === previous || (requireSorted && compareCodeUnits(previous, rel) >= 0)))) {
      throw failure("L1_BODY_SHAPE_MISMATCH", `${at}[${index}].path is not canonical, unique, and sorted`);
    }
    if (!requireSorted && paths.includes(rel)) throw failure("L1_BODY_SHAPE_MISMATCH", `${at}[${index}].path is duplicated`);
    paths.push(rel);
    previous = rel;
    if (entry.op === "put") {
      if ((entry.mode !== "100644" && entry.mode !== "100755") || typeof entry.blobOid !== "string" || !/^[0-9a-f]{40,64}$/.test(entry.blobOid) || typeof entry.bytesSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.bytesSha256)) {
        throw failure("L1_BODY_SHAPE_MISMATCH", `${at}[${index}] put fields are invalid`);
      }
    } else if (entry.op === "delete") {
      if (entry.mode !== "000000" || entry.blobOid !== "" || entry.bytesSha256 !== "") throw failure("L1_BODY_SHAPE_MISMATCH", `${at}[${index}] delete fields are invalid`);
    } else throw failure("L1_BODY_SHAPE_MISMATCH", `${at}[${index}].op is invalid`);
  }
  return Object.freeze(paths);
}

const LEGACY_RECOVERY_EPISODE_DOMAIN = "pi-astack/adr0027-c6/recovery-episode/v1";
const LEGACY_PUSH_EPISODE_V2_DOMAIN = "pi-astack/adr0027-c6/push-episode/v2";
const LEGACY_RECOVERY_CLAIM_DOMAIN = "pi-astack/adr0027-c6/recovery-claim/v1";
const LOCAL_RECOVERY_CLAIM_DOMAIN = "pi-astack/local-drain/recovery-claim/v2";
const PUSH_SCOPE_KEYS = ["repo_id", "remote", "ref_name", "target_commit", "remote_url_id", "transport_policy_id"] as const;
const PUSH_OUTCOME_V2_KEYS = [
  "classification", "command_exit_code", "error_code", "ref_name", "remote", "remote_contains_target",
  "remote_ref_after", "remote_ref_before", "remote_url_id", "repo_id", "stage", "stderr_redacted_sha256",
  "stdout_redacted_sha256", "target_commit", "transport_attempted", "transport_policy_id",
] as const;

function validateRecoveryRemote(value: unknown, at: string, pinned = false): string {
  const remote = recoveryString(value, at);
  if (remote.length > 4096 || /[\x00-\x1f\x7f]/.test(remote) || (pinned && remote !== "origin")) throw failure("L1_BODY_SHAPE_MISMATCH", `${at} is invalid`);
  return remote;
}

function validateRecoveryRef(value: unknown, at: string, pinned = false): string {
  const ref = recoveryString(value, at, /^refs\/(?:heads|tags)\/[A-Za-z0-9._\/-]+$/);
  if (ref.includes("..") || ref.endsWith("/") || (pinned && ref !== "refs/heads/main")) throw failure("L1_BODY_SHAPE_MISMATCH", `${at} is invalid`);
  return ref;
}

function validateLegacyRemoteScope(payload: Record<string, unknown>, at: string): void {
  for (const key of ["repo_id", "remote_url_id", "transport_policy_id"]) recoveryString(payload[key], `${at}.${key}`, /^[0-9a-f]{64}$/);
  validateRecoveryRemote(payload.remote, `${at}.remote`, true);
  validateRecoveryRef(payload.ref_name, `${at}.ref_name`, true);
  recoveryString(payload.target_commit, `${at}.target_commit`, /^[0-9a-f]{40,64}$/);
}

function validateDrainRecoveryBody(body: Record<string, unknown>, version: 1 | 2): void {
  exactKeys(body, ["event_schema_version", "event_type", "producer", "episode_id", "lane", "slot", "body"], "recovery event");
  const expectedSchema = version === 1 ? "drain-recovery-event/v1" : "local-drain-recovery-event/v2";
  exactString(body.event_schema_version, expectedSchema, "recovery event.event_schema_version", "L1_SCHEMA_ROLE_MISMATCH");
  const producer = record(body.producer, "L1_PRODUCER_MISMATCH", "recovery event.producer must be an object");
  exactKeys(producer, ["name", "version"], "recovery event.producer");
  exactString(producer.name, "pi-astack.convergence-recovery", "recovery event.producer.name", "L1_PRODUCER_MISMATCH");
  exactString(producer.version, version === 1 ? "1.0.0" : "2.0.0", "recovery event.producer.version", "L1_PRODUCER_MISMATCH");
  const episodeId = recoveryString(body.episode_id, "recovery event.episode_id", /^[0-9a-f]{64}$/);
  const lane = body.lane;
  if (version === 2 ? lane !== "drain" : lane !== "drain" && lane !== "push" && lane !== "curator") throw failure("L1_BODY_SHAPE_MISMATCH", "recovery event.lane is invalid");
  const slot = body.slot;
  if (!Number.isInteger(slot) || (slot as number) < 1 || (slot as number) > (lane === "curator" ? 3 : 5)) throw failure("L1_BODY_SHAPE_MISMATCH", "recovery event.slot is invalid");
  const payload = record(body.body, "L1_BODY_SHAPE_MISMATCH", "recovery event.body must be an object");
  const eventType = recoveryString(body.event_type, "recovery event.event_type");
  const oid = (value: unknown, at: string) => recoveryString(value, at, /^[0-9a-f]{40,64}$/);
  const hash = (value: unknown, at: string) => recoveryString(value, at, /^[0-9a-f]{64}$/);
  const common = eventType === "recovery_slot_claimed" || eventType === "recovery_slot_aborted" || eventType === "recovery_episode_terminal";
  const drain = eventType === "commit_prepared" || eventType === "commit_published" || eventType === "index_converged";
  const push = eventType === "push_intent" || eventType === "push_outcome" || eventType === "push_terminal_resolution_candidate" || eventType === "push_terminal_resolution_attestation";
  if (!common && !(lane === "drain" && drain) && !(version === 1 && lane === "push" && push)) throw failure("L1_BODY_SHAPE_MISMATCH", `${eventType} is invalid for lane ${String(lane)}`);

  if (eventType === "recovery_slot_claimed") {
    exactKeys(payload, ["claim_id"], "recovery claim body");
    const domain = version === 1 ? LEGACY_RECOVERY_CLAIM_DOMAIN : LOCAL_RECOVERY_CLAIM_DOMAIN;
    const expected = jcsSha256Hex({ domain, episode_id: episodeId, lane, slot });
    if (payload.claim_id !== expected) throw failure("L1_BODY_SHAPE_MISMATCH", "claim_id does not derive from episode/lane/slot");
    return;
  }
  if (eventType === "recovery_slot_aborted") {
    exactKeys(payload, ["reason", "error_code"], "recovery abort body");
    if (payload.reason !== "recovery_slot_aborted" || payload.error_code !== "RECOVERY_SLOT_ABORTED") throw failure("L1_BODY_SHAPE_MISMATCH", "recovery abort body is invalid");
    return;
  }
  if (eventType === "recovery_episode_terminal") {
    exactKeys(payload, ["reason", "owner_alert"], "recovery terminal body");
    if (payload.reason !== "owner_intervention_required" || payload.owner_alert !== true) throw failure("L1_BODY_SHAPE_MISMATCH", "recovery terminal body is invalid");
    return;
  }
  if (eventType === "commit_published") {
    exactKeys(payload, ["candidate", "publication_confirmed"], "commit_published body"); oid(payload.candidate, "candidate");
    if (payload.publication_confirmed !== true) throw failure("L1_BODY_SHAPE_MISMATCH", "publication_confirmed must be true");
    return;
  }
  if (eventType === "index_converged") {
    exactKeys(payload, ["candidate"], "index_converged body"); oid(payload.candidate, "candidate");
    return;
  }
  if (eventType === "commit_prepared") {
    const keys = version === 1
      ? ["repo", "ref_name", "frozen_commit", "new_tree", "candidate", "cohort_manifest_root", "entries", "frozen_index_snapshot"]
      : ["symbolic_ref", "frozen_commit", "new_tree", "candidate", "cohort_manifest_root", "entries", "frozen_index_snapshot"];
    exactKeys(payload, keys, "commit_prepared body");
    if (version === 1 && !path.isAbsolute(recoveryString(payload.repo, "repo"))) throw failure("L1_BODY_SHAPE_MISMATCH", "legacy repo must be absolute");
    const symbolic = recoveryString(version === 1 ? payload.ref_name : payload.symbolic_ref, "symbolic ref", /^refs\/[A-Za-z0-9._\/-]+$|^HEAD$/);
    if (symbolic.includes("..") || symbolic.endsWith("/")) throw failure("L1_BODY_SHAPE_MISMATCH", "symbolic ref is invalid");
    oid(payload.frozen_commit, "frozen_commit"); oid(payload.new_tree, "new_tree"); oid(payload.candidate, "candidate"); hash(payload.cohort_manifest_root, "cohort_manifest_root");
    const entryPaths = validatePreparedEntries(payload.entries, "entries", version === 2);
    const entrySet = new Set(entryPaths);
    const snapshot = record(payload.frozen_index_snapshot, "L1_BODY_SHAPE_MISMATCH", "frozen_index_snapshot must be an object");
    const snapshotKeys = Object.keys(snapshot);
    if (snapshotKeys.some((key) => !isCanonicalCohortPath(key) || !entrySet.has(key))) throw failure("L1_BODY_SHAPE_MISMATCH", "frozen_index_snapshot contains a non-cohort or non-canonical path");
    if (version === 2 && (snapshotKeys.length !== entryPaths.length || entryPaths.some((key) => !Object.hasOwn(snapshot, key)))) throw failure("L1_BODY_SHAPE_MISMATCH", "active frozen_index_snapshot keys must exactly equal entries paths");
    for (const [key, value] of Object.entries(snapshot)) {
      if (version === 2 && value === null) continue;
      recoveryString(value, `frozen_index_snapshot.${key}`, /^(?:100644|100755|120000|160000) [0-9a-f]{40,64} 0$/);
    }
    return;
  }
  if (version === 2) throw failure("L1_EVENT_TYPE_MISMATCH", `event type is not valid for local drain v2: ${eventType}`);

  if (eventType === "push_intent") {
    if (Object.hasOwn(payload, "scope_version")) {
      exactKeys(payload, ["scope_version", ...PUSH_SCOPE_KEYS], "push_intent v2 body");
      if (payload.scope_version !== "remote-scope/v2") throw failure("L1_BODY_SHAPE_MISMATCH", "scope_version is invalid");
      validateLegacyRemoteScope(payload, "push_intent");
      const scope = Object.fromEntries(PUSH_SCOPE_KEYS.map((key) => [key, payload[key]]));
      if (episodeId !== jcsSha256Hex({ domain: LEGACY_PUSH_EPISODE_V2_DOMAIN, scope_version: "remote-scope/v2", ...scope })) throw failure("L1_BODY_SHAPE_MISMATCH", "v2 push intent does not derive episode_id");
    } else {
      exactKeys(payload, ["repo", "remote", "ref_name", "target_commit"], "push_intent v1 body");
      const repo = recoveryString(payload.repo, "repo");
      if (!path.isAbsolute(repo)) throw failure("L1_BODY_SHAPE_MISMATCH", "push repo must be absolute");
      const remote = validateRecoveryRemote(payload.remote, "remote");
      const refName = validateRecoveryRef(payload.ref_name, "ref_name");
      const targetCommit = oid(payload.target_commit, "target_commit");
      const identity = { repo_id: sha256Hex(path.resolve(repo)), remote, ref_name: refName, target_commit: targetCommit };
      if (episodeId !== jcsSha256Hex({ domain: LEGACY_RECOVERY_EPISODE_DOMAIN, lane: "push", identity })) throw failure("L1_BODY_SHAPE_MISMATCH", "legacy push intent does not derive episode_id");
    }
    if (slot !== 1) throw failure("L1_BODY_SHAPE_MISMATCH", "push intent must use slot 1");
    return;
  }
  if (eventType === "push_outcome") {
    const classification = payload.classification;
    if (classification !== "success" && classification !== "retryable" && classification !== "nonretryable") throw failure("L1_BODY_SHAPE_MISMATCH", "push classification is invalid");
    if (Object.keys(payload).length === 2) {
      exactKeys(payload, ["classification", "target_commit"], "push_outcome v1 body");
      oid(payload.target_commit, "target_commit");
      return;
    }
    exactKeys(payload, PUSH_OUTCOME_V2_KEYS, "push_outcome v2 body");
    validateLegacyRemoteScope(payload, "push_outcome");
    if (typeof payload.transport_attempted !== "boolean" || typeof payload.remote_contains_target !== "boolean") throw failure("L1_BODY_SHAPE_MISMATCH", "push outcome booleans are invalid");
    if (payload.command_exit_code !== null && !Number.isSafeInteger(payload.command_exit_code)) throw failure("L1_BODY_SHAPE_MISMATCH", "command_exit_code must be an integer or null");
    for (const key of ["stdout_redacted_sha256", "stderr_redacted_sha256"]) if (payload[key] !== null) hash(payload[key], key);
    for (const key of ["remote_ref_before", "remote_ref_after"]) if (payload[key] !== null) oid(payload[key], key);
    recoveryString(payload.stage, "stage");
    if (payload.error_code !== null) recoveryString(payload.error_code, "error_code");
    const commandEvidence = [payload.command_exit_code, payload.stdout_redacted_sha256, payload.stderr_redacted_sha256];
    if (commandEvidence.some((value) => value === null) && commandEvidence.some((value) => value !== null)) throw failure("L1_BODY_SHAPE_MISMATCH", "command exit/stdout/stderr evidence must be all null or all present");
    if (classification === "success" ? payload.remote_contains_target !== true || payload.error_code !== null || payload.remote_ref_after === null : payload.remote_contains_target !== false || payload.error_code === null) throw failure("L1_BODY_SHAPE_MISMATCH", "push outcome status fields contradict classification");
    return;
  }
  if (eventType === "push_terminal_resolution_candidate") {
    exactKeys(payload, ["legacy_episode_id", "legacy_intent_event_id", "legacy_terminal_event_id", "scope_version", ...PUSH_SCOPE_KEYS], "legacy candidate body");
    for (const key of ["legacy_episode_id", "legacy_intent_event_id", "legacy_terminal_event_id"]) hash(payload[key], key);
    if (payload.legacy_episode_id !== episodeId || payload.scope_version !== "remote-scope/v2") throw failure("L1_BODY_SHAPE_MISMATCH", "candidate episode/scope binding is invalid");
    validateLegacyRemoteScope(payload, "legacy candidate");
    return;
  }
  if (eventType === "push_terminal_resolution_attestation") {
    exactKeys(payload, ["candidate_event_id", "observed_tip", "relation"], "legacy attestation body"); hash(payload.candidate_event_id, "candidate_event_id"); oid(payload.observed_tip, "observed_tip");
    if (payload.relation !== "equal" && payload.relation !== "descendant") throw failure("L1_BODY_SHAPE_MISMATCH", "attestation relation is invalid");
    return;
  }
  throw failure("L1_EVENT_TYPE_MISMATCH", `unknown legacy recovery event type: ${eventType}`);
}

function validateLegacyRecoveryCohorts(records: readonly ValidatedL1ScanRecord[]): void {
  const legacy = records.filter((record) => record.registration.envelope_schema === "drain-recovery-envelope/v1");
  const byId = new Map(legacy.map((record) => [record.eventId, record]));
  const byEpisode = new Map<string, ValidatedL1ScanRecord[]>();
  for (const record of legacy) {
    const episodeId = String(record.body.episode_id);
    byEpisode.set(episodeId, [...(byEpisode.get(episodeId) ?? []), record]);
  }
  for (const [episodeId, events] of byEpisode) {
    const pushIntent = events.find((record) => record.body.event_type === "push_intent");
    const intentBody = pushIntent ? record(pushIntent.body.body, "L1_BODY_SHAPE_MISMATCH", "push intent body must be an object") : null;
    const preparedBySlot = new Map(events.filter((item) => item.body.event_type === "commit_prepared").map((item) => [item.body.slot as number, record(item.body.body, "L1_BODY_SHAPE_MISMATCH", "prepared body must be an object")]));
    for (const event of events) {
      const eventType = String(event.body.event_type);
      const slot = event.body.slot as number;
      const payload = record(event.body.body, "L1_BODY_SHAPE_MISMATCH", "legacy recovery payload must be an object");
      if (eventType === "commit_published" || eventType === "index_converged") {
        const prepared = preparedBySlot.get(slot);
        if (prepared && payload.candidate !== prepared.candidate) throw failure("L1_BODY_SHAPE_MISMATCH", `${eventType} candidate does not match commit_prepared`);
      }
      if (eventType === "push_outcome") {
        if (!intentBody) throw failure("L1_BODY_SHAPE_MISMATCH", "push outcome has no durable intent in its episode");
        if (payload.target_commit !== intentBody.target_commit) throw failure("L1_BODY_SHAPE_MISMATCH", "push outcome target does not match durable intent");
        if (Object.hasOwn(payload, "repo_id")) {
          if (!Object.hasOwn(intentBody, "scope_version") || PUSH_SCOPE_KEYS.some((key) => payload[key] !== intentBody[key])) throw failure("L1_BODY_SHAPE_MISMATCH", "push outcome scope does not match durable intent");
        }
      }
      if (eventType === "push_terminal_resolution_candidate") {
        const intent = byId.get(String(payload.legacy_intent_event_id));
        const terminal = byId.get(String(payload.legacy_terminal_event_id));
        if (!intent || intent.body.event_type !== "push_intent" || intent.body.episode_id !== episodeId || !terminal || terminal.body.event_type !== "recovery_episode_terminal" || terminal.body.episode_id !== episodeId) throw failure("L1_BODY_SHAPE_MISMATCH", "resolution candidate IDs do not bind the exact legacy intent/terminal cohort");
        const boundIntent = record(intent.body.body, "L1_BODY_SHAPE_MISMATCH", "bound intent body must be an object");
        if (payload.target_commit !== boundIntent.target_commit || payload.remote !== boundIntent.remote || payload.ref_name !== boundIntent.ref_name) throw failure("L1_BODY_SHAPE_MISMATCH", "resolution candidate target/remote/ref do not match legacy intent");
        if (typeof boundIntent.repo === "string" && payload.repo_id !== sha256Hex(path.resolve(boundIntent.repo))) throw failure("L1_BODY_SHAPE_MISMATCH", "resolution candidate repo_id does not derive from recorded legacy repo");
      }
      if (eventType === "push_terminal_resolution_attestation") {
        const candidate = byId.get(String(payload.candidate_event_id));
        if (!candidate || candidate.body.event_type !== "push_terminal_resolution_candidate" || candidate.body.episode_id !== episodeId || candidate.body.slot !== slot) throw failure("L1_BODY_SHAPE_MISMATCH", "resolution attestation does not bind an exact candidate in its episode/slot");
        const candidateBody = record(candidate.body.body, "L1_BODY_SHAPE_MISMATCH", "candidate body must be an object");
        if ((payload.relation === "equal" && payload.observed_tip !== candidateBody.target_commit) || (payload.relation === "descendant" && payload.observed_tip === candidateBody.target_commit)) throw failure("L1_BODY_SHAPE_MISMATCH", "resolution attestation relation contradicts observed_tip/target");
      }
    }
  }
}

function validateExpectation(registration: L1SchemaRegistration, body: Record<string, unknown>, expected: L1EnvelopeExpectation | undefined): void {
  if (!expected) return;
  const actualProducer = isRecord(body.producer) && typeof body.producer.name === "string" ? body.producer.name : undefined;
  const actualEventType = typeof body.event_type === "string" ? body.event_type : undefined;
  const checks: Array<[string, unknown, unknown]> = [
    ["envelope schema", expected.envelopeSchema, registration.envelope_schema],
    ["body schema", expected.bodySchema, registration.body_schema],
    ["domain", expected.domain, registration.domain],
    ["role", expected.role, registration.role],
    ["phase", expected.phase, registration.phase],
    ["producer", expected.producer, actualProducer],
    ["event type", expected.eventType, actualEventType],
  ];
  for (const [label, wanted, actual] of checks) {
    if (wanted !== undefined && wanted !== actual) throw failure("L1_SCHEMA_ROLE_MISMATCH", `${label} does not match writer/scanner expectation`, { expected: wanted, actual });
  }
  if (expected.requireWriteEnabled && (registration.phase !== "active" || !registration.write_enabled)) {
    throw failure("L1_SCHEMA_WRITE_DISABLED", `schema is not enabled for writes: ${registration.envelope_schema}`, { phase: registration.phase });
  }
}

function classifyScanRecord(registration: L1SchemaRegistration, options: WholeL1ScanOptions): L1ScanClassification {
  if (registration.phase === "phase_disabled") return "phase-disabled-shadow";
  if (registration.phase === "defined_inactive") return "defined-inactive-shadow";
  if (registration.phase === "legacy_read_only") return "legacy-read-only";
  const domainMatch = !options.domains?.length || options.domains.includes(registration.domain);
  const roleMatch = !options.roles?.length || options.roles.includes(registration.role);
  return domainMatch && roleMatch ? "selected" : "foreign-skip";
}

const DURABLE_WRITE_TEMP_RESIDUE = /^\.[0-9a-f]{64}\.json\.\d+\.\d+\.[0-9a-f]+\.tmp$/;
const CANONICAL_L1_EVENT_LEAF = /^[0-9a-f]{64}\.json$/;

async function listContentAddressedFiles(root: string, rootReal: string, scanFs: L1ScanFileSystem): Promise<{ files: string[]; tempResidue: string[] }> {
  const files: string[] = [];
  const tempResidue: string[] = [];
  const first = await sortedDirents(root, scanFs);
  for (const firstShard of first) {
    const firstPath = path.join(root, firstShard.name);
    await assertShardDirectory(firstShard, firstPath, rootReal, 1, scanFs);
    const second = await sortedDiscoveredShardDirents(firstPath, 1, scanFs);
    for (const secondShard of second) {
      const secondPath = path.join(firstPath, secondShard.name);
      await assertShardDirectory(secondShard, secondPath, rootReal, 2, scanFs);
      const leaves = await sortedDiscoveredShardDirents(secondPath, 2, scanFs);
      for (const leaf of leaves) {
        const file = path.join(secondPath, leaf.name);
        if (DURABLE_WRITE_TEMP_RESIDUE.test(leaf.name)) {
          const stat = await lstatIfPresent(file, scanFs);
          if (!stat) continue;
          if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in L1 event tree: ${file}`);
          if (!stat.isFile()) throw failure("L1_NON_REGULAR", `non-regular entry in L1 event shard: ${file}`);
          tempResidue.push(file);
          continue;
        }
        if (!CANONICAL_L1_EVENT_LEAF.test(leaf.name)) throw failure("L1_PATH_MISMATCH", `invalid L1 event filename: ${file}`);
        let stat: fs.Stats;
        try {
          stat = await scanFs.lstat(file);
        } catch (err) {
          if (isEnoent(err)) throw failure("L1_EVENT_DISAPPEARED", `canonical event disappeared during discovery: ${file}`, { error: errorMessage(err) });
          throw err;
        }
        if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in L1 event tree: ${file}`);
        if (!stat.isFile()) throw failure("L1_NON_REGULAR", `non-regular entry in L1 event shard: ${file}`);
        files.push(file);
      }
    }
  }
  return { files, tempResidue };
}

async function assertShardDirectory(entry: fs.Dirent, fullPath: string, rootReal: string, depth: number, scanFs: L1ScanFileSystem): Promise<void> {
  if (!/^[0-9a-f]{2}$/.test(entry.name)) throw failure("L1_PATH_MISMATCH", `invalid shard name at depth ${depth}: ${fullPath}`);
  let stat: fs.Stats;
  try {
    stat = await scanFs.lstat(fullPath);
  } catch (err) {
    if (isEnoent(err)) throw failure("L1_EVENT_DISAPPEARED", `discovered canonical shard disappeared during depth ${depth} validation: ${fullPath}`, { error: errorMessage(err) });
    throw err;
  }
  if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in L1 shard tree: ${fullPath}`);
  if (!stat.isDirectory()) throw failure("L1_NON_REGULAR", `expected shard directory at depth ${depth}: ${fullPath}`);
  let real: string;
  try {
    real = await scanFs.realpath(fullPath);
  } catch (err) {
    if (isEnoent(err)) throw failure("L1_EVENT_DISAPPEARED", `discovered canonical shard disappeared during depth ${depth} realpath: ${fullPath}`, { error: errorMessage(err) });
    throw err;
  }
  if (!isPathInside(rootReal, real)) throw failure("L1_PATH_ESCAPE", `shard realpath escapes L1 root: ${fullPath}`, { real });
}

async function assertExistingDirectoryChainNoSymlink(abrainHome: string, root: string, scanFs: L1ScanFileSystem): Promise<string> {
  const relative = path.relative(abrainHome, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("L1_PATH_ESCAPE", "L1 root escapes abrainHome");
  let current = abrainHome;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = await scanFs.lstat(current);
    if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in L1 root chain: ${current}`);
    if (!stat.isDirectory()) throw failure("L1_NON_REGULAR", `L1 root component is not a directory: ${current}`);
  }
  const abrainReal = await scanFs.realpath(abrainHome);
  const rootReal = await scanFs.realpath(root);
  if (!isPathInside(abrainReal, rootReal)) throw failure("L1_PATH_ESCAPE", "L1 root realpath escapes abrainHome", { rootReal, abrainReal });
  return rootReal;
}

async function assertWritePathNoSymlink(abrainHome: string, targetPath: string): Promise<void> {
  const relative = path.relative(abrainHome, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw failure("L1_PATH_ESCAPE", "write target escapes abrainHome", { targetPath });
  const rootStat = await fsp.lstat(abrainHome).catch((err: unknown) => { throw failure("L1_PATH_GUARD_FAILED", "abrainHome must exist before write preflight", { error: errorMessage(err) }); });
  if (rootStat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `abrainHome is a symlink: ${abrainHome}`);
  if (!rootStat.isDirectory()) throw failure("L1_NON_REGULAR", `abrainHome is not a directory: ${abrainHome}`);
  const abrainReal = await fsp.realpath(abrainHome);
  let current = abrainHome;
  const components = relative.split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") break;
      throw err;
    }
    if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in write target chain: ${current}`);
    const isLeaf = index === components.length - 1;
    if (isLeaf ? !stat.isFile() : !stat.isDirectory()) throw failure("L1_NON_REGULAR", `unexpected file type in write target chain: ${current}`);
    const real = await fsp.realpath(current);
    if (!isPathInside(abrainReal, real)) throw failure("L1_PATH_ESCAPE", `write target realpath escapes abrainHome: ${current}`, { real });
  }
}

function emptyScanResult(): WholeL1ScanResult {
  const empty = Object.freeze([]) as readonly ValidatedL1ScanRecord[];
  return deepFreeze({ all: empty, selected: empty, foldable: empty, foreignSkipped: empty, legacyReadOnly: empty, phaseDisabledShadow: empty, definedInactiveShadow: empty, tempResidue: Object.freeze([]) as readonly string[] });
}

function failure(code: string, message: string, detail?: Record<string, unknown>): L1SchemaRegistryError {
  return new L1SchemaRegistryError(code, message, detail);
}

function record(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw failure(code, message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, at: string, code = "L1_REGISTRY_INVALID"): string {
  if (typeof value !== "string" || !value.trim()) throw failure(code, `${at} must be a non-empty string`);
  return value;
}

function versionedName(value: unknown, at: string): string {
  const text = nonEmptyString(value, at);
  if (!/^[a-z0-9][a-z0-9-]*\/v[1-9][0-9]*$/.test(text)) throw failure("L1_REGISTRY_INVALID", `${at} must be a versioned schema name`);
  return text;
}

function dottedPath(value: unknown, at: string): string {
  const text = nonEmptyString(value, at);
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/.test(text)) throw failure("L1_REGISTRY_INVALID", `${at} must be a dotted body path`);
  return text;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw failure("L1_REGISTRY_INVALID", `${at} must be boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], at: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw failure("L1_REGISTRY_INVALID", `${at} must be one of ${values.join(", ")}`);
  return value as T;
}

function uniqueStrings(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw failure("L1_REGISTRY_INVALID", `${at} must be a non-empty string array`);
  const strings = value.map((item, index) => nonEmptyString(item, `${at}[${index}]`));
  if (new Set(strings).size !== strings.length) throw failure("L1_REGISTRY_DUPLICATE", `${at} contains duplicates`);
  return Object.freeze(strings);
}

function exactString(value: unknown, expected: string, at: string, code = "L1_REGISTRY_INVALID"): void {
  if (value !== expected) throw failure(code, `${at} must equal ${expected}`, { actual: value });
}

function exactNumber(value: unknown, expected: number, at: string): void {
  if (value !== expected) throw failure("L1_REGISTRY_INVALID", `${at} must equal ${expected}`, { actual: value });
}

function assertSha256(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure("L1_HASH_MISMATCH", `${at} must be lowercase SHA-256 hex`);
  return value;
}

function readDotted(value: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = value;
  for (const part of dotted.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function relativeUnix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sortedDirents(dir: string, scanFs: L1ScanFileSystem): Promise<fs.Dirent[]> {
  return (await scanFs.readdir(dir, { withFileTypes: true })).sort((left: fs.Dirent, right: fs.Dirent) => compareCodeUnits(left.name, right.name));
}

async function sortedDiscoveredShardDirents(dir: string, depth: number, scanFs: L1ScanFileSystem): Promise<fs.Dirent[]> {
  try {
    return await sortedDirents(dir, scanFs);
  } catch (err) {
    if (isEnoent(err)) throw failure("L1_EVENT_DISAPPEARED", `discovered canonical shard disappeared before depth ${depth} contents could be read: ${dir}`, { error: errorMessage(err) });
    throw err;
  }
}

async function lstatIfPresent(file: string, scanFs: L1ScanFileSystem): Promise<fs.Stats | null> {
  try {
    return await scanFs.lstat(file);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function exists(file: string, scanFs: L1ScanFileSystem): Promise<boolean> {
  try {
    await scanFs.lstat(file);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return false;
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

function isEnoent(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export { sha256Hex };

export const __TEST = {
  scanWholeL1ValidatedWithFileSystem,
  nodeL1ScanFileSystem,
};
