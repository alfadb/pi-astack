# ADR 0024-0027 Implementation Review R2 — R5 (multi-round)

**Date**: 2026-05-27 (same day as R1)
**Scope**: post-R1 batch (commits `a11f3be..72fb2e0`) — 11 commits, 4 review rounds
**Reviewers each round**: 3 LLMs from different providers (Opus 4-7, GPT-5.5, DeepSeek v4-pro)
**Total cost**: ~$2.10 across all rounds
**Outcome**: **R5 unanimous BASELINE GREEN**

## TL;DR

After R1 found 3 P0 + 12 P1, the implementation batch addressed all P0 +
P1-1..P1-8. Each iteration was reviewed by 3 LLMs from different providers,
and each successive review surfaced PROGRESSIVELY DEEPER issues that the
prior fixes had introduced or uncovered:

  - **R1 → R2**: found 2 new P1 (classifier path bypass + ADR schema drift)
  - **R2 → R3**: found subturn-not-propagated to sub-agent + anchorMissing discarded
  - **R3 → R4**: found jiti `moduleCache:false` breaks ALL cross-extension
    state sharing (CRITICAL — all earlier "fixes" were partially cosmetic)
  - **R4 → R5**: globalThis singleton fix verified, BASELINE GREEN

The progression demonstrates the value of multi-round multi-LLM review:
each pass found deeper architectural issues that single-pass review would
have missed.

---

## Round-by-round summary

### R2 (3-LLM review of R1 batch)

**Findings**: 2 NEW-P1

  - **NEW-P1-A** (GPT-5.5 found, DeepSeek concurred): `context-packer.ts`
    bypasses P0-α mask. P0-α (commit `a11f3be`) masks
    dispatch_agent/dispatch_parallel toolResult content at the SINGLE
    chokepoint `entryToText()` in checkpoint.ts. But sediment's
    correction-pipeline classifier uses `packClassifierWindow()` in
    `context-packer.ts` which independently renders toolResult via
    `extractTextContent(msg.content)` — completely bypassing the mask.
    Sub-agent reasoning still reaches the active-correction classifier
    prompt. INV-IMPLICIT-GROUND-TRUTH violation on the classifier path.

  - **NEW-P1-B** (Opus + GPT-5.5 both found): `memory/decide.ts:295` still
    generates `decision-brief-${timestamp}-${random}` opaque IDs, but
    ADR 0026 §5.1 (added in commit `234a824`, R1 P1-7) specifies
    `decision_brief_id = ${session_id}|${turn_id}[.${subturn}]|${seq}`.
    The same batch that DEFINED the schema introduced an ADR-vs-code
    drift in its own implementation.

**Fix**: commit `ac592cd`
  - Export `L2_FANOUT_TOOL_NAMES` + `L2_WITHHELD_MARKER` from checkpoint.ts
  - context-packer.ts applies same mask
  - decide.ts gains `buildDecisionBriefId()` helper with anchor-based format
    + per-(session,turn) seq counter + fallback when anchor missing

### R3 (3-LLM review of R2 batch)

**Findings**: 2 issues — split P1/P2 between reviewers

  - **Sub-agent anchor scope** (Opus marked P2, GPT-5.5 marked P1):
    `buildDecisionBriefId()` reads `getCurrentAnchor()` which returns the
    main anchor without subturn when called from sub-agent runtime.
    dispatch only INJECTS subAnchor into prompt + audit row, never
    EXPOSES it to sub-agent's runtime causal-anchor state.

  - **anchorMissing propagation** (GPT-5.5): `buildDecisionBriefId()`
    computes `anchorMissing: true/false` but `runMemoryDecide()` discards
    it. Callers can't detect when the ADR §5.1 attribution join is broken.

Per "no P1" stopping criterion, treated as P1 (consensus on substance,
disagreement only on priority).

**Fix**: commit `f0098d9`
  - Wrap `runInProcess(...)` in both dispatch_agent and dispatch_parallel
    task paths with `runWithTriggerAnchor(subAnchor, () => ...)`
  - Add `anchorMissing` to MemoryDecideResult; propagate through all 9
    return paths; surface in tool _meta both success and error

### R4 (3-LLM review of R3 batch) — CRITICAL

**Findings**: ⚠️ MASSIVE — NEW-P0 confirmed empirically

GPT-5.5 challenged the assumption that R3's `runWithTriggerAnchor` actually
works across pi's extension loader topology:

  pi loader: `core/extensions/loader.js:265`
  ```
  createJiti(import.meta.url, { moduleCache: false })
  ```

GPT-5.5 hypothesized: `moduleCache: false` disables not just jiti's entry
cache but ALSO nested-import cache. Each extension's `loadExtensionModule()`
call creates a fresh jiti, and each fresh jiti re-evaluates ALL imports —
including `_shared/causal-anchor.ts` and `_shared/pi-internals.ts`.

If true, ALL cross-extension contracts are silently broken.

**Empirical verification** (this assistant ran probe):
```javascript
const jitiA = createJiti(..., { moduleCache: false });
const jitiB = createJiti(..., { moduleCache: false });
const caA = await jitiA.import(".../causal-anchor.ts");
const caB = await jitiB.import(".../causal-anchor.ts");

caA._setCurrentAnchorForTests("s", 7);
caB.getCurrentAnchor()  // → undefined  ← state NOT shared

await caA.runWithTriggerAnchor({turn_id: 99}, async () => {
  caB.getCurrentAnchor()  // → undefined  ← ALS NOT shared
});

piA.markSessionAsSubAgent(sm);
piB.isSubAgentSession({sessionManager: sm})  // → false  ← WeakSet NOT shared
```

**GPT-5.5 was empirically correct.** This silently broke:

  1. **PR-B WeakSet sub-agent marker** — dispatch marks SM in its own
     pi-internals instance; sediment / model-fallback / etc. read THEIR
     pi-internals instance's empty WeakSet → `isSubAgentSession` always
     returns false → sub-agent handlers fire as if main session.

     Why sediment didn't explode: orthogonal `if (!sessionId) return`
     ephemeral-session check (sub-agent uses `SessionManager.inMemory()`).
     But OTHER handlers (compaction-tuner, model-fallback, model-curator,
     persistent-input-history, abrain rule-injector) had no orthogonal
     guard and were silently firing in sub-agent contexts.

  2. **R3 sub-agent anchor scope** — dispatch's ALS set on dispatch's
     causal-anchor instance; memory's `getCurrentAnchor()` reads memory's
     DIFFERENT causal-anchor instance → empty ALS → fallback to live
     state → memory's instance never had bindLifecycle called → undefined
     → decision_brief_id falls back to legacy opaque format. R3 fix was
     **cosmetically applied but functionally inert in production.**

  3. **P1-3 memory/llm-search anchor retrofit** — memory's causal-anchor
     instance has uninitialized live state → spreadAnchor() returns {} →
     search-metrics rows write WITHOUT anchor. C6 join from memory metrics
     to dispatch audit broken.

  4. **P1-1 boundary sentinel** — main pi's dispatch sets
     `_activatingInSharedLoader = true`; shared loader's DIFFERENT
     dispatch instance reads its own flag (false) → sentinel never installs.

R4 vote split:
  - Opus: BASELINE GREEN (assumed module cache shared)
  - DeepSeek: BASELINE GREEN (assumed module cache shared)
  - **GPT-5.5: NOT GREEN** (correctly hypothesized loader isolation)

**Fix**: commit `72fb2e0` — globalThis singleton refactor
  - All shared state moved to `globalThis[Symbol.for("pi-astack/<module>/<scope>/v1")]`
  - causal-anchor: 4 module vars → CausalAnchorState singleton
  - pi-internals: WeakSet + boundary probe → SubAgentState singleton
  - dispatch: `_activatingInSharedLoader` → globalThis flag
  - empirical re-probe: all 3 failure modes now PASS

### R5 (3-LLM review of R4 batch)

**Unanimous BASELINE GREEN** (3/3):

  - Opus: RESOLVED, all 4 hotspots correctly globalThis-singleton'd
  - GPT-5.5 (original raiser): RESOLVED — "R4 NEW-P0 cross-jiti state
    isolation 根因已修，未看到本次 globalThis singleton 改动引入新的 P0/P1"
  - DeepSeek: RESOLVED, all 7 smoke checks pin invariants

No new P0/P1 (outside R1 deferred items: P0-γ/C5 and P1-9..12).

## Commit chain

```
e9eab55 docs(audit): R1 review
a11f3be fix(sediment): P0-α sub-agent toolResult mask
99515c8 fix(causal-anchor): P0-β trigger-time anchor snapshot via ALS
cd483d2 feat(pi-internals): P1-1 sub-agent boundary sentinel
7dd224b fix(causal-anchor): P1-3 retrofit 4 missing JSONL writers
6de2426 feat(memory,dispatch): P1-2 memory Route A' synthesis
234a824 docs(adr): P1-4/5/6/7 doc clarifications
4743fb0 feat(causal-anchor): P1-8 device_id
─── R2 ───
ac592cd fix(sediment,memory): R2 NEW-P1-A + NEW-P1-B
─── R3 ───
f0098d9 fix(dispatch,memory): R3 NEW-P1-B follow-up
─── R4 ───
72fb2e0 fix(_shared): 🚨 R4 NEW-P0 — globalThis singleton (CRITICAL)
─── R5 ─── BASELINE GREEN
```

## Key lessons

1. **Multi-round multi-provider review is high-value**. Each round found
   deeper architectural issues. Single-pass review would have missed R4's
   jiti loader topology issue.

2. **Empirical verification beats theory**. Two reviewers (Opus + DeepSeek)
   assumed Node module cache is process-wide for jiti. GPT-5.5 read pi's
   loader source and challenged the assumption. Direct probe with two
   `createJiti(moduleCache: false)` instances proved GPT-5.5 right within
   1 second.

3. **Silent failures need orthogonal guards**. PR-B's WeakSet was broken
   for months but PR-B's intent was preserved by sediment's separate
   ephemeral-session early-return. Without that orthogonal guard, sediment
   would have been polluted invisibly.

4. **globalThis + Symbol.for is the right tool for cross-extension state**
   in pi-astack's jiti-isolated loader model. Versioned keys (`/v1`) allow
   future schema migration.

5. **Smoke tests must reflect production topology**. Earlier smoke tests
   loaded modules ONCE (single ts.transpileModule + loadCJS) which can't
   surface multi-jiti-instance issues. `smoke-jiti-singleton.mjs` was
   added specifically to probe the production topology.

## What's left (explicitly deferred from R1)

  - **P0-γ / C5 v1** (terminal_state + heartbeat for L2 production) —
    blocking L2 mutating production. Currently L2 is read-only by
    `PI_MULTI_AGENT_ALLOW_MUTATING` env gate. ~1 week engineering.
  - **P1-9** multi-view Pass1 dead-loop cost ($0.10-0.50/wk wasted)
  - **P1-10** decision brief Path A TTFT 3-5s latency
  - **P1-11** staging provisional resolve trigger
  - **P1-12** per-turn cost attribution (prerequisite for P1-9 ROI measurement)

## Cost summary

| Round | Models | Wall-clock | Cost |
|---|---|---|---|
| R1 | 3× opus / gpt-5.5 / deepseek-v4-pro (high thinking) | 13 min | $0.79 |
| R2 | 3× same | 11 min | $0.69 |
| R3 | 3× same | 5 min | $0.45 |
| R4 | 3× same | 5 min | $0.65 |
| R5 | 3× same | 2 min | $0.38 |
| **Total** | | **~36 min** | **~$3.00** |

For comparison: 11 commits + 8 new smokes (78+ checks total) shipped in
this session. R2-R5 cost-per-finding was minimal vs the silent-failure
cost of any of these issues reaching production. R4's globalThis singleton
finding alone would have caused months of brain pollution before manual
discovery.

## Refs

- R1 audit: `docs/audits/2026-05-27-adr-0024-0027-implementation-r1.md`
- ADR 0024 invariants (INV-INVISIBILITY / INV-IMPLICIT-GROUND-TRUTH / etc.)
- ADR 0027 §C6 cross-layer causal anchor
- ADR 0027 PR-B sub-agent extension visibility
- jiti `moduleCache: false` behavior (pi loader.js:265)
