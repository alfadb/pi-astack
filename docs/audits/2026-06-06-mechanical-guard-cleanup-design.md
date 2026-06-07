# Mechanical-Guard Cleanup — Implementation Design Spec (for 3×T0 consensus)

Date: 2026-06-06. Basis: ADR 0024 §3 (AI-Native). Prior audit: 3×T0 sweep
classified 19 catalogued + ~5 discovered guards. This doc is the
**implementation design** for the items judged FIX. It must reach **unanimous
3×T0 consensus** before any code is edited. After implementation + smoke, a
fresh 3×T0 blind audit runs on the diff.

Repo: `/home/worker/.pi/agent/skills/pi-astack`.

## Verified grounding (read before judging)
- `writer.ts` mutation ops compute `entryRoot = scope==="world" ? abrainHome : projectRoot` (L898/1032/1244). **scope determines which store is searched**; a wrong scope on an existing neighbor → `findProjectEntryFile` miss → `entry_not_found`. (Confirms G2/G3 auto-correct is safe + necessary.)
- `multi-view.ts:174` already triggers multi-LLM review on `scope:"world"` creates (`create_world_scope`). (Confirms removing G1 keeps a review backstop.)
- `rule-injector` reads `~/.abrain/[projects/<id>/]rules/{always,listed}/` which are **currently all empty** (rules write-path never shipped). ⇒ G18/G16/G17 are **dormant** — forward-looking fixes, not active data loss.
- `enforceBudget()` (rule-injector) only pushes a `warning`; **no truncation/drop**. The cap is not a learning ceiling.

---

## P0 — Curator scope gates (ACTIVE data loss) — `extensions/sediment/curator.ts`

### Fix A1 — G1 `world_create_from_non_world_source` (create branch, ~L413-438)
**Current**: in the `op==="create"` derives_from loop, after the (legit)
`invented_neighbor_slug` existence check, a second check throws
`world_create_from_non_world_source` when `scope==="world"` and any
`derives_from` neighbor is project/workflow scope → converted to op=skip →
candidate dropped, no retry.

**Proposed**: DELETE the `if (scope === "world") { srcScope !== "world" → throw }`
block. KEEP the `if (!allowedSlugs.has(src)) throw invented_neighbor_slug`
existence check. A world create may carry a project/workflow slug in
`derives_from` — that edge is honest provenance ("this cross-project rule was
first observed in project X"), not a context leak; the entry body's generality
is the curator's job (prompt-owned), and `multi-view.ts:174` already escalates
every world create to multi-LLM review.

**Open fork F1**: keep the project `derives_from` edge as-is (proposed) **vs**
strip cross-scope edges from the persisted entry while preserving them in prose.
Recommended: **keep as-is** (provenance is valuable; stripping is itself a
mechanical edit of LLM output).

### Fix A2 — G2/G3 `scope_mismatch_*` (validateScope, L283-303)
**Current**: for non-create ops (update/merge/archive/supersede/delete) on an
EXISTING neighbor, `validateScope` throws `scope_mismatch_world_on_non_world_neighbor`
(curator declared scope:world but neighbor is project) or
`scope_mismatch_project_on_world_neighbor` (curator omitted scope but neighbor
is world) → candidate dropped.

**Proposed**: REPLACE both throws with **auto-correct**. We already hold the
neighbor's true scope in `neighborScopes.get(slug)`. For an existing-neighbor
op the physical store is ground truth, so the effective scope MUST be the
neighbor's actual scope regardless of what the curator declared. Mechanism:
compute `effectiveScope = neighborScopes.get(slug)` and thread it into the
op's returned `scope` field, overriding the curator-declared `scope`. This both
removes the silent drop AND guarantees the writer finds the file (strictly
better than trusting a wrong declaration → entry_not_found).
KEEP the `neighborScope === "workflow"` → `workflow_lane_read_only` throw (G6:
workflow entries are genuinely unwritable by this path; the writer skips
`workflows/`). KEEP `invented_neighbor_slug` (G4).

**Open fork F2**: `validateScope` currently returns `void` and the op returns
use the module-level `const scope`. Auto-correct requires returning the
resolved scope per-slug. For merge (multiple sources of potentially mixed
scope) the resolved scope is ambiguous — proposed: merge requires ALL
sources+target share one scope (else this is a genuine malformed op →
`malformed_curator_op`), and effectiveScope = that shared scope. Confirm this
is acceptable.

---

## P1 — Multiview staging replay hard-delete (ACTIVE deletion) — `extensions/sediment/multiview-staging-replay.ts`

### Fix B1 — terminal mechanical delete → preserve (converge to G15)
**Current**: `STALE_DAYS_MULTIVIEW_PENDING=14` (age≥14d) and
`retryCapForState` (retry_attempts≥cap) trigger `deleteOriginalOrAudit` →
`deleteMultiviewPending(slug)` → **hard delete** of a candidate the LLM already
extracted but multi-view couldn't synthesize (pass-1/pass-2 disagreement).
Also: `trigger_disappeared_on_replay` (:597) and `pass1_not_synthesizable`
(:1075) drop candidates.

**Proposed (panel to choose mechanism)**:
- **Option B1-soft**: replace hard delete with **soft-archive** — move the
  pending entry to a dead-letter dir (e.g. `staging/multiview-abandoned/`),
  git-ignored, never unlinked. Preserves the candidate for inspection; bounds
  the live staging dir. Minimal change, no new LLM machinery.
- **Option B1-reviewer**: route age/retry-terminal candidates through the
  EXISTING G15 `staging-ageout` prompt-driven reviewer (or a sibling reviewer)
  so an LLM makes the final keep/archive/promote call. Heaviest; fully
  G15-aligned but adds a model call to the replay loop.
- **Option B1-keep-cap-no-delete**: keep age/retry as a *stop-retrying* signal
  (stop spending compute) but mark terminal entries `status: abandoned` in
  place rather than delete. No new dir, no new model call.

**Recommended**: **B1-soft** (or B1-keep-cap-no-delete) for this pass —
preserves data, no new LLM machinery, matches G15's "age is a trigger not a
decision, soft-archive never unlink." B1-reviewer is a larger follow-up.

**Open fork F3**: which option. Also: is 14d/retry-cap acceptable as a
*stop-spending-compute* trigger (vs the AI-Native objection being only to the
*delete*, not to bounding retries)? Recommended framing: bounding retries is
legit compute-budget infra; the *delete* is the violation.

---

## P2 — Dormant / non-destructive

### Fix C1 — G18 rule-injector confidence floor (`extensions/abrain/rule-injector/index.ts:232`)
**Current**: `if (confidence < (tier==="always"?8:7)) return {}` — silently
excludes the rule from injection based on a hard confidence number (the
confidence the curator-LLM itself assigned).

**Proposed**: REMOVE the hard floor. Inject ALL active rules WITH a confidence
framing label so the reading LLM weighs them: e.g. always-tier
`[${kind} · confidence ${confidence}/10] ${body}` and for confidence<8 append
` (provisional — verify before relying)`. Tier placement (always vs listed)
remains the curator's importance signal; the reading LLM owns the weighting.

**Open fork F4**: (a) remove floor entirely (proposed) vs keep a *minimal*
floor (e.g. drop confidence≤2 pure-noise) to bound always-tier prompt cost;
(b) exact label format. Note this path is DORMANT (rules dirs empty) so cost is
hypothetical until ADR 0023 write-path ships. Recommended: remove floor, add
label, no minimal floor (revisit when write-path lands + real volume exists).

### Fix C2 — about-me-router 0.6 threshold (`extensions/sediment/about-me-router.ts:50/141`)
**Current**: `ROUTING_CONFIDENCE_THRESHOLD=0.6`; routing_confidence<0.6 →
hard route to staging (validateRouteDecision Rule 3 throw, or
applyStagingDowngrade non-destructive rewrite).

**Proposed (panel to choose)**: this is **non-destructive** (routes uncertain
identity facts to staging, not deletion) and is the *future* G3 classifier's
path. Options: (a) leave as-is this pass (triage-to-staging is defensible, not
a data-loss gate) and only document it; (b) prompt-drive — teach the router
LLM "if unsure, choose staging yourself" and drop the mechanical 0.6 override.
**Recommended**: (a) defer — lowest urgency, non-destructive, and the LLM
classifier that would consume it isn't built yet. Document, don't change.

---

## P3 — Cosmetic

### Fix D1 — G16/G17 misleading `enforceBudget` warning
**Current**: emits `over count/token cap; injected in full` warning with zero
behavioral effect (no drop). Misleading (implies a cap that doesn't exist) and
inconsistent with the now-known-stale memory claiming a learning ceiling.

**Proposed (panel to choose)**: (a) delete the count/token warning entirely
(it's noise); (b) keep as advisory telemetry but rename function/strings to
make clear it is advisory-only. **Recommended**: (a) delete — dormant +
misleading; revisit budgeting prompt-natively if/when real rule volume exists.

---

## Smoke / test obligations
- `parseDecision` is exported "so smoke can pin the create-branch scope guard."
  Existing smoke almost certainly asserts G1/G2/G3 **fire**. Those assertions
  must be **inverted/updated**: assert world-create-with-project-derives now
  SUCCEEDS; assert scope-mismatch now AUTO-CORRECTS to neighbor scope; assert
  workflow-lane (G6) + invented-slug (G4) still reject.
- Cluster 3: update/replace any smoke asserting terminal **delete**.
- Run full sediment smoke after edits.

## Consensus request to the panel
For EACH fork F1-F4 + each Fix (A1/A2/B1/C1/C2/D1): respond
ACCEPT (as proposed) or AMEND (specify exact change). Implementation proceeds
ONLY on unanimous ACCEPT (forks resolved identically by all three). Flag any
fix that is unsafe, any missed dependency, and any smoke/test that will break.

---

# FINAL RECONCILED SPEC v2 (post Round 2 — fact-verified)

Round 1 settled (unanimous): A2-core auto-correct, F2, C2 (defer/document
about-me-router 0.6), D1 (delete enforceBudget warnings), C1-remove-floor + F4
(no minimal floor). Round 2 reconciled the three divergent items with verified
facts. This v2 is the binding implementation contract.

## R1 — curator world-create scope gate (A1+F1)
- DELETE the `world_create_from_non_world_source` throw block in the create
  branch (curator.ts ~L413-438). KEEP `invented_neighbor_slug` existence check.
- KEEP cross-scope `derives_from` edges as provenance, AUTO-QUALIFIED: project
  neighbor -> `project:<projectId>:slug`, workflow neighbor -> `workflow:slug`,
  world neighbor -> bare.
- INSERTION POINT: apply the qualification helper to `proposerDecision` BEFORE
  `runMultiView` stages it (curator.ts ~L959), so BOTH the direct-write path
  AND the staging-replay write path persist qualified edges (replay's
  writer would otherwise re-emit bare edges).
- projectId FALLBACK: `deps.projectId` is optional; if undefined, leave
  project-neighbor slugs bare (documented read-time fallback).
- PROMPT FIX: REWRITE curator.ts:757 — invert from "DO NOT set derives_from"
  to "DO set derives_from with the project/workflow precursor; the system
  qualifies it to a scoped provenance edge." Keep L751/L762.

## R2 — curator scope-mismatch auto-correct (A2 + supersede)
- REPLACE `scope_mismatch_world_on_non_world_neighbor` +
  `scope_mismatch_project_on_world_neighbor` throws with auto-correct:
  effectiveScope = `neighborScopes.get(slug)`, threaded into the returned
  decision's `scope` per non-create op (world neighbor -> emit `scope:"world"`;
  project -> omit/undefined).
- KEEP `workflow_lane_read_only` (G6) + `invented_neighbor_slug` (G4).
- merge: require all target+sources share ONE scope, else `malformed_curator_op`.
- supersede: `oldSlug` determines writer scope; if `newSlug` is cross-scope
  (project<->world) qualify the `superseded_by` edge (R1 helper). workflow
  `newSlug` stays REJECTED by the kept workflow check.

## R3 — multiview-staging-replay soft-archive (B1-soft, SEPARATE helper)
- INTRODUCE a separate `archiveTerminalOrAudit` helper: atomic `rename` of the
  multiview-pending file into a gitignored dead-letter SUBDIR (never unlink).
- USE it ONLY at the mechanical-drop sites: :481 (terminal_writer_max_retries),
  :498 (terminal_max_retries), :509 (terminal_stale), :595
  (trigger_disappeared_on_replay).
- KEEP `deleteOriginalOrAudit` (real delete) at the reviewer-disposition sites:
  :469 (approved skip), :665 (replay decided op=skip), and :448 cleanup_pending.
- PRINCIPLE: never delete a candidate that never received a real LLM
  disposition; budget/age/trigger-vanished kills -> soft-archive; reviewer-
  decided skip -> delete OK.
- OUT OF SCOPE: `multiview_pass1_op_not_synthesizable` (multi-view.ts:1075)
  never stages a file (no deleteMultiviewPending call) -> nothing to archive.
- BINDING: `loadMultiviewPending` + `loadStagingContext` + `countMultiviewPending`
  must skip the dead-letter subdir (isDirectory()/name guard); keep all
  `terminal_*` audit outcome strings; atomic rename; failed move leaves
  original intact; verify dead-letter parent (`.state/`) is gitignored.

## R4 — rule-injector confidence floor + label survival (C1)
- REMOVE the `if (confidence < (tier==="always"?8:7)) return {}` floor
  (index.ts:232). No minimal floor.
- FIX `formatAlways` (index.ts:379) + `formatListed` (:383) so the confidence
  label reaches injection for BOTH tiers: always-tier
  `- [<kind> | conf <n>/10] <body>` (+ ` (provisional - verify)` when n<8);
  listed-tier `- <scopedSlug> [conf <n>/10] - <hint>`.

## D1 — delete the two `enforceBudget` count/token warnings (index.ts:305/308).
## C2 — about-me-router 0.6: no code change; document as triage-to-staging.

## Smoke obligations
- smoke-memory-sediment.mjs: INVERT the `world_create_from_non_world_source`
  assertions (now parses, op=create, scope:world, qualified derives_from kept);
  INVERT both `scope_mismatch_*` assertions (now auto-corrects to neighbor
  scope); KEEP invented_neighbor_slug + workflow_lane_read_only batteries green.
- smoke-abrain-rule-injector.mjs: FLIP the low-confidence filter assertion
  (low-conf rule now injects with provisional label).
- NEW B1 assertion: at terminal budget/age, file is MOVED to dead-letter,
  still readable there, `loadMultiviewPending` no longer returns it, second
  replay does not re-pick it up.
- Run full sediment + rule-injector smoke after edits.
