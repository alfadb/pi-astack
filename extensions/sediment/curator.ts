import * as path from "node:path";
import * as fs from "node:fs";
import type { MemorySettings } from "../memory/settings";
import { loadEntries } from "../memory/parser";
import { llmSearchEntries } from "../memory/llm-search";
import type { MemoryEntry } from "../memory/types";
import { ensureUserGlobalSidecarMigrated, userGlobalSedimentDir } from "../_shared/runtime";
import type { SedimentSettings } from "./settings";
import { sanitizeForMemory } from "./sanitizer";
import type { DeleteMode, ProjectEntryDraft, ProjectEntryUpdateDraft } from "./writer";
import type { CorrectionSignal } from "./correction-pipeline";
import { runMultiView, type MultiViewResult } from "./multi-view";

// ── Curator metrics (mirrors extractor-metrics.jsonl pattern) ─────────────
// User-global cross-project sidecar (ADR 0025 §4.2.4): lives under
// <abrainHome>/.state/sediment/, not user-home-derived ~/.pi/.pi-astack/.
function logCuratorMetrics(entry: {
  ts: string;
  model: string;
  promptChars: number;
  estimatedTokens: number;
  ok: boolean;
  durationMs: number;
}): void {
  try {
    ensureUserGlobalSidecarMigrated();
    const dir = userGlobalSedimentDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(path.join(dir, "curator-metrics.jsonl"), line, "utf-8");
  } catch {
    // metrics are best-effort; never throw
  }
}

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export type CuratorDecision =
  | { op: "create"; scope?: "world"; derives_from?: string[]; rationale?: string }
  | { op: "update"; slug: string; scope?: "world"; patch: ProjectEntryUpdateDraft; rationale?: string }
  | { op: "merge"; target: string; sources: string[]; scope?: "world"; compiledTruth: string; timelineNote?: string; rationale?: string }
  | { op: "archive"; slug: string; scope?: "world"; reason: string; rationale?: string }
  | { op: "supersede"; oldSlug: string; newSlug?: string; scope?: "world"; reason: string; rationale?: string }
  | { op: "delete"; slug: string; mode: DeleteMode; scope?: "world"; reason: string; rationale?: string }
  | { op: "skip"; reason: string; rationale?: string };

export interface CuratorAudit {
  decision: CuratorDecision;
  neighbors: Array<{ slug: string; score?: number; rank_reason?: string }>;
  stage_ms: { search: number; decide: number; total: number };
  error?: string;
  /** ADR 0025 P0.5: multi-view verification result, present only when
   *  the proposer's decision triggered review (high-value ops). When
   *  absent, the proposer's decision was treated as authoritative.
   *  When present + triggered=true + final_decision differs from
   *  proposer decision: the writer executed the reviewer's verdict
   *  (confirm_pass1 or defer→skip), and audit readers can compare
   *  the original `proposer_decision` field against `decision` to
   *  see what was overridden. */
  multi_view?: {
    triggered: boolean;
    trigger_reason?: string;
    proposer_decision?: CuratorDecision;
    pass1?: {
      model: string;
      op: string;
      scope?: string;
      slug_target?: string | null;
      confidence?: number;
      key_evidence_quote?: string;
      strongest_objection_to_your_own_op?: string;
      reasoning?: string;
      durationMs: number;
    };
    pass2?: {
      model: string;
      verdict: "confirm_proposer" | "confirm_pass1" | "defer";
      rationale?: string;
      anchor_bias_self_check?: string;
      devils_advocate_objection?: string;
      missed_evidence_quote?: string | null;
      durationMs: number;
    };
    error?: string;
    /** Batch 3b: set when runMultiView staged the candidate for replay
     *  on one of the 6 transient-failure paths. When present, `decision`
     *  is guaranteed to be op=skip(multiview_staged_for_replay). The
     *  audit consumer should NOT treat this as a brain write; replay
     *  at next agent_end may produce a real decision. */
    staged?: {
      slug: string;
      state: string;        // MultiviewPendingState; kept as string
                            // here to avoid leaking the union from
                            // multiview-staging-types into the audit
                            // schema (audit is consumed by external
                            // tools that should not be coupled).
      path: string;
    };
    durationMs: number;
  };
}

export interface CuratorOutcome {
  decision: CuratorDecision;
  audit: CuratorAudit;
}

/**
 * Typed reject error for curator policy violations. Carries a stable
 * machine-readable `code` so the outer catch in curateProjectDraft can
 * surface it as the audit-row `reason` — preserving the grep-ability
 * the pre-2d2b010 `entry_not_found` row had (round-2 review Opus P1-2
 * + gpt-5.5 P2 "curator_error conflates failure modes").
 *
 * Anything thrown without this class still falls through to the generic
 * `curator_error` bucket (JSON parse failures, callCuratorModel errors,
 * unexpected exceptions), so true model/transport errors remain distinct
 * from LLM-side policy violations.
 *
 * Stable code set (do not rename without coordinating with whoever is
 * counting audit buckets):
 *
 *   - workflow_lane_read_only
 *       any write op (update/supersede/merge/archive/delete) targets
 *       a workflow-lane neighbor; the writer cannot reach it.
 *
 *   - scope_mismatch_world_on_non_world_neighbor
 *       scope:"world" on a non-world existing neighbor.
 *
 *   - scope_mismatch_project_on_world_neighbor
 *       scope omitted but the existing neighbor is world-scope.
 *
 *   - invented_neighbor_slug
 *       any op's slug field (update.slug, merge.target/sources,
 *       archive/delete/supersede slug, create.derives_from) references
 *       a slug not in the candidate neighbor list.
 *
 *   - world_create_from_non_world_source
 *       create with scope:"world" whose derives_from contains a
 *       project- or workflow-scope neighbor.
 *
 *   - malformed_curator_op
 *       structural issues with the curator decision: non-object
 *       payload, unsupported op, merge missing compiled_truth, etc.
 *       Not the same as unparseable JSON (which stays under generic
 *       `curator_error`, since that often signals transport truncation
 *       rather than LLM intent).
 *
 * (Round-3 2026-05-19 follow-up: the round-2 fix only typed validateScope's
 * three throws; the remaining 10+ throws in parseDecision were still plain
 * Error, so audit row 22:32:00 fell into the generic curator_error bucket
 * when the curator picked scope:world create with project-scope derives_from
 * — the workflow-lane fix's audit improvement was incomplete.)
 */
export class CuratorRejectError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CuratorRejectError";
    this.code = code;
  }
}

// (2026-05-11: timeout/retries moved to SedimentSettings.curatorTimeoutMs/curatorMaxRetries)

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function unwrapJsonText(rawText: string): unknown {
  const raw = rawText.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [raw, fence?.[1]?.trim()].filter((x): x is string => !!x);

  for (const text of candidates) {
    try { return JSON.parse(text); } catch {}
  }

  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try { return JSON.parse(raw.slice(objectStart, objectEnd + 1)); } catch {}
  }

  throw new Error(`curator did not return parseable JSON: ${raw.slice(0, 300)}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asDeleteMode(value: unknown): DeleteMode {
  return value === "hard" ? "hard" : "soft";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => asString(v)).filter((v): v is string => !!v);
  const single = asString(value);
  return single ? single.split(",").map((part) => part.trim()).filter(Boolean) : [];
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// isWorkflowNeighborEntry moved to ./workflow-utils to break a circular
// dependency with ./multi-view (multi-view imports the detector;
// curator.ts imports runMultiView from multi-view → cycle). Re-exported
// here so existing callers (smoke tests, anything else `import {
// isWorkflowNeighborEntry } from "./curator"`) continue working.
export { isWorkflowNeighborEntry } from "./workflow-utils";
import { isWorkflowNeighborEntry } from "./workflow-utils";

/**
 * Lane label fed to parseDecision. "workflow" is a sediment-curator-only
 * extension of MemoryEntry.scope ("project" | "world") used to tag
 * neighbors whose physical store is the workflows lane. The decoder uses
 * this to reject write ops targeting workflow neighbors before they reach
 * the writer (which would silently reject with entry_not_found).
 */
export type CuratorNeighborLane = "project" | "world" | "workflow";

export function neighborLaneFor(entry: MemoryEntry): CuratorNeighborLane {
  if (isWorkflowNeighborEntry(entry)) return "workflow";
  return (entry.scope ?? "project") as CuratorNeighborLane;
}

// Exported (2026-05-15) so smoke can pin the create-branch scope guard.
// Internal-use otherwise — production callers go through curateProjectDraft.
export function parseDecision(rawText: string, neighborScopes: Map<string, string>): CuratorDecision {
  const payload = unwrapJsonText(rawText);
  if (!payload || typeof payload !== "object") throw new CuratorRejectError("malformed_curator_op", "curator JSON must be an object");
  const obj = payload as Record<string, unknown>;
  const op = asString(obj.op)?.toLowerCase();
  const rationale = asString(obj.rationale ?? obj.why);
  const scope = asString(obj.scope) === "world" ? "world" as const : undefined;
  // R6 audit P1 fix: validate that the curator's scope decision matches
  // the neighbor's actual scope. allowedSlugs was previously a Set<string>
  // that permitted world→project and project→world scope confusion;
  // now neighborScopes (Map<slug, scope>) carries the ground truth.
  const allowedSlugs = new Set(neighborScopes.keys());
  // 2026-05-19 fix (sub2api audit row 32: entry_not_found on run-when-releasing).
  // Workflow-lane neighbors are surfaced by the search/index side but the
  // auto-write writer (updateProjectEntry / supersedeProjectEntry /
  // archiveProjectEntry / deleteProjectEntry / mergeProjectEntries) skips
  // the `workflows/` subdir on findProjectEntryFile and would silently
  // reject as entry_not_found. Catch the mismatch at the decoder so the
  // candidate either falls through to op=skip (via the curator_error
  // catch in curateProjectDraft) or, in a future curator pass with the
  // workflow-lane prompt rule visible, gets correctly classified as skip
  // (when the workflow already covers the claim) or create-with-derives
  // (when the candidate is a separate downstream observation).
  function validateScope(slug: string): void {
    const neighborScope = neighborScopes.get(slug);
    if (neighborScope === "workflow") {
      // 2026-05-19 round-2 review (Opus P1-2 + gpt-5.5 P2): use a typed
      // reject so curateProjectDraft can surface a stable `reason` code
      // distinct from the generic `curator_error` bucket. Dashboard
      // grepping for workflow-lane rejects no longer has to scan free
      // text inside `rationale`.
      throw new CuratorRejectError(
        "workflow_lane_read_only",
        `curator op "${op}" targets workflow-lane neighbor "${slug}" — workflow entries are read-only references in the sediment auto-write path (they live in ~/.abrain/[projects/<id>/]workflows/ and are mutated only by writeAbrainWorkflow). Use op=skip (when the workflow already covers the candidate's claim) or op=create with derives_from:["${slug}"] (when the candidate is a separate downstream observation building on the workflow).`,
      );
    }
    if (scope === "world" && neighborScope !== "world") {
      throw new CuratorRejectError(
        "scope_mismatch_world_on_non_world_neighbor",
        `curator set scope:world on project-scope neighbor "${slug}" — use project scope (omit scope) instead`,
      );
    }
    // curator omitted scope (defaults to project) but neighbor is world-scope:
    // this is also an error — updating a world entry as project would write
    // to the wrong directory and produce entry_not_found.
    if (!scope && neighborScope === "world") {
      throw new CuratorRejectError(
        "scope_mismatch_project_on_world_neighbor",
        `curator omitted scope on world-scope neighbor "${slug}" — must set scope:"world"`,
      );
    }
  }

  if (op === "skip") {
    return { op: "skip", reason: asString(obj.reason) ?? rationale ?? "curator decided to skip", ...(rationale ? { rationale } : {}) };
  }

  if (op === "update") {
    const slug = asString(obj.slug);
    if (!slug || !allowedSlugs.has(slug)) throw new CuratorRejectError("invented_neighbor_slug", `curator update slug is not an allowed neighbor: ${slug || "<missing>"}`);
    validateScope(slug);
    const patchObj = (obj.patch && typeof obj.patch === "object" ? obj.patch : obj) as Record<string, unknown>;
    const patch: ProjectEntryUpdateDraft = {
      ...(asString(patchObj.title) ? { title: asString(patchObj.title)! } : {}),
      ...(asString(patchObj.kind) ? { kind: asString(patchObj.kind)! as ProjectEntryUpdateDraft["kind"] } : {}),
      ...(asString(patchObj.status) ? { status: asString(patchObj.status)! as ProjectEntryUpdateDraft["status"] } : {}),
      ...(asNumber(patchObj.confidence) !== undefined ? { confidence: asNumber(patchObj.confidence)! } : {}),
      ...(asString(patchObj.compiled_truth ?? patchObj.compiledTruth) ? { compiledTruth: asString(patchObj.compiled_truth ?? patchObj.compiledTruth)! } : {}),
      ...(Array.isArray(patchObj.trigger_phrases) ? { triggerPhrases: patchObj.trigger_phrases.map(String).filter(Boolean) } : {}),
      timelineNote: asString(obj.timeline_note ?? obj.timelineNote) ?? rationale ?? "updated by sediment curator",
    };
    return { op: "update", slug, ...(scope ? { scope } : {}), patch, ...(rationale ? { rationale } : {}) };
  }

  if (op === "merge") {
    const target = asString(obj.target);
    const sources = asStringArray(obj.sources);
    const compiledTruth = asString(obj.compiled_truth ?? obj.compiledTruth);
    if (!target || !allowedSlugs.has(target)) throw new CuratorRejectError("invented_neighbor_slug", `curator merge target is not an allowed neighbor: ${target || "<missing>"}`);
    validateScope(target);
    const invalidSource = sources.find((slug) => !allowedSlugs.has(slug));
    if (invalidSource) throw new CuratorRejectError("invented_neighbor_slug", `curator merge source is not an allowed neighbor: ${invalidSource}`);
    // R6 review P1: validate scope for all sources, not just target.
    // If curator declares scope:world but a source is project-scope,
    // the merge would cross scope boundaries and produce partial results
    // (source deletion targeting the wrong store).
    for (const src of sources) validateScope(src);
    if (!sources.includes(target)) sources.unshift(target);
    if (!compiledTruth) throw new CuratorRejectError("malformed_curator_op", "curator merge requires compiled_truth");
    return { op: "merge", target, sources: Array.from(new Set(sources)), ...(scope ? { scope } : {}), compiledTruth, timelineNote: asString(obj.timeline_note ?? obj.timelineNote) ?? rationale, ...(rationale ? { rationale } : {}) };
  }

  if (op === "archive") {
    const slug = asString(obj.slug);
    if (!slug || !allowedSlugs.has(slug)) throw new CuratorRejectError("invented_neighbor_slug", `curator archive slug is not an allowed neighbor: ${slug || "<missing>"}`);
    validateScope(slug);
    return { op: "archive", slug, ...(scope ? { scope } : {}), reason: asString(obj.reason) ?? rationale ?? "archived by sediment curator", ...(rationale ? { rationale } : {}) };
  }

  if (op === "supersede") {
    const oldSlug = asString(obj.old_slug ?? obj.oldSlug ?? obj.slug);
    const newSlug = asString(obj.new_slug ?? obj.newSlug);
    if (!oldSlug || !allowedSlugs.has(oldSlug)) throw new CuratorRejectError("invented_neighbor_slug", `curator supersede old_slug is not an allowed neighbor: ${oldSlug || "<missing>"}`);
    validateScope(oldSlug);
    if (newSlug && !allowedSlugs.has(newSlug)) throw new CuratorRejectError("invented_neighbor_slug", `curator supersede new_slug is not an allowed neighbor: ${newSlug}`);
    // 2026-05-19 round-2 review (Opus P1-1 + gpt-5.5 P2): the prompt's
    // Workflow-lane section explicitly forbids workflow-lane slugs "as
    // the target/source" of supersede, but the decoder previously only
    // checked oldSlug. A curator decision like
    //   {op:"supersede", old_slug:"some-fact", new_slug:"run-when-x"}
    // would pass the decoder and the writer would write
    // `superseded_by:["run-when-x"]` into the old project entry's
    // frontmatter — a semantically wrong graph edge declaring "project
    // entry X superseded by workflow Y". Workflows are not knowledge
    // entries; they cannot supersede them. Enforce the prompt promise.
    if (newSlug) validateScope(newSlug);
    return { op: "supersede", oldSlug, ...(newSlug ? { newSlug } : {}), ...(scope ? { scope } : {}), reason: asString(obj.reason) ?? rationale ?? "superseded by sediment curator", ...(rationale ? { rationale } : {}) };
  }

  if (op === "delete") {
    const slug = asString(obj.slug);
    if (!slug || !allowedSlugs.has(slug)) throw new CuratorRejectError("invented_neighbor_slug", `curator delete slug is not an allowed neighbor: ${slug || "<missing>"}`);
    validateScope(slug);
    return {
      op: "delete",
      slug,
      ...(scope ? { scope } : {}),
      mode: asDeleteMode(obj.mode),
      reason: asString(obj.reason) ?? rationale ?? "deleted by sediment curator",
      ...(rationale ? { rationale } : {}),
    };
  }

  if (op === "create") {
    const derives_from = asStringArray(obj.derives_from ?? obj.derivesFrom);
    // 2026-05-15 audit fix — close roadmap "Curator scope binding
    // (create branch)" + deepseek audit [LOW] derives_from validation.
    //
    // For non-create ops the scope guard rides on the existing
    // neighbor's known scope (validateScope above). Create has no
    // pre-existing target; the only mechanical signal we have is the
    // derives_from chain. Two checks:
    //
    //   (a) Every derives_from slug MUST exist in allowedSlugs.
    //       Curator was previously free to invent derivation slugs
    //       (no `allowedSlugs.has(slug)` check), producing dead links
    //       in the graph. The non-create ops already enforce this; we
    //       extend the same discipline to create.
    //
    //   (b) If curator declares scope:"world" on a create, EVERY
    //       derives_from neighbor MUST also be world-scope. World
    //       entries are cross-project, hard-to-add canonical knowledge;
    //       deriving a world entry from a project-specific neighbor is
    //       almost always a curator semantic mistake (it leaks
    //       project-specific context into world store). Project
    //       creates remain free to derive from either scope (project
    //       legitimately specializes / applies world knowledge — that
    //       direction is fine and is how knowledge flows down).
    //
    // Note: the scope check is asymmetric on purpose. Symmetric
    // matching would prevent legit project-from-world derivations.
    for (const src of derives_from) {
      if (!allowedSlugs.has(src)) {
        throw new CuratorRejectError(
          "invented_neighbor_slug",
          `curator create derives_from slug is not an allowed neighbor: ${src} (do not invent derivation slugs; only use slugs from the candidate list)`,
        );
      }
      if (scope === "world") {
        const srcScope = neighborScopes.get(src);
        if (srcScope !== "world") {
          // 2026-05-19: srcScope can now be "workflow" (workflow-lane
          // neighbor) in addition to "project". Both are disallowed as
          // upstream for a world create; reflect the actual scope in
          // the error so the curator/LLM sees an accurate diagnostic.
          //
          // Round-3 (2026-05-19, this commit): typed reject so the
          // audit row carries `reason:"world_create_from_non_world_source"`
          // instead of falling into the generic `curator_error` bucket
          // — closes the round-2 P1-2 fix's missed throw sites. The
          // 22:32:00 audit row that prompted this round was a project
          // pi-global preference candidate where the curator picked
          // scope:world + derives_from:[project-scope neighbor], which
          // is exactly the policy this guard exists to reject.
          throw new CuratorRejectError(
            "world_create_from_non_world_source",
            `curator create scope:"world" cannot derive from ${srcScope ?? "project"}-scope neighbor "${src}" — either drop the scope (let it default to project) or only derive from world neighbors`,
          );
        }
      }
    }
    return { op: "create", ...(scope ? { scope } : {}), ...(derives_from.length ? { derives_from } : {}), ...(rationale ? { rationale } : {}) };
  }

  throw new CuratorRejectError("malformed_curator_op", `unsupported curator op: ${op || "<missing>"}`);
}

/** Project the runMultiView result onto the CuratorAudit.multi_view
 *  shape. Drops the raw model text fields (those live in the
 *  multi-view-metrics.jsonl sidecar written by callReviewerModel —
 *  see logReviewerMetrics in multi-view.ts; ADR 0025 P0.5 R-series
 *  batch-2 wired the sidecar after batch-1 review found the previous
 *  comment claimed sidecar storage that did not actually exist) and
 *  drops the synthesized final_decision (the outer audit already
 *  records that as `decision`). Keeps proposer_decision when
 *  triggered so audit readers can compare proposer-vs-final without
 *  joining tables. */
function buildMultiViewAudit(
  mv: MultiViewResult,
  proposerDecision: CuratorDecision,
): CuratorAudit["multi_view"] {
  if (!mv.triggered) {
    return { triggered: false, durationMs: mv.durationMs };
  }
  const out: NonNullable<CuratorAudit["multi_view"]> = {
    triggered: true,
    trigger_reason: mv.trigger_reason,
    proposer_decision: proposerDecision,
    durationMs: mv.durationMs,
  };
  if (mv.error) out.error = mv.error;
  if (mv.pass1) {
    out.pass1 = {
      model: mv.pass1.model,
      op: mv.pass1.op,
      scope: mv.pass1.scope,
      slug_target: mv.pass1.slug_target,
      confidence: mv.pass1.confidence,
      key_evidence_quote: mv.pass1.key_evidence_quote,
      strongest_objection_to_your_own_op: mv.pass1.strongest_objection_to_your_own_op,
      reasoning: mv.pass1.reasoning,
      durationMs: mv.pass1.durationMs,
    };
  }
  if (mv.pass2) {
    out.pass2 = {
      model: mv.pass2.model,
      verdict: mv.pass2.verdict,
      rationale: mv.pass2.rationale,
      anchor_bias_self_check: mv.pass2.anchor_bias_self_check,
      devils_advocate_objection: mv.pass2.devils_advocate_objection,
      missed_evidence_quote: mv.pass2.missed_evidence_quote,
      durationMs: mv.pass2.durationMs,
    };
  }
  // batch 3b: propagate staged-for-replay ref into audit. Audit consumers
  // can grep for `multi_view.staged.state` to count how often each
  // transient-failure path fires, and `multi_view.staged.slug` to follow
  // a specific candidate's replay history.
  if (mv.staged) {
    out.staged = {
      slug: mv.staged.slug,
      state: mv.staged.state,
      path: mv.staged.path,
    };
  }
  return out;
}

/**
 * Filter loaded MemoryEntry list down to the subset that the curator
 * (and any A'-layer replay) should consider as neighbor context.
 *
 * Currently retained scopes: "project" and "world". Workflow-lane
 * entries are intentionally NOT filtered out here because reviewer
 * needs to see them (with READ-ONLY marker injected later via
 * `isWorkflowNeighborEntry`); the parser does not give them their
 * own scope, so they ride along with project/world here.
 *
 * Exported (batch 3c-i.5 review N3) so multiview-staging-replay's
 * loadNeighborsBySlug callback can reproduce the same context as
 * the original multi-view trigger — without duplicating the filter
 * logic in two places, which would silently drift over time.
 */
export function relevantEntriesForCurator(entries: MemoryEntry[]): MemoryEntry[] {
  // Include both project and world entries so the curator can:
  //   1. dedupe world candidates against existing world maxims
  //   2. run full lifecycle ops (update/merge/archive/supersede/delete) on world entries
  //   3. detect cross-scope relationships (project specialization of world principle)
  // Without world neighbors, world store is structurally append-only and
  // ADR 0016 "knowledge is self-evolving" is violated for world scope.
  return entries.filter((entry) => entry.scope === "project" || entry.scope === "world");
}

function sanitizePromptText(text: string): string {
  const s = sanitizeForMemory(text);
  return s.ok ? (s.text ?? text) : `[redacted: ${s.error}]`;
}

function sanitizeDecisionStrings<T>(value: T): T {
  if (typeof value === "string") return sanitizePromptText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeDecisionStrings(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeDecisionStrings(item);
    }
    return out as T;
  }
  return value;
}

function entryForPrompt(entry: MemoryEntry): string {
  const timelineTail = entry.timeline.slice(-4).join("\n") || "(none)";
  // 2026-05-19 fix: mark workflow-lane neighbors as read-only references so
  // the curator LLM does not pick op=update/supersede/merge/archive/delete
  // on them (the writer cannot reach workflows/ — see isWorkflowNeighborEntry
  // JSDoc + parseDecision::validateScope workflow branch).
  const isWorkflow = isWorkflowNeighborEntry(entry);
  const scopeLine = isWorkflow
    ? `scope: workflow (READ-ONLY reference — sediment auto-write CANNOT modify workflow-lane entries; do not op=update/supersede/merge/archive/delete this slug, prefer op=skip or op=create with derives_from)`
    : `scope: ${entry.scope ?? "project"}`;
  return [
    `## ${entry.slug}`,
    scopeLine,
    `title: ${sanitizePromptText(entry.title)}`,
    `kind: ${entry.kind}`,
    `status: ${entry.status}`,
    `confidence: ${entry.confidence}`,
    entry.created ? `created: ${entry.created}` : undefined,
    entry.updated ? `updated: ${entry.updated}` : undefined,
    "",
    "### compiled_truth",
    sanitizePromptText(entry.compiledTruth),
    "",
    "### timeline_tail",
    sanitizePromptText(timelineTail),
  ].filter((x): x is string => x !== undefined).join("\n");
}

function makeSearchPrompt(draft: ProjectEntryDraft): string {
  return [
    "For sediment curator: find existing project memories that this candidate may update, merge with, supersede, or duplicate.",
    "Prefer entries with matching durable meaning even if wording differs. Include stale design decisions that this candidate implements or corrects.",
    "",
    `Candidate title: ${draft.title}`,
    `Candidate kind: ${draft.kind}`,
    `Candidate confidence: ${draft.confidence ?? "unknown"}`,
    "Candidate compiled truth:",
    draft.compiledTruth,
  ].join("\n");
}

/**
 * Build the prompt sent to the curator model. Exported so smoke can
 * assert directive markers (e.g. cross-scope wikilink hygiene) survive
 * future refactors. The curator decides create/update/merge/archive/
 * supersede/delete/skip; weakening these directives could regress
 * graph quality silently across thousands of auto-write decisions.
 */
export function buildCuratorPrompt(draft: ProjectEntryDraft, neighbors: MemoryEntry[]): string {
  return makeCuratorPrompt(draft, neighbors);
}

function makeCuratorPrompt(
  draft: ProjectEntryDraft,
  neighbors: MemoryEntry[],
  correctionSignal?: CorrectionSignal | null,
): string {
  const correctionBlock = correctionSignal?.signal_found
    ? [
        "=== ACTIVE CORRECTION SIGNAL ===",
        "The user just expressed a correction in the conversation.",
        "The classifier below produced this signal; treat it as a HYPOTHESIS,",
        "not ground truth. Read the classifier's own uncertainty signals before deciding.",
        "",
        `Typing: ${correctionSignal.typing ?? "unknown"}`,
        `Confidence: ${correctionSignal.confidence ?? "?"}/10`,
        `Intent: ${correctionSignal.correction_intent ?? "unknown"}`,
        `Scope: ${correctionSignal.scope_description ?? "unknown"}`,
        correctionSignal.user_quote ? `User said: "${correctionSignal.user_quote}"` : "",
        correctionSignal.target_entry_slug ? `Target entry: ${correctionSignal.target_entry_slug}` : "",
        correctionSignal.most_likely_error
          ? `Classifier uncertainty: "${correctionSignal.most_likely_error}"` : "",
        correctionSignal.surrounding_context
          ? `Context: "${correctionSignal.surrounding_context.slice(0, 300)}"` : "",
        "",
        "If the classifier says it may have confused durable with task-instruction",
        "or debug frustration, prefer SKIP or narrow-scope CREATE over broad UPDATE.",
        "If this candidate is related to the correction, prefer UPDATE",
        "over CREATE. If the correction contradicts the candidate, prefer",
        "SKIP only when the candidate is not the right vehicle for the correction.",
        "Do NOT assume the correction signal will create a separate durable entry by itself;",
        "if this candidate is the only safe vehicle, decide accordingly or defer explicitly.",
        "Task-local signals should not reach this prompt; if one appears, do not use it to create or update durable entries.",
        "=== END CORRECTION SIGNAL ===",
        "",
      ].filter(Boolean).join("\n")
    : "";

  return [
    correctionBlock,
    "You are pi-astack sediment curator.",
    "Your job is to maintain the current best knowledge state, not append duplicate notes.",
    "Decide whether the candidate should create a new memory, update/merge existing memories, archive/supersede/delete an existing memory, or be skipped.",
    "Output JSON only, one object. No markdown wrapper.",
    "",
    "Allowed operations for this implementation batch:",
    "- {\"op\":\"create\", \"scope\"?: \"world\", \"derives_from\"?: [slug, ...], \"rationale\": string}  — scope omitted defaults to project; set derives_from when the new entry is a downstream observation building on a neighbor's premise (links the new entry to upstream neighbor for graph tracing). HARD CONSTRAINT (2026-05-15): every derives_from slug MUST be one of the neighbor slugs shown below — inventing derivation slugs will reject the decision. If scope:\"world\", every derives_from neighbor MUST also be world-scope (you cannot derive a world maxim from a project-specific neighbor; that leaks project context into world store). If the candidate is world-scope but the only related/upstream neighbors are project-scope or workflow-scope, OMIT derives_from rather than pointing a world entry at non-world context.",
    "",
    "Scope judgment (when to set scope: world on any operation):",
    "- Use scope: world when the candidate is a durable cross-project engineering maxim, principle, or pattern that does NOT depend on any specific project's context, file paths, or module names.",
    "- Use project scope (default, omit scope) when the candidate is a project-specific fact, decision, observation, or pattern tied to the current project's codebase, architecture, or workflow.",
    "- Signal: if you could drop the candidate into any other project's knowledge base and it would still be true and useful, it's world scope. If it mentions or depends on this project's specifics, it's project scope.",
    "- The same agent_end window can produce both project and world entries from different aspects of the same debugging session (e.g. 'pi-astack entry 4 runs slowest' is project fact; 'agent_end handlers must defer async' is world principle).",
    "- {\"op\":\"update\", \"slug\": one_of_neighbors, \"scope\"?: \"world\", \"patch\": {\"title\"?: string, \"kind\"?: string, \"status\"?: string, \"confidence\"?: number, \"compiled_truth\"?: string, \"trigger_phrases\"?: string[]}, \"timeline_note\": string, \"rationale\": string}",
    "- {\"op\":\"merge\", \"target\": one_of_neighbors, \"scope\"?: \"world\", \"sources\": [one_or_more_neighbors], \"compiled_truth\": string, \"timeline_note\": string, \"rationale\": string}",
    "- {\"op\":\"skip\", \"reason\": string, \"rationale\": string}",
    "- {\"op\":\"archive\", \"slug\": one_of_neighbors, \"scope\"?: \"world\", \"reason\": string, \"rationale\": string}",
    "- {\"op\":\"supersede\", \"old_slug\": one_of_neighbors, \"scope\"?: \"world\", \"new_slug\"?: one_of_neighbors, \"reason\": string, \"rationale\": string}",
    "- {\"op\":\"delete\", \"slug\": one_of_neighbors, \"scope\"?: \"world\", \"mode\": \"soft\"|\"hard\", \"reason\": string, \"rationale\": string}",
    "",
    "Rules:",
    "- Candidate and neighbor bodies may contain [SECRET:<type>] placeholders. Preserve placeholders when semantically relevant, but never replace them with raw values and never invent secret values.",
    "- If you see any raw secret-like string in a candidate or neighbor, write only a typed placeholder such as [SECRET:api_key], [SECRET:token], [SECRET:connection_url], or [SECRET:private_key] in your JSON output.",
    "- Prefer update over create when the candidate refines, implements, corrects, or supersedes a single neighbor.",
    "- Prefer merge when two or more neighbors are the same evolving knowledge unit and the candidate supplies a better compiled truth.",
    "- Prefer skip when the candidate adds no durable information beyond a neighbor.",
    "- Use create only when no neighbor is the same evolving knowledge unit.",
    "- Use archive when a neighbor is no longer useful as active knowledge but should remain retained.",
    "- Use supersede when an existing neighbor is replaced by another existing neighbor or explicitly made stale by the candidate.",
    "- Delete defaults to mode=soft: archive the existing entry with a delete timeline note. Use mode=hard only for secrets, obvious junk/noise, or explicit user-requested removal. Git history is the rollback surface.",
    "",
    "Update vs create discipline (added 2026-05-13 after curator P0 in abrain commit 2e8924d: candidate was a downstream observation that touched the same topic as an existing entry; curator overwrote the upstream entry instead of creating a derived one, dropping 4 evidence bullets + 3 fix steps + principle section).",
    "- Use UPDATE only when the candidate REFINES the SAME claim the neighbor already makes (corrects an error, adds confidence, narrows scope, supplies a better compiled truth for the SAME assertion).",
    "- When the candidate is a DOWNSTREAM observation that builds on a neighbor's premise but states a DIFFERENT claim (a new failure mode, a new operational hazard, a new consequence, a new specialization): use CREATE — do NOT update the neighbor. 'Same topic area' is NOT sufficient grounds for update; the candidate must contradict, supersede, or directly refine the neighbor's claim.",
    "- When you CREATE a downstream observation, set \"derives_from\": [\"<upstream-neighbor-slug>\"] to preserve the graph link. This makes the upstream→downstream relationship traceable in graph rebuild / doctor-lite and prevents silent duplicate families.",
    "- Exception: when you CREATE with scope:\"world\" and the only possible upstream neighbors are project/workflow-scope, DO NOT set derives_from. A world entry may share topic/context with project memories, but it must not derive from them. Correct output is {\"op\":\"create\", \"scope\":\"world\", \"rationale\":...} with no derives_from.",
    "- When in doubt: prefer CREATE over UPDATE. A spurious duplicate is recoverable via merge later; an UPDATE that overwrites durable evidence/fix/principle sections is data loss recoverable only via git history.",
    "",
    "Update body-preservation contract (when you DO choose update):",
    "- For update, compiled_truth should be the new current best truth, not an append-only delta. But: PRESERVE the neighbor's Evidence, Fix, Principle, code-example, and similarly-load-bearing sections VERBATIM unless the candidate explicitly contradicts a specific sentence in them. Removing such a section because the candidate 'no longer discusses it' is the bug. The candidate's compiled_truth is a DELTA proposal; you must integrate it into the existing body, not replace the body.",
    "- The candidate's title is a HINT, not a directive. Do NOT change the neighbor's title via the title patch field unless the candidate's title genuinely renames the same claim (e.g. fixing a typo). If the candidate's title describes a different claim than the neighbor's title, that is a strong signal you should CREATE, not UPDATE.",
    "- trigger_phrases on update: UNION the existing trigger_phrases with the candidate's, do not REPLACE. Drop existing phrases only if they describe a sub-claim the candidate explicitly retires; otherwise keep all old phrases (they are retrieval anchors, losing them breaks future memory_search). If you want to fully replace trigger_phrases, you almost certainly meant CREATE.",
    "",
    "- timeline_note should be short and evidence-based.",
    "- Do not invent slugs. update/merge/archive/delete/supersede slugs must be one of the neighbor slugs.",
    "- Cross-scope wikilink hygiene (soft, prefer but not strict): if compiled_truth references entries outside this project, prefer the explicit scope prefix `[[world:slug]]` (for ~/.abrain/knowledge/ maxims and durable knowledge), `[[workflow:slug]]` (for ~/.abrain/workflows/ pipelines), or `[[project:<projectId>:slug]]` (for other projects). Bare `[[slug]]` resolves to the current project by default and to global as fallback during read, but explicit prefixes reduce future graph-rewrite work. Do not invent slugs you have not seen.",
    "",
    "Workflow-lane neighbors (added 2026-05-19 after sub2api audit row 32 entry_not_found):",
    "- Neighbors whose `scope:` header reads `workflow (READ-ONLY reference ...)` live in the abrain workflows lane (`~/.abrain/[projects/<id>/]workflows/<slug>.md`) and are NOT writable via this auto-write path. Their writer is `writeAbrainWorkflow` (B1), which the sediment curator does not call.",
    "- HARD CONSTRAINT: do NOT emit op=update / op=supersede / op=merge / op=archive / op=delete with a workflow-lane slug as the target/source. The decoder will reject it and the candidate will fall through to op=skip — wasting one curator decision and silently dropping the candidate's claim.",
    "- Correct dispositions when a workflow neighbor matches the candidate's topic: (1) op=skip with rationale referencing the workflow if the workflow already fully covers the claim (this was the right answer for sub2api's 'release preconditions checklist' candidate); (2) op=create with derives_from:[\"<workflow-slug>\"] when the candidate is a separate downstream observation building on the workflow's premise — derives_from MAY point at workflow neighbors even though update/etc may not.",
    "",
    "Scope stickiness (CRITICAL — added 2026-05-14 after world-scope neighbor pool opened):",
    "- Scope is immutable on update/merge/archive/supersede/delete. You MUST NOT change an entry's scope via these operations. The scope shown in the neighbor header is authoritative.",
    "- If a project-scope candidate matches a world-scope neighbor by topic but adds project-specific evidence: output CREATE (scope: project), NOT update the world entry. The world entry is the general principle; the project entry is a specialization.",
    "- If a world-scope candidate (a cross-project maxim/principle) matches an existing world entry: output UPDATE or MERGE or SKIP, NOT create. World store must self-evolve, not grow append-only duplicates.",
    "- If a world-scope candidate matches a project entry by topic and the project entry's claim is fully subsumed by the candidate: output CREATE (scope: world) for the world entry. In a future pass the world entry may be linked to supersede the project entry; do not attempt to do both in one decision.",
    "- Wikilink target discipline: `[[...]]` MUST point to an existing abrain memory entry slug (one of the neighbor slugs shown below, or a global maxim/workflow slug you have memory_search'd for). ADR files (`docs/adr/00XX-name.md`), source code paths, file basenames, section anchors, and external URLs MUST be referenced in PROSE — NEVER as `[[...]]`. Forms like `[[project:foo:0018-some-adr]]` are bugs: that target is not an abrain entry, doctor-lite will report it as a dead link, and `memory_search` won't find it. Write `documented in ADR 0018 (docs/adr/0018-some-adr.md)` or `see the brain-redesign-spec` instead.",
    "- Preserve existing wikilinks verbatim when merging. Only change a `[[...]]` form if you are deliberately re-pointing it; never silently drop or rewrite an existing link's slug.",
    "- Example update line: `This refines [[world:reduce-complexity-before-adding-branches]] in the writer-substrate context.`",
    "",
    "Candidate:",
    "<<<SEDIMENT_CANDIDATE",
    `title: ${draft.title}`,
    `kind: ${draft.kind}`,
    draft.status ? `status: ${draft.status}` : undefined,
    draft.confidence !== undefined ? `confidence: ${draft.confidence}` : undefined,
    "",
    draft.compiledTruth,
    "SEDIMENT_CANDIDATE>>>",
    "",
    "Neighbors:",
    "<<<SEDIMENT_NEIGHBORS",
    neighbors.length ? neighbors.map(entryForPrompt).join("\n\n---\n\n") : "(none)",
    "SEDIMENT_NEIGHBORS>>>",
  ].filter((x): x is string => x !== undefined).join("\n");
}

async function callCuratorModel(
  settings: SedimentSettings,
  modelRegistry: ModelRegistryLike,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const t0 = Date.now();
  const estimatedTokens = Math.ceil(prompt.length / 3);
  try {
    const parsed = parseModelRef(settings.curatorModel);
  if (!parsed) throw new Error(`invalid sediment.curatorModel: ${settings.curatorModel || "<empty>"}; expected provider/model`);
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) throw new Error(`sediment curator model not found in registry: ${settings.curatorModel}`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`sediment curator auth unavailable: ${auth.error || "missing api key"}`);

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai");

  const stream = piAi.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
    { apiKey: auth.apiKey, headers: auth.headers, signal, timeoutMs: settings.curatorTimeoutMs, maxRetries: settings.curatorMaxRetries },
  );
  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    throw new Error(finalMsg.errorMessage || finalMsg.stopReason);
  }
  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!rawText) throw new Error("sediment curator returned empty text");

  logCuratorMetrics({
    ts: new Date().toISOString(),
    model: settings.curatorModel,
    promptChars: prompt.length,
    estimatedTokens,
    ok: true,
    durationMs: Date.now() - t0,
  });

  return rawText;
  } catch (e: unknown) {
    logCuratorMetrics({
      ts: new Date().toISOString(),
      model: settings.curatorModel,
      promptChars: prompt.length,
      estimatedTokens,
      ok: false,
      durationMs: Date.now() - t0,
    });
    throw e;
  }
}

export async function curateProjectDraft(
  draft: ProjectEntryDraft,
  deps: {
    projectRoot: string;
    sedimentSettings: SedimentSettings;
    memorySettings: MemorySettings;
    modelRegistry: ModelRegistryLike;
    signal?: AbortSignal;
    /** ADR 0025 P1: active correction signal from the conversation window.
     *  When present, injected into the curator prompt so update/merge
     *  decisions account for user corrections. */
    correctionSignal?: CorrectionSignal | null;
  },
): Promise<CuratorOutcome> {
  const totalStart = Date.now();
  const searchStart = Date.now();

  // Belt-and-suspenders: sanitize the extractor's output before feeding it
  // to any LLM (search prompt → memory_search LLM, curator prompt → curator
  // LLM). The extractor prompt instructs the LLM to use placeholders, but
  // raw PII/credentials can still leak through transcript quotes. Writer-
  // level sanitize runs later at writeProjectEntry time — by then the LLMs
  // have already seen the raw text. (2026-05-14 audit round 6; 2026-05-15
  // credential redaction instead of whole-run abort)
  const titleSanitize = sanitizeForMemory(draft.title);
  const bodySanitize = sanitizeForMemory(draft.compiledTruth);
  const safeDraft: ProjectEntryDraft = {
    ...draft,
    title: titleSanitize.text ?? draft.title,
    compiledTruth: bodySanitize.text ?? draft.compiledTruth,
  };
  // sanitizeForMemory currently redacts credentials and returns ok=true. Keep
  // this defensive branch for future unrecoverable sanitizer errors.
  if (!titleSanitize.ok || !bodySanitize.ok) {
    const error = sanitizePromptText(`curator sanitize failed: ${(!titleSanitize.ok ? titleSanitize.error : bodySanitize.error)}`);
    const decision: CuratorDecision = { op: "skip", reason: "credential_in_draft", rationale: error };
    return { decision, audit: { decision, neighbors: [], stage_ms: { search: 0, decide: 0, total: Date.now() - totalStart }, error } };
  }

  let entries: MemoryEntry[];
  let cards: any[];
  try {
    entries = relevantEntriesForCurator(await loadEntries(deps.projectRoot, deps.memorySettings, deps.signal));
    cards = await llmSearchEntries(
      entries,
      { query: makeSearchPrompt(safeDraft), filters: { limit: 5, status: ["all"] } },
      deps.memorySettings,
      deps.modelRegistry,
      deps.signal,
      deps.projectRoot,
    ) as any[];
  } catch (e: unknown) {
    const error = sanitizePromptText(e instanceof Error ? e.message : String(e));
    const searchMs = Date.now() - searchStart;
    const decision: CuratorDecision = { op: "skip", reason: "curator_search_error", rationale: error };
    return {
      decision,
      audit: { decision, neighbors: [], stage_ms: { search: searchMs, decide: 0, total: Date.now() - totalStart }, error },
    };
  }
  const searchMs = Date.now() - searchStart;
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const neighbors = cards
    .map((card: any) => bySlug.get(String(card.slug)))
    .filter((entry): entry is MemoryEntry => !!entry);
  const neighborAudit = cards.map((card: any) => ({
    slug: String(card.slug),
    ...(typeof card.score === "number" ? { score: card.score } : {}),
    ...(typeof card.rank_reason === "string" ? { rank_reason: card.rank_reason } : {}),
  }));

  // Even with zero neighbors, run the curator model: it can still classify
  // scope (project vs world) and produce a richer rationale. Skipping the
  // curator on empty neighbors used to force-create project-scope entries
  // for all candidates that happened to have no memory_search hits.
  if (neighbors.length === 0) {
    // fall through to curator call below
  }

  const decideStart = Date.now();
  let proposerRawText = "";
  try {
    proposerRawText = await callCuratorModel(
      deps.sedimentSettings,
      deps.modelRegistry,
      makeCuratorPrompt(safeDraft, neighbors, deps.correctionSignal),
      deps.signal,
    );
    const proposerDecision = sanitizeDecisionStrings(parseDecision(proposerRawText, new Map(neighbors.map((entry) => [entry.slug, neighborLaneFor(entry)]))));
    const decideMs = Date.now() - decideStart;

    // ADR 0025 P0.5 multi-view verification. Runs ONLY for high-value
    // ops (see shouldTriggerMultiView). For low-value ops triggered=false
    // and proposer decision is used as-is. Two separate API calls to the
    // reviewer model (different family from curator) — Pass 1 blind, Pass
    // 2 reveal.
    //
    // ADR 0025 §4.4.6 batch 3b: on any of 6 transient reviewer failure
    // paths (reviewer_unavailable / pass1_call_failed / pass1_unparseable
    // / pass2_call_failed / pass2_unparseable / deferred), runMultiView
    // writes a multiview-pending staging entry and returns op=skip
    // (multiview_staged_for_replay). The candidate is NOT silently
    // written to brain (would violate §3.1 A' layer). The 7th path
    // (confirm_pass1_not_synthesizable) keeps op=skip(multiview_pass1_op_
    // not_synthesizable) deliberately — known Pass 1 schema limitation.
    // Multi-view is a safety net + staging queue, not a blocking gate.
    const mvResult = await runMultiView({
      proposerDecision,
      proposerRawText,
      candidate: safeDraft,
      neighbors,
      correctionSignal: deps.correctionSignal ?? null,
      settings: deps.sedimentSettings,
      modelRegistry: deps.modelRegistry,
      signal: deps.signal,
    });
    // batch 3b: when staged, final_decision is guaranteed to be
    // op=skip(multiview_staged_for_replay) so the downstream caller
    // naturally skips brain write. We surface this in the audit by
    // copying mvResult.staged through buildMultiViewAudit.
    const decision = sanitizeDecisionStrings(mvResult.final_decision);

    return {
      decision,
      audit: {
        decision,
        neighbors: neighborAudit,
        stage_ms: { search: searchMs, decide: decideMs, total: Date.now() - totalStart },
        multi_view: buildMultiViewAudit(mvResult, proposerDecision),
      },
    };
  } catch (e: unknown) {
    const error = sanitizePromptText(e instanceof Error ? e.message : String(e));
    // 2026-05-19 round-2 review (Opus P1-2 + gpt-5.5 P2): preserve
    // grep-able reason codes for policy rejects. Generic `curator_error`
    // stays the catch-all for JSON parse / model errors / unexpected
    // exceptions; CuratorRejectError instances surface their `code`
    // (e.g. `workflow_lane_read_only`) so audit-log scanners can count
    // each policy bucket independently.
    const reason = e instanceof CuratorRejectError ? e.code : "curator_error";
    const decision: CuratorDecision = { op: "skip", reason, rationale: error };
    const decideMs = Date.now() - decideStart;
    return {
      decision,
      audit: { decision, neighbors: neighborAudit, stage_ms: { search: searchMs, decide: decideMs, total: Date.now() - totalStart }, error },
    };
  }
}
