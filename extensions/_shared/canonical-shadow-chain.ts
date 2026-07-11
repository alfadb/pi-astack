import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { durableAtomicCreateFile, type DurableCreateStatus } from "./durable-write";
import { canonicalizeJcs, jcsSha256Hex, sha256Hex, type JcsJsonValue } from "./jcs";
import { renderConstraintL2View } from "../sediment/constraint-compiler/render";
import {
  knowledgeIdentityKey,
  renderKnowledgeProjectionFromSet,
  type KnowledgeEvidenceEventBodyV1,
  type KnowledgeEventNode,
} from "../sediment/knowledge-evidence";
import {
  canonicalL1BodyHash,
  canonicalL1EnvelopeJson,
  loadL1SchemaRegistry,
  scanWholeL1Validated,
  validateL1Envelope,
  type L1SchemaRoleRegistry,
  type ValidatedL1Envelope,
  type ValidatedL1ScanRecord,
} from "./l1-schema-registry";

const execFileAsync = promisify(execFile);
const PRODUCER_NAME = "pi-astack.canonical-shadow-chain";
const PRODUCER_VERSION = "r3.4.2-p1-s4";
const SHADOW_BODY_SCHEMA = "canonical-path-shadow-event/v1";
const DOSSIER_SCHEMA = "canonical-path-shadow-dossier/v1";
const KNOWLEDGE_ARTIFACT_SCHEMA = "canonical-path-shadow-knowledge-render/v1";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHADOW_SCHEMAS = Object.freeze([
  "knowledge-candidate-observation/v1",
  "knowledge-curator-attempt/v1",
  "knowledge-curator-decision/v1",
  "knowledge-apply-receipt/v1",
  "constraint-genesis/v1",
] as const);

export type CanonicalShadowSchema = typeof SHADOW_SCHEMAS[number];
export type CanonicalShadowDomain = "knowledge" | "constraint";
export type ShadowWriteStatus = "created" | "identical";

export class CanonicalShadowError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CanonicalShadowError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export interface CanonicalShadowEnvelope {
  schema: CanonicalShadowSchema;
  canonicalization: "RFC8785-JCS";
  hash_alg: "sha256";
  event_id: string;
  body_hash: string;
  body: Record<string, JcsJsonValue>;
}

export interface CommittedEventAnchor {
  schema: string;
  eventId: string;
  bodyHash: string;
  envelopeHash: string;
  relativePath: string;
  blobOid: string;
  blobSha256: string;
  sourceGitHead: string;
  sourceRef: string;
  envelope: Readonly<Record<string, unknown>>;
  body: Readonly<Record<string, unknown>>;
}

export interface ShadowEventWriteResult {
  status: ShadowWriteStatus;
  eventId: string;
  filePath: string;
  relativePath: string;
  envelope: CanonicalShadowEnvelope;
}

export interface KnowledgeFoldAnchor {
  identity: string;
  winnerEventId: string;
  inputEventIds: readonly string[];
  inputEventSetHash: string;
  outputMarkdownHash: string;
  projectionKind: "entry";
}

export interface KnowledgeCandidateResult extends ShadowEventWriteResult {
  anchor: CommittedEventAnchor;
  fold: KnowledgeFoldAnchor;
  candidateId: string;
  frozenCuratorInputHash: string;
}

export interface KnowledgeAttemptResult extends ShadowEventWriteResult {
  status: ShadowWriteStatus;
  claimStatus: "winner" | "consumed";
  shouldCurate: boolean;
  claimId: string;
  slot: number;
}

export interface KnowledgeDecisionResult extends ShadowEventWriteResult {
  decision: "accept" | "reject";
  outputHash: string;
  provenanceHash: string;
}

export interface KnowledgeReceiptResult extends ShadowEventWriteResult {
  outputPath: string;
  outputRelativePath: string;
  outputHash: string;
  outputStatus: ShadowWriteStatus;
}

export interface ConstraintGenesisResult extends ShadowEventWriteResult {
  projection: CommittedEventAnchor;
  sourceL2: CommittedFileAnchor;
}

export interface CommittedFileAnchor {
  relativePath: string;
  blobOid: string;
  blobSha256: string;
  worktree_matches_head: boolean;
  worktree_sha256: string;
}

interface GitIdentity {
  root: string;
  head: string;
  ref: string;
}

interface ShadowScanRecord extends ValidatedL1Envelope {
  schema: CanonicalShadowSchema;
  relativePath: string;
  filePath: string;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new CanonicalShadowError(code, message, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail("SHADOW_BODY_INVALID", `${field} must be an object`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) fail("SHADOW_BODY_INVALID", `${field} must be a non-empty string`);
  return value;
}

function requireSha256(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!SHA256_PATTERN.test(text)) fail("SHADOW_HASH_INVALID", `${field} must be lowercase SHA-256`, { value: text });
  return text;
}

function requireGitOid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!GIT_OID_PATTERN.test(text)) fail("SHADOW_GIT_OID_INVALID", `${field} must be a lowercase Git object id`, { value: text });
  return text;
}

function requireExact(value: unknown, expected: unknown, field: string): void {
  if (value !== expected) fail("SHADOW_BODY_INVALID", `${field} must equal ${String(expected)}`, { actual: value });
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort(compareAscii);
  const expected = [...expectedKeys].sort(compareAscii);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("SHADOW_BODY_INVALID", `${field} must contain exactly the approved keys`, { actual, expected });
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateCanonicalShadowRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    fail("SHADOW_RUN_ID_INVALID", "runId must be a path-safe fixed identifier", { runId });
  }
  return runId;
}

export function canonicalShadowRunRoot(shadowAbrainHome: string, domain: CanonicalShadowDomain, runId: string): string {
  validateCanonicalShadowRunId(runId);
  if (domain !== "knowledge" && domain !== "constraint") fail("SHADOW_DOMAIN_INVALID", `unsupported shadow domain: ${String(domain)}`);
  const home = path.resolve(shadowAbrainHome);
  const root = path.resolve(home, "l2", "shadow", "r3", domain, runId);
  if (!pathInside(home, root) || root === home) fail("SHADOW_PATH_ESCAPE", "shadow run root escapes shadowAbrainHome", { root, home });
  return root;
}

export function assertShadowHomeInOsTmp(shadowAbrainHome: string): string {
  const tmp = path.resolve(os.tmpdir());
  const home = path.resolve(shadowAbrainHome);
  if (home === tmp || !pathInside(tmp, home)) {
    fail("SHADOW_HOME_NOT_TEMP", `shadowAbrainHome must be a child of os.tmpdir(): ${tmp}`, { home });
  }
  return home;
}

async function lstatOrNull(file: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fsp.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function ensureDirectoryChain(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathInside(resolvedRoot, resolvedTarget)) fail("SHADOW_PATH_ESCAPE", "directory target escapes guarded root", { root: resolvedRoot, target: resolvedTarget });
  const rootStat = await lstatOrNull(resolvedRoot);
  if (!rootStat) fail("SHADOW_ROOT_MISSING", `guard root does not exist: ${resolvedRoot}`);
  if (rootStat.isSymbolicLink()) fail("SHADOW_SYMLINK_REJECTED", `guard root is a symlink: ${resolvedRoot}`);
  if (!rootStat.isDirectory()) fail("SHADOW_NON_REGULAR", `guard root is not a directory: ${resolvedRoot}`);
  const rootReal = await fsp.realpath(resolvedRoot);
  let current = resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    if (component === "." || component === ".." || component.includes("\0")) fail("SHADOW_PATH_ESCAPE", "invalid path component", { component });
    current = path.join(current, component);
    let stat = await lstatOrNull(current);
    if (!stat) {
      try {
        await fsp.mkdir(current, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      stat = await fsp.lstat(current);
    }
    if (stat.isSymbolicLink()) fail("SHADOW_SYMLINK_REJECTED", `symlink in shadow path: ${current}`);
    if (!stat.isDirectory()) fail("SHADOW_NON_REGULAR", `non-directory in shadow path: ${current}`);
    const real = await fsp.realpath(current);
    if (!pathInside(rootReal, real)) fail("SHADOW_PATH_ESCAPE", `shadow realpath escapes root: ${current}`, { real, rootReal });
  }
}

async function assertSafeCreateTarget(root: string, file: string): Promise<void> {
  if (await lstatOrNull(file)) await assertSafeExistingFile(root, file);
}

async function assertSafeExistingFile(root: string, file: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (!pathInside(resolvedRoot, resolvedFile) || resolvedRoot === resolvedFile) fail("SHADOW_PATH_ESCAPE", "file escapes guarded root", { root, file });
  let current = resolvedRoot;
  const rootStat = await fsp.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("SHADOW_SYMLINK_REJECTED", `unsafe shadow root: ${resolvedRoot}`);
  const rootReal = await fsp.realpath(resolvedRoot);
  const parts = path.relative(resolvedRoot, resolvedFile).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) fail("SHADOW_SYMLINK_REJECTED", `symlink in shadow file path: ${current}`);
    const leaf = index === parts.length - 1;
    if (leaf ? !stat.isFile() : !stat.isDirectory()) fail("SHADOW_NON_REGULAR", `unexpected file type: ${current}`);
    const real = await fsp.realpath(current);
    if (!pathInside(rootReal, real)) fail("SHADOW_PATH_ESCAPE", `shadow file realpath escapes root: ${current}`, { real });
  }
}

export async function initializeCanonicalShadowHome(shadowAbrainHome: string, requireTemp = false): Promise<string> {
  const home = requireTemp ? assertShadowHomeInOsTmp(shadowAbrainHome) : path.resolve(shadowAbrainHome);
  const tmpReal = requireTemp ? await fsp.realpath(path.resolve(os.tmpdir())) : undefined;
  if (!(await lstatOrNull(home))) {
    const parent = path.dirname(home);
    const parentStat = await fsp.lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("SHADOW_SYMLINK_REJECTED", `unsafe shadow home parent: ${parent}`);
    const parentReal = await fsp.realpath(parent);
    if (tmpReal && !pathInside(tmpReal, parentReal)) fail("SHADOW_HOME_NOT_TEMP", "shadow home parent realpath escapes os.tmpdir", { parentReal, tmpReal });
    await fsp.mkdir(home, { mode: 0o700 });
  }
  const stat = await fsp.lstat(home);
  if (stat.isSymbolicLink()) fail("SHADOW_SYMLINK_REJECTED", `shadowAbrainHome is a symlink: ${home}`);
  if (!stat.isDirectory()) fail("SHADOW_NON_REGULAR", `shadowAbrainHome is not a directory: ${home}`);
  const homeReal = await fsp.realpath(home);
  if (tmpReal && !pathInside(tmpReal, homeReal)) fail("SHADOW_HOME_NOT_TEMP", "shadow home realpath escapes os.tmpdir", { homeReal, tmpReal });
  return home;
}

function schemaDomain(schema: CanonicalShadowSchema): CanonicalShadowDomain {
  return schema === "constraint-genesis/v1" ? "constraint" : "knowledge";
}

function registryForShadow(registry?: L1SchemaRoleRegistry): L1SchemaRoleRegistry {
  const selected = registry ?? loadL1SchemaRegistry();
  for (const schema of SHADOW_SCHEMAS) {
    const entry = selected.entries.find((item) => item.envelope_schema === schema);
    if (!entry || entry.phase !== "phase_disabled" || entry.write_enabled || entry.fold_eligible || entry.role !== "meta") {
      fail("SHADOW_REGISTRY_PHASE_DRIFT", `${schema} must remain phase_disabled, non-writable, non-foldable meta`);
    }
  }
  return selected;
}

export function createCanonicalShadowEnvelope(
  schema: CanonicalShadowSchema,
  body: Record<string, JcsJsonValue>,
  registry?: L1SchemaRoleRegistry,
): CanonicalShadowEnvelope {
  if (!SHADOW_SCHEMAS.includes(schema)) fail("SHADOW_SCHEMA_FORBIDDEN", `schema is not approved for S4 shadow: ${String(schema)}`);
  const selected = registryForShadow(registry);
  const bodyHash = canonicalL1BodyHash(body);
  const envelope: CanonicalShadowEnvelope = {
    schema,
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
  validateL1Envelope(envelope, {
    registry: selected,
    expected: { envelopeSchema: schema, role: "meta", phase: "phase_disabled" },
  });
  validateShadowBody(schema, body);
  return envelope;
}

function shadowEventRelativePath(eventId: string): string {
  requireSha256(eventId, "eventId");
  return `events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

export async function writeCanonicalShadowEvent(options: {
  shadowAbrainHome: string;
  runId: string;
  schema: CanonicalShadowSchema;
  body: Record<string, JcsJsonValue>;
  registry?: L1SchemaRoleRegistry;
}): Promise<ShadowEventWriteResult> {
  const home = await initializeCanonicalShadowHome(options.shadowAbrainHome);
  const envelope = createCanonicalShadowEnvelope(options.schema, options.body, options.registry);
  requireExact(options.body.run_id, options.runId, "body.run_id");
  const runRoot = canonicalShadowRunRoot(home, schemaDomain(options.schema), options.runId);
  const relativePath = shadowEventRelativePath(envelope.event_id);
  const filePath = path.resolve(runRoot, ...relativePath.split("/"));
  if (!pathInside(runRoot, filePath)) fail("SHADOW_PATH_ESCAPE", "event target escapes run root", { filePath });
  await ensureDirectoryChain(home, path.dirname(filePath));
  await assertSafeCreateTarget(runRoot, filePath);
  const status = await durableAtomicCreateFile(filePath, canonicalL1EnvelopeJson(envelope), { mode: 0o600 });
  if (status === "collision") fail("SHADOW_EVENT_COLLISION", `different bytes occupy content-addressed event path: ${filePath}`);
  await assertSafeExistingFile(runRoot, filePath);
  const parsed = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
  const validated = validateL1Envelope(parsed, { registry: registryForShadow(options.registry), expected: { envelopeSchema: options.schema, phase: "phase_disabled" } });
  if (validated.eventId !== envelope.event_id) fail("SHADOW_EVENT_READBACK_MISMATCH", "event read-back id differs");
  return { status, eventId: envelope.event_id, filePath, relativePath, envelope };
}

function baseBody(kind: string, runId: string, provenance: Record<string, JcsJsonValue>, inputHashes: Record<string, JcsJsonValue>): Record<string, JcsJsonValue> {
  return {
    shadow_schema_version: SHADOW_BODY_SCHEMA,
    event_kind: kind,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
    run_id: validateCanonicalShadowRunId(runId),
    provenance,
    input_hashes: inputHashes,
  };
}

async function git(repo: string, args: string[], options: { timeout?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      timeout: options.timeout ?? 15_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=5",
      },
    });
    return stdout;
  } catch (err) {
    const stderr = isRecord(err) && typeof err.stderr === "string" ? err.stderr.trim() : "";
    fail("SHADOW_GIT_FAILED", `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { repo });
  }
}

async function gitBytes(repo: string, args: string[], options: { timeout?: number } = {}): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      encoding: "buffer",
      timeout: options.timeout ?? 15_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=5",
      },
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (err) {
    const stderrValue = isRecord(err) ? err.stderr : undefined;
    const stderr = Buffer.isBuffer(stderrValue) ? stderrValue.toString("utf8").trim() : typeof stderrValue === "string" ? stderrValue.trim() : "";
    fail("SHADOW_GIT_FAILED", `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { repo });
  }
}

async function gitIdentity(sourceAbrainHome: string): Promise<GitIdentity> {
  const root = path.resolve(sourceAbrainHome);
  const stat = await fsp.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("SHADOW_SOURCE_UNSAFE", `sourceAbrainHome must be a real directory: ${root}`);
  const top = path.resolve((await git(root, ["rev-parse", "--show-toplevel"])).trim());
  if (top !== root) fail("SHADOW_SOURCE_NOT_REPO_ROOT", "sourceAbrainHome must be the Git worktree root", { root, top });
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const refOut = await execFileAsync("git", ["-C", root, "symbolic-ref", "-q", "HEAD"], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).then((value) => value.stdout.trim()).catch(() => "DETACHED");
  return { root, head, ref: refOut || "DETACHED" };
}

function safeGitRelativePath(relativePath: string): string {
  const normalized = relativePath.split("\\").join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some((item) => item === "" || item === "." || item === "..")) {
    fail("SHADOW_SOURCE_PATH_INVALID", "source path is not a safe Git relative path", { relativePath });
  }
  return normalized;
}

async function committedBlob(repo: string, head: string, relativePath: string): Promise<{ oid: string; bytes: Buffer }> {
  const relative = safeGitRelativePath(relativePath);
  await git(repo, ["cat-file", "-e", `${head}:${relative}`]);
  const treeLine = await git(repo, ["ls-tree", "-z", head, "--", relative]);
  const match = /^[0-7]{6} blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(treeLine);
  if (!match || match[2] !== relative) fail("SHADOW_SOURCE_NOT_COMMITTED", `HEAD does not contain a regular blob at ${relative}`);
  const oid = match[1]!;
  const bytes = await gitBytes(repo, ["cat-file", "blob", oid]);
  return { oid, bytes };
}

async function proveCommittedRecord(identity: GitIdentity, record: ValidatedL1ScanRecord): Promise<CommittedEventAnchor> {
  const relativePath = safeGitRelativePath(requireString(record.relativePath, "record.relativePath"));
  const absolute = path.resolve(identity.root, ...relativePath.split("/"));
  if (!pathInside(identity.root, absolute)) fail("SHADOW_SOURCE_PATH_INVALID", "event path escapes source root", { relativePath });
  const stat = await fsp.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("SHADOW_SOURCE_UNSAFE", `source event is not a regular file: ${relativePath}`);
  const real = await fsp.realpath(absolute);
  const rootReal = await fsp.realpath(identity.root);
  if (!pathInside(rootReal, real)) fail("SHADOW_SOURCE_PATH_INVALID", `source event realpath escapes repository: ${relativePath}`);
  const worktreeBytes = await fsp.readFile(absolute);
  const committed = await committedBlob(identity.root, identity.head, relativePath);
  if (!worktreeBytes.equals(committed.bytes)) fail("SHADOW_SOURCE_UNCOMMITTED", `source event differs from HEAD: ${relativePath}`);
  const committedEnvelope = JSON.parse(committed.bytes.toString("utf8")) as unknown;
  const validated = validateL1Envelope(committedEnvelope, { registry: loadL1SchemaRegistry(), expected: { envelopeSchema: record.registration.envelope_schema } });
  if (validated.eventId !== record.eventId || validated.envelopeHash !== record.envelopeHash) {
    fail("SHADOW_SOURCE_ANCHOR_MISMATCH", `worktree scan and committed event differ: ${relativePath}`);
  }
  return {
    schema: record.registration.envelope_schema,
    eventId: record.eventId,
    bodyHash: record.bodyHash,
    envelopeHash: record.envelopeHash,
    relativePath,
    blobOid: committed.oid,
    blobSha256: sha256Hex(committed.bytes),
    sourceGitHead: identity.head,
    sourceRef: identity.ref,
    envelope: validated.envelope,
    body: validated.body,
  };
}

function eventTimestamp(record: { body: Readonly<Record<string, unknown>> }): string {
  const value = record.body.created_at_utc;
  return typeof value === "string" ? value : "";
}

export async function selectCommittedProductionEvent(options: {
  sourceAbrainHome: string;
  schema: "knowledge-evidence-envelope/v1" | "constraint-projection-envelope/v1";
  eventId?: string;
}): Promise<CommittedEventAnchor> {
  const identity = await gitIdentity(options.sourceAbrainHome);
  const scan = await scanWholeL1Validated({ abrainHome: identity.root });
  let records = scan.all.filter((item) => item.registration.envelope_schema === options.schema);
  if (options.eventId !== undefined) {
    requireSha256(options.eventId, "eventId");
    records = records.filter((item) => item.eventId === options.eventId);
    if (records.length !== 1) fail("SHADOW_SOURCE_EVENT_MISSING", `requested ${options.schema} event is absent`, { eventId: options.eventId });
    return proveCommittedRecord(identity, records[0]!);
  }
  records.sort((left, right) => compareAscii(eventTimestamp(right), eventTimestamp(left)) || compareAscii(right.eventId, left.eventId));
  for (const record of records) {
    try {
      return await proveCommittedRecord(identity, record);
    } catch (err) {
      if (!(err instanceof CanonicalShadowError) || !["SHADOW_GIT_FAILED", "SHADOW_SOURCE_UNCOMMITTED", "SHADOW_SOURCE_NOT_COMMITTED"].includes(err.code)) throw err;
    }
  }
  fail("SHADOW_SOURCE_EVENT_MISSING", `no committed ${options.schema} event is available at HEAD`);
}

async function committedProductionAnchors(
  identity: GitIdentity,
  schema: "knowledge-evidence-envelope/v1" | "constraint-projection-envelope/v1",
): Promise<CommittedEventAnchor[]> {
  const scan = await scanWholeL1Validated({ abrainHome: identity.root });
  const anchors: CommittedEventAnchor[] = [];
  for (const record of scan.all.filter((item) => item.registration.envelope_schema === schema)) {
    try {
      anchors.push(await proveCommittedRecord(identity, record));
    } catch (err) {
      if (!(err instanceof CanonicalShadowError) || !["SHADOW_GIT_FAILED", "SHADOW_SOURCE_UNCOMMITTED", "SHADOW_SOURCE_NOT_COMMITTED", "SHADOW_SOURCE_UNSAFE"].includes(err.code)) throw err;
    }
  }
  return anchors;
}

export async function selectCommittedKnowledgeFoldWinner(options: {
  sourceAbrainHome: string;
  eventId?: string;
}): Promise<{ anchor: CommittedEventAnchor; fold: KnowledgeFoldAnchor }> {
  const identity = await gitIdentity(options.sourceAbrainHome);
  const anchors = await committedProductionAnchors(identity, "knowledge-evidence-envelope/v1");
  const byIdentity = new Map<string, CommittedEventAnchor[]>();
  for (const anchor of anchors) {
    const body = anchor.body as unknown as KnowledgeEvidenceEventBodyV1;
    const key = knowledgeIdentityKey(body);
    const group = byIdentity.get(key) ?? [];
    group.push(anchor);
    byIdentity.set(key, group);
  }
  const winners: Array<{ anchor: CommittedEventAnchor; fold: KnowledgeFoldAnchor }> = [];
  for (const [foldIdentity, group] of byIdentity) {
    const nodes: KnowledgeEventNode[] = group.map((anchor) => ({ eventId: anchor.eventId, body: anchor.body as unknown as KnowledgeEvidenceEventBodyV1 }));
    const projection = renderKnowledgeProjectionFromSet(nodes);
    const winner = group.find((anchor) => anchor.eventId === projection.winnerEventId);
    if (!winner || projection.kind !== "entry" || !projection.markdown) continue;
    const winnerBody = winner.body as unknown as KnowledgeEvidenceEventBodyV1;
    if (winnerBody.payload.status !== "active") continue;
    const inputEventIds = nodes.map((node) => node.eventId).sort(compareAscii);
    winners.push({
      anchor: winner,
      fold: {
        identity: foldIdentity,
        winnerEventId: winner.eventId,
        inputEventIds: Object.freeze(inputEventIds),
        inputEventSetHash: projection.inputEventSetHash,
        outputMarkdownHash: sha256Hex(projection.markdown),
        projectionKind: "entry",
      },
    });
  }
  if (options.eventId !== undefined) {
    requireSha256(options.eventId, "eventId");
    const selected = winners.find((item) => item.anchor.eventId === options.eventId);
    if (!selected) {
      fail("SHADOW_KNOWLEDGE_SOURCE_NOT_ACTIVE_WINNER", "requested knowledge event is not a committed active canonical fold winner", { eventId: options.eventId });
    }
    return selected;
  }
  winners.sort((left, right) => compareAscii(eventTimestamp(right.anchor), eventTimestamp(left.anchor)) || compareAscii(right.anchor.eventId, left.anchor.eventId));
  const selected = winners[0];
  if (!selected) fail("SHADOW_SOURCE_EVENT_MISSING", "no committed active knowledge fold winner is available at HEAD");
  return selected;
}

export function deriveFrozenCuratorInputHash(input: {
  runId: string;
  sourceEventId: string;
  sourceBodyHash: string;
  sourceEnvelopeHash: string;
  sourceGitHead: string;
}): string {
  validateCanonicalShadowRunId(input.runId);
  requireSha256(input.sourceEventId, "sourceEventId");
  requireSha256(input.sourceBodyHash, "sourceBodyHash");
  requireSha256(input.sourceEnvelopeHash, "sourceEnvelopeHash");
  requireGitOid(input.sourceGitHead, "sourceGitHead");
  return jcsSha256Hex({
    domain: "canonical-path-r3.4.2/knowledge-curator-input/v1",
    run_id: input.runId,
    source_event_id: input.sourceEventId,
    source_body_hash: input.sourceBodyHash,
    source_envelope_hash: input.sourceEnvelopeHash,
    source_git_head: input.sourceGitHead,
  });
}

export async function createKnowledgeCandidateObservation(options: {
  sourceAbrainHome: string;
  shadowAbrainHome: string;
  runId: string;
  sourceEventId?: string;
}): Promise<KnowledgeCandidateResult> {
  const selected = await selectCommittedKnowledgeFoldWinner({
    sourceAbrainHome: options.sourceAbrainHome,
    eventId: options.sourceEventId,
  });
  const { anchor, fold } = selected;
  const frozenCuratorInputHash = deriveFrozenCuratorInputHash({
    runId: options.runId,
    sourceEventId: anchor.eventId,
    sourceBodyHash: anchor.bodyHash,
    sourceEnvelopeHash: anchor.envelopeHash,
    sourceGitHead: anchor.sourceGitHead,
  });
  const candidateId = jcsSha256Hex({
    domain: "canonical-path-r3.4.2/knowledge-candidate/v1",
    run_id: options.runId,
    source_event_id: anchor.eventId,
    frozen_curator_input_hash: frozenCuratorInputHash,
  });
  const provenance = {
    mode: "replay-existing-accepted-fold-winner",
    source_git_head: anchor.sourceGitHead,
    source_ref: anchor.sourceRef,
    source_relative_path: anchor.relativePath,
    source_blob_oid: anchor.blobOid,
    source_blob_sha256: anchor.blobSha256,
    fold_identity: fold.identity,
    fold_input_event_ids_hash: jcsSha256Hex(fold.inputEventIds),
    fold_input_event_set_hash: fold.inputEventSetHash,
    fold_output_markdown_hash: fold.outputMarkdownHash,
  } satisfies Record<string, JcsJsonValue>;
  const body = {
    ...baseBody("knowledge_candidate_observation", options.runId, provenance, {
      source_body_hash: anchor.bodyHash,
      source_envelope_hash: anchor.envelopeHash,
      frozen_curator_input_hash: frozenCuratorInputHash,
    }),
    sequence: 1,
    candidate_id: candidateId,
    source_evidence_event_id: anchor.eventId,
    source_evidence_schema: "knowledge-evidence-envelope/v1",
    source_evidence_body_hash: anchor.bodyHash,
    source_evidence_envelope_hash: anchor.envelopeHash,
    source_committed_at_head: true,
    production_acceptance_fact: "existing_committed_active_canonical_fold_winner",
    source_fold_identity: fold.identity,
    source_fold_winner_event_id: fold.winnerEventId,
    source_fold_input_event_ids: [...fold.inputEventIds],
    source_fold_input_event_set_hash: fold.inputEventSetHash,
    source_fold_output_markdown_hash: fold.outputMarkdownHash,
    source_fold_projection_kind: fold.projectionKind,
    canonical_fold_eligible: false,
  } satisfies Record<string, JcsJsonValue>;
  const written = await writeCanonicalShadowEvent({ ...options, schema: "knowledge-candidate-observation/v1", body });
  return { ...written, anchor, fold, candidateId, frozenCuratorInputHash };
}

function knowledgeAttemptClaimId(runId: string, candidateEventId: string, slot: number, frozenCuratorInputHash: string): string {
  return jcsSha256Hex({
    domain: "canonical-path-r3.4.2/knowledge-attempt-claim/v1",
    run_id: runId,
    candidate_event_id: candidateEventId,
    slot,
    frozen_curator_input_hash: frozenCuratorInputHash,
  });
}

export async function claimKnowledgeCuratorAttempt(options: {
  shadowAbrainHome: string;
  runId: string;
  candidateEventId: string;
  slot: number;
  frozenCuratorInputHash: string;
}): Promise<KnowledgeAttemptResult> {
  requireSha256(options.candidateEventId, "candidateEventId");
  requireSha256(options.frozenCuratorInputHash, "frozenCuratorInputHash");
  if (!Number.isInteger(options.slot) || options.slot < 1 || options.slot > 3) fail("SHADOW_ATTEMPT_SLOT_INVALID", "knowledge curator slot must be 1..3", { slot: options.slot });
  const claimId = knowledgeAttemptClaimId(options.runId, options.candidateEventId, options.slot, options.frozenCuratorInputHash);
  const body = {
    ...baseBody("knowledge_curator_attempt", options.runId, {
      mode: "deterministic-atomic-no-replace-claim",
      candidate_event_id: options.candidateEventId,
    }, {
      frozen_curator_input_hash: options.frozenCuratorInputHash,
    }),
    sequence: 2,
    candidate_event_id: options.candidateEventId,
    slot: options.slot,
    frozen_curator_input_hash: options.frozenCuratorInputHash,
    claim_id: claimId,
    claim_bytes_domain: "run/candidate/slot/frozen_curator_input_hash",
    canonical_fold_eligible: false,
  } satisfies Record<string, JcsJsonValue>;
  const written = await writeCanonicalShadowEvent({ ...options, schema: "knowledge-curator-attempt/v1", body });
  return {
    ...written,
    claimStatus: written.status === "created" ? "winner" : "consumed",
    shouldCurate: written.status === "created",
    claimId,
    slot: options.slot,
  };
}

async function readShadowEventById(shadowAbrainHome: string, domain: CanonicalShadowDomain, runId: string, eventId: string): Promise<ShadowScanRecord> {
  requireSha256(eventId, "eventId");
  const runRoot = canonicalShadowRunRoot(shadowAbrainHome, domain, runId);
  const filePath = path.resolve(runRoot, ...shadowEventRelativePath(eventId).split("/"));
  await assertSafeExistingFile(runRoot, filePath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") fail("SHADOW_CHAIN_MISSING", `shadow event is missing: ${eventId}`);
    throw err;
  });
  const parsed = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
  const validated = validateL1Envelope(parsed, { registry: registryForShadow() });
  const schema = validated.registration.envelope_schema as CanonicalShadowSchema;
  if (!SHADOW_SCHEMAS.includes(schema) || schemaDomain(schema) !== domain) fail("SHADOW_SCHEMA_FORBIDDEN", `unexpected shadow schema: ${schema}`);
  validateShadowBody(schema, validated.body as Record<string, unknown>);
  requireExact(validated.body.run_id, runId, "shadow event body.run_id");
  return { ...validated, schema, relativePath: shadowEventRelativePath(eventId), filePath };
}

function renderKnowledgeArtifact(candidate: ShadowScanRecord, attempt: ShadowScanRecord, decision: "accept" | "reject"): string {
  const candidateBody = candidate.body as Record<string, unknown>;
  return `${canonicalizeJcs({
    schema_version: KNOWLEDGE_ARTIFACT_SCHEMA,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
    run_id: candidateBody.run_id,
    candidate_event_id: candidate.eventId,
    attempt_event_id: attempt.eventId,
    replayed_production_event_id: candidateBody.source_evidence_event_id,
    replayed_production_body_hash: candidateBody.source_evidence_body_hash,
    decision,
    canonical_target: null,
    canonical_applied: false,
  })}\n`;
}

export async function createKnowledgeCuratorDecision(options: {
  shadowAbrainHome: string;
  runId: string;
  candidateEventId: string;
  attemptEventId: string;
  decision: "accept" | "reject";
}): Promise<KnowledgeDecisionResult> {
  if (options.decision !== "accept" && options.decision !== "reject") fail("SHADOW_DECISION_INVALID", "decision must be accept or reject");
  const candidate = await readShadowEventById(options.shadowAbrainHome, "knowledge", options.runId, options.candidateEventId);
  const attempt = await readShadowEventById(options.shadowAbrainHome, "knowledge", options.runId, options.attemptEventId);
  if (candidate.schema !== "knowledge-candidate-observation/v1" || attempt.schema !== "knowledge-curator-attempt/v1") fail("SHADOW_CHAIN_BROKEN", "decision requires candidate then attempt");
  const candidateBody = candidate.body as Record<string, unknown>;
  const attemptBody = attempt.body as Record<string, unknown>;
  const candidateInputHashes = requireRecord(candidateBody.input_hashes, "candidate.input_hashes");
  const frozenHash = requireSha256(candidateInputHashes.frozen_curator_input_hash, "candidate.input_hashes.frozen_curator_input_hash");
  if (attemptBody.candidate_event_id !== candidate.eventId || attemptBody.frozen_curator_input_hash !== frozenHash) fail("SHADOW_CHAIN_BROKEN", "attempt does not bind candidate frozen input");
  const output = renderKnowledgeArtifact(candidate, attempt, options.decision);
  const outputHash = sha256Hex(output);
  const provenanceHash = jcsSha256Hex({
    mode: "replay-existing-accepted-fold-winner",
    source_event_id: candidateBody.source_evidence_event_id,
    source_git_head: requireRecord(candidateBody.provenance, "candidate.provenance").source_git_head,
    candidate_event_id: candidate.eventId,
    attempt_event_id: attempt.eventId,
  });
  const body = {
    ...baseBody("knowledge_curator_decision", options.runId, {
      mode: "replay-existing-accepted-fold-winner",
      provenance_hash: provenanceHash,
      historical_llm_rerun: false,
      new_model_judgment: false,
    }, {
      curator_input_hash: frozenHash,
      curator_output_hash: outputHash,
      provenance_hash: provenanceHash,
    }),
    sequence: 3,
    candidate_event_id: candidate.eventId,
    attempt_event_id: attempt.eventId,
    attempt_slot: attemptBody.slot as number,
    source_evidence_event_id: candidateBody.source_evidence_event_id as string,
    source_evidence_body_hash: candidateBody.source_evidence_body_hash as string,
    decision: options.decision,
    curator_input_hash: frozenHash,
    curator_output_hash: outputHash,
    decision_provenance_hash: provenanceHash,
    canonical_fold_eligible: false,
    canonical_applied: false,
    canonical_apply_count: 0,
  } satisfies Record<string, JcsJsonValue>;
  const written = await writeCanonicalShadowEvent({ ...options, schema: "knowledge-curator-decision/v1", body });
  return { ...written, decision: options.decision, outputHash, provenanceHash };
}

function outputRelativePath(outputHash: string): string {
  requireSha256(outputHash, "outputHash");
  return `outputs/sha256/${outputHash.slice(0, 2)}/${outputHash.slice(2, 4)}/${outputHash}.json`;
}

export async function createKnowledgeApplyReceipt(options: {
  shadowAbrainHome: string;
  runId: string;
  decisionEventId: string;
}): Promise<KnowledgeReceiptResult> {
  const decision = await readShadowEventById(options.shadowAbrainHome, "knowledge", options.runId, options.decisionEventId);
  if (decision.schema !== "knowledge-curator-decision/v1") fail("SHADOW_CHAIN_BROKEN", "apply receipt requires a curator decision");
  const decisionBody = decision.body as Record<string, unknown>;
  if (decisionBody.decision !== "accept") fail("SHADOW_APPLY_REJECTED", "a rejected decision cannot produce an apply receipt");
  const candidateId = requireSha256(decisionBody.candidate_event_id, "decision.candidate_event_id");
  const attemptId = requireSha256(decisionBody.attempt_event_id, "decision.attempt_event_id");
  const candidate = await readShadowEventById(options.shadowAbrainHome, "knowledge", options.runId, candidateId);
  const attempt = await readShadowEventById(options.shadowAbrainHome, "knowledge", options.runId, attemptId);
  const output = renderKnowledgeArtifact(candidate, attempt, "accept");
  const outputHash = sha256Hex(output);
  requireExact(decisionBody.curator_output_hash, outputHash, "decision.curator_output_hash");
  const runRoot = canonicalShadowRunRoot(options.shadowAbrainHome, "knowledge", options.runId);
  const outputRel = outputRelativePath(outputHash);
  const outputPath = path.resolve(runRoot, ...outputRel.split("/"));
  await ensureDirectoryChain(path.resolve(options.shadowAbrainHome), path.dirname(outputPath));
  await assertSafeCreateTarget(runRoot, outputPath);
  const outputStatusRaw = await durableAtomicCreateFile(outputPath, output, { mode: 0o600 });
  if (outputStatusRaw === "collision") fail("SHADOW_OUTPUT_COLLISION", `different bytes occupy output path: ${outputPath}`);
  await assertSafeExistingFile(runRoot, outputPath);
  const outputBytes = await fsp.readFile(outputPath);
  if (sha256Hex(outputBytes) !== outputHash) fail("SHADOW_OUTPUT_HASH_MISMATCH", "rendered output read-back hash mismatch");
  const body = {
    ...baseBody("knowledge_apply_receipt", options.runId, {
      mode: "isolated-shadow-output-only",
      decision_event_id: decision.eventId,
    }, {
      decision_output_hash: outputHash,
      rendered_output_hash: outputHash,
    }),
    sequence: 4,
    candidate_event_id: candidate.eventId,
    attempt_event_id: attempt.eventId,
    decision_event_id: decision.eventId,
    decision_output_hash: outputHash,
    rendered_output_hash: outputHash,
    output_relative_path: outputRel,
    output_namespace: "same-run-isolated-shadow",
    canonical_fold_eligible: false,
    canonical_applied: false,
    canonical_apply_count: 0,
    zero_canonical_apply: true,
  } satisfies Record<string, JcsJsonValue>;
  const written = await writeCanonicalShadowEvent({ ...options, schema: "knowledge-apply-receipt/v1", body });
  return { ...written, outputPath, outputRelativePath: outputRel, outputHash, outputStatus: outputStatusRaw };
}

async function scanShadowRun(shadowAbrainHome: string, domain: CanonicalShadowDomain, runId: string): Promise<ShadowScanRecord[]> {
  const runRoot = canonicalShadowRunRoot(shadowAbrainHome, domain, runId);
  const eventsRoot = path.join(runRoot, "events", "sha256");
  if (!(await lstatOrNull(eventsRoot))) return [];
  const records: ShadowScanRecord[] = [];
  const firstEntries = (await fsp.readdir(eventsRoot, { withFileTypes: true })).sort((a, b) => compareAscii(a.name, b.name));
  for (const first of firstEntries) {
    if (!/^[0-9a-f]{2}$/.test(first.name)) fail("SHADOW_PATH_INVALID", `invalid first shard: ${first.name}`);
    const firstPath = path.join(eventsRoot, first.name);
    if (first.isSymbolicLink() || !first.isDirectory()) fail("SHADOW_SYMLINK_REJECTED", `unsafe first shard: ${firstPath}`);
    for (const second of (await fsp.readdir(firstPath, { withFileTypes: true })).sort((a, b) => compareAscii(a.name, b.name))) {
      if (!/^[0-9a-f]{2}$/.test(second.name)) fail("SHADOW_PATH_INVALID", `invalid second shard: ${second.name}`);
      const secondPath = path.join(firstPath, second.name);
      if (second.isSymbolicLink() || !second.isDirectory()) fail("SHADOW_SYMLINK_REJECTED", `unsafe second shard: ${secondPath}`);
      for (const leaf of (await fsp.readdir(secondPath, { withFileTypes: true })).sort((a, b) => compareAscii(a.name, b.name))) {
        const match = /^([0-9a-f]{64})\.json$/.exec(leaf.name);
        if (!match || leaf.isSymbolicLink() || !leaf.isFile()) fail("SHADOW_PATH_INVALID", `invalid event leaf: ${path.join(secondPath, leaf.name)}`);
        const eventId = match[1]!;
        if (first.name !== eventId.slice(0, 2) || second.name !== eventId.slice(2, 4)) fail("SHADOW_PATH_INVALID", `event shard does not match id: ${eventId}`);
        records.push(await readShadowEventById(shadowAbrainHome, domain, runId, eventId));
      }
    }
  }
  return records.sort((left, right) => compareAscii(left.eventId, right.eventId));
}

export interface ValidatedKnowledgeShadowChain {
  candidate: ShadowScanRecord;
  attempts: readonly ShadowScanRecord[];
  decision: ShadowScanRecord;
  receipt: ShadowScanRecord;
  outputPath: string;
  chainHash: string;
}

export async function validateKnowledgeShadowChain(options: {
  shadowAbrainHome: string;
  runId: string;
}): Promise<ValidatedKnowledgeShadowChain> {
  const records = await scanShadowRun(options.shadowAbrainHome, "knowledge", options.runId);
  const candidates = records.filter((item) => item.schema === "knowledge-candidate-observation/v1");
  const attempts = records.filter((item) => item.schema === "knowledge-curator-attempt/v1");
  const decisions = records.filter((item) => item.schema === "knowledge-curator-decision/v1");
  const receipts = records.filter((item) => item.schema === "knowledge-apply-receipt/v1");
  if (candidates.length !== 1 || decisions.length !== 1 || receipts.length !== 1 || attempts.length < 1 || attempts.length > 3) {
    fail("SHADOW_CHAIN_INCOMPLETE", "knowledge chain must contain exactly E1, E2, E3 and one to three attempts", {
      candidates: candidates.length, attempts: attempts.length, decisions: decisions.length, receipts: receipts.length,
    });
  }
  const candidate = candidates[0]!;
  const decision = decisions[0]!;
  const receipt = receipts[0]!;
  const candidateBody = candidate.body as Record<string, unknown>;
  const candidateHashes = requireRecord(candidateBody.input_hashes, "candidate.input_hashes");
  const candidateProvenance = requireRecord(candidateBody.provenance, "candidate.provenance");
  const sourceEventId = requireSha256(candidateBody.source_evidence_event_id, "candidate.source_evidence_event_id");
  const sourceBodyHash = requireSha256(candidateBody.source_evidence_body_hash, "candidate.source_evidence_body_hash");
  const sourceEnvelopeHash = requireSha256(candidateBody.source_evidence_envelope_hash, "candidate.source_evidence_envelope_hash");
  const frozenHash = deriveFrozenCuratorInputHash({
    runId: options.runId,
    sourceEventId,
    sourceBodyHash,
    sourceEnvelopeHash,
    sourceGitHead: requireGitOid(candidateProvenance.source_git_head, "candidate.provenance.source_git_head"),
  });
  requireExact(candidateHashes.source_body_hash, sourceBodyHash, "candidate.input_hashes.source_body_hash");
  requireExact(candidateHashes.source_envelope_hash, sourceEnvelopeHash, "candidate.input_hashes.source_envelope_hash");
  requireExact(candidateHashes.frozen_curator_input_hash, frozenHash, "candidate.input_hashes.frozen_curator_input_hash");
  requireExact(candidateBody.candidate_id, jcsSha256Hex({
    domain: "canonical-path-r3.4.2/knowledge-candidate/v1",
    run_id: options.runId,
    source_event_id: sourceEventId,
    frozen_curator_input_hash: frozenHash,
  }), "candidate.candidate_id");
  const slots = new Set<number>();
  for (const attempt of attempts) {
    const body = attempt.body as Record<string, unknown>;
    const slot = body.slot;
    if (!Number.isInteger(slot) || (slot as number) < 1 || (slot as number) > 3 || slots.has(slot as number)) fail("SHADOW_CHAIN_ORDER", "attempt slots must be unique and in 1..3");
    slots.add(slot as number);
    requireExact(body.sequence, 2, "attempt.sequence");
    requireExact(body.candidate_event_id, candidate.eventId, "attempt.candidate_event_id");
    requireExact(body.frozen_curator_input_hash, frozenHash, "attempt.frozen_curator_input_hash");
    requireExact(body.claim_id, knowledgeAttemptClaimId(options.runId, candidate.eventId, slot as number, frozenHash), "attempt.claim_id");
  }
  const orderedSlots = [...slots].sort((left, right) => left - right);
  if (orderedSlots.some((slot, index) => slot !== index + 1)) {
    fail("SHADOW_CHAIN_ORDER", "attempt slots must be contiguous from 1 with no gaps", { slots: orderedSlots });
  }
  const decisionBody = decision.body as Record<string, unknown>;
  requireExact(candidateBody.sequence, 1, "candidate.sequence");
  requireExact(decisionBody.sequence, 3, "decision.sequence");
  requireExact(decisionBody.candidate_event_id, candidate.eventId, "decision.candidate_event_id");
  const boundAttempt = attempts.find((item) => item.eventId === decisionBody.attempt_event_id);
  if (!boundAttempt) fail("SHADOW_CHAIN_BROKEN", "decision references a missing attempt");
  requireExact(decisionBody.attempt_slot, boundAttempt.body.slot, "decision.attempt_slot");
  requireExact(decisionBody.curator_input_hash, frozenHash, "decision.curator_input_hash");
  requireExact(decisionBody.source_evidence_event_id, sourceEventId, "decision.source_evidence_event_id");
  requireExact(decisionBody.source_evidence_body_hash, sourceBodyHash, "decision.source_evidence_body_hash");
  const decisionProvenanceHash = jcsSha256Hex({
    mode: "replay-existing-accepted-fold-winner",
    source_event_id: sourceEventId,
    source_git_head: candidateProvenance.source_git_head,
    candidate_event_id: candidate.eventId,
    attempt_event_id: boundAttempt.eventId,
  });
  requireExact(decisionBody.decision_provenance_hash, decisionProvenanceHash, "decision.decision_provenance_hash");
  const decisionHashes = requireRecord(decisionBody.input_hashes, "decision.input_hashes");
  requireExact(decisionHashes.curator_input_hash, frozenHash, "decision.input_hashes.curator_input_hash");
  requireExact(decisionHashes.provenance_hash, decisionProvenanceHash, "decision.input_hashes.provenance_hash");
  if (decisionBody.decision !== "accept") fail("SHADOW_CHAIN_INCOMPLETE", "an E3 receipt requires an accepted E2 decision");
  const expectedOutput = renderKnowledgeArtifact(candidate, boundAttempt, "accept");
  const outputHash = sha256Hex(expectedOutput);
  requireExact(decisionBody.curator_output_hash, outputHash, "decision.curator_output_hash");
  requireExact(decisionBody.canonical_fold_eligible, false, "decision.canonical_fold_eligible");
  requireExact(decisionBody.canonical_applied, false, "decision.canonical_applied");
  const receiptBody = receipt.body as Record<string, unknown>;
  requireExact(receiptBody.sequence, 4, "receipt.sequence");
  requireExact(receiptBody.candidate_event_id, candidate.eventId, "receipt.candidate_event_id");
  requireExact(receiptBody.attempt_event_id, boundAttempt.eventId, "receipt.attempt_event_id");
  requireExact(receiptBody.decision_event_id, decision.eventId, "receipt.decision_event_id");
  requireExact(receiptBody.decision_output_hash, outputHash, "receipt.decision_output_hash");
  requireExact(receiptBody.rendered_output_hash, outputHash, "receipt.rendered_output_hash");
  const receiptHashes = requireRecord(receiptBody.input_hashes, "receipt.input_hashes");
  requireExact(receiptHashes.decision_output_hash, outputHash, "receipt.input_hashes.decision_output_hash");
  requireExact(receiptHashes.rendered_output_hash, outputHash, "receipt.input_hashes.rendered_output_hash");
  requireExact(receiptBody.zero_canonical_apply, true, "receipt.zero_canonical_apply");
  requireExact(receiptBody.canonical_applied, false, "receipt.canonical_applied");
  const outputRel = requireString(receiptBody.output_relative_path, "receipt.output_relative_path");
  requireExact(outputRel, outputRelativePath(outputHash), "receipt.output_relative_path");
  const runRoot = canonicalShadowRunRoot(options.shadowAbrainHome, "knowledge", options.runId);
  const outputPath = path.resolve(runRoot, ...outputRel.split("/"));
  await assertSafeExistingFile(runRoot, outputPath);
  const bytes = await fsp.readFile(outputPath);
  if (sha256Hex(bytes) !== outputHash || bytes.toString("utf8") !== expectedOutput) fail("SHADOW_OUTPUT_HASH_MISMATCH", "chain output bytes do not match decision");
  const chainHash = jcsSha256Hex({
    candidate_event_id: candidate.eventId,
    attempt_event_ids: attempts.map((item) => item.eventId).sort(compareAscii),
    decision_event_id: decision.eventId,
    receipt_event_id: receipt.eventId,
    output_hash: outputHash,
  });
  return { candidate, attempts: Object.freeze(attempts.slice()), decision, receipt, outputPath, chainHash };
}

function validateProjectionAnchor(anchor: CommittedEventAnchor): {
  decisionValidationHash: string;
  decisionInputRootHash: string;
  decisionObjectHash: string;
  inputEventIdsHash: string;
  provenanceHash: string;
  templateVersion: string;
} {
  const body = anchor.body;
  requireExact(body.event_schema_version, "constraint-projection-event/v1", "projection.event_schema_version");
  requireExact(body.event_type, "constraint_compiled_view_produced", "projection.event_type");
  const decision = requireRecord(body.validated_decision, "projection.validated_decision");
  requireExact(decision.schemaVersion, "constraint-shadow-decision/v1", "validated_decision.schemaVersion");
  const decisionValidationHash = requireSha256(decision.validationHash, "validated_decision.validationHash");
  const decisionInputRootHash = requireSha256(decision.inputRootHash, "validated_decision.inputRootHash");
  requireExact(body.input_root_hash, decisionInputRootHash, "projection.input_root_hash");
  const inputEventIds = body.input_event_ids;
  if (!Array.isArray(inputEventIds) || !inputEventIds.every((item) => typeof item === "string" && SHA256_PATTERN.test(item))) fail("SHADOW_PROJECTION_INVALID", "projection.input_event_ids must be SHA-256 ids");
  const sorted = [...inputEventIds].sort(compareAscii);
  if (canonicalizeJcs(inputEventIds) !== canonicalizeJcs(sorted) || new Set(inputEventIds).size !== inputEventIds.length) fail("SHADOW_PROJECTION_INVALID", "projection.input_event_ids must be sorted and unique");
  const provenance = requireRecord(body.provenance, "projection.provenance");
  requireSha256(provenance.prompt_hash, "projection.provenance.prompt_hash");
  requireExact(provenance.input_hash, decisionInputRootHash, "projection.provenance.input_hash");
  requireSha256(provenance.raw_output_hash, "projection.provenance.raw_output_hash");
  if (provenance.parsed_output_hash !== undefined) requireExact(provenance.parsed_output_hash, decisionValidationHash, "projection.provenance.parsed_output_hash");
  requireExact(provenance.acceptance, "accepted_for_event_append", "projection.provenance.acceptance");
  const templateVersion = requireString(body.template_version, "projection.template_version");
  return {
    decisionValidationHash,
    decisionInputRootHash,
    decisionObjectHash: jcsSha256Hex(decision),
    inputEventIdsHash: jcsSha256Hex(sorted),
    provenanceHash: jcsSha256Hex(provenance),
    templateVersion,
  };
}

async function committedFileAnchor(sourceAbrainHome: string, head: string, relativePath: string): Promise<{ anchor: CommittedFileAnchor; committedBytes: Buffer }> {
  const relative = safeGitRelativePath(relativePath);
  let committed: { oid: string; bytes: Buffer };
  try {
    committed = await committedBlob(sourceAbrainHome, head, relative);
  } catch (err) {
    if (err instanceof CanonicalShadowError && err.code === "SHADOW_GIT_FAILED") {
      fail("SHADOW_SOURCE_NOT_COMMITTED", `HEAD does not contain required source L2: ${relative}`);
    }
    throw err;
  }
  const worktreePath = path.resolve(sourceAbrainHome, ...relative.split("/"));
  let stat: import("node:fs").Stats;
  try {
    stat = await fsp.lstat(worktreePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") fail("SHADOW_SOURCE_L2_MISSING", `required source L2 is missing from worktree: ${relative}`);
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("SHADOW_SOURCE_UNSAFE", `source L2 is not a regular file: ${relative}`);
  const worktree = await fsp.readFile(worktreePath);
  return {
    anchor: {
      relativePath: relative,
      blobOid: committed.oid,
      blobSha256: sha256Hex(committed.bytes),
      worktree_matches_head: worktree.equals(committed.bytes),
      worktree_sha256: sha256Hex(worktree),
    },
    committedBytes: committed.bytes,
  };
}

export interface ConstraintGenesisSelection {
  projection: CommittedEventAnchor;
  sourceL2: CommittedFileAnchor;
  decisionHash: string;
  canonicalOutputHash: string;
  committedL2Sha256: string;
  rerenderedL2Sha256: string;
  byteEqual: true;
}

export async function selectConstraintGenesisProjection(options: {
  sourceAbrainHome: string;
  projectionEventId?: string;
  sourceL2RelativePath?: string;
}): Promise<ConstraintGenesisSelection> {
  const identity = await gitIdentity(options.sourceAbrainHome);
  const l2 = await committedFileAnchor(identity.root, identity.head, options.sourceL2RelativePath ?? "l2/views/constraint/latest/compiled-view.md");
  const anchors = await committedProductionAnchors(identity, "constraint-projection-envelope/v1");
  let candidates = anchors;
  if (options.projectionEventId !== undefined) {
    requireSha256(options.projectionEventId, "projectionEventId");
    candidates = anchors.filter((anchor) => anchor.eventId === options.projectionEventId);
    if (candidates.length !== 1) fail("SHADOW_SOURCE_EVENT_MISSING", "requested committed constraint projection is absent", { eventId: options.projectionEventId });
  } else {
    candidates = anchors.sort((left, right) => compareAscii(eventTimestamp(right), eventTimestamp(left)) || compareAscii(right.eventId, left.eventId));
  }
  for (const projection of candidates) {
    let rendered: ReturnType<typeof renderConstraintL2View>;
    try {
      validateProjectionAnchor(projection);
      const decision = requireRecord(projection.body.validated_decision, "projection.validated_decision");
      rendered = renderConstraintL2View(decision as never, projection.eventId);
    } catch (err) {
      if (options.projectionEventId !== undefined) throw err;
      continue;
    }
    const renderedBytes = Buffer.from(rendered.markdown, "utf8");
    const byteEqual = renderedBytes.equals(l2.committedBytes);
    if (byteEqual) {
      return {
        projection,
        sourceL2: l2.anchor,
        decisionHash: rendered.decisionHash,
        canonicalOutputHash: rendered.canonicalOutputHash,
        committedL2Sha256: sha256Hex(l2.committedBytes),
        rerenderedL2Sha256: sha256Hex(renderedBytes),
        byteEqual: true,
      };
    }
    if (options.projectionEventId !== undefined) {
      fail("SHADOW_GENESIS_L2_RERENDER_MISMATCH", "explicit projection does not byte-render to committed source L2", {
        eventId: projection.eventId,
        decisionHash: rendered.decisionHash,
        committedL2Sha256: sha256Hex(l2.committedBytes),
        rerenderedL2Sha256: sha256Hex(renderedBytes),
      });
    }
  }
  fail("SHADOW_GENESIS_L2_RERENDER_MISMATCH", "no committed projection byte-renders to committed source L2", {
    committedL2Sha256: sha256Hex(l2.committedBytes),
  });
}

export async function createConstraintGenesis(options: {
  sourceAbrainHome: string;
  shadowAbrainHome: string;
  runId: string;
  projectionEventId?: string;
  sourceL2RelativePath?: string;
}): Promise<ConstraintGenesisResult> {
  const selected = await selectConstraintGenesisProjection(options);
  const { projection, sourceL2 } = selected;
  const projectionBinding = validateProjectionAnchor(projection);
  const authoritativeL2 = { relative_path: sourceL2.relativePath, blob_oid: sourceL2.blobOid, sha256: sourceL2.blobSha256 };
  const provenanceHash = jcsSha256Hex({
    projection_event_id: projection.eventId,
    projection_blob_oid: projection.blobOid,
    projection_blob_sha256: projection.blobSha256,
    source_git_head: projection.sourceGitHead,
    decision_validation_hash: projectionBinding.decisionValidationHash,
    decision_input_root_hash: projectionBinding.decisionInputRootHash,
    decision_hash: selected.decisionHash,
    canonical_output_hash: selected.canonicalOutputHash,
    source_l2: authoritativeL2,
  });
  const body = {
    ...baseBody("constraint_genesis", options.runId, {
      mode: "committed-head-zero-delta-rerender",
      provenance_hash: provenanceHash,
      source_ref: projection.sourceRef,
    }, {
      projection_body_hash: projection.bodyHash,
      projection_envelope_hash: projection.envelopeHash,
      projection_blob_sha256: projection.blobSha256,
      decision_validation_hash: projectionBinding.decisionValidationHash,
      decision_input_root_hash: projectionBinding.decisionInputRootHash,
      decision_object_hash: projectionBinding.decisionObjectHash,
      input_event_ids_hash: projectionBinding.inputEventIdsHash,
      projection_provenance_hash: projectionBinding.provenanceHash,
      decision_hash: selected.decisionHash,
      canonical_output_hash: selected.canonicalOutputHash,
      committed_l2_sha256: selected.committedL2Sha256,
      rerendered_l2_sha256: selected.rerenderedL2Sha256,
    }),
    sequence: 1,
    projection_event_id: projection.eventId,
    projection_body_hash: projection.bodyHash,
    projection_envelope_hash: projection.envelopeHash,
    projection_relative_path: projection.relativePath,
    projection_blob_oid: projection.blobOid,
    projection_blob_sha256: projection.blobSha256,
    decision_validation_hash: projectionBinding.decisionValidationHash,
    decision_input_root_hash: projectionBinding.decisionInputRootHash,
    decision_object_hash: projectionBinding.decisionObjectHash,
    input_event_ids_hash: projectionBinding.inputEventIdsHash,
    projection_provenance_hash: projectionBinding.provenanceHash,
    template_version: projectionBinding.templateVersion,
    decision_hash: selected.decisionHash,
    canonical_output_hash: selected.canonicalOutputHash,
    committed_l2_sha256: selected.committedL2Sha256,
    rerendered_l2_sha256: selected.rerenderedL2Sha256,
    byte_equal: true,
    source_git_head: projection.sourceGitHead,
    source_ref: projection.sourceRef,
    source_l2: { ...authoritativeL2, worktree_matches_head: sourceL2.worktree_matches_head, worktree_sha256: sourceL2.worktree_sha256 },
    historical_llm_rerun: false,
    canonical_delta_expected: 0,
    compiled_content_copied: false,
    canonical_fold_eligible: false,
    canonical_applied: false,
  } satisfies Record<string, JcsJsonValue>;
  const written = await writeCanonicalShadowEvent({ ...options, schema: "constraint-genesis/v1", body });
  return { ...written, projection, sourceL2 };
}

export async function validateConstraintGenesis(options: {
  sourceAbrainHome: string;
  shadowAbrainHome: string;
  runId: string;
  genesisEventId: string;
}): Promise<ShadowScanRecord> {
  const genesis = await readShadowEventById(options.shadowAbrainHome, "constraint", options.runId, options.genesisEventId);
  if (genesis.schema !== "constraint-genesis/v1") fail("SHADOW_GENESIS_INVALID", "event is not constraint genesis");
  const body = genesis.body as Record<string, unknown>;
  requireExact(body.historical_llm_rerun, false, "genesis.historical_llm_rerun");
  requireExact(body.canonical_delta_expected, 0, "genesis.canonical_delta_expected");
  requireExact(body.compiled_content_copied, false, "genesis.compiled_content_copied");
  const sourceHead = requireGitOid(body.source_git_head, "genesis.source_git_head");
  const identity = await gitIdentity(options.sourceAbrainHome);
  if (identity.head !== sourceHead) fail("SHADOW_SOURCE_REF_DRIFT", "source HEAD drifted after genesis", { expected: sourceHead, actual: identity.head });
  requireExact(body.source_ref, identity.ref, "genesis.source_ref");
  const projectionId = requireSha256(body.projection_event_id, "genesis.projection_event_id");
  const anchor = await selectCommittedProductionEvent({ sourceAbrainHome: identity.root, schema: "constraint-projection-envelope/v1", eventId: projectionId });
  const binding = validateProjectionAnchor(anchor);
  const checks: Array<[string, unknown, unknown]> = [
    ["projection_body_hash", body.projection_body_hash, anchor.bodyHash],
    ["projection_envelope_hash", body.projection_envelope_hash, anchor.envelopeHash],
    ["projection_relative_path", body.projection_relative_path, anchor.relativePath],
    ["projection_blob_oid", body.projection_blob_oid, anchor.blobOid],
    ["projection_blob_sha256", body.projection_blob_sha256, anchor.blobSha256],
    ["decision_validation_hash", body.decision_validation_hash, binding.decisionValidationHash],
    ["decision_input_root_hash", body.decision_input_root_hash, binding.decisionInputRootHash],
    ["decision_object_hash", body.decision_object_hash, binding.decisionObjectHash],
    ["input_event_ids_hash", body.input_event_ids_hash, binding.inputEventIdsHash],
    ["projection_provenance_hash", body.projection_provenance_hash, binding.provenanceHash],
    ["template_version", body.template_version, binding.templateVersion],
  ];
  for (const [field, actual, expected] of checks) requireExact(actual, expected, `genesis.${field}`);
  const sourceL2Body = requireRecord(body.source_l2, "genesis.source_l2");
  const sourceL2RelativePath = requireString(sourceL2Body.relative_path, "genesis.source_l2.relative_path");
  const committedL2 = await committedFileAnchor(identity.root, identity.head, sourceL2RelativePath);
  requireExact(sourceL2Body.blob_oid, committedL2.anchor.blobOid, "genesis.source_l2.blob_oid");
  requireExact(sourceL2Body.sha256, committedL2.anchor.blobSha256, "genesis.source_l2.sha256");
  requireExact(sourceL2Body.worktree_matches_head, committedL2.anchor.worktree_matches_head, "genesis.source_l2.worktree_matches_head");
  requireExact(sourceL2Body.worktree_sha256, committedL2.anchor.worktree_sha256, "genesis.source_l2.worktree_sha256");
  const rendered = renderConstraintL2View(requireRecord(anchor.body.validated_decision, "projection.validated_decision") as never, anchor.eventId);
  const renderedBytes = Buffer.from(rendered.markdown, "utf8");
  if (!renderedBytes.equals(committedL2.committedBytes)) fail("SHADOW_GENESIS_L2_RERENDER_MISMATCH", "genesis projection no longer byte-renders to committed source L2");
  const renderedL2Sha256 = sha256Hex(renderedBytes);
  const committedL2Sha256 = sha256Hex(committedL2.committedBytes);
  requireExact(body.decision_hash, rendered.decisionHash, "genesis.decision_hash");
  requireExact(body.canonical_output_hash, rendered.canonicalOutputHash, "genesis.canonical_output_hash");
  requireExact(body.committed_l2_sha256, committedL2Sha256, "genesis.committed_l2_sha256");
  requireExact(body.rerendered_l2_sha256, renderedL2Sha256, "genesis.rerendered_l2_sha256");
  requireExact(body.byte_equal, true, "genesis.byte_equal");
  const authoritativeL2 = { relative_path: sourceL2RelativePath, blob_oid: committedL2.anchor.blobOid, sha256: committedL2.anchor.blobSha256 };
  const expectedGenesisProvenanceHash = jcsSha256Hex({
    projection_event_id: anchor.eventId,
    projection_blob_oid: anchor.blobOid,
    projection_blob_sha256: anchor.blobSha256,
    source_git_head: anchor.sourceGitHead,
    decision_validation_hash: binding.decisionValidationHash,
    decision_input_root_hash: binding.decisionInputRootHash,
    decision_hash: rendered.decisionHash,
    canonical_output_hash: rendered.canonicalOutputHash,
    source_l2: authoritativeL2,
  });
  const genesisProvenance = requireRecord(body.provenance, "genesis.provenance");
  requireExact(genesisProvenance.provenance_hash, expectedGenesisProvenanceHash, "genesis.provenance.provenance_hash");
  const genesisHashes = requireRecord(body.input_hashes, "genesis.input_hashes");
  requireExact(genesisHashes.projection_body_hash, anchor.bodyHash, "genesis.input_hashes.projection_body_hash");
  requireExact(genesisHashes.projection_envelope_hash, anchor.envelopeHash, "genesis.input_hashes.projection_envelope_hash");
  requireExact(genesisHashes.projection_blob_sha256, anchor.blobSha256, "genesis.input_hashes.projection_blob_sha256");
  requireExact(genesisHashes.decision_validation_hash, binding.decisionValidationHash, "genesis.input_hashes.decision_validation_hash");
  requireExact(genesisHashes.decision_input_root_hash, binding.decisionInputRootHash, "genesis.input_hashes.decision_input_root_hash");
  requireExact(genesisHashes.decision_object_hash, binding.decisionObjectHash, "genesis.input_hashes.decision_object_hash");
  requireExact(genesisHashes.input_event_ids_hash, binding.inputEventIdsHash, "genesis.input_hashes.input_event_ids_hash");
  requireExact(genesisHashes.projection_provenance_hash, binding.provenanceHash, "genesis.input_hashes.projection_provenance_hash");
  requireExact(genesisHashes.decision_hash, rendered.decisionHash, "genesis.input_hashes.decision_hash");
  requireExact(genesisHashes.canonical_output_hash, rendered.canonicalOutputHash, "genesis.input_hashes.canonical_output_hash");
  requireExact(genesisHashes.committed_l2_sha256, committedL2Sha256, "genesis.input_hashes.committed_l2_sha256");
  requireExact(genesisHashes.rerendered_l2_sha256, renderedL2Sha256, "genesis.input_hashes.rerendered_l2_sha256");
  return genesis;
}

function validateCommonBody(body: Record<string, unknown>, expectedKind: string): void {
  requireExact(body.shadow_schema_version, SHADOW_BODY_SCHEMA, "body.shadow_schema_version");
  requireExact(body.event_kind, expectedKind, "body.event_kind");
  validateCanonicalShadowRunId(requireString(body.run_id, "body.run_id"));
  const producer = requireRecord(body.producer, "body.producer");
  requireExact(producer.name, PRODUCER_NAME, "body.producer.name");
  requireExact(producer.version, PRODUCER_VERSION, "body.producer.version");
  requireRecord(body.provenance, "body.provenance");
  requireRecord(body.input_hashes, "body.input_hashes");
  requireExact(body.canonical_fold_eligible, false, "body.canonical_fold_eligible");
}

function validateShadowBody(schema: CanonicalShadowSchema, body: Record<string, unknown>): void {
  const kinds: Record<CanonicalShadowSchema, string> = {
    "knowledge-candidate-observation/v1": "knowledge_candidate_observation",
    "knowledge-curator-attempt/v1": "knowledge_curator_attempt",
    "knowledge-curator-decision/v1": "knowledge_curator_decision",
    "knowledge-apply-receipt/v1": "knowledge_apply_receipt",
    "constraint-genesis/v1": "constraint_genesis",
  };
  validateCommonBody(body, kinds[schema]);
  if (schema === "knowledge-candidate-observation/v1") {
    requireExact(body.sequence, 1, "candidate.sequence");
    requireSha256(body.candidate_id, "candidate.candidate_id");
    requireSha256(body.source_evidence_event_id, "candidate.source_evidence_event_id");
    requireExact(body.source_evidence_schema, "knowledge-evidence-envelope/v1", "candidate.source_evidence_schema");
    requireExact(body.source_committed_at_head, true, "candidate.source_committed_at_head");
    requireExact(body.production_acceptance_fact, "existing_committed_active_canonical_fold_winner", "candidate.production_acceptance_fact");
    requireExact(body.source_fold_winner_event_id, body.source_evidence_event_id, "candidate.source_fold_winner_event_id");
    requireSha256(body.source_fold_input_event_set_hash, "candidate.source_fold_input_event_set_hash");
    requireSha256(body.source_fold_output_markdown_hash, "candidate.source_fold_output_markdown_hash");
    requireExact(body.source_fold_projection_kind, "entry", "candidate.source_fold_projection_kind");
  } else if (schema === "knowledge-curator-attempt/v1") {
    requireExact(body.sequence, 2, "attempt.sequence");
    requireSha256(body.candidate_event_id, "attempt.candidate_event_id");
    requireSha256(body.frozen_curator_input_hash, "attempt.frozen_curator_input_hash");
    requireSha256(body.claim_id, "attempt.claim_id");
    if (!Number.isInteger(body.slot) || (body.slot as number) < 1 || (body.slot as number) > 3) fail("SHADOW_ATTEMPT_SLOT_INVALID", "attempt slot must be 1..3");
  } else if (schema === "knowledge-curator-decision/v1") {
    requireExact(body.sequence, 3, "decision.sequence");
    requireSha256(body.candidate_event_id, "decision.candidate_event_id");
    requireSha256(body.attempt_event_id, "decision.attempt_event_id");
    if (body.decision !== "accept" && body.decision !== "reject") fail("SHADOW_DECISION_INVALID", "decision must be accept or reject");
    requireExact(body.canonical_applied, false, "decision.canonical_applied");
  } else if (schema === "knowledge-apply-receipt/v1") {
    requireExact(body.sequence, 4, "receipt.sequence");
    requireSha256(body.decision_event_id, "receipt.decision_event_id");
    requireSha256(body.rendered_output_hash, "receipt.rendered_output_hash");
    requireExact(body.zero_canonical_apply, true, "receipt.zero_canonical_apply");
    requireExact(body.canonical_applied, false, "receipt.canonical_applied");
  } else {
    requireExactKeys(body, [
      "shadow_schema_version", "event_kind", "producer", "run_id", "provenance", "input_hashes",
      "sequence", "projection_event_id", "projection_body_hash", "projection_envelope_hash",
      "projection_relative_path", "projection_blob_oid", "projection_blob_sha256",
      "decision_validation_hash", "decision_input_root_hash", "decision_object_hash",
      "input_event_ids_hash", "projection_provenance_hash", "template_version", "decision_hash",
      "canonical_output_hash", "committed_l2_sha256", "rerendered_l2_sha256", "byte_equal",
      "source_git_head", "source_ref", "source_l2", "historical_llm_rerun",
      "canonical_delta_expected", "compiled_content_copied", "canonical_fold_eligible", "canonical_applied",
    ], "genesis");
    const provenance = requireRecord(body.provenance, "genesis.provenance");
    requireExactKeys(provenance, ["mode", "provenance_hash", "source_ref"], "genesis.provenance");
    const inputHashes = requireRecord(body.input_hashes, "genesis.input_hashes");
    requireExactKeys(inputHashes, [
      "projection_body_hash", "projection_envelope_hash", "projection_blob_sha256",
      "decision_validation_hash", "decision_input_root_hash", "decision_object_hash",
      "input_event_ids_hash", "projection_provenance_hash", "decision_hash", "canonical_output_hash",
      "committed_l2_sha256", "rerendered_l2_sha256",
    ], "genesis.input_hashes");
    requireExact(body.sequence, 1, "genesis.sequence");
    requireSha256(body.projection_event_id, "genesis.projection_event_id");
    requireGitOid(body.source_git_head, "genesis.source_git_head");
    requireExact(body.historical_llm_rerun, false, "genesis.historical_llm_rerun");
    requireExact(body.canonical_delta_expected, 0, "genesis.canonical_delta_expected");
    requireExact(body.compiled_content_copied, false, "genesis.compiled_content_copied");
    requireExact(body.canonical_applied, false, "genesis.canonical_applied");
    requireSha256(body.decision_hash, "genesis.decision_hash");
    requireSha256(body.canonical_output_hash, "genesis.canonical_output_hash");
    requireSha256(body.committed_l2_sha256, "genesis.committed_l2_sha256");
    requireSha256(body.rerendered_l2_sha256, "genesis.rerendered_l2_sha256");
    requireExact(body.byte_equal, true, "genesis.byte_equal");
    const sourceL2 = requireRecord(body.source_l2, "genesis.source_l2");
    requireExactKeys(sourceL2, ["relative_path", "blob_oid", "sha256", "worktree_matches_head", "worktree_sha256"], "genesis.source_l2");
    requireExact(typeof sourceL2.worktree_matches_head, "boolean", "genesis.source_l2.worktree_matches_head type");
    requireSha256(sourceL2.worktree_sha256, "genesis.source_l2.worktree_sha256");
    if (Object.hasOwn(body, "validated_decision") || Object.hasOwn(body, "compiled_content") || Object.hasOwn(body, "compiled_view")) {
      fail("SHADOW_GENESIS_COMPILED_CONTENT", "genesis contains forbidden copied decision or compiled content");
    }
  }
}

interface TreeHashResult {
  hash: string;
  files: number;
  bytes: number;
}

async function treeHash(root: string): Promise<TreeHashResult> {
  const stat = await lstatOrNull(root);
  if (!stat) return { hash: jcsSha256Hex({ state: "absent" }), files: 0, bytes: 0 };
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("SHADOW_SOURCE_UNSAFE", `canonical tree root is unsafe: ${root}`);
  const rows: Array<{ path: string; sha256: string; bytes: number }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => compareAscii(a.name, b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail("SHADOW_SOURCE_UNSAFE", `symlink in canonical tree: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await fsp.readFile(file);
        rows.push({ path: path.relative(root, file).split(path.sep).join("/"), sha256: sha256Hex(bytes), bytes: bytes.length });
      } else fail("SHADOW_SOURCE_UNSAFE", `non-regular entry in canonical tree: ${file}`);
    }
  }
  await walk(root);
  return { hash: jcsSha256Hex(rows), files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
}

async function remoteRefsSnapshot(repo: string): Promise<Array<{ remote: string; pushUrl: string; refsHash: string; refs: string[] }>> {
  const names = (await git(repo, ["remote"])).split(/\r?\n/).filter(Boolean).sort(compareAscii);
  const output: Array<{ remote: string; pushUrl: string; refsHash: string; refs: string[] }> = [];
  for (const remote of names) {
    const urls = (await git(repo, ["remote", "get-url", "--push", "--all", remote])).split(/\r?\n/).filter(Boolean).sort(compareAscii);
    for (const pushUrl of urls) {
      const refsText = await git(repo, ["ls-remote", "--refs", pushUrl], { timeout: 15_000 });
      const refs = refsText.split(/\r?\n/).filter(Boolean).sort(compareAscii);
      output.push({ remote, pushUrl, refsHash: jcsSha256Hex(refs), refs });
    }
  }
  return output;
}

async function canonicalReadSnapshot(sourceAbrainHome: string, readConfigPath?: string): Promise<Record<string, JcsJsonValue>> {
  let root: Record<string, unknown> = {};
  let source = "not-supplied";
  let configSha256 = jcsSha256Hex(null);
  if (readConfigPath) {
    const file = path.resolve(readConfigPath);
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("SHADOW_READ_CONFIG_UNSAFE", `read config is not a regular file: ${file}`);
    const bytes = await fsp.readFile(file);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { fail("SHADOW_READ_CONFIG_INVALID", `read config is not JSON: ${file}`); }
    root = isRecord(parsed) ? parsed : {};
    source = path.basename(file);
    configSha256 = sha256Hex(bytes);
  }
  const sediment = isRecord(root.sediment) ? root.sediment : {};
  const projector = isRecord(sediment.knowledgeProjector) ? sediment.knowledgeProjector : {};
  const ruleInjector = isRecord(root.ruleInjector) ? root.ruleInjector : {};
  const compiled = isRecord(ruleInjector.compiledViewInjection) ? ruleInjector.compiledViewInjection : {};
  const knowledgeMode = projector.canonicalReadMode === "projection_only" || projector.canonicalReadMode === "projection_with_legacy_fallback"
    ? projector.canonicalReadMode
    : "legacy";
  const knowledgeRelative = "l2/views/knowledge/latest";
  const constraintRelative = ".state/sediment/constraint-shadow/latest";
  const knowledgeBundle = knowledgeMode === "projection_only"
    ? await treeHash(path.join(sourceAbrainHome, ...knowledgeRelative.split("/")))
    : null;
  const constraintBundle = compiled.enabled === true
    ? await treeHash(path.join(sourceAbrainHome, ...constraintRelative.split("/")))
    : null;
  const bundles = {
    knowledge: knowledgeBundle ? { enabled: true, relative_path: knowledgeRelative, ...knowledgeBundle } : { enabled: false, relative_path: null, hash: jcsSha256Hex({ state: "disabled" }), files: 0, bytes: 0 },
    constraint: constraintBundle ? { enabled: true, relative_path: constraintRelative, ...constraintBundle } : { enabled: false, relative_path: null, hash: jcsSha256Hex({ state: "disabled" }), files: 0, bytes: 0 },
  };
  return {
    source,
    config_sha256: configSha256,
    canonical_read_config: {
      knowledge_mode: knowledgeMode,
      knowledge_source: knowledgeMode === "projection_only" ? knowledgeRelative : null,
      constraint_compiled_view_enabled: compiled.enabled === true,
      constraint_source: compiled.enabled === true ? constraintRelative : null,
    },
    bundles,
    bundles_hash: jcsSha256Hex(bundles),
  };
}

async function untrackedContentSnapshot(repo: string): Promise<{ hash: string; files: number; bytes: number; rows: Array<{ path: string; sha256: string; bytes: number }> }> {
  const names = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort(compareAscii);
  const rows: Array<{ path: string; sha256: string; bytes: number }> = [];
  const rootReal = await fsp.realpath(repo);
  for (const name of names) {
    const relative = safeGitRelativePath(name);
    const file = path.resolve(repo, ...relative.split("/"));
    if (!pathInside(repo, file)) fail("SHADOW_SOURCE_PATH_INVALID", "untracked path escapes source root", { relative });
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("SHADOW_SOURCE_UNSAFE", `untracked source entry is not a regular file: ${relative}`);
    const real = await fsp.realpath(file);
    if (!pathInside(rootReal, real)) fail("SHADOW_SOURCE_PATH_INVALID", "untracked source entry realpath escapes repository", { relative, real });
    const content = await fsp.readFile(file);
    rows.push({ path: relative, sha256: sha256Hex(content), bytes: content.length });
  }
  return { hash: jcsSha256Hex(rows), files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), rows };
}

interface CanonicalFoldSnapshot {
  input_set_hash: string;
  output_hash: string;
  knowledge_identity_count: number;
  knowledge_event_count: number;
  constraint_projection_count: number;
  constraint_decision_hashes: string[];
  event_count: number;
}

async function canonicalFoldSnapshot(identity: GitIdentity, scan: Awaited<ReturnType<typeof scanWholeL1Validated>>): Promise<CanonicalFoldSnapshot> {
  const byIdentity = new Map<string, KnowledgeEventNode[]>();
  for (const record of scan.foldable.filter((item) => item.registration.envelope_schema === "knowledge-evidence-envelope/v1")) {
    const body = record.body as unknown as KnowledgeEvidenceEventBodyV1;
    const key = knowledgeIdentityKey(body);
    const nodes = byIdentity.get(key) ?? [];
    nodes.push({ eventId: record.eventId, body });
    byIdentity.set(key, nodes);
  }
  const knowledge: Array<Record<string, JcsJsonValue>> = [];
  const knowledgeInputs: Array<Record<string, JcsJsonValue>> = [];
  let knowledgeEventCount = 0;
  for (const [key, nodes] of [...byIdentity.entries()].sort(([left], [right]) => compareAscii(left, right))) {
    const projection = renderKnowledgeProjectionFromSet(nodes);
    const inputEventIds = nodes.map((node) => node.eventId).sort(compareAscii);
    knowledgeEventCount += inputEventIds.length;
    knowledgeInputs.push({ identity: key, input_event_ids: inputEventIds, input_event_set_hash: projection.inputEventSetHash });
    knowledge.push({
      identity: key,
      winner_event_id: projection.winnerEventId,
      input_event_ids: inputEventIds,
      input_event_set_hash: projection.inputEventSetHash,
      output_kind: projection.kind,
      output_markdown_sha256: projection.kind === "entry" && projection.markdown ? sha256Hex(projection.markdown) : null,
    });
  }
  const committedProjections = await committedProductionAnchors(identity, "constraint-projection-envelope/v1");
  const constraintDecisionHashes = [...new Set(committedProjections.map((anchor) => (
    renderConstraintL2View(requireRecord(anchor.body.validated_decision, "projection.validated_decision") as never, anchor.eventId).decisionHash
  )))].sort(compareAscii);
  const input = { knowledge: knowledgeInputs, constraint_projection_event_ids: committedProjections.map((anchor) => anchor.eventId).sort(compareAscii) };
  const output = { knowledge, constraint_decision_hashes: constraintDecisionHashes };
  return {
    input_set_hash: jcsSha256Hex(input),
    output_hash: jcsSha256Hex(output),
    knowledge_identity_count: knowledge.length,
    knowledge_event_count: knowledgeEventCount,
    constraint_projection_count: committedProjections.length,
    constraint_decision_hashes: constraintDecisionHashes,
    event_count: scan.foldable.length,
  };
}

export interface CanonicalSourceSnapshot {
  source_git_head: string;
  source_ref: string;
  refs_hash: string;
  refs: string[];
  index_hash: string;
  index_status_hash: string;
  worktree_status_hash: string;
  worktree_status: string[];
  untracked_content_hash: string;
  untracked_files: number;
  untracked_bytes: number;
  push_remote_refs_hash: string;
  push_remote_refs: Array<{ remote: string; pushUrl: string; refsHash: string; refs: string[] }>;
  canonical_trees: { rules: TreeHashResult; knowledge: TreeHashResult; projects: TreeHashResult };
  canonical_trees_hash: string;
  l1_event_set_hash: string;
  l1_event_count: number;
  fold_input_set_hash: string;
  fold_output_hash: string;
  fold_event_count: number;
  canonical_fold: CanonicalFoldSnapshot;
  phase_disabled_shadow_count: number;
  phase_disabled_shadow_ids_hash: string;
  canonical_read: Record<string, JcsJsonValue>;
  canonical_read_hash: string;
  snapshot_hash: string;
}

export async function captureCanonicalSourceSnapshot(options: {
  sourceAbrainHome: string;
  readConfigPath?: string;
}): Promise<CanonicalSourceSnapshot> {
  const identity = await gitIdentity(options.sourceAbrainHome);
  const refs = (await git(identity.root, ["for-each-ref", "--format=%(refname)%09%(objectname)"]))
    .split(/\r?\n/).filter(Boolean).sort(compareAscii);
  const indexRows = await git(identity.root, ["ls-files", "--stage", "-z"]);
  const indexStatus = await git(identity.root, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  const statusText = await git(identity.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const worktreeDiff = await git(identity.root, ["diff", "--binary", "--no-ext-diff"]);
  const worktreeStatus = statusText.split("\0").filter(Boolean).sort(compareAscii);
  const untracked = await untrackedContentSnapshot(identity.root);
  const pushRemoteRefs = await remoteRefsSnapshot(identity.root);
  const canonicalTrees = {
    rules: await treeHash(path.join(identity.root, "rules")),
    knowledge: await treeHash(path.join(identity.root, "knowledge")),
    projects: await treeHash(path.join(identity.root, "projects")),
  };
  const scan = await scanWholeL1Validated({ abrainHome: identity.root });
  const eventRows = scan.all.map((item) => ({ event_id: item.eventId, envelope_hash: item.envelopeHash, schema: item.registration.envelope_schema })).sort((a, b) => compareAscii(a.event_id, b.event_id));
  const phaseDisabledIds = scan.phaseDisabledShadow.map((item) => item.eventId).sort(compareAscii);
  const canonicalFold = await canonicalFoldSnapshot(identity, scan);
  const canonicalRead = await canonicalReadSnapshot(identity.root, options.readConfigPath);
  const base = {
    source_git_head: identity.head,
    source_ref: identity.ref,
    refs_hash: jcsSha256Hex(refs),
    refs,
    index_hash: sha256Hex(indexRows),
    index_status_hash: sha256Hex(indexStatus),
    worktree_status_hash: jcsSha256Hex({ status: worktreeStatus, diff_sha256: sha256Hex(worktreeDiff), untracked_content_hash: untracked.hash }),
    worktree_status: worktreeStatus,
    untracked_content_hash: untracked.hash,
    untracked_files: untracked.files,
    untracked_bytes: untracked.bytes,
    push_remote_refs_hash: jcsSha256Hex(pushRemoteRefs),
    push_remote_refs: pushRemoteRefs,
    canonical_trees: canonicalTrees,
    canonical_trees_hash: jcsSha256Hex(canonicalTrees),
    l1_event_set_hash: jcsSha256Hex(eventRows),
    l1_event_count: eventRows.length,
    fold_input_set_hash: canonicalFold.input_set_hash,
    fold_output_hash: canonicalFold.output_hash,
    fold_event_count: canonicalFold.event_count,
    canonical_fold: canonicalFold,
    phase_disabled_shadow_count: phaseDisabledIds.length,
    phase_disabled_shadow_ids_hash: jcsSha256Hex(phaseDisabledIds),
    canonical_read: canonicalRead,
    canonical_read_hash: jcsSha256Hex(canonicalRead),
  };
  return { ...base, snapshot_hash: jcsSha256Hex(base) };
}

export function compareCanonicalSourceSnapshots(before: CanonicalSourceSnapshot, after: CanonicalSourceSnapshot): {
  refChanged: boolean;
  indexChanged: boolean;
  worktreeChanged: boolean;
  pushChanged: boolean;
  canonicalChanged: boolean;
  readChanged: boolean;
  foldChanged: boolean;
} {
  return {
    refChanged: before.source_git_head !== after.source_git_head || before.source_ref !== after.source_ref || before.refs_hash !== after.refs_hash,
    indexChanged: before.index_hash !== after.index_hash || before.index_status_hash !== after.index_status_hash,
    worktreeChanged: before.worktree_status_hash !== after.worktree_status_hash,
    pushChanged: before.push_remote_refs_hash !== after.push_remote_refs_hash,
    canonicalChanged: before.canonical_trees_hash !== after.canonical_trees_hash,
    readChanged: before.canonical_read_hash !== after.canonical_read_hash,
    foldChanged: before.fold_input_set_hash !== after.fold_input_set_hash || before.fold_output_hash !== after.fold_output_hash,
  };
}

export function deriveCanonicalShadowRunId(input: { sourceGitHead: string; knowledgeEventId: string; projectionEventId: string }): string {
  requireGitOid(input.sourceGitHead, "sourceGitHead");
  requireSha256(input.knowledgeEventId, "knowledgeEventId");
  requireSha256(input.projectionEventId, "projectionEventId");
  return `s4-${jcsSha256Hex({ domain: "canonical-path-r3.4.2/dossier-run/v1", ...input }).slice(0, 32)}`;
}

export interface CanonicalShadowDossierResult {
  report: Record<string, JcsJsonValue>;
  reportPath: string;
  reportStatus: ShadowWriteStatus;
  ok: boolean;
}

export async function createCanonicalPathShadowDossier(options: {
  sourceAbrainHome: string;
  shadowAbrainHome: string;
  runId: string;
  knowledgeEventId?: string;
  projectionEventId?: string;
  sourceL2RelativePath?: string;
  readConfigPath?: string;
}): Promise<CanonicalShadowDossierResult> {
  validateCanonicalShadowRunId(options.runId);
  const shadowHome = await initializeCanonicalShadowHome(options.shadowAbrainHome, true);
  const before = await captureCanonicalSourceSnapshot({ sourceAbrainHome: options.sourceAbrainHome, readConfigPath: options.readConfigPath });
  if (before.phase_disabled_shadow_count !== 0) {
    fail("SHADOW_CANONICAL_PHASE_DISABLED_LEAK", "phase-disabled shadow events are present in canonical L1 before dossier", {
      count: before.phase_disabled_shadow_count,
      idsHash: before.phase_disabled_shadow_ids_hash,
    });
  }
  const candidate = await createKnowledgeCandidateObservation({ ...options, shadowAbrainHome: shadowHome, sourceEventId: options.knowledgeEventId });
  const attempt = await claimKnowledgeCuratorAttempt({
    shadowAbrainHome: shadowHome,
    runId: options.runId,
    candidateEventId: candidate.eventId,
    slot: 1,
    frozenCuratorInputHash: candidate.frozenCuratorInputHash,
  });
  const decision = await createKnowledgeCuratorDecision({
    shadowAbrainHome: shadowHome,
    runId: options.runId,
    candidateEventId: candidate.eventId,
    attemptEventId: attempt.eventId,
    decision: "accept",
  });
  const receipt = await createKnowledgeApplyReceipt({ shadowAbrainHome: shadowHome, runId: options.runId, decisionEventId: decision.eventId });
  const chain = await validateKnowledgeShadowChain({ shadowAbrainHome: shadowHome, runId: options.runId });
  const genesis = await createConstraintGenesis({
    ...options,
    shadowAbrainHome: shadowHome,
    projectionEventId: options.projectionEventId,
  });
  await validateConstraintGenesis({ sourceAbrainHome: options.sourceAbrainHome, shadowAbrainHome: shadowHome, runId: options.runId, genesisEventId: genesis.eventId });
  const after = await captureCanonicalSourceSnapshot({ sourceAbrainHome: options.sourceAbrainHome, readConfigPath: options.readConfigPath });
  if (after.phase_disabled_shadow_count !== 0) {
    fail("SHADOW_CANONICAL_PHASE_DISABLED_LEAK", "phase-disabled shadow events are present in canonical L1 after dossier", {
      count: after.phase_disabled_shadow_count,
      idsHash: after.phase_disabled_shadow_ids_hash,
    });
  }
  const changes = compareCanonicalSourceSnapshots(before, after);
  const sourceChanged = Object.values(changes).some(Boolean);
  const reportWithoutSelfHash = {
    schema_version: DOSSIER_SCHEMA,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
    run_id: options.runId,
    reproducibility_input_hash: jcsSha256Hex({
      source_git_head: before.source_git_head,
      run_id: options.runId,
      knowledge_event_id: candidate.anchor.eventId,
      projection_event_id: genesis.projection.eventId,
      read_config_hash: before.canonical_read_hash,
    }),
    source_before: before as unknown as JcsJsonValue,
    source_after: after as unknown as JcsJsonValue,
    sourceChanged,
    ...changes,
    knowledge_chain: {
      candidate_event_id: candidate.eventId,
      attempt_event_ids: chain.attempts.map((item) => item.eventId).sort(compareAscii),
      decision_event_id: decision.eventId,
      receipt_event_id: receipt.eventId,
      source_evidence_event_id: candidate.anchor.eventId,
      provenance_mode: "replay-existing-accepted-fold-winner",
      source_fold_identity: candidate.fold.identity,
      source_fold_winner_event_id: candidate.fold.winnerEventId,
      source_fold_input_event_ids: [...candidate.fold.inputEventIds],
      source_fold_input_event_set_hash: candidate.fold.inputEventSetHash,
      source_fold_output_markdown_hash: candidate.fold.outputMarkdownHash,
      frozen_curator_input_hash: candidate.frozenCuratorInputHash,
      curator_output_hash: decision.outputHash,
      decision_provenance_hash: decision.provenanceHash,
      chain_hash: chain.chainHash,
      canonical_fold_eligible: false,
      canonical_applied: false,
    },
    constraint_genesis: {
      genesis_event_id: genesis.eventId,
      projection_event_id: genesis.projection.eventId,
      projection_blob_oid: genesis.projection.blobOid,
      projection_blob_sha256: genesis.projection.blobSha256,
      decision_validation_hash: genesis.envelope.body.decision_validation_hash,
      decision_input_root_hash: genesis.envelope.body.decision_input_root_hash,
      decision_hash: genesis.envelope.body.decision_hash,
      canonical_output_hash: genesis.envelope.body.canonical_output_hash,
      committed_l2_sha256: genesis.envelope.body.committed_l2_sha256,
      rerendered_l2_sha256: genesis.envelope.body.rerendered_l2_sha256,
      byte_equal: true,
      source_git_head: genesis.projection.sourceGitHead,
      source_l2: {
        relative_path: genesis.sourceL2.relativePath,
        blob_oid: genesis.sourceL2.blobOid,
        sha256: genesis.sourceL2.blobSha256,
        worktree_matches_head: genesis.sourceL2.worktree_matches_head,
        worktree_sha256: genesis.sourceL2.worktree_sha256,
        authoritative_anchor: "HEAD committed blob oid and sha256 only",
      },
      historical_llm_rerun: false,
      canonical_delta_expected: 0,
    },
    phase_disabled_shadow_count_before: before.phase_disabled_shadow_count,
    phase_disabled_shadow_ids_hash_before: before.phase_disabled_shadow_ids_hash,
    phase_disabled_shadow_count_after: after.phase_disabled_shadow_count,
    phase_disabled_shadow_ids_hash_after: after.phase_disabled_shadow_ids_hash,
    shadow_outputs: {
      knowledge_event_ids: [candidate.eventId, attempt.eventId, decision.eventId, receipt.eventId],
      constraint_event_ids: [genesis.eventId],
      rendered_output_relative_path: receipt.outputRelativePath,
      rendered_output_hash: receipt.outputHash,
    },
    dossier_self_hash_rule: "sha256(RFC8785-JCS(report_without_dossier_self_hash)); this is a logical report self-hash, not the dossier.json file hash",
    report_file_sha256_rule: "sha256(exact dossier.json file bytes) must be recorded externally; it cannot equal or be embedded as dossier_self_hash without self-reference",
  } satisfies Record<string, JcsJsonValue>;
  const report = { ...reportWithoutSelfHash, dossier_self_hash: jcsSha256Hex(reportWithoutSelfHash) } satisfies Record<string, JcsJsonValue>;
  const runRoot = canonicalShadowRunRoot(shadowHome, "knowledge", options.runId);
  await ensureDirectoryChain(shadowHome, runRoot);
  const reportPath = path.join(runRoot, "dossier.json");
  await assertSafeCreateTarget(runRoot, reportPath);
  const statusRaw: DurableCreateStatus = await durableAtomicCreateFile(reportPath, `${canonicalizeJcs(report)}\n`, { mode: 0o600 });
  if (statusRaw === "collision") fail("SHADOW_DOSSIER_COLLISION", "existing dossier bytes differ for the same reproducibility inputs", { reportPath });
  await assertSafeExistingFile(runRoot, reportPath);
  return { report, reportPath, reportStatus: statusRaw, ok: !sourceChanged };
}

export function validateCanonicalShadowDossierSelfHash(report: unknown): boolean {
  if (!isRecord(report)) return false;
  const selfHash = report.dossier_self_hash;
  if (typeof selfHash !== "string" || !SHA256_PATTERN.test(selfHash)) return false;
  const without = { ...report };
  delete without.dossier_self_hash;
  return jcsSha256Hex(without) === selfHash;
}

export const CANONICAL_SHADOW_SCHEMAS = SHADOW_SCHEMAS;
export const CANONICAL_SHADOW_PRODUCER = Object.freeze({ name: PRODUCER_NAME, version: PRODUCER_VERSION });
