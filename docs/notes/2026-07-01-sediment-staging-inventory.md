---
doc_type: notes
status: active
---

# Sediment staging inventory - 2026-07-01

This note records a read-only inventory of `/home/worker/.abrain/.state/sediment/staging` for the second-brain cleanup sequence. No staging file was deleted, replayed, moved, or edited.

## Source and method

The scan walked `*.json` under `/home/worker/.abrain/.state/sediment/staging`, parsed each file as JSON, grouped by `entry.status`, `entry.kind`, `entry.resolver_disposition`, `entry.aged_out_decision`, directory, filename-derived age, content hash, and slug. File age was derived from the filename prefix such as `2026-05-23T09-37-33-735Z-...`, because these staging files do not expose a directly parseable timestamp field in a consistent location. Candidate groups below are advisory inventory labels only.

## Summary

| Dimension | Result |
|---|---:|
| Total JSON files | 80 |
| Root staging files | 69 |
| `abandoned/` files | 11 |
| Malformed JSON | 0 |
| Duplicate content hashes | 0 |

## Group counts

### Directory

| Directory | Count |
|---|---:|
| root | 69 |
| `abandoned/` | 11 |

### Status and kind

| Field | Value | Count |
|---|---|---:|
| `entry.status` | `provisional` | 80 |
| `entry.kind` | `provisional-correction` | 69 |
| `entry.kind` | `multiview-pending` | 11 |

### Resolver fields

| Field | Value | Count |
|---|---|---:|
| `entry.resolver_disposition` | `promote_candidate` | 41 |
| `entry.resolver_disposition` | `plausible` | 16 |
| `entry.resolver_disposition` | `likely_noise` | 12 |
| `entry.resolver_disposition` | missing | 11 |
| `entry.aged_out_decision` | missing | 43 |
| `entry.aged_out_decision` | `promote_candidate` | 19 |
| `entry.aged_out_decision` | `keep_aging` | 10 |
| `entry.aged_out_decision` | `soft_archive` | 8 |

### Age buckets

| Age bucket | Count |
|---|---:|
| `<7d` | 7 |
| `7-29d` | 36 |
| `30-59d` | 37 |
| `>=60d` | 0 |

## Advisory candidate groups

| Candidate group | Count | Meaning |
|---|---:|---|
| `promote_candidate_requires_review` | 44 | At least one resolver field points at promotion. Requires human or policy review before any replay. |
| `drop_candidate_requires_policy` | 13 | Resolver classified likely noise or soft archive. Requires explicit retention/removal policy before deletion. |
| `quarantine_or_keep_aging` | 12 | Plausible or keep-aging items without a promotion decision. Keep in staging or isolate for review. |
| `quarantine_abandoned_multiview` | 11 | Existing `abandoned/` multiview-pending files. Treat separately from root provisional corrections. |

## Duplicate identity signals

No duplicate raw content hashes were found. Slug-level repeats exist and should be reviewed before any replay, because repeated slugs are not byte-identical:

| Slug | Count |
|---|---:|
| `provisional-3096e384` | 5 |
| `provisional-2772c60f` | 3 |
| `provisional-87900a3c` | 3 |
| `provisional-bde6c246` | 2 |

## Representative files

### Promotion candidates

| File | Age days | Resolver | Age-out | Hash prefix |
|---|---:|---|---|---|
| `2026-05-23T17-59-36-379Z-provisional-2772c60f.json` | 38 | `promote_candidate` | `promote_candidate` | `8b7dd29d78ea0810` |
| `2026-05-24T03-43-30-769Z-provisional-2d828922.json` | 37 | `plausible` | `promote_candidate` | `69f00d086ba19a5e` |
| `2026-05-24T11-39-02-911Z-provisional-3096e384.json` | 37 | `promote_candidate` | `promote_candidate` | `48381ab40bc9e957` |
| `2026-06-25T12-46-41-124Z-provisional-87900a3c.json` | 5 | `promote_candidate` | missing | `9fbcf74149b39a21` |

### Removal-policy candidates

| File | Age days | Resolver | Age-out | Hash prefix |
|---|---:|---|---|---|
| `2026-05-23T09-53-35-175Z-provisional-1b06318a.json` | 38 | `likely_noise` | `soft_archive` | `81acf62878f5b3d8` |
| `2026-05-23T10-21-23-085Z-provisional-211d7581.json` | 38 | `likely_noise` | `soft_archive` | `a4e8e84a3c19ee05` |
| `2026-05-28T13-36-28-426Z-provisional-5cecc342.json` | 33 | `plausible` | `soft_archive` | `61dcb67fd1c45bab` |
| `2026-06-10T07-09-13-036Z-provisional-f1a9f6cc.json` | 20 | `likely_noise` | missing | `9a1a080f33bf9c6d` |

### Keep-aging / quarantine candidates

| File | Age days | Resolver | Age-out | Hash prefix |
|---|---:|---|---|---|
| `2026-05-23T09-37-33-735Z-provisional-b59a703c.json` | 38 | `plausible` | `keep_aging` | `0ec06ded16441f39` |
| `2026-05-23T10-47-15-224Z-provisional-496956d6.json` | 38 | `plausible` | `keep_aging` | `4d40cdc56b3a65c8` |
| `2026-06-05T07-27-10-406Z-provisional-bbe8ccda.json` | 25 | `plausible` | missing | `a995fe15efdf375e` |
| `2026-06-26T16-05-34-840Z-provisional-3b4aa950.json` | 4 | `plausible` | missing | `685fb5d2580b1903` |

## Decision boundary

This inventory does not authorize cleanup. The follow-up policy is documented in `2026-07-02-sediment-staging-backlog-policy.md`; it distinguishes replay, continued quarantine, and deletion using duplicated slug handling, current L1/L2 presence checks, resolver confidence, age, and whether a file is under `abandoned/`. Cleanup must follow that policy rather than act directly on this inventory.
