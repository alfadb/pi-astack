/**
 * Bounded per-worker-run tool execution snapshot.
 *
 * Maintains active/last tool metadata from SDK
 * `tool_execution_start|update|end` events only. Heartbeat alive beats are
 * intentionally NOT tool progress and must never enter this tracker.
 *
 * Safety: only tool name, tool_call_id, status, timestamps, and age_ms are
 * retained. Tool args, commands, outputs, prompts, reasoning, and any
 * attacker-controlled field names are never stored.
 *
 * age_ms is progress age, not total runtime:
 *   age_ms = max(0, snapshotNowMs - last_update_at_ms)
 * start/update/end all refresh last_update_at_ms, so:
 *   - running with no later update ≈ idle since start
 *   - just after update ≈ 0
 *   - completed/error ≈ age since the end event
 *
 * Capacity / orphan policy (conservative):
 *   - maxTracked is hard-capped at MAX_TRACKED_TOOL_RUNS (32).
 *   - Missing/empty toolCallId events are ignored (no shared "unknown" slot).
 *   - Orphan update/end without a prior start are ignored.
 *   - At capacity: finished slots may be reclaimed; still-running tools are
 *     never evicted. New starts that cannot fit are dropped.
 */

export type ToolRunStatus = "running" | "completed" | "error";

/** Safe tool metadata for idle-timeout / terminal audit. */
export interface ToolRunSnapshot {
  tool_name: string;
  tool_call_id: string;
  status: ToolRunStatus;
  started_at: string;
  last_update_at?: string;
  completed_at?: string;
  /**
   * Progress age in ms: snapshot now − last_update_at_ms (clamped ≥ 0).
   * Not wall-clock total runtime (started → completed/now).
   */
  age_ms: number;
}

/** Terminal-facing aggregate: concurrent actives + most-recently-touched tool. */
export interface ToolRunSnapshotSummary {
  active_count: number;
  active: ToolRunSnapshot[];
  last?: ToolRunSnapshot;
}

/** Hard cap on concurrently tracked tool_call_ids (prevents unbounded Map). */
export const MAX_TRACKED_TOOL_RUNS = 32;

interface InternalToolRun {
  tool_name: string;
  tool_call_id: string;
  status: ToolRunStatus;
  started_at_ms: number;
  last_update_at_ms: number;
  completed_at_ms?: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sanitizeToolName(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim();
  if (!trimmed) return "unknown";
  // Bound length; reject control chars. Name only — never args.
  return trimmed.slice(0, 128).replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * Returns a sanitized toolCallId, or undefined when the id is missing/empty.
 * Callers must ignore events without a correlatable id (no shared "unknown"
 * bucket that would merge unrelated orphans).
 */
function sanitizeToolCallId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 128).replace(/[\u0000-\u001f\u007f]/g, "");
}

function toSnapshot(entry: InternalToolRun, nowMs: number): ToolRunSnapshot {
  const snap: ToolRunSnapshot = {
    tool_name: entry.tool_name,
    tool_call_id: entry.tool_call_id,
    status: entry.status,
    started_at: iso(entry.started_at_ms),
    // Progress age: time since last start/update/end touch, not total runtime.
    age_ms: Math.max(0, nowMs - entry.last_update_at_ms),
  };
  if (entry.last_update_at_ms !== entry.started_at_ms || entry.status === "running") {
    snap.last_update_at = iso(entry.last_update_at_ms);
  }
  if (entry.completed_at_ms !== undefined) {
    snap.completed_at = iso(entry.completed_at_ms);
  }
  return snap;
}

/**
 * Per-worker-run tracker. One instance owns one runInProcess invocation.
 *
 * Concurrent tools: each tool_call_id is independent. Completing tool A
 * never erases still-running tool B; `active_count` reflects still-running
 * tools at snapshot time.
 */
export class ToolRunTracker {
  private readonly active = new Map<string, InternalToolRun>();
  private last?: InternalToolRun;
  private readonly maxTracked: number;

  constructor(maxTracked: number = MAX_TRACKED_TOOL_RUNS) {
    // Force-cap at MAX_TRACKED_TOOL_RUNS regardless of caller argument.
    const n = Number.isFinite(maxTracked) ? Math.floor(maxTracked) : MAX_TRACKED_TOOL_RUNS;
    this.maxTracked = Math.min(MAX_TRACKED_TOOL_RUNS, Math.max(1, n));
  }

  /** tool_execution_start — open or replace a running slot. */
  onStart(toolName: unknown, toolCallId: unknown, atMs: number = Date.now()): void {
    const id = sanitizeToolCallId(toolCallId);
    if (!id) return; // missing/empty id → ignore
    const name = sanitizeToolName(toolName);
    if (this.active.has(id)) {
      // Duplicate id: replace in place (same correlation key).
      const entry: InternalToolRun = {
        tool_name: name,
        tool_call_id: id,
        status: "running",
        started_at_ms: atMs,
        last_update_at_ms: atMs,
      };
      this.active.set(id, entry);
      this.last = entry;
      return;
    }
    if (this.active.size >= this.maxTracked) {
      // Prefer reclaiming finished slots. Never evict a still-running tool.
      if (!this.evictFinishedOne()) return; // capacity full of running → drop
    }
    const entry: InternalToolRun = {
      tool_name: name,
      tool_call_id: id,
      status: "running",
      started_at_ms: atMs,
      last_update_at_ms: atMs,
    };
    this.active.set(id, entry);
    this.last = entry;
  }

  /** tool_execution_update — touch last_update_at only (no payload). */
  onUpdate(toolName: unknown, toolCallId: unknown, atMs: number = Date.now()): void {
    const id = sanitizeToolCallId(toolCallId);
    if (!id) return;
    const existing = this.active.get(id);
    if (!existing) {
      // Orphan update without start: ignore (conservative — no invented slot).
      return;
    }
    existing.last_update_at_ms = atMs;
    if (existing.status === "running") {
      const name = sanitizeToolName(toolName);
      if (existing.tool_name === "unknown" && name !== "unknown") {
        existing.tool_name = name;
      }
    }
    this.last = existing;
  }

  /** tool_execution_end — mark completed/error; keep slot until snapshot. */
  onEnd(
    toolName: unknown,
    toolCallId: unknown,
    isError: boolean,
    atMs: number = Date.now(),
  ): void {
    const id = sanitizeToolCallId(toolCallId);
    if (!id) return;
    const existing = this.active.get(id);
    if (!existing) {
      // Orphan end without start: ignore (conservative — no invented slot).
      return;
    }
    existing.status = isError ? "error" : "completed";
    existing.completed_at_ms = atMs;
    existing.last_update_at_ms = atMs;
    const name = sanitizeToolName(toolName);
    if (existing.tool_name === "unknown" && name !== "unknown") {
      existing.tool_name = name;
    }
    this.last = existing;
  }

  /**
   * Snapshot for terminal audit. Active = still running; last = most
   * recently touched (may be completed). Completed/error entries that are
   * not `last` are dropped from the map after snapshot to bound memory
   * across long runs — but the returned snapshot is self-contained.
   *
   * Prune uses collect-then-delete for readability (JS Map for-of + delete
   * of non-visited finished keys is also safe per ECMAScript Map iteration
   * semantics, but collect-then-delete makes intent explicit).
   */
  snapshot(nowMs: number = Date.now()): ToolRunSnapshotSummary {
    const active: ToolRunSnapshot[] = [];
    for (const entry of this.active.values()) {
      if (entry.status === "running") {
        active.push(toSnapshot(entry, nowMs));
      }
    }
    // Stable order by started_at then tool_call_id for determinism.
    active.sort((a, b) =>
      a.started_at < b.started_at
        ? -1
        : a.started_at > b.started_at
          ? 1
          : a.tool_call_id.localeCompare(b.tool_call_id),
    );
    const last = this.last ? toSnapshot(this.last, nowMs) : undefined;
    // Collect-then-delete finished entries that are not the last-touched one.
    const toPrune: string[] = [];
    for (const [id, entry] of this.active) {
      if (entry.status !== "running" && entry !== this.last) {
        toPrune.push(id);
      }
    }
    for (const id of toPrune) this.active.delete(id);
    return {
      active_count: active.length,
      active,
      ...(last ? { last } : {}),
    };
  }

  /** Reclaim one finished slot. Returns true if a slot was freed. */
  private evictFinishedOne(): boolean {
    for (const [id, entry] of this.active) {
      if (entry.status !== "running") {
        this.active.delete(id);
        if (this.last === entry) this.last = undefined;
        return true;
      }
    }
    return false;
  }
}

/** Audit-safe projection: only the allowlisted keys. */
export function toolSnapshotAuditFields(
  summary: ToolRunSnapshotSummary | undefined,
): Record<string, unknown> {
  if (!summary) return {};
  const out: Record<string, unknown> = {
    active_tool_count: summary.active_count,
  };
  if (summary.active.length > 0) {
    out.active_tools = summary.active.map(projectToolSnapshot);
  }
  if (summary.last) {
    out.last_tool = projectToolSnapshot(summary.last);
  }
  return out;
}

function projectToolSnapshot(snap: ToolRunSnapshot): Record<string, unknown> {
  return {
    tool_name: snap.tool_name,
    tool_call_id: snap.tool_call_id,
    status: snap.status,
    started_at: snap.started_at,
    ...(snap.last_update_at ? { last_update_at: snap.last_update_at } : {}),
    ...(snap.completed_at ? { completed_at: snap.completed_at } : {}),
    age_ms: snap.age_ms,
  };
}

/** Details-facing camelCase projection (no sensitive payload). */
export function toolSnapshotDetailsFields(
  summary: ToolRunSnapshotSummary | undefined,
): Record<string, unknown> {
  if (!summary) return {};
  const out: Record<string, unknown> = {
    activeToolCount: summary.active_count,
  };
  if (summary.active.length > 0) {
    out.activeTools = summary.active.map((s) => ({
      toolName: s.tool_name,
      toolCallId: s.tool_call_id,
      status: s.status,
      startedAt: s.started_at,
      ...(s.last_update_at ? { lastUpdateAt: s.last_update_at } : {}),
      ...(s.completed_at ? { completedAt: s.completed_at } : {}),
      ageMs: s.age_ms,
    }));
  }
  if (summary.last) {
    out.lastTool = {
      toolName: summary.last.tool_name,
      toolCallId: summary.last.tool_call_id,
      status: summary.last.status,
      startedAt: summary.last.started_at,
      ...(summary.last.last_update_at ? { lastUpdateAt: summary.last.last_update_at } : {}),
      ...(summary.last.completed_at ? { completedAt: summary.last.completed_at } : {}),
      ageMs: summary.last.age_ms,
    };
  }
  return out;
}
