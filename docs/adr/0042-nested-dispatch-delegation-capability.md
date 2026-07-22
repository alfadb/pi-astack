---
doc_type: adr
status: accepted
---

# ADR 0042 - Nested Dispatch Delegation Capability

- **Status**: Accepted (2026-07-22; offline core plus second-wave non-delegating shadow connected; no nested session authorization).
- **Relates-to**: [ADR 0009](./0009-multi-agent-as-base-capability.md), [ADR 0027](./0027-coupled-stigmergic-dual-loop-agent-system.md), [ADR 0030](./0030-l2-hub-baseline-and-evaluation-harness.md) (retired historical record only).
- **Supersedes-direction**: Supersedes the absolute principles that nested dispatch is *never* delegable and that delegation-class Category-C capability is a *permanent* deny. It does not remove the current runtime deny or authorize any live depth.
- **Scope**: Defines the capability, governor, provider-limiter, broker, audit, and rollout architecture for possible future nested delegation. The offline core and production-connected non-delegating shadow are implemented; no nested execution is enabled.

## Background

Production `dispatch_agent` and `dispatch_parallel` create one layer of independent sub-agent sessions. By default, a target sub-agent receives ordinary tools from its actual dynamic tool registry while five structural tools remain denied by both preflight validation and SDK `excludeTools`: `dispatch_agent`, `dispatch_parallel`, `workflow_run`, `prompt_user`, and `vault_release`. The second-wave exception can expose an explicitly requested dispatch name only to a capability-bound non-delegating shadow evaluator; it still cannot create a nested session. Nested execution therefore remains impossible and fail-closed.

The old rule promoted that implementation boundary into an absolute architecture principle: nested dispatch would never be delegated, and delegation-class Category-C tools would remain permanently denied. That rule avoided fan-out amplification but could not express bounded delegation, revocation, hierarchical resource accounting, waiting-parent liveness, or a staged depth-1 read-only experiment. It also conflated an ordinary tool capability with an amplifying broker that can create another execution.

ADR 0030 cannot be reused to relax the boundary. Its dynamic `dispatch_hub` object and evaluation path are retired. Restoring hub/planner topology would reintroduce the rejected `task -> hub -> worker` translation layer. Nested delegation needs a separate architecture in which a non-LLM broker enforces a capability chosen by the existing caller without rewriting the task.

Three rounds of independent T0 review converged unanimously on the following conclusions:

- ordinary tools are authorized against the target's live dynamic registry, while delegation is an amplifying broker capability;
- the LLM never receives the delegation handle; authority decays under a partial order and delegation authorization is atomic;
- a per-root single-writer tree governor and process-wide per-provider limiter are distinct owners;
- waiting parents release active execution capacity but retain open sessions, and eligible resume is fair and starvation-free;
- abort, revoke, shutdown, drain, deadline, required audit, and privacy semantics must exist before any live gate;
- rollout order is read-only replay, non-delegating shadow, a new independent H5, production depth 1 read-only, then capability batches.

This ADR accepts those conclusions. It does not claim that T0 agreement is runtime evidence or an H5 clearance.

## Decision

### D1 - Ordinary registry tools and the amplifying broker are different capabilities

Ordinary child tools use the target session's actual dynamic registry. A registered and active extension tool is eligible in the same way as a built-in tool; no new static `KNOWN_TOOLS` allowlist is introduced. A requested tool must still exist in the current target registry, and the broker must know whether it can mutate the host.

Delegation itself is not an ordinary tool grant. It is an **amplifying broker** operation because one authorization can create another execution and another capability-bearing lineage node. Merely registering a tool named like a dispatcher does not grant amplification.

### D2 - Delegation authority is an opaque in-process identity

A delegation capability is an opaque object whose validity depends on object identity in a process-owned `WeakMap`. Only the capability module creates valid handles. Shape-compatible objects, copies, JSON, strings, prompts, and model output cannot construct one.

The handle stays in trusted runtime closures and is never included in an LLM prompt, tool arguments, tool results, audit rows, or session metadata. Its process-owned record binds `rootRef`, exact holder node, parent node, and depth; only broker-only inspection can read those fields. A broker rejects the handle unless its root matches the governor root and the requested parent exactly matches the holder. This is not a cryptographic bearer-token design and makes no cross-process authority claim. Trusted same-process code remains inside the threat boundary.

### D3 - Authority follows a monotone partial order

Every child capability must be less than or equal to its parent:

- tool, model, and profile sets are subsets/intersections of the parent sets;
- the child deadline is no later than the parent deadline;
- remaining depth decreases by at least one on every delegated edge;
- mutation authority can change from allowed to denied, never from denied to allowed;
- typed constraints narrow under the kind-specific partial order defined below; different kinds compose by logical AND;
- `maxDescendantRuns` decays on each edge and `maxConcurrentLeaves` cannot increase;
- every child receives a separate revocation cell and retains its ancestors' revocation links; revoking or terminating one node invalidates that handle and its descendants without invalidating siblings;
- root renewal advances its revocation generation and issues a fresh root identity while every handle from older generations remains invalid.

All deadlines, depths, counts, byte bounds, and concurrency ceilings are explicit constructor inputs validated as finite non-negative safe integers. This ADR defines no hidden budget constants. The second wave adds dynamic branch accounting: every accepted child consumes one descendant run from its holder and every ancestor, that consumption is never refunded, and current open descendant leaves are recomputed across the actual lineage tree. Every ancestor's `maxConcurrentLeaves` is checked in the same serialized authorization transaction. A child terminal, delegation failure, revoke, or root shutdown releases its active leaf state without restoring descendant-run budget. The root `TreeGovernor` separately remains the final owner of accepted-run, active-execution, and open-session budgets.

Typed constraints are canonical and monotone, not an append-only bag. `workspace_roots` entries are normalized absolute paths. If a parent has that kind, every child root must be equal to or path-contained by at least one parent root, and the canonical result is the child root set; if the parent has no such kind, the child may add one. `max_output_bytes` may be added when absent and otherwise may only stay equal or decrease. `tool_schema` is keyed by tool: a child may add a previously unconstrained tool, but an inherited tool must retain the exact parent `schemaId`. Canonical input has at most one workspace-root set, one output-byte limit, and one schema per tool; conflicting duplicates are invalid. Constraints of different kinds all remain in force as a logical AND.

Typed constraints are not prompt promises. They are enforceable only when the amplifying broker has a corresponding deterministic enforcer. A constrained capability presented to a broker without an enforcer is rejected.

### D4 - Authorization and delegation initiation are one serialized operation

The tree owner exposes one `authorize-and-delegate` operation. It validates root/parent state and budgets, reserves the next lineage node under the single writer, permanently consumes that lineage sequence number, performs any required pre-delegation audit barrier, commits accepted-run/active/open accounting, and synchronously invokes the delegation callback before releasing the transaction. A later audit, signal, deadline, constraint, or callback rejection leaves an intentional sequence hole; that lineage is never reused.

There is no separate “check budget, later delegate” API. Concurrent callers cannot both observe the same remaining budget. A required audit failure occurs before acceptance and prevents delegation. The broker writes denial closure against the same reserved lineage when one exists; a pre-reservation rejection receives a process-unique audit-safe request/denial reference. If an authorization row was synced before a later pre-delegation abort, a denial row closes that same request and lineage. Once accepted, a synchronous delegation failure terminates that node as failed, writes lifecycle rather than denial, and does **not** refund the accepted run.

The required `beforeDelegate` hook runs in a governor-marked `AsyncLocalStorage` callback context, so awaiting a governor operation from that hook rejects immediately as reentrant and cannot deadlock the writer. The external `delegate` and `onTerminal` adapters still execute synchronously inside the serialized transaction, but under an exited ALS context. Async resources they create can later call the governor and queue behind the current transaction instead of inheriting a permanent false reentrant marker. Exiting ALS does not release or overlap the single-writer transaction.

The callback is an abstraction boundary. Offline tests use plain values, and the production shadow adapter can return only its frozen no-delegate sentinel; neither path creates a session. A future nested execution adapter requires its own H5 authorization under D11.

### D5 - Tree and provider concurrency have separate owners

Each delegation root owns exactly one `TreeGovernor` instance and one in-memory tree. The governor serializes all mutations and owns hierarchy state, accepted-run accounting, active-execution accounting, open-session accounting, root deadline, parent/child registration, resume order, and terminal first-wins semantics.

A distinct process-wide limiter module owns provider concurrency. It partitions queues by provider, serves each provider in FIFO order, returns idempotent leases, removes aborted waiters without leaking capacity, rejects a zero limit immediately as `provider_disabled`, and stores state under `globalThis[Symbol.for(...)]` so independent jiti module copies share one process owner.

The first-wave broker does **not** depend on this limiter, acquire a lease during authorization/delegation, pass a lease to the delegation callback, or retain a lease for session lifetime. Pi SDK exposes no provider-request hook in this wave. A future runtime adapter must acquire and release around each actual provider request, after a separate live gate. The tree governor must not absorb provider queues, and the provider limiter must not infer tree lifecycle. `WorkerRunGovernor` remains the separate owner of one worker's retry/output/tool-loop observations; its logic is not copied into `TreeGovernor`.

### D6 - Accepted runs, active executions, and open sessions are different quantities

- `acceptedRuns` is monotone and never refunded after acceptance, including delegation or execution failure.
- `activeExecutions` counts nodes currently consuming execution capacity.
- `openSessions` counts non-terminal delegated sessions, including waiting parents.

A node can therefore be waiting with `activeExecutions` released while `openSessions` remains charged. Closing or terminating the node releases open-session capacity but never accepted-run budget.

### D7 - Waiting and resume preserve liveness

A parent that waits for children releases its active execution slot and retains its open session. Waiting nodes enter a deterministic resume queue. When capacity becomes available, the governor resumes the earliest eligible waiter. An ineligible earlier waiter does not block a later eligible waiter, but once it becomes eligible it retains priority over later arrivals. Stale, aborted, revoked, or terminal waiters are removed.

This is FIFO among eligible waiters and is designed to avoid starvation. Resume is a governor state transition; it is not inferred from silence or delegated to an LLM.

### D8 - Terminal, abort, revoke, shutdown, and drain are explicit

Node and root terminal decisions are first-wins and idempotent. Later abort/revoke/shutdown calls cannot rewrite an earlier terminal reason. Broker-installed terminal callbacks synchronously revoke the node capability, which invalidates its descendant chain; sibling capability cells remain independent.

- `abort` cancels a node/subtree or the root due to an execution/lifecycle signal;
- `revoke` invalidates capability authority and can terminate the affected subtree;
- `shutdown` stops admission and force-terminates remaining open nodes;
- `drain` stops admission, lets accepted nodes and eligible resumes settle, and marks the root drained only when open sessions reach zero;
- root deadline is checked deterministically at governor operations and requires no background timer.

The in-memory tree does not survive process failure. This ADR does not claim reconstruction of live sessions or leases after a process crash. Replay is for audit/evaluation, not resurrection.

### D9 - Delegation audit is additive v4 and can be required

Delegation introduces a separate additive audit v4 rather than changing the production dispatch v3 writer in place. Lineage authorization can select `required` mode. In that mode, the authorization row is appended to a private file, the file is forced to `0600`, its directory to `0700`, and the descriptor is synced before the delegation callback runs. An append or sync failure prevents delegation.

Authorization rows explicitly record `execution_mode` as `offline` or `shadow`, audit-safe `request_ref`, `root_lineage_ref`, `lineage_ref`, `parent_lineage_ref`, `node_depth`, selected provider/model/profile/tool names, mutation flag, a safe short `capability_id` (never the handle), `capability_version`, `revocation_generation`, remaining depth, descendant/leaf ceilings, deadline, constraint kinds, and budget before/after. Denials include the same execution mode plus request/root/lineage/parent/depth, reason, and every available safe provider/model/profile selection. Lifecycle rows close accepted nodes with the same execution mode, lineage, and capability short identity. No other execution mode exists in this schema.

In required mode, every broker rejection path attempts a durable denial append. Authorization-write failure still prevents delegation even if the subsequent denial append also fails; no row is claimed as recorded unless its append resolves. Audit failure never replaces the original broker denial. Unsafe caller lineage is replaced with the audit-safe `request_ref` fallback so a privacy rejection does not suppress the denial attempt. Accepted delegation failure writes lifecycle, and the original delegation error remains primary even when that lifecycle append also fails. Later node terminal callbacks enqueue lifecycle without awaiting inside the governor transaction; the writer owns every promise and exposes `flush()`, which aggregates all captured background failures so none becomes an unhandled rejection or is silently discarded.

The closed schema and recursive privacy validator reject raw prompt/task text, secrets/credentials, chain-of-thought/reasoning, runtime handles/non-plain objects, raw session-id fields, and UUID-like substrings in audit-safe references. `reason_code` is a short lowercase machine code and cannot contain prompt/task/reasoning/secret or related semantic-field words. Production v3 retains its existing C6 session anchor; v4 deliberately does not copy raw session identifiers into the delegation lineage file.

### D10 - `bash` is host mutation, not a sandbox

`bash` is treated as host-mutating authority even if a registry descriptor incorrectly labels it read-only. Granting `bash` is not evidence of sandboxing, path confinement, network confinement, or secret isolation. Any future live batch containing `bash`, `edit`, `write`, or another host-mutating tool requires explicit mutation authority and a later capability-batch gate.

### D11 - Every live depth, including depth 1, requires a new independent H5

This ADR accepts the architecture and offline core only. **Any live nested delegation depth greater than or equal to 1, including exactly one delegated edge, requires a new independent H5 decision and evidence package.** That gate must not cite retired ADR 0030 as clearance, must not restore `dispatch_hub`, and must evaluate the actual broker/capability/governor runtime adapter proposed at that time.

Until that H5 is accepted, production nested execution remains fail-closed. The default path retains all five structural denies; a valid shadow context may remove only an explicitly requested and capability-authorized dispatch name while retaining the other dispatch name unless separately requested and always retaining `workflow_run`, `prompt_user`, and `vault_release`.

### D12 - The broker has no LLM and does not rewrite tasks

The broker performs deterministic authority, lineage binding, registry, constraint, budget, audit, revocation, and lifecycle operations. It deliberately performs no provider-lease operation in the first wave. It does not call an LLM, choose a new task, summarize/rephrase the caller's task, select a worker topology, or insert a planner. The caller remains responsible for the task and selected model/profile within its authority.

Nested delegation therefore does not restore the retired hub, either by name or by moving hub behavior behind a “broker” label.

### D13 - Rollout is evidence-ordered

The only accepted rollout order is:

1. **read-only replay** of existing production dispatch audit/settings to prove parser and budget-domain compatibility - implemented and retained as a production read-only smoke;
2. **non-delegating shadow** that computes proposed authorization/governor outcomes but cannot create nested sessions or return capabilities - implemented in the second wave through the real registered dispatch tool entrypoints;
3. **new independent H5** for the exact nested execution adapter and depth - not started and still mandatory;
4. **production depth 1, read-only tools only**, with required authorization audit, kill-switch, abort/revoke/shutdown/drain evidence, and no deeper handle;
5. **capability batches**, each separately reviewed: additional read tools/providers/profiles first, mutation tools later, depth greater than 1 last.

A later stage cannot use success at an earlier stage as blanket authorization. Each batch must define rollback and prove provider/tree lease cleanup under failure.

### D14 - Second-wave shadow is connected without nested execution

The second wave imports one production bridge from `extensions/dispatch/index.ts`. `dispatch_agent` and each `dispatch_parallel` task accept an optional exact `delegation` object whose only mode is `shadow`; every budget and allowed model/tool/profile set is explicit. Without that object, behavior and output remain unchanged. With it, the first-level worker is still created by the existing root dispatch path, but only explicitly requested `dispatch_agent` / `dispatch_parallel` names that also appear in `allowedTools` are removed from preflight and SDK exclusion. `workflow_run`, `prompt_user`, and `vault_release` remain denied at both layers.

Before the first-level session is created, the bridge weakly binds that session's actual `SessionManager` identity to one opaque root capability, one per-worker-root `TreeGovernor`, and one required private shadow audit writer. A delegation object is invalid unless that worker's explicit `tools` request contains at least one capability-authorized dispatch tool, so an unusable delegation cannot allocate a claim, governor, or audit writer. Root references are process-claimed and cleanup is idempotently attached to signal abort, every `runInProcess` exit, explicit disposal, and `session_shutdown`; shadow shutdown and audit-flush failure are best-effort cleanup diagnostics and cannot replace a completed worker result or prevent session lifecycle disposal.

The real registered `dispatch_agent` and `dispatch_parallel` execute entrypoints apply a structural guard independent of tool-registry visibility. They snapshot the context `SessionManager`, check `isSubAgentSession` before and after the shadow binding lookup, and reject a marked sub-agent when the binding is missing, closed, or disappears during evaluation. Missing or invalid execution context is also rejected structurally. Such calls return a structured tool rejection or shadow denial and cannot fall through to root model lookup, `runInProcess`, or session creation. This guard is in addition to SDK `excludeTools`, not a substitute for it.

A binding's broker registry is the exact intersection of the target session's current active tool names and its available descriptors. `getAllTools()` alone is never authorization truth. This preserves descriptors for active dynamic tools and host-mutation classification while ensuring excluded or inactive `workflow_run`, `prompt_user`, and `vault_release` cannot become `would_allow` even if a delegation's `allowedTools` names them. The evaluator returns only `shadow_no_delegate` with `would_allow` or `would_deny`, safe lineage references, a prompt HMAC fingerprint, and non-sensitive remaining budgets. Its delegation adapter can return only a frozen sentinel; it has no session-creation, normal runner, or prompt call path. Authorization is immediately settled as `shadow_no_delegate` and required v4 audit is flushed.

The production v3 dispatch audit, provider concurrency behavior, target-session exact registry validation, and root first-level worker creation remain unchanged. These fail-closed structural and active-registry guards do not open a live gate. No shadow result contains a handle or raw prompt, and no shadow authorization can be used to execute a child.

## Constraints

1. No cryptographic token, cross-process bearer, serialized handle, or LLM-visible authority is introduced.
2. No default budget numbers are embedded in the capability, tree, limiter, broker, or required-audit APIs.
3. Capability attenuation, exact root/holder binding, ancestor-chain revocation, and registry validation are deterministic and fail-closed on malformed values, expiration, revocation, escalation, cross-tree replay, unavailable tools, or unauthorized host mutation.
4. Required write-before-delegate is inside the tree's serialized authorization transaction; reservation lineage sequence is never reused after any later failure.
5. Provider limiter state is process-wide across jiti copies, but tree state remains per root and the first-wave broker owns no provider lease.
6. Accepted runs are not refunded; active/open capacities are released through terminal lifecycle.
7. Governor operation reentry from the required `beforeDelegate` callback async chain is rejected deterministically; external delegation/terminal async resources and unrelated concurrency remain serialized normally.
8. Fair resume must not let an ineligible head block all eligible waiters.
9. Audit files contain no prompt, secret, CoT, handle, binding record, or raw session identity.
10. Dynamic branch accounting is process-local and non-recoverable after process crash; no claim is made that `bash` is sandboxed or that trees recover after process failure.
11. The production shadow import authorizes evaluation only. No nested delegation, hub/planner restoration, task rewrite, alternate execution mode, or removal of the three permanent structural denies is authorized by this ADR.
12. A marked sub-agent without a live binding fails closed at both dispatch execute entrypoints, and shadow registry authority is limited to the active-name/descriptor intersection; neither invariant changes D11's independent live gate.

## Verification

The offline acceptance suite must cover at least:

- forged/copy-shaped handles are rejected; attenuation succeeds only downward; every upgrade dimension is rejected;
- cross-governor replay and wrong-holder use are rejected; per-node revoke/terminal invalidates descendants while a sibling remains usable;
- root-generation revocation invalidates descendants and renewal creates a fresh identity;
- real pi SDK target registry data accepts a dynamically registered ordinary tool and rejects unavailable tools;
- two concurrent authorizations cannot oversell; failed pre-delegation reservations permanently consume lineage sequence; accepted delegation failure is not refunded;
- required audit success followed by abort produces authorization plus denial closure on one lineage, and the next request uses a different lineage;
- active executions and open sessions are independent; waiting parents retain open capacity; FIFO eligible resume makes progress without starvation;
- required `beforeDelegate` callback-chain reentry rejects without wedging the governor, while immediate/promise continuations created by external delegation and terminal adapters can queue later governor operations;
- node, subtree, root, deadline, abort, revoke, shutdown, and drain transitions are first-wins/idempotent;
- provider limiter queues are shared across independent jiti copies, FIFO, abort-aware, zero-limit rejecting, and leak-free;
- broker delegation holds no provider lease, so a separate real request can acquire a configured provider limit of one;
- v4 authorization is synced before callback execution; all denial classes and lifecycle closure are writable; file/directory permissions are private; privacy rejection covers all forbidden data classes;
- typed constraints fail closed without a broker enforcer;
- source assertions scan the complete `extensions/` dependency surface and allow the delegation core in production only through `dispatch/index.ts -> delegation-shadow-bridge`; the bridge contains no session-creation, normal runner, or prompt-call path, and default five-deny enforcement remains at preflight plus SDK exclusion;
- a real SDK `createAgentSession` smoke obtains the actual registered `dispatch_agent` and `dispatch_parallel` tool definitions and calls their execute functions with a real bound `SessionManager`; both return `shadow_no_delegate`, do not increase the session-start baseline, and never touch a normal-runner sentinel;
- the same real execute references fail closed for a marked SessionManager with no binding and after binding shutdown, without touching the model registry or runner; missing context and an evaluation-time binding loss produce structured rejection/denial rather than a thrown error;
- active registry tests prove `getAllTools()` descriptors excluded from `getActiveToolNames()` cannot authorize `workflow_run`, `prompt_user`, or `vault_release`, while an ordinary active dynamic/mutating descriptor remains available;
- injected shadow audit-flush failure proves shutdown starts once, cached disposal resolves, `session_shutdown` and session disposal each run once, a successful worker result is preserved, and diagnostics expose no prompt or secret;
- shadow deny coverage includes malformed schema, delegation without an explicitly requested dispatch tool, unauthorized dispatch exposure, model/profile/tool registry/mutation mismatch, depth/run/leaf/tree budgets, expiration, revoke, abort, sibling oversell, cleanup, root-claim reuse, and cross-jiti binding visibility;
- read-only replay parses real production dispatch v3 JSONL and real repo settings, validates existing object/aggregate governor budget shapes, and emits only counts/compatibility evidence outside the repo.

The TypeScript check must include the new modules directly. If the repository-wide check has pre-existing diagnostics, before/after output must prove that the new files add none.

## Consequences

The architecture can now describe bounded delegation without granting it. This is intentionally more machinery than recursively exposing `dispatch_agent`: amplification requires explicit authority, two levels of concurrency ownership, lifecycle closure, and durable pre-delegation evidence.

The cost is process-local complexity and strict staging. Object identity does not protect against malicious trusted extensions in the same process. Descendant-run and active-leaf budgets now account actual branch state, but provider-request lease integration still does not exist. A future nested execution adapter must prove exact provider-request acquisition/release and real child-session lifecycle behavior under a separate gate. Those are accepted boundaries, not hidden guarantees.

The old absolute prohibition is no longer the long-term design truth, but the prohibition on nested execution remains the runtime truth until D11's gate. “Superseded principle” must not be read as “enabled nested execution”; shadow computes and audits a decision without carrying it out.

## Backlog / Rollout

The second-wave shadow closes the first two former blockers: each worker root has a process claim plus one weakly bound capability/registry/governor owner, and descendant-run/active-leaf accounting is dynamic and transactionally composed with `TreeGovernor`. Shadow is non-delegating, so it neither makes nor simulates provider requests.

The remaining runtime blocker is a real SDK provider-request adapter that acquires/releases `ProcessProviderLimiter` leases around each actual request, never around broker authorization or session lifetime. The current SDK offers no exact request hook suitable for this ownership contract, so this wave deliberately leaves the limiter disconnected from the broker and shadow evaluator. That adapter, real child-session lifecycle evidence, kill-switch behavior, and a new independent H5 remain mandatory before any nested execution gate.

The following follow-up walk-backs are required only in a later authorized documentation/ingest batch; they are deliberately not changed by this first wave:

- `docs/adr/0009-multi-agent-as-base-capability.md`: replace “nested dispatch forever denied” with “runtime denied until ADR 0042 staged H5.”
- `docs/reference/commands.md`: keep current behavior text, but stop presenting it as an unconditional future architecture law once a live gate is accepted.
- `docs/notes/adr0034-ingest/0009.json`: supersede `nested-dispatch-is-never-delegated` rather than editing historical evidence in place.
- `~/.abrain/projects/pi-global/nested-dispatch-is-never-delegated.md` and its L1/L2 projections: update only through the canonical evidence/projector path, never by direct file edit.
- `docs/adr/0027-coupled-stigmergic-dual-loop-agent-system.md`: point future nested-depth H5 language to a new independent gate and retain ADR 0030 as retired history only.
- `docs/current-state.md` and `docs/reference/commands.md`: update only when a production behavior actually ships.
- `docs/roadmap.md`: add shadow/H5/live batches in a separate backlog change; this first wave must not touch the user-owned file.

Historical audits and retired ADR 0030 remain immutable evidence. They are not rewritten to simulate prior agreement with this decision.
