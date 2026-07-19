/// <reference types="node" />
/**
 * ADR0040 D3-v2 session_start S2 production create/bind operator (R4).
 *
 * The production contract is bind-existing-only: it never creates, appends,
 * rewrites, renames, or quarantines a session. Preview is strictly read-only.
 * Execute and continue derive authority only from an exact latest standalone
 * role=user message in the bound persisted session JSONL.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { parseJsonRejectDuplicateKeys } from "./strict-json";
import {
  buildD3V2SessionStartActivationObject,
  validateBoundActivationObjectClosed,
  activationRootHasNoBoundObject,
  normalizeSettingsMutationClosed,
  assertSafeSessionIdComponent,
  ensureDirectoryChainNoSymlink,
  listD3V2SessionStartHardProductionRoots,
  procFdChildPath,
  walkRetainParentDirectoryFd,
  D3_V2_SESSION_START_R4_ACTIVATION_OBJECT_SCHEMA,
  D3_V2_SESSION_START_R4_SETTINGS_BINDING_SCHEMA,
  type D3V2ActivationD3Identities,
  type D3V2BoundActivationObject,
  type D3V2R4SettingsBinding,
  type D3V2SessionStartInjectionSettings,
} from "./proposition-lifecycle-freshness-d3-v2-session-start";
import { acquireRetainedDirectoryOfdLock } from "./retained-directory-ofd-lock";
import {
  createOnlyPendingBasename,
  publishCreateOnlyRetained,
  recoverCreateOnlyPendingRetained,
  readExactRetainedFile,
  readAtRetainedParent,
  type RetainedCreateOnlyCrashPoint,
  type RetainedCreateOnlyKind,
} from "./retained-fd-create-only";
import {
  captureTrustedSessionPrefixBinding,
  validateTrustedSessionUserCoordinate,
  verifyFreshLatestStandaloneUserAuthorization,
  verifyRecordedTrustedSessionCoordinate,
  type TrustedSessionUserCoordinate,
} from "./trusted-session-transcript";
import {
  buildTypescriptStaticDependencyGraph,
  validateTypescriptStaticDependencyGraph,
  type TypescriptStaticDependencyGraph,
} from "./typescript-static-dependency-graph";

export const D3_V2_R4_REVISION = "R4.1" as const;
export const D3_V2_R4_OPERATOR_MANIFEST_SCHEMA = "adr0040-d3-v2-session-start-r4-operator-manifest/v1" as const;
export const D3_V2_R4_AUTHORIZATION_TUPLE_SCHEMA = "adr0040-d3-v2-session-start-r4-authorization-tuple/v1" as const;
export const D3_V2_R4_INTENT_SCHEMA = "adr0040-d3-v2-session-start-r4-create-bind-intent/v1" as const;
export const D3_V2_R4_RECEIPT_SCHEMA = "adr0040-d3-v2-session-start-r4-commit-receipt/v1" as const;
export const D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE = "确认执行当前 ADR0040 D3-v2 session_start R4 S2 bind-existing create/bind。" as const;
export const D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE = "确认继续当前 ADR0040 D3-v2 session_start R4 S2 恢复。" as const;
export const D3_V2_R4_AUTHORIZATION_MAXIMUM_AGE_MS = 2 * 60 * 60 * 1000;
export const D3_V2_R4_NONCOOPERATIVE_WRITER_RESIDUAL = "cooperative_retained_parent_OFD_lock_plus_immediate_preimage_recheck_cannot_exclude_noncooperative_writer_between_final_check_and_rename" as const;
export const D3_V2_R4_SETTINGS_KEY = "propositionLifecycleFreshnessD3V2SessionStartInjection" as const;

export const D3_V2_R4_MODULE = "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts" as const;
export const D3_V2_R4_TRANSCRIPT_MODULE = "extensions/_shared/trusted-session-transcript.ts" as const;
export const D3_V2_R4_STRICT_JSON_MODULE = "extensions/_shared/strict-json.ts" as const;
export const D3_V2_R4_CREATE_ONLY_MODULE = "extensions/_shared/retained-fd-create-only.ts" as const;
export const D3_V2_R4_MANIFEST_GENERATOR = "scripts/generate-proposition-lifecycle-freshness-d3-v2-session-start-r4-manifest.mjs" as const;
export const D3_V2_R4_ADAPTER_MANIFEST_GENERATOR = "scripts/generate-proposition-lifecycle-freshness-d3-v2-session-start-manifest.mjs" as const;
export const D3_V2_R4_DOSSIER_GENERATOR = "scripts/dossier-proposition-lifecycle-freshness-d3-v2-session-start-r4-execution-ready.mjs" as const;
export const D3_V2_R4_EVIDENCE_MODULE = "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4-evidence.ts" as const;
export const D3_V2_R4_PRODUCTION_CLI = "scripts/operate-proposition-lifecycle-freshness-d3-v2-session-start-r4.mjs" as const;
export const D3_V2_R4_SMOKE = "scripts/smoke-proposition-lifecycle-freshness-d3-v2-session-start-r4.mjs" as const;

export const D3_V2_R4_PREDECESSOR_DOSSIER_RELATIVE = "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-execution-ready-dossier.json" as const;
export const D3_V2_R4_ADAPTER_MANIFEST_RELATIVE = "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-adapter-manifest.json" as const;
export const D3_V2_R4_OPERATOR_MANIFEST_RELATIVE = "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-operator-manifest.json" as const;
export const D3_V2_R4_EXECUTION_DOSSIER_RELATIVE = "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-execution-ready-dossier.json" as const;
export const D3_V2_R4_PREVIEW_RELATIVE = "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-r4-production-read-only-preview.json" as const;

export const D3_V2_R4_PRODUCTION_TARGET_SESSION_ID = "019f6f1d-cc5c-7fcf-bcee-18dd618656ff" as const;
export const D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT = "/home/worker/.pi/agent/sessions" as const;
export const D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH = "/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-17T08-07-31-677Z_019f6f1d-cc5c-7fcf-bcee-18dd618656ff.jsonl" as const;
export const D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_ID = "019f77f6-899b-7fa0-ad5f-e1d8bb1ceadc" as const;
export const D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSIONS_ROOT = "/home/worker/.pi/agent/sessions" as const;
export const D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH = "/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-19T01-21-13-627Z_019f77f6-899b-7fa0-ad5f-e1d8bb1ceadc.jsonl" as const;
export const D3_V2_R4_FROZEN_TARGET_PREFIX_BYTES = 955019 as const;
export const D3_V2_R4_FROZEN_TARGET_PREFIX_SHA256 = "99e9e1a229f5007618f625b2c9407ce098cfffd5801e0a7a42b65485c3a8de4e" as const;
export const D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_BYTES = 4269956 as const;
export const D3_V2_R4_FROZEN_AUTHORIZATION_PREFIX_SHA256 = "3c27956db96faedd6d20c4e203a660ce3ea6b758790bb5049cec7f562a5c5379" as const;
// Compatibility aliases are read-only names; all R4.1 structures use explicit target/auth bindings.
export const D3_V2_R4_PRODUCTION_SESSION_ID = D3_V2_R4_PRODUCTION_TARGET_SESSION_ID;
export const D3_V2_R4_PRODUCTION_SESSION_ROOT = D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT;
export const D3_V2_R4_PRODUCTION_SESSION_PATH = D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH;
export const D3_V2_R4_PRODUCTION_SETTINGS_PATH = "/home/worker/.pi/agent/pi-astack-settings.json" as const;
export const D3_V2_R4_PRODUCTION_CONTROL_ROOT = "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4" as const;
export const D3_V2_R4_PRODUCTION_ROLLBACK_ROOT = "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4-rollback" as const;
export const D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT = "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/activations" as const;
export const D3_V2_R4_PRODUCTION_RUNTIME_AUDIT = "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start-runtime-audit.jsonl" as const;
export const D3_V2_R4_PRODUCTION_OPERATOR_AUDIT = "/home/worker/.pi/.pi-astack/adr0040-d3-v2-session-start/r4/operator-audit.jsonl" as const;
export const D3_V2_R4_PRODUCTION_QUARANTINE_TARGET = `/home/worker/.pi/agent/sessions/--home-worker-.pi--/.adr0040-r4-quarantine-${D3_V2_R4_PRODUCTION_TARGET_SESSION_ID}.jsonl` as const;

const HASH = /^[0-9a-f]{64}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const MAX_OBJECT_BYTES = 1024 * 1024;

export interface D3V2R4D3Identities extends D3V2ActivationD3Identities {}

export interface D3V2R4FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  raw_sha256: string;
}

export interface D3V2R4ArtifactIdentity {
  relative_path: string;
  raw_sha256: string;
  self_hash: string;
}

export interface D3V2R4OperatorManifest {
  schema_version: typeof D3_V2_R4_OPERATOR_MANIFEST_SCHEMA;
  revision: typeof D3_V2_R4_REVISION;
  predecessor_revision: "R3.9";
  graph: TypescriptStaticDependencyGraph;
  critical_required_paths: readonly string[];
  source_closure_hash: string;
  manifest_hash: string;
}

export interface D3V2R4SessionBinding {
  session_id: string;
  sessions_root: string;
  session_file: Readonly<{ path: string; dev: number; ino: number; prefix_bytes: number; prefix_sha256: string }>;
}

export interface D3V2R4FrozenBinding {
  schema_version: "adr0040-d3-v2-session-start-r4-frozen-execution-binding/v2";
  target_session_binding: D3V2R4SessionBinding;
  authorization_transcript_binding: D3V2R4SessionBinding;
  settings_path: string;
  settings_pre: D3V2R4FileIdentity;
  settings_post_raw_sha256: string;
  desired_settings: Readonly<Record<string, unknown>>;
  control_root: string;
  old_activation_root: string;
  runtime_audit_path: string;
  operator_audit_path: string;
  rollback_target: string;
  quarantine_target: string;
  d3_identities: D3V2R4D3Identities;
  adapter_manifest_hash: string;
  operator_manifest: Readonly<{ relative_path: string; raw_sha256: string; manifest_hash: string; graph_hash: string; source_closure_hash: string }>;
  predecessor_dossier: D3V2R4ArtifactIdentity;
  execution_dossier: D3V2R4ArtifactIdentity;
  source_commit: string | null;
  source_commit_required_at_production_authorization: true;
}

export interface D3V2R4TestHooks {
  beforeFirstPublish?: () => void;
  beforeSettingsCas?: () => void;
  afterSettingsCasBeforeReceipt?: () => void;
  createOnlyCrash?: Readonly<{ kind: RetainedCreateOnlyKind; point: RetainedCreateOnlyCrashPoint }>;
}

export class D3V2R4Error extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "D3V2R4Error";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export const D3_V2_R4_CRITICAL_REQUIRED_PATHS = Object.freeze([
  D3_V2_R4_MODULE,
  D3_V2_R4_TRANSCRIPT_MODULE,
  D3_V2_R4_STRICT_JSON_MODULE,
  D3_V2_R4_CREATE_ONLY_MODULE,
  "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts",
  "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-activation.ts",
  "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-rollback.ts",
  "extensions/_shared/retained-directory-ofd-lock.ts",
  "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.ts",
  "extensions/abrain/rule-injector/index.ts",
  "pi-astack-settings.schema.json",
  ".gitignore",
  "package.json",
  "package-lock.json",
  D3_V2_R4_ADAPTER_MANIFEST_GENERATOR,
  D3_V2_R4_ADAPTER_MANIFEST_RELATIVE,
  D3_V2_R4_MANIFEST_GENERATOR,
  D3_V2_R4_DOSSIER_GENERATOR,
  D3_V2_R4_EVIDENCE_MODULE,
  D3_V2_R4_PRODUCTION_CLI,
  D3_V2_R4_SMOKE,
] as const);

export function buildD3V2R4OperatorManifest(repoRootInput: string): D3V2R4OperatorManifest {
  const repoRoot = path.resolve(repoRootInput);
  const graph = buildTypescriptStaticDependencyGraph({
    repoRoot,
    roots: [D3_V2_R4_MODULE, D3_V2_R4_EVIDENCE_MODULE, "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.ts"],
    explicitFiles: [
      "extensions/abrain/rule-injector/index.ts", "pi-astack-settings.schema.json", ".gitignore", "package.json", "package-lock.json",
      D3_V2_R4_ADAPTER_MANIFEST_GENERATOR, D3_V2_R4_ADAPTER_MANIFEST_RELATIVE,
      D3_V2_R4_MANIFEST_GENERATOR, D3_V2_R4_DOSSIER_GENERATOR, D3_V2_R4_PRODUCTION_CLI, D3_V2_R4_SMOKE,
    ],
  });
  validateTypescriptStaticDependencyGraph(graph, { requiredPaths: D3_V2_R4_CRITICAL_REQUIRED_PATHS });
  const sourceClosureHash = jcsSha256Hex({ graph_hash: graph.graph_hash, files: graph.files });
  const base = {
    schema_version: D3_V2_R4_OPERATOR_MANIFEST_SCHEMA,
    revision: D3_V2_R4_REVISION,
    predecessor_revision: "R3.9" as const,
    graph,
    critical_required_paths: [...D3_V2_R4_CRITICAL_REQUIRED_PATHS],
    source_closure_hash: sourceClosureHash,
  };
  return deepFreeze({ ...base, manifest_hash: jcsSha256Hex(base) });
}

export function validateD3V2R4OperatorManifest(value: unknown): D3V2R4OperatorManifest {
  const manifest = asRecord(value, "R4 operator manifest") as unknown as D3V2R4OperatorManifest;
  exactKeys(manifest as unknown as Record<string, unknown>, ["schema_version", "revision", "predecessor_revision", "graph", "critical_required_paths", "source_closure_hash", "manifest_hash"], "R4 operator manifest");
  if (manifest.schema_version !== D3_V2_R4_OPERATOR_MANIFEST_SCHEMA || manifest.revision !== D3_V2_R4_REVISION || manifest.predecessor_revision !== "R3.9") fail("R4_MANIFEST_INVALID", "R4 manifest identity differs");
  validateTypescriptStaticDependencyGraph(manifest.graph, { requiredPaths: D3_V2_R4_CRITICAL_REQUIRED_PATHS });
  if (canonicalizeJcs(manifest.critical_required_paths) !== canonicalizeJcs([...D3_V2_R4_CRITICAL_REQUIRED_PATHS])) fail("R4_MANIFEST_INVALID", "R4 critical path closure differs");
  assertHash(manifest.source_closure_hash, "source_closure_hash");
  if (manifest.source_closure_hash !== jcsSha256Hex({ graph_hash: manifest.graph.graph_hash, files: manifest.graph.files })) fail("R4_MANIFEST_INVALID", "source closure hash differs");
  const base = { ...manifest } as Record<string, unknown>;
  delete base.manifest_hash;
  if (manifest.manifest_hash !== jcsSha256Hex(base)) fail("R4_MANIFEST_INVALID", "manifest self-hash differs");
  return deepFreeze(manifest);
}

export function buildD3V2R4SettingsBinding(args: {
  controlRoot: string;
  operatorManifestHash: string;
  settingsPath: string;
}): D3V2R4SettingsBinding {
  assertHash(args.operatorManifestHash, "operatorManifestHash");
  return deepFreeze({
    schema_version: D3_V2_SESSION_START_R4_SETTINGS_BINDING_SCHEMA,
    controlRoot: requireAbsolute(args.controlRoot, "controlRoot"),
    operatorManifestHash: args.operatorManifestHash,
    settingsPath: requireAbsolute(args.settingsPath, "settingsPath"),
  });
}

export function buildD3V2R4DesiredSettings(args: {
  sessionId: string;
  d3: D3V2R4D3Identities;
  adapterManifestHash: string;
  r4Binding: D3V2R4SettingsBinding;
  maxReadBytes?: number;
}): Readonly<Record<string, unknown>> {
  assertSafeSessionIdComponent(args.sessionId);
  validateD3Identities(args.d3);
  assertHash(args.adapterManifestHash, "adapterManifestHash");
  return deepFreeze({
    enabled: true,
    selector: { session_ids: [args.sessionId] },
    expectedSelectionHash: args.d3.selection_hash,
    expectedHeadHash: args.d3.head_hash,
    expectedProofHash: args.d3.proof_hash,
    expectedStableBundleHash: args.d3.stable_bundle_hash,
    expectedIntentHash: args.d3.intent_hash,
    adapterManifestHash: args.adapterManifestHash,
    r4Binding: args.r4Binding,
    maxReadBytes: args.maxReadBytes ?? 65536,
  });
}

export function captureD3V2R4SettingsPrestate(settingsPath: string): Readonly<{
  raw: string;
  identity: D3V2R4FileIdentity;
  parsed: Record<string, unknown>;
  v2_prestate: "absent" | "disabled_empty";
}> {
  const captured = readRegularFileIdentity(settingsPath, "settings", 8 * 1024 * 1024);
  const parsed = asRecord(parseStrict(captured.raw, "settings"), "settings");
  const ruleInjector = asRecord(parsed.ruleInjector, "settings.ruleInjector");
  const current = ruleInjector[D3_V2_R4_SETTINGS_KEY];
  let v2Prestate: "absent" | "disabled_empty";
  if (current === undefined) v2Prestate = "absent";
  else {
    const disabled = asRecord(current, "settings R4 prestate");
    exactKeys(disabled, ["enabled", "selector"], "settings R4 disabled-empty prestate");
    const selector = asRecord(disabled.selector, "settings R4 disabled-empty selector");
    exactKeys(selector, ["session_ids"], "settings R4 disabled-empty selector");
    if (disabled.enabled !== false || !Array.isArray(selector.session_ids) || selector.session_ids.length !== 0) {
      fail("R4_SETTINGS_PRESTATE", "v2 key must be absent or exact disabled-empty");
    }
    v2Prestate = "disabled_empty";
  }
  return deepFreeze({ raw: captured.raw.toString("utf8"), identity: captured.identity, parsed, v2_prestate: v2Prestate });
}

export function renderD3V2R4SettingsPost(preParsedInput: Record<string, unknown>, desired: Readonly<Record<string, unknown>>): string {
  const preParsed = clone(preParsedInput);
  const ruleInjector = asRecord(preParsed.ruleInjector, "settings.ruleInjector");
  const beforeOther = clone(ruleInjector);
  delete beforeOther[D3_V2_R4_SETTINGS_KEY];
  ruleInjector[D3_V2_R4_SETTINGS_KEY] = clone(desired);
  preParsed.ruleInjector = ruleInjector;
  const raw = `${JSON.stringify(preParsed, null, 2)}\n`;
  const reparsed = asRecord(parseStrict(Buffer.from(raw), "rendered settings post"), "rendered settings post");
  const afterRule = asRecord(reparsed.ruleInjector, "rendered settings post ruleInjector");
  const afterOther = clone(afterRule);
  delete afterOther[D3_V2_R4_SETTINGS_KEY];
  if (canonicalizeJcs(beforeOther) !== canonicalizeJcs(afterOther)) fail("R4_SETTINGS_MUTATION_SCOPE", "settings renderer changed another ruleInjector key");
  const preOther = clone(preParsedInput);
  const preOtherRule = asRecord(preOther.ruleInjector, "pre settings ruleInjector");
  delete preOtherRule[D3_V2_R4_SETTINGS_KEY];
  const postOther = clone(reparsed);
  const postOtherRule = asRecord(postOther.ruleInjector, "post settings ruleInjector");
  delete postOtherRule[D3_V2_R4_SETTINGS_KEY];
  if (canonicalizeJcs(preOther) !== canonicalizeJcs(postOther)) fail("R4_SETTINGS_MUTATION_SCOPE", "settings renderer changed a non-v2 setting");
  return raw;
}

export function buildD3V2R4FrozenBinding(args: {
  targetSessionId: string;
  targetSessionsRoot: string;
  targetSessionPath: string;
  targetFrozenPrefix?: D3V2R4SessionBinding["session_file"];
  authorizationSessionId: string;
  authorizationSessionsRoot: string;
  authorizationSessionPath: string;
  authorizationFrozenPrefix?: D3V2R4SessionBinding["session_file"];
  settingsPath: string;
  controlRoot: string;
  rollbackTarget: string;
  oldActivationRoot: string;
  runtimeAuditPath: string;
  operatorAuditPath: string;
  quarantineTarget: string;
  d3: D3V2R4D3Identities;
  adapterManifestHash: string;
  operatorManifest: D3V2R4OperatorManifest;
  operatorManifestIdentity: Readonly<{ relative_path: string; raw_sha256: string }>;
  predecessorDossier: D3V2R4ArtifactIdentity;
  executionDossier: D3V2R4ArtifactIdentity;
  sourceCommit?: string | null;
}): D3V2R4FrozenBinding {
  assertSafeSessionIdComponent(args.targetSessionId);
  assertSafeSessionIdComponent(args.authorizationSessionId);
  const targetSession = args.targetFrozenPrefix ?? captureTrustedSessionPrefixBinding({ sessionsRoot: args.targetSessionsRoot, sessionPath: args.targetSessionPath, expectedSessionId: args.targetSessionId });
  const authorizationSession = args.authorizationFrozenPrefix ?? captureTrustedSessionPrefixBinding({ sessionsRoot: args.authorizationSessionsRoot, sessionPath: args.authorizationSessionPath, expectedSessionId: args.authorizationSessionId });
  const targetBinding = deepFreeze({ session_id: args.targetSessionId, sessions_root: path.resolve(args.targetSessionsRoot), session_file: targetSession });
  const authorizationBinding = deepFreeze({ session_id: args.authorizationSessionId, sessions_root: path.resolve(args.authorizationSessionsRoot), session_file: authorizationSession });
  assertDistinctSessionBindings(targetBinding, authorizationBinding);
  assertSessionBindingCurrent(targetSession, targetBinding.sessions_root, targetBinding.session_id);
  assertSessionBindingCurrent(authorizationSession, authorizationBinding.sessions_root, authorizationBinding.session_id);
  if (path.resolve(args.controlRoot) === path.resolve(args.rollbackTarget)) fail("R4_CONTROL_ROLLBACK_ALIAS", "control_root and rollback_target must be distinct");
  const settings = captureD3V2R4SettingsPrestate(args.settingsPath);
  assertNoSelectorConflict(settings.parsed, args.targetSessionId, true);
  if (!activationRootHasNoBoundObject(args.oldActivationRoot)) fail("R4_FOREIGN_ACTIVATION", "foreign activation root is not empty/absent and safe");
  const r4Binding = buildD3V2R4SettingsBinding({ controlRoot: args.controlRoot, operatorManifestHash: args.operatorManifest.manifest_hash, settingsPath: args.settingsPath });
  const desired = buildD3V2R4DesiredSettings({ sessionId: args.targetSessionId, d3: args.d3, adapterManifestHash: args.adapterManifestHash, r4Binding });
  const postRaw = renderD3V2R4SettingsPost(settings.parsed, desired);
  return deepFreeze({
    schema_version: "adr0040-d3-v2-session-start-r4-frozen-execution-binding/v2",
    target_session_binding: targetBinding,
    authorization_transcript_binding: authorizationBinding,
    settings_path: path.resolve(args.settingsPath),
    settings_pre: settings.identity,
    settings_post_raw_sha256: sha256Hex(postRaw),
    desired_settings: desired,
    control_root: path.resolve(args.controlRoot),
    old_activation_root: path.resolve(args.oldActivationRoot),
    runtime_audit_path: path.resolve(args.runtimeAuditPath),
    operator_audit_path: path.resolve(args.operatorAuditPath),
    rollback_target: path.resolve(args.rollbackTarget),
    quarantine_target: path.resolve(args.quarantineTarget),
    d3_identities: deepFreeze({ ...args.d3 }),
    adapter_manifest_hash: args.adapterManifestHash,
    operator_manifest: deepFreeze({
      relative_path: args.operatorManifestIdentity.relative_path,
      raw_sha256: args.operatorManifestIdentity.raw_sha256,
      manifest_hash: args.operatorManifest.manifest_hash,
      graph_hash: args.operatorManifest.graph.graph_hash,
      source_closure_hash: args.operatorManifest.source_closure_hash,
    }),
    predecessor_dossier: deepFreeze({ ...args.predecessorDossier }),
    execution_dossier: deepFreeze({ ...args.executionDossier }),
    source_commit: args.sourceCommit ?? null,
    source_commit_required_at_production_authorization: true,
  });
}

export function executeD3V2R4BindOperator(args: {
  target: "sandbox" | "production";
  mode: "execute" | "continue";
  frozen: D3V2R4FrozenBinding;
  nowMs?: number;
  testHooks?: D3V2R4TestHooks;
}): Readonly<Record<string, unknown>> {
  validateFrozenBinding(args.frozen);
  if (args.target === "production" && args.testHooks) fail("R4_TEST_HOOK_PRODUCTION", "R4 test hooks are sandbox-only");
  if (args.target === "sandbox") assertSandboxEnvironment(args.frozen);
  else assertProductionEnvironment(args.frozen);
  assertR4PlatformBoundary();
  assertBothSessionBindingsCurrent(args.frozen);
  if (args.mode === "execute") return executeFresh({ ...args, mode: "execute" });
  return executeContinue({ ...args, mode: "continue" });
}

function executeFresh(args: {
  target: "sandbox" | "production";
  mode: "execute";
  frozen: D3V2R4FrozenBinding;
  nowMs?: number;
  testHooks?: D3V2R4TestHooks;
}): Readonly<Record<string, unknown>> {
  const frozen = args.frozen;
  const target = frozen.target_session_binding;
  const auth = frozen.authorization_transcript_binding;
  const settingsPre = captureD3V2R4SettingsPrestate(frozen.settings_path);
  assertSettingsPreMatchesFrozen(settingsPre, frozen);
  assertNoSelectorConflict(settingsPre.parsed, target.session_id, true);
  if (!activationRootHasNoBoundObject(frozen.old_activation_root)) fail("R4_FOREIGN_ACTIVATION", "target session may not coexist with a foreign authorized activation");
  assertControlRootFreshOrAbsent(frozen.control_root);
  const coordinate = verifyFreshLatestStandaloneUserAuthorization({
    sessionsRoot: auth.sessions_root,
    sessionPath: auth.session_file.path,
    expectedSessionId: auth.session_id,
    exactText: D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE,
    maximumAgeMs: D3_V2_R4_AUTHORIZATION_MAXIMUM_AGE_MS,
    nowMs: args.nowMs,
  });
  const sourceCommit = requireSourceCommit(args.target, frozen);
  const tuple = buildAuthorizationTuple(frozen, coordinate, sourceCommit);
  validateAuthorizationTuple(tuple as Record<string, unknown>);
  assertTupleMatchesFrozen(tuple as Record<string, unknown>, frozen, sourceCommit);
  const operationId = jcsSha256Hex(tuple);
  const paths = operationPaths(frozen.control_root, operationId, frozen.operator_audit_path);
  const intentBase = { schema_version: D3_V2_R4_INTENT_SCHEMA, operation_id: operationId, authorization_tuple: tuple, control_paths: paths };
  const intent = deepFreeze({ ...intentBase, intent_hash: jcsSha256Hex(intentBase) });
  validateIntent(intent);
  const activation = buildActivation(frozen, coordinate, operationId, intent.intent_hash);
  assertActivationMatchesTuple(activation, tuple as Record<string, unknown>, intent, paths);

  const lock = acquireRetainedDirectoryOfdLock(path.dirname(frozen.settings_path));
  if (lock.status !== "ACQUIRED" || lock.fd === null) fail("R4_SETTINGS_LOCK_BUSY", "settings parent cooperative OFD lock is busy; no automatic retry");
  try {
    // Complete tuple/cross-binding/source/settings validation and immediate target/auth
    // revalidation all happen before the first control or rollback-root write.
    args.testHooks?.beforeFirstPublish?.();
    assertSettingsPreMatchesFrozen(captureD3V2R4SettingsPrestate(frozen.settings_path), frozen);
    verifyBothSessionBindingsImmediatelyBeforeMutation(frozen, coordinate, D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE, args.nowMs);
    if (requireSourceCommit(args.target, frozen) !== sourceCommit) fail("R4_SOURCE_COMMIT_DRIFT", "source commit changed before intent publication");
    assertControlRootFreshOrAbsent(frozen.control_root);
    ensureR4ControlDirectories(frozen.control_root);
    ensureDirectoryChainNoSymlink(frozen.rollback_target, "R4 rollback root");
    assertCreateTargetsAbsent(paths);
    publishR4Object(paths.intent, intent, "intent", operationId, "R4 create-only intent", args.testHooks);
    publishR4Object(paths.activation, activation, "activation", operationId, "R4 create-only activation", args.testHooks);
    const postRaw = renderD3V2R4SettingsPost(settingsPre.parsed, frozen.desired_settings);
    const cas = applySettingsCas({ settingsPath: frozen.settings_path, parentFd: lock.fd, expectedPre: frozen.settings_pre, postRaw, desired: frozen.desired_settings, beforeCas: args.testHooks?.beforeSettingsCas });
    args.testHooks?.afterSettingsCasBeforeReceipt?.();
    const receipt = buildReceipt({ frozen, operationId, intent, activation, settingsPost: cas.identity, completionKind: "initial_execute", completionCoordinate: coordinate, paths });
    publishR4Object(paths.receipt, receipt, "receipt", operationId, "R4 create-only commit receipt", args.testHooks);
    const terminal = verifyTerminalState(frozen, operationId, intent, activation, receipt);
    const audit = appendOperatorAuditBestEffort(frozen.operator_audit_path, { operation_id: operationId, mode: "execute", result: "bound", receipt_hash: receipt.receipt_hash });
    return deepFreeze({ status: "bound", operation_id: operationId, receipt_hash: receipt.receipt_hash, settings_cas: cas.status, runtime_injection_authorized: false, runtime_audit_required_later: true, operator_audit: audit, terminal });
  } finally { lock.close(); }
}

function executeContinue(args: {
  target: "sandbox" | "production";
  mode: "continue";
  frozen: D3V2R4FrozenBinding;
  nowMs?: number;
  testHooks?: D3V2R4TestHooks;
}): Readonly<Record<string, unknown>> {
  const frozen = args.frozen;
  const auth = frozen.authorization_transcript_binding;
  const found = discoverSoleOperationCandidate(frozen.control_root);
  const intent = validateIntent(found.intent);
  const tuple = asRecord(intent.authorization_tuple, "R4 authorization tuple");
  const initial = validateTrustedSessionUserCoordinate(tuple.authorization_coordinate);
  verifyRecordedTrustedSessionCoordinate({ sessionsRoot: auth.sessions_root, sessionPath: auth.session_file.path, expectedSessionId: auth.session_id, coordinate: initial, exactText: D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE });
  const continueCoordinate = verifyFreshLatestStandaloneUserAuthorization({
    sessionsRoot: auth.sessions_root,
    sessionPath: auth.session_file.path,
    expectedSessionId: auth.session_id,
    exactText: D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE,
    maximumAgeMs: D3_V2_R4_AUTHORIZATION_MAXIMUM_AGE_MS,
    nowMs: args.nowMs,
    requiredAfter: { line: initial.message_line_number, timestamp: initial.timestamp },
  });
  const operationId = String(intent.operation_id);
  if (operationId !== jcsSha256Hex(tuple) || operationId !== found.operationId) fail("R4_OPERATION_ID", "existing operation_id is not SHA-256(JCS(full authorization tuple))");
  const sourceCommit = requireSourceCommit(args.target, frozen);
  assertTupleMatchesFrozen(tuple, frozen, sourceCommit);
  const paths = operationPaths(frozen.control_root, operationId, frozen.operator_audit_path);
  const expectedActivation = buildActivation(frozen, initial, operationId, String(intent.intent_hash));
  if (found.activation) {
    const candidateActivation = validateBoundActivationObjectClosed(found.activation);
    if (canonicalizeJcs(candidateActivation) !== canonicalizeJcs(expectedActivation)) fail("R4_RECOVERY_ACTIVATION_MISMATCH", "existing/pending activation bytes differ from the exact tuple-derived activation");
  }
  const activation = expectedActivation;
  assertActivationMatchesTuple(activation, tuple, intent, paths);

  const lock = acquireRetainedDirectoryOfdLock(path.dirname(frozen.settings_path));
  if (lock.status !== "ACQUIRED" || lock.fd === null) fail("R4_SETTINGS_LOCK_BUSY", "settings parent cooperative OFD lock is busy; no automatic retry");
  try {
    // No mutation (including pending cleanup) occurs until both transcript bindings,
    // source closure, the control inventory, and the legal A/B recovery state re-close.
    args.testHooks?.beforeFirstPublish?.();
    verifyRecordedTrustedSessionCoordinate({ sessionsRoot: auth.sessions_root, sessionPath: auth.session_file.path, expectedSessionId: auth.session_id, coordinate: initial, exactText: D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE });
    verifyBothSessionBindingsImmediatelyBeforeMutation(frozen, continueCoordinate, D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE, args.nowMs);
    if (requireSourceCommit(args.target, frozen) !== sourceCommit) fail("R4_SOURCE_COMMIT_DRIFT", "source commit changed before continue recovery");

    const current = discoverSoleOperationCandidate(frozen.control_root);
    if (current.operationId !== operationId || canonicalizeJcs(current.intent) !== canonicalizeJcs(intent)) fail("R4_RECOVERY_INTENT_MISMATCH", "intent/control identity changed before continue recovery");
    if (current.activation) {
      const candidateActivation = validateBoundActivationObjectClosed(current.activation);
      if (canonicalizeJcs(candidateActivation) !== canonicalizeJcs(activation)) fail("R4_RECOVERY_ACTIVATION_MISMATCH", "existing/pending activation bytes differ from the exact tuple-derived activation");
    }
    const settings = readRegularFileIdentity(frozen.settings_path, "settings continue", 8 * 1024 * 1024);
    const isPre = settings.identity.raw_sha256 === frozen.settings_pre.raw_sha256 && sameExactFileIdentityExcludingRawHash(settings.identity, frozen.settings_pre);
    const isPost = settings.identity.raw_sha256 === frozen.settings_post_raw_sha256 && settingsSemanticallyExact(settings.raw, frozen.desired_settings);
    if (!current.activation && (!isPre || current.receipt)) {
      fail("R4_RECOVERY_ACTIVATION_MISSING", "activation reconstruction requires exact settings A(pre) and an absent receipt; halt without cleanup");
    }
    let candidateReceipt: Record<string, unknown> | null = null;
    if (current.receipt) {
      candidateReceipt = validateReceipt(current.receipt);
      assertReceiptMatchesTuple(candidateReceipt, tuple, intent, activation, paths);
    }
    if (candidateReceipt && !isPost) fail("R4_RECOVERY_PRE_WITH_RECEIPT", "receipt final/pending exists while settings is not exact post; halt without cleanup");
    if (!candidateReceipt && !isPre && !isPost) fail("R4_RECOVERY_SETTINGS_AB", "settings is neither exact A(pre) nor exact B(post); halt without cleanup");

    const intentRaw = `${canonicalizeJcs(intent)}\n`;
    const intentRecovery = recoverCreateOnlyPendingRetained({ file: paths.intent, raw: intentRaw, label: "R4 intent", operationId, kind: "intent", recoveryMode: "fresh_continue" });
    if (!intentRecovery.finalPresent) publishR4Object(paths.intent, intent, "intent", operationId, "R4 continue intent recovery", args.testHooks);
    const activationRaw = `${canonicalizeJcs(activation)}\n`;
    const activationRecovery = recoverCreateOnlyPendingRetained({ file: paths.activation, raw: activationRaw, label: "R4 activation", operationId, kind: "activation", recoveryMode: "fresh_continue" });
    if (!activationRecovery.finalPresent) publishR4Object(paths.activation, activation, "activation", operationId, "R4 continue activation recovery", args.testHooks);

    let receiptFinalPresent = false;
    if (candidateReceipt) {
      const receiptRecovery = recoverCreateOnlyPendingRetained({ file: paths.receipt, raw: `${canonicalizeJcs(candidateReceipt)}\n`, label: "R4 receipt", operationId, kind: "receipt", recoveryMode: "fresh_continue" });
      receiptFinalPresent = receiptRecovery.finalPresent;
      if (receiptFinalPresent) {
        const exactReceipt = loadReceipt(paths.receipt, operationId, String(intent.intent_hash), activation.activation_object_hash);
        const terminal = verifyTerminalState(frozen, operationId, intent, activation, exactReceipt);
        return deepFreeze({ status: "terminal_verified", operation_id: operationId, receipt_hash: exactReceipt.receipt_hash, rewritten: false, pending_recovered: receiptRecovery.status, runtime_injection_authorized: false, runtime_audit_required_later: true, terminal });
      }
    }

    let postIdentity = settings.identity;
    let casStatus = "already_exact_post";
    if (isPre) {
      const pre = captureD3V2R4SettingsPrestate(frozen.settings_path);
      assertSettingsPreMatchesFrozen(pre, frozen);
      const postRaw = renderD3V2R4SettingsPost(pre.parsed, frozen.desired_settings);
      const cas = applySettingsCas({ settingsPath: frozen.settings_path, parentFd: lock.fd, expectedPre: frozen.settings_pre, postRaw, desired: frozen.desired_settings, beforeCas: args.testHooks?.beforeSettingsCas });
      postIdentity = cas.identity;
      casStatus = cas.status;
      args.testHooks?.afterSettingsCasBeforeReceipt?.();
    }
    const receipt = buildReceipt({ frozen, operationId, intent, activation, settingsPost: postIdentity, completionKind: "fresh_continue", completionCoordinate: continueCoordinate, paths });
    publishR4Object(paths.receipt, receipt, "receipt", operationId, "R4 continue create-only commit receipt", args.testHooks);
    const terminal = verifyTerminalState(frozen, operationId, intent, activation, receipt);
    const audit = appendOperatorAuditBestEffort(frozen.operator_audit_path, { operation_id: operationId, mode: "continue", result: "bound", receipt_hash: receipt.receipt_hash });
    return deepFreeze({ status: "bound", operation_id: operationId, receipt_hash: receipt.receipt_hash, settings_cas: casStatus, receipt_final_preexisting: receiptFinalPresent, runtime_injection_authorized: false, runtime_audit_required_later: true, operator_audit: audit, terminal });
  } finally { lock.close(); }
}

export function evaluateD3V2R4RuntimeGate(args: {
  settings: D3V2SessionStartInjectionSettings;
  sessionManager?: unknown;
  adapterManifestHash: string;
}): { ok: true; activation: D3V2BoundActivationObject; operationId: string; receiptHash: string } | { ok: false; reason: string; error?: string } {
  try {
    if (!args.settings.enabled) return { ok: false, reason: "disabled" };
    const binding = args.settings.r4Binding;
    if (!binding) return { ok: false, reason: "not_r4" };
    if (args.settings.adapterManifestHash !== args.adapterManifestHash) fail("R4_RUNTIME_MANIFEST", "runtime adapter manifest binding differs");
    const manager = args.sessionManager as { getSessionId?(): unknown; getSessionFile?(): unknown } | undefined;
    if (!manager || typeof manager.getSessionId !== "function" || typeof manager.getSessionFile !== "function") fail("R4_RUNTIME_SESSION", "persisted session manager is required");
    const sessionId = manager.getSessionId();
    const sessionPath = manager.getSessionFile();
    assertSafeSessionIdComponent(sessionId);
    if (typeof sessionPath !== "string" || !sessionPath) fail("R4_RUNTIME_SESSION", "persisted session file is required");
    const settings = readRegularFileIdentity(binding.settingsPath, "runtime settings", 8 * 1024 * 1024);
    if (!settingsSemanticallyExact(settings.raw, runtimeDesiredSettings(args.settings))) fail("R4_RUNTIME_SETTINGS", "live settings subtree is not exact desired R4 shape");
    const found = loadSoleOperation(binding.controlRoot);
    const intent = validateIntent(found.intent);
    const tuple = asRecord(intent.authorization_tuple, "R4 runtime authorization tuple");
    if (found.operationId !== jcsSha256Hex(tuple) || intent.operation_id !== found.operationId) fail("R4_RUNTIME_OPERATION", "runtime operation identity differs");
    if (tuple.settings_post_raw_sha256 !== settings.identity.raw_sha256) fail("R4_RUNTIME_SETTINGS", "runtime settings raw hash differs from authorization tuple");
    const tupleManifest = asRecord(tuple.operator_manifest, "R4 runtime operator manifest");
    if (tupleManifest.manifest_hash !== binding.operatorManifestHash) fail("R4_RUNTIME_MANIFEST", "runtime operator manifest pin differs from authorization tuple");
    const target = validateTupleSessionBinding(tuple.target_session_binding, "R4 runtime target_session_binding");
    const authorization = validateTupleSessionBinding(tuple.authorization_transcript_binding, "R4 runtime authorization_transcript_binding");
    assertDistinctSessionBindings(target, authorization);
    if (target.session_id !== sessionId || path.resolve(target.session_file.path) !== path.resolve(sessionPath)) fail("R4_RUNTIME_SESSION", "runtime session path/id differs from target binding");
    assertSessionBindingCurrent(target.session_file, target.sessions_root, target.session_id);
    assertSessionBindingCurrent(authorization.session_file, authorization.sessions_root, authorization.session_id);
    verifyRecordedTrustedSessionCoordinate({ sessionsRoot: authorization.sessions_root, sessionPath: authorization.session_file.path, expectedSessionId: authorization.session_id, coordinate: tuple.authorization_coordinate, exactText: D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE });
    const paths = operationPaths(binding.controlRoot, found.operationId, String(asRecord(tuple.control_path_derivation, "path derivation").operator_audit_path));
    const activation = loadActivation(paths.activation, found.operationId, String(intent.intent_hash));
    assertActivationMatchesTuple(activation, tuple, intent, paths);
    const receipt = loadReceipt(paths.receipt, found.operationId, String(intent.intent_hash), activation.activation_object_hash);
    assertReceiptMatchesTuple(receipt, tuple, intent, activation, paths);
    const completionEnvelope = asRecord(receipt.completion_authorization, "R4 runtime completion authorization");
    const completion = validateTrustedSessionUserCoordinate(completionEnvelope.coordinate);
    verifyRecordedTrustedSessionCoordinate({
      sessionsRoot: authorization.sessions_root,
      sessionPath: authorization.session_file.path,
      expectedSessionId: authorization.session_id,
      coordinate: completion,
      exactText: completionEnvelope.kind === "initial_execute" ? D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE : D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE,
    });
    if (receipt.settings_post_raw_sha256 !== settings.identity.raw_sha256 || canonicalizeJcs(receipt.settings_post_identity) !== canonicalizeJcs(settings.identity)) fail("R4_RUNTIME_SETTINGS", "receipt does not bind exact current settings post identity");
    if (canonicalizeJcs(receipt.target_session_binding) !== canonicalizeJcs(target)) fail("R4_RUNTIME_SESSION", "receipt target session binding differs");
    if (canonicalizeJcs(receipt.authorization_transcript_binding) !== canonicalizeJcs(authorization)) fail("R4_RUNTIME_SESSION", "receipt authorization transcript binding differs");
    if (!activationRootHasNoBoundObject(String(asRecord(tuple.control_path_derivation, "path derivation").old_activation_root))) fail("R4_RUNTIME_FOREIGN", "foreign authorized activation present");
    assertNoSelectorConflict(asRecord(parseStrict(settings.raw, "runtime settings"), "runtime settings"), String(sessionId), false);
    return { ok: true, activation, operationId: found.operationId, receiptHash: String(receipt.receipt_hash) };
  } catch (error) {
    return { ok: false, reason: errorCode(error, "r4_runtime_gate_failed"), error: message(error) };
  }
}

function buildAuthorizationTuple(frozen: D3V2R4FrozenBinding, coordinate: TrustedSessionUserCoordinate, sourceCommit: string): Readonly<Record<string, unknown>> {
  const tuple = {
    schema_version: D3_V2_R4_AUTHORIZATION_TUPLE_SCHEMA,
    authorization_kind: "fresh_latest_standalone_role_user_bind_existing_session" as const,
    authorization_status: "AUTHORIZED" as const,
    target_session_binding: frozen.target_session_binding,
    authorization_transcript_binding: frozen.authorization_transcript_binding,
    d3_identities: frozen.d3_identities,
    predecessor_dossier: frozen.predecessor_dossier,
    operator_manifest: frozen.operator_manifest,
    execution_dossier: frozen.execution_dossier,
    settings_path: frozen.settings_path,
    settings_pre_identity: frozen.settings_pre,
    settings_pre_raw_sha256: frozen.settings_pre.raw_sha256,
    settings_post_raw_sha256: frozen.settings_post_raw_sha256,
    desired_settings: frozen.desired_settings,
    control_path_derivation: deepFreeze({
      control_root: frozen.control_root,
      intent: "intents/{operation_id}.json",
      activation: "activations/{operation_id}.json",
      receipt: "receipts/{operation_id}.json",
      operator_audit_path: frozen.operator_audit_path,
      runtime_audit_path: frozen.runtime_audit_path,
      old_activation_root: frozen.old_activation_root,
      rollback_target: frozen.rollback_target,
      quarantine_target: frozen.quarantine_target,
    }),
    source_closure_hash: frozen.operator_manifest.source_closure_hash,
    source_commit: sourceCommit,
    initial_authorization_contract: authorizationContract("initial"),
    authorization_coordinate: coordinate,
    safety_contract: deepFreeze({
      bind_existing_only: true,
      create_or_rewrite_session: false,
      create_only_objects: true,
      activation_authorized_once_no_flip: true,
      auto_retry: false,
      settings_noncooperative_writer_residual: D3_V2_R4_NONCOOPERATIVE_WRITER_RESIDUAL,
      rollback_not_pre_authorized: true,
    }),
  };
  return deepFreeze(tuple);
}

function authorizationContract(kind: "initial" | "continue"): Readonly<Record<string, unknown>> {
  const phrase = kind === "initial" ? D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE : D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE;
  const base = {
    schema_version: `adr0040-d3-v2-session-start-r4-${kind}-authorization-contract/v1`,
    required_phrase_utf8_bytes: Buffer.byteLength(phrase),
    required_phrase_sha256: sha256Hex(phrase),
    exact_latest_standalone_role_user_required: true,
    freshness_maximum_age_ms: D3_V2_R4_AUTHORIZATION_MAXIMUM_AGE_MS,
    caller_supplied_authorization_payload_forbidden: true,
    machine_binding_generated_by_operator: true,
  };
  return deepFreeze({ ...base, contract_hash: jcsSha256Hex(base) });
}

function buildActivation(frozen: D3V2R4FrozenBinding, coordinate: TrustedSessionUserCoordinate, operationId: string, intentHash: string): D3V2BoundActivationObject {
  const target = frozen.target_session_binding;
  const activationNonce = sha256Hex(`adr0040-d3-v2-r4-activation\0${operationId}`);
  const value = buildD3V2SessionStartActivationObject({
    sessionId: target.session_id,
    activationNonce,
    authorizationStatus: "AUTHORIZED",
    authorizationCoordinate: coordinate,
    d3Identities: frozen.d3_identities,
    adapterManifestHash: frozen.adapter_manifest_hash,
    settingsMutation: frozen.desired_settings,
    auditTarget: frozen.runtime_audit_path,
    rollbackTarget: frozen.rollback_target,
    sessionFile: target.session_file,
    quarantineTarget: frozen.quarantine_target,
    mode: "bound",
    r4: {
      operation_id: operationId,
      intent_hash: intentHash,
      operator_manifest_hash: frozen.operator_manifest.manifest_hash,
      execution_dossier_hash: frozen.execution_dossier.self_hash,
      settings_pre_raw_sha256: frozen.settings_pre.raw_sha256,
      settings_post_raw_sha256: frozen.settings_post_raw_sha256,
      source_closure_hash: frozen.operator_manifest.source_closure_hash,
    },
  });
  return validateBoundActivationObjectClosed(value);
}

function buildReceipt(args: {
  frozen: D3V2R4FrozenBinding;
  operationId: string;
  intent: Record<string, unknown>;
  activation: D3V2BoundActivationObject;
  settingsPost: D3V2R4FileIdentity;
  completionKind: "initial_execute" | "fresh_continue";
  completionCoordinate: TrustedSessionUserCoordinate;
  paths: ReturnType<typeof operationPaths>;
}): Readonly<Record<string, unknown>> {
  const base = {
    schema_version: D3_V2_R4_RECEIPT_SCHEMA,
    operation_id: args.operationId,
    intent_hash: String(args.intent.intent_hash),
    activation_object_hash: args.activation.activation_object_hash,
    settings_pre_raw_sha256: args.frozen.settings_pre.raw_sha256,
    settings_post_raw_sha256: args.frozen.settings_post_raw_sha256,
    settings_post_identity: args.settingsPost,
    target_session_binding: args.frozen.target_session_binding,
    authorization_transcript_binding: args.frozen.authorization_transcript_binding,
    d3_identities: args.frozen.d3_identities,
    adapter_manifest_hash: args.frozen.adapter_manifest_hash,
    operator_manifest_hash: args.frozen.operator_manifest.manifest_hash,
    predecessor_dossier: args.frozen.predecessor_dossier,
    execution_dossier: args.frozen.execution_dossier,
    source_closure_hash: args.frozen.operator_manifest.source_closure_hash,
    initial_authorization_coordinate_hash: String(asRecord(args.intent.authorization_tuple, "authorization tuple").authorization_coordinate && asRecord(asRecord(args.intent.authorization_tuple, "authorization tuple").authorization_coordinate, "authorization coordinate").coordinate_hash),
    completion_authorization: deepFreeze({ kind: args.completionKind, coordinate: args.completionCoordinate, coordinate_hash: args.completionCoordinate.coordinate_hash }),
    control_paths: args.paths,
    durable_object_not_message: true,
    exactly_once: true,
    runtime_audit_required_later: true,
  };
  return deepFreeze({ ...base, receipt_hash: jcsSha256Hex(base) });
}

function applySettingsCas(args: {
  settingsPath: string;
  parentFd: number;
  expectedPre: D3V2R4FileIdentity;
  postRaw: string;
  desired: Readonly<Record<string, unknown>>;
  beforeCas?: () => void;
}): { status: "written" | "exact_winner_readback"; identity: D3V2R4FileIdentity } {
  const basename = path.basename(args.settingsPath);
  const before = readAtRetainedParent(args.parentFd, basename, { label: "settings CAS preimage", maxBytes: 8 * 1024 * 1024, expectedMode: args.expectedPre.mode, expectedNlink: args.expectedPre.nlink });
  const beforeIdentity = withRawIdentity(before.identity, before.raw);
  if (canonicalizeJcs(beforeIdentity) !== canonicalizeJcs(args.expectedPre)) fail("R4_SETTINGS_CAS_PREIMAGE", "settings preimage identity/raw differs before CAS");
  parseStrict(before.raw, "settings CAS preimage");
  args.beforeCas?.();
  const immediate = readAtRetainedParent(args.parentFd, basename, { label: "settings CAS immediate preimage", maxBytes: 8 * 1024 * 1024, expectedMode: args.expectedPre.mode, expectedNlink: args.expectedPre.nlink });
  const immediateIdentity = withRawIdentity(immediate.identity, immediate.raw);
  if (canonicalizeJcs(immediateIdentity) !== canonicalizeJcs(args.expectedPre)) {
    if (sha256Hex(immediate.raw) === sha256Hex(args.postRaw) && settingsSemanticallyExact(immediate.raw, args.desired)) return { status: "exact_winner_readback", identity: immediateIdentity };
    fail("R4_SETTINGS_CAS_RACE", "settings changed before CAS and readback is not the exact winner");
  }
  const tempBase = `.${basename}.adr0040-r4-${process.pid}-${Date.now()}.tmp`;
  const tempProc = procFdChildPath(args.parentFd, tempBase);
  const targetProc = procFdChildPath(args.parentFd, basename);
  let tempPresent = false;
  try {
    const fd = fs.openSync(tempProc, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, args.expectedPre.mode);
    tempPresent = true;
    try { fs.fchmodSync(fd, args.expectedPre.mode); writeAll(fd, Buffer.from(args.postRaw)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const finalCheck = readAtRetainedParent(args.parentFd, basename, { label: "settings CAS final preimage", maxBytes: 8 * 1024 * 1024, expectedMode: args.expectedPre.mode, expectedNlink: args.expectedPre.nlink });
    if (canonicalizeJcs(withRawIdentity(finalCheck.identity, finalCheck.raw)) !== canonicalizeJcs(args.expectedPre)) {
      if (sha256Hex(finalCheck.raw) === sha256Hex(args.postRaw) && settingsSemanticallyExact(finalCheck.raw, args.desired)) {
        fs.unlinkSync(tempProc); tempPresent = false; fs.fsyncSync(args.parentFd);
        return { status: "exact_winner_readback", identity: withRawIdentity(finalCheck.identity, finalCheck.raw) };
      }
      fail("R4_SETTINGS_CAS_RACE", "settings final preimage changed and readback is not the exact winner");
    }
    fs.renameSync(tempProc, targetProc);
    tempPresent = false;
    fs.fsyncSync(args.parentFd);
    const post = readAtRetainedParent(args.parentFd, basename, { label: "settings CAS post", maxBytes: 8 * 1024 * 1024, expectedMode: args.expectedPre.mode, expectedNlink: 1 });
    if (post.raw.toString("utf8") !== args.postRaw || !settingsSemanticallyExact(post.raw, args.desired)) fail("R4_SETTINGS_CAS_POST", "settings exact post readback differs");
    return { status: "written", identity: withRawIdentity(post.identity, post.raw) };
  } finally {
    if (tempPresent) { try { fs.unlinkSync(tempProc); fs.fsyncSync(args.parentFd); } catch { /* best effort */ } }
  }
}

function verifyTerminalState(frozen: D3V2R4FrozenBinding, operationId: string, intentInput: Record<string, unknown>, activation: D3V2BoundActivationObject, receiptInput: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const intent = validateIntent(intentInput);
  const receipt = validateReceipt(receiptInput);
  const tuple = asRecord(intent.authorization_tuple, "terminal authorization tuple");
  const paths = operationPaths(frozen.control_root, operationId, frozen.operator_audit_path);
  assertActivationMatchesTuple(activation, tuple, intent, paths);
  assertReceiptMatchesTuple(receipt, tuple, intent, activation, paths);
  if (intent.operation_id !== operationId || activation.operation_id !== operationId || receipt.operation_id !== operationId) fail("R4_TERMINAL", "operation identity differs across terminal objects");
  if (activation.intent_hash !== intent.intent_hash || receipt.intent_hash !== intent.intent_hash || receipt.activation_object_hash !== activation.activation_object_hash) fail("R4_TERMINAL", "intent/activation/receipt hashes do not close");
  const settings = readRegularFileIdentity(frozen.settings_path, "terminal settings", 8 * 1024 * 1024);
  if (settings.identity.raw_sha256 !== frozen.settings_post_raw_sha256 || canonicalizeJcs(settings.identity) !== canonicalizeJcs(receipt.settings_post_identity) || !settingsSemanticallyExact(settings.raw, frozen.desired_settings)) fail("R4_TERMINAL", "terminal settings post differs");
  assertBothSessionBindingsCurrent(frozen);
  const auth = frozen.authorization_transcript_binding;
  verifyRecordedTrustedSessionCoordinate({ sessionsRoot: auth.sessions_root, sessionPath: auth.session_file.path, expectedSessionId: auth.session_id, coordinate: tuple.authorization_coordinate, exactText: D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE });
  const completion = asRecord(receipt.completion_authorization, "terminal completion authorization");
  verifyRecordedTrustedSessionCoordinate({ sessionsRoot: auth.sessions_root, sessionPath: auth.session_file.path, expectedSessionId: auth.session_id, coordinate: completion.coordinate, exactText: completion.kind === "initial_execute" ? D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE : D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE });
  return deepFreeze({ intent_hash: intent.intent_hash, activation_object_hash: activation.activation_object_hash, receipt_hash: receipt.receipt_hash, settings_post_raw_sha256: settings.identity.raw_sha256, exact: true });
}

function validateIntent(value: unknown): Record<string, unknown> {
  const intent = asRecord(value, "R4 intent");
  exactKeys(intent, ["schema_version", "operation_id", "authorization_tuple", "control_paths", "intent_hash"], "R4 intent");
  if (intent.schema_version !== D3_V2_R4_INTENT_SCHEMA) fail("R4_INTENT_INVALID", "intent schema differs");
  assertHash(intent.operation_id, "intent.operation_id"); assertHash(intent.intent_hash, "intent.intent_hash");
  const tuple = asRecord(intent.authorization_tuple, "intent authorization tuple");
  validateAuthorizationTuple(tuple);
  if (intent.operation_id !== jcsSha256Hex(tuple)) fail("R4_OPERATION_ID", "operation_id is not SHA-256(JCS(full authorization tuple))");
  const base = { ...intent }; delete base.intent_hash;
  if (intent.intent_hash !== jcsSha256Hex(base)) fail("R4_INTENT_INVALID", "intent self-hash differs");
  return deepFreeze(intent);
}

function validateAuthorizationTuple(tuple: Record<string, unknown>): void {
  exactKeys(tuple, ["schema_version", "authorization_kind", "authorization_status", "target_session_binding", "authorization_transcript_binding", "d3_identities", "predecessor_dossier", "operator_manifest", "execution_dossier", "settings_path", "settings_pre_identity", "settings_pre_raw_sha256", "settings_post_raw_sha256", "desired_settings", "control_path_derivation", "source_closure_hash", "source_commit", "initial_authorization_contract", "authorization_coordinate", "safety_contract"], "R4 authorization tuple");
  if (tuple.schema_version !== D3_V2_R4_AUTHORIZATION_TUPLE_SCHEMA || tuple.authorization_kind !== "fresh_latest_standalone_role_user_bind_existing_session" || tuple.authorization_status !== "AUTHORIZED") fail("R4_AUTHORIZATION_TUPLE", "authorization tuple identity differs");
  const target = validateTupleSessionBinding(tuple.target_session_binding, "authorization tuple target_session_binding");
  const authorization = validateTupleSessionBinding(tuple.authorization_transcript_binding, "authorization tuple authorization_transcript_binding");
  assertDistinctSessionBindings(target, authorization);
  const coordinate = validateTrustedSessionUserCoordinate(tuple.authorization_coordinate);
  if (coordinate.session_id !== authorization.session_id || coordinate.session_jsonl_path !== authorization.session_file.path
    || coordinate.session_dev !== authorization.session_file.dev || coordinate.session_ino !== authorization.session_file.ino
    || coordinate.transcript_prefix_bytes < authorization.session_file.prefix_bytes
    || (coordinate.transcript_prefix_bytes === authorization.session_file.prefix_bytes && coordinate.transcript_prefix_sha256 !== authorization.session_file.prefix_sha256)) {
    fail("R4_AUTHORIZATION_CROSS_BINDING", "authorization coordinate does not bind the independent authorization transcript identity/prefix");
  }
  for (const field of ["settings_pre_raw_sha256", "settings_post_raw_sha256", "source_closure_hash"] as const) assertHash(tuple[field], `authorization tuple ${field}`);
  if (typeof tuple.source_commit !== "string" || !/^[0-9a-f]{40}$/.test(tuple.source_commit)) fail("R4_AUTHORIZATION_TUPLE", "authorization tuple source_commit must be a Git commit");
  const settingsPath = requireAbsolute(String(tuple.settings_path), "authorization tuple settings_path");
  const settingsPre = validateFileIdentity(tuple.settings_pre_identity, "authorization tuple settings_pre_identity");
  if (tuple.settings_pre_raw_sha256 !== settingsPre.raw_sha256) fail("R4_AUTHORIZATION_TUPLE", "settings_pre raw hash differs from its identity");
  const desired = asRecord(tuple.desired_settings, "authorization tuple desired_settings");
  exactKeys(desired, ["enabled", "selector", "expectedSelectionHash", "expectedHeadHash", "expectedProofHash", "expectedStableBundleHash", "expectedIntentHash", "adapterManifestHash", "r4Binding", "maxReadBytes"], "authorization tuple desired_settings");
  normalizeSettingsMutationClosed(desired, { requireExecutableShape: true });
  const selector = asRecord(desired.selector, "authorization tuple desired selector");
  if (canonicalizeJcs(selector.session_ids) !== canonicalizeJcs([target.session_id])) fail("R4_AUTHORIZATION_CROSS_BINDING", "desired selector does not name only the target session");
  const d3 = asRecord(tuple.d3_identities, "authorization tuple D3") as unknown as D3V2R4D3Identities;
  exactKeys(d3 as unknown as Record<string, unknown>, ["selection_hash", "head_hash", "proof_hash", "intent_hash", "stable_bundle_hash", "p2a_bundle_hash", "generation", "selection_seq"], "authorization tuple D3");
  validateD3Identities(d3);
  validateArtifactIdentity(tuple.predecessor_dossier, "authorization tuple predecessor_dossier");
  validateArtifactIdentity(tuple.execution_dossier, "authorization tuple execution_dossier");
  const operator = asRecord(tuple.operator_manifest, "authorization tuple operator_manifest");
  exactKeys(operator, ["relative_path", "raw_sha256", "manifest_hash", "graph_hash", "source_closure_hash"], "authorization tuple operator_manifest");
  if (typeof operator.relative_path !== "string" || !operator.relative_path || path.isAbsolute(operator.relative_path)) fail("R4_AUTHORIZATION_TUPLE", "operator manifest relative_path is invalid");
  for (const field of ["raw_sha256", "manifest_hash", "graph_hash", "source_closure_hash"] as const) assertHash(operator[field], `operator_manifest.${field}`);
  if (operator.source_closure_hash !== tuple.source_closure_hash) fail("R4_AUTHORIZATION_TUPLE", "operator/source closure hash differs");
  const paths = asRecord(tuple.control_path_derivation, "authorization tuple path derivation");
  exactKeys(paths, ["control_root", "intent", "activation", "receipt", "operator_audit_path", "runtime_audit_path", "old_activation_root", "rollback_target", "quarantine_target"], "authorization tuple path derivation");
  for (const field of ["control_root", "operator_audit_path", "runtime_audit_path", "old_activation_root", "rollback_target", "quarantine_target"] as const) requireAbsolute(String(paths[field]), `path derivation ${field}`);
  if (paths.intent !== "intents/{operation_id}.json" || paths.activation !== "activations/{operation_id}.json" || paths.receipt !== "receipts/{operation_id}.json") fail("R4_AUTHORIZATION_TUPLE", "operation path derivation template differs");
  const controlRoot = String(paths.control_root);
  const rollbackTarget = String(paths.rollback_target);
  if (controlRoot === rollbackTarget || insideEither(controlRoot, rollbackTarget)) fail("R4_CONTROL_ROLLBACK_ALIAS", "control_root and rollback_target must be distinct non-nested roots");
  if (path.resolve(String(paths.operator_audit_path)) !== path.join(controlRoot, "operator-audit.jsonl")) fail("R4_AUTHORIZATION_TUPLE", "operator audit must be the sole control-root audit file");
  if (settingsPath !== path.resolve(String(tuple.settings_path))) fail("R4_AUTHORIZATION_TUPLE", "settings path is not resolved");
  const contract = asRecord(tuple.initial_authorization_contract, "initial authorization contract");
  exactKeys(contract, ["schema_version", "required_phrase_utf8_bytes", "required_phrase_sha256", "exact_latest_standalone_role_user_required", "freshness_maximum_age_ms", "caller_supplied_authorization_payload_forbidden", "machine_binding_generated_by_operator", "contract_hash"], "initial authorization contract");
  if (canonicalizeJcs(contract) !== canonicalizeJcs(authorizationContract("initial"))) fail("R4_AUTHORIZATION_TUPLE", "initial authorization contract differs");
  if (coordinate.text_utf8_bytes !== contract.required_phrase_utf8_bytes || coordinate.text_sha256 !== contract.required_phrase_sha256) fail("R4_AUTHORIZATION_TUPLE", "initial authorization coordinate text does not match its exact contract");
  const safety = asRecord(tuple.safety_contract, "authorization tuple safety_contract");
  exactKeys(safety, ["bind_existing_only", "create_or_rewrite_session", "create_only_objects", "activation_authorized_once_no_flip", "auto_retry", "settings_noncooperative_writer_residual", "rollback_not_pre_authorized"], "authorization tuple safety_contract");
  if (safety.bind_existing_only !== true || safety.create_or_rewrite_session !== false || safety.create_only_objects !== true
    || safety.activation_authorized_once_no_flip !== true || safety.auto_retry !== false || safety.rollback_not_pre_authorized !== true
    || safety.settings_noncooperative_writer_residual !== D3_V2_R4_NONCOOPERATIVE_WRITER_RESIDUAL) fail("R4_AUTHORIZATION_TUPLE", "safety contract differs");
}

function assertActivationMatchesTuple(activation: D3V2BoundActivationObject, tuple: Record<string, unknown>, intent: Record<string, unknown>, paths: ReturnType<typeof operationPaths>): void {
  const targetBinding = validateTupleSessionBinding(tuple.target_session_binding, "activation target session binding");
  const target = targetBinding.session_file;
  const derivation = asRecord(tuple.control_path_derivation, "activation path derivation");
  const desired = asRecord(tuple.desired_settings, "activation desired settings");
  const operatorManifest = asRecord(tuple.operator_manifest, "activation operator manifest");
  const executionDossier = asRecord(tuple.execution_dossier, "activation execution dossier");
  if (activation.schema_version !== D3_V2_SESSION_START_R4_ACTIVATION_OBJECT_SCHEMA
    || activation.operation_id !== intent.operation_id || activation.intent_hash !== intent.intent_hash
    || activation.session_id !== targetBinding.session_id
    || activation.activation_nonce !== sha256Hex(`adr0040-d3-v2-r4-activation\0${String(intent.operation_id)}`)
    || canonicalizeJcs(activation.authorization_coordinate) !== canonicalizeJcs(tuple.authorization_coordinate)
    || canonicalizeJcs(activation.d3_identities) !== canonicalizeJcs(tuple.d3_identities)
    || activation.adapter_manifest_hash !== desired.adapterManifestHash
    || canonicalizeJcs(activation.settings_mutation) !== canonicalizeJcs(normalizeSettingsMutationClosed(desired, { requireExecutableShape: true }))
    || activation.audit_target !== derivation.runtime_audit_path
    || activation.rollback_target !== derivation.rollback_target
    || activation.quarantine_target !== derivation.quarantine_target
    || canonicalizeJcs(activation.session_file) !== canonicalizeJcs(target)
    || activation.operator_manifest_hash !== operatorManifest.manifest_hash
    || activation.execution_dossier_hash !== executionDossier.self_hash
    || activation.settings_pre_raw_sha256 !== tuple.settings_pre_raw_sha256
    || activation.settings_post_raw_sha256 !== tuple.settings_post_raw_sha256
    || activation.source_closure_hash !== tuple.source_closure_hash
    || paths.activation !== path.join(String(derivation.control_root), "activations", `${String(intent.operation_id)}.json`)) {
    fail("R4_ACTIVATION_INVALID", "activation does not exactly close the authorization tuple");
  }
  if (canonicalizeJcs(intent.control_paths) !== canonicalizeJcs(paths)) fail("R4_INTENT_INVALID", "intent resolved control paths differ from operation derivation");
}

function assertReceiptMatchesTuple(receipt: Record<string, unknown>, tuple: Record<string, unknown>, intent: Record<string, unknown>, activation: D3V2BoundActivationObject, paths: ReturnType<typeof operationPaths>): void {
  const target = validateTupleSessionBinding(tuple.target_session_binding, "receipt target session binding");
  const authorization = validateTupleSessionBinding(tuple.authorization_transcript_binding, "receipt authorization transcript binding");
  const desired = asRecord(tuple.desired_settings, "receipt desired settings");
  const operatorManifest = asRecord(tuple.operator_manifest, "receipt operator manifest");
  const initial = validateTrustedSessionUserCoordinate(tuple.authorization_coordinate);
  if (receipt.operation_id !== intent.operation_id || receipt.intent_hash !== intent.intent_hash
    || receipt.activation_object_hash !== activation.activation_object_hash
    || receipt.settings_pre_raw_sha256 !== tuple.settings_pre_raw_sha256
    || receipt.settings_post_raw_sha256 !== tuple.settings_post_raw_sha256
    || canonicalizeJcs(receipt.target_session_binding) !== canonicalizeJcs(target)
    || canonicalizeJcs(receipt.authorization_transcript_binding) !== canonicalizeJcs(authorization)
    || canonicalizeJcs(receipt.d3_identities) !== canonicalizeJcs(tuple.d3_identities)
    || receipt.adapter_manifest_hash !== desired.adapterManifestHash
    || receipt.operator_manifest_hash !== operatorManifest.manifest_hash
    || canonicalizeJcs(receipt.predecessor_dossier) !== canonicalizeJcs(tuple.predecessor_dossier)
    || canonicalizeJcs(receipt.execution_dossier) !== canonicalizeJcs(tuple.execution_dossier)
    || receipt.source_closure_hash !== tuple.source_closure_hash
    || receipt.initial_authorization_coordinate_hash !== initial.coordinate_hash
    || canonicalizeJcs(receipt.control_paths) !== canonicalizeJcs(paths)) {
    fail("R4_RECEIPT_INVALID", "receipt does not exactly close the authorization tuple and activation");
  }
  assertCompletionAuthorizationMatchesTuple(receipt, initial, authorization);
}

function assertCompletionAuthorizationMatchesTuple(
  receipt: Record<string, unknown>,
  initial: TrustedSessionUserCoordinate,
  authorization: D3V2R4SessionBinding,
): void {
  const completion = asRecord(receipt.completion_authorization, "receipt completion authorization");
  const coordinate = validateTrustedSessionUserCoordinate(completion.coordinate);
  if (completion.kind === "initial_execute") {
    if (canonicalizeJcs(coordinate) !== canonicalizeJcs(initial)) fail("R4_RECEIPT_INVALID", "initial execute receipt coordinate differs from initial authorization");
    return;
  }
  if (completion.kind !== "fresh_continue") fail("R4_RECEIPT_INVALID", "receipt completion kind differs");
  const contract = authorizationContract("continue");
  const initialMs = Date.parse(initial.timestamp);
  const completionMs = Date.parse(coordinate.timestamp);
  if (coordinate.session_id !== authorization.session_id || coordinate.session_jsonl_path !== authorization.session_file.path
    || coordinate.session_dev !== authorization.session_file.dev || coordinate.session_ino !== authorization.session_file.ino
    || coordinate.message_line_number <= initial.message_line_number
    || coordinate.transcript_prefix_bytes <= initial.transcript_prefix_bytes
    || !Number.isFinite(initialMs) || !Number.isFinite(completionMs) || completionMs <= initialMs
    || coordinate.text_utf8_bytes !== contract.required_phrase_utf8_bytes
    || coordinate.text_sha256 !== contract.required_phrase_sha256) {
    fail("R4_RECEIPT_INVALID", "fresh continue receipt coordinate does not bind a later exact authorization-transcript coordinate");
  }
}

function validateReceipt(value: unknown): Record<string, unknown> {
  const receipt = asRecord(value, "R4 receipt");
  exactKeys(receipt, ["schema_version", "operation_id", "intent_hash", "activation_object_hash", "settings_pre_raw_sha256", "settings_post_raw_sha256", "settings_post_identity", "target_session_binding", "authorization_transcript_binding", "d3_identities", "adapter_manifest_hash", "operator_manifest_hash", "predecessor_dossier", "execution_dossier", "source_closure_hash", "initial_authorization_coordinate_hash", "completion_authorization", "control_paths", "durable_object_not_message", "exactly_once", "runtime_audit_required_later", "receipt_hash"], "R4 receipt");
  if (receipt.schema_version !== D3_V2_R4_RECEIPT_SCHEMA || receipt.durable_object_not_message !== true || receipt.exactly_once !== true || receipt.runtime_audit_required_later !== true) fail("R4_RECEIPT_INVALID", "receipt identity flags differ");
  for (const field of ["operation_id", "intent_hash", "activation_object_hash", "settings_pre_raw_sha256", "settings_post_raw_sha256", "adapter_manifest_hash", "operator_manifest_hash", "source_closure_hash", "initial_authorization_coordinate_hash", "receipt_hash"] as const) assertHash(receipt[field], `receipt.${field}`);
  validateFileIdentity(receipt.settings_post_identity, "receipt settings_post_identity");
  validateTupleSessionBinding(receipt.target_session_binding, "receipt target_session_binding");
  validateTupleSessionBinding(receipt.authorization_transcript_binding, "receipt authorization_transcript_binding");
  validateArtifactIdentity(receipt.predecessor_dossier, "receipt predecessor_dossier");
  validateArtifactIdentity(receipt.execution_dossier, "receipt execution_dossier");
  const completion = asRecord(receipt.completion_authorization, "receipt completion authorization");
  exactKeys(completion, ["kind", "coordinate", "coordinate_hash"], "receipt completion authorization");
  const coordinate = validateTrustedSessionUserCoordinate(completion.coordinate);
  if ((completion.kind !== "initial_execute" && completion.kind !== "fresh_continue") || completion.coordinate_hash !== coordinate.coordinate_hash) fail("R4_RECEIPT_INVALID", "completion authorization differs");
  const base = { ...receipt }; delete base.receipt_hash;
  if (receipt.receipt_hash !== jcsSha256Hex(base)) fail("R4_RECEIPT_INVALID", "receipt self-hash differs");
  return deepFreeze(receipt);
}

function loadActivation(file: string, operationId: string, intentHash: string): D3V2BoundActivationObject {
  const loaded = readCanonicalObject(file, "R4 activation");
  const activation = validateBoundActivationObjectClosed(loaded);
  if (activation.schema_version !== D3_V2_SESSION_START_R4_ACTIVATION_OBJECT_SCHEMA || activation.operation_id !== operationId || activation.intent_hash !== intentHash) fail("R4_ACTIVATION_INVALID", "R4 activation operation/intent binding differs");
  return activation;
}
function loadReceipt(file: string, operationId: string, intentHash: string, activationHash: string): Record<string, unknown> {
  const receipt = validateReceipt(readCanonicalObject(file, "R4 receipt"));
  if (receipt.operation_id !== operationId || receipt.intent_hash !== intentHash || receipt.activation_object_hash !== activationHash) fail("R4_RECEIPT_INVALID", "receipt operation/hash binding differs");
  return receipt;
}

function loadSoleOperation(controlRoot: string): { operationId: string; intent: Record<string, unknown> } {
  assertExactControlRootShape(controlRoot, { requireReceipt: false });
  const names = exactJsonNames(path.join(controlRoot, "intents"), "R4 intents");
  if (names.length !== 1) fail("R4_FOREIGN_OR_PENDING", "R4 control root must contain exactly one intent object");
  const operationId = names[0]!.slice(0, -5);
  assertHash(operationId, "operation filename");
  const intent = readCanonicalObject(path.join(controlRoot, "intents", names[0]!), "R4 intent");
  const activationNames = exactJsonNames(path.join(controlRoot, "activations"), "R4 activations");
  const receiptNames = exactJsonNames(path.join(controlRoot, "receipts"), "R4 receipts");
  if (canonicalizeJcs(activationNames) !== canonicalizeJcs([`${operationId}.json`])) fail("R4_FOREIGN_OR_PENDING", "activation directory is missing exact operation or contains foreign objects");
  if (receiptNames.length > 1 || (receiptNames.length === 1 && receiptNames[0] !== `${operationId}.json`)) fail("R4_FOREIGN_OR_PENDING", "receipt directory contains a foreign object");
  return { operationId, intent };
}

function discoverSoleOperationCandidate(controlRoot: string): {
  operationId: string;
  intent: Record<string, unknown>;
  activation: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
} {
  assertExactControlRootShape(controlRoot, { requireReceipt: false });
  const inventory = (["intent", "activation", "receipt"] as const).map((kind) => {
    const directoryName = kind === "intent" ? "intents" : kind === "activation" ? "activations" : "receipts";
    const directory = path.join(controlRoot, directoryName);
    const entries = fs.readdirSync(directory).sort();
    const parsed = entries.map((name) => {
      const finalMatch = /^([0-9a-f]{64})\.json$/.exec(name);
      const pendingMatch = /^\.([0-9a-f]{64})\.(intent|activation|receipt)\.pending$/.exec(name);
      if (finalMatch) return { name, operationId: finalMatch[1]!, pending: false };
      if (pendingMatch && pendingMatch[2] === kind) return { name, operationId: pendingMatch[1]!, pending: true };
      fail("R4_FOREIGN_OR_PENDING", `${directoryName} contains a foreign target/temp`, { name });
    });
    if (parsed.length > 2) fail("R4_FOREIGN_OR_PENDING", `${directoryName} contains multiple target/pending entries`);
    return { kind, directory, parsed };
  });
  const operationIds = new Set(inventory.flatMap((row) => row.parsed.map((item) => item.operationId)));
  if (operationIds.size !== 1) fail("R4_FOREIGN_OR_PENDING", "continue requires exactly one operation identity across final/pending objects");
  const operationId = [...operationIds][0]!;
  assertHash(operationId, "continue operation identity");
  const readKind = (kind: RetainedCreateOnlyKind): Record<string, unknown> | null => {
    const row = inventory.find((item) => item.kind === kind)!;
    const same = row.parsed.filter((item) => item.operationId === operationId);
    if (same.length === 0) return null;
    const preferred = same.find((item) => !item.pending) ?? same[0]!;
    return readCanonicalCandidate(path.join(row.directory, preferred.name), `R4 ${kind} continue candidate`);
  };
  const intent = readKind("intent");
  if (!intent) fail("R4_FOREIGN_OR_PENDING", "continue requires an exact intent final or deterministic pending");
  return { operationId, intent, activation: readKind("activation"), receipt: readKind("receipt") };
}

function readCanonicalCandidate(file: string, label: string): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.nlink !== 1 && stat.nlink !== 2)) fail("R4_FOREIGN_OR_PENDING", `${label} metadata is unsafe`);
  const read = readExactRetainedFile(file, { label, maxBytes: MAX_OBJECT_BYTES, expectedMode: 0o600, expectedNlink: stat.nlink, expectedUid: stat.uid, expectedGid: stat.gid });
  const value = asRecord(parseStrict(read.raw, label), label);
  if (`${canonicalizeJcs(value)}\n` !== read.raw.toString("utf8")) fail("R4_OBJECT_NONCANONICAL", `${label} is not exact RFC8785-JCS plus LF`);
  return value;
}

function publishR4Object(
  file: string,
  value: unknown,
  kind: RetainedCreateOnlyKind,
  operationId: string,
  label: string,
  hooks?: D3V2R4TestHooks,
): void {
  const crashPoint = hooks?.createOnlyCrash?.kind === kind ? hooks.createOnlyCrash.point : undefined;
  publishCreateOnlyRetained(file, `${canonicalizeJcs(value)}\n`, label, { operationId, kind, ...(crashPoint ? { crashPoint } : {}) });
}

function operationPaths(controlRoot: string, operationId: string, operatorAuditPath: string) {
  assertHash(operationId, "operationId");
  return deepFreeze({
    intent: path.join(path.resolve(controlRoot), "intents", `${operationId}.json`),
    activation: path.join(path.resolve(controlRoot), "activations", `${operationId}.json`),
    receipt: path.join(path.resolve(controlRoot), "receipts", `${operationId}.json`),
    operator_audit: path.resolve(operatorAuditPath),
  });
}

function ensureR4ControlDirectories(controlRoot: string): void {
  ensureDirectoryChainNoSymlink(controlRoot, "R4 control root");
  for (const name of ["intents", "activations", "receipts"]) ensureDirectoryChainNoSymlink(path.join(controlRoot, name), `R4 ${name}`);
  assertExactControlRootShape(controlRoot, { requireReceipt: false, allowEmpty: true });
}
function assertCreateTargetsAbsent(paths: ReturnType<typeof operationPaths>): void {
  const operationId = path.basename(paths.intent, ".json");
  for (const [kind, file] of [["intent", paths.intent], ["activation", paths.activation], ["receipt", paths.receipt]] as const) {
    const pending = path.join(path.dirname(file), createOnlyPendingBasename(operationId, kind));
    if (fileExistsNoFollow(file) || fileExistsNoFollow(pending)) fail("R4_CREATE_ONLY_COLLISION", `create-only target or deterministic pending already exists: ${file}`);
    if (fs.readdirSync(path.dirname(file)).length !== 0) fail("R4_CONTROL_FOREIGN", `fresh execute refuses foreign entries in ${path.dirname(file)}`);
  }
}
function assertControlRootFreshOrAbsent(controlRoot: string): void {
  const stat = lstatMaybe(controlRoot);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("R4_CONTROL_FOREIGN", "R4 control root is unsafe");
  const entries = fs.readdirSync(controlRoot);
  if (entries.length !== 0) fail("R4_CONTROL_FOREIGN", "fresh execute refuses any existing R4 control entry");
}
function assertExactControlRootShape(controlRoot: string, options: { requireReceipt: boolean; allowEmpty?: boolean }): void {
  const stat = fs.lstatSync(controlRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(controlRoot) !== path.resolve(controlRoot)) fail("R4_CONTROL_FOREIGN", "R4 control root is not an exact directory");
  const entries = fs.readdirSync(controlRoot).sort();
  const expected = ["activations", "intents", "receipts"];
  if (options.allowEmpty && entries.length === 0) return;
  const authorityEntries = entries.filter((name) => name !== "operator-audit.jsonl");
  if (canonicalizeJcs(authorityEntries) !== canonicalizeJcs(expected)) fail("R4_CONTROL_FOREIGN", "R4 control root authority entries differ");
  if (entries.includes("operator-audit.jsonl")) {
    const audit = fs.lstatSync(path.join(controlRoot, "operator-audit.jsonl"));
    if (audit.isSymbolicLink() || !audit.isFile()) fail("R4_CONTROL_FOREIGN", "operator audit is unsafe");
  }
  for (const name of expected) {
    const child = fs.lstatSync(path.join(controlRoot, name));
    if (child.isSymbolicLink() || !child.isDirectory()) fail("R4_CONTROL_FOREIGN", `R4 ${name} is unsafe`);
  }
  void options.requireReceipt;
}
function exactJsonNames(directory: string, label: string): string[] {
  const names = fs.readdirSync(directory).sort();
  for (const name of names) if (!/^[0-9a-f]{64}\.json$/.test(name)) fail("R4_FOREIGN_OR_PENDING", `${label} contains a foreign entry`, { name });
  return names;
}

function settingsSemanticallyExact(raw: Buffer, desired: Readonly<Record<string, unknown>>): boolean {
  try {
    const root = asRecord(parseStrict(raw, "settings exact"), "settings exact");
    const rule = asRecord(root.ruleInjector, "settings exact ruleInjector");
    return canonicalizeJcs(rule[D3_V2_R4_SETTINGS_KEY]) === canonicalizeJcs(desired);
  } catch { return false; }
}
function runtimeDesiredSettings(settings: D3V2SessionStartInjectionSettings): Record<string, unknown> {
  if (!settings.r4Binding) fail("R4_RUNTIME_SETTINGS", "R4 binding absent");
  return {
    enabled: settings.enabled,
    selector: { session_ids: [...settings.selector.session_ids] },
    expectedSelectionHash: settings.expectedSelectionHash,
    expectedHeadHash: settings.expectedHeadHash,
    expectedProofHash: settings.expectedProofHash,
    expectedStableBundleHash: settings.expectedStableBundleHash,
    expectedIntentHash: settings.expectedIntentHash,
    adapterManifestHash: settings.adapterManifestHash,
    r4Binding: settings.r4Binding,
    maxReadBytes: settings.maxReadBytes,
  };
}

function assertNoSelectorConflict(settings: Record<string, unknown>, sessionId: string, prestate: boolean): void {
  const rule = asRecord(settings.ruleInjector, "settings.ruleInjector");
  const v1 = recordOptional(rule.propositionPolicyStableViewInjection);
  const v1Ids = recordOptional(v1?.selector)?.session_ids;
  if (Array.isArray(v1Ids) && v1Ids.includes(sessionId)) fail("R4_SELECTOR_CONFLICT", "target session already exists in v1 selector");
  const v2 = recordOptional(rule[D3_V2_R4_SETTINGS_KEY]);
  const v2Ids = recordOptional(v2?.selector)?.session_ids;
  if (prestate && Array.isArray(v2Ids) && v2Ids.includes(sessionId)) fail("R4_SELECTOR_CONFLICT", "target session already exists in v2 selector prestate");
  if (!prestate && (!Array.isArray(v2Ids) || canonicalizeJcs(v2Ids) !== canonicalizeJcs([sessionId]))) fail("R4_SELECTOR_CONFLICT", "runtime v2 selector is not the exact target session");
}

function assertSessionBindingCurrent(binding: D3V2R4SessionBinding["session_file"], sessionsRoot: string, sessionId: string): void {
  assertSafeSessionIdComponent(sessionId);
  const current = captureTrustedSessionPrefixBinding({ sessionsRoot, sessionPath: binding.path, expectedSessionId: sessionId, prefixBytes: binding.prefix_bytes });
  if (canonicalizeJcs(current) !== canonicalizeJcs(binding)) fail("R4_SESSION_BINDING", "trusted persisted session frozen prefix binding differs");
  const resolved = path.resolve(binding.path);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== binding.dev || stat.ino !== binding.ino || stat.size < binding.prefix_bytes) fail("R4_SESSION_BINDING", "target persisted session identity/prefix size differs");
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== binding.dev || before.ino !== binding.ino || before.size < binding.prefix_bytes) fail("R4_SESSION_BINDING", "opened persisted session identity differs");
    const buffer = Buffer.alloc(binding.prefix_bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) fail("R4_SESSION_BINDING", "target persisted session prefix read made no progress");
      offset += read;
    }
    const after = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(resolved);
    if (after.dev !== binding.dev || after.ino !== binding.ino || after.size < binding.prefix_bytes
      || namedAfter.isSymbolicLink() || namedAfter.dev !== binding.dev || namedAfter.ino !== binding.ino
      || sha256Hex(buffer) !== binding.prefix_sha256) fail("R4_SESSION_BINDING", "target persisted session identity/prefix differs after read");
  } finally { fs.closeSync(fd); }
}

function validateTupleSessionBinding(value: unknown, label: string): D3V2R4SessionBinding {
  const binding = asRecord(value, label);
  exactKeys(binding, ["session_id", "sessions_root", "session_file"], label);
  assertSafeSessionIdComponent(binding.session_id, `${label}.session_id`);
  const sessionsRoot = requireAbsolute(String(binding.sessions_root), `${label}.sessions_root`);
  const sessionFile = asRecord(binding.session_file, `${label}.session_file`);
  exactKeys(sessionFile, ["path", "dev", "ino", "prefix_bytes", "prefix_sha256"], `${label}.session_file`);
  const filePath = requireAbsolute(String(sessionFile.path), `${label}.session_file.path`);
  const relative = path.relative(sessionsRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("R4_SESSION_BINDING", `${label} file is outside sessions_root`);
  for (const field of ["dev", "ino", "prefix_bytes"] as const) if (!Number.isSafeInteger(sessionFile[field]) || Number(sessionFile[field]) < 1) fail("R4_SESSION_BINDING", `${label}.session_file.${field} is invalid`);
  assertHash(sessionFile.prefix_sha256, `${label}.session_file.prefix_sha256`);
  return deepFreeze({
    session_id: String(binding.session_id),
    sessions_root: sessionsRoot,
    session_file: deepFreeze({ path: filePath, dev: Number(sessionFile.dev), ino: Number(sessionFile.ino), prefix_bytes: Number(sessionFile.prefix_bytes), prefix_sha256: String(sessionFile.prefix_sha256) }),
  });
}

function validateFileIdentity(value: unknown, label: string): D3V2R4FileIdentity {
  const identity = asRecord(value, label);
  exactKeys(identity, ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtime_ms", "ctime_ms", "raw_sha256"], label);
  for (const field of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtime_ms", "ctime_ms"] as const) {
    if (typeof identity[field] !== "number" || !Number.isFinite(identity[field]) || Number(identity[field]) < 0) fail("R4_FILE_IDENTITY", `${label}.${field} is invalid`);
  }
  assertHash(identity.raw_sha256, `${label}.raw_sha256`);
  return identity as unknown as D3V2R4FileIdentity;
}

function validateArtifactIdentity(value: unknown, label: string): D3V2R4ArtifactIdentity {
  const artifact = asRecord(value, label);
  exactKeys(artifact, ["relative_path", "raw_sha256", "self_hash"], label);
  if (typeof artifact.relative_path !== "string" || !artifact.relative_path || path.isAbsolute(artifact.relative_path)) fail("R4_ARTIFACT_IDENTITY", `${label}.relative_path is invalid`);
  assertHash(artifact.raw_sha256, `${label}.raw_sha256`);
  assertHash(artifact.self_hash, `${label}.self_hash`);
  return artifact as unknown as D3V2R4ArtifactIdentity;
}

function assertDistinctSessionBindings(target: D3V2R4SessionBinding, authorization: D3V2R4SessionBinding): void {
  if (target.session_id === authorization.session_id || target.session_file.path === authorization.session_file.path
    || (target.session_file.dev === authorization.session_file.dev && target.session_file.ino === authorization.session_file.ino)) {
    fail("R4_SESSION_BINDINGS_NOT_DISTINCT", "target and authorization transcript bindings must identify two distinct persisted sessions");
  }
}

function assertBothSessionBindingsCurrent(frozen: D3V2R4FrozenBinding): void {
  const target = validateTupleSessionBinding(frozen.target_session_binding, "target_session_binding");
  const authorization = validateTupleSessionBinding(frozen.authorization_transcript_binding, "authorization_transcript_binding");
  assertDistinctSessionBindings(target, authorization);
  assertSessionBindingCurrent(target.session_file, target.sessions_root, target.session_id);
  assertSessionBindingCurrent(authorization.session_file, authorization.sessions_root, authorization.session_id);
}

function verifyBothSessionBindingsImmediatelyBeforeMutation(frozen: D3V2R4FrozenBinding, coordinate: TrustedSessionUserCoordinate, exactText: string, nowMs?: number): void {
  assertBothSessionBindingsCurrent(frozen);
  const authorization = frozen.authorization_transcript_binding;
  const fresh = verifyFreshLatestStandaloneUserAuthorization({ sessionsRoot: authorization.sessions_root, sessionPath: authorization.session_file.path, expectedSessionId: authorization.session_id, exactText, maximumAgeMs: D3_V2_R4_AUTHORIZATION_MAXIMUM_AGE_MS, nowMs });
  if (canonicalizeJcs(fresh) !== canonicalizeJcs(coordinate)) fail("R4_AUTHORIZATION_TOCTOU", "latest exact authorization coordinate changed before mutation");
}

function insideEither(leftInput: string, rightInput: string): boolean {
  const left = path.resolve(leftInput);
  const right = path.resolve(rightInput);
  const leftRelative = path.relative(left, right);
  const rightRelative = path.relative(right, left);
  return (leftRelative !== "" && !leftRelative.startsWith("..") && !path.isAbsolute(leftRelative))
    || (rightRelative !== "" && !rightRelative.startsWith("..") && !path.isAbsolute(rightRelative));
}

function readRegularFileIdentity(file: string, label: string, maxBytes: number): { raw: Buffer; identity: D3V2R4FileIdentity } {
  const resolved = path.resolve(file);
  assertExistingNoSymlinkAncestors(resolved, label);
  const named = fs.lstatSync(resolved);
  if (named.isSymbolicLink() || !named.isFile() || named.size > maxBytes) fail("R4_FILE_UNSAFE", `${label} is not an exact bounded regular file`);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const namedAfter = fs.lstatSync(resolved);
    if (!sameStat(before, after) || !sameStat(after, namedAfter) || raw.length !== before.size) fail("R4_FILE_RACE", `${label} changed while read`);
    return { raw, identity: withRawIdentity(statIdentity(before), raw) };
  } finally { fs.closeSync(fd); }
}
function readCanonicalObject(file: string, label: string): Record<string, unknown> {
  const read = readExactRetainedFile(file, { label, maxBytes: MAX_OBJECT_BYTES, expectedMode: 0o600, expectedNlink: 1 });
  const raw = read.raw.toString("utf8");
  const value = asRecord(parseStrict(read.raw, label), label);
  if (`${canonicalizeJcs(value)}\n` !== raw) fail("R4_OBJECT_NONCANONICAL", `${label} is not exact RFC8785-JCS plus LF`);
  return value;
}

function assertSettingsPreMatchesFrozen(pre: ReturnType<typeof captureD3V2R4SettingsPrestate>, frozen: D3V2R4FrozenBinding): void {
  if (canonicalizeJcs(pre.identity) !== canonicalizeJcs(frozen.settings_pre)) fail("R4_SETTINGS_PRESTATE", "settings exact pre identity/raw differs from frozen dossier");
  if (sha256Hex(renderD3V2R4SettingsPost(pre.parsed, frozen.desired_settings)) !== frozen.settings_post_raw_sha256) fail("R4_SETTINGS_PRESTATE", "settings exact post raw hash differs from frozen dossier");
}
function sameExactFileIdentityExcludingRawHash(left: D3V2R4FileIdentity, right: D3V2R4FileIdentity): boolean {
  const leftIdentity = { ...left } as Record<string, unknown>;
  const rightIdentity = { ...right } as Record<string, unknown>;
  delete leftIdentity.raw_sha256;
  delete rightIdentity.raw_sha256;
  return canonicalizeJcs(leftIdentity) === canonicalizeJcs(rightIdentity);
}
function withRawIdentity(identity: Readonly<Record<string, number>>, raw: Buffer): D3V2R4FileIdentity { return { dev: Number(identity.dev), ino: Number(identity.ino), mode: Number(identity.mode), uid: Number(identity.uid), gid: Number(identity.gid), nlink: Number(identity.nlink), size: Number(identity.size), mtime_ms: Number(identity.mtime_ms), ctime_ms: Number(identity.ctime_ms), raw_sha256: sha256Hex(raw) }; }
function statIdentity(stat: fs.Stats): Record<string, number> { return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs }; }

function validateFrozenBinding(frozen: D3V2R4FrozenBinding): void {
  exactKeys(frozen as unknown as Record<string, unknown>, ["schema_version", "target_session_binding", "authorization_transcript_binding", "settings_path", "settings_pre", "settings_post_raw_sha256", "desired_settings", "control_root", "old_activation_root", "runtime_audit_path", "operator_audit_path", "rollback_target", "quarantine_target", "d3_identities", "adapter_manifest_hash", "operator_manifest", "predecessor_dossier", "execution_dossier", "source_commit", "source_commit_required_at_production_authorization"], "R4 frozen binding");
  if (frozen.schema_version !== "adr0040-d3-v2-session-start-r4-frozen-execution-binding/v2" || frozen.source_commit_required_at_production_authorization !== true) fail("R4_FROZEN_BINDING", "frozen binding schema/commit policy differs");
  const target = validateTupleSessionBinding(frozen.target_session_binding, "frozen target_session_binding");
  const authorization = validateTupleSessionBinding(frozen.authorization_transcript_binding, "frozen authorization_transcript_binding");
  assertDistinctSessionBindings(target, authorization);
  for (const item of [frozen.settings_path, frozen.control_root, frozen.old_activation_root, frozen.runtime_audit_path, frozen.operator_audit_path, frozen.rollback_target, frozen.quarantine_target]) requireAbsolute(item, "frozen path");
  if (frozen.control_root === frozen.rollback_target || insideEither(frozen.control_root, frozen.rollback_target)) fail("R4_CONTROL_ROLLBACK_ALIAS", "frozen control and rollback roots must be distinct and non-nested");
  if (frozen.operator_audit_path !== path.join(frozen.control_root, "operator-audit.jsonl")) fail("R4_FROZEN_BINDING", "operator audit is not the exact control-root audit file");
  validateFileIdentity(frozen.settings_pre, "frozen settings_pre");
  validateD3Identities(frozen.d3_identities);
  validateArtifactIdentity(frozen.predecessor_dossier, "frozen predecessor_dossier");
  validateArtifactIdentity(frozen.execution_dossier, "frozen execution_dossier");
  for (const hash of [frozen.settings_post_raw_sha256, frozen.adapter_manifest_hash, frozen.operator_manifest.raw_sha256, frozen.operator_manifest.manifest_hash, frozen.operator_manifest.graph_hash, frozen.operator_manifest.source_closure_hash]) assertHash(hash, "frozen hash");
  if (frozen.source_commit !== null && !/^[0-9a-f]{40}$/.test(frozen.source_commit)) fail("R4_FROZEN_BINDING", "frozen source_commit is invalid");
}
function assertTupleMatchesFrozen(tuple: Record<string, unknown>, frozen: D3V2R4FrozenBinding, sourceCommit: string): void {
  validateAuthorizationTuple(tuple);
  const coordinate = validateTrustedSessionUserCoordinate(tuple.authorization_coordinate);
  const expected = buildAuthorizationTuple(frozen, coordinate, sourceCommit);
  if (canonicalizeJcs(tuple) !== canonicalizeJcs(expected)) fail("R4_AUTHORIZATION_TUPLE", "existing authorization tuple differs from the complete frozen binding");
}
function validateD3Identities(d3: D3V2R4D3Identities): void { for (const field of ["selection_hash", "head_hash", "proof_hash", "intent_hash", "stable_bundle_hash", "p2a_bundle_hash"] as const) assertHash(d3[field], `d3.${field}`); if (!Number.isSafeInteger(d3.generation) || d3.generation < 0 || !Number.isSafeInteger(d3.selection_seq) || d3.selection_seq < 0) fail("R4_D3", "D3 generation/selection_seq invalid"); }

function assertSandboxEnvironment(frozen: D3V2R4FrozenBinding): void {
  const hardRoots = listD3V2SessionStartHardProductionRoots();
  const target = frozen.target_session_binding;
  const auth = frozen.authorization_transcript_binding;
  for (const candidate of [target.sessions_root, target.session_file.path, auth.sessions_root, auth.session_file.path, frozen.settings_path, frozen.control_root, frozen.old_activation_root, frozen.runtime_audit_path, frozen.operator_audit_path, frozen.rollback_target, frozen.quarantine_target]) {
    const resolved = path.resolve(candidate);
    if (hardRoots.some((root) => resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep))) fail("R4_SANDBOX_PRODUCTION_PATH", `sandbox refuses production hard path ${resolved}`);
  }
}
function assertProductionEnvironment(frozen: D3V2R4FrozenBinding): void {
  const target = frozen.target_session_binding;
  const auth = frozen.authorization_transcript_binding;
  if (target.session_id !== D3_V2_R4_PRODUCTION_TARGET_SESSION_ID || target.sessions_root !== D3_V2_R4_PRODUCTION_TARGET_SESSIONS_ROOT || target.session_file.path !== D3_V2_R4_PRODUCTION_TARGET_SESSION_PATH) fail("R4_PRODUCTION_PATH", "production target session binding differs from fixed target");
  if (auth.session_id !== D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_ID || auth.sessions_root !== D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSIONS_ROOT || auth.session_file.path !== D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH) fail("R4_PRODUCTION_PATH", "production authorization transcript binding differs from fixed source");
  const expected = productionPathBinding();
  for (const [key, value] of Object.entries(expected)) if ((frozen as unknown as Record<string, unknown>)[key] !== value) fail("R4_PRODUCTION_PATH", `production frozen ${key} differs from fixed path`);
}
function productionPathBinding(): Record<string, string> { return { settings_path: D3_V2_R4_PRODUCTION_SETTINGS_PATH, control_root: D3_V2_R4_PRODUCTION_CONTROL_ROOT, old_activation_root: D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT, runtime_audit_path: D3_V2_R4_PRODUCTION_RUNTIME_AUDIT, operator_audit_path: D3_V2_R4_PRODUCTION_OPERATOR_AUDIT, rollback_target: D3_V2_R4_PRODUCTION_ROLLBACK_ROOT, quarantine_target: D3_V2_R4_PRODUCTION_QUARANTINE_TARGET }; }

export function assertR4PlatformBoundary(platform = process.platform, procPath = "/proc/self/fd"): void {
  if (platform !== "linux") fail("R4_PROCFD_UNAVAILABLE", `R4 requires Linux retained parent-FD paths; platform=${platform}`);
  try { if (!fs.lstatSync(procPath).isDirectory()) fail("R4_PROCFD_UNAVAILABLE", `${procPath} is not a directory`); }
  catch (error) { if (error instanceof D3V2R4Error) throw error; fail("R4_PROCFD_UNAVAILABLE", `R4 requires accessible ${procPath}`); }
}

export function inspectD3V2R4SourceCommitClosure(
  repoRootInput: string,
  expected?: Readonly<{ manifest_hash: string; graph_hash: string; source_closure_hash: string }>,
): Readonly<Record<string, unknown>> {
  const repoRoot = path.resolve(repoRootInput);
  const manifest = buildD3V2R4OperatorManifest(repoRoot);
  validateD3V2R4OperatorManifest(manifest);
  const rev = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const commit = rev.status === 0 ? rev.stdout.trim() : null;
  const manifestMatchesExpected = !expected || (manifest.manifest_hash === expected.manifest_hash
    && manifest.graph.graph_hash === expected.graph_hash && manifest.source_closure_hash === expected.source_closure_hash);
  const paths = [...new Set([...manifest.critical_required_paths, ...manifest.graph.files.map((row) => row.path)])].sort(compare);
  const graphByPath = new Map(manifest.graph.files.map((row) => [row.path, row]));
  const rows = paths.map((relativePath) => {
    const livePath = path.join(repoRoot, ...relativePath.split("/"));
    const liveStat = lstatMaybe(livePath);
    const liveSafe = Boolean(liveStat?.isFile() && !liveStat.isSymbolicLink() && fs.realpathSync.native(livePath) === livePath);
    const liveRaw = liveSafe ? fs.readFileSync(livePath) : null;
    const head = gitBuffer(repoRoot, ["cat-file", "blob", `HEAD:${relativePath}`]);
    const ignored = gitText(repoRoot, ["check-ignore", "--no-index", "-q", "--", relativePath]).status === 0;
    const graphRow = graphByPath.get(relativePath);
    const headPresent = head.status === 0;
    const headRaw = headPresent ? head.stdout : null;
    const graphExact = Boolean(graphRow && liveRaw && graphRow.bytes === liveRaw.length && graphRow.sha256 === sha256Hex(liveRaw));
    const liveEqualsHead = Boolean(liveRaw && headRaw && liveRaw.equals(headRaw));
    return deepFreeze({
      path: relativePath,
      critical: manifest.critical_required_paths.includes(relativePath),
      graph_member: Boolean(graphRow),
      live_safe_regular: liveSafe,
      head_blob_present: headPresent,
      ignored,
      graph_exact: graphExact,
      live_equals_head_blob: liveEqualsHead,
      live_sha256: liveRaw ? sha256Hex(liveRaw) : null,
      head_blob_sha256: headRaw ? sha256Hex(headRaw) : null,
    });
  });
  const status = gitText(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const sourceFilesExactAtHead = /^[0-9a-f]{40}$/.test(commit ?? "") && manifestMatchesExpected
    && rows.every((row) => row.live_safe_regular === true && row.head_blob_present === true && row.ignored === false && row.graph_exact === true && row.live_equals_head_blob === true);
  const base = {
    schema_version: "adr0040-d3-v2-session-start-r4-source-commit-closure/v1",
    commit,
    manifest_hash: manifest.manifest_hash,
    graph_hash: manifest.graph.graph_hash,
    source_closure_hash: manifest.source_closure_hash,
    manifest_matches_expected: manifestMatchesExpected,
    rows,
    row_count: rows.length,
    source_files_exact_at_head: sourceFilesExactAtHead,
    repository_clean_informational_only: status.status === 0 && status.stdout === "",
    git_optional_locks: "0",
  };
  return deepFreeze({ ...base, closure_hash: jcsSha256Hex(base) });
}

function requireSourceCommit(target: "sandbox" | "production", frozen: D3V2R4FrozenBinding): string {
  if (target === "sandbox") return frozen.source_commit ?? "0".repeat(40);
  const report = inspectD3V2R4SourceCommitClosure(path.resolve(__dirname, "../.."), frozen.operator_manifest);
  if (report.source_files_exact_at_head !== true || typeof report.commit !== "string" || !/^[0-9a-f]{40}$/.test(report.commit)) {
    fail("R4_SOURCE_COMMIT_REQUIRED", "production requires every critical/graph file to exist as an exact non-ignored HEAD blob; clean status alone is insufficient", { closure_hash: report.closure_hash });
  }
  return report.commit;
}

function gitText(repoRoot: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", env: gitReadOnlyEnv(), maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function gitBuffer(repoRoot: string, args: readonly string[]): { status: number | null; stdout: Buffer; stderr: Buffer } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "buffer", env: gitReadOnlyEnv(), maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}
function gitReadOnlyEnv(): NodeJS.ProcessEnv { return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }; }

function appendOperatorAuditBestEffort(file: string, value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  try {
    const parent = walkRetainParentDirectoryFd(path.dirname(file), { create: false, label: "R4 operator audit parent" });
    try {
      const child = procFdChildPath(parent.fd, path.basename(file));
      const row = { schema_version: "adr0040-d3-v2-session-start-r4-operator-audit/v1", ...value, authority: false };
      const fd = fs.openSync(child, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NOFOLLOW, 0o600);
      try { fs.writeSync(fd, `${canonicalizeJcs(row)}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.fsyncSync(parent.fd);
      return deepFreeze({ appended: true, authority: false });
    } finally { fs.closeSync(parent.fd); }
  } catch (error) { return deepFreeze({ appended: false, authority: false, error: message(error) }); }
}

function parseStrict(raw: Buffer, label: string): unknown { try { return parseJsonRejectDuplicateKeys(raw); } catch (error) { fail("R4_DUPLICATE_OR_INVALID_JSON", `${label} is invalid or contains duplicate keys`, { error: message(error) }); } }
function assertExistingNoSymlinkAncestors(file: string, label: string): void { let current = path.parse(file).root; for (const part of path.relative(current, path.dirname(file)).split(path.sep).filter(Boolean)) { current = path.join(current, part); const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("R4_ANCESTOR_UNSAFE", `${label} ancestor is a symlink/non-directory`, { current }); } }
function assertHash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) fail("R4_HASH", `${label} must be lowercase SHA-256`); }
function requireAbsolute(value: string, label: string): string { if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) fail("R4_PATH", `${label} must be resolved absolute`); return value; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void { const actual = Object.keys(value).sort(compare); const wanted = [...expected].sort(compare); if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("R4_SCHEMA_CLOSED", `${label} keys differ`, { actual, expected: wanted }); }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("R4_SHAPE", `${label} must be an object`); return value as Record<string, unknown>; }
function recordOptional(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sameStat(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function fileExistsNoFollow(file: string): boolean { const stat = lstatMaybe(file); if (!stat) return false; if (stat.isSymbolicLink()) fail("R4_FILE_UNSAFE", `symlink exists at ${file}`); return true; }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function writeAll(fd: number, bytes: Buffer): void { let offset = 0; while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset); if (written <= 0) fail("R4_WRITE", "write made no progress"); offset += written; } }
function errorCode(error: unknown, fallback: string): string { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : fallback; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(code: string, text: string, detail?: Record<string, unknown>): never { throw new D3V2R4Error(code, text, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
