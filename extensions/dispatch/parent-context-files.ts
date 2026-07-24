/**
 * Parent-session contextFiles snapshot for dispatch sub-agents.
 *
 * Capture happens once per main-session turn from
 * `event.systemPromptOptions.contextFiles` (the ordered {path,content}[]
 * already loaded into the parent system prompt). Sub-agent loaders must not
 * re-scan disk or re-parse the system prompt; they inject this snapshot via
 * DefaultResourceLoader.agentsFilesOverride.
 *
 * Missing snapshot vs empty array:
 *   - undefined / not captured for the parent (session, turn) → reject
 *   - [] (parent had no context files) → legal
 *
 * Parallel fan-out reuses the same frozen array reference for every task in
 * the turn. Audit metadata exposes digest/paths/byte counts only — never body.
 */

import { createHash } from "node:crypto";
import type { CausalAnchor } from "../_shared/causal-anchor";

export type ParentContextFile = Readonly<{
  path: string;
  content: string;
}>;

/** Ordered, immutable parent contextFiles snapshot. Empty array is valid. */
export type ParentContextFilesSnapshot = readonly ParentContextFile[];

export type ParentContextFilesAuditMeta = Readonly<{
  digest: string;
  paths: readonly string[];
  byteCounts: readonly number[];
  totalBytes: number;
  count: number;
}>;

type SnapshotRecord = {
  files: ParentContextFilesSnapshot;
  meta: ParentContextFilesAuditMeta;
  sessionId: string;
  turnId: number;
  capturedAt: string;
};

const STORE_KEY = Symbol.for("pi-astack/dispatch/parent-context-files-snapshot/v1");

function store(): Map<string, SnapshotRecord> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[STORE_KEY] as Map<string, SnapshotRecord> | undefined;
  if (!(map instanceof Map)) {
    map = new Map();
    g[STORE_KEY] = map;
  }
  return map;
}

function turnKey(sessionId: string, turnId: number): string {
  return `${sessionId}|${turnId}`;
}

/**
 * True only for a finite integer turn_id >= 0.
 * Rejects NaN, Infinity, non-integers (e.g. 1.5), and negatives.
 * Used by both capture and resolve so lookup keys stay consistent.
 */
export function isValidParentContextTurnId(turnId: unknown): turnId is number {
  return typeof turnId === "number" && Number.isFinite(turnId) && Number.isInteger(turnId) && turnId >= 0;
}

/** Freeze an ordered snapshot so parallel fan-out shares one immutable value. */
export function freezeParentContextFilesSnapshot(
  files: ReadonlyArray<{ path: string; content: string }>,
): ParentContextFilesSnapshot {
  const frozen = files.map((file) =>
    Object.freeze({
      path: file.path,
      content: file.content,
    }),
  );
  return Object.freeze(frozen);
}

/**
 * Normalize systemPromptOptions.contextFiles into an ordered snapshot.
 *
 * Strict: returns undefined when the input is not a real array, OR when any
 * entry is not an object with string `path` and string `content`. Never skips
 * bad entries or coerces missing fields to "" — silent partial snapshots would
 * drop parent rules without failing closed.
 *
 * Empty array is legal (parent had no context files).
 */
export function normalizeParentContextFiles(
  raw: unknown,
): ParentContextFilesSnapshot | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ path: string; content: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const rec = item as { path?: unknown; content?: unknown };
    if (typeof rec.path !== "string" || typeof rec.content !== "string") {
      return undefined;
    }
    out.push({ path: rec.path, content: rec.content });
  }
  return freezeParentContextFilesSnapshot(out);
}

/** Audit-safe digest + path/byte metadata. Never includes file bodies. */
export function describeParentContextFilesSnapshot(
  snapshot: ParentContextFilesSnapshot,
): ParentContextFilesAuditMeta {
  const hash = createHash("sha256");
  const paths: string[] = [];
  const byteCounts: number[] = [];
  let totalBytes = 0;
  for (const file of snapshot) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    paths.push(file.path);
    byteCounts.push(bytes);
    totalBytes += bytes;
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(bytes));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return Object.freeze({
    digest: hash.digest("hex"),
    paths: Object.freeze(paths),
    byteCounts: Object.freeze(byteCounts),
    totalBytes,
    count: paths.length,
  });
}

/** Compact audit fields (no bodies). */
export function parentContextFilesAuditFields(
  snapshot: ParentContextFilesSnapshot | undefined,
): Record<string, unknown> {
  if (!Array.isArray(snapshot)) {
    return {
      parent_context_files_present: false,
    };
  }
  const meta = describeParentContextFilesSnapshot(snapshot);
  return {
    parent_context_files_present: true,
    parent_context_files_digest: meta.digest,
    parent_context_files_paths: [...meta.paths],
    parent_context_files_byte_counts: [...meta.byteCounts],
    parent_context_files_count: meta.count,
    parent_context_files_total_bytes: meta.totalBytes,
  };
}

/**
 * Capture the parent session's effective contextFiles for (session_id, turn_id).
 * No-op when anchor is incomplete or raw is not an array.
 * Same turn re-capture replaces the record (idempotent for handler re-fires).
 */
export function captureParentContextFilesSnapshot(
  anchor: CausalAnchor | undefined,
  rawContextFiles: unknown,
): ParentContextFilesSnapshot | undefined {
  if (!anchor?.session_id || !isValidParentContextTurnId(anchor.turn_id)) {
    return undefined;
  }
  const files = normalizeParentContextFiles(rawContextFiles);
  if (files === undefined) return undefined;

  const meta = describeParentContextFilesSnapshot(files);
  const record: SnapshotRecord = Object.freeze({
    files,
    meta,
    sessionId: anchor.session_id,
    turnId: anchor.turn_id,
    capturedAt: new Date().toISOString(),
  });
  const key = turnKey(anchor.session_id, anchor.turn_id);
  store().set(key, record);

  // Bound growth: keep only recent turns for this session.
  pruneSessionSnapshots(anchor.session_id, /*keep*/ 8);
  return files;
}

function pruneSessionSnapshots(sessionId: string, keep: number): void {
  const map = store();
  const keys: Array<{ key: string; turnId: number }> = [];
  for (const [key, rec] of map) {
    if (rec.sessionId === sessionId) keys.push({ key, turnId: rec.turnId });
  }
  if (keys.length <= keep) return;
  keys.sort((a, b) => a.turnId - b.turnId);
  const drop = keys.slice(0, Math.max(0, keys.length - keep));
  for (const item of drop) map.delete(item.key);
}

/**
 * Drop every parent contextFiles snapshot for one main session.
 * Bound the process-wide store when a session ends: per-session turn prune
 * alone cannot bound the number of sessions.
 *
 * Call from main-session shutdown only. Sub-agent disposal must not clear
 * the parent's turn snapshots (still needed by siblings / later tools).
 * Returns the number of removed records.
 */
export function clearParentContextFilesSnapshotsForSession(sessionId: string): number {
  if (typeof sessionId !== "string" || sessionId.length === 0) return 0;
  const map = store();
  let removed = 0;
  for (const [key, rec] of map) {
    if (rec.sessionId === sessionId) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Resolve the immutable snapshot for a parent (session, turn).
 * Returns undefined when never captured — callers/runInProcess must reject.
 * Empty array is a successful resolve (legal).
 */
export function resolveParentContextFilesSnapshot(
  anchor: CausalAnchor | undefined,
): ParentContextFilesSnapshot | undefined {
  if (!anchor?.session_id || !isValidParentContextTurnId(anchor.turn_id)) {
    return undefined;
  }
  return store().get(turnKey(anchor.session_id, anchor.turn_id))?.files;
}

/**
 * True only for a real array snapshot (including empty) whose every entry is a
 * non-array object with string `path` and string `content`.
 * Frozen-ness is not required (callers may pass a freshly built array).
 */
export function isParentContextFilesSnapshot(
  value: unknown,
): value is ParentContextFilesSnapshot {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const rec = item as { path?: unknown; content?: unknown };
    if (typeof rec.path !== "string" || typeof rec.content !== "string") {
      return false;
    }
  }
  return true;
}

/** Test-only: clear the process-wide snapshot store. */
export function _resetParentContextFilesForTests(): void {
  store().clear();
}

/** Test-only: inspect store size. */
export function _parentContextFilesStoreSizeForTests(): number {
  return store().size;
}
