---
doc_type: adr
status: accepted
date: 2026-07-25
---

# ADR 0045 — Sediment worker-safe RPC command（Stage A 机制）

- **Status**: Accepted（Stage A daemon-owned short-lived worker RPC migration surface）
- **Date**: 2026-07-25
- **Relates-to**: [ADR 0044](./0044-central-sediment-edge-authority.md)（**目标** authority/edge contract；本 ADR 是 Stage A 机制，不是并列 primary）, [ADR 0024](./0024-second-brain-from-natural-conversation.md), [ADR 0027](./0027-coupled-stigmergic-dual-loop-agent-system.md) C6, edge-protocol-shadow capture-only slice（`extensions/sediment/edge-protocol-shadow.ts`）, pi-router central-memory Stage A bridge plan
- **Implementation**: `extensions/sediment/worker-rpc.ts` + worker-mode branch in `extensions/sediment/index.ts` + `sediment.executionOwner`
- **Hierarchy**: A0 完成前 local sediment intake/queue/publication 仍是唯一 semantic primary；本 ADR 的 worker RPC 与 continuous edge producer **不得**升为第二 primary。capture-only protocol shadow 见 ADR 0044。

## 1. Context

Central sediment edge authority migrates semantic evaluation off the interactive Pi process. Pi / pi-astack already has capture-only protocol shadow（raw sidecar + terminal witness journal）. Stage A in pi-router spawns a headless TS sediment worker under the daemon. This ADR freezes the **pi-astack Stage0 worker command** that daemon can call over `pi --mode rpc` without taking ordinary foreground agent lifecycle.

## 2. Decision

### 2.1 Single-executor ownership (`sediment.executionOwner`)

Default **`foreground`** — ordinary Pi extension owns enqueue + recovery + normal sediment pass/timer. **Zero behavior change** for existing installs.

**Configured `daemon`** uses an **effective owner** fail-safe (never orphan ordinary intake, never dual semantic primary, never bypass triple gate):

- **Full triple gate** (`executionOwner=daemon` **and** `edgeProtocolShadow.enabled` **and** `daemonWorker.edgeShadowCaptureEnabled`): effective owner = **daemon**. Ordinary Pi extension does **not** write ordinary intake / enqueue / recovery / normal pass; `agent_end` captures healthy terminals into edge shadow only. Headless worker (`PI_ASTACK_SEDIMENT_WORKER_MODE=1`) is the sole pass executor.
- **Incomplete triple gate**: effective owner **degrades to foreground** for the whole process so local intake still has a consumer (enqueue/recovery/pass). Audit/diagnostic `daemon_effective_owner_foreground`. **No** force edge capture without full triple gate; **no** durable intake without consumer.
- Worker start still **requires** configured `executionOwner=daemon` else returns `execution_owner_not_daemon` (prevents dual-executor races when properly gated).

### 2.1b Continuous edge-protocol-shadow producer (`sediment.daemonWorker.edgeShadowCaptureEnabled`)

Default **`false`**. Triple gate — all required: `executionOwner=daemon` **and** `edgeProtocolShadow.enabled=true` **and** `daemonWorker.edgeShadowCaptureEnabled=true`. Ordinary foreground Pi then writes each **healthy** terminal assistant turn into the existing flat `edge-protocol-shadow` authoritative source:

- Pair API `captureEdgeProtocolTerminalPair` (source + candidate + terminal_witness under one journal OFD lock). Public `writeEdgeTerminalWitness` default append semantics unchanged; pair/recovery use explicit pin + idempotent opts
- Hard size contract: exact raw sidecar bytes and journal record JSON each ≤ **8 MiB** (`EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES` = pi-router `MAX_READ_BYTES`). Oversize → stable skip/fail code, **no** candidate left
- Atomic publish temps live under per-session `staging/` (same FS, scanner does **not** enumerate). Never leave `.tmp` under `journal/records/` (daemon whole-round fail)
- Owner root = `resolveDaemonEdgeOwnerRoot(cwd, abrain)` physical bind/git root → realpath (unique `owner_key`). Never worktree extension path. Realpath double-fail is **fail closed** (throw / skip capture+recovery aggregate) — never return non-realpath raw
- Session id is SessionManager authority; C6 keeps real number/string types; leaf tip from real `getLeafEntry` (never synthesized)
- Healthy terminal: real last assistant with `stopReason` in accepted set (`stop`/`length`). Empty / no assistant / `toolUse` / error / aborted / untrusted → skip
- Concurrent same (session,terminal_leaf,content) under OFD lock → one candidate + one witness. Same terminal leaf different content → fail closed `terminal_identity_content_conflict`. Different leaves with same C6 admit independently and record `c6_collision` diagnostic (C6 is attribution only, not unique admission). Unreferenced sources are operator-only recovery (`recover:edge-unreferenced-sources`, dry-run default; execute requires capture-audit + identity proof; never auto on session_start; never synthesizes C6/leaf)
- Sidecar always create/verify content-addressed; missing restored; corrupt collision fail closed; never witness → missing sidecar
- Candidate-only partial failure: owner-wide bounded `session_start` recovery fills witnesses only
- Full triple gate → edge capture only; daemon owner **never** writes ordinary intake under effective daemon ownership (no unbounded `pending/` orphans). Incomplete triple gate → effective owner degrades to foreground (intake→queue with consumer); never bypass triple gate for edge. Capture receipt is **not** ConsumerAck / knowledge ack / formal authority / retention / delete
- `agent_end` awaits local fsync only (no LLM). Worker mode never producer-captures
- Production is settings-JSON only. Env `PI_ASTACK_DAEMON_WORKER_EDGE_SHADOW_CAPTURE` requires `PI_ASTACK_ENABLE_TEST_HOOKS=1`

### 2.2 Worker mode env

`PI_ASTACK_SEDIMENT_WORKER_MODE=1` puts the sediment extension into worker-only registration:

- Registers **only** worker commands: `/sediment-worker-run` + `/sediment-worker-maintenance` (health capability = commands registered; no free-text expansion)
- Installs the **same** `runSedimentAgentEndPass` implementation used by ordinary `agent_end` / intake recovery（no duplicated writer）
- **Does not** register or run: `session_start` / `before_agent_start` / `agent_start` / `agent_end` / `agent_settled` / `session_shutdown` ordinary sediment hooks
- **Does not** start ordinary detached queue, intake recovery, timers, or footer
- **Does not** enable recursive edge-protocol-shadow capture from the worker session

Worker-required env (ordinary mode never requires these):

| env | notes |
|---|---|
| `PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT` | canonical realpath existing dir; sidecar must live under it |
| `PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS` | JSON array of realpath owner project roots (exact allowlist) |

### 2.3 Command semantics

- Command name: `sediment-worker-run`（stable; Pi extension command naming）
- Invoked via RPC `prompt` with `/sediment-worker-run <manifest>`
- Pi extension commands execute the handler **without** starting an agent turn（handler does not call `sendMessage` / LLM）
- **Result notify must be available before execution**; missing `ctx.ui.notify` ⇒ no pipeline run
- RPC `response.success` only means the command was accepted/handled — **not** business success
- Business result is an aggregate JSON notify: prefix `sediment-worker-result:` + `pi-astack/sediment-worker-result/v1`
- All exceptions become structured results (preserve `request_id` / `terminal_record_id` when manifest parses). Manifest parse failures may only correlate via RPC command response — never fake business settled.

### 2.4 Task manifest

Schema `pi-astack/sediment-worker-task/v1`. Args: single-line JSON or base64url(JSON), **≤64KiB**. Stage0 admits **only** `task_kind=terminal_witness`.

**Strict unknown-field reject** at top / `c6` / `leaf_tip` / `candidate_ref`.

Required fields:

| field | notes |
|---|---|
| `request_id` | 64 hex; daemon correlation |
| `terminal_record_id` | 64 hex; **idempotency key**（terminal witness record id） |
| `session_id` | source session（not worker session） |
| `owner_project_root` | absolute; realpath must exist and be in allowed owner roots |
| `owner_key` | **required**; must equal `sha256(abs realpath owner root)` |
| `sidecar_path` | absolute; shape `<copy_store_root>/records/<terminal_record_id>/sidecar.bin` |
| `content_id` | **required** 64 hex; must match envelope + messages digest |
| `c6` | causal identity; `c6.session_id` must match `session_id`; `turn_id`/`subturn` only safe integers (number or lossless numeric string) — non-numeric ⇒ `unsupported_integer`, never silent 0 |
| `leaf_tip` | optional tip pin for type/timestamp only |
| `candidate_ref` | optional; when present all of `record_id`/`producer_seq`/`payload_digest`/`run_generation` required; `payload_digest` must equal `content_id` |
| `budget_ms` | optional wall budget ms; absent → 600_000; closed range 60_000..3_600_000 (see §2.6b) |

**Forbidden**: raw transcript on argv beyond path reference; logging/stdout of raw body, paths in result, session/content/digest in result.

### 2.5 Sidecar verification

Handler opens sidecar via **open file handle + fstat** with `O_NOFOLLOW` when available (not lstat-then-readFile):

- reject symlink; require regular file; cap 8MiB
- verify `edge-source/v1`, `session_id`, exact `messages` RawValue sha256 = `content_id`
- Same-permission TOCTOU bound is honest Stage0

### 2.6 Pipeline reuse + independent checkpoint slot

Messages convert to synthetic branch entries with **content-stable entry IDs** (leaf_tip does **not** rename prior tips when cumulative sidecars grow). Fed into the existing agent_end pass against **owner_project_root** + source session provenance (C6/anchor).

Checkpoint IO uses an independent slot `daemon-worker:<sha256(source session)>` via snapshot `checkpointSessionId` so worker evaluation does **not** share the foreground source-session watermark.

### 2.6b Task budget / progress / cancel (2026-07-26)

End-to-end worker self-budget — **does not** change foreground `agent_end` pass defaults. Only `/sediment-worker-run` injects worker runtime opts into the shared pass body. Scheduler/redrive remain pi-router owned.

**Deploy order (hard constraint)**

- Old workers do **not** understand `budget_ms` / progress / `restart_child` / poison — that is a **deployment constraint**, not a runtime fallback.
- **Publish worker extension first**, then daemon/router that emits budget fields and acts on `restart_child` / poison codes.
- Never roll a budget-aware daemon against an old worker process and claim healthy reuse.

**`budget_ms` (task contract)**

- Optional for old daemons: absent → **600_000 ms** default
- Closed range **60_000 .. 3_600_000** (validate reject outside)
- Budget clock `startedAt` is the **handler entry** (covers validate / receipt / claim / pass)
- Worker creates absolute soft deadline = start + budget − **5_000 ms** return reserve + `AbortController`
- Worker **must** return a structured result within budget; does **not** rely on daemon kill
- Soft deadline is a hard work fence: progress is observational only and **does not extend** the deadline
- Fence poll slice ≤ **1_000 ms** (test-injectable)

**Progress notify** schema `pi-astack/sediment-worker-progress/v1` via `ctx.ui.notify` (prefix `sediment-worker-progress:`):

- Closed `stage` set **actually emitted**: claim / sidecar / checkpoint / pass / search / classifier / detached_join / receipt / publication / auto_write_preflight / auto_write_extractor / auto_write_curator / auto_write_writer / auto_write_embedding / auto_write_publication
- Closed `phase`: start / end / heartbeat / aborted
- Optional low-cardinality `elapsed_bucket` / `pending_bucket` (closed bucket values only) / closed `lanes`
- **No** identity, path, session, digest, content, or free text
- Notify failure **never** fails the task

**Pass runtime opts** (worker-only): `{ signal, requestAbort, deadlineMs, onProgress, now? }`. Existing callers that omit opts keep original behavior. Signal is threaded into memory search / correction / extractor / curator / multiview / embedding paths that already accept `AbortSignal`. `requestAbort` aborts the worker controller (detached-join abort-first). Worker runtime clamps model/embedding/git-singleflight timeouts to remaining budget (reuses `gitSingleFlightWithDeadline` via worker-budget ALS); **does not** change global settings defaults (e.g. 1200s).

**Checkpoint slot (ALS)**: worker pass runs under `AsyncLocalStorage` override `daemon-worker:<sha256(source session)>`. Detached promises inherit the store; nested/concurrent contexts do not clobber. Foreground never enters the store → provenance sessionId. Module-global save/restore is deleted.

**Global serial**: `withGlobalPassSerial` wait is deadline/abort bound. **Signal-only** waits are event-driven (prev settle OR abort) with **no poll timer**. When a deadline is present, a single timer/race fence (slice ≤1s) is used (no per-slice handler append). Prior task rejection does not poison the *tail chain*, but a hung previous pass is **not** actively released. Timeout → `global_serial_deadline` + **process poison** + `restart_child=true`. Under single-worker single-inflight this fences the previous pass; do **not** claim healthy process reuse.

**Process poison (closed set)**: only these codes poison the process **and** set `restart_child=true`:

- `global_serial_deadline`
- `cancel_cleanup_unreaped`
- `pass_deadline_exceeded_unreaped`
- `deadline_after_checkpoint_advanced`
- `worker_process_poisoned`

All `WorkerDeadlineError` catch sites call the unique `poisonIfSerialOrUnreaped(code)` closed set. Plain settled `worker_budget_exhausted` / `stage_deadline` / `detached_join_deadline` (cleanup already settled **and** CP not advanced) **must not** poison and return `restart_child=false`. Subsequent `/sediment-worker-run` on a poisoned process returns `worker_process_poisoned` (`restart_child=true`) **immediately** — no claim, no pass (in-process depth defense).

**OFD claim + daemon restart contract**: OFD claim is **always** released on RPC return (finally) — no fd leak. After claim release, when the result has `restart_child=true` (poison closed set), the daemon **must kill-and-wait** the Pi child **before** any ledger retry / redrive. Released claim alone must never allow the same poisoned process to accept work; extension process poison is the depth defense that refuses same-process tasks.

**Deadline fence lifecycle**: soft-deadline fence is AbortSignal/deferred-stop cancelable. After `workPromise` settles the handler **must** cancel and await fence cleanup — no permanent pending async frame on the success path. Fence poll slice ≤1s (test-injectable).

**Detached join**: worker mode accepts deadline+signal+progress; heartbeat timer independent every **5s** or when pending/lane set changes; **attach `allSettled` once per pending-set identity** and rebuild only when the set changes (no per-50ms handlers). On deadline/abort: **abort first**, then bounded cleanup **≤5s** checking tracked pending. pending==0 → `detached_join_deadline` (settled + CP not advanced → no poison, `restart_child=false`). pending>0 → `cancel_cleanup_unreaped` (poison + `restart_child=true`). Outer must **not** misclassify background pending as settled. Foreground without opts keeps original infinite wait.

**Task-scoped runtime (`taskScoped=true`)**: worker pass opts imply task scope over the **current verified sidecar/run window only**. Branch entries are synthetic from verified sidecar messages; `getBranch` never expands to foreign session backlog. Global maintenance fire-and-forget is **skipped** (no causal dependency on the current record):

- aggregator
- staging-resolver
- staging-ageout
- staging-promotion
- archive-reactivation
- independent forgetting
- independent multiview-replay

Foreground (no worker opts) keeps original schedules unchanged. Docs describe this as **task-scoped** — **never** claim that global maintenance completed for a worker task. If a future lane is required for current-candidate correctness it must be `trackSessionPassWork` + closed lane + signal/deadline (no untracked fire-and-forget).

**Current-candidate unfinished artifacts (fail closed)**: when the **current** task-scoped candidate produces multiview pending / staging deferred / promotion-needed unfinished artifacts, the worker **must** return exact `current_candidate_deferred` (`retryable=true`, no poison) — **no CP advance, no success receipt, not processed**. Detection uses **only this run's internal outcome keys** (e.g. `multiview_staged_for_replay`, curator `multi_view.staged`, this-run `stagingWritten`) — **never a global staging/multiview directory scan**. Mark/consume is **attempt-local** (`AsyncLocalStorage` per agent-end pass) — **not** a process sticky session map; exception / deadline / next terminal / independent worker task for the same session must not inherit the flag. On deferred, **stop this-task recursive candidate/drain immediately** so later outcomes cannot advance CP; future independent worker tasks still drain normally. Global resolver/replay remain skipped in Stage0. **Candidate-scoped resolver/replay is a future slice**; until then unfinished current-candidate artifacts fail closed as `current_candidate_deferred`.

**Retryable return invariant (receipt + CP re-read)**: before returning any retryable `current_candidate_deferred` / `no_progress` / deadline-class result, worker **must** re-read the create-only processed receipt and durable CP. Valid receipt → settled success. If **this attempt** advanced CP or CP already covers tip **without** receipt → immediate fatal `deadline_after_checkpoint_advanced` (poison; do not wait for redrive). Normal deferred **requires** CP not advanced this attempt.

**auto_write progress**: worker `onProgress` emits closed stages auto_write_preflight / extractor / curator / writer / embedding / publication with start/end/aborted (no identity). **Per candidate** emits curator start/end (no index/count). Candidate loop **asserts remaining budget at loop top before constructing any candidate work**; expired → ordinary `stage_deadline` (do not start new work). Each candidate start dynamically re-clamps settings timeouts to remaining budget; worker mode forces `curatorMaxRetries=0` / `aggregatorMaxRetries=0` (multi-view already 0). Memory search stage timeouts clamp via worker-budget ALS. Main awaits receive signal + remaining deadline; callees without signal use worker budget race with `unreapedIfTimeout` + track (including `curateProjectDraft` / writer / embedding / publication). Writer abort-checks worker budget **before** critical IO/git only (`writer_before`); **no `writer_after`** — successful writes are retained and never flipped to failure by a post-success budget check. After writer, bgPromise tail (`auditDirectiveRecall` / checkpoint) is raced into the same budget fence — **no black zone**; checkpoint lands only after main-chain success (`shouldAdvance`).

**`stage_deadline`**: produced by index stage precheck (`assertWorkerStageBudget` on pass/classifier/search, candidate-loop top, plus embedding/writer_before budget gate). Kept in the deadline closed set; settled + CP not advanced → no poison, `restart_child=false`.

**Deadline / poison result fields** (backward compatible; old daemons ignore unknown codes):

| `error_code` | meaning | retryable | restart_child |
|---|---|---|---|
| `worker_budget_exhausted` | soft budget elapsed (settled path, CP not advanced) | true | **false** (no poison) |
| `stage_deadline` | stage pre-check past budget (settled, CP not advanced) | true | **false** (no poison) |
| `detached_join_deadline` | detached join past budget (settled, CP not advanced) | true | **false** (no poison) |
| `global_serial_deadline` | waited on process serial past budget; fences prev pass | true | true (poison) |
| `cancel_cleanup_unreaped` | cancel cleanup could not reap | true | true (poison) |
| `pass_deadline_exceeded_unreaped` | abort + ≤5s cleanup still not settled | true | true (poison) |
| `deadline_after_checkpoint_advanced` | durable CP **covers sidecar tip** but **no** success receipt — fail closed, human diagnosis; not auto no_progress / already_processed | **false** | true (poison) |
| `worker_process_poisoned` | process already poisoned; refused claim/pass | true | true (poison) |
| `current_candidate_deferred` | task-scoped current candidate left unfinished artifact (multiview pending / staging deferred / promotion-needed); this-run keys only; **CP must not have advanced this attempt** | true | **false** (no poison) |
| `receipt_write_failed` | create-only receipt write failed/timed out under hard reserve after more=false main-chain success (**CP already advanced**) | **false** | **true** (restart_child; first cause preserved; optional atomic-write retry inside hard reserve only) |

**Checkpoint / receipt deadline rules**:
- On **every** deadline/abort/unreaped outcome path, first re-read the create-only **processed receipt**. If a valid receipt is durable → return settled `processed` / `already_processed` (**never** `deadline_after_checkpoint_advanced` / `pass_deadline_exceeded_unreaped` poison).
- After success receipt, worker task does **not** drain knowledge publication in-task (no uncancelled `Promise.race`). Result/audit stamps `publication_pending` from the production metadata-only existence probe (read failure fail-closes true); durable outbox + independent maintenance own publication.
- On deadline/abort capture without receipt, re-read CP. **Only** when durable CP **covers tip** and no success receipt → `deadline_after_checkpoint_advanced` (retryable=false, poison).
- **Partial** before→after CP advance (more-loop intermediate watermark, tip not covered) is **safe resume**: ordinary retryable deadline (`worker_budget_exhausted` / `stage_deadline` / …), **no poison**.
- Entry path: if durable CP already covers current sidecar tip but receipt is absent → same closed `deadline_after_checkpoint_advanced` (only a valid success receipt may return `already_processed`).
- After `more=false` and main chain really advanced: even if **soft** deadline has elapsed, use the reserved **hard** deadline (≤5s cleanup reserve) to attempt create-only receipt (`verifyCreated=true`) — **do not soft-fence before receipt write**. Success → `processed` + `publication_pending`; failure/timeout after CP advanced → `receipt_write_failed` (**nonretryable**, `restart_child=true`, first cause preserved; may retry the atomic write once inside the hard reserve — no complex state machine). Corrupt receipt / collision without valid re-read → `receipt_corrupt_or_collision` fail-closed, **no** force-retry path.
- more-loop re-checks remaining budget each iteration (cannot open 16 full budgets).
- **Canonical ownership**: process-level startup attempt is created/retried in `runOutsideWorkerBudget` (outside task ALS; full busy budget; not bound to short task deadline). RPC tasks never wait 60m — if process-level startup is not already ready, return cooperative deferred (`STARTUP_BUDGET_EXHAUSTED`) immediately (retryable/held, no poison). Each external task best-effort kicks the next generation; bootstrap continues for worker process lifetime. Worker shutdown/restart drops in-memory attempt; a new process re-bootstraps. Does **not** hard-kill in-flight mutation. CE/writer share the process runtime singleton.

**`no_progress` classification (M4)**:
- Pass may return `{ no_progress: true, code, retryable? }` for explicit skips.
- **Deterministic non-retryable** closed codes: `project_not_bound`, `settings_disabled`, `empty_window`, `ephemeral_session` (`retryable=false`, no receipt, no poison) — **only when this task never advanced CP** (`!anyAdvanced`). Daemon attempt policy: do **not** auto-redrive these; surface for operator/config fix.
- If the task **already advanced** CP (e.g. more-loop advance then `empty_window`), worker **must** write processed receipt / settle normally — never lose progress on redrive.
- Unclassified void / soft no-progress remains `no_progress` with `retryable=true` (transient) when `!anyAdvanced`.
- Process poison reason is sticky (first root cause wins; subsequent `worker_process_poisoned` refuses do not overwrite).

**Honest Stage0 bounds**

- Worker budget should be **strictly less than** daemon/RPC child timeout so the worker returns first
- Daemon kill remains the unreaped fence; after `restart_child=true`, daemon **must kill-and-wait** then redrive — never healthy-reuse the process
- Stage0 local success receipt is **not** formal ConsumerAck / authority / retention

### 2.7 Success condition / more loop / receipts

**Create-only success receipt** only when:

1. pipeline **really advanced** durable checkpoint (`lastProcessedEntryId` change), AND
2. backlog exhausted (`more=false`)

`more=true` continues **inside the worker** (hard budget 16). Budget exhaust ⇒ retryable non-final, **no** success receipt.

Soft skip / void return ⇒ `status=failed`, `settled=false`, `retryable=true`, **no** success receipt. Void is never treated as processed.
Deterministic skips (`project_not_bound` / `settings_disabled` / `empty_window` / `ephemeral_session`) ⇒ `status=failed`, `settled=false`, **`retryable=false`**, **no** success receipt (see M4 classification above).

Receipt schema `pi-astack/sediment-worker-receipt/v1` under:

`ABRAIN_ROOT/.state/sediment/worker/receipts/<terminal_record_id>.json`

- Receipt **only** means processed settled success
- **No durable failed receipts** (transient failure must not block later success)
- Corrupt receipt / collision without valid processed re-read ⇒ `receipt_corrupt_or_collision`, fail closed, never return processed
- Crash before success receipt ⇒ retryable

Statuses: `processed` | `already_processed` | `busy` | `failed`.  
`settled=true` **only** for `processed` / `already_processed`. Others carry `retryable` (claim/pipeline/write errors ⇒ `settled=false`).

Cross-process claim via Linux **OFD** lock under `.../worker/claims/<terminal_record_id>/` (Stage0 **Linux-only**). **All passes in one worker process are globally serial** (even across terminal ids); per-id OFD claim retained.

**Not** `pi.memory.v1` ConsumerAck / formal durable ACK / retention watermark.  
Receipts and claims have **no GC** (known Stage0 bound).

### 2.8 Knowledge publication after worker success

On settled processed / already_processed success the worker writes create-only receipt (when applicable) and stamps `publication_pending` from the production outbox **existence/metadata-only** `hasPending`/count API. It does not deserialize every pending item. Empty outbox → `false`; any durable pending filename → `true`. Probe failure **fail-closes to `true`** (never fake empty). Worker task does **not** drain publication outbox in-task. Durable outbox + independent maintenance own publication. Worker cannot wait for foreground `session_start`.

### 2.8b Publication outbox maintenance command (daemon idle owner)

Command `/sediment-worker-maintenance` — local publication-outbox maintenance under the **daemon idle owner**. **Not** formal ConsumerAck / authority / retention / delete.

**Deploy order (hard constraint)**: publish worker extension first (understands maintenance command + `publication_pending` actual bool), then daemon/router that invokes it. Never claim healthy reuse of an old worker process that lacks the command.

**Request** schema `pi-astack/sediment-worker-maintenance/v1` (JSON or base64url, ≤64KiB; strict unknown-field reject):

| field | notes |
|---|---|
| `request_id` | 64 hex; daemon correlation only |
| `budget_ms` | required; closed range **60_000 .. 900_000** |
| `kind` | Stage0 admits **only** `publication_outbox` |
| `repair_policy` | optional closed `none\|legacy_world_project_stamp`; absent defaults to `none` |
| `repair_limit` | optional integer `0\|1`; absent defaults to `0`; non-`none` policy requires exactly `1`; `none` with `1` is invalid |

**Forbidden identity**: no project / record / session / path / item id on the request. Settings + `ABRAIN_ROOT` follow worker mode. Normal daemon calls omit repair fields and therefore perform zero repair.

**Gate**: effective owner must be **daemon** (configured `executionOwner=daemon` **and** full triple gate). Incomplete gate / foreground → closed `effective_owner_not_daemon` (`retryable=false`, **no writes**). Although the request has no record identity, maintenance validates the same worker copy-store env and non-empty realpath owner allowlist as task RPC before reading or writing the outbox. Any security-env/config failure is zero-write.

**Serialization**: the complete gate/count/drain body enters the same process-wide `withGlobalPassSerial` as terminal tasks, so publication maintenance cannot overlap a task pass. Serial wait is bounded by the maintenance soft deadline. Timeout while waiting means this invocation never entered its drain body: return retryable `pending` + `maintenance_worker_busy`, `restart_child=false`, before/after `unknown`; do not poison, restart, or kill the healthy serial owner. Task-run `global_serial_deadline` semantics are unchanged.

**Body**: directly awaits production `drainKnowledgePublicationOutbox`, which returns the real `PublicationOutboxDrainResult`; it does not discard `status`, `processed`, `terminalFailed`, or `lastError`. The direct path performs a one-shot nonblocking canonical OFD probe **before** scheduling/reading a batch. Contention returns real `status=busy` immediately, without retrying against or consuming the maintenance budget. After acquisition, every candidate Knowledge item must resolve and validate its exact L1 event before selection. Missing L1 is held/not-ready (same pending item/event identity); other independent ready groups still drain, and the result closes with `lastError=publication_l1_pending`, `pending>0`, `terminalFailed=0`. After selection it checks worker `AbortSignal`/remaining budget at frozen-batch cutpoints and retains the existing fixed git subprocess timeouts. The foreground one-shot remains unchanged: canonical contention is represented as `completed` with retryable `lastError`. The outer worker fence remains authoritative for a drain started by this invocation that cannot be reaped. **Does not** run agent-end / other maintenance lanes; **does not** touch checkpoint / receipt / ledger / source.

**Before/after pending + failed residual**: production metadata-only counts. Pending count does not deserialize item bodies. Failed residual count validates legal item filename + schema/identity and **fail-closes** on symlink/corrupt/illegal entries (throw → unread). Closed buckets for both: `unknown` / `0` / `1` / `2-4` / `5-9` / `10-49` / `50+`. Owner/security/poison failures and any count that was not successfully read are `unknown`, never invented `0`. Optional result field `failed_bucket` is forward-compatible (old readers ignore; absent still accepted).

**Durable `failed/` is critical residual**: maintenance does not generally requeue or delete failed items. One narrow, explicit operator repair exists for the historical world-scope stamp defect. `repair_policy=legacy_world_project_stamp` plus `repair_limit=1` scans legal failed entries under the canonical barrier and accepts at most one only when the canonical Knowledge L1 exists and validates, L1 scope is world with no `project_id`, the failed item has exact legacy `projectId=pi-global`, and domain/event/slug/operation/session/source/candidate identity otherwise matches.

The legacy item follows a durable two-stage path. Stage 1 creates or recognizes the deterministic normalized omit-`projectId` item in `pending/<newId>.json`, while the old failed bytes remain in place. Stage 2 atomically renames the old bytes from `failed/<oldId>.json` to same-root immutable `resolved/<oldId>.json`; ordinary drain later moves normalized pending to `done/<newId>.json`. Crash after Stage 1 resumes the identical pending item; crash after Stage 2 reports `already_repaired`. No state is deleted. Historical audit recovery traverses every legal resolved row in one invocation, derives `(oldId,newId)` only from the immutable resolved old item, and appends every missing pair once; it neither re-reads L1 nor requires normalized pending/done to remain. Audit recovery is bookkeeping, not a repair mutation, and is not limited by `repair_limit=1`.

Canonical-barrier contention and repair budget expiry return retryable pending with closed `publication_repair_busy` / `publication_repair_budget`; they do not create a sticky terminal result. Identity, destination conflict, and I/O failures return closed `publication_repair_failed`, append durable `operation=repair_failed` audit with closed `reason=identity|conflict|io` and no content/path, and emit only a closed stderr code if audit append itself fails. This operator path is **not** formal ConsumerAck, source ACK, retention, delete, quarantine, generic requeue, or bulk repair. The limit is structurally one. Task result `publication_pending` remains pending-only and must not mix failed residual.

**Status/result mapping** (closed, in precedence order):

| condition | status | retryable | `error_code` |
|---|---|---|---|
| pending_before = 0 **and** failed residual = 0 | `idle` | false | absent |
| pending_before = 0 **and** failed residual > 0 | `failed` | false | `publication_terminal_failed_present` |
| `terminalFailed > 0` this round (even when pending_after = 0) | `failed` | false | `publication_terminal_failed` |
| failed residual after > 0 (historical or remaining; regardless of pending) | `failed` | false | `publication_terminal_failed_present` |
| production drain `status=busy` | `pending` | true | `publication_drain_busy` |
| production `lastError=publication_l1_pending` | `pending` | true | `publication_l1_pending` |
| other production `lastError` or drain throw | `failed` | true | `publication_drain_failed` |
| after pending-count read fails | `failed` | true | `publication_outbox_count_failed` |
| after failed-count read fails | `failed` | true | `publication_outbox_failed_count_failed` |
| pending_after > 0 without the errors above | `pending` | true | `publication_remaining` |
| pending drained and failed residual = 0 without failed/error | `drained` | false | absent |

Soft budget expiry before drain leaves pending_before known and pending_after `unknown` (failed_bucket keeps the successfully read before residual when available). Cleanup unreaped after this invocation started a drain → `cancel_cleanup_unreaped` + poison + `restart_child=true`; `workPromise` always has a rejection observer even when cleanup reserve is zero, preventing late unhandled rejection.

**Result notify** prefix `sediment-worker-maintenance-result:` + schema `pi-astack/sediment-worker-maintenance-result/v1`. Closed keys only: `request_id`, `status`, `retryable`, `restart_child`, `pending_before_bucket`, `pending_after_bucket`, optional `failed_bucket`, optional `repaired_bucket=unknown|0|1`, optional `repair_status=repaired|already_repaired|not_eligible|busy|budget|failed`, optional `error_code`, optional `elapsed_bucket`. `repaired_bucket` and `repair_status` appear only when the request policy is non-`none`; absent/default `none` preserves the pre-repair maintenance result keys. Final `failed_bucket` is re-read after repair/drain. Resolved history count is not added to this protocol. **No** item/event id / path / URL / free-text error.

**Progress**: reuses `pi-astack/sediment-worker-progress/v1` with stage `publication` (no identity), emitting a heartbeat every 5 seconds while valid maintenance is waiting/running.

### 2.9 Suggested worker argv

```bash
PI_ASTACK_SEDIMENT_WORKER_MODE=1 \
PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT=<copy-store> \
PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS='["/abs/owner"]' \
ABRAIN_ROOT=<path> \
  pi --mode rpc --no-session \
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
  --extension <path-to>/extensions/sediment/index.ts
```

All flags are real Pi CLI flags（`pi --help`）. Settings must set `sediment.executionOwner: "daemon"`.

## 3. Non-goals（Stage0）

- Formal ConsumerAck / required-consumer retention
- Authority cutover / central primary
- Daemon lifecycle supervisor（owned by pi-router）
- Recursive edge shadow from worker
- Memory decision/write counter telemetry completeness（reported 0 until pipeline surfaces counts）
- Receipt/claim GC
- Non-Linux OFD claim portability
- Edge-protocol-shadow delete / retention watermark advance from capture receipt
- Publication outbox retention / delete / formal ACK from maintenance result (local drain only; not authority)

## 4. Consequences

- Daemon can hand terminal witness work to a headless worker without blocking interactive Pi
- Single writer implementation remains `runSedimentAgentEndPass` / existing extractor→curator→writer
- Dual-executor races prevented by `executionOwner` + worker gate
- Stage0 is a migration bridge surface only; full Stage A/B/C remain open
