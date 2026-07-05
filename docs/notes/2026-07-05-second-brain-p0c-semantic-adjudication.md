---
doc_type: notes
status: active
---

# Second Brain P0C Constraint Semantic Adjudication - 2026-07-05

## Scope

This note records the P0C T0 Round3 semantic adjudication outcome for Second Brain constraint handling. It is repo documentation only.

P0C is read-only. This note does not authorize or perform a runtime flip, shadow refresh or write, evidence write, archive or delete action, or compiler/runtime change.

## Input Evidence

The adjudication used these inputs:

- P0B note.
- Latest decision, diff, diagnostics, and compiled-view artifacts.
- Session-start-dualread audit.
- Legacy rules.

The active project baseline has `pi-global legacyOnly=8`. Later observed latest counts may show `legacyOnly=6` because of `cwd` or `pi-router` context, but the P0C ruling is based on source semantics. The three `human_required` rulings and `textDelta=17` still hold under that source-semantic interpretation.

## T0 Round3 Consensus

T0 Round3 reached 5/5 ACCEPT consensus.

The consensus accepts P0C as a read-only adjudication. It does not authorize:

- Runtime flip.
- Shadow refresh or write.
- Evidence write.
- Archive or delete.
- Compiler fix.

## Human Required Rulings

### Unicode Literal UTF-8/No `\u` Escapes

Source: `compile_behavior_constraint`.

The `settings_not_memory` classification is a misclassification. Legacy evidence is semantically sufficient for this constraint.

Actual reclassification or event mutation requires later explicit authorization. Until that authorization and follow-on work exist, this blocks retirement, runtime flip, and convergence acceptance.

### Jargon/Professional Vocabulary

Source: compile active global always behavior constraint.

Archived or listed predecessors are excluded as superseded.

The current unresolved state plus the diagnostics-vs-decision inconsistency is a hard blocker. This blocks shadow acceptance, retirement, and runtime flip.

### Runtime Kill-Switch

Keep the `human_required` boundary.

`machineDisposition=settings_not_memory` is not enough for retirement. Do not assert compile lean from the current evidence. Ask the human to choose between `settings_not_memory` or `knowledge-settings-only` versus compile operational behavior before any compiler or evidence work.

This blocks retirement and runtime flip for that source, but does not by itself block shadow refresh.

## Text Delta

`textDelta=17` is accepted as follows.

Five entries are `normalization_accepted`:

- `rule:global:listed:charter-document-staleness-is-the-highest-severity-doc-drift-signal`
- `rule:global:listed:l2-not-user-managed-popup-only-on-write`
- `rule:global:listed:second-brain-memory-multi-t0-consensus-refactoring-protocol`
- `rule:global:listed:t0-tier-cost-blind-capability-principle`
- `rule:global:listed:windows-path-separator-normalisation-in-ui-labels`

Twelve entries are `semantic_equivalent_needs_human_confirm`:

- `rule:global:always:all-current-and-future-projects-using-the-pi-astack-architecture-humans-control-technical-big-direct`
- `rule:global:always:all-github-repositories-must-be-managed-using-the-gh-cli-tool-this-covers-api-management-operations`
- `rule:global:always:applies-broadly-when-the-assistant-is-deciding-whether-to-keep-fallback-paths-dead-code-backups-old`
- `rule:global:always:applies-to-the-pi-global-private-internal-repository-the-user-wants-secrets-json-and-agent-models-js`
- `rule:global:always:the-user-establishes-a-durable-expectation-that-the-assistant-should-cross-reference-actual-file-dir`
- `rule:global:always:this-applies-to-the-users-development-methodology-work-in-the-pi-astack-context-pi-astack-should-be`
- `rule:global:always:this-correction-applies-to-the-development-methodology-discussion-as-a-global-cross-project-standard`
- `rule:global:always:when-deciding-whether-to-sync-and-release-upstream-changes-in-sub2api-project-only-business-logic-ch`
- `rule:global:always:对于所有未来涉及-pr-回复的场景-回复应当作为-review-thread-的-reply-inline-而不是独立的-issue-comment-所有-pr-的标题和描述应当使用中文`
- `rule:global:always:所有托管在-git-alfadb-cn-的-git-仓库-在所有会话和项目中-必须使用-glab-cli-工具进行管理操作-git-原生操作-commit-push-pull-clone-允许使用原生`
- `rule:global:always:所有未来的-adr-文档应避免段内硬换行-软换行-改用段落内一行到底的格式`
- `rule:global:listed:新功能验收必须使用真实生产数据`

There are no `semantic_mismatch_fix_required` entries.

The `rule:global:always:when-deciding-whether-to-sync-and-release-upstream-changes-in-sub2api-project-only-business-logic-ch` row is flagged for human confirmation, not automatic mismatch, because the evidence title is truncated and compiled materiality has a caveat.

## Human Decisions

- Unicode literal UTF-8/no `\u` escapes: human confirmed `compile_behavior_constraint`; `settings_not_memory` is misclassification. A later compiler fix or equivalent event may cover it, but production mutation or shadow refresh still requires separate authorization.
- Runtime kill-switch: human did not decide; keep `human_required`.
- Sub2api textDelta: human did not decide; keep `semantic_equivalent_needs_human_confirm`.

## Minimal Next Action

The original batch human prompt is complete. The next step may only prepare a compiler-only plan for Unicode literal handling and jargon/professional vocabulary.

Runtime kill-switch and sub2api textDelta remain unresolved blockers for retirement and runtime flip. This note does not authorize shadow refresh, evidence write, archive, or runtime flip.

## P0D Compiler-Only Patch

The user authorized implementing a compiler-only patch for Unicode misclassification and the jargon `injectMode`/diagnostic blocker.

The patch does not refresh shadow state, write evidence, archive or delete records, perform a runtime flip, or write production `~/.abrain`.

Unicode handling: normalize, prompt, and event-scan now keep no-`\u`/literal UTF-8 output behavior as `behavioral_constraint` and guard runtime-kill-switch/plain UTF-8 settings facts.

Jargon handling: the prompt instructs active always plus listed predecessor handling. The validator warns with `SC_DIAGNOSTIC_DECISION_INCONSISTENCY` when diagnostics claim compiled or merged but final disposition is unresolved or excluded. Negated/internal diagnostics are guarded.

Runtime kill-switch and sub2api remain unresolved blockers for retirement and runtime flip.

Validation:

- `smoke:constraint-shadow-compiler`: 73 assertions.
- `smoke:constraint-evidence-event`: 37 checks.
- `smoke:constraint-l2-repo-preflight`: 4 checks with stale warning only.
- `smoke:abrain-rule-injector`: 11 assertions.
- Clean worktree isolated `smoke:constraint-shadow-compiler`: 73 assertions.

## Blocked Actions

The following actions remain blocked by this note:

- Writing production `~/.abrain`.
- Refreshing or writing shadow state.
- Writing evidence.
- Archiving or deleting records.
- Changing runtime behavior or performing additional compiler changes beyond the authorized P0D compiler-only patch.
- Performing runtime flip.
- Treating P0C acceptance as convergence acceptance.
