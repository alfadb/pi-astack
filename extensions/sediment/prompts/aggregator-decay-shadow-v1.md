# Aggregator addendum — ADR 0031 Phase 1B decay shadow assessment (v1)

> This block is appended to the skeptical-historian prompt ONLY when the
> `forgetting.decayShadow` flag is enabled. It adds ONE orthogonal output array,
> `entry_decay_assessments[]`. It does NOT change any existing instruction,
> output field, or the empty-output discipline for `promoted_advisories`.

## Decay assessment — purpose and hard limits

You additionally produce a SHADOW decay assessment for durable entries. This is
**observation only**: nothing is demoted, archived, or deleted as a result. The
safety of the whole system rests on archived being a reversible floor, not on the
accuracy of these scores — so be calibrated, not aggressive.

Assess the entries surfaced in the `ENTRY DECAY TELEMETRY` input block (their
per-entry usage signals), plus any entry for which the existing input feeds carry
truth-change evidence.

For each assessed entry emit one object in `entry_decay_assessments[]`:

- `slug`: the durable entry slug.
- `decay_score` (0..1): an **advisory** estimate of how much this entry has
  decayed in standing. Multi-factor, in descending weight:
  1. **superseded** by a newer entry, or **contradicted** by a user correction — strong.
  2. **version/domain staleness** readable from the entry content — medium.
  3. **kind**: `anti-pattern` and `maxim` resist decay (negative knowledge and
     durable principles re-cost an incident to relearn); `fact`/`smell` decay
     faster. Weight kind into the score.
  4. **disuse** (low retrieval, high `window_retrieved_unused`, old `last_cited_at`)
     — **WEAK context only**. Disuse is normal for cold-but-critical entries.
  `decay_score` is colour for review, never an authorization to forget.
- `would_demote` (boolean): TRUE only when the SAME §4.2 independent evidence bar
  that gates an `archive` `lifecycle_proposal` is met — supersession by an active
  newer entry, a user contradiction, or version/domain staleness. **Disuse, low
  usage, or a high `decay_score` ALONE must NEVER set `would_demote=true`.** If you
  have only usage signals, `would_demote` is `false`.
- `demote_evidence_type`: `"superseded_by"` | `"contradicted"` | `"version_stale"`
  when `would_demote=true`; otherwise `null`. It must be non-null IF AND ONLY IF
  `would_demote=true`. A usage signal is never a valid value here.
- `primary_driver`: `"supersede"` | `"contradiction"` | `"staleness"` | `"disuse"`
  | `"kind_atypical"` — the dominant factor behind `decay_score`.
- `decay_inputs`: echo back the usage context you used
  (`window_retrieved_unused`, `decisive_streak`, `last_cited_at`) — context, not driver.
- `falsifier`: what observation would prove this assessment wrong.

## Resurrection feedback (self-calibration)

The input may include a `resurrection_context` (recent reactivation rate + trend).
If recent reactivations are **accelerating** or the rate is **high**, prior decay
was too aggressive — entries that were demoted are being pulled back. In that case,
lower `decay_score` across the board and raise your bar for `would_demote`. A LOW
reactivation rate is **inconclusive**, never proof that aggressive decay is safe
(rare-recurrence entries are by definition not in the reactivation window).

## Correlated-blindness self-check (run before emitting)

For each entry where you set both an `archive` `lifecycle_proposal` AND a high
`decay_score` / `would_demote`: ask whether you are judging both in the same
direction because of the entry's kind, domain, or language rather than independent
evidence. If the only thing linking them is a shared surface feature, lower
`decay_score` and keep `would_demote=false`. The most valuable entries are often
the ones whose value is least obvious to you.

Modal expectation: most assessed entries have `would_demote=false`. A run where
many entries are `would_demote=true` from usage signals is a self-error — re-read
this section.

## Output addition

Add to the existing strict-JSON output object exactly one new top-level key:

```json
{
  "entry_decay_assessments": [
    {
      "slug": "<entry slug>",
      "decay_score": 0.0,
      "would_demote": false,
      "demote_evidence_type": null,
      "primary_driver": "disuse",
      "decay_inputs": { "window_retrieved_unused": 0, "decisive_streak": 0, "last_cited_at": "<iso|absent>" },
      "falsifier": "<what would disprove this>"
    }
  ]
}
```

Omit the key entirely if you assessed no entries. All existing output keys and
their rules are unchanged.
