---
doc_type: architecture
status: active
---

# Local Sediment Executor Authority: worker-first admission

> Status: worker-first minimum admission implemented in pi-astack. Daemon authority ownership, process containment, handoff, status, and production rollout remain pi-router work. This document does not claim full LSEA completion.

The authoritative full design is the living LSEA section of `/home/worker/work/components/pi-router/plan.md`. This repository implements only the pi-astack worker rollout slice.

## Contract boundary

The authority store is shared per canonical ABRAIN:

```text
<ABRAIN>/.state/sediment/local-executor-authority/
  authority.lock
  authority.json
```

`authority.json` is a strict flat string-object with schema `pi-router/local-sediment-executor-authority/v1`. The reader rejects unknown or duplicate keys, missing fields, noncanonical/zero/overflowing u64 epochs, non-lowercase 64-hex values, invalid mode/holder pairs, symlinked or non-regular files, and non-`0600` POSIX files. Reads are capped at 64 KiB. Pi-astack never creates, updates, removes, repairs, or locks this store.

Task and maintenance manifests retain schema v1 and add one paired expectation:

```json
{
  "local_executor_epoch": "7",
  "local_executor_holder_nonce": "<64 lowercase hex>"
}
```

Both fields must be absent or both must be present and canonical. The worker's point-in-time rollout matrix is:

| Store | Manifest pair | Result |
| --- | --- | --- |
| authority directory absent | both absent | legacy compatibility |
| authority directory absent | present or partial | `local_executor_authority_unavailable` |
| authority directory exists | both absent or partial | `local_executor_authority_unavailable` |
| authority directory exists | both present | strict admission |

During any read where the directory exists, corrupting or removing fields cannot restore legacy compatibility. New-daemon manifests remain paired, so deleting the whole store also returns unavailable for worker task/maintenance admission. Pi-astack is a read-only rollout slice and writes no separate durable "store once existed" tombstone; therefore permanent strict regime across whole-directory deletion and process restart depends on the pi-router daemon contract never deleting the store. This slice does not claim to implement that lifecycle invariant by itself.

Legacy compatibility is intentionally narrower than historical installs: if legacy `.state` or an intermediate component exists as a symlink, non-directory, unreadable path, or otherwise cannot prove that the authority directory is absent, classification fails closed. Only a clean `ENOENT` while walking ordinary directories is legacy-absent.

## Single-entry admission

`/sediment-worker-run` performs one admission after read-only worker/config/path validation and before receipt lookup, claim-directory creation, sidecar read, checkpoint, pass, L1, outbox, Git, or audit work. `/sediment-worker-maintenance` performs one admission before pending/failed counts, repair, or drain.

Strict admission reads the authority record, observes the physical lock, rereads the record, and requires the two record reads to have identical bytes **and the same opened file identity**. Because the daemon updates `authority.json` by atomic replacement, this rejects read-lock-read ABA even when a replacement generation restores byte-for-byte A before the second read. It then requires:

- `mode == held`
- `holder_kind == daemon`
- physical lock observed held
- record epoch equals manifest epoch
- record holder nonce equals manifest nonce

Failure codes are closed:

| Code | Classification |
| --- | --- |
| `local_executor_authority_unavailable` | store/path/schema/permission/read/lock observation cannot be proved, paired fields invalid, or record changes during observation |
| `local_executor_authority_revoked` | mode is not `held`, holder kind is not expected, or physical lock is free |
| `local_executor_authority_stale` | valid held daemon record and lock, but expected epoch or nonce differs |

Rejected task entry returns before the fixed worker artifact surface changes: receipt, checkpoint, L1, publication/decision outbox, Git HEAD/tree, and audit. Rejected maintenance returns before count/drain/repair. These errors are returned only in the existing structured worker result; rejection does not write a sediment audit row. All three authority codes return `retryable=true` and `restart_child=false`, including parse-time rejection of a partial/noncanonical authority pair.

For maintenance, heartbeat/progress emission and waiting for the process-local global serial may occur before admission. The zero-delta guarantee is therefore **durable semantic zero-delta**: no count/drain/repair and no sediment artifact mutation. It does not claim zero in-process scheduling, timer, or notification activity.

The authority-aware daemon design must interpret any of the three codes as a **global authority pause**: stop scheduling the whole worker, roll back/no-count the current ledger attempt, and retain the backlog. It must not consume per-item retry budgets or deadletter items one by one. A permanently corrupt store therefore remains globally paused for operator repair rather than converting the backlog into permanent deadletters. This daemon behavior is a rollout contract here, not an implemented pi-astack supervisor.

There are deliberately no B1-B8 authority barriers. After admission, the daemon's long-held lock and OS process-tree containment own the process-lifetime fence. Existing transaction/idempotency behavior remains responsible for already-admitted task effects.

## Capability and rollout

Worker mode registers `/sediment-worker-capabilities`. Its notify schema is `pi-astack/sediment-worker-capabilities/v1` and it declares exactly:

```json
{
  "capabilities": ["local_executor_authority_process_lifetime_v1"]
}
```

The command does not resolve settings or ABRAIN and performs no filesystem or semantic work. Rollout order is worker first: deploy this capability and absent-store legacy compatibility, prove the probe, stop/reap the old daemon, then deploy the authority-aware daemon. The new daemon must confirm capability before creating the authority store or sending strict task/maintenance manifests. The rollout must not leave an old daemon running after store creation: old-daemon compatibility is proved only against an absent store, so an old daemon never encounters strict-store rejection or burns legacy per-item attempts.

## Foreground classification

Ordinary Pi classifies the authority store read-only at semantic admission points:

| Observation | Foreground behavior |
| --- | --- |
| store missing | legacy behavior |
| strict `free+none` and physical lock observed free | legacy behavior |
| strict `held` | capture-only |
| strict `draining` | capture-only |
| corrupt/unreadable/unstable store or lock observation unavailable | capture-only |
| `free` while lock is still held | capture-only |

Capture-only keeps durable intake and edge candidate/witness capture available but does not enqueue or recover a local sediment pass, drain publication, replay, run policy/liveness recovery, or start writer work. When sediment is **enabled**, `session_start` still initializes the TUI edge layout and performs bounded owner-wide candidate-only witness recovery before the semantic early return. `settings.enabled=false` remains full legacy disable: zero authority IO, zero edge-recovery reopening through the main session_start path, and zero publication/policy startup — the edge triple gate must not reopen that path (edge keeps its independent session_start). On `agent_end`, fully disabled sediment+edge returns before any authority posture observation. `draining` only blocks new admission; it does not claim the old worker tree has stopped.

## Platform observation

### Linux/Unix

Linux opens the exact no-symlink `0600` lock file and executes pinned `/usr/bin/flock` through `/proc/self/fd` with `-xn` on that retained open file description. Exit 1 means another holder owns the lock; exit 0 means the worker briefly obtained and immediately released the probe lock, so authority is revoked. Any other outcome is unavailable. Other Unix platforms fail closed unless a native lock observer is supplied; file existence is never accepted as proof of a held lock.

### Windows

The daemon contract uses a process-lifetime handle opened with deny-all sharing. Before opening, the worker `lstat`s the lock path and rejects every symlink/reparse shape visible to Node plus all non-regular files. With the current Node Windows error mapping, only `EBUSY` is the closed sharing-violation signal and therefore means held. `EACCES`/`EPERM` may be ACL denial and are unavailable; a successful identity-matched read-only open is immediately closed and means free; all other outcomes are unavailable. POSIX mode bits are not treated as Windows ACL proof. Windows native daemon acceptance remains responsible for exact DACL, deny-all handle, Job Object, and process containment verification.

The focused smoke has a platform adapter seam for deterministic Windows classification tests. It is not a substitute for Windows native CI.

## Verification

```bash
npm run smoke:lsea-worker-admission
npm run smoke:sediment-worker-rpc
npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module preserve --target es2022 \
  extensions/sediment/local-executor-authority.ts
git diff --check
```

`smoke:lsea-worker-admission` covers every strict-record field omission, paired task/maintenance field omission, Unix non-`0600`, read-lock-read ABA, all three closed codes and retryable/no-restart shape, real Linux `flock` hold/release, Windows `EBUSY` versus ACL/unavailable classification plus symlink/non-regular rejection, free+held foreground posture, task/maintenance durable zero-delta rejection, capability zero side effect, and the absence of B1-B8 authority calls. `smoke:sediment-daemon-edge-capture` covers the capture-only `session_start` boundary and candidate-only witness recovery only when sediment is enabled, plus regressions that `settings.enabled=false` does not reopen authority recovery via the edge triple gate and that `agent_end` fully-disabled returns before authority IO.
