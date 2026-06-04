# Design — Outcome→Entry Feedback Edge (meta-curator capability #1)

> Status: **v3 — Round-2 cross-model CONSENSUS** (Opus-4-8 + GPT-5.5 + DeepSeek-v4-pro).
> v1 FAILED Round-1 blind review with 2 P0s. v2 incorporated the P0 fixes but the
> orchestrator unilaterally arbitrated the one remaining disagreement (lane
> structure). Per user direction, a Round-2 debate let the three models converge
> themselves; v3 records THEIR consensus (not orchestrator arbitration). See §0.
> No code written yet; v3 awaits user go-ahead before implementation.
> Implements: ADR 0024 meta-curator capability #1 (mechanism deferred to ADR 0025);
> see memory `sediment-meta-curator-five-capability-outline`.
> Date: 2026-06-04.

## 0. Revision log — v1 → v2 (Round-1 P0 fixes) → v3 (Round-2 consensus)

### Round 1 (blind): v1's two load-bearing assumptions were wrong

- **[P0-B, killed] "confidence/status changes are automatically multi-view-gated
  by the writer."** FALSE. multi-view lives in the curator pipeline
  (`curator.ts:975`), NOT in the writer. `updateProjectEntry` /
  `archiveProjectEntry` / `supersedeProjectEntry` execute directly with no gate;
  a lane calling them bypasses review entirely. Even `shouldTriggerMultiView`
  returns `triggered:false` for low-confidence archive and mid-confidence
  changes (`multi-view.ts:178-260`). (v1 also misnamed the fn `patchProjectEntry`;
  real name is `updateProjectEntry`.) → v2 routes lifecycle changes through an
  EXPLICIT gate and EXTENDS the trigger to cover all corpus-curator changes.
- **[P0-A, killed] "Tier A telemetry in frontmatter is side-effect-free."**
  FALSE. The writer update path force-bumps `updated`, appends a Timeline line
  every run, git-commits + auto-pushes to origin (ADR 0020), serializes nested
  objects as JSON string scalars, and can silently reset `status→provisional` /
  `confidence→3` on a malformed entry. → v2 moves ALL telemetry to a git-ignored
  **sidecar**; frontmatter is never touched for telemetry.
- **[P0, new] Feedback-loop collapse.** Outcome signals are self-reported by the
  same brain that reads the entries. `retrieved-unused → demote → less injected
  → never cited → archived` is a self-reinforcing collapse, and `retrieved-unused`
  is frequently HEALTHY disuse. → v2 makes `retrieved-unused` TRIAGE-ONLY and
  requires INDEPENDENT evidence for any demotion, plus hysteresis + a re-test
  (holdout) path so demoted entries can recover.
- **[decisions settled in Round 1]** D2 = demote/contest only, defer auto-raise.
  D3 = cumulative `citation_count` (computed separately — NOT from
  `summarizeEntryActivity`, which is windowed) + 30d rolling `outcome_signals`.
  D4 = sidecar, not frontmatter.

### Round-2 consensus on D1 (lane structure) — the models' own convergence

Round 1 split 2:1 (Opus+DeepSeek dedicated lane; GPT-5.5 aggregator-feed). In
Round 2 each model saw the others' arguments and converged:

- DeepSeek verified in code (`aggregator.ts`) that the aggregator ALREADY does
  per-`entry_slug` staleness judgment: `summarizeOutcomes` groups outcome rows by
  slug; `buildAdvisories` emits per-entry `high_unused`/`echo_chamber` signals;
  the v1 LLM returns per-entry `demoted_signals`. A dedicated lane would be
  literal code-path duplication → DeepSeek moved to aggregator-feed.
- Opus moved to aggregator-feed, adding: the aggregator emits a read-only
  OBSERVATION (not a verdict); a **deterministic** executor owns routing; the
  cognitive verdict reuses the aggregator LLM (existing) + the multi-view
  reviewer — NO third LLM pass.
- GPT-5.5 also dropped the dedicated full-recompute lane but flagged a residual
  risk: emitting lifecycle proposals from the aggregator escalates the aggregator
  prompt's blast radius (a prompt tweak could regress lifecycle behavior).

**CONSENSUS (D1):** aggregator-feed. (1) Aggregator stays READ-ONLY and emits
`entry_lifecycle_proposal` derived from the per-entry `demoted_signals` it ALREADY
produces — a new sink for an existing judgment, not a new responsibility, and no
duplicated stats pass. (2) A thin DETERMINISTIC executor applies the §4
loop-breaker preconditions and routes through the explicit multi-view gate; the
only LLMs in the path are the aggregator (existing) and the multi-view reviewer.
(3) GPT-5.5's coupling concern is captured as a DOCUMENTED FALLBACK TRIGGER, not
pre-built: if dogfood shows the aggregator prompt's lifecycle-proposal duty
regresses its operational-hypothesis duty, split lifecycle judgment into a
separate small lane then (ADR 0024 R5 — build on observed regression, not
imagined coupling).

## 1. Why (the missing half of the self-correcting brain)

We shipped the **L1 evolution loop** (aggregator v1.2 + `evolution-ledger.jsonl`):
the aggregator reflects on its OWN hypotheses. That is self-correction over
*operations*. The **durable corpus has no equivalent loop**: `outcome-ledger.jsonl`
records per-citation `decisive`/`confirmatory`/`retrieved-unused` (5000+ rows),
but it never flows back to the entry. `grep` confirms no code adjusts
`confidence`/`status` from outcome signal anywhere in `extensions/sediment/`.

Goal: close that edge — let the corpus self-clean using REAL usage data, without
breaking INV-INVISIBILITY and without opening `promote_candidate → durable`.

## 2. Boundary vs evolution-ledger

| | L1 evolution-ledger (shipped) | Outcome→Entry feedback (this) |
|---|---|---|
| Subject | aggregator's own operation hypotheses | durable corpus entries' usefulness |
| Telemetry sink | `evolution-ledger.jsonl` | NEW `entry-telemetry` sidecar (git-ignored) |
| Touches durable memory? | NEVER | ONLY via gated lifecycle executor |
| User-visible? | no | no (INV-INVISIBILITY) |

## 3. Architecture (v2): read-only proposal → sidecar telemetry → gated executor

Three pieces, each with a single concern:

### 3a. Telemetry sidecar (INFRA, no LLM, no durable write)
A new git-ignored sidecar under `~/.abrain/.state/sediment/` (sibling of
`evolution-ledger.jsonl` / `aggregator-ledger.jsonl`), keyed by `project_root + slug`:

```jsonc
{ "project_root": "...", "slug": "...",
  "citation_count": 42,            // CUMULATIVE — computed by accumulating ledger rows,
                                   // NOT available from summarizeEntryActivity (windowed)
  "last_cited_at": "2026-06-04T20:13:11+08:00",
  "window_days": 30,
  "decisive": 0, "confirmatory": 6, "retrieved_unused": 12,
  "decisive_streak": 0, "possible_echo_chamber": false, "total_retrievals": 18,
  "updated_at": "..." }
```

- Rolling fields reuse `summarizeEntryActivity(rows, slugs, 30)` verbatim.
- `citation_count` is the ONE field not in `EntryActivityStats`; computed by a
  thin cumulative accumulator over `readProjectOutcomeRows` (or carried forward
  in the sidecar). The v1 reuse table overclaimed this — corrected.
- Telemetry is re-derivable from the ledger; sidecar loss → full re-scan rebuilds.
- NEVER writes entry frontmatter. No `updated` bump, no Timeline growth, no git
  churn, no auto-push. Resolves P0-A wholesale.
- If telemetry is ever needed on a result card, surface it through the
  `memory_search` card path (like `outcome_activity` already is), NOT frontmatter.

### 3b. Lifecycle proposal — REUSE the aggregator's existing per-entry judgment
The aggregator already groups outcome rows by `entry_slug` and produces per-entry
`demoted_signals` (verified: `summarizeOutcomes` + `buildAdvisories` +
`aggregator-llm.ts`). v3 adds ONE read-only output: when a `demoted_signal` also
clears the §4 loop-breaker bar (independent evidence, not usage-only), the
aggregator additionally emits an `entry_lifecycle_proposal` into a sidecar (NOT a
durable write; the aggregator stays read-only). This is a new SINK for an
existing judgment — no second corpus-wide LLM pass, no duplicated stats. Each
proposal carries a falsifier and the independent-evidence citation.

### 3c. Gated executor (the ONLY durable-mutating lane; deterministic plumbing)
A thin executor consumes pending `entry_lifecycle_proposal`s. It contains NO
staleness LLM of its own (the verdict is the aggregator's existing judgment +
the reviewer below). For each proposal it:

1. Re-checks §4 loop-breaker preconditions against fresh state (mechanical
   preconditions: independent evidence present? hysteresis cooldown elapsed?
   not in a holdout-recovery window?). These are routing guards, not the verdict.
2. Routes through the EXPLICIT review gate — NOT a bare writer call. Concretely:
   `shouldTriggerMultiView` + `runMultiView` (lives in `curator.ts:975`, NOT the
   writer), with the trigger EXTENDED so EVERY corpus-curator lifecycle change is
   gated regardless of confidence (v1's "writer auto-gates" assumption is dead).
   The multi-view reviewer is the SECOND (independent-family) LLM in the path.
   Simplest safe v1 subset: `status` → `contested`/`archive`/`supersede` via an
   explicitly-forced gate; `confidence-down` deferred (see §9.4).
3. On reviewer confirm → existing writer (ADR 0014 #1 single writer preserved).
   On veto → defer to staging; never execute. Reversible via archive-reactivation.

## 4. Loop-breaker contract (new in v2 — required before any demotion)

1. `retrieved-unused` is **triage-only**: it may flag an entry for LLM review,
   but is NEVER sufficient evidence to demote on its own.
2. Demotion requires INDEPENDENT evidence, at least one of: explicit user
   correction; contradiction by a newer active/superseding entry; domain/version
   staleness visible in the entry text; reviewer-found content mismatch.
3. Do NOT count "not injected after demotion" as further negative evidence
   (freeze the evidence window at proposal time).
4. Hysteresis: per-entry min sample size + cooldown (a per-entry dwell-time
   record, not the per-project lane debounce) before re-proposing.
5. Holdout / exploration: periodically re-surface demoted/contested entries with
   neutral retrieval so a wrongly-demoted entry can recover.
6. No `archive` from usage-only evidence; archive needs §4.2 independent evidence
   AND passes the gate.

## 5. AI-Native split

- Prompt-native: the judgment "is this entry stale / contradicted" (aggregator's
  skeptical-historian, case-FOR/AGAINST + falsifier).
- Structured INFRA only: aggregate ledger rows, serialize telemetry sidecar,
  enqueue proposals, route through gate, call writer. No mechanical
  threshold decides lifecycle. Caveat (Opus P2): do NOT let the existing
  selection thresholds (`streak≥5`, `unused≥3`) silently filter which entries the
  LLM ever sees — feed the raw distribution + non-flagged population too.

## 6. Invariants preserved (reviewers must re-verify on code)

1. ADR 0014 #1 single writer — all durable mutations via existing writer.
2. INV-INVISIBILITY — no user surface.
3. No `promote_candidate → durable` — only adjusts EXISTING entries.
4. Reversibility — soft archive (archive-reactivation rollback) + git.
5. Prompt-native cognitive layer; structured layer only serializes/routes.
6. **Gate is explicit** (NOT assumed-from-writer) and covers ALL corpus-curator
   lifecycle changes regardless of confidence.
7. Aggregator stays read-only w.r.t. durable memory (it only emits proposals).

## 7. Reuse map (corrected)

| Need | Existing primitive | New work |
|---|---|---|
| windowed per-slug stats | `summarizeEntryActivity()` | none |
| read project outcome rows | `readProjectOutcomeRows()` | none |
| cumulative `citation_count` | — (NOT in EntryActivityStats) | thin accumulator |
| enumerate corpus slugs | `loadEntries()` (full dir walk) | project-scoped active+provisional filter |
| telemetry persistence | evolution/aggregator-ledger sidecar pattern | new `entry-telemetry` sidecar |
| proposal emission | aggregator prompt-native pass | new `entry_lifecycle_proposal` output field |
| gate | `shouldTriggerMultiView`+`runMultiView` (`curator.ts:975`) | extend trigger for corpus-curator origin |
| durable write | `updateProjectEntry`/`archive`/`supersede` | route from executor only |
| lane debounce | aggregator `readLastRun`/`writeLastRun` | clone for executor |

## 8. Smoke test plan

- Telemetry sidecar: synthetic ledger → correct stats; idempotent; NEVER writes
  frontmatter; `citation_count` accumulates across runs.
- Loop-breaker: a `retrieved-unused`-only signal does NOT produce a demotion
  proposal; demotion requires independent evidence.
- Gate: a proposed `archive`/`supersede` MUST invoke the gate; reviewer veto
  defers, does not execute; low-confidence target is STILL gated (regression
  against the v1 bug).
- Degraded: no modelRegistry → telemetry still writes, no proposals, no crash.
- Boundary: executor never opens promote_candidate→durable; never emits a user
  surface; aggregator emits proposals but performs no durable write.
- Scale/concurrency: telemetry write acquires sediment lock per durable touch
  (here: none, sidecar only); executor write serializes with auto-write lane via
  sediment lock; partial-batch failure leaves consistent sidecar (per-item
  try/catch).

## 9. Open items still to settle before/while coding

1. **Measure corpus size** per `~/.abrain/projects/*/` (DeepSeek P0): confirms
   scan cost and validates sidecar-over-frontmatter (already chosen).
2. Exact gate-extension shape: forced-trigger flag on `shouldTriggerMultiView`
   for `origin="corpus_curator"` vs restricting executor to always-gated ops
   (`supersede`). Lean: forced-trigger flag (covers archive + confidence-down).
3. Dwell-time / hysteresis store location (per-entry) — likely inside the
   telemetry sidecar row (`last_proposed_at`, `proposal_cooldown_until`).
4. Whether confidence-down is in scope for v1 of this feature or status-only
   first (lower blast radius). Lean: status `contested`/`archive` first; add
   confidence-down once dogfood shows the gate + loop-breaker behave.

## 10. Out of scope (deferred)

- `promote_candidate → durable`; classifier auto-iteration (#4, needs version
  error-rate data); brain→user proactive surface; cross-project synthesis.
- Auto-RAISE of confidence (echo-chamber risk; all 3 reviewers).
