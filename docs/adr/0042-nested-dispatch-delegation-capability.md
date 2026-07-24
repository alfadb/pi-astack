---
doc_type: adr
status: superseded
---

# ADR 0042 - Nested Dispatch Delegation Capability (retired)

- **Status**: Superseded / permanently retired (2026-07-24 owner decision).
- **Relates-to**: [ADR 0009](./0009-multi-agent-as-base-capability.md), [ADR 0027](./0027-coupled-stigmergic-dual-loop-agent-system.md). ADR 0030 remains a retired historical record only.
- **Historical note**: An earlier accepted revision of this ADR defined a nested-delegation architecture (capability, broker, audit, shadow bridge, tree governor, process provider limiter, staged H5/live gates). That design is **not** restated here. Git history holds the full text as historical evidence only; it does **not** authorize restoration.

## Decision (2026-07-24)

**Nested / recursive subagent dispatch is permanently forbidden again.**

Owner rationale: multi-layer task restatement produced goal drift. Orchestration returns to **main-session-only**. Workers execute; they do not re-dispatch, re-plan, or re-orchestrate.

### Permanent structural denials

The following five structural tools are denied to every sub-agent with **no exceptions** (preflight + SDK `excludeTools`):

1. `dispatch_agent`
2. `dispatch_parallel`
3. `workflow_run`
4. `prompt_user`
5. `vault_release`

There is no shadow mode, capability grant, depth-1 exception, or broker path that can lift any of these denials for a sub-agent.

### What was deleted

All runtime scaffolding for nested delegation has been removed from the tree, including:

- capability / broker / audit modules
- shadow bridge
- tree governor
- process provider limiter
- four dedicated delegation smoke scripts

### What remains

Single-layer dispatch is unchanged:

- main session may call `dispatch_agent` / `dispatch_parallel` once to create workers
- `WorkerRunGovernor` continues to own one worker's retry/output/tool-loop observations
- workflow fixed DAG (`workflow_run` + DSL) remains a main-session orchestration path; stages cannot request spawn-class tools

### Restoration rule

Any future restore of nested / recursive delegation requires **all** of:

1. a **new** owner decision
2. a **new** ADR
3. an independent H5 evidence package

The retired accepted design in git history is evidence of past intent only. It does not authorize re-enabling nested execution, reintroducing deleted modules, or treating this ADR as an open rollout/backlog item.

## Consequences

- Sub-agents stay fail-closed against structural fan-out tools.
- Main session remains the only orchestration surface for multi-agent work.
- Documentation and smoke tests assert permanent denial and absence of retired scaffolding; they do not describe shadow/H5/live batches as current work.
