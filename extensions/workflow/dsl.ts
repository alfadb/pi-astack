/**
 * workflow DSL v1 — types + deterministic validation (PR-9 / ADR 0032 §7).
 *
 * NORMATIVE SOURCE: docs/adr/0032-goal-runtime-and-declarative-workflow.md.
 * Every rule here cites its ADR clause. Validation is DETERMINISTIC CODE,
 * never an LLM (§7) — dry-run is gate (b) of the user-authority triple
 * (persisted artifact + dry-run presented + explicit invoke, §6).
 *
 * v1 boundary (§7, 合议钉死):
 *   - schema_version === 1, unknown → reject
 *   - stage id globally unique (children included); needs reference
 *     TOP-LEVEL stage ids only
 *   - parallel.children: kind=agent only, no needs, no nested parallel,
 *     not referenceable by external needs (parallel = aggregate DAG node)
 *   - tools: whitelist-validated; dispatch-class tools UNCONDITIONALLY
 *     rejected (§6 H5 软肋闭合 — a stage with spawn tools is a de-facto
 *     hub regardless of fixed topology); unknown tools rejected
 *   - mutating tools require BOTH stage `mutating: true` (per-stage
 *     explicit declaration, W9) AND workflow.readOnly=false; readOnly
 *     violations are dry-run FAILURES, never silent stripping
 *   - on_fail ∈ {retry, degrade, abort}; max_retries only with retry
 *   - DAG acyclic; estimated peak concurrency ≤ MAX (W12 pre-check;
 *     the PR-10 engine ALSO enforces a global semaphore at runtime)
 *
 * PR-9 scope: parse + validate + dry-run report ONLY. No execution —
 * that is PR-10 (after the dispatch shared-runner API extraction).
 */

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

/** Keep in sync with extensions/dispatch/index.ts MAX_CONCURRENCY (=4).
 *  PR-10 imports the real constant once the shared runner API is
 *  extracted; duplicating the literal here keeps PR-9 free of a
 *  dependency on dispatch internals. */
export const WORKFLOW_MAX_CONCURRENCY = 4;

/** Read-only tool surface — mirrors dispatch's default sub-agent
 *  allowlist (dispatch/index.ts:625). */
export const READONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "web_search", "web_fetch",
  "memory_search", "memory_get", "memory_neighbors", "memory_decide",
  // opus R1 F2: dispatch KNOWN_TOOLS additionally accepts memory_list —
  // keep the requestable read-only surface aligned.
  "memory_list",
]);

/** Mutating tools (W9: per-stage `mutating: true` + workflow.readOnly=false
 *  + PI_MULTI_AGENT_ALLOW_MUTATING=1 at runtime). */
export const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

/** §6 M1: spawn-class tools are FORBIDDEN in stage tools regardless of any
 *  flag — a stage that can dispatch is a de-facto hub (H5). Lifting this
 *  requires ADR 0030, not a settings change. */
export const FORBIDDEN_TOOLS = new Set([
  "dispatch_agent", "dispatch_parallel", "dispatch_parallel_subagent",
]);

export type StageKind = "agent" | "parallel";
export type OnFail = "retry" | "degrade" | "abort";

export interface WorkflowStage {
  id: string;
  kind: StageKind;
  model?: string;
  thinking?: string;
  prompt?: string;
  tools?: string[];
  mutating?: boolean;
  needs?: string[];
  on_fail?: OnFail;
  max_retries?: number;
  children?: WorkflowStage[];
}

export interface WorkflowDoc {
  schema_version: number;
  name: string;
  timeout_minutes?: number;
  stages: WorkflowStage[];
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary?: {
    name: string;
    stageCount: number;
    /** Topological order of top-level stage ids (Kahn). */
    order: string[];
    /** Kahn levels: stages with no unmet deps grouped per wave. */
    levels: string[][];
    /** Peak concurrent dispatch-unit demand (agent=1, parallel=min(children,4)). */
    estConcurrency: number;
    mutatingStages: string[];
    timeoutMinutes: number;
  };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_TIMEOUT_MINUTES = 60;
const MAX_TIMEOUT_MINUTES = 24 * 60;
const MAX_STAGES = 32;
const MAX_CHILDREN = 16; // dispatch_parallel MAX_PARALLEL
const MAX_RETRIES_CAP = 3;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Parse raw JSON text into a WorkflowDoc candidate. JSON errors are
 *  validation errors, not exceptions (C6 posture: malformed input →
 *  structured failure). */
export function parseWorkflowJson(raw: string): { doc?: WorkflowDoc; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    return { error: `invalid JSON: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "root must be a JSON object" };
  }
  return { doc: parsed as WorkflowDoc };
}

/** Deterministic v1 validation per ADR 0032 §7. `readOnly` is the
 *  effective workflow.readOnly setting at validation time. */
export function validateWorkflow(doc: WorkflowDoc, opts: { readOnly: boolean }): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => { errors.push(m); };

  // ── document level ──
  if (doc.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    err(`schema_version must be ${WORKFLOW_SCHEMA_VERSION} (got ${JSON.stringify(doc.schema_version)}) — unknown versions are rejected (ADR 0032 §7)`);
  }
  if (typeof doc.name !== "string" || !doc.name.trim()) err("name: required non-empty string");
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  if (doc.timeout_minutes !== undefined) {
    // gpt R1 N3: integer required — 0.5 would floor to a 0min report.
    if (typeof doc.timeout_minutes !== "number" || !Number.isInteger(doc.timeout_minutes) || doc.timeout_minutes < 1 || doc.timeout_minutes > MAX_TIMEOUT_MINUTES) {
      err(`timeout_minutes: must be an integer in [1, ${MAX_TIMEOUT_MINUTES}]`);
    } else {
      timeoutMinutes = doc.timeout_minutes;
    }
  }
  if (!Array.isArray(doc.stages) || doc.stages.length === 0) {
    err("stages: required non-empty array");
    return { ok: false, errors, warnings };
  }
  if (doc.stages.length > MAX_STAGES) err(`stages: at most ${MAX_STAGES} top-level stages`);

  // ── id uniqueness across the WHOLE document (children included, §7) ──
  const allIds = new Set<string>();
  const topIds = new Set<string>();
  const registerId = (id: unknown, where: string): id is string => {
    if (typeof id !== "string" || !ID_RE.test(id)) {
      err(`${where}: id must match ${ID_RE} (got ${JSON.stringify(id)})`);
      return false;
    }
    if (allIds.has(id)) {
      err(`${where}: duplicate id "${id}" (ids are globally unique, children included)`);
      return false;
    }
    allIds.add(id);
    return true;
  };

  const mutatingStages: string[] = [];

  const validateToolsAndFlags = (s: WorkflowStage, where: string) => {
    let hasMutatingTool = false;
    if (s.tools !== undefined) {
      if (!Array.isArray(s.tools) || s.tools.some((t) => typeof t !== "string")) {
        err(`${where}: tools must be an array of strings`);
      } else {
        for (const rawTool of s.tools) {
          // deepseek R1 N1: case-normalize like dispatch's validateTools —
          // "Dispatch_Agent" must hit the FORBIDDEN message (not "unknown"),
          // and "Read" must pass. Either way variants were already rejected
          // (fail-closed); this aligns message precision with dispatch.
          const t = rawTool.toLowerCase().trim();
          if (FORBIDDEN_TOOLS.has(t)) {
            // H5 软肋闭合 (§6 M1): hard reject, NOT a warning. Lifting = ADR 0030.
            err(`${where}: tool "${t}" is a spawn-class tool — FORBIDDEN in workflow stages (ADR 0032 §6: a stage that can dispatch is a de-facto hub; lifting this gate requires ADR 0030)`);
          } else if (MUTATING_TOOLS.has(t)) {
            hasMutatingTool = true;
          } else if (!READONLY_TOOLS.has(t)) {
            err(`${where}: unknown tool ${JSON.stringify(rawTool)} (whitelist: ${[...READONLY_TOOLS, ...MUTATING_TOOLS].join(", ")})`);
          }
        }
      }
    }
    // W9 per-stage explicit declaration: mutating tools ⇔ mutating:true.
    if (hasMutatingTool && s.mutating !== true) {
      err(`${where}: stage uses mutating tools but does not declare "mutating": true (W9 per-stage explicit declaration)`);
    }
    if (s.mutating === true && !hasMutatingTool) {
      warnings.push(`${where}: declares mutating:true but lists no mutating tool — declaration is inert`);
    }
    if (s.mutating === true && opts.readOnly) {
      // §7: dry-run FAILURE, never silent stripping.
      err(`${where}: mutating stage but workflow.readOnly=true — dry-run fails (tools are never silently stripped); set workflow.readOnly=false AND run with PI_MULTI_AGENT_ALLOW_MUTATING=1 (W9 triple-explicit)`);
    }
    if (s.mutating === true) mutatingStages.push(s.id);
    if (s.thinking !== undefined && (typeof s.thinking !== "string" || !THINKING_LEVELS.has(s.thinking))) {
      err(`${where}: thinking must be one of ${[...THINKING_LEVELS].join("/")}`);
    }
    if (s.model !== undefined && (typeof s.model !== "string" || !/^[^/]+\/.+$/.test(s.model))) {
      err(`${where}: model must be "provider/model"`);
    }
    if (typeof s.prompt !== "string" || !s.prompt.trim()) err(`${where}: prompt required non-empty string`);
  };

  const validateOnFail = (s: WorkflowStage, where: string) => {
    const onFail = s.on_fail ?? "abort";
    if (onFail !== "retry" && onFail !== "degrade" && onFail !== "abort") {
      err(`${where}: on_fail must be retry|degrade|abort`);
      return;
    }
    if (s.max_retries !== undefined) {
      if (onFail !== "retry") err(`${where}: max_retries only valid with on_fail:"retry"`);
      else if (typeof s.max_retries !== "number" || !Number.isInteger(s.max_retries) || s.max_retries < 1 || s.max_retries > MAX_RETRIES_CAP) {
        err(`${where}: max_retries must be an integer in [1, ${MAX_RETRIES_CAP}]`);
      }
    }
  };

  // ── per-stage structural validation ──
  for (const s of doc.stages) {
    if (!s || typeof s !== "object") { err("stages[]: each stage must be an object"); continue; }
    const idOk = registerId(s.id, `stage ${JSON.stringify(s.id)}`);
    if (idOk) topIds.add(s.id);
    // deepseek R1 N3: JSON.stringify the id in diagnostics — a rejected id
    // like `a"b` must not corrupt the error-message framing.
    const where = `stage ${typeof s.id === "string" ? JSON.stringify(s.id) : "\"?\""}`;
    if (s.kind !== "agent" && s.kind !== "parallel") {
      err(`${where}: kind must be "agent" | "parallel"`);
      continue;
    }
    validateOnFail(s, where);
    if (s.kind === "agent") {
      if (s.children !== undefined) err(`${where}: children only valid on kind:"parallel"`);
      validateToolsAndFlags(s, where);
    } else {
      // parallel = aggregate DAG node (§7): children agent-only, no needs,
      // no nesting, not externally referenceable.
      if (s.prompt !== undefined) warnings.push(`${where}: parallel stage prompt is ignored (children carry the prompts)`);
      if (s.tools !== undefined || s.mutating !== undefined || s.model !== undefined || s.thinking !== undefined) {
        err(`${where}: parallel stage must not carry tools/mutating/model/thinking — declare them per child`);
      }
      if (!Array.isArray(s.children) || s.children.length === 0) {
        err(`${where}: parallel requires non-empty children[]`);
        continue;
      }
      if (s.children.length > MAX_CHILDREN) err(`${where}: at most ${MAX_CHILDREN} children (dispatch_parallel cap)`);
      for (const c of s.children) {
        if (!c || typeof c !== "object") { err(`${where}: children[] entries must be objects`); continue; }
        registerId(c.id, `${where} child ${JSON.stringify(c.id)}`);
        const cw = `${where} child ${typeof c.id === "string" ? JSON.stringify(c.id) : "\"?\""}`;
        if (c.kind !== "agent") err(`${cw}: parallel children must be kind:"agent" (no nested parallel)`);
        if (c.needs !== undefined) err(`${cw}: children must not declare needs (parallel is an aggregate node)`);
        if (c.children !== undefined) err(`${cw}: children must not nest`);
        if (c.on_fail !== undefined || c.max_retries !== undefined) err(`${cw}: on_fail/max_retries live on the parallel stage, not children`);
        validateToolsAndFlags(c, cw);
      }
    }
  }

  // ── needs: top-level ids only (children unreferenceable) + DAG ──
  const adj = new Map<string, string[]>(); // id -> needs
  for (const s of doc.stages) {
    if (typeof s.id !== "string" || !topIds.has(s.id)) continue;
    const needs: string[] = [];
    if (s.needs !== undefined) {
      if (!Array.isArray(s.needs) || s.needs.some((n) => typeof n !== "string")) {
        err(`stage "${s.id}": needs must be an array of stage ids`);
      } else {
        const seen = new Set<string>();
        for (const n of s.needs) {
          // deepseek R1 N4: duplicates are edge-set no-ops but the author
          // should hear about them.
          if (seen.has(n)) { warnings.push(`stage "${s.id}": duplicate needs entry "${n}"`); continue; }
          seen.add(n);
          if (n === s.id) err(`stage "${s.id}": needs itself`);
          else if (topIds.has(n)) needs.push(n);
          else if (allIds.has(n)) err(`stage "${s.id}": needs "${n}" refers to a parallel CHILD — children are not addressable (parallel is an aggregate node, ADR 0032 §7)`);
          else err(`stage "${s.id}": needs unknown stage "${n}"`);
        }
      }
    }
    adj.set(s.id, needs);
  }

  // Kahn topological sort → cycle detection + levels + concurrency estimate.
  const order: string[] = [];
  const levels: string[][] = [];
  let estConcurrency = 0;
  if (errors.length === 0) {
    const remaining = new Map<string, Set<string>>();
    for (const [id, needs] of adj) remaining.set(id, new Set(needs));
    const done = new Set<string>();
    while (done.size < remaining.size) {
      const wave = [...remaining.entries()]
        .filter(([id, needs]) => !done.has(id) && [...needs].every((n) => done.has(n)))
        .map(([id]) => id);
      if (wave.length === 0) {
        const stuck = [...remaining.keys()].filter((id) => !done.has(id));
        err(`dependency cycle detected among: ${stuck.join(", ")}`);
        break;
      }
      levels.push(wave);
      // W12 pre-check: agent stage = 1 dispatch unit; parallel stage =
      // min(children, 4) concurrent units (dispatch_parallel self-caps).
      const width = wave.reduce((acc, id) => {
        const st = doc.stages.find((s) => s.id === id)!;
        return acc + (st.kind === "parallel" ? Math.min(st.children?.length ?? 0, WORKFLOW_MAX_CONCURRENCY) : 1);
      }, 0);
      estConcurrency = Math.max(estConcurrency, width);
      for (const id of wave) { done.add(id); order.push(id); }
    }
    if (estConcurrency > WORKFLOW_MAX_CONCURRENCY) {
      err(`estimated peak concurrency ${estConcurrency} > ${WORKFLOW_MAX_CONCURRENCY} (W12) — add needs ordering so concurrent dispatch demand stays within the global cap (the PR-10 engine also enforces a runtime semaphore; dry-run requires the plan itself to fit)`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    errors,
    warnings,
    summary: {
      name: doc.name,
      stageCount: doc.stages.length,
      order,
      levels,
      estConcurrency,
      mutatingStages,
      timeoutMinutes,
    },
  };
}

/** Human-readable dry-run report (gate (b) of §6: the user must SEE the
 *  validated plan before any execution is possible). */
export function formatDryRunReport(result: WorkflowValidationResult, opts: { readOnly: boolean; enabled: boolean }): string {
  const lines: string[] = [];
  if (!result.ok) {
    lines.push(`✗ workflow dry-run FAILED (${result.errors.length} error${result.errors.length > 1 ? "s" : ""})`);
    for (const e of result.errors) lines.push(`  - ${e}`);
  } else {
    const s = result.summary!;
    // deepseek R1 N2: name is user file content — strip control chars so it
    // cannot corrupt the gate-(b) report framing.
    // eslint-disable-next-line no-control-regex
    const safeName = s.name.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 120);
    lines.push(`✓ workflow "${safeName}" valid — ${s.stageCount} stage(s), timeout ${s.timeoutMinutes}min`);
    lines.push(`  plan: ${s.levels.map((l) => l.join(" | ")).join("  →  ")}`);
    // opus R1 F1 honesty note: this is the Kahn WAVE-WIDTH estimate, not the
    // true DAG antichain — eager scheduling can overlap stages across waves,
    // so the PR-10 runtime global semaphore (W12) is the authority; this
    // number is an authoring aid, not the enforcement.
    lines.push(`  peak concurrency (wave estimate): ${s.estConcurrency}/${WORKFLOW_MAX_CONCURRENCY} — runtime semaphore is the enforcing gate`);
    lines.push(s.mutatingStages.length
      ? `  ⚠ mutating stages: ${s.mutatingStages.join(", ")} (requires PI_MULTI_AGENT_ALLOW_MUTATING=1 at runtime)`
      : "  read-only: all stages");
  }
  for (const w of result.warnings) lines.push(`  ~ ${w}`);
  if (!opts.enabled) lines.push("  note: workflow.enabled=false — execution channel disabled (validation only; PR-10 executor not yet shipped)");
  return lines.join("\n");
}
