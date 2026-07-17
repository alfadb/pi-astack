import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import {
  REAL_POLICY_APPEND_STAGE2_LINE,
  REAL_POLICY_APPEND_STAGE2_MESSAGE_ID,
  REAL_POLICY_APPEND_STAGE2_SESSION_ID,
  REAL_POLICY_APPEND_STAGE2_SESSION_PATH,
  REAL_POLICY_APPEND_STAGE2_TEXT_SHA256,
  REAL_POLICY_APPEND_STAGE2_TIMESTAMP,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_CONTRACT_SCHEMA,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED_SPEC_FIELDS,
  REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA,
  REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_CONTRACT_SCHEMA,
  realPolicyAppendRecoveryHumanAuthorizationExpectation,
  realPolicyAppendStage3AuthorizationExpectation,
  verifyFreshRealPolicyAppendRecoveryAuthorization,
  verifyFreshRealPolicyAppendStage3Authorization,
  verifyRecordedRealPolicyAppendStage3Authorization,
  type RealPolicyAppendRecoveryAuthorizationBinding,
  type RealPolicyAppendRecoveryHumanAuthorizationContract,
  type RealPolicyAppendStage3AuthorizationBinding,
  type RealPolicyAppendStage3AuthorizationSpec,
  type VerifiedRealPolicyAppendRecoveryAuthorization,
  type VerifiedRealPolicyAppendStage3Authorization,
} from "./proposition-real-policy-append-transcript";
import {
  REAL_POLICY_APPEND_ABSOLUTE_TARGET,
  REAL_POLICY_APPEND_EVENT_ID,
  REAL_POLICY_APPEND_RELATIVE_TARGET,
  fixedRealPolicyAppendTuple,
} from "./proposition-real-policy-append-writer";

export const REAL_POLICY_APPEND_RATIFICATION_RELATIVE = "docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-production-ratification-record.json" as const;
export const REAL_POLICY_APPEND_INTENT_RELATIVE = "docs/evidence/adr0040-real-policy-proposition-append-execution-intent-1c8cc5d23110f44a.json" as const;
export const REAL_POLICY_APPEND_POST_RELATIVE = "docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-production-post-execute-dossier.json" as const;
export const REAL_POLICY_APPEND_PREVIEW_RELATIVE = "docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-execution-ready-preview-dossier.json" as const;
export const REAL_POLICY_APPEND_RECOVERY_DOSSIER_RELATIVE = "docs/evidence/2026-07-16-adr0040-real-policy-proposition-append-s2-recovery-ready-dossier.json" as const;
export const REAL_POLICY_APPEND_STAGE3_OUTPUTS = Object.freeze([
  REAL_POLICY_APPEND_RATIFICATION_RELATIVE,
  REAL_POLICY_APPEND_INTENT_RELATIVE,
  REAL_POLICY_APPEND_POST_RELATIVE,
] as const);

const EVENT_PARENT_RELATIVE = path.posix.dirname(REAL_POLICY_APPEND_RELATIVE_TARGET);
const EVENT_FIRST_SHARD_RELATIVE = path.posix.dirname(EVENT_PARENT_RELATIVE);
const INTENT_SCHEMA = "adr0040-real-policy-proposition-append-execution-intent/v1";
const RATIFICATION_SCHEMA = "adr0040-real-policy-proposition-append-production-ratification/v1";
const POST_SCHEMA = "adr0040-real-policy-proposition-append-production-post-execute-dossier/v1";
const PREVIEW_SCHEMA = "adr0040-real-policy-proposition-append-execution-ready-preview-dossier/v1";
const RECOVERY_DOSSIER_SCHEMA = "adr0040-real-policy-proposition-append-s2-recovery-ready-dossier/v1";
const PROTOCOL_HASH = "b53bc2692fc65f478301597756217a097bb2b2627a74c4c3ef5cd82ef1684a76";
const RECOVERY_RATIFICATION_RAW_SHA256 = "516c99ce932ce14c812f117ebbe135f7e763eb9a4ca50ba66e1137aa091687e5";
const RECOVERY_RATIFICATION_SELF_HASH = "1434980dbaeb7aa30a566a3d39757932dd6e4e9cacf18d302e479e4bc176548d";
const RECOVERY_INTENT_RAW_SHA256 = "abfec6296f8beccc91f6fb751bf673a7169c3eb8b71dab18bfd10fcd677ce8e4";
const RECOVERY_INTENT_SELF_HASH = "e10ccfd45feeeec4059c9da771497bd8aa6941932b42ee369b565ba0ff921751";
const RECOVERY_PREVIEW_RAW_SHA256 = "1dd1b8e45acadfe264c4a8062dff6fd8d6f6dd41675ad8f83cc7e5481926029b";
const RECOVERY_PREVIEW_SELF_HASH = "f0d7eac6a20278fce4e4d0c72cce10d4b9249d17dbcf165b56b658d6cf950f11";
const HARD_REPO_ROOT = "/home/worker/.pi/agent/skills/pi-astack";
const HARD_ABRAIN_HOME = "/home/worker/.abrain";
const EVIDENCE_RELATIVE = "docs/evidence";
const CONFINED_EVIDENCE_DIRECTORY = "/run/pi-astack/evidence";
const CONFINED_EVENT_FIRST_SHARD = "/run/pi-astack/event-first";
const CONFINED_FLOCK = "/run/pi-astack/flock";
const HARD_NODE_EXECUTABLE = "/home/worker/.volta/tools/image/node/24.15.0/bin/node";
const CLOSURE_SCHEMA = "adr0040-real-policy-proposition-append-execution-closure/v2";
const EXPECTED_PRESTATE_IDS = Object.freeze([
  "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
  "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585",
] as const);

export type EventDurableState = "S0" | "S1" | "S2" | "S3" | "S4";

export class RealPolicyAppendExecuteError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "RealPolicyAppendExecuteError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

/** The sole production executor. Stage2 reaches only its pre-authority default deny. */
export function executeRealPolicyAppendProduction(options: { repoRoot: string }): Readonly<Record<string, unknown>> {
  const repoRoot = exactDirectory(options.repoRoot, "repository root");
  if (repoRoot !== HARD_REPO_ROOT) notAuthorized("FIXED_PRODUCTION_REPOSITORY_REQUIRED", "production executor accepts only the fixed repository");
  if (process.env.PI_ASTACK_REAL_POLICY_APPEND_CONFINED !== "1") notAuthorized("EFFECTIVE_BWRAP_REQUIRED", "production append requires the official verified-FD bubblewrap launcher");
  const evidenceDirectory = exactDirectory(CONFINED_EVIDENCE_DIRECTORY, "confined retained evidence directory");
  assertEffectiveConfinement(evidenceDirectory);
  const lock = acquireEvidenceDirectoryLock(evidenceDirectory);
  if (lock.status === "BUSY") { fs.closeSync(lock.fd); fail("REAL_POLICY_APPEND_BUSY", "another official executor holds the evidence-directory OFD lock"); }
  try {
    const previewPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_PREVIEW_RELATIVE));
    if (!lstatMaybe(previewPath)) notAuthorized("EXECUTION_READY_PREVIEW_REQUIRED", "the exact completed Stage2 preview dossier is required before Stage3");
    const previewRaw = readExactRegular(previewPath, "execution-ready preview dossier");
    const preview = parseCanonicalSelfHashed(previewRaw.raw, "dossier_hash", PREVIEW_SCHEMA, previewPath);
    const tuple = fixedRealPolicyAppendTuple();
    if (tuple.event_id !== REAL_POLICY_APPEND_EVENT_ID || tuple.absolute_target_path !== REAL_POLICY_APPEND_ABSOLUTE_TARGET) fail("REAL_POLICY_APPEND_TUPLE_CORRUPTION", "fixed tuple identity differs before target classification");
    const authorizationBinding = realPolicyAppendStage3AuthorizationBinding(preview, previewRaw.raw_sha256);
    const ratificationPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_RATIFICATION_RELATIVE));
    const intentPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_INTENT_RELATIVE));
    const postPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_POST_RELATIVE));

    const targetFirst = classifyTargetFirst(CONFINED_EVENT_FIRST_SHARD);
    const initialRatificationStat = lstatMaybe(ratificationPath);
    const initialIntentStat = lstatMaybe(intentPath);
    const initialPostStat = lstatMaybe(postPath);
    if (targetFirst === "foreign") fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "live target is foreign or tuple-corrupt");
    if (targetFirst === "absent" && initialPostStat) fail("REAL_POLICY_APPEND_POST_TARGET_PRECEDENCE", "terminal post exists while live target is absent");
    if (targetFirst === "exact" && initialPostStat) {
      if (!initialRatificationStat || !initialIntentStat) fail("REAL_POLICY_APPEND_RECOVERY_FOREIGN", "terminal target/post lacks ratification or intent");
      const terminalRatification = readCanonicalSelfHashed(ratificationPath, "record_hash", RATIFICATION_SCHEMA);
      validateRatification(terminalRatification, preview, previewRaw.raw_sha256);
      const terminalIntent = readCanonicalSelfHashed(intentPath, "intent_hash", INTENT_SCHEMA);
      validateIntent(terminalIntent, terminalRatification, preview);
      return validateTerminalPost(postPath, terminalRatification, terminalIntent, "S4");
    }

    verifyPreviewExecutionClosure(repoRoot, preview);
    if (!initialRatificationStat) {
      if (initialIntentStat || initialPostStat) fail("REAL_POLICY_APPEND_RECOVERY_FOREIGN", "fresh Stage3 entry cannot have intent or terminal post");
      assertStage3OutputsAbsent(repoRoot);
      assertExactStage3EventFsm("pre_mutation");
    }

    let ratification: Record<string, unknown>;
    let authorization: VerifiedRealPolicyAppendStage3Authorization;
    if (!lstatMaybe(ratificationPath)) {
      authorization = requireFreshStage3Authorization(authorizationBinding);
      ratification = withSelfHash({
        schema_version: RATIFICATION_SCHEMA,
        canonicalization: "RFC8785-JCS",
        hash_algorithm: "sha256",
        record_hash_scope: "sha256 over RFC8785-JCS of this object with record_hash omitted and no LF",
        record_kind: "real_user_stage3_ratification",
        protocol_hash: PROTOCOL_HASH,
        stage3_authorized: true,
        preview: { path: REAL_POLICY_APPEND_PREVIEW_RELATIVE, raw_sha256: previewRaw.raw_sha256, dossier_hash: preview.dossier_hash, source_closure_hash: asRecord(preview.source_closure, "preview source closure").closure_hash },
        fixed_tuple: fixedTupleBinding(),
        authorization_evidence: authorization,
        exact_repo_outputs: REAL_POLICY_APPEND_STAGE3_OUTPUTS,
        exact_abrain_mutation: exactAbrainMutationBinding(),
        non_authority: ["commit", "push", "restart", "P2a", "P2b", "runtime", "P3", "P4"],
      }, "record_hash");
      stageRepoArtifact({ directory: evidenceDirectory, directoryFd: lock.fd, finalName: path.basename(ratificationPath), raw: canonicalRaw(ratification) });
    } else {
      ratification = readCanonicalSelfHashed(ratificationPath, "record_hash", RATIFICATION_SCHEMA);
      validateRatification(ratification, preview, previewRaw.raw_sha256);
      authorization = verifyRecordedRealPolicyAppendStage3Authorization(ratification.authorization_evidence, authorizationBinding);
    }
    validateRatification(ratification, preview, previewRaw.raw_sha256);

    const intentStat = lstatMaybe(intentPath);
    const postStat = lstatMaybe(postPath);
    if (!intentStat && (postStat || targetFirst === "exact")) fail("REAL_POLICY_APPEND_RECOVERY_FOREIGN", "target/post cannot exist without an exact durable intent");

    let intent: Record<string, unknown>;
    let recovery = false;
    if (intentStat) {
      recovery = true;
      intent = readCanonicalSelfHashed(intentPath, "intent_hash", INTENT_SCHEMA);
      validateIntent(intent, ratification, preview);
      authorization = verifyRecordedRealPolicyAppendStage3Authorization(ratification.authorization_evidence, authorizationBinding);
      const state = classifyFixedEventState({ firstShard: CONFINED_EVENT_FIRST_SHARD, intentHash: stringField(intent.intent_hash, "intent_hash") });
      if (postStat) return validateTerminalPost(postPath, ratification, intent, state);
    } else {
      if (postStat) fail("REAL_POLICY_APPEND_POST_WITHOUT_INTENT", "terminal post exists without intent");
      assertExactStage3EventFsm("pre_mutation");
      const anchorsC0a = captureClosedStableAnchors(repoRoot, preview, authorization, "pre_mutation");
      const anchors = captureClosedStableAnchors(repoRoot, preview, authorization, "pre_mutation");
      if (canonicalizeJcs(anchorsC0a) !== canonicalizeJcs(anchors)) fail("REAL_POLICY_APPEND_C0_DRIFT", "C0a and C0b closed stable anchors differ");
      intent = withSelfHash({
        schema_version: INTENT_SCHEMA,
        canonicalization: "RFC8785-JCS",
        hash_algorithm: "sha256",
        intent_hash_scope: "sha256 over RFC8785-JCS of this object with intent_hash omitted and no LF",
        protocol_hash: PROTOCOL_HASH,
        production_append_authorized: true,
        ratification_hash: ratification.record_hash,
        preview_dossier_hash: preview.dossier_hash,
        source_closure_hash: asRecord(preview.source_closure, "preview source closure").closure_hash,
        event_id: REAL_POLICY_APPEND_EVENT_ID,
        target_path: REAL_POLICY_APPEND_ABSOLUTE_TARGET,
        canonical_envelope_raw_sha256: tuple.canonical_envelope_raw_sha256,
        authorization_evidence: authorization,
        C0: { anchors, anchors_hash: jcsSha256Hex(anchors), C0a_hash: jcsSha256Hex(anchorsC0a), C0b_hash: jcsSha256Hex(anchors) },
      }, "intent_hash");
      stageRepoArtifact({ directory: evidenceDirectory, directoryFd: lock.fd, finalName: path.basename(intentPath), raw: canonicalRaw(intent) });
    }

    const c0 = asRecord(intent.C0, "intent C0");
    const expectedAnchorHash = stringField(c0.anchors_hash, "intent C0 anchors_hash");
    const intentHash = stringField(intent.intent_hash, "intent_hash");
    const verifyCheckpoint = (checkpoint: "C1" | "Ccommit" | "S4"): void => {
      const currentAuthorization = recovery
        ? verifyRecordedRealPolicyAppendStage3Authorization(ratification.authorization_evidence, authorizationBinding)
        : requireFreshStage3Authorization(authorizationBinding);
      if (currentAuthorization.message_id !== authorization.message_id || currentAuthorization.text_sha256 !== authorization.text_sha256) fail("REAL_POLICY_APPEND_AUTHORIZATION_DRIFT", `${checkpoint} authorization differs`);
      const phase: Stage3EventPhase = checkpoint === "S4" ? "post_mutation" : checkpoint === "Ccommit" ? "commit_ready" : "pre_mutation";
      const anchors = captureClosedStableAnchors(repoRoot, preview, currentAuthorization, phase, intentHash);
      if (jcsSha256Hex(anchors) !== expectedAnchorHash) fail("REAL_POLICY_APPEND_STABLE_ANCHOR_DRIFT", `${checkpoint} closed stable anchors differ`, { checkpoint, expected: expectedAnchorHash, actual: jcsSha256Hex(anchors) });
    };
    verifyCheckpoint("C1");
    const event = convergeFixedEvent({ firstShard: CONFINED_EVENT_FIRST_SHARD, logicalTargetPath: REAL_POLICY_APPEND_ABSOLUTE_TARGET, intentHash, beforeCommit: () => verifyCheckpoint("Ccommit") });
    let terminalStatus: "COMPLETE" | "target_durable_evidence_incomplete" = "COMPLETE";
    let observedDrift: Readonly<Record<string, unknown>> | null = null;
    try { verifyCheckpoint("S4"); }
    catch (error) {
      terminalStatus = "target_durable_evidence_incomplete";
      observedDrift = deepFreeze({ code: error instanceof RealPolicyAppendExecuteError ? error.code : "UNKNOWN", message: errorMessage(error), observed_by_completed_check: true });
    }
    const post = withSelfHash({
      schema_version: POST_SCHEMA,
      canonicalization: "RFC8785-JCS",
      hash_algorithm: "sha256",
      dossier_hash_scope: "sha256 over RFC8785-JCS of this object with dossier_hash omitted and no LF",
      terminal_status: terminalStatus,
      protocol_hash: PROTOCOL_HASH,
      ratification_hash: ratification.record_hash,
      intent_hash: intent.intent_hash,
      fixed_tuple: fixedTupleBinding(),
      event_result: event,
      clean_s4_observed: terminalStatus === "COMPLETE",
      observed_drift: observedDrift,
      mutation_accounting: exactAbrainMutationBinding(),
      recovery,
    }, "dossier_hash");
    stageRepoArtifact({ directory: evidenceDirectory, directoryFd: lock.fd, finalName: path.basename(postPath), raw: canonicalRaw(post) });
    if (terminalStatus !== "COMPLETE") fail("REAL_POLICY_APPEND_TARGET_DURABLE_EVIDENCE_INCOMPLETE", "target is durable but a completed S4 check observed drift", { dossier_hash: post.dossier_hash });
    return deepFreeze({ status: "COMPLETE", recovery, event, ratification_hash: ratification.record_hash, intent_hash: intent.intent_hash, dossier_hash: post.dossier_hash });
  } finally { fs.closeSync(lock.fd); }
}

/**
 * The only S2 repair entry. It never creates or rewrites ratification/intent and
 * accepts only the recovery-specific authorization bound to the recovery dossier.
 */
export function executeRealPolicyAppendRecovery(options: { repoRoot: string }): Readonly<Record<string, unknown>> {
  const repoRoot = exactDirectory(options.repoRoot, "repository root");
  if (repoRoot !== HARD_REPO_ROOT) notAuthorized("FIXED_PRODUCTION_REPOSITORY_REQUIRED", "recovery executor accepts only the fixed repository");
  if (process.env.PI_ASTACK_REAL_POLICY_APPEND_CONFINED !== "1") notAuthorized("EFFECTIVE_BWRAP_REQUIRED", "recovery requires the official verified-FD bubblewrap launcher");
  const evidenceDirectory = exactDirectory(CONFINED_EVIDENCE_DIRECTORY, "confined retained evidence directory");
  assertEffectiveConfinement(evidenceDirectory);
  const lock = acquireEvidenceDirectoryLock(evidenceDirectory);
  if (lock.status === "BUSY") { fs.closeSync(lock.fd); fail("REAL_POLICY_APPEND_BUSY", "another official executor holds the evidence-directory OFD lock"); }
  try {
    const recoveryPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_RECOVERY_DOSSIER_RELATIVE));
    const recoveryRaw = readExactRegular(recoveryPath, "S2 recovery-ready dossier");
    const dossier = parseCanonicalSelfHashed(recoveryRaw.raw, "recovery_dossier_hash", RECOVERY_DOSSIER_SCHEMA, recoveryPath);
    validateRecoveryReadyDossier(dossier, recoveryRaw.raw_sha256);

    const previewPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_PREVIEW_RELATIVE));
    const ratificationPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_RATIFICATION_RELATIVE));
    const intentPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_INTENT_RELATIVE));
    const postPath = path.join(evidenceDirectory, path.basename(REAL_POLICY_APPEND_POST_RELATIVE));
    const previewRaw = readExactRegular(previewPath, "old execution-ready dossier");
    const ratificationRaw = readExactRegular(ratificationPath, "old ratification");
    const intentRaw = readExactRegular(intentPath, "old intent");
    if (previewRaw.raw_sha256 !== RECOVERY_PREVIEW_RAW_SHA256 || ratificationRaw.raw_sha256 !== RECOVERY_RATIFICATION_RAW_SHA256 || intentRaw.raw_sha256 !== RECOVERY_INTENT_RAW_SHA256) fail("REAL_POLICY_APPEND_RECOVERY_OLD_RECORD_DRIFT", "old execution-ready, ratification, or intent raw bytes differ");
    const preview = parseCanonicalSelfHashed(previewRaw.raw, "dossier_hash", PREVIEW_SCHEMA, previewPath);
    const ratification = parseCanonicalSelfHashed(ratificationRaw.raw, "record_hash", RATIFICATION_SCHEMA, ratificationPath);
    const intent = parseCanonicalSelfHashed(intentRaw.raw, "intent_hash", INTENT_SCHEMA, intentPath);
    if (preview.dossier_hash !== RECOVERY_PREVIEW_SELF_HASH || ratification.record_hash !== RECOVERY_RATIFICATION_SELF_HASH || intent.intent_hash !== RECOVERY_INTENT_SELF_HASH) fail("REAL_POLICY_APPEND_RECOVERY_OLD_RECORD_DRIFT", "old execution-ready, ratification, or intent self hash differs");
    validateRatification(ratification, preview, previewRaw.raw_sha256);
    validateIntent(intent, ratification, preview);
    const originalAuthorization = verifyRecordedRealPolicyAppendStage3Authorization(ratification.authorization_evidence, realPolicyAppendStage3AuthorizationBinding(preview, previewRaw.raw_sha256));
    verifyRecoverySourceClosure(repoRoot, dossier);

    // C1 classifies target-first across S0-S4; the ready dossier authorizes only its exact S2 continuation.
    const intentHash = stringField(intent.intent_hash, "intent_hash");
    const c1State = classifyFixedEventState({ firstShard: CONFINED_EVENT_FIRST_SHARD, intentHash });
    if (!( ["S0", "S1", "S2", "S3", "S4"] as string[]).includes(c1State)) fail("REAL_POLICY_APPEND_RECOVERY_C1", "C1 target-first state is outside the recovery contract", { c1State });
    const s2Shape = captureRecoveryS2Shape(CONFINED_EVENT_FIRST_SHARD, intentHash, postPath);
    if (c1State !== "S2" || canonicalizeJcs(s2Shape) !== canonicalizeJcs(asRecord(dossier.current_s2_shape, "recovery dossier current S2 shape"))) fail("REAL_POLICY_APPEND_RECOVERY_S2_REQUIRED", "recovery dossier and live target-first state are not the exact authorized S2 shape", { c1State });
    const liveHardAnchors = captureRecoveryHardAnchors(previewRaw.raw_sha256, preview, ratificationRaw.raw_sha256, ratification, intentRaw.raw_sha256, intent, originalAuthorization, s2Shape);
    const recordedHardAnchors = asRecord(dossier.hard_anchors, "recovery dossier hard anchors");
    if (recordedHardAnchors.hard_anchor_hash !== jcsSha256Hex(liveHardAnchors) || canonicalizeJcs(recordedHardAnchors.anchors) !== canonicalizeJcs(liveHardAnchors)) fail("REAL_POLICY_APPEND_RECOVERY_HARD_ANCHOR_DRIFT", "recovery hard anchors differ before mutation");

    const recoveryBinding = recoveryAuthorizationBinding(dossier, recoveryRaw.raw_sha256, s2Shape, liveHardAnchors);
    const repairAuthorization = requireFreshRecoveryAuthorization(recoveryBinding);
    const beforeRatification = ratificationRaw.raw_sha256;
    const beforeIntent = intentRaw.raw_sha256;
    const event = convergeFixedEvent({
      firstShard: CONFINED_EVENT_FIRST_SHARD,
      logicalTargetPath: REAL_POLICY_APPEND_ABSOLUTE_TARGET,
      intentHash,
      beforeCommit: (context) => assertRecoveryCommitCheckpoint(context, intentHash),
    });
    if (classifyFixedEventState({ firstShard: CONFINED_EVENT_FIRST_SHARD, intentHash }) !== "S4") fail("REAL_POLICY_APPEND_RECOVERY_S4", "S4 requires the exact target-only durable state");
    if (readExactRegular(ratificationPath, "old ratification after recovery").raw_sha256 !== beforeRatification || readExactRegular(intentPath, "old intent after recovery").raw_sha256 !== beforeIntent) fail("REAL_POLICY_APPEND_RECOVERY_OLD_RECORD_MUTATION", "recovery changed ratification or intent");
    if (lstatMaybe(postPath)) fail("REAL_POLICY_APPEND_RECOVERY_POST_PRESENT", "terminal post must be absent before the one recovery terminal write");
    const post = withSelfHash({
      schema_version: POST_SCHEMA,
      canonicalization: "RFC8785-JCS",
      hash_algorithm: "sha256",
      dossier_hash_scope: "sha256 over RFC8785-JCS of this object with dossier_hash omitted and no LF",
      terminal_status: "COMPLETE",
      protocol_hash: PROTOCOL_HASH,
      ratification_hash: ratification.record_hash,
      intent_hash: intent.intent_hash,
      fixed_tuple: fixedTupleBinding(),
      event_result: event,
      clean_s4_observed: true,
      observed_drift: null,
      mutation_accounting: exactAbrainMutationBinding(),
      recovery: true,
      recovery_authorization: {
        recovery_dossier_raw_sha256: recoveryRaw.raw_sha256,
        recovery_dossier_hash: dossier.recovery_dossier_hash,
        message_id: repairAuthorization.message_id,
        message_line_number: repairAuthorization.message_line_number,
        text_sha256: repairAuthorization.text_sha256,
        human_authorization_contract_hash: repairAuthorization.human_authorization_contract_hash,
        machine_authorization_binding_hash: recoveryBinding.machine_authorization_binding.machine_authorization_binding_hash,
      },
    }, "dossier_hash");
    stageRepoArtifact({ directory: evidenceDirectory, directoryFd: lock.fd, finalName: path.basename(postPath), raw: canonicalRaw(post) });
    return deepFreeze({ status: "COMPLETE", recovery: true, event, dossier_hash: post.dossier_hash, human_authorization_sha256: repairAuthorization.text_sha256, machine_authorization_binding_hash: recoveryBinding.machine_authorization_binding.machine_authorization_binding_hash });
  } finally { fs.closeSync(lock.fd); }
}

function validateRecoveryReadyDossier(dossier: Record<string, unknown>, rawSha256: string): void {
  exactKeys(dossier, ["schema_version", "canonicalization", "hash_algorithm", "recovery_dossier_hash_scope", "mode", "old_execution_ready_dossier", "old_stage3_records", "original_authorization", "current_s2_shape", "target_and_post", "fixed_tuple", "recovery_source_closure", "hard_anchors", "recovery_binding", "human_authorization_contract", "allowed_exact_continuation", "downstream_non_authority", "whole_abrain_inventory_evidence", "recovery_dossier_hash"], "recovery dossier");
  if (dossier.canonicalization !== "RFC8785-JCS" || dossier.hash_algorithm !== "sha256" || dossier.mode !== "read_only_s2_recovery_preview" || typeof dossier.recovery_dossier_hash !== "string") fail("REAL_POLICY_APPEND_RECOVERY_DOSSIER", "recovery dossier identity differs");
  const oldPreview = asRecord(dossier.old_execution_ready_dossier, "recovery old preview");
  const oldRecords = asRecord(dossier.old_stage3_records, "recovery old records");
  const original = asRecord(dossier.original_authorization, "recovery original authorization");
  if (oldPreview.path !== REAL_POLICY_APPEND_PREVIEW_RELATIVE || oldPreview.raw_sha256 !== RECOVERY_PREVIEW_RAW_SHA256 || oldPreview.dossier_hash !== RECOVERY_PREVIEW_SELF_HASH
    || oldRecords.ratification_raw_sha256 !== RECOVERY_RATIFICATION_RAW_SHA256 || oldRecords.ratification_hash !== RECOVERY_RATIFICATION_SELF_HASH
    || oldRecords.intent_raw_sha256 !== RECOVERY_INTENT_RAW_SHA256 || oldRecords.intent_hash !== RECOVERY_INTENT_SELF_HASH
    || canonicalizeJcs(original) !== canonicalizeJcs(oldRecords.original_authorization)
    || rawSha256 !== sha256Hex(canonicalRaw(dossier))) fail("REAL_POLICY_APPEND_RECOVERY_DOSSIER", "recovery dossier bindings or canonical bytes differ");
  const targetAndPost = asRecord(dossier.target_and_post, "recovery target/post");
  if (targetAndPost.target_state !== "absent" || targetAndPost.terminal_post_state !== "absent") fail("REAL_POLICY_APPEND_RECOVERY_DOSSIER", "recovery dossier was not captured at target/post absence");
  if (canonicalizeJcs(dossier.fixed_tuple) !== canonicalizeJcs(fixedTupleBinding())) fail("REAL_POLICY_APPEND_RECOVERY_DOSSIER", "recovery dossier fixed tuple differs");
  if (canonicalizeJcs(dossier.downstream_non_authority) !== canonicalizeJcs({ P2a: false, P2b: false, runtime: false, commit: false, push: false, restart: false })) fail("REAL_POLICY_APPEND_RECOVERY_DOSSIER", "recovery dossier downstream non-authority differs");
  const whole = asRecord(dossier.whole_abrain_inventory_evidence, "whole .abrain inventory evidence");
  if (whole.scope !== "whole_abrain_evidence_only_not_a_hard_anchor_or_gate" || typeof whole.inventory_hash !== "string") fail("REAL_POLICY_APPEND_RECOVERY_DOSSIER", "whole .abrain inventory must remain evidence-only");
  const binding = asRecord(dossier.recovery_binding, "recovery binding");
  const bindingBase = { ...binding };
  delete bindingBase.binding_hash;
  if (binding.binding_hash !== jcsSha256Hex(bindingBase)) fail("REAL_POLICY_APPEND_RECOVERY_DOSSIER", "recovery binding hash differs");
}

function recoveryAuthorizationBinding(dossier: Record<string, unknown>, dossierRawSha256: string, liveS2Shape: Readonly<Record<string, unknown>>, liveHardAnchors: Readonly<Record<string, unknown>>): RealPolicyAppendRecoveryAuthorizationBinding {
  const contract = asRecord(dossier.human_authorization_contract, "recovery human authorization contract") as RealPolicyAppendRecoveryHumanAuthorizationContract;
  const expectation = realPolicyAppendRecoveryHumanAuthorizationExpectation(contract);
  const binding = asRecord(dossier.recovery_binding, "recovery binding");
  const original = asRecord(dossier.original_authorization, "recovery original authorization");
  const sourceClosure = asRecord(dossier.recovery_source_closure, "recovery source closure");
  const recordedHardAnchors = asRecord(dossier.hard_anchors, "recovery hard anchors");
  if (contract.schema_version !== REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_CONTRACT_SCHEMA
    || canonicalizeJcs(liveS2Shape) !== canonicalizeJcs(dossier.current_s2_shape)
    || canonicalizeJcs(liveHardAnchors) !== canonicalizeJcs(recordedHardAnchors.anchors)) fail("REAL_POLICY_APPEND_RECOVERY_BINDING", "recovery human contract, live S2 shape, or hard anchors differ");
  const machineBase = {
    schema_version: "adr0040-real-policy-proposition-append-s2-recovery-machine-authorization-binding/v1",
    recovery_dossier: { path: REAL_POLICY_APPEND_RECOVERY_DOSSIER_RELATIVE, raw_sha256: dossierRawSha256, recovery_dossier_hash: dossier.recovery_dossier_hash },
    recovery_core: { binding_hash: binding.binding_hash, hard_anchor_hash: recordedHardAnchors.hard_anchor_hash },
    old_execution_ready_dossier: dossier.old_execution_ready_dossier,
    old_stage3_records: dossier.old_stage3_records,
    original_authorization: original,
    current_s2_shape: liveS2Shape,
    target_and_post: dossier.target_and_post,
    fixed_tuple: dossier.fixed_tuple,
    recovery_source_closure: sourceClosure.binding,
    allowed_exact_continuation: dossier.allowed_exact_continuation,
    downstream_non_authority: dossier.downstream_non_authority,
    whole_abrain_inventory_evidence: { scope: asRecord(dossier.whole_abrain_inventory_evidence, "whole .abrain inventory evidence").scope, inventory_hash: asRecord(dossier.whole_abrain_inventory_evidence, "whole .abrain inventory evidence").inventory_hash },
    human_authorization_contract_hash: expectation.human_authorization_contract_hash,
  };
  const machineAuthorizationBinding = deepFreeze({ ...machineBase, machine_authorization_binding_hash: jcsSha256Hex(machineBase) });
  return deepFreeze({
    human_authorization_contract: contract,
    original_authorization: { message_line_number: numberField(original.message_line_number, "recovery original authorization line"), timestamp: stringField(original.timestamp, "recovery original authorization timestamp") },
    machine_authorization_binding: machineAuthorizationBinding,
  });
}

function requireFreshRecoveryAuthorization(binding: RealPolicyAppendRecoveryAuthorizationBinding): VerifiedRealPolicyAppendRecoveryAuthorization {
  try { return verifyFreshRealPolicyAppendRecoveryAuthorization(binding); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error) notAuthorized("FRESH_RECOVERY_AUTHORIZATION_REQUIRED", "the S2 repair requires a fresh exact recovery authorization", { verifier_code: String((error as { code?: unknown }).code) });
    throw error;
  }
}

function verifyRecoverySourceClosure(repoRoot: string, dossier: Record<string, unknown>): void {
  const closure = asRecord(dossier.recovery_source_closure, "recovery source closure");
  const preimage = asRecord(closure.preimage, "recovery source closure preimage");
  if (closure.closure_hash !== jcsSha256Hex(preimage)) fail("REAL_POLICY_APPEND_RECOVERY_SOURCE_CLOSURE", "recovery source closure self hash differs");
  const rows = arrayField(preimage.source_rows, "recovery source rows");
  for (const entry of rows) {
    const row = asRecord(entry, "recovery source row");
    const relative = stringField(row.path, "recovery source path");
    if (path.isAbsolute(relative) || relative.split("/").includes("..")) fail("REAL_POLICY_APPEND_RECOVERY_SOURCE_CLOSURE", "recovery source row escapes repository", { relative });
    const opened = readExactRegular(path.join(repoRoot, ...relative.split("/")), `recovery source ${relative}`);
    if (opened.raw.length !== row.bytes || opened.raw_sha256 !== row.sha256) fail("REAL_POLICY_APPEND_RECOVERY_SOURCE_CLOSURE", "recovery source bytes differ", { relative });
  }
  const expectedExternal = asRecord(preimage.external_execution_closure, "recovery external execution closure");
  const captured = captureRealPolicyAppendExecutionClosure(repoRoot);
  try { if (canonicalizeJcs(captured.evidence) !== canonicalizeJcs(expectedExternal)) fail("REAL_POLICY_APPEND_RECOVERY_EXTERNAL_CLOSURE", "recovery external execution closure differs", { expected: jcsSha256Hex(expectedExternal), actual: jcsSha256Hex(captured.evidence) }); }
  finally { closeRealPolicyAppendExecutionClosureHandles(captured.handles); }
  const binding = asRecord(closure.binding, "recovery source closure binding");
  if (binding.closure_hash !== closure.closure_hash || binding.external_execution_closure_hash !== jcsSha256Hex(expectedExternal)) fail("REAL_POLICY_APPEND_RECOVERY_SOURCE_CLOSURE", "recovery source closure binding differs");
}

function captureRecoveryS2Shape(firstShard: string, intentHash: string, postPath: string): Readonly<Record<string, unknown>> {
  const first = procfdDirectory(exactDirectory(firstShard, "recovery retained event first shard"));
  try {
    const secondName = path.basename(EVENT_PARENT_RELATIVE);
    const second = path.join(first.path, secondName);
    const secondNamed = fs.lstatSync(second);
    if (secondNamed.isSymbolicLink() || !secondNamed.isDirectory()) fail("REAL_POLICY_APPEND_RECOVERY_S2", "S2 second shard is unsafe");
    const secondFd = fs.openSync(second, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const secondStat = fs.fstatSync(secondFd);
      if (secondStat.dev !== secondNamed.dev || secondStat.ino !== secondNamed.ino || (secondStat.mode & 0o777) !== 0o700) fail("REAL_POLICY_APPEND_RECOVERY_S2", "S2 second shard identity differs");
      if (classifyRetainedEventSecond(secondFd, intentHash) !== "S2") fail("REAL_POLICY_APPEND_RECOVERY_S2", "recovery requires exact S2");
      const tempName = deterministicEventTempBasename(intentHash);
      const temp = path.join(`/proc/self/fd/${secondFd}`, tempName);
      const tempStat = fs.lstatSync(temp);
      assertExactEventFile(temp, fixedRealPolicyAppendTuple().canonical_envelope_json, tempStat);
      const raw = fs.readFileSync(temp);
      if (sha256Hex(raw) !== fixedRealPolicyAppendTuple().canonical_envelope_raw_sha256) fail("REAL_POLICY_APPEND_RECOVERY_S2", "S2 deterministic temp raw hash differs");
      if (lstatMaybe(postPath)) fail("REAL_POLICY_APPEND_RECOVERY_POST_PRESENT", "recovery terminal post already exists");
      return deepFreeze({
        state: "S2",
        second_shard: { dev: Number(secondStat.dev), ino: Number(secondStat.ino), nlink: secondStat.nlink, mode: secondStat.mode & 0o7777, uid: secondStat.uid, gid: secondStat.gid },
        temp: { name: tempName, bytes: raw.length, raw_sha256: sha256Hex(raw), dev: Number(tempStat.dev), ino: Number(tempStat.ino), nlink: tempStat.nlink, mode: tempStat.mode & 0o7777, uid: tempStat.uid, gid: tempStat.gid },
        target_state: "absent",
        terminal_post_state: "absent",
      });
    } finally { fs.closeSync(secondFd); }
  } finally { fs.closeSync(first.fd); }
}

function captureRecoveryHardAnchors(previewRawSha256: string, preview: Record<string, unknown>, ratificationRawSha256: string, ratification: Record<string, unknown>, intentRawSha256: string, intent: Record<string, unknown>, originalAuthorization: VerifiedRealPolicyAppendStage3Authorization, s2Shape: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const c0 = asRecord(intent.C0, "recovery intent C0");
  const anchors = asRecord(c0.anchors, "recovery intent C0 anchors");
  if (c0.anchors_hash !== jcsSha256Hex(anchors) || c0.C0a_hash !== c0.anchors_hash || c0.C0b_hash !== c0.anchors_hash) fail("REAL_POLICY_APPEND_RECOVERY_HARD_ANCHOR_DRIFT", "old intent C0 anchors are malformed");
  return deepFreeze({
    old_execution_ready_dossier: { raw_sha256: previewRawSha256, dossier_hash: preview.dossier_hash },
    old_ratification: { raw_sha256: ratificationRawSha256, record_hash: ratification.record_hash },
    old_intent: { raw_sha256: intentRawSha256, intent_hash: intent.intent_hash, C0_anchors_hash: c0.anchors_hash },
    original_authorization: { message_id: originalAuthorization.message_id, message_line_number: originalAuthorization.message_line_number, text_sha256: originalAuthorization.text_sha256, transcript_prefix_sha256: originalAuthorization.transcript_prefix_sha256, continuous_parent_chain_verified: originalAuthorization.continuous_parent_chain_verified },
    fixed_tuple: fixedTupleBinding(),
    current_s2_shape_hash: jcsSha256Hex(s2Shape),
  });
}

function assertRecoveryCommitCheckpoint(context: EventCommitContext, intentHash: string): void {
  if (context.state !== "S2" || context.intentHash !== intentHash) fail("REAL_POLICY_APPEND_RECOVERY_CCOMMIT", "Ccommit context differs from the fixed intent");
  verifyRetainedEventFirst(context.firstPath, context.firstFd);
  verifyRetainedEventSecond(context.firstFd, context.secondFd);
  if (classifyRetainedEventSecond(context.secondFd, intentHash) !== "S2") fail("REAL_POLICY_APPEND_RECOVERY_CCOMMIT", "Ccommit requires retained 8c and the sole deterministic S2 temp");
}

function acquireEvidenceDirectoryLock(directory: string): { status: "ACQUIRED" | "BUSY"; fd: number } {
  assertNoSymlinkAncestors(directory);
  const retained = procfdDirectory(directory);
  const flockExecutable = process.env.PI_ASTACK_REAL_POLICY_APPEND_CONFINED === "1" ? CONFINED_FLOCK : "/usr/bin/flock";
  const flockFd = fs.openSync(flockExecutable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const result = spawnSync("/proc/self/fd/4", ["-xn", "3"], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "ignore", retained.fd, flockFd],
  });
  fs.closeSync(flockFd);
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    fs.closeSync(retained.fd);
    fail("REAL_POLICY_APPEND_FLOCK", "pinned same-OFD flock acquisition failed", { status: result.status, signal: result.signal, error: result.error?.message });
  }
  return { status: result.status === 0 ? "ACQUIRED" : "BUSY", fd: retained.fd };
}

export function realPolicyAppendStage3AuthorizationBinding(preview: Record<string, unknown>, previewRawSha256: string): RealPolicyAppendStage3AuthorizationBinding {
  const closure = asRecord(preview.source_closure, "preview source closure");
  const preimage = asRecord(closure.preimage, "preview source closure preimage");
  const contract = asRecord(preview.stage3_authorization_contract, "preview Stage3 authorization contract");
  const contractBase = { ...contract };
  delete contractBase.contract_hash;
  const spec: RealPolicyAppendStage3AuthorizationSpec = deepFreeze({
    schema_version: REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA,
    authorization_kind: "exact_fresh_role_user_stage3_production_append",
    production_append_authorized: true,
    protocol_hash: PROTOCOL_HASH,
    fresh_after_stage2: { message_id: REAL_POLICY_APPEND_STAGE2_MESSAGE_ID, text_sha256: REAL_POLICY_APPEND_STAGE2_TEXT_SHA256 },
    stage2_dossier: { path: REAL_POLICY_APPEND_PREVIEW_RELATIVE, raw_sha256: previewRawSha256, dossier_hash: stringField(preview.dossier_hash, "preview dossier_hash") },
    complete_source_closure: { closure_hash: stringField(closure.closure_hash, "preview source closure_hash"), preimage_sha256: jcsSha256Hex(preimage), source_rows_sha256: jcsSha256Hex(arrayField(preimage.source_rows, "preview source rows")), external_execution_closure_sha256: jcsSha256Hex(asRecord(preimage.external_execution_closure, "preview external execution closure")) },
    execution_closure_proofs: {
      platform_closure_sha256: jcsSha256Hex(asRecord(preview.platform_closure, "preview platform closure")),
      effective_bwrap_proof_sha256: jcsSha256Hex(asRecord(preview.effective_bwrap_proof, "preview bwrap proof")),
      flock_proof_sha256: jcsSha256Hex(asRecord(preview.flock_proof, "preview flock proof")),
      durability_proof_sha256: jcsSha256Hex(asRecord(preview.durability_and_crash_recovery, "preview durability proof")),
    },
    fixed_tuple: fixedTupleBinding(),
    repo_evidence_paths: { ratification: REAL_POLICY_APPEND_RATIFICATION_RELATIVE, intent: REAL_POLICY_APPEND_INTENT_RELATIVE, terminal_post: REAL_POLICY_APPEND_POST_RELATIVE },
    abrain_mutation_inventory: exactAbrainMutationBinding(),
    downstream_non_authority: { commit: false, push: false, restart: false, P2a: false, P2b: false, P3: false, P4: false, runtime_or_read_flip: false },
    authorization_contract_hash: stringField(contract.contract_hash, "Stage3 authorization contract hash"),
  });
  if (contract.contract_hash !== jcsSha256Hex(contractBase)
    || contract.schema_version !== REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_CONTRACT_SCHEMA
    || contract.authorization_spec_schema !== REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA
    || contract.renderer !== REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER
    || contract.renderer_definition_sha256 !== sha256Hex(REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION)
    || canonicalizeJcs(contract.required_spec_fields) !== canonicalizeJcs([...REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_REQUIRED_SPEC_FIELDS])
    || contract.exact_full_text_hash_and_bytes_required !== true
    || contract.exact_text_hash_computed_only_after_explicit_stage3_request !== true
    || contract.latest_role_user_required !== true
    || contract.continuous_parent_chain_required !== true
    || contract.fresh_after_stage2_required !== true
    || contract.authorization_text_generated !== false
    || contract.current_stage2_message_can_satisfy !== false) fail("REAL_POLICY_APPEND_STAGE3_SPEC", "dossier Stage3 authorization contract differs");
  return deepFreeze({ authorization_spec: spec });
}

function fixedTupleBinding(): Readonly<Record<string, unknown>> {
  const tuple = fixedRealPolicyAppendTuple();
  return deepFreeze({
    event_id: tuple.event_id,
    body_hash: tuple.body_hash,
    target_path: tuple.absolute_target_path,
    relative_target_path: tuple.relative_target_path,
    canonical_envelope_raw_sha256: tuple.canonical_envelope_raw_sha256,
    canonical_envelope_utf8_bytes_including_lf: tuple.canonical_envelope_utf8_bytes_including_lf,
    caller_supplied_tuple_fields: tuple.caller_supplied_tuple_fields,
  });
}

function exactAbrainMutationBinding(): Readonly<Record<string, unknown>> {
  return deepFreeze({
    terminal_created: [EVENT_PARENT_RELATIVE, REAL_POLICY_APPEND_RELATIVE_TARGET],
    terminal_modified: [],
    terminal_removed: [],
    transient_created_then_removed: [`${EVENT_PARENT_RELATIVE}/.${REAL_POLICY_APPEND_EVENT_ID}.json.0.0.<intent_hash_first_16>.tmp`],
    no_shard_deletion: true,
  });
}

function validateRatification(ratification: Record<string, unknown>, preview: Record<string, unknown>, previewRawSha256: string): void {
  exactKeys(ratification, ["schema_version", "canonicalization", "hash_algorithm", "record_hash_scope", "record_kind", "protocol_hash", "stage3_authorized", "preview", "fixed_tuple", "authorization_evidence", "exact_repo_outputs", "exact_abrain_mutation", "non_authority", "record_hash"], "ratification");
  if (ratification.canonicalization !== "RFC8785-JCS" || ratification.hash_algorithm !== "sha256" || ratification.record_hash_scope !== "sha256 over RFC8785-JCS of this object with record_hash omitted and no LF") fail("REAL_POLICY_APPEND_SCHEMA", "ratification canonicalization/hash contract differs");
  const authEvidence = asRecord(ratification.authorization_evidence, "ratification authorization evidence");
  exactKeys(authEvidence, ["session_jsonl_path", "session_id", "message_id", "message_parent_id", "message_line_number", "timestamp", "role", "text_utf8_bytes", "text_sha256", "transcript_prefix_bytes", "transcript_prefix_sha256", "continuous_parent_chain_verified", "latest_role_user_message_verified", "fresh_after_stage2_verified", "fresh_verified", "exact_full_text_verified", "authorization_spec_hash", "authorization_expectation", "caller_supplied_raw_text"], "ratification authorization evidence");
  const previewBinding = asRecord(ratification.preview, "ratification preview");
  exactKeys(previewBinding, ["path", "raw_sha256", "dossier_hash", "source_closure_hash"], "ratification preview");
  const authorizationBinding = realPolicyAppendStage3AuthorizationBinding(preview, previewRawSha256);
  const expectedAuthorization = realPolicyAppendStage3AuthorizationExpectation(authorizationBinding.authorization_spec);
  const tupleBinding = asRecord(ratification.fixed_tuple, "ratification fixed tuple");
  if (ratification.protocol_hash !== PROTOCOL_HASH || ratification.stage3_authorized !== true || ratification.record_kind !== "real_user_stage3_ratification"
    || previewBinding.path !== REAL_POLICY_APPEND_PREVIEW_RELATIVE || previewBinding.raw_sha256 !== previewRawSha256
    || previewBinding.dossier_hash !== preview.dossier_hash || previewBinding.source_closure_hash !== asRecord(preview.source_closure, "preview source closure").closure_hash
    || authEvidence.session_jsonl_path !== REAL_POLICY_APPEND_STAGE2_SESSION_PATH || authEvidence.session_id !== REAL_POLICY_APPEND_STAGE2_SESSION_ID
    || authEvidence.role !== "user" || typeof authEvidence.message_line_number !== "number" || authEvidence.message_line_number <= REAL_POLICY_APPEND_STAGE2_LINE || typeof authEvidence.timestamp !== "string" || Date.parse(authEvidence.timestamp) <= Date.parse(REAL_POLICY_APPEND_STAGE2_TIMESTAMP)
    || authEvidence.continuous_parent_chain_verified !== true || authEvidence.latest_role_user_message_verified !== true || authEvidence.fresh_after_stage2_verified !== true || authEvidence.fresh_verified !== true || authEvidence.exact_full_text_verified !== true || authEvidence.caller_supplied_raw_text !== false
    || authEvidence.authorization_spec_hash !== expectedAuthorization.authorization_spec_hash || authEvidence.text_utf8_bytes !== expectedAuthorization.exact_text_utf8_bytes || authEvidence.text_sha256 !== expectedAuthorization.exact_text_sha256
    || canonicalizeJcs(authEvidence.authorization_expectation) !== canonicalizeJcs(expectedAuthorization)
    || canonicalizeJcs(tupleBinding) !== canonicalizeJcs(fixedTupleBinding())
    || canonicalizeJcs(ratification.exact_repo_outputs) !== canonicalizeJcs(REAL_POLICY_APPEND_STAGE3_OUTPUTS)
    || canonicalizeJcs(ratification.exact_abrain_mutation) !== canonicalizeJcs(exactAbrainMutationBinding())
    || canonicalizeJcs(ratification.non_authority) !== canonicalizeJcs(["commit", "push", "restart", "P2a", "P2b", "runtime", "P3", "P4"])) {
    notAuthorized("STAGE3_RATIFICATION_BINDING_INVALID", "ratification does not bind the exact Stage2 closure, tuple, outputs, and mutation protocol");
  }
}

function validateIntent(intent: Record<string, unknown>, ratification: Record<string, unknown>, preview: Record<string, unknown>): void {
  exactKeys(intent, ["schema_version", "canonicalization", "hash_algorithm", "intent_hash_scope", "protocol_hash", "production_append_authorized", "ratification_hash", "preview_dossier_hash", "source_closure_hash", "event_id", "target_path", "canonical_envelope_raw_sha256", "authorization_evidence", "C0", "intent_hash"], "intent");
  if (intent.canonicalization !== "RFC8785-JCS" || intent.hash_algorithm !== "sha256" || intent.intent_hash_scope !== "sha256 over RFC8785-JCS of this object with intent_hash omitted and no LF") fail("REAL_POLICY_APPEND_SCHEMA", "intent canonicalization/hash contract differs");
  const c0 = asRecord(intent.C0, "intent C0");
  exactKeys(c0, ["anchors", "anchors_hash", "C0a_hash", "C0b_hash"], "intent C0");
  const anchors = asRecord(c0.anchors, "intent C0 anchors");
  if (intent.protocol_hash !== PROTOCOL_HASH || intent.production_append_authorized !== true
    || intent.ratification_hash !== ratification.record_hash || intent.preview_dossier_hash !== preview.dossier_hash
    || intent.source_closure_hash !== asRecord(preview.source_closure, "preview source closure").closure_hash
    || intent.event_id !== REAL_POLICY_APPEND_EVENT_ID || intent.target_path !== REAL_POLICY_APPEND_ABSOLUTE_TARGET
    || intent.canonical_envelope_raw_sha256 !== fixedRealPolicyAppendTuple().canonical_envelope_raw_sha256
    || canonicalizeJcs(intent.authorization_evidence) !== canonicalizeJcs(ratification.authorization_evidence)
    || c0.anchors_hash !== jcsSha256Hex(anchors) || c0.C0a_hash !== c0.anchors_hash || c0.C0b_hash !== c0.anchors_hash) fail("REAL_POLICY_APPEND_INTENT_BINDING", "execution intent binding differs");
}

function validateTerminalPost(file: string, ratification: Record<string, unknown>, intent: Record<string, unknown>, state: EventDurableState): Readonly<Record<string, unknown>> {
  if (state !== "S4") fail("REAL_POLICY_APPEND_POST_TARGET_PRECEDENCE", "terminal post exists but target is not exact durable S4", { state });
  const post = readCanonicalSelfHashed(file, "dossier_hash", POST_SCHEMA);
  const recoveryKeys = post.recovery === true ? ["recovery_authorization"] : [];
  exactKeys(post, ["schema_version", "canonicalization", "hash_algorithm", "dossier_hash_scope", "terminal_status", "protocol_hash", "ratification_hash", "intent_hash", "fixed_tuple", "event_result", "clean_s4_observed", "observed_drift", "mutation_accounting", "recovery", ...recoveryKeys, "dossier_hash"], "terminal post");
  if (post.recovery === true) {
    const recoveryAuthorization = asRecord(post.recovery_authorization, "terminal recovery authorization");
    exactKeys(recoveryAuthorization, ["recovery_dossier_raw_sha256", "recovery_dossier_hash", "message_id", "message_line_number", "text_sha256", "human_authorization_contract_hash", "machine_authorization_binding_hash"], "terminal recovery authorization");
  }
  const eventResult = asRecord(post.event_result, "terminal event result");
  exactKeys(eventResult, ["initial_state", "final_state", "target", "identical"], "terminal event result");
  const complete = post.terminal_status === "COMPLETE";
  if (!(["COMPLETE", "target_durable_evidence_incomplete"] as unknown[]).includes(post.terminal_status)
    || post.canonicalization !== "RFC8785-JCS" || post.hash_algorithm !== "sha256" || post.dossier_hash_scope !== "sha256 over RFC8785-JCS of this object with dossier_hash omitted and no LF"
    || post.protocol_hash !== PROTOCOL_HASH || post.ratification_hash !== ratification.record_hash || post.intent_hash !== intent.intent_hash
    || canonicalizeJcs(post.fixed_tuple) !== canonicalizeJcs(fixedTupleBinding()) || canonicalizeJcs(post.mutation_accounting) !== canonicalizeJcs(exactAbrainMutationBinding())
    || eventResult.final_state !== "S4" || eventResult.target !== REAL_POLICY_APPEND_ABSOLUTE_TARGET || typeof eventResult.identical !== "boolean"
    || post.clean_s4_observed !== complete || (complete ? post.observed_drift !== null : !post.observed_drift)) fail("REAL_POLICY_APPEND_POST_BINDING", "terminal post is malformed, foreign, or differently bound");
  return deepFreeze({ status: post.terminal_status, recovery: true, identical: true, dossier_hash: post.dossier_hash, intent_hash: intent.intent_hash, ratification_hash: ratification.record_hash });
}

interface ExecutionClosureHandle { path: string; actual_path: string; fd: number; raw: Buffer; raw_sha256: string; identity: Readonly<Record<string, unknown>> }

/** Captured in Stage2 and recaptured byte-for-byte inside the Stage3 FD-pinned namespace. */
export function captureRealPolicyAppendExecutionClosure(repoRootInput: string): { evidence: Readonly<Record<string, unknown>>; handles: { node: ExecutionClosureHandle; flock: ExecutionClosureHandle; bwrap: ExecutionClosureHandle } } {
  const repoRoot = exactDirectory(repoRootInput, "execution closure repository");
  const confined = process.env.PI_ASTACK_REAL_POLICY_APPEND_CONFINED === "1";
  const node = openClosureExecutable(HARD_NODE_EXECUTABLE, confined ? "/run/pi-astack/node" : process.execPath, "Node runtime");
  const flock = openClosureExecutable("/usr/bin/flock", confined ? CONFINED_FLOCK : "/usr/bin/flock", "flock");
  const bwrap = openClosureExecutable("/usr/bin/bwrap", confined ? "/run/pi-astack/bwrap" : "/usr/bin/bwrap", "bubblewrap");
  const ldd = openClosureExecutable("/usr/bin/ldd", confined ? "/run/pi-astack/ldd" : "/usr/bin/ldd", "ldd");
  const versions = { node: runClosureFd(node, ["--version"]).stdout.trim(), flock: runClosureFd(flock, ["--version"]).stdout.trim(), bwrap: runClosureFd(bwrap, ["--version"]).stdout.trim() };
  const loaderRows = new Map<string, Readonly<Record<string, unknown>>>();
  for (const executable of [node, flock, bwrap]) {
    const result = spawnSync("/proc/self/fd/3", [executable.actual_path], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", ldd.fd] });
    if (result.error || result.status !== 0 || result.signal || result.stderr) fail("REAL_POLICY_APPEND_LDD", "verified ldd closure capture failed", { executable: executable.path, status: result.status, signal: result.signal, stderr: result.stderr });
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/=>\s+(\/[^\s]+)|^\s*(\/[^\s]+)/);
      const requested = match?.[1] ?? match?.[2];
      if (!requested) continue;
      const real = fs.realpathSync.native(requested);
      const opened = openClosureRegular(real, real, `loader/DSO ${requested}`);
      try { loaderRows.set(real, deepFreeze({ requested_path: requested, real_path: real, bytes: opened.raw.length, sha256: opened.raw_sha256, identity: opened.identity })); }
      finally { fs.closeSync(opened.fd); }
    }
  }
  const sourcePrefix = confined ? "/run/pi-astack/source" : repoRoot;
  const jcsLogical = path.join(repoRoot, "extensions/_shared/jcs.ts");
  const jcs = openClosureRegular(jcsLogical, path.join(sourcePrefix, "extensions/_shared/jcs.ts"), "JCS implementation");
  const jcsVectors = [null, true, 0, -0, "text", [3, 2, 1], { b: 2, a: 1 }].map((value) => ({ input: value, canonical: canonicalizeJcs(value), sha256: jcsSha256Hex(value) }));
  fs.closeSync(jcs.fd);

  const hostRequire = createRequire(path.join(repoRoot, "package.json"));
  const hostJitiEntry = hostRequire.resolve("jiti");
  const hostJitiPackage = hostRequire.resolve("jiti/package.json");
  const logicalJitiRoot = path.dirname(hostJitiPackage);
  const actualJitiRoot = confined ? "/run/pi-astack/node_modules/jiti" : logicalJitiRoot;
  const jitiRows: Array<Readonly<Record<string, unknown>>> = [];
  const walkJiti = (actual: string): void => {
    const relative = path.relative(actualJitiRoot, actual).split(path.sep).join("/") || ".";
    const named = fs.lstatSync(actual);
    if (named.isSymbolicLink()) fail("REAL_POLICY_APPEND_JITI_CLOSURE", "Jiti package contains a symlink", { relative });
    if (named.isDirectory()) {
      const fd = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        const children = fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare);
        jitiRows.push(deepFreeze({ path: relative, kind: "directory", children, identity: closureIdentity(opened) }));
        for (const child of children) walkJiti(path.join(actual, child));
        if (!sameStatIdentity(opened, fs.fstatSync(fd)) || canonicalizeJcs(children) !== canonicalizeJcs(fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare))) fail("REAL_POLICY_APPEND_JITI_CLOSURE", "Jiti directory changed during capture", { relative });
      } finally { fs.closeSync(fd); }
      return;
    }
    if (!named.isFile()) fail("REAL_POLICY_APPEND_JITI_CLOSURE", "Jiti package contains an unsupported entry", { relative });
    const logical = path.join(logicalJitiRoot, ...relative.split("/"));
    const opened = openClosureRegular(logical, actual, `Jiti ${relative}`);
    try { jitiRows.push(deepFreeze({ path: relative, kind: "file", bytes: opened.raw.length, sha256: opened.raw_sha256, identity: opened.identity })); }
    finally { fs.closeSync(opened.fd); }
  };
  walkJiti(actualJitiRoot);
  jitiRows.sort((left, right) => compare(String(left.path), String(right.path)));
  const procStat = fs.statSync("/proc/self/fd");
  const procFs = fs.statfsSync("/proc");
  const base = deepFreeze({
    schema_version: CLOSURE_SCHEMA,
    complete: true,
    official_node: { version: versions.node, executable: closureHandleEvidence(node), required_apis: ["O_NOFOLLOW", "O_DIRECTORY", "fsync", "hardlink", "procfs_dirfd", "spawn_fd_handoff"] },
    pinned_flock: { version: versions.flock, executable: closureHandleEvidence(flock), acquire: "verified /run/pi-astack/flock FD -xn 3" },
    bubblewrap: { version: versions.bwrap, executable: closureHandleEvidence(bwrap), bind_method: "verified FD execution plus bind-fd/ro-bind-fd" },
    ldd: closureHandleEvidence(ldd),
    loader_dso_rows: [...loaderRows.values()].sort((left, right) => compare(String(left.real_path), String(right.real_path))),
    jiti: { package_root: logicalJitiRoot, resolved_entry: hostJitiEntry, resolved_entry_relative: path.relative(logicalJitiRoot, hostJitiEntry).split(path.sep).join("/"), package_json: hostJitiPackage, rows: jitiRows, rows_hash: jcsSha256Hex(jitiRows), no_symlinks: true },
    jcs: { path: "extensions/_shared/jcs.ts", bytes: jcs.raw.length, sha256: jcs.raw_sha256, identity: jcs.identity, vectors: jcsVectors, canonicalization: "RFC8785-JCS" },
    procfs: { mount_path: "/proc", statfs_type: Number(procFs.type), self_fd_directory: "/proc/self/fd", self_fd_mode: procStat.mode, readable: procStat.isDirectory(), fd_relative_identity_verified: true },
  });
  fs.closeSync(ldd.fd);
  return { evidence: deepFreeze({ ...base, closure_hash: jcsSha256Hex(base) }), handles: { node, flock, bwrap } };
}

export function closeRealPolicyAppendExecutionClosureHandles(handles: { node: ExecutionClosureHandle; flock: ExecutionClosureHandle; bwrap: ExecutionClosureHandle }): void { for (const handle of Object.values(handles)) fs.closeSync(handle.fd); }

function verifyPreviewExecutionClosure(repoRoot: string, preview: Record<string, unknown>): void {
  verifyPreviewSourceClosure(repoRoot, preview);
  const sourceClosure = asRecord(preview.source_closure, "preview source closure");
  const preimage = asRecord(sourceClosure.preimage, "preview source closure preimage");
  const expected = asRecord(preimage.external_execution_closure, "preview external execution closure");
  const captured = captureRealPolicyAppendExecutionClosure(repoRoot);
  try {
    if (canonicalizeJcs(captured.evidence) !== canonicalizeJcs(expected)) { const difference = firstClosureDifference(expected, captured.evidence); fail("REAL_POLICY_APPEND_EXECUTION_CLOSURE_DRIFT", "Node/Jiti/bwrap/flock/loader/DSO/procfs/JCS execution closure differs", { expected_hash: jcsSha256Hex(expected), actual_hash: jcsSha256Hex(captured.evidence), difference }); }
    if (canonicalizeJcs(preview.platform_closure) !== canonicalizeJcs(expected)) fail("REAL_POLICY_APPEND_EXECUTION_CLOSURE_DRIFT", "dossier platform closure and source closure external proof differ");
  } finally { closeRealPolicyAppendExecutionClosureHandles(captured.handles); }
}

function firstClosureDifference(expected: unknown, actual: unknown, at = "$" ): Readonly<Record<string, unknown>> | null {
  if (canonicalizeJcs(expected) === canonicalizeJcs(actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return deepFreeze({ at, expected_length: expected.length, actual_length: actual.length });
    for (let index = 0; index < expected.length; index += 1) { const child = firstClosureDifference(expected[index], actual[index], `${at}[${index}]`); if (child) return child; }
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual)) {
    const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compare);
    for (const key of keys) { if (!(key in left) || !(key in right)) return deepFreeze({ at: `${at}.${key}`, expected_present: key in left, actual_present: key in right }); const child = firstClosureDifference(left[key], right[key], `${at}.${key}`); if (child) return child; }
  }
  return deepFreeze({ at, expected, actual });
}

function classifyTargetFirst(firstShardInput: string): "absent" | "exact" | "foreign" {
  const firstShard = exactDirectory(firstShardInput, "retained event first shard");
  const first = procfdDirectory(firstShard);
  try {
    const second = path.join(first.path, path.basename(EVENT_PARENT_RELATIVE));
    const secondStat = lstatMaybe(second);
    if (!secondStat) return "absent";
    if (secondStat.isSymbolicLink() || !secondStat.isDirectory()) return "foreign";
    const secondFd = fs.openSync(second, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(secondFd);
      if (opened.dev !== secondStat.dev || opened.ino !== secondStat.ino || (opened.mode & 0o777) !== 0o700) return "foreign";
      const target = path.join(`/proc/self/fd/${secondFd}`, path.basename(REAL_POLICY_APPEND_RELATIVE_TARGET));
      const targetStat = lstatMaybe(target);
      if (!targetStat) return "absent";
      try { assertExactEventFile(target, fixedRealPolicyAppendTuple().canonical_envelope_json, targetStat); }
      catch { return "foreign"; }
      return targetStat.nlink === 1 ? "exact" : "foreign";
    } finally { fs.closeSync(secondFd); }
  } finally { fs.closeSync(first.fd); }
}

function openClosureExecutable(logical: string, actual: string, label: string): ExecutionClosureHandle { const opened = openClosureRegular(logical, actual, label); if ((Number(opened.identity.mode) & 0o111) === 0) { fs.closeSync(opened.fd); fail("REAL_POLICY_APPEND_EXECUTABLE", `${label} is not executable`, { logical, actual }); } return opened; }
function openClosureRegular(logicalInput: string, actualInput: string, label: string): ExecutionClosureHandle {
  const logical = path.resolve(logicalInput);
  const actual = path.resolve(actualInput);
  assertNoSymlinkAncestors(actual);
  const named = fs.lstatSync(actual);
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(actual) !== actual) fail("REAL_POLICY_APPEND_OPEN_UNSAFE", `${label} is not an exact regular file`, { logical, actual });
  const fd = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) { fs.closeSync(fd); fail("REAL_POLICY_APPEND_OPEN_RACE", `${label} opened identity differs`, { logical, actual }); }
  const raw = fs.readFileSync(fd);
  const after = fs.fstatSync(fd);
  if (!sameStatIdentity(opened, after) || raw.length !== opened.size) { fs.closeSync(fd); fail("REAL_POLICY_APPEND_OPEN_RACE", `${label} changed while read`, { logical, actual }); }
  return { path: logical, actual_path: actual, fd, raw, raw_sha256: sha256Hex(raw), identity: closureIdentity(opened) };
}
function closureIdentity(stat: fs.Stats): Readonly<Record<string, unknown>> {
  const confined = process.env.PI_ASTACK_REAL_POLICY_APPEND_CONFINED === "1";
  const normalizeId = (value: number): number => confined ? (value === 0 ? 1000 : value === 65534 ? 0 : value) : value;
  return deepFreeze({ dev: Number(stat.dev), ino: Number(stat.ino), size: stat.size, mode: stat.mode, uid: normalizeId(stat.uid), gid: normalizeId(stat.gid), nlink: stat.nlink, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs });
}
function closureHandleEvidence(handle: ExecutionClosureHandle): Readonly<Record<string, unknown>> { return deepFreeze({ path: handle.path, bytes: handle.raw.length, sha256: handle.raw_sha256, identity: handle.identity }); }
function runClosureFd(handle: ExecutionClosureHandle, args: string[]): { stdout: string; stderr: string } { const result = spawnSync("/proc/self/fd/3", args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", handle.fd] }); if (result.error || result.status !== 0 || result.signal) fail("REAL_POLICY_APPEND_TOOL", "verified closure executable failed", { path: handle.path, args, status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr }); return { stdout: result.stdout, stderr: result.stderr }; }

type Stage3EventPhase = "pre_mutation" | "commit_ready" | "post_mutation";

function assertStage3OutputsAbsent(repoRoot: string): void {
  for (const relative of REAL_POLICY_APPEND_STAGE3_OUTPUTS) if (lstatMaybe(path.join(repoRoot, ...relative.split("/")))) fail("REAL_POLICY_APPEND_STAGE3_PRESENT", "Stage3 output exists before Stage3", { relative });
}

function assertExactStage3EventFsm(phase: Stage3EventPhase, intentHash?: string): void {
  const first = exactDirectory(CONFINED_EVENT_FIRST_SHARD, "retained event first shard");
  const second = path.join(first, path.basename(EVENT_PARENT_RELATIVE));
  const secondStat = lstatMaybe(second);
  if (phase === "pre_mutation") {
    if (secondStat) fail("REAL_POLICY_APPEND_I0", "bootstrap C0 requires S0 with the second shard absent");
    return;
  }
  if (phase === "commit_ready") {
    if (!intentHash || classifyFixedEventState({ firstShard: first, intentHash }) !== "S2") fail("REAL_POLICY_APPEND_CCOMMIT", "Ccommit requires exact S2 with only the deterministic temp");
    return;
  }
  if (!secondStat || secondStat.isSymbolicLink() || !secondStat.isDirectory() || (secondStat.mode & 0o777) !== 0o700) fail("REAL_POLICY_APPEND_EVENT_FSM_DELTA", "post-mutation event FSM second shard differs");
  const target = path.join(second, path.basename(REAL_POLICY_APPEND_RELATIVE_TARGET));
  const targetStat = lstatMaybe(target);
  if (!targetStat) fail("REAL_POLICY_APPEND_EVENT_FSM_DELTA", "post-mutation fixed target is absent");
  assertExactEventFile(target, fixedRealPolicyAppendTuple().canonical_envelope_json, targetStat);
  const names = fs.readdirSync(second).sort(compare);
  if (targetStat.nlink !== 1 || canonicalizeJcs(names) !== canonicalizeJcs([path.basename(target)])) fail("REAL_POLICY_APPEND_EVENT_FSM_DELTA", "S4 requires the target as the sole nlink-one entry", { names, nlink: targetStat.nlink });
}

function captureClosedStableAnchors(repoRoot: string, preview: Record<string, unknown>, authorization: VerifiedRealPolicyAppendStage3Authorization, eventPhase: Stage3EventPhase, intentHash?: string): Readonly<Record<string, unknown>> {
  assertExactStage3EventFsm(eventPhase, intentHash);
  verifyPreviewExecutionClosure(repoRoot, preview);
  const tuple = fixedRealPolicyAppendTuple();
  if (tuple.event_id !== REAL_POLICY_APPEND_EVENT_ID || tuple.absolute_target_path !== REAL_POLICY_APPEND_ABSOLUTE_TARGET || tuple.caller_supplied_tuple_fields.length !== 0) fail("REAL_POLICY_APPEND_TUPLE_CORRUPTION", "fixed tuple differs at hard-anchor checkpoint");
  const propositionIds = scanPropositionIdsSync(path.join(HARD_ABRAIN_HOME, "l1/events/sha256")).filter((id) => id !== REAL_POLICY_APPEND_EVENT_ID).sort(compare);
  if (canonicalizeJcs(propositionIds) !== canonicalizeJcs([...EXPECTED_PRESTATE_IDS])) fail("REAL_POLICY_APPEND_PROPOSITION_PRESTATE", "closed proposition prestate differs", { propositionIds });
  const production = asRecord(preview.production_prestate, "preview production prestate");
  const registryExpected = asRecord(production.registry, "preview registry");
  const registry = readExactRegular(path.join(repoRoot, "schemas/l1-schema-role-registry.json"), "L1 registry");
  let registryValue: Record<string, unknown>;
  try { registryValue = asRecord(JSON.parse(registry.raw.toString("utf8")), "L1 registry JSON"); }
  catch (error) { fail("REAL_POLICY_APPEND_REGISTRY_DRIFT", "registry JSON is invalid", { error: errorMessage(error) }); }
  const propositionRegistry = Array.isArray(registryValue.entries)
    ? registryValue.entries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).domain === "proposition")
    : [];
  if (registry.raw_sha256 !== registryExpected.raw_sha256 || registryExpected.generic_write_gate !== "L1_SCHEMA_WRITE_DISABLED" || propositionRegistry.length !== 4 || propositionRegistry.some((entry) => entry.write_enabled !== false || entry.fold_eligible !== false)) fail("REAL_POLICY_APPEND_REGISTRY_DRIFT", "registry generic write/fold gate differs");
  const p2aExpected = asRecord(production.p2a, "preview P2a");
  const p2aRoot = path.join(HARD_ABRAIN_HOME, ".state/sediment/proposition-policy-push-shadow/v1");
  const latestPath = path.join(p2aRoot, "latest");
  const latestStat = fs.lstatSync(latestPath);
  if (!latestStat.isSymbolicLink()) fail("REAL_POLICY_APPEND_P2A_DRIFT", "P2a latest is not a symlink");
  const latest = fs.readlinkSync(latestPath);
  if (latest !== p2aExpected.latest_value) fail("REAL_POLICY_APPEND_P2A_DRIFT", "P2a latest differs");
  const bundleRoot = path.join(p2aRoot, latest);
  const manifest = readExactRegular(path.join(bundleRoot, "manifest.json"), "P2a manifest");
  const bundleInventory = captureNoFollowInventorySummary(bundleRoot);
  if (manifest.raw_sha256 !== p2aExpected.manifest_raw_sha256 || bundleInventory.inventory_hash !== p2aExpected.bundle_inventory_hash) fail("REAL_POLICY_APPEND_P2A_DRIFT", "P2a bundle inventory differs");
  const downstream = asRecord(asRecord(preview.downstream_bindings, "preview downstream").p2b1, "preview P2b1");
  const p2bPlan = readExactRegular(path.join(repoRoot, "docs/evidence/adr0040-p2b1-stable-view-design/implementation-authorization-plan.json"), "P2b plan");
  const p2bDossier = readExactRegular(path.join(repoRoot, "docs/evidence/2026-07-14-adr0040-p2b1-production-read-only-preview-dossier.json"), "P2b dossier");
  const transition = readExactRegular(path.join(repoRoot, "docs/transition-register.machine.json"), "P2b transition register");
  let transitionValue: unknown;
  try { transitionValue = JSON.parse(transition.raw.toString("utf8")); }
  catch (error) { fail("REAL_POLICY_APPEND_P2B_DRIFT", "P2b transition register is invalid", { error: errorMessage(error) }); }
  const matches: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") { const record = value as Record<string, unknown>; if (record.id === "proposition.adr0040-p2b-policy-push-stable-view") matches.push(record); Object.values(record).forEach(walk); } };
  walk(transitionValue);
  if (p2bPlan.raw_sha256 !== downstream.plan_raw_sha256 || p2bDossier.raw_sha256 !== downstream.dossier_raw_sha256
    || downstream.phase_status !== "blocked" || downstream.authorization_status !== "separate_authorization_required" || downstream.runtime_reachable !== false || downstream.production_destination_defined !== false
    || matches.length !== 1 || matches[0]!.phase_status !== "blocked" || matches[0]!.authorization_status !== "separate_authorization_required") fail("REAL_POLICY_APPEND_P2B_DRIFT", "P2b plan/dossier/status/runtime binding differs");
  const first = fs.lstatSync(path.join(HARD_ABRAIN_HOME, EVENT_FIRST_SHARD_RELATIVE));
  assertExactDirectory(path.join(HARD_ABRAIN_HOME, EVENT_FIRST_SHARD_RELATIVE), { mode: null });
  return deepFreeze({
    source_closure_hash: asRecord(preview.source_closure, "preview source closure").closure_hash,
    proposition_prestate_ids: propositionIds,
    fixed_tuple: { event_id: tuple.event_id, canonical_envelope_raw_sha256: tuple.canonical_envelope_raw_sha256, target_path: tuple.absolute_target_path },
    registry_raw_sha256: registry.raw_sha256,
    p2a: { latest, manifest_raw_sha256: manifest.raw_sha256, bundle_inventory_hash: bundleInventory.inventory_hash },
    p2b1: { plan_raw_sha256: p2bPlan.raw_sha256, dossier_raw_sha256: p2bDossier.raw_sha256, blocked: true, runtime_reachable: false },
    first_shard_identity: stableDirectoryIdentity(first),
    authorization: { session_id: authorization.session_id, message_id: authorization.message_id, message_line_number: authorization.message_line_number, text_sha256: authorization.text_sha256, transcript_prefix_sha256: authorization.transcript_prefix_sha256 },
  });
}

function captureNoFollowInventorySummary(rootInput: string): Readonly<Record<string, unknown>> {
  const root = exactDirectory(rootInput, "whole-abrain evidence root");
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  const walk = (file: string): void => {
    const relative = path.relative(root, file).split(path.sep).join("/") || ".";
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      const after = fs.lstatSync(file);
      if (!sameStatIdentity(before, after)) fail("REAL_POLICY_APPEND_INVENTORY_RACE", "symlink changed during no-follow inventory", { relative });
      rows.push(deepFreeze({ path: relative, kind: "symlink", mode: before.mode & 0o7777, uid: before.uid, gid: before.gid, nlink: before.nlink, target, target_sha256: sha256Hex(target) }));
      return;
    }
    if (before.isDirectory()) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        const names = fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare);
        rows.push(deepFreeze({ path: relative, kind: "directory", mode: opened.mode & 0o7777, uid: opened.uid, gid: opened.gid, nlink: opened.nlink, children_sha256: jcsSha256Hex(names) }));
        for (const name of names) walk(path.join(file, name));
        if (!sameStatIdentity(opened, fs.fstatSync(fd)) || canonicalizeJcs(names) !== canonicalizeJcs(fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare))) fail("REAL_POLICY_APPEND_INVENTORY_RACE", "directory changed during no-follow inventory", { relative });
      } finally { fs.closeSync(fd); }
      return;
    }
    if (!before.isFile()) fail("REAL_POLICY_APPEND_INVENTORY_TYPE", "unsupported whole-abrain entry", { relative });
    const opened = readExactRegular(file, `whole-abrain ${relative}`);
    rows.push(deepFreeze({ path: relative, kind: "file", mode: before.mode & 0o7777, uid: before.uid, gid: before.gid, nlink: before.nlink, bytes: opened.raw.length, sha256: opened.raw_sha256 }));
  };
  walk(root);
  rows.sort((left, right) => compare(String(left.path), String(right.path)));
  return deepFreeze({
    schema_version: "adr0040-real-policy-no-follow-inventory/v1",
    root,
    entry_count: rows.length,
    directories: rows.filter((row) => row.kind === "directory").length,
    files: rows.filter((row) => row.kind === "file").length,
    symlinks: rows.filter((row) => row.kind === "symlink").length,
    bytes: rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    inventory_hash: jcsSha256Hex(rows),
    symlink_observations: rows.filter((row) => row.kind === "symlink").map((row) => ({ path: row.path, target: row.target })),
  });
}

function scanPropositionIdsSync(root: string): string[] {
  const ids: string[] = [];
  const walk = (directory: string): void => {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      for (const name of fs.readdirSync(`/proc/self/fd/${fd}`).sort(compare)) {
        if (name.startsWith(".")) continue;
        const file = path.join(`/proc/self/fd/${fd}`, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) fail("REAL_POLICY_APPEND_PROPOSITION_SCAN", "proposition event tree contains a symlink", { file });
        if (stat.isDirectory()) { walk(path.join(directory, name)); continue; }
        if (!stat.isFile()) fail("REAL_POLICY_APPEND_PROPOSITION_SCAN", "proposition event tree contains a non-regular entry", { file });
        const opened = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const raw = fs.readFileSync(opened);
          if (!raw.includes(Buffer.from("proposition-"))) continue;
          const value = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          const body = asRecord(value.body, "proposition body");
          if (typeof body.event_schema_version === "string" && body.event_schema_version.startsWith("proposition-")) ids.push(stringField(value.event_id, "proposition event_id"));
        } finally { fs.closeSync(opened); }
      }
    } finally { fs.closeSync(fd); }
  };
  walk(root);
  return ids;
}

function verifyPreviewSourceClosure(repoRoot: string, preview: Record<string, unknown>): void {
  const closure = asRecord(preview.source_closure, "preview source closure");
  const preimage = asRecord(closure.preimage, "preview source closure preimage");
  if (closure.closure_hash !== jcsSha256Hex(preimage)) fail("REAL_POLICY_APPEND_SOURCE_CLOSURE", "preview source closure self-binding differs");
  const rows = arrayField(preimage.source_rows, "preview source rows");
  for (const input of rows) {
    const row = asRecord(input, "preview source row");
    const relative = stringField(row.path, "preview source row path");
    if (path.isAbsolute(relative) || relative.split("/").includes("..")) fail("REAL_POLICY_APPEND_SOURCE_CLOSURE", "source row escapes repository", { relative });
    const opened = readExactRegular(path.join(repoRoot, ...relative.split("/")), `source row ${relative}`);
    if (opened.raw.length !== row.bytes || opened.raw_sha256 !== row.sha256) fail("REAL_POLICY_APPEND_SOURCE_CLOSURE", "source row bytes differ", { relative });
  }
}

function assertEffectiveConfinement(evidenceDirectory: string): void {
  if (process.env.PI_ASTACK_REAL_POLICY_APPEND_CONFINED !== "1") notAuthorized("EFFECTIVE_BWRAP_REQUIRED", "production append requires the official bubblewrap launcher");
  const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n");
  const optionsFor = (mountpoint: string): string[] | null => {
    for (const line of mountinfo) {
      const fields = line.split(" ");
      if (fields[4] === mountpoint) return fields[5].split(",");
    }
    return null;
  };
  const rootOptions = optionsFor("/");
  const evidenceOptions = optionsFor(evidenceDirectory);
  const eventOptions = optionsFor(CONFINED_EVENT_FIRST_SHARD);
  if (!rootOptions?.includes("ro") || !evidenceOptions?.includes("rw") || !eventOptions?.includes("rw")) notAuthorized("EFFECTIVE_BWRAP_REQUIRED", "mount namespace is not root-read-only with only retained evidence/event writable binds", { rootOptions, evidenceOptions, eventOptions });
}

function withSelfHash(input: Record<string, unknown>, field: string): Record<string, unknown> {
  return deepFreeze({ ...input, [field]: jcsSha256Hex(input) });
}

function canonicalRaw(value: unknown): string { return `${canonicalizeJcs(value)}\n`; }

function parseCanonicalSelfHashed(raw: Buffer, selfField: string, schema: string, file: string): Record<string, unknown> {
  let value: Record<string, unknown>;
  try { value = asRecord(JSON.parse(raw.toString("utf8")), file); } catch (error) { fail("REAL_POLICY_APPEND_CANONICAL", "canonical artifact is invalid JSON", { file, error: errorMessage(error) }); }
  if (canonicalRaw(value) !== raw.toString("utf8") || value.schema_version !== schema) fail("REAL_POLICY_APPEND_CANONICAL", "canonical artifact schema or JCS+LF bytes differ", { file });
  const claimed = value[selfField];
  const base = { ...value };
  delete base[selfField];
  if (typeof claimed !== "string" || jcsSha256Hex(base) !== claimed) fail("REAL_POLICY_APPEND_CANONICAL", "canonical artifact self-hash differs", { file });
  return value;
}

function readExactRegular(file: string, label: string): { raw: Buffer; raw_sha256: string } {
  assertNoSymlinkAncestors(file);
  const named = fs.lstatSync(file);
  if (named.isSymbolicLink() || !named.isFile() || fs.realpathSync.native(file) !== file) fail("REAL_POLICY_APPEND_PATH_UNSAFE", `${label} is not an exact regular file`, { file });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!sameStatIdentity(before, after) || !sameStatIdentity(before, fs.lstatSync(file))) fail("REAL_POLICY_APPEND_READ_RACE", `${label} changed while read`, { file });
    return { raw, raw_sha256: sha256Hex(raw) };
  } finally { fs.closeSync(fd); }
}

function assertNoSymlinkAncestors(file: string): void {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const component of path.relative(current, path.dirname(resolved)).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("REAL_POLICY_APPEND_ANCESTOR_UNSAFE", "ancestor is not an exact directory", { current });
  }
}

function statIdentity(stat: fs.Stats): Readonly<Record<string, unknown>> {
  return deepFreeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink });
}

function stableDirectoryIdentity(stat: fs.Stats): Readonly<Record<string, unknown>> {
  return deepFreeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid });
}

export function deterministicEventTempBasename(intentHash: string): string {
  assertHash(intentHash, "intentHash");
  return `.${REAL_POLICY_APPEND_EVENT_ID}.json.0.0.${intentHash.slice(0, 16)}.tmp`;
}

type EventSurfaceInput = { abrainHome: string; firstShard?: never } | { firstShard: string; abrainHome?: never };
type EventCommitContext = Readonly<{ firstPath: string; firstFd: number; secondFd: number; intentHash: string; state: "S2" }>;
type EventConvergeOptions = EventSurfaceInput & { intentHash: string; logicalTargetPath?: string; beforeCommit?: (context: EventCommitContext) => void; crashAt?: EventDurableState; afterClassifyForTest?: () => void };

export function classifyFixedEventState(options: EventSurfaceInput & { intentHash: string }): EventDurableState {
  const firstPath = resolveEventFirstShard(options);
  const first = procfdDirectory(firstPath);
  let secondFd: number | null = null;
  try {
    const secondName = path.basename(EVENT_PARENT_RELATIVE);
    const second = path.join(first.path, secondName);
    const secondStat = lstatMaybe(second);
    if (!secondStat) return "S0";
    if (secondStat.isSymbolicLink() || !secondStat.isDirectory()) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "second shard is not an exact directory");
    secondFd = fs.openSync(second, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(secondFd);
    if (opened.dev !== secondStat.dev || opened.ino !== secondStat.ino || (opened.mode & 0o777) !== 0o700) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "second shard opened identity or mode differs");
    return classifyRetainedEventSecond(secondFd, options.intentHash);
  } finally { if (secondFd !== null) fs.closeSync(secondFd); fs.closeSync(first.fd); }
}

/** Fixed tuple S0-S4 primitive; every mutation is relative to retained first/second shard FDs. */
function convergeFixedEvent(options: EventConvergeOptions): Readonly<Record<string, unknown>> {
  const tuple = fixedRealPolicyAppendTuple();
  const firstPath = resolveEventFirstShard(options);
  const first = procfdDirectory(firstPath);
  let secondFd: number | null = null;
  try {
    const secondName = path.basename(EVENT_PARENT_RELATIVE);
    const secondNamed = path.join(first.path, secondName);
    const secondStat = lstatMaybe(secondNamed);
    let state: EventDurableState;
    if (!secondStat) state = "S0";
    else {
      if (secondStat.isSymbolicLink() || !secondStat.isDirectory()) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "second shard is not an exact directory");
      secondFd = fs.openSync(secondNamed, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(secondFd);
      if (opened.dev !== secondStat.dev || opened.ino !== secondStat.ino || (opened.mode & 0o777) !== 0o700) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "second shard opened identity or mode differs");
      state = classifyRetainedEventSecond(secondFd, options.intentHash);
    }
    const initial = state;
    options.afterClassifyForTest?.();
    verifyRetainedEventFirst(firstPath, first.fd);
    if (secondFd !== null) verifyRetainedEventSecond(first.fd, secondFd);
    if (state === "S4") return deepFreeze({ initial_state: initial, final_state: "S4", target: options.logicalTargetPath ?? eventTargetPath(firstPath), identical: true });
    if (state === "S0") {
      try { fs.mkdirSync(secondNamed, { mode: 0o700 }); } catch (error) { if (!isCode(error, "EEXIST")) throw error; }
      const created = fs.lstatSync(secondNamed);
      if (created.isSymbolicLink() || !created.isDirectory() || (created.mode & 0o777) !== 0o700) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "created second shard identity differs");
      secondFd = fs.openSync(secondNamed, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(secondFd);
      if (opened.dev !== created.dev || opened.ino !== created.ino) fail("REAL_POLICY_APPEND_EVENT_RACE", "created second shard was replaced before FD retention");
      fs.fsyncSync(first.fd);
      crash(options.crashAt, "S0");
      state = classifyRetainedEventSecond(secondFd, options.intentHash);
    }
    if (secondFd === null) fail("REAL_POLICY_APPEND_EVENT_DURABILITY", "second shard FD is unavailable after S0");
    const secondProc = `/proc/self/fd/${secondFd}`;
    const target = path.join(secondProc, path.basename(REAL_POLICY_APPEND_RELATIVE_TARGET));
    const temp = path.join(secondProc, deterministicEventTempBasename(options.intentHash));
    verifyRetainedEventSecond(first.fd, secondFd);
    if (state === "S2") {
      assertOwnedRegular(temp, fs.lstatSync(temp), 0o600, 1);
      fs.unlinkSync(temp);
      fs.fsyncSync(secondFd);
      state = "S1";
    }
    if (state === "S3") {
      verifyRetainedEventSecond(first.fd, secondFd);
      fs.unlinkSync(temp);
      fs.fsyncSync(secondFd);
      const targetAfter = fs.lstatSync(target);
      assertExactEventFile(target, tuple.canonical_envelope_json, targetAfter);
      if (targetAfter.nlink !== 1) fail("REAL_POLICY_APPEND_EVENT_DURABILITY", "S3 cleanup did not leave target nlink one");
      state = "S4";
    }
    if (state === "S1") {
      verifyRetainedEventSecond(first.fd, secondFd);
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.fchmodSync(fd, 0o600); writeAll(fd, Buffer.from(tuple.canonical_envelope_json)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      assertExactEventFile(temp, tuple.canonical_envelope_json, fs.lstatSync(temp));
      crash(options.crashAt, "S2");
      options.beforeCommit?.(deepFreeze({ firstPath, firstFd: first.fd, secondFd, intentHash: options.intentHash, state: "S2" as const }));
      verifyRetainedEventFirst(firstPath, first.fd);
      verifyRetainedEventSecond(first.fd, secondFd);
      if (classifyRetainedEventSecond(secondFd, options.intentHash) !== "S2") fail("REAL_POLICY_APPEND_CCOMMIT", "Ccommit requires the sole deterministic S2 temp");
      try { fs.linkSync(temp, target); } catch (error) { if (!isCode(error, "EEXIST")) throw error; }
      const tempLinked = fs.lstatSync(temp);
      const targetLinked = fs.lstatSync(target);
      if (tempLinked.dev !== targetLinked.dev || tempLinked.ino !== targetLinked.ino || tempLinked.nlink !== 2 || targetLinked.nlink !== 2) fail("REAL_POLICY_APPEND_EVENT_DURABILITY", "hardlink no-replace identity differs");
      const linkedFd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(linkedFd); } finally { fs.closeSync(linkedFd); }
      fs.fsyncSync(secondFd);
      crash(options.crashAt, "S3");
      verifyRetainedEventSecond(first.fd, secondFd);
      fs.unlinkSync(temp);
      fs.fsyncSync(secondFd);
      state = "S4";
    }
    const final = classifyRetainedEventSecond(secondFd, options.intentHash);
    if (final !== "S4") fail("REAL_POLICY_APPEND_EVENT_DURABILITY", "event did not converge to S4", { final });
    verifyRetainedEventSecond(first.fd, secondFd);
    const finalFd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(finalFd); if (fs.readFileSync(finalFd, "utf8") !== tuple.canonical_envelope_json) fail("REAL_POLICY_APPEND_EVENT_READBACK", "S4 readback differs"); }
    finally { fs.closeSync(finalFd); }
    fs.fsyncSync(secondFd);
    return deepFreeze({ initial_state: initial, final_state: final, target: options.logicalTargetPath ?? eventTargetPath(firstPath), identical: initial === "S4" });
  } finally { if (secondFd !== null) fs.closeSync(secondFd); fs.closeSync(first.fd); }
}

function classifyRetainedEventSecond(secondFd: number, intentHash: string): EventDurableState {
  const second = `/proc/self/fd/${secondFd}`;
  const tuple = fixedRealPolicyAppendTuple();
  const target = path.join(second, path.basename(tuple.relative_target_path));
  const temp = path.join(second, deterministicEventTempBasename(intentHash));
  const names = fs.readdirSync(second).sort(compare);
  const targetStat = lstatMaybe(target);
  const tempStat = lstatMaybe(temp);
  if (targetStat) {
    assertExactEventFile(target, tuple.canonical_envelope_json, targetStat);
    if (tempStat) {
      assertExactEventFile(temp, tuple.canonical_envelope_json, tempStat);
      if (targetStat.dev !== tempStat.dev || targetStat.ino !== tempStat.ino || targetStat.nlink !== 2 || tempStat.nlink !== 2 || canonicalizeJcs(names) !== canonicalizeJcs([path.basename(temp), path.basename(target)].sort(compare))) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "S3 target/temp identity differs");
      return "S3";
    }
    if (targetStat.nlink !== 1 || canonicalizeJcs(names) !== canonicalizeJcs([path.basename(target)])) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "S4 target is not the sole nlink-one entry");
    return "S4";
  }
  if (tempStat) {
    assertOwnedRegular(temp, tempStat, 0o600, 1);
    if (canonicalizeJcs(names) !== canonicalizeJcs([path.basename(temp)])) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "S2 temp is not the sole entry");
    return "S2";
  }
  if (names.length !== 0) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "S1 shard contains a foreign entry", { names });
  return "S1";
}

function resolveEventFirstShard(options: EventSurfaceInput): string {
  if ("firstShard" in options && typeof options.firstShard === "string") return exactDirectory(options.firstShard, "retained event first shard");
  const root = exactDirectory(options.abrainHome, "event sandbox root");
  return exactDirectory(path.join(root, ...EVENT_FIRST_SHARD_RELATIVE.split("/")), "event first shard");
}
function eventTargetPath(firstShard: string): string { return path.join(firstShard, path.basename(EVENT_PARENT_RELATIVE), path.basename(REAL_POLICY_APPEND_RELATIVE_TARGET)); }
function verifyRetainedEventFirst(named: string, fd: number): void { const opened = fs.fstatSync(fd); const current = fs.lstatSync(named); if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) fail("REAL_POLICY_APPEND_EVENT_ANCESTOR_SWAP", "retained first shard no longer matches its named identity", { named }); }
function verifyRetainedEventSecond(firstFd: number, secondFd: number): void { const named = path.join(`/proc/self/fd/${firstFd}`, path.basename(EVENT_PARENT_RELATIVE)); const current = fs.lstatSync(named); const opened = fs.fstatSync(secondFd); if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino || (opened.mode & 0o777) !== 0o700) fail("REAL_POLICY_APPEND_EVENT_ANCESTOR_SWAP", "retained second shard no longer matches the child bound under first shard"); }

function stageRepoArtifact(options: { directory: string; directoryFd?: number; finalName: string; raw: string; mode?: number; replaceExistingRawSha256?: string; crashAt?: "temp" | "linked"; afterDirectoryOpenForTest?: () => void }): Readonly<Record<string, unknown>> {
  const directory = exactDirectory(options.directory, "repo evidence sandbox directory");
  const mode = options.mode ?? 0o600;
  if (path.basename(options.finalName) !== options.finalName || options.finalName.startsWith(".")) fail("REAL_POLICY_APPEND_REPO_STAGE_NAME", "finalName must be one plain final leaf");
  const rawHash = sha256Hex(options.raw);
  const tempName = `.${options.finalName}.${rawHash}.tmp`;
  const ownsFd = options.directoryFd === undefined;
  const proc = ownsFd ? procfdDirectory(directory) : retainedProcfdDirectory(directory, options.directoryFd as number);
  options.afterDirectoryOpenForTest?.();
  verifyRetainedDirectoryNamed(directory, proc.fd);
  const final = path.join(proc.path, options.finalName);
  const temp = path.join(proc.path, tempName);
  try {
    const related = fs.readdirSync(proc.path).filter((name) => name === options.finalName || (name.startsWith(`.${options.finalName}.`) && name.endsWith(".tmp"))).sort(compare);
    const allowed = new Set([options.finalName, tempName]);
    const foreign = related.filter((name) => !allowed.has(name));
    if (foreign.length) fail("REAL_POLICY_APPEND_REPO_STAGE_FOREIGN", "foreign temp/final namespace entry exists", { final_name: options.finalName, foreign });
    let finalStat = lstatMaybe(final);
    const tempStat = lstatMaybe(temp);
    if (finalStat && options.replaceExistingRawSha256) {
      assertOwnedRegular(final, finalStat, mode, 1);
      const existingFd = fs.openSync(final, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let existingHash: string;
      try { const before = fs.fstatSync(existingFd); const raw = fs.readFileSync(existingFd); const after = fs.fstatSync(existingFd); if (!sameStatIdentity(before, after)) fail("REAL_POLICY_APPEND_REPO_STAGE_FOREIGN", "existing replaceable dossier changed while read"); existingHash = sha256Hex(raw); }
      finally { fs.closeSync(existingFd); }
      if (existingHash !== options.replaceExistingRawSha256) fail("REAL_POLICY_APPEND_REPO_STAGE_FOREIGN", "existing replaceable dossier bytes differ", { expected: options.replaceExistingRawSha256, actual: existingHash });
      verifyRetainedDirectoryNamed(directory, proc.fd);
      fs.unlinkSync(final);
      fs.fsyncSync(proc.fd);
      finalStat = null;
    }
    if (finalStat) {
      assertExactRepoFile(final, options.raw, finalStat, mode);
      if (tempStat) {
        assertExactRepoFile(temp, options.raw, tempStat, mode);
        if (finalStat.dev !== tempStat.dev || finalStat.ino !== tempStat.ino || finalStat.nlink !== 2 || tempStat.nlink !== 2) fail("REAL_POLICY_APPEND_REPO_STAGE_FOREIGN", "final/temp hardlink identity differs");
        fs.unlinkSync(temp);
        fs.fsyncSync(proc.fd);
      }
      const settled = fs.lstatSync(final);
      if (settled.nlink !== 1) fail("REAL_POLICY_APPEND_REPO_STAGE_FOREIGN", "settled final nlink differs");
      return deepFreeze({ status: "identical", final_name: options.finalName, temp_name: tempName, raw_sha256: rawHash });
    }
    if (tempStat) {
      assertOwnedRegular(temp, tempStat, mode, 1);
      fs.unlinkSync(temp);
      fs.fsyncSync(proc.fd);
    }
    verifyRetainedDirectoryNamed(directory, proc.fd);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try { fs.fchmodSync(fd, mode); writeAll(fd, Buffer.from(options.raw)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    assertExactRepoFile(temp, options.raw, fs.lstatSync(temp), mode);
    if (options.crashAt === "temp") process.kill(process.pid, "SIGKILL");
    verifyRetainedDirectoryNamed(directory, proc.fd);
    fs.linkSync(temp, final);
    const linkedTemp = fs.lstatSync(temp);
    const linkedFinal = fs.lstatSync(final);
    if (linkedTemp.dev !== linkedFinal.dev || linkedTemp.ino !== linkedFinal.ino || linkedTemp.nlink !== 2 || linkedFinal.nlink !== 2) fail("REAL_POLICY_APPEND_REPO_STAGE_DURABILITY", "repo hardlink identity differs");
    fs.fsyncSync(proc.fd);
    if (options.crashAt === "linked") process.kill(process.pid, "SIGKILL");
    fs.unlinkSync(temp);
    fs.fsyncSync(proc.fd);
    const finalFd = fs.openSync(final, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(finalFd); if (fs.readFileSync(finalFd, "utf8") !== options.raw) fail("REAL_POLICY_APPEND_REPO_STAGE_READBACK", "repo final readback differs"); }
    finally { fs.closeSync(finalFd); }
    fs.fsyncSync(proc.fd);
    if (fs.lstatSync(final).nlink !== 1) fail("REAL_POLICY_APPEND_REPO_STAGE_DURABILITY", "repo final nlink differs");
    return deepFreeze({ status: "created", final_name: options.finalName, temp_name: tempName, raw_sha256: rawHash });
  } finally { if (ownsFd) fs.closeSync(proc.fd); }
}

function verifyRetainedDirectoryNamed(directory: string, fd: number): void {
  const opened = fs.fstatSync(fd);
  const named = fs.lstatSync(directory);
  if (!opened.isDirectory() || named.isSymbolicLink() || !named.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino) fail("REAL_POLICY_APPEND_REPO_PARENT_SWAP", "retained directory no longer matches its named identity", { directory });
}

function retainedProcfdDirectory(directory: string, fd: number): { fd: number; path: string } {
  const proc = `/proc/self/fd/${fd}`;
  const opened = fs.fstatSync(fd);
  const named = fs.lstatSync(directory);
  if (!opened.isDirectory() || named.isSymbolicLink() || !named.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino || fs.realpathSync.native(proc) !== directory) fail("REAL_POLICY_APPEND_PROCFS_DIRFD", "retained evidence dirfd identity differs", { directory, proc });
  return { fd, path: proc };
}

function procfdDirectory(directory: string): { fd: number; path: string } {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const proc = `/proc/self/fd/${fd}`;
  const opened = fs.fstatSync(fd);
  const named = fs.lstatSync(directory);
  if (!opened.isDirectory() || named.isSymbolicLink() || !named.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino || fs.realpathSync.native(proc) !== directory) {
    fs.closeSync(fd);
    fail("REAL_POLICY_APPEND_PROCFS_DIRFD", "procfs dirfd does not resolve to the retained directory", { directory, proc });
  }
  return { fd, path: proc };
}

function readCanonicalSelfHashed(file: string, selfField: string, schema: string): Record<string, unknown> {
  try {
    const opened = readExactRegular(file, "Stage3 evidence");
    return parseCanonicalSelfHashed(opened.raw, selfField, schema, file);
  } catch (error) {
    if (error instanceof RealPolicyAppendExecuteError) throw error;
    notAuthorized("STAGE3_EVIDENCE_INVALID", "Stage3 evidence failed closed parsing", { file, error: errorMessage(error) });
  }
}

function assertExactDirectory(directory: string, options: { mode: number | null }): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== directory || (options.mode !== null && (stat.mode & 0o777) !== options.mode)) fail("REAL_POLICY_APPEND_DIRECTORY_UNSAFE", "directory identity or mode differs", { directory, mode: stat.mode & 0o777 });
}

function assertExactEventFile(file: string, expected: string, stat: fs.Stats): void {
  assertOwnedRegular(file, stat, 0o600, stat.nlink);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if (fs.readFileSync(fd, "utf8") !== expected) fail("REAL_POLICY_APPEND_EVENT_FOREIGN", "event bytes differ", { file }); }
  finally { fs.closeSync(fd); }
}

function assertExactRepoFile(file: string, expected: string, stat: fs.Stats, mode = 0o600): void {
  assertOwnedRegular(file, stat, mode, stat.nlink);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if (fs.readFileSync(fd, "utf8") !== expected) fail("REAL_POLICY_APPEND_REPO_STAGE_FOREIGN", "repo evidence bytes differ", { file }); }
  finally { fs.closeSync(fd); }
}

function assertOwnedRegular(file: string, stat: fs.Stats, mode: number, nlink: number): void {
  const uid = process.getuid?.() ?? stat.uid;
  const gid = process.getgid?.() ?? stat.gid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== mode || stat.nlink !== nlink) fail("REAL_POLICY_APPEND_FILE_UNSAFE", "regular file identity/mode/owner/nlink differs", { file, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink });
}

function requireFreshStage3Authorization(binding: RealPolicyAppendStage3AuthorizationBinding): VerifiedRealPolicyAppendStage3Authorization {
  try { return verifyFreshRealPolicyAppendStage3Authorization(binding); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error) notAuthorized("FRESH_STAGE3_AUTHORIZATION_REQUIRED", "Stage2 grants no production append authority", { verifier_code: String((error as { code?: unknown }).code) });
    throw error;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compare);
  const wanted = [...expected].sort(compare);
  if (canonicalizeJcs(actual) !== canonicalizeJcs(wanted)) fail("REAL_POLICY_APPEND_SCHEMA", `${at} keys differ`, { actual, expected: wanted });
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("REAL_POLICY_APPEND_SCHEMA", `${at} must be an object`);
  return value as Record<string, unknown>;
}

function arrayField(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("REAL_POLICY_APPEND_SCHEMA", `${at} must be an array`);
  return value;
}

function stringField(value: unknown, at: string): string {
  if (typeof value !== "string" || !value) fail("REAL_POLICY_APPEND_SCHEMA", `${at} must be a nonempty string`);
  return value;
}

function numberField(value: unknown, at: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("REAL_POLICY_APPEND_SCHEMA", `${at} must be a positive integer`);
  return value as number;
}

function sameStatIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) fail("REAL_POLICY_APPEND_SHORT_WRITE", "write made no progress");
    offset += written;
  }
}

function fsyncDirectory(directory: string): void { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function crash(actual: EventDurableState | undefined, expected: EventDurableState): void { if (actual === expected) process.kill(process.pid, "SIGKILL"); }
function exactDirectory(input: string, label: string): string { const resolved = path.resolve(input); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) fail("REAL_POLICY_APPEND_PATH_UNSAFE", `${label} is not an exact directory`, { resolved }); return resolved; }
function lstatMaybe(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; } }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code; }
function assertHash(value: unknown, at: string): asserts value is string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("REAL_POLICY_APPEND_HASH_INVALID", `${at} must be SHA-256`); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function notAuthorized(reason: string, message: string, detail?: Record<string, unknown>): never { throw new RealPolicyAppendExecuteError("NOT_AUTHORIZED", `${reason}: ${message}`, { reason, ...detail }); }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { throw new RealPolicyAppendExecuteError(code, message, detail); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }

export const __STAGE2_TEST = Object.freeze({
  convergeFixedEvent,
  stageRepoArtifact,
  classifyFixedEventState,
  procfdDirectory,
  acquireEvidenceDirectoryLock,
  validateTerminalPost,
  withSelfHash,
  canonicalRaw,
  fixedTupleBinding,
  exactAbrainMutationBinding,
  recoveryAuthorizationBinding,
  verifyClosureByteRow(file: string, expected: { bytes: number; sha256: string }, label: string): void {
    const opened = openClosureRegular(file, file, label);
    try { if (opened.raw.length !== expected.bytes || opened.raw_sha256 !== expected.sha256) fail("REAL_POLICY_APPEND_EXECUTION_CLOSURE_DRIFT", `${label} bytes differ`, { expected, actual: { bytes: opened.raw.length, sha256: opened.raw_sha256 } }); }
    finally { fs.closeSync(opened.fd); }
  },
});
