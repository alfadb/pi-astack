---
doc_type: adr
status: accepted
---

# ADR 0041 - `prompt_user` waits without a deadline

- **Status**: Accepted (2026-07-13, user-directed behavior change).
- **Date**: 2026-07-13.
- **Relates-to**: [ADR 0022](./0022-prompt-user-tool.md).
- **Supersedes-direction**: Supersedes only ADR 0022's `timeoutSec` parameter, default/clamp, countdown, timer, and `timeout` terminal result. All other ADR 0022 trust, privacy, concurrency, audit, and UI boundaries remain active.
- **Implementation status**: Shipped with this decision; current behavior is recorded in [current-state.md](../current-state.md) and REQ-008.

## Context

A structured question represents a real pause for a user decision. Expiring that pause because the user did not answer within an agent-selected or default interval converts silence into a synthetic terminal result and can make the agent continue without the required decision. The desired product behavior is to keep waiting.

The timeout path also enlarged the public contract and UI lifecycle: callers could set `timeoutSec`, validation supplied a default and clamp, the manager owned a timer, audit exposed a timeout outcome, and UI teardown had to race the timer. None of those surfaces are needed when silence means "still waiting".

## Decision

`prompt_user` has no deadline and exposes no timeout parameter. Once accepted by validation and shown to the user, it remains pending until one of these terminal events occurs:

- the user submits an answer;
- the user actively rejects or presses Esc;
- the turn's `ctx.signal` aborts;
- `session_shutdown` or another explicit lifecycle drain calls `cancelAllPending`.

There is no elapsed-time terminal event, no default timeout, no timeout clamp, no countdown UI, and no `timeout` failure reason or audit outcome. A pending prompt continues to block a concurrent `prompt_user` call and continues to defer compaction.

## Safety Boundary

Removing the timer does not weaken secret handling. Every remaining terminal event still converges on the manager's idempotent resolver. Its registered disposer wipes `PromptDialog` component-local secret and paste buffers and closes the editor region before the awaiting caller observes completion. Raw secret input remains unavailable to the LLM and audit surfaces.

Session and turn termination remain explicit cancellation paths, so an indefinite user wait does not prevent controlled shutdown. Tests must prove both halves of the contract: elapsed time alone does not settle the promise, while user cancel, signal abort, and lifecycle drain do settle it and clear pending state.

## Consequences

A session can remain paused indefinitely while the user is away. This is intentional. Operators and hosts must use the existing turn abort or session shutdown paths when they need to terminate the wait; callers cannot impose their own deadline.

Historical ADR 0022 text remains unchanged as the record of the earlier design. Readers must apply this ADR's narrow supersede relation when interpreting its timeout sections.
