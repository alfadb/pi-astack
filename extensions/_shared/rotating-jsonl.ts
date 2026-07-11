import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock } from "./runtime";

export interface JsonlRotationSettings {
  enabled: boolean;
  maxBytes: number;
  maxAgeMs: number;
  lockTimeoutMs: number;
}

export interface JsonlRotationDefaults extends JsonlRotationSettings {}

export interface JsonlRotationDiagnostic {
  code: "rotation_failed" | "recovery_failed" | "oversize_line" | "permission_repair_failed";
  operation: string;
  message: string;
}

export interface JsonlRotationResult {
  rotated: boolean;
  archivePath?: string;
  diagnostics: JsonlRotationDiagnostic[];
}

export interface JsonlAppendResult extends JsonlRotationResult {
  appended: boolean;
  bytes: number;
  oversize: boolean;
}

export type RotationTransactionPhase =
  | "prepared"
  | "meta_archived"
  | "active_archived"
  | "active_created"
  | "meta_created";

export interface JsonlRotationOptions {
  sink: string;
  rotation: JsonlRotationSettings;
  now?: () => number;
  archiveTag?: string;
  force?: boolean;
  /** Test-only crash seam. Production callers must not set this. */
  afterArchiveRename?: (archivePath: string) => Promise<void> | void;
  /** Test-only crash seam called after each durable transaction phase. */
  afterRotationPhase?: (phase: RotationTransactionPhase, archivePath: string) => Promise<void> | void;
  /** Maintenance-only in-lock check immediately before the transaction marker is written. */
  beforeRotationMutation?: (identity: FileIdentity) => Promise<void> | void;
  /** Maintenance-only check immediately before the old active inode is renamed. */
  beforeActiveRename?: (identity: FileIdentity) => Promise<void> | void;
}

export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface StrictJsonlRotationOptions extends JsonlRotationOptions {
  expectedIdentity: FileIdentity;
  /** Runs after the strict rotation lock is held and before any rotation mutation. */
  validateLocked: () => Promise<FileIdentity>;
}

interface GenerationMeta {
  schemaVersion: 1;
  sink: string;
  generationId: string;
  createdAt: string;
  activePath: string;
  boundaryPrecision: typeof BOUNDARY_PRECISION;
}

interface RotationTransaction {
  schemaVersion: 1;
  phase: RotationTransactionPhase;
  activePath: string;
  archivePath: string;
  metaPath: string;
  archiveMetaPath: string;
  oldIdentity: FileIdentity;
  oldMeta: GenerationMeta;
  nextMeta: GenerationMeta;
  boundaryPrecision: typeof BOUNDARY_PRECISION;
}

export const BOUNDARY_PRECISION = "eventually_stable_not_linearizable" as const;

const ROTATION_LIMITS = {
  maxBytes: { min: 1, max: 1024 * 1024 * 1024 * 1024 },
  maxAgeMs: { min: 1, max: 366 * 24 * 60 * 60 * 1000 },
  lockTimeoutMs: { min: 1, max: 60_000 },
} as const;

const SERIAL_CHAINS_KEY = Symbol.for("pi-astack/rotating-jsonl/process-local-chains/v1");
const NOFOLLOW = fsSync.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsSync.constants.O_DIRECTORY ?? 0;

function serialChains(): Map<string, Promise<unknown>> {
  const global = globalThis as Record<symbol, unknown>;
  let chains = global[SERIAL_CHAINS_KEY] as Map<string, Promise<unknown>> | undefined;
  if (!chains) {
    chains = new Map();
    global[SERIAL_CHAINS_KEY] = chains;
  }
  return chains;
}

function serializeForPath<T>(activePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(activePath);
  const chains = serialChains();
  const prior = chains.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(task);
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  }).catch(() => undefined);
  return next;
}

function boundedPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function resolveJsonlRotationSettings(
  raw: unknown,
  defaults: JsonlRotationDefaults,
): JsonlRotationSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    maxBytes: boundedPositiveInteger(value.maxBytes, defaults.maxBytes, ROTATION_LIMITS.maxBytes.min, ROTATION_LIMITS.maxBytes.max),
    maxAgeMs: boundedPositiveInteger(value.maxAgeMs, defaults.maxAgeMs, ROTATION_LIMITS.maxAgeMs.min, ROTATION_LIMITS.maxAgeMs.max),
    lockTimeoutMs: boundedPositiveInteger(value.lockTimeoutMs, defaults.lockTimeoutMs, ROTATION_LIMITS.lockTimeoutMs.min, ROTATION_LIMITS.lockTimeoutMs.max),
  };
}

function controlledMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 512);
}

function pathsFor(activePath: string): {
  sinkDir: string;
  archiveDir: string;
  metaPath: string;
  lockPath: string;
  transactionPath: string;
} {
  const sinkDir = path.dirname(activePath);
  const base = path.basename(activePath);
  return {
    sinkDir,
    archiveDir: path.join(sinkDir, "archive"),
    metaPath: path.join(sinkDir, `.${base}.generation.json`),
    lockPath: path.join(sinkDir, `.${base}.rotate.lock`),
    transactionPath: path.join(sinkDir, `.${base}.rotation-transaction.json`),
  };
}

function identityOf(stat: { dev: number; ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface HeldDirectory {
  path: string;
  handle: fs.FileHandle;
  identity: FileIdentity;
}

async function lstatIdentity(file: string): Promise<FileIdentity | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`regular non-symlink file required: ${file}`);
    return identityOf(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function verifyHeldDirectory(directory: HeldDirectory): Promise<void> {
  const held = await directory.handle.stat();
  if (!held.isDirectory() || !sameIdentity(identityOf(held), directory.identity)) {
    throw new Error(`directory handle identity changed: ${directory.path}`);
  }
  const current = await fs.lstat(directory.path);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(identityOf(current), directory.identity)) {
    throw new Error(`directory path identity changed or became unsafe: ${directory.path}`);
  }
}

async function openSafeDirectory(dir: string, create: boolean): Promise<HeldDirectory> {
  const resolved = path.resolve(dir);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`directory path component is not a real directory: ${current}`);
    }
  }

  const before = await fs.lstat(resolved);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`directory is unsafe: ${resolved}`);
  const handle = await fs.open(resolved, fsSync.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || !sameIdentity(identityOf(before), identityOf(held))) {
      throw new Error(`directory identity changed while opening: ${resolved}`);
    }
    const directory = { path: resolved, handle, identity: identityOf(held) };
    await handle.chmod(0o700);
    await verifyHeldDirectory(directory);
    return directory;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function ensureDirectory(dir: string): Promise<void> {
  const directory = await openSafeDirectory(dir, true);
  await directory.handle.close();
}

async function anchoredDirectoryChild(directory: HeldDirectory, basename: string): Promise<string> {
  if (path.basename(basename) !== basename || basename === "." || basename === "..") {
    throw new Error(`invalid directory-relative basename: ${basename}`);
  }
  if (process.platform === "linux") {
    const procDirectory = `/proc/self/fd/${directory.handle.fd}`;
    const procStat = await fs.stat(procDirectory).catch(() => undefined);
    if (procStat?.isDirectory() && sameIdentity(identityOf(procStat), directory.identity)) {
      return path.join(procDirectory, basename);
    }
  }
  await verifyHeldDirectory(directory);
  return path.join(directory.path, basename);
}

async function openRegularNoFollow(file: string, flags: number, mode?: number): Promise<{ handle: fs.FileHandle; identity: FileIdentity }> {
  let before: FileIdentity | undefined;
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`regular non-symlink file required: ${file}`);
    before = identityOf(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (flags & fsSync.constants.O_CREAT) === 0) throw error;
  }
  const handle = await fs.open(file, flags | NOFOLLOW, mode);
  try {
    const held = await handle.stat();
    if (!held.isFile()) throw new Error(`regular file required after open: ${file}`);
    const heldIdentity = identityOf(held);
    if (before && !sameIdentity(before, heldIdentity)) throw new Error(`file identity changed while opening: ${file}`);
    const current = await fs.lstat(file);
    if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(identityOf(current), heldIdentity)) {
      throw new Error(`file path identity changed while opening: ${file}`);
    }
    return { handle, identity: heldIdentity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function ensureActive(activePath: string): Promise<void> {
  const opened = await openRegularNoFollow(
    activePath,
    fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT,
    0o600,
  );
  try {
    await opened.handle.chmod(0o600);
  } finally {
    await opened.handle.close();
  }
}

async function readRegularNoFollow(file: string): Promise<Buffer | undefined> {
  let opened;
  try {
    opened = await openRegularNoFollow(file, fsSync.constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const bytes = await opened.handle.readFile();
    const after = await opened.handle.stat();
    if (!after.isFile() || !sameIdentity(identityOf(after), opened.identity)) throw new Error(`file identity changed while reading: ${file}`);
    return bytes;
  } finally {
    await opened.handle.close();
  }
}

async function writeRegularAtomicNoFollow(file: string, content: string): Promise<void> {
  const directory = await openSafeDirectory(path.dirname(file), false);
  const existingIdentity = await lstatIdentity(file);
  const tmpBasename = `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`;
  const tmpPath = await anchoredDirectoryChild(directory, tmpBasename);
  const publishPath = await anchoredDirectoryChild(directory, path.basename(file));
  let tmp: fs.FileHandle | undefined;
  let published = false;
  try {
    tmp = await fs.open(tmpPath, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | NOFOLLOW, 0o600);
    const tmpStat = await tmp.stat();
    if (!tmpStat.isFile()) throw new Error(`temporary sidecar is not regular: ${tmpPath}`);
    const tmpIdentity = identityOf(tmpStat);
    await tmp.writeFile(content, "utf8");
    await tmp.chmod(0o600);
    await tmp.sync();
    await verifyHeldDirectory(directory);
    const currentIdentity = await lstatIdentity(file);
    if ((existingIdentity === undefined) !== (currentIdentity === undefined) ||
      (existingIdentity && currentIdentity && !sameIdentity(existingIdentity, currentIdentity))) {
      throw new Error(`sidecar identity changed before publish: ${file}`);
    }
    await fs.rename(tmpPath, publishPath);
    published = true;
    const publishedStat = await fs.lstat(file);
    if (publishedStat.isSymbolicLink() || !publishedStat.isFile() || !sameIdentity(identityOf(publishedStat), tmpIdentity)) {
      throw new Error(`sidecar publish identity mismatch: ${file}`);
    }
    await verifyHeldDirectory(directory);
    await directory.handle.sync();
  } finally {
    await tmp?.close().catch(() => undefined);
    if (!published) await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    await directory.handle.close();
  }
}

async function chmodRegularNoFollow(file: string, expected?: FileIdentity): Promise<void> {
  const opened = await openRegularNoFollow(file, fsSync.constants.O_RDONLY);
  try {
    if (expected && !sameIdentity(opened.identity, expected)) throw new Error(`file identity mismatch before chmod: ${file}`);
    await opened.handle.chmod(0o600);
    const after = await opened.handle.stat();
    if (!after.isFile() || !sameIdentity(identityOf(after), opened.identity)) throw new Error(`file identity changed during chmod: ${file}`);
  } finally {
    await opened.handle.close();
  }
}

async function renameRegularNoFollow(source: string, destination: string, expected?: FileIdentity): Promise<FileIdentity> {
  const sourceOpened = await openRegularNoFollow(source, fsSync.constants.O_RDONLY);
  const sourceDirectory = await openSafeDirectory(path.dirname(source), false);
  try {
    if (expected && !sameIdentity(sourceOpened.identity, expected)) throw new Error(`source identity mismatch before rename: ${source}`);
    const destinationDirectory = await openSafeDirectory(path.dirname(destination), false);
    try {
      await verifyHeldDirectory(sourceDirectory);
      await verifyHeldDirectory(destinationDirectory);
      const anchoredSource = await anchoredDirectoryChild(sourceDirectory, path.basename(source));
      const anchoredDestination = await anchoredDirectoryChild(destinationDirectory, path.basename(destination));
      await fs.rename(anchoredSource, anchoredDestination);
      await sourceOpened.handle.chmod(0o600);
      const destinationStat = await fs.lstat(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isFile() || !sameIdentity(identityOf(destinationStat), sourceOpened.identity)) {
        throw new Error(`destination identity mismatch after rename: ${destination}`);
      }
      await verifyHeldDirectory(sourceDirectory);
      await verifyHeldDirectory(destinationDirectory);
      return sourceOpened.identity;
    } finally {
      await destinationDirectory.handle.close();
    }
  } finally {
    await sourceDirectory.handle.close();
    await sourceOpened.handle.close();
  }
}

function generationMeta(activePath: string, sink: string, nowMs: number): GenerationMeta {
  return {
    schemaVersion: 1,
    sink,
    generationId: randomUUID(),
    createdAt: new Date(nowMs).toISOString(),
    activePath: path.resolve(activePath),
    boundaryPrecision: BOUNDARY_PRECISION,
  };
}

function isGenerationMeta(value: unknown, activePath: string, sink: string): value is GenerationMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const parsed = value as Partial<GenerationMeta>;
  const createdMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
  return parsed.schemaVersion === 1 && parsed.sink === sink &&
    typeof parsed.generationId === "string" && parsed.generationId.length > 0 &&
    Number.isFinite(createdMs) && parsed.activePath === path.resolve(activePath) &&
    (parsed.boundaryPrecision === BOUNDARY_PRECISION || parsed.boundaryPrecision === undefined);
}

async function writeGenerationMeta(metaPath: string, meta: GenerationMeta): Promise<void> {
  await writeRegularAtomicNoFollow(metaPath, `${JSON.stringify(meta)}\n`);
}

async function readGenerationMeta(metaPath: string, activePath: string, sink: string): Promise<GenerationMeta | undefined> {
  const bytes = await readRegularNoFollow(metaPath);
  if (!bytes) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
  if (!isGenerationMeta(parsed, activePath, sink)) return undefined;
  return { ...parsed, boundaryPrecision: BOUNDARY_PRECISION };
}

function compactUtc(value: string | number): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(".", "");
}

function safeNamePart(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "audit";
}

function archivePathFor(
  archiveDir: string,
  sink: string,
  meta: GenerationMeta,
  observedLastPreRotateMtimeMs: number,
  rotatedAtMs: number,
  archiveTag?: string,
): string {
  const tag = archiveTag ? `__${safeNamePart(archiveTag)}` : "";
  const filename = [
    safeNamePart(sink),
    `first-${compactUtc(meta.createdAt)}`,
    `observed-last-pre-rotate-${compactUtc(observedLastPreRotateMtimeMs)}`,
    `rotated-${compactUtc(rotatedAtMs)}`,
    `pid-${process.pid}`,
    `seq-${randomUUID()}`,
  ].join("__") + `${tag}.jsonl`;
  return path.join(archiveDir, filename);
}

async function acquireRotationLock(lockPath: string, timeoutMs: number, sink: string) {
  return acquireFileLock(lockPath, {
    timeoutMs,
    staleMs: Math.max(30_000, timeoutMs * 4),
    retryMs: Math.min(50, Math.max(5, Math.floor(timeoutMs / 10))),
    label: `${sink}-audit-rotation`,
  });
}

async function writeTransaction(transactionPath: string, transaction: RotationTransaction): Promise<void> {
  await writeRegularAtomicNoFollow(transactionPath, `${JSON.stringify(transaction)}\n`);
}

function isRotationTransaction(value: unknown, activePath: string, options: JsonlRotationOptions): value is RotationTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RotationTransaction>;
  const locations = pathsFor(activePath);
  return record.schemaVersion === 1 &&
    ["prepared", "meta_archived", "active_archived", "active_created", "meta_created"].includes(record.phase ?? "") &&
    record.activePath === activePath && record.metaPath === locations.metaPath &&
    typeof record.archivePath === "string" && path.dirname(record.archivePath) === locations.archiveDir &&
    record.archiveMetaPath === `${record.archivePath}.generation.json` &&
    record.boundaryPrecision === BOUNDARY_PRECISION &&
    !!record.oldIdentity && Number.isInteger(record.oldIdentity.dev) && Number.isInteger(record.oldIdentity.ino) &&
    isGenerationMeta(record.oldMeta, activePath, options.sink) &&
    isGenerationMeta(record.nextMeta, activePath, options.sink);
}

async function readTransaction(transactionPath: string, activePath: string, options: JsonlRotationOptions): Promise<RotationTransaction | undefined> {
  const bytes = await readRegularNoFollow(transactionPath);
  if (!bytes) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error(`invalid rotation transaction marker: ${transactionPath}`);
  }
  if (!isRotationTransaction(parsed, activePath, options)) throw new Error(`invalid rotation transaction marker: ${transactionPath}`);
  return parsed;
}

async function advancePhase(
  transactionPath: string,
  transaction: RotationTransaction,
  phase: RotationTransactionPhase,
  options: JsonlRotationOptions,
): Promise<void> {
  transaction.phase = phase;
  await writeTransaction(transactionPath, transaction);
  await options.afterRotationPhase?.(phase, transaction.archivePath);
  if (phase === "active_archived") await options.afterArchiveRename?.(transaction.archivePath);
}

async function recoverRotationTransactionLocked(activePath: string, options: JsonlRotationOptions): Promise<string | undefined> {
  const locations = pathsFor(activePath);
  const transaction = await readTransaction(locations.transactionPath, activePath, options);
  if (!transaction) return undefined;

  if (transaction.phase === "prepared") {
    const archivedMetaIdentity = await lstatIdentity(transaction.archiveMetaPath);
    if (!archivedMetaIdentity) {
      const liveMeta = await readGenerationMeta(transaction.metaPath, activePath, options.sink);
      if (!liveMeta || liveMeta.generationId !== transaction.oldMeta.generationId) {
        throw new Error("rotation recovery cannot identify prepared generation metadata");
      }
      await renameRegularNoFollow(transaction.metaPath, transaction.archiveMetaPath);
    }
    await advancePhase(locations.transactionPath, transaction, "meta_archived", options);
  }

  if (transaction.phase === "meta_archived") {
    const archivedIdentity = await lstatIdentity(transaction.archivePath);
    if (!archivedIdentity) {
      const activeIdentity = await lstatIdentity(activePath);
      if (!activeIdentity || !sameIdentity(activeIdentity, transaction.oldIdentity)) {
        throw new Error("rotation recovery detected old active identity loss before archive rename");
      }
      await options.beforeActiveRename?.(transaction.oldIdentity);
      const renamedIdentity = await renameRegularNoFollow(activePath, transaction.archivePath, transaction.oldIdentity);
      if (!sameIdentity(renamedIdentity, transaction.oldIdentity)) throw new Error("rotation recovery archive identity mismatch");
    } else if (!sameIdentity(archivedIdentity, transaction.oldIdentity)) {
      throw new Error("rotation recovery found unexpected archive identity");
    }
    await advancePhase(locations.transactionPath, transaction, "active_archived", options);
  }

  if (transaction.phase === "active_archived") {
    const activeIdentity = await lstatIdentity(activePath);
    if (activeIdentity && sameIdentity(activeIdentity, transaction.oldIdentity)) {
      throw new Error("rotation recovery found old generation at active path after archive rename");
    }
    if (!activeIdentity) await ensureActive(activePath);
    await advancePhase(locations.transactionPath, transaction, "active_created", options);
  }

  if (transaction.phase === "active_created") {
    const existingMeta = await readGenerationMeta(transaction.metaPath, activePath, options.sink);
    if (existingMeta && existingMeta.generationId !== transaction.nextMeta.generationId) {
      throw new Error("rotation recovery found conflicting next-generation metadata");
    }
    if (!existingMeta) await writeGenerationMeta(transaction.metaPath, transaction.nextMeta);
    await advancePhase(locations.transactionPath, transaction, "meta_created", options);
  }

  if (transaction.phase === "meta_created") await fs.unlink(locations.transactionPath);
  return transaction.archivePath;
}

async function recoverGenerationLocked(activePath: string, options: JsonlRotationOptions, nowMs: number): Promise<GenerationMeta> {
  const locations = pathsFor(activePath);
  await ensureDirectory(locations.sinkDir);
  await ensureDirectory(locations.archiveDir);
  await recoverRotationTransactionLocked(activePath, options);
  await ensureActive(activePath);
  let meta = await readGenerationMeta(locations.metaPath, activePath, options.sink);
  if (!meta) {
    meta = generationMeta(activePath, options.sink, nowMs);
    await writeGenerationMeta(locations.metaPath, meta);
  } else {
    await chmodRegularNoFollow(locations.metaPath);
  }
  return meta;
}

async function needsLockedRecovery(activePath: string, options: JsonlRotationOptions): Promise<boolean> {
  const locations = pathsFor(activePath);
  try {
    const [activeStat, meta, transaction] = await Promise.all([
      fs.lstat(activePath),
      readGenerationMeta(locations.metaPath, activePath, options.sink),
      readTransaction(locations.transactionPath, activePath, options),
    ]);
    return !activeStat.isFile() || !meta || !!transaction;
  } catch {
    return true;
  }
}

async function shouldRotate(
  activePath: string,
  meta: GenerationMeta,
  incomingBytes: number,
  settings: JsonlRotationSettings,
  nowMs: number,
  force: boolean,
): Promise<{ rotate: boolean; observedLastPreRotateMtimeMs: number; identity: FileIdentity }> {
  const handle = await fs.open(activePath, fsSync.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`active audit path is not a regular file: ${activePath}`);
    const createdAtMs = Date.parse(meta.createdAt);
    const sizeDue = stat.size > 0 && (stat.size > settings.maxBytes || stat.size + incomingBytes > settings.maxBytes);
    const ageDue = stat.size > 0 && nowMs - createdAtMs >= settings.maxAgeMs;
    return {
      rotate: force || sizeDue || ageDue,
      observedLastPreRotateMtimeMs: stat.mtimeMs,
      identity: identityOf(stat),
    };
  } finally {
    await handle.close();
  }
}

async function rotateLocked(
  activePath: string,
  options: JsonlRotationOptions,
  incomingBytes: number,
  diagnostics: JsonlRotationDiagnostic[],
): Promise<JsonlRotationResult> {
  const nowMs = (options.now ?? Date.now)();
  const locations = pathsFor(activePath);
  const recoveredArchivePath = await recoverRotationTransactionLocked(activePath, options);
  if (recoveredArchivePath) {
    await ensureActive(activePath);
    const meta = await readGenerationMeta(locations.metaPath, activePath, options.sink);
    if (!meta) throw new Error("rotation recovery did not restore generation metadata");
    return { rotated: true, archivePath: recoveredArchivePath, diagnostics };
  }

  const meta = await recoverGenerationLocked(activePath, options, nowMs);
  const decision = await shouldRotate(activePath, meta, incomingBytes, options.rotation, nowMs, options.force === true);
  if (!decision.rotate) return { rotated: false, diagnostics };

  await options.beforeRotationMutation?.(decision.identity);
  const archivePath = archivePathFor(
    locations.archiveDir,
    options.sink,
    meta,
    decision.observedLastPreRotateMtimeMs,
    nowMs,
    options.archiveTag,
  );
  const transaction: RotationTransaction = {
    schemaVersion: 1,
    phase: "prepared",
    activePath,
    archivePath,
    metaPath: locations.metaPath,
    archiveMetaPath: `${archivePath}.generation.json`,
    oldIdentity: decision.identity,
    oldMeta: meta,
    nextMeta: generationMeta(activePath, options.sink, nowMs),
    boundaryPrecision: BOUNDARY_PRECISION,
  };
  await writeTransaction(locations.transactionPath, transaction);
  await options.afterRotationPhase?.("prepared", archivePath);
  await recoverRotationTransactionLocked(activePath, options);
  return { rotated: true, archivePath, diagnostics };
}

async function rotateWithFailOpen(
  activePath: string,
  options: JsonlRotationOptions,
  incomingBytes: number,
): Promise<JsonlRotationResult> {
  const diagnostics: JsonlRotationDiagnostic[] = [];
  const locations = pathsFor(activePath);
  try {
    await ensureDirectory(locations.sinkDir);
    await ensureDirectory(locations.archiveDir);
  } catch (error) {
    diagnostics.push({ code: "recovery_failed", operation: "prepare", message: controlledMessage(error) });
    return { rotated: false, diagnostics };
  }

  const recoveryNeeded = await needsLockedRecovery(activePath, options);
  if (!options.rotation.enabled && !options.force) {
    if (recoveryNeeded) {
      try {
        const lock = await acquireRotationLock(locations.lockPath, options.rotation.lockTimeoutMs, options.sink);
        try { await recoverGenerationLocked(activePath, options, (options.now ?? Date.now)()); } finally { await lock.release(); }
      } catch (error) {
        diagnostics.push({ code: "recovery_failed", operation: "disabled_recovery", message: controlledMessage(error) });
      }
    }
    return { rotated: false, diagnostics };
  }

  let preliminaryRotate = recoveryNeeded || options.force === true;
  if (!preliminaryRotate) {
    try {
      const meta = await readGenerationMeta(locations.metaPath, activePath, options.sink);
      if (!meta) preliminaryRotate = true;
      else preliminaryRotate = (await shouldRotate(activePath, meta, incomingBytes, options.rotation, (options.now ?? Date.now)(), false)).rotate;
    } catch {
      preliminaryRotate = true;
    }
  }
  if (!preliminaryRotate) return { rotated: false, diagnostics };

  try {
    const lock = await acquireRotationLock(locations.lockPath, options.rotation.lockTimeoutMs, options.sink);
    try {
      return await rotateLocked(activePath, options, incomingBytes, diagnostics);
    } finally {
      await lock.release();
    }
  } catch (error) {
    diagnostics.push({
      code: recoveryNeeded ? "recovery_failed" : "rotation_failed",
      operation: recoveryNeeded ? "recover_or_rotate" : "rotate",
      message: controlledMessage(error),
    });
    return { rotated: false, diagnostics };
  }
}

async function acquireStrictRotationLock(lockPath: string): Promise<{ release(): Promise<void> }> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      lockPath,
      fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`rotation lock is busy; maintenance refuses to inspect or steal it: ${lockPath}`);
    }
    throw error;
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new Error(`rotation lock is not a regular file: ${lockPath}`);
  }
  const lockIdentity = identityOf(stat);
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: randomUUID(), created_at: new Date().toISOString(), label: "strict-maintenance-rotation" })}\n`);
  await handle.sync();
  await handle.chmod(0o600);
  await handle.close();
  return {
    release: async () => {
      const current = await fs.lstat(lockPath).catch(() => undefined);
      if (current?.isFile() && sameIdentity(identityOf(current), lockIdentity)) await fs.unlink(lockPath);
    },
  };
}

async function strictRotationInternal(activePath: string, options: StrictJsonlRotationOptions): Promise<JsonlRotationResult> {
  const locations = pathsFor(activePath);
  const lock = await acquireStrictRotationLock(locations.lockPath);
  try {
    const lockedIdentity = await options.validateLocked();
    if (!sameIdentity(lockedIdentity, options.expectedIdentity)) {
      throw new Error("active audit identity changed before rotation lock validation");
    }
    const result = await rotateLocked(activePath, {
      ...options,
      force: true,
      beforeRotationMutation: async (decisionIdentity) => {
        const currentIdentity = await options.validateLocked();
        if (!sameIdentity(currentIdentity, lockedIdentity) || !sameIdentity(decisionIdentity, lockedIdentity)) {
          throw new Error("active audit identity changed immediately before rotation mutation");
        }
      },
      beforeActiveRename: async (transactionIdentity) => {
        const currentIdentity = await options.validateLocked();
        if (!sameIdentity(currentIdentity, lockedIdentity) || !sameIdentity(transactionIdentity, lockedIdentity)) {
          throw new Error("active audit identity changed immediately before archive rename");
        }
      },
    }, 0, []);
    if (!result.rotated || !result.archivePath) throw new Error("strict maintenance rotation did not produce an archive");
    const archived = await fs.lstat(result.archivePath);
    if (!archived.isFile() || !sameIdentity(identityOf(archived), lockedIdentity)) {
      throw new Error("archive identity does not match the locked active file identity");
    }
    return result;
  } finally {
    await lock.release();
  }
}

async function appendInternal(activePath: string, serializedLine: string, options: JsonlRotationOptions): Promise<JsonlAppendResult> {
  const line = serializedLine.endsWith("\n") ? serializedLine : `${serializedLine}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  const oversize = bytes > options.rotation.maxBytes;
  const rotationResult = await rotateWithFailOpen(activePath, options, bytes);
  if (oversize) {
    rotationResult.diagnostics.push({
      code: "oversize_line",
      operation: "append",
      message: `serialized JSONL row is ${bytes} bytes; soft max is ${options.rotation.maxBytes} bytes`,
    });
  }

  let appended = false;
  try {
    await ensureDirectory(path.dirname(activePath));
    const opened = await openRegularNoFollow(
      activePath,
      fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT,
      0o600,
    );
    try {
      await opened.handle.writeFile(line, { encoding: "utf8" });
      appended = true;
      try { await opened.handle.chmod(0o600); } catch (error) {
        rotationResult.diagnostics.push({ code: "permission_repair_failed", operation: "active_chmod", message: controlledMessage(error) });
      }
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    rotationResult.diagnostics.push({ code: "recovery_failed", operation: "business_append", message: controlledMessage(error) });
  }

  return { ...rotationResult, appended, bytes, oversize };
}

/**
 * Append one already-serialized JSON object as one JSONL record. Calls are
 * process-locally serialized by resolved active path. Rotation failures are
 * fail-open: the complete line is still attempted against the active path and
 * the failure is returned as a controlled diagnostic.
 *
 * A process that already held the old inode may append after rename. Therefore
 * generation boundaries are eventually stable, not linearizable; seal verifies
 * a later stable snapshot rather than treating the rename timestamp as final.
 */
export function appendRotatingJsonlLine(
  activePath: string,
  serializedLine: string,
  options: JsonlRotationOptions,
): Promise<JsonlAppendResult> {
  return serializeForPath(activePath, () => appendInternal(path.resolve(activePath), serializedLine, options));
}

/** Force a generation boundary without reading audit contents. Runtime failures remain fail-open. */
export function rotateJsonlGeneration(
  activePath: string,
  options: JsonlRotationOptions,
): Promise<JsonlRotationResult> {
  return serializeForPath(activePath, () => rotateWithFailOpen(path.resolve(activePath), { ...options, force: true }, 0));
}

/** Fail-closed maintenance-only rotation with an in-lock identity check. */
export function rotateJsonlGenerationStrict(
  activePath: string,
  options: StrictJsonlRotationOptions,
): Promise<JsonlRotationResult> {
  const resolved = path.resolve(activePath);
  return serializeForPath(resolved, () => strictRotationInternal(resolved, { ...options, force: true }));
}
