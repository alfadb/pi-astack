import type { CuratorDecision } from "./curator";
import {
  archiveProjectEntry,
  deleteProjectEntry,
  mergeProjectEntries,
  supersedeProjectEntry,
  updateProjectEntry,
  writeProjectEntry,
  writeAbrainRule,
  archiveAbrainRule,
  deleteAbrainRule,
  findRuleFile,
  type ProjectEntryDraft,
  type WriteProjectEntryOptions,
  type WriteProjectEntryResult,
  type WriteRuleResult,
  type WriterAuditContext,
} from "./writer";
import type { SedimentSettings } from "./settings";
import type { EntryStatus } from "./validation";

function hasGitCommitFailure(result: WriteProjectEntryResult, settings: SedimentSettings): boolean {
  return settings.gitCommit === true
    && result.status !== "rejected"
    && result.status !== "skipped"
    && result.status !== "dry_run"
    && result.gitCommit === null;
}

function assertNoGitCommitFailure(results: WriteProjectEntryResult[], settings: SedimentSettings): void {
  const failed = results.find((result) => hasGitCommitFailure(result, settings));
  if (failed) {
    throw new Error(`git_commit_failed for op result status=${failed.status} slug=${failed.slug}`);
  }
}

/**
 * Execute a curator-approved decision against the brain writer.
 *
 * This is the single dispatcher shared by the original auto-write turn
 * and the multi-view replay lane. Keeping the op→writer mapping here
 * prevents the replay path from drifting into a dead stub while the
 * foreground path keeps evolving.
 */
export async function executeCuratorDecisionToBrain(args: {
  decision: CuratorDecision;
  draft: ProjectEntryDraft;
  projectRoot: string;
  abrainHome: string;
  projectId: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  auditContext?: WriterAuditContext;
  sessionId?: string;
  /** ADR 0031 CAS parity: observed status per neighbor slug at curate time.
   *  Lifecycle ops (archive/delete/merge) pin expected_status from this so a
   *  concurrent reactivation/status change aborts the write instead of being
   *  silently clobbered. Undefined → CAS skipped (legacy/backward-compatible). */
  neighborStatusBySlug?: Record<string, EntryStatus>;
  createTimelineNote?: string;
  updateTimelineNote?: string;
  mergeTimelineNote?: string;
  archiveReason?: string;
  supersedeReason?: string;
  deleteReason?: string;
}): Promise<WriteProjectEntryResult[]> {
  const {
    decision,
    draft,
    projectRoot,
    abrainHome,
    projectId,
    settings,
    dryRun = false,
    auditContext,
    sessionId,
  } = args;

  if (decision.op === "skip") {
    return [{
      slug: draft.title,
      path: "",
      status: "skipped",
      reason: decision.reason,
      lane: auditContext?.lane,
      sessionId: auditContext?.sessionId ?? sessionId,
      correlationId: auditContext?.correlationId,
      candidateId: auditContext?.candidateId,
    }];
  }

  // ADR 0023 W2: route rules-zone ops to the rule writers (writeAbrainRule /
  // archiveAbrainRule / deleteAbrainRule) instead of the entries writer. CREATE
  // is keyed on decision.zone==="rules"; lifecycle ops are keyed on whether the
  // target slug resolves to an existing rule file (neighbor-lane routing). The
  // WriteRuleResult is adapted to the shared WriteProjectEntryResult shape.
  const ruleResult = (r: WriteRuleResult): WriteProjectEntryResult => ({
    // a #2 semantic-dedup hit is a no-op write -> 'skipped' in the shared shape.
    // "similar_found" is a Tier-1 report-mode intermediate (PR-4) that Tier-2
    // never requests (semanticDedup here is only ever dedup|off) — defensive
    // map to 'skipped' to keep the shared status union closed.
    slug: r.slug, path: r.path, status: r.status === "deduped" || r.status === "similar_found" ? "skipped" : r.status, reason: r.reason, gitCommit: r.gitCommit,
    auditPath: r.auditPath, lane: r.lane ?? auditContext?.lane, sessionId: r.sessionId ?? sessionId,
    correlationId: r.correlationId, candidateId: r.candidateId,
    // FIX-5: preserve dedupedAgainst so the promotion executor can tell a
    // real write from a rules-zone dedupe skip.
    dedupedAgainst: r.dedupedAgainst,
    // audit round-3 P3: carry lint + sanitization counts so the notify/audit
    // summary (resultSummary) is complete for rules results too.
    lintErrors: r.lintErrors, lintWarnings: r.lintWarnings, sanitizedReplacements: r.sanitizedReplacements,
    tier2RulesLegacyWriteGate: r.tier2RulesLegacyWriteGate,
  });
  // PR-4/P0.3 Tier-2 (O2 2026-06-10): with the adjudication lane ON, Jaccard
  // demotes from autonomous write-time gate to curator neighbor pre-filter —
  // the curator already saw existing rules as readonly neighbors and its
  // create decision IS the adjudication. CONJUNCTION GUARD: the neighbor
  // pre-filter only exists when rulesAsReadonlyNeighborsEnabled actually
  // loaded rules into the curator prompt (curator.ts:1053-1058, default off);
  // bypassing the gate without that substitute would regress the 2026-06-07
  // glab near-dup incident. Lane OFF (default) keeps the legacy gate.
  const tier2SemanticDedup: "dedup" | "off" =
    settings.tier1JaccardCuratorLane === true && settings.rulesAsReadonlyNeighborsEnabled === true
      ? "off" : "dedup";
  const ruleOpts = { abrainHome, settings, dryRun, auditContext, semanticDedup: tier2SemanticDedup };
  const resolveRuleLifecycleScope = (slug: string): "global" | "project" | null => {
    if (findRuleFile(abrainHome, "global", undefined, slug)) return "global";
    if (findRuleFile(abrainHome, "project", projectId, slug)) return "project";
    return null;
  };

  if (decision.op === "create" && decision.zone === "rules") {
    // §12.3 rename dual-read: persisted multiview-staging replay decisions
    // written before the rename still carry the legacy `tier` key.
    const injectMode = decision.injectMode ?? (decision as { tier?: "always" | "listed" }).tier ?? "listed";
    const ruleScope = decision.ruleScope === "project" ? "project" : "global";
    const r = await writeAbrainRule({
      title: draft.title,
      body: draft.compiledTruth,
      zone: "rules",
      injectMode,
      scope: ruleScope === "project" ? { projectId } : "global",
      kind: draft.kind,
      entryConfidence: typeof draft.confidence === "number" ? draft.confidence : 5,
      routingConfidence: 0.8,
      routingReason: decision.rationale ?? args.createTimelineNote ?? "promoted by sediment classifier",
      triggerPhrases: draft.triggerPhrases,
      derivesFrom: decision.derives_from,
      status: draft.status,
      // AX-PROVENANCE (audit P1 2026-06-07): carry the TRUE source from the draft
      // (Tier-1 seed = user-expressed). Default to assistant-observed so an
      // autonomous curator/extractor-created rule is NOT mislabeled user-expressed.
      provenance: draft.provenance ?? "assistant-observed",
      sessionId,
    }, {
      ...ruleOpts,
      tier2RulesLegacyWriteContext: {
        caller: "curator_decision_writer",
        operation: "create",
        ruleScope,
        ...(ruleScope === "project" ? { projectId } : {}),
        slug: draft.title,
        injectMode,
      },
    });
    return [ruleResult(r)];
  }
  if (decision.op === "archive" || decision.op === "delete") {
    const ruleScope = resolveRuleLifecycleScope(decision.slug);
    if (ruleScope) {
      const pid = ruleScope === "project" ? projectId : undefined;
      const reason = decision.reason || decision.rationale || (decision.op === "archive" ? args.archiveReason : args.deleteReason) || `${decision.op}d by sediment classifier`;
      const r = decision.op === "archive"
        ? await archiveAbrainRule(decision.slug, ruleScope, pid, {
          ...ruleOpts,
          reason,
          tier2RulesLegacyWriteContext: {
            caller: "curator_decision_writer",
            operation: "archive",
            ruleScope,
            ...(pid ? { projectId: pid } : {}),
            slug: decision.slug,
          },
        })
        : await deleteAbrainRule(decision.slug, ruleScope, pid, {
          ...ruleOpts,
          reason,
          tier2RulesLegacyWriteContext: {
            caller: "curator_decision_writer",
            operation: "delete",
            ruleScope,
            ...(pid ? { projectId: pid } : {}),
            slug: decision.slug,
          },
        });
      return [ruleResult(r)];
    }
  }

  const writerOpts = (scope: "world" | undefined): WriteProjectEntryOptions => ({
    projectRoot,
    abrainHome,
    projectId,
    ...(scope ? { scope } : {}),
    settings,
    dryRun,
    auditContext,
  });

  switch (decision.op) {
    case "update": {
      const result = await updateProjectEntry(
        decision.slug,
        {
          ...decision.patch,
          sessionId,
          timelineNote:
            decision.patch.timelineNote ||
            args.updateTimelineNote ||
            decision.rationale ||
            "updated by sediment curator",
        },
        writerOpts(decision.scope),
      );
      assertNoGitCommitFailure([result], settings);
      return [result];
    }

    case "merge": {
      const results = await mergeProjectEntries(
        decision.target,
        decision.sources,
        {
          compiledTruth: decision.compiledTruth,
          timelineNote: decision.timelineNote || args.mergeTimelineNote,
          reason:
            decision.rationale ||
            decision.timelineNote ||
            args.mergeTimelineNote ||
            "merged by sediment curator",
          sessionId,
        },
        { ...writerOpts(decision.scope), sourceExpectedStatus: args.neighborStatusBySlug },
      );
      assertNoGitCommitFailure(results, settings);
      return results;
    }

    case "archive": {
      const result = await archiveProjectEntry(decision.slug, {
        ...writerOpts(decision.scope),
        reason:
          decision.reason ||
          decision.rationale ||
          args.archiveReason ||
          "archived by sediment curator",
        sessionId,
        expected_status: args.neighborStatusBySlug?.[decision.slug],
      });
      assertNoGitCommitFailure([result], settings);
      return [result];
    }

    case "supersede": {
      const result = await supersedeProjectEntry(decision.oldSlug, {
        ...writerOpts(decision.scope),
        newSlug: decision.newSlug,
        reason:
          decision.reason ||
          decision.rationale ||
          args.supersedeReason ||
          "superseded by sediment curator",
        sessionId,
      });
      assertNoGitCommitFailure([result], settings);
      return [result];
    }

    case "delete": {
      const result = await deleteProjectEntry(decision.slug, {
        ...writerOpts(decision.scope),
        mode: decision.mode,
        reason:
          decision.reason ||
          decision.rationale ||
          args.deleteReason ||
          "deleted by sediment curator",
        sessionId,
        expected_status: args.neighborStatusBySlug?.[decision.slug],
      });
      assertNoGitCommitFailure([result], settings);
      return [result];
    }

    case "create": {
      const result = await writeProjectEntry(
        {
          ...draft,
          ...(decision.derives_from?.length ? { derivesFrom: decision.derives_from } : {}),
          sessionId,
          timelineNote:
            draft.timelineNote ||
            args.createTimelineNote ||
            "captured from sediment curator",
        },
        writerOpts(decision.scope),
      );
      assertNoGitCommitFailure([result], settings);
      return [result];
    }
  }
}
