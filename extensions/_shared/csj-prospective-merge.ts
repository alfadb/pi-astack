/**
 * CSJ C4/C5 — prospective two-parent merge, cert, single CAS, same-barrier T2 recover.
 */

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  canonicalRefMovePrimitive,
  installCsjWitnessMintCapability,
  type CsjEligibilityWitness,
  type CsjWitnessMintFn,
} from "./canonical-ref-move";
import { assertCanonicalMutationAuthorized } from "./canonical-mutation-authority";
import { assertCanonicalMutationBarrierHeld } from "./canonical-mutation-barrier";
import {
  recoverDrainSlotV3,
  type DrainRecoveryAction,
} from "./convergence-recovery";
import {
  evaluateCsjEligibility,
  recheckCsjBindFreeze,
  type CsjEligibilityContext,
  type CsjFreezeBind,
  CsjEligibilityError,
} from "./csj-eligibility";
import { adaptCsjClosedReason, type CsjClosedReason, type CsjClosedSurface } from "./csj-closed-reason";
import {
  assertCsjArtifactBindingExactMatch,
  CSJ_ARTIFACT_RECEIPT_SCHEMA,
  readCsjCloneGreenReceipt,
  defaultCsjReceiptStateHome,
  type CsjCloneGreenReceipt,
} from "./csj-artifact-binding";
import {
  fullIndexFingerprint,
  isAncestor,
  snapshotIndexEntries,
  verifyCandidateShape,
} from "./git-exact-cohort";
import { durableAtomicWriteFile } from "./durable-write";
import { sha256Hex } from "./jcs";
import {
  certifyProspectiveRecoveryJoin,
  sortCodeUnits,
  type AcceptedV3Candidate,
} from "./recovery-history-classifier";
// statusSnapshot loaded lazily inside Cert.F to avoid runtime↔csj static cycles

const execFileAsync = promisify(execFile);
const CSJ_SPEC_VERSION = "csj-final-r6";
const CSJ_COMMIT_MESSAGE = "abrain: recover stale v3 semantic join";

/** One-shot module-private mint capability — not re-exported for arbitrary modules. */
const mintCertifiedCsjWitness: CsjWitnessMintFn = installCsjWitnessMintCapability(
  Symbol.for("pi-astack/csj-witness-mint-install-nonce"),
);
const DRAIN_IDENTITY = Object.freeze({
  name: "pi-astack-local-drain",
  email: "local-drain@pi-astack.invalid",
});

export class CsjError extends Error {
  readonly code: string;
  readonly closedReason: CsjClosedReason;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, closedReason: CsjClosedReason, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CsjError";
    this.code = code;
    this.closedReason = closedReason;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface CsjDiffRow {
  readonly path: string;
  readonly status: string;
  readonly dstMode: string;
  readonly dstOid: string;
}

export interface CsjMergeBuildResult {
  readonly treeM: string;
  readonly mergeCommit: string;
  readonly head: string;
  readonly candidate: string;
  readonly base: string;
}

export interface CsjJournalRecord {
  readonly schema: "pi-astack/csj-journal/v1";
  readonly phase: string;
  readonly head_expected?: string;
  readonly candidate?: string;
  readonly base?: string;
  readonly episode_id_hash?: string;
  readonly treeM?: string;
  readonly M?: string;
  readonly head_after?: string;
  readonly cas_ok?: boolean;
  readonly published?: boolean;
  readonly converged?: boolean;
  readonly reason_code?: string;
}

export interface CsjRunResult {
  readonly status: "joined" | "recover_only" | "ineligible" | "failed";
  readonly mergeCommit?: string;
  readonly head?: string;
  readonly recoverAction?: DrainRecoveryAction;
  readonly closed: CsjClosedSurface;
  readonly journalPhase?: string;
}

async function gitText(repo: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      ...extraEnv,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return String(stdout);
}

async function gitBuffer(repo: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    encoding: "buffer",
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout as Buffer;
}

export function parseDiffTreeZ(raw: Buffer | string): CsjDiffRow[] {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const rows: CsjDiffRow[] = [];
  // git diff-tree -r -z --no-renames format: :srcMode dstMode srcOid dstOid status\0path\0
  const parts = text.split("\0").filter((part, index, arr) => part.length > 0 || index < arr.length - 1);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const relPath = parts[i + 1]!;
    if (!meta.startsWith(":")) continue;
    const fields = meta.slice(1).split(/\s+/);
    if (fields.length < 5) continue;
    const status = fields[4]!;
    rows.push(Object.freeze({
      path: relPath,
      status: status[0]!,
      dstMode: fields[1]!,
      dstOid: fields[3]!,
    }));
  }
  return rows;
}

export async function buildProspectiveCsjMerge(ctx: CsjEligibilityContext): Promise<CsjMergeBuildResult> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-astack-csj-"));
  const tmpIndex = path.join(tmpDir, "index");
  try {
    await gitText(ctx.repo, ["read-tree", ctx.head], { GIT_INDEX_FILE: tmpIndex });
    for (const entry of ctx.entries) {
      await gitText(ctx.repo, ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.blobOid},${entry.path}`], {
        GIT_INDEX_FILE: tmpIndex,
      });
    }
    const treeM = (await gitText(ctx.repo, ["write-tree"], { GIT_INDEX_FILE: tmpIndex })).trim();
    const parentEpochText = (await gitText(ctx.repo, ["show", "-s", "--format=%ct", ctx.head])).trim();
    const parentEpoch = /^\d+$/.test(parentEpochText) ? parentEpochText : "0";
    const stableDate = `${parentEpoch} +0000`;
    const mergeCommit = (await gitText(
      ctx.repo,
      ["commit-tree", treeM, "-p", ctx.head, "-p", ctx.candidate, "-m", CSJ_COMMIT_MESSAGE],
      {
        GIT_AUTHOR_NAME: DRAIN_IDENTITY.name,
        GIT_AUTHOR_EMAIL: DRAIN_IDENTITY.email,
        GIT_AUTHOR_DATE: stableDate,
        GIT_COMMITTER_NAME: DRAIN_IDENTITY.name,
        GIT_COMMITTER_EMAIL: DRAIN_IDENTITY.email,
        GIT_COMMITTER_DATE: stableDate,
      },
    )).trim();
    return Object.freeze({
      treeM,
      mergeCommit,
      head: ctx.head,
      candidate: ctx.candidate,
      base: ctx.base,
    });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function certifyDiffHeadToMerge(repo: string, head: string, merge: string, entries: CsjEligibilityContext["entries"]): Promise<void> {
  const raw = await gitBuffer(repo, ["diff-tree", "-r", "-z", "--no-renames", head, merge]);
  const rows = parseDiffTreeZ(raw);
  if (rows.length !== entries.length) {
    throw new CsjError("CSJ_CERT_A", "cert_failed", "Cert.A |diff| != |entries|", { diff: rows.length, entries: entries.length });
  }
  const byPath = new Map(rows.map((row) => [row.path, row]));
  for (const entry of entries) {
    const row = byPath.get(entry.path);
    if (!row || (row.status !== "A" && row.status !== "M") || row.dstMode !== entry.mode || row.dstOid !== entry.blobOid) {
      throw new CsjError("CSJ_CERT_A", "cert_failed", "Cert.A cohort row mismatch", { path: entry.path, row });
    }
  }
}

export async function certifyDiffCandidateToMerge(
  repo: string,
  candidate: string,
  merge: string,
  base: string,
  head: string,
  cohortPaths: ReadonlySet<string>,
): Promise<void> {
  const dCm = parseDiffTreeZ(await gitBuffer(repo, ["diff-tree", "-r", "-z", "--no-renames", candidate, merge]));
  const dBh = parseDiffTreeZ(await gitBuffer(repo, ["diff-tree", "-r", "-z", "--no-renames", base, head]));
  for (const row of dCm) {
    if (cohortPaths.has(row.path)) {
      throw new CsjError("CSJ_CERT_B", "cert_failed", "Cert.B cohort path present in candidate→M diff", { path: row.path });
    }
  }
  const noncohortCm = dCm.filter((row) => !cohortPaths.has(row.path));
  const noncohortBh = dBh.filter((row) => !cohortPaths.has(row.path));
  const key = (row: CsjDiffRow) => `${row.path}\0${row.status}\0${row.dstMode}\0${row.dstOid}`;
  const left = noncohortCm.map(key).sort();
  const right = noncohortBh.map(key).sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new CsjError("CSJ_CERT_B", "cert_failed", "Cert.B noncohort multiset mismatch");
  }
}

async function certifyObjects(repo: string, merge: string, entries: CsjEligibilityContext["entries"]): Promise<void> {
  try {
    await gitText(repo, ["cat-file", "-e", merge]);
    const type = (await gitText(repo, ["cat-file", "-t", merge])).trim();
    if (type !== "commit") throw new Error("not commit");
  } catch {
    throw new CsjError("CSJ_OBJECT_MISSING", "object_missing", "merge commit missing before CAS");
  }
  for (const entry of entries) {
    try {
      await gitText(repo, ["cat-file", "-e", entry.blobOid]);
      const type = (await gitText(repo, ["cat-file", "-t", entry.blobOid])).trim();
      if (type !== "blob") throw new Error("not blob");
    } catch {
      throw new CsjError("CSJ_OBJECT_MISSING", "object_missing", "cohort blob missing before CAS", { path: entry.path });
    }
  }
}

export function csjJournalPath(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "csj-journal", "v1", "journal.json");
}

export async function writeCsjJournal(abrainHome: string, record: CsjJournalRecord): Promise<void> {
  const filePath = csjJournalPath(abrainHome);
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await durableAtomicWriteFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

export async function readCsjJournal(abrainHome: string): Promise<CsjJournalRecord | null> {
  try {
    const raw = await fsp.readFile(csjJournalPath(abrainHome), "utf8");
    const parsed = JSON.parse(raw) as CsjJournalRecord;
    if (parsed?.schema !== "pi-astack/csj-journal/v1") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Full CSJ frame body — must already be inside
 * withCanonicalMutationAuthority ∘ withCanonicalMutationBarrierInSingleFlight.
 */
export interface CsjInitialFreeze {
  readonly head: string;
  readonly statusHash: string;
  readonly noncohortIndexFingerprint: string;
  readonly freezeBind: CsjFreezeBind | null;
  readonly worktreeFreeze: ReadonlyArray<{ path: string; mode: "100644"; bytesSha256: string; blobOid: string }>;
  readonly frozenIndexSnapshot: ReadonlyMap<string, string>;
  readonly candidate: string;
  readonly base: string;
  readonly cohortManifestRoot: string;
  readonly historyHead: string;
  readonly historyStatus: string;
}

/** Post-cert only: brand-registered via module-private capability; plain forgeries fail. */
function mintCsjWitness(input: {
  episodeId: string;
  candidate: string;
  headExpected: string;
  mergeCommit: string;
}): CsjEligibilityWitness {
  const token = sha256Hex(Buffer.concat([
    randomBytes(32),
    Buffer.from(`${input.episodeId}\0${input.candidate}\0${input.headExpected}\0${input.mergeCommit}`, "utf8"),
  ]));
  return mintCertifiedCsjWitness(Object.freeze({
    token,
    episodeId: input.episodeId,
    candidate: input.candidate,
    headExpected: input.headExpected,
    mergeCommit: input.mergeCommit,
    certified: true as const,
  }));
}

export interface CsjTestHooks {
  /** After merge build, before Cert.A–D. Test-only (PI_ASTACK_ENABLE_TEST_HOOKS=1). */
  afterMergeBuild?: () => void | Promise<void>;
  /** After Cert.F succeeds, immediately before CAS. Test-only. */
  beforeCas?: () => void | Promise<void>;
  /** After successful CAS, before T2 recover. Test-only. */
  afterCasBeforeRecover?: () => void | Promise<void>;
}

function assertCsjTestHooksAllowed(hooks: CsjTestHooks | undefined): void {
  if (!hooks) return;
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new CsjError(
      "CSJ_TEST_HOOKS_FORBIDDEN",
      "internal_error",
      "csj testHooks require PI_ASTACK_ENABLE_TEST_HOOKS=1",
    );
  }
}

export async function runCsjInBarrier(options: {
  abrainHome: string;
  repo: string;
  refName: string;
  /**
   * Production: artifact binding is REQUIRED (receipt or explicit binding).
   * Synthetic tests may set requireArtifactBinding=false.
   */
  requireArtifactBinding?: boolean;
  /** Explicit binding (clone-green). When absent, receipt is loaded from receiptStateHome. */
  artifactBinding?: {
    executionArtifactDigest: string;
    implementationFingerprint: string;
    validatorFingerprint: string;
    registryHash: string;
  };
  /** Independent private state home for clone-green receipt (not L1). */
  receiptStateHome?: string;
  sourceRoot?: string;
  daemonBinaryPath?: string;
  daemonBinarySha256?: string;
  piExecutableVersion?: string;
  implementationFingerprint?: string;
  validatorFingerprint?: string;
  registryHash?: string;
  /**
   * Test-only injectable hooks. Production never sets this.
   * Dual-gated: options present + PI_ASTACK_ENABLE_TEST_HOOKS=1.
   */
  testHooks?: CsjTestHooks;
}): Promise<CsjRunResult> {
  assertCsjTestHooksAllowed(options.testHooks);
  const abrainHome = path.resolve(options.abrainHome);
  const repo = path.resolve(options.repo);
  const refName = options.refName;

  try {
    assertCanonicalMutationBarrierHeld(repo);
    await assertCanonicalMutationAuthorized(abrainHome);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "CSJ_AUTHORITY";
    const closedReason: CsjClosedReason = code.includes("LOCK") ? "barrier_not_held" : "authority_revoked";
    return { status: "failed", closed: adaptCsjClosedReason({ reason: closedReason, code }) };
  }

  let ctx: CsjEligibilityContext;
  try {
    const evaluated = await evaluateCsjEligibility({ abrainHome, repo, refName });
    ctx = evaluated.context;
  } catch (error) {
    if (error instanceof CsjEligibilityError) {
      // Spec §8.4: any CsjEligibility clause false → eligible_false (incl. E24 worktree preimage).
      // Only index/fingerprint clauses E26/E27 map to index_or_fingerprint_failed.
      const reason: CsjClosedReason =
        error.clause === "E1" ? "open_not_unique"
          : error.clause === "E3" ? "published_nonzero"
            : error.clause === "E6" ? "antichain_false"
              : error.clause === "E14" ? "bind_intent_mismatch"
                : error.clause === "E26" || error.clause === "E27" ? "index_or_fingerprint_failed"
                  : "eligible_false";
      return {
        status: "ineligible",
        closed: adaptCsjClosedReason({ reason, code: error.code, flags: { eligibility_false: true } }),
      };
    }
    return { status: "failed", closed: adaptCsjClosedReason({ reason: "internal_error", code: "CSJ_ELIGIBILITY" }) };
  }

  // Capture initial freeze BEFORE any journal/diagnostic mutation (Cert.F bind).
  const initialFreeze: CsjInitialFreeze = Object.freeze({
    head: ctx.head,
    statusHash: ctx.statusHash,
    noncohortIndexFingerprint: ctx.noncohortIndexFingerprint,
    freezeBind: ctx.freezeBind,
    worktreeFreeze: ctx.worktreeFreeze,
    frozenIndexSnapshot: ctx.frozenIndexSnapshot,
    candidate: ctx.candidate,
    base: ctx.base,
    cohortManifestRoot: ctx.prepared.cohortManifestRoot,
    historyHead: ctx.history.head,
    historyStatus: ctx.history.status,
  });

  // NoSecondCsjCAS: if candidate already ancestor, recover only
  if (await isAncestor(repo, ctx.candidate, ctx.head)) {
    const action = await recoverDrainSlotV3({
      abrainHome,
      repo,
      operation: ctx.operation,
      slot: ctx.episode.pendingSlot!,
    });
    return {
      status: "recover_only",
      head: ctx.head,
      recoverAction: action,
      closed: adaptCsjClosedReason({ reason: "none" }),
    };
  }

  await writeCsjJournal(abrainHome, {
    schema: "pi-astack/csj-journal/v1",
    phase: "pre_merge_build",
    head_expected: ctx.head,
    candidate: ctx.candidate,
    base: ctx.base,
    episode_id_hash: sha256Hex(ctx.episode.episodeId),
  });

  const built = await buildProspectiveCsjMerge(ctx);
  const cohortSet = new Set(ctx.entries.map((entry) => entry.path));
  if (options.testHooks?.afterMergeBuild) await options.testHooks.afterMergeBuild();

  const runCertsABCD = async (): Promise<void> => {
    await certifyDiffHeadToMerge(repo, ctx.head, built.mergeCommit, ctx.entries);
    await certifyDiffCandidateToMerge(repo, ctx.candidate, built.mergeCommit, ctx.base, ctx.head, cohortSet);
    await certifyObjects(repo, built.mergeCommit, ctx.entries);
    if (!ctx.history.v3 || ctx.history.v2.status !== "accepted" || ctx.history.v3.status !== "accepted") {
      throw new CsjError("CSJ_CERT_C", "cert_failed", "accepted history required for Cert.C");
    }
    // Cert.C — tip=M reclassify v2→v3 + explicit join (wrapper enforces)
    await certifyProspectiveRecoveryJoin({
      repo,
      scan: ctx.scan,
      head: built.mergeCommit,
      episodeId: ctx.episode.episodeId,
      slot: ctx.episode.pendingSlot!,
      labels: sortCodeUnits([ctx.head, ctx.candidate]),
      expectedMerge: built.mergeCommit,
      acceptedV2: ctx.history.v2,
      acceptedV3: ctx.history.v3,
    });
    // Cert.C2 complete residual pairs
    const complete: readonly AcceptedV3Candidate[] = ctx.history.v3.candidates;
    for (const k of complete) {
      const candK = k.candidate;
      const cAncK = await isAncestor(repo, ctx.candidate, candK);
      const kAncC = await isAncestor(repo, candK, ctx.candidate);
      if (cAncK || kAncC) continue;
      await certifyProspectiveRecoveryJoin({
        repo,
        scan: ctx.scan,
        head: built.mergeCommit,
        episodeId: `${ctx.episode.episodeId}+${k.episodeId}`,
        slot: Math.max(ctx.episode.pendingSlot!, k.slot),
        labels: sortCodeUnits([ctx.candidate, candK]),
        expectedMerge: built.mergeCommit,
        acceptedV2: ctx.history.v2,
        acceptedV3: ctx.history.v3,
      });
    }
  };

  try {
    await runCertsABCD();
  } catch (error) {
    const closedReason: CsjClosedReason = error instanceof CsjError ? error.closedReason : "cert_failed";
    await writeCsjJournal(abrainHome, {
      schema: "pi-astack/csj-journal/v1",
      phase: "failed_cert",
      head_expected: ctx.head,
      candidate: ctx.candidate,
      base: ctx.base,
      M: built.mergeCommit,
      reason_code: closedReason,
    }).catch(() => undefined);
    return {
      status: "failed",
      mergeCommit: built.mergeCommit,
      closed: adaptCsjClosedReason({
        reason: closedReason,
        code: error instanceof CsjError ? error.code : error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "CSJ_CERT",
      }),
    };
  }

  // Cert.F full recheck — bind to INITIAL freeze (not a re-minted freeze)
  let csjWitness: CsjEligibilityWitness;
  try {
    assertCanonicalMutationBarrierHeld(repo);
    await assertCanonicalMutationAuthorized(abrainHome);
    const headNow = (await gitText(repo, ["rev-parse", "--verify", `${refName}^{commit}`])).trim();
    if (headNow !== initialFreeze.head) throw new CsjError("CSJ_CAS_RACE", "cas_race", "HEAD drifted before CAS");

    // Full eligibility recheck; then compare against INITIAL freeze fields.
    const re = await evaluateCsjEligibility({
      abrainHome,
      repo,
      refName,
      episode: ctx.episode,
    });
    if (re.context.candidate !== initialFreeze.candidate || re.context.head !== initialFreeze.head) {
      throw new CsjError("CSJ_CERT_F", "cert_f_failed", "eligibility recheck drift vs initial freeze");
    }
    if (re.context.base !== initialFreeze.base || re.context.prepared.cohortManifestRoot !== initialFreeze.cohortManifestRoot) {
      throw new CsjError("CSJ_CERT_F", "cert_f_failed", "prepared operation drift vs initial freeze");
    }
    // Bind freeze identity must match initial freeze (itemId/path/bytes).
    if (Boolean(re.context.freezeBind) !== Boolean(initialFreeze.freezeBind)) {
      throw new CsjError("CSJ_CERT_F", "bind_intent_mismatch", "bind freeze presence drifted");
    }
    if (initialFreeze.freezeBind) {
      await recheckCsjBindFreeze(abrainHome, initialFreeze.freezeBind);
      const live = re.context.freezeBind!;
      if (
        live.itemId !== initialFreeze.freezeBind.itemId
        || live.path !== initialFreeze.freezeBind.path
        || live.blobBytes !== initialFreeze.freezeBind.blobBytes
        || live.blobBytesSha256 !== initialFreeze.freezeBind.blobBytesSha256
      ) {
        throw new CsjError("CSJ_CERT_F", "bind_intent_mismatch", "bind freeze drifted from initial");
      }
    }

    if (!await verifyCandidateShape(repo, ctx.candidate, { frozenCommit: ctx.base, newTree: ctx.prepared.newTree })) {
      throw new CsjError("CSJ_SHAPE", "shape_or_operation_failed", "shape recheck failed");
    }

    // E26: null current does NOT unconditionally pass — must ∈ {frozen, target}.
    const currentIndex = await snapshotIndexEntries(repo, ctx.entries.map((e) => e.path));
    for (const entry of ctx.entries) {
      const frozen = initialFreeze.frozenIndexSnapshot.get(entry.path) ?? null;
      const current = currentIndex.get(entry.path) ?? null;
      const target = `${entry.mode} ${entry.blobOid} 0`;
      if (current !== frozen && current !== target) {
        throw new CsjError("CSJ_INDEX", "index_or_fingerprint_failed", "index recheck failed", { path: entry.path });
      }
    }
    const noncohort = await fullIndexFingerprint(repo, cohortSet);
    if (noncohort !== initialFreeze.noncohortIndexFingerprint) {
      throw new CsjError("CSJ_FINGERPRINT", "index_or_fingerprint_failed", "noncohort index fingerprint drifted from initial freeze");
    }
    // Cert.F / E27: statusSnapshot.hash must equal initial freeze.
    // journal/.state is gitignored so diagnostic journal writes must not drift statusHash;
    // any real drift (non-ignored dirty) is fail-closed (no CAS).
    if (!re.context.statusHash) {
      throw new CsjError("CSJ_STATUS_HASH", "index_or_fingerprint_failed", "statusHash missing on recheck");
    }
    if (re.context.statusHash !== initialFreeze.statusHash) {
      throw new CsjError(
        "CSJ_STATUS_HASH",
        "index_or_fingerprint_failed",
        "statusHash drifted from initial freeze",
      );
    }
    // Worktree freeze bytes must still match initial freeze.
    for (const row of initialFreeze.worktreeFreeze) {
      const live = re.context.worktreeFreeze.find((w) => w.path === row.path);
      if (!live || live.bytesSha256 !== row.bytesSha256 || live.blobOid !== row.blobOid) {
        throw new CsjError("CSJ_CERT_F", "cert_f_failed", "worktree freeze drifted");
      }
    }

    // Re-run Cert.A/B/C/C2/D immediately before CAS.
    await runCertsABCD();

    // Artifact binding: default REQUIRED. No receipt ⇒ no CAS. Live digest always
    // recomputed against a real clone-green receipt (never optional live self-compare).
    // Synthetic tests may set requireArtifactBinding:false.
    const effectiveRequire = options.requireArtifactBinding ?? true;
    if (effectiveRequire) {
      const receiptHome = options.receiptStateHome ?? defaultCsjReceiptStateHome();
      let receipt: CsjCloneGreenReceipt | null = await readCsjCloneGreenReceipt(receiptHome);
      // Explicit binding only accepted when it is a full green receipt (schema+matrix),
      // not a bare digest/fingerprint tuple that could be live self-compare.
      if (!receipt && options.artifactBinding) {
        const candidate = options.artifactBinding as Partial<CsjCloneGreenReceipt> & Record<string, unknown>;
        if (
          candidate.schema === CSJ_ARTIFACT_RECEIPT_SCHEMA
          && candidate.matrix_status === "green"
          && typeof candidate.executionArtifactDigest === "string"
          && typeof candidate.implementationFingerprint === "string"
          && typeof candidate.validatorFingerprint === "string"
          && typeof candidate.registryHash === "string"
          && candidate.parts
          && typeof candidate.parts === "object"
        ) {
          receipt = candidate as CsjCloneGreenReceipt;
        }
      }
      if (!receipt) {
        throw new CsjError("CSJ_ARTIFACT_MISMATCH", "artifact_mismatch", "missing clone-green receipt; refuse CAS without receipt");
      }
      if (!options.implementationFingerprint || !options.validatorFingerprint || !options.registryHash) {
        throw new CsjError("CSJ_ARTIFACT_MISMATCH", "artifact_mismatch", "live fingerprints required for artifact binding");
      }
      const sourceRoot = options.sourceRoot;
      if (!sourceRoot) {
        throw new CsjError("CSJ_ARTIFACT_MISMATCH", "artifact_mismatch", "sourceRoot required for artifact binding");
      }
      try {
        await assertCsjArtifactBindingExactMatch({
          sourceRoot,
          receipt,
          implementationFingerprint: options.implementationFingerprint,
          validatorFingerprint: options.validatorFingerprint,
          registryHash: options.registryHash,
          daemonBinaryPath: options.daemonBinaryPath,
          daemonBinarySha256: options.daemonBinarySha256,
          piExecutableVersion: options.piExecutableVersion,
        });
      } catch (error) {
        if (error instanceof CsjError) throw error;
        throw new CsjError(
          "CSJ_ARTIFACT_MISMATCH",
          "artifact_mismatch",
          error instanceof Error ? error.message : "artifact binding mismatch",
        );
      }
    }

    csjWitness = mintCsjWitness({
      episodeId: ctx.episode.episodeId,
      candidate: ctx.candidate,
      headExpected: ctx.head,
      mergeCommit: built.mergeCommit,
    });
  } catch (error) {
    const closedReason: CsjClosedReason = error instanceof CsjError ? error.closedReason : "cert_f_failed";
    await writeCsjJournal(abrainHome, {
      schema: "pi-astack/csj-journal/v1",
      phase: "failed_cert_f",
      head_expected: ctx.head,
      M: built.mergeCommit,
      reason_code: closedReason,
    }).catch(() => undefined);
    return {
      status: "failed",
      mergeCommit: built.mergeCommit,
      closed: adaptCsjClosedReason({
        reason: closedReason,
        code: error instanceof CsjError ? error.code : "CSJ_CERT_F",
      }),
    };
  }

  await writeCsjJournal(abrainHome, {
    schema: "pi-astack/csj-journal/v1",
    phase: "pre_cas",
    head_expected: ctx.head,
    candidate: ctx.candidate,
    base: ctx.base,
    episode_id_hash: sha256Hex(ctx.episode.episodeId),
    treeM: built.treeM,
    M: built.mergeCommit,
  });

  // T1 — single CSJ merge CAS (purpose=csj_v1 + full eligibility witness)
  try {
    if (options.testHooks?.beforeCas) await options.testHooks.beforeCas();
    await canonicalRefMovePrimitive({
      repo,
      abrainHome,
      refName,
      newTip: built.mergeCommit,
      expectedTip: ctx.head,
      purpose: "csj_v1",
      expectedEpisodeId: ctx.episode.episodeId,
      // No historyAcceptedHead: all purposes always reclassify pre-CAS.
      skipOpenGate: false,
      csjWitness,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "CSJ_CAS";
    const codeUpper = code.toUpperCase();
    const closedReason: CsjClosedReason =
      codeUpper.includes("PURPOSE") || codeUpper.includes("WITNESS") ? "purpose_invalid"
        : codeUpper.includes("AUTHORIZED") || codeUpper.includes("AUTHORITY") ? "authority_revoked"
          : codeUpper.includes("LOCK") ? "barrier_not_held"
            : codeUpper.includes("ARTIFACT") ? "artifact_mismatch"
              : "cas_race";
    await writeCsjJournal(abrainHome, {
      schema: "pi-astack/csj-journal/v1",
      phase: "failed_cas",
      head_expected: ctx.head,
      M: built.mergeCommit,
      cas_ok: false,
      reason_code: closedReason,
    }).catch(() => undefined);
    return {
      status: "failed",
      mergeCommit: built.mergeCommit,
      closed: adaptCsjClosedReason({ reason: closedReason, code }),
    };
  }

  const headAfter = (await gitText(repo, ["rev-parse", "--verify", `${refName}^{commit}`])).trim();
  await writeCsjJournal(abrainHome, {
    schema: "pi-astack/csj-journal/v1",
    phase: "post_cas",
    head_expected: ctx.head,
    head_after: headAfter,
    M: built.mergeCommit,
    cas_ok: true,
    candidate: ctx.candidate,
  });

  // T2 — same barrier immediate recoverDrainSlotV3 (ancestry branch; no candidate CAS)
  try {
    if (options.testHooks?.afterCasBeforeRecover) await options.testHooks.afterCasBeforeRecover();
    const action = await recoverDrainSlotV3({
      abrainHome,
      repo,
      operation: ctx.operation,
      slot: ctx.episode.pendingSlot!,
    });
    await writeCsjJournal(abrainHome, {
      schema: "pi-astack/csj-journal/v1",
      phase: action === "index_converged" || action === "already_complete" ? "post_converged" : "post_published",
      head_after: headAfter,
      M: built.mergeCommit,
      cas_ok: true,
      published: true,
      converged: action === "index_converged" || action === "already_complete",
    });
    return {
      status: "joined",
      mergeCommit: built.mergeCommit,
      head: headAfter,
      recoverAction: action,
      closed: adaptCsjClosedReason({ reason: "none" }),
      journalPhase: "post_converged",
    };
  } catch (error) {
    await writeCsjJournal(abrainHome, {
      schema: "pi-astack/csj-journal/v1",
      phase: "failed_post_cas_recover",
      head_after: headAfter,
      M: built.mergeCommit,
      cas_ok: true,
      reason_code: "post_cas_recover_failed",
    }).catch(() => undefined);
    return {
      status: "failed",
      mergeCommit: built.mergeCommit,
      head: headAfter,
      closed: adaptCsjClosedReason({
        reason: "post_cas_recover_failed",
        code: error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "CSJ_POST_CAS_RECOVER",
        flags: { cas_succeeded: true },
      }),
      journalPhase: "failed_post_cas_recover",
    };
  }
}

export function csjSpecVersion(): string {
  return CSJ_SPEC_VERSION;
}

/**
 * NextKick decision helper (spec §7.5). Order is fixed:
 * 1) AncOpen ∧ budget exhausted → ownerAlert blocked
 * 2) AncOpen ∧ ¬exhausted → bounded T2 only
 * 3) Deadlock ∧ eligible → CSJ
 * 4) Published non-ancestor → blocked owner
 * 5) else existing
 */
export type CsjNextKickDecision =
  | { action: "owner_alert_blocked"; reason: "t2_budget_exhausted" }
  | { action: "bounded_t2_recover" }
  | { action: "run_csj" }
  | { action: "published_nonancestor_blocked" }
  | { action: "existing" };

export function decideCsjNextKick(input: {
  candidateIsAncestorOfHead: boolean;
  openPrepared: boolean;
  t2BudgetExhausted: boolean;
  published: boolean;
  deadlockEligible: boolean;
}): CsjNextKickDecision {
  const ancOpen = input.candidateIsAncestorOfHead && input.openPrepared;
  if (ancOpen && input.t2BudgetExhausted) return { action: "owner_alert_blocked", reason: "t2_budget_exhausted" };
  if (ancOpen && !input.t2BudgetExhausted) return { action: "bounded_t2_recover" };
  if (input.deadlockEligible && !input.candidateIsAncestorOfHead && !input.published) return { action: "run_csj" };
  if (input.published && !input.candidateIsAncestorOfHead) return { action: "published_nonancestor_blocked" };
  return { action: "existing" };
}
