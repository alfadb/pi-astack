import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";

export type L1SchemaDomain = "knowledge" | "constraint" | "canonical_path";
export type L1SchemaRole = "canonical" | "evidence" | "meta";
export type L1SchemaPhase = "active" | "phase_disabled";

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

export type L1ScanClassification = "selected" | "foreign-skip" | "phase-disabled-shadow";

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
  phaseDisabledShadow: readonly ValidatedL1ScanRecord[];
  /**
   * Crash residue of the durable atomic write protocol (`.{name}.….tmp`
   * dotfiles that never got renamed into place). These are not events and
   * never enter validation or folds; they are surfaced for diagnostics only.
   * Any other non-conforming name still fails the whole scan closed.
   */
  tempResidue: readonly string[];
}

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
    const domain = oneOf(item.domain, ["knowledge", "constraint", "canonical_path"] as const, `${at}.domain`);
    const role = oneOf(item.role, ["canonical", "evidence", "meta"] as const, `${at}.role`);
    const phase = oneOf(item.phase, ["active", "phase_disabled"] as const, `${at}.phase`);
    const writeEnabled = boolean(item.write_enabled, `${at}.write_enabled`);
    const foldEligible = boolean(item.fold_eligible, `${at}.fold_eligible`);
    const bodySchema = item.body_schema === undefined ? undefined : versionedName(item.body_schema, `${at}.body_schema`);
    const eventTypes = item.event_types === undefined ? undefined : uniqueStrings(item.event_types, `${at}.event_types`);
    const producers = item.producers === undefined ? undefined : uniqueStrings(item.producers, `${at}.producers`);
    const bodyDomainPath = item.body_domain_path === undefined ? undefined : dottedPath(item.body_domain_path, `${at}.body_domain_path`);

    if (phase === "active") {
      if (!bodySchema || !eventTypes?.length || !producers?.length) {
        throw failure("L1_REGISTRY_INVALID", `${at} active registration requires body_schema, event_types, and producers`);
      }
      if (!writeEnabled) throw failure("L1_REGISTRY_INVALID", `${at} active registration must enable existing writes`);
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

  if (registration.phase === "active") validateActiveBodyContract(body, registration);
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
  const registry = options.registry ?? loadL1SchemaRegistry(options.registryPath);
  const abrainHome = path.resolve(options.abrainHome);
  const root = path.resolve(abrainHome, ...registry.storage.root_relative_path.split("/"));
  const maxEventBytes = options.maxEventBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) throw failure("L1_SCAN_INVALID_OPTIONS", "maxEventBytes must be a positive safe integer");
  if (!(await exists(root))) return emptyScanResult();
  const rootReal = await assertExistingDirectoryChainNoSymlink(abrainHome, root);
  const { files, tempResidue } = await listContentAddressedFiles(root, rootReal);
  const records: ValidatedL1ScanRecord[] = [];
  const seenEventIds = new Set<string>();

  for (const file of files) {
    const stat = await fsp.lstat(file);
    if (!stat.isFile()) throw failure("L1_NON_REGULAR", `event path is not a regular file: ${file}`);
    if (stat.size > maxEventBytes) throw failure("L1_EVENT_TOO_LARGE", `event exceeds ${maxEventBytes} bytes: ${file}`, { size: stat.size });
    const real = await fsp.realpath(file);
    if (!isPathInside(rootReal, real)) throw failure("L1_PATH_ESCAPE", `event realpath escapes L1 root: ${file}`, { real });
    const relativePath = relativeUnix(abrainHome, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(file, "utf-8"));
    } catch (err) {
      throw failure("L1_ENVELOPE_INVALID", `event is not valid JSON: ${relativePath}`, { error: errorMessage(err) });
    }
    const validated = validateL1Envelope(parsed, { registry, abrainHome, filePath: file, relativePath });
    if (seenEventIds.has(validated.eventId)) throw failure("L1_EVENT_DUPLICATE", `duplicate event id ${validated.eventId}`);
    seenEventIds.add(validated.eventId);
    const classification = classifyScanRecord(validated.registration, options);
    records.push(deepFreeze({ ...validated, classification }));
  }

  records.sort((left, right) => (left.relativePath ?? "").localeCompare(right.relativePath ?? ""));
  const all = Object.freeze(records.slice());
  const selected = Object.freeze(all.filter((item) => item.classification === "selected"));
  const result: WholeL1ScanResult = {
    all,
    selected,
    foldable: Object.freeze(selected.filter((item) => item.registration.fold_eligible)),
    foreignSkipped: Object.freeze(all.filter((item) => item.classification === "foreign-skip")),
    phaseDisabledShadow: Object.freeze(all.filter((item) => item.classification === "phase-disabled-shadow")),
    tempResidue: Object.freeze(tempResidue.slice().sort()),
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
  const domainMatch = !options.domains?.length || options.domains.includes(registration.domain);
  const roleMatch = !options.roles?.length || options.roles.includes(registration.role);
  return domainMatch && roleMatch ? "selected" : "foreign-skip";
}

const DURABLE_WRITE_TEMP_RESIDUE = /^\.[0-9a-f]{64}\.json\.\d+\.\d+\.[0-9a-f]+\.tmp$/;

async function listContentAddressedFiles(root: string, rootReal: string): Promise<{ files: string[]; tempResidue: string[] }> {
  const files: string[] = [];
  const tempResidue: string[] = [];
  const first = await sortedDirents(root);
  for (const firstShard of first) {
    const firstPath = path.join(root, firstShard.name);
    await assertShardDirectory(firstShard, firstPath, rootReal, 1);
    const second = await sortedDirents(firstPath);
    for (const secondShard of second) {
      const secondPath = path.join(firstPath, secondShard.name);
      await assertShardDirectory(secondShard, secondPath, rootReal, 2);
      const leaves = await sortedDirents(secondPath);
      for (const leaf of leaves) {
        const file = path.join(secondPath, leaf.name);
        const stat = await fsp.lstat(file);
        if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in L1 event tree: ${file}`);
        if (!stat.isFile()) throw failure("L1_NON_REGULAR", `non-regular entry in L1 event shard: ${file}`);
        if (DURABLE_WRITE_TEMP_RESIDUE.test(leaf.name)) {
          tempResidue.push(file);
          continue;
        }
        if (!/^[0-9a-f]{64}\.json$/.test(leaf.name)) throw failure("L1_PATH_MISMATCH", `invalid L1 event filename: ${file}`);
        files.push(file);
      }
    }
  }
  return { files, tempResidue };
}

async function assertShardDirectory(entry: fs.Dirent, fullPath: string, rootReal: string, depth: number): Promise<void> {
  const stat = await fsp.lstat(fullPath);
  if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in L1 shard tree: ${fullPath}`);
  if (!stat.isDirectory()) throw failure("L1_NON_REGULAR", `expected shard directory at depth ${depth}: ${fullPath}`);
  if (!/^[0-9a-f]{2}$/.test(entry.name)) throw failure("L1_PATH_MISMATCH", `invalid shard name at depth ${depth}: ${fullPath}`);
  const real = await fsp.realpath(fullPath);
  if (!isPathInside(rootReal, real)) throw failure("L1_PATH_ESCAPE", `shard realpath escapes L1 root: ${fullPath}`, { real });
}

async function assertExistingDirectoryChainNoSymlink(abrainHome: string, root: string): Promise<string> {
  const relative = path.relative(abrainHome, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("L1_PATH_ESCAPE", "L1 root escapes abrainHome");
  let current = abrainHome;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) throw failure("L1_SYMLINK_REJECTED", `symlink in L1 root chain: ${current}`);
    if (!stat.isDirectory()) throw failure("L1_NON_REGULAR", `L1 root component is not a directory: ${current}`);
  }
  const abrainReal = await fsp.realpath(abrainHome);
  const rootReal = await fsp.realpath(root);
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
  return deepFreeze({ all: empty, selected: empty, foldable: empty, foreignSkipped: empty, phaseDisabledShadow: empty, tempResidue: Object.freeze([]) as readonly string[] });
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

async function sortedDirents(dir: string): Promise<fs.Dirent[]> {
  return (await fsp.readdir(dir, { withFileTypes: true })).sort((left: fs.Dirent, right: fs.Dirent) => left.name.localeCompare(right.name));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.lstat(file);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return false;
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
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
