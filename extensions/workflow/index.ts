/**
 * workflow extension — PR-9 / P2a (ADR 0032 Part B).
 *
 * Scope of THIS PR: `/workflow dry-run <file>` ONLY — deterministic DSL
 * validation presented to the user (gate (b) of the §6 user-authority
 * triple: persisted artifact + dry-run presented + explicit invoke).
 * NO execution: the PR-10 executor ships separately after the dispatch
 * shared-runner API extraction (ADR 0032 §8 API 边界注记).
 *
 * dry-run works even with workflow.enabled=false: it is pure read-only
 * deterministic validation (no LLM, no spawn, no writes) and is exactly
 * what users need to AUTHOR workflows before opting into the
 * experimental channel. The report footer states that the execution
 * channel is disabled. Execution (PR-10) is hard-gated on
 * workflow.enabled per ADR 0032 §5.
 */

import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDryRunReport, parseWorkflowJson, validateWorkflow } from "./dsl";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

interface WorkflowSettings {
  /** ADR 0032 §5: experimental channel master switch. Default OFF.
   *  Flipping this default = promotion = blocked on ADR 0030. */
  enabled: boolean;
  /** ADR 0032 §5: read-only tool surface. Default ON. */
  readOnly: boolean;
}

const DEFAULTS: WorkflowSettings = { enabled: false, readOnly: true };

function resolveWorkflowSettings(): WorkflowSettings {
  let cfg: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    if (raw && typeof raw.workflow === "object" && raw.workflow !== null) cfg = raw.workflow as Record<string, unknown>;
  } catch { /* defaults */ }
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    readOnly: typeof cfg.readOnly === "boolean" ? cfg.readOnly : DEFAULTS.readOnly,
  };
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_WORKFLOW === "1") return;

  pi.registerCommand("workflow", {
    description:
      "Declarative workflow (ADR 0032, experimental): /workflow dry-run <file.json> validates a v1 workflow DSL document and presents the plan. Execution ships with PR-10 behind workflow.enabled (default off).",
    getArgumentCompletions(prefix: string) {
      const items = ["dry-run "];
      const filtered = items.filter((i) => i.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      const notify = (msg: string, type?: string) => ctx.ui.notify(msg, type as never);
      const trimmed = args.trim();
      const m = /^dry-run\s+(.+)$/.exec(trimmed);
      if (!m) {
        notify("usage: /workflow dry-run <file.json> — validates an ADR 0032 v1 workflow document (execution channel ships with PR-10)", "info");
        return;
      }
      const settings = resolveWorkflowSettings();
      const cwd = ctx.cwd ?? process.cwd();
      // Gate (a) of §6: the topology must be a PERSISTED artifact — dry-run
      // only reads files from disk, never inline JSON from the prompt.
      // gpt R1 N4: strip quotes only as a MATCHING pair — lone quotes are
      // part of the path, not silently rewritten.
      const trimmedArg = m[1].trim();
      const quoted = /^(["'])(.*)\1$/.exec(trimmedArg);
      const fileArg = quoted ? quoted[2] : trimmedArg;
      const fp = path.isAbsolute(fileArg) ? fileArg : path.resolve(cwd, fileArg);
      let raw: string;
      try {
        raw = fsSync.readFileSync(fp, "utf-8");
      } catch (e: unknown) {
        notify(`/workflow dry-run: cannot read ${fp}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`, "warning");
        return;
      }
      const parsed = parseWorkflowJson(raw);
      if (!parsed.doc) {
        notify(`✗ workflow dry-run FAILED\n  - ${parsed.error}`, "warning");
        return;
      }
      const result = validateWorkflow(parsed.doc, { readOnly: settings.readOnly });
      notify(formatDryRunReport(result, { readOnly: settings.readOnly, enabled: settings.enabled }), result.ok ? "info" : "warning");
    },
  });
}
