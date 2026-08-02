/**
 * Daemon-local global maintenance lanes (R6 / ADR 0045 §2.8b additive).
 *
 * Restores the 7 agent_end global lanes that worker taskScoped mode skips:
 *   forgetting, aggregator, staging_resolver, staging_ageout,
 *   staging_promotion, multiview_replay, archive_reactivation
 *
 * Invoked only by `/sediment-worker-maintenance kind=global_maintenance`.
 * Does NOT open taskScoped, does NOT restore foreground execution, and never
 * returns identity/path free text — only closed lane statuses + count buckets.
 *
 * Context for LLM window lanes is process-local only: the most recent
 * verified worker-task snapshot's owner-local bounded window (no protocol
 * identity). Missing context → closed per-lane `skipped` without writing
 * debounce / failure sidecars (never consume a due slot with empty window).
 */

import * as path from "node:path";
import { resolveActiveProject, resolveUserGlobalAbrainHome } from "../_shared/runtime";
import { resolveSettings as resolveMemorySettings } from "../memory/settings";
import { loadEntries } from "../memory/parser";
import { runAndWriteSedimentAggregatorIfDue } from "./aggregator";
import { runArchiveReactivationIfDue } from "./archive-reactivation";
import { entryToText } from "./checkpoint";
import { executeCuratorDecisionToBrain } from "./curator-decision-writer";
import { relevantEntriesForCurator } from "./curator";
import { runForgettingAgentEndPass } from "./forgetting-agent-end";
import {
  hasAdr0039L3RelevantWriteResult,
  syncAdr0039L3AfterKnowledgeWrite,
} from "./knowledge-evidence";
import { replayMultiviewPending } from "./multiview-staging-replay";
import {
  resolveSedimentGlobalWriteAuthority,
  resolveSedimentSettings,
  type SedimentSettings,
} from "./settings";
import { runStagingAgeOutIfDue } from "./staging-ageout";
import { runStagingPromotionIfDue } from "./staging-promotion";
import { runStagingResolverIfDue } from "./staging-resolver";
import {
  appendAudit,
  updateProjectEntry,
  type WriteProjectEntryResult,
} from "./writer";

/** Local deadline error (avoid circular import with worker-rpc). */
class GlobalMaintenanceBudgetError extends Error {
  readonly code = "worker_budget_exhausted" as const;
  constructor(message = "deadline exceeded") {
    super(message);
    this.name = "GlobalMaintenanceBudgetError";
  }
}

function throwIfBudget(opts: {
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
}): void {
  if (opts.signal?.aborted) throw new GlobalMaintenanceBudgetError("aborted");
  if (opts.deadlineMs !== undefined) {
    const now = opts.now ?? Date.now;
    if (now() >= opts.deadlineMs) throw new GlobalMaintenanceBudgetError("deadline exceeded");
  }
}

/** Closed set of original global maintenance lanes (taskScoped skip list). */
export const GLOBAL_MAINTENANCE_LANES = [
  "forgetting",
  "aggregator",
  "staging_resolver",
  "staging_ageout",
  "staging_promotion",
  "multiview_replay",
  "archive_reactivation",
] as const;
export type GlobalMaintenanceLane = (typeof GLOBAL_MAINTENANCE_LANES)[number];
const LANE_SET = new Set<string>(GLOBAL_MAINTENANCE_LANES);

/**
 * Closed per-lane status:
 * - idle: nothing due / no candidates / debounced across all owners
 * - ran: at least one owner performed real work
 * - skipped: gate closed (settings / unbound / no model / no context) without error
 * - failed: at least one owner threw
 * - budget: stopped by worker soft deadline / abort
 * - unknown: lane not attempted (should not appear after a complete run)
 */
export const GLOBAL_MAINTENANCE_LANE_STATUSES = [
  "idle",
  "ran",
  "skipped",
  "failed",
  "budget",
  "unknown",
] as const;
export type GlobalMaintenanceLaneStatus = (typeof GLOBAL_MAINTENANCE_LANE_STATUSES)[number];
const LANE_STATUS_SET = new Set<string>(GLOBAL_MAINTENANCE_LANE_STATUSES);

export type GlobalMaintenanceLaneMap = Record<GlobalMaintenanceLane, GlobalMaintenanceLaneStatus>;

export interface GlobalMaintenanceAggregate {
  lanes: GlobalMaintenanceLaneMap;
  /** Owners successfully bound and visited (closed bucket input). */
  owners_visited: number;
  /** Owners skipped as unbound / invalid (closed bucket input). */
  owners_skipped: number;
  /** Lanes that reported ran. */
  lanes_ran: number;
  /** Lanes that reported failed. */
  lanes_failed: number;
  /** Lanes that reported budget. */
  lanes_budget: number;
  /** Lanes that reported skipped. */
  lanes_skipped: number;
  /** Lanes that reported idle. */
  lanes_idle: number;
  /**
   * Overall maintenance status mapping into existing closed set:
   * idle | drained | pending | failed
   */
  status: "idle" | "drained" | "pending" | "failed";
  retryable: boolean;
  error_code?: string;
}

export interface RunGlobalMaintenanceOptions {
  ownerRoots: readonly string[];
  abrainHome: string;
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
  modelRegistry?: unknown;
  /**
   * Optional test hooks: replace individual lane runners.
   * Production leaves undefined.
   */
  laneRunners?: Partial<Record<GlobalMaintenanceLane, (ctx: LaneRunContext) => Promise<GlobalMaintenanceLaneStatus>>>;
}

export interface LaneRunContext {
  projectRoot: string;
  projectId: string;
  abrainHome: string;
  settings: SedimentSettings;
  modelRegistry?: unknown;
  signal?: AbortSignal;
  sessionId: string;
  /**
   * Owner-local bounded window from the most recent verified worker task
   * snapshot (process-local; never a protocol identity). Absent → LLM window
   * lanes must closed-skip without debounce writes.
   */
  windowText?: string;
}

// ── Owner-local verified window cache (process-local; no protocol identity) ──

const MAX_WINDOW_ENTRIES = 50;
const MAX_WINDOW_CHARS = 24_000;
const WINDOW_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h — stale snapshot is not "real context"

interface CachedOwnerWindow {
  windowText: string;
  capturedAtMs: number;
}

/** ownerRoot realpath → most recent verified worker-task bounded window. */
const ownerWindowCache = new Map<string, CachedOwnerWindow>();

function ownerCacheKey(ownerRoot: string): string {
  return path.resolve(ownerRoot);
}

/**
 * Remember the owner-local bounded window from a verified worker task snapshot.
 * Called only after sidecar verification succeeds — never from untrusted input.
 * No session/record identity is stored.
 */
export function rememberVerifiedWorkerTaskWindow(args: {
  ownerRoot: string;
  branchEntries: readonly unknown[];
  nowMs?: number;
}): void {
  const key = ownerCacheKey(args.ownerRoot);
  if (!key) return;
  const recent = (args.branchEntries ?? []).slice(-MAX_WINDOW_ENTRIES);
  const parts: string[] = [];
  let total = 0;
  for (const entry of recent) {
    const text = entryToText(entry);
    if (!text) continue;
    if (total + text.length + 2 > MAX_WINDOW_CHARS) break;
    parts.push(text);
    total += text.length + 2;
  }
  const windowText = parts.join("\n\n").trim();
  if (!windowText) {
    // Empty branch is not usable context; do not invent a cache hit.
    ownerWindowCache.delete(key);
    return;
  }
  ownerWindowCache.set(key, {
    windowText,
    capturedAtMs: args.nowMs ?? Date.now(),
  });
}

/**
 * Resolve process-local owner window for global maintenance LLM lanes.
 * Returns null when absent/stale/empty — callers must closed-skip without
 * writing debounce or failure sidecars.
 */
export function resolveOwnerLocalMaintenanceWindow(
  ownerRoot: string,
  nowMs: number = Date.now(),
): string | null {
  const cached = ownerWindowCache.get(ownerCacheKey(ownerRoot));
  if (!cached) return null;
  if (!cached.windowText.trim()) return null;
  if (nowMs - cached.capturedAtMs > WINDOW_MAX_AGE_MS) return null;
  return cached.windowText;
}

/** Test-only: clear process-local window cache. */
export function _resetOwnerLocalMaintenanceWindowCacheForTests(): void {
  ownerWindowCache.clear();
}

/** Test-only: inject a window without a real worker snapshot. */
export function _setOwnerLocalMaintenanceWindowForTests(
  ownerRoot: string,
  windowText: string,
  capturedAtMs: number = Date.now(),
): void {
  const trimmed = String(windowText || "").trim();
  if (!trimmed) {
    ownerWindowCache.delete(ownerCacheKey(ownerRoot));
    return;
  }
  ownerWindowCache.set(ownerCacheKey(ownerRoot), { windowText: trimmed, capturedAtMs });
}

function emptyLaneMap(status: GlobalMaintenanceLaneStatus = "unknown"): GlobalMaintenanceLaneMap {
  return {
    forgetting: status,
    aggregator: status,
    staging_resolver: status,
    staging_ageout: status,
    staging_promotion: status,
    multiview_replay: status,
    archive_reactivation: status,
  };
}

function mergeLaneStatus(
  current: GlobalMaintenanceLaneStatus,
  next: GlobalMaintenanceLaneStatus,
): GlobalMaintenanceLaneStatus {
  // Precedence: failed > budget > ran > skipped > idle > unknown
  const rank: Record<GlobalMaintenanceLaneStatus, number> = {
    unknown: 0,
    idle: 1,
    skipped: 2,
    ran: 3,
    budget: 4,
    failed: 5,
  };
  return rank[next] > rank[current] ? next : current;
}

function checkBudget(opts: RunGlobalMaintenanceOptions): void {
  throwIfBudget({
    signal: opts.signal,
    deadlineMs: opts.deadlineMs,
    now: opts.now,
  });
}

function mapSkippedToStatus(skipped: string | undefined): GlobalMaintenanceLaneStatus {
  if (!skipped) return "ran";
  if (skipped === "debounced" || skipped === "no_candidates" || skipped === "concurrent_run") return "idle";
  return "skipped";
}

/** Immutable chronology helpers shared with agent_end forgetting / archive paths. */
function sourceTimestampFromEntry(entry: {
  created?: string;
  updated?: string;
  frontmatter?: Record<string, unknown>;
  timeline?: string[];
} | undefined): string | undefined {
  if (!entry) return undefined;
  const archiveAt = typeof entry.frontmatter?.archive_at === "string" ? entry.frontmatter.archive_at : undefined;
  if (archiveAt && Number.isFinite(Date.parse(archiveAt))) return new Date(Date.parse(archiveAt)).toISOString();
  if (typeof entry.created === "string" && Number.isFinite(Date.parse(entry.created))) {
    return new Date(Date.parse(entry.created)).toISOString();
  }
  if (typeof entry.updated === "string" && Number.isFinite(Date.parse(entry.updated))) {
    return new Date(Date.parse(entry.updated)).toISOString();
  }
  if (entry.timeline?.length) {
    for (let i = entry.timeline.length - 1; i >= 0; i -= 1) {
      const m = /^[-*]\s+(\d{4}-\d{2}-\d{2}T[^\s|]+)/.exec(entry.timeline[i] ?? "");
      if (m?.[1] && Number.isFinite(Date.parse(m[1]))) return new Date(Date.parse(m[1])).toISOString();
    }
  }
  return undefined;
}

async function runForgettingLane(ctx: LaneRunContext): Promise<GlobalMaintenanceLaneStatus> {
  const memSettings = resolveMemorySettings();
  if (!memSettings.forgetting?.enabled) return "skipped";
  const globalWriteAuthority = resolveSedimentGlobalWriteAuthority();
  const result = await runForgettingAgentEndPass({
    projectRoot: ctx.projectRoot,
    memorySettings: memSettings,
    globalWriteAuthority,
    loadEntries: () => loadEntries(ctx.projectRoot, memSettings, ctx.signal),
    createArchiveEntry: (scopeOf) => async (target) => {
      try {
        const scope = scopeOf.get(target.slug) ?? "project";
        const expectedStatus = target.expected_status ?? "active";
        const liveEntries = await loadEntries(ctx.projectRoot, memSettings, ctx.signal);
        const live = liveEntries.find((entry) => entry.slug === target.slug);
        const sourceTimestampUtc = sourceTimestampFromEntry(live);
        const res = await updateProjectEntry(
          target.slug,
          {
            status: "archived",
            expected_status: expectedStatus,
            timelineAction: "archived",
            timelineNote: `forgetting-executor v1(${target.reason}; expected_status=${expectedStatus})`,
            sessionId: ctx.sessionId,
          },
          {
            projectRoot: ctx.projectRoot,
            abrainHome: ctx.abrainHome,
            projectId: ctx.projectId,
            settings: ctx.settings,
            scope,
            dryRun: false,
            auditOperation: "forgetting_demote_apply",
            auditContext: {
              lane: "forgetting",
              sessionId: ctx.sessionId,
              candidateId: target.proposal_id || `forgetting:${target.slug}:${target.reason}`,
              ...(sourceTimestampUtc ? { sourceTimestampUtc } : {}),
            },
          },
        );
        const ok = res.status !== "rejected";
        return { ok, status: ok ? "archived" : "active", error: res.reason, rejected: !ok };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  const demoted = result.executor?.demoted?.length ?? 0;
  const planned = result.executor?.plan?.demote?.length ?? 0;
  if (demoted > 0 || planned > 0) return "ran";
  if (result.lifecycle_hooks.frontmatter_bridge === "completed") return "ran";
  if (!result.real_apply_gate_enabled) return "skipped";
  return "idle";
}

async function runAggregatorLane(ctx: LaneRunContext): Promise<GlobalMaintenanceLaneStatus> {
  const llmAllowed = ctx.settings.autoLlmWriteEnabled !== false;
  const summary = await runAndWriteSedimentAggregatorIfDue({
    projectRoot: ctx.projectRoot,
    settings: ctx.settings,
    sessionId: ctx.sessionId,
    modelRegistry: llmAllowed
      ? (ctx.modelRegistry as Parameters<typeof runAndWriteSedimentAggregatorIfDue>[0]["modelRegistry"])
      : undefined,
  });
  if (!summary) return "idle";
  return "ran";
}

/**
 * LLM window lanes must never call IfDue with empty windowText — that would
 * consume debounce with non-context. No process-local verified window →
 * closed skipped (skipped_no_context semantics) without sidecar writes.
 */
function requireOwnerWindowOrSkip(ctx: LaneRunContext): string | "skipped_no_context" {
  const text = typeof ctx.windowText === "string" ? ctx.windowText.trim() : "";
  if (!text) return "skipped_no_context";
  return text;
}

async function runStagingResolverLane(ctx: LaneRunContext): Promise<GlobalMaintenanceLaneStatus> {
  if (ctx.settings.autoLlmWriteEnabled === false) return "skipped";
  const windowText = requireOwnerWindowOrSkip(ctx);
  if (windowText === "skipped_no_context") return "skipped";
  if (!ctx.modelRegistry) return "skipped";
  const result = await runStagingResolverIfDue({
    projectRoot: ctx.projectRoot,
    windowText,
    settings: ctx.settings,
    modelRegistry: ctx.modelRegistry as Parameters<typeof runStagingResolverIfDue>[0]["modelRegistry"],
    sessionId: ctx.sessionId,
    signal: ctx.signal,
  });
  return mapSkippedToStatus(result.skipped);
}

async function runStagingAgeOutLane(ctx: LaneRunContext): Promise<GlobalMaintenanceLaneStatus> {
  if (ctx.settings.autoLlmWriteEnabled === false) return "skipped";
  const windowText = requireOwnerWindowOrSkip(ctx);
  if (windowText === "skipped_no_context") return "skipped";
  if (!ctx.modelRegistry) return "skipped";
  const result = await runStagingAgeOutIfDue({
    projectRoot: ctx.projectRoot,
    windowText,
    settings: ctx.settings,
    modelRegistry: ctx.modelRegistry as Parameters<typeof runStagingAgeOutIfDue>[0]["modelRegistry"],
    sessionId: ctx.sessionId,
    signal: ctx.signal,
  });
  return mapSkippedToStatus(result.skipped);
}

async function runStagingPromotionLane(ctx: LaneRunContext): Promise<GlobalMaintenanceLaneStatus> {
  if (ctx.settings.stagingPromotionEnabled !== true || ctx.settings.autoLlmWriteEnabled !== true) {
    return "skipped";
  }
  if (!ctx.modelRegistry) return "skipped";
  const result = await runStagingPromotionIfDue({
    projectRoot: ctx.projectRoot,
    abrainHome: ctx.abrainHome,
    projectId: ctx.projectId,
    settings: ctx.settings,
    modelRegistry: ctx.modelRegistry as Parameters<typeof runStagingPromotionIfDue>[0]["modelRegistry"],
    sessionId: ctx.sessionId,
    signal: ctx.signal,
  });
  return mapSkippedToStatus(result.skipped);
}

/**
 * Real multiview brain writer (same path as agent_end scheduleMultiviewReplay).
 * Must throw on failure so staging-replay keeps pending — never no-op resolve.
 */
async function writeMultiviewApprovedToBrain(
  ctx: LaneRunContext,
  decision: Parameters<typeof executeCuratorDecisionToBrain>[0]["decision"],
  candidate: Parameters<typeof executeCuratorDecisionToBrain>[0]["draft"],
  neighborStatusBySlug: Parameters<typeof executeCuratorDecisionToBrain>[0]["neighborStatusBySlug"],
  replaySource?: { slug: string; created?: string; updated?: string },
): Promise<void> {
  const captured =
    (typeof replaySource?.created === "string" && Number.isFinite(Date.parse(replaySource.created))
      ? new Date(Date.parse(replaySource.created)).toISOString()
      : undefined)
    || (typeof replaySource?.updated === "string" && Number.isFinite(Date.parse(replaySource.updated))
      ? new Date(Date.parse(replaySource.updated)).toISOString()
      : undefined);
  const correlationId = `daemon-global-maintenance:multiview-replay:${candidate.title || replaySource?.slug || "unknown"}`;
  let results: WriteProjectEntryResult[] = [];
  let dispatcherError: unknown;
  try {
    results = await executeCuratorDecisionToBrain({
      decision,
      draft: candidate,
      projectRoot: ctx.projectRoot,
      abrainHome: ctx.abrainHome,
      projectId: ctx.projectId,
      settings: ctx.settings,
      dryRun: false,
      neighborStatusBySlug,
      auditContext: {
        lane: "replay",
        sessionId: ctx.sessionId,
        correlationId,
        candidateId: `${correlationId}:0`,
        ...(captured ? { sourceTimestampUtc: captured } : {}),
      },
      sessionId: ctx.sessionId,
      createTimelineNote: "captured from multi-view staging replay (global_maintenance)",
      updateTimelineNote: decision.rationale || "updated by multi-view staging replay (global_maintenance)",
      mergeTimelineNote: decision.rationale || "merged by multi-view staging replay (global_maintenance)",
      archiveReason: decision.op === "archive"
        ? decision.reason || decision.rationale || "archived by multi-view staging replay (global_maintenance)"
        : undefined,
      supersedeReason: decision.op === "supersede"
        ? decision.reason || decision.rationale || "superseded by multi-view staging replay (global_maintenance)"
        : undefined,
      deleteReason: decision.op === "delete"
        ? decision.reason || decision.rationale || "deleted by multi-view staging replay (global_maintenance)"
        : undefined,
    });
  } catch (e: unknown) {
    dispatcherError = e;
  }

  try {
    await appendAudit(ctx.projectRoot, {
      operation: "multi_view_replay_brain_write",
      session_id: ctx.sessionId,
      lane: "replay",
      correlation_id: correlationId,
      decision_op: decision.op,
      candidate_title: candidate.title,
      candidate_kind: candidate.kind,
      result_count: results.length,
      results: results.map((r) => ({ slug: r.slug, status: r.status, reason: r.reason })),
      writer_rejected: results.some((r) => r.status === "rejected"),
      source: "global_maintenance",
      ...(dispatcherError
        ? { dispatcher_error: dispatcherError instanceof Error ? dispatcherError.message : String(dispatcherError) }
        : {}),
    });
  } catch {
    // Diagnostic only — never preserve staging after a successful durable write.
  }

  if (dispatcherError) throw dispatcherError;
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) {
    throw new Error(`multi-view replay writer rejected op=${decision.op}: ${rejected.reason || "unknown"}`);
  }
  const missingCommit = results.find((r) => ctx.settings.gitCommit === true
    && r.status !== "skipped"
    && r.status !== "dry_run"
    && r.gitCommit === null);
  if (missingCommit) {
    throw new Error(
      `multi-view replay writer missing git commit op=${decision.op} status=${missingCommit.status} slug=${missingCommit.slug}`,
    );
  }
  if (hasAdr0039L3RelevantWriteResult(results)) {
    await syncAdr0039L3AfterKnowledgeWrite({ abrainHome: ctx.abrainHome, settings: ctx.settings });
  }
}

async function runMultiviewReplayLane(ctx: LaneRunContext): Promise<GlobalMaintenanceLaneStatus> {
  if (ctx.settings.autoLlmWriteEnabled === false) return "skipped";
  if (!ctx.modelRegistry) return "skipped";
  const memSettings = resolveMemorySettings();
  const result = await replayMultiviewPending({
    settings: ctx.settings,
    modelRegistry: ctx.modelRegistry as Parameters<typeof replayMultiviewPending>[0]["modelRegistry"],
    currentProjectId: ctx.projectId,
    currentProjectRoot: ctx.projectRoot,
    loadNeighborsBySlug: async (slugs: string[]) => {
      if (slugs.length === 0) return [];
      const all = await loadEntries(ctx.projectRoot, memSettings, ctx.signal);
      const filtered = relevantEntriesForCurator(all);
      const bySlug = new Map(filtered.map((entry) => [entry.slug, entry]));
      return slugs.map((slug) => bySlug.get(slug)).filter((entry): entry is NonNullable<typeof entry> => !!entry);
    },
    writeApprovedToBrain: async (decision, candidate, neighborStatusBySlug, replaySource) => {
      await writeMultiviewApprovedToBrain(
        ctx,
        decision,
        candidate,
        neighborStatusBySlug,
        replaySource,
      );
    },
    signal: ctx.signal,
  });
  try {
    await appendAudit(ctx.projectRoot, {
      operation: "multi_view_replay_batch",
      session_id: ctx.sessionId,
      lane: "replay",
      source: "global_maintenance",
      attempted: result.attempted,
      succeeded: result.succeeded,
      re_staged: result.re_staged,
      errors: result.errors,
      total_pending: result.totalPending,
    });
  } catch {
    /* best-effort */
  }
  const processed = (result.attempted ?? 0) + (result.succeeded ?? 0) + (result.re_staged ?? 0);
  if (processed > 0) return "ran";
  return "idle";
}

async function runArchiveReactivationLane(ctx: LaneRunContext): Promise<GlobalMaintenanceLaneStatus> {
  if (ctx.settings.autoLlmWriteEnabled === false) return "skipped";
  const windowText = requireOwnerWindowOrSkip(ctx);
  if (windowText === "skipped_no_context") return "skipped";
  if (!ctx.modelRegistry) return "skipped";
  // true → review + mutate; staging-only → review without status flip (matches agent_end).
  const canMutate = ctx.settings.autoLlmWriteEnabled === true;
  const memSettings = resolveMemorySettings();
  const allEntries = await loadEntries(ctx.projectRoot, memSettings, ctx.signal);
  const archived = allEntries.filter((e) => e.status === "archived");
  const result = await runArchiveReactivationIfDue({
    projectRoot: ctx.projectRoot,
    archivedEntries: archived,
    windowText,
    settings: ctx.settings,
    modelRegistry: ctx.modelRegistry as Parameters<typeof runArchiveReactivationIfDue>[0]["modelRegistry"],
    sessionId: ctx.sessionId,
    reactivateEntry: canMutate
      ? async (slug: string, scope: "project" | "world", rationale: string) => {
          try {
            const archivedSource = archived.find((entry) => entry.slug === slug);
            const sourceTimestampUtc = sourceTimestampFromEntry(archivedSource);
            const res = await updateProjectEntry(
              slug,
              {
                status: "active",
                // CAS: reviewer decided from a pre-LLM archived snapshot.
                expected_status: "archived",
                timelineAction: "reactivated",
                // Truncate free-text rationale (agent_end parity).
                timelineNote: `archive-reactivation-reviewer v1: ${String(rationale || "archive reactivation").slice(0, 200)}`,
                sessionId: ctx.sessionId,
              },
              {
                projectRoot: ctx.projectRoot,
                abrainHome: ctx.abrainHome,
                projectId: ctx.projectId,
                settings: ctx.settings,
                scope,
                dryRun: false,
                auditOperation: "archive_reactivation_apply",
                auditContext: {
                  lane: "archive_reactivation",
                  sessionId: ctx.sessionId,
                  candidateId: `archive-reactivation:${slug}`,
                  ...(sourceTimestampUtc ? { sourceTimestampUtc } : {}),
                },
              },
            );
            return { ok: res.status !== "rejected", error: res.reason };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
      : undefined,
  });
  if (result.reactivated_slugs?.length) return "ran";
  return mapSkippedToStatus(result.skipped);
}

const DEFAULT_LANE_RUNNERS: Record<GlobalMaintenanceLane, (ctx: LaneRunContext) => Promise<GlobalMaintenanceLaneStatus>> = {
  forgetting: runForgettingLane,
  aggregator: runAggregatorLane,
  staging_resolver: runStagingResolverLane,
  staging_ageout: runStagingAgeOutLane,
  staging_promotion: runStagingPromotionLane,
  multiview_replay: runMultiviewReplayLane,
  archive_reactivation: runArchiveReactivationLane,
};

function resolveOwnerBinding(
  ownerRoot: string,
  abrainHome: string,
): { projectRoot: string; projectId: string } | null {
  try {
    const resolved = resolveActiveProject(ownerRoot, { abrainHome });
    if (!resolved.activeProject?.projectId || !resolved.activeProject.projectRoot) return null;
    return {
      projectRoot: path.resolve(resolved.activeProject.projectRoot),
      projectId: resolved.activeProject.projectId,
    };
  } catch {
    return null;
  }
}

/**
 * Run all 7 global maintenance lanes across allowed owner roots.
 * Budget/abort bound; returns closed aggregate only (no path/identity).
 *
 * Per-lane honesty: missing model/context/settings → `skipped` (never claim
 * all 7 ran). Window lanes without process-local verified context never call
 * IfDue (no debounce consumption).
 */
export async function runGlobalMaintenanceLanes(
  options: RunGlobalMaintenanceOptions,
): Promise<GlobalMaintenanceAggregate> {
  const lanes = emptyLaneMap("unknown");
  let ownersVisited = 0;
  let ownersSkipped = 0;
  const abrainHome = path.resolve(options.abrainHome || resolveUserGlobalAbrainHome());
  const settings = resolveSedimentSettings();
  const runners = { ...DEFAULT_LANE_RUNNERS, ...(options.laneRunners ?? {}) };
  // Stable synthetic session for audit correlation only (never a real Pi session).
  const sessionId = "daemon-global-maintenance";
  const nowMs = options.now?.() ?? Date.now();

  const ownerRoots = Array.from(new Set(
    (options.ownerRoots ?? [])
      .filter((r): r is string => typeof r === "string" && r.length > 0)
      .map((r) => path.resolve(r)),
  ));

  if (ownerRoots.length === 0) {
    for (const lane of GLOBAL_MAINTENANCE_LANES) lanes[lane] = "skipped";
    return finalizeAggregate(lanes, 0, 0, "worker_configuration_invalid");
  }

  try {
    for (const ownerRoot of ownerRoots) {
      checkBudget(options);
      const bound = resolveOwnerBinding(ownerRoot, abrainHome);
      if (!bound) {
        ownersSkipped += 1;
        continue;
      }
      ownersVisited += 1;
      const windowText = resolveOwnerLocalMaintenanceWindow(bound.projectRoot, nowMs)
        ?? resolveOwnerLocalMaintenanceWindow(ownerRoot, nowMs)
        ?? undefined;
      const ctx: LaneRunContext = {
        projectRoot: bound.projectRoot,
        projectId: bound.projectId,
        abrainHome,
        settings,
        modelRegistry: options.modelRegistry,
        signal: options.signal,
        sessionId,
        ...(windowText ? { windowText } : {}),
      };

      for (const lane of GLOBAL_MAINTENANCE_LANES) {
        checkBudget(options);
        try {
          const status = await runners[lane](ctx);
          lanes[lane] = mergeLaneStatus(lanes[lane], status);
        } catch (error) {
          if (error instanceof GlobalMaintenanceBudgetError) {
            lanes[lane] = mergeLaneStatus(lanes[lane], "budget");
            for (const rest of GLOBAL_MAINTENANCE_LANES) {
              if (lanes[rest] === "unknown") lanes[rest] = "budget";
            }
            return finalizeAggregate(lanes, ownersVisited, ownersSkipped);
          }
          lanes[lane] = mergeLaneStatus(lanes[lane], "failed");
        }
      }
    }
  } catch (error) {
    if (error instanceof GlobalMaintenanceBudgetError) {
      for (const lane of GLOBAL_MAINTENANCE_LANES) {
        if (lanes[lane] === "unknown") lanes[lane] = "budget";
      }
      return finalizeAggregate(lanes, ownersVisited, ownersSkipped);
    }
    for (const lane of GLOBAL_MAINTENANCE_LANES) {
      if (lanes[lane] === "unknown") lanes[lane] = "failed";
    }
    return finalizeAggregate(lanes, ownersVisited, ownersSkipped, "global_maintenance_failed");
  }

  // Any lane still unknown (no owner visited) → skipped.
  for (const lane of GLOBAL_MAINTENANCE_LANES) {
    if (lanes[lane] === "unknown") {
      lanes[lane] = ownersVisited === 0 ? "skipped" : "idle";
    }
  }

  return finalizeAggregate(lanes, ownersVisited, ownersSkipped);
}

function finalizeAggregate(
  lanes: GlobalMaintenanceLaneMap,
  ownersVisited: number,
  ownersSkipped: number,
  errorCode?: string,
): GlobalMaintenanceAggregate {
  let lanesRan = 0;
  let lanesFailed = 0;
  let lanesBudget = 0;
  let lanesSkipped = 0;
  let lanesIdle = 0;
  for (const lane of GLOBAL_MAINTENANCE_LANES) {
    const s = lanes[lane];
    if (s === "ran") lanesRan += 1;
    else if (s === "failed") lanesFailed += 1;
    else if (s === "budget") lanesBudget += 1;
    else if (s === "skipped") lanesSkipped += 1;
    else if (s === "idle") lanesIdle += 1;
  }

  let status: GlobalMaintenanceAggregate["status"];
  let retryable = false;
  let error_code = errorCode;
  if (lanesFailed > 0) {
    status = "failed";
    retryable = true;
    error_code = error_code ?? "global_maintenance_lane_failed";
  } else if (lanesBudget > 0) {
    status = "pending";
    retryable = true;
    error_code = error_code ?? "global_maintenance_budget";
  } else if (lanesRan > 0) {
    status = "drained";
    retryable = false;
  } else {
    // All idle/skipped → idle (nothing due)
    status = "idle";
    retryable = false;
  }

  return {
    lanes,
    owners_visited: ownersVisited,
    owners_skipped: ownersSkipped,
    lanes_ran: lanesRan,
    lanes_failed: lanesFailed,
    lanes_budget: lanesBudget,
    lanes_skipped: lanesSkipped,
    lanes_idle: lanesIdle,
    status,
    retryable,
    ...(error_code ? { error_code } : {}),
  };
}

export function isGlobalMaintenanceLane(value: unknown): value is GlobalMaintenanceLane {
  return typeof value === "string" && LANE_SET.has(value);
}

export function isGlobalMaintenanceLaneStatus(value: unknown): value is GlobalMaintenanceLaneStatus {
  return typeof value === "string" && LANE_STATUS_SET.has(value);
}

/** Closed count buckets shared with publication maintenance (unknown|0|1|2-4|5-9|10-49|50+). */
export function bucketLaneCount(n: number | null | undefined): "unknown" | "0" | "1" | "2-4" | "5-9" | "10-49" | "50+" {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "unknown";
  const c = Math.floor(n);
  if (c <= 0) return "0";
  if (c === 1) return "1";
  if (c <= 4) return "2-4";
  if (c <= 9) return "5-9";
  if (c <= 49) return "10-49";
  return "50+";
}

/** Sanitize lane map for result notify (drop unknown keys / invalid statuses). */
export function sanitizeGlobalMaintenanceLanes(raw: unknown): GlobalMaintenanceLaneMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out = emptyLaneMap("unknown");
  for (const lane of GLOBAL_MAINTENANCE_LANES) {
    const s = o[lane];
    if (!isGlobalMaintenanceLaneStatus(s)) return null;
    out[lane] = s;
  }
  // Reject unexpected keys (closed map).
  for (const key of Object.keys(o)) {
    if (!LANE_SET.has(key)) return null;
  }
  return out;
}
