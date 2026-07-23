/**
 * Durable sediment intake trigger.
 *
 * The trigger is intentionally a small receipt over immutable pi session
 * coordinates. It never copies branch entries or messages into ~/.abrain.
 * Recovery rebuilds the frozen branch from pi's persisted session JSONL at
 * branchTip.id using pi's own session parser.
 */

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { durableAtomicCreateFile, durableAtomicWriteFile, fsyncDirectory } from "../_shared/durable-write";
import { canonicalizeJcs, normalizeJcsValueOmittingUndefined } from "../_shared/jcs";
import { acquireRetainedDirectoryOfdLock } from "../_shared/retained-directory-ofd-lock";

export const SEDIMENT_INTAKE_SCHEMA = "sediment-intake/v2" as const;

export interface SedimentIntakeAnchor {
  session_id?: string;
  turn_id?: number | string;
  subturn?: number | string;
  sub_agent_label?: string;
  device_id?: string;
}

export interface SedimentIntakeBranchTip {
  id: string;
  parentId: string | null;
  type: string;
  timestampUtc: string;
}

export interface SedimentIntakeCaptureBoundary {
  kind: "agent_end";
  terminalAssistantStopReason?: string;
  terminalAssistantErrorDigest?: string;
  boundaryUntrusted: boolean;
  boundaryDiagnosticCode?: string;
}

/** Lightweight create-only trigger. No transcript/message body is allowed. */
export interface SedimentIntakeRecord {
  schema: typeof SEDIMENT_INTAKE_SCHEMA;
  windowId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  branchTip: SedimentIntakeBranchTip;
  /** Digest of the immutable pi source coordinates, not session file bytes. */
  sourceDigest: string;
  anchor?: SedimentIntakeAnchor;
  captureBoundary: SedimentIntakeCaptureBoundary;
}

export type SedimentIntakeWriteStatus = "created" | "identical" | "collision";

export interface SedimentIntakeWriteResult {
  status: SedimentIntakeWriteStatus;
  windowId: string;
  filePath: string;
  record: SedimentIntakeRecord;
  durationMs: number;
}

export interface SedimentIntakeListItem {
  windowId: string;
  filePath: string;
  sessionId: string;
  sessionFile: string;
  branchTipId: string;
  sourceTimestampUtc: string;
  approxBytes: number;
  mtimeMs: number;
}

export type SedimentIntakeRestoreResult =
  | { ok: true; record: SedimentIntakeRecord; branchEntries: SessionEntry[]; header: SessionHeader }
  | { ok: false; status: "source_unavailable" | "source_invalid"; record: SedimentIntakeRecord; detail: string };

export type SedimentIntakeClaim =
  | { claimed: false; status: "busy" }
  | { claimed: true; status: "acquired"; owner: string; release(): void };

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalizeJcs(normalizeJcsValueOmittingUndefined(value)));
}

export function sedimentIntakeRoot(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "sediment", "intake");
}

export function sedimentIntakePendingDir(abrainHome: string): string {
  return path.join(sedimentIntakeRoot(abrainHome), "pending");
}

export function sedimentIntakeAckedDir(abrainHome: string): string {
  return path.join(sedimentIntakeRoot(abrainHome), "acked");
}

export function sedimentIntakeStatusDir(abrainHome: string): string {
  return path.join(sedimentIntakeRoot(abrainHome), "status");
}

export function sedimentIntakeClaimsDir(abrainHome: string): string {
  return path.join(sedimentIntakeRoot(abrainHome), "claims");
}

function assertWindowId(windowId: string): void {
  if (!/^[0-9a-f]{64}$/.test(windowId)) throw new Error(`invalid sediment intake windowId: ${windowId}`);
}

export function sedimentIntakePendingPath(abrainHome: string, windowId: string): string {
  assertWindowId(windowId);
  return path.join(sedimentIntakePendingDir(abrainHome), `${windowId}.json`);
}

function normalizedTip(tip: SedimentIntakeBranchTip): SedimentIntakeBranchTip {
  const parsedTimestamp = Date.parse(tip.timestampUtc);
  if (!tip.id || typeof tip.id !== "string") throw new Error("sediment intake branch tip id is required");
  if (!tip.type || typeof tip.type !== "string") throw new Error("sediment intake branch tip type is required");
  if (!Number.isFinite(parsedTimestamp)) throw new Error("sediment intake branch tip timestamp is invalid");
  if (tip.parentId !== null && typeof tip.parentId !== "string") throw new Error("sediment intake branch tip parentId is invalid");
  return {
    id: tip.id,
    parentId: tip.parentId,
    type: tip.type,
    timestampUtc: new Date(parsedTimestamp).toISOString(),
  };
}

function sourceCoordinates(args: {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  branchTip: SedimentIntakeBranchTip;
}): Record<string, unknown> {
  return {
    sessionId: args.sessionId,
    sessionFile: path.resolve(args.sessionFile),
    cwd: path.resolve(args.cwd),
    branchTip: normalizedTip(args.branchTip),
  };
}

function intakeIdentity(record: Omit<SedimentIntakeRecord, "windowId">): Record<string, unknown> {
  return {
    schema: record.schema,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    cwd: record.cwd,
    branchTip: record.branchTip,
    sourceDigest: record.sourceDigest,
    anchor: record.anchor ?? null,
    captureBoundary: record.captureBoundary,
  };
}

export function computeSedimentIntakeWindowId(args: {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  branchTip: SedimentIntakeBranchTip;
  anchor?: SedimentIntakeAnchor;
  captureBoundary: SedimentIntakeCaptureBoundary;
}): string {
  const coordinates = sourceCoordinates(args);
  const withoutId: Omit<SedimentIntakeRecord, "windowId"> = {
    schema: SEDIMENT_INTAKE_SCHEMA,
    sessionId: args.sessionId,
    sessionFile: path.resolve(args.sessionFile),
    cwd: path.resolve(args.cwd),
    branchTip: normalizedTip(args.branchTip),
    sourceDigest: canonicalHash(coordinates),
    ...(args.anchor ? { anchor: args.anchor } : {}),
    captureBoundary: args.captureBoundary,
  };
  return canonicalHash(intakeIdentity(withoutId));
}

export function buildSedimentIntakeRecord(args: {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  branchTip: SedimentIntakeBranchTip;
  anchor?: SedimentIntakeAnchor;
  captureBoundary: SedimentIntakeCaptureBoundary;
}): SedimentIntakeRecord {
  if (!args.sessionId) throw new Error("sediment intake sessionId is required");
  if (!args.sessionFile) throw new Error("sediment intake sessionFile is required");
  const coordinates = sourceCoordinates(args);
  const withoutId: Omit<SedimentIntakeRecord, "windowId"> = {
    schema: SEDIMENT_INTAKE_SCHEMA,
    sessionId: args.sessionId,
    sessionFile: path.resolve(args.sessionFile),
    cwd: path.resolve(args.cwd),
    branchTip: normalizedTip(args.branchTip),
    sourceDigest: canonicalHash(coordinates),
    ...(args.anchor ? { anchor: args.anchor } : {}),
    captureBoundary: {
      kind: "agent_end",
      ...(args.captureBoundary.terminalAssistantStopReason
        ? { terminalAssistantStopReason: args.captureBoundary.terminalAssistantStopReason }
        : {}),
      ...(args.captureBoundary.terminalAssistantErrorDigest
        ? { terminalAssistantErrorDigest: args.captureBoundary.terminalAssistantErrorDigest }
        : {}),
      boundaryUntrusted: args.captureBoundary.boundaryUntrusted === true,
      ...(args.captureBoundary.boundaryDiagnosticCode
        ? { boundaryDiagnosticCode: args.captureBoundary.boundaryDiagnosticCode }
        : {}),
    },
  };
  return { ...withoutId, windowId: canonicalHash(intakeIdentity(withoutId)) };
}

function validateRecord(record: SedimentIntakeRecord, expectedWindowId?: string): void {
  if (!record || record.schema !== SEDIMENT_INTAKE_SCHEMA) throw new Error("unsupported sediment intake schema");
  if (expectedWindowId && record.windowId !== expectedWindowId) throw new Error("sediment intake filename/windowId mismatch");
  const expected = computeSedimentIntakeWindowId({
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    cwd: record.cwd,
    branchTip: record.branchTip,
    anchor: record.anchor,
    captureBoundary: record.captureBoundary,
  });
  if (record.windowId !== expected) throw new Error(`sediment intake windowId mismatch: ${record.windowId} !== ${expected}`);
  if (record.sourceDigest !== canonicalHash(sourceCoordinates(record))) throw new Error("sediment intake sourceDigest mismatch");
}

export async function writeSedimentIntakeRecord(
  abrainHome: string,
  record: SedimentIntakeRecord,
): Promise<SedimentIntakeWriteResult> {
  const started = Date.now();
  validateRecord(record);
  const pendingDir = sedimentIntakePendingDir(abrainHome);
  await fs.mkdir(pendingDir, { recursive: true, mode: 0o700 });
  const filePath = sedimentIntakePendingPath(abrainHome, record.windowId);
  const raw = `${JSON.stringify(record)}\n`;
  const createStatus = await durableAtomicCreateFile(filePath, raw, { mode: 0o600 });
  if (createStatus !== "collision") {
    return { status: createStatus, windowId: record.windowId, filePath, record, durationMs: Date.now() - started };
  }

  // A hash-path collision is identical only when the complete immutable
  // trigger identity matches. Session/window alone is never sufficient.
  try {
    const existingRaw = await fs.readFile(filePath, "utf-8");
    const existing = JSON.parse(existingRaw) as SedimentIntakeRecord;
    validateRecord(existing, record.windowId);
    if (canonicalizeJcs(existing) === canonicalizeJcs(record)) {
      return { status: "identical", windowId: record.windowId, filePath, record: existing, durationMs: Date.now() - started };
    }
  } catch {
    // Hard collision below; caller must not enqueue or checkpoint it.
  }
  return { status: "collision", windowId: record.windowId, filePath, record, durationMs: Date.now() - started };
}

export async function readSedimentIntakeRecord(abrainHome: string, windowId: string): Promise<SedimentIntakeRecord | null> {
  const filePath = sedimentIntakePendingPath(abrainHome, windowId);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as SedimentIntakeRecord;
    validateRecord(parsed, windowId);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listSedimentIntakePending(abrainHome: string): Promise<SedimentIntakeListItem[]> {
  const pendingDir = sedimentIntakePendingDir(abrainHome);
  let names: string[];
  try {
    names = await fs.readdir(pendingDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SedimentIntakeListItem[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const filePath = path.join(pendingDir, name);
    try {
      const [raw, st] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)]);
      const record = JSON.parse(raw) as SedimentIntakeRecord;
      validateRecord(record, name.slice(0, 64));
      out.push({
        windowId: record.windowId,
        filePath,
        sessionId: record.sessionId,
        sessionFile: record.sessionFile,
        branchTipId: record.branchTip.id,
        sourceTimestampUtc: record.branchTip.timestampUtc,
        approxBytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // A corrupt trigger remains on disk for operator inspection; it is not
      // silently acked or TTL-deleted.
    }
  }
  out.sort((a, b) => a.sourceTimestampUtc.localeCompare(b.sourceTimestampUtc) || a.mtimeMs - b.mtimeMs || a.windowId.localeCompare(b.windowId));
  return out;
}

export async function listSedimentIntakePendingForSession(abrainHome: string, sessionId: string): Promise<SedimentIntakeListItem[]> {
  return (await listSedimentIntakePending(abrainHome)).filter((item) => item.sessionId === sessionId);
}

function entryMatchesTip(entry: SessionEntry, tip: SedimentIntakeBranchTip): boolean {
  const entryTimestamp = Date.parse(entry.timestamp);
  return entry.id === tip.id
    && entry.parentId === tip.parentId
    && entry.type === tip.type
    && Number.isFinite(entryTimestamp)
    && new Date(entryTimestamp).toISOString() === tip.timestampUtc;
}

/** Rebuild the exact frozen branch from persisted pi JSONL at the intake tip. */
export async function restoreSedimentIntakeBranch(record: SedimentIntakeRecord): Promise<SedimentIntakeRestoreResult> {
  validateRecord(record);
  let raw: string;
  try {
    raw = await fs.readFile(record.sessionFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: "source_unavailable", record, detail: `session source unavailable: ${record.sessionFile}` };
    }
    return { ok: false, status: "source_unavailable", record, detail: `session source unreadable: ${String((err as Error).message || err)}` };
  }

  try {
    const fileEntries = parseSessionEntries(raw) as FileEntry[];
    migrateSessionEntries(fileEntries);
    const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
    if (!header) throw new Error("session header missing");
    if (header.id !== record.sessionId) throw new Error(`session id mismatch: ${header.id} !== ${record.sessionId}`);
    const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
    const byId = new Map<string, SessionEntry>();
    for (const entry of entries) {
      if (!entry.id || byId.has(entry.id)) throw new Error(`duplicate or missing session entry id: ${String(entry.id)}`);
      byId.set(entry.id, entry);
    }
    const tip = byId.get(record.branchTip.id);
    if (!tip) throw new Error(`branch tip not found: ${record.branchTip.id}`);
    if (!entryMatchesTip(tip, record.branchTip)) throw new Error("branch tip immutable metadata mismatch");
    if (record.sourceDigest !== canonicalHash(sourceCoordinates(record))) throw new Error("source digest mismatch");

    const reverse: SessionEntry[] = [];
    const seen = new Set<string>();
    let current: SessionEntry | undefined = tip;
    while (current) {
      if (seen.has(current.id)) throw new Error(`session parent cycle at ${current.id}`);
      seen.add(current.id);
      reverse.push(current);
      if (current.parentId === null) break;
      current = byId.get(current.parentId);
      if (!current) throw new Error("session parent chain is incomplete");
    }
    reverse.reverse();
    return { ok: true, record, branchEntries: reverse, header };
  } catch (err) {
    return { ok: false, status: "source_invalid", record, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist a small operational status while leaving the pending trigger intact. */
export async function writeSedimentIntakeRecoveryStatus(
  abrainHome: string,
  record: SedimentIntakeRecord,
  status: "ready" | "source_unavailable" | "source_invalid",
  detail?: string,
): Promise<string> {
  const dir = sedimentIntakeStatusDir(abrainHome);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${record.windowId}.json`);
  await durableAtomicWriteFile(file, `${JSON.stringify({
    schema: "sediment-intake-recovery-status/v1",
    windowId: record.windowId,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    status,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  })}\n`, { mode: 0o600 });
  return file;
}

/** Nonblocking cross-process claim. Crash/SIGKILL releases the retained OFD. */
export function tryClaimSedimentIntake(abrainHome: string, windowId: string, owner: string): SedimentIntakeClaim {
  assertWindowId(windowId);
  const claimDir = path.join(sedimentIntakeClaimsDir(abrainHome), windowId);
  fsSync.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
  const lock = acquireRetainedDirectoryOfdLock(claimDir);
  if (lock.status === "BUSY") return { claimed: false, status: "busy" };
  let released = false;
  return {
    claimed: true,
    status: "acquired",
    owner,
    release() {
      if (released) return;
      released = true;
      lock.close();
    },
  };
}

/** Ack only after durable checkpoint coverage has been proven by the caller. */
export async function ackSedimentIntake(abrainHome: string, windowId: string): Promise<{ status: "acked" | "missing"; fromPath: string; toPath?: string }> {
  const fromPath = sedimentIntakePendingPath(abrainHome, windowId);
  const ackedDir = sedimentIntakeAckedDir(abrainHome);
  await fs.mkdir(ackedDir, { recursive: true, mode: 0o700 });
  const toPath = path.join(ackedDir, `${windowId}.json`);
  try {
    await fs.rename(fromPath, toPath);
    await fsyncDirectory(ackedDir).catch(() => undefined);
    await fsyncDirectory(path.dirname(fromPath)).catch(() => undefined);
    await fs.unlink(path.join(sedimentIntakeStatusDir(abrainHome), `${windowId}.json`)).catch(() => undefined);
    void pruneAckedIntake(abrainHome, 64).catch(() => undefined);
    return { status: "acked", fromPath, toPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", fromPath };
    const raw = await fs.readFile(fromPath);
    await durableAtomicWriteFile(toPath, raw, { mode: 0o600 });
    await fs.unlink(fromPath);
    await fsyncDirectory(ackedDir).catch(() => undefined);
    await fsyncDirectory(path.dirname(fromPath)).catch(() => undefined);
    return { status: "acked", fromPath, toPath };
  }
}

async function pruneAckedIntake(abrainHome: string, keep: number): Promise<void> {
  const dir = sedimentIntakeAckedDir(abrainHome);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return; }
  const rows: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try { rows.push({ name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs }); } catch { /* skip */ }
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const row of rows.slice(0, Math.max(0, rows.length - keep))) {
    await fs.unlink(path.join(dir, row.name)).catch(() => undefined);
  }
}

export function resetSedimentIntakeClaimsForTests(): void {
  // Claims are kernel OFD leases, not process-local mutable state.
}
