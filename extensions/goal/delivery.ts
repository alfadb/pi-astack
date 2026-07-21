import { createHash } from "node:crypto";
import { parseGoalContinuationMessage } from "../_shared/goal-continuation";
import { appendGoalAutoContinueAudit } from "./state";

export const GOAL_CONTINUATION_INTENT_TYPE = "pi-goal-continuation";
export const GOAL_CONTINUATION_ACK_TYPE = "pi-goal-continuation-ack";
export const DEFAULT_GOAL_CONTINUATION_ACK_TIMEOUT_MS = 30_000;

export interface GoalSessionRuntimeBinding {
  modelRegistry: unknown;
  appendEntry(customType: string, data: unknown): void;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sendUserMessage(message: string): void;
}

interface RegisteredRuntime extends GoalSessionRuntimeBinding {
  epoch: number;
}

interface AckWaiter {
  deliveryId: string;
  resolve(result: GoalContinuationAckWaitResult): void;
}

interface DeliveryClaim {
  claimedAt: number;
  /** Set immediately before evaluating the one sendUserMessage call. */
  sendAttempted: boolean;
}

interface DeliveryState {
  nextEpoch: number;
  runtimes: Map<string, RegisteredRuntime>;
  waiters: Map<string, Set<AckWaiter>>;
  /** Numeric values are retained for hot-reload compatibility with v2. */
  claims: Map<string, DeliveryClaim | number>;
}

const STATE = Symbol.for("pi-astack/goal/delivery/v2");
const host = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
const CLAIM_TTL_MS = 24 * 60 * 60_000;
const MAX_CLAIMS = 512;

function deliveryState(): DeliveryState {
  const current = host[STATE] as DeliveryState | undefined;
  if (current) return current;
  const created: DeliveryState = {
    nextEpoch: 0,
    runtimes: new Map(),
    waiters: new Map(),
    claims: new Map(),
  };
  host[STATE] = created;
  return created;
}

function ackKey(sessionId: string, messageHash: string): string {
  return `${sessionId}\u0000${messageHash}`;
}

export function goalContinuationMessageHash(message: string): string {
  return createHash("sha256").update(message, "utf-8").digest("hex").slice(0, 12);
}

function audit(cwd: string, row: Record<string, unknown>): void {
  appendGoalAutoContinueAudit(cwd, {
    type: "goal_auto_continue",
    ts: new Date().toISOString(),
    ...row,
  });
}

function activeDeliveryIds(state: DeliveryState): Set<string> {
  const active = new Set<string>();
  for (const waiters of state.waiters.values()) {
    for (const waiter of waiters) active.add(waiter.deliveryId);
  }
  return active;
}

function normalizedClaim(value: DeliveryClaim | number): DeliveryClaim {
  // The old v2 singleton stored only a timestamp and retained every claim.
  // Treat those hot-reloaded claims as attempted: conservative suppression is
  // safer than rolling back a debit whose direct call may already be in flight.
  return typeof value === "number" ? { claimedAt: value, sendAttempted: true } : value;
}

function pruneClaims(state: DeliveryState, now = Date.now()): void {
  const active = activeDeliveryIds(state);
  for (const [id, value] of state.claims) {
    if (!active.has(id) && now - normalizedClaim(value).claimedAt > CLAIM_TTL_MS) state.claims.delete(id);
  }
  while (state.claims.size > MAX_CLAIMS) {
    const victim = [...state.claims.keys()].find((id) => !active.has(id));
    // Never trade exactly-once behavior for the memory bound. Active claims
    // are naturally bounded by live per-session queue workers.
    if (victim === undefined) break;
    state.claims.delete(victim);
  }
}

/** Register only the narrow live capabilities needed by detached Goal work. */
export function registerGoalSessionRuntime(sessionId: string, binding: GoalSessionRuntimeBinding): number {
  const state = deliveryState();
  const epoch = ++state.nextEpoch;
  state.runtimes.set(sessionId, { ...binding, epoch });
  return epoch;
}

export function unregisterGoalSessionRuntime(sessionId: string, epoch: number): void {
  const state = deliveryState();
  if (state.runtimes.get(sessionId)?.epoch === epoch) state.runtimes.delete(sessionId);
}

export function getGoalSessionRuntime(sessionId: string, epoch: number): RegisteredRuntime | undefined {
  const runtime = deliveryState().runtimes.get(sessionId);
  return runtime?.epoch === epoch ? runtime : undefined;
}

export function getGoalSessionRuntimeEpoch(sessionId: string): number | undefined {
  return deliveryState().runtimes.get(sessionId)?.epoch;
}

export type GoalContinuationAckWaitResult =
  | { status: "acknowledged" }
  | { status: "timeout" }
  | { status: "cancelled" };

function cancelAckWaiter(sessionId: string, messageHash: string, deliveryId: string): void {
  const waiters = deliveryState().waiters.get(ackKey(sessionId, messageHash));
  const waiter = waiters ? [...waiters].find((candidate) => candidate.deliveryId === deliveryId) : undefined;
  waiter?.resolve({ status: "cancelled" });
}

function waitForAck(args: {
  sessionId: string;
  messageHash: string;
  deliveryId: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<GoalContinuationAckWaitResult> {
  if (args.signal.aborted) return Promise.resolve({ status: "cancelled" });
  const state = deliveryState();
  const key = ackKey(args.sessionId, args.messageHash);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GoalContinuationAckWaitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal.removeEventListener("abort", onAbort);
      const set = state.waiters.get(key);
      if (set) {
        set.delete(waiter);
        if (set.size === 0) state.waiters.delete(key);
      }
      resolve(result);
    };
    const waiter: AckWaiter = { deliveryId: args.deliveryId, resolve: finish };
    const onAbort = (): void => finish({ status: "cancelled" });
    const timer = setTimeout(() => finish({ status: "timeout" }), Math.max(1, args.timeoutMs));
    const set = state.waiters.get(key) ?? new Set<AckWaiter>();
    set.add(waiter);
    state.waiters.set(key, set);
    args.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Observe a real user message lifecycle event. Only active delivery waiters are
 * acknowledged, so a forged prefix with no in-flight Goal delivery does not
 * create an ack ledger row.
 */
export function observeGoalContinuationUserMessage(
  sessionId: string,
  text: string,
): { goalId: string; messageHash: string; deliveryIds: string[] } | undefined {
  const parsed = parseGoalContinuationMessage(text);
  if (!parsed) return undefined;
  const messageHash = goalContinuationMessageHash(text);
  const key = ackKey(sessionId, messageHash);
  const waiters = deliveryState().waiters.get(key);
  if (!waiters || waiters.size === 0) return undefined;
  const deliveryIds = [...waiters].map((waiter) => waiter.deliveryId);
  for (const waiter of [...waiters]) waiter.resolve({ status: "acknowledged" });
  return { goalId: parsed.goalId, messageHash, deliveryIds };
}

export type GoalContinuationDeliveryPhase =
  | "claim"
  | "runtime_check"
  | "direct_window"
  | "intent_append"
  | "pre_send_check"
  | "send_call"
  | "ack_wait"
  | "acknowledged";

interface GoalContinuationDeliveryMeta {
  messageHash: string;
  deliveryId: string;
  /** True once the sendUserMessage invocation expression has been reached. */
  sendAttempted: boolean;
  phase: GoalContinuationDeliveryPhase;
}

export type GoalContinuationDeliveryResult =
  | ({ status: "acknowledged" } & GoalContinuationDeliveryMeta)
  | ({ status: "unconfirmed"; reason: "ack_timeout" | "cancelled" } & GoalContinuationDeliveryMeta)
  | ({ status: "failed"; reason: "stale_runtime" | "direct_window_timeout" | "intent_append_failed" | "send_call_failed" | "duplicate" } & GoalContinuationDeliveryMeta);

type DirectDeliveryWindowResult = "ready" | "cancelled" | "stale_runtime" | "timeout";

async function waitForDirectDeliveryWindow(args: {
  sessionId: string;
  runtimeEpoch: number;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<DirectDeliveryWindowResult> {
  const deadline = Date.now() + Math.max(1, args.timeoutMs);
  for (;;) {
    if (args.signal.aborted) return "cancelled";
    const runtime = getGoalSessionRuntime(args.sessionId, args.runtimeEpoch);
    if (!runtime) return "stale_runtime";
    try {
      if (runtime.isIdle() && !runtime.hasPendingMessages()) return "ready";
    } catch {
      return "stale_runtime";
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        args.signal.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, Math.min(25, remaining));
      args.signal.addEventListener("abort", finish, { once: true });
      if (args.signal.aborted) finish();
    });
  }
}

/**
 * Exactly-once direct send attempt with observable acknowledgement.
 *
 * Detached agent_end work first waits for a bounded idle/no-pending window.
 * Only then may it use bare sendUserMessage(), which starts a new turn instead
 * of entering pi's follow-up queue. pi.sendUserMessage returns void, so a
 * returned call is never delivery evidence. Delivery is acknowledged only by
 * observeGoalContinuationUserMessage(). Timeout never retries or falls back to
 * followUp because the original async direct request may still arrive.
 */
export async function deliverGoalContinuation(args: {
  cwd: string;
  sessionId: string;
  runtimeEpoch: number;
  goalId: string;
  expectedContinuationsUsed: number;
  message: string;
  signal: AbortSignal;
  ackTimeoutMs?: number;
}): Promise<GoalContinuationDeliveryResult> {
  const state = deliveryState();
  pruneClaims(state);
  const messageHash = goalContinuationMessageHash(args.message);
  const deliveryId = `${args.sessionId}:${args.goalId}:${args.expectedContinuationsUsed}`;
  const base = {
    operation: "continuation_delivery",
    session_id: args.sessionId,
    goal_id: args.goalId,
    continuations_used: args.expectedContinuationsUsed,
    delivery_id: deliveryId,
    message_hash: messageHash,
  };

  const existing = state.claims.get(deliveryId);
  if (existing !== undefined) {
    const existingClaim = normalizedClaim(existing);
    audit(args.cwd, {
      ...base,
      outcome: "duplicate_suppressed",
      phase: "claim",
      send_attempted: existingClaim.sendAttempted,
    });
    return {
      status: "failed",
      reason: "duplicate",
      messageHash,
      deliveryId,
      sendAttempted: existingClaim.sendAttempted,
      phase: "claim",
    };
  }

  const claim: DeliveryClaim = { claimedAt: Date.now(), sendAttempted: false };
  state.claims.set(deliveryId, claim);
  const releaseUnattemptedClaim = (): void => {
    if (!claim.sendAttempted && state.claims.get(deliveryId) === claim) state.claims.delete(deliveryId);
  };

  if (!getGoalSessionRuntime(args.sessionId, args.runtimeEpoch)) {
    releaseUnattemptedClaim();
    audit(args.cwd, { ...base, outcome: "stale_runtime", phase: "runtime_check", send_attempted: false });
    return {
      status: "failed",
      reason: "stale_runtime",
      messageHash,
      deliveryId,
      sendAttempted: false,
      phase: "runtime_check",
    };
  }

  const deliveryTimeoutMs = args.ackTimeoutMs ?? DEFAULT_GOAL_CONTINUATION_ACK_TIMEOUT_MS;
  const window = await waitForDirectDeliveryWindow({
    sessionId: args.sessionId,
    runtimeEpoch: args.runtimeEpoch,
    signal: args.signal,
    timeoutMs: deliveryTimeoutMs,
  });
  if (window !== "ready") {
    releaseUnattemptedClaim();
    const outcome = window === "timeout" ? "direct_window_timeout" : window === "cancelled" ? "cancelled_before_send" : "stale_runtime";
    audit(args.cwd, {
      ...base,
      outcome,
      phase: "direct_window",
      send_attempted: false,
      sent: false,
      intent_recorded: false,
    });
    if (window === "cancelled") {
      return {
        status: "unconfirmed",
        reason: "cancelled",
        messageHash,
        deliveryId,
        sendAttempted: false,
        phase: "direct_window",
      };
    }
    return {
      status: "failed",
      reason: window === "timeout" ? "direct_window_timeout" : "stale_runtime",
      messageHash,
      deliveryId,
      sendAttempted: false,
      phase: "direct_window",
    };
  }

  const ack = waitForAck({
    sessionId: args.sessionId,
    messageHash,
    deliveryId,
    timeoutMs: deliveryTimeoutMs,
    signal: args.signal,
  });
  const intentRuntime = getGoalSessionRuntime(args.sessionId, args.runtimeEpoch);
  if (args.signal.aborted || !intentRuntime) {
    cancelAckWaiter(args.sessionId, messageHash, deliveryId);
    await ack;
    releaseUnattemptedClaim();
    audit(args.cwd, {
      ...base,
      outcome: args.signal.aborted ? "cancelled_before_send" : "stale_runtime",
      phase: "pre_send_check",
      send_attempted: false,
      sent: false,
      intent_recorded: false,
    });
    return args.signal.aborted
      ? { status: "unconfirmed", reason: "cancelled", messageHash, deliveryId, sendAttempted: false, phase: "pre_send_check" }
      : { status: "failed", reason: "stale_runtime", messageHash, deliveryId, sendAttempted: false, phase: "pre_send_check" };
  }

  try {
    intentRuntime.appendEntry(GOAL_CONTINUATION_INTENT_TYPE, {
      goal_id: args.goalId,
      session_id: args.sessionId,
      continuations_used: args.expectedContinuationsUsed,
      delivery_id: deliveryId,
      message_hash: messageHash,
      ts: new Date().toISOString(),
    });
  } catch (error) {
    cancelAckWaiter(args.sessionId, messageHash, deliveryId);
    await ack;
    releaseUnattemptedClaim();
    audit(args.cwd, {
      ...base,
      outcome: "intent_append_failed",
      phase: "intent_append",
      send_attempted: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    return {
      status: "failed",
      reason: "intent_append_failed",
      messageHash,
      deliveryId,
      sendAttempted: false,
      phase: "intent_append",
    };
  }
  audit(args.cwd, {
    ...base,
    outcome: "intent_recorded",
    phase: "intent_append",
    send_attempted: false,
    delivery_mode: "direct",
  });

  const runtime = getGoalSessionRuntime(args.sessionId, args.runtimeEpoch);
  if (args.signal.aborted || !runtime) {
    cancelAckWaiter(args.sessionId, messageHash, deliveryId);
    await ack;
    releaseUnattemptedClaim();
    audit(args.cwd, {
      ...base,
      outcome: args.signal.aborted ? "cancelled_before_send" : "stale_runtime",
      phase: "pre_send_check",
      send_attempted: false,
      sent: false,
      intent_recorded: true,
    });
    return args.signal.aborted
      ? { status: "unconfirmed", reason: "cancelled", messageHash, deliveryId, sendAttempted: false, phase: "pre_send_check" }
      : { status: "failed", reason: "stale_runtime", messageHash, deliveryId, sendAttempted: false, phase: "pre_send_check" };
  }

  // This assignment is the no-rollback boundary. It occurs immediately before
  // the single invocation expression; synchronous throws still count as an
  // attempt because the runtime may have accepted work before throwing.
  claim.sendAttempted = true;
  try {
    runtime.sendUserMessage(args.message);
  } catch (error) {
    cancelAckWaiter(args.sessionId, messageHash, deliveryId);
    await ack;
    audit(args.cwd, {
      ...base,
      outcome: "send_call_failed",
      phase: "send_call",
      send_attempted: true,
      delivery_mode: "direct",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    return {
      status: "failed",
      reason: "send_call_failed",
      messageHash,
      deliveryId,
      sendAttempted: true,
      phase: "send_call",
    };
  }
  audit(args.cwd, {
    ...base,
    outcome: "send_call_returned_void",
    phase: "send_call",
    send_attempted: true,
    delivery_mode: "direct",
    delivered: false,
  });

  const observed = await ack;
  if (observed.status === "acknowledged") {
    audit(args.cwd, {
      ...base,
      outcome: "acknowledged",
      phase: "acknowledged",
      send_attempted: true,
      ack: "user_message_end",
    });
    return { status: "acknowledged", messageHash, deliveryId, sendAttempted: true, phase: "acknowledged" };
  }
  const outcome = observed.status === "timeout" ? "ack_timeout" : "cancelled_waiting_for_ack";
  audit(args.cwd, {
    ...base,
    outcome,
    phase: "ack_wait",
    send_attempted: true,
    retry_suppressed: true,
  });
  return {
    status: "unconfirmed",
    reason: observed.status === "timeout" ? "ack_timeout" : "cancelled",
    messageHash,
    deliveryId,
    sendAttempted: true,
    phase: "ack_wait",
  };
}

export function hasActiveGoalContinuationDelivery(sessionId: string, goalId: string): boolean {
  const prefix = `${sessionId}:${goalId}:`;
  for (const waiters of deliveryState().waiters.values()) {
    for (const waiter of waiters) if (waiter.deliveryId.startsWith(prefix)) return true;
  }
  return false;
}

/** Test-only reset. Do not call while delivery waiters are active. */
export function resetGoalDeliveryStateForTests(): void {
  const state = deliveryState();
  if (state.waiters.size > 0) throw new Error("cannot reset active Goal delivery waiters");
  state.runtimes.clear();
  state.claims.clear();
  state.nextEpoch = 0;
}
