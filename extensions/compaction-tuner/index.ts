/**
 * compaction-tuner extension for pi-astack.
 *
 * Triggers compaction when context usage crosses a configurable effective
 * threshold. Solves the problem that pi's built-in `reserveTokens` is an
 * absolute number while user-stack models span 200k → 1M+ contextWindows,
 * and some routes (notably GPT-5.5) have lower economic/safe budgets than
 * their nominal API contextWindow.
 *
 * Configuration lives in `~/.pi/agent/pi-astack-settings.json`:
 *
 *   "compactionTuner": {
 *     "enabled": true,
 *     "thresholdPercent": 75,
 *     "dynamicThreshold": { "enabled": true },
 *     "rearmMarginPercent": 5,
 *     "notifyOnTrigger": true,
 *     "customInstructions": "",
 *     "summaryModels": []
 *   }
 *
 * Runtime data:
 *   - audit: <projectRoot>/.pi-astack/compaction-tuner/audit.jsonl
 *
 * Default `enabled: false` — extension is a no-op until user opts in.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compact as runPiCompaction } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
// ADR 0022 INV-K: cross-extension defer checks. Both imported from their
// own leaf modules so smoke can exercise each in isolation. See
// ./prompt-user-defer.ts and ./vault-defer.ts for the why.
import { isPendingPromptUserBlocking } from "./prompt-user-defer";
import { isPendingVaultDialogBlocking } from "./vault-defer";
import {
  compactionTunerAuditPath,
  compactionTunerDir,
  ensureProjectGitignoredOnce,
  formatLocalIsoTimestamp,
} from "../_shared/runtime";
import {
  installTurnBoundaryCompactionPatch,
  isSubAgentSession,
  type TurnBoundaryCompactionDecision,
  type TurnBoundaryCompactionUsage,
} from "../_shared/pi-internals";
// ADR 0027 C6b: cross-layer causal anchor for audit rows.
import { getCurrentAnchor, runWithTriggerAnchor, spreadAnchor } from "../_shared/causal-anchor";
import {
  DEFAULT_COMPACTION_TUNER_SETTINGS,
  resolveCompactionTunerSettings,
  snapshotCompactionTunerSettings,
  type CompactionTunerSettings,
  type DynamicThresholdSettings,
  type ModelCompactionPolicySettings,
} from "./settings";

const AUDIT_VERSION = 1;

interface CompactionTunerCtx {
  cwd?: string;
  hasUI?: boolean;
  ui?: { notify?(message: string, type?: string): void };
  model?: { id?: string; provider?: string; contextWindow?: number };
  sessionManager?: {
    getSessionId?(): string | undefined | null;
    getSessionFile?(): string | undefined | null;
  };
  getContextUsage?(): TurnBoundaryCompactionUsage | undefined;
  compact?(options?: {
    customInstructions?: string;
    onComplete?(result?: unknown): void;
    onError?(error: Error): void;
  }): void;
  modelRegistry?: {
    find?(provider: string, modelId: string): unknown;
    getApiKeyAndHeaders?(model: unknown): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
  };
}

interface CompactionTunerSessionLike {
  agent?: {
    state?: {
      messages?: unknown[];
      model?: { id?: string; provider?: string; contextWindow?: number };
    };
  };
  sessionManager?: CompactionTunerCtx["sessionManager"];
  getContextUsage?(): TurnBoundaryCompactionUsage | undefined;
  model?: { id?: string; provider?: string; contextWindow?: number };
  _cwd?: string;
}

interface ModelRef {
  provider: string;
  id: string;
}

interface CustomSummaryAttempt {
  model: string;
  provider?: string;
  id?: string;
  outcome: "completed" | "invalid_ref" | "not_found" | "auth_unavailable" | "missing_api_key" | "context_window_too_small" | "empty_summary" | "error";
  elapsed_ms?: number;
  error_message?: string;
  context_window?: number | null;
  prompt_tokens_estimate?: number;
}

/**
 * Per-process armed state (keyed by session id, so multiple sessions in
 * one pi process — dispatched subagents, etc. — don't leak hysteresis
 * state across each other). Each session is "armed" until it triggers,
 * then becomes "disarmed" until usage drops by `rearmMarginPercent`
 * below threshold.
 */
const armedBySession = new Map<string, boolean>();

/**
 * Per-session error backoff state.
 *
 * Background — 2026-05-18 retry storm (audit at
 * `<projectRoot>/.pi-astack/compaction-tuner/audit.jsonl`,
 * session 019e3968...): 71 seconds, 7 triggers, all identical
 * (percent=130.93%, tokens=356132/272000, outcome=error,
 * provider 500 on summarization). Root cause: the old onError
 * unconditionally `armedBySession.set(stateKey, true)`, which
 * re-armed instantly. Because percent didn't drop after a failed
 * compact (messages unchanged), every subsequent agent_end
 * re-evaluated, re-triggered, re-failed, re-armed — an unbounded
 * loop until the user quit or the provider stopped 500ing.
 *
 * Fix: onError no longer re-arms. Instead it bumps `failureCount`
 * and sets `cooldownUntil` to now + exponential backoff. The
 * top-of-handler timed re-arm gives one fresh attempt after the
 * cooldown elapses (so a truly transient 500 self-heals), but
 * after `MAX_CONSECUTIVE_FAILURES` the session stays disarmed
 * until a legitimate percent-based rearm fires (classifyDecision
 * "rearm" branch, which only triggers when percent drops below
 * the floor — i.e. context actually shrank). onComplete clears
 * both maps so a successful compact resets the backoff.
 */
const failureCountBySession = new Map<string, number>();
const cooldownUntilBySession = new Map<string, number>();

const ERROR_COOLDOWN_BASE_MS = 60_000;       // 1 min after first failure
const ERROR_COOLDOWN_MAX_MS = 5 * 60_000;    // cap at 5 min
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Best-effort sessionId reader, with ephemeral-session filtering.
 * Mirrors the sediment extension: a session is treated as ephemeral
 * (returns undefined) when `getSessionFile()` is unavailable or
 * returns no path. `--no-session`, `pi --print` without a session
 * file, and dispatch_agent subprocesses without a persisted session
 * all fall into this bucket. Their compaction would summarize
 * messages no future turn will ever see, so we skip the work.
 */
function readSessionId(sm: CompactionTunerCtx["sessionManager"]): string | undefined {
  if (!sm || typeof sm.getSessionId !== "function") return undefined;
  if (typeof sm.getSessionFile === "function") {
    try {
      const file = sm.getSessionFile();
      if (!file || typeof file !== "string") return undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const id = sm.getSessionId();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Audit a single skip row. Mirrors `appendAudit` but exists as a
 * named helper so the INV-K defer path reads cleanly above and the
 * smoke can inject a recorder.
 */
async function recordSimpleSkip(
  projectRoot: string,
  row: Record<string, unknown>,
): Promise<void> {
  try {
    await appendAudit(projectRoot, row);
  } catch { /* never let audit failures break compaction */ }
}

async function appendAudit(projectRoot: string, row: Record<string, unknown>): Promise<void> {
  await fs.mkdir(compactionTunerDir(projectRoot), { recursive: true });
  // Round 9 P0 (sonnet R9-5 fix): ensure .pi-astack/ gitignored on
  // first audit touch. compaction-tuner audit may contain truncated
  // error_message from compact() failures — same exfil risk as sediment
  // audit.jsonl if accidentally git-committed.
  await ensureProjectGitignoredOnce(projectRoot);
  // ADR 0027 C6b: cross-layer causal anchor. Inserted between header
  // fields (timestamp/audit_version/pid/project_root) and caller's row so
  // caller-provided fields take precedence if they happen to overlap.
  const policySource = row.policy_source ?? row.threshold_reason;
  const policyKey = row.policy_key ?? (
    policySource === "model_policy" && typeof row.model_provider === "string" && typeof row.model_id === "string"
      ? `${row.model_provider}/${row.model_id}`
      : undefined
  );
  const enriched = {
    timestamp: formatLocalIsoTimestamp(new Date()),
    ...spreadAnchor(getCurrentAnchor()),
    audit_version: AUDIT_VERSION,
    pid: process.pid,
    project_root: projectRoot,
    ...(policySource ? { policy_source: policySource } : {}),
    ...(policyKey ? { policy_key: policyKey } : {}),
    ...row,
  };
  await fs.appendFile(compactionTunerAuditPath(projectRoot), `${JSON.stringify(enriched)}\n`, "utf-8");
}

function parseModelRef(ref: string): ModelRef | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, slash),
    id: trimmed.slice(slash + 1),
  };
}

function estimatePromptTokensForPreparation(preparation: SessionBeforeCompactEvent["preparation"]): number {
  const messageChars = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
    .reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  return Math.ceil((messageChars + (preparation.previousSummary?.length ?? 0)) / 3);
}

function compactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

async function runCustomCompactionSummary(
  event: SessionBeforeCompactEvent,
  ctx: CompactionTunerCtx,
  settings: CompactionTunerSettings,
  projectRoot: string,
): Promise<{ compaction: CompactionResult } | undefined> {
  if (settings.summaryModels.length === 0) return undefined;

  // P2 (pi 0.79.8 / 0.79.10): attribute every custom-summary audit row to the
  // compaction trigger (manual / threshold / overflow) and the overflow-retry
  // flag, so the audit can tell WHY compaction ran. Field names are namespaced
  // (compaction_reason / will_retry) to avoid colliding with the existing
  // skip-`reason` field already on these rows. (reason/willRetry ship in pi
  // 0.79.10+; the package floor is >=0.80.0, so they are always present.)
  const trigger = { compaction_reason: event.reason, will_retry: event.willRetry };

  const modelRegistry = ctx.modelRegistry;
  if (!modelRegistry || typeof modelRegistry.find !== "function" || typeof modelRegistry.getApiKeyAndHeaders !== "function") {
    await recordSimpleSkip(projectRoot, {
      operation: "custom_summary",
      outcome: "unavailable",
      reason: "model_registry_unavailable",
      summary_models: settings.summaryModels,
      ...trigger,
    });
    return undefined;
  }

  const promptTokensEstimate = estimatePromptTokensForPreparation(event.preparation);
  const attempts: CustomSummaryAttempt[] = [];
  const started = Date.now();

  for (const ref of settings.summaryModels) {
    const parsed = parseModelRef(ref);
    if (!parsed) {
      attempts.push({ model: ref, outcome: "invalid_ref" });
      continue;
    }

    const model = modelRegistry.find(parsed.provider, parsed.id) as { provider?: string; id?: string; contextWindow?: number } | undefined;
    if (!model) {
      attempts.push({ model: ref, provider: parsed.provider, id: parsed.id, outcome: "not_found" });
      continue;
    }

    const contextWindow = typeof model.contextWindow === "number" ? model.contextWindow : null;
    if (contextWindow !== null && promptTokensEstimate > Math.floor(contextWindow * 0.92)) {
      attempts.push({
        model: ref,
        provider: parsed.provider,
        id: parsed.id,
        outcome: "context_window_too_small",
        context_window: contextWindow,
        prompt_tokens_estimate: promptTokensEstimate,
      });
      continue;
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      attempts.push({
        model: ref,
        provider: parsed.provider,
        id: parsed.id,
        outcome: "auth_unavailable",
        error_message: compactErrorMessage(auth.error),
      });
      continue;
    }
    if (!auth.apiKey) {
      attempts.push({ model: ref, provider: parsed.provider, id: parsed.id, outcome: "missing_api_key" });
      continue;
    }

    const attemptStarted = Date.now();
    try {
      const compaction = await runPiCompaction(
        event.preparation,
        model as never,
        auth.apiKey,
        auth.headers,
        (event.customInstructions ?? settings.customInstructions) || undefined,
        event.signal,
      );
      if (!compaction.summary.trim()) {
        attempts.push({
          model: ref,
          provider: parsed.provider,
          id: parsed.id,
          outcome: "empty_summary",
          elapsed_ms: Date.now() - attemptStarted,
          context_window: contextWindow,
          prompt_tokens_estimate: promptTokensEstimate,
        });
        continue;
      }
      attempts.push({
        model: ref,
        provider: parsed.provider,
        id: parsed.id,
        outcome: "completed",
        elapsed_ms: Date.now() - attemptStarted,
        context_window: contextWindow,
        prompt_tokens_estimate: promptTokensEstimate,
      });
      await recordSimpleSkip(projectRoot, {
        operation: "custom_summary",
        outcome: "completed",
        summary_model: ref,
        summary_model_provider: parsed.provider,
        summary_model_id: parsed.id,
        fallback_index: settings.summaryModels.indexOf(ref),
        attempt_count: attempts.length,
        attempts,
        elapsed_ms: Date.now() - started,
        tokens_before: event.preparation.tokensBefore,
        estimated_tokens_after: compaction.estimatedTokensAfter,
        prompt_tokens_estimate: promptTokensEstimate,
        settings_snapshot: snapshotCompactionTunerSettings(settings),
        ...trigger,
      });
      return { compaction };
    } catch (error) {
      attempts.push({
        model: ref,
        provider: parsed.provider,
        id: parsed.id,
        outcome: "error",
        error_message: compactErrorMessage(error),
        elapsed_ms: Date.now() - attemptStarted,
        context_window: contextWindow,
        prompt_tokens_estimate: promptTokensEstimate,
      });
    }
  }

  await recordSimpleSkip(projectRoot, {
    operation: "custom_summary",
    outcome: "fallback_to_default",
    reason: "all_summary_models_failed",
    attempt_count: attempts.length,
    attempts,
    elapsed_ms: Date.now() - started,
    tokens_before: event.preparation.tokensBefore,
    prompt_tokens_estimate: promptTokensEstimate,
    settings_snapshot: snapshotCompactionTunerSettings(settings),
    ...trigger,
  });
  return undefined;
}

function classifyDecision(
  percent: number | null,
  threshold: number,
  armed: boolean,
  rearmMargin: number,
):
  | { decision: "skip"; reason: string }
  | { decision: "rearm"; reason: string }
  | { decision: "trigger" } {
  if (percent === null) return { decision: "skip", reason: "no_usage_yet" };
  if (percent < threshold - rearmMargin && !armed) {
    return { decision: "rearm", reason: "below_rearm_floor" };
  }
  if (percent < threshold) return { decision: "skip", reason: "below_threshold" };
  if (!armed) return { decision: "skip", reason: "already_triggered_awaiting_rearm" };
  return { decision: "trigger" };
}

function readStateKey(sessionId: string): string {
  return sessionId;
}

function applyTimedRearm(stateKey: string, nowMs: number): void {
  const failuresSoFar = failureCountBySession.get(stateKey) ?? 0;
  const cooldownUntil = cooldownUntilBySession.get(stateKey) ?? 0;
  if (
    armedBySession.get(stateKey) === false &&
    failuresSoFar > 0 &&
    failuresSoFar < MAX_CONSECUTIVE_FAILURES &&
    nowMs >= cooldownUntil
  ) {
    armedBySession.set(stateKey, true);
  }
}

function clearBackoffIfBelowRearmFloor(
  stateKey: string,
  percent: number | null,
  thresholdPercent: number,
  rearmMarginPercent: number,
): void {
  if (
    failureCountBySession.has(stateKey) &&
    percent !== null &&
    percent < thresholdPercent - rearmMarginPercent
  ) {
    failureCountBySession.delete(stateKey);
    cooldownUntilBySession.delete(stateKey);
  }
}

function recordSuccessfulTriggerState(stateKey: string): void {
  armedBySession.delete(stateKey);
  failureCountBySession.delete(stateKey);
  cooldownUntilBySession.delete(stateKey);
}

function recordSuccessfulTurnBoundaryTriggerState(stateKey: string): void {
  // A turn-boundary compaction can be followed by one more assistant turn in
  // the same agent run. Keep the session disarmed until usage drops below the
  // rearm floor so the agent_end fallback cannot immediately compact again.
  armedBySession.set(stateKey, /* armed */ false);
  failureCountBySession.delete(stateKey);
  cooldownUntilBySession.delete(stateKey);
}

function recordFailedTriggerState(stateKey: string): { nextFailures: number; cooldownMs: number } {
  const nextFailures = (failureCountBySession.get(stateKey) ?? 0) + 1;
  failureCountBySession.set(stateKey, nextFailures);
  const cooldownMs = Math.min(
    ERROR_COOLDOWN_MAX_MS,
    ERROR_COOLDOWN_BASE_MS * 2 ** (nextFailures - 1),
  );
  cooldownUntilBySession.set(stateKey, Date.now() + cooldownMs);
  return { nextFailures, cooldownMs };
}

function modelRefKey(provider?: string, id?: string): string | undefined {
  if (!provider || !id) return undefined;
  return `${provider}/${id}`;
}

function capByRuntimeWindow(override: number | undefined, runtimeWindow: number | undefined): number | undefined {
  if (override && Number.isFinite(override) && override > 0) {
    return runtimeWindow && runtimeWindow > 0 ? Math.min(override, runtimeWindow) : override;
  }
  return runtimeWindow && Number.isFinite(runtimeWindow) && runtimeWindow > 0
    ? runtimeWindow
    : undefined;
}

function readEffectiveContextBudget(
  usage: TurnBoundaryCompactionUsage | undefined,
  modelInfo: { provider?: string; id?: string; contextWindow?: number },
  dynamic: DynamicThresholdSettings,
  policy?: ModelCompactionPolicySettings,
): number | undefined {
  const ref = modelRefKey(modelInfo.provider, modelInfo.id);
  const override = policy?.effectiveContextBudget ?? (ref ? dynamic.modelEffectiveContextBudgets[ref] : undefined);
  const runtimeWindow = usage?.contextWindow ?? modelInfo.contextWindow;
  return capByRuntimeWindow(override, runtimeWindow);
}

function dynamicCapForBudget(budget: number, dynamic: DynamicThresholdSettings): number {
  if (budget <= dynamic.smallWindowMaxTokens) return dynamic.smallWindowThresholdPercent;
  if (budget <= dynamic.mediumWindowMaxTokens) return dynamic.mediumWindowThresholdPercent;
  return dynamic.largeWindowThresholdPercent;
}

function headroomCapForBudget(budget: number, minHeadroomTokens: number): number {
  return minHeadroomTokens > 0 && budget > minHeadroomTokens
    ? Math.max(10, Math.min(95, Math.floor(((budget - minHeadroomTokens) / budget) * 100)))
    : 95;
}

function computeEffectiveThreshold(
  settings: CompactionTunerSettings,
  usage: TurnBoundaryCompactionUsage | undefined,
  modelInfo: { provider?: string; id?: string; contextWindow?: number },
): {
  thresholdPercent: number;
  effectiveContextBudget?: number;
  policySource: "model_policy" | "dynamic" | "global";
  policyKey?: string;
} {
  const configured = settings.thresholdPercent;
  const dynamic = settings.dynamicThreshold;
  const policyKey = modelRefKey(modelInfo.provider, modelInfo.id);
  const policy = policyKey ? settings.modelPolicies[policyKey] : undefined;
  if (policy) {
    const budget = readEffectiveContextBudget(usage, modelInfo, dynamic, policy);
    const policyThreshold = policy.thresholdPercent ?? configured;
    const headroomCap = budget && policy.minHeadroomTokens !== undefined
      ? headroomCapForBudget(budget, policy.minHeadroomTokens)
      : 95;
    return {
      thresholdPercent: Math.min(policyThreshold, headroomCap),
      effectiveContextBudget: budget,
      policySource: "model_policy",
      policyKey,
    };
  }
  if (!dynamic.enabled) {
    return { thresholdPercent: configured, policySource: "global" };
  }
  const budget = readEffectiveContextBudget(usage, modelInfo, dynamic);
  if (!budget) {
    return { thresholdPercent: configured, policySource: "global" };
  }
  const classCap = dynamicCapForBudget(budget, dynamic);
  const headroomCap = headroomCapForBudget(budget, dynamic.minHeadroomTokens);
  return {
    thresholdPercent: Math.min(configured, classCap, headroomCap),
    effectiveContextBudget: budget,
    policySource: "dynamic",
  };
}

function computeEffectiveRearmMargin(thresholdPercent: number, configuredRearmMarginPercent: number, policy?: ModelCompactionPolicySettings): number {
  return Math.min(policy?.rearmMarginPercent ?? configuredRearmMarginPercent, Math.max(0, thresholdPercent - 1));
}

function computeCompactionDecisionMetrics(
  settings: CompactionTunerSettings,
  usage: TurnBoundaryCompactionUsage | undefined,
  modelInfo: { provider?: string; id?: string; contextWindow?: number },
): {
  thresholdPercent: number;
  rearmMarginPercent: number;
  configuredRearmMarginPercent: number;
  effectiveContextBudget?: number;
  thresholdReason: "model_policy" | "dynamic" | "global";
  policySource: "model_policy" | "dynamic" | "global";
  policyKey?: string;
  percent: number | null;
  rawPercent: number | null;
} {
  const threshold = computeEffectiveThreshold(settings, usage, modelInfo);
  const policy = threshold.policyKey ? settings.modelPolicies[threshold.policyKey] : undefined;
  const rawPercent = usage?.percent ?? null;
  const tokens = usage?.tokens;
  const runtimeWindow = usage?.contextWindow ?? modelInfo.contextWindow;
  const estimatedTokens = typeof tokens === "number" && Number.isFinite(tokens)
    ? tokens
    : rawPercent !== null && runtimeWindow && runtimeWindow > 0
      ? (rawPercent / 100) * runtimeWindow
      : undefined;
  const percent = threshold.effectiveContextBudget && typeof estimatedTokens === "number" && Number.isFinite(estimatedTokens)
    ? (estimatedTokens / threshold.effectiveContextBudget) * 100
    : rawPercent;
  return {
    thresholdPercent: threshold.thresholdPercent,
    rearmMarginPercent: computeEffectiveRearmMargin(threshold.thresholdPercent, settings.rearmMarginPercent, policy),
    configuredRearmMarginPercent: policy?.rearmMarginPercent ?? settings.rearmMarginPercent,
    effectiveContextBudget: threshold.effectiveContextBudget,
    thresholdReason: threshold.policySource,
    policySource: threshold.policySource,
    policyKey: threshold.policyKey,
    percent,
    rawPercent,
  };
}

function inspectCompactionTunerDecision(
  stateKey: string,
  percent: number | null,
  thresholdPercent: number,
  rearmMarginPercent: number,
  nowMs: number,
):
  | { decision: "skip"; reason: string }
  | { decision: "rearm"; reason: string }
  | { decision: "trigger" } {
  applyTimedRearm(stateKey, nowMs);
  const wasArmed = armedBySession.get(stateKey) ?? true;
  const decision = classifyDecision(percent, thresholdPercent, wasArmed, rearmMarginPercent);
  if (decision.decision === "rearm") {
    armedBySession.set(stateKey, true);
    failureCountBySession.delete(stateKey);
    cooldownUntilBySession.delete(stateKey);
  }
  return decision;
}

function getCompactionFailureGate(stateKey: string, nowMs: number):
  | { ok: true }
  | { ok: false; reason: "max_failures_reached"; failuresSoFar: number }
  | { ok: false; reason: "in_error_cooldown"; failuresSoFar: number; cooldownRemainingMs: number } {
  const failuresSoFar = failureCountBySession.get(stateKey) ?? 0;
  const cooldownUntil = cooldownUntilBySession.get(stateKey) ?? 0;
  if (failuresSoFar >= MAX_CONSECUTIVE_FAILURES) {
    return { ok: false, reason: "max_failures_reached", failuresSoFar };
  }
  if (failuresSoFar > 0 && nowMs < cooldownUntil) {
    return { ok: false, reason: "in_error_cooldown", failuresSoFar, cooldownRemainingMs: cooldownUntil - nowMs };
  }
  return { ok: true };
}

function compactErrorMessageFromError(error: Error): string {
  return compactErrorMessage(error);
}

function getLastAgentMessageRole(session: CompactionTunerSessionLike): string | undefined {
  const messages = session.agent?.state?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] as { role?: unknown } | undefined : undefined;
  return typeof last?.role === "string" ? last.role : undefined;
}

function getSessionModelInfo(session: CompactionTunerSessionLike): { provider?: string; id?: string; contextWindow?: number } {
  const stateModel = session.agent?.state?.model;
  return {
    provider: session.model?.provider ?? stateModel?.provider,
    id: session.model?.id ?? stateModel?.id,
    contextWindow: session.model?.contextWindow ?? stateModel?.contextWindow,
  };
}

export default function (pi: ExtensionAPI) {
  // Sub-pi guard (2026-05-14 audit): compaction-tuner must not fire
  // in sub-pi — sub-agents have their own ephemeral sessions and
  // shouldn't trigger compaction of the parent's context.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  installTurnBoundaryCompactionPatch("compaction-tuner", {
    warn: (msg) => console.warn(msg),
    shouldCompact: async (sessionUnknown: unknown): Promise<TurnBoundaryCompactionDecision> => {
      const session = sessionUnknown as CompactionTunerSessionLike;
      const settings = resolveCompactionTunerSettings();
      if (!settings.enabled) return { decision: "skip", reason: "disabled" };

      const sessionId = readSessionId(session.sessionManager);
      if (!sessionId) return { decision: "skip", reason: "ephemeral_session" };

      const lastMessageRole = getLastAgentMessageRole(session);
      if (lastMessageRole !== "toolResult") {
        return { decision: "skip", reason: "last_message_not_tool_result", sessionId };
      }

      const usage = typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined;
      const stateKey = readStateKey(sessionId);
      const modelInfo = getSessionModelInfo(session);
      const metrics = computeCompactionDecisionMetrics(settings, usage, modelInfo);
      clearBackoffIfBelowRearmFloor(stateKey, metrics.percent, metrics.thresholdPercent, metrics.rearmMarginPercent);
      const decision = inspectCompactionTunerDecision(
        stateKey,
        metrics.percent,
        metrics.thresholdPercent,
        metrics.rearmMarginPercent,
        Date.now(),
      );
      if (decision.decision === "rearm") {
        return { decision: "skip", reason: decision.reason, usage, sessionId };
      }
      if (decision.decision === "skip") {
        return { decision: "skip", reason: decision.reason, usage, sessionId };
      }

      const gate = getCompactionFailureGate(stateKey, Date.now());
      if (!gate.ok) {
        const cwd = path.resolve(session._cwd || process.cwd());
        await recordSimpleSkip(cwd, {
          operation: "turn_boundary_trigger",
          decision: "skip",
          reason: gate.reason,
          session_id: sessionId,
          usage_percent: metrics.percent,
          raw_usage_percent: metrics.rawPercent,
          consecutive_failures: gate.failuresSoFar,
          ...(gate.reason === "in_error_cooldown" ? { cooldown_remaining_ms: gate.cooldownRemainingMs } : {}),
          threshold_percent: metrics.thresholdPercent,
          configured_threshold_percent: settings.thresholdPercent,
          effective_context_budget: metrics.effectiveContextBudget ?? null,
          threshold_reason: metrics.thresholdReason,
          settings_snapshot: snapshotCompactionTunerSettings(settings),
        });
        return { decision: "skip", reason: gate.reason, usage, sessionId };
      }

      if (isPendingPromptUserBlocking()) {
        const cwd = path.resolve(session._cwd || process.cwd());
        await recordSimpleSkip(cwd, {
          operation: "turn_boundary_trigger",
          decision: "skip",
          reason: "prompt_user_pending",
          session_id: sessionId,
          usage_percent: metrics.percent,
          raw_usage_percent: metrics.rawPercent,
          threshold_percent: metrics.thresholdPercent,
          configured_threshold_percent: settings.thresholdPercent,
          effective_context_budget: metrics.effectiveContextBudget ?? null,
          threshold_reason: metrics.thresholdReason,
        });
        return { decision: "skip", reason: "prompt_user_pending", usage, sessionId };
      }
      if (isPendingVaultDialogBlocking()) {
        const cwd = path.resolve(session._cwd || process.cwd());
        await recordSimpleSkip(cwd, {
          operation: "turn_boundary_trigger",
          decision: "skip",
          reason: "vault_dialog_pending",
          session_id: sessionId,
          usage_percent: metrics.percent,
          raw_usage_percent: metrics.rawPercent,
          threshold_percent: metrics.thresholdPercent,
          configured_threshold_percent: settings.thresholdPercent,
          effective_context_budget: metrics.effectiveContextBudget ?? null,
          threshold_reason: metrics.thresholdReason,
        });
        return { decision: "skip", reason: "vault_dialog_pending", usage, sessionId };
      }

      armedBySession.set(stateKey, /* armed */ false);
      return usage
        ? { decision: "trigger", usage, sessionId }
        : { decision: "skip", reason: "usage_unavailable", sessionId };
    },
    onComplete: async ({ session: sessionUnknown, usage, sessionId, elapsedMs, result }) => {
      const session = sessionUnknown as CompactionTunerSessionLike;
      const cwd = path.resolve(session._cwd || process.cwd());
      const stateKey = readStateKey(sessionId);
      const settings = resolveCompactionTunerSettings();
      const modelInfo = getSessionModelInfo(session);
      const metrics = computeCompactionDecisionMetrics(settings, usage, modelInfo);
      if (result) {
        recordSuccessfulTurnBoundaryTriggerState(stateKey);
      } else {
        // `_runAutoCompaction()` returns false for benign no-op cases
        // (missing auth, no eligible messages, abort). Do not count those
        // as provider failures/backoff, but keep the session disarmed until
        // usage drops below the rearm floor so we do not hammer a no-op path
        // on every turn-boundary check.
        armedBySession.set(stateKey, /* armed */ false);
      }
      await appendAudit(cwd, {
        operation: "turn_boundary_trigger",
        outcome: result ? "completed" : "no_op",
        session_id: sessionId,
        percent_at_trigger: metrics.percent,
        raw_percent_at_trigger: metrics.rawPercent,
        threshold_percent: metrics.thresholdPercent,
        configured_threshold_percent: settings.thresholdPercent,
        effective_context_budget: metrics.effectiveContextBudget ?? null,
        threshold_reason: metrics.thresholdReason,
        rearm_margin_percent: metrics.rearmMarginPercent,
        configured_rearm_margin_percent: metrics.configuredRearmMarginPercent,
        tokens_at_trigger: usage.tokens ?? null,
        context_window: usage.contextWindow ?? modelInfo.contextWindow ?? null,
        model_provider: modelInfo.provider ?? null,
        model_id: modelInfo.id ?? null,
        last_message_role: getLastAgentMessageRole(session) ?? null,
        elapsed_ms: elapsedMs,
        settings_snapshot: snapshotCompactionTunerSettings(settings),
      });
    },
    onError: async ({ session: sessionUnknown, usage, sessionId, elapsedMs, error }) => {
      const session = sessionUnknown as CompactionTunerSessionLike;
      const cwd = path.resolve(session._cwd || process.cwd());
      const settings = resolveCompactionTunerSettings();
      const modelInfo = getSessionModelInfo(session);
      const metrics = computeCompactionDecisionMetrics(settings, usage, modelInfo);
      const stateKey = sessionId ? readStateKey(sessionId) : undefined;
      const failureState = stateKey
        ? recordFailedTriggerState(stateKey)
        : { nextFailures: 0, cooldownMs: 0 };
      if (stateKey && failureState.nextFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `compaction-tuner: ${MAX_CONSECUTIVE_FAILURES} consecutive turn-boundary compaction failures — ` +
          `auto-compaction disabled for this session until usage drops below ` +
          `${metrics.thresholdPercent - metrics.rearmMarginPercent}%. ` +
          `Use '/compaction-tuner reset' to clear backoff and try again.`,
        );
      }
      await appendAudit(cwd, {
        operation: "turn_boundary_trigger",
        outcome: "error",
        error_message: compactErrorMessageFromError(error),
        session_id: sessionId ?? null,
        percent_at_trigger: metrics.percent,
        raw_percent_at_trigger: metrics.rawPercent,
        threshold_percent: metrics.thresholdPercent,
        configured_threshold_percent: settings.thresholdPercent,
        effective_context_budget: metrics.effectiveContextBudget ?? null,
        threshold_reason: metrics.thresholdReason,
        tokens_at_trigger: usage?.tokens ?? null,
        context_window: usage?.contextWindow ?? modelInfo.contextWindow ?? null,
        model_provider: modelInfo.provider ?? null,
        model_id: modelInfo.id ?? null,
        last_message_role: getLastAgentMessageRole(session) ?? null,
        elapsed_ms: elapsedMs,
        consecutive_failures: failureState.nextFailures,
        cooldown_remaining_ms: failureState.cooldownMs,
        settings_snapshot: snapshotCompactionTunerSettings(settings),
      });
    },
    onUnavailable: (api) => {
      void recordSimpleSkip(process.cwd(), {
        operation: "turn_boundary_patch",
        outcome: "unavailable",
        api,
      });
    },
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: CompactionTunerCtx) => {
    const settings = resolveCompactionTunerSettings();
    if (!settings.enabled || settings.summaryModels.length === 0) return undefined;
    const cwd = path.resolve(ctx.cwd || process.cwd());
    try {
      return await runCustomCompactionSummary(event, ctx, settings, cwd);
    } catch (error) {
      await recordSimpleSkip(cwd, {
        operation: "custom_summary",
        outcome: "fallback_to_default",
        reason: "custom_summary_hook_threw",
        error_message: compactErrorMessage(error),
        compaction_reason: event.reason,
        will_retry: event.willRetry,
        settings_snapshot: snapshotCompactionTunerSettings(settings),
      });
      return undefined;
    }
  });

  pi.on("agent_end", async (_event: unknown, ctx: CompactionTunerCtx) => {
    // ADR 0027 PR-B: compaction-tuner observes main-session context
    // pressure to adjust thresholds. Sub-agent sessions are in-memory
    // ephemeral, have their own (different) model + budget, and shouldn’t
    // feed their token usage into main-session compaction state.
    if (isSubAgentSession(ctx)) return;

    // ADR 0027 PR-B+ R1 P0-β: snapshot anchor at handler entry. The body
    // fires off `void recordOutcome(...)` and other fire-and-forget audit
    // writers that may run after the next user prompt has advanced
    // `_currentTurnId`. Without this scope, late writes carry the wrong
    // turn. See causal-anchor.ts P0-β docs.
    return runWithTriggerAnchor(getCurrentAnchor(), async () => {

    // Capture ctx fields synchronously — pi may invalidate ctx during
    // async work (same pattern sediment uses).
    const cwd = path.resolve(ctx.cwd || process.cwd());
    const sessionId = readSessionId(ctx.sessionManager);
    const hasUI = !!ctx.hasUI;
    const notify = ctx.ui?.notify?.bind(ctx.ui);
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const compact = typeof ctx.compact === "function" ? ctx.compact.bind(ctx) : undefined;
    const modelInfo = {
      provider: ctx.model?.provider,
      id: ctx.model?.id,
      contextWindow: ctx.model?.contextWindow,
    };

    const settings = resolveCompactionTunerSettings();
    if (!settings.enabled) return;
    // Ephemeral sessions: their compaction would summarize a transcript
    // no future turn will read. Skip silently and don't even pollute
    // hysteresis state with a throwaway slot.
    if (!sessionId) return;
    if (!compact) return;

    // sessionId is guaranteed truthy past the ephemeral early-return.
    const stateKey = readStateKey(sessionId);

    // Timed re-arm after error cooldown. If a previous trigger failed,
    // armed is stuck at false; the only paths out are (a) percent drops
    // below floor (classifyDecision "rearm" branch), or (b) the
    // cooldown elapses AND failures < MAX (this block). This gives a
    // truly transient provider error one fresh attempt without forming
    // a retry storm.
    const nowMs = Date.now();
    applyTimedRearm(stateKey, nowMs);

    const metrics = computeCompactionDecisionMetrics(settings, usage, modelInfo);
    const percent = metrics.percent;

    // Opportunistic backoff clear (P1-1 fix from 2026-05-21 review):
    // if percent dropped below the rearm floor, real context reduction
    // happened somewhere (manual /compact, pi's own auto-compact,
    // message-slice from retry, etc.). Clear stale failure state
    // regardless of HOW armed got to its current value. This closes
    // the gap where timed re-arm beats percent-based rearm: it sets
    // armed=true at the top of the handler, so classifyDecision's
    // "rearm" branch (which requires !armed) is unreachable, leaving
    // failureCount/cooldown stale to bias the next trigger's backoff.
    clearBackoffIfBelowRearmFloor(stateKey, percent, metrics.thresholdPercent, metrics.rearmMarginPercent);

    const wasArmed = armedBySession.get(stateKey) ?? true;
    const decision = classifyDecision(percent, metrics.thresholdPercent, wasArmed, metrics.rearmMarginPercent);

    // Update arming state for "rearm" decisions before logging/short-circuiting.
    if (decision.decision === "rearm") {
      armedBySession.set(stateKey, true);
      // Percent dropped below floor → real progress was made; the
      // opportunistic block above already cleared backoff state in
      // this case, but be explicit (idempotent .delete()) so future
      // refactors don't accidentally rely on the upstream clear.
      failureCountBySession.delete(stateKey);
      cooldownUntilBySession.delete(stateKey);
      // Don't audit pure rearm transitions to keep the log focused on triggers.
      return;
    }

    if (decision.decision === "skip") {
      // Silent skip: avoid audit churn (one row per turn would dominate
      // the log). Only triggers and errors are logged.
      return;
    }

    // decision === "trigger"
    const ts = Date.now();

    // Error backoff guards (defensive depth). In the current control
    // flow these are UNREACHABLE — classifyDecision short-circuits with
    // "already_triggered_awaiting_rearm" while armed=false, and the
    // top-of-handler timed re-arm only sets armed=true when
    // failures<MAX and cooldown elapsed. So if we got here, the upstream
    // checks already vetted both conditions.
    //
    // BUT — if a future refactor leaves armed=true with pending
    // failures/cooldown (e.g. someone adds another rearm path that
    // doesn't clear backoff state), these guards stop a retry storm
    // instead of launching unbounded compact() calls. The audit reason
    // makes the situation visible. See failureCountBySession header
    // comment for the 2026-05-18 incident that motivated this entire
    // backoff machinery.
    const failureGate = getCompactionFailureGate(stateKey, ts);
    if (!failureGate.ok) {
      await recordSimpleSkip(cwd, {
        ts: new Date(ts).toISOString(),
        decision: "skip",
        reason: failureGate.reason,
        usage_percent: percent,
        raw_usage_percent: metrics.rawPercent,
        consecutive_failures: failureGate.failuresSoFar,
        ...(failureGate.reason === "in_error_cooldown" ? { cooldown_remaining_ms: failureGate.cooldownRemainingMs } : {}),
        threshold_percent: metrics.thresholdPercent,
        configured_threshold_percent: settings.thresholdPercent,
        effective_context_budget: metrics.effectiveContextBudget ?? null,
        threshold_reason: metrics.thresholdReason,
      });
      return;
    }
    // ADR 0022 INV-K: defer compaction while a user-facing overlay
    // (prompt_user dialog OR vault authorization dialog) is pending.
    // We check AFTER classifyDecision returned "trigger" but BEFORE
    // consuming rearm state — so the next agent_end after the user
    // answers will re-classify and trigger normally (no missed
    // compaction; just delayed one turn).
    //
    // Unlike the silent skips above, we DO audit this branch because
    // (a) the cardinality is low (only fires while the user is at the
    // keyboard), and (b) operators chasing "why didn't compaction
    // fire at 90%?" need an observable trace.
    //
    // Two separate checks, separate audit reasons. See
    // ./vault-defer.ts header for why these are NOT collapsed into a
    // single "any overlay" hook. prompt_user is checked first because
    // it's the more common path (vault auth is per-secret-release).
    if (isPendingPromptUserBlocking()) {
      await recordSimpleSkip(cwd, {
        ts: new Date(ts).toISOString(),
        decision: "skip",
        reason: "prompt_user_pending",
        usage_percent: percent,
        raw_usage_percent: metrics.rawPercent,
        threshold_percent: metrics.thresholdPercent,
        configured_threshold_percent: settings.thresholdPercent,
        effective_context_budget: metrics.effectiveContextBudget ?? null,
        threshold_reason: metrics.thresholdReason,
      });
      return;
    }
    if (isPendingVaultDialogBlocking()) {
      await recordSimpleSkip(cwd, {
        ts: new Date(ts).toISOString(),
        decision: "skip",
        reason: "vault_dialog_pending",
        usage_percent: percent,
        raw_usage_percent: metrics.rawPercent,
        threshold_percent: metrics.thresholdPercent,
        configured_threshold_percent: settings.thresholdPercent,
        effective_context_budget: metrics.effectiveContextBudget ?? null,
        threshold_reason: metrics.thresholdReason,
      });
      return;
    }

    armedBySession.set(stateKey, /* armed */ false);

    if (hasUI && settings.notifyOnTrigger && notify) {
      notify(
        `compaction-tuner: triggering compact at ${(percent ?? 0).toFixed(1)}% (threshold ${metrics.thresholdPercent}%)`,
        "info",
      );
    }

    let outcomeRecorded = false;
    const recordOutcome = async (row: Record<string, unknown>) => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      try {
        await appendAudit(cwd, row);
      } catch {
        // never let audit failures break compaction
      }
    };

    try {
      compact({
        customInstructions: settings.customInstructions || undefined,
        onComplete: () => {
          if (hasUI && settings.notifyOnTrigger && notify) {
            notify("compaction-tuner: compaction completed", "info");
          }
          // Compact succeeded → wipe ALL session state so a fresh
          // cycle starts. armedBySession is also deleted (rather
          // than left at false) so it doesn't accumulate stale
          // entries for long-lived pi processes (DEEPSEEK P1-2);
          // .get(stateKey) ?? true correctly defaults to armed on
          // the next agent_end.
          recordSuccessfulTriggerState(stateKey);
          void recordOutcome({
            operation: "trigger",
            outcome: "completed",
            session_id: sessionId,
            percent_at_trigger: percent,
            raw_percent_at_trigger: metrics.rawPercent,
            threshold_percent: metrics.thresholdPercent,
            configured_threshold_percent: settings.thresholdPercent,
            effective_context_budget: metrics.effectiveContextBudget ?? null,
            threshold_reason: metrics.thresholdReason,
            rearm_margin_percent: metrics.rearmMarginPercent,
            configured_rearm_margin_percent: metrics.configuredRearmMarginPercent,
            tokens_at_trigger: usage?.tokens ?? null,
            context_window: usage?.contextWindow ?? modelInfo.contextWindow ?? null,
            model_provider: modelInfo.provider ?? null,
            model_id: modelInfo.id ?? null,
            elapsed_ms: Date.now() - ts,
            settings_snapshot: snapshotCompactionTunerSettings(settings),
          });
        },
        onError: (error) => {
          if (hasUI && notify) {
            notify(`compaction-tuner: compaction failed: ${error.message}`, "error");
          }
          // Do NOT re-arm immediately (the old code's bug — see
          // failureCountBySession header comment for the 2026-05-18
          // retry storm this caused). Instead bump failure count and
          // set exponential cooldown; the top-of-handler timed re-arm
          // grants one fresh attempt after cooldown IFF failures <
          // MAX. armedBySession stays at false (set just above when we
          // decided to trigger).
          const { nextFailures, cooldownMs } = recordFailedTriggerState(stateKey);
          // When MAX reached, the session is permanently disarmed
          // until percent drops below floor (impossible on an
          // overflowed context where compact is the only way to
          // shrink). Tell the user about the escape hatch so they
          // don't think auto-compaction is silently broken.
          if (hasUI && notify && nextFailures >= MAX_CONSECUTIVE_FAILURES) {
            notify(
              `compaction-tuner: ${MAX_CONSECUTIVE_FAILURES} consecutive failures — ` +
              `auto-compaction disabled for this session until usage drops ` +
              `below ${metrics.thresholdPercent - metrics.rearmMarginPercent}%. ` +
              `Use '/compaction-tuner reset' to clear backoff and try again.`,
              "warning",
            );
          }
          void recordOutcome({
            operation: "trigger",
            outcome: "error",
            error_message: compactErrorMessage(error),
            session_id: sessionId,
            percent_at_trigger: percent,
            raw_percent_at_trigger: metrics.rawPercent,
            threshold_percent: metrics.thresholdPercent,
            configured_threshold_percent: settings.thresholdPercent,
            effective_context_budget: metrics.effectiveContextBudget ?? null,
            threshold_reason: metrics.thresholdReason,
            tokens_at_trigger: usage?.tokens ?? null,
            context_window: usage?.contextWindow ?? modelInfo.contextWindow ?? null,
            model_provider: modelInfo.provider ?? null,
            model_id: modelInfo.id ?? null,
            elapsed_ms: Date.now() - ts,
            consecutive_failures: nextFailures,
            cooldown_remaining_ms: cooldownMs,
            settings_snapshot: snapshotCompactionTunerSettings(settings),
          });
        },
      });
    } catch (err) {
      // Defense-in-depth only. The pi runtime wraps ctx.compact() in
      // an async IIFE (see agent-session.js:1770-1781) that routes
      // sync throws to onError(), so this catch is effectively
      // unreachable in normal pi builds. We keep it (with the same
      // backoff policy as onError) so a future pi change that drops
      // the IIFE wrapper doesn't silently bypass backoff.
      const message = err instanceof Error ? err.message : String(err);
      const { nextFailures, cooldownMs } = recordFailedTriggerState(stateKey);
      await recordOutcome({
        operation: "trigger",
        outcome: "sync_error",
        error_message: message,
        session_id: sessionId,
        percent_at_trigger: percent,
        raw_percent_at_trigger: metrics.rawPercent,
        threshold_percent: metrics.thresholdPercent,
        configured_threshold_percent: settings.thresholdPercent,
        effective_context_budget: metrics.effectiveContextBudget ?? null,
        threshold_reason: metrics.thresholdReason,
        elapsed_ms: Date.now() - ts,
        consecutive_failures: nextFailures,
        cooldown_remaining_ms: cooldownMs,
        settings_snapshot: snapshotCompactionTunerSettings(settings),
      });
    }

    }); // end runWithTriggerAnchor — ADR 0027 PR-B+ R1 P0-β trigger-time scope
  });

  pi.registerCommand("compaction-tuner", {
    description: "Inspect / debug compaction-tuner: status | trigger | reset",
    handler: async (
      args: string,
      ctx: CompactionTunerCtx & {
        ui: { notify(message: string, type?: string): void };
      },
    ) => {
      const sub = args.trim() || "status";
      const settings = resolveCompactionTunerSettings();
      const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;

      if (sub === "status") {
        const modelInfo = {
          provider: ctx.model?.provider,
          id: ctx.model?.id,
          contextWindow: ctx.model?.contextWindow,
        };
        const metrics = computeCompactionDecisionMetrics(settings, usage, modelInfo);
        // Surface per-session state so operators chasing "why isn't
        // compaction firing at 90%?" can see whether it's disarmed
        // (post-trigger awaiting rearm), in error backoff, or at
        // MAX. Shows ALL sessions known to this process (usually 1,
        // but dispatch-agent / multi-session hosts can have more).
        const knownSessions = new Set<string>([
          ...armedBySession.keys(),
          ...failureCountBySession.keys(),
          ...cooldownUntilBySession.keys(),
        ]);
        const sessionLines: string[] = [];
        if (knownSessions.size > 0) {
          const now = Date.now();
          for (const sid of knownSessions) {
            const armed = armedBySession.get(sid);
            const f = failureCountBySession.get(sid) ?? 0;
            const cu = cooldownUntilBySession.get(sid) ?? 0;
            const remainingMs = Math.max(0, cu - now);
            const armedStr = armed === undefined
              ? "armed=default(true)"
              : `armed=${armed}`;
            sessionLines.push(
              `  ${sid.slice(0, 8)}…: ${armedStr}, failures=${f}/${MAX_CONSECUTIVE_FAILURES}` +
              (remainingMs > 0 ? `, cooldown=${Math.ceil(remainingMs / 1000)}s` : "") +
              (f >= MAX_CONSECUTIVE_FAILURES ? " (max reached — use /compaction-tuner reset)" : ""),
            );
          }
        }
        const lines = [
          "# compaction-tuner",
          "",
          `enabled: ${settings.enabled}`,
          `thresholdPercent: ${settings.thresholdPercent}%`,
          `effectiveThresholdPercent: ${metrics.thresholdPercent}%${metrics.effectiveContextBudget ? ` (budget ${metrics.effectiveContextBudget} tokens)` : ""}`,
          `dynamicThreshold: ${settings.dynamicThreshold.enabled ? `enabled (${metrics.thresholdReason})` : "disabled"}`,
          `rearmMarginPercent: ${metrics.rearmMarginPercent}%${metrics.rearmMarginPercent !== metrics.configuredRearmMarginPercent ? ` (configured ${metrics.configuredRearmMarginPercent}%)` : ""}`,
          `notifyOnTrigger: ${settings.notifyOnTrigger}`,
          `customInstructions: ${settings.customInstructions ? `(${settings.customInstructions.length} chars)` : "(empty)"}`,
          `summaryModels: ${settings.summaryModels.length > 0 ? settings.summaryModels.join(", ") : "(default — main session model)"}`,
          "",
          `current usage: ${metrics.percent != null ? `${metrics.percent.toFixed(1)}% (${usage?.tokens}/${metrics.effectiveContextBudget ?? usage?.contextWindow} effective tokens)` : "(unknown — no post-compaction usage yet)"}`,
          `raw usage: ${metrics.rawPercent != null ? `${metrics.rawPercent.toFixed(1)}% (${usage?.tokens}/${usage?.contextWindow} runtime tokens)` : "(unknown)"}`,
          `model: ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`,
          "",
          `per-session state:${sessionLines.length === 0 ? " none (fresh process)" : ""}`,
          ...sessionLines,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "reset") {
        // Escape hatch from a permanently-disarmed session (MAX
        // failures reached on an overflowed context where percent
        // can't drop without compact succeeding). Clears ALL
        // per-session state for the current session so the next
        // agent_end re-evaluates fresh.
        const sid = readSessionId(ctx.sessionManager);
        if (!sid) {
          ctx.ui.notify(
            "compaction-tuner: no resumable session bound (ephemeral / --no-session)",
            "warning",
          );
          return;
        }
        const hadArmed = armedBySession.has(sid);
        const hadFailures = failureCountBySession.has(sid);
        const f = failureCountBySession.get(sid) ?? 0;
        const cu = cooldownUntilBySession.get(sid) ?? 0;
        const remainingMs = Math.max(0, cu - Date.now());
        armedBySession.delete(sid);
        failureCountBySession.delete(sid);
        cooldownUntilBySession.delete(sid);
        const summary = hadFailures
          ? `cleared backoff (was failures=${f}/${MAX_CONSECUTIVE_FAILURES}` +
            (remainingMs > 0 ? `, cooldown=${Math.ceil(remainingMs / 1000)}s` : "") +
            `)`
          : hadArmed
            ? "cleared armed state (no error backoff was set)"
            : "no state to clear (session was already fresh)";
        ctx.ui.notify(
          `compaction-tuner: reset ${sid.slice(0, 8)}… — ${summary}`,
          "info",
        );
        return;
      }

      if (sub === "trigger") {
        if (typeof ctx.compact !== "function") {
          ctx.ui.notify("ctx.compact unavailable", "error");
          return;
        }
        ctx.ui.notify(
          `compaction-tuner: forced compact (${usage?.percent != null ? `${usage.percent.toFixed(1)}%` : "unknown"})`,
          "info",
        );
        ctx.compact({
          customInstructions: settings.customInstructions || undefined,
          onComplete: () => ctx.ui.notify("compaction-tuner: forced compact completed", "info"),
          onError: (e) => ctx.ui.notify(`compaction-tuner: forced compact failed: ${e.message}`, "error"),
        });
        return;
      }

      ctx.ui.notify(`unknown subcommand: ${sub}\nusage: /compaction-tuner [status|trigger|reset]`, "warning");
    },
  });
}

// Test-only exports: the smoke harness uses these directly to verify
// decision logic without going through pi's runtime.
export { classifyDecision, computeEffectiveThreshold, DEFAULT_COMPACTION_TUNER_SETTINGS };
