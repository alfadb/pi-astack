import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile } from "./durable-write";
import {
  cohortManifestRoot,
  convergeExactCohortIndex,
  isAncestor,
  LOCAL_DRAIN_PROTOCOL_V3,
  publishExactCohortCommit,
  refContainsCohort,
  resolveRef,
  verifyCandidateShape,
  type PreparedExactCohortCommit,
} from "./git-exact-cohort";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex, type JcsJsonValue } from "./jcs";
import {
  canonicalL1BodyHash,
  canonicalL1EnvelopeJson,
  expectedL1EventPath,
  isCanonicalCohortPath,
  isGitOid,
  scanWholeL1Validated,
  validateL1WritePreflight,
} from "./l1-schema-registry";

const PROTOCOL_VERSION = "local-drain-recovery/v2" as const;
const EPISODE_DOMAIN = "pi-astack/local-drain/recovery-episode/v2";
const CLAIM_DOMAIN = "pi-astack/local-drain/recovery-claim/v2";
const ENVELOPE_SCHEMA = "local-drain-recovery-envelope/v2" as const;
const EVENT_SCHEMA_VERSION = "local-drain-recovery-event/v2" as const;
export const RECOVERY_PROTOCOL_V3 = "local-drain-recovery/v3" as const;
const CLAIM_DOMAIN_V3 = "pi-astack/local-drain/recovery-claim/v3";
const INDEX_SNAPSHOT_DOMAIN_V3 = "pi-astack/local-drain/frozen-index-snapshot/v3";
const ENVELOPE_SCHEMA_V3 = "local-drain-recovery-envelope/v3" as const;
const EVENT_SCHEMA_VERSION_V3 = "local-drain-recovery-event/v3" as const;
const PRODUCER_NAME = "pi-astack.convergence-recovery" as const;
const PRODUCER_VERSION = "2.0.0" as const;
const PRODUCER_VERSION_V3 = "3.0.0" as const;
const TERMINAL_REASON = "owner_intervention_required" as const;
const ABORT_REASON = "recovery_slot_aborted" as const;
const ABORT_ERROR_CODE = "RECOVERY_SLOT_ABORTED" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

export const RECOVERY_LANE_BUDGETS = Object.freeze({ drain: 5 } as const);
export type RecoveryLane = "drain";
export type RecoveryEventType =
  | "recovery_slot_claimed"
  | "commit_prepared"
  | "commit_published"
  | "index_converged"
  | "recovery_slot_aborted"
  | "recovery_episode_terminal";

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

export interface RecoveryQuarantineDiagnostic {
  readonly status: "quarantined";
  readonly episodeId: string;
  readonly lane: "drain";
  readonly ownerAlert: true;
  readonly errorCode: string;
  readonly message: string;
  readonly detail?: string;
}

const MAX_RECOVERY_DIAGNOSTIC_MESSAGE = 256;
const MAX_RECOVERY_DIAGNOSTIC_DETAIL = 512;

function safeDiagnosticValue(value: unknown, key: string, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) || /^(?:refs\/|RECOVERY_|L1_|local-drain-|v[123]$)/.test(value)) return value.slice(0, 96);
    if (key === "format" && (value === "sha1" || value === "sha256")) return value;
    return Object.freeze({ sha256: sha256Hex(value).slice(0, 16), length: value.length });
  }
  if (Array.isArray(value)) return Object.freeze({ count: value.length, sample: Object.freeze(value.slice(0, 4).map((item) => safeDiagnosticValue(item, key, depth + 1))) });
  if (value && typeof value === "object" && depth < 2) {
    const output: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort(compareCodeUnits);
    for (const childKey of keys.slice(0, 12)) output[childKey] = safeDiagnosticValue((value as Record<string, unknown>)[childKey], childKey, depth + 1);
    if (keys.length > 12) output.omittedKeyCount = keys.length - 12;
    return Object.freeze(output);
  }
  return Object.freeze({ type: typeof value });
}

function sanitizeDiagnosticMessage(input: string): string {
  const withoutAbsolutePaths = input
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, (value) => `<path:${sha256Hex(value).slice(0, 12)}>`)
    .replace(/[A-Za-z]:\\[^\s;|,)]+/g, (value) => `<path:${sha256Hex(value).slice(0, 12)}>`);
  return withoutAbsolutePaths.length <= MAX_RECOVERY_DIAGNOSTIC_MESSAGE
    ? withoutAbsolutePaths
    : `${withoutAbsolutePaths.slice(0, MAX_RECOVERY_DIAGNOSTIC_MESSAGE - 3)}...`;
}

export function recoveryQuarantineDiagnostic(episodeId: string, error: unknown): RecoveryQuarantineDiagnostic {
  const errorCode = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code)
    : "RECOVERY_FOLD_FAILED";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawDetail = error && typeof error === "object" && "detail" in error ? (error as { detail?: unknown }).detail : undefined;
  let detail: string | undefined;
  if (rawDetail !== undefined) {
    const encoded = JSON.stringify(safeDiagnosticValue(rawDetail, "detail"));
    detail = encoded.length <= MAX_RECOVERY_DIAGNOSTIC_DETAIL ? encoded : `${encoded.slice(0, MAX_RECOVERY_DIAGNOSTIC_DETAIL - 3)}...`;
  }
  return Object.freeze({
    status: "quarantined",
    episodeId,
    lane: "drain",
    ownerAlert: true,
    errorCode,
    message: sanitizeDiagnosticMessage(rawMessage),
    ...(detail ? { detail } : {}),
  });
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

export interface RecoveryOperationV3 {
  protocol_version: typeof RECOVERY_PROTOCOL_V3;
  symbolic_ref: string;
  base_commit: string;
  cohort_semantic_root: string;
  frozen_index_snapshot_root: string;
}

export interface RecoveryEventV3 {
  event_schema_version: typeof EVENT_SCHEMA_VERSION_V3;
  event_type: RecoveryEventType;
  producer: { name: typeof PRODUCER_NAME; version: typeof PRODUCER_VERSION_V3 };
  episode_id: string;
  lane: RecoveryLane;
  slot: number;
  operation: RecoveryOperationV3;
  body: Record<string, JcsJsonValue>;
}

interface RecoveryEnvelopeV3 {
  schema: typeof ENVELOPE_SCHEMA_V3;
  canonicalization: "RFC8785-JCS";
  hash_alg: "sha256";
  event_id: string;
  body_hash: string;
  body: RecoveryEventV3;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertHash(value: string, field: string): void {
  if (!HASH_RE.test(value)) throw new ConvergenceRecoveryError("RECOVERY_ID_INVALID", `${field} must be lowercase SHA-256 hex`);
}

function assertSymbolicRef(value: string): void {
  if (!(value === "HEAD" || /^refs\/[A-Za-z0-9._\/-]+$/.test(value)) || value.includes("..") || value.endsWith("/")) {
    throw new ConvergenceRecoveryError("RECOVERY_REF_INVALID", "symbolic_ref is invalid");
  }
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > RECOVERY_LANE_BUDGETS.drain) {
    throw new ConvergenceRecoveryError("RECOVERY_SLOT_INVALID", `drain slot must be 1..${RECOVERY_LANE_BUDGETS.drain}`);
  }
}

export function recoveryEpisodeIdentity(input: {
  protocol_version?: typeof PROTOCOL_VERSION;
  lane?: RecoveryLane;
  symbolic_ref: string;
  generation_anchor: string;
}): string {
  assertSymbolicRef(input.symbolic_ref);
  if (!input.generation_anchor) throw new ConvergenceRecoveryError("RECOVERY_ANCHOR_INVALID", "generation_anchor is required");
  return jcsSha256Hex({
    domain: EPISODE_DOMAIN,
    protocol_version: PROTOCOL_VERSION,
    lane: "drain",
    symbolic_ref: input.symbolic_ref,
    generation_anchor: input.generation_anchor,
  });
}

export function drainEpisodeIdentity(input: { symbolic_ref: string; generation_anchor: string }): string {
  return recoveryEpisodeIdentity(input);
}

export function deriveNextEpisodeIdentity(input: { symbolicRef: string; generationAnchor: string }): string {
  return drainEpisodeIdentity({ symbolic_ref: input.symbolicRef, generation_anchor: input.generationAnchor });
}

export function recoveryClaimId(episodeId: string, lane: RecoveryLane, slot: number): string {
  assertHash(episodeId, "episode_id");
  if (lane !== "drain") throw new ConvergenceRecoveryError("RECOVERY_LANE_INVALID", "v2 supports only the drain lane");
  assertSlot(slot);
  return jcsSha256Hex({ domain: CLAIM_DOMAIN, episode_id: episodeId, lane, slot });
}

function makeEvent(episodeId: string, slot: number, eventType: RecoveryEventType, body: Record<string, JcsJsonValue>): RecoveryEvent {
  assertHash(episodeId, "episode_id");
  assertSlot(slot);
  return {
    event_schema_version: EVENT_SCHEMA_VERSION,
    event_type: eventType,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
    episode_id: episodeId,
    lane: "drain",
    slot,
    body,
  };
}

function makeEnvelope(event: RecoveryEvent): RecoveryEnvelope {
  const bodyHash = canonicalL1BodyHash(event);
  return { schema: ENVELOPE_SCHEMA, canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: bodyHash, body_hash: bodyHash, body: event };
}

async function createRecoveryEnvelope(abrainHome: string, event: RecoveryEvent): Promise<{ status: "created" | "identical"; filePath: string; eventId: string }> {
  const envelope = makeEnvelope(event);
  const filePath = expectedL1EventPath(abrainHome, envelope.event_id);
  await validateL1WritePreflight({
    abrainHome,
    envelope,
    targetPath: filePath,
    expected: {
      envelopeSchema: ENVELOPE_SCHEMA,
      bodySchema: EVENT_SCHEMA_VERSION,
      domain: "canonical_path",
      role: "meta",
      producer: PRODUCER_NAME,
      eventType: event.event_type,
    },
  });
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const status = await durableAtomicCreateFile(filePath, canonicalL1EnvelopeJson(envelope));
  if (status === "collision") throw new ConvergenceRecoveryError("RECOVERY_DURABLE_COLLISION", `different bytes occupy ${filePath}`, { filePath });
  return { status, filePath, eventId: envelope.event_id };
}

export interface ClaimResult {
  status: "acquired" | "consumed";
  shouldExecute: boolean;
  claimId: string;
  filePath: string;
}

function rejectV2Mutation(): never {
  throw new ConvergenceRecoveryError("L1_SCHEMA_WRITE_DISABLED", "local drain recovery v2 is legacy read-only");
}

export async function claimRecoverySlot(options: { abrainHome: string; episodeId: string; lane: RecoveryLane; slot: number }): Promise<ClaimResult> {
  rejectV2Mutation();
  if (options.lane !== "drain") throw new ConvergenceRecoveryError("RECOVERY_LANE_INVALID", "v2 supports only the drain lane");
  const claimId = recoveryClaimId(options.episodeId, "drain", options.slot);
  const created = await createRecoveryEnvelope(options.abrainHome, makeEvent(options.episodeId, options.slot, "recovery_slot_claimed", { claim_id: claimId }));
  return { status: created.status === "created" ? "acquired" : "consumed", shouldExecute: created.status === "created", claimId, filePath: created.filePath };
}

export async function appendRecoveryEvent(options: {
  abrainHome: string;
  episodeId: string;
  lane: RecoveryLane;
  slot: number;
  eventType: RecoveryEventType;
  body: Record<string, JcsJsonValue>;
}): Promise<{ status: "created" | "identical"; event: RecoveryEvent; filePath: string; eventId: string }> {
  rejectV2Mutation();
  if (options.lane !== "drain") throw new ConvergenceRecoveryError("RECOVERY_LANE_INVALID", "v2 supports only the drain lane");
  const event = makeEvent(options.episodeId, options.slot, options.eventType, options.body);
  return { ...(await createRecoveryEnvelope(options.abrainHome, event)), event };
}

function recoveryRecords(scan: Awaited<ReturnType<typeof scanWholeL1Validated>>): RecoveryEvent[] {
  return scan.all
    .filter((record) => record.registration.envelope_schema === ENVELOPE_SCHEMA)
    .map((record) => record.body as unknown as RecoveryEvent);
}

export async function readRecoveryEvents(abrainHome: string, episodeId: string, lane: RecoveryLane = "drain"): Promise<RecoveryEvent[]> {
  assertHash(episodeId, "episode_id");
  if (lane !== "drain") throw new ConvergenceRecoveryError("RECOVERY_LANE_INVALID", "v2 supports only the drain lane");
  return recoveryRecords(await scanWholeL1Validated({ abrainHome }))
    .filter((event) => event.episode_id === episodeId)
    .sort((a, b) => a.slot - b.slot || compareCodeUnits(a.event_type, b.event_type) || compareCodeUnits(canonicalizeJcs(a), canonicalizeJcs(b)));
}

export interface FoldedRecoverySlot {
  claimId?: string;
  claimed?: RecoveryEvent;
  prepared?: RecoveryEvent;
  published?: RecoveryEvent;
  converged?: RecoveryEvent;
  aborted?: RecoveryEvent;
  terminal?: RecoveryEvent;
}

function unique(existing: RecoveryEvent | undefined, next: RecoveryEvent): RecoveryEvent {
  if (existing && canonicalizeJcs(existing) !== canonicalizeJcs(next)) {
    throw new ConvergenceRecoveryError("RECOVERY_EVENT_INVARIANT", `conflicting ${next.event_type} events in slot ${next.slot}`);
  }
  return next;
}

export function foldRecoveryEvents(events: readonly RecoveryEvent[]): ReadonlyMap<number, Readonly<FoldedRecoverySlot>> {
  const folded = new Map<number, FoldedRecoverySlot>();
  let episode: string | undefined;
  for (const event of events) {
    assertSlot(event.slot);
    if (event.lane !== "drain" || event.event_schema_version !== EVENT_SCHEMA_VERSION) throw new ConvergenceRecoveryError("RECOVERY_LANE_INVARIANT", "fold accepts only active drain v2 events");
    if (episode && episode !== event.episode_id) throw new ConvergenceRecoveryError("RECOVERY_FOLD_MIXED_EPISODE", "fold input mixes episodes");
    episode = event.episode_id;
    const slot = folded.get(event.slot) ?? {};
    if (event.event_type === "recovery_slot_claimed") {
      const claimId = String(event.body.claim_id ?? "");
      const expected = recoveryClaimId(event.episode_id, "drain", event.slot);
      if (claimId !== expected) throw new ConvergenceRecoveryError("RECOVERY_CLAIM_INVARIANT", "claim id is not deterministic", { expected, actual: claimId });
      slot.claimed = unique(slot.claimed, event); slot.claimId = claimId;
    } else if (event.event_type === "commit_prepared") slot.prepared = unique(slot.prepared, event);
    else if (event.event_type === "commit_published") slot.published = unique(slot.published, event);
    else if (event.event_type === "index_converged") slot.converged = unique(slot.converged, event);
    else if (event.event_type === "recovery_slot_aborted") slot.aborted = unique(slot.aborted, event);
    else slot.terminal = unique(slot.terminal, event);
    folded.set(event.slot, slot);
  }
  const slots = [...folded.keys()].sort((a, b) => a - b);
  for (const number of slots) {
    const slot = folded.get(number)!;
    if (!slot.claimed && (slot.prepared || slot.published || slot.converged || slot.aborted || slot.terminal)) throw new ConvergenceRecoveryError("RECOVERY_RESULT_WITHOUT_CLAIM", `slot ${number} has result without claim`);
    if (slot.published && !slot.prepared) throw new ConvergenceRecoveryError("RECOVERY_STATE_ORDER", `slot ${number} published without prepared`);
    if (slot.converged && !slot.published) throw new ConvergenceRecoveryError("RECOVERY_STATE_ORDER", `slot ${number} converged without published`);
    const candidate = slot.prepared?.body.candidate;
    if (slot.published && slot.published.body.candidate !== candidate) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} publication candidate mismatch`);
    if (slot.converged && slot.converged.body.candidate !== candidate) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} convergence candidate mismatch`);
    if (slot.aborted && (slot.aborted.body.reason !== ABORT_REASON || slot.aborted.body.error_code !== ABORT_ERROR_CODE)) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} abort body mismatch`);
    if (slot.terminal && (slot.terminal.body.reason !== TERMINAL_REASON || slot.terminal.body.owner_alert !== true)) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `slot ${number} terminal body mismatch`);
  }
  const claimed = slots.filter((slot) => folded.get(slot)!.claimed);
  for (let index = 0; index < claimed.length; index += 1) if (claimed[index] !== index + 1) throw new ConvergenceRecoveryError("RECOVERY_SLOT_GAP", "claimed slots must be contiguous", { claimed });
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
  const lastClaimedSlot = claimed.at(-1) ?? null;
  const complete = slots.some((slot) => Boolean(folded.get(slot)!.converged && !folded.get(slot)!.aborted));
  const terminal = slots.some((slot) => Boolean(folded.get(slot)!.terminal));
  const pendingSlot = lastClaimedSlot !== null && !folded.get(lastClaimedSlot)!.aborted && !folded.get(lastClaimedSlot)!.converged && !terminal ? lastClaimedSlot : null;
  const candidate = (lastClaimedSlot ?? 0) + 1;
  return { episodeId, lane, nextSlot: complete || terminal || candidate > 5 ? null : candidate, lastClaimedSlot, complete, terminal, pendingSlot, folded };
}

export interface OpenRecoveryEpisodesResult {
  open: readonly RecoveryEpisodeCursor[];
  terminal: readonly RecoveryEpisodeCursor[];
  quarantined: readonly RecoveryQuarantineDiagnostic[];
}

export function recoverOpenRecoveryEpisodesFromScan(scan: Awaited<ReturnType<typeof scanWholeL1Validated>>): OpenRecoveryEpisodesResult {
  const groups = new Map<string, RecoveryEvent[]>();
  for (const event of recoveryRecords(scan)) groups.set(event.episode_id, [...(groups.get(event.episode_id) ?? []), event]);
  const open: RecoveryEpisodeCursor[] = [];
  const terminal: RecoveryEpisodeCursor[] = [];
  const quarantined: OpenRecoveryEpisodesResult["quarantined"][number][] = [];
  for (const [episodeId, events] of groups) {
    try {
      const cursor = recoveryEpisodeCursor(episodeId, "drain", events);
      if (cursor.terminal) terminal.push(cursor);
      else if (!cursor.complete) open.push(cursor);
    } catch (error) {
      quarantined.push(recoveryQuarantineDiagnostic(episodeId, error));
    }
  }
  const byEpisode = (a: { episodeId: string }, b: { episodeId: string }) => compareCodeUnits(a.episodeId, b.episodeId);
  return { open: Object.freeze(open.sort(byEpisode)), terminal: Object.freeze(terminal.sort(byEpisode)), quarantined: Object.freeze(quarantined.sort(byEpisode)) };
}

export async function recoverOpenRecoveryEpisodes(abrainHome: string): Promise<OpenRecoveryEpisodesResult> {
  return recoverOpenRecoveryEpisodesFromScan(await scanWholeL1Validated({ abrainHome }));
}

export interface ResolvedDrainEpisode {
  episodeId: string;
  generationAnchor: string;
  status: "new" | "open" | "terminal";
}

export async function resolveRecoveryEpisode(options: {
  abrainHome: string;
  symbolicRef: string;
  genesisAnchor?: string;
}): Promise<ResolvedDrainEpisode> {
  assertSymbolicRef(options.symbolicRef);
  const events = recoveryRecords(await scanWholeL1Validated({ abrainHome: options.abrainHome }));
  const groups = new Map<string, RecoveryEvent[]>();
  for (const event of events) groups.set(event.episode_id, [...(groups.get(event.episode_id) ?? []), event]);
  let generationAnchor = options.genesisAnchor ?? "genesis";
  for (let generation = 0; generation <= groups.size; generation += 1) {
    const episodeId = deriveNextEpisodeIdentity({ symbolicRef: options.symbolicRef, generationAnchor });
    const group = groups.get(episodeId);
    if (!group) return { episodeId, generationAnchor, status: "new" };
    const cursor = recoveryEpisodeCursor(episodeId, "drain", group);
    if (cursor.terminal) return { episodeId, generationAnchor, status: "terminal" };
    if (!cursor.complete) return { episodeId, generationAnchor, status: "open" };
    const closure = [...cursor.folded.values()].map((slot) => slot.converged).filter((event): event is RecoveryEvent => !!event)
      .sort((a, b) => a.slot - b.slot || compareCodeUnits(canonicalizeJcs(a), canonicalizeJcs(b)))[0];
    if (!closure) throw new ConvergenceRecoveryError("RECOVERY_EPISODE_CLOSURE_MISSING", "complete episode has no convergence event");
    generationAnchor = canonicalL1BodyHash(closure);
  }
  throw new ConvergenceRecoveryError("RECOVERY_EPISODE_CHAIN_CYCLE", "episode generation chain did not terminate");
}

export type NextSlotResult =
  | ({ status: "acquired" | "consumed"; slot: number } & ClaimResult)
  | { status: "pending"; slot: number; shouldExecute: false }
  | { status: "complete" | "terminal"; slot: null; shouldExecute: false };

async function ensureTerminal(abrainHome: string, episodeId: string, slot: number): Promise<void> {
  await appendRecoveryEvent({ abrainHome, episodeId, lane: "drain", slot, eventType: "recovery_episode_terminal", body: { reason: TERMINAL_REASON, owner_alert: true } });
}

export async function claimNextRecoverySlot(options: { abrainHome: string; episodeId: string; lane: RecoveryLane }): Promise<NextSlotResult> {
  const cursor = recoveryEpisodeCursor(options.episodeId, "drain", await readRecoveryEvents(options.abrainHome, options.episodeId));
  if (cursor.complete) return { status: "complete", slot: null, shouldExecute: false };
  if (cursor.terminal) return { status: "terminal", slot: null, shouldExecute: false };
  if (cursor.pendingSlot !== null) return { status: "pending", slot: cursor.pendingSlot, shouldExecute: false };
  if (cursor.nextSlot === null) {
    await ensureTerminal(options.abrainHome, options.episodeId, cursor.lastClaimedSlot ?? 5);
    return { status: "terminal", slot: null, shouldExecute: false };
  }
  const claim = await claimRecoverySlot({ ...options, lane: "drain", slot: cursor.nextSlot });
  return { ...claim, slot: cursor.nextSlot };
}

function preparedBody(prepared: PreparedExactCohortCommit, snapshot: ReadonlyMap<string, string>): Record<string, JcsJsonValue> {
  return {
    symbolic_ref: prepared.refName,
    frozen_commit: prepared.frozenCommit,
    new_tree: prepared.newTree,
    candidate: prepared.candidate,
    cohort_manifest_root: prepared.cohortManifestRoot,
    entries: prepared.entries.map((entry) => ({ ...entry })) as unknown as JcsJsonValue,
    frozen_index_snapshot: Object.fromEntries(prepared.entries.map((entry) => [entry.path, snapshot.get(entry.path) ?? null])),
  };
}

export async function recordDrainPrepared(options: { abrainHome: string; episodeId: string; slot: number; prepared: PreparedExactCohortCommit; frozenIndexSnapshot: ReadonlyMap<string, string> }): Promise<void> {
  await appendRecoveryEvent({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "drain", slot: options.slot, eventType: "commit_prepared", body: preparedBody(options.prepared, options.frozenIndexSnapshot) });
}

export function decodePreparedRecoveryEvent(event: Pick<RecoveryEvent, "body" | "slot"> | Pick<RecoveryEventV3, "body" | "slot">, repo: string, symbolicRef: string, protocolVersion: "local-drain-recovery/v2" | "local-drain-recovery/v3" = PROTOCOL_VERSION): { prepared: PreparedExactCohortCommit; snapshot: ReadonlyMap<string, string> } {
  const body = event.body as Record<string, unknown>;
  const fail = (message: string): never => { throw new ConvergenceRecoveryError("RECOVERY_PREPARED_INVALID", message, { slot: event.slot }); };
  const text = (key: string): string => typeof body[key] === "string" && body[key] ? body[key] as string : fail(`${key} must be a non-empty string`);
  if (text("symbolic_ref") !== symbolicRef) fail("symbolic_ref does not match runtime");
  const entries = Array.isArray(body.entries) ? body.entries as PreparedExactCohortCommit["entries"] : fail("entries must be an array");
  if (!entries.length) fail("entries must be a non-empty array");
  let previousPath: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).sort(compareCodeUnits).join("\0") !== ["blobOid", "bytesSha256", "mode", "op", "path"].join("\0") || !isCanonicalCohortPath(entry.path)) fail(`entries[${index}] shape/path is invalid`);
    if (previousPath !== null && compareCodeUnits(previousPath, entry.path) >= 0) fail(`entries[${index}].path is duplicated or unsorted`);
    if (entry.op === "put") {
      if ((entry.mode !== "100644" && entry.mode !== "100755") || !isGitOid(entry.blobOid) || !HASH_RE.test(entry.bytesSha256)) fail(`entries[${index}] put fields are invalid`);
    } else if (entry.op === "delete") {
      if (entry.mode !== "000000" || entry.blobOid !== "" || entry.bytesSha256 !== "") fail(`entries[${index}] delete fields are invalid`);
    } else fail(`entries[${index}].op is invalid`);
    previousPath = entry.path;
  }
  if (cohortManifestRoot(entries, protocolVersion) !== text("cohort_manifest_root")) fail("cohort manifest does not match entries");
  const rawSnapshot = body.frozen_index_snapshot;
  if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) fail("frozen_index_snapshot must be an object");
  const entryPaths = new Set(entries.map((entry) => entry.path));
  const snapshotKeys = Object.keys(rawSnapshot as Record<string, unknown>);
  if (snapshotKeys.length !== entryPaths.size || snapshotKeys.some((key) => !entryPaths.has(key))) fail("frozen_index_snapshot keys must equal entry paths");
  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(rawSnapshot as Record<string, unknown>)) {
    if (!isCanonicalCohortPath(key) || !entryPaths.has(key)) fail(`snapshot ${key} path is invalid`);
    if (value === null) continue;
    const snapshotValue: string = typeof value === "string" ? value : fail(`snapshot ${key} value is invalid`);
    if (!/^(?:100644|100755|120000|160000) (?:[0-9a-f]{40}|[0-9a-f]{64}) 0$/.test(snapshotValue)) fail(`snapshot ${key} value is invalid`);
    snapshot.set(key, snapshotValue);
  }
  const prepared: PreparedExactCohortCommit = {
    repo,
    refName: symbolicRef,
    frozenCommit: text("frozen_commit"),
    newTree: text("new_tree"),
    candidate: text("candidate"),
    cohortManifestRoot: text("cohort_manifest_root"),
    entries,
  };
  if (![prepared.frozenCommit, prepared.newTree, prepared.candidate].every(isGitOid)) fail("prepared OID is invalid");
  return { prepared, snapshot };
}

export type DrainRecoveryAction = "burned" | "published" | "absorbed" | "index_converged" | "refreeze_required" | "already_complete" | "terminal";

export async function abortRecoverySlotAfterRefold(options: { abrainHome: string; episodeId: string; lane: RecoveryLane; slot: number }, immediateTerminal = false): Promise<"aborted" | "already_complete"> {
  const state = foldRecoveryEvents(await readRecoveryEvents(options.abrainHome, options.episodeId)).get(options.slot);
  if (state?.converged) return "already_complete";
  await appendRecoveryEvent({ ...options, lane: "drain", eventType: "recovery_slot_aborted", body: { reason: ABORT_REASON, error_code: ABORT_ERROR_CODE } });
  if (immediateTerminal || options.slot === 5) await ensureTerminal(options.abrainHome, options.episodeId, options.slot);
  return "aborted";
}

export async function burnPendingRecoverySlot(options: { abrainHome: string; episodeId: string; lane: RecoveryLane }): Promise<number | "already_complete" | null> {
  const cursor = recoveryEpisodeCursor(options.episodeId, "drain", await readRecoveryEvents(options.abrainHome, options.episodeId));
  if (cursor.pendingSlot === null) return null;
  const result = await abortRecoverySlotAfterRefold({ ...options, lane: "drain", slot: cursor.pendingSlot });
  return result === "aborted" ? cursor.pendingSlot : result;
}

async function currentContainsPrepared(prepared: PreparedExactCohortCommit): Promise<boolean> {
  const current = await resolveRef(prepared.repo, prepared.refName);
  return await isAncestor(prepared.repo, prepared.candidate, current)
    || await refContainsCohort(prepared.repo, prepared.refName, prepared.entries);
}

export async function recoverDrainSlot(options: {
  abrainHome: string;
  repo: string;
  symbolicRef: string;
  episodeId: string;
  slot: number;
  prePublishCheck?: () => Promise<void>;
  preConvergeCheck?: () => Promise<void>;
}): Promise<DrainRecoveryAction> {
  rejectV2Mutation();
  assertSlot(options.slot);
  const state = foldRecoveryEvents(await readRecoveryEvents(options.abrainHome, options.episodeId)).get(options.slot);
  if (!state?.claimed) throw new ConvergenceRecoveryError("RECOVERY_SLOT_UNCLAIMED", "restart recovery requires a durable claim");
  if (state.terminal) return "terminal";
  if (state.converged) return "already_complete";
  if (state.aborted) return options.slot === 5 ? "terminal" : "refreeze_required";
  if (!state.prepared) {
    if (await abortRecoverySlotAfterRefold({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "drain", slot: options.slot }) === "already_complete") return "already_complete";
    return options.slot === 5 ? "terminal" : "burned";
  }
  const { prepared, snapshot } = decodePreparedRecoveryEvent(state.prepared, path.resolve(options.repo), options.symbolicRef);
  if (!await verifyCandidateShape(prepared.repo, prepared.candidate, prepared)) {
    if (await abortRecoverySlotAfterRefold({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "drain", slot: options.slot }) === "already_complete") return "already_complete";
    return options.slot === 5 ? "terminal" : "refreeze_required";
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
      if (await abortRecoverySlotAfterRefold({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "drain", slot: options.slot }) === "already_complete") return "already_complete";
      return options.slot === 5 ? "terminal" : "refreeze_required";
    }
    await appendRecoveryEvent({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "drain", slot: options.slot, eventType: "commit_published", body: { candidate: prepared.candidate, publication_confirmed: true } });
  } else if (!await currentContainsPrepared(prepared)) {
    throw new ConvergenceRecoveryError("RECOVERY_PUBLISHED_REF_DIVERGED", "published candidate/cohort is not contained by the configured ref", { episodeId: options.episodeId, slot: options.slot });
  }
  await options.preConvergeCheck?.();
  await convergeExactCohortIndex({ repo: prepared.repo, refName: prepared.refName, cohortPaths: prepared.entries.map((entry) => entry.path), frozenIndexSnapshot: snapshot });
  await appendRecoveryEvent({ abrainHome: options.abrainHome, episodeId: options.episodeId, lane: "drain", slot: options.slot, eventType: "index_converged", body: { candidate: prepared.candidate } });
  return "index_converged";
}

export function frozenIndexSnapshotRootV3(entries: readonly { path: string }[], snapshot: ReadonlyMap<string, string>): string {
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.path, b.path));
  return jcsSha256Hex({
    domain: INDEX_SNAPSHOT_DOMAIN_V3,
    entries: sorted.map((entry) => ({ path: entry.path, value: snapshot.get(entry.path) ?? null })),
  });
}

export function recoveryOperationV3(input: {
  symbolicRef: string;
  baseCommit: string;
  cohortSemanticRoot: string;
  frozenIndexSnapshotRoot: string;
}): RecoveryOperationV3 {
  assertSymbolicRef(input.symbolicRef);
  if (!isGitOid(input.baseCommit)) throw new ConvergenceRecoveryError("RECOVERY_BASE_INVALID", "v3 base_commit must be a Git OID");
  assertHash(input.cohortSemanticRoot, "cohort_semantic_root");
  assertHash(input.frozenIndexSnapshotRoot, "frozen_index_snapshot_root");
  return Object.freeze({
    protocol_version: RECOVERY_PROTOCOL_V3,
    symbolic_ref: input.symbolicRef,
    base_commit: input.baseCommit,
    cohort_semantic_root: input.cohortSemanticRoot,
    frozen_index_snapshot_root: input.frozenIndexSnapshotRoot,
  });
}

export function recoveryEpisodeIdentityV3(operation: RecoveryOperationV3): string {
  return jcsSha256Hex(recoveryOperationV3({
    symbolicRef: operation.symbolic_ref,
    baseCommit: operation.base_commit,
    cohortSemanticRoot: operation.cohort_semantic_root,
    frozenIndexSnapshotRoot: operation.frozen_index_snapshot_root,
  }));
}

export function recoveryClaimIdV3(episodeId: string, slot: number): string {
  assertHash(episodeId, "episode_id");
  assertSlot(slot);
  return jcsSha256Hex({ domain: CLAIM_DOMAIN_V3, episode_id: episodeId, lane: "drain", slot });
}

function makeEventV3(operation: RecoveryOperationV3, slot: number, eventType: RecoveryEventType, body: Record<string, JcsJsonValue>): RecoveryEventV3 {
  const exactOperation = recoveryOperationV3({
    symbolicRef: operation.symbolic_ref,
    baseCommit: operation.base_commit,
    cohortSemanticRoot: operation.cohort_semantic_root,
    frozenIndexSnapshotRoot: operation.frozen_index_snapshot_root,
  });
  assertSlot(slot);
  return {
    event_schema_version: EVENT_SCHEMA_VERSION_V3,
    event_type: eventType,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION_V3 },
    episode_id: recoveryEpisodeIdentityV3(exactOperation),
    lane: "drain",
    slot,
    operation: exactOperation,
    body,
  };
}

async function createRecoveryEnvelopeV3(abrainHome: string, event: RecoveryEventV3): Promise<{ status: "created" | "identical"; filePath: string; eventId: string }> {
  const bodyHash = canonicalL1BodyHash(event);
  const envelope: RecoveryEnvelopeV3 = {
    schema: ENVELOPE_SCHEMA_V3,
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body: event,
  };
  const filePath = expectedL1EventPath(abrainHome, envelope.event_id);
  await validateL1WritePreflight({
    abrainHome,
    envelope,
    targetPath: filePath,
    expected: {
      envelopeSchema: ENVELOPE_SCHEMA_V3,
      bodySchema: EVENT_SCHEMA_VERSION_V3,
      domain: "canonical_path",
      role: "meta",
      producer: PRODUCER_NAME,
      eventType: event.event_type,
    },
  });
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const status = await durableAtomicCreateFile(filePath, canonicalL1EnvelopeJson(envelope));
  if (status === "collision") throw new ConvergenceRecoveryError("RECOVERY_DURABLE_COLLISION", `different bytes occupy ${filePath}`, { filePath });
  return { status, filePath, eventId: envelope.event_id };
}

export async function appendRecoveryEventV3(options: {
  abrainHome: string;
  operation: RecoveryOperationV3;
  slot: number;
  eventType: RecoveryEventType;
  body: Record<string, JcsJsonValue>;
}): Promise<{ status: "created" | "identical"; event: RecoveryEventV3; filePath: string; eventId: string }> {
  const event = makeEventV3(options.operation, options.slot, options.eventType, options.body);
  return { ...(await createRecoveryEnvelopeV3(options.abrainHome, event)), event };
}

function recoveryRecordsV3(scan: Awaited<ReturnType<typeof scanWholeL1Validated>>): RecoveryEventV3[] {
  return scan.selected
    .filter((record) => record.registration.envelope_schema === ENVELOPE_SCHEMA_V3)
    .map((record) => record.body as unknown as RecoveryEventV3);
}

export async function readRecoveryEventsV3(abrainHome: string, episodeId: string): Promise<RecoveryEventV3[]> {
  assertHash(episodeId, "episode_id");
  return recoveryRecordsV3(await scanWholeL1Validated({ abrainHome }))
    .filter((event) => event.episode_id === episodeId)
    .sort((a, b) => a.slot - b.slot || compareCodeUnits(a.event_type, b.event_type) || compareCodeUnits(canonicalizeJcs(a), canonicalizeJcs(b)));
}

export interface FoldedRecoverySlotV3 {
  claimId?: string;
  claimed?: RecoveryEventV3;
  prepared?: RecoveryEventV3;
  published?: RecoveryEventV3;
  converged?: RecoveryEventV3;
  aborted?: RecoveryEventV3;
  terminal?: RecoveryEventV3;
  staleAbort?: RecoveryEventV3;
  staleTerminal?: RecoveryEventV3;
}

function uniqueV3(existing: RecoveryEventV3 | undefined, next: RecoveryEventV3): RecoveryEventV3 {
  if (existing && canonicalizeJcs(existing) !== canonicalizeJcs(next)) {
    throw new ConvergenceRecoveryError("RECOVERY_EVENT_INVARIANT", `conflicting ${next.event_type} events in v3 slot ${next.slot}`, {
      episodeId: next.episode_id,
      slot: next.slot,
      eventIds: [canonicalL1BodyHash(existing), canonicalL1BodyHash(next)].sort(compareCodeUnits),
    });
  }
  return next;
}

export function foldRecoveryEventsV3(events: readonly RecoveryEventV3[]): ReadonlyMap<number, Readonly<FoldedRecoverySlotV3>> {
  const folded = new Map<number, FoldedRecoverySlotV3>();
  let episodeId: string | undefined;
  let operationBytes: string | undefined;
  for (const event of events) {
    assertSlot(event.slot);
    if (event.lane !== "drain" || event.event_schema_version !== EVENT_SCHEMA_VERSION_V3) throw new ConvergenceRecoveryError("RECOVERY_LANE_INVARIANT", "v3 fold accepts only active drain v3 events");
    const expectedEpisode = recoveryEpisodeIdentityV3(event.operation);
    if (event.episode_id !== expectedEpisode) throw new ConvergenceRecoveryError("RECOVERY_EPISODE_INVARIANT", "v3 event episode does not bind its exact operation");
    if (episodeId && episodeId !== event.episode_id) throw new ConvergenceRecoveryError("RECOVERY_FOLD_MIXED_EPISODE", "v3 fold input mixes episodes");
    episodeId = event.episode_id;
    const encodedOperation = canonicalizeJcs(event.operation);
    if (operationBytes && operationBytes !== encodedOperation) throw new ConvergenceRecoveryError("RECOVERY_OPERATION_INVARIANT", "v3 episode mixes exact operations");
    operationBytes = encodedOperation;
    const slot = folded.get(event.slot) ?? {};
    if (event.event_type === "recovery_slot_claimed") {
      const claimId = String(event.body.claim_id ?? "");
      const expected = recoveryClaimIdV3(event.episode_id, event.slot);
      if (claimId !== expected) throw new ConvergenceRecoveryError("RECOVERY_CLAIM_INVARIANT", "v3 claim id is not deterministic", { expected, actual: claimId });
      slot.claimed = uniqueV3(slot.claimed, event); slot.claimId = claimId;
    } else if (event.event_type === "commit_prepared") slot.prepared = uniqueV3(slot.prepared, event);
    else if (event.event_type === "commit_published") slot.published = uniqueV3(slot.published, event);
    else if (event.event_type === "index_converged") slot.converged = uniqueV3(slot.converged, event);
    else if (event.event_type === "recovery_slot_aborted") slot.aborted = uniqueV3(slot.aborted, event);
    else slot.terminal = uniqueV3(slot.terminal, event);
    folded.set(event.slot, slot);
  }
  const slots = [...folded.keys()].sort((a, b) => a - b);
  for (const number of slots) {
    const slot = folded.get(number)!;
    if (!slot.claimed && (slot.prepared || slot.published || slot.converged || slot.aborted || slot.terminal)) throw new ConvergenceRecoveryError("RECOVERY_RESULT_WITHOUT_CLAIM", `v3 slot ${number} has result without claim`);
    if (slot.published && !slot.prepared) throw new ConvergenceRecoveryError("RECOVERY_STATE_ORDER", `v3 slot ${number} published without prepared`);
    if (slot.converged && !slot.published) throw new ConvergenceRecoveryError("RECOVERY_STATE_ORDER", `v3 slot ${number} converged without published`);
    if (slot.aborted && (slot.aborted.body.reason !== ABORT_REASON || slot.aborted.body.error_code !== ABORT_ERROR_CODE)) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `v3 slot ${number} abort body mismatch`);
    if (slot.terminal && (slot.terminal.body.reason !== TERMINAL_REASON || slot.terminal.body.owner_alert !== true)) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `v3 slot ${number} terminal body mismatch`);
    const candidate = slot.prepared?.body.candidate;
    if (slot.prepared) {
      const decoded = decodePreparedRecoveryEvent(slot.prepared, "__shape_only__", slot.prepared.operation.symbolic_ref, LOCAL_DRAIN_PROTOCOL_V3);
      if (decoded.prepared.frozenCommit !== slot.prepared.operation.base_commit || decoded.prepared.cohortManifestRoot !== slot.prepared.operation.cohort_semantic_root || frozenIndexSnapshotRootV3(decoded.prepared.entries, decoded.snapshot) !== slot.prepared.operation.frozen_index_snapshot_root) {
        throw new ConvergenceRecoveryError("RECOVERY_OPERATION_INVARIANT", `v3 slot ${number} prepared body does not bind exact operation`, { episodeId: slot.prepared.episode_id, slot: number });
      }
      // A process may append prepared after another process made an abort
      // decision from a stale fold. The unique shape-valid prepared object is
      // positive evidence; that stale abort and its slot-5 terminal do not
      // negate it. Conflicting prepared objects already fail in uniqueV3.
      if (slot.aborted) {
        slot.staleAbort = slot.aborted;
        slot.aborted = undefined;
        if (slot.terminal) {
          slot.staleTerminal = slot.terminal;
          slot.terminal = undefined;
        }
      } else if (slot.terminal) {
        throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `v3 slot ${number} prepared contradicts an unpaired terminal`, { episodeId: slot.prepared.episode_id, slot: number });
      }
    }
    if (slot.published && slot.published.body.candidate !== candidate) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `v3 slot ${number} publication candidate mismatch`);
    if (slot.converged && slot.converged.body.candidate !== candidate) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", `v3 slot ${number} convergence candidate mismatch`);
  }
  const completeSlots = slots.filter((slot) => folded.get(slot)!.converged);
  const terminalSlots = slots.filter((slot) => folded.get(slot)!.terminal);
  if (completeSlots.length > 1 || terminalSlots.length > 1 || (completeSlots.length && terminalSlots.length)) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", "v3 episode has contradictory complete/terminal closures");
  const absorbingSlot = completeSlots[0] ?? terminalSlots[0];
  if (absorbingSlot !== undefined && slots.some((slot) => slot > absorbingSlot)) throw new ConvergenceRecoveryError("RECOVERY_STATE_INVARIANT", "v3 episode has events after an absorbing closure");
  const claimed = slots.filter((slot) => folded.get(slot)!.claimed);
  for (let index = 0; index < claimed.length; index += 1) if (claimed[index] !== index + 1) throw new ConvergenceRecoveryError("RECOVERY_SLOT_GAP", "v3 claimed slots must be contiguous", { claimed });
  return folded;
}

export interface RecoveryEpisodeCursorV3 {
  episodeId: string;
  operation: RecoveryOperationV3;
  nextSlot: number | null;
  lastClaimedSlot: number | null;
  complete: boolean;
  terminal: boolean;
  pendingSlot: number | null;
  folded: ReadonlyMap<number, Readonly<FoldedRecoverySlotV3>>;
}

export function recoveryEpisodeCursorV3(episodeId: string, operation: RecoveryOperationV3, events: readonly RecoveryEventV3[]): RecoveryEpisodeCursorV3 {
  if (episodeId !== recoveryEpisodeIdentityV3(operation)) throw new ConvergenceRecoveryError("RECOVERY_EPISODE_INVARIANT", "v3 cursor episode does not bind operation");
  const folded = foldRecoveryEventsV3(events);
  const slots = [...folded.keys()].sort((a, b) => a - b);
  const claimed = slots.filter((slot) => folded.get(slot)!.claimed);
  const lastClaimedSlot = claimed.at(-1) ?? null;
  const complete = slots.some((slot) => Boolean(folded.get(slot)!.converged));
  const terminal = slots.some((slot) => Boolean(folded.get(slot)!.terminal));
  const pendingSlot = lastClaimedSlot !== null && !folded.get(lastClaimedSlot)!.aborted && !folded.get(lastClaimedSlot)!.converged && !terminal ? lastClaimedSlot : null;
  const candidate = (lastClaimedSlot ?? 0) + 1;
  return { episodeId, operation, nextSlot: complete || terminal || candidate > 5 ? null : candidate, lastClaimedSlot, complete, terminal, pendingSlot, folded };
}

export interface OpenRecoveryEpisodesV3Result {
  open: readonly RecoveryEpisodeCursorV3[];
  complete: readonly RecoveryEpisodeCursorV3[];
  terminal: readonly RecoveryEpisodeCursorV3[];
  quarantined: readonly RecoveryQuarantineDiagnostic[];
}

export function recoverOpenRecoveryEpisodesV3FromScan(scan: Awaited<ReturnType<typeof scanWholeL1Validated>>): OpenRecoveryEpisodesV3Result {
  const groups = new Map<string, RecoveryEventV3[]>();
  for (const event of recoveryRecordsV3(scan)) groups.set(event.episode_id, [...(groups.get(event.episode_id) ?? []), event]);
  const open: RecoveryEpisodeCursorV3[] = [];
  const complete: RecoveryEpisodeCursorV3[] = [];
  const terminal: RecoveryEpisodeCursorV3[] = [];
  const quarantined: OpenRecoveryEpisodesV3Result["quarantined"][number][] = [];
  for (const [episodeId, events] of groups) {
    try {
      const operation = events[0]?.operation;
      if (!operation) throw new ConvergenceRecoveryError("RECOVERY_OPERATION_MISSING", "v3 episode has no exact operation");
      const cursor = recoveryEpisodeCursorV3(episodeId, operation, events);
      if (cursor.terminal) terminal.push(cursor);
      else if (cursor.complete) complete.push(cursor);
      else open.push(cursor);
    } catch (error) {
      quarantined.push(recoveryQuarantineDiagnostic(episodeId, error));
    }
  }
  const byEpisode = (a: { episodeId: string }, b: { episodeId: string }) => compareCodeUnits(a.episodeId, b.episodeId);
  return { open: Object.freeze(open.sort(byEpisode)), complete: Object.freeze(complete.sort(byEpisode)), terminal: Object.freeze(terminal.sort(byEpisode)), quarantined: Object.freeze(quarantined.sort(byEpisode)) };
}

export async function recoverOpenRecoveryEpisodesV3(abrainHome: string): Promise<OpenRecoveryEpisodesV3Result> {
  return recoverOpenRecoveryEpisodesV3FromScan(await scanWholeL1Validated({ abrainHome }));
}

export type NextSlotResultV3 =
  | { status: "acquired" | "consumed"; slot: number; shouldExecute: boolean; claimId: string; filePath: string; episodeId: string }
  | { status: "pending"; slot: number; shouldExecute: false; episodeId: string }
  | { status: "complete" | "terminal"; slot: null; shouldExecute: false; episodeId: string };

export async function claimNextRecoverySlotV3(options: { abrainHome: string; operation: RecoveryOperationV3 }): Promise<NextSlotResultV3> {
  const episodeId = recoveryEpisodeIdentityV3(options.operation);
  const cursor = recoveryEpisodeCursorV3(episodeId, options.operation, await readRecoveryEventsV3(options.abrainHome, episodeId));
  if (cursor.complete) return { status: "complete", slot: null, shouldExecute: false, episodeId };
  if (cursor.terminal) return { status: "terminal", slot: null, shouldExecute: false, episodeId };
  if (cursor.pendingSlot !== null) return { status: "pending", slot: cursor.pendingSlot, shouldExecute: false, episodeId };
  if (cursor.nextSlot === null) {
    await ensureTerminalV3(options.abrainHome, options.operation, cursor.lastClaimedSlot ?? RECOVERY_LANE_BUDGETS.drain);
    return { status: "terminal", slot: null, shouldExecute: false, episodeId };
  }
  const claimId = recoveryClaimIdV3(episodeId, cursor.nextSlot);
  const created = await appendRecoveryEventV3({ abrainHome: options.abrainHome, operation: options.operation, slot: cursor.nextSlot, eventType: "recovery_slot_claimed", body: { claim_id: claimId } });
  return { status: created.status === "created" ? "acquired" : "consumed", slot: cursor.nextSlot, shouldExecute: created.status === "created", claimId, filePath: created.filePath, episodeId };
}

export async function recordDrainPreparedV3(options: { abrainHome: string; operation: RecoveryOperationV3; slot: number; prepared: PreparedExactCohortCommit; frozenIndexSnapshot: ReadonlyMap<string, string> }): Promise<void> {
  if (options.prepared.frozenCommit !== options.operation.base_commit || options.prepared.cohortManifestRoot !== options.operation.cohort_semantic_root || frozenIndexSnapshotRootV3(options.prepared.entries, options.frozenIndexSnapshot) !== options.operation.frozen_index_snapshot_root) {
    throw new ConvergenceRecoveryError("RECOVERY_OPERATION_INVARIANT", "prepared commit does not match v3 exact operation");
  }
  await appendRecoveryEventV3({ abrainHome: options.abrainHome, operation: options.operation, slot: options.slot, eventType: "commit_prepared", body: preparedBody(options.prepared, options.frozenIndexSnapshot) });
}

async function ensureTerminalV3(abrainHome: string, operation: RecoveryOperationV3, slot: number): Promise<void> {
  await appendRecoveryEventV3({ abrainHome, operation, slot, eventType: "recovery_episode_terminal", body: { reason: TERMINAL_REASON, owner_alert: true } });
}

type AbortAfterRefoldV3 = "aborted" | "prepared" | "already_complete" | "terminal";

async function abortRecoverySlotV3AfterRefold(options: { abrainHome: string; operation: RecoveryOperationV3; slot: number }): Promise<AbortAfterRefoldV3> {
  const episodeId = recoveryEpisodeIdentityV3(options.operation);
  const state = foldRecoveryEventsV3(await readRecoveryEventsV3(options.abrainHome, episodeId)).get(options.slot);
  if (!state?.claimed) throw new ConvergenceRecoveryError("RECOVERY_SLOT_UNCLAIMED", "v3 abort requires a durable claim");
  if (state.converged) return "already_complete";
  if (state.terminal) return "terminal";
  if (state.prepared) return "prepared";
  if (!state.aborted) {
    await appendRecoveryEventV3({ abrainHome: options.abrainHome, operation: options.operation, slot: options.slot, eventType: "recovery_slot_aborted", body: { reason: ABORT_REASON, error_code: ABORT_ERROR_CODE } });
  }
  if (options.slot === RECOVERY_LANE_BUDGETS.drain) await ensureTerminalV3(options.abrainHome, options.operation, options.slot);
  return "aborted";
}

export async function recoverDrainSlotV3(options: {
  abrainHome: string;
  repo: string;
  operation: RecoveryOperationV3;
  slot: number;
  prePublishCheck?: () => Promise<void>;
  preConvergeCheck?: () => Promise<void>;
}): Promise<DrainRecoveryAction> {
  assertSlot(options.slot);
  const episodeId = recoveryEpisodeIdentityV3(options.operation);
  const state = foldRecoveryEventsV3(await readRecoveryEventsV3(options.abrainHome, episodeId)).get(options.slot);
  if (!state?.claimed) throw new ConvergenceRecoveryError("RECOVERY_SLOT_UNCLAIMED", "v3 restart recovery requires a durable claim");
  if (state.terminal) return "terminal";
  if (state.converged) return "already_complete";
  if (state.aborted) {
    if (options.slot === RECOVERY_LANE_BUDGETS.drain) await ensureTerminalV3(options.abrainHome, options.operation, options.slot);
    return options.slot === RECOVERY_LANE_BUDGETS.drain ? "terminal" : "burned";
  }
  if (!state.prepared) {
    const aborted = await abortRecoverySlotV3AfterRefold({ abrainHome: options.abrainHome, operation: options.operation, slot: options.slot });
    if (aborted === "prepared") return recoverDrainSlotV3(options);
    if (aborted === "already_complete") return "already_complete";
    if (aborted === "terminal" || options.slot === RECOVERY_LANE_BUDGETS.drain) return "terminal";
    return "burned";
  }
  const { prepared, snapshot } = decodePreparedRecoveryEvent(state.prepared, path.resolve(options.repo), options.operation.symbolic_ref, LOCAL_DRAIN_PROTOCOL_V3);
  if (!await verifyCandidateShape(prepared.repo, prepared.candidate, prepared)) throw new ConvergenceRecoveryError("RECOVERY_CANDIDATE_INVALID", "v3 prepared candidate shape is invalid", { candidate: prepared.candidate });
  if (!state.published) {
    const current = await resolveRef(prepared.repo, prepared.refName);
    if (current === options.operation.base_commit) {
      await options.prePublishCheck?.();
      const result = await publishExactCohortCommit({ repo: prepared.repo, refName: prepared.refName, candidate: prepared.candidate, frozenCommit: options.operation.base_commit });
      if (result.status === "cas_conflict" && !await isAncestor(prepared.repo, prepared.candidate, result.currentRef)) {
        throw new ConvergenceRecoveryError("RECOVERY_V3_STALE_BASE", "concurrent canonical path publication has no certified semantic join", { episodeId, baseCommit: options.operation.base_commit, current: result.currentRef });
      }
    } else if (!await isAncestor(prepared.repo, prepared.candidate, current)) {
      throw new ConvergenceRecoveryError("RECOVERY_V3_STALE_BASE", "v3 base is stale and candidate is not in current ancestry", { episodeId, baseCommit: options.operation.base_commit, current });
    }
    await appendRecoveryEventV3({ abrainHome: options.abrainHome, operation: options.operation, slot: options.slot, eventType: "commit_published", body: { candidate: prepared.candidate, publication_confirmed: true } });
  } else {
    const current = await resolveRef(prepared.repo, prepared.refName);
    if (!await isAncestor(prepared.repo, prepared.candidate, current)) throw new ConvergenceRecoveryError("RECOVERY_PUBLISHED_REF_DIVERGED", "v3 published candidate is not contained by current ref", { episodeId, slot: options.slot });
  }
  await options.preConvergeCheck?.();
  await convergeExactCohortIndex({ repo: prepared.repo, refName: prepared.refName, cohortPaths: prepared.entries.map((entry) => entry.path), frozenIndexSnapshot: snapshot });
  await appendRecoveryEventV3({ abrainHome: options.abrainHome, operation: options.operation, slot: options.slot, eventType: "index_converged", body: { candidate: prepared.candidate } });
  return "index_converged";
}
