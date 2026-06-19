import type {
  ConstraintEventProjectionRecord,
  ConstraintEventProjectionStatus,
  ConstraintEventProjectionSummary,
} from "./types";

export function summarizeConstraintEventProjectionStatus(
  records: ConstraintEventProjectionRecord[],
  options: { nowMs?: number } = {},
): ConstraintEventProjectionSummary {
  const nowMs = options.nowMs ?? Date.now();
  const counts: Record<ConstraintEventProjectionStatus, number> = {
    queued: 0,
    projected: 0,
    stale: 0,
    invalid: 0,
    append_failed: 0,
  };
  let oldestQueuedAtMs: number | undefined;
  for (const record of records) {
    counts[record.status] += 1;
    if (record.status !== "queued" || !record.observedAtUtc) continue;
    const observedAtMs = Date.parse(record.observedAtUtc);
    if (!Number.isFinite(observedAtMs)) continue;
    oldestQueuedAtMs = oldestQueuedAtMs === undefined ? observedAtMs : Math.min(oldestQueuedAtMs, observedAtMs);
  }
  return {
    total: records.length,
    queued: counts.queued,
    projected: counts.projected,
    stale: counts.stale,
    invalid: counts.invalid,
    appendFailed: counts.append_failed,
    ...(oldestQueuedAtMs === undefined ? {} : { oldestQueuedAgeMs: Math.max(0, nowMs - oldestQueuedAtMs) }),
  };
}

export function markStaleQueuedConstraintEvents(
  records: ConstraintEventProjectionRecord[],
  options: { nowMs?: number; staleAfterMs: number },
): ConstraintEventProjectionRecord[] {
  const nowMs = options.nowMs ?? Date.now();
  return records.map((record) => {
    if (record.status !== "queued" || !record.observedAtUtc) return { ...record };
    const observedAtMs = Date.parse(record.observedAtUtc);
    if (!Number.isFinite(observedAtMs) || nowMs - observedAtMs <= options.staleAfterMs) return { ...record };
    return { ...record, status: "stale" };
  });
}
