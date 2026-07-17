import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex } from "./jcs";
import { buildPropositionPolicyPushShadow, validatePropositionPolicyPushBundle, type PropositionPolicyPushBundle } from "./proposition-policy-push-shadow";
import { verifyTrustedCurrentSessionUserMessage, type TranscriptMessageBinding } from "./proposition-p1b-transcript";
import {
  PROPOSITION_POLICY_PUSH_DRIFT_PATHS,
  PROPOSITION_POLICY_PUSH_DRIFT_REGISTRY_SCHEMA,
  PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH,
  PROPOSITION_POLICY_PUSH_HARD_ABRAIN,
  PROPOSITION_POLICY_PUSH_HARD_TARGET,
  PROPOSITION_POLICY_PUSH_HISTORICAL_EVIDENCE,
  PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V1_RELATIVE,
  PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V2_RELATIVE,
  PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V3_RELATIVE,
  PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V4_RELATIVE,
  PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V5_RELATIVE,
  PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE,
  PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_V3_SCHEMA,
  PROPOSITION_POLICY_PUSH_PUBLICATION_REVIEW_V2_SCHEMA,
  PROPOSITION_POLICY_PUSH_REVIEW_V2_VENDORS,
  PROPOSITION_POLICY_PUSH_TARGET_RELATIVE,
  buildPublicationPlanV2,
  canonicalJson,
  publicationIntentV3Relative,
  publicationReviewV2RelativePaths,
  validateCurrentStaticPlanAnchors,
  validateHistoricalPublicationEvidence,
  validatePublicationPlanV2,
  type PublicationPlanV2,
  type StaticInventoryRow,
} from "./proposition-policy-push-live-publication-plan";

export const PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_SCHEMA = "proposition-policy-push-live-publication-contract-dossier/v5" as const;
export const PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_RELATIVE = PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V5_RELATIVE;
export const PROPOSITION_POLICY_PUSH_BOOTSTRAP_MANIFEST_SCHEMA = "proposition-policy-push-bootstrap-manifest/v1" as const;
export const PROPOSITION_POLICY_PUSH_INSTALLER_MANIFEST_SCHEMA = "proposition-policy-push-installer-manifest/v1" as const;

const execFileAsync = promisify(execFile);
const BOOTSTRAP_HELPER = "scripts/proposition-policy-push-bootstrap-helper.mjs";
const INSTALLER_HELPER = "scripts/proposition-policy-push-installer-helper.mjs";
const CONFINEMENT_PROBE = "scripts/proposition-policy-push-confinement-probe.mjs";
const AUTHORIZED_PARENT = path.posix.dirname(PROPOSITION_POLICY_PUSH_TARGET_RELATIVE);
const BOOTSTRAP_HASH_SCOPE = "sha256 over canonical sorted-key JSON UTF-8 bytes of this manifest with manifest_hash omitted";
const INSTALLER_HASH_SCOPE = BOOTSTRAP_HASH_SCOPE;
const INTENT_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this intent with intent_hash omitted";
const DOSSIER_HASH_SCOPE = "sha256 over RFC8785-JCS UTF-8 bytes of this dossier with dossier_hash omitted";
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_NAMES = Object.freeze(["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"] as const);
type Mode = "production" | "sandbox_test";
type JsonRecord = Record<string, unknown>;

export interface ProtectedRow {
  relative_name: string;
  kind: "directory" | "file" | "symlink";
  bytes: number;
  sha256: string;
  symlink_value: string | null;
  mode: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  children: readonly string[] | null;
}

export interface ProtectedCapture {
  schema_version: "proposition-policy-push-protected-state/v3";
  scope: "all_non_target_non_registered_stream_non_git_metadata_paths_with_exact_authorized_entry_normalization";
  rows: readonly ProtectedRow[];
  row_count: number;
  state_hash: string;
}

export interface DriftCutoff {
  relative_path: string;
  absolute_path: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  cutoff_size: number;
  prefix_sha256: string;
  prefix_complete_newline: true;
  prefix_bytes: Buffer;
}

export interface DriftVerification {
  relative_path: string;
  dev: number;
  ino: number;
  cutoff_size: number;
  final_size: number;
  prefix_sha256: string;
  suffix_bytes: number;
  suffix_sha256: string;
  suffix_row_count: number;
  suffix_rows: readonly Readonly<Record<string, unknown>>[];
  attempts: number;
}

export interface GateBinding {
  plan_relative_path: string;
  plan_raw_sha256: string;
  plan_hash: string;
  reviews: readonly Readonly<Record<string, unknown>>[];
  intent_hash: string;
}

export interface PublicationVerdicts {
  confinement: boolean;
  target: boolean;
  protected: boolean;
  drift: boolean;
  runtime: boolean;
}

export class PropositionPolicyPushLivePublicationError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "PropositionPolicyPushLivePublicationError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export async function readExactPublicationPlanV2(repoRootInput: string): Promise<{ plan: PublicationPlanV2; raw: Buffer; raw_sha256: string }> {
  const repoRoot = path.resolve(repoRootInput);
  const relative = PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE;
  const file = path.join(repoRoot, ...relative.split("/"));
  const raw = await readExactRegular(file, "v2 publication plan");
  const plan = parseCanonical<PublicationPlanV2>(raw, "v2 publication plan");
  validatePublicationPlanV2(plan);
  return deepFreeze({ plan, raw, raw_sha256: sha256Hex(raw) });
}

export function buildPublicationAuthorizationTextV2(input: {
  planRawSha256: string;
  plan: PublicationPlanV2;
  reviews: readonly Readonly<Record<string, unknown>>[];
}): string {
  assertHash(input.planRawSha256, "planRawSha256");
  validatePublicationPlanV2(input.plan);
  const reviewText = input.reviews.map((row) => `${row.vendor}|${row.model}|${row.verdict}|${row.relative_path}|raw sha256=${row.raw_sha256}`).join(", ");
  return [
    "I explicitly authorize ADR0040 P2a.2 confined live-system shadow publication",
    `publication plan path=${PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE}`,
    `publication plan raw sha256=${input.planRawSha256}`,
    `publication plan content hash=${input.plan.plan_hash}`,
    `semantic bundle hash=${PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH}`,
    `hard target=${PROPOSITION_POLICY_PUSH_HARD_TARGET}`,
    `drift registry hash=${String(input.plan.drift_registry.registry_hash)}`,
    `review artifact bindings=${reviewText}`,
    "I attest the six exact review artifact bytes represent the named vendor/model reviews; code verifies bytes and metadata, not cryptographic vendor provenance",
    "execute only the reviewed bubblewrap bootstrap and installer with no unconstrained fallback",
    "bootstrap kernel writable surface is parent-wide .state/sediment while reviewed helper and post-check behavior are narrow",
    "installer has only the FD-verified exact target host bind writable",
    "publication remains inert shadow-only with no runtime consumer, L1/L2, knowledge, rules, project, sibling-shadow, or legacy authority mutation",
  ].join("; ");
}

export async function validatePublicationGatesV2(options: {
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
  mode: Mode;
  syntheticAuthorization?: boolean;
  skipCurrentStaticAnchorsForTest?: boolean;
}): Promise<GateBinding> {
  const repoRoot = path.resolve(options.repoRoot);
  const { plan, raw, raw_sha256 } = await readExactPublicationPlanV2(repoRoot);
  validatePublicationPlanV2(plan, { bundle: options.bundle });
  if (!(options.mode === "sandbox_test" && options.skipCurrentStaticAnchorsForTest)) await validateCurrentStaticPlanAnchors({ repoRoot, bundle: options.bundle, plan });
  const reviewBindings = [] as Array<Record<string, unknown>>;
  const reviewPaths = publicationReviewV2RelativePaths();
  for (const [index, spec] of PROPOSITION_POLICY_PUSH_REVIEW_V2_VENDORS.entries()) {
    const relative = reviewPaths[index]!;
    const reviewRaw = await readExactRegular(path.join(repoRoot, ...relative.split("/")), `${spec.vendor} v2 review`);
    const review = parseCanonical<JsonRecord>(reviewRaw, `${spec.vendor} v2 review`);
    exactKeys(review, ["schema_version", "canonicalization", "artifact_nature", "vendor", "model", "verdict", "reviewed_plan_relative_path", "plan_raw_sha256", "plan_hash"], "v2 review");
    if (review.schema_version !== PROPOSITION_POLICY_PUSH_PUBLICATION_REVIEW_V2_SCHEMA || review.canonicalization !== "RFC8785-JCS" || review.artifact_nature !== "named_review_artifact_bytes_requiring_trusted_user_attestation_not_cryptographic_vendor_provenance" || review.vendor !== spec.vendor || typeof review.model !== "string" || !review.model || review.verdict !== "SIGN" || review.reviewed_plan_relative_path !== PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE || review.plan_raw_sha256 !== raw_sha256 || review.plan_hash !== plan.plan_hash) fail("REVIEW_GATE_INVALID", "v2 review is missing, stale, reordered, or foreign", { vendor: spec.vendor });
    reviewBindings.push({ vendor: review.vendor, model: review.model, verdict: review.verdict, relative_path: relative, raw_sha256: sha256Hex(reviewRaw), plan_hash: review.plan_hash });
  }
  const intentRelative = publicationIntentV3Relative();
  const intentRaw = await readExactRegular(path.join(repoRoot, ...intentRelative.split("/")), "v3 publication intent");
  const intent = parseCanonical<JsonRecord>(intentRaw, "v3 publication intent");
  exactKeys(intent, ["schema_version", "canonicalization", "hash_algorithm", "intent_hash_scope", "mode", "plan_relative_path", "plan_raw_sha256", "plan_hash", "reviews", "authorization", "intent_hash"], "v3 intent");
  if (intent.schema_version !== PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_V3_SCHEMA || intent.canonicalization !== "RFC8785-JCS" || intent.hash_algorithm !== "sha256" || intent.intent_hash_scope !== INTENT_HASH_SCOPE || intent.mode !== options.mode || intent.plan_relative_path !== PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE || intent.plan_raw_sha256 !== raw_sha256 || intent.plan_hash !== plan.plan_hash || canonicalizeJcs(intent.reviews) !== canonicalizeJcs(reviewBindings)) fail("USER_GATE_INVALID", "v3 intent binding differs");
  const authorization = asRecord(intent.authorization);
  exactKeys(authorization, ["kind", "role", "authorization_text_sha256", "transcript"], "v3 intent authorization");
  const authorizationText = buildPublicationAuthorizationTextV2({ planRawSha256: raw_sha256, plan, reviews: reviewBindings });
  if (authorization.authorization_text_sha256 !== sha256Hex(authorizationText)) fail("USER_GATE_INVALID", "authorization text hash differs");
  if (options.mode === "production") {
    if (authorization.kind !== "exact_role_user_transcript_authorization" || authorization.role !== "user" || !authorization.transcript) fail("USER_GATE_INVALID", "production requires an exact role=user transcript authorization");
    const verified = await verifyTrustedCurrentSessionUserMessage(authorization.transcript as TranscriptMessageBinding, { requireFreshAfterAttestation: true });
    if (verified.text !== authorizationText) fail("USER_GATE_INVALID", "trusted role=user authorization text differs");
  } else if (!options.syntheticAuthorization || authorization.kind !== "synthetic_test_fixture" || authorization.role !== "test_fixture" || authorization.transcript !== null) {
    fail("USER_GATE_INVALID", "sandbox requires an explicit synthetic fixture authorization");
  }
  assertHash(intent.intent_hash, "intent.intent_hash");
  const intentBase = { ...intent };
  delete intentBase.intent_hash;
  if (jcsSha256Hex(intentBase) !== intent.intent_hash) fail("USER_GATE_INVALID", "intent self-hash differs");
  return deepFreeze({ plan_relative_path: PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE, plan_raw_sha256: sha256Hex(raw), plan_hash: plan.plan_hash, reviews: reviewBindings, intent_hash: String(intent.intent_hash) });
}

export function buildSyntheticGateArtifactsV2(input: { plan: PublicationPlanV2; planRawSha256: string }): {
  reviews: readonly JsonRecord[];
  intent: JsonRecord;
} {
  validatePublicationPlanV2(input.plan);
  const reviewPaths = publicationReviewV2RelativePaths();
  const reviews = PROPOSITION_POLICY_PUSH_REVIEW_V2_VENDORS.map((spec, index) => ({
    schema_version: PROPOSITION_POLICY_PUSH_PUBLICATION_REVIEW_V2_SCHEMA,
    canonicalization: "RFC8785-JCS",
    artifact_nature: "named_review_artifact_bytes_requiring_trusted_user_attestation_not_cryptographic_vendor_provenance",
    vendor: spec.vendor,
    model: `synthetic-${index + 1}`,
    verdict: "SIGN",
    reviewed_plan_relative_path: PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE,
    plan_raw_sha256: input.planRawSha256,
    plan_hash: input.plan.plan_hash,
  }));
  const bindings = reviews.map((review, index) => ({ vendor: review.vendor, model: review.model, verdict: review.verdict, relative_path: reviewPaths[index], raw_sha256: sha256Hex(canonicalJson(review)), plan_hash: review.plan_hash }));
  const authorizationText = buildPublicationAuthorizationTextV2({ planRawSha256: input.planRawSha256, plan: input.plan, reviews: bindings });
  const intentBase = {
    schema_version: PROPOSITION_POLICY_PUSH_PUBLICATION_INTENT_V3_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    intent_hash_scope: INTENT_HASH_SCOPE,
    mode: "sandbox_test",
    plan_relative_path: PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE,
    plan_raw_sha256: input.planRawSha256,
    plan_hash: input.plan.plan_hash,
    reviews: bindings,
    authorization: { kind: "synthetic_test_fixture", role: "test_fixture", authorization_text_sha256: sha256Hex(authorizationText), transcript: null },
  };
  return deepFreeze({ reviews, intent: { ...intentBase, intent_hash: jcsSha256Hex(intentBase) } });
}

export async function captureProtectedState(abrainHomeInput: string): Promise<ProtectedCapture> {
  const abrainHome = await exactDirectory(abrainHomeInput, "abrain");
  const rows: ProtectedRow[] = [];
  const driftSet = new Set<string>(PROPOSITION_POLICY_PUSH_DRIFT_PATHS);
  const walk = async (file: string): Promise<void> => {
    const relative = unixRelative(abrainHome, file) || ".";
    if (relative === PROPOSITION_POLICY_PUSH_TARGET_RELATIVE || relative.startsWith(`${PROPOSITION_POLICY_PUSH_TARGET_RELATIVE}/`)) return;
    if (relative === ".git" || relative.startsWith(".git/")) return;
    if (driftSet.has(relative)) return;
    const first = await fs.lstat(file);
    if (first.isSymbolicLink()) {
      const value = await fs.readlink(file);
      const second = await fs.lstat(file);
      assertStableIdentity(first, second, file);
      rows.push(rowFromStat(relative, "symlink", first, 0, sha256Hex(value), value, null));
      return;
    }
    if (first.isDirectory()) {
      const actualChildren = (await fs.readdir(file)).sort(compare);
      let normalizedChildren = actualChildren;
      if (relative === path.posix.dirname(AUTHORIZED_PARENT)) normalizedChildren = normalizedChildren.filter((name) => name !== path.posix.basename(AUTHORIZED_PARENT));
      if (relative === AUTHORIZED_PARENT) normalizedChildren = normalizedChildren.filter((name) => name !== path.posix.basename(PROPOSITION_POLICY_PUSH_TARGET_RELATIVE));
      rows.push(rowFromStat(relative, "directory", first, 0, jcsSha256Hex({ kind: "directory", children: normalizedChildren }), null, Object.freeze(normalizedChildren)));
      for (const child of actualChildren) {
        if (relative === AUTHORIZED_PARENT && child === path.posix.basename(PROPOSITION_POLICY_PUSH_TARGET_RELATIVE)) continue;
        await walk(path.join(file, child));
      }
      const second = await fs.lstat(file);
      assertStableIdentity(first, second, file);
      return;
    }
    if (!first.isFile()) fail("PROTECTED_UNSUPPORTED_TYPE", "protected state contains an unsupported filesystem type", { file });
    const bytes = await fs.readFile(file);
    const second = await fs.lstat(file);
    assertStableIdentity(first, second, file);
    if (bytes.length !== first.size) fail("PROTECTED_CAPTURE_RACE", "protected file size changed while read", { file });
    rows.push(rowFromStat(relative, "file", first, bytes.length, sha256Hex(bytes), null, null));
  };
  await walk(abrainHome);
  rows.sort((left, right) => compare(left.relative_name, right.relative_name));
  const frozenRows = Object.freeze(rows.map((row) => deepFreeze(row)));
  return deepFreeze({ schema_version: "proposition-policy-push-protected-state/v3", scope: "all_non_target_non_registered_stream_non_git_metadata_paths_with_exact_authorized_entry_normalization", rows: frozenRows, row_count: frozenRows.length, state_hash: jcsSha256Hex(frozenRows) });
}

export function verifyProtectedStateDelta(before: ProtectedCapture, after: ProtectedCapture): Readonly<Record<string, unknown>> {
  const beforeRows = new Map(before.rows.map((row) => [row.relative_name, row]));
  const afterRows = new Map(after.rows.map((row) => [row.relative_name, row]));
  const created = [...afterRows.keys()].filter((name) => !beforeRows.has(name)).sort(compare);
  const removed = [...beforeRows.keys()].filter((name) => !afterRows.has(name)).sort(compare);
  const modified = [...beforeRows.keys()].filter((name) => afterRows.has(name) && canonicalizeJcs(beforeRows.get(name)) !== canonicalizeJcs(afterRows.get(name))).sort(compare);
  let authorizedParentCreation = false;
  if (created.length === 1 && created[0] === AUTHORIZED_PARENT && removed.length === 0 && modified.length === 0) {
    const row = afterRows.get(AUTHORIZED_PARENT)!;
    authorizedParentCreation = row.kind === "directory"
      && row.mode === 0o700
      && row.uid === (process.getuid?.() ?? row.uid)
      && row.gid === (process.getgid?.() ?? row.gid)
      && canonicalizeJcs(row.children) === canonicalizeJcs([])
      && row.sha256 === jcsSha256Hex({ kind: "directory", children: [] });
  }
  const exactEquality = created.length === 0 && removed.length === 0 && modified.length === 0;
  return deepFreeze({
    schema_version: "proposition-policy-push-protected-delta/v1",
    allowed: exactEquality || authorizedParentCreation,
    exact_equality: exactEquality,
    authorized_parent_creation: authorizedParentCreation,
    created,
    removed,
    modified,
  });
}

export async function captureDriftCutoffs(abrainHomeInput: string): Promise<readonly DriftCutoff[]> {
  return captureDriftCutoffsInternal(abrainHomeInput);
}

async function captureDriftCutoffsInternal(
  abrainHomeInput: string,
  afterFdReadForTest?: (relative: string, absolutePath: string) => Promise<void> | void,
): Promise<readonly DriftCutoff[]> {
  const abrainHome = await exactDirectory(abrainHomeInput, "abrain");
  const output: DriftCutoff[] = [];
  for (const relative of PROPOSITION_POLICY_PUSH_DRIFT_PATHS) {
    const file = path.join(abrainHome, ...relative.split("/"));
    const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const named = await fs.lstat(file);
      if (!stat.isFile() || named.isSymbolicLink() || !named.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || await fs.realpath(file) !== file) fail("DRIFT_STREAM_UNSAFE", "registered stream is not an exact pinned regular file", { relative });
      const bytes = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
      if (bytesRead !== stat.size) fail("DRIFT_STREAM_RACE", "registered stream prefix read was short", { relative, expected: stat.size, actual: bytesRead });
      await afterFdReadForTest?.(relative, file);
      const openedAfter = await handle.stat();
      await assertNamedRegularIdentity(file, stat, "DRIFT_STREAM_REPLACED", { relative });
      if (!openedAfter.isFile() || openedAfter.dev !== stat.dev || openedAfter.ino !== stat.ino || openedAfter.size !== stat.size || (openedAfter.mode & 0o7777) !== (stat.mode & 0o7777) || openedAfter.uid !== stat.uid || openedAfter.gid !== stat.gid) fail("DRIFT_STREAM_RACE", "registered stream opened identity changed after prefix read", { relative });
      if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) fail("DRIFT_STREAM_TORN", "registered stream prefix lacks a complete newline", { relative, cutoff: stat.size });
      output.push({ relative_path: relative, absolute_path: file, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, cutoff_size: stat.size, prefix_sha256: sha256Hex(bytes), prefix_complete_newline: true, prefix_bytes: bytes });
    } finally { await handle.close(); }
  }
  return Object.freeze(output.map((row) => deepFreeze(row)));
}

export async function verifyDriftSuffixes(cutoffs: readonly DriftCutoff[], options: { retries?: number; retryDelayMs?: number } = {}): Promise<readonly DriftVerification[]> {
  if (canonicalizeJcs(cutoffs.map((row) => row.relative_path)) !== canonicalizeJcs(PROPOSITION_POLICY_PUSH_DRIFT_PATHS)) fail("DRIFT_REGISTRY_MISMATCH", "cutoffs do not exactly match the registered paths");
  const output: DriftVerification[] = [];
  for (const cutoff of cutoffs) {
    let completed: DriftVerification | null = null;
    const retries = options.retries ?? 5;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        completed = await verifyOneDrift(cutoff, attempt);
        break;
      } catch (error) {
        if (!(error instanceof PropositionPolicyPushLivePublicationError) || error.code !== "DRIFT_STREAM_TORN" || attempt === retries) throw error;
        await delay(options.retryDelayMs ?? 10);
      }
    }
    if (!completed) fail("DRIFT_STREAM_TORN", "registered stream never reached a complete newline", { relative: cutoff.relative_path });
    output.push(completed);
  }
  return Object.freeze(output.map((row) => deepFreeze(row)));
}

async function verifyOneDrift(cutoff: DriftCutoff, attempt: number): Promise<DriftVerification> {
  const named = await fs.lstat(cutoff.absolute_path);
  if (named.isSymbolicLink() || !named.isFile() || named.dev !== cutoff.dev || named.ino !== cutoff.ino || (named.mode & 0o7777) !== cutoff.mode || named.uid !== cutoff.uid || named.gid !== cutoff.gid || await fs.realpath(cutoff.absolute_path) !== cutoff.absolute_path) fail("DRIFT_STREAM_REPLACED", "registered stream identity/type/mode/ownership changed", { relative: cutoff.relative_path });
  const handle = await fs.open(cutoff.absolute_path, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.dev !== cutoff.dev || stat.ino !== cutoff.ino) fail("DRIFT_STREAM_REPLACED", "registered stream open identity changed", { relative: cutoff.relative_path });
    if (stat.size < cutoff.cutoff_size) fail("DRIFT_STREAM_TRUNCATED", "registered stream was truncated", { relative: cutoff.relative_path, cutoff: cutoff.cutoff_size, size: stat.size });
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    if (bytesRead !== stat.size) fail("DRIFT_STREAM_RACE", "registered stream final read was short", { relative: cutoff.relative_path });
    const openedAfter = await handle.stat();
    await assertNamedRegularIdentity(cutoff.absolute_path, stat, "DRIFT_STREAM_REPLACED", { relative: cutoff.relative_path });
    if (!openedAfter.isFile() || openedAfter.dev !== stat.dev || openedAfter.ino !== stat.ino || openedAfter.size !== stat.size || (openedAfter.mode & 0o7777) !== cutoff.mode || openedAfter.uid !== cutoff.uid || openedAfter.gid !== cutoff.gid) fail("DRIFT_STREAM_RACE", "registered stream opened identity changed after final read", { relative: cutoff.relative_path });
    const prefix = bytes.subarray(0, cutoff.cutoff_size);
    if (!prefix.equals(cutoff.prefix_bytes) || sha256Hex(prefix) !== cutoff.prefix_sha256) fail("DRIFT_STREAM_PREFIX_CHANGED", "registered stream prefix bytes changed", { relative: cutoff.relative_path });
    const suffix = bytes.subarray(cutoff.cutoff_size);
    if (suffix.length > 0 && suffix[suffix.length - 1] !== 0x0a) fail("DRIFT_STREAM_TORN", "registered stream suffix ends with a torn append", { relative: cutoff.relative_path, size: stat.size });
    const suffixRows = parseDriftSuffix(cutoff.relative_path, suffix, cutoff.cutoff_size);
    return { relative_path: cutoff.relative_path, dev: cutoff.dev, ino: cutoff.ino, cutoff_size: cutoff.cutoff_size, final_size: stat.size, prefix_sha256: cutoff.prefix_sha256, suffix_bytes: suffix.length, suffix_sha256: sha256Hex(suffix), suffix_row_count: suffixRows.length, suffix_rows: suffixRows, attempts: attempt };
  } finally { await handle.close(); }
}

function parseDriftSuffix(relative: string, suffix: Buffer, cutoff: number): readonly Readonly<Record<string, unknown>>[] {
  if (!suffix.length) return Object.freeze([]);
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  let offset = 0;
  while (offset < suffix.length) {
    const newline = suffix.indexOf(0x0a, offset);
    if (newline < 0) fail("DRIFT_STREAM_TORN", "registered stream suffix row lacks newline", { relative });
    const raw = suffix.subarray(offset, newline);
    if (!raw.length) fail("DRIFT_STREAM_SCHEMA", "registered stream contains an empty row", { relative, offset: cutoff + offset });
    let value: JsonRecord;
    try { value = JSON.parse(raw.toString("utf8")) as JsonRecord; } catch (error) { fail("DRIFT_STREAM_MALFORMED", "registered stream suffix row is malformed JSON", { relative, offset: cutoff + offset, error: errorMessage(error) }); }
    validateDriftRow(relative, value);
    const nativeIds: Record<string, unknown> = {};
    if (relative === PROPOSITION_POLICY_PUSH_DRIFT_PATHS[0]) for (const key of ["inject_id", "session_id", "turn_id"] as const) if (value[key] !== undefined) nativeIds[key] = value[key];
    rows.push(deepFreeze({ byte_start: cutoff + offset, byte_end_exclusive: cutoff + newline + 1, raw_sha256: sha256Hex(raw), native_ids: nativeIds }));
    offset = newline + 1;
  }
  return Object.freeze(rows);
}

function validateDriftRow(relative: string, value: JsonRecord): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("DRIFT_STREAM_SCHEMA", "registered stream row must be an object", { relative });
  if (relative === PROPOSITION_POLICY_PUSH_DRIFT_PATHS[0]) {
    if (!nonempty(value.ts) || !nonempty(value.inject_id) || !nonempty(value.outcome) || !nonnegativeInteger(value.prompt_chars) || !nonnegativeNumber(value.total_duration_ms)) fail("DRIFT_STREAM_SCHEMA", "path-a suffix row violates its structural schema");
    if (value.session_id !== undefined && !nonempty(value.session_id)) fail("DRIFT_STREAM_SCHEMA", "path-a session_id is invalid");
    if (value.turn_id !== undefined && !nonnegativeInteger(value.turn_id)) fail("DRIFT_STREAM_SCHEMA", "path-a turn_id is invalid");
    return;
  }
  if (relative === PROPOSITION_POLICY_PUSH_DRIFT_PATHS[1]) {
    if (!nonempty(value.ts) || !["push", "fetch", "sync", "writer_publication"].includes(String(value.op)) || !nonempty(value.result)) fail("DRIFT_STREAM_SCHEMA", "git-sync suffix row violates its structural schema");
    return;
  }
  if (relative === PROPOSITION_POLICY_PUSH_DRIFT_PATHS[2]) {
    if (value.schemaVersion !== "rule-injector-dualread-audit/v1" || !nonempty(value.observedAtUtc) || !nonempty(value.status) || !nonnegativeNumber(value.latencyMs)) fail("DRIFT_STREAM_SCHEMA", "dual-read suffix row violates its schema");
    return;
  }
  fail("DRIFT_REGISTRY_MISMATCH", "unregistered stream reached schema validation", { relative });
}

export async function captureGitForensics(abrainHomeInput: string): Promise<Readonly<Record<string, unknown>>> {
  const abrainHome = await exactDirectory(abrainHomeInput, "abrain");
  const gitDir = path.join(abrainHome, ".git");
  const gitStat = await fs.lstat(gitDir);
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory() || await fs.realpath(gitDir) !== gitDir) fail("GIT_FORENSIC_UNSAFE", ".git is not an exact directory");
  const run = async (args: readonly string[]): Promise<Buffer> => {
    const result = await execFileAsync("/usr/bin/git", ["--no-optional-locks", "-C", abrainHome, ...args], { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }) as unknown as { stdout: Buffer };
    return Buffer.from(result.stdout);
  };
  const [head, symbolic, status, index, worktreeDiff, cachedDiff] = await Promise.all([
    run(["rev-parse", "--verify", "HEAD"]),
    run(["symbolic-ref", "-q", "HEAD"]).catch(() => Buffer.alloc(0)),
    run(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    run(["ls-files", "--stage", "-z"]),
    run(["diff", "--no-ext-diff", "--binary"]),
    run(["diff", "--cached", "--no-ext-diff", "--binary"]),
  ]);
  const metadataRows: Array<Record<string, unknown>> = [];
  const walk = async (entry: string): Promise<void> => {
    const stat = await fs.lstat(entry);
    const relative = unixRelative(gitDir, entry) || ".";
    const base = { relative_name: relative, bytes: stat.size, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, dev: stat.dev, ino: stat.ino };
    if (stat.isSymbolicLink()) {
      const value = await fs.readlink(entry);
      const after = await fs.lstat(entry);
      assertStableIdentity(stat, after, entry);
      metadataRows.push({ ...base, kind: "symlink", content_sha256: sha256Hex(value), symlink_value: value });
      return;
    }
    if (stat.isFile()) {
      const handle = await fs.open(entry, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) fail("GIT_FORENSIC_RACE", "git regular file changed while opened", { relative });
        const bytes = Buffer.alloc(opened.size);
        const { bytesRead } = await handle.read(bytes, 0, opened.size, 0);
        const openedAfter = await handle.stat();
        await assertNamedRegularIdentity(entry, opened, "GIT_FORENSIC_RACE", { relative });
        if (bytesRead !== opened.size
          || openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino || openedAfter.size !== opened.size
          || openedAfter.mode !== opened.mode || openedAfter.uid !== opened.uid || openedAfter.gid !== opened.gid
          || openedAfter.mtimeMs !== opened.mtimeMs || openedAfter.ctimeMs !== opened.ctimeMs) fail("GIT_FORENSIC_RACE", "git regular file changed while read", { relative });
        metadataRows.push({ relative_name: relative, kind: "file", bytes: bytes.length, mode: opened.mode & 0o7777, uid: opened.uid, gid: opened.gid, dev: opened.dev, ino: opened.ino, content_sha256: sha256Hex(bytes), symlink_value: null });
      } finally { await handle.close(); }
      return;
    }
    if (stat.isDirectory()) {
      const children = (await fs.readdir(entry)).sort(compare);
      const after = await fs.lstat(entry);
      assertStableIdentity(stat, after, entry);
      metadataRows.push({ ...base, kind: "directory", content_sha256: jcsSha256Hex(children), symlink_value: null });
      for (const child of children) await walk(path.join(entry, child));
      return;
    }
    metadataRows.push({ ...base, kind: "other", content_sha256: null, symlink_value: null });
  };
  await walk(gitDir);
  return deepFreeze({
    schema_version: "proposition-policy-push-git-forensics/v1",
    probe_policy: "nonmutating_git_optional_locks_disabled",
    git_dir_identity: { dev: gitStat.dev, ino: gitStat.ino, mode: gitStat.mode & 0o7777, uid: gitStat.uid, gid: gitStat.gid },
    head_observation_sha256: sha256Hex(head),
    symbolic_ref_sha256: sha256Hex(symbolic),
    status_porcelain_v2_z_sha256: sha256Hex(status),
    index_stage_z_sha256: sha256Hex(index),
    worktree_diff_sha256: sha256Hex(worktreeDiff),
    cached_diff_sha256: sha256Hex(cachedDiff),
    metadata_row_count: metadataRows.length,
    metadata_hash: jcsSha256Hex(metadataRows),
  });
}

async function runBubblewrapEffectivenessPreflight(options: {
  repoRoot: string;
  plan: PublicationPlanV2;
  bwrapPathOverrideForTest?: string;
  simulateDisabledUsernsForTest?: boolean;
}): Promise<Readonly<Record<string, unknown>>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-p2a22-effectiveness-"));
  try {
    const home = path.join(root, "abrain");
    const target = path.join(home, ...PROPOSITION_POLICY_PUSH_TARGET_RELATIVE.split("/"));
    await fs.mkdir(path.join(home, "l1"), { recursive: true });
    await fs.mkdir(path.join(home, ".git"), { recursive: true });
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const targetHandle = await openVerifiedDirectory(target);
    try {
      const nonce = crypto.randomBytes(16).toString("hex");
      const result = await launchBwrap({
        repoRoot: options.repoRoot,
        plan: options.plan,
        mode: "sandbox_test",
        abrainHome: home,
        writableHandle: targetHandle.handle,
        writableDestination: PROPOSITION_POLICY_PUSH_HARD_TARGET,
        manifestName: "probe-manifest.json",
        manifest: { nonce },
        helperRelative: CONFINEMENT_PROBE,
        bwrapPathOverrideForTest: options.bwrapPathOverrideForTest,
        simulateDisabledUsernsForTest: options.simulateDisabledUsernsForTest,
      });
      if (result.status !== 0 || result.signal) fail("CONFINEMENT_PREFLIGHT_FAILED", "bubblewrap effectiveness probe process failed", { status: result.status, signal: result.signal, stderr: result.stderr });
      const parsed = JSON.parse(result.stdout.trim()) as JsonRecord;
      const hostNamespaces = await readHostNamespaces();
      const namespaces = asRecord(parsed.namespaces);
      const namespaceNames = ["user", "mnt", "pid", "net", "ipc", "uts", "cgroup"];
      const namespaceSeparation = namespaceNames.every((name) => typeof namespaces[name] === "string" && namespaces[name] !== hostNamespaces[name]);
      const denials = asRecord(parsed.host_write_denials);
      const allDenials = ["l1", "git", "sediment_sibling", "tmp"].every((name) => asRecord(denials[name]).denied === true);
      const effective = parsed.nonce === nonce
        && canonicalizeJcs(parsed.environment_keys) === canonicalizeJcs(["LANG", "LC_ALL", "PATH", "PWD"])
        && parsed.capability_effective_hex === "0000000000000000"
        && array(parsed.inherited_regular_fds, "probe inherited fds").length === 0
        && parsed.target_writable === true
        && allDenials
        && asRecord(parsed.network).denied === true
        && namespaceSeparation;
      if (!effective) fail("CONFINEMENT_PREFLIGHT_INEFFECTIVE", "bubblewrap effectiveness assertions failed", { parsed, hostNamespaces, namespaceSeparation, allDenials });
      return deepFreeze({ ...parsed, host_namespaces: hostNamespaces, namespace_separation: true, effective: true, mutation_scope: "temporary_sandbox_only" });
    } finally { await targetHandle.handle.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function runConfinedBootstrap(options: {
  repoRoot: string;
  plan: PublicationPlanV2;
  planRawSha256: string;
  abrainHome: string;
  mode: Mode;
  testCrashAt?: "parent_ready" | null;
  executableOverridesForTest?: {
    bwrapPath?: string;
    runtimePath?: string;
    helperPath?: string;
    afterOpen?: (paths: Readonly<{ bwrap: string; runtime: string; helper: string }>) => Promise<void> | void;
  };
}): Promise<Readonly<Record<string, unknown>>> {
  const sediment = path.join(options.abrainHome, ".state", "sediment");
  const pinned = await openVerifiedDirectory(sediment);
  try {
    const source = sourceHash(options.plan, BOOTSTRAP_HELPER);
    const manifestBase = {
      schema_version: PROPOSITION_POLICY_PUSH_BOOTSTRAP_MANIFEST_SCHEMA,
      hash_algorithm: "sha256",
      manifest_hash_scope: BOOTSTRAP_HASH_SCOPE,
      mode: options.mode,
      plan_hash: options.plan.plan_hash,
      plan_raw_sha256: options.planRawSha256,
      bootstrap_source_sha256: source,
      test_crash_at: options.testCrashAt ?? null,
    };
    const manifest = { ...manifestBase, manifest_hash: jcsSha256Hex(manifestBase) };
    validateBootstrapManifest(manifest, options.mode);
    const launched = await launchBwrap({
      repoRoot: options.repoRoot,
      plan: options.plan,
      mode: options.mode,
      abrainHome: options.abrainHome,
      writableHandle: pinned.handle,
      writableDestination: `${PROPOSITION_POLICY_PUSH_HARD_ABRAIN}/.state/sediment`,
      manifestName: "bootstrap-manifest.json",
      manifest,
      helperRelative: BOOTSTRAP_HELPER,
      bwrapPathOverrideForTest: options.executableOverridesForTest?.bwrapPath,
      runtimePathOverrideForTest: options.executableOverridesForTest?.runtimePath,
      helperPathOverrideForTest: options.executableOverridesForTest?.helperPath,
      afterExecutableOpenForTest: options.executableOverridesForTest?.afterOpen,
    });
    if (launched.status !== 0 || launched.signal) fail("BOOTSTRAP_CONFINED_FAILED", "confined bootstrap failed", { status: launched.status, signal: launched.signal, stderr: launched.stderr });
    const target = path.join(options.abrainHome, ...PROPOSITION_POLICY_PUSH_TARGET_RELATIVE.split("/"));
    const targetPinned = await openVerifiedDirectory(target);
    try { return deepFreeze({ manifest, result: JSON.parse(launched.stdout.trim()), target_identity: targetPinned.identity }); }
    finally { await targetPinned.handle.close(); }
  } finally { await pinned.handle.close(); }
}

interface ConfinedInstallerOptions {
  repoRoot: string;
  plan: PublicationPlanV2;
  planRawSha256: string;
  bundle: PropositionPolicyPushBundle;
  abrainHome: string;
  mode: Mode;
  transactionId: string;
  testCrashAt?: "staging_partial" | "bundle_ready" | "complete_latest" | null;
  testPauseAfterStaleReadyMs?: number;
  afterTargetPinForTest?: () => Promise<void> | void;
}

async function runConfinedInstaller(options: ConfinedInstallerOptions): Promise<Readonly<Record<string, unknown>>> {
  validatePropositionPolicyPushBundle(options.bundle);
  const target = path.join(options.abrainHome, ...PROPOSITION_POLICY_PUSH_TARGET_RELATIVE.split("/"));
  const targetPinned = await openVerifiedDirectory(target);
  const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-p2a22-bundle-"));
  try {
    await options.afterTargetPinForTest?.();
    for (const name of ARTIFACT_NAMES) await fs.writeFile(path.join(bundleRoot, name), options.bundle.bytes[name], { mode: 0o600, flag: "wx" });
    const bundlePinned = await openVerifiedDirectory(bundleRoot);
    try {
      const artifactRows = ARTIFACT_NAMES.map((name) => ({ name, bytes: Buffer.byteLength(options.bundle.bytes[name]), sha256: sha256Hex(options.bundle.bytes[name]) }));
      const manifestBase = {
        schema_version: PROPOSITION_POLICY_PUSH_INSTALLER_MANIFEST_SCHEMA,
        hash_algorithm: "sha256",
        manifest_hash_scope: INSTALLER_HASH_SCOPE,
        mode: options.mode,
        plan_hash: options.plan.plan_hash,
        plan_raw_sha256: options.planRawSha256,
        installer_source_sha256: sourceHash(options.plan, INSTALLER_HELPER),
        bundle_hash: options.bundle.manifest.bundle_hash,
        artifact_rows: artifactRows,
        target_identity: targetPinned.identity,
        transaction_id: options.transactionId,
        test_crash_at: options.testCrashAt ?? null,
        test_pause_after_stale_ready_ms: options.testPauseAfterStaleReadyMs ?? 0,
      };
      const manifest = { ...manifestBase, manifest_hash: jcsSha256Hex(manifestBase) };
      validateInstallerManifest(manifest, options.mode);
      const launched = await launchBwrap({ repoRoot: options.repoRoot, plan: options.plan, mode: options.mode, abrainHome: options.abrainHome, writableHandle: targetPinned.handle, writableDestination: PROPOSITION_POLICY_PUSH_HARD_TARGET, manifestName: "installer-manifest.json", manifest, helperRelative: INSTALLER_HELPER, bundleHandle: bundlePinned.handle });
      if (launched.status !== 0 || launched.signal) fail("INSTALLER_CONFINED_FAILED", "confined installer failed", { status: launched.status, signal: launched.signal, stderr: launched.stderr });
      const namedAfter = await fs.lstat(target);
      if (namedAfter.isSymbolicLink() || !namedAfter.isDirectory() || namedAfter.dev !== targetPinned.identity.dev || namedAfter.ino !== targetPinned.identity.ino || await fs.realpath(target) !== target) fail("FD_HANDOFF_REPLACED", "named target changed after FD-bound installer handoff");
      return deepFreeze({ manifest, result: JSON.parse(launched.stdout.trim()) });
    } finally { await bundlePinned.handle.close(); }
  } finally {
    await targetPinned.handle.close();
    await fs.rm(bundleRoot, { recursive: true, force: true });
  }
}

export async function captureExactFinalInventory(abrainHomeInput: string): Promise<readonly StaticInventoryRow[]> {
  const abrainHome = await exactDirectory(abrainHomeInput, "abrain");
  const paths = [AUTHORIZED_PARENT, PROPOSITION_POLICY_PUSH_TARGET_RELATIVE];
  const target = path.join(abrainHome, ...PROPOSITION_POLICY_PUSH_TARGET_RELATIVE.split("/"));
  const walk = async (entry: string, output: StaticInventoryRow[]): Promise<void> => {
    const relative = unixRelative(abrainHome, entry);
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) {
      const value = await fs.readlink(entry);
      output.push({ relative_name: relative, kind: "symlink", bytes: 0, sha256: sha256Hex(value), symlink_value: value, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, children: null });
      return;
    }
    if (stat.isDirectory()) {
      const children = (await fs.readdir(entry)).sort(compare);
      output.push({ relative_name: relative, kind: "directory", bytes: 0, sha256: jcsSha256Hex({ kind: "directory", children }), symlink_value: null, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, children: Object.freeze(children) });
      for (const child of children) await walk(path.join(entry, child), output);
      return;
    }
    if (!stat.isFile()) fail("TARGET_INVENTORY_UNSUPPORTED", "target contains an unsupported type", { relative });
    const bytes = await fs.readFile(entry);
    output.push({ relative_name: relative, kind: "file", bytes: bytes.length, sha256: sha256Hex(bytes), symlink_value: null, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, children: null });
  };
  const rows: StaticInventoryRow[] = [];
  const parent = path.join(abrainHome, ...AUTHORIZED_PARENT.split("/"));
  await walk(parent, rows);
  if (!rows.some((row) => row.relative_name === PROPOSITION_POLICY_PUSH_TARGET_RELATIVE) || await fs.realpath(target) !== target) fail("TARGET_INVENTORY_UNSAFE", "exact target identity is missing");
  rows.sort((left, right) => compare(left.relative_name, right.relative_name));
  return Object.freeze(rows.map((row) => deepFreeze(row)));
}

async function captureTargetInventoryIfPresent(abrainHome: string): Promise<readonly StaticInventoryRow[] | null> {
  const target = path.join(abrainHome, ...PROPOSITION_POLICY_PUSH_TARGET_RELATIVE.split("/"));
  if (!await lstatMaybe(target)) return null;
  return captureExactFinalInventory(abrainHome);
}

export async function verifyBootstrapInventory(abrainHome: string, plan: PublicationPlanV2, before: readonly StaticInventoryRow[] | null = null): Promise<Readonly<Record<string, unknown>>> {
  const actual = await captureExactFinalInventory(abrainHome);
  const parent = plan.exact_final_inventory.find((row) => row.relative_name === AUTHORIZED_PARENT);
  const target = plan.exact_final_inventory.find((row) => row.relative_name === PROPOSITION_POLICY_PUSH_TARGET_RELATIVE);
  if (!parent || !target || parent.kind !== "directory" || target.kind !== "directory") fail("BOOTSTRAP_INVENTORY_PLAN", "plan lacks exact parent/target directory rows");
  const emptyTarget: StaticInventoryRow = {
    ...target,
    bytes: 0,
    sha256: jcsSha256Hex({ kind: "directory", children: [] }),
    children: Object.freeze([]),
  };
  const expected = before ?? Object.freeze([parent, emptyTarget].sort((left, right) => compare(left.relative_name, right.relative_name)));
  const allowed = canonicalizeJcs(actual) === canonicalizeJcs(expected);
  return deepFreeze({ schema_version: "proposition-policy-push-bootstrap-inventory-proof/v1", allowed, expected, actual });
}

export async function executeProductionPublicationV2(options: {
  repoRoot: string;
  bundle: PropositionPolicyPushBundle;
}): Promise<Readonly<Record<string, unknown>>> {
  const repoRoot = path.resolve(options.repoRoot);
  validatePropositionPolicyPushBundle(options.bundle);
  await validateHistoricalPublicationEvidence(repoRoot);
  const firstPlan = await readExactPublicationPlanV2(repoRoot);
  await validateCurrentStaticPlanAnchors({ repoRoot, bundle: options.bundle, plan: firstPlan.plan });
  const gate = await validatePublicationGatesV2({ repoRoot, bundle: options.bundle, mode: "production" });
  const { plan, raw_sha256 } = await readExactPublicationPlanV2(repoRoot);
  if (raw_sha256 !== firstPlan.raw_sha256 || plan.plan_hash !== firstPlan.plan.plan_hash || raw_sha256 !== gate.plan_raw_sha256 || plan.plan_hash !== gate.plan_hash) fail("GATE_PLAN_RACE", "preflight, gate, and execution plan binding differ");
  await validateCurrentStaticPlanAnchors({ repoRoot, bundle: options.bundle, plan });
  const confinement = await runBubblewrapEffectivenessPreflight({ repoRoot, plan });
  const protectedBefore = await captureProtectedState(PROPOSITION_POLICY_PUSH_HARD_ABRAIN);
  const targetBeforeBootstrap = await captureTargetInventoryIfPresent(PROPOSITION_POLICY_PUSH_HARD_ABRAIN);
  const streamsBefore = await captureDriftCutoffs(PROPOSITION_POLICY_PUSH_HARD_ABRAIN);
  const gitBefore = await captureGitForensics(PROPOSITION_POLICY_PUSH_HARD_ABRAIN);
  await validateCurrentStaticPlanAnchors({ repoRoot, bundle: options.bundle, plan });
  const bootstrap = await runConfinedBootstrap({ repoRoot, plan, planRawSha256: raw_sha256, abrainHome: PROPOSITION_POLICY_PUSH_HARD_ABRAIN, mode: "production" });
  const protectedAfterBootstrap = await captureProtectedState(PROPOSITION_POLICY_PUSH_HARD_ABRAIN);
  const bootstrapProtected = verifyProtectedStateDelta(protectedBefore, protectedAfterBootstrap);
  const bootstrapInventory = await verifyBootstrapInventory(PROPOSITION_POLICY_PUSH_HARD_ABRAIN, plan, targetBeforeBootstrap);
  if (bootstrapProtected.allowed !== true || bootstrapInventory.allowed !== true) {
    return deepFreeze({ schema_version: "proposition-policy-push-production-execution-result/v2", gate, bootstrap, bootstrap_protected: bootstrapProtected, bootstrap_inventory: bootstrapInventory, installer: null, verdicts: { confinement: true, target: false, protected: false, drift: false, runtime: true }, completion: false, target_inert: true, reason: "bootstrap_postcheck_protected_drift" });
  }
  const installer = await runConfinedInstaller({ repoRoot, plan, planRawSha256: raw_sha256, bundle: options.bundle, abrainHome: PROPOSITION_POLICY_PUSH_HARD_ABRAIN, mode: "production", transactionId: gate.intent_hash });
  const errors: Record<string, unknown> = {};
  let protectedEqual = false;
  let driftValid = false;
  let targetEqual = false;
  let runtimeEqual = false;
  let protectedAfter: ProtectedCapture | null = null;
  let driftAfter: readonly DriftVerification[] = [];
  let gitAfter: Readonly<Record<string, unknown>> | null = null;
  try {
    const immediateBundle = await buildPropositionPolicyPushShadow({ abrainHome: PROPOSITION_POLICY_PUSH_HARD_ABRAIN, repoRoot, registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json") });
    await validateCurrentStaticPlanAnchors({ repoRoot, bundle: immediateBundle, plan });
    runtimeEqual = true;
  } catch (error) { errors.runtime_immediate_after = { code: errorCode(error), message: errorMessage(error) }; }
  let protectedDelta: Readonly<Record<string, unknown>> | null = null;
  try { protectedAfter = await captureProtectedState(PROPOSITION_POLICY_PUSH_HARD_ABRAIN); protectedDelta = verifyProtectedStateDelta(protectedBefore, protectedAfter); protectedEqual = protectedDelta.allowed === true; } catch (error) { errors.protected = { code: errorCode(error), message: errorMessage(error) }; }
  try { driftAfter = await verifyDriftSuffixes(streamsBefore); driftValid = driftAfter.length === 3; } catch (error) { errors.drift = { code: errorCode(error), message: errorMessage(error) }; }
  try { const actual = await captureExactFinalInventory(PROPOSITION_POLICY_PUSH_HARD_ABRAIN); targetEqual = canonicalizeJcs(actual) === canonicalizeJcs(plan.exact_final_inventory); } catch (error) { errors.target = { code: errorCode(error), message: errorMessage(error) }; }
  try { gitAfter = await captureGitForensics(PROPOSITION_POLICY_PUSH_HARD_ABRAIN); } catch (error) { errors.git = { code: errorCode(error), message: errorMessage(error) }; }
  try {
    const finalBundle = await buildPropositionPolicyPushShadow({ abrainHome: PROPOSITION_POLICY_PUSH_HARD_ABRAIN, repoRoot, registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json") });
    await validateCurrentStaticPlanAnchors({ repoRoot, bundle: finalBundle, plan });
  } catch (error) { runtimeEqual = false; errors.runtime_final = { code: errorCode(error), message: errorMessage(error) }; }
  const verdicts: PublicationVerdicts = { confinement: confinement.effective === true, target: targetEqual, protected: protectedEqual, drift: driftValid, runtime: runtimeEqual };
  const completion = Object.values(verdicts).every(Boolean);
  return deepFreeze({ schema_version: "proposition-policy-push-production-execution-result/v2", gate, bootstrap, bootstrap_protected: bootstrapProtected, bootstrap_inventory: bootstrapInventory, installer, protected: { before_hash: protectedBefore.state_hash, after_hash: protectedAfter?.state_hash ?? null, delta: protectedDelta }, drift: driftAfter, git: { before: gitBefore, after: gitAfter, metadata_drift_recorded: !!gitAfter && canonicalizeJcs(gitBefore) !== canonicalizeJcs(gitAfter) }, errors, verdicts, completion, target_inert: !completion || asRecord(plan.deployment).runtime_consumer === false });
}

export async function executeSandboxPublicationFixture(options: {
  repoRoot: string;
  plan: PublicationPlanV2;
  planRawSha256: string;
  bundle: PropositionPolicyPushBundle;
  abrainHome: string;
  transactionId: string;
  testCrashAt?: "parent_ready" | "staging_partial" | "bundle_ready" | "complete_latest" | null;
  afterInstallForTest?: () => Promise<void> | void;
  forceStaticAnchorAdvancedForTest?: boolean;
  afterBootstrapForTest?: () => Promise<void> | void;
}): Promise<Readonly<Record<string, unknown>>> {
  requireSandboxAbrainHome(options.abrainHome);
  const confinement = await runBubblewrapEffectivenessPreflight({ repoRoot: options.repoRoot, plan: options.plan });
  const protectedBefore = await captureProtectedState(options.abrainHome);
  const targetBeforeBootstrap = await captureTargetInventoryIfPresent(options.abrainHome);
  const streamsBefore = await captureDriftCutoffs(options.abrainHome);
  const gitBefore = await captureGitForensics(options.abrainHome);
  const bootstrap = await runConfinedBootstrap({ repoRoot: options.repoRoot, plan: options.plan, planRawSha256: options.planRawSha256, abrainHome: options.abrainHome, mode: "sandbox_test", testCrashAt: options.testCrashAt === "parent_ready" ? "parent_ready" : null });
  await options.afterBootstrapForTest?.();
  const protectedAfterBootstrap = await captureProtectedState(options.abrainHome);
  const bootstrapProtected = verifyProtectedStateDelta(protectedBefore, protectedAfterBootstrap);
  const bootstrapInventory = await verifyBootstrapInventory(options.abrainHome, options.plan, targetBeforeBootstrap);
  if (bootstrapProtected.allowed !== true || bootstrapInventory.allowed !== true) fail("BOOTSTRAP_POSTCHECK_DRIFT", "bootstrap exceeded the exact parent/v1 creation delta", { bootstrapProtected, bootstrapInventory });
  const installer = await runConfinedInstaller({ repoRoot: options.repoRoot, plan: options.plan, planRawSha256: options.planRawSha256, bundle: options.bundle, abrainHome: options.abrainHome, mode: "sandbox_test", transactionId: options.transactionId, testCrashAt: options.testCrashAt && options.testCrashAt !== "parent_ready" ? options.testCrashAt : null });
  await options.afterInstallForTest?.();
  const [protectedAfter, streamsAfter, gitAfter, actualInventory] = await Promise.all([
    captureProtectedState(options.abrainHome),
    verifyDriftSuffixes(streamsBefore),
    captureGitForensics(options.abrainHome),
    captureExactFinalInventory(options.abrainHome),
  ]);
  const targetEqual = canonicalizeJcs(actualInventory) === canonicalizeJcs(options.plan.exact_final_inventory);
  const protectedDelta = verifyProtectedStateDelta(protectedBefore, protectedAfter);
  const protectedEqual = protectedDelta.allowed === true;
  const staticAnchorsEqual = options.forceStaticAnchorAdvancedForTest !== true;
  const verdicts: PublicationVerdicts = { confinement: confinement.effective === true, target: targetEqual, protected: protectedEqual, drift: streamsAfter.length === 3, runtime: staticAnchorsEqual };
  const completion = Object.values(verdicts).every((value) => value === true);
  return deepFreeze({ schema_version: "proposition-policy-push-sandbox-execution-result/v1", bootstrap, bootstrap_protected: bootstrapProtected, bootstrap_inventory: bootstrapInventory, installer, protected: { before_hash: protectedBefore.state_hash, after_hash: protectedAfter.state_hash, equal: protectedEqual, delta: protectedDelta }, drift: streamsAfter, git: { before: gitBefore, after: gitAfter, metadata_drift_recorded: canonicalizeJcs(gitBefore) !== canonicalizeJcs(gitAfter) }, target_inventory_equal: targetEqual, static_anchors_equal: staticAnchorsEqual, verdicts, completion, target_inert: !completion || true });
}

export async function buildProductionReadOnlyPreview(options: {
  repoRoot: string;
  abrainHome: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const repoRoot = path.resolve(options.repoRoot);
  const abrainHome = await exactDirectory(options.abrainHome, "production abrain");
  if (abrainHome !== PROPOSITION_POLICY_PUSH_HARD_ABRAIN) fail("PRODUCTION_ROOT_REQUIRED", "real preview is hard-limited to /home/worker/.abrain");
  const target = path.join(abrainHome, ...PROPOSITION_POLICY_PUSH_TARGET_RELATIVE.split("/"));
  if (await lstatMaybe(target)) fail("PRODUCTION_TARGET_PRESENT", "read-only preview requires the hard target to remain absent");
  const preservedHistory = await validateHistoricalPublicationEvidence(repoRoot);
  const protectedBefore = await captureProtectedState(abrainHome);
  const cutoffs = await captureDriftCutoffs(abrainHome);
  const gitBefore = await captureGitForensics(abrainHome);
  const bundleBefore = await buildPropositionPolicyPushShadow({ abrainHome, repoRoot, registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json") });
  validatePropositionPolicyPushBundle(bundleBefore);
  const { plan, raw_sha256 } = await readExactPublicationPlanV2(repoRoot);
  await validateCurrentStaticPlanAnchors({ repoRoot, bundle: bundleBefore, plan });
  const confinement = await runBubblewrapEffectivenessPreflight({ repoRoot, plan });
  let gateObservation: Readonly<Record<string, unknown>>;
  try {
    await validatePublicationGatesV2({ repoRoot, bundle: bundleBefore, mode: "production" });
    gateObservation = { status: "unexpectedly_present_and_valid" };
  } catch (error) {
    gateObservation = { status: "blocked_missing_v2_review_or_user_gate", code: errorCode(error) };
  }
  const bundleAfter = await buildPropositionPolicyPushShadow({ abrainHome, repoRoot, registryPath: path.join(repoRoot, "schemas/l1-schema-role-registry.json") });
  await validateCurrentStaticPlanAnchors({ repoRoot, bundle: bundleAfter, plan });
  const [protectedAfter, driftAfter, gitAfter] = await Promise.all([captureProtectedState(abrainHome), verifyDriftSuffixes(cutoffs), captureGitForensics(abrainHome)]);
  if (await lstatMaybe(target)) fail("PRODUCTION_TARGET_CREATED", "read-only preview created the hard target");
  const protectedEqual = protectedBefore.state_hash === protectedAfter.state_hash;
  const bundleEqual = bundleBefore.manifest.bundle_hash === bundleAfter.manifest.bundle_hash && bundleBefore.manifest.bundle_hash === PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH;
  const verdicts: PublicationVerdicts = { confinement: confinement.effective === true, target: true, protected: protectedEqual, drift: driftAfter.length === 3, runtime: bundleEqual };
  if (!Object.values(verdicts).every(Boolean)) fail("PRODUCTION_PREVIEW_VERDICT", "one or more independent read-only preview verdicts failed", { verdicts });
  const suffixBytes = driftAfter.reduce((sum, row) => sum + row.suffix_bytes, 0);
  return deepFreeze({
    schema_version: PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    dossier_hash_scope: DOSSIER_HASH_SCOPE,
    mode: "real_production_read_only_live_system_publication_contract_preview",
    authorization: { phase: "ADR0040-P2a.2.2", scope: "repo_contract_sandbox_mutation_and_real_read_only_preview_only", actual_publication: "blocked_not_authorized", gate_observation: gateObservation },
    preserved_history: preservedHistory,
    supersession: {
      generation: "v5",
      supersedes_relative_path: PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V4_RELATIVE,
      supersedes_raw_sha256: PROPOSITION_POLICY_PUSH_HISTORICAL_EVIDENCE.find((row) => row.generation === "p2a22-v4")?.raw_sha256,
      output_relative_path: PROPOSITION_POLICY_PUSH_P2A22_DOSSIER_V5_RELATIVE,
      reason: "ADR0040 P2a.2.2 final sandbox-gate and stale-ready convergence blockers repaired without rewriting prior evidence bytes",
    },
    plan: { relative_path: PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE, raw_sha256, plan_hash: plan.plan_hash, drift_registry_hash: plan.drift_registry.registry_hash, binds_live_whole_snapshot: false, binds_git_head: false },
    confinement,
    protected: { before: { row_count: protectedBefore.row_count, state_hash: protectedBefore.state_hash }, after: { row_count: protectedAfter.row_count, state_hash: protectedAfter.state_hash }, equal: protectedEqual, whole_tree_equality_required: false },
    drift: { exact_registry_paths: PROPOSITION_POLICY_PUSH_DRIFT_PATHS, streams: driftAfter, total_suffix_bytes: suffixBytes, append_liveness_observed: suffixBytes > 0, zero_suffix_is_valid_quiescent_execution: true },
    git_forensics: { before: gitBefore, after: gitAfter, metadata_drift_recorded: canonicalizeJcs(gitBefore) !== canonicalizeJcs(gitAfter), corresponding_worktree_change: !protectedEqual },
    target: { root: PROPOSITION_POLICY_PUSH_HARD_TARGET, before: "absent", after: "absent", created: false },
    runtime: { bundle_before: bundleBefore.manifest.bundle_hash, bundle_after: bundleAfter.manifest.bundle_hash, static_anchors_equal: bundleEqual, runtime_consumer: false },
    verdicts,
    preview_contract_ready: true,
    actual_execution_completion: false,
    abrain_mutation_by_preview: false,
  });
}

export function finalizeDossier(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const base = { ...input };
  delete base.dossier_hash;
  return deepFreeze({ ...base, dossier_hash: jcsSha256Hex(base) });
}

interface OpenedVerifiedRegular {
  path: string;
  handle: fs.FileHandle;
  sha256: string;
  identity: {
    dev: number;
    ino: number;
    size: number;
    mode: number;
    uid: number;
    gid: number;
    mtime_ms: number;
    ctime_ms: number;
  };
}

async function launchBwrap(options: {
  repoRoot: string;
  plan: PublicationPlanV2;
  mode: Mode;
  abrainHome: string;
  writableHandle: fs.FileHandle;
  writableDestination: string;
  manifestName: string;
  manifest: unknown;
  helperRelative: string;
  bundleHandle?: fs.FileHandle;
  bwrapPathOverrideForTest?: string;
  runtimePathOverrideForTest?: string;
  helperPathOverrideForTest?: string;
  afterExecutableOpenForTest?: (paths: Readonly<{ bwrap: string; runtime: string; helper: string }>) => Promise<void> | void;
  simulateDisabledUsernsForTest?: boolean;
}): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const hasTestSubstitution = !!(options.bwrapPathOverrideForTest || options.runtimePathOverrideForTest || options.helperPathOverrideForTest || options.afterExecutableOpenForTest);
  if (hasTestSubstitution && (options.mode !== "sandbox_test" || path.resolve(options.abrainHome) === PROPOSITION_POLICY_PUSH_HARD_ABRAIN)) fail("TEST_SUBSTITUTION_FORBIDDEN", "executable substitution is unavailable to production launches");
  const confinement = asRecord(options.plan.confinement);
  const bwrapAnchor = asRecord(confinement.bubblewrap);
  const runtimeAnchor = asRecord(confinement.runtime_executable);
  const bwrapPath = path.resolve(options.bwrapPathOverrideForTest ?? String(bwrapAnchor.path));
  const runtimePath = path.resolve(options.runtimePathOverrideForTest ?? String(runtimeAnchor.path));
  const helperPath = path.resolve(options.helperPathOverrideForTest ?? path.join(options.repoRoot, ...options.helperRelative.split("/")));
  const manifestRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-astack-p2a22-manifest-"));
  const manifestFile = path.join(manifestRoot, "manifest.json");
  let manifestHandle: fs.FileHandle | null = null;
  let executableSet: { bwrap: OpenedVerifiedRegular; runtime: OpenedVerifiedRegular; helper: OpenedVerifiedRegular } | null = null;
  try {
    await fs.writeFile(manifestFile, canonicalJson(options.manifest), { mode: 0o600, flag: "wx" });
    manifestHandle = await fs.open(manifestFile, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    executableSet = await openVerifiedExecutableSet({
      bwrapPath,
      bwrapSha256: assertHash(bwrapAnchor.sha256, "confinement.bubblewrap.sha256"),
      runtimePath,
      runtimeSha256: assertHash(runtimeAnchor.sha256, "confinement.runtime_executable.sha256"),
      helperPath,
      helperSha256: sourceHash(options.plan, options.helperRelative),
    });
    const { bwrap, runtime, helper } = executableSet;
    await options.afterExecutableOpenForTest?.({ bwrap: bwrap.path, runtime: runtime.path, helper: helper.path });
    const args = [
      "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
      "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
      "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C", "--setenv", "LC_ALL", "C",
      "--ro-bind", "/", "/",
    ];
    if (options.mode === "sandbox_test") args.push("--ro-bind", path.resolve(options.abrainHome), PROPOSITION_POLICY_PUSH_HARD_ABRAIN);
    if (options.simulateDisabledUsernsForTest) args.push("--userns", "99");
    args.push(
      "--bind-fd", "4", options.writableDestination,
      "--tmpfs", "/run", "--dir", "/run/pi-astack",
      "--ro-bind-fd", "3", "/run/pi-astack/bwrap",
      "--ro-bind-data", "5", `/run/pi-astack/${options.manifestName}`,
      "--ro-bind-fd", "6", "/run/pi-astack/node",
      "--ro-bind-fd", "7", "/run/pi-astack/helper.mjs",
    );
    if (options.bundleHandle) args.push("--dir", "/run/pi-astack/bundle", "--ro-bind-fd", "8", "/run/pi-astack/bundle");
    args.push("--remount-ro", "/run", "--chdir", "/", "--unsetenv", "PWD", "--", "/run/pi-astack/node", "/run/pi-astack/helper.mjs");
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe", bwrap.handle.fd, options.writableHandle.fd, manifestHandle.fd, runtime.handle.fd, helper.handle.fd];
    if (options.bundleHandle) stdio.push(options.bundleHandle.fd);
    const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("/proc/self/fd/3", args, { env: {}, stdio: stdio as any });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => reject(Object.assign(error, { code: errorCode(error) === "ENOENT" ? "BWRAP_UNAVAILABLE" : errorCode(error) })));
      child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    await verifyOpenedRegularAfterHandoff(bwrap, "bwrap");
    await verifyOpenedRegularAfterHandoff(runtime, "Node runtime");
    await verifyOpenedRegularAfterHandoff(helper, "confined helper");
    return result;
  } finally {
    await manifestHandle?.close().catch(() => undefined);
    if (executableSet) await Promise.all([executableSet.bwrap.handle.close(), executableSet.runtime.handle.close(), executableSet.helper.handle.close()].map((promise) => promise.catch(() => undefined)));
    await fs.rm(manifestRoot, { recursive: true, force: true });
  }
}

async function openVerifiedExecutableSet(options: {
  bwrapPath: string;
  bwrapSha256: string;
  runtimePath: string;
  runtimeSha256: string;
  helperPath: string;
  helperSha256: string;
}): Promise<{ bwrap: OpenedVerifiedRegular; runtime: OpenedVerifiedRegular; helper: OpenedVerifiedRegular }> {
  const opened: OpenedVerifiedRegular[] = [];
  try {
    const bwrap = await openVerifiedRegular(options.bwrapPath, options.bwrapSha256, "bwrap", true);
    opened.push(bwrap);
    const runtime = await openVerifiedRegular(options.runtimePath, options.runtimeSha256, "Node runtime", true);
    opened.push(runtime);
    const helper = await openVerifiedRegular(options.helperPath, options.helperSha256, "confined helper", false);
    opened.push(helper);
    return { bwrap, runtime, helper };
  } catch (error) {
    await Promise.all(opened.map((entry) => entry.handle.close().catch(() => undefined)));
    throw error;
  }
}

async function openVerifiedRegular(fileInput: string, expectedSha256: string, label: string, requireExecutable: boolean): Promise<OpenedVerifiedRegular> {
  const file = path.resolve(fileInput);
  let named: Awaited<ReturnType<typeof fs.lstat>>;
  try { named = await fs.lstat(file); }
  catch (error) { if (isCode(error, "ENOENT")) fail(label === "bwrap" ? "BWRAP_UNAVAILABLE" : "CONFINED_EXECUTABLE_MISSING", `${label} is missing`, { file }); throw error; }
  if (named.isSymbolicLink() || !named.isFile() || await fs.realpath(file) !== file || (requireExecutable && (named.mode & 0o111) === 0)) fail("CONFINED_EXECUTABLE_UNSAFE", `${label} is not an exact executable regular file`, { file });
  const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) fail("FD_HANDOFF_REPLACED", `${label} identity changed while opened`, { file });
    const digest = await hashOpenedFile(handle, opened.size);
    const current = await fs.lstat(file);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino || await fs.realpath(file) !== file) fail("FD_HANDOFF_REPLACED", `${label} named identity changed while hashed`, { file });
    if (digest !== expectedSha256) fail("CONFINED_EXECUTABLE_DRIFT", `${label} bytes differ from the reviewed plan`, { file, expected: expectedSha256, actual: digest });
    return {
      path: file,
      handle,
      sha256: digest,
      identity: { dev: Number(opened.dev), ino: Number(opened.ino), size: Number(opened.size), mode: Number(opened.mode), uid: Number(opened.uid), gid: Number(opened.gid), mtime_ms: opened.mtimeMs, ctime_ms: opened.ctimeMs },
    };
  } catch (error) { await handle.close(); throw error; }
}

async function hashOpenedFile(handle: fs.FileHandle, size: number): Promise<string> {
  const digest = crypto.createHash("sha256");
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunk.length, size - offset);
    const { bytesRead } = await handle.read(chunk, 0, length, offset);
    if (bytesRead !== length) fail("FD_HANDOFF_RACE", "opened executable read was short", { expected: length, actual: bytesRead, offset });
    digest.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return digest.digest("hex");
}

async function verifyOpenedRegularAfterHandoff(opened: OpenedVerifiedRegular, label: string): Promise<void> {
  const after = await opened.handle.stat();
  const identity = opened.identity;
  if (!after.isFile() || Number(after.dev) !== identity.dev || Number(after.ino) !== identity.ino || Number(after.size) !== identity.size
    || Number(after.mode) !== identity.mode || Number(after.uid) !== identity.uid || Number(after.gid) !== identity.gid
    || after.mtimeMs !== identity.mtime_ms || after.ctimeMs !== identity.ctime_ms) fail("FD_HANDOFF_REPLACED", `${label} opened identity changed across handoff`, { file: opened.path });
  await assertNamedRegularIdentity(opened.path, after, "FD_HANDOFF_REPLACED", { label, file: opened.path });
}

async function openVerifiedDirectory(directoryInput: string): Promise<{ handle: fs.FileHandle; identity: { dev: number; ino: number } }> {
  const directory = path.resolve(directoryInput);
  const named = await fs.lstat(directory);
  if (named.isSymbolicLink() || !named.isDirectory() || await fs.realpath(directory) !== directory) fail("FD_HANDOFF_UNSAFE", "bind source is not an exact non-symlink directory", { directory });
  const handle = await fs.open(directory, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW);
  const opened = await handle.stat();
  const current = await fs.lstat(directory);
  if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino || current.dev !== opened.dev || current.ino !== opened.ino) {
    await handle.close();
    fail("FD_HANDOFF_REPLACED", "bind source identity changed during FD handoff", { directory });
  }
  return { handle, identity: { dev: Number(opened.dev), ino: Number(opened.ino) } };
}

function validateBootstrapManifest(value: JsonRecord, mode: Mode): void {
  exactKeys(value, ["schema_version", "hash_algorithm", "manifest_hash_scope", "mode", "plan_hash", "plan_raw_sha256", "bootstrap_source_sha256", "test_crash_at", "manifest_hash"], "bootstrap manifest");
  if (value.schema_version !== PROPOSITION_POLICY_PUSH_BOOTSTRAP_MANIFEST_SCHEMA || value.hash_algorithm !== "sha256" || value.manifest_hash_scope !== BOOTSTRAP_HASH_SCOPE || value.mode !== mode) fail("BOOTSTRAP_MANIFEST_INVALID", "bootstrap manifest identity differs");
  for (const key of ["plan_hash", "plan_raw_sha256", "bootstrap_source_sha256", "manifest_hash"]) assertHash(value[key], `bootstrap.${key}`);
  if (mode === "production" && value.test_crash_at !== null) fail("BOOTSTRAP_MANIFEST_INVALID", "production bootstrap crash hook is non-null");
  const base = { ...value };
  delete base.manifest_hash;
  if (jcsSha256Hex(base) !== value.manifest_hash) fail("BOOTSTRAP_MANIFEST_INVALID", "bootstrap manifest hash differs");
}

function validateInstallerManifest(value: JsonRecord, mode: Mode): void {
  exactKeys(value, ["schema_version", "hash_algorithm", "manifest_hash_scope", "mode", "plan_hash", "plan_raw_sha256", "installer_source_sha256", "bundle_hash", "artifact_rows", "target_identity", "transaction_id", "test_crash_at", "test_pause_after_stale_ready_ms", "manifest_hash"], "installer manifest");
  if (value.schema_version !== PROPOSITION_POLICY_PUSH_INSTALLER_MANIFEST_SCHEMA || value.hash_algorithm !== "sha256" || value.manifest_hash_scope !== INSTALLER_HASH_SCOPE || value.mode !== mode || value.bundle_hash !== PROPOSITION_POLICY_PUSH_EXPECTED_BUNDLE_HASH) fail("INSTALLER_MANIFEST_INVALID", "installer manifest identity differs");
  for (const key of ["plan_hash", "plan_raw_sha256", "installer_source_sha256", "bundle_hash", "transaction_id", "manifest_hash"]) assertHash(value[key], `installer.${key}`);
  if (!Number.isSafeInteger(value.test_pause_after_stale_ready_ms) || Number(value.test_pause_after_stale_ready_ms) < 0 || Number(value.test_pause_after_stale_ready_ms) > 5_000) fail("INSTALLER_MANIFEST_INVALID", "installer stale-ready pause is invalid");
  if (mode === "production" && (value.test_crash_at !== null || value.test_pause_after_stale_ready_ms !== 0)) fail("INSTALLER_MANIFEST_INVALID", "production installer test hook is enabled");
  const base = { ...value };
  delete base.manifest_hash;
  if (jcsSha256Hex(base) !== value.manifest_hash) fail("INSTALLER_MANIFEST_INVALID", "installer manifest hash differs");
}

function sourceHash(plan: PublicationPlanV2, relative: string): string {
  const confinement = asRecord(plan.confinement);
  const inventory = asRecord(confinement.source_inventory);
  const row = array(inventory.rows, "source inventory rows").map(asRecord).find((candidate) => candidate.path === relative);
  if (!row) fail("CONFINED_SOURCE_UNBOUND", "source is absent from the reviewed plan", { relative });
  return assertHash(row.sha256, `source ${relative}`);
}

async function assertNamedRegularIdentity(
  file: string,
  opened: Awaited<ReturnType<fs.FileHandle["stat"]>>,
  code: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const named = await fs.lstat(file);
  if (named.isSymbolicLink() || !named.isFile()
    || Number(named.dev) !== Number(opened.dev) || Number(named.ino) !== Number(opened.ino)
    || (Number(named.mode) & 0o7777) !== (Number(opened.mode) & 0o7777)
    || Number(named.uid) !== Number(opened.uid) || Number(named.gid) !== Number(opened.gid)
    || await fs.realpath(file) !== file) fail(code, "named regular-file identity changed after FD read", detail);
}

async function readHostNamespaces(): Promise<Record<string, string | null>> {
  const output: Record<string, string | null> = {};
  for (const name of ["user", "mnt", "pid", "net", "ipc", "uts", "cgroup"]) output[name] = await fs.readlink(`/proc/self/ns/${name}`).catch(() => null);
  return output;
}

function rowFromStat(relative: string, kind: ProtectedRow["kind"], stat: Awaited<ReturnType<typeof fs.lstat>>, bytes: number, hash: string, symlink: string | null, children: readonly string[] | null): ProtectedRow {
  return { relative_name: relative, kind, bytes, sha256: hash, symlink_value: symlink, mode: Number(stat.mode) & 0o7777, uid: Number(stat.uid), gid: Number(stat.gid), dev: Number(stat.dev), ino: Number(stat.ino), children };
}

function assertStableIdentity(first: Awaited<ReturnType<typeof fs.lstat>>, second: Awaited<ReturnType<typeof fs.lstat>>, file: string): void {
  if (first.dev !== second.dev || first.ino !== second.ino || first.mode !== second.mode || first.uid !== second.uid || first.gid !== second.gid || first.size !== second.size) fail("PROTECTED_CAPTURE_RACE", "protected entry changed while captured", { file });
}

function requireSandboxAbrainHome(input: string): string {
  const resolved = path.resolve(input);
  let realTmp: string;
  try { realTmp = fsSync.realpathSync.native(os.tmpdir()); }
  catch (error) { fail("SANDBOX_REQUIRED", "real os.tmpdir() is unavailable", { error: errorMessage(error) }); }
  const relative = path.relative(realTmp, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) fail("SANDBOX_REQUIRED", "abrainHome must be strictly beneath real os.tmpdir()", { resolved, real_tmpdir: realTmp });
  try {
    const stat = fsSync.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fsSync.realpathSync.native(resolved) !== resolved) fail("SANDBOX_REQUIRED", "abrainHome must be a real non-symlink directory", { resolved, real_tmpdir: realTmp });
  } catch (error) {
    if (error instanceof PropositionPolicyPushLivePublicationError) throw error;
    fail("SANDBOX_REQUIRED", "abrainHome must be an existing real non-symlink directory", { resolved, real_tmpdir: realTmp, error: errorMessage(error) });
  }
  return resolved;
}

async function exactDirectory(input: string, label: string): Promise<string> {
  const resolved = path.resolve(input);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(resolved) !== resolved) fail("PATH_UNSAFE", `${label} is not an exact non-symlink directory`, { resolved });
  return resolved;
}

async function readExactRegular(file: string, label: string): Promise<Buffer> {
  const stat = await fs.lstat(file).catch((error: unknown) => { if (isCode(error, "ENOENT")) fail("EVIDENCE_MISSING", `${label} is missing`, { file }); throw error; });
  if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(file) !== file) fail("EVIDENCE_UNSAFE", `${label} is not an exact regular file`, { file });
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) fail("EVIDENCE_RACE", `${label} changed while read`, { file });
  return bytes;
}

function parseCanonical<T>(raw: Buffer, label: string): T {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch (error) { fail("EVIDENCE_MALFORMED", `${label} is malformed JSON`, { error: errorMessage(error) }); }
  if (!raw.equals(Buffer.from(canonicalJson(value), "utf8"))) fail("EVIDENCE_NONCANONICAL", `${label} is not RFC8785-JCS plus one newline`);
  return value as T;
}

function exactKeys(value: JsonRecord, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compare);
  const wanted = [...expected].sort(compare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("SHAPE_INVALID", `${at} keys differ`, { actual, wanted });
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SHAPE_INVALID", "expected object");
  return value as JsonRecord;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("SHAPE_INVALID", `${at} must be an array`);
  return value;
}

function assertHash(value: unknown, at: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("HASH_INVALID", `${at} must be SHA-256`);
  return value;
}

function nonempty(value: unknown): boolean { return typeof value === "string" && value.length > 0; }
function nonnegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function nonnegativeNumber(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function unixRelative(parent: string, child: string): string { return path.relative(parent, child).split(path.sep).join("/"); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown): string { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "ERROR"; }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code; }
async function lstatMaybe(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> { try { return await fs.lstat(file); } catch (error) { if (isCode(error, "ENOENT")) return null; throw error; } }
function fail(code: string, message: string, detail?: Record<string, unknown>): never { throw new PropositionPolicyPushLivePublicationError(code, message, detail); }
function deepFreeze<T>(value: T): T { if (Buffer.isBuffer(value)) return value; if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }

async function runBubblewrapEffectivenessPreflightForTest(options: Parameters<typeof runBubblewrapEffectivenessPreflight>[0] & { abrainHome: string }): Promise<Readonly<Record<string, unknown>>> {
  requireSandboxAbrainHome(options.abrainHome);
  return runBubblewrapEffectivenessPreflight(options);
}

async function runConfinedBootstrapForTest(options: Omit<Parameters<typeof runConfinedBootstrap>[0], "mode">): Promise<Readonly<Record<string, unknown>>> {
  requireSandboxAbrainHome(options.abrainHome);
  return runConfinedBootstrap({ ...options, mode: "sandbox_test" });
}

async function runConfinedInstallerForTest(options: Omit<ConfinedInstallerOptions, "mode">): Promise<Readonly<Record<string, unknown>>> {
  requireSandboxAbrainHome(options.abrainHome);
  return runConfinedInstaller({ ...options, mode: "sandbox_test" });
}

async function captureDriftCutoffsWithTerminalHookForTest(
  abrainHome: string,
  hook?: (relative: string, absolutePath: string) => Promise<void> | void,
): Promise<readonly DriftCutoff[]> {
  requireSandboxAbrainHome(abrainHome);
  return captureDriftCutoffsInternal(abrainHome, hook);
}

export const __TEST = Object.freeze({
  runBubblewrapEffectivenessPreflight: runBubblewrapEffectivenessPreflightForTest,
  runConfinedBootstrap: runConfinedBootstrapForTest,
  runConfinedInstaller: runConfinedInstallerForTest,
  captureDriftCutoffsWithTerminalHook: captureDriftCutoffsWithTerminalHookForTest,
});
