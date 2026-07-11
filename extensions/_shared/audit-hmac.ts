import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const KEY_BYTES = 32;
const MIN_UNIQUE_KEY_BYTES = 16;
const KEY_FILE = ".audit-hmac-key";
const KEY_CACHE = Symbol.for("pi-astack/audit-hmac/key-cache/v1");
const FALLBACK_KEYS = Symbol.for("pi-astack/audit-hmac/fallback-keys/v1");

interface AuditHmacKey {
  key: Buffer;
  keyId: string;
}

function globalMap(symbol: symbol): Map<string, AuditHmacKey> {
  const global = globalThis as Record<symbol, unknown>;
  let value = global[symbol] as Map<string, AuditHmacKey> | undefined;
  if (!value) {
    value = new Map<string, AuditHmacKey>();
    global[symbol] = value;
  }
  return value;
}

function deriveKeyId(key: Buffer): string {
  return createHmac("sha256", key).update("pi-astack/audit-hmac/key-id/v1", "utf8").digest("hex").slice(0, 24);
}

function assertStrongKey(key: Buffer, file: string): void {
  if (key.length !== KEY_BYTES) throw new Error(`invalid audit HMAC key length: ${file}`);
  const unique = new Set(key.values()).size;
  const repeatedShortPeriod = Array.from({ length: 16 }, (_, index) => index + 1)
    .some((period) => key.every((byte, index) => index < period || byte === key[index % period]));
  const monotonic = key.length > 1 && (() => {
    const step = (key[1] - key[0] + 256) % 256;
    return key.every((byte, index) => index === 0 || byte === (key[0] + step * index) % 256);
  })();
  if (unique < MIN_UNIQUE_KEY_BYTES || repeatedShortPeriod || monotonic) {
    throw new Error(`weak audit HMAC key material rejected: ${file}`);
  }
}

function assertCurrentOwner(stat: fs.Stats, target: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw new Error(`audit HMAC path owner is not the current uid: ${target}`);
}

function assertExactMode(stat: fs.Stats, expected: number, target: string): void {
  if ((stat.mode & 0o777) !== expected) throw new Error(`audit HMAC path mode must be ${expected.toString(8)}: ${target}`);
}

function verifyDirectoryIdentity(directory: string, fd: number, expected: fs.Stats): void {
  const held = fs.fstatSync(fd);
  const current = fs.lstatSync(directory);
  if (!held.isDirectory() || current.isSymbolicLink() || !current.isDirectory() ||
      held.dev !== expected.dev || held.ino !== expected.ino || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`audit HMAC directory identity changed: ${directory}`);
  }
}

interface HeldDirectory {
  path: string;
  fd: number;
  stat: fs.Stats;
}

function openRootDirectory(directory: string): HeldDirectory {
  const before = fs.lstatSync(directory);
  if (before.isSymbolicLink() || !before.isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error(`audit HMAC project root must be a canonical directory: ${directory}`);
  }
  assertCurrentOwner(before, directory);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    verifyDirectoryIdentity(directory, fd, before);
    return { path: directory, fd, stat: before };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function openPrivateChild(parent: HeldDirectory, basename: string, createIfMissing = true): HeldDirectory {
  if (process.platform !== "linux") throw new Error("safe audit HMAC directory-relative access requires Linux /proc/self/fd");
  verifyDirectoryIdentity(parent.path, parent.fd, parent.stat);
  const directory = path.join(parent.path, basename);
  const access = path.join(`/proc/self/fd/${parent.fd}`, basename);
  let created = false;
  if (createIfMissing) {
    try {
      fs.mkdirSync(access, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const before = fs.lstatSync(access);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`unsafe audit HMAC directory: ${directory}`);
  assertCurrentOwner(before, directory);
  if (!created) assertExactMode(before, 0o700, directory);
  const fd = fs.openSync(access, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    if (created) fs.fchmodSync(fd, 0o700);
    const held = fs.fstatSync(fd);
    if (!held.isDirectory() || held.dev !== before.dev || held.ino !== before.ino) {
      throw new Error(`audit HMAC directory identity changed while opening: ${directory}`);
    }
    assertCurrentOwner(held, directory);
    assertExactMode(held, 0o700, directory);
    verifyDirectoryIdentity(parent.path, parent.fd, parent.stat);
    const logical = fs.lstatSync(directory);
    if (logical.isSymbolicLink() || !logical.isDirectory() || logical.dev !== held.dev || logical.ino !== held.ino) {
      throw new Error(`audit HMAC child path identity changed: ${directory}`);
    }
    return { path: directory, fd, stat: held };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readKeyFile(accessFile: string, logicalFile: string): Buffer {
  const before = fs.lstatSync(accessFile);
  if (before.isSymbolicLink() || !before.isFile() || before.size !== KEY_BYTES) {
    throw new Error(`invalid audit HMAC key file: ${logicalFile}`);
  }
  assertCurrentOwner(before, logicalFile);
  assertExactMode(before, 0o600, logicalFile);
  const fd = fs.openSync(accessFile, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const held = fs.fstatSync(fd);
    if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino || held.size !== KEY_BYTES) {
      throw new Error(`audit HMAC key identity changed: ${logicalFile}`);
    }
    assertCurrentOwner(held, logicalFile);
    assertExactMode(held, 0o600, logicalFile);
    const key = Buffer.allocUnsafe(KEY_BYTES);
    const bytes = fs.readSync(fd, key, 0, key.length, 0);
    if (bytes !== KEY_BYTES) throw new Error(`short audit HMAC key read: ${logicalFile}`);
    assertStrongKey(key, logicalFile);
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

function persistentProjectKey(projectRoot: string, createIfMissing = true): AuditHmacKey {
  const root = openRootDirectory(path.resolve(projectRoot));
  let moduleDir: HeldDirectory | undefined;
  let sinkDir: HeldDirectory | undefined;
  try {
    moduleDir = openPrivateChild(root, ".pi-astack", createIfMissing);
    sinkDir = openPrivateChild(moduleDir, "llm-audit", createIfMissing);
    verifyDirectoryIdentity(root.path, root.fd, root.stat);
    verifyDirectoryIdentity(moduleDir.path, moduleDir.fd, moduleDir.stat);
    verifyDirectoryIdentity(sinkDir.path, sinkDir.fd, sinkDir.stat);
    const logicalFile = path.join(sinkDir.path, KEY_FILE);
    const accessFile = path.join(`/proc/self/fd/${sinkDir.fd}`, KEY_FILE);
    if (createIfMissing) {
      try {
        const candidate = randomBytes(KEY_BYTES);
        assertStrongKey(candidate, logicalFile);
        const fd = fs.openSync(accessFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
        try {
          const written = fs.writeSync(fd, candidate, 0, candidate.length, 0);
          if (written !== candidate.length) throw new Error(`short audit HMAC key write: ${logicalFile}`);
          fs.fchmodSync(fd, 0o600);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.fsyncSync(sinkDir.fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    verifyDirectoryIdentity(root.path, root.fd, root.stat);
    verifyDirectoryIdentity(moduleDir.path, moduleDir.fd, moduleDir.stat);
    verifyDirectoryIdentity(sinkDir.path, sinkDir.fd, sinkDir.stat);
    const key = readKeyFile(accessFile, logicalFile);
    return { key, keyId: deriveKeyId(key) };
  } finally {
    if (sinkDir) fs.closeSync(sinkDir.fd);
    if (moduleDir) fs.closeSync(moduleDir.fd);
    fs.closeSync(root.fd);
  }
}

function strictProjectKey(projectRoot: string): AuditHmacKey {
  const cacheKey = path.resolve(projectRoot);
  const cache = globalMap(KEY_CACHE);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const value = persistentProjectKey(cacheKey);
  cache.set(cacheKey, value);
  return value;
}

function projectKey(projectRoot: string): AuditHmacKey {
  const cacheKey = path.resolve(projectRoot);
  try {
    return strictProjectKey(cacheKey);
  } catch {
    const fallbacks = globalMap(FALLBACK_KEYS);
    let fallback = fallbacks.get(cacheKey);
    if (!fallback) {
      const key = randomBytes(KEY_BYTES);
      fallback = { key, keyId: `ephemeral-${deriveKeyId(key)}` };
      fallbacks.set(cacheKey, fallback);
    }
    return fallback;
  }
}

function frame(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

export interface AuditRollingHmac {
  readonly algorithm: "hmac-sha256";
  readonly keyId: string;
  update(label: string, value: string | Buffer): void;
  digestHex(): string;
}

export function createAuditRollingHmac(projectRoot: string, domain: string): AuditRollingHmac {
  const material = projectKey(projectRoot);
  const hmac = createHmac("sha256", material.key);
  hmac.update(frame("pi-astack/audit-rolling-hmac/v1"));
  hmac.update(frame(domain));
  let finalized: string | undefined;
  return {
    algorithm: "hmac-sha256",
    keyId: material.keyId,
    update(label: string, value: string | Buffer): void {
      if (finalized) throw new Error("audit rolling HMAC is already finalized");
      hmac.update(frame(label));
      hmac.update(frame(value));
    },
    digestHex(): string {
      if (!finalized) finalized = hmac.digest("hex");
      return finalized;
    },
  };
}

function hmacHexWithMaterial(material: AuditHmacKey, domain: string, value: string | Buffer): { algorithm: "hmac-sha256"; key_id: string; digest: string } {
  const hmac = createHmac("sha256", material.key);
  hmac.update(frame("pi-astack/audit-hmac/v1"));
  hmac.update(frame(domain));
  hmac.update(frame("value"));
  hmac.update(frame(value));
  return { algorithm: "hmac-sha256", key_id: material.keyId, digest: hmac.digest("hex") };
}

export function auditHmacHex(projectRoot: string, domain: string, value: string | Buffer): { algorithm: "hmac-sha256"; key_id: string; digest: string } {
  return hmacHexWithMaterial(projectKey(projectRoot), domain, value);
}

export function auditHmacHexStrict(projectRoot: string, domain: string, value: string | Buffer): { algorithm: "hmac-sha256"; key_id: string; digest: string } {
  return hmacHexWithMaterial(strictProjectKey(projectRoot), domain, value);
}

export function verifyAuditHmacHexStrict(
  projectRoot: string,
  domain: string,
  value: string | Buffer,
  signature: { algorithm?: unknown; key_id?: unknown; digest?: unknown },
): boolean {
  if (signature.algorithm !== "hmac-sha256" || typeof signature.key_id !== "string" || typeof signature.digest !== "string" || !/^[0-9a-f]{64}$/.test(signature.digest)) return false;
  const expected = auditHmacHexStrict(projectRoot, domain, value);
  if (signature.key_id !== expected.key_id) return false;
  return timingSafeEqual(Buffer.from(signature.digest, "hex"), Buffer.from(expected.digest, "hex"));
}

export function signAuditMaintenanceHmacStrict(
  projectRoot: string,
  domain: string,
  value: string | Buffer,
): { algorithm: "hmac-sha256"; key_id: string; digest: string } {
  return hmacHexWithMaterial(persistentProjectKey(path.resolve(projectRoot)), domain, value);
}

export function verifyAuditMaintenanceHmacStrict(
  projectRoot: string,
  domain: string,
  value: string | Buffer,
  signature: { algorithm?: unknown; key_id?: unknown; digest?: unknown },
): boolean {
  if (signature.algorithm !== "hmac-sha256" || typeof signature.key_id !== "string" || typeof signature.digest !== "string" || !/^[0-9a-f]{64}$/.test(signature.digest)) return false;
  const expected = hmacHexWithMaterial(persistentProjectKey(path.resolve(projectRoot), false), domain, value);
  return signature.key_id === expected.key_id && timingSafeEqual(Buffer.from(signature.digest, "hex"), Buffer.from(expected.digest, "hex"));
}

export function _resetAuditHmacCachesForTests(): void {
  globalMap(KEY_CACHE).clear();
  globalMap(FALLBACK_KEYS).clear();
}
