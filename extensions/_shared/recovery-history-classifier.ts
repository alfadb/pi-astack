import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  CONSTRAINT_L2_V1,
  KNOWLEDGE_L2_V1,
  canonicalKnowledgeManifestRelativePathV1,
} from "./canonical-l2-contract";
import {
  assertCanonicalL2ReconcilerCoverage,
  buildCanonicalL2V1,
  selectCanonicalL2ReconcilerVersions,
} from "./canonical-l2-reconciler";
import {
  scanWholeL1Validated,
  type ValidatedL1ScanRecord,
  type WholeL1ScanResult,
} from "./l1-schema-registry";
import {
  cohortManifestRoot,
  deterministicDrainCommitMessage,
  isAncestor,
  LOCAL_DRAIN_PROTOCOL_V3,
  type PreparedCohortEntry,
} from "./git-exact-cohort";
import {
  decodePreparedRecoveryEvent,
  deriveNextEpisodeIdentity,
  drainEpisodeIdentity,
  frozenIndexSnapshotRootV3,
  recoveryClaimId,
  recoveryQuarantineDiagnostic,
  recoverOpenRecoveryEpisodesV3FromScan,
  type RecoveryEvent,
  type RecoveryEventV3,
} from "./convergence-recovery";
import { sha256Hex } from "./jcs";

const execFileAsync = promisify(execFile);
const V2_ENVELOPE = "local-drain-recovery-envelope/v2";
const SYMBOLIC_REF = "refs/heads/main";
const L1_PREFIX = "l1/events/sha256/";
const AUTHOR = "pi-astack-local-drain <local-drain@pi-astack.invalid>";
const V2_ACCEPTED_BRAND = Symbol("pi-astack/recovery-history/v2-accepted");

export class RecoveryHistoryClassificationError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "RecoveryHistoryClassificationError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface AcceptedV2Closure {
  readonly episodeId: string;
  readonly slot: number;
  readonly candidate: string;
  readonly frozenCommit: string;
  readonly preparedEventId: string;
  readonly publishedEventId: string;
  readonly convergedEventId: string;
  readonly branchLabel: string;
  readonly childEpisodeId: string;
}

export interface AcceptedV2Episode {
  readonly episodeId: string;
  readonly status: "complete" | "terminal";
  readonly closures: readonly AcceptedV2Closure[];
  readonly consumedEventIds: readonly string[];
  readonly childEpisodeIds: readonly string[];
}

export interface CertifiedSemanticJoin {
  readonly episodeId: string;
  readonly slot: number;
  readonly branchLabels: readonly string[];
  readonly mergeCommit: string;
  readonly parents: readonly string[];
  readonly l1ObjectCount: number;
  readonly l2ObjectCount: number;
}

export interface RecoveryHistoryQuarantine {
  readonly status: "quarantined";
  readonly episodeId: string;
  readonly lane: "drain";
  readonly ownerAlert: true;
  readonly errorCode: string;
  readonly message: string;
  readonly detail?: string;
}

export interface V2RecoveryHistoryResult {
  readonly status: "accepted" | "quarantined";
  readonly head: string;
  readonly episodes: readonly AcceptedV2Episode[];
  readonly joins: readonly CertifiedSemanticJoin[];
  readonly consumedEventIds: readonly string[];
  readonly writableFrontierCount: 0;
  readonly quarantined: readonly RecoveryHistoryQuarantine[];
}

export interface AcceptedV3Candidate {
  readonly episodeId: string;
  readonly slot: number;
  readonly candidate: string;
  readonly baseCommit: string;
}

export interface V3RecoveryHistoryResult {
  readonly status: "accepted" | "quarantined";
  readonly head: string;
  readonly candidates: readonly AcceptedV3Candidate[];
  readonly joins: readonly CertifiedSemanticJoin[];
  readonly openEpisodeIds: readonly string[];
  readonly terminalEpisodeIds: readonly string[];
  readonly quarantined: readonly RecoveryHistoryQuarantine[];
}

export interface CombinedRecoveryHistoryResult {
  readonly status: "accepted" | "quarantined";
  readonly head: string;
  readonly v2: V2RecoveryHistoryResult;
  readonly v3: V3RecoveryHistoryResult | null;
  readonly quarantined: readonly (RecoveryHistoryQuarantine & { readonly protocol: "v2" | "v3" })[];
}

type TreeEntry = Readonly<{ mode: string; type: string; oid: string; path: string }>;
type V2Record = Readonly<{ record: ValidatedL1ScanRecord; event: RecoveryEvent }>;
type CandidateRows = Readonly<{ prepared: V2Record; published: V2Record; converged: V2Record }>;

type ParsedEpisode = {
  episodeId: string;
  status: "complete" | "terminal";
  rows: V2Record[];
  candidates: Array<{ slot: number; candidate: string; rows: CandidateRows }>;
  consumed: Set<string>;
  closures: AcceptedV2Closure[];
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new RecoveryHistoryClassificationError(code, message, detail);
}

function eventId(row: V2Record): string {
  return row.record.eventId;
}

function payload(row: V2Record): Record<string, unknown> {
  return row.event.body as Record<string, unknown>;
}

function candidateOf(row: V2Record): string {
  const candidate = payload(row).candidate;
  return typeof candidate === "string" ? candidate : "";
}

function v2Records(scan: WholeL1ScanResult): V2Record[] {
  return scan.all
    .filter((record) => record.registration.envelope_schema === V2_ENVELOPE)
    .map((record) => ({ record, event: record.body as unknown as RecoveryEvent }))
    .sort((left, right) => compareCodeUnits(eventId(left), eventId(right)));
}

function exactlyOne(rows: readonly V2Record[], code: string, message: string, detail: Record<string, unknown>): V2Record {
  if (rows.length !== 1) fail(code, message, { ...detail, count: rows.length, eventIds: rows.map(eventId) });
  return rows[0]!;
}

function parseEpisode(episodeId: string, rows: V2Record[]): ParsedEpisode {
  const consumed = new Set<string>();
  const candidates: ParsedEpisode["candidates"] = [];
  const bySlot = new Map<number, V2Record[]>();
  for (const row of rows) bySlot.set(row.event.slot, [...(bySlot.get(row.event.slot) ?? []), row]);
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  if (!slots.length) fail("RECOVERY_EPISODE_EMPTY", "v2 episode has no events", { episodeId });
  for (let index = 0; index < slots.length; index += 1) {
    if (slots[index] !== index + 1) fail("RECOVERY_SLOT_GAP", "v2 episode slots are not contiguous", { episodeId, slots });
  }

  let completeSlot: number | null = null;
  let terminalSeen = false;
  for (const slot of slots) {
    const slotRows = bySlot.get(slot)!;
    const claims = slotRows.filter((row) => row.event.event_type === "recovery_slot_claimed");
    const claim = exactlyOne(claims, "RECOVERY_CLAIM_CARDINALITY", "v2 slot must have exactly one shared deterministic claim", { episodeId, slot });
    if (payload(claim).claim_id !== recoveryClaimId(episodeId, "drain", slot)) fail("RECOVERY_CLAIM_INVARIANT", "v2 claim does not derive from episode/slot", { episodeId, slot });
    consumed.add(eventId(claim));

    const aborts = slotRows.filter((row) => row.event.event_type === "recovery_slot_aborted");
    const terminals = slotRows.filter((row) => row.event.event_type === "recovery_episode_terminal");
    if (aborts.length > 1 || terminals.length > 1) fail("RECOVERY_TERMINAL_CARDINALITY", "v2 slot has duplicate abort/terminal objects", { episodeId, slot });
    const prepared = slotRows.filter((row) => row.event.event_type === "commit_prepared");
    const published = slotRows.filter((row) => row.event.event_type === "commit_published");
    const converged = slotRows.filter((row) => row.event.event_type === "index_converged");
    const candidateNames = [...new Set(prepared.map(candidateOf))].sort(compareCodeUnits);
    const resultCandidates = [...new Set([...published, ...converged].map(candidateOf))].sort(compareCodeUnits);
    if (resultCandidates.some((candidate) => !candidateNames.includes(candidate))) fail("RECOVERY_ORPHAN_RESULT", "v2 publication/convergence has no candidate-specific prepared object", { episodeId, slot, resultCandidates, candidateNames });

    if (candidateNames.length > 0) {
      if (aborts.length || terminals.length) fail("RECOVERY_ABORT_CONTRADICTION", "v2 complete closure contradicts abort/terminal state", { episodeId, slot });
      if (completeSlot !== null) fail("RECOVERY_POST_COMPLETE_EVENT", "v2 episode has another closure after convergence", { episodeId, slot, completeSlot });
      completeSlot = slot;
      for (const candidate of candidateNames) {
        const preparedRow = exactlyOne(prepared.filter((row) => candidateOf(row) === candidate), "RECOVERY_PREPARED_CONFLICT", "candidate has conflicting prepared bytes", { episodeId, slot, candidate });
        const publishedRow = exactlyOne(published.filter((row) => candidateOf(row) === candidate), "RECOVERY_CLOSURE_INCOMPLETE", "candidate does not have exactly one publication confirmation", { episodeId, slot, candidate });
        const convergedRow = exactlyOne(converged.filter((row) => candidateOf(row) === candidate), "RECOVERY_CLOSURE_INCOMPLETE", "candidate does not have exactly one convergence object", { episodeId, slot, candidate });
        candidates.push({ slot, candidate, rows: { prepared: preparedRow, published: publishedRow, converged: convergedRow } });
        for (const row of [preparedRow, publishedRow, convergedRow]) consumed.add(eventId(row));
      }
    } else if (aborts.length) {
      consumed.add(eventId(aborts[0]!));
      if (terminals.length) {
        consumed.add(eventId(terminals[0]!));
        terminalSeen = true;
      }
    } else if (terminals.length) {
      consumed.add(eventId(terminals[0]!));
      terminalSeen = true;
    } else {
      fail("RECOVERY_OPEN_NONTERMINAL", "v2 open non-terminal attempt has a writable frontier and is quarantined", { episodeId, slot });
    }
    if (terminalSeen && slot !== slots.at(-1)) fail("RECOVERY_POST_TERMINAL_EVENT", "v2 episode has events after an absorbing terminal", { episodeId, slot });
  }

  if (completeSlot === null && !terminalSeen) fail("RECOVERY_OPEN_NONTERMINAL", "v2 episode is neither complete nor explicitly terminal", { episodeId });
  if (consumed.size !== rows.length) {
    const unconsumed = rows.map(eventId).filter((id) => !consumed.has(id));
    fail("RECOVERY_OBJECT_CONSUMPTION", "not every v2 object was consumed exactly once", { episodeId, consumed: consumed.size, total: rows.length, unconsumed });
  }
  return { episodeId, status: completeSlot === null ? "terminal" : "complete", rows, candidates, consumed, closures: [] };
}

async function gitText(repo: string, args: readonly string[], timeout = 60_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: gitEnvironment(),
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
    timeout,
  });
  return stdout;
}

async function gitBuffer(repo: string, args: readonly string[], timeout = 60_000): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: gitEnvironment(),
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    timeout,
  });
  return stdout as Buffer;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  return { ...env, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

async function resolveCommit(repo: string, revision: string): Promise<string> {
  return (await gitText(repo, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
}

async function commitParents(repo: string, commit: string): Promise<string[]> {
  const line = (await gitText(repo, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/);
  if (line[0] !== commit) fail("RECOVERY_GIT_GRAPH_INVALID", "git returned the wrong commit while reading parents", { commit, line });
  return line.slice(1);
}

async function treeEntries(repo: string, commit: string, prefix: string): Promise<Map<string, TreeEntry>> {
  const raw = await gitBuffer(repo, ["ls-tree", "-r", "-z", commit, "--", prefix]);
  const result = new Map<string, TreeEntry>();
  for (const record of raw.toString("utf-8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const meta = tab >= 0 ? record.slice(0, tab).split(/\s+/) : [];
    const relative = tab >= 0 ? record.slice(tab + 1) : "";
    if (meta.length !== 3 || !relative || result.has(relative)) fail("RECOVERY_GIT_TREE_INVALID", "git tree record is malformed or duplicated", { commit, record });
    result.set(relative, Object.freeze({ mode: meta[0]!, type: meta[1]!, oid: meta[2]!, path: relative }));
  }
  return result;
}

function sameTreeEntry(left: TreeEntry, right: TreeEntry): boolean {
  return left.mode === right.mode && left.type === right.type && left.oid === right.oid && left.path === right.path;
}

function exactTreeMap(left: ReadonlyMap<string, TreeEntry>, right: ReadonlyMap<string, TreeEntry>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => {
    const other = right.get(key);
    return !!other && sameTreeEntry(value, other);
  });
}

async function truePathIntroductionCommits(repo: string, commits: readonly string[], relativePath: string): Promise<string[]> {
  const introduced: string[] = [];
  for (const commit of commits) {
    const parents = await commitParents(repo, commit);
    const inherited = (await Promise.all(parents.map(async (parent) => (await treeEntries(repo, parent, relativePath)).has(relativePath)))).some(Boolean);
    if (!inherited) introduced.push(commit);
  }
  return introduced;
}

async function eventIntroductionCommits(repo: string, head: string, row: V2Record): Promise<string[]> {
  const relativePath = row.record.relativePath;
  if (!relativePath) fail("RECOVERY_EVENT_PATH_MISSING", "validated v2 event has no relative path", { eventId: eventId(row) });
  // -m is required for merge commits: without it Git emits no path diff for a
  // path created by the merge result itself. It can emit the same merge once
  // per parent, so classification de-duplicates commit labels.
  const mutated = [...new Set((await gitText(repo, ["log", "-m", "--format=%H", "--full-history", "--diff-filter=MD", head, "--", relativePath])).trim().split("\n").filter(Boolean))];
  if (mutated.length) fail("RECOVERY_L1_HISTORY_MUTATED", "content-addressed v2 object was modified or deleted in reachable history", { eventId: eventId(row), relativePath, commits: mutated });
  const addDiffCommits = [...new Set((await gitText(repo, ["log", "-m", "--format=%H", "--full-history", "--diff-filter=A", head, "--", relativePath])).trim().split("\n").filter(Boolean))];
  const introduced = await truePathIntroductionCommits(repo, addDiffCommits, relativePath);
  if (!introduced.length) fail("RECOVERY_EVENT_UNCOMMITTED", "v2 history object is not introduced by any HEAD ancestor", { eventId: eventId(row), relativePath });
  return introduced;
}

async function branchLabelForCandidate(repo: string, head: string, rows: CandidateRows): Promise<string> {
  const introductions = new Set<string>();
  for (const row of [rows.prepared, rows.published, rows.converged]) {
    for (const commit of await eventIntroductionCommits(repo, head, row)) introductions.add(commit);
  }
  const commits = [...introductions];
  const maximal = [];
  for (const candidate of commits) {
    let descendantOfAll = true;
    for (const other of commits) if (!await isAncestor(repo, other, candidate)) descendantOfAll = false;
    if (descendantOfAll) maximal.push(candidate);
  }
  if (maximal.length !== 1) fail("RECOVERY_BRANCH_PROVENANCE_AMBIGUOUS", "candidate-specific closure bytes do not have one deterministic branch-introducing label", { eventIds: [eventId(rows.prepared), eventId(rows.published), eventId(rows.converged)], introductions: commits, maximal });
  return maximal[0]!;
}

function parseRawDiff(raw: Buffer): Map<string, { oldMode: string; newMode: string; oldOid: string; newOid: string; status: string }> {
  const tokens = raw.toString("utf-8").split("\0").filter(Boolean);
  const result = new Map<string, { oldMode: string; newMode: string; oldOid: string; newOid: string; status: string }>();
  for (let index = 0; index < tokens.length; index += 2) {
    const meta = tokens[index]!;
    const relative = tokens[index + 1];
    const parts = meta.replace(/^:/, "").split(/\s+/);
    if (!relative || parts.length !== 5 || result.has(relative)) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "candidate diff-tree is malformed", { meta, relative });
    result.set(relative, { oldMode: parts[0]!, newMode: parts[1]!, oldOid: parts[2]!, newOid: parts[3]!, status: parts[4]! });
  }
  return result;
}

async function validateCandidate(repo: string, head: string, episodeId: string, slot: number, row: V2Record): Promise<{ candidate: string; frozenCommit: string }> {
  const decoded = decodePreparedRecoveryEvent(row.event, repo, SYMBOLIC_REF);
  const prepared = decoded.prepared;
  if (cohortManifestRoot(prepared.entries) !== prepared.cohortManifestRoot) fail("RECOVERY_COHORT_ROOT_INVALID", "prepared cohort semantic root does not match entries", { episodeId, slot, candidate: prepared.candidate });
  if (!await isAncestor(repo, prepared.candidate, head)) fail("RECOVERY_CANDIDATE_NOT_ANCESTOR", "closure candidate is not a current HEAD ancestor", { episodeId, slot, candidate: prepared.candidate, head });
  const [candidateTree, parents, parentEpoch, commitBytes] = await Promise.all([
    gitText(repo, ["rev-parse", "--verify", `${prepared.candidate}^{tree}`]).then((value) => value.trim()),
    commitParents(repo, prepared.candidate),
    gitText(repo, ["show", "-s", "--format=%ct", prepared.frozenCommit]).then((value) => value.trim()),
    gitBuffer(repo, ["cat-file", "commit", prepared.candidate]),
  ]);
  if (candidateTree !== prepared.newTree || parents.length !== 1 || parents[0] !== prepared.frozenCommit) fail("RECOVERY_CANDIDATE_SHAPE_INVALID", "candidate parent/tree does not match prepared object", { episodeId, slot, candidate: prepared.candidate, candidateTree, expectedTree: prepared.newTree, parents, frozenCommit: prepared.frozenCommit });
  const commit = commitBytes.toString("utf-8");
  const expectedHeader = `tree ${prepared.newTree}\nparent ${prepared.frozenCommit}\nauthor ${AUTHOR} ${parentEpoch} +0000\ncommitter ${AUTHOR} ${parentEpoch} +0000\n\n`;
  const expectedCommit = `${expectedHeader}${deterministicDrainCommitMessage(prepared.cohortManifestRoot)}\n`;
  if (commit !== expectedCommit) fail("RECOVERY_CANDIDATE_METADATA_INVALID", "candidate commit bytes are not deterministic local-drain bytes", { episodeId, slot, candidate: prepared.candidate, actualSha256: sha256Hex(commitBytes), expectedSha256: sha256Hex(Buffer.from(expectedCommit)) });

  const diff = parseRawDiff(await gitBuffer(repo, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", prepared.frozenCommit, prepared.candidate]));
  if (diff.size !== prepared.entries.length) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "candidate exact diff size does not match prepared entries", { episodeId, slot, candidate: prepared.candidate, expected: prepared.entries.length, actual: diff.size });
  for (const entry of prepared.entries) await validatePreparedEntry(repo, episodeId, slot, prepared.candidate, entry, diff.get(entry.path));
  return { candidate: prepared.candidate, frozenCommit: prepared.frozenCommit };
}

async function validateCandidateV3(repo: string, head: string, episodeId: string, slot: number, event: RecoveryEventV3): Promise<{ candidate: string; baseCommit: string }> {
  const decoded = decodePreparedRecoveryEvent(event, repo, event.operation.symbolic_ref, LOCAL_DRAIN_PROTOCOL_V3);
  const prepared = decoded.prepared;
  const semanticRoot = cohortManifestRoot(prepared.entries, LOCAL_DRAIN_PROTOCOL_V3);
  const snapshotRoot = frozenIndexSnapshotRootV3(prepared.entries, decoded.snapshot);
  if (semanticRoot !== prepared.cohortManifestRoot) fail("RECOVERY_COHORT_ROOT_INVALID", "v3 prepared cohort semantic root does not match entries", { episodeId, slot, candidate: prepared.candidate });
  if (
    prepared.frozenCommit !== event.operation.base_commit
    || prepared.cohortManifestRoot !== event.operation.cohort_semantic_root
    || semanticRoot !== event.operation.cohort_semantic_root
    || snapshotRoot !== event.operation.frozen_index_snapshot_root
  ) {
    fail("RECOVERY_OPERATION_INVARIANT", "v3 candidate validation independently rejected prepared/operation binding", { episodeId, slot, candidate: prepared.candidate, snapshotRoot, operationSnapshotRoot: event.operation.frozen_index_snapshot_root });
  }
  if (!await isAncestor(repo, prepared.candidate, head)) fail("RECOVERY_CANDIDATE_NOT_ANCESTOR", "v3 closure candidate is not a current HEAD ancestor", { episodeId, slot, candidate: prepared.candidate, head });
  const [candidateTree, parents, parentEpoch, commitBytes] = await Promise.all([
    gitText(repo, ["rev-parse", "--verify", `${prepared.candidate}^{tree}`]).then((value) => value.trim()),
    commitParents(repo, prepared.candidate),
    gitText(repo, ["show", "-s", "--format=%ct", prepared.frozenCommit]).then((value) => value.trim()),
    gitBuffer(repo, ["cat-file", "commit", prepared.candidate]),
  ]);
  if (candidateTree !== prepared.newTree || parents.length !== 1 || parents[0] !== prepared.frozenCommit || prepared.frozenCommit !== event.operation.base_commit) fail("RECOVERY_CANDIDATE_SHAPE_INVALID", "v3 candidate parent/tree/base does not match exact operation", { episodeId, slot, candidate: prepared.candidate, parents, candidateTree });
  const expectedHeader = `tree ${prepared.newTree}\nparent ${prepared.frozenCommit}\nauthor ${AUTHOR} ${parentEpoch} +0000\ncommitter ${AUTHOR} ${parentEpoch} +0000\n\n`;
  const expectedCommit = `${expectedHeader}${deterministicDrainCommitMessage(prepared.cohortManifestRoot, LOCAL_DRAIN_PROTOCOL_V3)}\n`;
  if (commitBytes.toString("utf-8") !== expectedCommit) fail("RECOVERY_CANDIDATE_METADATA_INVALID", "v3 candidate commit bytes are not deterministic", { episodeId, slot, candidate: prepared.candidate });
  const diff = parseRawDiff(await gitBuffer(repo, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", prepared.frozenCommit, prepared.candidate]));
  if (diff.size !== prepared.entries.length) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "v3 candidate exact diff size does not match prepared entries", { episodeId, slot, candidate: prepared.candidate, expected: prepared.entries.length, actual: diff.size });
  for (const entry of prepared.entries) await validatePreparedEntry(repo, episodeId, slot, prepared.candidate, entry, diff.get(entry.path));
  return { candidate: prepared.candidate, baseCommit: prepared.frozenCommit };
}

async function validatePreparedEntry(repo: string, episodeId: string, slot: number, candidate: string, entry: PreparedCohortEntry, diff: { oldMode: string; newMode: string; oldOid: string; newOid: string; status: string } | undefined): Promise<void> {
  if (!diff) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "prepared path is absent from candidate diff", { episodeId, slot, candidate, path: entry.path });
  if (entry.op === "delete") {
    if (diff.status !== "D" || diff.newMode !== "000000") fail("RECOVERY_CANDIDATE_DIFF_INVALID", "prepared delete does not match candidate diff", { episodeId, slot, candidate, path: entry.path, diff });
    return;
  }
  if ((diff.status !== "A" && diff.status !== "M") || diff.newMode !== entry.mode || diff.newOid !== entry.blobOid) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "prepared put does not match candidate diff", { episodeId, slot, candidate, path: entry.path, diff, entry });
  const bytes = await gitBuffer(repo, ["cat-file", "blob", entry.blobOid]);
  if (sha256Hex(bytes) !== entry.bytesSha256) fail("RECOVERY_CANDIDATE_BLOB_INVALID", "prepared byte hash does not match candidate blob", { episodeId, slot, candidate, path: entry.path, blobOid: entry.blobOid });
}

async function assertAntichain(repo: string, labels: readonly string[], episodeId: string, slot: number): Promise<void> {
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      if (await isAncestor(repo, labels[left]!, labels[right]!) || await isAncestor(repo, labels[right]!, labels[left]!)) fail("RECOVERY_SAME_BRANCH_CONFLICT", "conflicting closure bytes are comparable in branch ancestry", { episodeId, slot, left: labels[left], right: labels[right] });
    }
  }
}

async function findCertifiedJoin(repo: string, head: string, episodeId: string, slot: number, labels: readonly string[], snapshots: SnapshotCache): Promise<CertifiedSemanticJoin> {
  await assertAntichain(repo, labels, episodeId, slot);
  const merges = (await gitText(repo, ["rev-list", "--merges", "--reverse", head])).trim().split("\n").filter(Boolean);
  const validationErrors: Array<{ merge: string; error: string }> = [];
  for (const merge of merges) {
    if (!(await Promise.all(labels.map((label) => isAncestor(repo, label, merge)))).every(Boolean)) continue;
    const parents = await commitParents(repo, merge);
    if (parents.length < 2) continue;
    const coverage: boolean[][] = [];
    for (const parent of parents) coverage.push(await Promise.all(labels.map((label) => isAncestor(repo, label, parent))));
    if (labels.some((_, index) => !coverage.some((row) => row[index]))) continue;
    const relevantIndexes = coverage.map((row, index) => row.some(Boolean) ? index : -1).filter((index) => index >= 0);
    if (relevantIndexes.length < 2 || relevantIndexes.some((index) => coverage[index]!.every(Boolean))) continue;
    const relevantParents = relevantIndexes.map((index) => parents[index]!);
    const parentTrees = await Promise.all(relevantParents.map((parent) => treeEntries(repo, parent, L1_PREFIX)));
    const union = new Map<string, TreeEntry>();
    let conflict = false;
    for (const tree of parentTrees) {
      for (const [relative, entry] of tree) {
        const existing = union.get(relative);
        if (existing && !sameTreeEntry(existing, entry)) conflict = true;
        else union.set(relative, entry);
      }
    }
    if (conflict) continue;
    const joinedL1 = await treeEntries(repo, merge, L1_PREFIX);
    if (!exactTreeMap(union, joinedL1)) continue;
    try {
      const l2Count = await snapshots.validateWholeL1AndL2(merge);
      return Object.freeze({ episodeId, slot, branchLabels: Object.freeze([...labels]), mergeCommit: merge, parents: Object.freeze(relevantParents), l1ObjectCount: joinedL1.size, l2ObjectCount: l2Count });
    } catch (error) {
      validationErrors.push({ merge, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
  }
  const suffix = validationErrors.length ? `; snapshot validation: ${validationErrors[0]!.error}` : "";
  fail("RECOVERY_SEMANTIC_JOIN_MISSING", `branch divergence has no certified semantic join${suffix}`, { episodeId, slot, branchLabels: labels, head, validationErrors });
}

class SnapshotCache {
  readonly repo: string;
  readonly roots = new Map<string, string>();
  readonly scans = new Map<string, WholeL1ScanResult>();
  readonly objectFormat: Promise<string>;

  constructor(repo: string) {
    this.repo = repo;
    this.objectFormat = gitText(repo, ["rev-parse", "--show-object-format"]).then((value) => value.trim());
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.roots.values()].map((root) => fsp.rm(root, { recursive: true, force: true })));
  }

  async snapshot(commit: string): Promise<{ root: string; scan: WholeL1ScanResult }> {
    const existingRoot = this.roots.get(commit);
    const existingScan = this.scans.get(commit);
    if (existingRoot && existingScan) return { root: existingRoot, scan: existingScan };
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-astack-history-snapshot-"));
    const archivePath = path.join(root, "l1.tar");
    const archive = await gitBuffer(this.repo, ["archive", "--format=tar", commit, "l1"]);
    await fsp.writeFile(archivePath, archive);
    await execFileAsync("tar", ["-xf", archivePath, "-C", root], { env: gitEnvironment(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    await fsp.rm(archivePath, { force: true });
    const scan = await scanWholeL1Validated({ abrainHome: root });
    this.roots.set(commit, root);
    this.scans.set(commit, scan);
    return { root, scan };
  }

  async validateWholeL1AndL2(commit: string): Promise<number> {
    const { scan } = await this.snapshot(commit);
    const actual = await canonicalL2TreeEntries(this.repo, commit);
    const expected = await buildExpectedL2(this.repo, scan, actual);
    if (actual.size !== expected.size) fail("RECOVERY_L2_PROJECTION_DRIFT", "L2 tree path count is not the deterministic whole-L1 rebuild", { commit, expected: expected.size, actual: actual.size, missing: [...expected.keys()].filter((key) => !actual.has(key)).slice(0, 10), extra: [...actual.keys()].filter((key) => !expected.has(key)).slice(0, 10) });
    const format = await this.objectFormat;
    for (const [relative, bytes] of expected) {
      const entry = actual.get(relative);
      const expectedOid = gitBlobOid(bytes, format);
      if (!entry || entry.mode !== "100644" || entry.type !== "blob" || entry.oid !== expectedOid) fail("RECOVERY_L2_PROJECTION_DRIFT", `L2 object is not byte-exact deterministic whole-L1 output: ${relative}`, { commit, path: relative, expectedOid, actual: entry ?? null });
    }
    return actual.size;
  }
}

function gitBlobOid(bytes: Buffer, format: string): string {
  if (format !== "sha1" && format !== "sha256") fail("RECOVERY_GIT_OBJECT_FORMAT", "unsupported Git object format", { format });
  return createHash(format).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
}

async function canonicalL2TreeEntries(repo: string, commit: string): Promise<Map<string, TreeEntry>> {
  const knowledge = await treeEntries(repo, commit, `${KNOWLEDGE_L2_V1.canonicalRoot}/`);
  const constraint = await treeEntries(repo, commit, `${CONSTRAINT_L2_V1.canonicalRoot}/`);
  return new Map([...knowledge, ...constraint]);
}

async function buildExpectedL2(repo: string, scan: WholeL1ScanResult, actual: ReadonlyMap<string, TreeEntry>): Promise<Map<string, Buffer>> {
  assertCanonicalL2ReconcilerCoverage();
  const manifestPath = canonicalKnowledgeManifestRelativePathV1();
  const knowledgeMarkdownEntries = [...actual.values()]
    .filter((entry) => entry.path.startsWith(`${KNOWLEDGE_L2_V1.canonicalRoot}/`) && entry.path.endsWith(".md"))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const knowledgeMarkdown = await Promise.all(knowledgeMarkdownEntries.map((entry) => gitBuffer(repo, ["cat-file", "blob", entry.oid]).then((bytes) => bytes.toString("utf-8"))));
  const manifestEntry = actual.get(manifestPath);
  const constraintEntry = actual.get(CONSTRAINT_L2_V1.canonicalPath);
  const [knowledgeManifest, constraintMarkdown] = await Promise.all([
    manifestEntry ? gitBuffer(repo, ["cat-file", "blob", manifestEntry.oid]).then((bytes) => bytes.toString("utf-8")) : null,
    constraintEntry ? gitBuffer(repo, ["cat-file", "blob", constraintEntry.oid]).then((bytes) => bytes.toString("utf-8")) : null,
  ]);
  const constraintSourceTemplateVersions = scan.selected
    .filter((record) => record.registration.envelope_schema === "constraint-projection-envelope/v1")
    .map((record) => String(record.body.template_version ?? ""));
  selectCanonicalL2ReconcilerVersions({ knowledgeMarkdown, knowledgeManifest, constraintMarkdown, constraintSourceTemplateVersions });
  return new Map(buildCanonicalL2V1(scan));
}

async function assertReachableRecoveryRetention(repo: string, head: string): Promise<void> {
  const introduced = new Set((await gitText(repo, ["log", "-m", "--format=", "--name-only", "--full-history", "--diff-filter=A", head, "--", L1_PREFIX]))
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(L1_PREFIX)));
  const current = await treeEntries(repo, head, L1_PREFIX);
  const missing = [...introduced].filter((relative) => !current.has(relative)).sort(compareCodeUnits);
  const missingRecovery: string[] = [];
  for (const relative of missing) {
    const addDiffCommits = [...new Set((await gitText(repo, ["log", "-m", "--format=%H", "--full-history", "--diff-filter=A", head, "--", relative])).trim().split("\n").filter(Boolean))];
    const introducedAt = (await truePathIntroductionCommits(repo, addDiffCommits, relative)).at(-1);
    if (!introducedAt) continue;
    let parsed: unknown;
    try { parsed = JSON.parse((await gitBuffer(repo, ["show", `${introducedAt}:${relative}`])).toString("utf-8")); }
    catch { continue; }
    const schema = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).schema : null;
    if (schema === "drain-recovery-envelope/v1" || schema === "local-drain-recovery-envelope/v2" || schema === "local-drain-recovery-envelope/v3") missingRecovery.push(relative);
  }
  if (missingRecovery.length) fail("RECOVERY_REACHABLE_L1_DROPPED", "current HEAD dropped recovery objects introduced by its reachable branch history", { head, introduced: introduced.size, current: current.size, missingRecovery: missingRecovery.slice(0, 20) });
}

async function assertCurrentRetainsJoin(repo: string, head: string, join: CertifiedSemanticJoin): Promise<void> {
  const joined = await treeEntries(repo, join.mergeCommit, L1_PREFIX);
  const current = await treeEntries(repo, head, L1_PREFIX);
  for (const [relative, entry] of joined) {
    const retained = current.get(relative);
    if (!retained || !sameTreeEntry(entry, retained)) fail("RECOVERY_JOIN_NOT_RETAINED", "current HEAD dropped or mutated a certified join L1 object", { head, join: join.mergeCommit, path: relative, expected: entry, actual: retained ?? null });
  }
}

export function assertAcyclicDirectedGraph(edges: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) fail("RECOVERY_EPISODE_CHAIN_CYCLE", "recovery episode graph contains a cycle", { node });
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of edges.get(node) ?? []) visit(child);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) visit(node);
}

function quarantine(head: string, error: unknown): V2RecoveryHistoryResult {
  const externalCode = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "RECOVERY_HISTORY_FAILED";
  const externalDetail = error && typeof error === "object" && "detail" in error ? (error as { detail?: Record<string, unknown> }).detail : undefined;
  const typed = error instanceof RecoveryHistoryClassificationError ? error : new RecoveryHistoryClassificationError(externalCode, error instanceof Error ? error.message : String(error), externalDetail);
  const episodeId = typeof typed.detail?.episodeId === "string" ? typed.detail.episodeId : "history";
  const item: RecoveryHistoryQuarantine = recoveryQuarantineDiagnostic(episodeId, typed);
  return Object.freeze({ status: "quarantined", head, episodes: Object.freeze([]), joins: Object.freeze([]), consumedEventIds: Object.freeze([]), writableFrontierCount: 0, quarantined: Object.freeze([item]) });
}

export async function classifyV3RecoveryHistory(options: { repo: string; acceptedV2: V2RecoveryHistoryResult; scan?: WholeL1ScanResult; head?: string }): Promise<V3RecoveryHistoryResult> {
  const repo = path.resolve(options.repo);
  const head = await resolveCommit(repo, options.head ?? "HEAD");
  const snapshots = new SnapshotCache(repo);
  try {
    const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: repo });
    const scanV2EventIds = scan.all
      .filter((record) => record.registration.envelope_schema === V2_ENVELOPE)
      .map((record) => record.eventId)
      .sort(compareCodeUnits);
    const acceptedIds = options.acceptedV2?.consumedEventIds ?? [];
    if (
      !options.acceptedV2
      || options.acceptedV2.status !== "accepted"
      || options.acceptedV2.head !== head
      || (options.acceptedV2 as V2RecoveryHistoryResult & { [V2_ACCEPTED_BRAND]?: boolean })[V2_ACCEPTED_BRAND] !== true
      || scanV2EventIds.length !== acceptedIds.length
      || scanV2EventIds.some((eventId, index) => eventId !== acceptedIds[index])
    ) {
      fail("RECOVERY_V2_PREREQUISITE", "v3 classification requires this module's accepted v2 proof for the exact same HEAD and scan", {
        expectedHead: head,
        actualHead: options.acceptedV2?.head ?? null,
        actualStatus: options.acceptedV2?.status ?? "missing",
        scanV2Count: scanV2EventIds.length,
        acceptedV2Count: acceptedIds.length,
      });
    }
    const recovered = recoverOpenRecoveryEpisodesV3FromScan(scan);
    if (recovered.quarantined.length) {
      return Object.freeze({
        status: "quarantined",
        head,
        candidates: Object.freeze([]),
        joins: Object.freeze([]),
        openEpisodeIds: Object.freeze([]),
        terminalEpisodeIds: Object.freeze([]),
        quarantined: Object.freeze(recovered.quarantined),
      });
    }
    const candidates: AcceptedV3Candidate[] = [];
    for (const cursor of recovered.complete) {
      const convergedSlots = [...cursor.folded].filter(([, state]) => state.converged);
      if (convergedSlots.length !== 1) fail("RECOVERY_CLOSURE_INCOMPLETE", "complete v3 episode does not have exactly one closure", { episodeId: cursor.episodeId, convergedSlots: convergedSlots.map(([slot]) => slot) });
      const [slot, state] = convergedSlots[0]!;
      if (!state.prepared) fail("RECOVERY_CLOSURE_INCOMPLETE", "complete v3 episode has no prepared object", { episodeId: cursor.episodeId, slot });
      const validated = await validateCandidateV3(repo, head, cursor.episodeId, slot, state.prepared);
      candidates.push(Object.freeze({ episodeId: cursor.episodeId, slot, candidate: validated.candidate, baseCommit: validated.baseCommit }));
    }
    candidates.sort((left, right) => compareCodeUnits(left.candidate, right.candidate));

    const joins: CertifiedSemanticJoin[] = [];
    const seenJoins = new Set<string>();
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        const a = candidates[left]!; const b = candidates[right]!;
        if (await isAncestor(repo, a.candidate, b.candidate) || await isAncestor(repo, b.candidate, a.candidate)) continue;
        const labels = [a.candidate, b.candidate].sort(compareCodeUnits);
        const certified = await findCertifiedJoin(repo, head, `${a.episodeId}+${b.episodeId}`, Math.max(a.slot, b.slot), labels, snapshots);
        const key = `${certified.mergeCommit}\0${certified.branchLabels.join("\0")}`;
        if (!seenJoins.has(key)) { seenJoins.add(key); joins.push(certified); }
      }
    }
    if (joins.length) {
      for (const join of joins) await assertCurrentRetainsJoin(repo, head, join);
      await snapshots.validateWholeL1AndL2(head);
    }
    return Object.freeze({
      status: "accepted",
      head,
      candidates: Object.freeze(candidates),
      joins: Object.freeze(joins),
      openEpisodeIds: Object.freeze(recovered.open.map((cursor) => cursor.episodeId).sort(compareCodeUnits)),
      terminalEpisodeIds: Object.freeze(recovered.terminal.map((cursor) => cursor.episodeId).sort(compareCodeUnits)),
      quarantined: Object.freeze([]),
    });
  } catch (error) {
    const externalCode = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "RECOVERY_HISTORY_FAILED";
    const externalDetail = error && typeof error === "object" && "detail" in error ? (error as { detail?: Record<string, unknown> }).detail : undefined;
    const typed = error instanceof RecoveryHistoryClassificationError ? error : new RecoveryHistoryClassificationError(externalCode, error instanceof Error ? error.message : String(error), externalDetail);
    const episodeId = typeof typed.detail?.episodeId === "string" ? typed.detail.episodeId : "history";
    const item: RecoveryHistoryQuarantine = recoveryQuarantineDiagnostic(episodeId, typed);
    return Object.freeze({ status: "quarantined", head, candidates: Object.freeze([]), joins: Object.freeze([]), openEpisodeIds: Object.freeze([]), terminalEpisodeIds: Object.freeze([]), quarantined: Object.freeze([item]) });
  } finally {
    await snapshots.dispose();
  }
}

export async function classifyV2RecoveryHistory(options: { repo: string; scan?: WholeL1ScanResult; head?: string; symbolicRef?: string }): Promise<V2RecoveryHistoryResult> {
  const repo = path.resolve(options.repo);
  const head = await resolveCommit(repo, options.head ?? "HEAD");
  const snapshots = new SnapshotCache(repo);
  try {
    const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: repo });
    await assertReachableRecoveryRetention(repo, head);
    const rows = v2Records(scan);
    if (!rows.length) return Object.freeze({ status: "accepted", head, episodes: Object.freeze([]), joins: Object.freeze([]), consumedEventIds: Object.freeze([]), writableFrontierCount: 0, quarantined: Object.freeze([]), [V2_ACCEPTED_BRAND]: true });
    const grouped = new Map<string, V2Record[]>();
    for (const row of rows) grouped.set(row.event.episode_id, [...(grouped.get(row.event.episode_id) ?? []), row]);
    const parsed = new Map<string, ParsedEpisode>();
    for (const [episodeId, episodeRows] of grouped) parsed.set(episodeId, parseEpisode(episodeId, episodeRows));

    for (const episode of parsed.values()) {
      const divergentSlots = new Set([...new Set(episode.candidates.map((candidate) => candidate.slot))]
        .filter((slot) => episode.candidates.filter((candidate) => candidate.slot === slot).length > 1));
      for (const candidate of episode.candidates) {
        const shape = await validateCandidate(repo, head, episode.episodeId, candidate.slot, candidate.rows.prepared);
        // Complete single-closure leaves may have their four metadata objects
        // in the worktree tail awaiting a future content drain. Git provenance
        // is authority only for partitioning conflicting bytes.
        const label = divergentSlots.has(candidate.slot)
          ? await branchLabelForCandidate(repo, head, candidate.rows)
          : shape.candidate;
        episode.closures.push(Object.freeze({
          episodeId: episode.episodeId,
          slot: candidate.slot,
          candidate: shape.candidate,
          frozenCommit: shape.frozenCommit,
          preparedEventId: eventId(candidate.rows.prepared),
          publishedEventId: eventId(candidate.rows.published),
          convergedEventId: eventId(candidate.rows.converged),
          branchLabel: label,
          childEpisodeId: deriveNextEpisodeIdentity({ symbolicRef: options.symbolicRef ?? SYMBOLIC_REF, generationAnchor: eventId(candidate.rows.converged) }),
        }));
      }
    }

    const edges = new Map<string, readonly string[]>();
    for (const episode of parsed.values()) edges.set(episode.episodeId, Object.freeze(episode.closures.map((closure) => closure.childEpisodeId).filter((child) => parsed.has(child)).sort(compareCodeUnits)));
    assertAcyclicDirectedGraph(edges);
    const rootEpisode = drainEpisodeIdentity({ symbolic_ref: options.symbolicRef ?? SYMBOLIC_REF, generation_anchor: "genesis" });
    const visited = new Set<string>();
    const walk = (episodeId: string): void => {
      if (visited.has(episodeId)) return;
      const episode = parsed.get(episodeId);
      if (!episode) return;
      visited.add(episodeId);
      for (const child of edges.get(episodeId) ?? []) walk(child);
    };
    walk(rootEpisode);
    const orphans = [...parsed.keys()].filter((episodeId) => !visited.has(episodeId)).sort(compareCodeUnits);
    if (orphans.length) fail("RECOVERY_EPISODE_ORPHAN", "v2 episode is not reachable from genesis through every accepted converged hash", { episodeId: orphans[0], orphans });

    const joins: CertifiedSemanticJoin[] = [];
    for (const episode of parsed.values()) {
      const bySlot = new Map<number, AcceptedV2Closure[]>();
      for (const closure of episode.closures) bySlot.set(closure.slot, [...(bySlot.get(closure.slot) ?? []), closure]);
      for (const [slot, closures] of bySlot) {
        if (closures.length < 2) continue;
        const labels = closures.map((closure) => closure.branchLabel).sort(compareCodeUnits);
        joins.push(await findCertifiedJoin(repo, head, episode.episodeId, slot, labels, snapshots));
      }
    }
    if (joins.length) {
      for (const join of joins) await assertCurrentRetainsJoin(repo, head, join);
      await snapshots.validateWholeL1AndL2(head);
    }

    const episodes: AcceptedV2Episode[] = [...parsed.values()].map((episode) => Object.freeze({
      episodeId: episode.episodeId,
      status: episode.status,
      closures: Object.freeze(episode.closures.slice().sort((left, right) => left.slot - right.slot || compareCodeUnits(left.candidate, right.candidate))),
      consumedEventIds: Object.freeze([...episode.consumed].sort(compareCodeUnits)),
      childEpisodeIds: Object.freeze(episode.closures.map((closure) => closure.childEpisodeId).filter((child) => parsed.has(child)).sort(compareCodeUnits)),
    })).sort((left, right) => compareCodeUnits(left.episodeId, right.episodeId));
    const consumedEventIds = episodes.flatMap((episode) => episode.consumedEventIds).sort(compareCodeUnits);
    if (consumedEventIds.length !== rows.length || new Set(consumedEventIds).size !== rows.length) fail("RECOVERY_OBJECT_CONSUMPTION", "global v2 object consumption is not exactly once", { total: rows.length, consumed: consumedEventIds.length, unique: new Set(consumedEventIds).size });
    return Object.freeze({ status: "accepted", head, episodes: Object.freeze(episodes), joins: Object.freeze(joins), consumedEventIds: Object.freeze(consumedEventIds), writableFrontierCount: 0, quarantined: Object.freeze([]), [V2_ACCEPTED_BRAND]: true });
  } catch (error) {
    return quarantine(head, error);
  } finally {
    await snapshots.dispose();
  }
}

export async function classifyRecoveryHistory(options: { repo: string; scan?: WholeL1ScanResult; head?: string; symbolicRef?: string }): Promise<CombinedRecoveryHistoryResult> {
  const repo = path.resolve(options.repo);
  const head = await resolveCommit(repo, options.head ?? "HEAD");
  const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: repo });
  const v2 = await classifyV2RecoveryHistory({ repo, scan, head, symbolicRef: options.symbolicRef });
  if (v2.status !== "accepted") {
    return Object.freeze({
      status: "quarantined",
      head,
      v2,
      v3: null,
      quarantined: Object.freeze(v2.quarantined.map((item) => Object.freeze({ ...item, protocol: "v2" as const }))),
    });
  }
  const v3 = await classifyV3RecoveryHistory({ repo, scan, head, acceptedV2: v2 });
  if (v3.status !== "accepted") {
    return Object.freeze({
      status: "quarantined",
      head,
      v2,
      v3,
      quarantined: Object.freeze(v3.quarantined.map((item) => Object.freeze({ ...item, protocol: "v3" as const }))),
    });
  }
  return Object.freeze({ status: "accepted", head, v2, v3, quarantined: Object.freeze([]) });
}
