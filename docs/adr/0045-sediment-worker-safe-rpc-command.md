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

**`daemon`**: ordinary Pi extension **does not** write ordinary intake pending (nobody consumes it under daemon ownership), does **not** enqueue / schedule recovery / run the normal sediment pass/timer. When the continuous edge-protocol-shadow producer triple gate is fully open, `agent_end` captures healthy terminals into edge shadow; when dual producer flags are incomplete, `agent_end` emits aggregate audit/config diagnostic `daemon_capture_disabled` and returns (no foreground pipeline, no pending leak). Headless worker (`PI_ASTACK_SEDIMENT_WORKER_MODE=1`) is the sole pass executor. Worker start **requires** `executionOwner=daemon` else returns `execution_owner_not_daemon` (prevents dual-executor races).

### 2.1b Continuous edge-protocol-shadow producer (`sediment.daemonWorker.edgeShadowCaptureEnabled`)

Default **`false`**. Triple gate — all required: `executionOwner=daemon` **and** `edgeProtocolShadow.enabled=true` **and** `daemonWorker.edgeShadowCaptureEnabled=true`. Ordinary foreground Pi then writes each **healthy** terminal assistant turn into the existing flat `edge-protocol-shadow` authoritative source:

- Pair API `captureEdgeProtocolTerminalPair` (source + candidate + terminal_witness under one journal OFD lock). Public `writeEdgeTerminalWitness` default append semantics unchanged; pair/recovery use explicit pin + idempotent opts
- Hard size contract: exact raw sidecar bytes and journal record JSON each ≤ **8 MiB** (`EDGE_PROTOCOL_SHADOW_MAX_FILE_BYTES` = pi-router `MAX_READ_BYTES`). Oversize → stable skip/fail code, **no** candidate left
- Atomic publish temps live under per-session `staging/` (same FS, scanner does **not** enumerate). Never leave `.tmp` under `journal/records/` (daemon whole-round fail)
- Owner root = `resolveDaemonEdgeOwnerRoot(cwd, abrain)` physical bind/git root → realpath (unique `owner_key`). Never worktree extension path. Realpath double-fail is **fail closed** (throw / skip capture+recovery aggregate) — never return non-realpath raw
- Session id is SessionManager authority; C6 keeps real number/string types; leaf tip from real `getLeafEntry` (never synthesized)
- Healthy terminal: real last assistant with `stopReason` in accepted set (`stop`/`length`). Empty / no assistant / `toolUse` / error / aborted / untrusted → skip
- Concurrent same (session,C6,content) under OFD lock → one candidate + one witness. Same C6 different content → fail closed `c6_content_conflict`
- Sidecar always create/verify content-addressed; missing restored; corrupt collision fail closed; never witness → missing sidecar
- Candidate-only partial failure: owner-wide bounded `session_start` recovery fills witnesses only
- Daemon owner **never** writes ordinary intake (no unbounded `pending/` orphans) regardless of producer source / flag completeness. Full triple gate → edge capture; incomplete flags → `daemon_capture_disabled` skip. Foreground keeps intake→queue. Capture receipt is **not** ConsumerAck / knowledge ack / formal authority / retention / delete
- `agent_end` awaits local fsync only (no LLM). Worker mode never producer-captures
- Production is settings-JSON only. Env `PI_ASTACK_DAEMON_WORKER_EDGE_SHADOW_CAPTURE` requires `PI_ASTACK_ENABLE_TEST_HOOKS=1`

### 2.2 Worker mode env

`PI_ASTACK_SEDIMENT_WORKER_MODE=1` puts the sediment extension into worker-only registration:

- Registers **only** `/sediment-worker-run`
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

**Forbidden**: raw transcript on argv beyond path reference; logging/stdout of raw body, paths in result, session/content/digest in result.

### 2.5 Sidecar verification

Handler opens sidecar via **open file handle + fstat** with `O_NOFOLLOW` when available (not lstat-then-readFile):

- reject symlink; require regular file; cap 8MiB
- verify `edge-source/v1`, `session_id`, exact `messages` RawValue sha256 = `content_id`
- Same-permission TOCTOU bound is honest Stage0

### 2.6 Pipeline reuse + independent checkpoint slot

Messages convert to synthetic branch entries with **content-stable entry IDs** (leaf_tip does **not** rename prior tips when cumulative sidecars grow). Fed into the existing agent_end pass against **owner_project_root** + source session provenance (C6/anchor).

Checkpoint IO uses an independent slot `daemon-worker:<sha256(source session)>` via snapshot `checkpointSessionId` so worker evaluation does **not** share the foreground source-session watermark.

### 2.7 Success condition / more loop / receipts

**Create-only success receipt** only when:

1. pipeline **really advanced** durable checkpoint (`lastProcessedEntryId` change), AND
2. backlog exhausted (`more=false`)

`more=true` continues **inside the worker** (hard budget 16). Budget exhaust ⇒ retryable non-final, **no** success receipt.

Soft skip / `project_not_bound` / settings disabled / no progress / void return ⇒ `status=failed`, `settled=false`, `retryable=true`, **no** success receipt. Void is never treated as processed.

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

On settled processed success the worker **explicitly** triggers knowledge publication outbox one-shot/drain (reuse existing function). It cannot wait for foreground `session_start`.

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

## 4. Consequences

- Daemon can hand terminal witness work to a headless worker without blocking interactive Pi
- Single writer implementation remains `runSedimentAgentEndPass` / existing extractor→curator→writer
- Dual-executor races prevented by `executionOwner` + worker gate
- Stage0 is a migration bridge surface only; full Stage A/B/C remain open
