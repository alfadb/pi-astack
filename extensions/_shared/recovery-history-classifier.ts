import { execFile, spawn } from "node:child_process";
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

function failure(code: string, message: string, detail?: Record<string, unknown>): RecoveryHistoryClassificationError {
  return new RecoveryHistoryClassificationError(code, message, detail);
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw failure(code, message, detail);
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

const GIT_BATCH_DEFAULT_TIMEOUT_MS = 60_000;
const GIT_BATCH_DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
const GIT_BATCH_DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const GIT_BATCH_MAX_STDERR_BYTES = 1024 * 1024;
const GIT_BATCH_MAX_HEADER_BYTES = 256;

interface GitBatchLimits {
  timeoutMs?: number;
  maxBlobBytes?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

interface NormalizedGitBatchLimits {
  timeoutMs: number;
  maxBlobBytes: number;
  maxOutputBytes: number;
}

const recoveryHistoryTestStats = {
  catFileBatchSpawns: 0,
  wholeValidationRuns: 0,
  wholeValidationCacheHits: 0,
};

function normalizeGitBatchLimits(options: GitBatchLimits = {}): NormalizedGitBatchLimits {
  const timeoutMs = options.timeoutMs ?? GIT_BATCH_DEFAULT_TIMEOUT_MS;
  const maxBlobBytes = options.maxBlobBytes ?? GIT_BATCH_DEFAULT_MAX_BLOB_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_BATCH_DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("RECOVERY_GIT_BATCH_LIMIT_INVALID", "cat-file batch timeout must be a positive safe integer", { timeoutMs });
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes <= 0) fail("RECOVERY_GIT_BATCH_LIMIT_INVALID", "cat-file batch blob limit must be a positive safe integer", { maxBlobBytes });
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) fail("RECOVERY_GIT_BATCH_LIMIT_INVALID", "cat-file batch output limit must be a positive safe integer", { maxOutputBytes });
  return { timeoutMs, maxBlobBytes, maxOutputBytes };
}

/**
 * Streaming cat-file --batch parser.
 *
 * Incoming data chunks are copied once into a capacity-doubling ring buffer
 * (no per-chunk Buffer.concat O(n²) path, no second defensive Buffer.from on
 * the socket chunk). Parsed blob bodies are isolated with a single copy at
 * commit time so callers own independent Buffers.
 */
class GitCatFileBatchParser {
  private readonly requests: readonly string[];
  private readonly limits: NormalizedGitBatchLimits;
  private readonly results = new Map<string, Buffer>();
  private buffer = Buffer.alloc(0);
  private length = 0;
  private readOffset = 0;
  private requestIndex = 0;
  private body: { oid: string; size: number } | undefined;
  private outputBytes = 0;

  constructor(requests: readonly string[], limits: NormalizedGitBatchLimits) {
    this.requests = requests;
    this.limits = limits;
  }

  private get available(): number {
    return this.length - this.readOffset;
  }

  private ensureCapacity(additional: number): void {
    const need = this.length + additional;
    if (need <= this.buffer.length) return;
    // Compact consumed prefix first when that frees enough room.
    if (this.readOffset > 0 && need - this.readOffset <= this.buffer.length) {
      this.buffer.copyWithin(0, this.readOffset, this.length);
      this.length -= this.readOffset;
      this.readOffset = 0;
      if (this.length + additional <= this.buffer.length) return;
    } else if (this.readOffset > 0) {
      this.buffer.copyWithin(0, this.readOffset, this.length);
      this.length -= this.readOffset;
      this.readOffset = 0;
    }
    let capacity = this.buffer.length || 4096;
    const target = this.length + additional;
    while (capacity < target) capacity *= 2;
    const next = Buffer.allocUnsafe(capacity);
    if (this.length > 0) this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  private compactIfNeeded(): void {
    if (this.readOffset === 0) return;
    if (this.readOffset < 64 * 1024 && this.available > 0) return;
    if (this.available === 0) {
      this.readOffset = 0;
      this.length = 0;
      return;
    }
    this.buffer.copyWithin(0, this.readOffset, this.length);
    this.length -= this.readOffset;
    this.readOffset = 0;
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > this.limits.maxOutputBytes) {
      fail("RECOVERY_GIT_BATCH_OUTPUT_LIMIT", "cat-file --batch exceeded the bounded stdout budget", {
        maxOutputBytes: this.limits.maxOutputBytes,
        observedBytes: this.outputBytes,
      });
    }
    // Single copy of the socket chunk into the owned ring buffer.
    this.ensureCapacity(chunk.length);
    chunk.copy(this.buffer, this.length);
    this.length += chunk.length;
    this.parseAvailable();
  }

  finish(): Map<string, Buffer> {
    this.parseAvailable();
    if (this.body || this.requestIndex !== this.requests.length) {
      fail("RECOVERY_GIT_BATCH_SHORT_READ", "cat-file --batch ended before every declared blob body was read", {
        expectedObjects: this.requests.length,
        completedObjects: this.requestIndex,
        pendingOid: this.body?.oid ?? this.requests[this.requestIndex] ?? null,
        bufferedBytes: this.available,
      });
    }
    if (this.available !== 0) {
      fail("RECOVERY_GIT_BATCH_TRAILING_BYTES", "cat-file --batch emitted bytes after the final response", {
        trailingBytes: this.available,
      });
    }
    return new Map(this.results);
  }

  private parseAvailable(): void {
    for (;;) {
      if (!this.body) {
        if (this.requestIndex >= this.requests.length) return;
        const view = this.buffer.subarray(this.readOffset, this.length);
        const newline = view.indexOf(0x0a);
        if (newline < 0) {
          if (this.available > GIT_BATCH_MAX_HEADER_BYTES) {
            fail("RECOVERY_GIT_BATCH_HEADER_INVALID", "cat-file --batch header exceeded its bounded length", { headerBytes: this.available });
          }
          return;
        }
        if (newline > GIT_BATCH_MAX_HEADER_BYTES) {
          fail("RECOVERY_GIT_BATCH_HEADER_INVALID", "cat-file --batch header exceeded its bounded length", { headerBytes: newline });
        }
        const requested = this.requests[this.requestIndex]!;
        const header = view.subarray(0, newline).toString("ascii");
        this.readOffset += newline + 1;
        if (header === `${requested} missing`) {
          fail("RECOVERY_GIT_BATCH_MISSING", "cat-file --batch reported a missing object", { oid: requested, requestIndex: this.requestIndex });
        }
        const match = /^([0-9a-f]+) ([^ ]+) ([0-9]+)$/.exec(header);
        if (!match) fail("RECOVERY_GIT_BATCH_HEADER_INVALID", "cat-file --batch returned a malformed header", { requestIndex: this.requestIndex, header });
        const [, oid, type, rawSize] = match;
        if (oid !== requested) fail("RECOVERY_GIT_BATCH_OID_MISMATCH", "cat-file --batch response did not match request order", { requested, actual: oid, requestIndex: this.requestIndex });
        if (type !== "blob") fail("RECOVERY_GIT_BATCH_TYPE_MISMATCH", "cat-file --batch object is not a blob", { oid, type, requestIndex: this.requestIndex });
        const size = Number(rawSize);
        if (!Number.isSafeInteger(size) || size < 0 || String(size) !== rawSize) {
          fail("RECOVERY_GIT_BATCH_SIZE_INVALID", "cat-file --batch declared an invalid object size", { oid, rawSize });
        }
        if (size > this.limits.maxBlobBytes) {
          fail("RECOVERY_GIT_BATCH_BLOB_LIMIT", "cat-file --batch blob exceeded the per-object bound", { oid, size, maxBlobBytes: this.limits.maxBlobBytes });
        }
        this.body = { oid, size };
      }

      const body = this.body;
      if (this.available < body.size + 1) return;
      if (this.buffer[this.readOffset + body.size] !== 0x0a) {
        fail("RECOVERY_GIT_BATCH_DELIMITER_INVALID", "cat-file --batch blob body lacks the required trailing newline", { oid: body.oid, size: body.size });
      }
      // One isolation copy of the body; callers own the resulting Buffer.
      this.results.set(body.oid, Buffer.from(this.buffer.subarray(this.readOffset, this.readOffset + body.size)));
      this.readOffset += body.size + 1;
      this.requestIndex += 1;
      this.body = undefined;
      this.compactIfNeeded();
    }
  }
}

async function readGitBlobsBatch(repo: string, objectIds: readonly string[], options: GitBatchLimits = {}): Promise<Map<string, Buffer>> {
  const requests = [...new Set(objectIds)];
  for (const oid of requests) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
      fail("RECOVERY_GIT_BATCH_REQUEST_INVALID", "cat-file --batch request is not an exact Git object id", { oid });
    }
  }
  if (!requests.length) return new Map();
  const limits = normalizeGitBatchLimits(options);
  if (options.signal?.aborted) fail("RECOVERY_GIT_BATCH_ABORTED", "cat-file --batch was aborted before spawn");

  recoveryHistoryTestStats.catFileBatchSpawns += 1;
  const child = spawn("git", ["-C", repo, "--literal-pathspecs", "cat-file", "--batch"], {
    env: gitEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parser = new GitCatFileBatchParser(requests, limits);
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    let settled = false;
    let stderrBytes = 0;
    const stderrChunks: Buffer[] = [];
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      reject(error);
    };
    const onAbort = () => rejectOnce(failure("RECOVERY_GIT_BATCH_ABORTED", "cat-file --batch was aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      rejectOnce(failure("RECOVERY_GIT_BATCH_TIMEOUT", "cat-file --batch exceeded its timeout", { timeoutMs: limits.timeoutMs }));
    }, limits.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      // parser.push performs the single owned copy; do not double-Buffer here.
      try { parser.push(chunk); }
      catch (error) { rejectOnce(error); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > GIT_BATCH_MAX_STDERR_BYTES) {
        rejectOnce(failure("RECOVERY_GIT_BATCH_STDERR_LIMIT", "cat-file --batch exceeded the bounded stderr budget", { stderrBytes }));
        return;
      }
      stderrChunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => rejectOnce(failure("RECOVERY_GIT_BATCH_SPAWN_FAILED", error.message)));
    child.stdin.once("error", (error) => rejectOnce(failure("RECOVERY_GIT_BATCH_STDIN_FAILED", error.message)));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").slice(0, 1000);
        rejectOnce(failure("RECOVERY_GIT_BATCH_EXIT_FAILED", "cat-file --batch exited unsuccessfully", { code, signal, stderr }));
        return;
      }
      try {
        const result = parser.finish();
        settled = true;
        cleanup();
        resolve(result);
      } catch (error) {
        rejectOnce(error);
      }
    });

    child.stdin.end(`${requests.join("\n")}\n`);
  });
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

async function commitParentsUncached(repo: string, commit: string): Promise<string[]> {
  const line = (await gitText(repo, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/);
  if (line[0] !== commit) fail("RECOVERY_GIT_GRAPH_INVALID", "git returned the wrong commit while reading parents", { commit, line });
  return line.slice(1);
}

async function treeEntriesUncached(repo: string, commit: string, prefix: string): Promise<Map<string, TreeEntry>> {
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

/** Uncached fallback for call sites outside a classification SnapshotCache. */
async function commitParents(repo: string, commit: string): Promise<string[]> {
  return commitParentsUncached(repo, commit);
}

async function treeEntries(repo: string, commit: string, prefix: string): Promise<Map<string, TreeEntry>> {
  return treeEntriesUncached(repo, commit, prefix);
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

async function truePathIntroductionCommits(repo: string, commits: readonly string[], relativePath: string, snapshots?: SnapshotCache): Promise<string[]> {
  const introduced: string[] = [];
  for (const commit of commits) {
    const parents = snapshots ? await snapshots.commitParents(commit) : await commitParents(repo, commit);
    const inherited = (await Promise.all(parents.map(async (parent) => {
      const tree = snapshots ? await snapshots.treeEntries(parent, relativePath) : await treeEntries(repo, parent, relativePath);
      return tree.has(relativePath);
    }))).some(Boolean);
    if (!inherited) introduced.push(commit);
  }
  return introduced;
}

async function eventIntroductionCommits(repo: string, head: string, row: V2Record, snapshots?: SnapshotCache): Promise<string[]> {
  const relativePath = row.record.relativePath;
  if (!relativePath) fail("RECOVERY_EVENT_PATH_MISSING", "validated v2 event has no relative path", { eventId: eventId(row) });
  // -m is required for merge commits: without it Git emits no path diff for a
  // path created by the merge result itself. It can emit the same merge once
  // per parent, so classification de-duplicates commit labels.
  const mutated = [...new Set((await gitText(repo, ["log", "-m", "--format=%H", "--full-history", "--diff-filter=MD", head, "--", relativePath])).trim().split("\n").filter(Boolean))];
  if (mutated.length) fail("RECOVERY_L1_HISTORY_MUTATED", "content-addressed v2 object was modified or deleted in reachable history", { eventId: eventId(row), relativePath, commits: mutated });
  const addDiffCommits = [...new Set((await gitText(repo, ["log", "-m", "--format=%H", "--full-history", "--diff-filter=A", head, "--", relativePath])).trim().split("\n").filter(Boolean))];
  const introduced = await truePathIntroductionCommits(repo, addDiffCommits, relativePath, snapshots);
  if (!introduced.length) fail("RECOVERY_EVENT_UNCOMMITTED", "v2 history object is not introduced by any HEAD ancestor", { eventId: eventId(row), relativePath });
  return introduced;
}

async function branchLabelForCandidate(repo: string, head: string, rows: CandidateRows, snapshots: SnapshotCache): Promise<string> {
  const introductions = new Set<string>();
  for (const row of [rows.prepared, rows.published, rows.converged]) {
    for (const commit of await eventIntroductionCommits(repo, head, row, snapshots)) introductions.add(commit);
  }
  const commits = [...introductions];
  const maximal = [];
  for (const candidate of commits) {
    let descendantOfAll = true;
    for (const other of commits) if (!await snapshots.isAncestor(other, candidate)) descendantOfAll = false;
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

async function validateCandidate(repo: string, head: string, episodeId: string, slot: number, row: V2Record, snapshots: SnapshotCache): Promise<{ candidate: string; frozenCommit: string }> {
  const decoded = decodePreparedRecoveryEvent(row.event, repo, SYMBOLIC_REF);
  const prepared = decoded.prepared;
  if (cohortManifestRoot(prepared.entries) !== prepared.cohortManifestRoot) fail("RECOVERY_COHORT_ROOT_INVALID", "prepared cohort semantic root does not match entries", { episodeId, slot, candidate: prepared.candidate });
  if (!await snapshots.isAncestor(prepared.candidate, head)) fail("RECOVERY_CANDIDATE_NOT_ANCESTOR", "closure candidate is not a current HEAD ancestor", { episodeId, slot, candidate: prepared.candidate, head });
  const [candidateTree, parents, parentEpoch, commitBytes] = await Promise.all([
    gitText(repo, ["rev-parse", "--verify", `${prepared.candidate}^{tree}`]).then((value) => value.trim()),
    snapshots.commitParents(prepared.candidate),
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
  await validatePreparedEntries(repo, episodeId, slot, prepared.candidate, prepared.entries, diff, (objectIds) => snapshots.readBlobs(objectIds));
  return { candidate: prepared.candidate, frozenCommit: prepared.frozenCommit };
}

async function validateCandidateV3(repo: string, head: string, episodeId: string, slot: number, event: RecoveryEventV3, snapshots: SnapshotCache): Promise<{ candidate: string; baseCommit: string }> {
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
  if (!await snapshots.isAncestor(prepared.candidate, head)) fail("RECOVERY_CANDIDATE_NOT_ANCESTOR", "v3 closure candidate is not a current HEAD ancestor", { episodeId, slot, candidate: prepared.candidate, head });
  const [candidateTree, parents, parentEpoch, commitBytes] = await Promise.all([
    gitText(repo, ["rev-parse", "--verify", `${prepared.candidate}^{tree}`]).then((value) => value.trim()),
    snapshots.commitParents(prepared.candidate),
    gitText(repo, ["show", "-s", "--format=%ct", prepared.frozenCommit]).then((value) => value.trim()),
    gitBuffer(repo, ["cat-file", "commit", prepared.candidate]),
  ]);
  if (candidateTree !== prepared.newTree || parents.length !== 1 || parents[0] !== prepared.frozenCommit || prepared.frozenCommit !== event.operation.base_commit) fail("RECOVERY_CANDIDATE_SHAPE_INVALID", "v3 candidate parent/tree/base does not match exact operation", { episodeId, slot, candidate: prepared.candidate, parents, candidateTree });
  const expectedHeader = `tree ${prepared.newTree}\nparent ${prepared.frozenCommit}\nauthor ${AUTHOR} ${parentEpoch} +0000\ncommitter ${AUTHOR} ${parentEpoch} +0000\n\n`;
  const expectedCommit = `${expectedHeader}${deterministicDrainCommitMessage(prepared.cohortManifestRoot, LOCAL_DRAIN_PROTOCOL_V3)}\n`;
  if (commitBytes.toString("utf-8") !== expectedCommit) fail("RECOVERY_CANDIDATE_METADATA_INVALID", "v3 candidate commit bytes are not deterministic", { episodeId, slot, candidate: prepared.candidate });
  const diff = parseRawDiff(await gitBuffer(repo, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", prepared.frozenCommit, prepared.candidate]));
  if (diff.size !== prepared.entries.length) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "v3 candidate exact diff size does not match prepared entries", { episodeId, slot, candidate: prepared.candidate, expected: prepared.entries.length, actual: diff.size });
  await validatePreparedEntries(repo, episodeId, slot, prepared.candidate, prepared.entries, diff, (objectIds) => snapshots.readBlobs(objectIds));
  return { candidate: prepared.candidate, baseCommit: prepared.frozenCommit };
}

async function validatePreparedEntries(
  repo: string,
  episodeId: string,
  slot: number,
  candidate: string,
  entries: readonly PreparedCohortEntry[],
  diff: Map<string, { oldMode: string; newMode: string; oldOid: string; newOid: string; status: string }>,
  readBlobs: (objectIds: readonly string[]) => Promise<Map<string, Buffer>> = (objectIds) => readGitBlobsBatch(repo, objectIds),
): Promise<void> {
  const putEntries: PreparedCohortEntry[] = [];
  for (const entry of entries) {
    const row = diff.get(entry.path);
    if (!row) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "prepared path is absent from candidate diff", { episodeId, slot, candidate, path: entry.path });
    if (entry.op === "delete") {
      if (row.status !== "D" || row.newMode !== "000000") fail("RECOVERY_CANDIDATE_DIFF_INVALID", "prepared delete does not match candidate diff", { episodeId, slot, candidate, path: entry.path, diff: row });
      continue;
    }
    if ((row.status !== "A" && row.status !== "M") || row.newMode !== entry.mode || row.newOid !== entry.blobOid) fail("RECOVERY_CANDIDATE_DIFF_INVALID", "prepared put does not match candidate diff", { episodeId, slot, candidate, path: entry.path, diff: row, entry });
    putEntries.push(entry);
  }

  const blobs = await readBlobs(putEntries.map((entry) => entry.blobOid));
  for (const entry of putEntries) {
    const bytes = blobs.get(entry.blobOid);
    if (!bytes || sha256Hex(bytes) !== entry.bytesSha256) fail("RECOVERY_CANDIDATE_BLOB_INVALID", "prepared byte hash does not match candidate blob", { episodeId, slot, candidate, path: entry.path, blobOid: entry.blobOid });
  }
}

async function assertAntichain(labels: readonly string[], episodeId: string, slot: number, snapshots: SnapshotCache): Promise<void> {
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      if (await snapshots.isAncestor(labels[left]!, labels[right]!) || await snapshots.isAncestor(labels[right]!, labels[left]!)) {
        fail("RECOVERY_SAME_BRANCH_CONFLICT", "conflicting closure bytes are comparable in branch ancestry", { episodeId, slot, left: labels[left], right: labels[right] });
      }
    }
  }
}

async function findCertifiedJoin(repo: string, head: string, episodeId: string, slot: number, labels: readonly string[], snapshots: SnapshotCache): Promise<CertifiedSemanticJoin> {
  await assertAntichain(labels, episodeId, slot, snapshots);
  // Pure graph facts for a fixed HEAD are memoized on SnapshotCache so the
  // O(pairs × merges) v3 join search does not re-spawn merge-base/ls-tree.
  const merges = await snapshots.mergeCommits(head);
  const validationErrors: Array<{ merge: string; error: string }> = [];
  for (const merge of merges) {
    if (!(await Promise.all(labels.map((label) => snapshots.isAncestor(label, merge)))).every(Boolean)) continue;
    const parents = await snapshots.commitParents(merge);
    if (parents.length < 2) continue;
    const coverage: boolean[][] = [];
    for (const parent of parents) coverage.push(await Promise.all(labels.map((label) => snapshots.isAncestor(label, parent))));
    if (labels.some((_, index) => !coverage.some((row) => row[index]))) continue;
    const relevantIndexes = coverage.map((row, index) => row.some(Boolean) ? index : -1).filter((index) => index >= 0);
    if (relevantIndexes.length < 2 || relevantIndexes.some((index) => coverage[index]!.every(Boolean))) continue;
    const relevantParents = relevantIndexes.map((index) => parents[index]!);
    const parentTrees = await Promise.all(relevantParents.map((parent) => snapshots.treeEntries(parent, L1_PREFIX)));
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
    const joinedL1 = await snapshots.treeEntries(merge, L1_PREFIX);
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
  readonly snapshots = new Map<string, Promise<{ root: string; scan: WholeL1ScanResult }>>();
  readonly validations = new Map<string, Promise<number>>();
  readonly objectFormat: Promise<string>;
  private readonly blobBytes = new Map<string, Buffer>();
  private blobCacheBytes = 0;
  private readonly ancestry = new Map<string, Promise<boolean>>();
  private readonly mergeLists = new Map<string, Promise<readonly string[]>>();
  private readonly parents = new Map<string, Promise<readonly string[]>>();
  private readonly trees = new Map<string, Promise<Map<string, TreeEntry>>>();

  constructor(repo: string) {
    this.repo = repo;
    this.objectFormat = gitText(repo, ["rev-parse", "--show-object-format"]).then((value) => value.trim());
  }

  isAncestor(maybeAncestor: string, descendant: string): Promise<boolean> {
    if (maybeAncestor === descendant) return Promise.resolve(true);
    const key = `${maybeAncestor}\0${descendant}`;
    const existing = this.ancestry.get(key);
    if (existing) return existing;
    const created = isAncestor(this.repo, maybeAncestor, descendant);
    this.ancestry.set(key, created);
    return created;
  }

  mergeCommits(head: string): Promise<readonly string[]> {
    const existing = this.mergeLists.get(head);
    if (existing) return existing;
    const created = gitText(this.repo, ["rev-list", "--merges", "--reverse", head]).then((raw) => Object.freeze(raw.trim().split("\n").filter(Boolean)));
    this.mergeLists.set(head, created);
    return created;
  }

  commitParents(commit: string): Promise<readonly string[]> {
    const existing = this.parents.get(commit);
    if (existing) return existing;
    const created = commitParentsUncached(this.repo, commit).then((value) => Object.freeze(value));
    this.parents.set(commit, created);
    return created;
  }

  treeEntries(commit: string, prefix: string): Promise<Map<string, TreeEntry>> {
    const key = `${commit}\0${prefix}`;
    const existing = this.trees.get(key);
    if (existing) return existing;
    const created = treeEntriesUncached(this.repo, commit, prefix);
    this.trees.set(key, created);
    return created;
  }

  canonicalL2TreeEntries(commit: string): Promise<Map<string, TreeEntry>> {
    return canonicalL2TreeEntriesFrom(this, commit);
  }

  async dispose(): Promise<void> {
    // The number of certified joins is history-dependent. Remove snapshots
    // serially instead of creating another unbounded Promise.all fan-out.
    for (const root of this.roots.values()) {
      await fsp.rm(root, { recursive: true, force: true });
    }
    this.blobBytes.clear();
    this.blobCacheBytes = 0;
    this.ancestry.clear();
    this.mergeLists.clear();
    this.parents.clear();
    this.trees.clear();
  }

  async readBlobs(objectIds: readonly string[]): Promise<Map<string, Buffer>> {
    const requested = [...new Set(objectIds)];
    const missing = requested.filter((oid) => !this.blobBytes.has(oid));
    const loaded = await readGitBlobsBatch(this.repo, missing);
    for (const [oid, bytes] of loaded) {
      if (this.blobBytes.has(oid)) continue;
      const nextBytes = this.blobCacheBytes + bytes.length;
      if (nextBytes > GIT_BATCH_DEFAULT_MAX_OUTPUT_BYTES) {
        fail("RECOVERY_GIT_BATCH_OUTPUT_LIMIT", "classification blob cache exceeded its bounded byte budget", {
          maxOutputBytes: GIT_BATCH_DEFAULT_MAX_OUTPUT_BYTES,
          observedBytes: nextBytes,
        });
      }
      this.blobBytes.set(oid, bytes);
      this.blobCacheBytes = nextBytes;
    }
    const result = new Map<string, Buffer>();
    for (const oid of requested) {
      const bytes = this.blobBytes.get(oid);
      if (!bytes) fail("RECOVERY_GIT_BATCH_SHORT_READ", "classification blob cache omitted a requested object", { oid });
      result.set(oid, bytes);
    }
    return result;
  }

  snapshot(commit: string): Promise<{ root: string; scan: WholeL1ScanResult }> {
    const existing = this.snapshots.get(commit);
    if (existing) return existing;
    const created = this.createSnapshot(commit);
    // Rejections remain cached for this immutable classification run. Retrying
    // the same commit in the same proof could turn one I/O fault into divergent
    // v2/v3 verdicts. A new top-level classification gets a fresh cache.
    this.snapshots.set(commit, created);
    return created;
  }

  private async createSnapshot(commit: string): Promise<{ root: string; scan: WholeL1ScanResult }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-astack-history-snapshot-"));
    this.roots.set(commit, root);
    const archivePath = path.join(root, "l1.tar");
    try {
      const archive = await gitBuffer(this.repo, ["archive", "--format=tar", commit, "l1"]);
      await fsp.writeFile(archivePath, archive);
      await execFileAsync("tar", ["-xf", archivePath, "-C", root], { env: gitEnvironment(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      const scan = await scanWholeL1Validated({ abrainHome: root });
      return { root, scan };
    } finally {
      await fsp.rm(archivePath, { force: true });
    }
  }

  validateWholeL1AndL2(commit: string): Promise<number> {
    const existing = this.validations.get(commit);
    if (existing) {
      recoveryHistoryTestStats.wholeValidationCacheHits += 1;
      return existing;
    }
    recoveryHistoryTestStats.wholeValidationRuns += 1;
    const created = this.validateWholeL1AndL2Uncached(commit);
    // Failures are intentionally sticky for this cache lifetime; see snapshot().
    this.validations.set(commit, created);
    return created;
  }

  private async validateWholeL1AndL2Uncached(commit: string): Promise<number> {
    const { scan } = await this.snapshot(commit);
    const actual = await this.canonicalL2TreeEntries(commit);
    const expected = await buildExpectedL2(this.repo, scan, actual, (objectIds) => this.readBlobs(objectIds));
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

// Attached to SnapshotCache so L2 tree walks reuse the same ls-tree memo table
// as certified-join search within one classification run.
async function canonicalL2TreeEntriesFrom(snapshots: SnapshotCache, commit: string): Promise<Map<string, TreeEntry>> {
  const knowledge = await snapshots.treeEntries(commit, `${KNOWLEDGE_L2_V1.canonicalRoot}/`);
  const constraint = await snapshots.treeEntries(commit, `${CONSTRAINT_L2_V1.canonicalRoot}/`);
  return new Map([...knowledge, ...constraint]);
}

async function buildExpectedL2(
  repo: string,
  scan: WholeL1ScanResult,
  actual: ReadonlyMap<string, TreeEntry>,
  readBlobs: (objectIds: readonly string[]) => Promise<Map<string, Buffer>> = (objectIds) => readGitBlobsBatch(repo, objectIds),
): Promise<Map<string, Buffer>> {
  assertCanonicalL2ReconcilerCoverage();
  const manifestPath = canonicalKnowledgeManifestRelativePathV1();
  const knowledgeMarkdownEntries = [...actual.values()]
    .filter((entry) => entry.path.startsWith(`${KNOWLEDGE_L2_V1.canonicalRoot}/`) && entry.path.endsWith(".md"))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const manifestEntry = actual.get(manifestPath);
  const constraintEntry = actual.get(CONSTRAINT_L2_V1.canonicalPath);
  const blobs = await readBlobs([
    ...knowledgeMarkdownEntries.map((entry) => entry.oid),
    ...(manifestEntry ? [manifestEntry.oid] : []),
    ...(constraintEntry ? [constraintEntry.oid] : []),
  ]);
  const blobText = (entry: TreeEntry | undefined): string | null => {
    if (!entry) return null;
    const bytes = blobs.get(entry.oid);
    if (!bytes) fail("RECOVERY_GIT_BATCH_SHORT_READ", "validated batch result omitted a requested L2 blob", { oid: entry.oid, path: entry.path });
    return bytes.toString("utf-8");
  };
  const knowledgeMarkdown = knowledgeMarkdownEntries.map((entry) => blobText(entry)!);
  const knowledgeManifest = blobText(manifestEntry);
  const constraintMarkdown = blobText(constraintEntry);
  const constraintSourceTemplateVersions = scan.selected
    .filter((record) => record.registration.envelope_schema === "constraint-projection-envelope/v1")
    .map((record) => String(record.body.template_version ?? ""));
  selectCanonicalL2ReconcilerVersions({ knowledgeMarkdown, knowledgeManifest, constraintMarkdown, constraintSourceTemplateVersions });
  return new Map(buildCanonicalL2V1(scan));
}

async function assertReachableRecoveryRetention(repo: string, head: string, snapshots?: SnapshotCache): Promise<void> {
  const introduced = new Set((await gitText(repo, ["log", "-m", "--format=", "--name-only", "--full-history", "--diff-filter=A", head, "--", L1_PREFIX]))
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(L1_PREFIX)));
  const current = snapshots ? await snapshots.treeEntries(head, L1_PREFIX) : await treeEntries(repo, head, L1_PREFIX);
  const missing = [...introduced].filter((relative) => !current.has(relative)).sort(compareCodeUnits);
  const missingRecovery: string[] = [];
  for (const relative of missing) {
    const addDiffCommits = [...new Set((await gitText(repo, ["log", "-m", "--format=%H", "--full-history", "--diff-filter=A", head, "--", relative])).trim().split("\n").filter(Boolean))];
    const introducedAt = (await truePathIntroductionCommits(repo, addDiffCommits, relative, snapshots)).at(-1);
    if (!introducedAt) continue;
    let parsed: unknown;
    try { parsed = JSON.parse((await gitBuffer(repo, ["show", `${introducedAt}:${relative}`])).toString("utf-8")); }
    catch { continue; }
    const schema = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).schema : null;
    if (schema === "drain-recovery-envelope/v1" || schema === "local-drain-recovery-envelope/v2" || schema === "local-drain-recovery-envelope/v3") missingRecovery.push(relative);
  }
  if (missingRecovery.length) fail("RECOVERY_REACHABLE_L1_DROPPED", "current HEAD dropped recovery objects introduced by its reachable branch history", { head, introduced: introduced.size, current: current.size, missingRecovery: missingRecovery.slice(0, 20) });
}

async function assertCurrentRetainsJoin(repo: string, head: string, join: CertifiedSemanticJoin, snapshots: SnapshotCache): Promise<void> {
  const joined = await snapshots.treeEntries(join.mergeCommit, L1_PREFIX);
  const current = await snapshots.treeEntries(head, L1_PREFIX);
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

async function classifyV3RecoveryHistoryWithSnapshots(options: { repo: string; acceptedV2: V2RecoveryHistoryResult; scan?: WholeL1ScanResult; head?: string }, snapshots: SnapshotCache): Promise<V3RecoveryHistoryResult> {
  const repo = path.resolve(options.repo);
  const head = await resolveCommit(repo, options.head ?? "HEAD");
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
      const validated = await validateCandidateV3(repo, head, cursor.episodeId, slot, state.prepared, snapshots);
      candidates.push(Object.freeze({ episodeId: cursor.episodeId, slot, candidate: validated.candidate, baseCommit: validated.baseCommit }));
    }
    candidates.sort((left, right) => compareCodeUnits(left.candidate, right.candidate));

    const joins: CertifiedSemanticJoin[] = [];
    const seenJoins = new Set<string>();
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        const a = candidates[left]!; const b = candidates[right]!;
        if (await snapshots.isAncestor(a.candidate, b.candidate) || await snapshots.isAncestor(b.candidate, a.candidate)) continue;
        const labels = [a.candidate, b.candidate].sort(compareCodeUnits);
        const certified = await findCertifiedJoin(repo, head, `${a.episodeId}+${b.episodeId}`, Math.max(a.slot, b.slot), labels, snapshots);
        const key = `${certified.mergeCommit}\0${certified.branchLabels.join("\0")}`;
        if (!seenJoins.has(key)) { seenJoins.add(key); joins.push(certified); }
      }
    }
    if (joins.length) {
      for (const join of joins) await assertCurrentRetainsJoin(repo, head, join, snapshots);
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
  }
}

export async function classifyV3RecoveryHistory(options: { repo: string; acceptedV2: V2RecoveryHistoryResult; scan?: WholeL1ScanResult; head?: string }): Promise<V3RecoveryHistoryResult> {
  const snapshots = new SnapshotCache(path.resolve(options.repo));
  try {
    return await classifyV3RecoveryHistoryWithSnapshots(options, snapshots);
  } finally {
    await snapshots.dispose();
  }
}

async function classifyV2RecoveryHistoryWithSnapshots(options: { repo: string; scan?: WholeL1ScanResult; head?: string; symbolicRef?: string }, snapshots: SnapshotCache): Promise<V2RecoveryHistoryResult> {
  const repo = path.resolve(options.repo);
  const head = await resolveCommit(repo, options.head ?? "HEAD");
  try {
    const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: repo });
    await assertReachableRecoveryRetention(repo, head, snapshots);
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
        const shape = await validateCandidate(repo, head, episode.episodeId, candidate.slot, candidate.rows.prepared, snapshots);
        // Complete single-closure leaves may have their four metadata objects
        // in the worktree tail awaiting a future content drain. Git provenance
        // is authority only for partitioning conflicting bytes.
        const label = divergentSlots.has(candidate.slot)
          ? await branchLabelForCandidate(repo, head, candidate.rows, snapshots)
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
      for (const join of joins) await assertCurrentRetainsJoin(repo, head, join, snapshots);
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
  }
}

export async function classifyV2RecoveryHistory(options: { repo: string; scan?: WholeL1ScanResult; head?: string; symbolicRef?: string }): Promise<V2RecoveryHistoryResult> {
  const snapshots = new SnapshotCache(path.resolve(options.repo));
  try {
    return await classifyV2RecoveryHistoryWithSnapshots(options, snapshots);
  } finally {
    await snapshots.dispose();
  }
}

export async function classifyRecoveryHistory(options: { repo: string; scan?: WholeL1ScanResult; head?: string; symbolicRef?: string }): Promise<CombinedRecoveryHistoryResult> {
  const repo = path.resolve(options.repo);
  const head = await resolveCommit(repo, options.head ?? "HEAD");
  const scan = options.scan ?? await scanWholeL1Validated({ abrainHome: repo });
  const snapshots = new SnapshotCache(repo);
  try {
    const v2 = await classifyV2RecoveryHistoryWithSnapshots({ repo, scan, head, symbolicRef: options.symbolicRef }, snapshots);
    if (v2.status !== "accepted") {
      return Object.freeze({
        status: "quarantined",
        head,
        v2,
        v3: null,
        quarantined: Object.freeze(v2.quarantined.map((item) => Object.freeze({ ...item, protocol: "v2" as const }))),
      });
    }
    const v3 = await classifyV3RecoveryHistoryWithSnapshots({ repo, scan, head, acceptedV2: v2 }, snapshots);
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
  } finally {
    await snapshots.dispose();
  }
}

export async function _readGitBlobsBatchForTests(
  repo: string,
  objectIds: readonly string[],
  options: GitBatchLimits = {},
): Promise<Map<string, Buffer>> {
  return readGitBlobsBatch(repo, objectIds, options);
}

export function _parseGitCatFileBatchForTests(
  objectIds: readonly string[],
  chunks: readonly Buffer[],
  options: Pick<GitBatchLimits, "maxBlobBytes" | "maxOutputBytes"> = {},
): Map<string, Buffer> {
  const requests = [...new Set(objectIds)];
  const parser = new GitCatFileBatchParser(requests, normalizeGitBatchLimits(options));
  for (const chunk of chunks) parser.push(chunk);
  return parser.finish();
}

export async function _validateWholeL1AndL2CacheForTests(repo: string, commit = "HEAD"): Promise<{ samePromise: boolean; count: number }> {
  const resolved = await resolveCommit(path.resolve(repo), commit);
  const snapshots = new SnapshotCache(path.resolve(repo));
  try {
    const first = snapshots.validateWholeL1AndL2(resolved);
    const second = snapshots.validateWholeL1AndL2(resolved);
    const count = await first;
    await second;
    return { samePromise: first === second, count };
  } finally {
    await snapshots.dispose();
  }
}

export function _recoveryHistoryBatchStatsForTests(): Readonly<typeof recoveryHistoryTestStats> {
  return Object.freeze({ ...recoveryHistoryTestStats });
}

export function _resetRecoveryHistoryBatchStatsForTests(): void {
  recoveryHistoryTestStats.catFileBatchSpawns = 0;
  recoveryHistoryTestStats.wholeValidationRuns = 0;
  recoveryHistoryTestStats.wholeValidationCacheHits = 0;
}

export async function _validatePreparedEntriesForTests(
  repo: string,
  entries: readonly PreparedCohortEntry[],
  diff: Map<string, { oldMode: string; newMode: string; oldOid: string; newOid: string; status: string }>,
): Promise<void> {
  await validatePreparedEntries(repo, "test-episode", 0, "test-candidate", entries, diff);
}

export async function _readGitBlobBatchesThroughCacheForTests(
  repo: string,
  batches: readonly (readonly string[])[],
): Promise<readonly Map<string, Buffer>[]> {
  const snapshots = new SnapshotCache(path.resolve(repo));
  try {
    const results: Map<string, Buffer>[] = [];
    for (const objectIds of batches) results.push(await snapshots.readBlobs(objectIds));
    return Object.freeze(results);
  } finally {
    await snapshots.dispose();
  }
}
