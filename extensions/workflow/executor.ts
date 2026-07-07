/**
 * workflow executor — PR-10 / P2b (ADR 0032 §8).
 *
 * Deterministic DAG engine over a validated v1 WorkflowDoc. The engine has
 * ZERO topology freedom (W7): it can only execute / retry / degrade / abort
 * stages that exist in the persisted declaration — there is no API on this
 * module that adds, removes, or rewires stages at runtime (W8: any such
 * entry point = H5 = ADR 0030).
 *
 * Spec anchors:
 *  - W11 — on_fail routing consumes ONLY deterministic signals: the
 *    runner's terminal result (error/failureType), output-path existence
 *    (fs check), and run-level deadline/abort state. No LLM ever picks a
 *    branch; see classify sites tagged "W11" below.
 *  - W12 — GLOBAL semaphore ≤ maxConcurrency across the whole run (eager
 *    scheduling can overlap Kahn waves — the dry-run estimate is an
 *    authoring aid, THIS semaphore is the enforcing gate). Units: one
 *    agent stage = 1 unit; each parallel child = 1 unit.
 *  - W13 — every unit execution carries a stage label for C6 anchor
 *    derivation by the production runner (index.ts wraps dispatch's
 *    runInProcess with deriveSubAgentAnchor + heartbeatCtx; this module
 *    stays runner-agnostic so smoke can inject a fake runner).
 *  - §7 degrade — a degraded stage MUST still produce its output path
 *    (partial output + failure note). Path produced → degraded, needs
 *    satisfied downstream, downstream prompt carries a structured
 *    {"upstream_status":"degraded"} marker. Path NOT produced → failed.
 *    Degraded is never silent: the run result aggregates a degraded list.
 *  - §8 data contract — downstream stages receive upstream output as
 *    path + bounded summary (context throttling), never full transcripts.
 *    Downstream launch is preceded by a deterministic upstream-path
 *    existence check.
 *  - §8 resume forward-compat — per-stage completion is persisted to
 *    runDir/state.json after every terminal transition (v1 implements no
 *    resume, but the layout must not lock it out).
 *  - P0.6b — stage/state file writes are serialized through the per-key
 *    single-flight lock keyed on runDir (orthogonal to abrain git keys).
 *  - W10 — everything written here is execution trace (assistant-
 *    observed); nothing in this module feeds sediment/Tier-1.
 */

import * as fsSync from "node:fs";
import * as path from "node:path";
import { gitSingleFlight } from "../_shared/git-singleflight";
import {
  validateWorkflow,
  WORKFLOW_MAX_CONCURRENCY,
  type WorkflowDoc,
  type WorkflowStage,
} from "./dsl";

// ── Types ───────────────────────────────────────────────────────

/** C5 four-state terminal taxonomy (ADR 0027, inherited per W13). */
export type StageTerminal = "completed" | "failed" | "degraded" | "cancelled";

/** W11: closed enumeration of deterministic failure/cancel sources. Every
 *  non-completed record cites exactly one — auditable proof that no LLM
 *  chose the branch. */
export type FailureSource =
  | "runner_terminal"          // runner returned a terminal error
  | "output_write_failed"      // stage output path could not be produced
  | "upstream_output_missing"  // pre-launch deterministic path check failed
  | "run_timeout"              // whole-run timeout_minutes exceeded
  | "external_abort"           // caller's AbortSignal fired
  | "workflow_abort";          // a sibling failure aborted the run (on_fail policy)

export interface StageRunRequest {
  stageId: string;
  /** W13: label the production runner feeds to deriveSubAgentAnchor. */
  anchorLabel: string;
  model: string;
  thinking: string;
  prompt: string;
  /** Comma-joined allowlist; undefined → runner default (read-only set). */
  tools?: string;
  taskProfile?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Subset of dispatch's AgentResult the engine consumes. */
export interface StageRunResult {
  output: string;
  error?: string;
  failureType?: string;
  durationMs: number;
  usage?: { input: number; output: number; total: number; cost: number };
  toolCallCount?: number;
}

export type StageRunner = (req: StageRunRequest) => Promise<StageRunResult>;

export interface StageRecord {
  id: string;
  parent?: string;
  kind: "agent" | "parallel";
  status: StageTerminal;
  attempts: number;
  duration_ms: number;
  output_path?: string;
  /** parallel parent: all child output paths. */
  output_paths?: string[];
  error?: string;
  failure_source?: FailureSource;
  /** ids of degraded upstreams visible to this stage at launch. */
  degraded_upstreams?: string[];
  cost?: number;
  tool_call_count?: number;
}

export interface WorkflowRunResult {
  status: "completed" | "failed" | "degraded" | "cancelled";
  runId: string;
  stages: Record<string, StageRecord>;
  /** §7: degraded is never silent. */
  degraded: string[];
  durationMs: number;
  /** opus PR-10 R1 NIT-4: run-level cost roll-up (children included). */
  totalCost: number;
  statePath: string;
}

/** Injectable IO so smoke can force write failures (W11 output_write_failed
 *  is otherwise unreachable in tests without fs sabotage). */
export interface ExecutorIo {
  mkdirp(dir: string): void;
  writeFile(file: string, content: string): void;
  exists(file: string): boolean;
}

const realIo: ExecutorIo = {
  mkdirp: (d) => { fsSync.mkdirSync(d, { recursive: true }); },
  writeFile: (f, c) => { fsSync.writeFileSync(f, c, "utf-8"); },
  exists: (f) => fsSync.existsSync(f),
};

export interface WorkflowRunOptions {
  doc: WorkflowDoc;
  runId: string;
  /** .pi-astack/workflow/<runId> — also the per-key lock key (P0.6b). */
  runDir: string;
  runner: StageRunner;
  readOnly: boolean;
  defaultModel: string;
  defaultThinking: string;
  maxConcurrency?: number;
  perStageTimeoutMs?: number;
  signal?: AbortSignal;
  notify?: (msg: string) => void;
  /** Audit row sink (index.ts wires the anchor-spread JSONL writer). */
  audit?: (row: Record<string, unknown>) => void;
  io?: ExecutorIo;
  now?: () => number;
  /** Test-only seam: production uses the process-global W12 semaphore. */
  semaphore?: Semaphore;
}

// ── Internals ───────────────────────────────────────────────────

const SUMMARY_CHARS = 700;
const DEFAULT_STAGE_TIMEOUT_MS = 1_800_000; // mirrors dispatch DEFAULT_TIMEOUT_MS

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  /** introspection for W12 smoke */
  peakInUse(): number;
}

export function makeSemaphore(n: number): Semaphore {
  let free = n;
  let peak = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (free > 0) {
        free--;
        peak = Math.max(peak, n - free);
        return;
      }
      await new Promise<void>((r) => waiters.push(r));
      peak = Math.max(peak, n - free);
    },
    release() {
      const w = waiters.shift();
      if (w) w();
      else free++;
    },
    peakInUse: () => peak,
  };
}

const _WORKFLOW_SEMAPHORE_KEY = Symbol.for("pi-astack/workflow/global-semaphore/v1");

function globalWorkflowSemaphore(n: number): Semaphore {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[_WORKFLOW_SEMAPHORE_KEY] as { n: number; sem: Semaphore } | undefined;
  if (existing && existing.n === n) return existing.sem;
  const sem = makeSemaphore(n);
  g[_WORKFLOW_SEMAPHORE_KEY] = { n, sem };
  return sem;
}

/** Test seam for smoke. Production code never calls this. */
export function _resetWorkflowGlobalSemaphoreForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[_WORKFLOW_SEMAPHORE_KEY];
}

function stageFileName(id: string): string {
  return `stage-${id}.md`;
}

/** Human-readable markdown trace header (§8: dogfood 人工审计用). */
function renderStageFile(args: {
  runId: string;
  name: string;
  stage: { id: string; model: string };
  status: "completed" | "degraded";
  attempts: number;
  durationMs: number;
  failureNote?: string;
  output: string;
}): string {
  const lines = [
    "<!-- pi-astack workflow stage trace v1 — assistant-observed (W10): not Tier-1 material -->",
    `# workflow stage: ${args.stage.id}`,
    "",
    `- run: ${args.runId} (${args.name})`,
    `- status: ${args.status}`,
    `- model: ${args.stage.model}`,
    `- attempts: ${args.attempts}`,
    `- duration_ms: ${args.durationMs}`,
    `- finished_at: ${new Date().toISOString()}`,
  ];
  if (args.failureNote) {
    lines.push(`- failure_note: ${args.failureNote.replace(/[\r\n]+/g, " ").slice(0, 400)}`);
  }
  lines.push("", "---", "", args.output.length > 0 ? args.output : "(no output)");
  return lines.join("\n");
}

function summarize(output: string): string {
  return output.length > SUMMARY_CHARS ? `${output.slice(0, SUMMARY_CHARS)}\n…[truncated]` : output;
}

/** §8 data contract: path + bounded summary; §7 degraded marker structured. */
export function buildUpstreamBlock(
  needs: string[],
  records: Record<string, StageRecord>,
  summaries: Map<string, string>,
): string {
  if (needs.length === 0) return "";
  const lines = ["<workflow-upstream>"];
  for (const n of needs) {
    const rec = records[n];
    if (!rec) continue;
    const paths = rec.output_paths ?? (rec.output_path ? [rec.output_path] : []);
    lines.push(JSON.stringify({
      upstream_id: n,
      upstream_status: rec.status,
      output_paths: paths,
    }));
    const s = summaries.get(n);
    if (s) lines.push(`--- summary of "${n}" ---`, s);
  }
  lines.push("</workflow-upstream>");
  return lines.join("\n");
}

// ── Engine ──────────────────────────────────────────────────────

export async function executeWorkflow(opts: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const io = opts.io ?? realIo;
  const now = opts.now ?? Date.now;
  const notify = opts.notify ?? (() => {});
  const audit = opts.audit ?? (() => {});
  const maxConcurrency = Math.min(opts.maxConcurrency ?? WORKFLOW_MAX_CONCURRENCY, WORKFLOW_MAX_CONCURRENCY);
  const perStageTimeout = opts.perStageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;

  // Defense-in-depth: the engine refuses unvalidated docs even though the
  // command path always dry-runs first (gate (b) is presentation; this is
  // mechanical enforcement).
  const validation = validateWorkflow(opts.doc, { readOnly: opts.readOnly });
  if (!validation.ok) {
    throw new Error(`executeWorkflow: document failed validation: ${validation.errors[0]}`);
  }

  const startedAt = now();
  const deadline = startedAt + validation.summary!.timeoutMinutes * 60_000;
  // ADR 0033 N5: process-level global W12 semaphore shared by all concurrent
  // workflow runs. Tests may inject a local semaphore for deterministic probes.
  const sem = opts.semaphore ?? globalWorkflowSemaphore(maxConcurrency);

  // Run-scoped abort: external signal + deadline cut in-flight units.
  // A stage failure with on_fail!=degrade sets abortRequested (stop
  // scheduling new stages, let in-flight drain — their work is recorded).
  const runCtl = new AbortController();
  let abortRequested = false;
  const onExternalAbort = () => runCtl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) runCtl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const wallRemaining = () => deadline - now();
  // Deadline is enforced via BOTH a real timer (cuts in-flight units) and
  // deterministic wallRemaining() checks at every scheduling/finalize site
  // (so an injected now() in smoke — or a suspended laptop — still halts
  // without depending on timer delivery).
  const timedOut = () => wallRemaining() <= 0;
  const deadlineTimer = setTimeout(() => runCtl.abort(), Math.max(1, wallRemaining()));
  deadlineTimer.unref?.();
  const haltSignal = () => runCtl.signal.aborted || timedOut();

  const records: Record<string, StageRecord> = {};
  const summaries = new Map<string, string>();
  const stageById = new Map<string, WorkflowStage>(opts.doc.stages.map((s) => [s.id, s]));

  io.mkdirp(opts.runDir);
  const statePath = path.join(opts.runDir, "state.json");

  // P0.6b: serialize all writes for this run through the per-key lock
  // (key = runDir). Orthogonal to abrain repo keys by construction
  // (different resolved paths → different chains).
  const persistState = (status: string) => gitSingleFlight(opts.runDir, async () => {
    try {
      io.writeFile(statePath, JSON.stringify({
        schema_version: 1,
        run_id: opts.runId,
        name: opts.doc.name,
        status,
        started_at: new Date(startedAt).toISOString(),
        updated_at: new Date().toISOString(),
        stages: records,
      }, null, 2));
    } catch (e: unknown) {
      // State persistence is the resume layer, not the execution truth for
      // v1 (no resume). Loud-warn, keep running.
      notify(`workflow: state.json write failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  });

  const writeStageOutput = async (file: string, content: string): Promise<boolean> => {
    return gitSingleFlight(opts.runDir, async () => {
      try {
        io.writeFile(file, content);
        return io.exists(file); // W11: path existence is the deterministic signal
      } catch {
        return false;
      }
    });
  };

  const cancelSource = (): FailureSource =>
    opts.signal?.aborted ? "external_abort" : timedOut() ? "run_timeout" : "workflow_abort";

  const setRecord = async (rec: StageRecord, runStatus = "running") => {
    records[rec.id] = rec;
    audit({
      event: "stage_terminal",
      run_id: opts.runId,
      stage: rec.id,
      ...(rec.parent ? { parent: rec.parent } : {}),
      kind: rec.kind,
      status: rec.status,
      attempts: rec.attempts,
      duration_ms: rec.duration_ms,
      ...(rec.failure_source ? { failure_source: rec.failure_source } : {}),
      ...(rec.error ? { error: rec.error.slice(0, 300) } : {}),
      ...(typeof rec.cost === "number" ? { cost: rec.cost } : {}),
      ...(typeof rec.tool_call_count === "number" ? { tool_call_count: rec.tool_call_count } : {}),
    });
    await persistState(runStatus);
  };

  /** Run one agent unit (top-level agent stage or parallel child) behind
   *  the GLOBAL semaphore (W12), with on_fail-aware retry loop. */
  const runUnit = async (
    stage: WorkflowStage,
    parent: WorkflowStage | undefined,
    upstreamBlock: string,
    maxAttempts: number,
  ): Promise<{ res: StageRunResult; attempts: number }> => {
    const model = stage.model ?? opts.defaultModel;
    const thinking = stage.thinking ?? opts.defaultThinking;
    const prompt = upstreamBlock ? `${upstreamBlock}\n\n${stage.prompt}` : (stage.prompt ?? "");
    let attempts = 0;
    let res: StageRunResult = { output: "", error: "not started", durationMs: 0 };
    while (attempts < maxAttempts) {
      attempts++;
      if (haltSignal()) {
        res = { output: "", error: "aborted before attempt", failureType: "aborted", durationMs: 0 };
        break;
      }
      await sem.acquire();
      try {
        if (haltSignal()) {
          res = { output: "", error: "aborted before attempt", failureType: "aborted", durationMs: 0 };
          break;
        }
        // deepseek PR-10 R1 NIT-1: compute AFTER acquire — a saturated
        // semaphore can hold a unit for minutes; a pre-acquire snapshot
        // would grant stale wall budget past the run deadline.
        const timeoutMs = Math.min(perStageTimeout, Math.max(1, wallRemaining()));
        res = await opts.runner({
          stageId: stage.id,
          anchorLabel: `workflow[${opts.doc.name}].stage[${parent ? `${parent.id}/` : ""}${stage.id}]`,
          model,
          thinking,
          prompt,
          ...(stage.tools && stage.tools.length > 0 ? { tools: stage.tools.join(",") } : {}),
          ...(stage.taskProfile ?? stage.profile ? { taskProfile: stage.taskProfile ?? stage.profile } : {}),
          timeoutMs,
          signal: runCtl.signal,
        });
      } catch (e: unknown) {
        res = {
          output: "",
          error: `runner crashed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
          failureType: "crash",
          durationMs: 0,
        };
      } finally {
        sem.release();
      }
      // W11: retry routing keyed ONLY on the runner's deterministic
      // terminal result. Don't burn retries once the run is aborted.
      if (!res.error || haltSignal()) break;
    }
    return { res, attempts };
  };

  /** Materialize a unit terminal into (status, file write) per §7/§8.
   *  Returns the StageRecord. W11: every branch below keys on res.error,
   *  runCtl/abort state, or io.exists — never on LLM output content. */
  const finalizeUnit = async (
    stage: WorkflowStage,
    parent: WorkflowStage | undefined,
    res: StageRunResult,
    attempts: number,
    onFail: "retry" | "degrade" | "abort",
    startMs: number,
  ): Promise<StageRecord> => {
    const model = stage.model ?? opts.defaultModel;
    const file = path.join(opts.runDir, stageFileName(stage.id));
    const base: StageRecord = {
      id: stage.id,
      ...(parent ? { parent: parent.id } : {}),
      kind: "agent",
      status: "failed",
      attempts,
      duration_ms: now() - startMs,
      ...(typeof res.usage?.cost === "number" ? { cost: res.usage.cost } : {}),
      ...(typeof res.toolCallCount === "number" ? { tool_call_count: res.toolCallCount } : {}),
    };
    if (res.error && haltSignal()) {
      // In-flight unit cut by external abort / run timeout → cancelled
      // (C5 distinction from failed), not chargeable to the stage.
      return { ...base, status: "cancelled", error: res.error, failure_source: cancelSource() };
    }
    if (!res.error) {
      const ok = await writeStageOutput(file, renderStageFile({
        runId: opts.runId, name: opts.doc.name,
        stage: { id: stage.id, model }, status: "completed",
        attempts, durationMs: res.durationMs, output: res.output,
      }));
      if (!ok) return { ...base, status: "failed", error: "output file write failed", failure_source: "output_write_failed" };
      summaries.set(stage.id, summarize(res.output));
      return { ...base, status: "completed", output_path: file };
    }
    if (onFail === "degrade") {
      // §7: degraded MUST still produce its output path (partial output +
      // failure note); produced → degraded; not produced → failed.
      const ok = await writeStageOutput(file, renderStageFile({
        runId: opts.runId, name: opts.doc.name,
        stage: { id: stage.id, model }, status: "degraded",
        attempts, durationMs: res.durationMs,
        failureNote: res.error, output: res.output,
      }));
      if (!ok) return { ...base, status: "failed", error: res.error, failure_source: "output_write_failed" };
      summaries.set(stage.id, `[degraded: ${res.error.slice(0, 160)}]\n${summarize(res.output)}`);
      return { ...base, status: "degraded", output_path: file, error: res.error, failure_source: "runner_terminal" };
    }
    return { ...base, status: "failed", error: res.error, failure_source: "runner_terminal" };
  };

  /** Launch one top-level stage (agent or parallel aggregate). */
  const launchStage = async (stage: WorkflowStage): Promise<void> => {
    const startMs = now();
    const needs = stage.needs ?? [];
    const onFail = stage.on_fail ?? "abort";
    const maxAttempts = onFail === "retry" ? 1 + (stage.max_retries ?? 1) : 1;

    // §8: deterministic upstream output-path existence check before launch.
    for (const n of needs) {
      const rec = records[n];
      const paths = rec?.output_paths ?? (rec?.output_path ? [rec.output_path] : []);
      const missing = paths.filter((p) => !io.exists(p));
      if (!rec || missing.length > 0) {
        abortRequested = true;
        await setRecord({
          id: stage.id, kind: stage.kind, status: "failed", attempts: 0,
          duration_ms: 0, failure_source: "upstream_output_missing",
          error: `upstream "${n}" output missing: ${missing.join(", ") || "(no record)"}`,
        });
        return;
      }
    }
    const degradedUps = needs.filter((n) => records[n]?.status === "degraded");
    const upstreamBlock = buildUpstreamBlock(needs, records, summaries);

    if (stage.kind === "agent") {
      const { res, attempts } = await runUnit(stage, undefined, upstreamBlock, maxAttempts);
      const rec = await finalizeUnit(stage, undefined, res, attempts, onFail, startMs);
      if (degradedUps.length > 0) rec.degraded_upstreams = degradedUps;
      if (rec.status === "failed") abortRequested = true;
      await setRecord(rec);
      notify(`workflow stage "${stage.id}": ${rec.status}${rec.error ? ` (${rec.error.slice(0, 100)})` : ""}`);
      return;
    }

    // parallel aggregate: children are units behind the SAME global
    // semaphore; the parent's on_fail policy governs the aggregate.
    const children = stage.children ?? [];
    const childRecords = new Map<string, StageRecord>();
    let attempt = 0;
    let pendingChildren = [...children];
    while (attempt < maxAttempts && pendingChildren.length > 0) {
      attempt++;
      const settled = await Promise.all(pendingChildren.map(async (c) => {
        const { res, attempts: ca } = await runUnit(c, stage, upstreamBlock, 1);
        // children have no own on_fail (validated); degrade policy applies
        // at finalize time only on the FINAL attempt.
        const isFinalAttempt = attempt >= maxAttempts;
        const childPolicy = isFinalAttempt && onFail === "degrade" ? "degrade" : "abort";
        const rec = await finalizeUnit(c, stage, res, ca, childPolicy, startMs);
        // opus PR-10 R1 NIT-1: a child settles in wave `attempt` after
        // running once per wave since wave 1 — record the real run count,
        // not runUnit's per-wave counter.
        rec.attempts = attempt;
        return rec;
      }));
      for (const rec of settled) childRecords.set(rec.id, rec);
      // retry only children that did not reach completed/degraded
      pendingChildren = pendingChildren.filter((c) => {
        const st = childRecords.get(c.id)?.status;
        return st !== "completed" && st !== "degraded";
      });
      if (onFail !== "retry") break;
      if (haltSignal()) break;
    }
    for (const rec of childRecords.values()) await setRecord(rec);

    const childList = [...childRecords.values()];
    const anyCancelled = childList.some((r) => r.status === "cancelled");
    const anyFailed = childList.some((r) => r.status === "failed") || childList.length < children.length;
    const anyDegraded = childList.some((r) => r.status === "degraded");
    const okPaths = childList.flatMap((r) => (r.output_path ? [r.output_path] : []));
    const aggStatus: StageTerminal = anyFailed ? "failed" : anyCancelled ? "cancelled" : anyDegraded ? "degraded" : "completed";
    const agg: StageRecord = {
      id: stage.id, kind: "parallel", status: aggStatus,
      attempts: attempt, duration_ms: now() - startMs,
      output_paths: okPaths,
      ...(degradedUps.length > 0 ? { degraded_upstreams: degradedUps } : {}),
      ...(aggStatus === "failed" ? {
        error: `children failed: ${childList.filter((r) => r.status === "failed").map((r) => r.id).join(",") || "(missing)"}`,
        failure_source: "runner_terminal" as FailureSource,
      } : {}),
      ...(aggStatus === "cancelled" ? { failure_source: cancelSource() } : {}),
    };
    if (aggStatus === "degraded") {
      summaries.set(stage.id, childList.map((r) => `child "${r.id}": ${r.status}`).join("\n"));
    } else if (aggStatus === "completed") {
      summaries.set(stage.id, childList.map((r) => `child "${r.id}": completed → ${r.output_path}`).join("\n"));
    }
    if (aggStatus === "failed") abortRequested = true;
    await setRecord(agg);
    notify(`workflow stage "${stage.id}" (parallel ×${children.length}): ${aggStatus}`);
  };

  // ── Eager scheduler (W12 semaphore is the concurrency authority) ──
  const pending = new Set(validation.summary!.order);
  const running = new Map<string, Promise<void>>();
  try {
    while (pending.size > 0 || running.size > 0) {
      const halted = abortRequested || haltSignal();
      if (halted) {
        for (const id of [...pending]) {
          pending.delete(id);
          await setRecord({
            id, kind: stageById.get(id)!.kind, status: "cancelled", attempts: 0,
            duration_ms: 0,
            failure_source: abortRequested && !haltSignal() ? "workflow_abort" : cancelSource(),
          });
        }
      } else {
        for (const id of [...pending]) {
          const st = stageById.get(id)!;
          const needs = st.needs ?? [];
          const upStates = needs.map((n) => records[n]?.status);
          if (upStates.some((s) => s === "failed" || s === "cancelled")) {
            pending.delete(id);
            await setRecord({
              id, kind: st.kind, status: "cancelled", attempts: 0, duration_ms: 0,
              failure_source: "workflow_abort",
              error: `upstream not satisfied: ${needs.filter((n) => records[n]?.status === "failed" || records[n]?.status === "cancelled").join(",")}`,
            });
            continue;
          }
          // §7: completed AND degraded both satisfy needs.
          if (upStates.every((s) => s === "completed" || s === "degraded")) {
            pending.delete(id);
            const p = launchStage(st)
              .catch(async (e: unknown) => {
                // Engine bug guard: a launch must never reject silently.
                // opus NIT-2 / gpt N4 (PR-10 R1): route through setRecord so
                // the crash gets an audit row + state.json persist like every
                // other terminal, not a records[]-only side write.
                abortRequested = true;
                await setRecord({
                  id, kind: st.kind, status: "failed", attempts: 0, duration_ms: 0,
                  failure_source: "runner_terminal",
                  error: `launch crashed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
                });
              })
              .finally(() => { running.delete(id); });
            running.set(id, p);
          }
        }
      }
      if (running.size > 0) {
        await Promise.race(running.values());
      } else if (pending.size > 0 && !abortRequested && !haltSignal()) {
        // Unreachable for validated acyclic docs — defensive halt.
        abortRequested = true;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }

  const topRecords = validation.summary!.order.map((id) => records[id]).filter(Boolean) as StageRecord[];
  const degraded = Object.values(records).filter((r) => r.status === "degraded").map((r) => r.id);
  const anyFailed = topRecords.some((r) => r.status === "failed");
  const anyCancelled = topRecords.some((r) => r.status === "cancelled");
  const status: WorkflowRunResult["status"] =
    anyFailed ? "failed" : anyCancelled ? "cancelled" : degraded.length > 0 ? "degraded" : "completed";
  const durationMs = now() - startedAt;
  const totalCost = Object.values(records).reduce((s, r) => s + (typeof r.cost === "number" ? r.cost : 0), 0);
  audit({
    event: "run_terminal",
    run_id: opts.runId,
    name: opts.doc.name,
    status,
    duration_ms: durationMs,
    total_cost: totalCost,
    degraded,
    stage_counts: {
      completed: topRecords.filter((r) => r.status === "completed").length,
      failed: topRecords.filter((r) => r.status === "failed").length,
      degraded: topRecords.filter((r) => r.status === "degraded").length,
      cancelled: topRecords.filter((r) => r.status === "cancelled").length,
    },
  });
  await persistState(status);
  return { status, runId: opts.runId, stages: records, degraded, durationMs, totalCost, statePath };
}
