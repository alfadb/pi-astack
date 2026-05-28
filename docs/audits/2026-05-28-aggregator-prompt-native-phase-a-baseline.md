# Phase A — Aggregator prompt-native pass baseline dossier

- **Date**: 2026-05-28
- **Purpose**: Phase A of ADR 0025 §4.3 aggregator prompt-native skeptical-historian
  upgrade. Pure data collection, no code mutation. Provides baseline for
  Phase B prompt drafting and Phase D regression dossier.
- **Author**: autonomous main session (sediment auto-write tracking this turn)
- **Reviewers (planned)**: 3 × T0 cross-provider per ADR 0024 §5.4 multi-view
  norm — Claude Opus 4-7, GPT-5.5, DeepSeek v4-pro.

---

## 1. Dataset

| Source | Path | Rows | Window |
|---|---|---|---|
| aggregator-ledger | `~/.abrain/.state/sediment/aggregator-ledger.jsonl` | 8 runs | 2026-05-26 → 2026-05-28 (3 days) |
| audit (latest run sample) | `~/.abrain/.state/sediment/audit.jsonl` | 455 rows considered in last run | 30 d window |
| outcome-ledger | `~/.abrain/.state/sediment/outcome-ledger.jsonl` | 374 rows in last run | 30 d window |
| multi-view-metrics | `~/.abrain/.state/sediment/multi-view-metrics.jsonl` | 254 calls (pass1=133, pass2=121), `ok=true` × 254 | full retention |
| staging | `~/.abrain/.state/sediment/staging/` | 29 files (27 provisional + 2 multiview-pending) | full retention |
| classifier health (latest) | aggregator row `classifier_health` | quote=1.0, alt=1.0, self_critique=1.0 (n=46) | last 50 classifier rows |

Cross-project distribution of the 8 aggregator runs:

| Project | Runs | Audit rows | Outcome rows |
|---|---|---|---|
| `/home/worker/.pi` (pi-astack itself) | 3 | 500 each (cap) | 1604-1712 |
| `/home/worker/work/kihh/full` | 3 | 455-487 | 291-374 |
| `/home/worker/work/base/sub2api` | 2 | 82-147 | 12-40 |

→ pi-astack itself is the dominant dogfood site (highest outcome volume).

---

## 2. Advisory taxonomy emitted by mechanical v0.2

Total advisories across 8 runs: **40**, split:

| Advisory kind | Count | Severity | Trigger (mechanical) |
|---|---|---|---|
| `outcome_entry` (retrieved-unused) | 17 | warning | `retrieved_unused_count >= HIGH_UNUSED_THRESHOLD = 3` |
| `outcome_entry` (decisive-streak) | 8 | warning | `decisive_streak >= 5` (echo-chamber proxy) |
| `staging_backlog` | 8 | warning | `total_files >= STAGING_CRITICAL_THRESHOLD = 50` or growth |
| `multiview_pending` | 7 | warning | `multiview_pending > 0` with replay-stuck framing |

### 2.1 `outcome_entry` retrieved-unused — distinct entries flagged

| Slug | Max count | Kind / scope | Mechanical verdict | Human reading |
|---|---|---|---|---|
| `in-vivo-correction-channel-as-durable-knowledge-source` | 13 | pattern (pi-global) | warning | **maxim-like pattern, frequent retrieval expected. RETRIEVED-UNUSED is normal — it shapes framing without being directly cited.** Likely false positive. |
| `prefer-prompt-engineering-over-mechanical-guards` | 13 | maxim (pi-global) | warning | Same as above — **maxim cited indirectly via framing, not via concrete decision quote**. False positive. |
| `sediment-status-bar-idle-hidden` | 9 | fact (pi-global) | warning | Narrow scope fact (footer rendering). Possibly stale — was relevant during f3555e8 walkback, now footnote-only history. **Could justify archive consideration**. |
| `pi-footer-supports-multi-line-rendering-via-setfooter` | 4 | fact (pi-global) | warning | Same shape as above — old infra fact, possibly stale. |
| `avoid-long-argv-prompts` | 11 | anti-pattern (pi-global) | warning | **Retrieved often but never tripped = healthy avoidance** (the anti-pattern is doing its job). False positive. |
| `大臂电流控制新架构原则` | 6 | pattern (kihh, conf=9) | warning | kihh project pattern, retrieved 9 times, used 0. **Possibly genuine memory_search noise / over-retrieval into unrelated contexts**. Worth a closer look. |
| `大臂液压方向电流首期标定参数集` | 3 | decision (kihh, conf=8, provisional) | warning | Similar shape, provisional status, kihh project. |
| `dont-reuse-shared-headers-whitelist-across-different-upstream-trust-domains` | 5 | anti-pattern | warning | Healthy avoidance (same as `avoid-long-argv-prompts`). False positive. |

**Reading**: ~5/8 distinct flagged entries are **mechanically tripped false
positives** (maxims/anti-patterns expected to be retrieved often without being
"directly cited"). The remaining 3 (2 kihh patterns + 1 stale fact) are
candidates for genuine LLM-level scrutiny.

### 2.2 `outcome_entry` decisive-streak — distinct entries flagged

| Slug | Streak | Likely cause |
|---|---|---|
| `persistent-input-history-v4-design` | 21 | Active work on this design — repeated DECISIVE = it's the spec we're implementing. NOT echo chamber. |
| `final-pi-multi-agent-architecture` | 20 | Same as above — active dispatch/L2 work cites it because it IS the architecture. NOT echo chamber. |
| `second-brain-invasion-boundary-natural-vs-management-ui` | 10 | Active sediment dogfood — every sediment-related decision cites this boundary. Active reaffirmation by being applied. |
| `rlhf-reviewer-bias-toward-mechanical-derisk-in-ai-native-system-critique` | 6 | Cited in 3-T0-review setups (the review protocol invokes this pattern). |
| `separate-classification-axis-from-capability-axis-in-gateway-fields` | 5 | Project-local pattern (sub2api). |
| `kihh-t0-review-panel-consensus-protocol` | 5 | Project-local pattern. |

**Reading**: All 6 are "active-application streaks", NOT echo chamber. Mechanical
threshold `>=5` catches them because that's the only signal it has. **A
prompt-native skeptical-historian should distinguish "actively-applied
spec" from "self-reinforcing recommendation loop"**.

### 2.3 `staging_backlog` — 25-35 file range

8 runs report `staging_backlog` warning every time (total_files=25-35). All
runs flag this because growth is monotone (no resolve mechanism — see
ADR 0025 §4.1.5.1 staging-resolver NOT implemented, lazy-resolve via
classifier step 6 is the current path).

- 27 of 29 current staging files are `provisional-*` (classifier hypotheses
  awaiting resolution).
- 2 of 29 are `multiview-pending-*` (batch 3 staging-replay queue).
- Oldest provisional: 2026-05-23 (5 days). All within 30 d age-out window.

**Reading**: This is a **structural advisory about a known unimplemented
capability** (staging-resolver), not a runtime anomaly. A prompt-native
skeptical-historian should EITHER:
  (a) note this once and stop repeating it ("this is the expected baseline
      until staging-resolver ships"), OR
  (b) escalate only if growth rate exceeds X / week (not absolute count).

### 2.4 `multiview_pending` — 1-11 file fluctuation

7 runs flag `multiview_pending > 0` with message: "if this persists, the
writeApprovedToBrain replay gap is still costing recall." But that message
is **stale** — ADR 0025 §4.4.6 D was patched: `writeApprovedToBrain` stub
has already been replaced by `executeCuratorDecisionToBrain`. The advisory
text didn't follow the code.

Fluctuation 1 → 11 → 3 over 3 days shows replay IS recovering. Pure
mechanical "count > 0" warning does not distinguish "drain backlog
healthy churn" from "stuck queue".

---

## 3. Multi-view dead-loop frequency — REAL DATA refutes ADR §6 #2 priority

**The key finding contradicting the differential analysis P0 ordering:**

- `multi-view-metrics.jsonl`: 254 calls, `ok=true` × 254 (0% transient
  failure)
- `audit.jsonl`: 0 occurrences of `multiview_pass1_op_not_synthesizable`
  in 30-day window

ADR 0025 §6 sets the "advance P1.5 early" threshold at:
> dogfood 在 audit.jsonl grep `multiview_pass1_op_not_synthesizable` >5/week
> 时提前启动 P1.5

Real frequency: **0/week, 30 days running**. Per ADR 0024 §10:
> R5 至少给系统机会实现 vision … walkback 必须基于真实 dogfood 数据，
> 不是基于"想象中可能会"

**Decision**: P1.5 multi-view Pass 1 schema upgrade is **NOT P0**. Recommend
keeping the current Pass 1 schema and the 7-day skip-cache TTL; revisit
only if frequency rises above the 5/week threshold.

---

## 4. Classifier health (sample size 46/50 from latest run)

| Dimension | Rate | Threshold | Status |
|---|---|---|---|
| `quoteRate` (verbatim quote inclusion) | 1.00 | 0.40 | ✓ |
| `alternativeRate` (genuine alternative consideration) | 1.00 | 0.40 | ✓ |
| `concreteSelfCritiqueRate` (anchored not boilerplate) | 1.00 | 0.40 | ✓ |

**Reading**: classifier prompt v1 is performing at 100% across all three
ADR §4.3.3 quality dimensions. No 7-day moving-average trend detection
implemented (ADR §4.3.3 "trend" rule absent in `health.ts`).

---

## 5. Per-turn cost burn — multi-view dominates

Latest run (`kihh/full`):

- Top 2 turn cost: 256K and 256K tokens, both with operations
  `{extractor: 2-3, curator: 4-5, multi_view: 8}`. multi-view is the
  dominant cost driver (ADR 0024 §6 #7 doubled-call cost — actively in
  effect at expected magnitude).
- Aggregate: 995K estimated tokens across 9 turns considered.
- 3148 audit rows had no per-turn attribution (anchor missing or pre-C6
  rows).

No advisory currently exists for "per-turn cost outlier" — `per_turn_cost`
data is collected but `aggregator.ts` does not emit a cost advisory.

---

## 6. What Phase B (prompt drafting) must address

Concrete asks the prompt-native skeptical-historian (`v1`) must do, derived
from §2-§5 above:

1. **Distinguish maxim/anti-pattern "framing retrieval" from genuine
   memory-of-decision retrieval.** retrieved-unused on a maxim is HEALTHY
   ("it shaped reasoning without being cited"); retrieved-unused on a
   narrow-scope fact is a CANDIDATE FOR ARCHIVE.
2. **Distinguish "active-application streak" from echo chamber.** A spec
   currently being implemented will trip decisive-streak ≥ 20 — that's
   the spec being applied, not the brain self-reinforcing.
3. **Acknowledge structural advisories about known unimplemented
   capabilities** (staging-resolver, archive-reactivation reviewer) and
   stop re-flagging them every run. Convert "every-run repeat warning"
   into "one-line acknowledgment unless growth rate exceeds X / week".
4. **Re-read advisory message text** — e.g. the `multiview_pending` message
   still references the patched-out `writeApprovedToBrain` stub. The
   skeptical-historian should detect this kind of stale text.
5. **Apply ADR §5.3 "no candidate is success" framing.** Most aggregator
   runs across a single user / single repo SHOULD produce empty advisory
   lists. The current v0.2 mechanical version emits 5+ advisories per run
   reliably (40 total / 8 runs = avg 5).
6. **Falsifiability requirement on any hypothesis** ("which observation in
   the next 2 weeks would falsify this?").
7. **Sycophancy self-check** ("would I still raise this if no one praised
   me for finding patterns?").
8. **Trend detection** — add 7-day moving average comparison for
   `classifier_health` three dimensions (ADR §4.3.3 partial — current
   `health.ts` is static threshold only).

---

## 7. AI-Native (ADR 0024 §3) compliance checklist for Phase B/C design

Per ADR §3.3 PE / Infra / Mech-on-LLM tri-state, Phase B/C design will be:

| Component | Layer | Justification |
|---|---|---|
| v0.2 deterministic data gathering (audit / outcome / staging / search-metrics scan) | Infra | File I/O + JSON parse — already infra |
| v0.2 mechanical thresholds (HIGH_UNUSED_THRESHOLD=3, STAGING_CRITICAL=50, etc.) | **REMOVED as warning emitter, KEPT as raw signal feed to LLM** | The mechanical numbers become input data to LLM, not the gate emitting warnings |
| v1 LLM skeptical-historian pass | PE | All advisory emission goes through LLM reasoning (skeptical historian + falsifiability + sycophancy check); LLM may choose to emit zero advisories — that's success |
| Audit row schema for v1 advisory output | Infra | structured `{reasoning_trace, candidate_hypothesis, falsifier_observation, advice}` for downstream consumers |
| Kill switch / fallback when LLM call fails | Infra | If v1 LLM call throws / times-out → fall back to v0.2 mechanical advisories with `degraded_to_mechanical: true` marker. Does NOT silently drop signal. |

No mechanical accuracy threshold gates. No fixture-based ship-block. No
TTL state machine. No schema-enforced advisory shape. All compliant with
ADR 0024 §3.

---

## 8. Phase B prompt skeleton (draft direction, NOT final)

To be expanded in Phase B with two cross-provider draft variants per
ADR §7 multi-view norm (Claude + GPT, e.g.):

```
You are a skeptical historian reviewing the second brain's behavior
over the last <window>. You are NOT rewarded for finding hypotheses.
Most runs SHOULD produce no candidate hypothesis. "No candidate, no
action — timeline within normal variance" is a SUCCESSFUL run.

Data feed (deterministic, do not re-derive):
  - mechanical advisories from v0.2 pass: <list>
  - audit summary: <operations, skip_reasons, error_count>
  - outcome ledger: <high_unused entries with kind/scope, decisive_streak
                     entries, slugs_seen>
  - staging: <provisional + multiview-pending counts, oldest age>
  - classifier_health: <three rates + sample size>
  - per_turn_cost: <top burners, multi-view % of cost>
  - context: <"this is a single-user repo where the user IS the author;
              feedback loop is tight">

For EACH mechanical advisory presented above, before propagating it:

  (1) Reasons NOT to propagate this advisory:
      - Is this a maxim/anti-pattern where retrieved-unused is healthy
        (framing retrieval, not cited)?
      - Is this an actively-applied spec where decisive-streak reflects
        implementation work, not echo chamber?
      - Is this a structural advisory about a known unimplemented
        capability (staging-resolver, archive-reactivation) that has
        been flagged in previous runs already?
      - Is the advisory message text stale (refers to a code path that
        has since been patched)?

  (2) Falsifiability: name ONE specific observation in the next 2 weeks
      that would prove this advisory wrong. If none, discard.

  (3) Sycophancy self-check: would I still raise this if nobody praised
      me for finding patterns? Would I still raise this if I knew the
      user was tired of seeing the same advisory every run?

For NEW patterns not covered by mechanical advisories:
  (1) Same three checks above.

Output strict JSON:
{
  "promoted_advisories": [...],   // mechanical advisories LLM endorses
  "demoted_advisories": [...],    // mechanical advisories LLM rejects + 1-sentence reason
  "new_hypotheses": [...],        // LLM-noticed patterns not in mechanical
  "trend_observations": [...],    // classifier_health 7-day delta if data exists
  "reasoning_quality_self_check": {
    "would_propose_if_no_praise": true|false,
    "falsifiers_named_count": N
  }
}
```

(Phase B will refine this; Phase C wires it; Phase D regression-tests
against the 8 historical aggregator runs collected here.)

---

## 9. Open question for reviewers

1. Should v1 also produce a "**stop flagging this**" persistent suppression
   list? E.g. the `staging_backlog` advisory is now structurally expected
   until staging-resolver ships — should LLM be allowed to mark
   `kind="staging_backlog"` as "acknowledged, do not re-flag for 30 days"?
   This is borderline mechanical (TTL) but stored OUTSIDE LLM behavior
   layer (as a hint to next LLM call, not a gate).

2. Should v1 read previous aggregator-ledger rows (the 8 prior runs) so
   that "I already flagged this 3 times, user has not acted, escalate or
   demote?" reasoning becomes possible? This adds context but raises
   cross-run drift risk.

3. multi-view P1.5 was deprioritized based on real 0/week frequency. Does
   any reviewer disagree based on different signal?

---

## 10. Reviewer consensus (2026-05-28, 3 × T0 cross-provider Blind Pass)

Reviewers: Claude Opus 4-7 · OpenAI GPT-5.5 · DeepSeek v4-pro.
Protocol: ADR 0024 §5.4 multi-view, Blind Pass independent verdicts.

| Reviewer | Verdict | P0 | P1 count |
|---|---|---|---|
| Opus 4-7 | APPROVE-with-P1 | none | 5 |
| GPT-5.5 | APPROVE-with-P1 | none | 5 |
| DeepSeek v4-pro | PASS-with-conditions | none | 3 gaps |

**No P0**. All three reviewers agree Phase A baseline is sound:
baseline + design intent identifies the v0.2 false-positive shape
correctly, the proposed direction (mechanical thresholds → LLM input
signal) is the right AI-Native refactor, and the dossier respects
INV-INVISIBILITY by limiting outputs to audit/ledger sidecar.

### 10.1 Consensus P1 (must be addressed in Phase B prompt drafting)

| # | Consensus | Strength | Authoritative sources |
|---|---|---|---|
| C1 | Rename `mechanical advisories` → `mechanical_suspicion_signals` / raw signal feed; prompt MUST permit LLM to discard mechanical signals wholesale (not just per-item promote/demote). LLM is independent skeptical historian, NOT the appellate court for v0.2 thresholds. | 3/3 | Opus (implicit P1-1) · DeepSeek Gap-1 · GPT-5.5 P1-1 |
| C2 | LLM call failure → fallback writes ONLY to audit/ledger with `degraded_to_mechanical: true`. MUST NOT surface fallback v0.2 warnings as user-facing notifications or feed them into the writer/curator decision path. (This is the boundary between Infra fallback and Mech-on-LLM regression.) | 3/3 | Opus P1-3 + P1-4 · GPT-5.5 P1-2 · DeepSeek (implied via Q5) |
| C3 | v1 MUST read prior aggregator-ledger rows (8–8 most recent) as compact summary. Prompt MUST explicitly authorize LLM to disagree with past runs ("predecessors were working with less data"). Enables structural advisory de-duplication (e.g. recurring `staging_backlog`). | 3/3 | All three on Q-b |
| C4 | P1.5 multi-view-pass1 schema upgrade deprioritization is correct, but tracked as `watchdog P1.5` (not removed). Telemetry watchpoints: `multiview_pass1_op_not_synthesizable >5/week`, `candidate_lost` growth, replay queue age/retry, cross-project distribution, Pass 1 op type breakdown. | 3/3 | All three on Q4 |
| C5 | Outcome-ledger DECISIVE/CONFIRMATORY counterfactual quotes MUST be in v1 LLM context. Without them, distinguishing "actively-applied spec streak" (= work in progress) from "echo chamber" (= self-reinforcing loop) is impossible at the slug+streak level alone. | 2/3 | Opus P1-5 · DeepSeek Gap-2 |
| C6 | Resolve current dossier internal contradiction: §8 prompt skeleton says "Output strict JSON" but §7 says "No schema-enforced advisory shape". Phase B MUST split: JSON envelope = Infra serialization (allowed), schema-as-validator-gating-LLM-output = Mech-on-LLM (forbidden). Parse failure → audit-only fallback, NEVER "reject and retry LLM". | 2/3 | GPT-5.5 P1-4 · DeepSeek Q5 + Q6 |
| C7 | Add reverse anchor against RLHF skeptical-bias swap. "No candidate = success" framing protects against helpful-emission bias but can swap to skeptical-suppression bias. Prompt MUST include: "if you silence a real signal because silence feels safer, you are doing the opposite failure mode — name it." | 2/3 | Opus P1-1 · GPT-5.5 (implicit P1-3 framing) |
| C8 | Advisory presentation layer MUST satisfy INV-INVISIBILITY: audit-only + footer `info` is fine; user push notification with "please review" / "please archive" / "[Y/N]" is the reverse-direction reversion that ADR 0024 §2 forbids. Phase B C wiring spec MUST write this out explicitly so downstream PRs don't drift. | 1/3 explicit | GPT-5.5 P1-3 |
| C9 | Add `raw_distribution_summary` to v1 LLM input alongside the threshold-hit list (so LLM sees the 92 non-flagged entries' aggregate, not only the 8 flagged). Otherwise threshold acts as invisible attention filter — Infra-with-caveat, not pure Infra. | 1/3 explicit | DeepSeek Gap-1 (Q5 method-B variant) |

### 10.2 Open Q answers — reviewer consensus

- **Q (a) Suppression list?** All three: **YES, but prompt-decided (not TTL).** LLM-readable hint (`previous acknowledgments`), not external 30-day TTL store. Each run re-evaluates. Prompt explicitly invites override.
- **Q (b) Read prior 8 ledger rows?** All three: **YES**, compact summary, explicit "disagree with past runs" license.
- **Q (c) P1.5 deprioritization?** All three: **YES, with watchdog telemetry** (per C4).

### 10.3 Cost of this Phase A review

3 reviewers × 1 round, parallel dispatch:
- Opus 4-7: 215.8s, $0.33
- GPT-5.5: 130.5s (rerun post-F1 fix), $0.23
- DeepSeek v4-pro: 275.5s, $0.02
- DeepSeek v4-flash (liveness probe for F1 fix): 8.9s, $0.0005

Total: ~$0.58 / ~10 min wall clock.

F1 fix in commit `041f47f` (model-fallback Handler A regression
+ dispatch classifyError) restored sub-agent retry; the GPT-5.5
rerun (130s success vs prior 145s `agent_error` with empty
retryHistory) is real-world confirmation that ADR 0024 §5.4
three-T0 protocol now works as designed.

---

## 11. Phase B entry plan (P1 → prompt drafting checklist)

Phase B will produce two artifacts:

1. `extensions/sediment/prompts/aggregator-skeptical-historian-v1.md`
2. Bumped `settings.ts` `promptVersion.aggregator: v0.2 → v1` + semantic note

The prompt MUST address all 9 consensus P1 (C1–C9). Phase B exit
criteria: 3-T0 review of the v1 prompt text returns no P0 and no
additional P1 beyond the C1–C9 already accounted for.

Phase C (wiring `aggregator.ts` to call v1 LLM with full input feed)
follows Phase B; Phase D (regression dossier on the 8 historical
aggregator runs collected in §1) closes the iteration.

Phase B is being entered with this commit; the dossier itself ships
as baseline (no code changes pending in Phase A).

