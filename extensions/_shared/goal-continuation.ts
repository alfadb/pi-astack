/**
 * Shared contract for goal auto-continue transcript provenance isolation
 * (PR-7 / P1b, impl-plan 2026-06-10 §P1 hard-constraint 2a).
 *
 * Why a transcript-layer string prefix is the PRIMARY defense
 * (INV-IMPLICIT-GROUND-TRUTH): a continuation message is injected as a
 * USER-role message (pi.sendUserMessage), but its content is machine-
 * composed (goal judge next_step). sediment's window builder
 * (checkpoint.ts / context-packer.ts) only preserves `msg.role` — the
 * event-level `source:"extension"` discriminator does NOT survive into
 * the packed transcript. The prefix is therefore the only signal that
 * survives to deriveProvenance, which must NOT classify these turns as
 * user-expressed (else the goal loop could launder assistant-composed
 * text into Tier-1 rules).
 *
 * Both sides import THIS module so the producer (goal extension) and the
 * consumer (sediment deriveProvenance) can never drift:
 *   - goal/continue.ts composes messages via formatGoalContinuationMessage
 *   - sediment/correction-pipeline.ts demotes user-role turns matching
 *     isGoalContinuationText to machine-origin (assistant-observed sink)
 *
 * Detection is deterministic prefix matching, fail-closed in the demote
 * direction: a FORGED prefix typed by a real user costs only a Tier-1
 * demote of their own directive (visible via R3' recall flag), never a
 * promote.
 */

export const GOAL_CONTINUATION_PREFIX = "[pi-goal-continuation";

export function formatGoalContinuationMessage(goalId: string, instruction: string): string {
  return `${GOAL_CONTINUATION_PREFIX} goal_id=${goalId}] ${instruction}`;
}

/** True when a transcript turn's text is a goal continuation message.
 *  trimStart absorbs leading whitespace the transport may add; the packer
 *  keeps message starts verbatim for user-role turns. */
export function isGoalContinuationText(text: string): boolean {
  return text.trimStart().startsWith(GOAL_CONTINUATION_PREFIX);
}
