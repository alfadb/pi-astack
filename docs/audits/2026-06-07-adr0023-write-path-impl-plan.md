# ADR 0023 R1 Write-Path — Implementation Plan v2 (post Round-1 consensus)

Date: 2026-06-07. v1 was too thin; 3×T0 Round-1 found real integration bugs +
dropped invariants. This v2 incorporates them + the verified INV-R facts. Needs
unanimous Round-2 ACCEPT before implementation; blind audit after.

Repo: /home/worker/.pi/agent/skills/pi-astack. ADR: docs/adr/0023-*.md.

## Verified facts that resolved Round-1 forks
- **INV-R3 (§533, R4 verbatim)**: "写入超 token cap → **writer reject + audit**;
  session_start 超 cap → 全量注入 + ui.notify warning". R4 simplified only the
  INJECTOR over-cap UX (no deterministic trim), NOT the writer reject. So the
  writer-side budget reject is a RETAINED invariant (opus correct on F-W1). It
  is an infra single-store consistency bound (reject + audit + suggest-archive =
  visible + recoverable, not a silent behavior-layer drop), distinct from the
  semantic gates this session removed.
- **INV-R4 (§534)**: kind limit is writer-enforced (§663 smoke covers it).
- **INV-R8/R9 (§538-539)**: ui.notify on promotion + lifecycle, "绝不静默修改".
- **ADR 0014 inv#7**: code already 8-zone (brain-layout BRAIN_ZONES); doc patch
  is the ship gate, must be same-PR.

## Already done (do not rebuild)
D1 layout (rules zone + tier dirs + ZONE_META) ; D3 read-path (rule-injector,
R4-cleaned this session) ; CAS.

## Scope: MVP write path. DEFER full G3-merge (about-me-router stays separate).

## Phase W0 — PREREQUISITE integration fixes (must land first; rules unsafe without)
- **W0.1 multi-view zone/tier carry-through.** `synthesizeFromPass1`
  (multi-view.ts ~654) + the confirm path must carry forward `zone`/`tier`
  from proposerDecision (extend the derives_from carry-forward already added
  this session). Else a rules create that hits `confirm_pass1` silently
  becomes a knowledge create. Add smoke.
- **W0.2 rules neighbor loading + scope isolation.** `relevantEntriesForCurator`
  (curator.ts ~550) must load rules entries with a `"rules"` neighbor lane so
  `parseDecision` allowedSlugs accepts rules lifecycle ops. `effectiveScopeFor`
  + `qualifyCrossScopeEdges` must be GATED on `zone !== "rules"` (rules use
  global/project, not world/workflow). Add neighbor-lane + scope tests.

## Phase W1 — D5 writers (create + lifecycle)
- `writeAbrainRule` (create) mirroring writeAbrainWorkflow/AboutMe substrate
  (sanitizer, lintMarkdown, atomic write+rename, git, `rules.lock`, appendAudit
  lane:"rules"). Paths global/project per ADR.
- **Lifecycle writers**: `updateAbrainRule` / `archiveAbrainRule` /
  `supersedeAbrainRule` / `mergeAbrainRule` / `deleteAbrainRule` (find+mutate in
  rules/<tier>/). Not just create.
- Frontmatter: id, scope, kind, status, confidence, tier, hint, body_hash,
  trigger_phrases, created/updated, routing_reason, **derives_from /
  promoted_from + source_body_hash** (F-W2 provenance link).
- Lints (writer-enforced, INV): **lintRuleKind** (INV-R4: always∈{maxim,
  preference,anti-pattern}; listed rejects {fact,smell}); **lintRuleAlwaysSize**
  (≤300 code units, always); **lintRuleBudget** (INV-R3: over-token-cap →
  REJECT + audit + suggest-archive); `sanitizeRuleHint` (D5.1) + hint fallback.
- **ui.notify on every write (INV-R8) + every lifecycle op (INV-R9)** — do NOT
  copy the workflow writer's no-notify behavior.
- Smoke `smoke:abrain-rule-writer` covers INV-R2/R3/R4/R5/R7/R8/R9.

## Phase W2 — D4 classifier (curator extension)
- Extend `CuratorDecision`: add a rules discriminant — `zone?: "rules"`,
  `tier?: "always"|"listed"`, **`ruleScope?: "global"|"project"`** (SEPARATE
  field — do NOT overload the entries `scope:"world"` field; avoids the
  qualifyCrossScopeEdges/multi-view `scope==="world"` collision).
- `parseDecision` must extract zone/tier/ruleScope and validate (tier+ruleScope
  required iff zone==="rules"). projectId for project rules comes from dispatch
  context (INV-R2), never the LLM payload.
- Curator prompt: D4.2 判定规则 + D4.3 trust-source guidance + promote/demote
  signals + **INV-R1 layer-3 clause** (assistant reciting a self-injected rule →
  op=skip).
- Dispatch (`curator-decision-writer.ts`): when `zone==="rules"` route to the
  rule writer matching op (create→writeAbrainRule, update→updateAbrainRule, …);
  entries ops unchanged. Rules decisions bypass effectiveScopeFor/qualify.

## Phase W3 — lifecycle (explicit only; periodic auto-demotion DEFERRED, F-W4)
Explicit classifier ops (archive/supersede/update/merge) handled by W1 writers +
W2 dispatch. G15-style periodic rules-ageout reviewer = follow-up.

## Phase W4 — fixtures + audit (D4.4): 30-50 fixtures incl. NEW cases:
multi-view confirm_pass1 preserves zone/tier; rules lifecycle op targeting (not
invented_neighbor_slug); budget-over-cap reject; knowledge→rules promotion
records derives_from+body_hash; bare-slug collision across zones. 3×T0 ≥85%.

## Phase W5 — ADR 0014 §7 doc patch + current-state.md (same PR, ship gate).

## Resolved forks (v2)
- F-W1: **writer budget REJECT** (INV-R3 retained). [changed from v1]
- F-W2: independent create + **derives_from/promoted_from + source_body_hash**
  provenance link to source knowledge slug; region-move deferred. [amended]
- F-W3: extend CuratorDecision with **clean rules discriminant + separate
  ruleScope field**; rules path bypasses world/project machinery. [amended]
- F-W4: defer periodic auto-demotion. [unchanged]
- F-W5: confidence = prompt rubric, not writer reject (INV-R4 is kind-only, no
  confidence INV). [unchanged]

## Scope reality
Not a small MVP: touches multi-view (just-refactored), curator neighbor-loading,
parseDecision, dispatch, 6 writer fns, fixtures, ADR patch. Multi-turn build.

## Round-2 result + v3 delta (opus root blocker, incorporated)
Round-2: gpt-5.5 + deepseek full ACCEPT; opus HOLD with one root blocker:
the rules discriminant only rides create/update/supersede; archive/merge/delete
carry only targetSlug → dispatch (switches on op, no zone signal) mis-routes them
to the entries writer → entry_not_found on the most common rules op (archive).

### v3 amendments (deterministic application of opus's prescribed fix)
- **Lifecycle routing keys on NEIGHBOR LANE, not `decision.zone`.** CREATE: zone/
  tier/ruleScope from the decision (no pre-existing neighbor). update / archive /
  supersede / merge / delete: the TARGET slug's neighbor lane (loaded by W0.2)
  determines rules-vs-entries routing + scope-machinery bypass. Mirror the
  existing workflow pattern (`isWorkflowNeighborEntry` / the workflow branch in
  `effectiveScopeFor`).
- **`effectiveScopeFor` gets an explicit `"rules"` neighbor branch** (returns the
  rule's global/project scope, bypasses world/project coercion) mirroring the
  workflow branch — so lifecycle ops on rule slugs neither throw nor mis-scope.
- **`executeCuratorDecisionToBrain` must receive the target neighbor lane**
  (or neighborScopes) so it can route lifecycle ops to the rule writers; today
  it only sees `decision.op`. Thread it from the curator call site.
- **W0.1 extends to the `synthesizeFromPass1` ARCHIVE branch** (multi-view ~725),
  which currently rebuilds scope from the neighbor → drops rules-ness + re-adds
  the scope:world collision. Carry zone/tier (or derive from neighbor lane).
- **N2**: the `"rules"` neighbor lane must OVERRIDE any `scope:"world"` tag
  loadEntries assigns to global rules (same override pattern as workflow).
- **N1 (P2)**: run `qualifyCrossScopeEdges` on the rules path too, so the
  cross-scope `derives_from`/`promoted_from` (knowledge→rules) is qualified, not
  a bare/dead edge. Referential-integrity infra, orthogonal to scope routing.

Standing ACCEPTs unchanged: W1, W4, W5, F-W1..F-W5 (all three), W0.1-create/
W0.2-load (gpt+deepseek). v3 only ADDS opus's neighbor-lane routing on top.

## Round-3 request
Confirm v3 resolves the lifecycle-routing root blocker. ACCEPT or HOLD+reason
per W0.1/W0.2/W1/W2/W3 (W4/W5/F-* already unanimous). Unanimous → implement,
starting with W0.1 (multi-view) + W0.2 (neighbor lane) as the prerequisites.

---

## 实现状态 (2026-06-07, R1 partial — CREATE 路径 ship)

本轮落地的是 ADR 0023 写路径的 **autonomous rule CREATE + 机制 lifecycle dispatch**,
经 3×T0 fixture 门禁验证。lifecycle 自治(classifier 看见现有 rules 当 neighbor)与
update/supersede/merge rule writers 为清晰 seam,延后。

### 已 ship(LSP 干净 + smoke 全绿 + 无回归)

| 阶段 | 文件 | 内容 |
|---|---|---|
| W1 writer 纯逻辑 | `extensions/sediment/rule-writer.ts` | RuleDraft、sanitizeRuleHint(D5.1)、lintRuleKind(INV-R4)、lintRuleAlwaysSize(300 CU)、buildRuleMarkdown(body_hash+provenance frontmatter)、ruleEntryId/ruleBodyHash |
| W1 writer 编排 | `extensions/sediment/writer.ts` | `writeAbrainRule`(create,镜像 writeAbrainWorkflow)、`archiveAbrainRule`、`deleteAbrainRule`、`findRuleFile`、`lintRuleBudget`(**INV-R3 REJECT**)、`acquireAbrainRuleLock`(rules.lock)、`rulesBaseDir`;`gitCommitAbrain` 加 label 参数 |
| W0.1 multi-view | `extensions/sediment/multi-view.ts` | `synthesizeFromPass1` create 分支透传 zone/tier/ruleScope(防 confirm_pass1 把 rules create 降级成 knowledge create) |
| W0.2 schema/parse | `extensions/sediment/curator.ts` | `CuratorDecision.create` 加 `zone?:"rules"`/`tier`/`ruleScope`(独立 ruleScope,不 overload scope:world);`parseDecision` create 分支提取 + 校验(zone:rules 缺 tier → reject) |
| W2 dispatch | `extensions/sediment/curator-decision-writer.ts` | rules create → `writeAbrainRule`;archive/delete 按 `findRuleFile` neighbor-lane 路由到 rule writers;WriteRuleResult → WriteProjectEntryResult 适配 |
| W2 classifier prompt | `extensions/sediment/curator.ts` | "Rules zone" 段:D4.2 always/listed rubric(消歧:cross-task universal = task-INDEPENDENT,项目级 rule 可 always)+ D4.3 trust-source(USER-EXPRESSED vs CONTENT-IN-TRANSCRIPT)+ lifecycle 信号 + INV-R1 层3(self-injected-rule reflux → skip) |
| INV-R8/R9 可见性 | `extensions/sediment/index.ts` | `deriveAutoWriteScope` 优先识别 rules/{always,listed},返回醒目 `rules:always/global` 标签(原先项目 rule 会伪装成 `project:<id>`,掩盖规则性);knowledge 写入行为不变 |

### W4 ship gate(3×T0:opus-4-8 / gpt-5.5 / deepseek-v4-pro,24 fixtures)

- **promote-vs-not 轴:24/24 = 100%**(≥85% 门禁)。所有 trust-source 陷阱
  (README "always Yarn"、sub-agent 输出、AGENTS.md 冗余、INV-R1 reflux、
  self-observed、一次性任务话、纯执行、诊断 fact)三模型全判 rules=false。
- **tier:消歧前 9/10,补 "cross-task = task-independent not project-independent"
  澄清后复测 F23/F02/F13 → 10/10 = 100%**。scope 10/10。lifecycle op
  (F06 archive / F15 update / F21 supersede)全对。
- fixtures: `docs/audits/2026-06-07-adr0023-classifier-fixtures.json`

### 测试

- `scripts/smoke-abrain-rule-writer.mjs`(纯逻辑 12 断言)
- `scripts/smoke-abrain-rule-writer-fs.mjs`(fs 编排 + e2e parseDecision→dispatch→落盘,12 断言)
- 回归绿:smoke-memory-sediment / multi-view-skip-cache / cas-guard / staging-resolver / rule-injector / archive-reactivation

### 清晰延后的 seam(非阻塞 CREATE)

1. **自治 lifecycle 的 neighbor 可见性(W0.2-neighbor)**:`loadEntries`→resolveStores
   只扫 knowledge 语料,不含 `rules/`。classifier 要自主 archive/update 现有 rule
   需把 rules 拉进 curator neighbor 集 + `neighborLaneFor` 加 "rules" lane +
   `effectiveScopeFor` rules 分支。这是跨切面改动(影响 memory 语料/dedup/scope),
   应单独设计。**dispatch 的 archive/delete-by-findRuleFile plumbing 已在且已测**,
   且 lifecycle 还有显式 `/rule` 命令通道(Lane G),非唯一退役路径。
2. **update/supersede/merge rule writers**:本轮做了 create/archive/delete。
3. **N1 qualifyCrossScopeEdges on rules `derives_from`**:provenance 边限定,
   正交于 scope 路由。
