---
doc_type: reference
status: active
---

# LLM audit minimization and archive retention

## Runtime audit shape

`pi.session_event` streaming is aggregated in memory per `(root, module, operation, session, turn, subturn, ordinal)`. Every `message_start` allocates a unique ordinal. An update belongs to a stream only when its response ID matches exactly or the anchor has exactly one open stream. Ambiguous identity-free updates become independent orphan streams and are never compatibility-merged.

A matching `message_end` emits one complete summary. An ambiguous end emits each candidate and any response-associated orphan separately as incomplete, and removes all of them before the terminal row; no associated orphan is deferred to `agent_end`. `agent_end` and LRU eviction also emit incomplete summaries. State is capped at 256 streams. Event/type maps contain at most 32 keys including `other`; content indices are capped at 64.

Summaries contain only bounded counts, lengths, identity, completion state, and framed rolling SHA-256 checksum metadata. Delta text, cumulative partials, reasoning traces, tool payloads, signatures, encrypted content, prompts, and credentials are not retained.

The rolling checksum is keyless and deterministic (ADR 0027 C6): a domain-framed SHA-256 over the framed delta sequence, identical in every process for the same input. There is no key material, no key file, no mode/owner/symlink verification, and no ephemeral fallback — the checksum is a correlation/change-detection fingerprint, not authentication.

## Maintenance locking

Executing `seal`, `prune`, and `pin` share `.audit-maintenance.lock` per sink. Maintenance lock timeout is fail-closed. Executing `prune --yes` additionally holds `.audit.jsonl.rotate.lock`; lock order is always:

```text
maintenance -> rotate
```

Runtime rotation continues to use the rotate lock. Executing `pin` holds maintenance locks from source verification through pin publication. Executing `seal` holds them through archive enumeration, hashing, signing, and manifest publication. `prune --yes` holds both locks through recovery, both plan scans, quarantine, verification, and deletion. Prune dry-run acquires, creates, repairs, or removes neither lock.

A lock is removed as stale only when it is a bounded regular non-symlink file with stable identity and an owner PID that is definitively dead. Live, malformed, unknown, or unsafe locks are never stolen.

## Seal trust boundary

Seal stable archives before pruning:

```bash
node scripts/audit-log-maintenance.mjs seal \
  --root /absolute/project/.pi-astack/llm-audit \
  --yes
```

`audit-seal-manifest/v2` has a closed schema. Each verified entry carries the archive's identity (dev/ino/size/mtime/ctime), byte count, line count, and SHA-256. The manifest itself is NOT signed (ADR 0027 C6): the manifest-level HMAC signature was local-attacker authentication and is removed. Integrity is enforced by the per-entry SHA-256 + identity snapshots, which prune re-verifies against the actual archive file before any deletion. Legacy manifests that still carry a `signature` field are accepted and the field is ignored.

Prune validates the closed schema and requires a current seal to match archive dev, ino, size, mtime, ctime, SHA-256, and byte count. Unknown fields, malformed entries, and root/path mismatches cannot authorize deletion.

## Command read budget

Seal, pin, and prune use one `CommandReadBudget` per invocation. Archive hashes, seal manifests, pin request/output/evidence manifests, generation sidecars, and deletion journals all consume the same entry, byte, and wall-clock envelope. Every read follows `lstat -> O_NOFOLLOW open -> fstat`, requires size equality at open, and reads explicit bounded chunks no farther than the initial size. Budget/time checks run before and after each chunk; growth is detected by repeated `fstat` without consuming the appended suffix.

Default seal/prune hashing limits are:

- archive directory entries: 4096 hard maximum for seal
- prune read entries: 20,000 default, 100,000 hard maximum
- bytes per file: 512 MiB default, 16 GiB hard maximum
- bytes per command: 2 GiB default, 16 GiB hard maximum
- time per file: 60 seconds hard maximum
- time per command: 10 minutes hard maximum

Seal overrides use `--max-bytes`, `--total-max-bytes`, `--time-budget-ms`, `--total-time-budget-ms`, and `--read-max-entries`. Pin uses `--read-max-entries`, `--read-max-bytes-total`, and `--read-time-budget-ms-total`. Prune uses `--hash-max-bytes-per-file`, `--hash-max-bytes-total`, `--hash-time-budget-ms-per-file`, `--hash-time-budget-ms-total`, and `--read-max-entries`. Values above hard limits are rejected; exhausted budgets fail closed in dry-run and execution. Successful reports include `read_budget.consumed` and `read_budget.limits`.

Every regular helper-format archive contributes its actual `lstat` size to `archive_bytes`, even when its sidecar or seal is missing/invalid. Such entries are reported as `accounted_unprunable` and remain undeletable.

## Prune and recovery

Prune accepts only the canonical sink and defaults to dry-run:

```bash
node scripts/audit-log-maintenance.mjs prune \
  --root /absolute/project/.pi-astack/llm-audit
```

Retention defaults remain 30 days, 2 GiB archive capacity, latest 2 generations protected, 512 MiB per batch, and 16 archive pairs per batch. Incident pins under the sink exempt referenced archives.

Execution never directly unlinks an original archive path. For each pair it:

1. creates `maintenance-manifests/` through the held sink directory fd, then fsyncs the parent sink and newly opened `0700` directory;
2. exclusive-creates and fsyncs a `0600` `audit-prune-deletion-journal/v1` (no signature — the journal-level HMAC was local-attacker authentication and is removed; per-target sha256 + identity are the integrity checks);
3. atomically renames archive and its exact `.generation.json` sidecar within the archive directory to quarantine basenames derived only from `(journal_id, original_basename, pair_kind)`;
4. persists `prepared -> archive_quarantined -> pair_quarantined` progress by rewriting every changed field, fsyncing the replacement file, renaming it, and fsyncing the journal directory;
5. opens quarantines with `O_NOFOLLOW`, then verifies inode, size, mtime, and SHA-256 against the intent;
6. fsyncs each verified quarantine file before unlink, fsyncs the archive directory after unlink, records per-member durable progress, and persists terminal `deleted` state.

Recovery requires an exact `audit-prune-journal-<journal_id>.json` filename, a current nonlegacy helper archive basename, its exact sidecar, canonical logical paths, and exact derived quarantine basenames. Fake, structurally-invalid, path-traversing, cross-journal-colliding, and target-mismatched records (per-target identity/hash verification against the actual files) are rejected before any pair mutation. Legacy journals that still carry a `signature` field are accepted and the field is ignored.

Leaf swaps produce a persistent `blocked` journal while the unexpected object remains undeleted. Half-renamed pairs and the microstate where an archive or sidecar unlink is durable but its progress update was interrupted resume idempotently only when the exact counterpart state and identity make that inference safe. Missing, partial, colliding, or mismatched objects otherwise become `blocked` and require operator review.

There is no automatic GC, scheduler, or production default execution path. A prune dry-run is strictly read-only: it does not acquire, create, repair, remove, chmod, write, rename, or unlink maintenance/rotate locks or any sink object. It reports `consistency: "advisory_no_lock"`, reads existing lock/rotation-transaction/journal/archive/pin/seal state, and captures pre/post metadata snapshots. Existing control files or any non-active identity/entry change make candidate plans `stale` and add rejected records; the command does not retry. A same-inode append to only `audit.jsonl` is reported as `active_append_observed` but does not invalidate archive candidates. Recovery runs only with `--yes` while both maintenance and rotate locks are held.
