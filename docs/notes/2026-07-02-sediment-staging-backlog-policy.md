---
doc_type: notes
status: active
---

# Sediment staging backlog policy - 2026-07-02

This policy follows the read-only inventory in `2026-07-01-sediment-staging-inventory.md` and the 2026-07-02 refresh. It does not authorize direct deletion or manual durable-memory writes. The staging directory is `~/.abrain/.state/sediment/staging`, which is git-ignored local state; unlinking a staging file has no git recovery path.

## Current inventory

2026-07-02 refresh:

| Dimension | Count |
|---|---:|
| Total JSON files | 81 |
| Root staging files | 70 |
| `abandoned/` files | 11 |
| `provisional-correction` | 70 |
| `multiview-pending` | 11 |
| `lifecycle_state=soft_archived` | 8 |
| Age `<7d` | 7 |
| Age `7-29d` | 37 |
| Age `30-59d` | 37 |
| Age `>=60d` | 0 |

Repeated slug clusters still require grouped handling before any promotion or cleanup: `provisional-3096e384` x5, `provisional-2772c60f` x3, `provisional-87900a3c` x3, `provisional-bde6c246` x2.

## Policy

### Replay

Replay is allowed only for root `multiview-pending` entries handled by the existing `multiview-staging-replay` path. The replay path must preserve its current guards: oldest-first batch limit, origin project binding checks, neighbor reload through the same semantics as the original multi-view trigger, writer retry accounting, and deletion only after a successful writer action or an approved skip. Entries already under `abandoned/` are not replay candidates; they were isolated as terminal or unsafe retry cases and require manual investigation or a purpose-built recovery path.

`provisional-correction` files are not direct replay inputs. A `resolver_disposition=promote_candidate` or `aged_out_decision=promote_candidate` is only an advisory signal. Promotion to durable memory must pass a multi-view gated promotion path and must first check whether the same quote or target entry is already represented in current L1/L2 projections. Do not manually convert a staging JSON file into a memory entry.

### Keep Active

Keep active entries in the root staging directory when they are younger than 30 days and have `resolver_disposition=plausible`, no resolver disposition, or a future utterance may still supply attribution. These remain eligible for classifier context, resolver triage, and later age-out review. `likely_noise` before age-out is deprioritized, not deleted.

For repeated slugs, treat the slug cluster as one review unit. Compare all source utterances and target-entry hints before deciding whether any durable promotion is warranted. If a durable write later captures the signal, remove all staging twins for that slug through the existing cleanup primitive rather than one file at a time.

### Quarantine

Keep quarantined, and exclude from active backlog accounting, when an entry is already `lifecycle_state=soft_archived` or lives under `abandoned/`. These files are retained for inspection because `.state` is not git-recoverable. They should not be selected by normal loader, resolver, age-out, or replay paths.

If a root entry is older than 30 days and has not been reviewed by age-out within the re-review window, it should go through `staging-ageout`. The age-out reviewer may set `keep_aging`, `soft_archive`, or `promote_candidate`; it must not unlink the file.

### Delete

Hard-delete is not authorized for `provisional-correction` staging files in the current state. A future hard-delete sweep requires a recovery primitive first, such as a tracked tombstone, a recoverable trash directory, or another auditable archive that survives process and host restarts.

The only current deletion cases are existing code paths with their own safety contracts: `multiview-staging-replay` may delete the original staging file after successful durable write or approved skip, and deterministic Tier-1 direct-write cleanup may remove matching provisional staging twins after the durable write has already captured the same signal. Manual cleanup by filename is out of policy.

## Operating sequence

1. Re-run a read-only inventory before every maintenance batch and compare counts with this note.
2. Process root `multiview-pending` replay through the existing replay loop only, with the correct active project binding.
3. For `provisional-correction` promotion candidates, build a grouped review set by slug, target entry, and source quote; then use a multi-view gated promotion path. If no such path is available, keep them staged.
4. Let resolver and age-out continue to annotate active root files. Move to quarantine only by existing lifecycle fields or replay soft-archive paths.
5. Do not hard-delete quarantined files until a recovery primitive exists and a separate sweep policy defines its age window, audit row, and rollback procedure.
6. After any maintenance batch, run `npm --prefix /home/worker/.pi/agent/skills/pi-astack run health:memory` and record staging counts plus any search/health regressions.
