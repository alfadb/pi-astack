import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { durableAtomicCreateFile } from "./durable-write";
import {
  cohortManifestRoot,
  convergeExactCohortIndex,
  publishExactCohortCommit,
  refContainsCohort,
  resolveRef,
  verifyCandidateShape,
  type PreparedExactCohortCommit,
} from "./git-exact-cohort";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex, type JcsJsonValue } from "./jcs";
import {
  CanonicalGitTransportError,
  type CanonicalGitTransportSession,
  type StableRemoteProof,
} from "./canonical-git-transport";
import {
  canonicalL1BodyHash,
  canonicalL1EnvelopeJson,
  expectedL1EventPath,
  scanWholeL1Validated,
  validateL1WritePreflight,
} from "./l1-schema-registry";

const execFileAsync = promisify(execFile);
const EPISODE_DOMAIN = "pi-astack/adr0027-c6/recovery-episode/v1";
const PUSH_EPISODE_V2_DOMAIN = "pi-astack/adr0027-c6/push-episode/v2";
const CLAIM_DOMAIN = "pi-astack/adr0027-c6/recovery-claim/v1";
const ENVELOPE_SCHEMA = "drain-recovery-envelope/v1";
const EVENT_SCHEMA_VERSION = "drain-recovery-event/v1";
const PRODUCER_NAME = "pi-astack.convergence-recovery";
const PRODUCER_VERSION = "1.0.0";
const TERMINAL_REASON_CATEGORY = "owner_intervention_required";
const ABORT_REASON_CATEGORY = "recovery_slot_aborted";
const ABORT_ERROR_CODE = "RECOVERY_SLOT_ABORTED";
const GIT_OID_RE = /^[0-9a-fA-F]{40,64}$/;

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function execGit(repo: string, args: readonly string[]) {
  return execFileAsync("git", ["-C", repo, ...args], {
    env: sanitizedGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

export const RECOVERY_LANE_BUDGETS = Object.freeze({ curator: 3, drain: 5, push: 5 } as const);
export type RecoveryLane = keyof typeof RECOVERY_LANE_BUDGETS;
export type RecoveryEventType =
  | "recovery_slot_claimed"
  | "commit_prepared"
  | "commit_published"
  | "index_converged"
  | "recovery_slot_aborted"
  | "recovery_episode_terminal"
  | "push_intent"
  | "push_outcome"
  | "push_terminal_resolution_candidate"
  | "push_terminal_resolution_attestation";

export class ConvergenceRecoveryError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "ConvergenceRecoveryError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface RecoveryEvent {
  event_schema_version: typeof EVENT_SCHEMA_VERSION;
  event_type: RecoveryEventType;
  producer: { name: typeof PRODUCER_NAME; version: typeof PRODUCER_VERSION };
  episode_id: string;
  lane: RecoveryLane;
  slot: number;
  body: Record<string, JcsJsonValue>;
}

interface RecoveryEnvelope {
  schema: typeof ENVELOPE_SCHEMA;
  canonicalization: "RFC8785-JCS";
  hash_alg: "sha256";
  event_id: string;
  body_hash: string;
  body: RecoveryEvent;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecoveryLane(value: unknown): value is RecoveryLane {
  return value === "curator" || value === "drain" || value === "push";
}

function assertSlot(lane: RecoveryLane, slot: number): void {
  if (!isRecoveryLane(lane)) throw new ConvergenceRecoveryError("RECOVERY_LANE_INVALID", `unknown recovery lane: ${String(lane)}`);
  if (!Number.isInteger(slot) || slot < 1 || slot > RECOVERY_LANE_BUDGETS[lane]) {
    throw new ConvergenceRecoveryError("RECOVERY_SLOT_INVALID", `${lane} slot must be 1..${RECOVERY_LANE_BUDGETS[lane]}`);
  }
}

function safeId(value: string, field: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new ConvergenceRecoveryError("RECOVERY_ID_INVALID", `${field} is not path-safe`);
  return value;
}

/** Stable across processes and restarts. Identity fields must be frozen at episode genesis. */
export function recoveryEpisodeIdentity(lane: RecoveryLane, identity: Record<string, JcsJsonValue>): string {
  return jcsSha256Hex({ domain: EPISODE_DOMAIN, lane, identity });
}

/** A drain generation is anchored to its predecessor completion/genesis, never to a mutable cohort. */
export function drainEpisodeIdentity(input: { repo_id: string; ref_name: string; generation_anchor: string }): string {
  return recoveryEpisodeIdentity("drain", input);
}

export function deriveNextEpisodeIdentity(input: { repoId: string; refName: string; generationAnchor: string }): string {
  return drainEpisodeIdentity({ repo_id: input.repoId, ref_name: input.refName, generation_anchor: input.generationAnchor });
}

export interface RemoteScopeV2 {
  repo_id: string;
  remote: string;
  ref_name: string;
  target_commit: string;
  remote_url_id: string;
  transport_policy_id: string;
}

/** New push episodes are v2. The v1 helper is retained only for validating
 * already-durable legacy records and is never used by a writer. */
export function legacyPushEpisodeIdentity(input: Pick<RemoteScopeV2, "repo_id" | "remote" | "ref_name" | "target_commit">): string {
  return recoveryEpisodeIdentity("push", input);
}

export function pushEpisodeIdentity(input: RemoteScopeV2): string {
  if (!input.remote_url_id || !input.transport_policy_id) return legacyPushEpisodeIdentity(input);
  return jcsSha256Hex({ domain: PUSH_EPISODE_V2_DOMAIN, scope_version: "remote-scope/v2", ...input });
}

export function curatorEpisodeIdentity(identity: Record<string, JcsJsonValue>): string {
  return recoveryEpisodeIdentity("curator", identity);
}

export function recoveryClaimId(episodeId: string, lane: RecoveryLane, slot: number): string {
  assertSlot(lane, slot);
  return jcsSha256Hex({ domain: CLAIM_DOMAIN, episode_id: episodeId, lane, slot });
}

function recoveryEvent(episodeId: string, lane: RecoveryLane, slot: number, eventType: RecoveryEventType, body: Record<string, JcsJsonValue>): RecoveryEvent {
  safeId(episodeId, "episode_id");
  return {
    event_schema_version: EVENT_SCHEMA_VERSION,
    event_type: eventType,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
    episode_id: episodeId,
    lane,
    slot,
    body,
  };
}

function recoveryEnvelope(event: RecoveryEvent): RecoveryEnvelope {
  const bodyHash = canonicalL1BodyHash(event);
  return { schema: ENVELOPE_SCHEMA, canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: bodyHash, body_hash: bodyHash, body: event };
}

async function createRecoveryEnvelope(abrainHome: string, event: RecoveryEvent): Promise<{ status: "created" | "identical"; filePath: string; eventId: string }> {
  const envelope = recoveryEnvelope(event);
  const filePath = expectedL1EventPath(abrainHome, envelope.event_id);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await validateL1WritePreflight({
    abrainHome,
    envelope,
    targetPath: filePath,
    expected: { domain: "canonical_path", role: "meta", producer: PRODUCER_NAME, eventType: event.event_type },
  });
  const status = await durableAtomicCreateFile(filePath, canonicalL1EnvelopeJson(envelope));
  if (status === "collision") throw new ConvergenceRecoveryError("RECOVERY_DURABLE_COLLISION", `different bytes already occupy ${filePath}`, { filePath });
  return { status, filePath, eventId: envelope.event_id };
}

export interface ClaimResult {
  status: "acquired" | "consumed";
  shouldExecute: boolean;
  claimId: string;
  filePath: string;
}

/** Low-level atomic no-replace primitive. High-level recovery uses claimNextRecoverySlot. */
export async function claimRecoverySlot(options: { abrainHome: string; episodeId: string; lane: RecoveryLane; slot: number }): Promise<ClaimResult> {
  assertSlot(options.lane, options.slot);
  const claimId = recoveryClaimId(options.episodeId, options.lane, options.slot);
  const event = recoveryEvent(options.episodeId, options.lane, options.slot, "recovery_slot_claimed", { claim_id: claimId });
  const { status, filePath } = await createRecoveryEnvelope(options.abrainHome, event);
  return { status: status === "created" ? "acquired" : "consumed", shouldExecute: status === "created", claimId, filePath };
}

export async function appendRecoveryEvent(options: {
  abrainHome: string;
  episodeId: string;
  lane: RecoveryLane;
  slot: number;
  eventType: RecoveryEventType;
  body: Record<string, JcsJsonValue>;
}): Promise<{ status: "created" | "identical"; event: RecoveryEvent; filePath: string; eventId: string }> {
  assertSlot(options.lane, options.slot);
  const event = recoveryEvent(options.episodeId, options.lane, options.slot, options.eventType, options.body);
  const created = await createRecoveryEnvelope(options.abrainHome, event);
  return { ...created, event };
}

function recoveryRecords(scan: Awaited<ReturnType<typeof scanWholeL1Validated>>): RecoveryEvent[] {
  return scan.all
    .filter((record) => record.registration.envelope_schema === ENVELOPE_SCHEMA)
    .map((record) => record.body as unknown as RecoveryEvent);
}

export async function readRecoveryEvents(abrainHome: string, episodeId: string, lane: RecoveryLane): Promise<RecoveryEvent[]> {
  safeId(episodeId, "episode_id");
  return recoveryRecords(await scanWholeL1Validated({ abrainHome }))
    .filter((event) => event.episode_id === episodeId && event.lane === lane)
    .sort((a, b) => a.slot - b.slot || compareAscii(a.event_type, b.event_type) || compareAscii(canonicalizeJcs(a), canonicalizeJcs(b)));
}

export interface FoldedRecoverySlot {
  claimId?: string;
  claimed?: RecoveryEvent;
  prepared?: RecoveryEvent;
  published?: RecoveryEvent;
  converged?: RecoveryEvent;
  aborted?: RecoveryEvent;
  terminal?: RecoveryEvent;
  pushIntent?: RecoveryEvent;
  pushOutcome?: RecoveryEvent;
  resolutionCandidates?: RecoveryEvent[];
  resolutionAttestations?: RecoveryEvent[];
}

function uniqueEvent(existing: RecoveryEvent | undefined, next: RecoveryEvent): RecoveryEvent {
  if (existing && canonicalizeJcs(existing) !== canonicalizeJcs(next)) {
    throw new ConvergenceRecoveryError("RECOVERY_EVENT_INVARIANT", `conflicting ${next.event_type} events in one slot`);
  }
  return next;
}

function hasExactBodyKeys(event: RecoveryEvent, keys: readonly string[]): boolean {
  const actual = Object.keys(event.body).sort(compareAscii);
  const expected = [...keys].sort(compareAscii);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const REMOTE_SCOPE_KEYS = ["remote", "ref_name", "remote_url_id", "repo_id", "target_commit", "transport_policy_id"] as const;
const PUSH_OUTCOME_V2_KEYS = [
  "classification", "command_exit_code", "error_code", "ref_name", "remote", "remote_contains_target",
  "remote_ref_after", "remote_ref_before", "remote_url_id", "repo_id", "stage", "stderr_redacted_sha256",
  "stdout_redacted_sha256", "target_commit", "transport_attempted", "transport_policy_id",
] as const;
const HASH_OR_NULL = (value: unknown) => value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
const OID_OR_NULL = (value: unknown) => value === null || (typeof value === "string" && GIT_OID_RE.test(value));

export function remoteScopeFromBody(body: Record<string, JcsJsonValue>): RemoteScopeV2 | undefined {
  if (
    body.scope_version !== "remote-scope/v2"
    || typeof body.repo_id !== "string" || !/^[0-9a-f]{64}$/.test(body.repo_id)
    || typeof body.remote !== "string" || body.remote !== "origin"
    || typeof body.ref_name !== "string" || body.ref_name !== "refs/heads/main"
    || typeof body.target_commit !== "string" || !GIT_OID_RE.test(body.target_commit)
    || typeof body.remote_url_id !== "string" || !/^[0-9a-f]{64}$/.test(body.remote_url_id)
    || typeof body.transport_policy_id !== "string" || !/^[0-9a-f]{64}$/.test(body.transport_policy_id)
  ) return undefined;
  return {
    repo_id: body.repo_id,
    remote: body.remote,
    ref_name: body.ref_name,
    target_commit: body.target_commit,
    remote_url_id: body.remote_url_id,
    transport_policy_id: body.transport_policy_id,
  };
}

function hasValidPushOutcomeBody(event: RecoveryEvent): boolean {
  if (hasExactBodyKeys(event, ["classification", "target_commit"])) {
    return (event.body.classification === "success" || event.body.classification === "retryable" || event.body.classification === "nonretryable")
      && typeof event.body.target_commit === "string" && GIT_OID_RE.test(event.body.target_commit);
  }
  return hasExactBodyKeys(event, PUSH_OUTCOME_V2_KEYS)
    && (event.body.classification === "success" || event.body.classification === "retryable" || event.body.classification === "nonretryable")
    && typeof event.body.repo_id === "string" && /^[0-9a-f]{64}$/.test(event.body.repo_id)
    && event.body.remote === "origin" && event.body.ref_name === "refs/heads/main"
    && typeof event.body.target_commit === "string" && GIT_OID_RE.test(event.body.target_commit)
    && typeof event.body.remote_url_id === "string" && /^[0-9a-f]{64}$/.test(event.body.remote_url_id)
    && typeof event.body.transport_policy_id === "string" && /^[0-9a-f]{64}$/.test(event.body.transport_policy_id)
    && typeof event.body.stage === "string"
    && typeof event.body.transport_attempted === "boolean"
    && (event.body.command_exit_code === null || Number.isInteger(event.body.command_exit_code))
    && HASH_OR_NULL(event.body.stdout_redacted_sha256) && HASH_OR_NULL(event.body.stderr_redacted_sha256)
    && OID_OR_NULL(event.body.remote_ref_before) && OID_OR_NULL(event.body.remote_ref_after)
    && typeof event.body.remote_contains_target === "boolean"
    && (event.body.error_code === null || typeof event.body.error_code === "string");
}

function hasValidPushIntentBody(event: RecoveryEvent): boolean {
  if (hasExactBodyKeys(event, ["repo", "remote", "ref_name", "target_commit"])) {
    return typeof event.body.repo === "string" && path.isAbsolute(event.body.repo)
      && typeof event.body.remote === "string" && event.body.remote.length > 0 && event.body.remote.length <= 4096
      && !/[\x00-\x1f\x7f]/.test(event.body.remote)
      && typeof event.body.ref_name === "string" && /^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/.test(event.body.ref_name)
      && !event.body.ref_name.includes("..")
      && typeof event.body.target_commit === "string" && GIT_OID_RE.test(event.body.target_commit);
  }
  return hasExactBodyKeys(event, ["scope_version", ...REMOTE_SCOPE_KEYS]) && !!remoteScopeFromBody(event.body);
}

function hasValidResolutionCandidate(event: RecoveryEvent): boolean {
  return hasExactBodyKeys(event, ["legacy_episode_id", "legacy_intent_event_id", "legacy_terminal_event_id", "scope_version", ...REMOTE_SCOPE_KEYS])
    && event.body.legacy_episode_id === event.episode_id
    && typeof event.body.legacy_intent_event_id === "string" && /^[0-9a-f]{64}$/.test(event.body.legacy_intent_event_id)
    && typeof event.body.legacy_terminal_event_id === "string" && /^[0-9a-f]{64}$/.test(event.body.legacy_terminal_event_id)
    && !!remoteScopeFromBody(event.body);
}

function hasValidResolutionAttestation(event: RecoveryEvent): boolean {
  return hasExactBodyKeys(event, ["candidate_event_id", "observed_tip", "relation"])
    && typeof event.body.candidate_event_id === "string" && /^[0-9a-f]{64}$/.test(event.body.candidate_event_id)
    && typeof event.body.observed_tip === "string" && GIT_OID_RE.test(event.body.observed_tip)
    && (event.body.relation === "equal" || event.body.relation === "descendant");
}

function laneAllows(lane: RecoveryLane, type: RecoveryEventType): boolean {
  if (type === "recovery_slot_claimed" || type === "recovery_slot_aborted" || type === "recovery_episode_terminal") return true;
  if (lane === "drain") return type === "commit_prepared" || type === "commit_published" || type === "index_converged";
  return lane === "push" && (type === "push_intent" || type === "push_outcome" || type === "push_terminal_resolution_candidate" || type === "push_terminal_resolution_attestation");
}

/** Aggregate content-addressed events first, then validate the state graph independent of scan order. */
export function foldRecoveryEvents(events: readonly RecoveryEvent[]): ReadonlyMap<number, Readonly<FoldedRecoverySlot>> {
  const folded = new Map<number, FoldedRecoverySlot>();
  let identity: string | undefined;
  for (const event of events) {
    assertSlot(event.lane, event.slot);
    const nextIdentity = `${event.episode_id}\0${event.lane}`;
    if (identity !== undefined && identity !== nextIdentity) throw new ConvergenceRecoveryError("RECOVERY_FOLD_MIXED_EPISODE", "fold input mixes episodes or lanes");
    identity = nextIdentity;
    if (!laneAllows(event.lane, event.event_type)) {
      throw new ConvergenceRecoveryError("RECOVERY_LANE_INVARIANT", `${event.event_type} is illegal in ${event.lane} lane`, { slot: event.slot });
    }
    const slot = folded.get(event.slot) ?? {};
    if (event.event_type === "recovery_slot_claimed") {
      const claimId = String(event.body.claim_id ?? "");
      const expected = recoveryClaimId(event.episode_id, event.lane, event.slot);
      if (claimId !== expected) throw new ConvergenceRecoveryError("RECOVERY_CLAIM_INVARIANT", "claim id is not deterministic", { slot: event.slot, expected, actual: claimId });
      slot.claimed = uniqueEvent(slot.claimed, event);
      slot.claimId = claimId;
    } else if (event.event_type === "commit_prepared") slot.prepared = uniqueEvent(slot.prepared, event);
    else if (event.event_type === "commit_published") slot.published = uniqueEvent(slot.published, event);
    else if (event.event_type === "index_converged") slot.converged = uniqueEvent(slot.converged, event);
    else if (event.event_type === "recovery_slot_aborted") slot.aborted = uniqueEvent(slot.aborted, event);
    else if (event.event_type === "recovery_episode_terminal") slot.terminal = uniqueEvent(slot.terminal, event);
    else if (event.event_type === "push_intent") slot.pushIntent = uniqueEvent(slot.pushIntent, event);
    else if (event.event_type === "push_outcome") slot.pushOutcome = uniqueEvent(slot.pushOutcome, event);
    else if (event.event_type === "push_terminal_resolution_candidate") (slot.resolutionCandidates ??= []).push(event);
    else (slot.resolutionAttestations ??= []).push(event);
    folded.set(event.slot, slot);
  }

  const slots = [...folded.keys()].sort((a, b) => a - b);
  const pushIntents = slots.map((number) => folded.get(number)!.pushIntent).filter((item): item is RecoveryEvent => !!item);
  if (pushIntents.length > 1) {
    const first = pushIntents[0]!;
    if (pushIntents.some((item) => canonicalizeJcs(item.body) !== canonicalizeJcs(first.body))) {
      throw new ConvergenceRecoveryError("PUSH_INTENT_MISMATCH", "push episode contains conflicting durable intents");
    }
  }
  const durablePushIntent = pushIntents[0];
  if (durablePushIntent) {
    const v2Scope = remoteScopeFromBody(durablePushIntent.body);
    const expectedEpisode = v2Scope
      ? pushEpisodeIdentity(v2Scope)
      : legacyPushEpisodeIdentity({
        repo_id: sha256Hex(path.resolve(String(durablePushIntent.body.repo))),
        remote: String(durablePushIntent.body.remote),
        ref_name: String(durablePushIntent.body.ref_name),
        target_commit: String(durablePushIntent.body.target_commit),
      });
    if (durablePushIntent.episode_id !== expectedEpisode) {
      throw new ConvergenceRecoveryError("PUSH_INTENT_EPISODE_MISMATCH", "push intent fields do not derive this episode identity");
    }
    if (durablePushIntent.slot !== 1) {
      throw new ConvergenceRecoveryError("PUSH_INTENT_SLOT_MISMATCH", "durable push intent must be bound to slot 1");
    }
  }

  for (const number of slots) {
    const slot = folded.get(number)!;
    if (!slot.claimed && (slot.prepared || slot.published || slot.converged || slot.aborted || slot.terminal || slot.pushOutcome)) {
      throw new ConvergenceRecoveryError("RECOVERY_RESULT_WITHOUT_CLAIM", `slot ${number} has a result without a claim`);
    }
    if (slot.pushIntent && !hasValidPushIntentBody(slot.pushIntent)) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} has a malformed push intent`);
    }
    if (slot.published && !slot.prepared) throw new ConvergenceRecoveryError("RECOVERY_STATE_ORDER", `slot ${number} published without prepared`);
    if (slot.converged && !slot.published) throw new ConvergenceRecoveryError("RECOVERY_STATE_ORDER", `slot ${number} converged without published`);
    const preparedCandidate = slot.prepared?.body.candidate;
    if (slot.published && slot.published.body.candidate !== preparedCandidate) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} published candidate differs from prepared candidate`);
    }
    if (slot.converged && slot.converged.body.candidate !== preparedCandidate) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} converged candidate differs from prepared candidate`);
    }
    if (slot.published && (!hasExactBodyKeys(slot.published, ["candidate", "publication_confirmed"]) || slot.published.body.publication_confirmed !== true)) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} published event is not a deterministic publication fact`);
    }
    if (slot.converged && !hasExactBodyKeys(slot.converged, ["candidate"])) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} converged event contains non-authoritative diagnostics`);
    }
    if (slot.pushOutcome && !hasValidPushOutcomeBody(slot.pushOutcome)) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} has a malformed push outcome`);
    }
    if (slot.pushOutcome) {
      if (!durablePushIntent) throw new ConvergenceRecoveryError("PUSH_INTENT_MISSING", `slot ${number} has a push outcome without a durable intent`);
      if (slot.pushOutcome.body.target_commit !== durablePushIntent.body.target_commit) throw new ConvergenceRecoveryError("PUSH_OUTCOME_TARGET_MISMATCH", `slot ${number} outcome target differs from durable push intent`);
      const intentScope = remoteScopeFromBody(durablePushIntent.body);
      if (intentScope && REMOTE_SCOPE_KEYS.some((key) => slot.pushOutcome!.body[key] !== intentScope[key])) {
        throw new ConvergenceRecoveryError("PUSH_OUTCOME_SCOPE_MISMATCH", `slot ${number} outcome scope differs from durable push intent`);
      }
    }
    if (slot.resolutionCandidates) {
      slot.resolutionCandidates = [...new Map(slot.resolutionCandidates.map((item) => [canonicalizeJcs(item.body), item])).values()];
      if (slot.resolutionCandidates.some((item) => !hasValidResolutionCandidate(item))) throw new ConvergenceRecoveryError("LEGACY_CANDIDATE_INVALID", `slot ${number} has a malformed legacy resolution candidate`);
      if (slot.resolutionCandidates.length > 1) throw new ConvergenceRecoveryError("LEGACY_CANDIDATE_CONFLICT", `slot ${number} has different legacy resolution candidates`);
    }
    if (slot.resolutionAttestations) {
      slot.resolutionAttestations = [...new Map(slot.resolutionAttestations.map((item) => [canonicalizeJcs(item.body), item])).values()];
      if (slot.resolutionAttestations.some((item) => !hasValidResolutionAttestation(item))) throw new ConvergenceRecoveryError("LEGACY_ATTESTATION_INVALID", `slot ${number} has a malformed legacy resolution attestation`);
      const candidateId = slot.resolutionCandidates?.[0] ? canonicalL1BodyHash(slot.resolutionCandidates[0]) : null;
      if (!candidateId || slot.resolutionAttestations.some((item) => item.body.candidate_event_id !== candidateId)) throw new ConvergenceRecoveryError("LEGACY_ATTESTATION_CANDIDATE_MISMATCH", `slot ${number} attestation does not bind its exact candidate`);
    }
    if (slot.aborted && (!hasExactBodyKeys(slot.aborted, ["reason", "error_code"]) || slot.aborted.body.reason !== ABORT_REASON_CATEGORY || slot.aborted.body.error_code !== ABORT_ERROR_CODE)) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} abort event is not deterministic`);
    }
    if (slot.terminal && (!hasExactBodyKeys(slot.terminal, ["reason", "owner_alert"]) || slot.terminal.body.owner_alert !== true || slot.terminal.body.reason !== TERMINAL_REASON_CATEGORY)) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} terminal event is not deterministic`);
    }
  }
  const claimed = slots.filter((number) => folded.get(number)!.claimed);
  for (let index = 0; index < claimed.length; index += 1) {
    if (claimed[index] !== index + 1) throw new ConvergenceRecoveryError("RECOVERY_SLOT_GAP", "claimed slots must be contiguous from slot 1", { claimed });
  }
  // Claims can race with a completion/terminal publication. Once durable,
  // those states stop future claims, but lower/equal already-claimed results
  // remain legal history and must never poison replay.
  return folded;
}

export interface RecoveryEpisodeCursor {
  episodeId: string;
  lane: RecoveryLane;
  nextSlot: number | null;
  lastClaimedSlot: number | null;
  complete: boolean;
  terminal: boolean;
  pendingSlot: number | null;
  folded: ReadonlyMap<number, Readonly<FoldedRecoverySlot>>;
}

export function recoveryEpisodeCursor(episodeId: string, lane: RecoveryLane, events: readonly RecoveryEvent[]): RecoveryEpisodeCursor {
  const folded = foldRecoveryEvents(events);
  const slots = [...folded.keys()].sort((a, b) => a - b);
  const claimed = slots.filter((slot) => folded.get(slot)!.claimed);
  const lastClaimedSlot = claimed.length ? claimed[claimed.length - 1]! : null;
  const complete = slots.some((slot) => {
    const state = folded.get(slot)!;
    return Boolean(!state.aborted && (state.converged || state.pushOutcome?.body.classification === "success"));
  });
  const terminal = slots.some((slot) => Boolean(folded.get(slot)!.terminal));
  const pendingSlot = lastClaimedSlot !== null && (() => {
    const state = folded.get(lastClaimedSlot)!;
    if (lane === "drain") return !state.aborted && !state.converged;
    if (lane === "push") return !state.aborted && !state.pushOutcome;
    return !state.aborted && !state.terminal;
  })() ? lastClaimedSlot : null;
  const candidate = (lastClaimedSlot ?? 0) + 1;
  return { episodeId, lane, nextSlot: complete || terminal || candidate > RECOVERY_LANE_BUDGETS[lane] ? null : candidate, lastClaimedSlot, complete, terminal, pendingSlot, folded };
}

export interface RecoveryEpisodeQuarantine {
  status: "quarantined";
  episodeId: string;
  lane: "drain" | "push";
  ownerAlert: true;
  errorCode: string;
  message: string;
}

export interface OpenRecoveryEpisodesResult {
  open: readonly RecoveryEpisodeCursor[];
  terminal: readonly RecoveryEpisodeCursor[];
  quarantined: readonly RecoveryEpisodeQuarantine[];
}

/** Rebuild P1-S2 open drain/push episodes. Curator completion belongs to the
 * external E2 decision schema and is deliberately outside this recovery loop. */
export function recoverOpenRecoveryEpisodesFromScan(
  scan: Awaited<ReturnType<typeof scanWholeL1Validated>>,
  lane?: "drain" | "push",
): OpenRecoveryEpisodesResult {
  const events = recoveryRecords(scan);
  const groups = new Map<string, RecoveryEvent[]>();
  for (const event of events) {
    if (event.lane === "curator" || (lane && event.lane !== lane)) continue;
    if (event.lane !== "drain" && event.lane !== "push") continue;
    const key = `${event.episode_id}\0${event.lane}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const open: RecoveryEpisodeCursor[] = [];
  const terminal: RecoveryEpisodeCursor[] = [];
  const quarantined: RecoveryEpisodeQuarantine[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    try {
      const cursor = recoveryEpisodeCursor(first.episode_id, first.lane, group);
      if (cursor.terminal) terminal.push(cursor);
      else if (!cursor.complete) open.push(cursor);
    } catch (error) {
      quarantined.push({
        status: "quarantined",
        episodeId: first.episode_id,
        lane: first.lane as "drain" | "push",
        ownerAlert: true,
        errorCode: error instanceof ConvergenceRecoveryError ? error.code : "RECOVERY_FOLD_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  open.sort((a, b) => compareAscii(`${a.lane}\0${a.episodeId}`, `${b.lane}\0${b.episodeId}`));
  terminal.sort((a, b) => compareAscii(`${a.lane}\0${a.episodeId}`, `${b.lane}\0${b.episodeId}`));
  quarantined.sort((a, b) => compareAscii(`${a.lane}\0${a.episodeId}`, `${b.lane}\0${b.episodeId}`));
  return { open: Object.freeze(open), terminal: Object.freeze(terminal), quarantined: Object.freeze(quarantined) };
}

export async function recoverOpenRecoveryEpisodes(abrainHome: string, lane?: "drain" | "push"): Promise<OpenRecoveryEpisodesResult> {
  return recoverOpenRecoveryEpisodesFromScan(await scanWholeL1Validated({ abrainHome }), lane);
}

export interface ResolvedDrainEpisode {
  episodeId: string;
  generationAnchor: string;
  status: "new" | "open";
}

/** Resolve a drain generation from a fixed genesis anchor and prior durable
 * closure event IDs only. Mutable HEAD, cohort roots, and unrelated L1 events
 * are intentionally absent from this API. */
export async function resolveRecoveryEpisode(options: {
  abrainHome: string;
  repoId: string;
  refName: string;
  genesisAnchor?: string;
}): Promise<ResolvedDrainEpisode> {
  const all = recoveryRecords(await scanWholeL1Validated({ abrainHome: options.abrainHome })).filter((event) => event.lane === "drain");
  const groups = new Map<string, RecoveryEvent[]>();
  for (const event of all) {
    const group = groups.get(event.episode_id) ?? [];
    group.push(event);
    groups.set(event.episode_id, group);
  }
  let generationAnchor = options.genesisAnchor ?? "genesis";
  for (let generation = 0; generation <= groups.size; generation += 1) {
    const episodeId = deriveNextEpisodeIdentity({ repoId: options.repoId, refName: options.refName, generationAnchor });
    const events = groups.get(episodeId);
    if (!events) return { episodeId, generationAnchor, status: "new" };
    const cursor = recoveryEpisodeCursor(episodeId, "drain", events);
    if (!cursor.complete && !cursor.terminal) return { episodeId, generationAnchor, status: "open" };
    const closureEvents: RecoveryEvent[] = [];
    for (const state of cursor.folded.values()) {
      if (!state.aborted && state.converged) closureEvents.push(state.converged);
      if (state.terminal) closureEvents.push(state.terminal);
    }
    closureEvents.sort((a, b) => a.slot - b.slot || compareAscii(a.event_type, b.event_type) || compareAscii(canonicalizeJcs(a), canonicalizeJcs(b)));
    const closure = closureEvents[0];
    if (!closure) throw new ConvergenceRecoveryError("RECOVERY_EPISODE_CLOSURE_MISSING", "closed episode has no deterministic closure event", { episodeId });
    generationAnchor = canonicalL1BodyHash(closure);
  }
  throw new ConvergenceRecoveryError("RECOVERY_EPISODE_CHAIN_CYCLE", "episode generation chain did not terminate");
}

export type NextSlotResult =
  | ({ status: "acquired" | "consumed"; slot: number } & ClaimResult)
  | { status: "pending"; slot: number; shouldExecute: false }
  | { status: "complete" | "terminal"; slot: null; shouldExecute: false };

async function ensureTerminal(abrainHome: string, episodeId: string, lane: RecoveryLane, slot: number): Promise<void> {
  await appendRecoveryEvent({
    abrainHome,
    episodeId,
    lane,
    slot,
    eventType: "recovery_episode_terminal",
    body: { reason: TERMINAL_REASON_CATEGORY, owner_alert: true },
  });
}

/** Claim only the continuous next slot after a whole-L1 scan/fold. */
export async function claimNextRecoverySlot(options: { abrainHome: string; episodeId: string; lane: RecoveryLane }): Promise<NextSlotResult> {
  const events = await readRecoveryEvents(options.abrainHome, options.episodeId, options.lane);
  const cursor = recoveryEpisodeCursor(options.episodeId, options.lane, events);
  if (cursor.complete) return { status: "complete", slot: null, shouldExecute: false };
  if (cursor.terminal) return { status: "terminal", slot: null, shouldExecute: false };
  if (cursor.pendingSlot !== null) return { status: "pending", slot: cursor.pendingSlot, shouldExecute: false };
  if (cursor.nextSlot === null) {
    const slot = cursor.lastClaimedSlot ?? RECOVERY_LANE_BUDGETS[options.lane];
    await ensureTerminal(options.abrainHome, options.episodeId, options.lane, slot);
    return { status: "terminal", slot: null, shouldExecute: false };
  }
  const claim = await claimRecoverySlot({ ...options, slot: cursor.nextSlot });
  return { ...claim, slot: cursor.nextSlot };
}

export async function claimLaneSlot(options: Parameters<typeof claimRecoverySlot>[0]): Promise<ClaimResult> {
  return claimRecoverySlot(options);
}
export const claimCuratorSlot = (options: Omit<Parameters<typeof claimRecoverySlot>[0], "lane">) => claimRecoverySlot({ ...options, lane: "curator" });

export type DurablePushIntent =
  | ({ version: "v1"; repo: string; scope: Pick<RemoteScopeV2, "remote" | "ref_name" | "target_commit"> })
  | ({ version: "v2"; scope: RemoteScopeV2 });

export async function recordPushIntent(options: { abrainHome: string; episodeId: string; scope: RemoteScopeV2 } | ({ abrainHome: string; episodeId: string; repo: string; remote: string; refName: string; targetCommit: string })): Promise<void> {
  if (!("scope" in options)) return recordLegacyPushIntentForTests(options);
  if (options.episodeId !== pushEpisodeIdentity(options.scope)) throw new ConvergenceRecoveryError("PUSH_INTENT_EPISODE_MISMATCH", "v2 push intent does not derive the supplied episode id");
  await appendRecoveryEvent({
    abrainHome: options.abrainHome,
    episodeId: options.episodeId,
    lane: "push",
    slot: 1,
    eventType: "push_intent",
    body: { scope_version: "remote-scope/v2", ...options.scope },
  });
}

function legacyFixtureExecutionEnabled(repo: string, abrainHome: string): boolean {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS === "1") return true;
  const replayRoot = process.env.P1B_REPLAY_ROOT;
  if (!replayRoot || !path.isAbsolute(replayRoot)) return false;
  const root = path.resolve(replayRoot);
  const tmpPrefix = `${path.resolve(process.env.TMPDIR || "/tmp")}${path.sep}`;
  const contained = (candidate: string) => {
    const relative = path.relative(root, path.resolve(candidate));
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return `${root}${path.sep}`.startsWith(tmpPrefix) && contained(repo) && contained(abrainHome);
}

/** Fixture-only compatibility writer. Production code must never call this. */
export async function recordLegacyPushIntentForTests(options: { abrainHome: string; episodeId: string; repo: string; remote: string; refName: string; targetCommit: string }): Promise<void> {
  if (!legacyFixtureExecutionEnabled(options.repo, options.abrainHome)) throw new ConvergenceRecoveryError("LEGACY_PUSH_WRITE_FORBIDDEN", "v1 push intent writes are disabled");
  await appendRecoveryEvent({
    abrainHome: options.abrainHome,
    episodeId: options.episodeId,
    lane: "push",
    slot: 1,
    eventType: "push_intent",
    body: { repo: path.resolve(options.repo), remote: options.remote, ref_name: options.refName, target_commit: options.targetCommit },
  });
}

export async function readPushIntent(abrainHome: string, episodeId: string): Promise<DurablePushIntent | undefined> {
  const events = await readRecoveryEvents(abrainHome, episodeId, "push");
  const intents = events.filter((event) => event.event_type === "push_intent");
  if (intents.length === 0) return undefined;
  const first = intents[0]!;
  for (const event of intents.slice(1)) {
    if (canonicalizeJcs(event.body) !== canonicalizeJcs(first.body)) {
      throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", "push episode contains conflicting intents");
    }
  }
  if (!hasValidPushIntentBody(first)) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", "push episode intent is malformed");
  const v2 = remoteScopeFromBody(first.body);
  if (v2) return { version: "v2", scope: v2 };
  return {
    version: "v1",
    repo: String(first.body.repo),
    scope: { remote: String(first.body.remote), ref_name: String(first.body.ref_name), target_commit: String(first.body.target_commit) },
  };
}

function preparedBody(prepared: PreparedExactCohortCommit, frozenIndexSnapshot: ReadonlyMap<string, string>): Record<string, JcsJsonValue> {
  return {
    repo: prepared.repo,
    ref_name: prepared.refName,
    frozen_commit: prepared.frozenCommit,
    new_tree: prepared.newTree,
    candidate: prepared.candidate,
    cohort_manifest_root: prepared.cohortManifestRoot,
    entries: prepared.entries.map((entry) => ({ ...entry })) as unknown as JcsJsonValue,
    frozen_index_snapshot: Object.fromEntries([...frozenIndexSnapshot].sort(([a], [b]) => compareAscii(a, b))),
  };
}

export async function recordDrainPrepared(options: { abrainHome: string; episodeId: string; slot: number; prepared: PreparedExactCohortCommit; frozenIndexSnapshot: ReadonlyMap<string, string> }): Promise<void> {
  await appendRecoveryEvent({ ...options, lane: "drain", eventType: "commit_prepared", body: preparedBody(options.prepared, options.frozenIndexSnapshot) });
}

function decodePrepared(event: RecoveryEvent): { prepared: PreparedExactCohortCommit; snapshot: ReadonlyMap<string, string> } {
  const body = event.body as Record<string, unknown>;
  const fail = (message: string): never => {
    throw new ConvergenceRecoveryError("RECOVERY_PREPARED_INVALID", message, { slot: event.slot });
  };
  const requiredString = (key: string): string => {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0) fail(`commit_prepared.${key} must be a non-empty string`);
    return value as string;
  };
  const rawEntries = body.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) fail("commit_prepared.entries must be a non-empty array");
  const entryPaths = new Set<string>();
  const entries: Array<PreparedExactCohortCommit["entries"][number]> = (rawEntries as unknown[]).map((value: unknown, index: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`commit_prepared.entries[${index}] must be an object`);
    const entry = value as Record<string, unknown>;
    const entryPath = entry.path;
    const op = entry.op;
    const mode = entry.mode;
    const blobOid = entry.blobOid;
    const bytesSha256 = entry.bytesSha256;
    if (typeof entryPath !== "string" || !entryPath || entryPath.includes("\0") || entryPath.startsWith("/") || entryPath.includes("\\")
      || entryPath.split("/").some((part) => part === "" || part === "." || part === "..") || entryPath === ".git" || entryPath.startsWith(".git/")) {
      fail(`commit_prepared.entries[${index}].path is invalid`);
    }
    const canonicalPath = entryPath as string;
    if (entryPaths.has(canonicalPath)) fail(`commit_prepared.entries[${index}].path is duplicated`);
    entryPaths.add(canonicalPath);
    if (op !== "put" && op !== "delete") fail(`commit_prepared.entries[${index}].op is invalid`);
    if (typeof mode !== "string" || typeof blobOid !== "string" || typeof bytesSha256 !== "string") {
      fail(`commit_prepared.entries[${index}] has invalid mode/hash fields`);
    }
    const canonicalOp = op as "put" | "delete";
    const canonicalMode = mode as string;
    const canonicalBlobOid = blobOid as string;
    const canonicalBytesSha256 = bytesSha256 as string;
    if (canonicalOp === "put" && (!["100644", "100755"].includes(canonicalMode) || !/^[0-9a-f]{40,64}$/.test(canonicalBlobOid) || !/^[0-9a-f]{64}$/.test(canonicalBytesSha256))) {
      fail(`commit_prepared.entries[${index}] put shape is invalid`);
    }
    if (canonicalOp === "delete" && (canonicalMode !== "000000" || canonicalBlobOid !== "" || canonicalBytesSha256 !== "")) {
      fail(`commit_prepared.entries[${index}] delete shape is invalid`);
    }
    return { path: canonicalPath, op: canonicalOp, mode: canonicalMode, blobOid: canonicalBlobOid, bytesSha256: canonicalBytesSha256 };
  });
  const manifestRoot = requiredString("cohort_manifest_root");
  if (!/^[0-9a-f]{64}$/.test(manifestRoot) || cohortManifestRoot(entries) !== manifestRoot) {
    fail("commit_prepared.cohort_manifest_root does not match entries");
  }
  const rawSnapshot = body.frozen_index_snapshot;
  if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) fail("commit_prepared.frozen_index_snapshot must be an object");
  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(rawSnapshot as Record<string, unknown>)) {
    if (!entryPaths.has(key) || typeof value !== "string") fail(`commit_prepared.frozen_index_snapshot.${key} is invalid`);
    snapshot.set(key, value as string);
  }
  return {
    prepared: {
      repo: requiredString("repo"),
      refName: requiredString("ref_name"),
      frozenCommit: requiredString("frozen_commit"),
      newTree: requiredString("new_tree"),
      candidate: requiredString("candidate"),
      cohortManifestRoot: manifestRoot,
      entries,
    },
    snapshot,
  };
}

export type DrainRecoveryAction = "burned" | "published" | "absorbed" | "index_converged" | "refreeze_required" | "already_complete" | "terminal";
export type AbortRecoverySlotResult = "aborted" | "already_complete" | "success";

/** Re-scan and fold whole L1 immediately before publishing an abort fact. */
export async function abortRecoverySlotAfterRefold(
  options: { abrainHome: string; episodeId: string; lane: RecoveryLane; slot: number },
  immediateTerminal = false,
): Promise<AbortRecoverySlotResult> {
  const state = foldRecoveryEvents(await readRecoveryEvents(options.abrainHome, options.episodeId, options.lane)).get(options.slot);
  if (options.lane === "drain" && state?.converged) return "already_complete";
  if (options.lane === "push" && state?.pushOutcome?.body.classification === "success") return "success";
  await appendRecoveryEvent({
    ...options,
    eventType: "recovery_slot_aborted",
    body: { reason: ABORT_REASON_CATEGORY, error_code: ABORT_ERROR_CODE },
  });
  if (immediateTerminal || options.slot === RECOVERY_LANE_BUDGETS[options.lane]) {
    await ensureTerminal(options.abrainHome, options.episodeId, options.lane, options.slot);
  }
  return "aborted";
}

export async function burnPendingRecoverySlot(options: { abrainHome: string; episodeId: string; lane: RecoveryLane }): Promise<number | "already_complete" | "success" | null> {
  const cursor = recoveryEpisodeCursor(options.episodeId, options.lane, await readRecoveryEvents(options.abrainHome, options.episodeId, options.lane));
  if (cursor.pendingSlot === null) return null;
  const result = await abortRecoverySlotAfterRefold({ ...options, slot: cursor.pendingSlot });
  if (result !== "aborted") return result;
  return cursor.pendingSlot;
}

async function currentContainsPrepared(prepared: PreparedExactCohortCommit): Promise<boolean> {
  const current = await resolveRef(prepared.repo, prepared.refName);
  return await gitIsAncestor(prepared.repo, prepared.candidate, current)
    || await refContainsCohort(prepared.repo, prepared.refName, prepared.entries);
}

/** Resume a claimed drain slot. A published fact never authorizes convergence against an unrelated current ref. */
export async function recoverDrainSlot(options: {
  abrainHome: string;
  episodeId: string;
  slot: number;
  /** Production orchestrators use this for a fail-closed index.lock/provenance
   * check immediately before the update-ref CAS. Recovery owns the CAS; callers
   * must not duplicate its publication algorithm. */
  prePublishCheck?: () => Promise<void>;
  /** Re-check shared-index safety immediately before convergence. */
  preConvergeCheck?: () => Promise<void>;
}): Promise<DrainRecoveryAction> {
  assertSlot("drain", options.slot);
  const state = foldRecoveryEvents(await readRecoveryEvents(options.abrainHome, options.episodeId, "drain")).get(options.slot);
  if (!state?.claimId) throw new ConvergenceRecoveryError("RECOVERY_SLOT_UNCLAIMED", "restart recovery requires a durable claim event");
  if (state.terminal) return "terminal";
  if (state.converged) return "already_complete";
  if (state.aborted) return options.slot === RECOVERY_LANE_BUDGETS.drain ? "terminal" : "refreeze_required";
  if (!state.prepared) {
    if (await abortRecoverySlotAfterRefold({ ...options, lane: "drain" }) === "already_complete") return "already_complete";
    return options.slot === RECOVERY_LANE_BUDGETS.drain ? "terminal" : "burned";
  }
  const { prepared, snapshot } = decodePrepared(state.prepared);
  if (!await verifyCandidateShape(prepared.repo, prepared.candidate, prepared)) {
    if (await abortRecoverySlotAfterRefold({ ...options, lane: "drain" }) === "already_complete") return "already_complete";
    return options.slot === RECOVERY_LANE_BUDGETS.drain ? "terminal" : "refreeze_required";
  }
  if (!state.published) {
    const current = await resolveRef(prepared.repo, prepared.refName);
    let outcome: "published" | "absorbed" | "conflict" = "conflict";
    if (current === prepared.frozenCommit) {
      await options.prePublishCheck?.();
      const result = await publishExactCohortCommit({ repo: prepared.repo, refName: prepared.refName, candidate: prepared.candidate, frozenCommit: prepared.frozenCommit });
      outcome = result.status === "cas_conflict" ? "conflict" : result.status === "published" ? "published" : "absorbed";
    } else if (await currentContainsPrepared(prepared)) outcome = "absorbed";
    if (outcome === "conflict") {
      if (await abortRecoverySlotAfterRefold({ ...options, lane: "drain" }) === "already_complete") return "already_complete";
      return options.slot === RECOVERY_LANE_BUDGETS.drain ? "terminal" : "refreeze_required";
    }
    await appendRecoveryEvent({
      ...options,
      lane: "drain",
      eventType: "commit_published",
      body: { candidate: prepared.candidate, publication_confirmed: true },
    });
  } else if (!await currentContainsPrepared(prepared)) {
    // Publication is an irreversible durable fact. Never abort or burn this
    // slot after CAS; owner intervention must repair the ref and retry only
    // index convergence against the same published candidate/cohort.
    throw new ConvergenceRecoveryError(
      "RECOVERY_PUBLISHED_REF_DIVERGED",
      "published candidate/cohort is no longer contained by the configured ref",
      { episodeId: options.episodeId, slot: options.slot, candidate: prepared.candidate },
    );
  }

  await options.preConvergeCheck?.();
  await convergeExactCohortIndex({ repo: prepared.repo, refName: prepared.refName, cohortPaths: prepared.entries.map((entry) => entry.path), frozenIndexSnapshot: snapshot });
  await appendRecoveryEvent({
    ...options,
    lane: "drain",
    eventType: "index_converged",
    body: { candidate: prepared.candidate },
  });
  return "index_converged";
}

export type PushClassification = "success" | "retryable" | "nonretryable";
export interface PushTransportEvidence {
  transportAttempted: boolean;
  commandExitCode: number | null;
  stdoutSha256: string | null;
  stderrSha256: string | null;
  remoteRefBefore: string | null;
  remoteRefAfter: string | null;
  stage: string;
  errorCode: string | null;
}

export function classifyPushFailure(error: unknown): Exclude<PushClassification, "success"> {
  const text = error instanceof Error ? `${error.message}\n${(error as any).stderr ?? ""}` : String(error);
  if (/cannot lock ref|failed to update ref|reference already locked|P1B_RETRYABLE_REF_LOCK/i.test(text)) return "retryable";
  if (/non-fast-forward|rejected|permission denied|authentication failed|repository not found|protected branch/i.test(text)) return "nonretryable";
  return "nonretryable";
}

async function objectExists(repo: string, oid: string): Promise<boolean> {
  try {
    await execGit(repo, ["cat-file", "-e", `${oid}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function gitIsAncestor(repo: string, maybeAncestor: string, descendant: string): Promise<boolean> {
  try {
    await execGit(repo, ["merge-base", "--is-ancestor", maybeAncestor, descendant]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 1) return false;
    throw error;
  }
}

async function remoteContainsTarget(repo: string, remote: string, refName: string, target: string): Promise<boolean> {
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/.test(refName) || refName.includes("..") || refName.endsWith("/")) {
    throw new ConvergenceRecoveryError("REMOTE_REF_INVALID", `remote ref must be fully qualified: ${refName}`);
  }
  const { stdout } = await execGit(repo, ["ls-remote", "--refs", remote, refName]);
  const matches = stdout.trim().split("\n").filter(Boolean).map((line) => {
    const fields = line.split(/\s+/);
    if (fields.length !== 2 || fields[1] !== refName || !/^[0-9a-fA-F]{40,64}$/.test(fields[0]!)) {
      throw new ConvergenceRecoveryError("REMOTE_REF_INVALID", `ls-remote returned an invalid fully-qualified result for ${refName}`);
    }
    return fields[0]!;
  });
  if (matches.length === 0) return false;
  if (new Set(matches).size !== 1) throw new ConvergenceRecoveryError("REMOTE_REF_INVALID", `ls-remote returned conflicting values for ${refName}`);
  const remoteOid = matches[0]!;
  if (remoteOid === target) return true;
  if (!await objectExists(repo, remoteOid)) {
    await execGit(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, refName]);
  }
  return gitIsAncestor(repo, target, remoteOid);
}

interface PushExecutionOptions {
  abrainHome: string;
  episodeId: string;
  repo: string;
  scope: RemoteScopeV2;
  transportFactory?: () => Promise<CanonicalGitTransportSession>;
  closeTransport?: boolean;
  allowClaim?: () => boolean;
  legacy?: { remote: string; refName: string; targetCommit: string };
}

function outcomeBody(scope: RemoteScopeV2, evidence: PushTransportEvidence, classification: PushClassification, remoteContainsTarget: boolean): Record<string, JcsJsonValue> {
  return {
    classification,
    repo_id: scope.repo_id,
    remote: scope.remote,
    ref_name: scope.ref_name,
    target_commit: scope.target_commit,
    remote_url_id: scope.remote_url_id,
    transport_policy_id: scope.transport_policy_id,
    stage: evidence.stage,
    transport_attempted: evidence.transportAttempted,
    command_exit_code: evidence.commandExitCode,
    stdout_redacted_sha256: evidence.stdoutSha256,
    stderr_redacted_sha256: evidence.stderrSha256,
    remote_ref_before: evidence.remoteRefBefore,
    remote_ref_after: evidence.remoteRefAfter,
    remote_contains_target: remoteContainsTarget,
    error_code: evidence.errorCode,
  };
}

async function executeLegacyPushSlot(options: PushExecutionOptions & { slot: number }): Promise<{ classification: PushClassification; targetCommit: string; remoteContainsTarget: boolean } & PushTransportEvidence> {
  const legacy = options.legacy!;
  let classification: PushClassification = "success";
  let remoteContains = false;
  let transportAttempted = false;
  let commandExitCode: number | null = null;
  let stdoutSha256: string | null = null;
  let stderrSha256: string | null = null;
  let errorCode: string | null = null;
  try {
    remoteContains = await remoteContainsTarget(options.repo, legacy.remote, legacy.refName, legacy.targetCommit);
    if (!remoteContains) {
      transportAttempted = true;
      const completed = await execGit(options.repo, ["push", legacy.remote, `${legacy.targetCommit}:${legacy.refName}`]);
      remoteContains = true;
      commandExitCode = 0;
      stdoutSha256 = sha256Hex(String(completed.stdout ?? ""));
      stderrSha256 = sha256Hex(String(completed.stderr ?? ""));
    }
  } catch (error) {
    if (error instanceof ConvergenceRecoveryError) throw error;
    classification = classifyPushFailure(error);
    remoteContains = false;
    if (transportAttempted) {
      const rawCode = (error as any)?.code;
      commandExitCode = typeof rawCode === "number" ? rawCode : -1;
      stdoutSha256 = sha256Hex(String((error as any)?.stdout ?? ""));
      stderrSha256 = sha256Hex(String((error as any)?.stderr ?? (error instanceof Error ? error.message : error)));
      errorCode = "LEGACY_PUSH_FAILED";
    }
  }
  const evidence: PushTransportEvidence = { transportAttempted, commandExitCode, stdoutSha256, stderrSha256, remoteRefBefore: null, remoteRefAfter: null, stage: transportAttempted ? "push" : "proof_before", errorCode };
  await appendRecoveryEvent({ ...options, lane: "push", eventType: "push_outcome", body: { classification, target_commit: legacy.targetCommit } });
  if (classification !== "success" && (classification === "nonretryable" || options.slot === RECOVERY_LANE_BUDGETS.push)) await ensureTerminal(options.abrainHome, options.episodeId, "push", options.slot);
  return { classification, targetCommit: legacy.targetCommit, remoteContainsTarget: remoteContains, ...evidence };
}

async function executeV2PushSlot(options: PushExecutionOptions & { slot: number }): Promise<{ classification: PushClassification; targetCommit: string; remoteContainsTarget: boolean; proof?: StableRemoteProof } & PushTransportEvidence> {
  let classification: PushClassification = "success";
  let remoteContainsTarget = false;
  let proof: StableRemoteProof | undefined;
  let evidence: PushTransportEvidence = { transportAttempted: false, commandExitCode: null, stdoutSha256: null, stderrSha256: null, remoteRefBefore: null, remoteRefAfter: null, stage: "pretransport", errorCode: null };
  let transport: CanonicalGitTransportSession | undefined;
  try {
    if (!options.transportFactory) throw new ConvergenceRecoveryError("TRANSPORT_FACTORY_MISSING", "v2 push execution requires the credential broker transport");
    transport = await options.transportFactory();
    evidence = { ...evidence, stage: "proof_before" };
    proof = await transport.stableProof(options.scope.target_commit);
    evidence = { ...evidence, remoteRefBefore: proof.tipBefore, remoteRefAfter: proof.tipAfter, commandExitCode: proof.commands.at(-1)?.exitCode ?? null, stdoutSha256: proof.commands.at(-1)?.stdoutSha256 ?? null, stderrSha256: proof.commands.at(-1)?.stderrSha256 ?? null };
    remoteContainsTarget = proof.remoteContainsTarget;
    if (!remoteContainsTarget) {
      evidence = { ...evidence, stage: "push", transportAttempted: true };
      const pushed = await transport.push(options.scope.target_commit);
      evidence = { ...evidence, commandExitCode: pushed.command.exitCode, stdoutSha256: pushed.command.stdoutSha256, stderrSha256: pushed.command.stderrSha256 };
      if (pushed.exitCode !== 0) throw new CanonicalGitTransportError(pushed.retryableNetwork ? "NETWORK_TRANSIENT" : "PUSH_REJECTED", "push command did not succeed", { stage: "push", retryable: pushed.retryableNetwork, transportAttempted: true, commandExitCode: pushed.exitCode, stdoutSha256: pushed.command.stdoutSha256, stderrSha256: pushed.command.stderrSha256 });
      evidence = { ...evidence, stage: "proof_after" };
      proof = await transport.stableProof(options.scope.target_commit);
      evidence = { ...evidence, remoteRefAfter: proof.tipAfter, commandExitCode: proof.commands.at(-1)?.exitCode ?? null, stdoutSha256: proof.commands.at(-1)?.stdoutSha256 ?? null, stderrSha256: proof.commands.at(-1)?.stderrSha256 ?? null };
      remoteContainsTarget = proof.remoteContainsTarget;
      if (!remoteContainsTarget) throw new CanonicalGitTransportError("REMOTE_PROOF_MISSING_TARGET", "stable post-push proof does not contain target", { stage: "proof_after", transportAttempted: true });
    }
  } catch (error) {
    classification = error instanceof CanonicalGitTransportError && error.retryable ? "retryable" : "nonretryable";
    evidence = {
      ...evidence,
      stage: error instanceof CanonicalGitTransportError ? error.stage : evidence.stage,
      transportAttempted: error instanceof CanonicalGitTransportError ? error.transportAttempted || evidence.transportAttempted : evidence.transportAttempted,
      commandExitCode: error instanceof CanonicalGitTransportError ? error.commandExitCode : evidence.commandExitCode,
      stdoutSha256: error instanceof CanonicalGitTransportError ? error.stdoutSha256 : evidence.stdoutSha256,
      stderrSha256: error instanceof CanonicalGitTransportError ? error.stderrSha256 : evidence.stderrSha256,
      errorCode: error instanceof CanonicalGitTransportError || error instanceof ConvergenceRecoveryError ? error.code : "PUSH_INTERNAL_FAILURE",
    };
    remoteContainsTarget = false;
  } finally {
    if (options.closeTransport !== false) await transport?.close();
  }
  await appendRecoveryEvent({ ...options, lane: "push", eventType: "push_outcome", body: outcomeBody(options.scope, evidence, classification, remoteContainsTarget) });
  if (classification !== "success" && (classification === "nonretryable" || options.slot === RECOVERY_LANE_BUDGETS.push)) await ensureTerminal(options.abrainHome, options.episodeId, "push", options.slot);
  return { classification, targetCommit: options.scope.target_commit, remoteContainsTarget, ...evidence, ...(proof ? { proof } : {}) };
}

export type PushRecoveryAction = "burned" | "success" | "retryable" | "nonretryable" | "terminal";

/** Recover an old push slot without re-executing it. Late outcomes are folded on the next call. */
export async function recoverPushSlot(options: { abrainHome: string; episodeId: string; slot: number }): Promise<PushRecoveryAction> {
  assertSlot("push", options.slot);
  const state = foldRecoveryEvents(await readRecoveryEvents(options.abrainHome, options.episodeId, "push")).get(options.slot);
  if (!state?.claimed) throw new ConvergenceRecoveryError("RECOVERY_SLOT_UNCLAIMED", "push recovery requires a durable claim");
  if (state.terminal) return "terminal";
  const classification = state.pushOutcome?.body.classification;
  if (classification === "success") return "success";
  if (classification === "nonretryable") {
    await ensureTerminal(options.abrainHome, options.episodeId, "push", options.slot);
    return "nonretryable";
  }
  if (classification === "retryable") {
    if (options.slot === RECOVERY_LANE_BUDGETS.push) {
      await ensureTerminal(options.abrainHome, options.episodeId, "push", options.slot);
      return "terminal";
    }
    return "retryable";
  }
  if (!state.aborted && await abortRecoverySlotAfterRefold({ ...options, lane: "push" }) === "success") return "success";
  return options.slot === RECOVERY_LANE_BUDGETS.push ? "terminal" : "burned";
}

/** Resume an episode, burn a missing result, then execute only the continuous next slot. */
export async function recoverPushEpisode(options: PushExecutionOptions | ({ abrainHome: string; episodeId: string; repo: string; remote: string; refName: string; targetCommit: string })): Promise<{ classification: PushClassification | "burned" | "complete" | "terminal" | "consumed"; targetCommit: string; slot: number | null; remoteContainsTarget: boolean; proof?: StableRemoteProof } & Partial<PushTransportEvidence>> {
  if (!("scope" in options)) {
    if (!legacyFixtureExecutionEnabled(options.repo, options.abrainHome)) throw new ConvergenceRecoveryError("LEGACY_PUSH_EXECUTION_FORBIDDEN", "v1 push execution is disabled");
    options = { ...options, scope: { repo_id: sha256Hex(path.resolve(options.repo)), remote: "origin", ref_name: "refs/heads/main", target_commit: options.targetCommit, remote_url_id: "0".repeat(64), transport_policy_id: "0".repeat(64) }, legacy: { remote: options.remote, refName: options.refName, targetCommit: options.targetCommit } };
  }
  const intent = await readPushIntent(options.abrainHome, options.episodeId);
  if (!intent) throw new ConvergenceRecoveryError("PUSH_INTENT_MISSING", "push execution requires a durable intent");
  const targetCommit = intent.scope.target_commit;
  if (intent.version === "v2") {
    if (options.episodeId !== pushEpisodeIdentity(intent.scope) || canonicalizeJcs(intent.scope as never) !== canonicalizeJcs(options.scope as never)) throw new ConvergenceRecoveryError("PUSH_INTENT_MISMATCH", "v2 push arguments do not exactly match durable intent", { episodeId: options.episodeId });
  } else if (!options.legacy || options.episodeId !== legacyPushEpisodeIdentity({ repo_id: sha256Hex(path.resolve(intent.repo)), ...intent.scope }) || path.resolve(intent.repo) !== path.resolve(options.repo) || canonicalizeJcs(intent.scope as never) !== canonicalizeJcs({ remote: options.legacy.remote, ref_name: options.legacy.refName, target_commit: options.legacy.targetCommit } as never)) {
    throw new ConvergenceRecoveryError("PUSH_INTENT_MISMATCH", "legacy push arguments do not exactly match durable intent", { episodeId: options.episodeId });
  }
  let cursor = recoveryEpisodeCursor(options.episodeId, "push", await readRecoveryEvents(options.abrainHome, options.episodeId, "push"));
  if (cursor.complete) return { classification: "complete", targetCommit, slot: cursor.lastClaimedSlot, remoteContainsTarget: true };
  if (cursor.terminal) return { classification: "terminal", targetCommit, slot: cursor.lastClaimedSlot, remoteContainsTarget: false };
  if (cursor.pendingSlot !== null) {
    const recovered = await recoverPushSlot({ abrainHome: options.abrainHome, episodeId: options.episodeId, slot: cursor.pendingSlot });
    if (recovered === "success") return { classification: "complete", targetCommit, slot: cursor.pendingSlot, remoteContainsTarget: true };
    if (recovered === "nonretryable" || recovered === "terminal") return { classification: "terminal", targetCommit, slot: cursor.pendingSlot, remoteContainsTarget: false };
    cursor = recoveryEpisodeCursor(options.episodeId, "push", await readRecoveryEvents(options.abrainHome, options.episodeId, "push"));
  }
  if (options.allowClaim && !options.allowClaim()) return { classification: "consumed", targetCommit, slot: null, remoteContainsTarget: false };
  const next = await claimNextRecoverySlot({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "push" });
  if (next.status === "complete" || next.status === "terminal") return { classification: next.status, targetCommit, slot: null, remoteContainsTarget: next.status === "complete" };
  if (next.status === "pending" || !next.shouldExecute) return { classification: "consumed", targetCommit, slot: next.slot, remoteContainsTarget: false };
  const result = intent.version === "v2" ? await executeV2PushSlot({ ...options, slot: next.slot }) : await executeLegacyPushSlot({ ...options, slot: next.slot });
  return { ...result, slot: next.slot };
}

/** Compatibility/competition surface. New orchestration should call recoverPushEpisode. */
export async function runPushSlot(options: { abrainHome: string; episodeId: string; slot: number; repo: string; remote: string; refName: string; targetCommit: string }): Promise<({ classification: PushClassification | "consumed"; targetCommit: string; remoteContainsTarget: boolean } & Partial<PushTransportEvidence>)> {
  if (!legacyFixtureExecutionEnabled(options.repo, options.abrainHome)) throw new ConvergenceRecoveryError("LEGACY_PUSH_EXECUTION_FORBIDDEN", "v1 push execution is fixture-only");
  const intent = await readPushIntent(options.abrainHome, options.episodeId);
  if (!intent || intent.version !== "v1" || path.resolve(intent.repo) !== path.resolve(options.repo) || intent.scope.remote !== options.remote || intent.scope.ref_name !== options.refName || intent.scope.target_commit !== options.targetCommit) throw new ConvergenceRecoveryError("PUSH_INTENT_MISMATCH", "push slot arguments do not exactly match durable intent");
  const claim = await claimRecoverySlot({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "push", slot: options.slot });
  if (!claim.shouldExecute) return { classification: "consumed", targetCommit: options.targetCommit, remoteContainsTarget: false };
  return executeLegacyPushSlot({ abrainHome: options.abrainHome, episodeId: options.episodeId, slot: options.slot, repo: options.repo, scope: { repo_id: sha256Hex(path.resolve(options.repo)), remote: "origin", ref_name: "refs/heads/main", target_commit: options.targetCommit, remote_url_id: "0".repeat(64), transport_policy_id: "0".repeat(64) }, legacy: { remote: options.remote, refName: options.refName, targetCommit: options.targetCommit } });
}
