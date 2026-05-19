/**
 * dispatch extension for pi-astack — delegate tasks to sub-agents via subprocess pi.
 *
 * Self-contained rewrite (2026-05-06, v2). Replaces the in-process completeSimple
 * runner with pi subprocess spawning. Each dispatch = an independent pi instance
 * running in print+json mode, providing:
 *
 *   - OS-level process isolation (the runtime context IS the boundary)
 *   - Full pi tool ecosystem (reuses pi's own tool loop, event bus, trace)
 *   - Zero maintenance tool-calling loop (pi runtime handles it)
 *   - Structured JSON event stream (free observability)
 *
 * Registers:
 *   dispatch_agent    — single task
 *   dispatch_parallel — parallel tasks (max 16, renamed from dispatch_agents 2026-05-13 to prevent LLM confusion with dispatch_agent)
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { coerceTasksParam, normalizeTaskSpec } from "./input-compat";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";

// ── Constants ───────────────────────────────────────────────────

const MAX_PARALLEL = 16;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

// ── Footer status state machine ────────────────────────────────────────────────
//
// Mirrors the sediment extension's status discipline so users get a
// consistent vocabulary across pi-astack extensions:
//
//   idle      no dispatch tool has been called yet, or the most recent
//             completion was already cleared by a fresh agent_start
//   running   one or more sub-agents are in flight — footer shows live
//             counters: running/failed/success/total
//   completed all sub-agents finished without errors
//   failed    at least one sub-agent errored or timed out
//
// Transitions:
//   - session_start                          -> idle
//   - agent_start                            -> idle (resets prev result)
//   - dispatch_agent / dispatch_parallel start -> running
//   - dispatch finishes, no errors           -> completed
//   - dispatch finishes with any error       -> failed
//
// Concurrent dispatch tool calls are theoretically possible (pi default
// is parallel tool mode) but semantically unusual — a model wanting
// parallelism uses dispatch_parallel(tasks[]) rather than firing two tool
// calls. We accept simple last-writer-wins overlap rather than
// maintaining a multi-call counter.

const DISPATCH_STATUS_KEY = FOOTER_STATUS_KEYS.dispatch;

type DispatchState = "idle" | "running" | "completed" | "failed";

interface DispatchCounts {
  running: number;
  failed: number;
  success: number;
  total: number;
}

/** Format the footer status string. Exported for smoke tests — the
 *  formatting itself is informational, do not depend on it elsewhere. */
export function renderDispatchStatus(
  state: DispatchState,
  counts?: DispatchCounts,
  durationMs?: number,
): string {
  const c = counts
    ? ` ${counts.running}/${counts.failed}/${counts.success}/${counts.total}`
    : "";
  const dur = typeof durationMs === "number"
    ? ` (${(durationMs / 1000).toFixed(1)}s)`
    : "";
  switch (state) {
    case "idle":      return "💤 dispatch idle";
    case "running":   return `📡 dispatch${c}`;
    case "completed": return `✅ dispatch${c}${dur}`;
    case "failed":    return `⚠️  dispatch${c}${dur}`;
    default:          return `❓ dispatch (${state})${c}${dur}`;
  }
}

/**
 * Apply a dispatch state to ctx.ui.setStatus. Tolerates older pi versions
 * without setStatus and stale-ctx late fires (try/catch wrapper).
 */
function applyDispatchStatus(
  ctx: { ui?: { setStatus?(extId: string, message?: string): void } },
  state: DispatchState,
  counts?: DispatchCounts,
  durationMs?: number,
): void {
  const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
  if (!setStatusRaw) return;
  try {
    setStatusRaw(DISPATCH_STATUS_KEY, renderDispatchStatus(state, counts, durationMs));
  } catch { /* best-effort */ }
}

// ── Prompt file helper ──────────────────────────────────────────

/**
 * Simple prompt-to-file writer. The caller is responsible for providing
 * a unique tmpDir (via mkdtemp) to prevent concurrent dispatch_parallel
 * tasks from overwriting each other's prompt files (R6 audit P1 fix).
 */
function promptArg(
  prompt: string,
  tmpDir: string,
): { arg: string; cleanup?: () => void } {
  const file = path.join(tmpDir, "dispatch-prompt.md");
  fs.writeFileSync(file, prompt, "utf-8");
  return {
    arg: `@${file}`,
    cleanup: () => {
      try { fs.unlinkSync(file); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    },
  };
}

// ── Tool validation ─────────────────────────────────────────────

interface ToolValidation {
  ok: boolean;
  reason?: string;
}

function validateTools(toolsStr: string | undefined): ToolValidation {
  if (!toolsStr) return { ok: true };

  const names = toolsStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

  for (const name of names) {
    if (name === "dispatch_agent" || name === "dispatch_parallel") {
      return { ok: false, reason: `nested dispatch not allowed` };
    }
    if (MUTATING_TOOLS.has(name)) {
      if (process.env.PI_MULTI_AGENT_ALLOW_MUTATING !== "1") {
        return { ok: false, reason: `mutating tool "${name}" requires PI_MULTI_AGENT_ALLOW_MUTATING=1` };
      }
    }
  }

  return { ok: true };
}

// ── Subprocess ──────────────────────────────────────────────────

interface RetryEntry {
  /** 1-based attempt index from pi's auto_retry_start event. */
  attempt: number;
  /** First ~120 chars of the error message that triggered this retry. */
  errorPreview?: string;
  /** Backoff delay (ms) pi reported before this attempt. */
  delayMs?: number;
  /** Wall-clock when dispatch saw the auto_retry_start event. */
  startedAt: number;
}

interface RetryHistory {
  /** One entry per auto_retry_start event observed on the child stdout. */
  entries: RetryEntry[];
  /**
   * Terminal outcome reported by pi via auto_retry_end. Undefined means we
   * never observed an auto_retry_end (process killed mid-retry, etc.).
   *
   * - "succeeded": pi's retry loop produced a non-error assistant message
   *   before maxRetries was hit. The next message_end after this carries the
   *   actual successful output.
   * - "exhausted": pi exhausted maxRetries; lastAssistant stays on the final
   *   failed message.
   */
  finalOutcome?: "succeeded" | "exhausted";
  /** Attempt number reported by the last auto_retry_end event. */
  finalAttempt?: number;
}

interface SubprocessResult {
  output: string;
  error?: string;
  stopReason?: string;
  durationMs: number;
  usage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
  /**
   * Pi internal retry history (auto_retry_start / auto_retry_end events).
   * Independent of model-fallback. Undefined when no retry was triggered.
   *
   * The retry happens INSIDE the same pi subprocess: dispatch sees a failed
   * message_end, then later a successful message_end (if recovery worked).
   * lastAssistant tracks the latest message_end, so retry-then-succeed flows
   * naturally produce stopReason=stop and dispatch reports success. This
   * field surfaces "how many retries were burned" so the operator knows the
   * difference between "first try succeeded" and "6th try succeeded after
   * 5 transient EOFs".
   */
  retryHistory?: RetryHistory;
}

/**
 * Spawn a pi subprocess, consume its JSON event stream, return the
 * final assistant output. pi handles multi-turn tool calling internally.
 *
 * onSpawn is called synchronously with the child PID once the process
 * starts — before any event listeners are set up.
 */
function runSubprocess(
  model: string,
  thinking: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
  onSpawn?: (pid: number) => void,
  toolAllowlist?: string,
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-"));
    const { arg: promptArgValue, cleanup: cleanupTemp } = promptArg(prompt, tmpDir);

    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--model", model,
    ];

    // pi's --thinking flag
    if (thinking !== "off") {
      args.push("--thinking", thinking);
    }

    // ── Tool allowlist ──────────────────────────────────────────
    // pi supports --tools <allowlist> to restrict which tools the
    // sub-agent can call (see `pi --help`). When no allowlist is
    // provided, default to read-only safe tools (read, grep, find,
    // ls). When PI_MULTI_AGENT_ALLOW_MUTATING=1 and mutating tools
    // were explicitly requested, the caller passes the expanded
    // allowlist including bash/edit/write.
    const allowlist = toolAllowlist || "read,grep,find,ls";
    args.push("--tools", allowlist);

    // The prompt as the positional argument
    args.push(promptArgValue);

    let child: ChildProcess | null = null;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGTERM");
      // Force kill after 5s grace
      forceKillTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", onAbort);
      cleanupTemp?.();
    };

    const onAbort = () => {
      child?.kill("SIGTERM");
    };

    if (signal.aborted) {
      cleanup();
      resolve({
        output: "",
        error: "aborted before start",
        durationMs: Date.now() - start,
      });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      // env override: force PI_ABRAIN_DISABLED=1 in sub-pi to enforce ADR 0014
      // invariant #6 (sub-pi 默认看不到任何 vault). Order matters: ...process.env
      // first, PI_ABRAIN_DISABLED last — so user's `export PI_ABRAIN_DISABLED=0`
      // cannot bypass. See migration/vault-bootstrap.md §5 layer (a).
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PI_ABRAIN_DISABLED: "1",
      };
      child = spawn("pi", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: childEnv,
      });
      if (child.pid) onSpawn?.(child.pid);
    } catch (e: any) {
      cleanup();
      resolve({
        output: "",
        error: `spawn failed: ${e.message}`,
        durationMs: Date.now() - start,
      });
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    const messages: any[] = [];
    let finalOutput = "";
    let lastAssistant: any = null;
    const retryHistory: RetryHistory = { entries: [] };

    const processLines = (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            messages.push(event.message);
            if (event.message.role === "assistant") {
              lastAssistant = event.message;

              // Accumulate usage
              if (event.message.usage) {
                // usage is accumulated across turns by pi
              }

              // Final text — taken from the LAST assistant message
              // (earlier ones are intermediate tool-calling turns).
              // On retry: pi emits message_end(error) for the failed
              // attempt, then later message_end(stop|toolUse) for the
              // recovered attempt. We just keep overwriting; the last one
              // wins, which is exactly the right semantics.
              finalOutput = "";
              if (event.message.content) {
                for (const part of event.message.content) {
                  if (part.type === "text") finalOutput += part.text;
                }
              }
            }
          }
          if (event.type === "tool_result_end" && event.message) {
            messages.push(event.message);
          }
          // Pi-internal retry observability. These events come from
          // agent-session.js _handleRetryableError / _processAgentEvent.
          if (event.type === "auto_retry_start") {
            const errorMessage =
              typeof event.errorMessage === "string" ? event.errorMessage : undefined;
            retryHistory.entries.push({
              attempt:
                typeof event.attempt === "number"
                  ? event.attempt
                  : retryHistory.entries.length + 1,
              errorPreview: errorMessage
                ? errorMessage.slice(0, 120).replace(/\s+/g, " ").trim()
                : undefined,
              delayMs: typeof event.delayMs === "number" ? event.delayMs : undefined,
              startedAt: Date.now(),
            });
          }
          if (event.type === "auto_retry_end") {
            retryHistory.finalOutcome = event.success ? "succeeded" : "exhausted";
            if (typeof event.attempt === "number") {
              retryHistory.finalAttempt = event.attempt;
            }
          }
        } catch {
          // Non-JSON line (banner, warning) — ignore in -p mode
        }
      }
    };

    child.stdout.on("data", processLines);

    child.stderr.on("data", (data) => {
      stderrBuf += data.toString();
    });

    child.on("close", (code) => {
      // Flush remaining buffer
      if (stdoutBuf.trim()) {
        try {
          const event = JSON.parse(stdoutBuf.trim());
          if (event.type === "message_end" && event.message) {
            messages.push(event.message);
            if (event.message.role === "assistant") {
              lastAssistant = event.message;
              finalOutput = "";
              if (event.message.content) {
                for (const part of event.message.content) {
                  if (part.type === "text") finalOutput += part.text;
                }
              }
            }
          }
        } catch { /* ignore */ }
      }

      cleanup();

      const durationMs = Date.now() - start;

      if (timedOut) {
        resolve({ output: finalOutput, error: `timeout after ${timeoutMs}ms`, durationMs });
        return;
      }

      if (signal.aborted) {
        resolve({ output: finalOutput, error: "aborted", durationMs });
        return;
      }

      // Extract usage from last assistant message
      let usage: SubprocessResult["usage"] | undefined;
      if (lastAssistant?.usage) {
        usage = {
          input: lastAssistant.usage.input ?? 0,
          output: lastAssistant.usage.output ?? 0,
          total: lastAssistant.usage.totalTokens ?? 0,
          cost: lastAssistant.usage.cost?.total ?? 0,
        };
      }

      const retries = retryHistory.entries.length > 0 ? retryHistory : undefined;

      if (code !== 0) {
        resolve({
          output: finalOutput,
          error: `pi exited code ${code}${stderrBuf ? ": " + stderrBuf.slice(0, 200) : ""}`,
          stopReason: lastAssistant?.stopReason,
          durationMs,
          usage,
          retryHistory: retries,
        });
        return;
      }

      if (lastAssistant?.stopReason === "error") {
        resolve({
          output: finalOutput,
          error: lastAssistant.errorMessage ?? "pi reported error",
          stopReason: "error",
          durationMs,
          usage,
          retryHistory: retries,
        });
        return;
      }

      resolve({
        output: finalOutput || "(no output)",
        stopReason: lastAssistant?.stopReason,
        durationMs,
        usage,
        retryHistory: retries,
      });
    });

    child.on("error", (err) => {
      cleanup();
      resolve({
        output: "",
        error: `pi process error: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ── Result formatting ───────────────────────────────────────────

/**
 * One-line retry summary, suitable to splice into formatResult output.
 * Returns empty string when no retries were observed (vast majority of calls).
 *
 * Examples:
 *   retries: 1 attempt, recovered ✓ (first error: "connection lost — ...")
 *   retries: 9 attempts, all failed ✗ (first error: "connection lost — ...")
 *   retries: 3 attempts, status unknown (first error: "...")
 */
function formatRetrySummary(history?: RetryHistory): string {
  if (!history || history.entries.length === 0) return "";
  const n = history.entries.length;
  const word = n === 1 ? "attempt" : "attempts";
  let outcome: string;
  if (history.finalOutcome === "succeeded") outcome = "recovered ✓";
  else if (history.finalOutcome === "exhausted") outcome = "all failed ✗";
  else outcome = "status unknown";
  const firstErr = history.entries[0]?.errorPreview;
  const errPart = firstErr ? ` (first error: "${firstErr}")` : "";
  return `retries: ${n} ${word}, ${outcome}${errPart}`;
}

// Exported for smoke test only — not part of the public extension surface.
// `smoke:dispatch-output-format` requires this to verify the no-truncation
// invariant (caller LLM must receive sub-agent's full output, mirror of
// dispatch_parallel `lines.push(r.output)` path).
export function formatResult(
  label: string,
  model: string,
  result: SubprocessResult,
): string {
  const dur = `${(result.durationMs / 1000).toFixed(1)}s`;
  const usageStr = result.usage
    ? ` ↑${result.usage.input} ↓${result.usage.output} $${result.usage.cost.toFixed(4)}`
    : "";
  const retryLine = formatRetrySummary(result.retryHistory);
  const retrySuffix = retryLine ? `\n_${retryLine}_` : "";

  if (result.error) {
    return `## ${label} (${model}) ❌ ${dur}\n${result.error}${usageStr ? `\n_${usageStr}_` : ""}${retrySuffix}`;
  }

  // No truncation: dispatch_agent's primary purpose is returning the
  // sub-agent's full reasoning output to the caller. Mirrors
  // dispatch_parallel which also returns r.output verbatim (line ~850).
  //
  // Pre-2026-05-19: this path hard-sliced to 500 chars + '...' which
  // silently truncated any review / analysis longer than ~80 words.
  // Symptom: caller LLM appears to receive a half-finished response
  // from the sub-agent and has no way to ask for the rest (sub-agent
  // is a single-shot subprocess; the missing tail is gone). The
  // caller's token budget for the returned text is the caller's own
  // problem to manage — if the sub-agent emits 100K chars, that's a
  // sub-agent prompt design issue, not something to hide via
  // truncation in the result-formatting path.
  return `## ${label} (${model}) ✅ ${dur}${usageStr ? ` _${usageStr}_` : ""}${retrySuffix}\n\n${result.output}`;
}

// ── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Sub-pi guard (2026-05-14 audit): dispatch tools must not register
  // in sub-pi — nested dispatch is blocked at execute() time, but the
  // tools shouldn't appear in the sub-pi tool schema at all.
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  // Footer status: reset to idle on session/agent boundaries so the
  // previous turn's completed/failed result doesn't linger past the
  // next user message. Mirrors sediment's lifecycle.
  pi.on("session_start", async (_event: unknown, ctx: any) => {
    applyDispatchStatus(ctx, "idle");
  });
  pi.on("agent_start", async (_event: unknown, ctx: any) => {
    applyDispatchStatus(ctx, "idle");
  });

  // ═══════════════════════════════════════════════════════════════
  // dispatch_agent
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Spawn a SINGLE sub-agent. For 2+ independent tasks, use dispatch_parallel instead " +
      "(calling dispatch_agent N times runs them serially, wasting wall-clock time). " +
      "The sub-agent runs as an independent pi process, capable of multi-turn " +
      "tool calling (read, grep, find, ls). Mutating tools (bash, edit, write) " +
      "are blocked by default.",
    promptSnippet: "dispatch_agent(model, thinking, prompt, tools?, timeoutMs?) — SINGLE task only",
    promptGuidelines: [
      "Use dispatch_agent ONLY for a single analysis/reasoning task. For 2+ tasks, use dispatch_parallel.",
      "⚠️ Anti-pattern: calling dispatch_agent 3 times for 3 models. Each call blocks for the sub-agent to finish, so 3×30s=90s vs dispatch_parallel which runs them in parallel (~30s).",
      "Sub-agents CAN use read, grep, find, ls. Mutating tools require PI_MULTI_AGENT_ALLOW_MUTATING=1.",
      "The sub-agent is an independent pi process — its context does NOT count against your token budget.",
    ],
    parameters: Type.Object({
      model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
      thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
      prompt: Type.String({ description: "Prompt sent to this task" }),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool names allowlist. Sub-pi runs with its own built-in tool set; this field controls the --tools parameter passed to the sub-pi. The sub-agent can ONLY call tools in this list (default: read,grep,find,ls). Mutating tools (bash/edit/write) require PI_MULTI_AGENT_ALLOW_MUTATING=1, and nested dispatch_agent/dispatch_parallel is always rejected." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in ms (default 1800000 = 30min)" })),
    }),

    prepareArguments(args: Record<string, unknown>) {
      const n = normalizeTaskSpec(args);
      return {
        model: n.model,
        thinking: n.thinking,
        prompt: n.prompt,
        tools: n.tools,
        timeoutMs: n.timeoutMs,
      };
    },

    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      // Validate tools if specified
      const toolCheck = validateTools(params.tools);
      if (!toolCheck.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ ${toolCheck.reason}` }],
          isError: true,
        };
      }

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const startedAt = Date.now();
      applyDispatchStatus(ctx, "running", { running: 1, failed: 0, success: 0, total: 1 });
      // runSubprocess returns a Promise that may reject if its constructor
      // synchronously throws (e.g. promptArg's fs.mkdirSync / writeFileSync
      // hits a disk-full or permission error). Catch here so the footer
      // status doesn't get stuck in `running` and the user still gets
      // an actionable tool-result error.
      let result: SubprocessResult;
      try {
        result = await runSubprocess(params.model, params.thinking, params.prompt, signal, timeoutMs, undefined, params.tools || undefined);
      } catch (err: any) {
        result = {
          output: "",
          error: `dispatch crashed: ${err?.message ?? String(err)}`,
          durationMs: Date.now() - startedAt,
        };
      }
      const durationMs = Date.now() - startedAt;
      if (result.error) {
        applyDispatchStatus(ctx, "failed", { running: 0, failed: 1, success: 0, total: 1 }, durationMs);
      } else {
        applyDispatchStatus(ctx, "completed", { running: 0, failed: 0, success: 1, total: 1 }, durationMs);
      }

      const text = formatResult("dispatch", params.model, result);

      return {
        content: [{ type: "text" as const, text }],
        ...(result.error ? { isError: true } : {}),
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // dispatch_parallel
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "dispatch_parallel",
    label: "Dispatch Parallel",
    description:
      "Run multiple sub-agents IN PARALLEL. Each is an independent pi process. " +
      "Results are collected when ALL complete. This is the primary tool for " +
      "multi-model analysis — do NOT call dispatch_agent N times instead. " +
      "Mutating tools blocked by default. " +
      `Up to ${MAX_PARALLEL} tasks per call; up to ${MAX_CONCURRENCY} run concurrently.`,
    promptSnippet: "dispatch_parallel([{model, thinking, prompt}, ...], timeoutMs?) — parallel execution",
    promptGuidelines: [
      "Use dispatch_parallel EVERY TIME you have 2+ independent analysis tasks with different models. All tasks run in parallel — do NOT call dispatch_agent N times.",
      "Example: dispatch_parallel([{model:'claude-opus-4-7', thinking:'high', prompt:'audit docs'}, {model:'gpt-5.5', thinking:'high', prompt:'audit code'}, {model:'deepseek-v4-pro', thinking:'high', prompt:'audit architecture'}]) → all 3 run concurrently, results returned together.",
      `Concurrency: up to ${MAX_PARALLEL} tasks accepted; ${MAX_CONCURRENCY} run at once, others queue. Choose models from DIFFERENT providers for diversity.`,
      "For reasoning-only tasks, omit tools (sub-pi uses built-in read/grep/find/ls).",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
          thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
          prompt: Type.String({ description: "Prompt sent to this task" }),
          tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist for this task (default: read,grep,find,ls). Per-task override of the global allowlist." })),
          timeoutMs: Type.Optional(Type.Number({ description: "Per-task timeout in ms (default 1800000 = 30min)" })),
        }),
        { description: `Array of task specifications (max ${MAX_PARALLEL})` },
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Default per-task timeout in ms (default 1800000 = 30min)" })),
    }),

    prepareArguments(args: Record<string, unknown>) {
      const rawTasks = (args as any).tasks;
      const raw = coerceTasksParam(rawTasks);
      // Defense-in-depth: coerceTasksParam now returns [] on failure rather
      // than masquerading a string as an array, but we still throw an
      // actionable error here so the model sees *why* its input was rejected
      // rather than a generic "No tasks provided" or a downstream crash.
      // Common failure: hand-stringified array where an inner prompt contains
      // an unescaped quote (e.g. 中文 prompt with `"..."`), making outer
      // JSON.parse fail mid-string.
      if (!Array.isArray(raw) || raw.length === 0) {
        const got =
          rawTasks === undefined
            ? "undefined"
            : typeof rawTasks === "string"
              ? `string of length ${rawTasks.length} starting with ${JSON.stringify(rawTasks.slice(0, 40))}`
              : `${typeof rawTasks} (${Array.isArray(rawTasks) ? "empty array" : "non-array"})`;
        throw new Error(
          `dispatch_parallel: 'tasks' must be a non-empty array of task objects {model, thinking, prompt}. ` +
            `Got ${got}. ` +
            `Pass tasks directly as a JSON array — do NOT wrap the entire array in a JSON string. ` +
            `If your prompt contains quote characters, the host's tool-call serializer handles escaping; ` +
            `you only need to author the array structurally.`,
        );
      }
      const tasks = raw.slice(0, MAX_PARALLEL).map((t: unknown) => {
        const n = normalizeTaskSpec(t);
        return {
          model: n.model,
          thinking: n.thinking,
          prompt: n.prompt,
          tools: n.tools,
          timeoutMs: n.timeoutMs,
        };
      });
      return { tasks, timeoutMs: (args as any).timeoutMs };
    },

    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const tasks = params.tasks ?? [];
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No tasks provided." }],
          isError: true,
        };
      }
      if (tasks.length === 1) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ dispatch_parallel requires 2+ tasks. You provided 1 task.\n\n` +
              `For a single task, use dispatch_agent instead — it has the same ` +
              `model/thinking/prompt/timeoutMs parameters and returns a simpler result. ` +
              `dispatch_parallel exists ONLY for parallel multi-model analysis; ` +
              `calling it with 1 task wastes the parallelism infrastructure and makes ` +
              `the output harder to read (table format for a single row).`,
          }],
          isError: true,
        };
      }

      const dispatchStart = Date.now();
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // Concurrency-limited worker pool with status bar progress.
      // Counters track running/failed/success/total — the unstarted
      // count is implicit (total - running - failed - success).
      const results: SubprocessResult[] = new Array(tasks.length);
      let nextIdx = 0;
      let running = 0;
      let success = 0;
      let failed = 0;
      const total = tasks.length;

      const updateRunning = () =>
        applyDispatchStatus(ctx, "running", { running, failed, success, total });
      updateRunning();

      const worker = async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= total) return;
          const t = tasks[i];
          // Track running by slot occupancy (worker has a task in flight)
          // rather than by onSpawn callback. runSubprocess does NOT call
          // onSpawn when signal is already aborted or when spawn()
          // synchronously fails — if we relied on onSpawn for running++,
          // the matching running-- would still fire and make the counter
          // negative.
          running++;
          updateRunning();
          let res: SubprocessResult;
          try {
            // P1 fix (2026-05-14 audit): validateTools was missing in
            // dispatch_parallel, allowing per-task `tools: "bash,edit,write"`
            // to bypass the PI_MULTI_AGENT_ALLOW_MUTATING gate that
            // dispatch_agent enforces. Per-task tools must pass the same
            // validation.
            const toolCheck = validateTools(t.tools);
            if (!toolCheck.ok) {
              res = {
                output: "",
                error: `task[${i}] rejected: ${toolCheck.reason}`,
                durationMs: 0,
              };
              results[i] = res;
              running--;
              failed++;
              updateRunning();
              continue;  // continue to next task — do NOT return (kills the worker permanently)
            }
            res = await runSubprocess(
              t.model, t.thinking, t.prompt, signal,
              t.timeoutMs ?? timeoutMs,
              undefined,
              t.tools || "read,grep,find,ls",
            );
          } catch (err: any) {
            res = {
              output: "",
              error: `dispatch crashed: ${err?.message ?? String(err)}`,
              durationMs: 0,
            };
          }
          results[i] = res;
          running--;
          if (res.error) failed++;
          else success++;
          updateRunning();
        }
      };

      const workers = new Array(Math.min(MAX_CONCURRENCY, total)).fill(null).map(() => worker());
      await Promise.allSettled(workers);
      const totalWallMs = Date.now() - dispatchStart;
      const totalWall = (totalWallMs / 1000).toFixed(1);
      const finalState: DispatchState = failed > 0 ? "failed" : "completed";
      applyDispatchStatus(
        ctx, finalState,
        { running: 0, failed, success, total },
        totalWallMs,
      );

      // Log parallelism: serial time estimate vs actual
      const serialEstimate = results.reduce((s, r) => s + r.durationMs, 0);
      const maxSingle = Math.max(...results.map((r) => r.durationMs));

      // Build summary table
      const lines: string[] = [
        `## Dispatch Results (${tasks.length} tasks, ${totalWall}s total)`,
      ];
      if (tasks.length > 1) {
        const parallelRatio = (serialEstimate / (maxSingle || 1)).toFixed(1);
        lines.push(
          `_serial sum: ${(serialEstimate / 1000).toFixed(1)}s → ` +
          `parallel actual: ${totalWall}s (${parallelRatio}× speedup)_\n`,
        );
      }
      lines.push("");
      lines.push(`| # | Model | Duration | Status |`);
      lines.push(`|---|-------|----------|--------|`);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        const status = r.error ? "❌" : "✅";
        lines.push(`| ${i + 1} | ${tasks[i].model} | ${dur} | ${status} |`);
      }
      lines.push("");

      // Full outputs
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        const usageStr = r.usage
          ? ` ↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`
          : "";

        lines.push(`### ${i + 1}. ${tasks[i].model} (${dur}${usageStr ? ` — ${usageStr}` : ""})`);

        if (r.error) {
          lines.push(`❌ ${r.error}`);
        } else {
          lines.push(r.output);
        }
        lines.push("");
      }

      const hasErrors = results.some((r) => r.error);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        ...(hasErrors ? { isError: true } : {}),
      };
    },
  });
}
