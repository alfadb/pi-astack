/// <reference types="node" />
/**
 * Non-authoritative, rebuildable whole-L1 validated-scan cache + local scan
 * coordination. Never recovery / semantic / leader authority.
 *
 * Layout (all under gitignored `.state/`):
 *   .state/canonical/l1-scan-mutex/                 — OFD scan lock root (≠ mutation barrier)
 *   .state/canonical/l1-validated-scan-cache/v2/    — SQLite progressive validated cache
 *   .state/canonical/last-known-ready/v2/ready.json — fail-closed last-ready fingerprint
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { sha256Hex } from "./jcs";
import {
  acquireRetainedDirectoryLock,
  type RetainedDirectoryLock,
} from "./retained-directory-lock";
import { durableAtomicWriteFile } from "./durable-write";
import type { L1SchemaRoleRegistry, ValidatedL1Envelope } from "./l1-schema-registry";

const sqliteModule = require("node:sqlite") as {
  DatabaseSync: new (filename: string, options?: { open?: boolean }) => DatabaseSyncLike;
};

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

interface StatementSyncLike {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Record<string, unknown>[];
}

/** Bump when validator semantics or cache row/header contract change. */
export const L1_VALIDATED_SCAN_CACHE_SCHEMA = "l1-validated-scan-cache/v2" as const;
export const L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT = "l1-scan-validator/v2@2026-07-24" as const;
export const LAST_KNOWN_READY_SCHEMA = "canonical-last-known-ready/v2" as const;
/**
 * Max rows held inside one put transaction. Bounds SQLITE write-lock duration
 * under multi-process contention; crash may lose at most one open batch
 * (cache is non-authoritative).
 */
export const L1_VALIDATED_SCAN_CACHE_PUT_BATCH = 128 as const;

export interface L1FileIdentity {
  relativePath: string;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface CachedValidatedL1Payload {
  relativePath: string;
  eventId: string;
  bodyHash: string;
  envelopeHash: string;
  envelopeSchema: string;
  envelopeJson: string;
}

export interface L1ValidatedScanCacheHeader {
  schema: typeof L1_VALIDATED_SCAN_CACHE_SCHEMA;
  validatorFingerprint: string;
  registryHash: string;
  registryPath: string;
  rootRelativePath: string;
  abrainHomeRealpath: string;
  epochHash: string;
}

export interface LastKnownReadyFingerprint {
  schema: typeof LAST_KNOWN_READY_SCHEMA;
  head: string;
  statusHash: string;
  inventoryFingerprint: string;
  abrainHomeRealpath: string;
  implementationFingerprint: string;
  validatorFingerprint: string;
  registryHash: string;
  publishedAtUnixMs: number;
}

export class L1ScanCoordinationError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "L1ScanCoordinationError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

function stateCanonicalRoot(abrainHomeRealpath: string): string {
  return path.join(abrainHomeRealpath, ".state", "canonical");
}

export function l1ScanMutexDirectory(abrainHomeRealpath: string): string {
  return path.join(stateCanonicalRoot(abrainHomeRealpath), "l1-scan-mutex");
}

export function l1ValidatedScanCacheDirectory(abrainHomeRealpath: string): string {
  return path.join(stateCanonicalRoot(abrainHomeRealpath), "l1-validated-scan-cache", "v2");
}

export function l1ValidatedScanCacheDbPath(abrainHomeRealpath: string): string {
  return path.join(l1ValidatedScanCacheDirectory(abrainHomeRealpath), "cache.sqlite");
}

export function lastKnownReadyPath(abrainHomeRealpath: string): string {
  return path.join(stateCanonicalRoot(abrainHomeRealpath), "last-known-ready", "v2", "ready.json");
}

export function resolveAbrainHomeRealpath(abrainHome: string): string {
  const resolved = path.resolve(abrainHome);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function ensureExactDirectory(target: string): string {
  fs.mkdirSync(target, { recursive: true });
  const named = fs.lstatSync(target);
  if (named.isSymbolicLink() || !named.isDirectory()) {
    throw new L1ScanCoordinationError("L1_SCAN_STATE_UNSAFE", "canonical state path must be a no-symlink directory", { target });
  }
  const real = fs.realpathSync(target);
  if (real !== target) {
    throw new L1ScanCoordinationError("L1_SCAN_STATE_UNSAFE", "canonical state path must already be its realpath", { target, real });
  }
  return real;
}

export function ensureL1ScanMutexDirectory(abrainHome: string): string {
  const home = resolveAbrainHomeRealpath(abrainHome);
  ensureExactDirectory(path.join(home, ".state"));
  ensureExactDirectory(stateCanonicalRoot(home));
  return ensureExactDirectory(l1ScanMutexDirectory(home));
}

export function ensureL1ValidatedScanCacheDirectory(abrainHome: string): string {
  const home = resolveAbrainHomeRealpath(abrainHome);
  ensureExactDirectory(path.join(home, ".state"));
  ensureExactDirectory(stateCanonicalRoot(home));
  ensureExactDirectory(path.join(stateCanonicalRoot(home), "l1-validated-scan-cache"));
  return ensureExactDirectory(l1ValidatedScanCacheDirectory(home));
}

export function ensureLastKnownReadyDirectory(abrainHome: string): string {
  const home = resolveAbrainHomeRealpath(abrainHome);
  ensureExactDirectory(path.join(home, ".state"));
  ensureExactDirectory(stateCanonicalRoot(home));
  ensureExactDirectory(path.join(stateCanonicalRoot(home), "last-known-ready"));
  return ensureExactDirectory(path.join(stateCanonicalRoot(home), "last-known-ready", "v2"));
}

/**
 * Nonblocking OFD lock on a dedicated `.state` directory. Distinct from the
 * abrainHome mutation barrier. Crash releases the lock with the process.
 */
export function tryAcquireL1ScanMutex(abrainHome: string): RetainedDirectoryLock {
  const directory = ensureL1ScanMutexDirectory(abrainHome);
  return acquireRetainedDirectoryLock(directory);
}

export function registryContentHash(registry: L1SchemaRoleRegistry, registryPath?: string): string {
  const material = JSON.stringify({
    path: registryPath ? path.resolve(registryPath) : null,
    registry_id: registry.registry_id,
    schema_version: registry.schema_version,
    storage: registry.storage,
    entries: registry.entries,
  });
  return sha256Hex(material);
}

export function cacheEpochHash(parts: {
  schema: string;
  validatorFingerprint: string;
  registryHash: string;
  rootRelativePath: string;
  abrainHomeRealpath: string;
}): string {
  return sha256Hex(JSON.stringify({
    schema: parts.schema,
    validatorFingerprint: parts.validatorFingerprint,
    registryHash: parts.registryHash,
    rootRelativePath: parts.rootRelativePath,
    abrainHomeRealpath: parts.abrainHomeRealpath,
  }));
}

export function fileIdentityFromBigIntStat(relativePath: string, stat: fs.BigIntStats): L1FileIdentity {
  return {
    relativePath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

export async function readL1FileIdentity(filePath: string, relativePath: string): Promise<L1FileIdentity> {
  const stat = await fsp.lstat(filePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new L1ScanCoordinationError("L1_SCAN_IDENTITY_UNSAFE", "event path is not a regular file", { relativePath });
  }
  return fileIdentityFromBigIntStat(relativePath, stat);
}

export function inventoryFingerprintFromIdentities(identities: readonly L1FileIdentity[]): string {
  const rows = [...identities]
    .map((item) => [item.relativePath, item.dev, item.ino, item.size, item.mtimeNs, item.ctimeNs] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return sha256Hex(JSON.stringify(rows));
}

export function cacheRowIntegrity(
  payload: CachedValidatedL1Payload,
  identity: L1FileIdentity,
  epochHash: string,
): string {
  return sha256Hex(JSON.stringify({
    epochHash,
    relativePath: payload.relativePath,
    eventId: payload.eventId,
    bodyHash: payload.bodyHash,
    envelopeHash: payload.envelopeHash,
    envelopeSchema: payload.envelopeSchema,
    envelopeJson: payload.envelopeJson,
    identity,
  }));
}

function openCacheDatabase(dbPath: string): DatabaseSyncLike {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS validated_files (
  relative_path TEXT PRIMARY KEY,
  epoch_hash TEXT NOT NULL,
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  size TEXT NOT NULL,
  mtime_ns TEXT NOT NULL,
  ctime_ns TEXT NOT NULL,
  event_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  envelope_schema TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  integrity TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS validated_files_epoch ON validated_files(epoch_hash);
`);
  return db;
}

function metaGet(db: DatabaseSyncLike, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row && typeof row.value === "string" ? row.value : undefined;
}

function metaSet(db: DatabaseSyncLike, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function resetCacheHeaderImmediate(db: DatabaseSyncLike, wanted: L1ValidatedScanCacheHeader): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM validated_files");
    metaSet(db, "schema", wanted.schema);
    metaSet(db, "validatorFingerprint", wanted.validatorFingerprint);
    metaSet(db, "registryHash", wanted.registryHash);
    metaSet(db, "registryPath", wanted.registryPath);
    metaSet(db, "rootRelativePath", wanted.rootRelativePath);
    metaSet(db, "abrainHomeRealpath", wanted.abrainHomeRealpath);
    metaSet(db, "epochHash", wanted.epochHash);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

export interface OpenL1ValidatedScanCache {
  readonly header: L1ValidatedScanCacheHeader;
  readonly dbPath: string;
  get(relativePath: string): { identity: L1FileIdentity; payload: CachedValidatedL1Payload } | null;
  put(identity: L1FileIdentity, payload: CachedValidatedL1Payload): void;
  /** Commit any open put batch so pending rows become durable. */
  flush(): void;
  /** Drop current-epoch rows whose relative paths are not in the live inventory (best-effort hygiene). */
  retainOnly(relativePaths: ReadonlySet<string>): void;
  close(): void;
  /** Observability only — not a semantic contract. */
  readonly stats: {
    readonly pendingInTransaction: number;
    readonly openTransaction: boolean;
    readonly committedPuts: number;
  };
}

export function openL1ValidatedScanCache(options: {
  abrainHome: string;
  registry: L1SchemaRoleRegistry;
  registryPath?: string;
}): OpenL1ValidatedScanCache | null {
  if (!process.versions.sqlite) return null;
  try {
    const abrainHomeRealpath = resolveAbrainHomeRealpath(options.abrainHome);
    ensureL1ValidatedScanCacheDirectory(abrainHomeRealpath);
    const dbPath = l1ValidatedScanCacheDbPath(abrainHomeRealpath);
    const db = openCacheDatabase(dbPath);
    const registryHash = registryContentHash(options.registry, options.registryPath);
    const epochHash = cacheEpochHash({
      schema: L1_VALIDATED_SCAN_CACHE_SCHEMA,
      validatorFingerprint: L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT,
      registryHash,
      rootRelativePath: options.registry.storage.root_relative_path,
      abrainHomeRealpath,
    });
    const wanted: L1ValidatedScanCacheHeader = {
      schema: L1_VALIDATED_SCAN_CACHE_SCHEMA,
      validatorFingerprint: L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT,
      registryHash,
      registryPath: options.registryPath ? path.resolve(options.registryPath) : "",
      rootRelativePath: options.registry.storage.root_relative_path,
      abrainHomeRealpath,
      epochHash,
    };
    const current = {
      schema: metaGet(db, "schema"),
      validatorFingerprint: metaGet(db, "validatorFingerprint"),
      registryHash: metaGet(db, "registryHash"),
      registryPath: metaGet(db, "registryPath") ?? "",
      rootRelativePath: metaGet(db, "rootRelativePath"),
      abrainHomeRealpath: metaGet(db, "abrainHomeRealpath"),
      epochHash: metaGet(db, "epochHash"),
    };
    const headerMatches = current.schema === wanted.schema
      && current.validatorFingerprint === wanted.validatorFingerprint
      && current.registryHash === wanted.registryHash
      && current.rootRelativePath === wanted.rootRelativePath
      && current.abrainHomeRealpath === wanted.abrainHomeRealpath
      && current.epochHash === wanted.epochHash;
    if (!headerMatches) {
      resetCacheHeaderImmediate(db, wanted);
    }

    const select = db.prepare(`
SELECT relative_path, epoch_hash, dev, ino, size, mtime_ns, ctime_ns, event_id, body_hash, envelope_hash, envelope_schema, envelope_json, integrity
FROM validated_files WHERE relative_path = ?
`);
    const upsert = db.prepare(`
INSERT INTO validated_files(
  relative_path, epoch_hash, dev, ino, size, mtime_ns, ctime_ns,
  event_id, body_hash, envelope_hash, envelope_schema, envelope_json, integrity
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(relative_path) DO UPDATE SET
  epoch_hash=excluded.epoch_hash,
  dev=excluded.dev, ino=excluded.ino, size=excluded.size,
  mtime_ns=excluded.mtime_ns, ctime_ns=excluded.ctime_ns,
  event_id=excluded.event_id, body_hash=excluded.body_hash,
  envelope_hash=excluded.envelope_hash, envelope_schema=excluded.envelope_schema,
  envelope_json=excluded.envelope_json, integrity=excluded.integrity
`);

    // Bounded put transactions avoid per-row autocommit fsync storms on cold scans.
    // Crash may lose at most one open batch; close()/flush() commit partial batches so
    // budget-deferred progressive progress remains durable after finally-close.
    let pendingInTransaction = 0;
    let openTransaction = false;
    let committedPuts = 0;
    let closed = false;

    const rollbackPutBatch = (): void => {
      if (!openTransaction) {
        pendingInTransaction = 0;
        return;
      }
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      openTransaction = false;
      pendingInTransaction = 0;
    };

    const commitPutBatch = (): void => {
      if (!openTransaction) {
        pendingInTransaction = 0;
        return;
      }
      try {
        db.exec("COMMIT");
        committedPuts += pendingInTransaction;
        openTransaction = false;
        pendingInTransaction = 0;
      } catch (error) {
        rollbackPutBatch();
        throw error;
      }
    };

    const flush = (): void => {
      if (closed) return;
      if (openTransaction || pendingInTransaction > 0) commitPutBatch();
    };

    return {
      header: wanted,
      dbPath,
      get stats() {
        return {
          pendingInTransaction,
          openTransaction,
          committedPuts,
        };
      },
      get(relativePath: string) {
        try {
          const row = select.get(relativePath);
          if (!row) return null;
          // Only trust rows bound to the live header epoch. Stale writers from a
          // previous process/header cannot pollute the current epoch view.
          if (String(row.epoch_hash ?? "") !== wanted.epochHash) return null;
          const identity: L1FileIdentity = {
            relativePath: String(row.relative_path),
            dev: String(row.dev),
            ino: String(row.ino),
            size: String(row.size),
            mtimeNs: String(row.mtime_ns),
            ctimeNs: String(row.ctime_ns),
          };
          const payload: CachedValidatedL1Payload = {
            relativePath: identity.relativePath,
            eventId: String(row.event_id),
            bodyHash: String(row.body_hash),
            envelopeHash: String(row.envelope_hash),
            envelopeSchema: String(row.envelope_schema),
            envelopeJson: String(row.envelope_json),
          };
          if (cacheRowIntegrity(payload, identity, wanted.epochHash) !== String(row.integrity)) return null;
          return { identity, payload };
        } catch {
          return null;
        }
      },
      put(identity: L1FileIdentity, payload: CachedValidatedL1Payload) {
        if (closed) {
          throw new L1ScanCoordinationError("L1_SCAN_CACHE_CLOSED", "validated scan cache already closed");
        }
        const integrity = cacheRowIntegrity(payload, identity, wanted.epochHash);
        try {
          if (!openTransaction) {
            db.exec("BEGIN IMMEDIATE");
            openTransaction = true;
            pendingInTransaction = 0;
          }
          upsert.run(
            identity.relativePath,
            wanted.epochHash,
            identity.dev,
            identity.ino,
            identity.size,
            identity.mtimeNs,
            identity.ctimeNs,
            payload.eventId,
            payload.bodyHash,
            payload.envelopeHash,
            payload.envelopeSchema,
            payload.envelopeJson,
            integrity,
          );
          pendingInTransaction += 1;
          if (pendingInTransaction >= L1_VALIDATED_SCAN_CACHE_PUT_BATCH) {
            commitPutBatch();
          }
        } catch (error) {
          rollbackPutBatch();
          throw error;
        }
      },
      flush,
      retainOnly(relativePaths: ReadonlySet<string>) {
        try {
          // Durably land progressive puts before hygiene so a cleanup failure
          // cannot roll back already-accepted cache rows.
          flush();
          // Hygiene only for the live epoch. Concurrent/stale-epoch rows are ignored.
          const rows = db.prepare("SELECT relative_path FROM validated_files WHERE epoch_hash = ?").all(wanted.epochHash);
          const stale: string[] = [];
          for (const row of rows) {
            const rel = String(row.relative_path ?? "");
            if (rel && !relativePaths.has(rel)) stale.push(rel);
          }
          if (stale.length === 0) return;
          db.exec("BEGIN IMMEDIATE");
          try {
            const del = db.prepare("DELETE FROM validated_files WHERE relative_path = ? AND epoch_hash = ?");
            for (const rel of stale) del.run(rel, wanted.epochHash);
            db.exec("COMMIT");
          } catch {
            try { db.exec("ROLLBACK"); } catch { /* ignore */ }
            // hygiene only — never undo previously committed put batches
          }
        } catch {
          // hygiene only — concurrent writers / busy errors have no semantic effect
        }
      },
      close() {
        try { flush(); } catch { /* best-effort; cache is non-authoritative */ }
        closed = true;
        try { db.close(); } catch { /* ignore */ }
      },
    };
  } catch {
    // Cache is non-authoritative: open failures degrade to no-cache.
    return null;
  }
}

export function payloadFromValidatedEnvelope(validated: ValidatedL1Envelope & { relativePath?: string }): CachedValidatedL1Payload {
  if (!validated.relativePath) {
    throw new L1ScanCoordinationError("L1_SCAN_CACHE_PAYLOAD", "validated envelope missing relativePath");
  }
  return {
    relativePath: validated.relativePath,
    eventId: validated.eventId,
    bodyHash: validated.bodyHash,
    envelopeHash: validated.envelopeHash,
    envelopeSchema: validated.registration.envelope_schema,
    envelopeJson: `${JSON.stringify(validated.envelope)}\n`,
  };
}

export function identitiesMatch(left: L1FileIdentity, right: L1FileIdentity): boolean {
  return left.relativePath === right.relativePath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function writeLastKnownReadyFingerprint(
  abrainHome: string,
  fingerprint: Omit<LastKnownReadyFingerprint, "schema" | "abrainHomeRealpath" | "publishedAtUnixMs"> & {
    publishedAtUnixMs?: number;
  },
): Promise<LastKnownReadyFingerprint> {
  const abrainHomeRealpath = resolveAbrainHomeRealpath(abrainHome);
  ensureLastKnownReadyDirectory(abrainHomeRealpath);
  const record: LastKnownReadyFingerprint = {
    schema: LAST_KNOWN_READY_SCHEMA,
    head: fingerprint.head,
    statusHash: fingerprint.statusHash,
    inventoryFingerprint: fingerprint.inventoryFingerprint,
    abrainHomeRealpath,
    implementationFingerprint: fingerprint.implementationFingerprint,
    validatorFingerprint: fingerprint.validatorFingerprint,
    registryHash: fingerprint.registryHash,
    publishedAtUnixMs: fingerprint.publishedAtUnixMs ?? Date.now(),
  };
  if (
    !/^[0-9a-f]{40,64}$/.test(record.head)
    || !/^[0-9a-f]{64}$/.test(record.statusHash)
    || !/^[0-9a-f]{64}$/.test(record.inventoryFingerprint)
    || !/^[0-9a-f]{64}$/.test(record.implementationFingerprint)
    || !/^[0-9a-f]{64}$/.test(record.registryHash)
    || typeof record.validatorFingerprint !== "string"
    || record.validatorFingerprint.length === 0
  ) {
    throw new L1ScanCoordinationError("LAST_KNOWN_READY_INVALID", "ready fingerprint fields are malformed");
  }
  const target = lastKnownReadyPath(abrainHomeRealpath);
  await durableAtomicWriteFile(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export async function readLastKnownReadyFingerprint(abrainHome: string): Promise<LastKnownReadyFingerprint | null> {
  const abrainHomeRealpath = resolveAbrainHomeRealpath(abrainHome);
  const target = lastKnownReadyPath(abrainHomeRealpath);
  let raw: string;
  try {
    raw = await fsp.readFile(target, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LastKnownReadyFingerprint>;
    if (
      parsed.schema !== LAST_KNOWN_READY_SCHEMA
      || typeof parsed.head !== "string"
      || typeof parsed.statusHash !== "string"
      || typeof parsed.inventoryFingerprint !== "string"
      || typeof parsed.implementationFingerprint !== "string"
      || typeof parsed.validatorFingerprint !== "string"
      || typeof parsed.registryHash !== "string"
      || parsed.abrainHomeRealpath !== abrainHomeRealpath
      || !/^[0-9a-f]{40,64}$/.test(parsed.head)
      || !/^[0-9a-f]{64}$/.test(parsed.statusHash)
      || !/^[0-9a-f]{64}$/.test(parsed.inventoryFingerprint)
      || !/^[0-9a-f]{64}$/.test(parsed.implementationFingerprint)
      || !/^[0-9a-f]{64}$/.test(parsed.registryHash)
      || parsed.validatorFingerprint.length === 0
      || typeof parsed.publishedAtUnixMs !== "number"
      || !Number.isFinite(parsed.publishedAtUnixMs)
    ) {
      return null;
    }
    if (`${JSON.stringify(parsed)}\n` !== raw && JSON.stringify(parsed) !== raw.trim()) {
      // Accept either pretty or compact single-line canonical writes; reject junk tails.
      if (!raw.startsWith("{") || !raw.trimEnd().endsWith("}")) return null;
    }
    return {
      schema: LAST_KNOWN_READY_SCHEMA,
      head: parsed.head,
      statusHash: parsed.statusHash,
      inventoryFingerprint: parsed.inventoryFingerprint,
      abrainHomeRealpath: parsed.abrainHomeRealpath,
      implementationFingerprint: parsed.implementationFingerprint,
      validatorFingerprint: parsed.validatorFingerprint,
      registryHash: parsed.registryHash,
      publishedAtUnixMs: parsed.publishedAtUnixMs,
    };
  } catch {
    return null;
  }
}

/** Fail-closed presence probe for device-join journal (durable recovery). */
export async function deviceJoinJournalPresent(abrainHome: string): Promise<boolean> {
  const home = resolveAbrainHomeRealpath(abrainHome);
  try {
    const stat = await fsp.lstat(path.join(home, ".state", "device-join-journal.v1.json"));
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    // Unreadable journal → treat as present so last-known-ready cannot skip recovery.
    return true;
  }
}

export function hashBuffer(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}
