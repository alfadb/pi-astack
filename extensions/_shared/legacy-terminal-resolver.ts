import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  appendRecoveryEvent,
  legacyPushEpisodeIdentity,
  remoteScopeFromBody,
  type RecoveryEvent,
  type RemoteScopeV2,
} from "./convergence-recovery";
import { scanWholeL1Validated, type WholeL1ScanResult } from "./l1-schema-registry";
import { canonicalizeJcs, sha256Hex } from "./jcs";
import { gitSingleFlight } from "./git-singleflight";
import {
  CanonicalGitTransportError,
  type CanonicalGitTransportSession,
  type StableRemoteProof,
} from "./canonical-git-transport";

const ID_RE = /^[0-9a-f]{64}$/;

export class LegacyTerminalResolutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "LegacyTerminalResolutionError";
    this.code = code;
  }
}

interface RecoveryRecord {
  eventId: string;
  body: RecoveryEvent;
}

function recoveryRecords(scan: WholeL1ScanResult): RecoveryRecord[] {
  return scan.all
    .filter((record) => record.registration.envelope_schema === "drain-recovery-envelope/v1")
    .map((record) => ({ eventId: record.eventId, body: record.body as unknown as RecoveryEvent }));
}

function exactId(value: string, field: string): string {
  if (!ID_RE.test(value)) throw new LegacyTerminalResolutionError("LEGACY_ID_INVALID", `${field} must be one exact sha256 id`);
  return value;
}

function scopeWithoutTarget(scope: RemoteScopeV2): string {
  return canonicalizeJcs({
    repo_id: scope.repo_id,
    remote: scope.remote,
    ref_name: scope.ref_name,
    remote_url_id: scope.remote_url_id,
    transport_policy_id: scope.transport_policy_id,
  } as never);
}

export interface LegacyTerminalIds {
  legacyEpisodeId: string;
  intentEventId: string;
  terminalEventId: string;
}

export interface ValidatedLegacyTerminal extends LegacyTerminalIds {
  slot: number;
  targetCommit: string;
  repo: string;
}

export function validateExactLegacyTerminal(input: LegacyTerminalIds & { scan: WholeL1ScanResult; repo: string }): ValidatedLegacyTerminal {
  const legacyEpisodeId = exactId(input.legacyEpisodeId, "legacyEpisodeId");
  const intentEventId = exactId(input.intentEventId, "intentEventId");
  const terminalEventId = exactId(input.terminalEventId, "terminalEventId");
  const records = recoveryRecords(input.scan);
  const intentRecord = records.find((record) => record.eventId === intentEventId);
  const terminalRecord = records.find((record) => record.eventId === terminalEventId);
  if (!intentRecord || intentRecord.body.event_type !== "push_intent") throw new LegacyTerminalResolutionError("LEGACY_INTENT_NOT_FOUND", "exact intent event id is missing or is not push_intent");
  if (!terminalRecord || terminalRecord.body.event_type !== "recovery_episode_terminal") throw new LegacyTerminalResolutionError("LEGACY_TERMINAL_NOT_FOUND", "exact terminal event id is missing or is not recovery_episode_terminal");
  if (intentRecord.body.episode_id !== legacyEpisodeId || terminalRecord.body.episode_id !== legacyEpisodeId || intentRecord.body.lane !== "push" || terminalRecord.body.lane !== "push") {
    throw new LegacyTerminalResolutionError("LEGACY_ID_COHORT_MISMATCH", "episode, intent, and terminal ids do not name one push cohort");
  }
  if (remoteScopeFromBody(intentRecord.body.body)) throw new LegacyTerminalResolutionError("LEGACY_RESOLVER_V2_FORBIDDEN", "v2 push terminals cannot use the legacy resolver");
  const body = intentRecord.body.body;
  if (typeof body.repo !== "string" || !path.isAbsolute(body.repo) || body.remote !== "origin" || body.ref_name !== "refs/heads/main" || typeof body.target_commit !== "string" || !/^[0-9a-f]{40,64}$/.test(body.target_commit)) {
    throw new LegacyTerminalResolutionError("LEGACY_INTENT_INVALID", "legacy intent body is malformed or outside the pinned production remote/ref");
  }
  const expected = legacyPushEpisodeIdentity({ repo_id: sha256Hex(path.resolve(body.repo)), remote: "origin", ref_name: "refs/heads/main", target_commit: body.target_commit });
  if (expected !== legacyEpisodeId || path.resolve(body.repo) !== path.resolve(input.repo)) throw new LegacyTerminalResolutionError("LEGACY_EPISODE_IDENTITY_MISMATCH", "legacy intent fields do not derive the supplied episode/repository");
  if (terminalRecord.body.body.reason !== "owner_intervention_required" || terminalRecord.body.body.owner_alert !== true) throw new LegacyTerminalResolutionError("LEGACY_TERMINAL_INVALID", "legacy terminal body is not the deterministic owner alert");
  return { legacyEpisodeId, intentEventId, terminalEventId, slot: terminalRecord.body.slot, targetCommit: body.target_commit, repo: body.repo };
}

function candidateBody(terminal: ValidatedLegacyTerminal, scope: RemoteScopeV2): Record<string, any> {
  return {
    legacy_episode_id: terminal.legacyEpisodeId,
    legacy_intent_event_id: terminal.intentEventId,
    legacy_terminal_event_id: terminal.terminalEventId,
    scope_version: "remote-scope/v2",
    ...scope,
  };
}

function parseCandidate(event: RecoveryRecord): { ids: LegacyTerminalIds; scope: RemoteScopeV2 } | undefined {
  if (event.body.event_type !== "push_terminal_resolution_candidate") return undefined;
  const body = event.body.body;
  const scope = remoteScopeFromBody(body);
  const expectedKeys = ["legacy_episode_id", "legacy_intent_event_id", "legacy_terminal_event_id", "ref_name", "remote", "remote_url_id", "repo_id", "scope_version", "target_commit", "transport_policy_id"];
  if (Object.keys(body).sort().join("\0") !== expectedKeys.sort().join("\0")
    || !scope || body.scope_version !== "remote-scope/v2"
    || !ID_RE.test(String(body.legacy_episode_id ?? "")) || !ID_RE.test(String(body.legacy_intent_event_id ?? "")) || !ID_RE.test(String(body.legacy_terminal_event_id ?? ""))) return undefined;
  return {
    ids: { legacyEpisodeId: String(body.legacy_episode_id), intentEventId: String(body.legacy_intent_event_id), terminalEventId: String(body.legacy_terminal_event_id) },
    scope,
  };
}

function validAttestation(event: RecoveryRecord, candidateEventId: string, target: string): boolean {
  if (event.body.event_type !== "push_terminal_resolution_attestation") return false;
  const body = event.body.body;
  if (Object.keys(body).sort().join("\0") !== ["candidate_event_id", "observed_tip", "relation"].join("\0")
    || body.candidate_event_id !== candidateEventId
    || typeof body.observed_tip !== "string" || !/^[0-9a-f]{40,64}$/.test(body.observed_tip)
    || (body.relation !== "equal" && body.relation !== "descendant")) return false;
  return body.relation === "equal" ? body.observed_tip === target : body.observed_tip !== target;
}

async function stableProofResampled(session: CanonicalGitTransportSession, target: string, maxSamples = 3): Promise<StableRemoteProof> {
  for (let sample = 1; sample <= maxSamples; sample += 1) {
    try { return await session.stableProof(target); }
    catch (error) {
      if (!(error instanceof CanonicalGitTransportError) || error.code !== "REMOTE_TIP_CHANGED" || sample === maxSamples) throw error;
    }
  }
  throw new LegacyTerminalResolutionError("REMOTE_TIP_UNSTABLE", "stable proof resampling exhausted");
}

export interface LegacyResolutionAssessment {
  effectiveResolvedEpisodeIds: readonly string[];
  currentScopeUnresolved: readonly string[];
  diagnosticsOnlyTerminalIds: readonly string[];
  quarantinedEpisodeIds: readonly string[];
  proofs: ReadonlyMap<string, StableRemoteProof>;
}

/** Candidate/attestation rows are historical evidence only. Effective
 * resolution exists solely for this process after a fresh stable proof. */
export async function assessLegacyTerminalResolutions(options: {
  abrainHome: string;
  currentScope: RemoteScopeV2;
  scan?: WholeL1ScanResult;
  transport?: CanonicalGitTransportSession;
  transportFactory?: () => Promise<CanonicalGitTransportSession>;
}): Promise<LegacyResolutionAssessment> {
  const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: options.abrainHome });
  const records = recoveryRecords(scan);
  const terminals = records.filter((record) => record.body.lane === "push" && record.body.event_type === "recovery_episode_terminal");
  const effective: string[] = [];
  const unresolved: string[] = [];
  const diagnostics: string[] = [];
  const quarantined: string[] = [];
  const proofs = new Map<string, StableRemoteProof>();

  for (const terminalRecord of terminals) {
    const episodeId = terminalRecord.body.episode_id;
    const intentRecord = records.find((record) => record.body.episode_id === episodeId && record.body.event_type === "push_intent");
    if (!intentRecord || remoteScopeFromBody(intentRecord.body.body)) continue;
    const body = intentRecord.body.body;
    if (typeof body.repo !== "string" || typeof body.target_commit !== "string") { quarantined.push(episodeId); continue; }
    const terminalScopeBase = canonicalizeJcs({ repo_id: sha256Hex(path.resolve(body.repo)), remote: body.remote, ref_name: body.ref_name, remote_url_id: options.currentScope.remote_url_id, transport_policy_id: options.currentScope.transport_policy_id } as never);
    if (terminalScopeBase !== scopeWithoutTarget(options.currentScope)) { diagnostics.push(episodeId); continue; }
    const rawCandidates = records.filter((record) => record.body.event_type === "push_terminal_resolution_candidate" && record.body.episode_id === episodeId);
    const episodeCandidates = rawCandidates.map((record) => ({ record, parsed: parseCandidate(record) }));
    if (episodeCandidates.length !== 1 || !episodeCandidates[0]!.parsed) {
      if (episodeCandidates.length > 1 || episodeCandidates.some((item) => !item.parsed)) quarantined.push(episodeId);
      else unresolved.push(episodeId);
      continue;
    }
    const candidate = episodeCandidates[0]! as { record: RecoveryRecord; parsed: { ids: LegacyTerminalIds; scope: RemoteScopeV2 } };
    try {
      const validated = validateExactLegacyTerminal({ ...candidate.parsed.ids, scan, repo: options.abrainHome });
      if (validated.targetCommit !== body.target_commit) throw new LegacyTerminalResolutionError("LEGACY_CANDIDATE_TARGET_MISMATCH", "candidate ids bind a different target");
    } catch {
      quarantined.push(episodeId);
      continue;
    }
    if (candidate.parsed.scope.target_commit !== body.target_commit || scopeWithoutTarget(candidate.parsed.scope) !== scopeWithoutTarget(options.currentScope)) {
      quarantined.push(episodeId);
      continue;
    }
    const attestations = records.filter((record) => record.body.event_type === "push_terminal_resolution_attestation" && record.body.episode_id === episodeId);
    if (!attestations.length) { unresolved.push(episodeId); continue; }
    if (attestations.some((event) => !validAttestation(event, candidate.record.eventId, body.target_commit))) {
      quarantined.push(episodeId);
      continue;
    }
    const transport = options.transport ?? await options.transportFactory?.();
    if (!transport) throw new LegacyTerminalResolutionError("LEGACY_FRESH_PROOF_TRANSPORT_MISSING", "fresh legacy proof requires the broker transport");
    const proof = await stableProofResampled(transport, body.target_commit);
    proofs.set(episodeId, proof);
    if (proof.remoteContainsTarget) effective.push(episodeId);
    else unresolved.push(episodeId);
  }
  return {
    effectiveResolvedEpisodeIds: Object.freeze(effective.sort()),
    currentScopeUnresolved: Object.freeze(unresolved.sort()),
    diagnosticsOnlyTerminalIds: Object.freeze(diagnostics.sort()),
    quarantinedEpisodeIds: Object.freeze(quarantined.sort()),
    proofs,
  };
}

export type ResolveLegacyPushTerminalOptions = LegacyTerminalIds & {
  abrainHome: string;
  scope: RemoteScopeV2;
  transportFactory: () => Promise<CanonicalGitTransportSession>;
};

async function resolveLegacyPushTerminalUnlocked(options: ResolveLegacyPushTerminalOptions): Promise<{ candidateEventId: string; attestationEventId: string; observedTip: string; relation: "equal" | "descendant" }> {
  const repo = await fsp.realpath(path.resolve(options.abrainHome));
  if (options.scope.repo_id !== sha256Hex(repo) || options.scope.target_commit === "") throw new LegacyTerminalResolutionError("LEGACY_SCOPE_MISMATCH", "v2 scope does not bind the resolver repository/target");
  const scan = await scanWholeL1Validated({ abrainHome: repo });
  const terminal = validateExactLegacyTerminal({ ...options, scan, repo });
  if (terminal.targetCommit !== options.scope.target_commit) throw new LegacyTerminalResolutionError("LEGACY_SCOPE_MISMATCH", "v2 scope target differs from legacy intent target");
  const existing = recoveryRecords(scan).map((record) => ({ record, parsed: parseCandidate(record) })).filter((item) => item.parsed?.ids.legacyEpisodeId === terminal.legacyEpisodeId);
  const expectedBody = candidateBody(terminal, options.scope);
  if (existing.some((item) => canonicalizeJcs(item.record.body.body as never) !== canonicalizeJcs(expectedBody as never))) throw new LegacyTerminalResolutionError("LEGACY_CANDIDATE_CONFLICT", "same legacy episode has a different resolution candidate");
  const candidate = await appendRecoveryEvent({ abrainHome: repo, episodeId: terminal.legacyEpisodeId, lane: "push", slot: terminal.slot, eventType: "push_terminal_resolution_candidate", body: expectedBody });

  const transport = await options.transportFactory();
  let proof: StableRemoteProof;
  try {
    proof = await stableProofResampled(transport, terminal.targetCommit);
    if (!proof.remoteContainsTarget) {
      const pushed = await transport.push(terminal.targetCommit);
      if (pushed.exitCode !== 0) throw new LegacyTerminalResolutionError("LEGACY_EXACT_PUSH_FAILED", "brokered legacy target push failed");
      proof = await stableProofResampled(transport, terminal.targetCommit);
    }
  } finally {
    await transport.close();
  }
  if (!proof.remoteContainsTarget || proof.relation === "absent") throw new LegacyTerminalResolutionError("LEGACY_STABLE_PROOF_FAILED", "remote does not stably contain legacy target");
  const attestation = await appendRecoveryEvent({
    abrainHome: repo,
    episodeId: terminal.legacyEpisodeId,
    lane: "push",
    slot: terminal.slot,
    eventType: "push_terminal_resolution_attestation",
    body: { candidate_event_id: candidate.eventId, observed_tip: proof.tipAfter, relation: proof.relation },
  });
  return { candidateEventId: candidate.eventId, attestationEventId: attestation.eventId, observedTip: proof.tipAfter, relation: proof.relation };
}

export async function resolveLegacyPushTerminal(options: ResolveLegacyPushTerminalOptions): Promise<{ candidateEventId: string; attestationEventId: string; observedTip: string; relation: "equal" | "descendant" }> {
  const repo = await fsp.realpath(path.resolve(options.abrainHome));
  return gitSingleFlight(repo, () => resolveLegacyPushTerminalUnlocked({ ...options, abrainHome: repo }));
}
