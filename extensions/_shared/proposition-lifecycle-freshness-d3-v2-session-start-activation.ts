/// <reference types="node" />
/**
 * ADR0040 D3-v2 session_start activation-object loader (R3.8).
 *
 * Closed-schema bound activation objects live under a controlled activation
 * root. Paths are absolute, walked with NOFOLLOW/identity, and must be exact
 * JCS+LF with self-hash = SHA-256(RFC8785-JCS(base without activation_object_hash)).
 *
 * `validateBoundActivationObjectClosed` is the pure closed-schema validator
 * (no production I/O). Rollback Door1 and any other consumer must reuse it
 * rather than copying a weaker key/selfhash-only check.
 *
 * R3.7/R3.8: `session_id` is forced to a single safe filename component (non-empty,
 * length ≤ 128, ASCII [A-Za-z0-9._-] only; reject '.'/'..' , any /\\, control
 * chars). Builders and full validators share `assertSafeSessionIdComponent`.
 * Generic path components used by `joinUnderRootContained` allow ≤ Linux NAME_MAX
 * (255) so derived names like `${sessionId}.json` / `${sessionId}.jsonl` at the
 * 128-char session-id boundary remain legal. `activation_nonce` remains lowercase
 * SHA-256 hex. Safe join helper `joinUnderRootContained` + path helpers provide
 * containment defense-in-depth so sessionTaintPath/receipt/intents cannot escape
 * stateRoot. `assertResolvedPathContainedUnderRoot` rejects external absolute,
 * sibling, and `..` paths under a disposable root (R3.8 rehearse containment).
 *
 * `activationRootHasNoBoundObject` is the dossier zero-write predicate: scan only
 * inside the dedicated activation root, all regular files (no extension filter),
 * NOFOLLOW size-limited reads; any lstat/readdir/read/parse error fail-closed false;
 * any file with AUTHORIZED/bound/executable=true makes the predicate false.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";

export const D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA =
  "adr0040-d3-v2-session-start-activation-object/v1" as const;
export const D3_V2_SESSION_START_ACTIVATION_TEMPLATE_SCHEMA =
  "adr0040-d3-v2-session-start-activation-object-template/v1" as const;
export const D3_V2_SESSION_START_DEFAULT_ACTIVATION_ROOT = path.join(
  os.homedir(),
  ".pi",
  ".pi-astack",
  "adr0040-d3-v2-session-start",
  "activations",
);
export const D3_V2_SESSION_START_ACTIVATION_MAX_BYTES = 256 * 1024;

/** R3.7/R3.8: max length for session_id (stricter than generic path components). */
export const D3_V2_SESSION_ID_MAX_LENGTH = 128 as const;

/**
 * R3.8: max length for a generic single safe path/filename component.
 * Matches Linux NAME_MAX (255) so derived artifacts like `${sessionId}.jsonl`
 * remain joinable when session_id is at its 128-char bound.
 */
export const D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH = 255 as const;

/** R3.7: closed charset for a single safe path component — ASCII [A-Za-z0-9._-] only. */
export const D3_V2_SAFE_PATH_COMPONENT_RE = /^[A-Za-z0-9._-]+$/;

const HASH = /^[0-9a-f]{64}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

/** Closed-schema keys for settings_mutation (exact equality vs live norm). */
export const D3_V2_SESSION_START_SETTINGS_MUTATION_KEYS = Object.freeze([
  "enabled",
  "selector",
  "expectedSelectionHash",
  "expectedHeadHash",
  "expectedProofHash",
  "expectedStableBundleHash",
  "expectedIntentHash",
  "adapterManifestHash",
  "activationObjectPath",
  "maxReadBytes",
] as const);

const BOUND_KEYS = Object.freeze([
  "schema_version",
  "mode",
  "authorization_status",
  "session_id",
  "activation_nonce",
  "authorization_coordinate",
  "authorization_coordinate_hash",
  "d3_identities",
  "adapter_manifest_hash",
  "settings_mutation",
  "audit_target",
  "rollback_target",
  "session_file",
  "quarantine_target",
  "executable",
] as const);

const TEMPLATE_KEYS = Object.freeze([
  "schema_version",
  "mode",
  "authorization_status",
  "session_id",
  "activation_nonce",
  "authorization_coordinate",
  "authorization_coordinate_hash",
  "d3_identities",
  "adapter_manifest_hash",
  "settings_mutation",
  "audit_target",
  "rollback_target",
  "session_file",
  "quarantine_target",
  "executable",
] as const);

export class D3V2ActivationError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "D3V2ActivationError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface D3V2ActivationSessionFileBinding {
  path: string;
  dev: number;
  ino: number;
  prefix_bytes: number;
  prefix_sha256: string;
}

export interface D3V2ActivationD3Identities {
  selection_hash: string;
  head_hash: string;
  proof_hash: string;
  intent_hash: string;
  stable_bundle_hash: string;
  p2a_bundle_hash: string;
  generation: number;
  selection_seq: number;
}

export interface D3V2BoundActivationObject {
  schema_version: typeof D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA;
  mode: "bound";
  authorization_status: "AUTHORIZED";
  session_id: string;
  activation_nonce: string;
  authorization_coordinate: Readonly<Record<string, unknown>>;
  authorization_coordinate_hash: string;
  d3_identities: D3V2ActivationD3Identities;
  adapter_manifest_hash: string;
  settings_mutation: Readonly<Record<string, unknown>>;
  audit_target: string;
  rollback_target: string;
  session_file: D3V2ActivationSessionFileBinding;
  quarantine_target: string;
  executable: true;
  activation_object_hash: string;
}

export function resolveD3V2SessionStartActivationRoot(override?: string): string {
  const fromEnv = process.env.PI_ASTACK_D3V2_ACTIVATION_ROOT;
  const raw = override
    ?? (typeof fromEnv === "string" && fromEnv.trim() ? fromEnv.trim() : D3_V2_SESSION_START_DEFAULT_ACTIVATION_ROOT);
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

export function computeD3V2ActivationObjectHash(value: Record<string, unknown>): string {
  const base = { ...value };
  delete base.activation_object_hash;
  return jcsSha256Hex(base);
}

/**
 * R3.7/R3.8: assert `value` is a single safe filename component.
 * Non-empty, length ≤ maxLength (default Linux NAME_MAX 255), ASCII [A-Za-z0-9._-]
 * only, reject '.' / '..' / any /\\ / NUL / control chars / multi-component basenames.
 * Session IDs use the stricter `assertSafeSessionIdComponent` (≤128).
 */
export function assertSafeSinglePathComponent(
  value: unknown,
  label = "path_component",
  maxLength: number = D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH,
): asserts value is string {
  if (typeof value !== "string") fail("path_component_invalid", `${label} must be a string`);
  if (value.length === 0) fail("path_component_invalid", `${label} must be non-empty`);
  if (value.length > maxLength) {
    fail("path_component_invalid", `${label} exceeds max length ${maxLength}`);
  }
  if (value === "." || value === "..") {
    fail("path_component_invalid", `${label} must not be '.' or '..'`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    fail("path_component_invalid", `${label} must not contain path separators or NUL`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      fail("path_component_invalid", `${label} must not contain control characters`);
    }
  }
  if (!D3_V2_SAFE_PATH_COMPONENT_RE.test(value)) {
    fail("path_component_invalid", `${label} must be ASCII [A-Za-z0-9._-] only`);
  }
  if (path.basename(value) !== value || path.normalize(value) !== value) {
    fail("path_component_invalid", `${label} must be a single safe basename component`);
  }
}

/**
 * R3.7/R3.8: session_id forced to a single safe filename component (builder + full
 * validator + live selector). Length bound is ≤128 (stricter than NAME_MAX 255).
 */
export function assertSafeSessionIdComponent(sessionId: unknown, label = "session_id"): asserts sessionId is string {
  if (typeof sessionId === "string" && sessionId.length > D3_V2_SESSION_ID_MAX_LENGTH) {
    fail("path_component_invalid", `${label} exceeds max length ${D3_V2_SESSION_ID_MAX_LENGTH}`);
  }
  assertSafeSinglePathComponent(sessionId, label, D3_V2_SESSION_ID_MAX_LENGTH);
}

/**
 * R3.8: non-throwing predicate for live selector / session fail-closed paths.
 * Never throws; unsafe values return false.
 */
export function isSafeSessionIdComponent(value: unknown): value is string {
  try {
    assertSafeSessionIdComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * R3.7: activation_nonce used as a path component must remain lowercase SHA-256 hex
 * (already a strict subset of the safe charset).
 */
export function assertSafeActivationNonceComponent(
  nonce: unknown,
  label = "activation_nonce",
): asserts nonce is string {
  assertSafeSinglePathComponent(nonce, label);
  if (!HASH.test(nonce)) fail("activation_nonce_invalid", `${label} must be lowercase SHA-256 hex`);
}

/**
 * R3.7/R3.8: join one or more safe single components under `root` and assert the
 * resolved result stays inside the resolved root (containment). Rejects any
 * escape via '..', absolute components, or separator injection. Generic components
 * may be up to NAME_MAX (255) so `${sessionId}.json` / `${sessionId}.jsonl` at the
 * session-id 128 boundary pass.
 */
export function joinUnderRootContained(root: string, ...components: string[]): string {
  if (typeof root !== "string" || root.length === 0) {
    fail("path_escape", "joinUnderRootContained root must be a non-empty string");
  }
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  for (const component of components) {
    assertSafeSinglePathComponent(component, "path_component", D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH);
    current = path.join(current, component);
  }
  const resolved = path.resolve(current);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    fail("path_escape", `joined path escapes root: ${resolved} not under ${resolvedRoot}`);
  }
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("path_escape", `joined path escapes root via relative: ${relative}`);
  }
  // Defense: no empty relative when components were supplied and result equals root
  // is only legal when components is empty (not used here for artifact joins).
  return resolved;
}

/**
 * R3.8: assert a resolved candidate path is equal-to or strictly under the
 * resolved disposable root. Rejects external absolute, sibling, and `..` escapes
 * with pure string resolution (no I/O). Used by rehearse to force settings/
 * session/quarantine (+ parents) into the unique sandbox stateRoot before any
 * mkdir/write.
 */
export function assertResolvedPathContainedUnderRoot(
  root: string,
  candidate: string,
  label = "path",
): string {
  if (typeof root !== "string" || root.length === 0) {
    fail("path_escape", `${label}: root must be a non-empty string`);
  }
  if (typeof candidate !== "string" || candidate.length === 0) {
    fail("path_escape", `${label}: path must be a non-empty string`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    fail(
      "path_escape",
      `${label} must be contained under disposable stateRoot: ${resolved} not under ${resolvedRoot}`,
    );
  }
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("path_escape", `${label} escapes stateRoot via relative: ${relative}`);
  }
  return resolved;
}

export function buildD3V2SessionStartActivationObject(args: {
  sessionId: string | null;
  activationNonce: string | null;
  authorizationStatus: "NOT_AUTHORIZED" | "AUTHORIZED";
  authorizationCoordinate: Readonly<Record<string, unknown>> | null;
  d3Identities: D3V2ActivationD3Identities;
  adapterManifestHash: string;
  settingsMutation: Readonly<Record<string, unknown>>;
  auditTarget: string;
  rollbackTarget: string;
  sessionFile?: D3V2ActivationSessionFileBinding | null;
  quarantineTarget?: string | null;
  mode?: "bound" | "template";
}): Readonly<Record<string, unknown>> {
  assertHash(args.adapterManifestHash, "adapterManifestHash");
  for (const field of [
    "selection_hash", "head_hash", "proof_hash", "intent_hash",
    "stable_bundle_hash", "p2a_bundle_hash",
  ] as const) {
    assertHash(args.d3Identities[field], field);
  }
  // Activation object must never embed settings.activationObjectHash (circular pin).
  if (Object.prototype.hasOwnProperty.call(args.settingsMutation, "activationObjectHash")
    || Object.prototype.hasOwnProperty.call(args.settingsMutation, "activation_object_hash")) {
    fail("activation_invalid", "activation object must not self-reference settings.activationObjectHash");
  }
  const mode = args.mode ?? (args.authorizationStatus === "AUTHORIZED" ? "bound" : "template");
  const normalizedSettingsMutation = normalizeSettingsMutationClosed(args.settingsMutation, {
    requireExecutableShape: mode === "bound",
  });
  if (args.authorizationStatus === "AUTHORIZED" && mode !== "bound") {
    fail("activation_invalid", "AUTHORIZED activation must be mode=bound");
  }
  if (args.authorizationStatus === "NOT_AUTHORIZED" && mode === "bound") {
    fail("activation_invalid", "NOT_AUTHORIZED activation cannot claim bound mode");
  }
  // R3.7: any non-null session_id (bound or template-with-id) must be a single safe filename component.
  if (typeof args.sessionId === "string") {
    assertSafeSessionIdComponent(args.sessionId);
  }
  if (mode === "bound") {
    if (typeof args.sessionId !== "string") fail("activation_invalid", "bound activation requires session_id");
    assertSafeSessionIdComponent(args.sessionId);
    if (typeof args.activationNonce !== "string") fail("activation_invalid", "bound activation requires activation_nonce");
    assertSafeActivationNonceComponent(args.activationNonce);
    if (!args.authorizationCoordinate) fail("activation_invalid", "bound activation requires authorization coordinate");
    if (!args.sessionFile) fail("activation_invalid", "bound activation requires session_file binding");
    if (typeof args.quarantineTarget !== "string" || !path.isAbsolute(args.quarantineTarget)) {
      fail("activation_invalid", "bound activation requires absolute quarantine_target");
    }
  } else if (typeof args.activationNonce === "string" && args.activationNonce.length > 0) {
    // Template may carry a nonce; if present it must still be a safe hash component.
    assertSafeActivationNonceComponent(args.activationNonce);
  }
  const schema = mode === "template"
    ? D3_V2_SESSION_START_ACTIVATION_TEMPLATE_SCHEMA
    : D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA;
  const authorizationCoordinate = args.authorizationCoordinate
    ? deepFreeze({ ...args.authorizationCoordinate })
    : null;
  const authorizationCoordinateHash = authorizationCoordinate
    ? jcsSha256Hex(authorizationCoordinate)
    : null;
  const base: Record<string, unknown> = {
    schema_version: schema,
    mode,
    authorization_status: args.authorizationStatus,
    session_id: args.sessionId,
    activation_nonce: args.activationNonce,
    authorization_coordinate: authorizationCoordinate,
    authorization_coordinate_hash: authorizationCoordinateHash,
    d3_identities: deepFreeze({ ...args.d3Identities }),
    adapter_manifest_hash: args.adapterManifestHash,
    settings_mutation: deepFreeze(normalizedSettingsMutation),
    audit_target: args.auditTarget,
    rollback_target: args.rollbackTarget,
    session_file: args.sessionFile ? deepFreeze({ ...args.sessionFile }) : null,
    quarantine_target: args.quarantineTarget ?? null,
    executable: args.authorizationStatus === "AUTHORIZED" && mode === "bound",
  };
  return deepFreeze({ ...base, activation_object_hash: computeD3V2ActivationObjectHash(base) });
}

export function loadD3V2SessionStartBoundActivationObject(args: {
  activationObjectPath: string;
  activationObjectHash: string;
  activationRoot?: string;
  maxBytes?: number;
}): D3V2BoundActivationObject {
  assertHash(args.activationObjectHash, "activationObjectHash");
  if (typeof args.activationObjectPath !== "string" || !path.isAbsolute(args.activationObjectPath)) {
    fail("activation_path_invalid", "activationObjectPath must be absolute");
  }
  const activationRoot = resolveD3V2SessionStartActivationRoot(args.activationRoot);
  const resolvedPath = path.resolve(args.activationObjectPath);
  if (resolvedPath !== args.activationObjectPath) {
    fail("activation_path_invalid", "activationObjectPath must already be resolved absolute");
  }
  if (!(resolvedPath === activationRoot || resolvedPath.startsWith(activationRoot + path.sep))) {
    fail("activation_path_outside_root", "activation object path is outside controlled activation root", {
      activationRoot,
      resolvedPath,
    });
  }

  ensureTrustedDirectoryTree(activationRoot);
  const relative = path.relative(activationRoot, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("activation_path_outside_root", "activation object relative path is unsafe");
  }
  const components = relative.split(path.sep).filter(Boolean);
  if (components.some((c) => c === "." || c === ".." || c.includes("\0"))) {
    fail("activation_path_invalid", "activation path components are unsafe");
  }

  // Walk from activation root with NOFOLLOW/identity at every directory.
  let currentDir = activationRoot;
  let dirFd = openDirectoryNoFollow(currentDir);
  try {
    for (let i = 0; i < components.length - 1; i += 1) {
      const next = path.join(currentDir, components[i]!);
      const childFd = openChildDirectoryNoFollow(dirFd, currentDir, components[i]!);
      fs.closeSync(dirFd);
      dirFd = childFd;
      currentDir = next;
    }
    const basename = components[components.length - 1]!;
    const filePath = path.join(currentDir, basename);
    const named = fs.lstatSync(filePath);
    if (named.isSymbolicLink() || !named.isFile()) fail("activation_file_unsafe", "activation object is not a regular non-symlink file");
    const maxBytes = args.maxBytes ?? D3_V2_SESSION_START_ACTIVATION_MAX_BYTES;
    if (named.size > maxBytes) fail("activation_oversized", "activation object exceeds bounded max bytes");
    const fileFd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const opened = fs.fstatSync(fileFd);
      if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
        fail("activation_file_race", "activation object identity changed while opening");
      }
      const rawBuf = fs.readFileSync(fileFd);
      const after = fs.fstatSync(fileFd);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || rawBuf.length !== opened.size) {
        fail("activation_file_race", "activation object changed while reading");
      }
      const raw = rawBuf.toString("utf8");
      if (!raw.endsWith("\n") || raw.includes("\r")) fail("activation_noncanonical", "activation object must be exact JCS+LF");
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { fail("activation_parse_failed", "activation object is not JSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("activation_shape_invalid", "activation object must be an object");
      const record = parsed as Record<string, unknown>;
      if (`${canonicalizeJcs(record)}\n` !== raw) fail("activation_noncanonical", "activation object is not exact JCS+LF");
      if (typeof record.activation_object_hash !== "string" || !HASH.test(record.activation_object_hash)) {
        fail("activation_hash_missing", "activation_object_hash required");
      }
      const recomputed = computeD3V2ActivationObjectHash(record);
      if (recomputed !== record.activation_object_hash) fail("activation_selfhash_mismatch", "activation_object_hash does not recompute");
      if (record.activation_object_hash !== args.activationObjectHash) {
        fail("activation_settings_pin_mismatch", "settings.activationObjectHash does not equal object self-hash");
      }
      // Object must not self-reference the settings pin field.
      if (Object.prototype.hasOwnProperty.call(record, "settings_activation_object_hash")
        || (record.settings_mutation && typeof record.settings_mutation === "object"
          && (Object.prototype.hasOwnProperty.call(record.settings_mutation as object, "activationObjectHash")
            || Object.prototype.hasOwnProperty.call(record.settings_mutation as object, "activation_object_hash")))) {
        fail("activation_invalid", "activation object must not self-reference settings.activationObjectHash");
      }
      return validateBoundActivationObjectClosed(record);
    } finally {
      fs.closeSync(fileFd);
    }
  } finally {
    try { fs.closeSync(dirFd); } catch { /* ignore */ }
  }
}

/**
 * Pure closed-schema validator for a bound AUTHORIZED activation object.
 * Does not read production files. Rejects trimmed/partial objects: every
 * BOUND_KEYS field is required, no extras, schema/version/status/mode/
 * executable, authorization_coordinate + hash, D3 identities, manifest,
 * closed settings_mutation, session_file binding, absolute targets, and
 * activation_object_hash self-hash must all hold.
 */
export function validateBoundActivationObjectClosed(
  recordInput: unknown,
): D3V2BoundActivationObject {
  const record = asRecord(recordInput, "activation object");
  if (typeof record.activation_object_hash !== "string" || !HASH.test(record.activation_object_hash)) {
    fail("activation_hash_missing", "activation_object_hash required");
  }
  const recomputed = computeD3V2ActivationObjectHash(record);
  if (recomputed !== record.activation_object_hash) {
    fail("activation_selfhash_mismatch", "activation_object_hash does not recompute");
  }
  if (Object.prototype.hasOwnProperty.call(record, "settings_activation_object_hash")
    || (record.settings_mutation && typeof record.settings_mutation === "object"
      && (Object.prototype.hasOwnProperty.call(record.settings_mutation as object, "activationObjectHash")
        || Object.prototype.hasOwnProperty.call(record.settings_mutation as object, "activation_object_hash")))) {
    fail("activation_invalid", "activation object must not self-reference settings.activationObjectHash");
  }
  return validateBoundActivationShape(record);
}

export function assertBoundActivationMatchesRuntime(args: {
  activation: D3V2BoundActivationObject;
  sessionId: string;
  adapterManifestHash: string;
  d3Identities: D3V2ActivationD3Identities;
  settingsMutationExpected: Readonly<Record<string, unknown>>;
  sessionManager?: unknown;
}): void {
  const a = args.activation;
  if (a.mode !== "bound" || a.authorization_status !== "AUTHORIZED" || a.executable !== true) {
    fail("activation_not_authorized", "runtime requires bound AUTHORIZED executable activation");
  }
  if (a.session_id !== args.sessionId) fail("activation_session_mismatch", "activation session_id does not match selected session");
  if (a.adapter_manifest_hash !== args.adapterManifestHash) {
    fail("activation_manifest_mismatch", "activation adapter_manifest_hash does not match live manifest");
  }
  for (const field of [
    "selection_hash", "head_hash", "proof_hash", "intent_hash",
    "stable_bundle_hash", "p2a_bundle_hash", "generation", "selection_seq",
  ] as const) {
    if (a.d3_identities[field] !== args.d3Identities[field]) {
      fail("activation_d3_mismatch", `activation d3_identities.${field} differs from current D3`);
    }
  }
  // Closed-schema exact equality of settings_mutation vs live norm object.
  const mut = normalizeSettingsMutationClosed(a.settings_mutation as Record<string, unknown>, {
    requireExecutableShape: true,
  });
  const exp = normalizeSettingsMutationClosed(args.settingsMutationExpected as Record<string, unknown>, {
    requireExecutableShape: true,
  });
  if (canonicalizeJcs(mut) !== canonicalizeJcs(exp)) {
    fail("activation_settings_mutation_mismatch", "settings_mutation is not exact-equal to live norm object");
  }
  // Session file identity + append-only prefix.
  const manager = args.sessionManager as { getSessionFile?(): unknown } | undefined;
  if (!manager || typeof manager.getSessionFile !== "function") {
    fail("activation_session_file_missing", "sessionManager.getSessionFile required for bound activation");
  }
  const rawFile = manager.getSessionFile();
  if (typeof rawFile !== "string" || !rawFile.trim()) fail("activation_session_file_missing", "session file path missing");
  const sessionFile = path.resolve(rawFile);
  if (sessionFile !== a.session_file.path) fail("activation_session_file_mismatch", "session file path differs from activation binding");
  const st = fs.lstatSync(sessionFile);
  if (st.isSymbolicLink() || !st.isFile()) fail("activation_session_file_unsafe", "session file is not a regular non-symlink file");
  if (st.dev !== a.session_file.dev || st.ino !== a.session_file.ino) {
    fail("activation_session_file_identity_mismatch", "session file dev/ino differs from activation-time binding");
  }
  if (st.size < a.session_file.prefix_bytes) {
    fail("activation_session_prefix_shrunk", "session file shrank below activation-time prefix");
  }
  const fd = fs.openSync(sessionFile, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(a.session_file.prefix_bytes);
    const read = a.session_file.prefix_bytes === 0 ? 0 : fs.readSync(fd, buf, 0, a.session_file.prefix_bytes, 0);
    if (read !== a.session_file.prefix_bytes) fail("activation_session_prefix_read_failed", "could not read activation-time prefix");
    const prefixSha = sha256Hex(buf.subarray(0, a.session_file.prefix_bytes));
    if (prefixSha !== a.session_file.prefix_sha256) {
      fail("activation_session_prefix_mismatch", "session file prefix bytes drifted from activation-time binding");
    }
  } finally {
    fs.closeSync(fd);
  }
  // Quarantine target must still be absent; parent dir identity trusted.
  const q = path.resolve(a.quarantine_target);
  if (fs.existsSync(q)) fail("activation_quarantine_present", "quarantine target must be absent at runtime");
  ensureTrustedDirectoryTree(path.dirname(q));
  // Rollback target and audit target must be absolute exact directories/files roots.
  if (!path.isAbsolute(a.rollback_target) || !path.isAbsolute(a.audit_target)) {
    fail("activation_targets_invalid", "audit_target and rollback_target must be absolute");
  }
  ensureTrustedDirectoryTree(a.rollback_target);
  ensureTrustedDirectoryTree(path.dirname(a.audit_target));
}

export function captureSessionFileBinding(sessionFilePath: string): D3V2ActivationSessionFileBinding {
  const resolved = path.resolve(sessionFilePath);
  const st = fs.lstatSync(resolved);
  if (st.isSymbolicLink() || !st.isFile()) fail("session_file_unsafe", "session file must be a regular non-symlink file");
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) fail("session_file_race", "session file identity race");
    const raw = fs.readFileSync(fd);
    return {
      path: resolved,
      dev: opened.dev,
      ino: opened.ino,
      prefix_bytes: raw.length,
      prefix_sha256: sha256Hex(raw),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function validateBoundActivationShape(record: Record<string, unknown>): D3V2BoundActivationObject {
  for (const key of Object.keys(record)) {
    if (key === "activation_object_hash") continue;
    if (!(BOUND_KEYS as readonly string[]).includes(key)) {
      fail("activation_schema_closed", `unknown activation field: ${key}`);
    }
  }
  for (const key of BOUND_KEYS) {
    if (!(key in record)) fail("activation_schema_closed", `missing required activation field: ${key}`);
  }
  if (record.schema_version !== D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA) fail("activation_schema_invalid", "schema differs");
  if (record.mode !== "bound") fail("activation_not_bound", "mode must be bound");
  if (record.authorization_status !== "AUTHORIZED") fail("activation_not_authorized", "authorization_status must be AUTHORIZED");
  if (record.executable !== true) fail("activation_not_executable", "executable must be true");
  // R3.7 full validator: session_id is a single safe filename component (reused by rollback Door1).
  if (typeof record.session_id !== "string") fail("activation_session_invalid", "session_id required");
  assertSafeSessionIdComponent(record.session_id);
  if (typeof record.activation_nonce !== "string") fail("activation_nonce_invalid", "activation_nonce required");
  assertSafeActivationNonceComponent(record.activation_nonce);
  if (!record.authorization_coordinate || typeof record.authorization_coordinate !== "object" || Array.isArray(record.authorization_coordinate)) {
    fail("activation_coordinate_invalid", "authorization_coordinate required");
  }
  if (typeof record.authorization_coordinate_hash !== "string" || !HASH.test(record.authorization_coordinate_hash)) {
    fail("activation_coordinate_hash_invalid", "authorization_coordinate_hash required");
  }
  if (jcsSha256Hex(record.authorization_coordinate) !== record.authorization_coordinate_hash) {
    fail("activation_coordinate_hash_mismatch", "authorization_coordinate_hash does not recompute");
  }
  const d3 = asRecord(record.d3_identities, "d3_identities");
  const d3Identities: D3V2ActivationD3Identities = {
    selection_hash: requireHash(d3.selection_hash, "selection_hash"),
    head_hash: requireHash(d3.head_hash, "head_hash"),
    proof_hash: requireHash(d3.proof_hash, "proof_hash"),
    intent_hash: requireHash(d3.intent_hash, "intent_hash"),
    stable_bundle_hash: requireHash(d3.stable_bundle_hash, "stable_bundle_hash"),
    p2a_bundle_hash: requireHash(d3.p2a_bundle_hash, "p2a_bundle_hash"),
    generation: requireNonNegInt(d3.generation, "generation"),
    selection_seq: requireNonNegInt(d3.selection_seq, "selection_seq"),
  };
  const sessionFileRaw = asRecord(record.session_file, "session_file");
  const sessionFile: D3V2ActivationSessionFileBinding = {
    path: requireAbsolute(sessionFileRaw.path, "session_file.path"),
    dev: requireNonNegInt(sessionFileRaw.dev, "session_file.dev"),
    ino: requireNonNegInt(sessionFileRaw.ino, "session_file.ino"),
    prefix_bytes: requireNonNegInt(sessionFileRaw.prefix_bytes, "session_file.prefix_bytes"),
    prefix_sha256: requireHash(sessionFileRaw.prefix_sha256, "session_file.prefix_sha256"),
  };
  return deepFreeze({
    schema_version: D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA,
    mode: "bound",
    authorization_status: "AUTHORIZED",
    session_id: String(record.session_id),
    activation_nonce: String(record.activation_nonce),
    authorization_coordinate: deepFreeze({ ...(record.authorization_coordinate as Record<string, unknown>) }),
    authorization_coordinate_hash: String(record.authorization_coordinate_hash),
    d3_identities: deepFreeze(d3Identities),
    adapter_manifest_hash: requireHash(record.adapter_manifest_hash, "adapter_manifest_hash"),
    settings_mutation: deepFreeze(normalizeSettingsMutationClosed(
      asRecord(record.settings_mutation, "settings_mutation"),
      { requireExecutableShape: true },
    )),
    audit_target: requireAbsolute(record.audit_target, "audit_target"),
    rollback_target: requireAbsolute(record.rollback_target, "rollback_target"),
    session_file: deepFreeze(sessionFile),
    quarantine_target: requireAbsolute(record.quarantine_target, "quarantine_target"),
    executable: true,
    activation_object_hash: requireHash(record.activation_object_hash, "activation_object_hash"),
  });
}

/**
 * Normalize settings_mutation to the closed live-norm object.
 * Rejects unknown keys and activationObjectHash self-reference.
 * When requireExecutableShape=true (bound path), all critical fields must be present.
 */
export function normalizeSettingsMutationClosed(
  input: Readonly<Record<string, unknown>>,
  options: { requireExecutableShape: boolean },
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("activation_settings_mutation_invalid", "settings_mutation must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!(D3_V2_SESSION_START_SETTINGS_MUTATION_KEYS as readonly string[]).includes(key)) {
      // Template may carry a transitional note/path/set envelope only when not requiring executable shape.
      if (!options.requireExecutableShape && (key === "note" || key === "path" || key === "set")) continue;
      fail("activation_settings_mutation_closed", `settings_mutation unknown field: ${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "activationObjectHash")
    || Object.prototype.hasOwnProperty.call(input, "activation_object_hash")) {
    fail("activation_invalid", "settings_mutation must not self-reference activationObjectHash");
  }

  // Template envelope (dossier): keep closed template payload without requiring executable fields.
  if (!options.requireExecutableShape && ("set" in input || "path" in input || "note" in input)) {
    const out: Record<string, unknown> = {};
    if (typeof input.path === "string") out.path = input.path;
    if (input.set && typeof input.set === "object" && !Array.isArray(input.set)) {
      out.set = normalizeSettingsMutationClosed(input.set as Record<string, unknown>, {
        requireExecutableShape: false,
      });
    }
    if (typeof input.note === "string") out.note = input.note;
    // Also allow direct closed keys on template.
    for (const key of D3_V2_SESSION_START_SETTINGS_MUTATION_KEYS) {
      if (key in input) out[key] = (input as Record<string, unknown>)[key];
    }
    if ("selector" in out) out.selector = normalizeSelector(out.selector);
    if ("expectedIntentHash" in out && out.expectedIntentHash != null) {
      out.expectedIntentHash = requireHash(out.expectedIntentHash, "expectedIntentHash");
    } else if ("expectedIntentHash" in out) {
      out.expectedIntentHash = null;
    }
    return out;
  }

  const selector = normalizeSelector(input.selector);
  const out: Record<string, unknown> = {
    enabled: input.enabled === true,
    selector,
    expectedSelectionHash: hashOrNullField(input.expectedSelectionHash, "expectedSelectionHash"),
    expectedHeadHash: hashOrNullField(input.expectedHeadHash, "expectedHeadHash"),
    expectedProofHash: hashOrNullField(input.expectedProofHash, "expectedProofHash"),
    expectedStableBundleHash: hashOrNullField(input.expectedStableBundleHash, "expectedStableBundleHash"),
    expectedIntentHash: hashOrNullField(input.expectedIntentHash, "expectedIntentHash"),
    adapterManifestHash: hashOrNullField(input.adapterManifestHash, "adapterManifestHash"),
    activationObjectPath: typeof input.activationObjectPath === "string" && input.activationObjectPath.trim()
      ? input.activationObjectPath.trim()
      : null,
    maxReadBytes: typeof input.maxReadBytes === "number" && Number.isFinite(input.maxReadBytes)
      ? Math.floor(input.maxReadBytes)
      : null,
  };

  if (options.requireExecutableShape && out.enabled === true) {
    // Injection-bound activations must carry the full live-norm closed object.
    if (!Array.isArray((out.selector as { session_ids: string[] }).session_ids)
      || (out.selector as { session_ids: string[] }).session_ids.length === 0) {
      fail("activation_settings_mutation_invalid", "bound settings_mutation.selector.session_ids required");
    }
    for (const key of [
      "expectedSelectionHash", "expectedHeadHash", "expectedProofHash",
      "expectedStableBundleHash", "adapterManifestHash",
    ] as const) {
      if (typeof out[key] !== "string" || !HASH.test(out[key] as string)) {
        fail("activation_settings_mutation_invalid", `bound settings_mutation.${key} required`);
      }
    }
    if (out.expectedIntentHash != null && (typeof out.expectedIntentHash !== "string" || !HASH.test(out.expectedIntentHash as string))) {
      fail("activation_settings_mutation_invalid", "settings_mutation.expectedIntentHash invalid");
    }
    if (typeof out.activationObjectPath !== "string" || !path.isAbsolute(out.activationObjectPath as string)) {
      fail("activation_settings_mutation_invalid", "bound settings_mutation.activationObjectPath must be absolute");
    }
    if (typeof out.maxReadBytes !== "number" || !Number.isSafeInteger(out.maxReadBytes) || (out.maxReadBytes as number) < 1) {
      fail("activation_settings_mutation_invalid", "bound settings_mutation.maxReadBytes required");
    }
  }
  return out;
}

function normalizeSelector(value: unknown): { session_ids: string[] } {
  if (value == null) return { session_ids: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("activation_settings_mutation_invalid", "settings_mutation.selector must be an object");
  }
  const sel = value as Record<string, unknown>;
  for (const key of Object.keys(sel)) {
    if (key !== "session_ids") fail("activation_settings_mutation_closed", `settings_mutation.selector unknown field: ${key}`);
  }
  const ids = Array.isArray(sel.session_ids)
    ? sel.session_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
    : [];
  // Preserve order but de-dupe for stable equality with live resolver output.
  // R3.7: each selector session_id must also be a single safe filename component.
  const seen = new Set<string>();
  const session_ids: string[] = [];
  for (const id of ids) {
    assertSafeSessionIdComponent(id, "settings_mutation.selector.session_ids[]");
    if (!seen.has(id)) { seen.add(id); session_ids.push(id); }
  }
  return { session_ids };
}

function hashOrNullField(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !HASH.test(value)) fail("hash_invalid", `${label} must be lowercase SHA-256 or null`);
  return value;
}

function ensureTrustedDirectoryTree(directoryInput: string): void {
  const directory = path.resolve(directoryInput);
  const root = path.parse(directory).root;
  let current = root;
  for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { fs.mkdirSync(current, { mode: 0o700 }); } catch (mkErr) {
          if ((mkErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkErr;
        }
        stat = fs.lstatSync(current);
      } else throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("directory_unsafe", `directory component is unsafe: ${current}`);
  }
}

function openDirectoryNoFollow(directory: string): number {
  const named = fs.lstatSync(directory);
  if (named.isSymbolicLink() || !named.isDirectory()) fail("directory_unsafe", `not a directory: ${directory}`);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  const st = fs.fstatSync(fd);
  if (!st.isDirectory() || st.dev !== named.dev || st.ino !== named.ino) {
    fs.closeSync(fd);
    fail("directory_unsafe", `directory identity unsafe: ${directory}`);
  }
  return fd;
}

function openChildDirectoryNoFollow(parentFd: number, parentPath: string, basename: string): number {
  if (path.basename(basename) !== basename || basename === "." || basename === "..") {
    fail("directory_unsafe", "invalid directory basename");
  }
  const childPath = path.join(parentPath, basename);
  const named = fs.lstatSync(childPath);
  if (named.isSymbolicLink() || !named.isDirectory()) fail("directory_unsafe", `child is not a directory: ${childPath}`);
  // Open via path; verify identity matches named lstat (NOFOLLOW when supported).
  const fd = fs.openSync(childPath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  const st = fs.fstatSync(fd);
  if (!st.isDirectory() || st.dev !== named.dev || st.ino !== named.ino) {
    fs.closeSync(fd);
    fail("directory_unsafe", `child directory identity unsafe: ${childPath}`);
  }
  // Parent still same identity.
  const parentSt = fs.fstatSync(parentFd);
  const parentNamed = fs.lstatSync(parentPath);
  if (parentSt.dev !== parentNamed.dev || parentSt.ino !== parentNamed.ino) {
    fs.closeSync(fd);
    fail("directory_unsafe", "parent directory identity drifted");
  }
  return fd;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) fail("hash_invalid", `${label} must be lowercase SHA-256`);
  return value;
}
function requireAbsolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("path_invalid", `${label} must be absolute`);
  return value;
}
function requireNonNegInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("shape_invalid", `${label} must be non-negative integer`);
  return value;
}
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("shape_invalid", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) fail("hash_invalid", `${label} must be lowercase SHA-256`);
}
function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new D3V2ActivationError(code, message, detail);
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Dossier zero-write predicate (R3.5): scan ONLY inside `root` for any regular
 * file (extension-agnostic) whose JSON body is a bound/AUTHORIZED/executable
 * activation object. NOFOLLOW reads with a size limit. Any readdir/lstat/read/
 * parse error fails closed to false. Absent root is true (no bound object).
 * Never follows symlinks and never scans outside root.
 */
export function activationRootHasNoBoundObject(
  root: string,
  options?: { maxFileBytes?: number },
): boolean {
  const maxFileBytes = options?.maxFileBytes ?? D3_V2_SESSION_START_ACTIVATION_MAX_BYTES;
  const resolvedRoot = path.resolve(root);

  function insideRoot(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  }

  function scanDir(dir: string): boolean {
    if (!insideRoot(dir)) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false; // fail-closed
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (!insideRoot(full)) return false; // never scan outside root
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        return false; // fail-closed
      }
      if (st.isSymbolicLink()) {
        // NOFOLLOW: never follow; do not treat as bound content.
        continue;
      }
      if (st.isDirectory()) {
        if (!scanDir(full)) return false;
        continue;
      }
      if (!st.isFile()) continue;
      // All regular files — no extension filter.
      try {
        if (st.size < 0 || st.size > maxFileBytes) return false;
        const fd = fs.openSync(full, fs.constants.O_RDONLY | NOFOLLOW);
        let raw: string;
        try {
          const before = fs.fstatSync(fd);
          if (!before.isFile() || before.size > maxFileBytes || before.dev !== st.dev || before.ino !== st.ino) {
            return false;
          }
          const buf = Buffer.alloc(Number(before.size));
          let offset = 0;
          while (offset < buf.length) {
            const n = fs.readSync(fd, buf, offset, buf.length - offset, offset);
            if (n <= 0) break;
            offset += n;
          }
          if (offset !== buf.length) return false;
          const after = fs.fstatSync(fd);
          if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) return false;
          raw = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
        let obj: unknown;
        try {
          obj = JSON.parse(raw);
        } catch {
          return false; // parse error fail-closed
        }
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
        const rec = obj as Record<string, unknown>;
        if (
          rec.authorization_status === "AUTHORIZED"
          || rec.mode === "bound"
          || rec.executable === true
        ) {
          return false;
        }
      } catch {
        return false; // fail-closed
      }
    }
    return true;
  }

  try {
    const st = fs.lstatSync(resolvedRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    return scanDir(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; // absent = no bound
    return false; // fail-closed
  }
}

// silence unused TEMPLATE_KEYS (kept for schema documentation / future template validator)
void TEMPLATE_KEYS;
