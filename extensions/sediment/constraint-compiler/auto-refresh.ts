import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPiAiConstraintCompilerInvoker } from "./pi-ai-invoker";
import { runConstraintShadowCompiler } from "./shadow-runner";
import { getDeviceId } from "../../_shared/causal-anchor";
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
  state.lastStartedMs = startedAtMs;

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

  await appendAuditLine(trigger.abrainHome, {
    schemaVersion: "constraint-shadow-auto-refresh/v1",
    observedAtUtc: new Date(startedAtMs).toISOString(),
    ok: true,
    reason: trigger.reason,
    sourceEventId: trigger.sourceEventId ?? null,
    modelRef,
    status: "started",
  }).catch(() => undefined);

  try {
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
      compilerInvoker: createPiAiConstraintCompilerInvoker({
        modelRegistry: trigger.modelRegistry,
        defaultModelRef: modelRef,
        timeoutMs: trigger.settings.constraintShadowCompiler.timeoutMs,
        maxRetries: trigger.settings.constraintShadowCompiler.maxRetries,
      }),
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
