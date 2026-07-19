/// <reference types="node" />
/**
 * ADR0040 D3-v2 session_start single-consumer adapter (R3.8).
 * Reads only a published D3 control root via the production closure reader.
 * Never scans L1, never runs projector/compiler/LLM, never repairs.
 * Default-off with empty selector; selected sessions are v2-only and require a
 * bound activation object (path+hash) when enabled=true.
 * R3.6 closes the check-after ancestor-swap window via Linux retained parent-fd
 * /proc/self/fd walks on all rollback create/write/quarantine paths.
 * R3.7: session_id is a single safe filename component; path helpers contain under
 * stateRoot; rehearse writes are procfd-anchored (no absolute post-check write).
 * R3.8: live selector normalization reuses the safe session-id rule and fail-closes
 * unsafe selectors to disabled/empty (no throw); select refuses unsafe current
 * session ids; rehearse forces settings/session/quarantine under stateRoot;
 * generic path components allow ≤255 (NAME_MAX) while session_id remains ≤128.
 * R3.9: normalizeLiveSelectorSessionIds / selectD3V2SessionStartSession apply
 * isSafeSessionIdComponent to the original raw value only — no trim, no identity
 * rewrite. Empty, pure-whitespace, leading/trailing-whitespace, null, non-string,
 * and any other unsafe entry fail-closed (disabled/empty/cleared pins or unselected).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { readPublishedD3PubSelection } from "./proposition-lifecycle-freshness-production-core";
import {
  buildTypescriptStaticDependencyGraph,
  type TypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";
import {
  buildD3V2SessionStartActivationObject as buildActivationObjectImpl,
  loadD3V2SessionStartBoundActivationObject,
  resolveD3V2SessionStartActivationRoot,
  captureSessionFileBinding,
  assertBoundActivationMatchesRuntime,
  computeD3V2ActivationObjectHash,
  normalizeSettingsMutationClosed,
  validateBoundActivationObjectClosed,
  activationRootHasNoBoundObject,
  assertSafeSessionIdComponent,
  assertSafeActivationNonceComponent,
  assertSafeSinglePathComponent,
  isSafeSessionIdComponent,
  joinUnderRootContained,
  assertResolvedPathContainedUnderRoot,
  D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA,
  D3_V2_SESSION_START_ACTIVATION_TEMPLATE_SCHEMA,
  D3_V2_SESSION_START_SETTINGS_MUTATION_KEYS,
  D3_V2_SESSION_START_DEFAULT_ACTIVATION_ROOT,
  D3_V2_SESSION_ID_MAX_LENGTH,
  D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH,
  D3_V2_SAFE_PATH_COMPONENT_RE,
  type D3V2BoundActivationObject,
  type D3V2ActivationD3Identities,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-activation";
import {
  composeD3V2ExactFence,
  D3_V2_SESSION_START_SOURCE_MARKER,
  sanitizeManagedRuleFences,
  stripSelectedActivationRuleFence,
  classifyManagedSuffix,
  parseAllAbrainRuleFences,
  type D3V2OwnFenceExpectation,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-fence";
import {
  buildD3V2SessionStartRollbackReceipt,
  buildD3V2SessionStartRollbackBarrier,
  buildD3V2SessionStartRollbackAuthorization,
  buildD3V2SessionStartProductionTargetAuthorization,
  executeD3V2SessionStartRollbackOperator,
  rehearseD3V2SessionStartRollback,
  readD3V2SessionStartHaltOrTaint,
  readD3V2SessionStartPendingRollbackIntent,
  haltMarkerPath,
  sessionTaintPath,
  rollbackIntentDir,
  rollbackReceiptDir,
  rollbackFaceArtifactPath,
  rollbackBarrierPath,
  haltFailurePath,
  listD3V2SessionStartHardProductionRoots,
  assertExistingAncestorsNoSymlink,
  ensureDirectoryChainNoSymlink,
  assertSandboxRealpathOutsideHardProduction,
  walkRetainParentDirectoryFd,
  procFdChildPath,
  applyR36TestAncestorSwapAfterPreflight,
  __resetR36TestAncestorSwapHookForTests,
  D3_V2_SESSION_START_ROLLBACK_RECEIPT_SCHEMA,
  D3_V2_SESSION_START_ROLLBACK_BARRIER_SCHEMA,
  D3_V2_SESSION_START_ROLLBACK_AUTHORIZATION_SCHEMA,
  D3_V2_SESSION_START_PRODUCTION_TARGET_AUTHORIZATION_SCHEMA,
  D3_V2_SESSION_START_QUARANTINE_RENAME_RESIDUAL,
  D3_V2_SESSION_START_PATH_SAFETY_PLATFORM_BOUNDARY,
  D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND,
  D3_V2_R36_TEST_TOKEN_ENV,
  D3_V2_ROLLBACK_FACES,
  type D3V2R36TestAncestorSwapHook,
  type D3V2RetainedDirFd,
} from "./proposition-lifecycle-freshness-d3-v2-session-start-rollback";

export {
  buildD3V2SessionStartRollbackReceipt,
  buildD3V2SessionStartRollbackBarrier,
  buildD3V2SessionStartRollbackAuthorization,
  buildD3V2SessionStartProductionTargetAuthorization,
  executeD3V2SessionStartRollbackOperator,
  rehearseD3V2SessionStartRollback,
  readD3V2SessionStartHaltOrTaint,
  readD3V2SessionStartPendingRollbackIntent,
  haltMarkerPath,
  sessionTaintPath,
  rollbackIntentDir,
  rollbackReceiptDir,
  rollbackFaceArtifactPath,
  rollbackBarrierPath,
  haltFailurePath,
  listD3V2SessionStartHardProductionRoots,
  assertExistingAncestorsNoSymlink,
  ensureDirectoryChainNoSymlink,
  assertSandboxRealpathOutsideHardProduction,
  walkRetainParentDirectoryFd,
  procFdChildPath,
  applyR36TestAncestorSwapAfterPreflight,
  __resetR36TestAncestorSwapHookForTests,
  loadD3V2SessionStartBoundActivationObject,
  resolveD3V2SessionStartActivationRoot,
  captureSessionFileBinding,
  assertBoundActivationMatchesRuntime,
  computeD3V2ActivationObjectHash,
  normalizeSettingsMutationClosed,
  validateBoundActivationObjectClosed,
  activationRootHasNoBoundObject,
  assertSafeSessionIdComponent,
  assertSafeActivationNonceComponent,
  assertSafeSinglePathComponent,
  isSafeSessionIdComponent,
  joinUnderRootContained,
  assertResolvedPathContainedUnderRoot,
  composeD3V2ExactFence,
  sanitizeManagedRuleFences,
  stripSelectedActivationRuleFence,
  classifyManagedSuffix,
  parseAllAbrainRuleFences,
  D3_V2_SESSION_START_SOURCE_MARKER,
  D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA,
  D3_V2_SESSION_START_ACTIVATION_TEMPLATE_SCHEMA,
  D3_V2_SESSION_START_SETTINGS_MUTATION_KEYS,
  D3_V2_SESSION_START_DEFAULT_ACTIVATION_ROOT,
  D3_V2_SESSION_ID_MAX_LENGTH,
  D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH,
  D3_V2_SAFE_PATH_COMPONENT_RE,
  D3_V2_SESSION_START_ROLLBACK_RECEIPT_SCHEMA,
  D3_V2_SESSION_START_ROLLBACK_BARRIER_SCHEMA,
  D3_V2_SESSION_START_ROLLBACK_AUTHORIZATION_SCHEMA,
  D3_V2_SESSION_START_PRODUCTION_TARGET_AUTHORIZATION_SCHEMA,
  D3_V2_SESSION_START_QUARANTINE_RENAME_RESIDUAL,
  D3_V2_SESSION_START_PATH_SAFETY_PLATFORM_BOUNDARY,
  D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND,
  D3_V2_R36_TEST_TOKEN_ENV,
  D3_V2_ROLLBACK_FACES,
};
export type { D3V2R36TestAncestorSwapHook, D3V2RetainedDirFd };
export type { D3V2BoundActivationObject, D3V2ActivationD3Identities, D3V2OwnFenceExpectation };

export const D3_V2_SESSION_START_CONTROL_ROOT_RELATIVE =
  ".state/sediment/proposition-lifecycle-freshness/v2" as const;
export const D3_V2_SESSION_START_ADAPTER_ROOT =
  "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts" as const;
export const D3_V2_SESSION_START_ACTIVATION_MODULE =
  "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-activation.ts" as const;
export const D3_V2_SESSION_START_FENCE_MODULE =
  "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-fence.ts" as const;
export const D3_V2_SESSION_START_ROLLBACK_MODULE =
  "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-rollback.ts" as const;
export const D3_V2_SESSION_START_ADAPTER_MANIFEST_SCHEMA =
  "adr0040-d3-v2-session-start-adapter-manifest/v1" as const;
export const D3_V2_SESSION_START_FORENSIC_SCHEMA =
  "adr0040-d3-v2-session-start-forensic-audit/v1" as const;
export const D3_V2_SESSION_START_MAX_ITEMS = 64 as const;
export const D3_V2_SESSION_START_MAX_READ_BYTES_LIMIT = 262_144 as const;
export const D3_V2_SESSION_START_DEFAULT_MAX_READ_BYTES = 65_536 as const;
export const D3_V2_SESSION_START_CONTROL_MODULE =
  "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.ts" as const;
export const D3_V2_SESSION_START_RUNTIME_AUDIT_MODULE =
  "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-runtime-audit.ts" as const;
export const D3_V2_SESSION_START_RULE_INJECTOR_INDEX =
  "extensions/abrain/rule-injector/index.ts" as const;
export const D3_V2_SESSION_START_ABRAIN_HOST_ENTRY =
  "extensions/abrain/index.ts" as const;
export const D3_V2_SESSION_START_PI_INTERNALS =
  "extensions/_shared/pi-internals.ts" as const;
export const D3_V2_SESSION_START_CONTEXT_PACKER =
  "extensions/sediment/context-packer.ts" as const;
export const D3_V2_SESSION_START_LLM_EXTRACTOR =
  "extensions/sediment/llm-extractor.ts" as const;
export const D3_V2_SESSION_START_SETTINGS_SCHEMA =
  "pi-astack-settings.schema.json" as const;
export const D3_V2_SESSION_START_PACKAGE_JSON = "package.json" as const;
export const D3_V2_SESSION_START_PACKAGE_LOCK = "package-lock.json" as const;

/** Critical exact-byte surfaces that the adapter manifest must cover (fail-closed). */
export const D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS = Object.freeze([
  D3_V2_SESSION_START_ADAPTER_ROOT,
  D3_V2_SESSION_START_ACTIVATION_MODULE,
  D3_V2_SESSION_START_FENCE_MODULE,
  D3_V2_SESSION_START_ROLLBACK_MODULE,
  D3_V2_SESSION_START_CONTROL_MODULE,
  D3_V2_SESSION_START_RUNTIME_AUDIT_MODULE,
  D3_V2_SESSION_START_RULE_INJECTOR_INDEX,
  D3_V2_SESSION_START_ABRAIN_HOST_ENTRY,
  D3_V2_SESSION_START_PI_INTERNALS,
  D3_V2_SESSION_START_CONTEXT_PACKER,
  D3_V2_SESSION_START_LLM_EXTRACTOR,
  D3_V2_SESSION_START_SETTINGS_SCHEMA,
  D3_V2_SESSION_START_PACKAGE_JSON,
  D3_V2_SESSION_START_PACKAGE_LOCK,
] as const);

export const D3_V2_SESSION_START_ADAPTER_ROOTS = Object.freeze([
  D3_V2_SESSION_START_ADAPTER_ROOT,
  D3_V2_SESSION_START_ACTIVATION_MODULE,
  D3_V2_SESSION_START_FENCE_MODULE,
  D3_V2_SESSION_START_ROLLBACK_MODULE,
  D3_V2_SESSION_START_CONTROL_MODULE,
  D3_V2_SESSION_START_RUNTIME_AUDIT_MODULE,
  D3_V2_SESSION_START_CONTEXT_PACKER,
  D3_V2_SESSION_START_LLM_EXTRACTOR,
] as const);

/** Explicit inventory files not necessarily reachable via TS import graph. */
export const D3_V2_SESSION_START_ADAPTER_EXPLICIT_FILES = Object.freeze([
  D3_V2_SESSION_START_RULE_INJECTOR_INDEX,
  D3_V2_SESSION_START_ABRAIN_HOST_ENTRY,
  D3_V2_SESSION_START_PI_INTERNALS,
  D3_V2_SESSION_START_SETTINGS_SCHEMA,
  D3_V2_SESSION_START_PACKAGE_JSON,
  D3_V2_SESSION_START_PACKAGE_LOCK,
] as const);

const HASH = /^[0-9a-f]{64}$/;

export interface D3V2SessionStartInjectionSettings {
  enabled: boolean;
  selector: { session_ids: string[] };
  expectedSelectionHash: string | null;
  expectedHeadHash: string | null;
  expectedProofHash: string | null;
  expectedStableBundleHash: string | null;
  expectedIntentHash: string | null;
  adapterManifestHash: string | null;
  activationObjectPath: string | null;
  activationObjectHash: string | null;
  maxReadBytes: number;
}

export interface D3V2SessionStartSelection {
  selected: boolean;
  reason: "disabled" | "ephemeral_session" | "unselected_session" | "selected";
  sessionId?: string;
}

export type D3V2SessionStartRuntimeReadResult =
  | {
    ok: true;
    reason: "selected_valid";
    sessionId: string;
    selectionHash: string;
    headHash: string;
    proofHash: string;
    intentHash: string;
    stableBundleHash: string;
    p2aBundleHash: string;
    generation: number;
    selectionSeq: number;
    adapterManifestHash: string;
    activationObjectHash: string;
    activationNonce: string;
    authorizationCoordinateHash: string;
    sourcePath: string;
    viewMd: string;
    viewBytes: number;
    itemCount: number;
    publicationAgeMs: number | null;
    publicationAgeDiagnosticOnly: true;
    surfaceCombinationHash: string;
  }
  | {
    ok: false;
    reason: string;
    sessionId?: string;
    error?: string;
    publicationAgeMs?: number | null;
  };

export class D3V2SessionStartError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "D3V2SessionStartError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

/**
 * R3.9: normalize live selector session_ids with the same safe session-id rule
 * used by builders/validators. Never throws. Never trims or rewrites identity.
 * Any non-string, empty, pure-whitespace, leading/trailing-whitespace, null, or
 * otherwise unsafe entry marks the whole selector unsafe so resolve can
 * fail-closed to disabled/empty/cleared pins. Empty entries are NOT ignored.
 */
function normalizeLiveSelectorSessionIds(raw: unknown): { session_ids: string[]; unsafe: boolean } {
  if (raw == null) return { session_ids: [], unsafe: false };
  if (!Array.isArray(raw)) return { session_ids: [], unsafe: true };
  const session_ids: string[] = [];
  const seen = new Set<string>();
  let unsafe = false;
  for (const item of raw) {
    // Direct predicate on the original item only — no trim/rewrite.
    if (!isSafeSessionIdComponent(item)) {
      unsafe = true;
      continue;
    }
    if (!seen.has(item)) {
      seen.add(item);
      session_ids.push(item);
    }
  }
  return { session_ids, unsafe };
}

export function resolveD3V2SessionStartInjectionSettings(value: unknown): D3V2SessionStartInjectionSettings {
  const cfg = recordOptional(value) ?? {};
  const selector = recordOptional(cfg.selector) ?? {};
  const normalized = normalizeLiveSelectorSessionIds(selector.session_ids);
  const requestedMax = typeof cfg.maxReadBytes === "number" && Number.isFinite(cfg.maxReadBytes)
    ? Math.floor(cfg.maxReadBytes)
    : D3_V2_SESSION_START_DEFAULT_MAX_READ_BYTES;
  const maxReadBytes = Math.max(1_024, Math.min(D3_V2_SESSION_START_MAX_READ_BYTES_LIMIT, requestedMax));

  // R3.9 fail-closed: any unsafe selector item (including empty / whitespace /
  // padded entries) disables the consumer, empties the selector, and clears
  // activation pins immediately. Never throws (including no missing-pin throw).
  if (normalized.unsafe) {
    return {
      enabled: false,
      selector: { session_ids: [] },
      expectedSelectionHash: hashOrNull(cfg.expectedSelectionHash),
      expectedHeadHash: hashOrNull(cfg.expectedHeadHash),
      expectedProofHash: hashOrNull(cfg.expectedProofHash),
      expectedStableBundleHash: hashOrNull(cfg.expectedStableBundleHash),
      expectedIntentHash: hashOrNull(cfg.expectedIntentHash),
      adapterManifestHash: hashOrNull(cfg.adapterManifestHash),
      activationObjectPath: null,
      activationObjectHash: null,
      maxReadBytes,
    };
  }

  const sessionIds = normalized.session_ids;
  const enabled = cfg.enabled === true;
  const activationObjectPath = typeof cfg.activationObjectPath === "string" && cfg.activationObjectPath.trim()
    ? cfg.activationObjectPath.trim()
    : null;
  const activationObjectHash = hashOrNull(cfg.activationObjectHash);
  if (enabled) {
    if (!activationObjectPath || !path.isAbsolute(activationObjectPath)) {
      fail("settings_activation_required", "enabled=true requires absolute activationObjectPath");
    }
    if (!activationObjectHash) {
      fail("settings_activation_required", "enabled=true requires activationObjectHash");
    }
  }
  return {
    enabled,
    selector: { session_ids: sessionIds },
    expectedSelectionHash: hashOrNull(cfg.expectedSelectionHash),
    expectedHeadHash: hashOrNull(cfg.expectedHeadHash),
    expectedProofHash: hashOrNull(cfg.expectedProofHash),
    expectedStableBundleHash: hashOrNull(cfg.expectedStableBundleHash),
    expectedIntentHash: hashOrNull(cfg.expectedIntentHash),
    adapterManifestHash: hashOrNull(cfg.adapterManifestHash),
    activationObjectPath,
    activationObjectHash,
    maxReadBytes,
  };
}

export function selectD3V2SessionStartSession(args: {
  settings: D3V2SessionStartInjectionSettings;
  sessionManager?: unknown;
}): D3V2SessionStartSelection {
  if (!args.settings.enabled) return { selected: false, reason: "disabled" };
  const manager = args.sessionManager as { getSessionId?(): unknown; getSessionFile?(): unknown } | undefined;
  if (!manager || typeof manager.getSessionId !== "function" || typeof manager.getSessionFile !== "function") {
    return { selected: false, reason: "ephemeral_session" };
  }
  let sessionId: string;
  try {
    const rawId = manager.getSessionId();
    // R3.9: safety-check the raw getSessionId value only — no trim, no identity rewrite.
    // Empty / pure whitespace / leading-trailing whitespace / any unsafe form → unselected
    // (no D3 read, no inject). Safe IDs keep their original form for selector equality.
    if (!isSafeSessionIdComponent(rawId)) {
      return {
        selected: false,
        reason: "unselected_session",
        ...(typeof rawId === "string" ? { sessionId: rawId } : {}),
      };
    }
    sessionId = rawId;
    const rawFile = manager.getSessionFile();
    if (typeof rawFile !== "string" || !rawFile.trim()) {
      return { selected: false, reason: "ephemeral_session", sessionId };
    }
    const sessionFile = path.resolve(rawFile);
    const stat = fs.lstatSync(sessionFile);
    if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(sessionFile) !== sessionFile) {
      return { selected: false, reason: "ephemeral_session", sessionId };
    }
  } catch {
    return { selected: false, reason: "ephemeral_session" };
  }
  if (!args.settings.selector.session_ids.includes(sessionId)) {
    return { selected: false, reason: "unselected_session", sessionId };
  }
  return { selected: true, reason: "selected", sessionId };
}

export function buildD3V2SessionStartAdapterManifest(options: {
  repoRoot: string;
  roots?: readonly string[];
  explicitFiles?: readonly string[];
}): {
  schema_version: typeof D3_V2_SESSION_START_ADAPTER_MANIFEST_SCHEMA;
  adapter_root: typeof D3_V2_SESSION_START_ADAPTER_ROOT;
  graph: TypescriptStaticDependencyGraph;
  critical_required_paths: readonly string[];
  manifest_hash: string;
} {
  const graph = buildTypescriptStaticDependencyGraph({
    repoRoot: options.repoRoot,
    roots: options.roots ?? D3_V2_SESSION_START_ADAPTER_ROOTS,
    explicitFiles: options.explicitFiles ?? D3_V2_SESSION_START_ADAPTER_EXPLICIT_FILES,
  });
  const fileSet = new Set(graph.files.map((row) => row.path));
  for (const required of D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS) {
    if (!fileSet.has(required)) {
      fail("adapter_manifest_incomplete", `adapter manifest missing critical surface ${required}`);
    }
  }
  // D3-critical guard: index must be present (wiring) and control/audit/helpers covered.
  if (!fileSet.has(D3_V2_SESSION_START_RULE_INJECTOR_INDEX)) {
    fail("adapter_manifest_incomplete", "D3-critical guard: rule-injector index missing");
  }
  const base = {
    schema_version: D3_V2_SESSION_START_ADAPTER_MANIFEST_SCHEMA,
    adapter_root: D3_V2_SESSION_START_ADAPTER_ROOT,
    graph,
    critical_required_paths: [...D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS],
  };
  return deepFreeze({ ...base, manifest_hash: jcsSha256Hex(base) });
}

/**
 * Executable host-wiring predicate: the real abrain total entry must import and
 * call the rule-injector activate path. Used by smoke/dossier so wiring is not
 * a hard-coded boolean.
 */
export function evaluateD3V2SessionStartHostWiringPredicate(repoRoot: string): {
  ok: boolean;
  host_entry: typeof D3_V2_SESSION_START_ABRAIN_HOST_ENTRY;
  rule_injector_index: typeof D3_V2_SESSION_START_RULE_INJECTOR_INDEX;
  imports_rule_injector_activate: boolean;
  calls_activate_rule_injector: boolean;
  registers_session_start_surface: boolean;
  evidence: string[];
} {
  const hostRel = D3_V2_SESSION_START_ABRAIN_HOST_ENTRY;
  const injectorRel = D3_V2_SESSION_START_RULE_INJECTOR_INDEX;
  const hostPath = path.join(repoRoot, hostRel);
  const injectorPath = path.join(repoRoot, injectorRel);
  const evidence: string[] = [];
  if (!fs.existsSync(hostPath)) {
    return {
      ok: false,
      host_entry: hostRel,
      rule_injector_index: injectorRel,
      imports_rule_injector_activate: false,
      calls_activate_rule_injector: false,
      registers_session_start_surface: false,
      evidence: [`missing host entry: ${hostRel}`],
    };
  }
  if (!fs.existsSync(injectorPath)) {
    return {
      ok: false,
      host_entry: hostRel,
      rule_injector_index: injectorRel,
      imports_rule_injector_activate: false,
      calls_activate_rule_injector: false,
      registers_session_start_surface: false,
      evidence: [`missing rule-injector index: ${injectorRel}`],
    };
  }
  const hostSrc = fs.readFileSync(hostPath, "utf8");
  const injectorSrc = fs.readFileSync(injectorPath, "utf8");
  const importsActivate =
    /import\s+activateRuleInjector\b/.test(hostSrc)
    && /from\s+["']\.\/rule-injector["']/.test(hostSrc);
  const callsActivate = /activateRuleInjector\s*\(\s*pi\s*\)/.test(hostSrc);
  const registersSessionStart =
    /on\(\s*["']session_start["']/.test(injectorSrc)
    && /on\(\s*["']before_agent_start["']/.test(injectorSrc)
    && /decideD3V2SessionStartControl/.test(injectorSrc);
  if (importsActivate) evidence.push("host imports activateRuleInjector from ./rule-injector");
  if (callsActivate) evidence.push("host calls activateRuleInjector(pi)");
  if (registersSessionStart) evidence.push("rule-injector registers session_start + before_agent_start and calls decideD3V2SessionStartControl");
  return {
    ok: importsActivate && callsActivate && registersSessionStart,
    host_entry: hostRel,
    rule_injector_index: injectorRel,
    imports_rule_injector_activate: importsActivate,
    calls_activate_rule_injector: callsActivate,
    registers_session_start_surface: registersSessionStart,
    evidence,
  };
}

export function validateD3V2SessionStartAdapterManifest(value: unknown): {
  schema_version: typeof D3_V2_SESSION_START_ADAPTER_MANIFEST_SCHEMA;
  adapter_root: typeof D3_V2_SESSION_START_ADAPTER_ROOT;
  graph: TypescriptStaticDependencyGraph;
  critical_required_paths: readonly string[];
  manifest_hash: string;
} {
  const record = asRecord(value, "adapter manifest");
  if (record.schema_version !== D3_V2_SESSION_START_ADAPTER_MANIFEST_SCHEMA) fail("adapter_manifest_invalid", "schema differs");
  if (record.adapter_root !== D3_V2_SESSION_START_ADAPTER_ROOT) fail("adapter_manifest_invalid", "adapter root differs");
  const graph = record.graph as TypescriptStaticDependencyGraph;
  const critical = Array.isArray(record.critical_required_paths)
    ? record.critical_required_paths.map(String)
    : [];
  const fileSet = new Set(graph.files.map((row) => row.path));
  for (const required of D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS) {
    if (!critical.includes(required)) fail("adapter_manifest_invalid", `critical_required_paths missing ${required}`);
    if (!fileSet.has(required)) fail("adapter_manifest_invalid", `graph missing critical surface ${required}`);
  }
  const base = {
    schema_version: D3_V2_SESSION_START_ADAPTER_MANIFEST_SCHEMA,
    adapter_root: D3_V2_SESSION_START_ADAPTER_ROOT,
    graph,
    critical_required_paths: critical,
  };
  if (record.manifest_hash !== jcsSha256Hex(base)) fail("adapter_manifest_invalid", "self-hash differs");
  return deepFreeze({ ...base, manifest_hash: String(record.manifest_hash) });
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
  sessionFile?: {
    path: string;
    dev: number;
    ino: number;
    prefix_bytes: number;
    prefix_sha256: string;
  } | null;
  quarantineTarget?: string | null;
  mode?: "bound" | "template";
}): Readonly<Record<string, unknown>> {
  return buildActivationObjectImpl(args);
}

export function readD3V2SessionStartForRuntime(args: {
  abrainHome: string;
  settings: D3V2SessionStartInjectionSettings;
  sessionManager?: unknown;
  activeProjectId?: string;
  nowMs?: number;
  controlRoot?: string;
  adapterManifestHash?: string;
  activation?: D3V2BoundActivationObject;
  activationRoot?: string;
}): D3V2SessionStartRuntimeReadResult {
  const selection = selectD3V2SessionStartSession({ settings: args.settings, sessionManager: args.sessionManager });
  if (!selection.selected || !selection.sessionId) {
    return { ok: false, reason: selection.reason, ...(selection.sessionId ? { sessionId: selection.sessionId } : {}) };
  }
  const sessionId = selection.sessionId;
  try {
    if (!args.settings.expectedSelectionHash || !args.settings.expectedHeadHash
      || !args.settings.expectedProofHash || !args.settings.expectedStableBundleHash
      || !args.settings.adapterManifestHash) {
      return { ok: false, reason: "expected_binding_missing", sessionId };
    }
    if (!args.settings.activationObjectPath || !args.settings.activationObjectHash) {
      return { ok: false, reason: "activation_binding_missing", sessionId };
    }
    if (typeof args.adapterManifestHash !== "string" || !HASH.test(args.adapterManifestHash)) {
      return { ok: false, reason: "adapter_manifest_hash_required", sessionId, error: "live hook must pass validated current adapterManifestHash" };
    }
    const adapterManifestHash = args.adapterManifestHash;
    if (adapterManifestHash !== args.settings.adapterManifestHash) {
      fail("adapter_manifest_mismatch", "runtime adapter manifest hash is not the configured binding");
    }

    // Load + validate bound activation (settings pin == object hash inside loader).
    const activation = args.activation ?? loadD3V2SessionStartBoundActivationObject({
      activationObjectPath: args.settings.activationObjectPath,
      activationObjectHash: args.settings.activationObjectHash,
      activationRoot: args.activationRoot,
    });
    if (activation.activation_object_hash !== args.settings.activationObjectHash) {
      fail("activation_settings_pin_mismatch", "runtime settings pin does not equal activation object hash");
    }

    // Halt / taint check BEFORE D3 read.
    const halt = readD3V2SessionStartHaltOrTaint({
      rollbackTarget: activation.rollback_target,
      activationNonce: activation.activation_nonce,
      sessionId,
    });
    if (halt.halted) {
      return { ok: false, reason: "halted", sessionId, error: halt.reason ?? "halted" };
    }

    const controlRoot = args.controlRoot
      ? exactDirectory(args.controlRoot, "D3-v2 control root")
      : resolveControlRoot(args.abrainHome);

    const firstPointers = readPointerIdentities(controlRoot);
    const published = readPublishedD3PubSelection(controlRoot);
    const secondPointers = readPointerIdentities(controlRoot);
    assertPointerStable(firstPointers, secondPointers);

    const selectionObj = asRecord(published.selection, "published selection");
    const headObj = asRecord(published.head, "published head");
    const proofObj = asRecord(published.proof, "published proof");
    const artifactClosure = asRecord(published.artifact_closure, "artifact closure");
    const stableBundle = asRecord(artifactClosure.stable, "stable bundle");
    const p2aBundle = asRecord(artifactClosure.p2a, "p2a bundle");

    const selectionHash = String(selectionObj.selection_hash);
    const headHash = String(headObj.head_hash);
    const proofHash = String(proofObj.proof_hash);
    const intentHash = String(selectionObj.intent_hash);
    const stableBundleHash = String(stableBundle.bundle_hash);
    const p2aBundleHash = String(p2aBundle.bundle_hash);
    const generation = Number(selectionObj.generation);
    const selectionSeq = Number(selectionObj.seq);

    if (selectionHash !== args.settings.expectedSelectionHash) fail("unexpected_selection_hash", "selection identity differs");
    if (headHash !== args.settings.expectedHeadHash) fail("unexpected_head_hash", "head identity differs");
    if (proofHash !== args.settings.expectedProofHash) fail("unexpected_proof_hash", "proof identity differs");
    if (stableBundleHash !== args.settings.expectedStableBundleHash) fail("unexpected_stable_bundle_hash", "stable identity differs");
    if (args.settings.expectedIntentHash && intentHash !== args.settings.expectedIntentHash) {
      fail("unexpected_intent_hash", "intent identity differs");
    }
    if (!Number.isSafeInteger(generation) || generation < 0) fail("generation_invalid", "generation invalid");
    if (!Number.isSafeInteger(selectionSeq) || selectionSeq < 0) fail("selection_seq_invalid", "seq invalid");

    const d3Identities: D3V2ActivationD3Identities = {
      selection_hash: selectionHash,
      head_hash: headHash,
      proof_hash: proofHash,
      intent_hash: intentHash,
      stable_bundle_hash: stableBundleHash,
      p2a_bundle_hash: p2aBundleHash,
      generation,
      selection_seq: selectionSeq,
    };

    // settings_mutation expected from live settings (closed-schema norm; never embeds activationObjectHash).
    const settingsMutationExpected = normalizeSettingsMutationClosed({
      enabled: true,
      selector: { session_ids: [...args.settings.selector.session_ids] },
      expectedSelectionHash: args.settings.expectedSelectionHash,
      expectedHeadHash: args.settings.expectedHeadHash,
      expectedProofHash: args.settings.expectedProofHash,
      expectedStableBundleHash: args.settings.expectedStableBundleHash,
      expectedIntentHash: args.settings.expectedIntentHash,
      adapterManifestHash: args.settings.adapterManifestHash,
      activationObjectPath: args.settings.activationObjectPath,
      maxReadBytes: args.settings.maxReadBytes,
    }, { requireExecutableShape: true });
    assertBoundActivationMatchesRuntime({
      activation,
      sessionId,
      adapterManifestHash,
      d3Identities,
      settingsMutationExpected,
      sessionManager: args.sessionManager,
    });
    if (activation.adapter_manifest_hash !== adapterManifestHash) {
      fail("activation_manifest_mismatch", "activation adapter_manifest_hash differs");
    }

    const stableArtifacts = asRecord(stableBundle.artifacts, "stable artifacts") as Record<string, string>;
    const viewJsonRaw = requireString(stableArtifacts["view.json"], "view.json");
    const viewMdRaw = requireString(stableArtifacts["view.md"], "view.md");
    const wrapperManifestRaw = requireString(stableArtifacts["manifest.json"], "manifest.json");
    const parityRaw = requireString(stableArtifacts["parity.json"], "parity.json");
    const wrapperManifest = asRecord(JSON.parse(wrapperManifestRaw), "stable wrapper manifest");
    const render = asRecord(wrapperManifest.render, "stable wrapper render");
    if (render.raw_sha256 !== sha256Hex(viewMdRaw) || Number(render.bytes) !== Buffer.byteLength(viewMdRaw)) {
      fail("render_binding_invalid", "stable wrapper render does not bind view.md bytes");
    }
    const view = asRecord(JSON.parse(viewJsonRaw), "view.json");
    if (!Array.isArray(view.items)) fail("view_items_invalid", "view.json items must be an array");
    const items = view.items;
    if (items.length > D3_V2_SESSION_START_MAX_ITEMS) fail("item_count_overflow", "stable item count exceeds hard limit");

    const validatedItems = validateFullStableViewParity({
      items,
      viewMdRaw,
      parityRaw,
      viewInjectableSha256: typeof view.injectable_payload_sha256 === "string" ? view.injectable_payload_sha256 : null,
      viewInjectableBytes: typeof view.injectable_payload_utf8_bytes === "number" ? view.injectable_payload_utf8_bytes : null,
    });

    const selectedItems: Array<{ statement: string; item_id: string }> = [];
    for (const item of validatedItems) {
      const scope = item.scope;
      if (scope.scope_level === "global") {
        if (scope.project_id !== null || scope.domain !== null) fail("scope_invalid", "global scope carries project/domain");
        selectedItems.push({ statement: item.statement, item_id: item.item_id });
        continue;
      }
      if (scope.scope_level === "project") {
        if (typeof scope.project_id !== "string" || !scope.project_id || scope.domain !== null) fail("scope_invalid", "project scope shape differs");
        if (args.activeProjectId && scope.project_id === args.activeProjectId) {
          selectedItems.push({ statement: item.statement, item_id: item.item_id });
        }
        continue;
      }
      fail("scope_invalid", "stable item scope level differs");
    }

    const viewMd = renderOrderedStatements(selectedItems.map((item) => item.statement));
    const viewBytes = Buffer.byteLength(viewMd, "utf8");
    if (viewBytes > args.settings.maxReadBytes) fail("oversize", "filtered runtime payload exceeds maxReadBytes");

    const publicationAgeMs = diagnosePublicationAgeMs(controlRoot, args.nowMs);
    const surfaceCombinationHash = jcsSha256Hex({
      schema_version: "adr0040-d3-v2-session-start-surface-combination/v1",
      selection_hash: selectionHash,
      head_hash: headHash,
      proof_hash: proofHash,
      intent_hash: intentHash,
      stable_bundle_hash: stableBundleHash,
      p2a_bundle_hash: p2aBundleHash,
      adapter_manifest_hash: adapterManifestHash,
      activation_object_hash: activation.activation_object_hash,
      activation_nonce: activation.activation_nonce,
      view_md_sha256: sha256Hex(viewMd),
      item_count: selectedItems.length,
      generation,
      selection_seq: selectionSeq,
    });

    return {
      ok: true,
      reason: "selected_valid",
      sessionId,
      selectionHash,
      headHash,
      proofHash,
      intentHash,
      stableBundleHash,
      p2aBundleHash,
      generation,
      selectionSeq,
      adapterManifestHash,
      activationObjectHash: activation.activation_object_hash,
      activationNonce: activation.activation_nonce,
      authorizationCoordinateHash: activation.authorization_coordinate_hash,
      sourcePath: path.join(controlRoot, "stable", "v1", "bundles", stableBundleHash, "view.md"),
      viewMd,
      viewBytes,
      itemCount: selectedItems.length,
      publicationAgeMs,
      publicationAgeDiagnosticOnly: true,
      surfaceCombinationHash,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof D3V2SessionStartError ? error.code : "read_failed",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function composeD3V2SessionStartInjection(
  result: Extract<D3V2SessionStartRuntimeReadResult, { ok: true }>,
  sessionId?: string,
): string {
  const expected: D3V2OwnFenceExpectation = {
    session_id: sessionId ?? result.sessionId,
    activation_nonce: result.activationNonce,
    activation_object_hash: result.activationObjectHash,
    selection: result.selectionHash,
    head: result.headHash,
    proof: result.proofHash,
    stable: result.stableBundleHash,
    adapter_manifest: result.adapterManifestHash,
    viewMd: result.viewMd,
  };
  return composeD3V2ExactFence(expected);
}

/** @deprecated Use composeD3V2SessionStartInjection(result) — nonce comes from bound activation. */
export function composeD3V2SessionStartInjectionLegacy(
  nonce: string,
  result: Extract<D3V2SessionStartRuntimeReadResult, { ok: true }>,
): string {
  // Only used by transitional callers; prefer activation-bound compose.
  if (result.activationNonce && result.activationNonce !== nonce) {
    // Still emit with activation nonce if present.
  }
  return composeD3V2SessionStartInjection(result);
}

export function buildD3V2SessionStartForensicAuditRow(args: {
  preOffset: number;
  activationNonce: string;
  causalAnchor: Readonly<Record<string, unknown>>;
  adapterManifestHash: string;
  surfaceCombinationHash: string;
  parentHash?: string | null;
}): Readonly<Record<string, unknown>> {
  assertHash(args.adapterManifestHash, "adapterManifestHash");
  assertHash(args.surfaceCombinationHash, "surfaceCombinationHash");
  if (args.parentHash != null) assertHash(args.parentHash, "parentHash");
  if (!Number.isSafeInteger(args.preOffset) || args.preOffset < 0) fail("forensic_invalid", "pre_offset invalid");
  if (typeof args.activationNonce !== "string" || !args.activationNonce.trim()) fail("forensic_invalid", "activation_nonce required");
  const base = {
    schema_version: D3_V2_SESSION_START_FORENSIC_SCHEMA,
    pre_offset: args.preOffset,
    activation_nonce: args.activationNonce.trim(),
    causal_anchor: deepFreeze({ ...args.causalAnchor }),
    adapter_manifest_hash: args.adapterManifestHash,
    surface_combination_hash: args.surfaceCombinationHash,
    parent_hash: args.parentHash ?? null,
  };
  return deepFreeze({ ...base, self_hash: jcsSha256Hex(base) });
}

function resolveControlRoot(abrainHome: string): string {
  const fromEnv = process.env.PI_ASTACK_D3V2_CONTROL_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return exactDirectory(fromEnv.trim(), "D3-v2 control root (env)");
  }
  return exactDirectory(
    path.join(exactDirectory(expandHome(abrainHome), "abrain home"), ...D3_V2_SESSION_START_CONTROL_ROOT_RELATIVE.split("/")),
    "D3-v2 control root",
  );
}


function validateFullStableViewParity(args: {
  items: unknown[];
  viewMdRaw: string;
  parityRaw: string;
  viewInjectableSha256: string | null;
  viewInjectableBytes: number | null;
}): Array<{ statement: string; item_id: string; scope: Record<string, unknown> }> {
  const validated: Array<{ statement: string; item_id: string; scope: Record<string, unknown> }> = [];
  for (const [index, rawItem] of args.items.entries()) {
    const item = asRecord(rawItem, `view.items[${index}]`);
    const statement = requireString(item.statement, `view.items[${index}].statement`);
    const itemId = requireString(item.item_id, `view.items[${index}].item_id`);
    const statementSha = requireString(item.statement_sha256, `view.items[${index}].statement_sha256`);
    const itemPayloadSha = requireString(item.item_payload_sha256, `view.items[${index}].item_payload_sha256`);
    const scopeSha = requireString(item.scope_sha256, `view.items[${index}].scope_sha256`);
    const scope = asRecord(item.scope, `view.items[${index}].scope`);
    if (statementSha !== sha256Hex(statement)) fail("item_hash_invalid", `statement_sha256 differs at item ${index}`);
    if (scopeSha !== jcsSha256Hex(scope)) fail("item_hash_invalid", `scope_sha256 differs at item ${index}`);
    const itemBase = { ...item };
    delete itemBase.item_payload_sha256;
    if (itemPayloadSha !== jcsSha256Hex(itemBase)) fail("item_hash_invalid", `item_payload_sha256 differs at item ${index}`);
    validated.push({ statement, item_id: itemId, scope });
  }
  const fullViewMd = renderOrderedStatements(validated.map((item) => item.statement));
  if (fullViewMd !== args.viewMdRaw) fail("view_parity_invalid", "view.json statements do not re-render to view.md exact bytes");
  if (args.viewInjectableSha256 && args.viewInjectableSha256 !== sha256Hex(fullViewMd)) {
    fail("view_parity_invalid", "view.injectable_payload_sha256 differs from re-rendered view.md");
  }
  if (args.viewInjectableBytes != null && args.viewInjectableBytes !== Buffer.byteLength(fullViewMd)) {
    fail("view_parity_invalid", "view.injectable_payload_utf8_bytes differs from re-rendered view.md");
  }
  const parity = asRecord(JSON.parse(args.parityRaw), "parity.json");
  const deterministic = asRecord(parity.deterministic_render, "parity.deterministic_render");
  if (Number(deterministic.item_count) !== validated.length) fail("view_parity_invalid", "parity item_count differs");
  if (String(deterministic.view_md_sha256) !== sha256Hex(fullViewMd)) fail("view_parity_invalid", "parity view_md_sha256 differs");
  if (Number(deterministic.view_md_utf8_bytes) !== Buffer.byteLength(fullViewMd)) fail("view_parity_invalid", "parity view_md_utf8_bytes differs");
  if (String(deterministic.items_hash) !== jcsSha256Hex(args.items)) fail("view_parity_invalid", "parity items_hash differs from view.items");
  return validated;
}

function renderOrderedStatements(statements: readonly string[]): string {
  return statements.length === 0 ? "" : `${statements.join("\n\n")}\n`;
}

function diagnosePublicationAgeMs(controlRoot: string, nowMs?: number): number | null {
  try {
    const selectionPointer = path.join(controlRoot, "selections", "current.json");
    const stat = fs.lstatSync(selectionPointer);
    if (!stat.isFile()) return null;
    const publishedAt = Math.max(stat.mtimeMs, stat.ctimeMs);
    if (!Number.isFinite(publishedAt)) return null;
    return Math.max(0, (nowMs ?? Date.now()) - publishedAt);
  } catch {
    return null;
  }
}

interface PointerIdentity {
  hash: string;
  raw: string;
  identity: { dev: number; ino: number; mode: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number };
}

function readPointerIdentities(controlRoot: string): { head: PointerIdentity; selection: PointerIdentity } {
  return {
    head: readOnePointerIdentity(controlRoot, "head"),
    selection: readOnePointerIdentity(controlRoot, "selection"),
  };
}

function readOnePointerIdentity(controlRoot: string, kind: "head" | "selection"): PointerIdentity {
  const file = path.join(controlRoot, kind === "head" ? "heads" : "selections", "current.json");
  const named = fs.lstatSync(file);
  if (named.isSymbolicLink() || !named.isFile()) fail("pointer_unsafe", `${kind} pointer is not a regular file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const rawBuf = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (!before.isFile()
      || before.dev !== named.dev || before.ino !== named.ino
      || rawBuf.length !== before.size
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino
      || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
      fail("pointer_race", `${kind} pointer changed while reading`);
    }
    const raw = rawBuf.toString("utf8");
    const value = JSON.parse(raw) as Record<string, unknown>;
    const field = kind === "head" ? "head_hash" : "selection_hash";
    const hash = String(value[field] ?? "");
    assertHash(hash, `${kind} pointer hash`);
    if (`${canonicalizeJcs(value)}\n` !== raw) fail("pointer_noncanonical", `${kind} pointer is not JCS+LF`);
    return {
      hash,
      raw,
      identity: {
        dev: before.dev,
        ino: before.ino,
        mode: before.mode & 0o7777,
        nlink: before.nlink,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertPointerStable(
  first: { head: PointerIdentity; selection: PointerIdentity },
  second: { head: PointerIdentity; selection: PointerIdentity },
): void {
  for (const kind of ["head", "selection"] as const) {
    const a = first[kind];
    const b = second[kind];
    if (a.hash !== b.hash || a.raw !== b.raw || canonicalizeJcs(a.identity) !== canonicalizeJcs(b.identity)) {
      fail("pointer_aba", `${kind} pointer identity drifted across dual-read`);
    }
  }
}

function expandHome(input: string): string {
  return input.replace(/^~(?=$|\/)/, os.homedir());
}
function exactDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) {
    fail("directory_unsafe", `${label} must be an exact directory`, { resolved });
  }
  return resolved;
}
function hashOrNull(value: unknown): string | null {
  return typeof value === "string" && HASH.test(value) ? value : null;
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) fail("hash_invalid", `${label} must be lowercase SHA-256`);
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") fail("shape_invalid", `${label} must be a string`);
  return value;
}
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("shape_invalid", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function recordOptional(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new D3V2SessionStartError(code, message, detail);
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
