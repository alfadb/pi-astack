/**
 * C2 blocked startup memo — diagnostic only.
 * Schema/path independent of attestation and last-known-ready.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicWriteFile } from "./durable-write";

export const CANONICAL_BLOCKED_MEMO_SCHEMA = "pi-astack/canonical-blocked-memo/v1" as const;
export const CANONICAL_BLOCKED_MEMO_DIR_REL = ".state/sediment/canonical-blocked-memo/v1" as const;
export const CANONICAL_BLOCKED_MEMO_FILE = "blocked-memo.json" as const;

export interface CanonicalBlockedMemoRecord {
  readonly schema: typeof CANONICAL_BLOCKED_MEMO_SCHEMA;
  readonly head: string;
  readonly statusHash: string;
  readonly inventoryFingerprint: string;
  readonly implementationFingerprint: string;
  readonly validatorFingerprint: string;
  readonly registryHash: string;
  readonly reason_code?: string;
  readonly open_count?: number;
  readonly quarantine_count?: number;
  readonly eligibility_false?: boolean;
}

export type CanonicalBlockedMemoKeys = Pick<
  CanonicalBlockedMemoRecord,
  | "head"
  | "statusHash"
  | "inventoryFingerprint"
  | "implementationFingerprint"
  | "validatorFingerprint"
  | "registryHash"
>;

const MEMO_KEY_NAMES = Object.freeze([
  "head",
  "statusHash",
  "inventoryFingerprint",
  "implementationFingerprint",
  "validatorFingerprint",
  "registryHash",
] as const);

export class CanonicalBlockedMemoError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CanonicalBlockedMemoError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

export function canonicalBlockedMemoDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), CANONICAL_BLOCKED_MEMO_DIR_REL);
}

export function canonicalBlockedMemoPath(abrainHome: string): string {
  return path.join(canonicalBlockedMemoDir(abrainHome), CANONICAL_BLOCKED_MEMO_FILE);
}

export function buildCanonicalBlockedMemo(
  keys: CanonicalBlockedMemoKeys,
  diagnostic?: { reason_code?: string; open_count?: number; quarantine_count?: number; eligibility_false?: boolean },
): CanonicalBlockedMemoRecord {
  assertMemoKeys(keys);
  return Object.freeze({
    schema: CANONICAL_BLOCKED_MEMO_SCHEMA,
    head: keys.head,
    statusHash: keys.statusHash,
    inventoryFingerprint: keys.inventoryFingerprint,
    implementationFingerprint: keys.implementationFingerprint,
    validatorFingerprint: keys.validatorFingerprint,
    registryHash: keys.registryHash,
    ...(diagnostic?.reason_code ? { reason_code: diagnostic.reason_code } : {}),
    ...(typeof diagnostic?.open_count === "number" ? { open_count: diagnostic.open_count } : {}),
    ...(typeof diagnostic?.quarantine_count === "number" ? { quarantine_count: diagnostic.quarantine_count } : {}),
    ...(typeof diagnostic?.eligibility_false === "boolean" ? { eligibility_false: diagnostic.eligibility_false } : {}),
  });
}

export async function writeCanonicalBlockedMemo(
  abrainHome: string,
  record: CanonicalBlockedMemoRecord,
): Promise<string> {
  if (record.schema !== CANONICAL_BLOCKED_MEMO_SCHEMA) {
    throw new CanonicalBlockedMemoError("BLOCKED_MEMO_SCHEMA_INVALID", "schema must be pi-astack/canonical-blocked-memo/v1");
  }
  assertMemoKeys(record);
  const dir = canonicalBlockedMemoDir(abrainHome);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(dir, 0o700); } catch { /* best-effort */ }
  const filePath = canonicalBlockedMemoPath(abrainHome);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  await durableAtomicWriteFile(filePath, payload);
  try { await fsp.chmod(filePath, 0o600); } catch { /* best-effort */ }
  return filePath;
}

export async function readCanonicalBlockedMemo(abrainHome: string): Promise<CanonicalBlockedMemoRecord | null> {
  const filePath = canonicalBlockedMemoPath(abrainHome);
  let raw: string;
  try {
    const st = await fsp.lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.schema !== CANONICAL_BLOCKED_MEMO_SCHEMA) return null;
  for (const key of MEMO_KEY_NAMES) {
    if (typeof rec[key] !== "string" || !(rec[key] as string).length) return null;
  }
  return Object.freeze({
    schema: CANONICAL_BLOCKED_MEMO_SCHEMA,
    head: rec.head as string,
    statusHash: rec.statusHash as string,
    inventoryFingerprint: rec.inventoryFingerprint as string,
    implementationFingerprint: rec.implementationFingerprint as string,
    validatorFingerprint: rec.validatorFingerprint as string,
    registryHash: rec.registryHash as string,
    ...(typeof rec.reason_code === "string" ? { reason_code: rec.reason_code } : {}),
    ...(typeof rec.open_count === "number" ? { open_count: rec.open_count } : {}),
    ...(typeof rec.quarantine_count === "number" ? { quarantine_count: rec.quarantine_count } : {}),
    ...(typeof rec.eligibility_false === "boolean" ? { eligibility_false: rec.eligibility_false } : {}),
  });
}

export async function clearCanonicalBlockedMemo(abrainHome: string): Promise<boolean> {
  const filePath = canonicalBlockedMemoPath(abrainHome);
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

export function memoKeysMatch(
  memo: CanonicalBlockedMemoKeys,
  observed: CanonicalBlockedMemoKeys,
): boolean {
  return MEMO_KEY_NAMES.every((key) => memo[key] === observed[key]);
}

function assertMemoKeys(keys: CanonicalBlockedMemoKeys): void {
  for (const key of MEMO_KEY_NAMES) {
    const value = keys[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new CanonicalBlockedMemoError("BLOCKED_MEMO_KEY_INVALID", `memo key ${key} must be a non-empty string`);
    }
  }
}

/** Ready / attestation readers must never open this path — exported for static audits. */
export function isCanonicalBlockedMemoPath(candidate: string, abrainHome: string): boolean {
  try {
    return fs.realpathSync.native(path.resolve(candidate)) === fs.realpathSync.native(canonicalBlockedMemoPath(abrainHome));
  } catch {
    return path.resolve(candidate) === path.resolve(canonicalBlockedMemoPath(abrainHome));
  }
}
