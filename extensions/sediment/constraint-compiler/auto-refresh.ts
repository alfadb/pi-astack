import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPiAiConstraintCompilerInvoker, createPiAiMergedSourceVerifierInvoker } from "./pi-ai-invoker";
import { runConstraintShadowCompiler } from "./shadow-runner";
import { commitAbrainDerivedOutputs } from "../writer";
import { getDeviceId } from "../../_shared/causal-anchor";
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
}

interface AutoRefreshGlobalState {
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  pending?: ConstraintShadowAutoRefreshTrigger;
  lastStartedMs?: number;
}

const GLOBAL_KEY = "__piAstConstraintShadowAutoRefresh";
const state: AutoRefreshGlobalState = ((globalThis as unknown as Record<string, AutoRefreshGlobalState>)[GLOBAL_KEY] ??= {});

function stateRoot(abrainHome: string): string {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow", "auto-refresh");
}

async function appendAuditLine(abrainHome: string, row: Record<string, unknown>): Promise<void> {
  const root = stateRoot(abrainHome);
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(path.join(root, "audit.jsonl"), `${JSON.stringify(row)}\n`, "utf-8");
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

async function runOnce(trigger: ConstraintShadowAutoRefreshTrigger): Promise<void> {
  const auto = trigger.settings.constraintShadowCompiler.autoRefresh;
  const modelRef = defaultModelRef(trigger.settings);
  const startedAtMs = Date.now();

  if (!modelRef) {
    await appendAuditLine(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date(startedAtMs).toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      status: "model_not_configured",
    }).catch(() => undefined);
    return;
  }

  if (!isModelRegistry(trigger.modelRegistry)) {
    await appendAuditLine(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date(startedAtMs).toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: "model_registry_unavailable",
    }).catch(() => undefined);
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
    await appendAuditLine(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date(startedAtMs).toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: "lock_contended",
    }).catch(() => undefined);
    return;
  }

  state.lastStartedMs = startedAtMs;

  await appendAuditLine(trigger.abrainHome, {
    schemaVersion: "constraint-shadow-auto-refresh/v1",
    observedAtUtc: new Date(startedAtMs).toISOString(),
    ok: true,
    reason: trigger.reason,
    sourceEventId: trigger.sourceEventId ?? null,
    modelRef,
    status: "started",
  }).catch(() => undefined);

  // pi-astack: live footer indicator while the (minutes-long, async) compile
  // runs, so the user sees a background compile in progress and does not close
  // pi mid-flight. Driven via the globalThis setStatus stashed by the sediment
  // extension (the auto-refresh has no ctx.ui of its own). No-op when unavailable.
  const compileStatus = (globalThis as { __abrain_constraintCompileSetStatus?: (msg?: string) => void })
    .__abrain_constraintCompileSetStatus;
  const shortModel = modelRef.split("/").pop() ?? modelRef;
  compileStatus?.(`约束编译中… (${shortModel})`);
  const statusTicker = setInterval(() => {
    const mins = Math.floor((Date.now() - startedAtMs) / 60000);
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
    const result = await runConstraintShadowCompiler({
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
    await appendAuditLine(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date().toISOString(),
      ok: result.ok,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: result.ok ? "completed" : "failed",
      durationMs: Date.now() - startedAtMs,
      result: compactResult(result),
    }).catch(() => undefined);
    // ADR0039 Part A: commit this background compile's derived l1/l2 (固化 L1
    // projection event + L2 view + the triggering constraint-evidence event),
    // which no agent_end create will sweep because the compile completes minutes
    // later. no-throw + conditional, so it never disrupts the background flow.
    await commitAbrainDerivedOutputs(trigger.abrainHome, "constraint-shadow-auto-refresh");
  } catch (err) {
    await appendAuditLine(trigger.abrainHome, {
      schemaVersion: "constraint-shadow-auto-refresh/v1",
      observedAtUtc: new Date().toISOString(),
      ok: false,
      reason: trigger.reason,
      sourceEventId: trigger.sourceEventId ?? null,
      modelRef,
      status: "threw",
      durationMs: Date.now() - startedAtMs,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
  } finally {
    clearInterval(statusTicker);
    compileStatus?.(undefined);
    // Release the cross-process lock.
    if (lockHandle) await lockHandle.release().catch(() => undefined);
  }
}

export function scheduleConstraintShadowAutoRefresh(trigger: ConstraintShadowAutoRefreshTrigger): { scheduled: boolean; reason: string } {
  const auto = trigger.settings.constraintShadowCompiler.autoRefresh;
  if (!trigger.settings.constraintShadowCompiler.enabled) return { scheduled: false, reason: "constraint_shadow_compiler_disabled" };
  if (!auto.enabled) return { scheduled: false, reason: "auto_refresh_disabled" };

  state.pending = trigger;
  if (state.timer) clearTimeout(state.timer);

  const now = Date.now();
  const cooldownMs = Math.max(0, auto.minIntervalMs - (now - (state.lastStartedMs ?? 0)));
  const delayMs = Math.max(0, auto.debounceMs, cooldownMs);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    const next = state.pending;
    state.pending = undefined;
    if (!next) return;
    if (state.inFlight) {
      state.pending = next;
      state.inFlight.finally(() => scheduleConstraintShadowAutoRefresh(next));
      return;
    }
    state.inFlight = runOnce(next).finally(() => {
      state.inFlight = undefined;
      if (state.pending) scheduleConstraintShadowAutoRefresh(state.pending);
    });
    state.inFlight.catch(() => undefined);
  }, delayMs);

  return { scheduled: true, reason: delayMs > 0 ? "scheduled_debounced" : "scheduled_now" };
}

export async function _runConstraintShadowAutoRefreshNowForTests(trigger: ConstraintShadowAutoRefreshTrigger): Promise<void> {
  await runOnce(trigger);
}

export function _resetConstraintShadowAutoRefreshForTests(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.inFlight = undefined;
  state.pending = undefined;
  state.lastStartedMs = undefined;
}
