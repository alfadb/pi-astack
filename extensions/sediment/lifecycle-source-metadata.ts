import { createHash } from "node:crypto";
import type { MultiviewPendingEntry } from "./multiview-staging-types";

export const LIFECYCLE_COHORT_CUTOVER_UTC = "2026-07-16T18:55:00.000Z" as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type LifecycleQueueKind = "provisional_correction" | "multiview_pending" | "entry_lifecycle_proposal";
export type LifecycleCohort = "legacy" | "fresh";
export type LifecycleFailureClass = "none" | "provider" | "transient" | "parse" | "conflict" | "writer" | "semantic_defer";

export function validLifecycleIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function lifecycleCohortFor(arrivalAt: string): LifecycleCohort {
  return Date.parse(arrivalAt) < Date.parse(LIFECYCLE_COHORT_CUTOVER_UTC) ? "legacy" : "fresh";
}

export function lifecycleItemId(queueKind: LifecycleQueueKind, stableParts: unknown[]): string {
  const digest = createHash("sha256")
    .update(stableParts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `lc-${queueKind.replace(/_/g, "-")}-${digest}`;
}

export function multiviewLifecycleFailureClass(entry: MultiviewPendingEntry): LifecycleFailureClass {
  if (entry.approved_decision || (entry.writer_retry_attempts ?? 0) > 0 || entry.brain_write_intent_at_iso) return "writer";
  switch (entry.multiview_state) {
    case "reviewer_unavailable": return "provider";
    case "pass1_unparseable":
    case "pass2_unparseable": return "parse";
    case "deferred": return "semantic_defer";
    case "pass1_call_failed":
    case "pass2_call_failed":
    case "synthesis_call_failed": return "transient";
    default: {
      const exhaustive: never = entry.multiview_state;
      throw new Error(`unknown multiview lifecycle state: ${String(exhaustive)}`);
    }
  }
}

export function boundedLifecycleRetryDelayMs(failureClass: LifecycleFailureClass, attempt: number): number {
  const exponent = Math.max(0, Math.min(10, Math.floor(attempt) - 1));
  const config: Record<LifecycleFailureClass, { base: number; max: number }> = {
    none: { base: 5 * MINUTE_MS, max: 60 * MINUTE_MS },
    provider: { base: 60 * MINUTE_MS, max: DAY_MS },
    transient: { base: 15 * MINUTE_MS, max: 6 * 60 * MINUTE_MS },
    parse: { base: 6 * 60 * MINUTE_MS, max: DAY_MS },
    conflict: { base: 6 * 60 * MINUTE_MS, max: DAY_MS },
    writer: { base: MINUTE_MS, max: 60 * MINUTE_MS },
    semantic_defer: { base: DAY_MS, max: 14 * DAY_MS },
  };
  const selected = config[failureClass];
  return Math.min(selected.max, selected.base * 2 ** exponent);
}

export function scheduleLifecycleRetry(
  now: Date,
  failureClass: LifecycleFailureClass,
  attempt: number,
  horizonMs: number,
): { next: string; deadline: string } {
  const nextMs = now.getTime() + boundedLifecycleRetryDelayMs(failureClass, Math.max(1, attempt));
  return {
    next: new Date(nextMs).toISOString(),
    deadline: new Date(nextMs + horizonMs).toISOString(),
  };
}

/**
 * Materialize the complete RM-LIFECYCLE-002 contract on a live multiview
 * source. Creation and reconciliation both use this helper so item identity
 * and scheduling cannot drift between the two paths.
 */
export function ensureMultiviewLifecycleMetadata(
  entry: MultiviewPendingEntry,
  now: Date = new Date(),
): MultiviewPendingEntry {
  const arrival = validLifecycleIso(entry.created);
  if (!arrival) throw new Error("multiview lifecycle source has invalid created timestamp");

  const failureClass = multiviewLifecycleFailureClass(entry);
  const attempt = Math.max(0, entry.retry_attempts ?? 0) + Math.max(0, entry.writer_retry_attempts ?? 0);
  const horizonMs = failureClass === "writer" ? DAY_MS : 14 * DAY_MS;
  const schedule = scheduleLifecycleRetry(now, failureClass, Math.max(1, attempt), horizonMs);
  const next = validLifecycleIso(entry.next_retry_not_before_iso)
    ?? validLifecycleIso(entry.lifecycle_next_retry_not_before)
    ?? schedule.next;

  entry.lifecycle_item_id = entry.lifecycle_item_id
    ?? lifecycleItemId("multiview_pending", [arrival, entry.slug, entry.originating_device]);
  entry.lifecycle_cohort = entry.lifecycle_cohort ?? lifecycleCohortFor(arrival);
  entry.lifecycle_attempt = attempt;
  entry.lifecycle_failure_class = failureClass;
  entry.lifecycle_next_retry_not_before = next;
  entry.lifecycle_deadline = validLifecycleIso(entry.lifecycle_deadline) ?? schedule.deadline;
  entry.lifecycle_new_evidence_trigger = entry.lifecycle_new_evidence_trigger ?? (failureClass === "writer"
    ? "writer_or_storage_recovered|retry_due"
    : "reviewer_or_provider_recovered|retry_due|origin_project_session");
  return entry;
}
