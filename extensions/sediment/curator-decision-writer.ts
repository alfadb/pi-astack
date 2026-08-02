import type { CuratorDecision } from "./curator";
import { appendCuratorConflictProposals } from "./entry-lifecycle-proposals";
import {
  notePassMemoryDecision,
  notePassMemoryWrite,
} from "./pass-telemetry";
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
    && result.publication?.status !== "durable_pending"
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
  /** R6: real neighbor kinds for conflict lifecycle evidence (never invent).
   *  Missing/unknown kinds keep proposals deferred — no fake execution_ready. */
  neighborKindBySlug?: Record<string, string>;
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

  // R7: count every curator decision considered (including skip).
  notePassMemoryDecision(1);

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

  /**
   * After successful writes, emit R6 contradicted lifecycle evidence (no L1 rewrite).
   * Must bind the real Knowledge L1 event id(s) from this write as
   * independent_evidence_event_ids so proposals can enter lifecycle/forgetting.
   * Event id is taken only when append.ok (never bare eventId on failed append).
   * Real neighbor kindBySlug is required for execution_ready; missing kind → defer.
   */
  const emitConflictEvidence = (writeResults: WriteProjectEntryResult[]) => {
    if (decision.op !== "create" && decision.op !== "update") return;
    const stale = decision.stale_neighbors;
    const supersedes = decision.supersedes;
    if ((!stale || stale.length === 0) && (!supersedes || supersedes.length === 0)) return;
    const independentEvidenceEventIds = [...new Set(
      writeResults
        .map((r) => {
          const append = r.knowledgeEvidenceEvent?.append;
          // Strict: append.ok is the only authority to treat eventId as durable evidence.
          if (!append || append.ok !== true) return undefined;
          return typeof append.eventId === "string" && /^[0-9a-f]{64}$/.test(append.eventId)
            ? append.eventId
            : undefined;
        })
        .filter((id): id is string => !!id),
    )];
    // Prefer observed neighbor kinds; never invent. Empty map → append path defers.
    const kindBySlug: Record<string, string> = {};
    for (const slug of [...(stale ?? []), ...(supersedes ?? [])]) {
      const kind = args.neighborKindBySlug?.[slug];
      if (typeof kind === "string" && kind.trim() && kind.trim() !== "unknown") {
        kindBySlug[slug] = kind.trim();
      }
    }
    try {
      appendCuratorConflictProposals({
        projectRoot,
        staleNeighbors: stale,
        supersedes,
        candidateSlug: decision.op === "update" ? decision.slug : draft.preferredSlug ?? draft.title,
        kindBySlug,
        ...(independentEvidenceEventIds.length
          ? { independentEvidenceEventIds }
          : {}),
      });
    } catch {
      /* lifecycle sidecar is best-effort; never fail the brain write */
    }
  };

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
      slug: draft.preferredSlug,
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
        slug: draft.preferredSlug ?? draft.title,
        injectMode,
      },
    });
    const adaptedCreate = ruleResult(r);
    if (adaptedCreate.status === "created" || adaptedCreate.status === "updated") {
      notePassMemoryWrite(1);
      // Rules-zone creates rarely emit Knowledge L1; still attempt bind (may defer).
      emitConflictEvidence([adaptedCreate]);
    }
    return [adaptedCreate];
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
      const adaptedRule = ruleResult(r);
      if (adaptedRule.status === "archived" || adaptedRule.status === "deleted" || adaptedRule.status === "updated") {
        notePassMemoryWrite(1);
      }
      return [adaptedRule];
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

  let results: WriteProjectEntryResult[];
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
      results = [result];
      break;
    }

    case "merge": {
      results = await mergeProjectEntries(
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
      break;
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
      results = [result];
      break;
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
      results = [result];
      break;
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
      results = [result];
      break;
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
      results = [result];
      break;
    }

    default:
      results = [];
      break;
  }

  const writeStatuses = new Set([
    "created", "updated", "merged", "archived", "superseded", "deleted",
  ]);
  const writeCount = results.filter((r) => writeStatuses.has(r.status)).length;
  if (writeCount > 0) {
    notePassMemoryWrite(writeCount);
    emitConflictEvidence(results);
  }
  return results;
}
