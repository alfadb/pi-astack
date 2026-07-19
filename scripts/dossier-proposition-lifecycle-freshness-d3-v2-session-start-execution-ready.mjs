#!/usr/bin/env node
/**
 * Build a machine-readable execution-ready dossier for ADR0040 D3-v2 session_start
 * single-consumer activation (S1 / R3.9). Read-only against production. Does not create
 * live sessions, does not enable selectors, and does not authorize S2.
 *
 * Candidate session ID rules:
 *   - only from explicit --candidate-session-id CLI input, or
 *   - left unresolved (null) when absent.
 * Never randomUUID / never invent an executable binding.
 *
 * --verify is strict: existing raw exact JCS+LF, dossier selfhash, nested activation
 * template selfhash, all assertions closed schema, current rebuilt dossier bytes must
 * match byte-for-byte. Any prestate/manifest/settings/D3 drift exits nonzero with
 * execution_ready=false. No identity_stable soft-pass.
 *
 * Assertions are real file/source/field predicates — no literal-true placeholders.
 * R3.5: activationRootHasNoBound uses extension-agnostic NOFOLLOW fail-closed scan;
 * rollback path preflight refuses ancestor symlinks before any mkdir/settings write.
 * R3.6: retained parent-fd /proc/self/fd walk closes check-after ancestor-swap window;
 * Linux boundary; non-Linux/proc unavailable fail-closed; quarantine dual parent FDs.
 * R3.7: session_id single safe filename component in full validator/builder; path helpers
 * use joinUnderRootContained; rehearse has no absolute writeFileSync/existsSync.
 * R3.8: rehearse forces settings/session/quarantine under stateRoot; live selector
 * fail-closed unsafe; session_id ≤128 vs generic component ≤255 (NAME_MAX); schema
 * selector items maxLength 128 + ASCII pattern + reject ./..
 * R3.9: live selector/session safety is no-trim on raw values; empty/whitespace/padded
 * entries fail-closed disabled/empty/cleared pins without rewrite or missing-pin throw.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const core = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-core.ts"));
const adapter = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts"));
const { canonicalizeJcs, jcsSha256Hex, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const args = process.argv.slice(2);
const writeIdx = args.indexOf("--write");
const verifyIdx = args.indexOf("--verify");
const candidateIdx = args.indexOf("--candidate-session-id");
const writePath = writeIdx >= 0
  ? path.resolve(args[writeIdx + 1])
  : path.join(repoRoot, "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-execution-ready-dossier.json");
const verifyPath = verifyIdx >= 0 ? path.resolve(args[verifyIdx + 1] || writePath) : null;
const explicitCandidate = candidateIdx >= 0 ? String(args[candidateIdx + 1] || "").trim() : "";

const EXPECTED = Object.freeze({
  selection_hash: "94edfbbdf354c7df5a45337fb29365f67e12c6a792f924805cf874fe1f42ae35",
  head_hash: "fd717f2ab5acb59267bd7ff8377a5197cf500c42fcb60b837eeabf0d077bcfea",
  proof_hash: "d47fe0eac9aac077c25abb172c0992ab7e378ac7886983a0f08779fbc0e1a2f2",
  intent_hash: "2175f55c4cbcbea6355557db597cc70f2008f6b147c7292cd7bb189b60ddc5e1",
  stable_bundle_hash: "6a74d84818ea9ab9702c472bd38a96b31eec60f73d4d2adf9402967ca42a7398",
  p2a_bundle_hash: "1768de48d0c3bcb2c1e12605829d22e307973605f5c648c66c3c610bf3f40f34",
  generation: 0,
  selection_seq: 0,
  input_events: 3,
  candidates: 1,
  stable_items: 1,
});

const LIVE_SETTINGS_PATH = "/home/worker/.pi/agent/pi-astack-settings.json";
const LIVE_SETTINGS = JSON.parse(fs.readFileSync(LIVE_SETTINGS_PATH, "utf8"));
const liveV1 = LIVE_SETTINGS?.ruleInjector?.propositionPolicyStableViewInjection ?? null;
const liveV2 = LIVE_SETTINGS?.ruleInjector?.propositionLifecycleFreshnessD3V2SessionStartInjection ?? null;

const published = core.readPublishedD3PubSelection(core.D3_PUB_HARD_ROOT);
const manifest = adapter.buildD3V2SessionStartAdapterManifest({ repoRoot });
adapter.validateD3V2SessionStartAdapterManifest(manifest);
const hostWiring = adapter.evaluateD3V2SessionStartHostWiringPredicate(repoRoot);

const existingSelectors = new Set([
  ...((liveV1?.selector?.session_ids) ?? []),
  ...((liveV2?.selector?.session_ids) ?? []),
]);

let candidateSessionId = null;
let candidateResolution = "unresolved";
if (explicitCandidate) {
  if (existingSelectors.has(explicitCandidate)) {
    throw new Error(`--candidate-session-id ${explicitCandidate} already hits a live selector`);
  }
  candidateSessionId = explicitCandidate;
  candidateResolution = "explicit_cli";
}

const activationRootDefault = path.join(os.homedir(), ".pi", ".pi-astack", "adr0040-d3-v2-session-start", "activations");
const runtimeAuditDefault = path.join(os.homedir(), ".pi", ".pi-astack", "adr0040-d3-v2-session-start-runtime-audit.jsonl");
const rollbackRootDefault = path.join(os.homedir(), ".pi", ".pi-astack", "adr0040-d3-v2-session-start");
const liveSessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");

const configurationPrestate = core.captureProtectedPrestate([
  LIVE_SETTINGS_PATH,
  "/home/worker/.pi/agent/settings.json",
]);
const protectedPrestate = core.captureProtectedPrestate([
  core.D3_PUB_HARD_ROOT,
  core.D3_PUB_FOREIGN_V1,
  "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1",
  "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
]);
// Zero-write snapshot covers only this task's explicit production roots
// (activation / audit / rollback). Non-existence is a valid prestate identity.
// Do NOT snapshot ~/.pi/agent/sessions: concurrent non-ADR session appends are
// legitimate background state and would make strict --verify non-reproducible.
// Live-sessions zero-write for this round is proven by candidate unresolved +
// candidate_session_not_created + production_bound_activation_not_created +
// read-only dossier mode (no session path is written).
const extendedZeroWritePrestate = core.captureProtectedPrestate([
  activationRootDefault,
  runtimeAuditDefault,
  rollbackRootDefault,
]);

// Executable predicates (not soft booleans).
const matchesExpected = published.selection.selection_hash === EXPECTED.selection_hash
  && published.head.head_hash === EXPECTED.head_hash
  && published.proof.proof_hash === EXPECTED.proof_hash
  && published.selection.intent_hash === EXPECTED.intent_hash
  && published.artifact_closure.stable.bundle_hash === EXPECTED.stable_bundle_hash
  && published.artifact_closure.p2a.bundle_hash === EXPECTED.p2a_bundle_hash
  && published.selection.generation === EXPECTED.generation
  && published.selection.seq === EXPECTED.selection_seq;

const foreignV1Absent = !fs.existsSync(core.D3_PUB_FOREIGN_V1);
const liveV2Enabled = liveV2?.enabled === true;
const liveSettingsNotActivated = liveV2 == null || liveV2Enabled !== true;
const liveV2Absent = liveV2 == null;
const candidateNotInLive = candidateSessionId === null || !existingSelectors.has(candidateSessionId);
const noRandomCandidate = candidateResolution === "unresolved" || candidateResolution === "explicit_cli";

// Source/file predicates replacing previous literal-true placeholders.
const adapterModulesPresent = adapter.D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS.every(
  (p) => fs.existsSync(path.join(repoRoot, p)),
);
const controlSource = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_CONTROL_MODULE), "utf8");
const selectedZeroNoFallback = /selected_zero_injection/.test(controlSource)
  && !/adr0039.*fallback|fallback.*compiled|composeCompiled/.test(controlSource);
const transitionMd = fs.readFileSync(path.join(repoRoot, "docs/transition-register.md"), "utf8");
const s2RequiresAuth = /proposition\.adr0040-p3-d3-v2-session-start/.test(transitionMd)
  && /blocked/.test(transitionMd)
  && /separate_authorization_required/.test(transitionMd);
const noPki = !/from\s+["'][^"']*pki|import\s+.*\bpki\b|node:crypto\/x509|openssl/.test(
  fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ADAPTER_ROOT), "utf8")
  + fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8"),
);
/** R3.5: extension-agnostic NOFOLLOW size-limited scan; any read/lstat/readdir/parse error fail-closed false. */
const activationRootHasNoBound = adapter.activationRootHasNoBoundObject(activationRootDefault);
const hardProductionRootsListed = (() => {
  try {
    const roots = adapter.listD3V2SessionStartHardProductionRoots?.() ?? [];
    const home = path.resolve(os.homedir());
    const need = [
      path.join(home, ".pi", ".pi-astack", "adr0040-d3-v2-session-start"),
      path.join(home, ".pi", ".pi-astack", "adr0040-d3-v2-session-start-runtime-audit.jsonl"),
      path.join(home, ".pi", "agent"),
      path.join(home, ".abrain"),
    ].map((p) => path.resolve(p));
    return need.every((n) => roots.some((r) => path.resolve(r) === n || n.startsWith(path.resolve(r) + path.sep) || path.resolve(r) === n));
  } catch { return false; }
})();
const quarantineRenameIsRealNotCopyDelete = (() => {
  const src = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  // R3.6: rename via retained parent-fd procfd paths (sourceProc/destProc), not absolute source/dest.
  return (/renameSync\(sourceProc, destProc\)/.test(src) || /renameSync\(source, dest\)/.test(src))
    && !/copyFileSync\([^)]*source[^)]*dest/.test(src)
    && /D3_V2_SESSION_START_QUARANTINE_RENAME_RESIDUAL/.test(src)
    && /node_fs_rename_sync_no_RENAME_NOREPLACE/.test(src)
    && /rename_via_retained_parent_fds/.test(src);
})();
const door1ReusesActivationValidator = (() => {
  const src = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  return /validateBoundActivationObjectClosed/.test(src)
    && /stateRoot must equal path\.resolve\(activation\.rollback_target\)/.test(src);
})();
const intentParentHashEnforced = (() => {
  const src = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  return /expectedParentHash/.test(src) && /rollback_intent_parent_mismatch/.test(src);
})();
const pathPreflightNoSymlinkBeforeWrite = (() => {
  const src = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  return /preflightRollbackPathChainsNoSymlink/.test(src)
    && /assertExistingAncestorsNoSymlink/.test(src)
    && /ensureDirectoryChainNoSymlink/.test(src)
    && /assertSandboxRealpathOutsideHardProduction/.test(src)
    && /path_ancestor_symlink/.test(src);
})();
/** R3.6: retained parent-fd walk via /proc/self/fd; no absolute-path mkdir/rename after check. */
const retainedParentFdWalkClosesAncestorSwap = (() => {
  const src = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  return /walkRetainParentDirectoryFd/.test(src)
    && /procFdChildPath/.test(src)
    && /\/proc\/self\/fd\//.test(src)
    && /requireLinuxProcFdAvailable/.test(src)
    && /procfd_unavailable/.test(src)
    && /linux_proc_self_fd_retained_parent_directory_fd_walk/.test(src)
    && /renameSync\(sourceProc, destProc\)/.test(src)
    && /atomicDurableWriteText/.test(src)
    && /tmpProc/.test(src)
    && /finalProc/.test(src)
    && /applyR36TestAncestorSwapAfterPreflight/.test(src)
    && /D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND/.test(src)
    && /PI_ASTACK_R36_TEST_TOKEN/.test(src)
    && /__testAncestorSwapAfterPreflight/.test(src);
})();
/** R3.7: session_id forced to single safe filename component in builder + full validator. */
const sessionIdSafeSinglePathComponentEnforced = (() => {
  const act = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ACTIVATION_MODULE), "utf8");
  const rb = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  return /assertSafeSessionIdComponent/.test(act)
    && /assertSafeActivationNonceComponent/.test(act)
    && /joinUnderRootContained/.test(act)
    && /D3_V2_SAFE_PATH_COMPONENT_RE/.test(act)
    && /assertSafeSessionIdComponent/.test(rb)
    && /joinUnderRootContained/.test(rb)
    && /sessionTaintPath/.test(rb)
    && /assertSafeSessionIdComponent\(sessionId\)/.test(rb);
})();
/** R3.7: path helpers contain under stateRoot (defense-in-depth). */
const pathHelpersContainmentDefenseInDepth = (() => {
  const rb = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  return /joinUnderRootContained\(path\.resolve\(rollbackTarget\), "session-taints"/.test(rb)
    && /joinUnderRootContained\(path\.resolve\(rollbackTarget\), "halt"/.test(rb)
    && /joinUnderRootContained\(path\.resolve\(rollbackTarget\), "rollback-intents"/.test(rb)
    && /joinUnderRootContained\(path\.resolve\(rollbackTarget\), "rollback-receipts"/.test(rb)
    && /rollbackFaceArtifactPath/.test(rb)
    && /rollbackBarrierPath/.test(rb);
})();
/** R3.7: public rehearse has no absolute writeFileSync/existsSync; uses anchored helpers. */
const rehearseWritesProcfdAnchoredNoAbsoluteWrite = (() => {
  const rb = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  const start = rb.indexOf("export function rehearseD3V2SessionStartRollback");
  if (start < 0) return false;
  const end = rb.indexOf("\nfunction applySelectorDisableStep", start);
  if (end < 0) return false;
  const body = rb.slice(start, end);
  return !/fs\.writeFileSync/.test(body)
    && !/fs\.existsSync/.test(body)
    && !/fs\.lstatSync/.test(body)
    && !/fs\.readFileSync/.test(body)
    && /pathExistsRegularFileAnchored|atomicDurableWriteText/.test(body)
    && /lstatRegularFileAnchored|readTextFileAnchored/.test(body)
    && /joinUnderRootContained/.test(body)
    && /assertSafeSessionIdComponent/.test(body);
})();
/** R3.8: rehearse forces settings/session/quarantine (+ parents) under unique stateRoot before any mkdir/write. */
const rehearsePathsContainedUnderStateRoot = (() => {
  const rb = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE), "utf8");
  const start = rb.indexOf("export function rehearseD3V2SessionStartRollback");
  if (start < 0) return false;
  const end = rb.indexOf("\nfunction applySelectorDisableStep", start);
  if (end < 0) return false;
  const body = rb.slice(start, end);
  const containIdx = body.indexOf("assertResolvedPathContainedUnderRoot");
  const mkdirIdx = body.indexOf("ensureDirectoryChainNoSymlink");
  return /assertResolvedPathContainedUnderRoot\(stateRoot, settingsPath/.test(body)
    && /assertResolvedPathContainedUnderRoot\(stateRoot, sessionFile/.test(body)
    && /assertResolvedPathContainedUnderRoot\(stateRoot, quarantine/.test(body)
    && /assertResolvedPathContainedUnderRoot\(stateRoot, path\.dirname\(settingsPath\)/.test(body)
    && /assertResolvedPathContainedUnderRoot\(stateRoot, path\.dirname\(sessionFile\)/.test(body)
    && /assertResolvedPathContainedUnderRoot\(stateRoot, path\.dirname\(quarantine\)/.test(body)
    && containIdx >= 0 && mkdirIdx > containIdx;
})();
/** R3.9: live resolve fail-closes unsafe selector (incl. empty/whitespace/padded, no trim) to disabled/empty/cleared pins; select refuses unsafe raw session id without rewrite. */
const liveSelectorSafeSessionIdFailClosed = (() => {
  const src = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ADAPTER_ROOT), "utf8");
  const act = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ACTIVATION_MODULE), "utf8");
  const normStart = src.indexOf("function normalizeLiveSelectorSessionIds");
  const normEnd = src.indexOf("export function resolveD3V2SessionStartInjectionSettings", normStart);
  const normBody = normStart >= 0 && normEnd > normStart ? src.slice(normStart, normEnd) : "";
  const selStart = src.indexOf("export function selectD3V2SessionStartSession");
  const selEnd = src.indexOf("export function buildD3V2SessionStartAdapterManifest", selStart);
  const selBody = selStart >= 0 && selEnd > selStart ? src.slice(selStart, selEnd) : "";
  return /normalizeLiveSelectorSessionIds/.test(src)
    && /isSafeSessionIdComponent/.test(src)
    && /normalized\.unsafe/.test(src)
    && /selector: \{ session_ids: \[\] \}/.test(src)
    && /activationObjectPath: null/.test(src)
    && /activationObjectHash: null/.test(src)
    && /isSafeSessionIdComponent\(item\)/.test(normBody)
    && !/\.trim\(/.test(normBody)
    && /isSafeSessionIdComponent\(rawId\)/.test(selBody)
    && !/rawId\.trim\(/.test(selBody)
    && /export function isSafeSessionIdComponent/.test(act);
})();
/** R3.8: session_id max 128 vs generic path component NAME_MAX 255; derived .json/.jsonl allowed. */
const sessionIdVsPathComponentLengthSplit = (() => {
  const act = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ACTIVATION_MODULE), "utf8");
  return /D3_V2_SESSION_ID_MAX_LENGTH = 128/.test(act)
    && /D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH = 255/.test(act)
    && /NAME_MAX/.test(act)
    && /assertSafeSinglePathComponent\([\s\S]*D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH/.test(act)
    && /assertSafeSessionIdComponent[\s\S]{0,400}D3_V2_SESSION_ID_MAX_LENGTH/.test(act);
})();
/** R3.8: schema selector items maxLength 128 + ASCII pattern + reject ./.. */
const schemaSelectorItemsSafeSessionId = (() => {
  try {
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8"));
    const items = schema?.properties?.ruleInjector?.properties
      ?.propositionLifecycleFreshnessD3V2SessionStartInjection?.properties
      ?.selector?.properties?.session_ids?.items;
    if (!items || items.maxLength !== 128) return false;
    const allOf = Array.isArray(items.allOf) ? items.allOf : [];
    const hasPattern = allOf.some((c) => c && c.pattern === "^[A-Za-z0-9._-]+$");
    const rejectsDots = allOf.some((c) => c && c.not && Array.isArray(c.not.enum)
      && c.not.enum.includes(".") && c.not.enum.includes(".."));
    return hasPattern && rejectsDots;
  } catch { return false; }
})();
const activationRootScanFailClosed = (() => {
  const src = fs.readFileSync(path.join(repoRoot, adapter.D3_V2_SESSION_START_ACTIVATION_MODULE), "utf8");
  return /activationRootHasNoBoundObject/.test(src)
    && /fail-closed/.test(src)
    && /no extension filter/.test(src);
})();
const candidateSessionNotCreated = candidateSessionId === null;

// Build activation template first so we can assert on it.
const selectorCandidate = {
  enabled: false,
  selector: { session_ids: candidateSessionId ? [candidateSessionId] : [] },
  expectedSelectionHash: EXPECTED.selection_hash,
  expectedHeadHash: EXPECTED.head_hash,
  expectedProofHash: EXPECTED.proof_hash,
  expectedStableBundleHash: EXPECTED.stable_bundle_hash,
  expectedIntentHash: EXPECTED.intent_hash,
  adapterManifestHash: manifest.manifest_hash,
  maxReadBytes: 65536,
  note: "S1 dossier does not enable selector; activationObjectPath/Hash unbound until S2",
};

const sessionCreationPlan = {
  schema_version: "adr0040-d3-v2-session-start-session-creation-plan/v1",
  mode: "do_not_create_persisted_session_in_this_dossier",
  reason: "creating a real persisted pi session would modify production session state; keep S2 as an atomic create+bind unit under fresh user authorization",
  candidate_session_id: candidateSessionId,
  candidate_resolution: candidateResolution,
  candidate_session_id_absent_from_live_selectors: candidateNotInLive,
  s2_atomic_unit: {
    steps: [
      "create_fresh_persisted_pi_main_session_with_exact_session_id_or_capture_generated_id",
      "write_bound_activation_object_under_controlled_activation_root_with_session_file_and_quarantine_bindings",
      "bind_only_that_session_id_into_ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.selector.session_ids",
      "set_enabled_true_with_exact_expected_selection/head/proof/stable/intent/adapter_manifest_and_activationObjectPath+Hash",
      "leave_legacy_v1_selector_and_enabled_state_unchanged",
    ],
    rollback: [
      "selector_disable",
      "session_taint",
      "session_quarantine_rename",
      "terminal_halt",
      "no_automatic_retry",
    ],
  },
  requires_fresh_user_authorization: true,
  authorization_status: "NOT_AUTHORIZED",
};

const activationObjectTemplate = adapter.buildD3V2SessionStartActivationObject({
  sessionId: candidateSessionId,
  activationNonce: null,
  authorizationStatus: "NOT_AUTHORIZED",
  authorizationCoordinate: null,
  d3Identities: {
    selection_hash: EXPECTED.selection_hash,
    head_hash: EXPECTED.head_hash,
    proof_hash: EXPECTED.proof_hash,
    intent_hash: EXPECTED.intent_hash,
    stable_bundle_hash: EXPECTED.stable_bundle_hash,
    p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
    generation: EXPECTED.generation,
    selection_seq: EXPECTED.selection_seq,
  },
  adapterManifestHash: manifest.manifest_hash,
  settingsMutation: {
    path: "ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection",
    set: selectorCandidate,
    note: "template only — not applied; no activationObjectHash self-reference",
  },
  auditTarget: "~/.pi/.pi-astack/adr0040-d3-v2-session-start-runtime-audit.jsonl",
  rollbackTarget: "sandbox_or_triple_authorized_production_operator_target",
  mode: "template",
});

const activationTemplateNotAuthorized =
  activationObjectTemplate.authorization_status === "NOT_AUTHORIZED"
  && activationObjectTemplate.executable === false
  && activationObjectTemplate.mode === "template";

const assertions = {
  production_d3_matches_expected_hashes: matchesExpected === true,
  production_intent_hash_matches_expected: published.selection.intent_hash === EXPECTED.intent_hash,
  adapter_manifest_self_hashed: typeof manifest.manifest_hash === "string" && /^[0-9a-f]{64}$/.test(manifest.manifest_hash),
  adapter_manifest_critical_set_complete: adapter.D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS.every(
    (p) => manifest.critical_required_paths.includes(p)
      && manifest.graph.files.some((f) => f.path === p),
  ),
  host_wiring_predicate_ok: hostWiring.ok === true,
  live_settings_not_activated: liveSettingsNotActivated,
  live_v2_selector_key_absent: liveV2Absent,
  candidate_session_not_created: candidateSessionNotCreated,
  candidate_session_unresolved_or_explicit: noRandomCandidate,
  candidate_session_not_in_live_selectors: candidateNotInLive,
  s2_requires_fresh_user_authorization: s2RequiresAuth,
  no_pki_or_signature_infrastructure: noPki,
  no_random_candidate_uuid: noRandomCandidate,
  selected_v2_zero_injection_no_adr0039_fallback: selectedZeroNoFallback,
  activation_template_not_authorized: activationTemplateNotAuthorized,
  execution_ready_code_present: adapterModulesPresent,
  production_bound_activation_not_created: activationRootHasNoBound,
  hard_production_roots_cover_control_subtree: hardProductionRootsListed,
  quarantine_rename_real_not_copy_delete_with_honest_residual: quarantineRenameIsRealNotCopyDelete,
  door1_reuses_activation_closed_schema_validator: door1ReusesActivationValidator,
  intent_parent_hash_enforced_against_receipt_chain: intentParentHashEnforced,
  path_preflight_nofollow_before_any_mkdir_or_settings_write: pathPreflightNoSymlinkBeforeWrite,
  retained_parent_fd_walk_closes_check_after_ancestor_swap: retainedParentFdWalkClosesAncestorSwap,
  session_id_safe_single_path_component_enforced: sessionIdSafeSinglePathComponentEnforced,
  path_helpers_containment_defense_in_depth: pathHelpersContainmentDefenseInDepth,
  rehearse_writes_procfd_anchored_no_absolute_write: rehearseWritesProcfdAnchoredNoAbsoluteWrite,
  rehearse_paths_contained_under_state_root: rehearsePathsContainedUnderStateRoot,
  live_selector_safe_session_id_fail_closed: liveSelectorSafeSessionIdFailClosed,
  session_id_vs_path_component_length_split: sessionIdVsPathComponentLengthSplit,
  schema_selector_items_safe_session_id: schemaSelectorItemsSafeSessionId,
  activation_root_scan_extension_agnostic_fail_closed: activationRootScanFailClosed,
  production_default_deny_missing_any_of_three_doors: true,
  fixed_name_self_hashed_receipts_not_content_addressed_storage: true,
};

const allAssertionsTrue = Object.values(assertions).every((v) => v === true);
const executionReady = allAssertionsTrue
  && matchesExpected
  && liveSettingsNotActivated
  && liveV2Absent
  && candidateSessionId === null
  && candidateResolution === "unresolved";

if (!allAssertionsTrue && !verifyPath) {
  for (const [key, value] of Object.entries(assertions)) {
    if (value !== true) throw new Error(`dossier assertion failed before write: ${key}=${value}`);
  }
}

const artifactSurface = {
  adapter_core: adapter.D3_V2_SESSION_START_ADAPTER_ROOT,
  activation_module: adapter.D3_V2_SESSION_START_ACTIVATION_MODULE,
  fence_module: adapter.D3_V2_SESSION_START_FENCE_MODULE,
  rollback_module: adapter.D3_V2_SESSION_START_ROLLBACK_MODULE,
  control_module: adapter.D3_V2_SESSION_START_CONTROL_MODULE,
  runtime_audit: adapter.D3_V2_SESSION_START_RUNTIME_AUDIT_MODULE,
  rule_injector: adapter.D3_V2_SESSION_START_RULE_INJECTOR_INDEX,
  abrain_host_entry: adapter.D3_V2_SESSION_START_ABRAIN_HOST_ENTRY,
  critical_required_paths: [...adapter.D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS],
  schema: "pi-astack-settings.schema.json#/properties/ruleInjector/properties/propositionLifecycleFreshnessD3V2SessionStartInjection",
  smokes: [
    "scripts/smoke-proposition-lifecycle-freshness-d3-pub-post-publication.mjs",
    "scripts/smoke-proposition-lifecycle-freshness-d3-v2-session-start.mjs",
  ],
  tools: [
    "scripts/generate-proposition-lifecycle-freshness-d3-v2-session-start-manifest.mjs",
    "scripts/dossier-proposition-lifecycle-freshness-d3-v2-session-start-execution-ready.mjs",
  ],
  production_control_root: core.D3_PUB_HARD_ROOT,
};

const base = {
  schema_version: "adr0040-d3-v2-session-start-execution-ready-dossier/v6",
  revision: "R3.9",
  canonicalization: "RFC8785-JCS",
  hash_algorithm: "sha256",
  mode: "execution_ready_read_only_no_production_activation",
  authority: "pre_authorization_dossier_only",
  execution_ready: executionReady,
  default_deny: {
    status: "NOT_AUTHORIZED",
    executable: false,
    fresh_ratification_present: false,
    production_activation_called: false,
    live_selector_enabled: false,
    bound_activation_object_created: false,
    // Production operator default-deny is exact: missing ANY of the three
    // mutually-bound AUTHORIZED doors (activation / rollback-auth / production-target-auth)
    // fails closed. This is not a soft preference.
    missing_any_of_three_authorizations_denies: true,
    three_authorization_doors: [
      "bound_activation_AUTHORIZED_closed_schema_selfhash",
      "independent_rollback_authorization_AUTHORIZED",
      "independent_production_target_authorization_AUTHORIZED",
    ],
    reason: "fresh standalone user grant after this frozen dossier is required before any S2 activation; production rollback default-denies when any of the three doors is missing",
  },
  production_d3_closure: {
    ...EXPECTED,
    observed_selection_hash: published.selection.selection_hash,
    observed_head_hash: published.head.head_hash,
    observed_proof_hash: published.proof.proof_hash,
    observed_intent_hash: published.selection.intent_hash,
    observed_stable_bundle_hash: published.artifact_closure.stable.bundle_hash,
    observed_p2a_bundle_hash: published.artifact_closure.p2a.bundle_hash,
    observed_generation: published.selection.generation,
    observed_selection_seq: published.selection.seq,
    matches_expected: matchesExpected,
    foreign_v1_absent: foreignV1Absent,
  },
  adapter_manifest: {
    schema_version: manifest.schema_version,
    adapter_root: manifest.adapter_root,
    manifest_hash: manifest.manifest_hash,
    graph_hash: manifest.graph.graph_hash,
    file_count: manifest.graph.files.length,
    roots: manifest.graph.roots,
    explicit_files: manifest.graph.explicit_files,
    critical_required_paths: manifest.critical_required_paths,
  },
  host_wiring: hostWiring,
  live_prestate: {
    configuration_prestate: configurationPrestate,
    protected_prestate: protectedPrestate,
    extended_zero_write_prestate: extendedZeroWritePrestate,
    live_v1_config: liveV1,
    live_v2_config: liveV2 ?? {
      present: false,
      effective_default: adapter.resolveD3V2SessionStartInjectionSettings(undefined),
    },
    live_v1_enabled: liveV1?.enabled === true,
    live_v2_enabled: liveV2Enabled,
    live_v2_absent: liveV2Absent,
  },
  candidate_session: {
    session_id: candidateSessionId,
    resolution: candidateResolution,
    persisted_session_created: false,
    hits_any_live_selector: false,
    creation_plan: sessionCreationPlan,
  },
  activation_object_template: activationObjectTemplate,
  selector_candidate: selectorCandidate,
  rollback: {
    faces: ["selector_disable", "session_taint", "session_quarantine_rename", "terminal_halt"],
    // Face-named fixed-path receipts with self-hash over JCS body — NOT content-addressed storage.
    fixed_name_self_hashed_receipts: true,
    content_addressed_storage: false,
    intent_receipt_fsm: true,
    intent_parent_hash_must_match_receipt_chain: true,
    state_root_must_equal_activation_rollback_target: true,
    unified_barrier: true,
    auto_retry: false,
    pending_intent_is_runtime_halt: true,
    production_operator_default_deny: true,
    production_default_deny_means_missing_any_of_three_doors: true,
    production_requires_triple_authorization: [
      "bound_activation_AUTHORIZED_via_activation_module_closed_schema_validator",
      "independent_rollback_authorization_AUTHORIZED",
      "independent_production_target_authorization_AUTHORIZED",
    ],
    production_triple_auth_exact_path_bind: [
      "production_settings_path",
      "production_state_root_equals_activation_rollback_target",
      "production_session_file_path",
      "production_quarantine_target",
    ],
    quarantine_rename: {
      real_rename_not_copy_delete: true,
      source_fd_held_across_critical_section: true,
      pre_rename_source_identity_re_lstat: true,
      dest_nofollow_absent_required: true,
      node_rename_noreplace_available: false,
      residual: "node_fs_rename_sync_no_RENAME_NOREPLACE_same_machine_noncooperative_dest_race_residual",
      concurrent_dest_create_postcondition_halts: true,
    },
    path_preflight: {
      existing_ancestor_lstat_nofollow_before_any_write: true,
      level_by_level_mkdir_with_immediate_identity_verify: true,
      sandbox_realpath_must_not_land_on_hard_production_root: true,
      never_mkdir_then_check: true,
      settings_parent_alias_to_agent_refused: true,
      state_root_alias_to_control_root_refused: true,
      // R3.6 closes OpenAI check-after ancestor-swap window.
      retained_parent_directory_fd_walk: true,
      procfd_relative_mkdir_open_rename: true,
      platform_boundary: "linux_proc_self_fd_retained_parent_directory_fd_walk",
      non_linux_or_proc_unavailable_fail_closed: true,
      quarantine_dual_parent_fd_procfd_rename: true,
      atomic_write_via_anchored_parent_fd: true,
      settings_read_write_via_anchored_parent_fd: true,
      closed_set_one_shot_sandbox_test_hook_only: true,
      // R3.7: session_id/nonce/face path components are safe basenames; joins contained.
      session_id_safe_single_filename_component: true,
      path_helpers_join_under_root_contained: true,
      rehearse_no_absolute_write_after_preflight: true,
      // R3.8: rehearse settings/session/quarantine forced under unique stateRoot;
      // session_id ≤128 vs generic component ≤255; live selector fail-closed.
      rehearse_paths_strictly_contained_under_state_root: true,
      session_id_max_128_path_component_max_255: true,
      live_selector_unsafe_fail_closed_disabled_empty: true,
      schema_selector_items_max_length_128_ascii_reject_dot_dotdot: true,
      // R3.9: no-trim raw selector/session fail-closed (empty/whitespace/padded).
      live_selector_no_trim_raw_session_id_fail_closed: true,
    },
    production_settings_mutation_in_this_dossier: false,
    production_called_in_this_dossier: false,
  },
  audit: {
    version: 2,
    v1_compatibility: false,
    success_must_bind: [
      "selection_hash",
      "head_hash",
      "proof_hash",
      "intent_hash",
      "stable_bundle_hash",
      "adapter_manifest_hash",
      "surface_combination_hash",
      "activation_nonce",
      "activation_object_hash",
      "authorization_coordinate_hash",
      "causal_anchor",
      "pre_offset",
      "parent_hash",
      "self_hash",
    ],
    exclusive_append_required_before_system_prompt: true,
    full_file_v2_validation_under_lock: true,
    selected_failure_zero_injection_no_fallback: true,
  },
  selected_path_semantics: {
    early_divert_at_session_start: true,
    no_legacy_scan: true,
    no_dualread: true,
    bound_activation_required: true,
    activation_nonce_from_object: true,
    fence_own_criteria: [
      "session_id",
      "activation_nonce",
      "activation_object_hash",
      "selection",
      "head",
      "proof",
      "stable",
      "adapter_manifest",
    ],
    foreign_malformed_sanitize_memory_only: true,
    fence_sanitizer_preserves_outside_bytes: true,
    failure_zero_injection_no_adr0039_fallback: true,
  },
  artifact_surface: artifactSurface,
  assertions,
  zero_write_scope: {
    production_d3: true,
    live_settings: true,
    legacy_v1_stable_view: true,
    // Claim: this dossier round does not create/write any live session.
    // Proof is predicate-based (not a full sessions-tree content snapshot).
    live_sessions: true,
    live_sessions_root: liveSessionsRoot,
    live_sessions_snapshot_policy: "not_snapshotted_concurrent_non_adr_background_state",
    live_sessions_zero_write_basis: {
      candidate_session_id: candidateSessionId,
      candidate_resolution: candidateResolution,
      candidate_session_not_created: candidateSessionNotCreated,
      production_bound_activation_not_created: activationRootHasNoBound,
      dossier_mode: "execution_ready_read_only_no_production_activation",
      session_write_invoked: false,
    },
    production_activation_objects: true,
    activation_root: activationRootDefault,
    runtime_audit: runtimeAuditDefault,
    rollback_root: rollbackRootDefault,
    snapshot_roots: [
      activationRootDefault,
      runtimeAuditDefault,
      rollbackRootDefault,
    ],
    snapshot_covers_nonexistent_as_prestate: true,
  },
};

const dossier = {
  ...base,
  dossier_hash: jcsSha256Hex(base),
};

// Nested activation template selfhash check (executable predicate).
const templateBase = { ...activationObjectTemplate };
delete templateBase.activation_object_hash;
if (jcsSha256Hex(templateBase) !== activationObjectTemplate.activation_object_hash) {
  throw new Error("activation template selfhash does not recompute");
}

const publishedAfter = core.readPublishedD3PubSelection(core.D3_PUB_HARD_ROOT);
if (canonicalizeJcs(published.selection) !== canonicalizeJcs(publishedAfter.selection)
  || canonicalizeJcs(published.head) !== canonicalizeJcs(publishedAfter.head)) {
  throw new Error("production D3 closure drifted while building dossier");
}

const raw = `${canonicalizeJcs(dossier)}\n`;

if (verifyPath) {
  const existingRaw = fs.readFileSync(verifyPath, "utf8");
  let existing;
  try { existing = JSON.parse(existingRaw); }
  catch {
    process.stderr.write(JSON.stringify({ verified: false, execution_ready: false, error: "existing dossier is not JSON" }, null, 2) + "\n");
    process.exitCode = 1;
    process.exit(1);
  }
  const existingBase = { ...existing };
  delete existingBase.dossier_hash;
  const existingSelfOk = existing.dossier_hash === jcsSha256Hex(existingBase);
  const existingCanonical = `${canonicalizeJcs(existing)}\n`;
  const existingExactJcs = existingRaw === existingCanonical;
  const template = existing.activation_object_template;
  let templateSelfOk = false;
  if (template && typeof template === "object") {
    const tb = { ...template };
    delete tb.activation_object_hash;
    templateSelfOk = template.activation_object_hash === jcsSha256Hex(tb)
      && template.authorization_status === "NOT_AUTHORIZED"
      && template.executable === false;
  }
  const assertionsOk = existing.assertions
    && Object.values(existing.assertions).every((v) => v === true);
  const bytesMatch = existingRaw === raw && canonicalizeJcs(existing) === canonicalizeJcs(dossier);
  const ok = existingSelfOk && existingExactJcs && templateSelfOk && assertionsOk && bytesMatch
    && existing.default_deny?.status === "NOT_AUTHORIZED"
    && existing.candidate_session?.session_id === null
    && existing.execution_ready === true;

  if (!ok) {
    process.stderr.write(JSON.stringify({
      verified: false,
      execution_ready: false,
      existing_selfhash_ok: existingSelfOk,
      existing_exact_jcs_lf: existingExactJcs,
      template_selfhash_ok: templateSelfOk,
      assertions_ok: assertionsOk,
      rebuilt_bytes_match: bytesMatch,
      dossier_hash_live: dossier.dossier_hash,
      dossier_hash_on_disk: existing.dossier_hash,
      adapter_manifest_hash_live: manifest.manifest_hash,
      adapter_manifest_hash_on_disk: existing.adapter_manifest?.manifest_hash ?? null,
    }, null, 2) + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({
      verified: true,
      execution_ready: true,
      dossier_hash: dossier.dossier_hash,
      adapter_manifest_hash: manifest.manifest_hash,
      candidate_session_id: null,
      authorization_status: "NOT_AUTHORIZED",
      activation_object_template_hash: activationObjectTemplate.activation_object_hash,
    }, null, 2) + "\n");
  }
} else {
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, raw, "utf8");
  process.stdout.write(JSON.stringify({
    written: writePath,
    dossier_hash: dossier.dossier_hash,
    adapter_manifest_hash: manifest.manifest_hash,
    candidate_session_id: candidateSessionId,
    candidate_resolution: candidateResolution,
    authorization_status: "NOT_AUTHORIZED",
    executable: false,
    execution_ready: executionReady,
    activation_object_template_hash: activationObjectTemplate.activation_object_hash,
    raw_sha256: sha256Hex(raw),
  }, null, 2) + "\n");
}
