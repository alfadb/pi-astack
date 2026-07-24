/**
 * workflow extension — ADR 0033 PR-12.
 *
 * Natural-language-first surface:
 *   - LLM tools are the primary invocation path (tell-not-ask, zero
 *     confirmation modals): workflow_validate / workflow_list / workflow_run.
 *   - Slash command remains a debugging/direct path and calls the same
 *     helpers so semantics cannot drift.
 *
 * ADR 0033 revisions over ADR 0032:
 *   - No --yes gate. workflow_run performs deterministic validation as an
 *     internal machine gate; validation failure returns structured error and
 *     does not call the runner (N3).
 *   - workflow_run may be called from foreground main-session turns,
 *     including goal continuation turns. Only authority-creating goal tools
 *     are rejected in machine turns (PR-13).
 *   - workflow_run remains in dispatch's structural disabled set, so a stage
 *     cannot launch an indirect workflow. Read-only workflow tool names are
 *     otherwise subject to the target sub-agent registry like other tools.
 */

import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatDryRunReport,
  formatEffectiveStageLines,
  parseWorkflowJson,
  parseWorkflowRunArgs,
  validateWorkflow,
  WORKFLOW_MAX_CONCURRENCY,
  type WorkflowDoc,
  type WorkflowValidationResult,
} from "./dsl";
import { executeWorkflow, type StageRunner, type WorkflowRunResult } from "./executor";
import {
  runInProcess,
  validateTools,
  enforceMutatingEnvGate,
  dispatchReasoningTraceFields,
  resolveParentContextFilesSnapshot,
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY as DISPATCH_MAX_CONCURRENCY,
  type AgentResult,
} from "../dispatch/index";
import {
  abrainProjectWorkflowsDir,
  abrainWorkflowsDir,
  resolveActiveProject,
} from "../_shared/runtime";
import {
  deriveSubAgentAnchor,
  formatAnchorPromptBlock,
  getCurrentAnchor,
  runWithTriggerAnchor,
  spreadAnchor,
} from "../_shared/causal-anchor";

const PI_STACK_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");

interface WorkflowSettings {
  enabled: boolean;
  readOnly: boolean;
  defaultModel: string;
  defaultThinking: string;
}

const DEFAULTS: WorkflowSettings = {
  enabled: false,
  readOnly: true,
  // Single source of truth remains pi-astack-settings.json. Empty default
  // means stages must specify model explicitly or runInProcess fails closed.
  defaultModel: "",
  defaultThinking: "medium",
};

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

export function resolveWorkflowSettings(): WorkflowSettings {
  let cfg: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    if (raw && typeof raw.workflow === "object" && raw.workflow !== null) cfg = raw.workflow as Record<string, unknown>;
  } catch { /* defaults */ }
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    readOnly: typeof cfg.readOnly === "boolean" ? cfg.readOnly : DEFAULTS.readOnly,
    defaultModel: typeof cfg.defaultModel === "string" && cfg.defaultModel.includes("/") ? cfg.defaultModel : DEFAULTS.defaultModel,
    defaultThinking: typeof cfg.defaultThinking === "string" ? cfg.defaultThinking : DEFAULTS.defaultThinking,
  };
}

export interface LoadedWorkflow {
  doc?: WorkflowDoc;
  validation?: WorkflowValidationResult;
  fp?: string;
  error?: string;
}

function expandWorkflowPath(fileArgRaw: string, cwd: string): { fp?: string; error?: string } {
  const trimmedArg = fileArgRaw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmedArg);
  const fileArgRaw2 = quoted ? quoted[2] : trimmedArg;
  if (!fileArgRaw2.trim()) return { error: "empty file argument" };

  // Reject ~ paths: they expand outside cwd by design and are not allowed
  // for workflow files (ADR 0027 C6 containment).
  if (fileArgRaw2 === "~" || fileArgRaw2.startsWith("~/")) {
    return { error: `~ paths are not allowed for workflow files; use a path relative to the project root (cwd: ${path.resolve(cwd)})` };
  }

  const resolvedCwd = path.resolve(cwd);
  const resolvedFp = path.isAbsolute(fileArgRaw2)
    ? path.resolve(fileArgRaw2)
    : path.resolve(cwd, fileArgRaw2);

  // Containment check: the resolved path must be within cwd.
  // path.relative returns a path that starts with ".." (or is absolute on
  // Windows) when the target is outside the base directory.
  const rel = path.relative(resolvedCwd, resolvedFp);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: `workflow file path must be within the current working directory (cwd: ${resolvedCwd}), got: ${resolvedFp}` };
  }

  // Symlink containment (ADR 0027 C6): if the path already exists, its
  // realpath must be within cwd's realpath AND it must be a regular file.
  // Non-existent files skip this check so loadWorkflowFile can produce the
  // standard "cannot read" error.
  try {
    const st = fsSync.statSync(resolvedFp);
    // Always check realpath containment for any existing path — a symlink
    // to a directory/device/FIFO outside cwd must not bypass the guard.
    const realFp = fsSync.realpathSync(resolvedFp);
    const realCwd = fsSync.realpathSync(resolvedCwd);
    const realRel = path.relative(realCwd, realFp);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      return { error: `workflow file realpath is outside cwd (symlink escape): ${realFp} not within ${realCwd}` };
    }
    if (!st.isFile()) {
      return { error: `workflow file must be a regular file: ${resolvedFp}` };
    }
  } catch (e: unknown) {
    // ENOENT → file doesn't exist; let loadWorkflowFile produce the
    // "cannot read" error.  Other stat errors (permission, etc.) are
    // surfaced here because readFileSync would fail the same way.
    if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT")) {
      return { error: `cannot access ${resolvedFp}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
    }
  }

  return { fp: resolvedFp };
}

/** Read + parse + validate a workflow file from disk (persisted artifact). */
export function loadWorkflowFile(fileArgRaw: string, cwd: string, readOnly: boolean): LoadedWorkflow {
  const expanded = expandWorkflowPath(fileArgRaw, cwd);
  if (expanded.error || !expanded.fp) return { error: expanded.error ?? "path expansion failed" };
  const fp = expanded.fp;
  let raw: string;
  try {
    raw = fsSync.readFileSync(fp, "utf-8");
  } catch (e: unknown) {
    return { error: `cannot read ${fp}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
  const parsed = parseWorkflowJson(raw);
  if (!parsed.doc) return { fp, error: `✗ workflow validation FAILED\n  - ${parsed.error}` };
  const validation = validateWorkflow(parsed.doc, { readOnly });
  return { doc: parsed.doc, validation, fp };
}

export interface WorkflowListEntry {
  namespace: "project" | "abrain";
  name: string;
  path: string;
  runnable: boolean;
  kind: "json-asset" | "markdown-convention";
}

function listFiles(dir: string, suffixes: string[]): string[] {
  try {
    return fsSync.readdirSync(dir)
      .filter((n) => suffixes.some((s) => n.endsWith(s)))
      .map((n) => path.join(dir, n));
  } catch { return []; }
}

export function listWorkflowEntries(cwd: string): WorkflowListEntry[] {
  const entries: WorkflowListEntry[] = [];
  const abrainHome = path.join(os.homedir(), ".abrain");
  const active = resolveActiveProject(cwd, { abrainHome }).activeProject;
  // gpt R1 NIT: use strict-bound projectRoot when available so calling
  // from a subdirectory still sees <project>/workflows/*.json.
  const projectRoot = active?.projectRoot ?? cwd;
  const projectDir = path.join(projectRoot, "workflows");
  for (const fp of listFiles(projectDir, [".json"])) {
    entries.push({ namespace: "project", name: path.basename(fp, ".json"), path: fp, runnable: true, kind: "json-asset" });
  }
  const abrainDirs = [abrainWorkflowsDir(abrainHome)];
  if (active) abrainDirs.push(abrainProjectWorkflowsDir(abrainHome, active.projectId));
  // gpt R1 NIT: dedupe after path.resolve to avoid duplicate listing if
  // abnormal config/symlinks collapse global/project workflow dirs.
  for (const abrainDir of [...new Set(abrainDirs.map((d) => path.resolve(d)))]) for (const fp of listFiles(abrainDir, [".json", ".md"])) {
    const isJson = fp.endsWith(".json");
    entries.push({
      namespace: "abrain",
      name: path.basename(fp, path.extname(fp)),
      path: fp,
      runnable: isJson,
      kind: isJson ? "json-asset" : "markdown-convention",
    });
  }
  return entries.sort((a, b) => `${a.namespace}:${a.name}:${a.path}`.localeCompare(`${b.namespace}:${b.name}:${b.path}`));
}

function workflowRoot(cwd: string): string {
  return path.join(cwd, ".pi-astack", "workflow");
}

function appendWorkflowAudit(cwd: string, row: Record<string, unknown>): void {
  try {
    const auditPath = path.join(workflowRoot(cwd), "audit.jsonl");
    fsSync.mkdirSync(path.dirname(auditPath), { recursive: true });
    fsSync.appendFileSync(auditPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ...spreadAnchor(getCurrentAnchor()),
      ...row,
    })}\n`, "utf-8");
  } catch { /* best-effort: audit failure never breaks the run */ }
}

function makeProductionRunner(modelRegistry: unknown, projectRoot: string): StageRunner {
  return async (req) => {
    const toolCheck = validateTools(req.tools);
    if (!toolCheck.ok) {
      return { output: "", error: `tool_rejected: ${toolCheck.reason}`, failureType: "tool_rejected", durationMs: 0 };
    }
    // ADR 0033 W9 triple-explicit (workflow-only): mutating tools require the
    // PI_MULTI_AGENT_ALLOW_MUTATING env gate. Enforced HERE, not in the shared
    // validateTools — the dispatch swarm intentionally dropped this gate
    // (2026-06-16), but the workflow channel keeps it as a deliberate
    // deployment-form gate (dropping it is an ADR 0033 promotion tripwire).
    const mutCheck = enforceMutatingEnvGate(req.tools);
    if (!mutCheck.ok) {
      return { output: "", error: `tool_rejected: ${mutCheck.reason}`, failureType: "tool_rejected", durationMs: 0 };
    }
    // Resolve parent contextFiles from the main-session (session, turn) that
    // launched workflow_run. Same snapshot contract as dispatch_agent: missing
    // rejects inside runInProcess; empty array is legal; no disk re-scan.
    const parentAnchor = getCurrentAnchor();
    const parentContextFiles = resolveParentContextFilesSnapshot(parentAnchor);
    const anchor = deriveSubAgentAnchor(parentAnchor, req.anchorLabel);
    const prompt = anchor ? `${formatAnchorPromptBlock(anchor)}\n\n${req.prompt}` : req.prompt;
    const result: AgentResult = await runWithTriggerAnchor(anchor, () =>
      runInProcess(
        req.model, req.thinking, prompt,
        req.signal ?? new AbortController().signal,
        req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        modelRegistry,
        req.tools,
        {
          anchor,
          projectRoot,
          maxRuntimeMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          taskProfile: req.taskProfile,
          parentContextFiles,
          reasoningTrace: {
            workflowRunId: req.workflowRunId,
            workflowStageId: req.stageId,
          },
        },
      ),
    );
    return {
      output: result.output,
      ...(result.error ? { error: result.error } : {}),
      ...(result.failureType ? { failureType: result.failureType } : {}),
      durationMs: result.durationMs,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(typeof result.toolCallCount === "number" ? { toolCallCount: result.toolCallCount } : {}),
      ...(result.workerRunGovernance ? { workerRunGovernance: result.workerRunGovernance } : {}),
      ...dispatchReasoningTraceFields(result),
    };
  };
}

function runIdFor(doc: WorkflowDoc): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${doc.name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40)}-${randomUUID().slice(0, 8)}`;
}

function successContent(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
function errorContent(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details, ...{ isError: true } };
}

export async function runWorkflowCore(args: {
  file: string;
  cwd: string;
  modelRegistry: unknown;
  signal?: AbortSignal;
  notify?: (msg: string, type?: string) => void;
}): Promise<{ ok: true; report: string; result: WorkflowRunResult; doc: WorkflowDoc; statePath: string } | { ok: false; error: string; details: Record<string, unknown>; report?: string }> {
  const settings = resolveWorkflowSettings();
  if (!settings.enabled) {
    return { ok: false, error: "workflow.enabled=false", details: { kind: "workflow_disabled" } };
  }
  const loaded = loadWorkflowFile(args.file, args.cwd, settings.readOnly);
  if (loaded.error || !loaded.doc || !loaded.validation) {
    return { ok: false, error: loaded.error ?? "load failed", details: { kind: "load_failed", file: args.file } };
  }
  const report = formatDryRunReport(loaded.validation, { readOnly: settings.readOnly, enabled: settings.enabled });
  if (!loaded.validation.ok) {
    return { ok: false, error: "workflow validation failed", details: { kind: "validation_failed", errors: loaded.validation.errors }, report };
  }
  const doc = loaded.doc;
  const effective = formatEffectiveStageLines(doc, { model: settings.defaultModel, thinking: settings.defaultThinking });
  const runId = runIdFor(doc);
  const runDir = path.join(workflowRoot(args.cwd), runId);
  const safeNotify = (msg: string, type?: string) => { try { args.notify?.(msg, type); } catch { /* notify must never break execution */ } };
  safeNotify(`workflow "${doc.name}" starting — run ${runId}\n${effective.join("\n")}`, "info");
  let result: WorkflowRunResult;
  try {
    result = await executeWorkflow({
      doc,
      runId,
      runDir,
      runner: makeProductionRunner(args.modelRegistry, args.cwd),
      maxConcurrency: Math.min(WORKFLOW_MAX_CONCURRENCY, DISPATCH_MAX_CONCURRENCY),
      perStageTimeoutMs: DEFAULT_TIMEOUT_MS,
      signal: args.signal,
      readOnly: settings.readOnly,
      defaultModel: settings.defaultModel,
      defaultThinking: settings.defaultThinking,
      notify: (msg) => safeNotify(msg, "info"),
      audit: (row) => appendWorkflowAudit(args.cwd, row),
    });
  } catch (e: unknown) {
    // ADR 0033 §2.1: failures are structured tool errors, never bare
    // exceptions. Covers startup infra errors in executeWorkflow
    // (mkdir/state/audit/runner construction etc.).
    return {
      ok: false,
      error: `workflow execution failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
      details: { kind: "execution_failed", runId, file: args.file },
      report,
    };
  }
  return { ok: true, report, result, doc, statePath: result.statePath };
}

function formatRunSummary(doc: WorkflowDoc, result: WorkflowRunResult): string {
  const icon = result.status === "completed" ? "✓" : result.status === "degraded" ? "⚠" : "✗";
  const stageLines = Object.values(result.stages)
    .filter((r) => !r.parent)
    .map((r) => `  ${r.id}: ${r.status}${r.error ? ` (${r.error.slice(0, 80)})` : ""}`);
  const degradedLine = result.degraded.length > 0
    ? `\n  ⚠ degraded stages: ${result.degraded.join(", ")} (partial results + failure notes in their output files)`
    : "";
  const costLine = result.totalCost > 0 ? ` ($${result.totalCost.toFixed(4)})` : "";
  return `${icon} workflow "${doc.name}" ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s${costLine}\n` +
    `${stageLines.join("\n")}${degradedLine}\n  trace: ${result.statePath}`;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_WORKFLOW === "1") return;

  // ── LLM tools (ADR 0033 primary surface) ──────────────────────

  pi.registerTool({
    name: "workflow_validate",
    label: "Workflow Validate",
    description: "Validate a persisted workflow JSON file deterministically and return the dry-run report. Read-only.",
    promptSnippet: "workflow_validate(file) — validate a workflow JSON file",
    promptGuidelines: ["Use before explaining why a workflow cannot run, or when the user asks to inspect/check a workflow."],
    parameters: Type.Object({ file: Type.String({ description: "Workflow JSON path (relative to cwd, absolute, or ~/...)" }) }),
    prepareArguments(rawArgs: unknown) {
      const a = asRecord(rawArgs);
      return { file: typeof a.file === "string" ? a.file : String(a.file ?? "") };
    },
    async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const settings = resolveWorkflowSettings();
      const cwd = ctx.cwd ?? process.cwd();
      const loaded = loadWorkflowFile(params.file, cwd, settings.readOnly);
      if (loaded.error || !loaded.doc || !loaded.validation) {
        return errorContent(`✗ workflow_validate: ${loaded.error ?? "load failed"}`, { kind: "load_failed", file: params.file });
      }
      const report = formatDryRunReport(loaded.validation, { readOnly: settings.readOnly, enabled: settings.enabled });
      return {
        content: [{ type: "text" as const, text: report }],
        details: {
          kind: "workflow_validation_result",
          ok: loaded.validation.ok,
          file: loaded.fp,
          errors: loaded.validation.errors,
          warnings: loaded.validation.warnings,
          summary: loaded.validation.summary,
        },
        ...(loaded.validation.ok ? {} : { isError: true }),
      };
    },
  });

  pi.registerTool({
    name: "workflow_list",
    label: "Workflow List",
    description: "List project workflow JSON assets and abrain workflow zone entries. Read-only.",
    promptSnippet: "workflow_list() — list available workflows",
    promptGuidelines: ["Use when the user asks what workflows exist or when choosing a reusable workflow for a task."],
    parameters: Type.Object({}),
    prepareArguments(_rawArgs: unknown) { return {}; },
    async execute(_id: string, _params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const cwd = ctx.cwd ?? process.cwd();
      const settings = resolveWorkflowSettings();
      const entries = listWorkflowEntries(cwd);
      const lines = entries.length === 0
        ? ["No workflows found. Project workflows live in ./workflows/*.json; cross-project assets live in ~/.abrain/workflows/*.json."]
        : ["Available workflows:", ...entries.map((e) => `- ${e.namespace}:${e.name} ${e.runnable ? "(runnable)" : "(convention)"} — ${e.path}`)];
      return successContent(lines.join("\n"), { kind: "workflow_list", entries, settings });
    },
  });

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow Run",
    description: "Run a persisted workflow JSON file after deterministic validation. Tell-not-ask; no confirmation modal. Requires workflow.enabled=true.",
    promptSnippet: "workflow_run(file) — run a workflow JSON file",
    promptGuidelines: [
      "Use when a persisted workflow matches the user's natural-language task.",
      "Do not ask for permission based on cost; report cost after completion.",
      "If validation fails, explain the structured errors and do not run.",
    ],
    parameters: Type.Object({ file: Type.String({ description: "Workflow JSON path (relative to cwd, absolute, or ~/...)" }) }),
    prepareArguments(rawArgs: unknown) {
      const a = asRecord(rawArgs);
      return { file: typeof a.file === "string" ? a.file : String(a.file ?? "") };
    },
    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const notify = (msg: string, type?: string) => ctx.ui?.notify?.(msg, type as never);
      const cwd = ctx.cwd ?? process.cwd();
      const r = await runWorkflowCore({ file: params.file, cwd, modelRegistry: ctx.modelRegistry, signal, notify });
      if (!r.ok) {
        return errorContent(`✗ workflow_run: ${r.error}${r.report ? `\n\n${r.report}` : ""}`, r.details);
      }
      const text = formatRunSummary(r.doc, r.result);
      notify(text, r.result.status === "completed" ? "info" : "warning");
      return successContent(text, { kind: "workflow_run_result", ...r.result });
    },
  });

  // ── Slash direct path (legacy/debug surface; shares helpers) ───

  pi.registerCommand("workflow", {
    description: "Workflow direct path: /workflow dry-run <file.json> | /workflow run <file.json>. Primary surface is LLM tools workflow_validate/list/run.",
    getArgumentCompletions(prefix: string) {
      const items = ["dry-run ", "run ", "list"];
      const filtered = items.filter((i) => i.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      const notify = (msg: string, type?: string) => ctx.ui.notify(msg, type as never);
      const trimmed = args.trim();
      const settings = resolveWorkflowSettings();
      const cwd = ctx.cwd ?? process.cwd();

      if (trimmed === "list") {
        const entries = listWorkflowEntries(cwd);
        notify(entries.length ? entries.map((e) => `${e.namespace}:${e.name} ${e.runnable ? "(runnable)" : "(convention)"} — ${e.path}`).join("\n") : "No workflows found.", "info");
        return;
      }

      const m = /^(dry-run|run)\s+(.+)$/.exec(trimmed);
      if (!m) {
        notify("usage: /workflow dry-run <file.json> | /workflow run <file.json> | /workflow list", "info");
        return;
      }
      const sub = m[1];
      // Backward-compat: if a user still types --yes, strip it safely; it is no longer required.
      const { fileSpec, malformed } = sub === "run"
        ? parseWorkflowRunArgs(m[2])
        : { fileSpec: m[2].trim(), malformed: false };
      if (malformed) {
        notify("/workflow run: unmatched or mixed quotes in the file argument — wrap the FULL path in one matching pair of quotes.", "warning");
        return;
      }

      if (sub === "dry-run") {
        const loaded = loadWorkflowFile(fileSpec, cwd, settings.readOnly);
        if (loaded.error || !loaded.doc || !loaded.validation) {
          notify(`/workflow dry-run: ${loaded.error ?? "load failed"}`, "warning");
          return;
        }
        notify(formatDryRunReport(loaded.validation, { readOnly: settings.readOnly, enabled: settings.enabled }), loaded.validation.ok ? "info" : "warning");
        return;
      }

      const r = await runWorkflowCore({ file: fileSpec, cwd, modelRegistry: ctx.modelRegistry, signal: (ctx as any).signal, notify });
      if (!r.ok) {
        notify(`✗ /workflow run: ${r.error}${r.report ? `\n\n${r.report}` : ""}`, "warning");
        return;
      }
      notify(formatRunSummary(r.doc, r.result), r.result.status === "completed" ? "info" : "warning");
    },
  });
}
