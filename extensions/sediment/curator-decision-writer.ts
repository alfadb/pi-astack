import type { CuratorDecision } from "./curator";
import {
  archiveProjectEntry,
  deleteProjectEntry,
  mergeProjectEntries,
  supersedeProjectEntry,
  updateProjectEntry,
  writeProjectEntry,
  type ProjectEntryDraft,
  type WriteProjectEntryOptions,
  type WriteProjectEntryResult,
  type WriterAuditContext,
} from "./writer";
import type { SedimentSettings } from "./settings";

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
        writerOpts(decision.scope),
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
