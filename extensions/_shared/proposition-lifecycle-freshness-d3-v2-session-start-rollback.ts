/// <reference types="node" />
/**
 * ADR0040 D3-v2 session_start rollback / halt operator (R3.8).
 *
 * Production requires triple authorization (missing ANY door = default-deny):
 *   1) bound activation AUTHORIZED via activation-module pure closed-schema
 *      validator (all BOUND_KEYS required; no trimmed objects; full selfhash;
 *      R3.7 session_id single safe filename component)
 *   2) independent rollback authorization AUTHORIZED (required+no-extra keys,
 *      schema, grant hash, fixed faces/auto_retry/crash_resume, selfhash)
 *   3) independent production-target authorization AUTHORIZED (required+no-extra,
 *      schema, grant hash, exact path bind settings/state/session/quarantine, selfhash)
 * stateRoot must equal activation.rollback_target (path.resolve identity).
 * Production-target auth production_state_root must bind the same path.
 * After all three doors, production may mutate ONLY the exact bound paths.
 * Sandbox rejects hard production roots derived from HOME/default control roots
 * (settings/sessions/.abrain/adr0040-d3-v2-session-start subtree + runtime-audit).
 * No substring exemptions. Default-deny without all doors.
 *
 * Path safety (R3.6/R3.7/R3.8):
 * Linux-only retained parent-directory FD walk via /proc/self/fd/<parentFd>/<basename>.
 * Walk starts at filesystem root with an open directory FD; each next component is
 * lstat/open/mkdir'd ONLY through the retained parent FD procfd path. The previous
 * layer FD is released only after the next layer FD is open (or the chain is kept).
 * Any symlink is refused. Create/write keep the target parent FD open for the whole
 * critical section. ensureDirectoryChainNoSymlink never falls back to absolute-path
 * mkdir after a check. atomicDurableWriteText/Json create tmp, fsync, rename-to-final,
 * and fsync-parent only through the anchored parent FD. Quarantine rename holds both
 * source-parent and dest-parent FDs and performs final re-lstat + rename on procfd
 * relative paths (RENAME_NOREPLACE dest-race residual remains honest). Settings
 * read/write/postcondition use the same anchored open where practical. Non-Linux or
 * missing /proc/self/fd fails closed. This is a Linux boundary, not a portable claim.
 *
 * R3.7: session_id / activation_nonce / face path helpers use safe basename +
 * joinUnderRootContained containment (defense-in-depth against stateRoot escape).
 * Public rehearse and main operator writes are procfd-anchored; no post-validation
 * absolute writeFileSync/existsSync in rehearse. Test fixture setup lives only in
 * smoke scripts, not in this production module. applyR36TestAncestorSwapAfterPreflight
 * remains a closed-set one-shot sandbox test hook (absolute rename for the swap itself).
 *
 * R3.8: public `rehearseD3V2SessionStartRollback` forces sandboxSettingsPath /
 * sessionFilePath / quarantineTarget and their parents to be strictly contained
 * under the unique disposable `path.resolve(stateRoot)` before any mkdir/write.
 * External absolute, sibling, and `..` overrides are rejected; defaults remain
 * joinUnderRootContained under stateRoot. Overrides are retained but contained.
 *
 * Face order: selector_disable → session_taint → session_quarantine_rename → terminal_halt.
 * Each face: atomic durable intent → action → postcondition → atomic durable receipt.
 * Intent reads require parent_hash === current receipt-chain parentHash.
 * Intent without receipt resumes only with operatorContinue=true.
 * Any pending intent is treated as halt by selected runtime (closes selector-disable
 * crash injection window).
 *
 * Quarantine rename is a real rename (not copy+delete). Source + parent FDs held across
 * the critical section; source identity is re-lstat'd via procfd immediately before rename;
 * dest must be NOFOLLOW-absent via dest-parent procfd. Node fs.renameSync cannot express
 * RENAME_NOREPLACE; residual same-machine non-cooperative overwrite risk on the race
 * window is documented honestly — we do not claim full no-overwrite atomicity.
 * Concurrent dest creation that leaves postcondition unsatisfied halts (no silent success).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  buildD3V2SessionStartActivationObject,
  validateBoundActivationObjectClosed,
  assertSafeSessionIdComponent,
  assertSafeActivationNonceComponent,
  assertSafeSinglePathComponent,
  joinUnderRootContained,
  assertResolvedPathContainedUnderRoot,
  D3_V2_SESSION_START_DEFAULT_ACTIVATION_ROOT,
  type D3V2BoundActivationObject,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-activation";

export const D3_V2_SESSION_START_ROLLBACK_RECEIPT_SCHEMA =
  "adr0040-d3-v2-session-start-rollback-receipt/v1" as const;
export const D3_V2_SESSION_START_ROLLBACK_BARRIER_SCHEMA =
  "adr0040-d3-v2-session-start-rollback-barrier/v1" as const;
export const D3_V2_SESSION_START_ROLLBACK_AUTHORIZATION_SCHEMA =
  "adr0040-d3-v2-session-start-rollback-authorization/v1" as const;
export const D3_V2_SESSION_START_PRODUCTION_TARGET_AUTHORIZATION_SCHEMA =
  "adr0040-d3-v2-session-start-production-target-authorization/v1" as const;
export const D3_V2_SESSION_START_ROLLBACK_INTENT_SCHEMA =
  "adr0040-d3-v2-session-start-rollback-intent/v1" as const;
export const D3_V2_SESSION_START_HALT_SCHEMA =
  "adr0040-d3-v2-session-start-halt/v1" as const;
export const D3_V2_SESSION_START_SESSION_TAINT_SCHEMA =
  "adr0040-d3-v2-session-start-session-taint/v1" as const;

export type D3V2RollbackFace =
  | "selector_disable"
  | "session_taint"
  | "session_quarantine_rename"
  | "terminal_halt";

export const D3_V2_ROLLBACK_FACES: readonly D3V2RollbackFace[] = Object.freeze([
  "selector_disable",
  "session_taint",
  "session_quarantine_rename",
  "terminal_halt",
]);

const HASH = /^[0-9a-f]{64}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const CRASH_RESUME_SEMANTICS = "intent_receipt_fsm_operator_continue_only" as const;

/** Linux-only boundary for R3.6 retained parent-fd /proc/self/fd walks. */
export const D3_V2_SESSION_START_PATH_SAFETY_PLATFORM_BOUNDARY =
  "linux_proc_self_fd_retained_parent_directory_fd_walk" as const;

/** Closed-set kind for the one-shot sandbox-only ancestor-swap test hook (R3.6). */
export const D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND =
  "r3.6_sandbox_ancestor_swap_after_preflight_v1" as const;

/** Env token name required by the R3.6 test hook (never set in production defaults). */
export const D3_V2_R36_TEST_TOKEN_ENV = "PI_ASTACK_R36_TEST_TOKEN" as const;

/**
 * Quarantine rename residual (R3.4/R3.6):
 * Node.js `fs.renameSync` has no RENAME_NOREPLACE / RENAME_EXCHANGE flag surface.
 * On Linux, rename(2) replaces an existing non-directory dest silently. We keep a
 * real rename (not copy+delete), hold source + parent FDs, re-lstat source identity
 * and re-check dest NOFOLLOW-absent via procfd immediately before rename, then
 * postcondition-halt on any failed identity/absence check. A same-machine
 * non-cooperative attacker who creates dest inside the final check→rename window
 * may still observe dest content replacement; this is an honest residual, not full
 * no-overwrite atomicity. Ancestor-swap rewrite of the rename target is closed by
 * retained parent FDs (R3.6).
 */
export const D3_V2_SESSION_START_QUARANTINE_RENAME_RESIDUAL =
  "node_fs_rename_sync_no_RENAME_NOREPLACE_same_machine_noncooperative_dest_race_residual" as const;

export type D3V2RetainedDirFd = Readonly<{
  fd: number;
  /** Lexical absolute path corresponding to the open directory inode at open time. */
  path: string;
  dev: number;
  ino: number;
}>;

/**
 * Closed-set one-shot sandbox-only test hook (R3.6).
 * Production default path never supplies this. Requires:
 *   - operator target === "sandbox"
 *   - kind exact match
 *   - testToken non-empty and equal to process.env.PI_ASTACK_R36_TEST_TOKEN
 *   - sandboxAncestorToSwap under system temp (not a hard production root)
 *   - hardRootSymlinkTarget is an exact listed hard production root
 * Applied once after preflight and before any mkdir/open/rename write.
 */
export type D3V2R36TestAncestorSwapHook = Readonly<{
  kind: typeof D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND;
  testToken: string;
  sandboxAncestorToSwap: string;
  hardRootSymlinkTarget: string;
}>;

const ROLLBACK_AUTH_KEYS = Object.freeze([
  "schema_version",
  "authorization_status",
  "activation_object_hash",
  "activation_nonce",
  "session_id",
  "grant_phrase_sha256",
  "faces",
  "auto_retry",
  "crash_resume",
  "authorization_hash",
] as const);

const PROD_AUTH_KEYS = Object.freeze([
  "schema_version",
  "authorization_status",
  "activation_object_hash",
  "rollback_authorization_hash",
  "production_settings_path",
  "production_state_root",
  "production_session_file_path",
  "production_quarantine_target",
  "grant_phrase_sha256",
  "authorization_hash",
] as const);

const INTENT_KEYS = Object.freeze([
  "schema_version",
  "face",
  "activation_nonce",
  "session_id",
  "reason",
  "parent_hash",
  "intent_hash",
] as const);

export class D3V2RollbackError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "D3V2RollbackError";
    this.code = code;
  }
}

export function buildD3V2SessionStartRollbackReceipt(args: {
  face: D3V2RollbackFace;
  activationNonce: string;
  sessionId: string;
  reason: string;
  payload: Readonly<Record<string, unknown>>;
  parentHash?: string | null;
}): Readonly<Record<string, unknown>> {
  if (args.parentHash != null) assertHash(args.parentHash, "parentHash");
  const base = {
    schema_version: D3_V2_SESSION_START_ROLLBACK_RECEIPT_SCHEMA,
    face: args.face,
    activation_nonce: args.activationNonce,
    session_id: args.sessionId,
    reason: args.reason,
    payload: deepFreeze({ ...args.payload }),
    parent_hash: args.parentHash ?? null,
  };
  return deepFreeze({ ...base, receipt_hash: jcsSha256Hex(base) });
}

export function buildD3V2SessionStartRollbackBarrier(args: {
  activationNonce: string;
  receipts: readonly Readonly<Record<string, unknown>>[];
}): Readonly<Record<string, unknown>> {
  const receiptHashes = args.receipts.map((receipt) => {
    const row = asRecord(receipt, "rollback receipt");
    assertHash(row.receipt_hash, "receipt_hash");
    return String(row.receipt_hash);
  }).sort(compareCodeUnits);
  const base = {
    schema_version: D3_V2_SESSION_START_ROLLBACK_BARRIER_SCHEMA,
    activation_nonce: args.activationNonce,
    receipt_count: receiptHashes.length,
    receipt_hashes: receiptHashes,
    receipt_hashes_hash: jcsSha256Hex(receiptHashes),
  };
  return deepFreeze({ ...base, barrier_hash: jcsSha256Hex(base) });
}

export function buildD3V2SessionStartRollbackAuthorization(args: {
  activationObject: Readonly<Record<string, unknown>>;
  authorizationStatus: "NOT_AUTHORIZED" | "AUTHORIZED";
  grantPhrase?: string | null;
}): Readonly<Record<string, unknown>> {
  const activation = asRecord(args.activationObject, "activation object");
  // Door1-equivalent pure closed-schema check (no production I/O).
  validateBoundActivationObjectClosed(activation);
  if (args.authorizationStatus === "AUTHORIZED") {
    if (typeof args.grantPhrase !== "string" || !args.grantPhrase.trim()) {
      fail("rollback_authorization_invalid", "rollback authorization requires an independent grant phrase");
    }
  }
  const base = {
    schema_version: D3_V2_SESSION_START_ROLLBACK_AUTHORIZATION_SCHEMA,
    authorization_status: args.authorizationStatus,
    activation_object_hash: String(activation.activation_object_hash),
    activation_nonce: activation.activation_nonce ?? null,
    session_id: activation.session_id ?? null,
    grant_phrase_sha256: args.grantPhrase ? sha256Hex(args.grantPhrase) : null,
    faces: [...D3_V2_ROLLBACK_FACES],
    auto_retry: false,
    crash_resume: CRASH_RESUME_SEMANTICS,
  };
  return deepFreeze({ ...base, authorization_hash: jcsSha256Hex(base) });
}

export function buildD3V2SessionStartProductionTargetAuthorization(args: {
  activationObject: Readonly<Record<string, unknown>>;
  rollbackAuthorization: Readonly<Record<string, unknown>>;
  authorizationStatus: "NOT_AUTHORIZED" | "AUTHORIZED";
  grantPhrase?: string | null;
  productionSettingsPath: string;
  productionStateRoot: string;
  productionSessionFilePath?: string;
  productionQuarantineTarget?: string;
}): Readonly<Record<string, unknown>> {
  const activation = asRecord(args.activationObject, "activation object");
  const rollback = asRecord(args.rollbackAuthorization, "rollback authorization");
  validateBoundActivationObjectClosed(activation);
  validateRollbackAuthorizationClosed(rollback);
  const sessionFilePath = args.productionSessionFilePath
    ?? (activation.session_file && typeof activation.session_file === "object"
      ? String((activation.session_file as Record<string, unknown>).path ?? "")
      : "");
  const quarantineTarget = args.productionQuarantineTarget
    ?? (typeof activation.quarantine_target === "string" ? activation.quarantine_target : "");
  if (args.authorizationStatus === "AUTHORIZED") {
    if (activation.authorization_status !== "AUTHORIZED" || activation.mode !== "bound" || activation.executable !== true) {
      fail("production_target_authorization_invalid", "production-target auth requires bound AUTHORIZED activation");
    }
    if (rollback.authorization_status !== "AUTHORIZED") {
      fail("production_target_authorization_invalid", "production-target auth requires AUTHORIZED rollback authorization");
    }
    if (String(rollback.activation_object_hash) !== String(activation.activation_object_hash)) {
      fail("production_target_authorization_invalid", "production-target auth must bind the same activation object");
    }
    if (typeof args.grantPhrase !== "string" || !args.grantPhrase.trim()) {
      fail("production_target_authorization_invalid", "production-target auth requires independent grant phrase");
    }
    if (!path.isAbsolute(args.productionSettingsPath) || !path.isAbsolute(args.productionStateRoot)) {
      fail("production_target_authorization_invalid", "production settings/state paths must be absolute");
    }
    if (!sessionFilePath || !path.isAbsolute(sessionFilePath)) {
      fail("production_target_authorization_invalid", "production session file path must be absolute");
    }
    if (!quarantineTarget || !path.isAbsolute(quarantineTarget)) {
      fail("production_target_authorization_invalid", "production quarantine target must be absolute");
    }
    // production_state_root must bind activation.rollback_target exactly
    if (path.resolve(args.productionStateRoot) !== path.resolve(String(activation.rollback_target))) {
      fail("production_target_authorization_invalid", "production_state_root must equal activation.rollback_target");
    }
    const boundSession = activation.session_file && typeof activation.session_file === "object"
      ? String((activation.session_file as Record<string, unknown>).path ?? "")
      : "";
    if (path.resolve(sessionFilePath) !== path.resolve(boundSession)) {
      fail("production_target_authorization_invalid", "production_session_file_path must equal activation.session_file.path");
    }
    if (path.resolve(quarantineTarget) !== path.resolve(String(activation.quarantine_target))) {
      fail("production_target_authorization_invalid", "production_quarantine_target must equal activation.quarantine_target");
    }
  }
  const base = {
    schema_version: D3_V2_SESSION_START_PRODUCTION_TARGET_AUTHORIZATION_SCHEMA,
    authorization_status: args.authorizationStatus,
    activation_object_hash: String(activation.activation_object_hash),
    rollback_authorization_hash: String(rollback.authorization_hash),
    production_settings_path: path.resolve(args.productionSettingsPath),
    production_state_root: path.resolve(args.productionStateRoot),
    production_session_file_path: sessionFilePath ? path.resolve(sessionFilePath) : null,
    production_quarantine_target: quarantineTarget ? path.resolve(quarantineTarget) : null,
    grant_phrase_sha256: args.grantPhrase ? sha256Hex(args.grantPhrase) : null,
  };
  return deepFreeze({ ...base, authorization_hash: jcsSha256Hex(base) });
}

/** R3.7: face basename must be a closed-set safe single path component. */
function assertSafeRollbackFace(face: string): asserts face is D3V2RollbackFace {
  if (!(D3_V2_ROLLBACK_FACES as readonly string[]).includes(face)) {
    fail("path_component_invalid", `unknown rollback face: ${face}`);
  }
  assertSafeSinglePathComponent(face, "face");
}

/** R3.7 path helper: halt marker under stateRoot/halt/<nonce>.json (contained). */
export function haltMarkerPath(rollbackTarget: string, activationNonce: string): string {
  assertSafeActivationNonceComponent(activationNonce);
  return joinUnderRootContained(path.resolve(rollbackTarget), "halt", `${activationNonce}.json`);
}

/** R3.7 path helper: session taint under stateRoot/session-taints/<sessionId>.json (contained). */
export function sessionTaintPath(rollbackTarget: string, sessionId: string): string {
  assertSafeSessionIdComponent(sessionId);
  return joinUnderRootContained(path.resolve(rollbackTarget), "session-taints", `${sessionId}.json`);
}

/** R3.7 path helper: intent dir under stateRoot/rollback-intents/<nonce> (contained). */
export function rollbackIntentDir(rollbackTarget: string, activationNonce: string): string {
  assertSafeActivationNonceComponent(activationNonce);
  return joinUnderRootContained(path.resolve(rollbackTarget), "rollback-intents", activationNonce);
}

/** R3.7 path helper: receipt dir under stateRoot/rollback-receipts/<nonce> (contained). */
export function rollbackReceiptDir(rollbackTarget: string, activationNonce: string): string {
  assertSafeActivationNonceComponent(activationNonce);
  return joinUnderRootContained(path.resolve(rollbackTarget), "rollback-receipts", activationNonce);
}

/** R3.7 path helper: face-named artifact under an already-contained directory. */
export function rollbackFaceArtifactPath(parentDir: string, face: D3V2RollbackFace): string {
  assertSafeRollbackFace(face);
  return joinUnderRootContained(path.resolve(parentDir), `${face}.json`);
}

/** R3.7 path helper: barrier under stateRoot/rollback-barriers/<nonce>.json (contained). */
export function rollbackBarrierPath(rollbackTarget: string, activationNonce: string): string {
  assertSafeActivationNonceComponent(activationNonce);
  return joinUnderRootContained(path.resolve(rollbackTarget), "rollback-barriers", `${activationNonce}.json`);
}

/** R3.7 path helper: halt failure under stateRoot/halt/<nonce>.failure.json (contained). */
export function haltFailurePath(rollbackTarget: string, activationNonce: string): string {
  assertSafeActivationNonceComponent(activationNonce);
  return joinUnderRootContained(path.resolve(rollbackTarget), "halt", `${activationNonce}.failure.json`);
}

/**
 * Any pending intent (intent without receipt) for this activation must be treated
 * as halt by the selected runtime — closes the selector-disable crash injection window.
 */
export function readD3V2SessionStartPendingRollbackIntent(args: {
  rollbackTarget: string;
  activationNonce: string;
  sessionId: string;
}): { pending: boolean; face: D3V2RollbackFace | null; reason: string | null } {
  const intentDir = rollbackIntentDir(args.rollbackTarget, args.activationNonce);
  const receiptDir = rollbackReceiptDir(args.rollbackTarget, args.activationNonce);
  if (!fs.existsSync(intentDir)) return { pending: false, face: null, reason: null };
  for (const face of D3_V2_ROLLBACK_FACES) {
    const intentPath = rollbackFaceArtifactPath(intentDir, face);
    const receiptPath = rollbackFaceArtifactPath(receiptDir, face);
    if (!fs.existsSync(intentPath)) continue;
    if (fs.existsSync(receiptPath)) continue;
    // Validate intent shape; invalid intent is still a halt signal.
    try {
      loadValidatedIntent({
        intentPath,
        face,
        activationNonce: args.activationNonce,
        sessionId: args.sessionId,
      });
    } catch {
      return { pending: true, face, reason: `pending_intent_invalid:${face}` };
    }
    return { pending: true, face, reason: `pending_intent:${face}` };
  }
  return { pending: false, face: null, reason: null };
}

/** Runtime pre-D3 check: halt marker, session taint, OR pending rollback intent. */
export function readD3V2SessionStartHaltOrTaint(args: {
  rollbackTarget: string;
  activationNonce: string;
  sessionId: string;
}): { halted: boolean; reason: string | null; kind: "halt" | "taint" | "pending_intent" | null } {
  const haltPath = haltMarkerPath(args.rollbackTarget, args.activationNonce);
  if (fs.existsSync(haltPath)) {
    try {
      const raw = fs.readFileSync(haltPath, "utf8");
      const row = JSON.parse(raw) as Record<string, unknown>;
      if (row.schema_version === D3_V2_SESSION_START_HALT_SCHEMA
        && row.activation_nonce === args.activationNonce
        && row.session_id === args.sessionId) {
        return { halted: true, reason: typeof row.reason === "string" ? row.reason : "halt_marker", kind: "halt" };
      }
    } catch { /* treat unreadable halt as halt */ }
    return { halted: true, reason: "halt_marker_present", kind: "halt" };
  }
  const taint = sessionTaintPath(args.rollbackTarget, args.sessionId);
  if (fs.existsSync(taint)) {
    return { halted: true, reason: "session_taint_present", kind: "taint" };
  }
  const pending = readD3V2SessionStartPendingRollbackIntent(args);
  if (pending.pending) {
    return { halted: true, reason: pending.reason ?? "pending_rollback_intent", kind: "pending_intent" };
  }
  return { halted: false, reason: null, kind: null };
}

export function executeD3V2SessionStartRollbackOperator(args: {
  target: "sandbox" | "production";
  settingsPath: string;
  stateRoot: string;
  sessionId: string;
  activationObject: Readonly<Record<string, unknown>>;
  rollbackAuthorization: Readonly<Record<string, unknown>>;
  productionTargetAuthorization?: Readonly<Record<string, unknown>> | null;
  reason: string;
  operatorContinue?: boolean;
  /** Optional; must equal activation binding when provided. Never overrides activation. */
  sessionFilePath?: string;
  quarantineTarget?: string;
  /**
   * Closed-set R3.6 one-shot sandbox-only test hook. Production default path never
   * supplies this. Applied after path preflight and before any mkdir/open/rename.
   * Requires env token PI_ASTACK_R36_TEST_TOKEN and target==="sandbox".
   */
  __testAncestorSwapAfterPreflight?: D3V2R36TestAncestorSwapHook;
}): {
  receipts: readonly Readonly<Record<string, unknown>>[];
  barrier: Readonly<Record<string, unknown>>;
  settingsAfter: {
    enabled: boolean;
    selector: { session_ids: string[] };
  };
  resumed_from_receipt_count: number;
  halted: boolean;
  faces_completed: readonly D3V2RollbackFace[];
} {
  // R3.7: session_id must be a single safe filename component before any path join.
  assertSafeSessionIdComponent(args.sessionId);
  const settingsPath = path.resolve(args.settingsPath);
  const stateRoot = path.resolve(args.stateRoot);
  const auth = asRecord(args.rollbackAuthorization, "rollback authorization");
  const activationRaw = asRecord(args.activationObject, "activation object");

  // Door 1: full activation-module closed-schema validator (no trimmed objects).
  // Missing/partial activation => default-deny. Does not read production files.
  // Reuses R3.7 session_id / activation_nonce safe-component enforcement.
  let activation: D3V2BoundActivationObject;
  try {
    activation = validateBoundActivationObjectClosed(activationRaw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail("rollback_not_authorized", `bound activation closed-schema validation failed (default-deny): ${msg}`);
  }
  if (activation.session_id !== args.sessionId) {
    fail("rollback_invalid", "activation session_id mismatch");
  }
  assertSafeActivationNonceComponent(activation.activation_nonce);
  const activationNonce = activation.activation_nonce;
  const activationRollbackTarget = path.resolve(activation.rollback_target);
  // stateRoot must be identity-equal to activation.rollback_target
  if (stateRoot !== activationRollbackTarget) {
    fail("rollback_state_root_mismatch", "stateRoot must equal path.resolve(activation.rollback_target)");
  }

  // Door 2: independent rollback authorization full closed-schema + mutual bind
  validateRollbackAuthorizationClosed(auth);
  if (auth.authorization_status !== "AUTHORIZED") {
    fail("rollback_not_authorized", "rollback authorization AUTHORIZED required; default-deny without any of the three doors");
  }
  if (String(auth.activation_object_hash) !== activation.activation_object_hash) {
    fail("rollback_authorization_mismatch", "rollback authorization does not bind the activation object");
  }
  if (auth.activation_nonce != null && String(auth.activation_nonce) !== activationNonce) {
    fail("rollback_authorization_mismatch", "rollback authorization activation_nonce mismatch");
  }
  if (auth.session_id != null && String(auth.session_id) !== args.sessionId) {
    fail("rollback_authorization_mismatch", "rollback authorization session_id mismatch");
  }

  // Session/quarantine ALWAYS from activation binding; args may not override.
  const boundSessionFile = activation.session_file.path;
  const boundQuarantine = activation.quarantine_target;
  if (args.sessionFilePath != null && path.resolve(args.sessionFilePath) !== path.resolve(boundSessionFile)) {
    fail("rollback_binding_override_forbidden", "sessionFilePath args must not override activation.session_file binding");
  }
  if (args.quarantineTarget != null && path.resolve(args.quarantineTarget) !== path.resolve(boundQuarantine)) {
    fail("rollback_binding_override_forbidden", "quarantineTarget args must not override activation.quarantine_target binding");
  }
  const sessionFilePath = path.resolve(boundSessionFile);
  const quarantineTarget = path.resolve(boundQuarantine);

  let allowProductionPaths = false;
  if (args.target === "production") {
    // Door 3: independent production-target authorization AUTHORIZED + exact path bind
    if (!args.productionTargetAuthorization) {
      fail("rollback_production_forbidden", "production rollback requires independent production-target authorization; default-deny without any of the three doors");
    }
    const prod = asRecord(args.productionTargetAuthorization, "production-target authorization");
    validateProductionTargetAuthorizationClosed(prod);
    if (prod.authorization_status !== "AUTHORIZED") {
      fail("rollback_production_forbidden", "production-target authorization not AUTHORIZED; default-deny without any of the three doors");
    }
    if (String(prod.activation_object_hash) !== activation.activation_object_hash) {
      fail("rollback_production_forbidden", "production-target authorization activation bind mismatch");
    }
    if (String(prod.rollback_authorization_hash) !== String(auth.authorization_hash)) {
      fail("rollback_production_forbidden", "production-target authorization rollback bind mismatch");
    }
    // Exact path comparison — only the authorized object paths may execute.
    if (path.resolve(String(prod.production_settings_path)) !== settingsPath) {
      fail("rollback_production_path_mismatch", "settingsPath does not equal production-target authorization binding");
    }
    if (path.resolve(String(prod.production_state_root)) !== stateRoot) {
      fail("rollback_production_path_mismatch", "stateRoot does not equal production-target authorization binding");
    }
    // production_state_root must also equal activation.rollback_target (A==B identity)
    if (path.resolve(String(prod.production_state_root)) !== activationRollbackTarget) {
      fail("rollback_production_path_mismatch", "production_state_root must equal activation.rollback_target");
    }
    if (path.resolve(String(prod.production_session_file_path)) !== sessionFilePath) {
      fail("rollback_production_path_mismatch", "session file does not equal production-target authorization binding");
    }
    if (path.resolve(String(prod.production_quarantine_target)) !== quarantineTarget) {
      fail("rollback_production_path_mismatch", "quarantine target does not equal production-target authorization binding");
    }
    // Triple auth passed with exact path binds — production mutation of ONLY those paths is allowed.
    allowProductionPaths = true;
  } else {
    // sandbox still rejects hard production paths (before any write)
    if (isHardProductionPath(settingsPath) || isHardProductionPath(stateRoot)
      || isHardProductionPath(sessionFilePath) || isHardProductionPath(quarantineTarget)
      || isHardProductionPath(activationRollbackTarget)) {
      fail("rollback_production_forbidden", "sandbox rollback target must not resolve to production control roots");
    }
  }

  // R3.6 path preflight: existing-ancestor NOFOLLOW checks BEFORE any mkdir/settings/intents write.
  // Covers settings parent, stateRoot, session/quarantine parents, activation targets.
  // Missing components are NOT created yet — only refuse symlink/non-dir ancestors.
  // Subsequent creates/writes use retained parent FDs (closes check-after ancestor-swap).
  preflightRollbackPathChainsNoSymlink({
    settingsPath,
    stateRoot,
    sessionFilePath,
    quarantineTarget,
    activationRollbackTarget,
  });

  // Sandbox: nearest-existing realpath must not land under hard production roots
  // (blocks /tmp/alias → ~/.pi/agent and /tmp/alias → control root even when lexical path looks safe).
  if (!allowProductionPaths) {
    assertSandboxRealpathOutsideHardProduction(settingsPath, "settingsPath");
    assertSandboxRealpathOutsideHardProduction(path.dirname(settingsPath), "settings parent");
    assertSandboxRealpathOutsideHardProduction(stateRoot, "stateRoot");
    assertSandboxRealpathOutsideHardProduction(sessionFilePath, "sessionFilePath");
    assertSandboxRealpathOutsideHardProduction(path.dirname(sessionFilePath), "session parent");
    assertSandboxRealpathOutsideHardProduction(quarantineTarget, "quarantineTarget");
    assertSandboxRealpathOutsideHardProduction(path.dirname(quarantineTarget), "quarantine parent");
    assertSandboxRealpathOutsideHardProduction(activationRollbackTarget, "activation.rollback_target");
  }

  // R3.6 closed-set one-shot sandbox test hook: after preflight, before any write.
  // Default production path never supplies this argument.
  if (args.__testAncestorSwapAfterPreflight !== undefined) {
    applyR36TestAncestorSwapAfterPreflight({
      target: args.target,
      hook: args.__testAncestorSwapAfterPreflight,
    });
  }

  // R3.6 retained parent-fd chain create (procfd relative mkdir; never absolute-path mkdir after check).
  ensureDirectoryChainNoSymlink(stateRoot, "rollback state root");

  const receiptDir = rollbackReceiptDir(stateRoot, activationNonce);
  const intentDir = rollbackIntentDir(stateRoot, activationNonce);
  ensureDirectoryChainNoSymlink(receiptDir, "rollback receipt dir");
  ensureDirectoryChainNoSymlink(intentDir, "rollback intent dir");

  // Post-create sandbox realpath recheck (created chain must still stay outside hard roots).
  if (!allowProductionPaths) {
    assertSandboxRealpathOutsideHardProduction(stateRoot, "stateRoot post-create");
    assertSandboxRealpathOutsideHardProduction(receiptDir, "receiptDir post-create");
    assertSandboxRealpathOutsideHardProduction(intentDir, "intentDir post-create");
  }

  const existingReceipts = loadOrderedRollbackReceipts(receiptDir, D3_V2_ROLLBACK_FACES);
  let parentHash: string | null = existingReceipts.length > 0
    ? String(existingReceipts[existingReceipts.length - 1]!.receipt_hash)
    : null;
  const receipts: Array<Readonly<Record<string, unknown>>> = [...existingReceipts];
  const resumedFrom = existingReceipts.length;
  const facesCompleted: D3V2RollbackFace[] = existingReceipts.map((r) => r.face as D3V2RollbackFace);

  let settingsAfter = readSettingsSlice(settingsPath);

  for (const face of D3_V2_ROLLBACK_FACES) {
    if (receipts.some((row) => row.face === face)) continue;

    const intentPath = rollbackFaceArtifactPath(intentDir, face);
    const receiptPath = rollbackFaceArtifactPath(receiptDir, face);
    const hasIntent = fs.existsSync(intentPath);
    const hasReceipt = fs.existsSync(receiptPath);

    if (hasIntent && !hasReceipt && args.operatorContinue !== true) {
      fail("rollback_intent_without_receipt", `face ${face} has durable intent without receipt; requires operatorContinue=true`);
    }

    // Crash window: intent present, no receipt — check poststate.
    if (hasIntent && !hasReceipt && args.operatorContinue === true) {
      // Validate intent before resume (parent_hash must match receipt-chain parent).
      loadValidatedIntent({
        intentPath,
        face,
        activationNonce,
        sessionId: args.sessionId,
        expectedParentHash: parentHash,
      });
      const post = inspectFacePoststate({
        face,
        settingsPath,
        stateRoot,
        sessionId: args.sessionId,
        activationNonce,
        sessionFilePath,
        quarantineTarget,
        activation: activation as unknown as Record<string, unknown>,
      });
      if (post.status === "completed") {
        const receipt = buildD3V2SessionStartRollbackReceipt({
          face,
          activationNonce,
          sessionId: args.sessionId,
          reason: args.reason,
          payload: post.payload,
          parentHash,
        });
        atomicDurableWriteJson(receiptPath, receipt);
        receipts.push(receipt);
        parentHash = String(receipt.receipt_hash);
        facesCompleted.push(face);
        if (face === "selector_disable") settingsAfter = readSettingsSlice(settingsPath);
        continue;
      }
      if (post.status === "prestate_intact") {
        // fall through to execute
      } else {
        writeFailureHalt({
          stateRoot,
          sessionId: args.sessionId,
          activationNonce,
          reason: `ambiguous_or_failed_resume:${face}:${post.status}`,
        });
        fail("rollback_resume_ambiguous", `face ${face} resume is ambiguous/failed; halt written; no automatic retry`);
      }
    }

    // Fresh intent (atomic).
    const intentBase = {
      schema_version: D3_V2_SESSION_START_ROLLBACK_INTENT_SCHEMA,
      face,
      activation_nonce: activationNonce,
      session_id: args.sessionId,
      reason: args.reason,
      parent_hash: parentHash,
    };
    atomicDurableWriteJson(intentPath, { ...intentBase, intent_hash: jcsSha256Hex(intentBase) });

    let payload: Record<string, unknown>;
    try {
      if (face === "selector_disable") {
        const step = applySelectorDisableStep({ settingsPath, sessionId: args.sessionId });
        settingsAfter = step.settingsAfter;
        payload = step.payload;
      } else if (face === "session_taint") {
        payload = applySessionTaintStep({
          stateRoot, sessionId: args.sessionId, activationNonce, reason: args.reason,
        }).payload;
      } else if (face === "session_quarantine_rename") {
        payload = applySessionQuarantineRenameStep({
          stateRoot,
          sessionId: args.sessionId,
          activationNonce,
          reason: args.reason,
          sessionFilePath,
          quarantineTarget,
          activation: activation as unknown as Record<string, unknown>,
          allowProductionPaths,
        }).payload;
      } else {
        payload = applyTerminalHaltStep({
          stateRoot, sessionId: args.sessionId, activationNonce, reason: args.reason,
        }).payload;
      }
    } catch (error) {
      writeFailureHalt({
        stateRoot,
        sessionId: args.sessionId,
        activationNonce,
        reason: `action_failed:${face}:${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }

    // Verify postcondition before receipt.
    const post = inspectFacePoststate({
      face,
      settingsPath,
      stateRoot,
      sessionId: args.sessionId,
      activationNonce,
      sessionFilePath,
      quarantineTarget,
      activation: activation as unknown as Record<string, unknown>,
    });
    if (post.status !== "completed") {
      writeFailureHalt({
        stateRoot,
        sessionId: args.sessionId,
        activationNonce,
        reason: `postcondition_failed:${face}:${post.status}`,
      });
      fail("rollback_postcondition_failed", `face ${face} postcondition failed: ${post.status}`);
    }

    const receipt = buildD3V2SessionStartRollbackReceipt({
      face,
      activationNonce,
      sessionId: args.sessionId,
      reason: args.reason,
      payload,
      parentHash,
    });
    atomicDurableWriteJson(receiptPath, receipt);
    receipts.push(receipt);
    parentHash = String(receipt.receipt_hash);
    facesCompleted.push(face);
  }

  // Barrier: all receipts + poststate.
  for (const face of D3_V2_ROLLBACK_FACES) {
    const post = inspectFacePoststate({
      face,
      settingsPath,
      stateRoot,
      sessionId: args.sessionId,
      activationNonce,
      sessionFilePath,
      quarantineTarget,
      activation: activation as unknown as Record<string, unknown>,
    });
    if (post.status !== "completed") {
      fail("rollback_barrier_incomplete", `barrier poststate incomplete for ${face}: ${post.status}`);
    }
  }
  const barrier = buildD3V2SessionStartRollbackBarrier({ activationNonce, receipts });
  const barrierPath = rollbackBarrierPath(stateRoot, activationNonce);
  ensureDirectoryChainNoSymlink(path.dirname(barrierPath), "rollback barrier parent");
  atomicDurableWriteJson(barrierPath, barrier);

  return {
    receipts: deepFreeze(receipts),
    barrier,
    settingsAfter,
    resumed_from_receipt_count: resumedFrom,
    halted: true,
    faces_completed: deepFreeze(facesCompleted),
  };
}

/** Sandbox rehearsal — same FSM, sandbox-only synthetic AUTHORIZED objects. */
export function rehearseD3V2SessionStartRollback(args: {
  sandboxSettingsPath: string;
  sandboxStateRoot: string;
  sessionId: string;
  activationNonce: string;
  reason: string;
  /** Optional; when set must resolve under sandboxStateRoot (R3.8 containment). */
  sessionFilePath?: string;
  /** Optional; when set must resolve under sandboxStateRoot (R3.8 containment). */
  quarantineTarget?: string;
  operatorContinue?: boolean;
}): {
  receipts: readonly Readonly<Record<string, unknown>>[];
  barrier: Readonly<Record<string, unknown>>;
  settingsAfter: { enabled: boolean; selector: { session_ids: string[] } };
} {
  // R3.7: session_id / activation_nonce are safe single path components before any join.
  assertSafeSessionIdComponent(args.sessionId);
  assertSafeActivationNonceComponent(args.activationNonce);

  // R3.8: stateRoot is the unique disposable sandbox root. Resolve all rehearsal
  // paths first and force containment under it BEFORE any mkdir/write.
  const stateRoot = path.resolve(args.sandboxStateRoot);
  const settingsPath = path.resolve(args.sandboxSettingsPath);
  // Defaults stay under stateRoot; retained overrides must still be contained.
  const sessionFile = args.sessionFilePath != null && String(args.sessionFilePath).length > 0
    ? path.resolve(args.sessionFilePath)
    : joinUnderRootContained(stateRoot, "sessions", `${args.sessionId}.jsonl`);
  const quarantine = args.quarantineTarget != null && String(args.quarantineTarget).length > 0
    ? path.resolve(args.quarantineTarget)
    : joinUnderRootContained(stateRoot, "quarantine", `${args.sessionId}.jsonl`);

  // Pure containment (no I/O): external absolute / sibling / .. rejected here.
  assertResolvedPathContainedUnderRoot(stateRoot, settingsPath, "sandboxSettingsPath");
  assertResolvedPathContainedUnderRoot(stateRoot, path.dirname(settingsPath), "sandboxSettingsPath parent");
  assertResolvedPathContainedUnderRoot(stateRoot, sessionFile, "sessionFilePath");
  assertResolvedPathContainedUnderRoot(stateRoot, path.dirname(sessionFile), "sessionFilePath parent");
  assertResolvedPathContainedUnderRoot(stateRoot, quarantine, "quarantineTarget");
  assertResolvedPathContainedUnderRoot(stateRoot, path.dirname(quarantine), "quarantineTarget parent");

  if (
    isHardProductionPath(settingsPath)
    || isHardProductionPath(stateRoot)
    || isHardProductionPath(sessionFile)
    || isHardProductionPath(quarantine)
  ) {
    fail("rollback_production_forbidden", "rollback rehearsal must stay inside disposable sandbox paths");
  }

  // Preflight before any write (same R3.5 ancestor rules as production operator).
  assertExistingAncestorsNoSymlink(path.dirname(settingsPath), "rehearsal settings parent");
  assertExistingAncestorsNoSymlink(stateRoot, "rehearsal stateRoot");
  assertExistingAncestorsNoSymlink(path.dirname(sessionFile), "rehearsal session parent");
  assertExistingAncestorsNoSymlink(path.dirname(quarantine), "rehearsal quarantine parent");
  assertSandboxRealpathOutsideHardProduction(settingsPath, "rehearsal settingsPath");
  assertSandboxRealpathOutsideHardProduction(stateRoot, "rehearsal stateRoot");
  assertSandboxRealpathOutsideHardProduction(sessionFile, "rehearsal sessionFile");
  assertSandboxRealpathOutsideHardProduction(quarantine, "rehearsal quarantine");

  ensureDirectoryChainNoSymlink(stateRoot, "rehearsal state root");
  ensureDirectoryChainNoSymlink(path.dirname(sessionFile), "rehearsal session parent");
  // R3.7: no absolute existsSync/writeFileSync after preflight — retained-FD anchored only.
  if (!pathExistsRegularFileAnchored(sessionFile)) {
    atomicDurableWriteText(sessionFile, `{"session":"${args.sessionId}"}\n`);
  }

  // Anchored lstat + read (no absolute post-validation open of session file).
  const st = lstatRegularFileAnchored(sessionFile, "rehearsal session");
  const prefix = Buffer.from(readTextFileAnchored(sessionFile, "rehearsal session"), "utf8");

  const activation = buildD3V2SessionStartActivationObject({
    sessionId: args.sessionId,
    activationNonce: args.activationNonce,
    authorizationStatus: "AUTHORIZED",
    authorizationCoordinate: {
      schema_version: "adr0040-d3-v2-session-start-sandbox-rehearsal-authorization/v1",
      mode: "sandbox_rehearsal_only",
    },
    d3Identities: {
      selection_hash: "0".repeat(64),
      head_hash: "0".repeat(64),
      proof_hash: "0".repeat(64),
      intent_hash: "0".repeat(64),
      stable_bundle_hash: "0".repeat(64),
      p2a_bundle_hash: "0".repeat(64),
      generation: 0,
      selection_seq: 0,
    },
    adapterManifestHash: "0".repeat(64),
    settingsMutation: { enabled: false },
    auditTarget: joinUnderRootContained(stateRoot, "audit-target.jsonl"),
    rollbackTarget: stateRoot,
    sessionFile: {
      path: path.resolve(sessionFile),
      dev: st.dev,
      ino: st.ino,
      prefix_bytes: prefix.length,
      prefix_sha256: sha256Hex(prefix),
    },
    quarantineTarget: path.resolve(quarantine),
    mode: "bound",
  });
  const rollbackAuthorization = buildD3V2SessionStartRollbackAuthorization({
    activationObject: activation,
    authorizationStatus: "AUTHORIZED",
    grantPhrase: "sandbox-rehearsal-only",
  });
  const result = executeD3V2SessionStartRollbackOperator({
    target: "sandbox",
    settingsPath,
    stateRoot,
    sessionId: args.sessionId,
    activationObject: activation,
    rollbackAuthorization,
    reason: args.reason,
    operatorContinue: args.operatorContinue,
    sessionFilePath: path.resolve(sessionFile),
    quarantineTarget: path.resolve(quarantine),
  });
  return {
    receipts: result.receipts,
    barrier: result.barrier,
    settingsAfter: result.settingsAfter,
  };
}

function applySelectorDisableStep(args: { settingsPath: string; sessionId: string }): {
  settingsAfter: { enabled: boolean; selector: { session_ids: string[] } };
  payload: Record<string, unknown>;
} {
  // Anchored read through retained parent FD (R3.6) so a mid-step ancestor swap cannot
  // redirect the read/write into production.
  const raw = readTextFileAnchored(args.settingsPath, "settings read");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const ruleInjector = asRecord(parsed.ruleInjector ?? {}, "sandbox ruleInjector");
  const current = asRecord(ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection ?? {}, "v2 settings");
  const selector = asRecord(current.selector ?? {}, "selector");
  const sessionIds = Array.isArray(selector.session_ids)
    ? selector.session_ids.filter((id): id is string => typeof id === "string" && id !== args.sessionId)
    : [];
  const next = {
    ...current,
    enabled: false,
    selector: { session_ids: sessionIds },
  };
  ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection = next;
  parsed.ruleInjector = ruleInjector;
  const out = `${JSON.stringify(parsed, null, 2)}\n`;
  atomicDurableSettingsWrite(args.settingsPath, out);
  return {
    settingsAfter: { enabled: false, selector: { session_ids: sessionIds } },
    payload: {
      enabled: false,
      selector_session_ids: sessionIds,
      settings_path_sha256: sha256Hex(args.settingsPath),
      settings_raw_sha256: sha256Hex(out),
    },
  };
}

function applySessionTaintStep(args: {
  stateRoot: string; sessionId: string; activationNonce: string; reason: string;
}): { payload: Record<string, unknown> } {
  const taint = {
    schema_version: D3_V2_SESSION_START_SESSION_TAINT_SCHEMA,
    session_id: args.sessionId,
    activation_nonce: args.activationNonce,
    reason: args.reason,
    tainted_at_ms: Date.now(),
  };
  const taintPath = sessionTaintPath(args.stateRoot, args.sessionId);
  ensureDirectoryChainNoSymlink(path.dirname(taintPath), "session taint parent");
  atomicDurableWriteJson(taintPath, taint);
  return {
    payload: {
      taint_path_sha256: sha256Hex(taintPath),
      taint_sha256: sha256Hex(`${canonicalizeJcs(taint)}\n`),
    },
  };
}

function applySessionQuarantineRenameStep(args: {
  stateRoot: string;
  sessionId: string;
  activationNonce: string;
  reason: string;
  sessionFilePath: string;
  quarantineTarget: string;
  activation: Record<string, unknown>;
  allowProductionPaths: boolean;
}): { payload: Record<string, unknown> } {
  if (!args.sessionFilePath || !args.quarantineTarget) {
    fail("quarantine_binding_missing", "session_file and quarantine_target required for quarantine rename");
  }
  const source = path.resolve(args.sessionFilePath);
  const dest = path.resolve(args.quarantineTarget);
  if (!args.allowProductionPaths && (isHardProductionPath(source) || isHardProductionPath(dest))) {
    fail("quarantine_production_forbidden", "quarantine paths must not be production under sandbox");
  }
  const sessionFileBinding = args.activation.session_file && typeof args.activation.session_file === "object"
    ? args.activation.session_file as Record<string, unknown>
    : null;
  if (!sessionFileBinding) fail("quarantine_binding_missing", "activation.session_file required");

  const sourceDir = path.dirname(source);
  const destDir = path.dirname(dest);
  const sourceBase = path.basename(source);
  const destBase = path.basename(dest);
  const prefixBytes = Number(sessionFileBinding.prefix_bytes);

  // R3.6: retain BOTH source-parent and dest-parent FDs across the critical section.
  // Final re-lstat + rename use /proc/self/fd/<parentFd>/<basename> so an ancestor
  // swap after preflight cannot retarget the rename into production.
  const sourceParent = walkRetainParentDirectoryFd(sourceDir, { create: false, label: "session parent" });
  let destParent: D3V2RetainedDirFd | null = null;
  let sourceFd = -1;
  try {
    destParent = walkRetainParentDirectoryFd(destDir, { create: true, label: "quarantine parent" });
    const sourceProc = procFdChildPath(sourceParent.fd, sourceBase);
    const destProc = procFdChildPath(destParent.fd, destBase);

    const named = fs.lstatSync(sourceProc);
    if (named.isSymbolicLink() || !named.isFile()) fail("quarantine_source_unsafe", "session file is not a regular non-symlink file");
    if (named.dev !== Number(sessionFileBinding.dev) || named.ino !== Number(sessionFileBinding.ino)) {
      fail("quarantine_identity_mismatch", "session file dev/ino differs from activation binding");
    }

    // Hold source FD across the critical section (TOCTOU strengthen).
    sourceFd = fs.openSync(sourceProc, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(sourceFd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      fail("quarantine_identity_mismatch", "source FD identity differs from lstat");
    }
    const buf = Buffer.allocUnsafe(prefixBytes);
    const read = prefixBytes === 0 ? 0 : fs.readSync(sourceFd, buf, 0, prefixBytes, 0);
    if (read !== prefixBytes) fail("quarantine_prefix_read_failed", "prefix read incomplete");
    if (sha256Hex(buf.subarray(0, prefixBytes)) !== String(sessionFileBinding.prefix_sha256)) {
      fail("quarantine_prefix_mismatch", "session prefix differs from activation-time binding");
    }

    // dest must be NOFOLLOW-absent via dest-parent procfd. Existing dest => halt.
    assertPathNofollowAbsentAtParentFd(destParent.fd, destBase, "quarantine dest");

    // Immediately before rename: re-lstat source identity + re-check dest absent via procfd.
    const namedAgain = fs.lstatSync(sourceProc);
    if (namedAgain.isSymbolicLink() || !namedAgain.isFile()
      || namedAgain.dev !== named.dev || namedAgain.ino !== named.ino) {
      fail("quarantine_identity_race", "source identity changed immediately before rename");
    }
    const openedAgain = fs.fstatSync(sourceFd);
    if (openedAgain.dev !== named.dev || openedAgain.ino !== named.ino) {
      fail("quarantine_identity_race", "source FD identity drifted immediately before rename");
    }
    assertPathNofollowAbsentAtParentFd(destParent.fd, destBase, "quarantine dest pre-rename");

    // Real rename via retained parent FDs (not copy+delete; not absolute-path rename).
    // Node has no RENAME_NOREPLACE — see residual constant.
    try {
      fs.renameSync(sourceProc, destProc);
    } catch (error) {
      fail("quarantine_rename_failed", `rename failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    fs.fsyncSync(sourceParent.fd);
    fs.fsyncSync(destParent.fd);

    // Postcondition via procfd: source absent, dest present with source identity.
    try {
      fs.lstatSync(sourceProc);
      fail("quarantine_postcondition", "source still present after rename");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail("quarantine_postcondition", `source lstat after rename unexpected: ${(error as Error).message}`);
      }
    }
    let destStat: fs.Stats;
    try {
      destStat = fs.lstatSync(destProc);
    } catch (error) {
      fail("quarantine_postcondition", `dest missing after rename: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (destStat!.isSymbolicLink() || !destStat!.isFile()) {
      fail("quarantine_postcondition", "dest is not a regular non-symlink file");
    }
    // Held source FD still refers to the inode (now at dest).
    const fdAfter = fs.fstatSync(sourceFd);
    if (fdAfter.dev !== Number(sessionFileBinding.dev) || fdAfter.ino !== Number(sessionFileBinding.ino)) {
      fail("quarantine_postcondition", "held source FD identity drifted after rename");
    }
    if (destStat!.dev !== fdAfter.dev || destStat!.ino !== fdAfter.ino) {
      fail("quarantine_postcondition", "dest dev/ino does not match held source FD (concurrent dest race halt)");
    }
    if (destStat!.dev !== Number(sessionFileBinding.dev) || destStat!.ino !== Number(sessionFileBinding.ino)) {
      fail("quarantine_postcondition", "dest dev/ino differs from activation session_file binding");
    }
    // Prefix still holds via held FD (same inode).
    const prefixBuf = Buffer.allocUnsafe(prefixBytes);
    const prefixRead = prefixBytes === 0 ? 0 : fs.readSync(sourceFd, prefixBuf, 0, prefixBytes, 0);
    if (prefixRead !== prefixBytes) fail("quarantine_postcondition", "post-rename prefix read incomplete");
    if (sha256Hex(prefixBuf.subarray(0, prefixBytes)) !== String(sessionFileBinding.prefix_sha256)) {
      fail("quarantine_postcondition", "post-rename prefix differs from activation-time binding");
    }

    return {
      payload: {
        source_path_sha256: sha256Hex(source),
        dest_path_sha256: sha256Hex(dest),
        dest_size: destStat!.size,
        dest_dev: destStat!.dev,
        dest_ino: destStat!.ino,
        renamed: true,
        deleted: false,
        rename_residual: D3_V2_SESSION_START_QUARANTINE_RENAME_RESIDUAL,
        rename_via_retained_parent_fds: true,
      },
    };
  } finally {
    if (sourceFd >= 0) {
      try { fs.closeSync(sourceFd); } catch { /* ignore */ }
    }
    if (destParent) {
      try { fs.closeSync(destParent.fd); } catch { /* ignore */ }
    }
    try { fs.closeSync(sourceParent.fd); } catch { /* ignore */ }
  }
}

function assertPathNofollowAbsent(target: string, label: string): void {
  try {
    const st = fs.lstatSync(target);
    // Present under any type (file/dir/symlink) => halt; never proceed to overwrite.
    fail("quarantine_target_exists", `${label} must be NOFOLLOW-absent; found type present (concurrent create must postcondition-halt)`);
    void st;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("quarantine_target_probe_failed", `${label} lstat failed: ${(error as Error).message}`);
    }
  }
}

function assertPathNofollowAbsentAtParentFd(parentFd: number, basename: string, label: string): void {
  const child = procFdChildPath(parentFd, basename);
  try {
    const st = fs.lstatSync(child);
    fail("quarantine_target_exists", `${label} must be NOFOLLOW-absent; found type present (concurrent create must postcondition-halt)`);
    void st;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("quarantine_target_probe_failed", `${label} procfd lstat failed: ${(error as Error).message}`);
    }
  }
}

function applyTerminalHaltStep(args: {
  stateRoot: string; sessionId: string; activationNonce: string; reason: string;
}): { payload: Record<string, unknown> } {
  const halt = {
    schema_version: D3_V2_SESSION_START_HALT_SCHEMA,
    activation_nonce: args.activationNonce,
    session_id: args.sessionId,
    reason: args.reason,
    auto_retry: false,
  };
  const haltPath = haltMarkerPath(args.stateRoot, args.activationNonce);
  ensureDirectoryChainNoSymlink(path.dirname(haltPath), "halt marker parent");
  atomicDurableWriteJson(haltPath, halt);
  return { payload: { auto_retry: false, halt_path_sha256: sha256Hex(haltPath) } };
}

function writeFailureHalt(args: {
  stateRoot: string; sessionId: string; activationNonce: string; reason: string;
}): void {
  try {
    applyTerminalHaltStep(args);
    const failurePath = haltFailurePath(args.stateRoot, args.activationNonce);
    atomicDurableWriteJson(failurePath, {
      schema_version: "adr0040-d3-v2-session-start-halt-failure/v1",
      activation_nonce: args.activationNonce,
      session_id: args.sessionId,
      reason: args.reason,
      auto_retry: false,
    });
  } catch { /* best-effort */ }
}

function inspectFacePoststate(args: {
  face: D3V2RollbackFace;
  settingsPath: string;
  stateRoot: string;
  sessionId: string;
  activationNonce: string;
  sessionFilePath: string;
  quarantineTarget: string;
  activation: Record<string, unknown>;
}): { status: "completed" | "prestate_intact" | "ambiguous"; payload: Record<string, unknown> } {
  if (args.face === "selector_disable") {
    try {
      const slice = readSettingsSlice(args.settingsPath);
      if (slice.enabled === false && !slice.selector.session_ids.includes(args.sessionId)) {
        return {
          status: "completed",
          payload: {
            enabled: false,
            selector_session_ids: slice.selector.session_ids,
            settings_path_sha256: sha256Hex(args.settingsPath),
            settings_raw_sha256: sha256Hex(readTextFileAnchored(args.settingsPath, "settings postcondition")),
          },
        };
      }
      if (slice.enabled === true || slice.selector.session_ids.includes(args.sessionId)) {
        return { status: "prestate_intact", payload: {} };
      }
      return { status: "ambiguous", payload: {} };
    } catch {
      return { status: "ambiguous", payload: {} };
    }
  }
  if (args.face === "session_taint") {
    const taint = sessionTaintPath(args.stateRoot, args.sessionId);
    try {
      const taintRaw = readTextFileAnchored(taint, "taint postcondition");
      return {
        status: "completed",
        payload: {
          taint_path_sha256: sha256Hex(taint),
          taint_sha256: sha256Hex(taintRaw),
        },
      };
    } catch {
      return { status: "prestate_intact", payload: {} };
    }
  }
  if (args.face === "session_quarantine_rename") {
    const source = args.sessionFilePath ? path.resolve(args.sessionFilePath) : "";
    const dest = args.quarantineTarget ? path.resolve(args.quarantineTarget) : "";
    // Anchored existence/identity probes (R3.6) — refuse to follow swapped ancestors.
    let sourceExists = false;
    let destExists = false;
    let destStat: fs.Stats | null = null;
    if (source) {
      try {
        const sp = walkRetainParentDirectoryFd(path.dirname(source), { create: false, label: "quarantine post source parent" });
        try {
          fs.lstatSync(procFdChildPath(sp.fd, path.basename(source)));
          sourceExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          try { fs.closeSync(sp.fd); } catch { /* ignore */ }
        }
      } catch {
        sourceExists = fs.existsSync(source);
      }
    }
    if (dest) {
      try {
        const dp = walkRetainParentDirectoryFd(path.dirname(dest), { create: false, label: "quarantine post dest parent" });
        try {
          destStat = fs.lstatSync(procFdChildPath(dp.fd, path.basename(dest)));
          destExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          try { fs.closeSync(dp.fd); } catch { /* ignore */ }
        }
      } catch {
        destExists = fs.existsSync(dest);
        if (destExists) destStat = fs.lstatSync(dest);
      }
    }
    if (!sourceExists && destExists && destStat) {
      const binding = args.activation.session_file && typeof args.activation.session_file === "object"
        ? args.activation.session_file as Record<string, unknown>
        : null;
      // Resume must re-verify dest dev/ino/prefix against activation binding via retained parent FD.
      if (binding) {
        if (destStat.dev !== Number(binding.dev) || destStat.ino !== Number(binding.ino)) {
          return { status: "ambiguous", payload: {} };
        }
        try {
          const prefixBytes = Number(binding.prefix_bytes);
          const dp = walkRetainParentDirectoryFd(path.dirname(dest), { create: false, label: "quarantine resume dest parent" });
          try {
            const fd = fs.openSync(procFdChildPath(dp.fd, path.basename(dest)), fs.constants.O_RDONLY | NOFOLLOW);
            try {
              const buf = Buffer.allocUnsafe(prefixBytes);
              const read = prefixBytes === 0 ? 0 : fs.readSync(fd, buf, 0, prefixBytes, 0);
              if (read !== prefixBytes) return { status: "ambiguous", payload: {} };
              if (sha256Hex(buf.subarray(0, prefixBytes)) !== String(binding.prefix_sha256)) {
                return { status: "ambiguous", payload: {} };
              }
            } finally {
              fs.closeSync(fd);
            }
          } finally {
            try { fs.closeSync(dp.fd); } catch { /* ignore */ }
          }
        } catch {
          return { status: "ambiguous", payload: {} };
        }
      }
      return {
        status: "completed",
        payload: {
          source_path_sha256: sha256Hex(source),
          dest_path_sha256: sha256Hex(dest),
          dest_size: destStat.size,
          dest_dev: destStat.dev,
          dest_ino: destStat.ino,
          renamed: true,
          deleted: false,
        },
      };
    }
    if (sourceExists && !destExists) return { status: "prestate_intact", payload: {} };
    return { status: "ambiguous", payload: {} };
  }
  // terminal_halt
  const haltPath = haltMarkerPath(args.stateRoot, args.activationNonce);
  if (fs.existsSync(haltPath)) {
    return {
      status: "completed",
      payload: { auto_retry: false, halt_path_sha256: sha256Hex(haltPath) },
    };
  }
  return { status: "prestate_intact", payload: {} };
}

function loadValidatedIntent(args: {
  intentPath: string;
  face: D3V2RollbackFace;
  activationNonce: string;
  sessionId: string;
  /** When provided (including null), parent_hash must equal this receipt-chain parent. Omit to skip (pending-intent halt scan only). */
  expectedParentHash?: string | null;
}): Readonly<Record<string, unknown>> {
  const raw = fs.readFileSync(args.intentPath, "utf8");
  if (!raw.endsWith("\n") || raw.includes("\r")) fail("rollback_intent_invalid", "intent must be exact JCS+LF");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { fail("rollback_intent_invalid", "intent is not JSON"); }
  const row = asRecord(parsed, `intent ${args.face}`);
  if (`${canonicalizeJcs(row)}\n` !== raw) fail("rollback_intent_invalid", "intent is not exact JCS+LF");
  for (const key of Object.keys(row)) {
    if (!(INTENT_KEYS as readonly string[]).includes(key)) {
      fail("rollback_intent_invalid", `intent unknown field: ${key}`);
    }
  }
  for (const key of INTENT_KEYS) {
    if (!(key in row)) fail("rollback_intent_invalid", `intent missing required field: ${key}`);
  }
  if (row.schema_version !== D3_V2_SESSION_START_ROLLBACK_INTENT_SCHEMA) {
    fail("rollback_intent_invalid", "intent schema differs");
  }
  if (row.face !== args.face) fail("rollback_intent_invalid", "intent face mismatch");
  if (row.activation_nonce !== args.activationNonce) fail("rollback_intent_invalid", "intent activation_nonce mismatch");
  if (row.session_id !== args.sessionId) fail("rollback_intent_invalid", "intent session_id mismatch");
  const base = { ...row }; delete base.intent_hash;
  if (String(row.intent_hash) !== jcsSha256Hex(base)) fail("rollback_intent_invalid", "intent self-hash differs");
  if (args.expectedParentHash !== undefined) {
    const actualParent = row.parent_hash === undefined ? null : (row.parent_hash as string | null);
    if (actualParent !== args.expectedParentHash) {
      fail(
        "rollback_intent_parent_mismatch",
        `intent parent_hash does not match receipt-chain parentHash (stale/out-of-order intent rejected)`,
      );
    }
  }
  return deepFreeze(row);
}

function loadOrderedRollbackReceipts(
  receiptDir: string,
  faces: readonly D3V2RollbackFace[],
): Array<Readonly<Record<string, unknown>>> {
  const loaded: Array<Readonly<Record<string, unknown>>> = [];
  let expectedParent: string | null = null;
  for (const face of faces) {
    const file = rollbackFaceArtifactPath(receiptDir, face);
    if (!fs.existsSync(file)) break;
    const raw = fs.readFileSync(file, "utf8");
    const row = asRecord(JSON.parse(raw), `receipt ${face}`);
    if (row.face !== face) fail("rollback_receipt_invalid", `receipt face mismatch for ${face}`);
    const base = { ...row }; delete base.receipt_hash;
    if (String(row.receipt_hash) !== jcsSha256Hex(base)) fail("rollback_receipt_invalid", `receipt self-hash differs for ${face}`);
    if ((row.parent_hash ?? null) !== expectedParent) fail("rollback_receipt_invalid", `receipt parent chain broken at ${face}`);
    if (`${canonicalizeJcs(row)}\n` !== raw) fail("rollback_receipt_invalid", `receipt is not JCS+LF at ${face}`);
    loaded.push(deepFreeze(row));
    expectedParent = String(row.receipt_hash);
  }
  return loaded;
}

function readSettingsSlice(settingsPath: string): { enabled: boolean; selector: { session_ids: string[] } } {
  const parsed = JSON.parse(readTextFileAnchored(settingsPath, "settings slice")) as Record<string, unknown>;
  const ruleInjector = asRecord(parsed.ruleInjector ?? {}, "ruleInjector");
  const current = asRecord(ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection ?? {}, "v2");
  const selector = asRecord(current.selector ?? {}, "selector");
  const sessionIds = Array.isArray(selector.session_ids)
    ? selector.session_ids.filter((id): id is string => typeof id === "string")
    : [];
  return { enabled: current.enabled === true, selector: { session_ids: sessionIds } };
}

function atomicDurableSettingsWrite(file: string, raw: string): void {
  atomicDurableWriteText(file, raw);
}

function atomicDurableWriteJson(file: string, value: unknown): void {
  atomicDurableWriteText(file, `${canonicalizeJcs(value)}\n`);
}

/**
 * Atomic temp + fsync + rename + parent fsync for intent/receipt/taint/halt/barrier/settings.
 * R3.6: all create/open/rename go through retained parent FD procfd paths — never
 * validate-then-absolute-path open/rename (closes check-after ancestor-swap window).
 */
function atomicDurableWriteText(file: string, raw: string): void {
  const resolved = path.resolve(file);
  const directory = path.dirname(resolved);
  const base = path.basename(resolved);
  const parent = walkRetainParentDirectoryFd(directory, { create: true, label: "atomic write parent" });
  try {
    const tmpBase = `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const tmpProc = procFdChildPath(parent.fd, tmpBase);
    const finalProc = procFdChildPath(parent.fd, base);
    const fd = fs.openSync(tmpProc, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, raw);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpProc, finalProc);
    fs.fsyncSync(parent.fd);
  } finally {
    try { fs.closeSync(parent.fd); } catch { /* ignore */ }
  }
}

/** Anchored text read through retained parent FD + O_NOFOLLOW open of basename. */
function readTextFileAnchored(file: string, label: string): string {
  const resolved = path.resolve(file);
  const parent = walkRetainParentDirectoryFd(path.dirname(resolved), { create: false, label: `${label} parent` });
  try {
    const child = procFdChildPath(parent.fd, path.basename(resolved));
    const named = fs.lstatSync(child);
    if (named.isSymbolicLink() || !named.isFile()) {
      fail("file_unsafe", `${label}: not a regular non-symlink file: ${resolved}`);
    }
    const fd = fs.openSync(child, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
        fail("file_identity_mismatch", `${label}: open identity differs from lstat: ${resolved}`);
      }
      return fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    try { fs.closeSync(parent.fd); } catch { /* ignore */ }
  }
}

/**
 * R3.7: existence probe via retained parent FD + procfd lstat.
 * Returns false on any error (missing parent, missing file, not a regular file).
 * Never opens the absolute path after a check for write purposes.
 */
function pathExistsRegularFileAnchored(file: string): boolean {
  const resolved = path.resolve(file);
  try {
    const parent = walkRetainParentDirectoryFd(path.dirname(resolved), {
      create: false,
      label: "exists regular parent",
    });
    try {
      const child = procFdChildPath(parent.fd, path.basename(resolved));
      const st = fs.lstatSync(child);
      return st.isFile() && !st.isSymbolicLink();
    } finally {
      try { fs.closeSync(parent.fd); } catch { /* ignore */ }
    }
  } catch {
    return false;
  }
}

/** R3.7: lstat a regular non-symlink file via retained parent FD (no absolute post-check open). */
function lstatRegularFileAnchored(file: string, label: string): fs.Stats {
  const resolved = path.resolve(file);
  const parent = walkRetainParentDirectoryFd(path.dirname(resolved), { create: false, label: `${label} parent` });
  try {
    const child = procFdChildPath(parent.fd, path.basename(resolved));
    const named = fs.lstatSync(child);
    if (named.isSymbolicLink() || !named.isFile()) {
      fail("file_unsafe", `${label}: not a regular non-symlink file: ${resolved}`);
    }
    return named;
  } finally {
    try { fs.closeSync(parent.fd); } catch { /* ignore */ }
  }
}

function fsyncDir(directory: string): void {
  // Prefer retained-fd open of the directory itself (still absolute open of the dir
  // entry is only used as a best-effort fsync helper for callers that already wrote
  // via retained parent FDs). On Linux this still refuses symlinks via O_NOFOLLOW.
  const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

/** Full Door2 closed-schema validator: required+no-extra, schema, grant hash, fixed faces/auto_retry/crash_resume, selfhash. */
function validateRollbackAuthorizationClosed(auth: Record<string, unknown>): void {
  for (const key of Object.keys(auth)) {
    if (!(ROLLBACK_AUTH_KEYS as readonly string[]).includes(key)) {
      fail("rollback_authorization_schema_closed", `rollback auth unknown field: ${key}`);
    }
  }
  for (const key of ROLLBACK_AUTH_KEYS) {
    if (!(key in auth)) fail("rollback_authorization_schema_closed", `rollback auth missing required field: ${key}`);
  }
  if (auth.schema_version !== D3_V2_SESSION_START_ROLLBACK_AUTHORIZATION_SCHEMA) {
    fail("rollback_authorization_schema_closed", "rollback auth schema differs");
  }
  if (auth.authorization_status !== "AUTHORIZED" && auth.authorization_status !== "NOT_AUTHORIZED") {
    fail("rollback_authorization_schema_closed", "rollback auth authorization_status invalid");
  }
  assertHash(auth.activation_object_hash, "activation_object_hash");
  assertHash(auth.authorization_hash, "authorization_hash");
  if (!Array.isArray(auth.faces) || canonicalizeJcs(auth.faces) !== canonicalizeJcs([...D3_V2_ROLLBACK_FACES])) {
    fail("rollback_authorization_schema_closed", "rollback auth faces must be the fixed face order");
  }
  if (auth.auto_retry !== false) {
    fail("rollback_authorization_schema_closed", "rollback auth auto_retry must be false");
  }
  if (auth.crash_resume !== CRASH_RESUME_SEMANTICS) {
    fail("rollback_authorization_schema_closed", "rollback auth crash_resume semantics must be fixed");
  }
  if (auth.authorization_status === "AUTHORIZED") {
    assertHash(auth.grant_phrase_sha256, "grant_phrase_sha256");
  } else if (auth.grant_phrase_sha256 != null) {
    assertHash(auth.grant_phrase_sha256, "grant_phrase_sha256");
  }
  const base = { ...auth };
  delete base.authorization_hash;
  if (jcsSha256Hex(base) !== String(auth.authorization_hash)) {
    fail("rollback_authorization_selfhash", "rollback authorization self-hash differs");
  }
}

/** Full Door3 closed-schema validator: required+no-extra, schema, grant hash, path fields, selfhash. */
function validateProductionTargetAuthorizationClosed(prod: Record<string, unknown>): void {
  for (const key of Object.keys(prod)) {
    if (!(PROD_AUTH_KEYS as readonly string[]).includes(key)) {
      fail("production_target_authorization_schema_closed", `prod auth unknown field: ${key}`);
    }
  }
  for (const key of PROD_AUTH_KEYS) {
    if (!(key in prod)) fail("production_target_authorization_schema_closed", `prod auth missing required field: ${key}`);
  }
  if (prod.schema_version !== D3_V2_SESSION_START_PRODUCTION_TARGET_AUTHORIZATION_SCHEMA) {
    fail("production_target_authorization_schema_closed", "prod auth schema differs");
  }
  if (prod.authorization_status !== "AUTHORIZED" && prod.authorization_status !== "NOT_AUTHORIZED") {
    fail("production_target_authorization_schema_closed", "prod auth authorization_status invalid");
  }
  assertHash(prod.activation_object_hash, "activation_object_hash");
  assertHash(prod.rollback_authorization_hash, "rollback_authorization_hash");
  assertHash(prod.authorization_hash, "authorization_hash");
  if (typeof prod.production_settings_path !== "string" || !path.isAbsolute(prod.production_settings_path)) {
    fail("production_target_authorization_schema_closed", "production_settings_path must be absolute");
  }
  if (typeof prod.production_state_root !== "string" || !path.isAbsolute(prod.production_state_root)) {
    fail("production_target_authorization_schema_closed", "production_state_root must be absolute");
  }
  if (prod.authorization_status === "AUTHORIZED") {
    assertHash(prod.grant_phrase_sha256, "grant_phrase_sha256");
    if (typeof prod.production_session_file_path !== "string" || !path.isAbsolute(prod.production_session_file_path)) {
      fail("production_target_authorization_schema_closed", "production_session_file_path must be absolute when AUTHORIZED");
    }
    if (typeof prod.production_quarantine_target !== "string" || !path.isAbsolute(prod.production_quarantine_target)) {
      fail("production_target_authorization_schema_closed", "production_quarantine_target must be absolute when AUTHORIZED");
    }
  }
  const base = { ...prod };
  delete base.authorization_hash;
  if (jcsSha256Hex(base) !== String(prod.authorization_hash)) {
    fail("rollback_production_forbidden", "production-target authorization self-hash differs");
  }
}

/**
 * Hard production roots derived from HOME + default activation root.
 * Boundary-safe: exact match or `${root}${sep}` prefix only (no substring exemptions).
 * Covers: ~/.abrain, ~/.pi/agent (settings/sessions), adr0040-d3-v2-session-start
 * control subtree, runtime-audit file, default activation root.
 */
function listHardProductionRoots(): string[] {
  const home = path.resolve(os.homedir());
  const controlRoot = path.join(home, ".pi", ".pi-astack", "adr0040-d3-v2-session-start");
  return [
    path.join(home, ".abrain"),
    path.join(home, ".pi", "agent"),
    controlRoot,
    path.join(home, ".pi", ".pi-astack", "adr0040-d3-v2-session-start-runtime-audit.jsonl"),
    path.resolve(D3_V2_SESSION_START_DEFAULT_ACTIVATION_ROOT),
  ];
}

function isHardProductionPath(resolved: string): boolean {
  const r = path.resolve(resolved);
  for (const root of listHardProductionRoots()) {
    const base = path.resolve(root);
    if (r === base || r.startsWith(base + path.sep)) return true;
  }
  return false;
}

export function listD3V2SessionStartHardProductionRoots(): readonly string[] {
  return Object.freeze(listHardProductionRoots().map((r) => path.resolve(r)));
}

/**
 * R3.5/R3.6 pure path-chain safety: walk existing ancestors of `target` with lstat NOFOLLOW.
 * Every existing component must not be a symlink. Every existing intermediate (non-final)
 * must be a regular directory. Stops at first ENOENT. Does not create anything.
 * Preflight-only detection; create/write paths use retained parent FDs (R3.6).
 */
export function assertExistingAncestorsNoSymlink(target: string, label: string): {
  nearestExisting: string;
  targetExists: boolean;
} {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  let nearestExisting = parsed.root;
  const rootStat = lstatMaybe(current);
  if (rootStat) {
    if (rootStat.isSymbolicLink()) fail("path_ancestor_symlink", `${label}: filesystem root is a symlink`);
    nearestExisting = current;
  }
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]!);
    const st = lstatMaybe(current);
    if (!st) {
      return { nearestExisting, targetExists: false };
    }
    if (st.isSymbolicLink()) {
      fail("path_ancestor_symlink", `${label}: ancestor is a symlink: ${current}`);
    }
    const isFinal = i === parts.length - 1;
    if (!isFinal && !st.isDirectory()) {
      fail("path_ancestor_unsafe", `${label}: intermediate is not a regular directory: ${current}`);
    }
    nearestExisting = current;
  }
  return { nearestExisting: resolved, targetExists: true };
}

/**
 * Ensure `directory` exists as a real non-symlink directory (R3.6).
 * Retained parent-directory FD walk from filesystem root:
 * each component is lstat/open/mkdir'd ONLY via /proc/self/fd/<parentFd>/<basename>.
 * Previous layer FD released only after next layer FD is open. Any symlink refused.
 * Never falls back to absolute-path mkdir after a check.
 * Linux /proc/self/fd boundary; non-Linux or missing proc fail-closed.
 */
export function ensureDirectoryChainNoSymlink(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const held = walkRetainParentDirectoryFd(resolved, { create: true, label });
  try {
    const st = fs.fstatSync(held.fd);
    if (!st.isDirectory() || st.dev !== held.dev || st.ino !== held.ino) {
      fail("directory_identity_mismatch", `${label}: retained fd identity drifted: ${resolved}`);
    }
    return resolved;
  } finally {
    try { fs.closeSync(held.fd); } catch { /* ignore */ }
  }
}

/** Build /proc/self/fd/<parentFd>/<basename> after validating basename is a single component. */
export function procFdChildPath(parentFd: number, basename: string): string {
  requireLinuxProcFdAvailable();
  if (
    typeof parentFd !== "number"
    || !Number.isInteger(parentFd)
    || parentFd < 0
    || typeof basename !== "string"
    || basename.length === 0
    || basename === "."
    || basename === ".."
    || basename.includes("/")
    || basename.includes("\\")
    || path.basename(basename) !== basename
  ) {
    fail("path_basename_invalid", `invalid basename for procfd walk: ${String(basename)}`);
  }
  return `/proc/self/fd/${parentFd}/${basename}`;
}

/**
 * R3.6 retained parent-directory FD walk from filesystem root.
 * Opens `/` first, then for each path component:
 *   lstat/open/mkdir only via /proc/self/fd/<parentFd>/<basename>
 * Previous FD closed only after next FD is successfully opened.
 * Caller owns the returned FD and must close it.
 * Exported for low-level R3.6 unit tests (not an operator production entry).
 */
export function walkRetainParentDirectoryFd(
  directory: string,
  options: { create: boolean; label: string },
): D3V2RetainedDirFd {
  requireLinuxProcFdAvailable();
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let currentPath = parsed.root;
  let parentFd = openRootDirectoryFd(options.label);
  try {
    for (const part of parts) {
      const childLexical = path.join(currentPath, part);
      const childProc = procFdChildPath(parentFd, part);
      let st = lstatMaybe(childProc);
      if (!st) {
        if (!options.create) {
          fail("directory_missing", `${options.label}: missing component (create=false): ${childLexical}`);
        }
        try {
          fs.mkdirSync(childProc, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            fail(
              "directory_create_failed",
              `${options.label}: procfd mkdir failed at ${childLexical}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        try {
          fs.fsyncSync(parentFd);
        } catch { /* best-effort parent fsync after mkdir */ }
        st = lstatMaybe(childProc);
        if (!st) {
          fail("directory_create_failed", `${options.label}: post-mkdir lstat missing at ${childLexical}`);
        }
      }
      if (st!.isSymbolicLink()) {
        fail("path_ancestor_symlink", `${options.label}: ancestor is a symlink: ${childLexical}`);
      }
      if (!st!.isDirectory()) {
        fail("path_ancestor_unsafe", `${options.label}: intermediate is not a regular directory: ${childLexical}`);
      }
      let childFd: number;
      try {
        childFd = fs.openSync(childProc, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      } catch (error) {
        fail(
          "directory_open_failed",
          `${options.label}: procfd open failed at ${childLexical}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        const opened = fs.fstatSync(childFd!);
        if (!opened.isDirectory() || opened.dev !== st!.dev || opened.ino !== st!.ino) {
          fail("directory_identity_mismatch", `${options.label}: post-open identity differs at ${childLexical}`);
        }
      } catch (error) {
        try { fs.closeSync(childFd!); } catch { /* ignore */ }
        throw error;
      }
      // Release previous layer only after next layer FD is open and verified.
      try { fs.closeSync(parentFd); } catch { /* ignore */ }
      parentFd = childFd!;
      currentPath = childLexical;
    }
    const finalStat = fs.fstatSync(parentFd);
    if (!finalStat.isDirectory()) {
      fail("directory_unsafe", `${options.label}: final path is not a directory: ${resolved}`);
    }
    const held: D3V2RetainedDirFd = {
      fd: parentFd,
      path: resolved,
      dev: finalStat.dev,
      ino: finalStat.ino,
    };
    // Transfer ownership to caller.
    parentFd = -1;
    return held;
  } finally {
    if (parentFd >= 0) {
      try { fs.closeSync(parentFd); } catch { /* ignore */ }
    }
  }
}

function openRootDirectoryFd(label: string): number {
  requireLinuxProcFdAvailable();
  const root = path.parse(path.resolve("/")).root;
  const named = fs.lstatSync(root);
  if (named.isSymbolicLink() || !named.isDirectory()) {
    fail("path_ancestor_symlink", `${label}: filesystem root is not a regular directory`);
  }
  const fd = fs.openSync(root, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino) {
      fail("directory_identity_mismatch", `${label}: root open identity differs`);
    }
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    throw error;
  }
}

function requireLinuxProcFdAvailable(): void {
  if (process.platform !== "linux") {
    fail(
      "procfd_unavailable",
      `R3.6 retained parent-fd walk requires Linux /proc/self/fd (platform=${process.platform}); fail-closed`,
    );
  }
  try {
    const st = fs.lstatSync("/proc/self/fd");
    if (!st.isDirectory()) {
      fail("procfd_unavailable", "R3.6 retained parent-fd walk requires /proc/self/fd directory; fail-closed");
    }
  } catch (error) {
    fail(
      "procfd_unavailable",
      `R3.6 retained parent-fd walk requires accessible /proc/self/fd; fail-closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** One-shot guard for the closed-set R3.6 test hook (module-local). */
let r36TestAncestorSwapHookConsumed = false;

/**
 * Closed-set one-shot sandbox-only ancestor swap for R3.6 deterministic testing.
 * Never on production default path. Requires env token + target===sandbox.
 * Swaps an existing sandbox directory to a symlink pointing at a hard production root
 * AFTER preflight and BEFORE mkdir/open/rename — so retained-FD writes must not land
 * in production (they either fail-closed on re-walk or stay on the original inode).
 * Exported only for low-level unit tests that need the same closed gate.
 */
export function applyR36TestAncestorSwapAfterPreflight(args: {
  target: "sandbox" | "production";
  hook: D3V2R36TestAncestorSwapHook;
}): { swappedFrom: string; backupPath: string; symlinkPath: string; hardRoot: string } {
  if (args.target !== "sandbox") {
    fail("test_hook_production_forbidden", "R3.6 ancestor-swap test hook refuses target=production");
  }
  const hook = args.hook;
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
    fail("test_hook_invalid", "R3.6 ancestor-swap test hook must be a closed object");
  }
  const keys = Object.keys(hook).sort(compareCodeUnits);
  const expectedKeys = ["hardRootSymlinkTarget", "kind", "sandboxAncestorToSwap", "testToken"];
  if (canonicalizeJcs(keys) !== canonicalizeJcs(expectedKeys)) {
    fail("test_hook_invalid", "R3.6 ancestor-swap test hook keys must be exact closed set");
  }
  if (hook.kind !== D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND) {
    fail("test_hook_invalid", `R3.6 ancestor-swap test hook kind must be ${D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND}`);
  }
  if (typeof hook.testToken !== "string" || hook.testToken.length < 16) {
    fail("test_hook_invalid", "R3.6 ancestor-swap test hook testToken must be a non-trivial string");
  }
  const envToken = process.env[D3_V2_R36_TEST_TOKEN_ENV];
  if (typeof envToken !== "string" || envToken.length === 0 || envToken !== hook.testToken) {
    fail("test_hook_token_mismatch", `R3.6 ancestor-swap test hook requires env ${D3_V2_R36_TEST_TOKEN_ENV} exact match`);
  }
  if (r36TestAncestorSwapHookConsumed) {
    fail("test_hook_one_shot", "R3.6 ancestor-swap test hook is one-shot and already consumed in this process");
  }
  const sandboxAncestor = path.resolve(hook.sandboxAncestorToSwap);
  const hardRoot = path.resolve(hook.hardRootSymlinkTarget);
  // Sandbox ancestor must live under system temp and must NOT be a hard production root.
  const tmpRoot = path.resolve(os.tmpdir());
  if (!(sandboxAncestor === tmpRoot || sandboxAncestor.startsWith(tmpRoot + path.sep))) {
    fail("test_hook_invalid", "R3.6 ancestor-swap sandboxAncestorToSwap must be under system temp");
  }
  if (isHardProductionPath(sandboxAncestor)) {
    fail("test_hook_invalid", "R3.6 ancestor-swap sandboxAncestorToSwap must not be a hard production path");
  }
  // hardRoot must be an exact listed hard production root (attack target for the simulation).
  const hardRoots = listHardProductionRoots().map((r) => path.resolve(r));
  if (!hardRoots.some((r) => r === hardRoot)) {
    fail("test_hook_invalid", "R3.6 ancestor-swap hardRootSymlinkTarget must be an exact listed hard production root");
  }
  // Ancestor must currently be a real non-symlink directory (preflight already passed).
  let st: fs.Stats;
  try {
    st = fs.lstatSync(sandboxAncestor);
  } catch (error) {
    fail("test_hook_invalid", `R3.6 ancestor-swap sandbox ancestor missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (st!.isSymbolicLink() || !st!.isDirectory()) {
    fail("test_hook_invalid", "R3.6 ancestor-swap sandbox ancestor must be a real non-symlink directory");
  }
  // Do not touch hard root contents — only create a symlink pointing at it.
  const backupPath = `${sandboxAncestor}.r36-swap-backup-${process.pid}`;
  if (fs.existsSync(backupPath)) {
    fail("test_hook_invalid", "R3.6 ancestor-swap backup path already exists");
  }
  r36TestAncestorSwapHookConsumed = true;
  fs.renameSync(sandboxAncestor, backupPath);
  try {
    fs.symlinkSync(hardRoot, sandboxAncestor);
  } catch (error) {
    // Best-effort restore on failure to create the attack symlink.
    try { fs.renameSync(backupPath, sandboxAncestor); } catch { /* ignore */ }
    fail("test_hook_failed", `R3.6 ancestor-swap symlink create failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    swappedFrom: sandboxAncestor,
    backupPath,
    symlinkPath: sandboxAncestor,
    hardRoot,
  };
}

/** Test-only: reset the one-shot consumed flag between isolated smoke cases. */
export function __resetR36TestAncestorSwapHookForTests(): void {
  r36TestAncestorSwapHookConsumed = false;
}

/**
 * Sandbox: nearest-existing realpath (and projected full realpath) must not land
 * under any hard production root. Refuses symlink ancestors first.
 */
export function assertSandboxRealpathOutsideHardProduction(input: string, label: string): void {
  const resolved = path.resolve(input);
  // Refuse symlink anywhere on existing chain first.
  assertExistingAncestorsNoSymlink(resolved, label);
  let probe = resolved;
  while (true) {
    const st = lstatMaybe(probe);
    if (st) {
      if (st.isSymbolicLink()) {
        fail("path_ancestor_symlink", `${label}: realpath probe hit symlink: ${probe}`);
      }
      let real: string;
      try {
        real = fs.realpathSync.native(probe);
      } catch (error) {
        fail("path_realpath_failed", `${label}: realpath failed at ${probe}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (isHardProductionPath(real)) {
        fail(
          "rollback_production_forbidden",
          `sandbox ${label} realpath lands on hard production root (${real})`,
        );
      }
      if (probe !== resolved) {
        const projected = path.resolve(real, path.relative(probe, resolved));
        if (isHardProductionPath(projected)) {
          fail(
            "rollback_production_forbidden",
            `sandbox ${label} projected realpath lands on hard production root (${projected})`,
          );
        }
      }
      return;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}

/** Preflight all operator mutation path chains before any mkdir/settings/intents write. */
function preflightRollbackPathChainsNoSymlink(args: {
  settingsPath: string;
  stateRoot: string;
  sessionFilePath: string;
  quarantineTarget: string;
  activationRollbackTarget: string;
}): void {
  // settings parent chain (especially blocks /tmp/x → ~/.pi/agent)
  assertExistingAncestorsNoSymlink(path.dirname(args.settingsPath), "settings parent");
  const settingsStat = lstatMaybe(args.settingsPath);
  if (settingsStat?.isSymbolicLink()) {
    fail("path_ancestor_symlink", `settingsPath is a symlink: ${args.settingsPath}`);
  }
  // stateRoot / activation.rollback_target chain
  assertExistingAncestorsNoSymlink(args.stateRoot, "stateRoot");
  assertExistingAncestorsNoSymlink(args.activationRollbackTarget, "activation.rollback_target");
  // session / quarantine parent chains (activation targets)
  assertExistingAncestorsNoSymlink(path.dirname(args.sessionFilePath), "session parent");
  assertExistingAncestorsNoSymlink(path.dirname(args.quarantineTarget), "quarantine parent");
  const sessionStat = lstatMaybe(args.sessionFilePath);
  if (sessionStat?.isSymbolicLink()) {
    fail("path_ancestor_symlink", `sessionFilePath is a symlink: ${args.sessionFilePath}`);
  }
  const quarantineStat = lstatMaybe(args.quarantineTarget);
  if (quarantineStat?.isSymbolicLink()) {
    fail("path_ancestor_symlink", `quarantineTarget is a symlink: ${args.quarantineTarget}`);
  }
}

function verifyExactDirectoryOpen(resolved: string, label: string): void {
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("directory_unsafe", `${label} must be a regular non-symlink directory`);
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      fail("directory_identity_mismatch", `${label} open identity differs from lstat`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function exactDirectory(input: string, label: string): void {
  const resolved = path.resolve(input);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) {
    fail("directory_unsafe", `${label} must be an exact directory`);
  }
}

function lstatMaybe(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("path_probe_failed", `lstat failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("shape_invalid", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) fail("hash_invalid", `${label} must be lowercase SHA-256`);
}
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function fail(code: string, message: string): never {
  throw new D3V2RollbackError(code, message);
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export type { D3V2BoundActivationObject };
