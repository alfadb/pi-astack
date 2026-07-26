/**
 * Create-only publication outbox for accepted sediment results.
 *
 * Event-first acceptance durably enqueues this outbox item before its
 * deterministic idempotent L1 append, all under the canonical mutation
 * barrier and before Git/L2 publication. The outbox is NOT semantic truth:
 * accepted knowledge/constraint/outcome must eventually land in canonical L1.
 * This file only records a CAS work item so L2 projection + Git drain can
 * run asynchronously under the existing canonical runtime without rolling
 * back checkpoints or deleting L1 when canonical is busy.
 *
 * Path: ~/.abrain/.state/sediment/publication-outbox/pending/<itemId>.json
 * itemId is content-addressed over the stable work reference (no wall clock).
 * Knowledge work references eventId; it never copies the semantic event body.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicCreateFile, durableAtomicWriteFile, fsyncDirectory } from "../_shared/durable-write";
import { canonicalizeJcs, normalizeJcsValueOmittingUndefined } from "../_shared/jcs";
import {
  canonicalL1EnvelopeJson,
  expectedL1EventRelativePath,
  loadL1SchemaRegistry,
  validateL1Envelope,
} from "../_shared/l1-schema-registry";
import { withCanonicalMutationBarrier } from "../_shared/canonical-mutation-barrier";
import { abrainSedimentAuditPath, formatLocalIsoTimestamp } from "../_shared/runtime";

export const SEDIMENT_PUBLICATION_OUTBOX_SCHEMA = "sediment-publication-outbox/v2" as const;

export type PublicationOutboxDomain = "knowledge" | "constraint" | "outcome" | "generic";

export interface PublicationOutboxItem {
  schema: typeof SEDIMENT_PUBLICATION_OUTBOX_SCHEMA;
  itemId: string;
  domain: PublicationOutboxDomain;
  sessionId: string;
  windowId?: string;
  /** Content-addressed L1 event id when already durable. */
  eventId?: string;
  /** Explicit relative or absolute paths the async publisher may drain. */
  artifactPaths: string[];
  /** Stable candidate key for idempotent retries. */
  candidateKey: string;
  operation: string;
  slug?: string;
  projectId?: string;
  scope?: "project" | "world";
  /** When true, publisher should run knowledge L2 projection for eventId. */
  projectKnowledge?: boolean;
  /** When true, publisher should request Git/canonical drain. */
  publishGit?: boolean;
  /** Immutable timestamp from the accepted L1 source event, when present. */
  sourceTimestampUtc?: string;
  /** Stable all-event publication group (merge); both fields appear together. */
  batchId?: string;
  batchSize?: number;
  /** Free-form non-semantic diagnostics. */
  note?: string;
}

export type PublicationOutboxWriteStatus = "created" | "identical" | "collision";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

export function publicationOutboxRoot(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "publication-outbox");
}

export function publicationOutboxPendingDir(abrainHome: string): string {
  return path.join(publicationOutboxRoot(abrainHome), "pending");
}

export function publicationOutboxDoneDir(abrainHome: string): string {
  return path.join(publicationOutboxRoot(abrainHome), "done");
}

/** Permanent terminal publication failures. Visible, not retried, not silent-done. */
export function publicationOutboxFailedDir(abrainHome: string): string {
  return path.join(publicationOutboxRoot(abrainHome), "failed");
}

/** Operator-resolved terminal history. Retained permanently; never deleted. */
export function publicationOutboxResolvedDir(abrainHome: string): string {
  return path.join(publicationOutboxRoot(abrainHome), "resolved");
}

export function publicationOutboxPendingPath(abrainHome: string, itemId: string): string {
  if (!/^[0-9a-f]{64}$/.test(itemId)) {
    throw new Error(`invalid publication outbox itemId: ${itemId}`);
  }
  return path.join(publicationOutboxPendingDir(abrainHome), `${itemId}.json`);
}

/** Identity fields only. No enqueue wall clock exists in the durable item. */
export function computePublicationOutboxItemId(input: Omit<PublicationOutboxItem, "schema" | "itemId" | "note">): string {
  const identity = {
    schema: SEDIMENT_PUBLICATION_OUTBOX_SCHEMA,
    domain: input.domain,
    sessionId: input.sessionId,
    windowId: input.windowId ?? null,
    eventId: input.eventId ?? null,
    artifactPaths: [...input.artifactPaths].map((p) => path.normalize(p)).sort(),
    candidateKey: input.candidateKey,
    operation: input.operation,
    slug: input.slug ?? null,
    projectId: input.projectId ?? null,
    scope: input.scope ?? null,
    projectKnowledge: input.projectKnowledge === true,
    publishGit: input.publishGit === true,
    sourceTimestampUtc: input.sourceTimestampUtc ?? null,
    batchId: input.batchId ?? null,
    batchSize: input.batchSize ?? null,
  };
  return sha256Hex(canonicalizeJcs(normalizeJcsValueOmittingUndefined(identity)));
}

export function buildPublicationOutboxItem(
  input: Omit<PublicationOutboxItem, "schema" | "itemId">,
): PublicationOutboxItem {
  if (input.domain === "knowledge" && !input.eventId) {
    throw new Error("knowledge publication work requires eventId");
  }
  if (input.scope === "world" && input.projectId !== undefined) {
    throw new Error("world publication work must omit projectId");
  }
  if (input.scope === "project" && (!input.projectId || input.projectId.trim() !== input.projectId)) {
    throw new Error("project publication work requires exact projectId");
  }
  if ((input.batchId === undefined) !== (input.batchSize === undefined)) {
    throw new Error("publication batchId and batchSize must appear together");
  }
  if (input.batchId !== undefined && (!/^[0-9a-f]{64}$/.test(input.batchId) || !Number.isInteger(input.batchSize) || input.batchSize! < 2)) {
    throw new Error("invalid publication batch identity");
  }
  const base = {
    domain: input.domain,
    sessionId: input.sessionId,
    ...(input.windowId ? { windowId: input.windowId } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
    artifactPaths: [...input.artifactPaths],
    candidateKey: input.candidateKey,
    operation: input.operation,
    ...(input.slug ? { slug: input.slug } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.projectKnowledge ? { projectKnowledge: true } : {}),
    ...(input.publishGit ? { publishGit: true } : {}),
    ...(input.sourceTimestampUtc ? { sourceTimestampUtc: input.sourceTimestampUtc } : {}),
    ...(input.batchId ? { batchId: input.batchId, batchSize: input.batchSize } : {}),
  };
  const itemId = computePublicationOutboxItemId(base);
  return {
    schema: SEDIMENT_PUBLICATION_OUTBOX_SCHEMA,
    itemId,
    ...base,
    ...(input.note ? { note: input.note } : {}),
  };
}

export async function writePublicationOutboxItem(
  abrainHome: string,
  item: PublicationOutboxItem,
): Promise<{ status: PublicationOutboxWriteStatus; itemId: string; filePath: string; item: PublicationOutboxItem }> {
  if (item.schema !== SEDIMENT_PUBLICATION_OUTBOX_SCHEMA) {
    throw new Error(`unsupported publication outbox schema: ${String((item as { schema?: unknown }).schema)}`);
  }
  if (item.scope === "world" && item.projectId !== undefined) {
    throw new Error("world publication work must omit projectId");
  }
  if (item.scope === "project" && (!item.projectId || item.projectId.trim() !== item.projectId)) {
    throw new Error("project publication work requires exact projectId");
  }
  const expected = computePublicationOutboxItemId(item);
  if (item.itemId !== expected) {
    throw new Error(`publication outbox itemId mismatch: ${item.itemId} !== ${expected}`);
  }
  const donePath = path.join(publicationOutboxDoneDir(abrainHome), `${item.itemId}.json`);
  try {
    const done = JSON.parse(await fs.readFile(donePath, "utf-8")) as PublicationOutboxItem;
    if (computePublicationOutboxItemId(done) === item.itemId && canonicalizeJcs(done) === canonicalizeJcs(item)) {
      return { status: "identical", itemId: item.itemId, filePath: donePath, item: done };
    }
    return { status: "collision", itemId: item.itemId, filePath: donePath, item };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { status: "collision", itemId: item.itemId, filePath: donePath, item };
    }
  }
  const failedPath = path.join(publicationOutboxFailedDir(abrainHome), `${item.itemId}.json`);
  try {
    await fs.access(failedPath);
    return { status: "collision", itemId: item.itemId, filePath: failedPath, item };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const dir = publicationOutboxPendingDir(abrainHome);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = publicationOutboxPendingPath(abrainHome, item.itemId);
  const raw = `${JSON.stringify(item)}\n`;
  const createStatus = await durableAtomicCreateFile(filePath, raw, { mode: 0o600 });
  if (createStatus !== "collision") return { status: createStatus, itemId: item.itemId, filePath, item };
  try {
    const existing = JSON.parse(await fs.readFile(filePath, "utf-8")) as PublicationOutboxItem;
    const existingExpected = computePublicationOutboxItemId(existing);
    if (
      existing.schema === SEDIMENT_PUBLICATION_OUTBOX_SCHEMA
      && existing.itemId === item.itemId
      && existingExpected === item.itemId
      && canonicalizeJcs(existing) === canonicalizeJcs(item)
    ) {
      return { status: "identical", itemId: item.itemId, filePath, item: existing };
    }
  } catch {
    // Hard collision below. The caller must not checkpoint accepted work whose
    // publication receipt could not be durably established.
  }
  return { status: "collision", itemId: item.itemId, filePath, item };
}

const PUBLICATION_OUTBOX_ITEM_FILENAME_RE = /^[0-9a-f]{64}\.json$/;

/** Count durable pending directory entries without reading semantic item bodies. */
export async function countPublicationOutboxPending(abrainHome: string): Promise<number> {
  const dir = publicationOutboxPendingDir(abrainHome);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  return names.filter((name) => PUBLICATION_OUTBOX_ITEM_FILENAME_RE.test(name)).length;
}

/** Existence-only pending probe; stops at the first valid directory entry. */
export async function hasPublicationOutboxPending(abrainHome: string): Promise<boolean> {
  const dir = publicationOutboxPendingDir(abrainHome);
  try {
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (PUBLICATION_OUTBOX_ITEM_FILENAME_RE.test(entry.name)) return true;
    }
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Validate one durable failed/ entry without semantic body processing.
 * Legal filename + regular file + schema/identity only. Symlink / corrupt / illegal → throw (fail closed).
 */
async function validatePublicationOutboxFailedEntry(dir: string, name: string): Promise<void> {
  if (!PUBLICATION_OUTBOX_ITEM_FILENAME_RE.test(name)) {
    throw new Error(`publication outbox failed entry illegal filename: ${name}`);
  }
  const filePath = path.join(dir, name);
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(filePath);
  } catch (err) {
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`publication outbox failed entry is symlink: ${name}`);
  }
  if (!st.isFile()) {
    throw new Error(`publication outbox failed entry is not a regular file: ${name}`);
  }
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    throw err;
  }
  let parsed: PublicationOutboxItem | { item?: PublicationOutboxItem };
  try {
    parsed = JSON.parse(raw) as PublicationOutboxItem | { item?: PublicationOutboxItem };
  } catch {
    throw new Error(`publication outbox failed entry invalid JSON: ${name}`);
  }
  // Read-only compatibility for former copy/unlink terminal receipts.
  const item = (parsed as { item?: PublicationOutboxItem }).item ?? parsed as PublicationOutboxItem;
  const itemId = name.slice(0, 64);
  if (
    !item
    || item.schema !== SEDIMENT_PUBLICATION_OUTBOX_SCHEMA
    || item.itemId !== itemId
    || computePublicationOutboxItemId(item) !== itemId
  ) {
    throw new Error(`publication outbox failed entry identity invalid: ${name}`);
  }
}

/**
 * Metadata-only failed residual count. Validates legal filename/schema/identity;
 * symlink / corrupt / illegal entries fail closed (throw) — never silent skip.
 */
export async function countPublicationOutboxFailed(abrainHome: string): Promise<number> {
  const dir = publicationOutboxFailedDir(abrainHome);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let count = 0;
  for (const name of names) {
    await validatePublicationOutboxFailedEntry(dir, name);
    count += 1;
  }
  return count;
}

/**
 * Existence-only failed residual probe with the same fail-closed validation as count.
 * Stops at the first validated entry; empty/missing dir → false.
 */
export async function hasPublicationOutboxFailed(abrainHome: string): Promise<boolean> {
  const dir = publicationOutboxFailedDir(abrainHome);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  for (const name of names) {
    await validatePublicationOutboxFailedEntry(dir, name);
    return true;
  }
  return false;
}

const LEGACY_WORLD_PROJECT_STAMP = "pi-global";
const LEGACY_WORLD_REPAIR_REASON = "legacy_world_project_stamp_repaired";
const PUBLICATION_OUTBOX_ITEM_KEYS = new Set([
  "schema", "itemId", "domain", "sessionId", "windowId", "eventId",
  "artifactPaths", "candidateKey", "operation", "slug", "projectId", "scope",
  "projectKnowledge", "publishGit", "sourceTimestampUtc", "batchId", "batchSize", "note",
]);

interface LegacyWorldRepairTerminalRow {
  itemId: string;
  filePath: string;
  item: PublicationOutboxItem;
}

export type LegacyWorldProjectStampRepairStatus = "repaired" | "already_repaired" | "not_eligible";
export type LegacyWorldProjectStampRepairFailureReason = "identity" | "conflict" | "io";

export class LegacyWorldProjectStampRepairError extends Error {
  readonly reason: LegacyWorldProjectStampRepairFailureReason;

  constructor(reason: LegacyWorldProjectStampRepairFailureReason) {
    super(`publication repair ${reason} failure`);
    this.name = "LegacyWorldProjectStampRepairError";
    this.reason = reason;
  }
}

export interface LegacyWorldProjectStampRepairResult {
  status: LegacyWorldProjectStampRepairStatus;
  repaired: 0 | 1;
}

export interface LegacyWorldProjectStampRepairOptions {
  /** Test-only deterministic crash cutpoint. */
  crashHook?: (point: "after_pending_enqueue" | "after_failed_resolve") => Promise<void> | void;
  clock?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function assertSafePublicationDirectory(dir: string, create = false): Promise<boolean> {
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (!create) return false;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    st = await fs.lstat(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new LegacyWorldProjectStampRepairError("conflict");
  }
  return true;
}

async function readRepairTerminalRows(dir: string): Promise<LegacyWorldRepairTerminalRow[]> {
  if (!(await assertSafePublicationDirectory(dir))) return [];
  const names = (await fs.readdir(dir)).sort();
  const rows: LegacyWorldRepairTerminalRow[] = [];
  for (const name of names) {
    if (!PUBLICATION_OUTBOX_ITEM_FILENAME_RE.test(name)) {
      throw new LegacyWorldProjectStampRepairError("identity");
    }
    const filePath = path.join(dir, name);
    const st = await fs.lstat(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new LegacyWorldProjectStampRepairError("conflict");
    }
    const real = await fs.realpath(filePath);
    if (real !== path.resolve(filePath)) {
      throw new LegacyWorldProjectStampRepairError("conflict");
    }
    const raw = await fs.readFile(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LegacyWorldProjectStampRepairError("identity");
    }
    const item = isRecord(parsed) && isRecord(parsed.item) ? parsed.item as unknown as PublicationOutboxItem : parsed as PublicationOutboxItem;
    const itemId = name.slice(0, 64);
    if (
      !item
      || item.schema !== SEDIMENT_PUBLICATION_OUTBOX_SCHEMA
      || item.itemId !== itemId
      || computePublicationOutboxItemId(item) !== itemId
    ) {
      throw new LegacyWorldProjectStampRepairError("identity");
    }
    rows.push({ itemId, filePath, item });
  }
  return rows;
}

async function readRepairStateItem(filePath: string, itemId: string): Promise<PublicationOutboxItem | null> {
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new LegacyWorldProjectStampRepairError("conflict");
  }
  const real = await fs.realpath(filePath);
  if (real !== path.resolve(filePath)) throw new LegacyWorldProjectStampRepairError("conflict");
  const raw = await fs.readFile(filePath, "utf-8");
  let item: PublicationOutboxItem;
  try {
    item = JSON.parse(raw) as PublicationOutboxItem;
  } catch {
    throw new LegacyWorldProjectStampRepairError("identity");
  }
  if (
    item.schema !== SEDIMENT_PUBLICATION_OUTBOX_SCHEMA
    || item.itemId !== itemId
    || computePublicationOutboxItemId(item) !== itemId
  ) {
    throw new LegacyWorldProjectStampRepairError("identity");
  }
  return item;
}

function normalizeLegacyWorldPublicationItem(item: PublicationOutboxItem): PublicationOutboxItem {
  const { schema: _schema, itemId: _itemId, projectId: _projectId, ...input } = item;
  return buildPublicationOutboxItem(input);
}

function isLegacyWorldPublicationItem(item: PublicationOutboxItem): boolean {
  return !Object.keys(item).some((key) => !PUBLICATION_OUTBOX_ITEM_KEYS.has(key))
    && item.domain === "knowledge"
    && item.scope === "world"
    && item.projectId === LEGACY_WORLD_PROJECT_STAMP
    && typeof item.eventId === "string"
    && /^[0-9a-f]{64}$/.test(item.eventId)
    && typeof item.slug === "string"
    && item.slug.length > 0
    && typeof item.operation === "string"
    && item.operation.length > 0
    && typeof item.sessionId === "string"
    && item.sessionId.length > 0
    && typeof item.candidateKey === "string"
    && item.candidateKey.length > 0
    && typeof item.sourceTimestampUtc === "string"
    && item.sourceTimestampUtc.length > 0
    && item.note === "accepted_pending_publication"
    && item.projectKnowledge === true
    && item.publishGit === true
    && item.batchId === undefined
    && item.batchSize === undefined
    && Array.isArray(item.artifactPaths)
    && item.artifactPaths.length === 0
    && (item.windowId === undefined || (typeof item.windowId === "string" && item.windowId.length > 0));
}

function normalizeResolvedLegacyWorldPublicationItem(item: PublicationOutboxItem): PublicationOutboxItem {
  if (!isLegacyWorldPublicationItem(item)) {
    throw new LegacyWorldProjectStampRepairError("identity");
  }
  try {
    return normalizeLegacyWorldPublicationItem(item);
  } catch {
    throw new LegacyWorldProjectStampRepairError("identity");
  }
}

async function eligibleLegacyWorldPublicationItem(
  abrainHome: string,
  item: PublicationOutboxItem,
): Promise<PublicationOutboxItem | null> {
  if (!isLegacyWorldPublicationItem(item) || typeof item.eventId !== "string") return null;

  const relativePath = expectedL1EventRelativePath(item.eventId);
  const filePath = path.join(path.resolve(abrainHome), ...relativePath.split("/"));
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new LegacyWorldProjectStampRepairError("conflict");
  if (await fs.realpath(filePath) !== path.resolve(filePath)) throw new LegacyWorldProjectStampRepairError("conflict");
  const content = await fs.readFile(filePath);
  let envelope: unknown;
  try {
    envelope = JSON.parse(content.toString("utf-8"));
  } catch {
    return null;
  }
  let validated: ReturnType<typeof validateL1Envelope>;
  try {
    validated = validateL1Envelope(envelope, {
      registry: loadL1SchemaRegistry(),
      abrainHome: path.resolve(abrainHome),
      filePath,
      relativePath,
      expected: { domain: "knowledge", role: "canonical", phase: "active", requireWriteEnabled: true },
    });
  } catch {
    return null;
  }
  if (!content.equals(Buffer.from(canonicalL1EnvelopeJson(envelope), "utf-8"))) return null;
  const body = validated.body as Record<string, unknown>;
  const scope = isRecord(body.scope) ? body.scope : null;
  const payload = isRecord(body.payload) ? body.payload : null;
  const intent = isRecord(body.intent) ? body.intent : null;
  const source = isRecord(body.source) ? body.source : null;
  if (
    validated.eventId !== item.eventId
    || body.event_schema_version !== "knowledge-evidence-event/v1"
    || body.event_type !== "knowledge_entry_observed"
    || body.session_id !== item.sessionId
    || body.created_at_utc !== item.sourceTimestampUtc
    || intent?.domain_hint !== item.domain
    || intent?.operation_hint !== item.operation
    || scope?.kind !== "world"
    || Object.prototype.hasOwnProperty.call(scope, "project_id")
    || payload?.slug !== item.slug
  ) {
    return null;
  }
  const expectedCandidateKey = typeof source?.candidate_id === "string"
    ? source.candidate_id
    : typeof source?.correlation_id === "string"
      ? source.correlation_id
      : `knowledge:${item.operation}:${item.slug}:${item.eventId}`;
  if (item.candidateKey !== expectedCandidateKey) return null;
  return normalizeLegacyWorldPublicationItem(item);
}

async function appendLegacyWorldRepairAuditOnce(args: {
  abrainHome: string;
  oldItemId: string;
  newItemId: string;
  repairedAtUtc: string;
}): Promise<void> {
  const auditPath = abrainSedimentAuditPath(args.abrainHome);
  const auditDir = path.dirname(auditPath);
  await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
  let existing = "";
  try {
    existing = await fs.readFile(auditPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const line of existing.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        row.operation === "publication_outbox_legacy_repair"
        && row.reason === LEGACY_WORLD_REPAIR_REASON
        && row.old_internal_id === args.oldItemId
        && row.new_internal_id === args.newItemId
      ) return;
    } catch { /* unrelated malformed historical audit row */ }
  }
  const row = {
    timestamp: formatLocalIsoTimestamp(new Date(args.repairedAtUtc)),
    audit_version: 2,
    pid: process.pid,
    lane: "publication",
    operation: "publication_outbox_legacy_repair",
    reason: LEGACY_WORLD_REPAIR_REASON,
    old_internal_id: args.oldItemId,
    new_internal_id: args.newItemId,
    repaired_at_utc: args.repairedAtUtc,
  };
  const handle = await fs.open(auditPath, "a", 0o600);
  try {
    await handle.writeFile(`${existing && !existing.endsWith("\n") ? "\n" : ""}${JSON.stringify(row)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(auditDir);
}

export async function appendLegacyWorldRepairFailureAuditClosed(
  abrainHome: string,
  reason: LegacyWorldProjectStampRepairFailureReason,
): Promise<void> {
  try {
    const auditPath = abrainSedimentAuditPath(abrainHome);
    const auditDir = path.dirname(auditPath);
    await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
    let needsLeadingNewline = false;
    try {
      const existing = await fs.readFile(auditPath);
      needsLeadingNewline = existing.length > 0 && existing[existing.length - 1] !== 0x0a;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const row = {
      timestamp: formatLocalIsoTimestamp(),
      audit_version: 2,
      pid: process.pid,
      lane: "publication",
      operation: "repair_failed",
      reason,
    };
    const handle = await fs.open(auditPath, "a", 0o600);
    try {
      await handle.writeFile(`${needsLeadingNewline ? "\n" : ""}${JSON.stringify(row)}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(auditDir);
  } catch {
    console.error("[sediment-writer] publication_repair_audit_failed operation=repair_failed reason=audit_append_failed");
  }
}

async function assertNormalizedRepairDestination(
  abrainHome: string,
  item: PublicationOutboxItem,
): Promise<"pending" | "done" | null> {
  const pending = await readRepairStateItem(
    path.join(publicationOutboxPendingDir(abrainHome), `${item.itemId}.json`),
    item.itemId,
  );
  const done = await readRepairStateItem(
    path.join(publicationOutboxDoneDir(abrainHome), `${item.itemId}.json`),
    item.itemId,
  );
  if (pending && done) throw new LegacyWorldProjectStampRepairError("conflict");
  const existing = pending ?? done;
  if (existing && canonicalizeJcs(existing) !== canonicalizeJcs(item)) {
    throw new LegacyWorldProjectStampRepairError("conflict");
  }
  return pending ? "pending" : done ? "done" : null;
}

/**
 * Explicit, single-item operator repair for the historical world-scope
 * `projectId=pi-global` stamp. The old failed bytes move to resolved/; the
 * normalized item is independently retained in pending/ or done/.
 */
export async function repairLegacyWorldProjectStampFailures(
  abrainHome: string,
  limit: 0 | 1 = 1,
  options: LegacyWorldProjectStampRepairOptions = {},
): Promise<LegacyWorldProjectStampRepairResult> {
  if (limit !== 0 && limit !== 1) throw new LegacyWorldProjectStampRepairError("identity");
  if (limit === 0) return { status: "not_eligible", repaired: 0 };
  const root = path.resolve(abrainHome);
  return withCanonicalMutationBarrier(root, async () => {
    const outboxRoot = publicationOutboxRoot(root);
    if (!(await assertSafePublicationDirectory(outboxRoot))) return { status: "not_eligible", repaired: 0 };
    const pendingDir = publicationOutboxPendingDir(root);
    const doneDir = publicationOutboxDoneDir(root);
    const failedDir = publicationOutboxFailedDir(root);
    const resolvedDir = publicationOutboxResolvedDir(root);
    await assertSafePublicationDirectory(pendingDir);
    await assertSafePublicationDirectory(doneDir);
    const failedRows = await readRepairTerminalRows(failedDir);
    const resolvedRows = await readRepairTerminalRows(resolvedDir);

    // Audit recovery is historical bookkeeping, not a repair mutation: it is
    // unbounded by repair_limit and derives identity only from immutable old bytes.
    for (const row of resolvedRows) {
      const normalized = normalizeResolvedLegacyWorldPublicationItem(row.item);
      const repairedAtUtc = new Date((options.clock ?? Date.now)()).toISOString();
      await appendLegacyWorldRepairAuditOnce({
        abrainHome: root,
        oldItemId: row.itemId,
        newItemId: normalized.itemId,
        repairedAtUtc,
      });
    }

    for (const row of failedRows) {
      const normalized = await eligibleLegacyWorldPublicationItem(root, row.item);
      if (!normalized) continue;
      const existingResolved = resolvedRows.find((candidate) => candidate.itemId === row.itemId);
      if (existingResolved) throw new LegacyWorldProjectStampRepairError("conflict");
      const destination = await assertNormalizedRepairDestination(root, normalized);
      if (!destination) {
        const written = await writePublicationOutboxItem(root, normalized);
        if (written.status === "collision") throw new LegacyWorldProjectStampRepairError("conflict");
      }
      await options.crashHook?.("after_pending_enqueue");
      await assertSafePublicationDirectory(resolvedDir, true);
      const resolvedPath = path.join(resolvedDir, `${row.itemId}.json`);
      if (await readRepairStateItem(resolvedPath, row.itemId)) {
        throw new LegacyWorldProjectStampRepairError("conflict");
      }
      await fs.rename(row.filePath, resolvedPath);
      await fsyncDirectory(resolvedDir);
      await fsyncDirectory(failedDir);
      await options.crashHook?.("after_failed_resolve");
      const repairedAtUtc = new Date((options.clock ?? Date.now)()).toISOString();
      await appendLegacyWorldRepairAuditOnce({
        abrainHome: root,
        oldItemId: row.itemId,
        newItemId: normalized.itemId,
        repairedAtUtc,
      });
      return { status: "repaired", repaired: 1 };
    }

    if (resolvedRows.length > 0) return { status: "already_repaired", repaired: 0 };
    return { status: "not_eligible", repaired: 0 };
  });
}

/** Resolved history count with the same legal filename/schema/identity closure. */
export async function countPublicationOutboxResolved(abrainHome: string): Promise<number> {
  return (await readRepairTerminalRows(publicationOutboxResolvedDir(abrainHome))).length;
}

export async function listPublicationOutboxPending(
  abrainHome: string,
): Promise<Array<{ itemId: string; filePath: string; item: PublicationOutboxItem; mtimeMs: number }>> {
  const dir = publicationOutboxPendingDir(abrainHome);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Array<{ itemId: string; filePath: string; item: PublicationOutboxItem; mtimeMs: number }> = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const [raw, st] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)]);
      const item = JSON.parse(raw) as PublicationOutboxItem;
      if (!item || item.schema !== SEDIMENT_PUBLICATION_OUTBOX_SCHEMA) continue;
      out.push({ itemId: item.itemId || name.slice(0, 64), filePath, item, mtimeMs: st.mtimeMs });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.itemId.localeCompare(b.itemId));
  return out;
}

export async function ackPublicationOutboxItem(
  abrainHome: string,
  itemId: string,
): Promise<{ status: "acked" | "missing"; fromPath: string; toPath?: string }> {
  const fromPath = publicationOutboxPendingPath(abrainHome, itemId);
  const doneDir = publicationOutboxDoneDir(abrainHome);
  await fs.mkdir(doneDir, { recursive: true, mode: 0o700 });
  const toPath = path.join(doneDir, `${itemId}.json`);
  try {
    await fs.rename(fromPath, toPath);
    await fsyncDirectory(doneDir).catch(() => undefined);
    await fsyncDirectory(path.dirname(fromPath)).catch(() => undefined);
    return { status: "acked", fromPath, toPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", fromPath };
    try {
      const raw = await fs.readFile(fromPath);
      await durableAtomicWriteFile(toPath, raw, { mode: 0o600 });
      await fs.unlink(fromPath);
      return { status: "acked", fromPath, toPath };
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", fromPath };
      throw err2;
    }
  }
}

const PUBLICATION_FAILURE_REASONS = new Set([
  "knowledge_publication_validation_failed",
  "unknown_publication_domain",
]);

function closedPublicationFailureReason(reason: string): string {
  const code = reason.split(":", 1)[0]?.trim() ?? "";
  return PUBLICATION_FAILURE_REASONS.has(code) ? code : "publication_terminal_failure";
}

async function appendPublicationFailureAudit(
  abrainHome: string,
  phase: "before_transition" | "after_transition",
  reason: string,
  item: PublicationOutboxItem,
): Promise<void> {
  const auditPath = abrainSedimentAuditPath(abrainHome);
  const auditDir = path.dirname(auditPath);
  await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
  const row = {
    timestamp: formatLocalIsoTimestamp(),
    audit_version: 2,
    pid: process.pid,
    abrain_home: path.resolve(abrainHome),
    lane: "publication",
    operation: "publication_outbox_terminal_transition",
    phase,
    reason: closedPublicationFailureReason(reason),
    item_identity: {
      item_id: item.itemId,
      domain: item.domain,
      session_id: item.sessionId,
      ...(item.windowId ? { window_id: item.windowId } : {}),
      ...(item.eventId ? { event_id: item.eventId } : {}),
      candidate_key: item.candidateKey,
      item_operation: item.operation,
      ...(item.slug ? { slug: item.slug } : {}),
      ...(item.projectId ? { project_id: item.projectId } : {}),
      ...(item.scope ? { scope: item.scope } : {}),
      ...(item.batchId ? { batch_id: item.batchId } : {}),
    },
  };
  const handle = await fs.open(auditPath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(row)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(auditDir);
}

async function appendPublicationFailureAuditClosed(
  abrainHome: string,
  phase: "before_transition" | "after_transition",
  reason: string,
  item: PublicationOutboxItem,
): Promise<void> {
  try {
    await appendPublicationFailureAudit(abrainHome, phase, reason, item);
  } catch {
    // Do not include raw I/O error/path text: transition audit logging is closed.
    console.error(`[sediment-writer] publication_failure_audit_failed phase=${phase} reason=audit_append_failed`);
  }
}

/**
 * Atomically move a terminal item from pending/ to failed/ within one outbox
 * filesystem. The failed path retains the immutable item bytes; its directory
 * is the terminal status. Existing identical destination is idempotent, while
 * any identity/content conflict fails closed and leaves pending untouched.
 */
export async function failPublicationOutboxItem(
  abrainHome: string,
  itemId: string,
  reason: string,
): Promise<{ status: "failed" | "missing"; fromPath: string; toPath?: string }> {
  const fromPath = publicationOutboxPendingPath(abrainHome, itemId);
  const pendingDir = path.dirname(fromPath);
  const failedDir = publicationOutboxFailedDir(abrainHome);
  await fs.mkdir(failedDir, { recursive: true, mode: 0o700 });
  const toPath = path.join(failedDir, `${itemId}.json`);

  const readValidated = async (filePath: string): Promise<{ raw: Buffer; item: PublicationOutboxItem } | null> => {
    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: PublicationOutboxItem | { item?: PublicationOutboxItem };
    try {
      parsed = JSON.parse(raw.toString("utf-8")) as PublicationOutboxItem | { item?: PublicationOutboxItem };
    } catch {
      throw new Error(`publication outbox terminal move found invalid JSON: ${filePath}`);
    }
    // Read-only compatibility for terminal receipts created by the former
    // copy/unlink implementation; new transitions always rename the raw item.
    const item = (parsed as { item?: PublicationOutboxItem }).item ?? parsed as PublicationOutboxItem;
    if (
      item.schema !== SEDIMENT_PUBLICATION_OUTBOX_SCHEMA
      || item.itemId !== itemId
      || computePublicationOutboxItemId(item) !== itemId
    ) {
      throw new Error(`publication outbox terminal move identity conflict: ${filePath}`);
    }
    return { raw, item };
  };

  const source = await readValidated(fromPath);
  const destination = await readValidated(toPath);
  if (destination) {
    if (source && canonicalizeJcs(source.item) !== canonicalizeJcs(destination.item)) {
      throw new Error(`publication outbox failed destination conflict: ${itemId}`);
    }
    if (source) {
      await appendPublicationFailureAuditClosed(abrainHome, "before_transition", reason, source.item);
      await fs.unlink(fromPath);
      await fsyncDirectory(failedDir);
      await fsyncDirectory(pendingDir);
      await appendPublicationFailureAuditClosed(abrainHome, "after_transition", reason, source.item);
    }
    return { status: "failed", fromPath, toPath };
  }
  if (!source) return { status: "missing", fromPath };

  await appendPublicationFailureAuditClosed(abrainHome, "before_transition", reason, source.item);
  await fs.rename(fromPath, toPath);
  await fsyncDirectory(failedDir);
  await fsyncDirectory(pendingDir);
  await appendPublicationFailureAuditClosed(abrainHome, "after_transition", reason, source.item);
  return { status: "failed", fromPath, toPath };
}

/** Process-local single-flight publisher lock (not a global daemon). */
const PUB_STATE = Symbol.for("pi-astack/sediment/publication-outbox-drain/v1");
const pubHost = globalThis as typeof globalThis & Record<PropertyKey, unknown>;

interface PubDrainState {
  inflight: Promise<void> | null;
  lastError?: string;
  drained: number;
  failed: number;
}

function pubState(): PubDrainState {
  const existing = pubHost[PUB_STATE] as PubDrainState | undefined;
  if (existing) return existing;
  const created: PubDrainState = { inflight: null, drained: 0, failed: 0 };
  pubHost[PUB_STATE] = created;
  return created;
}

export type PublicationOutboxHandlerResult =
  | "done"
  | "retry"
  | { result: "failed"; reason: string };

export type PublicationOutboxHandler = (item: PublicationOutboxItem) => Promise<PublicationOutboxHandlerResult>;

async function durablePublicationBatchCounts(
  abrainHome: string,
  pending: Awaited<ReturnType<typeof listPublicationOutboxPending>>,
): Promise<Map<string, number>> {
  const idsByBatch = new Map<string, Set<string>>();
  const add = (item: PublicationOutboxItem | undefined, expectedItemId?: string) => {
    if (!item?.batchId || !item.itemId || (expectedItemId && item.itemId !== expectedItemId)) return;
    try {
      if (item.schema !== SEDIMENT_PUBLICATION_OUTBOX_SCHEMA || computePublicationOutboxItemId(item) !== item.itemId) return;
    } catch {
      return;
    }
    const ids = idsByBatch.get(item.batchId) ?? new Set<string>();
    ids.add(item.itemId);
    idsByBatch.set(item.batchId, ids);
  };
  for (const row of pending) add(row.item, row.itemId);
  const incomplete = pending.some((row) => row.item.batchId
    && (idsByBatch.get(row.item.batchId)?.size ?? 0) < (row.item.batchSize ?? Number.POSITIVE_INFINITY));
  if (!incomplete) {
    return new Map([...idsByBatch].map(([batchId, ids]) => [batchId, ids.size]));
  }
  for (const dir of [publicationOutboxDoneDir(abrainHome), publicationOutboxFailedDir(abrainHome)]) {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as PublicationOutboxItem | { item?: PublicationOutboxItem };
        add((parsed as { item?: PublicationOutboxItem }).item ?? parsed as PublicationOutboxItem, name.slice(0, 64));
      } catch { /* corrupt terminal receipt remains visible but cannot satisfy a batch */ }
    }
  }
  return new Map([...idsByBatch].map(([batchId, ids]) => [batchId, ids.size]));
}

export interface PublicationOutboxDrainResult {
  status: "busy" | "completed";
  processed: number;
  drained: number;
  terminalFailed: number;
  pending: number;
  lastError?: string;
}

export type PublicationOutboxPendingRow = Awaited<ReturnType<typeof listPublicationOutboxPending>>[number];

export interface FrozenPublicationOutboxBatch {
  /** One immutable pending-directory listing taken by the OFD owner. */
  snapshot: readonly PublicationOutboxPendingRow[];
  /** Ready groups selected without splitting any merge batch. */
  selected: readonly PublicationOutboxPendingRow[];
  maxItems: number;
}

/** Freeze one bounded ready batch. New pending tail remains for a later call. */
export async function freezePublicationOutboxBatch(
  abrainHome: string,
  options: {
    maxItems?: number;
    isReady?: (row: PublicationOutboxPendingRow) => Promise<boolean>;
  } = {},
): Promise<FrozenPublicationOutboxBatch> {
  const maxItems = Math.max(1, Math.min(1024, Math.floor(options.maxItems ?? 64)));
  const snapshot = await listPublicationOutboxPending(abrainHome);
  const batchCounts = await durablePublicationBatchCounts(abrainHome, snapshot);
  const groups = new Map<string, PublicationOutboxPendingRow[]>();
  for (const row of snapshot) {
    const key = row.item.batchId ? `batch:${row.item.batchId}` : `item:${row.itemId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const selected: PublicationOutboxPendingRow[] = [];
  for (const rows of groups.values()) {
    const first = rows[0]!;
    if (first.item.batchId && (batchCounts.get(first.item.batchId) ?? 0) < (first.item.batchSize ?? Number.POSITIVE_INFINITY)) {
      continue;
    }
    // maxItems is an ordinary multi-group target. A single atomic merge/group
    // larger than that target freezes completely alone so it cannot starve.
    if (selected.length > 0 && selected.length + rows.length > maxItems) continue;
    let ready = true;
    if (options.isReady) {
      for (const row of rows) {
        if (!(await options.isReady(row))) { ready = false; break; }
      }
    }
    if (!ready) continue;
    selected.push(...rows);
  }
  return Object.freeze({
    snapshot: Object.freeze(snapshot.slice()),
    selected: Object.freeze(selected),
    maxItems,
  });
}

export interface PublicationOutboxBatchHandlerResult {
  processed: number;
  doneItemIds?: readonly string[];
  failedItems?: readonly { itemId: string; reason: string }[];
  lastError?: string;
}

export type PublicationOutboxBatchHandler = () => Promise<PublicationOutboxBatchHandlerResult>;

/**
 * Batch-level single flight. The handler owns one frozen semantic transaction;
 * acknowledgements happen only after it returns successful item ids.
 */
export async function schedulePublicationOutboxBatchDrain(
  abrainHome: string,
  handler: PublicationOutboxBatchHandler,
): Promise<PublicationOutboxDrainResult> {
  const state = pubState();
  if (state.inflight) {
    return {
      status: "busy",
      processed: 0,
      drained: 0,
      terminalFailed: 0,
      pending: -1,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  let processed = 0;
  let drained = 0;
  let terminalFailed = 0;
  state.lastError = undefined;
  const run = (async () => {
    try {
      const result = await handler();
      processed = Math.max(0, Math.floor(result.processed));
      const done = [...new Set(result.doneItemIds ?? [])];
      const failed = result.failedItems ?? [];
      const failedIds = new Set(failed.map((item) => item.itemId));
      if (done.some((itemId) => failedIds.has(itemId))) throw new Error("publication batch returned an item as both done and failed");
      for (const itemId of done) {
        const ack = await ackPublicationOutboxItem(abrainHome, itemId);
        if (ack.status === "acked") {
          state.drained += 1;
          drained += 1;
        }
      }
      for (const failure of failed) {
        const moved = await failPublicationOutboxItem(abrainHome, failure.itemId, failure.reason);
        if (moved.status === "failed") {
          state.failed += 1;
          terminalFailed += 1;
        }
        state.lastError = failure.reason;
      }
      if (result.lastError) state.lastError = result.lastError;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      // A thrown batch never returns ack eligibility. Pending remains replayable.
    } finally {
      state.inflight = null;
    }
  })();
  state.inflight = run;
  await run;
  return {
    status: "completed",
    processed,
    drained,
    terminalFailed,
    pending: (await listPublicationOutboxPending(abrainHome)).length,
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}

/**
 * Run one async drain snapshot. A concurrent trigger returns `busy`
 * immediately; it never joins or waits for the existing flight. Handler owns
 * projection/Git; this helper only walks pending create-only work references.
 * Mutable L2 writes must be serialised inside the handler / existing locks.
 *
 * - done → move pending → done/
 * - retry → leave pending (no attempt/backoff/timer here)
 * - failed → move pending → failed/ (terminal visible; not re-tried)
 */
export async function schedulePublicationOutboxDrain(
  abrainHome: string,
  handler: PublicationOutboxHandler,
): Promise<PublicationOutboxDrainResult> {
  const state = pubState();
  if (state.inflight) {
    return {
      status: "busy",
      processed: 0,
      drained: 0,
      terminalFailed: 0,
      pending: -1,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  let processed = 0;
  let drained = 0;
  let terminalFailed = 0;
  state.lastError = undefined;
  const run = (async () => {
    try {
      const pending = await listPublicationOutboxPending(abrainHome);
      const batchCounts = await durablePublicationBatchCounts(abrainHome, pending);
      for (const row of pending) {
        if (row.item.batchId && (batchCounts.get(row.item.batchId) ?? 0) < (row.item.batchSize ?? Number.POSITIVE_INFINITY)) {
          // A merge crashed before every per-event work receipt was durable.
          // Leave partial work pending; replay completes the same batch.
          continue;
        }
        processed += 1;
        try {
          const result = await handler(row.item);
          if (result === "done") {
            await ackPublicationOutboxItem(abrainHome, row.itemId);
            state.drained += 1;
            drained += 1;
          } else if (result === "retry") {
            // Leave pending for a later lifecycle trigger.
          } else if (result && typeof result === "object" && result.result === "failed") {
            await failPublicationOutboxItem(abrainHome, row.itemId, result.reason);
            state.failed += 1;
            terminalFailed += 1;
            state.lastError = result.reason;
          }
        } catch (err) {
          state.lastError = err instanceof Error ? err.message : String(err);
          // Unexpected throw is recoverable here: leave pending and visible.
        }
      }
    } finally {
      state.inflight = null;
    }
  })();
  state.inflight = run;
  await run;
  return {
    status: "completed",
    processed,
    drained,
    terminalFailed,
    pending: (await listPublicationOutboxPending(abrainHome)).length,
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}

export function publicationOutboxDrainStats(): Readonly<PubDrainState> {
  const state = pubState();
  return Object.freeze({ ...state });
}

export function resetPublicationOutboxDrainForTests(): void {
  const state = pubState();
  state.inflight = null;
  state.lastError = undefined;
  state.drained = 0;
  state.failed = 0;
}
