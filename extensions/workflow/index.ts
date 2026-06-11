/**
 * workflow extension — PR-9 dry-run + PR-10 executor (ADR 0032 Part B).
 *
 * Commands (USER-ONLY surface — deliberately NOT an LLM tool: gate (c) of
 * the §6 user-authority triple requires explicit user invoke; registering
 * an executor tool would let the LLM auto-trigger workflows, which is
 * promotion machine-check item 3 of §5):
 *
 *   /workflow dry-run <file>        — deterministic v1 DSL validation +
 *                                     plan presentation (gate (b)).
 *   /workflow run <file>            — gate sequence: validates, presents
 *                                     the SAME report + per-stage effective
 *                                     model/tools, then instructs --yes.
 *   /workflow run <file> --yes      — explicit invoke (gate (c)): executes
 *                                     via the dispatch shared runner API.
 *
 * Execution is hard-gated on workflow.enabled (default false, §5). The
 * two-step run/--yes shape makes the triple auditable: (a) persisted
 * artifact on disk, (b) report presented in step 1, (c) --yes in step 2.
 *
 * Production runner (W13): wraps dispatch's exported runInProcess —
 * NOT a copy (ADR 0032 §8 API boundary note). Nested-dispatch rejection,
 * PI_MULTI_AGENT_ALLOW_MUTATING enforcement (third gate of W9), and
 * heartbeat semantics inherit with the API. Each stage unit derives a C6
 * anchor via deriveSubAgentAnchor and runs under runWithTriggerAnchor.
 */

import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatDryRunReport,
  formatEffectiveStageLines,
  parseWorkflowJson,
  parseWorkflowRunArgs,
  validateWorkflow,
  WORKFLOW_MAX_CONCURRENCY,
  type WorkflowDoc,
} from "./dsl";
import { executeWorkflow, type StageRunner } from "./executor";
import {
  runInProcess,
  validateTools,
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY as DISPATCH_MAX_CONCURRENCY,
  type AgentResult,
} from "../dispatch/index";
import {
  deriveSubAgentAnchor,
  formatAnchorPromptBlock,
  getCurrentAnchor,
  runWithTriggerAnchor,
  spreadAnchor,
} from "../_shared/causal-anchor";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

interface WorkflowSettings {
  /** ADR 0032 §5: experimental channel master switch. Default OFF.
   *  Flipping this default = promotion = blocked on ADR 0030. */
  enabled: boolean;
  /** ADR 0032 §5: read-only tool surface. Default ON. */
  readOnly: boolean;
  /** P3 cost layering (ADR 0032 §9, advisory-only): stages without an
   *  explicit model run on the cheap tier. Never used for correctness
   *  adjudication — T0 blind review stays cost-blind. */
  defaultModel: string;
  defaultThinking: string;
}

const DEFAULTS: WorkflowSettings = {
  enabled: false,
  readOnly: true,
  defaultModel: "deepseek/deepseek-v4-flash",
  defaultThinking: "medium",
};

function resolveWorkflowSettings(): WorkflowSettings {
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

/** Read + parse + validate a workflow file from disk (gate (a): persisted
 *  artifact only — no inline JSON). Returns notify-ready error strings. */
function loadWorkflowFile(fileArgRaw: string, cwd: string, readOnly: boolean): {
  doc?: WorkflowDoc;
  validation?: ReturnType<typeof validateWorkflow>;
  fp?: string;
  error?: string;
} {
  // gpt R1 N4: strip quotes only as a MATCHING pair.
  const trimmedArg = fileArgRaw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmedArg);
  const fileArg = quoted ? quoted[2] : trimmedArg;
  // gpt R3-2: empty argument after quote-strip must not resolve to cwd.
  if (!fileArg.trim()) return { error: "empty file argument" };
  const fp = path.isAbsolute(fileArg) ? fileArg : path.resolve(cwd, fileArg);
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

/** Production stage runner: dispatch shared runner API + C6 anchor +
 *  heartbeat threading (W13). validateTools is the runtime tool gate —
 *  the THIRD W9 gate (PI_MULTI_AGENT_ALLOW_MUTATING) lives inside it and
 *  is enforced here at execution time, not just at dry-run. */
function makeProductionRunner(modelRegistry: unknown, projectRoot: string): StageRunner {
  return async (req) => {
    const toolCheck = validateTools(req.tools);
    if (!toolCheck.ok) {
      return { output: "", error: `tool_rejected: ${toolCheck.reason}`, failureType: "tool_rejected", durationMs: 0 };
    }
    const anchor = deriveSubAgentAnchor(getCurrentAnchor(), req.anchorLabel);
    const prompt = anchor ? `${formatAnchorPromptBlock(anchor)}\n\n${req.prompt}` : req.prompt;
    const result: AgentResult = await runWithTriggerAnchor(anchor, () =>
      runInProcess(
        req.model, req.thinking, prompt,
        req.signal ?? new AbortController().signal,
        req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        modelRegistry,
        req.tools,
        { anchor, projectRoot },
      ),
    );
    return {
      output: result.output,
      ...(result.error ? { error: result.error } : {}),
      ...(result.failureType ? { failureType: result.failureType } : {}),
      durationMs: result.durationMs,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  };
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

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_WORKFLOW === "1") return;

  pi.registerCommand("workflow", {
    description:
      "Declarative workflow (ADR 0032, experimental): /workflow dry-run <file.json> validates a v1 DSL document; /workflow run <file.json> [--yes] executes it (requires workflow.enabled; --yes is the explicit-invoke gate).",
    getArgumentCompletions(prefix: string) {
      const items = ["dry-run ", "run "];
      const filtered = items.filter((i) => i.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      const notify = (msg: string, type?: string) => ctx.ui.notify(msg, type as never);
      const trimmed = args.trim();
      const m = /^(dry-run|run)\s+(.+)$/.exec(trimmed);
      if (!m) {
        notify("usage: /workflow dry-run <file.json> | /workflow run <file.json> [--yes]", "info");
        return;
      }
      const settings = resolveWorkflowSettings();
      const cwd = ctx.cwd ?? process.cwd();
      const sub = m[1];
      // gpt PR-10 R1 B1: quote-aware parsing — a quoted path containing
      // "--yes" is path data; only a trailing unquoted --yes confirms.
      const { fileSpec, confirmed, malformed } = sub === "run"
        ? parseWorkflowRunArgs(m[2])
        : { fileSpec: m[2].trim(), confirmed: false, malformed: false };
      if (malformed) {
        // gpt R2 B1-R2 fail-closed surface: unmatched/mixed quotes never
        // confirm and never get rewritten — tell the user to quote properly.
        notify("/workflow run: unmatched or mixed quotes in the file argument — wrap the FULL path in one matching pair of quotes (a trailing --yes must sit outside the quotes).", "warning");
        return;
      }

      const loaded = loadWorkflowFile(fileSpec, cwd, settings.readOnly);
      if (loaded.error || !loaded.doc || !loaded.validation) {
        notify(`/workflow ${sub}: ${loaded.error ?? "load failed"}`, "warning");
        return;
      }
      const { doc, validation } = loaded;
      const report = formatDryRunReport(validation, { readOnly: settings.readOnly, enabled: settings.enabled });

      if (sub === "dry-run") {
        notify(report, validation.ok ? "info" : "warning");
        return;
      }

      // ── /workflow run ──
      if (!settings.enabled) {
        // §5 hard gate: the execution channel itself is off by default.
        notify(
          "/workflow run: workflow.enabled=false — the execution channel is an experimental opt-in (ADR 0032 §5). " +
          "Set { \"workflow\": { \"enabled\": true } } in pi-astack-settings.json to enable. Dry-run validation works without it.",
          "warning",
        );
        return;
      }
      if (!validation.ok) {
        notify(report, "warning");
        return;
      }
      const effective = formatEffectiveStageLines(doc, {
        model: settings.defaultModel, thinking: settings.defaultThinking,
      });
      if (!confirmed) {
        // Gate (b): present the validated plan + effective surface, then
        // require the explicit-invoke token (gate (c)) as a SECOND step.
        notify(
          `${report}\n  effective stage surface:\n${effective.join("\n")}\n\n` +
          `to execute: /workflow run ${fileSpec} --yes`,
          "info",
        );
        return;
      }

      // gpt R1 N2: random suffix — same-millisecond runs must not share a runDir.
      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${doc.name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40)}-${randomUUID().slice(0, 8)}`;
      const runDir = path.join(workflowRoot(cwd), runId);
      notify(`workflow "${doc.name}" starting — run ${runId}\n${effective.join("\n")}`, "info");

      try {
        const result = await executeWorkflow({
          doc,
          runId,
          runDir,
          runner: makeProductionRunner(ctx.modelRegistry, cwd),
          // deepseek N3 / gpt N3 (PR-10 R1): clamp to BOTH the DSL mirror and
          // dispatch's real constant — if either drops, the run obeys the
          // smaller cap (drift-proof at the production call site).
          maxConcurrency: Math.min(WORKFLOW_MAX_CONCURRENCY, DISPATCH_MAX_CONCURRENCY),
          // gpt R2 N1: thread dispatch's exported default explicitly so the
          // per-stage timeout can't drift from the runner's own default.
          perStageTimeoutMs: DEFAULT_TIMEOUT_MS,
          readOnly: settings.readOnly,
          defaultModel: settings.defaultModel,
          defaultThinking: settings.defaultThinking,
          notify: (msg) => notify(msg, "info"),
          audit: (row) => appendWorkflowAudit(cwd, row),
        });
        const icon = result.status === "completed" ? "✓" : result.status === "degraded" ? "⚠" : "✗";
        const stageLines = Object.values(result.stages)
          .filter((r) => !r.parent)
          .map((r) => `  ${r.id}: ${r.status}${r.error ? ` (${r.error.slice(0, 80)})` : ""}`);
        // §7: degraded is NEVER silent — the summary always carries the list.
        const degradedLine = result.degraded.length > 0
          ? `\n  ⚠ degraded stages: ${result.degraded.join(", ")} (partial results + failure notes in their output files)`
          : "";
        const costLine = result.totalCost > 0 ? ` ($${result.totalCost.toFixed(4)})` : "";
        notify(
          `${icon} workflow "${doc.name}" ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s${costLine}\n` +
          `${stageLines.join("\n")}${degradedLine}\n  trace: ${result.statePath}`,
          result.status === "completed" ? "info" : "warning",
        );
      } catch (e: unknown) {
        notify(`✗ workflow run failed to start: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`, "error");
      }
    },
  });
}
