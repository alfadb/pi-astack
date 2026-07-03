/**
 * dispatch_hub — ADR 0030 caged-live dynamic hub (increment 2 + 3).
 *
 * A hub LLM (cross-vendor, per-task selected) proposes a worker assignment
 * { workers:[{model,role,prompt}], rationale } for a task; dispatch_hub then
 * REALLY dispatches those workers via the exported runInProcess (single-level,
 * read-only default, nested-dispatch forbidden — inherited) and returns the
 * aggregate. This is NOT advisory-shadow: the assignment is executed, so the
 * online evaluation harness (ADR 0030 §5) gets real outcomes to judge.
 *
 * Cage (ADR 0030 §4): worker count hard-capped at HARD_MAX_WORKERS; workers
 * read-only by default (WORKER_TOOLS + hub prompt — not a hard tool cap; same
 * posture as dispatch after the 2026-06-16 env-gate removal); NO cost gate
 * (INV-COST-NOT-A-GATE — cost is report-only);
 * dispatch.hub.enabled default false (tool is not registered when off);
 * cross-vendor decorrelation flagged in audit (hub vendor vs worker vendors).
 *
 * This module keeps all decision logic in PURE, offline-testable functions
 * (selection / parse / validate / audit-row builders). The orchestration
 * shell (registerHubTool) is thin over them and reuses dispatch primitives
 * injected as deps, so the smoke-locked dispatch_parallel core is untouched.
 *
 * Audit rows are ADDITIVE new row_kinds (hub_decision / hub_disposition /
 * hub_summary) on the existing dispatch audit stream — joined to per-worker
 * task rows by the C6 anchor (session_id, turn_id, subturn).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DispatchCounts,
  DispatchProgressSnapshot,
  DispatchProgressTask,
  DispatchState,
} from "./index"; // type-only (erased) — no runtime import cycle
import {
  getCurrentAnchor,
  deriveSubAgentAnchor,
  formatAnchorPromptBlock,
  runWithTriggerAnchor,
  type CausalAnchor,
} from "../_shared/causal-anchor";

type HubToolRenderer = (...args: any[]) => unknown;

// ── Cage constant (ADR 0030 §4: non-tunable sanity ceiling) ─────

/** Hard worker-count ceiling. An infra liveness/resource bound, NOT a cost
 *  gate. settings.dispatch.hub.maxWorkers is clamped to [1, HARD_MAX_WORKERS]
 *  so config can only LOWER it, never raise past the焊死 ceiling. */
export const HARD_MAX_WORKERS = 8;

// ── Types ───────────────────────────────────────────────────────

export interface HubSettings {
  /** ADR 0030 §4 kill-switch. Default false → tool not registered. */
  enabled: boolean;
  /** Explicit hub planning model. When absent, auto-pick a flagship-tier
   *  model decorrelated from the worker vendors. */
  model?: string;
  /** Worker-count ceiling, clamped to [1, HARD_MAX_WORKERS]. */
  maxWorkers: number;
  /** Thinking level for the hub planning call. */
  thinking: string;
  /** ADR 0030 §5(b): fraction of hub turns that also dual-execute for the
   *  cross-vendor correctness judge. Consumed by the oracle (increment 4). */
  dualExecSampleRate: number;
}

export interface HubWorkerSpec {
  model: string;
  role: string;
  prompt: string;
  thinking?: string;
  tools?: string;
}

export interface HubPlan {
  workers: HubWorkerSpec[];
  rationale: string;
}

export interface HubValidation {
  /** Workers that survived validation (valid model, capped to maxWorkers). */
  workers: HubWorkerSpec[];
  /** Non-fatal observations (dropped invalid models, cap truncation, …). */
  warnings: string[];
  /** Count of surviving workers sharing the hub model's vendor (self-talk
   *  signal — soft, surfaced in audit, NOT a hard reject per ADR 0030 §7). */
  sameVendorAsHub: number;
}

// ── Defaults + settings resolution (pure) ───────────────────────

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  enabled: false,
  maxWorkers: HARD_MAX_WORKERS,
  thinking: "high",
  dualExecSampleRate: 0.2,
};

function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Resolve + clamp the hub settings sub-block. maxWorkers is clamped to
 *  [1, HARD_MAX_WORKERS]; dualExecSampleRate to [0, 1]. */
export function resolveHubSettings(raw: unknown): HubSettings {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const maxWorkers = Math.max(1, Math.min(HARD_MAX_WORKERS, Math.floor(asNum(cfg.maxWorkers, DEFAULT_HUB_SETTINGS.maxWorkers))));
  const rate = Math.max(0, Math.min(1, asNum(cfg.dualExecSampleRate, DEFAULT_HUB_SETTINGS.dualExecSampleRate)));
  return {
    enabled: cfg.enabled === true,
    ...(typeof cfg.model === "string" && cfg.model.trim() ? { model: cfg.model.trim() } : {}),
    maxWorkers,
    thinking: typeof cfg.thinking === "string" && cfg.thinking.trim() ? cfg.thinking.trim() : DEFAULT_HUB_SETTINGS.thinking,
    dualExecSampleRate: rate,
  };
}

// ── Roster + model selection (pure) ─────────────────────────────

function vendorOf(model: string): string {
  return String(model ?? "").split("/")[0]?.trim() || "unknown";
}

/** Flatten modelCurator.providers into a flat "provider/model" allow-set for
 *  plan validation. The settings shape is { provider: [bareModelName, ...] }
 *  (e.g. { deepseek: ["deepseek-v4-pro"] }), so the full id is built as
 *  `${provider}/${bareName}`. Entries that already contain "/" are kept as-is. */
export function flattenRoster(providers: Record<string, readonly string[]> | undefined): string[] {
  if (!providers || typeof providers !== "object") return [];
  const out: string[] = [];
  for (const [provider, list] of Object.entries(providers)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (typeof m !== "string" || !m.trim()) continue;
      out.push(m.includes("/") ? m : `${provider}/${m.trim()}`);
    }
  }
  return Array.from(new Set(out));
}

/** Pick the hub planning model. Priority: explicit setting → first flagship
 *  model whose vendor is NOT in avoidVendors → first flagship → undefined.
 *  ADR 0030 §7: cross-vendor decorrelation is the one hard rule. */
export function selectHubModel(opts: {
  explicit?: string;
  flagshipModels?: readonly string[];
  avoidVendors?: readonly string[];
}): string | undefined {
  const { explicit, flagshipModels = [], avoidVendors = [] } = opts;
  if (explicit && explicit.includes("/")) return explicit;
  const avoid = new Set(avoidVendors.map((v) => v.trim()).filter(Boolean));
  const decorrelated = flagshipModels.find((m) => typeof m === "string" && m.includes("/") && !avoid.has(vendorOf(m)));
  if (decorrelated) return decorrelated;
  return flagshipModels.find((m) => typeof m === "string" && m.includes("/"));
}

// ── Hub planning prompt (pure) ──────────────────────────────────

export function buildHubPlanPrompt(opts: {
  task: string;
  roster: string[];
  maxWorkers: number;
  hubModel: string;
}): string {
  const { task, roster, maxWorkers, hubModel } = opts;
  const hubVendor = vendorOf(hubModel);
  return [
    "You are the L2 dispatch HUB. Decide the worker assignment for the task below.",
    "Output ONLY a single JSON object (no prose, no code fence) of the form:",
    '{"workers":[{"model":"vendor/model","role":"short-role","prompt":"the full prompt for this worker","thinking":"high"}],"rationale":"why this assignment"}',
    "",
    "Rules:",
    `- Choose 1..${maxWorkers} workers. Fewer is better when fewer suffice — do not over-provision.`,
    "- Each worker.model MUST be one of the available models listed below (exact string).",
    "- Prefer DIFFERENT vendors across workers for cross-vendor diversity on judgment-heavy tasks.",
    `- You (the hub) are vendor "${hubVendor}". For independent-review tasks, prefer workers from OTHER vendors so the result is not self-confirming.`,
    "- Write a focused, self-contained prompt for each worker (they share NO context with each other).",
    "- Workers are read-only sub-agents (read/grep/find/ls + optional web/memory). They cannot edit/spawn.",
    "",
    "Available models:",
    ...roster.map((m) => `  - ${m}`),
    "",
    "Task:",
    task,
  ].join("\n");
}

// ── Plan parsing (pure, tolerant) ───────────────────────────────

/** Extract the first balanced {...} JSON object from arbitrary model text. */
export function extractFirstJsonObject(text: string): string | undefined {
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function parseHubPlan(text: string): { ok: true; plan: HubPlan } | { ok: false; error: string } {
  const json = extractFirstJsonObject(text);
  if (!json) return { ok: false, error: "no JSON object found in hub output" };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `hub plan JSON parse failed: ${(e as Error)?.message ?? "unknown"}` };
  }
  const rec = obj as Record<string, unknown>;
  const rawWorkers = Array.isArray(rec.workers) ? rec.workers : undefined;
  if (!rawWorkers) return { ok: false, error: "hub plan missing 'workers' array" };
  const workers: HubWorkerSpec[] = [];
  for (const w of rawWorkers) {
    const wr = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
    const model = typeof wr.model === "string" ? wr.model.trim() : "";
    const role = typeof wr.role === "string" ? wr.role.trim() : "";
    const prompt = typeof wr.prompt === "string" ? wr.prompt : "";
    if (!model || !prompt) continue;
    workers.push({
      model,
      role: role || "worker",
      prompt,
      ...(typeof wr.thinking === "string" && wr.thinking.trim() ? { thinking: wr.thinking.trim() } : {}),
      ...(typeof wr.tools === "string" && wr.tools.trim() ? { tools: wr.tools.trim() } : {}),
    });
  }
  if (workers.length === 0) return { ok: false, error: "hub plan has no usable workers (need model+prompt)" };
  const rationale = typeof rec.rationale === "string" ? rec.rationale : "";
  return { ok: true, plan: { workers, rationale } };
}

// ── Plan validation + cap + cross-vendor flag (pure) ────────────

export function validateHubPlan(plan: HubPlan, opts: {
  roster: string[];
  hubModel: string;
  maxWorkers: number;
}): HubValidation {
  const { roster, hubModel, maxWorkers } = opts;
  const allow = new Set(roster);
  const warnings: string[] = [];
  const cap = Math.max(1, Math.min(HARD_MAX_WORKERS, maxWorkers));

  let valid = plan.workers.filter((w) => {
    if (allow.size > 0 && !allow.has(w.model)) {
      warnings.push(`dropped worker with unknown model "${w.model}" (not in roster)`);
      return false;
    }
    return true;
  });

  if (valid.length > cap) {
    warnings.push(`hub proposed ${valid.length} workers; capped to ${cap} (HARD_MAX_WORKERS=${HARD_MAX_WORKERS})`);
    valid = valid.slice(0, cap);
  }

  const hubVendor = vendorOf(hubModel);
  const sameVendorAsHub = valid.filter((w) => vendorOf(w.model) === hubVendor).length;
  if (sameVendorAsHub > 0) {
    warnings.push(`${sameVendorAsHub}/${valid.length} workers share the hub vendor "${hubVendor}" (self-talk risk, ADR 0030 §7 — flagged, not rejected)`);
  }

  return { workers: valid, warnings, sameVendorAsHub };
}

// ── Audit row builders (pure; additive row_kinds on the dispatch stream) ──

export function buildHubDecisionRow(args: {
  hubModel: string;
  hubThinking: string;
  taskChars: number;
  planText: string;
  workers: HubWorkerSpec[];
  rationale: string;
  warnings: string[];
  sameVendorAsHub: number;
  mainVendor?: string;
  hubDurationMs: number;
  hubResult: "ok" | "fail";
  hubFailureType?: string;
  usage?: { input?: number; output?: number; cost?: number };
}): Record<string, unknown> {
  const hubVendor = vendorOf(args.hubModel);
  return {
    operation: "dispatch_hub.decision",
    row_kind: "hub_decision",
    hub_model: args.hubModel,
    hub_vendor: hubVendor,
    hub_thinking: args.hubThinking,
    ...(args.mainVendor ? { main_session_vendor: args.mainVendor, decorrelated: hubVendor !== args.mainVendor } : {}),
    task_chars: args.taskChars,
    hub_plan_text: args.planText.slice(0, 8000),
    worker_count: args.workers.length,
    worker_models: args.workers.map((w) => w.model),
    worker_roles: args.workers.map((w) => w.role),
    rationale: String(args.rationale ?? "").slice(0, 2000),
    warnings: args.warnings,
    same_vendor_as_hub: args.sameVendorAsHub,
    hub_duration_ms: args.hubDurationMs,
    hub_result: args.hubResult,
    ...(args.hubFailureType ? { hub_failure_type: args.hubFailureType } : {}),
    ...(args.usage ? { hub_tokens_in: args.usage.input, hub_tokens_out: args.usage.output, hub_cost: args.usage.cost } : {}),
  };
}

export function buildHubDispositionRow(args: {
  workerIndex: number;
  workerCount: number;
  model: string;
  role: string;
  promptChars: number;
}): Record<string, unknown> {
  return {
    operation: "dispatch_hub.disposition",
    row_kind: "hub_disposition",
    worker_index: args.workerIndex,
    worker_count: args.workerCount,
    model: args.model,
    vendor: vendorOf(args.model),
    role: args.role,
    worker_prompt_chars: args.promptChars,
  };
}

export function buildHubSummaryRow(args: {
  workerCount: number;
  successCount: number;
  failedCount: number;
  terminalState: string;
  hubCost: number;
  workersCost: number;
  hubDurationMs: number;
  totalWallMs: number;
  dualExecSampled: boolean;
}): Record<string, unknown> {
  return {
    operation: "dispatch_hub.summary",
    row_kind: "hub_summary",
    worker_count: args.workerCount,
    success_count: args.successCount,
    failed_count: args.failedCount,
    terminal_state: args.terminalState,
    hub_cost: args.hubCost,
    workers_cost: args.workersCost,
    total_cost: args.hubCost + args.workersCost,
    hub_duration_ms: args.hubDurationMs,
    total_wall_ms: args.totalWallMs,
    // main_session_disposition is filled post-hoc by the oracle reader from
    // the main session's subsequent behavior; the row carries a placeholder
    // so the schema is stable. (ADR 0030 §5(a).)
    main_session_disposition: "unobserved",
    dual_exec_sampled: args.dualExecSampled,
  };
}

// ── Settings reader (impure; reads the live pi-astack-settings.json) ──

const PI_STACK_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");

/** Read modelCurator roster/flagship + dispatch.hub fresh from the live
 *  settings file (same path the model-curator uses). Fail-open to defaults
 *  so a missing/corrupt settings file never throws into the dispatch path. */
export function readHubConfigFromSettings(): { hub: HubSettings; roster: string[]; flagshipModels: string[] } {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch { /* fail-open to defaults */ }
  const curator = (settings.modelCurator && typeof settings.modelCurator === "object" ? settings.modelCurator : {}) as Record<string, unknown>;
  const dispatch = (settings.dispatch && typeof settings.dispatch === "object" ? settings.dispatch : {}) as Record<string, unknown>;
  const hub = resolveHubSettings(dispatch.hub);
  const roster = flattenRoster(curator.providers as Record<string, readonly string[]> | undefined);
  const tiers = (curator.tiers && typeof curator.tiers === "object" ? curator.tiers : {}) as Record<string, { models?: readonly string[] }>;
  const flagshipModels = Array.isArray(tiers.flagship?.models)
    ? (tiers.flagship!.models as readonly unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  return { hub, roster, flagshipModels };
}

// ── Orchestration shell (registerHubTool) ───────────────────────

export interface HubDeps {
  runInProcess: (
    model: string, thinking: string, prompt: string, signal: AbortSignal,
    timeoutMs: number, modelRegistry: unknown, toolAllowlist?: string,
    heartbeatCtx?: {
      anchor?: CausalAnchor;
      projectRoot?: string;
      maxRuntimeMs?: number;
      onProgress?: (progress: { reason: string; at: number; heartbeatTracePath?: string }) => void;
    },
  ) => Promise<{
    output: string; error?: string; failureType?: string; durationMs: number;
    heartbeat_liveness?: { msSinceLastBeat?: number };
    usage?: { input: number; output: number; cost: number };
  }>;
  appendDispatchAudit: (projectRoot: string, anchor: CausalAnchor | undefined, event: Record<string, unknown>) => Promise<void>;
  providerFromModel: (model: string) => string;
  validateTools: (tools: string | undefined) => { ok: boolean; reason?: string };
  progress: {
    taskFromSpec: (task: Record<string, unknown>, fallback: string) => DispatchProgressTask;
    updateFromResult: (task: DispatchProgressTask, result: any) => void;
    markProgress: (task: DispatchProgressTask, reason: string, at: number) => void;
    startTicker: (onUpdate: unknown, snapshot: DispatchProgressSnapshot) => () => void;
    emit: (onUpdate: unknown, snapshot: DispatchProgressSnapshot, isError?: boolean) => void;
    details: (snapshot: DispatchProgressSnapshot) => { dispatchProgress: DispatchProgressSnapshot };
  };
  renderCall?: HubToolRenderer;
  renderResult?: HubToolRenderer;
  defaultTimeoutMs: number;
  maxProviderConcurrency: number;
  /** Read settings.modelCurator + settings.dispatch.hub fresh per call. */
  readConfig: () => { hub: HubSettings; roster: string[]; flagshipModels: string[] };
}

const WORKER_TOOLS = "read,grep,find,ls,web_search,web_fetch,memory_search,memory_get,memory_decide";
const HUB_TOOLS = "read,grep,find,ls,memory_search,memory_get";

/** Register dispatch_hub IFF settings.dispatch.hub.enabled === true.
 *  Default-off → the tool surface is absent (ADR 0030 §4 kill-switch). */
export function registerHubTool(pi: { registerTool: (def: unknown) => void }, deps: HubDeps): boolean {
  const { hub } = deps.readConfig();
  if (!hub.enabled) return false;

  pi.registerTool({
    name: "dispatch_hub",
    label: "Dispatch Hub",
    description:
      "ADR 0030 caged-live dynamic hub: a cross-vendor hub LLM proposes a worker " +
      "assignment for the task, then dispatch_hub REALLY dispatches those workers " +
      "(read-only, single-level) and returns the aggregate. Use for judgment-heavy " +
      "tasks where you want the hub to decide the worker mix. Cost is report-only. " +
      `Worker count is hard-capped at ${HARD_MAX_WORKERS}.`,
    promptSnippet: "dispatch_hub({ task, hubModel? }) — you pick a hub model per-task; it plans cross-vendor workers and dispatches them",
    promptGuidelines: [
      "Pass a clear, self-contained task description. The hub LLM decides how many workers, which models, and what each does, then really dispatches them.",
      "ADR 0030 §7: YOU (the main session) choose the hub model per-task via `hubModel`. Pick a model from a DIFFERENT vendor than yourself so the hub is an independent second voice (not self-talk). Omit hubModel to auto-pick a flagship model.",
      "The hub is read-only and single-level; results return in-turn. After it returns, your acceptance/revision of the result is the disposition signal (ADR 0030 §5).",
    ],
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task for the hub to plan a worker assignment for." },
        hubModel: { type: "string", description: "Which model acts as the hub/planner for THIS task (provider/model). Choose per-task, cross-vendor from yourself to avoid self-talk. Omit to auto-pick a flagship model." },
        timeoutMs: { type: "number", description: "Per-worker no-progress idle timeout in ms (default 1800000)." },
      },
      required: ["task"],
    },
    ...(deps.renderCall ? { renderCall: deps.renderCall } : {}),
    ...(deps.renderResult ? { renderResult: deps.renderResult } : {}),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: Record<string, unknown>) {
      const task = typeof params.task === "string" ? params.task : "";
      if (!task.trim()) {
        return { content: [{ type: "text" as const, text: "dispatch_hub: 'task' is required." }], details: { kind: "dispatch_hub_no_task" }, isError: true };
      }
      const { hub: hubCfg, roster, flagshipModels } = deps.readConfig();
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : deps.defaultTimeoutMs;
      const projectRoot = (typeof ctx.cwd === "string" ? ctx.cwd : "") || process.cwd();
      const modelRegistry = ctx.modelRegistry;
      const parentAnchor = getCurrentAnchor();

      // ADR 0030 §7: the main session picks the hub model per-task (params.hubModel).
      // Priority: per-call choice → optional settings default → auto-pick flagship.
      // NOT a fixed settings pin — hub model is chosen freely by the main session.
      const requestedHubModel = typeof params.hubModel === "string" ? params.hubModel.trim() : "";
      const hubModel = selectHubModel({ explicit: requestedHubModel || hubCfg.model, flagshipModels });
      if (!hubModel) {
        return { content: [{ type: "text" as const, text: "dispatch_hub: no flagship model available to act as hub (configure modelCurator.tiers.flagship or dispatch.hub.model)." }], details: { kind: "dispatch_hub_no_model" }, isError: true };
      }

      const progress = deps.progress;
      const hubProgressTask = progress.taskFromSpec({ name: "hub planner", model: hubModel, thinking: hubCfg.thinking }, "hub planner");
      const progressSnapshot: DispatchProgressSnapshot = {
        title: "hub",
        state: "running",
        startedAt: Date.now(),
        counts: { running: 1, failed: 0, success: 0, total: 1 },
        countsLabel: "steps",
        tasks: [hubProgressTask],
      };
      hubProgressTask.state = "running";
      hubProgressTask.startedAt = progressSnapshot.startedAt;
      progress.markProgress(hubProgressTask, "hub_planning_started", progressSnapshot.startedAt);
      let progressTickerStopped = false;
      let stopProgressTicker = progress.startTicker(onUpdate, progressSnapshot);
      const stopProgressTickerOnce = () => {
        if (progressTickerStopped) return;
        progressTickerStopped = true;
        stopProgressTicker();
      };
      const finishProgress = (state: DispatchState, counts: DispatchCounts, durationMs?: number, isError?: boolean) => {
        progressSnapshot.state = state;
        progressSnapshot.counts = counts;
        progressSnapshot.durationMs = durationMs ?? Math.max(0, Date.now() - progressSnapshot.startedAt);
        stopProgressTickerOnce();
        progress.emit(onUpdate, progressSnapshot, isError);
      };

      // Unique id for THIS hub run, stamped on EVERY audit row. The oracle
      // groups runs by hub_run_id because (session_id, turn_id) is NOT unique
      // per run — multiple dispatch_hub calls share one turn, and a single run's
      // rows span subturns 0..N (summary=0, decision=S, workers=S+1..). The first
      // dogfood batch surfaced the oracle silently merging same-(session,turn)
      // runs (later hub_decision overwrote earlier); hub_run_id fixes that.
      const hubRunId = randomUUID();
      const emit = (anchor: CausalAnchor | undefined, event: Record<string, unknown>) =>
        deps.appendDispatchAudit(projectRoot, anchor, { ...event, hub_run_id: hubRunId });

      // ── Hub planning call ──
      const planPrompt = buildHubPlanPrompt({ task, roster, maxWorkers: hubCfg.maxWorkers, hubModel });
      const hubAnchor = deriveSubAgentAnchor(parentAnchor, "dispatch_hub.plan");
      const summaryAnchor = parentAnchor ? { ...parentAnchor, subturn: 0, sub_agent_label: "dispatch_hub.summary" } : undefined;

      // Planning-failure degrade path (C5 fail-degrade): emit hub_decision(fail)
      // + a 0-worker hub_summary so failed invocations still leave a joinable
      // trace, then return a graceful error — never crash the tool, never execute
      // an errored plan. Shared by all three failure routes below.
      const failPlanning = (reason: string, failureType: string, planText: string, usage?: { input: number; output: number; cost: number }, durMs = 0) => {
        void emit(hubAnchor, buildHubDecisionRow({
          hubModel, hubThinking: hubCfg.thinking, taskChars: task.length, planText,
          workers: [], rationale: "", warnings: [reason], sameVendorAsHub: 0,
          hubDurationMs: durMs, hubResult: "fail", hubFailureType: failureType,
          ...(usage ? { usage } : {}),
        }));
        void emit(summaryAnchor, buildHubSummaryRow({
          workerCount: 0, successCount: 0, failedCount: 0, terminalState: "failed",
          hubCost: usage?.cost ?? 0, workersCost: 0, hubDurationMs: durMs, totalWallMs: durMs, dualExecSampled: false,
        }));
        progress.updateFromResult(hubProgressTask, { output: planText, error: reason, failureType, durationMs: durMs });
        finishProgress("failed", { running: 0, failed: 1, success: 0, total: 1 }, durMs, true);
        return {
          content: [{ type: "text" as const, text: `❌ dispatch_hub: ${reason}. Fall back to dispatch_parallel with an explicit assignment.` }],
          details: {
            kind: "dispatch_hub_plan_failed",
            ...progress.details(progressSnapshot),
            error: reason,
            failure_type: failureType,
            hub_model: hubModel,
          },
          isError: true,
        };
      };

      const hubStart = Date.now();
      // MAJOR fix (cross-vendor audit): the planning call MUST be try/catch'd —
      // runInProcess can REJECT (getSharedInfra failure / undefined modelRegistry);
      // an unguarded reject would crash the whole tool + skip the audit (C5 breach).
      let hubRes: { output: string; error?: string; failureType?: string; durationMs: number; usage?: { input: number; output: number; cost: number } };
      try {
        hubRes = await runWithTriggerAnchor(hubAnchor, () =>
          deps.runInProcess(
            hubModel, hubCfg.thinking,
            hubAnchor ? `${formatAnchorPromptBlock(hubAnchor)}\n\n${planPrompt}` : planPrompt,
            signal, timeoutMs, modelRegistry, HUB_TOOLS,
            {
              anchor: hubAnchor,
              projectRoot,
              onProgress: (p: { reason: string; at: number }) => progress.markProgress(hubProgressTask, p.reason, p.at),
            },
          ),
        );
      } catch (err) {
        return failPlanning(`hub planning call threw: ${(err as Error)?.message ?? String(err)}`, "hub_call_threw", "", undefined, Date.now() - hubStart);
      }
      const hubDurationMs = Date.now() - hubStart;

      // CRITICAL fix (cross-vendor audit): an errored/timed-out hub call must NOT
      // be executed even if its partial output happens to parse as JSON — check
      // hubRes.error BEFORE parsing/executing.
      if (hubRes.error) {
        return failPlanning(`hub planning errored: ${hubRes.error}`, hubRes.failureType ?? "hub_call_error", hubRes.output ?? "", hubRes.usage, hubDurationMs);
      }

      const parsed = parseHubPlan(hubRes.output ?? "");
      if (!parsed.ok) {
        return failPlanning(`plan parse failed: ${parsed.error}`, hubRes.failureType ?? "plan_parse_error", hubRes.output ?? "", hubRes.usage, hubDurationMs);
      }
      progress.updateFromResult(hubProgressTask, hubRes);

      const v = validateHubPlan(parsed.plan, { roster, hubModel, maxWorkers: hubCfg.maxWorkers });
      void emit(hubAnchor, buildHubDecisionRow({
        hubModel, hubThinking: hubCfg.thinking, taskChars: task.length, planText: hubRes.output ?? "",
        workers: v.workers, rationale: parsed.plan.rationale, warnings: v.warnings, sameVendorAsHub: v.sameVendorAsHub,
        hubDurationMs, hubResult: "ok", ...(hubRes.usage ? { usage: hubRes.usage } : {}),
      }));

      if (v.workers.length === 0) {
        void emit(summaryAnchor, buildHubSummaryRow({
          workerCount: 0, successCount: 0, failedCount: 0, terminalState: "failed",
          hubCost: hubRes.usage?.cost ?? 0, workersCost: 0, hubDurationMs, totalWallMs: hubDurationMs, dualExecSampled: false,
        }));
        finishProgress("failed", { running: 0, failed: 1, success: 0, total: 1 }, hubDurationMs, true);
        return {
          content: [{ type: "text" as const, text: `❌ dispatch_hub: no valid workers after validation. ${v.warnings.join("; ")}` }],
          details: { kind: "dispatch_hub_no_valid_workers", ...progress.details(progressSnapshot), warnings: v.warnings, hub_model: hubModel },
          isError: true,
        };
      }

      // ── Worker fan-out (claim loop, per-provider cap) ──
      const tasks = v.workers;
      const total = tasks.length;
      const workerProgressTasks = tasks.map((t, i) => progress.taskFromSpec({ name: t.role, role: t.role, model: t.model, thinking: t.thinking ?? "high", prompt: t.prompt }, `worker ${i + 1}`));
      progressSnapshot.tasks = [hubProgressTask, ...workerProgressTasks];
      progressSnapshot.counts = { running: 0, failed: 0, success: 0, total };
      progressSnapshot.countsLabel = "workers";
      progress.emit(onUpdate, progressSnapshot);
      const results: Array<{ output: string; error?: string; failureType?: string; durationMs: number; usage?: { input: number; output: number; cost: number } } | null> = new Array(total).fill(null);
      const activeByProvider = new Map<string, number>();
      const claimed = new Set<number>();
      const claimNext = (): number | undefined => {
        for (let i = 0; i < total; i++) {
          if (claimed.has(i)) continue;
          const p = deps.providerFromModel(tasks[i].model);
          if ((activeByProvider.get(p) ?? 0) >= deps.maxProviderConcurrency) continue;
          claimed.add(i);
          activeByProvider.set(p, (activeByProvider.get(p) ?? 0) + 1);
          return i;
        }
        return undefined;
      };
      const release = (i: number) => {
        const p = deps.providerFromModel(tasks[i].model);
        const n = Math.max(0, (activeByProvider.get(p) ?? 0) - 1);
        if (n === 0) activeByProvider.delete(p); else activeByProvider.set(p, n);
      };

      let running = 0, success = 0, failed = 0;
      const updateStatus = () => {
        const counts = { running, failed, success, total };
        progressSnapshot.state = "running";
        progressSnapshot.counts = counts;
      };

      updateStatus();
      const worker = async () => {
        while (true) {
          if (signal.aborted) return;
          const i = claimNext();
          if (i === undefined) return;
          const progressTask = workerProgressTasks[i];
          if (progressTask) {
            const startedAt = Date.now();
            progressTask.state = "running";
            progressTask.startedAt = startedAt;
            progress.markProgress(progressTask, "worker_started", startedAt);
          }
          running++;
          updateStatus();
          try {
            const t = tasks[i];
            const subAnchor = deriveSubAgentAnchor(parentAnchor, `dispatch_hub[${i}]`);
            void emit(subAnchor, buildHubDispositionRow({
              workerIndex: i, workerCount: total, model: t.model, role: t.role, promptChars: t.prompt.length,
            }));
            let res: { output: string; error?: string; failureType?: string; durationMs: number; usage?: { input: number; output: number; cost: number } };
            const toolCheck = deps.validateTools(t.tools ?? WORKER_TOOLS);
            if (!toolCheck.ok) {
              res = { output: "", error: `worker[${i}] tool rejected: ${toolCheck.reason}`, failureType: "tool_rejected", durationMs: 0 };
            } else {
              try {
                res = await runWithTriggerAnchor(subAnchor, () =>
                  deps.runInProcess(
                    t.model, t.thinking ?? "high",
                    subAnchor ? `${formatAnchorPromptBlock(subAnchor)}\n\n${t.prompt}` : t.prompt,
                    signal, timeoutMs, modelRegistry, t.tools ?? WORKER_TOOLS,
                    {
                      anchor: subAnchor,
                      projectRoot,
                      ...(progressTask
                        ? { onProgress: (p: { reason: string; at: number }) => progress.markProgress(progressTask, p.reason, p.at) }
                        : {}),
                    },
                  ),
                );
              } catch (err) {
                res = { output: "", error: `worker crashed: ${(err as Error)?.message ?? String(err)}`, failureType: "crash", durationMs: 0 };
              }
            }
            if (progressTask) {
              progress.updateFromResult(progressTask, res);
            }
            results[i] = res;
            running--;
            if (res.error) failed++; else success++;
            updateStatus();
            // MAJOR fix: emit the dispatch_hub.task terminal row for EVERY claimed
            // worker, INCLUDING tool-rejected (previously skipped via early continue
            // → that worker had a disposition row but no terminal row).
            void emit(subAnchor, {
              operation: "dispatch_hub.task",
              row_kind: "task",
              task_index: i,
              task_count: total,
              model: t.model,
              thinking: t.thinking ?? "high",
              role: t.role,
              prompt_chars: t.prompt.length,
              duration_ms: res.durationMs,
              result: res.error ? "fail" : "ok",
              ...(res.failureType ? { failure_type: res.failureType } : {}),
              output_chars: res.output?.length ?? 0,
              ...(res.usage ? { tokens_in: res.usage.input, tokens_out: res.usage.output, cost: res.usage.cost } : {}),
            });
          } finally {
            // MINOR fix (1.A): release ALWAYS runs, even on a synchronous throw
            // between claim and dispatch — no provider-slot leak / pool starvation.
            release(i);
          }
        }
      };
      const concurrency = Math.min(total, Math.max(1, deps.maxProviderConcurrency * Math.max(1, new Set(tasks.map((t) => deps.providerFromModel(t.model))).size)));
      await Promise.allSettled(new Array(concurrency).fill(null).map(() => worker()));
      const totalWallMs = Date.now() - progressSnapshot.startedAt;

      const dense = results.map((r) => r ?? { output: "", error: "worker did not start", failureType: "aborted", durationMs: 0 });
      const successCount = dense.filter((r) => !r.error).length;
      const failedCount = dense.filter((r) => !!r.error).length;
      const terminalState = failedCount === 0 ? "completed" : successCount === 0 ? "failed" : "degraded";
      const finalCounts = { running: 0, failed: failedCount, success: successCount, total };
      for (let i = 0; i < dense.length; i++) {
        const task = workerProgressTasks[i];
        if (task && !task.endedAt) progress.updateFromResult(task, dense[i]);
      }
      finishProgress(terminalState, finalCounts, totalWallMs, failedCount === total);
      const workersCost = dense.reduce((s, r) => s + (r.usage?.cost ?? 0), 0);
      const hubCost = hubRes.usage?.cost ?? 0;

      void emit(
        summaryAnchor,
        buildHubSummaryRow({
          workerCount: total, successCount, failedCount, terminalState,
          hubCost, workersCost, hubDurationMs, totalWallMs, dualExecSampled: false,
        }),
      );

      // ── Render aggregate for the main session ──
      const lines: string[] = [];
      lines.push(`🧭 dispatch_hub — hub=${hubModel} chose ${total} worker(s): ${tasks.map((t) => `${t.role}(${t.model})`).join(", ")}`);
      if (parsed.plan.rationale) lines.push(`rationale: ${parsed.plan.rationale}`);
      if (v.warnings.length) lines.push(`⚠ ${v.warnings.join(" | ")}`);
      lines.push(`cost: hub $${hubCost.toFixed(4)} + workers $${workersCost.toFixed(4)} = $${(hubCost + workersCost).toFixed(4)} (report-only) · ${terminalState} · ${(totalWallMs / 1000).toFixed(1)}s`);
      lines.push("");
      dense.forEach((r, i) => {
        const t = tasks[i];
        lines.push(`### [${i}] ${t.role} — ${t.model} ${r.error ? "❌" : "✅"}`);
        lines.push(r.error ? r.error : (r.output || "(empty)"));
        lines.push("");
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          kind: "dispatch_hub",
          ...progress.details(progressSnapshot),
          hub_model: hubModel,
          worker_count: total,
          success_count: successCount,
          failed_count: failedCount,
          terminal_state: terminalState,
          total_cost: hubCost + workersCost,
          same_vendor_as_hub: v.sameVendorAsHub,
          warnings: v.warnings,
        },
        ...(failedCount === total ? { isError: true } : {}),
      };
    },
  });
  return true;
}
