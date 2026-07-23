/**
 * Create-only publication outbox for accepted sediment results.
 *
 * Accepted durability boundary is create-only L1 (and/or this outbox item)
 * BEFORE Git/L2 publication. The outbox is NOT semantic truth: the accepted
 * knowledge/constraint/outcome result must eventually land in canonical L1.
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

/**
 * Move a permanently terminal publication item out of pending into failed/.
 * No attempt counters, backoff timers, or retry scheduling — the failure is
 * visible and stays failed until an operator/repair path intervenes.
 */
export async function failPublicationOutboxItem(
  abrainHome: string,
  itemId: string,
  reason: string,
): Promise<{ status: "failed" | "missing"; fromPath: string; toPath?: string }> {
  const fromPath = publicationOutboxPendingPath(abrainHome, itemId);
  const failedDir = publicationOutboxFailedDir(abrainHome);
  await fs.mkdir(failedDir, { recursive: true, mode: 0o700 });
  const toPath = path.join(failedDir, `${itemId}.json`);
  let item: PublicationOutboxItem | undefined;
  try {
    item = JSON.parse(await fs.readFile(fromPath, "utf-8")) as PublicationOutboxItem;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", fromPath };
  }
  const payload = {
    schema: SEDIMENT_PUBLICATION_OUTBOX_SCHEMA,
    itemId,
    status: "failed" as const,
    reason: reason.slice(0, 500),
    failedAtUtc: new Date().toISOString(),
    item: item ?? null,
  };
  const raw = `${JSON.stringify(payload)}\n`;
  try {
    await durableAtomicWriteFile(toPath, raw, { mode: 0o600 });
    await fs.unlink(fromPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
    await fsyncDirectory(failedDir).catch(() => undefined);
    await fsyncDirectory(path.dirname(fromPath)).catch(() => undefined);
    return { status: "failed", fromPath, toPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", fromPath };
    throw err;
  }
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
  const add = (item: PublicationOutboxItem | undefined) => {
    if (!item?.batchId || !item.itemId) return;
    const ids = idsByBatch.get(item.batchId) ?? new Set<string>();
    ids.add(item.itemId);
    idsByBatch.set(item.batchId, ids);
  };
  for (const row of pending) add(row.item);
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
        add((parsed as { item?: PublicationOutboxItem }).item ?? parsed as PublicationOutboxItem);
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
