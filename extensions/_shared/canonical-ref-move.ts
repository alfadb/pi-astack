/**
 * Unified CanonicalRefMovePrimitive (CSJ final spec §3 / C1).
 * All symbolic-ref CAS for canonical path must pass through this primitive.
 * purpose is required with no default.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { assertCanonicalMutationAuthorized } from "./canonical-mutation-authority";
import { assertCanonicalMutationBarrierHeld } from "./canonical-mutation-barrier";
// Open-gate dependencies are loaded lazily to avoid a static cycle:
// git-exact-cohort → canonical-ref-move → convergence-recovery → git-exact-cohort

const execFileAsync = promisify(execFile);

export const REF_MOVE_PURPOSES = Object.freeze([
  "exact_cohort_publish",
  "recover_v3",
  "csj_v1",
  "device_join",
  "migrate",
] as const);

export type RefMovePurpose = (typeof REF_MOVE_PURPOSES)[number];

const PURPOSE_SET = new Set<string>(REF_MOVE_PURPOSES);
const OPEN_ALLOWED = new Set<RefMovePurpose>(["recover_v3", "csj_v1"]);

export class CanonicalRefMoveError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CanonicalRefMoveError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

/**
 * Module-private brand + process-local registry shared with csj-prospective-merge
 * via Symbol.for (mint is private to CSJ post-cert; plain object forgeries fail).
 */
const CSJ_WITNESS_BRAND = Symbol.for("pi-astack/csj-witness-brand");
const CSJ_WITNESS_REGISTRY_KEY = Symbol.for("pi-astack/csj-witness-registry");

function csjWitnessRegistry(): WeakSet<object> {
  const g = globalThis as typeof globalThis & { [CSJ_WITNESS_REGISTRY_KEY]?: WeakSet<object> };
  if (!g[CSJ_WITNESS_REGISTRY_KEY]) g[CSJ_WITNESS_REGISTRY_KEY] = new WeakSet<object>();
  return g[CSJ_WITNESS_REGISTRY_KEY]!;
}

export interface CsjEligibilityWitness {
  /** Unforgeable per-frame token minted only after Cert.A–F succeed. */
  readonly token: string;
  readonly episodeId: string;
  readonly candidate: string;
  readonly headExpected: string;
  readonly mergeCommit: string;
  readonly certified: true;
}

/**
 * Module-private mint channel. Only csj-prospective-merge may obtain a registrar
 * via installCsjWitnessMintCapability; arbitrary modules cannot forge witnesses
 * by calling a public register API.
 *
 * Capability slot lives on globalThis so pi's per-extension jiti loaders
 * (moduleCache:false → separate nested module instances of this file and of
 * csj-prospective-merge) share one mint of the correct version. Legitimate
 * reloads are idempotent; version/shape conflicts fail closed. Plain object
 * forgeries still never enter the registry without the mint fn.
 */
const CSJ_WITNESS_MINT_INSTALL_NONCE = Symbol.for("pi-astack/csj-witness-mint-install-nonce");
const CSJ_WITNESS_MINT_CAPABILITY_KEY = Symbol.for("pi-astack/csj-witness-mint-capability/v1");
const CSJ_WITNESS_MINT_CAPABILITY_VERSION = 1;
const CSJ_WITNESS_MINT_CAPABILITY_SHAPE = "register_branded_weakset_v1";

export type CsjWitnessMintFn = (witness: CsjEligibilityWitness) => CsjEligibilityWitness;

interface CsjWitnessMintCapabilitySlot {
  readonly version: number;
  readonly shape: string;
  readonly mint: CsjWitnessMintFn;
}

function registerCsjEligibilityWitnessInternal(witness: CsjEligibilityWitness): CsjEligibilityWitness {
  if (typeof witness.token !== "string" || witness.token.length < 32 || witness.certified !== true) {
    throw new CanonicalRefMoveError("REF_MOVE_CSJ_WITNESS_REQUIRED", "csj witness token invalid");
  }
  const branded = Object.freeze({
    ...witness,
    [CSJ_WITNESS_BRAND]: true as const,
  });
  csjWitnessRegistry().add(branded);
  return branded;
}

function isCompatibleCsjWitnessMintSlot(value: unknown): value is CsjWitnessMintCapabilitySlot {
  if (!value || typeof value !== "object") return false;
  const slot = value as Partial<CsjWitnessMintCapabilitySlot>;
  return slot.version === CSJ_WITNESS_MINT_CAPABILITY_VERSION
    && slot.shape === CSJ_WITNESS_MINT_CAPABILITY_SHAPE
    && typeof slot.mint === "function";
}

/**
 * Capability install for csj-prospective-merge only.
 * Requires the process-wide install nonce (Symbol.for); returns a sealed mint
 * function shared process-wide. Same-version reloads (jiti dual instances of
 * memory + sediment) are idempotent and return the shared mint. Incompatible
 * version/shape already installed → fail closed. Plain object forgeries never
 * enter the registry without this capability; episode binding of minted
 * witnesses is unchanged.
 */
export function installCsjWitnessMintCapability(installNonce: symbol): CsjWitnessMintFn {
  if (installNonce !== CSJ_WITNESS_MINT_INSTALL_NONCE) {
    throw new CanonicalRefMoveError(
      "REF_MOVE_CSJ_WITNESS_CAPABILITY",
      "csj witness mint capability install nonce invalid",
    );
  }
  const g = globalThis as typeof globalThis & {
    [CSJ_WITNESS_MINT_CAPABILITY_KEY]?: CsjWitnessMintCapabilitySlot | unknown;
  };
  const existing = g[CSJ_WITNESS_MINT_CAPABILITY_KEY];
  if (existing !== undefined) {
    if (!isCompatibleCsjWitnessMintSlot(existing)) {
      throw new CanonicalRefMoveError(
        "REF_MOVE_CSJ_WITNESS_CAPABILITY",
        "csj witness mint capability version/shape conflict",
        {
          expectedVersion: CSJ_WITNESS_MINT_CAPABILITY_VERSION,
          expectedShape: CSJ_WITNESS_MINT_CAPABILITY_SHAPE,
          existingVersion: existing && typeof existing === "object"
            ? (existing as { version?: unknown }).version
            : typeof existing,
          existingShape: existing && typeof existing === "object"
            ? (existing as { shape?: unknown }).shape
            : undefined,
        },
      );
    }
    return existing.mint;
  }
  const mint: CsjWitnessMintFn = (witness: CsjEligibilityWitness) =>
    registerCsjEligibilityWitnessInternal(witness);
  const slot: CsjWitnessMintCapabilitySlot = Object.freeze({
    version: CSJ_WITNESS_MINT_CAPABILITY_VERSION,
    shape: CSJ_WITNESS_MINT_CAPABILITY_SHAPE,
    mint,
  });
  g[CSJ_WITNESS_MINT_CAPABILITY_KEY] = slot;
  return mint;
}

function isAuthenticCsjWitness(value: unknown): value is CsjEligibilityWitness {
  return typeof value === "object"
    && value !== null
    && csjWitnessRegistry().has(value)
    && (value as CsjEligibilityWitness).certified === true
    && (value as { [k: symbol]: unknown })[CSJ_WITNESS_BRAND] === true;
}

export interface CanonicalRefMoveOptions {
  repo: string;
  abrainHome: string;
  refName: string;
  newTip: string;
  expectedTip: string;
  /** Explicit required purpose — no default. */
  purpose: RefMovePurpose;
  /**
   * Required when purpose is recover_v3 or csj_v1: must equal the unique open
   * episode id being resolved. Missing/mismatch refuse CAS.
   */
  expectedEpisodeId?: string;
  /**
   * Test-only. Never a production bypass — only accepted when
   * PI_ASTACK_ENABLE_TEST_HOOKS=1 (no dedicated production env flag).
   */
  skipOpenGate?: boolean;
  /**
   * Required for purpose=csj_v1: full eligibility token + certified unforgeable witness.
   * Missing/invalid witness ⇒ refuse CAS.
   */
  csjWitness?: CsjEligibilityWitness;
}

export interface CanonicalRefMoveResult {
  readonly status: "moved" | "already_at_tip";
  readonly previousTip: string;
  readonly currentTip: string;
  readonly purpose: RefMovePurpose;
}

function assertPurpose(purpose: unknown): asserts purpose is RefMovePurpose {
  if (typeof purpose !== "string" || !PURPOSE_SET.has(purpose)) {
    throw new CanonicalRefMoveError(
      "REF_MOVE_PURPOSE_INVALID",
      "CanonicalRefMovePrimitive requires an explicit closed-set purpose",
      { purpose: purpose === undefined ? "undefined" : String(purpose) },
    );
  }
}

async function gitText(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "--literal-pathspecs", ...args], {
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(stdout);
}

export async function evaluateOpenQuarantineGate(options: {
  repo: string;
  purpose: RefMovePurpose;
  expectedEpisodeId?: string;
}): Promise<{
  openCount: number;
  quarantineCount: number;
  openEpisodeIds: readonly string[];
  head: string;
}> {
  assertPurpose(options.purpose);
  const repo = path.resolve(options.repo);
  const head = (await gitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const { scanWholeL1Validated } = await import("./l1-schema-registry");
  const {
    recoverOpenRecoveryEpisodesFromScan,
    recoverOpenRecoveryEpisodesV3FromScan,
  } = await import("./convergence-recovery");
  const scan = await scanWholeL1Validated({ abrainHome: repo });
  const v2 = recoverOpenRecoveryEpisodesFromScan(scan);
  const v3 = recoverOpenRecoveryEpisodesV3FromScan(scan);
  const openEpisodeIds = Object.freeze([
    ...v2.open.map((cursor: { episodeId: string }) => cursor.episodeId),
    ...v3.open.map((cursor: { episodeId: string }) => cursor.episodeId),
  ].sort());
  const openCount = openEpisodeIds.length;
  const quarantineCount = v2.quarantined.length + v3.quarantined.length;

  // All purposes: real classifyRecoveryHistory before CAS (no historyAcceptedHead bypass).
  const { classifyRecoveryHistory } = await import("./recovery-history-classifier");
  const history = await classifyRecoveryHistory({ repo, scan, head });
  if (history.status !== "accepted" || history.quarantined.length > 0) {
    throw new CanonicalRefMoveError("REF_MOVE_HISTORY_NOT_ACCEPTED", "HistoryAccepted(HEAD) failed before ref move", {
      status: history.status,
      quarantine: history.quarantined.length,
    });
  }

  if (quarantineCount > 0 && !OPEN_ALLOWED.has(options.purpose)) {
    throw new CanonicalRefMoveError("REF_MOVE_QUARANTINE_BLOCKED", "ordinary ref move blocked while recovery is quarantined", {
      purpose: options.purpose,
      quarantineCount,
    });
  }

  // recover_v3 / csj_v1 always require expectedEpisodeId (even before open checks).
  if (OPEN_ALLOWED.has(options.purpose)) {
    if (typeof options.expectedEpisodeId !== "string" || !options.expectedEpisodeId) {
      throw new CanonicalRefMoveError(
        "REF_MOVE_EPISODE_REQUIRED",
        "recover_v3/csj_v1 require expectedEpisodeId matching the unique open episode",
        { purpose: options.purpose },
      );
    }
  }

  if (openCount > 0 || quarantineCount > 0) {
    if (!OPEN_ALLOWED.has(options.purpose)) {
      throw new CanonicalRefMoveError("REF_MOVE_OPEN_BLOCKED", "ordinary ref move blocked while open/quarantined recovery exists", {
        purpose: options.purpose,
        openCount,
        quarantineCount,
      });
    }
    if (openCount !== 1) {
      throw new CanonicalRefMoveError("REF_MOVE_OPEN_NOT_UNIQUE", "recover/csj ref move requires exactly one open episode", {
        purpose: options.purpose,
        openCount,
      });
    }
    if (options.expectedEpisodeId !== openEpisodeIds[0]) {
      throw new CanonicalRefMoveError("REF_MOVE_EPISODE_MISMATCH", "ref move resolver does not match the unique open episode", {
        purpose: options.purpose,
        expectedEpisodeId: options.expectedEpisodeId,
        openEpisodeId: openEpisodeIds[0],
      });
    }
  } else if (OPEN_ALLOWED.has(options.purpose)) {
    // Spec: recover_v3 and csj_v1 both require the unique open episode — no open → fail.
    throw new CanonicalRefMoveError(
      options.purpose === "csj_v1" ? "REF_MOVE_CSJ_NO_OPEN" : "REF_MOVE_RECOVER_NO_OPEN",
      `${options.purpose} requires the unique open prepared episode`,
      { purpose: options.purpose },
    );
  }

  return { openCount, quarantineCount, openEpisodeIds, head };
}

/**
 * Single CAS funnel for all canonical symbolic-ref moves.
 * purpose is required; missing/undefined is a hard error.
 */
export async function canonicalRefMovePrimitive(options: CanonicalRefMoveOptions): Promise<CanonicalRefMoveResult> {
  if (!options || typeof options !== "object") {
    throw new CanonicalRefMoveError("REF_MOVE_OPTIONS_INVALID", "CanonicalRefMovePrimitive options are required");
  }
  if (!("purpose" in options) || options.purpose === undefined) {
    throw new CanonicalRefMoveError("REF_MOVE_PURPOSE_INVALID", "purpose is required with no default");
  }
  assertPurpose(options.purpose);
  if (typeof options.abrainHome !== "string" || !options.abrainHome) {
    throw new CanonicalRefMoveError("REF_MOVE_ABRAIN_HOME_REQUIRED", "abrainHome is required for Authorized assert");
  }
  if (typeof options.repo !== "string" || !options.repo) {
    throw new CanonicalRefMoveError("REF_MOVE_REPO_REQUIRED", "repo is required");
  }
  if (typeof options.refName !== "string" || !/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(options.refName)) {
    throw new CanonicalRefMoveError("REF_MOVE_REF_INVALID", "refName must be a fully-qualified heads ref");
  }
  if (typeof options.newTip !== "string" || !/^[0-9a-f]{40,64}$/.test(options.newTip)) {
    throw new CanonicalRefMoveError("REF_MOVE_TIP_INVALID", "newTip must be a git OID");
  }
  if (typeof options.expectedTip !== "string" || !/^[0-9a-f]{40,64}$/.test(options.expectedTip)) {
    throw new CanonicalRefMoveError("REF_MOVE_TIP_INVALID", "expectedTip must be a git OID");
  }

  const repo = path.resolve(options.repo);
  const abrainHome = path.resolve(options.abrainHome);

  assertCanonicalMutationBarrierHeld(repo);
  await assertCanonicalMutationAuthorized(abrainHome);

  // purpose=csj_v1 requires full certified eligibility witness (module-private brand only).
  if (options.purpose === "csj_v1") {
    const w = options.csjWitness;
    if (!isAuthenticCsjWitness(w) || typeof w.token !== "string" || w.token.length < 32) {
      throw new CanonicalRefMoveError(
        "REF_MOVE_CSJ_WITNESS_REQUIRED",
        "csj_v1 requires full eligibility token / certified unforgeable witness",
      );
    }
    if (w.mergeCommit !== options.newTip || w.headExpected !== options.expectedTip) {
      throw new CanonicalRefMoveError(
        "REF_MOVE_CSJ_WITNESS_MISMATCH",
        "csj witness does not match CAS tips",
      );
    }
    if (typeof options.expectedEpisodeId !== "string" || !options.expectedEpisodeId) {
      throw new CanonicalRefMoveError(
        "REF_MOVE_EPISODE_REQUIRED",
        "csj_v1 requires expectedEpisodeId matching the unique open episode",
      );
    }
    if (w.episodeId !== options.expectedEpisodeId) {
      throw new CanonicalRefMoveError(
        "REF_MOVE_CSJ_WITNESS_MISMATCH",
        "csj witness episode does not match expectedEpisodeId",
      );
    }
  }

  if (options.purpose === "recover_v3") {
    if (typeof options.expectedEpisodeId !== "string" || !options.expectedEpisodeId) {
      throw new CanonicalRefMoveError(
        "REF_MOVE_EPISODE_REQUIRED",
        "recover_v3 requires expectedEpisodeId matching the unique open episode",
      );
    }
  }

  // skipOpenGate: test hooks only — no production env bypass flag.
  if (options.skipOpenGate) {
    if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
      throw new CanonicalRefMoveError(
        "REF_MOVE_SKIP_OPEN_GATE_FORBIDDEN",
        "skipOpenGate is test-only; production env bypass removed",
      );
    }
  }

  if (!options.skipOpenGate) {
    // All purposes: real OpenQuarantineGate reclassify (historyAcceptedHead production bypass removed).
    await evaluateOpenQuarantineGate({
      repo,
      purpose: options.purpose,
      expectedEpisodeId: options.expectedEpisodeId,
    });
  }

  // Re-assert immediately before CAS (spec C1.P2).
  assertCanonicalMutationBarrierHeld(repo);
  await assertCanonicalMutationAuthorized(abrainHome);

  try {
    await gitText(repo, ["update-ref", options.refName, options.newTip, options.expectedTip]);
    return Object.freeze({
      status: "moved" as const,
      previousTip: options.expectedTip,
      currentTip: options.newTip,
      purpose: options.purpose,
    });
  } catch (error) {
    let currentTip: string | undefined;
    try {
      currentTip = (await gitText(repo, ["rev-parse", "--verify", `${options.refName}^{commit}`])).trim();
    } catch {
      throw error;
    }
    if (currentTip === options.newTip) {
      return Object.freeze({
        status: "already_at_tip" as const,
        previousTip: options.expectedTip,
        currentTip,
        purpose: options.purpose,
      });
    }
    throw new CanonicalRefMoveError("REF_MOVE_CAS_FAILED", "update-ref optimistic CAS failed", {
      purpose: options.purpose,
      expectedTip: options.expectedTip,
      newTip: options.newTip,
      currentTip,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Alias matching the frozen-spec name. */
export const CanonicalRefMovePrimitive = canonicalRefMovePrimitive;
