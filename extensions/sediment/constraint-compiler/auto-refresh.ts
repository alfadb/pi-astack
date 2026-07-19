import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPiAiConstraintCompilerInvoker, createPiAiMergedSourceVerifierInvoker } from "./pi-ai-invoker";
import { runConstraintShadowCompiler } from "./shadow-runner";
import { commitAbrainDerivedOutputs, type WriterPublicationResult, type WriterPublicationStatus } from "../writer";
import { getDeviceId } from "../../_shared/causal-anchor";
import { fsyncDirectory } from "../../_shared/durable-write";
import { acquireFileLock, abrainSedimentLocksDir } from "../../_shared/runtime";
import type { ConstraintShadowRunResult } from "./types";
import type { SedimentSettings } from "../settings";

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export interface ConstraintShadowAutoRefreshSettings {
  enabled: boolean;
  debounceMs: number;
  minIntervalMs: number;
  eventStaleAfterMs: number;
  maxPromptChars: number;
}

export interface ConstraintShadowAutoRefreshTrigger {
  abrainHome: string;
  cwd: string;
  activeProjectId?: string;
  knownProjectIds?: string[];
  settings: SedimentSettings;
  modelRegistry?: unknown;
  reason: string;
  sourceEventId?: string;
  sourceEventIds?: readonly string[];
  retryAttempt?: number;
}

interface NeedsRefreshMarker {
  schemaVersion: "constraint-shadow-auto-refresh-needs-refresh/v1";
  observedAtUtc: string;
  reason: string;
  sourceEventId: string | null;
  sourceEventIds: readonly string[];
  modelRef: string;
}

interface AutoRefreshGlobalState {
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  pending?: ConstraintShadowAutoRefreshTrigger;
  lastStartedMs?: number;
  scheduleGeneration?: number;
  markerWriteTail?: Promise<void>;
  markerDirectorySyncForTests?: (dir: string) => Promise<void>;
  compilerRunnerForTests?: (trigger: ConstraintShadowAutoRefreshTrigger) => Promise<ConstraintShadowRunResult>;
}

interface RunOnceOptions {
  scheduleOnLockContention?: boolean;
  compilerRunnerForTests?: (trigger: ConstraintShadowAutoRefreshTrigger) => Promise<ConstraintShadowRunResult>;
}

const GLOBAL_KEY = "__piAstConstraintShadowAutoRefresh";
const LIVENESS_GLOBAL_KEY = Symbol.for("pi-astack.constraint-shadow.liveness-recovery");
const LIVENESS_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const NEEDS_REFRESH_MAX_BYTES = 64 * 1024;
const NEEDS_REFRESH_MAX_LINES = 200;
const state: AutoRefreshGlobalState = ((globalThis as unknown as Record<string, AutoRefreshGlobalState>)[GLOBAL_KEY] ??= {});

function triggerEventIds(trigger: ConstraintShadowAutoRefreshTrigger): string[] {
  return Array.from(new Set([
    ...(trigger.sourceEventIds ?? []),
    ...(trigger.sourceEventId ? [trigger.sourceEventId] : []),
  ])).sort();
}

function withEventIds(trigger: ConstraintShadowAutoRefreshTrigger, eventIds: readonly string[]): ConstraintShadowAutoRefreshTrigger {
  const sourceEventIds = Object.freeze(Array.from(new Set(eventIds)).sort());
  return {
    ...trigger,
    sourceEventIds,
    sourceEventId: sourceEventIds.length === 1 ? sourceEventIds[0] : undefined,
  };
}

function mergePendingTrigger(current: ConstraintShadowAutoRefreshTrigger | undefined, next: ConstraintShadowAutoRefreshTrigger): ConstraintShadowAutoRefreshTrigger {
  if (!current) return withEventIds(next, triggerEventIds(next));
  if (path.resolve(current.abrainHome) !== path.resolve(next.abrainHome)) {
    throw new Error("constraint auto-refresh cannot debounce different abrain roots in one process");
  }
  return withEventIds(next, [...triggerEventIds(current), ...triggerEventIds(next)]);
}

function stateRoot(abrainHome: string): string {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh");
}

function needsRefreshPath(abrainHome: string): string {
  return path.join(stateRoot(abrainHome), "needs-refresh.jsonl");
}

async function appendAuditLine(abrainHome: string, row: Record<string, unknown>): Promise<void> {
  const root = stateRoot(abrainHome);
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(path.join(root, "audit.jsonl"), `${JSON.stringify(row)}\n`, "utf-8");
}

async function appendAuditLineNoThrow(abrainHome: string, row: Record<string, unknown>): Promise<void> {
  try {
    await appendAuditLine(abrainHome, row);
  } catch (err) {
    console.error(`[constraint-shadow-auto-refresh] audit append failed: ${errorMessage(err)}`);
  }
}

async function appendNeedsRefreshMarker(
  trigger: ConstraintShadowAutoRefreshTrigger,
  observedAtMs: number,
  modelRef: string,
): Promise<void> {
  const root = stateRoot(trigger.abrainHome);
  const markerPath = needsRefreshPath(trigger.abrainHome);
  const sourceEventIds = triggerEventIds(trigger);
  const marker: NeedsRefreshMarker = {
    schemaVersion: "constraint-shadow-auto-refresh-needs-refresh/v1",
    observedAtUtc: new Date(observedAtMs).toISOString(),
    reason: trigger.reason,
    sourceEventId: sourceEventIds.length === 1 ? sourceEventIds[0]! : null,
    sourceEventIds,
    modelRef,
  };
  await fs.mkdir(root, { recursive: true });

  let raw = "";
  try {
    raw = await fs.readFile(markerPath, "utf-8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  const lineCount = raw.split("\n").filter((line) => line.trim()).length;
  if (!raw || (Buffer.byteLength(raw, "utf-8") <= NEEDS_REFRESH_MAX_BYTES && lineCount <= NEEDS_REFRESH_MAX_LINES)) {
    const handle = await fs.open(markerPath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await (state.markerDirectorySyncForTests ?? fsyncDirectory)(root);
    return;
  }

  const latest = latestNeedsRefreshMarker(raw);
  const compacted = `${latest ? `${JSON.stringify(latest)}\n` : ""}${JSON.stringify(marker)}\n`;
  const tmpPath = path.join(root, `.needs-refresh.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await fs.open(tmpPath, "wx", 0o600);
  try {
    await handle.writeFile(compacted, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, markerPath);
  await (state.markerDirectorySyncForTests ?? fsyncDirectory)(root);
}

function parseNeedsRefreshMarker(value: unknown): NeedsRefreshMarker | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== "constraint-shadow-auto-refresh-needs-refresh/v1") return null;
  if (typeof row.observedAtUtc !== "string" || !Number.isFinite(Date.parse(row.observedAtUtc))) return null;
  if (typeof row.reason !== "string") return null;
  if (row.sourceEventId !== null && row.sourceEventId !== undefined && typeof row.sourceEventId !== "string") return null;
  if (row.sourceEventIds !== undefined && (!Array.isArray(row.sourceEventIds) || !row.sourceEventIds.every((value) => typeof value === "string"))) return null;
  if (typeof row.modelRef !== "string") return null;
  const sourceEventIds = Array.from(new Set([
    ...(Array.isArray(row.sourceEventIds) ? row.sourceEventIds as string[] : []),
    ...(typeof row.sourceEventId === "string" ? [row.sourceEventId] : []),
  ])).sort();
  return {
    schemaVersion: "constraint-shadow-auto-refresh-needs-refresh/v1",
    observedAtUtc: row.observedAtUtc,
    reason: row.reason,
    sourceEventId: sourceEventIds.length === 1 ? sourceEventIds[0]! : null,
    sourceEventIds,
    modelRef: row.modelRef,
  };
}

function latestNeedsRefreshMarker(raw: string): NeedsRefreshMarker | undefined {
  let latest: NeedsRefreshMarker | undefined;
  let latestMs = -Infinity;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const marker = parseNeedsRefreshMarker(parsed);
    if (!marker) continue;
    const observedAtMs = Date.parse(marker.observedAtUtc);
    if (observedAtMs >= latestMs) {
      latest = marker;
      latestMs = observedAtMs;
    }
  }
  return latest;
}

async function readLatestNeedsRefreshMarker(abrainHome: string): Promise<NeedsRefreshMarker | undefined> {
  try {
    return latestNeedsRefreshMarker(await fs.readFile(needsRefreshPath(abrainHome), "utf-8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

function markerObservedAfter(marker: NeedsRefreshMarker, timestampMs: number): boolean {
  return Date.parse(marker.observedAtUtc) > timestampMs;
}

export interface ConstraintPublicationDurability {
  durable: boolean;
  required: "local_durable";
  sourceEventId: string | null;
  sourceEventIds?: readonly string[];
  status?: string;
  publication?: WriterPublicationResult;
  observedAtUtc?: string;
}

function requiredPublicationDurability(): "local_durable" {
  return "local_durable";
}

type AuditPublicationStatus = WriterPublicationStatus | "remote_durable";

interface AuditPublicationEvidence {
  status: AuditPublicationStatus;
  commit: string | null;
  localCommit: WriterPublicationResult["localCommit"];
  drainStatus: string;
  reason?: string;
  canonical: boolean;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWriterPublicationStatus(value: unknown): value is WriterPublicationStatus {
  return value === "local_durable"
    || value === "durable_pending"
    || value === "clean"
    || value === "terminal_before_publish";
}

function isAuditPublicationStatus(value: unknown): value is AuditPublicationStatus {
  return isWriterPublicationStatus(value) || value === "remote_durable";
}

function isWriterPublicationLocalCommit(value: unknown): value is WriterPublicationResult["localCommit"] {
  return value === "not_published" || value === "published" || value === "index_converged";
}

function parseAuditPublication(value: unknown): AuditPublicationEvidence | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const { status, commit, localCommit, drainStatus, reason, canonical } = value;
  if (!isAuditPublicationStatus(status)) return undefined;
  if (commit !== null && typeof commit !== "string") return undefined;
  if (!isWriterPublicationLocalCommit(localCommit)) return undefined;
  if (typeof drainStatus !== "string" || typeof canonical !== "boolean") return undefined;
  if (reason !== undefined && typeof reason !== "string") return undefined;
  return {
    status,
    commit,
    localCommit,
    drainStatus,
    ...(typeof reason === "string" ? { reason } : {}),
    canonical,
  };
}

function currentPublicationFromAudit(publication: AuditPublicationEvidence | undefined): WriterPublicationResult | undefined {
  if (!publication || !isWriterPublicationStatus(publication.status)) return undefined;
  return {
    status: publication.status,
    commit: publication.commit,
    localCommit: publication.localCommit,
    drainStatus: publication.drainStatus,
    ...(publication.reason !== undefined ? { reason: publication.reason } : {}),
    canonical: publication.canonical,
  };
}

function publicationSatisfiesDurability(
  publication: Pick<AuditPublicationEvidence, "status"> | undefined,
  _required: "local_durable",
): boolean {
  if (!publication) return false;
  // Legacy audit compatibility only: old remote_durable rows prove that the
  // local commit was durable. Remote state is not canonical truth.
  return publication.status === "clean" || publication.status === "local_durable" || publication.status === "remote_durable";
}

async function readAutoRefreshAuditRows(abrainHome: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(stateRoot(abrainHome), "audit.jsonl"), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
    } catch { /* malformed audit rows are never durability evidence */ }
  }
  return rows;
}

export async function readConstraintPublicationSetDurability(
  abrainHome: string,
  requestedEventIds: readonly string[],
): Promise<ConstraintPublicationDurability> {
  const required = requiredPublicationDurability();
  const sourceEventIds = Object.freeze(Array.from(new Set(requestedEventIds)).sort());
  const requested = new Set(sourceEventIds);
  const rows = await readAutoRefreshAuditRows(abrainHome);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.status !== "completed" || row.ok !== true) continue;
    const rowIds = new Set([
      ...(Array.isArray(row.sourceEventIds) ? row.sourceEventIds.filter((value): value is string => typeof value === "string") : []),
      ...(typeof row.sourceEventId === "string" ? [row.sourceEventId] : []),
    ]);
    if (requested.size === 0 ? rowIds.size !== 0 : [...requested].some((eventId) => !rowIds.has(eventId))) continue;
    const auditPublication = parseAuditPublication(row.publication);
    const publication = currentPublicationFromAudit(auditPublication);
    return {
      durable: publicationSatisfiesDurability(auditPublication, required),
      required,
      sourceEventId: sourceEventIds.length === 1 ? sourceEventIds[0]! : null,
      sourceEventIds,
      status: String(row.status),
      ...(publication ? { publication } : {}),
      ...(typeof row.observedAtUtc === "string" ? { observedAtUtc: row.observedAtUtc } : {}),
    };
  }
  return { durable: false, required, sourceEventId: sourceEventIds.length === 1 ? sourceEventIds[0]! : null, sourceEventIds };
}

export async function readConstraintPublicationDurability(
  abrainHome: string,
  sourceEventId: string | null,
): Promise<ConstraintPublicationDurability> {
  return readConstraintPublicationSetDurability(abrainHome, sourceEventId ? [sourceEventId] : []);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function scheduleRecoverableRetry(
  trigger: ConstraintShadowAutoRefreshTrigger,
  modelRef: string,
  previousStatus: string,
): Promise<void> {
  if ((trigger.retryAttempt ?? 0) >= 1) return;
  const retryAttempt = (trigger.retryAttempt ?? 0) + 1;
  await appendAuditLineNoThrow(trigger.abrainHome, {
    schemaVersion: "constraint-shadow-auto-refresh/v1",
    observedAtUtc: new Date().toISOString(),
    ok: true,
    reason: trigger.reason,
    sourceEventId: trigger.sourceEventId ?? null,
    modelRef,
    status: "retry_scheduled",
    retryAttempt,
    previousStatus,
  });
  await scheduleConstraintShadowAutoRefresh({ ...trigger, retryAttempt, reason: "previous_run_failed" });
}

async function hasReadableConstraintEvidenceEnvelope(
  root: string,
  isQueued: (envelope: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const walk = async (dir: string): Promise<boolean> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full)) return true;
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const envelope = JSON.parse(await fs.readFile(full, "utf-8")) as Record<string, unknown>;
          if (envelope.schema === "constraint-evidence-envelope/v1" && isQueued(envelope)) return true;
        } catch {
          // Conservative liveness recovery is only for readable evidence rows.
        }
      }
    }
    return false;
  };
  return walk(root);
}

function coverageRowSettled(row: Record<string, unknown>): boolean {
  if (row.status === "projected") return true;
  return (row.status === "queued" || row.status === "stale")
    && (row.disposition === "merged_source" || row.disposition === "unresolved");
}

async function readQueuedConstraintEventCount(abrainHome: string): Promise<{ queuedEvents: number; fallbackReason?: string }> {
  const evidenceRoot = path.join(abrainHome, "l1", "events", "sha256");
  const coveragePath = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest", "event-coverage.json");
  let coverage: unknown;
  let fallbackReason: string | undefined;
  try {
    coverage = JSON.parse(await fs.readFile(coveragePath, "utf-8"));
  } catch (err: any) {
    fallbackReason = err?.code === "ENOENT" ? "event_coverage_missing" : "event_coverage_unreadable";
  }

  if (fallbackReason) {
    const hasAnyReadableEnvelope = await hasReadableConstraintEvidenceEnvelope(evidenceRoot, () => true);
    return { queuedEvents: hasAnyReadableEnvelope ? 1 : 0, fallbackReason };
  }

  const rows = Array.isArray((coverage as { rows?: unknown }).rows) ? (coverage as { rows: unknown[] }).rows : undefined;
  if (!rows) {
    const hasAnyReadableEnvelope = await hasReadableConstraintEvidenceEnvelope(evidenceRoot, () => true);
    return { queuedEvents: hasAnyReadableEnvelope ? 1 : 0, fallbackReason: "event_coverage_rows_missing" };
  }

  const settledEventIds = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.eventId === "string" && coverageRowSettled(record)) settledEventIds.add(record.eventId);
  }

  const hasQueued = await hasReadableConstraintEvidenceEnvelope(evidenceRoot, (envelope) => {
    const eventId = typeof envelope.event_id === "string" ? envelope.event_id : undefined;
    return !!eventId && !settledEventIds.has(eventId);
  });
  return { queuedEvents: hasQueued ? 1 : 0 };
}

async function latestCompiledViewObservedMs(abrainHome: string): Promise<number | undefined> {
  const latest = path.join(abrainHome, ".state", "sediment", "constraint-shadow", "latest");
  const candidates = [path.join(latest, "compiled-view.md"), path.join(latest, "decision.json")];
  let newest = -Infinity;
  for (const file of candidates) {
    try {
      const stat = await fs.stat(file);
      newest = Math.max(newest, stat.mtimeMs);
    } catch (err: any) {
      if (err?.code !== "ENOENT") return undefined;
    }
  }
  return Number.isFinite(newest) ? newest : undefined;
}

function isModelRegistry(value: unknown): value is ModelRegistryLike {
  return !!value
    && typeof value === "object"
    && typeof (value as ModelRegistryLike).find === "function"
    && typeof (value as ModelRegistryLike).getApiKeyAndHeaders === "function";
}

function defaultModelRef(settings: SedimentSettings): string {
  return settings.constraintShadowCompiler.model || settings.curatorModel || "";
}

function compactResult(result: ConstraintShadowRunResult): Record<string, unknown> {
  return {
    ok: result.ok,
    inputRootHash: result.inputRootHash,
    sourceCount: result.sourceCount,
    diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
    ...(result.ok ? {
      shadowOutputHash: result.view.shadowOutputHash,
      eventCoverage: result.eventCoverage?.summary,
      legacyParallelDelta: result.legacyParallelDelta?.summary,
      latestDir: result.artifacts?.latestDir,
      runDir: result.artifacts?.runDir,
    } : {
      latestDir: result.artifacts?.latestDir,
      runDir: result.artifacts?.runDir,
    }),
  };
}

async function projectionInputEventIds(
  abrainHome: string,
  projection: { eventId?: string } | undefined,
  fallback: readonly string[],
): Promise<string[]> {
  const ids = new Set(fallback);
  const eventId = projection?.eventId;
  if (!eventId || !/^[0-9a-f]{64}$/.test(eventId)) return [...ids].sort();
  const file = path.join(abrainHome, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
  try {
    const envelope = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, any>;
    for (const value of [...(envelope.body?.input_event_ids ?? []), ...(envelope.body?.causal_parents ?? [])]) {
      if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) ids.add(value);
    }
  } catch {
    // The projection receipt validation remains fail-closed later; this helper
    // only expands the explicit publication cohort.
  }
  return [...ids].sort();
}

async function runOnce(trigger: ConstraintShadowAutoRefreshTrigger, options: RunOnceOptions = {}): Promise<void> {
  trigger = withEventIds(trigger, triggerEventIds(trigger));
  const auto = trigger.settings.constraintShadowCompiler.autoRefresh;
  const modelRef = defaultModelRef(trigger.settings);
  const startedAtMs = Date.now();
  let compileStartedAtMs = startedAtMs;
  let terminalStatus: "completed" | "failed" | "threw" | undefined;

  if (!modelRef) {
    await appendAuditLineNoThrow(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date(startedAtMs).toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: "model_not_configured",
    });
    await scheduleRecoverableRetry(trigger, modelRef, "model_not_configured");
    return;
  }

  if (!isModelRegistry(trigger.modelRegistry)) {
    await appendAuditLineNoThrow(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date(startedAtMs).toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: "model_registry_unavailable",
    });
    await scheduleRecoverableRetry(trigger, modelRef, "model_registry_unavailable");
    return;
  }

  // Cross-process mutual exclusion: only one pi instance compiles at a time.
  // The lock covers the actual compile/commit section, not the debounce wait.
  const lockPath = path.join(abrainSedimentLocksDir(trigger.abrainHome), "constraint-shadow-auto-refresh.lock");
  let lockHandle: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
  try {
    lockHandle = await acquireFileLock(lockPath, {
      timeoutMs: 5_000,
      staleMs: 30 * 60 * 1_000, // 30 min — long enough to survive a hung compile
      retryMs: 100,
      label: "constraint-shadow-auto-refresh",
    });
  } catch {
    await appendAuditLineNoThrow(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date().toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: "lock_contended",
    });
    try {
      await appendNeedsRefreshMarker(trigger, Date.now(), modelRef);
    } catch (err) {
      await appendAuditLineNoThrow(trigger.abrainHome, {
        schemaVersion: "constraint-shadow-auto-refresh/v1",
        observedAtUtc: new Date().toISOString(),
        ok: false,
        reason: trigger.reason,
        sourceEventId: trigger.sourceEventId ?? null,
        modelRef,
        status: "needs_refresh_marker_write_failed",
        error: errorMessage(err),
      });
    }
    if (options.scheduleOnLockContention) {
      await scheduleConstraintShadowAutoRefresh(trigger);
    }
    return;
  }

  compileStartedAtMs = Date.now();
  state.lastStartedMs = compileStartedAtMs;

  await appendAuditLineNoThrow(trigger.abrainHome, {
    schemaVersion: "constraint-shadow-auto-refresh/v1",
    observedAtUtc: new Date(compileStartedAtMs).toISOString(),
    ok: true,
    reason: trigger.reason,
    sourceEventId: trigger.sourceEventId ?? null,
    modelRef,
    status: "started",
  });

  // pi-astack: live footer indicator while the (minutes-long, async) compile
  // runs, so the user sees a background compile in progress and does not close
  // pi mid-flight. Driven via the globalThis setStatus stashed by the sediment
  // extension (the auto-refresh has no ctx.ui of its own). No-op when unavailable.
  const compileStatus = (globalThis as { __abrain_constraintCompileSetStatus?: (msg?: string) => void })
    .__abrain_constraintCompileSetStatus;
  const shortModel = modelRef.split("/").pop() ?? modelRef;
  compileStatus?.(`约束编译中… (${shortModel})`);
  const statusTicker = setInterval(() => {
    const mins = Math.floor((Date.now() - compileStartedAtMs) / 60000);
    compileStatus?.(`约束编译中 ${mins}m… (${shortModel})`);
  }, 30000);
  (statusTicker as unknown as { unref?: () => void }).unref?.();

  try {
    const verifierSettings = trigger.settings.constraintShadowCompiler.mergedSourceVerifier;
    const verifierModelRef = verifierSettings.model || modelRef;
    const verifierMaxPromptChars = verifierSettings.maxPromptChars
      || auto.maxPromptChars
      || trigger.settings.constraintShadowCompiler.maxPromptChars
      || undefined;
    const result = options.compilerRunnerForTests ? await options.compilerRunnerForTests(trigger) : await runConstraintShadowCompiler({
      abrainHome: trigger.abrainHome,
      cwd: trigger.cwd,
      activeProjectId: trigger.activeProjectId,
      knownProjectIds: trigger.knownProjectIds,
      includeProjects: trigger.activeProjectId ? [trigger.activeProjectId] : "active",
      includeStatuses: "all",
      maxPromptChars: auto.maxPromptChars || trigger.settings.constraintShadowCompiler.maxPromptChars || undefined,
      eventStaleAfterMs: auto.eventStaleAfterMs,
      modelRef,
      maxCompileRetries: trigger.settings.constraintShadowCompiler.maxCompileRetries,
      escalationModelRef: trigger.settings.constraintShadowCompiler.escalationModelRef || undefined,
      compilerInvoker: createPiAiConstraintCompilerInvoker({
        modelRegistry: trigger.modelRegistry,
        defaultModelRef: modelRef,
        timeoutMs: trigger.settings.constraintShadowCompiler.timeoutMs,
        maxRetries: trigger.settings.constraintShadowCompiler.maxRetries,
      }),
      ...(verifierSettings.enabled ? {
        generateMergedSourceVerifier: true,
        verifierInvoker: createPiAiMergedSourceVerifierInvoker({
          modelRegistry: trigger.modelRegistry,
          defaultModelRef: verifierModelRef,
          timeoutMs: trigger.settings.constraintShadowCompiler.timeoutMs,
          maxRetries: trigger.settings.constraintShadowCompiler.maxRetries,
        }),
        verifierModelRef,
        verifierMaxPromptChars,
      } : {}),
      writeArtifacts: true,
      l2OutputRoot: trigger.settings.constraintShadowCompiler.l2OutputRoot,
      deviceId: getDeviceId() ?? "unknown-device",
    });
    terminalStatus = result.ok ? undefined : "failed";
    await appendAuditLineNoThrow(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date().toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: result.ok ? "compiled_publication_pending" : "failed",
      durationMs: Date.now() - compileStartedAtMs,
      result: compactResult(result),
    });
    if (!result.ok) return;
    if (trigger.settings.constraintShadowCompiler.l2OutputRoot === "repo" && !result.l2Projection) {
      await appendAuditLineNoThrow(trigger.abrainHome, {
        schemaVersion: "constraint-shadow-auto-refresh/v1",
        observedAtUtc: new Date().toISOString(),
        ok: false,
        reason: trigger.reason,
        sourceEventId: trigger.sourceEventId ?? null,
        modelRef,
        status: "publication_terminal",
        terminalReason: "required_l2_output_missing",
        result: compactResult(result),
      });
      return;
    }
    // The successful compile above is the first canonical worktree mutation
    // in this lane; earlier writes are ignored .state locks/markers/audit only.
    // Thread its exact trigger evidence, projection envelope, and L2 view into
    // the immediately following commitAbrainDerivedOutputs startup/drain
    // barrier. Enabled mode never infers this cohort from status or a sweep.
    const producedFilePaths: string[] = [];
    const sourceEventIds = await projectionInputEventIds(trigger.abrainHome, result.l2Projection, triggerEventIds(trigger));
    if (sourceEventIds.some((eventId) => !/^[0-9a-f]{64}$/.test(eventId))) {
      throw new Error("constraint trigger sourceEventIds contain a non-SHA-256 event id");
    }
    for (const eventId of sourceEventIds) {
      producedFilePaths.push(path.join(
        trigger.abrainHome,
        "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`,
      ));
    }
    if (result.l2Projection) {
      if (result.l2Projection.status !== "written" && result.l2Projection.status !== "unchanged") {
        throw new Error(`constraint L2 projection is not publishable: ${result.l2Projection.status}`);
      }
      const eventId = result.l2Projection.eventId;
      if (!eventId || !/^[0-9a-f]{64}$/.test(eventId)) throw new Error("constraint projection event id is missing or invalid");
      producedFilePaths.push(path.join(
        trigger.abrainHome,
        "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`,
      ));
      producedFilePaths.push(path.join(trigger.abrainHome, result.l2Projection.l2RelativePath));
    }
    const publication = await commitAbrainDerivedOutputs(trigger.abrainHome, "constraint-shadow-auto-refresh", Array.from(new Set(producedFilePaths)))
      ?? { status: "clean", commit: null, localCommit: "not_published", drainStatus: "legacy_test_adapter", canonical: false };
    const requiredDurability = requiredPublicationDurability();
    if (!publicationSatisfiesDurability(publication, requiredDurability)) {
      terminalStatus = "failed";
      await appendAuditLineNoThrow(trigger.abrainHome, {
        schemaVersion: "constraint-shadow-auto-refresh/v1",
        observedAtUtc: new Date().toISOString(),
        ok: false,
        reason: trigger.reason,
        sourceEventId: sourceEventIds.length === 1 ? sourceEventIds[0]! : null,
        sourceEventIds,
        modelRef,
        status: publication.status === "terminal_before_publish" ? "publication_terminal" : "publication_pending",
        requiredDurability,
        publication,
      });
    } else {
      terminalStatus = "completed";
      await appendAuditLineNoThrow(trigger.abrainHome, {
        schemaVersion: "constraint-shadow-auto-refresh/v1",
        observedAtUtc: new Date().toISOString(),
        ok: true,
        reason: trigger.reason,
        sourceEventId: sourceEventIds.length === 1 ? sourceEventIds[0]! : null,
        sourceEventIds,
        modelRef,
        status: "completed",
        requiredDurability,
        durationMs: Date.now() - compileStartedAtMs,
        publication,
        result: compactResult(result),
      });
    }
  } catch (err) {
    terminalStatus = "threw";
    await appendAuditLineNoThrow(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date().toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: "threw",
      durationMs: Date.now() - compileStartedAtMs,
      error: errorMessage(err),
    });
  } finally {
    clearInterval(statusTicker);
    compileStatus?.(undefined);
    // Release the cross-process lock before scheduling any follow-up compile.
    if (lockHandle) await lockHandle.release().catch(() => undefined);
    let needsRefresh: NeedsRefreshMarker | undefined;
    try {
      needsRefresh = await readLatestNeedsRefreshMarker(trigger.abrainHome);
    } catch (err) {
      await appendAuditLineNoThrow(trigger.abrainHome, {
        schemaVersion: "constraint-shadow-auto-refresh/v1",
        observedAtUtc: new Date().toISOString(),
        ok: false,
        reason: trigger.reason,
        sourceEventId: trigger.sourceEventId ?? null,
        modelRef,
        status: "needs_refresh_marker_read_failed",
        error: errorMessage(err),
      });
    }
    if (needsRefresh && markerObservedAfter(needsRefresh, compileStartedAtMs)) {
      await scheduleConstraintShadowAutoRefresh({
        ...trigger,
        reason: needsRefresh.reason,
        sourceEventId: needsRefresh.sourceEventId ?? undefined,
        sourceEventIds: needsRefresh.sourceEventIds,
      });
    } else if (terminalStatus === "failed" || terminalStatus === "threw") {
      await scheduleRecoverableRetry(trigger, modelRef, terminalStatus);
    }
  }
}

function armScheduledRun(trigger: ConstraintShadowAutoRefreshTrigger, delayMs: number): void {
  state.timer = setTimeout(() => {
    state.timer = undefined;
    const next = state.pending;
    state.pending = undefined;
    if (!next) return;
    if (state.inFlight) {
      state.pending = mergePendingTrigger(state.pending, next);
      void state.inFlight.finally(() => {
        const pending = state.pending;
        if (pending) void scheduleConstraintShadowAutoRefresh(pending).catch(() => undefined);
      });
      return;
    }
    state.inFlight = runOnce(next, { scheduleOnLockContention: true, compilerRunnerForTests: state.compilerRunnerForTests }).finally(() => {
      state.inFlight = undefined;
      const pending = state.pending;
      if (pending) void scheduleConstraintShadowAutoRefresh(pending).catch(() => undefined);
    });
    state.inFlight.catch(() => undefined);
  }, delayMs);
}

export async function scheduleConstraintShadowAutoRefresh(trigger: ConstraintShadowAutoRefreshTrigger): Promise<{ scheduled: boolean; reason: string }> {
  const auto = trigger.settings.constraintShadowCompiler.autoRefresh;
  if (!trigger.settings.constraintShadowCompiler.enabled) return { scheduled: false, reason: "constraint_shadow_compiler_disabled" };
  if (!auto.enabled) return { scheduled: false, reason: "auto_refresh_disabled" };

  state.pending = mergePendingTrigger(state.pending, trigger);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  const generation = (state.scheduleGeneration ?? 0) + 1;
  state.scheduleGeneration = generation;
  const pending = state.pending;
  const now = Date.now();
  const modelRef = defaultModelRef(pending.settings);
  const markerWrite = (state.markerWriteTail ?? Promise.resolve())
    .then(() => appendNeedsRefreshMarker(pending, now, modelRef));
  state.markerWriteTail = markerWrite.catch(() => undefined);
  try {
    await markerWrite;
  } catch (err) {
    await appendAuditLineNoThrow(pending.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date().toISOString(),
      ok: false,
      reason: pending.reason,
      sourceEventId: pending.sourceEventId ?? null,
      sourceEventIds: triggerEventIds(pending),
      modelRef,
      status: "needs_refresh_marker_write_failed",
      error: errorMessage(err),
    });
    return { scheduled: false, reason: "needs_refresh_marker_write_failed" };
  }

  // A later debounce call owns arming; its durable marker contains this full set.
  if (generation !== state.scheduleGeneration) return { scheduled: true, reason: "superseded_by_newer_debounce" };
  const cooldownMs = Math.max(0, auto.minIntervalMs - (now - (state.lastStartedMs ?? 0)));
  const delayMs = Math.max(0, auto.debounceMs, cooldownMs);
  armScheduledRun(pending, delayMs);
  return { scheduled: true, reason: delayMs > 0 ? "scheduled_debounced" : "scheduled_now" };
}

export async function resumeConstraintShadowAutoRefreshAtStartup(
  trigger: ConstraintShadowAutoRefreshTrigger,
): Promise<{ scheduled: boolean; reason: string; sourceEventId?: string; sourceEventIds?: readonly string[] }> {
  const marker = await readLatestNeedsRefreshMarker(trigger.abrainHome);
  if (!marker) return { scheduled: false, reason: "needs_refresh_marker_missing" };
  const durability = await readConstraintPublicationSetDurability(trigger.abrainHome, marker.sourceEventIds);
  if (durability.durable) return { scheduled: false, reason: "marker_already_durable", ...(marker.sourceEventId ? { sourceEventId: marker.sourceEventId } : {}), sourceEventIds: marker.sourceEventIds };
  const scheduled = await scheduleConstraintShadowAutoRefresh({
    ...trigger,
    reason: marker.reason,
    sourceEventId: marker.sourceEventId ?? undefined,
    sourceEventIds: marker.sourceEventIds,
  });
  await appendAuditLineNoThrow(trigger.abrainHome, {
    schemaVersion: "constraint-shadow-auto-refresh/v1",
    observedAtUtc: new Date().toISOString(),
    ok: scheduled.scheduled,
    reason: marker.reason,
    sourceEventId: marker.sourceEventId,
    sourceEventIds: marker.sourceEventIds,
    modelRef: marker.modelRef,
    status: scheduled.scheduled ? "startup_retry_scheduled" : "startup_retry_skipped",
    scheduleReason: scheduled.reason,
    requiredDurability: durability.required,
  });
  return { ...scheduled, ...(marker.sourceEventId ? { sourceEventId: marker.sourceEventId } : {}), sourceEventIds: marker.sourceEventIds };
}

export async function ensureConstraintShadowLiveness(trigger: ConstraintShadowAutoRefreshTrigger): Promise<{ scheduled: boolean; reason: string; queuedEvents?: number; staleAgeMs?: number; queuedFallbackReason?: string }> {
  if (!trigger.settings.constraintShadowCompiler.enabled) return { scheduled: false, reason: "constraint_shadow_compiler_disabled" };
  if (!trigger.settings.constraintShadowCompiler.autoRefresh.enabled) return { scheduled: false, reason: "auto_refresh_disabled" };

  const observedMs = await latestCompiledViewObservedMs(trigger.abrainHome);
  const staleAgeMs = observedMs === undefined ? undefined : Date.now() - observedMs;
  if (staleAgeMs !== undefined && staleAgeMs < LIVENESS_STALE_AFTER_MS) return { scheduled: false, reason: "compiled_view_fresh", staleAgeMs };

  const queued = await readQueuedConstraintEventCount(trigger.abrainHome);
  const { queuedEvents, fallbackReason: queuedFallbackReason } = queued;
  if (queuedEvents <= 0) return { scheduled: false, reason: "no_queued_events", queuedEvents, staleAgeMs, queuedFallbackReason };

  const modelRef = defaultModelRef(trigger.settings);
  const guardReason = !modelRef
    ? "model_not_configured"
    : !isModelRegistry(trigger.modelRegistry)
      ? "model_registry_unavailable"
      : undefined;
  if (guardReason) {
    await appendAuditLineNoThrow(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date().toISOString(),
      ok: false,
      reason: "liveness_recovery",
      sourceEventId: null,
      modelRef,
      status: "liveness_recovery_skipped",
      scheduleReason: guardReason,
      queuedEvents,
      staleAgeMs,
      ...(queuedFallbackReason ? { queuedFallbackReason } : {}),
    });
    return { scheduled: false, reason: guardReason, queuedEvents, staleAgeMs, queuedFallbackReason };
  }

  const g = globalThis as typeof globalThis & { [LIVENESS_GLOBAL_KEY]?: boolean };
  if (g[LIVENESS_GLOBAL_KEY]) return { scheduled: false, reason: "liveness_recovery_already_attempted", queuedEvents, staleAgeMs, queuedFallbackReason };

  const scheduled = await scheduleConstraintShadowAutoRefresh({ ...trigger, reason: "liveness_recovery", sourceEventId: undefined });
  if (scheduled.scheduled) g[LIVENESS_GLOBAL_KEY] = true;
  await appendAuditLineNoThrow(trigger.abrainHome, {
    schemaVersion: "constraint-shadow-auto-refresh/v1",
    observedAtUtc: new Date().toISOString(),
    ok: scheduled.scheduled,
    reason: "liveness_recovery",
    sourceEventId: null,
    modelRef,
    status: scheduled.scheduled ? "liveness_recovery_scheduled" : "liveness_recovery_skipped",
    scheduleReason: scheduled.reason,
    queuedEvents,
    staleAgeMs,
    ...(queuedFallbackReason ? { queuedFallbackReason } : {}),
  });
  return { ...scheduled, queuedEvents, staleAgeMs, queuedFallbackReason };
}

export async function _scheduleConstraintShadowAutoRefreshWithCompilerForTests(
  trigger: ConstraintShadowAutoRefreshTrigger,
  compilerRunnerForTests: (trigger: ConstraintShadowAutoRefreshTrigger) => Promise<ConstraintShadowRunResult>,
): Promise<{ scheduled: boolean; reason: string }> {
  state.compilerRunnerForTests = compilerRunnerForTests;
  return scheduleConstraintShadowAutoRefresh(trigger);
}

export async function _runConstraintShadowAutoRefreshNowForTests(trigger: ConstraintShadowAutoRefreshTrigger): Promise<void> {
  await runOnce(trigger);
}

export async function _runConstraintShadowAutoRefreshWithCompilerForTests(
  trigger: ConstraintShadowAutoRefreshTrigger,
  compilerRunnerForTests: (trigger: ConstraintShadowAutoRefreshTrigger) => Promise<ConstraintShadowRunResult>,
): Promise<void> {
  await runOnce(trigger, { compilerRunnerForTests });
}

export function _setConstraintShadowMarkerDirectorySyncForTests(sync?: (dir: string) => Promise<void>): void {
  state.markerDirectorySyncForTests = sync;
}

export function _resetConstraintShadowAutoRefreshForTests(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.inFlight = undefined;
  state.pending = undefined;
  state.lastStartedMs = undefined;
  state.scheduleGeneration = undefined;
  state.markerWriteTail = undefined;
  state.markerDirectorySyncForTests = undefined;
  state.compilerRunnerForTests = undefined;
  delete (globalThis as typeof globalThis & { [LIVENESS_GLOBAL_KEY]?: boolean })[LIVENESS_GLOBAL_KEY];
}
